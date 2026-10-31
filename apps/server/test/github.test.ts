import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubRepository, githubToken, hostsToken, type Request } from '../src/github/github.js';
import { GithubService, type GithubServiceOptions } from '../src/github/service.js';
import { answer, graphqlGithub, polled, reply, settled, sha, type GraphqlCall, type World } from './helpers/github-graphql.js';

// gh's multi-account hosts.yml: bob is github.com's active account, and another host has its own token
const multiAccountHosts = `ghe.example.com:
    oauth_token: gho_enterprise
    user: carol
github.com:
    users:
        alice:
            oauth_token: gho_alice
        bob:
            oauth_token: gho_bob
    git_protocol: https
    oauth_token: gho_bob
    user: bob
other.example.com:
    oauth_token: gho_other
`;
const octo = { owner: 'octo', name: 'repo' };

// the module over a scripted GitHub, for a checkout whose origin is octo/repo
function github(request: Request, options: GithubServiceOptions = {}): GithubService {
  return new GithubService({ request, command: async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), token: async () => 'private-token', ...options });
}

describe('GitHub token selection', () => {
  it('takes the active github.com token, never another account or host', () => {
    expect(hostsToken(multiAccountHosts)).toBe('gho_bob');
    expect(hostsToken('github.com:\n    oauth_token: "gho_quoted"\n    user: dana\n')).toBe('gho_quoted');
    // a keyring login keeps no token in the file; another host's must not stand in for it
    expect(hostsToken('github.com:\n    users:\n        erin:\n            oauth_token: gho_erin\n    user: erin\nghe.example.com:\n    oauth_token: gho_enterprise\n')).toBeUndefined();
    expect(hostsToken('')).toBeUndefined();
  });

  it('prefers RAC_GITHUB_TOKEN, then reads the hosts file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-gh-hosts-'));
    const hosts = join(directory, 'hosts.yml');
    await writeFile(hosts, multiAccountHosts);
    const saved = { token: process.env.RAC_GITHUB_TOKEN, hosts: process.env.RAC_GH_HOSTS };
    try {
      process.env.RAC_GH_HOSTS = hosts;
      delete process.env.RAC_GITHUB_TOKEN;
      await expect(githubToken()).resolves.toBe('gho_bob');
      process.env.RAC_GITHUB_TOKEN = 'env-token';
      await expect(githubToken()).resolves.toBe('env-token');
    } finally {
      if (saved.token === undefined) delete process.env.RAC_GITHUB_TOKEN; else process.env.RAC_GITHUB_TOKEN = saved.token;
      if (saved.hosts === undefined) delete process.env.RAC_GH_HOSTS; else process.env.RAC_GH_HOSTS = saved.hosts;
    }
  });

  it('looks the viewer up once per token, and again after GitHub refuses it or the token changes', async () => {
    let token = 'token-1';
    let refuse = false;
    const viewers: string[] = [];
    const service = github(async (url, init) => {
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      if (url.endsWith('/user')) { viewers.push(authorization); return reply({ login: authorization.slice(-1) === '1' ? 'me' : 'other' }); }
      return refuse ? reply({ message: 'Bad credentials' }, 401) : reply([]);
    }, { token: async () => token });

    await expect(service.viewer()).resolves.toBe('me');
    await expect(service.viewer()).resolves.toBe('me');
    expect(viewers).toEqual(['Bearer token-1']);
    refuse = true;
    await expect(service.repository(octo)).resolves.toMatchObject({ problem: { kind: 'failing' } });
    refuse = false;
    await expect(service.viewer()).resolves.toBe('me');
    expect(viewers).toEqual(['Bearer token-1', 'Bearer token-1']);
    // a new login applies at once, though the old token still works
    token = 'token-2';
    await expect(service.viewer()).resolves.toBe('other');
    expect(viewers).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  });
});

describe('GitHub origins', () => {
  it('recognizes GitHub origin formats', () => {
    expect(githubRepository('git@github.com:octo/repo.git')).toEqual(octo);
    expect(githubRepository('https://github.com/octo/repo.git')).toEqual(octo);
    expect(githubRepository('https://example.com/octo/repo.git')).toBeUndefined();
  });
});

