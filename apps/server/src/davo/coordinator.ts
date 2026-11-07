import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactIntegrationText } from '../integrations/text.js';
import { davoCompletionEnvelopeSchema, davoRemoteQuestionSchema, isSafeDavoText, utf8Bytes, type DavoCompletionEnvelopeV1, type DavoContinuationPrincipalV1, type DavoCriterionV1, type DavoInstanceQualifiedTargetV1, type DavoRequestV1, type DavoStateV1 } from './contracts.js';
import { activityEpoch, continuationPayloadDigest, type DavoActivityFrontierV1, type DavoContinuationPublishInput, type DavoContinuationResult } from './continuation.js';
import { expiryForAnchor, localDateForInstant } from './retention.js';
import { canonicalFollowupPayload, canonicalRequestSeed, digestDavo, renderDavoFollowupV1 } from './remote.js';
import { DavoStore } from './store.js';

export const DAVO_AUTOMATIC_FOLLOWUP_ROUNDS = 3;
export const DAVO_CUMULATIVE_FOLLOWUP_MAX_BYTES = DAVO_AUTOMATIC_FOLLOWUP_ROUNDS * 40_960;
export const DAVO_EVALUATIONS_PER_HOUR = 12;
export const DAVO_PUBLICATION_LOOKUP_LIMIT = 3;

type ContinuationChoiceReason = 'followup-budget' | 'target-chain-diverged' | 'publication-unknown';

export type DavoEvaluatorRecommendation = {
  recommendation: 'candidate_done' | 'continue' | 'inconsistent';
  unmetCriterionIds: string[];
  contradictions: string[];
  safeSummary: string;
};

export type DavoAdmissionInput = {
  requestId: string;
  originalMessageId: string;
  criteria: DavoCriterionV1[];
  requiredChecks: string[];
  target: DavoInstanceQualifiedTargetV1;
  principal: DavoContinuationPrincipalV1;
  operationId: string;
  payloadDigest: string;
};

export type DavoLifecycleReceipt = {
  requestId: string;
  operationId: string;
  promptId: string;
  generation: number;
  requestRevision: number;
  targetActivityEpoch: string;
  state: 'completed' | 'failed' | 'question';
  completionEnvelope?: DavoCompletionEnvelopeV1;
  safeExcerpt?: string;
  question?: { questionId: string; question: string; agentProcessGeneration: number; answerShape: 'text' | 'single-choice' | 'multiple-choice'; choices?: string[] };
};

export type DavoCoordinatorResult =
  | { status: 'done' }
  | { status: 'continued'; promptId: string }
  | { status: 'choice' }
  | { status: 'blocked' }
  | { status: 'stale' }
  | { status: 'expired' };

export type DavoCoordinatorOptions = {
  store: DavoStore;
  continuation: {
    publish(input: DavoContinuationPublishInput): Promise<DavoContinuationResult>;
    lookup?(requestId: string, operationId: string): Promise<DavoContinuationResult>;
  };
  activity: { read(target: DavoInstanceQualifiedTargetV1): Promise<DavoActivityFrontierV1 | undefined> };
  evaluator: {
    evaluate(input: {
      requestId: string;
      requestRevision: number;
      generation: number;
      promptId: string;
      originalRequest: string;
      criteria: DavoCriterionV1[];
      envelope?: DavoCompletionEnvelopeV1;
      safeExcerpt?: string;
    }): Promise<DavoEvaluatorRecommendation>;
  };
  lifecycle?: { lookup(request: DavoRequestV1): Promise<DavoLifecycleReceipt | undefined> };
  now?: () => Date;
};

export type DavoAnswerChoiceInput = {
  requestId: string;
  choiceId: string;
  option: 'authorize-one-more-batch' | 'stop-followup' | 'resume-after-current-chain' | 'wait-for-evidence';
  generation: number;
  frontier?: DavoActivityFrontierV1;
};

const evaluatorRecommendationSchema = z.object({
  recommendation: z.enum(['candidate_done', 'continue', 'inconsistent']),
  unmetCriterionIds: z.array(z.string().min(1).max(256)).max(64),
  contradictions: z.array(z.string().max(8_192)).max(64),
  safeSummary: z.string().max(8_192)
}).strict().refine(value => utf8Bytes(JSON.stringify(value)) <= 8_192);

// redact every string before accepting untrusted completion evidence
export function sanitizeDavoCompletion(value: unknown): DavoCompletionEnvelopeV1 | undefined {
  // recurse without changing container shape
  const redact = (candidate: unknown): unknown => {
    // redact scalar evidence before durable use
    if (typeof candidate === 'string') return redactIntegrationText(candidate);
    // retain array shape while sanitizing every entry
    if (Array.isArray(candidate)) return candidate.map(redact);
    // retain only plain object entries
    if (candidate !== null && typeof candidate === 'object') return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, redact(entry)]));
    return candidate;
  };
  const parsed = davoCompletionEnvelopeSchema.safeParse(redact(value));
  return parsed.success ? parsed.data : undefined;
}

// expire one superseded choice delivery without rewriting send certainty
function retireChoiceNotification(state: DavoStateV1, request: DavoRequestV1): void {
  const eventId = request.notification?.outcome === 'choice' ? request.notification.eventId : undefined;
  // expire only the exact active choice event
  if (eventId !== undefined) {
    for (const notification of state.notificationOutbox) {
      // preserve historical attempted and ambiguous outcomes
      if (notification.requestId === request.id && notification.eventId === eventId && (notification.state === 'ready' || notification.state === 'dispatching')) notification.state = 'expired';
    }
  }
  request.notification = undefined;
}

