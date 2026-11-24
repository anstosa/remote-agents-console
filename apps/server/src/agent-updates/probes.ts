import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { maxAgentUpdateOutputBytes, type AgentUpdateFailureReason } from './diagnostics.js';
import type { InstallerLocation, InstallerResult } from './installer.js';
import { agentUpdateDirectory, InvalidAgentUpdateArtifact, readPrivateAgentArtifact } from './storage.js';
import { run, safeEnv, tmuxFormatLiteral } from '../tmux/command.js';

const probeReceiptLimit = 1024;
const probePollMs = 100;
const probeGraceMs = 7_000;
const knownProbeFailures = new Set<AgentUpdateFailureReason>(['launch_failed', 'timed_out', 'invalid_completion']);

// quote one fixed shell value
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// retain only the newest bounded output bytes
function appendOutput(current: Buffer, value: Buffer): Buffer {
  const combined = Buffer.concat([current, value]);
  // discard only the oldest bytes above the diagnostic limit
  if (combined.length > maxAgentUpdateOutputBytes) return combined.subarray(combined.length - maxAgentUpdateOutputBytes);
  return combined;
}

// preserve stdout-first version evidence within one shared bound
function combinedNativeOutput(stdout: Buffer, stderr: Buffer): string {
  const retainedStdout = stdout.length > maxAgentUpdateOutputBytes ? stdout.subarray(stdout.length - maxAgentUpdateOutputBytes) : stdout;
  const remaining = maxAgentUpdateOutputBytes - retainedStdout.length;
  const retainedStderr = stderr.length > remaining ? stderr.subarray(stderr.length - remaining) : stderr;
  return Buffer.concat([retainedStdout, retainedStderr]).toString('utf8');
}

// retain one bounded launch-client output tail
function boundedProbeOutput(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  // preserve already bounded client evidence
  if (bytes.length <= maxAgentUpdateOutputBytes) return value;
  return bytes.subarray(bytes.length - maxAgentUpdateOutputBytes).toString('utf8');
}

