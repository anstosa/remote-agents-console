import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { gt, valid } from 'semver';
import { agentKinds, type AgentKind } from '../adapters/types.js';
import { writePrivate } from '../settings/files.js';
import { agentUpdateDirectory, readPrivateAgentArtifact, validInstallerLockIdentity } from './storage.js';
import type { AgentUpdateStatus } from './service.js';

export type AgentUpdateJob =
  | { id: string; kind: AgentKind; state: 'running' }
  | { id: string; kind: AgentKind; state: 'complete'; agent: AgentUpdateStatus }
  | { id: string; kind: AgentKind; state: 'failed'; error: string; agent?: AgentUpdateStatus };

type DurableAgentUpdateJob =
  | { id: string; kind: AgentKind; state: 'running'; phase: 'preflight'; deadline: number }
  | { id: string; kind: AgentKind; state: 'running'; phase: 'install'; deadline: number; previousVersion: string; targetVersion: string; installerLock?: string }
  | ({ finishedAt: number; cleanupEligible?: true } & Extract<AgentUpdateJob, { state: 'failed' | 'complete' }>);

export type AgentUpdateJobRecord = { version: 1; startedAt: number; authority: string } & DurableAgentUpdateJob;
export type TerminalAgentUpdateRecord = Exclude<AgentUpdateJobRecord, { state: 'running' }>;

const jobIdPattern = /^[a-f0-9]{24}$/u;
const authorityPattern = /^[a-f0-9]{64}$/u;
const jobFilePattern = /^([a-f0-9]{24})\.job\.json$/u;
const retainedTerminalJobs = 32;
const maximumRecordBytes = 16 * 1024;
const maximumErrorCharacters = 512;
const lockWaitSeconds = 5;

// require one plain object before inspecting durable fields
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// accept only one registered adapter kind
function agentKind(value: unknown): AgentKind | undefined {
  return typeof value === 'string' && (agentKinds as readonly string[]).includes(value) ? value as AgentKind : undefined;
}

// accept only one finite nonnegative millisecond timestamp
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

// retain only semantic versions that fit the public version contract
function semanticVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && valid(value) !== null;
}

// retain only a bounded single-line public error
function safeError(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumErrorCharacters && !/[\u0000-\u001f\u007f]/u.test(value);
}

// require an exact key set for every durable record variant
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

// retain only a verified installed/target pair in a durable outcome
function agentStatus(value: unknown, kind: AgentKind): AgentUpdateStatus | undefined {
  const record = objectRecord(value);
  // verified job results cannot contain missing versions, error statuses or pins
  if (record === undefined || agentKind(record.kind) !== kind || !semanticVersion(record.currentVersion) || !semanticVersion(record.latestVersion)) return undefined;
  // require the derived comparison and exact public shape
  if (record.updateAvailable !== gt(record.latestVersion, record.currentVersion) || !exactKeys(record, ['kind', 'currentVersion', 'latestVersion', 'updateAvailable'])) return undefined;
  return record as AgentUpdateStatus;
}

