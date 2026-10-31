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

// stub the console; `panels` answer each panel read in turn (the last repeats), each read's query
// lands in `reads` and each mark-seen report in `seen`; the dashboard reports `github.revision`
async function mount(page: Page, panels: unknown[], reads: string[] = [], seen: string[][] = [], github = { revision: 1 }) {
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
  await expect(panel.getByRole('status')).toHaveText('GitHub is unreachable. Showing what was fetched 6m ago.Retry');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('heading', { name: 'No GitHub token' })).toBeVisible();
  await expect(panel).toContainText('gh auth login');
  expect(reads.slice(-1)).toEqual(['?refresh=1']);
});