// execute one locally bounded probe without waiting for descendant-held pipes
async function runNativeProbe(location: InstallerLocation, command: string, timeoutMs: number): Promise<InstallerResult> {
  const path = location.path?.trim() || safeEnv().PATH!;
  const script = `export HOME=${quote(location.home)}
export PATH=${quote(path)}
export BASH_ENV=/dev/null
cd -- ${quote(location.home)} || exit 125
{ ${command}; }`;
  const timeout = `${Math.max(1, timeoutMs) / 1000}s`;
  return await new Promise(resolve => {
    const child = spawn('/usr/bin/timeout', ['--signal=TERM', '--kill-after=2s', timeout, '/bin/bash', '-lc', script], {
      cwd: location.home,
      detached: true,
      env: { ...safeEnv(), HOME: location.home, PATH: path, BASH_ENV: '/dev/null' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    // finish once and explicitly close any descendant-held output pipes
    const finish = (result: InstallerResult): void => {
      // ignore a late exit after the outer deadline
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    // retain separate tails so stdout stays ahead of warnings
    child.stdout.on('data', (value: Buffer) => { stdout = appendOutput(stdout, value); });
    child.stderr.on('data', (value: Buffer) => { stderr = appendOutput(stderr, value); });
    child.once('error', error => finish({ code: -1, output: error.message, failure: 'launch_failed' }));
    child.once('close', (code, signal) => {
      const text = combinedNativeOutput(stdout, stderr);
      // classify the host timeout utility's terminal statuses
      if (code === 124 || code === 137) return finish({ code: -1, output: text, failure: 'timed_out' });
      // reject signal termination without inventing a command exit
      if (code === null) return finish({ code: -1, output: text || `Probe stopped by ${signal ?? 'an unknown signal'}.`, failure: 'launch_failed' });
      return finish({ code, output: text });
    });
    const deadline = setTimeout(() => {
      // kill the detached process group when the host supervisor exceeds its grace
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      finish({ code: -1, output: combinedNativeOutput(stdout, stderr), failure: 'timed_out' });
    }, timeoutMs + 2_500);
  });
}

// build one host-bounded probe that publishes output before its terminal receipt
function bridgeProbeScript(location: InstallerLocation, command: string, deadlineMs: number, hostBase: string): string {
  const output = `${hostBase}.out`;
  const outputTemporary = `${output}.tmp`;
  const commandStatus = `${hostBase}.command.tmp`;
  const captureStatus = `${hostBase}.capture.tmp`;
  const status = `${hostBase}.status`;
  const statusTemporary = `${status}.tmp`;
  const pathExport = location.path?.trim() ? `export PATH=${quote(location.path.trim())}\n` : '';
  const commandScript = `export HOME=${quote(location.home)}
${pathExport}export BASH_ENV=/dev/null
cd -- ${quote(location.home)} || exit 125
( { ${command}; } )
code="$?"
(set -o noclobber; printf '%s\\n' "$code" > ${quote(commandStatus)}) || exit 74
exit "$code"`;
  const captureScript = `set -o noclobber
/usr/bin/timeout --signal=TERM --kill-after=2s "$remaining_timeout" /bin/bash -lc ${quote(commandScript)} 2>&1 | /usr/bin/tail -c ${maxAgentUpdateOutputBytes} > ${quote(outputTemporary)}
tail_code="\${PIPESTATUS[1]}"
printf '%s\\n' "$tail_code" > ${quote(captureStatus)}`;
  return `umask 077
export HOME=${quote(location.home)}
${pathExport}export BASH_ENV=/dev/null
# publish one atomic probe receipt
publish_receipt() {
  local payload="$1"
  (set -o noclobber; printf '%s\\n' "$payload" > ${quote(statusTemporary)}) || exit 74
  /bin/chmod 600 ${quote(statusTemporary)}
  /bin/mv -- ${quote(statusTemporary)} ${quote(status)}
}
# require the launch directory and fixed host tools
if ! cd -- ${quote(location.home)}; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
for tool in /usr/bin/date /usr/bin/timeout /usr/bin/tail /bin/bash /bin/chmod /bin/mv /bin/rm; do
  if [ ! -x "$tool" ]; then
    publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
    exit 0
  fi
done
# enforce the caller deadline on the host
now_ms="$(/usr/bin/date +%s%3N)"
remaining_ms=$(( ${deadlineMs} - now_ms ))
if [ "$remaining_ms" -le 0 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"timed_out"}'
  exit 0
fi
capture_ms=$(( remaining_ms + 3000 ))
printf -v remaining_timeout '%d.%03ds' "$(( remaining_ms / 1000 ))" "$(( remaining_ms % 1000 ))"
printf -v capture_timeout '%d.%03ds' "$(( capture_ms / 1000 ))" "$(( capture_ms % 1000 ))"
export remaining_timeout
/usr/bin/timeout --signal=TERM --kill-after=2s "$capture_timeout" /bin/bash -c ${quote(captureScript)}
capture_code="$?"
# require the output-drain completion marker
if [ -f ${quote(captureStatus)} ]; then
  IFS= read -r tail_code < ${quote(captureStatus)}
  /bin/rm -f -- ${quote(captureStatus)}
else
  tail_code=-1
fi
# publish the bounded output before terminal state
if [ ! -f ${quote(outputTemporary)} ]; then
  (set -o noclobber; : > ${quote(outputTemporary)}) || true
fi
if [ ! -f ${quote(outputTemporary)} ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
/bin/chmod 600 ${quote(outputTemporary)}
/bin/mv -- ${quote(outputTemporary)} ${quote(output)}
# classify a bounded output-drain timeout
if [ "$tail_code" -eq -1 ]; then
  /bin/rm -f -- ${quote(commandStatus)}
  publish_receipt '{"version":1,"code":-1,"failure":"timed_out"}'
  exit 0
fi
# reject an output capture failure
if ! [[ "$tail_code" =~ ^(0|[1-9][0-9]{0,2})$ ]] || [ "$tail_code" -ne 0 ]; then
  /bin/rm -f -- ${quote(commandStatus)}
  publish_receipt '{"version":1,"code":-1,"failure":"launch_failed"}'
  exit 0
fi
# a missing command marker means the inner host deadline fired
if [ ! -f ${quote(commandStatus)} ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"timed_out"}'
  exit 0
fi
IFS= read -r code < ${quote(commandStatus)}
/bin/rm -f -- ${quote(commandStatus)}
# require one exact shell exit code
if ! [[ "$code" =~ ^(0|[1-9][0-9]{0,2})$ ]] || [ "$code" -gt 255 ]; then
  publish_receipt '{"version":1,"code":-1,"failure":"invalid_completion"}'
else
  publish_receipt "{\\"version\\":1,\\"code\\":$code}"
fi`;
}

// parse one exact versioned terminal receipt
function parseProbeReceipt(bytes: Buffer): Omit<InstallerResult, 'output'> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new InvalidAgentUpdateArtifact('invalid agent update probe receipt'); }
  // require one plain receipt object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidAgentUpdateArtifact('invalid agent update probe receipt');
  const receipt = value as { version?: unknown; code?: unknown; failure?: unknown };
  const keys = Object.keys(receipt);
  // reject added fields and malformed exit codes
  if (receipt.version !== 1 || !Number.isInteger(receipt.code) || (receipt.code as number) < -1 || (receipt.code as number) > 255 || keys.some(key => !['version', 'code', 'failure'].includes(key))) {
    throw new InvalidAgentUpdateArtifact('invalid agent update probe receipt');
  }
  // accept only known synthetic probe failures
  if (receipt.failure !== undefined && (typeof receipt.failure !== 'string' || !knownProbeFailures.has(receipt.failure as AgentUpdateFailureReason))) {
    throw new InvalidAgentUpdateArtifact('invalid agent update probe receipt');
  }
  // pair synthetic exits with a categorical failure
  if ((receipt.code === -1) !== (receipt.failure !== undefined)) throw new InvalidAgentUpdateArtifact('invalid agent update probe receipt');
  return { code: receipt.code as number, ...(receipt.failure === undefined ? {} : { failure: receipt.failure as AgentUpdateFailureReason }) };
}

// test one exact artifact name without following it
async function artifactExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    // classify only an absent artifact as available
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// remove only one probe's exact private artifact set
async function cleanupProbeArtifacts(base: string): Promise<void> {
  await Promise.all(['.out', '.out.tmp', '.command.tmp', '.capture.tmp', '.status', '.status.tmp'].map(async suffix => {
    await unlink(`${base}${suffix}`).catch(error => {
      // ignore only artifacts already removed by the host
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }));
}

// execute one host-bridged probe with host-owned deadline and artifacts
async function runBridgeProbe(location: InstallerLocation, command: string, timeoutMs: number): Promise<InstallerResult> {
  // refuse a container-local fallback for host-owned commands
  if (location.hostCheckout === undefined) return { code: -1, output: 'Shared host checkout unavailable.', failure: 'bridge_unavailable' };
  const directory = await agentUpdateDirectory(location.checkout);
  // creation always returns the validated shared directory
  if (directory === undefined) return { code: -1, output: 'Shared update directory unavailable.', failure: 'bridge_unavailable' };
  const token = randomBytes(12).toString('hex');
  const session = `rac-agent-update-${token}`;
  const localBase = join(directory, token);
  const hostBase = join(location.hostCheckout, '.data', 'agent-updates', token);
  const artifacts = ['.out', '.out.tmp', '.command.tmp', '.capture.tmp', '.status', '.status.tmp'];
  // reject an ambiguous token before handing it to the host
  if ((await Promise.all(artifacts.map(async suffix => await artifactExists(`${localBase}${suffix}`)))).some(Boolean)) {
    return { code: -1, output: '', failure: 'invalid_completion' };
  }
  const deadlineMs = Date.now() + timeoutMs;
  const script = bridgeProbeScript(location, command, deadlineMs, hostBase);
  let writerConfirmed = false;
  try {
    let launched;
    try {
      launched = await run(location.tmuxBinary, ['-S', location.socket!, 'new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(location.home), '/bin/bash', '-lc', script]);
    } catch (error) {
      // a local spawn rejection cannot have reached the host bridge
      return { code: -1, output: error instanceof Error ? error.message : String(error), failure: 'launch_failed' };
    }
    const launchFailed = launched.timedOut || launched.code !== 0;
    const launchOutput = boundedProbeOutput(`${launched.stdout}${launched.stderr}`);
    const clientDeadline = deadlineMs + probeGraceMs;
    // wait for the host's atomic terminal receipt
    while (Date.now() < clientDeadline) {
      let receipt: Buffer | undefined;
      try {
        receipt = await readPrivateAgentArtifact(`${localBase}.status`, probeReceiptLimit);
      } catch (error) {
        // classify a malformed final artifact without assuming its writer stopped
        if (error instanceof InvalidAgentUpdateArtifact) return { code: -1, output: '', failure: 'invalid_completion' };
        throw error;
      }
      // settle only a complete atomic receipt
      if (receipt !== undefined) {
        let terminal: Omit<InstallerResult, 'output'>;
        try { terminal = parseProbeReceipt(receipt); } catch { return { code: -1, output: '', failure: 'invalid_completion' }; }
        writerConfirmed = true;
        let output: Buffer | undefined;
        try {
          output = await readPrivateAgentArtifact(`${localBase}.out`, maxAgentUpdateOutputBytes);
        } catch (error) {
          // reject malformed published output
          if (error instanceof InvalidAgentUpdateArtifact) return { code: -1, output: '', failure: 'invalid_completion' };
          throw error;
        }
        // normal command exits always publish output before the receipt
        if (output === undefined && terminal.code >= 0) return { code: -1, output: '', failure: 'invalid_completion' };
        return { ...terminal, output: output?.toString('utf8') ?? '' };
      }
      await wait(probePollMs);
    }
    // preserve ambiguous launch artifacts while reporting the client evidence
    if (launchFailed) return { code: launched.code, output: launchOutput, failure: 'launch_failed' };
    return { code: -1, output: '', failure: 'timed_out' };
  } finally {
    // delete artifacts only after a valid receipt proves host publication finished
    if (writerConfirmed) await cleanupProbeArtifacts(localBase);
  }
}

// run one configured version probe under the configured account and transport
export async function runConfiguredAgentProbe(location: InstallerLocation, command: string, timeoutMs: number): Promise<InstallerResult> {
  // reject unbounded or nonsensical host deadlines
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid agent update probe timeout');
  // use the native account directly when no host bridge is configured
  if (location.socket === undefined) return await runNativeProbe(location, command, timeoutMs);
  return await runBridgeProbe(location, command, timeoutMs);
}
