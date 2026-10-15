import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  addUntrackedLineStats, capturePatch, captureComparisonPatch, commitLog, comparisonAgainst,
  fileAtRevision, gitComparisonSummary, gitStatusSummary, mergeBaseChoices, prComparisonCandidates, saveMergeBase,
  resolveComparison, synthesizeUntrackedPatch, workingStatus, type Comparison
} from '../src/git/comparison.js';

const execute = promisify(execFile);
const roots: string[] = [];

// run one fixture Git command, returning its stdout
async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('/usr/bin/git', ['-C', root, ...args]);
  return stdout;
}

// initialise an empty committed-nothing repository on `main`
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-comparison-'));
  roots.push(root);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'compare@example.com');
  await git(root, 'config', 'user.name', 'Compare Fixture');
  return root;
}

// a NUL-bearing byte sequence git and the sniffers treat as binary
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0x05]);

// the first captured file for one path
function fileFor(patch: Awaited<ReturnType<typeof captureComparisonPatch>>, path: string) {
  return patch.files.find(file => file.change.path === path);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('git status parsing', () => {
  it('summarizes staged, unstaged, untracked, and conflicted worktree files', () => {
    expect(gitStatusSummary(' M modified.ts\nM  staged.ts\nMM both.ts\n?? new.ts\nUU conflict.ts\nR  old.ts -> renamed.ts\n')).toEqual({
      files: 6,
      staged: 3,
      unstaged: 2,
      untracked: 1,
      conflicted: 1,
      changes: [
        { code: ' M', path: 'modified.ts', category: 'implementation' },
        { code: 'M ', path: 'staged.ts', category: 'implementation' },
        { code: 'MM', path: 'both.ts', category: 'implementation' },
        { code: '??', path: 'new.ts', category: 'implementation' },
        { code: 'UU', path: 'conflict.ts', category: 'implementation' },
        { code: 'R ', path: 'renamed.ts', originalPath: 'old.ts', category: 'implementation' }
      ]
    });
    expect(gitStatusSummary('')).toEqual({ files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes: [] });
  });

  it('preserves spaces and rename origins from nul-delimited porcelain output', () => {
    expect(gitStatusSummary(
      'R  new name.ts\0old name.ts\0?? untracked file.md\0',
      ['4\t2\t\0old name.ts\0new name.ts\0']
    )).toMatchObject({
      files: 2,
      staged: 1,
      untracked: 1,
      changes: [
        { code: 'R ', path: 'new name.ts', originalPath: 'old name.ts', additions: 4, deletions: 2 },
        { code: '??', path: 'untracked file.md' }
      ]
    });
  });

  it('combines line changes from multiple numstat passes and leaves binary counts unavailable', () => {
    expect(gitStatusSummary(
      'MM mixed.ts\0 M binary.png\0',
      ['3\t1\tmixed.ts\0-\t-\tbinary.png\0', '2\t4\tmixed.ts\0']
    ).changes).toEqual([
      { code: 'MM', path: 'mixed.ts', additions: 5, deletions: 5, category: 'implementation' },
      { code: ' M', path: 'binary.png', category: 'implementation' }
    ]);
  });

  it('summarizes merge-base changes with renames and current untracked files', () => {
    expect(gitComparisonSummary(
      'origin/main',
      'M\x00src/changed.ts\x00R100\x00docs/old.md\x00docs/new.md\x00A\x00assets/image.png\x00',
      '3\t1\tsrc/changed.ts\x002\t2\t\x00docs/old.md\x00docs/new.md\x00-\t-\tassets/image.png\x00',
      [{ code: '??', path: 'notes/local.txt', additions: 4, deletions: 0 }]
    )).toEqual({
      base: 'origin/main',
      files: 4,
      changes: [
        { code: 'M ', path: 'src/changed.ts', additions: 3, deletions: 1, category: 'implementation' },
        { code: 'R ', path: 'docs/new.md', originalPath: 'docs/old.md', additions: 2, deletions: 2, category: 'doc' },
        { code: 'A ', path: 'assets/image.png', category: 'implementation' },
        { code: '??', path: 'notes/local.txt', additions: 4, deletions: 0 }
      ]
    });
  });

  it('bounds untracked line-stat enrichment by file count and aggregate bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-untracked-stats-'));
    roots.push(workspace);
    await Promise.all([
      writeFile(join(workspace, 'one.txt'), 'one\ntwo\n'),
      writeFile(join(workspace, 'two.txt'), 'three\nfour\n'),
      writeFile(join(workspace, 'three.txt'), 'five\nsix\n')
    ]);
    const summary = gitStatusSummary('?? one.txt\n?? two.txt\n?? three.txt\n');

    await addUntrackedLineStats(workspace, summary, { files: 2, bytes: 16, bytesPerFile: 16 });

    expect(summary.changes).toEqual([
      { code: '??', path: 'one.txt', additions: 2, deletions: 0, category: 'implementation' },
      { code: '??', path: 'two.txt', category: 'implementation' },
      { code: '??', path: 'three.txt', category: 'implementation' }
    ]);
  });
});

