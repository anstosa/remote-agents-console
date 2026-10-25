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
  const agent = stated({ id: 'agent-new', paneId: '%9', sessionId: 'socket:$9', socketFingerprint: 'socket', home: '/repo/wts/feat', projectId: 'proj', worktreeId: newWorktree.id, title: 'Ready' });
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
  it('returns the offerable branches and the default', async () => {
    const worktreeManagement = { branches: async () => ({ ok: true, branches: [{ name: 'feature', ref: 'feature', remote: false, checkedOut: false }, { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }], defaultBranch: 'main' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'GET', url: '/api/projects/proj/branches', headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ branches: [{ name: 'feature', ref: 'feature', remote: false, checkedOut: false }, { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }], defaultBranch: 'main' });
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

  it('creates without launching when launch is off, but still starts the idle shell', async () => {
    const launched: string[] = [];
    const shells: string[] = [];
    const worktreeManagement = { add: async () => ({ ok: true, path: '/repo/wts/feat' }) } as never;
    const launch = { startWorktreeShell: async (w: { id: string }) => { shells.push(w.id); return true; }, launch: async (id: string) => { launched.push(id); return true; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore: await store() });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'new', branch: 'feat', base: 'main', launch: false } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ worktreeId: 'proj:/repo/wts/feat' });
      // the checkout still gets its idle shell (so it has a tab); no agent is launched
      expect(shells).toEqual(['proj:/repo/wts/feat']);
      expect(launched).toEqual([]);
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

  it('creates a worktree from a pull request number, labelled as the service names it', async () => {
    const added: unknown[] = [];
    const worktreeStore = await store();
    const worktreeManagement = { add: async (_id: string, input: unknown) => { added.push(input); return { ok: true, path: '/repo/wts/feat', label: 'Proj · pr-7' }; } } as never;
    const launch = { startWorktreeShell: async () => true, launch: async () => true } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore });
    try {
      for (const payload of [{ mode: 'pull-request' }, { mode: 'pull-request', number: '7' }, { mode: 'pull-request', number: 1.5 }, { mode: 'pull-request', number: 0 }]) {
        const invalid = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload });
        expect(invalid.statusCode).toBe(400);
      }
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees', headers: mutationHeaders, payload: { mode: 'pull-request', number: 7, launch: false } });
      expect(response.statusCode).toBe(201);
      // client-supplied branch names never reach a pull-request add
      expect(added).toEqual([{ mode: 'pull-request', number: 7 }]);
      expect(await worktreeStore.labels()).toEqual({ 'proj:/repo/wts/feat': 'Proj · pr-7' });
    } finally { await server.close(); }
  });
});
