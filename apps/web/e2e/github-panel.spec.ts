import { expect, test, type Page } from '@playwright/test';

// The GitHub panel: one Project's Pull requests and Issues beside its Worktrees, opened from the
// Workspace toolbar (the ⋮ on a phone) in a Place whose origin is on github.com.

const worktree = (projectId: string, id: string, label: string, branch: string, main: boolean, order: number) => ({ id, projectId, label, path: id.slice(id.indexOf(':') + 1), main, detached: false, locked: false, available: true, pinned: true, order, branch });
const dashboard = {
  generation: 1,
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
  assigned: [issue(201, 'GitHub PR dashboard', { labels: ['feature'], linkedPullRequests: [214] })],
  issues: [issue(11, 'Launcher search ignores Notes')],
  fetchedAt: Date.now() - 20_000
};
const overview = {
  mine: [], reviews: [{ ...lists.reviews[0]!, unseen: undefined, destination: { kind: 'project', worktreeId: 'repo:/repo', label: 'Repo' } }],
  // an assigned Issue the panel lists among the others (past the Overview's first page, say)
  issues: [{ ...lists.issues[0]!, destination: { kind: 'project', worktreeId: 'repo:/repo', label: 'Repo' } }],
  totals: { mine: 0, reviews: 1, issues: 1 }, fetchedAt: Date.now()
};

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
async function mount(page: Page, panels: unknown[], reads: string[] = [], seen: string[][] = [], github = { revision: 1 }, detailReads: string[] = []) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { ...dashboard, githubRevision: github.revision } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: overview });
    if (path === '/api/github/overview/seen') {
      seen.push((route.request().postDataJSON() as { keys: string[] }).keys);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/projects/repo/github') {
      reads.push(url.search);
      const next = panels.length > 1 ? panels.shift() : panels[0];
      return next === 'pending' ? undefined : route.fulfill({ json: next });
    }
    const detail = /^\/api\/projects\/repo\/github\/((?:pulls|issues)\/\d+)$/u.exec(path)?.[1];
    if (detail !== undefined) {
      detailReads.push(`${detail}${url.search}`);
      return route.fulfill({ json: details[detail] ?? { problem: { kind: 'failing', message: 'GitHub could not read the pull request: Could not resolve to a PullRequest.' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });

test('lists a Project\'s Pull requests and Issues in groups, with This Worktree\'s pinned on top', async ({ page }) => {
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
  const pinned = panel.getByRole('region', { name: 'This Worktree' });
  await expect(pinned.locator('.overview-row-number')).toHaveText(['#214']);
  await expect(pinned.getByRole('button', { name: 'Pull request #214 Serve GitHub lists from one cached poll, new, here' })).toBeVisible();
  await expect(pinned).toContainText('@mira on service.ts');
  await expect(pinned).toContainText('closes #201');

  // Waiting on me first in each group; the pinned row is not listed again
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' }).locator('.overview-row-number')).toHaveText(['#231', '#230']);
  const reviews = panel.getByRole('region', { name: 'Pull requests: Review requested' });
  await expect(reviews.locator('.overview-row')).toContainText(['@kai']);
  await expect(reviews).toContainText('Re-requestednew commits since your review');
  const other = panel.getByRole('region', { name: 'Pull requests: Other open' });
  await expect(other.getByRole('button', { name: /^Other open/u })).toHaveAttribute('aria-expanded', 'false');
  await expect(other.locator('.overview-row')).toHaveCount(0);
  await expect(other.getByRole('button', { name: /^Other open/u })).toContainText('1 new');
  const done = panel.getByRole('region', { name: 'Pull requests: Merged or closed, Worktree still here' });
  await expect(done.locator('.overview-row')).toContainText(['#203Scheduled prompts10mmerged 10m agoshipped']);
  await expect(done.locator('.overview-destination')).toHaveText('shipped');
  await expect(panel.getByRole('region', { name: 'Issues: Assigned to me' }).locator('.overview-row')).toContainText(['#201GitHub PR dashboard@jo']);
  await expect(panel.getByRole('region', { name: 'Issues: Other open' }).locator('.overview-row')).toHaveCount(0);

  // the rows shown are reported seen, not those of a collapsed group, until it opens
  await expect.poll(() => seen.flat().sort()).toEqual(['octo/repo#214:thread:t1:c1', 'octo/repo#90:review:q']);
  await other.getByRole('button', { name: /^Other open/u }).click();
  await expect(other.locator('.overview-row')).toContainText(['#205Bump vite@dependabot']);
  await expect.poll(() => seen.flat()).toContain('octo/repo#205:test');

  // a row is picked by tapping it; ↗ opens it on github.com
  await panel.getByRole('button', { name: /^Pull request #231/u }).click();
  await expect(panel.getByRole('button', { name: /^Pull request #231/u })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByRole('link', { name: 'Open #231 on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/231');

  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => reads).toEqual(['', '?refresh=1']);
  await expect(panel.getByRole('button', { name: 'Expand GitHub' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close GitHub panel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('pins a Push and create PR placeholder for a branch with no pull request, and nothing in the main worktree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const quiet = { ...lists, mine: lists.mine.slice(1) };
  await mount(page, [quiet]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('region', { name: 'This Worktree' })).toContainText('featureNo pull request yet.');

  await page.getByRole('tab', { name: /^Repo/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'This Worktree' })).toHaveCount(0);
});

test('hides the toggle where the origin is not on github.com, and explains a panel left open there', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:notes:/notes', 'open'));
  await mount(page, [lists]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^Notes/u }).click();
  await expect(toolbar(page).getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('heading', { name: 'Not a GitHub repository' })).toBeVisible();
  await panel.getByRole('link', { name: 'Open the Overview' }).click();
  await expect(page.getByRole('region', { name: 'Overview' })).toBeVisible();
});

test('lands on the panel focused on the item an Overview row names, opening its group', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [lists]);
  await page.goto('/#overview');
  await page.getByRole('region', { name: 'Overview' }).getByRole('button', { name: '#11 Launcher search ignores Notes, in Repo' }).click();
  await expect(page.getByRole('tab', { name: /^Repo/u })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const row = panel.getByRole('region', { name: 'Issues: Other open' }).locator('.overview-row');
  await expect(row).toHaveClass(/focus/u);
  await expect(row).toContainText('from the Overview');
  await expect(row.getByRole('button')).toHaveAttribute('aria-current', 'true');
  await expect(toolbar(page).getByRole('button', { name: 'GitHub', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // picking another row ends the Overview's outline
  await panel.getByRole('button', { name: /^Pull request #231/u }).click();
  await expect(row).not.toHaveClass(/focus/u);
});

test('lands on a Pull request an Overview row names, in the Project\'s main worktree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // an Issue with the same number is not the one meant
  await mount(page, [{ ...lists, issues: [...lists.issues, issue(90, 'Same number, an Issue')] }]);
  await page.goto('/#overview');
  await page.getByRole('region', { name: 'Overview' }).getByRole('button', { name: '#90 Handle redacted events, in Repo' }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const row = panel.getByRole('region', { name: 'Pull requests: Review requested' }).locator('.overview-row');
  await expect(row).toHaveClass(/focus/u);
  await expect(row).toContainText('from the Overview');
  await expect(panel.locator('.overview-row.focus')).toHaveCount(1);
  await expect(panel.getByRole('region', { name: 'Issues: Other open' }).locator('.overview-row')).toHaveCount(0);

  // reopened by hand, the panel is not the Overview's any more
  await panel.getByRole('button', { name: 'Close GitHub panel' }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Pull requests: Review requested' })).toBeVisible();
  await expect(panel.locator('.overview-row.focus')).toHaveCount(0);
});

test('reads the lists again when the dashboard\'s GitHub revision moves', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const github = { revision: 1 };
  const renamed = { ...lists, other: [{ ...lists.other[0]!, title: 'Bump vite, renamed' }] };
  await mount(page, [lists, renamed], reads, [], github);
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:repo:/repo/wts/feature', 'open'));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await panel.getByRole('button', { name: /^Other open/u }).first().click();
  const other = panel.getByRole('region', { name: 'Pull requests: Other open' }).locator('.overview-row-title');
  await expect(other).toHaveText('#205Bump vite');
  github.revision = 2;
  // the dashboard is read again within a few seconds
  await expect(other).toHaveText('#205Bump vite, renamed', { timeout: 20_000 });
  expect(reads).toEqual(['', '']);
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
  await expect(panel.getByRole('region', { name: 'This Worktree' })).toBeVisible();
  await expect(panel).toBeInViewport();
  // nothing in the panel runs off the side of the screen
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.evaluate(() => { location.hash = 'tab=Notes'; });
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
});

test('shows skeleton rows, the Overview\'s no-token card, and a stale banner with Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const stale = { ...lists, fetchedAt: Date.now() - 6 * 60_000, problem: { kind: 'failing', message: 'GitHub could not read pull requests (502).' } };
  const noToken = { mine: [], reviews: [], other: [], done: [], assigned: [], issues: [], problem: { kind: 'no-token', message: 'GitHub authentication is not configured.' } };
  await mount(page, ['pending', stale, noToken], reads);
  await page.addInitScript(() => localStorage.setItem('rac.github-panel:repo:/repo/wts/feature', 'open'));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('status', { name: 'Loading the GitHub panel' })).toBeVisible();

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

test('shows This Worktree\'s pull request beside the list on a desktop, in full', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const detailReads: string[] = [];
  await mount(page, [lists], [], [], { revision: 1 }, detailReads);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const pull = detail(page);
  await expect(pull.getByRole('heading')).toHaveText('#214Serve GitHub lists from one cached poll');
  await expect(panel.getByRole('button', { name: /^Pull request #214/u })).toHaveAttribute('aria-current', 'true');
  await expect(pull.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214');
  await expect(pull.locator('.github-detail-meta')).toHaveText(/^open@tonyfeature → mainupdated 10m ago$/u);
  await expect(pull.locator('.overview-chips').first()).toHaveText('@mira on service.ts');
  await expect(pull.locator('.github-strip')).toHaveText('Checked out here, in feature.');
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
  await expect(panel.getByRole('button', { name: /^Issue #201/u })).toHaveAttribute('aria-current', 'true');
  await expect(issue.locator('.overview-chip.label')).toHaveText(['feature']);
  await expect(issue.getByRole('region', { name: 'Description' })).toContainText('One place for every PR.');
  await expect(issue.locator('.github-strip')).toHaveText('Checked out here, in feature.');
  await expect(issue.getByRole('link', { name: 'Assign / label' })).toHaveAttribute('href', 'https://github.com/octo/repo/issues/201');
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
  await panel.getByRole('button', { name: /^Pull request #90/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(detail(page).locator('.github-strip')).toHaveText('Not checked out.');
  await expect(detail(page).getByRole('link', { name: 'Submit review' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/90/files');
  await expect(detail(page).getByRole('link', { name: 'Merge' })).toHaveCount(0);
  // re-requesting a review is the author's
  await expect(detail(page).getByRole('region', { name: 'Reviewers' })).toContainText('new commits since');
  await expect(detail(page).getByRole('button', { name: /Re-request/u })).toHaveCount(0);
  // my draft, conflicting with its base
  await panel.getByRole('button', { name: /^Pull request #231/u }).click();
  await expect(detail(page).getByRole('link', { name: 'Ready for review' })).toBeVisible();
  await expect(detail(page).locator('.github-strip.conflict')).toHaveText('Merge conflicts with main. Check it out in a Worktree to rebase it.');
  // one GitHub cannot read says so
  await panel.getByRole('button', { name: /^Other open/u }).first().click();
  await panel.getByRole('button', { name: /^Pull request #205/u }).click();
  await expect(detail(page).getByRole('heading', { name: 'Pull request #205 could not be read' })).toBeVisible();
});

test('goes to the Worktree holding a pull request, keeping the panel on it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, [lists]);
  await page.goto('/');
  await page.getByRole('tab', { name: /^Repo/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  // the main worktree pins nothing, so nothing is picked yet
  await expect(panel.getByText('Pick a pull request or issue.')).toBeVisible();
  await panel.getByRole('button', { name: /^Pull request #214/u }).click();
  await expect(detail(page).locator('.github-strip')).toHaveText('Checked out in feature.Go to Worktree');
  await detail(page).getByRole('button', { name: 'Go to Worktree' }).click();
  await expect(page.getByRole('tab', { name: /^feature/u })).toHaveAttribute('aria-selected', 'true');
  await expect(detail(page).locator('.github-strip')).toHaveText('Checked out here, in feature.');
  // not an Overview arrival
  await expect(panel.locator('.overview-row.focus')).toHaveCount(0);
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
    await expect(detail(page).getByRole('region', { name: 'Reviewers' })).toBeVisible();
    await expect(panel.locator('.github-pane-body')).toHaveClass(/split/u);
    expect(await overflows(page, '.github-detail-column')).toBe(false);

    // just wide enough for both: every detail wraps to the column, and the rows to theirs
    await sizePanel(page, 560);
    await expect(panel.locator('.github-pane-body')).toHaveClass(/split/u);
    for (const name of [/^Pull request #214/u, /^Pull request #90/u, /^Pull request #231/u, /^Issue #201/u]) {
      await panel.getByRole('button', { name }).click();
      await expect(detail(page).locator('.github-detail-meta')).toBeVisible();
      expect(await overflows(page, '.github-detail-column')).toBe(false);
      expect(await overflows(page, '.github-list-column')).toBe(false);
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
  // the list first: This Worktree's pull request is not opened for it
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toBeVisible();
  await expect(panel.locator('.github-pane-body')).not.toHaveClass(/split/u);
  await expect(detail(page)).toHaveCount(0);
  await expect.poll(() => seen.flat().sort()).toEqual(['octo/repo#214:thread:t1:c1', 'octo/repo#90:review:q']);

  await panel.getByRole('button', { name: /^Pull request #231/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#231Needs a rebase');
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toHaveCount(0);
  expect(await overflows(page, '.github-pane-body')).toBe(false);
  await detail(page).getByRole('button', { name: '‹ All' }).click();
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toBeVisible();
  await expect(detail(page)).toHaveCount(0);

  // widened, the panel shows both again, This Worktree's pull request beside the list
  await sizePanel(page, 900);
  await expect(panel.locator('.github-pane-body')).toHaveClass(/split/u);
  await expect(detail(page).getByRole('heading')).toHaveText('#214Serve GitHub lists from one cached poll');
});

test('opens an Overview row\'s item straight on its detail in a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen: string[][] = [];
  await mount(page, [lists], [], seen);
  await page.goto('/#overview');
  await sizePanel(page, 480);
  await page.getByRole('region', { name: 'Overview' }).getByRole('button', { name: '#90 Handle redacted events, in Repo' }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(detail(page)).toContainText('from the Overview');
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toHaveCount(0);
  await expect.poll(() => seen.flat()).toEqual(['octo/repo#90:review:q']);
  await detail(page).getByRole('button', { name: '‹ All' }).click();
  await expect(panel.getByRole('region', { name: 'Pull requests: Review requested' }).locator('.overview-row')).toHaveCount(1);
});

test('drills down from the list on a phone, the open detail counting as shown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seen: string[][] = [];
  await mount(page, [lists], [], seen);
  // an Overview tap opens straight on the item's detail
  await page.goto('/#overview');
  await page.getByRole('region', { name: 'Overview' }).getByRole('tab', { name: /^Reviews/u }).click();
  await page.getByRole('region', { name: 'Overview' }).getByRole('button', { name: '#90 Handle redacted events, in Repo' }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(detail(page)).toContainText('from the Overview');
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toHaveCount(0);
  await expect.poll(() => seen.flat()).toEqual(['octo/repo#90:review:q']);
  // nothing in the detail runs off the side of the screen
  expect(await panel.locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await detail(page).getByRole('button', { name: '‹ All' }).click();
  await expect(panel.getByRole('region', { name: 'Pull requests: Mine' })).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await panel.getByRole('button', { name: /^Issue #201/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#201GitHub PR dashboard');
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

test('says when GitHub held a reply in the operator\'s Draft review', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, [lists]);
  await stubWrites(page, [], () => ({ status: 200, json: { id: 'c9', pending: true } }));
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
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
  await panel.getByRole('region', { name: 'This Worktree' }).getByRole('button', { name: /^Pull request #214/u }).click();
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
