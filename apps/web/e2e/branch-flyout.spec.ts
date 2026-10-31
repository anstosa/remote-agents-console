import { expect, test, type Page } from '@playwright/test';

type RepositoryCommitFrame = {
  branchesDisabled: boolean;
  branchesBusy: boolean;
  skeletonTabs: number;
  cachedBranch: boolean;
  cachedActions: number;
  workingSelected: boolean;
  branchesSelected: boolean;
  error: string;
  retry: boolean;
};

// record every connected paintable repository panel commit
async function installRepositoryCommitRecorder(page: Page) {
  await page.evaluate(() => {
    type Frame = RepositoryCommitFrame;
    const frames: Frame[] = [];
    let previous = '';
    // snapshot only complete visible flyout subtrees
    const capture = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('.git-status-panel')].filter(panel => {
        const style = getComputedStyle(panel);
        return panel.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && panel.getClientRects().length > 0;
      });
      // retain each distinct paintable state
      for (const panel of panels) {
        const branches = panel.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Branches"]');
        const working = [...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.trim() === 'Working');
        // ignore partial portal construction
        if (branches === null || working === undefined) continue;
        const frame: Frame = {
          branchesDisabled: branches.disabled,
          branchesBusy: branches.getAttribute('aria-busy') === 'true',
          skeletonTabs: panel.querySelectorAll('.git-tab-skeleton').length,
          cachedBranch: panel.textContent?.includes('feature/cached') ?? false,
          cachedActions: panel.querySelectorAll('.switch-pr-actions').length,
          workingSelected: working.getAttribute('aria-selected') === 'true',
          branchesSelected: branches.getAttribute('aria-selected') === 'true',
          error: panel.querySelector<HTMLElement>('[role="alert"]')?.textContent?.trim() ?? '',
          retry: panel.querySelector<HTMLButtonElement>('button[aria-label="Retry repository choices"]') !== null
        };
        const serialized = JSON.stringify(frame);
        // collapse duplicate mutation notifications
        if (serialized !== previous) {
          frames.push(frame);
          previous = serialized;
        }
      }
    };
    const appendChild = Node.prototype.appendChild;
    const insertBefore = Node.prototype.insertBefore;
    // capture a fully prepared portal at the connection boundary
    Node.prototype.appendChild = function<T extends Node>(this: Node, child: T): T {
      const result = appendChild.call(this, child) as T;
      capture();
      return result;
    };
    // capture alternative react insertion paths
    Node.prototype.insertBefore = function<T extends Node>(this: Node, child: T, reference: Node | null): T {
      const result = insertBefore.call(this, child, reference) as T;
      capture();
      return result;
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    (window as unknown as { __repositoryCommitFrames: Frame[] }).__repositoryCommitFrames = frames;
  });
}

// read the paintable states captured inside the browser
async function repositoryCommitFrames(page: Page): Promise<RepositoryCommitFrame[]> {
  return page.evaluate(() => (window as unknown as { __repositoryCommitFrames?: RepositoryCommitFrame[] }).__repositoryCommitFrames ?? []);
}

// open the branch flyout on its Branches tab
async function openBranchTab(page: Page) {
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await panel.getByRole('tab', { name: 'Branches', exact: true }).click();
  return panel;
}

