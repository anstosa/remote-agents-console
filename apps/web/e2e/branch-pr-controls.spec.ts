import { expect, test, type Locator, type Page } from '@playwright/test';

type DashboardMount = {
  dashboard: unknown;
  onPrompt?: (body: unknown) => void | Promise<void>;
  onHistoryRequest?: () => void;
};

const emptyButtonSlots = () => ({
  tabLead: [], leftNav: [], rightNav: [], navMenu: [], pullRequest: [],
  'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': []
});
const pullRequestButtons = [
  { id: 'push-project', text: 'Finish and PR', icon: 'M12 16V4m0 0-5 5m5-5 5 5M5 14v5h14v-5', color: 'mauve', style: 'solid', actionKind: 'prompt' },
  { id: 'fixup-project', text: '$fixup', color: 'mauve', style: 'outline', actionKind: 'prompt' }
];
const buttonCatalog = { revision: 'buttons-v1', application: { ...emptyButtonSlots(), pullRequest: pullRequestButtons }, projects: { repo: { ...emptyButtonSlots(), pullRequest: pullRequestButtons } } };

// fail explicitly when layout geometry is unavailable
async function renderedBox(locator: Locator) {
  const box = await locator.boundingBox();
  // require a rendered element
  if (box === null) throw new Error(`Rendered bounds unavailable for ${await locator.evaluate(element => { /* identify the missing target */ return element.outerHTML; })}`);
  return box;
}

// prove one scrollable control can be brought fully onscreen
async function expectReachableWithin(locator: Locator, container: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const [box, containerBox] = await Promise.all([renderedBox(locator), renderedBox(container)]);
  expect(box.y).toBeGreaterThanOrEqual(containerBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(containerBox.y + containerBox.height + 1);
}

// mount one deterministic dashboard scenario
async function mountDashboard(page: Page, options: DashboardMount) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish the requested worktrees
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { ...(options.dashboard as object), serverStartedAt: 1, buttons: buttonCatalog } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect active agent logs
    if (/^\/api\/agents\/[^/]+\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty prompt collections
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // track prompt history refreshes
    if (/^\/api\/agents\/[^/]+\/prompt-history$/u.test(url.pathname)) {
      options.onHistoryRequest?.();
      return route.fulfill({ json: { prompts: [] } });
    }
    // expose repository tabs
    if (/^\/api\/worktrees\/[^/]+\/switch-prs$/u.test(url.pathname)) return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // record configured action submissions
    if (url.pathname === '/api/button-actions' && request.method() === 'POST') {
      await options.onPrompt?.(request.postDataJSON());
      return route.fulfill({ status: 202, json: { operation: { id: `operation-${Date.now()}`, state: 'complete' } } });
    }
    // serve empty inactive-worktree notes
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
}

const longTitle = 'Keep the complete current pull request title readable while every action and repository view remains stable '.repeat(12).trim();
const activePullRequest = {
  number: 812,
  title: longTitle,
  status: 'open',
  url: 'https://github.example.com/octo/remoteagents/pull/812',
  checks: 'failed',
  issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true }
};
const activeWorktree = {
  id: 'active', projectId: 'repo', label: 'Active', path: '/worktrees/active', main: true, detached: false, locked: false, available: true, pinned: true, order: 0,
  branch: 'feature/current-pr-controls', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0 }, gitPrStatus: { base: 'origin/main', files: 4 }, pullRequest: activePullRequest
};
const activeAgent = {
  id: 'agent-active', sessionId: 'socket:$1', home: '/worktrees/active', projectId: 'repo', worktreeId: 'active', title: 'Ready', queuedPromptCount: 0,
  branch: activeWorktree.branch, gitStatus: activeWorktree.gitStatus, gitPrStatus: activeWorktree.gitPrStatus, pullRequest: activePullRequest, push: { label: 'Finish and PR', prompt: '$finish' }
};

