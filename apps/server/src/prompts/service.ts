import { createHash, randomBytes } from 'node:crypto';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { adapterFor } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
import type { PromptCalendarLifecycle } from '../google-calendar/lifecycle.js';
import type { Agent } from '../domain/models.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { agentAttentionState } from '../notifications.js';
import { promptScope, QueuedPromptService, senderOf, type PromptSender, type QueuedPrompt, type QueuedPromptOrigin, type QueuedPromptSummary } from './queue.js';
import { validPrompt, type PromptAttachment } from './validation.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
import { answerCaptureGraceMs, reportsOwnState, TmuxTransport, type AdapterView, type AttachmentStagingWorkspace, type Delivery, type DeliveryOptions, type FailedDraft, type RecoveredAnswer, type SendIntent, type TmuxTurnEvent, type TurnMark, type TurnWatch } from '../transports/tmux.js';
import type { PromptHistoryEntry } from '../prompt-history/service.js';
import type { AgentTransport, Gate, InterruptOutcome, QuestionAnswer } from '../transports/transport.js';
export { maxPromptAttachmentBytes, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';
export { promptScope } from './queue.js';
export type { AttachmentStagingWorkspace } from '../transports/tmux.js';

// where a halted queue's prompts are drained: each queued prompt is handed to this sink, in order,
// and removed only when the sink reports it durable. The console wires it to the notes store; a
// false return leaves the prompt queued and the queue halted (see saveQueued).
export type UndeliveredDrain = (scope: string, prompt: QueuedPrompt) => Promise<boolean>;

// a pane missing from a few discovery ticks (a socket that briefly fails to list) is not a departed Agent
const departedAgentGraceMs = 30_000;
// the sweep reads both stores, history from disk; it need not run every dashboard tick
const departedSweepMs = 10_000;
// a reported-state prompt must report `working` within this window or the dispatch is failed
const reportedWorkingGraceMs = 5_000;
const trackedRequestTerminalTtlMs = 60 * 60 * 1_000;
const maxTrackedTerminalRequests = 1_000;
type PromptCompletion = 'completed' | 'failed' | 'pending';
export type PromptRequestStatus = { id: string; agentId: string; state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted'; submitted: boolean; error?: string };
type StoredPromptRequest = PromptRequestStatus & { terminalAt?: number; promptFingerprint: string };
/**
 * What the queue policy asks of an Agent's Transport: deliver a prompt and report its Turn, plus
 * the tmux steps around them (reset gates, marks for adopted work, restart answer recovery, a
 * failed draft to clear), which a structured Transport answers trivially. A delivery is `busy`
 * when the Agent was already working: the prompt stays queued for the next settle.
 */
export interface TurnTransport extends Pick<AgentTransport, 'answer' | 'interrupt' | 'close' | 'latestAnswer' | 'recentLines'> {
  target(agentId: string): Promise<{ agent: Agent } | undefined>;
  gate(agentId: string, step?: 'retry' | 'settle'): Promise<Gate>;
  held(agentId: string): boolean;
  mark(agent: Pick<Agent, 'id' | 'kind'>): Promise<TurnMark>;
  deliver(agentId: string, prompt: string, attachments: PromptAttachment[], options: TurnDeliveryOptions, rendering: (prompt: string) => void): Promise<TurnDelivery>;
  observe(agent: Pick<Agent, 'id' | 'kind' | 'attention'>, turn: TurnWatch): Promise<TmuxTurnEvent | undefined>;
  externalReset(agentId: string, current: () => boolean): Promise<boolean>;
  recoverAnswer(agentId: string, entries: readonly PromptHistoryEntry[], sawWorking: boolean): Promise<RecoveredAnswer>;
  clearDraft(draft: FailedDraft): Promise<boolean>;
  /** Redirect the working Agent at once, where its Transport can steer. */
  steer?(agentId: string, prompt: string): Promise<'sent' | 'unsupported' | 'refused'>;
}
type TurnDelivery = Delivery | { status: 'busy' };
// how a prompt is delivered (`waited`: it waited in the queue behind earlier work)
type TurnDeliveryOptions = Omit<DeliveryOptions, 'discovered'> & { discovered?: { agent: Agent }; waited?: true; sender?: PromptSender };
/** The structured Agents' Transport, which says which Agents are its own. */
export type StructuredTurnTransport = TurnTransport & { owns(agentId: string): Promise<boolean> };
type PromptPhase = TurnMark & { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; requestId?: string; historyEntryId?: string; historyPrompt?: string; failedDraft?: FailedDraft; sender?: PromptSender };
/**
 * How a queued prompt's Turn, or the prompt itself, ended: its Turn completed, failed, was
 * interrupted, or its Agent's process exited under it; it never went out (it became a Note, or was
 * removed), was `withdrawn` by its own sender, or its Agent is `gone`.
 */
export type PromptOutcome = 'completed' | 'failed' | 'interrupted' | 'exited' | 'not-delivered' | 'withdrawn' | 'gone';
/**
 * What the console's dispatch bookkeeping hears from the queue policy (the Conductor's, ADR 0018),
 * keyed by queued prompt id: a prompt another Agent sent was queued (before it can go out), went out
 * as a Turn (with its history entry), and how it ended. `admits` may hold a queued prompt back for
 * now; the next one that it admits goes out instead.
 */
export interface PromptDispatchHooks {
  admits(agentId: string, prompt: QueuedPrompt): boolean;
  queued(agentId: string, promptId: string, sender: PromptSender): Promise<void>;
  delivered(agentId: string, promptId: string, sender: PromptSender, entryId: string | undefined): Promise<void>;
  ended(promptId: string, outcome: PromptOutcome, answer?: string): void;
  /** An Agent restarted as another, whose queue it carries on. */
  handedOver(fromAgentId: string, toAgentId: string): Promise<void>;
}
// the outcome a tracked request's settling means for its prompt
const outcomeOf = (state: 'complete' | 'failed' | 'interrupted', error: string | undefined): PromptOutcome => {
  if (state === 'complete') return 'completed';
  switch (error) {
    case 'agent_exited': return 'exited';
    case 'queue_removed': case 'queue_saved': case 'prompt_not_delivered': return 'not-delivered';
    case 'queue_withdrawn': return 'withdrawn';
    case 'agent_departed': case 'agent_closed': return 'gone';
    default: return state === 'interrupted' ? 'interrupted' : 'failed';
  }
};

/**
 * The queue policy: what to dispatch and when, the cancel policy, and a halted or departed
 * Agent's queue becoming Notes. It owns the console's state for each Agent (queued prompts,
 * history, tracked requests, input reservations) and leaves delivery to the Agent's Transport.
 */
export class PromptService {
  // the Transport every Agent is driven over; tmux is the only one so far (ADR 0015)
  readonly transport: TmuxTransport;
  private readonly phases = new Map<string, PromptPhase>();
  private readonly trackedRequests = new Map<string, StoredPromptRequest>();
  private readonly dispatching = new Set<string>();
  private readonly restartLocks = new Set<string>();
  // scopes whose Agent is being interrupted: the Turn it ends is the cancel's to settle
  private readonly cancelling = new Set<string>();
  private readonly lockedAgentIds = new Set<string>();
  private readonly activeMutations = new Map<string, number>();
  private readonly mutationVersions = new Map<string, number>();
  private readonly departedSince = new Map<string, number>();
  // restart recovery: work seen since the console started, scopes whose lost answers are
  // recovered, and when an unfinished recovery began
  private readonly observedWorking = new Set<string>();
  private readonly reconciled = new Set<string>();
  private readonly reconciliationPendingSince = new Map<string, number>();
  private sweptAt = -Infinity;
  private lifecycleMutationVersion = 0;
  private dispatchHooks?: PromptDispatchHooks;
  // who sent the latest prompt each Agent's Turn started from, when not the operator
  private readonly senders = new Map<string, PromptSender>();

  // bind queue delivery and optional shared host staging
  // the Transport is built from the delivery arguments unless one is given, whose input
  // reservations must then be this service's
  constructor(discovery: DiscoveryService, tmux: TmuxAdapter, private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService, private readonly drainUndelivered?: UndeliveredDrain, private readonly resolveAdapter: (kind: AgentKind) => AdapterView | undefined = adapterFor, teardownFor: (kind: AgentKind) => string | undefined = () => undefined, attachmentStaging?: AttachmentStagingWorkspace, private readonly calendar?: PromptCalendarLifecycle, transport?: TmuxTransport, private readonly structured?: StructuredTurnTransport) {
    const hooks = { begin: (agentId: string) => this.beginAgentMutation(agentId), version: (agentId: string) => this.mutationVersion(agentId), busy: (agentId: string) => this.mutating(agentId), restored: (scope: string, deliveredPromptId?: string) => this.resetRestored(scope, deliveredPromptId) };
    this.transport = transport ?? new TmuxTransport(discovery, tmux, hooks, queued?.resets, resolveAdapter, teardownFor, attachmentStaging);
  }

  /** Report queued prompts' dispatches and ends to `hooks`, which may also hold some back. */
  useDispatches(hooks: PromptDispatchHooks): void { this.dispatchHooks = hooks; }

  /**
   * Whether the Turn an Agent last started is one the operator need not hear finish (ADR 0019):
   * one the console started on its behalf, or one the Conductor that spawned it dispatched. A Turn
   * the Conductor dispatched to the operator's own Agent still pushes.
   */
  quiet(agent: Pick<Agent, 'id' | 'structured'>): boolean {
    const sender = this.senders.get(agent.id);
    return sender?.label !== undefined || sender?.from !== undefined && sender.from === agent.structured?.spawnedBy;
  }

  /** The queued prompt whose Turn the Agent is on now, and who sent it. */
  inFlight(agentId: string): { promptId: string; sender: PromptSender } | undefined {
    const phase = this.phases.get(promptScope(agentId));
    return phase?.requestId === undefined || phase.state === 'halted' ? undefined : { promptId: phase.requestId, sender: phase.sender ?? {} };
  }

  /** Queue a prompt from `sender` (another Agent, or the console), answering its queued prompt's id. */
  async submitFrom(agentId: string, prompt: string, sender: PromptSender): Promise<string | undefined> {
    return (await this.submitRequest(agentId, prompt, [], undefined, false, sender)).promptId;
  }

  /** The Transport an Agent is driven over: structured for the structured Agents, tmux otherwise. */
  async transportFor(agentId: string): Promise<TurnTransport> {
    const structured = this.structured;
    return structured !== undefined && await structured.owns(agentId) ? structured : this.transport;
  }

  private async target(agentId: string): Promise<{ agent: Agent } | undefined> {
    return await (await this.transportFor(agentId)).target(agentId);
  }

  // a reset boundary restored after a console restart: the reset command it delivered leaves the
  // queue, and no answer from before the reset is recovered
  async resetRestored(scope: string, deliveredPromptId?: string): Promise<void> {
    if (deliveredPromptId !== undefined) await this.queued?.remove(scope, deliveredPromptId);
    this.reconciled.add(scope);
  }

  // submit or durably queue one prompt. `resetAt` marks the prompt as the first
  // turn of a conversation just reset with the Adapter's new-conversation command
  // (a Run reusing a pane): it flows into the completion baseline so the answer is
  // read from the fresh thread's rollout, not the reset pane's stale one.
  async submit(agentId: string, prompt: string, attachments: PromptAttachment[] = [], resetAt?: number): Promise<boolean> {
    return (await this.submitRequest(agentId, prompt, attachments, resetAt, false)).accepted;
  }

  // submit one prompt and expose its exact process-local lifecycle identity
  async submitTracked(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<{ requestId: string } | undefined> {
    const result = await this.submitRequest(agentId, prompt, attachments, undefined, true);
    return result.accepted && result.requestId !== undefined ? { requestId: result.requestId } : undefined;
  }

  // return one immutable request lifecycle snapshot
  requestStatus(requestId: string): PromptRequestStatus | undefined {
    this.pruneTrackedRequests();
    const request = this.trackedRequests.get(requestId);
    if (request === undefined) return undefined;
    const { terminalAt: _terminalAt, promptFingerprint: _promptFingerprint, ...status } = request;
    return status;
  }

  // share ordinary and tracked prompt admission without changing legacy results
  private async submitRequest(agentId: string, prompt: string, attachments: PromptAttachment[], resetAt: number | undefined, tracked: boolean, sender: PromptSender = {}): Promise<{ accepted: boolean; requestId?: string; promptId?: string }> {
    if (!validPrompt(prompt, attachments)) return { accepted: false };
    const releaseMutation = this.beginAgentMutation(agentId);
    const transport = await this.transportFor(agentId);
    const first = await transport.target(agentId);
    // release reservations for vanished targets
    if (!first) {
      releaseMutation?.();
      return { accepted: false };
    }
    const scope = promptScope(agentId);
    const origin: QueuedPromptOrigin = { home: first.agent.home, ...(first.agent.placeId === undefined ? {} : { placeId: first.agent.placeId }) };
    // queue the prompt durably, admitting it to the Calendar and tracking it before anything can dispatch it
    const enqueue = async (queued: QueuedPromptService): Promise<QueuedPromptSummary | undefined> => {
      const added = await queued.enqueue(scope, prompt, attachments, origin, sender);
      if (added === undefined) return undefined;
      // a record that cannot be kept loses only the report: the prompt is queued
      if (sender.from !== undefined) await this.dispatchHooks?.queued(agentId, added.id, senderOf(sender)).catch(error => { console.error('[prompts] a dispatch could not be recorded:', error); });
      await this.admitCalendar(transport, added.id, agentId, first.agent.kind, added.createdAt, prompt, attachments);
      if (tracked) this.trackQueuedRequest(added.id, agentId, prompt);
      return added;
    };
    const queuedAnswer = (queued: QueuedPromptSummary | undefined) => ({ accepted: queued !== undefined, ...(queued === undefined ? {} : { promptId: queued.id }), ...(tracked && queued !== undefined ? { requestId: queued.id } : {}) });
    // queue work arriving during a restart handoff
    if (releaseMutation === undefined || this.restartLocks.has(scope)) {
      releaseMutation?.();
      // retain exact queue identity through the restart handoff
      return queuedAnswer(this.queued === undefined ? undefined : await enqueue(this.queued));
    }
    try {
      const gate = await transport.gate(agentId, 'retry');
      const waiting = await this.queued?.list(scope);
      // retain prompts behind active or halted work
      if (this.queued !== undefined && (agentAttentionState(first.agent) !== 'finished' || this.phases.has(scope) || gate === 'pending' || gate === 'foreign' || (waiting?.length ?? 0) > 0)) {
        const adopting = agentAttentionState(first.agent) !== 'finished' && !this.phases.has(scope) && gate === 'none';
        const mark = adopting ? await transport.mark(first.agent) : {};
        const queued = await enqueue(this.queued);
        // track work that started outside the managed prompt flow
        if (queued !== undefined && adopting) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...mark });
        return queuedAnswer(queued);
      }
      // persist direct work before attempting interactive delivery
      if (this.queued !== undefined) {
        const queued = await enqueue(this.queued);
        // stop before paste when durable storage is unavailable
        if (queued === undefined) return { accepted: false };
        // delivery may remain queued without rejecting the accepted request
        await this.dispatch(transport, agentId, scope, resetAt, false);
        return queuedAnswer(queued);
      }
      const requestId = tracked || this.calendar !== undefined ? randomBytes(18).toString('base64url') : undefined;
      if (requestId !== undefined) await this.admitCalendar(transport, requestId, agentId, first.agent.kind, new Date().toISOString(), prompt, attachments);
      // direct deployments still receive a unique process-local identity
      if (requestId !== undefined) this.trackQueuedRequest(requestId, agentId, prompt);
      const accepted = await this.send(transport, agentId, prompt, attachments, { discovered: first, resetAt, ...(requestId === undefined ? {} : { queuedPromptId: requestId }) }) === 'submitted';
      // failed direct delivery has no durable queue to retain it
      if (!accepted && requestId !== undefined) this.settleTrackedRequest(requestId, 'failed', 'prompt submission failed');
      return { accepted, ...(accepted && requestId !== undefined ? { requestId } : {}) };
    } finally {
      releaseMutation();
    }
  }

  // register one accepted tracked request before dispatch begins
  private trackQueuedRequest(requestId: string, agentId: string, prompt: string): void {
    this.pruneTrackedRequests();
    this.trackedRequests.set(requestId, { id: requestId, agentId, state: 'queued', submitted: false, promptFingerprint: createHash('sha256').update(prompt).digest('base64url') });
  }

  // mark only the exact request whose submit receipt was confirmed
  private markTrackedRequestSubmitted(requestId: string | undefined): void {
    if (requestId === undefined) return;
    const current = this.trackedRequests.get(requestId);
    if (current === undefined || current.terminalAt !== undefined) return;
    this.trackedRequests.set(requestId, { ...current, state: 'running', submitted: true });
  }

  // settle one exact request once and retain a bounded terminal snapshot
  // (a queued prompt's dispatch hears every end, tracked or not, but an edit, which ends nothing)
  private settleTrackedRequest(requestId: string | undefined, state: 'complete' | 'failed' | 'interrupted', error?: string, answer?: string): void {
    if (requestId === undefined) return;
    if (error !== 'queue_updated') this.dispatchHooks?.ended(requestId, outcomeOf(state, error), answer);
    const current = this.trackedRequests.get(requestId);
    if (current === undefined || current.terminalAt !== undefined) return;
    const next: StoredPromptRequest = { ...current, state, ...(error === undefined ? {} : { error }), terminalAt: Date.now() };
    this.trackedRequests.set(requestId, next);
    this.pruneTrackedRequests();
  }

  // retain every active request while bounding terminal memory
  private pruneTrackedRequests(): void {
    const now = Date.now();
    const terminal: Array<[string, StoredPromptRequest]> = [];
    // expire old terminal entries without touching active work
    for (const entry of this.trackedRequests) {
      const terminalAt = entry[1].terminalAt;
      if (terminalAt === undefined) continue;
      if (now - terminalAt >= trackedRequestTerminalTtlMs) this.trackedRequests.delete(entry[0]);
      else terminal.push(entry);
    }
    terminal.sort((left, right) => (left[1].terminalAt ?? 0) - (right[1].terminalAt ?? 0));
    // evict only the oldest terminal overflow
    for (let index = 0; index < terminal.length - maxTrackedTerminalRequests; index += 1) this.trackedRequests.delete(terminal[index]![0]);
  }

  // admit only model prompts; shell and instant conversation controls never become activities
  // (the Calendar follows a prompt's lifecycle through the pane, so only over tmux)
  private async admitCalendar(transport: TurnTransport, id: string, agentId: string, kind: AgentKind, submittedAt: string, prompt: string, attachments: PromptAttachment[]): Promise<void> {
    if (this.calendar === undefined || transport !== this.transport || attachments.length === 0 && prompt.startsWith('!')) return;
    const adapter = this.resolveAdapter(kind);
    if (adapter?.submission.completesWithoutWork?.(prompt) === true) return;
    await this.calendar.admit({ id, agentId, kind, submittedAt }).catch(() => undefined);
  }

  // start a new Conversation on the Agent with its CLI's own reset command
  async submitReset(agentId: string, command: string): Promise<boolean> {
    return await this.transport.newConversation(agentId, command);
  }

  // submit one server-owned advisor prompt directly
  async submitUpdateAdvisor(agentId: string, targetSha: string, prompt: string): Promise<boolean> {
    // require one exact pending advisor and valid generated prompt
    if (!isFullGitSha(targetSha) || !validPrompt(prompt, [])) return false;
    const target = await this.transport.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.send(this.transport, agentId, prompt, [], { discovered: target, submission: 'confirmed-enter' }) === 'submitted';
  }

  // mark one advisor reusable only after its initial prompt is scheduled
  async markUpdateAdvisorReady(agentId: string, targetSha: string): Promise<boolean> {
    return await this.transport.markUpdateAdvisorReady(agentId, targetSha);
  }

  // reserve one agent for an idle restart
  async acquireRestartLock(agentId: string, expectedMutationVersion?: number, expectedMutationGeneration?: number): Promise<(() => void) | undefined> {
    const transport = await this.transportFor(agentId);
    const target = await transport.target(agentId);
    // require a current target
    if (target === undefined) return undefined;
    const scope = promptScope(agentId);
    // reject overlapping input and lifecycle work
    const gate = await transport.gate(agentId);
    // reserve a live owner's reset even when a sibling shares the queue scope
    if (this.restartLocks.has(scope) || this.lockedAgentIds.has(agentId) || this.phases.has(scope) || gate === 'pending' || gate === 'foreign' || this.mutating(agentId)
      || (expectedMutationVersion !== undefined && this.mutationVersion(agentId) !== expectedMutationVersion)
      || (expectedMutationGeneration !== undefined && this.mutationGeneration() !== expectedMutationGeneration)) return undefined;
    this.restartLocks.add(scope);
    this.lockedAgentIds.add(agentId);
    let released = false;
    // release the exact reservation once
    return () => {
      if (released) return;
      released = true;
      this.restartLocks.delete(scope);
      this.lockedAgentIds.delete(agentId);
    };
  }

  // reserve one direct agent mutation
  beginAgentMutation(agentId: string): (() => void) | undefined {
    // reject input after restart reservation
    if (this.lockedAgentIds.has(agentId)) return undefined;
    this.lifecycleMutationVersion += 1;
    this.mutationVersions.set(agentId, this.mutationVersion(agentId) + 1);
    this.activeMutations.set(agentId, (this.activeMutations.get(agentId) ?? 0) + 1);
    let released = false;
    // release the exact mutation once
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.activeMutations.get(agentId) ?? 1) - 1;
      // remove empty counters
      if (remaining <= 0) this.activeMutations.delete(agentId);
      else this.activeMutations.set(agentId, remaining);
    };
  }

  // snapshot one agent mutation generation
  mutationVersion(agentId: string): number {
    return this.mutationVersions.get(agentId) ?? 0;
  }

  // whether a direct mutation of this agent is in flight
  mutating(agentId: string): boolean {
    return (this.activeMutations.get(agentId) ?? 0) > 0;
  }

  // snapshot all agent mutations
  mutationGeneration(): number {
    return this.lifecycleMutationVersion;
  }

  async listQueued(agentId: string): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.list(promptScope(agentId));
  }

  async updateQueued(agentId: string, promptId: string, text: string): Promise<QueuedPromptSummary | undefined> {
    const target = await this.target(agentId);
    if (target === undefined || this.queued === undefined) return undefined;
    const prompt = await this.queued.update(promptScope(agentId), promptId, text);
    const tracked = this.trackedRequests.get(promptId);
    // changed configured bytes no longer represent the tracked action request
    if (prompt !== undefined && tracked !== undefined && tracked.promptFingerprint !== createHash('sha256').update(text).digest('base64url')) {
      this.settleTrackedRequest(promptId, 'failed', 'queue_updated');
      await this.calendar?.invalid(promptId, 'missing_lifecycle_evidence').catch(() => undefined);
    }
    return prompt;
  }

  // consume one queued prompt only after its external save succeeds
  async consumeQueuedOnSuccess(agentId: string, promptId: string, use: (queued: QueuedPrompt) => Promise<boolean>): Promise<'missing' | 'failed' | 'consumed'> {
    const result = await this.queued?.consumeOnSuccess(promptScope(agentId), promptId, use) ?? 'missing';
    // a saved Note cannot later complete the original prompt action
    if (result === 'consumed') {
      this.settleTrackedRequest(promptId, 'failed', 'queue_saved');
      await this.calendar?.invalid(promptId, 'missing_lifecycle_evidence').catch(() => undefined);
    }
    return result;
  }

  async moveQueued(agentId: string, promptId: string, direction: 'earlier' | 'later'): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.move(promptScope(agentId), promptId, direction);
  }

  // remove a queued prompt; `withdrawn` when its own sender took it back, which it need not hear of
  async removeQueued(agentId: string, promptId: string, withdrawn = false): Promise<boolean> {
    const target = await this.target(agentId);
    const removed = target !== undefined && this.queued !== undefined && await this.queued.remove(promptScope(agentId), promptId) !== undefined;
    // removed tracked work can never be dispatched
    if (removed) {
      this.settleTrackedRequest(promptId, 'failed', withdrawn ? 'queue_withdrawn' : 'queue_removed');
      await this.calendar?.invalid(promptId, 'missing_lifecycle_evidence').catch(() => undefined);
    }
    return removed;
  }

  // advance managed prompt completion over the Transport's Turn feed
  async observe(agent: Pick<Agent, 'id' | 'displayLabel' | 'home' | 'attention' | 'kind'>): Promise<void> {
    const scope = promptScope(agent.id);
    const transport = await this.transportFor(agent.id);
    const gate = await transport.gate(agent.id);
    // pause observation during restart handoffs and in-flight delivery
    if (this.restartLocks.has(scope) || this.dispatching.has(scope) || this.cancelling.has(scope)) return;
    // duplicate agents cannot settle, expire, or dispatch another pane's reset
    if (gate === 'foreign') return;
    // an Adapter without Turn capture cannot read an answer back: complete on
    // working -> finished, store the prompt alone, and skip the grace/halt path
    const adapter = this.resolveAdapter(agent.kind);
    // reconcile durable correlations even when process-local prompt phases were lost on restart
    await this.reconcileCalendar(undefined, agent.id);
    // a reset spinner is not a model turn and must never enter answer recovery
    if (!this.phases.has(scope) && transport.held(agent.id)) {
      // use fresh reset readiness rather than a possibly stale dashboard attention snapshot
      const settled = await transport.gate(agent.id, 'settle');
      if (settled === 'expired') await this.holdFailedSubmission(scope);
      if (settled === 'anchored') await this.dispatch(transport, agent.id, scope);
      return;
    }
    // a tmux Adapter without Turn capture; a structured Transport reports its Turns itself
    if (transport === this.transport && adapter !== undefined && adapter.turns === undefined) return this.observeTurnless(transport, agent, scope, reportsOwnState(adapter));
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry failed queue transfers without dispatching
    if (phase?.state === 'halted') {
      // clear abandoned native input before final note recovery
      if (!busy && await this.clearHaltedDraft(phase) && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    // wait through active agent work
    if (busy) {
      // recover one submitted prompt after a server restart
      const restartedEntry = phase === undefined && !this.observedWorking.has(scope) ? await this.latestUnanswered(scope) : undefined;
      // work seen: restart recovery starts over once it finishes
      this.observedWorking.add(scope);
      this.reconciled.delete(scope);
      this.reconciliationPendingSince.delete(scope);
      // mark the prompt as started
      if (phase?.state === 'awaiting-start' || phase?.state === 'awaiting-answer') {
        const started = await transport.observe(agent, phase);
        this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now(), ...(started?.type === 'started' ? started.mark : {}) });
      }
      const waiting = phase === undefined ? await this.queued?.list(scope) : undefined;
      // inspect queued or restart-orphaned work
      if (phase === undefined && ((waiting?.length ?? 0) > 0 || restartedEntry !== undefined)) {
        const mark = await transport.mark(agent);
        // adopt an unanswered entry only with rollout completion tracking
        const recoveringEntry = mark.rolloutBaseline === undefined ? undefined : restartedEntry;
        // retain terminal reconciliation when rollout tracking is unavailable
        if ((waiting?.length ?? 0) > 0 || recoveringEntry !== undefined) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(recoveringEntry === undefined ? {} : { historyEntryId: recoveringEntry.id, historyPrompt: recoveringEntry.text }), ...mark });
      }
      return;
    }
    // finish tracked work before releasing its queue
    if (phase !== undefined) {
      const event = await transport.observe(agent, phase);
      // the Agent's process exited under the Turn: it failed, and the queue waits for a resume
      if (event?.type === 'exited') {
        this.settleTrackedRequest(phase.requestId, 'failed', 'agent_exited');
        this.phases.delete(scope);
        return;
      }
      const completion: PromptCompletion = event === undefined || event.type === 'started' ? 'pending' : event.type === 'settled' ? await this.persistAnswer(scope, phase.historyEntryId, event.message) : 'failed';
      const answer = event?.type === 'settled' ? event.message : undefined;
      // allow terminal output to finish rendering
      if (completion === 'pending' && phase.state === 'working') {
        this.phases.set(scope, { ...phase, state: 'awaiting-answer', changedAt: Date.now() });
        return;
      }
      // retry capture and persistence during the grace window
      if (completion === 'pending' && Date.now() - phase.changedAt < answerCaptureGraceMs) return;
      // external resets can spin without a turn; never fail work we have not attempted
      if (completion === 'pending' && phase.historyPrompt === undefined && phase.historyEntryId === undefined) {
        // reserve the adopted phase while the pane is read and its reset boundary written;
        // the queue waits until the actual pane is ready
        if (this.dispatching.has(scope)) return;
        this.dispatching.add(scope);
        let anchored = false;
        try {
          anchored = await transport.externalReset(agent.id, () => this.phases.get(scope) === phase);
          if (anchored) {
            this.phases.delete(scope);
            this.resetDelivered(scope);
          }
        } finally { this.dispatching.delete(scope); }
        if (anchored) await this.dispatch(transport, agent.id, scope);
        return;
      }
      // save the queue after failed, cancelled, or unrecordable work
      if (completion !== 'completed') {
        this.settleTrackedRequest(phase.requestId, 'failed', 'prompt_failed');
        this.phases.set(scope, { ...phase, state: 'halted', changedAt: Date.now() });
        // clear the halt after every queued prompt is durable
        if (await this.saveQueued(scope)) this.phases.delete(scope);
        return;
      }
      // reconcile adopted work before releasing its queue
      if (phase.historyEntryId === undefined) {
        // wait for restart recovery before releasing queued work
        if (!await this.reconcile(transport, agent.id, scope)) return;
      }
      // release completed prompts
      this.settleTrackedRequest(phase.requestId, 'complete', undefined, answer);
      this.phases.delete(scope);
    }
    // recover answer tracking lost across restarts
    if (phase === undefined && !this.reconciled.has(scope) && !await this.reconcile(transport, agent.id, scope)) return;
    await this.dispatch(transport, agent.id, scope);
  }

  // Recover an answer the Agent finished while the console was down, retrying through the grace
  // window while the pane renders; true once recovery is done and queued work may go out.
  private async reconcile(transport: TurnTransport, agentId: string, scope: string): Promise<boolean> {
    const result = await this.recoverAnswer(transport, agentId, scope);
    // wait briefly for terminal rendering or storage recovery
    if (result === 'pending') {
      const startedAt = this.reconciliationPendingSince.get(scope) ?? Date.now();
      this.reconciliationPendingSince.set(scope, startedAt);
      // retain queued work during the recovery window
      if (Date.now() - startedAt < answerCaptureGraceMs) return false;
    }
    this.reconciliationPendingSince.delete(scope);
    this.reconciled.add(scope);
    this.observedWorking.delete(scope);
    return true;
  }

  // record the answer the Transport reads back for the latest matching unanswered entry
  private async recoverAnswer(transport: TurnTransport, agentId: string, scope: string): Promise<'pending' | 'settled' | 'recorded'> {
    // require prompt history
    if (this.history === undefined || typeof this.history.list !== 'function') return 'settled';
    let entries: Awaited<ReturnType<PromptHistoryService['list']>>;
    // contain history read failures
    try { entries = await this.history.list(scope); }
    catch { entries = undefined; }
    // retry failed history reads
    if (entries === undefined) return 'pending';
    // stop when no response needs recovery
    if (!entries.some(candidate => candidate.answer === undefined)) return 'settled';
    const recovered = await transport.recoverAnswer(agentId, entries, this.observedWorking.has(scope));
    if (typeof recovered === 'string') return recovered;
    const recorded = await this.history.recordAnswer(scope, recovered.entryId, recovered.text).catch(() => undefined);
    return recorded === undefined ? 'pending' : 'recorded';
  }

  // a new Conversation started on the Agent: its earlier answers need no recovery
  private resetDelivered(scope: string): void {
    this.reconciled.add(scope);
    this.observedWorking.delete(scope);
    this.reconciliationPendingSince.delete(scope);
  }

  // split departed-owner recovery from each live agent's observation
  async reconcileCalendar(liveAgentIds?: readonly string[], onlyAgentId?: string): Promise<void> {
    const pending = await this.calendar?.pending().catch(() => []) ?? [];
    const live = liveAgentIds === undefined ? undefined : new Set(liveAgentIds);
    for (const activity of pending) {
      // live agents reconcile once through their own observation path
      if (live?.has(activity.agentId)) continue;
      // process-local observation does not rescan sibling native evidence
      if (onlyAgentId !== undefined && activity.agentId !== onlyAgentId) continue;
      const capability = this.resolveAdapter(activity.kind as AgentKind)?.managedPromptLifecycleV1;
      await this.calendar?.observe(activity.id, capability).catch(() => undefined);
      if (live !== undefined && !live.has(activity.agentId)) await this.calendar?.missing(activity.id).catch(() => undefined);
    }
  }

  // advance a Turn-less prompt: no answer to capture, so completion is the
  // working -> finished transition and the durable queue is released on finished
  private async observeTurnless(transport: TurnTransport, agent: Pick<Agent, 'id' | 'attention'>, scope: string, reported: boolean): Promise<void> {
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry a failed queue transfer without dispatching
    if (phase?.state === 'halted') {
      // clear abandoned native input before final note recovery
      if (!busy && await this.clearHaltedDraft(phase) && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    if (busy) {
      // the working report the reported-state machine was waiting for
      if (phase?.state === 'awaiting-start') this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now() });
      // adopt externally started work once prompts are queued
      else if (phase === undefined && (await this.queued?.list(scope))?.length) this.phases.set(scope, { state: 'working', changedAt: Date.now() });
      return;
    }
    if (phase !== undefined) {
      // a reported-state Agent must report `working` before `finished` counts as
      // completion; a paste that landed in a trust or fork prompt never does, so
      // fail the dispatch once the window elapses rather than release its queue
      if (reported && phase.state === 'awaiting-start') {
        if (Date.now() - phase.changedAt < reportedWorkingGraceMs) return;
        this.settleTrackedRequest(phase.requestId, 'failed', 'prompt_did_not_start');
        this.phases.set(scope, { ...phase, state: 'halted', changedAt: Date.now() });
        if (await this.saveQueued(scope)) this.phases.delete(scope);
        return;
      }
      // working -> finished: the prompt completed; its history entry stays answerless
      this.settleTrackedRequest(phase.requestId, 'complete');
      this.phases.delete(scope);
    }
    await this.dispatch(transport, agent.id, scope);
  }

  // an Agent's queue and history end with it: once it has been absent from discovery for the
  // grace window, its queued prompts drain into Notes and its history is dropped. Scopes from
  // before prompts were per-Agent (keyed by Worktree id) have no live owner and drain the same way.
  async retireDeparted(liveAgentIds: readonly string[]): Promise<void> {
    if (this.queued === undefined || Date.now() - this.sweptAt < departedSweepMs) return;
    this.sweptAt = Date.now();
    const live = new Set(liveAgentIds.map(promptScope));
    const stored = new Set([...await this.queued.scopes(), ...await this.history?.scopes() ?? []]);
    for (const scope of this.departedSince.keys()) if (live.has(scope) || !stored.has(scope)) this.departedSince.delete(scope);
    const now = Date.now();
    for (const scope of stored) {
      // a restarting Agent is briefly absent; its restart hands the scope over
      if (live.has(scope) || this.restartLocks.has(scope)) continue;
      const since = this.departedSince.get(scope) ?? now;
      if (now - since < departedAgentGraceMs) {
        this.departedSince.set(scope, since);
        continue;
      }
      // a prompt with nowhere to go stays queued; retry after another grace window
      if (!await this.saveQueued(scope)) {
        this.departedSince.set(scope, now);
        continue;
      }
      await this.history?.clearScope(scope);
      await this.forget(scope);
    }
  }

  // a restarted Agent carries on in its replacement pane: queued prompts and history follow it.
  // Call while the restart lock still holds the departing Agent's scope.
  async handOver(fromAgentId: string, toAgentId: string): Promise<void> {
    const from = promptScope(fromAgentId);
    const to = promptScope(toAgentId);
    // prompts that cannot move stay with the departed scope and drain into Notes
    if (this.queued !== undefined && !await this.queued.moveScope(from, to)) return;
    await this.calendar?.handOver(fromAgentId, toAgentId).catch(() => undefined);
    await this.dispatchHooks?.handedOver(fromAgentId, toAgentId).catch(() => undefined);
    // only queued requests have exact transfer identity during a restart handoff
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId !== fromAgentId || request.terminalAt !== undefined) continue;
      if (request.submitted) this.settleTrackedRequest(requestId, 'interrupted', 'agent_handover');
      else this.trackedRequests.set(requestId, { ...request, agentId: toAgentId });
    }
    await this.history?.moveScope(from, to);
    await this.forget(from);
  }

  private async forget(scope: string): Promise<void> {
    this.departedSince.delete(scope);
    this.senders.delete(scope.slice(promptScope('').length));
    this.settleTrackedRequest(this.phases.get(scope)?.requestId, 'interrupted', 'agent_departed');
    this.phases.delete(scope);
    for (const state of [this.reconciled, this.observedWorking, this.reconciliationPendingSince]) state.delete(scope);
    await this.transport.forget(scope);
  }

  // drain a halted queue's prompts into Notes, in order, one Note per prompt
  private async saveQueued(scope: string): Promise<boolean> {
    if (this.dispatching.has(scope) || this.queued === undefined || this.drainUndelivered === undefined) return false;
    this.dispatching.add(scope);
    try {
      // preserve every prompt until its Note is durable
      while (true) {
        const prompt = await this.queued.next(scope);
        if (prompt === undefined) return true;
        const result = await this.queued.consumeOnSuccess(scope, prompt.id, queued => this.drainUndelivered!(scope, queued));
        if (result === 'failed') return false;
        // a durable note recovery is terminal failure for the requested action
        if (result === 'consumed') {
          this.settleTrackedRequest(prompt.id, 'failed', 'prompt_not_delivered');
          await this.calendar?.invalid(prompt.id, 'missing_lifecycle_evidence').catch(() => undefined);
        }
      }
    } catch {
      return false;
    } finally {
      this.dispatching.delete(scope);
    }
  }

  // scheduled runs may supply a reset instant; interactive resets retain their own
  // the head goes out at once on submit, or having `waited` behind earlier work
  private async dispatch(transport: TurnTransport, agentId: string, scope: string, resetAt?: number, waited = true): Promise<void> {
    // reject overlapping or held dispatches
    if (this.dispatching.has(scope) || this.phases.has(scope) || this.restartLocks.has(scope) || transport.held(agentId)) return;
    this.dispatching.add(scope);
    try {
      const hooks = this.dispatchHooks;
      const prompt = await this.queued?.next(scope, hooks === undefined ? undefined : candidate => hooks.admits(agentId, candidate));
      // consume only after the adapter confirms submission
      if (prompt !== undefined) {
        const status = await this.send(transport, agentId, prompt.text, prompt.attachments ?? [], { durable: true, resetAt, queuedPromptId: prompt.id, sender: senderOf(prompt), ...(waited ? { waited: true as const } : {}) });
        // exact tracked failures halt instead of replaying on a later observation; a busy Agent
        // keeps the prompt queued for its next settle
        if (status !== 'submitted' && status !== 'busy' && this.trackedRequests.has(prompt.id)) {
          const phase = this.phases.get(scope);
          this.settleTrackedRequest(prompt.id, 'failed', 'prompt_submission_failed');
          this.phases.set(scope, { ...(phase ?? { state: 'halted' as const, changedAt: Date.now() }), state: 'halted', changedAt: Date.now(), requestId: prompt.id });
        }
        if (status === 'submitted') await this.queued?.remove(scope, prompt.id);
      }
    } finally { this.dispatching.delete(scope); }
  }

  // deliver one prompt over the Transport and track the Turn it started
  private async send(transport: TurnTransport, agentId: string, prompt: string, attachments: PromptAttachment[], options: TurnDeliveryOptions): Promise<TurnDelivery['status']> {
    const scope = promptScope(agentId);
    const requestId = options.queuedPromptId;
    const calendar = this.calendar;
    // the Calendar records the exact send intent before the submit keys
    const intent = requestId === undefined || calendar === undefined ? {} : { intent: (send: SendIntent) => calendar.beforeSend({ id: requestId, agentId, submittedAt: send.sentAt, ...send }) };
    // hold the scope so a quick second submit queues behind this one while its draft renders
    const delivery = await transport.deliver(agentId, prompt, attachments, { ...options, ...intent }, historyPrompt => {
      this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt, ...(options.sender === undefined ? {} : { sender: options.sender }) });
    });
    // a rejected target cannot leave an admitted interval eligible for later delivery
    if (delivery.status === 'held' && delivery.intended === true && requestId !== undefined) await calendar?.invalid(requestId, 'missing_lifecycle_evidence').catch(() => undefined);
    // halt only when a durable prompt is still waiting
    if (delivery.status === 'held') await this.holdFailedSubmission(scope, delivery.failedDraft);
    if (delivery.status !== 'submitted') return delivery.status;
    this.markTrackedRequestSubmitted(requestId);
    const sender = options.sender ?? {};
    this.senders.set(agentId, sender);
    if (delivery.instant) {
      this.settleTrackedRequest(requestId, 'complete');
      // release the provisional render phase instead of waiting for a nonexistent answer
      this.phases.delete(scope);
      if (delivery.reset === true) this.resetDelivered(scope);
      return 'submitted';
    }
    // track real prompts and their answers rather than reset commands
    const entry = await this.history?.record(scope, delivery.prompt, sender).catch(() => undefined);
    // monitor managed prompt completion
    if (this.queued !== undefined || requestId !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt: delivery.prompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }), ...(delivery.rolloutBaseline === undefined ? {} : { rolloutBaseline: delivery.rolloutBaseline }), sender });
    // recorded before the prompt leaves the queue, so a restart never takes a Turn that ran for one that did not
    if (requestId !== undefined) await this.dispatchHooks?.delivered(agentId, requestId, sender, entry?.id).catch(() => undefined);
    return 'submitted';
  }

  // keep failed queues pending while their observed native draft cannot be cleared
  private async clearHaltedDraft(phase: PromptPhase): Promise<boolean> {
    return phase.failedDraft === undefined || await this.transport.clearDraft(phase.failedDraft);
  }

  // halt redispatch only while durable queue state remains
  private async holdFailedSubmission(scope: string, failedDraft?: FailedDraft): Promise<void> {
    const waiting = await this.queued?.list(scope);
    const requestId = this.phases.get(scope)?.requestId;
    // protect queued prompts from duplicate repaste
    if ((waiting?.length ?? 0) > 0) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), ...(failedDraft === undefined ? {} : { failedDraft }) });
    else this.phases.delete(scope);
  }

  // find one durable prompt whose answer tracking may have restarted
  private async latestUnanswered(scope: string) {
    // skip deployments without prompt history
    if (this.history === undefined || typeof this.history.list !== 'function') return undefined;
    const entries = await this.history.list(scope);
    const latest = entries?.[0];
    // never attach new work to older unanswered history
    return latest?.answer === undefined ? latest : undefined;
  }

  // persist one settled Turn's answer to history, retrying transient or missing-entry writes
  private async persistAnswer(scope: string, entryId: string | undefined, answer: string): Promise<PromptCompletion> {
    if (this.history === undefined || entryId === undefined) return 'completed';
    const stored = await this.history.recordAnswer(scope, entryId, answer).catch(() => undefined);
    return stored === undefined ? 'pending' : 'completed';
  }

  // reveal a collapsed native question without choosing or submitting an answer
  async openQueuedQuestion(agentId: string, observedCapture: string, mayOpen: () => boolean): Promise<boolean> {
    return await this.transport.openQueuedQuestion(agentId, observedCapture, mayOpen);
  }

  // answer the current question directly without queueing a new agent turn
  async answerQuestion(agentId: string, questionId: string, answer: QuestionAnswer): Promise<boolean> {
    return await (await this.transportFor(agentId)).answer(agentId, questionId, answer);
  }

  // Redirect a working Agent at once, where its Transport can steer. A steer is not queued;
  // history keeps it as its own entry, with no answer.
  async steer(agentId: string, prompt: string): Promise<'sent' | 'unsupported' | 'refused'> {
    const transport = await this.transportFor(agentId);
    const outcome = transport.steer === undefined ? 'unsupported' : await transport.steer(agentId, prompt);
    if (outcome === 'sent') await this.history?.record(promptScope(agentId), prompt).catch(() => undefined);
    return outcome;
  }

  // interrupt a working Agent, holding the in-flight prompt's queue rather than releasing it;
  // `returned` hears the steers it dropped
  async cancel(agentId: string, returned?: (steers: string[]) => void): Promise<InterruptOutcome> {
    const scope = promptScope(agentId);
    this.cancelling.add(scope);
    let outcome: InterruptOutcome;
    try { outcome = await (await this.transportFor(agentId)).interrupt(agentId, returned); }
    finally { this.cancelling.delete(scope); }
    if (outcome !== 'ok') return outcome;
    const phase = this.phases.get(scope);
    this.settleTrackedRequest(phase?.requestId, 'interrupted', 'prompt_interrupted');
    if (this.queued !== undefined) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(phase?.requestId === undefined ? {} : { requestId: phase.requestId }) });
    return 'ok';
  }

  // stop one Agent; closing it makes every accepted tracked request terminal. A structured
  // Agent's queue becomes Notes at once; a pane's departs with it after the departure grace.
  async close(agentId: string): Promise<boolean> {
    const transport = await this.transportFor(agentId);
    if (!await transport.close(agentId)) return false;
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId === agentId && request.terminalAt === undefined) this.settleTrackedRequest(requestId, 'interrupted', 'agent_closed');
    }
    // the Turn it was on ends with it, tracked or not
    this.settleTrackedRequest(this.phases.get(promptScope(agentId))?.requestId, 'interrupted', 'agent_closed');
    this.senders.delete(agentId);
    if (transport === this.structured) await this.saveQueued(promptScope(agentId));
    return true;
  }
}
