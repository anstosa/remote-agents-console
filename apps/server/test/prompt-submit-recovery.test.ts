import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { adapterFor } from '../src/adapters/registry.js';
import type { AgentKind } from '../src/adapters/types.js';
import { stated } from './helpers/agent.js';
import { codexComposerWithFooter } from './helpers/codex-composer.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };

// drive polling without delaying durable filesystem work
const settlePolling = async <T>(operation: Promise<T>): Promise<T> => {
  let settled = false;
  // observe both outcomes without swallowing errors
  void operation.then(() => { settled = true; }, () => { settled = true; });
  // yield between bounded timer batches
  while (!settled) {
    await setImmediate();
    await vi.runOnlyPendingTimersAsync();
  }
  return await operation;
};

// isolate queued delivery and note recovery
const fixture = async (kind: AgentKind = 'codex') => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const directory = await mkdtemp(join(tmpdir(), 'rac-submit-recovery-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const agent = { ...stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: directory, title: 'Ready' }), kind };
  const scope = `agent:${agent.id}`;
  const notes: string[] = [];
  // preserve undelivered text before removing queue items
  const drain = async (_scope: string, prompt: { text: string }) => { notes.push(prompt.text); return true; };
  // remove only this test's durable files
  const cleanup = async () => rm(directory, { recursive: true, force: true });
  return { agent, queue, history, scope, notes, drain, cleanup };
};

// recover pasted drafts before moving failed queues into notes
describe('failed queue submission recovery', () => {
  afterEach(() => vi.useRealTimers());

  // real footer rows must allow initial delivery, retries and verified cleanup
  it.each([
    ['codex', 'accepted'], ['codex', 'retry'], ['codex', 'abandoned'],
    ['omx', 'accepted'], ['omx', 'retry'], ['omx', 'abandoned']
  ] as const)('handles a %s weather draft when submission is %s', async (kind, outcome) => {
    const { agent, queue, history, scope, notes, drain, cleanup } = await fixture(kind);
    const prompt = 'Show the icons for humidity, air quality, pressure, and UV in gold when adjustment is on too';
    let composer = prompt;
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // keep the live two-row footer through every redraw
      capture: async () => codexComposerWithFooter(composer),
      // model swallowed Enter separately from the single cleanup key
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // allow only the requested submit outcome or native draft clearing
        if (keys.join() === 'C-c' || outcome === 'accepted' || outcome === 'retry' && sent.length > 1) composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, prompt));
      expect(sent[0]).toEqual(['Enter']);
      expect(composer).toBe('');
      expect(notes).toEqual([]);
      // preserve failed work until an idle observer saves its note
      if (outcome === 'abandoned') {
        expect(sent.length).toBeGreaterThan(2);
        expect(sent.at(-1)).toEqual(['C-c']);
        expect(sent.slice(0, -1).every(keys => keys.join() === 'Enter')).toBe(true);
        await expect(queue.list(scope)).resolves.toMatchObject([{ text: prompt }]);
        await expect(history.list(scope)).resolves.toEqual([]);
        await service.observe(agent);
        expect(notes).toEqual([prompt]);
      } else {
        expect(sent).toEqual(outcome === 'accepted' ? [['Enter']] : [['Enter'], ['Enter']]);
        await expect(history.list(scope)).resolves.toMatchObject([{ text: prompt }]);
      }
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // native redraws can outlast the original render gate
  it('waits for a late pasted composer before submitting', async () => {
    const { agent, queue, history, scope, drain, cleanup } = await fixture();
    let pastedAt = 0;
    let composer = '';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // keep the paste hidden during a slow redraw
      pastePrompt: async () => { pastedAt = Date.now(); composer = 'late draft'; return true; },
      // expose the complete draft only after the old render budget
      capture: async () => Date.now() - pastedAt < 900 ? '' : `› ${composer}`,
      // accept the first key after rendering
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); composer = ''; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'late draft'));
      expect(sent).toEqual([['Enter']]);
      await expect(queue.list(scope)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'late draft' }]);
    } finally { await cleanup(); }
  });

  // stale working state must not pin recovery to the queue key
  it.each(['codex', 'omx'] as const)('rechecks %s attention and retries Tab as Enter when the pane becomes idle', async kind => {
    const { agent, queue, history, scope, notes, drain, cleanup } = await fixture(kind);
    const sent: string[][] = [];
    let composer = 'recover me';
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // render while external work starts
      pastePrompt: async () => { agent.attention = 'working'; return true; },
      capture: async () => `› ${composer}`,
      // swallow Tab just as the external turn finishes
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        agent.attention = 'finished';
        // only Enter starts the remaining draft
        if (keys.includes('Enter')) composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'recover me'));
      expect(sent).toEqual([['Tab'], ['Enter']]);
      await expect(queue.list(scope)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'recover me' }]);
      expect(notes).toEqual([]);
    } finally { await cleanup(); }
  });

  // neither a slow tui nor one failed transport should abandon a visible paste
  it.each(['slow', 'false', 'throw'] as const)('recovers a visible draft after %s submit delivery', async failure => {
    const { agent, queue, history, scope, notes, drain, cleanup } = await fixture();
    let submittedAt = 0;
    let composer = 'retry visible draft';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // reject early delivery or swallow keys until the native tui recovers
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // simulate an ambiguous first transport failure
        if (sent.length === 1) {
          submittedAt = Date.now();
          // preserve the draft after an explicit rejection
          if (failure === 'false') return false;
          // preserve the draft after a command exception
          if (failure === 'throw') throw new Error('temporary tmux failure');
        }
        // acknowledge only a real submit after the recovery delay
        if (keys.includes('Enter') && (failure !== 'slow' || Date.now() - submittedAt >= 2_000)) composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'retry visible draft'));
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.every(keys => keys.join() === 'Enter')).toBe(true);
      await expect(queue.list(scope)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'retry visible draft' }]);
      expect(notes).toEqual([]);
    } finally { await cleanup(); }
  });

  // exhausted recovery must remove the pasted draft without discarding its note
  it.each(['codex', 'omx'] as const)('clears an unsubmitted %s draft before saving the queue to notes', async kind => {
    const { agent, queue, history, scope, notes, drain, cleanup } = await fixture(kind);
    const prompt = 'first paragraph\n\nsecond paragraph';
    let composer = prompt;
    const sent: string[][] = [];
    const clearKeys = adapterFor(kind)!.submission.clearDraft;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // swallow every submit but allow the adapter's non-interrupting clear
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // distinguish clearing from prompt submission
        if (JSON.stringify(keys) === JSON.stringify(clearKeys)) composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, prompt));
      expect(clearKeys?.length).toBeGreaterThan(0);
      expect(sent.at(-1)).toEqual(clearKeys);
      expect(composer).toBe('');
      await expect(queue.list(scope)).resolves.toMatchObject([{ text: prompt }]);
      await expect(history.list(scope)).resolves.toEqual([]);
      await service.observe(agent);
      expect(notes).toEqual([prompt]);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // missing composers and live native questions never authorize extra keys
  it.each(['hidden', 'question', 'replaced'] as const)('does not retry or clear an unsafe %s target', async state => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    const sent: string[][] = [];
    let submitted = false;
    const replacement = { ...agent, pane: { ...agent.pane, paneId: '%2' } };
    const discovery = {
      worktreesNow: () => [],
      // replace the pane only after the original submit
      target: async () => ({ agent: submitted && state === 'replaced' ? replacement : agent, socket })
    };
    const tmux = {
      pastePrompt: async () => true,
      // hidden redraws provide no proof that a draft still belongs to this queue
      capture: async () => submitted && state === 'hidden' ? '' : '› unsafe draft ',
      // transition to the unsafe native state after the initial submit
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        submitted = true;
        // a native question must remain under user control
        if (state === 'question') agent.attention = 'question';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'unsafe draft'));
      expect(sent).toEqual([['Enter']]);
      await expect(queue.list(scope)).resolves.toMatchObject([{ text: 'unsafe draft' }]);
      expect(notes).toEqual([]);
    } finally { await cleanup(); }
  });

  // a stalled transport must still leave time to inspect the pasted draft
  it('recovers after an initial submit transport exceeds the acknowledgement budget', async () => {
    const { agent, queue, scope, drain, cleanup } = await fixture();
    let composer = 'slow transport';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // finish the slow first command before beginning the recovery budget
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // preserve a swallowed draft through the transport timeout
        if (sent.length === 1) { await new Promise(resolve => setTimeout(resolve, 5_000)); return false; }
        composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'slow transport'));
      expect(sent).toEqual([['Enter'], ['Enter']]);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // never clear an empty composer twice or abandon a swallowed cleanup
  it.each(['swallowed', 'false', 'throw', 'persistent'] as const)('verifies native clearing after %s cleanup delivery', async failure => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let composer = 'clear only this draft';
    let clears = 0;
    let clearedEmpty = false;
    let clearingAllowed = failure !== 'persistent';
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // swallow submit and vary the first single-key cleanup response
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        // only a single ctrl-c may clear the live nonempty composer
        if (keys.join() === 'C-c') {
          clearedEmpty ||= composer === '';
          clears += 1;
          // keep cleanup pending while its transport remains unavailable
          if (!clearingAllowed) return false;
          // the first key can dismiss history search without clearing
          if (clears === 1) {
            // model a transport exception before native clearing
            if (failure === 'throw') throw new Error('clear response lost');
            return failure !== 'false';
          }
          composer = '';
        }
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'clear only this draft'));
      // persistent transport failures must not finalize recovery into notes
      if (failure === 'persistent') {
        await settlePolling(service.observe(agent));
        expect(notes).toEqual([]);
        await expect(queue.list(scope)).resolves.toHaveLength(1);
        clearingAllowed = true;
      }
      await settlePolling(service.observe(agent));
      expect(composer).toBe('');
      expect(clearedEmpty).toBe(false);
      expect(clears).toBeGreaterThanOrEqual(2);
      expect(notes).toEqual(['clear only this draft']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // operator additions must not become automatic submissions or collateral deletion
  it('preserves operator text appended while the failed draft is recovering', async () => {
    const { agent, queue, scope, drain, cleanup } = await fixture();
    let composer = 'original draft';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // the operator modifies the text after the initial swallowed submit
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); composer = 'original draft plus operator changes'; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'original draft'));
      expect(sent).toEqual([['Enter']]);
      expect(composer).toBe('original draft plus operator changes');
      await expect(queue.list(scope)).resolves.toHaveLength(1);
    } finally { await cleanup(); }
  });

  // the same pane id must not hide a native process replacement
  it('retains a queue when a new process has an empty composer in the same pane', async () => {
    const { agent, queue, history, scope, drain, cleanup } = await fixture();
    let pid = 123;
    let composer = 'not accepted by the old process';
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 100, agentProcessId: () => pid };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // restart before the previous native process consumes its draft
      sendKeys: async () => { pid = 456; composer = ''; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'not accepted by the old process'));
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      await expect(history.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // final redraw acceptance must remain tied to the original native process
  it('does not acknowledge a replacement process during the final capture', async () => {
    const { agent, queue, history, scope, drain, cleanup } = await fixture();
    let pid = 123;
    let submittedAt = 0;
    let finalCapture = false;
    const discovery = {
      worktreesNow: () => [],
      agentProcessId: () => pid,
      // expose replacement only after the final lifecycle scan returns
      target: async (_id: string, force = false) => {
        finalCapture ||= force && submittedAt > 0 && Date.now() - submittedAt >= 4_000;
        return { agent, socket };
      }
    };
    const tmux = {
      pastePrompt: async () => true,
      // switch the recognized descendant during the last redraw
      capture: async () => {
        // an empty replacement composer is not the old prompt's receipt
        if (finalCapture) { pid = 456; return '› '; }
        return '› final original draft';
      },
      sendKeys: async () => { submittedAt ||= Date.now(); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'final original draft'));
      expect(pid).toBe(456);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      await expect(history.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // a cached pane must be revalidated before pasting into its native process
  it('does not paste when the cached native process was replaced before delivery', async () => {
    const { agent, queue, scope, drain, cleanup } = await fixture();
    let pid = 123;
    const pastePrompt = vi.fn(async () => true);
    const sendKeys = vi.fn(async () => true);
    const discovery = {
      worktreesNow: () => [],
      agentProcessId: () => pid,
      // reveal a same-pane replacement only during a fresh lifecycle scan
      target: async (_id: string, force = false) => {
        // the replacement must never receive the old process's paste
        if (force) pid = 456;
        return { agent, socket };
      }
    };
    const tmux = { pastePrompt, sendKeys, capture: async () => '› replacement input' };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'for the original process'));
      expect(pastePrompt).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
      await expect(queue.list(scope)).resolves.toHaveLength(1);
    } finally { await cleanup(); }
  });

  // process identity can change while a slow cleanup capture is being inspected
  it('does not clear a native process replaced after ownership inspection', async () => {
    const { agent, queue, scope, drain, cleanup } = await fixture();
    let pid = 123;
    let submittedAt = 0;
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), agentProcessId: () => pid };
    const base = adapterFor('codex')!;
    const adapter = { ...base, submission: { ...base.submission,
      // reproduce replacement after capture but before destructive cleanup
      ownsDraft: (capture: string, prompt: string) => {
        const owned = base.submission.ownsDraft!(capture, prompt);
        // only the expired delivery window enters native cleanup
        if (submittedAt > 0 && Date.now() - submittedAt >= 4_000) pid = 456;
        return owned;
      }
    } };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› draft before replacement',
      // swallow submits without authorizing a replacement-process ctrl-c
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { submittedAt ||= Date.now(); sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, 'draft before replacement'));
      expect(pid).toBe(456);
      expect(sent.every(keys => keys.join() === 'Enter')).toBe(true);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
    } finally { await cleanup(); }
  });

  // missing ownership proof cannot authorize retries or destructive clearing
  it.each(['missing', 'collapsed', 'cropped'] as const)('keeps recovery pending for %s draft ownership', async mode => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    // exercise the accepted prompt limit without unbounded matcher compilation
    const prompt = { missing: 'no ownership observer', collapsed: '😀'.repeat(80), cropped: 'x'.repeat(32_000) }[mode];
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const base = adapterFor('codex')!;
    const adapter = { ...base, submission: { ...base.submission, ownsDraft: mode === 'missing' ? undefined : base.submission.ownsDraft } };
    const composer = { missing: `› ${prompt}`, collapsed: '› [Pasted Content 81 chars]', cropped: `› ${'x'.repeat(64)}` }[mode];
    const tmux = {
      pastePrompt: async () => true,
      // a collapsed label hides content that an operator could replace at equal length
      capture: async () => composer,
      // leave the original native submission unacknowledged
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, prompt));
      await settlePolling(service.observe(agent));
      expect(sent).toEqual([['Enter']]);
      expect(notes).toEqual([]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
    } finally { await cleanup(); }
  });

  // baseline discovery must not turn intervening operator edits into a submission
  it('preserves a draft edited before its first submit key', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let composer = 'original queued draft';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 100 };
    const base = adapterFor('codex')!;
    const adapter = { ...base, completion: {
      // simulate operator typing while the structured baseline read is in flight
      baseline: async () => { composer += ' plus operator changes'; return undefined; },
      since: async () => undefined
    } };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // no submit or clear may consume the edited native draft
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, 'original queued draft'));
      expect(sent).toEqual([]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      await settlePolling(service.observe(agent));
      expect(sent).toEqual([]);
      expect(composer).toBe('original queued draft plus operator changes');
      expect(notes).toEqual(['original queued draft']);
    } finally { await cleanup(); }
  });

  // forced lifecycle scans can outlive a previously inspected composer
  it.each(['initial', 'retry', 'clear'] as const)('recaptures input edited during the %s identity scan', async mode => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    const prompt = 'draft before identity scan';
    let composer = prompt;
    let submittedAt = 0;
    let changeOnNextScan = false;
    let edited = false;
    const sent: string[][] = [];
    const unsafeSent: string[][] = [];
    const discovery = {
      worktreesNow: () => [],
      // operator typing need not change the process id or its attention
      target: async (_id: string, force = false) => {
        // change input after an ownership check while fresh identity is awaited
        if (force && changeOnNextScan) { composer = `${prompt} plus operator changes`; changeOnNextScan = false; edited = true; }
        return { agent, socket };
      }
    };
    const base = adapterFor('codex')!;
    const adapter = { ...base, submission: { ...base.submission,
      // arm the scan race in exactly one delivery stage
      ownsDraft: (capture: string, text: string) => {
        const initial = mode === 'initial' && submittedAt === 0;
        const retry = mode === 'retry' && submittedAt > 0 && Date.now() - submittedAt < 4_000;
        const clearing = mode === 'clear' && submittedAt > 0 && Date.now() - submittedAt >= 4_000;
        changeOnNextScan ||= !edited && (initial || retry || clearing);
        return base.submission.ownsDraft!(capture, text);
      }
    } };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // fail immediately if stale ownership authorizes input against the edit
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        // record violations outside transport errors that production intentionally catches
        if (edited) unsafeSent.push(keys);
        submittedAt ||= Date.now();
        sent.push(keys);
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, prompt));
      await settlePolling(service.observe(agent));
      expect(edited).toBe(true);
      expect(unsafeSent).toEqual([]);
      expect(composer).toBe(`${prompt} plus operator changes`);
      expect(sent.every(keys => keys.join() === 'Enter')).toBe(true);
      expect(notes).toEqual([prompt]);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // lifecycle latency cannot authorize retry submission after its deadline
  it('does not retry after a forced scan exhausts the acceptance window', async () => {
    const { agent, queue, scope, drain, cleanup } = await fixture();
    let composer = 'slow lifecycle scan';
    let submitted = false;
    let stallNextScan = false;
    const sent: string[][] = [];
    const discovery = {
      worktreesNow: () => [],
      // consume the budget only after a retry owns the visible draft
      target: async (_id: string, force = false) => {
        // model a slow lifecycle response without changing process identity
        if (force && stallNextScan) { vi.setSystemTime(Date.now() + 5_000); stallNextScan = false; }
        return { agent, socket };
      }
    };
    const base = adapterFor('codex')!;
    const adapter = { ...base, submission: { ...base.submission,
      // stall the fresh scan requested by the first retry
      ownsDraft: (capture: string, prompt: string) => { stallNextScan ||= submitted; return base.submission.ownsDraft!(capture, prompt); }
    } };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // swallow the initial Enter but permit verified cleanup
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        submitted = true;
        // clear only after the submission window expires
        if (keys.join() === 'C-c') composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, 'slow lifecycle scan'));
      expect(sent).toEqual([['Enter'], ['C-c']]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
    } finally { await cleanup(); }
  });

  // remain-on-exit panes contain no live native composer to clean
  it('recovers the queue to notes when only a dead native pane remains', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let submittedAt = 0;
    const discovery = {
      worktreesNow: () => [],
      // lose the process after exhausting submission retries
      target: async () => submittedAt > 0 && Date.now() - submittedAt >= 4_000 ? undefined : { agent, socket }
    };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› dead pane draft',
      paneSnapshotsNow: () => new Map([[socket.path, { status: 'available' as const, panes: [{ paneId: agent.pane.paneId, dead: true }] }]]),
      // the native process never acknowledges the original draft
      sendKeys: async () => { submittedAt ||= Date.now(); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'dead pane draft'));
      await settlePolling(service.observe(agent));
      expect(notes).toEqual(['dead pane draft']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // unknown redraws must not finalize notes while failed native text can reappear
  it('keeps cleanup pending until a hidden composer becomes observable', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let hidden = false;
    let composer = 'temporarily hidden draft';
    let clears = 0;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => hidden ? '' : `› ${composer}`,
      // hide the composer after a swallowed submit and clear only when observed
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        // a verified cleanup may remove the visible draft
        if (keys.join() === 'C-c') { clears += 1; composer = ''; }
        else hidden = true;
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'temporarily hidden draft'));
      await settlePolling(service.observe(agent));
      expect(notes).toEqual([]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      hidden = false;
      await settlePolling(service.observe(agent));
      expect(clears).toBe(1);
      expect(composer).toBe('');
      expect(notes).toEqual(['temporarily hidden draft']);
    } finally { await cleanup(); }
  });

  // unavailable discovery is not evidence that the native draft disappeared
  it('keeps cleanup pending across a transient forced-discovery failure', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let composer = 'visible through scan failure';
    let submittedAt = 0;
    let available = false;
    const discovery = {
      worktreesNow: () => [],
      // fail only lifecycle revalidation once the submit budget expires
      target: async (_id: string, force = false) => {
        // preserve the original draft when the live scan cannot complete
        if (force && submittedAt > 0 && Date.now() - submittedAt >= 4_000 && !available) throw new Error('discovery unavailable');
        return { agent, socket };
      }
    };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // swallow submission but allow clearing after discovery recovers
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        submittedAt ||= Date.now();
        // clear only the known native draft
        if (keys.join() === 'C-c') composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'visible through scan failure'));
      await settlePolling(service.observe(agent));
      expect(notes).toEqual([]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      available = true;
      await settlePolling(service.observe(agent));
      expect(composer).toBe('');
      expect(notes).toEqual(['visible through scan failure']);
    } finally { await cleanup(); }
  });

  // native questions that appear after rendering must preserve deferred cleanup
  it('clears the draft after a pre-submit question returns to idle', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let composer = 'question interrupted delivery';
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 100 };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // only post-question cleanup may touch the remaining native draft
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); composer = ''; return true; }
    };
    const adapter = { ...adapterFor('codex')!, completion: {
      // surface a native question during the pre-submit baseline read
      baseline: async () => { agent.attention = 'question'; return undefined; },
      since: async () => undefined
    } };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => adapter);
    try {
      await settlePolling(service.submit(agent.id, 'question interrupted delivery'));
      expect(sent).toEqual([]);
      await settlePolling(service.observe(agent));
      expect(notes).toEqual([]);
      agent.attention = 'finished';
      await settlePolling(service.observe(agent));
      expect(sent).toEqual([['C-c']]);
      expect(notes).toEqual(['question interrupted delivery']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // a failed post-paste scan must reserve cleanup rather than allow repasting
  it('holds a pasted draft through its first forced discovery failure', async () => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let pasted = 0;
    let unavailable = true;
    let composer = '';
    const sent: string[][] = [];
    const discovery = {
      worktreesNow: () => [],
      // fail one scan immediately after the native paste lands
      target: async (_id: string, force = false) => {
        // retain the queue and cleanup descriptor through the failed scan
        if (force && pasted > 0 && unavailable) { unavailable = false; throw new Error('post-paste scan unavailable'); }
        return { agent, socket };
      }
    };
    const tmux = {
      // count any accidental duplicate paste after failed discovery
      pastePrompt: async () => { pasted += 1; composer = 'pasted before scan failure'; return true; },
      capture: async () => `› ${composer}`,
      // only cleanup may run after the failed delivery
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); composer = ''; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'pasted before scan failure'));
      expect(sent).toEqual([]);
      await settlePolling(service.observe(agent));
      expect(pasted).toBe(1);
      expect(sent).toEqual([['C-c']]);
      expect(notes).toEqual(['pasted before scan failure']);
      await expect(queue.list(scope)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // missing discovery must not hide a failed listing or temporary recognition loss
  it.each(['unavailable', 'present'] as const)('keeps cleanup pending while the native pane listing is %s', async listing => {
    const { agent, queue, scope, notes, drain, cleanup } = await fixture();
    let composer = 'native listing unavailable';
    let submittedAt = 0;
    let available = false;
    const discovery = {
      worktreesNow: () => [],
      // unavailable tmux listings normally make discovery resolve undefined
      target: async (_id: string, force = false) => force && submittedAt > 0 && Date.now() - submittedAt >= 4_000 && !available ? undefined : { agent, socket }
    };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => `› ${composer}`,
      // expose the same incomplete inventory marker as the production transport
      paneSnapshotsNow: () => new Map([[socket.path, listing === 'unavailable' ? { status: 'unavailable' as const } : { status: 'available' as const, panes: [{ paneId: agent.pane.paneId }] }]]),
      // preserve the draft until lifecycle discovery becomes available again
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        submittedAt ||= Date.now();
        // clear only after an observed native target returns
        if (keys.join() === 'C-c') composer = '';
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
    try {
      await settlePolling(service.submit(agent.id, 'native listing unavailable'));
      await settlePolling(service.observe(agent));
      expect(notes).toEqual([]);
      await expect(queue.list(scope)).resolves.toHaveLength(1);
      available = true;
      await settlePolling(service.observe(agent));
      expect(composer).toBe('');
      expect(notes).toEqual(['native listing unavailable']);
    } finally { await cleanup(); }
  });
});
