import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import type {
  HostFilesBackend,
  HostFilesCommand,
  HostFilesCommandResult,
  HostFilesReadCommand,
  HostFilesWriteCommand,
  HostFilesWriteResult
} from './contracts.js';
import { HostFilesError } from './contracts.js';
import { HostBrokerBackend } from './backend.js';
import { HOST_FILES_PROTOCOL, HostFilesTransportError } from './protocol.js';
import { run, tmuxFormatLiteral, type tmuxBinary } from '../tmux/command.js';

type CommandResult = Awaited<ReturnType<typeof run>>;
type CommandRunner = (command: string, args: string[], input?: string, timeoutMs?: number) => Promise<CommandResult>;

export type HostBrokerControllerOptions = {
  tmuxBinary: ReturnType<typeof tmuxBinary>;
  hostTmuxSocket: string;
  hostProcRoot: string;
  serverCheckout: string;
  hostCheckout: string;
  hostNodeBin: string;
  hostPath?: string;
  hostUid: number;
  operationJournalPath: string;
  fileFavoritesPath: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  commandRunner?: CommandRunner;
  compiledModuleDirectory?: string;
};

type FileIdentity = { dev: string; ino: string; uid: number; mode: number; kind: 'file' | 'directory' | 'socket' };
type BrokerOwnerBase = {
  version: 1;
  state: 'launching' | 'ready' | 'stopping';
  protocol: number;
  programDigest: string;
  launcherDigest: string;
  ownerKey: string;
  expectedSessionName: string;
  launchNonce: string;
  serverInstanceId: string;
  generation: string;
  capabilityHash: string;
  descriptorPath: string;
  descriptorIdentity: FileIdentity;
  createdAt: string;
};
type BrokerLaunchingOwner = BrokerOwnerBase & { state: 'launching' };
type BrokerReadyOwner = BrokerOwnerBase & {
  state: 'ready' | 'stopping';
  sessionId: string;
  sessionName: string;
  paneId: string;
  pid: number;
  pidStartTime: string;
  uid: number;
  executable: string;
  cmdlineDigest: string;
  hostRuntimePath: string;
  runtimePath: string;
  runtimeIdentity: FileIdentity;
  hostSocketPath: string;
  socketPath: string;
  socketIdentity: FileIdentity;
};
type BrokerOwnerRecord = BrokerLaunchingOwner | BrokerReadyOwner;
type BrokerLockRecord = { version: 1; serverInstanceId: string; pid: number; pidStartTime: string; createdAt: string };

type Snapshot = { digest: string; entryHostPath: string };

// validate persisted controller lock fields
function isBrokerLockRecord(value: unknown): value is BrokerLockRecord {
  // require one bounded exact process identity
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.serverInstanceId === 'string'
    && record.serverInstanceId.length >= 1
    && Number.isSafeInteger(record.pid)
    && Number(record.pid) > 1
    && typeof record.pidStartTime === 'string'
    && /^\d+$/u.test(record.pidStartTime)
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt));
}

// validate the bounded owner fields used during stale reconciliation
function isBrokerOwnerRecord(value: unknown): value is BrokerOwnerRecord {
  // require common immutable ownership fields
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  // require exact owner schema fields
  if (record.version !== 1
    || (record.state !== 'launching' && record.state !== 'ready' && record.state !== 'stopping')
    || record.protocol !== HOST_FILES_PROTOCOL
    || typeof record.programDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.programDigest)
    || typeof record.expectedSessionName !== 'string'
    || !/^rac-files-[a-f0-9]{24}$/u.test(record.expectedSessionName)
    || typeof record.launchNonce !== 'string'
    || !uuid.test(record.launchNonce)
    || typeof record.serverInstanceId !== 'string'
    || !uuid.test(record.serverInstanceId)
    || typeof record.generation !== 'string'
    || !uuid.test(record.generation)
    || typeof record.descriptorPath !== 'string'
    || !isAbsolute(record.descriptorPath)
    || value === null) return false;
  const descriptorIdentity = record.descriptorIdentity;
  // require the descriptor identity before cleanup authority
  if (descriptorIdentity === null || typeof descriptorIdentity !== 'object' || Array.isArray(descriptorIdentity)) return false;
  const identity = descriptorIdentity as Record<string, unknown>;
  // require exact private descriptor metadata
  if (typeof identity.dev !== 'string' || typeof identity.ino !== 'string' || typeof identity.uid !== 'number' || identity.mode !== 0o600 || identity.kind !== 'file') return false;
  // launching records end at the common identity
  if (record.state === 'launching') return true;
  return typeof record.sessionId === 'string'
    && typeof record.sessionName === 'string'
    && typeof record.paneId === 'string'
    && Number.isSafeInteger(record.pid)
    && typeof record.pidStartTime === 'string';
}

