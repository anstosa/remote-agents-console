import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanWorkingTree } from '../src/git/worktree-state.js';
import { gitCommonDir, listWorktrees } from '../src/git/worktrees.js';
import { run } from '../src/tmux/command.js';

// The console runs git in Worktrees a Sandboxed Agent may write to (ADR 0004), so its own git
// takes nothing from a repository there that would run code: these are what a command could
// leave behind, and the console's git running over them.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
function scratch(): { root: string; work: string; marker: (name: string) => string; script: (name: string) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rac-git-overrides-')));
  roots.push(root);
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'init');
  const marker = (name: string) => join(root, `ran-${name}`);
  const script = (name: string) => { const path = join(root, `${name}.sh`); writeFileSync(path, `#!/bin/sh\ntouch ${marker(name)}\n`); chmodSync(path, 0o755); return path; };
  return { root, work, marker, script };
}

describe('the console\'s git in a Worktree a command wrote to', () => {
  it('does not take the Worktree root for a bare repository once its .git is broken', async () => {
    const { root, work, marker, script } = scratch();
    // the command breaks .git and makes the Worktree root look like a repository of its own,
    // whose config runs a program for a signed commit
    renameSync(join(work, '.git/HEAD'), join(work, '.git/HEAD.bak'));
    git(root, 'init', '-q', '--bare', 'fake');
    for (const entry of ['HEAD', 'objects', 'refs']) cpSync(join(root, 'fake', entry), join(work, entry), { recursive: true });
    const tree = git(work, '--git-dir=.', 'mktree').trim();
    const commit = execFileSync('git', ['--git-dir=.', 'hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: work, encoding: 'utf8', input: `tree ${tree}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\nsigned\n` }).trim();
    git(work, '--git-dir=.', 'update-ref', 'HEAD', commit);
    writeFileSync(join(work, 'config'), `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${script('gpg')}\n`);

    const log = await run('/usr/bin/git', ['--no-optional-locks', '-C', work, 'log', '-z', '--max-count=2', 'HEAD', '--']);
    expect(log.code).not.toBe(0);
    expect(existsSync(marker('gpg'))).toBe(false);
  });

  it('does not run a nested repository\'s fsmonitor that a command added as a submodule', async () => {
    const { work, marker, script } = scratch();
    mkdirSync(join(work, 'sub'));
    git(join(work, 'sub'), 'init', '-q');
    git(join(work, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'sub');
    git(work, 'add', 'sub');
    git(work, 'commit', '-q', '-m', 'gitlink');
    writeFileSync(join(work, 'sub/.git/config'), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "${script('fsmonitor')}"\n`);

    // the dashboard's status check, and a status as the PR switch runs it
    await cleanWorkingTree(work);
    await run('/usr/bin/git', ['-C', work, 'status', '--porcelain=v1', '--untracked-files=all']);
    expect(existsSync(marker('fsmonitor'))).toBe(false);
  });

  it('runs none of a repository\'s own hooks or fsmonitor', async () => {
    const { work, marker, script } = scratch();
    git(work, 'config', 'core.fsmonitor', script('own-fsmonitor'));
    writeFileSync(join(work, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker('hook')}\n`);
    chmodSync(join(work, '.git/hooks/post-checkout'), 0o755);

    expect((await run('/usr/bin/git', ['-C', work, 'status', '--porcelain=v1'])).code).toBe(0);
    expect((await run('/usr/bin/git', ['-C', work, 'switch', '-q', '-c', 'other'])).code).toBe(0);
    expect(existsSync(marker('own-fsmonitor'))).toBe(false);
    expect(existsSync(marker('hook'))).toBe(false);
  });

  it('takes a folder for a bare repository only when its configured path names one, never for what is in it', async () => {
    const { root } = scratch();
    // a folder a command filled with what makes git take it for a bare repository
    const planted = join(root, 'folder');
    mkdirSync(planted);
    git(root, 'init', '-q', '--bare', 'fake');
    for (const entry of ['HEAD', 'objects', 'refs']) cpSync(join(root, 'fake', entry), join(planted, entry), { recursive: true });
    expect(await gitCommonDir(planted)).toBeUndefined();
    expect(await listWorktrees(planted)).toBeUndefined();
    // the operator's bare repository, named as one
    git(root, 'init', '-q', '--bare', 'store.git');
    expect(await gitCommonDir(join(root, 'store.git'))).toBe(join(root, 'store.git'));
  });

  it('refuses a writing git command in a checkout whose .git is broken, leaving the repository around it alone', async () => {
    const { work: parent } = scratch();
    // the operator's repository has work in progress; a checkout inside it is another repository
    writeFileSync(join(parent, 'tracked.txt'), 'committed\n');
    git(parent, 'add', 'tracked.txt');
    git(parent, 'commit', '-q', '-m', 'tracked');
    writeFileSync(join(parent, 'tracked.txt'), 'work in progress\n');
    const nested = join(parent, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    git(nested, 'commit', '-q', '--allow-empty', '-m', 'nested');
    // a command breaks the nested checkout's .git, so git would find the repository around it
    renameSync(join(nested, '.git/HEAD'), join(nested, '.git/HEAD.bak'));

    const reset = await run('/usr/bin/git', ['-C', nested, 'reset', '--hard', 'HEAD']);
    expect(reset.code).not.toBe(0);
    expect(reset.stderr).toContain(`refusing to run git reset in ${nested}`);
    expect(readFileSync(join(parent, 'tracked.txt'), 'utf8')).toBe('work in progress\n');
    // reading still works, and a healthy checkout still takes writes
    expect((await run('/usr/bin/git', ['-C', parent, 'status', '--porcelain=v1'])).code).toBe(0);
    expect((await run('/usr/bin/git', ['-C', parent, 'checkout', '--', 'tracked.txt'])).code).toBe(0);
    expect(readFileSync(join(parent, 'tracked.txt'), 'utf8')).toBe('committed\n');
  });
});
