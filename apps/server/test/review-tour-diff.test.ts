import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_REVIEW_FILE_BYTES, parseReviewTour } from '../src/review-tour/contracts.js';
import { captureReviewComparison } from '../src/review-tour/diff.js';
import { ReviewTourService } from '../src/review-tour/service.js';
import type { PullRequestReviewThread } from '../src/domain/models.js';
import { resolveConfiguredWorkspace } from '../src/workspaces/resolver.js';
import type { ResolvedWorkspace } from '../src/workspaces/resolver.js';

const execute = promisify(execFile);
const roots: string[] = [];

// run one fixture Git command
async function git(root: string, ...args: string[]): Promise<void> {
  await execute('/usr/bin/git', ['-C', root, ...args]);
}

// create a committed review fixture
async function fixture(): Promise<ResolvedWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'rac-review-diff-'));
  roots.push(root);
  await Promise.all([mkdir(join(root, 'src')), mkdir(join(root, 'test')), mkdir(join(root, 'docs'))]);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'review@example.com');
  await git(root, 'config', 'user.name', 'Review Fixture');
  await Promise.all([
    writeFile(join(root, 'src', 'feature.ts'), 'export const value = 1;\n'),
    writeFile(join(root, 'test', 'feature.test.ts'), 'expect(1).toBe(1);\n'),
    writeFile(join(root, 'docs', 'feature.md'), '# Feature\n')
  ]);
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture');
  await git(root, 'switch', '-c', 'feature/review-tour');
  await Promise.all([
    writeFile(join(root, 'src', 'feature.ts'), 'export const value = 2;\nexport const enabled = true;\n'),
    writeFile(join(root, 'test', 'feature.test.ts'), 'expect(2).toBe(2);\n'),
    writeFile(join(root, 'docs', 'feature.md'), '# Updated feature\n')
  ]);
  return {
    workspace: root,
    worktree: { id: 'cora', projectId: 'cora', label: 'Cora', path: root, identity: root, available: true, pinned: false, main: true, detached: false, locked: false }
  };
}