// quote one validated path as a POSIX shell literal
export function posixShellLiteral(value: string): string {
  // reject values that cannot be represented as one shell word
  if (value.length === 0 || /[\0\r\n]/u.test(value)) throw new HostFilesTransportError('bridge_unavailable', 'invalid broker launch path');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// require one absolute configured path
function absolutePath(value: string, name: string): string {
  // fail before filesystem mutation on missing prerequisites
  if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new HostFilesTransportError('bridge_unavailable', `invalid ${name}`);
  return value;
}

// resolve the configured executable or inspect the host tmux environment
export async function resolveHostNodeBin(options: Pick<HostBrokerControllerOptions, 'hostNodeBin' | 'hostPath' | 'tmuxBinary' | 'hostTmuxSocket' | 'startupTimeoutMs' | 'commandRunner'>): Promise<string> {
  // explicit absolute overrides never consult tmux
  if (options.hostNodeBin.trim() !== '') return absolutePath(options.hostNodeBin, 'host Node path');
  absolutePath(options.tmuxBinary, 'tmux binary');
  absolutePath(options.hostTmuxSocket, 'host tmux socket');
  const path = options.hostPath?.trim();
  const pathExport = path ? `export PATH=${posixShellLiteral(path)}\n` : '';
  const command = options.commandRunner ?? run;
  const resolved = await command(options.tmuxBinary, [
    '-S', options.hostTmuxSocket, 'run-shell',
    tmuxFormatLiteral(`${pathExport}exec node -p 'process.execPath'`)
  ], undefined, options.startupTimeoutMs ?? 5_000);
  // never substitute the server executable when host node cannot be found
  if (resolved.code !== 0) throw new HostFilesTransportError('bridge_unavailable', 'node is unavailable on the host PATH');
  return absolutePath(resolved.stdout.trim(), 'resolved host Node path');
}

// render the fixed two-exec launcher without operation data
export function renderHostBrokerLauncher(hostNodeBin: string, brokerProgram: string, descriptorPath: string): string {
  absolutePath(hostNodeBin, 'host Node path');
  absolutePath(brokerProgram, 'broker program path');
  absolutePath(descriptorPath, 'broker descriptor path');
  return `#!/bin/sh\nexec ${posixShellLiteral(hostNodeBin)} ${posixShellLiteral(brokerProgram)} ${posixShellLiteral(descriptorPath)}\n`;
}

// compute stable content digests
function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// identify one exact filesystem object
async function fileIdentity(path: string): Promise<FileIdentity> {
  const metadata = await lstat(path, { bigint: true });
  const kind = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : metadata.isSocket() ? 'socket' : undefined;
  // reject unexpected object types
  if (kind === undefined) throw new HostFilesTransportError('bridge_unavailable', 'unexpected broker filesystem object');
  return { dev: String(metadata.dev), ino: String(metadata.ino), uid: Number(metadata.uid), mode: Number(metadata.mode & 0o777n), kind };
}

// compare exact recorded filesystem identities
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode && left.kind === right.kind;
}

// write one private JSON state transition atomically
async function writePrivateJson(path: string, value: unknown): Promise<FileIdentity> {
  const temporary = `${path}.${randomUUID()}.next`;
  // create the next version privately
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  // commit the complete next version
  try {
    await rename(temporary, path);
  } finally {
    // remove only this operation's temporary path
    await rm(temporary, { force: true }).catch(() => {});
  }
  await chmod(path, 0o600);
  return await fileIdentity(path);
}

// remove one file only while its recorded identity still matches
async function removeExactFile(path: string, expected: FileIdentity): Promise<boolean> {
  const current = await fileIdentity(path).catch(() => undefined);
  // preserve substituted or already-absent objects
  if (current === undefined || !sameIdentity(current, expected)) return false;
  await rm(path);
  return true;
}

// read Linux proc stat start time despite spaces in comm
async function procStartTime(procRoot: string, pid: number): Promise<string> {
  const value = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  // reject malformed or recycled proc identities
  if (startTime === undefined || !/^\d+$/u.test(startTime)) throw new HostFilesTransportError('bridge_unavailable', 'invalid broker process identity');
  return startTime;
}

// read the effective uid from proc status
async function procUid(procRoot: string, pid: number): Promise<number> {
  const status = await readFile(join(procRoot, String(pid), 'status'), 'utf8');
  const match = /^Uid:\s+(\d+)\s+/mu.exec(status);
  // reject unreadable identity data
  if (match === null) throw new HostFilesTransportError('bridge_unavailable', 'invalid broker process uid');
  return Number(match[1]);
}

// map one host absolute path through a verified proc mount namespace
function procRootPath(procRoot: string, pid: number, hostPath: string): string {
  absolutePath(hostPath, 'host path');
  return join(procRoot, String(pid), 'root', hostPath.slice(1));
}

// parse one ready pane identity returned by fixed argv tmux
function parsePaneIdentity(output: string): { sessionId: string; sessionName: string; paneId: string; pid: number; nonce: string; role: string; protocol: string; digest: string } {
  const [sessionId, sessionName, paneId, rawPid, nonce, role, protocol, programDigest] = output.trim().split('\t');
  // require exact tmux and marker fields
  if (!/^\$\d+$/u.test(sessionId ?? '')
    || !/^[A-Za-z0-9_.-]+$/u.test(sessionName ?? '')
    || !/^%\d+$/u.test(paneId ?? '')
    || !/^\d+$/u.test(rawPid ?? '')) {
    throw new HostFilesTransportError('bridge_unavailable', 'invalid broker pane identity');
  }
  return { sessionId: sessionId!, sessionName: sessionName!, paneId: paneId!, pid: Number(rawPid), nonce: nonce ?? '', role: role ?? '', protocol: protocol ?? '', digest: programDigest ?? '' };
}

// discover only relative module imports for a dependency-free snapshot
function relativeModuleImports(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:from\s*|import\s*)["']([^"']+)["']/gu;
  // inspect every static import
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]!;
    // allow Node builtins without copying them
    if (specifier.startsWith('node:')) continue;
    // reject package/runtime dependencies on the host
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new HostFilesTransportError('bridge_unavailable', `broker snapshot has external import: ${specifier}`);
    imports.add(specifier);
  }
  return [...imports];
}

