import { createHash, randomBytes } from 'node:crypto';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { adapterFor } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
import type { PromptCalendarLifecycle } from '../google-calendar/lifecycle.js';
import type { Agent } from '../domain/models.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { agentAttentionState } from '../notifications.js';
import { promptScope, QueuedPromptService, type QueuedPrompt, type QueuedPromptOrigin, type QueuedPromptSummary } from './queue.js';
import { validPrompt, type PromptAttachment } from './validation.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
import { reportsOwnState, TmuxTransport, type AdapterView, type AttachmentStagingWorkspace, type DeliveryOptions, type FailedDraft, type TurnMark } from '../transports/tmux.js';
import type { InterruptOutcome } from '../transports/transport.js';
export { maxPromptAttachmentBytes, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';
export { promptScope } from './queue.js';
export type { AttachmentStagingWorkspace } from '../transports/tmux.js';

// where a halted queue's prompts are drained: each queued prompt is handed to this sink, in order,
// and removed only when the sink reports it durable. The console wires it to the notes store; a
// false return leaves the prompt queued and the queue halted (see saveQueued).
export type UndeliveredDrain = (scope: string, prompt: QueuedPrompt) => Promise<boolean>;

const answerCaptureGraceMs = 10_000;
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
type PromptPhase = TurnMark & { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; requestId?: string; historyEntryId?: string; historyPrompt?: string; failedDraft?: FailedDraft };

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
  private readonly lockedAgentIds = new Set<string>();
  private readonly activeMutations = new Map<string, number>();
  private readonly mutationVersions = new Map<string, number>();
  private readonly departedSince = new Map<string, number>();
  private sweptAt = -Infinity;
  private lifecycleMutationVersion = 0;

  // bind queue delivery and optional shared host staging
  // the Transport is built from the delivery arguments unless one is given, whose input
  // reservations must then be this service's
  constructor(discovery: DiscoveryService, tmux: TmuxAdapter, private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService, private readonly drainUndelivered?: UndeliveredDrain, private readonly resolveAdapter: (kind: AgentKind) => AdapterView | undefined = adapterFor, teardownFor: (kind: AgentKind) => string | undefined = () => undefined, attachmentStaging?: AttachmentStagingWorkspace, private readonly calendar?: PromptCalendarLifecycle, transport?: TmuxTransport) {
    const locks = { begin: (agentId: string) => this.beginAgentMutation(agentId), version: (agentId: string) => this.mutationVersion(agentId), busy: (agentId: string) => this.mutating(agentId) };
    this.transport = transport ?? new TmuxTransport(discovery, tmux, locks, history, queued, resolveAdapter, teardownFor, attachmentStaging, calendar);
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
  private async submitRequest(agentId: string, prompt: string, attachments: PromptAttachment[], resetAt: number | undefined, tracked: boolean): Promise<{ accepted: boolean; requestId?: string }> {
    if (!validPrompt(prompt, attachments)) return { accepted: false };
    const releaseMutation = this.beginAgentMutation(agentId);
    const first = await this.transport.target(agentId);
    // release reservations for vanished targets
    if (!first) {
      releaseMutation?.();
      return { accepted: false };
    }
    const scope = promptScope(agentId);
    const origin: QueuedPromptOrigin = { home: first.agent.home, ...(first.agent.placeId === undefined ? {} : { placeId: first.agent.placeId }) };
    // queue work arriving during a restart handoff
    if (releaseMutation === undefined || this.restartLocks.has(scope)) {
      releaseMutation?.();
      const queued = await this.queued?.enqueue(scope, prompt, attachments, origin);
      if (queued !== undefined) await this.admitCalendar(queued.id, agentId, first.agent.kind, queued.createdAt, prompt, attachments);
      // retain exact queue identity through the restart handoff
      if (tracked && queued !== undefined) this.trackQueuedRequest(queued.id, agentId, prompt);
      return { accepted: queued !== undefined, ...(tracked && queued !== undefined ? { requestId: queued.id } : {}) };
    }
    try {
      await this.transport.restoreReset(scope, agentId);
      const previousReset = this.transport.reset(scope);
      this.transport.retryExpiredReset(scope, agentId);
      const waiting = await this.queued?.list(scope);
      // retain prompts behind active or halted work
      if (this.queued !== undefined && (agentAttentionState(first.agent) !== 'finished' || this.phases.has(scope) || previousReset?.state === 'pending' || previousReset !== undefined && previousReset.agentId !== agentId || (waiting?.length ?? 0) > 0)) {
        const adopting = agentAttentionState(first.agent) !== 'finished' && !this.phases.has(scope) && previousReset === undefined;
        const mark = adopting ? await this.transport.mark(first.agent) : {};
        const queued = await this.queued.enqueue(scope, prompt, attachments, origin);
        if (queued !== undefined) await this.admitCalendar(queued.id, agentId, first.agent.kind, queued.createdAt, prompt, attachments);
        // register before any later observer can dispatch this queue item
        if (tracked && queued !== undefined) this.trackQueuedRequest(queued.id, agentId, prompt);
        // track work that started outside the managed prompt flow
        if (queued !== undefined && adopting) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...mark });
        return { accepted: queued !== undefined, ...(tracked && queued !== undefined ? { requestId: queued.id } : {}) };
      }
      // persist direct work before attempting interactive delivery
      if (this.queued !== undefined) {
        const queued = await this.queued.enqueue(scope, prompt, attachments, origin);
        // stop before paste when durable storage is unavailable
        if (queued === undefined) return { accepted: false };
        await this.admitCalendar(queued.id, agentId, first.agent.kind, queued.createdAt, prompt, attachments);
        // publish identity before synchronous dispatch can advance it
        if (tracked) this.trackQueuedRequest(queued.id, agentId, prompt);
        // delivery may remain queued without rejecting the accepted request
        await this.dispatch(agentId, scope, resetAt);
        return { accepted: true, ...(tracked ? { requestId: queued.id } : {}) };
      }
      const requestId = tracked || this.calendar !== undefined ? randomBytes(18).toString('base64url') : undefined;
      if (requestId !== undefined) await this.admitCalendar(requestId, agentId, first.agent.kind, new Date().toISOString(), prompt, attachments);
      // direct deployments still receive a unique process-local identity
      if (requestId !== undefined) this.trackQueuedRequest(requestId, agentId, prompt);
      const accepted = await this.send(agentId, prompt, attachments, { discovered: first, resetAt, ...(requestId === undefined ? {} : { queuedPromptId: requestId }) });
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
  private settleTrackedRequest(requestId: string | undefined, state: 'complete' | 'failed' | 'interrupted', error?: string): void {
    if (requestId === undefined) return;
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
  private async admitCalendar(id: string, agentId: string, kind: AgentKind, submittedAt: string, prompt: string, attachments: PromptAttachment[]): Promise<void> {
    if (this.calendar === undefined || attachments.length === 0 && prompt.startsWith('!')) return;
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
    return await this.send(agentId, prompt, [], { discovered: target, submission: 'confirmed-enter' });
  }

  // mark one advisor reusable only after its initial prompt is scheduled
  async markUpdateAdvisorReady(agentId: string, targetSha: string): Promise<boolean> {
    return await this.transport.markUpdateAdvisorReady(agentId, targetSha);
  }

  // reserve one agent for an idle restart
  async acquireRestartLock(agentId: string, expectedMutationVersion?: number, expectedMutationGeneration?: number): Promise<(() => void) | undefined> {
    const target = await this.transport.target(agentId);
    // require a current target
    if (target === undefined) return undefined;
    const scope = promptScope(agentId);
    await this.transport.restoreReset(scope, agentId);
    // reject overlapping input and lifecycle work
    const reset = this.transport.reset(scope);
    // reserve a live owner's reset even when a sibling shares the queue scope
    if (this.restartLocks.has(scope) || this.lockedAgentIds.has(agentId) || this.phases.has(scope) || reset?.state === 'pending' || reset !== undefined && reset.agentId !== agentId || this.mutating(agentId)
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
    const target = await this.transport.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.list(promptScope(agentId));
  }

  async updateQueued(agentId: string, promptId: string, text: string): Promise<QueuedPromptSummary | undefined> {
    const target = await this.transport.target(agentId);
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
    const target = await this.transport.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.move(promptScope(agentId), promptId, direction);
  }

  async removeQueued(agentId: string, promptId: string): Promise<boolean> {
    const target = await this.transport.target(agentId);
    const removed = target !== undefined && this.queued !== undefined && await this.queued.remove(promptScope(agentId), promptId) !== undefined;
    // removed tracked work can never be dispatched
    if (removed) {
      this.settleTrackedRequest(promptId, 'failed', 'queue_removed');
      await this.calendar?.invalid(promptId, 'missing_lifecycle_evidence').catch(() => undefined);
    }
    return removed;
  }

  // advance managed prompt completion over the Transport's Turn feed
  async observe(agent: Pick<Agent, 'id' | 'displayLabel' | 'home' | 'attention' | 'kind'>): Promise<void> {
    const scope = promptScope(agent.id);
    await this.transport.restoreReset(scope, agent.id);
    // pause observation during restart handoffs and in-flight delivery
    if (this.restartLocks.has(scope) || this.dispatching.has(scope)) return;
    const reset = this.transport.reset(scope);
    // duplicate agents cannot settle, expire, or dispatch another pane's reset
    if (reset !== undefined && reset.agentId !== agent.id) return;
    // an Adapter without Turn capture cannot read an answer back: complete on
    // working -> finished, store the prompt alone, and skip the grace/halt path
    const adapter = this.resolveAdapter(agent.kind);
    // reconcile durable correlations even when process-local prompt phases were lost on restart
    await this.reconcileCalendar(undefined, agent.id);
    // a reset spinner is not a model turn and must never enter answer recovery
    if (this.transport.reset(scope)?.state === 'pending' && !this.phases.has(scope)) {
      // use fresh reset readiness rather than a possibly stale dashboard attention snapshot
      const settled = await this.transport.settleReset(agent.id, scope, adapter);
      if (settled === 'expired') await this.holdFailedSubmission(scope);
      if (settled === 'ready') await this.dispatch(agent.id, scope);
      return;
    }
    if (adapter !== undefined && adapter.turns === undefined) return this.observeTurnless(agent, scope, reportsOwnState(adapter));
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
      const restartedEntry = phase === undefined && !this.transport.sawWorking(scope) ? await this.latestUnanswered(scope) : undefined;
      this.transport.working(scope);
      // mark the prompt as started
      if (phase?.state === 'awaiting-start' || phase?.state === 'awaiting-answer') {
        const started = await this.transport.observe(agent, phase);
        this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now(), ...(started?.type === 'started' ? started.mark : {}) });
      }
      const waiting = phase === undefined ? await this.queued?.list(scope) : undefined;
      // inspect queued or restart-orphaned work
      if (phase === undefined && ((waiting?.length ?? 0) > 0 || restartedEntry !== undefined)) {
        const mark = await this.transport.mark(agent);
        // adopt an unanswered entry only with structured completion tracking
        const recoveringEntry = mark.rolloutBaseline === undefined ? undefined : restartedEntry;
        // retain terminal reconciliation when rollout tracking is unavailable
        if ((waiting?.length ?? 0) > 0 || recoveringEntry !== undefined) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(recoveringEntry === undefined ? {} : { historyEntryId: recoveringEntry.id, historyPrompt: recoveringEntry.text }), ...mark });
      }
      return;
    }
    // finish tracked work before releasing its queue
    if (phase !== undefined) {
      const event = await this.transport.observe(agent, phase);
      const completion: PromptCompletion = event === undefined || event.type === 'started' ? 'pending' : event.type === 'settled' ? await this.persistAnswer(scope, phase.historyEntryId, event.message) : 'failed';
      // allow terminal output to finish rendering
      if (completion === 'pending' && phase.state === 'working') {
        this.phases.set(scope, { ...phase, state: 'awaiting-answer', changedAt: Date.now() });
        return;
      }
      // retry capture and persistence during the grace window
      if (completion === 'pending' && Date.now() - phase.changedAt < answerCaptureGraceMs) return;
      // external resets can spin without a turn; never fail work we have not attempted
      if (completion === 'pending' && phase.historyPrompt === undefined && phase.historyEntryId === undefined) {
        // preserve the queue until the actual pane is ready
        const before = await this.transport.externalReset(agent.id, adapter);
        if (before === undefined) return;
        // reserve the adopted phase while its durable reset boundary is written
        if (this.phases.get(scope) !== phase || this.dispatching.has(scope)) return;
        this.dispatching.add(scope);
        try {
          // the reset time is unknown; follow the pane's first rollout replacement instead
          await this.transport.rememberReset(scope, { agentId: agent.id, at: Date.now(), before, external: true }, 'ready');
          this.phases.delete(scope);
        } finally { this.dispatching.delete(scope); }
        await this.dispatch(agent.id, scope);
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
        if (!await this.transport.reconcile(agent.id, scope)) return;
      }
      // release completed prompts
      this.settleTrackedRequest(phase.requestId, 'complete');
      this.phases.delete(scope);
    }
    // recover answer tracking lost across restarts
    if (phase === undefined && !this.transport.isReconciled(scope) && !await this.transport.reconcile(agent.id, scope)) return;
    await this.dispatch(agent.id, scope);
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
  private async observeTurnless(agent: Pick<Agent, 'id' | 'attention'>, scope: string, reported: boolean): Promise<void> {
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
    await this.dispatch(agent.id, scope);
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
      await this.queued.resets.clear(scope);
      this.forget(scope);
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
    // only queued requests have exact transfer identity during a restart handoff
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId !== fromAgentId || request.terminalAt !== undefined) continue;
      if (request.submitted) this.settleTrackedRequest(requestId, 'interrupted', 'agent_handover');
      else this.trackedRequests.set(requestId, { ...request, agentId: toAgentId });
    }
    await this.history?.moveScope(from, to);
    await this.queued?.resets.clear(from);
    this.forget(from);
  }

  private forget(scope: string): void {
    this.departedSince.delete(scope);
    this.settleTrackedRequest(this.phases.get(scope)?.requestId, 'interrupted', 'agent_departed');
    this.phases.delete(scope);
    this.transport.forget(scope);
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
  private async dispatch(agentId: string, scope: string, resetAt?: number): Promise<void> {
    // reject overlapping or held dispatches
    if (this.dispatching.has(scope) || this.phases.has(scope) || this.restartLocks.has(scope) || this.transport.reset(scope)?.state === 'pending') return;
    this.dispatching.add(scope);
    try {
      const prompt = await this.queued?.next(scope);
      // consume only after the adapter confirms submission
      if (prompt !== undefined) {
        const submitted = await this.send(agentId, prompt.text, prompt.attachments ?? [], { durable: true, resetAt, queuedPromptId: prompt.id });
        // exact tracked failures halt instead of replaying on a later observation
        if (!submitted && this.trackedRequests.has(prompt.id)) {
          const phase = this.phases.get(scope);
          this.settleTrackedRequest(prompt.id, 'failed', 'prompt_submission_failed');
          this.phases.set(scope, { ...(phase ?? { state: 'halted' as const, changedAt: Date.now() }), state: 'halted', changedAt: Date.now(), requestId: prompt.id });
        }
        if (submitted) await this.queued?.remove(scope, prompt.id);
      }
    } finally { this.dispatching.delete(scope); }
  }

  // deliver one prompt over the Transport and track the Turn it started
  private async send(agentId: string, prompt: string, attachments: PromptAttachment[], options: DeliveryOptions): Promise<boolean> {
    const scope = promptScope(agentId);
    const requestId = options.queuedPromptId;
    // hold the scope so a quick second submit queues behind this one while its draft renders
    const delivery = await this.transport.deliver(agentId, prompt, attachments, options, historyPrompt => {
      this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt });
    });
    // halt only when a durable prompt is still waiting
    if (delivery.status === 'held') await this.holdFailedSubmission(scope, delivery.failedDraft);
    if (delivery.status !== 'submitted') return false;
    this.markTrackedRequestSubmitted(requestId);
    if (delivery.instant) {
      this.settleTrackedRequest(requestId, 'complete');
      // release the provisional render phase instead of waiting for a nonexistent answer
      this.phases.delete(scope);
      return true;
    }
    // track real prompts and their answers rather than reset commands
    const entry = await this.history?.record(scope, delivery.prompt).catch(() => undefined);
    // monitor managed prompt completion
    if (this.queued !== undefined || requestId !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt: delivery.prompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }), ...(delivery.rolloutBaseline === undefined ? {} : { rolloutBaseline: delivery.rolloutBaseline }) });
    return true;
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
  async answerQuestion(agentId: string, questionId: string, answer: number | string): Promise<boolean> {
    return await this.transport.answer(agentId, questionId, answer);
  }

  // interrupt a working Agent, holding the in-flight prompt's queue rather than releasing it
  async cancel(agentId: string): Promise<InterruptOutcome> {
    const outcome = await this.transport.interrupt(agentId);
    if (outcome !== 'ok') return outcome;
    const scope = promptScope(agentId);
    const phase = this.phases.get(scope);
    this.settleTrackedRequest(phase?.requestId, 'interrupted', 'prompt_interrupted');
    if (this.queued !== undefined) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(phase?.requestId === undefined ? {} : { requestId: phase.requestId }) });
    return 'ok';
  }

  // stop one Agent; closing it makes every accepted tracked request terminal
  async close(agentId: string): Promise<boolean> {
    if (!await this.transport.close(agentId)) return false;
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId === agentId && request.terminalAt === undefined) this.settleTrackedRequest(requestId, 'interrupted', 'agent_closed');
    }
    return true;
  }
}
