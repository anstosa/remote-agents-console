import {
  DAVO_EXCERPT_MAX_BYTES,
  DAVO_USER_TEXT_MAX_BYTES,
  davoCompletionEnvelopeSchema,
  davoContextSchema,
  isSafeDavoText,
  utf8Bytes,
  type DavoCompletionEnvelopeV1,
  type DavoContextV1,
  type DavoMessageV1,
  type DavoStateV1
} from './contracts.js';

export const DAVO_LIVE_INPUT_MAX_BYTES = 40_960;
export const DAVO_CONTEXT_MAX_BYTES = 8_192;
export const DAVO_CURRENT_TURN_MAX_BYTES = 12_288;
export const DAVO_DESCRIPTOR_MAX_BYTES = 4_096;
export const DAVO_COMPACTOR_INPUT_MAX_BYTES = 32_768;
export const DAVO_EVALUATION_INPUT_MAX_BYTES = 32_768;

export class DavoContextError extends Error {
  readonly code = 'davo_context_capacity' as const;

  // expose only the safe capacity code
  constructor() {
    super('davo_context_capacity');
    this.name = 'DavoContextError';
  }
}

export type DavoContextProjection = {
  generation: number;
  text: string;
  sourceMessageIds: string[];
  sourceRetentionAnchorDates: string[];
};

export type DavoCompactorSource = DavoContextProjection;

export type DavoLiveContextInput = {
  currentTurn: string;
  currentMessageId?: string;
  descriptor?: string;
  fixedInstructions?: string;
  reservedBytes?: number;
};

export type DavoPendingChoiceDescriptor = {
  requestId: string;
  choiceId: string;
  kind: 'agent_question' | 'davo_continuation_choice';
  question: string;
  options: string[];
};

export type DavoEvaluationInput = {
  originalRequest: string;
  criteria: Array<{ id: string; statement: string }>;
  completionEnvelope: DavoCompletionEnvelopeV1;
  safeExcerpt?: string;
  fixedInstructions?: string;
};

type WholeTurn = {
  sequence: number;
  messages: DavoMessageV1[];
  text: string;
};

// require safe text within one component budget
function validateComponent(value: string, maximum: number): void {
  // reject unsafe or oversized authored text
  if (!isSafeDavoText(value) || utf8Bytes(value) > maximum) throw new DavoContextError();
}

// join sections without invisible budget growth
function joinSections(sections: string[]): string {
  return sections.filter(section => section !== '').join('\n\n');
}

// render one chat row with a fixed role fence
function renderMessage(message: DavoMessageV1): string {
  return message.kind === 'user' ? `[user]\n${message.text}` : `[assistant]\n${message.text}`;
}

// resolve one assistant row to its original user
function assistantUserId(state: DavoStateV1, message: Extract<DavoMessageV1, { kind: 'assistant' }>): string | undefined {
  const source = message.source;
  // voice replies directly identify their user row
  if (source.kind === 'assistant-final') return source.inReplyToMessageId;
  return state.requests.find(request => request.id === source.requestId)?.originalMessageId;
}

// build eligible complete user and assistant groups
function wholeTurns(state: DavoStateV1, excluded = new Set<string>()): WholeTurn[] {
  const retainedFrom = Date.parse(state.retention.retainedFrom);
  const eligible = state.messages.filter(message => message.kind !== 'status' && Date.parse(message.retentionAnchorAt) >= retainedFrom && !excluded.has(message.id));
  const users = eligible.filter((message): message is Extract<DavoMessageV1, { kind: 'user' }> => message.kind === 'user');
  const assistants = eligible.filter((message): message is Extract<DavoMessageV1, { kind: 'assistant' }> => message.kind === 'assistant');
  // retain one complete response group per user row
  return users.map(user => {
    const replies = assistants.filter(message => assistantUserId(state, message) === user.id).sort((left, right) => left.sequence - right.sequence);
    const messages: DavoMessageV1[] = [user, ...replies];
    return { sequence: user.sequence, messages, text: messages.map(renderMessage).join('\n') };
  }).sort((left, right) => left.sequence - right.sequence);
}

