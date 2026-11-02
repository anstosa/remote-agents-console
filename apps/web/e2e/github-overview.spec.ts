import { expect, test, type Locator, type Page } from '@playwright/test';

// The Overview command opens the current Workspace's GitHub split maximized. Repository and
// all-repository scopes share the operator's pull requests, Review requests and assigned Issues.

const dashboard = {
  generation: 1,
  serverStartedAt: 1001,
  githubRevision: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', github: 'octo/repo', available: true, manageWorktrees: true, worktrees: [
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

const sameNumberAcrossRepositories = {
  mine: [
    { repository: 'octo/repo', number: 7, title: 'Local seven', url: 'https://github.com/octo/repo/pull/7', updatedAt: minutesAgo(2), reasons: [], destination: project },
    { repository: 'acme/web', number: 7, title: 'Foreign seven', url: 'https://github.com/acme/web/pull/7', updatedAt: minutesAgo(1), reasons: [] }
  ],
  reviews: [
    { repository: 'octo/repo', number: 8, title: 'Local review', url: 'https://github.com/octo/repo/pull/8', author: 'kai', updatedAt: minutesAgo(3), reasons: [{ kind: 'review' }], destination: project },
    { repository: 'acme/web', number: 8, title: 'Foreign review', url: 'https://github.com/acme/web/pull/8', author: 'lee', updatedAt: minutesAgo(4), reasons: [{ kind: 'review' }] }
  ],
  issues: [
    { repository: 'octo/repo', number: 9, title: 'Local issue', url: 'https://github.com/octo/repo/issues/9', author: 'jo', updatedAt: minutesAgo(5), reasons: [], destination: project },
    { repository: 'acme/web', number: 9, title: 'Foreign issue', url: 'https://github.com/acme/web/issues/9', author: 'sam', updatedAt: minutesAgo(6), reasons: [] }
  ],
  totals: { mine: 2, reviews: 2, issues: 2 },
  fetchedAt: Date.now()
};

const legacyCatalog = {
  mine: busy.mine.filter(item => item.repository === 'octo/repo'),
  reviews: busy.reviews.filter(item => item.repository === 'octo/repo'),
  other: [{ repository: 'octo/repo', number: 777, title: 'Catalog-only pull request', url: 'https://github.com/octo/repo/pull/777', updatedAt: minutesAgo(7), reasons: [] }],
  done: [],
  assigned: [],
  issues: busy.issues,
  fetchedAt: Date.now()
};

type DetailMocks = {
  reads: string[];
  responses: Record<string, unknown>;
  checkoutPosts: string[];
};

// build one repository-addressed detail fixture
const repositoryPullDetail = (repository: string, number: number, title: string) => ({
  fetchedAt: Date.now(),
  pullRequest: {
    repository, number, title, url: `https://github.com/${repository}/pull/${number}`, state: 'open', draft: false, author: 'tony', mine: true, updatedAt: minutesAgo(1),
    branch: `branch-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40), headOnOrigin: true, mergeable: 'mergeable', checks: 'passed',
    description: undefined,
    threads: [{ id: 'foreign-thread', path: 'src/search.ts', line: 12, resolved: false, outdated: false, diffHunk: '@@ -12 +12 @@\n+debounce()', comments: [{ id: 'foreign-comment', author: 'lee', bot: false, mine: false, body: 'Can this wait for input?', createdAt: minutesAgo(2), url: `https://github.com/${repository}/pull/${number}#discussion_r1` }] }],
    reviews: [], comments: [], checkRuns: [], reviewers: [{ login: 'lee', id: 'U_lee', state: 'approved', newCommits: true }], linkedIssues: []
  }
});

// stub the console; `overviews` answer each Overview read in turn (the last repeats), and the
// dashboard reports `github.revision` and `github.badge`; each mark-seen report lands in `seen`
async function mount(page: Page, overviews: unknown[], reads: string[] = [], github: { revision: number; badge?: number; seen?: string[][] } = { revision: 1 }, snapshot: typeof dashboard = dashboard, detailMocks?: DetailMocks) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { ...snapshot, githubRevision: github.revision, githubBadge: github.badge } });
    if (path === '/api/github/overview/seen') {
      github.seen?.push((route.request().postDataJSON() as { keys: string[] }).keys);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: legacyCatalog });
    if (detailMocks !== undefined && (/^\/api\/github\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+$/u.test(path) || /^\/api\/projects\/[^/]+\/github\/(?:pulls|issues)\/\d+$/u.test(path))) {
      detailMocks.reads.push(path);
      const response = detailMocks.responses[path];
      return response === undefined ? route.fulfill({ status: 404, json: { error: 'detail not mocked' } }) : route.fulfill({ json: response });
    }
    if (detailMocks !== undefined && request.method() === 'POST' && /^\/api\/worktrees\/.+\/(?:switch-pr|move-pr)$/u.test(path)) {
      detailMocks.checkoutPosts.push(path);
      return route.fulfill({ status: 202 });
    }
    if (path === '/api/github/overview') {
      reads.push(url.search);
      const next = overviews.length > 1 ? overviews.shift() : overviews[0];
      return next === 'pending' ? undefined : route.fulfill({ json: next });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// prove the grid consumes the panel instead of leaving an empty row below the cards
async function expectGithubBodyFillsPanel(page: Page) {
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  const [panelBox, bodyBox] = await Promise.all([panel.boundingBox(), panel.locator('.github-pane-body').boundingBox()]);
  expect(panelBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(Math.abs(bodyBox!.y + bodyBox!.height - (panelBox!.y + panelBox!.height))).toBeLessThanOrEqual(1);
}

// prove card icons are independent standard controls in one top-right column
async function expectCardControlColumn(row: Locator, minimum = 1) {
  const column = row.locator('.github-card-controls');
  const controls = column.locator('button, a');
  await expect(controls).toHaveCount(minimum);
  const [rowBox, columnBox, geometry] = await Promise.all([row.boundingBox(), column.boundingBox(), controls.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const copy = element.cloneNode(true) as Element;
    // ignore allowed assistive-only labels
    copy.querySelectorAll('.sr-only').forEach(label => label.remove());
    return {
      x: box.x, y: box.y, width: box.width, height: box.height,
      border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(Number.parseFloat),
      radius: Number.parseFloat(style.borderTopLeftRadius),
      label: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      text: copy.textContent?.trim() ?? ''
    };
  }))]);
  expect(rowBox).not.toBeNull();
  expect(columnBox).not.toBeNull();
  expect(Math.abs(columnBox!.y - rowBox!.y)).toBeLessThanOrEqual(1);
  // compare every icon with the shared control contract
  for (const [index, control] of geometry.entries()) {
    expect(control.width).toBeCloseTo(41.6, 0);
    expect(control.height).toBeCloseTo(41.6, 0);
    expect(control.width).toBeCloseTo(control.height, 1);
    expect(Math.abs(control.x - geometry[0]!.x)).toBeLessThanOrEqual(1);
    expect(control.border.every(width => width > 0)).toBe(true);
    expect(control.radius).toBeGreaterThan(0);
    expect(control.label).toBeTruthy();
    expect(control.title).toBeTruthy();
    expect(control.text).toBe('');
    // keep neighboring controls visually separate
    if (index > 0) expect(control.y).toBeGreaterThanOrEqual(geometry[index - 1]!.y + geometry[index - 1]!.height);
  }
}

