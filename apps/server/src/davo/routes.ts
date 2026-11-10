import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DavoRuntime } from './runtime.js';

const generation = z.number().int().safe().nonnegative();
const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const voice = { voiceSessionId: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/u), generation };
const openSchema = z.object({ ...voice, worktreeId: id.optional(), agentId: id.optional() }).strict();
const negotiateSchema = z.object({ ...voice, negotiationId: id, sdp: z.string().min(1).max(256 * 1024) }).strict();
const userSchema = z.object({ ...voice, providerSessionId: id, providerItemId: id, text: z.string().min(1).max(12 * 1024) }).strict();
const bindSchema = z.object({ ...voice, turnId: id, responseId: id }).strict();
// constrain provider mcp references at the route boundary
const mcpContinuationSchema = bindSchema.extend({ itemIds: z.array(id).min(1).max(16).refine(values => new Set(values).size === values.length) }).strict();
const assistantSchema = bindSchema.extend({ messageId: id, text: z.string().min(1).max(48 * 1024) }).strict();
const finishSchema = z.object({ ...voice, turnId: id, responseId: id.optional() }).strict();
type Options = { runtime: DavoRuntime; subject: (request: FastifyRequest, write: boolean) => string; enabled: () => boolean };

// expose controller-bound transport and durable conversation receipts
export function registerDavoRoutes(app: FastifyInstance, options: Options): void {
  const { runtime } = options;
  // expose only authenticated aggregate diagnostics
  app.get('/api/davo/status', async request => { options.subject(request, false); return runtime.status(); });
  // project retained history without write or microphone authority
  app.get('/api/davo/conversation', async (request, reply) => {
    options.subject(request, false);
    const parsed = z.object({ beforeSequence: z.coerce.number().int().positive().optional(), afterSequence: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(request.query);
    // reject malformed cursors before loading history
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try { return await runtime.conversation(parsed.data); }
    catch { return reply.code(503).send({ error: 'davo_store_unavailable' }); }
  });

  // share exact validation and safe failures across audio receipts
  function post<T>(path: string, schema: z.ZodType<T>, effect: (ownerId: string, input: T) => unknown | Promise<unknown>, stop = false): void {
    app.post(path, { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
      const ownerId = options.subject(request, true);
      // stopping remains possible when feature configuration changes
      if (!stop && !options.enabled()) return reply.code(503).send({ error: 'davo_unavailable' });
      const parsed = schema.safeParse(request.body);
      // malformed receipts never create inference or tool authority
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const result = await effect(ownerId, parsed.data) ?? { ok: true };
        // recovery receipts acknowledge uncertainty without authorizing inference
        if (typeof result === 'object' && result !== null && 'pending' in result && result.pending === true) return reply.code(202).send(result);
        return result;
      }
      catch (error) {
        runtime.recordFailure(error);
        const code = error instanceof Error && /^(?:davo_[a-z_]+|unavailable|provider_error)$/u.test(error.message) ? error.message : 'davo_unavailable';
        return reply.code(code === 'davo_generation_changed' || code === 'davo_response_active' || code === 'davo_turn_changed' ? 409 : 503).send({ error: code });
      }
    });
  }

  post('/api/realtime/session', openSchema, (owner, input) => runtime.open(owner, input));
  post('/api/realtime/negotiate', negotiateSchema, (owner, input) => runtime.negotiate(owner, input));
  post('/api/davo/session/ready', z.object({ ...voice, readinessId: id, responseId: id, importedTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u)).min(0).max(256) }).strict(), (owner, input) => runtime.acknowledgeReady(owner, input));
  post('/api/realtime/session/heartbeat', z.object(voice).strict(), (owner, input) => runtime.heartbeat(owner, input));
  post('/api/realtime/session/stop', z.object(voice).strict(), (owner, input) => runtime.stop(owner, input), true);
  post('/api/davo/transcripts/user', userSchema, (owner, input) => runtime.admit(owner, input));
  post('/api/davo/responses/bind', bindSchema, (owner, input) => runtime.bind(owner, input));
  post('/api/davo/responses/continue', bindSchema.extend({ callId: id, worktreeId: id }).strict(), (owner, input) => runtime.continue(owner, input));
  post('/api/davo/responses/mcp', mcpContinuationSchema, (owner, input) => runtime.continueMcp(owner, input));
  post('/api/davo/transcripts/assistant', assistantSchema, (owner, input) => runtime.assistant(owner, input));
  post('/api/davo/responses/finish', finishSchema, (owner, input) => runtime.finish(owner, input));
}