// install one exact continuation choice and its notification
function installContinuationChoice(state: DavoStateV1, request: DavoRequestV1, reason: ContinuationChoiceReason, now: string): void {
  retireChoiceNotification(state, request);
  const choiceId = randomUUID();
  request.state = 'awaiting-choice';
  request.revision += 1;
  request.attention = reason === 'followup-budget'
    ? { kind: 'davo_continuation_choice', choiceId, reason, options: ['authorize-one-more-batch', 'stop-followup'] }
    : reason === 'target-chain-diverged'
      ? { kind: 'davo_continuation_choice', choiceId, reason, options: ['resume-after-current-chain', 'stop-followup'] }
      : { kind: 'davo_continuation_choice', choiceId, reason, options: ['wait-for-evidence', 'stop-followup'] };
  const message = reason === 'followup-budget' ? 'More work needs your choice.' : reason === 'target-chain-diverged' ? 'Other Agent activity needs your choice.' : 'Publication evidence needs your choice.';
  appendStatus(state, request, message, `choice-${choiceId}`, now);
  const eventId = `davo-choice-${choiceId}`;
  state.notificationOutbox.push({ id: randomUUID(), requestId: request.id, kind: 'choice', tag: `davo-${request.id}-choice`, state: 'ready', eventId, attempts: 0, createdAt: now });
  request.notification = { eventId, outcome: 'choice', revision: request.revision };
}

// find one durable request
function requestFrom(state: DavoStateV1, requestId: string): DavoRequestV1 | undefined {
  return state.requests.find(request => request.id === requestId);
}

// find the immutable original user text
function originalText(state: DavoStateV1, request: DavoRequestV1): string | undefined {
  const message = state.messages.find(candidate => candidate.id === request.originalMessageId);
  return message?.kind === 'user' ? message.text : undefined;
}

// compare one exact stable frontier
function currentChain(request: DavoRequestV1, frontier: DavoActivityFrontierV1 | undefined): boolean {
  // reject missing or pending activity
  if (frontier === undefined || frontier.pendingExternalMutation !== undefined) return false;
  const target = request.instanceQualifiedTarget;
  return frontier.instanceId === target.instanceId
    && frontier.agentId === target.agentId
    && frontier.processGeneration === target.processGeneration
    && frontier.conversationId === target.conversationId
    && frontier.chainHeadPromptId === request.expectedPromptChainHead
    && activityEpoch(frontier) === request.targetActivityEpoch;
}

// prove all immutable completion predicates
function deterministicCompletion(request: DavoRequestV1, envelope: DavoCompletionEnvelopeV1 | undefined): envelope is DavoCompletionEnvelopeV1 {
  // require exact complete evidence
  if (envelope === undefined || envelope.requestId !== request.id || envelope.outcome !== 'complete' || envelope.question !== undefined || envelope.remaining.length !== 0) return false;
  const expectedCriteria = request.criteria.map(criterion => criterion.id);
  const actualCriteria = envelope.criteria.map(criterion => criterion.id);
  // require exact ordered criterion coverage
  if (expectedCriteria.length !== actualCriteria.length || expectedCriteria.some((id, index) => actualCriteria[index] !== id)) return false;
  // reject incomplete criterion evidence
  if (envelope.criteria.some(criterion => criterion.status !== 'satisfied' || criterion.evidence === '')) return false;
  const checks = new Map(envelope.checks.map(check => [check.name, check]));
  // require every declared check exactly once
  if (checks.size !== envelope.checks.length || request.requiredChecks.some(name => !checks.has(name)) || envelope.checks.some(check => !request.requiredChecks.includes(check.name))) return false;
  // reject failed or unexplained checks
  if (envelope.checks.some(check => check.status === 'failed' || check.evidence === '')) return false;
  return true;
}

// append one anchored status inside an existing transaction
function appendStatus(state: DavoStateV1, request: DavoRequestV1, text: string, statusKey: string, now: string): void {
  state.messages.push({
    sequence: state.nextSequence,
    id: randomUUID(),
    conversationId: state.logicalConversationId,
    generation: state.retention.generation,
    createdAt: now,
    localDate: localDateForInstant(now),
    retentionAnchorAt: request.originalRequestedAt,
    retentionAnchorLocalDate: request.originalLocalDate,
    requestId: request.id,
    kind: 'status',
    text,
    source: { kind: 'request-status', statusKey }
  });
  state.nextSequence += 1;
}

// append one terminal assistant row and outbox event
function appendDone(state: DavoStateV1, request: DavoRequestV1, summary: string, now: string): void {
  const eventId = `davo-done-${request.id}`;
  state.messages.push({
    sequence: state.nextSequence,
    id: randomUUID(),
    conversationId: state.logicalConversationId,
    generation: state.retention.generation,
    createdAt: now,
    localDate: localDateForInstant(now),
    retentionAnchorAt: request.originalRequestedAt,
    retentionAnchorLocalDate: request.originalLocalDate,
    requestId: request.id,
    kind: 'assistant',
    text: summary,
    source: { kind: 'request-response', requestId: request.id, eventId }
  });
  state.nextSequence += 1;
  state.notificationOutbox.push({ id: randomUUID(), requestId: request.id, kind: 'done', tag: `davo-${request.id}-done`, state: 'ready', eventId, attempts: 0, createdAt: now });
  request.notification = { eventId, outcome: 'done', revision: request.revision };
}

// render one server-owned followup from immutable evidence
function renderFollowup(original: string, request: DavoRequestV1, envelope: DavoCompletionEnvelopeV1 | undefined, recommendation: DavoEvaluatorRecommendation, safeExcerpt: string | undefined, cycle: number): { canonicalPayload: string; rendered: string } {
  const requestSeed = { version: 1 as const, requestId: request.id, originalRequest: original, criterionSetVersion: 1 as const, criteria: request.criteria, requiredChecks: request.requiredChecks };
  const recommended = new Set(recommendation.unmetCriterionIds);
  const incomplete = new Set(envelope?.criteria.filter(criterion => criterion.status !== 'satisfied').map(criterion => criterion.id) ?? request.criteria.map(criterion => criterion.id));
  const unmetCriterionIds = request.criteria.map(criterion => criterion.id).filter(id => recommended.has(id) || incomplete.has(id));
  const canonicalPayload = canonicalFollowupPayload({
    version: 1,
    rendererVersion: 1,
    requestSeed,
    requestSeedDigest: digestDavo(canonicalRequestSeed(requestSeed)),
    cycle,
    priorPromptId: request.dispatch.state === 'published' ? request.dispatch.promptId : request.expectedPromptChainHead,
    unmetCriterionIds,
    ...(envelope === undefined ? {} : { completionEnvelope: envelope }),
    safeExcerpt: safeExcerpt ?? ''
  });
  return { canonicalPayload, rendered: renderDavoFollowupV1(canonicalPayload) };
}

