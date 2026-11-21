import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { CleanupService } from '../src/cleanup/service.js';
import { testConfig } from './helpers/config.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';

const config = testConfig();

describe('cleanup API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); });

  // publish a real scan's overdue suggestion without closing its agent on reads
  it('exposes an idle hidden agent on the dashboard and closes it only on the selected cleanup POST', async () => {
    const socket = { fingerprint: 'idle-socket', path: '/tmp/idle-test-tmux', device: 1, inode: 2 };
    const pane = { socket, paneId: '%3', sessionId: '$1', windowId: '@1', pid: 300, cleanupActivity: 'p42', path: '/worktrees/idle', title: 'Ready', command: 'codex' };
    const closeIdlePane = vi.fn().mockResolvedValue(true);
    let now = 0;
    const discovery = {
      // the socket is known but the agent isn't in the dashboard inventory
      tmuxDiscoverySockets: new Set([socket.fingerprint]),
      refresh: async () => [],
      worktreesNow: () => [],
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] })
    };
    const cleanup = new CleanupService(
      discovery,
      { find: async () => [socket] },
      { listPanes: async () => [pane], capture: async () => 'Ready.\n›', closeIdlePane, close: vi.fn(), terminateHostProcess: vi.fn() },
      { recognizeAgent: async () => ({ kind: 'codex', pid: pane.pid, wrapped: false, startTime: '42' }), listProcesses: async () => [] },
      undefined,
      // simulate the watcher clock without waiting a day
      () => now
    );
    app = await buildApp(config, { auth: await testAuthService(), cleanup, discovery: discovery as never });
    const headers = await authenticatedHeaders(app);
    const readHeaders = { host: headers.host, cookie: headers.cookie };
    await expect(cleanup.scan()).resolves.toEqual([]);
    now = 24 * 60 * 60 * 1_000 + 1;
    const [target] = await cleanup.scan();

    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: readHeaders });
    const listed = await app.inject({ method: 'GET', url: '/api/cleanup', headers: readHeaders });
    expect(target).toMatchObject({ kind: 'stale-agent', detail: expect.stringContaining('Idle for more than 24 hours') });
    expect(dashboard.json()).toMatchObject({ cleanupPending: 1, cleanupTargets: [target] });
    expect(listed.json()).toMatchObject({ targets: [target] });
    expect(closeIdlePane).not.toHaveBeenCalled();

    const cleaned = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: [target!.id] } });
    expect(cleaned.json()).toMatchObject({ targets: [] });
    expect(closeIdlePane).toHaveBeenCalledExactlyOnceWith(pane);
  });

  // expose closed PR targets through the same authenticated selection contract
  it('returns closed-pr-branch targets, validates selections, and exposes pending state on the dashboard', async () => {
    const target = { id: 'cleanup-abcdefghijklmnopqrstuvwx', kind: 'closed-pr-branch', label: 'Cleanup candidate', detail: 'candidate detail' };
    let pending = [target];
    let scans = 0;
    const cleanup = {
      pending: () => pending,
      // record explicit cleanup discovery only
      scan: async () => { scans += 1; return pending; },
      cleanup: async (ids: unknown) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !pending.some(target => target.id === id))) return undefined;
        pending = pending.filter(target => !ids.includes(target.id));
        return pending;
      }
    };
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(config, {
      auth: await testAuthService(),
      cleanup: cleanup as never,
      discovery: discovery as never
    });
    const headers = await authenticatedHeaders(app);

    const listed = await app.inject({ method: 'GET', url: '/api/cleanup', headers: { host: headers.host, cookie: headers.cookie } });
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
    const invalid = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: ['missing'] } });
    const cleaned = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: [target.id] } });
    const after = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ targets: [target] });
    expect(dashboard.json().cleanupPending).toBe(1);
    expect(dashboard.json().cleanupTargets).toEqual([target]);
    expect(invalid.statusCode).toBe(400);
    expect(cleaned.json()).toEqual({ targets: [] });
    expect(after.json().cleanupPending).toBe(0);
    expect(after.json().cleanupTargets).toEqual([]);
    expect(scans).toBe(1);
  }, 15_000);

  it('pairs cleanup targets with the current cleanup version in API and dashboard responses', async () => {
    const target = { id: 'cleanup-abcdefghijklmnopqrstuvwx', kind: 'stale-agent', label: 'Cleanup candidate', detail: 'candidate detail' };
    let pending = [target];
    const version = { epoch: 4_321, revision: 0 };
    const cleanup = {
      // copy the current cleanup ordering metadata
      get version() { return { ...version }; },
      pending: () => pending,
      // replace the cached target snapshot
      scan: async () => { version.revision += 1; return pending; },
      // suppress selected cached targets
      cleanup: async (ids: unknown) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !pending.some(target => target.id === id))) return undefined;
        pending = pending.filter(target => !ids.includes(target.id));
        version.revision += ids.length;
        return pending;
      }
    };
    const discovery = { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(config, {
      auth: await testAuthService(),
      cleanup: cleanup as never,
      discovery: discovery as never
    });
    const headers = await authenticatedHeaders(app);

    const listed = await app.inject({ method: 'GET', url: '/api/cleanup', headers: { host: headers.host, cookie: headers.cookie } });
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
    const cleaned = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: [target.id] } });
    const after = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });

    expect(listed.json()).toEqual({ targets: [target], version: { epoch: 4_321, revision: 1 } });
    expect(dashboard.json()).toMatchObject({ cleanupTargets: [target], cleanupVersion: { epoch: 4_321, revision: 1 } });
    expect(cleaned.json()).toEqual({ targets: [], version: { epoch: 4_321, revision: 2 } });
    expect(after.json()).toMatchObject({ cleanupTargets: [], cleanupVersion: { epoch: 4_321, revision: 2 } });
  }, 15_000);
});
