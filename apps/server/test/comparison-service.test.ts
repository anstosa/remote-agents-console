import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ComparisonService, type PreferredBaseResolver } from '../src/git/comparison-service.js';
import { commitLog } from '../src/git/comparison.js';
import type { Worktree } from '../src/domain/models.js';

const execute = promisify(execFile);
const roots: string[] = [];

// run one fixture Git command, returning its stdout
async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('/usr/bin/git', ['-C', root, ...args]);
  return stdout;
}

// initialise an empty repository on `main`
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-comparison-service-'));
  roots.push(root);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'compare@example.com');
  await git(root, 'config', 'user.name', 'Compare Fixture');
  return root;
}

// a worktree record pointing the service at one fixture repo
function worktree(root: string, overrides: Partial<Worktree> = {}): Worktree {
  return { id: 'w1', projectId: 'p1', label: 'Fixture', path: root, identity: root, available: true, pinned: false, main: true, detached: false, locked: false, branch: 'feature', ...overrides };
}

// the base resolver: `main` for an All PR fixture, or none (the full ladder finds nothing without a remote)
const noBase: PreferredBaseResolver = async () => undefined;
const baseMain: PreferredBaseResolver = async () => 'main';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// build a repo with a `main` base commit and a `feature` checkout that modifies, renames, deletes,
// adds, and leaves one file untracked — the standard fixture the Comparison reads
async function featureRepo(): Promise<string> {
  const root = await repo();
  await mkdir(join(root, 'src'), { recursive: true });
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
  // uncommitted working-tree edits on top of the feature commit
  await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\nv3\n');
  await writeFile(join(root, 'note.txt'), 'a note\n');
  return root;
}

describe('ComparisonService patch', () => {
  it('captures the Working Comparison with a fingerprint and per-file patches', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    const result = await service.patch(worktree(root), 'working');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('working');
    expect(result.patch.base).toBe('HEAD');
    expect(result.patch.fingerprint).toMatch(/^[\w-]+$/u);
    const paths = result.patch.files.map(file => file.change.path).sort();
    expect(paths).toEqual(['note.txt', 'src/a.ts']);
    const modified = result.patch.files.find(file => file.change.path === 'src/a.ts');
    expect(modified?.patch).toContain('+v3');
    const untracked = result.patch.files.find(file => file.change.path === 'note.txt');
    expect(untracked?.kind).toBe('untracked');
    expect(untracked?.patch).toContain('+a note');
  });

  it('compares against the resolved base for an All PR Comparison', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const result = await service.patch(worktree(root), 'pr');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.base).toBe('main');
    const paths = result.patch.files.map(file => file.change.path).sort();
    // the PR Comparison spans the whole feature branch plus the untracked working-tree file
    expect(paths).toEqual(['added.ts', 'gone.ts', 'note.txt', 'renamed.ts', 'src/a.ts']);
  });

  // refuse comparison after every branch fallback disappears
  it('reports a failure reason when no base resolves for an All PR Comparison', async () => {
    const root = await featureRepo();
    await git(root, 'branch', '-D', 'main');
    // no resolved base, retained source, configured default, or main branch
    const service = new ComparisonService(noBase);
    const result = await service.patch(worktree(root, { branch: 'feature' }), 'pr');
    expect(result).toEqual({ ok: false, reason: 'no_base' });
  });

  // keep an unavailable known pr unavailable
  it('does not fall back when a known PR has no usable base', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(async () => null);

    await expect(service.patch(worktree(root, { defaultBranch: 'main' }), 'pr')).resolves.toEqual({ ok: false, reason: 'no_base' });
    await expect(service.commits(worktree(root, { defaultBranch: 'main' }))).resolves.toBeUndefined();
  });

  // share the configured fallback across patch and log reads
  it('uses the workspace default branch for both the All PR patch and commit log', async () => {
    const root = await repo();
    await writeFile(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'main base');
    await git(root, 'switch', '-c', 'release/default');
    await writeFile(join(root, 'default.txt'), 'default\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'default base');
    const defaultHead = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'switch', '--detach', defaultHead);
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'feature.txt'), 'feature\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature work');
    const configured = worktree(root, { defaultBranch: 'release/default' });
    const service = new ComparisonService(noBase);

    const patch = await service.patch(configured, 'pr');
    expect(patch.ok).toBe(true);
    // require a resolved patch before inspecting its base
    if (!patch.ok) return;
    expect(patch.patch.base).toBe('release/default');
    expect(patch.patch.files.map(file => file.change.path)).toEqual(['feature.txt']);
    const commits = await service.commits(configured);
    expect(commits?.base).toBe('release/default');
    expect(commits?.commits.map(commit => commit.subject)).toEqual(['feature work']);
  });

  it('marks a file past the per-file cap as capped without its patch', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await writeFile(join(root, 'big.txt'), `${'x'.repeat(5_000)}\n`);
    const service = new ComparisonService(noBase, { perFileBytes: 100, totalBytes: 1_000, maxFiles: 10 });
    const result = await service.patch(worktree(root), 'working');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const big = result.patch.files.find(file => file.change.path === 'big.txt');
    expect(big?.capped).toBe(true);
    expect(big?.patch).toBe('');
  });

  it('moves the fingerprint when a size-capped untracked file is edited in place (F2)', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    // an untracked file whose patch is withheld by the per-file cap
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(400));
    const service = new ComparisonService(noBase, { perFileBytes: 100, totalBytes: 10_000, maxFiles: 10 });
    const before = await service.patch(worktree(root), 'working');
    // append lines to the capped untracked file
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(600));
    const after = await service.patch(worktree(root), 'working');
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // the withheld file stays capped across both captures, but its enriched line count moves the fingerprint
    expect(before.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.fingerprint).not.toBe(before.patch.fingerprint);
  });

  it('moves the All PR fingerprint when a size-capped untracked file is edited in place', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(400));
    const service = new ComparisonService(baseMain, { perFileBytes: 100, totalBytes: 10_000, maxFiles: 10 });
    const before = await service.patch(worktree(root), 'pr');
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(600));
    const after = await service.patch(worktree(root), 'pr');
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // untracked entries are copied into an All PR Comparison, yet the enrichment still moves the fingerprint
    expect(before.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.fingerprint).not.toBe(before.patch.fingerprint);
  });
});