export class DavoCoordinator {
  private readonly store: DavoStore;
  private readonly continuation: DavoCoordinatorOptions['continuation'];
  private readonly activity: DavoCoordinatorOptions['activity'];
  private readonly evaluator: DavoCoordinatorOptions['evaluator'];
  private readonly lifecycle?: DavoCoordinatorOptions['lifecycle'];
  private readonly now: () => Date;

  // retain narrow coordinator dependencies
  constructor(options: DavoCoordinatorOptions) {
    this.store = options.store;
    this.continuation = options.continuation;
    this.activity = options.activity;
    this.evaluator = options.evaluator;
    this.lifecycle = options.lifecycle;
    this.now = options.now ?? (() => new Date());
  }

  // persist immutable request authority before publication
  async admit(input: DavoAdmissionInput, guard?: () => boolean): Promise<DavoRequestV1> {
    return this.store.transact(state => {
      const existing = requestFrom(state, input.requestId);
      // reconcile exact admission retries
      if (existing !== undefined) {
        const same = existing.originalMessageId === input.originalMessageId
          && JSON.stringify(existing.criteria) === JSON.stringify(input.criteria)
          && JSON.stringify(existing.requiredChecks) === JSON.stringify(input.requiredChecks)
          && existing.dispatch.operationId === input.operationId
          && existing.dispatch.payloadDigest === input.payloadDigest;
        // reject semantic request reuse
        if (!same) throw new Error('davo admission conflict');
        return existing;
      }
      const message = state.messages.find(candidate => candidate.id === input.originalMessageId);
      // require one current retained user anchor
      if (message === undefined || message.kind !== 'user' || message.generation !== state.retention.generation) throw new Error('invalid davo original message');
      // bind authority expiry to the immutable original anchor
      if (input.principal.expiresAt !== expiryForAnchor(message.createdAt)) throw new Error('invalid davo request expiry');
      const { instanceId: _instanceId, ...unqualifiedTarget } = input.target;
      // bind principal identity and exact target to admission
      if (input.principal.destinationInstanceId !== input.target.instanceId || JSON.stringify(input.principal.target) !== JSON.stringify(unqualifiedTarget)) throw new Error('invalid davo continuation principal');
      const request: DavoRequestV1 = {
        id: input.requestId,
        originalMessageId: message.id,
        originalRequestedAt: message.createdAt,
        originalLocalDate: message.localDate,
        state: 'dispatching',
        revision: 0,
        admittedGeneration: state.retention.generation,
        instanceQualifiedTarget: input.target,
        targetActivityEpoch: input.target.targetActivityEpoch,
        expectedPromptChainHead: input.target.expectedPromptChainHead,
        principal: input.principal,
        dispatch: { state: 'prepared', operationId: input.operationId, payloadDigest: input.payloadDigest },
        criteria: input.criteria,
        requiredChecks: input.requiredChecks,
        coordination: { followupCycles: 0, evaluationTimestamps: [], cumulativeFollowupBytes: 0, extraAuthorizedBatches: 0 }
      };
      // revalidate the exact live capability at the durable insertion point
      if (guard !== undefined && !guard()) throw new Error('davo_turn_changed');
      state.requests.push(request);
      return request;
    });
  }

  // record one exact initial or followup publication
  async markPublished(requestId: string, operationId: string, promptId: string, frontier?: DavoActivityFrontierV1): Promise<void> {
    await this.store.transact(state => {
      const request = requestFrom(state, requestId);
      // require the currently prepared operation
      if (request === undefined || request.dispatch.operationId !== operationId) throw new Error('stale davo publication');
      // reject a substituted prompt after publication
      if (request.dispatch.state === 'published' && request.dispatch.promptId !== promptId) throw new Error('stale davo publication');
      const frontierEpoch = frontier === undefined ? undefined : activityEpoch(frontier);
      // ignore only a fully applied exact publication receipt
      if (request.dispatch.state === 'published'
        && request.state === 'awaiting-agent'
        && request.expectedPromptChainHead === promptId
        && (frontierEpoch === undefined || request.targetActivityEpoch === frontierEpoch)) return;
      const operation = state.operations.find(candidate => candidate.operationId === operationId);
      // reject a conflicting durable operation identity
      if (operation !== undefined && (operation.requestId !== request.id
        || operation.destinationInstanceId !== request.principal.destinationInstanceId
        || operation.generation !== request.admittedGeneration
        || operation.payloadDigest !== request.dispatch.payloadDigest
        || operation.promptId !== undefined && operation.promptId !== promptId)) throw new Error('stale davo publication');
      // persist the caller-validated publication proof when initial dispatch has no row yet
      if (operation === undefined) state.operations.push({
        operationId,
        requestId: request.id,
        destinationInstanceId: request.principal.destinationInstanceId,
        kind: 'original-delegation',
        generation: request.admittedGeneration,
        targetActivityEpoch: request.targetActivityEpoch,
        payloadDigest: request.dispatch.payloadDigest,
        state: 'published',
        promptId,
        createdAt: this.now().toISOString(),
        expiresAt: request.principal.expiresAt
      });
      else {
        operation.state = 'published';
        operation.promptId = promptId;
      }
      // preserve an already durable publication identity
      if (request.dispatch.state !== 'published') request.dispatch = { state: 'published', operationId, payloadDigest: request.dispatch.payloadDigest, promptId };
      // exact proof resolves a pending publication decision
      if (request.coordination.publicationRecovery?.operationId === operationId) {
        retireChoiceNotification(state, request);
        request.coordination.publicationRecovery = undefined;
        request.attention = undefined;
        request.lastSafeError = undefined;
      }
      request.state = 'awaiting-agent';
      request.revision += 1;
      request.expectedPromptChainHead = promptId;
      request.instanceQualifiedTarget.expectedPromptChainHead = promptId;
      // advance only from exact publication frontier proof
      if (frontierEpoch !== undefined) {
        request.targetActivityEpoch = frontierEpoch;
        request.instanceQualifiedTarget.targetActivityEpoch = request.targetActivityEpoch;
      }
    });
  }

