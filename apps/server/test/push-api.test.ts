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
  vi.restoreAllMocks();
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

  // return exact content-free repair advice for provider-settled credential failures
  it.each([
    [410, 'push_subscription_expired'],
    [403, 'push_provider_auth_rejected']
  ] as const)('returns typed advice after provider status %i', async (statusCode, error) => {
    const { app, directory, headers, push } = await fixture();
    const registration = { endpoint: `https://push.example.test/provider-${statusCode}`, expirationTime: 1_800_000_000_000, keys: { auth: `auth-${statusCode}`, p256dh: `key-${statusCode}` } };
    expect((await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: registration })).statusCode).toBe(204);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(Object.assign(new Error('provider body sentinel'), { statusCode }));

    await push.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'agent-status-provider', url: '/' });
    const advice = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: registration });

    expect(advice.statusCode).toBe(409);
    expect(advice.json()).toEqual({ error });
    expect(advice.body).not.toContain(registration.endpoint);
    expect(advice.body).not.toContain(registration.keys.auth);
    const stored = JSON.parse(await readFile(join(directory, 'push-subscriptions.json'), 'utf8')) as Record<string, unknown>;
    expect(statusCode === 410 ? stored : stored[registration.endpoint]).toEqual(statusCode === 410 ? {} : registration);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('provider body sentinel');
  }, 15_000);

  // accept inactive authenticated receipts while enforcing Origin, CSRF, size, and schema
  it('ingests bounded receipts for an inactive signed session', async () => {
    const { app, headers, push } = await fixture();
    const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
    const inactiveLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
    expect(inactiveLogin.json().active).toBe(false);
    const inactiveHeaders = { ...headers, cookie: String(inactiveLogin.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': inactiveLogin.json().csrfToken as string };
    const receipt = {
      id: 'worker-stage-1',
      stage: 'show_succeeded',
      at: Date.now(),
      eventId: 'question-1',
      eventEpoch: '11111111-1111-4111-8111-111111111111',
      eventSequence: 1,
      kind: 'question'
    };

    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: inactiveHeaders, payload: { records: [receipt] } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: { ...inactiveHeaders, origin: 'https://evil.example' }, payload: { records: [receipt] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: { ...inactiveHeaders, 'x-csrf-token': 'wrong' }, payload: { records: [receipt] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': inactiveHeaders['x-csrf-token'] }, payload: { records: [receipt] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: inactiveHeaders, payload: { records: [{ ...receipt, title: 'secret prompt' }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: inactiveHeaders, payload: { records: Array.from({ length: 101 }, (_, index) => ({ ...receipt, id: `receipt-${index}` })) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/push/receipts', headers: inactiveHeaders, payload: { records: [{ ...receipt, status: 'x'.repeat(70_000) }] } })).statusCode).toBe(413);

    expect(await push.diagnostics.snapshot()).toEqual([
      receipt,
      expect.objectContaining({ stage: 'receipt_reported', eventId: receipt.eventId, status: 'accepted' })
    ]);
  }, 15_000);
});
