import { stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostSettingsTransport, recoveryResourceTransportMs, settingsControlRoot } from '../settings/transport.js';
import { containerized, readBoundedText } from './recovery-proc.js';
import type { ResourceSnapshot, ResourceUsage } from './resource-contracts.js';

type CpuCounters = { idle: number; total: number };
type SampledValue<T> = { value: T; error?: string };
type FilesystemStats = { blocks: bigint; bfree: bigint; bsize: bigint };
type DiskCapacity = { usedBytes: number; totalBytes: number };

export type RecoveryResourceSamplerOptions = {
  procRoot?: string;
  bridged?: boolean;
  cacheMs?: number;
  now?: () => number;
  isContainer?: () => Promise<boolean>;
  readText?: (path: string, maxBytes: number) => Promise<string>;
  waitForCpuSample?: () => Promise<void>;
  statFilesystem?: (path: string) => Promise<FilesystemStats>;
  statDevice?: (path: string) => Promise<bigint>;
  windowsHostSample?: () => Promise<ResourceUsage | null>;
};

const maxProcBytes = 64 * 1024;
const defaultCacheMs = 1_000;
const cpuSampleMs = 250;
const windowsCacheMs = 10_000;
const windowsRetryMs = 15_000;
// use the existing compose bind mounts without exposing any new host paths
const rootDiskProbes = ['/etc/localtime', '/workspace'];
const cpuUnavailable = 'CPU usage is unavailable in recovery mode.';
const memoryUnavailable = 'Memory usage is unavailable in recovery mode.';
const diskUnavailable = 'Root filesystem usage is unavailable in recovery mode.';
const windowsUnavailable = 'Windows host resource monitoring is unavailable in recovery mode.';

// parse the aggregate Linux CPU counters without double-counting guest time
const parseCpuCounters = (text: string): CpuCounters | undefined => {
  const line = text.split('\n', 1)[0];
  // require the aggregate record and its four mandatory counters
  if (line === undefined || !/^cpu\s/u.test(line)) return undefined;
  const fields = line.trim().split(/\s+/u).slice(1, 9).map(Number);
  // reject truncated or non-numeric kernel records
  if (fields.length < 4 || fields.some(field => !Number.isFinite(field) || field < 0)) return undefined;
  return { idle: fields[3]! + (fields[4] ?? 0), total: fields.reduce((sum, field) => sum + field, 0) };
};

// parse MemTotal and MemAvailable into the shared byte-based contract
const parseMemory = (text: string): ResourceUsage['memory'] => {
  const totalKb = /^MemTotal:\s+(\d+)\s+kB$/mu.exec(text)?.[1];
  const availableKb = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(text)?.[1];
  // require both kernel values so cache and reclaimable memory are not counted as used
  if (totalKb === undefined || availableKb === undefined) return null;
  const totalBytes = Number(totalKb) * 1024;
  const availableBytes = Number(availableKb) * 1024;
  // reject unsafe or internally inconsistent capacities
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes) || totalBytes <= 0 || availableBytes > totalBytes) return null;
  return { usedBytes: totalBytes - availableBytes, totalBytes };
};

