import { expect, test } from '@playwright/test';

// exercise explicit unpushed branch acknowledgement
test('guards deletion of an unpushed and unmerged branch', async ({ page }) => {
  let deletion: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // provide authenticated application state
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide one worktree-backed agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // provide one deletable local branch
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [{ branch: 'feature/risky', checkedOut: false }] } });
    // expose fresh risky branch facts
    if (url.pathname === '/api/worktrees/cora/branch-removal') return route.fulfill({ json: { branch: url.searchParams.get('branch'), checkedOut: false, dirtyCount: 0, pushed: false, merged: false, defaultBranch: false } });
    // record the guarded deletion
    if (url.pathname === '/api/worktrees/cora/branch' && request.method() === 'DELETE') { deletion = request.postDataJSON(); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('tab', { name: 'Branches', exact: true }).click();
  const branchOption = page.getByRole('group', { name: 'feature/risky', exact: true });
  const deleteButton = branchOption.getByRole('button', { name: 'Delete feature/risky' });
  const checkoutButton = branchOption.getByRole('button', { name: 'Checkout' });
  await expect(deleteButton).toHaveCSS('color', 'rgb(243, 139, 168)');
  const [deleteBounds, checkoutBounds] = await Promise.all([deleteButton.boundingBox(), checkoutButton.boundingBox()]);
  expect(deleteBounds).not.toBeNull();
  expect(checkoutBounds).not.toBeNull();
  // require measurable rendered controls
  if (deleteBounds === null || checkoutBounds === null) throw new Error('branch action bounds unavailable');
  expect(Math.abs(deleteBounds.width - deleteBounds.height)).toBeLessThanOrEqual(1);
  expect(deleteBounds.x + deleteBounds.width).toBeLessThanOrEqual(checkoutBounds.x);
  await deleteButton.click();

  const dialog = page.getByRole('dialog', { name: 'Delete branch' });
  await expect(dialog.getByText('No uncommitted changes')).toBeVisible();
  await expect(dialog.getByText('Not pushed · not merged')).toBeVisible();
  const confirm = dialog.getByRole('checkbox', { name: 'Delete unpushed work' });
  const submit = dialog.getByRole('button', { name: 'Delete branch', exact: true });
  await expect(submit).toBeDisabled();
  await confirm.check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => deletion).toEqual({ branch: 'feature/risky', discardUnpushed: true });
  await expect(dialog).toHaveCount(0);
  const success = page.locator('.operation-feedback.success').filter({ hasText: 'Branch deleted' });
  await expect(success).toBeVisible();
  await expect(success.locator('.toast-timer-bar')).toHaveCSS('animation-name', 'key-indicator-drain');
  await expect(success.locator('.toast-timer-bar')).toHaveCSS('animation-duration', '5s');
});

// block deletion while a branch owns dirty work
test('blocks deletion of a checked-out branch with uncommitted changes', async ({ page }) => {
  let deletionRequested = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // provide authenticated application state
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide one worktree-backed agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // provide one occupied local branch
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches: [{ branch: 'feature/occupied', checkedOut: true }] } });
    // expose fresh dirty checkout facts
    if (url.pathname === '/api/worktrees/cora/branch-removal') return route.fulfill({ json: { branch: url.searchParams.get('branch'), checkedOut: true, dirtyCount: 2, pushed: false, merged: false, defaultBranch: false } });
    // detect an unsafe delete attempt
    if (url.pathname === '/api/worktrees/cora/branch' && request.method() === 'DELETE') { deletionRequested = true; return route.fulfill({ status: 500 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('tab', { name: 'Branches', exact: true }).click();
  await page.getByRole('group', { name: 'feature/occupied', exact: true }).getByRole('button', { name: 'Delete feature/occupied' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete branch' });
  await expect(dialog.getByText('2 uncommitted changes')).toBeVisible();
  await expect(dialog.locator('.remove-worktree-blocked')).toContainText('Remove its worktree first.');
  await expect(dialog.getByRole('checkbox', { name: 'Delete unpushed work' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Delete branch', exact: true })).toBeDisabled();
  expect(deletionRequested).toBe(false);
});