describe('ComparisonService commit scope', () => {
  it('shows only one commit\'s Changes, not later commits or working edits to the same files', async () => {
    const root = await featureRepo();
    const feature = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'second');
    await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\nv3\nv4\n');
    const service = new ComparisonService(noBase);
    const result = await service.patch(worktree(root), { commit: feature });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('commit');
    expect(result.patch.gitBase).toBe((await git(root, 'rev-parse', 'main')).trim());
    expect(result.patch.files.map(file => [file.change.code, file.change.path]).sort()).toEqual([['A ', 'added.ts'], ['D ', 'gone.ts'], ['M ', 'src/a.ts'], ['R ', 'renamed.ts']]);
    const patch = result.patch.files.find(file => file.change.path === 'src/a.ts')?.patch ?? '';
    expect(patch).toContain('+v2');
    expect(patch).not.toContain('v3');
    // the new side reads the commit, not the working tree
    const file = await service.file(worktree(root), { commit: feature }, 'src/a.ts');
    expect(file).toMatchObject({ ok: true, base: { content: 'v1\n' }, working: { content: 'v1\nv2\n' } });
  });

  it('compares a root commit with the empty tree', async () => {
    const root = await featureRepo();
    const first = (await git(root, 'rev-parse', 'main')).trim();
    const result = await new ComparisonService(noBase).patch(worktree(root), { commit: first });
    expect(result.ok && result.patch.files.map(file => file.change.path).sort()).toEqual(['gone.ts', 'old.ts', 'src/a.ts']);
  });

  it('refuses a commit HEAD does not contain, or anything but an object id', async () => {
    const root = await featureRepo();
    // a commit on main's tree that the feature branch never merged
    const side = (await git(root, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'side')).trim();
    const service = new ComparisonService(noBase);
    for (const commit of [side, 'HEAD', '--output=/tmp/x', side.slice(0, 7)]) {
      expect(await service.patch(worktree(root), { commit })).toEqual({ ok: false, reason: 'unavailable' });
    }
  });
});

