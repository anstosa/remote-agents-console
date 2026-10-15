// croner reads the process zone dynamically; pin it so the due-instant math is deterministic anywhere.
process.env.TZ = 'America/Los_Angeles';

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import type { PushMessage } from '../src/notifications.js';
import type { Schedule, ScheduleLastRun, ScheduleTarget } from '../src/schedule/types.js';
import type { Agent } from '../src/domain/models.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { appearingDiscovery, launchFake, recordingTmux, zeroPollDelay } from './helpers/run.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: '/repo', identity: '/repo', main: true });
const codexPane = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/repo', worktreeId: 'wt-main', title: 'Ready', kind: 'codex' as const };

// boot and settings-change both precede the Jan-5 due instant, so a tick at Jan-5 10:00 fires it once.
const bootPast = new Date('2026-01-01T00:00:00-08:00');
const oldUpdatedAt = '2026-01-01T00:00:00-08:00';
const tickNow = new Date('2026-01-05T10:00:00-08:00');
const dueInstant = '2026-01-05T17:00:00.000Z';

// a push recorder standing in for PushService.notify
function pushRecorder(): { messages: PushMessage[]; push: never } {
  const messages: PushMessage[] = [];
  return { messages, push: { notify: async (message: PushMessage) => { messages.push(message); }, enabled: false } as never };
}

// seed one Project-keyed scheduled note; `previousAgentId` records a prior Run so a tick can reuse its pane
async function seed(schedule: Partial<Schedule> & { target: ScheduleTarget }, options: { previousAgentId?: string; text?: string } = {}): Promise<{ notes: WorktreeNoteService; queued: QueuedPromptService; noteId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-schedule-tick-')); dirs.push(root);
  const notes = new WorktreeNoteService(join(root, 'notes.json'));
  const created = await notes.create('proj', 'Weekly report');
  const text = options.text ?? 'Draft the weekly report';
  if (text) await notes.update('proj', created!.id, text);
  await notes.setSchedule('proj', created!.id, { cron: '0 9 * * *', kind: 'codex', enabled: true, updatedAt: oldUpdatedAt, ...schedule });
  if (options.previousAgentId !== undefined) await notes.recordLastRun('proj', created!.id, { at: new Date(0).toISOString(), status: 'launched', agentId: options.previousAgentId });
  return { notes, queued: new QueuedPromptService(join(root, 'queue.json')), noteId: created!.id };
}

async function tickApp(deps: Record<string, unknown>, bootAt = bootPast) {
  return await buildApp(testConfig({ projects: [testProject({ id: 'proj' })] as never }), { auth, control, dashboardUpdates, launchPollDelay: zeroPollDelay, scheduleBootAt: bootAt, ...deps } as never);
}

const lastRunOf = async (notes: WorktreeNoteService, noteId: string) => (await notes.list('proj'))?.find(note => note.id === noteId)?.schedule?.lastRun;

// a discovery that resolves one live agent for the reconcile pass (no fresh launch this tick)
const staticDiscovery = (agent: Agent) => ({
  invalidateWorktrees: () => {},
  worktreesNow: () => [worktree],
  worktrees: async () => [worktree],
  dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] }),
  target: async (id: string) => (id === agent.id ? { agent, socket: testSocket } : undefined),
});

// seed a scheduled note already mid-managed-Run (lastRun.status === 'running'), so a tick reconciles it.
// startedAt defaults to now (reconcile measures elapsed against the wall clock), well inside the window.
async function seedRunning(lastRun: Partial<ScheduleLastRun> = {}): Promise<{ notes: WorktreeNoteService; queued: QueuedPromptService; noteId: string }> {
  const base = await seed({ target: { worktreeId: 'wt-main' } });
  await base.notes.recordLastRun('proj', base.noteId, { at: dueInstant, status: 'running', agentId: 'agent-1', startedAt: new Date().toISOString(), sawWorking: false, ...lastRun });
  return base;
}

const mutate = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const runNow = (noteId: string) => ({ method: 'POST' as const, url: `/api/worktrees/wt-main/notes/${noteId}/schedule/run`, headers: mutate });

