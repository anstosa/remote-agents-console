import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerDavoRoutes } from '../src/davo/routes.js';

// preserve the distinction between a proven admission and pending recovery
it.each([false, true])('returns the exact admission disposition when pending=%s', async pending => {
  const receipt = pending
    ? { ok: true, pending: true, messageId: 'message-1', generation: 0 }
    : { ok: true, pending: false, messageId: 'message-1', turnId: 'turn-1', generation: 0, response: { conversation: 'none', tools: [] } };
  const admit = vi.fn().mockResolvedValue(receipt);
  const app = Fastify();
  registerDavoRoutes(app, { runtime: { admit } as never, subject: () => 'owner-1', enabled: () => true });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/davo/transcripts/user', payload: { voiceSessionId: 'voice-session-1234567890', generation: 0, providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'spoken input' } });
    expect(result.statusCode).toBe(pending ? 202 : 200);
    expect(result.json()).toEqual(receipt);
    expect(admit).toHaveBeenCalledOnce();
    // pending recovery grants no provider response or tool capability
    if (pending) expect(result.json()).not.toHaveProperty('response');
  } finally { await app.close(); }
});

// report provider cleanup uncertainty instead of a false stop success
it('returns a fixed failure when provider stop is ambiguous', async () => {
  const stop = vi.fn().mockRejectedValue(new Error('davo_provider_hangup_ambiguous'));
  const recordFailure = vi.fn();
  const app = Fastify();
  registerDavoRoutes(app, { runtime: { stop, recordFailure } as never, subject: () => 'owner-1', enabled: () => true });
  // exercise one stop receipt
  try {
    const result = await app.inject({ method: 'POST', url: '/api/realtime/session/stop', payload: { voiceSessionId: 'voice-session-1234567890', generation: 0 } });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: 'davo_provider_hangup_ambiguous' });
    expect(stop).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledOnce();
  } finally {
    // close the isolated route app
    await app.close();
  }
});

// pass an explicitly empty imported catalog to exact runtime readiness matching
it('accepts an empty readiness tool import at the route boundary', async () => {
  const acknowledgeReady = vi.fn().mockReturnValue({ ok: true });
  const app = Fastify();
  registerDavoRoutes(app, { runtime: { acknowledgeReady } as never, subject: () => 'owner-1', enabled: () => true });
  const input = { voiceSessionId: 'voice-session-1234567890', generation: 0, readinessId: 'readiness-1', responseId: 'response-1', importedTools: [] };
  try {
    const result = await app.inject({ method: 'POST', url: '/api/davo/session/ready', payload: input });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true });
    expect(acknowledgeReady).toHaveBeenCalledWith('owner-1', input);
  } finally { await app.close(); }
});

// admit only bounded unique provider item references
it('validates mcp continuation item identities before runtime dispatch', async () => {
  const receipt = { ok: true, messageId: 'message-1', turnId: 'turn-1', generation: 0, response: { conversation: 'none', input: [{ type: 'item_reference', id: 'mcp-item-1' }] } };
  const continueMcp = vi.fn().mockResolvedValue(receipt);
  const app = Fastify();
  registerDavoRoutes(app, { runtime: { continueMcp } as never, subject: () => 'owner-1', enabled: () => true });
  const base = { voiceSessionId: 'voice-session-1234567890', generation: 0, turnId: 'turn-1', responseId: 'response-1' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/davo/responses/mcp', payload: { ...base, itemIds: ['mcp-item-1'] } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(receipt);
    expect(continueMcp).toHaveBeenCalledWith('owner-1', { ...base, itemIds: ['mcp-item-1'] });

    const duplicate = await app.inject({ method: 'POST', url: '/api/davo/responses/mcp', payload: { ...base, itemIds: ['mcp-item-1', 'mcp-item-1'] } });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toEqual({ error: 'invalid_request' });
    expect(continueMcp).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});
