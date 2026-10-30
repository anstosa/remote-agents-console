import { execFileSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, readlink, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOverrideEnv } from '../git/overrides.js';
import type { SandboxSettings } from './types.js';

/**
 * The sandbox policy of a Sandboxed Pi Agent (ADR 0004), free of Pi so it is tested on its own.
 * The console renders the static part at boot (`sandbox.json`); the RAC Pi extension adds the
 * session's own paths, hands the result to the sandbox runtime for `bash`, and checks the file
 * tools' paths against it, since those run in Pi's own process.
 */

/**
 * `sandbox.json`: what the sandbox runtime takes, the names a command's environment adds, and the
 * console's repositories (its Projects and its own checkout), which a writable folder may not hold.
 */
export type SandboxPolicy = {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  env: string[];
  repositories: string[];
};
/** The policy the console renders from a kind's sandbox settings. */
export const staticPolicy = (settings: SandboxSettings): SandboxPolicy => ({
  network: { allowedDomains: settings.allowedDomains, deniedDomains: settings.deniedDomains },
  filesystem: { denyRead: settings.denyRead, allowWrite: settings.allowWrite, denyWrite: settings.denyWrite },
  env: settings.env,
  repositories: settings.repositories ?? []
});
/**
 * One session's own paths: its Worktree, Pi's state directory, its git directories (`dir` is a
 * linked Worktree's admin directory, or the repository's own `.git` like `commonDir`), its temp
 * directory and tmux socket.
 */
export type SessionPaths = { cwd: string; stateDir: string; git?: { dir: string; commonDir: string }; tempDir: string; tmuxSocket?: string };

