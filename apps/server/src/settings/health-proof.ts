import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// prove a public tunnel reaches this boot without exposing session credentials
export function registerHealthRoute(app: FastifyInstance): void {
  const key = randomBytes(32);
  app.get('/healthz', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const challenge = (request.query as Record<string, unknown>).racChallenge;
    // preserve ordinary readiness checks
    if (challenge === undefined) return { ok: true };
    // keep the public proof oracle bounded and domain-separated
    if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/u.test(challenge)) return reply.code(400).send({ error: 'invalid_health_challenge' });
    return { ok: true, proof: createHmac('sha256', key).update(`rac-cloudflare-route-v1:${challenge}`).digest('hex') };
  });
}