// select newest whole turns and render chronologically
function selectTurns(state: DavoStateV1, maximum: number, excluded = new Set<string>()): DavoContextProjection {
  const selected: WholeTurn[] = [];
  let used = 0;
  const candidates = wholeTurns(state, excluded);
  // consider newest groups first
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turn = candidates[index];
    const separator = selected.length === 0 ? 0 : utf8Bytes('\n\n');
    const size = utf8Bytes(turn.text) + separator;
    // preserve the whole group when it fits
    if (used + size <= maximum) {
      selected.push(turn);
      used += size;
    }
  }
  selected.sort((left, right) => left.sequence - right.sequence);
  const messages = selected.flatMap(turn => turn.messages);
  return {
    generation: state.retention.generation,
    text: selected.map(turn => turn.text).join('\n\n'),
    sourceMessageIds: messages.map(message => message.id),
    sourceRetentionAnchorDates: messages.map(message => message.retentionAnchorLocalDate)
  };
}

// build a restart-stable newest-whole-turn projection
export function buildFallbackContext(state: DavoStateV1, maximum = DAVO_CONTEXT_MAX_BYTES): DavoContextV1 {
  // enforce the compacted-context ceiling
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > DAVO_CONTEXT_MAX_BYTES) throw new DavoContextError();
  const selected = selectTurns(state, maximum);
  const latest = selected.sourceMessageIds.length === 0
    ? undefined
    : state.messages.find(message => message.id === selected.sourceMessageIds[selected.sourceMessageIds.length - 1]);
  return {
    ...selected,
    builtAt: latest?.createdAt ?? state.retention.retainedFrom
  };
}

// render bounded active request metadata
function requestMetadata(state: DavoStateV1, maximum: number): string {
  const lines: string[] = [];
  let used = 0;
  const requests = [...state.requests].sort((left, right) => left.id.localeCompare(right.id));
  // include metadata in stable request order
  for (const request of requests) {
    const line = JSON.stringify({
      requestId: request.id,
      state: request.state,
      instanceId: request.instanceQualifiedTarget.instanceId,
      projectId: request.instanceQualifiedTarget.projectId,
      worktreeId: request.instanceQualifiedTarget.worktreeId,
      agentId: request.instanceQualifiedTarget.agentId,
      targetActivityEpoch: request.targetActivityEpoch
    });
    const size = utf8Bytes(line) + (lines.length === 0 ? 0 : 1);
    // stop before partial metadata
    if (used + size > maximum) break;
    lines.push(line);
    used += size;
  }
  return lines.join('\n');
}

// build raw retained-only compactor input
export function buildCompactorSource(state: DavoStateV1): DavoCompactorSource {
  const metadata = requestMetadata(state, DAVO_COMPACTOR_INPUT_MAX_BYTES);
  const metadataSection = metadata === '' ? '' : `[active requests]\n${metadata}`;
  const remaining = DAVO_COMPACTOR_INPUT_MAX_BYTES - utf8Bytes(metadataSection) - (metadataSection === '' ? 0 : utf8Bytes('\n\n'));
  const selected = selectTurns(state, Math.max(0, remaining));
  return { ...selected, text: joinSections([metadataSection, selected.text]) };
}

