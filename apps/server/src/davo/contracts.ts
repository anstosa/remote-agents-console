import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DAVO_STATE_SCHEMA_VERSION = 1;
export const DAVO_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const DAVO_MESSAGE_MAX_BYTES = 48 * 1024;
export const DAVO_USER_TEXT_MAX_BYTES = 12 * 1024;
export const DAVO_EXCERPT_MAX_BYTES = 8 * 1024;
export const DAVO_MESSAGE_MAX_COUNT = 10_000;
export const DAVO_REQUEST_MAX_COUNT = 256;
export const DAVO_CRITERIA_MAX_COUNT = 64;
export const DAVO_CRITERIA_MAX_BYTES = 4 * 1024;
export const DAVO_REQUEST_SEED_MAX_BYTES = 20 * 1024;

// count serialized utf-8 bytes
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// reject nul and unpaired surrogates
export function isSafeDavoText(value: string): boolean {
  // reject embedded nul
  if (value.includes('\0')) return false;
  // verify unicode scalar pairs
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // require a paired high surrogate
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      // reject a missing low surrogate
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    // reject a lone low surrogate
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// encode one canonical scalar or composite value
export function canonicalizeDavo(value: unknown): string {
  // encode null exactly
  if (value === null) return 'null';
  // encode safe strings without normalization
  if (typeof value === 'string') {
    // reject invalid unicode scalars
    if (!isSafeDavoText(value)) throw new TypeError('invalid davo canonical string');
    return JSON.stringify(value);
  }
  // encode exact booleans
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // encode only safe integers
  if (typeof value === 'number') {
    // reject floats and unsafe values
    if (!Number.isSafeInteger(value)) throw new TypeError('invalid davo canonical number');
    return String(value);
  }
  // preserve array order
  if (Array.isArray(value)) return `[${value.map(canonicalizeDavo).join(',')}]`;
  // encode closed object keys deterministically
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    // reject undefined fields instead of dropping them
    if (keys.some(key => record[key] === undefined)) throw new TypeError('undefined davo canonical field');
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalizeDavo(record[key])}`).join(',')}}`;
  }
  throw new TypeError('unsupported davo canonical value');
}

// hash exact canonical bytes
export function digestDavo(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// build one bounded safe text schema
function boundedText(maxBytes: number, minimumBytes = 0): z.ZodType<string> {
  return z.string().refine(isSafeDavoText, 'invalid text').refine(value => utf8Bytes(value) >= minimumBytes && utf8Bytes(value) <= maxBytes, 'text exceeds byte limit');
}

// validate a real calendar date
function validLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  // require the complete date form
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const identifier = boundedText(256, 1);
const longIdentifier = boundedText(1_024, 1);
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'invalid timestamp');
const localDate = z.string().refine(validLocalDate, 'invalid local date');
const nonnegativeInteger = z.number().int().safe().nonnegative();
const positiveInteger = z.number().int().safe().positive();
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const safeErrorCode = z.enum([
  'davo_store_unavailable',
  'davo_capacity',
  'davo_context_capacity',
  'davo_generation_changed',
  'davo_context_rebuild_failed',
  'davo_provider_unavailable',
  'davo_provider_control_unsupported',
  'davo_provider_hangup_ambiguous',
  'davo_item_quarantine',
  'davo_capability_replay',
  'davo_target_chain_changed',
  'davo_external_activity_pending',
  'davo_remote_rebind_conflict',
  'davo_remote_payload_mismatch',
  'davo_publication_unknown',
  'davo_remote_unavailable',
  'davo_followup_budget',
  'davo_notification_ambiguous',
  'davo_expired'
]);

export const davoSafeErrorSchema = z.object({ code: safeErrorCode, retryAt: timestamp.optional() }).strict();
export type DavoSafeErrorV1 = z.infer<typeof davoSafeErrorSchema>;

export const davoTargetSchema = z.object({
  projectId: identifier,
  placeId: identifier,
  worktreeId: identifier,
  agentId: identifier,
  conversationId: longIdentifier.optional(),
  processGeneration: nonnegativeInteger,
  targetActivityEpoch: identifier,
  expectedPromptChainHead: identifier
}).strict();
export type DavoTargetV1 = z.infer<typeof davoTargetSchema>;

