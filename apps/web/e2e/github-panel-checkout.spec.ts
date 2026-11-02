import { expect, test, type Locator, type Page } from '@playwright/test';

// The GitHub panel's Worktree strip: checking a pull request out here, moving it here from the
// Worktree holding it, and removing a merged or closed pull request's Worktree through the Remove
// worktree dialog.

const clean = { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
const worktree = (id: string, label: string, branch: string, extra: Record<string, unknown> = {}) => ({ id: `repo:/repo/wts/${id}`, projectId: 'repo', label, path: `/repo/wts/${id}`, main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch, gitStatus: clean, ...extra });
// an Agent in the feature Worktree, which a guided review needs
const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/repo/wts/feature', projectId: 'repo', worktreeId: 'repo:/repo/wts/feature', worktreeLabel: 'feature', branch: 'feature', title: 'Ready', gitStatus: clean, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] } };
const dashboard = (dirty: boolean, withAgent: boolean) => ({
  generation: 1,
  serverStartedAt: 1001,
  githubRevision: 1,
  reviewTour: { available: true },
  agents: withAgent ? [agent] : [],
  projects: [{
    id: 'repo', label: 'Repo', github: 'octo/repo', available: true, worktrees: [
      { ...worktree('main', 'Repo', 'main'), id: 'repo:/repo', path: '/repo', main: true, order: 0 },
      worktree('feature', 'feature', 'feature', dirty ? { gitStatus: { ...clean, files: 2, unstaged: 2 } } : {}),
      worktree('other', 'other', 'branch-90', { order: 2 }),
      worktree('shipped', 'shipped', 'branch-203', { order: 3 })
    ]
  }]
});
const at = (id: string, label: string) => ({ kind: 'worktree', worktreeId: `repo:/repo/wts/${id}`, label });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, author: 'kai', updatedAt: minutesAgo(10), reasons: [], ...extra });
const lists = {
  mine: [row(214, 'Serve GitHub lists from one cached poll', { author: 'tony', destination: at('feature', 'feature') })],
  reviews: [row(90, 'Handle redacted events', { destination: at('other', 'other') }), row(91, 'Retry webhooks')],
  other: [], assigned: [], issues: [],
  done: [row(203, 'Scheduled prompts', { state: 'merged', destination: at('shipped', 'shipped') })],
  fetchedAt: Date.now()
};
const detail = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  fetchedAt: Date.now(), pullRequest: {
    repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, state: 'open', draft: false, author: 'kai', mine: false, updatedAt: minutesAgo(10),
    branch: `branch-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40), headOnOrigin: true, mergeable: 'mergeable', checks: 'passed',
    threads: [], reviews: [], comments: [], checkRuns: [], reviewers: [], linkedIssues: [], ...extra
  }
});
const details: Record<string, unknown> = {
  214: detail(214, 'Serve GitHub lists from one cached poll', { author: 'tony', mine: true, branch: 'feature', destination: at('feature', 'feature') }),
  90: detail(90, 'Handle redacted events', { destination: at('other', 'other') }),
  91: detail(91, 'Retry webhooks'),
  203: detail(203, 'Scheduled prompts', { state: 'merged', destination: at('shipped', 'shipped') })
};

type Call = { method: string; path: string; body?: unknown };
// stub the console; every worktree action lands in `calls`, and `refuse` answers one with a 409
async function mount(page: Page, { dirty = false, withAgent = false, calls = [], refuse, removal = {} }: { dirty?: boolean; withAgent?: boolean; calls?: Call[]; refuse?: string; removal?: Record<string, unknown> } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard(dirty, withAgent) });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [...lists.mine, ...lists.done], reviews: lists.reviews, issues: [], totals: { mine: lists.mine.length + lists.done.length, reviews: lists.reviews.length, issues: 0 }, fetchedAt: Date.now() } });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: lists });
    const number = /^\/api\/projects\/repo\/github\/pulls\/(\d+)$/u.exec(path)?.[1];
    if (number !== undefined) return route.fulfill({ json: details[number] });
    if (path.endsWith('/switch-prs') && request.method() === 'GET') return route.fulfill({ json: { enabled: !dirty } });
    if (path.startsWith('/api/worktrees/') && (request.method() !== 'GET' || path.endsWith('/removal'))) {
      calls.push({ method: request.method(), path, ...(request.postData() === null ? {} : { body: request.postDataJSON() }) });
      if (refuse !== undefined && path.endsWith(refuse)) return route.fulfill({ status: 409, json: { error: 'An agent in this worktree is busy. Wait for it to finish, then switch again.' } });
      if (path.endsWith('/removal')) return route.fulfill({ json: { main: false, detached: false, locked: false, branch: 'branch-203', dirtyCount: 0, pushed: true, merged: true, blockers: [], stopsProcesses: [], ...removal } });
      if (request.method() === 'DELETE') return route.fulfill({ json: { removed: true, branchDeleted: (request.postDataJSON() as { deleteBranch?: boolean }).deleteBranch === true } });
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
const panel = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true });
const strip = (page: Page) => page.locator('.github-detail .github-strip').first();
// identify blank rail coordinates without touching either real control
async function cardWhitespacePoints(row: Locator) {
  const controls = row.locator('.github-card-controls');
  const checkout = controls.getByRole('button').first();
  const external = controls.locator('.overview-row-browser');
  const [rowBox, controlsBox, checkoutBox, externalBox] = await Promise.all([
    row.boundingBox(), controls.boundingBox(), checkout.boundingBox(), external.boundingBox()
  ]);
  expect(rowBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(checkoutBox).not.toBeNull();
  expect(externalBox).not.toBeNull();
  return [
    { name: 'rail padding', x: controlsBox!.x + controlsBox!.width - 2, y: checkoutBox!.y + checkoutBox!.height / 2 },
    { name: 'control gap', x: checkoutBox!.x + checkoutBox!.width / 2, y: (checkoutBox!.y + checkoutBox!.height + externalBox!.y) / 2 },
    { name: 'below rail', x: checkoutBox!.x + checkoutBox!.width / 2, y: rowBox!.y + rowBox!.height - 4 }
  ];
}
// open the panel in one Worktree's Workspace and pick a pull request
async function show(page: Page, tab: RegExp, number: number) {
  await page.goto('/');
  await page.getByRole('tab', { name: tab }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('button', { name: new RegExp(`^#${number} `, 'u') }).click();
  await expect(page.locator('.github-detail').getByRole('heading')).toContainText(`#${number}`);
}