// verify the active desktop control and transaction boundary
test('keeps the current pull request in the Working footer and queues one active-agent fixup', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1180, height: 900 });
  let finishPrompt!: () => void;
  let promptRequests = 0;
  let historyRequests = 0;
  // hold the fixup response through duplicate-submit assertions
  const promptFinished = new Promise<void>(resolve => { /* expose the response gate */ finishPrompt = resolve; });
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] },
    // delay one fixup response
    onPrompt: async body => {
      promptRequests += 1;
      expect(body).toMatchObject({ actionId: 'fixup-project', configRevision: 'buttons-v1', placeId: 'active', slot: 'pullRequest', agentId: 'agent-active' });
      await promptFinished;
    },
    // count every history refresh
    onHistoryRequest: () => { /* record one refresh */ historyRequests += 1; }
  });

  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await expect(branch).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.agent-view > .pull-request-card')).toHaveCount(0);
  await expect(branch).toHaveClass(/\bhas-pull-request\b/u);
  await expect(branch).toHaveClass(/\bstatus-open\b/u);
  await expect(branch.locator('.git-branch')).toHaveCSS('color', 'rgb(166, 227, 161)');
  const shortcutIndicators = branch.locator(':scope > .pull-request-issues');
  await expect(shortcutIndicators).toHaveCount(1);
  await expect(shortcutIndicators.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(shortcutIndicators.getByRole('img', { name: 'Merge conflicts' })).toBeVisible();
  await expect(shortcutIndicators.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  // the row beneath the tabs shows the branch as a standard-height chip, as an agentless tab does
  const [branchBox, attachmentBox] = await Promise.all([renderedBox(branch), renderedBox(page.getByRole('button', { name: 'Attach files' }))]);
  expect(Math.abs(branchBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);

  await branch.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const footer = panel.locator('.git-status-panel-footer');
  const card = footer.locator(':scope > .pull-request-card');
  const actions = footer.locator(':scope > .git-status-actions');
  const mode = footer.getByRole('group', { name: 'Git change view' });
  await expect(footer.locator(':scope > .git-status-actions + .pull-request-card + .git-status-mode')).toHaveCount(1);
  await expect(card.getByRole('link', { name: `Open pull request #812: ${longTitle}` })).toHaveAttribute('href', activePullRequest.url);
  const [footerBox, actionsBox, cardBox, modeBox, reviewBox, pushBox, allPrBox] = await Promise.all([
    renderedBox(footer), renderedBox(actions), renderedBox(card), renderedBox(mode), renderedBox(actions.getByRole('button', { name: 'Review', exact: true })), renderedBox(actions.getByRole('button', { name: 'Finish and PR', exact: true })), renderedBox(mode.getByRole('button', { name: 'All PR' }))
  ]);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(cardBox.x + 1);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(modeBox.x + 1);
  expect([actionsBox, cardBox, modeBox].every(box => { /* center one footer control */ return Math.abs(box.y + box.height / 2 - cardBox.y - cardBox.height / 2) <= 1; })).toBe(true);
  // match the pr card and actions to the standard control height
  expect(Math.abs(cardBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(reviewBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(pushBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(allPrBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(cardBox.x).toBeGreaterThanOrEqual(footerBox.x);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(footerBox.x + footerBox.width);
  const titleOverflow = await card.locator('.pull-request-card-main > span').evaluate(element => { /* measure the long title */ return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }; });
  expect(titleOverflow.scrollWidth).toBeGreaterThan(titleOverflow.clientWidth);

  const working = mode.getByRole('button', { name: 'Working' });
  const allPr = mode.getByRole('button', { name: 'All PR' });
  await working.click();
  await expect(card).toBeVisible();
  await allPr.click();
  await expect(card).toBeVisible();
  await panel.getByRole('tab', { name: 'PRs', exact: true }).click();
  await expect(panel.locator('.pull-request-card')).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Working', exact: true }).click();
  await expect(card).toBeVisible();

  // keep the standalone fixup immediately after push
  const fixup = actions.getByRole('button', { name: '$fixup', exact: true });
  await expect(actions.locator('.configured-pull-request-actions .configured-button')).toHaveCount(2);
  await expect(card.getByRole('button')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Show PR comments' })).toBeVisible();
  await fixup.click();
  await expect.poll(() => promptRequests).toBe(1);
  await expect(panel).toHaveCount(0);
  await expect(branch).toHaveAttribute('aria-expanded', 'false');
  await expect(branch).toHaveAttribute('aria-busy', 'true');
  await branch.click();
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* exercise a disabled native button */ button.click(); });
  expect(promptRequests).toBe(1);
  finishPrompt();
  await expect(fixup).toBeEnabled();
  expect(historyRequests).toBeGreaterThanOrEqual(1);
});

// expand the flyout while keeping the current pr centered and reachable
test('centers the current pull request across viewport-bounded flyout widths', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_600, height: 1_000 });
  await mountDashboard(page, { dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] } });

  await page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const footer = panel.locator('.git-status-panel-footer');
  const card = footer.locator(':scope > .pull-request-card');
  // exercise wide, breakpoint, phone, and smallest supported layouts
  for (const viewport of [{ width: 1_600, height: 1_000 }, { width: 1_440, height: 900 }, { width: 900, height: 500 }, { width: 600, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => { /* wait for the resize refit */ return (await renderedBox(panel)).width; }).toBeLessThanOrEqual(viewport.width);
    const [panelBox, footerBox, cardBox] = await Promise.all([renderedBox(panel), renderedBox(footer), renderedBox(card)]);
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(footerBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(footerBox.x + footerBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    expect(await page.evaluate(() => { /* measure page overflow */ return document.documentElement.scrollWidth; })).toBeLessThanOrEqual(viewport.width);
    // require horizontal growth and geometric centering above the stacked breakpoint
    if (viewport.width > 900) {
      expect(panelBox.width).toBeGreaterThan(720);
      expect(Math.abs(cardBox.x + cardBox.width / 2 - footerBox.x - footerBox.width / 2)).toBeLessThanOrEqual(1);
    } else {
      // keep every stacked footer control reachable on bounded viewports
      await expectReachableWithin(footer, panel);
    }
    // retain the requested wide and phone render evidence
    if (viewport.width === 1_600 || viewport.width === 390) await page.screenshot({ path: testInfo.outputPath(`pr-flyout-${viewport.width}.png`), fullPage: true });
  }
});

// keep toolbar pr health floating while card indicators retain their normal layout
test('floats compact branch indicators from the same corners at every width', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const singleWorktree = {
    id: 'single', projectId: 'repo', label: 'Single', path: '/worktrees/single', main: false, detached: false, locked: false, available: true, pinned: true, order: 1,
    branch: 'feature/single-indicator', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, pullRequest: { number: 813, title: 'Single build state', status: 'draft', url: 'https://github.example.com/pull/813', checks: 'pending' }
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree, singleWorktree] }] }
  });

  // measure one branch shortcut without depending on css constants
  const measureBranchShortcut = async (name: RegExp) => {
    const branch = page.getByRole('button', { name });
    await expect(branch).toBeVisible({ timeout: 15_000 });
    const issues = branch.locator(':scope > .pull-request-issues');
    const indicators = issues.getByRole('img');
    const [buttonBox, iconBox, dotBox, issuesBox, moreBox] = await Promise.all([
      renderedBox(branch), renderedBox(branch.locator(':scope > .git-branch-icon')), renderedBox(branch.locator(':scope > .git-status-dot')), renderedBox(issues), renderedBox(page.getByRole('button', { name: 'More options' }))
    ]);
    const indicatorBoxes = await Promise.all(Array.from({ length: await indicators.count() }, (_, index) => { /* measure each compact status */ return renderedBox(indicators.nth(index)); }));
    // keep inner toolbar glyphs compact as well as their containers
    for (const glyph of await indicators.locator('svg').all()) {
      await expect(glyph).toHaveCSS('width', '8px');
      await expect(glyph).toHaveCSS('height', '8px');
    }
    const pageWidth = await page.evaluate(() => { /* measure page overflow */ return { inner: innerWidth, document: document.documentElement.scrollWidth }; });
    return {
      branch,
      count: indicatorBoxes.length,
      buttonBox,
      iconBox,
      dotBox,
      issuesBox,
      indicatorBoxes,
      relativeLeft: issuesBox.x - buttonBox.x,
      dotRightInset: buttonBox.x + buttonBox.width - dotBox.x - dotBox.width,
      dotTopInset: dotBox.y - buttonBox.y,
      rightInset: buttonBox.x + buttonBox.width - issuesBox.x - issuesBox.width,
      bottomInset: buttonBox.y + buttonBox.height - issuesBox.y - issuesBox.height,
      overlapsIcon: issuesBox.x < iconBox.x + iconBox.width && issuesBox.x + issuesBox.width > iconBox.x && issuesBox.y < iconBox.y + iconBox.height && issuesBox.y + issuesBox.height > iconBox.y,
      neighborGap: moreBox.x - buttonBox.x - buttonBox.width,
      pageWidth
    };
  };
  // keep card indicators alongside their main content at every breakpoint
  const expectCardIndicatorsInline = async (card: Locator) => {
    const issues = card.locator(':scope > .pull-request-issues');
    const [cardBox, mainBox, issuesBox] = await Promise.all([
      renderedBox(card), renderedBox(card.locator(':scope > .pull-request-card-main')), renderedBox(card.locator(':scope > .pull-request-issues'))
    ]);
    const indicatorBoxes = await Promise.all((await issues.locator(':scope > i').all()).map(indicator => { /* measure one card status */ return renderedBox(indicator); }));
    const glyphBoxes = await Promise.all((await issues.locator(':scope > i > svg').all()).map(glyph => { /* measure one card glyph */ return renderedBox(glyph); }));
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(issuesBox.x + 1);
    expect(Math.abs(mainBox.y + mainBox.height / 2 - issuesBox.y - issuesBox.height / 2)).toBeLessThanOrEqual(1);
    expect(issuesBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(issuesBox.x + issuesBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    expect(issuesBox.y).toBeGreaterThanOrEqual(cardBox.y);
    expect(issuesBox.y + issuesBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1);
    expect(indicatorBoxes.every(box => { /* retain normal card status controls */ return box.width > 16 && box.height > 16; })).toBe(true);
    expect(glyphBoxes.every(box => { /* retain normal card status glyphs */ return box.width >= 15 && box.height >= 15; })).toBe(true);
  };
  // switch through the phone sheet or the labelled desktop tabs
  const switchWorkspace = async (label: RegExp) => {
    const phone = await page.evaluate(() => { /* use the app's phone breakpoint */ return innerWidth <= 768; });
    // use the selected dropdown and its sheet on compact layouts
    if (phone) {
      const selected = page.getByRole('tab', { selected: true });
      const selectedName = await selected.getAttribute('aria-label');
      // leave the already selected mobile tab closed
      if (selectedName !== null && label.test(selectedName)) return;
      await selected.click();
      const workspaces = page.getByRole('dialog', { name: 'Workspaces' });
      await expect(workspaces).toBeVisible();
      await workspaces.getByRole('button', { name: label }).click();
      await expect(workspaces).toHaveCount(0);
      return;
    }
    const directTab = page.getByRole('tab', { name: label });
    await expect(directTab).toBeVisible();
    // leave the already selected desktop tab untouched
    if (await directTab.getAttribute('aria-selected') === 'true') return;
    await directTab.click();
  };
  // validate phones, the breakpoint edges and a wide desktop
  for (const width of [390, 600, 601, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await switchWorkspace(/^Active\b/u);
    const all = await measureBranchShortcut(/^Git status: feature\/current-pr-controls/u);
    await expect(all.branch.locator(':scope > .pull-request-issues').getByRole('img')).toHaveCount(3);
    // keep the requested phone and desktop artifacts
    if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`branch-indicators-${width}.png`), fullPage: true });
    for (const label of await all.branch.locator(':scope > .git-branch, :scope > .git-status-separator, :scope > .git-worktree-state').all()) {
      await expect(label).toBeVisible({ visible: width > 600 });
    }
    expect(all.dotRightInset).toBeGreaterThanOrEqual(0);
    expect(all.dotRightInset).toBeLessThanOrEqual(6);
    expect(all.dotTopInset).toBeGreaterThanOrEqual(0);
    expect(all.dotTopInset).toBeLessThanOrEqual(6);
    expect(all.rightInset).toBeGreaterThanOrEqual(0);
    expect(all.rightInset).toBeLessThanOrEqual(6);
    expect(all.bottomInset).toBeGreaterThanOrEqual(0);
    expect(all.bottomInset).toBeLessThanOrEqual(6);
    expect(all.overlapsIcon).toBe(false);
    expect(all.neighborGap).toBeGreaterThanOrEqual(0);
    expect(all.pageWidth.document).toBeLessThanOrEqual(all.pageWidth.inner);
    expect(all.indicatorBoxes.every(box => { /* keep each toolbar status compact */ return box.width === 8 && box.height === 8; })).toBe(true);
    // desktop labels remain visible and clear of both corner decorators
    if (width > 600) {
      const [branchBox, stateBox] = await Promise.all([renderedBox(all.branch.locator(':scope > .git-branch')), renderedBox(all.branch.locator(':scope > .git-worktree-state'))]);
      expect(branchBox.x).toBeGreaterThanOrEqual(all.iconBox.x + all.iconBox.width);
      expect(stateBox.x).toBeGreaterThanOrEqual(branchBox.x + branchBox.width);
      expect(all.issuesBox.x >= stateBox.x + stateBox.width || all.issuesBox.y >= stateBox.y + stateBox.height).toBe(true);
      expect(all.dotBox.x >= stateBox.x + stateBox.width || all.dotBox.y + all.dotBox.height <= stateBox.y).toBe(true);
    } else {
      expect(Math.abs(all.iconBox.x + all.iconBox.width / 2 - all.buttonBox.x - all.buttonBox.width / 2)).toBeLessThanOrEqual(1);
    }
    await all.branch.click();
    const panel = page.getByRole('region', { name: 'Changed files' });
    const card = panel.locator('.git-status-panel-footer > .pull-request-card');
    await expect(panel).toBeVisible();
    await expect(card.locator(':scope > .pull-request-issues')).toBeVisible();
    await expectCardIndicatorsInline(card);
    // keep card evidence beside the requested toolbar artifacts
    if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`branch-card-${width}.png`), fullPage: true });
    await page.mouse.click(4, 4);

    await switchWorkspace(/^Single\b/u);
    const single = await measureBranchShortcut(/^Git status: feature\/single-indicator/u);
    expect(single.count).toBe(1);
    expect(single.dotRightInset).toBeCloseTo(all.dotRightInset, 0);
    expect(single.dotTopInset).toBeCloseTo(all.dotTopInset, 0);
    expect(single.rightInset).toBeCloseTo(all.rightInset, 0);
    expect(single.bottomInset).toBeCloseTo(all.bottomInset, 0);
    // equal-width compact controls expand left as statuses accumulate
    if (width <= 600) expect(all.relativeLeft).toBeLessThan(single.relativeLeft);
    expect(all.issuesBox.width).toBeGreaterThan(single.issuesBox.width);
    expect(single.indicatorBoxes.every(box => { /* keep one toolbar status compact */ return box.width === 8 && box.height === 8; })).toBe(true);
    expect(single.overlapsIcon).toBe(false);
    expect(single.neighborGap).toBeGreaterThanOrEqual(0);
    expect(single.pageWidth.document).toBeLessThanOrEqual(single.pageWidth.inner);
  }
});

