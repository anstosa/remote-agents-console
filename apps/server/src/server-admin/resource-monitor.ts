import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { ValidatedConfig } from '../config/schema.js';
import { resolveHostNodeBin } from '../host-files/broker.js';
import { run, tmuxFormatLiteral, type RunResult } from '../tmux/command.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { isResourceSnapshot, type ResourceSnapshot, type ResourceUsage } from './resource-contracts.js';

type RunCommand = (command: string, args: string[], input?: string, timeoutMs?: number) => Promise<RunResult>;
type CollectionMode = 'disks' | 'metrics';
type SpawnProcess = (command: string, args: string[]) => ChildProcess;
type SnapshotPublisher = (snapshot: ResourceSnapshot) => void | Promise<void>;

export type ResourceMonitorOptions = {
  checkoutRoot?: string;
  hostRepository?: string;
  hostNode?: string;
  tmuxBinary?: string;
  tmuxSocket?: string | null;
  runCommand?: RunCommand;
  pollMs?: number;
  timeoutMs?: number;
  container?: () => Promise<boolean>;
  spawnProcess?: SpawnProcess;
  stallMs?: number;
};

const maxLiveRecordBytes = 512_000;
const liveLeaseIntervalMs = 1_000;

// allow only browser-visible fields from one operating system
const publicUsage = ({ cpuPercent, memory, disks, diskError }: ResourceUsage): ResourceUsage => ({
  cpuPercent,
  memory: memory === null ? null : { usedBytes: memory.usedBytes, totalBytes: memory.totalBytes },
  // omit collector metadata at every volume boundary
  disks: disks.map(({ mount, usedBytes, totalBytes }) => ({ mount, usedBytes, totalBytes })),
  ...(diskError === undefined ? {} : { diskError })
});

// strip extra fields from both one-shot and live collector replies
const publicSnapshot = ({ sampledAt, host, wsl, errors }: ResourceSnapshot): ResourceSnapshot => ({
  sampledAt,
  host: host === null ? null : publicUsage(host),
  ...(wsl === undefined ? {} : { wsl: publicUsage(wsl) }),
  ...(errors === undefined ? {} : { errors })
});

// validate the complete collector response before publishing it
export const parseResourceSnapshot = (text: string): ResourceSnapshot | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isResourceSnapshot(value) ? publicSnapshot(value) : undefined;
  } catch {
    return undefined;
  }
};

// validate one bounded live-file record
const parseLiveRecord = (text: string): { sequence: number; snapshot: ResourceSnapshot } | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    // require one increasing integer and validated snapshot
    if (value === null || typeof value !== 'object' || !Number.isSafeInteger((value as { sequence?: unknown }).sequence) || !isResourceSnapshot((value as { snapshot?: unknown }).snapshot)) return undefined;
    const { sequence, snapshot } = value as { sequence: number; snapshot: ResourceSnapshot };
    return { sequence, snapshot: publicSnapshot(snapshot) };
  } catch {
    return undefined;
  }
};

// one truthful unavailable response
const unavailableSnapshot = (): ResourceSnapshot => ({ sampledAt: new Date().toISOString(), host: null, errors: ['Host resource monitoring is unavailable.'] });

// collect resources only when the authenticated interface requests them
export class ResourceMonitorService {
  private readonly checkoutRoot: string;
  private readonly hostRepository: string | undefined;
  private readonly hostNode: string;
  private resolvedHostNode?: Promise<string>;
  private readonly tmuxBinary: string;
  private readonly tmuxSocket: string | undefined;
  private readonly runCommand: RunCommand;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly container: () => Promise<boolean>;
  private readonly spawnProcess: SpawnProcess;
  private readonly stallMs: number;
  private readonly inFlight = new Map<CollectionMode, Promise<ResourceSnapshot>>();