const matrixWorktree = (projectId: string, id: string, label: string, main: boolean, order: number) => ({ id, projectId, label, path: id.slice(id.indexOf(':') + 1), main, detached: false, locked: false, available: true, pinned: true, order, branch: main ? 'main' : 'branch-7', gitStatus: clean });
const alphaMain = matrixWorktree('a', 'a:/a', 'A Main', true, 0);
const bravoMain = matrixWorktree('b1', 'b1:/b1', 'B Main', true, 0);
// readiness, not detached metadata, decides checkout eligibility
const bravoAlt = { ...matrixWorktree('b1', 'b1:/b1/wts/alt', 'B Alt', false, 1), detached: true };
const bravoClone = matrixWorktree('b2', 'b2:/b2', 'B2 Main', true, 0);
const matrixDashboard = (targets = [bravoMain, bravoAlt, bravoClone]) => ({
  generation: 1,
  serverStartedAt: 1001,
  githubRevision: 1,
  agents: [],
  projects: [
    { id: 'a', label: 'Alpha', github: 'acme/a', available: true, manageWorktrees: true, worktrees: [alphaMain] },
    { id: 'b1', label: 'Bravo One', github: 'Acme/B', available: true, manageWorktrees: true, worktrees: targets.filter(target => target.projectId === 'b1') },
    ...targets.some(target => target.projectId === 'b2') ? [{ id: 'b2', label: 'Bravo Two', github: 'acme/b', available: true, manageWorktrees: true, worktrees: targets.filter(target => target.projectId === 'b2') }] : []
  ]
});
const matrixPull = (destination?: { kind: 'worktree' | 'project'; worktreeId: string; label: string }) => row(7, 'Same number in repository B', { repository: 'acme/b', url: 'https://github.com/acme/b/pull/7', ...(destination === undefined ? {} : { destination }) });

const forkMain = { ...matrixWorktree('fork', 'fork:/audiobookshelf', 'Fork Main', true, 0), branch: 'master' };
const forkFeature = { ...matrixWorktree('fork', 'fork:/audiobookshelf/wts/podcasts', 'Fork podcasts', false, 1), branch: 'ansel/continueSerialPodcasts' };
const upstreamPull = row(4978, 'Continue serial podcasts upstream', { repository: 'advplyr/audiobookshelf', url: 'https://github.com/advplyr/audiobookshelf/pull/4978' });