// retain the prompt lock when the fixup control is remounted
test('keeps fixup pending across popup and tab roundtrips', async ({ page }) => {
  test.setTimeout(120_000);
  let finishPrompt = () => { /* replace with the response gate */ };
  let promptRequests = 0;
  const promptFinished = new Promise<void>(resolve => { /* expose the response gate */ finishPrompt = resolve; });
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] },
    // hold acceptance while the action moves through mount boundaries
    onPrompt: async () => {
      promptRequests += 1;
      await promptFinished;
    }
  });
  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await branch.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const fixup = panel.getByRole('button', { name: '$fixup', exact: true });
  await fixup.click();
  await expect.poll(() => promptRequests).toBe(1);
  await expect(panel).toHaveCount(0);
  await expect(branch).toHaveAttribute('aria-expanded', 'false');
  await expect(branch).toHaveAttribute('aria-busy', 'true');
  await branch.click();
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* attempt a native duplicate submission */ button.click(); });
  await panel.getByRole('tab', { name: 'PRs', exact: true }).click();
  await panel.getByRole('tab', { name: 'Working', exact: true }).click();
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* attempt another native duplicate submission */ button.click(); });
  expect(promptRequests).toBe(1);
  finishPrompt();
  await expect(fixup).toBeEnabled();
});

