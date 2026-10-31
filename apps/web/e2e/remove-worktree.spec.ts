import { expect, test } from '@playwright/test';

// the Remove and Prune flows: every idle Worktree's launcher row carries a Remove icon —
// disabled with its reason on Main and on locked checkouts, so the column never goes blank —
// the dialog decides with fresh facts, and a Project with stale checkouts offers
// "N stale · Prune".
const dashboard = {
  generation: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, stalePaths: ['/repo/wts/gone', '/repo/wts/orphan'], worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
      { id: 'repo:/repo/wts/feat', projectId: 'repo', label: 'Repo · feat', path: '/repo/wts/feat', main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch: 'feat' },
      { id: 'repo:/repo/wts/held', projectId: 'repo', label: 'Repo · held', path: '/repo/wts/held', main: false, detached: false, locked: true, available: true, pinned: false, order: 2, branch: 'held' }
    ] }
  ]
};

const facts = { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 2, pushed: true, merged: false, ahead: 1, behind: 0, blockers: [], stopsProcesses: [] };

async function stub(page: import('@playwright/test').Page, handlers: { onDelete?: (body: unknown) => void; onPrune?: (contentType: string | undefined) => void; removal?: unknown; closedPullRequests?: unknown } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    // the Worktree wire id carries `:` and `/`, so decode the encoded path before matching
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/closed-pull-requests') return route.fulfill({ json: { worktrees: handlers.closedPullRequests ?? [] } });
    if (path === '/api/worktrees/repo:/repo/wts/feat/removal') return route.fulfill({ json: handlers.removal ?? facts });
    if (path === '/api/worktrees/repo:/repo/wts/feat' && request.method() === 'DELETE') {
      handlers.onDelete?.(request.postDataJSON());
      return route.fulfill({ status: 200, json: { removed: true } });
    }
    if (path === '/api/projects/repo/worktrees/prune' && request.method() === 'POST') {
      handlers.onPrune?.(request.headers()['content-type']);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('removes a linked worktree with discard and branch-delete from the launcher', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // Main keeps the Remove column but cannot act, and a locked linked worktree says why too
  const mainRemove = launcher.getByRole('button', { name: 'Remove Repo', exact: true });
  await expect(mainRemove).toBeDisabled();
  await expect(mainRemove).toHaveAttribute('title', 'The main worktree cannot be removed');
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

test('removes a linked worktree from the idle tab toolbar menu', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { onDelete: body => { deleted = body; } });
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

test('prunes a project\'s stale checkouts from the launcher header', async ({ page }) => {
  let pruned: { contentType: string | undefined } | undefined;
  await stub(page, { onPrune: contentType => { pruned = { contentType }; } });
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
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();

  await expect.poll(() => pruned !== undefined).toBe(true);
  // a body-less POST must not claim a JSON body: Fastify answers that pair with 400
  // "Body cannot be empty when content-type is set to 'application/json'"
  expect(pruned?.contentType).toBeUndefined();
  await expect(dialog).toBeHidden();
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
  await expect(merged).toHaveText('PR merged · Remove');
  await expect(merged).toBeEnabled();
  // orange, as the GitHub panel's Remove Worktree…
  await page.mouse.move(0, 0);
  await expect(merged).toHaveCSS('background-color', 'rgb(250, 179, 135)');
  const closed = launcher.getByRole('button', { name: 'PR closed · Remove Repo · held', exact: true });
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
