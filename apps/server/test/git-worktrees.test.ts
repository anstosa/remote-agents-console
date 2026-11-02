import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { gitCommonDir, listWorktrees, parseWorktreeList, parseWorktreeListNul } from '../src/git/worktrees.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };
async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-wt-')));
  dirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'readme.md'), 'hi\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

describe('parseWorktreeList', () => {
  it('parses main, linked, detached, bare, locked and prunable entries', () => {
    const porcelain = [
      'worktree /repo/main', 'HEAD aaaa1111', 'branch refs/heads/main', '',
      'worktree /repo/feature', 'HEAD bbbb2222', 'branch refs/heads/feat/x', '',
      'worktree /repo/detached', 'HEAD cccc3333', 'detached', '',
      'worktree /repo/bare', 'bare', '',
      'worktree /repo/locked', 'HEAD dddd4444', 'branch refs/heads/held', 'locked on purpose', '',
      'worktree /repo/gone', 'HEAD eeee5555', 'detached', 'prunable gitdir file points to non-existent location', ''
    ].join('\n');
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repo/main', head: 'aaaa1111', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/repo/feature', head: 'bbbb2222', branch: 'feat/x', detached: false, bare: false, locked: false, prunable: false },
      { path: '/repo/detached', head: 'cccc3333', detached: true, bare: false, locked: false, prunable: false },
      { path: '/repo/bare', detached: false, bare: true, locked: false, prunable: false },
      { path: '/repo/locked', head: 'dddd4444', branch: 'held', detached: false, bare: false, locked: true, lockedReason: 'on purpose', prunable: false },
      { path: '/repo/gone', head: 'eeee5555', detached: true, bare: false, locked: false, prunable: true, prunableReason: 'gitdir file points to non-existent location' }
    ]);
  });
  it('tolerates a trailing entry without a final blank line and a bare `locked` with no reason', () => {
    const porcelain = 'worktree /repo/main\nHEAD aaaa\nbranch refs/heads/main\nlocked\n';
    expect(parseWorktreeList(porcelain)).toEqual([{ path: '/repo/main', head: 'aaaa', branch: 'main', detached: false, bare: false, locked: true, prunable: false }]);
  });
  it('parses nul-delimited paths and reasons containing newlines without splitting records', () => {
    const porcelain = ['worktree /repo/line\nbreak', 'HEAD aaaa', 'branch refs/heads/main', 'locked first\nsecond', '', 'worktree /repo/next', 'HEAD bbbb', 'detached', ''].join('\0');
    expect(parseWorktreeListNul(porcelain)).toEqual([
      { path: '/repo/line\nbreak', head: 'aaaa', branch: 'main', detached: false, bare: false, locked: true, lockedReason: 'first\nsecond', prunable: false },
      { path: '/repo/next', head: 'bbbb', detached: true, bare: false, locked: false, prunable: false }
    ]);
  });
});

describe('gitCommonDir and listWorktrees', () => {
  it('reports the common dir and every checkout for a repository with a linked worktree', async () => {
    const root = await repo();
    const linked = `${root}-wt`;
    dirs.push(linked);
    await git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const common = await gitCommonDir(root);
    expect(common).toBe(await realpath(join(root, '.git')));
    // a linked worktree resolves to the same common dir — the shared identity
    expect(await gitCommonDir(linked)).toBe(common);
    const worktrees = await listWorktrees(root);
    expect(worktrees?.map(entry => ({ path: entry.path, branch: entry.branch }))).toEqual([
      { path: root, branch: 'main' },
      { path: linked, branch: 'feature' }
    ]);
    expect(worktrees?.[0]?.bare).toBe(false);
  });
  it('returns undefined outside a git repository', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'rac-plain-')));
    dirs.push(plain);
    expect(await gitCommonDir(plain)).toBeUndefined();
    expect(await listWorktrees(plain)).toBeUndefined();
  });
});