// the repositories, lists and branches one GraphQL read asked for
function asked({ query, variables }: GraphqlCall): { repositories: string[]; lists: number; branches: unknown[] } {
  const repositories = Object.keys(variables).filter(name => /^o\d+$/u.test(name)).map(name => `${String(variables[name])}/${String(variables[`n${name.slice(1)}`])}`);
  return { repositories, lists: query.match(/open:pullRequests\(/gu)?.length ?? 0, branches: Object.keys(variables).filter(name => /^b\d+_\d+$/u.test(name)).map(name => variables[name]) };
}

describe('the poll', () => {
  it('sends nothing while no browser watches, and polls at once and every minute while one does', async () => {
    const { service, calls, timers, clock } = polled({ 'octo/repo': {} });
    await settled();
    expect(timers.delays()).toEqual([]);
    expect(calls).toHaveLength(0);

    const release = service.watch();
    expect(timers.delays()).toEqual([0]);
    await timers.fire();
    expect(calls).toHaveLength(1);
    expect(timers.delays()).toEqual([60_000]);
    clock.now = 60_000;
    await timers.fire();
    expect(calls).toHaveLength(2);

    release();
    expect(timers.delays()).toEqual([]);
    // releasing twice does not release someone else's handle
    const other = service.watch();
    release();
    expect(timers.delays()).toHaveLength(1);
    other();
    expect(timers.delays()).toEqual([]);
  });

  it('keeps one schedule for many watchers', async () => {
    const { service, calls, timers } = polled({ 'octo/repo': {} });
    const first = service.watch();
    service.watch();
    expect(timers.delays()).toEqual([0]);
    await timers.fire();
    expect(calls).toHaveLength(1);
    first();
    expect(timers.delays()).toEqual([60_000]);
  });

  it('schedules nothing after a poll the last browser left while it ran', async () => {
    let answer: () => void = () => undefined;
    const answered = new Promise<void>(resolve => { answer = resolve; });
    const scripted = graphqlGithub({ 'octo/repo': {} });
    const { service, timers } = polled({}, { request: async (url, init) => { await answered; return await scripted.request(url, init); } });
    const release = service.watch();
    await timers.fire();
    release();
    answer();
    await settled();
    expect(scripted.calls.length + scripted.searches.length).toBe(2);
    expect(timers.delays()).toEqual([]);
  });

  it('fires as soon as a browser returns after the data has aged', async () => {
    const { service, calls, timers, clock } = polled({ 'octo/repo': {} });
    const release = service.watch();
    await timers.fire();
    release();
    clock.now = 20_000;
    const again = service.watch();
    // the poll from 20s ago is still fresh: the next one keeps its minute
    expect(timers.delays()).toEqual([40_000]);
    again();
    clock.now = 90_000;
    service.watch();
    expect(timers.delays()).toEqual([0]);
    await timers.fire();
    expect(calls).toHaveLength(2);
  });

  it('polls every Project\'s open pull requests and issues, and each tracked published branch, in one read', async () => {
    const { service, calls, timers } = polled({ 'octo/repo': {}, 'octo/tools': {}, 'acme/other': {} }, { repositories: ['octo/repo', 'octo/tools'] });
    await service.branch({ owner: 'octo', name: 'repo' }, 'feature/pushed', true);
    await service.branch({ owner: 'octo', name: 'repo' }, 'feature/local', false);
    await service.branch({ owner: 'acme', name: 'other' }, 'fix', true);
    await service.branch({ owner: 'octo', name: 'repo' }, `rac/pr/42/${sha('c').slice(0, 12)}`, false);
    service.watch();
    await timers.fire();

    expect(calls).toHaveLength(1);
    expect(asked(calls[0]!)).toEqual({ repositories: ['octo/repo', 'octo/tools', 'acme/other'], lists: 3, branches: ['feature/pushed', 42, 'fix'] });
    expect(calls[0]!.query).toContain('issues(states:OPEN');
    expect(calls[0]!.query).toContain('closingIssuesReferences');
  });

  it('stops polling a branch ten minutes after its last read', async () => {
    const { service, calls, timers, clock } = polled({ 'octo/repo': {} });
    await service.branch(octo, 'feature/old', true);
    service.watch();
    await timers.fire();
    clock.now = 599_999;
    await timers.fire();
    clock.now = 600_000;
    await timers.fire();
    expect(calls.map(call => asked(call).branches)).toEqual([['feature/old'], ['feature/old'], []]);
  });

  it('polls half as often while a budget is below 20%', async () => {
    const { service, timers } = polled({}, { request: async () => reply({ data: {} }, 200, { 'x-ratelimit-remaining': '999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '3600' }) });
    service.watch();
    await timers.fire();
    expect(timers.delays()).toEqual([120_000]);
  });

  it('moves the revision when the data changes, and only then', async () => {
    let title = 'First';
    const { service, timers, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', title }] } }));
    const start = service.revision;
    service.watch();
    await timers.fire();
    const polledOnce = service.revision;
    expect(polledOnce).toBeGreaterThan(start);
    clock.now = 60_000;
    await timers.fire();
    expect(service.revision).toBe(polledOnce);
    title = 'Renamed';
    clock.now = 120_000;
    await timers.fire();
    expect(service.revision).toBeGreaterThan(polledOnce);
  });
});

describe('a repository\'s open pull requests and issues', () => {
  const world: World = { 'octo/repo': {
    pulls: [
      { number: 7, branch: 'feature/draft', title: 'Draft work', draft: true, mine: true, sha: sha('c'), mergeable: 'CONFLICTING', checks: 'FAILURE', threads: [{ isResolved: false, isOutdated: false }] },
      { number: 8, branch: 'feature/other', title: 'Other user', head: 'contributor/repo', sha: sha('d') },
      { number: 9, branch: 'gone', state: 'MERGED' }
    ],
    issues: [{ number: 3, title: 'Crash on start' }]
  } };

  it('serves the poll\'s lists without asking GitHub, the viewer\'s own apart from others\'', async () => {
    const { service, calls, timers } = polled(world);
    service.watch();
    await timers.fire();

    await expect(service.repository(octo)).resolves.toEqual({
      own: [{ number: 7, title: 'Draft work', draft: true, url: 'https://github.com/octo/repo/pull/7', branch: 'feature/draft', headSha: sha('c'), headOnOrigin: true, checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } }],
      others: [{ number: 8, title: 'Other user', draft: false, url: 'https://github.com/octo/repo/pull/8', branch: 'feature/other', headSha: sha('d'), headOnOrigin: false }],
      issues: [{ number: 3, title: 'Crash on start', url: 'https://github.com/octo/repo/issues/3', author: 'someone', updatedAt: '2026-10-30T12:00:00Z' }],
      fetchedAt: 0
    });
    expect(calls).toHaveLength(1);
  });

  it('waits on GitHub only for a repository it never read, and then for that repository alone', async () => {
    const { service, calls } = polled({ ...world, 'acme/other': {} }, { repositories: ['octo/repo', 'acme/other'] });
    await service.branch(octo, 'feature/draft', true);
    await service.branch({ owner: 'acme', name: 'other' }, 'fix', true);

    await expect(service.repository(octo)).resolves.toMatchObject({ own: [{ number: 7 }], fetchedAt: 0 });
    expect(calls.map(asked)).toEqual([{ repositories: ['octo/repo'], lists: 1, branches: ['feature/draft'] }]);
  });

  it('answers with the old lists at once after a minute, and refreshes them behind', async () => {
    let title = 'Draft work';
    const { service, calls, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 7, branch: 'feature/draft', title, mine: true }] } }));
    await service.repository(octo);
    title = 'Renamed';
    clock.now = 59_999;
    await expect(service.repository(octo)).resolves.toMatchObject({ own: [{ title: 'Draft work' }] });
    expect(calls).toHaveLength(1);
    clock.now = 60_000;
    await expect(service.repository(octo)).resolves.toMatchObject({ own: [{ title: 'Draft work' }], fetchedAt: 0 });
    await settled();
    await expect(service.repository(octo)).resolves.toMatchObject({ own: [{ title: 'Renamed' }], fetchedAt: 60_000 });
    expect(calls).toHaveLength(2);
  });

  it('waits for lists under a minute old when the reader is about to act on them', async () => {
    let title = 'Draft work';
    const { service, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 7, branch: 'feature/draft', title, mine: true }] } }));
    await service.repository(octo);
    title = 'Renamed';
    clock.now = 60_000;
    await expect(service.repository(octo, { wait: true })).resolves.toMatchObject({ own: [{ title: 'Renamed' }], fetchedAt: 60_000 });
  });

  it('reports a missing token without asking GitHub', async () => {
    const { service, calls } = polled(world, { token: async () => undefined });

    await expect(service.repository(octo)).resolves.toEqual({ own: [], others: [], issues: [], problem: { kind: 'no-token', message: 'GitHub authentication is not configured for pull request lookup.' } });
    expect(calls).toHaveLength(0);
  });

  it('keeps the last lists beside the problem when GitHub fails', async () => {
    let failing = false;
    const scripted = graphqlGithub(world);
    const { service, clock } = polled(world, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 502) : await scripted.request(url, init) });
    await service.repository(octo);
    failing = true;
    clock.now = 60_000;
    await service.repository(octo);
    await settled();
    await expect(service.repository(octo)).resolves.toMatchObject({ others: [{ number: 8 }], fetchedAt: 0, problem: { kind: 'failing' } });
  });

  it('reports a repository GitHub does not show as a problem, without losing the others', async () => {
    const { service, timers } = polled({ 'octo/repo': world['octo/repo']! }, { repositories: ['octo/repo', 'octo/private'] });
    service.watch();
    await timers.fire();

    await expect(service.repository(octo)).resolves.toMatchObject({ own: [{ number: 7 }], fetchedAt: 0 });
    await expect(service.repository({ owner: 'octo', name: 'private' })).resolves.toMatchObject({ own: [], problem: { kind: 'failing' } });
  });
});

