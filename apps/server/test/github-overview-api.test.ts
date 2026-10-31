import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub } from './helpers/github-graphql.js';

describe('Overview API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const saved = process.env.RAC_GITHUB_TOKEN;
  afterEach(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.RAC_GITHUB_TOKEN; else process.env.RAC_GITHUB_TOKEN = saved;
  });

  it('serves the Overview\'s lists from the module, with the console\'s Worktrees as destinations, reading GitHub again on Refresh', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    // a Project checkout whose origin is octo/repo
    const checkout = await mkdtemp(join(tmpdir(), 'rac-overview-'));
    execFileSync('git', ['init', '-q', checkout]);
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:octo/repo.git']);
    const project = testProject({ id: 'proj', label: 'Repo', path: checkout });
    const worktrees = [testWorktree({ id: 'main', projectId: 'proj', path: checkout, branch: 'main', main: true }), testWorktree({ id: 'fix', projectId: 'proj', label: 'fix-wt', path: `${checkout}-fix`, branch: 'fix', main: false })];
    let title = 'Fix the thing';
    const scripted = graphqlGithub(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'fix', title, mine: true, checks: 'FAILURE' }] } }));
    const discovery = { worktreesNow: () => worktrees, projectsNow: () => [project], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: scripted.request });
    const { host, cookie } = await authenticatedHeaders(app);

    const listed = await app.inject({ method: 'GET', url: '/api/github/overview', headers: { host, cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ mine: [{ repository: 'octo/repo', number: 1, title: 'Fix the thing', reasons: [{ kind: 'checks' }], destination: { kind: 'worktree', worktreeId: 'fix', label: 'fix-wt' } }], reviews: [], issues: [], fetchedAt: expect.any(Number) });

    // Refresh reads again once the last read is ten seconds old
    title = 'Renamed';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
    try {
      const refreshed = await app.inject({ method: 'GET', url: '/api/github/overview?refresh=1', headers: { host, cookie } });
      expect(refreshed.json().mine[0].title).toBe('Renamed');
    } finally { vi.useRealTimers(); }
    expect(scripted.searches).toHaveLength(2);
  }, 15_000);

  it('marks the reasons of rows a browser showed as seen, and carries the badge on the dashboard frame', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'fix', mine: true, checks: 'FAILURE' }, { number: 2, branch: 'theirs', requested: true, viewerRequest: 'request-2' }] } });
    const discovery = { worktreesNow: () => [], projectsNow: () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: scripted.request });
    const headers = await authenticatedHeaders(app);
    const read = { host: headers.host, cookie: headers.cookie };

    const overview = (await app.inject({ method: 'GET', url: '/api/github/overview', headers: read })).json();
    expect(overview.mine[0].unseen).toEqual(['octo/repo#1:checks:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard', headers: read })).json().githubBadge).toBe(2);

    const seen = await app.inject({ method: 'POST', url: '/api/github/overview/seen', headers, payload: { keys: overview.mine[0].unseen } });
    expect(seen.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard', headers: read })).json().githubBadge).toBe(1);

    for (const payload of [{}, { keys: 'octo/repo#2' }, { keys: [2] }, { keys: Array.from({ length: 1_001 }, () => 'x') }]) {
      expect((await app.inject({ method: 'POST', url: '/api/github/overview/seen', headers, payload })).statusCode).toBe(400);
    }
  }, 15_000);
});
