import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gt, valid } from 'semver';
import type { AgentKind } from '../adapters/types.js';
import { agentKinds } from '../adapters/types.js';
import type { ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { maxAgentUpdateOutputBytes, saveAgentUpdateFailure, type AgentUpdateFailureReason } from './diagnostics.js';

// allow registry latency while keeping version checks bounded
const statusTimeoutMs = 30_000;
// large agent downloads can exceed five minutes; keep the browser wait above this budget
const updateTimeoutMs = 15 * 60_000;
const cacheTtlMs = 15 * 60_000;
const failedCacheTtlMs = 60_000;
// quote one trusted command wrapper value for the host shell
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export type AgentUpdateStatus = { kind: AgentKind; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string };
type AgentUpdateResult = { outcome: 'updated'; status: AgentUpdateStatus } | { outcome: 'unavailable' } | { outcome: 'busy' } | { outcome: 'failed'; error?: string };
export type AgentUpdateJob =
  | { id: string; kind: AgentKind; state: 'running' }
  | { id: string; kind: AgentKind; state: 'complete'; agent: AgentUpdateStatus }
  | { id: string; kind: AgentKind; state: 'failed'; error: string };
export type AgentUpdateStart = { outcome: 'started'; job: AgentUpdateJob } | { outcome: 'unavailable' } | { outcome: 'busy' };
type AgentUpdateCommandResult = { code: number; output: string; failure?: AgentUpdateFailureReason };
export type AgentUpdateRunner = (command: string, timeoutMs: number) => Promise<AgentUpdateCommandResult>;
export type AgentUpdateServiceLike = Pick<AgentUpdateService, 'statuses' | 'update' | 'startUpdate' | 'updateStatus'>;

// remove terminal controls and retain one bounded version line
export function normalizedVersion(output: string): string | undefined {
  const plain = output
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const line = plain.split(/\r?\n/gu).map(value => value.trim()).find(Boolean);
  return line === undefined ? undefined : line.slice(0, 120);
}

// compare valid semantic versions
function semanticUpdateAvailable(current: string, latest: string): boolean | undefined {
  const currentVersion = valid(current);
  const latestVersion = valid(latest);
  // reject invalid command output
  if (currentVersion === null || latestVersion === null) return undefined;
  return gt(latestVersion, currentVersion);
}

// read only the newest bounded command output
async function readOutput(path: string): Promise<string> {
  const file = await open(path, 'r').catch(() => undefined);
  // tolerate a command that produced no output
  if (file === undefined) return '';
  try {
    const details = await file.stat();
    const length = Math.min(details.size, maxAgentUpdateOutputBytes);
    // avoid an unnecessary read for an empty file
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const result = await file.read(buffer, 0, length, details.size - length);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export class AgentUpdateService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly checkout: string;
  private readonly hostCheckout: string | undefined;
  private readonly runner: AgentUpdateRunner;
  private readonly cache = new Map<AgentKind, { status: AgentUpdateStatus; expiresAt: number }>();
  private readonly refreshes = new Map<AgentKind, Promise<AgentUpdateStatus>>();
  private readonly jobs = new Map<AgentKind, AgentUpdateJob>();
  private updating: AgentKind | undefined;

  // bind update commands to the launch account and host bridge
  constructor(private readonly config: ValidatedConfig, private readonly home: string, runner?: AgentUpdateRunner, checkout: string = serverCheckout()) {
    this.checkout = checkout;
    // prefer the update repository while preserving legacy workspace overrides
    this.hostCheckout = serverCheckoutOnHost(config.projects, process.env.RAC_HOST_REPOSITORY?.trim() || process.env.RAC_HOST_WORKSPACE, checkout);
    this.runner = runner ?? ((command, timeoutMs) => this.runConfigured(command, timeoutMs));
  }

  // publish every configured update-capable agent in registry order
  async statuses(): Promise<AgentUpdateStatus[]> {
    const kinds = agentKinds.filter(kind => this.config.adapters?.[kind]?.updates !== undefined);
    return await Promise.all(kinds.map(kind => this.status(kind)));
  }

  // start one bounded background update
  startUpdate(kind: AgentKind): AgentUpdateStart {
    const commands = this.config.adapters?.[kind]?.updates;
    // refuse kinds without a complete update contract
    if (commands === undefined) return { outcome: 'unavailable' };
    const current = this.jobs.get(kind);
    // coalesce duplicate starts for the active kind
    if (current?.state === 'running') return { outcome: 'started', job: current };
    // serialize every installer in this process
    if (this.updating !== undefined) return { outcome: 'busy' };
    const job: AgentUpdateJob = { id: randomBytes(12).toString('hex'), kind, state: 'running' };
    this.jobs.set(kind, job);
    void this.update(kind).then(result => {
      // retain only the terminal state for this job identity
      if (result.outcome === 'updated') this.settleJob(job, { ...job, state: 'complete', agent: result.status });
      else this.settleJob(job, { ...job, state: 'failed', error: result.outcome === 'failed' ? result.error ?? 'Agent update failed.' : 'Agent update failed.' });
    }, async error => {
      // contain an unexpected background rejection
      const failure = await this.failedUpdate(kind, { code: -1, output: exceptionOutput(error), failure: 'launch_failed' });
      this.settleJob(job, { ...job, state: 'failed', error: failure.error ?? 'Agent update failed.' });
    });
    return { outcome: 'started', job };
  }

  // read only the latest matching job
  updateStatus(kind: AgentKind, id: string): AgentUpdateJob | undefined {
    const job = this.jobs.get(kind);
    // hide stale and cross-kind identifiers
    if (job?.id !== id) return undefined;
    return job;
  }

  // execute one configured update and refresh its versions
  async update(kind: AgentKind): Promise<AgentUpdateResult> {
    const commands = this.config.adapters?.[kind]?.updates;
    // refuse kinds without a complete update contract
    if (commands === undefined) return { outcome: 'unavailable' };
    // serialize updates for one installation
    if (this.updating !== undefined) return { outcome: 'busy' };
    this.updating = kind;
    try {
      const activeRefresh = this.refreshes.get(kind);
      // finish an older version read before mutating the installation
      if (activeRefresh !== undefined) await activeRefresh.catch(() => undefined);
      const result = await this.runner(commands.run, updateTimeoutMs).catch((error): AgentUpdateCommandResult => ({ code: -1, output: exceptionOutput(error), failure: 'launch_failed' }));
      // do not claim an update when the command failed
      if (result.code !== 0) return await this.failedUpdate(kind, result);
      this.cache.delete(kind);
      return { outcome: 'updated', status: await this.status(kind, true) };
    } finally {
      this.updating = undefined;
    }
  }

  // retain bounded private evidence while exposing only categorical failure details
  private async failedUpdate(kind: AgentKind, result: AgentUpdateCommandResult): Promise<Extract<AgentUpdateResult, { outcome: 'failed' }>> {
    const code = Number.isInteger(result.code) && result.code > 0 && result.code <= 255 ? result.code : undefined;
    const reason = result.failure ?? (code === undefined ? 'interrupted' : 'command_failed');
    const name = kind === 'omx' ? 'OMX' : kind === 'codex' ? 'Codex' : kind;
    const details: Record<AgentUpdateFailureReason, string> = {
      command_failed: `with exit code ${code ?? 'unknown'}`,
      launch_failed: 'because the update command could not start',
      timed_out: 'because the update command timed out',
      bridge_unavailable: 'because the host update bridge is unavailable',
      invalid_completion: 'because the update command returned an invalid completion status',
      interrupted: 'because the update command stopped before reporting completion'
    };
    const error = `${name} update failed ${details[reason]}.`;
    try {
      const report = await saveAgentUpdateFailure(this.checkout, { kind, code: result.code, output: result.output, reason });
      return { outcome: 'failed', error: `${error} Private diagnostics: ${report}.` };
    } catch {
      return { outcome: 'failed', error: `${error} Private diagnostics could not be saved.` };
    }
  }

  // settle only the job that still owns this kind
  private settleJob(started: AgentUpdateJob, terminal: AgentUpdateJob): void {
    // prevent an older completion from replacing a newer job
    if (this.jobs.get(started.kind)?.id !== started.id) return;
    this.jobs.set(started.kind, terminal);
  }

  // resolve one cached version comparison
  private async status(kind: AgentKind, force = false): Promise<AgentUpdateStatus> {
    const cached = this.cache.get(kind);
    // serve a fresh cached comparison
    if (!force && cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
    const active = this.refreshes.get(kind);
    // coalesce concurrent checks
    if (active !== undefined) return await active;
    const refresh = this.refresh(kind).finally(() => { this.refreshes.delete(kind); });
    this.refreshes.set(kind, refresh);
    return await refresh;
  }

  // run and compare the configured current and upstream version commands
  private async refresh(kind: AgentKind): Promise<AgentUpdateStatus> {
    const commands = this.config.adapters?.[kind]?.updates;
    // retain a safe fallback for a configuration change during runtime
    if (commands === undefined) return { kind, updateAvailable: false, error: 'Version check unavailable' };
    const [current, latest] = await Promise.all([
      this.runner(commands.current, statusTimeoutMs).catch(() => ({ code: -1, output: '' })),
      this.runner(commands.latest, statusTimeoutMs).catch(() => ({ code: -1, output: '' }))
    ]);
    const currentVersion = current.code === 0 ? normalizedVersion(current.output) : undefined;
    const latestVersion = latest.code === 0 ? normalizedVersion(latest.output) : undefined;
    const updateAvailable = currentVersion === undefined || latestVersion === undefined ? undefined : semanticUpdateAvailable(currentVersion, latestVersion);
    const failed = updateAvailable === undefined;
    const status: AgentUpdateStatus = failed
      ? { kind, updateAvailable: false, error: 'Version check failed' }
      : { kind, currentVersion, latestVersion, updateAvailable };
    this.cache.set(kind, { status, expiresAt: Date.now() + (failed ? failedCacheTtlMs : cacheTtlMs) });
    return status;
  }

  // execute a trusted command locally or through the host tmux bridge
  private async runConfigured(command: string, timeoutMs: number): Promise<AgentUpdateCommandResult> {
    const path = process.env.RAC_HOST_PATH?.trim();
    const prefix = `export HOME=${quote(this.home)}; ${path ? `export PATH=${quote(path)}; ` : ''}cd -- ${quote(this.home)}; `;
    // use the local shell for direct deployments
    if (this.socket === undefined) {
      const result = await run('/bin/bash', ['-lc', `${prefix}{ ${command}; }`], undefined, timeoutMs);
      return { code: result.code, output: `${result.stdout}${result.stderr}`, ...(result.timedOut ? { failure: 'timed_out' as const } : {}) };
    }
    // a bridged command needs a shared checkout for completion files
    if (this.hostCheckout === undefined) return { code: -1, output: 'Shared host checkout unavailable.', failure: 'bridge_unavailable' };
    const token = randomBytes(12).toString('hex');
    const session = `rac-agent-update-${token}`;
    const localBase = join(this.checkout, '.data', 'agent-updates', token);
    const hostBase = join(this.hostCheckout, '.data', 'agent-updates', token);
    const outputFile = `${localBase}.out`;
    const statusFile = `${localBase}.status`;
    const temporaryStatusFile = `${localBase}.status.tmp`;
    await mkdir(dirname(localBase), { recursive: true, mode: 0o700 });
    const script = `umask 077; ${prefix}{ ${command}; } > ${quote(`${hostBase}.out`)} 2>&1; code=$?; printf '%s' "$code" > ${quote(`${hostBase}.status.tmp`)}; mv -- ${quote(`${hostBase}.status.tmp`)} ${quote(`${hostBase}.status`)}`;
    try {
      const launched = await run(this.tmuxBinary, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', this.home, '/bin/bash', '-lc', script]);
      // fail when the host tmux rejects the command
      if (launched.code !== 0) return { code: launched.code, output: `${launched.stdout}${launched.stderr}`, failure: 'launch_failed' };
      const deadline = Date.now() + timeoutMs;
      // wait for the atomic completion marker
      while (Date.now() < deadline) {
        const status = await readFile(statusFile, 'utf8').catch(() => undefined);
        // return only after output has closed
        if (status !== undefined) {
          const code = /^(?:0|[1-9]\d{0,2})$/u.test(status.trim()) ? Number(status.trim()) : -1;
          // refuse malformed markers instead of guessing a successful completion
          if (code < 0 || code > 255) return { code: -1, output: await readOutput(outputFile), failure: 'invalid_completion' };
          return { code, output: await readOutput(outputFile) };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { code: -1, output: await readOutput(outputFile), failure: 'timed_out' };
    } finally {
      // stop writers before removing shared completion files
      await run(this.tmuxBinary, ['-S', this.socket, 'kill-session', '-t', `=${session}`]).catch(() => undefined);
      await Promise.all([
        unlink(outputFile).catch(() => {}),
        unlink(statusFile).catch(() => {}),
        unlink(temporaryStatusFile).catch(() => {})
      ]);
    }
  }
}

// keep rejected command details inside owner-only diagnostics
function exceptionOutput(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