describe('a branch\'s pull request summary', () => {
  it('never asks GitHub for a read that does not wait, however old its data', async () => {
    const { service, calls, clock } = polled({ 'octo/repo': {} });
    await expect(service.branch(octo, 'feature', true)).resolves.toEqual({});
    clock.now = 3_600_000;
    await service.branch(octo, 'feature', true, { remoteHead: sha('a') });
    await settled();
    expect(calls).toHaveLength(0);
  });

  it('summarizes an open pull request from the poll, with conflicts, failing checks and unresolved current threads', async () => {
    const { service, timers } = polled({ 'octo/repo': { pulls: [
      { number: 77, branch: 'feature/fixup', title: 'Needs attention', base: 'staging', mergeable: 'CONFLICTING', checks: 'FAILURE', threads: [{ isResolved: false, isOutdated: false }, { isResolved: false, isOutdated: true }, { isResolved: true, isOutdated: false }] }
    ] } });
    await service.branch(octo, 'feature/fixup', true);
    service.watch();
    await timers.fire();

    await expect(service.branch(octo, 'feature/fixup', true)).resolves.toEqual({ pullRequest: {
      number: 77, title: 'Needs attention', status: 'open', url: 'https://github.com/octo/repo/pull/77', baseBranch: 'staging', checks: 'failed',
      issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true },
      unresolvedThreads: 1
    }, fetchedAt: 0 });
  });

  it('matches an unpublished branch\'s open pull request from its Project\'s list', async () => {
    const { service, calls, timers } = polled({ 'octo/repo': { pulls: [{ number: 5, branch: 'feature/local', checks: 'PENDING' }] } });
    await service.branch(octo, 'feature/local', false);
    service.watch();
    await timers.fire();

    expect(asked(calls[0]!).branches).toEqual([]);
    await expect(service.branch(octo, 'feature/local', false)).resolves.toMatchObject({ pullRequest: { number: 5, status: 'open', checks: 'pending' } });
  });

  it.each([
    ['a merged pull request', [{ number: 41, branch: 'feature', state: 'MERGED' as const, checks: null }], { number: 41, status: 'merged', checks: 'passed' }],
    ['nothing for one closed without merging', [{ number: 40, branch: 'feature', state: 'CLOSED' as const }], undefined],
    ['a current draft over an older merge', [{ number: 12, branch: 'feature', state: 'MERGED' as const }, { number: 13, branch: 'feature', draft: true, checks: 'PENDING' as const }], { number: 13, status: 'draft', checks: 'pending' }],
    ['nothing for a fork\'s branch of the same name', [{ number: 14, branch: 'feature', head: 'someone/repo' }], undefined],
    ['nothing for an untrusted URL', [{ number: 15, branch: 'feature', url: 'https://example.com/pull/15' }], undefined]
  ])('shows %s', async (_name, pulls, expected) => {
    const { service, timers } = polled({ 'octo/repo': { pulls } });
    await service.branch(octo, 'feature', true);
    service.watch();
    await timers.fire();

    const { pullRequest } = await service.branch(octo, 'feature', true);
    if (expected === undefined) expect(pullRequest).toBeUndefined(); else expect(pullRequest).toMatchObject(expected);
  });

  it('falls back on the open list when GitHub has more pull requests for the name than it gave', async () => {
    const forks = Array.from({ length: 20 }, (_, index) => ({ number: 100 + index, branch: 'patch-1', head: `fork${index}/repo` }));
    const { service, timers } = polled({ 'octo/repo': { pulls: [{ number: 5, branch: 'patch-1' }, ...forks] } });
    await service.branch(octo, 'patch-1', true);
    service.watch();
    await timers.fire();

    await expect(service.branch(octo, 'patch-1', true)).resolves.toMatchObject({ pullRequest: { number: 5, status: 'open' } });
  });

  it('finds a fork checkout\'s pull request by its number', async () => {
    const { service, timers } = polled({ 'octo/repo': { pulls: [{ number: 42, branch: 'contributor-branch', head: 'someone/fork', state: 'MERGED' }] } });
    const fork = `rac/pr/42/${sha('a').slice(0, 12)}`;
    await service.branch(octo, fork, false);
    service.watch();
    await timers.fire();

    await expect(service.branch(octo, fork, false)).resolves.toMatchObject({ pullRequest: { number: 42, status: 'merged' } });
  });

  it('refreshes just that branch on a waiting read older than a minute', async () => {
    let checks: 'PENDING' | 'SUCCESS' = 'PENDING';
    const { service, calls, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 78, branch: 'feature/ci', checks, threads: [{ isResolved: false, isOutdated: false }] }] } }));
    await service.branch(octo, 'feature/other', true);

    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'pending', unresolvedThreads: 1 }, fetchedAt: 0 });
    checks = 'SUCCESS';
    clock.now = 59_999;
    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'pending' }, fetchedAt: 0 });
    clock.now = 60_000;
    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'passed', unresolvedThreads: 1 }, fetchedAt: 60_000 });
    expect(calls.map(asked)).toEqual([{ repositories: ['octo/repo'], lists: 0, branches: ['feature/ci'] }, { repositories: ['octo/repo'], lists: 0, branches: ['feature/ci'] }]);
  });

  it('refreshes an unpublished branch through its repository\'s list, never by name', async () => {
    const { service, calls } = polled({ 'octo/repo': { pulls: [{ number: 5, branch: 'feature/local' }] } });

    await expect(service.branch(octo, 'feature/local', false, { wait: true })).resolves.toMatchObject({ pullRequest: { number: 5 } });
    expect(calls.map(asked)).toEqual([{ repositories: ['octo/repo'], lists: 1, branches: [] }]);
  });

  it('keeps what the dashboard last said about publication when a reader does not know', async () => {
    const { service, calls } = polled({ 'octo/repo': {} });
    await service.branch(octo, 'feature/local', false);

    await service.branch(octo, 'feature/local', undefined, { wait: true });
    expect(asked(calls[0]!)).toMatchObject({ lists: 1, branches: [] });
  });

  it('keeps the last summary beside the problem when GitHub fails', async () => {
    let failing = false;
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 9, branch: 'feature/retries' }] } });
    const { service, clock } = polled({}, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 500) : await scripted.request(url, init) });
    await service.branch(octo, 'feature/retries', true, { wait: true });
    failing = true;
    clock.now = 60_000;

    await expect(service.branch(octo, 'feature/retries', true, { wait: true })).resolves.toEqual({
      pullRequest: expect.objectContaining({ number: 9 }),
      fetchedAt: 0,
      problem: { kind: 'failing', message: 'GitHub could not read pull requests (500): Server Error' }
    });
  });

  it('refreshes the repository when a tracked branch\'s remote ref moves', async () => {
    const { service, calls } = polled({ 'octo/repo': {} });
    await service.branch(octo, 'feature', true, { remoteHead: sha('a') });
    await service.branch(octo, 'feature', true, { remoteHead: sha('a') });
    await settled();
    expect(calls).toHaveLength(0);

    await service.branch(octo, 'feature', true, { remoteHead: sha('b') });
    await settled();
    expect(calls.map(asked)).toEqual([{ repositories: ['octo/repo'], lists: 1, branches: ['feature'] }]);
  });

  it('reads two checkouts of one branch, fetched at different times, as one push at most', async () => {
    const { service, calls } = polled({ 'octo/repo': {} });
    for (let tick = 0; tick < 3; tick += 1) {
      await service.branch(octo, 'main', true, { remoteHead: sha('a') });
      await service.branch(octo, 'main', true, { remoteHead: sha('b') });
    }
    await settled();
    expect(calls).toHaveLength(1);
  });

  it('still shows the merge of a branch whose remote ref the merge pruned', async () => {
    let state: 'OPEN' | 'MERGED' = 'OPEN';
    const { service, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 6, branch: 'feature/pushed', state }] } }));
    await service.branch(octo, 'feature/pushed', true, { wait: true });
    state = 'MERGED';
    clock.now = 60_000;

    await expect(service.branch(octo, 'feature/pushed', false, { wait: true })).resolves.toMatchObject({ pullRequest: { number: 6, status: 'merged' } });
  });

  it('reports a list GitHub withheld as a problem, not as an empty list', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 7, branch: 'feature/draft', mine: true }] } });
    const { service } = polled({}, { request: async (url, init) => {
      const body = await (await scripted.request(url, init)).json() as { data: { r0: Record<string, unknown> } };
      return reply({ data: { r0: { ...body.data.r0, issues: null } }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
    } });

    await expect(service.repository(octo)).resolves.toMatchObject({ own: [], problem: { kind: 'failing', message: 'GitHub could not read pull requests: Resource not accessible by integration' } });
  });

  it('refreshes the repository when another writer changes one of its pull requests', async () => {
    const { service, calls } = polled({ 'octo/repo': {} });
    service.changed(octo, 5);
    await settled();
    expect(calls.map(asked)).toEqual([{ repositories: ['octo/repo'], lists: 1, branches: [] }]);
  });
});

