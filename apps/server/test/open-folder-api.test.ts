import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { OpenedFolderStore } from '../src/places/opened-folders.js';
import type { Place } from '../src/places/places.js';
import { testConfig } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { stated } from './helpers/agent.js';
import { zeroPollDelay } from './helpers/run.js';

// Open folder (ADR 0014): one route opens any folder as a Workspace (an Agent, a Terminal, or a
// pinned empty Workspace), recording it among the recent folders the operator can list and forget.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const read = { host, cookie: '__Host-rac=x' };
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;
const idleDashboard = { generation: 1, adapters: {}, agents: [] as unknown[], projects: [], places: [] };

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-open-folder-')));
  dirs.push(root);
  return root;
}

// an app over a real folder `<root>/repo`, which discovery opens as `place`
async function start(options: { place?: (folder: string) => Place | undefined; launch?: object; dashboard?: (call: number, folder: string) => unknown; tmux?: object; target?: (id: string) => unknown } = {}) {
  const root = await tempRoot();
  const folder = join(root, 'repo');
  await mkdir(join(folder, 'src'), { recursive: true });
  const worktreeStore = new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
  const openedFolders = new OpenedFolderStore({ file: join(root, 'opened-folders.json') });
  let calls = 0;
  const openFolder = vi.fn(async (path: string) => (options.place ?? (() => ({ id: `ferry-1:${folder}`, kind: 'worktree', projectId: 'ferry-1', label: 'ferry', home: folder })))(path));
  const invalidateWorktrees = vi.fn();
  const discovery = {
    openFolder,
    invalidateWorktrees,
    worktreesNow: () => [],
    dashboard: async () => options.dashboard?.(calls++, folder) ?? idleDashboard,
    target: async (id: string) => options.target?.(id),
  };
  const launch = { launchResolutions: async () => new Map(), agentHome: () => root, ...options.launch };
  const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`) }), {
    auth, control, dashboardUpdates, launchPollDelay: zeroPollDelay, worktreeStore, openedFolders,
    discovery: discovery as never, launch: launch as never, tmux: (options.tmux ?? {}) as never,
  });
  return { app, root, folder, worktreeStore, openedFolders, openFolder, invalidateWorktrees };
}

const open = (payload: unknown) => ({ method: 'POST' as const, url: '/api/folders/open', headers: mutate, payload: payload as never });

describe('opening a folder', () => {
  it('refuses a path that is not an existing absolute folder, with the reason', async () => {
    const { app, root, openFolder } = await start();
    await writeFile(join(root, 'file.txt'), 'hi');
    try {
      const reasons = [];
      for (const path of ['repo', join(root, 'missing'), join(root, 'file.txt'), `${root}/re\0po`, `${root}/re\npo`, `/${'a'.repeat(4096)}`, 42]) {
        const response = await app.inject(open({ path, action: 'empty' }));
        expect(response.statusCode).toBe(400);
        reasons.push(response.json().error);
      }
      expect(reasons).toEqual(['The path must be absolute.', 'That folder does not exist.', 'That is not a folder.', 'That is not a valid path.', 'That is not a valid path.', 'That is not a valid path.', 'That is not a valid path.']);
      expect(openFolder).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('refuses an unknown action or agent kind', async () => {
    const { app, folder } = await start();
    try {
      expect((await app.inject(open({ path: folder, action: 'shell' }))).statusCode).toBe(400);
      expect((await app.inject(open({ path: folder, action: 'agent', kind: 'gpt' }))).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('expands a leading ~ against the account home and opens the realpath', async () => {
    const { app, folder, openFolder } = await start();
    try {
      const response = await app.inject(open({ path: '~/repo/src/../src', action: 'empty' }));
      expect(response.statusCode).toBe(201);
      expect(openFolder).toHaveBeenCalledWith(join(folder, 'src'));
    } finally { await app.close(); }
  });

  it('pins the Place for an empty Workspace, and records the folder', async () => {
    const { app, folder, worktreeStore, openedFolders, invalidateWorktrees } = await start();
    try {
      const response = await app.inject(open({ path: join(folder, 'src'), action: 'empty' }));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ placeId: `ferry-1:${folder}` });
      expect(await worktreeStore.pins()).toEqual({ [`ferry-1:${folder}`]: true });
      expect(invalidateWorktrees).toHaveBeenCalled();
      expect((await openedFolders.list()).map(entry => entry.path)).toEqual([join(folder, 'src')]);
    } finally { await app.close(); }
  });

  it('opens a Console shell at the Place for a Terminal', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const { app, folder } = await start({ launch: { createConsoleShell } });
    try {
      const response = await app.inject(open({ path: folder, action: 'terminal' }));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ placeId: `ferry-1:${folder}`, paneId: '%9' });
      expect(createConsoleShell).toHaveBeenCalledWith(expect.objectContaining({ id: `ferry-1:${folder}` }), '');
    } finally { await app.close(); }
  });

  it('launches an Agent of the given kind at an ad-hoc Scratch folder and returns it', async () => {
    const launchAt = vi.fn(async () => true);
    const adhoc = (folder: string): Place => ({ id: `scratch:${folder}`, kind: 'scratch', projectId: 'scratch', label: 'repo', home: folder, adhoc: true });
    const codex = (folder: string) => stated({ id: 'socket:%3', pane: { paneId: '%3' }, placeId: `scratch:${folder}`, title: 'Ready' });
    let opened = '';
    const { app, folder } = await start({
      place: adhoc,
      launch: { launchAt },
      dashboard: (call, folder) => { opened = folder; return call === 0 ? idleDashboard : { ...idleDashboard, agents: [codex(folder)] }; },
      tmux: { capture: async () => '' },
      target: () => ({ agent: codex(opened), socket: testSocket }),
    });
    try {
      const response = await app.inject(open({ path: folder, action: 'agent', kind: 'codex' }));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ placeId: `scratch:${folder}`, agentId: 'socket:%3' });
      expect(launchAt).toHaveBeenCalledWith(adhoc(folder), 'codex', undefined);
    } finally { await app.close(); }
  });

  it('reports a Claude trust prompt in the opened folder as needing the operator, not as a failed launch', async () => {
    const claude = (folder: string) => ({ ...stated({ id: 'socket:%3', pane: { paneId: '%3' }, title: 'Claude Code', placeId: `ferry-1:${folder}`, worktreeId: `ferry-1:${folder}` }), kind: 'claude' });
    const capture = vi.fn(async () => 'Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit');
    let opened = '';
    const { app, folder } = await start({
      launch: { launchAt: async () => true },
      dashboard: (call, folder) => { opened = folder; return call === 0 ? idleDashboard : { ...idleDashboard, agents: [claude(folder)] }; },
      tmux: { capture },
      target: () => ({ agent: claude(opened), socket: testSocket }),
    });
    try {
      const response = await app.inject(open({ path: folder, action: 'agent', kind: 'claude' }));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ placeId: `ferry-1:${folder}`, agentId: 'socket:%3', needsOperator: 'untrusted directory: safety check' });
      expect(capture).toHaveBeenCalledWith(testSocket, '%3');
    } finally { await app.close(); }
  });

  it('refuses a launch whose agent closes as it starts', async () => {
    const { app, folder } = await start({
      launch: { launchAt: async () => true },
      dashboard: (call, folder) => call === 0 ? idleDashboard : { ...idleDashboard, agents: [stated({ id: 'socket:%3', pane: { paneId: '%3' }, title: 'Ready', placeId: `ferry-1:${folder}`, worktreeId: `ferry-1:${folder}` })] },
      target: () => undefined,
    });
    try {
      const response = await app.inject(open({ path: folder, action: 'agent' }));
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/closed/u);
    } finally { await app.close(); }
  });

  it('refuses a launch that does not start', async () => {
    const { app, folder, openedFolders } = await start({ launch: { launchAt: async () => false } });
    try {
      const response = await app.inject(open({ path: folder, action: 'agent' }));
      expect(response.statusCode).toBe(409);
      expect(await openedFolders.list()).toEqual([]);
    } finally { await app.close(); }
  });
});

describe('recent folders', () => {
  it('lists the recorded folders and forgets one', async () => {
    const { app, folder, openedFolders } = await start();
    await openedFolders.record(folder, 5);
    try {
      const listed = await app.inject({ method: 'GET', url: '/api/folders/recent', headers: read });
      expect(listed.json()).toEqual({ folders: [{ path: folder, openedAt: 5, kind: 'folder' }] });
      const forgot = await app.inject({ method: 'POST', url: '/api/folders/forget', headers: mutate, payload: { path: folder } });
      expect(forgot.statusCode).toBe(204);
      expect(await openedFolders.list()).toEqual([]);
    } finally { await app.close(); }
  });
});
