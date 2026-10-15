import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { maxStoredAttachmentFootprintBytes } from '../src/prompts/validation.js';

describe('QueuedPromptService', () => {
  // reject unsafe attachments without mutating already queued work
  it.each([
    { label: 'malformed base64', attachments: [{ name: 'context.txt', data: 'invalid' }] },
    { label: 'empty payload', attachments: [{ name: 'context.txt', data: '' }] },
    { label: 'unsafe filename', attachments: [{ name: '../context.txt', data: 'eA==' }] },
    { label: 'duplicate filename', attachments: [{ name: 'context.txt', data: 'eA==' }, { name: ' context.txt ', data: 'eA==' }] }
  ])('rejects $label attachments while retaining the existing queue', async ({ attachments }) => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-queued-attachments-'));
    try {
      const service = new QueuedPromptService(join(directory, 'queue.json'));
      const kept = await service.enqueue('worktree:cora', 'Keep this prompt');
      await expect(service.enqueue('worktree:cora', 'Reject this prompt', attachments)).resolves.toBeUndefined();
      await expect(service.list('worktree:cora')).resolves.toEqual([kept]);
    } finally {
      // remove only the isolated queue fixture
      await rm(directory, { recursive: true, force: true });
    }
  });

  // allow the encoded form of the full decoded budget plus conservative metadata overhead
  it('keeps the serialized attachment budget above the prior bounded payload footprint', () => {
    const encodedDecodedBudget = Math.ceil((100 * 1024 * 1024) / 3) * 4;
    expect(maxStoredAttachmentFootprintBytes).toBeGreaterThan(encodedDecodedBudget + 1024 * 1024);
  });

  it('keeps a prompt\'s origin across a reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-origin-'));
    const file = join(directory, 'queue.json');
    try {
      await new QueuedPromptService(file).enqueue('agent:socket:%1', 'Remember where', [], { home: '/worktrees/cora', placeId: 'place-1' });
      await expect(new QueuedPromptService(file).next('agent:socket:%1')).resolves.toMatchObject({ text: 'Remember where', origin: { home: '/worktrees/cora', placeId: 'place-1' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('moves a scope\'s prompts ahead of the destination\'s, and refuses past the per-scope cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-move-scope-'));
    try {
      const service = new QueuedPromptService(join(directory, 'queue.json'));
      await service.enqueue('agent:old', 'First');
      await service.enqueue('agent:new', 'Second');
      await expect(service.moveScope('agent:old', 'agent:new')).resolves.toBe(true);
      await expect(service.list('agent:new')).resolves.toMatchObject([{ text: 'First' }, { text: 'Second' }]);
      await expect(service.scopes()).resolves.toEqual(['agent:new']);

      for (let index = 0; index < 49; index += 1) await service.enqueue('agent:full', `Full ${index}`);
      await expect(service.moveScope('agent:new', 'agent:full')).resolves.toBe(false);
      await expect(service.list('agent:new')).resolves.toHaveLength(2);
      await expect(service.list('agent:full')).resolves.toHaveLength(49);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not create storage while an empty queue is observed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-empty-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      await expect(service.next('worktree:cora')).resolves.toBeUndefined();
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('persists prompts and supports editing, reordering, and cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      const first = await service.enqueue('worktree:cora', 'First prompt');
      const second = await service.enqueue('worktree:cora', 'Second prompt', [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }]);
      expect(first).toBeDefined();
      expect(second).toMatchObject({ text: 'Second prompt', attachments: [{ name: 'context.txt', size: 7 }] });

      await expect(service.update('worktree:cora', second!.id, 'Edited second prompt')).resolves.toMatchObject({ text: 'Edited second prompt' });
      await expect(service.move('worktree:cora', second!.id, 'earlier')).resolves.toMatchObject([{ id: second!.id }, { id: first!.id }]);
      await expect(service.move('worktree:cora', second!.id, 'later')).resolves.toMatchObject([{ id: first!.id }, { id: second!.id }]);
      await expect(service.remove('worktree:cora', first!.id)).resolves.toMatchObject({ id: first!.id });

      await expect(new QueuedPromptService(file).list('worktree:cora')).resolves.toMatchObject([{ id: second!.id, text: 'Edited second prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // retain every valid file across queue persistence without a count cap
  it('persists more than ten attachments within the queue byte budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-many-queued-attachments-'));
    const file = join(directory, 'queue.json');
    // create distinct one-byte files beyond the former count cap
    const attachments = Array.from({ length: 11 }, (_, index) => ({ name: `context-${index}.txt`, data: 'eA==' }));
    try {
      const service = new QueuedPromptService(file);
      // summarize every payload without exposing stored bytes
      const summaries = attachments.map(attachment => ({ name: attachment.name, size: 1 }));
      await expect(service.enqueue('worktree:cora', 'Review every file', attachments)).resolves.toMatchObject({ attachments: summaries });
      await expect(new QueuedPromptService(file).list('worktree:cora')).resolves.toMatchObject([{ attachments: summaries }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // reject metadata-heavy attachment growth without changing the durable queue
  it('enforces the serialized attachment footprint on writes and reloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-attachment-footprint-'));
    const file = join(directory, 'queue.json');
    // create valid tiny payloads with large serialized filenames
    const attachments = Array.from({ length: 2 }, (_, index) => ({ name: `${'a'.repeat(200)}-${index}.txt`, data: 'eA==' }));
    try {
      const service = new QueuedPromptService(file, 750);
      const accepted = await service.enqueue('worktree:cora', 'Keep this prompt', attachments);
      await expect(service.enqueue('worktree:cora', 'Reject this prompt', attachments)).resolves.toBeUndefined();
      await expect(service.list('worktree:cora')).resolves.toMatchObject([{ id: accepted!.id, text: 'Keep this prompt' }]);
      await expect(new QueuedPromptService(file, 750).list('worktree:cora')).resolves.toMatchObject([{ id: accepted!.id }]);
      await expect(new QueuedPromptService(file, 400).list('worktree:cora')).rejects.toThrow('queued prompts file exceeds storage limits');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('clears a whole scope when its Worktree is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-clear-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      await service.enqueue('proj:/wts/cora', 'keep me');
      await service.enqueue('proj:/wts/dana', 'drop me');
      await service.clearScope('proj:/wts/dana');
      expect(await service.list('proj:/wts/dana')).toEqual([]);
      // a sibling scope is untouched, and the change is durable
      await expect(new QueuedPromptService(file).list('proj:/wts/cora')).resolves.toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('only removes a queued prompt after its consumer succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-consume-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
      const prompt = await service.enqueue('worktree:cora', 'Save this prompt', [attachment]);

      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async queued => {
        expect(queued).toMatchObject({ text: 'Save this prompt', attachments: [attachment] });
        return false;
      })).resolves.toBe('failed');
      await expect(service.list('worktree:cora')).resolves.toHaveLength(1);

      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async () => true)).resolves.toBe('consumed');
      await expect(service.list('worktree:cora')).resolves.toEqual([]);
      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async () => true)).resolves.toBe('missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
