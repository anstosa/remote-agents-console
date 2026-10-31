import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { stated } from './helpers/agent.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutationHeaders = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const readHeaders = { host, cookie: '__Host-rac=x' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

async function store(): Promise<WorktreeLaunchStore> {
  const root = await mkdtemp(join(tmpdir(), 'rac-add-api-')); dirs.push(root);
  return new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
}

const newWorktree = testWorktree({ id: 'proj:/repo/wts/feat', projectId: 'proj', label: 'Proj · feat', path: '/repo/wts/feat', identity: '/repo/wts/feat', main: false, pinned: false, branch: 'feat' });

// a discovery stub that surfaces the just-created worktree, and reveals its agent only
// after the launch call so waitForAgent sees a genuinely new agent id
function discoveryStub(agentAfterLaunch = true) {
  let dashboardCalls = 0;
  const agent = stated({ id: 'agent-new', pane: { paneId: '%9', sessionId: 'socket:$9', socketFingerprint: 'socket' }, home: '/repo/wts/feat', projectId: 'proj', worktreeId: newWorktree.id, title: 'Ready' });
  return {
    invalidateWorktrees: () => {},
    worktreesNow: () => [newWorktree],
    worktrees: async () => [newWorktree],
    dashboard: async () => { dashboardCalls += 1; return { generation: 1, places: [], adapters: {}, agents: agentAfterLaunch && dashboardCalls > 1 ? [agent] : [], projects: [] }; },
  } as never;
}

async function app(deps: Record<string, unknown>) {
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects: [testProject({ id: 'proj' })] }), { auth, control, dashboardUpdates, launchPollDelay: async () => {}, ...deps } as never);
}

describe('GET /api/projects/:id/branches', () => {
  it('returns the offerable branches and the base to pre-select, and nothing else', async () => {
    const worktreeManagement = { branches: async () => ({ ok: true, branches: [{ name: 'feature', ref: 'feature', remote: false, checkedOut: false }, { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }], base: 'origin/main', fetchError: 'not a field of this answer' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'GET', url: '/api/projects/proj/branches', headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ branches: [{ name: 'feature', ref: 'feature', remote: false, checkedOut: false }, { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }], base: 'origin/main' });
    } finally { await server.close(); }
  });

  it('propagates the service refusal status', async () => {
    const worktreeManagement = { branches: async () => ({ ok: false, status: 409, error: 'blocked' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'GET', url: '/api/projects/proj/branches', headers: readHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'blocked' });
    } finally { await server.close(); }
  });
});

