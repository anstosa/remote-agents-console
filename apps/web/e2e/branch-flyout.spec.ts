import { expect, test, type Page } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder } from './progress-border-assertions';

// open one branch flyout tab
async function openBranchTab(page: Page, name: 'PRs' | 'Branches') {
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await panel.getByRole('tab', { name, exact: true }).click();
  return panel;
}

test('prefetches shared repository choices and refreshes them when reopened', async ({ page }) => {
  test.setTimeout(60_000);
  let finishPullRequests!: () => void;
  let finishPullRequestRefresh!: () => void;
  let pullRequestRequests = 0;
  // hold repository choices through loading assertions
  const pullRequestsFinished = new Promise<void>(resolve => { finishPullRequests = resolve; });
  const pullRequestRefreshFinished = new Promise<void>(resolve => { finishPullRequestRefresh = resolve; });
  await page.context().route('https://github.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>GitHub PR</title>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      pullRequestRequests += 1;
      await (pullRequestRequests === 1 ? pullRequestsFinished : pullRequestRefreshFinished);
      return route.fulfill({ json: { enabled: true, pullRequests: [
        { number: 2567, title: 'Make prompt actions fit', branch: 'fix/prompt-actions', draft: false, url: 'https://github.example.com/pull/2567', checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true }, checkedOut: false },
        { number: 2568, title: 'Prompt actions experiment', branch: 'draft/prompt-actions', draft: true, url: 'https://github.example.com/pull/2568', checkedOut: false }
      ], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /^Git status:/u });
  await branchButton.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const tabs = panel.getByRole('tablist', { name: 'Branch views' });
  expect(await tabs.getByRole('tab').allTextContents()).toEqual(['Working', 'PRs', 'Branches']);
  const workingTab = tabs.getByRole('tab', { name: 'Working', exact: true });
  const pullRequestsTab = tabs.getByRole('tab', { name: 'PRs', exact: true });
  const branchesTab = tabs.getByRole('tab', { name: 'Branches', exact: true });
  // reuse the rendered agent selection as the visual contract
  const selectionEffect = await page.locator('.tabs button.active').evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, shadow: style.boxShadow };
  });
  await expect(workingTab).toHaveAttribute('aria-selected', 'true');
  await expect(workingTab).toHaveCSS('background-image', selectionEffect.background);
  await expect(workingTab).toHaveCSS('box-shadow', selectionEffect.shadow);
  await workingTab.hover();
  await expect(workingTab).toHaveCSS('background-image', selectionEffect.background);
  await expect(workingTab).toHaveCSS('box-shadow', selectionEffect.shadow);
  await expect.poll(() => pullRequestRequests).toBe(1);
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(workingTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(pullRequestsTab).toHaveAttribute('aria-busy', 'true');
  await expect(branchesTab).toHaveAttribute('aria-busy', 'true');
  await expectProgressBorder(pullRequestsTab, 'blue');
  await expectProgressBorder(branchesTab, 'blue');
  await expectClockwiseProgressBorder(pullRequestsTab);
  const [panelBox, tabsBox] = await Promise.all([panel.boundingBox(), tabs.boundingBox()]);
  expect(panelBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  // require rendered flyout bounds
  if (panelBox === null || tabsBox === null) throw new Error('branch flyout bounds unavailable');
  expect(Math.abs(panelBox.y + panelBox.height - (tabsBox.y + tabsBox.height))).toBeLessThanOrEqual(1);
  await pullRequestsTab.click();
  await expect(pullRequestsTab).toHaveCSS('background-image', selectionEffect.background);
  await expect(pullRequestsTab).toHaveCSS('box-shadow', selectionEffect.shadow);
  await expect(workingTab).toHaveCSS('box-shadow', 'none');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator('.git-status-panel-header')).not.toContainText('Loading');
  await expect(panel.locator('.git-status-panel-header').getByRole('status')).toHaveCount(0);
  await branchesTab.click();
  await expect(branchesTab).toHaveCSS('background-image', selectionEffect.background);
  await expect(branchesTab).toHaveCSS('box-shadow', selectionEffect.shadow);
  await expect(pullRequestsTab).toHaveCSS('box-shadow', 'none');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator('.git-status-panel-header')).not.toContainText('Loading');
  await expect(panel.locator('.git-status-panel-header').getByRole('status')).toHaveCount(0);
  expect(pullRequestRequests).toBe(1);
  await workingTab.click();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expectProgressBorder(pullRequestsTab, 'blue');
  finishPullRequests();
  await expect(pullRequestsTab).not.toHaveAttribute('aria-busy');
  await expect(branchesTab).not.toHaveAttribute('aria-busy');
  await expect(pullRequestsTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await pullRequestsTab.click();

  const pullRequestOption = panel.getByRole('group', { name: '#2567: Make prompt actions fit; Open', exact: true });
  const draftOption = panel.getByRole('group', { name: '#2568: Prompt actions experiment; Draft', exact: true });
  const pullRequest = panel.getByRole('link', { name: '#2567: Make prompt actions fit', exact: true });
  await expect(pullRequest).toBeVisible();
  const pullRequestActions = pullRequestOption.locator('.switch-pr-actions');
  await expect(pullRequestActions.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(pullRequestActions.getByRole('img', { name: 'Merge conflicts' })).toBeVisible();
  await expect(pullRequestActions.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  await expect(pullRequestOption).toHaveAccessibleName('#2567: Make prompt actions fit; Open');
  await expect(draftOption).toHaveAccessibleName('#2568: Prompt actions experiment; Draft');
  const checkout = pullRequestOption.getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeEnabled();
  await page.mouse.click(4, 4);
  await branchButton.click();
  await expect.poll(() => pullRequestRequests).toBe(2);
  await expectProgressBorder(pullRequestsTab, 'blue');
  await expectProgressBorder(branchesTab, 'blue');
  await pullRequestsTab.click();
  await expect(pullRequest).toBeVisible();
  await expect(checkout).toBeDisabled();
  finishPullRequestRefresh();
  await expect(checkout).toBeEnabled();
  await expect(pullRequestsTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  const [github] = await Promise.all([page.waitForEvent('popup'), pullRequest.click()]);
  await expect(github).toHaveURL('https://github.example.com/pull/2567');
  await github.close();
});

// keep configured and default branch actions aligned with standard prompt controls
test('queues the configured push prompt and falls back to the default action', async ({ page }) => {
  let push: { label: string; prompt: string } | undefined = { label: 'Finish and PR', prompt: '$finish' };
  const queued: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: queued.length + 1, reviewTour: { available: true }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/push-action', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready', ...(push === undefined ? {} : { push }) }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const body = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      expect(body.attachments).toEqual([]);
      queued.push(body.prompt);
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const more = page.getByRole('button', { name: 'More options' });
  await more.click();
  await expect(page.locator('.more-menu').getByRole('button', { name: 'Finish and PR', exact: true })).toHaveCount(0);
  // leave the overflow menu before opening branch status
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const branchFlyout = page.getByRole('region', { name: 'Changed files' });
  const review = branchFlyout.getByRole('button', { name: 'Review', exact: true });
  const custom = branchFlyout.getByRole('button', { name: 'Finish and PR', exact: true });
  const queue = page.getByRole('button', { name: 'Queue', exact: true });
  await expect(custom.locator('.more-menu-icon')).toBeVisible();
  const [reviewBounds, customBounds] = await Promise.all([review.boundingBox(), custom.boundingBox()]);
  // require rendered action bounds
  if (reviewBounds === null || customBounds === null) throw new Error('branch action bounds unavailable');
  expect(customBounds.x).toBeGreaterThan(reviewBounds.x + reviewBounds.width);
  expect(customBounds.y).toBeCloseTo(reviewBounds.y, 0);
  // match standard prompt-control height at desktop and mobile widths
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const [queueSize, reviewSize, customSize] = await Promise.all([queue.boundingBox(), review.boundingBox(), custom.boundingBox()]);
    // require each responsive control box
    if (queueSize === null || reviewSize === null || customSize === null) throw new Error('responsive branch action bounds unavailable');
    expect(reviewSize.height).toBeCloseTo(queueSize.height, 1);
    expect(customSize.height).toBeCloseTo(queueSize.height, 1);
    // a desktop gets a fixed-width flyout on screen; a phone's spans the screen within its edges
    const flyoutBox = () => branchFlyout.evaluate(element => { const box = element.getBoundingClientRect(); return { left: Math.round(box.left), width: Math.round(box.width) }; });
    if (viewport.width > 600) await expect.poll(flyoutBox).toEqual({ left: viewport.width - 6 - 720, width: 720 });
    else await expect.poll(flyoutBox).toEqual({ left: 6, width: viewport.width - 12 });
  }
  await custom.click();
  await expect.poll(() => queued).toEqual(['$finish']);
  await expect(branchFlyout).toBeHidden();

  push = undefined;
  await page.reload();
  await more.click();
  await expect(page.locator('.more-menu').getByRole('button', { name: 'Commit/Push', exact: true })).toHaveCount(0);
  // leave the overflow menu before opening branch status
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const defaultPush = page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Commit/Push', exact: true });
  const [defaultQueueSize, defaultPushSize] = await Promise.all([queue.boundingBox(), defaultPush.boundingBox()]);
  // require default action bounds
  if (defaultQueueSize === null || defaultPushSize === null) throw new Error('default branch action bounds unavailable');
  expect(defaultPushSize.height).toBeCloseTo(defaultQueueSize.height, 1);
  await defaultPush.click();
  await expect.poll(() => queued).toEqual(['$finish', 'review, commit, and push']);
});