// serve a foreign Workspace beside one verified fork of the pull request repository
async function mountForkMatrix(page: Page, targets: Array<typeof forkMain>, calls: Call[], manageWorktrees = true) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // return the authenticated shell
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose only the server-verified parent hint
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 1001, githubRevision: 1, agents: [], projects: [
      { id: 'a', label: 'Alpha', github: 'acme/a', available: true, manageWorktrees: true, worktrees: [alphaMain] },
      { id: 'fork', label: 'Audiobookshelf', github: 'anstosa/audiobookshelf', githubForkOf: 'advplyr/audiobookshelf', available: true, manageWorktrees, ...(manageWorktrees ? {} : { manageWorktreesReason: 'Repository setup is unavailable' }), worktrees: targets }
    ] } });
    // keep push setup out of this checkout proof
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // return the upstream identity without rewriting it to the fork origin
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [upstreamPull], reviews: [], issues: [], totals: { mine: 1, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    // retain catalog compatibility for both projects
    if (/^\/api\/projects\/(?:a|fork)\/github$/u.test(path)) return route.fulfill({ json: { mine: [upstreamPull], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() } });
    // prove each target before checkout
    if (path.endsWith('/switch-prs') && request.method() === 'GET') return route.fulfill({ json: { enabled: true } });
    // capture exact contextual mutations
    if (/^\/api\/worktrees\/.+\/switch-pr$/u.test(path) && request.method() === 'POST') {
      calls.push({ method: 'POST', path, body: request.postDataJSON() });
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// serve the cross-repository destination matrix
async function mountMatrix(page: Page, { destination = { kind: 'project' as const, worktreeId: bravoMain.id, label: 'Bravo One' }, targets, availability = {}, calls = [], refuse }: { destination?: { kind: 'worktree' | 'project'; worktreeId: string; label: string }; targets?: Array<typeof bravoMain>; availability?: Record<string, boolean>; calls?: Call[]; refuse?: string } = {}) {
  const item = matrixPull(destination);
  const dashboardValue = matrixDashboard(targets);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // return the authenticated browser shell
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboardValue });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [item], reviews: [], issues: [], totals: { mine: 1, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    if (/^\/api\/projects\/(?:a|b1|b2)\/github$/u.test(path)) return route.fulfill({ json: { mine: [item], reviews: [], other: [], done: [], assigned: [], issues: [], fetchedAt: Date.now() } });
    if (/^\/api\/projects\/(?:b1|b2)\/github\/pulls\/7$/u.test(path)) return route.fulfill({ json: detail(7, 'Same number in repository B', { repository: 'acme/b', destination: destination.kind === 'worktree' ? { worktreeId: destination.worktreeId, label: destination.label } : undefined }) });
    const readiness = /^\/api\/worktrees\/(.+)\/switch-prs$/u.exec(path)?.[1];
    if (readiness !== undefined && request.method() === 'GET') return route.fulfill({ json: { enabled: availability[readiness] ?? true } });
    if (/^\/api\/worktrees\/.+\/(?:switch-pr|move-pr)$/u.test(path) && request.method() === 'POST') {
      calls.push({ method: 'POST', path, body: request.postDataJSON() });
      if (refuse !== undefined) return route.fulfill({ status: 409, json: { error: refuse, refresh: true } });
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open all repositories from alpha
async function showMatrix(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  const github = panel(page);
  await github.getByRole('button', { name: 'All repos' }).click();
  await expect(github.getByRole('button', { name: 'All repos' })).toHaveAttribute('aria-pressed', 'true');
  return github;
}

test('checks out here a pull request no Worktree holds', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls });
  await show(page, /^feature/u, 91);
  // one adjacent menu separates selection from checkout
  await expect(strip(page)).toContainText('Not checked out.');
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #91' }).getByRole('button', { name: /^Checkout here(?: Repo)?$/u }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/switch-pr', body: { number: 91, context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 91 }, targetProjectId: 'repo', targetWorktreeId: 'repo:/repo/wts/feature', expectedHolderWorktreeIds: [] } } }]);
});

