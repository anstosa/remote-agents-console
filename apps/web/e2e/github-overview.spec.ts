import { expect, test, type Page } from '@playwright/test';

// The Overview: the operator's pull requests, Review requests and assigned Issues across every
// repository, opened from the tab row's Overview button, standing in for the Workspace while open.

const dashboard = {
  generation: 1,
  githubRevision: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
      { id: 'repo:/repo/wts/feature', projectId: 'repo', label: 'feature', path: '/repo/wts/feature', main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch: 'feature' }
    ] }
  ]
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const worktree = { kind: 'worktree', worktreeId: 'repo:/repo/wts/feature', label: 'feature' };
const project = { kind: 'project', worktreeId: 'repo:/repo', label: 'Repo' };
const busy = {
  // GitHub's order, newest first; the Overview regroups it
  mine: [
    { repository: 'acme/web', number: 1412, title: 'Debounce the search input', url: 'https://github.com/acme/web/pull/1412', updatedAt: minutesAgo(3), checks: 'failed', reasons: [{ kind: 'checks' }, { kind: 'changes', id: 'r1', author: 'lee' }] },
    { repository: 'octo/repo', number: 199, title: 'Post a Review tour as a draft review', url: 'https://github.com/octo/repo/pull/199', updatedAt: minutesAgo(5), checks: 'passed', reasons: [], approved: true, destination: project },
    { repository: 'octo/repo', number: 214, title: 'Serve GitHub lists from one cached poll', url: 'https://github.com/octo/repo/pull/214', updatedAt: minutesAgo(6), checks: 'passed', reasons: [{ kind: 'thread', id: 't1', author: 'mira', path: 'src/github/service.ts' }], closes: [201], destination: worktree },
    { repository: 'octo/repo', number: 220, title: 'Bottom status bar', url: 'https://github.com/octo/repo/pull/220', updatedAt: minutesAgo(60 * 2), checks: 'passed', reasons: [{ kind: 'conflicts' }], destination: project }
  ],
  reviews: [
    { repository: 'acme/web', number: 1420, title: 'Replace moment with date-fns', url: 'https://github.com/acme/web/pull/1420', author: 'sam', updatedAt: minutesAgo(12), reasons: [{ kind: 'review', reRequested: true }], newCommits: true },
    { repository: 'octo/repo', number: 90, title: 'Handle redacted events', url: 'https://github.com/octo/repo/pull/90', author: 'kai', updatedAt: minutesAgo(60 * 6), reasons: [{ kind: 'review' }], destination: project },
    { repository: 'octo/repo', number: 91, title: 'New onboarding flow', url: 'https://github.com/octo/repo/pull/91', author: 'jo', updatedAt: minutesAgo(60 * 30), reasons: [], draft: true, destination: project }
  ],
  issues: [
    { repository: 'octo/repo', number: 201, title: 'GitHub PR dashboard', url: 'https://github.com/octo/repo/issues/201', author: 'tony', updatedAt: minutesAgo(6), reasons: [], labels: ['feature'], linkedPullRequests: [214], destination: worktree }
  ],
  totals: { mine: 4, reviews: 3, issues: 1 },
  fetchedAt: Date.now() - 20_000
};