test('prefetches shared repository choices and refreshes them when reopened', async ({ page }) => {
  test.setTimeout(60_000);
  let finishRepository!: () => void;
  let finishRepositoryRefresh!: () => void;
  let repositoryRequests = 0;
  // hold repository choices through loading assertions
  const repositoryFinished = new Promise<void>(resolve => { finishRepository = resolve; });
  const repositoryRefreshFinished = new Promise<void>(resolve => { finishRepositoryRefresh = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      repositoryRequests += 1;
      await (repositoryRequests === 1 ? repositoryFinished : repositoryRefreshFinished);
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [{ branch: 'feature/cached', checkedOut: false }], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /^Git status:/u });
  await branchButton.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const tabs = panel.getByRole('tablist', { name: 'Branch views' });
  const workingTab = tabs.getByRole('tab', { name: 'Working', exact: true });
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
  await expect.poll(() => repositoryRequests).toBe(1);
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(workingTab).toBeEnabled();
  await expect(workingTab).toHaveText('Working');
  await expect(branchesTab).toBeDisabled();
  await expect(branchesTab).toHaveAttribute('aria-busy', 'true');
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(1);
  await expect(branchesTab.locator('.update-progress-ring')).toHaveCount(0);
  // capture the held repository loading state on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/branch-tabs-desktop.png` });
  const [panelBox, tabsBox] = await Promise.all([panel.boundingBox(), tabs.boundingBox()]);
  expect(panelBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  // require rendered flyout bounds
  if (panelBox === null || tabsBox === null) throw new Error('branch flyout bounds unavailable');
  expect(Math.abs(panelBox.y + panelBox.height - (tabsBox.y + tabsBox.height))).toBeLessThanOrEqual(1);
  expect(repositoryRequests).toBe(1);
  finishRepository();
  await expect(branchesTab).toBeEnabled();
  await expect(branchesTab).not.toHaveAttribute('aria-busy');
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await branchesTab.click();

  const branchOption = panel.getByRole('group', { name: 'feature/cached', exact: true });
  const checkout = branchOption.getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeEnabled();
  await page.mouse.click(4, 4);
  await installRepositoryCommitRecorder(page);
  await branchButton.click();
  await expect.poll(() => repositoryRequests).toBe(2);
  const heldFrames = await repositoryCommitFrames(page);
  expect(heldFrames.length).toBeGreaterThan(0);
  expect(heldFrames.every(frame => frame.branchesDisabled && frame.branchesBusy && frame.skeletonTabs === 1)).toBe(true);
  expect(heldFrames.every(frame => !frame.cachedBranch && frame.cachedActions === 0)).toBe(true);
  await expect(branchesTab).toBeDisabled();
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(1);
  await expect(branchOption).toHaveCount(0);
  finishRepositoryRefresh();
  await expect(branchesTab).toBeEnabled();
  await branchesTab.click();
  await expect(checkout).toBeEnabled();
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
});

// keep configured branch actions aligned with standard prompt controls
test('dispatches an iconless configured pull request action without a legacy fallback', async ({ page }) => {
  const emptyButtonSlots = {
    tabLead: [], leftNav: [], rightNav: [], navMenu: [], pullRequest: [],
    'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': []
  };
  let configured = true;
  const starts: Array<Record<string, unknown>> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the current configured catalog
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: configured ? 1 : 2,
      reviewTour: { available: true },
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', placeId: 'cora', projectId: 'repo', branch: 'feature/push-action', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }],
      projects: [],
      buttons: { revision: configured ? 'buttons-v1' : 'buttons-v2', application: { ...emptyButtonSlots, pullRequest: configured ? [{ id: 'finish-action', text: 'Finish and PR', color: 'mauve', style: 'solid', actionKind: 'prompt' }] : [] }, projects: {} }
    } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the agent stream
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // keep saved prompts empty
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // keep repository choices empty
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // record opaque configured action dispatch
    if (url.pathname === '/api/button-actions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      starts.push(body);
      return route.fulfill({ status: 202, json: { operation: { id: 'operation-finish-action', state: 'complete', phase: 'submitted' } } });
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
  // iconless configured actions retain their label and placement
  await expect(custom.locator('svg, .configured-button-icon')).toHaveCount(0);
  await expect(branchFlyout.locator('.git-status-actions').getByRole('button')).toHaveText(['View changes', 'Review', 'Finish and PR']);
  const [reviewBounds, customBounds] = await Promise.all([review.boundingBox(), custom.boundingBox()]);
  // require rendered action bounds
  if (reviewBounds === null || customBounds === null) throw new Error('branch action bounds unavailable');
  const horizontalOverlap = Math.max(0, Math.min(reviewBounds.x + reviewBounds.width, customBounds.x + customBounds.width) - Math.max(reviewBounds.x, customBounds.x));
  const verticalOverlap = Math.max(0, Math.min(reviewBounds.y + reviewBounds.height, customBounds.y + customBounds.height) - Math.max(reviewBounds.y, customBounds.y));
  expect(horizontalOverlap === 0 || verticalOverlap === 0).toBe(true);
  // match standard prompt-control height at desktop and mobile widths
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const [queueSize, reviewSize, customSize] = await Promise.all([queue.boundingBox(), review.boundingBox(), custom.boundingBox()]);
    // require each responsive control box
    if (queueSize === null || reviewSize === null || customSize === null) throw new Error('responsive branch action bounds unavailable');
    expect(reviewSize.height).toBeCloseTo(queueSize.height, 1);
    expect(customSize.height).toBeCloseTo(queueSize.height, 1);
    // keep the flyout right-aligned while the phone spans its viewport edges
    const flyoutBox = () => branchFlyout.evaluate(element => { const box = element.getBoundingClientRect(); return { left: Math.round(box.left), width: Math.round(box.width) }; });
    await expect.poll(async () => { const box = await flyoutBox(); return box.left + box.width; }).toBe(viewport.width - 6);
    const renderedFlyout = await flyoutBox();
    // match the current viewport layout
    if (viewport.width > 600) {
      expect(renderedFlyout.left).toBeGreaterThanOrEqual(6);
      expect(renderedFlyout.width).toBeGreaterThan(600);
    }
    else await expect.poll(flyoutBox).toEqual({ left: 6, width: viewport.width - 12 });
  }
  await custom.click();
  await expect.poll(() => starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ actionId: 'finish-action', configRevision: 'buttons-v1', placeId: 'cora', slot: 'pullRequest', agentId: 'agent-1' });
  expect(starts[0]).not.toHaveProperty('command');
  expect(starts[0]).not.toHaveProperty('prompt');
  expect(starts[0]).not.toHaveProperty('cwd');
  await expect(branchFlyout).toBeHidden();

  configured = false;
  await page.reload();
  await more.click();
  await expect(page.locator('.more-menu').getByRole('button', { name: 'Finish and PR', exact: true })).toHaveCount(0);
  await expect(page.locator('.more-menu').getByRole('button', { name: 'Commit/Push', exact: true })).toHaveCount(0);
  // leave the overflow menu before opening branch status
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const actions = page.getByRole('region', { name: 'Changed files' });
  await expect(actions.getByRole('button', { name: 'Finish and PR', exact: true })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Commit/Push', exact: true })).toHaveCount(0);
});