test('checks out and moves pull requests here from a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: Call[] = [];
  await mount(page, { calls });
  // a phone's tabs are a sheet; a link picks the Workspace
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('tab', { name: /^Reviews/u }).click();
  await panel(page).getByRole('button', { name: /^#91 Retry webhooks/u }).click();
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #91' }).getByRole('button', { name: /^Checkout here(?: Repo)?$/u }).click();
  await page.locator('.github-detail').getByRole('button', { name: '‹ Back to cards' }).click();
  await panel(page).getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(strip(page)).toContainText('Checked out in other.');
  // nothing in the strip runs off the side of the screen
  expect(await strip(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #90' }).getByRole('button', { name: 'Move checkout here' }).click();
  await expect.poll(() => calls.map(call => call.path)).toEqual(['/api/worktrees/repo:/repo/wts/feature/switch-pr', '/api/worktrees/repo:/repo/wts/feature/move-pr']);
});

test('moves here a pull request another Worktree holds, saying when the switch refuses', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls, refuse: '/move-pr' });
  await show(page, /^feature/u, 90);
  await expect(strip(page)).toContainText('Checked out in other.');
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #90' }).getByRole('button', { name: 'Move checkout here' }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/move-pr', body: { number: 90, context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 90 }, targetProjectId: 'repo', targetWorktreeId: 'repo:/repo/wts/feature', expectedHolderWorktreeIds: ['repo:/repo/wts/other'], expectedSourceWorktreeId: 'repo:/repo/wts/other' } } }]);
  await expect(page.getByText('Pull request could not be moved')).toBeVisible();
  await expect(page.getByText('An agent in this worktree is busy. Wait for it to finish, then switch again.')).toBeVisible();
});

test('offers neither checkout while this Worktree has uncommitted changes, and says why', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, { dirty: true });
  await show(page, /^feature/u, 91);
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  const switchMenu = page.getByRole('group', { name: 'Actions for pull request #91' });
  await expect(switchMenu.getByRole('button', { name: /^Checkout here(?: Repo)?$/u })).toBeDisabled();
  await expect(switchMenu.getByRole('button', { name: /^Checkout here(?: Repo)?$/u })).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
  await page.keyboard.press('Escape');
  await panel(page).getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await strip(page).getByRole('button', { name: 'Checkout' }).click();
  const moveMenu = page.getByRole('group', { name: 'Actions for pull request #90' });
  await expect(moveMenu.getByRole('button', { name: 'Move checkout here' })).toBeDisabled();
  await expect(moveMenu.getByRole('button', { name: 'Move checkout here' })).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
});

