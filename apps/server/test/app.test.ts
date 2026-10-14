import { afterEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { worktreePlace } from '../src/places/places.js';
import { AuthService } from '../src/auth/service.js';
import { AgentNotificationCoordinator } from '../src/notifications.js';
import { stated } from './helpers/agent.js';
import { testProject, testWorktree } from './helpers/config.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { parseKeysConfig, type KeysConfig } from '../src/config/keys.js';
import { resolveReviewConfig } from '../src/review-runs/config.js';
import type { ReviewRunProgress } from '../src/review-runs/runner.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';
import type { ReviewTour } from '../src/review-tour/contracts.js';
import { PullRequestLookupError } from '../src/pull-requests/service.js';
import { dashboardFingerprint, DashboardUpdates, type DashboardPayload } from '../src/dashboard/updates.js';
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen:{host:'127.0.0.1',port:8787},publicOrigin:new URL('https://agents.example.com'),trustedProxyIps:new Set(['127.0.0.1']),pollIntervalMs:500,adapters:{},projects:[] };
// reset environment overrides
afterEach(() => { vi.unstubAllEnvs(); });
describe('HTTP security boundary',()=>{let app:Awaited<ReturnType<typeof buildApp>>;afterEach(async()=>{await app?.close()});it('serves the browser application and its build version for the canonical host',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const response=await app.inject({method:'GET',url:'/',headers:{host:'agents.example.com'}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('text/html');expect(response.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');expect(response.body).toContain('<!doctype html>');const version=await app.inject({method:'GET',url:'/api/ui-version',headers:{host:'agents.example.com'}});expect(version.statusCode).toBe(200);expect(version.json().version).toMatch(/^\/assets\/index-[\w-]+\.js$/)}, 15_000);it('requires canonical Host and Origin and creates a secure host cookie',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const bad=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'evil.example'}});expect(bad.statusCode).toBe(403);const boot=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'agents.example.com'}});const token=boot.json().csrfToken;const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(denied.statusCode).toBe(403);const ok=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com',origin:'https://agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(ok.statusCode).toBe(200);expect(ok.headers['set-cookie']).toContain('__Host-rac=');expect(ok.headers['set-cookie']).toContain('HttpOnly');expect(ok.headers['set-cookie']).toContain('Secure');expect(ok.headers['content-security-policy']).toContain("default-src 'self'");expect(ok.headers['content-security-policy']).toContain("img-src 'self' data:")}, 15_000)});

describe('server identity API', () => {
  // verify authentication never waits for peers
  it('keeps authentication independent of stalled remote status checks', async () => {
    const namedConfig = { ...config, publicOrigin: new URL('https://x1carbon.santosa.dev'), remoteServers: [{ url: new URL('https://framework.santosa.dev') }] };
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // hold peer discovery indefinitely
    const instanceStatusPoller = { statuses: () => new Promise<never>(() => {}) };
    const identityApp = await buildApp(namedConfig, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), instanceStatusPoller });
    // close the isolated app after assertions
    try {
      const bootstrap = await identityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'x1carbon.santosa.dev' } });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().server.remotes).toEqual([{ name: 'framework.santosa.dev', url: 'https://framework.santosa.dev' }]);
      const login = await identityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'x1carbon.santosa.dev', origin: 'https://x1carbon.santosa.dev', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      expect(login.statusCode).toBe(200);
      expect(login.json().server.remotes).toEqual([{ name: 'framework.santosa.dev', url: 'https://framework.santosa.dev' }]);
    } finally {
      await identityApp.close();
    }
  }, 15_000);

  // verify peer metadata refreshes through status polling
  it('publishes local and remote server choices before login and in sessions', async () => {
    const namedConfig = { ...config, name: 'X1 Carbon', icon: 'potato' as const, publicOrigin: new URL('https://x1carbon.santosa.dev'), remoteServers: [{ url: new URL('https://framework.santosa.dev') }] };
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const statusSecret = 'shared-status-secret-with-thirty-two-bytes';
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', statusSecret);
    const instanceStatusPoller = { statuses: async () => [{ url: 'https://framework.santosa.dev', name: 'Framework', icon: 'heart' as const, attention: 'idle' as const }] };
    // avoid host discovery in identity test
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) };
    const identityApp = await buildApp(namedConfig, { auth: new AuthService(hash, Buffer.alloc(32, 16).toString('base64url')), instanceStatusPoller, discovery: discovery as never });
    // close the isolated app after assertions
    try {
      const bootstrap = await identityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'x1carbon.santosa.dev' } });
      const expected = { name: 'X1 Carbon', icon: 'potato', url: 'https://x1carbon.santosa.dev', remotes: [{ name: 'Framework', icon: 'heart', url: 'https://framework.santosa.dev' }] };
      expect(bootstrap.json().server).toMatchObject({ name: expected.name, icon: expected.icon, url: expected.url, remotes: [{ url: expected.remotes[0].url }] });
      const login = await identityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'x1carbon.santosa.dev', origin: 'https://x1carbon.santosa.dev', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const statuses = await identityApp.inject({ method: 'GET', url: '/api/server-statuses', headers: { host: 'x1carbon.santosa.dev', cookie } });
      expect(statuses.json().servers).toEqual([{ name: 'X1 Carbon', icon: 'potato', url: 'https://x1carbon.santosa.dev', attention: 'idle' }, { name: 'Framework', icon: 'heart', url: 'https://framework.santosa.dev', attention: 'idle' }]);
      const current = await identityApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'x1carbon.santosa.dev', cookie } });
      expect(current.json().server).toEqual(expected);
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', statusSecret).update(`rac-instance-status-v1\n${namedConfig.publicOrigin.origin}\n${timestamp}`).digest('base64url');
      const published = await identityApp.inject({ method: 'GET', url: '/api/instance-status', headers: { host: 'x1carbon.santosa.dev', 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': signature } });
      expect(published.json()).toMatchObject({ name: 'X1 Carbon', icon: 'potato', attention: 'idle' });
    } finally { await identityApp.close(); }
  }, 15_000);
});

describe('server administration API', () => {
  it('renames and updates only from the controlling browser', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const renamed: string[] = [];
    const defaults: string[] = [];
    const davoSettings: Array<{ enabled: boolean; name: string; context: string }> = [];
    const targetSha = '2'.repeat(40);
    const committedAt = '2026-09-06T14:22:31-07:00';
    let revisionReads = 0;
    const revisionStatus = vi.fn(async () => {
      revisionReads += 1;
      // expose a later checkout if the app rereads
      if (revisionReads > 1) return { sha: '3'.repeat(40), committedAt: '2026-09-07T14:22:31-07:00' };
      return { sha: targetSha, committedAt };
    });
    const reviewedPreview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Update server', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] as Array<{ kind: 'config'; paths: string[] }> } };
    let preview = reviewedPreview;
    const startUpdate = vi.fn(async () => ({ id: 'server_update_operation_1234', kind: 'update' as const, state: 'queued' as const, targetSha }));
    const serverAdmin = {
      renameServer: async (name: string) => { renamed.push(name); return name.trim() || undefined; },
      setDefaultAgent: async (kind: string) => { defaults.push(kind); return kind; },
      setDavoSettings: async (settings: { enabled: boolean; name: string; context: string }) => { davoSettings.push(settings); return settings; },
      startUpdate,
      updateStatus: async (id: string) => id === 'server_update_operation_1234' ? ({ id, kind: 'update' as const, state: 'running' as const, targetSha }) : undefined,
      // expose fetched upstream state
      updateAvailable: async () => true,
      updatePreview: async () => preview,
      revision: revisionStatus
    };
    const adminApp = await buildApp({ ...config, adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } } }, { auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const rename = await adminApp.inject({ method: 'PATCH', url: '/api/server/name', headers, payload: { name: 'Garage Server' } });
      const defaultAgent = await adminApp.inject({ method: 'PATCH', url: '/api/server/default-agent', headers, payload: { kind: 'codex' } });
      const unavailableDefault = await adminApp.inject({ method: 'PATCH', url: '/api/server/default-agent', headers, payload: { kind: 'claude' } });
      const invalidDefault = await adminApp.inject({ method: 'PATCH', url: '/api/server/default-agent', headers, payload: { kind: 'unknown' } });
      const davo = await adminApp.inject({ method: 'PATCH', url: '/api/server/davo', headers, payload: { enabled: false, name: 'Riley', context: 'Direct and dry.' } });
      const invalidDavo = await adminApp.inject({ method: 'PATCH', url: '/api/server/davo', headers, payload: { enabled: false, name: ' ', context: '' } });
      const unavailableDavo = await adminApp.inject({ method: 'PATCH', url: '/api/server/davo', headers, payload: { enabled: true, name: 'Riley', context: '' } });
      const update = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });
      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_operation_1234', headers: { host: headers.host, cookie: headers.cookie } });
      const availability = await adminApp.inject({ method: 'GET', url: '/api/server/update-available', headers: { host: headers.host, cookie: headers.cookie } });
      const revision = await adminApp.inject({ method: 'GET', url: '/api/server/revision', headers: { host: headers.host, cookie: headers.cookie } });
      const repeatedRevision = await adminApp.inject({ method: 'GET', url: '/api/server/revision', headers: { host: headers.host, cookie: headers.cookie } });
      const updatePreview = await adminApp.inject({ method: 'GET', url: '/api/server/update-preview', headers: { host: headers.host, cookie: headers.cookie } });
      // require explicit advisor acknowledgement for flagged previews
      preview = { ...preview, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
      const unacknowledgedUpdate = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });

      expect(rename.json()).toMatchObject({ name: 'Garage Server', server: { name: 'Garage Server' } });
      expect(renamed).toEqual(['Garage Server']);
      expect(defaultAgent.json()).toEqual({ defaultAgent: 'codex' });
      expect(defaults).toEqual(['codex']);
      expect(unavailableDefault.statusCode).toBe(409);
      expect(invalidDefault.statusCode).toBe(400);
      expect(davo.json()).toEqual({ davo: { enabled: false, available: false, name: 'Riley', context: 'Direct and dry.' } });
      expect(davoSettings).toEqual([{ enabled: false, name: 'Riley', context: 'Direct and dry.' }]);
      expect(invalidDavo.statusCode).toBe(400);
      expect(unavailableDavo.statusCode).toBe(409);
      expect(update.statusCode).toBe(202);
      expect(update.json()).toMatchObject({ state: 'queued' });
      expect(startUpdate).toHaveBeenCalledWith(targetSha);
      expect(status.json()).toMatchObject({ state: 'running' });
      expect(availability.json()).toEqual({ available: true, commitCount: 1, targetSha });
      expect(revision.json()).toEqual({ sha: targetSha, committedAt });
      expect(repeatedRevision.json()).toEqual({ sha: targetSha, committedAt });
      expect(updatePreview.json()).toEqual(reviewedPreview);
      expect(unacknowledgedUpdate.statusCode).toBe(409);
    } finally {
      await adminApp.close();
    }
  }, 15_000);

  it('requires the exact reviewed upstream target', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } };
    const startUpdate = vi.fn();
    const serverAdmin = { updatePreview: async () => preview, startUpdate, updateAvailable: async () => true, revision: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const missing = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers });
      const stale = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: '3'.repeat(40) } });

      expect(missing.statusCode).toBe(400);
      expect(stale.statusCode).toBe(409);
      expect(startUpdate).not.toHaveBeenCalled();
    } finally { await adminApp.close(); }
  }, 15_000);

  it('retries the reviewed rebuild after Git already reached its target', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const preview = { available: false, rebuildRetryAvailable: true, baseSha: targetSha, targetSha, fastForwardable: true, commitCount: 0, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } };
    const startUpdate = vi.fn(async () => ({ id: 'server_update_retry_123456', kind: 'update' as const, state: 'queued' as const, targetSha }));
    const serverAdmin = { updatePreview: async () => preview, startUpdate, updateAvailable: async () => false, revision: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const retry = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });

      expect(retry.statusCode).toBe(202);
      expect(startUpdate).toHaveBeenCalledWith(targetSha);
    } finally { await adminApp.close(); }
  }, 15_000);

  it('launches, reuses, and cleans one target-pinned update advisor', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const directory = await mkdtemp(join(tmpdir(), 'rac-update-advisor-api-'));
    const targetSha = '2'.repeat(40);
    const advisorId = 'update-advisor';
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const pendingAgent = stated({ id: advisorId, paneId: '%8', sessionId: 'socket:$8', socketFingerprint: 'socket', home: '/host/repo', displayLabel: 'Update Advisor Starting v4 2222222', title: 'Ready' });
    const readyAgent = { ...pendingAgent, displayLabel: 'Update Advisor v4 2222222' };
    const oldAgent = { ...pendingAgent, id: 'old-update-advisor', paneId: '%7', sessionId: 'socket:$7' };
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
    let activeTarget: string | undefined;
    let launched = false;
    let advisorReady = false;
    let advisorStarted = false;
    let advisorClosed = false;
    let oldAdvisorClosed = false;
    let blockAdvisorClose = false;
    let signalAdvisorCloseStarted = () => {};
    let advisorCloseGate = Promise.resolve();
    const discovery = { worktreesNow: () => [],
      dashboard: async () => ({ generation: launched ? 2 : 1, places: [], agents: [...(oldAdvisorClosed ? [] : [oldAgent]), ...(launched && !advisorClosed ? [stated({ ...(advisorReady ? readyAgent : pendingAgent), title: advisorStarted ? '⠋ Reviewing' : 'Ready' })] : [])], projects: [] }),
      target: async (id: string) => launched && !advisorClosed && id === advisorId ? { agent: stated({ ...(advisorReady ? readyAgent : pendingAgent), title: advisorStarted ? '⠋ Reviewing' : 'Ready' }), socket } : !oldAdvisorClosed && id === oldAgent.id ? { agent: oldAgent, socket } : undefined
    };
    const launch = { launchUpdateAdvisor: vi.fn(async () => { launched = true; advisorReady = false; advisorStarted = false; advisorClosed = false; return true; }) };
    const tmux = { pastePrompt: vi.fn(async () => true), capture: vi.fn(async () => '› Inspect the fixed committed range without changing it. '), sendKeys: vi.fn(async (_socket: unknown, _pane: string, keys: string[]) => { if (keys.includes('Enter')) advisorStarted = true; return true; }), label: vi.fn(async () => { advisorReady = true; return true; }), close: vi.fn(async (_socket: unknown, paneId: string) => {
      // close interrupted launches immediately
      if (paneId === oldAgent.paneId) oldAdvisorClosed = true;
      // optionally hold one modal-close race
      if (paneId === readyAgent.paneId) {
        signalAdvisorCloseStarted();
        if (blockAdvisorClose) await advisorCloseGate;
        advisorClosed = true;
      }
      return true;
    }) };
    const serverAdmin = {
      updatePreview: async () => preview,
      updateAdvisor: () => ({ repository: '/host/repo', prompt: 'Inspect the fixed committed range without changing it.' }),
      updateAvailable: async () => true,
      activeUpdateTarget: async () => activeTarget,
      startUpdate: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'queued' as const, targetSha }),
      updateStatus: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'complete' as const, targetSha }),
      revision: async () => undefined
    };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: tmux as never, serverAdmin: serverAdmin as never, queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')) });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      // reopen the modal beyond the former route limit
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const advisor = await adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });
        expect(advisor.statusCode).toBe(201);
        expect(advisor.json()).toEqual({ agentId: advisorId, targetSha });
      }
      expect(tmux.close).toHaveBeenCalledWith(socket, oldAgent.paneId);
      expect(tmux.close).not.toHaveBeenCalledWith(socket, readyAgent.paneId);
      let releaseAdvisorClose = () => {};
      const advisorCloseStarted = new Promise<void>(resolve => { signalAdvisorCloseStarted = resolve; });
      advisorCloseGate = new Promise<void>(resolve => { releaseAdvisorClose = resolve; });
      blockAdvisorClose = true;
      const racingClose = adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      await advisorCloseStarted;
      const racingReopen = adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      blockAdvisorClose = false;
      releaseAdvisorClose();
      expect((await racingClose).statusCode).toBe(204);
      expect((await racingReopen).statusCode).toBe(201);
      expect(advisorClosed).toBe(false);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledTimes(2);
      activeTarget = targetSha;
      const activeClose = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(activeClose.statusCode).toBe(409);
      expect(advisorClosed).toBe(false);
      activeTarget = undefined;
      const closeAdvisor = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(closeAdvisor.statusCode).toBe(204);
      expect(tmux.close).toHaveBeenCalledWith(socket, readyAgent.paneId);
      const update = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha, advisoryAcknowledged: true } });
      expect(update.statusCode).toBe(202);
      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_advisor_1234', headers: { host: headers.host, cookie: headers.cookie } });

      expect(status.statusCode).toBe(200);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledTimes(2);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledWith('/host/repo', targetSha);
      expect(tmux.pastePrompt).toHaveBeenCalledTimes(2);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
      expect(tmux.sendKeys).toHaveBeenCalledWith(socket, pendingAgent.paneId, ['Enter']);
      // the advisor is submitted with Enter, never Codex's Tab queue key
      expect(tmux.sendKeys.mock.calls.every(call => !(call[2] as string[]).includes('Tab'))).toBe(true);
      expect(tmux.label).toHaveBeenCalledWith(socket, pendingAgent.paneId, readyAgent.displayLabel);
      expect(tmux.close).toHaveBeenCalledWith(socket, readyAgent.paneId);
    } finally { await adminApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);

  it('closes a legacy advisor recovered after an update restart', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const legacy = stated({ id: 'legacy-advisor', paneId: '%7', sessionId: 'socket:$7', socketFingerprint: 'socket', home: '/host/repo', displayLabel: 'Update Advisor 2222222', title: 'Ready' });
    let closed = false;
    let dashboardFails = false;
    const discovery = { worktreesNow: () => [],
      dashboard: async () => { if (dashboardFails) throw new Error('tmux unavailable'); return { generation: 1, places: [], agents: closed ? [] : [legacy], projects: [] }; },
      target: async (id: string) => !closed && id === legacy.id ? { agent: legacy, socket } : undefined
    };
    const tmux = { close: vi.fn(async () => { closed = true; return true; }) };
    const serverAdmin = { updateStatus: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'complete' as const, targetSha }), updateAvailable: async () => false, activeUpdateTarget: async () => undefined, revision: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 25).toString('base64url')), discovery: discovery as never, tmux: tmux as never, serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_advisor_1234', headers });

      expect(status.statusCode).toBe(200);
      expect(tmux.close).toHaveBeenCalledWith(socket, legacy.paneId);
      dashboardFails = true;
      const failedCleanup = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(failedCleanup.statusCode).toBe(503);
    } finally { await adminApp.close(); }
  }, 15_000);

  it('keeps only the newest same-target update advisor', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const older = stated({ id: 'older-advisor', paneId: '%8', sessionId: 'socket:$8', socketFingerprint: 'socket', home: '/host/repo', displayLabel: 'Update Advisor v4 2222222', title: 'Framework' });
    const newer = { ...older, id: 'newer-advisor', paneId: '%9', sessionId: 'socket:$9', title: 'remoteagents' };
    let olderClosed = false;
    const discovery = { worktreesNow: () => [],
      dashboard: async () => ({ generation: 1, places: [], agents: [...(olderClosed ? [] : [older]), newer], projects: [] }),
      target: async (id: string) => id === newer.id ? { agent: newer, socket } : !olderClosed && id === older.id ? { agent: older, socket } : undefined
    };
    const launch = { launchUpdateAdvisor: vi.fn(async () => true) };
    const tmux = { pastePrompt: vi.fn(async () => true), queue: vi.fn(async () => true), close: vi.fn(async (_socket: unknown, paneId: string) => { if (paneId === older.paneId) olderClosed = true; return true; }) };
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
    const serverAdmin = { updatePreview: async () => preview, updateAdvisor: () => ({ repository: '/host/repo', prompt: 'Inspect the fixed committed range without changing it.' }), updateAvailable: async () => true, activeUpdateTarget: async () => undefined, revision: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 24).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: tmux as never, serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const advisor = await adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });

      expect(advisor.statusCode).toBe(201);
      expect(advisor.json()).toEqual({ agentId: newer.id, targetSha });
      expect(tmux.close).toHaveBeenCalledWith(socket, older.paneId);
      expect(tmux.close).not.toHaveBeenCalledWith(socket, newer.paneId);
      expect(launch.launchUpdateAdvisor).not.toHaveBeenCalled();
      expect(tmux.pastePrompt).not.toHaveBeenCalled();
    } finally { await adminApp.close(); }
  }, 15_000);
});

