import { describe, expect, it, vi } from 'vitest';
import { RecoveryResourceSampler } from '../src/server-admin/recovery-resources.js';

const baseTime = Date.parse('2026-11-18T20:00:00.000Z');
const memory = 'MemTotal:        1000 kB\nMemAvailable:     250 kB\n';
const windows = { cpuPercent: 42, memory: { usedBytes: 1024, totalBytes: 2048 }, disks: [{ mount: 'C:\\', usedBytes: 1024, totalBytes: 4096 }] };

// provide one bounded in-memory procfs for focused sampler tests
const procReader = (records: Record<string, string>) => vi.fn(async (path: string, maxBytes: number) => {
  expect(maxBytes).toBe(64 * 1024);
  const value = records[path];
  // mirror a missing procfs record
  if (value === undefined) throw new Error('ENOENT');
  return value;
});

describe('recovery resource sampler', () => {
  it('includes CPU in the first native sample while coalescing and caching reads', async () => {
    let now = baseTime;
    const records = {
      '/test/proc/stat': 'cpu  100 10 40 850 0 0 0 0 0 0\n',
      '/test/proc/meminfo': memory,
      '/test/proc/sys/kernel/osrelease': '6.8.0-generic\n'
    };
    const readText = procReader(records);
    const samples = ['cpu  120 10 50 870 0 0 0 0 0 0\n', 'cpu  125 10 55 910 0 0 0 0 0 0\n'];
    // advance the fixture's counters during each bounded sampling interval
    const waitForCpuSample = vi.fn(async () => { records['/test/proc/stat'] = samples.shift()!; });
    const statFilesystem = vi.fn(async () => ({ blocks: 100n, bfree: 25n, bsize: 1024n }));
    const windowsHostSample = vi.fn(async () => windows);
    const sampler = new RecoveryResourceSampler({
      procRoot: '/test/proc', bridged: false, cacheMs: 500, now: () => now,
      isContainer: async () => false, readText, statFilesystem, waitForCpuSample, windowsHostSample
    });

    const first = sampler.sample();
    const concurrent = sampler.sample();
    expect(concurrent).toBe(first);
    await expect(first).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: {
        cpuPercent: 60,
        memory: { usedBytes: 768_000, totalBytes: 1_024_000 },
        disks: [{ mount: '/', usedBytes: 76_800, totalBytes: 102_400 }]
      }
    });
    expect(statFilesystem).toHaveBeenCalledWith('/');

    now += 499;
    const cached = await sampler.sample();
    expect(cached.sampledAt).toBe('2026-11-18T20:00:00.000Z');
    expect(cached.host?.cpuPercent).toBe(60);
    expect(waitForCpuSample).toHaveBeenCalledTimes(1);
    now += 2;
    await expect(sampler.sample()).resolves.toMatchObject({
      sampledAt: '2026-11-18T20:00:00.501Z',
      host: { cpuPercent: 20 }
    });
    expect(statFilesystem).toHaveBeenCalledTimes(2);
    expect(windowsHostSample).not.toHaveBeenCalled();
  });

  it('keeps a bridged WSL guest separate from its unavailable Windows host', async () => {
    const records = {
      '/host/proc/stat': 'cpu  100 0 50 850 0 0 0 0\n',
      '/host/proc/meminfo': memory,
      '/host/proc/sys/kernel/osrelease': '6.6.87.2-microsoft-standard-WSL2\n'
    };
    const readText = procReader(records);
    const statFilesystem = vi.fn(async () => ({ blocks: 200n, bfree: 50n, bsize: 512n }));
    const sampler = new RecoveryResourceSampler({
      procRoot: '/host/proc', bridged: true, now: () => baseTime,
      readText, statFilesystem, windowsHostSample: async () => null, waitForCpuSample: async () => {
        // include a real rate in the first recovery response
        records['/host/proc/stat'] = 'cpu  125 0 50 925 0 0 0 0\n';
      }
    });

    await expect(sampler.sample()).resolves.toEqual({
      sampledAt: '2026-11-18T20:00:00.000Z',
      host: null,
      wsl: {
        cpuPercent: 25,
        memory: { usedBytes: 768_000, totalBytes: 1_024_000 },
        disks: [{ mount: '/', usedBytes: 76_800, totalBytes: 102_400 }]
      },
      errors: ['Windows host resource monitoring is unavailable in recovery mode.']
    });
    expect(statFilesystem).toHaveBeenCalledWith('/host/proc/1/root');
  });

  // keep Windows CPU, memory, and volumes fresh without queueing on every modal poll
  it('adds Windows host usage to the first WSL sample and reuses it for ten seconds', async () => {
    let now = baseTime;
    const windowsHostSample = vi.fn(async () => windows);
    const sampler = new RecoveryResourceSampler({
      procRoot: '/host/proc', bridged: true, now: () => now, windowsHostSample,
      readText: procReader({ '/host/proc/meminfo': memory, '/host/proc/sys/kernel/osrelease': '6.6-microsoft-WSL2' }),
      statFilesystem: async () => ({ blocks: 100n, bfree: 25n, bsize: 1024n })
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      host: windows,
      wsl: { memory: { usedBytes: 768_000 }, disks: [{ mount: '/', totalBytes: 102_400 }] }
    });
    now += 5_000;
    await expect(sampler.sample()).resolves.toMatchObject({ host: windows });
    expect(windowsHostSample).toHaveBeenCalledTimes(1);
    now += 5_001;
    await expect(sampler.sample()).resolves.toMatchObject({ host: windows });
    expect(windowsHostSample).toHaveBeenCalledTimes(2);
  });

  // fail independently and suppress repeat requests while a host bridge is busy
  it('retains WSL readings while the Windows host retry is deferred', async () => {
    let now = baseTime;
    const windowsHostSample = vi.fn(async () => windows).mockRejectedValueOnce(new Error('helper busy'));
    const sampler = new RecoveryResourceSampler({
      procRoot: '/host/proc', bridged: true, now: () => now, windowsHostSample,
      readText: procReader({ '/host/proc/meminfo': memory, '/host/proc/sys/kernel/osrelease': '6.6-microsoft-WSL2' }),
      statFilesystem: async () => ({ blocks: 100n, bfree: 25n, bsize: 1024n })
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      host: null, wsl: { memory: { usedBytes: 768_000 }, disks: [{ mount: '/' }] },
      errors: expect.arrayContaining(['Windows host resource monitoring is unavailable in recovery mode.'])
    });
    now += 14_999;
    await expect(sampler.sample()).resolves.toMatchObject({ host: null });
    expect(windowsHostSample).toHaveBeenCalledTimes(1);
    now += 1_001;
    await expect(sampler.sample()).resolves.toMatchObject({ host: windows });
    expect(windowsHostSample).toHaveBeenCalledTimes(2);
  });

  // mirror the ordinary compose user without access to the host init's root symlink
  it('uses an existing bind mount only when its device matches the host root', async () => {
    const readText = procReader({
      '/host/proc/1/mountinfo': '21 18 8:304 / / rw - ext4 /dev/example rw\n22 21 8:48 / /mnt/other rw - ext4 /dev/other rw\n',
      '/host/proc/sys/kernel/osrelease': '6.6.87.2-microsoft-standard-WSL2\n'
    });
    const statDevice = vi.fn(async (path: string) => path === '/workspace' ? 0x100830n : 0x830n);
    const statFilesystem = vi.fn(async (path: string) => {
      // deny the direct host root stat and reject unrelated mounts
      if (path !== '/workspace') throw new Error('EACCES');
      return { blocks: 100n, bfree: 25n, bsize: 1024n };
    });
    const sampler = new RecoveryResourceSampler({ procRoot: '/host/proc', bridged: true, readText, statFilesystem, statDevice, windowsHostSample: async () => null });

    const snapshot = await sampler.sample();
    expect(snapshot.wsl?.disks).toEqual([{ mount: '/', usedBytes: 76_800, totalBytes: 102_400 }]);
    expect(snapshot.wsl?.diskError).toBeUndefined();
    expect(statDevice.mock.calls).toEqual([['/etc/localtime'], ['/workspace']]);
    expect(statFilesystem.mock.calls).toEqual([['/host/proc/1/root'], ['/workspace']]);
  });

  // never show a different device or pick arbitrarily from ambiguous root records
  it.each([
    '21 18 8:304 / / rw - ext4 /dev/example rw\n',
    '21 18 8:304 / / rw - ext4 /dev/example rw\n22 21 8:48 / / rw - ext4 /dev/other rw\n'
  ])('reports disk usage unavailable without one proven accessible host root (%j)', async mountInfo => {
    const readText = procReader({ '/host/proc/1/mountinfo': mountInfo });
    const statFilesystem = vi.fn(async () => { throw new Error('EACCES'); });
    const statDevice = vi.fn(async () => 0x830n);
    const sampler = new RecoveryResourceSampler({ procRoot: '/host/proc', bridged: true, readText, statFilesystem, statDevice });

    const snapshot = await sampler.sample();
    expect(snapshot.host?.disks).toEqual([]);
    expect(snapshot.host?.diskError).toBe('Root filesystem usage is unavailable in recovery mode.');
    expect(statFilesystem.mock.calls).toEqual([['/host/proc/1/root']]);
  });

  // a failed CPU interval must not discard working disk or memory readings
  it.each(['cpu  100 0 50 850 0 0 0 0\n', 'cpu  1 0 2 8 0 0 0 0\n', 'malformed\n'])('keeps partial readings when the second CPU counter record is unusable (%j)', async after => {
    const records = { '/test/proc/stat': 'cpu  100 0 50 850 0 0 0 0\n', '/test/proc/meminfo': memory };
    const sampler = new RecoveryResourceSampler({
      procRoot: '/test/proc', bridged: false, isContainer: async () => false, readText: procReader(records),
      statFilesystem: async () => ({ blocks: 100n, bfree: 25n, bsize: 1024n }),
      waitForCpuSample: async () => {
        // replace the baseline with a stalled, reset, or malformed sample
        records['/test/proc/stat'] = after;
      }
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      host: { cpuPercent: null, memory: { usedBytes: 768_000 }, disks: [{ mount: '/', totalBytes: 102_400 }] },
      errors: ['CPU usage is unavailable in recovery mode.']
    });
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
