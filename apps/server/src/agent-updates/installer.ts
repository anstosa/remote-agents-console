import { constants, type BigIntStats } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentUpdateFailureReason } from './diagnostics.js';
import { maxAgentUpdateOutputBytes } from './diagnostics.js';
import { agentUpdateDirectory, InvalidAgentUpdateArtifact, readPrivateAgentArtifact, validInstallerLockIdentity } from './storage.js';
import { run, tmuxFormatLiteral } from '../tmux/command.js';

export type InstallerResult = { code: number; output: string; failure?: AgentUpdateFailureReason; confirmed?: true };

export type InstallerLocation = {
  checkout: string;
  hostCheckout?: string;
  home: string;
  socket?: string;
  tmuxBinary: string;
  path?: string;
};

const jobIdPattern = /^[a-f0-9]{24}$/u;
const receiptLimit = 1024;
const maximumTimeoutMs = 15 * 60_000;
const captureGraceMs = 5_000;
const artifactSuffixes = [
  '.installer.out',
  '.installer.out.tmp',
  '.installer.command.tmp',
  '.installer.capture.tmp',
  '.installer.status',
  '.installer.status.tmp'
] as const;
const knownFailures = new Set<AgentUpdateFailureReason>([
  'command_failed',
  'launch_failed',
  'timed_out',
  'bridge_unavailable',
  'invalid_completion',
  'interrupted',
  'installer_busy'
]);

// quote one fixed shell value
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// detect a console owned by one systemd service cgroup
function managedBySystemd(environment: NodeJS.ProcessEnv): boolean {
  return environment.INVOCATION_ID?.trim() !== '' && environment.INVOCATION_ID !== undefined
    || environment.SYSTEMD_EXEC_PID?.trim() !== '' && environment.SYSTEMD_EXEC_PID !== undefined;
}

// require one opaque job identifier before deriving paths
function requireJobId(id: string): void {
  // reject path syntax and identifiers from another protocol
  if (!jobIdPattern.test(id)) throw new Error('invalid agent update job id');
}

// identify only a private regular lock belonging to the launch account
function lockIdentity(details: BigIntStats): string | undefined {
  const owner = process.getuid?.();
  // reject foreign, exposed and non-regular lock state
  if (!details.isFile() || (details.mode & 0o077n) !== 0n || owner !== undefined && details.uid !== BigInt(owner)) return undefined;
  return `${details.dev}:${details.ino}`;
}

// verify the named entry still refers to the opened private inode
async function namedLockIdentity(path: string): Promise<string | undefined> {
  return lockIdentity(await lstat(path, { bigint: true }));
}

// test one exact entry without hiding storage failures
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    // classify only a missing entry as absent
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// parse the strict terminal receipt written by the host supervisor
function parseReceipt(bytes: Buffer): Omit<InstallerResult, 'output'> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid agent update installer receipt'); }
  // require the exact versioned receipt object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid agent update installer receipt');
  const receipt = value as { version?: unknown; code?: unknown; failure?: unknown };
  const keys = Object.keys(receipt);
  // refuse added fields and malformed exit codes
  if (receipt.version !== 1 || !Number.isInteger(receipt.code) || (receipt.code as number) < -1 || (receipt.code as number) > 255 || keys.some(key => !['version', 'code', 'failure'].includes(key))) {
    throw new Error('invalid agent update installer receipt');
  }
  // require a recognized failure category when one is present
  if (receipt.failure !== undefined && (typeof receipt.failure !== 'string' || !knownFailures.has(receipt.failure as AgentUpdateFailureReason))) {
    throw new Error('invalid agent update installer receipt');
  }
  // pair only synthetic exits with categorical failures
  if ((receipt.code === -1) !== (receipt.failure !== undefined)) throw new Error('invalid agent update installer receipt');
  return { code: receipt.code as number, ...(receipt.failure === undefined ? {} : { failure: receipt.failure as AgentUpdateFailureReason }) };
}