describe('project browser security boundary', () => {
  // permit parent-owned location without granting embedded origins native access
  it('limits brokered geolocation to the console origin', async () => {
    const app = await buildApp(config, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=(self)');
    } finally { await app.close(); }
  });

  // allow direct browser navigation without widening other resource policies
  it('allows HTTP(S) iframe navigation only', async () => {
    const app = await buildApp({ ...config, projects: [testProject({ projectUrl: 'https://external.example.com', worktreeOverrides: [
      { path: '/repo-feature', projectUrl: 'https://feature.example.com', projectPort: 4000 },
      { path: '/repo-shared', projectUrl: 'https://project.example.com', projectPort: 3000 },
      { path: '/repo-readonly', commands: {} }
    ] })] }, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host: 'agents.example.com' } });
      const policy = String(response.headers['content-security-policy']);
      const sources = policy.match(/(?:^|;)\s*frame-src\s+([^;]+)/u)?.[1]?.trim().split(/\s+/u);
      expect(sources).toEqual(["'self'", 'http:', 'https:']);
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("connect-src 'self' wss://agents.example.com");
      expect(policy).not.toContain("'unsafe-eval'");
      expect(policy).not.toContain('external.example.com');
      expect(policy).not.toContain('feature.example.com');
      expect(policy).not.toContain('project.example.com');
    } finally { await app.close(); }
  });
});

describe('client control', () => {
  it('automatically activates the first client and lets another client take control', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const names = new Map<string, string>();
    const devices = {
      get: async (sessionId: string) => names.get(sessionId),
      set: async (sessionId: string, name: string) => {
        const normalized = name.trim();
        if (!normalized) return undefined;
        names.set(sessionId, normalized);
        return normalized;
      }
    };
    const controlApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 5).toString('base64url')), devices: devices as never });
    const login = async () => {
      const boot = await controlApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await controlApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const first = await login();
    const firstHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie, 'x-csrf-token': first.response.json().csrfToken };
    const unnamedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders });
    const namedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders, payload: { deviceName: 'Studio Mac' } });
    const second = await login();
    expect(first.response.json().active).toBe(true);
    expect(first.response.json().deviceName).toBeUndefined();
    expect(unnamedFirst.statusCode).toBe(400);
    expect(namedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Mac', controllingDeviceName: 'Studio Mac' });
    const invalidRename = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: '   ' } });
    const renamedFirst = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: 'Studio Display' } });
    expect(invalidRename.statusCode).toBe(400);
    expect(renamedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Display', controllingDeviceName: 'Studio Display' });
    const dashboardTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: firstHeaders });
    expect(dashboardTicket.statusCode).toBe(200);
    expect(dashboardTicket.json().ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(second.response.json().active).toBe(false);
    expect(second.response.json().controllingDeviceName).toBe('Studio Mac');
    const secondHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.response.json().csrfToken };
    const blocked = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: second.cookie } });
    const blockedTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: secondHeaders });
    expect(blocked.statusCode).toBe(423);
    expect(blockedTicket.statusCode).toBe(423);
    const unnamedSecond = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders });
    const take = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders, payload: { deviceName: 'Kitchen iPad' } });
    expect(unnamedSecond.statusCode).toBe(400);
    expect(take.json()).toMatchObject({ active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' });
    const displaced = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: first.cookie } });
    const displacedSession = await controlApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(displaced.statusCode).toBe(423);
    expect(displacedSession.json()).toMatchObject({ active: false, deviceName: 'Studio Display', controllingDeviceName: 'Kitchen iPad' });
    await controlApp.close();
  }, 15_000);

  it('registers every authenticated client without pushing silent notification dismissals', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const subscribed: unknown[] = [];
    const messages: unknown[] = [];
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const push = { enabled: true, publicKey: 'public-key', subscribe: async (subscription: unknown) => { subscribed.push(subscription); return true; }, notify: async (message: unknown) => { messages.push(message); } };
    const notifications = new AgentNotificationCoordinator(() => {}, 0);
    notifications.observe(stated({ ...agent, title: '⠋ Working' }));
    notifications.observe(agent);
    await new Promise(resolve => setTimeout(resolve, 0));
    const discovery = { worktreesNow: () => [worktree], target: async (id: string) => id === agent.id ? { agent, socket } : undefined, dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pushApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 6).toString('base64url')), discovery: discovery as never, push: push as never, notifications });
    const login = async () => {
      const boot = await pushApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await pushApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const active = await login();
    const inactive = await login();
    expect(inactive.response.json().active).toBe(false);
    const key = await pushApp.inject({ method: 'GET', url: '/api/push/public-key', headers: { host: 'agents.example.com', cookie: inactive.cookie } });
    expect(key.json()).toEqual({ publicKey: 'public-key' });
    const registration = await pushApp.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: inactive.cookie, 'x-csrf-token': inactive.response.json().csrfToken }, payload: { endpoint: 'https://push.example.com/subscription', keys: { p256dh: 'key', auth: 'auth' } } });
    const unreadDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    const dismissal = await pushApp.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: active.cookie, 'x-csrf-token': active.response.json().csrfToken }, payload: { completionId: unreadDashboard.json().agents[0].completionId } });
    const viewedDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    expect(registration.statusCode).toBe(204);
    expect(subscribed).toHaveLength(1);
    expect(unreadDashboard.json().agents[0].unread).toBe(true);
    expect(dismissal.statusCode).toBe(204);
    expect(viewedDashboard.json().agents[0].unread).toBe(false);
    expect(messages).toEqual([]);
    notifications.stop();
    await pushApp.close();
  }, 15_000);
});

describe('agent launches', () => {
  it('waits for a discovered Codex pane and returns its id to the client', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu', placeId: 'scratch:/home/ubuntu', title: '' });
    // an Agent at another Place appears first; only the Scratch Place's is the launched one
    const stranger = stated({ id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', home: '/srv/tools', placeId: 'scratch:/srv/tools', title: '' });
    let dashboards = 0;
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: ++dashboards, places: [], agents: dashboards === 1 ? [] : dashboards === 2 ? [stranger] : [stranger, agent], projects: [] }) };
    const launch = { launch: async () => true, launchHome: async () => true, scratchPlace: async () => ({ id: 'scratch:/home/ubuntu' }) };
    const launchApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 3).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/agents/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
    } finally { await launchApp.close(); }
  }, 15_000);

  it('waits beyond twenty seconds for the requested worktree agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', home: '/worktrees/cora', title: '', worktreeId: 'cora' });
    let dashboards = 0;
    // reveal after the old timeout
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: ++dashboards, places: [], agents: dashboards < 83 ? [] : [agent], projects: [] }) };
    const launch = { launch: async (id: string) => id === 'cora', launchHome: async () => true };
    // skip real poll delays
    const skipLaunchPollDelay = async () => {};
    const launchApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 4).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: skipLaunchPollDelay });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/worktrees/cora/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
      expect(dashboards).toBe(83);
    } finally { await launchApp.close(); }
  }, 15_000);

  it('forwards a requested launch kind and rejects an unknown one', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu', placeId: 'scratch:/home/ubuntu', title: '' });
    let dashboards = 0;
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: ++dashboards, places: [], agents: dashboards === 1 ? [] : [agent], projects: [] }) };
    const kinds: Array<string | undefined> = [];
    const launch = { launch: async () => true, launchHome: async (kind?: string) => { kinds.push(kind); return true; }, scratchPlace: async () => ({ id: 'scratch:/home/ubuntu' }) };
    const launchApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 9).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken };
      const bad = await launchApp.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'nope' } });
      expect(bad.statusCode).toBe(400);
      const ok = await launchApp.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'codex' } });
      expect(ok.statusCode).toBe(201);
      expect(kinds).toEqual(['codex']);
    } finally { await launchApp.close(); }
  }, 15_000);

  it('launches a non-git directory Project in place and returns its labeled agent id', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const directoryConfig = { ...config, projects: [testProject({ id: 'notes', label: 'Notes', path: '/home/me/notes', identity: '/home/me/notes', mode: 'directory', available: true })] };
    const agent = stated({ id: 'socket:%5', paneId: '%5', sessionId: 'socket:$5', socketFingerprint: 'socket', home: '/home/me/notes', displayLabel: 'Notes', placeId: 'notes:/home/me/notes', title: '' });
    // an Agent at another Place appears first; only the Project's Place match picks the launched one
    const stranger = stated({ id: 'socket:%6', paneId: '%6', sessionId: 'socket:$6', socketFingerprint: 'socket', home: '/home/me', placeId: 'scratch:/home/me', title: '' });
    let dashboards = 0;
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: ++dashboards, places: [], agents: dashboards === 1 ? [] : dashboards === 2 ? [stranger] : [stranger, agent], projects: [] }) };
    const kinds: Array<string | undefined> = [];
    const launch = { launchProjectDirectory: async (id: string, kind?: string) => { kinds.push(kind); return id === 'notes'; }, directoryPlace: async (id: string) => (id === 'notes' ? { id: 'notes:/home/me/notes' } : undefined) };
    const launchApp = await buildApp(directoryConfig, { auth: new AuthService(hash, Buffer.alloc(32, 12).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: async () => {} });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      // the new Agent is matched back by the Project's Place
      const ok = await launchApp.inject({ method: 'POST', url: '/api/projects/notes/launch', headers, payload: { kind: 'codex' } });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toEqual({ agentId: agent.id });
      expect(kinds).toEqual(['codex']);
      // an unknown kind is rejected before any handoff
      const bad = await launchApp.inject({ method: 'POST', url: '/api/projects/notes/launch', headers, payload: { kind: 'nope' } });
      expect(bad.statusCode).toBe(400);
      expect(kinds).toEqual(['codex']);
    } finally { await launchApp.close(); }
  }, 15_000);

  it('refuses an in-place launch when the id resolves to no directory-Project Place, before any handoff', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const repoConfig = { ...config, projects: [testProject({ id: 'repo', label: 'Repo', mode: 'repository', available: true })] };
    let called = false;
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) };
    const launch = { launchProjectDirectory: async () => { called = true; return true; }, directoryPlace: async () => undefined };
    const launchApp = await buildApp(repoConfig, { auth: new AuthService(hash, Buffer.alloc(32, 13).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: async () => {} });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const repo = await launchApp.inject({ method: 'POST', url: '/api/projects/repo/launch', headers });
      const absent = await launchApp.inject({ method: 'POST', url: '/api/projects/absent/launch', headers });
      expect(repo.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      expect(called).toBe(false);
    } finally { await launchApp.close(); }
  }, 15_000);
});