afterEach(async () => {
  // remove every temporary repository
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('review Comparison capture', () => {
  it('excludes tests and docs by default and produces stable atomic fingerprints', async () => {
    const resolved = await fixture();
    const input = { scope: 'working' as const, includeTests: false, includeDocs: false };
    const first = await captureReviewComparison(resolved, input);
    const second = await captureReviewComparison(resolved, input);
    expect(first.changes.map(change => change.file)).toEqual(['src/feature.ts']);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({ category: 'implementation', kind: 'hunk', oldStart: 1, newStart: 1 });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('captures one commit against its parent, leaving later commits and working edits out', async () => {
    const resolved = await fixture();
    await git(resolved.workspace, 'commit', '-am', 'feature');
    const { stdout } = await execute('/usr/bin/git', ['-C', resolved.workspace, 'rev-parse', 'HEAD']);
    const commit = stdout.trim();
    await writeFile(join(resolved.workspace, 'src', 'feature.ts'), 'export const value = 3;\n');
    await git(resolved.workspace, 'commit', '-am', 'later');
    await writeFile(join(resolved.workspace, 'src', 'other.ts'), 'export const other = 1;\n');
    const comparison = await captureReviewComparison(resolved, { scope: 'commit', commit, includeTests: false, includeDocs: false });
    expect(comparison).toMatchObject({ scope: 'commit', commit, base: `${commit.slice(0, 7)}^` });
    expect(comparison.changes.map(change => change.file)).toEqual(['src/feature.ts']);
    expect(comparison.changes[0]!.patch).toContain('+export const enabled = true;');
    expect(comparison.changes[0]!.patch).not.toContain('value = 3');
  });

  it('includes tests and docs only when requested', async () => {
    const resolved = await fixture();
    const comparison = await captureReviewComparison(resolved, { scope: 'working', includeTests: true, includeDocs: true });
    expect(comparison.changes.map(change => [change.file, change.category])).toEqual([
      ['docs/feature.md', 'doc'],
      ['src/feature.ts', 'implementation'],
      ['test/feature.test.ts', 'test']
    ]);
  });

  it('resolves a Worktree with no Agent to its idle view\'s branch and merge target', async () => {
    const raw = await fixture();
    const view = { id: raw.worktree.id, branch: 'feature/review-tour', gitPrStatus: { base: 'main', files: 3, changes: [] } };
    const discovery = {
      worktreesNow: () => [raw.worktree],
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [{ id: 'cora', worktrees: [view] }] })
    };

    const resolved = await resolveConfiguredWorkspace(discovery as never, raw.worktree.id);

    expect(resolved).toMatchObject({ branch: 'feature/review-tour', prBase: 'main', workspace: raw.workspace });
    await expect(resolveConfiguredWorkspace(discovery as never, 'missing')).resolves.toBeUndefined();
    await expect(captureReviewComparison(resolved!, { scope: 'pr', includeTests: false, includeDocs: false })).resolves.toMatchObject({
      scope: 'pr',
      base: 'main',
      changes: [expect.objectContaining({ file: 'src/feature.ts' })]
    });
  });

  it('splits a large tracked file before enforcing the per-change limit', async () => {
    const resolved = await fixture();
    const original: string[] = [];
    const modified: string[] = [];
    // build separated tracked hunks
    for (let index = 0; index < 3_000; index += 1) {
      const suffix = 'x'.repeat(80);
      original.push(`export const value${index} = '${suffix}';`);
      modified.push(`export const value${index} = '${index % 10 === 0 ? `changed-${suffix}` : suffix}';`);
    }
    const path = join(resolved.workspace, 'src', 'large.ts');
    await writeFile(path, `${original.join('\n')}\n`);
    await git(resolved.workspace, 'add', 'src/large.ts');
    await git(resolved.workspace, 'commit', '-m', 'large fixture');
    await writeFile(path, `${modified.join('\n')}\n`);

    const comparison = await captureReviewComparison(resolved, { scope: 'working', includeTests: false, includeDocs: false });
    const largeChanges = comparison.changes.filter(change => change.file === 'src/large.ts');

    expect(largeChanges.length).toBeGreaterThan(1);
    expect(largeChanges.every(change => Buffer.byteLength(change.patch) <= MAX_REVIEW_FILE_BYTES)).toBe(true);
  });
});

// ---- Since my review ----------------------------------------------------------------------

// fixed identity and dates, so every commit id (and so every fingerprint) is the same on each run
const pinnedEnv = { ...process.env, GIT_AUTHOR_NAME: 'Review Fixture', GIT_AUTHOR_EMAIL: 'review@example.com', GIT_COMMITTER_NAME: 'Review Fixture', GIT_COMMITTER_EMAIL: 'review@example.com', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' };

// run one fixture Git command and return its output
async function out(root: string, ...args: string[]): Promise<string> {
  return (await execute('/usr/bin/git', ['-c', 'commit.gpgsign=false', '-C', root, ...args], { env: pinnedEnv })).stdout.trim();
}

const lines = (overrides: Record<number, string> = {}) => `${Array.from({ length: 8 }, (_, index) => overrides[index + 1] ?? `line ${index + 1}`).join('\n')}\n`;

// commit `content` as src/lines.ts (and any other files) and return the commit id
async function commitLines(root: string, message: string, content: string, others: Record<string, string> = {}): Promise<string> {
  await writeFile(join(root, 'src', 'lines.ts'), content);
  for (const [path, text] of Object.entries(others)) await writeFile(join(root, path), text);
  await out(root, 'add', '.');
  await out(root, 'commit', '-m', message);
  return await out(root, 'rev-parse', 'HEAD');
}

// a repository whose `feature` branch holds the reviewed commit (line 2 changed) on top of main
async function reviewedRepository(): Promise<{ root: string; reviewed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-since-review-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await out(root, 'init', '--initial-branch=main');
  await commitLines(root, 'base', lines());
  await out(root, 'switch', '-c', 'feature');
  const reviewed = await commitLines(root, 'reviewed', lines({ 2: 'feature 2' }));
  return { root, reviewed };
}

// the resolved Worktree of a checkout whose PR base is `prBase`
const sinceReviewWorkspace = (root: string, prBase: string): ResolvedWorkspace => ({
  workspace: root, branch: 'feature', prBase,
  worktree: { id: 'cora', projectId: 'cora', label: 'Cora', path: root, identity: root, available: true, pinned: false, main: false, detached: false, locked: false }
});

describe('Since my review Comparison capture', () => {
  it('replays the reviewed commit onto the rebased base, so only the author\'s edits since the review show', async () => {
    const { root, reviewed } = await reviewedRepository();
    // upstream moves on: line 8 changes and a file arrives, then the author rebases and edits line 5
    await out(root, 'switch', 'main');
    await commitLines(root, 'upstream', lines({ 8: 'upstream 8' }), { 'src/upstream.ts': 'export const upstream = 1;\n' });
    await out(root, 'switch', 'feature');
    await out(root, 'rebase', 'main');
    await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5', 8: 'upstream 8' }));

    const comparison = await captureReviewComparison(sinceReviewWorkspace(root, 'main'), { scope: 'since-review', reviewedCommit: reviewed, includeTests: false, includeDocs: false });

    expect(comparison).toMatchObject({ scope: 'since-review', reviewedCommit: reviewed, base: `${reviewed.slice(0, 7)} (rebased)` });
    expect(comparison.fallback).toBeUndefined();
    expect(comparison.baseTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(comparison.changes.map(change => change.file)).toEqual(['src/lines.ts']);
    expect(comparison.changes[0]!.patch).toContain('-line 5\n+fixed 5');
    // upstream's line 8 is context on both sides, not a change
    expect(comparison.changes[0]!.patch).not.toContain('+upstream 8');
  });

  it('falls back to the plain diff from the reviewed commit when the replay conflicts', async () => {
    const { root, reviewed } = await reviewedRepository();
    // upstream changes the reviewed line too, so replaying the review onto it conflicts
    await out(root, 'switch', 'main');
    await commitLines(root, 'upstream', lines({ 2: 'upstream 2' }), { 'src/upstream.ts': 'export const upstream = 1;\n' });
    await out(root, 'switch', '-c', 'rebased');
    await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));

    const comparison = await captureReviewComparison(sinceReviewWorkspace(root, 'main'), { scope: 'since-review', reviewedCommit: reviewed, includeTests: false, includeDocs: false });

    expect(comparison).toMatchObject({ scope: 'since-review', reviewedCommit: reviewed, base: `${reviewed.slice(0, 7)} (plain diff: replay conflicted)`, fallback: true, baseTree: await out(root, 'rev-parse', `${reviewed}^{tree}`) });
    // the plain diff carries what upstream brought in as well
    expect(comparison.changes.map(change => change.file)).toEqual(['src/lines.ts', 'src/upstream.ts']);
  });

  it('replays onto the merge base when the author merged upstream in rather than rebasing', async () => {
    const { root, reviewed } = await reviewedRepository();
    await out(root, 'switch', 'main');
    await commitLines(root, 'upstream', lines({ 8: 'upstream 8' }), { 'src/upstream.ts': 'export const upstream = 1;\n' });
    await out(root, 'switch', 'feature');
    await out(root, 'merge', '--no-edit', 'main');
    await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5', 8: 'upstream 8' }));

    const comparison = await captureReviewComparison(sinceReviewWorkspace(root, 'main'), { scope: 'since-review', reviewedCommit: reviewed, includeTests: false, includeDocs: false });

    expect(comparison.base).toBe(`${reviewed.slice(0, 7)} (rebased)`);
    expect(comparison.changes.map(change => change.file)).toEqual(['src/lines.ts']);
    expect(comparison.changes[0]!.patch).toContain('-line 5\n+fixed 5');
    expect(comparison.changes[0]!.patch).not.toContain('+upstream 8');
  });

  it('refuses a reviewed commit that is not here, leaving the fetch to a start', async () => {
    const { root } = await reviewedRepository();
    await expect(captureReviewComparison(sinceReviewWorkspace(root, 'main'), { scope: 'since-review', reviewedCommit: 'f'.repeat(40), includeTests: false, includeDocs: false })).rejects.toMatchObject({ code: 'reviewed_commit_unreachable' });
  });

  // A stored tour is current while its fingerprint matches a fresh capture, so a change to what the
  // fingerprint digests (a field, or their order) silently stales every stored tour. These values
  // were captured once; a deliberate change to the fingerprint updates them.
  it('keeps the fingerprints stored tours were saved with', async () => {
    const { root, reviewed } = await reviewedRepository();
    await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    const resolved = sinceReviewWorkspace(root, 'main');
    const fingerprints = {
      commit: (await captureReviewComparison(resolved, { scope: 'commit', commit: reviewed, includeTests: false, includeDocs: false })).fingerprint,
      sinceReview: (await captureReviewComparison(resolved, { scope: 'since-review', reviewedCommit: reviewed, includeTests: false, includeDocs: false })).fingerprint
    };
    expect(fingerprints).toEqual({ commit: 'aqmEVqYDMVVz4EK83GJLmf9HzRoCBN_g3FaQjO2nBFs', sinceReview: 'GWz5J25YUHBpRmav3vTWKmCfGvg2kRe06CqqxCDSTKM' });
  });
});

describe('Since my review availability and start', () => {
  type Detail = { headSha: string; viewerReviewCommit?: string; baseBranch?: string; headOnOrigin?: boolean; threads?: PullRequestReviewThread[]; pageFull?: { threads?: true } };
  // a service over the Worktree at `root` (branch `feature`) whose Pull request #7 GitHub reads as `detail`
  const service = (root: string, pull: { number: number; status: 'open' | 'merged' } | undefined, detail: Detail | undefined, prBase = 'main', problem?: object, generator: object = {}) => {
    const worktree = sinceReviewWorkspace(root, prBase).worktree;
    const view = { id: worktree.id, branch: 'feature', gitPrStatus: { base: prBase, files: 1, changes: [] } };
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [{ id: 'cora', worktrees: [view] }] }) };
    const repository = { owner: 'octo', name: 'repo' };
    const reads: unknown[] = [];
    const github = {
      repositoryAt: async (path: string) => path === root ? repository : undefined,
      branch: async (asked: unknown, name: string) => ({ ...(pull === undefined || asked !== repository || name !== 'feature' ? {} : { pullRequest: { ...pull, title: 'Fixes', url: 'https://github.com/octo/repo/pull/7' } }) }),
      pullRequestDetail: async (_repository: unknown, number: number, options: unknown) => { reads.push([number, options]); return { ...(detail === undefined || number !== 7 ? {} : { pullRequest: { number, threads: [], branch: 'feature', headOnOrigin: true, state: 'open', ...detail } }), ...(problem === undefined ? {} : { problem }) }; }
    };
    return { reads, service: new ReviewTourService(discovery as never, generator as never, github as never) };
  };

  it('names the commit of my latest submitted review, read fresh, while HEAD is the pull request\'s head', async () => {
    const { root, reviewed } = await reviewedRepository();
    const head = await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    const { service: ready, reads } = service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: reviewed });
    await expect(ready.sinceReview('cora')).resolves.toEqual({ reviewedCommit: reviewed, head });
    expect(reads).toEqual([[7, { fresh: true }]]);
  });

  it('refuses without a pull request, without a submitted review, with HEAD off the pull request\'s head, or when GitHub could not be read', async () => {
    const { root, reviewed } = await reviewedRepository();
    const head = await out(root, 'rev-parse', 'HEAD');
    await expect(service(root, undefined, undefined).service.sinceReview('cora')).rejects.toMatchObject({ code: 'no_pull_request' });
    await expect(service(root, { number: 7, status: 'merged' }, { headSha: head }).service.sinceReview('cora')).rejects.toMatchObject({ code: 'no_pull_request' });
    await expect(service(root, { number: 7, status: 'open' }, { headSha: head }).service.sinceReview('cora')).rejects.toMatchObject({ code: 'no_submitted_review' });
    await expect(service(root, { number: 7, status: 'open' }, { headSha: 'f'.repeat(40), viewerReviewCommit: reviewed }).service.sinceReview('cora')).rejects.toMatchObject({ code: 'head_diverged_from_pull_request' });
    await expect(service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: reviewed }, 'main', { kind: 'unreachable' }).service.sinceReview('cora')).rejects.toMatchObject({ code: 'scope_unavailable' });
  });

  // behind is what Update to PR head can fix: HEAD under the pull request's head, or, after a
  // force-push this checkout has not fetched, HEAD holding only commits once on origin/feature
  it('tells a HEAD Update to PR head can move from one with commits only this checkout has', async () => {
    const { root, reviewed } = await reviewedRepository();
    const pulled = (headSha: string) => service(root, { number: 7, status: 'open' }, { headSha, viewerReviewCommit: reviewed }).service.sinceReview('cora');
    const head = await out(root, 'rev-parse', 'HEAD');
    const later = await commitLines(root, 'author pushed more', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    await out(root, 'reset', '--hard', head);
    await expect(pulled(later)).rejects.toMatchObject({ code: 'head_behind_pull_request' });
    const forcePushed = 'f'.repeat(40);
    await expect(pulled(forcePushed)).rejects.toMatchObject({ code: 'head_diverged_from_pull_request' });
    await out(root, 'update-ref', 'refs/remotes/origin/feature', head);
    await expect(pulled(forcePushed)).rejects.toMatchObject({ code: 'head_behind_pull_request' });
    await commitLines(root, 'mine, not pushed', lines({ 2: 'feature 2', 7: 'local 7' }));
    await expect(pulled(later)).rejects.toMatchObject({ code: 'head_diverged_from_pull_request' });
  });

  it('calls a HEAD behind when origin/feature holds it with no reflog, as a fresh clone leaves it', async () => {
    const { root, reviewed } = await reviewedRepository();
    await out(root, '-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/remotes/origin/feature', reviewed);
    const pulled = (detail: Partial<Detail>) => service(root, { number: 7, status: 'open' }, { headSha: 'f'.repeat(40), viewerReviewCommit: reviewed, ...detail }).service.sinceReview('cora');
    await expect(pulled({})).rejects.toMatchObject({ code: 'head_behind_pull_request' });
    // Update to PR head never moves a branch to a head in a fork
    await expect(pulled({ headOnOrigin: false })).rejects.toMatchObject({ code: 'head_diverged_from_pull_request' });
  });

  it('finds no pull request for a fork checkout, even one GitHub would map to its pull request', async () => {
    const { root, reviewed } = await reviewedRepository();
    const forkCheckout = `rac/pr/7/${reviewed.slice(0, 12)}`;
    await out(root, 'switch', '-c', forkCheckout);
    const worktree = sinceReviewWorkspace(root, 'main').worktree;
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [{ id: 'cora', worktrees: [{ id: worktree.id, branch: forkCheckout, gitPrStatus: { base: 'main', files: 1, changes: [] } }] }] }) };
    const github = { repositoryAt: async () => ({ owner: 'octo', name: 'repo' }), branch: async () => ({ pullRequest: { number: 7, status: 'open', title: 'Fixes', url: '' } }), pullRequestDetail: async () => ({ pullRequest: { number: 7, state: 'open', branch: 'main', headOnOrigin: false, headSha: reviewed, viewerReviewCommit: 'a'.repeat(40) } }) };
    await expect(new ReviewTourService(discovery as never, {} as never, github as never).sinceReview('cora')).rejects.toMatchObject({ code: 'no_pull_request' });
  });

  it('refuses a start pinned to a review that is no longer my latest', async () => {
    const { root, reviewed } = await reviewedRepository();
    const head = await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    await expect(service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: head }).service.startSinceReview('cora', reviewed)).rejects.toMatchObject({ code: 'scope_unavailable' });
  });

  it('fetches the pull request\'s base and a reviewed commit only GitHub still has, so an upstream this checkout never saw stays out', async () => {
    const { root: work, reviewed } = await reviewedRepository();
    const origin = `${work}-origin.git`;
    const clone = `${work}-clone`;
    roots.push(origin, clone);
    await out(work, 'init', '--bare', origin);
    await out(origin, 'fetch', work, 'main:refs/heads/main', 'feature:refs/heads/feature');
    await execute('/usr/bin/git', ['clone', '--no-local', '--branch', 'feature', origin, clone], { env: pinnedEnv });
    // upstream moves on; the author rebases onto it, amends the reviewed commit, and force-pushes
    await out(work, 'switch', 'main');
    await commitLines(work, 'upstream', lines({ 8: 'upstream 8' }));
    await out(work, 'switch', 'feature');
    await out(work, 'reset', '--hard', 'main');
    await commitLines(work, 'amended', lines({ 2: 'amended 2', 5: 'fixed 5', 8: 'upstream 8' }));
    await out(origin, 'fetch', work, '+main:refs/heads/main', '+feature:refs/heads/feature');
    // the checkout takes only the new PR head, as a pull request switch does: its origin/main is stale
    await out(clone, 'fetch', 'origin', '+refs/heads/feature:refs/remotes/origin/feature');
    await out(clone, 'reset', '--hard', 'origin/feature');
    // and has since let the reviewed commit go
    await out(clone, 'reflog', 'expire', '--expire=now', '--all');
    await out(clone, 'gc', '--quiet', '--prune=now');
    await expect(out(clone, 'cat-file', '-e', `${reviewed}^{commit}`)).rejects.toThrow();
    const head = await out(clone, 'rev-parse', 'HEAD');
    const { service: ready } = service(clone, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: reviewed, baseBranch: 'main' }, 'origin/main');

    await ready.startSinceReview('cora', reviewed);
    const comparison = await captureReviewComparison(sinceReviewWorkspace(clone, 'origin/main'), { scope: 'since-review', reviewedCommit: reviewed, includeTests: false, includeDocs: false });

    expect(comparison.base).toBe(`${reviewed.slice(0, 7)} (rebased)`);
    expect(comparison.changes[0]!.patch).toContain('-feature 2\n+amended 2');
    expect(comparison.changes[0]!.patch).toContain('-line 5\n+fixed 5');
    expect(comparison.changes[0]!.patch).not.toContain('+upstream 8');
  });

  it('starts with a snapshot of the threads I opened and submitted, except those I resolved myself', async () => {
    const { root, reviewed } = await reviewedRepository();
    const head = await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    const comment = (id: string, mine: boolean) => ({ id, author: mine ? 'octocat' : 'mona', bot: false, ...(mine ? { mine: true as const } : {}), body: `${id} text`, createdAt: '2026-10-01T00:00:00Z', url: `https://github.com/octo/repo/pull/7#discussion_${id}` });
    const thread = (id: string, first: boolean, extra: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({ id, path: 'src/lines.ts', line: 5, resolved: false, outdated: false, diffHunk: '@@ -5 +5 @@', comments: [comment(`${id}-1`, first), comment(`${id}-2`, !first)], ...extra });
    const threads = [
      thread('open-mine', true),
      // the author resolved it: kept, so a resolve without a fix is caught
      thread('resolved-by-author', true, { resolved: true, resolvedBy: { login: 'mona' } }),
      thread('resolved-by-me', true, { resolved: true, resolvedBy: { login: 'octocat', mine: true } }),
      thread('outdated-mine', true, { outdated: true }),
      // still in my unsubmitted Draft review
      thread('pending-mine', true, { pending: true }),
      // someone else opened it, though I replied
      thread('theirs', false)
    ];
    const start = async (pageFull?: { threads?: true }) => await service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: reviewed, threads, ...(pageFull === undefined ? {} : { pageFull }) }).service.startSinceReview('cora', reviewed);

    expect(await start()).toEqual({ pullRequest: 7, threads: [threads[0], threads[1], threads[3]] });
    // GitHub gave a full page of threads, so older ones may be missing
    expect(await start({ threads: true })).toEqual({ pullRequest: 7, threads: [threads[0], threads[1], threads[3]], partial: true });
  });

  it('keeps a snapshot of a long, chatty thread that the stored tour loads again', async () => {
    const { root, reviewed } = await reviewedRepository();
    const head = await commitLines(root, 'address review', lines({ 2: 'feature 2', 5: 'fixed 5' }));
    const comment = (index: number) => ({ id: `C${index}`, author: index === 0 ? 'octocat' : 'mona', bot: false, ...(index === 0 ? { mine: true as const } : {}), body: `${index} ${'x'.repeat(70_000)}`, createdAt: '2026-10-01T00:00:00Z', url: `https://github.com/octo/repo/pull/7#discussion_C${index}` });
    const thread: PullRequestReviewThread = { id: 'T1', path: 'src/lines.ts', line: 5, resolved: false, outdated: false, diffHunk: Array.from({ length: 300 }, (_, index) => `+line ${index}`).join('\n'), comments: Array.from({ length: 51 }, (_, index) => comment(index)) };
    // a generator that narrates every Change in one step
    const generator = {
      capability: async () => ({ available: true, agent: 'claude', efforts: [] }),
      generate: async (comparison: { changes: { id: string }[] }) => ({ title: 'Fixes', overview: 'The author answered the review.', steps: [{ id: 'fixes', title: 'The fixes', explanation: 'Line 5 is fixed.', changeIds: comparison.changes.map(change => change.id) }] })
    };
    const { service: ready } = service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: reviewed, threads: [thread] }, 'main', undefined, generator);
    const input = { scope: 'since-review' as const, reviewedCommit: reviewed, includeTests: false, includeDocs: false };

    const tour = await ready.generate(await ready.prepare('cora', input, await ready.startSinceReview('cora', reviewed)), new AbortController().signal);

    // the opener and the latest replies, each cut short, under the end of the hunk
    const [kept] = tour.earlierThreads!.threads;
    expect(kept!.comments.map(entry => entry.id)).toEqual(['C0', 'C46', 'C47', 'C48', 'C49', 'C50']);
    expect(kept!.comments[0]!.body).toHaveLength(4_000);
    expect(kept!.diffHunk.split('\n')).toEqual(Array.from({ length: 20 }, (_, index) => `+line ${index + 280}`));
    expect(parseReviewTour(tour)).toEqual(tour);
  });

  it('refuses a start whose reviewed commit origin cannot serve', async () => {
    const { root } = await reviewedRepository();
    const head = await out(root, 'rev-parse', 'HEAD');
    const missing = 'f'.repeat(40);
    await expect(service(root, { number: 7, status: 'open' }, { headSha: head, viewerReviewCommit: missing }).service.startSinceReview('cora', missing)).rejects.toMatchObject({ code: 'reviewed_commit_unreachable' });
  });
});
