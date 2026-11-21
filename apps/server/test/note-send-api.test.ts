import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { promptScope, QueuedPromptService } from '../src/prompts/queue.js';
import type { PromptAttachment } from '../src/prompts/service.js';
import type { Agent } from '../src/domain/models.js';
import { stated } from './helpers/agent.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { recordingTmux } from './helpers/run.js';

const dirs: string[] = [];
// remove each isolated note and queue store
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;
const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: '/repo', identity: '/repo', main: true });

type Fixture = { notes: WorktreeNoteService; queued: QueuedPromptService; noteId: string; text: string };

// create one note and its isolated durable prompt queue
async function fixture(attachments: PromptAttachment[] = []): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rac-note-send-'));
  dirs.push(root);
  const notes = new WorktreeNoteService(join(root, 'notes.json'));
  const text = 'Draft the weekly report';
  const note = await notes.createWithText('proj', 'Weekly report', text, undefined, attachments);
  return { notes, queued: new QueuedPromptService(join(root, 'queue.json')), noteId: note!.id, text };
}

// expose one target agent and its worktree to prompt and note resolution
function discoveryFor(agent: Agent) {
  return {
    invalidateWorktrees: () => {},
    projectsNow: () => [testProject({ id: 'proj' })],
    worktreesNow: () => [worktree],
    worktrees: async () => [worktree],
    dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] }),
    target: async (id: string) => id === agent.id ? { agent, socket: testSocket } : undefined,
  };
}

// build the authenticated route over caller-owned stores and prompt behavior
async function sendApp(options: Fixture & { autoDeleteSentNotes: boolean; prompts?: unknown; agent?: Agent; tmux?: unknown }) {
  const agent = options.agent ?? stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', worktreeId: 'wt-main', title: 'Ready' });
  return await buildApp(testConfig({ autoDeleteSentNotes: options.autoDeleteSentNotes, projects: [testProject({ id: 'proj' })] }), {
    auth,
    control,
    dashboardUpdates,
    notes: options.notes,
    queuedPrompts: options.queued,
    discovery: discoveryFor(agent),
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.tmux === undefined ? {} : { tmux: options.tmux }),
  } as never);
}

// post the note through the regular agent prompt boundary
const send = (noteId: string, prompt: string, attachments: PromptAttachment[] = []) => ({
  method: 'POST' as const,
  url: '/api/agents/agent-1/prompt',
  headers: mutate,
  payload: { prompt, attachments, noteId },
});

describe('POST /api/agents/:id/prompt note cleanup', () => {
  // prove immediate delivery consumes the note and exposes a working undo token
  it('deletes an unlocked matching note after direct delivery and restores it through undo', async () => {
    const stores = await fixture();
    const tmux = recordingTmux();
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, tmux });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deletedNote: { id: stores.noteId, undoToken: expect.any(String) } });
      expect(tmux.pasted.some(prompt => prompt.includes(stores.text))).toBe(true);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toBeUndefined();

      const restored = await server.inject({ method: 'POST', url: `/api/notes/deletions/${response.json().deletedNote.undoToken as string}/undo`, headers: mutate });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ id: stores.noteId, text: stores.text });
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: stores.text } });
    } finally {
      await server.close();
    }
  }, 15_000);

  // prove durable queue admission is accepted delivery for cleanup purposes
  it('deletes an unlocked matching note after it is queued behind active work', async () => {
    const stores = await fixture();
    const agent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', worktreeId: 'wt-main', title: '⠋ Working', attention: 'working' });
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, agent, tmux: recordingTmux() });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deletedNote: { id: stores.noteId, undoToken: expect.any(String) } });
      await expect(stores.queued.list(promptScope(agent.id))).resolves.toMatchObject([{ text: stores.text }]);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  }, 15_000);

  // keep the legacy response and note when cleanup is disabled
  it('returns 204 and keeps the note when the setting is off', async () => {
    const stores = await fixture();
    const submit = vi.fn(async () => true);
    const server = await sendApp({ ...stores, autoDeleteSentNotes: false, prompts: { submit } });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(204);
      expect(submit).toHaveBeenCalledExactlyOnceWith('agent-1', stores.text, []);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId } });
    } finally {
      await server.close();
    }
  });

  // ordinary prompts never infer a note from matching content alone
  it('returns 204 and keeps matching notes when the request has no note id', async () => {
    const stores = await fixture();
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => true } });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers: mutate, payload: { prompt: stores.text, attachments: [] } });
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: stores.text } });
    } finally {
      await server.close();
    }
  });

  // a private note id from another workspace is not a valid prompt origin
  it('returns 204 and keeps a matching private note from another workspace', async () => {
    const stores = await fixture();
    const privateNote = await stores.notes.createWithText('other', 'Private report', stores.text);
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => true } });
    try {
      const response = await server.inject(send(privateNote!.id, stores.text));
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('other', privateNote!.id)).resolves.toMatchObject({ note: { id: privateNote!.id, text: stores.text } });
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: stores.text } });
    } finally {
      await server.close();
    }
  });

  // locked notes are never cleanup candidates
  it('returns 204 and keeps a locked matching note', async () => {
    const stores = await fixture();
    await stores.notes.setLocked('proj', stores.noteId, true);
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => true } });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, locked: true } });
    } finally {
      await server.close();
    }
  });

  // stale text must not consume the current draft
  it('returns 204 and keeps the note when the sent text does not match', async () => {
    const stores = await fixture();
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => true } });
    try {
      const response = await server.inject(send(stores.noteId, 'An edited prompt'));
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: stores.text } });
    } finally {
      await server.close();
    }
  });

  // stale files must not consume the current draft
  it('returns 204 and keeps the note when the sent files do not match', async () => {
    const saved = { name: 'context.txt', data: Buffer.from('saved').toString('base64') };
    const sent = { name: 'context.txt', data: Buffer.from('changed').toString('base64') };
    const stores = await fixture([saved]);
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => true } });
    try {
      const response = await server.inject(send(stores.noteId, stores.text, [sent]));
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, attachments: [saved] } });
    } finally {
      await server.close();
    }
  });

  // a rejected dispatch must leave the source note untouched
  it('returns 404 and keeps the note when prompt submission is refused', async () => {
    const stores = await fixture();
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit: async () => false } });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(404);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: stores.text } });
    } finally {
      await server.close();
    }
  });

  // an edit landing during submission wins over automatic cleanup
  it('returns 204 and keeps a note changed while prompt submission is in flight', async () => {
    const stores = await fixture();
    const submit = vi.fn(async () => {
      await stores.notes.update('proj', stores.noteId, 'Newer draft');
      return true;
    });
    const server = await sendApp({ ...stores, autoDeleteSentNotes: true, prompts: { submit } });
    try {
      const response = await server.inject(send(stores.noteId, stores.text));
      expect(response.statusCode).toBe(204);
      await expect(stores.notes.resolve('proj', stores.noteId)).resolves.toMatchObject({ note: { id: stores.noteId, text: 'Newer draft' } });
    } finally {
      await server.close();
    }
  });
});
