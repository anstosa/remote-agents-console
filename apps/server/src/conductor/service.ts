import type { ConductorConfig } from '../config/schema.js';
import type { AgentLifecycle } from '../domain/models.js';
import type { PushMessage } from '../notifications.js';
import type { Place } from '../places/places.js';
import type { StructuredAgents } from '../transports/structured-agents.js';

// after this many exits within the window the Conductor stays Exited until the operator resumes it
const maxExits = 3;
const exitWindowMs = 10 * 60_000;
const down = (lifecycle: AgentLifecycle | undefined): boolean => lifecycle === 'exited' || lifecycle === 'failed';

/**
 * Keeps the one configured Conductor running (ADR 0016 amendment, ADR 0018): launched at console
 * start and again whenever it exits, until it exits 3 times in 10 minutes; then it stays Exited,
 * with one push, and its queue keeps filling. A Conductor no longer configured, or at another
 * Project, is closed, so removing the configuration turns it off. Nothing here is Pi-shaped: the
 * Conductor is a role on a structured Agent of the configured kind.
 */
export class Conductor {
  private exits: number[] = [];
  private stopped = false;
  // the lifecycle the last reconciliation saw, or `starting` once it (re)started the Conductor
  private seen?: AgentLifecycle;
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly config: ConductorConfig | undefined,
    private readonly agents: StructuredAgents,
    private readonly place: () => Promise<Place | undefined>,
    private readonly close: (agentId: string) => Promise<boolean>,
    private readonly notify: (message: PushMessage) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** Bring the Conductor up as configured, and keep it up from now on. */
  async start(): Promise<void> {
    this.agents.onChange(() => { void this.keep(); });
    await this.keep();
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
    const place = config === undefined ? undefined : await this.place();
    const conductors = (await this.agents.agents()).filter(agent => agent.structured?.role === 'conductor');
    // at most one, at the configured Project; any other is turned off
    const kept = conductors.find(agent => place !== undefined && agent.placeId === place.id && agent.kind === config?.kind);
    for (const agent of conductors) if (agent !== kept) await this.close(agent.id);
    if (config === undefined || place === undefined) return;
    const lifecycle = kept?.structured?.lifecycle;
    const before = this.seen;
    this.seen = lifecycle;
    if (kept !== undefined && !down(lifecycle)) {
      // live again, as the operator resumed it: it is kept up once more
      if (lifecycle === 'live' && this.stopped) { this.stopped = false; this.exits = []; }
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
        this.notify({ kind: 'conductor', title: 'The Conductor stopped', body: `It exited ${maxExits} times in ${exitWindowMs / 60_000} minutes and stays down until you resume it. Prompts to it keep queueing.`, tag: 'conductor-stopped', url: kept === undefined ? '/' : `/#agent=${encodeURIComponent(kept.id)}` });
        return;
      }
    }
    if (kept === undefined) await this.agents.launch(place, config.kind, { sandboxed: true, role: 'conductor', model: { model: config.model, ...(config.effort === undefined ? {} : { effort: config.effort }) } });
    else await this.agents.restart(kept.id);
    this.seen = 'starting';
  }
}