describe('ComparisonService commits', () => {
  it('lists the All PR commits newest first with their own Changes, merges, and pushed state', async () => {
    const root = await featureRepo();
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'second', '-m', 'Why the second\ncommit exists.');
    // an upstream that has the first feature commit only
    await git(root, 'branch', 'published', 'HEAD~1');
    await git(root, 'branch', '--set-upstream-to=published');
    // merging a side branch adds a merge commit and the side branch's own commit
    await git(root, 'switch', '-c', 'side', 'HEAD~1');
    await writeFile(join(root, 'side.ts'), 'side\n');
    await git(root, 'add', 'side.ts');
    await git(root, 'commit', '-m', 'side work');
    await git(root, 'switch', 'feature');
    await git(root, 'merge', '--no-ff', '-m', 'merge side', 'side');
    const log = await new ComparisonService(baseMain).commits(worktree(root));
    expect(log?.base).toBe('main');
    expect(log?.truncated).toBe(false);
    const bySubject = new Map(log?.commits.map(commit => [commit.subject, commit]));
    expect(log?.commits[0]?.subject).toBe('merge side');
    expect(bySubject.get('merge side')).toMatchObject({ merge: true, pushed: false, changes: [] });
    expect(bySubject.get('second')).toMatchObject({ merge: false, pushed: false, body: 'Why the second\ncommit exists.', author: 'Compare Fixture' });
    expect(bySubject.get('second')?.changes.map(change => [change.code, change.path, change.additions, change.deletions]).sort()).toEqual([['A ', 'note.txt', 1, 0], ['M ', 'src/a.ts', 1, 0]]);
    expect(bySubject.get('side work')?.changes.map(change => change.path)).toEqual(['side.ts']);
    const feature = bySubject.get('feature');
    expect(feature?.pushed).toBe(true);
    expect(feature?.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(feature?.changes.map(change => [change.code, change.path, change.originalPath]).sort()).toEqual([['A ', 'added.ts', undefined], ['D ', 'gone.ts', undefined], ['M ', 'src/a.ts', undefined], ['R ', 'renamed.ts', 'old.ts']]);
    expect(feature?.changes.find(change => change.path === 'renamed.ts')).toMatchObject({ additions: 1, deletions: 0 });
  });

  it('caps the log and leaves every commit unpushed without an upstream', async () => {
    const root = await featureRepo();
    await git(root, 'commit', '--allow-empty', '-m', 'empty');
    const log = await commitLog(root, ['main'], 1);
    expect(log?.truncated).toBe(true);
    expect(log?.commits.map(commit => [commit.subject, commit.pushed, commit.changes])).toEqual([['empty', false, []]]);
  });

  // require every branch fallback to be unavailable
  it('is unavailable when no base resolves', async () => {
    const root = await featureRepo();
    await git(root, 'branch', '-D', 'main');
    expect(await new ComparisonService(noBase).commits(worktree(root))).toBeUndefined();
  });
});

describe('ComparisonService file', () => {
  it('returns a modified file at the base and the working tree', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    const result = await service.file(worktree(root), 'working', 'src/a.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base?.content).toBe('v1\nv2\n');
    expect(result.working?.content).toBe('v1\nv2\nv3\n');
  });

  it('reads a rename origin at the base and the new path at the working tree', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const result = await service.file(worktree(root), 'pr', 'renamed.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the base holds the pre-rename contents (from old.ts); the working tree holds the renamed file
    expect(result.base?.content).toBe('line1\nline2\nline3\nline4\n');
    expect(result.working?.content).toBe('line1\nline2\nline3\nline4\nline5\n');
  });

  it('omits the base for an added file and the working side for a deleted file', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const added = await service.file(worktree(root), 'pr', 'added.ts');
    expect(added.ok).toBe(true);
    if (added.ok) { expect(added.base).toBeUndefined(); expect(added.working?.content).toBe('brand new\n'); }
    const deleted = await service.file(worktree(root), 'pr', 'gone.ts');
    expect(deleted.ok).toBe(true);
    if (deleted.ok) { expect(deleted.base?.content).toBe('bye\n'); expect(deleted.working).toBeUndefined(); }
  });

  it('serves a new file at a rename origin path, not the renamed file, when both exist', async () => {
    const root = await repo();
    await writeFile(join(root, 'old.ts'), 'the original\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    // rename old.ts -> new.ts, then create a brand-new untracked file back at old.ts
    await git(root, 'mv', 'old.ts', 'new.ts');
    await git(root, 'commit', '-am', 'rename');
    await writeFile(join(root, 'old.ts'), 'a different new file\n');
    const service = new ComparisonService(baseMain);
    const result = await service.file(worktree(root), 'pr', 'old.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the exact path match wins: `old.ts` now names the new untracked file, not the rename origin
    expect(result.working?.content).toBe('a different new file\n');
  });

  it('refuses a path that is not a Change in the Comparison', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    // src/a.ts and note.txt are the only Working Changes; unchanged.ts is not, even though it exists
    await writeFile(join(root, 'src', 'unchanged.ts'), 'committed\n');
    await git(root, 'add', 'src/unchanged.ts');
    await git(root, 'commit', '-m', 'add unchanged');
    const result = await service.file(worktree(root), 'working', 'src/unchanged.ts');
    expect(result).toEqual({ ok: false, reason: 'not_in_comparison' });
  });
});