test('dismisses the flyout without activating a covered control, then switches to a branch\'s worktree', async ({ page }) => {
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
        pullRequests: [],
        otherPullRequests: [],
        branches: [
          { branch: 'feature/dirty-target', checkedOut: false },
          { branch: 'feature/delta-target', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
        ],
        pullRequestsSupported: true
      }
    });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const menu = await openBranchTab(page);
  await expect(menu.getByRole('group', { name: 'feature/dirty-target', exact: true })).toBeVisible();
  const switchToDelta = menu.getByRole('button', { name: 'Switch to Delta' });
  await expect(switchToDelta).toContainText('Open in Delta');
  const openOption = menu.getByRole('group', { name: 'feature/delta-target', exact: true });
  const checkout = openOption.getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeDisabled();
  await expect(checkout).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
  const [checkoutBox, switchBox] = await Promise.all([checkout.boundingBox(), switchToDelta.boundingBox()]);
  expect(checkoutBox).not.toBeNull();
  expect(switchBox).not.toBeNull();
  // require rendered option bounds
  if (checkoutBox === null || switchBox === null) throw new Error('branch action bounds unavailable');
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
  await openBranchTab(page);
  await switchToDelta.click();

  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
  await expect(menu).toBeHidden();
});

test('hides the workspace branch cache behind skeleton tabs while refreshing after a remount', async ({ page }) => {
  let repositoryRequests = 0;
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
      repositoryRequests += 1;
      // hold the remount refresh
      if (repositoryRequests > 1) await refreshFinished;
      const refreshed = repositoryRequests > 1;
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [{ branch: refreshed ? 'feature/refreshed' : 'feature/cached', checkedOut: false }], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page);
  const cached = page.getByRole('group', { name: 'feature/cached', exact: true });
  await expect(cached).toBeVisible();
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await page.getByRole('tab', { name: /^Delta/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await page.getByRole('button', { name: /^Git status:/u }).click();

  const menu = page.locator('.git-status-panel');
  const branchesTab = menu.getByRole('tab', { name: 'Branches', exact: true });
  await expect.poll(() => repositoryRequests).toBe(2);
  await expect(branchesTab).toBeDisabled();
  await expect(branchesTab).toHaveAttribute('aria-busy', 'true');
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(1);
  await expect(cached).toHaveCount(0);
  finishRefresh();
  await expect(branchesTab).toBeEnabled();
  await branchesTab.click();
  await expect(menu.getByRole('group', { name: 'feature/refreshed', exact: true })).toBeVisible();
  await expect(cached).toHaveCount(0);
  await expect(branchesTab.locator(':scope > .update-progress-ring')).toHaveCount(0);
});

// protect cached actions after refresh failures
test('keeps cached branch actions hidden when a refresh fails', async ({ page }) => {
  let repositoryRequests = 0;
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
      repositoryRequests += 1;
      // fail the remounted refresh
      if (repositoryRequests > 1) return route.fulfill({ status: 502, json: { error: 'GitHub could not load pull requests (503).' } });
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [{ branch: 'feature/cached', checkedOut: false }], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openBranchTab(page);
  const cached = page.getByRole('group', { name: 'feature/cached', exact: true });
  await expect(cached.getByRole('button', { name: 'Checkout' })).toBeEnabled();
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await installRepositoryCommitRecorder(page);
  await page.getByRole('button', { name: /^Git status:/u }).click();

  const menu = page.locator('.git-status-panel');
  await expect(menu.getByRole('alert')).toContainText('GitHub could not load pull requests (503).');
  const frames = await repositoryCommitFrames(page);
  const loadingIndex = frames.findIndex(frame => frame.skeletonTabs === 1 && frame.branchesBusy);
  expect(loadingIndex).toBeGreaterThanOrEqual(0);
  const firstSettled = frames.slice(loadingIndex + 1).find(frame => frame.skeletonTabs === 0);
  expect(firstSettled).toMatchObject({ cachedBranch: false, cachedActions: 0, workingSelected: true, branchesSelected: false, retry: true });
  expect(firstSettled?.error).toContain('GitHub could not load pull requests');
  await expect(menu.getByRole('tab', { name: 'Branches', exact: true })).toBeDisabled();
  await expect(cached).toHaveCount(0);
});

// expose failed repository lookups
// keep repository destinations inert until one successful list response
test('skeletonizes repository tabs through loading and error, then enables them after retry', async ({ page }) => {
  let finishFailure!: () => void;
  let repositoryRequests = 0;
  const failureFinished = new Promise<void>(resolve => {
    finishFailure = resolve;
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
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // fail once, then return one valid empty list
    if (url.pathname === '/api/worktrees/cora/switch-prs') {
      repositoryRequests += 1;
      if (repositoryRequests === 1) {
        await failureFinished;
        return route.fulfill({ status: 502, json: { error: 'Repository choices are temporarily unavailable.' } });
      }
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const workingTab = panel.getByRole('tab', { name: 'Working', exact: true });
  const branchesTab = panel.getByRole('tab', { name: 'Branches', exact: true });
  await expect(workingTab).toBeEnabled();
  await expect(workingTab).toHaveAttribute('aria-selected', 'true');
  await expect(branchesTab).toBeDisabled();
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(1);
  await expect(branchesTab).not.toHaveClass(/progress-border/u);

  finishFailure();
  await expect(panel.getByRole('alert')).toContainText('Repository choices are temporarily unavailable.');
  await expect(branchesTab).toBeDisabled();
  await expect(workingTab).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: 'Retry repository choices' }).click();
  await expect.poll(() => repositoryRequests).toBe(2);
  await expect(branchesTab).toBeEnabled();
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(0);
  await expect(branchesTab).toHaveText('Branches');
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
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await expect(panel.getByRole('alert')).toContainText('Repository choices are temporarily unavailable.');
  await expect(panel.getByRole('tab', { name: 'Branches', exact: true })).toBeDisabled();
  await expect(panel.locator('.git-status-repository-empty').filter({ hasText: /^No other local branches\.$/u })).toHaveCount(0);
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
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await expect(panel.getByRole('alert')).toContainText('The console returned invalid repository data.');
  await expect(panel.getByRole('tab', { name: 'Branches', exact: true })).toBeDisabled();
  await expect(panel.locator('.git-status-repository-empty').filter({ hasText: /^No other local branches\.$/u })).toHaveCount(0);
});

// cancel only when the complete branch flyout closes
test('keeps repository tabs inert and ignores a dismissed response', async ({ page }) => {
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
      await route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [{ branch: requestNumber === 1 ? 'feature/dismissed' : 'feature/current-response', checkedOut: false }], pullRequestsSupported: true } }).catch(() => { /* expected after cancellation */ });
      return;
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /^Git status:/u });
  await branchButton.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const workingTab = panel.getByRole('tab', { name: 'Working', exact: true });
  const branchesTab = panel.getByRole('tab', { name: 'Branches', exact: true });
  const dismissed = panel.getByRole('group', { name: 'feature/dismissed', exact: true });
  await expect.poll(() => repositoryRequests).toBe(1);
  await expect(branchesTab).toBeDisabled();
  await expect(branchesTab.locator('.git-tab-skeleton')).toHaveCount(1);
  expect(repositoryRequests).toBe(1);

  // dismiss the whole flyout to cancel its request
  await page.mouse.click(4, 4);
  await expect(panel).toBeHidden();
  await branchButton.click();
  await expect.poll(() => repositoryRequests).toBe(2);
  await expect(workingTab).toHaveAttribute('aria-selected', 'true');
  await expect(branchesTab).toBeDisabled();
  finishDismissedRequest();
  await expect(dismissed).toHaveCount(0);
  await expect(branchesTab).toBeDisabled();
  finishCurrentRequest();
  await expect(branchesTab).toBeEnabled();
  await branchesTab.click();
  await expect(panel.getByRole('group', { name: 'feature/current-response', exact: true })).toBeVisible();
  await expect(dismissed).toHaveCount(0);
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
  const menu = await openBranchTab(page);
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
  const menu = await openBranchTab(page);
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
  const menu = await openBranchTab(page);
  const checkout = menu.getByRole('group', { name: 'feature/clean', exact: true }).getByRole('button', { name: 'Checkout' });
  await expect(checkout).toBeDisabled();
  await expect(checkout).toHaveAttribute('title', 'Commit or stash uncommitted changes first');
});