  // persist followup identity before any publication effect
  private async prepareFollowup(requestId: string, expectedRevision: number, operationId: string, payloadDigest: string, payloadBytes: number): Promise<boolean> {
    return this.store.transact(state => {
      const request = requestFrom(state, requestId);
      // prepare only the exact evaluating revision and prior published chain
      if (request === undefined || request.revision !== expectedRevision || request.state !== 'evaluating' || request.dispatch.state !== 'published') return false;
      const existing = state.operations.find(operation => operation.operationId === operationId);
      // reject semantic operation reuse before publication
      if (existing !== undefined && (existing.requestId !== requestId || existing.kind !== 'followup' || existing.payloadDigest !== payloadDigest)) return false;
      // persist a prepared operation before crossing the effect boundary
      if (existing === undefined) state.operations.push({
        operationId,
        requestId,
        destinationInstanceId: request.principal.destinationInstanceId,
        kind: 'followup',
        generation: state.retention.generation,
        targetActivityEpoch: request.targetActivityEpoch,
        payloadDigest,
        state: 'prepared',
        createdAt: this.now().toISOString(),
        expiresAt: request.principal.expiresAt
      });
      request.coordination.activeOperationId = operationId;
      request.coordination.activeFollowupBytes = payloadBytes;
      return true;
    });
  }

  // parse the next exact deterministic followup cycle
  private followupCycle(request: DavoRequestV1, operationId: string): number | undefined {
    const match = new RegExp(`^${request.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-followup-(\\d+)$`, 'u').exec(operationId);
    // reject malformed, skipped, or repeated cycles
    if (match === null) return undefined;
    const cycle = Number(match[1]);
    return Number.isSafeInteger(cycle) && cycle === request.coordination.followupCycles + 1 ? cycle : undefined;
  }

  // bind one recovered or immediate publication to its new exact frontier
  private async finishFollowup(requestId: string, operationId: string, promptId: string, frontier: DavoActivityFrontierV1): Promise<boolean> {
    return this.store.transact(state => {
      const stored = requestFrom(state, requestId);
      const operation = state.operations.find(candidate => candidate.operationId === operationId && candidate.requestId === requestId);
      const recovering = stored?.coordination.publicationRecovery?.operationId === operationId;
      // require the same durable evaluating or exact recovery operation
      if (stored === undefined
        || stored.state !== 'evaluating' && !(stored.state === 'operational-blocked' && recovering)
        || operation === undefined
        || operation.promptId !== undefined && operation.promptId !== promptId
        || stored.coordination.activeFollowupBytes === undefined
        || frontier.pendingExternalMutation !== undefined
        || frontier.instanceId !== stored.instanceQualifiedTarget.instanceId
        || frontier.agentId !== stored.instanceQualifiedTarget.agentId
        || frontier.chainHeadPromptId !== promptId
        || frontier.processGeneration !== stored.instanceQualifiedTarget.processGeneration
        || frontier.conversationId !== stored.instanceQualifiedTarget.conversationId) return false;
      const cycle = this.followupCycle(stored, operationId);
      // refuse a nonsequential followup receipt
      if (cycle === undefined) return false;
      const payloadBytes = stored.coordination.activeFollowupBytes;
      operation.state = 'published';
      operation.promptId = promptId;
      stored.coordination.followupCycles = cycle;
      stored.coordination.cumulativeFollowupBytes += payloadBytes;
      stored.coordination.activeOperationId = undefined;
      stored.coordination.activeFollowupBytes = undefined;
      stored.coordination.publicationRecovery = undefined;
      stored.attention = undefined;
      stored.lastSafeError = undefined;
      stored.state = 'awaiting-agent';
      stored.revision += 1;
      stored.dispatch = { state: 'published', operationId, payloadDigest: operation.payloadDigest, promptId };
      stored.expectedPromptChainHead = promptId;
      stored.targetActivityEpoch = activityEpoch(frontier);
      stored.instanceQualifiedTarget.expectedPromptChainHead = promptId;
      stored.instanceQualifiedTarget.targetActivityEpoch = stored.targetActivityEpoch;
      appendStatus(state, stored, 'I asked the Agent to continue the original request.', `followup-${cycle}`, this.now().toISOString());
      return true;
    });
  }

  // persist a genuine pending choice once
  private async choice(requestId: string, reason: 'followup-budget' | 'target-chain-diverged'): Promise<DavoCoordinatorResult> {
    await this.store.transact(state => {
      const request = requestFrom(state, requestId);
      // preserve an existing exact choice
      if (request === undefined || request.attention?.kind === 'davo_continuation_choice') return;
      installContinuationChoice(state, request, reason, this.now().toISOString());
    });
    return { status: 'choice' };
  }

