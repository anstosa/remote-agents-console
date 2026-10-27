import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { codexCollapsedPasteLabel, failedTurnFromCapture, lastPromptFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from '../adapters/codex-turns.js';
import { adapterFor } from '../adapters/registry.js';
import { codexFamily, type Adapter, type AgentKind, type CompletionBaseline, type CompletionEvent, type PaneSnapshot, type Submission, type SubmissionDraftState, type SubmissionMode, type TmuxKey } from '../adapters/types.js';
import type { PromptCalendarLifecycle } from '../google-calendar/lifecycle.js';
import type { Agent } from '../domain/models.js';
import { run } from '../tmux/command.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { agentAttentionState } from '../notifications.js';
import { QueuedPromptService, type QueuedPrompt, type QueuedPromptOrigin, type QueuedPromptSummary } from './queue.js';
import type { ResetBoundary } from './reset-boundaries.js';
import { maxPromptAttachmentBytes, promptAttachmentData, promptAttachmentName, validPrompt, validPromptAttachments, type PromptAttachment } from './validation.js';
import { expandCommand } from '../launch/service.js';
import { configuredWorktreeForWorkspace } from '../workspaces/resolver.js';
import { updateAdvisorLabel, updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
export { maxPromptAttachmentBytes, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';

// where a halted queue's prompts are drained: each queued prompt is handed to this sink, in order,
// and removed only when the sink reports it durable. The console wires it to the notes store; a
// false return leaves the prompt queued and the queue halted (see saveQueued).
export type UndeliveredDrain = (scope: string, prompt: QueuedPrompt) => Promise<boolean>;
// queued prompts and history belong to the Agent they were sent to, never to a sibling at its Worktree
export const promptScope = (agentId: string) => `agent:${agentId}`;

const answerCaptureGraceMs = 10_000;
// a pane missing from a few discovery ticks (a socket that briefly fails to list) is not a departed Agent
const departedAgentGraceMs = 30_000;
// the sweep reads both stores, history from disk; it need not run every dashboard tick
const departedSweepMs = 10_000;
// preserve prompts through reset startup but do not strand them behind a dead pane
const conversationResetGraceMs = 10_000;
// a reported-state prompt must report `working` within this window or the dispatch is failed
const reportedWorkingGraceMs = 5_000;
// a queued submit key can be swallowed when it races an unrendered composer
// wait briefly for a stable draft and retain the queue item if rendering fails
const composerRenderAttempts = 40;
const composerRenderPollMs = 50;
const composerRenderStableMs = 100;
// recover slow native submission without keeping failed queues in flight indefinitely
const submissionAcceptGraceMs = 4_000;
// space retries within the acceptance deadline
const submissionRetryAttempts: ReadonlySet<number> = new Set([6, 14, 30, 50, 70]);
const trackedRequestTerminalTtlMs = 60 * 60 * 1_000;
const maxTrackedTerminalRequests = 1_000;
// the console never composes submission through an unknown kind
type AdapterView = Pick<Adapter, 'stateSource' | 'submission' | 'turns' | 'questions' | 'completion' | 'managedPromptLifecycleV1' | 'newConversation'>;
type CancelOutcome = 'ok' | 'unavailable' | 'not-working';
// an Adapter that announces its own Attention state (rather than the console
// inferring it from the title): it must report `working` before a prompt counts
// as complete, and fires no Stop hook on an interrupt, so the console writes
// `finished` itself.
const reportsOwnState = (adapter: AdapterView) => adapter.stateSource !== 'title';
const attachmentIgnoreRule = '/node_modules/.remote-agent-console/';
const updateAdvisorComposerAttempts = 100;
const updateAdvisorReadyStableMs = 500;
const updateAdvisorStartAttempts = 50;
const updateAdvisorPollMs = 100;
// normalize terminal-wrapped prompts
const normalizedPrompt = (value: string) => value.replace(/\s+/gu, ' ').trim();
// normalize one styled terminal snapshot
const normalizedTerminalText = (value: string) => normalizedPrompt(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ''));
type PromptCompletion = 'completed' | 'failed' | 'pending';
type PromptReconciliation = 'pending' | 'settled' | 'recorded';
export type PromptRequestStatus = { id: string; agentId: string; state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted'; submitted: boolean; error?: string };
type StoredPromptRequest = PromptRequestStatus & { terminalAt?: number; promptFingerprint: string };
// retain a failed native draft until clearing succeeds or ownership is lost
type FailedDraft = { agentId: string; target: DiscoveredTarget; prompt: string; submission: Adapter['submission'] };
type PromptPhase = { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; requestId?: string; historyEntryId?: string; historyPrompt?: string; baselineCompletion?: string; rolloutBaseline?: CompletionBaseline; failedDraft?: FailedDraft };
type DiscoveredTarget = NonNullable<Awaited<ReturnType<DiscoveryService['target']>>> & { processId?: number };
// pair the shared staging directory with its agent-visible host namespace
export type AttachmentStagingWorkspace = { workspace: string; hostWorkspace: string | undefined };
// keep reset readiness and its first-turn boundary separate from model completion
type ConversationReset = ResetBoundary & { observed: PaneSnapshot[]; state: 'pending' | 'ready' | 'expired' };
// share the adapter's reset and readiness snapshot shape
const paneSnapshot = (agent: Agent): PaneSnapshot => ({ title: agent.title, attention: agentAttentionState(agent), ...(agent.conversationId === undefined ? {} : { conversationId: agent.conversationId }) });
export class PromptService {
  private readonly phases = new Map<string, PromptPhase>();
  private readonly trackedRequests = new Map<string, StoredPromptRequest>();
  // retain the reset instant until the first real prompt anchors its fresh rollout
  private readonly conversationResets = new Map<string, ConversationReset>();
  // hydrate each scope once before input or observation can race its durable boundary
  private readonly restoredResets = new Map<string, Promise<void>>();
  private readonly dispatching = new Set<string>();
  private readonly reconciled = new Set<string>();
  // track work observed after service startup
  private readonly observedWorking = new Set<string>();
  private readonly reconciliationPendingSince = new Map<string, number>();
  private readonly restartLocks = new Set<string>();
  private readonly lockedAgentIds = new Set<string>();
  private readonly activeMutations = new Map<string, number>();
  private readonly openedQueuedQuestions = new Set<string>();
  private readonly mutationVersions = new Map<string, number>();
  private readonly departedSince = new Map<string, number>();
  private sweptAt = -Infinity;
  private lifecycleMutationVersion = 0;

  // bind queue delivery and optional shared host staging
  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService, private readonly drainUndelivered?: UndeliveredDrain, private readonly resolveAdapter: (kind: AgentKind) => AdapterView | undefined = adapterFor, private readonly teardownFor: (kind: AgentKind) => string | undefined = () => undefined, private readonly attachmentStaging?: AttachmentStagingWorkspace, private readonly calendar?: PromptCalendarLifecycle) {}

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
    const first = await this.discovery.target(agentId);
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
      await this.restoreConversationReset(scope, agentId);
      const previousReset = this.conversationResets.get(scope);
      // retry readiness for new input without forgetting the original conversation boundary
      if (previousReset?.agentId === agentId && previousReset.state === 'expired') previousReset.state = 'pending';
      const waiting = await this.queued?.list(scope);
      // retain prompts behind active or halted work
      if (this.queued !== undefined && (agentAttentionState(first.agent) !== 'finished' || this.phases.has(scope) || previousReset?.state === 'pending' || previousReset !== undefined && previousReset.agentId !== agentId || (waiting?.length ?? 0) > 0)) {
        const adopting = agentAttentionState(first.agent) !== 'finished' && !this.phases.has(scope) && previousReset === undefined;
        const baselineCompletion = adopting ? await this.completionSignature(agentId) : undefined;
        const rolloutBaseline = adopting ? await this.captureRolloutBaseline(agentId, this.resolveAdapter(first.agent.kind)) : undefined;
        const queued = await this.queued.enqueue(scope, prompt, attachments, origin);
        if (queued !== undefined) await this.admitCalendar(queued.id, agentId, first.agent.kind, queued.createdAt, prompt, attachments);
        // register before any later observer can dispatch this queue item
        if (tracked && queued !== undefined) this.trackQueuedRequest(queued.id, agentId, prompt);
        // track work that started outside the managed prompt flow
        if (queued !== undefined && adopting) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }), ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }) });
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
      const accepted = await this.send(agentId, prompt, attachments, first, 'queue', false, resetAt, requestId);
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

  // Paste and submit a new-conversation reset command (`/clear`, `/new`) through the
  // Adapter's own submission path, without the history and completion tracking a real
  // prompt gets. The Run primitive drives the settle polling itself over the Adapter's
  // `newConversation.settled` rule (Scheduled prompts); this call only lands the command.
  async submitReset(agentId: string, command: string): Promise<boolean> {
    const first = await this.discovery.target(agentId);
    if (first === undefined) return false;
    const adapter = this.resolveAdapter(first.agent.kind);
    if (adapter === undefined) return false;
    const composed = adapter.submission.prepare(command, 'prompt');
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, composed.text)) return false;
    // re-read so the submit keys reflect send-time state and the pane is still the same one
    const submitTarget = await this.discovery.target(agentId, true);
    if (submitTarget === undefined || submitTarget.socket.fingerprint !== first.socket.fingerprint || submitTarget.agent.paneId !== first.agent.paneId) return false;
    // an idle pane takes the Adapter's idle keys (Codex submits `/new` with Enter, not Tab)
    const keys = agentAttentionState(submitTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
    const submitted = await this.tmux.sendKeys(submitTarget.socket, submitTarget.agent.paneId, keys);
    // clear stale prose questions after delivery
    if (submitted) this.discovery.invalidateMessageQuestion?.(agentId);
    return submitted;
  }

  // submit one server-owned advisor prompt directly
  async submitUpdateAdvisor(agentId: string, targetSha: string, prompt: string): Promise<boolean> {
    // require one exact pending advisor and valid generated prompt
    if (!isFullGitSha(targetSha) || !validPrompt(prompt, [])) return false;
    const target = await this.discovery.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.send(agentId, prompt, [], target, 'confirmed-enter');
  }

  // mark one advisor reusable only after its initial prompt is scheduled
  async markUpdateAdvisorReady(agentId: string, targetSha: string): Promise<boolean> {
    // require one server-owned target and live advisor pane
    if (!isFullGitSha(targetSha)) return false;
    const target = await this.discovery.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.tmux.label(target.socket, target.agent.paneId, updateAdvisorLabel(targetSha));
  }

  // reserve one agent for an idle restart
  async acquireRestartLock(agentId: string, expectedMutationVersion?: number, expectedMutationGeneration?: number): Promise<(() => void) | undefined> {
    const target = await this.discovery.target(agentId);
    // require a current target
    if (target === undefined) return undefined;
    const scope = promptScope(agentId);
    await this.restoreConversationReset(scope, agentId);
    // reject overlapping input and lifecycle work
    const reset = this.conversationResets.get(scope);
    // reserve a live owner's reset even when a sibling shares the queue scope
    if (this.restartLocks.has(scope) || this.lockedAgentIds.has(agentId) || this.phases.has(scope) || reset?.state === 'pending' || reset !== undefined && reset.agentId !== agentId || (this.activeMutations.get(agentId) ?? 0) > 0
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

  // snapshot all agent mutations
  mutationGeneration(): number {
    return this.lifecycleMutationVersion;
  }

  async listQueued(agentId: string): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.list(promptScope(agentId));
  }

  async updateQueued(agentId: string, promptId: string, text: string): Promise<QueuedPromptSummary | undefined> {
    const target = await this.discovery.target(agentId);
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
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.move(promptScope(agentId), promptId, direction);
  }

  async removeQueued(agentId: string, promptId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    const removed = target !== undefined && this.queued !== undefined && await this.queued.remove(promptScope(agentId), promptId) !== undefined;
    // removed tracked work can never be dispatched
    if (removed) {
      this.settleTrackedRequest(promptId, 'failed', 'queue_removed');
      await this.calendar?.invalid(promptId, 'missing_lifecycle_evidence').catch(() => undefined);
    }
    return removed;
  }

  // advance managed prompt completion
  async observe(agent: Pick<Agent, 'id' | 'displayLabel' | 'home' | 'attention' | 'kind'>): Promise<void> {
    const scope = promptScope(agent.id);
    await this.restoreConversationReset(scope, agent.id);
    // pause observation during restart handoffs and in-flight delivery
    if (this.restartLocks.has(scope) || this.dispatching.has(scope)) return;
    const reset = this.conversationResets.get(scope);
    // duplicate agents cannot settle, expire, or dispatch another pane's reset
    if (reset !== undefined && reset.agentId !== agent.id) return;
    // an Adapter without Turn capture cannot read an answer back: complete on
    // working -> finished, store the prompt alone, and skip the grace/halt path
    const adapter = this.resolveAdapter(agent.kind);
    // reconcile durable correlations even when process-local prompt phases were lost on restart
    await this.reconcileCalendar(undefined, agent.id);
    // a reset spinner is not a model turn and must never enter answer recovery
    if (this.conversationResets.get(scope)?.state === 'pending' && !this.phases.has(scope)) {
      // use fresh reset readiness rather than a possibly stale dashboard attention snapshot
      if (await this.settleConversationReset(agent.id, scope, adapter)) await this.dispatch(agent.id, scope);
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
      const restartedEntry = phase === undefined && !this.observedWorking.has(scope) ? await this.latestUnanswered(scope) : undefined;
      this.observedWorking.add(scope);
      this.reconciled.delete(scope);
      this.reconciliationPendingSince.delete(scope);
      // mark the prompt as started
      if (phase?.state === 'awaiting-start' || phase?.state === 'awaiting-answer') {
        const baselineCompletion = phase.baselineCompletion ?? await this.completionSignature(agent.id);
        // keep the pre-submit baseline a sent prompt already carries; capturing it now
        // would sit past this turn's own `task_started` and miss a fast completion
        const rolloutBaseline = phase.rolloutBaseline ?? (adapter === undefined ? undefined : await this.captureRolloutBaseline(agent.id, adapter));
        this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }), ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }) });
      }
      const waiting = phase === undefined ? await this.queued?.list(scope) : undefined;
      // inspect queued or restart-orphaned work
      if (phase === undefined && ((waiting?.length ?? 0) > 0 || restartedEntry !== undefined)) {
        const baselineCompletion = await this.completionSignature(agent.id);
        const rolloutBaseline = adapter === undefined ? undefined : await this.captureRolloutBaseline(agent.id, adapter);
        // adopt an unanswered entry only with structured completion tracking
        const recoveringEntry = rolloutBaseline === undefined ? undefined : restartedEntry;
        // retain terminal reconciliation when rollout tracking is unavailable
        if ((waiting?.length ?? 0) > 0 || recoveringEntry !== undefined) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(recoveringEntry === undefined ? {} : { historyEntryId: recoveringEntry.id, historyPrompt: recoveringEntry.text }), ...(baselineCompletion === undefined ? {} : { baselineCompletion }), ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }) });
      }
      return;
    }
    // finish tracked work before releasing its queue
    if (phase !== undefined) {
      const completion = await this.recordAnswer(agent.id, scope, phase.historyEntryId, phase.historyPrompt, phase.baselineCompletion, phase.state !== 'awaiting-start', phase.rolloutBaseline);
      // allow terminal output to finish rendering
      if (completion === 'pending' && phase.state === 'working') {
        this.phases.set(scope, { ...phase, state: 'awaiting-answer', changedAt: Date.now() });
        return;
      }
      // retry capture and persistence during the grace window
      if (completion === 'pending' && Date.now() - phase.changedAt < answerCaptureGraceMs) return;
      // external resets can spin without a turn; never fail work we have not attempted
      if (completion === 'pending' && phase.historyPrompt === undefined && phase.historyEntryId === undefined) {
        const target = await this.discovery.target(agent.id, true);
        const capability = adapter?.newConversation;
        const capture = target === undefined ? undefined : await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
        // preserve the queue until the actual pane is ready, not merely its cached title
        if (target === undefined || capability === undefined || capture === undefined
          || agentAttentionState(target.agent) !== 'finished' || capability.ready(paneSnapshot(target.agent), capture).state !== 'ready'
          || !capability.composerEmpty(capture)) return;
        // reserve the adopted phase while its durable reset boundary is written
        if (this.phases.get(scope) !== phase || this.dispatching.has(scope)) return;
        this.dispatching.add(scope);
        try {
          // the reset time is unknown; follow the pane's first rollout replacement instead
          await this.rememberConversationReset(scope, { agentId: agent.id, at: Date.now(), before: paneSnapshot(target.agent), external: true }, 'ready');
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
        if (!await this.reconciliationComplete(agent.id, scope)) return;
      }
      // release completed prompts
      this.settleTrackedRequest(phase.requestId, 'complete');
      this.phases.delete(scope);
    }
    // recover answer tracking lost across restarts
    if (phase === undefined && !this.reconciled.has(scope) && !await this.reconciliationComplete(agent.id, scope)) return;
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
    for (const state of [this.phases, this.conversationResets, this.restoredResets, this.reconciled, this.observedWorking, this.reconciliationPendingSince]) state.delete(scope);
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
    if (this.dispatching.has(scope) || this.phases.has(scope) || this.restartLocks.has(scope) || this.conversationResets.get(scope)?.state === 'pending') return;
    this.dispatching.add(scope);
    try {
      const prompt = await this.queued?.next(scope);
      // consume only after the adapter confirms submission
      if (prompt !== undefined) {
        const submitted = await this.send(agentId, prompt.text, prompt.attachments ?? [], undefined, 'queue', true, resetAt, prompt.id);
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

  // send one prompt to a stable pane. `resetAt`, when set, anchors the completion
  // baseline on the conversation the pane was just reset into (see `submit`).
  private async send(agentId: string, prompt: string, attachments: PromptAttachment[], discovered?: DiscoveredTarget, submission: 'queue' | 'enter' | 'confirmed-enter' = 'queue', durable = false, resetAt?: number, queuedPromptId?: string): Promise<boolean> {
    const original = discovered ?? await this.discovery.target(agentId);
    // require one live agent before staging or pasting
    if (!original) return false;
    const processId = this.discovery.agentProcessId?.(agentId);
    const first: DiscoveredTarget = { ...original, ...(processId === undefined ? {} : { processId }) };
    // the Adapter describes the paste text and the submit keys; the console pastes and sends them
    const adapter = this.resolveAdapter(first.agent.kind);
    if (adapter === undefined) return false;
    const capability = adapter.newConversation;
    const reset = attachments.length === 0 && capability !== undefined
      && (prompt.trim() === capability.command || capability.aliases?.includes(prompt.trim()) === true);
    // reset commands have no model answer, even when startup briefly looks busy
    const instant = reset || (adapter.submission.completesWithoutWork?.(prompt) ?? false);
    const scope = promptScope(agentId);
    // codex can read shared files outside an unmounted scratch home
    const sharedStaging = attachments.length > 0 && codexFamily(first.agent.kind) && configuredWorktreeForWorkspace(this.discovery.worktreesNow(), first.agent.home) === undefined ? this.attachmentStaging : undefined;
    const hostWorkspace = sharedStaging?.hostWorkspace;
    // never paste a container-only path when the host mapping is unavailable
    if (sharedStaging !== undefined && (hostWorkspace === undefined || !isAbsolute(hostWorkspace))) return false;
    const workspace = sharedStaging?.workspace ?? this.workspaceFor(first.agent.home);
    const staged = await this.stageAttachments(workspace, attachments);
    if (staged === undefined) return false;
    // name shared files in the agent's namespace while retaining local cleanup paths
    const references = staged.map(path => `@${hostWorkspace === undefined ? path : join(hostWorkspace, path)}`);
    const attachmentPrompt = staged.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${references.join('\n')}`;
    const shellMode = attachments.length === 0 && prompt.startsWith('!');
    const mode: SubmissionMode = shellMode ? 'shell' : 'prompt';
    const composed = adapter.submission.prepare(attachmentPrompt, mode);
    const observeDraft = adapter.submission.observeDraft;
    // adapters without draft observation retain best-effort tmux delivery
    const settle = durable && submission === 'queue' && observeDraft !== undefined && typeof this.tmux.capture === 'function' && this.queued !== undefined;
    // retain cleanup coordinates through every post-paste failure
    const failedDraft = settle ? { agentId, target: first, prompt: composed.text, submission: adapter.submission } : undefined;
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    // keep the server-owned prompt out of the startup shell
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorReady(agentId, first)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    const pasteTarget = await this.submissionTarget(agentId, first).catch(() => undefined);
    // attachment staging and startup waits must not paste into a replacement process
    if (pasteTarget === undefined || agentAttentionState(pasteTarget.agent) === 'question') {
      await this.removeStaged(workspace, staged);
      return false;
    }
    // a rejected paste does not establish ownership of pre-existing native text
    if (!await this.tmux.pastePrompt(pasteTarget.socket, pasteTarget.agent.paneId, buffer, composed.text)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    const second = await this.submissionTarget(agentId, first).catch(() => undefined);
    // never adopt a new process after the paste
    if (!second) {
      // hold durable ownership through a failed post-paste discovery scan
      if (settle) await this.holdFailedSubmission(scope, failedDraft);
      await this.removeStaged(workspace, staged);
      return false;
    }
    // wait until the fresh advisor composer rendered the complete paste
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorComposer(agentId, second, attachmentPrompt)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    // hold the scope so a quick second submit queues behind this one, then let the
    // Adapter-owned composer observation settle before the submit key
    if (settle) {
      this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(queuedPromptId === undefined ? {} : { requestId: queuedPromptId }), historyPrompt: attachmentPrompt });
      // retain durable work instead of submitting an unrendered draft
      if (!await this.waitForComposerRender(agentId, second, composed.text, observeDraft)) {
        await this.clearFailedDraft(agentId, second, composed.text, adapter.submission);
        await this.holdFailedSubmission(scope, failedDraft);
        return false;
      }
    }
    // snapshot the rollout baseline before the turn starts: completion is then a
    // `task_complete` recorded past it (the native-Codex TUI renders no boundary,
    // so scraping the pane never observes the finish)
    const previousReset = this.conversationResets.get(scope);
    const matchingReset = previousReset?.agentId === agentId ? previousReset : undefined;
    const baselineResetAt = resetAt ?? (matchingReset?.external ? undefined : matchingReset?.at);
    const rolloutBaseline = this.queued === undefined && queuedPromptId === undefined || instant ? undefined : await this.captureRolloutBaseline(agentId, adapter, baselineResetAt, matchingReset?.external);
    // retain Calendar's pre-intent instant separately from transport and reset deadlines
    const calendarSentAt = new Date().toISOString();
    // persist exact pre-key intent before the tracked submit path proceeds
    const calendarIntent: { arm?: string } | undefined = queuedPromptId === undefined || this.calendar === undefined ? undefined : await this.calendar.beforeSend({
      id: queuedPromptId,
      agentId,
      kind: first.agent.kind,
      submittedAt: calendarSentAt,
      prompt: attachmentPrompt,
      ...(rolloutBaseline === undefined ? {} : { baseline: rolloutBaseline }),
      socketFingerprint: second.socket.fingerprint,
      socketPath: second.socket.path,
      paneId: second.agent.paneId,
      ...(first.processId === undefined ? {} : { processId: first.processId }),
      sentAt: calendarSentAt
    }).catch(() => ({}));
    // invalidate only this intent and retain durable ownership when the final proof fails
    const abortBeforeKeys = async (): Promise<false> => {
      // a rejected target cannot leave an admitted interval eligible for later delivery
      if (queuedPromptId !== undefined) await this.calendar?.invalid(queuedPromptId, 'missing_lifecycle_evidence').catch(() => undefined);
      await this.holdFailedSubmission(scope, failedDraft);
      return false;
    };
    // refresh after every settle/baseline delay so key selection reflects send-time state
    let submitTarget = await this.submissionTarget(agentId, second).catch(() => undefined);
    // never submit through a replacement pane or native question
    if (!submitTarget || agentAttentionState(submitTarget.agent) === 'question') {
      return abortBeforeKeys();
    }
    // preserve operator edits made while the initial baseline was being read
    if (settle) {
      const captured = await this.tmux.capture(submitTarget.socket, submitTarget.agent.paneId).catch(() => undefined);
      // first-paste delivery permits an exact collapsed label but never known edits
      if (captured === undefined || observeDraft(captured, composed.text) !== 'visible' || adapter.submission.ownsDraft?.(captured, composed.text) === false) {
        return abortBeforeKeys();
      }
      submitTarget = await this.submissionTarget(agentId, second).catch(() => undefined);
      // captures may outlive the original native process or reveal a new question
      if (!submitTarget || agentAttentionState(submitTarget.agent) === 'question') {
        return abortBeforeKeys();
      }
      const latestCapture = await this.tmux.capture(submitTarget.socket, submitTarget.agent.paneId).catch(() => undefined);
      // lifecycle scans can outlast the draft and must not authorize stale input
      if (latestCapture === undefined || observeDraft(latestCapture, composed.text) !== 'visible' || adapter.submission.ownsDraft?.(latestCapture, composed.text) === false || !this.submissionProcessCurrent(agentId, second) || agentAttentionState(submitTarget.agent) === 'question') {
        return abortBeforeKeys();
      }
    }
    // use direct submit only while the final target is idle
    const adapterKeys = agentAttentionState(submitTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
    // the update advisor is submitted with Enter regardless of the Adapter's keys
    const keys: TmuxKey[] = submission === 'enter' || submission === 'confirmed-enter' ? ['Enter'] : adapterKeys;
    const submittedAt = Date.now();
    const resetBefore = paneSnapshot(submitTarget.agent);
    // arm and submit Claude in one ordered tmux batch after exact draft ownership
    const submittedWithArm = calendarIntent?.arm === undefined ? undefined : await this.tmux.armAndSendKeys(submitTarget.socket, submitTarget.agent.paneId, calendarIntent.arm, keys).catch(() => false);
    let submitted = submittedWithArm ?? await this.tmux.sendKeys(submitTarget.socket, submitTarget.agent.paneId, keys).catch(() => false);
    // allow reset redraws their startup budget without weakening prompt acknowledgement
    const acceptUntil = reset ? submittedAt + conversationResetGraceMs : Date.now() + submissionAcceptGraceMs;
    // inspect ambiguous transport failures too before abandoning a pasted draft
    if (settle) submitted = await this.waitForSubmissionAccepted(agentId, submitTarget, composed, adapter.submission, adapter.completion, rolloutBaseline, attachmentPrompt, acceptUntil);
    // confirm the server-owned prompt left the composer
    if (submitted && submission === 'confirmed-enter') submitted = await this.waitForUpdateAdvisorStart(agentId, submitTarget, attachmentPrompt);
    // clear stale prose questions after delivery
    if (submitted) this.discovery.invalidateMessageQuestion?.(agentId);
    if (!submitted) {
      if (queuedPromptId !== undefined) await this.calendar?.invalid(queuedPromptId, 'missing_lifecycle_evidence').catch(() => undefined);
      // halt only when a durable prompt is still waiting
      await this.holdFailedSubmission(scope, failedDraft);
    } else if (instant) {
      this.markTrackedRequestSubmitted(queuedPromptId);
      this.settleTrackedRequest(queuedPromptId, 'complete');
      // release the provisional render phase instead of waiting for a nonexistent answer
      this.phases.delete(scope);
      // hold follow-ups through startup and anchor their completion on the new thread
      if (reset && this.queued !== undefined) {
        await this.rememberConversationReset(scope, { agentId, at: submittedAt, before: resetBefore, ...(queuedPromptId === undefined ? {} : { resetPromptId: queuedPromptId }) }, 'pending');
      }
    } else {
      this.markTrackedRequestSubmitted(queuedPromptId);
      // consume the durable boundary only once a real post-reset prompt is accepted
      if (matchingReset !== undefined) await this.queued?.resets.clear(scope, matchingReset.id);
      this.conversationResets.delete(scope);
      // track real prompts and their answers rather than reset commands
      const entry = await this.history?.record(scope, attachmentPrompt).catch(() => undefined);
      // monitor managed prompt completion
      if (this.queued !== undefined || queuedPromptId !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(queuedPromptId === undefined ? {} : { requestId: queuedPromptId }), historyPrompt: attachmentPrompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }), ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }) });
    }
    return submitted;
  }

  // recover a reset even when its command was consumed before the server restarted
  private async restoreConversationReset(scope: string, agentId: string): Promise<void> {
    // deployments without durable queues have no boundary to restore
    if (this.queued === undefined) return;
    let restoration = this.restoredResets.get(scope);
    // share one in-flight read so an observer cannot reinstall a consumed boundary
    if (restoration === undefined) {
      restoration = this.queued.resets.get(scope).then(async boundary => {
        // missing boundaries leave normal completion recovery unchanged
        if (boundary === undefined) return;
        // close the crash window between durable reset acknowledgement and queue removal
        if (boundary.resetPromptId !== undefined) await this.queued!.remove(scope, boundary.resetPromptId);
        this.conversationResets.set(scope, { ...boundary, observed: [], state: 'pending' });
        this.reconciled.add(scope);
      }).catch(error => {
        this.restoredResets.delete(scope);
        throw error;
      });
      this.restoredResets.set(scope, restoration);
    }
    await restoration;
    const reset = this.conversationResets.get(scope);
    // distinguish a live sibling from a genuinely removed reset owner
    if (reset !== undefined && reset.agentId !== agentId && await this.discovery.target(reset.agentId, true) === undefined) {
      await this.queued.resets.clear(scope, reset.id);
      // preserve any replacement recorded during the fresh discovery read
      if (this.conversationResets.get(scope) === reset) this.conversationResets.delete(scope);
    }
  }

  // persist before the reset command leaves the queue, including an empty follow-up queue
  private async rememberConversationReset(scope: string, boundary: Omit<ResetBoundary, 'id'>, state: 'pending' | 'ready'): Promise<void> {
    const durable = { ...boundary, id: randomBytes(18).toString('base64url') };
    await this.queued?.resets.set(scope, durable);
    this.conversationResets.set(scope, { ...durable, observed: [], state });
    this.reconciled.add(scope);
    this.observedWorking.delete(scope);
    this.reconciliationPendingSince.delete(scope);
  }

  // retain queued work until the reset settles into a genuinely ready empty composer
  private async settleConversationReset(agentId: string, scope: string, adapter: AdapterView | undefined): Promise<boolean> {
    const reset = this.conversationResets.get(scope);
    // normal turns and already settled resets need no additional terminal reads
    if (reset === undefined || reset.state !== 'pending') return true;
    const capability = adapter?.newConversation;
    const target = reset.agentId === agentId ? await this.discovery.target(agentId, true) : undefined;
    let lost = false;
    // never release a reset into a different pane or unsupported adapter
    if (target !== undefined && capability !== undefined) {
      const snapshot = paneSnapshot(target.agent);
      reset.observed.push(snapshot);
      // bound reset diagnostics even if a dialog remains open indefinitely
      if (reset.observed.length > 20) reset.observed.shift();
      // an external boundary was already settled when recorded; only readiness needs rechecking
      const settling = reset.external ? 'settled' : capability.settled(reset.before, reset.observed, Date.now() - reset.at);
      lost = settling === 'lost';
      // a visible composer during startup is not permission to submit
      if (settling === 'settled' && snapshot.attention === 'finished') {
        const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
        // wait through loading, drafts, and dialogs without pasting into them
        if (capture !== undefined && capability.ready(snapshot, capture).state === 'ready' && capability.composerEmpty(capture)) {
          // another observer may already have advanced to a newer reset
          if (this.conversationResets.get(scope) !== reset) return false;
          reset.state = 'ready';
          return true;
        }
      }
    }
    // leave genuinely lost or blocked resets recoverable through the existing notes path
    if ((lost || Date.now() - reset.at >= conversationResetGraceMs) && this.conversationResets.get(scope) === reset) {
      // retain the first-turn anchor while releasing the failed readiness reservation
      reset.state = 'expired';
      await this.holdFailedSubmission(scope);
    }
    return false;
  }

  // wait (briefly) for a pasted interactive prompt to render on the validated pane,
  // so the submit key is not swallowed by a composer that has not yet caught up
  private async waitForComposerRender(agentId: string, target: DiscoveredTarget, prompt: string, observeDraft: (capture: string, prompt: string) => SubmissionDraftState): Promise<boolean> {
    let renderedSince: number | undefined;
    const renderUntil = Date.now() + composerRenderAttempts * composerRenderPollMs;
    // poll within the bounded render window
    for (let attempt = 0; attempt < composerRenderAttempts && Date.now() < renderUntil; attempt += 1) {
      const current = await this.submissionTarget(agentId, target, false).catch(() => undefined);
      // never render-gate a replacement pane or native question
      if (current === undefined || agentAttentionState(current.agent) === 'question') return false;
      const captured = await this.tmux.capture(current.socket, current.agent.paneId).catch(() => undefined);
      const rendered = captured !== undefined && observeDraft(captured, prompt) === 'visible';
      // retain only uninterrupted live-composer rendering
      if (!rendered) renderedSince = undefined;
      else if (renderedSince === undefined) renderedSince = Date.now();
      else if (Date.now() - renderedSince >= composerRenderStableMs) return true;
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    return false;
  }

  // acknowledge a cleared composer or fresh exact structured receipt
  private async waitForSubmissionAccepted(agentId: string, target: DiscoveredTarget, composed: Submission, submission: Adapter['submission'], completion: Adapter['completion'] | undefined, baseline: CompletionBaseline | undefined, receiptPrompt: string, acceptUntil: number): Promise<boolean> {
    const acceptAttempts = Math.ceil((acceptUntil - Date.now()) / composerRenderPollMs);
    let draft: SubmissionDraftState | undefined;
    // poll within the acceptance deadline and retry only visible server-owned drafts
    for (let attempt = 0; attempt < acceptAttempts && Date.now() < acceptUntil; attempt += 1) {
      const current = await this.submissionTarget(agentId, target, false).catch(() => undefined);
      // read the original pane without writing when discovery temporarily loses it
      const observed = current ?? target;
      const captured = await this.tmux.capture(observed.socket, observed.agent.paneId).catch(() => undefined);
      draft = captured === undefined ? undefined : submission.observeDraft!(captured, composed.text);
      // bound rollout reads while checking before retries and final recovery
      const checkReceipt = draft === 'cleared' || attempt === 0 || submissionRetryAttempts.has(attempt) || attempt === acceptAttempts - 1;
      // preserve original whitespace when checking hidden or stale composer frames
      if (checkReceipt && baseline !== undefined && completion?.accepted !== undefined && await completion.accepted(baseline, receiptPrompt).catch(() => false)) return true;
      // revalidate the native process before trusting an empty composer
      if (draft === 'cleared') return await this.submissionTarget(agentId, target).catch(() => undefined) !== undefined || target.processId === undefined && current === undefined;
      // lost targets and native questions never authorize additional keys
      if (current === undefined || agentAttentionState(current.agent) === 'question') return false;
      // let an in-flight snapshot finish without extending recovery
      if (Date.now() >= acceptUntil) break;
      // recover submit keys swallowed while the previous turn finishes
      if (submissionRetryAttempts.has(attempt) && draft === 'visible' && captured !== undefined && submission.ownsDraft?.(captured, composed.text) === true) {
        const retryTarget = await this.submissionTarget(agentId, target).catch(() => undefined);
        // revalidate before every side effect
        if (retryTarget === undefined || agentAttentionState(retryTarget.agent) === 'question') return false;
        // a slow identity scan cannot extend the retry deadline
        if (Date.now() >= acceptUntil) break;
        const latestCapture = await this.tmux.capture(retryTarget.socket, retryTarget.agent.paneId).catch(() => undefined);
        // terminal captures also consume the bounded acceptance window
        if (Date.now() >= acceptUntil) break;
        // preserve any replacement or question observed during capture
        if (!this.submissionProcessCurrent(agentId, target) || agentAttentionState(retryTarget.agent) === 'question') return false;
        const latestDraft = latestCapture === undefined ? 'unknown' : submission.observeDraft!(latestCapture, composed.text);
        // native acceptance during discovery needs no second submit key
        if (latestDraft === 'cleared') return true;
        // require fresh content proof after the potentially slow identity read
        if (latestCapture === undefined || latestDraft !== 'visible' || submission.ownsDraft?.(latestCapture, composed.text) !== true || !this.submissionProcessCurrent(agentId, target)) continue;
        const keys = agentAttentionState(retryTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
        // inspect again after transport failure rather than immediately giving up
        await this.tmux.sendKeys(retryTarget.socket, retryTarget.agent.paneId, keys).catch(() => false);
      }
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    // inspect the final redraw unless a slow capture already exceeded the deadline
    if (Date.now() <= acceptUntil + composerRenderPollMs) {
      const current = await this.submissionTarget(agentId, target).catch(() => undefined);
      // never recover through a replacement pane
      if (current === undefined) return false;
      const captured = await this.tmux.capture(current.socket, current.agent.paneId).catch(() => undefined);
      draft = captured === undefined ? undefined : submission.observeDraft!(captured, composed.text);
      // a last-moment native acceptance must not become an undelivered note
      if (draft === 'cleared') return this.submissionProcessCurrent(agentId, target);
    }
    // trust a late structured receipt before clearing a stale composer frame
    if (baseline !== undefined && completion?.accepted !== undefined && await completion.accepted(baseline, receiptPrompt).catch(() => false)) return true;
    // hidden frames cannot authorize clearing and need no extra terminal reads
    if (draft === 'visible') await this.clearFailedDraft(agentId, target, composed.text, submission);
    return false;
  }

  // retain the original pane identity through recovery
  private async submissionTarget(agentId: string, expected: DiscoveredTarget, force = true): Promise<DiscoveredTarget | undefined> {
    const current = await this.discovery.target(agentId, force);
    // reject replaced sockets, panes, and agent kinds
    return current !== undefined && current.socket.fingerprint === expected.socket.fingerprint
      && current.agent.paneId === expected.agent.paneId && current.agent.kind === expected.agent.kind
      && this.submissionProcessCurrent(agentId, expected)
      ? { ...current, ...(expected.processId === undefined ? {} : { processId: expected.processId }) } : undefined;
  }

  // reject observed process changes without another slow scan after inspecting input
  private submissionProcessCurrent(agentId: string, expected: DiscoveredTarget): boolean {
    return expected.processId === undefined || this.discovery.agentProcessId?.(agentId) === expected.processId;
  }

  // remove only an observed server-owned draft without interrupting native work
  private async clearFailedDraft(agentId: string, expected: DiscoveredTarget, prompt: string, submission: Adapter['submission']): Promise<boolean> {
    // adapters must explicitly describe safe clearing
    if (submission.clearDraft === undefined || submission.observeDraft === undefined) return true;
    // retry one swallowed clear only after observing the same live draft again
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.submissionTarget(agentId, expected).catch(() => null);
      // transient discovery errors cannot prove that the draft disappeared
      if (current === null) return false;
      // preserve native questions and replacement panes
      if (current === undefined) {
        const snapshots = this.tmux.paneSnapshotsNow?.();
        const processId = this.discovery.agentProcessId?.(agentId);
        // a recognized replacement cannot retain the old native draft's ownership
        if (expected.processId !== undefined && processId !== undefined && processId !== expected.processId) return true;
        // legacy transports without inventory observations keep their existing absence contract
        if (snapshots === undefined) return true;
        const listing = snapshots.get(expected.socket.path);
        // only a complete listing that omits the exact pane proves removal
        return listing?.status === 'available' && !listing.panes.some(pane => pane.paneId === expected.agent.paneId && pane.dead !== true);
      }
      // an unanswered native question cannot authorize cleanup
      if (agentAttentionState(current.agent) === 'question') return false;
      const captured = await this.tmux.capture(current.socket, current.agent.paneId).catch(() => undefined);
      // matching scrollback or an unknown composer cannot authorize deletion
      if (captured === undefined) return false;
      const draft = submission.observeDraft(captured, prompt);
      // transient redraws keep cleanup pending rather than pretending it completed
      if (draft === 'unknown') return false;
      // a cleared composer needs no ownership proof or additional keys
      if (draft === 'cleared') return true;
      const owned = submission.ownsDraft?.(captured, prompt);
      // hidden paste contents and missing ownership observers keep cleanup pending
      if (owned === undefined) return false;
      // preserve operator-modified drafts without deleting their text
      if (!owned) return true;
      const clearTarget = await this.submissionTarget(agentId, expected).catch(() => undefined);
      // revalidate after capture before injecting a destructive key
      if (clearTarget === undefined || agentAttentionState(clearTarget.agent) === 'question') return false;
      const latestCapture = await this.tmux.capture(clearTarget.socket, clearTarget.agent.paneId).catch(() => undefined);
      // do not clear stale input after a slow lifecycle scan
      if (latestCapture === undefined) return false;
      const latestDraft = submission.observeDraft(latestCapture, prompt);
      // native acceptance or manual clearing needs no destructive key
      if (latestDraft === 'cleared') return true;
      const latestOwned = submission.ownsDraft?.(latestCapture, prompt);
      // keep hidden input pending until its ownership becomes provable
      if (latestDraft !== 'visible' || latestOwned === undefined) return false;
      // leave an operator edit untouched even if it arrived during discovery
      if (!latestOwned) return true;
      // account for identity or question changes observed during the final capture
      if (!this.submissionProcessCurrent(agentId, expected) || agentAttentionState(clearTarget.agent) === 'question') return false;
      await this.tmux.sendKeys(clearTarget.socket, clearTarget.agent.paneId, submission.clearDraft).catch(() => false);
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    // verify the native redraw even after the final clearing attempt
    const captured = await this.tmux.capture(expected.socket, expected.agent.paneId).catch(() => undefined);
    return captured !== undefined && submission.observeDraft(captured, prompt) === 'cleared';
  }

  // keep failed queues pending while their observed native draft cannot be cleared
  private async clearHaltedDraft(phase: PromptPhase): Promise<boolean> {
    const draft = phase.failedDraft;
    return draft === undefined || await this.clearFailedDraft(draft.agentId, draft.target, draft.prompt, draft.submission);
  }

  // halt redispatch only while durable queue state remains
  private async holdFailedSubmission(scope: string, failedDraft?: FailedDraft): Promise<void> {
    const waiting = await this.queued?.list(scope);
    const requestId = this.phases.get(scope)?.requestId;
    // protect queued prompts from duplicate repaste
    if ((waiting?.length ?? 0) > 0) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), ...(failedDraft === undefined ? {} : { failedDraft }) });
    else this.phases.delete(scope);
  }

  // wait for one stable empty Codex composer before pasting
  private async waitForUpdateAdvisorReady(agentId: string, expected: DiscoveredTarget): Promise<boolean> {
    let readySince: number | undefined;
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      const plain = captured?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
      const ready = agentAttentionState(target.agent) === 'finished' && plain !== undefined && /(?:^|\n)›(?:\s|$)/u.test(plain);
      // retain only uninterrupted readiness
      if (!ready) readySince = undefined;
      else if (readySince === undefined) readySince = Date.now();
      else if (Date.now() - readySince >= updateAdvisorReadyStableMs) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // wait for one pasted advisor prompt to reach Codex
  private async waitForUpdateAdvisorComposer(agentId: string, expected: DiscoveredTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // match the visible tail because Codex scrolls long composers to the cursor
    const visibleSuffix = normalized.slice(-Math.min(96, normalized.length));
    // match Codex's exact long-paste placeholder
    const collapsedPaste = codexCollapsedPasteLabel(queueReadyPrompt(prompt));
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      // submit only after the pasted prompt begins rendering
      const composer = captured === undefined ? '' : normalizedTerminalText(captured);
      if (composer.includes(visibleSuffix) || composer.includes(collapsedPaste)) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // confirm one advisor prompt actually started
  private async waitForUpdateAdvisorStart(agentId: string, expected: DiscoveredTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // bound submission confirmation and retry dropped Enter keys
    for (let attempt = 0; attempt < updateAdvisorStartAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during submission
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      // accept working, questioning, or already completed prompts
      if (agentAttentionState(target.agent) !== 'finished') return true;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      if (normalizedPrompt(lastPromptFromHistory(captured ?? '') ?? '') === normalized) return true;
      // retry only after Codex had time to process the first key
      if ((attempt === 9 || attempt === 24) && !await this.tmux.sendKeys(target.socket, target.agent.paneId, ['Enter'])) return false;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // restore the latest matching unanswered entry
  private async reconcileLatestAnswer(agentId: string, scope: string): Promise<PromptReconciliation> {
    // require prompt history
    if (this.history === undefined || typeof this.history.list !== 'function') return 'settled';
    let entries: Awaited<ReturnType<PromptHistoryService['list']>>;
    // contain history read failures
    try { entries = await this.history.list(scope); }
    catch { entries = undefined; }
    // retry failed history reads
    if (entries === undefined) return 'pending';
    const unanswered = entries.filter(candidate => candidate.answer === undefined);
    // stop when no response needs recovery
    if (unanswered.length === 0) return 'settled';
    const target = await this.discovery.target(agentId);
    // require a stable pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    // require terminal history
    if (capture === undefined) return 'pending';
    const turn = latestCompletedAssistantTurn(capture);
    // require a completed turn
    if (turn === undefined) return 'pending';
    const newest = entries[0];
    let entry: (typeof entries)[number] | undefined;
    // recover only observed work when its prompt text scrolled away
    if (turn.prompt === undefined) {
      entry = this.observedWorking.has(scope) && newest?.answer === undefined && !entries.some(candidate => candidate.answer === turn.text) ? newest : undefined;
    } else {
      const capturedPrompt = turn.prompt;
      entry = unanswered.find(candidate => normalizedPrompt(candidate.text) === normalizedPrompt(capturedPrompt));
    }
    // require an unanswered match
    if (entry === undefined) return 'settled';
    const recorded = await this.history.recordAnswer(scope, entry.id, turn.text).catch(() => undefined);
    return recorded === undefined ? 'pending' : 'recorded';
  }

  // retry restart recovery through the shared render grace window
  private async reconciliationComplete(agentId: string, scope: string): Promise<boolean> {
    const result = await this.reconcileLatestAnswer(agentId, scope);
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

  // find one durable prompt whose answer tracking may have restarted
  private async latestUnanswered(scope: string) {
    // skip deployments without prompt history
    if (this.history === undefined || typeof this.history.list !== 'function') return undefined;
    const entries = await this.history.list(scope);
    const latest = entries?.[0];
    // never attach new work to older unanswered history
    return latest?.answer === undefined ? latest : undefined;
  }

  // capture and persist the final answer
  private async recordAnswer(agentId: string, scope: string, entryId: string | undefined, prompt: string | undefined, baselineCompletion: string | undefined, allowPromptless = false, rolloutBaseline?: CompletionBaseline): Promise<PromptCompletion> {
    // rollout-based completion (native Codex; OMX when its rollout resolves): the
    // structured `task_complete`/`turn_aborted` events are authoritative and, unlike
    // the TUI parse, need no `─ Worked for` footer — which the native build never
    // renders. When the rollout resolves it stays authoritative; only an unresolvable
    // rollout falls through to the TUI parse below.
    if (rolloutBaseline !== undefined) {
      const event = await this.rolloutCompletion(agentId, rolloutBaseline);
      if (event?.kind === 'aborted') return 'failed';
      if (event?.kind === 'completed') return await this.persistAnswer(scope, entryId, event.answer);
      if (event?.kind === 'pending') return 'pending';
    }
    const target = await this.discovery.target(agentId);
    // require the original pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    // require a completed response
    if (capture === undefined) return 'pending';
    // fail explicit terminal errors without waiting through the grace window
    if (failedTurnFromCapture(capture)) return 'failed';
    // wait for the latest completed response
    const turn = latestCompletedAssistantTurn(capture);
    if (turn === undefined) return 'pending';
    const completion = this.completionSignatureFromCapture(capture);
    const promptMatches = prompt === undefined
      || turn.prompt !== undefined && normalizedPrompt(turn.prompt) === normalizedPrompt(prompt)
      || allowPromptless && turn.prompt === undefined && completion !== baselineCompletion;
    // reject stale pane completions
    if (!promptMatches) return 'pending';
    // reject completions that predate externally tracked work
    if (prompt === undefined && completion === baselineCompletion) return 'pending';
    return await this.persistAnswer(scope, entryId, turn.text);
  }

  // persist one captured answer to history, retrying transient or missing-entry writes
  private async persistAnswer(scope: string, entryId: string | undefined, answer: string): Promise<PromptCompletion> {
    if (this.history === undefined || entryId === undefined) return 'completed';
    const stored = await this.history.recordAnswer(scope, entryId, answer).catch(() => undefined);
    return stored === undefined ? 'pending' : 'completed';
  }

  // the OS pid backing one discovered pane, when the discovery service exposes it
  private paneProcessId(agentId: string): number | undefined {
    return typeof this.discovery.paneProcessId === 'function' ? this.discovery.paneProcessId(agentId) : undefined;
  }

  // the raw reported Inline question payload one pane carries, when discovery exposes it
  private reportedQuestionPayload(agentId: string): string | undefined {
    return typeof this.discovery.reportedQuestionPayload === 'function' ? this.discovery.reportedQuestionPayload(agentId) : undefined;
  }

  // the pane's unique working directory, when the discovery service exposes it: the
  // Adapter's privilege-free fallback for a sandboxed pane whose descriptors a
  // confined service cannot readlink
  private paneWorkingDirectory(agentId: string): string | undefined {
    return typeof this.discovery.paneWorkingDirectory === 'function' ? this.discovery.paneWorkingDirectory(agentId) : undefined;
  }

  // snapshot the rollout completion baseline before a turn starts, when the Adapter
  // reads completion from its event log and the pane's pid is known. The pid drives
  // the exact fd-walk; the working directory is the fallback when it is blocked.
  // `resetAt` defers the baseline to the conversation the pane was just reset into.
  // untracked resets follow the pane's first replacement without guessing its timestamp
  private async captureRolloutBaseline(agentId: string, adapter: AdapterView | undefined, resetAt?: number, followReset?: boolean): Promise<CompletionBaseline | undefined> {
    if (adapter?.completion === undefined) return undefined;
    const pid = this.paneProcessId(agentId);
    if (pid === undefined) return undefined;
    const cwd = this.paneWorkingDirectory(agentId);
    return await adapter.completion.baseline({ pid, ...(cwd === undefined ? {} : { cwd }) }, resetAt, followReset).catch(() => undefined);
  }

  // the newest terminal turn past the snapshotted baseline from the Adapter's event
  // log, or undefined when the Adapter has no such capability
  private async rolloutCompletion(agentId: string, baseline: CompletionBaseline): Promise<CompletionEvent | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const adapter = this.resolveAdapter(target.agent.kind);
    if (adapter?.completion === undefined) return undefined;
    return await adapter.completion.since(baseline).catch(() => undefined);
  }

  // capture the latest completed turn identity
  private async completionSignature(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    if (capture === undefined) return undefined;
    const completion = this.completionSignatureFromCapture(capture);
    if (completion !== undefined) return completion;
    // retain the completion hidden by current in-progress output
    const currentPrompt = capture.lastIndexOf('\n› ');
    return currentPrompt < 0 ? undefined : this.completionSignatureFromCapture(capture.slice(0, currentPrompt));
  }

  // identify a completion without retaining pane output
  private completionSignatureFromCapture(capture: string): string | undefined {
    const turn = latestCompletedAssistantTurn(capture);
    return turn === undefined ? undefined : `${turn.prompt ?? ''}\0${turn.text}`;
  }

  private workspaceFor(workspace: string): string {
    return configuredWorktreeForWorkspace(this.discovery.worktreesNow(), workspace)?.identity ?? workspace;
  }

  // the Worktree-scoped key (queued prompts, history): the Worktree wire id
  // `<projectId>:<realpath>`, or an `agent:<id>` scope for a Scratch, advisor or Review run pane
  // keep staged attachments outside Git status
  private async ensureAttachmentRootIgnored(workspace: string, relativeRoot: string): Promise<boolean> {
    const ignored = await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot]);
    // retain repository ignore rules
    if (ignored.code === 0) return true;
    // allow workspaces without Git metadata
    if (/not a git repository/u.test(ignored.stderr)) return true;
    const resolved = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude']);
    // require a repository-local exclude file
    if (resolved.code !== 0 || resolved.stdout.trim() === '') return false;
    const excludePath = resolved.stdout.trim();
    const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : join(workspace, excludePath);
    const existing = await readFile(absoluteExcludePath, 'utf8').catch(() => '');
    // add the narrow staging rule once
    if (!existing.split(/\r?\n/u).includes(attachmentIgnoreRule)) {
      await mkdir(dirname(absoluteExcludePath), { recursive: true });
      await appendFile(absoluteExcludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${attachmentIgnoreRule}\n`, { mode: 0o600 });
    }
    return (await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot])).code === 0;
  }

  // validate and stage batches without unbounded filesystem concurrency
  private async stageAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
    // skip empty attachment sets
    if (attachments.length === 0) return [];
    const files: Array<{ name: string; data: Buffer }> = [];
    const names = new Set<string>();
    let total = 0;
    // validate attachment payloads
    for (const attachment of attachments) {
      const name = promptAttachmentName(attachment.name);
      const data = promptAttachmentData(attachment.data);
      // reject unsafe or duplicate files
      if (!name || !data || names.has(name)) return undefined;
      names.add(name);
      total += data.length;
      // enforce the request limit
      if (total > maxPromptAttachmentBytes) return undefined;
      files.push({ name, data });
    }
    // stage beneath a dependency path
    const relativeRoot = `node_modules/.remote-agent-console/attachments/${randomBytes(12).toString('base64url')}`;
    // configure a local fallback for repositories without dependency ignores
    if (!await this.ensureAttachmentRootIgnored(workspace, relativeRoot)) return undefined;
    const root = join(workspace, relativeRoot);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      // bound file-descriptor use independently of batch size
      for (const file of files) await writeFile(join(root, file.name), file.data, { mode: 0o600 });
      // retain the original attachment order
      return files.map(file => `${relativeRoot}/${file.name}`);
    } catch {
      // remove every partial file before retaining the queued batch
      await rm(root, { recursive: true, force: true });
      return undefined;
    }
  }

  private async removeStaged(workspace: string, paths: string[]): Promise<void> {
    const relativeRoot = paths[0]?.split('/').slice(0, -1).join('/');
    if (relativeRoot) await rm(join(workspace, relativeRoot), { recursive: true, force: true });
  }


  // reveal a collapsed native question without choosing or submitting an answer
  async openQueuedQuestion(agentId: string, observedCapture: string, mayOpen: () => boolean): Promise<boolean> {
    const first = await this.discovery.target(agentId);
    const queued = first === undefined ? undefined : this.resolveAdapter(first.agent.kind)?.questions?.queued;
    // unsupported adapters never receive automatic keystrokes
    if (first === undefined || queued === undefined) return false;
    const question = queued(observedCapture);
    // rearm after completion, not when the operator merely collapses the editor
    if (question === undefined) {
      this.openedQueuedQuestions.delete(agentId);
      return false;
    }
    const key = question.key;
    // leave an expanded editor untouched
    if (key === undefined) return false;
    // coalesce viewers and avoid racing a newly started manual operation
    if (this.openedQueuedQuestions.has(agentId) || !mayOpen() || (this.activeMutations.get(agentId) ?? 0) > 0) return false;
    const release = this.beginAgentMutation(agentId);
    // respect a restart reservation acquired during discovery
    if (release === undefined) return false;
    const version = this.mutationVersion(agentId);
    try {
      const capture = await this.tmux.capture(first.socket, first.agent.paneId).catch(() => undefined);
      // never act on a footer that changed since the pane derive
      if (capture === undefined || queued(capture)?.key !== key) return false;
      const second = await this.discovery.target(agentId);
      // require the same live target, viewer lease, and untouched input generation
      if (second === undefined || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId
        || second.agent.kind !== first.agent.kind || !mayOpen() || this.mutationVersion(agentId) !== version) return false;
      const opened = await this.tmux.sendKeys(second.socket, second.agent.paneId, [key]);
      // suppress duplicate opening shortcuts until the native dialog changes the footer
      if (opened) this.openedQueuedQuestions.add(agentId);
      return opened;
    } finally {
      release();
    }
  }

  // answer the current question directly without queueing a new agent turn
  async answerQuestion(agentId: string, questionId: string, answer: number | string): Promise<boolean> {
    const textAnswer = typeof answer === 'string';
    // reject empty text, oversized input, and terminal control sequences
    if (questionId.length === 0 || (textAnswer
      ? !validPrompt(answer) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(answer)
      : !Number.isInteger(answer) || answer < 0 || answer > 15)) return false;
    // serialize question delivery with active input and restart handoffs
    if (this.activeMutations.has(agentId)) return false;
    const release = this.beginAgentMutation(agentId);
    // respect an existing lifecycle reservation
    if (release === undefined) return false;
    const version = this.mutationVersion(agentId);
    try {
      const first = await this.discovery.target(agentId);
      // require a live question-capable agent
      if (!first) return false;
      const adapter = this.resolveAdapter(first.agent.kind);
      if (adapter?.questions === undefined) return false;
      const workspace = this.workspaceFor(first.agent.home);
      let question = await adapter.questions.pending?.(workspace, first.agent.paneId);
      let capture: string | undefined;
      // re-derive reported questions from their current hook payload and pane
      if (question === undefined && adapter.questions.reported !== undefined) {
        const payload = this.reportedQuestionPayload(agentId);
        capture = payload === undefined ? undefined : await this.tmux.capture(first.socket, first.agent.paneId).catch(() => undefined);
        question = capture === undefined ? undefined : adapter.questions.reported(payload!, capture);
      }
      // re-derive native questions from the current terminal capture
      if (question === undefined && adapter.questions.parse !== undefined) {
        capture = await this.tmux.capture(first.socket, first.agent.paneId).catch(() => undefined);
        question = capture === undefined ? undefined : adapter.questions.parse(capture);
      }
      // refuse stale answers and out-of-range choices
      if (question === undefined || question.id !== questionId || (!textAnswer && answer >= question.choices.length)) return false;
      // only native queued-editor answers may release that editor's suppression
      const queuedQuestion = capture === undefined ? undefined : adapter.questions.queued?.(capture);
      const targetPane = question.targetPaneId ?? first.agent.paneId;
      // verify the target and manual-input generation before each delivery stage
      const stillCurrent = async () => {
        const current = await this.discovery.target(agentId);
        return current !== undefined && current.socket.fingerprint === first.socket.fingerprint
          && current.agent.paneId === first.agent.paneId && current.agent.kind === first.agent.kind
          && this.mutationVersion(agentId) === version;
      };
      // refuse replacement panes or intervening operator input
      if (!await stillCurrent()) return false;
      // preserve cursor-aware numbered selection
      if (!textAnswer) {
        const sent = await this.tmux.sendKeys(first.socket, targetPane, adapter.submission.selectOption(question.rows?.[answer] ?? answer, question.selectedIndex));
        // rearm the next follow-up without requiring an observed empty queue
        if (sent && queuedQuestion !== undefined && queuedQuestion.key === undefined) this.openedQueuedQuestions.delete(agentId);
        return sent;
      }
      const keys = capture === undefined ? undefined : adapter.questions.textEntry?.(question, capture);
      // unsupported menus must not receive a normal prompt or an implicit default
      if (keys === undefined) return false;
      // navigate without submitting a recommended option
      if (keys.length > 0 && !await this.tmux.sendKeys(first.socket, targetPane, keys)) return false;
      // recheck after navigation before inserting the answer
      if (!await stillCurrent()) return false;
      const buffer = `rac-${randomBytes(18).toString('base64url')}`;
      // bracketed paste keeps multiline answers and leading digits out of menu shortcuts
      if (!await this.tmux.pastePrompt(first.socket, targetPane, buffer, adapter.questions.textAnswer?.(answer) ?? answer)) return false;
      // never submit into a replacement pane after a slow paste
      if (!await stillCurrent()) return false;
      const sent = await this.tmux.sendKeys(first.socket, targetPane, ['Enter']);
      // text answers release the same follow-up suppression as numbered choices
      if (sent && queuedQuestion !== undefined && queuedQuestion.key === undefined) this.openedQueuedQuestions.delete(agentId);
      return sent;
    } finally { release(); }
  }

  // interrupt a working Agent; a stray interrupt on a finished pane is refused so
  // it can never send a chord that exits the agent or opens a Rewind dialog
  async cancel(agentId: string): Promise<CancelOutcome> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return 'unavailable';
    const adapter = this.resolveAdapter(target.agent.kind);
    if (adapter === undefined) return 'unavailable';
    // the interrupt is sent only while the Agent is working or a question is pending
    if (agentAttentionState(target.agent) === 'finished') return 'not-working';
    if (!await this.tmux.sendKeys(target.socket, target.agent.paneId, adapter.submission.interrupt)) return 'unavailable';
    // a reported-state Agent fires no Stop hook on an interrupt; write `finished`
    // ourselves so the pane does not keep looking busy (Codex's title already stops)
    if (reportsOwnState(adapter)) await this.tmux.setReportedAttention(target.socket, target.agent.paneId, 'finished').catch(() => false);
    // record the in-flight prompt as interrupted: hold its queue rather than releasing it
    const scope = promptScope(agentId);
    const phase = this.phases.get(scope);
    this.settleTrackedRequest(phase?.requestId, 'interrupted', 'prompt_interrupted');
    if (this.queued !== undefined) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(phase?.requestId === undefined ? {} : { requestId: phase.requestId }) });
    return 'ok';
  }
  // stop one Agent by killing its pane; a kind with a configured teardown command
  // then gets a best-effort post-stop cleanup in the stopped agent's home
  // (never on cleanup or new-task pane kills, which bypass this path)
  async close(agentId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    if (target === undefined || !await this.tmux.close(target.socket, target.agent.paneId)) return false;
    // closing the target makes every accepted tracked request terminal
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId === agentId && request.terminalAt === undefined) this.settleTrackedRequest(requestId, 'interrupted', 'agent_closed');
    }
    const teardown = this.teardownFor(target.agent.kind);
    if (teardown !== undefined) {
      const done = await this.tmux.runShell(target.socket, expandCommand(teardown, { identity: target.agent.home })).catch(() => false);
      // a failed teardown never blocks the stop; the setup command is the safety net.
      // the workspace is an agent-controlled path (its cwd), so JSON-encode it — a
      // directory name may hold newlines or control bytes that would forge log lines
      if (!done) console.error(`[prompts] adapters.${target.agent.kind} teardown failed in ${JSON.stringify(target.agent.home)}`);
    }
    return true;
  }
}
