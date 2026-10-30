import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { gitPublication } from '../src/discovery/service.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const git = async (path: string, ...args: string[]): Promise<string> => {
  const result = await run('/usr/bin/git', ['-C', path, ...args]);
  if (result.code !== 0) throw new Error(result.stdout);
  return result.stdout.trim();
};

// a checkout with an origin remote and one commit, whose remote-tracking refs the test sets by hand
async function checkout(): Promise<{ root: string; head: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-publication-')));
  directories.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/octo/repo.git');
  await git(root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'initial');
  return { root, head: await git(root, 'rev-parse', 'HEAD') };
}

describe('whether a branch is published', () => {
  it('counts an origin ref, pushed without an upstream, and names its commit', async () => {
    const { root, head } = await checkout();
    await git(root, 'branch', 'feature');
    await git(root, 'update-ref', 'refs/remotes/origin/feature', head);
    await expect(gitPublication(root, 'feature')).resolves.toEqual({ published: true, remoteHead: head });
  });

  it('counts an upstream whose remote ref is gone', async () => {
    const { root } = await checkout();
    await git(root, 'branch', 'merged');
    await git(root, 'config', 'branch.merged.remote', 'origin');
    await git(root, 'config', 'branch.merged.merge', 'refs/heads/merged');
    await expect(gitPublication(root, 'merged')).resolves.toEqual({ published: true, remoteHead: null });
  });

  it('does not count a local branch, nor a remote ref beneath its name', async () => {
    const { root, head } = await checkout();
    await git(root, 'branch', 'local');
    await git(root, 'update-ref', 'refs/remotes/origin/local/nested', head);
    await expect(gitPublication(root, 'local')).resolves.toEqual({ published: false, remoteHead: null });
  });
});
