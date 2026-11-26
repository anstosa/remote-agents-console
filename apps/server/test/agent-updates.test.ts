import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUpdateService, normalizedVersion, type AgentUpdateRunner } from '../src/agent-updates/service.js';
import { AgentUpdateJobStore, type AgentUpdateJobRecord } from '../src/agent-updates/job-store.js';
import type { InstallerResult } from '../src/agent-updates/installer.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import * as command from '../src/tmux/command.js';
import * as diagnostics from '../src/agent-updates/diagnostics.js';

// build one minimal update-capable configuration
const configured = (): ValidatedConfig => ({
  name: 'Remote Agents',
  remoteServers: [],
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(['127.0.0.1']),
  pollIntervalMs: 500,
  newAgentCommand: 'codex',
  projects: [],
  adapters: {
    codex: { program: '/bin/codex', args: [], env: {}, launchable: true, updates: { current: 'current', latest: 'latest', run: 'update' } },
    omx: { program: '/bin/omx', args: [], env: {}, launchable: true }
  }
});

// allow durable writes and lock handshakes to finish on slower filesystems
const waitForJob = <T>(callback: () => T | Promise<T>) => vi.waitFor(callback, { timeout: 10_000 });

describe('agent updates', () => {
  let testCheckout: string;
  // keep durable jobs and diagnostics isolated from the running installation
  beforeEach(async () => {
    testCheckout = await mkdtemp(join(tmpdir(), 'rac-agent-update-test-'));
    vi.spyOn(diagnostics, 'saveAgentUpdateFailure').mockResolvedValue('.data/agent-updates/codex-test.json');
  });
  // restore host settings and command spies between cases
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(testCheckout, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });

  // cover compose host paths and the legacy workspace override
  it.each([
    { repository: '/host/console', workspace: undefined, expected: '/host/console' },
    { repository: '/host/console', workspace: '/host/legacy', expected: '/host/console' },
    { repository: undefined, workspace: '/host/legacy', expected: '/host/legacy' }
  ])('checks versions through the host checkout $expected', async ({ repository, workspace, expected }) => {
    const checkout = testCheckout;
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_TMUX_BIN', '/host-tools/tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', repository);
    vi.stubEnv('RAC_HOST_WORKSPACE', workspace);
    // publish completion files without starting a real host session
    const run = vi.spyOn(command, 'run').mockImplementation(async (binary, args) => {
      expect(binary).toBe('/host-tools/tmux');
      // complete only the synthetic version commands
      if (args.includes('new-session')) {
        const session = args[args.indexOf('-s') + 1]!;
        const token = session.replace('rac-agent-update-', '');
        const script = args.at(-1)!;
        expect(args.slice(0, 2)).toEqual(['-S', '/host-tmux/default']);
        expect(script).toContain(`'${expected}/.data/agent-updates/${token}.out'`);
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.out`), script.includes('{ current; }') ? '1.0.0\n' : '1.1.0\n', { mode: 0o600 });
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.status`), '{"version":1,"code":0}', { mode: 0o600 });
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', undefined, checkout);
    await expect(service.statuses()).resolves.toEqual([{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await readdir(join(checkout, '.data', 'agent-updates'))).toEqual([]);

  });

  // classify terminal host receipts without exposing private installer output
  it.each([
    { scenario: 'launch', receipt: '{"version":1,"code":-1,"failure":"launch_failed"}', reason: 'launch_failed' },
    { scenario: 'command', receipt: '{"version":1,"code":17}', reason: 'command_failed' },
    { scenario: 'invalid marker', receipt: '0invalid', reason: 'invalid_completion' },
    { scenario: 'timeout', receipt: '{"version":1,"code":-1,"failure":"timed_out"}', reason: 'timed_out' }
  ] as const)('saves a safe diagnostic for a bridge $scenario failure', async ({ scenario, receipt, reason }) => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_TMUX_BIN', '/host-tools/tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/console');
    vi.spyOn(command, 'run').mockImplementation(async (_binary, args) => {
      // leave version-probe cleanup requests harmless
      if (!args.includes('new-session')) return { code: 0, stdout: '', stderr: '' };
      const session = args[args.indexOf('-s') + 1]!;
      // complete the read-only probes separately from the durable installer
      if (session.startsWith('rac-agent-update-')) {
        const token = session.replace('rac-agent-update-', '');
        await writeFile(join(testCheckout, '.data', 'agent-updates', `${token}.out`), args.at(-1)!.includes('{ current; }') ? '1.0.0' : '1.1.0', { mode: 0o600 });
        await writeFile(join(testCheckout, '.data', 'agent-updates', `${token}.status`), '{"version":1,"code":0}', { mode: 0o600 });
        return { code: 0, stdout: '', stderr: '' };
      }
      // model a definitive terminal receipt from the host
      const id = session.replace('rac-agent-install-', '');
      const jobs = join(testCheckout, '.data', 'agent-updates', 'jobs');
      await writeFile(join(jobs, `${id}.installer.out`), 'private installer output', { mode: 0o600 });
      await writeFile(join(jobs, `${id}.installer.status`), receipt!, { mode: 0o600 });
      return { code: 0, stdout: '', stderr: '' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', undefined, testCheckout);
    // a malformed receipt is not a completion proof until the observation budget expires
    const result = scenario === 'invalid marker' ? await (async () => {
      const started = await service.startUpdate('codex');
      // wait for the exact durable installer stage before simulating a later observer
      if (started.outcome !== 'started') throw new Error('expected update admission');
      const store = new AgentUpdateJobStore(testCheckout);
      await waitForJob(async () => expect(await readdir(join(testCheckout, '.data', 'agent-updates', 'jobs'))).toContain(`${started.job.id}.installer.status`));
      const record = await store.read(started.job.id);
      // move the durable deadline into the past in this isolated fixture
      if (record?.state !== 'running' || record.phase !== 'install') throw new Error('expected installer phase');
      await store.write({ ...record, deadline: record.startedAt + 1 });
      await waitForJob(() => expect(Date.now()).toBeGreaterThan(record.startedAt + 1));
      const restarted = new AgentUpdateService(configured(), '/home/test', undefined, testCheckout);
      await waitForJob(async () => expect(await restarted.updateStatus('codex', started.job.id)).toMatchObject({ state: 'failed' }));
      return { outcome: 'failed', job: await restarted.updateStatus('codex', started.job.id) };
    })() : await service.update('codex');
    expect(result.outcome).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({
      kind: 'codex', reason, phase: 'install', targetVersion: '1.1.0', observedVersion: '1.0.0',
      ...(scenario === 'invalid marker' ? {} : { output: expect.stringContaining('private installer output') })
    }));
    const artifacts = (await readdir(join(testCheckout, '.data', 'agent-updates', 'jobs'))).filter(name => name.includes('.installer.'));
    // reclaim proven receipts and retain unconfirmed artifacts
    if (scenario === 'invalid marker') expect(artifacts).toHaveLength(2);
    else expect(artifacts).toEqual([]);
  });

  it('normalizes terminal output to one bounded version line', () => {
    expect(normalizedVersion('\x1b[32m0.153.2\x1b[0m\nextra')).toBe('0.153.2');
    expect(normalizedVersion('\n\r')).toBeUndefined();
  });

  it('compares configured versions in registry order and caches the result', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? '0.152.1\n' : '0.153.2\n' }));
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('bypasses completed version caches for explicit refreshes and coalesces concurrent probes', async () => {
    let current = '1.0.0';
    let latest = '1.1.0';
    let release = () => {};
    let blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // isolate cache behavior from durable recovery scanning
    const snapshot = vi.spyOn(AgentUpdateJobStore.prototype, 'snapshot').mockResolvedValue({ terminal: [] });
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // hold only the refreshed installed-version probe
      if (blocked && command === 'current') await gate;
      return { code: 0, output: command === 'current' ? current : latest };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);
    current = '1.1.0';
    latest = '1.2.0';
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);

    blocked = true;
    const first = service.statuses(true);
    let pending = Promise.all([first]);
    try {
      // establish one running refreshed probe before adding callers
      await waitForJob(() => expect(runner).toHaveBeenCalledTimes(4));
      const second = service.statuses(true);
      const ordinary = service.statuses();
      pending = Promise.all([first, second, ordinary]);
      // hand both later callers through their controlled snapshots
      await waitForJob(() => expect(snapshot).toHaveBeenCalledTimes(5));
      await Promise.resolve();
      await Promise.resolve();
      // neither a forced nor ordinary caller may start another probe pair
      expect(runner).toHaveBeenCalledTimes(4);
    } finally {
      // never retain a blocked provider probe after an assertion failure
      release();
    }
    const refreshed = [{ kind: 'codex' as const, currentVersion: '1.1.0', latestVersion: '1.2.0', updateAvailable: true }];
    await expect(pending).resolves.toEqual([refreshed, refreshed, refreshed]);
    expect(await service.statuses()).toEqual(refreshed);
    expect(runner).toHaveBeenCalledTimes(4);
  });

  // keep every version and installer command disabled without a proven launch account
  it('reports updates unavailable without HOME and never invokes a runner', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async () => ({ code: 0, output: 'must not run' }));
    const service = new AgentUpdateService(configured(), undefined, runner, testCheckout);

    await expect(service.statuses()).resolves.toEqual([{ kind: 'codex', updateAvailable: false, error: 'Version check unavailable' }]);
    expect(await service.startUpdate('codex')).toEqual({ outcome: 'unavailable' });
    await expect(service.update('codex')).resolves.toEqual({ outcome: 'unavailable' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('lists a pinned kind with the pin as current and the published version as latest, and never runs an update for it', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async () => ({ code: 0, output: '0.152.1\n' }));
    const pinned = (JSON.parse(await readFile(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const published = vi.fn(async (name: string) => name === '@earendil-works/pi-coding-agent' ? '9.0.0' : undefined);
    const config = { ...configured(), adapters: { ...configured().adapters, pi: { program: process.execPath, args: [], env: {}, launchable: true } } };
    const service = new AgentUpdateService(config, '/home/test', runner, testCheckout, published);
    expect(await service.statuses()).toEqual([
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.152.1', updateAvailable: false },
      { kind: 'pi', currentVersion: pinned, latestVersion: '9.0.0', updateAvailable: true, pinned: true }
    ]);
    expect(await service.startUpdate('pi')).toEqual({ outcome: 'unavailable' });
    // the pin is read from the server's own dependencies, never by running a command
    expect(runner).toHaveBeenCalledTimes(2);
  });

  // tolerate a slow registry while keeping version checks bounded
  it.each([
    { lookupMs: 20_000, succeeds: true },
    { lookupMs: 35_000, succeeds: false }
  ])('bounds a registry lookup taking $lookupMs ms', async ({ lookupMs, succeeds }) => {
    let ready = () => {};
    const lookupStarted = new Promise<void>(resolve => { ready = resolve; });
    // model a command that completes or reaches the supplied deadline
    const runner: AgentUpdateRunner = async (command, timeoutMs) => {
      // installed versions do not wait for the registry
      if (command === 'current') return { code: 0, output: '1.0.0' };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      ready();
      await new Promise(resolve => setTimeout(resolve, Math.min(lookupMs, timeoutMs)));
      return lookupMs < timeoutMs ? { code: 0, output: '1.1.0' } : { code: -1, output: '' };
    };
    try {
      const pending = new AgentUpdateService(configured(), '/home/test', runner, testCheckout).statuses();
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(Math.min(lookupMs, 30_000));
      await expect(pending).resolves.toEqual([succeeds
        ? { kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }
        : { kind: 'codex', updateAvailable: false, error: 'Version check failed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // compare semantic precedence and equivalent forms
  it.each([
    { current: '0.10.0', latest: '0.9.0', updateAvailable: false },
    { current: 'v1.2.3', latest: '1.2.3', updateAvailable: false },
    { current: '1.2.3+installed', latest: '1.2.3+registry', updateAvailable: false },
    { current: '1.2.3-rc.1', latest: '1.2.3', updateAvailable: true }
  ])('compares $current with $latest using semver precedence', async ({ current, latest, updateAvailable }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? current : latest }));
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: current, latestVersion: latest, updateAvailable }]);
  });

  // suppress every failed version response
  it.each([
    { failure: 'a zero exit carries a timeout', current: { code: 0, output: '1.0.0', failure: 'timed_out' as const }, latest: { code: 0, output: '1.2.3' } },
    { failure: 'both outputs are present but one is invalid', current: { code: 0, output: 'development' }, latest: { code: 0, output: '1.2.3' } },
    { failure: 'the invalid current output accompanies a failed latest command', current: { code: 0, output: 'development' }, latest: { code: 1, output: 'registry error' } },
    { failure: 'the invalid latest output accompanies a failed current command', current: { code: 1, output: 'binary error' }, latest: { code: 0, output: 'development' } }
  ])('omits version output when $failure', async ({ current, latest }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => command === 'current' ? current : latest);
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    expect(await service.statuses()).toEqual([{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }]);
  });

  it('runs the update once and refreshes the installed version', async () => {
    let current = '0.152.1';
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // promote the installed version through the configured update command
      if (command === 'update') { current = '0.153.2'; return { code: 0, output: 'updated' }; }
      return { code: 0, output: command === 'current' ? current : '0.153.2' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    await service.statuses();
    expect(await service.update('codex')).toEqual({ outcome: 'updated', status: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } });
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest', 'current', 'latest', 'update', 'current']);
  });

  // accept the requested release or any newer OMX release
  it.each(['0.22.27', '0.22.29', '1.0.0', '2.0.0-rc.1'])('accepts OMX %s after requesting 0.22.27', async observed => {
    const config = configured();
    config.adapters!.omx!.updates = { current: 'current', latest: 'latest', run: 'update' };
    let current = '0.22.25';
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // simulate a registry release advancing during installation
      if (command === 'update') { current = observed; return { code: 0, output: 'updated' }; }
      return { code: 0, output: command === 'current' ? current : '0.22.27' };
    });
    const service = new AgentUpdateService(config, '/home/test', runner, testCheckout);
    await expect(service.update('omx')).resolves.toEqual({
      outcome: 'updated',
      status: { kind: 'omx', currentVersion: observed, latestVersion: '0.22.27', updateAvailable: false }
    });
    expect(runner.mock.calls.map(([command]) => command)).toEqual(['current', 'latest', 'update', 'current']);
    expect(diagnostics.saveAgentUpdateFailure).not.toHaveBeenCalled();
  });

  // reproduce an upstream installer timeout reported as a zero exit
  it('reports an unchanged OMX version as an incomplete update, not a successful installer', async () => {
    const config = configured();
    config.adapters!.omx!.updates = { current: 'current', latest: 'latest', run: 'update' };
    const runner = vi.fn<AgentUpdateRunner>(async command => ({
      code: 0,
      output: command === 'update' ? '[omx] npm stderr: spawnSync node ETIMEDOUT' : command === 'current' ? '0.22.25' : '0.22.27'
    }));
    const service = new AgentUpdateService(config, '/home/test', runner, testCheckout);
    await expect(service.update('omx')).resolves.toEqual({
      outcome: 'failed',
      error: 'OMX update incomplete: installed 0.22.25, expected 0.22.27 or newer. The installer returned exit code 0. Private diagnostics: .data/agent-updates/codex-test.json.',
      status: { kind: 'omx', currentVersion: '0.22.25', latestVersion: '0.22.27', updateAvailable: true }
    });
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({
      reason: 'target_not_installed',
      code: 0,
      output: expect.stringContaining('ETIMEDOUT')
    }));
  });

  // never replace an equal or newer installation
  it.each([
    { current: '1.1.0', latest: '1.1.0' },
    { current: '1.2.0', latest: '1.1.0' }
  ])('completes without an installer when $current is at least $latest', async ({ current, latest }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? current : latest }));
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);

    await expect(service.update('codex')).resolves.toEqual({
      outcome: 'updated',
      status: { kind: 'codex', currentVersion: current, latestVersion: latest, updateAvailable: false }
    });
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest']);
  });

  // settle an already-newer background request successfully
  it('completes a background update without downgrading a newer installation', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? '2.0.0' : '1.9.0' }));
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    const started = await service.startUpdate('codex');
    expect(started.outcome).toBe('started');
    // narrow the asserted start result
    if (started.outcome !== 'started') throw new Error('expected a started update');

    await waitForJob(async () => expect(await service.updateStatus('codex', started.job.id)).toEqual({
      id: started.job.id,
      kind: 'codex',
      state: 'complete',
      agent: { kind: 'codex', currentVersion: '2.0.0', latestVersion: '1.9.0', updateAvailable: false }
    }));
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest']);
  });

  // fail closed when versions cannot prove a safe update
  it.each([
    { failure: 'invalid output', current: { code: 0, output: 'development' } },
    { failure: 'failed command', current: { code: 1, output: 'private command error' } },
    { failure: 'timeout', current: { code: -1, output: '', failure: 'timed_out' as const } }
  ])('does not install after a $failure', async ({ current }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => command === 'current' ? current : { code: 0, output: '1.1.0' });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);

    await expect(service.update('codex')).resolves.toMatchObject({ outcome: 'failed', error: expect.stringContaining('version') });
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest']);
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({
      phase: 'preflight', reason: 'version_check_failed', targetVersion: '1.1.0', probeFailure: current.failure
    }));
  });

  // allow slow downloads without leaving hung installers unbounded
  it.each([
    { installMs: 8 * 60_000, terminal: 'complete' },
    { installMs: 16 * 60_000, terminal: 'failed' }
  ])('bounds an installer taking $installMs ms', async ({ installMs, terminal }) => {
    let installerBegan = () => {};
    const startedRunning = new Promise<void>(resolve => { installerBegan = resolve; });
    let installed = '1.0.0';
    // model the runner's deadline without starting a real installer
    const runner = vi.fn<AgentUpdateRunner>(async (command, timeoutMs) => {
      // keep version checks independent of the slow download
      if (command !== 'update') return { code: 0, output: command === 'current' ? installed : '1.1.0' };
      // simulate only installer timers after real filesystem admission
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      installerBegan();
      await new Promise(resolve => setTimeout(resolve, Math.min(installMs, timeoutMs)));
      // preserve the old installation when the runner times out
      if (installMs > timeoutMs) return { code: -1, output: '' };
      installed = '1.1.0';
      return { code: 0, output: 'installed' };
    });
    try {
      const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
      const started = await service.startUpdate('codex');
      // require the background job used by the browser
      if (started.outcome !== 'started') throw new Error('expected a started update');
      await startedRunning;
      expect(runner).toHaveBeenCalledWith('update', 15 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect((await service.updateStatus('codex', started.job.id))?.state).toBe('running');
      expect(await service.startUpdate('codex')).toEqual(started);

      await vi.advanceTimersByTimeAsync(Math.min(installMs, 15 * 60_000) - (5 * 60_000 + 1));
      vi.useRealTimers();
      await waitForJob(async () => expect((await service.updateStatus('codex', started.job.id))?.state).toBe(terminal));
      expect(installed).toBe(terminal === 'complete' ? '1.1.0' : '1.0.0');
      expect(runner.mock.calls.filter(([command]) => command === 'update')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes updates and reports command failures safely', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // hold the first update so a concurrent request sees the busy state
      if (command === 'update') { await gate; return { code: 1, output: 'secret failure details' }; }
      return { code: 0, output: command === 'current' ? '1.0.0' : '1.1.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    const pending = service.update('codex');
    // wait for the first caller to win durable admission
    await waitForJob(() => expect(runner).toHaveBeenCalledWith('update', 15 * 60_000));
    expect(await service.update('codex')).toEqual({ outcome: 'busy' });
    release();
    const failed = await pending;
    expect(failed).toMatchObject({ outcome: 'failed', error: expect.stringContaining('exit code 1') });
    expect(JSON.stringify(failed)).not.toContain('secret failure details');
    expect(await service.update('omx')).toEqual({ outcome: 'unavailable' });
  });

  // preserve an actionable failure without returning private installer output
  it('returns an exit code and saved diagnostic reference for a failed installer', async () => {
    const checkout = testCheckout;
    vi.mocked(diagnostics.saveAgentUpdateFailure).mockRestore();
    const runner: AgentUpdateRunner = async command => command === 'update'
      ? { code: 17, output: 'private installer error' }
      : { code: 0, output: command === 'current' ? '1.0.0' : '1.1.0' };
    const service = new AgentUpdateService(configured(), '/home/test', runner, checkout);
    const result = await service.update('codex');
    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('exit code 17') });
    expect(result).toMatchObject({ error: expect.stringContaining('.data/agent-updates/') });
    expect(JSON.stringify(result)).not.toContain('private installer error');
    const reports = (await readdir(join(checkout, '.data', 'agent-updates'))).filter(name => name.endsWith('.json'));
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(join(checkout, '.data', 'agent-updates', reports[0]!), 'utf8'));
    expect(report).toMatchObject({ version: 1, kind: 'codex', reason: 'command_failed', exitCode: 17, phase: 'install', output: expect.stringContaining('private installer error') });

  });

  // retain completed jobs even after the next admitted update
  it('coalesces one asynchronous update and retains its terminal job', async () => {
    const config = configured();
    config.adapters!.omx!.updates = { current: 'omx-current', latest: 'omx-latest', run: 'omx-update' };
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let installed = '1.0.0';
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // gate only the installer
      if (command === 'update') { await gate; installed = '1.1.0'; return { code: 0, output: 'installed' }; }
      return { code: 0, output: command === 'current' ? installed : '1.1.0' };
    });
    const service = new AgentUpdateService(config, '/home/test', runner, testCheckout);

    const started = await service.startUpdate('codex');
    expect(started.outcome).toBe('started');
    // narrow the asserted start result
    if (started.outcome !== 'started') throw new Error('expected a started update');
    expect(started.job).toMatchObject({ kind: 'codex', state: 'running' });
    expect(await service.updateStatus('codex', started.job.id)).toEqual(started.job);
    expect(await service.updateStatus('codex', 'unknown')).toBeUndefined();
    expect(await service.startUpdate('codex')).toEqual(started);
    expect(await service.startUpdate('omx')).toEqual({ outcome: 'busy' });

    release();
    await waitForJob(async () => expect(await service.updateStatus('codex', started.job.id)).toEqual({
      id: started.job.id,
      kind: 'codex',
      state: 'complete',
      agent: { kind: 'codex', currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false }
    }));

    const replacement = await service.startUpdate('codex');
    expect(replacement.outcome).toBe('started');
    // narrow the asserted replacement result
    if (replacement.outcome !== 'started') throw new Error('expected a replacement update');
    expect(replacement.job.id).not.toBe(started.job.id);
    expect(await service.updateStatus('codex', started.job.id)).toMatchObject({ state: 'complete' });
    await waitForJob(async () => expect((await service.updateStatus('codex', replacement.job.id))?.state).toBe('complete'));
  });

  // cover both command failure paths without publishing their output
  it.each(['exit', 'reject'] as const)('settles an asynchronous %s failure safely', async failure => {
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // fail only the configured installer
      if (command === 'update') {
        // model a rejected command promise separately
        if (failure === 'reject') throw new Error('secret rejected output');
        return { code: 1, output: 'secret command output' };
      }
      return { code: 0, output: command === 'current' ? '1.0.0' : '1.1.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    const started = await service.startUpdate('codex');
    expect(started.outcome).toBe('started');
    // narrow the asserted start result
    if (started.outcome !== 'started') throw new Error('expected a started update');
    await waitForJob(async () => expect(await service.updateStatus('codex', started.job.id)).toEqual({
      id: started.job.id,
      kind: 'codex',
      state: 'failed',
      error: expect.stringContaining('.data/agent-updates/codex-test.json'),
      agent: { kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }
    }));
    expect(JSON.stringify(await service.updateStatus('codex', started.job.id))).not.toContain('secret');
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      kind: 'codex',
      reason: failure === 'reject' ? 'launch_failed' : 'command_failed',
      output: expect.stringContaining(failure === 'reject' ? 'secret rejected output' : 'secret command output')
    }));
  });

  // preserve the original update failure when private storage itself is unavailable
  it('reports a diagnostic write failure without exposing exception details', async () => {
    vi.mocked(diagnostics.saveAgentUpdateFailure).mockRejectedValue(new Error('secret private storage path'));
    const service = new AgentUpdateService(configured(), '/home/test', async command => command === 'update'
      ? { code: 1, output: 'secret installer output' }
      : { code: 0, output: command === 'current' ? '1.0.0' : '1.1.0' }, testCheckout);
    const result = await service.update('codex');
    expect(result).toMatchObject({ outcome: 'failed', error: 'Codex update failed with exit code 1. Private diagnostics could not be saved.' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  // recover a detached installer across service recreation without replaying it
  it('recovers an accepted install using the identical durable job id', async () => {
    let installed = '1.0.0';
    let receipt: InstallerResult | undefined;
    let firstReceipt: InstallerResult | undefined;
    const handedOff = vi.fn(async () => undefined);
    const updater = {
      prepareLock: async () => '1:1', launch: handedOff,
      observe: async () => firstReceipt,
      cleanup: async () => {}, isIdle: async () => true
    };
    let beginVerification = () => {};
    let releaseVerification = () => {};
    const verificationStarted = new Promise<void>(resolve => { beginVerification = resolve; });
    const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
    let oldVerification = true;
    const readVersion: AgentUpdateRunner = async command => ({ code: 0, output: command === 'current' ? installed : '1.1.0' });
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      const result = await readVersion(command, 30_000);
      // delay the first controller's old verification while another settles the job
      if (command === 'current' && firstReceipt !== undefined && oldVerification) {
        oldVerification = false;
        beginVerification();
        await verificationGate;
      }
      return result;
    });
    const first = new AgentUpdateService(configured(), '/home/test', runner, testCheckout, undefined, updater);
    expect((await first.statuses())[0]?.currentVersion).toBe('1.0.0');
    let releaseOldRead = () => {};
    let beginOldRead = () => {};
    const oldReadGate = new Promise<void>(resolve => { releaseOldRead = resolve; });
    const oldReadStarted = new Promise<void>(resolve => { beginOldRead = resolve; });
    let firstRead = true;
    const viewer = new AgentUpdateService(configured(), '/home/test', async command => {
      const value = command === 'current' ? installed : '1.1.0';
      // keep the original installed-version read in flight across the update
      if (command === 'current' && firstRead) {
        firstRead = false;
        beginOldRead();
        await oldReadGate;
      }
      return { code: 0, output: value };
    }, testCheckout, undefined, updater);
    const oldStatuses = viewer.statuses();
    await oldReadStarted;
    const start = await first.startUpdate('codex');
    // require the accepted browser job and host handoff
    if (start.outcome !== 'started') throw new Error('expected a started update');
    await waitForJob(() => expect(handedOff).toHaveBeenCalledExactlyOnceWith(start.job.id, 'update', 15 * 60_000, expect.any(Number), '1:1'));
    const replay = vi.fn(async () => undefined);
    const restarted = new AgentUpdateService(configured(), '/home/test', readVersion, testCheckout, undefined, {
      ...updater, launch: replay, observe: async () => receipt
    });
    expect(await restarted.startUpdate('codex')).toEqual(start);
    expect(await restarted.updateStatus('omx', start.job.id)).toBeUndefined();
    firstReceipt = { code: 0, output: 'installed', confirmed: true };
    await verificationStarted;
    installed = '1.1.0';
    receipt = { code: 0, output: 'installed', confirmed: true };
    await waitForJob(async () => expect(await restarted.updateStatus('codex', start.job.id)).toMatchObject({
      id: start.job.id, state: 'complete', agent: { kind: 'codex', currentVersion: '1.1.0', updateAvailable: false }
    }));
    expect(replay).not.toHaveBeenCalled();
    expect((await first.statuses())[0]?.currentVersion).toBe('1.1.0');
    releaseVerification();
    // a losing verifier must not publish failure or repopulate its old cache
    expect((await first.statuses())[0]?.currentVersion).toBe('1.1.0');
    // a statuses-only observer invalidates its own outstanding comparison
    expect((await viewer.statuses())[0]?.currentVersion).toBe('1.1.0');
    releaseOldRead();
    expect((await oldStatuses)[0]?.currentVersion).toBe('1.1.0');
    expect(await first.updateStatus('codex', start.job.id)).toMatchObject({ state: 'complete' });
    const store = new AgentUpdateJobStore(testCheckout);
    const completed = await store.read(start.job.id);
    // publish a newer durable outcome to exercise polling a historical job
    if (completed?.state !== 'complete') throw new Error('expected completion');
    installed = '1.2.0';
    await store.write({ ...completed, id: 'e'.repeat(24), startedAt: completed.finishedAt + 1, finishedAt: completed.finishedAt + 2, agent: { kind: 'codex', currentVersion: '1.2.0', latestVersion: '1.2.0', updateAvailable: false } });
    expect((await first.statuses())[0]?.currentVersion).toBe('1.2.0');
    const afterRefresh = runner.mock.calls.length;
    await first.updateStatus('codex', start.job.id);
    expect((await first.statuses())[0]?.currentVersion).toBe('1.2.0');
    expect(runner.mock.calls).toHaveLength(afterRefresh);
  });

  // do not release admission when the host may still be executing an old job
  it('waits for an idle host after expiry and reports an installed but unconfirmed target', async () => {
    let installed = '1.0.0';
    let idle = false;
    const launch = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => {});
    const isIdle = vi.fn(async (_identity?: string) => idle);
    const updater = { prepareLock: async () => '1:1', launch, observe: async () => undefined, isIdle, cleanup };
    const runner: AgentUpdateRunner = async command => ({ code: 0, output: command === 'current' ? installed : '1.1.0' });
    const first = new AgentUpdateService(configured(), '/home/test', runner, testCheckout, undefined, updater);
    const started = await first.startUpdate('codex');
    // retain exact identity and original authority while simulating elapsed time
    if (started.outcome !== 'started') throw new Error('expected admission');
    await waitForJob(() => expect(launch).toHaveBeenCalledOnce());
    const store = new AgentUpdateJobStore(testCheckout);
    const current = await store.read(started.job.id);
    // expire the persisted observation window without touching a real installer
    if (current?.state !== 'running' || current.phase !== 'install') throw new Error('expected install phase');
    expect(current.installerLock).toBe('1:1');
    await store.write({ ...current, deadline: current.startedAt + 1 });
    const observer = new AgentUpdateService(configured(), '/home/test', runner, testCheckout, undefined, updater);
    await observer.updateStatus('codex', started.job.id);
    await waitForJob(() => expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({ output: expect.stringContaining('Host installer idleness could not be confirmed') })));
    expect(isIdle).toHaveBeenCalledWith('1:1');
    expect(await observer.startUpdate('codex')).toEqual(started);
    expect(await store.active()).toMatchObject({ id: started.job.id, state: 'running' });
    expect(launch).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    installed = '1.1.0';
    idle = true;
    await waitForJob(async () => expect(await observer.updateStatus('codex', started.job.id)).toMatchObject({
      state: 'failed', error: expect.stringContaining('installer completion could not be confirmed'),
      agent: { currentVersion: '1.1.0', updateAvailable: false }
    }));
    expect(await store.active()).toBeUndefined();
    expect(launch).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  // clean only jobs whose previous controller durably recorded completion proof
  it('reconciles confirmed terminal artifacts after restart and retains ambiguous output', async () => {
    const store = new AgentUpdateJobStore(testCheckout);
    const base = { version: 1, kind: 'codex', state: 'failed', authority: 'a'.repeat(64), startedAt: 1, finishedAt: 2, error: 'Interrupted' } as const;
    await store.write({ ...base, id: '1'.repeat(24), cleanupEligible: true });
    await store.write({ ...base, id: '2'.repeat(24) });
    let lateReceipt = false;
    const cleanup = vi.fn(async () => {});
    const runner: AgentUpdateRunner = async () => ({ code: 0, output: '1.1.0' });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout, undefined, {
      prepareLock: async () => '1:1', launch: async () => undefined,
      observe: async id => lateReceipt && id === '2'.repeat(24) ? { code: -1, output: '', failure: 'interrupted', confirmed: true } : undefined,
      cleanup, isIdle: async () => true
    });
    await service.statuses();
    await waitForJob(() => expect(cleanup).toHaveBeenCalledWith('1'.repeat(24)));
    await service.updateStatus('codex', '1'.repeat(24));
    expect(cleanup).not.toHaveBeenCalledWith('2'.repeat(24));
    lateReceipt = true;
    await service.updateStatus('codex', '2'.repeat(24));
    await waitForJob(() => expect(cleanup).toHaveBeenCalledWith('2'.repeat(24)));
    expect(await store.read('2'.repeat(24))).toMatchObject({ cleanupEligible: true });
  });

  // ordinary bridged status reads must share the installation's validated storage boundary
  it('refuses unsafe version-probe directories before launching commands', async () => {
    const updates = join(testCheckout, '.data', 'agent-updates');
    await mkdir(updates, { recursive: true, mode: 0o700 });
    await chmod(updates, 0o755);
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/console');
    const run = vi.spyOn(command, 'run');
    const service = new AgentUpdateService(configured(), '/home/test', undefined, testCheckout);
    expect(await service.statuses()).toEqual([{ kind: 'codex', updateAvailable: false, error: 'Version check unavailable' }]);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(updates)).toEqual([]);
  });

  // report a stuck observer explicitly and recover from its durable receipt
  it('records an observer write failure without replaying the installer', async () => {
    let rejectTerminalWrite = true;
    const write = AgentUpdateJobStore.prototype.write;
    vi.spyOn(AgentUpdateJobStore.prototype, 'write').mockImplementation(async function (this: AgentUpdateJobStore, record) {
      // fail only the first attempt to publish the terminal status
      if (record.state === 'complete' && rejectTerminalWrite) {
        rejectTerminalWrite = false;
        throw new Error('private storage failure');
      }
      await write.call(this, record);
    });
    const launch = vi.fn(async () => undefined);
    const runner: AgentUpdateRunner = async command => ({
      code: 0, output: command === 'current' && launch.mock.calls.length === 0 ? '1.0.0' : '1.1.0'
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout, undefined, {
      prepareLock: async () => '1:1', launch, observe: async () => ({ code: 0, output: 'installed', confirmed: true }), cleanup: async () => {}, isIdle: async () => true
    });
    const started = await service.startUpdate('codex');
    // require a durable job before checking its recovery
    if (started.outcome !== 'started') throw new Error('expected a started update');
    await waitForJob(() => expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({
      jobId: started.job.id, phase: 'install', reason: 'interrupted', targetVersion: '1.1.0',
      output: expect.stringContaining('private storage failure')
    })));
    await expect(service.updateStatus('codex', started.job.id)).rejects.toThrow('Agent update status is unavailable');
    await waitForJob(async () => expect(await service.updateStatus('codex', started.job.id)).toMatchObject({ state: 'complete' }));
    expect(launch).toHaveBeenCalledOnce();
  });

  // make the original target authoritative despite setup failure or changing registry state
  it.each([
    { exit: 1, observed: '1.1.0', reason: 'installed_setup_failed', phase: 'install' },
    { exit: 0, observed: '1.0.0', reason: 'target_not_installed', phase: 'verification' },
    { exit: 0, observed: undefined, reason: 'verification_failed', phase: 'verification' },
    { exit: 0, observed: '1.2.0', reason: undefined, phase: undefined }
  ])('reconciles exit $exit with observed installed version $observed', async ({ exit, observed, reason, phase }) => {
    let ranInstaller = false;
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // model a single installer that may change the binary and still return nonzero
      if (command === 'update') { ranInstaller = true; return { code: exit, output: 'private installer output' }; }
      // do not substitute newer registry versions for the job target
      if (command === 'latest') return { code: 0, output: ranInstaller ? '1.3.0' : '1.1.0' };
      return ranInstaller && observed === undefined ? { code: 2, output: 'private verification output' } : { code: 0, output: ranInstaller ? observed! : '1.0.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner, testCheckout);
    const result = await service.update('codex');
    expect(runner.mock.calls.map(([command]) => command)).toEqual(['current', 'latest', 'update', 'current']);
    expect(result.outcome).toBe(reason === undefined ? 'updated' : 'failed');
    expect(JSON.stringify(result)).not.toContain('private installer output');
    // distinguish the process exit from a verified installation
    if (reason === 'verification_failed') expect(result).toMatchObject({ error: expect.stringMatching(/returned exit code 0.*installed version could not be verified/u) });
    // expose observed versions without converting partial installers into success
    if (observed !== undefined) expect(result).toMatchObject({ status: { currentVersion: observed, latestVersion: '1.1.0', updateAvailable: observed === '1.0.0' } });
    // retain the phase and proof for every categorized failure
    if (reason !== undefined) expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(testCheckout, expect.objectContaining({
      jobId: expect.stringMatching(/^[a-f0-9]{24}$/u), elapsedMs: expect.any(Number), reason, phase,
      previousVersion: '1.0.0', targetVersion: '1.1.0', observedVersion: observed
    }));
  });
});
