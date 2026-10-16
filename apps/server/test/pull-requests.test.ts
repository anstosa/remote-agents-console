import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubToken, hostsToken } from '../src/pull-requests/github.js';
import { PullRequestService, githubRepository } from '../src/pull-requests/service.js';

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
});

describe('GitHub pull request lookup', () => {
  it('recognizes GitHub origin formats', () => {
    expect(githubRepository('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
    expect(githubRepository('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
    expect(githubRepository('https://example.com/octo/repo.git')).toBeUndefined();
  });

  it('builds the repository Actions URL only for GitHub origins', async () => {
    const github = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }));
    const other = new PullRequestService(async () => ({ code: 0, stdout: 'https://example.com/octo/repo.git\n' }));

    await expect(github.actionsUrl('/workspace')).resolves.toBe('https://github.com/octo/repo/actions');
    await expect(other.actionsUrl('/workspace')).resolves.toBeUndefined();
  });

  it('returns an open pull request URL and caches the request', async () => {
    const requests: string[] = [];
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url, init) => {
      requests.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer private-token');
      if (url.endsWith('/pulls/42')) return { ok: true, json: async () => ({ mergeable: true, mergeable_state: 'clean' }) };
      if (url.endsWith('/graphql')) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) };
      return { ok: true, json: async () => [{ number: 42, title: 'Voice input', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/42', base: { ref: 'staging' } }] };
    }, undefined, () => 'private-token');

    await expect(service.url('/workspace', 'feature/voice')).resolves.toBe('https://github.com/octo/repo/pull/42');
    await expect(service.url('/workspace', 'feature/voice')).resolves.toBe('https://github.com/octo/repo/pull/42');
    await expect(service.cachedPullRequest('/workspace', 'feature/voice')).resolves.toEqual({ number: 42, title: 'Voice input', status: 'open', url: 'https://github.com/octo/repo/pull/42', baseBranch: 'staging', checks: 'pending' });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain('head=octo%3Afeature%2Fvoice');
  });

  it('reports merge conflicts, failing checks, and unresolved current review threads', async () => {
    const sha = 'a'.repeat(40);
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url) => {
      if (url.includes('/pulls?')) return { ok: true, json: async () => [{ number: 77, title: 'Needs attention', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/77', head: { sha } }] };
      if (url.endsWith('/pulls/77')) return { ok: true, json: async () => ({ mergeable: false, mergeable_state: 'dirty' }) };
      if (url.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ conclusion: 'failure' }, { conclusion: 'success' }] }) };
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ state: 'success' }) };
      if (url.endsWith('/graphql')) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }, { isResolved: false, isOutdated: true }, { isResolved: true, isOutdated: false }] } } } } }) };
      return { ok: false, json: async () => ({}) };
    }, undefined, () => 'private-token');

    await service.url('/workspace', 'feature/fixup');
    await expect(service.cachedPullRequest('/workspace', 'feature/fixup')).resolves.toMatchObject({
      number: 77,
      checks: 'failed',
      issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true },
      unresolvedThreads: 1
    });
  });

  it('reports pending and successful CI independently from review comments', async () => {
    const sha = 'b'.repeat(40);
    let pending = true;
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url) => {
      if (url.includes('/pulls?')) return { ok: true, json: async () => [{ number: 78, title: 'CI state', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/78', head: { sha } }] };
      if (url.endsWith('/pulls/78')) return { ok: true, json: async () => ({ mergeable: true, mergeable_state: 'clean' }) };
      if (url.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ status: pending ? 'in_progress' : 'completed', conclusion: pending ? null : 'success' }] }) };
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ statuses: [{ state: 'success' }] }) };
      if (url.endsWith('/graphql')) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } } } } }) };
      return { ok: false, json: async () => ({}) };
    }, () => pending ? 0 : 61_000, () => 'private-token');

    await service.url('/workspace', 'feature/ci');
    await expect(service.cachedPullRequest('/workspace', 'feature/ci')).resolves.toMatchObject({ checks: 'pending', issues: { unresolvedComments: true } });
    pending = false;
    await service.url('/workspace', 'feature/ci');
    await expect(service.cachedPullRequest('/workspace', 'feature/ci')).resolves.toMatchObject({ checks: 'passed', issues: { unresolvedComments: true } });
  });

  it('does not expose an untrusted PR URL', async () => {
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async () => ({ ok: true, json: async () => [{ number: 42, title: 'Untrusted', state: 'open', draft: false, merged_at: null, html_url: 'https://example.com/pull/42' }] }));
    await expect(service.url('/workspace', 'feature')).resolves.toBeUndefined();
  });

  it('groups the current user’s open pull requests ahead of pull requests by others', async () => {
    const sha = 'c'.repeat(40);
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url) => {
      if (url.endsWith('/user')) return { ok: true, json: async () => ({ login: 'me' }) };
      if (url.endsWith('/pulls/7')) return { ok: true, json: async () => ({ mergeable: false, mergeable_state: 'dirty' }) };
      if (url.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ status: 'completed', conclusion: 'failure' }] }) };
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ statuses: [] }) };
      if (url.endsWith('/graphql')) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } } } } }) };
      return { ok: true, json: async () => [
        { number: 7, title: 'Draft work', draft: true, html_url: 'https://github.com/octo/repo/pull/7', user: { login: 'me' }, head: { ref: 'feature/draft', sha, repo: { full_name: 'octo/repo' } } },
        { number: 8, title: 'Other user', draft: false, html_url: 'https://attacker@github.com/wrong/repo/pull/999', user: { login: 'someone-else' }, head: { ref: 'feature/other', sha: 'd'.repeat(40), repo: { full_name: 'contributor/repo' } } }
      ] };
    }, undefined, () => 'private-token');

    await expect(service.open('/workspace')).resolves.toEqual({
      own: [{ number: 7, title: 'Draft work', draft: true, url: 'https://github.com/octo/repo/pull/7', branch: 'feature/draft', headSha: sha, headOnOrigin: true, checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } }],
      others: [{ number: 8, title: 'Other user', draft: false, url: 'https://github.com/octo/repo/pull/8', branch: 'feature/other', headSha: 'd'.repeat(40), headOnOrigin: false }]
    });
  });

  // preserve and recover from upstream failures
  it('reports repeated GitHub viewer failures and retries on the next lookup', async () => {
    let viewerRequests = 0;
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url) => {
      // fail one complete retry cycle
      if (url.endsWith('/user') && ++viewerRequests <= 3) return { ok: false, status: 503, json: async () => ({ message: 'GitHub is temporarily unavailable.' }) };
      // identify the viewer after recovery
      if (url.endsWith('/user')) return { ok: true, status: 200, json: async () => ({ login: 'me' }) };
      return { ok: true, status: 200, json: async () => [] };
    }, undefined, () => 'private-token');

    await expect(service.open('/workspace')).rejects.toMatchObject({
      statusCode: 502,
      message: 'GitHub could not identify the authenticated user (503): GitHub is temporarily unavailable.'
    });
    await expect(service.open('/workspace')).resolves.toEqual({ own: [], others: [] });
    expect(viewerRequests).toBe(4);
  });

  // recover after token rotation
  it('reloads credentials after GitHub rejects a cached token', async () => {
    let tokenRequests = 0;
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization;
      // reject the expired credential
      if (authorization === 'Bearer expired-token') return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) };
      // identify the recovered viewer
      if (url.endsWith('/user')) return { ok: true, status: 200, json: async () => ({ login: 'me' }) };
      return { ok: true, status: 200, json: async () => [] };
    }, undefined, async () => ++tokenRequests === 1 ? 'expired-token' : 'fresh-token');

    await expect(service.open('/workspace')).rejects.toMatchObject({
      statusCode: 502,
      githubStatus: 401,
      message: 'GitHub could not identify the authenticated user (401): Bad credentials'
    });
    await expect(service.open('/workspace')).resolves.toEqual({ own: [], others: [] });
    expect(tokenRequests).toBe(2);
  });

  it('caches rich draft, open, and merged pull request details for the dashboard', async () => {
    const requests: string[] = [];
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url) => {
      requests.push(url);
      return { ok: true, json: async () => [
        { number: 40, title: 'Closed without merge', state: 'closed', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/40' },
        { number: 41, title: 'Merged work', state: 'closed', draft: false, merged_at: '2026-07-28T20:00:00Z', html_url: 'https://github.com/octo/repo/pull/41' }
      ] };
    }, undefined, () => 'private-token');

    await expect(service.cachedPullRequest('/workspace', 'feature/card')).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(service.cachedPullRequest('/workspace', 'feature/card')).resolves.toEqual({ number: 41, title: 'Merged work', status: 'merged', url: 'https://github.com/octo/repo/pull/41', checks: 'pending' });
    expect(requests[0]).toContain('state=all');
  });

  it('prefers a current draft over an older merged pull request for the branch', async () => {
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async () => ({ ok: true, json: async () => [
      { number: 12, title: 'Previous merge', state: 'closed', draft: false, merged_at: '2026-07-20T20:00:00Z', html_url: 'https://github.com/octo/repo/pull/12' },
      { number: 13, title: 'Current draft', state: 'open', draft: true, merged_at: null, html_url: 'https://github.com/octo/repo/pull/13' }
    ] }), undefined, () => 'private-token');

    await service.url('/workspace', 'feature/draft');
    await expect(service.cachedPullRequest('/workspace', 'feature/draft')).resolves.toEqual({ number: 13, title: 'Current draft', status: 'draft', url: 'https://github.com/octo/repo/pull/13', checks: 'pending' });
  });

});

