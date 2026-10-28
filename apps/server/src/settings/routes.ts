import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from '../auth/service.js';
import { SettingsError, type SettingsInput } from './contracts.js';
import { safePath } from './patches.js';
import type { SettingsService } from './service.js';

export type SettingsRoutes = { service: Pick<SettingsService, 'snapshot' | 'status' | 'validate' | 'save' | 'reveal' | 'remask' | 'restart' | 'operation' | 'cloudflareStatus' | 'configureCloudflare' | 'tunnelHealth' | 'reconnectCloudflare'>; session: (request: FastifyRequest, mutation?: boolean) => Session; controlled: (request: FastifyRequest, mutation?: boolean) => Session; isController: (sessionId: string) => boolean };
// require one bounded exact JSON body
function body(request: FastifyRequest, keys?: string[]): Record<string, unknown> {
  const value = request.body;
  // reject unknown controls before they reach fixed helpers
  if (value === null || typeof value !== 'object' || Array.isArray(value) || keys !== undefined && Object.keys(value).some(key => !keys.includes(key))) throw new SettingsError('invalid_settings_request');
  return value as Record<string, unknown>;
}
// contain every settings failure without echoing source text
function endpoint(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await handler(request, reply); }
    catch (error) {
      const failure = error as { statusCode?: number };
      // keep existing authentication status without its arbitrary message
      if ([401, 403, 423].includes(failure.statusCode ?? 0)) return reply.code(failure.statusCode!).send({ error: failure.statusCode === 423 ? 'another client is active' : failure.statusCode === 401 ? 'unauthorized' : 'forbidden' });
      // publish only bounded settings codes and field identities
      if (error instanceof SettingsError) return reply.code(error.statusCode).send({ error: error.code, ...(error.issues.length > 0 ? { issues: error.issues } : {}) });
      return reply.code(503).send({ error: 'settings_unavailable' });
    }
  };
}
// expose settings only to authenticated browser sessions
export async function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutes): Promise<void> {
  const mutation = { bodyLimit: 2_097_152, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.get('/api/settings', endpoint(async request => {
    const session = deps.session(request); const controller = deps.isController(session.id);
    const snapshot = await deps.service.snapshot(controller, controller ? session.id : undefined);
    // discard controller-only values after an ownership change during host reads
    if (controller && !deps.isController(session.id)) throw new SettingsError('another_client_is_active', 423);
    return snapshot;
  }));
  app.get('/api/settings/status', endpoint(async request => { deps.session(request); return await deps.service.status(); }));
  app.get('/api/settings/cloudflare', endpoint(async request => { deps.session(request); return await deps.service.cloudflareStatus(); }));
  app.get('/api/settings/cloudflare/health', endpoint(async request => { deps.session(request); return await deps.service.tunnelHealth(); }));
  app.get('/api/settings/operations/:id', endpoint(async (request, reply) => { deps.session(request); const operation = await deps.service.operation((request.params as { id: string }).id); return operation ?? reply.code(404).send({ error: 'settings_operation_unavailable' }); }));
  app.post('/api/settings/validate', mutation, endpoint(async request => { const session = deps.controlled(request, true); return await deps.service.validate(body(request, ['changes']) as SettingsInput, session.id); }));
  app.patch('/api/settings', mutation, endpoint(async request => {
    const session = deps.controlled(request, true); const snapshot = await deps.service.save(body(request, ['changes']) as SettingsInput, session.id);
    // never return the post-save controller snapshot after a takeover
    if (!deps.isController(session.id)) throw new SettingsError('another_client_is_active', 423);
    return snapshot;
  }));
  app.post('/api/settings/reveal', mutation, endpoint(async request => {
    const session = deps.controlled(request, true); const input = body(request, ['sourceId', 'revisionId', 'path']);
    // bind exact source and optional selected field
    if (typeof input.sourceId !== 'string' || typeof input.revisionId !== 'string' || input.path !== undefined && !safePath(input.path)) throw new SettingsError('invalid_settings_request');
    const result = await deps.service.reveal({ sourceId: input.sourceId, revisionId: input.revisionId, ...(input.path === undefined ? {} : { path: input.path as string[] }) }, session.id);
    // prevent a takeover during host disclosure from releasing protected bytes
    if (!deps.isController(session.id)) { await deps.service.remask(result.leaseId, session.id); throw new SettingsError('another_client_is_active', 423); }
    return result;
  }));
  app.post('/api/settings/remask', mutation, endpoint(async request => { const session = deps.controlled(request, true); const input = body(request, ['leaseId']); if (typeof input.leaseId !== 'string') throw new SettingsError('invalid_settings_request'); return await deps.service.remask(input.leaseId, session.id); }));
  app.post('/api/settings/restart', mutation, endpoint(async request => { deps.controlled(request, true); body(request, []); return await deps.service.restart(); }));
  app.post('/api/settings/cloudflare', mutation, endpoint(async (request, reply) => {
    const session = deps.controlled(request, true); const input = body(request, ['action', 'hostname', 'token']);
    const result = await deps.service.configureCloudflare(input);
    // discard operation details after a controller takeover
    if (!deps.isController(session.id)) throw new SettingsError('another_client_is_active', 423);
    return reply.code(202).send(result);
  }));
  app.post('/api/settings/cloudflare/reconnect', mutation, endpoint(async (request, reply) => {
    deps.controlled(request, true); body(request, []);
    return reply.code(202).send(await deps.service.reconnectCloudflare());
  }));
  app.post('/api/settings/password/hash', { bodyLimit: 16_384, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, endpoint(async request => {
    const session = deps.controlled(request, true); const input = body(request, ['password']);
    // retain replacement passwords only in request memory
    if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 4096 || input.password.includes('\0')) throw new SettingsError('invalid_password');
    const hash = await argon2.hash(input.password, { type: argon2.argon2id });
    if (!await argon2.verify(hash, input.password) || !deps.isController(session.id)) throw new SettingsError('password_preparation_failed', 423);
    return { hash };
  }));
}
