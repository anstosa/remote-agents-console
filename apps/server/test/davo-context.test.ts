import { describe, expect, it } from 'vitest';
import { DAVO_CONTEXT_MAX_BYTES, DavoContextError, acceptCompactedContext, buildCompactorSource, buildFallbackContext, buildLiveContext } from '../src/davo/context.js';
import type { DavoMessageV1, DavoStateV1 } from '../src/davo/contracts.js';

// build one valid retained state
function state(messages: DavoMessageV1[]): DavoStateV1 {
  return {
    schemaVersion: 1,
    logicalConversationId: 'conversation-1',
    retention: {
      generation: 3,
      lastCompletedSweepDate: '2026-11-05',
      retainedFrom: '2026-11-03T08:00:00.000Z',
      contextRevision: 'context-1'
    },
    nextSequence: messages.length + 1,
    messages,
    requests: [],
    providerCalls: [],
    operations: [],
    remoteGrants: [],
    notificationOutbox: []
  };
}

// build one complete retained turn
function turn(sequence: number, text: string): DavoMessageV1[] {
  const createdAt = `2026-11-05T12:00:0${sequence}.000Z`;
  const userId = `user-${sequence}`;
  const base = {
    conversationId: 'conversation-1',
    generation: 3,
    createdAt,
    localDate: '2026-11-05',
    retentionAnchorAt: createdAt,
    retentionAnchorLocalDate: '2026-11-05'
  };
  return [
    { ...base, sequence: sequence * 2 - 1, id: userId, kind: 'user', text, source: { kind: 'user-transcript', voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: `item-${sequence}` } },
    { ...base, sequence: sequence * 2, id: `assistant-${sequence}`, kind: 'assistant', text: `answer ${text}`, source: { kind: 'assistant-final', voiceSessionId: 'voice-1', responseId: `response-${sequence}`, inReplyToMessageId: userId } }
  ];
}

// verify retained-only context construction
describe('davo context', () => {
  // retain newest whole turns without slicing
  it('builds a deterministic newest-whole-turn fallback', () => {
    const value = state([...turn(1, 'old'), ...turn(2, 'new')]);
    const first = buildFallbackContext(value, 50);
    const second = buildFallbackContext(structuredClone(value), 50);
    expect(first).toEqual(second);
    expect(first.sourceMessageIds).toEqual(['user-2', 'assistant-2']);
    expect(first.text).not.toContain('old');
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(50);
    expect(value.messages).toHaveLength(4);
  });

  // reject an oversized required current turn
  it('fails before inference when required context cannot fit', () => {
    const value = state(turn(1, 'retained'));
    expect(() => buildLiveContext(value, { currentTurn: 'x'.repeat(12_289) })).toThrowError(expect.objectContaining<DavoContextError>({ code: 'davo_context_capacity' }));
  });

  // leave exact caller-owned bytes outside the live projection
  it('reserves bounded response framing without padding', () => {
    const value = state([...turn(1, 'x'.repeat(2_000)), ...turn(2, 'y'.repeat(2_000))]);
    const projected = buildLiveContext(value, { currentTurn: 'current', reservedBytes: 4_096 });
    expect(Buffer.byteLength(projected.text)).toBeLessThanOrEqual(40_960 - 4_096);
    expect(projected.text.endsWith(' '.repeat(4_096))).toBe(false);
    expect(() => buildLiveContext(value, { currentTurn: 'current', reservedBytes: 16_385 })).toThrowError(expect.objectContaining<DavoContextError>({ code: 'davo_context_capacity' }));
  });

  // omit prior summaries from compactor input
  it('builds bounded raw compactor input and validates exact provenance', () => {
    const value = state(turn(1, 'retained'));
    value.retention.context = { generation: 3, builtAt: '2026-11-05T12:00:00.000Z', sourceMessageIds: ['user-old'], sourceRetentionAnchorDates: ['2026-11-03'], text: 'hostile old summary' };
    const source = buildCompactorSource(value);
    expect(source.text).not.toContain('hostile old summary');
    const accepted = acceptCompactedContext(value, {
      generation: 3,
      builtAt: '2026-11-05T12:00:10.000Z',
      sourceMessageIds: source.sourceMessageIds,
      sourceRetentionAnchorDates: source.sourceRetentionAnchorDates,
      text: 'safe summary'
    }, source.sourceMessageIds);
    expect(accepted.text).toBe('safe summary');
    expect(Buffer.byteLength(accepted.text)).toBeLessThanOrEqual(DAVO_CONTEXT_MAX_BYTES);
    expect(() => acceptCompactedContext(value, { ...accepted, sourceMessageIds: ['assistant-1'] }, source.sourceMessageIds)).toThrowError();
  });
});