// parse one owner-only durable job without widening its authority
function parseRecord(raw: string, expectedId: string): AgentUpdateJobRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid agent update job record'); }
  const record = objectRecord(value);
  // bind the record to its exact file identity and authority
  if (record === undefined || record.version !== 1 || record.id !== expectedId || !jobIdPattern.test(expectedId) || (typeof record.authority !== 'string' || !authorityPattern.test(record.authority))) throw new Error('invalid agent update job record');
  const kind = agentKind(record.kind);
  // require a registered kind and safe start time
  if (kind === undefined || !timestamp(record.startedAt)) throw new Error('invalid agent update job record');
  const base = ['version', 'startedAt', 'authority', 'id', 'kind', 'state'];
  // accept only the bounded preflight shape
  if (record.state === 'running' && record.phase === 'preflight' && timestamp(record.deadline) && Number(record.deadline) > Number(record.startedAt) && exactKeys(record, [...base, 'phase', 'deadline'])) return record as AgentUpdateJobRecord;
  // accept only an actual semantic upgrade
  if (record.state === 'running' && record.phase === 'install' && timestamp(record.deadline) && Number(record.deadline) > Number(record.startedAt) && semanticVersion(record.previousVersion) && semanticVersion(record.targetVersion) && gt(record.targetVersion, record.previousVersion) && (record.installerLock === undefined || validInstallerLockIdentity(record.installerLock)) && exactKeys(record, [...base, 'phase', 'deadline', 'previousVersion', 'targetVersion', ...(record.installerLock === undefined ? [] : ['installerLock'])])) return record as AgentUpdateJobRecord;
  // require terminal time ordering
  if (!timestamp(record.finishedAt) || Number(record.finishedAt) < Number(record.startedAt)) throw new Error('invalid agent update job record');
  // allow cleanup only when the observer persisted proof of a terminal host result
  if (record.cleanupEligible !== undefined && record.cleanupEligible !== true) throw new Error('invalid agent update job record');
  const terminalKeys = [...base, 'finishedAt', ...(record.cleanupEligible === true ? ['cleanupEligible'] : [])];
  // validate a verified completion status
  if (record.state === 'complete') {
    const status = agentStatus(record.agent, kind);
    // accept only the exact completion shape
    if (status?.updateAvailable === false && exactKeys(record, [...terminalKeys, 'agent'])) return { ...record, agent: status } as AgentUpdateJobRecord;
  }
  // validate a bounded failure result
  if (record.state === 'failed' && safeError(record.error)) {
    const status = record.agent === undefined ? undefined : agentStatus(record.agent, kind);
    // retain optional verified postfailure status
    if ((record.agent === undefined || status !== undefined) && exactKeys(record, [...terminalKeys, 'error', ...(record.agent === undefined ? [] : ['agent'])])) return { ...record, ...(status === undefined ? {} : { agent: status }) } as AgentUpdateJobRecord;
  }
  throw new Error('invalid agent update job record');
}

export class AgentUpdateJobStore {
  private readonly jobsDirectory: string;
  private readonly lockPath: string;

  constructor(private readonly checkout: string) {
    this.jobsDirectory = join(checkout, '.data', 'agent-updates', 'jobs');
    this.lockPath = join(this.jobsDirectory, 'jobs.lock');
  }

  // read one exact durable job identity
  async read(id: string): Promise<AgentUpdateJobRecord | undefined> {
    // reject traversal and ambiguous names
    if (!jobIdPattern.test(id)) throw new Error('invalid agent update job id');
    // leave an installation without update history untouched
    if (await agentUpdateDirectory(this.checkout, { jobs: true, create: false }) === undefined) return undefined;
    return await this.readRecord(id);
  }

  // discover the active admission and all terminal records on disk
  async snapshot(): Promise<{ active?: Extract<AgentUpdateJobRecord, { state: 'running' }>; terminal: TerminalAgentUpdateRecord[] }> {
    const records = await this.records();
    const active = records.filter(record => record.state === 'running');
    // fail closed instead of choosing authority
    if (active.length > 1) throw new Error('multiple active agent update jobs');
    return { active: active[0], terminal: records.filter(record => record.state !== 'running') };
  }

  // find the one job that still owns installation admission
  async active(): Promise<AgentUpdateJobRecord | undefined> {
    return (await this.snapshot()).active;
  }

  // atomically publish one validated lifecycle state
  async write(record: AgentUpdateJobRecord): Promise<void> {
    const parsed = parseRecord(JSON.stringify(record), record.id);
    await agentUpdateDirectory(this.checkout, { jobs: true });
    await writePrivate(join(this.jobsDirectory, `${parsed.id}.job.json`), `${JSON.stringify(parsed)}\n`);
  }