// show the empty branch state without a GitHub origin
test('shows the empty branch state without a GitHub origin', async ({ page }) => {
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
  const menu = await openBranchTab(page);
  await expect(menu.locator('.git-status-repository-empty').filter({ hasText: /^No other local branches\.$/u })).toBeVisible();
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
  const menu = await openBranchTab(page);
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
  const menu = await openBranchTab(page);
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
  await openBranchTab(page);
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
  const menu = await openBranchTab(page);
  await menu.getByRole('group', { name: 'feature/solo' }).getByRole('button', { name: 'Checkout' }).click();
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
    ], base: 'main' } });
    if (url.pathname === '/api/projects/repo/worktrees' && request.method() === 'POST') { onCreate(request.postDataJSON()); return route.fulfill({ status: 201, json: { worktreeId: 'created' } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

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
  const menu = await openBranchTab(page);
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

test('offers no New worktree action on flyout rows when the launcher offers none', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.dynamic-worktrees', 'disabled'));
  await stubNewWorktreeFromFlyout(page, {
    agents: [],
    worktreeId: 'idle',
    list: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [{ branch: 'feature/solo', checkedOut: false }] },
    onCreate: () => {}
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^Idle/u }).click();
  const menu = await openBranchTab(page);
  const row = menu.getByRole('group', { name: 'feature/solo', exact: true });
  await expect(row.getByRole('button', { name: 'Checkout' })).toBeVisible();
  await expect(row.getByRole('button', { name: /^New worktree/u })).toHaveCount(0);
});