test('shows every pull request target while keeping checkout and worktree actions available', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
        ],
        projects: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({
      json: {
        enabled: false,
        pullRequests: [
          { number: 300, title: 'Visible while dirty', branch: 'feature/dirty-target', draft: false, url: 'https://github.example.com/pull/300', checkedOut: false },
          { number: 301, title: 'Already in Delta', branch: 'feature/delta-target', draft: false, url: 'https://github.example.com/pull/301', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
        ],
        otherPullRequests: [
          { number: 302, title: 'Authored by someone else', branch: 'feature/other-author', draft: false, url: 'https://github.example.com/pull/302', checkedOut: false }
        ],
        branches: [],
        pullRequestsSupported: true
      }
    });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'PRs');
  const dirtyTarget = menu.getByRole('link', { name: '#300: Visible while dirty' });
  const openTarget = menu.getByRole('link', { name: '#301: Already in Delta' });
  const otherTarget = menu.getByRole('link', { name: '#302: Authored by someone else' });
  await expect(dirtyTarget).toBeVisible();
  await expect(dirtyTarget).toBeEnabled();
  await expect(openTarget).toBeVisible();
  await expect(openTarget).toBeEnabled();
  await expect(menu.getByRole('button', { name: 'Switch to Delta' })).toContainText('Open in Delta');
  await expect(otherTarget).not.toBeVisible();
  await menu.getByText(/^Pull requests by others/u).click();
  await expect(otherTarget).toBeVisible();
  await expect(otherTarget).toBeEnabled();
  await expect(dirtyTarget).toHaveAttribute('href', 'https://github.example.com/pull/300');

  const switchToDelta = menu.getByRole('button', { name: 'Switch to Delta' });
  const openOption = menu.getByRole('group', { name: '#301: Already in Delta; Open', exact: true });
  const checkout = openOption.getByRole('button', { name: 'Checkout' });
  // the checkout action is the only button in the action cluster; the merged switch link lives on its own owner line
  const actionOrder = await openOption.locator('.switch-pr-actions').locator('.switch-pr-action').evaluateAll(elements => elements.map(element => element.textContent?.trim()));
  expect(actionOrder).toEqual(['Checkout']);
  await expect(checkout).toBeDisabled();
  await expect(checkout).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
  const [checkoutBox, switchBox] = await Promise.all([checkout.boundingBox(), switchToDelta.boundingBox()]);
  expect(checkoutBox).not.toBeNull();
  expect(switchBox).not.toBeNull();
  // require rendered option bounds
  if (checkoutBox === null || switchBox === null) throw new Error('pull request action bounds unavailable');
  // the merged switch link sits on its own line below the checkout row, not beside it
  expect(switchBox.y).toBeGreaterThanOrEqual(checkoutBox.y + checkoutBox.height - 2);

  // close without activating a covered control: the prompt where the flyout leaves it bare, else
  // the agent panel's expand button
  const deltaTab = page.getByRole('tab', { name: /^Delta/u });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const expand = page.getByRole('button', { name: 'Expand agent output' });
  await expect(deltaTab).toHaveAttribute('aria-selected', 'false');
  await expect(prompt).not.toBeFocused();
  const [promptBox, expandBox, menuBox] = await Promise.all([prompt.boundingBox(), expand.boundingBox(), menu.boundingBox()]);
  expect(promptBox).not.toBeNull();
  expect(expandBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  // require rendered menu bounds
  if (promptBox === null || expandBox === null || menuBox === null) throw new Error('menu dismissal bounds unavailable');
  const outsideMenu = (point: { x: number; y: number }) => point.x < menuBox.x || point.x > menuBox.x + menuBox.width || point.y < menuBox.y || point.y > menuBox.y + menuBox.height;
  const coveredPoint = [promptBox.x + 12, promptBox.x + promptBox.width / 2, promptBox.x + promptBox.width - 12].map(x => ({ x, y: promptBox.y + promptBox.height / 2 })).find(outsideMenu)
    ?? { x: expandBox.x + expandBox.width / 2, y: expandBox.y + expandBox.height / 2 };
  expect(outsideMenu(coveredPoint)).toBe(true);
  await page.mouse.click(coveredPoint.x, coveredPoint.y);
  await expect(menu).toBeHidden();
  await expect(prompt).not.toBeFocused();
  await expect(expand).toHaveAttribute('aria-pressed', 'false');
  await expect(deltaTab).toHaveAttribute('aria-selected', 'false');

  // reopen for the explicit switch action
  await openBranchTab(page, 'PRs');
  await switchToDelta.click();

  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
  await expect(menu).toBeHidden();
});

