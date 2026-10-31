import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createHostFilesEngine, type HostFilesEngineOptions } from '../src/host-files/engine.js';
import { HostFileFavoritesStore } from '../src/host-files/favorites.js';
import { FileOperationJournal } from '../src/host-files/operation-journal.js';
import type { HostFilesBackend, HostFilesCopyCommand } from '../src/host-files/contracts.js';

const fixtures: Array<{ root: string; engine: HostFilesBackend }> = [];
// close actual jobs before removing only disposable fixture roots
afterEach(async () => {
  // clean every test-owned root after canceling its jobs
  for (const fixture of fixtures.splice(0)) { await fixture.engine.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

// create isolated journal and destination roots for one engine instance
async function fixture(options: HostFilesEngineOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rac-files-engine-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(source); await mkdir(destination);
  const engine = createHostFilesEngine('fixture-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json'), ...options });
  fixtures.push({ root, engine });
  return { root, source, destination, engine };
}

// prepare exactly the identities a service-owned copy manifest carries
async function copyCommand(engine: HostFilesBackend, sourcePath: string, destinationPath: string, replace = false): Promise<HostFilesCopyCommand> {
  const sourceIdentity = await engine.request({ kind: 'inspect', path: sourcePath });
  const sourceManifest = await engine.request({ kind: 'snapshot', path: sourcePath, maxEntries: 10_000, maxBytes: 1024 ** 3 });
  const destinationParentIdentity = await engine.request({ kind: 'inspect', path: join(destinationPath, '..') });
  const destinationIdentity = await engine.request({ kind: 'inspect', path: destinationPath }).catch(() => undefined);
  const destinationManifest = destinationIdentity === undefined ? undefined : await engine.request({ kind: 'snapshot', path: destinationPath, maxEntries: 10_000, maxBytes: 1024 ** 3 });
  return { kind: 'copy', operationId: randomUUID(), sourcePath, sourceIdentity, sourceManifest, destinationPath, destinationParentIdentity, destinationIdentity, destinationManifest, replace };
}

// exercise actual Unix identities rather than mocked stat-then-rename success
// test no-clobber publication and bounded recovery on native filesystem fixtures
describe('host Files mutation engine', () => {
  // preserve executable and read-only modes independently of the host umask
  it('copies permission modes through private staging under a restrictive umask', async () => {
    const f = await fixture();
    const source = join(f.source, 'tree');
    await mkdir(source); await mkdir(join(source, 'nested')); await mkdir(join(source, 'readonly'));
    await writeFile(join(source, 'nested/run.sh'), 'executable'); await writeFile(join(source, 'readonly/readme'), 'read-only tree');
    await chmod(source, 0o755); await chmod(join(source, 'nested'), 0o711); await chmod(join(source, 'nested/run.sh'), 0o755); await chmod(join(source, 'readonly'), 0o555);
    const destination = join(f.destination, 'copied');
    const command = await copyCommand(f.engine, source, destination);
    const previousUmask = process.umask(0o077);
    try { expect((await f.engine.request(command)).results[0]?.outcome).toBe('copied'); }
    finally { process.umask(previousUmask); }
    try {
      expect((await stat(destination)).mode & 0o777).toBe(0o755);
      expect((await stat(join(destination, 'nested'))).mode & 0o777).toBe(0o711);
      expect((await stat(join(destination, 'nested/run.sh'))).mode & 0o777).toBe(0o755);
      expect((await stat(join(destination, 'readonly'))).mode & 0o777).toBe(0o555);
      expect(await readFile(join(destination, 'readonly/readme'), 'utf8')).toBe('read-only tree');
    } finally {
      // make disposable read-only trees removable even after an assertion failure
      await chmod(join(source, 'readonly'), 0o755); await chmod(join(destination, 'readonly'), 0o755);
    }
  });

  // reject redirected directory authority before publishing any child bytes
  it('does not publish through a substituted destination parent', async () => {
    let destination = '';
    let redirected = '';
    const f = await fixture({ beforeStep: async (phase, path) => {
      // replace the freshly published parent before its first child
      if (phase === 'before-publish' && path === join(destination, 'payload')) {
        await rename(destination, `${destination}-displaced`);
        await symlink(redirected, destination);
      }
    } });
    destination = join(f.destination, 'copied'); redirected = join(f.root, 'redirected');
    await mkdir(redirected);
    const source = join(f.source, 'tree'); await mkdir(source); await writeFile(join(source, 'payload'), 'must not escape');
    await expect(f.engine.request(await copyCommand(f.engine, source, destination))).rejects.toMatchObject({ code: 'stale_object' });
    expect(await readdir(redirected)).toEqual([]);
    expect(await readFile(join(source, 'payload'), 'utf8')).toBe('must not escape');
  });

  // preserve hidden names, binary bytes, empty directories and inert symlinks
  it('copies a complete prepared tree without following symlinks', async () => {
    const f = await fixture();
    const tree = join(f.source, 'tree'); await mkdir(tree); await mkdir(join(tree, 'empty'));
    await writeFile(join(tree, '.hidden'), Buffer.from([0, 255, 17, 128]));
    await symlink('missing', join(tree, 'broken')); await symlink('.', join(tree, 'loop'));
    const command = await copyCommand(f.engine, tree, join(f.destination, 'copied'));
    const result = await f.engine.request(command);
    expect(result.results[0]?.outcome).toBe('copied');
    expect(await readFile(join(f.destination, 'copied/.hidden'))).toEqual(Buffer.from([0, 255, 17, 128]));
    const snapshot = await f.engine.request({ kind: 'snapshot', path: join(f.destination, 'copied'), maxEntries: 20, maxBytes: 100 });
    expect(snapshot.entries).toHaveLength(5);
    expect(snapshot.entries.filter(entry => entry.identity.kind === 'symlink')).toHaveLength(2);
    expect(await readdir(f.destination)).toEqual(['copied']);
  });

  // prevent publication from deleting or overwriting a newly created conflicting file
  it('retains a racer at the final name and cleans only its own staging file', async () => {
    let raced = false;
    const f = await fixture({ beforeStep: async (phase, path) => {
      // introduce a competing final-name object immediately before exclusive publication
      if (phase === 'before-publish' && !raced) { raced = true; await writeFile(path, 'racer', { flag: 'wx' }); }
    } });
    const source = join(f.source, 'file'); await writeFile(source, 'source');
    const destination = join(f.destination, 'file');
    await expect(f.engine.request(await copyCommand(f.engine, source, destination))).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(destination, 'utf8')).toBe('racer');
    expect(await readFile(source, 'utf8')).toBe('source');
    expect(await readdir(f.destination)).toEqual(['file']);
  });

  // reject stale parent authority before creating staging bytes
  it('rejects parent ctime drift before the first write', async () => {
    const f = await fixture(); const source = join(f.source, 'file'); await writeFile(source, 'source');
    const command = await copyCommand(f.engine, source, join(f.destination, 'copy'));
    await writeFile(join(f.destination, 'outside'), 'outside');
    await expect(f.engine.request(command)).rejects.toMatchObject({ code: 'stale_object' });
    expect(await readdir(f.destination)).toEqual(['outside']);
  });

  // refuse source edits discovered after prepare without publishing incomplete bytes
  it('rejects a changed recursive source manifest', async () => {
    const f = await fixture(); const source = join(f.source, 'file'); await writeFile(source, 'old');
    const command = await copyCommand(f.engine, source, join(f.destination, 'copy'));
    // another length, so the edit shows even when it lands in the same timestamp tick (coarse on tmpfs)
    await writeFile(source, 'newer');
    await expect(f.engine.request(command)).rejects.toMatchObject({ code: 'stale_object' });
    expect(await readdir(f.destination)).toEqual([]);
  });

  // actual rename-induced ctime changes must not invalidate owned backup cleanup
  it('replaces a prepared directory collision and removes the exact backup', async () => {
    const f = await fixture(); const source = join(f.source, 'tree'); const destination = join(f.destination, 'tree');
    await mkdir(source); await writeFile(join(source, 'new'), 'new');
    await mkdir(destination); await writeFile(join(destination, 'old'), 'old');
    const result = await f.engine.request(await copyCommand(f.engine, source, destination, true));
    expect(result.results[0]?.outcome).toBe('copied');
    expect(await readdir(destination)).toEqual(['new']);
    expect(await readdir(f.destination)).toEqual(['tree']);
  });

  // abrupt exit bypasses rollback at every visible root and child publication checkpoint
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('restores a replaced directory after publication checkpoint %i crashes', async checkpoint => {
    const f = await fixture(); const source = join(f.source, 'tree'); const destination = join(f.destination, 'tree');
    await mkdir(join(source, 'nested'), { recursive: true }); await writeFile(join(source, 'nested', 'one'), 'one'); await writeFile(join(source, 'two'), 'two');
    await mkdir(destination); await writeFile(join(destination, 'original'), 'original');
    const command = await copyCommand(f.engine, source, destination, true);
    await f.engine.close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/host-files/engine.ts')).href;
    const options = { journalFile: join(f.root, 'journal.json'), favoritesFile: join(f.root, 'favorites.json') };
    const script = `import { createHostFilesEngine } from ${JSON.stringify(moduleUrl)}; let count = 0; const engine = createHostFilesEngine('crashing', { ...${JSON.stringify(options)}, beforeStep: (phase) => { if (phase === 'after-checkpoint:publishing' && ++count === ${checkpoint}) process.exit(91); } }); await engine.request(${JSON.stringify(command)});`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd() })).rejects.toMatchObject({ code: 91 });
    const restarted = createHostFilesEngine('restarted', options);
    fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.destination, maxEntries: 100 });
    expect(await readdir(destination)).toEqual(['original']);
    expect(await readFile(join(destination, 'original'), 'utf8')).toBe('original');
    expect(await readdir(f.destination)).toEqual(['tree']);
    expect(JSON.parse(await readFile(options.journalFile, 'utf8')).operations).toEqual([]);
  });

  // a second abrupt exit must retain alias freshness already changed by stage cleanup
  it.each(['recovery-stage-cleaned', 'recovery-destination-cleaned'])('survives another crash after %s', async phase => {
    const f = await fixture(); const source = join(f.source, 'tree'); const destination = join(f.destination, 'tree');
    await mkdir(source); await writeFile(join(source, 'new'), 'new'); await mkdir(destination); await writeFile(join(destination, 'old'), 'old');
    const command = await copyCommand(f.engine, source, destination, true); await f.engine.close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/host-files/engine.ts')).href;
    const options = { journalFile: join(f.root, 'journal.json'), favoritesFile: join(f.root, 'favorites.json') };
    // first crash retains both hard-link names before the staging name is unlinked
    const first = `import { createHostFilesEngine } from ${JSON.stringify(moduleUrl)}; let count = 0; const engine = createHostFilesEngine('first', { ...${JSON.stringify(options)}, beforeStep: p => { if (p === 'after-checkpoint:publishing' && ++count === 2) process.exit(91); } }); await engine.request(${JSON.stringify(command)});`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', first])).rejects.toMatchObject({ code: 91 });
    // interrupt the recovery itself after its refreshed authority has been committed
    const second = `import { createHostFilesEngine } from ${JSON.stringify(moduleUrl)}; const engine = createHostFilesEngine('second', { ...${JSON.stringify(options)}, beforeStep: p => { if (p === ${JSON.stringify(`after-checkpoint:${phase}`)}) process.exit(92); } }); await engine.request({ kind:'list', path:${JSON.stringify(f.destination)}, maxEntries:100 });`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', second])).rejects.toMatchObject({ code: 92 });
    const restarted = createHostFilesEngine('third', options);
    fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.destination, maxEntries: 100 });
    expect(await readdir(destination)).toEqual(['old']); expect(await readFile(join(destination, 'old'), 'utf8')).toBe('old');
    expect(await readdir(f.destination)).toEqual(['tree']);
    expect(JSON.parse(await readFile(options.journalFile, 'utf8')).operations).toEqual([]);
  });

  // restoring must never consume the sole original backup before committing its final state
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 'restored', 'restore-backup-cleaned', 'before-recovery-journal-remove'])('retains the original through restoration crash %s', async point => {
    const f = await fixture(); const source = join(f.source, 'tree'); const destination = join(f.destination, 'tree');
    await mkdir(source); await writeFile(join(source, 'replacement'), 'replacement');
    await mkdir(join(destination, 'nested'), { recursive: true }); await writeFile(join(destination, 'nested', 'one'), 'original one'); await writeFile(join(destination, 'two'), 'original two');
    const command = await copyCommand(f.engine, source, destination, true); await f.engine.close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/host-files/engine.ts')).href;
    const options = { journalFile: join(f.root, 'journal.json'), favoritesFile: join(f.root, 'favorites.json') };
    // interrupt initial replacement immediately after reserving its visible root
    const first = `import { createHostFilesEngine } from ${JSON.stringify(moduleUrl)}; const engine = createHostFilesEngine('first', { ...${JSON.stringify(options)}, beforeStep: p => { if (p === 'after-checkpoint:publishing') process.exit(91); } }); await engine.request(${JSON.stringify(command)});`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', first])).rejects.toMatchObject({ code: 91 });
    // crash at each restore publication or its durable completion boundary
    const condition = typeof point === 'number' ? `p === 'after-checkpoint:publishing' && ++count === ${point}` : `p === ${JSON.stringify(point.startsWith('before-') ? point : `after-checkpoint:${point}`)}`;
    const second = `import { createHostFilesEngine } from ${JSON.stringify(moduleUrl)}; let count=0; const engine = createHostFilesEngine('second', { ...${JSON.stringify(options)}, beforeStep: p => { if (${condition}) process.exit(92); } }); await engine.request({kind:'list',path:${JSON.stringify(f.destination)},maxEntries:100});`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', second])).rejects.toMatchObject({ code: 92 });
    const restarted = createHostFilesEngine('third', options); fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.destination, maxEntries: 100 });
    expect((await readdir(destination)).sort()).toEqual(['nested', 'two']);
    expect(await readFile(join(destination, 'nested', 'one'), 'utf8')).toBe('original one'); expect(await readFile(join(destination, 'two'), 'utf8')).toBe('original two');
    expect(await readdir(f.destination)).toEqual(['tree']); expect(JSON.parse(await readFile(options.journalFile, 'utf8')).operations).toEqual([]);
  });

  // directory membership must be frozen before recursive deletion begins
  it('does not delete an unprepared child added after confirmation preparation', async () => {
    const f = await fixture(); const tree = join(f.source, 'tree'); await mkdir(tree); await writeFile(join(tree, 'old'), 'old');
    const identity = await f.engine.request({ kind: 'inspect', path: tree });
    const manifest = await f.engine.request({ kind: 'snapshot', path: tree, maxEntries: 20, maxBytes: 100 });
    await writeFile(join(tree, 'new'), 'outside');
    await expect(f.engine.request({ kind: 'remove', operationId: randomUUID(), items: [{ path: tree, identity, manifest }] })).rejects.toMatchObject({ code: 'stale_object' });
    expect((await readdir(tree)).sort()).toEqual(['new', 'old']);
  });

  // a late child substitution remains untouched even after other owned removal steps
  it('reports a changed descendant rather than unlinking its replacement', async () => {
    let replace = false;
    const f = await fixture({ beforeStep: async (phase, path) => {
      // mutate the selected child between full preflight and its exact unlink
      if (phase === 'before-remove' && path.endsWith('/child') && !replace) { replace = true; await writeFile(path, 'replacement'); }
    } });
    const tree = join(f.source, 'tree'); await mkdir(tree); await writeFile(join(tree, 'child'), 'old');
    const identity = await f.engine.request({ kind: 'inspect', path: tree });
    const manifest = await f.engine.request({ kind: 'snapshot', path: tree, maxEntries: 20, maxBytes: 100 });
    const result = await f.engine.request({ kind: 'remove', operationId: randomUUID(), items: [{ path: tree, identity, manifest }] });
    expect(result.results[0]).toMatchObject({ outcome: 'failed', code: 'stale_object' });
    expect(await readFile(join(tree, 'child'), 'utf8')).toBe('replacement');
  });

  // no-follow deletion acts on symlink entries and preserves targets
  it('deletes a prepared symlink without touching its target', async () => {
    const f = await fixture(); const target = join(f.source, 'target'); const link = join(f.source, 'link');
    await writeFile(target, 'safe'); await symlink(target, link);
    const identity = await f.engine.request({ kind: 'inspect', path: link });
    const manifest = await f.engine.request({ kind: 'snapshot', path: link, maxEntries: 20, maxBytes: 100 });
    const result = await f.engine.request({ kind: 'remove', operationId: randomUUID(), items: [{ path: link, identity, manifest }] });
    expect(result.results[0]?.outcome).toBe('deleted');
    expect(await readFile(target, 'utf8')).toBe('safe');
  });

  // preserve arbitrary binary bytes through exact-size streaming publication
  it('uploads binary bytes without base64 or whole-body buffering', async () => {
    const f = await fixture(); const path = join(f.destination, 'binary'); const data = Buffer.from([0, 255, 128, 1, 13, 10]);
    const parent = await f.engine.request({ kind: 'inspect', path: f.destination });
    const result = await f.engine.write({ kind: 'write', operationId: randomUUID(), path, size: data.length, destinationParentIdentity: parent, replace: false }, Readable.from([data.subarray(0, 2), data.subarray(2)]));
    expect(result.bytesWritten).toBe(data.length);
    expect(await readFile(path)).toEqual(data);
    expect(await readdir(f.destination)).toEqual(['binary']);
  });

  // incomplete and excessive streams cannot create visible final files
  it.each([0, 4])('rejects declared byte-count mismatch %i', async size => {
    const f = await fixture(); const path = join(f.destination, 'file'); const parent = await f.engine.request({ kind: 'inspect', path: f.destination });
    await expect(f.engine.write({ kind: 'write', operationId: randomUUID(), path, size, destinationParentIdentity: parent, replace: false }, Readable.from([Buffer.from('abc')]))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await readdir(f.destination)).toEqual([]);
  });

  // bounded manifests stop before traversing or allocating an oversized tree
  it('enforces recursive entry and byte limits', async () => {
    const f = await fixture(); await writeFile(join(f.source, 'a'), '1234'); await writeFile(join(f.source, 'b'), '5678');
    await expect(f.engine.request({ kind: 'snapshot', path: f.source, maxEntries: 2, maxBytes: 100 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(f.engine.request({ kind: 'snapshot', path: f.source, maxEntries: 10, maxBytes: 4 })).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  // retain explicit two-name phases around favorite persistence for real Unix special objects
  it('renames a real FIFO through link and unlink identity transitions', async () => {
    const f = await fixture(); const source = join(f.source, 'fifo'); const destination = join(f.source, 'renamed');
    await promisify(execFile)('mkfifo', [source]);
    const sourceIdentity = await f.engine.request({ kind: 'inspect', path: source });
    const parent = await f.engine.request({ kind: 'inspect', path: f.source });
    const operationId = randomUUID();
    const linked = await f.engine.request({ kind: 'link-special', operationId, sourcePath: source, sourceIdentity, destinationPath: destination, destinationParentIdentity: parent, replace: false });
    expect(linked.sourceIdentity.ino).toBe(sourceIdentity.ino);
    expect(linked.sourceIdentity.nlink).toBe('2');
    const unlinked = await f.engine.request({ kind: 'unlink-special', operationId, sourcePath: source, sourceIdentity: linked.sourceIdentity, destinationPath: destination, destinationIdentity: linked.destinationIdentity });
    expect(unlinked.destinationIdentity.nlink).toBe('1');
    const final = await f.engine.request({ kind: 'finalize-special', operationId });
    expect(final.results[0]?.outcome).toBe('renamed');
    expect(await readdir(f.source)).toEqual(['renamed']);
    await expect(f.engine.read({ kind: 'read', path: destination })).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  // recovery cleans only exact journal-owned temporary identities
  it('recovers an interrupted stage without globbing unrelated temporary names', async () => {
    const f = await fixture(); await f.engine.close();
    const stage = join(f.destination, '.rac-files-owned'); const outside = join(f.destination, '.rac-files-not-owned');
    await writeFile(stage, 'owned'); await writeFile(outside, 'outside');
    const inspector = createHostFilesEngine('inspect', { journalFile: join(f.root, 'empty.json') });
    const identity = await inspector.request({ kind: 'inspect', path: stage }); await inspector.close();
    const journal = new FileOperationJournal(join(f.root, 'journal.json'));
    await journal.put({ id: randomUUID(), kind: 'copy', phase: 'staged', destination: join(f.destination, 'final'), stage, owned: [{ path: stage, identity }], updatedAt: new Date().toISOString() });
    const restarted = createHostFilesEngine('restarted', { journalFile: join(f.root, 'journal.json') }); fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.destination, maxEntries: 100 });
    expect(await readdir(f.destination)).toEqual(['.rac-files-not-owned']);
    expect(await journal.all()).toHaveLength(1);
    expect(JSON.parse(await readFile(join(f.root, 'journal.json'), 'utf8')).operations).toEqual([]);
  });

  // replace preserves the old inode until the complete favorite-ordered rename succeeds
  it('replaces a prepared collision during a real FIFO rename', async () => {
    const f = await fixture(); const source = join(f.source, 'fifo'); const destination = join(f.source, 'existing');
    await promisify(execFile)('mkfifo', [source]); await writeFile(destination, 'old');
    const sourceIdentity = await f.engine.request({ kind: 'inspect', path: source });
    const destinationIdentity = await f.engine.request({ kind: 'inspect', path: destination });
    const destinationManifest = await f.engine.request({ kind: 'snapshot', path: destination, maxEntries: 10, maxBytes: 100 });
    const parent = await f.engine.request({ kind: 'inspect', path: f.source }); const operationId = randomUUID();
    const linked = await f.engine.request({ kind: 'link-special', operationId, sourcePath: source, sourceIdentity, destinationPath: destination, destinationParentIdentity: parent, destinationIdentity, destinationManifest, replace: true });
    expect(linked.backup?.identity.ino).toBe(destinationIdentity.ino);
    await f.engine.request({ kind: 'unlink-special', operationId, sourcePath: source, sourceIdentity: linked.sourceIdentity, destinationPath: destination, destinationIdentity: linked.destinationIdentity });
    await f.engine.request({ kind: 'finalize-special', operationId });
    expect(await readdir(f.source)).toEqual(['existing']);
    expect((await f.engine.request({ kind: 'inspect', path: destination })).kind).toBe('fifo');
  });

  // restart finishes source removal only when all intended favorites prove phase one committed
  it('recovers a crash after the first atomic special favorite write', async () => {
    const f = await fixture(); const source = join(f.source, 'fifo'); const destination = join(f.source, 'renamed');
    await promisify(execFile)('mkfifo', [source]);
    const sourceIdentity = await f.engine.request({ kind: 'inspect', path: source });
    const store = new HostFileFavoritesStore(join(f.root, 'favorites.json'));
    const favorite = await store.add('place-one', source, sourceIdentity);
    const parent = await f.engine.request({ kind: 'inspect', path: f.source }); const operationId = randomUUID();
    const linked = await f.engine.request({ kind: 'link-special', operationId, sourcePath: source, sourceIdentity, destinationPath: destination, destinationParentIdentity: parent, replace: false });
    await store.rewrite([{ placeId: 'place-one', favoriteId: favorite.id, path: destination, identity: linked.destinationIdentity, freshness: { operationId, state: 'pending-final-ctime' } }]);
    await f.engine.close();
    const restarted = createHostFilesEngine('restarted', { journalFile: join(f.root, 'journal.json'), favoritesFile: join(f.root, 'favorites.json') });
    fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.source, maxEntries: 100 });
    expect(await readdir(f.source)).toEqual(['renamed']);
    const current = await restarted.request({ kind: 'inspect', path: destination });
    expect((await store.list('place-one'))[0]).toMatchObject({ path: destination, identity: { ino: sourceIdentity.ino, ctimeNs: current.ctimeNs } });
    expect((await store.list('place-one'))[0]?.freshness).toBeUndefined();
    expect(JSON.parse(await readFile(join(f.root, 'journal.json'), 'utf8')).operations).toEqual([]);
  });

  // an uncommitted favorite phase rolls back only exact publication links
  it('recovers a crash before phase one without deleting the source', async () => {
    const f = await fixture(); const source = join(f.source, 'fifo'); const destination = join(f.source, 'renamed');
    await promisify(execFile)('mkfifo', [source]);
    const sourceIdentity = await f.engine.request({ kind: 'inspect', path: source });
    const store = new HostFileFavoritesStore(join(f.root, 'favorites.json')); await store.add('place-one', source, sourceIdentity);
    const parent = await f.engine.request({ kind: 'inspect', path: f.source });
    await f.engine.request({ kind: 'link-special', operationId: randomUUID(), sourcePath: source, sourceIdentity, destinationPath: destination, destinationParentIdentity: parent, replace: false });
    await f.engine.close();
    const restarted = createHostFilesEngine('restarted', { journalFile: join(f.root, 'journal.json'), favoritesFile: join(f.root, 'favorites.json') });
    fixtures.push({ root: await mkdtemp(join(tmpdir(), 'rac-engine-close-')), engine: restarted });
    await restarted.request({ kind: 'list', path: f.source, maxEntries: 100 });
    expect(await readdir(f.source)).toEqual(['fifo']);
    expect((await store.list('place-one'))[0]?.path).toBe(source);
  });

});
