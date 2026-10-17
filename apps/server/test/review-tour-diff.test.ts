import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_REVIEW_FILE_BYTES } from '../src/review-tour/contracts.js';
import { captureReviewComparison } from '../src/review-tour/diff.js';
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
    agent: { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: root, title: 'Ready' },
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

  it('retains the dashboard comparison when resolving a PR snapshot', async () => {
    const raw = await fixture();
    const enriched = { ...raw.agent, branch: 'feature/review-tour', worktreeId: raw.worktree.id, gitPrStatus: { base: 'main', files: 3, changes: [] } };
    const discovery = {
      // serve fast target metadata
      target: async () => ({ agent: raw.agent, socket: {} }),
      worktreesNow: () => [raw.worktree],
      // serve enriched comparison metadata
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [enriched], projects: [] })
    };

    const resolved = await resolveConfiguredWorkspace(discovery as never, raw.agent.id);

    expect(resolved?.agent.gitPrStatus?.base).toBe('main');
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
