import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { gt, valid } from 'semver';
import type { AgentKind } from '../adapters/types.js';
import { agentKinds } from '../adapters/types.js';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { ValidatedConfig } from '../config/schema.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { saveAgentUpdateFailure, type AgentUpdateFailure, type AgentUpdateFailureReason } from './diagnostics.js';
import { AgentUpdateInstaller, type InstallerResult } from './installer.js';
import { AgentUpdateJobStore, type AgentUpdateJob, type AgentUpdateJobRecord, type TerminalAgentUpdateRecord } from './job-store.js';

import { runConfiguredAgentProbe } from './probes.js';

export type { AgentUpdateJob } from './job-store.js';

// allow registry latency while keeping version checks bounded
const statusTimeoutMs = 30_000;
// large agent downloads can exceed five minutes; keep the browser wait above this budget
const updateTimeoutMs = 15 * 60_000;
const preflightDeadlineMs = 45_000;
// leave time for the host timeout to stop the installer and publish its receipt
const receiptGraceMs = 15_000;
// reserve a bounded handoff window without extending the host installer ceiling
const handoffGraceMs = 10_000;
const jobPollMs = 250;
const cacheTtlMs = 15 * 60_000;
const failedCacheTtlMs = 60_000;
// a `pinned` kind's current version is the console's pin: it updates only with the console, never by a Run
export type AgentUpdateStatus = { kind: AgentKind; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string; pinned?: true };
// the version an npm package's registry publishes as latest
export type PublishedVersion = (name: string) => Promise<string | undefined>;
const npmLatest: PublishedVersion = async name => {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(statusTimeoutMs) });
  const version = response.ok ? (await response.json() as { version?: unknown }).version : undefined;
  return typeof version === 'string' ? normalizedVersion(version) : undefined;
};
type AgentUpdateResult = { outcome: 'updated'; status: AgentUpdateStatus } | { outcome: 'unavailable' } | { outcome: 'busy' } | { outcome: 'failed'; error?: string; status?: AgentUpdateStatus };
export type AgentUpdateStart = { outcome: 'started'; job: AgentUpdateJob } | { outcome: 'unavailable' } | { outcome: 'busy' } | { outcome: 'failed'; error: string };
type AgentUpdateCommandResult = InstallerResult;
export type AgentUpdateRunner = (command: string, timeoutMs: number) => Promise<AgentUpdateCommandResult>;
export type AgentUpdateServiceLike = Pick<AgentUpdateService, 'statuses' | 'update'> & {
  startUpdate(kind: AgentKind): AgentUpdateStart | Promise<AgentUpdateStart>;
  updateStatus(kind: AgentKind, id: string): AgentUpdateJob | undefined | Promise<AgentUpdateJob | undefined>;
};
type RunningJob = Extract<AgentUpdateJobRecord, { state: 'running' }>;
type InstallingJob = Extract<RunningJob, { phase: 'install' }>;
type TerminalJob = Exclude<AgentUpdateJob, { state: 'running' }>;
type Installer = Pick<AgentUpdateInstaller, 'prepareLock' | 'launch' | 'observe' | 'cleanup' | 'isIdle'>;
const unavailableStatus = 'Agent update status is unavailable. Check the installed version before retrying.';

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

// accept only verifiable command output for an installed or published version
function commandVersion(result: AgentUpdateCommandResult): string | undefined {
  const version = result.code === 0 && result.failure === undefined ? normalizedVersion(result.output) : undefined;
  return version !== undefined && valid(version) !== null ? version : undefined;
}

// expose the job itself without its host authority or internal deadlines
function publicJob(record: AgentUpdateJobRecord): AgentUpdateJob {
  const { id, kind, state } = record;
  // attach verified version evidence to both complete and partial results
  if (state === 'complete') return { id, kind, state, agent: record.agent };
  // expose only the service-built failure message and safe version fields
  if (state === 'failed') return { id, kind, state, error: record.error, ...(record.agent === undefined ? {} : { agent: record.agent }) };
  return { id, kind, state };
}