// build one host supervisor that owns deadline, lock and terminal publication
function supervisorScript(location: InstallerLocation, id: string, command: string, timeoutMs: number, executionDeadlineMs: number, expectedLock: string, restoredPath?: string): string {
  const hostCheckout = location.socket === undefined ? location.checkout : location.hostCheckout!;
  const jobs = join(hostCheckout, '.data', 'agent-updates', 'jobs');
  const updates = join(hostCheckout, '.data', 'agent-updates');
  const output = join(jobs, `${id}.installer.out`);
  const outputTemporary = `${output}.tmp`;
  const commandStatus = join(jobs, `${id}.installer.command.tmp`);
  const captureStatus = join(jobs, `${id}.installer.capture.tmp`);
  const status = join(jobs, `${id}.installer.status`);
  const statusTemporary = `${status}.tmp`;
  const lock = join(updates, 'installer.lock');
  const path = location.path?.trim() || restoredPath;
  const pathExport = path === undefined ? '' : `export PATH=${quote(path)}\n`;
  const commandPayload = `(${command}\n)
code="$?"
(set -o noclobber; printf '%s\\n' "$code" > ${quote(commandStatus)}) || exit 74
exit "$code"`;
  const timedCommand = `now_ms="$(/usr/bin/date +%s%3N)"
# reject an unreadable clock without running configured work
if ! [[ "$now_ms" =~ ^[0-9]+$ ]]; then exit 70; fi
remaining_ms=$((${executionDeadlineMs} - now_ms))
# reject work that lost authorization before the timeout process started
if [ "$remaining_ms" -le 0 ]; then
  (set -o noclobber; printf '%s\\n' expired > ${quote(commandStatus)}) || exit 74
  exit 0
fi
# retain the configured ceiling when more authorization remains
if [ "$remaining_ms" -gt ${timeoutMs} ]; then remaining_ms=${timeoutMs}; fi
printf -v command_timeout '%d.%03ds' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))"
/usr/bin/timeout --signal=TERM --kill-after=2s "$command_timeout" /bin/bash -c ${quote(commandPayload)}`;
  const captureCommand = `set -o noclobber
now_ms="$(/usr/bin/date +%s%3N)"
# reject an unreadable clock without creating command evidence
if ! [[ "$now_ms" =~ ^[0-9]+$ ]]; then exit 70; fi
remaining_ms=$((${executionDeadlineMs} - now_ms))
# publish an empty capture when authorization expired before execution
if [ "$remaining_ms" -le 0 ]; then
  : > ${quote(outputTemporary)}
  printf '%s\\n' expired > ${quote(commandStatus)}
  printf '%s\\n' 0 > ${quote(captureStatus)}
  exit 0
fi
# cap the active timer to the configured installer ceiling
if [ "$remaining_ms" -gt ${timeoutMs} ]; then remaining_ms=${timeoutMs}; fi
printf -v command_timeout '%d.%03ds' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))"
/usr/bin/timeout --signal=TERM --kill-after=2s "$command_timeout" /bin/bash -c ${quote(timedCommand)} </dev/null 2>&1 | /usr/bin/tail -c ${maxAgentUpdateOutputBytes} > ${quote(outputTemporary)}
tail_code="\${PIPESTATUS[1]}"
printf '%s\\n' "$tail_code" > ${quote(captureStatus)}`;
  return `umask 077
export HOME=${quote(location.home)}
${pathExport}export BASH_ENV=/dev/null
# publish one durable terminal record
publish_receipt() {
  local payload="$1"
  (set -o noclobber; printf '%s\\n' "$payload" > ${quote(statusTemporary)}) || exit 74
  /bin/chmod 600 ${quote(statusTemporary)}
  if [ -x /usr/bin/sync ]; then /usr/bin/sync -f ${quote(statusTemporary)}; fi
  /bin/mv -- ${quote(statusTemporary)} ${quote(status)}
  if [ -x /usr/bin/sync ]; then /usr/bin/sync -f ${quote(jobs)}; fi
}
# fail before taking the shared lock
if ! cd -- ${quote(location.home)}; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# require fixed host tools
for tool in /usr/bin/date /usr/bin/flock /usr/bin/stat /usr/bin/timeout /usr/bin/tail /bin/bash /bin/chmod /bin/mv /bin/rm; do
  if [ ! -x "$tool" ]; then
    publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
    exit 0
  fi
done
# open only the preauthorized lock and never create replacement state
if ! exec 9< ${quote(lock)}; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# verify the shared device and inode before acquiring execution authority
if [ "$(/usr/bin/stat -Lc '%d:%i' /proc/self/fd/9)" != ${quote(expectedLock)} ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# serialize host package mutations
/usr/bin/flock -n -E 75 9
lock_code=$?
# return contention without retrying
if [ "$lock_code" -eq 75 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"installer_busy"}'
  exit 0
fi
# publish unexpected lock failures
if [ "$lock_code" -ne 0 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# retain authorization only while the named lock still matches the admitted inode
if [ "$(/usr/bin/stat -c '%d:%i' -- ${quote(lock)})" != ${quote(expectedLock)} ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# fence execution with the durable absolute authorization deadline
now_ms="$(/usr/bin/date +%s%3N)"
if ! [[ "$now_ms" =~ ^[0-9]+$ ]]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
remaining_ms=$((${executionDeadlineMs} - now_ms))
# reject expired work while holding the exact shared lock
if [ "$remaining_ms" -le 0 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"interrupted"}'
  exit 0
fi
# retain the configured ceiling and reserve only bounded capture grace
if [ "$remaining_ms" -gt ${timeoutMs} ]; then remaining_ms=${timeoutMs}; fi
capture_ms="$((remaining_ms + ${captureGraceMs}))"
printf -v capture_timeout '%d.%03ds' "$((capture_ms / 1000))" "$((capture_ms % 1000))"
# bound both the installer and its output drain within receipt grace
/usr/bin/timeout --signal=TERM --kill-after=2s "$capture_timeout" /bin/bash -c ${quote(captureCommand)}
capture_code="$?"
capture_timed_out=0
# require an authoritative capture completion marker
if [ -f ${quote(captureStatus)} ]; then
  IFS= read -r tail_code < ${quote(captureStatus)}
  /bin/rm -f -- ${quote(captureStatus)}
else
  tail_code=-1
  # distinguish the outer capture deadline
  if [ "$capture_code" -eq 124 ] || [ "$capture_code" -eq 137 ]; then
    capture_timed_out=1
    tail_code=0
  fi
fi
# fail when output cannot be published
if [ "$tail_code" -ne 0 ] || [ ! -f ${quote(outputTemporary)} ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
/bin/chmod 600 ${quote(outputTemporary)}
if [ -x /usr/bin/sync ]; then /usr/bin/sync -f ${quote(outputTemporary)}; fi
/bin/mv -- ${quote(outputTemporary)} ${quote(output)}
if [ -x /usr/bin/sync ]; then /usr/bin/sync -f ${quote(jobs)}; fi
# settle a bounded output-drain timeout
if [ "$capture_timed_out" -eq 1 ]; then
  /bin/rm -f -- ${quote(commandStatus)}
  publish_receipt '{"version":1,"code":-1,"failure":"timed_out"}'
  exit 0
fi
# prefer the inner command's exact exit marker
if [ -f ${quote(commandStatus)} ]; then
  IFS= read -r code < ${quote(commandStatus)}
  /bin/rm -f -- ${quote(commandStatus)}
else
  code=-1
fi
# classify host-side expiry separately from an active command timeout
if [ "$code" = expired ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"interrupted"}'
elif [ "$code" -eq -1 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"timed_out"}'
elif ! [[ "$code" =~ ^(0|[1-9][0-9]{0,2})$ ]] || [ "$code" -gt 255 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"invalid_completion"}'
else
  publish_receipt "{\\"version\\":1,\\"code\\":$code}"
fi`;
}