// convert bigint filesystem counters only while the public byte values remain exact
const diskCapacity = (stats: FilesystemStats): DiskCapacity | undefined => {
  const total = stats.blocks * stats.bsize;
  const free = stats.bfree * stats.bsize;
  // reject invalid counters before converting them to JSON numbers
  if (stats.blocks <= 0n || stats.bfree < 0n || stats.bsize <= 0n || free > total || total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { usedBytes: Number(total - free), totalBytes: Number(total) };
};

// identify the host root using mountinfo and linux's stat device encoding
const rootMountDevice = (mountInfo: string): bigint | undefined => {
  const devices = new Set<bigint>();
  // accept only a unique device for the exact root mountpoint
  for (const line of mountInfo.split('\n')) {
    const fields = line.split(' ', 6);
    // the fifth field is the mountpoint rather than the filesystem's subtree
    if (fields[4] !== '/') continue;
    const match = /^(\d{1,10}):(\d{1,10})$/u.exec(fields[2] ?? '');
    // reject ambiguous or malformed root records
    if (match === null || fields.length < 6) return undefined;
    const major = BigInt(match[1]!);
    const minor = BigInt(match[2]!);
    // dev_t stores two unsigned 32-bit device numbers across disjoint bits
    if (major > 0xffffffffn || minor > 0xffffffffn) return undefined;
    devices.add(((major & 0xfffn) << 8n) | ((major & ~0xfffn) << 32n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n));
  }
  return devices.size === 1 ? devices.values().next().value : undefined;
};

// sample emergency metrics without entering the tmux control plane
export class RecoveryResourceSampler {
  private readonly procRoot: string;
  private readonly bridged: boolean;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly isContainer: () => Promise<boolean>;
  private readonly readText: (path: string, maxBytes: number) => Promise<string>;
  private readonly waitForCpuSample: () => Promise<void>;
  private readonly statFilesystem: (path: string) => Promise<FilesystemStats>;
  private readonly statDevice: (path: string) => Promise<bigint>;
  private readonly windowsHostSample: () => Promise<ResourceUsage | null>;
  private windowsCached?: { expiresAt: number; usage: ResourceUsage | null };
  private cached?: { expiresAt: number; snapshot: ResourceSnapshot };
  private inFlight?: Promise<ResourceSnapshot>;

  // bind one sampler to either the native namespace or the configured host procfs bridge
  constructor(options: RecoveryResourceSamplerOptions = {}) {
    const environmentProcRoot = process.env.RAC_HOST_PROC?.trim();
    this.procRoot = options.procRoot ?? (environmentProcRoot || '/proc');
    this.bridged = options.bridged ?? (environmentProcRoot !== undefined && environmentProcRoot !== '');
    this.cacheMs = Math.max(0, options.cacheMs ?? defaultCacheMs);
    this.now = options.now ?? Date.now;
    this.readText = options.readText ?? readBoundedText;
    this.isContainer = options.isContainer ?? (() => containerized(this.readText));
    // bound the counter window inside one recovery request
    this.waitForCpuSample = options.waitForCpuSample ?? (() => delay(cpuSampleMs));
    this.statFilesystem = options.statFilesystem ?? (path => statfs(path, { bigint: true }));
    // use the device of the mounted file itself rather than the container root
    this.statDevice = options.statDevice ?? (async path => (await stat(path, { bigint: true })).dev);
    const host = new HostSettingsTransport(settingsControlRoot(), recoveryResourceTransportMs);
    // Windows interop belongs to the host helper, never to a tmux pane
    this.windowsHostSample = options.windowsHostSample ?? (() => host.recoveryResources());
  }

  // coalesce concurrent requests and reuse one recent recovery sample
  sample(): Promise<ResourceSnapshot> {
    const now = this.now();
    // return only a sample still inside its short recovery cache window
    if (this.cached !== undefined && now < this.cached.expiresAt) return Promise.resolve(this.cached.snapshot);
    // share direct procfs work already in progress
    if (this.inFlight !== undefined) return this.inFlight;
    const current = this.collect(now).then(snapshot => {
      this.cached = { expiresAt: this.now() + this.cacheMs, snapshot };
      return snapshot;
    }).finally(() => {
      // clear only the request that still owns the active slot
      if (this.inFlight === current) this.inFlight = undefined;
    });
    this.inFlight = current;
    return current;
  }

  // select one truthful OS boundary and retain all independently available readings
  private async collect(sampledAt: number): Promise<ResourceSnapshot> {
    // fail closed rather than publishing a container's private resources as its host
    if (!this.bridged && await this.isContainer().catch(() => true)) {
      return { sampledAt: new Date(sampledAt).toISOString(), host: null, errors: ['Host process namespace is unavailable in recovery mode.'] };
    }
    const [[wsl, windows], usage] = await Promise.all([this.hostBoundary(), this.usage()]);
    const errors = [...usage.errors];
    // keep the Windows host distinct from its sampled WSL guest
    if (wsl) {
      if (windows === null) errors.push(windowsUnavailable);
      return { sampledAt: new Date(sampledAt).toISOString(), host: windows, wsl: usage.value, ...(errors.length === 0 ? {} : { errors }) };
    }
    return { sampledAt: new Date(sampledAt).toISOString(), host: usage.value, ...(errors.length === 0 ? {} : { errors }) };
  }

  // skip Windows interop on Linux and rate-limit the read-only host queue
  private async hostBoundary(): Promise<[isWsl: boolean, windows: ResourceUsage | null]> {
    if (!/(?:microsoft|wsl)/iu.test(await this.kernelRelease())) return [false, null];
    const cached = this.windowsCached;
    // share fresh Windows data or a bounded retry interval across browser polls
    if (cached !== undefined && this.now() < cached.expiresAt) return [true, cached.usage];
    const usage = await this.windowsHostSample().catch(() => null);
    this.windowsCached = { usage, expiresAt: this.now() + (usage === null ? windowsRetryMs : windowsCacheMs) };
    return [true, usage];
  }

  // sample CPU, memory, and a verified namespace root independently
  private async usage(): Promise<{ value: ResourceUsage; errors: string[] }> {
    const [cpu, memory, disk] = await Promise.all([this.cpu(), this.memory(), this.disk()]);
    const errors = [cpu.error, memory.error].filter((error): error is string => error !== undefined);
    return {
      value: {
        cpuPercent: cpu.value,
        memory: memory.value,
        disks: disk.value === undefined ? [] : [{ mount: '/', ...disk.value }],
        ...(disk.error === undefined ? {} : { diskError: disk.error })
      },
      errors
    };
  }

  // read one aggregate counter snapshot from the selected namespace
  private async cpuCounters(): Promise<CpuCounters | undefined> {
    const text = await this.readText(join(this.procRoot, 'stat'), maxProcBytes).catch(() => undefined);
    return text === undefined ? undefined : parseCpuCounters(text);
  }

  // measure a fresh interval even on the first request after disconnection
  private async cpu(): Promise<SampledValue<number | null>> {
    const previous = await this.cpuCounters();
    // skip the sampling delay if the host cannot provide a baseline
    if (previous === undefined) return { value: null, error: cpuUnavailable };
    await this.waitForCpuSample();
    const current = await this.cpuCounters();
    // return a partial snapshot when the second read fails
    if (current === undefined) return { value: null, error: cpuUnavailable };
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    // do not treat stalled or inconsistent counters as actual usage
    if (total <= 0 || idle < 0 || idle > total) return { value: null, error: cpuUnavailable };
    const percent = ((total - idle) / total) * 100;
    return { value: Math.round(percent * 10) / 10 };
  }

  // read memory from the same selected process namespace
  private async memory(): Promise<SampledValue<ResourceUsage['memory']>> {
    const text = await this.readText(join(this.procRoot, 'meminfo'), maxProcBytes).catch(() => undefined);
    const value = text === undefined ? null : parseMemory(text);
    return value === null ? { value, error: memoryUnavailable } : { value };
  }

  // inspect capacity only for a verified filesystem path
  private async diskAt(path: string): Promise<DiskCapacity | undefined> {
    const stats = await this.statFilesystem(path).catch(() => undefined);
    return stats === undefined ? undefined : diskCapacity(stats);
  }

  // check existing compose mounts when the container cannot follow the host init's root
  private async bridgedRootDisk(): Promise<DiskCapacity | undefined> {
    const direct = await this.diskAt(join(this.procRoot, '1', 'root'));
    // preserve direct access on deployments that already have it
    if (direct !== undefined) return direct;
    const mountInfo = await this.readText(join(this.procRoot, '1', 'mountinfo'), maxProcBytes).catch(() => undefined);
    const rootDevice = mountInfo === undefined ? undefined : rootMountDevice(mountInfo);
    // never present container or unrelated volume usage as the host root
    if (rootDevice === undefined) return undefined;
    // only statfs a mount on the host root device
    for (const path of rootDiskProbes) {
      const device = await this.statDevice(path).catch(() => undefined);
      // skip mounts on a different filesystem
      if (device !== rootDevice) continue;
      const capacity = await this.diskAt(path);
      // retain the first usable verified capacity
      if (capacity !== undefined) return capacity;
    }
    return undefined;
  }

  // inspect only a root path proven by the selected native or bridged namespace
  private async disk(): Promise<SampledValue<DiskCapacity | undefined>> {
    const value = await (this.bridged ? this.bridgedRootDisk() : this.diskAt('/'));
    return value === undefined ? { value, error: diskUnavailable } : { value };
  }

  // detect WSL from bounded kernel metadata without requiring Windows or tmux access
  private async kernelRelease(): Promise<string> {
    const release = await this.readText(join(this.procRoot, 'sys', 'kernel', 'osrelease'), maxProcBytes).catch(() => undefined);
    // use the older proc version field only when osrelease is unavailable
    if (release !== undefined) return release;
    return await this.readText(join(this.procRoot, 'version'), maxProcBytes).catch(() => '');
  }
}