// stub the console; `overviews` answer each Overview read in turn (the last repeats), and the
// dashboard reports `github.revision` and `github.badge`; each mark-seen report lands in `seen`
async function mount(page: Page, overviews: unknown[], reads: string[] = [], github: { revision: number; badge?: number; seen?: string[][] } = { revision: 1 }) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { ...dashboard, githubRevision: github.revision, githubBadge: github.badge } });
    if (path === '/api/github/overview/seen') {
      github.seen?.push((route.request().postDataJSON() as { keys: string[] }).keys);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') {
      reads.push(url.search);
      const next = overviews.length > 1 ? overviews.shift() : overviews[0];
      return next === 'pending' ? undefined : route.fulfill({ json: next });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('opens from the tab row in place of the Workspace, with three columns grouped by repository', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [busy]);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Overview', exact: true });
  await expect(button).toHaveText('Overview');
  await expect(page.locator('.workspace-toolbar')).toBeVisible();

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#overview$/u);
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.getByText('5 waiting on me')).toBeVisible();
  await expect(overview.getByText('updated just now')).toBeVisible();
  // the Workspace's panels, composer and toolbar give way; the tab row stays
  await expect(page.locator('.workspace-toolbar')).toHaveCount(0);
  await expect(page.locator('.prompt-form, .log-shell')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^feature/u })).toBeVisible();

  const mine = overview.getByRole('region', { name: 'My pull requests' });
  await expect(mine.locator('.overview-column-head')).toContainText('My pull requests4');
  await expect(mine.locator('.overview-column-head')).toContainText('3 waiting on me');
  // repositories by waiting count, then name; Waiting on me rows first in each
  await expect(mine.locator('.overview-repository-head')).toHaveText(['octo/repo2', 'acme/web1']);
  await expect(mine.locator('.overview-repository-head').first().getByLabel('Has a Project')).toBeVisible();
  await expect(mine.locator('.overview-repository-head').nth(1).getByLabel('Has a Project')).toHaveCount(0);
  await expect(mine.locator('.overview-row-number')).toHaveText(['#214', '#220', '#199', '#1412']);
  const own = mine.locator('.overview-row').first();
  await expect(own).toContainText('@mira on service.ts');
  await expect(own).toContainText('closes #201');
  await expect(own.getByLabel('Checks pass')).toBeVisible();
  await expect(own.locator('.overview-destination')).toHaveText('feature');
  await expect(mine.locator('.overview-row').nth(1)).toContainText('merge conflicts');
  await expect(mine.locator('.overview-row').nth(2)).toContainText('approved');
  await expect(mine.locator('.overview-row').nth(3)).toContainText('checks failing@lee requested changes');
  await expect(mine.locator('.overview-row').nth(3).locator('.overview-destination')).toHaveText('github.com');

  const reviews = overview.getByRole('region', { name: 'Review requests' });
  await expect(reviews.locator('.overview-row').first()).toContainText('@sam');
  await expect(reviews.locator('.overview-row').first()).toContainText('Re-requestednew commits since your review');
  await expect(reviews.locator('.overview-row').nth(1)).toContainText('Review requested');
  await expect(reviews.locator('.overview-row').nth(2)).toContainText('draft');
  const issues = overview.getByRole('region', { name: 'Assigned issues' });
  await expect(issues.locator('.overview-row')).toHaveText(['#201GitHub PR dashboard@tony6m#214featurefeature']);

  // a repository with no Project opens on github.com; the others have ↗ beside the row
  await expect(mine.getByRole('link', { name: '#1412 Debounce the search input, on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/1412');
  await expect(mine.getByRole('link', { name: 'Open #214 on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214');

  // tapping a row opens its Worktree's Workspace
  await mine.getByRole('button', { name: '#214 Serve GitHub lists from one cached poll, in feature' }).click();
  await expect(overview).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^feature/u })).toHaveAttribute('aria-selected', 'true');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.workspace-toolbar')).toBeVisible();
});

test('closes with Esc or ✕ back to the last Workspace, and reopens from its address', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [busy]);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overview).toHaveCount(0);
  await expect(page).not.toHaveURL(/#overview$/u);

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await overview.getByRole('button', { name: 'Close Overview' }).click();
  await expect(overview).toHaveCount(0);
  // the button toggles too
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(overview).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(overview).toHaveCount(0);

  // a link to a Workspace (a notification's) leaves the Overview for it; Esc with a flyout open closes the flyout first
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Launch agent' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toHaveCount(0);
  await expect(overview).toBeVisible();
  await page.evaluate(() => { location.hash = 'tab=feature'; });
  await expect(overview).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^feature/u })).toHaveAttribute('aria-selected', 'true');
});

