import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ReplySuggestionService } from './service.js';

type Options = {
  service: ReplySuggestionService;
  admit(request: FastifyRequest): () => boolean;
  exists(id: string): Promise<boolean>;
  rateKey(request: FastifyRequest): string;
};

// expose bounded draft generation without accepting executable browser input
export function registerReplySuggestionRoutes(app: FastifyInstance, options: Options): void {
  app.post('/api/agents/:id/reply-suggestions', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: options.rateKey } } }, async (request, reply) => {
    const authorized = options.admit(request);
    const data = request.body;
    // accept only an opaque server-issued source locator
    if (data === null || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !('sourceKey' in data)
      || typeof data.sourceKey !== 'string' || data.sourceKey.length === 0 || data.sourceKey.length > 128) return reply.code(400).send({ error: 'invalid suggestion source' });
    const id = (request.params as { id: string }).id;
    // missing Agents are distinct from unsupported login capabilities
    if (!await options.exists(id)) return reply.code(404).send({ error: 'target unavailable' });
    // asynchronous target resolution cannot renew a displaced reservation
    if (!authorized()) return reply.code(403).send({ error: 'suggestion authority changed' });
    const observed = await options.service.observe(id);
    // never return cached data after logout or takeover
    if (!authorized()) return reply.code(403).send({ error: 'suggestion authority changed' });
    // unsupported routes leave the normal composer usable without a fallback
    if (observed === undefined) return { sourceKey: data.sourceKey, suggestions: [] };
    const result = await options.service.request(id, data.sourceKey, authorized);
    // source transitions and authorization loss never return old output
    if (result.status === 'denied') return reply.code(403).send({ error: 'suggestion authority changed' });
    if (result.status === 'stale') return reply.code(409).send({ error: 'suggestion source changed' });
    return { sourceKey: result.sourceKey, suggestions: result.suggestions };
  });
}
