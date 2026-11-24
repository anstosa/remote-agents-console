import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentUpdateJobStore, type AgentUpdateJobRecord } from '../src/agent-updates/job-store.js';

const roots: string[] = [];
const authority = 'a'.repeat(64);

// create one owner-private checkout fixture
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-agent-update-jobs-'));
  roots.push(root);
  return root;
}

// build one durable running record
function running(id = '1'.repeat(24)): AgentUpdateJobRecord {
  return { version: 1, id, kind: 'codex', state: 'running', phase: 'install', startedAt: 10, deadline: 1_000, previousVersion: '1.0.0', targetVersion: '1.1.0', installerLock: '12:345678901234567890', authority };
}

// build one durable terminal record
function complete(id: string, finishedAt: number): AgentUpdateJobRecord {
  return { version: 1, id, kind: 'codex', state: 'complete', startedAt: 1, finishedAt, authority, agent: { kind: 'codex', currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false } };
}

describe('agent update job store', () => {
  // remove only this suite's private fixtures
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('does not create storage for an empty status read', async () => {
    const root = await fixture();
    const store = new AgentUpdateJobStore(root);

    await expect(store.read('1'.repeat(24))).resolves.toBeUndefined();
    await expect(store.active()).resolves.toBeUndefined();
    await expect(lstat(join(root, '.data'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists one active job across store instances', async () => {
    const root = await fixture();
    const expected = running();
    await new AgentUpdateJobStore(root).write(expected);

    const recovered = new AgentUpdateJobStore(root);
    await expect(recovered.read(expected.id)).resolves.toEqual(expected);
    await expect(recovered.active()).resolves.toEqual(expected);
    expect((await readdir(join(root, '.data', 'agent-updates', 'jobs'))).sort()).toEqual([`${expected.id}.job.json`]);
  });

  it('preserves older running records without claiming lock continuity', async () => {
    const root = await fixture();
    const store = new AgentUpdateJobStore(root);
    const expected = { ...running(), installerLock: undefined };
    await store.write(expected);
    await expect(store.active()).resolves.toEqual(expected);
  });

  it('serializes admission across independent store instances', async () => {
    const root = await fixture();
    const otherRoot = await fixture();
    const first = new AgentUpdateJobStore(root);
    const second = new AgentUpdateJobStore(root);
    const other = new AgentUpdateJobStore(otherRoot);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const admitted = first.withLock(async () => {
      order.push('first-enter');
      await gate;
      order.push('first-exit');
    });
    await expect.poll(() => order).toEqual(['first-enter']);
    const waiting = second.withLock(async () => { order.push('second-enter'); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(order).toEqual(['first-enter']);
    await other.withLock(async () => { order.push('other-enter'); });
    expect(order).toEqual(['first-enter', 'other-enter']);

    releaseFirst();
    await Promise.all([admitted, waiting]);
    expect(order).toEqual(['first-enter', 'other-enter', 'first-exit', 'second-enter']);
  });

  it('rejects invalid identities, records, entries, and exposed storage', async () => {
    const root = await fixture();
    const store = new AgentUpdateJobStore(root);
    await expect(store.read('../escape')).rejects.toThrow('invalid agent update job id');
    await expect(store.write({ ...running(), targetVersion: '0.9.0' })).rejects.toThrow('invalid agent update job record');
    await expect(store.write({ ...running(), installerLock: 'unknown' })).rejects.toThrow('invalid agent update job record');

    await store.write(running());
    const jobs = join(root, '.data', 'agent-updates', 'jobs');
    const malformedId = '2'.repeat(24);
    await writeFile(join(jobs, `${malformedId}.job.json`), '{', { mode: 0o600 });
    await expect(store.active()).rejects.toThrow('invalid agent update job record');
    await rm(join(jobs, `${malformedId}.job.json`));
    await symlink('missing', join(jobs, `${malformedId}.job.json`));
    await expect(store.active()).rejects.toThrow('invalid agent update job entry');
    await rm(join(jobs, `${malformedId}.job.json`));
    await chmod(jobs, 0o755);
    await expect(store.active()).rejects.toThrow(/invalid.*agent update.*directory/u);
    await chmod(jobs, 0o700);
    await chmod(join(root, '.data'), 0o777);
    await expect(store.active()).rejects.toThrow(/invalid.*agent update.*directory/u);
  });

  it('fails closed when more than one running record exists', async () => {
    const root = await fixture();
    const store = new AgentUpdateJobStore(root);
    await store.write(running('1'.repeat(24)));
    await store.write({ version: 1, id: '2'.repeat(24), kind: 'codex', state: 'running', phase: 'preflight', startedAt: 10, deadline: 2_000, authority });
    await expect(store.active()).rejects.toThrow('multiple active agent update jobs');
  });

  it('retains the selected terminal record, the newest history, and every running job', async () => {
    const root = await fixture();
    const store = new AgentUpdateJobStore(root);
    const ids = Array.from({ length: 35 }, (_, index) => index.toString(16).padStart(24, '0'));
    // exceed terminal retention with deterministic completion order
    for (const [index, id] of ids.entries()) {
      const record = complete(id, index + 2);
      // retain one terminal receipt's cleanup authority through a failed prune
      await store.write(record.state === 'complete' && index === 1 ? { ...record, cleanupEligible: true } : record);
    }
    const active = running('f'.repeat(24));
    await store.write(active);

    await expect(store.prune(ids[0]!, async record => {
      // a transient cleanup failure must not erase the proof needed for recovery
      if (record.id === ids[1]) throw new Error('cleanup unavailable');
    })).rejects.toThrow('cleanup unavailable');
    await expect(store.read(ids[1]!)).resolves.toMatchObject({ cleanupEligible: true });
    await store.prune(ids[0]!);

    const jobs = (await readdir(join(root, '.data', 'agent-updates', 'jobs'))).filter(name => name.endsWith('.job.json'));
    expect(jobs).toHaveLength(33);
    await expect(store.read(ids[0]!)).resolves.toBeDefined();
    await expect(store.read(ids[1]!)).resolves.toBeUndefined();
    await expect(store.read(ids[2]!)).resolves.toBeUndefined();
    await expect(store.read(ids[3]!)).resolves.toBeUndefined();
    await expect(store.active()).resolves.toEqual(active);
  }, 45_000);
});
