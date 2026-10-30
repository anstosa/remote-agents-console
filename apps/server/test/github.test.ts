import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubRepository, githubToken, hostsToken, type Request, type ResponseLike } from '../src/github/github.js';
import { GithubService, type GithubServiceOptions } from '../src/github/service.js';

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

// one GitHub response, with any headers GitHub sends
function reply(body: unknown, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

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

describe('a branch\'s pull request summary', () => {
  it('summarizes the branch\'s open pull request and serves it from cache', async () => {
    const requests: string[] = [];
    const service = github(async (url, init) => {
      requests.push(url);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-token');
      if (url.endsWith('/pulls/42')) return reply({ mergeable: true, mergeable_state: 'clean' });
      if (url.endsWith('/graphql')) return reply({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      return reply([{ number: 42, title: 'Voice input', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/42', base: { ref: 'staging' } }]);
    }, { now: () => 1_000 });

    const summary = { pullRequest: { number: 42, title: 'Voice input', status: 'open', url: 'https://github.com/octo/repo/pull/42', baseBranch: 'staging', checks: 'pending' }, fetchedAt: 1_000 };
    await expect(service.branch(octo, 'feature/voice', true, { wait: true })).resolves.toEqual(summary);
    await expect(service.branch(octo, 'feature/voice', true)).resolves.toEqual(summary);
    expect(requests).toHaveLength(3);
    // merged pull requests are found too
    expect(new URL(requests[0]!).searchParams.get('state')).toBe('all');
    expect(requests[0]).toContain('head=octo%3Afeature%2Fvoice');
  });

  it('answers at once while the first lookup runs, and with the summary after it', async () => {
    const service = github(async () => reply([
      { number: 40, title: 'Closed without merge', state: 'closed', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/40' },
      { number: 41, title: 'Merged work', state: 'closed', draft: false, merged_at: '2026-07-28T20:00:00Z', html_url: 'https://github.com/octo/repo/pull/41' }
    ]));

    await expect(service.branch(octo, 'feature/card', true)).resolves.toEqual({});
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(service.branch(octo, 'feature/card', true)).resolves.toMatchObject({ pullRequest: { number: 41, title: 'Merged work', status: 'merged', url: 'https://github.com/octo/repo/pull/41', checks: 'pending' } });
  });

  it('reports merge conflicts, failing checks, and unresolved current review threads', async () => {
    const sha = 'a'.repeat(40);
    const service = github(async (url) => {
      if (url.includes('/pulls?')) return reply([{ number: 77, title: 'Needs attention', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/77', head: { sha } }]);
      if (url.endsWith('/pulls/77')) return reply({ mergeable: false, mergeable_state: 'dirty' });
      if (url.includes('/check-runs')) return reply({ check_runs: [{ conclusion: 'failure' }, { conclusion: 'success' }] });
      if (url.endsWith('/status')) return reply({ state: 'success' });
      if (url.endsWith('/graphql')) return reply({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }, { isResolved: false, isOutdated: true }, { isResolved: true, isOutdated: false }] } } } } });
      return reply({}, 404);
    });

    await expect(service.branch(octo, 'feature/fixup', true, { wait: true })).resolves.toMatchObject({ pullRequest: {
      number: 77,
      checks: 'failed',
      issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true },
      unresolvedThreads: 1
    } });
  });

  it('refreshes a summary after sixty seconds', async () => {
    const sha = 'b'.repeat(40);
    let now = 0;
    let pending = true;
    const service = github(async (url) => {
      if (url.includes('/pulls?')) return reply([{ number: 78, title: 'CI state', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/78', head: { sha } }]);
      if (url.endsWith('/pulls/78')) return reply({ mergeable: true, mergeable_state: 'clean' });
      if (url.includes('/check-runs')) return reply({ check_runs: [{ status: pending ? 'in_progress' : 'completed', conclusion: pending ? null : 'success' }] });
      if (url.endsWith('/status')) return reply({ statuses: [{ state: 'success' }] });
      if (url.endsWith('/graphql')) return reply({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } } } } });
      return reply({}, 404);
    }, { now: () => now });

    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'pending', issues: { unresolvedComments: true } } });
    pending = false;
    now = 59_999;
    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'pending' }, fetchedAt: 0 });
    now = 60_000;
    await expect(service.branch(octo, 'feature/ci', true, { wait: true })).resolves.toMatchObject({ pullRequest: { checks: 'passed', issues: { unresolvedComments: true } }, fetchedAt: 60_000 });
  });

  it('does not expose an untrusted PR URL', async () => {
    const service = github(async () => reply([{ number: 42, title: 'Untrusted', state: 'open', draft: false, merged_at: null, html_url: 'https://example.com/pull/42' }]));
    await expect(service.branch(octo, 'feature', true, { wait: true })).resolves.toEqual({ fetchedAt: expect.any(Number) });
  });

  it('prefers a current draft over an older merged pull request for the branch', async () => {
    const service = github(async () => reply([
      { number: 12, title: 'Previous merge', state: 'closed', draft: false, merged_at: '2026-07-20T20:00:00Z', html_url: 'https://github.com/octo/repo/pull/12' },
      { number: 13, title: 'Current draft', state: 'open', draft: true, merged_at: null, html_url: 'https://github.com/octo/repo/pull/13' }
    ]));

    await expect(service.branch(octo, 'feature/draft', true, { wait: true })).resolves.toMatchObject({ pullRequest: { number: 13, title: 'Current draft', status: 'draft', url: 'https://github.com/octo/repo/pull/13', checks: 'pending' } });
  });

  it('keeps the last summary beside the problem when GitHub fails', async () => {
    let now = 0;
    let failing = false;
    const service = github(async (url) => {
      if (failing) return reply({ message: 'Server Error' }, 500);
      return url.includes('/pulls?') ? reply([{ number: 9, title: 'Retries', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/9' }]) : reply({}, 404);
    }, { now: () => now });

    await service.branch(octo, 'feature/retries', true, { wait: true });
    failing = true;
    now = 60_000;
    await expect(service.branch(octo, 'feature/retries', true, { wait: true })).resolves.toEqual({
      pullRequest: expect.objectContaining({ number: 9 }),
      fetchedAt: 0,
      problem: { kind: 'failing', message: 'GitHub could not look up the branch\'s pull request (500): Server Error' }
    });
  });

  it('refreshes the summaries of a pull request another writer changed', async () => {
    const lookups: string[] = [];
    const service = github(async (url) => {
      if (!url.includes('/pulls?')) return reply({}, 404);
      const branch = new URL(url).searchParams.get('head')!.split(':')[1]!;
      lookups.push(branch);
      const number = branch === 'feature/posted' ? 5 : 6;
      return reply([{ number, title: branch, state: 'open', draft: false, merged_at: null, html_url: `https://github.com/octo/repo/pull/${number}` }]);
    });
    await service.branch(octo, 'feature/posted', true, { wait: true });
    await service.branch(octo, 'feature/other', true, { wait: true });

    service.changed(octo, 5);
    await service.branch(octo, 'feature/posted', true, { wait: true });
    await service.branch(octo, 'feature/other', true, { wait: true });

    expect(lookups).toEqual(['feature/posted', 'feature/other', 'feature/posted']);
  });

  it('does not let a lookup that began before a change stand for the changed pull request', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let lookups = 0;
    let now = 0;
    const service = github(async (url) => {
      if (!url.includes('/pulls?')) return reply({}, 404);
      lookups += 1;
      if (lookups === 2) await held;
      return reply([{ number: 5, title: `Lookup ${lookups}`, state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/5' }]);
    }, { now: () => now });
    await service.branch(octo, 'feature/posted', true, { wait: true });

    now = 60_000;
    const stale = service.branch(octo, 'feature/posted', true, { wait: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    service.changed(octo, 5);
    release();
    await stale;

    await expect(service.branch(octo, 'feature/posted', true, { wait: true })).resolves.toMatchObject({ pullRequest: { title: 'Lookup 3' } });
  });
});

describe('a repository\'s open pull requests', () => {
  it('lists the viewer\'s own pull requests, with their status, apart from others\'', async () => {
    const sha = 'c'.repeat(40);
    const service = github(async (url) => {
      if (url.endsWith('/user')) return reply({ login: 'me' });
      if (url.endsWith('/pulls/7')) return reply({ mergeable: false, mergeable_state: 'dirty' });
      if (url.includes('/check-runs')) return reply({ check_runs: [{ status: 'completed', conclusion: 'failure' }] });
      if (url.endsWith('/status')) return reply({ statuses: [] });
      if (url.endsWith('/graphql')) return reply({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } } } } });
      return reply([
        { number: 7, title: 'Draft work', draft: true, html_url: 'https://github.com/octo/repo/pull/7', user: { login: 'me' }, head: { ref: 'feature/draft', sha, repo: { full_name: 'octo/repo' } } },
        { number: 8, title: 'Other user', draft: false, html_url: 'https://attacker@github.com/wrong/repo/pull/999', user: { login: 'someone-else' }, head: { ref: 'feature/other', sha: 'd'.repeat(40), repo: { full_name: 'contributor/repo' } } }
      ]);
    }, { now: () => 5 });

    await expect(service.repository(octo)).resolves.toEqual({
      own: [{ number: 7, title: 'Draft work', draft: true, url: 'https://github.com/octo/repo/pull/7', branch: 'feature/draft', headSha: sha, headOnOrigin: true, checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } }],
      others: [{ number: 8, title: 'Other user', draft: false, url: 'https://github.com/octo/repo/pull/8', branch: 'feature/other', headSha: 'd'.repeat(40), headOnOrigin: false }],
      fetchedAt: 5
    });
  });

  it('reports a failed viewer lookup as a problem and looks the viewer up again next time', async () => {
    let viewerRequests = 0;
    const service = github(async (url) => {
      // fail one complete retry cycle
      if (url.endsWith('/user') && ++viewerRequests <= 3) return reply({ message: 'GitHub is temporarily unavailable.' }, 503);
      if (url.endsWith('/user')) return reply({ login: 'me' });
      return reply([]);
    });

    await expect(service.repository(octo)).resolves.toEqual({ own: [], others: [], problem: { kind: 'failing', message: 'GitHub could not identify the authenticated user (503): GitHub is temporarily unavailable.' } });
    await expect(service.repository(octo)).resolves.toEqual({ own: [], others: [], fetchedAt: expect.any(Number) });
    expect(viewerRequests).toBe(4);
  });

  it('reports a missing token without asking GitHub', async () => {
    let requests = 0;
    const service = github(async () => { requests += 1; return reply([]); }, { token: async () => undefined });

    await expect(service.repository(octo)).resolves.toEqual({ own: [], others: [], problem: { kind: 'no-token', message: 'GitHub authentication is not configured for pull request lookup.' } });
    expect(requests).toBe(0);
  });

  it('keeps the last lists beside the problem when GitHub fails', async () => {
    let failing = false;
    const service = github(async (url) => {
      if (url.endsWith('/user')) return reply({ login: 'me' });
      if (failing) return reply({ message: 'Server Error' }, 502);
      return reply([{ number: 8, title: 'Other user', draft: false, user: { login: 'someone-else' }, head: { ref: 'feature/other', sha: 'd'.repeat(40), repo: { full_name: 'octo/repo' } } }]);
    }, { now: () => 7 });

    await service.repository(octo);
    failing = true;
    await expect(service.repository(octo)).resolves.toMatchObject({ others: [{ number: 8 }], fetchedAt: 7, problem: { kind: 'failing' } });
  });
});