describe('check states', () => {
  it.each([
    ['SUCCESS', 'passed'],
    ['FAILURE', 'failed'],
    ['ERROR', 'failed'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    [null, 'passed']
  ] as const)('reads a %s rollup as %s', async (rollup, expected) => {
    const { service } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', checks: rollup }] } });
    await expect(service.branch(octo, 'feature', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: expected } });
  });
});

// an empty octo/repo, as GitHub answers the module's reads of it
const empty = (init?: RequestInit) => reply(answer({ 'octo/repo': {} }, JSON.parse(String(init?.body)) as GraphqlCall));

describe('the shared GitHub client', () => {
  it('sends one request at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const service = github(async (_url, init) => {
      most = Math.max(most, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return empty(init);
    });

    await Promise.all([service.branch(octo, 'one', true, { wait: true }), service.branch(octo, 'two', true, { wait: true }), service.cleanupHeads(octo, [{ branch: 'three', head: sha('a') }])]);
    expect(most).toBe(1);
  });

  it('holds every request back until a 429\'s retry-after has passed', async () => {
    let now = 1_000_000;
    let limited = true;
    let requests = 0;
    const service = github(async (_url, init) => {
      requests += 1;
      return limited ? reply({ message: 'secondary rate limit' }, 429, { 'retry-after': '30' }) : empty(init);
    }, { now: () => now });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toEqual({ problem: { kind: 'rate-limited', message: expect.any(String), until: 1_030_000 } });
    limited = false;
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_030_000 } });
    expect(requests).toBe(1);
    now = 1_030_000;
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_030_000 });
    expect(requests).toBe(2);
  });

  it('waits for the reset time after a 403 for an exhausted budget', async () => {
    let now = 1_000_000;
    let requests = 0;
    const service = github(async (_url, init) => {
      requests += 1;
      return requests === 1 ? reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' }) : empty(init);
    }, { now: () => now });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_100_000 } });
    now = 1_099_999;
    await expect(service.cleanupHeads(octo, [{ branch: 'two', head: sha('a') }])).resolves.toEqual(new Map());
    expect(requests).toBe(1);
    now = 1_100_000;
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_100_000 });
    expect(requests).toBe(2);
  });

  it('holds requests back after a 200 whose GraphQL errors say RATE_LIMITED, until the reset or for a minute', async () => {
    let now = 1_000_000;
    let requests = 0;
    const limited = (headers: Record<string, string>) => reply({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }, 200, headers);
    const service = github(async (_url, init) => {
      requests += 1;
      return requests === 1 ? limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' }) : requests === 3 ? limited({}) : empty(init);
    }, { now: () => now });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_100_000 } });
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_100_000 } });
    expect(requests).toBe(1);
    now = 1_100_000;
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_100_000 });
    // naming no reset, it holds for GitHub's minute
    await expect(service.branch(octo, 'four', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_160_000 } });
    await expect(service.branch(octo, 'five', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_160_000 } });
    expect(requests).toBe(3);
  });

  it('holds requests back after an answer that spent the last of the budget, until its reset', async () => {
    let now = 1_000_000;
    let requests = 0;
    const service = github(async (_url, init) => {
      requests += 1;
      return reply((await empty(init).json()) as object, 200, requests === 1 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' } : {});
    }, { now: () => now });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_000_000 });
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_100_000 } });
    expect(requests).toBe(1);
    now = 1_100_000;
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_100_000 });
  });

  it('holds requests for a minute after a secondary rate limit that names no wait, and keeps the viewer', async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const service = github(async (url, init) => {
      sent.push(url);
      if (url.endsWith('/user')) return reply({ login: 'me' });
      return sent.length === 2 ? reply({ message: 'You have exceeded a secondary rate limit.' }, 403) : empty(init);
    }, { now: () => now });

    await service.viewer();
    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_060_000 } });
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited' } });
    now = 1_060_000;
    await service.viewer();
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_060_000 });
    expect(sent.filter(url => url.endsWith('/user'))).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  it('does not hold back a new token behind a limit reached with another, nor past the hour', async () => {
    let now = 1_000_000;
    let token = 'spent';
    const service = github(async (_url, init) => new Headers(init?.headers).get('Authorization') === 'Bearer fresh-login'
      ? empty(init)
      : reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '999999999' }), { now: () => now, token: async () => token });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_000_000 + 3_600_000 } });
    token = 'fresh-login';
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_000_000 });
  });

  it('doubles the refresh interval while a budget is below 20%, until the budget resets', async () => {
    let now = 0;
    const lookups: unknown[] = [];
    const service = github(async (_url, init) => {
      const branch = (JSON.parse(String(init?.body)) as GraphqlCall).variables.b0_0;
      lookups.push(branch);
      // only the answers for `low` report a budget: low, and reset at 150s
      return reply((await empty(init).json()) as object, 200, branch === 'low' ? { 'x-ratelimit-remaining': '999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '150' } : {});
    }, { now: () => now });

    await service.branch(octo, 'low', true, { wait: true });
    now = 60_000;
    await service.branch(octo, 'low', true, { wait: true });
    expect(lookups).toEqual(['low']);
    now = 120_000;
    await service.branch(octo, 'low', true, { wait: true });
    expect(lookups).toEqual(['low', 'low']);
    // after the reset the usual minute applies again
    now = 150_000;
    await service.branch(octo, 'after', true, { wait: true });
    now = 210_000;
    await service.branch(octo, 'after', true, { wait: true });
    expect(lookups).toEqual(['low', 'low', 'after', 'after']);
  });

  it('keeps the usual interval at 20% remaining', async () => {
    let now = 0;
    let requests = 0;
    const service = github(async (_url, init) => {
      requests += 1;
      return reply((await empty(init).json()) as object, 200, { 'x-ratelimit-remaining': '1000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '3600' });
    }, { now: () => now });

    await service.branch(octo, 'feature', true, { wait: true });
    now = 60_000;
    await service.branch(octo, 'feature', true, { wait: true });
    expect(requests).toBe(2);
  });
});
