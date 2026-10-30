import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService } from '../src/worktrees/management.js';
import type { PullRequestCleanupStatus } from '../src/github/service.js';
import { testProject, testWorktree } from './helpers/config.js';

const directories: string[] = [];
// remove every temporary repository
afterEach(async () => {
  // clear all registered paths
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// run one repository command
const git = async (path: string, ...args: string[]) => {
  const result = await run('/usr/bin/git', ['-C', path, ...args]);
  // surface command failures
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

// what GitHub proves about a branch head, asked of the checkout at `path`
type CleanupHead = (path: string, branch: string, sha: string, fresh: boolean, acceptAncestor: boolean) => Promise<PullRequestCleanupStatus | undefined>;

// create one managed repository; its GitHub module names each checkout's origin after its path,
// so a fake can act on the checkout while GitHub is asked
async function repository(github?: { cleanupHead: CleanupHead; repositoryAt?: (path: string, fresh?: boolean) => Promise<{ owner: string; name: string } | undefined>; batches?: string[][] }) {
  const pullRequests = github === undefined ? undefined : {
    repositoryAt: github.repositoryAt ?? (async (path: string) => ({ owner: path, name: 'origin' })),
    cleanupHeads: async ({ owner }: { owner: string }, heads: readonly { branch: string; head: string }[], { fresh = false, acceptAncestor = false } = {}) => {
      const statuses = new Map<string, PullRequestCleanupStatus>();
      github.batches?.push(heads.map(({ branch }) => branch));
      for (const { branch, head } of heads) {
        const status = await github.cleanupHead(owner, branch, head, fresh, acceptAncestor);
        if (status !== undefined) statuses.set(branch, status);
      }
      return statuses;
    }
  };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-branches-')));
  directories.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'readme.md'), 'initial\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'initial');
  const project = testProject({ id: 'proj', label: 'Project', path: root, identity: join(root, '.git'), worktreesDirectory: `${root}-worktrees`, available: true });
  directories.push(project.worktreesDirectory);
  return { root, service: new WorktreeManagementService(() => [project], undefined, pullRequests) };
}

// create an inactive feature whose commit is not reachable from main
async function unmergedFeature(root: string) {
  await git(root, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(root, 'feature.txt'), 'feature\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'feature');
  const head = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'checkout', '-q', 'main');
  return head;
}

describe('guarded branch deletion', () => {
  // a deletion rechecks the live origin; an origin that is gone or cannot be read proves nothing
  it.each([
    ['is no longer on GitHub', async () => undefined],
    ['cannot be read', async () => { throw new Error('git unavailable'); }]
  ] as const)('keeps a closed PR branch when the live origin %s', async (_name, live) => {
    const repositoryAt = vi.fn(async (path: string, fresh?: boolean) => fresh === true ? await live() : { owner: path, name: 'origin' });
    const { root, service } = await repository({ cleanupHead: async () => 'closed', repositoryAt });
    const head = await unmergedFeature(root);

    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'feature', reason: 'closed' }]);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'closed')).resolves.toBe(false);
    expect(repositoryAt).toHaveBeenCalledWith(root, true);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // closed pull requests can be selected without being misreported as merged
  it('suggests and deletes an explicitly selected closed PR branch while preserving manual loss warnings', async () => {
    const cleanupHead = vi.fn(async () => 'closed' as const);
    const { root, service } = await repository({ cleanupHead });
    const head = await unmergedFeature(root);

    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'feature', reason: 'closed' }]);
    await expect(service.branchRemoval('proj', 'feature')).resolves.toMatchObject({ ok: true, facts: { merged: false, pushed: false } });
    await expect(service.deleteBranchGuarded('proj', 'feature', false)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('confirm deleting unpushed work') });
    await expect(service.deleteCleanupBranch('proj', 'main', 'closed')).resolves.toBe(false);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'closed')).resolves.toBe(true);
    expect(cleanupHead).toHaveBeenCalledWith(root, 'feature', head, true, false);
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/feature')).rejects.toThrow();
  });

  // never turn a merged selection into consent to discard unmerged work
  it('refuses a merged selection when fresh evidence only proves a closed PR', async () => {
    const { root, service } = await repository({ cleanupHead: async (_path, _branch, _sha, fresh) => fresh ? 'closed' : 'merged' });
    const head = await unmergedFeature(root);
    await expect(service.cleanupBranches()).resolves.toMatchObject([{ reason: 'merged' }]);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'merged')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // reopened pull requests and unavailable evidence both invalidate closed suggestions
  it('refuses a closed PR candidate when fresh evidence is unavailable', async () => {
    const { root, service } = await repository({ cleanupHead: async (_path, _branch, _sha, fresh) => fresh ? undefined : 'closed' });
    const head = await unmergedFeature(root);
    await expect(service.cleanupBranches()).resolves.toMatchObject([{ reason: 'closed' }]);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'closed')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // a closed pull request does not cover commits added after its final head
  it('preserves a closed PR branch after its local tip advances', async () => {
    let closedSha = '';
    const { root, service } = await repository({ cleanupHead: async (_path, _branch, sha) => sha === closedSha ? 'closed' : undefined });
    closedSha = await unmergedFeature(root);
    await expect(service.cleanupBranches()).resolves.toMatchObject([{ reason: 'closed' }]);
    await git(root, 'checkout', '-q', 'feature');
    await writeFile(join(root, 'feature.txt'), 'new work after close\n');
    await git(root, 'commit', '-qam', 'new work');
    const head = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');

    await expect(service.cleanupBranches()).resolves.toEqual([]);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'closed')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // both destructive entry points must close the remote lookup race
  it.each([['cleanup', 'merged'], ['cleanup', 'closed'], ['guarded', 'merged'], ['guarded', 'closed']] as const)('preserves commits added during %s %s PR revalidation', async (mode, reason) => {
    let advancedHead = '';
    const cleanupHead = vi.fn(async (path: string, _branch: string, _sha: string, fresh?: boolean) => {
      // simulate another git client committing while GitHub verification is pending
      if (fresh) {
        await git(path, 'checkout', '-q', 'feature');
        await writeFile(join(path, 'feature.txt'), 'new work during lookup\n');
        await git(path, 'commit', '-qam', 'new work');
        advancedHead = await git(path, 'rev-parse', 'HEAD');
        await git(path, 'checkout', '-q', 'main');
      }
      return reason;
    });
    const { root, service } = await repository({ cleanupHead });
    const originalHead = await unmergedFeature(root);
    // exercise cleanup and acknowledged manual deletion against the same race
    if (mode === 'cleanup') await expect(service.deleteCleanupBranch('proj', 'feature', reason)).resolves.toBe(false);
    else await expect(service.deleteBranchGuarded('proj', 'feature', true)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(cleanupHead).toHaveBeenCalledWith(root, 'feature', originalHead, true, false);
    expect(advancedHead).not.toBe(originalHead);
    expect(await git(root, 'rev-parse', 'feature')).toBe(advancedHead);
  });

  // another checkout acquiring the branch during lookup must remain authoritative
  it.each(['merged', 'closed'] as const)('refuses %s cleanup when a worktree checks out the branch during PR verification', async reason => {
    const { root, service } = await repository({ cleanupHead: async (path, branch, _sha, fresh) => {
      // simulate another client opening the branch before the response arrives
      if (fresh) await git(path, 'worktree', 'add', '-q', `${path}-worktrees/acquired`, branch);
      return reason;
    } });
    const head = await unmergedFeature(root);
    await expect(service.deleteCleanupBranch('proj', 'feature', reason)).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // fresh remote refusal overrides an earlier positive suggestion
  it('does not delete a candidate whose PR proof changes after the scan', async () => {
    const cleanupHead = vi.fn(async (_path: string, _branch: string, _sha: string, fresh?: boolean) => fresh === true ? undefined : 'merged' as const);
    const { root, service } = await repository({ cleanupHead });
    const head = await unmergedFeature(root);
    await expect(service.cleanupBranches()).resolves.toHaveLength(1);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'merged')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(head);
  });

  // large branch sets should be complete without unbounded remote fanout
  it('asks GitHub about every inactive branch at once and skips checked-out and default branches', async () => {
    const batches: string[][] = [];
    const cleanupHead = vi.fn(async () => 'merged' as const);
    const { root, service } = await repository({ cleanupHead, batches });
    const head = await unmergedFeature(root);
    // create enough inactive refs to require multiple batches
    for (let index = 0; index < 9; index += 1) await git(root, 'branch', `feature-${index}`, head);
    await git(root, 'worktree', 'add', '-q', `${root}-worktrees/occupied`, 'feature-0');
    const candidates = await service.cleanupBranches();
    expect(candidates).toHaveLength(9);
    expect(candidates.map(candidate => candidate.branch)).not.toContain('feature-0');
    expect(candidates.map(candidate => candidate.branch)).not.toContain('main');
    expect(batches).toEqual([Array.from({ length: 8 }, (_, index) => `feature-${index + 1}`).concat('feature').sort()]);
  });

  // recognize squash and release merges without relying on rewritten commit ancestry
  it('suggests a squash-merged release PR only when its head matches the local tip', async () => {
    let mergedSha = '';
    const cleanupHead = vi.fn(async (_path: string, branch: string, sha: string) => branch === 'squashed' && sha === mergedSha ? 'merged' as const : undefined);
    const { root, service } = await repository({ cleanupHead });
    await git(root, 'checkout', '-q', '-b', 'release');
    await git(root, 'checkout', '-q', '-b', 'squashed');
    await writeFile(join(root, 'feature.txt'), 'merged feature\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'feature');
    mergedSha = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'release');
    await git(root, 'merge', '--squash', 'squashed');
    await git(root, 'commit', '-q', '-m', 'squash feature');
    await git(root, 'checkout', '-q', 'main');

    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'squashed', reason: 'merged' }]);
    await expect(service.branchRemoval('proj', 'squashed')).resolves.toMatchObject({ ok: true, facts: { merged: true } });
    await expect(service.deleteCleanupBranch('proj', 'squashed', 'merged')).resolves.toBe(true);
    expect(cleanupHead).toHaveBeenCalledWith(root, 'squashed', mergedSha, true, false);
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/squashed')).rejects.toThrow();
  });

  // an old merged PR does not authorize deleting new local commits
  it('refuses a suggested branch after it advances beyond the merged PR head', async () => {
    let mergedSha = '';
    const { root, service } = await repository({ cleanupHead: async (_path, _branch, sha) => sha === mergedSha ? 'merged' : undefined });
    await git(root, 'checkout', '-q', '-b', 'feature');
    await writeFile(join(root, 'feature.txt'), 'merged\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'merged PR head');
    mergedSha = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'feature', reason: 'merged' }]);

    await git(root, 'checkout', '-q', 'feature');
    await writeFile(join(root, 'feature.txt'), 'new unmerged work\n');
    await git(root, 'commit', '-qam', 'new work after merge');
    const newSha = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    await expect(service.cleanupBranches()).resolves.toEqual([]);
    await expect(service.deleteCleanupBranch('proj', 'feature', 'merged')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', 'feature')).toBe(newSha);
  });

  // retain ancestry-only cleanup when GitHub cannot supply merge evidence
  it('fails closed on PR errors without hiding ordinary ancestry merges', async () => {
    const { root, service } = await repository({ cleanupHead: async () => { throw new Error('GitHub unavailable'); } });
    await git(root, 'branch', 'already-merged');
    await git(root, 'checkout', '-q', '-b', 'unknown');
    await writeFile(join(root, 'feature.txt'), 'unknown work\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'unverified work');
    await git(root, 'checkout', '-q', 'main');
    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'already-merged', reason: 'merged' }]);
    await expect(service.deleteCleanupBranch('proj', 'unknown', 'merged')).resolves.toBe(false);
    expect(await git(root, 'rev-parse', '--verify', 'unknown')).toMatch(/^[a-f0-9]{40}$/u);
  });

  it('lists merged branches for cleanup and protects unpushed work behind acknowledgement', async () => {
    const { root, service } = await repository();
    await git(root, 'checkout', '-q', '-b', 'merged');
    await writeFile(join(root, 'merged.txt'), 'merged\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'merged work');
    await git(root, 'checkout', '-q', 'main');
    await git(root, 'merge', '-q', '--no-ff', 'merged', '-m', 'merge feature');
    await git(root, 'checkout', '-q', '-b', 'risky');
    await writeFile(join(root, 'risky.txt'), 'risky\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'risky work');
    await git(root, 'checkout', '-q', 'main');

    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'merged', reason: 'merged' }]);
    await expect(service.branchRemoval('proj', 'merged')).resolves.toEqual({ ok: true, facts: { branch: 'merged', checkedOut: false, dirtyCount: 0, pushed: false, merged: true, defaultBranch: false } });
    await expect(service.deleteCleanupBranch('proj', 'merged', 'merged')).resolves.toBe(true);
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/merged')).rejects.toThrow();

    await expect(service.branchRemoval('proj', 'risky')).resolves.toEqual({ ok: true, facts: { branch: 'risky', checkedOut: false, dirtyCount: 0, pushed: false, merged: false, defaultBranch: false } });
    await expect(service.deleteCleanupBranch('proj', 'risky', 'merged')).resolves.toBe(false);
    await expect(service.deleteBranchGuarded('proj', 'risky', false)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('confirm deleting unpushed work') });
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/risky')).resolves.toContain('refs/heads/risky');
    await expect(service.deleteBranchGuarded('proj', 'risky', true)).resolves.toEqual({ ok: true });

    await expect(service.deleteBranchGuarded('proj', 'main', true)).resolves.toMatchObject({ ok: false, error: 'the default branch cannot be deleted' });
  });

  it('reports dirty checked-out branches and refuses to delete them', async () => {
    const { root, service } = await repository();
    const worktree = `${root}-worktrees/occupied`;
    await git(root, 'worktree', 'add', '-q', '-b', 'occupied', worktree, 'main');
    await writeFile(join(worktree, 'unfinished.txt'), 'unfinished\n');

    await expect(service.branchRemoval('proj', 'occupied')).resolves.toEqual({ ok: true, facts: { branch: 'occupied', checkedOut: true, dirtyCount: 1, pushed: false, merged: true, defaultBranch: false } });
    await expect(service.deleteBranchGuarded('proj', 'occupied', true)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('uncommitted changes') });
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/occupied')).resolves.toContain('refs/heads/occupied');
  });
});