test('shows the columns as tabs on a phone, each with its total and how many are waiting on me', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, [busy]);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Overview', exact: true });
  await expect(button).toHaveText('');
  await button.click();
  const overview = page.getByRole('region', { name: 'Overview' });
  const tabs = overview.getByRole('tablist', { name: 'Overview lists' }).getByRole('tab');
  await expect(tabs.locator('.overview-count')).toHaveText(['4', '3', '1']);
  await expect(tabs.locator('.overview-waits')).toHaveText(['3', '2']);
  await expect(tabs.first()).toHaveAccessibleName('Mine, 4, 3 waiting on me');
  await expect(tabs.nth(2)).toHaveAccessibleName('Issues, 1');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(overview.locator('.overview-row-number')).toHaveText(['#214', '#220', '#199', '#1412']);
  await tabs.nth(1).click();
  await expect(overview.locator('.overview-row-number')).toHaveText(['#1420', '#90', '#91']);
  await tabs.nth(2).click();
  await expect(overview.locator('.overview-row-number')).toHaveText(['#201']);
  // nothing in the Overview runs off the side of the screen
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('shows skeletons while loading, a card without a token or with nothing open, and a stale banner with Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const stale = { ...busy, fetchedAt: Date.now() - 6 * 60_000, problem: { kind: 'failing', message: 'GitHub could not read pull requests (502).' } };
  const empty = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() };
  const noToken = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, problem: { kind: 'no-token', message: 'GitHub authentication is not configured.' } };
  await mount(page, [stale, empty, noToken], reads);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.getByRole('status')).toHaveText('GitHub is unreachable. Showing what was fetched 6m ago.Retry');
  await expect(overview.locator('.overview-row')).toHaveCount(8);
  await overview.getByRole('button', { name: 'Retry' }).click();
  await expect(overview.getByRole('heading', { name: 'Nothing open' })).toBeVisible();
  expect(reads).toEqual(['', '?refresh=1']);
  await overview.getByRole('button', { name: 'Refresh' }).click();
  await expect(overview.getByRole('heading', { name: 'No GitHub token' })).toBeVisible();
  await expect(overview).toContainText('gh auth login');
  await expect(overview).toContainText('RAC_GITHUB_TOKEN');
});

test('reads the lists again when the dashboard\'s GitHub revision moves', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const github = { revision: 1 };
  const renamed = { ...busy, issues: [{ ...busy.issues[0]!, title: 'GitHub PR dashboard, renamed' }] };
  await mount(page, [busy, renamed], reads, github);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'Overview' });
  const issue = overview.getByRole('region', { name: 'Assigned issues' }).locator('.overview-row-title');
  await expect(issue).toHaveText('#201GitHub PR dashboard');
  github.revision = 2;
  // the dashboard is read again within a few seconds
  await expect(issue).toHaveText('#201GitHub PR dashboard, renamed', { timeout: 20_000 });
  expect(reads).toEqual(['', '']);
});

test('shows skeleton rows until the first read lands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, ['pending']);
  await page.goto('/#overview');
  await expect(page.getByRole('status', { name: 'Loading the Overview' })).toBeVisible();
});

// the busy lists with `unseen` reason instances on some rows
const unseenRows = (overview: typeof busy, unseen: Record<number, string[]>) => ({
  ...overview,
  mine: overview.mine.map(item => unseen[item.number] === undefined ? item : { ...item, unseen: unseen[item.number] }),
  reviews: overview.reviews.map(item => unseen[item.number] === undefined ? item : { ...item, unseen: unseen[item.number] })
});
const fresh = unseenRows(busy, { 220: ['octo/repo#220:conflicts'], 90: ['octo/repo#90:review:q'] });

