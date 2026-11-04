import { run } from '../tmux/command.js';
import { objectId } from './comparison.js';

export type GitCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string; stdoutTruncated?: true }>;

export async function cleanAndPushedOrDetached(workspace: string, command: GitCommand = run): Promise<boolean> {
  const status = await command('/usr/bin/git', ['-C', workspace, 'status', '--porcelain=v1']);
  if (status.code !== 0 || status.stdout.trim()) return false;
  const branch = await command('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--quiet', 'HEAD']);
  if (branch.code !== 0) return true;
  const remoteRefs = await command('/usr/bin/git', ['-C', workspace, 'for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/origin/']);
  if (remoteRefs.code === 0 && remoteRefs.stdout.trim()) return true;
  const upstream = await command('/usr/bin/git', ['-C', workspace, 'for-each-ref', '--format=%(upstream:track)', branch.stdout.trim()]);
  return upstream.code === 0 && upstream.stdout.trim() === '[gone]';
}

// The branch switch/move readiness gate. A clean working tree is sufficient — unlike
// cleanAndPushedOrDetached this does NOT require the current branch to be pushed.
// `git switch` and the move transaction never rewrite the branch you leave: its commits
// stay on the ref and are recoverable by switching back, so an unpushed named branch is
// safe to leave. A clean tree always sits on a named branch or a detached HEAD, both fine.
export async function cleanWorkingTree(workspace: string, command: GitCommand = run): Promise<boolean> {
  const status = await command('/usr/bin/git', ['-C', workspace, 'status', '--porcelain=v1']);
  return status.code === 0 && status.stdout.trim() === '';
}

// how a branch at `head` can reach `target` without losing work that exists only here
export type HeadUpdate = 'fast-forward' | 'reset' | 'local-commits';

// Fast-forward when `head` is behind `target` (a `target` not fetched yet never is). Otherwise reset
// only when every commit on `head` was once on `remoteRef` here: behind its current value, a value
// its reflog records (the newest 100 updates, and the value the oldest of them replaced, which a
// clone leaves unlogged) or one of `seen` (its value before a fetch, for a repository with no reflog). Commits that
// were never pushed or fetched make it `local-commits`.
export async function headUpdate(workspace: string, head: string, target: string, remoteRef: string, seen: string[] = [], command: GitCommand = run): Promise<HeadUpdate> {
  if (objectId.test(target) && (await command('/usr/bin/git', ['-C', workspace, 'merge-base', '--is-ancestor', head, target])).code === 0) return 'fast-forward';
  const logged = await command('/usr/bin/git', ['-C', workspace, 'log', '--walk-reflogs', '--format=%H', '--max-count=100', remoteRef, '--']);
  const values = logged.code === 0 ? logged.stdout.split('\n').filter(line => line !== '') : [];
  const [current, replaced] = await Promise.all([`${remoteRef}^{commit}`, `${remoteRef}@{${values.length}}`].map(revision => command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', revision])));
  const known = [...new Set([...seen, ...values, ...[current, replaced].map(found => found?.code === 0 ? found.stdout.trim() : '')])].filter(sha => objectId.test(sha));
  if (known.length === 0) return 'local-commits';
  const outside = await command('/usr/bin/git', ['-C', workspace, 'rev-list', '--count', '--ignore-missing', head, '--not', ...known]);
  return outside.code === 0 && outside.stdout.trim() === '0' ? 'reset' : 'local-commits';
}
