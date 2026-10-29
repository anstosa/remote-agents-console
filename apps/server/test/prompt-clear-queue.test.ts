import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { adapterFor } from '../src/adapters/registry.js';
import type { CompletionBaseline } from '../src/adapters/types.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };

// represent mutable adapter state across scenarios
type ResetTestAgent = {
  id: string;
  pane: { paneId: string };
  home: string;
  kind: 'claude' | 'codex' | 'omx';
  title: string;
  attention: 'finished' | 'working';
  displayLabel?: string;
  conversationId?: string;
};

// create shared durable services and agent state
const createResetFixture = async (kind: ResetTestAgent['kind'] = 'codex') => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-reset-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const agent: ResetTestAgent = {
    id: 'socket:%1',
    pane: { paneId: '%1' },
    home: '/tmp',
    kind,
    title: 'Ready',
    attention: 'finished'
  };
  const saved: string[] = [];
  // expose the default pane without scenario-specific terminal behavior
  const discovery = {
    worktreesNow: () => [],
    target: async () => ({ agent, socket }),
    paneProcessId: () => 123,
    paneWorkingDirectory: () => '/tmp'
  };
  // record accidental transfers to undelivered notes
  const drain = async (_scope: string, prompt: { text: string }) => {
    saved.push(prompt.text);
    return true;
  };
  // remove the isolated durable files
  const cleanup = async () => rm(directory, { recursive: true, force: true });
  return { agent, cleanup, discovery, drain, history, queue, saved };
};

// advance polling timers while allowing real durable storage to finish
const settlePolling = async <T>(operation: Promise<T>): Promise<T> => {
  let settled = false;
  // stop driving timers after either outcome without swallowing failures
  void operation.then(() => { settled = true; }, () => { settled = true; });
  // yield to filesystem callbacks between fake timer batches
  while (!settled) {
    await setImmediate();
    await vi.runOnlyPendingTimersAsync();
  }
  return await operation;
};