export class AgentUpdateInstaller {
  constructor(private readonly location: InstallerLocation) {}

  // establish lock identity before publishing a durable installation authorization
  async prepareLock(): Promise<string> {
    const jobs = await agentUpdateDirectory(this.location.checkout, { jobs: true });
    // creation guarantees the directory unless storage is invalid
    if (jobs === undefined) throw new Error('agent update installer storage unavailable');
    const path = join(dirname(jobs), 'installer.lock');
    const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const identity = lockIdentity(await file.stat({ bigint: true }));
      // bind the authorization to the exact named private inode
      if (identity === undefined || await namedLockIdentity(path) !== identity) throw new Error('invalid agent update installer lock');
      return identity;
    } finally {
      await file.close();
    }
  }

  // hand one bounded command to the host; isolated callers receive startup grace
  async launch(id: string, command: string, timeoutMs: number, executionDeadlineMs: number = Date.now() + timeoutMs + 10_000, expectedLock?: string): Promise<InstallerResult | undefined> {
    requireJobId(id);
    // reject unbounded or nonsensical host deadlines
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) throw new Error('invalid agent update installer timeout');
    // require one explicit absolute cutoff when the service supplies it
    if (!Number.isSafeInteger(executionDeadlineMs) || executionDeadlineMs < 1) throw new Error('invalid agent update installer deadline');
    // prove refusal before creating state or handing work to another process
    if (Date.now() >= executionDeadlineMs) return { code: -1, output: 'Installer authorization expired before handoff.', failure: 'interrupted', confirmed: true };
    const jobs = await agentUpdateDirectory(this.location.checkout, { jobs: true });
    // creation guarantees the directory unless storage is invalid
    if (jobs === undefined) throw new Error('agent update installer storage unavailable');
    const lock = join(dirname(jobs), 'installer.lock');
    const artifacts = artifactSuffixes.map(suffix => `${id}${suffix}`);
    // reject accidental or ambiguous reuse before starting another installation
    if ((await Promise.all(artifacts.map(async name => await entryExists(join(jobs, name))))).some(Boolean)) {
      throw new Error('agent update installer job already exists');
    }
    // isolated callers establish an identity; durable callers provide the persisted one
    const identity = expectedLock ?? await this.prepareLock();
    // a changed lock discovered before handoff proves this launch was refused
    if (!validInstallerLockIdentity(identity) || await namedLockIdentity(lock).catch(() => undefined) !== identity) {
      return { code: -1, output: 'Installer lock identity could not be verified before handoff.', failure: 'launch_failed', confirmed: true };
    }
    // use the long-lived host tmux server for bridged deployments
    if (this.location.socket !== undefined) {
      // refuse a container-local fallback for a host-owned installation
      if (this.location.hostCheckout === undefined) return { code: -1, output: 'Shared host checkout unavailable.', failure: 'bridge_unavailable', confirmed: true };
      const script = supervisorScript(this.location, id, command, timeoutMs, executionDeadlineMs, identity);
      const session = `rac-agent-install-${id}`;
      try {
        await run(this.location.tmuxBinary, ['-S', this.location.socket, 'new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(this.location.home), '/bin/bash', '-lc', script]);
      } catch {
        // a rejected client promise cannot prove whether tmux accepted the handoff
        return undefined;
      }
      // every client exit after spawn is ambiguous, so observation owns completion
      return undefined;
    }
    const nativePath = this.location.path?.trim() || process.env.PATH?.trim() || '/usr/local/bin:/usr/bin:/bin';
    // escape a managed console cgroup into one separately bounded user unit
    if (managedBySystemd(process.env)) {
      const script = supervisorScript(this.location, id, command, timeoutMs, executionDeadlineMs, identity, nativePath);
      // older systemd versions lack the argument-expansion switch
      const payload = Buffer.from(script, 'utf8').toString('base64');
      const literalScript = `echo '${payload}' | /usr/bin/base64 --decode | /bin/bash`;
      const clientEnvironment = [
        ...(process.env.XDG_RUNTIME_DIR === undefined ? [] : [`XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`]),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined ? [] : [`DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS}`])
      ];
      const unit = `rac-agent-install-${id}`;
      const runtimeBudgetMs = Math.min(timeoutMs, Math.max(1, executionDeadlineMs - Date.now()));
      const runtimeSeconds = Math.ceil((runtimeBudgetMs + 10_000) / 1000);
      try {
        await run('/usr/bin/env', [
          ...clientEnvironment,
          '/usr/bin/systemd-run',
          '--user',
          '--no-block',
          '--collect',
          '--quiet',
          `--unit=${unit}`,
          `--property=RuntimeMaxSec=${runtimeSeconds}s`,
          '--property=TimeoutStopSec=2s',
          '/bin/bash',
          '-c',
          literalScript
        ]);
      } catch {
        // a rejected client promise cannot prove whether systemd accepted the handoff
        return undefined;
      }
      // every client exit after spawn is ambiguous, so observation owns completion
      return undefined;
    }
    const script = supervisorScript(this.location, id, command, timeoutMs, executionDeadlineMs, identity);
    const environment: NodeJS.ProcessEnv = {
      HOME: this.location.home,
      ...(process.env.USER === undefined ? {} : { USER: process.env.USER }),
      ...(process.env.LOGNAME === undefined ? {} : { LOGNAME: process.env.LOGNAME }),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: nativePath,
      BASH_ENV: '/dev/null'
    };
    try {
      // a detached process survives an unmanaged console process restart
      const child = spawn('/bin/bash', ['-c', script], { cwd: this.location.home, detached: true, env: environment, shell: false, stdio: 'ignore' });
      // wait until the kernel accepts the detached supervisor
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return undefined;
    } catch (error) {
      // a local spawn rejection proves no detached supervisor exists
      return { code: -1, output: error instanceof Error ? error.message : String(error), failure: 'launch_failed', confirmed: true };
    }
  }

  // return one terminal receipt without inferring failure from missing state
  async observe(id: string): Promise<InstallerResult | undefined> {
    requireJobId(id);
    const jobs = await agentUpdateDirectory(this.location.checkout, { jobs: true });
    // creation guarantees the directory unless storage is invalid
    if (jobs === undefined) throw new Error('agent update installer storage unavailable');
    let receipt: Buffer | undefined;
    try {
      receipt = await readPrivateAgentArtifact(join(jobs, `${id}.installer.status`), receiptLimit);
    } catch (error) {
      // settle only one malformed terminal artifact
      if (error instanceof InvalidAgentUpdateArtifact) return { code: -1, output: '', failure: 'invalid_completion' };
      throw error;
    }
    // an absent atomic receipt means the accepted handoff may still be active
    if (receipt === undefined) return undefined;
    let terminal: Omit<InstallerResult, 'output'>;
    try { terminal = parseReceipt(receipt); } catch { return { code: -1, output: '', failure: 'invalid_completion' }; }
    let output: Buffer | undefined;
    try {
      output = await readPrivateAgentArtifact(join(jobs, `${id}.installer.out`), maxAgentUpdateOutputBytes);
    } catch (error) {
      // a valid receipt proves the writer stopped even when its output is corrupt
      if (error instanceof InvalidAgentUpdateArtifact) return { code: -1, output: '', failure: 'invalid_completion', confirmed: true };
      throw error;
    }
    // completed commands always publish output before their receipt
    if (output === undefined && !['installer_busy', 'launch_failed', 'invalid_completion', 'interrupted'].includes(terminal.failure ?? '')) {
      return { code: -1, output: '', failure: 'invalid_completion', confirmed: true };
    }
    return { ...terminal, output: output?.toString('utf8') ?? '', confirmed: true };
  }

  // prove the exact shared installer lock has no current holder
  async isIdle(expectedLock?: string): Promise<boolean> {
    // legacy jobs without continuity evidence cannot prove an unknown completion
    if (!validInstallerLockIdentity(expectedLock)) return false;
    const updates = await agentUpdateDirectory(this.location.checkout, { create: false });
    // missing state cannot prove a previously authorized lock was released
    if (updates === undefined) return false;
    const path = join(updates, 'installer.lock');
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      // absence or a link cannot establish lock continuity
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    try {
      // require the durable identity before attempting a descriptor-only lock
      if (lockIdentity(await file.stat({ bigint: true })) !== expectedLock) return false;
      const acquired = await new Promise<boolean>(resolve => {
        const child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', '3'], {
          shell: false,
          stdio: ['ignore', 'ignore', 'ignore', file.fd]
        });
        // a missing proof tool fails closed
        child.once('error', () => resolve(false));
        // only an acquired descriptor lock proves current idleness
        child.once('close', code => resolve(code === 0));
      });
      // preserve contention and proof-tool failures as not idle
      if (!acquired) return false;
      // require the acquired inode to remain the shared path target
      return await namedLockIdentity(path).catch(() => undefined) === expectedLock;
    } finally {
      await file.close();
    }
  }

  // remove only exact completed-job artifacts without touching a host process
  async cleanup(id: string): Promise<void> {
    requireJobId(id);
    const jobs = await agentUpdateDirectory(this.location.checkout, { jobs: true });
    // creation guarantees the directory unless storage is invalid
    if (jobs === undefined) throw new Error('agent update installer storage unavailable');
    await Promise.all(artifactSuffixes.map(async suffix => await unlink(join(jobs, `${id}${suffix}`)).catch(error => {
      // ignore only already-absent artifacts
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    })));
  }
}
