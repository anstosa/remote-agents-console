import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellPath } from '../src/tmux/interactive-shell.js';

const previousInteractiveShell = process.env.RAC_INTERACTIVE_SHELL;
const previousHostInteractiveShell = process.env.RAC_HOST_INTERACTIVE_SHELL;
const homes: string[] = [];

// restore shared runtime configuration
afterEach(async () => {
  if (previousInteractiveShell === undefined) delete process.env.RAC_INTERACTIVE_SHELL;
  else process.env.RAC_INTERACTIVE_SHELL = previousInteractiveShell;
  if (previousHostInteractiveShell === undefined) delete process.env.RAC_HOST_INTERACTIVE_SHELL;
  else process.env.RAC_HOST_INTERACTIVE_SHELL = previousHostInteractiveShell;
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

const fish = ['/usr/bin/fish', '/usr/local/bin/fish', '/home/linuxbrew/.linuxbrew/bin/fish'].find(path => existsSync(path));

// run a bootstrap the way a pane does (`<shell> -lc`) in a HOME whose rc file sets MARKER
async function runBootstrap(shell: string, rc: string, command: string, stay = false, input = ''): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'rac-shell-'));
  homes.push(home);
  await mkdir(join(home, '.config', 'fish'), { recursive: true });
  await writeFile(join(home, rc), shell.endsWith('fish') ? 'set -gx MARKER rc\n' : 'export MARKER=rc\n');
  return execFileSync(shell, ['-lc', interactiveShellBootstrap(command, home, shell, stay)], { env: { PATH: '/usr/bin:/bin', TERM: 'dumb' }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
}

const probe = `printf '%s|%s|%s\\n' "$MARKER" "\${RAC_AGENT_COMMAND-unset}" "it's"`;

describe('interactive agent shell', () => {
  it('execs the command from an interactive zsh, carrying it in the environment', () => {
    const command = "cd -- '/home/ubuntu/dave' && eval 'detach && new task-1'";
    const bootstrap = interactiveShellBootstrap(command);

    expect(interactiveShellPath()).toBe('/usr/bin/zsh');
    expect(hostInteractiveShellPath()).toBe('/usr/bin/zsh');
    expect(bootstrap).toBe([
      `export RAC_AGENT_COMMAND='cd -- '\\''/home/ubuntu/dave'\\'' && eval '\\''detach && new task-1'\\'''`,
      `exec '/usr/bin/zsh' -i -c 'exec sh -c '\\''cmd=$RAC_AGENT_COMMAND; unset RAC_AGENT_COMMAND; eval "$cmd"'\\'''`
    ].join('\n'));
  });

  it('sets the host home before the shell loads the operator configuration', () => {
    expect(interactiveShellBootstrap('codex', '/home/ubuntu').startsWith("export HOME='/home/ubuntu'\n")).toBe(true);
    expect(interactiveShellBootstrap('codex', '/home/ubuntu', '/usr/bin/fish').startsWith("set -gx HOME '/home/ubuntu'\n")).toBe(true);
  });

  it('starts the interactive shell alone when there is no command', () => {
    expect(interactiveShellBootstrap('', '/home/ubuntu')).toBe("export HOME='/home/ubuntu'\nexec '/usr/bin/zsh' -i");
  });

  it('refuses a shell it has no startup contract for', () => {
    expect(() => interactiveShellBootstrap('codex', '$HOME', '/bin/dash')).toThrow('unsupported interactive shell');
  });

  it('runs the command after .bashrc loads, unset from its environment, then exits with it', async () => {
    process.env.RAC_INTERACTIVE_SHELL = '/bin/bash';
    expect(interactiveShellPath()).toBe('/bin/bash');
    expect(await runBootstrap('/bin/bash', '.bashrc', probe, false, 'echo resumed\n')).toBe("rc|unset|it's\n");
  });

  it('returns to an interactive bash after the command when asked to stay', async () => {
    const output = await runBootstrap('/bin/bash', '.bashrc', probe, true, 'echo "after:$MARKER:${RAC_AGENT_COMMAND-unset}"\n');
    expect(output).toContain("rc|unset|it's\n");
    expect(output).toContain('after:rc:unset');
  });

  it.skipIf(fish === undefined)('runs the POSIX command after config.fish loads, then exits with it', async () => {
    expect(await runBootstrap(fish!, '.config/fish/config.fish', probe, false, 'echo resumed\n')).toBe("rc|unset|it's\n");
  });

  // a quoted word inside an already-quoted command puts a backslash next to a quote, which fish
  // reads differently from POSIX inside single quotes
  it.skipIf(fish === undefined)('carries an already-quoted command through fish unchanged', async () => {
    expect(await runBootstrap(fish!, '.config/fish/config.fish', `sh -c 'printf "%s\\n" "it'\\''s"'`)).toBe("it's\n");
  });

  it.skipIf(fish === undefined)('returns to an interactive fish after the command when asked to stay', async () => {
    const output = await runBootstrap(fish!, '.config/fish/config.fish', probe, true, 'echo after:$MARKER:(set -q RAC_AGENT_COMMAND; and echo set; or echo unset)\n');
    expect(output).toContain("rc|unset|it's\n");
    expect(output).toContain('after:rc:unset');
  });
});
