import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService, worktreeManagementAvailability, type AddResult, type GitExec } from '../src/worktrees/management.js';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { GitCommand } from '../src/git/worktree-state.js';
import { testProject, testWorktree } from './helpers/config.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type GitResult = { code: number; stdout: string; stderr: string; stdoutTruncated?: true };
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
    // the omitted base resolves to origin's default, fetched first, and reaches worktree add as the base
    expect(calls.some(args => has(args, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'))).toBe(true);
    expect(calls.some(args => has(args, 'worktree', 'add', '--no-track', '-b', 'feat', join(project.worktreesDirectory, 'feat'), 'origin/main'))).toBe(true);
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
    expect(result).toEqual({ ok: true, base: 'origin/main', branches: [
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
    expect(await new WorktreeManagementService(() => [project], git).branches('proj')).toEqual({ ok: true, base: 'trunk', branches: [{ name: 'trunk', ref: 'trunk', remote: false, checkedOut: false }] });
    expect(await new WorktreeManagementService(() => [], git).branches('nope')).toMatchObject({ ok: false, status: 404 });
  });
});

// every new branch starts from a freshly fetched origin default, against real repositories
describe('WorktreeManagementService — the fresh base of a new branch', () => {
  const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  async function commit(cwd: string, message: string) {
    await git(cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', message);
    return await git(cwd, 'rev-parse', 'HEAD');
  }
  // an origin and the Project's checkout cloned from it, so origin/HEAD names main
  async function cloned() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-base-')));
    dirs.push(root);
    const [origin, checkout] = [join(root, 'origin'), join(root, 'checkout')];
    await mkdir(origin);
    await git(origin, 'init', '-q', '-b', 'main');
    await commit(origin, 'initial');
    await git(root, 'clone', '-q', origin, checkout);
    const project = testProject({ id: 'proj', path: checkout, identity: join(checkout, '.git'), worktreesDirectory: join(root, 'wts'), available: true });
    return { origin, checkout, project, service: new WorktreeManagementService(() => [project]) };
  }

  it('offers origin/<default> as the base and fetches it when the branch is created, past what the checkout last fetched', async () => {
    const { origin, project, service } = await cloned();
    const newest = await commit(origin, 'landed after the clone');
    // listing branches reads only what is here
    expect(await service.branches('proj')).toMatchObject({ ok: true, base: 'origin/main' });
    // offered base or none, the new branch starts from origin's newest default
    for (const [branch, base] of [['offered', 'origin/main'], ['unnamed', undefined]] as const) {
      const created = await service.add('proj', { mode: 'new', branch, ...(base === undefined ? {} : { base }) });
      expect(created).toEqual({ ok: true, path: join(project.worktreesDirectory, branch) });
      expect(await git(join(project.worktreesDirectory, branch), 'rev-parse', 'HEAD')).toBe(newest);
    }
  });

  it('creates from origin/<default> as last fetched and says why when the fetch fails', async () => {
    const { checkout, project, service } = await cloned();
    const fetched = await git(checkout, 'rev-parse', 'origin/main');
    await git(checkout, 'remote', 'set-url', 'origin', join(checkout, 'no-such-origin'));
    expect(await service.add('proj', { mode: 'new', branch: 'offline', base: 'origin/main' })).toEqual({ ok: true, path: join(project.worktreesDirectory, 'offline'), fetchError: expect.stringContaining('no-such-origin') });
    expect(await git(join(project.worktreesDirectory, 'offline'), 'rev-parse', 'HEAD')).toBe(fetched);
  });

  it('falls back to the local default when origin publishes no HEAD, without fetching', async () => {
    const { checkout, project, service } = await cloned();
    await git(checkout, 'remote', 'set-head', 'origin', '--delete');
    await git(checkout, 'remote', 'set-url', 'origin', join(checkout, 'no-such-origin'));
    expect(await service.branches('proj')).toEqual(expect.objectContaining({ ok: true, base: 'main' }));
    expect(await service.add('proj', { mode: 'new', branch: 'local', base: 'main' })).toEqual({ ok: true, path: join(project.worktreesDirectory, 'local') });
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
    const pulls = { repositoryAt: async () => ({ owner: 'octo', name: 'repo' }), repository: async () => ({ own: listed.map(pullRequest => ({ ...pullRequest, title: 'Work', draft: false, url: `https://github.com/octo/repo/pull/${pullRequest.number}` })), others: [] }) };
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

  it('keeps the shared mutation lock through the contextual ordinary-create callback', async () => {
    const project = await fakeProject();
    const headSha = '1234567890abcdef1234567890abcdef12345678';
    const main = testWorktree({ id: `proj:${project.path}`, projectId: 'proj', path: project.path, identity: project.path, main: true, branch: 'main' });
    const commandCalls: string[][] = [];
    const command: GitCommand = async (_binary, args) => {
      commandCalls.push(args);
      if (has(args, 'remote', 'get-url', 'origin')) return ok('git@github.com:acme/repo.git\n');
      if (has(args, 'worktree', 'list', '--porcelain', '-z')) return ok(`worktree ${project.path}\0HEAD ${headSha}\0branch refs/heads/main\0\0`);
      if (has(args, 'check-ref-format', '--branch')) return ok('feature/draft\n');
      if (has(args, 'rev-parse', '--verify', '--quiet')) return ok(`${headSha}\n`);
      if (has(args, 'show-ref', '--verify', '--quiet')) return no();
      return ok();
    };
    const discovery = { projectsNow: () => [project], worktreesNow: () => [main] };
    const github = {
      repositoryAt: async () => ({ owner: 'acme', name: 'repo' }),
      pullRequestDetail: async () => ({ pullRequest: { number: 7, title: 'Work', branch: 'feature/draft', headSha, headOnOrigin: true, draft: false, url: 'https://github.com/acme/repo/pull/7', state: 'open', checks: 'passed' } })
    };
    const switching = new PullRequestSwitchService({} as ValidatedConfig, discovery as never, github as never, command);
    let enterAdd!: () => void;
    let releaseAdd!: () => void;
    const addEntered = new Promise<void>(resolve => { enterAdd = resolve; });
    const addReleased = new Promise<void>(resolve => { releaseAdd = resolve; });
    const structuralCalls: string[][] = [];
    const structuralGit: GitExec = async args => {
      structuralCalls.push(args);
      // pause the first structural write under both locks
      if (has(args, 'worktree', 'add')) { enterAdd(); await addReleased; }
      return ok();
    };
    const management = new WorktreeManagementService(() => [project], structuralGit, undefined, switching, () => [main]);
    const context = { identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 }, targetProjectId: 'proj', expectedHolderWorktreeIds: [] };
    const adding = management.add('proj', { mode: 'pull-request', number: 7, context });
    await addEntered;
    const callsAtBarrier = commandCalls.length;
    await expect(switching.fetchForWorktree('proj', 7)).resolves.toEqual({ error: 'Another branch checkout or move is already running. Try again when it finishes.' });
    expect(commandCalls).toHaveLength(callsAtBarrier);
    releaseAdd();
    await expect(adding).resolves.toEqual({ ok: true, path: join(project.worktreesDirectory, 'pr-7') });
    expect(structuralCalls.some(args => has(args, 'worktree', 'add', '--no-track', '-b', 'feature/draft'))).toBe(true);
  });

  it('keeps same-number origin and parent pull request worktree paths independent', async () => {
    const project = await fakeProject();
    const originKey = 'anstosa/audiobookshelf';
    const parentKey = 'advplyr/audiobookshelf';
    const pullRequestHeads = {
      createUnheldWorktree: async (context: { identity: { repositoryKey: string } }, _refuseFork: boolean, create: (head: object) => Promise<AddResult>) => ({ ok: true as const, value: await create({
        branch: context.identity.repositoryKey === originKey ? 'origin-pr' : 'parent-pr', sha: 'a'.repeat(40), existing: false, fork: true,
        repositoryScope: { baseRepositoryKey: context.identity.repositoryKey, originRepositoryKey: originKey }
      }) })
    };
    const structuralGit: GitExec = async args => {
      if (has(args, 'worktree', 'add')) await mkdir(args.at(-2)!, { recursive: true });
      return ok();
    };
    const management = new WorktreeManagementService(() => [project], structuralGit, undefined, pullRequestHeads as never);
    const context = (repositoryKey: string) => ({ identity: { repositoryKey, kind: 'pull' as const, number: 7 }, targetProjectId: 'proj', expectedHolderWorktreeIds: [] });

    const origin = await management.add('proj', { mode: 'pull-request', number: 7, context: context(originKey) });
    const parent = await management.add('proj', { mode: 'pull-request', number: 7, context: context(parentKey) });
    expect(origin).toEqual({ ok: true, path: join(project.worktreesDirectory, 'pr-7'), fork: true });
    expect(parent).toMatchObject({ ok: true, path: expect.stringMatching(new RegExp(`${project.worktreesDirectory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/pr-7-[a-f0-9]{16}$`, 'u')), fork: true });
    expect(parent).not.toEqual(origin);
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

describe('WorktreeManagementService.moveHeldPullRequest', () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const git = async (cwd: string, ...args: string[]) => { const result = await run('/usr/bin/git', ['-C', cwd, ...args]); if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };

  // create one disposable linked-worktree holder fixture
  async function heldRepository(
    withGitlink = false,
    afterCandidateDiscovery?: (sourcePath: string) => Promise<void>,
    commandFactory?: (sourcePath: string) => GitCommand,
    refreshAgents?: (call: number, sourcePath: string, candidatePath: string) => object[]
  ) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-github-split-')));
    dirs.push(root);
    const mainPath = join(root, 'main');
    const sourcePath = join(root, 'source');
    const worktreesDirectory = join(root, 'wts');
    await mkdir(mainPath);
    await git(mainPath, 'init', '-q', '-b', 'main');
    await git(mainPath, 'config', 'user.email', 'test@example.com');
    await git(mainPath, 'config', 'user.name', 'Test');
    await git(mainPath, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
    await writeFile(join(mainPath, 'tracked.txt'), 'original\n');
    await git(mainPath, 'add', 'tracked.txt');
    await git(mainPath, 'commit', '-q', '-m', 'base');
    // add a metadata-only gitlink without reading nested configuration
    if (withGitlink) {
      const commit = await git(mainPath, 'rev-parse', 'HEAD');
      await git(mainPath, 'update-index', '--add', '--cacheinfo', `160000,${commit},module`);
      await git(mainPath, 'commit', '-q', '-m', 'gitlink');
    }
    await git(mainPath, 'branch', 'feature/draft');
    await git(mainPath, 'worktree', 'add', '-q', sourcePath, 'feature/draft');
    const headSha = await git(sourcePath, 'rev-parse', 'HEAD');
    const project = testProject({ id: 'proj', path: mainPath, identity: join(mainPath, '.git'), worktreesDirectory });
    const main = testWorktree({ id: `proj:${mainPath}`, projectId: 'proj', path: mainPath, identity: mainPath, branch: 'main' });
    const source = testWorktree({ id: `proj:${sourcePath}`, projectId: 'proj', path: sourcePath, identity: sourcePath, main: false, branch: 'feature/draft' });
    const candidatePath = join(worktreesDirectory, `pr-7-move-${operationId}`);
    const target = testWorktree({ id: `proj:${candidatePath}`, projectId: 'proj', path: candidatePath, identity: candidatePath, main: false, detached: true, branch: undefined });
    let candidateDiscovered = false;
    let refreshCount = 0;
    const discovery = {
      projectsNow: () => [project],
      worktreesNow: () => [main, source, ...(candidateDiscovered ? [target] : [])],
      refresh: async () => refreshAgents?.(++refreshCount, sourcePath, candidatePath) ?? [],
      invalidateWorktrees: () => {},
      worktrees: async () => { candidateDiscovered = true; return [main, source, target]; }
    };
    const github = {
      repositoryAt: async () => ({ owner: 'acme', name: 'repo' }),
      pullRequestDetail: async () => ({ pullRequest: { number: 7, title: 'Work', branch: 'feature/draft', headSha, headOnOrigin: true, draft: false, url: 'https://github.com/acme/repo/pull/7', state: 'open', checks: 'passed' } })
    };
    const switching = new PullRequestSwitchService({} as ValidatedConfig, discovery as never, github as never, commandFactory?.(sourcePath) ?? run);
    const management = new WorktreeManagementService(() => [project], undefined, undefined, switching, () => discovery.worktreesNow());
    let discoveryHookRan = false;
    discovery.worktrees = async () => {
      candidateDiscovered = true;
      // inject one exact post-create race once
      if (!discoveryHookRan && afterCandidateDiscovery !== undefined) { discoveryHookRan = true; await afterCandidateDiscovery(sourcePath); }
      return [main, source, target];
    };
    // construct a state-free recovery reader over explicit current discovery
    const freshManagement = (visible: ReturnType<typeof testWorktree>[] = discovery.worktreesNow()) => new WorktreeManagementService(() => [project], undefined, undefined, undefined, () => visible);
    return { mainPath, sourcePath, worktreesDirectory, candidatePath, headSha, project, main, source, target, management, freshManagement, refreshCount: () => refreshCount };
  }

  it('moves the exact held branch and staged, unstaged and untracked changes into the UUID target', async () => {
    const { sourcePath, candidatePath, source, management } = await heldRepository();
    await writeFile(join(sourcePath, 'tracked.txt'), 'staged\n');
    await git(sourcePath, 'add', 'tracked.txt');
    await writeFile(join(sourcePath, 'tracked.txt'), 'staged\nunstaged\n');
    await writeFile(join(sourcePath, 'notes.txt'), 'untracked\n');
    const context = {
      identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 },
      targetProjectId: 'proj',
      expectedHolderWorktreeIds: [source.id],
      expectedSourceWorktreeId: source.id
    };

    await expect(management.moveHeldPullRequest('proj', { number: 7, sourceWorktreeId: source.id, context, operationId, openAgent: false })).resolves.toEqual({ ok: true, path: candidatePath, fork: false });
    expect(await git(candidatePath, 'branch', '--show-current')).toBe('feature/draft');
    expect(await readFile(join(candidatePath, 'tracked.txt'), 'utf8')).toBe('staged\nunstaged\n');
    expect(await readFile(join(candidatePath, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(await git(sourcePath, 'branch', '--show-current')).toBe('');
    const inspected = await management.inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(inspected).toMatchObject({ ok: true, recovery: { candidateWorktreeId: `proj:${candidatePath}`, currentHolderWorktreeId: `proj:${candidatePath}`, inferredPhase: 'moved' } });
  });

  it('reconstructs C1-C6 facts from git with fresh service instances and preserves the exact bytes and index', async () => {
    const { mainPath, sourcePath, candidatePath, source, main, target, freshManagement } = await heldRepository();
    await mkdir(join(candidatePath, '..'), { recursive: true });
    await git(mainPath, 'worktree', 'add', '-q', '--detach', candidatePath, 'HEAD');
    const c1Worktrees = await git(mainPath, 'worktree', 'list', '--porcelain');
    const c1Stashes = await git(mainPath, 'stash', 'list');
    const c1 = await freshManagement([main, source]).inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(c1).toMatchObject({ ok: true, recovery: { candidate: { pathExists: true, registered: true, discovered: false, status: 'clean' }, source: { branch: 'feature/draft', status: 'clean' }, inferredPhase: 'target-detached' } });
    expect(await git(mainPath, 'worktree', 'list', '--porcelain')).toBe(c1Worktrees);
    expect(await git(mainPath, 'stash', 'list')).toBe(c1Stashes);

    await writeFile(join(sourcePath, 'tracked.txt'), 'staged\n');
    await git(sourcePath, 'add', 'tracked.txt');
    await writeFile(join(sourcePath, 'tracked.txt'), 'staged\nunstaged\n');
    await writeFile(join(sourcePath, 'notes.txt'), 'untracked\n');
    const tag = `rac move-to-new ${operationId} feature/draft`;
    await git(sourcePath, 'stash', 'push', '--include-untracked', '--message', tag);
    const stashOid = await git(mainPath, 'rev-parse', 'refs/stash');
    const c2 = await freshManagement([main, source]).inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(c2).toMatchObject({ ok: true, recovery: { taggedStash: { oid: stashOid, subject: expect.stringContaining(tag) }, inferredPhase: 'stashed-source' } });

    await git(sourcePath, 'switch', '--detach');
    const c3 = await freshManagement([main, source]).inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(c3).toMatchObject({ ok: true, recovery: { inferredPhase: 'source-detached' } });
    if (c3.ok) expect('branch' in c3.recovery.source).toBe(false);
    await git(candidatePath, 'switch', 'feature/draft');
    const attachedTarget = { ...target, detached: false, branch: 'feature/draft' };
    const c4 = await freshManagement([main, source, attachedTarget]).inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(c4).toMatchObject({ ok: true, recovery: { currentHolderWorktreeId: `proj:${candidatePath}`, taggedStash: { oid: stashOid }, inferredPhase: 'target-holds-with-stash' } });

    await git(candidatePath, 'stash', 'apply', '--index', stashOid);
    expect(await readFile(join(candidatePath, 'tracked.txt'), 'utf8')).toBe('staged\nunstaged\n');
    expect(await readFile(join(candidatePath, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(await git(candidatePath, 'diff', '--cached', '--name-only')).toBe('tracked.txt');
    expect(await git(candidatePath, 'diff', '--name-only')).toBe('tracked.txt');
    expect(await git(candidatePath, 'ls-files', '--others', '--exclude-standard')).toBe('notes.txt');
    await git(mainPath, 'stash', 'drop', 'stash@{0}');
    const c6 = await freshManagement([main, source, attachedTarget]).inspectHeldPullRequest('proj', 7, source.id, operationId);
    expect(c6).toMatchObject({ ok: true, recovery: { currentHolderWorktreeId: `proj:${candidatePath}`, candidate: { status: 'dirty' }, inferredPhase: 'moved' } });
    expect(c6).not.toMatchObject({ recovery: { taggedStash: expect.anything() } });
    expect(await git(mainPath, 'stash', 'list')).toBe('');
    expect(await git(mainPath, 'worktree', 'list', '--porcelain')).toContain(`worktree ${sourcePath}`);
    expect(await git(mainPath, 'worktree', 'list', '--porcelain')).toContain(`worktree ${candidatePath}`);
  });

  it('returns recovery when source HEAD changes after candidate creation without stashing or detaching source', async () => {
    const fixture = await heldRepository(false, async sourcePath => {
      await writeFile(join(sourcePath, 'tracked.txt'), 'advanced source\n');
      await git(sourcePath, 'add', 'tracked.txt');
      await git(sourcePath, 'commit', '-q', '-m', 'advance during move');
    });
    const { sourcePath, candidatePath, headSha, source, management } = fixture;
    const context = {
      identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 },
      targetProjectId: 'proj',
      expectedHolderWorktreeIds: [source.id],
      expectedSourceWorktreeId: source.id
    };

    await expect(management.moveHeldPullRequest('proj', { number: 7, sourceWorktreeId: source.id, context, operationId, openAgent: false })).resolves.toMatchObject({ ok: false, status: 409, operationId, candidateWorktreeId: `proj:${candidatePath}`, recoveryRequired: true, recovery: { inferredPhase: 'target-detached' } });
    expect(await git(sourcePath, 'branch', '--show-current')).toBe('feature/draft');
    expect(await git(sourcePath, 'rev-parse', 'HEAD')).not.toBe(headSha);
    expect(await git(candidatePath, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(await readFile(join(sourcePath, 'tracked.txt'), 'utf8')).toBe('advanced source\n');
    expect(await git(sourcePath, 'stash', 'list')).toBe('');
  });

  it('rechecks source HEAD at the final pre-stash seam and retains the candidate on a race', async () => {
    let sourceHeadReads = 0;
    const fixture = await heldRepository(false, undefined, sourcePath => async (binary, args) => {
      // move the source only at the last held-move head read
      if (args[args.indexOf('-C') + 1] === sourcePath && has(args, 'rev-parse', '--verify', 'HEAD^{commit}') && ++sourceHeadReads === 3) {
        await writeFile(join(sourcePath, 'tracked.txt'), 'last-seam advance\n');
        await git(sourcePath, 'add', 'tracked.txt');
        await git(sourcePath, 'commit', '-q', '-m', 'advance before stash');
      }
      return await run(binary, args);
    });
    const { sourcePath, candidatePath, headSha, source, management } = fixture;
    const context = {
      identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 },
      targetProjectId: 'proj',
      expectedHolderWorktreeIds: [source.id],
      expectedSourceWorktreeId: source.id
    };

    await expect(management.moveHeldPullRequest('proj', { number: 7, sourceWorktreeId: source.id, context, operationId, openAgent: false })).resolves.toMatchObject({ ok: false, status: 409, candidateWorktreeId: `proj:${candidatePath}`, recoveryRequired: true });
    expect(sourceHeadReads).toBe(3);
    expect(await git(sourcePath, 'branch', '--show-current')).toBe('feature/draft');
    expect(await git(sourcePath, 'rev-parse', 'HEAD')).not.toBe(headSha);
    expect(await git(candidatePath, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(await readFile(join(sourcePath, 'tracked.txt'), 'utf8')).toBe('last-seam advance\n');
    expect(await git(sourcePath, 'stash', 'list')).toBe('');
  });

  it('rechecks source busy state after final contextual proof and preserves the created candidate', async () => {
    let lateSourceStatusRead = false;
    const fixture = await heldRepository(false, undefined, sourcePath => async (binary, args) => {
      const result = await run(binary, args);
      // make the source busy only after the last read before mutation
      if (args[args.indexOf('-C') + 1] === sourcePath && has(args, 'status', '--porcelain=v1') && !args.includes('-z')) lateSourceStatusRead = true;
      return result;
    }, (_call, sourcePath) => lateSourceStatusRead ? [{ home: sourcePath, attention: 'working' }] : []);
    const { sourcePath, candidatePath, source, management, refreshCount } = fixture;
    const context = {
      identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 },
      targetProjectId: 'proj',
      expectedHolderWorktreeIds: [source.id],
      expectedSourceWorktreeId: source.id
    };

    await expect(management.moveHeldPullRequest('proj', { number: 7, sourceWorktreeId: source.id, context, operationId, openAgent: false })).resolves.toMatchObject({ ok: false, status: 409, candidateWorktreeId: `proj:${candidatePath}`, recoveryRequired: true, recovery: { inferredPhase: 'target-detached' } });
    expect(lateSourceStatusRead).toBe(true);
    expect(refreshCount()).toBe(2);
    expect(await git(sourcePath, 'branch', '--show-current')).toBe('feature/draft');
    expect(await git(candidatePath, 'branch', '--show-current')).toBe('');
    expect(await git(sourcePath, 'stash', 'list')).toBe('');
  });

  it('refuses a current gitlink before candidate creation while ordinary move behavior stays separate', async () => {
    const { candidatePath, source, management } = await heldRepository(true);
    const context = {
      identity: { repositoryKey: 'acme/repo', kind: 'pull' as const, number: 7 },
      targetProjectId: 'proj',
      expectedHolderWorktreeIds: [source.id],
      expectedSourceWorktreeId: source.id
    };

    await expect(management.moveHeldPullRequest('proj', { number: 7, sourceWorktreeId: source.id, context, operationId, openAgent: false })).resolves.toEqual({ ok: false, status: 409, error: 'Pull requests in repositories with submodules cannot be moved to a new worktree.', operationId });
    expect(await management.inspectHeldPullRequest('proj', 7, source.id, operationId)).toMatchObject({ ok: true, recovery: { candidate: { pathExists: false, registered: false }, inferredPhase: 'none' } });
    expect((await run('/usr/bin/git', ['-C', candidatePath, 'rev-parse', 'HEAD'])).code).not.toBe(0);
  });

  it('refuses a truncated recovery metadata projection', async () => {
    const project = await fakeProject();
    const source = testWorktree({ id: `proj:${project.path}`, projectId: 'proj', path: project.path, identity: project.path, branch: 'feature/draft' });
    const recoveryGit: GitExec = async args => {
      if (has(args, 'worktree', 'list')) return { ...ok(`worktree ${project.path}\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/feature/draft\0\0`), stdoutTruncated: true };
      return ok();
    };
    const management = new WorktreeManagementService(() => [project], recoveryGit, undefined, undefined, () => [source]);
    await expect(management.inspectHeldPullRequest('proj', 7, source.id, operationId)).resolves.toEqual({ ok: false, status: 409, error: 'recovery metadata could not be read' });
  });
});
