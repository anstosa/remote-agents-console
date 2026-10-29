import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { dashboardFingerprint, DashboardUpdates, type DashboardPayload } from '../src/dashboard/updates.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { stated } from './helpers/agent.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

const directories: string[] = [];
// clean every isolated note store
afterEach(async () => {
  // remove every test directory
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const host = 'agents.example.com';
const readHeaders = { host, cookie: '__Host-rac=session' };
const mutateHeaders = { ...readHeaders, origin: `https://${host}`, 'x-csrf-token': 'csrf' };
const auth = {
  // accept only the fixture session cookie
  unsign: (cookie: string | undefined) => cookie === 'session' ? 'session' : undefined,
  // resolve only the fixture session
  get: (id: string | undefined) => id === 'session' ? { id: 'session', csrf: 'csrf' } : undefined,
  // require the fixture mutation token
  csrf: (_session: unknown, token: string | undefined) => token === 'csrf'
} as never;
// report the controlled tmux connection as available
const control = { connect: () => true } as never;

// exercise deletion protection through authenticated routes
describe('note deletion lock API', () => {
  // enforce durable locks through both project and scratch persistence routes
  it('locks, notifies, refuses deletion, unlocks, and validates mutation authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-lock-api-'));
    directories.push(directory);
    const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', path: '/repo', identity: '/repo' });
    const scratch = stated({ id: 'scratch-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/scratch', title: 'Ready' });
    const discovery = {
      // expose one project persistence scope
      worktreesNow: () => [worktree],
      // resolve only the scratch note route's live agent
      target: async (id: string) => id === scratch.id ? { agent: scratch, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      // isolate note revisions from discovery changes
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] })
    };
    const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
    const revisions: Array<number | undefined> = [];
    // record every published note revision
    dashboardUpdates.subscribe(snapshot => { revisions.push(snapshot.notesRevision); });
    const server = await buildApp(testConfig({ projects: [testProject({ id: 'proj', path: '/repo', identity: '/repo/.git' })] }), {
      auth,
      control,
      discovery: discovery as never,
      dashboardUpdates,
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      await dashboardUpdates.refresh();
      expect(revisions.at(-1)).toEqual(expect.any(Number));
      // require each confirmed lock change to publish a fresh opaque revision
      const setLock = async (url: string, locked: boolean) => {
        const previousRevision = revisions.at(-1);
        const response = await server.inject({ method: 'PUT', url, headers: mutateHeaders, payload: { locked } });
        expect(response.statusCode).toBe(200);
        await vi.waitFor(() => { expect(revisions.at(-1)).not.toBe(previousRevision); });
        return response;
      };
      const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
      const worktreeCreated = await server.inject({ method: 'POST', url: '/api/worktrees/wt-main/notes', headers: mutateHeaders, payload: { title: 'Project note', text: 'Keep me', attachments: [attachment] } });
      const scratchCreated = await server.inject({ method: 'POST', url: '/api/agents/scratch-1/notes', headers: mutateHeaders, payload: { title: 'Scratch note', text: 'Keep me too' } });
      const worktreeId = worktreeCreated.json().id as string;
      const scratchId = scratchCreated.json().id as string;

      const unauthorized = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${worktreeId}/lock`, headers: { host, origin: `https://${host}`, 'x-csrf-token': 'csrf' }, payload: { locked: true } });
      const noCsrf = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${worktreeId}/lock`, headers: { ...readHeaders, origin: `https://${host}` }, payload: { locked: true } });
      const missingFlag = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${worktreeId}/lock`, headers: mutateHeaders, payload: {} });
      const stringFlag = await server.inject({ method: 'PUT', url: `/api/agents/scratch-1/notes/${scratchId}/lock`, headers: mutateHeaders, payload: { locked: 'true' } });
      expect(unauthorized.statusCode).toBe(401);
      expect(noCsrf.statusCode).toBe(403);
      expect(missingFlag.statusCode).toBe(400);
      expect(stringFlag.statusCode).toBe(400);

      const worktreeLocked = await setLock(`/api/worktrees/wt-main/notes/${worktreeId}/lock`, true);
      const scratchLocked = await setLock(`/api/agents/scratch-1/notes/${scratchId}/lock`, true);
      expect(worktreeLocked.json()).toMatchObject({ id: worktreeId, text: 'Keep me', locked: true, attachments: [{ name: 'context.txt', size: 7 }] });
      expect(scratchLocked.json()).toMatchObject({ id: scratchId, text: 'Keep me too', locked: true });

      const worktreeDelete = await server.inject({ method: 'DELETE', url: `/api/worktrees/wt-main/notes/${worktreeId}`, headers: mutateHeaders });
      const scratchDelete = await server.inject({ method: 'DELETE', url: `/api/agents/scratch-1/notes/${scratchId}`, headers: mutateHeaders });
      expect(worktreeDelete.statusCode).toBe(409);
      expect(scratchDelete.statusCode).toBe(409);

      const worktreeUnlocked = await setLock(`/api/worktrees/wt-main/notes/${worktreeId}/lock`, false);
      const scratchUnlocked = await setLock(`/api/agents/scratch-1/notes/${scratchId}/lock`, false);
      expect(worktreeUnlocked.json()).not.toHaveProperty('locked');
      expect(scratchUnlocked.json()).not.toHaveProperty('locked');
      expect((await server.inject({ method: 'DELETE', url: `/api/worktrees/wt-main/notes/${worktreeId}`, headers: mutateHeaders })).statusCode).toBe(200);
      expect((await server.inject({ method: 'DELETE', url: `/api/agents/scratch-1/notes/${scratchId}`, headers: mutateHeaders })).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  }, 15_000);
});
