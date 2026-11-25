import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AgentUpdateService, type AgentUpdateJob, type AgentUpdateServiceLike } from '../src/agent-updates/service.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

// allow durable writes and lock handshakes to finish on slower filesystems
const waitForJob = <T>(callback: () => T | Promise<T>) => vi.waitFor(callback, { timeout: 10_000 });

describe('agent update API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let checkout: string | undefined;
  // close each isolated HTTP server and owned job directory
  afterEach(async () => {
    await app?.close();
    // remove only the fixture created for a real service instance
    if (checkout !== undefined) { await rm(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); checkout = undefined; }
  });

  it('publishes versions and executes authenticated configured updates', async () => {
    const available = { kind: 'codex' as const, currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true };
    const current = { kind: 'codex' as const, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false };
    const statuses = vi.fn(async () => [available]);
    const update = vi.fn(async () => ({ outcome: 'updated' as const, status: current }));
    const startUpdate = vi.fn<AgentUpdateServiceLike['startUpdate']>(() => ({ outcome: 'unavailable' }));
    const updateStatus = vi.fn<AgentUpdateServiceLike['updateStatus']>(() => undefined);
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses, update, startUpdate, updateStatus } satisfies AgentUpdateServiceLike });
    const denied = await app.inject({ method: 'GET', url: '/api/agents/updates', headers: { host: testHost } });
    const headers = await authenticatedHeaders(app);
    const listed = await app.inject({ method: 'GET', url: '/api/agents/updates', headers: { host: headers.host, cookie: headers.cookie } });
    const refreshed = await app.inject({ method: 'GET', url: '/api/agents/updates?refresh=true', headers: { host: headers.host, cookie: headers.cookie } });
    const updated = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    expect(denied.statusCode).toBe(401);
    expect(listed.json()).toEqual({ agents: [available] });
    expect(refreshed.json()).toEqual({ agents: [available] });
    expect(statuses.mock.calls).toEqual([[false], [true]]);
    expect(updated.json()).toEqual({ agent: current });
    expect(update).toHaveBeenCalledWith('codex');
  }, 15_000);

  it('maps unavailable, busy, and failed updates', async () => {
    const update: AgentUpdateServiceLike['update'] = vi.fn(async kind => {
      // exercise every public service refusal
      if (kind === 'codex') return { outcome: 'busy' };
      if (kind === 'claude') return { outcome: 'failed' };
      return { outcome: 'unavailable' };
    });
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update, startUpdate: () => ({ outcome: 'unavailable' }), updateStatus: () => undefined } });
    const headers = await authenticatedHeaders(app);
    const busy = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    const failed = await app.inject({ method: 'POST', url: '/api/agents/claude/update', headers });
    const unavailable = await app.inject({ method: 'POST', url: '/api/agents/omx/update', headers });
    expect(busy.statusCode).toBe(409);
    expect(failed.statusCode).toBe(502);
    expect(unavailable.statusCode).toBe(404);
  }, 15_000);

  // expose the service-owned safe message rather than erasing useful diagnostics
  it('preserves a safe installer failure and diagnostic reference for synchronous clients', async () => {
    const error = 'OMX update failed with exit code 1. Private diagnostics: .data/agent-updates/omx-example.json.';
    const update = vi.fn<AgentUpdateServiceLike['update']>(async () => ({ outcome: 'failed', error }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update, startUpdate: () => ({ outcome: 'unavailable' }), updateStatus: () => undefined } });
    const headers = await authenticatedHeaders(app);
    const failed = await app.inject({ method: 'POST', url: '/api/agents/omx/update', headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error });
  }, 15_000);

  // retain verified versions when a synchronous installer fails after mutation
  it('returns observed agent evidence with a synchronous installer failure', async () => {
    const agent = { kind: 'codex' as const, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false };
    const error = 'Codex is now at 0.153.2, but the installer did not complete successfully. Private diagnostics: .data/agent-updates/codex-example.json.';
    const update = vi.fn<AgentUpdateServiceLike['update']>(async () => ({ outcome: 'failed', error, status: agent }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update, startUpdate: () => ({ outcome: 'unavailable' }), updateStatus: () => undefined } });
    const headers = await authenticatedHeaders(app);
    const failed = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error, agent });
  }, 15_000);

  it('rejects unknown agent kinds', async () => {
    const update: AgentUpdateServiceLike['update'] = vi.fn(async () => ({ outcome: 'unavailable' }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update, startUpdate: () => ({ outcome: 'unavailable' }), updateStatus: () => undefined } });
    const headers = await authenticatedHeaders(app);
    const unknown = await app.inject({ method: 'POST', url: '/api/agents/not-real/update', headers });
    expect(unknown.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  }, 15_000);

  // carry an explicit media type through chunked tunnel requests
  it('accepts JSON update starts with chunked proxy framing', async () => {
    const job: AgentUpdateJob = { id: 'chunked-update', kind: 'codex', state: 'running' };
    const startUpdate = vi.fn<AgentUpdateServiceLike['startUpdate']>(() => ({ outcome: 'started', job }));
    const update = vi.fn<AgentUpdateServiceLike['update']>(async () => ({ outcome: 'unavailable' }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update, startUpdate, updateStatus: () => undefined } });
    const framing: Array<{ transferEncoding?: string; contentLength?: string }> = [];
    // inspect the actual request framing before body parsing
    app.addHook('onRequest', async request => {
      // leave authentication traffic out of the update fixture
      if (request.url !== '/api/agents/codex/update') return;
      framing.push({ transferEncoding: request.headers['transfer-encoding'], contentLength: request.headers['content-length'] });
    });
    const headers = { ...await authenticatedHeaders(app), prefer: 'respond-async', 'transfer-encoding': 'chunked' };

    const bodyless = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    expect(bodyless.statusCode).toBe(415);
    expect(startUpdate).not.toHaveBeenCalled();

    // preserve chunked framing without a synthetic content-length header
    const started = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...headers, 'content-type': 'application/json' }, payload: Readable.from(['{}']) });
    expect(framing).toEqual([{ transferEncoding: 'chunked', contentLength: undefined }, { transferEncoding: 'chunked', contentLength: undefined }]);
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ update: job });
    expect(startUpdate).toHaveBeenCalledExactlyOnceWith('codex');
    expect(update).not.toHaveBeenCalled();
  }, 15_000);

  // prove the async route returns before its gated installer
  it('returns an asynchronous update before the installer completes and exposes its terminal state', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let current = '0.152.1';
    const runner = vi.fn(async (command: string) => {
      // hold the installer behind an explicit test gate
      if (command === 'update') { await gate; current = '0.153.2'; return { code: 0, output: 'installed' }; }
      return { code: 0, output: command === 'current' ? current : '0.153.2' };
    });
    const config = testConfig({ adapters: { codex: { program: '/bin/codex', args: [], env: {}, launchable: true, updates: { current: 'current', latest: 'latest', run: 'update' } } } });
    checkout = await mkdtemp(join(tmpdir(), 'rac-agent-update-api-'));
    const service = new AgentUpdateService(config, '/home/test', runner, checkout);
    app = await buildApp(config, { auth: await testAuthService(), agentUpdates: service });
    const headers = await authenticatedHeaders(app);
    const readHeaders = { host: headers.host, cookie: headers.cookie };

    const noCsrf = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...readHeaders, origin: headers.origin, prefer: 'respond-async' } });
    expect(noCsrf.statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...headers, prefer: 'wait=1, respond-async' } });
    expect(started.statusCode).toBe(202);
    const job = started.json<{ update: AgentUpdateJob }>().update;
    expect(job).toMatchObject({ kind: 'codex', state: 'running' });
    await waitForJob(() => expect(runner).toHaveBeenCalledWith('update', 15 * 60_000));

    const denied = await app.inject({ method: 'GET', url: `/api/agents/codex/update/${job.id}`, headers: { host: testHost } });
    const running = await app.inject({ method: 'GET', url: `/api/agents/codex/update/${job.id}`, headers: readHeaders });
    const unknown = await app.inject({ method: 'GET', url: '/api/agents/codex/update/unknown', headers: readHeaders });
    const wrongKind = await app.inject({ method: 'GET', url: `/api/agents/omx/update/${job.id}`, headers: readHeaders });
    expect(denied.statusCode).toBe(401);
    expect(running.json()).toEqual({ update: job });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Agent update status is unknown. Check the installed version before retrying.' });
    expect(wrongKind.statusCode).toBe(404);

    release();
    await waitForJob(async () => {
      const terminal = await app!.inject({ method: 'GET', url: `/api/agents/codex/update/${job.id}`, headers: readHeaders });
      expect(terminal.json()).toEqual({ update: { id: job.id, kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } });
    });
  }, 15_000);

  // preserve safe async start refusal codes
  it('maps asynchronous unavailable, busy, and failed starts', async () => {
    // select one refusal per configured test kind
    const startError = 'Agent update status is unavailable. Check the installed version before retrying.';
    const startUpdate: AgentUpdateServiceLike['startUpdate'] = vi.fn(kind => {
      // expose durable admission failure as a retryable service response
      if (kind === 'claude') return { outcome: 'failed', error: startError };
      // preserve one admitted installer
      if (kind === 'codex') return { outcome: 'busy' };
      return { outcome: 'unavailable' };
    });
    const agentUpdates: AgentUpdateServiceLike = { statuses: async () => [], update: async () => ({ outcome: 'unavailable' }), startUpdate, updateStatus: () => undefined };
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates });
    const headers = await authenticatedHeaders(app);
    const busy = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...headers, prefer: 'respond-async' } });
    const failed = await app.inject({ method: 'POST', url: '/api/agents/claude/update', headers: { ...headers, prefer: 'respond-async' } });
    const unavailable = await app.inject({ method: 'POST', url: '/api/agents/omx/update', headers: { ...headers, prefer: 'respond-async' } });
    expect(busy.statusCode).toBe(409);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: startError });
    expect(unavailable.statusCode).toBe(404);
  }, 15_000);

  // separate transient storage failures from durable terminal job failures
  it('maps polling failures and returns terminal agent evidence', async () => {
    const agent = { kind: 'codex' as const, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false };
    const error = 'Codex is now at 0.153.2, but setup failed. Private diagnostics: .data/agent-updates/codex-example.json.';
    const failedJob: AgentUpdateJob = { id: 'terminal-failed', kind: 'codex', state: 'failed', error, agent };
    const updateStatus = vi.fn<AgentUpdateServiceLike['updateStatus']>((_kind, id) => {
      // hide private storage details behind the stable polling error
      if (id === 'storage-error') throw new Error('/home/private/.data/agent-updates/job.json is unreadable');
      return id === failedJob.id ? failedJob : undefined;
    });
    const agentUpdates: AgentUpdateServiceLike = { statuses: async () => [], update: async () => ({ outcome: 'unavailable' }), startUpdate: () => ({ outcome: 'unavailable' }), updateStatus };
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates });
    const headers = await authenticatedHeaders(app);
    const readHeaders = { host: headers.host, cookie: headers.cookie };
    const unavailable = await app.inject({ method: 'GET', url: '/api/agents/codex/update/storage-error', headers: readHeaders });
    const terminal = await app.inject({ method: 'GET', url: `/api/agents/codex/update/${failedJob.id}`, headers: readHeaders });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'Agent update status is temporarily unavailable.' });
    expect(unavailable.body).not.toContain('/home/private');
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toEqual({ update: failedJob });
  }, 15_000);
});