describe('GitHub pull request comments', () => {
  const openPull = [{ number: 9, title: 'Retries', state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/octo/repo/pull/9' }];
  const author = (login: string, typename = 'User') => ({ login, __typename: typename });
  const commentsPayload = { data: { repository: { pullRequest: {
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
  const service = (token: string | null = 'private-token', pulls: unknown[] = openPull) => new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url, init) => {
    if (url.includes('/pulls?')) return { ok: true, json: async () => pulls };
    if (url.endsWith('/graphql') && String(init?.body).includes('reviews(')) return { ok: true, json: async () => commentsPayload };
    return { ok: false, json: async () => ({}) };
  }, undefined, async () => token ?? undefined);

  it('reads threads, review summaries and conversation of the open pull request', async () => {
    const comments = await service().comments('/workspace', 'feature/retries');
    expect(comments.number).toBe(9);
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

  it('refuses a branch without an open pull request or a missing token', async () => {
    await expect(service('private-token', []).comments('/workspace', 'feature/none')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service('private-token', [{ ...openPull[0], state: 'closed', merged_at: '2026-10-01T00:00:00Z' }]).comments('/workspace', 'feature/merged')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service(null).comments('/workspace', 'feature/retries')).rejects.toMatchObject({ statusCode: 503 });
  });
});
