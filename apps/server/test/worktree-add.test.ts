import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService, worktreeManagementAvailability, type GitExec } from '../src/worktrees/management.js';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { GitCommand } from '../src/git/worktree-state.js';
import { testProject, testWorktree } from './helpers/config.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type GitResult = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const no = (stderr = '', code = 1): GitResult => ({ code, stdout: '', stderr });

// a recording git fake: `handler` answers specific argv shapes; anything else succeeds
function fakeGit(handler: (args: string[]) => GitResult | undefined = () => undefined): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async args => { calls.push(args); return handler(args) ?? ok(); };
  return { git, calls };
}
const has = (args: string[], ...needles: string[]) => needles.every(needle => args.includes(needle));

// a Project whose worktreesDirectory is a real temp path, so the service's mkdir/access
// touch only scratch space while the git calls stay faked
async function fakeProject(over: Parameters<typeof testProject>[0] = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rac-add-')));
  dirs.push(base);
  const path = join(base, 'repo');
  await mkdir(path, { recursive: true });
  return testProject({ id: 'proj', path, worktreesDirectory: join(base, 'wts'), available: true, ...over });
}

describe('WorktreeManagementService.add — flag composition', () => {
  it('creates a new branch worktree with --no-track from the given base', async () => {
    const project = await fakeProject();
    // show-ref (branch exists) fails ⇒ the branch is free; everything else succeeds
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat/login', base: 'main' });
    expect(result).toEqual({ ok: true, path: join(project.worktreesDirectory, 'feat-login') });
    // the leaf flattens `/` to `-`; the invocation is add --no-track -b <name> <path> <base>
    expect(calls.some(args => has(args, '-C', project.path, 'worktree', 'add', '--no-track', '-b', 'feat/login', join(project.worktreesDirectory, 'feat-login'), 'main'))).toBe(true);
  });

  it('falls back to the resolved default branch when no base is given', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit(args => {
      if (has(args, 'show-ref')) return no();                                            // branch is free
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n'); // default resolves
      return undefined;
    });
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat' });
    expect(result.ok).toBe(true);
    // the omitted base resolves to the default branch and reaches worktree add as the base
    expect(calls.some(args => has(args, 'worktree', 'add', '--no-track', '-b', 'feat', join(project.worktreesDirectory, 'feat'), 'main'))).toBe(true);
  });

  it('creates an existing-branch worktree without -b', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit();
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'existing', branch: 'release' });
    expect(result.ok).toBe(true);
    expect(calls.some(args => has(args, 'worktree', 'add', join(project.worktreesDirectory, 'release'), 'release') && !args.includes('-b'))).toBe(true);
  });
});

