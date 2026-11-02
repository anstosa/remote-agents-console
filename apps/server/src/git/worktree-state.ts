import { run } from '../tmux/command.js';

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
