import type { ConductorConfig } from '../config/schema.js';
import type { AttentionState } from '../adapters/types.js';
import type { AgentLifecycle } from '../domain/models.js';
import type { PushMessage } from '../notifications.js';
import type { Place } from '../places/places.js';
import type { StructuredAgents } from '../transports/structured-agents.js';

// after this many exits within the window the Conductor stays Exited until the operator resumes it
const maxExits = 3;
const exitWindowMs = 10 * 60_000;
const down = (lifecycle: AgentLifecycle | undefined): boolean => lifecycle === 'exited' || lifecycle === 'failed';
// compacted between Turns once its context holds this many tokens, well before any model's limit, so
// the summary is written with room to spare; a compaction that failed is not retried for a while
const compactAtTokens = 150_000;
const compactRetryMs = 10 * 60_000;
const listed = 30;

/**
 * What the console knows of the Conductor's work when it compacts: the workers it spawned, the
 * prompts it dispatched that are not reported yet, its Watches, and the other Agents in its scope
 * that are working or waiting on the operator. Ids only, never another Agent's text.
 */
export type HandoffState = {
  at: Date;
  workers: Array<{ id: string; worktreeId?: string; state: AttentionState | AgentLifecycle; model?: string }>;
  dispatches: Array<{ promptId: string; to: string; delivered: boolean }>;
  watches: Array<{ id: string; kind: string; description: string }>;
  busy: Array<{ id: string; worktreeId?: string; state: AttentionState }>;
};
const stateText: Record<AttentionState | AgentLifecycle, string> = { working: 'working', finished: 'idle', question: 'asking the operator a question', live: 'idle', starting: 'starting', exited: 'exited', failed: 'failed to start' };

/** The console's state for the Conductor's summary, said to be a snapshot that goes stale. */
export function handoffStateText({ at, workers, dispatches, watches, busy }: HandoffState): string {
  const section = <T,>(title: string, items: readonly T[], line: (item: T) => string): string[] => [
    '', title,
    ...items.length === 0 ? ['- none'] : items.slice(0, listed).map(item => `- ${line(item)}`),
    ...items.length > listed ? [`- and ${items.length - listed} more`] : []
  ];
  const where = (worktreeId: string | undefined) => worktreeId === undefined ? '' : ` in Worktree ${worktreeId}`;
  return [
    `The console wrote this at ${at.toISOString()}, when this conversation was compacted. It may have changed since: check with list_agents, list_watches or get_agent_status before acting on it.`,
    ...section('Workers you spawned:', workers, worker => `Agent ${worker.id}${where(worker.worktreeId)}: ${stateText[worker.state]}${worker.model === undefined ? '' : `, on ${worker.model}`}`),
    ...section('Prompts you queued whose report has not reached you yet:', dispatches, dispatch => `${dispatch.promptId} to Agent ${dispatch.to}: ${dispatch.delivered ? 'delivered' : 'still in its queue'}`),
    ...section('Your Watches:', watches, watch => `${watch.id} (${watch.kind}): ${watch.description}`),
    ...section('Other Agents in your scope that are working or waiting on the operator:', busy, agent => `Agent ${agent.id}${where(agent.worktreeId)}: ${stateText[agent.state]}`)
  ].join('\n');
}

/**
 * Keeps the one configured Conductor running (ADR 0016 amendment, ADR 0018): launched at console
 * start and again whenever it exits, until it exits 3 times in 10 minutes; then it stays Exited,
 * with one push, and its queue keeps filling. A Conductor no longer configured, or at another
 * Project, is closed (its queue left to become Notes as a departed Agent's does), so removing the
 * configuration turns it off. Nothing here is Pi-shaped: the
 * Conductor is a role on a structured Agent of the configured kind.
 */
export class Conductor {
  private exits: number[] = [];
  private stopped = false;
  // the lifecycle the last reconciliation saw, or `starting` once it (re)started the Conductor
  private seen?: AgentLifecycle;
  private running?: Promise<void>;
  private again = false;
  // the Conductors' ids, Places and lifecycles as last reconciled: most changes (a transcript line) touch none
  private fingerprint?: string;
  // the Conductor kept, as last reconciled
  private id?: string;
  private compacting = false;
  private compactFailedAt?: number;

