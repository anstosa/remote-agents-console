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

// preserve literal paths and commands in the selected shell's syntax
export function interactiveShellQuote(value: string, shell = ''): string {
  return interactiveShellName(shell) === 'fish' ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : quote(value);
}

// assign exported variables without depending on interactive shell functions
const shellExport = (variable: string, value: string, shell = '') => interactiveShellName(shell) === 'fish'
  ? `set -gx ${variable} ${interactiveShellQuote(value, shell)}`
  : `export ${variable}=${quote(value)}`;

// restore the explicitly configured host environment
export function hostCommand(command: string, home: string, path = process.env.RAC_HOST_PATH?.trim(), shell?: string): string {
  const pathExport = path ? `${shellExport('PATH', path, shell)}\n` : '';
  return `${shellExport('HOME', home, shell)}\n${pathExport}${command}`;
}

// Evaluate the POSIX command carried in the environment, unset first so the program never
// inherits it. It reads the same in zsh, bash and fish, so one bootstrap serves all three.
const runCommand = `sh -c 'cmd=$RAC_AGENT_COMMAND; unset RAC_AGENT_COMMAND; eval "$cmd"'`;

// Start the operator's interactive shell — `-i` loads `.zshrc`, `.bashrc` or `config.fish`, which
// restore the PATH and credentials `safeEnv()` strips — and have it exec `command`, so the command
// becomes the pane's process and the pane closes with it. With `stay` the native shell evaluates
// the command with its aliases and functions, then becomes a fresh interactive shell; an empty
// command is that shell alone. The command travels in the environment, never in `ps` argv.
export function interactiveShellBootstrap(command: string, home = '$HOME', shell = interactiveShellPath(), stay = false): string {
  const name = interactiveShellName(shell);
  if (name !== 'zsh' && name !== 'bash' && name !== 'fish') throw new Error(`unsupported interactive shell: ${shell}`);
  // use the same quoting for the bootstrap and its carried native command
  const q = (value: string) => interactiveShellQuote(value, shell);
  const nativeCommand = name === 'fish'
    ? 'set -l cmd $RAC_AGENT_COMMAND; set -e RAC_AGENT_COMMAND; eval $cmd'
    : 'cmd=$RAC_AGENT_COMMAND; unset RAC_AGENT_COMMAND; eval "$cmd"';
  const interactive = `${q(shell)} -i`;
  const start = command === '' ? `exec ${interactive}`
    : stay ? `exec ${interactive} -c ${q(`${nativeCommand}; exec env -u RAC_AGENT_COMMAND ${interactive}`)}`
    : `exec ${interactive} -c ${q(`exec ${runCommand}`)}`;
  return [...(home === '$HOME' ? [] : [shellExport('HOME', home, shell)]), ...(command === '' ? [] : [shellExport('RAC_AGENT_COMMAND', command, shell)]), start].join('\n');
}