// keep rail whitespace, the primary row and adjacent controls independent
test('opens desktop detail from card-rail whitespace while controls and keyboard stay independent', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  const popups: Page[] = [];
  page.on('popup', popup => popups.push(popup));
  await mount(page, { calls });
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  const primary = panel(page).getByRole('button', { name: /^#91 Retry webhooks/u });
  const row = primary.locator('..');
  await page.addStyleTag({ content: '.github-row { min-height: 12rem; }' });
  const trigger = row.getByRole('button', { name: 'Checkout and actions for pull request #91' });
  const external = row.getByRole('link', { name: 'Open #91 on GitHub' });
  const itemDetail = panel(page).locator('.github-detail');

  // every blank rail zone remains part of the real primary button
  for (const point of await cardWhitespacePoints(row)) {
    expect(await primary.evaluate((element, target) => document.elementFromPoint(target.x, target.y) === element, point), point.name).toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(itemDetail.getByRole('heading')).toContainText('#91Retry webhooks');
    expect(calls, point.name).toEqual([]);
    expect(popups, point.name).toEqual([]);
    await itemDetail.getByRole('button', { name: '‹ Back to cards' }).click();
  }

  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Actions for pull request #91' });
  await expect(menu.getByRole('button', { name: /^Checkout here(?: Repo)?$/u })).toBeVisible();
  await expect(itemDetail).toHaveCount(0);
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  await page.mouse.click(menuBox!.x + 3, menuBox!.y + 3);
  await expect(menu).toBeVisible();
  await expect(itemDetail).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();

  // exercise the external link without leaving the mocked browser
  await external.evaluate(element => element.addEventListener('click', event => event.preventDefault(), { once: true }));
  await external.click();
  await expect(itemDetail).toHaveCount(0);
  expect(popups).toEqual([]);

  await primary.focus();
  await primary.press('Enter');
  await expect(itemDetail.getByRole('heading')).toContainText('#91Retry webhooks');
  await itemDetail.getByRole('button', { name: '‹ Back to cards' }).click();
  await primary.focus();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(external).toBeFocused();
  expect(calls).toEqual([]);
});

test('opens phone detail from every blank card-rail zone without checkout or popup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: Call[] = [];
  const popups: Page[] = [];
  page.on('popup', popup => popups.push(popup));
  await mount(page, { calls });
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('tab', { name: /^Reviews/u }).click();
  await page.addStyleTag({ content: '.github-row { min-height: 12rem; }' });
  const primary = panel(page).getByRole('button', { name: /^#91 Retry webhooks/u });
  const row = primary.locator('..');
  const itemDetail = panel(page).locator('.github-detail');

  // phone hit testing matches desktop in every blank rail zone
  for (const point of await cardWhitespacePoints(row)) {
    expect(await primary.evaluate((element, target) => document.elementFromPoint(target.x, target.y) === element, point), point.name).toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(itemDetail.getByRole('heading')).toContainText('#91Retry webhooks');
    expect(calls, point.name).toEqual([]);
    expect(popups, point.name).toEqual([]);
    await itemDetail.getByRole('button', { name: '‹ Back to cards' }).click();
  }
});

// enumerate only repository b destinations with exact contextual writes
test('lists the full cross-repository dynamic matrix and posts only the paired B target', async ({ page }) => {
  const calls: Call[] = [];
  await mountMatrix(page, { calls });
  const github = await showMatrix(page);
  const trigger = github.getByRole('button', { name: 'Checkout and actions for pull request #7' });
  await trigger.click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #7' });
  await expect(menu.getByRole('link')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /^Checkout here/u })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /^Checkout in B Main/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in B Alt/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in B2 Main/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in a new Worktree in Bravo One/u })).toBeVisible();
  await expect(menu.getByText('A Main')).toHaveCount(0);
  await menu.getByRole('button', { name: /^Checkout in B Alt/u }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/b1:/b1/wts/alt/switch-pr', body: { number: 7, context: { identity: { repositoryKey: 'acme/b', kind: 'pull', number: 7 }, targetProjectId: 'b1', targetWorktreeId: 'b1:/b1/wts/alt', expectedHolderWorktreeIds: [] } } }]);
});

test('lists verified-fork targets from a foreign Workspace and preserves upstream checkout identity', async ({ page }) => {
  const calls: Call[] = [];
  await mountForkMatrix(page, [forkMain, forkFeature], calls);
  const github = await showMatrix(page);
  await github.getByRole('button', { name: 'Checkout and actions for pull request #4978' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #4978' });
  await expect(menu.getByRole('link')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /^Checkout here/u })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /^Checkout in Fork Main/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in Fork podcasts/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Checkout in a new Worktree in Audiobookshelf/u })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Start Review tour', exact: true })).toHaveCount(0);
  await expect(menu).not.toContainText('A Main');
  await menu.getByRole('button', { name: /^Checkout in Fork podcasts/u }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/fork:/audiobookshelf/wts/podcasts/switch-pr', body: { number: 4978, context: { identity: { repositoryKey: 'advplyr/audiobookshelf', kind: 'pull', number: 4978 }, targetProjectId: 'fork', targetWorktreeId: 'fork:/audiobookshelf/wts/podcasts', expectedHolderWorktreeIds: [] } } }]);
});

test('uses a verified fork as the sole direct target without adding a flyout marker', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.dynamic-worktrees', 'disabled'));
  const calls: Call[] = [];
  await mountForkMatrix(page, [forkMain], calls);
  const github = await showMatrix(page);
  const row = github.locator('.overview-row').filter({ hasText: '#4978' });
  const direct = row.getByRole('button', { name: 'Checkout in Fork Main' });
  await expect(direct).toBeEnabled();
  await expect(direct).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(direct.locator('.flyout-caret')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Checkout and actions for pull request #4978' })).toHaveCount(0);
  await expect(row.locator('.github-card-controls').locator('button, a')).toHaveCount(2);
  await expect(row.locator('.github-card-controls').getByRole('link', { name: /^(?:Merge|Ready for review|Submit review)$/u })).toHaveCount(0);
  await direct.click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/fork:/audiobookshelf/switch-pr', body: { number: 4978, context: { identity: { repositoryKey: 'advplyr/audiobookshelf', kind: 'pull', number: 4978 }, targetProjectId: 'fork', targetWorktreeId: 'fork:/audiobookshelf', expectedHolderWorktreeIds: [] } } }]);
});

