import { describe, expect, it } from 'vitest';
import { GithubService, type PullRequestCleanupStatus } from '../src/github/service.js';
import type { Request } from '../src/github/github.js';
import { testProject } from './helpers/config.js';
import { graphqlGithub, manualTimer, reply, sha, type PullFixture, type World } from './helpers/github-graphql.js';

const mergedSha = sha('a');
const otherSha = sha('b');
const octo = { owner: 'octo', name: 'repo' };
const fork = `rac/pr/42/${mergedSha.slice(0, 12)}`;

// the module over a scripted GitHub; compares answer with `compare` and are recorded
function service(world: World | (() => World), options: { now?: () => number; compare?: (url: string) => ReturnType<Request>; token?: () => Promise<string | undefined>; request?: Request } = {}) {
  const scripted = graphqlGithub(world);
  const compares: string[] = [];
  const github = new GithubService({
    request: options.request ?? (async (url, init) => {
      if (url.includes('/compare/')) { compares.push(url); return await (options.compare ?? (async () => reply({ message: 'Not Found' }, 404)))(url); }
      return await scripted.request(url, init);
    }),
    token: options.token ?? (async () => 'token'),
    ...(options.now === undefined ? {} : { now: options.now }),
    command: async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }),
    projects: () => [testProject({ id: 'repo', path: '/src/octo/repo' })]
  });
  return { github, calls: scripted.calls, compares };
}

const closed = (pull: Omit<PullFixture, 'number' | 'branch'> & { number?: number; branch?: string } = {}): PullFixture => ({ number: 1, branch: 'feature/cleanup', state: 'CLOSED', sha: mergedSha, ...pull });
const merged = (pull: Omit<PullFixture, 'number' | 'branch'> & { number?: number; branch?: string } = {}): PullFixture => closed({ state: 'MERGED', ...pull });

// what GitHub proves about one head
async function status(github: GithubService, branch: string, head: string, options: { fresh?: boolean; acceptAncestor?: boolean } = {}): Promise<PullRequestCleanupStatus | undefined> {
  return (await github.cleanupHeads(octo, [{ branch, head }], options)).get(branch);
}

