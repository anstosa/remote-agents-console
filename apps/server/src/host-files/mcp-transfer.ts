import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { hostFilesOwner, sameHostFilesOwner, type HostFilesOwnerContext, type HostFilesPlace } from './contracts.js';
import { HostFilesError, type HostFilesItemResult } from './contracts.js';
import type { HostFilesService } from './service.js';

export const mcpFileLimits = {
  chunkBytes: 40_960,
  fileBytes: 64 * 1024 * 1024,
  activeOwner: 2,
  activeGlobal: 8,
  declaredOwnerBytes: 128 * 1024 * 1024,
  declaredGlobalBytes: 512 * 1024 * 1024,
  retainedOwner: 32,
  retainedGlobal: 128,
  inactivityMs: 2 * 60_000,
  lifetimeMs: 30 * 60_000,
} as const;

export type McpFileRef = { object_token: string; name: string; size: number; mime?: string };
export type McpTransferView = { transfer_id: string; state: 'active' | 'ready' | 'cancelled' | 'failed'; next_offset: number; total_bytes: number; inactivity_expires_at: string; absolute_expires_at: string; error?: string; file?: McpFileRef };
type ActiveTransfer = {
  id: string;
  owner: HostFilesOwnerContext;
  place: HostFilesPlace;
  destinationToken: string;
  name: string;
  totalBytes: number;
  mime?: string;
  nextOffset: number;
  startedAt: number;
  touchedAt: number;
  stream: PassThrough;
  hash: ReturnType<typeof createHash>;
  upload: Promise<{ result: HostFilesItemResult }>;
  state: McpTransferView['state'];
  error?: string;
  file?: McpFileRef;
  mutation: Promise<void>;
};

// stream bounded MCP chunks directly into the existing atomic Host Files writer
export class McpFileTransferService {
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly reservations = new Map<symbol, { owner: HostFilesOwnerContext; totalBytes: number }>();
  private readonly virtual = new Map<string, { owner: HostFilesOwnerContext; name: string; size: number; mime?: string; expiresAt: number; digest: string; context: { worktreeId: string; noteId: string }; load: (offset: number, maxBytes: number) => Promise<Buffer> }>();

  // retain only the existing service, Place resolver and clock
  constructor(private readonly files: HostFilesService, private readonly place: (id: string, owner: HostFilesOwnerContext) => Promise<HostFilesPlace | undefined>, private readonly now: () => number = Date.now) {}

