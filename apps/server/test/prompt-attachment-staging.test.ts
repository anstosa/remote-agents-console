import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { stated } from './helpers/agent.js';

// track file-descriptor pressure at the filesystem boundary
const writes = vi.hoisted(() => ({ active: 0, peak: 0, completed: 0, failAfter: undefined as number | undefined }));

// retain real files while observing staging writes and injecting disk exhaustion
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...filesystem,
    // instrument only attachment files in the isolated checkout
    writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
      // leave durable queue writes unchanged
      if (!String(args[0]).includes('/.remote-agent-console/attachments/')) return filesystem.writeFile(...args);
      writes.active += 1;
      writes.peak = Math.max(writes.peak, writes.active);
      try {
        // fail after some files have reached disk
        if (writes.completed === writes.failAfter) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
        await filesystem.writeFile(...args);
        writes.completed += 1;
      } finally {
        writes.active -= 1;
      }
    }
  };
});

// isolate filesystem observations between deliveries
beforeEach(() => {
  writes.active = 0;
  writes.peak = 0;
  writes.completed = 0;
  writes.failAfter = undefined;
});

// preserve complete batches without exhausting attachment file descriptors
describe('attachment staging', () => {
  // deliver every file while keeping filesystem concurrency bounded
  it('stages a large batch with bounded writes and intact attachment bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-large-attachment-batch-'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: directory, title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };
    // distinguish every file in a batch well beyond the former cap
    const attachments = Array.from({ length: 256 }, (_, index) => ({ name: `context-${index}.txt`, data: Buffer.from(`context ${index}`).toString('base64') }));
    let pasted = '';
    const service = new PromptService({ worktreesNow: () => [], target: async () => ({ agent, socket }) } as never, {
      // retain outbound references without submitting to a live agent
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted = prompt; return true; },
      // accept the isolated prompt
      sendKeys: async () => true
    } as never);
    try {
      await expect(service.submit(agent.id, '', attachments)).resolves.toBe(true);
      expect(writes.peak).toBe(1);
      const paths = pasted.split('\n').slice(1);
      expect(paths).toHaveLength(attachments.length);
      // check all staged bytes without creating read-side descriptor pressure
      for (const [index, path] of paths.entries()) {
        await expect(readFile(join(directory, path.slice(1).trimEnd()), 'utf8')).resolves.toBe(`context ${index}`);
      }
    } finally {
      // remove only the isolated attachment checkout
      await rm(directory, { recursive: true, force: true });
    }
  });

  // retain the durable batch when storage fails after partial staging
  it('cleans partial staging and retains the complete queue after a write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-failed-attachment-batch-'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: directory, title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    // retain a batch larger than the former cap on failure
    const attachments = Array.from({ length: 16 }, (_, index) => ({ name: `context-${index}.txt`, data: 'eA==' }));
    let pasted = false;
    writes.failAfter = 4;
    const service = new PromptService({ worktreesNow: () => [], target: async () => ({ agent, socket }) } as never, {
      // detect accidental delivery after staging fails
      pastePrompt: async () => { pasted = true; return true; },
      // keep the external boundary isolated
      sendKeys: async () => true
    } as never, undefined, queue);
    try {
      await expect(service.submit(agent.id, '', attachments)).resolves.toBe(true);
      expect(pasted).toBe(false);
      await expect(queue.next(`agent:${agent.id}`)).resolves.toMatchObject({ attachments });
      await expect(readdir(join(directory, 'node_modules/.remote-agent-console/attachments'))).resolves.toEqual([]);
    } finally {
      // remove only the failed delivery fixture
      await rm(directory, { recursive: true, force: true });
    }
  });
});