// compare two ordered provenance arrays
function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// require exact eligible whole-turn provenance
function validProvenance(state: DavoStateV1, context: DavoContextV1): boolean {
  const retainedFrom = Date.parse(state.retention.retainedFrom);
  const selected = new Set(context.sourceMessageIds);
  const messages = context.sourceMessageIds.map(id => state.messages.find(message => message.id === id));
  // reject missing or expired source rows
  if (messages.some(message => message === undefined || message.kind === 'status' || Date.parse(message.retentionAnchorAt) < retainedFrom)) return false;
  const present = messages as DavoMessageV1[];
  // require chronological source order
  if (present.some((message, index) => index > 0 && present[index - 1].sequence >= message.sequence)) return false;
  // require exact anchor provenance
  if (!sameValues(present.map(message => message.retentionAnchorLocalDate), context.sourceRetentionAnchorDates)) return false;
  // verify each selected row belongs to a complete turn
  for (const message of present) {
    // assistant rows require their user
    if (message.kind === 'assistant' && !selected.has(assistantUserId(state, message) ?? '')) return false;
    // user rows require every eligible reply
    if (message.kind === 'user') {
      const replies = state.messages.filter((candidate): candidate is Extract<DavoMessageV1, { kind: 'assistant' }> => candidate.kind === 'assistant')
        .filter(candidate => assistantUserId(state, candidate) === message.id && Date.parse(candidate.retentionAnchorAt) >= retainedFrom);
      // reject partial response groups
      if (replies.some(reply => !selected.has(reply.id))) return false;
    }
  }
  return true;
}

// accept only exact current compactor output
export function acceptCompactedContext(state: DavoStateV1, candidate: DavoContextV1, expectedSourceMessageIds: string[]): DavoContextV1 {
  const parsed = davoContextSchema.safeParse(candidate);
  // reject malformed or stale output
  if (!parsed.success || parsed.data.generation !== state.retention.generation) throw new DavoContextError();
  // reject changed compactor provenance
  if (!sameValues(parsed.data.sourceMessageIds, expectedSourceMessageIds) || !validProvenance(state, parsed.data)) throw new DavoContextError();
  return parsed.data;
}

// choose a usable current summary or deterministic fallback
function retainedContext(state: DavoStateV1, excluded: Set<string>): DavoContextV1 {
  const current = state.retention.context;
  // never reuse stale or malformed context
  if (current === undefined || current.generation !== state.retention.generation || current.sourceMessageIds.some(id => excluded.has(id)) || !validProvenance(state, current)) {
    const selected = selectTurns(state, DAVO_CONTEXT_MAX_BYTES, excluded);
    const latest = selected.sourceMessageIds.length === 0 ? undefined : state.messages.find(message => message.id === selected.sourceMessageIds[selected.sourceMessageIds.length - 1]);
    return { ...selected, builtAt: latest?.createdAt ?? state.retention.retainedFrom };
  }
  return current;
}

// expose only bounded public pending-choice descriptors
export function pendingChoiceDescriptors(state: DavoStateV1): DavoPendingChoiceDescriptor[] {
  const descriptors: DavoPendingChoiceDescriptor[] = [];
  let bytes = 2;
  const requests = [...state.requests].sort((left, right) => left.id.localeCompare(right.id));
  // include whole current choices within the descriptor budget
  for (const request of requests) {
    const attention = request.attention;
    // omit quiet and non-choice states
    if (attention === undefined || attention.kind === 'operational_blocked') continue;
    const descriptor: DavoPendingChoiceDescriptor = attention.kind === 'agent_question'
      ? { requestId: request.id, choiceId: attention.questionId, kind: attention.kind, question: attention.question, options: [...(attention.choices ?? [])] }
      : {
          requestId: request.id,
          choiceId: attention.choiceId,
          kind: attention.kind,
          question: attention.reason === 'followup-budget' ? 'Should Davo authorize one more bounded follow-up batch?' : attention.reason === 'target-chain-diverged' ? 'Should Davo resume after the current Agent chain?' : 'Should Davo wait for exact publication evidence?',
          options: [...attention.options]
        };
    const size = utf8Bytes(JSON.stringify(descriptor)) + (descriptors.length === 0 ? 0 : 1);
    // stop before exposing a partial descriptor
    if (bytes + size > DAVO_DESCRIPTOR_MAX_BYTES) break;
    descriptors.push(descriptor);
    bytes += size;
  }
  return descriptors;
}

