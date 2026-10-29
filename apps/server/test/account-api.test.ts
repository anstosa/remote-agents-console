import argon2 from 'argon2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';
import { testWorktree } from './helpers/config.js';
import { AuthService } from '../src/auth/service.js';
import { UnsupportedAccountOperationError } from '../src/accounts/index.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { QueuedPromptService } from '../src/prompts/queue.js';

const baseConfig: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };

// authenticate one controlling browser
const login = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
};

describe('Codex account API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // close each isolated server
  afterEach(async () => { await app?.close(); });

  it('queries safe limits and restarts only open idle worktrees after switching', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', pinned: false });
    const owen = testWorktree({ id: 'owen', projectId: 'owen', label: 'Owen', path: '/worktrees/owen', pinned: false });
    const firstCora = stated({ id: 'agent-cora-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: cora.path, worktreeId: cora.id, title: 'Ready' });
    const secondCora = { ...firstCora, id: 'agent-cora-2', paneId: '%2', sessionId: 'socket:$2' };
    const workingOwen = stated({ id: 'agent-owen', pane: { paneId: '%3', sessionId: 'socket:$3', socketFingerprint: 'socket' }, home: owen.path, worktreeId: owen.id, title: '⠋ Working' });
    const scratch = stated({ id: 'agent-scratch', pane: { paneId: '%4', sessionId: 'socket:$4', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let coraClosed = false;
    let coraResumed = false;
    const discovery = {
      // expose the replacement only after the resume handoff
      dashboard: async () => ({ generation: coraResumed ? 2 : 1, places: [], adapters: {}, agents: [coraResumed ? secondCora : firstCora, workingOwen, scratch], projects: [] }),
      worktreesNow: () => [cora, owen],
      // resolve the original target until it closes
      target: async (id: string) => !coraClosed && id === firstCora.id ? { agent: firstCora, socket } : undefined
    };
    const accounts = {
      // return only sanitized provider data
      listAccounts: async () => [{ id: 'account-1', label: 'Personal', active: true, email: 'personal@example.com', planType: 'pro', limits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null }, rateLimitResetCredits: { availableCount: 2 } } }, { id: 'account-2', label: 'Work', active: false }],
      // switch before any worktree restart
      switchAccount: async (id: string) => { events.push(`switch:${id}`); return { id, label: 'Work', active: true }; },
      // return one refreshed post-reset snapshot
      consumeRateLimitReset: async (id: string) => ({ outcome: 'reset' as const, account: { id, label: 'Personal', active: true, limits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 }, rateLimitResetCredits: { availableCount: 1 } } } }),
      startAddAccount: async () => { throw new Error('unused'); },
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      cancelAddAccount: async () => false,
      close: async () => {}
    };
    const launch = {
      launch: async () => false,
      launchHome: async () => false,
      // expose a new agent after the selected account is active
      resume: async (id: string) => { events.push(`resume:${id}`); coraResumed = true; return true; }
    };
    app = await buildApp({ ...baseConfig }, {
      auth: new AuthService(hash, Buffer.alloc(32, 31).toString('base64url')),
      accounts: accounts as never,
      discovery: discovery as never,
      launch: launch as never,
      launchPollDelay: async () => {},
      // expose no pending queue or reset during account switching
      queuedPrompts: { list: async () => [], resets: { get: async () => undefined } } as never,
      tmux: { close: async () => { events.push(`close:${firstCora.id}`); coraClosed = true; return true; } } as never
    });
    const headers = await login(app);

    const listed = await app.inject({ method: 'GET', url: '/api/codex/accounts', headers: { host: headers.host, cookie: headers.cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ accounts: [{ id: 'account-1', label: 'Personal', active: true, email: 'personal@example.com', planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300 }, resetCount: 2 }, { id: 'account-2', label: 'Work', active: false }] });

    const reset = await app.inject({ method: 'POST', url: '/api/codex/accounts/account-1/reset', headers });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ outcome: 'reset', account: { id: 'account-1', label: 'Personal', active: true, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 }, resetCount: 1 } });

    const switched = await app.inject({ method: 'POST', url: '/api/codex/accounts/switch', headers, payload: { id: 'account-2' } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ account: { id: 'account-2', label: 'Work', active: true }, restarts: [{ worktreeId: 'cora', status: 'restarted' }, { worktreeId: 'owen', status: 'skipped', error: 'The worktree is not idle.' }] });
    expect(events).toEqual(['switch:account-2', 'close:agent-cora-1', 'resume:cora']);
  }, 15_000);

  it('starts and reports a device-code account login without exposing credentials', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    let repairTarget: string | undefined;
    const accounts = {
      listAccounts: async () => [],
      switchAccount: async () => { throw new Error('unused'); },
      startAddAccount: async (id?: string) => { repairTarget = id; return { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH' }; },
      status: async () => ({ status: 'succeeded', account: { id: 'account-3', label: 'new@example.com', email: 'new@example.com', planType: 'plus', active: false } } as const),
      cancelAddAccount: async () => true,
      close: async () => {}
    };
    app = await buildApp(baseConfig, { auth: new AuthService(hash, Buffer.alloc(32, 32).toString('base64url')), accounts: accounts as never });
    const headers = await login(app);

    const started = await app.inject({ method: 'POST', url: '/api/codex/accounts/login', headers, payload: { repairAccountId: 'account-3' } });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toEqual({ login: { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH' } });
    expect(repairTarget).toBe('account-3');
    const status = await app.inject({ method: 'GET', url: '/api/codex/accounts/login/login-1', headers: { host: headers.host, cookie: headers.cookie } });
    expect(status.json()).toEqual({ status: 'succeeded', account: { id: 'account-3', label: 'new@example.com', email: 'new@example.com', planType: 'plus', active: false } });
    const cancelled = await app.inject({ method: 'DELETE', url: '/api/codex/accounts/login/login-1', headers });
    expect(cancelled.statusCode).toBe(204);
  }, 15_000);

  it('renames accounts through an authenticated mutation and returns only public fields', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const received: Array<{ id: string; label: unknown }> = [];
    const accounts = {
      // keep unrelated listing empty
      listAccounts: async () => [],
      // reject unrelated switching
      switchAccount: async () => { throw new Error('unused'); },
      // record sanitized rename inputs
      renameAccount: async (id: string, label: unknown) => {
        received.push({ id, label });
        // model safe missing and storage failures
        if (id === 'missing') throw new Error('Account not found');
        if (id === 'failed') throw new Error(`storage leaked ${String(label)}`);
        return { id, label: String(label), active: true, authMode: 'apikey' as const, email: 'hidden@example.com', providerSecret: 'must-not-leak' };
      },
      // reject unrelated login startup
      startAddAccount: async () => { throw new Error('unused'); },
      // return an unused terminal state
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      // reject unrelated login cancellation
      cancelAddAccount: async () => false,
      // close without resources
      close: async () => {}
    };
    app = await buildApp(baseConfig, { auth: new AuthService(hash, Buffer.alloc(32, 35).toString('base64url')), accounts: accounts as never });
    const headers = await login(app);

    const unauthenticated = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/account-1', headers: { host: headers.host, origin: headers.origin, 'x-csrf-token': headers['x-csrf-token'] }, payload: { label: 'Renamed' } });
    expect(unauthenticated.statusCode).toBe(401);
    const missingOrigin = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/account-1', headers: { host: headers.host, cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }, payload: { label: 'Renamed' } });
    expect(missingOrigin.statusCode).toBe(403);
    const missingCsrf = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/account-1', headers: { host: headers.host, origin: headers.origin, cookie: headers.cookie }, payload: { label: 'Renamed' } });
    expect(missingCsrf.statusCode).toBe(403);
    const secondaryHeaders = await login(app);
    const inactiveSession = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/account-1', headers: secondaryHeaders, payload: { label: 'Renamed' } });
    expect(inactiveSession.statusCode).toBe(423);

    // reject unsafe ids and labels before calling the service
    for (const request of [
      { url: '/api/codex/accounts/bad.name', label: 'Renamed' },
      { url: '/api/codex/accounts/account-1', label: undefined },
      { url: '/api/codex/accounts/account-1', label: '' },
      { url: '/api/codex/accounts/account-1', label: '\nRenamed' },
      { url: '/api/codex/accounts/account-1', label: 'Renamed\t' },
      { url: '/api/codex/accounts/account-1', label: 'line\nbreak' },
      { url: '/api/codex/accounts/account-1', label: 'control\u0085' },
      { url: '/api/codex/accounts/account-1', label: 'x'.repeat(121) },
      { url: '/api/codex/accounts/account-1', label: 42 }
    ]) {
      const invalid = await app.inject({ method: 'PATCH', url: request.url, headers, payload: { label: request.label } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'Invalid account rename.' });
    }
    expect(received).toEqual([]);

    const renamed = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/account-1', headers, payload: { label: '  Production key  ' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ account: { id: 'account-1', label: 'Production key', active: true, authMode: 'apikey', email: 'hidden@example.com' } });
    expect(renamed.body).not.toContain('must-not-leak');
    expect(received).toEqual([{ id: 'account-1', label: 'Production key' }]);

    const missing = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/missing', headers, payload: { label: 'Missing' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Account not found.' });
    const failed = await app.inject({ method: 'PATCH', url: '/api/codex/accounts/failed', headers, payload: { label: 'private detail' } });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'Unable to rename account.' });
    expect(failed.body).not.toContain('private detail');
  }, 15_000);

  it('saves a bounded api-key account through the controlling session without exposing the key', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const received: string[] = [];
    const rejectedSecret = 'provider-rejected-secret';
    const accounts = {
      listAccounts: async () => [],
      switchAccount: async () => { throw new Error('unused'); },
      addApiKeyAccount: async (apiKey: string) => {
        received.push(apiKey);
        // return a provider failure without its details reaching the response
        if (apiKey === rejectedSecret) throw new Error(`provider rejected ${apiKey}`);
        return { id: 'account-3', label: 'API key (account-3)', active: false, authMode: 'apikey' as const, providerSecret: apiKey };
      },
      consumeRateLimitReset: async () => { throw new UnsupportedAccountOperationError('provider details'); },
      startAddAccount: async () => { throw new UnsupportedAccountOperationError('provider details'); },
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      cancelAddAccount: async () => false,
      close: async () => {}
    };
    app = await buildApp(baseConfig, { auth: new AuthService(hash, Buffer.alloc(32, 34).toString('base64url')), accounts: accounts as never });
    const headers = await login(app);
    let source = 0;
    // isolate behavior checks from the production route limiter
    const postApiKey = (requestHeaders: Record<string, string>, apiKey: unknown) => {
      source += 1;
      return app!.inject({ method: 'POST', url: '/api/codex/accounts/api-key', remoteAddress: `192.0.2.${source}`, headers: requestHeaders, payload: { apiKey } });
    };

    const unauthenticated = await postApiKey({ host: headers.host, origin: headers.origin, 'x-csrf-token': headers['x-csrf-token'] }, 'valid-key');
    expect(unauthenticated.statusCode).toBe(401);
    const missingOrigin = await postApiKey({ host: headers.host, cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }, 'valid-key');
    expect(missingOrigin.statusCode).toBe(403);
    const missingCsrf = await postApiKey({ host: headers.host, origin: headers.origin, cookie: headers.cookie }, 'valid-key');
    expect(missingCsrf.statusCode).toBe(403);

    // reject malformed values before the account service
    for (const apiKey of ['', '   ', 'embedded space', 'line\nbreak', 'x'.repeat(8193)]) {
      const invalid = await postApiKey(headers, apiKey);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'Invalid API key.' });
    }
    const nonString = await postApiKey(headers, 42);
    expect(nonString.statusCode).toBe(400);
    expect(received).toEqual([]);

    const saved = await postApiKey(headers, '  accepted-key\n');
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toEqual({ account: { id: 'account-3', label: 'API key (account-3)', active: false, authMode: 'apikey' } });
    expect(saved.body).not.toContain('accepted-key');
    expect(received).toEqual(['accepted-key']);

    const rejected = await postApiKey(headers, rejectedSecret);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toEqual({ error: 'Unable to add API key account.' });
    expect(rejected.body).not.toContain(rejectedSecret);

    const repair = await app.inject({ method: 'POST', url: '/api/codex/accounts/login', headers, payload: { repairAccountId: 'account-3' } });
    expect(repair.statusCode).toBe(400);
    expect(repair.json()).toEqual({ error: 'API key accounts do not support ChatGPT login.' });
    const reset = await app.inject({ method: 'POST', url: '/api/codex/accounts/account-3/reset', headers });
    expect(reset.statusCode).toBe(400);
    expect(reset.json()).toEqual({ error: 'API key accounts do not support ChatGPT resets.' });
  }, 15_000);

  it('preserves a prompt that starts while an account switch selects restart targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-account-prompt-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', pinned: false });
    const idleCora = stated({ id: 'agent-cora', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: cora.path, worktreeId: cora.id, title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let releasePaste!: () => void;
    let markPasteStarted!: () => void;
    const pasteStarted = new Promise<void>(resolve => { markPasteStarted = resolve; });
    const pasteBlocked = new Promise<void>(resolve => { releasePaste = resolve; });
    const closed: string[] = [];
    const discovery = {
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [idleCora], projects: [] }),
      worktreesNow: () => [cora],
      target: async (id: string) => id === idleCora.id ? { agent: idleCora, socket } : undefined
    };
    const accounts = {
      listAccounts: async () => [],
      switchAccount: async (id: string) => ({ id, label: 'Work', active: true }),
      startAddAccount: async () => { throw new Error('unused'); },
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      cancelAddAccount: async () => false,
      close: async () => {}
    };
    const tmux = {
      // hold a submitted prompt across the switch
      pastePrompt: async () => { markPasteStarted(); await pasteBlocked; return true; },
      sendKeys: async () => true,
      close: async () => { closed.push(idleCora.id); return true; }
    };
    app = await buildApp({ ...baseConfig }, {
      auth: new AuthService(hash, Buffer.alloc(32, 33).toString('base64url')),
      accounts: accounts as never,
      discovery: discovery as never,
      launch: { launch: async () => false, launchHome: async () => false, resume: async () => true } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      tmux: tmux as never
    });
    const headers = await login(app);

    const prompt = app.inject({ method: 'POST', url: `/api/agents/${idleCora.id}/prompt`, headers, payload: { prompt: 'Keep this running' } });
    try {
      await pasteStarted;
      const switched = await app.inject({ method: 'POST', url: '/api/codex/accounts/switch', headers, payload: { id: 'account-2' } });

      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toEqual({ account: { id: 'account-2', label: 'Work', active: true }, restarts: [{ worktreeId: 'cora', status: 'skipped', error: 'The worktree is not idle.' }] });
      expect(closed).toEqual([]);
      releasePaste();
      await expect(prompt).resolves.toMatchObject({ statusCode: 204 });
    } finally {
      releasePaste();
      await prompt.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
