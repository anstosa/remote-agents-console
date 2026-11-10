import { expect, test } from '@playwright/test';

// unpinned worktrees offer removal with fresh safeguards; stale checkouts offer pruning
const dashboard = {
  generation: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, stalePaths: ['/repo/wts/gone', '/repo/wts/orphan'], worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
      { id: 'repo:/repo/wts/feat', projectId: 'repo', label: 'Repo · feat', path: '/repo/wts/feat', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feat' },
      { id: 'repo:/repo/wts/held', projectId: 'repo', label: 'Repo · held', path: '/repo/wts/held', main: false, detached: false, locked: true, available: true, pinned: false, order: 2, branch: 'held' }
    ] }
  ]
};

const facts = { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 2, pushed: true, merged: false, ahead: 1, behind: 0, blockers: [], stopsProcesses: [] };

// retain the prune mutation's parser and authentication framing
type PruneTransport = { contentType: string | undefined; body: string | null; csrf: string | undefined };

// isolate dashboard state and handle removal and pin requests
async function stub(page: import('@playwright/test').Page, handlers: { onDelete?: (body: unknown) => void; onPrune?: (transport: PruneTransport) => void; pruneError?: string; removal?: unknown; closedPullRequests?: unknown; pinned?: boolean } = {}) {
  const currentDashboard = structuredClone(dashboard);
  const feature = currentDashboard.projects[0]!.worktrees[1]!;
  feature.pinned = handlers.pinned ?? false;
  // answer each mocked request
  await page.route('**/api/**', async route => {
    const request = route.request();
    // the Worktree wire id carries `:` and `/`, so decode the encoded path before matching
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish refreshed pin state
    if (path === '/api/dashboard') return route.fulfill({ json: currentDashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/closed-pull-requests') return route.fulfill({ json: { worktrees: handlers.closedPullRequests ?? [] } });
    // persist the feature pin for the following dashboard refresh
    if (path === '/api/worktrees/repo:/repo/wts/feat/pin' && request.method() === 'POST') {
      feature.pinned = request.postDataJSON().pinned;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/worktrees/repo:/repo/wts/feat/removal') return route.fulfill({ json: handlers.removal ?? facts });
    if (path === '/api/worktrees/repo:/repo/wts/feat' && request.method() === 'DELETE') {
      handlers.onDelete?.(request.postDataJSON());
      return route.fulfill({ status: 200, json: { removed: true } });
    }
    // model the tunnel rejecting untyped mutations before pruning can run
    if (path === '/api/projects/repo/worktrees/prune' && request.method() === 'POST') {
      const transport = { contentType: request.headers()['content-type'], body: request.postData(), csrf: request.headers()['x-csrf-token'] };
      handlers.onPrune?.(transport);
      // reject missing or empty json framing rather than hiding the parser error
      if (transport.contentType !== 'application/json' || transport.body !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      // retain stale paths when the service refuses the operation
      if (handlers.pruneError !== undefined) return route.fulfill({ status: 409, json: { error: handlers.pruneError } });
      currentDashboard.projects[0]!.stalePaths = [];
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// verify pin-sensitive controls at desktop and phone breakpoints
for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  // exercise pin refreshes and rendered removal geometry
  test(`hides pinned removal and matches launch height on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await stub(page, { pinned: true, closedPullRequests: [{ worktreeId: 'repo:/repo/wts/feat', reason: 'merged' }] });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    // phones open the launcher through the workspace menu
    if (viewport.width <= 768) {
      await page.locator('.workspace-dropdown').click();
      await page.getByRole('button', { name: /New Workspace/u }).click();
    } else await page.locator('.new-agent-tab').click();
    const launcher = page.getByRole('group', { name: 'Agent launcher' });
    const row = launcher.locator('.launcher-row').filter({ has: page.getByRole('button', { name: 'Rename Repo · feat', exact: true }) });
    const remove = row.getByRole('button', { name: 'Remove Repo · feat', exact: true });
    const offer = row.getByRole('button', { name: 'PR merged · Remove Repo · feat', exact: true });

    await expect(row.getByRole('button', { name: 'Unpin Repo · feat' })).toHaveAttribute('aria-pressed', 'true');
    await expect(remove).toHaveCount(0);
    await expect(offer).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`pinned-removal-${viewport.name}.png`), fullPage: true });

    await row.getByRole('button', { name: 'Unpin Repo · feat' }).click();
    await expect(row.getByRole('button', { name: 'Pin Repo · feat', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(remove).toBeVisible();
    await expect(offer).toBeVisible();
    await expect(offer.locator(':scope > span')).toHaveText(['Merged.', 'Remove?']);
    const launch = row.getByRole('button', { name: 'Launch Repo · feat', exact: true });
    const [removeBounds, offerBounds, launchBounds] = await Promise.all([remove.boundingBox(), offer.boundingBox(), launch.boundingBox()]);
    // require real rendered comparison targets
    if (removeBounds === null || offerBounds === null || launchBounds === null) throw new Error('worktree action buttons did not render');
    expect(Math.abs(removeBounds.height - launchBounds.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(offerBounds.height - launchBounds.height)).toBeLessThanOrEqual(1);
    expect(offerBounds.width).toBeLessThan(launchBounds.width);
    const [statusBounds, promptBounds] = await Promise.all([offer.locator(':scope > span').first().boundingBox(), offer.locator(':scope > span').last().boundingBox()]);
    // require two separate rendered lines
    if (statusBounds === null || promptBounds === null) throw new Error('cleanup prompt lines did not render');
    expect(promptBounds.y).toBeGreaterThanOrEqual(statusBounds.y + statusBounds.height - 1);
    testInfo.annotations.push({ type: 'measurements', description: JSON.stringify({ removeHeight: removeBounds.height, offerHeight: offerBounds.height, launchHeight: launchBounds.height }) });
    await page.screenshot({ path: testInfo.outputPath(`unpinned-removal-${viewport.name}.png`), fullPage: true });

    await row.getByRole('button', { name: 'Pin Repo · feat', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Unpin Repo · feat' })).toHaveAttribute('aria-pressed', 'true');
    await expect(remove).toHaveCount(0);
    await expect(offer).toHaveCount(0);
  });
}

test('removes a linked worktree with discard and branch-delete from the launcher', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // pinned main hides removal; unpinned locked checkouts still explain their restriction
  const mainRemove = launcher.getByRole('button', { name: 'Remove Repo', exact: true });
  await expect(mainRemove).toHaveCount(0);
  const lockedRemove = launcher.getByRole('button', { name: 'Remove Repo · held' });
  await expect(lockedRemove).toBeDisabled();
  await expect(lockedRemove).toHaveAttribute('title', 'Locked worktrees cannot be removed');

  // Remove is icon-only, so its tooltip says what the icon does
  const remove = launcher.getByRole('button', { name: 'Remove Repo · feat' });
  await expect(remove).toHaveText('');
  await expect(remove).toHaveAttribute('title', 'Remove worktree');
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toBeVisible();
  // the fresh facts render, a dirty tree needs the discard tick, and the branch is deletable
  await expect(dialog.getByText('2 uncommitted changes')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
  await dialog.getByLabel('Discard uncommitted changes').check();
  await dialog.getByLabel(/Also delete branch/u).check();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();

  await expect.poll(() => deleted).toEqual({ discardChanges: true, deleteBranch: true });
  await expect(dialog).toBeHidden();
});

// keep explicit toolbar removal available for pinned worktrees
test('removes a linked worktree from the idle tab toolbar menu', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { pinned: true, onDelete: body => { deleted = body; } });
  await page.goto('/');
  // the pinned idle worktree has its own tab; open it, then the toolbar's ⋮ → Remove
  await page.getByRole('tab', { name: /Repo · feat/u }).click();
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'Remove worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Discard uncommitted changes').check();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => deleted).toEqual({ discardChanges: true, deleteBranch: false });
});

test('warns before deleting a branch that is neither pushed nor merged, but allows it', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { removal: { ...facts, dirtyCount: 0, pushed: false, merged: false }, onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });

  // the warning is there before the tick, and the tick is the operator's to make
  const warning = dialog.locator('.remove-worktree-branch-warning');
  await expect(warning).toContainText('neither pushed nor merged');
  const branchOption = dialog.getByLabel(/Also delete branch/u);
  await expect(branchOption).toBeEnabled();
  await branchOption.check();
  await expect(warning).toHaveClass(/armed/u);
  // a clean tree removes with no discard needed
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => deleted).toEqual({ discardChanges: false, deleteBranch: true });
});

test('refuses removal while a blocker runs', async ({ page }) => {
  await stub(page, { removal: { ...facts, dirtyCount: 0, blockers: ['a running agent'] } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });

  await expect(dialog.getByText(/Cannot remove while a running agent is running/u)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
});

// send explicit empty json without bypassing confirmation or csrf
test('prunes a project\'s stale checkouts from the launcher header', async ({ page }, testInfo) => {
  const pruned: PruneTransport[] = [];
  // capture only confirmed prune requests
  await stub(page, { onPrune: transport => { pruned.push(transport); } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  await launcher.getByRole('button', { name: '2 stale · Prune' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  await expect(dialog).toBeVisible();
  // both stale paths are listed by path, with the bridge warning
  await expect(dialog.getByText('/repo/wts/gone')).toBeVisible();
  await expect(dialog.getByText('/repo/wts/orphan')).toBeVisible();
  await expect(dialog.getByText(/does not mount can look stale/u)).toBeVisible();
  expect(pruned).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('prune-confirmation.png') });
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();

  await expect.poll(() => pruned.length).toBe(1);
  expect(pruned).toEqual([{ contentType: 'application/json', body: '{}', csrf: 'csrf-token' }]);
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Worktrees pruned', { exact: true })).toBeVisible();
});

// cancellation must never issue a destructive request
test('cancels pruning without touching stale checkouts', async ({ page }) => {
  const pruned: PruneTransport[] = [];
  // retain any unexpected prune request
  await stub(page, { onPrune: transport => { pruned.push(transport); } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('button', { name: '2 stale · Prune' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '2 stale · Prune' })).toBeVisible();
  expect(pruned).toEqual([]);
});

// a refusal stays visible until the user explicitly retries
test('keeps prune failures in the modal and allows an explicit retry', async ({ page }) => {
  const pruned: PruneTransport[] = [];
  // refuse the first confirmed operation without losing stale records
  const handlers: { pruneError?: string; onPrune: (transport: PruneTransport) => void } = { pruneError: 'Pruning is blocked.', onPrune: transport => { pruned.push(transport); } };
  await stub(page, handlers);
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('button', { name: '2 stale · Prune' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Pruning is blocked.');
  await expect(dialog.getByRole('button', { name: 'Prune', exact: true })).toBeEnabled();
  await expect(dialog.getByText('/repo/wts/gone')).toBeVisible();
  expect(pruned).toHaveLength(1);
  expect(pruned[0]).toEqual({ contentType: 'application/json', body: '{}', csrf: 'csrf-token' });
  // clear the refusal only for the next explicit confirmation
  delete handlers.pruneError;
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(pruned).toEqual([
    { contentType: 'application/json', body: '{}', csrf: 'csrf-token' },
    { contentType: 'application/json', body: '{}', csrf: 'csrf-token' }
  ]);
});

// a worktree whose pull request merged or closed is offered for removal, never removed
test('offers a closed pull request worktree for removal through the Remove dialog', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { closedPullRequests: [{ worktreeId: 'repo:/repo/wts/feat', reason: 'merged' }, { worktreeId: 'repo:/repo/wts/held', reason: 'closed' }], onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // each closed pull request worktree's row says why; a locked one cannot be removed, so it says why not
  const merged = launcher.getByRole('button', { name: 'PR merged · Remove Repo · feat', exact: true });
  await expect(merged.locator(':scope > span')).toHaveText(['Merged.', 'Remove?']);
  await expect(merged).toBeEnabled();
  // orange, as the GitHub panel's Remove Worktree…
  await page.mouse.move(0, 0);
  await expect(merged).toHaveCSS('background-color', 'rgb(250, 179, 135)');
  const closed = launcher.getByRole('button', { name: 'PR closed · Remove Repo · held', exact: true });
  await expect(closed.locator(':scope > span')).toHaveText(['Closed.', 'Remove?']);
  await expect(closed).toBeDisabled();
  await expect(closed).toHaveAttribute('title', 'Locked worktrees cannot be removed');
  await expect(launcher.getByRole('button', { name: /PR (merged|closed)/u })).toHaveCount(2);

  await merged.click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toBeVisible();
  // the dialog's own safeguards still apply: the dirty tree needs the discard tick
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
  expect(deleted).toBeUndefined();
});

test('lists every running Stack process the removal stops', async ({ page }) => {
  await stub(page, { removal: { ...facts, dirtyCount: 0, stopsProcesses: ['sync', 'web'] } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const stops = page.getByRole('dialog', { name: 'Remove worktree' }).locator('.remove-worktree-facts li').filter({ hasText: 'running Stack process' });
  await expect(stops).toHaveText(['Stops sync, its running Stack process', 'Stops web, its running Stack process']);
});

test('names the running Stack process the removal stops, without blocking it', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { removal: { ...facts, dirtyCount: 0, stopsProcesses: ['dev'] }, onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });

  await expect(dialog.locator('.remove-worktree-facts')).toContainText('Stops dev, its running Stack process');
  await expect(dialog.locator('.remove-worktree-blocked')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => deleted).toEqual({ discardChanges: false, deleteBranch: false });
});