  // begin one exact-size upload without creating a second spool
  async begin(owner: HostFilesOwnerContext, input: { placeId: string; destinationToken: string; name: string; totalBytes: number; mime?: string; collision: 'fail' | 'keep_both' | 'replace' }): Promise<McpTransferView> {
    await this.prune();
    // validate the requested reservation before admission
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > mcpFileLimits.fileBytes) throw new HostFilesError('limit_exceeded', 'invalid MCP file size', 413);
    const reservation = this.reserve(owner, input.totalBytes);
    try {
      const place = await this.place(input.placeId, owner);
      // require one configured Place
      if (place === undefined) throw new HostFilesError('not_found', 'Place not found', 404);
      const clientId = randomBytes(18).toString('base64url');
      const prepared = await this.files.prepareUpload(place, owner, { destinationDirectoryToken: input.destinationToken, files: [{ clientId, name: input.name, size: input.totalBytes }] });
      // recheck Place authority after asynchronous preparation
      await this.currentPlace(owner, place);
      const decisions: Record<string, 'replace' | 'skip' | 'keep-both'> = {};
      // resolve every current conflict through the requested bounded policy
      for (const conflict of prepared.conflicts) {
        // fail collisions without authorizing a body
        if (input.collision === 'fail') throw new HostFilesError('conflict', 'destination already exists', 409);
        decisions[conflict.id] = input.collision === 'replace' ? 'replace' : 'keep-both';
      }
      const authorized = await this.files.authorizeUpload(place, owner, prepared.uploadId, decisions);
      // recheck Place authority immediately before opening the writer
      await this.currentPlace(owner, place);
      const file = authorized.files[0];
      // a single-file MCP upload never selects skip
      if (file?.token === undefined) throw new HostFilesError('conflict', 'upload was not authorized', 409);
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      // a writer may reject before installing its own stream error listener
      stream.on('error', () => undefined);
      const id = randomBytes(18).toString('base64url');
      const now = this.now();
      const upload = this.files.upload(place, owner, prepared.uploadId, clientId, file.token, stream);
      const transfer: ActiveTransfer = { id, owner: hostFilesOwner(owner), place, destinationToken: input.destinationToken, name: file.destinationName, totalBytes: input.totalBytes, ...(input.mime === undefined ? {} : { mime: input.mime }), nextOffset: 0, startedAt: now, touchedAt: now, stream, hash: createHash('sha256'), upload, state: 'active', mutation: Promise.resolve() };
      // settle failed writers immediately and release any held drain without leaking details
      void upload.catch(() => {
        // cancellation and terminal results retain their original outcome
        if (transfer.state !== 'active') return;
        transfer.state = 'failed';
        transfer.error = 'upload failed';
        transfer.touchedAt = this.now();
        stream.destroy(new Error('upload failed'));
      });
      // replace the reservation with its retained transfer without yielding
      this.reservations.delete(reservation);
      this.transfers.set(id, transfer);
      return this.view(transfer);
    } finally {
      // release failed or completed admission attempts
      this.reservations.delete(reservation);
    }
  }

  // accept one exact next chunk and its digest
  async chunk(owner: HostFilesOwnerContext, input: { transferId: string; offset: number; dataBase64: string; sha256: string }): Promise<{ transfer_id: string; next_offset: number; accepted_bytes: number }> {
    await this.prune();
    // require one canonical base64 payload within the decoded cap
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.dataBase64)) throw new HostFilesError('invalid_request', 'chunk is not canonical base64', 400);
    const bytes = Buffer.from(input.dataBase64, 'base64');
    const actual = createHash('sha256').update(bytes).digest('base64url');
    // compare the caller digest without timing disclosure
    if (!sameDigest(actual, input.sha256)) throw new HostFilesError('invalid_request', 'chunk digest mismatch', 400);
    const transfer = this.transfer(owner, input.transferId);
    return await this.serialize(transfer, async () => {
      let current = this.active(owner, input.transferId, true);
      // reauthorize the Place before writing another private-stage chunk
      await this.currentPlace(owner, current.place);
      current = this.active(owner, input.transferId, true);
      // enforce exact offset, bounded chunk and declared total inside the transfer lane
      if (input.offset !== current.nextOffset || bytes.length > mcpFileLimits.chunkBytes || current.nextOffset + bytes.length > current.totalBytes) throw new HostFilesError('stale_object', 'unexpected upload offset', 409);
      current.hash.update(bytes);
      // honor writer backpressure without letting another mutation pass
      if (!current.stream.write(bytes)) await once(current.stream, 'drain');
      // cancellation during backpressure never advances the public offset
      if (current.state !== 'active') throw new HostFilesError('not_found', 'transfer unavailable', 404);
      current.nextOffset += bytes.length;
      current.touchedAt = this.now();
      return { transfer_id: current.id, next_offset: current.nextOffset, accepted_bytes: bytes.length };
    });
  }

  // close the atomic writer only after exact size and whole-file digest checks
  async finalize(owner: HostFilesOwnerContext, transferId: string, totalSha256: string): Promise<{ file: McpFileRef; status: 'ready' }> {
    await this.prune();
    const transfer = this.transfer(owner, transferId);
    return await this.serialize(transfer, async () => {
      // an already failed writer has no publishable file or raw backend error
      if (transfer.state === 'failed') throw new HostFilesError('partial_failure', 'upload failed', 500);
      let current = this.active(owner, transferId, true);
      // reauthorize the Place before publishing the private stage
      await this.currentPlace(owner, current.place);
      current = this.active(owner, transferId, true);
      // refuse short uploads before ending the writer
      if (current.nextOffset !== current.totalBytes) throw new HostFilesError('invalid_request', 'upload is incomplete', 409);
      const actual = current.hash.digest('base64url');
      // destroy the stage on a mismatched final digest
      if (!sameDigest(actual, totalSha256)) {
        await this.cancelActive(current, 'total digest mismatch');
        throw new HostFilesError('invalid_request', 'total digest mismatch', 400);
      }
      current.stream.end();
      try {
        const settled = await current.upload;
        // cancellation wins over a concurrently settling writer
        current = this.active(owner, transferId, true);
        const path = settled.result.destinationPath;
        // a successful atomic write always names its destination
        if (path === undefined) throw new HostFilesError('partial_failure', 'upload destination unavailable', 500);
        const place = await this.currentPlace(owner, current.place);
        current = this.active(owner, transferId, true);
        const listed = await this.files.list(place, current.owner, dirname(path));
        await this.currentPlace(owner, current.place);
        current = this.active(owner, transferId, true);
        const entry = listed.entries.find(candidate => candidate.name === current.name);
        // issue a current object capability after the write settles
        if (entry === undefined) throw new HostFilesError('partial_failure', 'uploaded file unavailable', 500);
        current.state = 'ready';
        current.touchedAt = this.now();
        current.file = { object_token: entry.objectToken, name: entry.name, size: entry.size, ...(current.mime === undefined ? {} : { mime: current.mime }) };
        return { file: current.file, status: 'ready' };
      } catch (error) {
        // preserve an earlier cancellation result
        if (current.state === 'active') {
          current.state = 'failed';
          current.error = 'upload failed';
          current.touchedAt = this.now();
        }
        // retain only the non-oracular revocation class
        if (error instanceof HostFilesError && error.code === 'not_found') throw new HostFilesError('not_found', 'transfer unavailable', 404);
        throw new HostFilesError('partial_failure', 'upload failed', 500);
      }
    });
  }

  // return an owner-bound transfer snapshot
  async status(owner: HostFilesOwnerContext, transferId: string): Promise<McpTransferView> {
    await this.prune();
    const transfer = this.transfer(owner, transferId);
    // active transfers remain exact-lease-bound
    if (transfer.state === 'active' && !sameHostFilesOwner(transfer.owner, owner, true)) throw new HostFilesError('not_found', 'transfer unavailable', 404);
    return this.view(transfer);
  }

  // cancel one active transfer and await backend stage cleanup
  async cancel(owner: HostFilesOwnerContext, transferId: string): Promise<{ cancelled: true }> {
    await this.prune();
    const transfer = this.active(owner, transferId, true);
    // abort immediately so a held drain cannot block terminal settlement
    this.abort(transfer, 'cancelled');
    await this.serialize(transfer, async () => { await transfer.upload.catch(() => undefined); });
    return { cancelled: true };
  }

  // read one owner-bound single-file range without an archive stage
  async download(owner: HostFilesOwnerContext, objectToken: string, offset: number, maxBytes: number = mcpFileLimits.chunkBytes): Promise<{ offset: number; data_base64: string; bytes: number; eof: boolean; object_digest: string }> {
    const virtual = this.virtual.get(objectToken);
    // serve short-lived Note attachment capabilities through the same chunk contract
    if (virtual !== undefined) {
      // enforce stable owner and expiry without revealing foreign tokens
      if (!sameHostFilesOwner(virtual.owner, owner) || virtual.expiresAt < this.now() || await this.place(virtual.context.worktreeId, owner) === undefined) throw new HostFilesError('not_found', 'file unavailable', 404);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > virtual.size || maxBytes < 1 || maxBytes > mcpFileLimits.chunkBytes) throw new HostFilesError('invalid_request', 'invalid attachment range', 400);
      const bytes = await virtual.load(offset, maxBytes);
      // revoke capability reads when Place access changes during I/O
      if (await this.place(virtual.context.worktreeId, owner) === undefined) throw new HostFilesError('not_found', 'file unavailable', 404);
      // a changed attachment invalidates its capability instead of mixing versions
      if (bytes.length > maxBytes || offset + bytes.length > virtual.size) throw new HostFilesError('stale_object', 'attachment changed', 409);
      return { offset, data_base64: bytes.toString('base64'), bytes: bytes.length, eof: offset + bytes.length >= virtual.size, object_digest: virtual.digest };
    }
    const placeId = this.files.objectPlaceId(owner, objectToken);
    // hide foreign or malformed capabilities
    if (placeId === undefined) throw new HostFilesError('not_found', 'file unavailable', 404);
    const place = await this.place(placeId, owner);
    // require the token's configured Place
    if (place === undefined) throw new HostFilesError('not_found', 'Place not found', 404);
    const result = await this.files.readFileChunk(place, owner, objectToken, offset, maxBytes);
    // recheck Place authority after the asynchronous read
    await this.currentPlace(owner, place);
    return { offset, data_base64: result.bytes.toString('base64'), bytes: result.bytes.length, eof: offset + result.bytes.length >= result.size, object_digest: result.digest };
  }

  // issue one five-minute owner-bound capability for an existing Note attachment
  noteAttachment(owner: HostFilesOwnerContext, name: string, size: number, digest: string, load: (offset: number, maxBytes: number) => Promise<Buffer>, context: { worktreeId: string; noteId: string }, mime?: string): McpFileRef & { expires_at: string } {
    this.pruneVirtual();
    // keep virtual Note attachment state bounded
    if (this.virtual.size >= 512) throw new HostFilesError('limit_exceeded', 'attachment capability capacity is full', 429);
    const token = `mcp-note-${randomBytes(24).toString('base64url')}`;
    const expiresAt = this.now() + 5 * 60_000;
    this.virtual.set(token, { owner: hostFilesOwner(owner), name, size, digest, load, context, ...(mime === undefined ? {} : { mime }), expiresAt });
    return { object_token: token, name, size, ...(mime === undefined ? {} : { mime }), expires_at: new Date(expiresAt).toISOString() };
  }

  // cancel active transfers whose first-class owner or exact lease is no longer live
  async reconcile(active: (owner: HostFilesOwnerContext, placeId: string) => boolean | Promise<boolean>): Promise<void> {
    await this.prune();
    // inspect every bounded active stream
    for (const transfer of this.transfers.values()) {
      // leave terminal records for stable status recovery
      if (transfer.state !== 'active') continue;
      let current = false;
      try { current = await active(transfer.owner, transfer.place.id); } catch { current = false; }
      // destroy abandoned private stages immediately
      if (!current) await this.cancelActive(transfer, 'owner lease ended');
    }
  }

  // release all active streams during shutdown
  async close(): Promise<void> {
    // cancel every active transfer before closing the shared backend
    for (const transfer of this.transfers.values()) {
      // preserve terminal status records
      if (transfer.state !== 'active') continue;
      await this.cancelActive(transfer, 'server stopped');
    }
  }

  // find one stable-owner transfer without an existence oracle
  private transfer(owner: HostFilesOwnerContext, id: string): ActiveTransfer {
    const transfer = this.transfers.get(id);
    // match stable owner and namespace
    if (transfer === undefined || !sameHostFilesOwner(transfer.owner, owner)) throw new HostFilesError('not_found', 'transfer unavailable', 404);
    return transfer;
  }

  // require one active transfer and optional exact lease
  private active(owner: HostFilesOwnerContext, id: string, leaseBound: boolean): ActiveTransfer {
    const transfer = this.transfer(owner, id);
    // reject terminal or replaced-lease streams
    if (transfer.state !== 'active' || !sameHostFilesOwner(transfer.owner, owner, leaseBound)) throw new HostFilesError('not_found', 'transfer unavailable', 404);
    return transfer;
  }

  // reserve bounded active bytes and retained status capacity atomically
  private reserve(owner: HostFilesOwnerContext, totalBytes: number): symbol {
    const active = [...this.transfers.values()].filter(transfer => transfer.state === 'active');
    const pending = [...this.reservations.values()];
    const ownedActive = active.filter(transfer => sameHostFilesOwner(transfer.owner, owner));
    const ownedPending = pending.filter(reservation => sameHostFilesOwner(reservation.owner, owner));
    const ownedRetained = [...this.transfers.values()].filter(transfer => sameHostFilesOwner(transfer.owner, owner));
    // refuse capacity instead of evicting live or recoverable records
    if (active.length + pending.length >= mcpFileLimits.activeGlobal || ownedActive.length + ownedPending.length >= mcpFileLimits.activeOwner
      || active.reduce((sum, transfer) => sum + transfer.totalBytes, totalBytes) + pending.reduce((sum, reservation) => sum + reservation.totalBytes, 0) > mcpFileLimits.declaredGlobalBytes
      || ownedActive.reduce((sum, transfer) => sum + transfer.totalBytes, totalBytes) + ownedPending.reduce((sum, reservation) => sum + reservation.totalBytes, 0) > mcpFileLimits.declaredOwnerBytes
      || this.transfers.size + pending.length >= mcpFileLimits.retainedGlobal || ownedRetained.length + ownedPending.length >= mcpFileLimits.retainedOwner) throw new HostFilesError('limit_exceeded', 'MCP transfer capacity is full', 429);
    const id = Symbol('mcp-file-transfer');
    this.reservations.set(id, { owner: hostFilesOwner(owner), totalBytes });
    return id;
  }

  // require the same current owner-scoped Place root
  private async currentPlace(owner: HostFilesOwnerContext, expected: HostFilesPlace): Promise<HostFilesPlace> {
    const current = await this.place(expected.id, owner);
    // reject removed or rebound Place roots
    if (current === undefined || current.home !== expected.home || current.hostPath !== expected.hostPath) throw new HostFilesError('not_found', 'Place not found', 404);
    return current;
  }

  // serialize one transfer mutation without poisoning later terminal work
  private async serialize<T>(transfer: ActiveTransfer, change: () => Promise<T>): Promise<T> {
    const task = transfer.mutation.then(change);
    transfer.mutation = task.then(() => undefined, () => undefined);
    return await task;
  }

  // interrupt held backpressure before queued terminal settlement
  private abort(transfer: ActiveTransfer, reason: string): void {
    // preserve a terminal result reached before cancellation
    if (transfer.state !== 'active') return;
    transfer.state = 'cancelled';
    transfer.error = reason;
    transfer.touchedAt = this.now();
    transfer.stream.destroy(new Error(reason));
  }

  // destroy one writer and wait until the existing atomic stage settles
  private async cancelActive(transfer: ActiveTransfer, reason: string): Promise<void> {
    this.abort(transfer, reason);
    await transfer.upload.catch(() => undefined);
  }

  // expire abandoned streams and bounded terminal records
  private async prune(): Promise<void> {
    this.pruneVirtual();
    const now = this.now();
    // inspect every bounded transfer record
    for (const transfer of [...this.transfers.values()]) {
      // cancel inactive or absolute-expired streams
      if (transfer.state === 'active' && (transfer.touchedAt + mcpFileLimits.inactivityMs <= now || transfer.startedAt + mcpFileLimits.lifetimeMs <= now)) await this.cancelActive(transfer, 'transfer expired');
      // retain terminal recovery for one absolute lifetime
      if (transfer.state !== 'active' && transfer.touchedAt + mcpFileLimits.lifetimeMs <= now) this.transfers.delete(transfer.id);
    }
  }

  // discard expired virtual Note attachment capabilities
  private pruneVirtual(): void {
    const now = this.now();
    // remove only expired capabilities
    for (const [token, entry] of this.virtual) {
      // retain current tokens
      if (entry.expiresAt > now) continue;
      this.virtual.delete(token);
    }
  }

  // project one exact public transfer result
  private view(transfer: ActiveTransfer): McpTransferView {
    return { transfer_id: transfer.id, state: transfer.state, next_offset: transfer.nextOffset, total_bytes: transfer.totalBytes, inactivity_expires_at: new Date(transfer.touchedAt + mcpFileLimits.inactivityMs).toISOString(), absolute_expires_at: new Date(transfer.startedAt + mcpFileLimits.lifetimeMs).toISOString(), ...(transfer.error === undefined ? {} : { error: transfer.error }), ...(transfer.file === undefined ? {} : { file: transfer.file }) };
  }
}

// compare canonical base64url SHA-256 digests
function sameDigest(actual: string, supplied: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
