import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUpdateService, normalizedVersion, type AgentUpdateRunner } from '../src/agent-updates/service.js';
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

describe('agent updates', () => {
  // keep command fixtures isolated from the installation's real diagnostic directory
  beforeEach(() => {
    vi.spyOn(diagnostics, 'saveAgentUpdateFailure').mockResolvedValue('.data/agent-updates/codex-test.json');
  });
  // restore host settings and command spies between cases
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // cover compose host paths and the legacy workspace override
  it.each([
    { repository: '/host/console', workspace: undefined, expected: '/host/console' },
    { repository: '/host/console', workspace: '/host/legacy', expected: '/host/console' },
    { repository: undefined, workspace: '/host/legacy', expected: '/host/legacy' }
  ])('checks versions through the host checkout $expected', async ({ repository, workspace, expected }) => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-agent-updates-'));
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
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.out`), script.includes('{ current; }') ? '1.0.0\n' : '1.1.0\n');
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.status`), '0');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      const service = new AgentUpdateService(configured(), '/home/test', undefined, checkout);
      await expect(service.statuses()).resolves.toEqual([{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);
      expect(run).toHaveBeenCalledTimes(4);
      expect(await readdir(join(checkout, '.data', 'agent-updates'))).toEqual([]);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  // retain precise bridge failures before removing temporary command files
  it.each([
    { scenario: 'launch', status: undefined, reason: 'launch_failed' },
    { scenario: 'command', status: '17', reason: 'command_failed' },
    { scenario: 'invalid marker', status: '0invalid', reason: 'invalid_completion' },
    { scenario: 'timeout', status: undefined, reason: 'timed_out' }
  ] as const)('saves a safe diagnostic for a bridge $scenario failure', async ({ scenario, status, reason }) => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-agent-update-bridge-'));
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_TMUX_BIN', '/host-tools/tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/console');
    vi.spyOn(command, 'run').mockImplementation(async (_binary, args) => {
      // leave cleanup requests harmless
      if (!args.includes('new-session')) return { code: 0, stdout: '', stderr: '' };
      expect(args.at(-1)).toContain('umask 077;');
      // model a rejected tmux launch without publishing a completion file
      if (scenario === 'launch') return { code: 1, stdout: '', stderr: 'private bridge launch error' };
      const token = args[args.indexOf('-s') + 1]!.replace('rac-agent-update-', '');
      await writeFile(join(checkout, '.data', 'agent-updates', `${token}.out`), 'private installer output');
      // publish only completed synthetic commands
      if (status !== undefined) await writeFile(join(checkout, '.data', 'agent-updates', `${token}.status`), status);
      return { code: 0, stdout: '', stderr: '' };
    });
    // cross the deadline without waiting for a real installer
    if (scenario === 'timeout') vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15 * 60_000 + 1);
    try {
      const service = new AgentUpdateService(configured(), '/home/test', undefined, checkout);
      const result = await service.update('codex');
      expect(result.outcome).toBe('failed');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(checkout, expect.objectContaining({
        kind: 'codex', reason, output: scenario === 'launch' ? 'private bridge launch error' : 'private installer output'
      }));
      expect(await readdir(join(checkout, '.data', 'agent-updates'))).toEqual([]);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('normalizes terminal output to one bounded version line', () => {
    expect(normalizedVersion('\x1b[32m0.153.2\x1b[0m\nextra')).toBe('0.153.2');
    expect(normalizedVersion('\n\r')).toBeUndefined();
  });

  it('compares configured versions in registry order and caches the result', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? '0.152.1\n' : '0.153.2\n' }));
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  // tolerate a slow registry while keeping version checks bounded
  it.each([
    { lookupMs: 20_000, succeeds: true },
    { lookupMs: 35_000, succeeds: false }
  ])('bounds a registry lookup taking $lookupMs ms', async ({ lookupMs, succeeds }) => {
    vi.useFakeTimers();
    // model a command that completes or reaches the supplied deadline
    const runner: AgentUpdateRunner = async (command, timeoutMs) => {
      // installed versions do not wait for the registry
      if (command === 'current') return { code: 0, output: '1.0.0' };
      await new Promise(resolve => setTimeout(resolve, Math.min(lookupMs, timeoutMs)));
      return lookupMs < timeoutMs ? { code: 0, output: '1.1.0' } : { code: -1, output: '' };
    };
    try {
      const pending = new AgentUpdateService(configured(), '/home/test', runner).statuses();
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
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: current, latestVersion: latest, updateAvailable }]);
  });

  // suppress every failed version response
  it.each([
    { failure: 'both outputs are present but one is invalid', current: { code: 0, output: 'development' }, latest: { code: 0, output: '1.2.3' } },
    { failure: 'the invalid current output accompanies a failed latest command', current: { code: 0, output: 'development' }, latest: { code: 1, output: 'registry error' } },
    { failure: 'the invalid latest output accompanies a failed current command', current: { code: 1, output: 'binary error' }, latest: { code: 0, output: 'development' } }
  ])('omits version output when $failure', async ({ current, latest }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => command === 'current' ? current : latest);
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }]);
  });

  it('runs the update once and refreshes the installed version', async () => {
    let current = '0.152.1';
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // promote the installed version through the configured update command
      if (command === 'update') { current = '0.153.2'; return { code: 0, output: 'updated' }; }
      return { code: 0, output: command === 'current' ? current : '0.153.2' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    await service.statuses();
    expect(await service.update('codex')).toEqual({ outcome: 'updated', status: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } });
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest', 'update', 'current', 'latest']);
  });

  // allow slow downloads without leaving hung installers unbounded
  it.each([
    { installMs: 8 * 60_000, terminal: 'complete' },
    { installMs: 16 * 60_000, terminal: 'failed' }
  ])('bounds an installer taking $installMs ms', async ({ installMs, terminal }) => {
    vi.useFakeTimers();
    let installed = '1.0.0';
    // model the runner's deadline without starting a real installer
    const runner = vi.fn<AgentUpdateRunner>(async (command, timeoutMs) => {
      // keep version checks independent of the slow download
      if (command !== 'update') return { code: 0, output: command === 'current' ? installed : '1.1.0' };
      await new Promise(resolve => setTimeout(resolve, Math.min(installMs, timeoutMs)));
      // preserve the old installation when the runner times out
      if (installMs > timeoutMs) return { code: -1, output: '' };
      installed = '1.1.0';
      return { code: 0, output: 'installed' };
    });
    try {
      const service = new AgentUpdateService(configured(), '/home/test', runner);
      const started = service.startUpdate('codex');
      // require the background job used by the browser
      if (started.outcome !== 'started') throw new Error('expected a started update');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(service.updateStatus('codex', started.job.id)?.state).toBe('running');
      expect(service.startUpdate('codex')).toEqual(started);

      await vi.advanceTimersByTimeAsync(Math.min(installMs, 15 * 60_000) - (5 * 60_000 + 1));
      expect(service.updateStatus('codex', started.job.id)?.state).toBe(terminal);
      expect(installed).toBe(terminal === 'complete' ? '1.1.0' : '1.0.0');
      expect(runner.mock.calls.filter(([command]) => command === 'update')).toHaveLength(1);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('serializes updates and reports command failures safely', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // hold the first update so a concurrent request sees the busy state
      if (command === 'update') { await gate; return { code: 1, output: 'secret failure details' }; }
      return { code: 0, output: '1.0.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    const pending = service.update('codex');
    expect(await service.update('codex')).toEqual({ outcome: 'busy' });
    release();
    const failed = await pending;
    expect(failed).toMatchObject({ outcome: 'failed', error: expect.stringContaining('exit code 1') });
    expect(JSON.stringify(failed)).not.toContain('secret failure details');
    expect(await service.update('omx')).toEqual({ outcome: 'unavailable' });
  });

  // preserve an actionable failure without returning private installer output
  it('returns an exit code and saved diagnostic reference for a failed installer', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-agent-update-error-'));
    try {
      vi.mocked(diagnostics.saveAgentUpdateFailure).mockRestore();
      const runner: AgentUpdateRunner = async () => ({ code: 17, output: 'private installer error' });
      const service = new AgentUpdateService(configured(), '/home/test', runner, checkout);
      const result = await service.update('codex');
      expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('exit code 17') });
      expect(result).toMatchObject({ error: expect.stringContaining('.data/agent-updates/') });
      expect(JSON.stringify(result)).not.toContain('private installer error');
      const reports = await readdir(join(checkout, '.data', 'agent-updates'));
      expect(reports).toHaveLength(1);
      const report = JSON.parse(await readFile(join(checkout, '.data', 'agent-updates', reports[0]!), 'utf8'));
      expect(report).toMatchObject({ version: 1, kind: 'codex', reason: 'command_failed', exitCode: 17, output: 'private installer error' });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  // lock bounded coalescing and stale job behavior
  it('coalesces one asynchronous update and keeps only its latest terminal job', async () => {
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
    const service = new AgentUpdateService(config, '/home/test', runner);

    const started = service.startUpdate('codex');
    expect(started.outcome).toBe('started');
    // narrow the asserted start result
    if (started.outcome !== 'started') throw new Error('expected a started update');
    expect(started.job).toMatchObject({ kind: 'codex', state: 'running' });
    expect(service.updateStatus('codex', started.job.id)).toEqual(started.job);
    expect(service.updateStatus('codex', 'unknown')).toBeUndefined();
    expect(service.startUpdate('codex')).toEqual(started);
    expect(service.startUpdate('omx')).toEqual({ outcome: 'busy' });

    release();
    await vi.waitFor(() => expect(service.updateStatus('codex', started.job.id)).toEqual({
      id: started.job.id,
      kind: 'codex',
      state: 'complete',
      agent: { kind: 'codex', currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false }
    }));

    const replacement = service.startUpdate('codex');
    expect(replacement.outcome).toBe('started');
    // narrow the asserted replacement result
    if (replacement.outcome !== 'started') throw new Error('expected a replacement update');
    expect(replacement.job.id).not.toBe(started.job.id);
    expect(service.updateStatus('codex', started.job.id)).toBeUndefined();
    await vi.waitFor(() => expect(service.updateStatus('codex', replacement.job.id)?.state).toBe('complete'));
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
      return { code: 0, output: '1.0.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    const started = service.startUpdate('codex');
    expect(started.outcome).toBe('started');
    // narrow the asserted start result
    if (started.outcome !== 'started') throw new Error('expected a started update');
    await vi.waitFor(() => expect(service.updateStatus('codex', started.job.id)).toEqual({
      id: started.job.id,
      kind: 'codex',
      state: 'failed',
      error: expect.stringContaining('.data/agent-updates/codex-test.json')
    }));
    expect(JSON.stringify(service.updateStatus('codex', started.job.id))).not.toContain('secret');
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      kind: 'codex',
      reason: failure === 'reject' ? 'launch_failed' : 'command_failed',
      output: expect.stringContaining(failure === 'reject' ? 'secret rejected output' : 'secret command output')
    }));
  });

  // preserve the original update failure when private storage itself is unavailable
  it('reports a diagnostic write failure without exposing exception details', async () => {
    vi.mocked(diagnostics.saveAgentUpdateFailure).mockRejectedValue(new Error('secret private storage path'));
    const service = new AgentUpdateService(configured(), '/home/test', async () => ({ code: 1, output: 'secret installer output' }));
    const result = await service.update('codex');
    expect(result).toMatchObject({ outcome: 'failed', error: 'Codex update failed with exit code 1. Private diagnostics could not be saved.' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  // carry exact direct-process deadline evidence into both stored and public errors
  it('persists a direct installer timeout as timed out rather than interrupted', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', undefined);
    vi.spyOn(command, 'run').mockResolvedValue({ code: -1, stdout: 'private timeout output', stderr: '', timedOut: true });
    const result = await new AgentUpdateService(configured(), '/home/test').update('codex');
    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('timed out') });
    expect(JSON.stringify(result)).not.toContain('private timeout output');
    expect(diagnostics.saveAgentUpdateFailure).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'timed_out', output: 'private timeout output' }));
  });
});