describe('POST /api/projects/:id/worktrees', () => {
  it('creates, pins, and launches — returning the worktree id and its agent', async () => {
    const launched: string[] = [];
    const shells: string[] = [];
    const worktreeStore = await store();
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async (w: { id: string }) => { shells.push(w.id); return true; }, launch: async (id: string) => { launched.push(id); return true; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat', agentId: 'agent-new' });
      expect(shells).toEqual(['proj:/repo/wts/feat']);
      expect(launched).toEqual(['proj:/repo/wts/feat']);
      // the new checkout is pinned so it keeps its tab
      expect(await worktreeStore.pins()).toEqual({ 'proj:/repo/wts/feat': true });
    } finally { await server.close(); }
  });

  it('opens a Terminal: starts the idle shell but launches no agent', async () => {
    const launched: string[] = [];
    const shells: string[] = [];
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async (w: { id: string }) => { shells.push(w.id); return true; }, launch: async (id: string) => { launched.push(id); return true; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main', open: 'terminal' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat' });
      // the checkout still gets its idle shell (so it has a tab); no agent is launched
      expect(shells).toEqual(['proj:/repo/wts/feat']);
      expect(launched).toEqual([]);
    } finally { await server.close(); }
  });

  it('opens Nothing: runs setup and pins, but starts neither the shell nor an agent', async () => {
    const events: string[] = [];
    const worktreeStore = await store();
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async () => { events.push('shell'); return true; }, launch: async () => { events.push('launch'); return true; } } as never;
    const worktreeCommands = { runSetup: async () => { events.push('setup'); return { ok: true }; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, worktreeStore });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'existing', branch: 'feat', open: 'empty' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat' });
      // the pin alone keeps its tab
      expect(events).toEqual(['setup']);
      expect(await worktreeStore.pins()).toEqual({ 'proj:/repo/wts/feat': true });
    } finally { await server.close(); }
  });

  it('records the Issue a new branch was created for in the Worktree\'s record, and says why origin could not be fetched', async () => {
    const worktreeStore = await store();
    let refused = true;
    const worktreeManagement = { add: async () => refused ? { ok: false, status: 409, error: 'branch `12-fix-login` already exists' } : { ok: true, path: '/repo/wts/feat', fetchError: 'fatal: unable to access' } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch: { startWorktreeShell: async () => true, launch: async () => true } as never, worktreeStore });
    try {
      const payload = { mode: 'new', branch: '12-fix-login', base: 'origin/main', issue: 12, open: 'empty' };
      // a refused creation records nothing
      expect((await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload })).statusCode).toBe(409);
      expect(await worktreeStore.issues()).toEqual({});
      refused = false;
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat', fetchError: 'fatal: unable to access' });
      expect(await worktreeStore.issues()).toEqual({ 'proj:/repo/wts/feat': 12 });
    } finally { await server.close(); }
  });

  it('rejects an Issue that is not a number, or beside a pull request, before adding', async () => {
    const added: unknown[] = [];
    const worktreeManagement = { add: async (_id: string, input: unknown) => { added.push(input); return { ok: true, path: '/repo/wts/feat' }; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch: { startWorktreeShell: async () => true, launch: async () => true } as never, worktreeStore: await store() });
    try {
      for (const payload of [{ mode: 'new', branch: 'feat', issue: '12' }, { mode: 'new', branch: 'feat', issue: 0 }, { mode: 'new', branch: 'feat', issue: 1.5 }, { mode: 'pull-request', number: 7, issue: 12 }]) {
        const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload });
        expect(response.statusCode).toBe(400);
      }
      expect(added).toEqual([]);
    } finally { await server.close(); }
  });

  it('rejects an unknown open choice before adding', async () => {
    const added: unknown[] = [];
    const worktreeManagement = { add: async (_id: string, input: unknown) => { added.push(input); return { ok: true, path: '/repo/wts/feat' }; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch: { startWorktreeShell: async () => true, launch: async () => true } as never, worktreeStore: await store() });
    try {
      for (const open of ['review', 'none', true]) {
        const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', open } });
        expect(response.statusCode).toBe(400);
      }
      expect(added).toEqual([]);
    } finally { await server.close(); }
  });

  it('returns 201 with a launch error when the created worktree cannot be resolved', async () => {
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async () => true, launch: async () => true } as never;
    // discovery never surfaces the new checkout, so the route cannot resolve it to launch
    const discovery = { invalidateWorktrees: () => {}, worktreesNow: () => [], worktrees: async () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) } as never;
    const server = await app({ discovery, worktreeManagement, launch, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ worktreeId: 'proj:/repo/wts/feat', launchError: expect.stringContaining('could not be resolved') });
    } finally { await server.close(); }
  });

  it('still returns 201 with a launch error when the agent cannot start', async () => {
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async () => true, launch: async () => false } as never;
    const server = await app({ discovery: discoveryStub(false), worktreeManagement, launch, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ worktreeId: 'proj:/repo/wts/feat', launchError: expect.stringContaining('could not be started') });
    } finally { await server.close(); }
  });

  it('runs setup before the shell and agent, then launches when setup succeeds', async () => {
    const events: string[] = [];
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async () => { events.push('shell'); return true; }, launch: async () => { events.push('launch'); return true; } } as never;
    const worktreeCommands = { runSetup: async () => { events.push('setup'); return { ok: true }; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat', agentId: 'agent-new' });
      // setup is prepared first, then the idle shell, then the agent
      expect(events).toEqual(['setup', 'shell', 'launch']);
    } finally { await server.close(); }
  });

  it('gates the launch on a setup failure but still creates and pins the worktree', async () => {
    const launched: string[] = [];
    const shells: string[] = [];
    const worktreeStore = await store();
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async (w: { id: string }) => { shells.push(w.id); return true; }, launch: async (id: string) => { launched.push(id); return true; } } as never;
    const worktreeCommands = { runSetup: async () => ({ ok: false, log: '/repo/wts/feat/.data/stack-logs/setup.log' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, worktreeStore });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ worktreeId: 'proj:/repo/wts/feat', setupError: expect.stringContaining('setup command failed') });
      // no agent is launched into a half-prepared worktree, but it still gets its idle shell and stays pinned
      expect(launched).toEqual([]);
      expect(shells).toEqual(['proj:/repo/wts/feat']);
      expect(await worktreeStore.pins()).toEqual({ 'proj:/repo/wts/feat': true });
    } finally { await server.close(); }
  });

  it('propagates a service refusal and rejects an invalid body before adding', async () => {
    const added: unknown[] = [];
    const worktreeManagement = { add: async (_id: string, input: unknown) => { added.push(input); return { ok: false, status: 409, error: 'branch `feat` already exists' }; } } as never;
    const launch = { startWorktreeShell: async () => true, launch: async () => true } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore: await store() });
    try {
      const refused = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'existing', branch: 'feat' } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'branch `feat` already exists' });
      const invalid = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'sideways', branch: 'feat' } });
      expect(invalid.statusCode).toBe(400);
      // an invalid mode never reaches the service
      expect(added).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('creates a worktree from a pull request number, never from a client-supplied branch', async () => {
    const added: unknown[] = [];
    const worktreeStore = await store();
    const worktreeManagement = { add: async (_id: string, input: unknown) => { added.push(input); return { ok: true, path: '/repo/wts/feat' }; } } as never;
    const launch = { startWorktreeShell: async () => true, launch: async () => true } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore });
    try {
      for (const payload of [{ mode: 'pull-request' }, { mode: 'pull-request', number: '7' }, { mode: 'pull-request', number: 1.5 }, { mode: 'pull-request', number: 0 }]) {
        const invalid = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload });
        expect(invalid.statusCode).toBe(400);
      }
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'pull-request', number: 7, branch: 'evil', open: 'terminal' } });
      expect(response.statusCode).toBe(201);
      expect(added).toEqual([{ mode: 'pull-request', number: 7, openAgent: false }]);
      // discovery names a pr-<number> checkout itself, so no operator label is stored
      expect(await worktreeStore.labels()).toEqual({});
    } finally { await server.close(); }
  });

  it('opens a fork pull request without running setup, and passes an Agent request to the service to refuse', async () => {
    const events: string[] = [];
    const added: unknown[] = [];
    const worktreeManagement = { add: async (_id: string, input: { openAgent?: boolean }) => { added.push(input); return input.openAgent ? { ok: false, status: 409, error: 'Fork pull requests open without setup or an agent. Choose Terminal or Nothing.' } : { ok: true, path: '/repo/wts/feat', fork: true }; } } as never;
    const launch = { startWorktreeShell: async () => { events.push('shell'); return true; }, launch: async () => { events.push('launch'); return true; } } as never;
    const worktreeCommands = { runSetup: async () => { events.push('setup'); return { ok: true }; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, worktreeStore: await store() });
    try {
      // Review is sent as `agent`, so this covers both
      const refused = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'pull-request', number: 8, open: 'agent' } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'Fork pull requests open without setup or an agent. Choose Terminal or Nothing.' });
      expect(added).toEqual([{ mode: 'pull-request', number: 8, openAgent: true }]);
      const terminal = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'pull-request', number: 8, open: 'terminal' } });
      expect(terminal.statusCode).toBe(201);
      expect(terminal.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat' });
      // the fork's code gets its shell, but setup never runs in it
      expect(events).toEqual(['shell']);
    } finally { await server.close(); }
  });

  it('reads a stale client\'s `launch: false` with no open choice as a Terminal', async () => {
    const events: string[] = [];
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async () => { events.push('shell'); return true; }, launch: async () => { events.push('launch'); return true; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', launch: false } });
      expect(response.statusCode).toBe(201);
      expect(events).toEqual(['shell']);
    } finally { await server.close(); }
  });
});

describe('GET /api/projects/:id/switch-prs', () => {
  it('serves the repository list and limits it to 30 reads a minute', async () => {
    const list = { pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true };
    const prSwitch = { branchList: async (id: string) => id === 'proj' ? list : undefined } as never;
    const server = await app({ discovery: discoveryStub(), prSwitch, worktreeStore: await store() });
    try {
      expect((await server.inject({ method: 'GET', url: '/api/projects/absent/switch-prs', headers: readHeaders })).statusCode).toBe(404);
      const first = await server.inject({ method: 'GET', url: '/api/projects/proj/switch-prs', headers: readHeaders });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual(list);
      const statuses: number[] = [];
      for (let index = 0; index < 29; index += 1) statuses.push((await server.inject({ method: 'GET', url: '/api/projects/proj/switch-prs', headers: readHeaders })).statusCode);
      expect(statuses.at(-1)).toBe(429);
    } finally { await server.close(); }
  });
});