describe('cleanup evidence', () => {
  it.each([
    ['closed', [closed()]],
    ['merged', [merged()]],
    ['merged', [closed({ number: 1 }), merged({ number: 2 })]]
  ] as const)('proves an exact head %s', async (expected, pulls) => {
    const { github } = service({ 'octo/repo': { pulls: [...pulls] } });
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBe(expected);
  });

  it.each([
    ['an older head', [merged({ sha: otherSha })]],
    ['a fork\'s branch of the same name', [merged({ head: 'someone/repo' })]],
    ['an open pull request for the branch', [merged({ number: 1 }), { number: 2, branch: 'feature/cleanup', sha: otherSha }]],
    ['more pull requests than GitHub gave', Array.from({ length: 21 }, (_, index) => merged({ number: index + 1 }))],
    ['one GitHub gave that cannot be read', [merged({ number: 1 }), merged({ number: 2, sha: 'not-a-sha' })]]
  ])('proves nothing for %s', async (_name, pulls) => {
    const { github } = service({ 'octo/repo': { pulls } });
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
  });

  // a fork PR checks out as `rac/pr/<n>/<sha12>`, a name GitHub never lists as a head branch
  it.each([
    ['merged', { state: 'MERGED' as const }, 'merged'],
    ['closed', { state: 'CLOSED' as const }, 'closed'],
    ['open', { state: 'OPEN' as const }, undefined],
    ['moved on', { state: 'CLOSED' as const, sha: otherSha }, undefined]
  ] as const)('classifies a console fork checkout by its pull request number when %s', async (_name, pull, expected) => {
    const { github, calls } = service({ 'octo/repo': { pulls: [{ number: 42, branch: 'contributor-branch', head: 'someone/fork', sha: mergedSha, ...pull }] } });
    await expect(status(github, fork, mergedSha)).resolves.toBe(expected);
    expect(calls[0]!.variables).toMatchObject({ b0_0: 42 });
  });

  // a worktree offer also takes a checkout the author pushed past before the pull request closed;
  // branch deletion keeps requiring the exact final head
  it.each([
    ['behind', 'merged'],
    ['identical', 'merged'],
    ['ahead', undefined],
    ['diverged', undefined]
  ] as const)('accepts a head behind a closed pull request\'s final head for a worktree offer only when GitHub compares it %s', async (compared, expected) => {
    const { github, compares } = service({ 'octo/repo': { pulls: [merged({ sha: otherSha })] } }, { compare: async () => reply({ status: compared }) });

    await expect(status(github, 'feature/cleanup', mergedSha, { acceptAncestor: true })).resolves.toBe(expected);
    await expect(status(github, 'feature/cleanup', mergedSha, { acceptAncestor: true })).resolves.toBe(expected);
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    // two commits compare the same way for good
    expect(compares).toEqual([`https://api.github.com/repos/octo/repo/compare/${otherSha}...${mergedSha}`]);
  });

  it('compares nothing when the head is exactly the final head', async () => {
    const { github, compares } = service({ 'octo/repo': { pulls: [merged()] } }, { compare: async () => reply({ status: 'behind' }) });
    await expect(status(github, 'feature/cleanup', mergedSha, { acceptAncestor: true })).resolves.toBe('merged');
    expect(compares).toEqual([]);
  });

  it.each([
    ['behind', 'closed'],
    ['unknown to GitHub', undefined]
  ] as const)('accepts a fork checkout behind its pull request\'s final head, and fails closed when GitHub cannot compare (%s)', async (compared, expected) => {
    const { github } = service({ 'octo/repo': { pulls: [{ number: 42, branch: 'contributor-branch', head: 'someone/fork', state: 'CLOSED', sha: otherSha }] } }, { compare: async () => compared === 'behind' ? reply({ status: 'behind' }) : reply({ message: 'Not Found' }, 404) });
    await expect(status(github, fork, mergedSha, { acceptAncestor: true })).resolves.toBe(expected);
  });

  it('serves heads from data under a minute old, and reads them again after', async () => {
    let now = 0;
    const { github, calls } = service({ 'octo/repo': { pulls: [merged()] } }, { now: () => now });
    await status(github, 'feature/cleanup', mergedSha);
    now = 59_999;
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBe('merged');
    expect(calls).toHaveLength(1);
    now = 60_000;
    await status(github, 'feature/cleanup', mergedSha);
    expect(calls).toHaveLength(2);
  });

  it('takes a watched branch\'s heads from the poll without asking GitHub again', async () => {
    const timers = manualTimer();
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [merged()] } });
    const github = new GithubService({ request: scripted.request, token: async () => 'token', now: () => 0, timer: timers.timer, command: async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), projects: () => [testProject({ id: 'repo', path: '/src/octo/repo' })] });
    await github.branch(octo, 'feature/cleanup', true);
    github.watch();
    await timers.fire();

    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBe('merged');
    expect(scripted.calls).toHaveLength(1);
  });

  it('never looks up a branch the dashboard reads as unpublished', async () => {
    const { github, calls } = service({ 'octo/repo': { pulls: [merged()] } });
    await github.branch(octo, 'feature/cleanup', false);

    await expect(status(github, 'feature/cleanup', mergedSha, { fresh: true })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('looks every candidate up in one read', async () => {
    const { github, calls } = service({ 'octo/repo': { pulls: [merged({ branch: 'one' }), closed({ number: 2, branch: 'two' })] } });

    await expect(github.cleanupHeads(octo, [{ branch: 'one', head: mergedSha }, { branch: 'two', head: mergedSha }, { branch: 'three', head: mergedSha }])).resolves.toEqual(new Map([['one', 'merged'], ['two', 'closed']]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toMatchObject({ b0_0: 'one', b0_1: 'two', b0_2: 'three' });
  });

  it('replaces closed evidence when a fresh check finds the branch open', async () => {
    let open = false;
    const { github, calls } = service(() => ({ 'octo/repo': { pulls: [closed({ state: open ? 'OPEN' : 'CLOSED' })] } }));

    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBe('closed');
    open = true;
    await expect(status(github, 'feature/cleanup', mergedSha, { fresh: true })).resolves.toBeUndefined();
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('proves nothing when a fresh check fails, nor after it until GitHub answers again', async () => {
    let failing = false;
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [merged()] } });
    const { github } = service({}, { request: async (url, init) => { if (failing) throw new Error('offline'); return await scripted.request(url, init); } });

    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBe('merged');
    failing = true;
    await expect(status(github, 'feature/cleanup', mergedSha, { fresh: true })).resolves.toBeUndefined();
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    failing = false;
    await expect(status(github, 'feature/cleanup', mergedSha, { fresh: true })).resolves.toBe('merged');
  });

  it('proves nothing when GitHub refuses the token', async () => {
    const { github } = service({}, { request: async () => reply({ message: 'Bad credentials' }, 401) });
    await expect(status(github, 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
  });

  it('passes a branch name to GitHub as a variable, never in the query', async () => {
    const branch = 'feature/"quote" + space';
    const { github, calls } = service({ 'octo/repo': { pulls: [merged({ branch })] } });

    await expect(status(github, branch, mergedSha)).resolves.toBe('merged');
    expect(calls[0]!.query).not.toContain('quote');
    expect(calls[0]!.variables.b0_0).toBe(branch);
  });

  it('rejects invalid input before GitHub I/O', async () => {
    const { github, calls } = service({ 'octo/repo': { pulls: [merged()] } });

    await expect(status(github, 'feature/cleanup', 'invalid')).resolves.toBeUndefined();
    await expect(status(github, ' ', mergedSha)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
