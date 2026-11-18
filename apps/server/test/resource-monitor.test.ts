import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseResourceSnapshot, ResourceMonitorService } from '../src/server-admin/resource-monitor.js';
import type { ResourceSnapshot } from '../src/server-admin/resource-contracts.js';
import { linuxDiskUsage } from '../../../scripts/resource-monitor-disks.mjs';

const snapshot: ResourceSnapshot = {
  sampledAt: '2026-11-17T20:00:00.000Z',
  host: {
    cpuPercent: 12.5,
    memory: { usedBytes: 5_000, totalBytes: 10_000 },
    disks: [{ mount: '/', usedBytes: 25_000, totalBytes: 50_000 }]
  }
};

const diskSnapshot: ResourceSnapshot = {
  sampledAt: '2026-11-17T20:00:10.000Z',
  host: { ...snapshot.host!, cpuPercent: null, memory: null }
};

const metricsSnapshot: ResourceSnapshot = {
  ...snapshot,
  host: { ...snapshot.host!, disks: [] }
};

const result = (stdout = `${JSON.stringify(metricsSnapshot)}\n`, code = 0) => ({ code, stdout, stderr: '' });

// emulate only the child lifetime the monitor owns
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  });
}

describe('resource monitor', () => {
  let root: string | undefined;

  // remove only isolated resource-monitor state
  afterEach(async () => {
    vi.unstubAllEnvs();
    // delete a created test checkout
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('validates complete host and WSL resource records', () => {
    const wsl = { ...snapshot.host!, cpuPercent: 20 };
    expect(parseResourceSnapshot(JSON.stringify({ ...snapshot, wsl }))).toEqual({ ...snapshot, wsl });
    expect(parseResourceSnapshot(JSON.stringify({ ...snapshot, host: { ...snapshot.host, cpuPercent: 101 } }))).toBeUndefined();
    expect(parseResourceSnapshot(JSON.stringify({ ...snapshot, host: { ...snapshot.host, memory: { usedBytes: 11, totalBytes: 10 } } }))).toBeUndefined();
    expect(parseResourceSnapshot(JSON.stringify({ ...snapshot, host: { ...snapshot.host, disks: [{ ...snapshot.host!.disks[0], usedBytes: null }] } }))).toBeUndefined();
  });

  it('publishes capacities without collector-only machine or disk identities', () => {
    const disk = { mount: '/', usedBytes: 25_000, totalBytes: 50_000 };
    const host = { cpuPercent: 12.5, memory: { usedBytes: 5_000, totalBytes: 10_000 }, disks: [disk] };
    const privateHost = { ...host, label: 'private-hostname', disks: [{ ...disk, id: 'private-volume-id', label: 'private-volume-label' }] };
    const privateSnapshot = { ...snapshot, host: privateHost, wsl: { ...privateHost, label: 'private-distro' } };
    expect(parseResourceSnapshot(JSON.stringify(privateSnapshot))).toEqual({ sampledAt: snapshot.sampledAt, host, wsl: host });
  });

  // distinguish visible disks from system partitions and incidental mounts
  it('reads capacities for root and attached data without inspecting auxiliary Linux mounts', async () => {
    const mountInfo = [
      '23 1 8:1 / / rw - ext4 /dev/sda1 rw',
      '24 23 8:2 / /boot rw - ext4 /dev/sda2 rw',
      '25 24 8:3 / /boot/efi rw - vfat /dev/sda3 rw',
      '26 23 8:4 / /efi rw - vfat /dev/sda4 rw',
      '27 23 8:5 / /recovery rw - ext4 /dev/sda5 rw',
      '28 23 8:17 / /data rw - ext4 /dev/sdb1 rw',
      '29 23 8:17 / /mnt/extra rw - ext4 /dev/sdb1 rw',
      '30 23 7:0 / /mnt/image rw - ext4 /dev/loop0 rw',
      '31 23 0:39 / /sys rw - sysfs sysfs rw'
    ].join('\n');
    // return distinct filesystem counts for the two selected mounts
    const statFilesystem = vi.fn(async (mount: string) => ({ blocks: mount === '/' ? 100n : 200n, bfree: 30n, bsize: 1024n }));
    await expect(linuxDiskUsage(mountInfo, statFilesystem)).resolves.toEqual([
      { mount: '/', usedBytes: 71_680, totalBytes: 102_400 },
      { mount: '/data', usedBytes: 174_080, totalBytes: 204_800 }
    ]);
    expect(statFilesystem.mock.calls).toEqual([['/', { bigint: true }], ['/data', { bigint: true }]]);
  });

  // resolve and share the executable before any collector starts
  it.each([undefined, '', '/host/node'])('uses the configured host Node or host PATH when RAC_HOST_NODE_BIN=%s', async hostNode => {
    vi.stubEnv('RAC_HOST_NODE_BIN', hostNode);
    vi.stubEnv('RAC_HOST_PATH', '/host/bin:/usr/bin');
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      // return the absolute executable from the host namespace
      if (args.includes('run-shell')) return result('/host/node\n');
      // publish one record for each collector mode
      if (args.includes('new-session')) {
        const output = args.at(args.indexOf('--output') + 1)!;
        const record = args.includes('--stream') ? { sequence: 1, snapshot: metricsSnapshot } : args.includes('--disks') ? diskSnapshot : metricsSnapshot;
        await writeFile(output, JSON.stringify(record));
      }
      return result('');
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, hostRepository: root, tmuxBinary: '/host/tmux', tmuxSocket: '/host/tmux/default', runCommand, pollMs: 1 });
    const [metrics, disks] = await Promise.all([monitor.metrics(), monitor.disks()]);
    expect(metrics).toEqual(metricsSnapshot);
    expect(disks).toEqual(diskSnapshot);
    const controller = new AbortController();
    const published: ResourceSnapshot[] = [];
    await monitor.stream(controller.signal, value => { published.push(value); controller.abort(); });
    expect(published).toEqual([metricsSnapshot]);
    const calls = runCommand.mock.calls.map(([, args]) => args);
    const resolutions = calls.filter(args => args.includes('run-shell'));
    expect(resolutions).toHaveLength(hostNode ? 0 : 1);
    // use the configured host PATH only when discovery is needed
    if (!hostNode) expect(resolutions[0]).toEqual(expect.arrayContaining(['/host/tmux/default', expect.stringContaining('/host/bin:/usr/bin')]));
    const starts = calls.filter(args => args.includes('new-session'));
    expect(starts).toHaveLength(3);
    // verify every mode launches and cleans up its own exact host session
    for (const mode of ['--metrics', '--disks', '--stream']) {
      const start = starts.find(args => args.includes(mode))!;
      expect(start).toEqual(expect.arrayContaining(['/host/node', join(root, 'scripts', 'resource-monitor.mjs'), '--output']));
      expect(calls.some(args => args.includes('kill-session') && args.at(-1) === `=${start.at(start.indexOf('-s') + 1)}`)).toBe(true);
    }
    expect(await readdir(join(root, '.data', 'resource-monitor'))).toEqual([]);
  });

  it('rejects a relative host Node before creating collector files or sessions', async () => {
    vi.stubEnv('RAC_HOST_NODE_BIN', 'relative/node');
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const runCommand = vi.fn(async () => result('', 1));
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, hostRepository: root, tmuxBinary: '/host/tmux', tmuxSocket: '/host/tmux/default', runCommand });
    await expect(monitor.metrics()).resolves.toMatchObject({ host: null });
    await expect(monitor.disks()).resolves.toMatchObject({ host: null });
    const publish = vi.fn();
    await monitor.stream(new AbortController().signal, publish);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ host: null }));
    expect(runCommand).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('coalesces only concurrent native samples', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    let finish: ((value: ReturnType<typeof result>) => void) | undefined;
    let firstCall = true;
    const runCommand = vi.fn(async () => {
      // hold only the first collection open
      if (!firstCall) return result();
      firstCall = false;
      return await new Promise<ReturnType<typeof result>>(resolve => { finish = resolve; });
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, runCommand });

    const first = monitor.metrics();
    const second = monitor.metrics();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    finish?.(result());

    await expect(first).resolves.toEqual(metricsSnapshot);
    await expect(monitor.metrics()).resolves.toEqual(metricsSnapshot);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('coalesces disk-only samples separately and selects disk mode', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    let finish: ((value: ReturnType<typeof result>) => void) | undefined;
    const runCommand = vi.fn(async () => await new Promise<ReturnType<typeof result>>(resolve => { finish = resolve; }));
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, runCommand });

    const first = monitor.disks();
    const second = monitor.disks();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [join(root, 'scripts', 'resource-monitor.mjs'), '--disks'], undefined, 10_000);
    finish?.(result(`${JSON.stringify(diskSnapshot)}\n`));

    await expect(first).resolves.toEqual(diskSnapshot);
  });

  it('coalesces metrics separately from disk samples', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const pending = new Map<string, (value: ReturnType<typeof result>) => void>();
    // hold each collection mode independently
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const mode = args.includes('--metrics') ? 'metrics' : 'disks';
      return await new Promise<ReturnType<typeof result>>(resolve => { pending.set(mode, resolve); });
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, runCommand });

    const firstMetrics = monitor.metrics();
    const secondMetrics = monitor.metrics();
    const disks = monitor.disks();
    expect(firstMetrics).toBe(secondMetrics);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [join(root, 'scripts', 'resource-monitor.mjs'), '--metrics'], undefined, 10_000);
    pending.get('metrics')?.(result(`${JSON.stringify(metricsSnapshot)}\n`));
    pending.get('disks')?.(result(`${JSON.stringify(diskSnapshot)}\n`));

    await expect(firstMetrics).resolves.toEqual(metricsSnapshot);
    await expect(disks).resolves.toEqual(diskSnapshot);
  });

  it('does not label an unbridged container as its host', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const runCommand = vi.fn(async () => result());
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => true, runCommand });

    await expect(monitor.metrics()).resolves.toMatchObject({ host: null, errors: ['Host resource monitoring is unavailable.'] });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('starts no live work before subscription and cleans the native child on disconnect', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const child = new FakeChild();
    // publish one complete atomic live record after startup
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const output = args.at(args.indexOf('--output') + 1)!;
      void (async () => {
        await mkdir(dirname(output), { recursive: true });
        // strip private attributes from live records too
        const privateSample = { ...metricsSnapshot, host: { ...metricsSnapshot.host, label: 'private-machine' } };
        await writeFile(output, JSON.stringify({ sequence: 1, snapshot: privateSample }));
      })();
      return child as unknown as ChildProcess;
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, spawnProcess, pollMs: 1 });
    expect(spawnProcess).not.toHaveBeenCalled();
    const controller = new AbortController();
    const published: ResourceSnapshot[] = [];

    await monitor.stream(controller.signal, value => {
      published.push(value);
      controller.abort();
    });

    expect(published).toEqual([metricsSnapshot]);
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, [join(root, 'scripts', 'resource-monitor.mjs'), '--stream', '--output', expect.any(String), '--lease', expect.any(String)]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await readdir(join(root, '.data', 'resource-monitor'))).toEqual([]);
  });

  it('ends an alive native collector that stops advancing its sequence', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const child = new FakeChild();
    // publish one record and then deliberately stall
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const output = args.at(args.indexOf('--output') + 1)!;
      void (async () => {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ sequence: 1, snapshot: metricsSnapshot }));
      })();
      return child as unknown as ChildProcess;
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, spawnProcess, pollMs: 1, stallMs: 10 });
    const published: ResourceSnapshot[] = [];

    await monitor.stream(new AbortController().signal, value => { published.push(value); });

    expect(published[0]).toEqual(metricsSnapshot);
    expect(published.at(-1)).toMatchObject({ host: null, errors: ['Host resource monitoring is unavailable.'] });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await readdir(join(root, '.data', 'resource-monitor'))).toEqual([]);
  });

  it('rejects oversized native live records and cleans the collector', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const child = new FakeChild();
    // exceed the fixed live-record limit by one byte
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const output = args.at(args.indexOf('--output') + 1)!;
      void (async () => {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, 'x'.repeat(512_001));
      })();
      return child as unknown as ChildProcess;
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, spawnProcess, pollMs: 1 });
    const published: ResourceSnapshot[] = [];

    await monitor.stream(new AbortController().signal, value => { published.push(value); });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ host: null, errors: ['Host resource monitoring is unavailable.'] });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('self-stops the collector and removes bounded artifacts after parent lease expiry', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-lease-'));
    const output = join(root, 'snapshot.json');
    const lease = join(root, 'lease');
    await writeFile(lease, `${Date.now()}\n`);
    const script = join(process.cwd(), '..', '..', 'scripts', 'resource-monitor.mjs');
    const child = spawn(process.execPath, [script, '--stream', '--output', output, '--lease', lease], { stdio: 'ignore' });
    try {
      await vi.waitFor(async () => {
        const value = JSON.parse(await readFile(output, 'utf8')) as { sequence?: number; snapshot?: ResourceSnapshot };
        expect(value.sequence).toBeGreaterThan(0);
        expect(value.snapshot?.host?.disks).toEqual([]);
        expect(value.snapshot?.host?.diskError).toBeUndefined();
        // keep WSL live updates disk-free too
        if (value.snapshot?.wsl !== undefined) {
          expect(value.snapshot.wsl.disks).toEqual([]);
          expect(value.snapshot.wsl.diskError).toBeUndefined();
        }
      }, { timeout: 10_000, interval: 50 });
      const leaseRemovedAt = Date.now();
      await rm(lease, { force: true });

      await expect(Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('collector lease did not expire')), 7_000))
      ])).resolves.toBeDefined();

      expect(Date.now() - leaseRemovedAt).toBeLessThan(3_000);
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(lease, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      // stop only this fixture if an assertion interrupts expiry
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);

  it('stops the exact bridged live collector and removes output on disconnect', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const commands: string[][] = [];
    // publish the first bounded live record from the bridged process
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args.includes('new-session')) {
        const output = args.at(args.indexOf('--output') + 1)!;
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ sequence: 1, snapshot: metricsSnapshot }));
      }
      return result('');
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, hostRepository: root, hostNode: '/host/node', tmuxBinary: '/host/tmux', tmuxSocket: '/host/tmux/default', runCommand, pollMs: 1 });
    const controller = new AbortController();

    await monitor.stream(controller.signal, () => controller.abort());

    const started = commands.find(args => args.includes('new-session'))!;
    const stopped = commands.find(args => args.includes('kill-session'))!;
    expect(started).toEqual(expect.arrayContaining(['/host/node', join(root, 'scripts', 'resource-monitor.mjs'), '--stream', '--output']));
    expect(stopped.at(-1)).toBe(`=${started.at(started.indexOf('-s') + 1)}`);
    expect(await readdir(join(root, '.data', 'resource-monitor'))).toEqual([]);
  });

  it('reads the final atomic result after the bridged process exits', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    let output: string | undefined;
    // publish between the first file read and session-exit observation
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      // retain the exact bridged output path
      if (args.includes('new-session')) output = args.at(args.indexOf('--output') + 1);
      // emulate the collector publishing immediately before exit
      if (args.includes('has-session') && output !== undefined) {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(metricsSnapshot));
        return result('', 1);
      }
      return result('');
    });
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, hostRepository: root, hostNode: '/host/node', tmuxBinary: '/host/tmux', tmuxSocket: '/host/tmux/default', runCommand, pollMs: 1 });

    await expect(monitor.metrics()).resolves.toEqual(metricsSnapshot);
    expect(runCommand.mock.calls.some(([, args]) => args.includes('has-session'))).toBe(true);
    expect(await readdir(join(root, '.data', 'resource-monitor'))).toEqual([]);
  });

  it('returns an unavailable snapshot for malformed collector output', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-resource-monitor-'));
    const monitor = new ResourceMonitorService({ projects: [] }, { checkoutRoot: root, tmuxSocket: null, container: async () => false, runCommand: async () => result('{"host":"container"}') });

    await expect(monitor.metrics()).resolves.toMatchObject({ host: null, errors: ['Host resource monitoring is unavailable.'] });
  });
});