  // persist publication ambiguity before any exact lookup loop
  async markPublicationUnknown(requestId: string, operationId: string): Promise<DavoCoordinatorResult> {
    await this.store.transact(state => {
      const request = requestFrom(state, requestId);
      const operation = state.operations.find(candidate => candidate.requestId === requestId && candidate.operationId === operationId);
      // bind ambiguity only to the exact durable effect claim
      if (request === undefined || operation === undefined || request.dispatch.operationId !== operationId && request.coordination.activeOperationId !== operationId) return;
      // preserve an existing recovery frontier without duplicate status
      if (request.coordination.publicationRecovery?.operationId === operationId) return;
      operation.state = 'unknown';
      request.dispatch = { state: 'unknown', operationId, payloadDigest: operation.payloadDigest };
      request.coordination.publicationRecovery = { operationId, lookupChecks: 0, mode: 'probing' };
      request.state = 'operational-blocked';
      request.revision += 1;
      request.attention = { kind: 'operational_blocked', code: 'davo_publication_unknown' };
      request.lastSafeError = { code: 'davo_publication_unknown' };
      appendStatus(state, request, 'Publication is being verified.', `publication-unknown-${operationId}`, this.now().toISOString());
    });
    return { status: 'blocked' };
  }

  // record one exact unknown lookup and expose a bounded human choice
  private async recordUnknownLookup(requestId: string, operationId: string): Promise<DavoCoordinatorResult> {
    return await this.store.transact(state => {
      const request = requestFrom(state, requestId);
      const recovery = request?.coordination.publicationRecovery;
      // reject replaced or stopped recovery loops
      if (request === undefined || recovery?.operationId !== operationId) return { status: 'stale' as const };
      if (recovery.mode === 'choice') return { status: 'choice' as const };
      if (recovery.mode === 'stopped' || recovery.mode === 'waiting') return { status: 'blocked' as const };
      recovery.lookupChecks = Math.min(DAVO_PUBLICATION_LOOKUP_LIMIT, recovery.lookupChecks + 1);
      // keep bounded lookups quiet before exhaustion
      if (recovery.lookupChecks < DAVO_PUBLICATION_LOOKUP_LIMIT) return { status: 'blocked' as const };
      recovery.mode = 'choice';
      installContinuationChoice(state, request, 'publication-unknown', this.now().toISOString());
      return { status: 'choice' as const };
    });
  }

  // record one quiet operational block
  private async block(requestId: string): Promise<DavoCoordinatorResult> {
    await this.store.transact(state => {
      const request = requestFrom(state, requestId);
      // ignore expiry cleanup
      if (request === undefined) return;
      request.state = 'operational-blocked';
      request.revision += 1;
      request.attention = { kind: 'operational_blocked', code: 'davo_provider_unavailable' };
      request.lastSafeError = { code: 'davo_provider_unavailable' };
      appendStatus(state, request, 'Follow-up is temporarily unavailable.', `blocked-${request.revision}`, this.now().toISOString());
    });
    return { status: 'blocked' };
  }