// render exact pending descriptors for live context
export function buildPendingDescriptor(state: DavoStateV1): string {
  return JSON.stringify(pendingChoiceDescriptors(state));
}

// build one exact-budget live provider seed
export function buildLiveContext(state: DavoStateV1, input: DavoLiveContextInput): DavoContextProjection {
  validateComponent(input.currentTurn, DAVO_CURRENT_TURN_MAX_BYTES);
  const reservedBytes = input.reservedBytes ?? 0;
  // reserve bounded caller-owned framing and catalog bytes
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > 16_384) throw new DavoContextError();
  const liveMaximum = DAVO_LIVE_INPUT_MAX_BYTES - reservedBytes;
  const descriptor = input.descriptor ?? buildPendingDescriptor(state);
  const instructions = input.fixedInstructions ?? '';
  validateComponent(descriptor, DAVO_DESCRIPTOR_MAX_BYTES);
  validateComponent(instructions, DAVO_LIVE_INPUT_MAX_BYTES);
  const inferredCurrent = input.currentMessageId ?? [...state.messages].reverse().find(message => message.kind === 'user' && message.generation === state.retention.generation && message.text === input.currentTurn)?.id;
  const currentIds = inferredCurrent === undefined ? new Set<string>() : new Set([inferredCurrent]);
  const compacted = retainedContext(state, currentIds);
  const required = joinSections([
    instructions === '' ? '' : `[instructions]\n${instructions}`,
    `[current user]\n${input.currentTurn}`,
    descriptor === '' ? '' : `[current request]\n${descriptor}`,
    compacted.text === '' ? '' : `[retained context]\n${compacted.text}`
  ]);
  // reject before adding any optional history
  if (utf8Bytes(required) > liveMaximum) throw new DavoContextError();
  const excluded = new Set([...compacted.sourceMessageIds, ...currentIds]);
  const separator = required === '' ? 0 : utf8Bytes('\n\n');
  const available = liveMaximum - utf8Bytes(required) - separator - utf8Bytes('[recent turns]\n');
  const raw = selectTurns(state, Math.max(0, available), excluded);
  const text = joinSections([required, raw.text === '' ? '' : `[recent turns]\n${raw.text}`]);
  // guard framing arithmetic
  if (utf8Bytes(text) > liveMaximum) throw new DavoContextError();
  return {
    generation: state.retention.generation,
    text,
    sourceMessageIds: [...compacted.sourceMessageIds, ...raw.sourceMessageIds],
    sourceRetentionAnchorDates: [...compacted.sourceRetentionAnchorDates, ...raw.sourceRetentionAnchorDates]
  };
}

// build one bounded fenced evaluator input
export function buildEvaluationInput(input: DavoEvaluationInput): string {
  validateComponent(input.originalRequest, DAVO_USER_TEXT_MAX_BYTES);
  validateComponent(input.safeExcerpt ?? '', DAVO_EXCERPT_MAX_BYTES);
  validateComponent(input.fixedInstructions ?? '', DAVO_EVALUATION_INPUT_MAX_BYTES);
  const envelope = davoCompletionEnvelopeSchema.parse(input.completionEnvelope);
  const text = joinSections([
    input.fixedInstructions ?? '',
    `[untrusted original request]\n${input.originalRequest}`,
    `[immutable criteria]\n${JSON.stringify(input.criteria)}`,
    `[untrusted completion envelope]\n${JSON.stringify(envelope)}`,
    input.safeExcerpt === undefined ? '' : `[untrusted agent excerpt]\n${input.safeExcerpt}`
  ]);
  // enforce the complete evaluator envelope
  if (utf8Bytes(text) > DAVO_EVALUATION_INPUT_MAX_BYTES) throw new DavoContextError();
  return text;
}