// collect the compiled builtin-only dependency closure
async function compiledClosure(root: string, entry = 'broker-main.js'): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const pending = [entry];
  // walk each relative compiled module once
  while (pending.length > 0) {
    const name = pending.pop()!;
    // skip modules already captured
    if (files.has(name)) continue;
    const path = resolve(root, name);
    const relativePath = relative(root, path);
    // keep the snapshot inside host-files
    if (relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new HostFilesTransportError('bridge_unavailable', 'broker snapshot escapes module root');
    const contents = await readFile(path);
    files.set(relativePath, contents);
    // resolve only JavaScript static imports
    for (const specifier of relativeModuleImports(contents.toString('utf8'))) {
      const imported = relative(root, resolve(dirname(path), specifier));
      // capture compiled JavaScript only
      if (!imported.endsWith('.js')) throw new HostFilesTransportError('bridge_unavailable', 'broker snapshot contains a non-JavaScript import');
      pending.push(imported);
    }
  }
  return files;
}

// snapshot compiled modules into one content-addressed private directory
async function installSnapshot(options: HostBrokerControllerOptions, dataDirectory: string, hostDataDirectory: string): Promise<Snapshot> {
  const sourceRoot = options.compiledModuleDirectory ?? dirname(fileURLToPath(import.meta.url));
  const files = await compiledClosure(sourceRoot);
  // make the isolated JavaScript snapshot explicitly ESM on every supported Node
  files.set('package.json', Buffer.from('{"private":true,"type":"module"}\n'));
  const programHash = createHash('sha256');
  // hash names and contents in deterministic order
  for (const [name, contents] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    programHash.update(name).update('\0').update(contents).update('\0');
  }
  const programDigest = programHash.digest('hex');
  const destination = join(dataDirectory, 'snapshots', programDigest);
  // install one immutable content-addressed snapshot
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  // install every compiled snapshot module
  for (const [name, contents] of files) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const existing = await readFile(target).catch(() => undefined);
    // reject unexpected bytes at an existing digest path
    if (existing !== undefined && !existing.equals(contents)) throw new HostFilesTransportError('bridge_unavailable', 'broker snapshot digest collision');
    // create absent snapshot modules privately
    if (existing === undefined) await writeFile(target, contents, { mode: 0o600, flag: 'wx' });
    await chmod(target, 0o600);
  }
  return {
    digest: programDigest,
    entryHostPath: join(hostDataDirectory, 'snapshots', programDigest, 'broker-main.js')
  };
}

// reserve one exclusive private controller lock
async function acquireLock(path: string, record: BrokerLockRecord): Promise<FileIdentity> {
  // create without replacing another controller
  try {
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await fileIdentity(path);
  } catch (error) {
    // expose duplicate or ambiguous startup as retryable busy
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HostFilesError('broker_busy', 'host files broker startup is busy', 503, true);
    throw error;
  }
}

