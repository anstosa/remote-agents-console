import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { adapterFor } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
import type { PromptCalendarLifecycle } from '../google-calendar/lifecycle.js';
import type { Agent } from '../domain/models.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { agentAttentionState, type AgentAttentionState } from '../notifications.js';
import { promptScope, QueuedPromptService, senderOf, type PromptSender, type QueuedPrompt, type QueuedPromptOrigin, type QueuedPromptSummary, type StablePromptIdentity } from './queue.js';
import { PromptOperationLedger, type AgentActivitySnapshot, type PromptOperationIdentity, type PromptOperationRecord } from './operations.js';
import { validPrompt, type PromptAttachment } from './validation.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
import { answerCaptureGraceMs, reportsOwnState, TmuxTransport, type AdapterView, type AttachmentStagingWorkspace, type Delivery, type DeliveryOptions, type FailedDraft, type RecoveredAnswer, type SendIntent, type TmuxTurnEvent, type TurnMark, type TurnWatch } from '../transports/tmux.js';
import { structuredTurnMarkPrefix } from '../transports/structured-agents.js';
import type { PromptHistoryEntry } from '../prompt-history/service.js';
import type { AgentTransport, Gate, InterruptOutcome, QuestionAnswer } from '../transports/transport.js';
export { maxPromptAttachmentBytes, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';
export { promptScope } from './queue.js';
export type { AttachmentStagingWorkspace } from '../transports/tmux.js';
export type { AgentActivitySnapshot, PromptOperationIdentity, PromptOperationRecord } from './operations.js';

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
const maxPendingTerminalOperations = 4_096;
type PromptCompletion = 'completed' | 'failed' | 'pending';
export type PromptRequestStatus = { id: string; agentId: string; state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted'; submitted: boolean; error?: string };
type PendingTerminalOperation = Pick<PromptOperationIdentity, 'operationKey' | 'promptId' | 'agentId' | 'davoRequestId' | 'expiresAt'> & { outcome: PromptOutcome };
type StoredPromptRequest = PromptRequestStatus & { terminalAt?: number; promptFingerprint: string; terminalOperation?: Omit<PendingTerminalOperation, 'outcome'> };
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
  steer?(agentId: string, prompt: string, mayDispatch?: () => boolean): Promise<'sent' | 'unsupported' | 'refused'>;
}
type TurnDelivery = Delivery | { status: 'busy' };
// how a prompt is delivered (`waited`: it waited in the queue behind earlier work)
type TurnDeliveryOptions = Omit<DeliveryOptions, 'discovered'> & { discovered?: { agent: Agent }; waited?: true; sender?: PromptSender; identity?: StablePromptIdentity };
/** The structured Agents' Transport, which says which Agents are its own. */
export type StructuredTurnTransport = TurnTransport & { owns(agentId: string): Promise<boolean> };
type PromptPhase = TurnMark & { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; requestId?: string; historyEntryId?: string; historyPrompt?: string; failedDraft?: FailedDraft; sender?: PromptSender; operationKey?: string; davoRequestId?: string };
type SubmitRequestResult = { accepted: boolean; requestId?: string; promptId?: string; failure?: 'target-missing' | 'queue-rejected' | 'queue-conflict' | 'invalid' };
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

export type PromptLifecycleEvent = {
  agentId: string;
  promptId: string;
  sender: PromptSender;
  operationKey?: string;
  davoRequestId?: string;
};

export interface PromptLifecycleObserver {
  queued?(event: PromptLifecycleEvent): void | Promise<void>;
  delivered?(event: PromptLifecycleEvent & { historyEntryId?: string }): void | Promise<void>;
  ended?(event: Omit<PromptLifecycleEvent, 'agentId' | 'sender'> & { agentId?: string; sender?: PromptSender; outcome: PromptOutcome; answer?: string }): void | Promise<void>;
  handedOver?(event: { fromAgentId: string; toAgentId: string }): void | Promise<void>;
}

export type PromptPublicationInput = PromptOperationIdentity & {
  text: string;
  attachments?: PromptAttachment[];
};

export type PromptPublicationResult =
  | { kind: 'published'; operation: PromptOperationRecord; replayed: boolean }
  | { kind: 'conflict' | 'capacity' | 'expired' | 'invalid' | 'unavailable' }
  | { kind: 'unknown'; operation: PromptOperationRecord }
  | { kind: 'rejected'; reason: 'activity_changed' | 'activity_pending' | 'lease_rejected' | 'target_missing' | 'queue_rejected' };
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

// derive one content-free stable native observation key
const turnObservationKey = (attention: AgentAttentionState, mark: TurnMark): string => JSON.stringify({ attention: attention === 'finished' ? 'idle' : 'active', baselineCompletion: mark.baselineCompletion ?? null, rolloutBaseline: mark.rolloutBaseline ?? null });
// identify a native event gap without parsing any transcript content
const uncertainStructuredMark = (mark: TurnMark): boolean => mark.baselineCompletion?.startsWith(structuredTurnMarkPrefix) === true && mark.baselineCompletion.includes('"uncertain":true');

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
  private readonly ownedTurnMutations = new Set<string>();
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
  private operations?: PromptOperationLedger;
  private readonly lifecycleObservers = new Set<PromptLifecycleObserver>();
  private readonly activitySerializers = new Map<string, Promise<void>>();
  private readonly notifiedTerminalOperations = new Set<string>();
  private readonly pendingTerminalOperations = new Map<string, PendingTerminalOperation>();
  private readonly externalActivityEffects = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly davoOwnedTurns = new Map<string, { operationKey: string; promptId: string }>();
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

  // attach explicit durable operation storage without changing legacy construction
  useOperations(operations: PromptOperationLedger): void { this.operations = operations; }

  // add one independent lifecycle observer beside dispatch policy
  observePromptLifecycle(observer: PromptLifecycleObserver): () => void {
    this.lifecycleObservers.add(observer);
    // remove only this exact observer
    return () => { this.lifecycleObservers.delete(observer); };
  }

  // begin tracking one explicitly eligible Davo target
  async watchActivity(agentId: string, expiresAt: string): Promise<AgentActivitySnapshot | undefined> {
    return await this.serializeActivity(agentId, async () => {
      const operations = this.operations;
      if (operations === undefined) return undefined;
      const transport = await this.transportFor(agentId);
      const target = await transport.target(agentId);
      // require a real native baseline before tracking this target
      if (target === undefined) return undefined;
      const mark = await transport.mark(target.agent);
      const watched = await operations.watchActivity(agentId, expiresAt, { key: turnObservationKey(agentAttentionState(target.agent), mark), pending: agentAttentionState(target.agent) !== 'finished' });
      return watched;
    });
  }

  // read one tracked target frontier without creating ordinary-agent state
  async activitySnapshot(agentId: string): Promise<AgentActivitySnapshot | undefined> {
    return await this.operations?.activitySnapshot(agentId);
  }

  // report only an exactly verified current Davo turn
  davoOwned(agentId: string): boolean { return this.davoOwnedTurns.has(agentId); }

  // clear one exact Davo notification owner on intervening activity
  private clearDavoOwnership(agentId: string): void {
    this.davoOwnedTurns.delete(agentId);
    // clear only the sender marker this ownership supplied
    if (this.senders.get(agentId)?.label === 'davo') this.senders.delete(agentId);
  }

  // persist an external mutation before running its byte-preserving effect
  async withExternalActivity<T>(agentId: string, effect: () => T | Promise<T>, accepted?: (result: T) => boolean): Promise<T> {
    // recover durable tracking before any external effect
    if (await this.operations?.activitySnapshot(agentId) === undefined) return await effect();
    // nested effects reuse only their actual asynchronous caller's stamp
    if (this.externalActivityEffects.getStore()?.has(agentId)) return await effect();
    return await this.serializeActivity(agentId, async () => {
      await this.operations?.beginExternalActivity(agentId);
      return await this.externalActivityEffects.run(new Set([...(this.externalActivityEffects.getStore() ?? []), agentId]), async () => {
        const result = await effect();
        // clear only a caller-proven successful non-turn mutation
        if (accepted?.(result) === true) {
          this.clearDavoOwnership(agentId);
          await this.operations?.confirmExternalActivity(agentId);
        } else if (result === true) {
          // exact pane delivery is an intervening manual input
          this.clearDavoOwnership(agentId);
        }
        return result;
      });
    });
  }

  // advance only an uncorrelated observed turn
  async observeExternalTurn(agentId: string, observationKey: string, correlatedPromptId?: string, turnStarted = false): Promise<AgentActivitySnapshot | undefined> {
    // consult persisted eligibility before native observation
    if (await this.operations?.activitySnapshot(agentId) === undefined) return undefined;
    return await this.serializeActivity(agentId, async () => {
      const operations = this.operations;
      // ignore the exact PromptService-owned Davo turn
      if (operations !== undefined && correlatedPromptId !== undefined) {
        const correlated = await this.findOperationByPrompt(correlatedPromptId);
        if (correlated?.agentId === agentId && correlated.state === 'published') {
          await operations.setObservationBaseline(agentId, observationKey, turnStarted);
          return await operations.confirmExternalActivity(agentId);
        }
      }
      const before = await operations?.activitySnapshot(agentId);
      const after = await operations?.observeExternalTurn(agentId, observationKey, turnStarted);
      // changed uncorrelated evidence ends prior ownership
      if (before !== undefined && after !== undefined && (after.epoch !== before.epoch || after.pending !== before.pending)) this.clearDavoOwnership(agentId);
      return after;
    });
  }

  // recover one exact operation without presentation-history inference
  async lookupOperation(operationKey: string): Promise<PromptOperationRecord | undefined> {
    this.prunePendingTerminalOperations();
    const operation = await this.operations?.lookup(operationKey);
    // wait for an in-process publication before declaring recovery ambiguity
    if (operation === undefined) return undefined;
    return await this.serializeActivity(operation.agentId, async () => {
      const current = await this.operations?.lookup(operationKey);
      if (current === undefined) return undefined;
      const reconciled = await this.reconcileOperation(current);
      return await this.reconcileTerminalOperation(reconciled);
    });
  }

  // publish one exact idempotent prompt under the target activity serializer
  async publishOperation(input: PromptPublicationInput, leaseGuard: () => boolean | Promise<boolean>): Promise<PromptPublicationResult> {
    return await this.serializeActivity(input.agentId, async () => {
      const operations = this.operations;
      // require every durable publication dependency
      if (operations === undefined || this.queued === undefined || this.history === undefined) return { kind: 'unavailable' };
      const prepared = await operations.prepare(input);
      // return immutable identity failures without side effects
      if (prepared.kind === 'conflict' || prepared.kind === 'capacity' || prepared.kind === 'expired' || prepared.kind === 'invalid') return { kind: prepared.kind };
      let operation = prepared.operation;
      // reconcile every replay before considering another enqueue
      if (operation.state !== 'prepared') {
        operation = await this.reconcileOperation(operation);
        if (operation.state === 'published') return { kind: 'published', operation, replayed: true };
        return { kind: 'unknown', operation };
      }
      const activity = await operations.activitySnapshot(input.agentId);
      // require the exact nonpending target frontier
      if (activity?.pending) return { kind: 'rejected', reason: 'activity_pending' };
      if (activity === undefined || activity.epoch !== input.expectedActivityEpoch) return { kind: 'rejected', reason: 'activity_changed' };
      const publishing = await operations.transition(input.operationKey, ['prepared'], 'publishing');
      // fail closed on concurrent ledger mutation
      if (publishing === undefined) return { kind: 'unknown', operation: (await operations.lookup(input.operationKey)) ?? operation };
      const claimed = await operations.beginPublicationActivity(input.agentId, input.operationKey, input.expectedActivityEpoch);
      // restore prepared when no enqueue could begin
      if (claimed === undefined) {
        await operations.transition(input.operationKey, ['publishing'], 'prepared');
        const current = await operations.activitySnapshot(input.agentId);
        return { kind: 'rejected', reason: current?.pending ? 'activity_pending' : 'activity_changed' };
      }
      let guardAccepted: boolean;
      try { guardAccepted = await leaseGuard(); }
      catch { guardAccepted = false; }
      // re-open a proven no-effect attempt after authority rejection
      if (!guardAccepted) {
        await operations.transition(input.operationKey, ['publishing'], 'prepared');
        await operations.abandonPublicationActivity(input.agentId, input.operationKey, input.expectedActivityEpoch);
        return { kind: 'rejected', reason: 'lease_rejected' };
      }
      const identity: StablePromptIdentity = { id: input.promptId, operationKey: input.operationKey, davoRequestId: input.davoRequestId };
      let submitted: Awaited<ReturnType<PromptService['submitRequest']>>;
      try {
        submitted = await this.submitRequest(input.agentId, input.text, input.attachments ?? [], undefined, true, { label: 'davo' }, identity, input);
      } catch {
        const unknown = await operations.transition(input.operationKey, ['publishing'], 'unknown', claimed.epoch) ?? publishing;
        return { kind: 'unknown', operation: unknown };
      }
      // keep conflicting durable evidence non-replayable
      if (!submitted.accepted) {
        if (submitted.failure === 'queue-conflict') {
          const unknown = await operations.transition(input.operationKey, ['publishing'], 'unknown', claimed.epoch) ?? publishing;
          return { kind: 'unknown', operation: unknown };
        }
        // roll back only a proven no-enqueue result
        await operations.transition(input.operationKey, ['publishing'], 'prepared');
        await operations.abandonPublicationActivity(input.agentId, input.operationKey, input.expectedActivityEpoch);
        return { kind: 'rejected', reason: submitted.failure === 'target-missing' ? 'target_missing' : 'queue_rejected' };
      }
      const published = await operations.transition(input.operationKey, ['publishing'], 'published', claimed.epoch);
      // preserve ambiguity when the final durable commit is unavailable
      if (published === undefined) {
        const unknown = await operations.transition(input.operationKey, ['publishing'], 'unknown', claimed.epoch) ?? await operations.lookup(input.operationKey) ?? publishing;
        return { kind: 'unknown', operation: unknown };
      }
      await operations.confirmPublicationActivity(input.agentId, input.operationKey);
      this.davoOwnedTurns.set(input.agentId, { operationKey: input.operationKey, promptId: input.promptId });
      return { kind: 'published', operation: published, replayed: prepared.kind === 'existing' };
    });
  }

  // reconcile publishing ambiguity from exact durable queue or full history evidence
  private async reconcileOperation(operation: PromptOperationRecord): Promise<PromptOperationRecord> {
    const operations = this.operations;
    // preserve an authoritative terminal publication
    if (operations === undefined || operation.state === 'published' || operation.state === 'prepared') {
      if (operation.state === 'published') await operations?.confirmPublicationActivity(operation.agentId, operation.operationKey);
      return operation;
    }
    const scope = promptScope(operation.agentId);
    const queued = await this.queued?.findExact(scope, operation.operationKey, operation.promptId);
    const history = queued === undefined ? await this.history?.findExact(scope, operation.operationKey, operation.promptId) : undefined;
    // exact durable evidence proves the original publication only
    if (queued !== undefined || history !== undefined) {
      const published = await operations.transition(operation.operationKey, ['publishing', 'unknown'], 'published', operation.publicationActivityEpoch);
      if (published !== undefined) {
        await operations.confirmPublicationActivity(operation.agentId, operation.operationKey);
        return published;
      }
    }
    // recovered in-flight state is non-replayable unknown
    if (operation.state === 'publishing') return await operations.transition(operation.operationKey, ['publishing'], 'unknown', operation.publicationActivityEpoch) ?? operation;
    return operation;
  }

  // find one active operation by stable prompt identity
  private async findOperationByPrompt(promptId: string): Promise<PromptOperationRecord | undefined> {
    const operation = await this.operations?.lookupByPrompt(promptId);
    return operation === undefined ? undefined : await this.reconcileOperation(operation);
  }

  // serialize all activity-sensitive effects for one target
  private async serializeActivity<T>(agentId: string, effect: () => T | Promise<T>): Promise<T> {
    const previous = this.activitySerializers.get(agentId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(effect);
    const settled = operation.then(() => undefined, () => undefined);
    this.activitySerializers.set(agentId, settled);
    try { return await operation; }
    finally {
      // delete only the latest target serializer
      if (this.activitySerializers.get(agentId) === settled) this.activitySerializers.delete(agentId);
    }
  }

  // stamp and serialize one ordinary prompt source against Davo continuation
  private async runPromptSource<T>(agentId: string, effect: () => T | Promise<T>, accepted: (result: T) => boolean, preserveDavo = false): Promise<T> {
    // an outer lifecycle serializer already owns this exact asynchronous effect
    if (this.externalActivityEffects.getStore()?.has(agentId)) return await effect();
    // leave untracked agents outside durable activity state
    if (await this.operations?.activitySnapshot(agentId) === undefined) return await effect();
    const stamped = await this.serializeActivity(agentId, async () => await this.operations?.beginExternalActivity(agentId));
    const result = await effect();
    // retain failed or ambiguous attempts as pending divergence
    if (stamped !== undefined && accepted(result)) {
      // clear only an actually accepted unrelated source
      if (!preserveDavo) this.clearDavoOwnership(agentId);
      await this.serializeActivity(agentId, async () => { await this.operations?.confirmExternalActivity(agentId); });
    }
    return result;
  }

  // establish one managed or preexisting native turn baseline without divergence
  private async baselineTransportObservation(transport: TurnTransport, agent: Pick<Agent, 'id' | 'attention' | 'kind'>, pending: boolean, knownMark?: TurnMark, resolveUnknown = false): Promise<void> {
    // recover persisted eligibility before observing native activity
    if (await this.operations?.activitySnapshot(agent.id) === undefined) return;
    await this.serializeActivity(agent.id, async () => {
      const mark = knownMark ?? await transport.mark(agent);
      await this.operations?.setObservationBaseline(agent.id, turnObservationKey(agentAttentionState(agent), mark), pending);
      // exact owned history resolves a recovered native event gap
      if (resolveUnknown) await this.operations?.confirmExternalActivity(agent.id);
    });
  }

  // advance one watched target only for uncorrelated native evidence
  private async observeTransportActivity(transport: TurnTransport, agent: Pick<Agent, 'id' | 'attention' | 'kind'>, turnStarted: boolean, knownMark?: TurnMark): Promise<void> {
    // recover persisted eligibility before observing native activity
    if (await this.operations?.activitySnapshot(agent.id) === undefined) return;
    await this.serializeActivity(agent.id, async () => {
      const mark = knownMark ?? await transport.mark(agent);
      const before = await this.operations?.activitySnapshot(agent.id);
      const after = await this.operations?.observeExternalTurn(agent.id, turnObservationKey(agentAttentionState(agent), mark), turnStarted, uncertainStructuredMark(mark));
      // any changed native frontier ends prior Davo ownership
      if (before !== undefined && after !== undefined && (after.epoch !== before.epoch || after.pending !== before.pending)) this.clearDavoOwnership(agent.id);
    });
  }

  // verify one restarted busy turn against operation and native frontiers
  private async recoverDavoOwnership(agent: Pick<Agent, 'id' | 'attention'>, entry: PromptHistoryEntry, mark: TurnMark): Promise<boolean> {
    const operations = this.operations;
    // require complete stable Davo history identity
    if (operations === undefined || entry.operationKey === undefined || entry.davoRequestId === undefined) return false;
    const operationKey = entry.operationKey;
    const davoRequestId = entry.davoRequestId;
    return await this.serializeActivity(agent.id, async () => {
      // retain a dropped native replay as pending ambiguity
      if (uncertainStructuredMark(mark)) {
        await operations.observeExternalTurn(agent.id, turnObservationKey(agentAttentionState(agent), mark), true, true);
        this.clearDavoOwnership(agent.id);
        return false;
      }
      const operation = await operations.lookup(operationKey);
      const latest = await operations.latestPublished(agent.id);
      const before = await operations.activitySnapshot(agent.id);
      // bind only the exact latest published prompt at its publication frontier
      if (operation?.state !== 'published' || operation.promptId !== entry.id || operation.davoRequestId !== davoRequestId || operation.agentId !== agent.id || latest?.promptId !== entry.id || before === undefined || before.pending || operation.publicationActivityEpoch !== before.epoch) {
        this.clearDavoOwnership(agent.id);
        return false;
      }
      const after = await operations.observeExternalTurn(agent.id, turnObservationKey(agentAttentionState(agent), mark), true);
      const exact = after !== undefined && after.epoch === before.epoch && after.pending === before.pending;
      // preserve sender state only for unchanged exact native evidence
      if (exact) {
        this.davoOwnedTurns.set(agent.id, { operationKey: operation.operationKey, promptId: operation.promptId });
        this.senders.set(agent.id, senderOf(entry));
      } else this.clearDavoOwnership(agent.id);
      return exact;
    });
  }

  /**
   * Whether the Turn an Agent last started is one the operator need not hear finish (ADR 0019):
   * one the console started on its behalf, or one the Conductor that spawned it dispatched. A Turn
   * the Conductor dispatched to the operator's own Agent still pushes.
   */
  quiet(agent: Pick<Agent, 'id' | 'spawnedBy'>): boolean {
    const sender = this.senders.get(agent.id);
    return this.davoOwned(agent.id) || sender?.label !== undefined || sender?.from !== undefined && sender.from === agent.spawnedBy;
  }

  /** The queued prompt whose Turn the Agent is on now, and who sent it. */
  inFlight(agentId: string): { promptId: string; sender: PromptSender } | undefined {
    const phase = this.phases.get(promptScope(agentId));
    return phase?.requestId === undefined || phase.state === 'halted' ? undefined : { promptId: phase.requestId, sender: phase.sender ?? {} };
  }

  /** Queue a prompt from `sender` (another Agent, or the console), answering its queued prompt's id. */
  async submitFrom(agentId: string, prompt: string, sender: PromptSender, attachments: PromptAttachment[] = []): Promise<string | undefined> {
    return await this.runPromptSource(agentId, async () => (await this.submitRequest(agentId, prompt, attachments, undefined, false, sender)).promptId, promptId => promptId !== undefined);
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
    return await this.runPromptSource(agentId, async () => (await this.submitRequest(agentId, prompt, attachments, resetAt, false)).accepted, accepted => accepted);
  }

  // submit one prompt and expose its exact process-local lifecycle identity
  async submitTracked(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<{ requestId: string } | undefined> {
    return await this.runPromptSource(agentId, async () => {
      const result = await this.submitRequest(agentId, prompt, attachments, undefined, true);
      return result.accepted && result.requestId !== undefined ? { requestId: result.requestId } : undefined;
    }, result => result !== undefined);
  }

  // return one immutable request lifecycle snapshot
  requestStatus(requestId: string): PromptRequestStatus | undefined {
    this.pruneTrackedRequests();
    const request = this.trackedRequests.get(requestId);
    if (request === undefined) return undefined;
    const { terminalAt: _terminalAt, promptFingerprint: _promptFingerprint, terminalOperation: _terminalOperation, ...status } = request;
    return status;
  }

  // share ordinary and tracked prompt admission without changing legacy results
  private async submitRequest(agentId: string, prompt: string, attachments: PromptAttachment[], resetAt: number | undefined, tracked: boolean, sender: PromptSender = {}, identity?: StablePromptIdentity, terminalOperation?: PromptOperationIdentity): Promise<SubmitRequestResult> {
    // reject invalid content before any durable effect
    if (!validPrompt(prompt, attachments)) return { accepted: false, failure: 'invalid' };
    const releaseMutation = this.beginAgentMutation(agentId);
    const transport = await this.transportFor(agentId);
    const first = await transport.target(agentId);
    // release reservations for vanished targets
    if (!first) {
      releaseMutation?.();
      return { accepted: false, failure: 'target-missing' };
    }
    const scope = promptScope(agentId);
    const origin: QueuedPromptOrigin = { home: first.agent.home, ...(first.agent.placeId === undefined ? {} : { placeId: first.agent.placeId }) };
    let queueFailure: SubmitRequestResult['failure'];
    // queue the prompt durably, admitting it to the Calendar and tracking it before anything can dispatch it
    const enqueue = async (queued: QueuedPromptService): Promise<QueuedPromptSummary | undefined> => {
      const stable = identity === undefined ? undefined : await queued.putIfAbsent(scope, prompt, attachments, origin, identity);
      if (stable?.kind === 'conflict') queueFailure = 'queue-conflict';
      else if (stable !== undefined && stable.kind !== 'inserted' && stable.kind !== 'existing') queueFailure = 'queue-rejected';
      const added = stable === undefined ? await queued.enqueue(scope, prompt, attachments, origin, sender) : stable.kind === 'inserted' || stable.kind === 'existing' ? stable.prompt : undefined;
      if (added === undefined) return undefined;
      // a record that cannot be kept loses only the report: the prompt is queued
      if (sender.from !== undefined) await this.dispatchHooks?.queued(agentId, added.id, senderOf(sender)).catch(error => { console.error('[prompts] a dispatch could not be recorded:', error); });
      await this.notifyQueued(agentId, added, senderOf(sender));
      await this.admitCalendar(transport, added.id, agentId, first.agent.kind, added.createdAt, prompt, attachments);
      if (tracked) this.trackQueuedRequest(added.id, agentId, prompt, terminalOperation);
      return added;
    };
    const queuedAnswer = (queued: QueuedPromptSummary | undefined): SubmitRequestResult => ({ accepted: queued !== undefined, ...(queued === undefined ? { failure: queueFailure ?? 'queue-rejected' } : { promptId: queued.id }), ...(tracked && queued !== undefined ? { requestId: queued.id } : {}) });
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
        if (queued === undefined) return { accepted: false, failure: 'queue-rejected' };
        // delivery may remain queued without rejecting the accepted request
        await this.dispatch(transport, agentId, scope, resetAt, false);
        return queuedAnswer(queued);
      }
      const requestId = tracked || this.calendar !== undefined ? randomBytes(18).toString('base64url') : undefined;
      if (requestId !== undefined) await this.admitCalendar(transport, requestId, agentId, first.agent.kind, new Date().toISOString(), prompt, attachments);
      // direct deployments still receive a unique process-local identity
      if (requestId !== undefined) this.trackQueuedRequest(requestId, agentId, prompt, terminalOperation);
      const accepted = await this.send(transport, agentId, prompt, attachments, { discovered: first, resetAt, ...(requestId === undefined ? {} : { queuedPromptId: requestId }), ...(identity === undefined ? {} : { identity }), sender }) === 'submitted';
      // failed direct delivery has no durable queue to retain it
      if (!accepted && requestId !== undefined) this.settleTrackedRequest(requestId, 'failed', 'prompt submission failed');
      return { accepted, ...(accepted && requestId !== undefined ? { requestId } : {}), ...(accepted ? {} : { failure: 'queue-rejected' as const }) };
    } finally {
      releaseMutation();
    }
  }

  // register one accepted tracked request before dispatch begins
  private trackQueuedRequest(requestId: string, agentId: string, prompt: string, operation?: PromptOperationIdentity): void {
    this.pruneTrackedRequests();
    const terminalOperation = operation === undefined ? undefined : { operationKey: operation.operationKey, promptId: operation.promptId, agentId: operation.agentId, davoRequestId: operation.davoRequestId, expiresAt: operation.expiresAt };
    this.trackedRequests.set(requestId, { id: requestId, agentId, state: 'queued', submitted: false, promptFingerprint: createHash('sha256').update(prompt).digest('base64url'), ...(terminalOperation === undefined ? {} : { terminalOperation }) });
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
    const current = this.trackedRequests.get(requestId);
    if (error !== 'queue_updated') {
      const outcome = outcomeOf(state, error);
      this.rememberTerminalOperation(current?.terminalOperation, outcome);
      this.dispatchHooks?.ended(requestId, outcome, answer);
      void this.notifyEnded(requestId, outcome, answer);
    }
    if (current === undefined || current.terminalAt !== undefined) return;
    const next: StoredPromptRequest = { ...current, state, ...(error === undefined ? {} : { error }), terminalAt: Date.now() };
    this.trackedRequests.set(requestId, next);
    this.pruneTrackedRequests();
  }

  // report a durable queue row without letting observers affect delivery
  private async notifyQueued(agentId: string, prompt: QueuedPromptSummary, sender: PromptSender): Promise<void> {
    const event: PromptLifecycleEvent = { agentId, promptId: prompt.id, sender, ...(prompt.operationKey === undefined ? {} : { operationKey: prompt.operationKey }), ...(prompt.davoRequestId === undefined ? {} : { davoRequestId: prompt.davoRequestId }) };
    await this.operations?.recordLifecycle(prompt.id, { state: 'queued' }).catch(() => undefined);
    await this.notifyLifecycle('queued', event);
  }

  // report exact delivery and stable history identity
  private async notifyDelivered(agentId: string, promptId: string, sender: PromptSender, historyEntryId: string | undefined, identity: StablePromptIdentity | undefined): Promise<void> {
    const event: PromptLifecycleEvent & { historyEntryId?: string } = { agentId, promptId, sender, ...(historyEntryId === undefined ? {} : { historyEntryId }), ...(identity === undefined ? {} : { operationKey: identity.operationKey, davoRequestId: identity.davoRequestId }) };
    await this.operations?.recordLifecycle(promptId, { state: 'delivered', ...(historyEntryId === undefined ? {} : { historyEntryId }) }).catch(() => undefined);
    await this.notifyLifecycle('delivered', event);
  }

  // report one terminal lifecycle without retaining answer content in operations
  private async notifyEnded(promptId: string, outcome: PromptOutcome, answer?: string): Promise<void> {
    const operationKey = this.trackedRequests.get(promptId)?.terminalOperation?.operationKey;
    const pending = operationKey === undefined ? undefined : this.pendingTerminalOperations.get(operationKey);
    const operation = await this.operations?.lookupByPrompt(promptId).catch(() => undefined);
    const agentId = operation?.agentId ?? pending?.agentId;
    // retry only under the exact target serializer
    if (agentId === undefined) return;
    const recorded = await this.serializeActivity(agentId, async () => {
      const current = await this.operations?.lookupByPrompt(promptId).catch(() => undefined);
      // leave the bounded retry pending while storage is unavailable
      if (current === undefined) return undefined;
      const reconciled = await this.reconcileOperation(current);
      return await this.persistTerminalOperation(reconciled, outcome);
    });
    // observers run outside the target serializer they may reenter
    if (recorded !== undefined) await this.notifyTerminalOperation(recorded, outcome, answer);
  }

  // retain one immutable terminal receipt without answer content
  private rememberTerminalOperation(operation: StoredPromptRequest['terminalOperation'], outcome: PromptOutcome): void {
    // ordinary tracked prompts have no durable operation authority
    if (operation === undefined) return;
    this.prunePendingTerminalOperations();
    const existing = this.pendingTerminalOperations.get(operation.operationKey);
    // keep the first exact terminal observation immutable
    if (existing !== undefined) return;
    // expired operations have no retry authority
    if (Date.parse(operation.expiresAt) <= Date.now()) return;
    // never exceed the durable operation cap
    if (this.pendingTerminalOperations.size >= maxPendingTerminalOperations) return;
    this.pendingTerminalOperations.set(operation.operationKey, { ...operation, outcome });
  }

  // drop terminal retries at their original authority boundary
  private prunePendingTerminalOperations(): void {
    const now = Date.now();
    // remove only elapsed immutable receipts
    for (const [operationKey, operation] of this.pendingTerminalOperations) {
      if (Date.parse(operation.expiresAt) <= now) this.pendingTerminalOperations.delete(operationKey);
    }
  }

  // persist one exact terminal receipt before observer recovery
  private async persistTerminalOperation(operation: PromptOperationRecord, outcome: PromptOutcome): Promise<PromptOperationRecord> {
    const operations = this.operations;
    // preserve prior durable terminal authority
    if (operations === undefined || operation.lifecycle?.state === 'ended') {
      if (operation.lifecycle?.state === 'ended') this.pendingTerminalOperations.delete(operation.operationKey);
      return operation;
    }
    const pending = this.pendingTerminalOperations.get(operation.operationKey);
    // reject mismatched process-local retry identity
    if (pending !== undefined && (pending.promptId !== operation.promptId || pending.agentId !== operation.agentId || pending.davoRequestId !== operation.davoRequestId || pending.outcome !== outcome)) return operation;
    const recorded = await operations.recordLifecycle(operation.promptId, { state: 'ended', outcome }).catch(() => undefined);
    // require the exact durable terminal receipt
    if (recorded?.operationKey !== operation.operationKey || recorded.promptId !== operation.promptId || recorded.agentId !== operation.agentId || recorded.davoRequestId !== operation.davoRequestId || recorded.lifecycle?.state !== 'ended') return operation;
    this.pendingTerminalOperations.delete(operation.operationKey);
    return recorded;
  }

  // emit one callback only after exact durable terminal persistence
  private async notifyTerminalOperation(operation: PromptOperationRecord, outcome: PromptOutcome, answer?: string): Promise<void> {
    // reject nonterminal, racing, or duplicate callbacks
    if (operation.lifecycle?.state !== 'ended' || operation.lifecycle.outcome !== outcome || this.notifiedTerminalOperations.has(operation.operationKey)) return;
    this.notifiedTerminalOperations.add(operation.operationKey);
    // bound process-local observer deduplication by the durable operation cap
    if (this.notifiedTerminalOperations.size > maxPendingTerminalOperations) this.notifiedTerminalOperations.delete(this.notifiedTerminalOperations.values().next().value!);
    const history = answer === undefined ? await this.history?.findExact(promptScope(operation.agentId), operation.operationKey, operation.promptId).catch(() => undefined) : undefined;
    const recoveredAnswer = answer ?? history?.answer;
    await this.notifyLifecycle('ended', { promptId: operation.promptId, outcome, ...(recoveredAnswer === undefined ? {} : { answer: recoveredAnswer }), operationKey: operation.operationKey, davoRequestId: operation.davoRequestId, agentId: operation.agentId, sender: { label: 'davo' } });
  }

  // reconcile exact pending or completed history without prompt replay
  private async reconcileTerminalOperation(operation: PromptOperationRecord): Promise<PromptOperationRecord> {
    // terminal operations need no reconstruction
    if (operation.lifecycle?.state === 'ended') {
      this.pendingTerminalOperations.delete(operation.operationKey);
      return operation;
    }
    const pending = this.pendingTerminalOperations.get(operation.operationKey);
    // preserve the original in-process outcome
    if (pending !== undefined) return await this.persistTerminalOperation(operation, pending.outcome);
    const history = await this.history?.findExact(promptScope(operation.agentId), operation.operationKey, operation.promptId).catch(() => undefined);
    // only an exact correlated durable answer proves completion after restart
    if (history?.operationKey !== operation.operationKey || history.davoRequestId !== operation.davoRequestId || history.id !== operation.promptId || history.answer === undefined) return operation;
    return await this.persistTerminalOperation(operation, 'completed');
  }

  // mark exact idle restart evidence interrupted instead of inventing completion
  private async interruptUnresolvedTerminal(agentId: string): Promise<void> {
    const scope = promptScope(agentId);
    await this.serializeActivity(agentId, async () => {
      // fresh process-local ownership supersedes stale restart observation
      if (this.phases.has(scope)) return;
      const operation = await this.operations?.latestPublished(agentId).catch(() => undefined);
      // ignore absent, terminal, and locally retryable operations
      if (operation === undefined || operation.lifecycle?.state === 'ended' || this.pendingTerminalOperations.has(operation.operationKey)) return;
      const repaired = await this.reconcileTerminalOperation(operation);
      // a recovered answer already proved completion
      if (repaired.lifecycle?.state === 'ended') return;
      const history = await this.history?.findExact(scope, operation.operationKey, operation.promptId).catch(() => undefined);
      // require exact delivered identity before declaring restart interruption
      if (history?.operationKey !== operation.operationKey || history.davoRequestId !== operation.davoRequestId || history.id !== operation.promptId) return;
      // recheck ownership after durable history reads
      if (this.phases.has(scope)) return;
      await this.persistTerminalOperation(operation, 'interrupted');
    });
  }

  // isolate every additive observer failure
  private async notifyLifecycle<K extends keyof PromptLifecycleObserver>(method: K, event: Parameters<NonNullable<PromptLifecycleObserver[K]>>[0]): Promise<void> {
    const pending: Promise<unknown>[] = [];
    // invoke every observer independently
    for (const observer of this.lifecycleObservers) {
      const handler = observer[method] as ((value: typeof event) => void | Promise<void>) | undefined;
      // skip observers without this phase
      if (handler === undefined) continue;
      try { pending.push(Promise.resolve(handler.call(observer, event))); }
      catch { /* observer isolation */ }
    }
    await Promise.allSettled(pending);
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
    return await this.runPromptSource(agentId, async () => await this.transport.newConversation(agentId, command), accepted => accepted);
  }

  // submit one server-owned advisor prompt directly
  async submitUpdateAdvisor(agentId: string, targetSha: string, prompt: string): Promise<boolean> {
    // require one exact pending advisor and valid generated prompt
    if (!isFullGitSha(targetSha) || !validPrompt(prompt, [])) return false;
    return await this.runPromptSource(agentId, async () => {
      const target = await this.transport.target(agentId);
      if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
      return await this.send(this.transport, agentId, prompt, [], { discovered: target, submission: 'confirmed-enter' }) === 'submitted';
    }, accepted => accepted);
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
    if (this.lockedAgentIds.has(agentId) || this.ownedTurnMutations.has(agentId)) return undefined;
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
        const mark = started?.type === 'started' ? started.mark : undefined;
        this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now(), ...(mark ?? {}) });
        await this.baselineTransportObservation(transport, agent, true, mark);
      }
      const waiting = phase === undefined ? await this.queued?.list(scope) : undefined;
      // inspect queued or restart-orphaned work
      if (phase === undefined && ((waiting?.length ?? 0) > 0 || restartedEntry !== undefined || await this.operations?.activitySnapshot(agent.id) !== undefined)) {
        const mark = await transport.mark(agent);
        const davoRecovered = restartedEntry?.operationKey === undefined ? false : await this.recoverDavoOwnership(agent, restartedEntry, mark);
        // adopt Davo history only after exact native proof
        const recoveringEntry = restartedEntry?.operationKey !== undefined ? davoRecovered ? restartedEntry : undefined : mark.rolloutBaseline === undefined ? undefined : restartedEntry;
        // retain terminal reconciliation when rollout tracking is unavailable
        if ((waiting?.length ?? 0) > 0 || recoveringEntry !== undefined) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(recoveringEntry === undefined ? {} : { historyEntryId: recoveringEntry.id, historyPrompt: recoveringEntry.text, ...(recoveringEntry.operationKey === undefined || recoveringEntry.davoRequestId === undefined ? {} : { requestId: recoveringEntry.id, sender: senderOf(recoveringEntry), operationKey: recoveringEntry.operationKey, davoRequestId: recoveringEntry.davoRequestId }) }), ...mark });
        // correlated restart recovery and managed queued work keep their own baseline
        if (recoveringEntry?.operationKey !== undefined) await this.baselineTransportObservation(transport, agent, true, mark, true);
        else if (restartedEntry?.operationKey === undefined) await this.observeTransportActivity(transport, agent, true, mark);
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
        await this.baselineTransportObservation(transport, agent, false);
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
            await this.baselineTransportObservation(transport, agent, false);
          }
        } finally { this.dispatching.delete(scope); }
        if (anchored) await this.dispatch(transport, agent.id, scope);
        return;
      }
      // save the queue after failed, cancelled, or unrecordable work
      if (completion !== 'completed') {
        this.settleTrackedRequest(phase.requestId, 'failed', 'prompt_failed');
        this.phases.set(scope, { ...phase, state: 'halted', changedAt: Date.now() });
        await this.baselineTransportObservation(transport, agent, false);
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
      await this.baselineTransportObservation(transport, agent, false);
    }
    // recover answer tracking lost across restarts
    if (phase === undefined) {
      if (!this.reconciled.has(scope) && !await this.reconcile(transport, agent.id, scope)) return;
      await this.interruptUnresolvedTerminal(agent.id);
      // idle history alone cannot prove which native turn just ended
      await this.observeTransportActivity(transport, agent, false);
    }
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
  private async observeTurnless(transport: TurnTransport, agent: Pick<Agent, 'id' | 'attention' | 'kind'>, scope: string, reported: boolean): Promise<void> {
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry a failed queue transfer without dispatching
    if (phase?.state === 'halted') {
      // clear abandoned native input before final note recovery
      if (!busy && await this.clearHaltedDraft(phase) && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    if (busy) {
      // managed work was already counted at its mutation boundary
      if (phase !== undefined) await this.baselineTransportObservation(transport, agent, true);
      else await this.observeTransportActivity(transport, agent, true);
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
        await this.baselineTransportObservation(transport, agent, false);
        if (await this.saveQueued(scope)) this.phases.delete(scope);
        return;
      }
      // working -> finished: the prompt completed; its history entry stays answerless
      this.settleTrackedRequest(phase.requestId, 'complete');
      this.phases.delete(scope);
      await this.baselineTransportObservation(transport, agent, false);
    }
    // an idle native mark can prove a whole externally completed turn was missed
    if (phase === undefined) {
      await this.interruptUnresolvedTerminal(agent.id);
      await this.observeTransportActivity(transport, agent, false);
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
    await this.runPromptSource(fromAgentId, async () => await this.handOverNow(fromAgentId, toAgentId), moved => moved);
  }

  // move one exact agent scope after its durable activity stamp
  private async handOverNow(fromAgentId: string, toAgentId: string): Promise<boolean> {
    const from = promptScope(fromAgentId);
    const to = promptScope(toAgentId);
    // prompts that cannot move stay with the departed scope and drain into Notes
    if (this.queued !== undefined && !await this.queued.moveScope(from, to)) return false;
    await this.calendar?.handOver(fromAgentId, toAgentId).catch(() => undefined);
    await this.dispatchHooks?.handedOver(fromAgentId, toAgentId).catch(() => undefined);
    await this.notifyLifecycle('handedOver', { fromAgentId, toAgentId });
    // only queued requests have exact transfer identity during a restart handoff
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId !== fromAgentId || request.terminalAt !== undefined) continue;
      if (request.submitted) this.settleTrackedRequest(requestId, 'interrupted', 'agent_handover');
      else this.trackedRequests.set(requestId, { ...request, agentId: toAgentId });
    }
    await this.history?.moveScope(from, to);
    await this.forget(from);
    return true;
  }

  private async forget(scope: string): Promise<void> {
    this.departedSince.delete(scope);
    this.davoOwnedTurns.delete(scope.slice(promptScope('').length));
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
        const identity = prompt.operationKey === undefined || prompt.davoRequestId === undefined ? undefined : { id: prompt.id, operationKey: prompt.operationKey, davoRequestId: prompt.davoRequestId };
        const status = await this.send(transport, agentId, prompt.text, prompt.attachments ?? [], { durable: true, resetAt, queuedPromptId: prompt.id, sender: senderOf(prompt), ...(identity === undefined ? {} : { identity }), ...(waited ? { waited: true as const } : {}) });
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
      this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt, ...(options.sender === undefined ? {} : { sender: options.sender }), ...(options.identity === undefined ? {} : { operationKey: options.identity.operationKey, davoRequestId: options.identity.davoRequestId }) });
    });
    // a rejected target cannot leave an admitted interval eligible for later delivery
    if (delivery.status === 'held' && delivery.intended === true && requestId !== undefined) await calendar?.invalid(requestId, 'missing_lifecycle_evidence').catch(() => undefined);
    // halt only when a durable prompt is still waiting
    if (delivery.status === 'held') await this.holdFailedSubmission(scope, delivery.failedDraft);
    if (delivery.status !== 'submitted') return delivery.status;
    this.markTrackedRequestSubmitted(requestId);
    const sender = options.sender ?? {};
    // every accepted prompt replaces prior turn ownership
    this.clearDavoOwnership(agentId);
    this.senders.set(agentId, sender);
    if (delivery.instant) {
      this.settleTrackedRequest(requestId, 'complete');
      // release the provisional render phase instead of waiting for a nonexistent answer
      this.phases.delete(scope);
      if (delivery.reset === true) this.resetDelivered(scope);
      return 'submitted';
    }
    // track real prompts and their answers rather than reset commands
    const entry = await this.history?.record(scope, delivery.prompt, sender, options.identity).catch(() => undefined);
    // monitor managed prompt completion
    if (this.queued !== undefined || requestId !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), ...(requestId === undefined ? {} : { requestId }), historyPrompt: delivery.prompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }), ...(delivery.rolloutBaseline === undefined ? {} : { rolloutBaseline: delivery.rolloutBaseline }), sender, ...(options.identity === undefined ? {} : { operationKey: options.identity.operationKey, davoRequestId: options.identity.davoRequestId }) });
    // recorded before the prompt leaves the queue, so a restart never takes a Turn that ran for one that did not
    if (requestId !== undefined) await this.dispatchHooks?.delivered(agentId, requestId, sender, entry?.id).catch(() => undefined);
    if (requestId !== undefined) await this.notifyDelivered(agentId, requestId, sender, entry?.id, options.identity);
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

  // answer the current question directly without queueing a new agent turn; only the operator
  // answering in the console itself (`operator`) may grant a tool permission
  async answerQuestion(agentId: string, questionId: string, answer: QuestionAnswer, { mayAnswer = () => true, preserveDavo = false, operator = false }: { mayAnswer?: () => boolean; preserveDavo?: boolean; operator?: boolean } = {}): Promise<boolean> {
    return await this.runPromptSource(agentId, async () => {
      const transport = await this.transportFor(agentId);
      // revalidate actual live consent after durable activity stamping
      if (!mayAnswer()) return false;
      return await transport.answer(agentId, questionId, answer, operator);
    }, accepted => accepted, preserveDavo);
  }

  // Redirect a working Agent at once, where its Transport can steer. A steer is not queued;
  // history keeps it as its own entry, with no answer.
  async steer(agentId: string, prompt: string, expected?: { promptId: string; from: string }): Promise<'sent' | 'unsupported' | 'refused'> {
    return await this.runPromptSource(agentId, async () => {
      // reserve owned-Turn mutations so a browser input cannot replace their authorized Turn
      if (this.ownedTurnMutations.has(agentId)) return 'refused';
      // expected identity is checked again inside the transport at its final dispatch boundary
      const current = () => expected === undefined || this.inFlight(agentId)?.promptId === expected.promptId && this.inFlight(agentId)?.sender.from === expected.from;
      if (!current()) return 'refused';
      if (expected !== undefined) this.ownedTurnMutations.add(agentId);
      try {
        const transport = await this.transportFor(agentId);
        const outcome = transport.steer === undefined ? 'unsupported' : !current() ? 'refused' : await transport.steer(agentId, prompt, current);
        // record only an actual steer in history
        if (outcome === 'sent') await this.history?.record(promptScope(agentId), prompt).catch(() => undefined);
        return outcome;
      } finally { this.ownedTurnMutations.delete(agentId); }
    }, outcome => outcome === 'sent');
  }

  // interrupt a working Agent, holding the in-flight prompt's queue rather than releasing it;
  // `returned` hears the steers it dropped
  async cancel(agentId: string, returned?: (steers: string[]) => void, expected?: { promptId: string; from: string }): Promise<InterruptOutcome> {
    // avoid recursive serialization when pane input already stamped Ctrl+C
    if (this.externalActivityEffects.getStore()?.has(agentId)) return await this.cancelNow(agentId, returned, expected);
    return await this.runPromptSource(agentId, async () => await this.cancelNow(agentId, returned, expected), outcome => outcome === 'ok');
  }

  // perform one interrupt after its caller owns the activity boundary
  private async cancelNow(agentId: string, returned?: (steers: string[]) => void, expected?: { promptId: string; from: string }): Promise<InterruptOutcome> {
    const scope = promptScope(agentId);
    // refuse concurrent input or a stale dispatch before any interrupt can be sent
    if (this.ownedTurnMutations.has(agentId)) return 'not-working';
    const current = () => expected === undefined || this.inFlight(agentId)?.promptId === expected.promptId && this.inFlight(agentId)?.sender.from === expected.from;
    if (!current()) return 'not-working';
    if (expected !== undefined) this.ownedTurnMutations.add(agentId);
    this.cancelling.add(scope);
    let outcome: InterruptOutcome;
    try {
      const transport = await this.transportFor(agentId);
      outcome = current() ? await transport.interrupt(agentId, returned, current) : 'not-working';
    } finally { this.cancelling.delete(scope); this.ownedTurnMutations.delete(agentId); }
    if (outcome !== 'ok') return outcome;
    const phase = this.phases.get(scope);
    this.settleTrackedRequest(phase?.requestId, 'interrupted', 'prompt_interrupted');
    if (this.queued !== undefined) this.phases.set(scope, { state: 'halted', changedAt: Date.now(), ...(phase?.requestId === undefined ? {} : { requestId: phase.requestId }) });
    return 'ok';
  }

  // stop one Agent; closing it makes every accepted tracked request terminal. A structured
  // Agent's queue becomes Notes at once; a pane's departs with it after the departure grace.
  async close(agentId: string): Promise<boolean> {
    // reuse an outer manual activity stamp when one exists
    if (this.externalActivityEffects.getStore()?.has(agentId)) return await this.closeNow(agentId);
    return await this.runPromptSource(agentId, async () => await this.closeNow(agentId), closed => closed);
  }

  // close one exact transport after its caller owns the activity boundary
  private async closeNow(agentId: string): Promise<boolean> {
    const transport = await this.transportFor(agentId);
    if (!await transport.close(agentId)) return false;
    for (const [requestId, request] of this.trackedRequests) {
      if (request.agentId === agentId && request.terminalAt === undefined) this.settleTrackedRequest(requestId, 'interrupted', 'agent_closed');
    }
    // the Turn it was on ends with it, tracked or not
    this.settleTrackedRequest(this.phases.get(promptScope(agentId))?.requestId, 'interrupted', 'agent_closed');
    this.davoOwnedTurns.delete(agentId);
    this.senders.delete(agentId);
    if (transport === this.structured) await this.saveQueued(promptScope(agentId));
    return true;
  }
}