describe('pull request switch API', () => {
  // preserve lookup failures across the HTTP boundary
  it('returns an actionable gateway error when GitHub lookup fails', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const prSwitch = { available: async () => { throw new PullRequestLookupError('GitHub could not load pull requests (503).'); } };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 17).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await pullRequestApp.inject({ method: 'GET', url: '/api/worktrees/cora/switch-prs', headers: { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] } });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'GitHub could not load pull requests (503).' });
    } finally { await pullRequestApp.close(); }
  }, 15_000);

  it('moves an occupied pull request through the controlled HTTP boundary', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const move = vi.fn<() => Promise<'moved' | 'recovery-required'>>().mockResolvedValueOnce('moved').mockResolvedValueOnce('recovery-required');
    const prSwitch = { move };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 18).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-pr', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken }, payload: { number: 301 } });
      const recovery = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-pr', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken }, payload: { number: 302 } });

      expect(response.statusCode).toBe(202);
      expect(move).toHaveBeenCalledWith('cora', 301);
      expect(recovery.statusCode).toBe(409);
      expect(recovery.json()).toMatchObject({ recoveryRequired: true, error: expect.any(String) });
    } finally {
      await pullRequestApp.close();
    }
  }, 15_000);

  it('switches and moves a local branch through the controlled HTTP boundary', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const switchBranch = vi.fn<() => Promise<'switched' | 'unavailable'>>().mockResolvedValueOnce('switched').mockResolvedValueOnce('unavailable');
    const moveBranch = vi.fn<() => Promise<'moved' | 'recovery-required'>>().mockResolvedValueOnce('moved').mockResolvedValueOnce('recovery-required');
    const prSwitch = { switchBranch, moveBranch };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const switched = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/switch-branch', headers, payload: { branch: 'feature/solo' } });
      const rejectedSwitch = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/switch-branch', headers, payload: { branch: 'feature/solo' } });
      const moved = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-branch', headers, payload: { branch: 'feature/solo' } });
      const recovery = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-branch', headers, payload: { branch: 'feature/solo' } });
      // a non-string branch is rejected before the service is consulted
      const invalidSwitch = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/switch-branch', headers, payload: { branch: 42 } });
      const invalidMove = await pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-branch', headers, payload: {} });

      expect(switched.statusCode).toBe(202);
      expect(switchBranch).toHaveBeenCalledWith('cora', 'feature/solo');
      expect(rejectedSwitch.statusCode).toBe(409);
      expect(moved.statusCode).toBe(202);
      expect(moveBranch).toHaveBeenCalledWith('cora', 'feature/solo');
      expect(recovery.statusCode).toBe(409);
      expect(recovery.json()).toMatchObject({ recoveryRequired: true, error: expect.any(String) });
      expect(invalidSwitch.statusCode).toBe(409);
      expect(invalidMove.statusCode).toBe(409);
      // the invalid requests short-circuit, so the mocks saw only the two valid calls each
      expect(switchBranch).toHaveBeenCalledTimes(2);
      expect(moveBranch).toHaveBeenCalledTimes(2);
    } finally {
      await pullRequestApp.close();
    }
  }, 15_000);

  it('surfaces a busy agent as a 409 with a reason through the controlled HTTP boundary', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // every one of the four routes maps a busy service result to a 409 carrying a "busy" reason
    const prSwitch = { switch: async () => 'busy' as const, switchBranch: async () => 'busy' as const, move: async () => 'busy' as const, moveBranch: async () => 'busy' as const };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const responses = await Promise.all([
        pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/switch-pr', headers, payload: { number: 301 } }),
        pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/switch-branch', headers, payload: { branch: 'feature/solo' } }),
        pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-pr', headers, payload: { number: 301 } }),
        pullRequestApp.inject({ method: 'POST', url: '/api/worktrees/cora/move-branch', headers, payload: { branch: 'feature/solo' } })
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/busy/i);
      }
    } finally {
      await pullRequestApp.close();
    }
  }, 15_000);
});

// exercise status publication through the shared loader
describe('dashboard status updates', () => {
  // dismissal follows the session's workspace rather than its current directory
  it.each(['/worktrees/cora/nested-repo', '/worktrees/other'])('keeps a viewed completion dismissed when its pane runs in %s', async home => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'app', path: '/worktrees/cora', identity: '/worktrees/cora' });
    const other = testWorktree({ id: 'other', projectId: 'app', path: '/worktrees/other', identity: '/worktrees/other' });
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: worktree.identity, placeId: worktree.id, worktreeId: worktree.id, title: 'Ready' });
    const notifications = new AgentNotificationCoordinator(() => {}, 0);
    notifications.observe(stated({ ...agent, title: '⠋ Working' }));
    notifications.observe(agent);
    await new Promise(resolve => setTimeout(resolve, 0));
    const discovery = {
      // expose both roots so a pane's cwd could select the wrong worktree
      worktreesNow: () => [worktree, other],
      // retain the raw pane root while the session stays assigned to cora
      target: async () => ({ agent: { ...agent, home, worktreeId: undefined }, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } }),
      // publish the session's canonical workspace just as discovery does
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] })
    };
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 37).toString('base64url')), discovery: discovery as never, notifications });
    try {
      const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const before = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
      expect(before.json().agents[0].unread).toBe(true);
      expect(before.json().agents[0].completionId).toEqual(expect.any(String));
      const dismissal = await app.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers, payload: { completionId: before.json().agents[0].completionId } });
      expect(dismissal.statusCode).toBe(204);
      const after = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
      expect(after.json().agents[0].unread).toBe(false);
      expect(after.json().agents[0].completionId).toBeUndefined();
      // preserve a new completion when the old browser request arrives again
      notifications.observe(stated({ ...agent, title: '⠋ Working' }));
      notifications.observe(agent);
      await new Promise(resolve => setTimeout(resolve, 0));
      const nextId = notifications.completionId(agent);
      const delayed = await app.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers, payload: { completionId: before.json().agents[0].completionId } });
      expect(delayed.statusCode).toBe(204);
      const latest = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
      expect(latest.json().agents[0]).toMatchObject({ unread: true, completionId: nextId });
    } finally {
      notifications.stop();
      await app.close();
    }
  });

  // publish resumed work instead of the last cached completion
  it('publishes resumed work without reusing stale agent status', async () => {
    const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
    const cachedAgent = stated({ id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' });
    let currentAgent = cachedAgent;
    const discovery = {
      // isolate agent updates from worktree enrichment
      worktreesNow: () => [],
      // model the discovery cache while allowing fresh pane observations
      dashboard: async (force = false, freshAgents = false) => ({
        generation: 1, serverStartedAt: 0, places: [], adapters: {}, projects: [],
        agents: [force || freshAgents ? currentAgent : cachedAgent]
      }),
      // skip prompt dispatch without a live pane
      target: async () => undefined
    };
    const published: string[] = [];
    // observe the same payload stream consumed by dashboard subscribers
    dashboardUpdates.subscribe(value => { published.push(value.agents[0]!.attention); });
    const app = await buildApp(config, {
      auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 36).toString('base64url')),
      discovery: discovery as never,
      dashboardUpdates,
      reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never
    });
    try {
      await dashboardUpdates.refresh();
      currentAgent = stated({ ...cachedAgent, title: '⠋ Working' });
      await dashboardUpdates.refresh();

      expect(published).toEqual(['finished', 'working']);
    } finally {
      await app.close();
    }
  });
});

describe('dashboard launch resolution', () => {
  it('publishes each scope\'s launch profile: worktree, running agent, and scratch', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const discovery = {
      worktreesNow: () => [],
      dashboard: async () => ({
        generation: 1,
        places: [],
        adapters: {},
        agents: [{ id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', kind: 'codex', attention: 'finished' }],
        projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', projectId: 'proj', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, main: false, detached: false, locked: false, order: 1 }] }]
      }),
      target: async () => undefined
    };
    // record the scope keys the loader asks for; map each to a resolution tagged with its key
    const requestedScopes: string[][] = [];
    const launch = {
      launch: async () => false,
      launchHome: async () => false,
      resume: async () => false,
      launchResolutions: async (keys: Iterable<string>) => { const scopes = [...keys]; requestedScopes.push(scopes); return new Map(scopes.map(key => [key, { kind: 'claude', origin: key }])); }
    };
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 27).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: async () => {} });
    try {
      const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie } });
      const body = dashboard.json();
      // the worktree carries its own scope's resolution, the agent carries its worktree's, scratch its group's
      expect(body.projects[0].worktrees[0].launch).toEqual({ kind: 'claude', origin: 'delta' });
      expect(body.agents[0].launch).toEqual({ kind: 'claude', origin: 'cora' });
      expect(body.scratchLaunch).toEqual({ kind: 'claude', origin: 'scratch' });
      expect(requestedScopes.some(scopes => scopes.includes('scratch') && scopes.includes('delta') && scopes.includes('cora'))).toBe(true);
    } finally {
      await app.close();
    }
  }, 15_000);
});

describe('dashboard Place launch resolution', () => {
  it("publishes each directory-Project and Scratch Place's launch profile and resolves a placed Agent's from its Place", async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const placedAgent = (id: string, placeId: string, home: string) => ({ id, sessionId: 'socket:$1', home, placeId, title: 'Ready', kind: 'codex', attention: 'finished' });
    const discovery = {
      worktreesNow: () => [],
      dashboard: async () => ({
        generation: 1,
        adapters: {},
        agents: [placedAgent('agent-notes', 'notes:/data/notes', '/data/notes'), placedAgent('agent-tools', 'scratch:/srv/tools', '/srv/tools')],
        projects: [{ id: 'notes', label: 'Notes', mode: 'directory', available: true, worktrees: [] }],
        places: [
          { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: false },
          { id: 'scratch:/srv/tools', kind: 'scratch', projectId: 'scratch', label: 'tools', home: '/srv/tools', pinned: false }
        ]
      }),
      target: async () => undefined
    };
    // map each requested scope to a resolution tagged with its key
    const launch = { launchResolutions: async (keys: Iterable<string>) => new Map([...keys].map(key => [key, { kind: 'claude', origin: key }])) };
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 27).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: async () => {} });
    try {
      const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const body = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie } })).json();
      // a directory Project launches under its Project id; a Scratch Place under its own id
      expect(body.places.map((place: { id: string; launch: unknown }) => [place.id, place.launch])).toEqual([
        ['notes:/data/notes', { kind: 'claude', origin: 'notes' }],
        ['scratch:/srv/tools', { kind: 'claude', origin: 'scratch:/srv/tools' }]
      ]);
      expect(body.agents.map((agent: { id: string; launch: unknown }) => [agent.id, agent.launch])).toEqual([
        ['agent-notes', { kind: 'claude', origin: 'notes' }],
        ['agent-tools', { kind: 'claude', origin: 'scratch:/srv/tools' }]
      ]);
    } finally {
      await app.close();
    }
  }, 15_000);
});

