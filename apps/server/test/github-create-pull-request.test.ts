import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GithubService } from '../src/github/service.js';
import { run } from '../src/tmux/command.js';
import { testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub, graphqlSyntaxError, manualTimer, reply, settled, type GraphqlCall, type PullFixture } from './helpers/github-graphql.js';

const repo = { owner: 'octo', name: 'repo' };
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const isCreate = (call: GraphqlCall) => call.query.includes('createPullRequest(');
const input = { title: 'Retry with backoff', body: '', base: 'main', draft: false };
// the branches origin holds
const pushed = (bare: string) => execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim();

// octo/repo checked out with a linked Worktree on `42-retries` two commits past origin's `main`;
// origin's fetch URL names github.com while its pushes land in a local bare repository
async function checkouts() {
  const root = await mkdtemp(join(tmpdir(), 'rac-create-pr-'));
  const [bare, main, linked] = [join(root, 'origin.git'), join(root, 'repo'), join(root, 'repo-42-retries')];
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'Initial');
  git(main, 'remote', 'add', 'origin', 'git@github.com:octo/repo.git');
  git(main, 'config', 'remote.origin.pushurl', bare);
  git(main, 'push', '-q', 'origin', 'main');
  git(main, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(main, 'worktree', 'add', '-q', '-b', '42-retries', linked);
  git(linked, 'commit', '-q', '--allow-empty', '-m', 'Retry with backoff', '-m', 'Body text.');
  git(linked, 'commit', '-q', '--allow-empty', '-m', 'Cap the retries');
  return { bare, main, linked };
}

// the module over those checkouts and a GitHub whose world gains the pull request it creates
async function harness(create: (call: GraphqlCall) => unknown = () => ({ data: { createPullRequest: { pullRequest: { number: 77, url: 'https://github.com/octo/repo/pull/77' } } } })) {
  const paths = await checkouts();
  const pulls: PullFixture[] = [];
  const scripted = graphqlGithub(() => ({ 'octo/repo': { pulls } }));
  const calls: GraphqlCall[] = [];
  const timers = manualTimer();
  const worktrees = [
    testWorktree({ id: 'main', path: paths.main, identity: paths.main, branch: 'main', main: true }),
    testWorktree({ id: 'wt', label: 'retries', path: paths.linked, identity: paths.linked, branch: '42-retries', main: false, issue: 42 })
  ];
  const service = new GithubService({
    request: async (url, init) => {
      const call = JSON.parse(String(init?.body)) as GraphqlCall;
      calls.push(call);
      if (call.query.startsWith('query PullRequestRepository')) return reply({ data: { repository: { id: 'R_repo' } } });
      if (isCreate(call)) {
        const answer = create(call);
        if (at(answer, 'data', 'createPullRequest') !== undefined) pulls.push({ number: 77, branch: '42-retries', title: 'Retry with backoff', mine: true });
        return reply(answer);
      }
      return await scripted.request(url, init);
    },
    command: run,
    token: async () => 'private-token',
    timer: timers.timer,
    projects: () => [testProject({ id: 'proj', path: paths.main })],
    worktrees: () => worktrees
  });
  return { ...paths, service, calls, timers, worktrees };
}

function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

