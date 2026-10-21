import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { PushService } from '../src/push-service.js';

const config: ValidatedConfig = { name: 'Push fixture', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };
const directories: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// release application resources before deleting their isolated stores
afterEach(async () => {
  // close every fixture server
  for (const app of apps.splice(0)) await app.close();
  // remove only private fixture directories
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// isolate managed identity creation from the running console
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-push-api-'));
  directories.push(directory);
  vi.stubEnv('RAC_PUSH_SUBSCRIPTIONS_FILE', join(directory, 'push-subscriptions.json'));
  vi.stubEnv('RAC_VAPID_PUBLIC_KEY', undefined);
  vi.stubEnv('RAC_VAPID_PRIVATE_KEY', undefined);
  const push = new PushService();
  const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
  const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 44).toString('base64url')), push });
  apps.push(app);
  const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
  expect(login.statusCode).toBe(200);
  const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
  return { app, directory, headers, push };
};

describe('managed push identity API', () => {
  // create credentials only behind authentication and disclose only the public half
  it('automatically registers browsers with one stable persisted public key', async () => {
    const { app, directory, headers, push } = await fixture();
    const anonymous = await app.inject({ method: 'GET', url: '/api/push/public-key', headers: { host: 'agents.example.com' } });
    expect(anonymous.statusCode).toBe(401);
    expect(push.enabled).toBe(false);
    await expect(readFile(join(directory, 'push-vapid.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const first = await app.inject({ method: 'GET', url: '/api/push/public-key', headers });
    const second = await app.inject({ method: 'GET', url: '/api/push/public-key', headers });
    const stored = JSON.parse(await readFile(join(directory, 'push-vapid.json'), 'utf8')) as { publicKey: string; privateKey: string };
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ publicKey: stored.publicKey });
    expect(second.json()).toEqual(first.json());
    expect(first.body).not.toContain(stored.privateKey);
    expect(push.enabled).toBe(true);

    const subscription = { endpoint: 'https://push.example.test/browser', keys: { auth: 'fixture-auth', p256dh: 'fixture-client-key' } };
    const registration = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: subscription });
    expect(registration.statusCode).toBe(204);
    expect(JSON.parse(await readFile(join(directory, 'push-subscriptions.json'), 'utf8'))).toEqual({ [subscription.endpoint]: subscription });
  }, 15_000);

  // preserve damaged credentials and keep storage failures outside the browser response
  it('preserves a damaged identity, returns a safe error, and recovers after repair', async () => {
    const { app, directory, headers } = await fixture();
    const file = join(directory, 'push-vapid.json');
    const corrupt = 'private-material-sentinel';
    await writeFile(file, corrupt, { mode: 0o600 });
    const response = await app.inject({ method: 'GET', url: '/api/push/public-key', headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'push_unavailable' });
    expect(response.body).not.toContain(corrupt);
    expect(response.body).not.toContain(directory);
    expect(await readFile(file, 'utf8')).toBe(corrupt);

    const restored = webpush.generateVAPIDKeys();
    await writeFile(file, JSON.stringify(restored), { mode: 0o600 });
    const recovered = await app.inject({ method: 'GET', url: '/api/push/public-key', headers });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ publicKey: restored.publicKey });
    expect(recovered.body).not.toContain(restored.privateKey);
  }, 15_000);
});
