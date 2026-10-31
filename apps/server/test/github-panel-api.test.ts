import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub } from './helpers/github-graphql.js';

// a git checkout whose origin is `origin`
async function checkout(origin: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rac-github-panel-'));
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', origin]);
  return path;
}

describe('GitHub panel API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const saved = process.env.RAC_GITHUB_TOKEN;
  afterEach(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.RAC_GITHUB_TOKEN; else process.env.RAC_GITHUB_TOKEN = saved;
  });

  it('serves a Project\'s lists from the module, and refuses a Project with no github.com origin', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    const github = await checkout('git@github.com:octo/repo.git');
    const elsewhere = await checkout('git@git.home.lan:tony/notes.git');
    const projects = [
      testProject({ id: 'proj', label: 'Repo', path: github }),
      testProject({ id: 'notes', label: 'Notes', path: elsewhere }),
      testProject({ id: 'folder', label: 'Folder', path: github, mode: 'directory' })
    ];
    const worktrees = [testWorktree({ id: 'main', projectId: 'proj', path: github, branch: 'main', main: true }), testWorktree({ id: 'fix', projectId: 'proj', label: 'fix-wt', path: `${github}-fix`, branch: 'fix', main: false })];
    let title = 'Fix the thing';
    const scripted = graphqlGithub(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'fix', title, mine: true }, { number: 2, branch: 'theirs', title: 'Theirs', author: 'kai' }], issues: [{ number: 3, title: 'Bug' }] } }));
    const discovery = { worktreesNow: () => worktrees, projectsNow: () => projects, dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: scripted.request });
    const { host, cookie } = await authenticatedHeaders(app);

    const listed = await app.inject({ method: 'GET', url: '/api/projects/proj/github', headers: { host, cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      mine: [{ number: 1, title: 'Fix the thing', destination: { kind: 'worktree', worktreeId: 'fix', label: 'fix-wt' } }],
      other: [{ number: 2, author: 'kai' }], issues: [{ number: 3, title: 'Bug' }], fetchedAt: expect.any(Number)
    });
    // Refresh reads again once the last read is ten seconds old
    title = 'Renamed';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
    try {
      const refreshed = await app.inject({ method: 'GET', url: '/api/projects/proj/github?refresh=1', headers: { host, cookie } });
      expect(refreshed.json().mine[0].title).toBe('Renamed');
    } finally { vi.useRealTimers(); }
    for (const id of ['notes', 'folder', 'missing']) {
      expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/github`, headers: { host, cookie } })).statusCode).toBe(404);
    }
  }, 15_000);

  it('serves one pull request\'s and one Issue\'s detail, and refuses a bad number or Project', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    const github = await checkout('git@github.com:octo/repo.git');
    const projects = [testProject({ id: 'proj', label: 'Repo', path: github }), testProject({ id: 'folder', label: 'Folder', path: github, mode: 'directory' })];
    let title = 'Fix the thing';
    const scripted = graphqlGithub(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'fix', title, mine: true }], issues: [{ number: 3, title: 'Bug', body: 'It breaks.' }] } }));
    const discovery = { worktreesNow: () => [], projectsNow: () => projects, dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: scripted.request });
    const { host, cookie } = await authenticatedHeaders(app);
    const get = async (url: string) => await app!.inject({ method: 'GET', url, headers: { host, cookie } });

    const pull = await get('/api/projects/proj/github/pulls/1');
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ pullRequest: { repository: 'octo/repo', number: 1, title: 'Fix the thing', mine: true }, fetchedAt: expect.any(Number) });
    // Refresh reads again once the last read is ten seconds old
    title = 'Renamed';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
    try {
      expect((await get('/api/projects/proj/github/pulls/1?refresh=1')).json().pullRequest.title).toBe('Renamed');
    } finally { vi.useRealTimers(); }
    const issue = await get('/api/projects/proj/github/issues/3');
    expect(issue.json()).toMatchObject({ issue: { number: 3, title: 'Bug', body: 'It breaks.' } });
    // GitHub's own trouble, a missing pull request included, is the reader's to show
    expect((await get('/api/projects/proj/github/pulls/2')).json()).toEqual({ problem: { kind: 'failing', message: expect.any(String) } });
    for (const url of ['/api/projects/proj/github/pulls/0', '/api/projects/proj/github/issues/1e3', '/api/projects/proj/github/pulls/2147483648']) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
    for (const url of ['/api/projects/folder/github/pulls/1', '/api/projects/missing/github/issues/3', '/api/projects/proj/github/commits/1']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  }, 15_000);
});
