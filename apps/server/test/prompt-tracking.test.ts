import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { AttentionState, CompletionEvent } from '../src/adapters/types.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService } from '../src/prompts/service.js';

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
      paneProcessId: () => 42
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
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => adapter as never);

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
});
