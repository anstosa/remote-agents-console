import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { folderNoteKey, type Place } from '../src/places/places.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { stated } from './helpers/agent.js';
import { launchFake, zeroPollDelay } from './helpers/run.js';

// The Place-scoped routes that exist for Worktrees, driven with a directory-Project Place and
// Scratch Places that have no Agent: panes, Console shells, pane tickets, pins, notes and file
// preview accept them; the git-only routes refuse them with a clear 409.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const read = { host, cookie: '__Host-rac=x' };
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

// the Places discovery lists: a bridged directory Project, the configured Scratch folder, and an
// ad-hoc Scratch folder holding a Console shell
const directoryPlace: Place = { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', hostPath: '/host/notes' };
const scratchPlace: Place = { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch' };
const adhocPlace: Place = { id: 'scratch:/srv/tools', kind: 'scratch', projectId: 'scratch', label: 'tools', home: '/srv/tools', adhoc: true };
const listed = [directoryPlace, scratchPlace, adhocPlace];
const worktree = testWorktree({ id: 'proj:/repo', projectId: 'proj', path: '/repo' });
const url = (id: string, rest: string) => `/api/worktrees/${encodeURIComponent(id)}${rest}`;
const shell = (over: Record<string, unknown> = {}) => ({ paneId: '%9', sessionId: '$4', windowId: '@2', pid: 9, path: '/data/notes', command: 'zsh', role: 'shell', title: '', socket: testSocket, ...over });
const idleDashboard = { generation: 1, adapters: {}, agents: [] as unknown[], projects: [], places: [] };

// `realLaunch` leaves the launch service to buildApp, so its Place-session lookup is the app's own wiring
async function start(deps: { discovery?: object; launch?: object; realLaunch?: true; tmux?: object; notes?: WorktreeNoteService; worktreeStore?: WorktreeLaunchStore; workspaceFiles?: object } = {}) {
  const discovery = {
    worktreesNow: () => [worktree],
    invalidateWorktrees: () => {},
    dashboard: async () => idleDashboard,
    place: async (id: string) => listed.find(place => place.id === id),
    target: async () => undefined,
    ...deps.discovery,
  };
  const launch = { launchResolutions: async () => new Map(), consoleShellBusy: (pane: { command: string }) => pane.command !== 'zsh', ...deps.launch };
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects: [testProject({ id: 'proj' }), testProject({ id: 'notes', label: 'Notes', path: '/data/notes', identity: '/data/notes', mode: 'directory', hostPath: '/host/notes' })], scratchDirectory: '/home/me/scratch' }), {
    auth, control, dashboardUpdates, launchPollDelay: zeroPollDelay,
    discovery: discovery as never, tmux: (deps.tmux ?? {}) as never,
    ...(deps.realLaunch ? {} : { launch: launch as never }),
    ...(deps.notes === undefined ? {} : { notes: deps.notes }),
    ...(deps.worktreeStore === undefined ? {} : { worktreeStore: deps.worktreeStore }),
    ...(deps.workspaceFiles === undefined ? {} : { workspaceFiles: deps.workspaceFiles as never }),
  });
}

async function tempFile(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-place-routes-')); dirs.push(root);
  return join(root, name);
}