// wait until one exact condition becomes true
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // retry bounded process/socket startup
  while (Date.now() < deadline) {
    // finish immediately on success
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

// own one lazy fail-stop host broker generation
export class LazyHostBrokerBackend implements HostFilesBackend {
  private readonly serverInstanceId = randomUUID();
  private generationId = randomUUID();
  private capability = randomBytes(32).toString('base64url');
  private readonly command: CommandRunner;
  private dataDirectory = '';
  private hostDataDirectory = '';
  private ownerPath = '';
  private lockPath = '';
  private backend?: HostBrokerBackend;
  private starting?: Promise<HostBrokerBackend>;
  private stopping?: Promise<void>;
  private lockIdentity?: FileIdentity;
  private owner?: BrokerOwnerRecord;
  private closed = false;

  // retain configuration without touching optional host prerequisites
  constructor(private readonly options: HostBrokerControllerOptions) {
    this.command = options.commandRunner ?? run;
  }

  // expose the generation reserved before first token issuance
  generation(): string {
    return this.generationId;
  }

  // establish the generation once and share concurrent startup
  private async ensureBackend(): Promise<HostBrokerBackend> {
    // reject intake after graceful close
    if (this.closed) throw new HostFilesTransportError('bridge_unavailable', 'host files backend is closed');
    // reuse the verified controller
    if (this.backend !== undefined) return this.backend;
    // serialize concurrent first requests
    this.starting ??= this.start();
    try {
      this.backend = await this.starting;
      return this.backend;
    } catch (error) {
      // remove only state created by this failed attempt
      await this.cleanupFailedStart();
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  // clean an incomplete launch without touching mismatched sessions
  private async cleanupFailedStart(): Promise<void> {
    const owner = this.owner;
    // inspect only this deterministic session when launch state exists
    if (owner !== undefined) {
      let stopped = false;
      // preserve recovery authority on ambiguous process or session state
      try {
        stopped = await this.stopOwnedProcess(owner);
      } catch { /* ambiguous identity grants no cleanup authority */ }
      // retain every recovery artifact until exact process exit is proven
      if (!stopped) return;
      await removeExactFile(owner.descriptorPath, owner.descriptorIdentity).catch(() => false);
      const persisted = await readFile(this.ownerPath, 'utf8').then(value => JSON.parse(value) as BrokerOwnerRecord).catch(() => undefined);
      // remove only this attempt's owner record
      if (persisted?.serverInstanceId === this.serverInstanceId && persisted.generation === this.generationId) await rm(this.ownerPath).catch(() => {});
    }
    // release only the exact lock acquired by this attempt
    if (this.lockIdentity !== undefined) await removeExactFile(this.lockPath, this.lockIdentity).catch(() => false);
    this.owner = undefined;
    this.lockIdentity = undefined;
  }

  // launch and verify the exact private broker
  private async start(): Promise<HostBrokerBackend> {
    // validate optional bridge configuration only on first Files use
    absolutePath(this.options.tmuxBinary, 'tmux binary');
    absolutePath(this.options.hostTmuxSocket, 'host tmux socket');
    absolutePath(this.options.hostProcRoot, 'host proc root');
    // retain strict validation for a deliberately configured executable
    if (this.options.hostNodeBin.trim() !== '') absolutePath(this.options.hostNodeBin, 'host Node path');
    absolutePath(this.options.operationJournalPath, 'operation journal path');
    absolutePath(this.options.fileFavoritesPath, 'favorites file path');
    this.dataDirectory = join(absolutePath(this.options.serverCheckout, 'server checkout'), '.data', 'host-files');
    this.hostDataDirectory = join(absolutePath(this.options.hostCheckout, 'host checkout'), '.data', 'host-files');
    this.ownerPath = join(this.dataDirectory, 'owner.json');
    this.lockPath = join(this.dataDirectory, 'owner.lock');
    // reject malformed uid configuration before shared filesystem mutation
    if (!Number.isSafeInteger(this.options.hostUid) || this.options.hostUid < 0) throw new HostFilesTransportError('bridge_unavailable', 'invalid host uid');
    const currentUid = process.getuid?.();
    // require numeric uid parity before writing shared launch state
    if (currentUid === undefined || currentUid !== this.options.hostUid) throw new HostFilesTransportError('bridge_unavailable', 'host uid does not match server uid');
    const hostNodeBin = await resolveHostNodeBin(this.options);
    // the host lookup already returns its canonical executable path
    const expectedNodeBin = this.options.hostNodeBin.trim() === '' ? hostNodeBin : await realpath(hostNodeBin).catch(() => hostNodeBin);
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.dataDirectory, 0o700);
    await mkdir(join(this.dataDirectory, 'run'), { recursive: true, mode: 0o700 });
    await chmod(join(this.dataDirectory, 'run'), 0o700);
    await mkdir(join(this.dataDirectory, 'snapshots'), { recursive: true, mode: 0o700 });
    await chmod(join(this.dataDirectory, 'snapshots'), 0o700);
    const dataIdentity = await fileIdentity(this.dataDirectory);
    // require private owned shared storage
    if (dataIdentity.uid !== currentUid || dataIdentity.mode !== 0o700) throw new HostFilesTransportError('bridge_unavailable', 'host files data directory is not private');
    await this.reconcileStaleOwner();
    const pidStartTime = await procStartTime('/proc', process.pid);
    this.lockIdentity = await acquireLock(this.lockPath, { version: 1, serverInstanceId: this.serverInstanceId, pid: process.pid, pidStartTime, createdAt: new Date().toISOString() });
    // fail-stop simplification: never adopt a prior owner/session
    const priorOwner = await readFile(this.ownerPath, 'utf8').catch(() => undefined);
    // refuse an unreconciled prior generation
    if (priorOwner !== undefined) throw new HostFilesError('broker_busy', 'prior host files broker requires reconciliation', 503, true);
    const snapshot = await installSnapshot(this.options, this.dataDirectory, this.hostDataDirectory);
    const ownerKey = digest(`${this.options.hostTmuxSocket}\0${this.options.hostCheckout}`).slice(0, 24);
    const sessionName = `rac-files-${ownerKey}`;
    const launchNonce = randomUUID();
    const runtimeHostPath = join(this.hostDataDirectory, 'run', digest(this.generationId).slice(0, 24));
    const socketHostPath = join(runtimeHostPath, 'broker.sock');
    // reject Unix socket names that cannot fit the host sockaddr
    if (Buffer.byteLength(socketHostPath) > 107) throw new HostFilesTransportError('bridge_unavailable', 'host files socket path is too long');
    const descriptorContainerPath = join(this.dataDirectory, `descriptor-${this.generationId}.json`);
    const descriptorHostPath = join(this.hostDataDirectory, `descriptor-${this.generationId}.json`);
    const launcher = renderHostBrokerLauncher(hostNodeBin, snapshot.entryHostPath, descriptorHostPath);
    const launcherDigest = digest(launcher);
    const launcherContainerPath = join(this.dataDirectory, `launcher-${launcherDigest}.sh`);
    const launcherHostPath = join(this.hostDataDirectory, `launcher-${launcherDigest}.sh`);
    // commit fixed launcher bytes before recording launch state
    const existingLauncher = await readFile(launcherContainerPath, 'utf8').catch(() => undefined);
    // reject mismatched content-addressed bytes
    if (existingLauncher !== undefined && existingLauncher !== launcher) throw new HostFilesTransportError('bridge_unavailable', 'broker launcher digest collision');
    // create only an absent content-addressed launcher
    if (existingLauncher === undefined) await writeFile(launcherContainerPath, launcher, { mode: 0o700, flag: 'wx' });
    await chmod(launcherContainerPath, 0o700);
    const launcherIdentity = await fileIdentity(launcherContainerPath);
    // reject substituted or widened content-addressed launchers
    if (launcherIdentity.uid !== currentUid || launcherIdentity.mode !== 0o700 || launcherIdentity.kind !== 'file') throw new HostFilesTransportError('bridge_unavailable', 'broker launcher is not private');
    const descriptor = {
      version: 1,
      protocol: HOST_FILES_PROTOCOL,
      generation: this.generationId,
      capability: this.capability,
      serverInstanceId: this.serverInstanceId,
      socketPath: socketHostPath,
      runtimeDirectory: runtimeHostPath,
      operationJournalPath: this.options.operationJournalPath,
      fileFavoritesPath: this.options.fileFavoritesPath,
      uid: currentUid,
      programDigest: snapshot.digest
    };
    // create the capability descriptor privately
    await writeFile(descriptorContainerPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(descriptorContainerPath, 0o600);
    const descriptorIdentity = await fileIdentity(descriptorContainerPath);
    // require descriptor ownership before launch
    if (descriptorIdentity.uid !== currentUid || descriptorIdentity.mode !== 0o600) throw new HostFilesTransportError('bridge_unavailable', 'broker descriptor is not private');
    const launching: BrokerLaunchingOwner = {
      version: 1,
      state: 'launching',
      protocol: HOST_FILES_PROTOCOL,
      programDigest: snapshot.digest,
      launcherDigest,
      ownerKey,
      expectedSessionName: sessionName,
      launchNonce,
      serverInstanceId: this.serverInstanceId,
      generation: this.generationId,
      capabilityHash: digest(this.capability),
      descriptorPath: descriptorContainerPath,
      descriptorIdentity,
      createdAt: new Date().toISOString()
    };
    await writePrivateJson(this.ownerPath, launching);
    this.owner = launching;
    // refuse any deterministic-name collision without inspecting unrelated sessions
    const collision = await this.command(this.options.tmuxBinary, ['-S', this.options.hostTmuxSocket, 'has-session', '-t', `=${sessionName}`]);
    // keep colliding sessions untouched
    if (collision.code === 0) throw new HostFilesError('broker_busy', 'host files broker session is busy', 503, true);
    const startCommand = `exec ${posixShellLiteral(launcherHostPath)}`;
    const created = await this.command(this.options.tmuxBinary, [
      '-S', this.options.hostTmuxSocket,
      'new-session', '-d', '-s', tmuxFormatLiteral(sessionName), '-P', '-F', '#{pane_id}',
      '--', '/bin/sh', '-c', startCommand
    ], undefined, this.options.startupTimeoutMs ?? 5_000);
    // surface launch failure without fallback
    if (created.code !== 0 || !/^%\d+$/u.test(created.stdout.trim())) throw new HostFilesTransportError('bridge_unavailable', 'failed to launch host files broker');
    const paneId = created.stdout.trim();
    // mark exact ownership immediately after fixed launch
    const marks: Array<[string, string]> = [
      ['@rac_role', 'files-broker'],
      ['@rac_files_nonce', launchNonce],
      ['@rac_files_protocol', String(HOST_FILES_PROTOCOL)],
      ['@rac_files_digest', snapshot.digest]
    ];
    // commit every exact pane ownership marker
    for (const [name, value] of marks) {
      const marked = await this.command(this.options.tmuxBinary, ['-S', this.options.hostTmuxSocket, 'set-option', '-p', '-t', paneId, name, value]);
      // stop if exact ownership cannot be established
      if (marked.code !== 0) throw new HostFilesTransportError('bridge_unavailable', 'failed to mark host files broker');
    }
    const timeout = this.options.startupTimeoutMs ?? 5_000;
    let readyOwner: BrokerReadyOwner | undefined;
    const ready = await waitFor(async () => {
      try {
        const shown = await this.command(this.options.tmuxBinary, [
          '-S', this.options.hostTmuxSocket, 'display-message', '-p', '-t', paneId,
          '#{session_id}\t#{session_name}\t#{pane_id}\t#{pane_pid}\t#{@rac_files_nonce}\t#{@rac_role}\t#{@rac_files_protocol}\t#{@rac_files_digest}'
        ]);
        // wait while the broker exec chain settles
        if (shown.code !== 0) return false;
        const pane = parsePaneIdentity(shown.stdout);
        // require the complete marked pane identity
        if (pane.sessionName !== sessionName || pane.paneId !== paneId || pane.nonce !== launchNonce || pane.role !== 'files-broker' || pane.protocol !== String(HOST_FILES_PROTOCOL) || pane.digest !== snapshot.digest) return false;
        const [startTime, uid, executable, cmdline] = await Promise.all([
          procStartTime(this.options.hostProcRoot, pane.pid),
          procUid(this.options.hostProcRoot, pane.pid),
          readlink(join(this.options.hostProcRoot, String(pane.pid), 'exe')),
          readFile(join(this.options.hostProcRoot, String(pane.pid), 'cmdline'))
        ]);
        // require exact host uid and executable
        if (uid !== currentUid || executable !== expectedNodeBin) return false;
        const runtimePath = procRootPath(this.options.hostProcRoot, pane.pid, runtimeHostPath);
        const socketPath = procRootPath(this.options.hostProcRoot, pane.pid, socketHostPath);
        const [runtimeIdentity, socketIdentity] = await Promise.all([fileIdentity(runtimePath), fileIdentity(socketPath)]);
        // require one private owned runtime directory
        if (runtimeIdentity.uid !== currentUid || runtimeIdentity.mode !== 0o700 || runtimeIdentity.kind !== 'directory') return false;
        // require one private owned Unix socket
        if (socketIdentity.uid !== currentUid || socketIdentity.mode !== 0o600 || socketIdentity.kind !== 'socket') return false;
        readyOwner = {
          ...launching,
          state: 'ready',
          sessionId: pane.sessionId,
          sessionName: pane.sessionName,
          paneId: pane.paneId,
          pid: pane.pid,
          pidStartTime: startTime,
          uid,
          executable,
          cmdlineDigest: digest(cmdline),
          hostRuntimePath: runtimeHostPath,
          runtimePath,
          runtimeIdentity,
          hostSocketPath: socketHostPath,
          socketPath,
          socketIdentity
        };
        return true;
      } catch {
        return false;
      }
    }, timeout);
    // fail closed when exact identity never becomes ready
    if (!ready || readyOwner === undefined) throw new HostFilesTransportError('bridge_unavailable', 'host files broker did not become ready');
    await writePrivateJson(this.ownerPath, readyOwner);
    this.owner = readyOwner;
    return await HostBrokerBackend.connect(async () => await this.validateReadyOwner());
  }

  // replace only an expired exact fail-stop owner from a dead controller
  private async reconcileStaleOwner(): Promise<void> {
    const [lockBytes, lockIdentity, ownerBytes, ownerIdentity] = await Promise.all([
      readFile(this.lockPath, 'utf8').catch(() => undefined),
      fileIdentity(this.lockPath).catch(() => undefined),
      readFile(this.ownerPath, 'utf8').catch(() => undefined),
      fileIdentity(this.ownerPath).catch(() => undefined)
    ]);
    // preserve an owner without a matching lock as ambiguous
    if (lockBytes === undefined && ownerBytes !== undefined) throw new HostFilesError('broker_busy', 'host files broker ownership is ambiguous', 503, true);
    // continue when no prior controller state exists
    if (lockBytes === undefined) return;
    const lockValue = (() => { try { return JSON.parse(lockBytes) as unknown; } catch { return undefined; } })();
    // refuse malformed or substituted locks
    if (!isBrokerLockRecord(lockValue) || lockIdentity === undefined || lockIdentity.kind !== 'file' || lockIdentity.mode !== 0o600 || lockIdentity.uid !== this.options.hostUid) {
      throw new HostFilesError('broker_busy', 'host files broker ownership is ambiguous', 503, true);
    }
    const liveStart = await procStartTime('/proc', lockValue.pid).catch(() => undefined);
    // never disturb a live exact controller
    if (liveStart === lockValue.pidStartTime) throw new HostFilesError('broker_busy', 'host files broker already has a controller', 503, true);
    // retain a bounded lease while a starter may still be committing
    if (Date.now() - Date.parse(lockValue.createdAt) < 5_000) throw new HostFilesError('broker_busy', 'host files broker startup is busy', 503, true);
    // require a complete exact owner when one is present
    let priorOwner: BrokerOwnerRecord | undefined;
    // reconcile only a validated prior owner record
    if (ownerBytes !== undefined) {
      const ownerValue = (() => { try { return JSON.parse(ownerBytes) as unknown; } catch { return undefined; } })();
      // reject malformed or substituted owner state
      if (!isBrokerOwnerRecord(ownerValue) || ownerIdentity === undefined || ownerIdentity.kind !== 'file' || ownerIdentity.mode !== 0o600 || ownerIdentity.uid !== this.options.hostUid) {
        throw new HostFilesError('broker_busy', 'host files broker ownership is ambiguous', 503, true);
      }
      priorOwner = ownerValue;
      const expectedDescriptor = join(this.dataDirectory, `descriptor-${priorOwner.generation}.json`);
      // refuse state that could authorize cleanup outside private broker storage
      if (priorOwner.descriptorPath !== expectedDescriptor) throw new HostFilesError('broker_busy', 'host files broker descriptor identity is ambiguous', 503, true);
      const pane = await this.reconcilePaneIdentity(priorOwner);
      // preserve launching state when no process identity was ever recorded
      if (pane === undefined && priorOwner.state === 'launching') {
        throw new HostFilesError('broker_busy', 'launching host files broker process identity is unavailable', 503, true);
      }
      // kill only an exact marked crash survivor
      if (pane !== undefined) {
        // reject session marker drift
        if (pane.sessionName !== priorOwner.expectedSessionName
          || pane.nonce !== priorOwner.launchNonce
          || pane.role !== 'files-broker'
          || pane.protocol !== String(HOST_FILES_PROTOCOL)
          || pane.digest !== priorOwner.programDigest) {
          throw new HostFilesError('broker_busy', 'host files broker session collision', 503, true);
        }
        // ready state also binds the exact pane process identity
        if (priorOwner.state !== 'launching' && (pane.sessionId !== priorOwner.sessionId || pane.paneId !== priorOwner.paneId || pane.pid !== priorOwner.pid)) {
          throw new HostFilesError('broker_busy', 'host files broker process identity changed', 503, true);
        }
        const expectedStartTime = priorOwner.state === 'launching'
          ? await this.processStartTimeIfPresent(pane.pid)
          : priorOwner.pidStartTime;
        // require a live exact pane process before signaling its session
        if (expectedStartTime === undefined || !await this.exactProcessExists(pane.pid, expectedStartTime)) {
          throw new HostFilesError('broker_busy', 'host files broker process identity changed', 503, true);
        }
        await this.command(this.options.tmuxBinary, ['-S', this.options.hostTmuxSocket, 'kill-session', '-t', pane.sessionId]);
        const exited = await waitFor(async () => !await this.exactProcessExists(pane.pid, expectedStartTime), this.options.shutdownTimeoutMs ?? 3_000);
        // retain ownership while the exact process survives the stop request
        if (!exited) throw new HostFilesError('broker_busy', 'host files broker process is still running', 503, true);
      } else {
        const readyOwner = priorOwner as BrokerReadyOwner;
        const exited = await waitFor(async () => !await this.exactProcessExists(readyOwner.pid, readyOwner.pidStartTime), this.options.shutdownTimeoutMs ?? 3_000);
        // retain ownership while a sessionless recorded process remains live
        if (!exited) throw new HostFilesError('broker_busy', 'host files broker process is still running', 503, true);
      }
      // remove only the recorded private descriptor
      await removeExactFile(priorOwner.descriptorPath, priorOwner.descriptorIdentity);
      // remove only the owner bytes inspected above
      if (ownerIdentity !== undefined) await removeExactFile(this.ownerPath, ownerIdentity);
    }
    // release only the exact expired lock inspected above
    await removeExactFile(this.lockPath, lockIdentity);
  }

  // prove whether one exact stale session still exists
  private async exactSessionExists(sessionName: string): Promise<boolean> {
    const result = await this.command(this.options.tmuxBinary, [
      '-S', this.options.hostTmuxSocket, 'has-session', '-t', `=${sessionName}`
    ]);
    // accept tmux's successful exact lookup as presence
    if (result.code === 0) return true;
    // accept only tmux's exact missing-session result as absence
    if (result.code === 1 && result.stdout.trim() === '' && result.stderr.trim() === `can't find session: ${sessionName}`) return false;
    throw new HostFilesError('broker_busy', 'host files broker session state is ambiguous', 503, true);
  }

  // read one exact stale pane without trusting an empty display result
  private async reconcilePaneIdentity(owner: BrokerOwnerRecord): Promise<ReturnType<typeof parsePaneIdentity> | undefined> {
    // skip pane inspection only after exact absence proof
    if (!await this.exactSessionExists(owner.expectedSessionName)) return undefined;
    const shown = await this.command(this.options.tmuxBinary, [
      '-S', this.options.hostTmuxSocket, 'display-message', '-p', '-t', `=${owner.expectedSessionName}:`,
      '#{session_id}\t#{session_name}\t#{pane_id}\t#{pane_pid}\t#{@rac_files_nonce}\t#{@rac_role}\t#{@rac_files_protocol}\t#{@rac_files_digest}'
    ]);
    // parse only a nonempty successful identity response
    if (shown.code === 0 && shown.stdout.trim() !== '') {
      try {
        return parsePaneIdentity(shown.stdout);
      } catch { /* malformed identity grants no cleanup authority */ }
    }
    // tolerate only a session that disappeared during inspection
    if (!await this.exactSessionExists(owner.expectedSessionName)) return undefined;
    throw new HostFilesError('broker_busy', 'host files broker session identity is ambiguous', 503, true);
  }

  // inspect one host process while distinguishing absence from unreadable state
  private async processStartTimeIfPresent(pid: number): Promise<string | undefined> {
    try {
      return await procStartTime(this.options.hostProcRoot, pid);
    } catch (error) {
      // accept only proc entry disappearance as process absence
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
      throw new HostFilesError('broker_busy', 'host files broker process state is ambiguous', 503, true);
    }
  }

  // compare one exact persisted or just-captured process identity
  private async exactProcessExists(pid: number, expectedStartTime: string): Promise<boolean> {
    return await this.processStartTimeIfPresent(pid) === expectedStartTime;
  }

  // stop only one exact marked owner process
  private async stopOwnedProcess(owner: BrokerOwnerRecord): Promise<boolean> {
    const pane = await this.reconcilePaneIdentity(owner);
    // require persisted process identity when the session is already absent
    if (pane === undefined) {
      // launching records cannot prove which process exited
      if (owner.state === 'launching') return false;
      return !await this.exactProcessExists(owner.pid, owner.pidStartTime);
    }
    // require every immutable session marker before signaling
    if (pane.sessionName !== owner.expectedSessionName
      || pane.nonce !== owner.launchNonce
      || pane.role !== 'files-broker'
      || pane.protocol !== String(HOST_FILES_PROTOCOL)
      || pane.digest !== owner.programDigest) return false;
    // bind ready records to the persisted tmux and process identity
    if (owner.state !== 'launching'
      && (pane.sessionId !== owner.sessionId || pane.paneId !== owner.paneId || pane.pid !== owner.pid)) return false;
    const expectedStartTime = owner.state === 'launching'
      ? await this.processStartTimeIfPresent(pane.pid)
      : owner.pidStartTime;
    // require one live exact process before signaling its session
    if (expectedStartTime === undefined || !await this.exactProcessExists(pane.pid, expectedStartTime)) return false;
    const killed = await this.command(this.options.tmuxBinary, ['-S', this.options.hostTmuxSocket, 'kill-session', '-t', pane.sessionId]);
    // retain authority unless tmux accepted the exact stop request
    if (killed.code !== 0) return false;
    // verify exact process exit within the bounded shutdown window
    return await waitFor(async () => !await this.exactProcessExists(pane.pid, expectedStartTime), this.options.shutdownTimeoutMs ?? 3_000);
  }

  // revalidate exact process and socket identity before each connection
  private async validateReadyOwner(): Promise<{
    socketPath: string;
    namespaceRoot: string;
    socketHostPath: string;
    generation: string;
    capability: string;
  }> {
    const owner = this.owner;
    // require this instance's complete ready record
    if (owner === undefined || owner.state !== 'ready' || owner.serverInstanceId !== this.serverInstanceId || owner.generation !== this.generationId) {
      throw new HostFilesTransportError('bridge_unavailable', 'host files broker owner is not ready');
    }
    const persisted = JSON.parse(await readFile(this.ownerPath, 'utf8')) as BrokerOwnerRecord;
    // require the persisted owner bytes to bind this generation
    if (persisted.state !== 'ready'
      || persisted.serverInstanceId !== owner.serverInstanceId
      || persisted.generation !== owner.generation
      || persisted.pid !== owner.pid
      || persisted.pidStartTime !== owner.pidStartTime
      || persisted.hostSocketPath !== owner.hostSocketPath
      || persisted.socketPath !== owner.socketPath) {
      throw new HostFilesTransportError('bridge_unavailable', 'host files broker owner changed');
    }
    const [startTime, uid, executable, cmdline, socketIdentity, runtimeIdentity] = await Promise.all([
      procStartTime(this.options.hostProcRoot, owner.pid),
      procUid(this.options.hostProcRoot, owner.pid),
      readlink(join(this.options.hostProcRoot, String(owner.pid), 'exe')),
      readFile(join(this.options.hostProcRoot, String(owner.pid), 'cmdline')),
      fileIdentity(owner.socketPath),
      fileIdentity(owner.runtimePath)
    ]);
    // reject PID reuse, executable drift, argv drift, or socket substitution
    if (startTime !== owner.pidStartTime
      || uid !== owner.uid
      || executable !== owner.executable
      || digest(cmdline) !== owner.cmdlineDigest
      || !sameIdentity(socketIdentity, owner.socketIdentity)
      || !sameIdentity(runtimeIdentity, owner.runtimeIdentity)) {
      throw new HostFilesTransportError('bridge_unavailable', 'host files broker identity changed');
    }
    return {
      socketPath: owner.socketPath,
      namespaceRoot: join(this.options.hostProcRoot, String(owner.pid), 'root'),
      socketHostPath: owner.hostSocketPath,
      generation: owner.generation,
      capability: this.capability
    };
  }

  // classify backend loss that requires a fresh generation
  private resettable(error: unknown): boolean {
    return error instanceof HostFilesTransportError || error instanceof HostFilesError && error.code === 'bridge_unavailable';
  }

  // stop one failed generation without replaying its request
  private async resetAfterFailure(error: unknown): Promise<void> {
    // preserve ordinary operation failures and conflicts
    if (!this.resettable(error) || this.closed) return;
    this.stopping ??= (async () => {
      await this.stopGeneration();
      // rotate tokens only after exact old-generation cleanup
      this.generationId = randomUUID();
      this.capability = randomBytes(32).toString('base64url');
    })();
    const stopping = this.stopping;
    try {
      await stopping;
    } finally {
      // clear only the reset generation observed above
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  // execute one bounded host command after lazy startup
  async request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>> {
    try {
      return await (await this.ensureBackend()).request(command, signal);
    } catch (error) {
      // invalidate without replaying an ambiguous operation
      await this.resetAfterFailure(error);
      throw error;
    }
  }

  // stream one host file after lazy startup
  async read(command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable> {
    try {
      const stream = await (await this.ensureBackend()).read(command, signal);
      // rotate after an asynchronous broker stream failure
      stream.once('error', (error: Error) => { void this.resetAfterFailure(error).catch(() => {}); });
      return stream;
    } catch (error) {
      // invalidate before exposing an unopened stream failure
      await this.resetAfterFailure(error);
      throw error;
    }
  }

  // stream one host write after lazy startup
  async write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    try {
      return await (await this.ensureBackend()).write(command, source, signal);
    } catch (error) {
      // invalidate without replaying an ambiguous upload
      await this.resetAfterFailure(error);
      throw error;
    }
  }

  // stop and remove only the current exact fail-stop generation
  private async stopGeneration(): Promise<void> {
    const owner = this.owner;
    // mark exact ready ownership as stopping before signaling
    if (owner !== undefined && owner.state === 'ready') {
      const stopping: BrokerReadyOwner = { ...owner, state: 'stopping' };
      await writePrivateJson(this.ownerPath, stopping).catch(() => {});
      this.owner = stopping;
    }
    // close the authenticated controller first
    await this.backend?.close().catch(() => {});
    // require exact process exit before releasing recovery authority
    if (owner !== undefined) {
      const exited = owner.state === 'launching'
        ? false
        : await waitFor(async () => !await this.exactProcessExists(owner.pid, owner.pidStartTime), this.options.shutdownTimeoutMs ?? 3_000);
      const stopped = exited || await this.stopOwnedProcess(owner);
      // preserve descriptor, owner, and lock on every ambiguous stop
      if (!stopped) throw new HostFilesError('broker_busy', 'host files broker process is still running', 503, true);
    }
    // remove only this generation's exact descriptor
    if (owner !== undefined) await removeExactFile(owner.descriptorPath, owner.descriptorIdentity).catch(() => false);
    // remove the owner record only when it still names this instance
    const persisted = await readFile(this.ownerPath, 'utf8').then(value => JSON.parse(value) as BrokerOwnerRecord).catch(() => undefined);
    // preserve state replaced by another owner
    if (persisted?.serverInstanceId === this.serverInstanceId && persisted.generation === this.generationId) await rm(this.ownerPath).catch(() => {});
    // release only the exact lock acquired by this instance
    if (this.lockIdentity !== undefined) await removeExactFile(this.lockPath, this.lockIdentity).catch(() => false);
    this.backend = undefined;
    this.owner = undefined;
    this.lockIdentity = undefined;
  }

  // stop intake and the exact current generation
  async close(): Promise<void> {
    // make close idempotent and stop new intake
    if (this.closed) return;
    this.closed = true;
    const starting = this.starting;
    // await any already-requested launch before exact shutdown
    if (starting !== undefined) await starting.catch(() => undefined);
    this.stopping ??= this.stopGeneration();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }
}

// construct the lazy bridged backend for root integration
export function createHostFilesBackend(options: HostBrokerControllerOptions): HostFilesBackend {
  return new LazyHostBrokerBackend(options);
}