describe('comparison resolution', () => {
  // a repo with a base commit on main, a diverged commit on feature, and uncommitted edits
  async function diverged(): Promise<string> {
    const root = await repo();
    await mkdir(join(root, 'src'));
    await Promise.all([
      writeFile(join(root, 'src', 'a.ts'), 'v1\n'),
      writeFile(join(root, 'gone.ts'), 'bye\n'),
      writeFile(join(root, 'old.ts'), 'line1\nline2\nline3\nline4\n')
    ]);
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\n');
    await git(root, 'mv', 'old.ts', 'renamed.ts');
    await writeFile(join(root, 'renamed.ts'), 'line1\nline2\nline3\nline4\nline5\n');
    await git(root, 'rm', 'gone.ts');
    await writeFile(join(root, 'added.ts'), 'brand new\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');
    // uncommitted working-tree changes on top of the feature commit
    await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\nv3\n');
    await writeFile(join(root, 'note.txt'), 'a note\n');
    return root;
  }

  it('resolves the Working comparison as HEAD vs the working tree, untracked included', async () => {
    const root = await diverged();
    const result = await resolveComparison(root, 'working');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comparison.base).toBe('HEAD');
    const paths = result.comparison.changes.map(change => change.path).sort();
    // only the uncommitted edits: the modified tracked file and the untracked note
    expect(paths).toEqual(['note.txt', 'src/a.ts']);
    expect(result.comparison.changes.find(change => change.path === 'note.txt')?.code).toBe('??');

    // opting into line stats enriches the Working Changes' +/- counts (for content-sensitive fingerprints)
    const enriched = await resolveComparison(root, 'working', [], { lineStats: true });
    expect(enriched.ok).toBe(true);
    if (enriched.ok) expect(enriched.comparison.changes.find(change => change.path === 'src/a.ts')).toMatchObject({ additions: 1, deletions: 0 });
  });

  it('resolves the All PR comparison against the merge base, with renames and untracked', async () => {
    const root = await diverged();
    const result = await resolveComparison(root, 'pr', ['main']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comparison.base).toBe('main');
    // gitBase is the resolved merge-base sha, not the branch label
    expect(result.comparison.gitBase).toMatch(/^[0-9a-f]{40}$/u);
    const byPath = new Map(result.comparison.changes.map(change => [change.path, change]));
    expect([...byPath.keys()].sort()).toEqual(['added.ts', 'gone.ts', 'note.txt', 'renamed.ts', 'src/a.ts']);
    expect(byPath.get('renamed.ts')?.originalPath).toBe('old.ts');
    expect(byPath.get('added.ts')?.code).toBe('A ');
    expect(byPath.get('gone.ts')?.code).toBe('D ');
  });

  it('refuses a conflicted working tree before resolving a base', async () => {
    const root = await repo();
    await writeFile(join(root, 'c.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'left');
    await writeFile(join(root, 'c.txt'), 'left\n');
    await git(root, 'commit', '-am', 'left');
    await git(root, 'switch', '-c', 'right', 'main');
    await writeFile(join(root, 'c.txt'), 'right\n');
    await git(root, 'commit', '-am', 'right');
    await execute('/usr/bin/git', ['-C', root, 'merge', 'left']).catch(() => undefined);

    await expect(resolveComparison(root, 'working')).resolves.toEqual({ ok: false, reason: 'conflicted' });
  });

  it('reports no base when no candidate resolves', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.txt'), 'a\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await expect(resolveComparison(root, 'pr', ['origin/does-not-exist'])).resolves.toEqual({ ok: false, reason: 'no_base' });
  });

  // prefer proven local provenance over a matching remote-shaped ref
  it('uses the explicitly named creation branch as the source, preferring its local ref', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'remote', 'add', 'release', 'https://example.com/repository.git');
    await writeFile(join(root, 'source.txt'), 'source\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'source base');
    await git(root, 'branch', 'release/source');
    const sourceHead = (await git(root, 'rev-parse', 'refs/heads/release/source')).trim();
    await git(root, 'branch', 'feature', 'release/source');
    await git(root, 'update-ref', 'refs/remotes/release/source', 'HEAD~1');
    await git(root, 'switch', 'feature');
    await writeFile(join(root, 'feature.txt'), 'feature\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');

    const candidates = await prComparisonCandidates(root, 'feature', undefined, 'develop');
    expect(candidates).toEqual([
      'refs/heads/release/source',
      'origin/release/source',
      'origin/develop',
      'develop',
      'origin/main',
      'main'
    ]);
    expect((await comparisonAgainst(root, candidates))?.gitBase).toBe(sourceHead);
  });

  // pair implicit creation with the current worktree head log
  it('pairs a Created from HEAD reflog with its checkout source, including linked worktrees', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'branch', 'release/source');
    const linked = await mkdtemp(join(tmpdir(), 'rac-comparison-linked-'));
    roots.push(linked);
    await git(root, 'worktree', 'add', linked, 'release/source');
    await git(linked, 'switch', '-c', 'feature/linked');

    expect(await prComparisonCandidates(linked, 'feature/linked')).toEqual([
      'release/source',
      'origin/release/source',
      'origin/main',
      'main'
    ]);
  });

  // retain recent source evidence beyond the subprocess output limit
  it('finds the source in a large HEAD reflog using checkout time rather than commit time', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await execute('/usr/bin/git', ['-C', root, 'commit', '-m', 'base'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }
    });
    await git(root, 'switch', '-c', 'release/source');
    const sha = (await git(root, 'rev-parse', 'HEAD')).trim();
    const oldRecord = `${sha} ${sha} Compare Fixture <compare@example.com> 946684800 +0000\tcommit: ${'old history '.repeat(1000)}\n`;
    await writeFile(join(root, '.git/logs/HEAD'), oldRecord.repeat(100));
    await git(root, 'switch', '-c', 'feature/large-reflog');

    expect(await prComparisonCandidates(root, 'feature/large-reflog')).toEqual([
      'release/source', 'origin/release/source', 'origin/main', 'main'
    ]);
  });

  // resolve real branch names before classifying detached object ids
  it('keeps a hexadecimal branch name as the source', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'deadbee');
    await git(root, 'switch', '-c', 'feature');

    expect(await prComparisonCandidates(root, 'feature')).toEqual([
      'deadbee', 'origin/deadbee', 'origin/main', 'main'
    ]);
  });

  // preserve remote and local PR refs ahead of source fallbacks
  it('puts the PR base before source and default branches when gh-merge-base is unset', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'branch', 'release/target');
    await git(root, 'switch', '-c', 'feature');
    await git(root, 'remote', 'add', 'upstream', 'https://example.com/repository.git');

    const candidates = await prComparisonCandidates(root, 'feature', 'release/target', 'develop');
    expect(candidates.slice(0, 2)).toEqual(['origin/release/target', 'release/target']);
    expect((await prComparisonCandidates(root, 'feature', 'upstream/release/target')).slice(0, 2)).toEqual([
      'upstream/release/target',
      'release/target'
    ]);
    expect((await prComparisonCandidates(root, 'feature', 'refs/heads/upstream/release/target')).slice(0, 2)).toEqual([
      'origin/upstream/release/target',
      'refs/heads/upstream/release/target'
    ]);
    expect((await comparisonAgainst(root, await prComparisonCandidates(root, 'feature', 'origin/release/target')))?.comparison.base).toBe('release/target');
  });

  // preserve the requested fallback order
  it('uses the configured default branch and then main when source provenance is unavailable', async () => {
    const root = await repo();

    expect(await prComparisonCandidates(root, undefined, undefined, 'release/stable')).toEqual([
      'origin/release/stable',
      'release/stable',
      'origin/main',
      'main'
    ]);
    expect(await prComparisonCandidates(root, undefined)).toEqual(['origin/main', 'main']);
  });

  // honor the branch-specific GitHub CLI preference before all other bases
  it('prefers gh-merge-base when source provenance is unavailable', async () => {
    const root = await repo();
    await git(root, 'remote', 'add', 'upstream', 'https://example.com/repository.git');
    await git(root, 'config', 'branch.feature.gh-merge-base', 'upstream/release/stable');

    expect(await prComparisonCandidates(root, 'feature', undefined, 'develop')).toEqual([
      'upstream/release/stable',
      'release/stable',
      'origin/develop',
      'develop',
      'origin/main',
      'main'
    ]);
  });

  // resolve each usable level before trying the next fallback
  it('falls back from gh-merge-base to PR, source, default, and main in order', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    // give every fallback its own branch identity
    for (const branch of ['develop', 'source', 'release/pr', 'release/configured']) await git(root, 'branch', branch);
    await git(root, 'switch', '-c', 'feature', 'source');
    await git(root, 'config', 'branch.feature.gh-merge-base', 'release/configured');
    // resolve through real git refs rather than just inspecting candidate order
    const selectedBase = async () => (await comparisonAgainst(root, await prComparisonCandidates(root, 'feature', 'release/pr', 'develop')))?.comparison.base;

    expect(await selectedBase()).toBe('release/configured');
    await git(root, 'config', 'branch.feature.gh-merge-base', 'missing');
    expect(await selectedBase()).toBe('release/pr');
    await git(root, 'config', 'branch.feature.gh-merge-base', '');
    expect(await selectedBase()).toBe('release/pr');
    await git(root, 'config', '--unset', 'branch.feature.gh-merge-base');
    expect(await selectedBase()).toBe('release/pr');
    await git(root, 'branch', '-D', 'release/pr');
    expect(await selectedBase()).toBe('source');
    await git(root, 'branch', '-D', 'source');
    expect(await selectedBase()).toBe('develop');
    await git(root, 'branch', '-D', 'develop');
    expect(await selectedBase()).toBe('main');
  });

  // ignore publication tracking as source evidence
  it('does not mistake a same-name published upstream for the branch source', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await git(root, 'config', 'branch.feature.remote', 'origin');
    await git(root, 'config', 'branch.feature.merge', 'refs/heads/feature');

    expect(await prComparisonCandidates(root, 'feature')).toEqual(['main', 'origin/main']);
  });

  // discard unusable provenance before fallback
  it('falls back when the recorded source is missing or the branch was created from detached HEAD', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'branch', 'temporary-source');
    await git(root, 'branch', 'missing-source', 'temporary-source');
    await git(root, 'branch', '-D', 'temporary-source');
    expect(await prComparisonCandidates(root, 'missing-source', undefined, 'develop')).toEqual([
      'origin/develop',
      'develop',
      'origin/main',
      'main'
    ]);

    const head = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'switch', '--detach', head);
    await git(root, 'switch', '-c', 'detached-feature');
    expect(await prComparisonCandidates(root, 'detached-feature', undefined, 'develop')).toEqual([
      'origin/develop',
      'develop',
      'origin/main',
      'main'
    ]);
  });

  it('saves a branch base on origin that the candidate ladder then compares against', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.txt'), 'a\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(root, 'switch', '-c', 'stack/parent');
    await writeFile(join(root, 'parent.txt'), 'parent\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'parent');
    await git(root, 'update-ref', 'refs/remotes/origin/stack/parent', 'HEAD');
    await git(root, 'switch', '-c', 'child');
    await writeFile(join(root, 'child.txt'), 'child\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'child');

    await expect(mergeBaseChoices(root)).resolves.toEqual({ branch: 'child', branches: ['main', 'stack/parent'] });
    await expect(saveMergeBase(root, 'local-only')).resolves.toBe('unknown_base');
    await expect(saveMergeBase(root, 'stack/parent')).resolves.toBe('saved');
    expect((await mergeBaseChoices(root))?.configured).toBe('stack/parent');
    // a slashed bare name means the origin branch, not a local ref of that name
    const against = await comparisonAgainst(root, await prComparisonCandidates(root, 'child'));
    expect(against?.comparison.base).toBe('origin/stack/parent');
    expect(against?.comparison.changes.map(change => change.path)).toEqual(['child.txt']);

    await expect(saveMergeBase(root, null)).resolves.toBe('saved');
    await expect(saveMergeBase(root, null)).resolves.toBe('saved');
    expect((await mergeBaseChoices(root))?.configured).toBeUndefined();
    await git(root, 'switch', '--detach');
    await expect(saveMergeBase(root, 'main')).resolves.toBe('detached');
  });

  it('overrides the base through comparisonAgainst', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.txt'), 'a\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'a.txt'), 'a\nb\n');
    await git(root, 'commit', '-am', 'feature');

    const against = await comparisonAgainst(root, ['main']);
    expect(against?.comparison.base).toBe('main');
    expect(against?.gitBase).toMatch(/^[0-9a-f]{40}$/u);
    await expect(comparisonAgainst(root, ['no-such-branch'])).resolves.toBeUndefined();
  });

  // resolve only branch namespaces
  it('resolves branch candidates exactly instead of accepting tags with the same names', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'tag', 'collision');
    await git(root, 'tag', 'tag-only');
    await writeFile(join(root, 'branch.txt'), 'branch\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'branch base');
    await git(root, 'branch', 'collision');
    const branchHead = (await git(root, 'rev-parse', 'refs/heads/collision')).trim();
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'feature.txt'), 'feature\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');

    expect((await comparisonAgainst(root, ['collision']))?.gitBase).toBe(branchHead);
    expect((await commitLog(root, ['collision']))?.commits.map(commit => commit.subject)).toEqual(['feature']);
    await expect(comparisonAgainst(root, ['tag-only'])).resolves.toBeUndefined();
    await expect(commitLog(root, ['tag-only'])).resolves.toBeUndefined();
  });

  // keep missing remote refs distinct from unrelated local slash names
  it.each(['origin', 'upstream'])('does not resolve a missing %s ref to a same-named local branch', async remote => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'remote', 'add', remote, 'https://example.com/repository.git');
    await git(root, 'branch', `${remote}/main`);
    await writeFile(join(root, 'main.txt'), 'main\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'main work');
    const mainHead = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'switch', '-c', 'feature');
    await git(root, 'commit', '--allow-empty', '-m', 'feature work');

    const candidates = await prComparisonCandidates(root, 'feature', `${remote}/main`);
    expect((await comparisonAgainst(root, candidates))?.gitBase).toBe(mainHead);
    expect((await commitLog(root, candidates))?.commits.map(commit => commit.subject)).toEqual(['feature work']);
  });
});

