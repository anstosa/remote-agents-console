import { describe, expect, it } from 'vitest';
import type { GithubPanel, OverviewItem } from '../src/github/service.js';
import { testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub, polled, reply, sha } from './helpers/github-graphql.js';

const repo = { owner: 'octo', name: 'repo' };
// a group's rows as number and title
const rows = (panel: GithubPanel, group: Exclude<keyof GithubPanel, 'fetchedAt' | 'problem'>) => panel[group].map(item => item.number);

describe('the GitHub panel\'s lists', () => {
  it('groups one repository\'s Pull requests and Issues by how they relate to me, each row labelled with the Worktree holding it', async () => {
    const worktrees = [
      testWorktree({ id: 'main', projectId: 'octo-repo', label: 'repo', path: '/src/octo/repo', branch: 'main', main: true }),
      testWorktree({ id: 'feature', projectId: 'octo-repo', label: 'feature-wt', path: '/src/octo/repo-feature', branch: 'feature', main: false }),
      testWorktree({ id: 'shipped', projectId: 'octo-repo', label: 'shipped-wt', path: '/src/octo/repo-shipped', branch: 'shipped', main: false }),
      testWorktree({ id: 'abandoned', projectId: 'octo-repo', label: 'abandoned-wt', path: '/src/octo/repo-abandoned', branch: 'abandoned', main: false }),
      // another Project's checkout of a branch by the same name is not this repository's
      testWorktree({ id: 'elsewhere', projectId: 'acme-web', label: 'elsewhere-wt', path: '/src/acme/web-shipped', branch: 'shipped', main: false })
    ];
    const { service } = polled({
      'octo/repo': {
        pulls: [
          { number: 1, branch: 'feature', title: 'Mine', mine: true, checks: 'FAILURE', updatedAt: '2026-10-30T11:00:00Z' },
          { number: 2, branch: 'theirs', title: 'Review me', author: 'sam', requested: true, viewerRequest: 'request-2' },
          { number: 3, branch: 'other', title: 'Someone else\'s', author: 'kai', draft: true, updatedAt: '2026-10-29T08:00:00Z' },
          { number: 4, branch: 'shipped', title: 'Shipped', mine: true, state: 'MERGED', sha: sha('b') },
          { number: 5, branch: 'abandoned', title: 'Abandoned', mine: true, state: 'CLOSED', sha: sha('c') },
          // reopened as a new pull request and closed: the merge still stands for the branch
          { number: 8, branch: 'shipped', title: 'Shipped again', mine: true, state: 'CLOSED', sha: sha('d') },
          // merged with no Worktree left
          { number: 6, branch: 'gone', title: 'Gone', mine: true, state: 'MERGED' }
        ],
        issues: [{ number: 10, title: 'Assigned', author: 'lee', assigned: true, labels: ['bug'] }, { number: 11, title: 'Backlog', author: 'jo', updatedAt: '2026-10-28T08:00:00Z' }]
      },
      'acme/web': { pulls: [{ number: 7, branch: 'fix', title: 'Elsewhere', mine: true }], issues: [{ number: 12, title: 'Elsewhere', assigned: true }] }
    }, { worktrees: () => worktrees });
    // discovery reads each Worktree's branch, which keeps it in the poll
    for (const branch of ['main', 'feature', 'shipped', 'abandoned']) await service.branch(repo, branch, true, { wait: true });

    const panel = await service.panel(repo);
    expect([rows(panel, 'mine'), rows(panel, 'reviews'), rows(panel, 'other'), rows(panel, 'done'), rows(panel, 'assigned'), rows(panel, 'issues')]).toEqual([[1], [2], [3], [4, 5], [10], [11]]);
    // Mine and Review requested are the Overview's rows, reasons and all
    const overview = await service.overview();
    expect(panel.mine).toEqual([{ ...overview.mine[0], destination: { kind: 'worktree', worktreeId: 'feature', label: 'feature-wt' } }]);
    expect(panel.mine[0]).toMatchObject({ reasons: [{ kind: 'checks' }], checks: 'failed', unseen: [expect.stringContaining('octo/repo#1:checks:')] });
    // a row is labelled only with a Worktree holding it, not the Project's main worktree the Overview would open
    const unplaced = ({ destination, ...item }: OverviewItem) => { expect(destination).toMatchObject({ kind: 'project', worktreeId: 'main' }); return item; };
    expect(panel.reviews).toEqual(overview.reviews.map(unplaced));
    expect(panel.assigned).toEqual(overview.issues.filter(issue => issue.number === 10).map(unplaced));
    // the rest come from the repository's own lists
    expect(panel.other).toEqual([{ repository: 'octo/repo', number: 3, title: 'Someone else\'s', url: 'https://github.com/octo/repo/pull/3', author: 'kai', updatedAt: '2026-10-29T08:00:00Z', draft: true, reasons: [] }]);
    expect(panel.done).toMatchObject([
      { number: 4, state: 'merged', reasons: [], destination: { kind: 'worktree', worktreeId: 'shipped', label: 'shipped-wt' } },
      { number: 5, state: 'closed', reasons: [], destination: { kind: 'worktree', worktreeId: 'abandoned', label: 'abandoned-wt' } }
    ]);
    expect(panel.issues).toEqual([{ repository: 'octo/repo', number: 11, title: 'Backlog', url: 'https://github.com/octo/repo/issues/11', author: 'jo', updatedAt: '2026-10-28T08:00:00Z', reasons: [] }]);
    expect(panel.fetchedAt).toBe(0);
  });

  it('sends an Issue to the Worktree the console recorded it for, in the Overview, the panel and its detail', async () => {
    const worktrees = [
      testWorktree({ id: 'main', projectId: 'octo-repo', label: 'repo', path: '/src/octo/repo', branch: 'main', main: true }),
      testWorktree({ id: 'assigned', projectId: 'octo-repo', label: '10-assigned', path: '/src/octo/repo-10', branch: '10-assigned', main: false, issue: 10 }),
      testWorktree({ id: 'backlog', projectId: 'octo-repo', label: '11-backlog', path: '/src/octo/repo-11', branch: '11-backlog', main: false, issue: 11 }),
      // holds a pull request that closes Issue 13
      testWorktree({ id: 'closer', projectId: 'octo-repo', label: 'closer-wt', path: '/src/octo/repo-closer', branch: 'closer', main: false }),
      // another Project's record of the same number is not this repository's Issue
      testWorktree({ id: 'elsewhere', projectId: 'acme-web', label: '12-elsewhere', path: '/src/acme/web-12', branch: '12-elsewhere', main: false, issue: 12 })
    ];
    const { service } = polled({
      'octo/repo': {
        pulls: [{ number: 20, branch: 'closer', title: 'Close it', author: 'kai', closes: [13] }],
        issues: [{ number: 10, title: 'Assigned', assigned: true }, { number: 11, title: 'Backlog' }, { number: 12, title: 'Unstarted' }, { number: 13, title: 'Being closed' }]
      },
      'acme/web': {}
    }, { worktrees: () => worktrees });
    const assigned = { kind: 'worktree', worktreeId: 'assigned', label: '10-assigned' };
    const backlog = { kind: 'worktree', worktreeId: 'backlog', label: '11-backlog' };
    expect((await service.overview()).issues.map(item => item.destination)).toEqual([assigned]);
    const panel = await service.panel(repo);
    expect(panel.assigned.map(item => item.destination)).toEqual([assigned]);
    // an Issue an open pull request closes goes to the Worktree holding that pull request
    expect(panel.issues.map(item => [item.number, item.destination])).toEqual([[11, backlog], [12, undefined], [13, { kind: 'worktree', worktreeId: 'closer', label: 'closer-wt' }]]);
    expect((await service.issueDetail(repo, 11)).issue?.destination).toEqual(backlog);
    expect((await service.issueDetail(repo, 12)).issue).not.toHaveProperty('destination');
  });

  it('finds the Worktree holding an item in any Project of the repository, the asking Project\'s main worktree else', async () => {
    // two Projects are checkouts of octo/repo; the second holds the pull request's branch
    const projects = [testProject({ id: 'first', label: 'first', path: '/src/octo/repo' }), testProject({ id: 'second', label: 'second', path: '/src/octo/repo' })];
    const worktrees = [
      testWorktree({ id: 'first-main', projectId: 'first', label: 'first', path: '/src/octo/repo', branch: 'main', main: true }),
      testWorktree({ id: 'second-main', projectId: 'second', label: 'second', path: '/src/octo/repo-2', branch: 'main', main: true }),
      testWorktree({ id: 'feature', projectId: 'second', label: 'feature-wt', path: '/src/octo/repo-2-feature', branch: 'feature', main: false })
    ];
    const { service } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }], issues: [{ number: 10, title: 'Assigned', assigned: true }] } }, { projects: () => projects, worktrees: () => worktrees });
    expect((await service.panel(repo, { project: 'first' })).mine).toMatchObject([{ number: 1, destination: { worktreeId: 'feature' } }]);
    expect((await service.pullRequestDetail(repo, 1, { project: 'first' })).pullRequest?.destination).toMatchObject({ worktreeId: 'feature' });
    const overview = await service.overview();
    expect(overview.mine[0]?.destination).toMatchObject({ kind: 'worktree', worktreeId: 'feature' });
    expect(overview.issues[0]?.destination).toMatchObject({ kind: 'project', worktreeId: 'first-main' });
    // a clone in each Project holds it: the asking Project's
    worktrees.push(testWorktree({ id: 'feature-first', projectId: 'first', label: 'feature-wt', path: '/src/octo/repo-feature', branch: 'feature', main: false }));
    expect((await service.panel(repo, { project: 'first' })).mine[0]?.destination).toMatchObject({ worktreeId: 'feature-first' });
    expect((await service.panel(repo, { project: 'second' })).mine[0]?.destination).toMatchObject({ worktreeId: 'feature' });
    expect((await service.issueDetail(repo, 10, { project: 'second' })).issue?.destination).toBeUndefined();
  });

  it('reads the repository and the searches again on Refresh', async () => {
    let title = 'Mine';
    const { service, calls, searches, clock } = polled(() => ({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', title, mine: true }, { number: 2, branch: 'other', title: `Other ${title}` }] } }));
    const first = await service.panel(repo);
    expect([first.mine[0]?.title, first.other[0]?.title]).toEqual(['Mine', 'Other Mine']);
    expect([calls.length, searches.length]).toEqual([1, 1]);

    title = 'Renamed';
    // within ten seconds a Refresh answers from the last read
    clock.now = 5_000;
    await service.panel(repo, { fresh: true });
    expect([calls.length, searches.length]).toEqual([1, 1]);
    clock.now = 10_000;
    const refreshed = await service.panel(repo, { fresh: true });
    expect([refreshed.mine[0]?.title, refreshed.other[0]?.title, refreshed.fetchedAt]).toEqual(['Renamed', 'Other Renamed', 10_000]);
    expect([calls.length, searches.length]).toEqual([2, 2]);
  });

  it('keeps the last lists beside a problem when GitHub fails', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }], issues: [{ number: 3, title: 'Bug' }] } });
    let failing = false;
    const { service, clock } = polled({}, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 502) : await scripted.request(url, init) });
    await service.panel(repo);
    failing = true;
    clock.now = 60_000;
    const stale = await service.panel(repo, { fresh: true });
    expect(stale).toMatchObject({ mine: [{ number: 1 }], issues: [{ number: 3 }], fetchedAt: 0, problem: { kind: 'failing' } });
  });

  it('shows the searches\' problem, and their age, beside a repository read that worked', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }, { number: 2, branch: 'other' }] } });
    let searchesFail = false;
    const { service, clock } = polled({}, { request: async (url, init) => searchesFail && String(init?.body).includes('search(') ? reply({ message: 'Server Error' }, 502) : await scripted.request(url, init) });
    await service.panel(repo);
    searchesFail = true;
    clock.now = 60_000;
    const panel = await service.panel(repo, { fresh: true });
    // Mine is the Overview's, as last read
    expect(panel).toMatchObject({ mine: [{ number: 1 }], other: [{ number: 2 }], fetchedAt: 0, problem: { kind: 'failing' } });
  });

  it('finds the Overview\'s rows for a repository whatever GitHub\'s casing of its name', async () => {
    const { service } = polled({ 'Octo/Repo': { pulls: [{ number: 1, branch: 'feature', mine: true }, { number: 2, branch: 'theirs', requested: true }], issues: [{ number: 3, title: 'Bug', assigned: true }] } });
    const panel = await service.panel(repo);
    expect([panel.mine.map(item => item.number), panel.reviews.map(item => item.number), panel.assigned.map(item => item.number)]).toEqual([[1], [2], [3]]);
  });

  it('reports no token, with nothing listed', async () => {
    const { service, calls } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }] } }, { token: async () => undefined });
    expect(await service.panel(repo)).toEqual({ mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], problem: { kind: 'no-token', message: expect.any(String) } });
    expect(calls).toHaveLength(0);
  });
});
