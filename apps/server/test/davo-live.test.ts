import { describe, expect, it } from 'vitest';
import { DavoLive } from '../src/davo/live.js';

describe('DavoLive', () => {
  it('binds one response and rejects overlap, stale turns and replayed target authority', async () => {
    let generation = 3;
    const live = new DavoLive({ generation: () => generation, authorize: key => key === 'lease', now: () => 1000 });
    live.open({ voiceSessionId: 'voice', leaseKey: 'lease', ownerHash: 'a'.repeat(64), generation: 3, hardCutoffAt: 3000 });
    const turn = live.admit({ voiceSessionId: 'voice', generation: 3, messageId: 'message', providerItemId: 'item' });
    expect(() => live.admit({ voiceSessionId: 'voice', generation: 3, messageId: 'other', providerItemId: 'other' })).toThrow('davo_response_active');
    expect(() => live.authorize('lease', turn.capability, 'response')).toThrow('davo_response_unbound');
    live.bind('voice', 3, turn.id, 'response');
    expect(live.authorize('lease', turn.capability, 'response').messageId).toBe('message');
    const target = live.bindTarget('lease', turn.capability, 'response', { agentId: 'agent', worktreeId: 'worktree' });
    live.consumeTarget('lease', turn.capability, 'response', target, 'operation-a');
    live.consumeTarget('lease', turn.capability, 'response', target, 'operation-a');
    expect(() => live.consumeAction('lease', turn.capability, 'operation-a', 'different-tool-or-arguments')).toThrow('davo_capability_replayed');
    expect(() => live.consumeTarget('lease', turn.capability, 'response', target, 'operation-b')).toThrow('davo_capability_replayed');
    generation = 4;
    expect(() => live.authorize('lease', turn.capability, 'response')).toThrow('davo_generation_changed');
  });

  it('waits for the exact response-created receipt without adopting a newer turn', async () => {
    const live = new DavoLive({ generation: () => 1, authorize: () => true });
    live.open({ voiceSessionId: 'voice', leaseKey: 'lease', ownerHash: 'a'.repeat(64), generation: 1, hardCutoffAt: Date.now() + 10000 });
    const turn = live.admit({ voiceSessionId: 'voice', generation: 1, messageId: 'message', providerItemId: 'item' });
    const pending = live.awaitCapability('lease', turn.capability);
    live.bind('voice', 1, turn.id, 'response');
    expect((await pending).responseId).toBe('response');
  });

  it('revokes stopped responses and never reassigns an old callback', () => {
    const live = new DavoLive({ generation: () => 1, authorize: () => true, now: () => 1000 });
    live.open({ voiceSessionId: 'voice', leaseKey: 'lease', ownerHash: 'b'.repeat(64), generation: 1, hardCutoffAt: 3000 });
    const first = live.admit({ voiceSessionId: 'voice', generation: 1, messageId: 'first', providerItemId: 'first' });
    live.bind('voice', 1, first.id, 'response-1');
    live.finish('voice', 1, first.id, 'response-1');
    const second = live.admit({ voiceSessionId: 'voice', generation: 1, messageId: 'second', providerItemId: 'second' });
    expect(() => live.bind('voice', 1, first.id, 'late')).toThrow('davo_turn_changed');
    expect(() => live.authorize('lease', first.capability, 'response-1')).toThrow('davo_turn_changed');
    live.bind('voice', 1, second.id, 'response-2');
    live.close('voice');
    expect(() => live.authorize('lease', second.capability, 'response-2')).toThrow('davo_voice_inactive');
  });
});