export const davoInstanceQualifiedTargetSchema = davoTargetSchema.extend({ instanceId: identifier }).strict();
export type DavoInstanceQualifiedTargetV1 = z.infer<typeof davoInstanceQualifiedTargetSchema>;

export const davoActivityFrontierSchema = z.object({
  instanceId: identifier,
  agentId: identifier,
  promptActivityRevision: nonnegativeInteger,
  chainHeadPromptId: identifier,
  processGeneration: nonnegativeInteger,
  conversationId: longIdentifier.optional(),
  modelId: longIdentifier.optional(),
  handoverRevision: nonnegativeInteger,
  pendingExternalMutation: identifier.optional()
}).strict();
export type DavoActivityFrontierShapeV1 = z.infer<typeof davoActivityFrontierSchema>;

export const davoRemoteQuestionAnswerSchema = z.union([
  z.object({ index: z.number().int().min(0).max(99) }).strict(),
  z.object({ text: boundedText(8_000, 1) }).strict(),
  z.object({ dismiss: z.literal(true) }).strict()
]);
export type DavoRemoteQuestionAnswerV1 = z.infer<typeof davoRemoteQuestionAnswerSchema>;

export const davoRemoteQuestionSchema = z.object({
  questionId: identifier,
  question: boundedText(DAVO_EXCERPT_MAX_BYTES, 1),
  agentProcessGeneration: nonnegativeInteger,
  answerShape: z.enum(['text', 'single-choice', 'multiple-choice']),
  choices: z.array(boundedText(1_024, 1)).max(100).optional()
}).strict().superRefine((value, context) => {
  // choice questions must expose their exact options
  if (value.answerShape !== 'text' && (value.choices === undefined || value.choices.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question choices required', path: ['choices'] });
  // text questions cannot smuggle choice semantics
  if (value.answerShape === 'text' && value.choices !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'text question choices forbidden', path: ['choices'] });
  // bound the complete question descriptor
  if (utf8Bytes(JSON.stringify(value)) > DAVO_EXCERPT_MAX_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question exceeds byte limit' });
});
export type DavoRemoteQuestionV1 = z.infer<typeof davoRemoteQuestionSchema>;

const continuationScopes = z.tuple([z.literal('status:read'), z.literal('prompts:write')]);
const continuationRights = z.tuple([
  z.literal('correlated-prompt:observe'),
  z.literal('same-chain-followup:enqueue'),
  z.literal('davo-chat:append'),
  z.literal('davo-notification:enqueue')
]);

export const davoContinuationPrincipalSchema = z.object({
  principalKind: z.literal('davo-continuation'),
  principalOwnerHash: digest,
  originInstanceId: identifier,
  destinationInstanceId: identifier,
  admittedAt: timestamp,
  expiresAt: timestamp,
  sourceScopeSnapshot: continuationScopes,
  target: davoTargetSchema,
  rights: continuationRights
}).strict().refine(value => Date.parse(value.admittedAt) < Date.parse(value.expiresAt), 'principal expiry must follow admission');
export type DavoContinuationPrincipalV1 = z.infer<typeof davoContinuationPrincipalSchema>;

const completionCriterionSchema = z.object({ id: identifier, status: z.enum(['satisfied', 'unsatisfied', 'unknown']), evidence: boundedText(DAVO_EXCERPT_MAX_BYTES) }).strict();
const completionCheckSchema = z.object({ name: identifier, status: z.enum(['passed', 'failed', 'not-applicable']), evidence: boundedText(DAVO_EXCERPT_MAX_BYTES) }).strict();
export const davoCompletionEnvelopeSchema = z.object({
  requestId: identifier,
  promptId: identifier,
  outcome: z.enum(['complete', 'partial', 'blocked']),
  criteria: z.array(completionCriterionSchema).max(DAVO_CRITERIA_MAX_COUNT),
  checks: z.array(completionCheckSchema).max(DAVO_CRITERIA_MAX_COUNT),
  remaining: z.array(boundedText(DAVO_EXCERPT_MAX_BYTES, 1)).max(DAVO_CRITERIA_MAX_COUNT),
  question: boundedText(DAVO_EXCERPT_MAX_BYTES, 1).optional()
}).strict().refine(value => utf8Bytes(JSON.stringify(value)) <= DAVO_EXCERPT_MAX_BYTES, 'completion envelope exceeds byte limit');
export type DavoCompletionEnvelopeV1 = z.infer<typeof davoCompletionEnvelopeSchema>;

const messageBase = {
  sequence: positiveInteger,
  id: identifier,
  conversationId: identifier,
  generation: nonnegativeInteger,
  createdAt: timestamp,
  localDate,
  retentionAnchorAt: timestamp,
  retentionAnchorLocalDate: localDate,
  requestId: identifier.optional()
};
const userMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('user'),
  text: boundedText(DAVO_USER_TEXT_MAX_BYTES, 1),
  source: z.object({ kind: z.literal('user-transcript'), voiceSessionId: identifier, providerSessionId: identifier, providerItemId: identifier }).strict()
}).strict();
const assistantMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('assistant'),
  text: boundedText(DAVO_MESSAGE_MAX_BYTES, 1),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('assistant-final'), voiceSessionId: identifier, responseId: identifier, inReplyToMessageId: identifier }).strict(),
    z.object({ kind: z.literal('request-response'), requestId: identifier, eventId: identifier }).strict()
  ])
}).strict();
const statusMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('status'),
  text: boundedText(DAVO_EXCERPT_MAX_BYTES, 1),
  source: z.object({ kind: z.literal('request-status'), statusKey: identifier }).strict()
}).strict();
export const davoMessageSchema = z.discriminatedUnion('kind', [userMessageSchema, assistantMessageSchema, statusMessageSchema])
  .refine(value => utf8Bytes(JSON.stringify(value)) <= DAVO_MESSAGE_MAX_BYTES, 'message exceeds byte limit');