  // hold one cross-process admission lock for a short read-decide-write section
  async withLock<T>(action: () => Promise<T>): Promise<T> {
    await agentUpdateDirectory(this.checkout, { jobs: true });
    const file = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const details = await file.stat();
      const current = await lstat(this.lockPath);
      const owner = process.getuid?.();
      // bind the inherited descriptor to the private lock inode
      if (!details.isFile() || details.dev !== current.dev || details.ino !== current.ino || (details.mode & 0o077) !== 0 || owner !== undefined && details.uid !== owner) throw new Error('invalid agent update lock');
      const child = spawn('/bin/sh', ['-c', `/usr/bin/flock --exclusive --timeout ${lockWaitSeconds} 3 || exit $?; printf 'READY\\n'; /bin/cat >/dev/null`], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe', file.fd]
      });
      // a broken release pipe is reflected by the lock supervisor exit
      child.stdin!.on('error', () => {});
      const closed = new Promise<{ code?: number | null; error?: Error }>(resolve => {
        let settled = false;
        child.once('error', error => {
          // retain the first terminal process event
          if (!settled) { settled = true; resolve({ error }); }
        });
        child.once('close', code => {
          // retain the first terminal process event
          if (!settled) { settled = true; resolve({ code }); }
        });
      });
      await this.waitUntilLocked(child);
      let result: T | undefined;
      let actionError: unknown;
      try { result = await action(); } catch (error) { actionError = error; } finally { child.stdin!.end(); }
      const exit = await closed;
      // preserve the caller's failure
      if (actionError !== undefined) throw actionError;
      // reject a lock supervisor failure
      if (exit.error !== undefined || exit.code !== 0) throw new Error('agent update lock failed');
      return result as T;
    } finally {
      await file.close();
    }
  }

  // retain bounded terminal history without deleting any running job
  async prune(currentId: string, beforeRemove?: (record: TerminalAgentUpdateRecord) => Promise<void>): Promise<void> {
    // reject traversal and ambiguous names
    if (!jobIdPattern.test(currentId)) throw new Error('invalid agent update job id');
    await this.withLock(async () => {
      const terminal = (await this.records()).filter(record => record.state !== 'running');
      const current = terminal.find(record => record.id === currentId);
      const newest = terminal.filter(record => record.id !== currentId).sort((left, right) => right.finishedAt - left.finishedAt || right.id.localeCompare(left.id));
      const retained = new Set([...(current === undefined ? [] : [current.id]), ...newest.slice(0, retainedTerminalJobs - (current === undefined ? 0 : 1)).map(record => record.id)]);
      const removed = await Promise.allSettled(terminal.filter(record => !retained.has(record.id)).map(async record => {
        // retain the durable cleanup proof until confirmed artifacts have been removed
        await beforeRemove?.(record);
        await unlink(join(this.jobsDirectory, `${record.id}.job.json`));
      }));
      // release the admission lock only after every removal has settled
      const failed = removed.find(result => result.status === 'rejected');
      // preserve a failed cleanup for a subsequent reconciliation
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }

  // read owner-only regular metadata without following links or blocking on devices
  private async readRecord(id: string): Promise<AgentUpdateJobRecord | undefined> {
    const raw = await readPrivateAgentArtifact(join(this.jobsDirectory, `${id}.job.json`), maximumRecordBytes);
    // history can be pruned concurrently with a read
    if (raw === undefined) return undefined;
    const text = raw.toString('utf8');
    // reject malformed encodings rather than accepting replacement characters
    if (raw.includes(0) || !Buffer.from(text, 'utf8').equals(raw)) throw new Error('invalid agent update job record');
    return parseRecord(text, id);
  }

  // read every recognized job record and reject disguised entries
  private async records(): Promise<AgentUpdateJobRecord[]> {
    // treat absent history as an empty catalog
    if (await agentUpdateDirectory(this.checkout, { jobs: true, create: false }) === undefined) return [];
    const entries = await readdir(this.jobsDirectory, { withFileTypes: true });
    const jobs = entries.filter(entry => jobFilePattern.test(entry.name));
    // reject disguised recognized job names
    if (jobs.some(entry => !entry.isFile())) throw new Error('invalid agent update job entry');
    const records = await Promise.all(jobs.map(async entry => this.readRecord(jobFilePattern.exec(entry.name)![1]!)));
    return records.filter(record => record !== undefined);
  }

  // wait until flock owns the already-open lock inode
  private async waitUntilLocked(child: ReturnType<typeof spawn>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = '';
      let error = '';
      const fail = (message: string) => {
        // settle one launch failure
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(message));
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => {
        output = `${output}${chunk}`.slice(-64);
        // admit work only after flock confirms ownership
        if (!settled && output.includes('READY\n')) { settled = true; resolve(); }
      });
      child.stderr?.on('data', chunk => { error = `${error}${chunk}`.slice(-512); });
      child.once('error', cause => fail(`agent update lock unavailable: ${cause.message}`));
      child.once('close', () => fail(error.trim() || 'agent update lock unavailable'));
    });
  }
}
