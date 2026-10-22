import argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { ConfiguredButtonCatalog } from '../src/button-actions/catalog.js';
import { ButtonActionError, type ButtonActionService, type ButtonOperation } from '../src/button-actions/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = {
  name: 'Remote Agents',
  remoteServers: [],
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(['127.0.0.1']),
  pollIntervalMs: 500,
  adapters: {},
  projects: []
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// close every isolated application fixture
afterEach(async () => {
  // close only apps created by this file
  for (const app of apps.splice(0)) await app.close();
});

// authenticate one independent browser session
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0],
    csrf: response.json().csrfToken as string,
    headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string }
  };
}

describe('button action API boundary', () => {
  // enforce authentication, controller, Origin, CSRF and strict request shape
  it('starts and reads only server-resolved actions for the owning browser', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const catalog = new ConfiguredButtonCatalog(config, Buffer.alloc(32, 9));
    const operation: ButtonOperation = { id: 'operation_123456789012345678901234', state: 'queued' };
    let owner = '';
    const start = vi.fn(async (sessionId: string) => { owner = sessionId; return operation; });
    const status = vi.fn(async (sessionId: string, id: string) => {
      // hide operation identity across sessions
      if (sessionId !== owner || id !== operation.id) throw new ButtonActionError('button_action_unavailable', 404);
      return operation;
    });
    const close = vi.fn();
    const buttonActions = { catalog, start, status, close } as unknown as ButtonActionService;
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), buttonActions });
    apps.push(app);
    const first = await login(app);
    const request = {
      requestId: 'request_123456',
      actionId: catalog.value.application.pullRequest[0]!.id,
      configRevision: catalog.value.revision,
      placeId: 'project:/workspace',
      slot: 'pullRequest'
    };

    const unauthenticated = await app.inject({ method: 'POST', url: '/api/button-actions', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': first.csrf }, payload: request });
    expect(unauthenticated.statusCode).toBe(401);
    const foreignOrigin = await app.inject({ method: 'POST', url: '/api/button-actions', headers: { ...first.headers, origin: 'https://foreign.example.com' }, payload: request });
    expect(foreignOrigin.statusCode).toBe(403);
    const missingCsrf = await app.inject({ method: 'POST', url: '/api/button-actions', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie }, payload: request });
    expect(missingCsrf.statusCode).toBe(403);

    const injected = await app.inject({ method: 'POST', url: '/api/button-actions', headers: first.headers, payload: { ...request, cwd: '/tmp', shellCommand: 'rm -rf /' } });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toEqual({ error: 'invalid_button_action' });
    expect(start).not.toHaveBeenCalled();

    const started = await app.inject({ method: 'POST', url: '/api/button-actions', headers: first.headers, payload: request });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ operation });
    expect(start).toHaveBeenCalledTimes(1);

    const read = await app.inject({ method: 'GET', url: `/api/button-actions/${operation.id}`, headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ operation });
    const malformed = await app.inject({ method: 'GET', url: '/api/button-actions/not-valid', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual({ error: 'button_action_unavailable' });

    const second = await login(app);
    const foreign = await app.inject({ method: 'GET', url: `/api/button-actions/${operation.id}`, headers: { host: 'agents.example.com', cookie: second.cookie } });
    expect(foreign.statusCode).toBe(423);
    expect(foreign.body).not.toContain(owner);
    expect(status).toHaveBeenCalledTimes(1);

    const nonController = await app.inject({ method: 'POST', url: '/api/button-actions', headers: second.headers, payload: { ...request, requestId: 'request_second' } });
    expect(nonController.statusCode).toBe(423);
    expect(start).toHaveBeenCalledTimes(1);
  }, 20_000);

  // expose only bounded service errors
  it('maps action failures without leaking trusted definitions', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const catalog = new ConfiguredButtonCatalog(config, Buffer.alloc(32, 10));
    const start = vi.fn(async () => { throw new ButtonActionError('stale_button_configuration'); });
    const status = vi.fn(async () => { throw new ButtonActionError('button_action_status_unavailable', 503); });
    const buttonActions = { catalog, start, status, close: vi.fn() } as unknown as ButtonActionService;
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), buttonActions });
    apps.push(app);
    const browser = await login(app);
    const response = await app.inject({ method: 'POST', url: '/api/button-actions', headers: browser.headers, payload: {
      requestId: 'request_123456',
      actionId: catalog.value.application.pullRequest[0]!.id,
      configRevision: catalog.value.revision,
      placeId: 'project:/workspace',
      slot: 'pullRequest'
    } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'stale_button_configuration' });
    expect(response.body).not.toContain('review, commit, and push');

    const unavailable = await app.inject({ method: 'GET', url: '/api/button-actions/operation_123456789012345678901234', headers: { host: 'agents.example.com', cookie: browser.cookie } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'button_action_status_unavailable' });
  }, 20_000);
});