  // accept one exact correlated lifecycle receipt
  async acceptLifecycle(receipt: DavoLifecycleReceipt): Promise<DavoCoordinatorResult> {
    const snapshot = await this.store.read();
    const request = requestFrom(snapshot, receipt.requestId);
    // reject late or unrelated receipts
    if (request === undefined || request.state === 'done') return request?.state === 'done' ? { status: 'done' } : { status: 'expired' };
    const parsedQuestion = receipt.question === undefined ? undefined : davoRemoteQuestionSchema.safeParse(receipt.question);
    // reject oversized, unsafe, or state-inconsistent lifecycle content
    if ((receipt.safeExcerpt !== undefined && (!isSafeDavoText(receipt.safeExcerpt) || utf8Bytes(receipt.safeExcerpt) > 8_192))
      || (receipt.state === 'question' && parsedQuestion?.success !== true)
      || (receipt.state !== 'question' && receipt.question !== undefined)) return this.block(request.id);
    // require the exact durable correlation
    if (request.revision !== receipt.requestRevision
      || request.admittedGeneration !== receipt.generation
      || request.targetActivityEpoch !== receipt.targetActivityEpoch
      || request.dispatch.state !== 'published'
      || request.dispatch.operationId !== receipt.operationId
      || request.dispatch.promptId !== receipt.promptId) return { status: 'stale' };
    const frontier = await this.activity.read(request.instanceQualifiedTarget);
    // make unrelated work an explicit choice
    if (!currentChain(request, frontier)) return this.choice(request.id, 'target-chain-diverged');
    // preserve exact Agent questions without answering
    if (receipt.state === 'question' && parsedQuestion?.success === true) {
      const question = parsedQuestion.data;
      await this.store.transact(state => {
        const stored = requestFrom(state, request.id);
        // require the same receipt revision
        if (stored === undefined || stored.revision !== receipt.requestRevision) return;
        stored.state = 'awaiting-choice';
        stored.revision += 1;
        stored.attention = { kind: 'agent_question', questionId: question.questionId, question: question.question, agentProcessGeneration: question.agentProcessGeneration, targetActivityEpoch: receipt.targetActivityEpoch, answerShape: question.answerShape, ...(question.choices === undefined ? {} : { choices: question.choices }) };
        const now = this.now().toISOString();
        appendStatus(state, stored, 'The Agent needs your answer.', `agent-question-${question.questionId}`, now);
        const eventId = `davo-agent-question-${question.questionId}`;
        state.notificationOutbox.push({ id: randomUUID(), requestId: stored.id, kind: 'choice', tag: `davo-${stored.id}-choice`, state: 'ready', eventId, attempts: 0, createdAt: now });
        stored.notification = { eventId, outcome: 'choice', revision: stored.revision };
      });
      return { status: 'choice' };
    }
    const safeExcerpt = receipt.safeExcerpt === undefined ? undefined : redactIntegrationText(receipt.safeExcerpt);
    const validEnvelope = receipt.completionEnvelope === undefined ? undefined : sanitizeDavoCompletion(receipt.completionEnvelope);
    const now = this.now();
    const hourAgo = now.getTime() - 60 * 60 * 1000;
    const prepared = await this.store.transact(state => {
      const stored = requestFrom(state, request.id);
      // linearize one evaluation
      if (stored === undefined || stored.revision !== receipt.requestRevision || stored.state !== 'awaiting-agent') return undefined;
      stored.coordination.evaluationTimestamps = stored.coordination.evaluationTimestamps.filter(value => Date.parse(value) > hourAgo);
      // enforce the rolling evaluation budget
      if (stored.coordination.evaluationTimestamps.length >= DAVO_EVALUATIONS_PER_HOUR) return false;
      stored.coordination.evaluationTimestamps.push(now.toISOString());
      stored.state = 'evaluating';
      stored.revision += 1;
      return { revision: stored.revision, original: originalText(state, stored) };
    });
    // reject a duplicate concurrent evaluation
    if (prepared === undefined) return { status: 'stale' };
    // expose deterministic budget exhaustion as a choice
    if (prepared === false) return this.choice(request.id, 'followup-budget');
    let recommendation: DavoEvaluatorRecommendation;
    try {
      const evaluated = await this.evaluator.evaluate({ requestId: request.id, requestRevision: prepared.revision, generation: request.admittedGeneration, promptId: receipt.promptId, originalRequest: prepared.original ?? '', criteria: request.criteria, envelope: validEnvelope, safeExcerpt });
      const parsed = evaluatorRecommendationSchema.safeParse({
        ...evaluated,
        unmetCriterionIds: evaluated.unmetCriterionIds.map(redactIntegrationText),
        contradictions: evaluated.contradictions.map(redactIntegrationText),
        safeSummary: redactIntegrationText(evaluated.safeSummary)
      });
      // fail closed on invalid advisory output
      if (!parsed.success) return this.block(request.id);
      recommendation = parsed.data;
    } catch {
      return this.block(request.id);
    }
    const after = await this.store.read();
    const current = requestFrom(after, request.id);
    // reject evaluation after sweep or competing mutation
    if (current === undefined || current.revision !== prepared.revision || current.admittedGeneration !== after.retention.generation) return { status: 'stale' };
    const currentFrontier = await this.activity.read(current.instanceQualifiedTarget);
    // recheck the chain after asynchronous evaluation
    if (!currentChain(current, currentFrontier)) return this.choice(current.id, 'target-chain-diverged');
    // authorize done from deterministic evidence only
    if (deterministicCompletion(current, validEnvelope)
      && validEnvelope!.promptId === receipt.promptId
      && recommendation.recommendation === 'candidate_done'
      && recommendation.unmetCriterionIds.length === 0
      && recommendation.contradictions.length === 0) {
      await this.store.transact(state => {
        const stored = requestFrom(state, current.id);
        // terminalize once under the evaluation revision
        if (stored === undefined || stored.revision !== prepared.revision || stored.state !== 'evaluating') return;
        stored.state = 'done';
        stored.revision += 1;
        stored.terminalEvidence = { kind: 'completion', envelope: validEnvelope!, evaluatedAt: this.now().toISOString() };
        stored.evaluation = { generation: stored.admittedGeneration, promptId: receipt.promptId, providerTurnId: `evaluation-${stored.revision}`, result: recommendation.recommendation, criterionIds: recommendation.unmetCriterionIds, contradictions: recommendation.contradictions, safeExcerpt };
        appendDone(state, stored, recommendation.safeSummary === '' ? 'Your request is complete.' : recommendation.safeSummary, this.now().toISOString());
      });
      return { status: 'done' };
    }
    await this.store.transact(state => {
      const stored = requestFrom(state, current.id);
      // retain bounded advisory data for an explicit budget choice
      if (stored === undefined || stored.revision !== current.revision) return;
      stored.evaluation = {
        generation: stored.admittedGeneration,
        promptId: receipt.promptId,
        providerTurnId: `evaluation-${stored.revision}`,
        result: recommendation.recommendation,
        criterionIds: recommendation.unmetCriterionIds,
        contradictions: recommendation.contradictions,
        safeExcerpt
      };
    });
    const allowedRounds = DAVO_AUTOMATIC_FOLLOWUP_ROUNDS + current.coordination.extraAuthorizedBatches * DAVO_AUTOMATIC_FOLLOWUP_ROUNDS;
    // request a real choice after bounded automatic rounds
    if (current.coordination.followupCycles >= allowedRounds) return this.choice(current.id, 'followup-budget');
    const original = originalText(after, current);
    // fail closed without the immutable original
    if (original === undefined) return { status: 'expired' };
    const cycle = current.coordination.followupCycles + 1;
    const operationId = `${current.id}-followup-${cycle}`;
    const followup = renderFollowup(original, current, validEnvelope, recommendation, safeExcerpt, cycle);
    const payload = followup.rendered;
    const payloadDigest = continuationPayloadDigest(payload);
    // enforce the cumulative executable budget
    if (current.coordination.cumulativeFollowupBytes + utf8Bytes(payload) > DAVO_CUMULATIVE_FOLLOWUP_MAX_BYTES * (current.coordination.extraAuthorizedBatches + 1)) return this.choice(current.id, 'followup-budget');
    const followupPrepared = await this.prepareFollowup(current.id, current.revision, operationId, payloadDigest, utf8Bytes(payload));
    // stop before effects when the evaluation revision changed
    if (!followupPrepared) return { status: 'stale' };
    const result = await this.continuation.publish({ requestId: current.id, expectedRevision: current.revision, operationId, kind: 'followup', payload, payloadDigest, canonicalPayload: followup.canonicalPayload });
    // convert chain drift into one explicit choice
    if (result.status === 'diverged') return this.choice(current.id, 'target-chain-diverged');
    // keep uncertain publication quiet
    if (result.status === 'unknown') return this.markPublicationUnknown(current.id, operationId);
    if (result.status !== 'published') return result.status === 'expired' ? { status: 'expired' } : this.block(current.id);
    const publishedFrontier = result.activity ?? await this.activity.read(current.instanceQualifiedTarget);
    // require proof of the newly published chain head
    if (publishedFrontier === undefined || publishedFrontier.pendingExternalMutation !== undefined || publishedFrontier.chainHeadPromptId !== result.promptId) return this.choice(current.id, 'target-chain-diverged');
    const finished = await this.finishFollowup(current.id, operationId, result.promptId, publishedFrontier);
    // a concurrent cutoff cannot claim publication completion
    if (!finished) return { status: 'stale' };
    return { status: 'continued', promptId: result.promptId };
  }