test('does not broaden new-Worktree setup policy for a verified fork', async ({ page }) => {
  await mountForkMatrix(page, [forkMain], [], false);
  const github = await showMatrix(page);
  await github.getByRole('button', { name: 'Checkout and actions for pull request #4978' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #4978' });
  await expect(menu.getByRole('button', { name: /^Checkout in Fork Main/u })).toBeEnabled();
  const newWorktree = menu.getByRole('button', { name: /new Worktree/u });
  await expect(newWorktree).toHaveCount(1);
  await expect(newWorktree).toBeDisabled();
  await expect(newWorktree).toHaveAttribute('title', 'Repository setup is unavailable');
});

// suppress only new-worktree choices when dynamic worktrees are off
test('keeps every existing B target but no New choice when dynamic worktrees are off', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.dynamic-worktrees', 'disabled'));
  await mountMatrix(page);
  const github = await showMatrix(page);
  await github.getByRole('button', { name: 'Checkout and actions for pull request #7' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #7' });
  await expect(menu.getByRole('link')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /^Checkout in B Main/u })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^Checkout in B Alt/u })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^Checkout in B2 Main/u })).toBeVisible();
  await expect(menu.getByRole('button', { name: /New Worktree/u })).toHaveCount(0);
});

// keep same-repository compact mode direct while retaining full mutation context
test('directly switches and moves Here with context when dynamic worktrees are off', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.dynamic-worktrees', 'disabled'));
  const calls: Call[] = [];
  await mount(page, { calls });
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();

  const unheld = panel(page).locator('.overview-row').filter({ hasText: '#91' });
  const directCheckout = unheld.getByRole('button', { name: 'Checkout here' });
  await expect(directCheckout).toBeVisible();
  await expect(directCheckout).toHaveAttribute('title', 'Checkout here');
  await expect(directCheckout).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(directCheckout.locator('.flyout-caret')).toHaveCount(0);
  await expect(unheld.getByRole('button', { name: 'Checkout and actions for pull request #91' })).toHaveCount(0);
  await expect(unheld.locator('.github-card-controls').locator('button, a')).toHaveCount(2);
  await expect(unheld.locator('.github-card-controls').getByRole('link', { name: /^(?:Merge|Ready for review|Submit review)$/u })).toHaveCount(0);
  await directCheckout.click();

  const held = panel(page).locator('.overview-row').filter({ hasText: '#90' });
  const view = held.getByRole('button', { name: /^View in other/u });
  const directMove = held.getByRole('button', { name: 'Move checkout here' });
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('title', 'View in other · Repo');
  await expect(view).toHaveText('');
  await expect(directMove).toBeVisible();
  await expect(held.locator('.github-card-controls').locator('button, a')).toHaveCount(3);
  await expect(directMove).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(directMove.locator('.flyout-caret')).toHaveCount(0);
  await directMove.click();
  await expect.poll(() => calls).toEqual([
    { method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/switch-pr', body: { number: 91, context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 91 }, targetProjectId: 'repo', targetWorktreeId: 'repo:/repo/wts/feature', expectedHolderWorktreeIds: [] } } },
    { method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/move-pr', body: { number: 90, context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 90 }, targetProjectId: 'repo', targetWorktreeId: 'repo:/repo/wts/feature', expectedHolderWorktreeIds: ['repo:/repo/wts/other'], expectedSourceWorktreeId: 'repo:/repo/wts/other' } } }
  ]);
});

// use one direct foreign target only after its readiness read
test('uses the sole cross-repository target directly and disables it when readiness refuses', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.dynamic-worktrees', 'disabled'));
  const calls: Call[] = [];
  await mountMatrix(page, { calls, targets: [bravoMain], availability: { [bravoMain.id]: false } });
  const github = await showMatrix(page);
  const direct = github.getByRole('button', { name: 'Checkout in B Main' });
  await expect(direct).toBeDisabled();
  await expect(direct).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
  await expect(direct).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(direct.locator('.flyout-caret')).toHaveCount(0);
  expect(await direct.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await direct.click({ force: true });
  await expect(github.locator('.github-detail')).toHaveCount(0);
  expect(calls).toEqual([]);
});

// keep held-clone actions on the holder project and separate view from mutation
test('disables other-clone moves and View in the exact holder performs no POST', async ({ page }) => {
  const calls: Call[] = [];
  await mountMatrix(page, { calls, destination: { kind: 'worktree', worktreeId: bravoAlt.id, label: 'B Alt' } });
  const github = await showMatrix(page);
  await github.getByRole('button', { name: 'Checkout and actions for pull request #7' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #7' });
  await expect(menu.getByRole('button', { name: /^Move checkout to B Main/u })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Already checked out here/u })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /^Move checkout to B2 Main/u })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /^Move checkout to B2 Main/u })).toHaveAttribute('title', 'Checked out in Bravo One');
  await menu.getByRole('button', { name: /^View in B Alt/u }).click();
  await expect(page.getByRole('tab', { name: /^B Alt/u })).toHaveAttribute('aria-selected', 'true');
  expect(calls).toEqual([]);
});

