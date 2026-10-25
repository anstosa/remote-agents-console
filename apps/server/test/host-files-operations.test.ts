import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { BackendHostFileFavorites } from '../src/host-files/favorites.js';
import { hostFilesLimits, HostFilesService } from '../src/host-files/service.js';
import { HostFilesError, type HostFilesBackend, type HostFilesCommand, type HostFilesCommandResult, type HostFilesReadCommand, type HostFilesWriteCommand, type HostFilesWriteResult } from '../src/host-files/contracts.js';

const fixtures: Array<{ root: string; service: HostFilesService }> = [];
const place = { id: 'project:/place', home: '/unused' };
const session = { id: 'session-one' };
// await one disposable Unix fixture command
const execute = promisify(execFile);

afterEach(async () => {
  // close active jobs before deleting disposable filesystem roots
  for (const fixture of fixtures.splice(0)) { await fixture.service.close(); await rm(fixture.root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

class RecordingBackend implements HostFilesBackend {
  readonly writeOperationIds: string[] = [];
  // fail deterministic request boundaries in orchestration tests
  beforeRequest?: (command: HostFilesCommand) => Promise<void>;
  // pause deterministic request boundaries in orchestration tests
  afterRequest?: (command: HostFilesCommand) => Promise<void>;

  // decorate one real engine with bounded failure injection
  constructor(private readonly engine: HostFilesBackend, private readonly failAfterCopy = false) {}

  // retain the wrapped engine generation
  generation(): string { return this.engine.generation(); }

  // record or inject only the requested operation seam
  async request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>> {
    await this.beforeRequest?.(command);
    const result = await this.engine.request(command, signal);
    await this.afterRequest?.(command);
    // simulate a post-publication recovery failure after the engine has copied safely
    if (this.failAfterCopy && command.kind === 'copy') throw new HostFilesError('partial_failure', 'destination published; recovery required', 409);
    return result;
  }

  // preserve descriptor-bound reads
  async read(command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable> { return await this.engine.read(command, signal); }

  // record each independently journaled upload
  async write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    this.writeOperationIds.push(command.operationId);
    return await this.engine.write(command, source, signal);
  }

  // close only the wrapped engine
  async close(): Promise<void> { await this.engine.close(); }
}

// create one service over an isolated direct host engine
async function fixture(options: { failAfterCopy?: boolean; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rac-files-service-'));
  const favoritesFile = join(root, 'favorites.json');
  const engine = createHostFilesEngine('service-generation', { journalFile: join(root, 'journal.json'), favoritesFile });
  const backend = new RecordingBackend(engine, options.failAfterCopy);
  const favorites = new BackendHostFileFavorites(backend);
  const service = new HostFilesService({ backend, tokenSecret: 'service-operation-token-secret', now: options.now });
  fixtures.push({ root, service });
  return { root, backend, favorites, service };
}

// wait for one in-memory job to reach a terminal state
async function terminal(service: HostFilesService, operationId: string) {
  // bound test polling without changing service timing
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = service.operation(place, session, operationId);
    // return the first terminal snapshot
    if (['completed', 'partial', 'failed', 'canceled'].includes(operation.state)) return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('operation did not finish');
}

// expose one deterministic asynchronous test boundary
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('host Files service safety orchestration', () => {
  // resolve editor capabilities only for current regular files in their exact request scope
  it('resolves regular editor files while rejecting wrong scope, purpose, type and freshness', async () => {
    let now = 1_800_000_000_000;
    const f = await fixture({ now: () => now }); const directory = join(f.root, 'editor'); const file = join(directory, 'item.txt'); const pipe = join(directory, 'pipe');
    await mkdir(directory); await writeFile(file, 'item'); await execute('mkfifo', [pipe]);
    const listed = await f.service.list(place, session, directory);
    const fileToken = listed.entries.find(entry => entry.name === 'item.txt')!.objectToken;
    const pipeToken = listed.entries.find(entry => entry.name === 'pipe')!.objectToken;
    await expect(f.service.editorFile(place, session, fileToken)).resolves.toBe(file);
    await expect(f.service.editorFile({ ...place, id: 'other-place' }, session, fileToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    await expect(f.service.editorFile(place, { id: 'other-session' }, fileToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    await expect(f.service.editorFile(place, session, listed.destinationDirectoryToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    await expect(f.service.editorFile(place, session, listed.directoryEntry.objectToken)).rejects.toMatchObject({ code: 'unsupported_type', statusCode: 422 });
    await expect(f.service.editorFile(place, session, pipeToken)).rejects.toMatchObject({ code: 'unsupported_type', statusCode: 422 });
    await rename(file, join(directory, 'old-item.txt')); await writeFile(file, 'replacement');
    await expect(f.service.editorFile(place, session, fileToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    const freshToken = (await f.service.list(place, session, directory)).entries.find(entry => entry.name === 'item.txt')!.objectToken;
    now += 15 * 60_000 + 1;
    await expect(f.service.editorFile(place, session, freshToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
  });

  // retain the clicked symlink path while proving its target remains one regular file
  it('resolves regular-file symlinks for editors and rejects changed or non-file targets', async () => {
    const f = await fixture(); const directory = join(f.root, 'editor-links'); const target = join(f.root, 'target.txt'); const link = join(directory, 'linked.txt');
    await mkdir(directory); await writeFile(target, 'target'); await symlink(target, link);
    const token = (await f.service.list(place, session, directory)).entries[0]!.objectToken;
    await expect(f.service.editorFile(place, session, token)).resolves.toBe(link);
    let resolutions = 0;
    f.backend.afterRequest = async command => {
      // replace the resolved target after the first identity snapshot
      if (command.kind === 'inspect' && command.followSymlink && (resolutions += 1) === 1) { await rename(target, join(f.root, 'old-target.txt')); await writeFile(target, 'replacement'); }
    };
    await expect(f.service.editorFile(place, session, token)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    f.backend.afterRequest = undefined;
    const folder = join(f.root, 'folder-target'); const folderLink = join(directory, 'folder-link'); await mkdir(folder); await symlink(folder, folderLink);
    const folderToken = (await f.service.list(place, session, directory)).entries.find(entry => entry.name === 'folder-link')!.objectToken;
    await expect(f.service.editorFile(place, session, folderToken)).rejects.toMatchObject({ code: 'unsupported_type', statusCode: 422 });
  });

  // exchange exact row capabilities without adopting a replacement directory
  it('rejects replaced folder rows and unrelated scoped paths', async () => {
    const f = await fixture(); const parent = join(f.root, 'parent'); const folder = join(parent, 'folder');
    await mkdir(parent); await mkdir(folder);
    const row = (await f.service.list(place, session, parent)).entries[0]!;
    const resolved = await f.service.list(place, session, folder, row.objectToken);
    expect(resolved.path).toBe(folder);
    await expect(f.service.list(place, session, parent, row.objectToken)).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    await rename(folder, join(parent, 'old-folder')); await mkdir(folder);
    await expect(f.service.list(place, session, folder, row.objectToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    expect(await readdir(folder)).toEqual([]);
  });

  // require the resolved target to survive the exchange before issuing write authority
  it('rejects a replaced symlink target during scoped folder resolution', async () => {
    const f = await fixture(); const parent = join(f.root, 'links'); const target = join(f.root, 'target'); const link = join(parent, 'folder');
    await mkdir(parent); await mkdir(target); await symlink(target, link);
    const row = (await f.service.list(place, session, parent)).entries[0]!;
    expect((await f.service.list(place, session, link, row.objectToken)).path).toBe(target);
    f.backend.afterRequest = async command => {
      // replace the target after its first resolved identity was captured
      if (command.kind === 'inspect' && command.followSymlink) { await rename(target, join(f.root, 'old-target')); await mkdir(target); }
    };
    await expect(f.service.list(place, session, link, row.objectToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    expect(await readdir(target)).toEqual([]);
  });

  // retain the selected symlink identity through the final target inspection
  it('rejects symlink replacement after the final scoped target inspection', async () => {
    const f = await fixture(); const parent = join(f.root, 'links'); const target = join(f.root, 'target'); const link = join(parent, 'folder');
    await mkdir(parent); await mkdir(target); await symlink(target, link);
    const row = (await f.service.list(place, session, parent)).entries[0]!;
    let resolutions = 0;
    f.backend.afterRequest = async command => {
      // replace only the link after the final target identity was captured
      if (command.kind === 'inspect' && command.followSymlink && (resolutions += 1) === 2) { await rename(link, join(parent, 'old-link')); await symlink(target, link); }
    };
    await expect(f.service.list(place, session, link, row.objectToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    expect(await readdir(target)).toEqual([]);
  });

  // refuse a mixed snapshot when the directory changes before its current-object capability is issued
  it('rejects directory drift between listing and current-directory inspection', async () => {
    const f = await fixture(); const directory = join(f.root, 'listing');
    await mkdir(directory); await writeFile(join(directory, 'original'), 'original');
    f.backend.afterRequest = async command => {
      // change the directory after the backend returns its frozen listing
      if (command.kind === 'list') await writeFile(join(directory, 'changed'), 'changed');
    };
    await expect(f.service.list(place, session, directory)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    f.backend.afterRequest = undefined;
    const refreshed = await f.service.list(place, session, directory);
    expect(refreshed.directoryEntry).toMatchObject({ hostPath: directory, kind: 'directory', objectToken: expect.any(String) });
    expect(refreshed.entries.map(entry => entry.name).sort()).toEqual(['changed', 'original']);
  });

  // do not retarget a favorite whose stored inode was replaced before a later move
  it('leaves replaced favorites at their original path', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const source = join(f.root, 'source'); const destination = join(f.root, 'destination');
    await mkdir(source); await mkdir(destination); await writeFile(join(source, 'item.txt'), 'old');
    const oldList = await f.service.list(place, session, source);
    const oldToken = oldList.entries[0]!.objectToken;
    const favorite = (await f.service.addFavorite(place, session, oldToken)).favorite;
    await rename(join(source, 'item.txt'), join(source, 'old-object'));
    await writeFile(join(source, 'item.txt'), 'new');
    const sourceList = await f.service.list(place, session, source);
    const destinationList = await f.service.list(place, session, destination);
    const prepared = await f.service.prepareOperation(place, session, { kind: 'move', sourceTokens: [sourceList.entries.find(entry => entry.name === 'item.txt')!.objectToken], destinationDirectoryToken: destinationList.destinationDirectoryToken });
    await f.service.executeOperation(place, session, prepared.operationId, {});
    expect((await terminal(f.service, prepared.operationId)).state).toBe('completed');
    expect(await readFile(join(destination, 'item.txt'), 'utf8')).toBe('new');
    const stored = await f.favorites.list(place.id);
    expect(stored).toMatchObject([{ id: favorite.id, path: join(source, 'item.txt') }]);
    expect((await f.service.listFavorites(place, session)).favorites[0]?.state).toBe('unavailable');
  });

  // hold every favorite mutation from snapshot through ordinary source removal
  it('serializes favorite mutations across an ordinary move', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const source = join(f.root, 'source'); const destination = join(f.root, 'destination');
    await mkdir(source); await mkdir(destination); await writeFile(join(source, 'item.txt'), 'source');
    const sourceList = await f.service.list(place, session, source);
    const sourceToken = sourceList.entries[0]!.objectToken;
    const favorite = (await f.service.addFavorite(place, session, sourceToken)).favorite;
    const destinationList = await f.service.list(place, session, destination);
    const prepared = await f.service.prepareOperation(place, session, { kind: 'move', sourceTokens: [sourceToken], destinationDirectoryToken: destinationList.destinationDirectoryToken });
    const snapshotReached = deferred(); const continueMove = deferred();
    f.backend.afterRequest = async command => {
      // pause after the service froze the exact favorite set
      if (command.kind === 'favorites-beneath') { snapshotReached.resolve(); await continueMove.promise; }
    };
    await f.service.executeOperation(place, session, prepared.operationId, {});
    await snapshotReached.promise;
    let settled = 0;
    const add = f.service.addFavorite(place, session, sourceToken).finally(() => { settled += 1; });
    const acknowledge = f.service.acknowledgeFavorite(place, session, favorite.id, sourceToken).finally(() => { settled += 1; });
    const remove = f.service.removeFavorite(place, favorite.id).finally(() => { settled += 1; });
    const actions = Promise.allSettled([add, acknowledge, remove]);
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(0);
    continueMove.resolve();
    expect((await terminal(f.service, prepared.operationId)).state).toBe('completed');
    const [added, acknowledged, removed] = await actions;
    expect(added).toMatchObject({ status: 'rejected', reason: { code: 'not_found' } });
    expect(acknowledged).toMatchObject({ status: 'rejected', reason: { code: 'not_found' } });
    expect(removed).toEqual({ status: 'fulfilled', value: undefined });
    expect((await f.favorites.list(place.id))).toEqual([]);
  });

  // hold the exact journaled favorite set through every special rename phase
  it('serializes favorite removal through special rename finalization', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const directory = join(f.root, 'special'); const source = join(directory, 'pipe');
    await mkdir(directory); await execute('mkfifo', [source]);
    const listed = await f.service.list(place, session, directory);
    const sourceToken = listed.entries[0]!.objectToken;
    const favorite = (await f.service.addFavorite(place, session, sourceToken)).favorite;
    const prepared = await f.service.prepareOperation(place, session, { kind: 'rename', sourceToken, newName: 'renamed-pipe', destinationDirectoryToken: listed.destinationDirectoryToken });
    const linkReached = deferred(); const continueRename = deferred();
    f.backend.afterRequest = async command => {
      // pause after the engine journals and publishes the exact special link
      if (command.kind === 'link-special') { linkReached.resolve(); await continueRename.promise; }
    };
    await f.service.executeOperation(place, session, prepared.operationId, {});
    await linkReached.promise;
    const journal = JSON.parse(await readFile(join(f.root, 'journal.json'), 'utf8')) as { operations: Array<{ favorites?: Array<{ favoriteId: string }> }> };
    expect(journal.operations[0]?.favorites?.map(record => record.favoriteId)).toEqual([favorite.id]);
    let removed = false;
    const removal = f.service.removeFavorite(place, favorite.id).then(() => { removed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(removed).toBe(false);
    continueRename.resolve();
    expect((await terminal(f.service, prepared.operationId)).state).toBe('completed');
    await removal;
    expect(await f.favorites.list(place.id)).toEqual([]);
    expect((await f.service.list(place, session, directory)).entries.map(entry => entry.name)).toEqual(['renamed-pipe']);
  });

  // release the mutation gate while retaining phase-one recovery evidence
  it('retains pending special recovery after phase-two failure', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const directory = join(f.root, 'special-failure'); const source = join(directory, 'pipe');
    await mkdir(directory); await execute('mkfifo', [source]); await writeFile(join(directory, 'ordinary'), 'safe');
    const listed = await f.service.list(place, session, directory);
    const sourceToken = listed.entries.find(entry => entry.name === 'pipe')!.objectToken;
    const ordinaryToken = listed.entries.find(entry => entry.name === 'ordinary')!.objectToken;
    await f.service.addFavorite(place, session, sourceToken);
    const prepared = await f.service.prepareOperation(place, session, { kind: 'rename', sourceToken, newName: 'renamed-pipe', destinationDirectoryToken: listed.destinationDirectoryToken });
    let rewrites = 0;
    f.backend.beforeRequest = async command => {
      // fail only the service's final-ctime favorite publication
      if (command.kind === 'favorites-rewrite' && (rewrites += 1) === 2) throw new HostFilesError('partial_failure', 'fixture phase-two failure', 409);
    };
    await f.service.executeOperation(place, session, prepared.operationId, {});
    expect((await terminal(f.service, prepared.operationId))).toMatchObject({ state: 'partial', results: [{ code: 'favorite_freshness_pending' }] });
    expect((await f.service.listFavorites(place, session)).favorites[0]?.state).toBe('repair-pending');
    const journal = JSON.parse(await readFile(join(f.root, 'journal.json'), 'utf8')) as { operations: Array<{ id: string; phase: string }> };
    expect(journal.operations).toMatchObject([{ id: prepared.operationId, phase: 'source-unlinked' }]);
    f.backend.beforeRequest = undefined;
    await expect(f.service.addFavorite(place, session, ordinaryToken)).resolves.toMatchObject({ favorite: { path: join(directory, 'ordinary') } });
  });

  // serialize same-batch bodies while giving each host journal its own operation id
  it('publishes concurrent batch uploads with unique journal authority', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const destination = join(f.root, 'destination'); await mkdir(destination);
    const listed = await f.service.list(place, session, destination);
    const prepared = await f.service.prepareUpload(place, session, { destinationDirectoryToken: listed.destinationDirectoryToken, files: [{ clientId: 'one', name: 'one.bin', size: 3 }, { clientId: 'two', name: 'two.bin', size: 3 }] });
    const authorized = await f.service.authorizeUpload(place, session, prepared.uploadId, {});
    const one = authorized.files.find(file => file.clientId === 'one')!;
    const two = authorized.files.find(file => file.clientId === 'two')!;
    await Promise.all([
      f.service.upload(place, session, prepared.uploadId, 'one', one.token!, Readable.from([Buffer.from('one')])),
      f.service.upload(place, session, prepared.uploadId, 'two', two.token!, Readable.from([Buffer.from('two')])),
    ]);
    expect(await readFile(join(destination, 'one.bin'), 'utf8')).toBe('one');
    expect(await readFile(join(destination, 'two.bin'), 'utf8')).toBe('two');
    expect(new Set(f.backend.writeOperationIds).size).toBe(2);
  });

  // reject duplicate upload destinations before issuing body capabilities
  it('rejects duplicate upload filenames in one batch', async () => {
    const f = await fixture(); const destination = join(f.root, 'destination'); await mkdir(destination);
    const listed = await f.service.list(place, session, destination);
    await expect(f.service.prepareUpload(place, session, {
      destinationDirectoryToken: listed.destinationDirectoryToken,
      files: [{ clientId: 'one', name: 'duplicate.bin', size: 3 }, { clientId: 'two', name: 'duplicate.bin', size: 3 }],
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    expect(await readdir(destination)).toEqual([]);
  });

  // reject two selected basenames that derive the same copy or move target
  it.each(['copy', 'move'] as const)('rejects duplicate %s destination paths before execution', async kind => {
    const f = await fixture(); const left = join(f.root, 'left'); const right = join(f.root, 'right'); const destination = join(f.root, 'destination');
    await mkdir(left); await mkdir(right); await mkdir(destination);
    await writeFile(join(left, 'shared.txt'), 'left'); await writeFile(join(right, 'shared.txt'), 'right');
    const leftToken = (await f.service.list(place, session, left)).entries[0]!.objectToken;
    const rightToken = (await f.service.list(place, session, right)).entries[0]!.objectToken;
    const destinationToken = (await f.service.list(place, session, destination)).destinationDirectoryToken;
    await expect(f.service.prepareOperation(place, session, { kind, sourceTokens: [leftToken, rightToken], destinationDirectoryToken: destinationToken })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    expect(await readdir(destination)).toEqual([]);
    expect(await readFile(join(left, 'shared.txt'), 'utf8')).toBe('left');
    expect(await readFile(join(right, 'shared.txt'), 'utf8')).toBe('right');
  });

  // enforce recursive download limits across all selected roots
  it.each([
    { limit: 'recursiveBytes', value: 5 },
    { limit: 'recursiveEntries', value: 1 },
  ] as const)('rejects aggregate downloads beyond $limit', async ({ limit, value }) => {
    const f = await fixture(); const directory = join(f.root, 'downloads'); await mkdir(directory);
    await writeFile(join(directory, 'one.bin'), 'one'); await writeFile(join(directory, 'two.bin'), 'two');
    const listed = await f.service.list(place, session, directory);
    const mutableLimits = hostFilesLimits as { recursiveBytes: number; recursiveEntries: number };
    const original = mutableLimits[limit];
    mutableLimits[limit] = value;
    // restore the shared test limit after every rejection path
    try {
      await expect(f.service.prepareDownload(place, session, listed.entries.map(entry => entry.objectToken))).rejects.toMatchObject({ code: 'limit_exceeded', statusCode: 413 });
    } finally {
      mutableLimits[limit] = original;
    }
  });

  // reject aggregate filesystem batches before any destructive execution
  it.each(['copy', 'move', 'delete'] as const)('rejects an oversized aggregate %s batch', async kind => {
    const f = await fixture(); const source = join(f.root, 'source'); const destination = join(f.root, 'destination');
    await mkdir(source); await mkdir(destination); await writeFile(join(source, 'one'), 'one'); await writeFile(join(source, 'two'), 'two');
    const sourceTokens = (await f.service.list(place, session, source)).entries.map(entry => entry.objectToken);
    const destinationDirectoryToken = (await f.service.list(place, session, destination)).destinationDirectoryToken;
    const mutableLimits = hostFilesLimits as { recursiveBytes: number };
    const original = mutableLimits.recursiveBytes;
    mutableLimits.recursiveBytes = 5;
    try {
      const input = kind === 'delete' ? { kind, sourceTokens } : { kind, sourceTokens, destinationDirectoryToken };
      await expect(f.service.prepareOperation(place, session, input)).rejects.toMatchObject({ code: 'limit_exceeded', statusCode: 413 });
      expect(await readdir(destination)).toEqual([]);
      expect(await readFile(join(source, 'one'), 'utf8')).toBe('one');
      expect(await readFile(join(source, 'two'), 'utf8')).toBe('two');
    } finally {
      // restore the production limit after every regression branch
      mutableLimits.recursiveBytes = original;
    }
  });

  // preserve executable and directory modes despite a restrictive process umask
  it.each(['move', 'rename'] as const)('preserves recursive permissions during service %s', async kind => {
    const f = await fixture(); const parent = join(f.root, 'parent'); const destination = join(f.root, 'destination'); const source = join(parent, 'tree');
    await mkdir(parent); await mkdir(destination); await mkdir(source); await mkdir(join(source, 'nested'));
    await writeFile(join(source, 'nested', 'executable'), '#!/bin/sh\nexit 0\n');
    await chmod(source, 0o755); await chmod(join(source, 'nested'), 0o711); await chmod(join(source, 'nested', 'executable'), 0o755);
    const parentList = await f.service.list(place, session, parent);
    const sourceToken = parentList.entries.find(entry => entry.name === 'tree')!.objectToken;
    const previousUmask = process.umask(0o077);
    let operationId: string;
    // retain the restrictive umask through asynchronous publication
    try {
      const prepared = kind === 'move'
        ? await f.service.prepareOperation(place, session, { kind, sourceTokens: [sourceToken], destinationDirectoryToken: (await f.service.list(place, session, destination)).destinationDirectoryToken })
        : await f.service.prepareOperation(place, session, { kind, sourceToken, newName: 'renamed-tree', destinationDirectoryToken: parentList.destinationDirectoryToken });
      operationId = prepared.operationId;
      await f.service.executeOperation(place, session, operationId, {});
      expect((await terminal(f.service, operationId)).state).toBe('completed');
    } finally {
      process.umask(previousUmask);
    }
    const result = kind === 'move' ? join(destination, 'tree') : join(parent, 'renamed-tree');
    expect((await stat(result)).mode & 0o777).toBe(0o755);
    expect((await stat(join(result, 'nested'))).mode & 0o777).toBe(0o711);
    expect((await stat(join(result, 'nested', 'executable'))).mode & 0o777).toBe(0o755);
  });

  // surface post-publication backend failures as partial even on the first item
  it('records first-item post-publication failures as partial', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture({ failAfterCopy: true }); const source = join(f.root, 'source'); const destination = join(f.root, 'destination');
    await mkdir(source); await mkdir(destination); await writeFile(join(source, 'item'), 'source');
    const sourceList = await f.service.list(place, session, source);
    const destinationList = await f.service.list(place, session, destination);
    const prepared = await f.service.prepareOperation(place, session, { kind: 'copy', sourceTokens: [sourceList.entries[0]!.objectToken], destinationDirectoryToken: destinationList.destinationDirectoryToken });
    await f.service.executeOperation(place, session, prepared.operationId, {});
    const result = await terminal(f.service, prepared.operationId);
    expect(result).toMatchObject({ state: 'partial', completedItems: 0, results: [{ outcome: 'failed', code: 'partial_failure' }] });
    expect(await readFile(join(destination, 'item'), 'utf8')).toBe('source');
    expect(await readFile(join(source, 'item'), 'utf8')).toBe('source');
  });

  // mark a descriptor-open failure before response headers as a failed download
  it('records preheader download failures', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const directory = join(f.root, 'files'); await mkdir(directory); await writeFile(join(directory, 'item'), 'source');
    const listed = await f.service.list(place, session, directory);
    const prepared = await f.service.prepareDownload(place, session, [listed.entries[0]!.objectToken]);
    await unlink(join(directory, 'item'));
    await expect(f.service.openDownload(session, prepared.downloadId)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.service.downloadStatus(place, session, prepared.downloadId)).toEqual({ state: 'failed', bytesCompleted: 0, error: 'not_found' });
  });

  // retain an active upload's overlap lock even after its authorization clock expires
  it('does not prune locks for an active slow upload', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let now = 1_000;
    const f = await fixture({ now: () => now }); const destination = join(f.root, 'destination'); await mkdir(destination);
    const listed = await f.service.list(place, session, destination);
    const prepared = await f.service.prepareUpload(place, session, { destinationDirectoryToken: listed.destinationDirectoryToken, files: [{ clientId: 'slow', name: 'slow.bin', size: 10 }] });
    const authorized = await f.service.authorizeUpload(place, session, prepared.uploadId, {});
    const source = new PassThrough(); source.write('abc');
    const pending = f.service.upload(place, session, prepared.uploadId, 'slow', authorized.files[0]!.token!, source);
    // wait until the engine creates its exact upload stage
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // stop once the active stage proves the body reached the backend
      if ((await readdir(destination)).some(name => name.startsWith('.rac-files-upload-'))) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    now += 16 * 60_000;
    const refreshed = await f.service.list(place, session, destination);
    const create = await f.service.prepareOperation(place, session, { kind: 'create-file', name: 'other', destinationDirectoryToken: refreshed.destinationDirectoryToken });
    await expect(f.service.executeOperation(place, session, create.operationId, {})).rejects.toMatchObject({ code: 'busy' });
    // consume the intentional source error as well as the service rejection
    source.once('error', () => undefined);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'partial_failure' });
    source.destroy(new Error('fixture disconnect'));
    await rejected;
  });

  // lifecycle logs expose only identifiers, counts and stable state
  it('logs sanitized lifecycle transitions', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = await fixture(); const directory = join(f.root, 'sensitive-folder'); await mkdir(directory);
    const listed = await f.service.list(place, session, directory);
    const prepared = await f.service.prepareOperation(place, session, { kind: 'create-file', name: 'secret-name', destinationDirectoryToken: listed.destinationDirectoryToken });
    await f.service.executeOperation(place, session, prepared.operationId, {});
    await terminal(f.service, prepared.operationId);
    const output = logged.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('host_files_lifecycle');
    expect(output).toContain(prepared.operationId);
    expect(output).not.toContain(f.root);
    expect(output).not.toContain('secret-name');
    expect(output).not.toContain(session.id);
  });
});