describe('working status line stats', () => {
  it('enriches additions and deletions only when asked', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\n');

    const plain = await workingStatus(root);
    expect(plain?.changes?.[0]).toMatchObject({ path: 'a.ts' });
    expect(plain?.changes?.[0]?.additions).toBeUndefined();

    const enriched = await workingStatus(root, { lineStats: true });
    expect(enriched?.changes?.[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 0 });
  });
});

describe('comparison patch capture', () => {
  const bigLimits = { perFileBytes: 1_000_000, totalBytes: 10_000_000, maxFiles: 1_000 };

  async function scenario(): Promise<{ root: string; comparison: Comparison }> {
    const root = await repo();
    await Promise.all([
      writeFile(join(root, 'keep.ts'), 'a\n'),
      writeFile(join(root, 'gone.ts'), 'bye\n'),
      writeFile(join(root, 'old.ts'), 'line1\nline2\nline3\nline4\n'),
      writeFile(join(root, 'img.png'), binary)
    ]);
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'keep.ts'), 'a\nb\n');
    await git(root, 'mv', 'old.ts', 'renamed.ts');
    await writeFile(join(root, 'renamed.ts'), 'line1\nline2\nline3\nline4\nline5\n');
    await git(root, 'rm', 'gone.ts');
    await writeFile(join(root, 'added.ts'), 'brand new\n');
    await writeFile(join(root, 'img.png'), Buffer.concat([binary, Buffer.from([0x09, 0x00])]));
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');
    await writeFile(join(root, 'note.txt'), 'untracked line\n');
    const result = await resolveComparison(root, 'pr', ['main']);
    if (!result.ok) throw new Error(`unexpected ${result.reason}`);
    return { root, comparison: result.comparison };
  }

  it('captures adds, deletes, renames, untracked, and binary files with correct patch text', async () => {
    const { root, comparison } = await scenario();
    const patch = await captureComparisonPatch(root, comparison, bigLimits);

    // an added file is all-added; a deleted file is all-removed
    expect(fileFor(patch, 'added.ts')?.patch).toContain('+brand new');
    expect(fileFor(patch, 'gone.ts')?.patch).toContain('-bye');
    // a modified file shows the inserted line
    expect(fileFor(patch, 'keep.ts')?.patch).toContain('+b');
    // a rename is recognised with its origin
    expect(fileFor(patch, 'renamed.ts')?.change.originalPath).toBe('old.ts');
    // the untracked file is synthesised as an all-added patch
    const note = fileFor(patch, 'note.txt');
    expect(note?.kind).toBe('untracked');
    expect(note?.patch).toContain('+untracked line');
    // the binary file is captured as a binary git patch
    expect(fileFor(patch, 'img.png')?.patch).toContain('GIT binary patch');
    expect(patch.truncated).toBe(false);
  });

  it('captures standard a/ b/ prefixes regardless of the user git prefix config', async () => {
    const { root, comparison } = await scenario();
    // A reviewer with diff.mnemonicPrefix (c/ w/ i/ …) or diff.noprefix set would otherwise get a
    // header the diff library rejects, leaving the file nameless and breaking file-at-revision loads
    // (full context, Load anyway) and the Review tour.
    await git(root, 'config', 'diff.mnemonicPrefix', 'true');
    await git(root, 'config', 'diff.noprefix', 'true');
    const patch = await captureComparisonPatch(root, comparison, bigLimits);
    const keep = fileFor(patch, 'keep.ts');
    expect(keep?.patch).toContain('diff --git a/keep.ts b/keep.ts');
    expect(keep?.patch).toContain('--- a/keep.ts');
    expect(keep?.patch).toContain('+++ b/keep.ts');
    // no mnemonic/no-prefix header leaked through
    expect(keep?.patch).not.toMatch(/ [cwio]\/keep\.ts/u);
  });

  it('marks files past the per-file cap and truncates past the total cap', async () => {
    const { root, comparison } = await scenario();

    const perFile = await captureComparisonPatch(root, comparison, { perFileBytes: 1, totalBytes: 10_000_000, maxFiles: 1_000 });
    // every real diff is larger than one byte, so all files are withheld for lazy loading
    expect(perFile.files.every(file => file.capped && file.patch === '')).toBe(true);
    expect(perFile.truncated).toBe(false);

    const total = await captureComparisonPatch(root, comparison, { perFileBytes: 1_000_000, totalBytes: 1, maxFiles: 1_000 });
    expect(total.truncated).toBe(true);
    expect(total.files.every(file => file.capped)).toBe(true);

    // a budget one byte under the full total exercises the RUNNING total: early files are captured
    // and a later one tips it over. A per-file-only cap (no accumulation) would truncate nothing here.
    const full = await captureComparisonPatch(root, comparison, bigLimits);
    const sumAll = full.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch), 0);
    const mid = await captureComparisonPatch(root, comparison, { perFileBytes: 1_000_000, totalBytes: sumAll - 1, maxFiles: 1_000 });
    expect(mid.files.some(file => !file.capped && file.patch !== '')).toBe(true);
    expect(mid.files.some(file => file.capped)).toBe(true);
    expect(mid.truncated).toBe(true);

    // the file-count cap stops capture and marks the result truncated
    const count = await captureComparisonPatch(root, comparison, { perFileBytes: 1_000_000, totalBytes: 10_000_000, maxFiles: 1 });
    expect(count.files).toHaveLength(1);
    expect(count.truncated).toBe(true);
  });

  // re-resolve the PR comparison after a working-tree edit
  async function reresolve(root: string): Promise<Comparison> {
    const result = await resolveComparison(root, 'pr', ['main']);
    if (!result.ok) throw new Error(`unexpected ${result.reason}`);
    return result.comparison;
  }

  it('produces a stable fingerprint sensitive to both patch text and capped line counts', async () => {
    const { root, comparison } = await scenario();
    const first = await captureComparisonPatch(root, comparison, bigLimits);
    expect((await captureComparisonPatch(root, comparison, bigLimits)).fingerprint).toBe(first.fingerprint);

    // a same-line-count edit (keep.ts a\nb\n -> a\nX\n, still +1 line) changes only the patch text,
    // not the numstat counts: the fingerprint must still move, so it cannot ignore patch text
    await writeFile(join(root, 'keep.ts'), 'a\nX\n');
    const sameCount = await captureComparisonPatch(root, await reresolve(root), bigLimits);
    expect(sameCount.fingerprint).not.toBe(first.fingerprint);

    // when keep.ts is capped (patch withheld) a line-count change must still move the fingerprint,
    // so it cannot rely on patch text alone for capped files
    const tinyPerFile = { perFileBytes: 4, totalBytes: 10_000_000, maxFiles: 1_000 };
    const cappedBefore = await captureComparisonPatch(root, await reresolve(root), tinyPerFile);
    expect(fileFor(cappedBefore, 'keep.ts')).toMatchObject({ capped: true, patch: '' });
    await writeFile(join(root, 'keep.ts'), 'a\nX\nY\nZ\n');
    const cappedAfter = await captureComparisonPatch(root, await reresolve(root), tinyPerFile);
    expect(fileFor(cappedAfter, 'keep.ts')).toMatchObject({ capped: true, patch: '' });
    expect(cappedAfter.fingerprint).not.toBe(cappedBefore.fingerprint);
  });
});