export class AgentUpdateService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  // use the same path for installation and verification
  private readonly commandPath = process.env.RAC_HOST_PATH?.trim() || (this.socket === undefined ? process.env.PATH : undefined);
  private readonly checkout: string;
  private readonly hostCheckout: string | undefined;
  private readonly runner: AgentUpdateRunner;
  private readonly cache = new Map<AgentKind, { status: AgentUpdateStatus; expiresAt: number }>();
  private readonly refreshes = new Map<AgentKind, Promise<AgentUpdateStatus>>();
  private readonly store: AgentUpdateJobStore;
  private readonly installer: Installer;
  private readonly monitors = new Map<string, Promise<TerminalJob | undefined>>();
  private readonly latestTerminal = new Map<AgentKind, TerminalAgentUpdateRecord>();
  private failedMonitorId: string | undefined;
  private recoveryScanUnavailable = false;

  // bind update commands to the launch account and host bridge
  constructor(private readonly config: ValidatedConfig, private readonly home: string | undefined, runner?: AgentUpdateRunner, checkout: string = serverCheckout(), private readonly published: PublishedVersion = npmLatest, installer?: Installer) {
    this.checkout = checkout;
    // prefer the update repository while preserving legacy workspace overrides
    this.hostCheckout = serverCheckoutOnHost(config.projects, process.env.RAC_HOST_REPOSITORY?.trim() || process.env.RAC_HOST_WORKSPACE, checkout);
    const location = { checkout, hostCheckout: this.hostCheckout, home: home ?? '', socket: this.socket, tmuxBinary: this.tmuxBinary, path: this.commandPath };
    this.runner = runner ?? ((command, timeoutMs) => runConfiguredAgentProbe(location, command, timeoutMs));
    this.store = new AgentUpdateJobStore(checkout);
    this.installer = installer ?? (runner === undefined
      ? new AgentUpdateInstaller(location)
      // a supplied in-process test runner owns its invocation and terminal outcome
      : {
          // a rejected in-process runner cannot leave a detached installer behind
          launch: async (_id, command, timeoutMs) => ({
            ...await runner(command, timeoutMs).catch((error): AgentUpdateCommandResult => ({ code: -1, output: exceptionOutput(error), failure: 'launch_failed' })),
            confirmed: true
          }),
          prepareLock: async () => '1:1', observe: async () => undefined, cleanup: async () => {}, isIdle: async () => true
        });
  }

  // publish every configured update-capable or pinned agent in registry order
  async statuses(refresh = false): Promise<AgentUpdateStatus[]> {
    const kinds = agentKinds.filter(kind => this.config.adapters?.[kind]?.updates !== undefined || this.config.adapters?.[kind] !== undefined && structuredAdapterFor(kind)?.pinned() !== undefined);
    try {
      const { active, terminal } = await this.store.snapshot();
      this.recoveryScanUnavailable = false;
      // discover results from other controllers before serving cached versions
      for (const record of terminal) this.acceptTerminal(record);
      // leave an existing host installer in charge of its own execution
      if (active !== undefined) this.monitor(active, false);
    } catch {
      // fail closed before ordinary probes can use rejected storage
      if (!this.recoveryScanUnavailable) console.warn('Agent update recovery state is unavailable.');
      this.recoveryScanUnavailable = true;
      return await Promise.all(kinds.map(async kind => {
        // pinned registry reads do not create host command artifacts
        if (structuredAdapterFor(kind)?.pinned() !== undefined) return await this.status(kind, refresh);
        this.invalidateVersions(kind);
        return { kind, updateAvailable: false, error: 'Version check unavailable' };
      }));
    }
    return await Promise.all(kinds.map(kind => this.status(kind, refresh)));
  }

  // admit a single durable update before any command can mutate the host
  async startUpdate(kind: AgentKind): Promise<AgentUpdateStart> {
    return await this.admitUpdate(kind, true);
  }

  // allow asynchronous clients to reuse the active job without replaying it
  private async admitUpdate(kind: AgentKind, joinExisting: boolean): Promise<AgentUpdateStart> {
    const authority = this.updateAuthority(kind);
    // refuse unconfigured and pinned adapters
    if (authority === undefined) return { outcome: 'unavailable' };
    try {
      const { job, created } = await this.store.withLock(async () => {
        const active = await this.store.active();
        // reuse a running operation instead of wrapping another installer
        if (active?.state === 'running') return { job: active, created: false };
        const startedAt = Date.now();
        const job: RunningJob = { version: 1, id: randomBytes(12).toString('hex'), kind, state: 'running', phase: 'preflight', authority, startedAt, deadline: startedAt + preflightDeadlineMs };
        await this.store.write(job);
        return { job, created: true };
      });
      this.monitor(job, created);
      // serialize every configured installer that shares the installation
      return job.kind === kind && (created || joinExisting) ? { outcome: 'started', job: publicJob(job) } : { outcome: 'busy' };
    } catch {
      return { outcome: 'failed', error: unavailableStatus };
    }
  }

  // read and resume only the exact requested job
  async updateStatus(kind: AgentKind, id: string): Promise<AgentUpdateJob | undefined> {
    // reject unrecognized identifiers before touching the job directory
    if (!/^[a-f0-9]{24}$/u.test(id)) return undefined;
    const job = await this.store.read(id);
    // hide missing and cross-kind identifiers
    if (job === undefined || job.kind !== kind) return undefined;
    // observe existing work without launching it again
    if (job.state === 'running') {
      this.monitor(job, false);
      // report an unhealthy observer rather than presenting uncertain state as healthy progress
      if (this.failedMonitorId === job.id) throw new Error(unavailableStatus);
      return publicJob(job);
    }
    return this.acceptTerminal(job);
  }

  // preserve the synchronous API over the same durable operation
  async update(kind: AgentKind): Promise<AgentUpdateResult> {
    const started = await this.admitUpdate(kind, false);
    // preserve unavailable and busy replies
    if (started.outcome !== 'started') return started;
    try {
      const job = await (this.monitors.get(started.job.id) ?? this.updateStatus(kind, started.job.id));
      // require a verified terminal result
      if (job?.state === 'complete') return { outcome: 'updated', status: job.agent };
      // retain observed versions even when setup fails
      if (job?.state === 'failed') return { outcome: 'failed', error: job.error, status: job.agent };
    } catch {
      // avoid publishing storage or installer details
    }
    return { outcome: 'failed', error: unavailableStatus };
  }

  // bind recovery probes to the same configured commands and launch account
  private updateAuthority(kind: AgentKind): string | undefined {
    const commands = this.config.adapters?.[kind]?.updates;
    // never update a pinned adapter or guess a launch account
    if (commands === undefined || this.home === undefined || structuredAdapterFor(kind)?.pinned() !== undefined) return undefined;
    return createHash('sha256').update(JSON.stringify([this.home, this.hostCheckout, this.socket, this.commandPath, commands.current, commands.latest, commands.run])).digest('hex');
  }

  // share the local observer while its durable record remains authoritative
  private monitor(job: RunningJob, ownsPreflight: boolean): void {
    // never let a watcher claim the slot before the admitting process starts preflight
    if (job.phase === 'preflight' && !ownsPreflight && Date.now() < job.deadline) return;
    // coalesce browser polls and startup reconciliation
    if (this.monitors.has(job.id)) return;
    const pending = this.drive(job, ownsPreflight).catch(error => this.recordMonitorFailure(job, error)).finally(() => { this.monitors.delete(job.id); });
    this.monitors.set(job.id, pending);
  }

  // retain an unexpected observer failure without releasing or replaying a possible installer
  private async recordMonitorFailure(job: RunningJob, error: unknown): Promise<TerminalJob | undefined> {
    const current = await this.store.read(job.id).catch(() => job);
    // another observer may already have settled the operation
    if (current !== undefined && current.state !== 'running') return this.acceptTerminal(current);
    // keep one warning per active job until durable status recovers
    if (this.failedMonitorId === job.id) return undefined;
    this.failedMonitorId = job.id;
    const active = current ?? job;
    await saveAgentUpdateFailure(this.checkout, {
      kind: job.kind, jobId: job.id, phase: active.phase, reason: 'interrupted', code: -1,
      elapsedMs: Math.max(0, Date.now() - job.startedAt), output: exceptionOutput(error),
      ...(active.phase === 'install' ? { previousVersion: active.previousVersion, targetVersion: active.targetVersion } : {})
    }).catch(() => { console.warn('Agent update observer failed and private diagnostics could not be saved.'); });
    return undefined;
  }

  // perform preflight only from the admission owner; recover later stages by observation
  private async drive(job: RunningJob, ownsPreflight: boolean): Promise<TerminalJob | undefined> {
    // only the admitting process may hand the installer to the host
    if (job.phase === 'preflight' && ownsPreflight) return await this.prepare(job);
    // follow the preflight owner's durable transition or expire a lost admission
    while (job.phase === 'preflight') {
      // allow the original version checks to finish without launching replacements
      if (Date.now() >= job.deadline) {
        return await this.finish(job, undefined, { phase: 'preflight', reason: 'interrupted', code: -1, output: 'Preflight did not hand off an installer.' });
      }
      await wait(jobPollMs, undefined, { ref: false });
      const current = await this.store.read(job.id);
      // respect terminal state written by another observer
      if (current?.state !== 'running') return current === undefined ? undefined : this.acceptTerminal(current);
      job = current;
    }
    return await this.followInstaller(job);
  }

  // capture and persist the exact target before authorizing an installer
  private async prepare(job: Extract<RunningJob, { phase: 'preflight' }>): Promise<TerminalJob | undefined> {
    const commands = this.config.adapters?.[job.kind]?.updates;
    // recheck the authorized configuration before running anything
    if (commands === undefined || this.updateAuthority(job.kind) !== job.authority) {
      return await this.finish(job, undefined, { phase: 'preflight', reason: 'version_check_failed', code: -1, output: 'The configured updater changed before preflight.' });
    }
    const [currentProbe, targetProbe] = await Promise.all([this.probe(commands.current), this.probe(commands.latest)]);
    const previousVersion = commandVersion(currentProbe);
    const targetVersion = commandVersion(targetProbe);
    // fail closed while recording which preflight evidence was missing
    if (previousVersion === undefined || targetVersion === undefined) {
      this.invalidateVersions(job.kind);
      const failedProbe = previousVersion === undefined ? currentProbe : targetProbe;
      return await this.finish(job, undefined, {
        phase: 'preflight', reason: 'version_check_failed', code: failedProbe.code, probeFailure: failedProbe.failure,
        previousVersion, targetVersion, output: `installed probe (exit ${currentProbe.code}): ${currentProbe.output}
registry probe (exit ${targetProbe.code}): ${targetProbe.output}`
      });
    }
    const updateAvailable = semanticUpdateAvailable(previousVersion, targetVersion) === true;
    const status = { kind: job.kind, currentVersion: previousVersion, latestVersion: targetVersion, updateAvailable };
    // keep equal and newer installations unchanged
    if (!updateAvailable) {
      return await this.finish(job, status);
    }
    const install = await this.store.withLock(async (): Promise<InstallingJob | undefined> => {
      const current = await this.store.read(job.id);
      // prevent an expired or superseded admission from launching
      if (current?.state !== 'running' || current.phase !== 'preflight' || Date.now() >= current.deadline) return undefined;
      // establish immutable host lock continuity before recording possible handoff
      const installerLock = await this.installer.prepareLock();
      // do not extend an expired preflight while preparing private storage
      if (Date.now() >= current.deadline) return undefined;
      const record: InstallingJob = { ...current, installerLock, phase: 'install', previousVersion, targetVersion, deadline: Date.now() + updateTimeoutMs + handoffGraceMs + receiptGraceMs };
      await this.store.write(record);
      return record;
    });
    // never replay a launch after losing admission
    if (install === undefined) return await this.drive(job, false);
    const executionDeadline = install.deadline - receiptGraceMs;
    // never authorize mutation when the durable execution window has already expired
    if (Date.now() >= executionDeadline) return await this.followInstaller(install, { code: -1, output: 'Execution window expired before handoff.', failure: 'interrupted', confirmed: true });
    // the host checks this same cutoff under its shared lock before executing
    const immediate = await this.installer.launch(job.id, commands.run, updateTimeoutMs, executionDeadline, install.installerLock).catch((error): InstallerResult => ({ code: -1, output: exceptionOutput(error), failure: 'launch_failed' }));
    return await this.followInstaller(install, immediate);
  }

  // wait for the host-owned receipt rather than tying installer lifetime to the web process
  private async followInstaller(job: InstallingJob, immediate?: InstallerResult): Promise<TerminalJob | undefined> {
    let observationError: string | undefined;
    // keep transient read failures private without treating them as a terminal receipt
    const observe = async () => {
      try {
        const receipt = await this.installer.observe(job.id);
        observationError = undefined;
        return receipt;
      } catch (error) {
        observationError = exceptionOutput(error);
        return undefined;
      }
    };
    let result = immediate ?? await observe();
    // allow a detached installer to finish under its own deadline
    while (result?.confirmed !== true && Date.now() < job.deadline) {
      await wait(jobPollMs, undefined, { ref: false });
      const current = await this.store.read(job.id);
      // stop if another console already reconciled this job
      if (current?.state !== 'running') return current === undefined ? undefined : this.acceptTerminal(current);
      result = await observe() ?? result;
    }
    // a missing or corrupt receipt is not proof that the host stopped mutating
    if (result?.confirmed !== true && !await this.installer.isIdle(job.installerLock)) throw new Error('Host installer idleness could not be confirmed after the observation deadline.');
    const outcome: InstallerResult = result ?? {
      code: -1, output: observationError ?? 'No durable installer receipt before the observation deadline.',
      failure: observationError === undefined ? 'interrupted' : 'invalid_completion'
    };
    return await this.verify(job, outcome);
  }

  // attest the installed binary after every installer outcome against the original target
  private async verify(job: InstallingJob, result: InstallerResult): Promise<TerminalJob | undefined> {
    const commands = this.config.adapters?.[job.kind]?.updates;
    const probe = commands !== undefined && this.updateAuthority(job.kind) === job.authority ? await this.probe(commands.current) : undefined;
    const observedVersion = probe === undefined ? undefined : commandVersion(probe);
    const status = observedVersion === undefined ? undefined : {
      kind: job.kind, currentVersion: observedVersion, latestVersion: job.targetVersion,
      updateAvailable: semanticUpdateAvailable(observedVersion, job.targetVersion) === true
    };
    const successfulExit = result.confirmed === true && result.code === 0 && result.failure === undefined;
    // a successful exit requires both a trustworthy receipt and target evidence
    if (successfulExit && status?.updateAvailable === false) return await this.finish(job, status, undefined, true);
    const installerFailure = successfulExit ? undefined : result.failure ?? (result.code > 0 ? 'command_failed' : 'interrupted');
    // distinguish known command failure from uncertainty about the installer outcome
    const completionUnknown = result.confirmed !== true || installerFailure === 'invalid_completion';
    let reason: AgentUpdateFailureReason = installerFailure ?? 'interrupted';
    // distinguish a verification failure after a proven zero exit
    if (successfulExit) reason = status === undefined ? 'verification_failed' : 'target_not_installed';
    // never describe an ambiguous completion as setup failure
    else if (completionUnknown) reason = status?.updateAvailable === false ? 'installed_completion_unconfirmed' : installerFailure === 'invalid_completion' ? 'invalid_completion' : 'interrupted';
    // a known command or supervisor failure may still have installed the target
    else if (status?.updateAvailable === false && (installerFailure === 'command_failed' || installerFailure === 'timed_out')) reason = 'installed_setup_failed';
    const verificationOutput = probe === undefined ? 'The configured updater changed before verification.' : `installed probe (exit ${probe.code}): ${probe.output}`;
    return await this.finish(job, status, {
      phase: successfulExit ? 'verification' : 'install', reason, installerFailure, probeFailure: probe?.failure, code: result.code,
      previousVersion: job.previousVersion, targetVersion: job.targetVersion, observedVersion,
      output: `installer output:
${result.output}
verification:
${verificationOutput}`
    }, result.confirmed === true);
  }

  // publish one terminal state after checking that this observer still owns the result
  private async finish(job: RunningJob, status: AgentUpdateStatus | undefined, failure?: Omit<AgentUpdateFailure, 'kind' | 'jobId' | 'elapsedMs'>, cleanupEligible = false): Promise<TerminalJob | undefined> {
    const settled = await this.store.withLock(async () => {
      const current = await this.store.read(job.id);
      // reject stale stage transitions from another observer
      if (current?.state !== 'running' || current.phase !== job.phase) return current;
      const finishedAt = Math.max(Date.now(), job.startedAt);
      const terminal: TerminalJob = failure === undefined && status !== undefined
        ? { id: job.id, kind: job.kind, state: 'complete', agent: status }
        : {
            id: job.id, kind: job.kind, state: 'failed',
            error: failure === undefined ? unavailableStatus : await this.failureMessage({ ...failure, kind: job.kind, jobId: job.id, elapsedMs: finishedAt - job.startedAt }),
            ...(status === undefined ? {} : { agent: status })
          };
      const record = { ...terminal, version: 1 as const, authority: job.authority, startedAt: job.startedAt, finishedAt, ...(cleanupEligible ? { cleanupEligible: true as const } : {}) };
      await this.store.write(record);
      return record;
    });
    // leave a newer running stage for its own monitor
    if (settled === undefined || settled.state === 'running') return undefined;
    // reconcile the winner's evidence rather than publishing a losing observation
    const terminal = this.acceptTerminal(settled, false);
    await this.cleanupTerminal(settled).catch(() => { console.warn('Agent update artifact cleanup remains pending.'); });
    void this.store.prune(settled.id, record => this.cleanupTerminal(record, true)).catch(() => { console.warn('Agent update history cleanup remains pending.'); });
    return terminal;
  }

  // accept terminal records across controllers without overwriting fresher live versions
  private acceptTerminal(record: TerminalAgentUpdateRecord, scheduleCleanup = true): TerminalJob {
    const latest = this.latestTerminal.get(record.kind);
    // invalidate older comparisons once per newly discovered terminal transition
    if (latest === undefined || record.finishedAt > latest.finishedAt || record.finishedAt === latest.finishedAt && (record.startedAt > latest.startedAt || record.startedAt === latest.startedAt && record.id > latest.id)) {
      this.latestTerminal.set(record.kind, record);
      this.invalidateVersions(record.kind);
    }
    // clear temporary observer errors only after reading a durable result
    if (this.failedMonitorId === record.id) this.failedMonitorId = undefined;
    // reconcile historical terminal records after a controller restart
    if (scheduleCleanup) void this.cleanupTerminal(record).catch(() => { console.warn('Agent update artifact cleanup remains pending.'); });
    return publicJob(record) as TerminalJob;
  }

  // reclaim only exact artifacts with durable evidence that the publisher finished
  private async cleanupTerminal(record: TerminalAgentUpdateRecord, lockHeld = false): Promise<void> {
    // previously confirmed receipts remain safe to reclaim after a crash mid-cleanup
    if (record.cleanupEligible !== true) {
      // a late receipt can turn an uncertain terminal observation into cleanup proof
      const receipt = await this.installer.observe(record.id);
      // preserve every artifact whose writer has not reported completion
      if (receipt?.confirmed !== true) return;
      const retainProof = async () => {
        const current = await this.store.read(record.id);
        // never mark a pruned or newly active record eligible for cleanup
        if (current === undefined || current.state === 'running') return false;
        // persist proof before deleting even the last remaining receipt
        if (current.cleanupEligible !== true) await this.store.write({ ...current, cleanupEligible: true });
        return true;
      };
      // history pruning already owns the same admission lock
      const eligible = lockHeld ? await retainProof() : await this.store.withLock(retainProof);
      // leave artifacts untouched if durable eligibility was lost
      if (!eligible) return;
    }
    await this.installer.cleanup(record.id);
  }

  // retain raw output privately while giving the UI an actionable stage
  private async failureMessage(failure: AgentUpdateFailure): Promise<string> {
    const { kind, code, reason, observedVersion, targetVersion } = failure;
    const name = kind === 'omx' ? 'OMX' : kind === 'codex' ? 'Codex' : kind;
    const messages: Record<AgentUpdateFailureReason, string> = {
      command_failed: `${name} update failed with exit code ${code}.`,
      launch_failed: `${name} update command could not start.`,
      timed_out: `${name} update command timed out.`,
      bridge_unavailable: `${name} host update bridge is unavailable.`,
      invalid_completion: `${name} update returned an invalid completion status.`,
      interrupted: `${name} update stopped before reporting completion.`,
      installer_busy: 'An agent installer already holds the host update lock.',
      installed_completion_unconfirmed: `${name} is now at ${observedVersion}, but installer completion could not be confirmed. Check diagnostics before retrying.`,
      installed_setup_failed: `${name} is now at ${observedVersion}, but the installer did not complete successfully. Check diagnostics before retrying.`,
      version_check_failed: `${name} update did not start because versions could not be verified.`,
      verification_failed: `${name} installer exited successfully, but the installed version could not be verified.`,
      target_not_installed: `${name} installer exited successfully, but version ${observedVersion} does not meet the target ${targetVersion}.`
    };
    const error = messages[reason];
    try {
      const report = await saveAgentUpdateFailure(this.checkout, failure);
      return `${error} Private diagnostics: ${report}.`;
    } catch {
      return `${error} Private diagnostics could not be saved.`;
    }
  }

  // keep rejected version checks available to private diagnostics
  private async probe(command: string): Promise<AgentUpdateCommandResult> {
    return await this.runner(command, statusTimeoutMs).catch((error): AgentUpdateCommandResult => ({ code: -1, output: exceptionOutput(error), failure: 'launch_failed' }));
  }

  // disown any pending read that predates the mutation
  private invalidateVersions(kind: AgentKind): void {
    this.cache.delete(kind);
    this.refreshes.delete(kind);
  }

  // resolve one cached or explicitly refreshed version comparison
  private async status(kind: AgentKind, refreshRequested = false): Promise<AgentUpdateStatus> {
    const active = this.refreshes.get(kind);
    // coalesce concurrent checks
    if (active !== undefined) return await active;
    const cached = this.cache.get(kind);
    // bypass only a completed cache entry for an explicit refresh
    if (!refreshRequested && cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
    const refresh = this.refresh(kind).then(status => {
      // an older version read must not be returned after terminal evidence invalidated it
      if (this.refreshes.get(kind) !== refresh) return this.status(kind);
      this.cached(kind, status);
      return status;
    }).finally(() => {
      // release only the slot held by this read
      if (this.refreshes.get(kind) === refresh) this.refreshes.delete(kind);
    });
    this.refreshes.set(kind, refresh);
    return await refresh;
  }

  // run and compare the configured current and upstream version commands
  private async refresh(kind: AgentKind): Promise<AgentUpdateStatus> {
    const pin = structuredAdapterFor(kind)?.pinned();
    if (pin !== undefined) return await this.pinnedStatus(kind, pin);
    const commands = this.config.adapters?.[kind]?.updates;
    // retain a safe fallback for a configuration change during runtime
    if (commands === undefined || this.home === undefined) return { kind, updateAvailable: false, error: 'Version check unavailable' };
    const [current, latest] = await Promise.all([
      this.probe(commands.current),
      this.probe(commands.latest)
    ]);
    const currentVersion = commandVersion(current);
    const latestVersion = commandVersion(latest);
    const updateAvailable = currentVersion === undefined || latestVersion === undefined ? undefined : semanticUpdateAvailable(currentVersion, latestVersion);
    const failed = updateAvailable === undefined;
    return failed ? { kind, updateAvailable: false, error: 'Version check failed' } : { kind, currentVersion, latestVersion, updateAvailable };
  }

  // a pinned kind: its pin against the version its package's registry publishes
  private async pinnedStatus(kind: AgentKind, pin: { package: string; version: string }): Promise<AgentUpdateStatus> {
    const latestVersion = await this.published(pin.package).catch(() => undefined);
    const updateAvailable = latestVersion === undefined ? undefined : semanticUpdateAvailable(pin.version, latestVersion);
    return updateAvailable === undefined ? { kind, currentVersion: pin.version, updateAvailable: false, error: 'Version check failed', pinned: true } : { kind, currentVersion: pin.version, latestVersion, updateAvailable, pinned: true };
  }

  // keep a comparison, a failed one for less time
  private cached(kind: AgentKind, status: AgentUpdateStatus): AgentUpdateStatus {
    this.cache.set(kind, { status, expiresAt: Date.now() + (status.error === undefined ? cacheTtlMs : failedCacheTtlMs) });
    return status;
  }

}

// keep rejected command details inside owner-only diagnostics
function exceptionOutput(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