export type DavoMessageV1 = z.infer<typeof davoMessageSchema>;

const agentQuestionSchema = z.object({
  kind: z.literal('agent_question'),
  questionId: identifier,
  question: boundedText(DAVO_EXCERPT_MAX_BYTES, 1),
  agentProcessGeneration: nonnegativeInteger,
  targetActivityEpoch: identifier,
  answerShape: z.enum(['text', 'single-choice', 'multiple-choice']),
  choices: z.array(boundedText(1_024, 1)).max(100).optional()
}).strict().superRefine((value, context) => {
  // retained choice questions must keep their exact options
  if (value.answerShape !== 'text' && (value.choices === undefined || value.choices.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'attention choices required', path: ['choices'] });
  // retained text questions cannot acquire choice options
  if (value.answerShape === 'text' && value.choices !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'attention choices forbidden', path: ['choices'] });
});
const followupChoiceSchema = z.object({
  kind: z.literal('davo_continuation_choice'),
  choiceId: identifier,
  reason: z.literal('followup-budget'),
  options: z.tuple([z.literal('authorize-one-more-batch'), z.literal('stop-followup')])
}).strict();
const targetChoiceSchema = z.object({
  kind: z.literal('davo_continuation_choice'),
  choiceId: identifier,
  reason: z.literal('target-chain-diverged'),
  options: z.tuple([z.literal('resume-after-current-chain'), z.literal('stop-followup')])
}).strict();
const publicationChoiceSchema = z.object({
  kind: z.literal('davo_continuation_choice'),
  choiceId: identifier,
  reason: z.literal('publication-unknown'),
  options: z.tuple([z.literal('wait-for-evidence'), z.literal('stop-followup')])
}).strict();
const operationalAttentionSchema = z.object({ kind: z.literal('operational_blocked'), code: safeErrorCode, retryAt: timestamp.optional() }).strict();
export const davoAttentionSchema = z.union([agentQuestionSchema, followupChoiceSchema, targetChoiceSchema, publicationChoiceSchema, operationalAttentionSchema]);
export type DavoAttentionV1 = z.infer<typeof davoAttentionSchema>;

const requestDispatchSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('prepared'), operationId: identifier, payloadDigest: digest }).strict(),
  z.object({ state: z.literal('publishing'), operationId: identifier, payloadDigest: digest }).strict(),
  z.object({ state: z.literal('published'), operationId: identifier, payloadDigest: digest, promptId: identifier }).strict(),
  z.object({ state: z.literal('unknown'), operationId: identifier, payloadDigest: digest }).strict()
]);
const requestEvaluationSchema = z.object({
  generation: nonnegativeInteger,
  promptId: identifier,
  providerTurnId: identifier,
  result: z.enum(['candidate_done', 'continue', 'inconsistent']),
  criterionIds: z.array(identifier).max(DAVO_CRITERIA_MAX_COUNT),
  contradictions: z.array(boundedText(DAVO_EXCERPT_MAX_BYTES, 1)).max(DAVO_CRITERIA_MAX_COUNT),
  safeExcerpt: boundedText(DAVO_EXCERPT_MAX_BYTES).optional()
}).strict().refine(value => utf8Bytes(JSON.stringify(value)) <= DAVO_EXCERPT_MAX_BYTES, 'evaluation exceeds byte limit');
const completionEvidenceSchema = z.object({ kind: z.literal('completion'), envelope: davoCompletionEnvelopeSchema, evaluatedAt: timestamp }).strict();
const requestNotificationSchema = z.object({ eventId: identifier, outcome: z.enum(['done', 'choice']), revision: nonnegativeInteger }).strict();
const requiredCheckName = boundedText(128, 1);
export const davoCriterionSchema = z.object({ id: identifier, statement: boundedText(DAVO_CRITERIA_MAX_BYTES, 1) }).strict();
export type DavoCriterionV1 = z.infer<typeof davoCriterionSchema>;
const requestCoordinationSchema = z.object({
  followupCycles: nonnegativeInteger,
  evaluationTimestamps: z.array(timestamp).max(12),
  cumulativeFollowupBytes: nonnegativeInteger,
  extraAuthorizedBatches: nonnegativeInteger,
  publicationRecovery: z.object({
    operationId: identifier,
    lookupChecks: z.number().int().min(0).max(3),
    mode: z.enum(['probing', 'choice', 'waiting', 'stopped'])
  }).strict().optional(),
  activeOperationId: identifier.optional(),
  activeFollowupBytes: z.number().int().safe().min(1).max(40_960).optional()
}).strict();
export const davoRequestSchema = z.object({
  id: identifier,
  originalMessageId: identifier,
  originalRequestedAt: timestamp,
  originalLocalDate: localDate,
  state: z.enum(['dispatching', 'awaiting-agent', 'evaluating', 'awaiting-choice', 'operational-blocked', 'done']),
  revision: nonnegativeInteger,
  admittedGeneration: nonnegativeInteger,
  instanceQualifiedTarget: davoInstanceQualifiedTargetSchema,
  targetActivityEpoch: identifier,
  expectedPromptChainHead: identifier,
  principal: davoContinuationPrincipalSchema,
  dispatch: requestDispatchSchema,
  evaluation: requestEvaluationSchema.optional(),
  attention: davoAttentionSchema.optional(),
  terminalEvidence: completionEvidenceSchema.optional(),
  notification: requestNotificationSchema.optional(),
  lastSafeError: davoSafeErrorSchema.optional(),
  criteria: z.array(davoCriterionSchema).max(DAVO_CRITERIA_MAX_COUNT),
  requiredChecks: z.array(requiredCheckName).max(16),
  coordination: requestCoordinationSchema
}).strict()
  .refine(value => utf8Bytes(JSON.stringify(value.criteria)) <= DAVO_CRITERIA_MAX_BYTES, 'request criteria exceed byte limit');
export type DavoRequestV1 = z.infer<typeof davoRequestSchema>;

const hangupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), definitelyNotSentRetries: z.number().int().min(0).max(1) }).strict(),
  z.object({ state: z.literal('prepared'), attemptId: identifier, definitelyNotSentRetries: z.number().int().min(0).max(1) }).strict(),
  z.object({ state: z.literal('dispatching'), attemptId: identifier, attemptedAt: timestamp, definitelyNotSentRetries: z.number().int().min(0).max(1) }).strict()
]);
export const davoProviderCallSchema = z.object({
  voiceSessionId: identifier,
  generation: nonnegativeInteger,
  ownerHash: digest,
  callId: identifier,
  createdAt: timestamp,
  hardCutoffAt: timestamp,
  providerMaximumEndsAt: timestamp,
  hangup: hangupSchema
}).strict().refine(value => Date.parse(value.createdAt) < Date.parse(value.providerMaximumEndsAt), 'provider maximum must follow creation');
export type DavoProviderCallV1 = z.infer<typeof davoProviderCallSchema>;

