import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationPolicyService } from '../src/integrations/policy/service.js';

// fail only the nondeterministic filesystem boundary
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, readFile: vi.fn(real.readFile), mkdir: vi.fn(real.mkdir), writeFile: vi.fn(real.writeFile), chmod: vi.fn(real.chmod), rename: vi.fn(real.rename) };
});
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [];

// restore real I/O and remove only isolated temporary stores
afterEach(async () => {
  vi.mocked(files.readFile).mockReset().mockImplementation(real.readFile);
  vi.mocked(files.mkdir).mockReset().mockImplementation(real.mkdir);
  vi.mocked(files.writeFile).mockReset().mockImplementation(real.writeFile);
  vi.mocked(files.chmod).mockReset().mockImplementation(real.chmod);
  vi.mocked(files.rename).mockReset().mockImplementation(real.rename);
  await Promise.all(directories.splice(0).map(path => real.rm(path, { recursive: true, force: true })));
});

// retain one private, otherwise real policy store per scenario
async function fixture() {
  const directory = await real.mkdtemp(join(tmpdir(), 'rac-policy-failure-'));
  directories.push(directory);
  const file = join(directory, 'policy.json');
  const service = new IntegrationPolicyService(file);
  return { file, service, claim: async () => await service.claim('owner', 'queue_prompt', 'request-id', 'digest') };
}

describe('policy publication failures', () => {
  // no preparation failure may publish a claim or bypass retry protection
  it.each(['readFile', 'mkdir', 'writeFile', 'chmod'] as const)('refuses %s failure before publication', async operation => {
    const { file, claim } = await fixture();
    vi.mocked(files[operation]).mockRejectedValueOnce(Object.assign(new Error('private storage failure'), { code: 'EACCES' }));
    await expect(claim()).rejects.toBeDefined();
    await expect(real.readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(files.rename).not.toHaveBeenCalled();
    await expect(claim()).resolves.toMatchObject({ kind: 'claimed' });
  });

  // a refused atomic rename is known not to have published its private stage
  it('distinguishes a failed rename before publication', async () => {
    const { claim } = await fixture();
    vi.mocked(files.rename).mockRejectedValueOnce(new Error('rename refused'));
    await expect(claim()).rejects.toMatchObject({ publication: 'not_published' });
    await expect(claim()).resolves.toMatchObject({ kind: 'claimed' });
  });

  // a transport-style error after rename must not expose the claim as absent
  it('retains a published claim after an ambiguous rename response', async () => {
    const { file, service, claim } = await fixture();
    vi.mocked(files.rename).mockImplementationOnce(async (from, to) => { await real.rename(from, to); throw new Error('rename response lost'); });
    await expect(claim()).rejects.toMatchObject({ publication: 'published' });
    expect(JSON.parse(await real.readFile(file, 'utf8')).idempotency).toHaveLength(1);
    await expect(claim()).resolves.toMatchObject({ kind: 'in_progress' });
    await service.recoverUnknownOutcomes();
    await expect(claim()).resolves.toMatchObject({ kind: 'replay', state: 'unknown_outcome' });
  });

  // unreadable publication evidence stays uncertain instead of authorizing another effect
  it('reports an unknown rename outcome when reconciliation is unreadable', async () => {
    const { claim } = await fixture();
    vi.mocked(files.rename).mockImplementationOnce(async () => {
      vi.mocked(files.readFile).mockRejectedValueOnce(Object.assign(new Error('private read failure'), { code: 'EACCES' }));
      throw new Error('rename outcome unavailable');
    });
    await expect(claim()).rejects.toMatchObject({ publication: 'unknown' });
  });

  // permissions become private before the atomic publication point
  it('sets stage permissions before rename and performs no fallible work afterward', async () => {
    const { file, claim } = await fixture();
    await real.writeFile(`${file}.next`, '', { mode: 0o644 });
    vi.mocked(files.rename).mockImplementationOnce(async (from, to) => {
      expect((await real.stat(from)).mode & 0o777).toBe(0o600);
      await real.rename(from, to);
    });
    await expect(claim()).resolves.toMatchObject({ kind: 'claimed' });
    expect(files.chmod).toHaveBeenCalledExactlyOnceWith(`${file}.next`, 0o600);
    expect((await real.stat(file)).mode & 0o777).toBe(0o600);
  });
});
