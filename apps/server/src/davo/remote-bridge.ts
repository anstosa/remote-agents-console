import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationAuditService } from '../integrations/audit/service.js';
import type { DavoStore } from './store.js';
import type { PromptService } from '../prompts/service.js';
import type { PromptOperationLedger } from '../prompts/operations.js';
import { activityEpoch, continuationPayloadDigest, type DavoActivityFrontierV1, type DavoPromptPublication, type DavoPromptResult } from './continuation.js';
import { davoActivityFrontierSchema, davoCompletionEnvelopeSchema, davoInstanceQualifiedTargetSchema, davoRemoteQuestionAnswerSchema, davoRemoteQuestionSchema, davoTargetSchema, type DavoInstanceQualifiedTargetV1, type DavoRemoteGrantV1, type DavoRemoteQuestionAnswerV1, type DavoRequestV1, type DavoTargetV1 } from './contracts.js';
import { canonicalFollowupPayload, canonicalRequestSeed, canonicalizeDavo, davoFollowupPayloadSchema, davoPromptId, davoQuestionAnswerDigest, davoQuestionAnswerOperationKey, davoRemoteDispatchActionSchema, davoRemoteOperationSchema, DavoRemoteContinuation, digestDavo, renderDavoFollowupV1, renderDavoOriginalV1, signFreshEnvelope, verifyFreshEnvelope, type DavoRemoteDispatchReceiptV1, type DavoRemoteGrantAdmission, type DavoRemoteReceiptBodyV1, type FreshFederationEnvelopeV1 } from './remote.js';
import { expiryForAnchor } from './retention.js';

export type DavoWriteTool = 'delegate_request' | 'relay_agent_question_answer';

type Options = {
  store: DavoStore;
  prompts: PromptService;
  operations: PromptOperationLedger;
  instanceId: string;
  peers: string[];
  secret: string;
  audit: Pick<IntegrationAuditService, 'record'>;
  epoch?: string;
  resolveLocal: (agentId: string, worktreeId: string, expiresAt: string) => Promise<{ target: DavoTargetV1; frontier: DavoActivityFrontierV1 } | undefined>;
  readLocal: (target: DavoTargetV1) => Promise<DavoActivityFrontierV1 | undefined>;
  question?: (target: DavoTargetV1) => Promise<{ id: string; text: string; choices: string[] } | undefined>;
  answerQuestion?: (target: DavoTargetV1, questionId: string, answer: DavoRemoteQuestionAnswerV1) => Promise<boolean>;
  canWrite: (tool: DavoWriteTool) => boolean;
  fetch?: typeof fetch;
};

export type DavoRemoteRelayInput = {
  target: DavoInstanceQualifiedTargetV1;
  principalOwnerHash: string;
  admittedMessageId: string;
  admittedAt: string;
  turnId: string;
  operationId: string;
  questionId: string;
  answer: DavoRemoteQuestionAnswerV1;
};

export type DavoRemoteRelayResult = { answered: true; frontier: DavoActivityFrontierV1 };

