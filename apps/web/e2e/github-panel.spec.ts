import { expect, test, type Page } from '@playwright/test';

// The GitHub panel: the shared triage swimlanes filtered to the current repository by default,
// opened from the Workspace toolbar (the ⋮ on a phone) in a Place whose origin is on github.com.

const worktree = (projectId: string, id: string, label: string, branch: string, main: boolean, order: number) => ({ id, projectId, label, path: id.slice(id.indexOf(':') + 1), main, detached: false, locked: false, available: true, pinned: true, order, branch });
const dashboard = {
  generation: 1,
  serverStartedAt: 1001,
  githubRevision: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', github: 'octo/repo', available: true, worktrees: [worktree('repo', 'repo:/repo', 'Repo', 'main', true, 0), worktree('repo', 'repo:/repo/wts/feature', 'feature', 'feature', false, 1)] },
    // its origin is on another host
    { id: 'notes', label: 'Notes', available: true, worktrees: [worktree('notes', 'notes:/notes', 'Notes', 'main', true, 2)] }
  ]
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const feature = { kind: 'worktree', worktreeId: 'repo:/repo/wts/feature', label: 'feature' };
const pull = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, updatedAt: minutesAgo(10), reasons: [], ...extra });
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/issues/${number}`, author: 'jo', updatedAt: minutesAgo(60), reasons: [], ...extra });
const lists = {
  mine: [
    pull(214, 'Serve GitHub lists from one cached poll', { checks: 'passed', reasons: [{ kind: 'thread', id: 't1', author: 'mira', path: 'src/github/service.ts' }], unseen: ['octo/repo#214:thread:t1:c1'], closes: [201], destination: feature }),
    pull(230, 'Quiet work', { checks: 'pending' }),
    pull(231, 'Needs a rebase', { checks: 'passed', reasons: [{ kind: 'conflicts' }] })
  ],
  reviews: [pull(90, 'Handle redacted events', { author: 'kai', reasons: [{ kind: 'review', reRequested: true }], unseen: ['octo/repo#90:review:q'], newCommits: true })],
  // a test's stand-in for something new in a collapsed group
  other: [pull(205, 'Bump vite', { author: 'dependabot', draft: true, unseen: ['octo/repo#205:test'] })],
  done: [pull(203, 'Scheduled prompts', { state: 'merged', destination: { kind: 'worktree', worktreeId: 'repo:/repo/wts/shipped', label: 'shipped' } })],
  assigned: [issue(201, 'GitHub PR dashboard', { labels: ['feature'], linkedPullRequests: [214] }), issue(11, 'Launcher search ignores Notes')],
  issues: [],
  fetchedAt: Date.now() - 20_000
};
// adapt the rich repository catalog into the three triage lanes returned by Overview
const triage = (catalog: typeof lists) => ({
  mine: catalog.mine,
  reviews: catalog.reviews,
  issues: catalog.assigned,
  totals: { mine: catalog.mine.length, reviews: catalog.reviews.length, issues: catalog.assigned.length },
  ...(catalog.fetchedAt === undefined ? {} : { fetchedAt: catalog.fetchedAt }),
  ...('problem' in catalog ? { problem: catalog.problem } : {})
});

// one pull request's detail as the server gives it
const comment = (id: string, author: string, body: string, extra: Record<string, unknown> = {}) => ({ id, author, bot: false, body, createdAt: minutesAgo(30), url: `https://github.com/octo/repo/pull/214#${id}`, ...extra });
const pullDetail = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, state: 'open', draft: false, author: 'tony', mine: true, updatedAt: minutesAgo(10),
  branch: `branch-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40), headOnOrigin: true, mergeable: 'mergeable', checks: 'passed',
  threads: [], reviews: [], comments: [], checkRuns: [], reviewers: [], linkedIssues: [], ...extra
});
const details: Record<string, unknown> = {
  'pulls/214': { fetchedAt: Date.now(), pullRequest: pullDetail(214, 'Serve GitHub lists from one cached poll', {
    branch: 'feature', destination: feature, checks: 'failed',
    description: comment('d', 'tony', 'One poll for every list.', { mine: true }),
    threads: [
      { id: 't1', path: 'src/github/service.ts', line: 42, resolved: false, outdated: false, diffHunk: '@@ -40,3 +40,3 @@\n-  old()\n+  poll()', comments: [comment('c1', 'mira', 'Why one poll?'), comment('c2', 'tony', 'Budget.', { mine: true }), comment('c3', 'mira', 'Fair, but name it.')] },
      { id: 't2', path: 'src/github/github.ts', line: 7, resolved: false, outdated: false, diffHunk: '@@ -7 +7 @@\n+client', comments: [comment('c4', 'coderabbit', 'Consider a timeout.', { bot: true })] },
      { id: 't3', path: 'src/app.ts', line: 3, resolved: true, outdated: false, diffHunk: '', comments: [comment('c5', 'kai', 'Done.')] }
    ],
    checkRuns: [{ name: 'build', status: 'passed', url: 'https://github.com/octo/repo/actions/runs/1' }, { name: 'test', status: 'failed', url: 'https://github.com/octo/repo/actions/runs/2' }, { name: 'lint', status: 'pending' }],
    reviewers: [{ login: 'mira', id: 'U_mira', state: 'changes' }, { login: 'kai', id: 'U_kai', state: 'approved', newCommits: true }, { login: 'core', team: true, requested: true }],
    linkedIssues: [{ number: 201, title: 'GitHub PR dashboard', url: 'https://github.com/octo/repo/issues/201', state: 'open' }],
    reviews: [{ ...comment('r1', 'mira', 'A few notes inline.'), state: 'CHANGES_REQUESTED' }],
    comments: [comment('i1', 'codecov', 'Coverage 91%', { bot: true })]
  }) },
  'pulls/231': { fetchedAt: Date.now(), pullRequest: pullDetail(231, 'Needs a rebase', { mergeable: 'conflicting', draft: true }) },
  'pulls/90': { fetchedAt: Date.now(), pullRequest: pullDetail(90, 'Handle redacted events', { author: 'kai', mine: false, reviewers: [{ login: 'mira', id: 'U_mira', state: 'commented', newCommits: true }] }) },
  'issues/201': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 201, title: 'GitHub PR dashboard', url: 'https://github.com/octo/repo/issues/201', state: 'open', author: 'jo', updatedAt: minutesAgo(60), body: 'One place for every PR.', labels: ['feature'], linkedPullRequests: [{ number: 214, title: 'Serve GitHub lists from one cached poll', url: 'https://github.com/octo/repo/pull/214', state: 'open', draft: false }], destination: feature } },
  'issues/11': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 11, title: 'Launcher search ignores Notes', url: 'https://github.com/octo/repo/issues/11', state: 'open', author: 'jo', body: '', labels: [], linkedPullRequests: [] } }
};

// stub the console; `panels` answer each panel read in turn (the last repeats), each read's query
// lands in `reads` and each mark-seen report in `seen`; the dashboard reports `github.revision`;
// each detail read's path and query land in `detailReads`
async function mount(page: Page, panels: unknown[], reads: string[] = [], seen: string[][] = [], github = { revision: 1 }, detailReads: string[] = [], repositoryDetails: Record<string, unknown> = {}, dashboardResponse = dashboard, projectCatalog?: unknown) {
  let catalog: unknown = lists;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { ...dashboardResponse, githubRevision: github.revision } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') {
      reads.push(url.search);
      const next = panels.length > 1 ? panels.shift() : panels[0];
      // leave a pending route unanswered so the loading state remains observable
      if (next === 'pending') return undefined;
      catalog = next;
      return route.fulfill({ json: triage(next as typeof lists) });
    }
    if (path === '/api/github/overview/seen') {
      seen.push((route.request().postDataJSON() as { keys: string[] }).keys);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/projects/repo/github') {
      return route.fulfill({ json: projectCatalog === undefined ? catalog : projectCatalog });
    }
    const detail = /^\/api\/projects\/repo\/github\/((?:pulls|issues)\/\d+)$/u.exec(path)?.[1];
    if (detail !== undefined) {
      detailReads.push(`${detail}${url.search}`);
      return route.fulfill({ json: details[detail] ?? { problem: { kind: 'failing', message: 'GitHub could not read the pull request: Could not resolve to a PullRequest.' } } });
    }
    const repositoryDetail = /^\/api\/github\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+$/u.exec(path)?.[0];
    if (repositoryDetail !== undefined) {
      detailReads.push(`${repositoryDetail}${url.search}`);
      return route.fulfill({ json: repositoryDetails[repositoryDetail] ?? { problem: { kind: 'failing', message: 'GitHub could not read the item.' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });

test('lists one repository in the same three triage swimlanes without leaking catalog-only groups', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const seen: string[][] = [];
  await mount(page, [lists], reads, seen);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  // the toggle carries no count
  const toggle = toolbar(page).getByRole('button', { name: 'GitHub', exact: true });
  await expect(toggle).toHaveText('GitHub');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.locator('.panel-header-title')).toHaveText('GitHub · octo/repo');
  await expect(panel.getByText('updated just now')).toBeVisible();
  await expect(panel.locator('.overview-column')).toHaveCount(3);
  await expect(panel.locator('.overview-column-head h3')).toHaveText(['My pull requests', 'Review requests', 'Assigned issues']);
  await expect(panel.locator('.overview-column-head .overview-count')).toHaveText(['3', '1', '2']);
  const mine = panel.getByRole('region', { name: 'My pull requests' });
  await expect(mine.locator('.overview-row-number')).toHaveText(['#214', '#231', '#230']);
  await expect(mine.getByRole('button', { name: '#214 Serve GitHub lists from one cached poll, new, here, details' })).toBeVisible();
  await expect(mine).toContainText('@mira on service.ts');
  await expect(mine).toContainText('closes #201');

  const reviews = panel.getByRole('region', { name: 'Review requests' });
  await expect(reviews.locator('.overview-row')).toContainText(['@kai']);
  await expect(reviews).toContainText('Re-requestednew commits since your review');
  await expect(panel.getByRole('region', { name: 'Assigned issues' }).locator('.overview-row-number')).toHaveText(['#201', '#11']);
  await expect(panel).not.toContainText('Bump vite');
  await expect(panel).not.toContainText('Scheduled prompts');

  // the visible triage rows are reported seen
  await expect.poll(() => seen.flat().sort()).toEqual(['octo/repo#214:thread:t1:c1', 'octo/repo#90:review:q']);

  // a row is picked by tapping it; ↗ opens it on github.com
  await panel.getByRole('button', { name: /^#231 Needs a rebase/u }).click();
  await expect(panel.getByRole('button', { name: /^#231 Needs a rebase/u })).toHaveAttribute('aria-current', 'true');
  await expect(detail(page).getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/231');

  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => reads).toEqual(['', '?refresh=1']);
  await expect(panel.getByRole('button', { name: 'Expand GitHub' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close GitHub panel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('pins a Push and create PR card for a branch with no pull request, and nothing in the main worktree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const quiet = { ...lists, mine: lists.mine.slice(1) };
  await mount(page, [quiet]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.locator('.github-worktree-utility')).toContainText('featureNo pull request yet.');

  await page.getByRole('tab', { name: /^Repo/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toBeVisible();
  await expect(panel.locator('.github-worktree-utility')).toHaveCount(0);
});

test('pins an upstream pull request held in this fork worktree without an origin catalog entry', async ({ page }) => {
  const forkDashboard = {
    ...dashboard,
    projects: [{ ...dashboard.projects[0], label: 'Audiobookshelf', github: 'anstosa/audiobookshelf', githubForkOf: 'advplyr/audiobookshelf' }]
  };
  const heldParent = {
    repository: 'advplyr/audiobookshelf',
    number: 4978,
    title: 'Continue serial podcasts upstream',
    url: 'https://github.com/advplyr/audiobookshelf/pull/4978',
    updatedAt: minutesAgo(1),
    reasons: [],
    destination: feature
  };
  const overview = { ...lists, mine: [heldParent], reviews: [], assigned: [] };
  const emptyCatalog = { mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() };
  const detailReads: string[] = [];
  await mount(page, [overview], [], [], { revision: 1 }, detailReads, {}, forkDashboard, emptyCatalog);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();

  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  const utility = github.locator('.github-worktree-utility');
  const view = utility.getByRole('button', { name: 'View PR #4978 in this worktree' });
  await expect(view).toBeVisible();
  await expect(utility.getByRole('button', { name: 'Push and create PR…' })).toHaveCount(0);
  await expect(github.locator('.github-detail')).toHaveCount(0);

  // preserve the upstream identity when the pinned utility opens detail
  await view.click();
  await expect.poll(() => detailReads.map(value => decodeURIComponent(value))).toContain('pulls/4978?repository=advplyr/audiobookshelf');
  await expect(github.locator('.github-detail')).toBeVisible();
});

test('keeps a non-Git place browse-only and opens an unknown repository through repository detail', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:notes:/notes', 'open'));
  const foreign = { ...pull(1412, 'Debounce the search input'), repository: 'acme/web', url: 'https://github.com/acme/web/pull/1412' };
  const mixed = { ...lists, mine: [...lists.mine, foreign] };
  const detailReads: string[] = [];
  await mount(page, [mixed], [], [], { revision: 1 }, detailReads, {
    '/api/github/repos/acme/web/pulls/1412': { fetchedAt: Date.now(), pullRequest: pullDetail(1412, 'Debounce the search input', { repository: 'acme/web', url: foreign.url }) }
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^Notes/u }).click();
  await expect(toolbar(page).getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const scope = panel.getByRole('group', { name: 'GitHub scope' });
  await expect(scope.getByRole('button', { name: 'Repository' })).toBeDisabled();
  await expect(scope.getByRole('button', { name: 'All repos' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Checkout and actions for pull request #90' }).click();
  await expect(page.getByRole('group', { name: 'Actions for pull request #90' }).getByRole('button', { name: /^(?:Checkout|Move checkout) here/u })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const foreignRow = panel.locator('.overview-row').filter({ hasText: '#1412' });
  const foreignPrimary = foreignRow.getByRole('button', { name: /^#1412 Debounce the search input/u });
  const unavailable = foreignRow.locator('.github-card-controls').getByRole('button');
  await expect(unavailable).toBeDisabled();
  await expect(unavailable).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(unavailable.locator('.flyout-caret')).toHaveCount(0);
  await expect(foreignRow.locator('.github-card-controls').locator('button, a')).toHaveCount(2);
  await expect(foreignRow.locator('.github-card-controls').getByRole('link', { name: /^(?:Merge|Ready for review|Submit review)$/u })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Actions for pull request #1412' })).toHaveCount(0);
  await foreignPrimary.click();
  await expect(panel.getByRole('article', { name: 'Pull request #1412' }).getByRole('heading')).toHaveText('#1412Debounce the search input');
  expect(detailReads).toEqual(['/api/github/repos/acme/web/pulls/1412']);
});

test('opens a repo-scope issue in rich detail without leaving the owning Workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [lists]);
  await page.goto('/#overview');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const row = panel.getByRole('button', { name: /^#11 Launcher search ignores Notes/u });
  await row.click();
  await expect(page.getByRole('tab', { name: /^Repo/u })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('article', { name: 'Issue #11' })).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(toolbar(page).getByRole('button', { name: 'GitHub', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // picking another row changes the rich detail without changing scope
  await panel.getByRole('tab', { name: /^Reviews/u }).click();
  await panel.getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(panel.getByRole('article', { name: 'Pull request #90' })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('opens the pull-request identity selected from a swimlane, not a same-number issue', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // an Issue with the same number is not the one meant
  await mount(page, [{ ...lists, assigned: [...lists.assigned, issue(90, 'Same number, an Issue')] }]);
  await page.goto('/#overview');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(panel.getByRole('article', { name: 'Pull request #90' })).toBeVisible();
  await expect(panel.getByRole('article', { name: 'Issue #90' })).toHaveCount(0);

  // ordinary reopening defaults to repo scope in the same split
  await panel.getByRole('button', { name: 'Close GitHub panel' }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('defaults every explicit GitHub open to repo while All remains transient within the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rac.github-scope:repo:/repo', 'all'));
  await mount(page, [lists]);
  await page.goto('/');
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const scope = panel.getByRole('group', { name: 'GitHub scope' });
  await expect(scope.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.panel-header-title')).toHaveText('GitHub · octo/repo');
  await scope.getByRole('button', { name: 'All repos' }).click();
  await expect(scope.getByRole('button', { name: 'All repos' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.panel-header-title')).toHaveText('GitHub');
  await expect(scope.getByRole('button', { name: 'repo', exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Review requests' }).getByRole('button', { name: /^#90/u })).toBeVisible();
  await panel.getByRole('button', { name: 'Close GitHub panel' }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(scope.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('region', { name: 'Review requests' })).toBeVisible();
});

test('reads the lists again when the dashboard\'s GitHub revision moves', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const github = { revision: 1 };
  const renamed = { ...lists, mine: lists.mine.map(item => item.number === 230 ? { ...item, title: 'Quiet work, renamed' } : item) };
  await mount(page, [lists, renamed], reads, [], github);
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:repo:/repo/wts/feature', 'open'));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const changed = panel.getByRole('region', { name: 'My pull requests' }).getByText('#230Quiet work', { exact: true });
  await expect(changed).toBeVisible();
  github.revision = 2;
  // the dashboard is read again within a few seconds
  await expect(panel.getByText('#230Quiet work, renamed', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(reads).toEqual(['', '']);
});

test('refreshes upstream holders when a verified fork hint arrives without another dashboard revision', async ({ page }) => {
  test.setTimeout(60_000);
  const mutableProject = {
    ...dashboard.projects[0],
    label: 'Audiobookshelf',
    github: 'anstosa/audiobookshelf',
    githubForkOf: undefined as string | undefined
  };
  const mutableDashboard = { ...dashboard, projects: [mutableProject] };
  const upstream = {
    repository: 'advplyr/audiobookshelf',
    number: 4978,
    title: 'Continue serial podcasts upstream',
    url: 'https://github.com/advplyr/audiobookshelf/pull/4978',
    updatedAt: minutesAgo(1),
    reasons: []
  };
  const heldUpstream = { ...upstream, destination: feature };
  const beforeHint = { ...lists, mine: [upstream], reviews: [], assigned: [] };
  const afterHint = { ...beforeHint, mine: [heldUpstream] };
  const emptyCatalog = { mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() };
  const reads: string[] = [];
  const detailReads: string[] = [];
  await mount(page, [beforeHint, afterHint], reads, [], { revision: 1 }, detailReads, {}, mutableDashboard, emptyCatalog);
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:repo:/repo/wts/feature', 'open'));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();

  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  const utility = github.locator('.github-worktree-utility');
  await expect(utility.getByRole('button', { name: 'Push and create PR…' })).toBeVisible();
  await expect(github.getByRole('button', { name: /^#4978 Continue serial podcasts upstream/u })).toHaveCount(0);

  // change only verified repository metadata
  mutableProject.githubForkOf = 'advplyr/audiobookshelf';
  const view = utility.getByRole('button', { name: 'View PR #4978 in this worktree' });
  await expect(view).toBeVisible({ timeout: 20_000 });
  await expect(github.getByRole('button', { name: /^#4978 Continue serial podcasts upstream/u })).toContainText('here');
  expect(reads).toEqual(['', '']);

  // keep the newly verified parent identity on detail reads
  await view.click();
  await expect.poll(() => detailReads.map(value => decodeURIComponent(value))).toContain('pulls/4978?repository=advplyr/audiobookshelf');
});

test('opens from the ⋮ on a phone, only where the origin is on github.com', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, [lists]);
  // a phone's tabs are a sheet; a link picks the Workspace
  await page.goto('/#tab=feature');
  await expect(toolbar(page).getByRole('button', { name: 'More options' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toBeVisible();
  await expect(panel).toBeInViewport();
  // nothing in the panel runs off the side of the screen
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.evaluate(() => { location.hash = 'tab=Notes'; });
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
});

test('shows skeleton rows, the no-token card, and a stale banner with Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const stale = { ...lists, fetchedAt: Date.now() - 6 * 60_000, problem: { kind: 'failing', message: 'GitHub could not read pull requests (502).' } };
  const noToken = { mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], problem: { kind: 'no-token', message: 'GitHub authentication is not configured.' } };
  await mount(page, ['pending', stale, noToken], reads);
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:repo:/repo/wts/feature', 'open'));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('status', { name: 'Loading GitHub' })).toBeVisible();

  // the next read (another Workspace visit) lands on stale data
  await page.getByRole('tab', { name: /^Repo/u }).click();
  await page.getByRole('tab', { name: /^feature/u }).click();
  await expect(panel.locator('.overview-banner')).toHaveText('GitHub is unreachable. Showing what was fetched 6m ago.Retry');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('heading', { name: 'No GitHub token' })).toBeVisible();
  await expect(panel).toContainText('gh auth login');
  expect(reads.slice(-1)).toEqual(['?refresh=1']);
});

const detail = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true }).locator('.github-detail');

test('opens this Worktree\'s pull request from its swimlane beside the list, in full', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const detailReads: string[] = [];
  await mount(page, [lists], [], [], { revision: 1 }, detailReads);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
  const pull = detail(page);
  await expect(pull.getByRole('heading')).toHaveText('#214Serve GitHub lists from one cached poll');
  await expect(panel.getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u })).toHaveAttribute('aria-current', 'true');
  await expect(pull.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214');
  await expect(pull.locator('.github-detail-meta')).toHaveText(/^open@tonyfeature → mainupdated 10m ago$/u);
  await expect(pull.locator('.overview-chips').first()).toHaveText('@mira on service.ts');
  await expect(pull.locator('.github-strip > span')).toHaveText('Checked out here, in feature.');
  await expect(pull.getByRole('link', { name: 'Merge' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214');
  // every section starts open
  for (const name of ['Review threads', 'Checks', 'Reviewers', 'Linked issues', 'Description', 'Review summaries', 'Conversation']) await expect(pull.getByRole('button', { name: new RegExp(`^${name}`, 'u') })).toHaveAttribute('aria-expanded', 'true');

  // unresolved, current threads by file, each with its hunk and who spoke last; bots like anyone else
  const threads = pull.getByRole('region', { name: 'Review threads' });
  await expect(threads.locator('.github-thread-file')).toHaveText(['src/github/github.ts', 'src/github/service.ts']);
  await expect(threads.locator('.github-thread-who')).toHaveText(['waiting on you · @coderabbit spoke last', 'waiting on you · @mira spoke last']);
  await expect(threads.getByRole('article', { name: 'Review thread on src/github/github.ts' }).locator('.github-bot')).toHaveText('bot');
  await expect(threads.locator('.github-hunk').last()).toContainText('+  poll()');
  await threads.getByRole('button', { name: 'Resolved 1' }).click();
  await expect(threads.locator('.github-thread-who')).toHaveText(['resolved', 'waiting on you · @coderabbit spoke last', 'waiting on you · @mira spoke last']);

  // checks failing first, each linking to its run
  const checks = pull.getByRole('region', { name: 'Checks' });
  await expect(checks.getByRole('button', { name: /^Checks/u })).toContainText('1 failing');
  await expect(checks.locator('.github-list-name')).toHaveText(['test', 'lint', 'build']);
  await expect(checks.getByRole('link', { name: /test/u })).toHaveAttribute('href', 'https://github.com/octo/repo/actions/runs/2');
  await expect(pull.getByRole('region', { name: 'Reviewers' }).locator('.github-list-row')).toHaveText(['@mirarequested changes', '@kaiapprovednew commits sinceRe-request', 'corereview pending']);
  await expect(pull.getByRole('region', { name: 'Description' })).toContainText('One poll for every list.');
  await expect(pull.getByRole('region', { name: 'Review summaries' })).toContainText('A few notes inline.');
  await expect(pull.getByRole('region', { name: 'Conversation' })).toContainText('@codecovbot');
  await pull.getByRole('button', { name: /^Description/u }).click();
  await expect(pull.getByRole('region', { name: 'Description' })).not.toContainText('One poll');

  // a Linked issue opens the Issue's detail, and its linked pull request leads back
  await pull.getByRole('region', { name: 'Linked issues' }).getByRole('button', { name: /#201 GitHub PR dashboard/u }).click();
  const issue = detail(page);
  await expect(issue.getByRole('heading')).toHaveText('#201GitHub PR dashboard');
  await expect(issue.locator('.overview-chip.label')).toHaveText(['feature']);
  await expect(issue.getByRole('region', { name: 'Description' })).toContainText('One place for every PR.');
  await expect(issue.locator('.github-strip')).toHaveText('Checked out here, in feature.');
  await expect(issue.getByRole('link', { name: 'Assign / label' })).toHaveAttribute('href', 'https://github.com/octo/repo/issues/201');
  await panel.getByRole('tab', { name: /^Issues/u }).click();
  await expect(panel.getByRole('button', { name: /^#201 GitHub PR dashboard/u })).toHaveAttribute('aria-current', 'true');
  await issue.getByRole('region', { name: 'Linked pull request' }).getByRole('button', { name: /#214/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#214Serve GitHub lists from one cached poll');

  // Refresh reads the shown detail again from GitHub
  expect(detailReads.filter(read => read.includes('refresh'))).toEqual([]);
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => detailReads.filter(read => read.includes('refresh'))).toEqual(['pulls/214?refresh=1']);
});

test('links out to GitHub for review and merge decisions, and points merge conflicts at the Worktree', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, [lists]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  // someone else's pull request, not checked out anywhere
  await panel.getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(detail(page).locator('.github-strip > span')).toHaveText('Not checked out.');
  await expect(detail(page).getByRole('link', { name: 'Submit review' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/90/files');
  await expect(detail(page).getByRole('link', { name: 'Merge' })).toHaveCount(0);
  // re-requesting a review is the author's
  await expect(detail(page).getByRole('region', { name: 'Reviewers' })).toContainText('new commits since');
  await expect(detail(page).getByRole('button', { name: /Re-request/u })).toHaveCount(0);
  // my draft, conflicting with its base
  await panel.getByRole('tab', { name: /^Mine/u }).click();
  await panel.getByRole('button', { name: /^#231 Needs a rebase/u }).click();
  await expect(detail(page).getByRole('link', { name: 'Ready for review' })).toBeVisible();
  await expect(detail(page).locator('.github-strip.conflict')).toHaveText('Merge conflicts with main. Check it out in a Worktree to rebase it.');
  // one GitHub cannot read says so
  await panel.getByRole('button', { name: /^#230 Quiet work/u }).click();
  await expect(detail(page).getByRole('heading', { name: 'Pull request #230 could not be read' })).toBeVisible();
});

test('goes to the Worktree holding a pull request, keeping the panel on it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, [lists]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^Repo/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  // the main worktree opens on the three cards without selecting a detail
  await expect(panel.locator('.overview-column')).toHaveCount(3);
  await expect(detail(page)).toHaveCount(0);
  await panel.getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
  await expect(detail(page).locator('.github-strip > span')).toHaveText('Checked out in feature.');
  await detail(page).getByRole('button', { name: 'View in feature' }).click();
  await expect(page.getByRole('tab', { name: /^feature/u })).toHaveAttribute('aria-selected', 'true');
  await expect(detail(page).locator('.github-strip > span')).toHaveText('Checked out here, in feature.');
  // navigation retains the exact item focus
  await expect(panel.locator('.overview-row.focus')).toHaveCount(1);
});

// whether anything in `selector` runs off its right side; a diff hunk scrolls on its own
const overflows = (page: Page, selector: string) => page.locator(selector).evaluate(element => element.scrollWidth > element.clientWidth);
// size the GitHub panel as a split column or a resize would
const sizePanel = (page: Page, width: number) => page.addStyleTag({ content: `.github-pane { width: ${width}px; }` });

test('fits a pull request\'s detail beside the list from a wide panel down to a narrow one', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const saved = structuredClone(details['pulls/214']);
  // a diff line and a branch name far wider than the detail
  const pull = (details['pulls/214'] as { pullRequest: { threads: { diffHunk: string }[]; branch: string } }).pullRequest;
  pull.threads[0]!.diffHunk = '@@ -40,3 +40,3 @@\n-  old()\n+  const result = await this.client.graphql<PullRequestReviewThreads>(query, { owner, name, number, after: cursor ?? null });';
  pull.branch = 'tgrosinger/serve-every-github-list-from-one-cached-poll';
  await mount(page, [lists]);
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: /^feature/u }).click();
    await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
    const panel = page.getByRole('region', { name: 'GitHub', exact: true });
    await panel.getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
    await expect(detail(page).getByRole('region', { name: 'Reviewers' })).toBeVisible();
    await expect(panel.locator('.github-pane-body')).toHaveClass(/split/u);
    expect(await overflows(page, '.github-detail-column')).toBe(false);

    // just wide enough for both: every detail wraps to the column, and the rows to theirs
    await sizePanel(page, 560);
    await expect(panel.locator('.github-pane-body')).toHaveClass(/split/u);
    for (const [tab, name] of [[/^Mine/u, /^#214 Serve/u], [/^Reviews/u, /^#90 Handle/u], [/^Mine/u, /^#231 Needs/u], [/^Issues/u, /^#201 GitHub/u]] as const) {
      await panel.getByRole('tab', { name: tab }).click();
      const primary = panel.getByRole('button', { name });
      const row = primary.locator('..');
      const controls = row.locator('.github-card-controls');
      const [rowBox, controlsBox, externalBox, controlBoxes] = await Promise.all([
        row.boundingBox(),
        controls.boundingBox(),
        controls.locator('.overview-row-browser').boundingBox(),
        controls.locator('button, a').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }))
      ]);
      expect(rowBox).not.toBeNull();
      expect(controlsBox).not.toBeNull();
      expect(externalBox).not.toBeNull();
      expect(Math.abs(externalBox!.x - controlBoxes[0]!.x)).toBeLessThanOrEqual(1);
      expect(externalBox!.y).toBeGreaterThan(controlBoxes[0]!.y);
      expect(Math.abs(controlsBox!.y - rowBox!.y)).toBeLessThanOrEqual(1);
      // retain standard square controls in one vertical column at the forced split width
      for (const [index, control] of controlBoxes.entries()) {
        expect(control.width).toBeCloseTo(41.6, 0);
        expect(control.height).toBeCloseTo(41.6, 0);
        expect(Math.abs(control.x - controlBoxes[0]!.x)).toBeLessThanOrEqual(1);
        // prevent split-button attachment
        if (index > 0) expect(control.y).toBeGreaterThanOrEqual(controlBoxes[index - 1]!.y + controlBoxes[index - 1]!.height);
      }
      await primary.click();
      await expect(detail(page).locator('.github-detail-meta')).toBeVisible();
      expect(await overflows(page, '.github-detail-column')).toBe(false);
      const listWidth = await page.locator('.github-list-column').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(listWidth.scrollWidth, `github list width for ${name}: client ${listWidth.clientWidth}, scroll ${listWidth.scrollWidth}`).toBeLessThanOrEqual(listWidth.clientWidth);
    }
  } finally { details['pulls/214'] = saved; }
});

test('drills down from the list in a panel too narrow for both, as on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen: string[][] = [];
  await mount(page, [lists], [], seen);
  await page.goto('/');
  await sizePanel(page, 480);
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  // the list opens without selecting this Worktree's pull request
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toBeVisible();
  await expect(panel.locator('.github-pane-body')).not.toHaveClass(/split/u);
  await expect(detail(page)).toHaveCount(0);
  await expect.poll(() => seen.flat().sort()).toEqual(['octo/repo#214:thread:t1:c1']);

  await panel.getByRole('button', { name: /^#231 Needs a rebase/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#231Needs a rebase');
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toHaveCount(0);
  expect(await overflows(page, '.github-pane-body')).toBe(false);
  await detail(page).getByRole('button', { name: '‹ Back to cards' }).click();
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toBeVisible();
  await expect(detail(page)).toHaveCount(0);

  // widened, the panel restores all three lanes without auto-selecting a pinned detail
  await sizePanel(page, 900);
  await expect(panel.locator('.overview-column')).toHaveCount(3);
  await expect(detail(page)).toHaveCount(0);
});

test('opens a triage row straight on its detail in a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen: string[][] = [];
  await mount(page, [lists], [], seen);
  await page.goto('/');
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await sizePanel(page, 480);
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('tab', { name: /^Reviews/u }).click();
  await panel.getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toHaveCount(0);
  await expect.poll(() => seen.flat()).toEqual(['octo/repo#90:review:q']);
});

test('drills down from the list on a phone, the open detail counting as shown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seen: string[][] = [];
  await mount(page, [lists], [], seen);
  // a triage tap opens straight on the item's detail
  await page.goto('/#overview');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('tab', { name: /^Reviews/u }).click();
  await panel.getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(panel.getByRole('region', { name: 'My pull requests' })).toHaveCount(0);
  await expect.poll(() => seen.flat()).toEqual(['octo/repo#90:review:q']);
  // nothing in the detail runs off the side of the screen
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await detail(page).getByRole('button', { name: '‹ Back to cards' }).click();
  const tabs = panel.locator('.overview-tabs');
  await expect(tabs).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await tabs.getByRole('tab', { name: /^Issues/u }).click();
  await panel.getByRole('button', { name: /^#11 Launcher search ignores Notes/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#11Launcher search ignores Notes');
});

// answer the panel's writes to pull request #214: each lands in `writes` as its path and body, and
// `answer` gives the reply
async function stubWrites(page: Page, writes: { path: string; body: unknown }[], answer: (path: string) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>) {
  await page.route('**/api/projects/repo/github/pulls/214/**', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const path = new URL(route.request().url()).pathname.replace('/api/projects/repo/github/pulls/214/', '');
    writes.push({ path, body: route.request().postDataJSON() });
    const { status, json } = await answer(path);
    return status === 204 ? route.fulfill({ status }) : route.fulfill({ status, json });
  });
}

test('replies to and resolves a Review thread, and re-requests a review, from the PR\'s detail', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const saved = structuredClone(details['pulls/214']);
  const writes: { path: string; body: unknown }[] = [];
  const detailReads: string[] = [];
  await mount(page, [lists], [], [], { revision: 1 }, detailReads);
  let refuse = false;
  // the re-request waits until the test lets it answer
  let answerRerequest = () => {};
  const rerequested = new Promise<void>(resolve => { answerRerequest = resolve; });
  // each write changes what the next detail read returns, as GitHub would
  await stubWrites(page, writes, async path => {
    const pull = (details['pulls/214'] as { pullRequest: { threads: { resolved: boolean; comments: unknown[] }[]; reviewers: { requested?: true }[] } }).pullRequest;
    if (refuse) return { status: 502, json: { error: 'GitHub could not resolve the thread: Must have push access to this repository.' } };
    if (path === 'threads/t1/reply') pull.threads[0]!.comments.push(comment('c9', 'tony', 'Renamed it.', { mine: true }));
    if (path === 'threads/t2/resolve') pull.threads[1]!.resolved = true;
    if (path === 'rerequest') {
      await rerequested;
      pull.reviewers[1]!.requested = true;
    }
    return path.endsWith('/reply') ? { status: 200, json: { id: 'c9', pending: false } } : { status: 204 };
  });
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: /^feature/u }).click();
    await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
    await page.getByRole('region', { name: 'GitHub', exact: true }).getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
    const threads = detail(page).getByRole('region', { name: 'Review threads' });
    const thread = threads.getByRole('article', { name: 'Review thread on src/github/service.ts' });

    // the reply box opens inside the thread card; the composer stays the Agent's
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    const box = thread.getByRole('textbox', { name: 'Reply to @mira' });
    await expect(box).toBeFocused();
    await thread.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveCount(0);
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(thread.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    await box.fill('Renamed it.');
    const reads = detailReads.length;
    await thread.getByRole('button', { name: 'Send reply' }).click();
    await expect(box).toHaveCount(0);
    expect(writes).toEqual([{ path: 'threads/t1/reply', body: { body: 'Renamed it.' } }]);
    // the detail is read again and shows the reply
    await expect(thread.locator('.github-thread-bar')).toContainText('you spoke last');
    expect(detailReads.length).toBeGreaterThan(reads);

    await threads.getByRole('article', { name: 'Review thread on src/github/github.ts' }).getByRole('button', { name: 'Resolve' }).click();
    await expect(threads.getByRole('article')).toHaveCount(1);
    expect(writes.at(-1)).toEqual({ path: 'threads/t2/resolve', body: null });

    // Re-request only on my pull request, for a reviewer with commits since their review
    const reviewers = detail(page).getByRole('region', { name: 'Reviewers' });
    await expect(reviewers.getByRole('button', { name: /Re-request/u })).toHaveCount(1);
    const rerequest = reviewers.getByRole('button', { name: 'Re-request review from @kai' });
    await rerequest.click();
    // its border travels while GitHub answers
    await expect(rerequest).toHaveAttribute('aria-busy', 'true');
    await expect(rerequest).toBeDisabled();
    answerRerequest();
    await expect(reviewers.getByRole('button', { name: /Re-request/u })).toHaveCount(0);
    expect(writes.at(-1)).toEqual({ path: 'rerequest', body: { login: 'kai' } });
    await expect(reviewers.locator('.github-list-row').nth(1)).toContainText('review requested');

    // GitHub's refusal shows in the thread card
    refuse = true;
    await thread.getByRole('button', { name: 'Resolve' }).click();
    await expect(thread.getByRole('alert')).toHaveText('GitHub could not resolve the thread: Must have push access to this repository.');
  } finally { details['pulls/214'] = saved; }
});

test('keeps a half-typed reply when a refresh shows its thread resolved', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const saved = structuredClone(details['pulls/214']);
  await mount(page, [lists]);
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: /^feature/u }).click();
    await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
    await page.getByRole('region', { name: 'GitHub', exact: true }).getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
    const threads = detail(page).getByRole('region', { name: 'Review threads' });
    const thread = threads.getByRole('article', { name: 'Review thread on src/github/service.ts' });
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    await thread.getByRole('textbox', { name: 'Reply to @mira' }).fill('Half a thought');
    // someone resolves it on GitHub, and Refresh reads it so
    (details['pulls/214'] as { pullRequest: { threads: { resolved: boolean }[] } }).pullRequest.threads[0]!.resolved = true;
    await page.getByRole('region', { name: 'GitHub', exact: true }).getByRole('button', { name: 'Refresh' }).click();
    await expect(thread.locator('.github-thread-bar')).toContainText('resolved');
    await expect(thread.getByRole('textbox', { name: 'Reply to @mira' })).toHaveValue('Half a thought');
    // once the reply is let go, the resolved thread leaves the list
    await thread.getByRole('button', { name: 'Cancel' }).click();
    await expect(thread).toHaveCount(0);
  } finally { details['pulls/214'] = saved; }
});

test('says when GitHub held a reply in the operator\'s Draft review', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, [lists]);
  await stubWrites(page, [], () => ({ status: 200, json: { id: 'c9', pending: true } }));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await page.getByRole('region', { name: 'GitHub', exact: true }).getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
  const thread = detail(page).getByRole('article', { name: 'Review thread on src/github/service.ts' });
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByRole('textbox', { name: 'Reply to @mira' }).fill('Renamed it.');
  await thread.getByRole('button', { name: 'Send reply' }).click();
  await expect(thread.getByRole('status')).toHaveText('GitHub added your reply to your Draft review, so others see it only once you submit that review.Submit review');
  await expect(thread.getByRole('link', { name: 'Submit review' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214/files');
});

test('replies inline, resolves and re-requests on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: { path: string; body: unknown }[] = [];
  await mount(page, [lists]);
  await stubWrites(page, writes, path => path.endsWith('/reply') ? { status: 200, json: { id: 'c9', pending: false } } : { status: 502, json: { error: 'GitHub could not resolve the thread: Must have push access to this repository.' } });
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('button', { name: /^#214 Serve GitHub lists from one cached poll/u }).click();
  const thread = detail(page).getByRole('article', { name: 'Review thread on src/github/service.ts' });
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  const box = thread.getByRole('textbox', { name: 'Reply to @mira' });
  await expect(box).toBeInViewport();
  // nothing in the detail runs off the side of the screen
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await box.fill('On a phone.');
  await thread.getByRole('button', { name: 'Send reply' }).click();
  await expect(box).toHaveCount(0);
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(thread.getByRole('alert')).toContainText('Must have push access');
  await detail(page).getByRole('button', { name: 'Re-request review from @kai' }).click();
  await expect.poll(() => writes.map(write => write.path)).toEqual(['threads/t1/reply', 'threads/t1/resolve', 'rerequest']);
  expect(writes[0]!.body).toEqual({ body: 'On a phone.' });
  // nothing that appeared runs off the side of the screen either
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

// stub a Worktree's new pull request: its prefill (`draft`), and each create's body into `created`,
// answered in turn by `answers` (the last repeats)
async function stubCreate(page: Page, draft: unknown, created: unknown[], answers: { status: number; json: unknown }[]) {
  await page.route('**/api/worktrees/*/github/pull-request', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: draft });
    created.push(route.request().postDataJSON());
    const { status, json } = answers.length > 1 ? answers.shift()! : answers[0]!;
    return route.fulfill({ status, json });
  });
}

test('pushes and creates a pull request from This Worktree\'s card, keeping what was typed through a failure', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const github = { revision: 1 };
  const panels: unknown[] = [{ ...lists, mine: lists.mine.slice(1) }];
  await mount(page, panels, [], [], github);
  const created: unknown[] = [];
  await stubCreate(page, { branch: 'feature', base: 'main', title: 'Serve lists from one poll', issue: 201 }, created, [
    { status: 409, json: { error: 'The push failed: ! [rejected] feature -> feature (fetch first)' } },
    { status: 201, json: { number: 240, url: 'https://github.com/octo/repo/pull/240' } }
  ]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const pinned = page.getByRole('region', { name: 'GitHub', exact: true }).locator('.github-worktree-utility');
  await pinned.getByRole('button', { name: 'Push and create PR…' }).click();

  // prefilled from the branch's first commit, origin's default and the Worktree's Issue
  const form = pinned.getByRole('region', { name: 'Push and create a pull request' });
  await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue('Serve lists from one poll');
  await expect(form.getByRole('textbox', { name: 'Into' })).toHaveValue('main');
  await expect(form.getByRole('textbox', { name: 'Description' })).toHaveValue('Closes #201');
  await expect(form.getByRole('checkbox', { name: 'Create as draft' })).not.toBeChecked();
  await form.getByRole('textbox', { name: 'Title' }).fill('');
  await expect(form.getByRole('button', { name: 'Push feature and create PR' })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Title' }).fill('One poll for every list');
  await form.getByRole('checkbox', { name: 'Create as draft' }).check();

  // a failure shows in the form, which keeps what was typed
  await form.getByRole('button', { name: 'Push feature and create PR' }).click();
  await expect(form.getByRole('alert')).toHaveText('The push failed: ! [rejected] feature -> feature (fetch first)');
  await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue('One poll for every list');
  await expect(form.getByRole('checkbox', { name: 'Create as draft' })).toBeChecked();

  await form.getByRole('button', { name: 'Push feature and create PR' }).click();
  await expect(pinned.getByRole('status')).toHaveText('featurePushed, and opened #240.');
  expect(created).toEqual([1, 2].map(() => ({ title: 'One poll for every list', body: 'Closes #201', base: 'main', draft: true })));

  // the new pull request takes the spot once GitHub's data moves, with no Refresh
  panels[0] = { ...lists, mine: [pull(240, 'One poll for every list', { draft: true, checks: 'pending', destination: feature }), ...lists.mine.slice(1)] };
  github.revision = 2;
  await expect(page.getByRole('region', { name: 'GitHub', exact: true }).getByRole('button', { name: /^#240 One poll for every list/u })).toBeVisible({ timeout: 20_000 });
});

test('pushes and creates a pull request on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, [{ ...lists, mine: lists.mine.slice(1) }]);
  const created: unknown[] = [];
  await stubCreate(page, { branch: 'feature', base: 'main', title: '' }, created, [{ status: 201, json: { number: 240, url: 'https://github.com/octo/repo/pull/240' } }]);
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('button', { name: 'Push and create PR…' }).click();
  const form = panel.getByRole('region', { name: 'Push and create a pull request' });
  // no Issue, so no "Closes #N"
  await expect(form.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  await form.getByRole('textbox', { name: 'Title' }).fill('From a phone');
  await expect(form.getByRole('button', { name: 'Push feature and create PR' })).toBeInViewport();
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await form.getByRole('button', { name: 'Push feature and create PR' }).click();
  await expect(panel.getByRole('status')).toContainText('opened #240');
  expect(created).toEqual([{ title: 'From a phone', body: '', base: 'main', draft: false }]);
});

// isolate same-number items by repository through detail reads and writes
test('keeps A #7 and B #7 detail state and writes in their resolved Projects', async ({ page }) => {
  const aMain = worktree('a', 'a:/a', 'A Main', 'main', true, 0);
  const bMain = worktree('b', 'b:/b', 'B Main', 'main', true, 0);
  const item = (repository: string, title: string, worktreeId: string, label: string) => ({ repository, number: 7, title, url: `https://github.com/${repository}/pull/7`, author: 'kai', updatedAt: minutesAgo(5), reasons: [], destination: { kind: 'project' as const, worktreeId, label } });
  const aItem = item('acme/a', 'Repository A seven', aMain.id, 'Alpha');
  const bItem = item('acme/b', 'Repository B seven', bMain.id, 'Bravo');
  const detailFor = (repository: string, title: string, threadId: string) => ({ fetchedAt: Date.now(), pullRequest: pullDetail(7, title, {
    repository,
    url: `https://github.com/${repository}/pull/7`,
    branch: 'same-branch',
    destination: { worktreeId: repository === 'acme/a' ? aMain.id : bMain.id, label: repository === 'acme/a' ? 'A Main' : 'B Main' },
    threads: [{ id: threadId, path: 'src/same.ts', line: 7, resolved: false, outdated: false, diffHunk: '@@ -1 +1 @@\n-a\n+b', comments: [comment(`${threadId}-comment`, 'mira', `feedback for ${repository}`)] }],
    checkRuns: [{ name: `${repository} build`, status: 'passed', url: `https://github.com/${repository}/actions/1` }]
  }) });
  const reads: string[] = [];
  const writes: { path: string; body: unknown }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // return one owner and one foreign repository
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 1001, githubRevision: 1, agents: [], projects: [{ id: 'a', label: 'Alpha', github: 'acme/a', available: true, manageWorktrees: true, worktrees: [aMain] }, { id: 'b', label: 'Bravo', github: 'acme/b', available: true, manageWorktrees: true, worktrees: [bMain] }] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [aItem, bItem], reviews: [], issues: [], totals: { mine: 2, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    if (path === '/api/projects/a/github') return route.fulfill({ json: { mine: [aItem], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() } });
    if (path === '/api/projects/a/github/pulls/7') {
      reads.push(path);
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ json: detailFor('acme/a', 'Repository A seven', 'thread-a') });
    }
    if (path === '/api/projects/b/github/pulls/7') {
      reads.push(path);
      return route.fulfill({ json: detailFor('acme/b', 'Repository B seven', 'thread-b') });
    }
    if (path.startsWith('/api/projects/b/github/pulls/7/') && request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      return route.fulfill({ json: { pending: false } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  await github.getByRole('button', { name: 'All repos' }).click();
  await github.getByRole('button', { name: '#7 Repository A seven, details' }).click();
  await github.getByRole('button', { name: '#7 Repository B seven, details' }).click();
  const shown = github.getByRole('article', { name: 'Pull request #7' });
  await expect(shown.getByRole('heading')).toHaveText('#7Repository B seven');
  await expect(shown).toContainText('acme/b build');
  await shown.getByRole('button', { name: 'Reply', exact: true }).click();
  await shown.getByLabel('Reply to @mira').fill('reply only in B');
  await shown.getByRole('button', { name: 'Send reply' }).click();
  await expect.poll(() => writes).toEqual([{ path: '/api/projects/b/github/pulls/7/threads/thread-b/reply', body: { body: 'reply only in B' } }]);
  expect(reads).toContain('/api/projects/b/github/pulls/7');
  expect(writes.every(write => !write.path.includes('/projects/a/'))).toBe(true);
  await github.getByRole('button', { name: '#7 Repository A seven, details' }).click();
  await expect(shown.getByRole('heading')).toHaveText('#7Repository A seven');
});

// keep verified fork parents local without collapsing their identities into the fork origin
test('keeps fork-parent and origin PRs separate and routes parent detail writes with repository context', async ({ page }) => {
  const ready = { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const audioMain = { ...worktree('audio', 'audio:/audio', 'Audio Main', 'main', true, 0), gitStatus: ready };
  const audioFeature = { ...worktree('audio', 'audio:/audio/wts/feature', 'Audio feature', 'feature', false, 1), gitStatus: ready };
  const guessedMain = worktree('guess', 'guess:/guess', 'Guess Main', 'main', true, 0);
  const parentItem = { repository: 'advplyr/audiobookshelf', number: 4978, title: 'Continue serial podcasts upstream', url: 'https://github.com/advplyr/audiobookshelf/pull/4978', author: 'ansel', updatedAt: minutesAgo(1), reasons: [] };
  const originItem = { repository: 'anstosa/audiobookshelf', number: 4978, title: 'Origin pull request with the same number', url: 'https://github.com/anstosa/audiobookshelf/pull/4978', author: 'ansel', updatedAt: minutesAgo(2), reasons: [] };
  const unrelatedItem = { repository: 'evil/audiobookshelf', number: 4978, title: 'Unrelated same-name repository', url: 'https://github.com/evil/audiobookshelf/pull/4978', author: 'mallory', updatedAt: minutesAgo(3), reasons: [] };
  const parentDetail = { fetchedAt: Date.now(), pullRequest: pullDetail(4978, parentItem.title, {
    repository: parentItem.repository,
    url: parentItem.url,
    branch: 'ansel/continueSerialPodcasts',
    threads: [{ id: 'parent-thread', path: 'server/Podcast.ts', line: 49, resolved: false, outdated: false, diffHunk: '@@ -49 +49 @@\n+continueSerialPodcasts()', comments: [comment('parent-comment', 'mira', 'Keep the upstream identity.')] }]
  }) };
  const originDetail = { fetchedAt: Date.now(), pullRequest: pullDetail(4978, originItem.title, { repository: originItem.repository, url: originItem.url }) };
  const reads: Array<{ path: string; repository: string | null }> = [];
  const writes: Array<{ path: string; repository: string | null; body: unknown }> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    // serve one authenticated fork, one unverified same-name project and three exact identities
    // authenticate the browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose verified project metadata
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 1001, githubRevision: 1, agents: [], projects: [
      { id: 'audio', label: 'Audiobookshelf', github: 'anstosa/audiobookshelf', githubForkOf: 'advplyr/audiobookshelf', available: true, manageWorktrees: true, worktrees: [audioMain, audioFeature] },
      { id: 'guess', label: 'Guess', github: 'random/audiobookshelf', available: true, manageWorktrees: true, worktrees: [guessedMain] }
    ] } });
    // keep push registration inert
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // return all three identities
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [parentItem, originItem, unrelatedItem], reviews: [], issues: [], totals: { mine: 3, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    // accept seen reports
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    // retain the fork catalog
    if (path === '/api/projects/audio/github') return route.fulfill({ json: { mine: [parentItem, originItem], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() } });
    // keep the guessed project empty
    if (path === '/api/projects/guess/github') return route.fulfill({ json: { mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() } });
    // capture the parent-qualified write
    if (path === '/api/projects/audio/github/pulls/4978/threads/parent-thread/reply' && request.method() === 'POST') {
      writes.push({ path, repository: url.searchParams.get('repository'), body: request.postDataJSON() });
      return route.fulfill({ json: { pending: false } });
    }
    // distinguish parent and origin detail reads
    if (path === '/api/projects/audio/github/pulls/4978') {
      const repository = url.searchParams.get('repository');
      reads.push({ path, repository });
      return route.fulfill({ json: repository === parentItem.repository ? parentDetail : originDetail });
    }
    // allow local checkout choices to resolve
    if (path.startsWith('/api/worktrees/') && path.endsWith('/switch-prs')) return route.fulfill({ json: { enabled: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.getByRole('tab', { name: /^Audio Main/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(github.locator('.overview-column-head .overview-count')).toHaveText(['2', '0', '0']);
  await expect(github.getByRole('button', { name: /^#4978 Continue serial podcasts upstream/u })).toBeVisible();
  await expect(github.getByRole('button', { name: /^#4978 Origin pull request with the same number/u })).toBeVisible();
  await expect(github).not.toContainText('Unrelated same-name repository');

  await sizePanel(page, 560);
  await expect(github.locator('.overview-none')).toHaveCount(0);
  const laneHeaders = await github.locator('.overview-column-head').evaluateAll(headers => headers.map(header => {
    const box = header.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(Math.max(...laneHeaders.map(header => header.y)) - Math.min(...laneHeaders.map(header => header.y))).toBeLessThanOrEqual(1);
  expect(Math.max(...laneHeaders.map(header => header.height)) - Math.min(...laneHeaders.map(header => header.height))).toBeLessThanOrEqual(1);
  expect(await github.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await sizePanel(page, 900);

  const parentRow = github.locator('.overview-row').filter({ hasText: parentItem.title });
  await parentRow.getByRole('button', { name: 'Checkout and actions for pull request #4978' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #4978' });
  await expect(menu.getByRole('link')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /^Checkout here/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in a new Worktree in Audiobookshelf/u })).toBeVisible();
  await expect(menu).not.toContainText('Guess Main');
  await page.keyboard.press('Escape');

  await parentRow.getByRole('button', { name: /^#4978 Continue serial podcasts upstream/u }).click();
  const shown = github.getByRole('article', { name: 'Pull request #4978' });
  await expect(shown.getByRole('heading')).toHaveText('#4978Continue serial podcasts upstream');
  await expect.poll(() => reads).toContainEqual({ path: '/api/projects/audio/github/pulls/4978', repository: 'advplyr/audiobookshelf' });
  const thread = shown.getByRole('article', { name: 'Review thread on server/Podcast.ts' });
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByRole('textbox', { name: 'Reply to @mira' }).fill('reply to upstream only');
  await thread.getByRole('button', { name: 'Send reply' }).click();
  await expect.poll(() => writes).toEqual([{ path: '/api/projects/audio/github/pulls/4978/threads/parent-thread/reply', repository: 'advplyr/audiobookshelf', body: { body: 'reply to upstream only' } }]);

  await shown.getByRole('button', { name: '‹ Back to cards' }).click();
  await github.getByRole('button', { name: /^#4978 Origin pull request with the same number/u }).click();
  await expect(shown.getByRole('heading')).toHaveText('#4978Origin pull request with the same number');
  await expect.poll(() => reads).toContainEqual({ path: '/api/projects/audio/github/pulls/4978', repository: null });
  await shown.getByRole('button', { name: '‹ Back to cards' }).click();
  await github.getByRole('button', { name: 'All repos' }).click();
  const unrelatedRow = github.locator('.overview-row').filter({ hasText: unrelatedItem.title });
  await expect(unrelatedRow.locator('.overview-destination')).toHaveText('No local Project');
  await expect(unrelatedRow.locator('.github-card-controls').getByRole('button')).toBeDisabled();
});