  constructor(
    private readonly config: ConductorConfig | undefined,
    private readonly agents: StructuredAgents,
    private readonly placeId: string | undefined,
    private readonly place: () => Promise<Place | undefined>,
    private readonly notify: (message: PushMessage) => void,
    // the console's state for the Conductor's summary when it compacts
    private readonly handoff: (conductorId: string) => Promise<string>,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Bring the Conductor up as configured, and keep it up from now on. */
  async start(): Promise<void> {
    if (this.config?.unavailable !== undefined) {
      console.warn(`[conductor] off: ${this.config.unavailable}`);
      this.notify({ kind: 'conductor', title: 'The Conductor is off', body: `Its Project ${this.config.projectId} is unavailable: ${this.config.unavailable}. Fix it and restart the console.`, tag: 'conductor-off', url: '/' });
    }
    this.agents.onChange(() => { void this.keep(); void this.compactWhenFull(); });
    await this.keep();
  }

  /**
   * Compact the Conductor's Conversation between Turns, with the console's state appended to its
   * summary; `instructions` are the operator's for the summary.
   */
  async compact(instructions?: string): ReturnType<StructuredAgents['compact']> {
    const id = this.id;
    if (id === undefined) return 'unavailable';
    return await this.agents.compact(id, { ...(instructions === undefined ? {} : { instructions }), state: async () => await this.handoff(id) });
  }

  // compact once the context passes the threshold; while the Conductor works it refuses as busy, and
  // the next change tries again
  private async compactWhenFull(): Promise<void> {
    if (this.compacting || this.id === undefined || (this.agents.contextTokens(this.id) ?? 0) < compactAtTokens) return;
    if (this.compactFailedAt !== undefined && this.now() - this.compactFailedAt < compactRetryMs) return;
    this.compacting = true;
    try {
      const outcome = await this.compact();
      if (typeof outcome === 'object') {
        this.compactFailedAt = this.now();
        console.warn(`[conductor] compaction failed: ${outcome.refused}`);
      } else if (outcome === 'ok') this.compactFailedAt = undefined;
    } catch (error) {
      this.compactFailedAt = this.now();
      console.error('[conductor] compaction failed:', error);
    } finally { this.compacting = false; }
  }

  // one reconciliation at a time; a change during one runs another after it
  private keep(): Promise<void> {
    if (this.running !== undefined) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.reconcile().catch(error => { console.error('[conductor]', error); }); } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async reconcile(): Promise<void> {
    const config = this.config;
    const conductors = (await this.agents.agents()).filter(agent => agent.structured?.role === 'conductor');
    const fingerprint = conductors.map(agent => `${agent.id} ${agent.placeId} ${agent.structured?.lifecycle}`).join('\n');
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    // at most one, at the configured Project; any other is turned off
    const kept = conductors.find(agent => agent.placeId === this.placeId && agent.kind === config?.kind);
    this.id = config === undefined ? undefined : kept?.id;
    for (const agent of conductors) if (agent !== kept) await this.agents.close(agent.id, { retired: true });
    if (config === undefined) return;
    const lifecycle = kept?.structured?.lifecycle;
    // an unavailable Project leaves it off: nothing is launched, and one still running (its holder
    // outlived a console restart) is stopped, its record and queue kept for when the Project is back
    if (config.unavailable !== undefined) {
      // one busy with an operation is stopped once that ends (its end is a change)
      if (kept !== undefined && !down(lifecycle) && !await this.agents.stop(kept.id, `Its Project is unavailable: ${config.unavailable}`)) this.fingerprint = undefined;
      return;
    }
    const before = this.seen;
    this.seen = lifecycle;
    if (kept !== undefined && !down(lifecycle)) {
      // started again, as the operator resumed it: it is kept up once more
      if (this.stopped) { this.stopped = false; this.exits = []; }
      return;
    }
    if (this.stopped) return;
    // an exit seen happen counts (a launch that started nothing too); one found at console start is
    // relaunched without counting
    if (kept === undefined ? before === 'starting' : before !== undefined && !down(before)) {
      const now = this.now();
      this.exits = [...this.exits.filter(at => now - at < exitWindowMs), now];
      if (this.exits.length >= maxExits) {
        this.stopped = true;
        this.notify(kept === undefined
          ? { kind: 'conductor', title: 'The Conductor could not start', body: `It failed to start ${maxExits} times in ${exitWindowMs / 60_000} minutes. Check adapters.pi and restart the console.`, tag: 'conductor-stopped', url: '/' }
          : { kind: 'conductor', title: 'The Conductor stopped', body: `It exited ${maxExits} times in ${exitWindowMs / 60_000} minutes and stays down until you resume it. Prompts to it keep queueing.`, tag: 'conductor-stopped', url: `/#agent=${encodeURIComponent(kept.id)}` });
        return;
      }
    }
    const place = kept === undefined ? await this.place() : undefined;
    if (place !== undefined) await this.agents.launch(place, config.kind, { sandboxed: true, role: 'conductor' });
    else if (kept !== undefined) await this.agents.restart(kept.id);
    this.seen = 'starting';
    // what this did is reconciled afresh, even if it changed nothing
    this.fingerprint = undefined;
  }
}