const identifier = z.string().min(1).max(1024).refine(value => !value.includes('\0'));
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().safe().nonnegative();
const relayInputSchema = z.object({
  target: davoInstanceQualifiedTargetSchema,
  principalOwnerHash: digest,
  admittedMessageId: identifier,
  admittedAt: instant,
  turnId: identifier,
  operationId: identifier,
  questionId: identifier,
  answer: davoRemoteQuestionAnswerSchema
}).strict();
const activitySchema = davoActivityFrontierSchema;
const probeReceiptSchema = z.object({
  kind: z.literal('target-probe-receipt'), version: z.literal(1), originInstanceId: identifier, destinationInstanceId: identifier,
  target: davoTargetSchema, frontier: activitySchema, targetActivityEpoch: digest, expectedPromptChainHead: identifier,
  processGeneration: revision, conversationId: identifier.optional(), modelId: identifier.optional(), currentDestinationEpoch: identifier, expiresAt: instant
}).strict();
const admissionReceiptSchema = z.object({
  kind: z.literal('grant-admission-receipt'), version: z.literal(1), result: z.literal('admitted'), grantId: identifier,
  immutableGrantDigest: digest, requestSeedDigest: digest, originInstanceId: identifier, destinationInstanceId: identifier,
  destinationEpoch: identifier, grantRevision: z.literal(0), grantExpiresAt: instant
}).strict();
const frontierReceiptSchema = z.object({
  kind: z.literal('frontier-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, destinationEpoch: identifier, grantRevision: revision,
  frontier: activitySchema, targetActivityEpoch: digest, expectedPromptChainHead: identifier, processGeneration: revision,
  conversationId: identifier.optional(), modelId: identifier.optional(), pending: z.boolean(), grantExpiresAt: instant
}).strict();
const rebindReceiptSchema = z.object({
  kind: z.literal('rebind-receipt'), version: z.literal(1), result: z.enum(['rebound', 'rebind_required']), grantId: identifier,
  immutableGrantDigest: digest, originInstanceId: identifier, destinationInstanceId: identifier, requestedDestinationEpoch: identifier,
  resultDestinationEpoch: identifier, expectedGrantRevision: revision, resultGrantRevision: revision, grantExpiresAt: instant
}).strict();
const promptReceiptSchema = z.object({
  kind: z.literal('prompt-operation-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, operationId: identifier, payloadDigest: digest,
  result: z.enum(['published', 'unknown']), promptId: identifier.optional(), grantExpiresAt: instant
}).strict();
const lifecycleReceiptSchema = z.object({
  kind: z.literal('lifecycle-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, eventId: identifier, operationId: identifier, promptId: identifier,
  state: z.enum(['queued', 'started', 'completed', 'failed', 'question']), completionEnvelope: davoCompletionEnvelopeSchema.optional(),
  safeExcerpt: z.string().max(8192).optional(), question: davoRemoteQuestionSchema.optional(), targetActivityEpoch: digest, grantExpiresAt: instant
}).strict().superRefine((value, context) => {
  // question state requires its strict public descriptor
  if (value.state === 'question' && value.question === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question body required', path: ['question'] });
  // terminal states cannot smuggle question content
  if (value.state !== 'question' && value.question !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question body forbidden', path: ['question'] });
});
const questionAnswerReceiptSchema = z.object({
  kind: z.literal('question-answer-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, destinationEpoch: identifier, grantRevision: revision,
  operationId: identifier, questionId: identifier, payloadDigest: digest, answered: z.literal(true), frontier: activitySchema,
  targetActivityEpoch: digest, grantExpiresAt: instant
}).strict();
const receiptSchema = z.union([probeReceiptSchema, admissionReceiptSchema, frontierReceiptSchema, rebindReceiptSchema, promptReceiptSchema, lifecycleReceiptSchema, questionAnswerReceiptSchema]);

// namespace destination operation keys by configured origin
function remoteOperationKey(originInstanceId: string, operationId: string): string {
  return `davo-remote-${createHash('sha256').update(`${originInstanceId}\0${operationId}`, 'utf8').digest('hex')}`;
}

// connect configured peers through narrow signed continuation messages
export function createDavoRemoteBridge(options: Options) {
  const epoch = options.epoch ?? randomUUID();
  const fetcher = options.fetch ?? fetch;
  const destinations = new Map<string, DavoRemoteContinuation>();
  const seen = new Map<string, number>();

  // intersect every retained authority with the current named permission
  function canWrite(tool: DavoWriteTool): boolean { return options.canWrite(tool); }

  // reject unsigned, oversized, or substituted remote receipts
  async function exchange(destination: string, body: unknown, expiresAt: string): Promise<DavoRemoteDispatchReceiptV1 | DavoRemoteReceiptBodyV1> {
    // configuration, not a model-supplied url, owns network destinations
    if (!options.peers.includes(destination)) throw new Error('davo_remote_unavailable');
    const response = await fetcher(new URL('/api/davo/continuation', destination), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signFreshEnvelope(body, { secret: options.secret, audience: destination, grantExpiresAt: expiresAt })), signal: AbortSignal.timeout(5000) });
    // never interpret an unauthenticated status body as a receipt
    if (!response.ok) throw new Error('davo_remote_unavailable');
    const raw = await response.text();
    // bound network parsing independently of peer implementation
    if (Buffer.byteLength(raw) > 96 * 1024) throw new Error('davo_remote_payload_mismatch');
    const envelope = JSON.parse(raw) as FreshFederationEnvelopeV1<DavoRemoteDispatchReceiptV1 | DavoRemoteReceiptBodyV1>;
    const verified = verifyFreshEnvelope(envelope, { secret: options.secret, audience: options.instanceId });
    const parsed = receiptSchema.safeParse(verified);
    // reject unknown versions, fields, and receipt discriminants
    if (!parsed.success) throw new Error('davo_remote_payload_mismatch');
    const result = parsed.data as DavoRemoteDispatchReceiptV1 | DavoRemoteReceiptBodyV1;
    // bind every receipt to this configured exchange
    if (result.originInstanceId !== options.instanceId || result.destinationInstanceId !== destination) throw new Error('davo_remote_payload_mismatch');
    const now = Date.now();
    // discard only elapsed replay windows
    for (const [nonce, until] of seen) { if (until <= now) seen.delete(nonce); }
    // a new signature never extends a logical grant's expiry
    if (seen.has(envelope.transportNonce) || seen.size >= 4096) throw new Error('davo_remote_unavailable');
    seen.set(envelope.transportNonce, Date.parse(envelope.transportExpiresAt));
    return result;
  }

  // discover the canonical destination target before creating any execution grant
  async function probe(destination: string, agentId: string, worktreeId: string, expiresAt: string) {
    const result = await exchange(destination, { kind: 'probe-target', originInstanceId: options.instanceId, destinationInstanceId: destination, agentId, worktreeId, expiresAt, sourceScopeSnapshot: ['status:read', 'prompts:write'] }, expiresAt);
    // require exact canonical identity and signed activity bytes
    if (result.kind !== 'target-probe-receipt'
      || result.originInstanceId !== options.instanceId
      || result.destinationInstanceId !== destination
      || result.target.agentId !== agentId
      || result.target.worktreeId !== worktreeId
      || result.expiresAt !== expiresAt
      || result.currentDestinationEpoch === ''
      || result.expectedPromptChainHead !== result.frontier.chainHeadPromptId
      || result.processGeneration !== result.frontier.processGeneration
      || activityEpoch(result.frontier) !== result.targetActivityEpoch) throw new Error('davo_remote_payload_mismatch');
    davoTargetSchema.parse(result.target);
    return result;
  }

  // refresh only the mutable startup binding with exact revision cas
  async function bound(grant: DavoRemoteGrantV1): Promise<DavoRemoteGrantV1> {
    const discovered = await probe(grant.destinationInstanceId, grant.target.agentId, grant.target.worktreeId, grant.expiresAt);
    // retain an already current binding
    if (discovered.currentDestinationEpoch === grant.destinationEpoch) return grant;
    let expectedRevision = grant.grantRevision;
    let result: z.infer<typeof rebindReceiptSchema> | undefined;
    // resolve at most one documented revision refresh before the exact cas
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const receipt = await exchange(grant.destinationInstanceId, { kind: 'resume-grant', grantId: grant.grantId, immutableGrantDigest: grant.immutableGrantDigest, originInstanceId: grant.originInstanceId, destinationInstanceId: grant.destinationInstanceId, currentDestinationEpoch: discovered.currentDestinationEpoch, expectedGrantRevision: expectedRevision }, grant.expiresAt);
      // reject cross-grant or substituted rebind bodies
      if (receipt.kind !== 'rebind-receipt' || receipt.grantId !== grant.grantId || receipt.immutableGrantDigest !== grant.immutableGrantDigest || receipt.expectedGrantRevision !== expectedRevision || receipt.grantExpiresAt !== grant.expiresAt) throw new Error('davo_remote_rebind_conflict');
      result = receipt;
      // stop only on an exact current-epoch cas
      if (receipt.result === 'rebound' && receipt.resultDestinationEpoch === discovered.currentDestinationEpoch) break;
      // continue once with the destination-attested current revision
      if (receipt.result !== 'rebind_required' || receipt.resultGrantRevision < expectedRevision) throw new Error('davo_remote_rebind_conflict');
      expectedRevision = receipt.resultGrantRevision;
    }
    // require one final exact rebind
    if (result === undefined || result.result !== 'rebound' || result.resultDestinationEpoch !== discovered.currentDestinationEpoch) throw new Error('davo_remote_rebind_conflict');
    return await options.store.transact(state => {
      const stored = state.remoteGrants.find(candidate => candidate.grantId === grant.grantId);
      // persist only an exact eligible origin-side cas result
      if (stored === undefined || stored.immutableGrantDigest !== grant.immutableGrantDigest || stored.grantRevision !== grant.grantRevision || Date.now() >= Date.parse(stored.expiresAt)) throw new Error('davo_remote_rebind_conflict');
      stored.destinationEpoch = result.resultDestinationEpoch;
      stored.grantRevision = result.resultGrantRevision;
      stored.rebindReceiptBodies.push({ bodyDigest: digestDavo(canonicalizeDavo(result)), body: result });
      return stored;
    });
  }

  // locate one immutable origin-side grant for the exact request
  async function grantForRequest(request: DavoRequestV1): Promise<DavoRemoteGrantV1> {
    // local revocation applies to retained and newly admitted grants
    if (!canWrite('delegate_request')) throw new Error('davo_remote_unavailable');
    const state = await options.store.read();
    const existing = state.remoteGrants.find(grant => grant.originInstanceId === options.instanceId && grant.requestId === request.id);
    // resume persisted grants without creating a new authority
    if (existing !== undefined) return await bound(existing);
    const message = state.messages.find(row => row.id === request.originalMessageId && row.kind === 'user');
    // no expired or detached request can mint a remote grant
    if (message === undefined) throw new Error('davo_expired');
    const destination = request.instanceQualifiedTarget.instanceId;
    const discovered = await probe(destination, request.instanceQualifiedTarget.agentId, request.instanceQualifiedTarget.worktreeId, request.principal.expiresAt);
    // preserve the exact target selected in the admitted utterance
    if (discovered.targetActivityEpoch !== request.targetActivityEpoch || discovered.expectedPromptChainHead !== request.expectedPromptChainHead) throw new Error('davo_target_chain_changed');
    const { instanceId: _destination, ...target } = request.instanceQualifiedTarget;
    const grantId = `grant-${createHash('sha256').update(`${options.instanceId}\0${destination}\0${request.id}`, 'utf8').digest('hex').slice(0, 48)}`;
    const admission: DavoRemoteGrantAdmission = { grantId, originInstanceId: options.instanceId, destinationInstanceId: destination, requestId: request.id, principalOwnerHash: request.principal.principalOwnerHash, sourceScopeSnapshot: ['status:read', 'prompts:write'], originalRequestedAt: request.originalRequestedAt, expiresAt: request.principal.expiresAt, target, targetActivityEpoch: request.targetActivityEpoch, expectedPromptChainHead: request.expectedPromptChainHead, rights: request.principal.rights, requestSeed: { version: 1, requestId: request.id, originalRequest: message.text, criterionSetVersion: 1, criteria: request.criteria, requiredChecks: request.requiredChecks }, destinationEpoch: discovered.currentDestinationEpoch };
    const result = await exchange(destination, { kind: 'admit-grant', grant: admission }, admission.expiresAt);
    const seedDigest = digestDavo(canonicalRequestSeed(admission.requestSeed));
    // bind admission receipt to the exact seed and original expiry
    if (result.kind !== 'grant-admission-receipt'
      || result.originInstanceId !== options.instanceId
      || result.destinationInstanceId !== destination
      || result.grantId !== admission.grantId
      || result.requestSeedDigest !== seedDigest
      || result.grantExpiresAt !== admission.expiresAt
      || result.destinationEpoch !== admission.destinationEpoch
      || result.grantRevision !== 0) throw new Error('davo_remote_payload_mismatch');
    return await options.store.transact(draft => {
      const current = draft.requests.find(candidate => candidate.id === request.id);
      // reject late admission after a cutoff or request replacement
      if (current === undefined || current.admittedGeneration !== draft.retention.generation) throw new Error('davo_generation_changed');
      const stored = draft.remoteGrants.find(candidate => candidate.grantId === admission.grantId);
      // exact admission retries never create duplicate grant rows
      if (stored !== undefined) { if (stored.immutableGrantDigest !== result.immutableGrantDigest) throw new Error('davo_remote_payload_mismatch'); return stored; }
      const grant: DavoRemoteGrantV1 = { ...admission, grantVersion: 1, immutableGrantDigest: result.immutableGrantDigest, requestSeedDigest: seedDigest, grantRevision: 0, state: 'active', rebindReceiptBodies: [], operationReceiptBodies: [], lifecycleReceiptBodies: [] };
      draft.remoteGrants.push(grant);
      return grant;
    });
  }

  // publish destination work through the same generic exact-operation serializer
  async function publishDestination(originInstanceId: string, input: Parameters<NonNullable<ConstructorParameters<typeof DavoRemoteContinuation>[0]['prompts']['publish']>>[0]) {
    // revoked deployment policy stops before prompt preparation
    if (!canWrite('delegate_request')) return { status: 'unknown' as const };
    const before = await options.readLocal(input.target);
    // canonical signed chain evidence must still be current at the destination
    if (before === undefined || before.pendingExternalMutation !== undefined || activityEpoch(before) !== input.targetActivityEpoch || before.chainHeadPromptId !== input.expectedPromptChainHead) return { status: 'unknown' as const };
    const operationKey = remoteOperationKey(originInstanceId, input.operationId);
    const result = await options.prompts.publishOperation({ operationKey, promptId: input.promptId, agentId: input.target.agentId, canonicalDestination: options.instanceId, payloadDigest: input.payloadDigest, targetDigest: digestDavo(canonicalizeDavo(input.target)), generation: (await options.store.read()).retention.generation, davoRequestId: input.requestId, expiresAt: input.expiresAt, expectedActivityEpoch: before.promptActivityRevision, text: input.payload }, async () => {
      const state = await options.store.read();
      const grant = state.remoteGrants.find(row => row.originInstanceId === originInstanceId && row.destinationInstanceId === options.instanceId && row.requestId === input.requestId && row.state === 'active');
      const observed = await options.readLocal(input.target);
      return canWrite('delegate_request') && grant !== undefined && grant.destinationEpoch === epoch && Date.now() < Date.parse(grant.expiresAt) && observed?.processGeneration === input.target.processGeneration && observed.conversationId === input.target.conversationId;
    });
    return result.kind === 'published' ? { status: 'published' as const, promptId: result.operation.promptId } : { status: 'unknown' as const };
  }

  // create one destination authority per configured peer identity
  for (const peer of options.peers) {
    // expose question mutation only when both local ports exist
    const questions = options.question === undefined || options.answerQuestion === undefined ? {} : { questions: { read: options.question, answer: async (target: DavoTargetV1, questionId: string, answer: DavoRemoteQuestionAnswerV1) => {
      // revoked deployment policy stops before the agent mutation
      if (!canWrite('relay_agent_question_answer')) return false;
      return await options.answerQuestion!(target, questionId, answer);
    } } };
    destinations.set(peer, new DavoRemoteContinuation({ store: options.store, secret: options.secret, originInstanceId: peer, destinationInstanceId: options.instanceId, currentEpoch: () => epoch, activity: { read: options.readLocal }, ...questions, audit: {
      // map internal payload-free events into the shared append-only audit
      record: async event => {
        const tool = event.kind === 'remote-question-answer' ? 'relay_agent_question_answer' : 'delegate_request';
        // dynamic write revocation wins before any intent record or effect
        if (event.phase === 'intent' && !canWrite(tool)) return false;
        try {
          await options.audit.record({ phase: event.phase, timestamp: event.time, durationMs: 0, correlationId: event.operationId, principalHash: createHash('sha256').update(event.originInstanceId, 'utf8').digest('hex'), clientId: 'davo-remote', tool: event.kind, scopes: ['status:read', 'prompts:write'], risk: 'write', argumentsDigest: event.payloadDigest, result: event.result });
          return true;
        } catch {
          return false;
        }
      }
    }, admission: {
      // probes resolve only configured ordinary rac worktree targets
      probe: async input => { const resolved = await options.resolveLocal(input.agentId, input.worktreeId, input.expiresAt); return resolved === undefined ? { ok: false } : { ok: true, ...resolved }; },
      // admission repeats the destination's canonical place/process check
      authorize: async grant => {
        // revoked deployment policy cannot admit a continuation grant
        if (!canWrite('delegate_request')) return { ok: false };
        const resolved = await options.resolveLocal(grant.target.agentId, grant.target.worktreeId, grant.expiresAt);
        return resolved === undefined || canonicalizeDavo(resolved.target) !== canonicalizeDavo(grant.target) ? { ok: false } : { ok: true, ...resolved };
      }
    }, prompts: { publish: input => publishDestination(peer, input), lookup: async operationId => { const operation = await options.prompts.lookupOperation(remoteOperationKey(peer, operationId)); return operation?.state === 'published' ? { status: 'published', promptId: operation.promptId } : { status: 'unknown' }; } } }));
  }

  // relay one newly admitted live answer through distinct signed authority
  async function relay(input: DavoRemoteRelayInput): Promise<DavoRemoteRelayResult> {
    const parsed = relayInputSchema.parse(input);
    // revoked deployment policy stops before signed remote mutation
    if (!canWrite('relay_agent_question_answer')) throw new Error('davo_remote_unavailable');
    const now = Date.now();
    const admittedAt = Date.parse(parsed.admittedAt);
    // live assertions expire independently of the retained request
    if (!Number.isFinite(admittedAt) || admittedAt > now || now - admittedAt > 30_000) throw new Error('davo_turn_changed');
    const state = await options.store.read();
    const message = state.messages.find(candidate => candidate.id === parsed.admittedMessageId && candidate.kind === 'user');
    // require the exact current retained user admission at the origin
    if (message === undefined || message.createdAt !== parsed.admittedAt || message.generation !== state.retention.generation) throw new Error('davo_generation_changed');
    const request = state.requests.find(candidate => candidate.attention?.kind === 'agent_question'
      && candidate.attention.questionId === parsed.questionId
      && candidate.principal.principalOwnerHash === parsed.principalOwnerHash
      && canonicalizeDavo(candidate.instanceQualifiedTarget) === canonicalizeDavo(parsed.target));
    // a background grant without a current owned question cannot answer
    if (request === undefined) throw new Error('davo_question_changed');
    const existingGrant = state.remoteGrants.find(candidate => candidate.originInstanceId === options.instanceId
      && candidate.destinationInstanceId === parsed.target.instanceId
      && candidate.requestId === request.id
      && candidate.principalOwnerHash === parsed.principalOwnerHash
      && candidate.state === 'active');
    // no continuation grant can be inferred from target identity alone
    if (existingGrant === undefined) throw new Error('davo_question_changed');
    const grant = await bound(existingGrant);
    const { instanceId: _destination, ...canonicalTarget } = parsed.target;
    const semantic = {
      grantId: grant.grantId,
      canonicalTarget,
      principalOwnerHash: parsed.principalOwnerHash,
      admittedMessageId: parsed.admittedMessageId,
      admittedAt: parsed.admittedAt,
      turnId: parsed.turnId,
      operationId: parsed.operationId,
      questionId: parsed.questionId,
      answer: parsed.answer
    };
    const payloadDigest = davoQuestionAnswerDigest(semantic);
    const operationKey = davoQuestionAnswerOperationKey(options.instanceId, grant.destinationInstanceId, parsed.operationId);
    const prepared = await options.store.transact(draft => {
      const storedGrant = draft.remoteGrants.find(candidate => candidate.grantId === grant.grantId);
      const storedMessage = draft.messages.find(candidate => candidate.id === parsed.admittedMessageId && candidate.kind === 'user');
      const storedRequest = draft.requests.find(candidate => candidate.id === request.id);
      // recheck owner, live message, question, grant, and generation under lock
      if (storedGrant === undefined
        || storedMessage?.createdAt !== parsed.admittedAt
        || storedMessage.generation !== draft.retention.generation
        || storedRequest?.attention?.kind !== 'agent_question'
        || storedRequest.attention.questionId !== parsed.questionId
        || storedRequest.principal.principalOwnerHash !== parsed.principalOwnerHash
        || storedGrant.principalOwnerHash !== parsed.principalOwnerHash
        || storedGrant.destinationEpoch !== grant.destinationEpoch
        || storedGrant.grantRevision !== grant.grantRevision
        || Date.now() >= Date.parse(storedGrant.expiresAt)) throw new Error('davo_question_changed');
      const receipt = storedGrant.operationReceiptBodies.find(candidate => candidate.body.kind === 'question-answer-receipt' && candidate.body.operationId === parsed.operationId);
      // replay one exact durable answer result
      if (receipt !== undefined && receipt.body.kind === 'question-answer-receipt') {
        // changed answer bytes cannot reuse the operation id
        if (receipt.body.payloadDigest !== payloadDigest) throw new Error('davo_capability_replay');
        return { mode: 'receipt' as const, body: receipt.body };
      }
      const operation = draft.operations.find(candidate => candidate.operationId === operationKey);
      // one-use operation ids bind the original exact answer
      if (operation !== undefined && (operation.requestId !== request.id || operation.payloadDigest !== payloadDigest || operation.kind !== 'lifecycle')) throw new Error('davo_capability_replay');
      // an unknown prior send may retry only through destination pending reconciliation
      if (operation !== undefined) return { mode: 'exchange' as const };
      draft.operations.push({
        operationId: operationKey,
        requestId: request.id,
        destinationInstanceId: grant.destinationInstanceId,
        kind: 'lifecycle',
        generation: draft.retention.generation,
        targetActivityEpoch: canonicalTarget.targetActivityEpoch,
        payloadDigest,
        state: 'publishing',
        createdAt: parsed.admittedAt,
        expiresAt: grant.expiresAt
      });
      return { mode: 'exchange' as const };
    });
    // return a stored result without another remote effect
    if (prepared.mode === 'receipt') return { answered: true, frontier: prepared.body.frontier };
    const action = {
      kind: 'relay-question-answer' as const,
      grantId: grant.grantId,
      destinationEpoch: grant.destinationEpoch,
      grantRevision: grant.grantRevision,
      canonicalTarget,
      principalKind: 'davo-live-question-answer' as const,
      principalOwnerHash: parsed.principalOwnerHash,
      admittedMessageId: parsed.admittedMessageId,
      admittedAt: parsed.admittedAt,
      turnId: parsed.turnId,
      operationId: parsed.operationId,
      questionId: parsed.questionId,
      answer: parsed.answer,
      payloadDigest
    };
    let result: DavoRemoteDispatchReceiptV1 | DavoRemoteReceiptBodyV1;
    try {
      result = await exchange(grant.destinationInstanceId, action, grant.expiresAt);
    } catch (error) {
      await options.store.transact(draft => {
        const operation = draft.operations.find(candidate => candidate.operationId === operationKey && candidate.payloadDigest === payloadDigest);
        // retain uncertainty after a possible send
        if (operation !== undefined && operation.state !== 'published') operation.state = 'unknown';
      });
      throw error;
    }
    // require an exact signed same-grant answer receipt
    if (result.kind !== 'question-answer-receipt'
      || result.grantId !== grant.grantId
      || result.immutableGrantDigest !== grant.immutableGrantDigest
      || result.originInstanceId !== options.instanceId
      || result.destinationInstanceId !== grant.destinationInstanceId
      || result.destinationEpoch !== grant.destinationEpoch
      || result.grantRevision !== grant.grantRevision
      || result.operationId !== parsed.operationId
      || result.questionId !== parsed.questionId
      || result.payloadDigest !== payloadDigest
      || result.grantExpiresAt !== grant.expiresAt
      || !result.answered
      || result.targetActivityEpoch !== activityEpoch(result.frontier)
      || result.frontier.instanceId !== grant.destinationInstanceId
      || result.frontier.agentId !== canonicalTarget.agentId
      || result.frontier.processGeneration !== canonicalTarget.processGeneration
      || result.frontier.conversationId !== canonicalTarget.conversationId
      || result.frontier.chainHeadPromptId !== canonicalTarget.expectedPromptChainHead) throw new Error('davo_remote_payload_mismatch');
    await options.store.transact(draft => {
      const storedGrant = draft.remoteGrants.find(candidate => candidate.grantId === grant.grantId);
      const operation = draft.operations.find(candidate => candidate.operationId === operationKey && candidate.payloadDigest === payloadDigest);
      // late receipt cannot revive an expired grant or swept operation
      if (storedGrant === undefined || operation === undefined || Date.now() >= Date.parse(storedGrant.expiresAt)) throw new Error('davo_expired');
      const receiptDigest = digestDavo(canonicalizeDavo(result));
      // retain one logical receipt body without its transport signature
      if (!storedGrant.operationReceiptBodies.some(candidate => candidate.bodyDigest === receiptDigest)) storedGrant.operationReceiptBodies.push({ bodyDigest: receiptDigest, body: result });
      operation.state = 'published';
    });
    return { answered: true, frontier: result.frontier };
  }

  return {
    probe,
    relay,
    // authenticate configured source selection before dispatching either strict action union
    handle: async (envelope: FreshFederationEnvelopeV1<unknown>) => {
      const body = verifyFreshEnvelope(envelope, { secret: options.secret, audience: options.instanceId });
      // grant identity is routing data until the selected authority revalidates it
      const parsed = davoRemoteDispatchActionSchema.safeParse(body);
      const operation = davoRemoteOperationSchema.safeParse(body);
      // reject every unrecognized signed action before store lookup
      if (!parsed.success && !operation.success) throw new Error('davo_remote_payload_mismatch');
      // target discovery alone carries no continuation write authority
      if (parsed.success && parsed.data.kind !== 'probe-target') {
        const tool = parsed.data.kind === 'relay-question-answer' ? 'relay_agent_question_answer' : 'delegate_request';
        // signed grants never widen the destination's local named policy
        if (!canWrite(tool)) throw new Error('davo_remote_unavailable');
      }
      // retained continuation operations still require local delegation policy
      if (operation.success && !canWrite('delegate_request')) throw new Error('davo_remote_unavailable');
      const state = await options.store.read();
      const grantId = operation.success ? operation.data.grantId : parsed.success && parsed.data.kind !== 'admit-grant' && parsed.data.kind !== 'probe-target' ? parsed.data.grantId : undefined;
      const origin = parsed.success && parsed.data.kind === 'admit-grant' ? parsed.data.grant.originInstanceId : parsed.success && parsed.data.kind === 'probe-target' ? parsed.data.originInstanceId : state.remoteGrants.find(grant => grant.grantId === grantId && grant.destinationInstanceId === options.instanceId)?.originInstanceId;
      const authority = origin === undefined ? undefined : destinations.get(origin);
      // unconfigured identities never reach grant or prompt storage
      if (authority === undefined) throw new Error('davo_remote_unavailable');
      return parsed.success ? await authority.dispatch(envelope) : await authority.handle(envelope);
    },
    // read signed current activity without trusting an origin-side cached frontier
    read: async (target: DavoInstanceQualifiedTargetV1): Promise<DavoActivityFrontierV1 | undefined> => {
      const state = await options.store.read();
      const request = state.requests.find(row => row.instanceQualifiedTarget.instanceId === target.instanceId && row.instanceQualifiedTarget.agentId === target.agentId && row.expectedPromptChainHead === target.expectedPromptChainHead);
      // initial binding has no grant yet and uses signed canonical discovery
      if (request === undefined) return (await probe(target.instanceId, target.agentId, target.worktreeId, expiryForAnchor(new Date()))).frontier;
      const grant = await grantForRequest(request);
      const result = await exchange(grant.destinationInstanceId, { kind: 'read-frontier', grantId: grant.grantId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision }, grant.expiresAt);
      // reject a substituted or malformed activity receipt
      if (result.kind !== 'frontier-receipt'
        || result.grantId !== grant.grantId
        || result.immutableGrantDigest !== grant.immutableGrantDigest
        || result.destinationEpoch !== grant.destinationEpoch
        || result.grantRevision !== grant.grantRevision
        || result.grantExpiresAt !== grant.expiresAt
        || result.expectedPromptChainHead !== result.frontier.chainHeadPromptId
        || result.processGeneration !== result.frontier.processGeneration
        || result.pending !== (result.frontier.pendingExternalMutation !== undefined)
        || activityEpoch(result.frontier) !== result.targetActivityEpoch) throw new Error('davo_remote_payload_mismatch');
      return result.frontier;
    },
    // execute only the immutable original renderer or validated canonical followup renderer
    publish: async (input: DavoPromptPublication): Promise<DavoPromptResult> => {
      const state = await options.store.read();
      const request = state.requests.find(row => row.id === input.requestId);
      // expired requests cannot refresh a grant
      if (request === undefined) return { status: 'unknown' };
      const grant = await grantForRequest(request);
      let action: unknown;
      let expectedDigest: string;
      // originals use the exact stored seed renderer
      if (input.operationId === `${request.id}-original`) {
        const rendered = renderDavoOriginalV1(grant.requestSeed);
        // no origin-supplied executable replacement is accepted
        if (rendered !== input.payload || continuationPayloadDigest(rendered) !== input.payloadDigest) return { status: 'conflict' };
        action = { kind: 'publish-original', grantId: grant.grantId, operationId: input.operationId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision };
        expectedDigest = digestDavo(rendered);
      } else {
        const canonical = input.canonicalPayload;
        // remote followups require the exact shared canonical payload
        if (canonical === undefined) return { status: 'conflict' };
        const payload = davoFollowupPayloadSchema.parse(JSON.parse(canonical));
        // parsing is insufficient without byte-identical canonical re-rendering
        if (canonicalFollowupPayload(payload) !== canonical || renderDavoFollowupV1(canonical) !== input.payload || payload.requestSeedDigest !== grant.requestSeedDigest) return { status: 'conflict' };
        expectedDigest = digestDavo(canonical);
        action = { kind: 'publish-followup', grantId: grant.grantId, operationId: input.operationId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision, canonicalTarget: grant.target, targetActivityEpoch: input.targetActivityEpoch, expectedPromptChainHead: input.expectedPromptChainHead, payload, payloadDigest: expectedDigest };
      }
      const result = await exchange(grant.destinationInstanceId, action, grant.expiresAt);
      // persist logical operation truth, never reusable signed transport wrappers
      if (result.kind !== 'prompt-operation-receipt'
        || result.grantId !== grant.grantId
        || result.immutableGrantDigest !== grant.immutableGrantDigest
        || result.originInstanceId !== grant.originInstanceId
        || result.destinationInstanceId !== grant.destinationInstanceId
        || result.operationId !== input.operationId
        || result.payloadDigest !== expectedDigest
        || result.grantExpiresAt !== grant.expiresAt) return { status: 'unknown' };
      await options.store.transact(draft => { const stored = draft.remoteGrants.find(row => row.grantId === grant.grantId); if (stored !== undefined && !stored.operationReceiptBodies.some(row => row.bodyDigest === digestDavo(canonicalizeDavo(result)))) stored.operationReceiptBodies.push({ bodyDigest: digestDavo(canonicalizeDavo(result)), body: result }); });
      return result.result === 'published' && result.promptId === davoPromptId(input.operationId) ? { status: 'published', promptId: result.promptId } : { status: 'unknown' };
    },
    // recover exact remote publication state without another send
    lookup: async (request: DavoRequestV1, operationId: string): Promise<DavoPromptResult> => {
      const grant = await grantForRequest(request);
      const result = await exchange(grant.destinationInstanceId, { kind: 'lookup-operation', grantId: grant.grantId, operationId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision }, grant.expiresAt);
      return result.kind === 'prompt-operation-receipt'
        && result.grantId === grant.grantId
        && result.immutableGrantDigest === grant.immutableGrantDigest
        && result.originInstanceId === grant.originInstanceId
        && result.destinationInstanceId === grant.destinationInstanceId
        && result.operationId === operationId
        && result.grantExpiresAt === grant.expiresAt
        && result.result === 'published'
        && result.promptId === davoPromptId(operationId) ? { status: 'published', promptId: result.promptId } : { status: 'unknown' };
    },
    // look up one exact ended prompt receipt after origin restart or partition
    lifecycle: async (request: DavoRequestV1) => {
      const grant = await grantForRequest(request);
      // only published prompts have lifecycle authority
      if (request.dispatch.state !== 'published') return undefined;
      const result = await exchange(grant.destinationInstanceId, { kind: 'lookup-lifecycle', grantId: grant.grantId, eventId: `davo-lifecycle-${request.dispatch.promptId}`, promptId: request.dispatch.promptId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision }, grant.expiresAt);
      return result.kind === 'lifecycle-receipt'
        && result.grantId === grant.grantId
        && result.immutableGrantDigest === grant.immutableGrantDigest
        && result.eventId === `davo-lifecycle-${request.dispatch.promptId}`
        && result.operationId === request.dispatch.operationId
        && result.promptId === request.dispatch.promptId
        && result.targetActivityEpoch === request.targetActivityEpoch
        && result.grantExpiresAt === grant.expiresAt ? result : undefined;
    },
    // expose destination lifecycle persistence only to the local correlated prompt observer
    recordLifecycle: async (input: { requestId: string; operationId: string; promptId: string; state: 'completed' | 'failed' | 'question'; safeExcerpt?: string; completionEnvelope?: ReturnType<typeof import('./bridge.js').readDavoCompletion>; question?: z.infer<typeof davoRemoteQuestionSchema> }) => {
      // local revocation stops retained destination continuation updates
      if (!canWrite('delegate_request')) return;
      const state = await options.store.read();
      const grants = state.remoteGrants.filter(row => row.destinationInstanceId === options.instanceId
        && row.requestId === input.requestId
        && row.operationReceiptBodies.some(receipt => receipt.body.kind === 'prompt-operation-receipt'
          && receipt.body.result === 'published'
          && receipt.body.promptId === input.promptId
          && (receipt.body.operationId === input.operationId || remoteOperationKey(row.originInstanceId, receipt.body.operationId) === input.operationId)));
      // reject ambiguous colliding request and prompt ids
      if (grants.length !== 1) return;
      const grant = grants[0];
      const authority = grant === undefined ? undefined : destinations.get(grant.originInstanceId);
      // ordinary prompts have no remote grant or destination side effect
      if (grant === undefined || authority === undefined) return;
      const receipt = grant.operationReceiptBodies.find(row => row.body.kind === 'prompt-operation-receipt' && row.body.result === 'published' && row.body.promptId === input.promptId);
      // require the exact owned logical operation
      if (receipt === undefined || receipt.body.kind !== 'prompt-operation-receipt') return;
      // reject a cross-request or cross-prompt completion envelope
      if (input.completionEnvelope !== undefined && (input.completionEnvelope.requestId !== grant.requestId || input.completionEnvelope.promptId !== input.promptId)) return;
      const parsedQuestion = input.question === undefined ? undefined : davoRemoteQuestionSchema.safeParse(input.question);
      // require question content exactly for question lifecycle state
      if ((input.state === 'question' && parsedQuestion?.success !== true) || (input.state !== 'question' && input.question !== undefined)) return;
      const frontier = await options.readLocal(grant.target);
      // stale process or chain output cannot become a signed lifecycle receipt
      if (frontier === undefined
        || frontier.chainHeadPromptId !== input.promptId
        || frontier.processGeneration !== grant.target.processGeneration
        || frontier.conversationId !== grant.target.conversationId
        || parsedQuestion?.success === true && parsedQuestion.data.agentProcessGeneration !== frontier.processGeneration) return;
      await authority.recordLifecycle({ kind: 'lifecycle-receipt', version: 1, grantId: grant.grantId, immutableGrantDigest: grant.immutableGrantDigest, originInstanceId: grant.originInstanceId, destinationInstanceId: options.instanceId, eventId: `davo-lifecycle-${input.promptId}`, operationId: receipt.body.operationId, promptId: input.promptId, state: input.state, ...(input.safeExcerpt === undefined ? {} : { safeExcerpt: input.safeExcerpt }), ...(input.completionEnvelope === undefined ? {} : { completionEnvelope: input.completionEnvelope }), ...(parsedQuestion?.success === true ? { question: parsedQuestion.data } : {}), targetActivityEpoch: activityEpoch(frontier), grantExpiresAt: grant.expiresAt });
    }
  };
}