  // apply one explicit listed davo choice
  async answerChoice(input: DavoAnswerChoiceInput, guard?: () => boolean): Promise<DavoCoordinatorResult> {
    const snapshot = await this.store.read();
    const request = requestFrom(snapshot, input.requestId);
    // reject expired or replaced choices
    if (request === undefined || request.admittedGeneration !== input.generation) return { status: 'expired' };
    const attention = request.attention;
    // keep agent questions on their separate relay path
    if (attention === undefined || attention.kind !== 'davo_continuation_choice' || attention.choiceId !== input.choiceId || !attention.options.includes(input.option as never)) return { status: 'stale' };
    // stop or wait only after explicit selection
    if (input.option === 'stop-followup' || input.option === 'wait-for-evidence') {
      const consumed = await this.store.transact(state => {
        const stored = requestFrom(state, input.requestId);
        // consume only the exact current choice
        if (stored?.attention?.kind !== 'davo_continuation_choice' || stored.attention.choiceId !== input.choiceId) return false;
        // revalidate the exact live capability at choice consumption
        if (guard !== undefined && !guard()) return false;
        const publicationChoice = stored.attention.reason === 'publication-unknown';
        retireChoiceNotification(state, stored);
        // preserve the explicit wait or stop decision across restart
        if (publicationChoice && stored.coordination.publicationRecovery?.operationId === stored.dispatch.operationId) stored.coordination.publicationRecovery.mode = input.option === 'wait-for-evidence' ? 'waiting' : 'stopped';
        stored.state = 'operational-blocked';
        stored.revision += 1;
        stored.lastSafeError = { code: publicationChoice || input.option === 'wait-for-evidence' ? 'davo_publication_unknown' : stored.attention.reason === 'target-chain-diverged' ? 'davo_target_chain_changed' : 'davo_followup_budget' };
        stored.attention = { kind: 'operational_blocked', code: stored.lastSafeError.code };
        appendStatus(state, stored, input.option === 'wait-for-evidence' ? 'Waiting for exact publication evidence.' : 'Davo follow-up stopped.', `choice-answer-${input.choiceId}`, this.now().toISOString());
        return true;
      });
      // stale live authority cannot consume the choice
      if (!consumed) return { status: 'stale' };
      return { status: 'blocked' };
    }
    const frontier = input.frontier ?? await this.activity.read(request.instanceQualifiedTarget);
    // require a stable exact target before resuming
    if (frontier === undefined || frontier.pendingExternalMutation !== undefined || frontier.instanceId !== request.instanceQualifiedTarget.instanceId || frontier.agentId !== request.instanceQualifiedTarget.agentId) return { status: 'stale' };
    const prepared = await this.store.transact(state => {
      const stored = requestFrom(state, input.requestId);
      // consume only the exact current choice under the generation fence
      if (stored?.attention?.kind !== 'davo_continuation_choice' || stored.attention.choiceId !== input.choiceId || stored.admittedGeneration !== state.retention.generation) return undefined;
      // revalidate the exact live capability before adding consent
      if (guard !== undefined && !guard()) return undefined;
      // replace drifted budget consent atomically without rebinding
      if (input.option === 'authorize-one-more-batch' && !currentChain(stored, frontier)) {
        installContinuationChoice(state, stored, 'target-chain-diverged', this.now().toISOString());
        return { kind: 'diverged' as const };
      }
      // authorize only the requested bounded batch
      if (input.option === 'authorize-one-more-batch') stored.coordination.extraAuthorizedBatches += 1;
      stored.targetActivityEpoch = activityEpoch(frontier);
      stored.expectedPromptChainHead = frontier.chainHeadPromptId;
      stored.instanceQualifiedTarget.targetActivityEpoch = stored.targetActivityEpoch;
      stored.instanceQualifiedTarget.expectedPromptChainHead = stored.expectedPromptChainHead;
      stored.instanceQualifiedTarget.processGeneration = frontier.processGeneration;
      stored.instanceQualifiedTarget.conversationId = frontier.conversationId;
      retireChoiceNotification(state, stored);
      stored.attention = undefined;
      stored.state = 'evaluating';
      stored.revision += 1;
      return { kind: 'prepared' as const, request: structuredClone(stored), original: originalText(state, stored) };
    });
    // reject a concurrent answer or missing original
    if (prepared === undefined) return { status: 'stale' };
    // expose the atomically replaced choice without publishing
    if (prepared.kind === 'diverged') return { status: 'choice' };
    if (prepared.original === undefined) return { status: 'stale' };
    const recommendation: DavoEvaluatorRecommendation = {
      recommendation: 'continue',
      unmetCriterionIds: prepared.request.evaluation?.criterionIds ?? prepared.request.criteria.map(criterion => criterion.id),
      contradictions: prepared.request.evaluation?.contradictions ?? [],
      safeSummary: ''
    };
    const cycle = prepared.request.coordination.followupCycles + 1;
    const operationId = `${prepared.request.id}-followup-${cycle}`;
    const followup = renderFollowup(prepared.original, prepared.request, undefined, recommendation, prepared.request.evaluation?.safeExcerpt, cycle);
    const payload = followup.rendered;
    const payloadDigest = continuationPayloadDigest(payload);
    const followupPrepared = await this.prepareFollowup(prepared.request.id, prepared.request.revision, operationId, payloadDigest, utf8Bytes(payload));
    // stale explicit consent cannot cross the effect boundary
    if (!followupPrepared) return { status: 'stale' };
    const result = await this.continuation.publish({ requestId: prepared.request.id, expectedRevision: prepared.request.revision, operationId, kind: 'followup', payload, payloadDigest, canonicalPayload: followup.canonicalPayload });
    // preserve uncertainty without replay
    if (result.status === 'unknown') return this.markPublicationUnknown(prepared.request.id, operationId);
    if (result.status !== 'published') return result.status === 'diverged' ? this.choice(prepared.request.id, 'target-chain-diverged') : result.status === 'expired' ? { status: 'expired' } : this.block(prepared.request.id);
    const publishedFrontier = result.activity ?? await this.activity.read(prepared.request.instanceQualifiedTarget);
    // require exact new head evidence
    if (publishedFrontier === undefined || publishedFrontier.pendingExternalMutation !== undefined || publishedFrontier.chainHeadPromptId !== result.promptId) return this.choice(prepared.request.id, 'target-chain-diverged');
    const finished = await this.finishFollowup(prepared.request.id, operationId, result.promptId, publishedFrontier);
    // a concurrent cutoff cannot claim publication completion
    if (!finished) return { status: 'stale' };
    return { status: 'continued', promptId: result.promptId };
  }