// conversation resets must not wait for model answers or drain queued follow-ups
describe('clear then queue', () => {
  afterEach(() => vi.useRealTimers());

  // reset redraws can hide the composer beyond ordinary prompt acknowledgement
  it.each([
    ['codex', '/clear'], ['codex', '/new'], ['omx', '/clear'], ['omx', '/new']
  ] as const)('accepts %s %s after a delayed composer redraw without saving it to notes', async (kind, command) => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture(kind);
    const scope = `agent:${agent.id}`;
    const pasted: string[] = [];
    const sent: string[][] = [];
    let composer = '';
    let resetAt: number | undefined;
    let loading = true;
    const tmux = {
      // retain each draft until its submit key
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // reproduce the blank pane that clear draws before restoring its composer
      capture: async () => {
        // hide the composer beyond ordinary acknowledgement without pinning poll counts
        if (resetAt !== undefined && Date.now() - resetAt < 1_500) return '';
        return `${loading ? 'model: loading\n' : ''}› ${composer || 'Ask Codex to do anything'}`;
      },
      // execute the reset once without starting a model turn
      sendKeys: async (_s: unknown, _p: string, keys: string[]) => {
        sent.push(keys);
        resetAt = composer.trim() === command ? Date.now() : undefined;
        composer = '';
        agent.attention = 'working';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await expect(settlePolling(service.submit(agent.id, command))).resolves.toBe(true);
      expect(sent).toEqual([['Enter']]);
      await expect(queue.list(scope)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toEqual([]);
      await expect(queue.resets.get(scope)).resolves.toMatchObject({ agentId: agent.id });

      // hold immediate follow-ups until reset startup finishes
      await service.submit(agent.id, 'after delayed reset');
      agent.attention = 'finished';
      await settlePolling(service.observe(agent));
      expect(pasted).toEqual([command]);
      expect(saved).toEqual([]);

      // send real work only after the empty composer is ready
      loading = false;
      await settlePolling(service.observe(agent));
      expect(pasted).toEqual([command, 'after delayed reset']);
      expect(saved).toEqual([]);
      await expect(queue.list(scope)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'after delayed reset' }]);
    } finally { await cleanup(); }
  });

  // longer reset grace must still preserve commands without acknowledgement
  it.each(['visible', 'hidden'] as const)('recovers an unacknowledged reset with a %s composer after the reset budget', async frame => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture();
    const scope = `agent:${agent.id}`;
    const sent: string[][] = [];
    let submitted = false;
    let observable = false;
    let cleared = false;
    const tmux = {
      // allow the reset draft to render before its submit key
      pastePrompt: async () => true,
      // retain the draft or an inconclusive frame throughout reset acceptance
      capture: async () => cleared ? '› ' : submitted && frame === 'hidden' && !observable ? '' : '› /clear ',
      // successful key delivery alone must not consume the reset
      sendKeys: async (_s: unknown, _p: string, keys: string[]) => { sent.push(keys); submitted = true; cleared ||= keys.includes('C-c'); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await expect(settlePolling(service.submit(agent.id, '/clear'))).resolves.toBe(true);
      // visible drafts may retry without depending on the exact retry schedule
      expect(sent.length).toBeGreaterThan(0);
      // hidden frames never permit resubmitting the reset
      if (frame === 'hidden') expect(sent).toEqual([['Enter']]);
      await expect(queue.list(scope)).resolves.toMatchObject([{ text: '/clear' }]);
      await expect(queue.resets.get(scope)).resolves.toBeUndefined();
      await expect(history.list(scope)).resolves.toEqual([]);

      // defer note recovery until the native draft can be inspected and cleared
      observable = true;
      await settlePolling(service.observe(agent));
      expect(saved).toEqual(['/clear']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // slow terminal snapshots must not turn reset grace into an unbounded wait
  it('bounds reset acknowledgement time when terminal captures are slow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, queue, saved } = await createResetFixture();
    const scope = `agent:${agent.id}`;
    let submitted = false;
    let recovering = false;
    let cleared = false;
    const tmux = {
      // allow the reset draft to reach the terminal
      pastePrompt: async () => true,
      // each inconclusive snapshot consumes real terminal execution time
      capture: async () => {
        // make a later snapshot usable for native cleanup
        if (recovering) return cleared ? '› ' : '› /clear ';
        // keep the pre-submit composer visible for the render gate
        if (!submitted) return '› /clear ';
        vi.setSystemTime(Date.now() + 3_000);
        return '';
      },
      // key delivery does not acknowledge a hidden composer
      sendKeys: async (_s: unknown, _p: string, keys: string[]) => { submitted = true; cleared ||= keys.includes('C-c'); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      const startedAt = Date.now();
      await expect(settlePolling(service.submit(agent.id, '/clear'))).resolves.toBe(true);
      // allow the in-flight snapshot to finish without extending every poll
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      await expect(queue.list(scope)).resolves.toMatchObject([{ text: '/clear' }]);

      // inspect and clear the recovered composer before making its note durable
      recovering = true;
      await settlePolling(service.observe(agent));
      expect(saved).toEqual(['/clear']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // resets must release follow-ups without waiting for a nonexistent model answer
  it.each([
    ['codex', '/clear'], ['codex', '/new'], ['omx', '/clear'], ['omx', '/new']
  ] as const)('delivers queued work after %s %s and tracks the fresh conversation', async (kind, command) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture(kind);
    const scope = `agent:${agent.id}`;
    const pasted: string[] = [];
    let composer = '';
    let loading = false;
    let completed = false;
    const tmux = {
      // retain the exact draft until the submit key
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // advance deterministic render time without faking filesystem work
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `${loading ? 'model: loading\n' : ''}› ${composer || 'Ask Codex to do anything'}`; },
      // a reset briefly looks busy without producing a model turn
      sendKeys: async () => { loading = composer.trim() === command; composer = ''; agent.attention = 'working'; return true; }
    };
    const adapter = {
      ...adapterFor(kind)!,
      completion: {
        // model the stale file still held open until the first post-reset turn
        baseline: async (_pane: unknown, resetAt?: number): Promise<CompletionBaseline> => {
          return resetAt === undefined ? { rollout: 'stale.jsonl', ordinal: 3 } : { cwd: '/tmp', resetAt, ordinal: 0 };
        },
        // only the deferred fresh-thread baseline can see this completion
        since: async (baseline: CompletionBaseline) => completed && 'resetAt' in baseline
          ? { kind: 'completed' as const, ordinal: 4, answer: 'Fresh answer' }
          : { kind: 'pending' as const }
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      // cover both direct input and an already queued reset
      if (command === '/clear') {
        await service.submit(agent.id, command);
        await service.submit(agent.id, 'first follow-up');
      } else {
        await queue.enqueue(scope, command);
        await queue.enqueue(scope, 'first follow-up');
        await service.observe(agent);
      }
      await service.submit(agent.id, 'second follow-up');
      expect(pasted).toEqual([command]);

      // a visible empty composer is not ready while the new session still loads
      vi.setSystemTime(Date.now() + 2_000);
      await service.observe(agent);
      agent.attention = 'finished';
      await service.observe(agent);
      expect(pasted).toEqual([command]);

      loading = false;
      await service.observe(agent);
      expect(pasted).toEqual([command, 'first follow-up']);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'first follow-up' }]);
      await expect(history.list(scope)).resolves.toHaveLength(1);

      // the real answer releases the next prompt without a false undelivered drain
      completed = true;
      agent.attention = 'finished';
      await service.observe(agent);
      expect(pasted).toEqual([command, 'first follow-up', 'second follow-up']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'second follow-up' }, { text: 'first follow-up', answer: 'Fresh answer' }]);
    } finally { await cleanup(); }
  });

  // retain the fresh-thread anchor even when no prompt was queued during the reset
  it.each([[false, false], [true, false], [false, true]])('handles delayed input with swallowed submission=%s and expired readiness=%s', async (swallowed, expired) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture();
    const pasted: string[] = [];
    const resets: Array<number | undefined> = [];
    let composer = '';
    let loading = expired;
    const tmux = {
      // keep failed delivery in the composer rather than losing the original paste
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // drive deterministic render and acknowledgement polling
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `${loading ? 'model: loading\n' : ''}› ${composer}`; },
      // acknowledge only the reset when the next prompt is intentionally swallowed
      sendKeys: async (_s: unknown, _p: string, keys: string[]) => {
        // model native clearing even when prompt submission is swallowed
        if (keys.includes('C-c') || !swallowed || composer.trim() === '/clear') composer = '';
        return true;
      }
    };
    const adapter = {
      ...adapterFor('codex')!,
      completion: {
        // capture only the reset boundary used by the delayed real prompt
        baseline: async (_pane: unknown, resetAt?: number) => { resets.push(resetAt); return undefined; },
        since: async () => undefined
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      await service.submit(agent.id, '/clear');
      vi.setSystemTime(Date.now() + (expired ? 11_000 : 2_000));
      await service.observe(agent);
      // an idle settled reset must not permanently reserve lifecycle operations
      const release = await service.acquireRestartLock(agent.id);
      expect(release).toEqual(expect.any(Function));
      release?.();
      loading = false;
      await service.submit(agent.id, 'delayed follow-up');
      await service.observe(agent);
      expect(resets).toEqual([expect.any(Number)]);
      await service.observe(agent);
      expect(pasted).toEqual(['/clear', 'delayed follow-up']);
      expect(saved).toEqual(swallowed ? ['delayed follow-up'] : []);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // a terminal-entered reset has no console dispatch or answer to recover
  it('delivers unattempted work after an external reset spinner returns to idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture();
    agent.title = '⠋ Starting';
    agent.attention = 'working';
    const pasted: string[] = [];
    let composer = '';
    let completed = false;
    const tmux = {
      // observe actual delivery rather than assuming a queued prompt was sent
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // the startup composer is visible before the title becomes idle
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `› ${composer}`; },
      // acknowledge the eventual first real prompt
      sendKeys: async () => { composer = ''; return true; }
    };
    const adapter = {
      ...adapterFor('codex')!,
      completion: {
        // no reliable command timestamp exists for a terminal-entered reset
        baseline: async (_pane: unknown, _resetAt?: number, followReset?: boolean): Promise<CompletionBaseline> => {
          return { rollout: 'old.jsonl', ordinal: 3, ...(followReset ? { resetPane: { pid: 123, cwd: '/tmp' } } : {}) };
        },
        // the completion arrives in the new file only after the first prompt starts
        since: async (baseline: CompletionBaseline) => completed && 'resetPane' in baseline
          ? { kind: 'completed' as const, ordinal: 4, answer: 'Fresh answer' }
          : { kind: 'pending' as const }
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      await service.submit(agent.id, 'after external clear');
      await service.submit(agent.id, 'second follow-up');
      expect(pasted).toEqual([]);
      agent.attention = 'finished';
      await service.observe(agent);
      vi.setSystemTime(Date.now() + 11_000);
      await service.observe(agent);
      expect(pasted).toEqual(['after external clear']);
      completed = true;
      await service.observe(agent);
      expect(pasted).toEqual(['after external clear', 'second follow-up']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // an unusable reset must not reserve a durable queue forever
  it.each(['loading', 'missing'] as const)('preserves follow-ups as notes when a reset stays %s', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, drain, history, queue, saved } = await createResetFixture();
    const pasted: string[] = [];
    let composer = '';
    let reset = false;
    // keep discovery unavailable only after accepting the reset
    const discovery = { worktreesNow: () => [], target: async () => reset && failure === 'missing' ? undefined : { agent, socket } };
    const tmux = {
      // retain the reset draft for acknowledgement
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // leave an empty composer visible beneath a loading header
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `model: loading\n› ${composer}`; },
      // acknowledge the reset but never finish loading
      sendKeys: async () => { reset = true; composer = ''; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await queue.enqueue(`agent:${agent.id}`, '/clear');
      await queue.enqueue(`agent:${agent.id}`, 'recover this prompt');
      await service.observe(agent);
      vi.setSystemTime(Date.now() + 11_000);
      await service.observe(agent);
      await service.observe(agent);
      await service.observe(agent);
      expect(pasted).toEqual(['/clear']);
      expect(saved).toEqual(['recover this prompt']);
      await expect(queue.list(`agent:${agent.id}`)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  it('dispatches a prompt queued right after /clear instead of losing it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture('claude');
    agent.displayLabel = 'Claude';
    agent.title = 'Claude';
    agent.conversationId = 'before-clear';
    const pasted: string[] = [];
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; },
      capture: async () => '❯ ',
      // SessionStart reports the fresh session after the reset key
      sendKeys: async () => { agent.conversationId = 'after-clear'; return true; },
    };
    // resolve the real Claude adapter (reported-state, turn-less) by kind
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain as never);
    try {
      // send /clear without opening a model-answer phase
      await expect(service.submit(agent.id, '/clear')).resolves.toBe(true);
      // retain an immediate follow-up until the reported reset settles
      await expect(service.submit(agent.id, 'do the thing')).resolves.toBe(true);
      // let the reportedWorkingGraceMs (5s) window elapse with the pane still finished
      vi.setSystemTime(6_000);
      await service.observe(agent);

      // the follow-up must reach the pane, not be drained into a Note
      expect(pasted).toEqual(['/clear', 'do the thing']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });
});
