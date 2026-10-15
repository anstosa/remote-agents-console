import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../src/adapters/registry.js';
import type { CompletionBaseline } from '../src/adapters/types.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService } from '../src/prompts/service.js';
import { testWorktree } from './helpers/config.js';

// a server restart must not forget a reset while the terminal keeps its old rollout open
describe('prompt reset restart recovery', () => {
  // restore the clock after each isolated lifecycle
  afterEach(() => vi.useRealTimers());

  // preserve the boundary both with durable follow-ups and with an initially empty queue
  it.each(['queued', 'empty', 'interrupted-removal', 'sibling-first'] as const)('recovers reset readiness and completion after %s restart', async scenario => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-restart-'));
    const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };
    const agent = { id: 'socket:%1', paneId: '%1', home: '/tmp', kind: 'codex' as const, title: 'Ready', attention: 'finished' as 'finished' | 'working' };
    const sibling = { ...agent, id: 'socket:%2', paneId: '%2' };
    const worktree = testWorktree({ path: '/tmp' });
    const scope = `agent:${agent.id}`;
    const pasted: string[] = [];
    const saved: string[] = [];
    let composer = '';
    let loading = false;
    let completed = false;
    // keep the same real terminal identity across service instances
    const discovery = { worktreesNow: () => [worktree], target: async (id: string) => ({ agent: id === sibling.id ? sibling : agent, socket }), paneProcessId: () => 123, paneWorkingDirectory: () => '/tmp' };
    const tmux = {
      // expose every attempted delivery
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // advance render polling while leaving filesystem operations real
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `${loading ? 'model: loading\n' : ''}› ${composer}`; },
      // reset startup looks busy but never produces a model answer
      sendKeys: async () => { loading = composer.trim() === '/clear'; composer = ''; agent.attention = 'working'; return true; }
    };
    const adapter = {
      ...adapterFor('codex')!,
      completion: {
        // the pre-reset file remains open until the first real turn starts
        baseline: async (_pane: unknown, resetAt?: number): Promise<CompletionBaseline> => resetAt === undefined
          ? { rollout: 'old.jsonl', ordinal: 3 }
          : { cwd: '/tmp', resetAt, ordinal: 0 },
        // only the recovered reset boundary can see the fresh answer
        since: async (baseline: CompletionBaseline) => completed && 'resetAt' in baseline
          ? { kind: 'completed' as const, ordinal: 4, answer: 'Recovered fresh answer' }
          : { kind: 'pending' as const }
      }
    };
    // fail visibly if a valid follow-up is misclassified as undelivered
    const drain = async (_scope: string, prompt: { text: string }) => { saved.push(prompt.text); return true; };
    // reopen every durable store rather than accidentally sharing process-local state
    const restart = () => {
      const queue = new QueuedPromptService(join(directory, 'queue.json'));
      const history = new PromptHistoryService(join(directory, 'history.json'));
      return { service: new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter), history, queue };
    };
    try {
      const first = restart();
      // simulate stopping after durable acknowledgement but before queue consumption
      if (scenario === 'interrupted-removal') {
        vi.spyOn(first.queue, 'remove').mockRejectedValueOnce(new Error('server stopped'));
        await expect(first.service.submit(agent.id, '/clear')).rejects.toThrow('server stopped');
      } else {
        await first.service.submit(agent.id, '/clear');
      }
      // exercise both sides of the restart boundary
      if (scenario === 'queued') await first.service.submit(agent.id, 'first follow-up');
      const recovered = restart();
      // a duplicate pane must not steal another Agent's reset ownership
      if (scenario === 'sibling-first') await recovered.service.observe(sibling);
      // lifecycle reservations must hydrate pending resets before allowing a restart
      if (scenario === 'queued') await expect(recovered.service.acquireRestartLock(agent.id)).resolves.toBeUndefined();
      // input can arrive before the observer has hydrated the new service
      if (scenario !== 'queued') await recovered.service.submit(agent.id, 'first follow-up');
      await recovered.service.submit(agent.id, 'second follow-up');
      vi.setSystemTime(Date.now() + 2_000);
      await recovered.service.observe(agent);
      agent.attention = 'finished';
      await recovered.service.observe(agent);
      expect(pasted).toEqual(['/clear']);
      loading = false;
      // even after the grace window only the reset owner may settle or expire it
      if (scenario === 'sibling-first') {
        vi.setSystemTime(Date.now() + 11_000);
        await recovered.service.observe(sibling);
      }
      await recovered.service.observe(agent);
      expect(pasted).toEqual(['/clear', 'first follow-up']);
      completed = true;
      agent.attention = 'finished';
      await recovered.service.observe(agent);
      expect(pasted).toEqual(['/clear', 'first follow-up', 'second follow-up']);
      expect(saved).toEqual([]);
      await expect(recovered.service.listQueued(agent.id)).resolves.toEqual([]);
      // later server instances must not reapply the consumed first-turn boundary
      await expect(new QueuedPromptService(join(directory, 'queue.json')).resets.get(scope)).resolves.toBeUndefined();
      await expect(recovered.history.list(scope)).resolves.toMatchObject([
        { text: 'second follow-up' }, { text: 'first follow-up', answer: 'Recovered fresh answer' }
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
