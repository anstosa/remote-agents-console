import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { stated } from './helpers/agent.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const read = { host, cookie: '__Host-rac=x' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: '/repo', identity: '/repo', main: true });
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const scratchAgent = stated({ id: 'agent-scratch', pane: { paneId: '%3', sessionId: 'socket:$3', socketFingerprint: 'socket' }, home: '/home/user/scratch', title: 'Ready' });

const discoveryStub = () => ({
  invalidateWorktrees: () => {},
  worktreesNow: () => [worktree],
  projectsNow: () => [],
  worktrees: async () => [worktree],
  place: async () => undefined,
  target: async (id: string) => id === scratchAgent.id ? { agent: scratchAgent, socket } : undefined,
  dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [scratchAgent], projects: [] }),
}) as never;

async function notesService(): Promise<WorktreeNoteService> {
  const root = await mkdtemp(join(tmpdir(), 'rac-schedule-api-')); dirs.push(root);
  return new WorktreeNoteService(join(root, 'notes.json'));
}

async function app(deps: Record<string, unknown>) {
  const projects = [testProject({ id: 'proj' }), testProject({ id: 'notes-dir', mode: 'directory', available: true }), testProject({ id: 'gone-dir', mode: 'directory', available: false })];
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects }), { auth, control, dashboardUpdates, discovery: discoveryStub(), ...deps } as never);
}

const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true };

describe('worktree note Schedules', () => {
  it('sets, decorates with nextRun, replaces, and removes a Schedule', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      const created = await server.inject({ method: 'POST', url: '/api/worktrees/wt-main/notes', headers: mutate, payload: { title: 'Morning triage' } });
      const noteId = created.json().id as string;

      const set = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${noteId}/schedule`, headers: mutate, payload: daily });
      expect(set.statusCode).toBe(200);
      const body = set.json();
      expect(body.schedule).toMatchObject({ cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
      expect(typeof body.schedule.updatedAt).toBe('string');
      expect(new Date(body.nextRun as string).getTime()).toBeGreaterThan(Date.now());

      // pausing keeps a computed nextRun (the web renders "would next run")
      const paused = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${noteId}/schedule`, headers: mutate, payload: { ...daily, enabled: false } });
      expect(paused.json().schedule.enabled).toBe(false);
      expect(typeof paused.json().nextRun).toBe('string');

      const removed = await server.inject({ method: 'DELETE', url: `/api/worktrees/wt-main/notes/${noteId}/schedule`, headers: mutate });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().schedule).toBeUndefined();
      expect(removed.json().nextRun).toBeUndefined();

      const listed = await server.inject({ method: 'GET', url: '/api/worktrees/wt-main/notes', headers: read });
      const [listedNote] = listed.json().notes;
      expect(listedNote.id).toBe(noteId);
      expect(listedNote.schedule).toBeUndefined();
    } finally { await server.close(); }
  });

  it('decorates a listed scheduled note with nextRun', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      const created = await server.inject({ method: 'POST', url: '/api/worktrees/wt-main/notes', headers: mutate });
      const noteId = created.json().id as string;
      await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${noteId}/schedule`, headers: mutate, payload: daily });
      const listed = await server.inject({ method: 'GET', url: '/api/worktrees/wt-main/notes', headers: read });
      const [note] = listed.json().notes;
      expect(note.schedule.cron).toBe('0 9 * * *');
      expect(new Date(note.nextRun as string).getTime()).toBeGreaterThan(Date.now());
    } finally { await server.close(); }
  });

  it('accepts an available directory-Project target', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      const created = await server.inject({ method: 'POST', url: '/api/worktrees/wt-main/notes', headers: mutate });
      const noteId = created.json().id as string;
      const set = await server.inject({ method: 'PUT', url: `/api/worktrees/wt-main/notes/${noteId}/schedule`, headers: mutate, payload: { ...daily, target: { projectId: 'notes-dir' } } });
      expect(set.statusCode).toBe(200);
      expect(set.json().schedule.target).toEqual({ projectId: 'notes-dir' });
    } finally { await server.close(); }
  });

  it('rejects a bad cron, unknown kind, and unresolvable targets', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      const created = await server.inject({ method: 'POST', url: '/api/worktrees/wt-main/notes', headers: mutate });
      const noteId = created.json().id as string;
      const url = `/api/worktrees/wt-main/notes/${noteId}/schedule`;
      const badCron = await server.inject({ method: 'PUT', url, headers: mutate, payload: { ...daily, cron: '0 99 * * *' } });
      expect(badCron.statusCode).toBe(400);
      expect(badCron.json().error).toMatch(/hour/i);
      expect((await server.inject({ method: 'PUT', url, headers: mutate, payload: { ...daily, kind: 'nope' } })).statusCode).toBe(400);
      // an unresolvable target is refused with an operator-facing reason, not just a status
      const ghost = await server.inject({ method: 'PUT', url, headers: mutate, payload: { ...daily, target: { worktreeId: 'ghost' } } });
      expect(ghost.statusCode).toBe(400);
      expect(ghost.json().error).toMatch(/worktree/i);
      const repo = await server.inject({ method: 'PUT', url, headers: mutate, payload: { ...daily, target: { projectId: 'proj' } } }); // repository, not a directory
      expect(repo.statusCode).toBe(400);
      expect(repo.json().error).toMatch(/project/i);
      const goneDir = await server.inject({ method: 'PUT', url, headers: mutate, payload: { ...daily, target: { projectId: 'gone-dir' } } });
      expect(goneDir.statusCode).toBe(400);
      expect(goneDir.json().error).toMatch(/project/i);
    } finally { await server.close(); }
  });

  it('404s an unknown note and an unknown worktree', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      expect((await server.inject({ method: 'PUT', url: '/api/worktrees/wt-main/notes/note-identifier-000/schedule', headers: mutate, payload: daily })).statusCode).toBe(404);
      expect((await server.inject({ method: 'PUT', url: '/api/worktrees/ghost/notes/note-identifier-000/schedule', headers: mutate, payload: daily })).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});

describe('live agent note Schedules', () => {
  it('sets a Schedule under the Scratch note key', async () => {
    const notes = await notesService();
    const server = await app({ notes });
    try {
      const created = await server.inject({ method: 'POST', url: `/api/agents/${scratchAgent.id}/notes`, headers: mutate });
      const noteId = created.json().id as string;
      const set = await server.inject({ method: 'PUT', url: `/api/agents/${scratchAgent.id}/notes/${noteId}/schedule`, headers: mutate, payload: { ...daily, target: { scratch: true } } });
      expect(set.statusCode).toBe(200);
      expect(set.json().schedule.target).toEqual({ scratch: true });
    } finally { await server.close(); }
  });
});

describe('GET /api/schedule/preview', () => {
  it('returns three chained instants and 400s an invalid expression', async () => {
    const server = await app({ notes: await notesService() });
    try {
      const preview = await server.inject({ method: 'GET', url: `/api/schedule/preview?cron=${encodeURIComponent('0 9 * * *')}`, headers: read });
      expect(preview.statusCode).toBe(200);
      const next = preview.json().next as string[];
      expect(next).toHaveLength(3);
      expect(new Date(next[0]).getTime()).toBeLessThan(new Date(next[1]).getTime());
      const bad = await server.inject({ method: 'GET', url: `/api/schedule/preview?cron=${encodeURIComponent('nope')}`, headers: read });
      expect(bad.statusCode).toBe(400);
    } finally { await server.close(); }
  });
});
