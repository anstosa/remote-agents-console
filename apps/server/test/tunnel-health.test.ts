import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHealthRoute } from '../src/settings/health-proof.js';

const applications: ReturnType<typeof Fastify>[] = [];
// release isolated health servers
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });

// create an independent boot identity without application state
function application() {
  const app = Fastify();
  registerHealthRoute(app);
  applications.push(app);
  return app;
}

describe('tunnel health proof', () => {
  // preserve the ordinary health contract
  it('keeps ordinary health unchanged and noncacheable', async () => {
    const response = await application().inject('/healthz');
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  // tie one route check to one boot and random challenge
  it('returns the same proof only for the same instance and challenge', async () => {
    const app = application();
    const challenge = 'a'.repeat(64);
    const first = (await app.inject(`/healthz?racChallenge=${challenge}`)).json();
    const repeated = (await app.inject(`/healthz?racChallenge=${challenge}`)).json();
    const different = (await app.inject(`/healthz?racChallenge=${'b'.repeat(64)}`)).json();
    const other = (await application().inject(`/healthz?racChallenge=${challenge}`)).json();
    expect(first).toEqual({ ok: true, proof: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(repeated).toEqual(first);
    expect(different.proof).not.toBe(first.proof);
    expect(other.proof).not.toBe(first.proof);
  });
  // reject unbounded or ambiguous challenge representations
  it.each(['short', 'A'.repeat(64), 'a'.repeat(65), `${'a'.repeat(64)}&racChallenge=${'b'.repeat(64)}`])('rejects an invalid challenge', async challenge => {
    const response = await application().inject(`/healthz?racChallenge=${challenge}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_health_challenge' });
  });
});
