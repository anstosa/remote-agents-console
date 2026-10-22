import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostCommandRunner, type DirectoryExecutionLease } from '../src/button-actions/host-command-runner.js';
import { run } from '../src/tmux/command.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

// restore process namespace and remove private fixtures
afterEach(async () => {
  vi.unstubAllEnvs();
  // clean every owned temporary directory
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one isolated runner checkout
async function checkout(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

// find the runner-owned marker after scheduling
async function marker(root: string): Promise<string> {
  const parent = join(root, '.data', 'button-actions');
  const entries = await readdir(parent);
  if (entries.length !== 1) throw new Error('missing action directory');
  return join(parent, entries[0]!, 'exit');
}

// create one immutable Files lease
function lease(overrides: Partial<DirectoryExecutionLease> = {}): DirectoryExecutionLease {
  return {
    canonicalHostPath: '/host/workspace/folder',
    backendGeneration: 'generation',
    expiresAt: Date.now() + 60_000,
    identity: { dev: '10', ino: '20', kind: 'directory' },
    current: () => true,
    ...overrides
  };
}

describe('button host command runner', () => {
  // compose only trusted configured bytes and wait for an exact exit marker
  it('uses the native namespace, private bounded output and command exit code', async () => {
    const root = await checkout('rac-button-runner-native-');
    const calls: Array<{ binary: string; args: string[] }> = [];
    const command = vi.fn(async (binary: string, args: string[]) => {
      calls.push({ binary, args });
      // publish the configured command result
      if (args.includes('new-session')) await writeFile(await marker(root), '7');
      return { code: 0, stdout: '' };
    });
    const runner = new HostCommandRunner({ projects: [] } as never, command, root, 1);

    const result = await runner.execute({ command: "printf '%s' configured", cwd: '/host/workspace', lease: lease() });

    expect(result).toEqual({ state: 'failed', exitCode: 7, error: 'command_failed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binary).toBe('/usr/bin/tmux');
    expect(calls[0]!.args).toContain(root);
    const script = calls[0]!.args.at(-1)!;
    expect(script).toContain('umask 077');
    expect(script).toContain("cd -- '/host/workspace'");
    expect(script).toContain("stat -Lc '%d:%i:%F'");
    expect(script).toContain("10:20:directory");
    expect(script).toContain('/usr/bin/tail -c 65536');
    expect(script).toContain("BASH_ENV= /bin/bash -c 'printf");
    expect(script).toContain("configured' >");
  });

  // map container paths and tmux through the explicit host bridge
  it('uses the bridged host checkout, tmux socket, binary and PATH', async () => {
    const root = await checkout('rac-button-runner-bridge-');
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host/tmux');
    vi.stubEnv('RAC_TMUX_BIN', '/host/bin/tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/console');
    vi.stubEnv('RAC_HOST_PATH', '/host/bin:/usr/bin');
    let observed: { binary: string; args: string[] } | undefined;
    const command = vi.fn(async (binary: string, args: string[]) => {
      observed = { binary, args };
      // complete through the local view of the shared marker
      if (args.includes('new-session')) await writeFile(await marker(root), '0');
      return { code: 0, stdout: '' };
    });
    const runner = new HostCommandRunner({ projects: [] } as never, command, root, 1);

    await expect(runner.execute({ command: 'echo bridged', cwd: '/host/project' })).resolves.toEqual({ state: 'complete', exitCode: 0 });
    expect(observed?.binary).toBe('/host/bin/tmux');
    expect(observed?.args.slice(0, 2)).toEqual(['-S', '/host/tmux/default']);
    expect(observed?.args).toContain('/host/console');
    expect(observed?.args.at(-1)).toMatch(/export PATH=.*\/host\/bin:\/usr\/bin/u);
    expect(observed?.args.at(-1)).toContain('/host/console/.data/button-actions/');
  });

  // refuse stale capabilities before creating a host process
  it('checks Files generation and expiry both before and after preparation', async () => {
    const root = await checkout('rac-button-runner-capability-');
    const command = vi.fn(async () => ({ code: 0, stdout: '' }));
    const runner = new HostCommandRunner({ projects: [] } as never, command, root, 1);
    const stale = lease({ current: () => false });
    await expect(runner.execute({ command: 'pwd', cwd: stale.canonicalHostPath, lease: stale })).resolves.toEqual({ state: 'failed', error: 'files_context_changed' });

    let checks = 0;
    const changed = lease({ current: () => ++checks === 1 });
    await expect(runner.execute({ command: 'pwd', cwd: changed.canonicalHostPath, lease: changed })).resolves.toEqual({ state: 'failed', error: 'files_context_changed' });
    expect(command).not.toHaveBeenCalled();
    expect(await readdir(join(root, '.data', 'button-actions'))).toEqual([]);
  });

  // distinguish start failure, lost marker and malformed terminal state
  it('never treats tmux disappearance or invalid markers as success', async () => {
    const startRoot = await checkout('rac-button-runner-start-');
    const start = new HostCommandRunner({ projects: [] } as never, async () => ({ code: 1, stdout: '' }), startRoot, 1);
    await expect(start.execute({ command: 'true', cwd: '/tmp' })).resolves.toEqual({ state: 'failed', error: 'command_start_failed' });
    expect(await readdir(join(startRoot, '.data', 'button-actions'))).toEqual([]);

    const lostRoot = await checkout('rac-button-runner-lost-');
    const lost = new HostCommandRunner({ projects: [] } as never, async (_binary, args) => ({ code: args.includes('has-session') ? 1 : 0, stdout: '' }), lostRoot, 1);
    await expect(lost.execute({ command: 'true', cwd: '/tmp' })).resolves.toEqual({ state: 'interrupted', error: 'command_status_lost' });

    const invalidRoot = await checkout('rac-button-runner-invalid-');
    const invalid = new HostCommandRunner({ projects: [] } as never, async (_binary, args) => {
      // publish an impossible shell status
      if (args.includes('new-session')) await writeFile(await marker(invalidRoot), '999');
      return { code: 0, stdout: '' };
    }, invalidRoot, 1);
    await expect(invalid.execute({ command: 'true', cwd: '/tmp' })).resolves.toEqual({ state: 'interrupted', error: 'command_status_invalid' });
  });

  // retain active work without an elapsed-time success fallback
  it('waits until shutdown when a live session has no exit marker', async () => {
    const root = await checkout('rac-button-runner-pending-');
    const command = vi.fn(async () => ({ code: 0, stdout: '' }));
    const runner = new HostCommandRunner({ projects: [] } as never, command, root, 1);
    const operation = runner.execute({ command: 'sleep forever', cwd: '/tmp' });
    await new Promise(resolve => setTimeout(resolve, 10));
    runner.close();

    await expect(operation).resolves.toEqual({ state: 'interrupted', error: 'server_stopped' });
    expect(command.mock.calls.filter(([, args]) => args.includes('has-session')).length).toBeGreaterThan(0);
  });

  // prove actual host execution waits for command exit and rejects a replaced directory
  it('runs on an owned tmux socket and validates directory identity after cd', async () => {
    const root = await checkout('rac-button-runner-real-');
    const socketDirectory = join(root, 'tmux');
    await mkdir(socketDirectory, { recursive: true });
    vi.stubEnv('RAC_HOST_TMUX_DIR', socketDirectory);
    vi.stubEnv('RAC_HOST_REPOSITORY', root);
    const startup = join(root, 'startup.sh');
    await writeFile(startup, 'cd /\n');
    // hostile inner startup files must not retarget the already verified cwd
    const command = async (binary: string, args: string[]) => {
      if (!args.includes('new-session')) return await run(binary, args);
      const guarded = [...args];
      guarded[guarded.length - 1] = `export BASH_ENV='${startup}'; ${guarded.at(-1)!}`;
      return await run(binary, guarded);
    };
    const runner = new HostCommandRunner({ projects: [] } as never, command, root, 10);
    const startedAt = Date.now();

    await expect(runner.execute({ command: `test "$PWD" = '${root}' || exit 77; sleep 0.1; exit 0`, cwd: root })).resolves.toEqual({ state: 'complete', exitCode: 0 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);

    const first = join(root, 'first');
    const second = join(root, 'second');
    const link = join(root, 'current');
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link);
    const identity = await stat(first, { bigint: true });
    await unlink(link);
    await symlink(second, link);
    const changed = lease({ canonicalHostPath: link, identity: { dev: String(identity.dev), ino: String(identity.ino), kind: 'directory' } });
    await expect(runner.execute({ command: 'pwd', cwd: link, lease: changed })).resolves.toEqual({ state: 'failed', exitCode: 125, error: 'command_failed' });

    // stop only the isolated socket if it still exists
    await execFileAsync('/usr/bin/tmux', ['-S', join(socketDirectory, 'default'), 'kill-server']).catch(() => undefined);
  }, 15_000);
});
