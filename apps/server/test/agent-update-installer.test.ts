import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentUpdateInstaller, type InstallerLocation, type InstallerResult } from '../src/agent-updates/installer.js';
import * as command from '../src/tmux/command.js';

const roots: string[] = [];
// execute one generated host supervisor in integration coverage
const executeFile = promisify(execFile);

// create one native installer rooted in a private temporary checkout
async function fixture(): Promise<{ root: string; installer: AgentUpdateInstaller; location: InstallerLocation }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-agent-installer-'));
  roots.push(root);
  vi.stubEnv('INVOCATION_ID', '');
  vi.stubEnv('SYSTEMD_EXEC_PID', '');
  const location = { checkout: root, home: root, tmuxBinary: '/usr/bin/tmux', path: '/usr/local/bin:/usr/bin:/bin' };
  return { root, location, installer: new AgentUpdateInstaller(location) };
}

// wait for one durable terminal receipt
async function terminal(installer: AgentUpdateInstaller, id: string, timeoutMs = 15_000): Promise<InstallerResult> {
  const deadline = Date.now() + timeoutMs;
  // poll only until the test's bounded deadline
  while (Date.now() < deadline) {
    const result = await installer.observe(id);
    // return the first atomic terminal receipt
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('installer receipt did not arrive');
}

// remove only test-owned roots
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe('agent update installer', { timeout: 45_000 }, () => {
  it('publishes a bounded command result for a reconstructed observer', async () => {
    const { root, installer, location } = await fixture();
    const id = '111111111111111111111111';
    await expect(installer.launch(id, "printf 'installed\\n'; exit 17", 5_000)).resolves.toBeUndefined();

    const restarted = new AgentUpdateInstaller(location);
    await expect(terminal(restarted, id)).resolves.toEqual({ code: 17, output: 'installed\n', confirmed: true });
    await restarted.cleanup(id);
    expect(await readdir(join(root, '.data', 'agent-updates', 'jobs'))).toEqual([]);
  });

  it('proves an expired authorization was refused before handoff', async () => {
    const { root, installer } = await fixture();
    const marker = join(root, 'must-not-run');
    const result = await installer.launch('101010101010101010101010', `/usr/bin/touch -- '${marker}'`, 5_000, Date.now() - 1);

    expect(result).toEqual({
      code: -1,
      output: 'Installer authorization expired before handoff.',
      failure: 'interrupted',
      confirmed: true
    });
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, '.data'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a host supervisor delayed beyond its absolute deadline', async () => {
    const { root } = await fixture();
    const marker = join(root, 'delayed-mutation');
    const location: InstallerLocation = {
      checkout: root,
      hostCheckout: root,
      home: root,
      socket: '/host-tmux/default',
      tmuxBinary: '/host-tools/tmux'
    };
    const installer = new AgentUpdateInstaller(location);
    const run = vi.spyOn(command, 'run').mockResolvedValue({ code: 1, stdout: '', stderr: 'client result is ambiguous' });
    const id = '121212121212121212121212';
    const deadline = Date.now() + 250;

    await expect(installer.launch(id, `/usr/bin/touch -- '${marker}'`, 5_000, deadline)).resolves.toBeUndefined();
    const script = run.mock.calls[0]![1].at(-1)!;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 50)));
    await executeFile('/bin/bash', ['-c', script], { cwd: root });

    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(terminal(installer, id)).resolves.toEqual({ code: -1, output: '', failure: 'interrupted', confirmed: true });
  });

  it('serializes host installers and reports contention without retrying', async () => {
    const { root, installer } = await fixture();
    const first = '222222222222222222222222';
    const second = '333333333333333333333333';
    await installer.launch(first, "printf 'started'; while [[ ! -f release ]]; do /bin/sleep 0.05; done; printf 'finished'", 30_000);
    const partial = join(root, '.data', 'agent-updates', 'jobs', `${first}.installer.out.tmp`);
    try {
      // keep the first lock held until the second attempt has reported contention
      await vi.waitFor(async () => expect((await lstat(partial)).isFile()).toBe(true), { timeout: 10_000 });
      await installer.launch(second, "printf 'must not run'", 5_000);
      await expect(terminal(installer, second)).resolves.toEqual({ code: -1, output: '', failure: 'installer_busy', confirmed: true });
    } finally {
      await writeFile(join(root, 'release'), '', { mode: 0o600 });
    }
    await expect(terminal(installer, first)).resolves.toEqual({ code: 0, output: 'startedfinished', confirmed: true });
  });

  it('proves idleness only after the exact shared lock is released', async () => {
    const { root, installer } = await fixture();
    const id = '131313131313131313131313';
    const partial = join(root, '.data', 'agent-updates', 'jobs', `${id}.installer.out.tmp`);
    const identity = await installer.prepareLock();
    await expect(installer.isIdle(identity)).resolves.toBe(true);
    await installer.launch(id, "printf 'locked'; while [[ ! -f release ]]; do /bin/sleep 0.05; done", 30_000);
    try {
      // wait until the command holds the host lock
      await vi.waitFor(async () => expect((await lstat(partial)).isFile()).toBe(true), { timeout: 10_000 });
      await expect(installer.isIdle(identity)).resolves.toBe(false);
    } finally {
      await writeFile(join(root, 'release'), '', { mode: 0o600 });
    }
    await expect(terminal(installer, id)).resolves.toEqual({ code: 0, output: 'locked', confirmed: true });
    // allow the supervisor to exit after publishing its receipt
    await vi.waitFor(async () => expect(await installer.isIdle(identity)).toBe(true), { timeout: 5_000 });
  });

  it('requires the durable identity to prove an idle installer lock', async () => {
    const { root, installer } = await fixture();
    // missing state and legacy records do not provide continuity evidence
    await expect(installer.isIdle('1:1')).resolves.toBe(false);
    await expect(installer.isIdle()).resolves.toBe(false);
    const identity = await installer.prepareLock();
    await expect(installer.isIdle(identity)).resolves.toBe(true);
    await expect(installer.isIdle('0:0')).resolves.toBe(false);
    // reject a pre-handoff mismatch without creating installer artifacts
    await expect(installer.launch('141414141414141414141414', 'true', 5_000, Date.now() + 5_000, '0:0')).resolves.toMatchObject({ failure: 'launch_failed', confirmed: true });
    expect(await readdir(join(root, '.data', 'agent-updates', 'jobs'))).toEqual([]);
    // a missing lock cannot support the previous identity even when no command ran
    await rm(join(root, '.data', 'agent-updates', 'installer.lock'));
    await expect(installer.isIdle(identity)).resolves.toBe(false);
  });

  it('lets the host supervisor classify an installation timeout', async () => {
    const { installer } = await fixture();
    const id = '444444444444444444444444';
    await installer.launch(id, "printf 'before timeout'; sleep 30", 1_000);

    const result = await terminal(installer, id, 15_000);
    expect(result.code).toBe(-1);
    expect(result.output).toContain('before timeout');
    expect(result.failure).toBe('timed_out');
    expect(result.confirmed).toBe(true);
  });

  it('uses a capped output tail and classifies reused or malformed job state', async () => {
    const { root, installer } = await fixture();
    const id = '555555555555555555555555';
    await installer.launch(id, "/usr/bin/head -c 20000 /dev/zero | /usr/bin/tr '\\0' x; printf tail", 5_000);
    const result = await terminal(installer, id);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.output)).toBe(16 * 1024);
    expect(result.output.endsWith('tail')).toBe(true);
    await expect(installer.launch(id, 'true', 5_000)).rejects.toThrow('already exists');

    const malformed = '666666666666666666666666';
    const status = join(root, '.data', 'agent-updates', 'jobs', `${malformed}.installer.status`);
    await writeFile(status, '{"version":1,"code":-1}\n', { mode: 0o600 });
    await expect(installer.observe(malformed)).resolves.toEqual({ code: -1, output: '', failure: 'invalid_completion' });
    await writeFile(status, '{"version":1,"code":0,"failure":"launch_failed"}\n', { mode: 0o600 });
    await expect(installer.observe(malformed)).resolves.toEqual({ code: -1, output: '', failure: 'invalid_completion' });

    const corrupt = '676767676767676767676767';
    const corruptOutput = join(root, '.data', 'agent-updates', 'jobs', `${corrupt}.installer.out`);
    await writeFile(corruptOutput, 'untrusted', { mode: 0o600 });
    await chmod(corruptOutput, 0o644);
    await writeFile(join(root, '.data', 'agent-updates', 'jobs', `${corrupt}.installer.status`), '{"version":1,"code":0}\n', { mode: 0o600 });
    await expect(installer.observe(corrupt)).resolves.toEqual({ code: -1, output: '', failure: 'invalid_completion', confirmed: true });

    await chmod(join(root, '.data', 'agent-updates', 'jobs'), 0o755);
    await expect(installer.observe('bbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toThrow('invalid private agent update directory');
    await expect(installer.observe('../unsafe')).rejects.toThrow('invalid agent update job id');
  });

  it('keeps a command exit 124 distinct from the supervisor timeout', async () => {
    const { installer } = await fixture();
    const id = '999999999999999999999999';
    await installer.launch(id, "printf 'command failed'; exit 124", 5_000);

    await expect(terminal(installer, id)).resolves.toEqual({ code: 124, output: 'command failed', confirmed: true });
  });

  it('bounds output drain when a detached descendant retains stdout', async () => {
    const { installer } = await fixture();
    const id = 'cccccccccccccccccccccccc';
    await installer.launch(id, "/usr/bin/setsid /bin/bash -c 'sleep 6' & printf detached", 100);

    const result = await terminal(installer, id, 15_000);
    expect(result.code).toBe(-1);
    expect(result.failure).toBe('timed_out');
    expect(result.confirmed).toBe(true);
  });

  it('hands bridged work to tmux and preserves ambiguous accepted launches', async () => {
    const { root } = await fixture();
    const location: InstallerLocation = {
      checkout: root,
      hostCheckout: '/host/console',
      home: '/home/test',
      socket: '/host-tmux/default',
      tmuxBinary: '/host-tools/tmux',
      path: '/opt/node/bin:/usr/bin:/bin'
    };
    const installer = new AgentUpdateInstaller(location);
    const run = vi.spyOn(command, 'run').mockResolvedValue({ code: -1, stdout: '', stderr: '', timedOut: true });
    const id = '777777777777777777777777';

    await expect(installer.launch(id, 'update-agent', 5_000)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    const [binary, args] = run.mock.calls[0]!;
    expect(binary).toBe('/host-tools/tmux');
    expect(args.slice(0, 7)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', `rac-agent-install-${id}`, '-c']);
    expect(args.at(-1)).toContain("'/host/console/.data/agent-updates/jobs/777777777777777777777777.installer.status'");
    expect(args.at(-1)).toContain("export PATH='/opt/node/bin:/usr/bin:/bin'");
  });

  it('keeps nonzero tmux client exits ambiguous until a receipt arrives', async () => {
    const { root } = await fixture();
    const installer = new AgentUpdateInstaller({
      checkout: root,
      hostCheckout: '/host/console',
      home: '/home/test',
      socket: '/host-tmux/default',
      tmuxBinary: '/host-tools/tmux'
    });
    const run = vi.spyOn(command, 'run').mockResolvedValue({ code: 1, stdout: '', stderr: 'tmux rejected session' });

    const id = '888888888888888888888888';
    await expect(installer.launch(id, 'update-agent', 5_000)).resolves.toBeUndefined();
    expect(run.mock.calls[0]![1].at(-1)).not.toContain('export PATH=');
    const jobs = join(root, '.data', 'agent-updates', 'jobs');
    await writeFile(join(jobs, `${id}.installer.out`), 'accepted\n', { mode: 0o600 });
    await writeFile(join(jobs, `${id}.installer.status`), '{"version":1,"code":0}\n', { mode: 0o600 });
    await expect(installer.observe(id)).resolves.toEqual({ code: 0, output: 'accepted\n', confirmed: true });
    run.mockRejectedValueOnce(new Error('client connection disappeared'));
    await expect(installer.launch('898989898989898989898989', 'update-agent', 5_000)).resolves.toBeUndefined();
  });

  it('hands managed native work to one bounded transient user unit', async () => {
    const { root } = await fixture();
    vi.stubEnv('INVOCATION_ID', 'managed-service');
    vi.stubEnv('PATH', '/native/node/bin:/usr/bin:/bin');
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus');
    const installer = new AgentUpdateInstaller({ checkout: root, home: root, tmuxBinary: '/usr/bin/tmux' });
    const run = vi.spyOn(command, 'run').mockResolvedValue({ code: 1, stdout: '', stderr: 'unit client disconnected' });
    const id = 'dddddddddddddddddddddddd';

    await expect(installer.launch(id, 'update-agent', 15 * 60_000)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    const [binary, args] = run.mock.calls[0]!;
    expect(binary).toBe('/usr/bin/env');
    expect(args).toContain('XDG_RUNTIME_DIR=/run/user/1000');
    expect(args).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus');
    expect(args).toContain('--user');
    expect(args).toContain('--no-block');
    expect(args).toContain('--collect');
    expect(args).not.toContain('--expand-environment=no');
    expect(args).toContain(`--unit=rac-agent-install-${id}`);
    expect(args).toContain('--property=RuntimeMaxSec=910s');
    const payload = /^echo '([A-Za-z0-9+/=]+)' \| \/usr\/bin\/base64 --decode \| \/bin\/bash$/u.exec(args.at(-1)!)?.[1];
    expect(payload).toBeDefined();
    expect(Buffer.from(payload!, 'base64').toString('utf8')).toContain("export PATH='/native/node/bin:/usr/bin:/bin'");
    const jobs = join(root, '.data', 'agent-updates', 'jobs');
    await writeFile(join(jobs, `${id}.installer.out`), 'accepted\n', { mode: 0o600 });
    await writeFile(join(jobs, `${id}.installer.status`), '{"version":1,"code":0}\n', { mode: 0o600 });
    await expect(installer.observe(id)).resolves.toEqual({ code: 0, output: 'accepted\n', confirmed: true });
    run.mockRejectedValueOnce(new Error('unit client connection disappeared'));
    await expect(installer.launch('dededededededededededede', 'update-agent', 5_000)).resolves.toBeUndefined();
  });

  it('preserves the native service path outside systemd', async () => {
    const { root } = await fixture();
    vi.stubEnv('PATH', '/native/node/bin:/usr/bin:/bin');
    const installer = new AgentUpdateInstaller({ checkout: root, hostCheckout: '/stale/host/override', home: root, tmuxBinary: '/usr/bin/tmux' });
    const id = 'eeeeeeeeeeeeeeeeeeeeeeee';
    await installer.launch(id, "printf '%s' \"$PATH\"", 5_000);

    await expect(terminal(installer, id)).resolves.toEqual({ code: 0, output: '/native/node/bin:/usr/bin:/bin', confirmed: true });
  });

  it('refuses a bridged launch without one shared host checkout', async () => {
    const { root } = await fixture();
    const installer = new AgentUpdateInstaller({
      checkout: root,
      home: '/home/test',
      socket: '/host-tmux/default',
      tmuxBinary: '/host-tools/tmux'
    });
    const run = vi.spyOn(command, 'run');

    await expect(installer.launch('aaaaaaaaaaaaaaaaaaaaaaaa', 'update-agent', 5_000)).resolves.toEqual({
      code: -1,
      output: 'Shared host checkout unavailable.',
      failure: 'bridge_unavailable',
      confirmed: true
    });
    expect(run).not.toHaveBeenCalled();
  });
});
