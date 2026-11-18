import { describe, expect, it, vi } from 'vitest';
import { RecoveryResourceSampler } from '../src/server-admin/recovery-resources.js';

const baseTime = Date.parse('2026-11-18T20:00:00.000Z');
const memory = 'MemTotal:        1000 kB\nMemAvailable:     250 kB\n';

// provide one bounded in-memory procfs for focused sampler tests
const procReader = (records: Record<string, string>) => vi.fn(async (path: string, maxBytes: number) => {
  expect(maxBytes).toBe(64 * 1024);
  const value = records[path];
  // mirror a missing procfs record
  if (value === undefined) throw new Error('ENOENT');
  return value;
});

describe('recovery resource sampler', () => {
  it('coalesces, caches, and derives CPU usage between native snapshots', async () => {
    let now = baseTime;
    const records = {
      '/test/proc/stat': 'cpu  100 10 40 850 0 0 0 0 0 0\n',
      '/test/proc/meminfo': memory,
      '/test/proc/sys/kernel/osrelease': '6.8.0-generic\n'
    };
    const readText = procReader(records);
    const statFilesystem = vi.fn(async () => ({ blocks: 100n, bfree: 25n, bsize: 1024n }));
    const sampler = new RecoveryResourceSampler({
      procRoot: '/test/proc', bridged: false, cacheMs: 500, now: () => now,
      isContainer: async () => false, readText, statFilesystem
    });

    const first = sampler.sample();
    const concurrent = sampler.sample();
    expect(concurrent).toBe(first);
    await expect(first).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: {
        cpuPercent: null,
        memory: { usedBytes: 768_000, totalBytes: 1_024_000 },
        disks: [{ mount: '/', usedBytes: 76_800, totalBytes: 102_400 }]
      }
    });
    expect(statFilesystem).toHaveBeenCalledWith('/');

    records['/test/proc/stat'] = 'cpu  120 10 50 870 0 0 0 0 0 0\n';
    now += 499;
    const cached = await sampler.sample();
    expect(cached.sampledAt).toBe('2026-11-18T20:00:00.000Z');
    now += 2;
    await expect(sampler.sample()).resolves.toMatchObject({
      sampledAt: '2026-11-18T20:00:00.501Z',
      host: { cpuPercent: 60 }
    });
    expect(statFilesystem).toHaveBeenCalledTimes(2);
  });

  it('keeps a bridged WSL guest separate from its unavailable Windows host', async () => {
    const readText = procReader({
      '/host/proc/stat': 'cpu  100 0 50 850 0 0 0 0\n',
      '/host/proc/meminfo': memory,
      '/host/proc/sys/kernel/osrelease': '6.6.87.2-microsoft-standard-WSL2\n'
    });
    const statFilesystem = vi.fn(async () => ({ blocks: 200n, bfree: 50n, bsize: 512n }));
    const sampler = new RecoveryResourceSampler({
      procRoot: '/host/proc', bridged: true, now: () => baseTime,
      readText, statFilesystem
    });

    await expect(sampler.sample()).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: null,
      wsl: {
        cpuPercent: null,
        memory: { usedBytes: 768_000, totalBytes: 1_024_000 },
        disks: [{ mount: '/', usedBytes: 76_800, totalBytes: 102_400 }]
      },
      errors: ['Windows host resource monitoring is unavailable in recovery mode.']
    });
    expect(statFilesystem).toHaveBeenCalledWith('/host/proc/1/root');
  });

  it('retains partial readings and reports each unavailable resource', async () => {
    const readText = procReader({
      '/test/proc/stat': 'not a cpu record\n',
      '/test/proc/meminfo': 'MemTotal: 1000 kB\n',
      '/test/proc/sys/kernel/osrelease': '6.8.0-generic\n'
    });
    const sampler = new RecoveryResourceSampler({
      procRoot: '/test/proc', bridged: false, now: () => baseTime,
      isContainer: async () => false, readText,
      statFilesystem: async () => { throw new Error('unmapped namespace'); }
    });

    await expect(sampler.sample()).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: {
        cpuPercent: null,
        memory: null,
        disks: [],
        diskError: 'Root filesystem usage is unavailable in recovery mode.'
      },
      errors: [
        'CPU usage is unavailable in recovery mode.',
        'Memory usage is unavailable in recovery mode.'
      ]
    });
  });

  it('never presents an unbridged container namespace as its host', async () => {
    const readText = vi.fn(async () => '');
    const statFilesystem = vi.fn(async () => ({ blocks: 1n, bfree: 0n, bsize: 1n }));
    const sampler = new RecoveryResourceSampler({
      procRoot: '/proc', bridged: false, now: () => baseTime,
      isContainer: async () => true, readText, statFilesystem
    });

    await expect(sampler.sample()).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: null,
      errors: ['Host process namespace is unavailable in recovery mode.']
    });
    expect(readText).not.toHaveBeenCalled();
    expect(statFilesystem).not.toHaveBeenCalled();
  });
});
