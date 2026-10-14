import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { stated } from './helpers/agent.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

const directories: string[] = [];
// remove every isolated note store
afterEach(async () => {
  // delete every temporary directory
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

// exercise shared note access through both authenticated route families
describe('note all-workspace visibility API', () => {
  // share, mutate, isolate and delete one canonical note across workspace scopes
  it('supports cross-scope operations and validates authenticated visibility mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-visibility-api-'));
    directories.push(directory);
    const alpha = testWorktree({ id: 'alpha', projectId: 'alpha-project', label: 'Alpha', path: '/alpha', identity: '/alpha' });
    const beta = testWorktree({ id: 'beta', projectId: 'beta-project', label: 'Beta', path: '/beta', identity: '/beta' });
    const betaAgent = stated({ id: 'beta-agent', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', home: beta.path, title: 'Ready' });
    const discovery = {
      // expose both independent persistence scopes
      worktreesNow: () => [alpha, beta],
      // resolve the agent-route alias for beta
      target: async (id: string) => id === betaAgent.id ? { agent: betaAgent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      // avoid unrelated discovery work
      place: async () => undefined,
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [betaAgent], projects: [] })
    };
    const refresh = vi.fn(async () => ({ notesRevision: 0 }));
    const dashboardUpdates = { setLoader: () => {}, refresh, close: () => {} } as never;
    const server = await buildApp(testConfig({ projects: [
      testProject({ id: 'alpha-project', label: 'Alpha', path: '/alpha', identity: '/alpha/.git' }),
      testProject({ id: 'beta-project', label: 'Beta', path: '/beta', identity: '/beta/.git' })
    ] }), {
      auth,
      control,
      discovery: discovery as never,
      dashboardUpdates,
      notes: new WorktreeNoteService(join(directory, 'notes.json'))
    });
    try {
      const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
      const created = await server.inject({ method: 'POST', url: '/api/worktrees/alpha/notes', headers: mutateHeaders, payload: { title: 'Shared plan', text: 'Original', attachments: [attachment] } });
      const noteId = created.json().id as string;
      const worktreeVisibility = `/api/worktrees/alpha/notes/${noteId}/visibility`;
      const agentVisibility = `/api/agents/${betaAgent.id}/notes/${noteId}/visibility`;

      const unauthorized = await server.inject({ method: 'PUT', url: worktreeVisibility, headers: { host, origin: `https://${host}`, 'x-csrf-token': 'csrf' }, payload: { allWorkspaces: true } });
      const noCsrf = await server.inject({ method: 'PUT', url: worktreeVisibility, headers: { ...readHeaders, origin: `https://${host}` }, payload: { allWorkspaces: true } });
      const missingFlag = await server.inject({ method: 'PUT', url: worktreeVisibility, headers: mutateHeaders, payload: {} });
      expect(unauthorized.statusCode).toBe(401);
      expect(noCsrf.statusCode).toBe(403);
      expect(missingFlag.statusCode).toBe(400);

      const revisionCalls = refresh.mock.calls.length;
      const shared = await server.inject({ method: 'PUT', url: worktreeVisibility, headers: mutateHeaders, payload: { allWorkspaces: true } });
      expect(shared.statusCode).toBe(200);
      expect(shared.json()).toMatchObject({ id: noteId, allWorkspaces: true, visibleHere: true, attachments: [{ name: 'context.txt', size: 7 }] });
      await vi.waitFor(() => { expect(refresh.mock.calls.length).toBeGreaterThan(revisionCalls); });

      const betaWorktreeList = await server.inject({ method: 'GET', url: '/api/worktrees/beta/notes', headers: readHeaders });
      const betaAgentList = await server.inject({ method: 'GET', url: `/api/agents/${betaAgent.id}/notes`, headers: readHeaders });
      expect(betaWorktreeList.json().notes).toHaveLength(1);
      expect(betaAgentList.json().notes).toHaveLength(1);
      expect(betaAgentList.json().notes[0]).toMatchObject({ id: noteId, allWorkspaces: true });

      const beforeSharedEditRevision = refresh.mock.calls.length;
      const edited = await server.inject({ method: 'PUT', url: `/api/agents/${betaAgent.id}/notes/${noteId}`, headers: mutateHeaders, payload: { text: 'Edited from beta' } });
      await vi.waitFor(() => { expect(refresh.mock.calls.length).toBeGreaterThan(beforeSharedEditRevision); });
      const appended = await server.inject({ method: 'POST', url: `/api/worktrees/beta/notes/${noteId}/attachments`, headers: mutateHeaders, payload: { attachments: [{ name: 'extra.txt', data: Buffer.from('extra').toString('base64') }] } });
      const locked = await server.inject({ method: 'PUT', url: `/api/worktrees/beta/notes/${noteId}/lock`, headers: mutateHeaders, payload: { locked: true } });
      const refusedDelete = await server.inject({ method: 'DELETE', url: `/api/agents/${betaAgent.id}/notes/${noteId}`, headers: mutateHeaders });
      expect(edited.json()).toMatchObject({ text: 'Edited from beta', allWorkspaces: true });
      expect(appended.json().attachments).toEqual([{ name: 'context.txt', size: 7 }, { name: 'extra.txt', size: 5 }]);
      expect(locked.json()).toMatchObject({ locked: true, allWorkspaces: true });
      expect(refusedDelete.statusCode).toBe(409);
      await server.inject({ method: 'PUT', url: `/api/agents/${betaAgent.id}/notes/${noteId}/lock`, headers: mutateHeaders, payload: { locked: false } });

      const badAgentFlag = await server.inject({ method: 'PUT', url: agentVisibility, headers: mutateHeaders, payload: { allWorkspaces: 'false' } });
      const unshared = await server.inject({ method: 'PUT', url: agentVisibility, headers: mutateHeaders, payload: { allWorkspaces: false } });
      expect(badAgentFlag.statusCode).toBe(400);
      expect(unshared.statusCode).toBe(200);
      expect(unshared.json()).toMatchObject({ id: noteId, visibleHere: false, text: 'Edited from beta' });
      expect(unshared.json()).not.toHaveProperty('allWorkspaces');
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/beta/notes', headers: readHeaders })).json()).toEqual({ notes: [] });
      expect((await server.inject({ method: 'PUT', url: `/api/agents/${betaAgent.id}/notes/${noteId}`, headers: mutateHeaders, payload: { text: 'Hidden edit' } })).statusCode).toBe(404);
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/alpha/notes', headers: readHeaders })).json().notes[0]).toMatchObject({ id: noteId, text: 'Edited from beta' });

      await server.inject({ method: 'PUT', url: worktreeVisibility, headers: mutateHeaders, payload: { allWorkspaces: true } });
      const beforeDeleteRevision = refresh.mock.calls.length;
      const deleted = await server.inject({ method: 'DELETE', url: `/api/agents/${betaAgent.id}/notes/${noteId}`, headers: mutateHeaders });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ id: noteId, allWorkspaces: true, undoToken: expect.any(String) });
      await vi.waitFor(() => { expect(refresh.mock.calls.length).toBeGreaterThan(beforeDeleteRevision); });
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/alpha/notes', headers: readHeaders })).json()).toEqual({ notes: [] });

      const undoUrl = `/api/notes/deletions/${deleted.json().undoToken as string}/undo`;
      const unauthorizedUndo = await server.inject({ method: 'POST', url: undoUrl, headers: { host, origin: `https://${host}`, 'x-csrf-token': 'csrf' } });
      const noCsrfUndo = await server.inject({ method: 'POST', url: undoUrl, headers: { ...readHeaders, origin: `https://${host}` } });
      expect(unauthorizedUndo.statusCode).toBe(401);
      expect(noCsrfUndo.statusCode).toBe(403);

      const beforeUndoRevision = refresh.mock.calls.length;
      const restored = await server.inject({ method: 'POST', url: undoUrl, headers: mutateHeaders });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ id: noteId, text: 'Edited from beta', allWorkspaces: true, attachments: [{ name: 'context.txt', size: 7 }, { name: 'extra.txt', size: 5 }] });
      await vi.waitFor(() => { expect(refresh.mock.calls.length).toBeGreaterThan(beforeUndoRevision); });
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/alpha/notes', headers: readHeaders })).json().notes).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/beta/notes', headers: readHeaders })).json().notes).toHaveLength(1);
      expect((await server.inject({ method: 'POST', url: undoUrl, headers: mutateHeaders })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  }, 15_000);
});
