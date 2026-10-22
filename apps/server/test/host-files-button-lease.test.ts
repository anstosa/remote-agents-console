import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { HostFilesService } from '../src/host-files/service.js';

const fixtures: Array<{ root: string; service: HostFilesService }> = [];

// close private engines and remove their roots
afterEach(async () => {
  // clean every isolated fixture
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// create one real Files capability fixture
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rac-files-button-lease-'));
  const folder = join(root, 'folder');
  await mkdir(folder);
  let now = 1_000;
  const engine = createHostFilesEngine('button-lease-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
  const service = new HostFilesService({ backend: engine, tokenSecret: 'button-lease-secret-at-least-sixteen', now: () => now });
  fixtures.push({ root, service });
  return { root, folder, service, place: { id: 'place', home: root }, session: { id: 'session' }, advance: (value: number) => { now += value; } };
}

describe('host Files button directory lease', () => {
  // bind the lease to session, Place, generation, expiry and directory identity
  it('resolves only the exact current directory capability', async () => {
    const f = await fixture();
    const listed = await f.service.list(f.place, f.session, f.folder);
    const lease = await f.service.resolveDirectoryCapability(f.place, f.session, listed.destinationDirectoryToken);

    expect(lease).toMatchObject({ canonicalHostPath: f.folder, backendGeneration: 'button-lease-generation', identity: { kind: 'directory' } });
    expect(lease.current()).toBe(true);
    await expect(f.service.resolveDirectoryCapability(f.place, { id: 'other-session' }, listed.destinationDirectoryToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
    await expect(f.service.resolveDirectoryCapability({ id: 'other-place', home: f.root }, f.session, listed.destinationDirectoryToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });

    f.advance(15 * 60_000 + 1);
    expect(lease.current()).toBe(false);
    await expect(f.service.resolveDirectoryCapability(f.place, f.session, listed.destinationDirectoryToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
  });

  // reject a path whose directory object changed after listing
  it('revalidates identity before issuing a host command lease', async () => {
    const f = await fixture();
    const listed = await f.service.list(f.place, f.session, f.folder);
    await rename(f.folder, `${f.folder}-old`);
    await mkdir(f.folder);

    await expect(f.service.resolveDirectoryCapability(f.place, f.session, listed.destinationDirectoryToken)).rejects.toMatchObject({ code: 'stale_object', statusCode: 409 });
  });
});
