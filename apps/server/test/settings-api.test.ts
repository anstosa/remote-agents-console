import { afterEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { registerSettingsRoutes } from '../src/settings/routes.js';

const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };
const apps: FastifyInstance[] = [];

// close each isolated settings API fixture
afterEach(async () => {
  // release every server created by the current test
  for (const app of apps.splice(0)) await app.close();
});

// create a complete redacted service double
function settingsDouble() {
  const snapshot = vi.fn(async (controller = true, _sessionId?: string) => ({ version: 1 as const, revisionId: 'opaque-snapshot', sources: [{ id: 'app', label: 'Application configuration', format: 'json' as const, exists: true, writable: controller, protected: false, tracked: false, revisionId: 'opaque-app', apply: 'rac-restart' as const, ...(controller ? { content: '{\n  "name": "Remote Agents"\n}\n', value: { editor: '/usr/bin/nvim' } } : {}), hasProtectedContent: false }], status: { pending: true, targets: ['rac' as const], effective: 'unknown' as const, restartAvailable: true } }));
  return {
    snapshot,
    status: vi.fn(async () => ({ pending: true, targets: ['rac' as const], effective: 'unknown' as const, restartAvailable: true })),
    validate: vi.fn(async () => ({ valid: true, issues: [] })),
    save: vi.fn(async () => await snapshot(true)),
    reveal: vi.fn(async () => ({ value: 'selected secret', revisionId: 'opaque-app', leaseId: 'opaque-disclosure-lease', expiresAt: '2026-10-10T20:00:00.000Z' })),
    remask: vi.fn(async () => ({ ok: true as const })),
    restart: vi.fn(async () => ({ id: 'settings_restart_operation', state: 'queued' as const })),
    operation: vi.fn(async () => undefined),
    updateApplication: vi.fn(async () => undefined)
  };
}

// log in one independent browser session
async function login(app: FastifyInstance) {
  const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { cookie: String(response.headers['set-cookie']).split(';')[0], csrf: response.json().csrfToken as string };
}

describe('settings browser API authorization', () => {
  // bind established live preference routes to the controlling browser session
  it('passes controller identity through legacy name, default, and voice writes', async () => {
    const service = settingsDouble();
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const routeConfig = { ...config, adapters: { codex: { program: '/bin/codex', args: [], env: {}, launchable: true } } };
    const app = await buildApp(routeConfig, { auth: new AuthService(hash, Buffer.alloc(32, 40).toString('base64url')), settings: service as never });
    apps.push(app);
    const browser = await login(app);
    const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: browser.cookie, 'x-csrf-token': browser.csrf };

    const name = await app.inject({ method: 'PATCH', url: '/api/server/name', headers, payload: { name: 'Garage Server' } });
    const defaultAgent = await app.inject({ method: 'PATCH', url: '/api/server/default-agent', headers, payload: { kind: 'codex' } });
    const davo = await app.inject({ method: 'PATCH', url: '/api/server/davo', headers, payload: { enabled: false, name: 'Riley', context: 'Direct and dry.' } });

    expect([name.statusCode, defaultAgent.statusCode, davo.statusCode]).toEqual([200, 200, 200]);
    expect(service.updateApplication).toHaveBeenCalledTimes(3);
    const sessionIds = service.updateApplication.mock.calls.map(([, sessionId]) => sessionId);
    expect(sessionIds.every(sessionId => typeof sessionId === 'string' && sessionId === sessionIds[0])).toBe(true);
  }, 15_000);

  // require a canonical browser session while preserving redacted observer reads
  it('rejects wrong-host, anonymous, and bearer-only reads', async () => {
    const service = settingsDouble();
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 41).toString('base64url')), settings: service as never });
    apps.push(app);
    const browser = await login(app);
    const readOnly = await login(app);

    const wrongHost = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'evil.example', cookie: browser.cookie } });
    const anonymous = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'agents.example.com' } });
    const bearerOnly = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'agents.example.com', authorization: 'Bearer integration-token' } });
    const observer = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'agents.example.com', cookie: readOnly.cookie } });

    expect(wrongHost).toMatchObject({ statusCode: 403 });
    expect(wrongHost.json()).toEqual({ error: 'forbidden' });
    expect(anonymous).toMatchObject({ statusCode: 401 });
    expect(bearerOnly).toMatchObject({ statusCode: 401 });
    expect(observer).toMatchObject({ statusCode: 200, headers: { 'cache-control': 'no-store' } });
    expect(observer.body).not.toContain('selected secret');
    expect(observer.json().sources[0]).not.toHaveProperty('content');
    expect(observer.json().sources[0]).not.toHaveProperty('value');
    expect(service.snapshot).toHaveBeenLastCalledWith(false, undefined);
  }, 15_000);

  // require Host, Origin, CSRF, and active controller authority for every mutation
  it('blocks hostile mutations before invoking the settings service', async () => {
    const service = settingsDouble();
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 42).toString('base64url')), settings: service as never });
    apps.push(app);
    const first = await login(app);
    const second = await login(app);
    const payload = { changes: [{ sourceId: 'app', revisionId: 'opaque-app', patches: [{ op: 'set', path: ['name'], value: 'Changed' }] }] };

    const anonymous = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { host: 'agents.example.com', origin: 'https://agents.example.com' }, payload });
    const missingOrigin = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { host: 'agents.example.com', cookie: first.cookie, 'x-csrf-token': first.csrf }, payload });
    const missingCsrf = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie }, payload });
    const accepted = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie, 'x-csrf-token': first.csrf }, payload });
    const inactive = await app.inject({ method: 'POST', url: '/api/settings/restart', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.csrf }, payload: {} });

    expect(anonymous.statusCode).toBe(401);
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingCsrf.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(inactive.statusCode).toBe(423);
    expect(inactive.json()).toEqual({ error: 'another client is active' });
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(service.save).toHaveBeenCalledWith(payload, expect.any(String));
    expect(service.restart).not.toHaveBeenCalled();

    const controller = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'agents.example.com', cookie: first.cookie } });
    const observer = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'agents.example.com', cookie: second.cookie } });
    expect(controller.json().sources[0].writable).toBe(true);
    expect(observer.json().sources[0].writable).toBe(false);
    expect(service.snapshot.mock.calls.some(([writable, sessionId]) => writable === true && typeof sessionId === 'string')).toBe(true);
  }, 15_000);

  // reject unknown request controls without forwarding attacker-selected fields
  it('accepts only the fixed settings request vocabulary', async () => {
    const service = settingsDouble();
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 43).toString('base64url')), settings: service as never });
    apps.push(app);
    const browser = await login(app);
    const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: browser.cookie, 'x-csrf-token': browser.csrf };

    const restart = await app.inject({ method: 'POST', url: '/api/settings/restart', headers, payload: { command: 'docker compose down' } });
    const reveal = await app.inject({ method: 'POST', url: '/api/settings/reveal', headers, payload: { sourceId: 'app', revisionId: 'opaque-app', path: ['editor'], hostPath: '/etc/shadow' } });
    const malformed = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"changes":[{"value":"sensitive parser body"}' });

    expect(restart).toMatchObject({ statusCode: 400, headers: { 'cache-control': 'no-store' } });
    expect(restart.json()).toEqual({ error: 'invalid_settings_request' });
    expect(reveal.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('sensitive parser body');
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.reveal).not.toHaveBeenCalled();
  }, 15_000);
});