// title pills use the same content inset at both horizontal edges
for (const width of [390, 1280]) {
  // cover the shared title pill in phone and desktop layouts
  test(`uses equal horizontal split-title spacing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, [busy]);
    await page.goto('/#overview');
    const title = page.getByRole('region', { name: 'GitHub', exact: true }).locator('.panel-header-title');
    await expect(title).toBeVisible();
    const spacing = await title.evaluate(element => {
      // compare border-adjusted content insets rather than font glyph bounds
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const content = element.firstElementChild!.getBoundingClientRect();
      return {
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        left: content.left - bounds.left - Number.parseFloat(style.borderLeftWidth),
        right: bounds.right - content.right - Number.parseFloat(style.borderRightWidth)
      };
    });
    expect(spacing.paddingLeft).toBeCloseTo(spacing.paddingRight, 2);
    expect(Math.abs(spacing.left - spacing.right)).toBeLessThanOrEqual(.5);
  });
}

// preserve mobile launch access while matching the main row's shared icon geometry
test('hides the mobile plus and keeps Overview icons at the standard control size', async ({ page }, testInfo) => {
  await mount(page, [busy], [], { revision: 1, badge: 2 });
  await page.goto('/');
  const overview = page.getByRole('button', { name: 'Overview, 2 new', exact: true });
  const plus = page.locator('.new-agent-tab');
  const settings = page.locator('.tabs .server-switcher-settings');
  // cover small phones and both sides of the existing mobile breakpoint
  for (const width of [320, 390, 600, 768, 769, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    // icon mode must neither shrink nor stretch around its badge
    if (width <= 768) {
      await expect(overview).toHaveText('2');
      await expect(plus).toBeHidden();
      const [icon, peer] = await Promise.all([overview.boundingBox(), settings.boundingBox()]);
      expect(icon!.width).toBeCloseTo(peer!.width, 1);
      expect(icon!.height).toBeCloseTo(peer!.height, 1);
      expect(icon!.width).toBeCloseTo(icon!.height, 1);
      await expect(overview.locator('.overview-badge.corner')).toHaveText('2');
      // New Workspace remains reachable without the hidden main plus
      await page.locator('.workspace-dropdown').click();
      await page.getByRole('button', { name: /New Workspace/u }).click();
      const launcher = page.getByRole('group', { name: 'Agent launcher' });
      await expect(launcher).toBeVisible();
      const [menu, row] = await Promise.all([launcher.boundingBox(), page.locator('.tabs').boundingBox()]);
      expect(menu!.y).toBeGreaterThanOrEqual(0);
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(row!.y);
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
      await expect(launcher).toHaveCount(0);
      // retain the exact breakpoint render for review
      if (width === 768) await page.screenshot({ path: testInfo.outputPath('overview-toolbar-768.png') });
    } else {
      // desktop retains its labeled Overview and direct launch action
      await expect(plus).toBeVisible();
      await expect(overview).toHaveText('Overview2');
      // retain the first desktop-boundary render for review
      if (width === 769) await page.screenshot({ path: testInfo.outputPath('overview-toolbar-769.png') });
    }
  }
});

// keep both scopes inside the same Workspace-owned github split
test('opens Overview maximized in repo scope and switches to the identical all-repos swimlanes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rac.github-scope:repo:/repo', 'all'));
  await mount(page, [busy]);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Overview', exact: true });

  await button.click();
  await expect(page).toHaveURL(/#worktree=repo%3A%2Frepo$/u);
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(overview).toHaveClass(/\bexpanded\b/u);
  await expectGithubBodyFillsPanel(page);
  const scope = overview.getByRole('group', { name: 'GitHub scope' });
  await expect(scope.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(overview.getByText('updated just now')).toBeVisible();
  // desktop maximize hides sibling panels without replacing the workspace chrome
  await expect(page.locator('.workspace-toolbar')).toBeVisible();
  await expect(page.locator('.log-shell')).toHaveCount(1);
  await expect(page.locator('.github-pane')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^feature/u })).toBeVisible();

  // repo scope is the same three-lane board, filtered to one canonical repository
  const labels = ['My pull requests', 'Review requests', 'Assigned issues'];
  await expect(overview.locator('.overview-column')).toHaveCount(3);
  await expect(overview.locator('.overview-column-head h3')).toHaveText(labels);
  await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['3', '2', '1']);
  await expect(overview).not.toContainText('acme/web');
  await expect(overview).not.toContainText('Catalog-only pull request');

  await scope.getByRole('button', { name: 'All repos' }).click();
  await expect(scope.getByRole('button', { name: 'All repos' })).toHaveAttribute('aria-pressed', 'true');
  await expect(overview.locator('.overview-column')).toHaveCount(3);
  await expect(overview.locator('.overview-column-head h3')).toHaveText(labels);
  await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['4', '3', '1']);

  const mine = overview.getByRole('region', { name: 'My pull requests' });
  await expect(mine.locator('.overview-column-head')).toContainText('My pull requests4');
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
  await expectCardControlColumn(own, 2);
  const ownCheckout = own.getByRole('button', { name: 'Checkout and actions for pull request #214' });
  await expect(ownCheckout).toHaveAttribute('aria-expanded', 'false');
  await expect(ownCheckout.locator('.flyout-caret')).toBeVisible();
  await expect(own.locator('.github-card-controls').getByRole('link', { name: /^(?:Merge|Ready for review|Submit review)$/u })).toHaveCount(0);
  await expect(mine.locator('.overview-row').nth(1)).toContainText('merge conflicts');
  await expect(mine.locator('.overview-row').nth(2)).toContainText('approved');
  await expect(mine.locator('.overview-row').nth(3)).toContainText('checks failing@lee requested changes');
  await expect(mine.locator('.overview-row').nth(3).locator('.overview-destination')).toHaveText('No local Project');

  const reviews = overview.getByRole('region', { name: 'Review requests' });
  await expect(reviews.locator('.overview-row').first()).toContainText('@sam');
  await expect(reviews.locator('.overview-row').first()).toContainText('Re-requestednew commits since your review');
  await expect(reviews.locator('.overview-row').nth(1)).toContainText('Review requested');
  await expect(reviews.locator('.overview-row').nth(2)).toContainText('draft');
  const issues = overview.getByRole('region', { name: 'Assigned issues' });
  await expect(issues.locator('.overview-row')).toHaveText(['#201GitHub PR dashboard@tony6m#214featurefeature']);

  // every main row opens detail; its dedicated external link remains a separate icon
  const externalLinks = overview.locator('.overview-row .github-card-controls > .overview-row-browser');
  await expect(externalLinks).toHaveCount(8);
  expect(await externalLinks.evaluateAll(links => links.every(link => link instanceof HTMLAnchorElement && link.target === '_blank' && link.rel === 'noreferrer'))).toBe(true);
  const foreignRow = mine.locator('.overview-row').filter({ hasText: '#1412' });
  await expect(foreignRow.getByRole('button', { name: /^#1412 Debounce the search input/u })).toBeVisible();
  const foreignExternal = foreignRow.getByRole('link', { name: 'Open #1412 on GitHub' });
  await expect(foreignExternal).toHaveAttribute('href', 'https://github.com/acme/web/pull/1412');
  await expect(mine.getByRole('link', { name: 'Open #214 on GitHub' })).toHaveAttribute('href', 'https://github.com/octo/repo/pull/214');
  await expectCardControlColumn(foreignRow, 2);
  await expect(foreignRow.locator('.github-card-controls').getByRole('link', { name: /^(?:Merge|Ready for review|Submit review)$/u })).toHaveCount(0);
  const unavailableCheckout = foreignRow.locator('.github-card-controls').getByRole('button');
  await expect(unavailableCheckout).toBeDisabled();
  await expect(unavailableCheckout).not.toHaveAttribute('aria-expanded', /.+/u);
  await expect(unavailableCheckout.locator('.flyout-caret')).toHaveCount(0);
  const [checkoutBox, externalBox] = await Promise.all([
    foreignRow.locator('.github-card-controls').boundingBox(),
    foreignExternal.boundingBox()
  ]);
  expect(checkoutBox).not.toBeNull();
  expect(externalBox).not.toBeNull();
  expect(Math.abs(externalBox!.x - checkoutBox!.x)).toBeLessThanOrEqual(1);
  expect(externalBox!.y).toBeGreaterThan(checkoutBox!.y);

  // restore keeps the same split and its all-repository state
  await page.keyboard.press('Escape');
  await expect(overview).not.toHaveClass(/\bexpanded\b/u);
  await expect(overview).toBeVisible();
  await expect(page.locator('.workspace-toolbar')).toBeVisible();
  await expect(overview.getByRole('button', { name: 'All repos' })).toHaveAttribute('aria-pressed', 'true');

  // keep the blank area beside a tall control stack inside the detail target
  const foreignMain = foreignRow.locator('.overview-row-main');
  const [foreignRowBox, foreignMainBox] = await Promise.all([foreignRow.boundingBox(), foreignMain.boundingBox()]);
  expect(foreignRowBox).not.toBeNull();
  expect(foreignMainBox).not.toBeNull();
  expect(foreignRowBox!.height - foreignMainBox!.height).toBeCloseTo(2, 0);
  await foreignMain.click({ position: { x: 8, y: foreignMainBox!.height - 3 } });
  await expect(foreignMain).toHaveAttribute('aria-current', 'true');
  await expect(overview.locator('.github-detail')).toBeVisible();
});

test('keeps a long branch below usable title copy in a 1280px swim lane', async ({ page }) => {
  const longBranch = 'ansel/continueSerialPodcasts-with-a-long-upstream-branch';
  const longDestination = { kind: 'worktree', worktreeId: 'repo:/repo', label: longBranch };
  const longBranchOverview = {
    ...busy,
    mine: busy.mine.map(item => item.number === 220
      ? { ...item, title: 'Continue serial podcasts upstream', destination: longDestination }
      : item)
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [longBranchOverview]);
  await page.goto('/#overview');

  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  const row = github.locator('.overview-row').filter({ hasText: '#220' });
  const geometry = await row.evaluate(element => {
    const main = element.querySelector<HTMLElement>('.overview-row-main')!;
    const copy = element.querySelector<HTMLElement>('.overview-row-copy')!;
    const title = element.querySelector<HTMLElement>('.overview-row-title')!;
    const destination = element.querySelector<HTMLElement>('.overview-destination')!;
    const style = getComputedStyle(main);
    const mainBox = main.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const destinationBox = destination.getBoundingClientRect();
    return {
      contentWidth: mainBox.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      copyWidth: copyBox.width,
      titleWidth: titleBox.width,
      copyBottom: copyBox.bottom,
      destinationTop: destinationBox.top
    };
  });
  await expect(row.locator('.overview-destination')).toHaveText(longBranch);
  expect(geometry.copyWidth).toBeGreaterThan(200);
  expect(geometry.copyWidth / geometry.contentWidth).toBeGreaterThan(.85);
  expect(geometry.titleWidth).toBeGreaterThan(200);
  expect(geometry.destinationTop).toBeGreaterThanOrEqual(geometry.copyBottom);
});

test('opens same-number repository rows in isolated local detail without conflating repo scope', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const detailMocks: DetailMocks = {
    reads: [],
    checkoutPosts: [],
    responses: {
      '/api/github/repos/acme/web/pulls/7': repositoryPullDetail('acme/web', 7, 'Foreign seven'),
      '/api/projects/repo/github/pulls/7': repositoryPullDetail('octo/repo', 7, 'Local seven')
    }
  };
  await mount(page, [sameNumberAcrossRepositories], [], { revision: 1 }, dashboard, detailMocks);
  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'GitHub', exact: true }).click();
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  const scope = github.getByRole('group', { name: 'GitHub scope' });

  await expect(scope.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(github.locator('.overview-column-head .overview-count')).toHaveText(['1', '1', '1']);
  await expect(github).toContainText('Local seven');
  await expect(github).not.toContainText('Foreign seven');
  await expect(github).not.toContainText('Foreign review');
  await expect(github).not.toContainText('Foreign issue');

  await scope.getByRole('button', { name: 'All repos' }).click();
  await expect(github.locator('.overview-column-head .overview-count')).toHaveText(['2', '2', '2']);
  const local = github.getByRole('button', { name: /^#7 Local seven/u });
  const foreign = github.getByRole('button', { name: /^#7 Foreign seven/u });
  await expect(local).toBeVisible();
  await expect(foreign).toBeVisible();

  const foreignRow = foreign.locator('..');
  const foreignExternal = foreignRow.getByRole('link', { name: 'Open #7 on GitHub' });
  await expect(foreignExternal).toHaveAttribute('href', 'https://github.com/acme/web/pull/7');
  await expect(foreignExternal).toHaveAttribute('target', '_blank');
  await expect(foreignExternal).toHaveAttribute('rel', 'noreferrer');
  // exercise the external control without allowing the test browser to leave the console
  await foreignExternal.evaluate(element => element.addEventListener('click', event => event.preventDefault(), { once: true }));
  await foreignExternal.click();
  await expect(foreign).not.toHaveAttribute('aria-current', 'true');
  expect(detailMocks.reads).toEqual([]);
  expect(detailMocks.checkoutPosts).toEqual([]);

  let popupOpened = false;
  // a main-row click must never inherit the external anchor's popup behavior
  page.on('popup', popup => { popupOpened = true; void popup.close(); });
  const consoleUrl = page.url();
  await foreign.click();
  const foreignDetail = github.getByRole('article', { name: 'Pull request #7' });
  await expect(foreignDetail.getByRole('heading')).toHaveText('#7Foreign seven');
  expect(page.url()).toBe(consoleUrl);
  expect(popupOpened).toBe(false);
  expect(detailMocks.reads).toEqual(['/api/github/repos/acme/web/pulls/7']);
  expect(detailMocks.checkoutPosts).toEqual([]);
  await expect(foreignDetail.getByRole('button', { name: 'Checkout' })).toHaveCount(0);
  const foreignThread = foreignDetail.getByRole('article', { name: 'Review thread on src/search.ts' });
  const reply = foreignThread.getByRole('button', { name: 'Reply', exact: true });
  const resolve = foreignThread.getByRole('button', { name: 'Resolve' });
  const rerequest = foreignDetail.getByRole('button', { name: 'Re-request review from @lee' });
  await expect(reply).toBeDisabled();
  await expect(resolve).toBeDisabled();
  await expect(rerequest).toBeDisabled();
  await expect(reply).toHaveAttribute('title', /Project/u);
  await expect(resolve).toHaveAttribute('title', /Project/u);
  await expect(rerequest).toHaveAttribute('title', /Project/u);

  await foreignDetail.getByRole('button', { name: '‹ Back to cards' }).click();
  await local.click();
  const localDetail = github.getByRole('article', { name: 'Pull request #7' });
  await expect(localDetail.getByRole('heading')).toHaveText('#7Local seven');
  expect(detailMocks.reads).toEqual(['/api/github/repos/acme/web/pulls/7', '/api/projects/repo/github/pulls/7']);
  await localDetail.getByRole('button', { name: '‹ Back to cards' }).click();

  await scope.getByRole('button', { name: 'repo', exact: true }).click();
  await expect(github.locator('.overview-column-head .overview-count')).toHaveText(['1', '1', '1']);
  await expect(github).not.toContainText('Foreign seven');
});

// consume the old address without resurrecting a standalone page
test('consumes #overview into the retained GitHub split and ordinary close and reopen stay in the Workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, [busy]);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(overview).toBeVisible();
  await expect(page).toHaveURL(/#worktree=repo%3A%2Frepo$/u);
  await page.keyboard.press('Escape');
  await expect(overview).toBeVisible();
  await expect(overview).not.toHaveClass(/\bexpanded\b/u);
  await expect(page).not.toHaveURL(/#overview$/u);

  await overview.getByRole('button', { name: 'Close GitHub panel' }).click();
  await expect(overview).toHaveCount(0);
  // the ordinary toolbar reopens the retained split without maximizing it
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(overview).toBeVisible();
  await expect(overview).not.toHaveClass(/\bexpanded\b/u);
  await expect(overview.getByRole('button', { name: 'repo', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // a flyout still owns escape before a later overview command
  await overview.getByRole('button', { name: 'Close GitHub panel' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toHaveCount(0);
  await expect(overview).toBeVisible();
});

test('disables Overview when no place can own the GitHub split', async ({ page }) => {
  await mount(page, [busy], [], { revision: 1 }, { ...dashboard, projects: [] });
  await page.goto('/#overview');
  const overview = page.getByRole('button', { name: 'Overview', exact: true });
  await expect(overview).toBeDisabled();
  await expect(overview).toHaveAttribute('title', 'Open a Workspace first');
  await expect(page.getByRole('region', { name: 'GitHub', exact: true })).toHaveCount(0);
});

test('shows the columns as tabs on a phone, each with its total and how many are waiting on me', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, [busy]);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Overview', exact: true });
  await expect(button).toHaveText('');
  await button.click();
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await overview.getByRole('button', { name: 'All repos' }).click();
  await expect(page.locator('.tabs')).toBeHidden();
  await expect(page.locator('.workspace-toolbar')).toBeHidden();
  const tabs = overview.locator('.overview-tabs').getByRole('tab');
  await expect(tabs.locator('.overview-count')).toHaveText(['4', '3', '1']);
  await expect(tabs.first()).toHaveAccessibleName('Mine 4');
  await expect(tabs.nth(2)).toHaveAccessibleName('Issues 1');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(overview.locator('.overview-row-number')).toHaveText(['#214', '#220', '#199', '#1412']);
  await expectCardControlColumn(overview.locator('.overview-row').first(), 2);
  await tabs.nth(1).click();
  await expect(overview.locator('.overview-row-number')).toHaveText(['#1420', '#90', '#91']);
  await tabs.nth(2).click();
  await expect(overview.locator('.overview-row-number')).toHaveText(['#201']);
  // nothing in the Overview runs off the side of the screen
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  // restore keeps the selected github content and returns the phone chrome
  await page.keyboard.press('Escape');
  await expect(page.locator('.tabs')).toBeVisible();
  await expect(page.locator('.workspace-toolbar')).toBeVisible();
  await expect(overview).toBeVisible();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
});

// empty data preserves the same board in either scope
test('keeps empty swim lanes visible in repository and all scope', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const empty = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() };
  await mount(page, [empty]);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  // changing scope never replaces empty lane shells
  for (const scope of ['repo', 'All repos', 'repo']) {
    await overview.getByRole('group', { name: 'GitHub scope' }).getByRole('button', { name: scope, exact: true }).click();
    await expect(overview.locator('.overview-column-head h3')).toHaveText(['My pull requests', 'Review requests', 'Assigned issues']);
    await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['0', '0', '0']);
    await expect(overview.locator('.overview-column-body')).toHaveText(['', '', '']);
    await expect(overview.locator('.overview-row, .overview-none')).toHaveCount(0);
    await expect(overview.getByRole('heading', { name: 'Nothing open' })).toHaveCount(0);
    await expectGithubBodyFillsPanel(page);
  }
});

// a repository filter can empty the board without hiding its columns
test('keeps empty repository lanes while other repositories have items', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const foreign = { ...busy, mine: busy.mine.filter(item => item.repository === 'acme/web'), reviews: busy.reviews.filter(item => item.repository === 'acme/web'), issues: [], totals: { mine: 1, reviews: 1, issues: 0 } };
  await mount(page, [foreign]);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(overview.locator('.overview-column-body')).toHaveText(['', '', '']);
  await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['0', '0', '0']);
  await overview.getByRole('button', { name: 'All repos' }).click();
  await expect(overview.locator('.overview-row')).toHaveCount(2);
  await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['1', '1', '0']);
  await expect(overview.getByRole('region', { name: 'Assigned issues' }).locator('.overview-column-body')).toBeEmpty();
  await overview.getByRole('group', { name: 'GitHub scope' }).getByRole('button', { name: 'repo', exact: true }).click();
  await expect(overview.locator('.overview-column-body')).toHaveText(['', '', '']);
});

// phone lanes remain reachable through their existing tabbed layout
test('keeps empty swim-lane tabs available on a phone in both scopes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const empty = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() };
  await mount(page, [empty]);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  // both scopes retain all three empty tabs
  for (const scope of ['repo', 'All repos']) {
    await overview.getByRole('group', { name: 'GitHub scope' }).getByRole('button', { name: scope, exact: true }).click();
    const tabs = overview.getByRole('tablist', { name: 'GitHub lists' });
    await expect(tabs.getByRole('tab')).toHaveText(['Mine0', 'Reviews0', 'Issues0']);
    // selecting an empty lane still renders its shell
    for (const [tab, lane] of [['Mine', 'My pull requests'], ['Reviews', 'Review requests'], ['Issues', 'Assigned issues']]) {
      await tabs.getByRole('tab', { name: `${tab} 0`, exact: true }).click();
      await expect(overview.getByRole('region', { name: lane, exact: true })).toBeVisible();
      await expect(overview.locator('.overview-column-body')).toBeEmpty();
      await expect(overview.locator('.overview-row, .overview-none')).toHaveCount(0);
    }
    expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test('shows skeletons while loading, a card without a token, empty lanes, and a stale banner with Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reads: string[] = [];
  const stale = { ...busy, fetchedAt: Date.now() - 6 * 60_000, problem: { kind: 'failing', message: 'GitHub could not read pull requests (502).' } };
  const empty = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() };
  const noToken = { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, problem: { kind: 'no-token', message: 'GitHub authentication is not configured.' } };
  await mount(page, [stale, empty, noToken], reads);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await overview.getByRole('button', { name: 'All repos' }).click();
  await expect(overview.getByRole('status')).toHaveText('GitHub is unreachable. Showing what was fetched 6m ago.Retry');
  await expectGithubBodyFillsPanel(page);
  await expect(overview.locator('.overview-row')).toHaveCount(8);
  await overview.getByRole('button', { name: 'Retry' }).click();
  await expect(overview.locator('.overview-column-body')).toHaveText(['', '', '']);
  await expect(overview.locator('.overview-column-head .overview-count')).toHaveText(['0', '0', '0']);
  expect(reads).toEqual(['', '?refresh=1']);
  await overview.getByRole('button', { name: 'Refresh' }).click();
  await expect(overview.getByRole('heading', { name: 'No GitHub token' })).toBeVisible();
  await expect(overview).toContainText('gh auth login');
  await expect(overview).toContainText('RAC_GITHUB_TOKEN');
});

test('shows skeleton rows until the first read lands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, ['pending']);
  await page.goto('/#overview');
  await expect(page.getByRole('status', { name: 'Loading GitHub' })).toBeVisible();
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
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await overview.getByRole('button', { name: 'All repos' }).click();
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
  expect(github.seen).toHaveLength(1);

  // a new visit starts without them
  await overview.getByRole('button', { name: 'Close GitHub panel' }).click();
  await button.click();
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
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await overview.getByRole('button', { name: 'All repos' }).click();
  const tabs = overview.locator('.overview-tabs').getByRole('tab');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(overview.locator('.overview-row.new .overview-row-number')).toHaveText(['#90']);
  await expect.poll(() => github.seen).toEqual([['octo/repo#90:review:q']]);
});

test('leaves rows on a phone tab not yet opened unseen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const github = { revision: 1, badge: 2, seen: [] as string[][] };
  await mount(page, [unseenRows(busy, { 220: ['octo/repo#220:conflicts'], 90: ['octo/repo#90:review:q'] })], [], github);
  await page.goto('/#overview');
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await overview.getByRole('button', { name: 'All repos' }).click();
  const tabs = overview.locator('.overview-tabs').getByRole('tab');
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
  const overview = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(overview.getByRole('button', { name: '#220 Bottom status bar, new, details' })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(github.seen).toEqual([]);
  await page.evaluate(() => { (window as { shown?: boolean }).shown = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => github.seen.flat().sort()).toEqual(['octo/repo#220:conflicts', 'octo/repo#90:review:q']);
});