// surface rejected and disconnected submissions without preventing retries
test('reports fixup rejection and recovers one ambiguous submission with the same request', async ({ page }) => {
  test.setTimeout(120_000);
  await mountDashboard(page, { dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] } });
  let promptRequests = 0;
  await page.route('**/api/button-actions', async route => {
    promptRequests += 1;
    // expose the server rejection
    if (promptRequests === 1) return route.fulfill({ status: 409, json: { error: 'Agent is not accepting prompts' } });
    // simulate a lost connection on retry
    if (promptRequests === 2) return route.abort('failed');
    return route.fulfill({ status: 202, json: { operation: { id: 'fixup-retry', state: 'complete' } } });
  });
  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await branch.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const fixup = panel.getByRole('button', { name: '$fixup', exact: true });
  await fixup.click();
  const feedback = page.locator('.operation-feedback[role="alert"]');
  await expect(feedback).toContainText('Agent is not accepting prompts');
  await expect(panel).toHaveCount(0);
  await expect(branch).toHaveAttribute('aria-expanded', 'false');
  await branch.click();
  await expect(fixup).toBeEnabled();
  await fixup.click();
  await expect(panel).toHaveCount(0);
  await expect(branch).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.operation-feedback').filter({ hasText: '$fixup finished' })).toBeVisible();
  await branch.click();
  await expect(fixup).toBeEnabled();
  expect(promptRequests).toBe(3);
});