describe('settings reveal takeover boundary', () => {
  // discard a controller snapshot when ownership changes during host reads
  it('does not return controller-only snapshot values after a mid-request takeover', async () => {
    const app = Fastify();
    apps.push(app);
    let finishSnapshot: (() => void) | undefined;
    const base = settingsDouble();
    const snapshot = vi.fn(async () => await new Promise<Awaited<ReturnType<typeof base.snapshot>>>(resolve => {
      finishSnapshot = () => resolve({ version: 1, revisionId: 'opaque-snapshot', sources: [{ id: 'app', label: 'Application configuration', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'opaque-app', apply: 'rac-restart', content: 'private controller value', hasProtectedContent: false }], status: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    }));
    let controllerChecks = 0;
    await registerSettingsRoutes(app, {
      service: { ...base, snapshot } as never,
      session: () => ({ id: 'session-one' }) as never,
      controlled: () => ({ id: 'session-one' }) as never,
      isController: () => { controllerChecks += 1; return controllerChecks === 1; }
    });

    const pending = app.inject({ method: 'GET', url: '/api/settings' });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    finishSnapshot!();
    const response = await pending;

    expect(response.statusCode).toBe(423);
    expect(response.json()).toEqual({ error: 'another client is active' });
    expect(response.body).not.toContain('private controller value');
  });

  // discard disclosed bytes when controller ownership changes during host retrieval
  it('remasks and returns only a bounded error after a mid-request takeover', async () => {
    const app = Fastify();
    apps.push(app);
    const remask = vi.fn(async () => ({ ok: true as const }));
    const service = {
      ...settingsDouble(),
      reveal: vi.fn(async () => ({ value: 'must not escape', revisionId: 'opaque-app', leaseId: 'takeover-lease', expiresAt: '2026-10-10T20:00:00.000Z' })),
      remask
    };
    await registerSettingsRoutes(app, {
      service: service as never,
      session: () => ({ id: 'session-one' }) as never,
      controlled: () => ({ id: 'session-one' }) as never,
      isController: () => false
    });

    const response = await app.inject({ method: 'POST', url: '/api/settings/reveal', payload: { sourceId: 'app', revisionId: 'opaque-app', path: ['editor'] } });

    expect(response).toMatchObject({ statusCode: 423, headers: { 'cache-control': 'no-store' } });
    expect(response.json()).toEqual({ error: 'another client is active' });
    expect(response.body).not.toContain('must not escape');
    expect(remask).toHaveBeenCalledExactlyOnceWith('takeover-lease', 'session-one');
  });

  // map unexpected service failures to one secret-free availability error
  it('does not serialize thrown messages, stacks, or source values', async () => {
    const app = Fastify();
    apps.push(app);
    const service = { ...settingsDouble(), status: vi.fn(async () => { throw new Error('private path /host/config with secret sentinel'); }) };
    await registerSettingsRoutes(app, {
      service: service as never,
      session: () => ({ id: 'session-one' }) as never,
      controlled: () => ({ id: 'session-one' }) as never,
      isController: () => true
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings/status' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'settings_unavailable' });
    expect(response.body).not.toMatch(/private path|secret sentinel/u);
  });
});