test('checks out an available pull request from its dedicated action', async ({ page }) => {
  let checkedOut: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the test client
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable unrelated setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide an empty saved-prompt list
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // expose one available checkout
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 300, title: 'Available checkout', branch: 'feature/available', draft: false, url: 'https://github.example.com/pull/300', checkedOut: false }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // record the checkout action
    if (url.pathname === '/api/worktrees/cora/switch-pr' && request.method() === 'POST') { checkedOut = request.postDataJSON(); return route.fulfill({ status: 202 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  const option = page.getByRole('group', { name: '#300: Available checkout; Open', exact: true });
  await option.getByRole('button', { name: 'Checkout' }).click();

  await expect.poll(() => checkedOut).toEqual({ number: 300 });
  await expect(page.locator('.git-status-panel')).toBeHidden();
});

// reject a no-op checkout in the current worktree
test('disables checkout for the pull request already open in the current worktree', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the test client
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the current worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    // disable unrelated setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide an empty saved-prompt list
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // expose the branch as checked out here
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 300, title: 'Current checkout', branch: 'feature/current', draft: false, url: 'https://github.example.com/pull/300', checkedOut: true, openIn: { agentId: 'agent-1', worktreeId: 'cora', worktreeName: 'Cora' } }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  const option = page.getByRole('group', { name: '#300: Current checkout; Open', exact: true });
  const checkout = option.getByRole('button', { name: 'Checkout' });

  await expect(checkout).toBeDisabled();
  await expect(checkout).toHaveAttribute('title', 'Already checked out here');
  await expect(option).toContainText('Open here');
  await expect(option.getByRole('button', { name: 'Switch to Cora' })).toHaveCount(0);
});

