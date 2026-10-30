import { describe, expect, it } from 'vitest';
import type { OverviewItem } from '../src/github/service.js';
import { testWorktree } from './helpers/config.js';
import { graphqlGithub, polled, reply, settled, sha } from './helpers/github-graphql.js';

describe('the Overview', () => {
  it('lists my pull requests, my Review requests and my assigned Issues across repositories, from the poll\'s searches', async () => {
    const { service, calls, searches, timers } = polled({
      'octo/repo': {
        pulls: [
          { number: 1, branch: 'feature/mine', title: 'Mine', mine: true },
          { number: 2, branch: 'feature/theirs', title: 'Please review', author: 'sam', requested: true },
          { number: 3, branch: 'feature/other', title: 'Someone else\'s' }
        ],
        issues: [{ number: 10, title: 'Assigned', author: 'lee', assigned: true }, { number: 11, title: 'Not mine' }]
      },
      'acme/web': { pulls: [{ number: 4, branch: 'fix', title: 'Elsewhere', mine: true }] }
    });
    service.watch();
    await timers.fire();

    // the searches travel apart from the Projects' lists, so neither stalls the other
    expect([calls.length, searches.length]).toEqual([1, 1]);
    expect(calls[0]!.query).toContain('r0:repository(');
    expect(calls[0]!.query).not.toContain('search(');
    expect(Object.values(searches[0]!.variables).filter(value => typeof value === 'string' && value.includes('@me'))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^is:pr is:open author:@me archived:false/u),
      expect.stringMatching(/^is:pr is:open review-requested:@me archived:false/u),
      expect.stringMatching(/^is:issue is:open assignee:@me archived:false/u)
    ]));
    const overview = await service.overview();
    expect(overview.mine.map(item => [item.repository, item.number, item.title])).toEqual([['octo/repo', 1, 'Mine'], ['acme/web', 4, 'Elsewhere']]);
    expect(overview.reviews).toMatchObject([{ repository: 'octo/repo', number: 2, author: 'sam', url: 'https://github.com/octo/repo/pull/2' }]);
    expect(overview.issues).toMatchObject([{ repository: 'octo/repo', number: 10, author: 'lee', url: 'https://github.com/octo/repo/issues/10' }]);
    expect(overview.fetchedAt).toBe(0);
    expect([calls.length, searches.length]).toEqual([1, 1]);
  });

  it('calls a Review request Waiting on me unless a draft, and flags it Re-requested after my review', async () => {
    const { service } = polled({ 'octo/repo': { pulls: [
      { number: 2, branch: 'first-look', requested: true, viewerRequest: 'request-2' },
      { number: 3, branch: 'again', requested: true, sha: sha('b'), viewerRequest: 'request-3', viewerReview: { state: 'COMMENTED', commit: sha('a') } },
      { number: 4, branch: 'wip', requested: true, draft: true, viewerRequest: 'request-4' },
      // my unsubmitted Draft review is not a review yet
      { number: 5, branch: 'pending', requested: true, sha: sha('b'), viewerRequest: 'request-5', viewerReview: { state: 'PENDING', commit: sha('a') } },
      // still listed (a team's request, or the search lagging my review) with no request of mine
      { number: 6, branch: 'team', requested: true, sha: sha('b'), viewerReview: { state: 'APPROVED', commit: sha('a') } }
    ] } });

    const { reviews } = await service.overview();
    expect(reviews.map(({ number, reasons, draft, newCommits }) => ({ number, reasons, draft, newCommits }))).toEqual([
      { number: 2, reasons: [{ kind: 'review' }], draft: undefined, newCommits: undefined },
      { number: 3, reasons: [{ kind: 'review', reRequested: true }], draft: undefined, newCommits: true },
      { number: 4, reasons: [], draft: true, newCommits: undefined },
      { number: 5, reasons: [{ kind: 'review' }], draft: undefined, newCommits: undefined },
      { number: 6, reasons: [{ kind: 'review' }], draft: undefined, newCommits: true }
    ]);
  });

  it('calls my pull request Waiting on me for a thread someone else spoke last on, failing checks, conflicts, or changes requested with no push since', async () => {
    const head = sha('b');
    const { service } = polled({ 'octo/repo': { pulls: [
      { number: 1, branch: 'threads', mine: true, closes: [12], threads: [
        { id: 't1', path: 'src/a.ts', isResolved: false, isOutdated: false, last: 'mira' },
        // a bot is someone else too
        { id: 't2', path: 'src/b.ts', isResolved: false, isOutdated: false, last: 'coderabbitai' },
        { id: 't3', isResolved: false, isOutdated: false, last: 'viewer' },
        { id: 't4', isResolved: true, isOutdated: false, last: 'mira' },
        { id: 't5', isResolved: false, isOutdated: true, last: 'mira' }
      ] },
      { number: 2, branch: 'red', mine: true, checks: 'FAILURE' },
      { number: 3, branch: 'running', mine: true, checks: 'PENDING' },
      { number: 4, branch: 'conflicted', mine: true, mergeable: 'CONFLICTING' },
      { number: 5, branch: 'asked', mine: true, sha: head, reviews: [{ id: 'r5', author: 'lee', state: 'CHANGES_REQUESTED', commit: head }] },
      { number: 6, branch: 'pushed-since', mine: true, sha: head, reviews: [{ author: 'lee', state: 'CHANGES_REQUESTED', commit: sha('a') }] },
      { number: 7, branch: 'draft', mine: true, draft: true, checks: 'FAILURE', mergeable: 'CONFLICTING', threads: [{ isResolved: false, isOutdated: false, last: 'mira' }] },
      { number: 8, branch: 'approved', mine: true, reviews: [{ author: 'kai', state: 'APPROVED', commit: sha('a') }] },
      // an approval stands beside changes requested on an older head, not beside current ones
      { number: 9, branch: 'approved-since', mine: true, sha: head, reviews: [{ author: 'kai', state: 'APPROVED', commit: head }, { author: 'lee', state: 'CHANGES_REQUESTED', commit: sha('a') }] },
      { number: 10, branch: 'split', mine: true, sha: head, reviews: [{ author: 'kai', state: 'APPROVED', commit: sha('a') }, { id: 'r10', author: 'lee', state: 'CHANGES_REQUESTED', commit: head }] }
    ] } });

    const { mine } = await service.overview();
    expect(Object.fromEntries(mine.map(item => [item.number, item.reasons]))).toEqual({
      1: [{ kind: 'thread', id: 't1', author: 'mira', path: 'src/a.ts' }, { kind: 'thread', id: 't2', author: 'coderabbitai', path: 'src/b.ts' }],
      2: [{ kind: 'checks' }],
      3: [],
      4: [{ kind: 'conflicts' }],
      5: [{ kind: 'changes', id: 'r5', author: 'lee' }],
      6: [],
      7: [],
      8: [],
      9: [],
      10: [{ kind: 'changes', id: 'r10', author: 'lee' }]
    });
    expect(mine.find(item => item.number === 1)).toMatchObject({ closes: [12], checks: 'passed' });
    expect(mine.find(item => item.number === 3)?.checks).toBe('pending');
    expect(mine.find(item => item.number === 7)?.draft).toBe(true);
    expect(mine.filter(item => item.approved).map(item => item.number)).toEqual([8, 9]);
  });

  it('lists Issues with their labels and linked pull requests, never Waiting on me', async () => {
    const { service } = polled({ 'octo/repo': { issues: [{ number: 10, title: 'Bug', assigned: true, labels: ['bug', 'p1'], linked: [{ number: 1, branch: 'fix' }] }] } });
    expect((await service.overview()).issues).toMatchObject([{ number: 10, reasons: [], labels: ['bug', 'p1'], linkedPullRequests: [1] }]);
  });

  it('sends a row to the Worktree holding it, else to its Project\'s main worktree, and nowhere for a repository with no Project', async () => {
    const worktrees = [
      testWorktree({ id: 'main', projectId: 'octo-repo', label: 'repo', path: '/src/octo/repo', branch: 'main', main: true }),
      testWorktree({ id: 'feature', projectId: 'octo-repo', label: 'feature-wt', path: '/w/feature', branch: 'feature', main: false }),
      testWorktree({ id: 'fork', projectId: 'octo-repo', label: 'pr-2', path: '/w/pr-2', branch: `rac/pr/2/${sha('c').slice(0, 12)}`, main: false }),
      // another Project's branch of the same name holds nothing in octo/repo
      testWorktree({ id: 'tools-feature', projectId: 'octo-tools', label: 'tools-feature', path: '/w/tools-feature', branch: 'feature', main: false }),
      testWorktree({ id: 'tools-main', projectId: 'octo-tools', label: 'tools', path: '/src/octo/tools', branch: 'main', main: true })
    ];
    const { service } = polled({
      'octo/repo': {
        pulls: [
          { number: 1, branch: 'feature', mine: true },
          { number: 2, branch: 'patch', head: 'contributor/repo', requested: true },
          // a fork's branch of the same name is not the local one
          { number: 3, branch: 'feature', head: 'contributor/repo', requested: true }
        ],
        issues: [{ number: 10, title: 'Linked', assigned: true, linked: [{ number: 1, branch: 'feature' }] }, { number: 11, title: 'Loose', assigned: true }]
      },
      'acme/web': { pulls: [{ number: 4, branch: 'feature', mine: true }] }
    }, { worktrees: () => worktrees, repositories: ['octo/tools', 'octo/repo'] });

    const overview = await service.overview();
    const where = (items: OverviewItem[]) => Object.fromEntries(items.map(item => [`${item.repository}#${item.number}`, item.destination]));
    expect({ ...where(overview.mine), ...where(overview.reviews), ...where(overview.issues) }).toEqual({
      'octo/repo#1': { kind: 'worktree', worktreeId: 'feature', label: 'feature-wt' },
      'octo/repo#2': { kind: 'worktree', worktreeId: 'fork', label: 'pr-2' },
      'octo/repo#3': { kind: 'project', worktreeId: 'main', label: 'repo' },
      'octo/repo#10': { kind: 'worktree', worktreeId: 'feature', label: 'feature-wt' },
      'octo/repo#11': { kind: 'project', worktreeId: 'main', label: 'repo' },
      'acme/web#4': undefined
    });
  });

  it('reads only the searches when nothing read them yet, answers at once after a minute while refreshing behind, and reads now on Refresh', async () => {
    let title = 'Before';
    const { service, calls, searches, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true, title }] } }));

    expect((await service.overview()).mine[0]?.title).toBe('Before');
    expect(searches).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(searches[0]!.query).not.toContain('repository(');
    await service.overview();
    expect(searches).toHaveLength(1);

    title = 'After';
    clock.now = 60_000;
    expect((await service.overview()).mine[0]?.title).toBe('Before');
    await settled();
    expect(searches).toHaveLength(2);
    expect((await service.overview()).mine[0]?.title).toBe('After');

    // Refresh reads again, but not within ten seconds of the last read
    title = 'Refreshed';
    expect((await service.overview({ fresh: true })).mine[0]?.title).toBe('After');
    expect(searches).toHaveLength(2);
    clock.now = 70_000;
    expect((await service.overview({ fresh: true })).mine[0]?.title).toBe('Refreshed');
    expect(searches).toHaveLength(3);
  });

  it('moves the revision when the lists change, and keeps the last lists beside a problem', async () => {
    let failing = false;
    let title = 'First';
    const scripted = graphqlGithub(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true, title }] } }));
    const { service, clock } = polled({}, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 500) : await scripted.request(url, init) });
    await service.overview();
    const first = service.revision;
    clock.now = 10_000;
    await service.overview({ fresh: true });
    expect(service.revision).toBe(first);
    title = 'Second';
    clock.now = 20_000;
    await service.overview({ fresh: true });
    expect(service.revision).toBeGreaterThan(first);

    failing = true;
    clock.now = 30_000;
    expect(await service.overview({ fresh: true })).toMatchObject({ mine: [{ title: 'Second' }], fetchedAt: 20_000, problem: { kind: 'failing' } });
  });

  it('reports a search GitHub withheld as a problem, not as an empty list', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true, requested: true }] } });
    let withhold = false;
    const { service, clock } = polled({}, { request: async (url, init) => {
      const response = await scripted.request(url, init);
      if (!withhold) return response;
      const { data } = await response.json() as { data: Record<string, unknown> };
      return reply({ data: { ...data, reviews: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' }] });
    } });
    await service.overview();
    withhold = true;
    clock.now = 60_000;
    expect(await service.overview({ fresh: true })).toMatchObject({ reviews: [{ number: 1 }], fetchedAt: 0, problem: { kind: 'failing', message: expect.stringContaining('SAML') } });
  });

  it('reports a missing token without asking GitHub', async () => {
    const { service, calls, searches } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }] } }, { token: async () => undefined });
    expect(await service.overview()).toMatchObject({ mine: [], reviews: [], issues: [], problem: { kind: 'no-token' } });
    expect([calls.length, searches.length]).toEqual([0, 0]);
  });
});
