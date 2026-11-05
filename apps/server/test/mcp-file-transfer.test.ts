import { createHash } from 'node:crypto';
import type { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { HostFilesOwnerContext, HostFilesPlace } from '../src/host-files/contracts.js';
import { McpFileTransferService, mcpFileLimits } from '../src/host-files/mcp-transfer.js';
import type { HostFilesService } from '../src/host-files/service.js';

const owner: HostFilesOwnerContext = { namespace: 'davo', principalOwnerKey: 'owner', leaseKey: 'lease' };
const place: HostFilesPlace = { id: 'worktree', home: '/worktree' };
const digest = (value: Buffer) => createHash('sha256').update(value).digest('base64url');

// construct one held atomic-writer seam
function harness() {
  let held: Readable | undefined;
  const prepareUpload = vi.fn(async () => ({ uploadId: 'upload', conflicts: [] }));
  const authorizeUpload = vi.fn(async () => ({ files: [{ clientId: 'client', token: 'token', destinationName: 'file.bin' }] }));
  const upload = vi.fn(async (_place: HostFilesPlace, _owner: HostFilesOwnerContext, _uploadId: string, _clientId: string, _token: string, source: Readable) => await new Promise<{ result: { destinationPath: string } }>((resolve, reject) => {
    held = source;
    source.once('error', reject);
    source.once('end', () => resolve({ result: { destinationPath: '/worktree/file.bin' } }));
    source.resume();
    source.pause();
  }));
  const files = { prepareUpload, authorizeUpload, upload, list: vi.fn(async () => ({ entries: [{ name: 'file.bin', objectToken: 'object', size: 81_920 }] })), objectPlaceId: vi.fn(() => 'worktree'), readFileChunk: vi.fn(async () => ({ bytes: Buffer.from('data'), size: 4, digest: digest(Buffer.from('data')) })) } as unknown as HostFilesService;
  let allowed = true;
  const resolve = vi.fn(async (_id: string, _owner: HostFilesOwnerContext) => allowed ? place : undefined);
  return { service: new McpFileTransferService(files, resolve), files, prepareUpload, authorizeUpload, upload, resolve, release: () => held?.resume(), blocked: () => (held as PassThrough | undefined)?.writableNeedDrain === true, revoke: () => { allowed = false; } };
}

describe('MCP file transfers', () => {
  it('reserves concurrent begin capacity before asynchronous preparation', async () => {
    const releases: Array<() => void> = [];
    const prepareUpload = vi.fn(async () => await new Promise<{ uploadId: string; conflicts: [] }>(resolve => {
      releases.push(() => resolve({ uploadId: 'upload', conflicts: [] }));
    }));
    const upload = vi.fn(async (_place: HostFilesPlace, _owner: HostFilesOwnerContext, _uploadId: string, _clientId: string, _token: string, source: Readable) => await new Promise<{ result: { destinationPath: string } }>((resolve, reject) => {
      source.once('error', reject);
      source.once('end', () => resolve({ result: { destinationPath: '/worktree/file.bin' } }));
      source.resume();
    }));
    const files = { prepareUpload, authorizeUpload: vi.fn(async () => ({ files: [{ token: 'token', destinationName: 'file.bin' }] })), upload } as unknown as HostFilesService;
    const service = new McpFileTransferService(files, async () => place);
    const starts = [0, 1, 2].map(() => service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 1, collision: 'fail' }));
    const refused = starts[2]!.then(() => undefined, error => error);
    await vi.waitFor(() => { expect(prepareUpload).toHaveBeenCalledTimes(2); });
    await expect(refused).resolves.toMatchObject({ code: 'limit_exceeded' });
    // release both admitted preparations
    for (const release of releases) release();
    const admitted = await Promise.all(starts.slice(0, 2));
    expect(upload).toHaveBeenCalledTimes(2);
    // clean up both private stages
    for (const transfer of admitted) await service.cancel(owner, transfer.transfer_id);
  });

  it('serializes duplicate offsets so exactly one chunk changes the digest and offset', async () => {
    const { service, release, upload } = harness();
    const started = await service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 81_920, collision: 'fail' });
    const bytes = Buffer.alloc(40_960, 1);
    const input = { transferId: started.transfer_id, offset: 0, dataBase64: bytes.toString('base64'), sha256: digest(bytes) };
    const results = await Promise.allSettled([service.chunk(owner, input), service.chunk(owner, input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(service.status(owner, started.transfer_id)).resolves.toMatchObject({ state: 'active', next_offset: 40_960 });
    release();
    const tail = Buffer.alloc(40_960, 2);
    await service.chunk(owner, { transferId: started.transfer_id, offset: bytes.length, dataBase64: tail.toString('base64'), sha256: digest(tail) });
    await expect(service.finalize(owner, started.transfer_id, digest(Buffer.concat([bytes, tail])))).resolves.toMatchObject({ status: 'ready', file: { size: 81_920 } });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('lets cancellation interrupt held backpressure ahead of queued finalize', async () => {
    const { service, blocked } = harness();
    const started = await service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 122_880, collision: 'fail' });
    const first = Buffer.alloc(40_960, 1);
    const second = Buffer.alloc(40_960, 2);
    const third = Buffer.alloc(40_960, 3);
    await service.chunk(owner, { transferId: started.transfer_id, offset: 0, dataBase64: first.toString('base64'), sha256: digest(first) });
    await service.chunk(owner, { transferId: started.transfer_id, offset: first.length, dataBase64: second.toString('base64'), sha256: digest(second) });
    const held = service.chunk(owner, { transferId: started.transfer_id, offset: first.length + second.length, dataBase64: third.toString('base64'), sha256: digest(third) });
    const finalized = service.finalize(owner, started.transfer_id, digest(Buffer.concat([first, second, third])));
    await vi.waitFor(() => { expect(blocked()).toBe(true); });
    await expect(service.cancel(owner, started.transfer_id)).resolves.toEqual({ cancelled: true });
    await expect(held).rejects.toBeDefined();
    await expect(finalized).rejects.toBeDefined();
    await expect(service.status(owner, started.transfer_id)).resolves.toMatchObject({ state: 'cancelled', next_offset: first.length + second.length });
  });

  it('rechecks owner-scoped Place access for uploads, files, and Note capabilities', async () => {
    const first = harness();
    first.revoke();
    await expect(first.service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 1, collision: 'fail' })).rejects.toMatchObject({ code: 'not_found' });
    expect(first.prepareUpload).not.toHaveBeenCalled();
    await expect(first.service.download(owner, 'object-token', 0)).rejects.toMatchObject({ code: 'not_found' });
    expect((first.files.readFileChunk as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const second = harness();
    const load = vi.fn(async () => Buffer.from('note'));
    const note = second.service.noteAttachment(owner, 'note.txt', 4, digest(Buffer.from('note')), load, { worktreeId: place.id, noteId: 'note' });
    second.revoke();
    await expect(second.service.download(owner, note.object_token, 0)).rejects.toMatchObject({ code: 'not_found' });
    expect(load).not.toHaveBeenCalled();
  });

  it('handles an early writer rejection and exposes only a sanitized failure', async () => {
    const secret = '/private/root/file.bin: backend exploded';
    const upload = vi.fn(async () => { throw new Error(secret); });
    const files = {
      prepareUpload: vi.fn(async () => ({ uploadId: 'upload', conflicts: [] })),
      authorizeUpload: vi.fn(async () => ({ files: [{ token: 'token', destinationName: 'file.bin' }] })),
      upload,
    } as unknown as HostFilesService;
    const service = new McpFileTransferService(files, async () => place);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const started = await service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 0, collision: 'fail' });
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(service.finalize(owner, started.transfer_id, digest(Buffer.alloc(0)))).rejects.toMatchObject({ code: 'partial_failure', message: 'upload failed' });
      const status = await service.status(owner, started.transfer_id);
      expect(status).toMatchObject({ state: 'failed', error: 'upload failed' });
      expect(JSON.stringify(status)).not.toContain(secret);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // failed writers must release held chunk backpressure without waiting for expiry
  it('interrupts a held chunk when the backend writer rejects', async () => {
    let rejectWriter!: (error: Error) => void;
    let source!: PassThrough;
    const files = {
      prepareUpload: vi.fn(async () => ({ uploadId: 'upload', conflicts: [] })),
      authorizeUpload: vi.fn(async () => ({ files: [{ token: 'token', destinationName: 'file.bin' }] })),
      upload: vi.fn(async (_place: HostFilesPlace, _owner: HostFilesOwnerContext, _uploadId: string, _clientId: string, _token: string, stream: PassThrough) => {
        source = stream;
        return await new Promise<never>((_resolve, reject) => { rejectWriter = reject; });
      })
    } as unknown as HostFilesService;
    const service = new McpFileTransferService(files, async () => place);
    try {
      const started = await service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 122_880, collision: 'fail' });
      const bytes = Buffer.alloc(40_960, 1);
      await service.chunk(owner, { transferId: started.transfer_id, offset: 0, dataBase64: bytes.toString('base64'), sha256: digest(bytes) });
      await service.chunk(owner, { transferId: started.transfer_id, offset: bytes.length, dataBase64: bytes.toString('base64'), sha256: digest(bytes) });
      const held = service.chunk(owner, { transferId: started.transfer_id, offset: bytes.length * 2, dataBase64: bytes.toString('base64'), sha256: digest(bytes) }).then(() => undefined, error => error);
      await vi.waitFor(() => { expect(source.writableNeedDrain).toBe(true); });
      rejectWriter(new Error('/private/root: writer failed'));
      await vi.waitFor(async () => { expect(await service.status(owner, started.transfer_id)).toMatchObject({ state: 'failed', error: 'upload failed' }); });
      const refusal = await held;
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal.message).not.toContain('/private/root');
    } finally {
      // settle the isolated backend even when an assertion fails
      rejectWriter?.(new Error('test cleanup'));
      await service.close();
    }
  });

  it('refuses retained-record overflow without evicting recoverable transfers', async () => {
    const prepareUpload = vi.fn(async () => ({ uploadId: 'upload', conflicts: [] }));
    const upload = vi.fn(async (_place: HostFilesPlace, _owner: HostFilesOwnerContext, _uploadId: string, _clientId: string, _token: string, source: Readable) => await new Promise<{ result: { destinationPath: string } }>((resolve, reject) => {
      source.once('error', reject);
      source.once('end', () => resolve({ result: { destinationPath: '/worktree/file.bin' } }));
      source.resume();
    }));
    const files = {
      prepareUpload,
      authorizeUpload: vi.fn(async () => ({ files: [{ token: 'token', destinationName: 'file.bin' }] })),
      upload,
      list: vi.fn(async () => ({ entries: [{ name: 'file.bin', objectToken: 'object', size: 0 }] })),
    } as unknown as HostFilesService;
    const service = new McpFileTransferService(files, async () => place);
    // fill the bounded owner recovery window with terminal records
    for (let index = 0; index < mcpFileLimits.retainedOwner; index += 1) {
      const started = await service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 0, collision: 'fail' });
      await service.finalize(owner, started.transfer_id, digest(Buffer.alloc(0)));
    }
    await expect(service.begin(owner, { placeId: place.id, destinationToken: 'destination', name: 'file.bin', totalBytes: 0, collision: 'fail' })).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(prepareUpload).toHaveBeenCalledTimes(mcpFileLimits.retainedOwner);
  });
});