describe('configured worktree deactivation', () => {
  it('closes an idle configured agent so its worktree becomes inactive', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    let closed = false;
    const deactivateApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 7).toString('base64url')), discovery: { worktreesNow: () => [worktree], target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: "socket", path: "/tmp/tmux", device: 1, inode: 2 } } : undefined } as never, tmux: { close: async () => { closed = true; return true; } } as never });
    try {
      const boot = await deactivateApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await deactivateApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await deactivateApp.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(204);
      expect(closed).toBe(true);
    } finally { await deactivateApp.close(); }
  }, 15_000);

  it('runs the configured adapter teardown when the console stops an agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const shell: string[] = [];
    // the real buildApp wiring (`kind => config.adapters[kind]?.teardown`) must reach the tmux layer
    const teardownConfig = { ...config, adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true, teardown: 'rm -f .omx/state/session.json' } } };
    const teardownApp = await buildApp(teardownConfig, { auth: new AuthService(hash, Buffer.alloc(32, 8).toString('base64url')), discovery: { worktreesNow: () => [worktree], target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined } as never, tmux: { close: async () => true, runShell: async (_socket: unknown, command: string) => { shell.push(command); return true; } } as never });
    try {
      const boot = await teardownApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await teardownApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await teardownApp.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(204);
      expect(shell).toEqual(["cd -- '/worktrees/cora' && eval 'rm -f .omx/state/session.json'"]);
    } finally { await teardownApp.close(); }
  }, 15_000);

  it('runs adapters.omx.teardown for an OMX agent and no teardown for a Codex agent when only adapters.omx has one', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const omxAgent = { ...stated({ id: 'agent-omx', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' }), kind: 'omx' as const };
    const codexAgent = stated({ id: 'agent-codex', paneId: '%2', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const agents = [omxAgent, codexAgent];
    const shell: string[] = [];
    // the teardown is keyed by the stopped agent's kind: the OMX-on-ZFS cleanup never fires for a plain Codex stop
    const teardownConfig = { ...config, adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true }, omx: { program: '/abs/omx', args: [], env: {}, launchable: true, teardown: 'rm -f .omx/state/session.json' } } };
    const app = await buildApp(teardownConfig, { auth: new AuthService(hash, Buffer.alloc(32, 9).toString('base64url')), discovery: { worktreesNow: () => [worktree], target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } }; } } as never, tmux: { close: async () => true, runShell: async (_socket: unknown, command: string) => { shell.push(command); return true; } } as never });
    try {
      const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      expect((await app.inject({ method: 'POST', url: '/api/agents/agent-omx/deactivate', headers })).statusCode).toBe(204);
      expect(shell).toEqual(["cd -- '/worktrees/cora' && eval 'rm -f .omx/state/session.json'"]);
      expect((await app.inject({ method: 'POST', url: '/api/agents/agent-codex/deactivate', headers })).statusCode).toBe(204);
      expect(shell).toHaveLength(1);
    } finally { await app.close(); }
  }, 15_000);

  it('offers no sleep, wake, or forget-sleeping-tab routes, and Turn off leaves no sleeping flag', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let active = true;
    let resumed = false;
    const worktrees = [{ id: worktree.id, projectId: 'cora', label: worktree.label, path: worktree.path, available: true, pinned: false, main: true, detached: false, locked: false, order: 0 }];
    const discovery = { worktreesNow: () => [worktree],
      // expose the current process state
      dashboard: async () => ({ generation: active ? 1 : 2, places: [], adapters: {}, agents: active ? [agent] : [], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees }] }),
      // resolve only the live agent
      target: async (id: string) => active && id === agent.id ? { agent, socket } : undefined
    };
    const launch = {
      resume: async () => { resumed = true; return true; },
      launch: async () => false,
      launchHome: async () => false,
      // the dashboard loader resolves each scope's Launch profile
      launchResolutions: async () => new Map()
    };
    const app = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { active = false; return true; } } as never, launchPollDelay: async () => {} });
    try {
      const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      expect((await app.inject({ method: 'POST', url: '/api/agents/agent-1/sleep', headers })).statusCode).toBe(404);
      expect(active).toBe(true);
      expect((await app.inject({ method: 'POST', url: '/api/worktrees/cora/wake', headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/worktrees/cora/deactivate', headers })).statusCode).toBe(404);
      expect(resumed).toBe(false);

      expect((await app.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers })).statusCode).toBe(204);
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(dashboard.json().agents).toEqual([]);
      expect(dashboard.json().projects.flatMap((project: { worktrees: object[] }) => project.worktrees)).toEqual([expect.not.objectContaining({ sleeping: expect.anything() })]);
    } finally { await app.close(); }
  }, 15_000);

  it('closes an idle agent before restarting it through the resume alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-restart-agent-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false };
    const firstAgent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const secondAgent = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let resumed = false;
    let pollsAfterResume = 0;
    const discovery = { worktreesNow: () => [worktree],
      // expose one stale frame before the replacement
      dashboard: async () => {
        // retain the original agent before resume
        if (!resumed) return { generation: 1, places: [], agents: [firstAgent], projects: [] };
        pollsAfterResume += 1;
        return { generation: pollsAfterResume === 1 ? 1 : 2, places: [], agents: [pollsAfterResume === 1 ? firstAgent : secondAgent], projects: [] };
      },
      // resolve the original restart target
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined
    };
    const launch = {
      launch: async () => false,
      launchHome: async () => false,
      // record the host alias handoff
      resume: async (id: string) => { events.push(`resume:${id}`); resumed = true; return true; }
    };
    const restartApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')), launchPollDelay: async () => {} });
    try {
      const boot = await restartApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await restartApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const restarted = await restartApp.inject({ method: 'POST', url: '/api/agents/agent-1/restart', headers });

      expect(restarted.statusCode).toBe(201);
      expect(restarted.json()).toEqual({ agentId: 'agent-2' });
      expect(events).toEqual(['close:agent-1', 'resume:cora']);
    } finally { await restartApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);

  it("restarts one of two Agents at a Worktree into its own conversation, never the sibling's latest", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-restart-sibling-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false };
    const conversationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const restarting = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora', conversationId });
    const sibling = { ...restarting, id: 'agent-3', paneId: '%3', conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
    const replacement = { ...restarting, id: 'agent-2', paneId: '%2' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let resumed = false;
    const discovery = { worktreesNow: () => [worktree],
      dashboard: async () => ({ generation: resumed ? 2 : 1, places: [], agents: resumed ? [sibling, replacement] : [restarting, sibling], projects: [] }),
      target: async (id: string) => id === restarting.id ? { agent: restarting, socket } : undefined
    };
    const launch = {
      launchHome: async () => false,
      isLaunchableKind: () => true,
      canResumeConversation: () => true,
      resume: async (id: string) => { events.push(`resume:${id}`); resumed = true; return true; },
      resumeConversation: async (id: string, threadId: string, kind?: string) => { events.push(`resume:${id}:${threadId}:${kind}`); resumed = true; return true; },
      launch: async (id: string, kind?: string) => { events.push(`fresh:${id}:${kind}`); resumed = true; return true; }
    };
    const restartApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { events.push(`close:${restarting.id}`); return true; } } as never, queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')), launchPollDelay: async () => {} });
    try {
      const boot = await restartApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await restartApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const restarted = await restartApp.inject({ method: 'POST', url: '/api/agents/agent-1/restart', headers });

      expect(restarted.statusCode).toBe(201);
      expect(restarted.json()).toEqual({ agentId: 'agent-2' });
      expect(events).toEqual(['close:agent-1', `resume:cora:${conversationId}:codex`]);

      // Restart as another kind cannot resume this Agent's conversation, and "the latest" could be
      // the sibling's: it starts fresh instead
      events.length = 0;
      resumed = false;
      const restartedAs = await restartApp.inject({ method: 'POST', url: '/api/agents/agent-1/restart', headers, payload: { kind: 'claude' } });
      expect(restartedAs.statusCode).toBe(201);
      expect(events).toEqual(['close:agent-1', 'fresh:cora:claude']);
    } finally { await restartApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('Console shells server lifecycle', () => {
  const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
  const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/worktrees/cora', available: true, pinned: false, main: false, detached: false, locked: false };
  const idleDashboard = { generation: 1, places: [], adapters: {}, agents: [] as unknown[], projects: [{ id: 'cora', label: 'Cora', mode: 'repository', available: true, manageWorktrees: true, stalePaths: [], worktrees: [] }] };
  const shell = { paneId: '%9', sessionId: '$1', pid: 9, path: '/worktrees/cora', command: 'zsh', role: 'shell', title: '', socket };
  const consoleShellBusy = (pane: { command: string }) => pane.command !== 'zsh';
  let secret = 30;
  // build the app with the given fakes and return a logged-in session's headers
  // `realLaunch` leaves the launch service to buildApp, so its Place-session lookup is the app's own wiring
  const start = async (deps: { discovery?: object; launch?: object; realLaunch?: true; tmux?: object; worktreeCommands?: object; editor?: string; keys?: KeysConfig }) => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => idleDashboard, target: async () => undefined, ...deps.discovery };
    const launch = { launchResolutions: async () => new Map(), ...deps.launch };
    const app = await buildApp({ ...config, ...(deps.editor === undefined ? {} : { editor: deps.editor }), ...(deps.keys === undefined ? {} : { keys: deps.keys }) }, { auth: new AuthService(hash, Buffer.alloc(32, secret++).toString('base64url')), discovery: discovery as never, ...(deps.realLaunch ? {} : { launch: launch as never }), tmux: (deps.tmux ?? {}) as never, ...(deps.worktreeCommands === undefined ? {} : { worktreeCommands: deps.worktreeCommands as never }) });
    const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
    const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    return { app, headers };
  };

  it('lists the Worktree panes with their role, name, busy and agent flags', async () => {
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const agentPane = { paneId: '%1', sessionId: '$1', windowId: '@0', pid: 1, path: '/worktrees/cora', command: 'codex', title: '', socket };
    const busyShell = { ...shell, windowId: '@3', paneName: 'build', command: 'vim' };
    const { app, headers } = await start({ discovery: { dashboard: async () => ({ ...idleDashboard, agents: [agent] }) }, launch: { placePanes: async () => [agentPane, busyShell], consoleShellBusy } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/worktrees/cora/panes', headers: { host: headers.host, cookie: headers.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().panes).toEqual([
        { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
        { paneId: '%9', session: '$1', window: '@3', role: 'shell', name: 'build', command: 'vim', path: '/worktrees/cora', title: '', agent: false, busy: true }
      ]);
    } finally { await app.close(); }
  }, 15_000);

  it('names a Stack process pane for its process', async () => {
    const processPane = { paneId: '%4', sessionId: '$1', windowId: '@4', pid: 4, path: '/worktrees/cora/web', command: 'node', role: 'process', processName: 'dev', title: '', socket };
    const { app, headers } = await start({ launch: { placePanes: async () => [processPane], consoleShellBusy } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/worktrees/cora/panes', headers: { host: headers.host, cookie: headers.cookie } });
      expect(response.json().panes).toEqual([{ paneId: '%4', session: '$1', window: '@4', role: 'process', name: 'dev', command: 'node', path: '/worktrees/cora/web', title: '', agent: false }]);
    } finally { await app.close(); }
  }, 15_000);

  it('opens a Console shell beside a live Agent, in the Agent session', async () => {
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', placeId: 'cora', worktreeId: 'cora' });
    const createConsoleShellWindow = vi.fn(async () => '%9');
    const { app, headers } = await start({ discovery: { dashboard: async () => ({ ...idleDashboard, agents: [agent] }), target: async (id: string) => id === agent.id ? { agent, socket } : undefined }, realLaunch: true, tmux: { createConsoleShellWindow } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { name: 'build' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ paneId: '%9' });
      expect(createConsoleShellWindow).toHaveBeenCalledWith(socket, '$1', '/worktrees/cora', expect.any(Array), 'build');
    } finally { await app.close(); }
  }, 15_000);

  it("joins the Place's live Agent session from a fresh discovery, never a cached Agent that has just closed", async () => {
    // a restart closes its Agent and relaunches within the dashboard cache window: the cached
    // snapshot still lists the closed Agent (session $1), a forced scan sees only the live one ($2)
    const closed = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', placeId: 'cora', worktreeId: 'cora' });
    const live = { ...closed, id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2' };
    const createConsoleShellWindow = vi.fn(async () => '%9');
    const dashboard = async (force = false) => ({ ...idleDashboard, agents: [force ? live : closed] });
    const target = async (id: string) => id === live.id ? { agent: live, socket } : id === closed.id ? { agent: closed, socket } : undefined;
    const { app, headers } = await start({ discovery: { dashboard, target }, realLaunch: true, tmux: { createConsoleShellWindow } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { name: 'build' } });
      expect(response.statusCode).toBe(201);
      expect(createConsoleShellWindow).toHaveBeenCalledWith(socket, '$2', '/worktrees/cora', expect.any(Array), 'build');
    } finally { await app.close(); }
  }, 15_000);

  it('opens the configured editor in a Console shell named for its program, and says one is configured', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell }, editor: '/usr/local/bin/nvim -p' });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { editor: true } });
      expect(response.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenCalledWith(worktreePlace(worktree as never), 'nvim', '/usr/local/bin/nvim -p');
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(dashboard.json().editor).toBe(true);
    } finally { await app.close(); }
  }, 15_000);

  it('opens a terminal key binding with the command from config, named for its program', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const keys = parseKeysConfig({ root: { 'C-g': { table: 'git' } }, git: { d: { terminal: '/usr/bin/gh dash --verbose' } } });
    const { app, headers } = await start({ launch: { createConsoleShell, placeConsoleShells: async () => [] }, keys });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { binding: { table: 'git', key: 'd' } } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ paneId: '%9' });
      expect(createConsoleShell).toHaveBeenCalledWith(worktreePlace(worktree as never), 'gh', '/usr/bin/gh dash --verbose', 'git d');
      // the browser sees each terminal binding's program, never its command line
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(dashboard.json().keys).toEqual({ root: { 'C-g': { table: 'git' } }, git: { d: { terminal: 'gh' } } });
    } finally { await app.close(); }
  }, 15_000);

  it('focuses the running pane of a reuse binding instead of opening another', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    // only the pane tagged with the binding is its Terminal; another pane named for the program is not
    const placeConsoleShells = vi.fn(async () => [{ ...shell, paneId: '%3', paneName: 'lazygit', command: 'lazygit' }, { ...shell, paneId: '%4', paneName: 'lg', command: 'lazygit', keyBinding: 'prefix g' }]);
    const { app, headers } = await start({ launch: { createConsoleShell, placeConsoleShells } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { binding: { table: 'prefix', key: 'g' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ paneId: '%4', reused: true });
      expect(createConsoleShell).not.toHaveBeenCalled();
      placeConsoleShells.mockResolvedValueOnce([]);
      const opened = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { binding: { table: 'prefix', key: 'g' } } });
      expect(opened.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenCalledWith(worktreePlace(worktree as never), 'lazygit', 'lazygit', 'prefix g');
    } finally { await app.close(); }
  }, 15_000);

  it('refuses a binding that names no terminal, carries a command, or mixes with the editor', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell, placeConsoleShells: async () => [] }, editor: 'nvim', keys: parseKeysConfig({ prefix: { g: null } }) });
    try {
      for (const payload of [{ binding: { table: 'prefix', key: 'c' } }, { binding: { table: 'prefix', key: 'g' } }, { binding: { table: 'nope', key: 'x' } }, { binding: { table: '__proto__', key: 'toString' } }, { binding: 'prefix g' }, { binding: { table: 'prefix', key: 'g', terminal: 'htop' } }, { binding: { table: 'prefix', key: 'c' }, editor: true }, { binding: { table: 'prefix', key: 'c' }, name: 'x' }]) {
        const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(createConsoleShell).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 15_000);

  it('opens the configured editor at a file and line inside the Place', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell }, editor: '/usr/local/bin/nvim -p' });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { editor: true, file: "src/it's.ts", line: 42 } });
      expect(response.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenCalledWith(worktreePlace(worktree as never), 'nvim', "/usr/local/bin/nvim -p +42 'src/it'\\''s.ts'");
      const dashed = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { editor: true, file: '-rf', line: 1 } });
      expect(dashed.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenLastCalledWith(worktreePlace(worktree as never), 'nvim', "/usr/local/bin/nvim -p +1 './-rf'");
    } finally { await app.close(); }
  }, 15_000);

  it('refuses an editor file outside the Place, a bad line, or a file without the editor', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell }, editor: 'nvim' });
    try {
      for (const payload of [{ editor: true, file: '/etc/passwd', line: 1 }, { editor: true, file: 'src/../../secret', line: 1 }, { editor: true, file: 'a\nb', line: 1 }, { editor: true, file: 'a.ts', line: 0 }, { editor: true, file: 'a.ts', line: 1.5 }, { editor: true, line: 3 }, { file: 'a.ts', line: 1 }]) {
        const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(createConsoleShell).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 15_000);

  it('refuses an editor shell when no editor is configured, and leaves it off the dashboard', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: { editor: true } });
      expect(response.statusCode).toBe(400);
      expect(createConsoleShell).not.toHaveBeenCalled();
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(dashboard.json().editor).toBeUndefined();
    } finally { await app.close(); }
  }, 15_000);

  it('opens a Console shell with no name and no live Agent', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, headers } = await start({ launch: { createConsoleShell } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/shells', headers, payload: {} });
      expect(response.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenCalledWith(worktreePlace(worktree as never), '', '');
    } finally { await app.close(); }
  }, 15_000);

  it('renames a Console shell by writing its name option', async () => {
    const renamePaneName = vi.fn(async () => true);
    const { app, headers } = await start({ launch: { placeConsoleShells: async () => [shell] }, tmux: { renamePaneName } });
    try {
      const response = await app.inject({ method: 'PATCH', url: '/api/worktrees/cora/panes/%259', headers, payload: { name: 'build' } });
      expect(response.statusCode).toBe(204);
      expect(renamePaneName).toHaveBeenCalledWith(socket, '%9', 'build');
      // a control character in the name is rejected before touching tmux
      const bad = await app.inject({ method: 'PATCH', url: '/api/worktrees/cora/panes/%259', headers, payload: { name: 'a\nb' } });
      expect(bad.statusCode).toBe(400);
      expect(renamePaneName).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  }, 15_000);

  it('ends an idle Console shell, and reports a busy one until the operator confirms', async () => {
    const close = vi.fn(async () => true);
    const busy = { ...shell, command: 'vim' };
    const { app, headers } = await start({ launch: { placeConsoleShells: async () => [busy], consoleShellBusy }, tmux: { close } });
    try {
      // a busy shell is reported, not killed, until confirmed
      const blocked = await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/panes/%259', headers });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ busy: true });
      expect(close).not.toHaveBeenCalled();
      const confirmed = await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/panes/%259?confirm=1', headers });
      expect(confirmed.statusCode).toBe(204);
      expect(close).toHaveBeenCalledWith(socket, '%9');
    } finally { await app.close(); }
  }, 15_000);

  it('ends an idle Console shell without confirmation', async () => {
    const close = vi.fn(async () => true);
    const { app, headers } = await start({ launch: { placeConsoleShells: async () => [shell], consoleShellBusy }, tmux: { close } });
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/panes/%259', headers });
      expect(response.statusCode).toBe(204);
      expect(close).toHaveBeenCalledWith(socket, '%9');
    } finally { await app.close(); }
  }, 15_000);

  it('mints a pane ticket for a Worktree target', async () => {
    const { app, headers } = await start({});
    try {
      const response = await app.inject({ method: 'POST', url: '/api/worktrees/cora/tickets', headers, payload: { kind: 'pane' } });
      expect(response.statusCode).toBe(200);
      expect(typeof response.json().ticket).toBe('string');
      const bad = await app.inject({ method: 'POST', url: '/api/worktrees/cora/tickets', headers, payload: { kind: 'bogus' } });
      expect(bad.statusCode).toBe(400);
    } finally { await app.close(); }
  }, 15_000);

  // "Show dev output" reads the process pane through the service; a name the Worktree does not
  // configure is missing, and a tmux that cannot answer is a failed read, not an error page
  it("returns a Stack process's output, 404 for a name not configured, and 503 when tmux cannot answer", async () => {
    const reads: string[] = [];
    const processOutput = async (id: string, name: string) => { reads.push(`${id}/${name}`); return name === 'dev' ? { name: 'dev', state: 'exited', exitCode: 127, output: 'pnpm: command not found' } : name === 'web' ? 'unavailable' : undefined; };
    const { app, headers } = await start({ worktreeCommands: { processOutput } });
    try {
      const read = { host: headers.host, cookie: headers.cookie };
      const response = await app.inject({ method: 'GET', url: '/api/worktrees/cora/processes/dev/output', headers: read });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ name: 'dev', state: 'exited', exitCode: 127, output: 'pnpm: command not found' });
      expect((await app.inject({ method: 'GET', url: '/api/worktrees/cora/processes/api/output', headers: read })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/worktrees/cora/processes/web/output', headers: read })).statusCode).toBe(503);
      expect(reads).toEqual(['cora/dev', 'cora/api', 'cora/web']);
      // pane output can carry secrets a command printed: it needs a signed-in session
      expect((await app.inject({ method: 'GET', url: '/api/worktrees/cora/processes/dev/output', headers: { host: headers.host } })).statusCode).toBe(401);
      expect(reads).toHaveLength(3);
    } finally { await app.close(); }
  }, 15_000);

  it("clears a Stack process's output, 404 for a name not configured, 503 when tmux cannot answer", async () => {
    const clears: string[] = [];
    const clearProcessOutput = async (id: string, name: string) => { clears.push(`${id}/${name}`); return name === 'dev' ? true : name === 'web' ? 'unavailable' : undefined; };
    const { app, headers } = await start({ worktreeCommands: { clearProcessOutput } });
    try {
      expect((await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/processes/dev/output', headers })).statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/processes/api/output', headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/processes/web/output', headers })).statusCode).toBe(503);
      // a clear changes the pane, so it needs the CSRF token, not only a session
      expect((await app.inject({ method: 'DELETE', url: '/api/worktrees/cora/processes/dev/output', headers: { host: headers.host, cookie: headers.cookie } })).statusCode).toBe(403);
      expect(clears).toEqual(['cora/dev', 'cora/api', 'cora/web']);
    } finally { await app.close(); }
  }, 15_000);

  // one process of the stack: a name the Worktree does not configure, or a one-shot action, has
  // no route; a busy Worktree is the command route's 409, and a Start that fails is not a 404
  it('starts, stops and restarts one Stack process, 404 for a name or action it has not, 409 while busy', async () => {
    const calls: string[] = [];
    const results = ['started', 'started', 'started', 'busy', false] as const;
    const startAction = async (id: string, action: string, name?: string) => { calls.push(`${id}/${action}/${name}`); return results[calls.length - 1]; };
    const withProcesses = { ...worktree, commands: { processes: { sync: 'ods exec sync', api: 'ods exec api' }, build: 'pnpm build' } };
    const { app, headers } = await start({ discovery: { worktreesNow: () => [withProcesses] }, worktreeCommands: { start: startAction } });
    try {
      const post = (rest: string) => app.inject({ method: 'POST', url: `/api/worktrees/cora/processes/${rest}`, headers });
      for (const action of ['start', 'stop', 'restart']) expect((await post(`api/${action}`)).statusCode).toBe(202);
      expect((await post('sync/restart')).statusCode).toBe(409);
      const failed = await post('sync/start');
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'stack command failed' });
      expect(calls).toEqual(['cora/start/api', 'cora/stop/api', 'cora/restart/api', 'cora/restart/sync', 'cora/start/sync']);
      expect((await post('web/start')).statusCode).toBe(404);
      expect((await post('api/build')).statusCode).toBe(404);
      expect((await post('api/output')).statusCode).toBe(404);
      expect(calls).toHaveLength(5);
      // an operator action: it needs the CSRF token
      expect((await app.inject({ method: 'POST', url: '/api/worktrees/cora/processes/api/start', headers: { host: headers.host, cookie: headers.cookie } })).statusCode).toBe(403);
      expect(calls).toHaveLength(5);
    } finally { await app.close(); }
  }, 15_000);

  it('offers no Stack process route on a Worktree without processes', async () => {
    const startAction = vi.fn(async () => 'started');
    const { app, headers } = await start({ discovery: { worktreesNow: () => [{ ...worktree, commands: { start: 'docker compose up -d', stop: 'docker compose down' } }] }, worktreeCommands: { start: startAction } });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/worktrees/cora/processes/dev/start', headers })).statusCode).toBe(404);
      expect(startAction).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 15_000);

  it('refuses to remove a Worktree while it has an open Console shell', async () => {
    const { app, headers } = await start({ launch: { placeConsoleShells: async () => [shell] }, worktreeCommands: { sessionRunning: async () => false } });
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/worktrees/cora', headers });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('End the open terminals before removing this worktree');
    } finally { await app.close(); }
  }, 15_000);

  // Turn off closes only the Agent's own pane (`prompts.close`). A Console shell is a
  // separate pane in its own window, so recording every `kill-pane` and asserting only the
  // Agent's `%1` is closed proves the shell's pane (`%9`) is never touched — without relying on
  // the shell-scan, which this route deliberately never calls.
  it('leaves a Console shell alone when the Agent is turned off', async () => {
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const closed: string[] = [];
    const { app, headers } = await start({ discovery: { dashboard: async () => ({ ...idleDashboard, agents: [agent] }), target: async (id: string) => id === agent.id ? { agent, socket } : undefined }, tmux: { close: async (_socket: unknown, pane: string) => { closed.push(pane); return true; } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers });
      expect(response.statusCode).toBe(204);
      expect(closed).toEqual(['%1']);
    } finally { await app.close(); }
  }, 15_000);
});