test('offers a Review tour only on the pull request checked out here, once an Agent can run it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page);
  await show(page, /^feature/u, 214);
  await panel(page).getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  const cardReview = page.getByRole('group', { name: 'Actions for pull request #214' }).getByRole('button', { name: 'Start Review tour' });
  await expect(cardReview).toBeDisabled();
  await expect(cardReview).toHaveAttribute('title', 'Launch agent to review');
  await page.keyboard.press('Escape');
  await expect(strip(page)).toHaveText('Checked out here, in feature.Start Review tour');
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toBeDisabled();
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toHaveAttribute('title', 'Launch agent to review');
  // nowhere else
  await panel(page).getByRole('tab', { name: /^Reviews/u }).click();
  await panel(page).getByRole('button', { name: /^#90 Handle redacted events/u }).click();
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toHaveCount(0);
});

// highlight only the exact repository and worktree holder
test('marks the exact current holder and offers no checkout mutation', async ({ page }) => {
  const calls: Call[] = [];
  await mount(page, { calls });
  await show(page, /^feature/u, 214);
  const row = panel(page).locator('.overview-row.current-holder').filter({ hasText: '#214' });
  await expect(row).toContainText('here');
  await row.getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #214' });
  await expect(menu.getByRole('button', { name: 'Already checked out here' })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /^(?:Checkout here|Checkout in |Move checkout here|Move checkout to (?!a new Worktree))/u })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /^Move checkout to a new Worktree/u })).toHaveCount(1);
  await expect(strip(page).getByRole('button', { name: /Checkout|Move checkout here/u })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test('starts a Review tour of All PR changes from the held-here card', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, { withAgent: true });
  await show(page, /^feature/u, 214);
  await panel(page).getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #214' }).getByRole('button', { name: 'Start Review tour' }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
});

test('removes a merged pull request\'s Worktree through the Remove worktree dialog, its branch only when ticked', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls });
  await show(page, /^feature/u, 203);
  await expect(strip(page)).toHaveText('Merged 10m ago. Worktree shipped is still here.Remove Worktree…');
  const remove = strip(page).getByRole('button', { name: 'Remove Worktree…' });
  // orange, as the launcher's offer
  await expect(remove).toHaveCSS('background-color', 'rgb(250, 179, 135)');
  // Cancel leaves everything as it was
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toContainText('shipped');
  await expect(dialog.getByLabel(/Also delete branch branch-203/u)).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await remove.click();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => calls.map(call => `${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`)).toEqual([
    'GET /api/worktrees/repo:/repo/wts/shipped/removal null',
    'GET /api/worktrees/repo:/repo/wts/shipped/removal null',
    'DELETE /api/worktrees/repo:/repo/wts/shipped {"discardChanges":false,"deleteBranch":false}'
  ]);
  await expect(page.getByText('shipped was removed.')).toBeVisible();
});

test('will not remove a Worktree the removal would harm, saying why', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, { removal: { dirtyCount: 2, pushed: false, merged: false, blockers: ['a running agent'], stopsProcesses: ['web'] } });
  // a phone's tabs are a sheet; a link picks the Workspace
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('button', { name: /^#203 Scheduled prompts/u }).click();
  await strip(page).getByRole('button', { name: 'Remove Worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Cannot remove while a running agent is running.');
  await expect(dialog).toContainText('2 uncommitted changes');
  await expect(dialog).toContainText('branch-203 is neither pushed nor merged.');
  await expect(dialog).toContainText('Stops web, its running Stack process');
  await expect(dialog.getByLabel(/Also delete branch branch-203/u)).not.toBeChecked();
});
