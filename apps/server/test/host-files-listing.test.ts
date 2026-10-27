import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { HostFilesService } from '../src/host-files/service.js';

const failures = vi.hoisted(() => ({ metadata: new Map<string, string>(), listings: new Map<string, string>() }));

// emulate Windows metadata denials while retaining real directory contents
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...filesystem,
    // deny only explicitly marked fixture metadata
    lstat: (...args: Parameters<typeof filesystem.lstat>) => {
      const code = failures.metadata.get(String(args[0]));
      // preserve native failures at the exact denied pathname
      if (code !== undefined) return Promise.reject(Object.assign(new Error('fixture metadata failure'), { code }));
      return filesystem.lstat(...args);
    },
    // distinguish an unreadable directory from unreadable child metadata
    readdir: (...args: Parameters<typeof filesystem.readdir>) => {
      const code = failures.listings.get(String(args[0]));
      // deny the directory read before any child inspection
      if (code !== undefined) return Promise.reject(Object.assign(new Error('fixture listing failure'), { code }));
      return filesystem.readdir(...args);
    }
  };
});

const fixtures: Array<{ root: string; service: HostFilesService }> = [];

// close only test-owned jobs before removing their disposable directories
afterEach(async () => {
  failures.metadata.clear();
  failures.listings.clear();
  // clean every fixture even when listing failed
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// construct one real filesystem and service boundary per test
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rac-files-listing-'));
  const directory = join(root, 'drive');
  await mkdir(directory);
  await writeFile(join(directory, 'accessible.txt'), 'readable');
  await writeFile(join(directory, 'protected.sys'), 'protected');
  const engine = createHostFilesEngine('listing-fixture', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
  const service = new HostFilesService({ backend: engine, tokenSecret: 'listing-fixture-secret-at-least-sixteen' });
  fixtures.push({ root, service });
  return { directory, engine, service, place: { id: 'listing-place', home: directory }, session: { id: 'listing-session' } };
}

describe('host Files partial directory listings', () => {
  // one Windows-protected child must not hide its readable neighbors
  it.each(['EACCES', 'EPERM'])('lists accessible entries when child metadata returns %s', async code => {
    const f = await fixture();
    failures.metadata.set(join(f.directory, 'protected.sys'), code);
    const listed = await f.service.list(f.place, f.session);
    expect(listed.path).toBe(f.directory);
    expect(listed.entries.map(entry => entry.name)).toEqual(['accessible.txt']);
    expect(listed.inaccessibleEntries).toBe(1);
    expect(listed.truncated).toBe(false);
    expect(listed.directoryEntry.kind).toBe('directory');
    expect(listed.destinationDirectoryToken).toEqual(expect.any(String));
    await expect(f.engine.request({ kind: 'inspect', path: join(f.directory, 'protected.sys') })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  // permissions on the directory itself still enforce the host user's boundary
  it('rejects an unreadable directory rather than returning an empty success', async () => {
    const f = await fixture();
    failures.listings.set(f.directory, 'EACCES');
    await expect(f.service.list(f.place, f.session)).rejects.toMatchObject({ code: 'permission_denied', statusCode: 403 });
  });

  // disappearing children are not reported as permission failures
  it('does not count concurrently missing children as inaccessible', async () => {
    const f = await fixture();
    failures.metadata.set(join(f.directory, 'protected.sys'), 'ENOENT');
    const listed = await f.service.list(f.place, f.session);
    expect(listed.entries.map(entry => entry.name)).toEqual(['accessible.txt']);
    expect(listed.inaccessibleEntries).toBe(0);
  });

  // unrelated filesystem failures remain visible rather than silently hiding data
  it('does not swallow child I/O failures', async () => {
    const f = await fixture();
    failures.metadata.set(join(f.directory, 'protected.sys'), 'EIO');
    await expect(f.service.list(f.place, f.session)).rejects.toMatchObject({ code: 'partial_failure', statusCode: 500 });
  });

  // count only bounded entries attempted by this listing
  it('keeps permission omissions separate from listing truncation', async () => {
    const f = await fixture();
    failures.metadata.set(join(f.directory, 'accessible.txt'), 'EACCES');
    const listed = await f.engine.request({ kind: 'list', path: f.directory, maxEntries: 1 });
    expect(listed.entries).toEqual([]);
    expect(listed.inaccessibleEntries).toBe(1);
    expect(listed.truncated).toBe(true);
  });
});

// host file capabilities must not inline only the first part of a raster
describe('host Files bounded previews', () => {
  // preserve the real size when the host stream stops at its preview cap
  it('returns oversized images as metadata without partial base64', async () => {
    const f = await fixture();
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5 * 1024 * 1024)]);
    await writeFile(join(f.directory, 'large.png'), bytes);
    const listed = await f.service.list(f.place, f.session);
    const entry = listed.entries.find(candidate => candidate.name === 'large.png');
    // require the real listed capability rather than manufacturing a token
    if (entry === undefined) throw new Error('image fixture was not listed');
    const preview = await f.service.preview(f.place, f.session, entry.objectToken);
    expect(preview.binary).toBe(true);
    expect(preview.size).toBe(bytes.length);
    expect('image' in preview).toBe(false);
  });
});
