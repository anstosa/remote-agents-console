import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { containerized, readBoundedText } from './recovery-proc.js';
import type { ResourceSnapshot, ResourceUsage } from './resource-contracts.js';

type CpuCounters = { idle: number; total: number };
type SampledValue<T> = { value: T; error?: string };
type FilesystemStats = { blocks: bigint; bfree: bigint; bsize: bigint };

export type RecoveryResourceSamplerOptions = {
  procRoot?: string;
  bridged?: boolean;
  cacheMs?: number;
  now?: () => number;
  isContainer?: () => Promise<boolean>;
  readText?: (path: string, maxBytes: number) => Promise<string>;
  statFilesystem?: (path: string) => Promise<FilesystemStats>;
};

const maxProcBytes = 64 * 1024;
const defaultCacheMs = 1_000;
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
const diskCapacity = (stats: FilesystemStats): { usedBytes: number; totalBytes: number } | undefined => {
  const total = stats.blocks * stats.bsize;
  const free = stats.bfree * stats.bsize;
  // reject invalid counters before converting them to JSON numbers
  if (stats.blocks < 0n || stats.bfree < 0n || stats.bsize <= 0n || free > total || total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { usedBytes: Number(total - free), totalBytes: Number(total) };
};

// sample emergency metrics without entering the tmux control plane
export class RecoveryResourceSampler {
  private readonly procRoot: string;
  private readonly bridged: boolean;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly isContainer: () => Promise<boolean>;
  private readonly readText: (path: string, maxBytes: number) => Promise<string>;
  private readonly statFilesystem: (path: string) => Promise<FilesystemStats>;
  private previousCpu?: CpuCounters;
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
    this.statFilesystem = options.statFilesystem ?? (path => statfs(path, { bigint: true }));
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
    const [release, usage] = await Promise.all([this.kernelRelease(), this.usage()]);
    const errors = [...usage.errors];
    const wsl = /(?:microsoft|wsl)/iu.test(release);
    // keep the inaccessible Windows host distinct from its sampled WSL guest
    if (wsl) {
      errors.push(windowsUnavailable);
      return { sampledAt: new Date(sampledAt).toISOString(), host: null, wsl: usage.value, errors };
    }
    return { sampledAt: new Date(sampledAt).toISOString(), host: usage.value, ...(errors.length === 0 ? {} : { errors }) };
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

  // derive utilization only from successive aggregate counter snapshots
  private async cpu(): Promise<SampledValue<number | null>> {
    const text = await this.readText(join(this.procRoot, 'stat'), maxProcBytes).catch(() => undefined);
    const current = text === undefined ? undefined : parseCpuCounters(text);
    // disclose an unreadable or malformed counter record
    if (current === undefined) return { value: null, error: cpuUnavailable };
    const previous = this.previousCpu;
    this.previousCpu = current;
    // wait for a second sample before calculating a rate
    if (previous === undefined) return { value: null };
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    // treat counter reset or a zero interval as a new baseline
    if (total <= 0 || idle < 0) return { value: null };
    const percent = Math.max(0, Math.min(100, ((total - idle) / total) * 100));
    return { value: Math.round(percent * 10) / 10 };
  }

  // read memory from the same selected process namespace
  private async memory(): Promise<SampledValue<ResourceUsage['memory']>> {
    const text = await this.readText(join(this.procRoot, 'meminfo'), maxProcBytes).catch(() => undefined);
    const value = text === undefined ? null : parseMemory(text);
    return value === null ? { value, error: memoryUnavailable } : { value };
  }

  // inspect only a root path proven by the selected native or bridged namespace
  private async disk(): Promise<SampledValue<{ usedBytes: number; totalBytes: number } | undefined>> {
    const root = this.bridged ? join(this.procRoot, '1', 'root') : '/';
    const stats = await this.statFilesystem(root).catch(() => undefined);
    const value = stats === undefined ? undefined : diskCapacity(stats);
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
