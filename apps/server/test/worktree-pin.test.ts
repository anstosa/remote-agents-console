import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { testConfig, testWorktree } from './helpers/config.js';
import { stated } from './helpers/agent.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// a signed-session auth stub with CSRF always valid, so mutations pass the browser gate
const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutationHeaders = { host, origin: `https://${host}`, cookie: `__Host-rac=x`, 'x-csrf-token': 'csrf' };

async function store(): Promise<WorktreeLaunchStore> {
  const root = await mkdtemp(join(tmpdir(), 'rac-pin-')); dirs.push(root);
  return new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
}

describe('POST /api/worktrees/:id/pin', () => {
  const worktree = testWorktree({ id: 'proj:/repo', projectId: 'proj', path: '/repo', pinned: true });
  const encoded = encodeURIComponent(worktree.id);
  // a no-op dashboard fan-out keeps the pin route off the full loader
  const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

  it('records an explicit pin override and invalidates discovery', async () => {
    const worktreeStore = await store();
    let invalidated = 0;
    const discovery = { worktreesNow: () => [worktree], invalidateWorktrees: () => { invalidated += 1; } } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore, dashboardUpdates });
    try {
      const unpinned = await app.inject({ method: 'POST', url: `/api/worktrees/${encoded}/pin`, headers: mutationHeaders, payload: { pinned: false } });
      expect(unpinned.statusCode).toBe(204);
      // only the explicit override is stored; discovery re-reads it on the next tick
      expect(await worktreeStore.pins()).toEqual({ 'proj:/repo': false });
      expect(invalidated).toBe(1);
      const repinned = await app.inject({ method: 'POST', url: `/api/worktrees/${encoded}/pin`, headers: mutationHeaders, payload: { pinned: true } });
      expect(repinned.statusCode).toBe(204);
      expect(await worktreeStore.pins()).toEqual({ 'proj:/repo': true });
    } finally { await app.close(); }
  });

  it('rejects an unknown Worktree and a non-boolean pin state', async () => {
    const worktreeStore = await store();
    const discovery = { worktreesNow: () => [worktree], invalidateWorktrees: () => {}, place: async () => undefined } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore, dashboardUpdates });
    try {
      const unknown = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent('proj:/gone')}/pin`, headers: mutationHeaders, payload: { pinned: true } });
      expect(unknown.statusCode).toBe(404);
      const invalid = await app.inject({ method: 'POST', url: `/api/worktrees/${encoded}/pin`, headers: mutationHeaders, payload: { pinned: 'yes' } });
      expect(invalid.statusCode).toBe(400);
      expect(await worktreeStore.pins()).toEqual({});
    } finally { await app.close(); }
  });
});

describe('PATCH /api/worktrees/:id/label', () => {
  const worktree = testWorktree({ id: 'proj:/repo', projectId: 'proj', path: '/repo', pinned: true });
  const encoded = encodeURIComponent(worktree.id);
  // a no-op dashboard fan-out keeps the label route off the full loader
  const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

  it('records and clears a trimmed custom label, invalidating discovery', async () => {
    const worktreeStore = await store();
    let invalidated = 0;
    const discovery = { worktreesNow: () => [worktree], invalidateWorktrees: () => { invalidated += 1; } } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore, dashboardUpdates });
    try {
      const renamed = await app.inject({ method: 'PATCH', url: `/api/worktrees/${encoded}/label`, headers: mutationHeaders, payload: { label: '  🥔 Dave  ' } });
      expect(renamed.statusCode).toBe(204);
      expect(await worktreeStore.labels()).toEqual({ 'proj:/repo': '🥔 Dave' });
      const reset = await app.inject({ method: 'PATCH', url: `/api/worktrees/${encoded}/label`, headers: mutationHeaders, payload: { label: null } });
      expect(reset.statusCode).toBe(204);
      expect(await worktreeStore.labels()).toEqual({});
      expect(invalidated).toBe(2);
    } finally { await app.close(); }
  });

  it('returns after persistence without waiting for dashboard reconciliation', async () => {
    const worktreeStore = await store();
    const discovery = { worktreesNow: () => [worktree], invalidateWorktrees: () => {}, place: async () => undefined } as never;
    let releaseRefresh = () => {};
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    let markRefreshStarted = () => {};
    const refreshStarted = new Promise<void>(resolve => { markRefreshStarted = resolve; });
    const stalledDashboardUpdates = { setLoader: () => {}, refresh: () => { markRefreshStarted(); return refreshGate; }, close: () => {} } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore, dashboardUpdates: stalledDashboardUpdates });
    try {
      const pendingResponse = app.inject({ method: 'PATCH', url: `/api/worktrees/${encoded}/label`, headers: mutationHeaders, payload: { label: '🥔 Dave' } });
      await refreshStarted;
      // detect a handler blocked behind the unrelated dashboard scan
      const outcome = await Promise.race([pendingResponse, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 250))]);
      releaseRefresh();
      const response = await pendingResponse;
      expect(outcome).not.toBe('blocked');
      expect(response.statusCode).toBe(204);
      expect(await worktreeStore.labels()).toEqual({ 'proj:/repo': '🥔 Dave' });
    } finally {
      releaseRefresh();
      await app.close();
    }
  });

  it('rejects an unknown Worktree and invalid custom labels', async () => {
    const worktreeStore = await store();
    const discovery = { worktreesNow: () => [worktree], invalidateWorktrees: () => {}, place: async () => undefined } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore, dashboardUpdates });
    try {
      const unknown = await app.inject({ method: 'PATCH', url: `/api/worktrees/${encodeURIComponent('proj:/gone')}/label`, headers: mutationHeaders, payload: { label: 'Gone' } });
      expect(unknown.statusCode).toBe(404);
      // reject every invalid label shape
      for (const label of ['', 'has\nnewline', 'x'.repeat(121), 42]) {
        const invalid = await app.inject({ method: 'PATCH', url: `/api/worktrees/${encoded}/label`, headers: mutationHeaders, payload: { label } });
        expect(invalid.statusCode).toBe(400);
      }
      expect(await worktreeStore.labels()).toEqual({});
    } finally { await app.close(); }
  });
});

describe('GET /api/dashboard project shape', () => {
  it('nests each Worktree under its Project with tab order, pin and Launch profile', async () => {
    const worktreeStore = await store();
    const main = testWorktree({ id: 'proj:/repo', projectId: 'proj', label: 'Repo', path: '/repo', main: true, pinned: true });
    const linked = testWorktree({ id: 'proj:/repo-feat', projectId: 'proj', label: 'Repo · feat', path: '/repo-feat', main: false, pinned: false, branch: 'feat' });
    const agent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', projectId: 'proj', worktreeId: main.id, title: 'Ready' });
    const discovery = {
      worktreesNow: () => [main, linked],
      invalidateWorktrees: () => {},
      dashboard: async () => ({ generation: 1, places: [], serverStartedAt: 1, adapters: {}, agents: [agent], projects: [{ id: 'proj', label: 'Repo', available: true, worktrees: [
        { id: main.id, projectId: 'proj', label: 'Repo', path: '/repo', available: true, pinned: true, main: true, detached: false, locked: false, order: 0, branch: 'main' },
        { id: linked.id, projectId: 'proj', label: 'Repo · feat', path: '/repo-feat', available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'feat' }
      ] }] })
    } as never;
    const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), { auth, control, discovery, worktreeStore });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host, cookie: '__Host-rac=x' } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]).toMatchObject({ id: 'proj', label: 'Repo' });
      // both discovered Worktrees are on the wire, in tab order, the idle one carrying a launch profile
      expect(body.projects[0].worktrees.map((w: { id: string; order: number; main: boolean; pinned: boolean }) => ({ id: w.id, order: w.order, main: w.main, pinned: w.pinned })))
        .toEqual([{ id: 'proj:/repo', order: 0, main: true, pinned: true }, { id: 'proj:/repo-feat', order: 1, main: false, pinned: false }]);
      // the idle linked worktree resolves a one-click Launch profile; the active main defers to its agent
      expect(body.projects[0].worktrees[1].launch).toBeDefined();
      // the active worktree surfaces through its agent, not a duplicate tab
      expect(body.agents.map((a: { worktreeId?: string; projectId?: string }) => ({ worktreeId: a.worktreeId, projectId: a.projectId }))).toEqual([{ worktreeId: 'proj:/repo', projectId: 'proj' }]);
    } finally { await app.close(); }
  });
});