describe('scheduler tick fires Schedules unattended', () => {
  it('launches fresh at the due instant, records running, pushes nothing, and does not re-fire', async () => {
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const discovery = appearingDiscovery({ worktree, agent: idle, socket: testSocket, working: () => submissions.length > 0 });
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const attachment = { name: 'scheduled.txt', data: Buffer.from('scheduled').toString('base64') };
    await notes.appendAttachments('proj', noteId, [attachment]);
    const tmux = recordingTmux();
    const launch = launchFake();
    const submissions: unknown[] = [];
    const prompts = { submit: async (_agentId: string, _text: string, attachments: unknown[]) => { submissions.push(attachments); return true; } };
    const server = await tickApp({ notes, queued, tmux, launch, discovery, push, prompts });
    try {
      await server.scheduler.tick(tickNow);
      const lastRun = await lastRunOf(notes, noteId);
      // a managed Run records `running` at the due instant with the watch anchors; it never reuses a pane
      expect(lastRun).toMatchObject({ at: dueInstant, status: 'running', agentId: 'agent-1', sawWorking: false });
      expect(typeof lastRun?.startedAt).toBe('string');
      expect(submissions).toEqual([[attachment]]);
      expect(tmux.pasted.some(text => text.trim() === '/new')).toBe(false);
      // a running Run stays quiet
      expect(messages).toEqual([]);
      // a second tick reconciles the running Run rather than launching a second agent
      await server.scheduler.tick(tickNow);
      expect(launch.kinds).toEqual(['codex']);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'running' });
    } finally { await server.close(); }
  }, 15_000);

  // both pastes (`/rename`, then the note) landed but tmux refused each Enter ("client is
  // read-only"), so the run sat unsent until the reconciler recorded it `completed`
  it('presses Enter again and fails the Run, keeping the pane, when the fresh agent never starts the note', async () => {
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const tmux = recordingTmux();
    const prompts = { submit: async () => true, beginAgentMutation: () => () => {} };
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery, push, prompts });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ at: dueInstant, status: 'failed' });
      expect(tmux.submits).toBeGreaterThan(1);
      // the unsent note stays visible in its pane, and the operator is told
      expect(tmux.closed).toEqual([]);
      expect(messages).toHaveLength(1);
    } finally { await server.close(); }
  }, 15_000);

  it('records running once a re-pressed Enter starts the note', async () => {
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket, working: () => tmux.submits > 0 });
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const prompts = { submit: async () => true, beginAgentMutation: () => () => {} };
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery, prompts });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'running', agentId: 'agent-1' });
      expect(tmux.submits).toBe(1);
    } finally { await server.close(); }
  }, 15_000);

  it('never pastes the note after a rename the fresh agent did not take', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'rac-schedule-rename-')); dirs.push(configDir);
    const savedConfigDir = process.env.RAC_CLAUDE_CONFIG_DIR;
    // no transcript is ever written, so the rename never reads back
    process.env.RAC_CLAUDE_CONFIG_DIR = configDir;
    const claude: Agent = { ...codexPane, kind: 'claude', conversationId: '11111111-2222-4333-8444-555555555555', attention: 'finished' };
    const discovery = { ...appearingDiscovery({ worktree, agent: claude, socket: testSocket }), conversationId: async () => claude.conversationId, paneDirectory: () => '/repo' };
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ kind: 'claude', target: { worktreeId: 'wt-main' } });
    const tmux = recordingTmux();
    const submitted: string[] = [];
    const prompts = { submit: async (_agentId: string, text: string) => { submitted.push(text); return true; }, beginAgentMutation: () => () => {} };
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery, push, prompts, conversationNamePollDelay: async () => {} });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'failed', detail: 'the agent did not accept input' });
      expect(tmux.pasted).toEqual([expect.stringMatching(/^\/rename ⏰ Weekly report — /u)]);
      expect(tmux.submits).toBe(3);
      expect(submitted).toEqual([]);
      expect(messages).toHaveLength(1);
    } finally {
      await server.close();
      if (savedConfigDir === undefined) delete process.env.RAC_CLAUDE_CONFIG_DIR; else process.env.RAC_CLAUDE_CONFIG_DIR = savedConfigDir;
    }
  }, 15_000);

  it('closes the pane and records completed once a managed Run has finished', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seedRunning({ sawWorking: true });
    const tmux = recordingTmux();
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery({ ...codexPane, attention: 'finished' }), push });
    try {
      await server.scheduler.tick(tickNow);
      const lastRun = await lastRunOf(notes, noteId);
      // the finished pane is closed and recorded completed, dropping the (now dead) agent id; a completed Run stays quiet
      expect(lastRun).toMatchObject({ at: dueInstant, status: 'completed' });
      expect(lastRun?.agentId).toBeUndefined();
      expect(tmux.closed).toEqual(['%1']);
      expect(messages).toEqual([]);
    } finally { await server.close(); }
  });

  it('closes the pane, records needs-input and notifies when a managed Run ends on a question', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seedRunning({ sawWorking: true });
    const tmux = recordingTmux();
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery({ ...codexPane, attention: 'question' }), push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ at: dueInstant, status: 'needs-input', detail: 'the run ended asking a question' });
      expect(tmux.closed).toEqual(['%1']);
      // the pane is closed, so the notification falls back to the Worktree deep-link
      expect(messages).toEqual([{ kind: 'schedule', title: 'Scheduled run needs input in Proj', body: 'Weekly report · the run ended asking a question', tag: `schedule-${noteId}`, url: '/#worktree=wt-main', worktreeId: 'wt-main' }]);
    } finally { await server.close(); }
  });

  it('records failed when the managed pane is gone before the run finished', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seedRunning({ sawWorking: true });
    // the remembered agent id resolves to nothing (a manual stop, crash, or restart that outlived it)
    const discovery = staticDiscovery({ ...codexPane, id: 'someone-else', attention: 'finished' });
    const server = await tickApp({ notes, queued, tmux: recordingTmux(), launch: launchFake(), discovery, push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'failed', detail: 'the agent was closed before the run finished' });
      expect(messages).toEqual([{ kind: 'schedule', title: 'Scheduled run failed in Proj', body: 'Weekly report · the agent was closed before the run finished', tag: `schedule-${noteId}`, url: '/#worktree=wt-main', worktreeId: 'wt-main' }]);
    } finally { await server.close(); }
  });

  it('closes the pane and records timed-out when a managed Run overruns the max', async () => {
    const { messages, push } = pushRecorder();
    const overran = new Date(Date.now() - 31 * 60 * 1_000).toISOString();
    const { notes, queued, noteId } = await seedRunning({ sawWorking: true, startedAt: overran });
    const tmux = recordingTmux();
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery({ ...codexPane, attention: 'working', title: '⠋ Working' }), push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'timed-out' });
      expect(tmux.closed).toEqual(['%1']);
      expect(messages[0]).toMatchObject({ kind: 'schedule', title: 'Scheduled run timed out in Proj' });
    } finally { await server.close(); }
  });

  it('flips sawWorking while a managed Run is still working, without closing it or notifying', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seedRunning({ sawWorking: false });
    const tmux = recordingTmux();
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery({ ...codexPane, attention: 'working', title: '⠋ Working' }), push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'running', sawWorking: true, agentId: 'agent-1' });
      expect(tmux.closed).toEqual([]);
      expect(messages).toEqual([]);
    } finally { await server.close(); }
  });

  it('pushes a schedule notification for a failed Run, deep-linking to the Worktree when there is no pane', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const server = await tickApp({ notes, queued, tmux: recordingTmux(), launch: launchFake({ refuse: true }), discovery, push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ at: dueInstant, status: 'failed', detail: 'launch refused' });
      expect(messages).toEqual([{ kind: 'schedule', title: 'Scheduled run failed in Proj', body: 'Weekly report · launch refused', tag: `schedule-${noteId}`, url: '/#worktree=wt-main', worktreeId: 'wt-main' }]);
    } finally { await server.close(); }
  });

  it('drops the closed pane id when a fresh launch is blocked, deep-linking the notification to the Worktree', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' }, kind: 'claude' });
    const claude: Agent = { id: 'agent-9', paneId: '%9', sessionId: 'socket:$9', socketFingerprint: 'socket', home: '/repo', worktreeId: 'wt-main', title: 'Ready', kind: 'claude', attention: 'finished' };
    const discovery = appearingDiscovery({ worktree, agent: claude, socket: testSocket });
    // Claude's readiness sees the Quick safety check dialog and blocks; runFresh then closes the pane
    const tmux = recordingTmux({ capture: () => 'Quick safety check: Is this a project you trust?' });
    const server = await tickApp({ notes, queued, tmux, launch: launchFake(), discovery, push });
    try {
      await server.scheduler.tick(tickNow);
      const lastRun = await lastRunOf(notes, noteId);
      expect(lastRun).toMatchObject({ at: dueInstant, status: 'failed' });
      // the created pane was torn down, so no dead agent id is remembered or deep-linked
      expect(lastRun?.agentId).toBeUndefined();
      expect(tmux.closed).toEqual(['%9']);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'schedule', title: 'Scheduled run failed in Proj', url: '/#worktree=wt-main', worktreeId: 'wt-main' });
    } finally { await server.close(); }
  }, 15_000);

  it('does not fire a Schedule whose updatedAt is still ahead of the tick', async () => {
    const { messages, push } = pushRecorder();
    // created at 9:30, after today's 9:00: its first run is tomorrow, so a 10:00 tick fires nothing
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' }, updatedAt: '2026-01-05T09:30:00-08:00' }, { previousAgentId: 'agent-1' });
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const discovery = appearingDiscovery({ worktree, agent: idle, socket: testSocket });
    const server = await tickApp({ notes, queued, tmux: recordingTmux(), launch: launchFake(), discovery, push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toMatchObject({ status: 'launched', agentId: 'agent-1', at: new Date(0).toISOString() });
      expect(messages).toEqual([]);
    } finally { await server.close(); }
  });

  it('never replays a missed instant after a fresh boot', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    // booted Jan-6 00:00, after the Jan-5 09:00 instant; a Jan-6 08:00 tick must not replay Jan-5
    const server = await tickApp({ notes, queued, tmux: recordingTmux(), launch: launchFake(), discovery, push }, new Date('2026-01-06T00:00:00-08:00'));
    try {
      await server.scheduler.tick(new Date('2026-01-06T08:00:00-08:00'));
      expect(await lastRunOf(notes, noteId)).toBeUndefined();
      expect(messages).toEqual([]);
    } finally { await server.close(); }
  });

  it('never fires a disabled Schedule', async () => {
    const { messages, push } = pushRecorder();
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' }, enabled: false });
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const server = await tickApp({ notes, queued, tmux: recordingTmux(), launch: launchFake(), discovery, push });
    try {
      await server.scheduler.tick(tickNow);
      expect(await lastRunOf(notes, noteId)).toBeUndefined();
      expect(messages).toEqual([]);
    } finally { await server.close(); }
  });

  it('skips a tick for a Schedule whose Run now is still in flight, via the shared flight guard', async () => {
    const { notes, queued, noteId } = await seed({ target: { worktreeId: 'wt-main' } });
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket, working: () => tmux.submits > 0 });
    // gate the fresh launch so Run now stays in flight (holding the shared flight key) while we tick
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
    const launched: string[] = [];
    const launch = { launch: async (_id: string, kind?: string) => { launched.push(kind ?? 'codex'); await launchGate; return true; }, launchProjectDirectory: async () => true, launchHome: async () => true, isLaunchableKind: () => true };
    const server = await tickApp({ notes, queued, tmux, launch, discovery });
    try {
      const runNowResponse = server.inject(runNow(noteId));
      // wait until Run now has entered the (gated) launch, so its flight key is held
      await expect.poll(() => launched.length).toBe(1);
      // a tick for the same Schedule must see the in-flight guard and not launch a second agent
      await server.scheduler.tick(tickNow);
      expect(launched).toEqual(['codex']);
      releaseLaunch();
      expect((await runNowResponse).json().schedule.lastRun).toMatchObject({ status: 'launched' });
    } finally { await server.close(); }
  }, 15_000);
});