export const davoOperationSchema = z.object({
  operationId: identifier,
  requestId: identifier,
  destinationInstanceId: identifier,
  kind: z.enum(['original-delegation', 'followup', 'lifecycle', 'notification']),
  generation: nonnegativeInteger,
  targetActivityEpoch: identifier,
  payloadDigest: digest,
  state: z.enum(['prepared', 'publishing', 'published', 'unknown']),
  promptId: identifier.optional(),
  createdAt: timestamp,
  expiresAt: timestamp
}).strict().refine(value => Date.parse(value.createdAt) < Date.parse(value.expiresAt), 'operation expiry must follow creation');
export type DavoOperationV1 = z.infer<typeof davoOperationSchema>;

export const davoRequestSeedSchema = z.object({
  version: z.literal(1),
  requestId: identifier,
  originalRequest: boundedText(DAVO_USER_TEXT_MAX_BYTES, 1),
  criterionSetVersion: z.literal(1),
  criteria: z.array(davoCriterionSchema).max(DAVO_CRITERIA_MAX_COUNT),
  requiredChecks: z.array(requiredCheckName).max(16).optional()
}).strict()
  .refine(value => utf8Bytes(JSON.stringify(value.criteria)) <= DAVO_CRITERIA_MAX_BYTES, 'criteria exceed byte limit')
  .refine(value => utf8Bytes(JSON.stringify(value)) <= DAVO_REQUEST_SEED_MAX_BYTES, 'request seed exceeds byte limit');
export type DavoRequestSeedV1 = z.infer<typeof davoRequestSeedSchema>;

