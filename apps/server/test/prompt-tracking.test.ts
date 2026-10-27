import { randomBytes } from 'node:crypto';
import { AuthStore, ActivityStore } from '../src/google-calendar/store.js';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { AttentionState, CompletionEvent } from '../src/adapters/types.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService } from '../src/prompts/service.js';
import { GoogleCalendarLifecycle } from '../src/google-calendar/lifecycle.js';
import * as tmuxCommand from '../src/tmux/command.js';
import type { CalendarSignal } from '../src/google-calendar/contracts.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };
const directories: string[] = [];

// create one mutable discovered agent
const testAgent = (kind: 'codex' | 'claude', home: string, attention: AttentionState = 'finished') => ({
  id: 'socket:%1',
  paneId: '%1',
  sessionId: 'socket:$1',
  socketFingerprint: 'socket',
  home,
  title: attention === 'working' ? 'Working' : 'Ready',
  attention,
  kind
});

// remove isolated queue files
afterEach(async () => {
  // clean every fixture directory
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// exercise exact request identity independently of button orchestration
describe('tracked prompt lifecycle', () => {
  // keep a tracked prompt bound past unrelated work and human waits
  it('completes only its own Codex rollout after queued dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-tracking-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('codex', directory, 'working');
    const terminal = new Map<number, CompletionEvent>();
    let ordinal = 0;
    const discovery = {
      worktreesNow: () => [],
      target: async () => ({ agent, socket }),
      paneProcessId: () => 42,
      agentProcessId: () => process.pid
    };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› Ready',
      sendKeys: async () => true
    };
    const adapter = {
      ...codexAdapter,
      // avoid composer polling in this lifecycle-focused fixture
      submission: {
        prepare: (prompt: string) => ({ text: prompt, keys: ['Enter'] as const }),
        interrupt: ['C-c'] as const,
        selectOption: () => ['Enter'] as const
      },
      completion: {
        baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: ++ordinal }),
        since: async (baseline: { ordinal: number }) => terminal.get(baseline.ordinal) ?? { kind: 'pending' as const }
      }
    };
    const calendar = {
      admit: async () => undefined, beforeSend: async () => ({}),
      pending: async () => [], observe: async () => undefined,
      missing: async () => undefined, invalid: async () => undefined, handOver: async () => undefined
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => adapter as never, undefined, undefined, calendar);

    const tracked = await service.submitTracked(agent.id, 'same prompt');
    expect(tracked).toBeDefined();
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'queued', submitted: false });

    // complete only the unrelated adopted turn
    terminal.set(1, { kind: 'completed', ordinal: 2, answer: 'unrelated answer' });
    agent.attention = 'finished';
    await service.observe(agent as never);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'running', submitted: true });

    // retain loading through working and question states
    agent.attention = 'working';
    await service.observe(agent as never);
    agent.attention = 'question';
    await service.observe(agent as never);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'running', submitted: true });

    // reject an idle transition without this rollout's terminal event
    agent.attention = 'finished';
    await service.observe(agent as never);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'running', submitted: true });

    // settle only the exact post-submit baseline
    terminal.set(2, { kind: 'completed', ordinal: 3, answer: 'tracked answer' });
    await service.observe(agent as never);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'complete', submitted: true });
  });

  // map an exact structured abort to terminal failure
  it('fails the tracked Codex request on its rollout abort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-abort-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('codex', directory);
    let aborted = false;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 42 };
    const tmux = { pastePrompt: async () => true, capture: async () => '› Ready', sendKeys: async () => true };
    const adapter = {
      ...codexAdapter,
      // avoid composer polling in this lifecycle-focused fixture
      submission: {
        prepare: (prompt: string) => ({ text: prompt, keys: ['Enter'] as const }),
        interrupt: ['C-c'] as const,
        selectOption: () => ['Enter'] as const
      },
      completion: {
        baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: 7 }),
        since: async () => aborted ? { kind: 'aborted' as const, ordinal: 8 } : { kind: 'pending' as const }
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => adapter as never);

    const tracked = await service.submitTracked(agent.id, 'abort this prompt');
    agent.attention = 'working';
    await service.observe(agent as never);
    aborted = true;
    agent.attention = 'finished';
    await service.observe(agent as never);

    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'failed', submitted: true, error: 'prompt_failed' });
  });

  // map an operator interrupt to the exact active request
  it('interrupts only the tracked request in the active phase', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-interrupt-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory);
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = { pastePrompt: async () => true, sendKeys: async () => true, setReportedAttention: async () => true };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => claudeAdapter);

    const tracked = await service.submitTracked(agent.id, 'interrupt this prompt');
    agent.attention = 'working';
    await expect(service.cancel(agent.id)).resolves.toBe('ok');

    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'interrupted', submitted: true, error: 'prompt_interrupted' });
  });

  // preserve distinct identities for duplicate text
  it('tracks identical queued prompts independently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-duplicates-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('codex', directory, 'working');
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const service = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, queue);

    const first = await service.submitTracked(agent.id, 'duplicate bytes');
    const second = await service.submitTracked(agent.id, 'duplicate bytes');

    expect(first?.requestId).toBeDefined();
    expect(second?.requestId).toBeDefined();
    expect(first?.requestId).not.toBe(second?.requestId);
    expect(service.requestStatus(first!.requestId)).toMatchObject({ state: 'queued', submitted: false });
    expect(service.requestStatus(second!.requestId)).toMatchObject({ state: 'queued', submitted: false });
  });

  // expose Claude completion as soon as actual submission succeeds
  it('marks Claude submitted only after a queued prompt reaches its pane', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-claude-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory, 'working');
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› Ready',
      sendKeys: async (_socket: unknown, _paneId: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => claudeAdapter);

    const tracked = await service.submitTracked(agent.id, 'queued Claude prompt');
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'queued', submitted: false });
    expect(sent).toEqual([]);

    // finishing unrelated work dispatches the exact queued request
    agent.attention = 'finished';
    await service.observe(agent as never);
    expect(sent).toEqual([['Enter']]);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'running', submitted: true });
  });

  // keep the atomic Claude arm path inside the injected pane-safety boundary
  it.each([true, false])('submits a managed Claude arm through tmux with outcome %s', async accepted => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-arm-'));
    directories.push(directory);
    const agent = testAgent('claude', directory);
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const armAndSendKeys = vi.fn(async () => accepted);
    const sendKeys = vi.fn(async () => true);
    const invalid = vi.fn(async () => undefined);
    const beforeSend = vi.fn(async (_intent: { id: string }) => ({ arm: 'synthetic-arm' }));
    const calendar = {
      admit: async () => undefined, beforeSend,
      pending: async () => [], observe: async () => undefined,
      missing: async () => undefined, invalid, handOver: async () => undefined
    };
    const raw = vi.spyOn(tmuxCommand, 'run').mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    try {
      const service = new PromptService(discovery as never, { pastePrompt: async () => true, sendKeys, armAndSendKeys } as never, undefined, undefined, undefined, () => claudeAdapter, undefined, undefined, calendar);
      const tracked = await service.submitTracked(agent.id, 'managed Claude work');
      expect(armAndSendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', 'synthetic-arm', ['Enter']);
      expect(sendKeys).not.toHaveBeenCalled();
      expect(raw).not.toHaveBeenCalled();
      const requestId = beforeSend.mock.calls[0]![0].id;
      expect(tracked?.requestId).toBe(accepted ? requestId : undefined);
      expect(service.requestStatus(requestId)).toMatchObject({ state: accepted ? 'running' : 'failed', submitted: accepted });
      // failed atomic submission invalidates only the exact capture rather than sending again
      if (!accepted) expect(invalid).toHaveBeenCalledExactlyOnceWith(requestId, 'missing_lifecycle_evidence');
    } finally { raw.mockRestore(); }
  });

  // durable Calendar work must not authorize keys from a stale native snapshot
  it.each(['process', 'question', 'edit', 'clear', 'unchanged', 'working'] as const)('revalidates %s after deferred Calendar intent persistence', async change => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-calendar-presend-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory);
    let pid = process.pid;
    let draft = 'managed queued prompt';
    let sent = false;
    let entered!: () => void;
    let release!: (intent: { arm: string }) => void;
    const awaitingIntent = new Promise<void>(resolve => { entered = resolve; });
    const intent = new Promise<{ arm: string }>(resolve => { release = resolve; });
    const beforeSend = vi.fn(async (_input: { id: string }) => { entered(); return await intent; });
    const invalid = vi.fn(async () => undefined);
    const calendar = { admit: async () => undefined, beforeSend, invalid, pending: async () => [], observe: async () => undefined, missing: async () => undefined, handOver: async () => undefined };
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), agentProcessId: () => pid };
    const accept = async () => { sent = true; draft = ''; agent.attention = 'working'; return true; };
    const armAndSendKeys = vi.fn(accept);
    const sendKeys = vi.fn(accept);
    const adapter = {
      ...claudeAdapter,
      submission: {
        prepare: (prompt: string) => ({ text: prompt, keys: ['Tab'], idleKeys: ['Enter'] }),
        observeDraft: (capture: string, prompt: string) => capture === prompt ? 'visible' : 'cleared',
        ownsDraft: (capture: string, prompt: string) => capture === prompt,
        interrupt: ['C-c'], selectOption: () => ['Enter']
      },
      completion: { baseline: async () => ({ rollout: 'synthetic-rollout', ordinal: 0 }), since: async () => ({ kind: 'pending' }), accepted: async () => sent }
    };
    const service = new PromptService(discovery as never, { pastePrompt: async () => true, capture: async () => draft, armAndSendKeys, sendKeys } as never, undefined, queue, undefined, () => adapter as never, undefined, undefined, calendar);
    const submission = service.submitTracked(agent.id, draft);
    await awaitingIntent;
    // mutate only the selected native fact while persistence is genuinely suspended
    switch (change) {
      case 'process': pid += 1; break;
      case 'question': agent.attention = 'question'; break;
      case 'edit': draft = 'operator-owned edit'; break;
      case 'clear': draft = ''; break;
      case 'working': agent.attention = 'working'; break;
    }
    release({ arm: 'synthetic-arm' });
    const tracked = await submission;
    const requestId = beforeSend.mock.calls[0]![0].id;
    const accepted = change === 'unchanged' || change === 'working';
    expect(tracked?.requestId).toBe(requestId);
    // unchanged authority submits exactly once with send-time attention-derived keys
    if (accepted) {
      expect(armAndSendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', 'synthetic-arm', change === 'working' ? ['Tab'] : ['Enter']);
      expect(await queue.list(`agent:${agent.id}`)).toEqual([]);
      expect(service.requestStatus(requestId)).toMatchObject({ submitted: true });
      expect(invalid).not.toHaveBeenCalled();
    } else {
      expect(armAndSendKeys).not.toHaveBeenCalled();
      expect(await queue.list(`agent:${agent.id}`)).toEqual([expect.objectContaining({ id: requestId, text: 'managed queued prompt' })]);
      expect(service.requestStatus(requestId)).toMatchObject({ submitted: false });
      expect(invalid).toHaveBeenCalledExactlyOnceWith(requestId, 'missing_lifecycle_evidence');
    }
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // internal Note recovery must also settle an admitted but never-dispatched capture
  it('invalidates calendar admissions after a departed queue is durably drained to Notes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    try {
      const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-calendar-note-'));
      directories.push(directory);
      const key = `active:${randomBytes(32).toString('base64url')}`;
      const authPath = join(directory, 'auth.json');
      const activitiesPath = join(directory, 'activities.json');
      const lifecyclePath = join(directory, 'lifecycle.json');
      await new AuthStore(authPath, parseTokenKey(key)).save({ version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' });
      const provider = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath });
      const options = { file: lifecyclePath, sink: provider, labels: async () => ({ worktree: 'Main', agent: 'Claude' }) };
      const lifecycle = new GoogleCalendarLifecycle(options);
      const queue = new QueuedPromptService(join(directory, 'queue.json'));
      const agent = testAgent('claude', directory, 'working');
      const note = join(directory, 'recovered-note.txt');
      // acknowledge recovery only after the Note boundary has durably accepted the prompt
      const drain = vi.fn(async (_scope: string, queued: { text: string }) => { await writeFile(note, queued.text); return true; });
      const service = new PromptService({ worktreesNow: () => [], target: async () => ({ agent, socket }) } as never, { capture: async () => '› Working' } as never, undefined, queue, drain, () => claudeAdapter, undefined, undefined, lifecycle);
      const tracked = await service.submitTracked(agent.id, 'never sent follow-up');
      expect(provider.summary().counts.pending).toBe(1);
      expect(JSON.parse(await readFile(lifecyclePath, 'utf8')).records).toHaveLength(1);
      await service.retireDeparted([]);
      vi.setSystemTime(130_001);
      await service.retireDeparted([]);
      expect(drain).toHaveBeenCalledOnce();
      expect(await readFile(note, 'utf8')).toBe('never sent follow-up');
      await expect(queue.list('agent:socket:%1')).resolves.toEqual([]);
      expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'failed', error: 'prompt_not_delivered' });
      expect(JSON.parse(await readFile(lifecyclePath, 'utf8')).records).toEqual([]);
      await expect(new GoogleCalendarLifecycle(options).pending()).resolves.toEqual([]);
      const reloaded = new ActivityStore(activitiesPath);
      await reloaded.load();
      expect(reloaded.get(tracked!.requestId)).toMatchObject({ status: 'awaiting_evidence', reason: 'missing_lifecycle_evidence' });
      expect(provider.summary().counts.pending).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  // allocate a process-local identity when durable queuing is unavailable
  it('tracks direct submission with a fallback request id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-direct-'));
    directories.push(directory);
    const agent = testAgent('claude', directory);
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = { pastePrompt: async () => true, sendKeys: async () => true };
    const service = new PromptService(discovery as never, tmux as never, undefined, undefined, undefined, () => claudeAdapter);

    const tracked = await service.submitTracked(agent.id, 'direct prompt');

    expect(tracked?.requestId).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'running', submitted: true });
  });

  // settle removal and transport failure without replaying either request
  it('fails removed and unaccepted tracked prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-failure-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory, 'working');
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const service = new PromptService(discovery as never, { pastePrompt: async () => true, capture: async () => '› Ready', sendKeys: async () => false } as never, undefined, queue, undefined, () => claudeAdapter);

    const removed = await service.submitTracked(agent.id, 'remove me');
    await expect(service.removeQueued(agent.id, removed!.requestId)).resolves.toBe(true);
    expect(service.requestStatus(removed!.requestId)).toMatchObject({ state: 'failed', submitted: false, error: 'queue_removed' });

    // failed actual submission settles without claiming receipt
    agent.attention = 'finished';
    await service.observe(agent as never);
    const rejected = await service.submitTracked(agent.id, 'reject me');
    expect(service.requestStatus(rejected!.requestId)).toMatchObject({ state: 'failed', submitted: false, error: 'prompt_submission_failed' });
    await service.observe(agent as never);
    expect(service.requestStatus(rejected!.requestId)).toMatchObject({ state: 'failed', submitted: false });
  });

  // settle only after a queued prompt is durably saved elsewhere
  it('fails a tracked request only after successful queued consumption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-save-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory, 'working');
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const service = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, queue, undefined, () => claudeAdapter);
    const tracked = await service.submitTracked(agent.id, 'save this prompt');

    const refused = await service.consumeQueuedOnSuccess(agent.id, tracked!.requestId, async () => false);
    expect(refused).toBe('failed');
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'queued', submitted: false });
    expect(await queue.list(`agent:${agent.id}`)).toHaveLength(1);

    const consumed = await service.consumeQueuedOnSuccess(agent.id, tracked!.requestId, async queued => queued.text === 'save this prompt');
    expect(consumed).toBe('consumed');
    expect(service.requestStatus(tracked!.requestId)).toEqual({ id: tracked!.requestId, agentId: agent.id, state: 'failed', submitted: false, error: 'queue_saved' });
    expect(await queue.list(`agent:${agent.id}`)).toEqual([]);
  });

  // invalidate the original action only after its configured bytes change
  it('fails a tracked request after a successful queued edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-update-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory, 'working');
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const service = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, queue, undefined, () => claudeAdapter);
    const tracked = await service.submitTracked(agent.id, 'configured prompt');

    await expect(service.updateQueued(agent.id, tracked!.requestId, '')).resolves.toBeUndefined();
    await expect(service.updateQueued(agent.id, tracked!.requestId, 'configured prompt')).resolves.toMatchObject({ text: 'configured prompt' });
    expect(service.requestStatus(tracked!.requestId)).toMatchObject({ state: 'queued', submitted: false });

    await expect(service.updateQueued(agent.id, tracked!.requestId, 'edited prompt')).resolves.toMatchObject({ text: 'edited prompt' });
    expect(service.requestStatus(tracked!.requestId)).toEqual({ id: tracked!.requestId, agentId: agent.id, state: 'failed', submitted: false, error: 'queue_updated' });
    expect(await queue.list(`agent:${agent.id}`)).toEqual([expect.objectContaining({ id: tracked!.requestId, text: 'edited prompt' })]);
  });

  // keep the lifecycle registry boot-local
  it('does not restore tracked status from the durable queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-process-loss-'));
    directories.push(directory);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = testAgent('claude', directory, 'working');
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const first = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, queue, undefined, () => claudeAdapter);
    const tracked = await first.submitTracked(agent.id, 'survive only in queue');
    const restarted = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, new QueuedPromptService(join(directory, 'queue.json')), undefined, () => claudeAdapter);

    expect(first.requestStatus(tracked!.requestId)).toMatchObject({ state: 'queued' });
    expect(restarted.requestStatus(tracked!.requestId)).toBeUndefined();
  });

  // durable calendar correlation survives the process-local phase registry
  it('reconciles live and departed calendar activities once per dashboard refresh after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-calendar-restart-'));
    directories.push(directory);
    const agent = testAgent('codex', directory, 'finished');
    const observe = vi.fn(async () => undefined);
    const missing = vi.fn(async () => undefined);
    const calendar = {
      admit: async () => undefined,
      beforeSend: async () => ({}),
      pending: async () => [{ id: 'durable-activity', agentId: agent.id, kind: 'codex' }, { id: 'sibling-activity', agentId: 'socket:%2', kind: 'codex' }],
      observe,
      invalid: async () => undefined,
      missing,
      handOver: async () => undefined
    };
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const restarted = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, undefined, undefined, () => codexAdapter, undefined, undefined, calendar);

    await restarted.reconcileCalendar([agent.id]);
    await restarted.observe(agent as never);

    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.map(call => call[0])).toEqual(['sibling-activity', 'durable-activity']);
    expect(observe.mock.calls[1]?.[1]?.version).toBe(1);
    expect(missing).toHaveBeenCalledExactlyOnceWith('sibling-activity');
  });

  it('cold-starts PromptService and finalizes a persisted native lifecycle without a phase', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-calendar-cold-'));
    directories.push(directory);
    const file = join(directory, 'calendar-lifecycle.json');
    const signals: CalendarSignal[] = [];
    const options = { file, sink: { admit: async () => true, signal: async (signal: CalendarSignal) => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) };
    const original = new GoogleCalendarLifecycle(options);
    await original.admit({ id: 'cold-activity', agentId: 'socket:%1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await original.beforeSend({ id: 'cold-activity', agentId: 'socket:%1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'cold prompt', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    const agent = testAgent('codex', directory, 'finished');
    const adapter = {
      ...codexAdapter,
      managedPromptLifecycleV1: {
        version: 1 as const,
        compatible: () => true,
        inspect: async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 2, startOrdinal: 3, terminalOrdinal: 4, turnId: 'cold-turn', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' })
      }
    };
    const restartedLifecycle = new GoogleCalendarLifecycle(options);
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const restarted = new PromptService(discovery as never, { capture: async () => '› Ready' } as never, undefined, undefined, undefined, () => adapter, undefined, undefined, restartedLifecycle);

    await restarted.observe(agent as never);

    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'finished']);
    await expect(restartedLifecycle.pending()).resolves.toEqual([]);
  });
});