describe('agent GitHub Actions route', () => {
  it('returns the pull-request switch service actions URL, or 404 when there is none', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const actionsApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 8).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [] } as never,
      prSwitch: { actionsUrl: async (id: string) => id === agent.id ? 'https://github.com/octo/repo/actions' : undefined } as never
    });
    try {
      const boot = await actionsApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await actionsApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const actions = await actionsApp.inject({ method: 'GET', url: `/api/agents/${agent.id}/github-actions`, headers });
      const missing = await actionsApp.inject({ method: 'GET', url: '/api/agents/agent-2/github-actions', headers });

      expect(actions.json()).toEqual({ url: 'https://github.com/octo/repo/actions' });
      expect(missing.statusCode).toBe(404);
    } finally { await actionsApp.close(); }
  }, 15_000);

  it('looks up a Worktree’s actions URL from its checkout, with no Agent running there', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'demo', identity: '/worktrees/cora', path: '/worktrees/cora', label: 'Cora', main: false, detached: false, locked: false };
    const requested: string[] = [];
    const actionsApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 8).toString('base64url')),
      discovery: { worktreesNow: () => [worktree] } as never,
      prSwitch: { actionsUrlAt: async (workspace: string) => { requested.push(workspace); return 'https://github.com/octo/repo/actions'; } } as never
    });
    try {
      const boot = await actionsApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await actionsApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const actions = await actionsApp.inject({ method: 'GET', url: '/api/worktrees/cora/github-actions', headers });
      const unknown = await actionsApp.inject({ method: 'GET', url: '/api/worktrees/nope/github-actions', headers });

      expect(actions.json()).toEqual({ url: 'https://github.com/octo/repo/actions' });
      expect(requested).toEqual(['/worktrees/cora']);
      expect(unknown.statusCode).toBe(404);
    } finally { await actionsApp.close(); }
  }, 15_000);
});

describe('guided review API boundary', () => {
  it('normalizes malformed and oversized requests while accepting the exact request shape', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const comparison = { agentId: 'agent-1', worktreeId: 'cora', workspace: '/worktrees/cora', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'empty-fingerprint', changes: [] };
    let prepares = 0;
    const reviewTours = {
      capability: async () => ({ available: true }),
      prepare: async () => { prepares += 1; return { comparison, resolved: {} }; },
      fingerprint: async () => ({ comparison: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false }, empty: true })
    };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const pasted: string[] = [];
    const reviewApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')),
      reviewTours: reviewTours as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [] } as never,
      tmux: { pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt); return true; }, sendKeys: async () => true } as never
    });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken, 'content-type': 'application/json' };
      const malformed = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: '{"scope":' });
      const oversized = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, padding: 'x'.repeat(9_000) }) });
      const unexpected = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, unexpected: true }) });
      const idempotentHeaders = { ...headers, 'idempotency-key': 'review-start_1234567890' };
      const invalidRequestId = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: { ...headers, 'idempotency-key': 'short' }, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const valid = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: idempotentHeaders, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const replay = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: idempotentHeaders, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const invalidFingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=maybe&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const fingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=false&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const maximumPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_000), attachments: [] }) });
      const oversizedPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_001), attachments: [] }) });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(unexpected.statusCode).toBe(400);
      expect(unexpected.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(invalidRequestId.statusCode).toBe(400);
      expect(invalidRequestId.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ status: 'empty', comparison: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(valid.json());
      expect(prepares).toBe(1);
      expect(invalidFingerprint.statusCode).toBe(400);
      expect(invalidFingerprint.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(fingerprint.statusCode).toBe(200);
      expect(fingerprint.json()).toEqual({ status: 'empty', comparison: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(maximumPrompt.statusCode).toBe(204);
      expect(oversizedPrompt.statusCode).toBe(400);
      expect(pasted).toHaveLength(1);
    } finally { await reviewApp.close(); }
  }, 15_000);

  it('serves and dismisses a branch-bound review from durable dashboard state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false };
    const review: ReviewTour = { title: 'Persisted tour', overview: 'Resume the saved walkthrough.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'persisted-fingerprint-1234', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
    const reviewStore = new ReviewTourStore(join(directory, 'reviews.json'));
    await reviewStore.save('cora', 'feature/review', review);
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [{ id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, main: true, detached: false, locked: false, order: 0, branch: 'feature/review' }] }] }) };
    const reviewApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), discovery: discovery as never, reviewStore, reviewTours: { capability: async () => ({ available: true }) } as never });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const mutationHeaders = { ...headers, origin: 'https://agents.example.com', 'x-csrf-token': login.json().csrfToken };
      const dashboard = await reviewApp.inject({ method: 'GET', url: '/api/dashboard', headers });
      const restored = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      const dismissed = await reviewApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/review-tour', headers: mutationHeaders });
      const missing = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      expect(dashboard.json().reviews).toEqual([expect.objectContaining({ worktreeId: 'cora', branch: 'feature/review', title: review.title })]);
      expect(restored.json()).toMatchObject({ status: 'ready', review: { worktreeId: 'cora', branch: 'feature/review', tour: { fingerprint: review.fingerprint } } });
      expect(dismissed.statusCode).toBe(204);
      expect(missing.statusCode).toBe(404);
    } finally { await reviewApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('review tour capability', () => {
  it('describes the configured tour agent, its effort levels and its run mode in the dashboard', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    const review = resolveReviewConfig({ agents: { claude: { mode: 'interactive' } }, tour: { agent: 'claude', effort: 'high' } }, { claude: {} });
    const capabilityApp = await buildApp({ ...config, adapters: { claude: { program: '/usr/local/bin/claude', args: [], env: {}, launchable: true } }, review }, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never });
    try {
      const boot = await capabilityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await capabilityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const dashboard = await capabilityApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] } });
      // an interactive tour agent runs as a visible Agent once its kind is configured and executable
      expect(dashboard.json().reviewTour).toEqual({ available: true, agent: 'claude', effort: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    } finally { await capabilityApp.close(); }
  }, 15_000);

  it('reports an unconfigured default Codex tour unavailable', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    const saved = process.env.RAC_CODEX_BIN;
    delete process.env.RAC_CODEX_BIN;
    const capabilityApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), discovery: discovery as never });
    try {
      const boot = await capabilityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await capabilityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const dashboard = await capabilityApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] } });
      expect(dashboard.json().reviewTour).toEqual({ available: false, reason: 'configuration_invalid', agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] });
    } finally { await capabilityApp.close(); if (saved !== undefined) process.env.RAC_CODEX_BIN = saved; }
  }, 15_000);
});

