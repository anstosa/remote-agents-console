import { basename } from 'node:path';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// resolve the container-managed interactive shell
export function interactiveShellPath(): string {
  return process.env.RAC_INTERACTIVE_SHELL?.trim() || '/usr/bin/zsh';
}

// resolve the shell path visible to the host tmux server
export function hostInteractiveShellPath(): string {
  return process.env.RAC_HOST_INTERACTIVE_SHELL?.trim() || interactiveShellPath();
}

// match tmux's pane_current_command value
export function interactiveShellName(shell: string): string {
  return basename(shell);
}

// restore the explicitly configured host environment
export function hostCommand(command: string, home: string, path = process.env.RAC_HOST_PATH?.trim()): string {
  const pathExport = path ? `export PATH=${quote(path)}\n` : '';
  return `export HOME=${quote(home)}\n${pathExport}${command}`;
}

// Evaluate the POSIX command carried in the environment, unset first so the program never
// inherits it. It reads the same in zsh, bash and fish, so one bootstrap serves all three.
const runCommand = `sh -c 'cmd=$RAC_AGENT_COMMAND; unset RAC_AGENT_COMMAND; eval "$cmd"'`;

// Start the operator's interactive shell — `-i` loads `.zshrc`, `.bashrc` or `config.fish`, which
// restore the PATH and credentials `safeEnv()` strips — and have it exec `command`, so the command
// becomes the pane's process and the pane closes with it. With `stay` the shell runs the command
// and then becomes a fresh interactive shell (New Task's session outlives its script); an empty
// command is that shell alone. The command travels in the environment, never in `ps` argv.
export function interactiveShellBootstrap(command: string, home = '$HOME', shell = interactiveShellPath(), stay = false): string {
  const name = interactiveShellName(shell);
  if (name !== 'zsh' && name !== 'bash' && name !== 'fish') throw new Error(`unsupported interactive shell: ${shell}`);
  // fish reads `\\` and `\'` as escapes inside single quotes, where POSIX shells read them literally
  const q = name === 'fish' ? (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : quote;
  const exported = (variable: string, value: string) => name === 'fish' ? `set -gx ${variable} ${q(value)}` : `export ${variable}=${q(value)}`;
  const interactive = `${q(shell)} -i`;
  const start = command === '' ? `exec ${interactive}`
    : stay ? `exec ${interactive} -c ${q(`${runCommand}; exec env -u RAC_AGENT_COMMAND ${interactive}`)}`
    : `exec ${interactive} -c ${q(`exec ${runCommand}`)}`;
  return [...(home === '$HOME' ? [] : [exported('HOME', home)]), ...(command === '' ? [] : [exported('RAC_AGENT_COMMAND', command)]), start].join('\n');
}