test('badges the Pull requests with something new, which drops as their rows show while their dots stay for the visit', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const github = { revision: 1, badge: 2, seen: [] as string[][] };
  await mount(page, [fresh, busy], [], github);
  await page.goto('/');
  const button = page.getByRole('button', { name: /^Overview/u });
  await expect(button).toHaveAccessibleName('Overview, 2 new');
  await expect(button).toHaveText('Overview2');

  await button.click();
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.locator('.overview-summary')).toHaveText('5 waiting on me · 2 new');
  const mine = overview.getByRole('region', { name: 'My pull requests' });
  // new rows first among Waiting on me; repositories holding something new first
  await expect(mine.locator('.overview-row-number')).toHaveText(['#220', '#214', '#199', '#1412']);
  await expect(overview.getByRole('region', { name: 'Review requests' }).locator('.overview-repository-head')).toHaveText(['octo/repo1', 'acme/web1']);
  await expect(overview.locator('.overview-row.new .overview-row-number')).toHaveText(['#220', '#90']);

  // shown rows are reported seen; the server's badge drops, and the dots stay for the visit
  await expect.poll(() => github.seen.flat().sort()).toEqual(['octo/repo#220:conflicts', 'octo/repo#90:review:q']);
  github.badge = 0;
  github.revision = 2;
  await expect(button).toHaveAccessibleName('Overview', { timeout: 20_000 });
  await expect(button).toHaveText('Overview');
  await expect(overview.locator('.overview-row.new .overview-row-number')).toHaveText(['#220', '#90']);
  await expect(overview.locator('.overview-summary')).toHaveText('5 waiting on me · 2 new');
  expect(github.seen).toHaveLength(1);

  // a new visit starts without them
  await overview.getByRole('button', { name: 'Close Overview' }).click();
  await button.click();
  await expect(overview.locator('.overview-summary')).toHaveText('5 waiting on me');
  await expect(overview.locator('.overview-row.new')).toHaveCount(0);
});

test('opens a phone on the first tab holding something new, and reports only the rows of tabs opened', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const github = { revision: 1, badge: 1, seen: [] as string[][] };
  await mount(page, [unseenRows(busy, { 90: ['octo/repo#90:review:q'] })], [], github);
  await page.goto('/');
  const button = page.getByRole('button', { name: /^Overview/u });
  await expect(button).toHaveText('1');
  await expect(button.locator('.overview-badge.corner')).toBeVisible();
  // the corner badge sits inside the tab row, not clipped away
  const [badge, row] = await Promise.all([button.locator('.overview-badge').boundingBox(), page.locator('.tabs').boundingBox()]);
  expect(badge!.y).toBeGreaterThanOrEqual(row!.y);

  await button.click();
  const overview = page.getByRole('region', { name: 'Overview' });
  const tabs = overview.getByRole('tablist', { name: 'Overview lists' }).getByRole('tab');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(overview.locator('.overview-row.new .overview-row-number')).toHaveText(['#90']);
  await expect.poll(() => github.seen).toEqual([['octo/repo#90:review:q']]);
});

test('leaves rows on a phone tab not yet opened unseen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const github = { revision: 1, badge: 2, seen: [] as string[][] };
  await mount(page, [unseenRows(busy, { 220: ['octo/repo#220:conflicts'], 90: ['octo/repo#90:review:q'] })], [], github);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'Overview' });
  const tabs = overview.getByRole('tablist', { name: 'Overview lists' }).getByRole('tab');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1).getByRole('img', { name: 'Holds something new' })).toBeVisible();
  await expect(tabs.nth(2).getByRole('img', { name: 'Holds something new' })).toHaveCount(0);
  await expect.poll(() => github.seen).toEqual([['octo/repo#220:conflicts']]);
  await page.waitForTimeout(1_000);
  expect(github.seen).toEqual([['octo/repo#220:conflicts']]);
  await tabs.nth(1).click();
  await expect.poll(() => github.seen).toEqual([['octo/repo#220:conflicts'], ['octo/repo#90:review:q']]);
});

test('marks nothing seen while the page is hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const github = { revision: 1, badge: 1, seen: [] as string[][] };
  await page.addInitScript(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as { shown?: boolean }).shown === true ? 'visible' : 'hidden' }); });
  await mount(page, [fresh], [], github);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.getByRole('button', { name: '#220 Bottom status bar, new, in Repo' })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(github.seen).toEqual([]);
  await page.evaluate(() => { (window as { shown?: boolean }).shown = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => github.seen.flat().sort()).toEqual(['octo/repo#220:conflicts', 'octo/repo#90:review:q']);
});