describe('Terminals at a directory-Project or Scratch Place with no Agent', () => {
  it('lists the Place panes, disabling any live Agent pane', async () => {
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$4', socketFingerprint: 'socket', home: '/data/notes', placeId: directoryPlace.id, title: 'Ready' });
    const placePanes = vi.fn(async () => [shell(), shell({ paneId: '%1', role: undefined, command: 'codex' })]);
    const app = await start({ launch: { placePanes }, discovery: { dashboard: async () => ({ ...idleDashboard, agents: [agent] }) } });
    try {
      const response = await app.inject({ method: 'GET', url: url(directoryPlace.id, '/panes'), headers: read });
      expect(response.statusCode).toBe(200);
      expect(response.json().panes.map((pane: { paneId: string; agent: boolean }) => [pane.paneId, pane.agent])).toEqual([['%9', false], ['%1', true]]);
      expect(placePanes).toHaveBeenCalledWith(directoryPlace);
    } finally { await app.close(); }
  });

  it('opens a Console shell at a directory Project and at the Scratch folder with no Agent', async () => {
    const createConsoleShell = vi.fn(async () => '%9');
    const app = await start({ launch: { createConsoleShell } });
    try {
      const directory = await app.inject({ method: 'POST', url: url(directoryPlace.id, '/shells'), headers: mutate, payload: { name: 'build' } });
      expect(directory.statusCode).toBe(201);
      // the listed Place carries its bridge host path, where the host tmux starts the shell
      expect(createConsoleShell).toHaveBeenCalledWith(directoryPlace, 'build', '');
      const scratch = await app.inject({ method: 'POST', url: url(scratchPlace.id, '/shells'), headers: mutate, payload: {} });
      expect(scratch.statusCode).toBe(201);
      expect(createConsoleShell).toHaveBeenLastCalledWith(scratchPlace, '', '');
    } finally { await app.close(); }
  });

  it("opens a Console shell beside the Place's own Agent, not another Place's", async () => {
    // an Agent at another Place comes first, so only the Place match picks the right session
    const elsewhere = stated({ id: 'socket:%3', paneId: '%3', sessionId: 'socket:$2', socketFingerprint: 'socket', home: '/repo', placeId: worktree.id, worktreeId: worktree.id, title: 'Ready' });
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$7', socketFingerprint: 'socket', home: '/home/me/scratch', placeId: scratchPlace.id, title: 'Ready' });
    const createConsoleShellWindow = vi.fn(async () => '%9');
    const app = await start({
      realLaunch: true,
      tmux: { createConsoleShellWindow },
      discovery: { dashboard: async () => ({ ...idleDashboard, agents: [elsewhere, agent] }), target: async (id: string) => [elsewhere, agent].map(candidate => ({ agent: candidate, socket: testSocket })).find(target => target.agent.id === id) },
    });
    try {
      const response = await app.inject({ method: 'POST', url: url(scratchPlace.id, '/shells'), headers: mutate, payload: {} });
      expect(response.statusCode).toBe(201);
      expect(createConsoleShellWindow).toHaveBeenCalledWith(testSocket, '$7', '/home/me/scratch', expect.any(Array), '');
    } finally { await app.close(); }
  });

  it('renames and ends a Console shell at an ad-hoc Scratch Place', async () => {
    const renamePaneName = vi.fn(async () => true);
    const close = vi.fn(async () => true);
    const placeConsoleShells = vi.fn(async () => [shell({ path: '/srv/tools' })]);
    const app = await start({ launch: { placeConsoleShells }, tmux: { renamePaneName, close } });
    try {
      const renamed = await app.inject({ method: 'PATCH', url: url(adhocPlace.id, '/panes/%259'), headers: mutate, payload: { name: 'logs' } });
      expect(renamed.statusCode).toBe(204);
      expect(renamePaneName).toHaveBeenCalledWith(testSocket, '%9', 'logs');
      const ended = await app.inject({ method: 'DELETE', url: url(adhocPlace.id, '/panes/%259'), headers: mutate });
      expect(ended.statusCode).toBe(204);
      expect(close).toHaveBeenCalledWith(testSocket, '%9');
      expect(placeConsoleShells).toHaveBeenCalledWith(adhocPlace);
    } finally { await app.close(); }
  });

  it('mints a pane ticket for a listed Place and refuses an unknown one', async () => {
    const app = await start();
    try {
      const minted = await app.inject({ method: 'POST', url: url(scratchPlace.id, '/tickets'), headers: mutate, payload: { kind: 'pane' } });
      expect(minted.statusCode).toBe(200);
      expect(typeof minted.json().ticket).toBe('string');
      // a Scratch folder the dashboard does not list (no Agent, shell or pin) is no Place
      const unknown = await app.inject({ method: 'POST', url: url('scratch:/etc', '/tickets'), headers: mutate, payload: { kind: 'pane' } });
      expect(unknown.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('Pins at every Place', () => {
  it('pins a directory-Project and a Scratch Place, and unpinning clears the record', async () => {
    const worktreeStore = new WorktreeLaunchStore({ file: await tempFile('worktrees.json') });
    let invalidated = 0;
    const app = await start({ worktreeStore, discovery: { invalidateWorktrees: () => { invalidated += 1; } } });
    try {
      expect((await app.inject({ method: 'POST', url: url(directoryPlace.id, '/pin'), headers: mutate, payload: { pinned: true } })).statusCode).toBe(204);
      expect((await app.inject({ method: 'POST', url: url(adhocPlace.id, '/pin'), headers: mutate, payload: { pinned: true } })).statusCode).toBe(204);
      expect(await worktreeStore.pins()).toEqual({ [directoryPlace.id]: true, [adhocPlace.id]: true });
      // unpinned is the default for these Places, so no `pinned: false` is left behind
      expect((await app.inject({ method: 'POST', url: url(directoryPlace.id, '/pin'), headers: mutate, payload: { pinned: false } })).statusCode).toBe(204);
      expect(await worktreeStore.pins()).toEqual({ [adhocPlace.id]: true });
      expect(await worktreeStore.keys()).toEqual([adhocPlace.id]);
      expect(invalidated).toBe(3);
    } finally { await app.close(); }
  });
});

describe('Notes at an idle directory-Project or Scratch Place', () => {
  it('creates, lists, edits and deletes notes under the folder key its Agent uses', async () => {
    const notes = new WorktreeNoteService(await tempFile('notes.json'));
    const app = await start({ notes });
    try {
      const created = await app.inject({ method: 'POST', url: url(directoryPlace.id, '/notes'), headers: mutate, payload: { title: 'Plan', text: 'Draft the plan' } });
      expect(created.statusCode).toBe(201);
      const noteId = created.json().id as string;
      // an Agent launched there runs in the bridge host path and keys its notes by that folder
      expect((await notes.list(folderNoteKey('/host/notes')))?.map(note => note.id)).toEqual([noteId]);
      const listed = await app.inject({ method: 'GET', url: url(directoryPlace.id, '/notes'), headers: read });
      expect(listed.json().notes.map((note: { id: string }) => note.id)).toEqual([noteId]);
      expect((await app.inject({ method: 'PUT', url: url(directoryPlace.id, `/notes/${noteId}`), headers: mutate, payload: { text: 'Revised' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: url(directoryPlace.id, `/notes/${noteId}`), headers: mutate })).statusCode).toBe(200);
      // a Scratch Place keeps its own notes
      const scratchCreated = await app.inject({ method: 'POST', url: url(scratchPlace.id, '/notes'), headers: mutate, payload: { title: 'Idea', text: 'Scratch idea' } });
      const scratchId = scratchCreated.json().id as string;
      const scratchDeleted = await app.inject({ method: 'DELETE', url: url(scratchPlace.id, `/notes/${scratchId}`), headers: mutate });
      expect(scratchDeleted.json()).toMatchObject({ id: scratchId, undoToken: expect.any(String) });
      expect(await notes.list(folderNoteKey('/home/me/scratch'))).toEqual([]);
      const scratchRestored = await app.inject({ method: 'POST', url: `/api/notes/deletions/${scratchDeleted.json().undoToken as string}/undo`, headers: mutate });
      expect(scratchRestored.json()).toMatchObject({ id: scratchId, title: 'Idea', text: 'Scratch idea' });
      expect((await notes.list(folderNoteKey('/home/me/scratch')))?.map(note => note.id)).toEqual([scratchId]);
    } finally { await app.close(); }
  });

  it('keys an Agent’s own notes by its Place, so an Agent in a subfolder shares the Place notes', async () => {
    const notes = new WorktreeNoteService(await tempFile('notes.json'));
    const placeNote = await notes.createWithText(folderNoteKey('/host/notes'), 'Plan', 'Draft the plan');
    // started by hand in a subfolder of the directory Project, on the host side of the bridge
    const agent = stated({ id: 'socket:%3', paneId: '%3', sessionId: 'socket:$4', socketFingerprint: 'socket', home: '/host/notes/2026', placeId: directoryPlace.id, title: 'Ready' });
    const app = await start({ notes, discovery: { target: async (id: string) => id === agent.id ? { agent, socket: testSocket } : undefined } });
    try {
      const listed = await app.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(agent.id)}/notes`, headers: read });
      expect(listed.json().notes.map((note: { id: string }) => note.id)).toEqual([placeNote!.id]);
      const created = await app.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notes`, headers: mutate, payload: { title: 'Saved draft', text: 'From the composer' } });
      expect(created.statusCode).toBe(201);
      // the Place tab lists the note the Agent saved
      const atPlace = await app.inject({ method: 'GET', url: url(directoryPlace.id, '/notes'), headers: read });
      expect(atPlace.json().notes.map((note: { id: string }) => note.id).sort()).toEqual([placeNote!.id, created.json().id].sort());
    } finally { await app.close(); }
  });

  it('runs a note by launching at its Place', async () => {
    const notes = new WorktreeNoteService(await tempFile('notes.json'));
    const directoryNote = await notes.createWithText(folderNoteKey('/host/notes'), 'Report', 'Draft the report');
    const scratchNote = await notes.createWithText(folderNoteKey('/home/me/scratch'), 'Probe', 'Probe the thing');
    const adhocNote = await notes.createWithText(folderNoteKey('/srv/tools'), 'Tools', 'Tidy the tools');
    // a refused launch still records which launch the Run dispatched
    const launch = launchFake({ refuse: true });
    const app = await start({ notes, launch });
    try {
      await app.inject({ method: 'POST', url: url(directoryPlace.id, `/notes/${directoryNote!.id}/run`), headers: mutate, payload: { kind: 'codex' } });
      await app.inject({ method: 'POST', url: url(scratchPlace.id, `/notes/${scratchNote!.id}/run`), headers: mutate, payload: { kind: 'codex' } });
      expect(launch.calls.map(call => call.via)).toEqual(['project', 'home']);
      // an ad-hoc Scratch folder has no launch of its own yet
      const adhoc = await app.inject({ method: 'POST', url: url(adhocPlace.id, `/notes/${adhocNote!.id}/run`), headers: mutate, payload: { kind: 'codex' } });
      expect(adhoc.statusCode).toBe(409);
      expect(adhoc.json().error).toMatch(/cannot launch/iu);
      expect(launch.calls).toHaveLength(2);
    } finally { await app.close(); }
  });
});

describe('File preview at any Place', () => {
  it('previews a file in a directory Place home, with no git involved', async () => {
    const preview = vi.fn(async (_root: string, path: string) => ({ path, size: 2, binary: false, truncated: false, content: 'ok' }));
    const app = await start({ workspaceFiles: { preview } });
    try {
      const response = await app.inject({ method: 'POST', url: url(directoryPlace.id, '/file-preview'), headers: mutate, payload: { path: 'todo.md' } });
      expect(response.statusCode).toBe(200);
      expect(preview).toHaveBeenCalledWith('/data/notes', 'todo.md');
    } finally { await app.close(); }
  });
});

describe('Git-only routes at a directory-Project or Scratch Place', () => {
  const routes = [
    ['GET', '/conversations', /only a worktree/iu],
    ['POST', '/conversations/switch', /only a worktree/iu],
    ['DELETE', '/conversations/codex/abc', /only a worktree/iu],
    ['POST', '/comparison', /only a worktree/iu],
    ['POST', '/comparison/file', /only a worktree/iu],
    // the review tour keeps its own error shape
    ['GET', '/review-tour', /target_unavailable/u],
    ['DELETE', '/review-tour', /target_unavailable/u],
    ['GET', '/removal', /only a worktree/iu],
    ['DELETE', '', /only a worktree/iu],
    ['GET', '/branch-removal?branch=main', /only a worktree/iu],
    ['DELETE', '/branch', /only a worktree/iu],
    ['POST', '/commands/start', /only a worktree/iu],
    ['GET', '/commands/log', /only a worktree/iu],
    ['GET', '/processes/dev/output', /only a worktree/iu],
    ['POST', '/processes/dev/start', /only a worktree/iu],
    ['PATCH', '/label', /only a worktree can be renamed/iu],
  ] as const;
  it.each(listed.flatMap(place => routes.map(([method, rest, error]) => [place.id, method, rest, error] as const)))('%s: %s %s answers 409', async (id, method, rest, error) => {
    const app = await start();
    try {
      const response = await app.inject({ method, url: url(id, rest), headers: mutate, payload: method === 'GET' ? undefined : { label: 'Renamed', branch: 'main', kind: 'working', path: 'a.txt' } });
      expect(response.statusCode).toBe(409);
      expect(JSON.stringify(response.json())).toMatch(error);
    } finally { await app.close(); }
  });

  it('still answers 404 for an id that is no Place at all', async () => {
    const app = await start();
    try {
      const response = await app.inject({ method: 'GET', url: url('proj:/gone', '/removal'), headers: read });
      expect(response.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('a Worktree with a long id', () => {
  // the router caps each path parameter (100 characters by default), and an encoded Worktree id
  // is a project id plus a whole, percent-encoded path
  it('reaches its Place routes instead of a 404 or a 414', async () => {
    const path = '/tachi/code/obsidian/community-workers.worktrees/npm12-lockfile-fallback-to-npm10';
    const long = testWorktree({ id: `obsidian-community-workers:${path}`, path, main: false });
    const placePanes = vi.fn(async () => [shell({ path })]);
    const app = await start({ launch: { placePanes }, discovery: { worktreesNow: () => [worktree, long] } });
    try {
      const response = await app.inject({ method: 'GET', url: url(long.id, '/panes'), headers: read });
      expect(response.statusCode).toBe(200);
      expect(response.json().panes.map((pane: { paneId: string }) => pane.paneId)).toEqual(['%9']);
    } finally { await app.close(); }
  });
});
