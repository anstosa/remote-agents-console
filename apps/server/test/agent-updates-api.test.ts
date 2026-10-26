import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AgentUpdateService, type AgentUpdateJob, type AgentUpdateServiceLike } from '../src/agent-updates/service.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

describe('agent update API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // close each isolated HTTP server
  afterEach(async () => { await app?.close(); });

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
    const updated = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    expect(denied.statusCode).toBe(401);
    expect(listed.json()).toEqual({ agents: [available] });
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
    const service = new AgentUpdateService(config, '/home/test', runner);
    app = await buildApp(config, { auth: await testAuthService(), agentUpdates: service });
    const headers = await authenticatedHeaders(app);
    const readHeaders = { host: headers.host, cookie: headers.cookie };

    const noCsrf = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...readHeaders, origin: headers.origin, prefer: 'respond-async' } });
    expect(noCsrf.statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...headers, prefer: 'wait=1, respond-async' } });
    expect(started.statusCode).toBe(202);
    const job = started.json<{ update: AgentUpdateJob }>().update;
    expect(job).toMatchObject({ kind: 'codex', state: 'running' });
    expect(runner).toHaveBeenCalledWith('update', 15 * 60_000);

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
    await vi.waitFor(async () => {
      const terminal = await app!.inject({ method: 'GET', url: `/api/agents/codex/update/${job.id}`, headers: readHeaders });
      expect(terminal.json()).toEqual({ update: { id: job.id, kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } });
    });
  }, 15_000);

  // preserve safe async start refusal codes
  it('maps asynchronous unavailable and busy starts', async () => {
    // select one refusal per configured test kind
    const startUpdate: AgentUpdateServiceLike['startUpdate'] = vi.fn(kind => kind === 'codex' ? { outcome: 'busy' } : { outcome: 'unavailable' });
    const agentUpdates: AgentUpdateServiceLike = { statuses: async () => [], update: async () => ({ outcome: 'unavailable' }), startUpdate, updateStatus: () => undefined };
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates });
    const headers = await authenticatedHeaders(app);
    const busy = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers: { ...headers, prefer: 'respond-async' } });
    const unavailable = await app.inject({ method: 'POST', url: '/api/agents/omx/update', headers: { ...headers, prefer: 'respond-async' } });
    expect(busy.statusCode).toBe(409);
    expect(unavailable.statusCode).toBe(404);
  }, 15_000);
});