describe('per-file patch primitives', () => {
  it('synthesizes an untracked patch and reports oversized files', async () => {
    const root = await repo();
    await writeFile(join(root, 'small.txt'), 'one\ntwo\n');
    const change = { code: '??', path: 'small.txt' };
    const synth = await synthesizeUntrackedPatch(root, change, 1_000);
    expect(synth).toEqual({ patch: '--- /dev/null\n+++ b/small.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n', kind: 'untracked' });

    await writeFile(join(root, 'big.txt'), 'x'.repeat(64));
    await expect(synthesizeUntrackedPatch(root, { code: '??', path: 'big.txt' }, 8)).resolves.toEqual({ tooLarge: true });
  });

  it('renders untracked binary files and symlinks as metadata without following them', async () => {
    const root = await repo();
    await writeFile(join(root, 'img.png'), binary);
    const bin = await synthesizeUntrackedPatch(root, { code: '??', path: 'img.png' }, 1_000);
    expect(bin).toMatchObject({ kind: 'binary' });
    if ('patch' in bin) expect(bin.patch).toContain('new binary file img.png');

    // a symlink is described by its target, never read through (containment guard)
    await symlink('/etc/passwd', join(root, 'link'));
    const link = await synthesizeUntrackedPatch(root, { code: '??', path: 'link' }, 1_000);
    expect(link).toMatchObject({ kind: 'metadata' });
    if ('patch' in link) expect(link.patch).toContain('new symlink link -> /etc/passwd');
  });

  it('captures a tracked patch and reports git failures', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.ts'), 'one\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');

    const ok = await capturePatch(root, 'HEAD', { code: ' M', path: 'a.ts' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.patch).toContain('+two');

    const failed = await capturePatch(root, 'not-a-ref', { code: ' M', path: 'a.ts' });
    expect(failed.ok).toBe(false);
  });
});