describe('code review API', () => {
  it('starts a review with a tour, polls it, joins it to the stored tour and adds another', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-code-review-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false };
    const change = { id: 'chg_route0001', file: 'src/route.ts', category: 'implementation' as const, kind: 'hunk' as const, oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, patch: '@@ -1 +1,2 @@\n-old\n+new\n+more' };
    const comparison = { agentId: 'agent-1', worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/review', scope: 'pr' as const, base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'review-fingerprint-1234', changes: [change] };
    const tour: ReviewTour = { title: 'Route tour', overview: 'Follow the route.', steps: [{ id: 'route', title: 'Route', explanation: 'The route changes.', changeIds: [change.id] }], scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: comparison.fingerprint, changes: [change] };
    let prepares = 0;
    let finishTour!: (tour: ReviewTour) => void;
    let tourProgress: ReviewRunProgress | undefined;
    const reviewTours = {
      capability: async () => ({ available: true, agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] }),
      prepare: async () => { prepares += 1; return { comparison, resolved: { worktree } }; },
      generate: async (_prepared: unknown, _signal: AbortSignal, progress?: ReviewRunProgress) => { tourProgress = progress; return await new Promise<ReviewTour>(resolve => { finishTour = resolve; }); }
    };
    const runs: Array<{ request: { label: string; effort?: string; prompt: string } & ReviewRunProgress; signal: AbortSignal; resolve: (value: unknown) => void }> = [];
    const reviewRunner = { capability: async () => ({ available: true }), run: async (request: { label: string; prompt: string }, signal: AbortSignal) => await new Promise(resolve => { runs.push({ request, signal, resolve }); }) };
    const review = resolveReviewConfig({ presets: [{ id: 'correctness', label: 'Correctness', agent: 'codex', effort: 'high', prompt: 'Review for correctness.' }, { id: 'security', label: 'Security', agent: 'codex', prompt: 'Review for security.' }] }, { codex: {} });
    const reviewStore = new ReviewTourStore(join(directory, 'reviews.json'));
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [{ id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, main: true, detached: false, locked: false, order: 0, branch: 'feature/review' }] }] }) };
    const reviewApp = await buildApp({ ...config, review }, { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, reviewStore, reviewTours: reviewTours as never, reviewRunner: reviewRunner as never, push: { notify: async () => undefined } as never });
    // wait until a condition holds
    const until = async (check: () => Promise<boolean>) => { for (let index = 0; index < 100 && !await check(); index += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const deleteHeaders = { ...headers, origin: 'https://agents.example.com', 'x-csrf-token': login.json().csrfToken };
      const mutationHeaders = { ...deleteHeaders, 'content-type': 'application/json' };
      const scope = { scope: 'pr', includeTests: false, includeDocs: false };

      const unknownPreset = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, codeReview: { preset: 'missing' } }) });
      const badEffort = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, codeReview: { preset: 'correctness', effort: 'max' } }) });
      const longFocus = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, codeReview: { preset: 'correctness', focus: 'x'.repeat(2_001) } }) });
      expect([unknownPreset.statusCode, badEffort.statusCode, longFocus.statusCode]).toEqual([400, 400, 400]);
      expect(unknownPreset.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(prepares).toBe(0);

      const started = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, effort: 'low', codeReview: { preset: 'correctness', focus: 'ナ'.repeat(2_000) } }) });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({ status: 'pending', job: { id: expect.any(String), startedAt: expect.any(String) }, codeReview: { job: { id: expect.any(String), expiresAt: expect.any(String), retryAfterMs: 1_000, startedAt: expect.any(String) } } });
      // an interactive tour run names its Agent and its question state on the pending poll
      const tourJob = started.json().job.id as string;
      expect((await reviewApp.inject({ method: 'GET', url: `/api/review-tour/jobs/${tourJob}`, headers })).json()).not.toHaveProperty('run');
      tourProgress?.onStarted?.({ agentId: 'agent-tour' });
      tourProgress?.onAttention?.(true);
      expect((await reviewApp.inject({ method: 'GET', url: `/api/review-tour/jobs/${tourJob}`, headers })).json()).toEqual({ status: 'pending', job: started.json().job, run: { agentId: 'agent-tour', needsInput: true } });
      expect(prepares).toBe(1);
      expect(runs[0]!.request).toMatchObject({ label: '🔍 Review · Correctness', effort: 'high' });
      const reviewJob = started.json().codeReview.job.id as string;
      const pending = await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${reviewJob}`, headers });
      expect(pending.statusCode).toBe(202);
      expect(pending.json()).toEqual({ status: 'pending', job: started.json().codeReview.job });
      runs[0]!.request.onStarted?.({ agentId: 'agent-review' });
      expect((await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${reviewJob}`, headers })).json()).toMatchObject({ status: 'pending', run: { agentId: 'agent-review', needsInput: false } });
      runs[0]!.request.onAttention?.(true);
      expect((await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${reviewJob}`, headers })).json().run).toEqual({ agentId: 'agent-review', needsInput: true });
      expect((await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers })).statusCode).toBe(404);

      // the review finishes before the tour
      runs[0]!.resolve({ findings: [{ changeId: change.id, side: 'additions', startLine: 2, endLine: 2, severity: 'high', title: 'Unchecked value', body: 'The new line skips validation.' }], general: [] });
      await until(async () => (await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${reviewJob}`, headers })).statusCode === 200);
      const ready = await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${reviewJob}`, headers });
      expect(ready.json()).toMatchObject({ status: 'ready', review: { fingerprint: comparison.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'codex' }, effort: 'high', findings: [{ changeId: change.id, side: 'additions', startLine: 2, endLine: 2, severity: 'high' }], general: [] } });
      finishTour(tour);
      await until(async () => (await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers })).statusCode === 200);
      const stored = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      expect(stored.json()).toMatchObject({ status: 'ready', review: { tour: { fingerprint: comparison.fingerprint }, codeReview: ready.json().review } });
      expect(stored.json().review).not.toHaveProperty('codeReviewJob');
      const dashboard = await reviewApp.inject({ method: 'GET', url: '/api/dashboard', headers });
      expect(dashboard.json().codeReview).toEqual({ defaultPreset: 'correctness', presets: [{ id: 'correctness', label: 'Correctness', agent: 'codex', effort: 'high', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], available: true }, { id: 'security', label: 'Security', agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], available: true }] });
      expect(dashboard.json().reviews).toEqual([expect.objectContaining({ worktreeId: 'cora', codeReview: 'ready', findings: 1 })]);

      // "Add AI review" to the stored tour
      const stale = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/code-review/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, fingerprint: 'other-fingerprint-1234', preset: 'security' }) });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ status: 'error', error: { code: 'stale_during_generation', retryable: true } });
      const invalidAdd = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/code-review/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, fingerprint: comparison.fingerprint, preset: 'missing' }) });
      expect(invalidAdd.statusCode).toBe(400);
      const added = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/code-review/jobs', headers: mutationHeaders, payload: JSON.stringify({ ...scope, fingerprint: comparison.fingerprint, preset: 'security', effort: 'xhigh' }) });
      expect(added.statusCode).toBe(202);
      expect(added.json()).toMatchObject({ status: 'pending', job: { id: expect.any(String), retryAfterMs: 1_000 } });
      expect(runs[1]!.request).toMatchObject({ label: '🔍 Review · Security', effort: 'xhigh' });
      const resumed = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      expect(resumed.json().review.codeReviewJob).toEqual(added.json().job);
      expect((await reviewApp.inject({ method: 'GET', url: '/api/dashboard', headers })).json().reviews).toEqual([expect.objectContaining({ codeReview: 'running' })]);
      const cancelled = await reviewApp.inject({ method: 'DELETE', url: `/api/code-review/jobs/${added.json().job.id as string}`, headers: deleteHeaders });
      expect(cancelled.statusCode).toBe(204);
      expect(runs[1]!.signal.aborted).toBe(true);
      const gone = await reviewApp.inject({ method: 'GET', url: `/api/code-review/jobs/${added.json().job.id as string}`, headers });
      expect(gone.statusCode).toBe(410);
      expect(gone.json()).toMatchObject({ status: 'error', error: { code: 'job_cancelled' } });
      expect((await reviewApp.inject({ method: 'DELETE', url: '/api/code-review/jobs/unknown', headers: deleteHeaders })).statusCode).toBe(404);

      // dismissing the tour clears its review
      expect((await reviewApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/review-tour', headers: deleteHeaders })).statusCode).toBe(204);
      expect(await reviewStore.codeReview('cora', 'feature/review', comparison.fingerprint)).toBeUndefined();
    } finally { await reviewApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('queued prompt API', () => {
  // pair shared attachment storage with the repository's host namespace
  it('uses the host repository rather than a different stack workspace for Scratch attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scratch-attachment-api-'));
    vi.stubEnv('RAC_SERVER_CHECKOUT', directory);
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/fixture/host-tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/console-checkout');
    vi.stubEnv('RAC_HOST_WORKSPACE', '/host/stack-workspace');
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/host/unmounted-home', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let pasted = '';
    let submitted = false;
    const queuedApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 35).toString('base64url')),
      // discover a host-side Scratch pane without a mapped worktree
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      promptHistory: new PromptHistoryService(join(directory, 'history.json')),
      tmux: {
        // retain the actual outbound host reference
        pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted = prompt; return true; },
        // acknowledge only the submitted draft
        capture: async () => submitted ? '› ' : `› [Pasted Content ${[...pasted].length} chars]`,
        // accept one idle prompt
        sendKeys: async () => { submitted = true; return true; }
      } as never
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const response = await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: '', attachments: [{ name: 'report.csv', data: Buffer.from('report bytes').toString('base64') }] } });
      expect(response.statusCode).toBe(204);
      const hostPrefix = 'Attached files:\n@/host/console-checkout/';
      expect(pasted.startsWith(hostPrefix)).toBe(true);
      await expect(readFile(join(directory, pasted.slice(hostPrefix.length).trimEnd()), 'utf8')).resolves.toBe('report bytes');
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      expect(listed.json().prompts).toEqual([]);
    } finally {
      // release the app and its isolated shared checkout
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // preserve every valid attachment beyond the former request count cap
  it('accepts a durable prompt with more than ten attachments when immediate agent acknowledgement is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-unacknowledged-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: directory, title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let pasted = '';
    // create distinct one-byte files beyond the former count cap
    const attachments = Array.from({ length: 11 }, (_, index) => ({ name: `context-${index}.txt`, data: 'eA==' }));
    const queuedApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 34).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      tmux: {
        pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted = prompt; return true; },
        capture: async () => `› ${pasted}`,
        // model a key accepted by tmux but ignored by Codex
        sendKeys: async () => true
      } as never
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const submitted = await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Retain this prompt', attachments } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(submitted.statusCode).toBe(204);
      // verify every attachment survives request parsing and queue persistence
      const summaries = attachments.map(attachment => ({ name: attachment.name, size: 1 }));
      expect(listed.json().prompts).toMatchObject([{ text: 'Retain this prompt', attachments: summaries }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('lists, reorders, edits, and cancels prompts waiting behind a busy agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 11).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [worktree] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'First prompt', attachments: [] } });
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Second prompt', attachments: [] } });

      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [first, second] = listed.json().prompts as Array<{ id: string; text: string }>;
      const moved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${second!.id}/move`, headers, payload: { direction: 'earlier' } });
      const edited = await queuedApp.inject({ method: 'PUT', url: `/api/agents/agent-1/queued-prompts/${second!.id}`, headers, payload: { prompt: 'Edited second prompt' } });
      const cancelled = await queuedApp.inject({ method: 'DELETE', url: `/api/agents/agent-1/queued-prompts/${first!.id}`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.statusCode).toBe(200);
      expect([first?.text, second?.text]).toEqual(['First prompt', 'Second prompt']);
      expect(moved.json().prompts.map((prompt: { id: string }) => prompt.id)).toEqual([second!.id, first!.id]);
      expect(edited.json()).toMatchObject({ id: second!.id, text: 'Edited second prompt' });
      expect(cancelled.statusCode).toBe(204);
      expect(remaining.json().prompts).toMatchObject([{ id: second!.id, text: 'Edited second prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('saves a queued prompt as a note, consuming the queued copy and retaining its attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Renamed Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const dashboardUpdates = { setLoader: () => {}, refresh: async () => { throw new Error('refresh unavailable'); }, close: () => {} };
    const queuedApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 12).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [worktree] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      notes: new WorktreeNoteService(join(directory, 'notes.json')),
      // keep the durable save successful when publication fails
      dashboardUpdates: dashboardUpdates as never
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Save this prompt', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const worktreeNotes = await queuedApp.inject({ method: 'GET', url: '/api/worktrees/cora/notes', headers: { host: headers.host, cookie: headers.cookie } });
      const attachmentPayload = await queuedApp.inject({ method: 'GET', url: `/api/worktrees/cora/notes/${saved.json().id}/attachments`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ title: expect.stringMatching(/^Queued prompt in Renamed Cora · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u), text: 'Save this prompt', source: 'queued-prompt', attachments: [{ name: 'context.txt', size: 7 }] });
      expect(JSON.stringify(saved.json())).not.toContain('Y29udGV4dA==');
      expect(remaining.json()).toEqual({ prompts: [] });
      expect(worktreeNotes.json().notes).toMatchObject([{ title: expect.stringMatching(/^Queued prompt in Renamed Cora · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u), text: 'Save this prompt', source: 'queued-prompt', attachments: [{ name: 'context.txt', size: 7 }] }]);
      expect(attachmentPayload.json()).toEqual({ attachments: [{ name: 'context.txt', data: 'Y29udGV4dA==' }] });
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // publish the note revision without waiting for dashboard polling
  it('publishes a dashboard update after explicitly saving a queued prompt as a note', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-queued-prompt-update-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'cora', label: 'Renamed Cora', path: '/worktrees/cora', identity: '/worktrees/cora' });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: worktree.path, worktreeId: worktree.id, projectId: worktree.projectId, title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
    const dashboardProject = {
      id: 'cora', label: 'Cora', mode: 'repository' as const, available: true, manageWorktrees: true, stalePaths: [],
      worktrees: [{ id: worktree.id, projectId: worktree.projectId, label: worktree.label, path: worktree.path, available: true, pinned: true, main: true, detached: false, locked: false, order: 0 }]
    };
    const queuedApp = await buildApp({ ...config, projects: [testProject({ id: 'cora', label: 'Cora', path: worktree.path, identity: worktree.identity })] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 35).toString('base64url')),
      discovery: {
        target: async (id: string) => id === agent.id ? { agent, socket } : undefined,
        worktreesNow: () => [worktree],
        // expose the same agent and worktree represented by the save route
        dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [dashboardProject] })
      } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      notes: new WorktreeNoteService(join(directory, 'notes.json')),
      dashboardUpdates
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Publish this note' } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;
      const revisions: Array<number | undefined> = [];
      // record dashboard publications directly
      dashboardUpdates.subscribe(snapshot => { revisions.push(snapshot.notesRevision); });
      await dashboardUpdates.refresh();

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });

      expect(saved.statusCode).toBe(201);
      // allow the best-effort refresh to publish asynchronously
      await vi.waitFor(() => { expect(revisions).toEqual([0, 1]); });
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('leaves a queued prompt in place and returns an error when the note store fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-queued-prompt-fail-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 14).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [worktree] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      // the notes store refuses every write
      notes: { createWithText: async () => undefined } as never
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Keep this prompt' } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(saved.statusCode).toBe(409);
      expect(remaining.json().prompts).toMatchObject([{ id: queued!.id, text: 'Keep this prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('drains a halted queue into queued prompt notes when active work fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-drain-queue-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // a realistic `<projectId>:<realpath>` wire id, so the drain's projectId collapse is exercised
    const worktree = { id: 'cora:/worktrees/cora', projectId: 'cora', label: 'Release Lane', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let capture = ['› Earlier prompt', '', '• Earlier answer', '', '─ Worked for 1s', '', '› Active prompt', '', '• Working'].join('\n');
    const drainApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 15).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) } as never,
      tmux: { pastePrompt: async () => true, capture: async () => capture, sendKeys: async () => true } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      const boot = await drainApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await drainApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      // both prompts queue behind the working agent
      await drainApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'First undelivered', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      await drainApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Second undelivered' } });

      // the active turn fails: observing the pane halts the queue and drains it into Notes
      capture = ['› Active prompt', '', '■ Request failed', ''].join('\n');
      agent.title = 'Ready';
      const dashboard = await drainApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });

      const remaining = await drainApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      // read back through the same worktree wire id the fly-out uses: both the drain key and the read
      // key must collapse `<projectId>:<realpath>` to the Project id, or the notes would be invisible
      const worktreeNotes = await drainApp.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent('cora:/worktrees/cora')}/notes`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(remaining.json()).toEqual({ prompts: [] });
      const drained = worktreeNotes.json().notes as Array<{ title: string; text: string; source?: string; attachments?: Array<{ name: string; size: number }> }>;
      // one note per prompt, drained front-of-queue first (so the notes list, newest first, reverses them)
      expect(drained.map(note => note.text)).toEqual(['Second undelivered', 'First undelivered']);
      expect(drained[1]?.attachments).toEqual([{ name: 'context.txt', size: 7 }]);
      expect(drained.every(note => /^Queued prompt in Release Lane · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u.test(note.title))).toBe(true);
      expect(drained.every(note => note.source === 'queued-prompt')).toBe(true);
      expect(dashboard.json().notesRevision).toBe(2);
    } finally {
      await drainApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('saves a scratch agent queued prompt as a note under its scratch note key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-scratch-note-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // no configured worktree: the queue keys as agent:<id> while notes key by the hashed Scratch dir
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/me/scratch', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 16).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [] } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Scratch prompt' } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      // the agent notes route resolves the same scratch key, so the saved note is round-tripped through it
      const agentNotes = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ title: expect.stringMatching(/^Queued prompt in scratch · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u), text: 'Scratch prompt', source: 'queued-prompt' });
      expect(remaining.json()).toEqual({ prompts: [] });
      expect(agentNotes.json().notes).toMatchObject([{ title: expect.stringMatching(/^Queued prompt in scratch · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u), text: 'Scratch prompt', source: 'queued-prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('drains a scratch agent halted queue into a note under its scratch note key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-drain-scratch-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // no configured worktree: the queue keys as agent:<id> and the drain must resolve the scratch key
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/me/scratch', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let capture = ['› Active prompt', '', '• Working'].join('\n');
    const drainApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 17).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) } as never,
      tmux: { pastePrompt: async () => true, capture: async () => capture, sendKeys: async () => true } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      const boot = await drainApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await drainApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await drainApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Scratch undelivered' } });

      capture = ['› Active prompt', '', '■ Request failed', ''].join('\n');
      agent.title = 'Ready';
      await drainApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });

      const remaining = await drainApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const agentNotes = await drainApp.inject({ method: 'GET', url: '/api/agents/agent-1/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(remaining.json()).toEqual({ prompts: [] });
      expect(agentNotes.json().notes).toMatchObject([{ title: expect.stringMatching(/^Queued prompt in scratch · (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)$/u), text: 'Scratch undelivered', source: 'queued-prompt' }]);
    } finally {
      await drainApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('prompt history API', () => {
  it('records and lists history by configured worktree when the agent pane changes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agents = [
      stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready' }),
      stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', home: '/worktrees/cora', title: 'Ready' })
    ];
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const stored: Array<{ id: string; text: string; createdAt: string }> = [];
    const keys: string[] = [];
    const promptHistory = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      record: async (key: string, text: string) => {
        keys.push(`record:${key}`);
        const entry = { id: 'prompt-history-001', text, createdAt: '2026-08-04T01:00:00.000Z' };
        stored.unshift(entry);
        return entry;
      }
    };
    const historyApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; }, worktreesNow: () => [worktree] } as never,
      tmux: { pastePrompt: async () => true, sendKeys: async () => true } as never,
      promptHistory: promptHistory as never
    });
    try {
      const boot = await historyApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await historyApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const queued = await historyApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Review this branch.' } });
      const listed = await historyApp.inject({ method: 'GET', url: '/api/agents/agent-2/prompt-history', headers: { host: headers.host, cookie: headers.cookie } });

      expect(queued.statusCode).toBe(204);
      expect(listed.json()).toEqual({ prompts: stored });
      expect(keys).toEqual(['record:cora', 'list:cora']);
    } finally {
      await historyApp.close();
    }
  }, 15_000);
});

describe('worktree notes API', () => {
  it('lists, creates, updates, and deletes notes for the configured worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const stored: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-001', text: 'Existing note' }];
    const keys: string[] = [];
    const notes = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      create: async (key: string, title?: string) => { keys.push(`create:${key}:${title ?? ''}`); const note = { id: 'note-identifier-002', text: '', ...(title === undefined ? {} : { title }) }; stored.unshift(note); return note; },
      update: async (key: string, noteId: string, text: string) => { keys.push(`update:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.text = text; return { ...note }; },
      rename: async (key: string, noteId: string, title: string) => { keys.push(`rename:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.title = title; return { ...note }; },
      resolve: async (key: string, noteId: string) => { const note = stored.find(candidate => candidate.id === noteId); return note === undefined ? undefined : { key, note }; },
      deleteWithUndo: async (key: string, noteId: string) => { keys.push(`delete:${key}:${noteId}`); const index = stored.findIndex(candidate => candidate.id === noteId); return index < 0 ? undefined : { note: stored.splice(index, 1)[0], undoToken: 'worktree-delete-token' }; },
      undoDeletion: async (token: string) => { keys.push(`undo:${token}`); const note = { id: 'note-identifier-001', text: 'Existing note' }; stored.push(note); return note; }
    };
    const discovery = { worktreesNow: () => [worktree], place: async () => undefined, dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    const notesApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')), discovery: discovery as never, notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await notesApp.inject({ method: 'GET', url: '/api/worktrees/cora/notes', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { title: 'Assistant response' } });
      const updated = await notesApp.inject({ method: 'PUT', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { text: 'Autosaved note' } });
      const renamed = await notesApp.inject({ method: 'PATCH', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { title: 'Release checklist' } });
      // accept the explicit json bodies forwarded by chunked browser transports
      const jsonHeaders = { ...headers, 'content-type': 'application/json', 'transfer-encoding': 'chunked' };
      const deleted = await notesApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/notes/note-identifier-001', headers: jsonHeaders, payload: '{}' });
      const restored = await notesApp.inject({ method: 'POST', url: '/api/notes/deletions/worktree-delete-token/undo', headers: jsonHeaders, payload: '{}' });
      const missing = await notesApp.inject({ method: 'GET', url: '/api/worktrees/missing/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({ notes: [{ id: 'note-identifier-001', text: 'Existing note' }] });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'note-identifier-002', text: '', title: 'Assistant response' });
      expect(updated.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Assistant response' });
      expect(renamed.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Release checklist' });
      expect(deleted.json()).toEqual({ id: 'note-identifier-001', text: 'Existing note', undoToken: 'worktree-delete-token' });
      expect(restored.json()).toEqual({ id: 'note-identifier-001', text: 'Existing note' });
      expect(missing.statusCode).toBe(404);
      expect(keys).toEqual(['list:potato', 'create:potato:Assistant response', 'update:potato:note-identifier-002', 'rename:potato:note-identifier-002', 'delete:potato:note-identifier-001', 'undo:worktree-delete-token']);
    } finally { await notesApp.close(); }
  }, 15_000);

  it('keeps scratch notes available through the live agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu', title: 'Scratch' });
    const stored: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-001', text: 'Scratch note' }];
    const keys: string[] = [];
    const notes = {
      list: async (key: string) => { keys.push(key); return [...stored]; },
      create: async (key: string, title?: string) => { keys.push(key); const note = { id: 'note-identifier-002', text: '', ...(title === undefined ? {} : { title }) }; stored.unshift(note); return note; },
      update: async (key: string, noteId: string, text: string) => {
        keys.push(key);
        const note = stored.find(candidate => candidate.id === noteId);
        // require one fixture note
        if (note === undefined) return undefined;
        note.text = text;
        return { ...note };
      },
      rename: async (key: string, noteId: string, title: string) => {
        keys.push(key);
        const note = stored.find(candidate => candidate.id === noteId);
        // require one fixture note
        if (note === undefined) return undefined;
        note.title = title;
        return { ...note };
      },
      resolve: async (key: string, noteId: string) => { const note = stored.find(candidate => candidate.id === noteId); return note === undefined ? undefined : { key, note }; },
      deleteWithUndo: async (key: string, noteId: string) => { keys.push(key); const index = stored.findIndex(candidate => candidate.id === noteId); return index < 0 ? undefined : { note: stored.splice(index, 1)[0], undoToken: 'scratch-delete-token' }; }
    };
    const discovery = { worktreesNow: () => [worktree],
      // resolve the live scratch agent
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] })
    };
    const notesApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 26).toString('base64url')), discovery: discovery as never, notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const base = `/api/agents/${agent.id}/notes`;

      const listed = await notesApp.inject({ method: 'GET', url: base, headers: { host: headers.host, cookie: headers.cookie } });
      const created = await notesApp.inject({ method: 'POST', url: base, headers, payload: { title: 'Scratch checklist' } });
      const updated = await notesApp.inject({ method: 'PUT', url: `${base}/note-identifier-002`, headers, payload: { text: 'Keep this in scratch' } });
      const renamed = await notesApp.inject({ method: 'PATCH', url: `${base}/note-identifier-002`, headers, payload: { title: 'Scratch plan' } });
      const deleted = await notesApp.inject({ method: 'DELETE', url: `${base}/note-identifier-001`, headers });
      const missing = await notesApp.inject({ method: 'GET', url: '/api/agents/missing/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({ notes: [{ id: 'note-identifier-001', text: 'Scratch note' }] });
      expect(created.statusCode).toBe(201);
      expect(updated.json()).toEqual({ id: 'note-identifier-002', text: 'Keep this in scratch', title: 'Scratch checklist' });
      expect(renamed.json()).toEqual({ id: 'note-identifier-002', text: 'Keep this in scratch', title: 'Scratch plan' });
      expect(deleted.json()).toEqual({ id: 'note-identifier-001', text: 'Scratch note', undoToken: 'scratch-delete-token' });
      expect(missing.statusCode).toBe(404);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/^scratch_[A-Za-z0-9_-]{40}$/u);
    } finally { await notesApp.close(); }
  }, 15_000);

  it('creates a note with initial text in one request (the composer Ctrl+S save), atomically via createWithText', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const calls: string[] = [];
    const notes = {
      // a blank create must never be reached when the request carries text
      create: async () => { calls.push('create'); return { id: 'note-identifier-blank', text: '' }; },
      createWithText: async (key: string, title: string, text: string) => { calls.push(`createWithText:${key}:${title}`); return { id: 'note-identifier-777', title, text }; }
    };
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    const notesApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 11).toString('base64url')), discovery: discovery as never, notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const created = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { title: 'Draft this idea', text: 'Draft this idea into a note.' } });
      // an initial text without a title is refused before touching the store
      const untitled = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { text: 'No title here' } });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'note-identifier-777', title: 'Draft this idea', text: 'Draft this idea into a note.' });
      expect(untitled.statusCode).toBe(400);
      // the text path routes through the atomic createWithText, never the blank create
      expect(calls).toEqual(['createWithText:potato:Draft this idea']);
    } finally { await notesApp.close(); }
  }, 15_000);

  // expose summaries on note responses while dedicated endpoints retain full bytes
  it('creates and manages note attachments across worktree and agent scopes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachment-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: worktree.path, title: 'Ready' });
    const discovery = {
      worktreesNow: () => [worktree],
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] })
    };
    const notesApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 41).toString('base64url')),
      discovery: discovery as never,
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    const longName = `${'設計'.repeat(70)}.txt`;
    const attachments = [
      { name: 'dot.txt', data: Buffer.from('dots').toString('base64') },
      { name: longName, data: Buffer.from('long').toString('base64') }
    ];
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const readHeaders = { host: headers.host, cookie: headers.cookie };

      const created = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { title: 'Files only', text: '', attachments } });
      const noteId = created.json().id as string;
      const full = await notesApp.inject({ method: 'GET', url: `/api/agents/${agent.id}/notes/${noteId}/attachments`, headers: readHeaders });
      const autosaved = await notesApp.inject({ method: 'PUT', url: `/api/agents/${agent.id}/notes/${noteId}`, headers, payload: { text: 'Review the files' } });
      const noCsrf = await notesApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/notes/${noteId}/attachments`, headers: readHeaders, payload: { attachments: [{ name: 'x.txt', data: 'eA==' }] } });
      const malformed = await notesApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/notes/${noteId}/attachments`, headers, payload: { attachments: [{ name: 'bad.txt', data: 'not base64' }] } });
      const dotName = await notesApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/notes/${noteId}/attachments`, headers, payload: { attachments: [{ name: '..', data: 'eA==' }] } });
      const appended = await notesApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/notes/${noteId}/attachments`, headers, payload: { attachments: [{ name: ' extra.txt ', data: 'eA==' }] } });
      const removedDots = await notesApp.inject({ method: 'DELETE', url: `/api/worktrees/cora/notes/${noteId}/attachments?name=${encodeURIComponent('dot.txt')}`, headers });
      const removedLong = await notesApp.inject({ method: 'DELETE', url: `/api/agents/${agent.id}/notes/${noteId}/attachments?name=${encodeURIComponent(longName)}`, headers });
      const renamed = await notesApp.inject({ method: 'PATCH', url: `/api/worktrees/cora/notes/${noteId}`, headers, payload: { title: 'Renamed files' } });
      const deleted = await notesApp.inject({ method: 'DELETE', url: `/api/worktrees/cora/notes/${noteId}`, headers });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ text: '', attachments: [{ name: 'dot.txt', size: 4 }, { name: longName, size: 4 }] });
      expect(JSON.stringify(created.json())).not.toContain(attachments[0]!.data);
      expect(full.json()).toEqual({ attachments });
      expect(autosaved.json()).toMatchObject({ text: 'Review the files', attachments: [{ name: 'dot.txt', size: 4 }, { name: longName, size: 4 }] });
      expect(noCsrf.statusCode).toBe(403);
      expect(malformed.statusCode).toBe(400);
      expect(dotName.statusCode).toBe(400);
      expect(appended.json()).toMatchObject({ attachments: [{ name: 'dot.txt', size: 4 }, { name: longName, size: 4 }, { name: 'extra.txt', size: 1 }] });
      expect(removedDots.json().attachments).toEqual([{ name: longName, size: 4 }, { name: 'extra.txt', size: 1 }]);
      expect(removedLong.json().attachments).toEqual([{ name: 'extra.txt', size: 1 }]);
      expect(renamed.json()).toMatchObject({ title: 'Renamed files', attachments: [{ name: 'extra.txt', size: 1 }] });
      expect(deleted.json()).toMatchObject({ title: 'Renamed files', attachments: [{ name: 'extra.txt', size: 1 }] });
      expect(JSON.stringify(deleted.json())).not.toContain('eA==');
    } finally {
      await notesApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // persist attachment bytes under a scratch agent's hashed note scope
  it('manages attachments for scratch-agent notes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scratch-note-attachments-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu/scratch', title: 'Scratch' });
    const discovery = {
      worktreesNow: () => [],
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] })
    };
    const notesApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 42).toString('base64url')),
      discovery: discovery as never,
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const base = `/api/agents/${agent.id}/notes`;
      const attachment = { name: 'scratch.txt', data: Buffer.from('scratch').toString('base64') };

      const created = await notesApp.inject({ method: 'POST', url: base, headers, payload: { title: 'Scratch files', attachments: [attachment] } });
      const noteId = created.json().id as string;
      const full = await notesApp.inject({ method: 'GET', url: `${base}/${noteId}/attachments`, headers: { host: headers.host, cookie: headers.cookie } });
      const removed = await notesApp.inject({ method: 'DELETE', url: `${base}/${noteId}/attachments?name=scratch.txt`, headers });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ text: '', attachments: [{ name: 'scratch.txt', size: 7 }] });
      expect(full.json()).toEqual({ attachments: [attachment] });
      expect(removed.json()).not.toHaveProperty('attachments');
    } finally {
      await notesApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // preview only bytes stored on the requested note scope
  it('previews note attachment text, raster images and binary fallbacks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachment-preview-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = { id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true };
    const owen = { id: 'owen', projectId: 'other', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', available: true };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: cora.path, title: 'Ready' });
    const otherAgent = stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu/other', title: 'Ready' });
    const discovery = {
      worktreesNow: () => [cora, owen],
      target: async (id: string) => id === agent.id
        ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } }
        : id === otherAgent.id ? { agent: otherAgent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent, otherAgent], projects: [] })
    };
    const notes = new WorktreeNoteService(join(directory, 'notes.json'));
    const longName = `${'設計'.repeat(70)}.txt`;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const largeText = 'x'.repeat(256 * 1_024 + 17);
    const note = await notes.createWithText('potato', 'Previews', '', undefined, [
      { name: longName, data: Buffer.from('hello').toString('base64') },
      { name: 'image.png', data: png.toString('base64') },
      { name: 'binary.dat', data: Buffer.from([0xff, 0x00, 0x01]).toString('base64') },
      { name: 'large.txt', data: Buffer.from(largeText).toString('base64') }
    ]);
    const notesApp = await buildApp({ ...config }, {
      auth: new AuthService(hash, Buffer.alloc(32, 43).toString('base64url')),
      discovery: discovery as never,
      notes
    });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const readHeaders = { host: headers.host, cookie: headers.cookie };
      const worktreeBase = `/api/worktrees/cora/notes/${note!.id}/attachments/preview`;
      const agentBase = `/api/agents/${agent.id}/notes/${note!.id}/attachments/preview`;

      const text = await notesApp.inject({ method: 'POST', url: worktreeBase, headers, payload: { path: longName } });
      const image = await notesApp.inject({ method: 'POST', url: agentBase, headers, payload: { path: 'image.png' } });
      const binary = await notesApp.inject({ method: 'POST', url: worktreeBase, headers, payload: { path: 'binary.dat' } });
      const truncated = await notesApp.inject({ method: 'POST', url: worktreeBase, headers, payload: { path: 'large.txt' } });
      const missing = await notesApp.inject({ method: 'POST', url: worktreeBase, headers, payload: { path: 'missing.txt' } });
      const invalid = await notesApp.inject({ method: 'POST', url: worktreeBase, headers, payload: { path: '..' } });
      const unauthorized = await notesApp.inject({ method: 'POST', url: worktreeBase, headers: { host: headers.host }, payload: { path: longName } });
      const noCsrf = await notesApp.inject({ method: 'POST', url: worktreeBase, headers: readHeaders, payload: { path: longName } });
      const wrongWorktree = await notesApp.inject({ method: 'POST', url: `/api/worktrees/owen/notes/${note!.id}/attachments/preview`, headers, payload: { path: longName } });
      const wrongAgent = await notesApp.inject({ method: 'POST', url: `/api/agents/${otherAgent.id}/notes/${note!.id}/attachments/preview`, headers, payload: { path: longName } });

      expect(text.json()).toEqual({ path: longName, size: 5, binary: false, truncated: false, content: 'hello' });
      expect(image.json()).toEqual({ path: 'image.png', size: png.length, binary: true, truncated: false, image: { mediaType: 'image/png', base64: png.toString('base64') } });
      expect(binary.json()).toEqual({ path: 'binary.dat', size: 3, binary: true, truncated: false });
      expect(truncated.json()).toMatchObject({ path: 'large.txt', size: largeText.length, binary: false, truncated: true, content: 'x'.repeat(256 * 1_024) });
      expect(missing.statusCode).toBe(404);
      expect(invalid.statusCode).toBe(400);
      expect(unauthorized.statusCode).toBe(403);
      expect(noCsrf.statusCode).toBe(403);
      expect(wrongWorktree.statusCode).toBe(404);
      expect(wrongAgent.statusCode).toBe(404);
    } finally {
      await notesApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('workspace files API', () => {
  it('lists response files and previews active or inactive workspace files', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/ubuntu/cora', title: 'Ready' });
    const discovery = {
      worktreesNow: () => [worktree],
      place: async () => undefined,
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      // bind temporary artifacts to the selected pane
      paneProcessId: (id: string) => id === agent.id ? 1234 : undefined
    };
    const workspaceFiles = {
      list: async (workspace: string, message: string) => workspace === '/worktrees/cora' && message === 'Changed `src/main.ts`.' ? [{ path: 'src/main.ts', size: 12 }] : [],
      preview: async (workspace: string, path: string) => workspace === '/worktrees/cora' && path === 'src/main.ts' ? { path, size: 12, binary: false, truncated: false, content: 'const ok=1;\n' } : undefined,
      // return only one synthetic host temporary image
      previewTemporaryImage: async (path: string, panePid?: number) => path === '/tmp/screenshot.png' && panePid === 1234 ? { path, size: 8, binary: true, truncated: false, image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' } } : undefined
    };
    const filesApp = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 15).toString('base64url')), discovery: discovery as never, workspaceFiles: workspaceFiles as never });
    try {
      const boot = await filesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await filesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const listed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/message-files', headers, payload: { message: 'Changed `src/main.ts`.' } });
      const previewed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: 'src/main.ts' } });
      const temporaryImage = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: '/tmp/screenshot.png' } });
      const worktreePreviewed = await filesApp.inject({ method: 'POST', url: '/api/worktrees/cora/file-preview', headers, payload: { path: 'src/main.ts' } });
      const invalid = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: '' } });
      const missingWorktree = await filesApp.inject({ method: 'POST', url: '/api/worktrees/missing/file-preview', headers, payload: { path: 'src/main.ts' } });

      expect(listed.json()).toEqual({ files: [{ path: 'src/main.ts', size: 12 }] });
      expect(previewed.json()).toEqual({ path: 'src/main.ts', size: 12, binary: false, truncated: false, content: 'const ok=1;\n' });
      expect(temporaryImage.json()).toEqual({ path: '/tmp/screenshot.png', size: 8, binary: true, truncated: false, image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' } });
      expect(worktreePreviewed.json()).toEqual(previewed.json());
      expect(invalid.statusCode).toBe(400);
      expect(missingWorktree.statusCode).toBe(404);
    } finally { await filesApp.close(); }
  }, 15_000);
});

describe('comparison API', () => {
  const worktree = { id: 'cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, main: true, detached: false, locked: false, branch: 'feature' };
  const discovery = { worktreesNow: () => [worktree], place: async () => undefined };
  // a comparison service faked to the route seam: Working resolves with a capped file, All PR has no base
  const comparison = {
    patch: async (_worktree: unknown, kind: 'working' | 'pr' | { commit: string }) => typeof kind === 'object'
      ? { ok: true, kind: 'commit', patch: { base: `${kind.commit.slice(0, 7)}^`, gitBase: 'parent', truncated: false, fingerprint: 'fp-commit', files: [] } }
      : kind === 'working'
      ? { ok: true, kind, patch: { base: 'HEAD', gitBase: 'abc123', truncated: false, fingerprint: 'fp-passed-through', files: [
          { change: { code: ' M', path: 'src/a.ts' }, kind: 'tracked', patch: '@@ -1 +1 @@\n', capped: false },
          { change: { code: ' M', path: 'big.bin' }, kind: 'tracked', patch: '', capped: true }
        ] } }
      : { ok: false, reason: 'no_base' },
    file: async (_worktree: unknown, _kind: unknown, path: string) => path === 'src/a.ts'
      ? { ok: true, path, base: { path, size: 3, binary: false, truncated: false, content: 'old' }, working: { path, size: 3, binary: false, truncated: false, content: 'new' } }
      : path === 'added.ts'
        ? { ok: true, path, working: { path, size: 4, binary: false, truncated: false, content: 'new\n' } }
        : path === 'unresolved.ts'
          ? { ok: false, reason: 'no_base' }
          : { ok: false, reason: 'not_in_comparison' },
    commits: async () => ({ base: 'origin/main', truncated: false, commits: [{ sha: 'a'.repeat(40), subject: 'Add', body: '', author: 'A', authoredAt: '2026-10-06T12:00:00-07:00', merge: false, pushed: true, changes: [{ code: 'A ', path: 'a.ts' }] }] })
  };

  async function comparisonApp() {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const app = await buildApp({ ...config }, { auth: new AuthService(hash, Buffer.alloc(32, 17).toString('base64url')), discovery: discovery as never, comparison: comparison as never });
    const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
    const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    return { app, headers };
  }

  it('serves a Comparison patch with its fingerprint and per-file cap markers', async () => {
    const { app, headers } = await comparisonApp();
    try {
      const patched = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers, payload: { kind: 'working' } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ kind: 'working', base: 'HEAD', gitBase: 'abc123', truncated: false, fingerprint: 'fp-passed-through', files: [
        { change: { code: ' M', path: 'src/a.ts' }, kind: 'tracked', patch: '@@ -1 +1 @@\n', capped: false },
        { change: { code: ' M', path: 'big.bin' }, kind: 'tracked', patch: '', capped: true }
      ] });
    } finally { await app.close(); }
  }, 15_000);

  it('validates the kind, requires the worktree, and surfaces an unresolvable base', async () => {
    const { app, headers } = await comparisonApp();
    try {
      const invalidKind = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers, payload: { kind: 'staged' } });
      const unnamedCommit = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers, payload: { kind: 'commit' } });
      const commit = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers, payload: { kind: 'commit', commit: 'b'.repeat(40) } });
      const missingWorktree = await app.inject({ method: 'POST', url: '/api/worktrees/missing/comparison', headers, payload: { kind: 'working' } });
      const noBase = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers, payload: { kind: 'pr' } });
      const unauthenticated = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison', headers: { host: 'agents.example.com', origin: 'https://agents.example.com' }, payload: { kind: 'working' } });
      expect(invalidKind.statusCode).toBe(400);
      expect(unnamedCommit.statusCode).toBe(400);
      expect(commit.json()).toMatchObject({ kind: 'commit', base: 'bbbbbbb^', fingerprint: 'fp-commit' });
      expect(missingWorktree.statusCode).toBe(404);
      expect(noBase.statusCode).toBe(404);
      expect(unauthenticated.statusCode).toBe(401);
    } finally { await app.close(); }
  }, 15_000);

  it('serves the commit log of a worktree and requires the worktree', async () => {
    const { app, headers } = await comparisonApp();
    try {
      const log = await app.inject({ method: 'GET', url: '/api/worktrees/cora/commits', headers });
      const missingWorktree = await app.inject({ method: 'GET', url: '/api/worktrees/missing/commits', headers });
      const unauthenticated = await app.inject({ method: 'GET', url: '/api/worktrees/cora/commits', headers: { host: 'agents.example.com', origin: 'https://agents.example.com' } });
      expect(log.statusCode).toBe(200);
      expect(log.json()).toMatchObject({ base: 'origin/main', truncated: false, commits: [{ subject: 'Add', pushed: true, changes: [{ code: 'A ', path: 'a.ts' }] }] });
      expect(missingWorktree.statusCode).toBe(404);
      expect(unauthenticated.statusCode).toBe(401);
    } finally { await app.close(); }
  }, 15_000);

  it('serves a changed file at the base and working tree, nulling an absent side', async () => {
    const { app, headers } = await comparisonApp();
    try {
      const modified = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'working', path: 'src/a.ts' } });
      const added = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'pr', path: 'added.ts' } });
      const outside = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'working', path: 'src/other.ts' } });
      const unresolved = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'pr', path: 'unresolved.ts' } });
      const invalidPath = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'working', path: '' } });
      const invalidKind = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers, payload: { kind: 'staged', path: 'src/a.ts' } });
      const unauthenticated = await app.inject({ method: 'POST', url: '/api/worktrees/cora/comparison/file', headers: { host: 'agents.example.com', origin: 'https://agents.example.com' }, payload: { kind: 'working', path: 'src/a.ts' } });
      expect(modified.json()).toEqual({ path: 'src/a.ts', base: { path: 'src/a.ts', size: 3, binary: false, truncated: false, content: 'old' }, working: { path: 'src/a.ts', size: 3, binary: false, truncated: false, content: 'new' } });
      expect(added.json()).toEqual({ path: 'added.ts', base: null, working: { path: 'added.ts', size: 4, binary: false, truncated: false, content: 'new\n' } });
      // a path outside the Comparison and an unresolvable Comparison are both 404, but with distinct reasons
      expect(outside.statusCode).toBe(404);
      expect(outside.json()).toEqual({ error: 'file unavailable' });
      expect(unresolved.statusCode).toBe(404);
      expect(unresolved.json()).toEqual({ error: 'comparison unavailable' });
      expect(invalidPath.statusCode).toBe(400);
      expect(invalidKind.statusCode).toBe(400);
      expect(unauthenticated.statusCode).toBe(401);
    } finally { await app.close(); }
  }, 15_000);
});