// surface one rejected checkout transaction
test('shows the server reason when pull request checkout fails', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the test client
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    // disable unrelated setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide an empty saved-prompt list
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // expose one available checkout
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 300, title: 'Rejected checkout', branch: 'feature/rejected', draft: false, url: 'https://github.example.com/pull/300', checkedOut: false }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // reject the checkout with an actionable reason
    if (url.pathname === '/api/worktrees/cora/switch-pr' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: 'The branch changed before checkout.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  const option = page.getByRole('group', { name: '#300: Rejected checkout; Open', exact: true });
  await option.getByRole('button', { name: 'Checkout' }).click();

  await expect(page.getByRole('alert')).toContainText('Pull request could not be checked out');
  await expect(page.getByRole('alert')).toContainText('The branch changed before checkout.');
});

test('moves an occupied pull request into the current worktree', async ({ page }) => {
  let finishMove!: () => void;
  let moved: unknown;
  // hold the move request through pending-state assertions
  const moveFinished = new Promise<void>(resolve => { finishMove = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [
      { number: 301, title: 'Already in Delta', branch: 'feature/delta-target', draft: false, url: 'https://github.example.com/pull/301', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
    ], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    if (url.pathname === '/api/worktrees/cora/move-pr' && request.method() === 'POST') {
      moved = request.postDataJSON();
      await moveFinished;
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  const option = page.getByRole('group', { name: '#301: Already in Delta; Open', exact: true });
  const checkout = option.getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect.poll(() => moved).toEqual({ number: 301 });
  await expect(option.getByRole('button', { name: 'Moving…' })).toBeDisabled();
  await expect(option.getByRole('button', { name: 'Switch to Delta' })).toBeDisabled();
  finishMove();

  await expect(page.locator('.git-status-panel')).toBeHidden();
  await expect(page.getByText('Pull request moved here', { exact: true })).toBeVisible();
});

test('shows the workspace pull request cache while refreshing after a tab remount', async ({ page }) => {
  let pullRequestRequests = 0;
  let finishRefresh!: () => void;
  const refreshFinished = new Promise<void>(resolve => { finishRefresh = resolve; });
  // serve cached and refreshed lists
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [
        { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
        { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
      ],
      projects: []
    } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/delta/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      pullRequestRequests += 1;
      // hold the remount refresh
      if (pullRequestRequests > 1) await refreshFinished;
      const refreshed = pullRequestRequests > 1;
      return route.fulfill({ json: { enabled: true, pullRequests: [{ number: refreshed ? 402 : 401, title: refreshed ? 'Refreshed PR' : 'Cached PR', branch: refreshed ? 'feature/refreshed' : 'feature/cached', draft: false, url: `https://github.example.com/pull/${refreshed ? 402 : 401}`, checkedOut: false }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  await expect(page.getByRole('link', { name: '#401: Cached PR' })).toBeVisible();
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await page.getByRole('tab', { name: /^Delta/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await openBranchTab(page, 'PRs');

  const menu = page.locator('.git-status-panel');
  await expect.poll(() => pullRequestRequests).toBe(2);
  await expect(menu.getByRole('tab', { name: 'PRs', exact: true })).toHaveAttribute('aria-busy', 'true');
  await expect(menu.getByRole('tab', { name: 'Branches', exact: true })).toHaveAttribute('aria-busy', 'true');
  await expectProgressBorder(menu.getByRole('tab', { name: 'PRs', exact: true }), 'blue');
  await expect(menu.getByRole('link', { name: '#401: Cached PR' })).toBeVisible();
  finishRefresh();
  await expect(menu.getByRole('link', { name: '#402: Refreshed PR' })).toBeVisible();
  await expect(menu.getByRole('link', { name: '#401: Cached PR' })).toHaveCount(0);
  await expect(menu.getByRole('tab', { name: 'PRs', exact: true }).locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(menu.getByRole('tab', { name: 'Branches', exact: true }).locator(':scope > .update-progress-ring')).toHaveCount(0);
});

// protect cached actions after refresh failures
test('disables stale pull request switching when a refresh fails', async ({ page }) => {
  let pullRequestRequests = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide two tabs for remounting the menu
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [
        { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
        { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
      ],
      projects: []
    } });
    // disable unrelated browser setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/delta/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      pullRequestRequests += 1;
      // fail the remounted refresh
      if (pullRequestRequests > 1) return route.fulfill({ status: 502, json: { error: 'GitHub could not load pull requests (503).' } });
      return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 401, title: 'Cached PR', branch: 'feature/cached', draft: false, url: 'https://github.example.com/pull/401', checkedOut: false }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'PRs');
  await expect(page.getByRole('link', { name: '#401: Cached PR' })).toBeEnabled();
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await page.getByRole('tab', { name: /^Delta/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await openBranchTab(page, 'PRs');

  const menu = page.locator('.git-status-panel');
  const stalePullRequest = menu.getByRole('link', { name: '#401: Cached PR' });
  const staleCheckout = menu.getByRole('group', { name: '#401: Cached PR; Open', exact: true }).getByRole('button', { name: 'Checkout' });
  await expect(menu.getByRole('alert')).toHaveText('GitHub could not load pull requests (503).');
  await expect(stalePullRequest).toBeVisible();
  await expect(stalePullRequest).toBeEnabled();
  await expect(staleCheckout).toBeDisabled();
  await expect(staleCheckout).toHaveAttribute('title', 'Pull request list could not be refreshed');
});

test('shows the empty pull request state in the PRs tab', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'PRs');
  const empty = menu.getByRole('status', { name: 'No open pull requests.', exact: true });
  await expect(empty).toBeVisible();
  await expect(menu.getByRole('tab', { name: 'PRs' })).toHaveAttribute('aria-selected', 'true');
  await expect(menu.getByRole('tab', { name: 'Working' })).toHaveAttribute('aria-selected', 'false');
});

// expose failed pull request lookups
test('shows the GitHub error instead of an empty pull request state', async ({ page }) => {
  let finishFailure!: () => void;
  // hold the shared failure through border assertions
  const failureFinished = new Promise<void>(resolve => {
    // expose failure completion to the test
    finishFailure = resolve;
  });
  // serve one failed pull request request
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // fail the shared repository lookup
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      await failureFinished;
      return route.fulfill({ status: 502, json: { error: 'GitHub could not load pull requests (503): temporary outage.' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const menu = page.getByRole('region', { name: 'Changed files' });
  const workingTab = menu.getByRole('tab', { name: 'Working', exact: true });
  const pullRequestsTab = menu.getByRole('tab', { name: 'PRs', exact: true });
  const branchesTab = menu.getByRole('tab', { name: 'Branches', exact: true });
  await expect(workingTab).toHaveAccessibleName('Working');
  await expect(pullRequestsTab).toHaveAccessibleName('PRs');
  await expect(branchesTab).toHaveAccessibleName('Branches');
  await expect(workingTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expectProgressBorder(pullRequestsTab, 'blue');
  await expectProgressBorder(branchesTab, 'blue');
  await pullRequestsTab.click();
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  finishFailure();
  await expect(menu.getByRole('alert', { name: 'GitHub could not load pull requests (503): temporary outage.' })).toBeVisible();
  await expect(menu.getByRole('status', { name: 'No open pull requests.' })).toHaveCount(0);
  await expect(menu).toHaveAttribute('aria-busy', 'false');
  await expect(pullRequestsTab).not.toHaveAttribute('aria-busy');
  await expect(branchesTab).not.toHaveAttribute('aria-busy');
  await expect(pullRequestsTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
});

// expose shared lookup failures in the branches tab
test('shows the repository error instead of an empty branch state', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // fail the repository lookup
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ status: 502, json: { error: 'Repository choices are temporarily unavailable.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const panel = await openBranchTab(page, 'Branches');
  await expect(panel.getByRole('alert', { name: 'Repository choices are temporarily unavailable.' })).toBeVisible();
  await expect(panel.getByRole('status', { name: 'No other local branches.' })).toHaveCount(0);
});

// reject incomplete repository payloads
test('shows invalid repository data instead of legacy branch defaults', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // omit required branch capability fields
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const panel = await openBranchTab(page, 'Branches');
  await expect(panel.getByRole('alert', { name: 'The console returned invalid repository data.' })).toBeVisible();
  await expect(panel.getByRole('status', { name: 'No other local branches.' })).toHaveCount(0);
});

// cancel only when the complete branch flyout closes
test('keeps repository loading across inner tabs and ignores a dismissed response', async ({ page }) => {
  let finishDismissedRequest!: () => void;
  let finishCurrentRequest!: () => void;
  let repositoryRequests = 0;
  // control the dismissed and current responses independently
  const dismissedRequestFinished = new Promise<void>(resolve => {
    // expose stale completion to the test
    finishDismissedRequest = resolve;
  });
  const currentRequestFinished = new Promise<void>(resolve => {
    // expose current completion to the test
    finishCurrentRequest = resolve;
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // hold repository choices across tab and flyout changes
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      repositoryRequests += 1;
      const requestNumber = repositoryRequests;
      await (requestNumber === 1 ? dismissedRequestFinished : currentRequestFinished);
      // tolerate the browser aborting the dismissed route
      await route.fulfill({ json: { enabled: true, pullRequests: [{ number: requestNumber === 1 ? 501 : 502, title: requestNumber === 1 ? 'Dismissed response' : 'Current response', branch: requestNumber === 1 ? 'feature/dismissed' : 'feature/current-response', draft: false, url: `https://github.example.com/pull/${requestNumber === 1 ? 501 : 502}`, checkedOut: false }], otherPullRequests: [], branches: [], pullRequestsSupported: true } }).catch(() => { /* expected after cancellation */ });
      return;
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /^Git status:/u });
  await branchButton.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const workingTab = panel.getByRole('tab', { name: 'Working', exact: true });
  const pullRequestsTab = panel.getByRole('tab', { name: 'PRs', exact: true });
  const branchesTab = panel.getByRole('tab', { name: 'Branches', exact: true });
  await expect.poll(() => repositoryRequests).toBe(1);
  await pullRequestsTab.click();
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await branchesTab.click();
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  expect(repositoryRequests).toBe(1);
  await workingTab.click();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expectProgressBorder(pullRequestsTab, 'blue');
  await expectProgressBorder(branchesTab, 'blue');

  // dismiss the whole flyout to cancel its request
  await page.mouse.click(4, 4);
  await expect(panel).toBeHidden();
  await branchButton.click();
  await expect.poll(() => repositoryRequests).toBe(2);
  await expect(workingTab).toHaveAttribute('aria-selected', 'true');
  await expectProgressBorder(pullRequestsTab, 'blue');
  finishDismissedRequest();
  await pullRequestsTab.click();
  await expect(panel.getByRole('link', { name: '#501: Dismissed response' })).toHaveCount(0);
  await expectProgressBorder(pullRequestsTab, 'blue');
  finishCurrentRequest();
  await expect(panel.getByRole('link', { name: '#502: Current response' })).toBeVisible();
  await expect(pullRequestsTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
});

// check out an open-nowhere local branch, and refuse one detached in an unknown worktree
test('checks out a local branch from the Branches section', async ({ page }) => {
  let checkedOut: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // one switchable branch and one checked out in an unresolved worktree
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/solo', checkedOut: false },
      { branch: 'feature/detached', checkedOut: true }
    ] } });
    // record the branch checkout
    if (url.pathname === '/api/worktrees/cora/switch-branch' && request.method() === 'POST') { checkedOut = request.postDataJSON(); return route.fulfill({ status: 202 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  await expect(menu.getByRole('tab', { name: 'Branches', exact: true })).toHaveAttribute('aria-selected', 'true');
  const solo = menu.getByRole('group', { name: 'feature/solo', exact: true });
  await expect(solo.locator('.switch-branch-name')).toHaveText('feature/solo');
  const detached = menu.getByRole('group', { name: 'feature/detached', exact: true }).getByRole('button', { name: 'Checkout' });
  await expect(detached).toBeDisabled();
  await expect(detached).toHaveAttribute('title', 'Already open in another worktree');
  await solo.getByRole('button', { name: 'Checkout' }).click();
  await expect.poll(() => checkedOut).toEqual({ branch: 'feature/solo' });
  await expect(menu).toBeHidden();
});

// move a branch out of another worktree and into the current one
test('moves a branch open in another worktree into the current worktree', async ({ page }) => {
  let finishMove!: () => void;
  let moved: unknown;
  const moveFinished = new Promise<void>(resolve => { finishMove = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/delta', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
    ] } });
    if (url.pathname === '/api/worktrees/cora/move-branch' && request.method() === 'POST') { moved = request.postDataJSON(); await moveFinished; return route.fulfill({ status: 202 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  const option = menu.getByRole('group', { name: 'feature/delta', exact: true });
  await expect(option.getByRole('button', { name: 'Switch to Delta' })).toContainText('Open in Delta');
  const checkout = option.getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeEnabled();
  await expect(checkout).toHaveAttribute('title', 'Move feature/delta here');
  await checkout.click();
  await expect.poll(() => moved).toEqual({ branch: 'feature/delta' });
  await expect(option.getByRole('button', { name: 'Moving…' })).toBeDisabled();
  finishMove();

  await expect(menu).toBeHidden();
  await expect(page.getByText('Branch moved here', { exact: true })).toBeVisible();
});

// keep branch checkout gated behind a clean, pushed destination
test('gates branch checkout on a clean, pushed destination', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // a dirty working copy disables every checkout
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: false, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/clean', checkedOut: false }
    ] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  const checkout = menu.getByRole('group', { name: 'feature/clean', exact: true }).getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeDisabled();
  await expect(checkout).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
});

// show the empty branch state and mark pull requests unavailable without a GitHub origin
test('shows the empty branch state and pull requests unavailable without a GitHub origin', async ({ page }) => {
  let repositoryRequests = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // a git checkout without a GitHub origin: no branches, no pull request support
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      repositoryRequests += 1;
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: false, branches: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  await expect(menu.getByRole('status', { name: 'No other local branches.', exact: true })).toBeVisible();
  await menu.getByRole('tab', { name: 'PRs', exact: true }).click();
  await expect(menu.getByRole('status', { name: 'Pull requests unavailable.', exact: true })).toBeVisible();
  expect(repositoryRequests).toBe(1);
});

// surface a rejected branch checkout with the server reason
test('shows the server reason when branch checkout fails', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [{ branch: 'feature/rejected', checkedOut: false }] } });
    // reject the checkout with an actionable reason
    if (url.pathname === '/api/worktrees/cora/switch-branch' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: 'The branch changed before checkout.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  await menu.getByRole('group', { name: 'feature/rejected', exact: true }).getByRole('button', { name: 'Checkout' }).click();

  await expect(page.getByRole('alert')).toContainText('Branch could not be checked out');
  await expect(page.getByRole('alert')).toContainText('The branch changed before checkout.');
});

// keep a failed branch move from reporting a false success
test('shows the server reason and no success when a branch move fails', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/delta', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
    ] } });
    // the move needs manual recovery
    if (url.pathname === '/api/worktrees/cora/move-branch' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: 'The branch move needs manual recovery.', recoveryRequired: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page, 'Branches');
  await menu.getByRole('group', { name: 'feature/delta', exact: true }).getByRole('button', { name: 'Checkout' }).click();

  await expect(page.getByRole('alert')).toContainText('Branch could not be moved');
  await expect(page.getByRole('alert')).toContainText('The branch move needs manual recovery.');
  // a rejected move must not claim success or dismiss the menu
  await expect(page.getByText('Branch moved here', { exact: true })).toHaveCount(0);
  await expect(menu).toBeVisible();
});

// the merged owner line navigates to the worktree that holds the branch
test('switches to the worktree that already holds a branch', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/delta', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
    ] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page, 'Branches');
  const deltaTab = page.getByRole('tab', { name: /^Delta/u });
  await expect(deltaTab).toHaveAttribute('aria-selected', 'false');
  await page.locator('.git-status-panel').getByRole('button', { name: 'Switch to Delta' }).click();

  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.git-status-panel')).toBeHidden();
});

// a worktree with no agent still lists and checks out branches
test('lists and checks out branches in a worktree with no agent', async ({ page }) => {
  let checkedOut: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'console', label: 'Console', available: true, worktrees: [{ id: 'idle', projectId: 'console', label: 'Idle', path: '/worktrees/idle', main: false, detached: false, locked: false, branch: 'feature/idle', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, available: true, pinned: true, order: 1 }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (url.pathname === '/api/worktrees/idle/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 300, title: 'Open work', branch: 'feature/open', checkoutBranch: 'feature/open', headSha: 'a'.repeat(40), headOnOrigin: true, draft: false, url: 'https://github.com/octo/repo/pull/300', checkedOut: false }], otherPullRequests: [], pullRequestsSupported: true, branches: [{ branch: 'feature/solo', checkedOut: false }] } });
    if (url.pathname === '/api/worktrees/idle/switch-branch' && request.method() === 'POST') { checkedOut = request.postDataJSON(); return route.fulfill({ status: 202, body: '' }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prs = await openBranchTab(page, 'PRs');
  await expect(prs.getByRole('link', { name: /#300/u })).toBeVisible();
  await prs.getByRole('tab', { name: 'Branches', exact: true }).click();
  await prs.getByRole('group', { name: 'feature/solo' }).getByRole('button', { name: 'Checkout' }).click();
  await expect.poll(() => checkedOut).toEqual({ branch: 'feature/solo' });
});

// a Project whose worktrees can be managed: its main checkout and one worktree with no agent
const newWorktreeProject = { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, worktrees: [
  { id: 'main', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
  { id: 'idle', projectId: 'repo', label: 'Idle', path: '/repo/wts/idle', main: false, detached: false, locked: false, branch: 'feature/idle', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, available: true, pinned: true, order: 1 }
] };

// stub one worktree's flyout list and the New worktree dialog's Project lists
async function stubNewWorktreeFromFlyout(page: Page, { agents, worktreeId, list, onCreate }: { agents: unknown[]; worktreeId: string; list: unknown; onCreate: (body: unknown) => void }) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects: [newWorktreeProject] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === `/api/worktrees/${worktreeId}/switch-prs` || url.pathname === '/api/projects/repo/switch-prs') return route.fulfill({ json: list });
    if (url.pathname === '/api/projects/repo/branches') return route.fulfill({ json: { branches: [
      { name: 'main', ref: 'main', remote: false, checkedOut: true },
      { name: 'feature/aaa', ref: 'feature/aaa', remote: false, checkedOut: false },
      { name: 'feature/solo', ref: 'feature/solo', remote: false, checkedOut: false }
    ], defaultBranch: 'main' } });
    if (url.pathname === '/api/projects/repo/worktrees' && request.method() === 'POST') { onCreate(request.postDataJSON()); return route.fulfill({ status: 201, json: { worktreeId: 'created' } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('opens New worktree on a pull request from its flyout row while the worktree is dirty', async ({ page }) => {
  let created: unknown;
  await stubNewWorktreeFromFlyout(page, {
    agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/repo/wts/cora', projectId: 'repo', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/current', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, title: 'Ready' }],
    worktreeId: 'cora',
    list: { enabled: false, pullRequests: [
      { number: 299, title: 'Earlier work', branch: 'feature/earlier', draft: false, url: 'https://github.com/acme/repo/pull/299', checkedOut: false },
      { number: 300, title: 'Review me', branch: 'feature/review', draft: false, url: 'https://github.com/acme/repo/pull/300', checkedOut: false },
      { number: 301, title: 'Held in Idle', branch: 'feature/idle', draft: false, url: 'https://github.com/acme/repo/pull/301', checkedOut: true, openIn: { worktreeId: 'idle', worktreeName: 'Idle' } }
    ], otherPullRequests: [], branches: [], pullRequestsSupported: true },
    onCreate: body => { created = body; }
  });

  await page.goto('/');
  await page.getByRole('tab', { name: /^Cora/u }).click();
  const menu = await openBranchTab(page, 'PRs');
  const row = menu.getByRole('group', { name: '#300: Review me; Open', exact: true });
  // checkout needs a clean worktree; a new worktree does not
  await expect(row.getByRole('button', { name: 'Checkout' })).toBeDisabled();
  // a PR another worktree holds offers only its Open in link
  await expect(menu.getByRole('group', { name: '#301: Held in Idle; Open', exact: true }).getByRole('button', { name: /^New worktree/u })).toHaveCount(0);
  await row.getByRole('button', { name: 'New worktree from #300' }).click();

  await expect(menu).toBeHidden();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('tab', { name: 'Pull request' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radio', { name: 'Select #300' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();
  await expect.poll(() => created).toEqual({ mode: 'pull-request', number: 300, open: 'agent' });
});

test('opens New worktree on a branch from its flyout row in a worktree with no agent', async ({ page }) => {
  let created: unknown;
  await stubNewWorktreeFromFlyout(page, {
    agents: [],
    worktreeId: 'idle',
    list: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [
      { branch: 'feature/solo', checkedOut: false },
      { branch: 'main', checkedOut: true, openIn: { worktreeId: 'main', worktreeName: 'Repo' } }
    ] },
    onCreate: body => { created = body; }
  });

  await page.goto('/');
  await page.getByRole('tab', { name: /^Idle/u }).click();
  await page.setViewportSize({ width: 360, height: 760 });
  const menu = await openBranchTab(page, 'Branches');
  // a branch another worktree holds offers only its Open in link
  await expect(menu.getByRole('group', { name: 'main', exact: true }).getByRole('button', { name: /^New worktree/u })).toHaveCount(0);
  const solo = menu.getByRole('group', { name: 'feature/solo', exact: true });
  // on a phone the row's three actions (new worktree, delete, checkout) still share one line
  const tops = await solo.locator('.switch-pr-action').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(tops).toHaveLength(3);
  expect(new Set(tops).size).toBe(1);
  await solo.getByRole('button', { name: 'New worktree from feature/solo' }).click();

  await expect(menu).toBeHidden();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('tab', { name: 'Existing branch' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('feature/solo');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();
  await expect.poll(() => created).toEqual({ mode: 'existing', branch: 'feature/solo', open: 'agent' });
});