describe('file at revision', () => {
  it('reads an existing revision, the working tree, missing paths, and binary blobs', async () => {
    const root = await repo();
    await Promise.all([
      writeFile(join(root, 'a.ts'), 'committed\n'),
      writeFile(join(root, 'img.png'), binary)
    ]);
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await writeFile(join(root, 'a.ts'), 'working tree\n');

    // an existing revision returns the committed bytes
    await expect(fileAtRevision(root, { commit: 'HEAD' }, 'a.ts')).resolves.toEqual({ path: 'a.ts', size: 10, binary: false, truncated: false, content: 'committed\n' });
    // the working tree returns the uncommitted bytes
    await expect(fileAtRevision(root, { workingTree: true }, 'a.ts')).resolves.toMatchObject({ binary: false, content: 'working tree\n' });
    // a missing path resolves undefined at both a revision and the working tree
    await expect(fileAtRevision(root, { commit: 'HEAD' }, 'nope.ts')).resolves.toBeUndefined();
    await expect(fileAtRevision(root, { workingTree: true }, 'nope.ts')).resolves.toBeUndefined();
    // a binary blob is flagged with no textual content
    const image = await fileAtRevision(root, { commit: 'HEAD' }, 'img.png');
    expect(image).toMatchObject({ path: 'img.png', binary: true });
    expect(image?.content).toBeUndefined();
  });

  it('truncates a large blob, rejects trees, and refuses an option-like revision', async () => {
    const root = await repo();
    const big = `${'x'.repeat(2 * 1024 * 1024)}\n`;
    const sizable = `${'y'.repeat(300 * 1024)}\n`;
    await mkdir(join(root, 'dir'));
    await Promise.all([
      writeFile(join(root, 'big.txt'), big),
      writeFile(join(root, 'sizable.txt'), sizable),
      writeFile(join(root, 'dir', 'inner.txt'), 'inner\n')
    ]);
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');

    // a blob past the 2 MB cap comes back truncated with its true size and a capped body
    const large = await fileAtRevision(root, { commit: 'HEAD' }, 'big.txt');
    expect(large).toMatchObject({ path: 'big.txt', binary: false, truncated: true });
    expect(large?.size).toBe(Buffer.byteLength(big));
    expect(large?.content?.length).toBe(2 * 1024 * 1024);
    // a file past the 256 KB preview cap still reads whole, at a revision and in the working tree
    await expect(fileAtRevision(root, { commit: 'HEAD' }, 'sizable.txt')).resolves.toMatchObject({ truncated: false, content: sizable });
    await expect(fileAtRevision(root, { workingTree: true }, 'sizable.txt')).resolves.toMatchObject({ truncated: false, content: sizable });

    // a directory path resolves to a tree object, not a readable file
    await expect(fileAtRevision(root, { commit: 'HEAD' }, 'dir')).resolves.toBeUndefined();
    // a revision git would read as an option (arbitrary-file-write primitive) is refused
    await expect(fileAtRevision(root, { commit: '--output=escape.txt' }, 'big.txt')).resolves.toBeUndefined();
    // a NUL in the path is treated as absent rather than throwing
    await expect(fileAtRevision(root, { commit: 'HEAD' }, 'big\0.txt')).resolves.toBeUndefined();
  });
});
