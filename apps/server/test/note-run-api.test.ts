import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import type { Agent } from '../src/domain/models.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { stated } from './helpers/agent.js';
import { appearingDiscovery, launchFake, recordingTmux, zeroPollDelay } from './helpers/run.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: '/repo', identity: '/repo', main: true });
const codexAgent = () => stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', worktreeId: 'wt-main', title: 'Ready' });
const claudeAgent = (): Agent => ({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', worktreeId: 'wt-main', title: 'Ready', kind: 'claude', attention: 'finished' });

async function stores(): Promise<{ notes: WorktreeNoteService; queued: QueuedPromptService; noteId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-note-run-')); dirs.push(root);
  const notes = new WorktreeNoteService(join(root, 'notes.json'));
  const created = await notes.create('proj');
  await notes.update('proj', created!.id, 'Draft the weekly report');
  return { notes, queued: new QueuedPromptService(join(root, 'queue.json')), noteId: created!.id };
}

async function runApp({ queued, autoDeleteSentNotes = false, ...deps }: Record<string, unknown>) {
  // pass the per-test queue under the key buildApp reads, so tests never share the default file
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), autoDeleteSentNotes: autoDeleteSentNotes === true, projects: [testProject({ id: 'proj' })] }), { auth, control, dashboardUpdates, launchPollDelay: zeroPollDelay, queuedPrompts: queued, ...deps } as never);
}

const run = (noteId: string, worktreeId = 'wt-main', kind = 'codex') =>
  ({ method: 'POST' as const, url: `/api/worktrees/${worktreeId}/notes/${noteId}/run`, headers: mutate, payload: { kind } });

