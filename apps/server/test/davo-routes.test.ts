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
