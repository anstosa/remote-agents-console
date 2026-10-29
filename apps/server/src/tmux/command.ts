import { lstat, realpath } from 'node:fs/promises';
import type { SocketRef } from '../domain/models.js';
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { gitOverrideEnv } from '../git/overrides.js';
import { interactiveShellPath } from './interactive-shell.js';
// the tmux binary the console runs; read at call time so tests can stub the env
export const tmuxBinary = (): string => process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
// reconnects must not attach a replacement server under an older agent identity
export async function socketIsCurrent(socket: SocketRef): Promise<boolean> {
  const info = await lstat(socket.path).catch(() => undefined);
  return info !== undefined && info.isSocket() && info.dev === socket.device && info.ino === socket.inode;
}
// tmux pane and session identifiers, validated before they are put in a command
export const paneIdPattern = /^%\d+$/u;
export const sessionIdPattern = /^\$?[-\w.]+$/u;
// the one capture-pane invocation the log view uses, over either transport: spawned as
// argv by the adapter, or joined into a control-connection command (ADR 0008). Both must
// stay byte-identical, so the flags live here. The pane is validated by the caller.
export const capturePaneArgs = (pane: string, depth: number): string[] => ['capture-pane', '-e', '-p', '-t', pane, '-S', `-${depth}`];
// tmux reads any argv element ending in `;` as a command separator and drops the `;`;
// escaping it as `\;` keeps a value such as a checkout path whole
export const tmuxLiteralArg = (value: string): string => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
// A `-c` start directory or a `-s` session name is format-expanded, so a `#(…)` in one
// derived from an agent-controlled checkout path would run as a shell command inside the tmux
// server. Doubling every `#` makes tmux collapse it back to the literal text (as `runShell`
// does for its command).
export const tmuxFormatLiteral = (value: string): string => tmuxLiteralArg(value.replaceAll('#', '##'));
// `pipe-pane` runs its shell command through strftime before format expansion, so a `%` is
// doubled as well as a `#` for the command to reach the shell as written
export const tmuxTimeFormatLiteral = (value: string): string => tmuxFormatLiteral(value.replaceAll('%', '%%'));
// build one restricted subprocess environment; SHELL names the console's interactive shell,
// resolved by the one reader of RAC_INTERACTIVE_SHELL
export const safeEnv = (): NodeJS.ProcessEnv => { const user = userInfo(); return { HOME: user.homedir, USER: user.username, LOGNAME: user.username, SHELL: interactiveShellPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' }; };
/** The environment of the console's own git: `safeEnv` with what a Worktree's repository cannot override. */
export const gitEnv = (): NodeJS.ProcessEnv => ({ ...safeEnv(), ...gitOverrideEnv() });
// the variables tmux sets on the process it starts in a pane, naming that pane
const paneVariables = ['TMUX', 'TMUX_PANE'] as const;
/**
 * The environment for the shell a launch runner starts inside a tmux pane: the
 * restricted `safeEnv` plus the `TMUX`/`TMUX_PANE` pair tmux set on the runner
 * itself. An Agent's reporter hook (ADR 0001) writes `@rac_attention` and
 * `@rac_session` on `$TMUX_PANE` and exits silently without it, so dropping the
 * pair with the rest of the runner's environment left every runner-started Claude
 * unable to report its state or name its Conversation. Only those two pass through; the
 * console's secrets and everything else stay out. `source` is the runner's own
 * environment (a seam for tests; the runner runs under tmux, not the console).
 */
export const paneEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env = safeEnv();
  for (const name of paneVariables) { const value = source[name]; if (value !== undefined && value !== '') env[name] = value; }
  return env;
};
type RunResult = { code: number; stdout: string; stderr: string; timedOut?: true };
// git subcommands that change a checkout, its branches or its stashes
const gitWrites = new Set(['add', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'fetch', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'rm', 'stash', 'submodule', 'switch', 'update-ref', 'worktree']);
// the `-C` checkout and subcommand of a git argv; a `--git-dir` call names its repository outright
function gitTarget(args: string[]): { path: string; subcommand: string } | undefined {
  let path: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '-C') path = args[++index];
    else if (arg === '-c') index++;
    else if (arg.startsWith('--git-dir')) return undefined;
    else if (!arg.startsWith('-')) return path === undefined ? undefined : { path, subcommand: arg };
  }
  return undefined;
}
// A command can break a checkout's .git (ADR 0004), and git then walks up to the repository
// around it, so a reset or clean meant for the checkout would land on that one. A git call that
// writes runs only when the checkout it names is the top of its own work tree.
async function misdirectedGit(command: string, args: string[], timeoutMs: number): Promise<RunResult | undefined> {
  const target = gitTarget(args);
  if (target === undefined || !gitWrites.has(target.subcommand)) return undefined;
  const top = await run(command, ['-C', target.path, 'rev-parse', '--show-toplevel'], undefined, timeoutMs);
  const found = top.code === 0 ? top.stdout.trim() : '';
  const [actual, expected] = await Promise.all([found, target.path].map(path => realpath(path).catch(() => undefined)));
  if (actual !== undefined && actual === expected) return undefined;
  return { code: 128, stdout: '', stderr: `refusing to run git ${target.subcommand} in ${target.path}: its repository is ${found === '' ? 'not a work tree' : `at ${found}`}\n` };
}
// stdout and stderr decode as UTF-8 streams, so a character split between two pipe reads survives
export async function run(command: string, args: string[], input?: string, timeoutMs = 5000): Promise<RunResult> {
  const refusal = basename(command) === 'git' ? await misdirectedGit(command, args, timeoutMs) : undefined;
  if (refusal !== undefined) return refusal;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: basename(command) === 'git' ? gitEnv() : safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // distinguish a deadline kill from other signal interruptions
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-1_000_000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-16_384); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
    // close stdin even when no payload is supplied
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
