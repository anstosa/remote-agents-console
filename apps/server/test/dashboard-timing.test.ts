import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { DashboardUpdates, type DashboardBuild, type DashboardPayload } from '../src/dashboard/updates.js';
import { dashboardTimingReport } from '../src/dashboard/timing.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig, testWorktree } from './helpers/config.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const lines = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(line => line !== '');

describe('dashboard timing', () => {
  it('logs the build that served GET /api/dashboard and not a fast poll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-dashboard-timing-'));
    dirs.push(root);
    const file = join(root, 'dashboard-timing.jsonl');
    const worktree = testWorktree({ id: 'proj:/repo' });
    const discovery = {
      worktreesNow: () => [worktree],
      invalidateWorktrees: () => {},
      dashboard: async () => ({ generation: 1, serverStartedAt: 0, places: [], adapters: {}, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: worktree.id, projectId: 'proj', label: 'Proj', path: '/repo', available: true, pinned: true, main: true, detached: false, locked: false, order: 0, branch: 'main' }] }] })
    } as never;
    const dashboardUpdates = new DashboardUpdates<DashboardPayload>();
    const app = await buildApp(testConfig(), { auth: await testAuthService(), discovery, dashboardUpdates, worktreeStore: new WorktreeLaunchStore({ file: join(root, 'worktrees.json') }), dashboardTimingFile: file });
    try {
      await dashboardUpdates.refresh('poll');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(await lines(file)).toEqual([]);

      const headers = await authenticatedHeaders(app);
      const response = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: testHost, cookie: headers.cookie } });
      expect(response.statusCode).toBe(200);
      await vi.waitFor(async () => expect(await lines(file)).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 50));
      const records = await lines(file);
      expect(records).toHaveLength(1);
      const record = JSON.parse(records[0]!);
      expect(record).toMatchObject({
        trigger: 'http',
        callers: [{ trigger: 'http', atMs: 0 }],
        ms: expect.any(Number),
        uptimeMs: expect.any(Number),
        counts: { agents: 0, projects: 1, worktrees: 1, places: 0 },
        eventLoop: { utilization: expect.any(Number), maxDelayMs: expect.any(Number) },
        http: { jsonBytes: Buffer.byteLength(response.body), serializeMs: expect.any(Number) }
      });
      expect(Number.isNaN(Date.parse(record.at))).toBe(false);
      for (const step of ['discovery', 'queuedCounts', 'observeAgents', 'emitAgents', 'stackState', 'watches', 'reviews', 'launchResolutions', 'publish']) expect(record.steps[step], step).toEqual(expect.any(Number));
    } finally { await app.close(); }
  });

  it('records every caller that joined a build in flight', async () => {
    let release: (() => void) | undefined;
    const report = vi.fn();
    const updates = new DashboardUpdates<{ n: number }>();
    updates.setLoader(async () => { await new Promise<void>(resolve => { release = resolve; }); return { n: 1 }; }, report);
    const started = updates.refresh('poll');
    const joined = updates.refresh('http');
    release?.();
    await Promise.all([started, joined]);
    await new Promise(resolve => setImmediate(resolve));
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0].callers).toEqual([{ trigger: 'poll', atMs: 0 }, { trigger: 'http', atMs: expect.any(Number) }]);
    expect(report.mock.calls[0]![1]).toEqual({ n: 1 });
  });

  it('always logs a page load, but slow routine builds at most once every 10 s', () => {
    const records: unknown[] = [];
    const report = dashboardTimingReport(async record => { records.push(record); });
    const build = (trigger: 'poll' | 'ws', startedAt: number, ms: number): DashboardBuild => ({ callers: [{ trigger, atMs: 0 }], startedAt, steps: {}, counts: {}, ms });
    report(build('poll', 1_000, 400), {});
    report(build('poll', 1_500, 400), {});
    report(build('ws', 2_000, 40), {});
    report(build('poll', 11_000, 400), {});
    expect(records.map(record => (record as { uptimeMs: number }).uptimeMs)).toEqual([1_000, 2_000, 11_000]);
  });
});
