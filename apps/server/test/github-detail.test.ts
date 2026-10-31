import { describe, expect, it } from 'vitest';
import { testWorktree } from './helpers/config.js';
import { graphqlGithub, polled, reply, sha, type GraphqlCall, type World } from './helpers/github-graphql.js';

const repo = { owner: 'octo', name: 'repo' };
const author = (login: string, typename = 'User') => ({ login, __typename: typename });
const isDetail = (call: GraphqlCall) => call.query.startsWith('query PullRequestDetail');
const isIssue = (call: GraphqlCall) => call.query.startsWith('query IssueDetail');

// one pull request as GitHub answers the detail read, with everything it can hold
const detailPayload = { data: { repository: { pullRequest: {
  id: 'PR9', number: 9, title: 'Retry with backoff', url: 'https://github.com/octo/repo/pull/9', state: 'OPEN', isDraft: false,
  author: author('octocat'), viewerDidAuthor: true, body: 'Retries failed reads.', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-10-01T04:00:00Z',
  baseRefName: 'main', headRefName: 'retries', headRefOid: sha('a'), isCrossRepository: false, mergeable: 'CONFLICTING',
  statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/octo/repo/actions/runs/1/job/1' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/octo/repo/actions/runs/1/job/2' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
    { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: 'javascript:alert(1)' },
    { __typename: 'StatusContext', context: 'ci/external', state: 'ERROR', targetUrl: 'https://ci.example.com/build/7' }
  ] } },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'kai' } }, { requestedReviewer: { __typename: 'Team', slug: 'core' } }] },
  latestReviews: { nodes: [
    { author: author('mona'), state: 'CHANGES_REQUESTED', commit: { oid: sha('a') } },
    { author: author('kai'), state: 'APPROVED', commit: { oid: sha('b') } },
    { author: author('coderabbit', 'Bot'), state: 'COMMENTED', commit: { oid: sha('a') } },
    { author: author('octocat'), state: 'PENDING', commit: { oid: sha('a') } }
  ] },
  closingIssuesReferences: { nodes: [
    { number: 3, title: 'Reads fail on a flaky network', url: 'https://github.com/octo/repo/issues/3', state: 'OPEN', repository: { nameWithOwner: 'octo/repo' } },
    // another repository's Issue, which the panel could not open by number
    { number: 4, title: 'Elsewhere', url: 'https://github.com/acme/web/issues/4', state: 'OPEN', repository: { nameWithOwner: 'acme/web' } }
  ] },
  reviewThreads: { nodes: [
    { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, startLine: 10, originalLine: 11, originalStartLine: 9, comments: { nodes: [
      { id: 'C1', author: author('mona'), body: 'Back off first', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r1', diffHunk: '@@ -1 +1 @@\n+retry', viewerDidAuthor: false },
      { id: 'C2', author: author('octocat'), body: 'Done', createdAt: '2026-10-01T01:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r2', diffHunk: '@@ -1 +1 @@\n+retry', viewerDidAuthor: true },
      { id: 'C3', author: null, body: 'Agreed', createdAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r3', diffHunk: '@@ -1 +1 @@\n+retry', viewerDidAuthor: false }
    ] } },
    { id: 'T2', isResolved: false, isOutdated: true, path: 'src/b.ts', line: null, startLine: null, originalLine: 4, originalStartLine: 4, comments: { nodes: [
      { id: 'C4', author: author('coderabbit', 'Bot'), body: 'Old', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r4', diffHunk: '@@ -4 +4 @@', viewerDidAuthor: false }
    ] } },
    { id: 'T3', isResolved: true, isOutdated: false, path: 'src/c.ts', line: 1, comments: { nodes: [
      { id: 'C5', author: author('mona'), body: 'Untrusted', createdAt: '2026-10-01T00:00:00Z', url: 'https://evil.example/x', diffHunk: '' }
    ] } }
  ] },
  reviews: { nodes: [
    { id: 'R1', author: author('mona'), state: 'CHANGES_REQUESTED', body: 'See inline', submittedAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-1' },
    { id: 'R2', author: author('kai'), state: 'COMMENTED', body: '  ', submittedAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-2' },
    { id: 'R3', author: author('octocat'), state: 'PENDING', body: 'My draft', submittedAt: null, url: 'https://github.com/octo/repo/pull/9#pullrequestreview-3' }
  ] },
  comments: { nodes: [
    { id: 'I1', author: author('codecov', 'Bot'), body: 'Coverage 80%', createdAt: '2026-10-01T03:00:00Z', url: 'https://github.com/octo/repo/pull/9#issuecomment-1' }
  ] }
} } } };

describe('a pull request\'s detail', () => {
  it('reads everything the panel shows of one pull request, and the Worktree holding it', async () => {
    const worktrees = [testWorktree({ id: 'retries', projectId: 'octo-repo', label: 'retries-wt', path: '/src/octo/repo-retries', branch: 'retries', main: false })];
    const queries: string[] = [];
    const { service } = polled({}, { worktrees: () => worktrees, request: async (_url, init) => { queries.push(String(init?.body)); return reply(detailPayload); } });
    const { pullRequest, fetchedAt, problem } = await service.pullRequestDetail(repo, 9);
    expect([fetchedAt, problem]).toEqual([0, undefined]);
    // the read asks for everything the payload answers
    for (const field of ['statusCheckRollup{state}', 'statusCheckRollup{contexts', 'reviewRequests', 'latestReviews', 'closingIssuesReferences', 'repository{nameWithOwner}', 'reviewThreads(last:100)', 'comments(last:50)', 'diffHunk', 'viewerDidAuthor', 'reviews(last:100)', 'mergeable', 'isCrossRepository']) expect(queries[0]).toContain(field);
    expect(pullRequest).toMatchObject({
      id: 'PR9', repository: 'octo/repo', number: 9, title: 'Retry with backoff', url: 'https://github.com/octo/repo/pull/9', state: 'open', draft: false, author: 'octocat', mine: true,
      updatedAt: '2026-10-01T04:00:00Z', branch: 'retries', baseBranch: 'main', headSha: sha('a'), headOnOrigin: true, mergeable: 'conflicting', checks: 'failed',
      destination: { kind: 'worktree', worktreeId: 'retries', label: 'retries-wt' }
    });
    expect(pullRequest?.description).toEqual({ id: 'PR9', author: 'octocat', bot: false, mine: true, body: 'Retries failed reads.', createdAt: '2026-09-30T00:00:00Z', url: 'https://github.com/octo/repo/pull/9' });
    // each check with where to read it; a link that is not http(s) is dropped
    expect(pullRequest?.checkRuns).toEqual([
      { name: 'build', status: 'passed', url: 'https://github.com/octo/repo/actions/runs/1/job/1' },
      { name: 'test', status: 'failed', url: 'https://github.com/octo/repo/actions/runs/1/job/2' },
      { name: 'lint', status: 'pending' },
      { name: 'deploy', status: 'skipped' },
      { name: 'ci/external', status: 'failed', url: 'https://ci.example.com/build/7' }
    ]);
    // each reviewer's latest review, whether one is asked of them now, and whether commits landed
    // since; the viewer's unsent draft review is no review
    expect(pullRequest?.reviewers).toEqual([
      { login: 'mona', state: 'changes' },
      { login: 'kai', state: 'approved', requested: true, newCommits: true },
      { login: 'coderabbit', bot: true, state: 'commented' },
      { login: 'core', team: true, requested: true }
    ]);
    expect(pullRequest?.linkedIssues).toEqual([{ number: 3, title: 'Reads fail on a flaky network', url: 'https://github.com/octo/repo/issues/3', state: 'open' }]);
    expect(pullRequest?.threads).toEqual([
      { id: 'T1', path: 'src/a.ts', line: 12, startLine: 10, resolved: false, outdated: false, diffHunk: '@@ -1 +1 @@\n+retry', comments: [
        { id: 'C1', author: 'mona', bot: false, body: 'Back off first', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r1' },
        { id: 'C2', author: 'octocat', bot: false, mine: true, body: 'Done', createdAt: '2026-10-01T01:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r2' },
        // a deleted account is GitHub's ghost
        { id: 'C3', author: 'ghost', bot: false, body: 'Agreed', createdAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r3' }
      ] },
      { id: 'T2', path: 'src/b.ts', line: 4, resolved: false, outdated: true, diffHunk: '@@ -4 +4 @@', comments: [
        { id: 'C4', author: 'coderabbit', bot: true, body: 'Old', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/9#discussion_r4' }
      ] }
    ]);
    // a summary with no text is only its threads; a pending one is my unsent draft
    expect(pullRequest?.reviews).toEqual([{ id: 'R1', author: 'mona', bot: false, body: 'See inline', createdAt: '2026-10-01T02:00:00Z', url: 'https://github.com/octo/repo/pull/9#pullrequestreview-1', state: 'CHANGES_REQUESTED' }]);
    expect(pullRequest?.comments).toEqual([{ id: 'I1', author: 'codecov', bot: true, body: 'Coverage 80%', createdAt: '2026-10-01T03:00:00Z', url: 'https://github.com/octo/repo/pull/9#issuecomment-1' }]);
  });

  it('reuses the detail while a fresh list shows the pull request unchanged, and reads it again once it moves', async () => {
    const pull = { number: 1, branch: 'feature', mine: true, updatedAt: '2026-10-30T10:00:00Z', sha: sha('a'), checks: 'SUCCESS' as 'SUCCESS' | 'FAILURE' | 'PENDING', threads: [{ isResolved: false, isOutdated: false }] };
    const { service, calls, clock } = polled(() => ({ 'octo/repo': { pulls: [{ ...pull }] } }));
    const read = async (at: number) => {
      clock.now = at;
      await service.repository(repo, { wait: true });
      return (await service.pullRequestDetail(repo, 1)).fetchedAt;
    };
    expect(await read(0)).toBe(0);
    // the poll reads the list again a few minutes on: nothing moved
    expect(await read(300_000)).toBe(0);
    expect(calls.filter(isDetail)).toHaveLength(1);

    // checks settle and a thread is resolved without updatedAt moving; a push moves the head
    for (const [at, change] of [[400_000, { checks: 'FAILURE' as const }], [500_000, { threads: [{ isResolved: true, isOutdated: false }] }], [600_000, { sha: sha('b') }], [700_000, { updatedAt: '2026-10-30T11:00:00Z' }]] as const) {
      Object.assign(pull, change);
      expect(await read(at)).toBe(at);
    }
    expect(calls.filter(isDetail)).toHaveLength(5);

    // while checks run, each check may move with the list unchanged: kept only a minute
    pull.checks = 'PENDING';
    expect(await read(800_000)).toBe(800_000);
    expect(await read(830_000)).toBe(800_000);
    expect(await read(860_000)).toBe(860_000);
  });

  it('reuses a merged pull request\'s detail while the poll\'s branch lookup, which counts no threads, shows it unchanged', async () => {
    const { service, calls, timers, clock } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', state: 'MERGED', threads: [{ isResolved: false, isOutdated: false }] }] } });
    await service.branch(repo, 'feature', true);
    service.watch();
    await timers.fire();
    await service.pullRequestDetail(repo, 1);
    clock.now = 300_000;
    await timers.fire();
    expect((await service.pullRequestDetail(repo, 1)).fetchedAt).toBe(0);
    expect(calls.filter(isDetail)).toHaveLength(1);
  });

  it('does not trust a list read since the detail once that list is a minute old', async () => {
    const { service, calls, clock } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature' }] } });
    await service.pullRequestDetail(repo, 1);
    clock.now = 10_000;
    await service.repository(repo, { wait: true });
    // no browser keeps the poll going; a reader much later reads GitHub again
    clock.now = 200_000;
    expect((await service.pullRequestDetail(repo, 1)).fetchedAt).toBe(200_000);
    expect(calls.filter(isDetail)).toHaveLength(2);
  });

  it('reads a pull request in no list again once its detail is a minute old, and on Refresh after ten seconds', async () => {
    // someone else's repository, which no Project lists
    const { service, calls, clock } = polled({ 'acme/web': { pulls: [{ number: 7, branch: 'fix', author: 'kai' }] } });
    const acme = { owner: 'acme', name: 'web' };
    expect((await service.pullRequestDetail(acme, 7)).pullRequest).toMatchObject({ repository: 'acme/web', number: 7, author: 'kai', mine: false });
    clock.now = 5_000;
    await service.pullRequestDetail(acme, 7, { fresh: true });
    clock.now = 59_000;
    await service.pullRequestDetail(acme, 7);
    expect(calls.filter(isDetail)).toHaveLength(1);
    clock.now = 60_000;
    await service.pullRequestDetail(acme, 7);
    clock.now = 70_000;
    expect((await service.pullRequestDetail(acme, 7, { fresh: true })).fetchedAt).toBe(70_000);
    expect(calls.filter(isDetail)).toHaveLength(3);
    // the console's own write (Review tour posting) drops what was kept
    service.changed(acme, 7);
    await service.pullRequestDetail(acme, 7);
    expect(calls.filter(isDetail)).toHaveLength(4);
  });

  it('reads once for readers that ask together', async () => {
    const { service, calls } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature' }] } });
    await Promise.all([service.pullRequestDetail(repo, 1), service.pullRequestDetail(repo, 1)]);
    expect(calls.filter(isDetail)).toHaveLength(1);
  });

  it('keeps the last detail beside a problem, and says why there is none', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature' }] } });
    let failing = false;
    const { service, clock } = polled({}, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 502) : await scripted.request(url, init) });
    await service.pullRequestDetail(repo, 1);
    failing = true;
    clock.now = 60_000;
    expect(await service.pullRequestDetail(repo, 1)).toMatchObject({ pullRequest: { number: 1 }, fetchedAt: 0, problem: { kind: 'failing' } });
    failing = false;
    // the next read that works clears the problem
    clock.now = 120_000;
    expect(await service.pullRequestDetail(repo, 1)).toEqual({ pullRequest: expect.objectContaining({ number: 1 }), fetchedAt: 120_000 });
    clock.now = 60_000;
    // GitHub has no such pull request; asking again straight away does not ask GitHub again
    expect(await service.pullRequestDetail(repo, 2)).toEqual({ problem: { kind: 'failing', message: expect.stringContaining('could not read the pull request') } });
    const asked = scripted.calls.length;
    clock.now = 69_000;
    await service.pullRequestDetail(repo, 2);
    expect(scripted.calls).toHaveLength(asked);
    clock.now = 70_000;
    await service.pullRequestDetail(repo, 2);
    expect(scripted.calls).toHaveLength(asked + 1);

    // a failed read is tried again ten seconds on, even while a list since shows the pull request unchanged
    failing = true;
    clock.now = 180_000;
    expect((await service.pullRequestDetail(repo, 1)).problem).toMatchObject({ kind: 'failing' });
    failing = false;
    clock.now = 185_000;
    await service.repository(repo, { wait: true });
    clock.now = 190_000;
    expect(await service.pullRequestDetail(repo, 1)).toEqual({ pullRequest: expect.objectContaining({ number: 1 }), fetchedAt: 190_000 });

    const unauthenticated = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature' }] } }, { token: async () => undefined });
    expect(await unauthenticated.service.pullRequestDetail(repo, 1)).toEqual({ problem: { kind: 'no-token', message: expect.any(String) } });
    expect(unauthenticated.calls).toHaveLength(0);
  });
});

describe('an Issue\'s detail', () => {
  const world: World = {
    'octo/repo': {
      pulls: [{ number: 4, branch: 'fix-reads', title: 'Fix reads', mine: true }],
      issues: [{ number: 3, title: 'Reads fail', author: 'jo', labels: ['bug', 'network'], body: 'They time out.', linked: [{ number: 4, branch: 'fix-reads', title: 'Fix reads' }, { number: 8, branch: 'elsewhere', repository: 'acme/web' }] }]
    }
  };

  it('reads its header, labels, body and linked pull requests, and the Worktree holding one', async () => {
    const worktrees = [testWorktree({ id: 'fix', projectId: 'octo-repo', label: 'fix-wt', path: '/src/octo/repo-fix', branch: 'fix-reads', main: false })];
    const { service } = polled(world, { worktrees: () => worktrees });
    expect(await service.issueDetail(repo, 3)).toEqual({
      issue: {
        repository: 'octo/repo', number: 3, title: 'Reads fail', url: 'https://github.com/octo/repo/issues/3', state: 'open', author: 'jo', updatedAt: '2026-10-30T12:00:00Z',
        body: 'They time out.', labels: ['bug', 'network'],
        // only this repository's pull requests
        linkedPullRequests: [{ number: 4, title: 'Fix reads', url: 'https://github.com/octo/repo/pull/4', state: 'open', draft: false }],
        destination: { kind: 'worktree', worktreeId: 'fix', label: 'fix-wt' }
      },
      fetchedAt: 0
    });
  });

  it('reuses the detail while the repository\'s list shows the Issue unchanged', async () => {
    const issue = { number: 3, title: 'Reads fail', updatedAt: '2026-10-30T10:00:00Z' };
    const { service, calls, clock } = polled(() => ({ 'octo/repo': { issues: [{ ...issue }] } }));
    await service.repository(repo);
    await service.issueDetail(repo, 3);
    clock.now = 300_000;
    await service.repository(repo, { wait: true });
    await service.issueDetail(repo, 3);
    expect(calls.filter(isIssue)).toHaveLength(1);
    issue.updatedAt = '2026-10-30T11:00:00Z';
    clock.now = 400_000;
    await service.repository(repo, { wait: true });
    expect((await service.issueDetail(repo, 3)).fetchedAt).toBe(400_000);
    expect(calls.filter(isIssue)).toHaveLength(2);
  });
});