// verify the narrow stacked footer and the standard-height branch chip
test('stacks standard-height Working footer controls at 375px without growing the branch chip', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await mountDashboard(page, { dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] } });

  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  const [branchBox, attachmentBox] = await Promise.all([renderedBox(branch), renderedBox(page.getByRole('button', { name: 'Attach files' }))]);
  expect(Math.abs(branchBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  await branch.click();

  const panel = page.getByRole('region', { name: 'Changed files' });
  const footer = panel.locator('.git-status-panel-footer');
  const actions = footer.locator(':scope > .git-status-actions');
  const card = footer.locator(':scope > .pull-request-card');
  const mode = footer.getByRole('group', { name: 'Git change view' });
  const [panelBox, footerBox, actionsBox, cardBox, modeBox, reviewBox, workingBox] = await Promise.all([
    renderedBox(panel), renderedBox(footer), renderedBox(actions), renderedBox(card), renderedBox(mode), renderedBox(actions.getByRole('button', { name: 'Review', exact: true })), renderedBox(mode.getByRole('button', { name: 'Working' }))
  ]);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(cardBox.y + 1);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(modeBox.y + 1);
  expect(Math.abs(actionsBox.width - cardBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(modeBox.width - cardBox.width)).toBeLessThanOrEqual(1);
  // retain standard action heights on narrow screens
  expect(Math.abs(reviewBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(workingBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect([actionsBox, cardBox, modeBox].every(box => { /* contain one stacked control */ return box.x >= footerBox.x && box.x + box.width <= footerBox.x + footerBox.width + 1; })).toBe(true);
  expect([footerBox, actionsBox, cardBox, modeBox].every(box => { /* contain one panel child */ return box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width + 1; })).toBe(true);
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => { /* measure page overflow */ return document.documentElement.scrollWidth; })).toBeLessThanOrEqual(375);

  const cardMain = await renderedBox(card.locator('.pull-request-card-main'));
  const cardIndicators = await renderedBox(card.locator(':scope > .pull-request-issues'));
  const fixup = await renderedBox(actions.getByRole('button', { name: '$fixup', exact: true }));
  const push = await renderedBox(actions.getByRole('button', { name: 'Finish and PR', exact: true }));
  // keep pr content on one row while fixes stay beside push
  expect(Math.abs(cardBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(cardMain.y + cardMain.height / 2).toBeCloseTo(cardIndicators.y + cardIndicators.height / 2, 0);
  expect(fixup.y).toBeCloseTo(push.y, 0);
  expect(fixup.x).toBeGreaterThanOrEqual(push.x + push.width);
  expect(fixup.height).toBeCloseTo(attachmentBox.height, 0);
  await expect(card.getByRole('button')).toHaveCount(1);
  await expect(card.locator('.pull-request-card-main > span')).toHaveCount(1);
  await expect(card.locator('.pull-request-card-main > span')).toHaveCSS('text-overflow', 'ellipsis');
  // verify truncation instead of a wrapped title
  const title = await card.locator('.pull-request-card-main > span').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(title.clientWidth).toBeGreaterThan(0);
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);

  await page.setViewportSize({ width: 667, height: 320 });
  await expect(panel).toHaveCSS('overflow-y', 'auto');
  // the popup refits on the resize event, a render after the viewport changes
  await expect.poll(async () => (await renderedBox(panel)).y).toBeGreaterThanOrEqual(0);
  const shortPanelBox = await renderedBox(panel);
  expect(shortPanelBox.y + shortPanelBox.height).toBeLessThanOrEqual(320);
  await expectReachableWithin(actions, panel);
  await expectReachableWithin(card, panel);
  await expectReachableWithin(mode, panel);
});

// verify status presentation across live and idle worktrees
test('applies pull request status colors and indicators to active and inactive branch controls', async ({ page }) => {
  test.setTimeout(120_000);
  const draftWorktree = {
    id: 'draft', projectId: 'repo', label: 'Draft', path: '/worktrees/draft', main: false, detached: false, locked: false, available: true, pinned: true, order: 1,
    branch: 'feature/draft', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, pullRequest: { number: 813, title: 'Draft work', status: 'draft', url: 'https://github.example.com/pull/813', checks: 'pending' }
  };
  const mergedWorktree = {
    id: 'merged', projectId: 'repo', label: 'Merged', path: '/worktrees/merged', main: false, detached: false, locked: false, available: true, pinned: true, order: 2,
    branch: 'feature/merged', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, pullRequest: { number: 814, title: 'Merged work', status: 'merged', url: 'https://github.example.com/pull/814', checks: 'passed', issues: { unresolvedComments: true } }
  };
  const noPullRequestWorktree = {
    id: 'plain', projectId: 'repo', label: 'Plain', path: '/worktrees/plain', main: false, detached: false, locked: false, available: true, pinned: true, order: 3,
    branch: 'feature/plain', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 }
  };
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree, draftWorktree, mergedWorktree, noPullRequestWorktree] }] }
  });

  const activeBranch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await expect(activeBranch).toBeVisible({ timeout: 15_000 });
  await expect(activeBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(166, 227, 161)');

  await page.getByRole('tab', { name: /^Draft —/u }).click();
  const draftBranch = page.getByRole('button', { name: /^Git status: feature\/draft/u });
  await expect(draftBranch).toHaveClass(/\bhas-pull-request\b/u);
  await expect(draftBranch).toHaveClass(/\bstatus-draft\b/u);
  await expect(draftBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(147, 153, 178)');
  await expect(draftBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'CI checks running' })).toBeVisible();
  await draftBranch.click();
  const inactivePanel = page.getByRole('region', { name: 'Changed files' });
  await expect(inactivePanel.locator('.git-status-panel-footer').getByRole('link', { name: 'Draft pull request #813: Draft work' })).toHaveAttribute('href', 'https://github.example.com/pull/813');
  await expect(inactivePanel.getByRole('button', { name: 'Queue $fixup' })).toHaveCount(0);
  await page.mouse.click(4, 4);

  await page.getByRole('tab', { name: /^Merged —/u }).click();
  const mergedBranch = page.getByRole('button', { name: /^Git status: feature\/merged/u });
  await expect(mergedBranch).toHaveClass(/\bstatus-merged\b/u);
  await expect(mergedBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(203, 166, 247)');
  await expect(mergedBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'CI checks passed' })).toBeVisible();
  await expect(mergedBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();

  await page.getByRole('tab', { name: /^Plain —/u }).click();
  const plainBranch = page.getByRole('button', { name: /^Git status: feature\/plain/u });
  await expect(plainBranch).not.toHaveClass(/\bhas-pull-request\b/u);
  await expect(plainBranch).not.toHaveClass(/\bstatus-(?:draft|open|merged)\b/u);
  await expect(plainBranch.locator(':scope > .pull-request-issues')).toHaveCount(0);
  await expect(plainBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(180, 190, 254)');
});