const rebindReceiptSchema = z.object({
  kind: z.literal('rebind-receipt'), version: z.literal(1), result: z.enum(['rebound', 'rebind_required']), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, requestedDestinationEpoch: identifier, resultDestinationEpoch: identifier,
  expectedGrantRevision: nonnegativeInteger, resultGrantRevision: nonnegativeInteger, grantExpiresAt: timestamp
}).strict();
const operationReceiptSchema = z.object({
  kind: z.literal('prompt-operation-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, operationId: identifier, payloadDigest: digest,
  result: z.enum(['published', 'unknown']), promptId: identifier.optional(), grantExpiresAt: timestamp
}).strict();
const lifecycleReceiptSchema = z.object({
  kind: z.literal('lifecycle-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, eventId: identifier, operationId: identifier, promptId: identifier,
  state: z.enum(['queued', 'started', 'completed', 'failed', 'question']), completionEnvelope: davoCompletionEnvelopeSchema.optional(),
  safeExcerpt: boundedText(DAVO_EXCERPT_MAX_BYTES).optional(), question: davoRemoteQuestionSchema.optional(), targetActivityEpoch: identifier, grantExpiresAt: timestamp
}).strict().superRefine((value, context) => {
  // question state requires one strict question body
  if (value.state === 'question' && value.question === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question body required', path: ['question'] });
  // nonquestion states cannot retain question content
  if (value.state !== 'question' && value.question !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'question body forbidden', path: ['question'] });
});
const questionAnswerReceiptSchema = z.object({
  kind: z.literal('question-answer-receipt'), version: z.literal(1), grantId: identifier, immutableGrantDigest: digest,
  originInstanceId: identifier, destinationInstanceId: identifier, destinationEpoch: identifier, grantRevision: nonnegativeInteger,
  operationId: identifier, questionId: identifier, payloadDigest: digest, answered: z.literal(true), frontier: davoActivityFrontierSchema,
  targetActivityEpoch: digest, grantExpiresAt: timestamp
}).strict();
const storedReceiptSchema = z.object({ bodyDigest: digest, body: z.union([rebindReceiptSchema, operationReceiptSchema, lifecycleReceiptSchema, questionAnswerReceiptSchema]) }).strict();

export const davoRemoteGrantSchema = z.object({
  grantVersion: z.literal(1),
  grantId: identifier,
  originInstanceId: identifier,
  destinationInstanceId: identifier,
  requestId: identifier,
  principalOwnerHash: digest,
  sourceScopeSnapshot: continuationScopes,
  originalRequestedAt: timestamp,
  target: davoTargetSchema,
  targetActivityEpoch: identifier,
  expectedPromptChainHead: identifier,
  rights: continuationRights,
  requestSeed: davoRequestSeedSchema,
  requestSeedDigest: digest,
  immutableGrantDigest: digest,
  destinationEpoch: identifier,
  grantRevision: nonnegativeInteger,
  state: z.enum(['active', 'revoked', 'expired']),
  rebindReceiptBodies: z.array(storedReceiptSchema).max(256),
  operationReceiptBodies: z.array(storedReceiptSchema).max(256),
  lifecycleReceiptBodies: z.array(storedReceiptSchema).max(256),
  expiresAt: timestamp
}).strict().refine(value => Date.parse(value.originalRequestedAt) < Date.parse(value.expiresAt), 'grant expiry must follow request');
export type DavoRemoteGrantV1 = z.infer<typeof davoRemoteGrantSchema>;

const certaintyCountsSchema = z.object({ definitelyNotSent: nonnegativeInteger, acceptedAtLeastOnce: nonnegativeInteger, ambiguous: nonnegativeInteger }).strict();
export const davoNotificationOutboxSchema = z.object({
  id: identifier,
  requestId: identifier,
  kind: z.enum(['done', 'choice']),
  tag: identifier,
  state: z.enum(['ready', 'dispatching', 'attempted', 'ambiguous', 'expired']),
  eventId: identifier,
  attempts: nonnegativeInteger,
  certaintyCounts: certaintyCountsSchema.optional(),
  createdAt: timestamp
}).strict();
export type DavoNotificationOutboxV1 = z.infer<typeof davoNotificationOutboxSchema>;

// recheck the exact retained notification authority before external delivery
export function davoNotificationMatchesRequest(event: DavoNotificationOutboxV1, request: DavoRequestV1 | undefined): boolean {
  // require the current event rather than a historical or replaced choice
  if (request === undefined || event.requestId !== request.id || request.notification?.eventId !== event.eventId || request.notification.outcome !== event.kind) return false;
  // terminal notifications require correlated completion evidence
  if (event.kind === 'done') return request.state === 'done' && request.terminalEvidence?.envelope.requestId === request.id;
  return request.state === 'awaiting-choice' && (request.attention?.kind === 'agent_question' || request.attention?.kind === 'davo_continuation_choice');
}

export const davoContextSchema = z.object({
  generation: nonnegativeInteger,
  builtAt: timestamp,
  sourceMessageIds: z.array(identifier).max(DAVO_MESSAGE_MAX_COUNT),
  sourceRetentionAnchorDates: z.array(localDate).max(DAVO_MESSAGE_MAX_COUNT),
  text: boundedText(DAVO_EXCERPT_MAX_BYTES)
}).strict().refine(value => value.sourceMessageIds.length === value.sourceRetentionAnchorDates.length, 'context provenance lengths differ');
export type DavoContextV1 = z.infer<typeof davoContextSchema>;

const davoRetentionSchema = z.object({
  generation: nonnegativeInteger,
  lastCompletedSweepDate: localDate,
  retainedFrom: timestamp,
  contextRevision: identifier,
  context: davoContextSchema.optional()
}).strict();

export const davoStateSchema = z.object({
  schemaVersion: z.literal(DAVO_STATE_SCHEMA_VERSION),
  logicalConversationId: identifier,
  retention: davoRetentionSchema,
  nextSequence: positiveInteger,
  messages: z.array(davoMessageSchema).max(DAVO_MESSAGE_MAX_COUNT),
  requests: z.array(davoRequestSchema).max(DAVO_REQUEST_MAX_COUNT),
  providerCalls: z.array(davoProviderCallSchema).max(256),
  providerQuarantineUntil: timestamp.optional(),
  operations: z.array(davoOperationSchema).max(2_048),
  remoteGrants: z.array(davoRemoteGrantSchema).max(DAVO_REQUEST_MAX_COUNT),
  notificationOutbox: z.array(davoNotificationOutboxSchema).max(1_024)
}).strict().superRefine((value, context) => {
  const messageIds = new Set<string>();
  const sequences = new Set<number>();
  // validate message identities and state ownership
  for (const message of value.messages) {
    // reject duplicate message identities
    if (messageIds.has(message.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate message id', path: ['messages'] });
    messageIds.add(message.id);
    // reject duplicate sequences
    if (sequences.has(message.sequence)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate message sequence', path: ['messages'] });
    sequences.add(message.sequence);
    // bind every row to the stable conversation
    if (message.conversationId !== value.logicalConversationId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'message conversation mismatch', path: ['messages'] });
  }
  const greatestSequence = value.messages.reduce((greatest, message) => Math.max(greatest, message.sequence), 0);
  // keep the next sequence strictly ahead
  if (value.nextSequence <= greatestSequence) context.addIssue({ code: z.ZodIssueCode.custom, message: 'next sequence is stale', path: ['nextSequence'] });
  const requestIds = new Set<string>();
  // validate request anchors
  for (const request of value.requests) {
    // reject duplicate requests
    if (requestIds.has(request.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate request id', path: ['requests'] });
    requestIds.add(request.id);
    const message = value.messages.find(candidate => candidate.id === request.originalMessageId);
    // require the original user anchor
    if (message === undefined || message.kind !== 'user' || message.createdAt !== request.originalRequestedAt || message.localDate !== request.originalLocalDate) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'request anchor mismatch', path: ['requests'] });
    }
    // retain only one coherent effectful state under the current generation
    if (request.admittedGeneration !== value.retention.generation
      || request.instanceQualifiedTarget.targetActivityEpoch !== request.targetActivityEpoch
      || request.instanceQualifiedTarget.expectedPromptChainHead !== request.expectedPromptChainHead
      || request.principal.destinationInstanceId !== request.instanceQualifiedTarget.instanceId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'request authority mismatch', path: ['requests'] });
    const attention = request.attention;
    const choice = attention?.kind === 'agent_question' || attention?.kind === 'davo_continuation_choice';
    // attention must describe the exact state that can consume it
    if (request.state === 'awaiting-choice' ? !choice : request.state === 'operational-blocked' ? attention?.kind !== 'operational_blocked' : attention !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'request attention mismatch', path: ['requests'] });
    const envelope = request.terminalEvidence?.envelope;
    // terminal records must carry complete exact request and prompt evidence
    if (request.state === 'done') {
      const checks = envelope?.checks ?? [];
      const evidenceMatches = request.dispatch.state === 'published' && envelope !== undefined
        && envelope.requestId === request.id && envelope.promptId === request.dispatch.promptId
        && envelope.outcome === 'complete' && envelope.remaining.length === 0 && envelope.question === undefined
        && envelope.criteria.length === request.criteria.length
        && envelope.criteria.every((criterion, index) => criterion.id === request.criteria[index]?.id && criterion.status === 'satisfied' && criterion.evidence !== '')
        && checks.length === request.requiredChecks.length && new Set(checks.map(check => check.name)).size === checks.length
        && checks.every(check => request.requiredChecks.includes(check.name) && check.status !== 'failed' && check.evidence !== '');
      // incomplete persisted evidence cannot produce a completion effect
      if (!evidenceMatches) context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal evidence mismatch', path: ['requests'] });
    } else if (request.terminalEvidence !== undefined) {
      // nonterminal work cannot retain terminal authority
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'nonterminal completion evidence', path: ['requests'] });
    }
    const operation = value.operations.find(candidate => candidate.operationId === request.dispatch.operationId);
    // published dispatches require the exact durable publication receipt
    if (request.dispatch.state === 'published' && (operation === undefined || operation.state !== 'published'
      || operation.requestId !== request.id || operation.destinationInstanceId !== request.instanceQualifiedTarget.instanceId
      || operation.generation !== request.admittedGeneration || operation.payloadDigest !== request.dispatch.payloadDigest
      || operation.promptId !== request.dispatch.promptId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'dispatch operation mismatch', path: ['requests'] });
  }
  const operationIds = new Set<string>();
  // every persisted operation must retain its exact local or remote owner
  for (const operation of value.operations) {
    const request = value.requests.find(candidate => candidate.id === operation.requestId);
    const grant = value.remoteGrants.find(candidate => candidate.requestId === operation.requestId && candidate.destinationInstanceId === operation.destinationInstanceId);
    // reject orphaned, duplicated, or future-generation operation authority
    if (operationIds.has(operation.operationId) || request === undefined && grant === undefined
      || operation.generation > value.retention.generation
      || request !== undefined && (operation.destinationInstanceId !== request.instanceQualifiedTarget.instanceId || operation.expiresAt !== request.principal.expiresAt)
      || request === undefined && grant !== undefined && operation.expiresAt !== grant.expiresAt
      || operation.state === 'published' && (operation.kind === 'original-delegation' || operation.kind === 'followup') && operation.promptId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation ownership mismatch', path: ['operations'] });
    operationIds.add(operation.operationId);
  }
  const outboxIds = new Set<string>();
  const eventIds = new Set<string>();
  // effectful outbox entries must still represent a current done or genuine choice
  for (const event of value.notificationOutbox) {
    const request = value.requests.find(candidate => candidate.id === event.requestId);
    const active = event.state === 'ready' || event.state === 'dispatching';
    // keep historical attempts without giving replaced events delivery authority
    if (outboxIds.has(event.id) || eventIds.has(event.eventId) || request === undefined
      || event.kind === 'done' && request.state !== 'done'
      || active && !davoNotificationMatchesRequest(event, request)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'notification authority mismatch', path: ['notificationOutbox'] });
    outboxIds.add(event.id);
    eventIds.add(event.eventId);
  }
  const grantIds = new Set<string>();
  // verify durable remote authority with the same canonical protocol bytes
  for (const grant of value.remoteGrants) {
    const { immutableGrantDigest, destinationEpoch: _epoch, grantRevision: _revision, state: _state, rebindReceiptBodies, operationReceiptBodies, lifecycleReceiptBodies, ...immutable } = grant;
    // immutable seed and target duplicates cannot drift after admission
    if (grantIds.has(grant.grantId) || grant.requestSeed.requestId !== grant.requestId
      || grant.target.targetActivityEpoch !== grant.targetActivityEpoch || grant.target.expectedPromptChainHead !== grant.expectedPromptChainHead
      || digestDavo(JSON.stringify(davoRequestSeedSchema.parse(grant.requestSeed))) !== grant.requestSeedDigest
      || digestDavo(canonicalizeDavo(immutable)) !== immutableGrantDigest) context.addIssue({ code: z.ZodIssueCode.custom, message: 'remote grant digest mismatch', path: ['remoteGrants'] });
    grantIds.add(grant.grantId);
    const receiptIds = new Set<string>();
    // bind each logical receipt to its immutable grant and unmodified body
    for (const receipt of [...rebindReceiptBodies, ...operationReceiptBodies, ...lifecycleReceiptBodies]) {
      const body = receipt.body;
      // reject forged or cross-grant replay bodies before a fresh signature can be issued
      if (receiptIds.has(receipt.bodyDigest) || digestDavo(canonicalizeDavo(body)) !== receipt.bodyDigest
        || body.grantId !== grant.grantId || body.immutableGrantDigest !== immutableGrantDigest
        || body.originInstanceId !== grant.originInstanceId || body.destinationInstanceId !== grant.destinationInstanceId
        || body.grantExpiresAt !== grant.expiresAt
        || body.kind === 'prompt-operation-receipt' && (body.result === 'published' ? body.promptId === undefined : body.promptId !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'remote receipt identity mismatch', path: ['remoteGrants'] });
      receiptIds.add(receipt.bodyDigest);
    }
  }
  // require every request-derived row to keep the original anchor
  for (const message of value.messages) {
    // ignore ordinary live rows without request correlation
    if (message.requestId === undefined) continue;
    const request = value.requests.find(candidate => candidate.id === message.requestId);
    // reject missing or renewed derivative anchors
    if (request === undefined || message.retentionAnchorAt !== request.originalRequestedAt || message.retentionAnchorLocalDate !== request.originalLocalDate) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'message request anchor mismatch', path: ['messages'] });
      continue;
    }
    // bind background prose to the same request id
    if (message.kind === 'assistant' && message.source.kind === 'request-response' && message.source.requestId !== message.requestId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'assistant request mismatch', path: ['messages'] });
    }
  }
  // reject stale compacted context
  if (value.retention.context !== undefined && value.retention.context.generation !== value.retention.generation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'context generation mismatch', path: ['retention', 'context'] });
  }
  // reject oversized state
  if (utf8Bytes(JSON.stringify(value)) > DAVO_STATE_MAX_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: 'state exceeds byte limit' });
});
export type DavoStateV1 = z.infer<typeof davoStateSchema>;

// validate one complete persisted state
export function parseDavoState(value: unknown): DavoStateV1 {
  return davoStateSchema.parse(value);
}
