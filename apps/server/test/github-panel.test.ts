import { describe, expect, it } from 'vitest';
import type { GithubPanel, OverviewItem } from '../src/github/service.js';
import { testWorktree } from './helpers/config.js';
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