describe('a pull request\'s detail', () => {
  const author = (login: string, typename = 'User') => ({ login, __typename: typename });
  const commentsPayload = { data: { repository: { pullRequest: {
    id: 'PR9', author: author('octocat'), body: 'Retry with backoff', createdAt: '2026-09-30T00:00:00Z', url: 'https://github.com/octo/repo/pull/9',
    reviewThreads: { nodes: [
      { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, startLine: 10, originalLine: 11, originalStartLine: 9, comments: { nodes: [
        { id: 'C1', author: author('mona'), body: 'Back off first', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r1', diffHunk: '@@ -1 +1 @@\n+retry' },
        { id: 'C2', author: null, body: 'Agreed', createdAt: '2026-10-01T01:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r2', diffHunk: '@@ -1 +1 @@\n+retry' }
      ] } },
      { id: 'T2', isResolved: false, isOutdated: true, path: 'src/b.ts', line: null, startLine: null, originalLine: 4, originalStartLine: 4, comments: { nodes: [
        { id: 'C3', author: author('mona'), body: 'Old', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r3', diffHunk: '@@ -4 +4 @@' }
      ] } },
      { id: 'T3', isResolved: true, isOutdated: false, path: 'src/c.ts', line: 1, comments: { nodes: [
        { id: 'C4', author: author('mona'), body: 'Untrusted', createdAt: '2026-10-01T00:00:00Z', url: 'https://evil.example/x', diffHunk: '' }
      ] } }
    ] },
    reviews: { nodes: [
      { id: 'R1', author: author('mona'), state: 'CHANGES_REQUESTED', body: 'See inline', submittedAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-1' },
      { id: 'R2', author: author('mona'), state: 'COMMENTED', body: '  ', submittedAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-2' },
      { id: 'R3', author: author('me'), state: 'PENDING', body: 'My draft', submittedAt: null, url: 'https://github.com/octo/repo/pull/9#pullrequestreview-3' }
    ] },
    comments: { nodes: [
      { id: 'I1', author: author('codecov', 'Bot'), body: 'Coverage 80%', createdAt: '2026-10-01T03:00:00Z', url: 'https://github.com/octo/repo/pull/9#issuecomment-1' }
    ] }
  } } } };
  const service = (token?: string) => github(async (url, init) => url.endsWith('/graphql') && String(init?.body).includes('reviews(') ? reply(commentsPayload) : reply({}, 404), { token: async () => token });

  it('reads threads, review summaries and conversation', async () => {
    const comments = await service('private-token').pullRequest(octo, 9);
    expect(comments.number).toBe(9);
    expect(comments.url).toBe('https://github.com/octo/repo/pull/9');
    expect(comments.description).toEqual({ id: 'PR9', author: 'octocat', bot: false, body: 'Retry with backoff', createdAt: '2026-09-30T00:00:00Z', url: 'https://github.com/octo/repo/pull/9' });
    expect(comments.threads).toEqual([
      { id: 'T1', path: 'src/a.ts', line: 12, startLine: 10, resolved: false, outdated: false, diffHunk: '@@ -1 +1 @@\n+retry', comments: [
        { id: 'C1', author: 'mona', bot: false, body: 'Back off first', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r1' },
        { id: 'C2', author: 'ghost', bot: false, body: 'Agreed', createdAt: '2026-10-01T01:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r2' }
      ] },
      { id: 'T2', path: 'src/b.ts', line: 4, resolved: false, outdated: true, diffHunk: '@@ -4 +4 @@', comments: [
        { id: 'C3', author: 'mona', bot: false, body: 'Old', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r3' }
      ] }
    ]);
    expect(comments.reviews).toEqual([{ id: 'R1', author: 'mona', bot: false, body: 'See inline', createdAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-1', state: 'CHANGES_REQUESTED' }]);
    expect(comments.comments).toEqual([{ id: 'I1', author: 'codecov', bot: true, body: 'Coverage 80%', createdAt: '2026-10-01T03:00:00Z', url: 'https://github.com/octo/repo/pull/9#issuecomment-1' }]);
  });

  it('refuses without a token', async () => {
    await expect(service().pullRequest(octo, 9)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('the shared GitHub client', () => {
  it('sends one request at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const service = github(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return reply([]);
    });

    await Promise.all([service.branch(octo, 'one', true, { wait: true }), service.branch(octo, 'two', true, { wait: true }), service.cleanupHead(octo, 'three', 'a'.repeat(40))]);
    expect(most).toBe(1);
  });

  it('holds every request back until a 429\'s retry-after has passed', async () => {
    let now = 1_000_000;
    let limited = true;
    let requests = 0;
    const service = github(async () => {
      requests += 1;
      return limited ? reply({ message: 'secondary rate limit' }, 429, { 'retry-after': '30' }) : reply([]);
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
    const service = github(async () => {
      requests += 1;
      return requests === 1 ? reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1100' }) : reply([]);
    }, { now: () => now });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_100_000 } });
    now = 1_099_999;
    await expect(service.cleanupHead(octo, 'two', 'a'.repeat(40))).resolves.toBeUndefined();
    expect(requests).toBe(1);
    now = 1_100_000;
    await expect(service.branch(octo, 'three', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_100_000 });
    expect(requests).toBe(2);
  });

  it('holds requests for a minute after a secondary rate limit that names no wait, and keeps the viewer', async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const service = github(async (url) => {
      sent.push(url);
      if (url.endsWith('/user')) return reply({ login: 'me' });
      return sent.length === 2 ? reply({ message: 'You have exceeded a secondary rate limit.' }, 403) : reply([]);
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

  it('does not hold back a new token behind a limit reached without one, nor past the hour', async () => {
    let now = 1_000_000;
    let token: string | undefined;
    const service = github(async (_url, init) => new Headers(init?.headers).has('Authorization')
      ? reply([])
      : reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '999999999' }), { now: () => now, token: async () => token });

    await expect(service.branch(octo, 'one', true, { wait: true })).resolves.toMatchObject({ problem: { kind: 'rate-limited', until: 1_000_000 + 3_600_000 } });
    token = 'fresh-login';
    await expect(service.branch(octo, 'two', true, { wait: true })).resolves.toEqual({ fetchedAt: 1_000_000 });
  });

  it('doubles the refresh interval while a budget is below 20%, until the budget resets', async () => {
    let now = 0;
    const lookups: string[] = [];
    const service = github(async (url) => {
      const branch = new URL(url).searchParams.get('head')!.split(':')[1]!;
      lookups.push(branch);
      // only the first answer reports a budget: low, and reset at 50s
      return reply([], 200, branch === 'low' ? { 'x-ratelimit-remaining': '999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '50' } : {});
    }, { now: () => now });

    await service.branch(octo, 'low', true, { wait: true });
    now = 60_000;
    await service.branch(octo, 'low', true, { wait: true });
    expect(lookups).toEqual(['low']);
    // read after the reset, so the usual minute applies again
    await service.branch(octo, 'after', true, { wait: true });
    now = 120_000;
    await service.branch(octo, 'low', true, { wait: true });
    await service.branch(octo, 'after', true, { wait: true });
    expect(lookups).toEqual(['low', 'after', 'low', 'after']);
  });

  it('keeps the usual interval at 20% remaining', async () => {
    let now = 0;
    let requests = 0;
    const service = github(async () => {
      requests += 1;
      return reply([], 200, { 'x-ratelimit-remaining': '1000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '3600' });
    }, { now: () => now });

    await service.branch(octo, 'feature', true, { wait: true });
    now = 60_000;
    await service.branch(octo, 'feature', true, { wait: true });
    expect(requests).toBe(2);
  });
});