  // resolve native versus Docker-host execution once
  constructor(config: Pick<ValidatedConfig, 'projects'>, options: ResourceMonitorOptions = {}) {
    this.checkoutRoot = options.checkoutRoot ?? serverCheckout();
    this.hostRepository = options.hostRepository ?? serverCheckoutOnHost(config.projects, process.env.RAC_HOST_REPOSITORY?.trim() || process.env.RAC_HOST_WORKSPACE, this.checkoutRoot);
    this.hostNode = (options.hostNode ?? process.env.RAC_HOST_NODE_BIN ?? '').trim();
    this.tmuxBinary = options.tmuxBinary ?? process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
    this.tmuxSocket = options.tmuxSocket === null ? undefined : options.tmuxSocket ?? (process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default'));
    this.runCommand = options.runCommand ?? run;
    this.pollMs = options.pollMs ?? 50;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.container = options.container ?? (async () => {
      // Docker publishes this marker in its process namespace
      if (await access('/.dockerenv').then(() => true).catch(() => false)) return true;
      const cgroup = await readFile('/proc/1/cgroup', 'utf8').catch(() => '');
      return /(?:docker|containerd|kubepods|libpod)/u.test(cgroup);
    });
    this.spawnProcess = options.spawnProcess ?? ((command, args) => spawn(command, args, { stdio: 'ignore' }));
    this.stallMs = options.stallMs ?? 5_000;
  }

  // coalesce only concurrent disk requests
  disks(): Promise<ResourceSnapshot> {
    return this.coalesced('disks');
  }

  // coalesce CPU and memory requests independently from disk samples
  metrics(): Promise<ResourceSnapshot> {
    return this.coalesced('metrics');
  }

  // stream only while the owning HTTP request remains open
  async stream(signal: AbortSignal, publish: SnapshotPublisher): Promise<void> {
    // never start work for an already-closed flyout
    if (signal.aborted) return;
    try {
      // refuse container-local collection when no host bridge exists
      if (this.tmuxSocket === undefined && await this.container()) { await publish(unavailableSnapshot()); return; }
      // select one exact native or bridged collector
      if (this.tmuxSocket === undefined) await this.streamNative(signal, publish);
      else await this.streamBridged(signal, publish);
    } catch {
      // report startup failure only while the client can still consume it
      if (!signal.aborted) await publish(unavailableSnapshot());
    }
  }

  // share only an active inspection of the same request type
  private coalesced(mode: CollectionMode): Promise<ResourceSnapshot> {
    const active = this.inFlight.get(mode);
    // keep disk and metrics work independent
    if (active !== undefined) return active;
    const current = this.collect(mode).finally(() => {
      // release only the promise this completion owns
      if (this.inFlight.get(mode) === current) this.inFlight.delete(mode);
    });
    this.inFlight.set(mode, current);
    return current;
  }

  // select native or host-bridge collection
  private async collect(mode: CollectionMode): Promise<ResourceSnapshot> {
    const snapshot = await (this.tmuxSocket === undefined
      ? this.container().then(container => container ? undefined : this.collectNative(mode))
      : this.collectBridged(mode)).catch(() => undefined);
    // expose failure without substituting container resource values
    return snapshot ?? unavailableSnapshot();
  }

  // run the collector inside a native server process boundary
  private async collectNative(mode: CollectionMode): Promise<ResourceSnapshot | undefined> {
    const script = join(this.checkoutRoot, 'scripts', 'resource-monitor.mjs');
    const result = await this.runCommand(process.execPath, [script, `--${mode}`], undefined, this.timeoutMs).catch(() => undefined);
    // reject command failures and truncated output
    if (result === undefined || result.code !== 0 || result.timedOut === true || result.stdoutTruncated === true) return undefined;
    return parseResourceSnapshot(result.stdout);
  }

  // share a successful host lookup across sample modes without caching failures
  private hostNodeExecutable(hostTmuxSocket: string): Promise<string> {
    this.resolvedHostNode ??= resolveHostNodeBin({
      hostNodeBin: this.hostNode, hostPath: process.env.RAC_HOST_PATH,
      tmuxBinary: this.tmuxBinary, hostTmuxSocket, commandRunner: this.runCommand
    }).catch(error => {
      this.resolvedHostNode = undefined;
      throw error;
    });
    return this.resolvedHostNode;
  }

  // run the collector in the real host namespace behind Docker's tmux bridge
  private async collectBridged(mode: CollectionMode): Promise<ResourceSnapshot | undefined> {
    // never report container values as host values when bridge configuration is incomplete
    if (this.hostRepository === undefined || this.tmuxSocket === undefined) return undefined;
    const hostNode = await this.hostNodeExecutable(this.tmuxSocket);
    const parent = join(this.checkoutRoot, '.data', 'resource-monitor');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'sample-'));
    const name = directory.slice(parent.length + 1);
    const output = join(directory, 'snapshot.json');
    const hostOutput = join(this.hostRepository, '.data', 'resource-monitor', name, 'snapshot.json');
    const session = `rac-resources-${mode}-${randomBytes(12).toString('hex')}`;
    try {
      const script = join(this.hostRepository, 'scripts', 'resource-monitor.mjs');
      const started = await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(this.hostRepository), hostNode, script, `--${mode}`, '--output', hostOutput], undefined, 5_000);
      // refuse a collection that never started on the host
      if (started.code !== 0) return undefined;
      const deadline = Date.now() + this.timeoutMs;
      // poll only while this bounded host process can still publish its atomic result
      while (Date.now() < deadline) {
        const text = await readFile(output, 'utf8').catch(() => undefined);
        // validate the first atomic result
        if (text !== undefined) return parseResourceSnapshot(text);
        const active = await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'has-session', '-t', `=${session}`], undefined, 1_000).catch(() => undefined);
        // read once more after process exit to close the atomic-publish race
        if (active === undefined || active.code !== 0) {
          const finalText = await readFile(output, 'utf8').catch(() => undefined);
          return finalText === undefined ? undefined : parseResourceSnapshot(finalText);
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.pollMs);
          timer.unref();
        });
      }
      return undefined;
    } finally {
      // stop only this exact collector before removing its bounded output
      await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'kill-session', '-t', `=${session}`], undefined, 1_000).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // start one native live collector and own its complete lifetime
  private async streamNative(signal: AbortSignal, publish: SnapshotPublisher): Promise<void> {
    const parent = join(this.checkoutRoot, '.data', 'resource-monitor');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'live-'));
    const output = join(directory, 'snapshot.json');
    const lease = join(directory, 'lease');
    const script = join(this.checkoutRoot, 'scripts', 'resource-monitor.mjs');
    await this.refreshLiveLease(lease);
    const child = this.spawnProcess(process.execPath, [script, '--stream', '--output', output, '--lease', lease]);
    let ended = false;
    const end = () => { ended = true; };
    child.once('error', end);
    child.once('exit', end);
    try {
      const published = await this.followLiveFile(output, lease, signal, publish, () => !ended);
      // disclose a collector that exited before its first record
      if (published === 0 && !signal.aborted) await publish(unavailableSnapshot());
    } finally {
      await this.stopChild(child);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // start one bridged live collector in the real host namespace
  private async streamBridged(signal: AbortSignal, publish: SnapshotPublisher): Promise<void> {
    // fail closed when the host identity is incomplete
    if (this.hostRepository === undefined || this.tmuxSocket === undefined) { await publish(unavailableSnapshot()); return; }
    const hostNode = await this.hostNodeExecutable(this.tmuxSocket);
    // do not launch after a client disconnects during host discovery
    if (signal.aborted) return;
    const parent = join(this.checkoutRoot, '.data', 'resource-monitor');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'live-'));
    const name = directory.slice(parent.length + 1);
    const output = join(directory, 'snapshot.json');
    const lease = join(directory, 'lease');
    const hostOutput = join(this.hostRepository, '.data', 'resource-monitor', name, 'snapshot.json');
    const hostLease = join(this.hostRepository, '.data', 'resource-monitor', name, 'lease');
    const session = `rac-resources-live-${randomBytes(12).toString('hex')}`;
    try {
      await this.refreshLiveLease(lease);
      const script = join(this.hostRepository, 'scripts', 'resource-monitor.mjs');
      const started = await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(this.hostRepository), hostNode, script, '--stream', '--output', hostOutput, '--lease', hostLease], undefined, 5_000);
      // refuse a collector that never started
      if (started.code !== 0) { await publish(unavailableSnapshot()); return; }
      let nextLivenessAt = 0;
      let active = true;
      const published = await this.followLiveFile(output, lease, signal, publish, async () => {
        // avoid a tmux command on every file poll
        if (Date.now() < nextLivenessAt) return active;
        nextLivenessAt = Date.now() + 1_000;
        const current = await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket!, 'has-session', '-t', `=${session}`], undefined, 1_000).catch(() => undefined);
        active = current?.code === 0;
        return active;
      });
      // disclose a host session that ended before its first record
      if (published === 0 && !signal.aborted) await publish(unavailableSnapshot());
    } finally {
      // stop only the client-owned host collector
      await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'kill-session', '-t', `=${session}`], undefined, 1_000).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // publish each new atomic collector record once
  private async followLiveFile(output: string, lease: string, signal: AbortSignal, publish: SnapshotPublisher, active: () => boolean | Promise<boolean>): Promise<number> {
    let sequence = 0;
    let advancedAt = Date.now();
    let nextLeaseAt = 0;
    // poll only while the HTTP client and collector both remain live
    while (!signal.aborted && await active()) {
      // refresh only this live request's collector lease
      if (Date.now() >= nextLeaseAt) {
        await this.refreshLiveLease(lease);
        nextLeaseAt = Date.now() + liveLeaseIntervalMs;
      }
      const record = await this.readLiveRecord(output);
      // publish only a newer complete atomic record
      if (record !== undefined && record.sequence > sequence) {
        sequence = record.sequence;
        advancedAt = Date.now();
        await publish(record.snapshot);
      }
      const deadline = sequence === 0 ? this.timeoutMs : this.stallMs;
      // end an alive collector that stopped publishing fresh snapshots
      if (Date.now() - advancedAt >= deadline) throw new Error('resource_stream_stalled');
      await this.wait(this.pollMs, signal);
    }
    return sequence;
  }

  // refresh one bounded collector lease without a background timer
  private async refreshLiveLease(lease: string): Promise<void> {
    await writeFile(lease, `${Date.now()}\n`, { mode: 0o600 });
  }

  // read at most one bounded atomic live record
  private async readLiveRecord(output: string): Promise<{ sequence: number; snapshot: ResourceSnapshot } | undefined> {
    let file;
    try { file = await open(output, 'r'); }
    catch (error) {
      // wait only for a file that has not been published yet
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const status = await file.stat();
      // reject oversized records before allocating their read buffer
      if (status.size > maxLiveRecordBytes) throw new Error('resource_stream_record_too_large');
      const buffer = Buffer.allocUnsafe(status.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      // reject growth after the stable atomic file was opened
      if (bytesRead > status.size) throw new Error('resource_stream_record_changed');
      return parseLiveRecord(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await file.close();
    }
  }

  // stop one exact native child before removing its output
  private async stopChild(child: ChildProcess): Promise<void> {
    // skip children that have already ended
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit').catch(() => undefined), new Promise(resolve => setTimeout(resolve, 500))]);
    // force only a collector that ignored its graceful stop
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit').catch(() => undefined), new Promise(resolve => setTimeout(resolve, 500))]);
    }
  }

  // make polling cancellation immediate and timer-free after disconnect
  private async wait(duration: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      // skip timers after cancellation
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(done, duration);
      timer.unref();
      // release the one timer and abort listener
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