describe('closed pull request worktrees', () => {
  // a linked checkout of one branch, as discovery lists it
  const linked = async (root: string, branch: string, leaf = branch) => {
    const path = `${root}-worktrees/${leaf}`;
    await git(root, 'worktree', 'add', '-q', path, branch);
    return testWorktree({ id: `proj:${path}`, projectId: 'proj', path, identity: path, main: false, branch });
  };
  const mainWorktree = (root: string) => testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, identity: root, main: true, branch: 'main' });

  // the checkout's own branch decides, whatever the worktree is called
  it('offers a worktree whose branch head is a merged or closed pull request head', async () => {
    let mergedSha = '';
    const cleanupHead = vi.fn(async (_path: string, branch: string, sha: string) => sha !== mergedSha ? undefined : branch === 'feature' ? 'merged' as const : branch === 'abandoned' ? 'closed' as const : undefined);
    const { root, service } = await repository({ cleanupHead });
    mergedSha = await unmergedFeature(root);
    await git(root, 'branch', 'abandoned', mergedSha);
    const merged = await linked(root, 'feature', 'review-this');
    const closed = await linked(root, 'abandoned');

    await expect(service.closedPullRequestWorktrees([mainWorktree(root), merged, closed])).resolves.toEqual([
      { worktreeId: merged.id, reason: 'merged' },
      { worktreeId: closed.id, reason: 'closed' }
    ]);
  });

  // the main checkout and the default branch are never offered, whatever GitHub says
  it('never offers the main checkout or a checkout of the default branch', async () => {
    const { root, service } = await repository({ cleanupHead: async () => 'merged' });
    await unmergedFeature(root);
    // origin names the default, so it stays main while the main checkout holds feature
    await git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await git(root, 'checkout', '-q', 'feature');
    const main = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, identity: root, main: true, branch: 'feature' });
    const defaultCheckout = await linked(root, 'main');

    await expect(service.closedPullRequestWorktrees([main, defaultCheckout])).resolves.toEqual([]);
  });

  // a fresh branch off the default is its ancestor, yet nothing about it is finished
  it('needs pull request evidence, not ancestry of the default branch', async () => {
    const cleanupHead = vi.fn(async () => undefined);
    const { root, service } = await repository({ cleanupHead });
    await git(root, 'branch', 'fresh');
    const fresh = await linked(root, 'fresh');

    await expect(service.closedPullRequestWorktrees([mainWorktree(root), fresh])).resolves.toEqual([]);
    // the offer accepts a head behind the pull request's final head
    expect(cleanupHead).toHaveBeenCalledWith(root, 'fresh', await git(root, 'rev-parse', 'fresh'), false, true);
  });

  // a fork's commits live on GitHub as refs/pull/<n>/head, fetched into refs/rac/pull/<n>
  it('counts a fork pull request checkout held by its pinned pull request ref as pushed', async () => {
    const { root, service } = await repository();
    const sha = await unmergedFeature(root);
    const branch = `rac/pr/9/${sha.slice(0, 12)}`;
    await git(root, 'branch', branch, sha);
    const fork = await linked(root, branch, 'pr-9');
    expect(await service.removal(fork)).toMatchObject({ ok: true, facts: { pushed: false } });

    await git(root, 'update-ref', 'refs/rac/pull/9', sha);
    expect(await service.removal(fork)).toMatchObject({ ok: true, facts: { pushed: true } });
    // another pull request's ref proves nothing
    await git(root, 'update-ref', '-d', 'refs/rac/pull/9');
    await git(root, 'update-ref', 'refs/rac/pull/10', sha);
    expect(await service.removal(fork)).toMatchObject({ ok: true, facts: { pushed: false } });
  });

  // discovery's branch can be stale; the worktree must still hold the branch when asked
  it('never offers a worktree that has switched away from the finished branch', async () => {
    const cleanupHead = vi.fn(async () => 'merged' as const);
    const { root, service } = await repository({ cleanupHead });
    await unmergedFeature(root);
    const stale = await linked(root, 'feature');
    await git(stale.path, 'switch', '-q', '--detach');

    await expect(service.closedPullRequestWorktrees([mainWorktree(root), stale])).resolves.toEqual([]);
    expect(cleanupHead).not.toHaveBeenCalled();
  });
});

describe('a bare repository Project', () => {
  // the console's git takes a bare repository only when named explicitly (`safe.bareRepository=explicit`)
  it('resolves its default branch and finds its merged branches', async () => {
    const { root } = await repository();
    await git(root, 'branch', 'done');
    const bare = `${root}-store.git`;
    directories.push(bare);
    await git(root, 'clone', '-q', '--bare', root, bare);
    const project = testProject({ id: 'bare', label: 'Bare', path: bare, identity: bare, worktreesDirectory: `${bare}-worktrees`, available: true });
    const service = new WorktreeManagementService(() => [project]);

    await expect(service.branches('bare')).resolves.toMatchObject({ ok: true, defaultBranch: 'main' });
    await expect(service.cleanupBranches()).resolves.toEqual([{ projectId: 'bare', projectLabel: 'Bare', branch: 'done', reason: 'merged' }]);
  });
});
