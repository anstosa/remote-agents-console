import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import type { Request } from '../src/github/github.js';
import { detailNode, graphqlGithub, reply, type GraphqlCall } from './helpers/github-graphql.js';

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

  it('replies to and resolves a Review thread and re-requests a review through the module', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    const github = await checkout('git@github.com:octo/repo.git');
    const projects = [testProject({ id: 'proj', label: 'Repo', path: github })];
    const mutations: GraphqlCall[] = [];
    const answers: Record<string, unknown> = {
      addPullRequestReviewThreadReply: { comment: { id: 'C9', url: 'https://github.com/octo/repo/pull/9#discussion_r9', state: 'SUBMITTED' } },
      resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } },
      rerequestReviews: { pullRequest: { id: 'PR_9' } }
    };
    const request: Request = async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as GraphqlCall;
      if (call.query.startsWith('query PullRequestDetail')) return reply({ data: { repository: { pullRequest: detailNode() } } });
      if (!call.query.startsWith('mutation')) return reply({ data: {} });
      mutations.push(call);
      const name = Object.keys(answers).find(key => call.query.includes(`${key}(`))!;
      return name === 'resolveReviewThread' && mutations.length > 2 ? reply({ data: { resolveReviewThread: null }, errors: [{ type: 'FORBIDDEN', message: 'Must have push access' }] }) : reply({ data: { [name]: answers[name] } });
    };
    const discovery = { worktreesNow: () => [], projectsNow: () => projects, dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: request });
    const headers = await authenticatedHeaders(app);
    const post = async (url: string, payload?: unknown) => await app!.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

    const replied = await post('/api/projects/proj/github/pulls/9/threads/PRRT_1/reply', { body: 'On it.' });
    expect([replied.statusCode, replied.json()]).toEqual([200, { id: 'C9', url: 'https://github.com/octo/repo/pull/9#discussion_r9', pending: false }]);
    expect((await post('/api/projects/proj/github/pulls/9/threads/PRRT_1/resolve')).statusCode).toBe(204);
    expect((await post('/api/projects/proj/github/pulls/9/rerequest', { login: 'mona' })).statusCode).toBe(204);
    expect(mutations.map(call => call.variables.input)).toEqual([{ pullRequestReviewThreadId: 'PRRT_1', body: 'On it.' }, { threadId: 'PRRT_1' }, { pullRequestId: 'PR_9', userIds: ['U_mona'] }]);
    // GitHub's refusal carries its message
    const refused = await post('/api/projects/proj/github/pulls/9/threads/PRRT_1/resolve');
    expect([refused.statusCode, refused.json().error]).toEqual([502, expect.stringContaining('Must have push access')]);
    // what is not on the pull request, and malformed requests, never reach GitHub
    expect((await post('/api/projects/proj/github/pulls/9/threads/PRRT_2/resolve')).statusCode).toBe(404);
    expect((await post('/api/projects/proj/github/pulls/9/rerequest', { login: 'kai' })).statusCode).toBe(404);
    for (const [url, payload] of [['/api/projects/proj/github/pulls/9/threads/PRRT_1/reply', { body: '' }], ['/api/projects/proj/github/pulls/9/threads/PRRT_1/reply', {}], ['/api/projects/proj/github/pulls/9/rerequest', { login: 7 }], ['/api/projects/proj/github/pulls/0/threads/PRRT_1/resolve', undefined]] as const) {
      expect((await post(url, payload)).statusCode, url).toBe(400);
    }
    for (const url of ['/api/projects/missing/github/pulls/9/threads/PRRT_1/resolve', '/api/projects/proj/github/pulls/9/threads/a%20b/resolve']) expect((await post(url)).statusCode, url).toBe(404);
    expect(mutations).toHaveLength(4);
  }, 15_000);

  it('prefills a new pull request for a Worktree, and pushes its branch and creates it through the module', async () => {
    process.env.RAC_GITHUB_TOKEN = 'token';
    const github = await checkout('git@github.com:octo/repo.git');
    const bare = `${github}-origin.git`;
    const linked = `${github}-fix`;
    const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args]);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(github, 'config', 'remote.origin.pushurl', bare);
    git(github, 'commit', '-q', '--allow-empty', '-m', 'Initial');
    git(github, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(github, 'worktree', 'add', '-q', '-b', 'fix', linked);
    git(linked, 'commit', '-q', '--allow-empty', '-m', 'Fix the thing');
    const projects = [testProject({ id: 'proj', label: 'Repo', path: github })];
    const worktrees = [testWorktree({ id: 'main', projectId: 'proj', path: github, main: true }), testWorktree({ id: 'fix', projectId: 'proj', path: linked, branch: 'fix', main: false, issue: 3 })];
    const mutations: GraphqlCall[] = [];
    const request: Request = async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as GraphqlCall;
      if (call.query.startsWith('query PullRequestRepository')) return reply({ data: { repository: { id: 'R_1' } } });
      if (!call.query.startsWith('mutation')) return reply({ data: {} });
      mutations.push(call);
      return reply({ data: { createPullRequest: { pullRequest: { number: 12, url: 'https://github.com/octo/repo/pull/12' } } } });
    };
    const discovery = { worktreesNow: () => worktrees, projectsNow: () => projects, dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, githubRequest: request });
    const headers = await authenticatedHeaders(app);
    const url = (id: string) => `/api/worktrees/${encodeURIComponent(id)}/github/pull-request`;

    const draft = await app.inject({ method: 'GET', url: url('fix'), headers });
    expect([draft.statusCode, draft.json()]).toEqual([200, { branch: 'fix', base: 'main', title: 'Fix the thing', issue: 3 }]);
    const created = await app.inject({ method: 'POST', url: url('fix'), headers, payload: { title: 'Fix the thing', body: 'Closes #3', base: 'main', draft: false } });
    expect([created.statusCode, created.json()]).toEqual([201, { number: 12, url: 'https://github.com/octo/repo/pull/12' }]);
    expect(mutations.map(call => call.variables.input)).toEqual([{ repositoryId: 'R_1', baseRefName: 'main', headRefName: 'fix', title: 'Fix the thing', body: 'Closes #3', draft: false }]);
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/fix'], { encoding: 'utf8' })).toBe(execFileSync('git', ['-C', linked, 'rev-parse', 'HEAD'], { encoding: 'utf8' }));
    // malformed requests, the main worktree and an unknown one never reach GitHub
    for (const payload of [{ title: 'x', body: '', base: 'main' }, { title: 7, body: '', base: 'main', draft: false }, {}]) {
      expect((await app.inject({ method: 'POST', url: url('fix'), headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: url('main'), headers, payload: { title: 'x', body: '', base: 'main', draft: false } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: url('gone'), headers })).statusCode).toBe(404);
    expect(mutations).toHaveLength(1);
  }, 15_000);
});