describe('pushing a Worktree\'s branch and creating its pull request', () => {
  it('prefills the title from the branch\'s first commit, the base from origin\'s default, and the Worktree\'s Issue', async () => {
    const { service } = await harness();
    expect(await service.pullRequestDraft('wt')).toEqual({ branch: '42-retries', base: 'main', title: 'Retry with backoff', issue: 42 });
  });

  it('pushes the branch with an upstream, then creates the pull request, which the panel then pins to the Worktree', async () => {
    const { service, calls, bare, linked } = await harness();
    expect(await service.createPullRequest('wt', { title: 'Retry with backoff', body: 'Closes #42', base: 'main', draft: true })).toEqual({ number: 77, url: 'https://github.com/octo/repo/pull/77' });
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/42-retries'], { encoding: 'utf8' }).trim()).toBe(git(linked, 'rev-parse', 'HEAD'));
    expect(git(linked, 'rev-parse', '--abbrev-ref', '42-retries@{upstream}')).toBe('origin/42-retries');
    const created = calls.filter(isCreate);
    expect(created.map(call => call.variables)).toEqual([{ input: { repositoryId: 'R_repo', baseRefName: 'main', headRefName: '42-retries', title: 'Retry with backoff', body: 'Closes #42', draft: true } }]);
    expect(calls.map(call => graphqlSyntaxError(call.query)).filter(error => error !== undefined)).toEqual([]);
    await settled();
    const panel = await service.panel(repo);
    expect(panel.mine).toMatchObject([{ number: 77, destination: { kind: 'worktree', worktreeId: 'wt' } }]);
  });

  it('refuses the main worktree, an unknown one, and a blank title or a malformed base before pushing anything', async () => {
    const { service, calls, bare } = await harness();
    const input = { title: 'Retry with backoff', body: '', base: 'main', draft: false };
    for (const [worktree, changed, status] of [['main', {}, 409], ['gone', {}, 404], ['wt', { title: ' \n ' }, 400], ['wt', { title: 'x'.repeat(257) }, 400], ['wt', { base: '--force' }, 400], ['wt', { body: 'x'.repeat(65_537) }, 400]] as const) {
      await expect(service.createPullRequest(worktree, { ...input, ...changed })).rejects.toMatchObject({ statusCode: status });
    }
    await expect(service.pullRequestDraft('main')).rejects.toMatchObject({ statusCode: 409 });
    expect(execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim()).toBe('refs/heads/main');
    expect(calls.filter(isCreate)).toHaveLength(0);
  });

  it('refuses without a token, or a branch of its own as git has it now, before pushing anything', async () => {
    const { service, calls, bare, linked, worktrees } = await harness();
    const tokenless = new GithubService({ command: run, token: async () => undefined, projects: () => [testProject({ id: 'proj', path: worktrees[0]!.path })], worktrees: () => worktrees });
    await expect(tokenless.createPullRequest('wt', input)).rejects.toMatchObject({ statusCode: 503 });
    // the snapshot still names 42-retries, but the checkout has since moved on
    git(linked, 'checkout', '-q', '--detach');
    await expect(service.pullRequestDraft('wt')).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createPullRequest('wt', input)).rejects.toMatchObject({ statusCode: 409 });
    git(linked, 'checkout', '-q', '-b', `rac/pr/7/${'a'.repeat(12)}`);
    await expect(service.createPullRequest('wt', input)).rejects.toMatchObject({ statusCode: 409 });
    expect(pushed(bare)).toBe('refs/heads/main');
    expect(calls.filter(isCreate)).toHaveLength(0);
  });

  it('pushes the branch git has checked out now, not the one the snapshot last saw', async () => {
    const { service, calls, bare, linked } = await harness();
    git(linked, 'checkout', '-q', '-b', '43-backoff');
    expect(await service.pullRequestDraft('wt')).toMatchObject({ branch: '43-backoff' });
    await service.createPullRequest('wt', input);
    expect(pushed(bare)).toBe('refs/heads/43-backoff\nrefs/heads/main');
    expect(calls.filter(isCreate).map(call => (call.variables.input as { headRefName: string }).headRefName)).toEqual(['43-backoff']);
  });

  it('refuses a pull request from the base or origin\'s default branch into itself, before pushing', async () => {
    const { service, calls, bare, main } = await harness();
    await expect(service.createPullRequest('wt', { ...input, base: '42-retries' })).rejects.toMatchObject({ statusCode: 409 });
    git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/42-retries');
    await expect(service.pullRequestDraft('wt')).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createPullRequest('wt', input)).rejects.toMatchObject({ statusCode: 409 });
    expect(pushed(bare)).toBe('refs/heads/main');
    expect(calls.filter(isCreate)).toHaveLength(0);
  });

  it('without origin/HEAD, prefills the base from the main checkout\'s own branch, as the New worktree dialog does', async () => {
    const { service, main } = await harness();
    git(main, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git(main, 'branch', '-q', '-m', 'main', 'trunk');
    expect(await service.pullRequestDraft('wt')).toMatchObject({ branch: '42-retries', base: 'trunk' });
  });

  it('reports a push git refused, and creates nothing', async () => {
    const { service, calls, bare, main } = await harness();
    // someone else pushed a different 42-retries first
    git(main, 'push', '-q', 'origin', 'main:refs/heads/42-retries');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'Elsewhere');
    git(main, 'push', '-q', '--force', 'origin', 'main:refs/heads/42-retries');
    const theirs = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/42-retries'], { encoding: 'utf8' }).trim();
    await expect(service.createPullRequest('wt', { title: 'Retry with backoff', body: '', base: 'main', draft: false })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^The push failed: .*rejected/u) });
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/42-retries'], { encoding: 'utf8' }).trim()).toBe(theirs);
    expect(calls.filter(isCreate)).toHaveLength(0);
  });

  it('reports GitHub refusing the pull request after the push, and reads the repository again', async () => {
    const { service, calls } = await harness(() => ({ data: { createPullRequest: null }, errors: [{ type: 'UNPROCESSABLE', message: 'No commits between main and 42-retries' }] }));
    const lists = () => calls.filter(call => /\br0:repository\(/u.test(call.query)).length;
    const [listed, revision] = [lists(), service.revision];
    await expect(service.createPullRequest('wt', { title: 'Retry with backoff', body: '', base: 'main', draft: false })).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('No commits between main and 42-retries') });
    await settled();
    expect(lists()).toBe(listed + 1);
    expect(service.revision).toBeGreaterThan(revision);
  });

  it('warns that a creation whose answer was lost may have applied', async () => {
    const { service } = await harness(() => { throw new TypeError('fetch failed'); });
    await expect(service.createPullRequest('wt', { title: 'Retry with backoff', body: '', base: 'main', draft: false })).rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('may have been created anyway') });
  });

});