  // reconcile one uncertain request without republishing
  async reconcile(requestId: string): Promise<DavoContinuationResult | DavoCoordinatorResult | { status: 'absent' }> {
    const snapshot = await this.store.read();
    const request = requestFrom(snapshot, requestId);
    // stop after expiry cleanup
    if (request === undefined) return { status: 'absent' };
    const recovery = request.coordination.publicationRecovery;
    // reconcile only exact publication evidence after ambiguity
    if (recovery !== undefined) {
      if (recovery.mode === 'choice') return { status: 'choice' };
      if (recovery.mode === 'stopped') return { status: 'blocked' };
      const result = this.continuation.lookup === undefined ? { status: 'unknown' as const } : await this.continuation.lookup(request.id, recovery.operationId);
      // keep every nonterminal lookup bounded and never republish
      if (result.status !== 'published') return this.recordUnknownLookup(request.id, recovery.operationId);
      const operation = snapshot.operations.find(candidate => candidate.requestId === request.id && candidate.operationId === recovery.operationId);
      // initial publication is bound by the bridge with a fresh activity read
      if (operation?.kind !== 'followup') return result;
      const publishedFrontier = result.activity ?? await this.activity.read(request.instanceQualifiedTarget);
      // exact followup proof still requires the new stable chain head
      if (publishedFrontier === undefined || publishedFrontier.pendingExternalMutation !== undefined || publishedFrontier.chainHeadPromptId !== result.promptId) return this.recordUnknownLookup(request.id, recovery.operationId);
      const finished = await this.finishFollowup(request.id, recovery.operationId, result.promptId, publishedFrontier);
      return finished ? { status: 'continued', promptId: result.promptId } : { status: 'stale' };
    }
    // recover an evaluating request by its exact publication phase
    if (request.state === 'evaluating') {
      const dispatchFollowup = request.dispatch.state === 'published' && this.followupCycle(request, request.dispatch.operationId) !== undefined ? request.dispatch.operationId : undefined;
      const operationId = request.coordination.activeOperationId ?? dispatchFollowup;
      const operation = operationId === undefined ? undefined : snapshot.operations.find(candidate => candidate.operationId === operationId && candidate.requestId === request.id && candidate.kind === 'followup');
      // reconcile only an operation that may have crossed the effect boundary
      if (operation !== undefined && operation.state !== 'prepared') {
        // exact lookup is mandatory after a possible publication
        if (this.continuation.lookup === undefined) return { status: 'unknown' };
        const result = await this.continuation.lookup(request.id, operation.operationId);
        // preserve uncertainty without republishing
        if (result.status !== 'published') return result.status === 'diverged' ? this.choice(request.id, 'target-chain-diverged') : result;
        const publishedFrontier = result.activity ?? await this.activity.read(request.instanceQualifiedTarget);
        // bind only the exact newly published chain head
        if (publishedFrontier === undefined || publishedFrontier.pendingExternalMutation !== undefined || publishedFrontier.chainHeadPromptId !== result.promptId) return this.choice(request.id, 'target-chain-diverged');
        const finished = await this.finishFollowup(request.id, operation.operationId, result.promptId, publishedFrontier);
        return finished ? { status: 'continued', promptId: result.promptId } : { status: 'stale' };
      }
      // prepared or evaluator-only crashes may safely replay exact retained lifecycle evidence
      if (this.lifecycle === undefined) return this.block(request.id);
      const receipt = await this.lifecycle.lookup(request);
      // missing exact evidence cannot authorize reevaluation
      if (receipt === undefined) return this.block(request.id);
      const reset = await this.store.transact(state => {
        const stored = requestFrom(state, request.id);
        // reset only the same evaluator or no-effect prepared phase
        if (stored === undefined || stored.revision !== request.revision || stored.state !== 'evaluating') return false;
        stored.state = 'awaiting-agent';
        stored.coordination.activeOperationId = undefined;
        stored.coordination.activeFollowupBytes = undefined;
        return true;
      });
      // a concurrent recovery owns the exact receipt
      if (!reset) return { status: 'stale' };
      return this.acceptLifecycle(receipt);
    }
    // recover only one exact durable ended lifecycle receipt
    if (request.state === 'awaiting-agent' && this.lifecycle !== undefined) {
      const receipt = await this.lifecycle.lookup(request);
      // leave active work untouched without exact evidence
      if (receipt !== undefined) return this.acceptLifecycle(receipt);
    }
    // return known publications directly
    if (request.dispatch.state === 'published') return { status: 'published', promptId: request.dispatch.promptId };
    // require exact lookup support for uncertainty
    if (this.continuation.lookup === undefined) return { status: 'unknown' };
    return this.continuation.lookup(requestId, request.dispatch.operationId);
  }
}