describe('WorktreeManagementService.add — refusals before git runs', () => {
  it('404s an unknown Project and 409s a bridge-unmounted one', async () => {
    const service = new WorktreeManagementService(() => [], fakeGit().git);
    expect(await service.add('missing', { mode: 'new', branch: 'x', base: 'main' })).toMatchObject({ ok: false, status: 404 });
    const bridged = await fakeProject({ hostPath: '/host/elsewhere' });
    const onBridge = new WorktreeManagementService(() => [bridged], fakeGit().git);
    expect(await onBridge.add('proj', { mode: 'new', branch: 'x', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('host path') });
  });

  it('rejects an invalid branch name, a traversal name, and a taken branch', async () => {
    const project = await fakeProject();
    const taken = fakeGit(args => (has(args, 'show-ref') ? ok() : undefined));
    const service = new WorktreeManagementService(() => [project], taken.git);
    expect(await service.add('proj', { mode: 'new', branch: 'bad name', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('valid branch') });
    expect(await service.add('proj', { mode: 'new', branch: '..', base: 'main' })).toMatchObject({ ok: false, status: 409 });
    expect(await service.add('proj', { mode: 'new', branch: 'exists', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already exists') });
  });

  it('rejects a base that does not resolve and a branch checked out elsewhere', async () => {
    const project = await fakeProject();
    const badBase = fakeGit(args => (has(args, 'show-ref') ? no() : has(args, 'rev-parse') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], badBase.git).add('proj', { mode: 'new', branch: 'feat', base: 'nope' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('does not resolve') });
    const elsewhere = fakeGit(args => (args.includes('for-each-ref') && args.includes('refs/heads/feat') ? ok('/somewhere/feat') : undefined));
    expect(await new WorktreeManagementService(() => [project], elsewhere.git).add('proj', { mode: 'existing', branch: 'feat' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already checked out') });
  });

  it('rejects a base that begins with `-` before it can be read as a git flag', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: '--force' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('not valid') });
    // the guard fires before rev-parse or worktree add ever runs
    expect(calls.some(args => has(args, 'rev-parse') || has(args, 'worktree', 'add'))).toBe(false);
  });

  it('rejects a target path that already exists and never runs git worktree add', async () => {
    const project = await fakeProject();
    await mkdir(join(project.worktreesDirectory, 'feat'), { recursive: true });
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: 'main' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already exists') });
    expect(calls.some(args => has(args, 'worktree', 'add'))).toBe(false);
  });

  it('surfaces git\'s trimmed stderr when worktree add fails', async () => {
    const project = await fakeProject();
    const { git } = fakeGit(args => (has(args, 'show-ref') ? no() : has(args, 'worktree', 'add') ? no('fatal: something went wrong\n', 128) : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: 'main' }))
      .toEqual({ ok: false, status: 409, error: 'fatal: something went wrong' });
  });
});

describe('WorktreeManagementService.branches', () => {
  it('offers every local branch, marking the checked-out ones, plus remote-only branches and the default', async () => {
    const project = await fakeProject();
    const forEach = [
      'refs/heads/main\t/repo',            // checked out here — offered, marked
      'refs/heads/feature\t',              // free local — offered
      'refs/remotes/origin/HEAD\t',        // symbolic — skipped
      'refs/remotes/origin/feature\t',     // has a local — not remote-only
      'refs/remotes/origin/hotfix\t'       // remote-only — offered by its remote ref
    ].join('\n');
    const git = fakeGit(args => {
      if (has(args, 'for-each-ref') && args.includes('refs/heads')) return ok(forEach);
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n');
      return undefined;
    }).git;
    const result = await new WorktreeManagementService(() => [project], git).branches('proj');
    expect(result).toEqual({ ok: true, defaultBranch: 'main', branches: [
      { name: 'main', ref: 'main', remote: false, checkedOut: true },
      { name: 'feature', ref: 'feature', remote: false, checkedOut: false },
      { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }
    ] });
  });

  it('falls back to HEAD when origin publishes no default, and 404s an unknown Project', async () => {
    const project = await fakeProject();
    const git = fakeGit(args => {
      if (has(args, 'for-each-ref') && args.includes('refs/heads')) return ok('refs/heads/trunk\t\n');
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return no();
      if (has(args, 'symbolic-ref', 'HEAD')) return ok('trunk\n');
      return undefined;
    }).git;
    expect(await new WorktreeManagementService(() => [project], git).branches('proj')).toEqual({ ok: true, defaultBranch: 'trunk', branches: [{ name: 'trunk', ref: 'trunk', remote: false, checkedOut: false }] });
    expect(await new WorktreeManagementService(() => [], git).branches('nope')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('worktreeManagementAvailability', () => {
  it('blocks a missing checkout and a bridge host-path mismatch, allows an identity mount', async () => {
    expect(worktreeManagementAvailability(testProject({ available: false, unavailableReason: 'path /x was not found' }))).toEqual({ available: false, reason: 'path /x was not found' });
    expect(worktreeManagementAvailability(testProject({ available: true, path: '/c/repo', hostPath: '/host/repo' })).available).toBe(false);
    expect(worktreeManagementAvailability(testProject({ available: true, path: '/repo', hostPath: '/repo' }))).toEqual({ available: true });
    expect(worktreeManagementAvailability(testProject({ available: true }))).toEqual({ available: true });
  });

  it('blocks an available non-git directory Project: it has no worktrees to manage', async () => {
    const result = worktreeManagementAvailability(testProject({ available: true, mode: 'directory' }));
    expect(result.available).toBe(false);
    expect(result.reason).toContain('not a git repository');
  });
});

// exercised against a real repository so the actual git invocation is proven end to end
describe('WorktreeManagementService.add — against a real repository', () => {
  const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  async function repo() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-add-real-')));
    dirs.push(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'readme.md'), 'hi\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'initial');
    return root;
  }

  it('creates a worktree for a new branch and for an existing branch', async () => {
    const root = await repo();
    const worktreesDirectory = `${root}-wts`;
    dirs.push(worktreesDirectory);
    const project = testProject({ id: 'proj', path: root, identity: join(root, '.git'), worktreesDirectory, available: true });
    const service = new WorktreeManagementService(() => [project]);

    const created = await service.add('proj', { mode: 'new', branch: 'feature/one', base: 'main' });
    expect(created).toEqual({ ok: true, path: await realpath(join(worktreesDirectory, 'feature-one')) });
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/feature/one');

    await git(root, 'branch', 'existing', 'main');
    const adopted = await service.add('proj', { mode: 'existing', branch: 'existing' });
    expect(adopted).toEqual({ ok: true, path: await realpath(join(worktreesDirectory, 'existing')) });

    // a base that does not resolve is refused with git untouched
    expect(await service.add('proj', { mode: 'new', branch: 'feature/two', base: 'no-such-ref' })).toMatchObject({ ok: false, status: 409 });
  });
});

// the pull-request source is the real switch service, so the pinned fetch and SHA check run for real
describe('WorktreeManagementService.add — from a pull request', () => {
  const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  type Listed = { number: number; branch: string; headSha: string; headOnOrigin: boolean };

  // an origin holding a head-on-origin branch and a fork PR head reachable only as refs/pull/8/head,
  // cloned as the Project's main checkout
  async function pullRequestRepository() {
    // exercise names that resemble a requested worktree in the parent path
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-add-pr-8-pr-9-')));
    dirs.push(root);
    const origin = join(root, 'origin');
    const checkout = join(root, 'repo');
    await mkdir(origin);
    await git(origin, 'init', '-q', '-b', 'main');
    await git(origin, 'config', 'user.email', 'test@example.com');
    await git(origin, 'config', 'user.name', 'Test');
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
    await git(origin, 'switch', '-q', '-c', 'feature/draft');
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'draft');
    const draftSha = await git(origin, 'rev-parse', 'HEAD');
    await git(origin, 'switch', '-q', '-c', 'fork-source', 'main');
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'fork');
    const forkSha = await git(origin, 'rev-parse', 'HEAD');
    await git(origin, 'update-ref', 'refs/pull/8/head', forkSha);
    await git(origin, 'switch', '-q', 'main');
    await git(origin, 'branch', '-q', '-D', 'fork-source');
    await git(root, 'clone', '-q', origin, checkout);
    const project = testProject({ id: 'proj', label: 'Proj', path: checkout, identity: join(checkout, '.git'), worktreesDirectory: join(root, 'wts'), available: true });
    return { origin, checkout, project, draftSha, forkSha };
  }

  // the real switch service over one main worktree, listing the given open pull requests
  function service(project: ReturnType<typeof testProject>, listed: Listed[], dashboardWorktrees: object[] = [], command: GitCommand = run) {
    const main = testWorktree({ id: `proj:${project.path}`, projectId: 'proj', path: project.path, identity: project.path, main: true });
    const discovery = { worktreesNow: () => [main], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [{ worktrees: dashboardWorktrees }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: listed.map(pullRequest => ({ ...pullRequest, title: 'Work', draft: false, url: `https://github.com/octo/repo/pull/${pullRequest.number}` })), others: [] }) };
    const switching = new PullRequestSwitchService({} as ValidatedConfig, discovery as never, pulls as never, command);
    return new WorktreeManagementService(() => [project], undefined, undefined, switching);
  }

  it('checks out an origin pull request as pr-<number> on a tracking branch at the listed head', async () => {
    const { project, draftSha } = await pullRequestRepository();
    const result = await service(project, [{ number: 7, branch: 'feature/draft', headSha: draftSha, headOnOrigin: true }]).add('proj', { mode: 'pull-request', number: 7 });
    const path = join(project.worktreesDirectory, 'pr-7');
    expect(result).toEqual({ ok: true, path });
    expect(await git(path, 'branch', '--show-current')).toBe('feature/draft');
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(draftSha);
    expect(await git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/draft');
  });

  it('checks out the verified head even when the fetched ref moves right after the check', async () => {
    const { project, checkout, draftSha } = await pullRequestRepository();
    const base = await git(checkout, 'rev-parse', 'origin/main');
    // another fetch lands between the SHA check and the worktree add
    const command: GitCommand = async (binary, args) => {
      const result = await run(binary, args);
      if (args.includes('refs/remotes/origin/feature/draft^{commit}')) await git(checkout, 'update-ref', 'refs/remotes/origin/feature/draft', base);
      return result;
    };
    const result = await service(project, [{ number: 7, branch: 'feature/draft', headSha: draftSha, headOnOrigin: true }], [], command).add('proj', { mode: 'pull-request', number: 7 });
    expect(result).toMatchObject({ ok: true });
    expect(await git(join(project.worktreesDirectory, 'pr-7'), 'rev-parse', 'HEAD')).toBe(draftSha);
  });

  it('checks out a fork pull request from its pinned ref on an untracked rac/pr branch', async () => {
    const { project, forkSha } = await pullRequestRepository();
    const result = await service(project, [{ number: 8, branch: 'main', headSha: forkSha, headOnOrigin: false }]).add('proj', { mode: 'pull-request', number: 8 });
    const path = join(project.worktreesDirectory, 'pr-8');
    // a fork's code is marked so the caller runs no setup in it
    expect(result).toEqual({ ok: true, path, fork: true });
    expect(await git(path, 'branch', '--show-current')).toBe(`rac/pr/8/${forkSha.slice(0, 12)}`);
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(forkSha);
    expect((await run('/usr/bin/git', ['-C', path, 'rev-parse', '--abbrev-ref', '@{upstream}'])).code).not.toBe(0);
  });

  it('reuses an existing local branch at the pull request head and refuses one that differs', async () => {
    const { project, checkout, draftSha, forkSha } = await pullRequestRepository();
    await git(checkout, 'fetch', '-q', 'origin', `${forkSha}:refs/heads/rac/pr/8/${forkSha.slice(0, 12)}`);
    await git(checkout, 'branch', 'feature/draft', 'origin/main');
    const management = service(project, [{ number: 7, branch: 'feature/draft', headSha: draftSha, headOnOrigin: true }, { number: 8, branch: 'main', headSha: forkSha, headOnOrigin: false }]);

    expect(await management.add('proj', { mode: 'pull-request', number: 8 })).toMatchObject({ ok: true });
    expect(await git(join(project.worktreesDirectory, 'pr-8'), 'rev-parse', 'HEAD')).toBe(forkSha);

    expect(await management.add('proj', { mode: 'pull-request', number: 7 })).toEqual({ ok: false, status: 409, error: 'The local branch feature/draft differs from the pull request head. Update or delete it, then try again.' });
    expect(await git(checkout, 'rev-parse', 'feature/draft')).toBe(await git(checkout, 'rev-parse', 'origin/main'));
  });

  it('refuses a taken pr-<number> path, a pull request another worktree holds, and one that moved', async () => {
    const { project, checkout, origin, draftSha, forkSha } = await pullRequestRepository();
    const other = join(project.worktreesDirectory, 'review');
    await mkdir(project.worktreesDirectory);
    await git(checkout, 'worktree', 'add', '-q', other, 'feature/draft');
    const holder = { id: `proj:${other}`, label: 'Proj · review', path: other, branch: 'feature/draft' };
    const management = service(project, [{ number: 7, branch: 'feature/draft', headSha: draftSha, headOnOrigin: true }, { number: 8, branch: 'main', headSha: forkSha, headOnOrigin: false }, { number: 9, branch: 'main', headSha: forkSha, headOnOrigin: false }], [holder]);

    expect(await management.add('proj', { mode: 'pull-request', number: 7 })).toEqual({ ok: false, status: 409, error: 'feature/draft is already checked out in Proj · review.' });

    await mkdir(join(project.worktreesDirectory, 'pr-8'));
    expect(await management.add('proj', { mode: 'pull-request', number: 8 })).toEqual({ ok: false, status: 409, error: 'Pull request #8 already has a worktree at pr-8.' });

    // origin's PR ref moved past the listed head
    await git(origin, 'update-ref', 'refs/pull/9/head', draftSha);
    expect(await management.add('proj', { mode: 'pull-request', number: 9 })).toEqual({ ok: false, status: 409, error: 'Pull request #9 changed on GitHub after it was listed. Reopen the list and try again.' });
    expect(await management.add('proj', { mode: 'pull-request', number: 10 })).toEqual({ ok: false, status: 409, error: 'Pull request #10 is no longer open.' });
    // match the requested checkout rather than a random parent name
    expect((await git(checkout, 'worktree', 'list', '--porcelain')).split('\n')).not.toContain(`worktree ${join(project.worktreesDirectory, 'pr-9')}`);
  });

  it('refuses a fork pull request asked to open an agent, before fetching or adding anything', async () => {
    const { project, checkout, forkSha } = await pullRequestRepository();
    const result = await service(project, [{ number: 8, branch: 'main', headSha: forkSha, headOnOrigin: false }]).add('proj', { mode: 'pull-request', number: 8, openAgent: true });
    expect(result).toEqual({ ok: false, status: 409, error: 'Fork pull requests open without setup or an agent. Choose Terminal or Nothing.' });
    expect((await run('/usr/bin/git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', 'refs/rac/pull/8'])).code).not.toBe(0);
    // match the requested checkout rather than a random parent name
    expect((await git(checkout, 'worktree', 'list', '--porcelain')).split('\n')).not.toContain(`worktree ${join(project.worktreesDirectory, 'pr-8')}`);
  });

  it('refuses a pull request a worktree holds at an earlier fork head, read live from git rather than the dashboard', async () => {
    const { project, checkout, forkSha } = await pullRequestRepository();
    // a worktree outside pr-8 still holds #8 at the head the author has since replaced
    const base = await git(checkout, 'rev-parse', 'origin/main');
    const older = join(project.worktreesDirectory, 'older-review');
    await mkdir(project.worktreesDirectory);
    await git(checkout, 'worktree', 'add', '-q', '-b', `rac/pr/8/${base.slice(0, 12)}`, older, base);
    const result = await service(project, [{ number: 8, branch: 'main', headSha: forkSha, headOnOrigin: false }]).add('proj', { mode: 'pull-request', number: 8 });
    expect(result).toEqual({ ok: false, status: 409, error: `Pull request #8 is already checked out at ${older}.` });
    // match the requested checkout rather than a random parent name
    expect((await git(checkout, 'worktree', 'list', '--porcelain')).split('\n')).not.toContain(`worktree ${join(project.worktreesDirectory, 'pr-8')}`);
  });
});