describe('POST /api/worktrees/:id/notes/:noteId/run', () => {
  // launch attachment-only notes through the normal staged prompt path
  it('launches and runs an attachment-only note with its staged file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-note-run-attachments-')); dirs.push(root);
    const localWorktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: root, identity: root, main: true });
    const localAgent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: root, worktreeId: 'wt-main', title: 'Ready' });
    const notes = new WorktreeNoteService(join(root, 'notes.json'));
    const attachment = { name: 'context.txt', data: Buffer.from('attachment body').toString('base64') };
    const note = await notes.createWithText('proj', 'Files only', '', undefined, [attachment]);
    const queued = new QueuedPromptService(join(root, 'queue.json'));
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree: localWorktree, agent: localAgent, socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(run(note!.id));
      expect(response.statusCode).toBe(201);
      expect(tmux.pasted.some(text => /Attached files:\n@node_modules\/\.remote-agent-console\/attachments\/.+\/context\.txt /u.test(text))).toBe(true);
    } finally {
      await server.close();
    }
  }, 15_000);

  it('launches, waits for readiness, pastes the note, and returns the new agent id', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux();
    const launch = launchFake();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: 'agent-1' });
      await expect(notes.resolve('proj', noteId)).resolves.toMatchObject({ note: { id: noteId } });
      // the requested kind reached the launch handoff
      expect(launch.kinds).toEqual(['codex']);
      // the note's saved text was pasted (only reachable once readiness passed)
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  // consume a successful manual run and return an undoable deletion receipt
  it('deletes an unlocked note after a successful manual run and restores it through undo', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery, autoDeleteSentNotes: true });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: 'agent-1', deletedNote: { id: noteId, undoToken: expect.any(String) } });
      await expect(notes.resolve('proj', noteId)).resolves.toBeUndefined();

      const restored = await server.inject({ method: 'POST', url: `/api/notes/deletions/${response.json().deletedNote.undoToken as string}/undo`, headers: mutate });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ id: noteId, text: 'Draft the weekly report' });
      await expect(notes.resolve('proj', noteId)).resolves.toMatchObject({ note: { id: noteId } });
    } finally {
      await server.close();
    }
  }, 15_000);

  // preserve locked notes after the same successful manual run
  it('keeps a locked note after a successful manual run', async () => {
    const { notes, queued, noteId } = await stores();
    await notes.setLocked('proj', noteId, true);
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery, autoDeleteSentNotes: true });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: 'agent-1' });
      await expect(notes.resolve('proj', noteId)).resolves.toMatchObject({ note: { id: noteId, locked: true } });
    } finally {
      await server.close();
    }
  }, 15_000);

  // scheduled runs update their note instead of consuming it
  it('keeps a scheduled note after a successful scheduled launch when cleanup is enabled', async () => {
    const { notes, queued, noteId } = await stores();
    await notes.setSchedule('proj', noteId, { cron: '0 9 * * *', kind: 'codex', enabled: true, updatedAt: new Date().toISOString(), target: { worktreeId: 'wt-main' } });
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery, autoDeleteSentNotes: true });
    try {
      const response = await server.inject({ method: 'POST', url: `/api/worktrees/wt-main/notes/${noteId}/schedule/run`, headers: mutate });
      expect(response.statusCode).toBe(200);
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      await expect(notes.resolve('proj', noteId)).resolves.toMatchObject({ note: { id: noteId, schedule: { lastRun: { status: 'launched' } } } });
    } finally {
      await server.close();
    }
  }, 15_000);

  it('launches with the worktree default kind when the request omits one (the fly-out path)', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux();
    const launch = launchFake();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      // the shipping client posts no body, so the launch handoff receives an undefined kind
      const response = await server.inject({ method: 'POST', url: `/api/worktrees/wt-main/notes/${noteId}/run`, headers: mutate });
      expect(response.statusCode).toBe(201);
      expect(launch.kinds).toEqual([undefined]);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('waits for a Claude launch to report its session, then pastes the note', async () => {
    const { notes, queued, noteId } = await stores();
    // Claude is ready only once its pane reports a conversation id; no safety check on screen
    const tmux = recordingTmux({ capture: () => 'Ready to help.' });
    const launch = launchFake();
    const agent: Agent = { ...claudeAgent(), conversationId: 'conv-123' };
    const discovery = appearingDiscovery({ worktree, agent, socket: testSocket, working: () => tmux.submits > 0 });
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      const response = await server.inject(run(noteId, 'wt-main', 'claude'));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: 'agent-1' });
      expect(tmux.closed).toEqual([]);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('rejects an unknown kind before any handoff', async () => {
    const { notes, queued, noteId } = await stores();
    const launch = launchFake();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket });
    const server = await runApp({ notes, queued, tmux: recordingTmux(), launch, discovery });
    try {
      const response = await server.inject({ ...run(noteId), payload: { kind: 'nope' } });
      expect(response.statusCode).toBe(400);
      expect(launch.kinds).toEqual([]);
    } finally { await server.close(); }
  });

  it('409s a refused launch', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket });
    const server = await runApp({ notes, queued, tmux, launch: launchFake({ refuse: true }), discovery, autoDeleteSentNotes: true });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Could not start/i);
      expect(tmux.pasted).toEqual([]);
      await expect(notes.resolve('proj', noteId)).resolves.toMatchObject({ note: { id: noteId } });
    } finally { await server.close(); }
  });

  it('504s when no agent appears', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket, appearAfter: Infinity });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(504);
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  }, 15_000);

  it('409s and closes the pane when readiness is blocked, never pasting', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux({ capture: () => 'Quick safety check: Is this a project you trust?' });
    const discovery = appearingDiscovery({ worktree, agent: claudeAgent(), socket: testSocket });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(run(noteId, 'wt-main', 'claude'));
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/safety check/i);
      // the Run's pane is torn down and nothing was pasted into it
      expect(tmux.closed).toEqual(['%1']);
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  }, 15_000);

  it('504s and closes the pane when readiness never settles, never pasting', async () => {
    const { notes, queued, noteId } = await stores();
    const tmux = recordingTmux({ capture: () => 'model: loading' });
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(run(noteId));
      expect(response.statusCode).toBe(504);
      expect(tmux.closed).toEqual(['%1']);
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  }, 15_000);

  it('404s an unknown worktree and an unknown note, and 400s an empty note', async () => {
    const { notes, queued, noteId } = await stores();
    const empty = await notes.create('proj');
    const discovery = appearingDiscovery({ worktree, agent: codexAgent(), socket: testSocket });
    const server = await runApp({ notes, queued, tmux: recordingTmux(), launch: launchFake(), discovery });
    try {
      expect((await server.inject(run(noteId, 'ghost'))).statusCode).toBe(404);
      expect((await server.inject(run('note-identifier-000'))).statusCode).toBe(404);
      expect((await server.inject(run(empty!.id))).statusCode).toBe(400);
    } finally { await server.close(); }
  });
});