// what in Pi's state directory holds credentials, may hold literal keys, or holds other
// Conversations
const piSecrets = ['auth.json', 'oauth.json', 'mcp-auth.json', 'models.json', 'mcp.json', 'sessions'];
// the operator's other credentials a command never needs
const homeSecrets = ['.ssh', '.gnupg', '.aws', '.config/gh', '.claude/.credentials.json', '.codex/auth.json'];
/** What in a repository's git directory configures git, runs code, or points git elsewhere. */
export const gitDirections = ['config', 'config.worktree', 'hooks', 'info', 'modules', 'commondir', 'worktrees', 'remotes', 'branches'];
// what other tools run code from, as the sandbox runtime protects it from commands: these names
// anywhere in the Worktree, and anything in these folders
const runsCode = { files: ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'], folders: ['.git', '.vscode', '.idea', '.claude/commands', '.claude/agents'] };

/**
 * The session's policy: the Worktree and a temp directory become writable (never the home
 * directory itself or a folder above it, whose dotfiles configure the operator's own shells and
 * git, nor a folder holding one of the console's repositories, whose git the console runs); Pi's state, the Worktree's `.pi`, Claude's settings there and the tmux socket stay
 * protected; Pi's and the operator's credentials and the tmux socket are unreadable.
 *
 * A command may commit, but nothing it writes may configure or redirect git, because the console
 * runs git in the Worktree unsandboxed later. In a repository's own checkout its git directory is
 * writable except `gitDirections` (its own `commondir` must exist: a deny on a missing path leaves
 * an empty placeholder, which stops git). A linked Worktree writes its shared objects, refs and logs
 * and its own admin directory, except the files there that point git elsewhere or configure it, and
 * its `.git` file cannot be repointed; the shared directory's other files, its `packed-refs`
 * included, stay read-only, since making it writable would let a command add a Worktree to it.
 * Outside a repository a command may not make one. A `.git` cannot be moved aside and replaced:
 * a repository's git directory is a write root of its own and a `.git` file a deny, and the
 * sandbox runtime binds each, so each is a mount point the kernel will not rename or remove.
 */
export function sessionPolicy(policy: SandboxPolicy, session: SessionPaths): SandboxPolicy {
  const { git } = session;
  const linked = git !== undefined && git.dir !== git.commonDir;
  const socket = session.tmuxSocket === undefined ? [] : [session.tmuxSocket];
  const cwd = canonical(session.cwd);
  const holds = (path: string) => isUnder(canonical(path), cwd);
  const writable = holds(homedir()) || policy.repositories.some(repository => canonical(repository) !== cwd && holds(repository)) ? [] : [session.cwd];
  // a linked Worktree's `.git` file, or the `.git` a command would make outside any repository; a
  // deny on a missing path leaves a placeholder in its place, which no git outside a repository reads
  const gitFile = linked && existsSync(join(session.cwd, '.git')) || git === undefined ? [join(session.cwd, '.git')] : [];
  const gitWrites = git === undefined || writable.length === 0 ? [] : linked ? [...['objects', 'refs', 'logs'].map(name => join(git.commonDir, name)), git.dir] : [git.dir];
  const gitDenies = git === undefined ? [] : linked ? ['commondir', 'gitdir', 'config.worktree', 'modules'].map(name => join(git.dir, name)) : gitDirections.map(name => join(git.dir, name));
  return {
    network: policy.network,
    filesystem: {
      denyRead: [...policy.filesystem.denyRead, ...piSecrets.map(name => join(session.stateDir, name)), ...homeSecrets.map(name => join(homedir(), name)), ...socket],
      allowWrite: [...policy.filesystem.allowWrite, ...writable, ...gitWrites, session.tempDir],
      denyWrite: [...policy.filesystem.denyWrite, session.stateDir, join(session.cwd, '.pi'), join(session.cwd, '.claude', 'settings.json'), join(session.cwd, '.claude', 'settings.local.json'), ...gitFile, ...gitDenies, ...socket]
    },
    env: policy.env,
    repositories: policy.repositories
  };
}

/**
 * The checkout's git directory and git's common directory (the same one outside a linked Worktree).
 * What the policy protects in a repository's own git directory must exist to be protected in place
 * (a deny on a missing path leaves a placeholder that git stumbles on), so it is made: `.` is the
 * `commondir` git takes when there is none, and the folders are empty.
 */
export function sessionGit(cwd: string): Pick<SessionPaths, 'git'> {
  let dirs: string[];
  try {
    dirs = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, env: { ...process.env, ...gitOverrideEnv() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().split('\n');
  } catch { return {}; }
  const [dir, commonDir] = dirs;
  if (dir === undefined || dir === '' || commonDir === undefined || commonDir === '') return {};
  if (dir === commonDir) {
    if (!existsSync(join(dir, 'commondir'))) writeFileSync(join(dir, 'commondir'), '.\n', { flag: 'wx' });
    for (const folder of ['hooks', 'info', 'modules', 'worktrees', 'remotes', 'branches']) mkdirSync(join(dir, folder), { recursive: true });
  }
  return { git: { dir, commonDir } };
}
/** Pi's state directory, as Pi's own `getAgentDir` reads it from its environment. */
export const piStateDir = (env: NodeJS.ProcessEnv): string => env.PI_CODING_AGENT_DIR === undefined || env.PI_CODING_AGENT_DIR === '' ? join(homedir(), '.pi', 'agent') : expandHome(env.PI_CODING_AGENT_DIR);

/**
 * The policy of a session in `cwd`: the rendered one in `policyFile` with the session's own paths,
 * its state directory and temp directory given, its git and tmux socket found.
 */
export const sessionPolicyFrom = (policyFile: string, { cwd, stateDir, tempDir }: Pick<SessionPaths, 'cwd' | 'stateDir' | 'tempDir'>, env: NodeJS.ProcessEnv): SandboxPolicy =>
  sessionPolicy(JSON.parse(readFileSync(policyFile, 'utf8')) as SandboxPolicy, { cwd, stateDir, ...sessionGit(cwd), tempDir, ...sessionTmuxSocket(env) });

/** The socket of the tmux server a process runs in (`TMUX` is `<socket>,<pid>,<session>`). */
export function sessionTmuxSocket(env: NodeJS.ProcessEnv): Pick<SessionPaths, 'tmuxSocket'> {
  const socket = env.TMUX?.split(',')[0];
  return socket === undefined || socket === '' ? {} : { tmuxSocket: socket };
}

const expandHome = (path: string): string => path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
// a path as Pi's file tools read it (`resolveToCwd`): spaces normalised, a leading `@` dropped,
// `~` and `file://` expanded, then resolved against the session's cwd
function toolPath(raw: string, cwd: string): string {
  let path = expandHome(raw.replace(/\p{Zs}/gu, ' ').replace(/^@/u, ''));
  if (path.startsWith('file://')) path = fileURLToPath(path);
  return resolve(cwd, path);
}
// the other spellings Pi's `read` tries when a path is missing (macOS screenshot names)
const readVariants = (path: string): string[] => {
  const curly = (value: string) => value.replaceAll("'", String.fromCharCode(0x2019));
  return [path, path.replace(/ (AM|PM)\./giu, `${String.fromCharCode(0x202f)}$1.`), path.normalize('NFD'), curly(path), curly(path.normalize('NFD'))];
};
// a path with every symlink resolved, as far as it exists; a link to a missing file resolves to
// where writing through it would land
function canonical(path: string, links = 0): string {
  const absolute = resolve(expandHome(path));
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const link = links < 40 && (() => { try { return lstatSync(absolute).isSymbolicLink(); } catch { return false; } })();
    return link ? canonical(resolve(parent, readlinkSync(absolute)), links + 1) : join(canonical(parent, links), basename(absolute));
  }
}
const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const underAny = (path: string, roots: readonly string[]): boolean => roots.some(root => isUnder(path, canonical(root)));

/**
 * Why a file tool's call breaks the policy, or `undefined` when it may run. `read` may not read a
 * denied path; `write` and `edit` must land under a writable root and outside the protected ones;
 * `grep`, `find` and `ls` may not search at, in, or above a denied path. Other tools pass.
 */
export function pathRefusal(tool: string, input: Record<string, unknown>, cwd: string, policy: SandboxPolicy): string | undefined {
  const searches = tool === 'grep' || tool === 'find' || tool === 'ls';
  if (!searches && tool !== 'read' && tool !== 'write' && tool !== 'edit') return undefined;
  const raw = input.path ?? (searches ? '.' : undefined);
  if (typeof raw !== 'string') return `${tool} needs a path`;
  const denied = deniedReads(policy);
  const unreadable = `${raw} is not readable in the sandbox`;
  if (tool === 'read') return readVariants(toolPath(raw, cwd)).some(path => underAny(canonical(path), denied)) ? unreadable : undefined;
  const path = canonical(toolPath(raw, cwd));
  if (searches) return underAny(path, denied) || denied.some(root => isUnder(canonical(root), path)) ? unreadable : undefined;
  const reason = unwritable(path, cwd, policy);
  return reason === undefined ? undefined : `${raw} ${reason}`;
}

// the file tools run in Pi's own process, whose /proc shows its environment and every other
// process's; a command's /proc is the sandbox's own
const deniedReads = (policy: SandboxPolicy): string[] => [...policy.filesystem.denyRead, '/proc'];
// why a file tool may not write `path`, whose links are resolved, or `undefined` when it may
function unwritable(path: string, cwd: string, policy: SandboxPolicy): string | undefined {
  if (!underAny(path, policy.filesystem.allowWrite)) return 'is outside the paths the sandbox may write';
  const inWorktree = relative(canonical(cwd), path);
  const runsCodeHere = !inWorktree.startsWith('..') && (runsCode.files.includes(basename(path)) || runsCode.folders.some(folder => `${sep}${inWorktree}${sep}`.includes(`${sep}${folder}${sep}`)));
  return runsCodeHere || underAny(path, policy.filesystem.denyWrite) ? 'is protected in the sandbox' : undefined;
}

/**
 * The operations Pi's `read`, `write` and `edit` run with in a Sandboxed session. `pathRefusal`
 * checks a path before a tool runs, but a command running beside it (a Watch's, or code mode's
 * nested `bash`) could swap a link in between, so each of these opens the file first and checks
 * where the opened file really is. A new file or folder is made in the folder that was checked,
 * never through a link, and nothing is truncated before its check.
 */
export function fileOperations(session: () => { policy: SandboxPolicy; cwd: string } | undefined) {
  const loaded = () => {
    const current = session();
    if (current === undefined) throw new Error('The sandbox policy is not loaded');
    return current;
  };
  // `path` opened, unless `refusal` refuses where the opened file really is
  const openChecked = async (path: string, flags: number, refusal: (real: string) => string | undefined): Promise<FileHandle> => {
    const handle = await open(path, flags);
    try {
      const reason = refusal(await readlink(`/proc/self/fd/${handle.fd}`));
      if (reason !== undefined) throw new Error(`${path} ${reason}`);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  };
  const readable = (real: string) => underAny(real, deniedReads(loaded().policy)) ? 'is not readable in the sandbox' : undefined;
  const writable = (real: string) => { const { policy, cwd } = loaded(); return unwritable(real, cwd, policy); };
  // `use` given `path` as a name in its parent folder, opened and checked with that name in it
  const inParent = async <T>(path: string, use: (named: string) => Promise<T>): Promise<T> => {
    const parent = await openChecked(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY, real => writable(join(real, basename(path))));
    try { return await use(`/proc/self/fd/${parent.fd}/${basename(path)}`); } finally { await parent.close(); }
  };
  /** `use` given the file at `path` opened and checked readable, by a name no command can swap. */
  const read = async <T>(path: string, use: (opened: string) => Promise<T>): Promise<T> => {
    const handle = await openChecked(path, constants.O_RDONLY, readable);
    try { return await use(`/proc/self/fd/${handle.fd}`); } finally { await handle.close(); }
  };
  const makeDir = async (dir: string): Promise<void> => {
    try { await stat(dir); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(dir) !== dir) await makeDir(dirname(dir));
    await inParent(dir, named => mkdir(named)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  };
  return {
    read,
    readFile: (path: string): Promise<Buffer> => read(path, opened => readFile(opened)),
    async writeFile(path: string, content: string): Promise<void> {
      let handle: FileHandle;
      try {
        handle = await openChecked(path, constants.O_WRONLY | constants.O_NONBLOCK, writable);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        handle = await inParent(path, named => open(named, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666));
      }
      try { await handle.truncate(0); await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
    },
    mkdir: async (dir: string): Promise<void> => { loaded(); await makeDir(dir); }
  };
}

// what every sandboxed command keeps of the environment, besides `LC_*` and the policy's names
const baseEnv = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR']);
/** A sandboxed command's environment: the base names, `LC_*` and `names`, nothing else (no keys, no tokens). */
export const commandEnv = (source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && (baseEnv.has(name) || name.startsWith('LC_') || names.includes(name))));
