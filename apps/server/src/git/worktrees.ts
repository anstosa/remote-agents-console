import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { run } from '../tmux/command.js';

/**
 * One checkout as `git worktree list --porcelain` reports it, before the console
 * canonicalises the path or derives a label. `branch` is the short name (git
 * prints `refs/heads/<name>`); it is absent for a detached HEAD or a bare entry.
 * `bare` marks the repository's bare entry (never a Worktree). `prunable` marks a
 * checkout whose directory is gone — hidden and never auto-pruned (ADR 0003).
 */
export type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
};

/** The injectable git runner, so discovery and config validation can stub it in tests. */
export type GitRun = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const defaultRun: GitRun = (command, args) => run(command, args);
/**
 * How to name a repository to git: a bare one by its git directory, since the console's git does
 * not discover bare repositories (`safe.bareRepository=explicit`); anything else by `-C`, so git
 * fails on a checkout whose `.git` is broken rather than adopting what was planted there. Whether
 * it is bare comes from the path the operator configured (named `*.git`, with no `.git` inside),
 * never from the folder's contents, which a Sandboxed Agent may have written.
 */
export const repositoryArgs = (path: string): string[] => basename(path).endsWith('.git') && !existsSync(join(path, '.git')) ? ['--git-dir', path] : ['-C', path];

// strip a `refs/heads/` prefix to the short branch name git prints elsewhere
function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Parse `git worktree list --porcelain` into one entry per checkout. Entries are
 * blank-line separated; each attribute is its own line (`worktree <path>` first,
 * then `HEAD`, `branch`/`detached`, and optional `bare`/`locked`/`prunable`, the
 * last two carrying an optional trailing reason). Pure: no filesystem access, so
 * the caller canonicalises paths.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split('\n')) {
    if (line === '') { if (current !== undefined) { entries.push(current); current = undefined; } continue; }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') { current = { path: value, detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (current === undefined) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = shortBranch(value);
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') { current.locked = true; if (value !== '') current.lockedReason = value; }
    else if (key === 'prunable') { current.prunable = true; if (value !== '') current.prunableReason = value; }
  }
  // the porcelain output ends the last entry with a blank line, but tolerate its absence
  if (current !== undefined) entries.push(current);
  return entries;
}

/**
 * The repository's common git directory (realpath'd) — the Project identity: two
 * Projects that resolve to the same common dir are the same repository (ADR 0003).
 * `undefined` when `path` is not inside a git repository, which the caller turns
 * into an unavailable Project rather than a boot failure.
 */
export async function gitCommonDir(path: string, command: GitRun = defaultRun): Promise<string | undefined> {
  const result = await command('/usr/bin/git', [...repositoryArgs(path), 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (result.code !== 0) return undefined;
  const dir = result.stdout.trim();
  if (dir === '') return undefined;
  return await realpath(dir).catch(() => dir);
}

/** Every checkout git lists for the repository at `path`, or `undefined` when git fails. */
export async function listWorktrees(path: string, command: GitRun = defaultRun): Promise<WorktreeEntry[] | undefined> {
  const result = await command('/usr/bin/git', [...repositoryArgs(path), 'worktree', 'list', '--porcelain']);
  if (result.code !== 0) return undefined;
  return parseWorktreeList(result.stdout);
}
