import { expect, test } from '@playwright/test';

// review merged and closed PR suggestions with explicit consent for unmerged work
test('reviews hourly cleanup targets from the alert and glowing cleanup button', async ({ page }) => {
  test.setTimeout(45_000);
  let cleanupPending = 6;
  let submissions = 0;
  let submittedIds: string[] | undefined;
  const targets = [
    { id: 'worker-1', kind: 'orphan-worker', label: 'Orphan OMX worker', detail: 'worker-2 in tmux session feature-team' },
    { id: 'agent-1', kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old-agent at /worktrees/removed' },
    { id: 'pane-1', kind: 'hud-pane', label: 'HUD watcher', detail: 'hud in tmux session monitoring' },
    { id: 'process-1', kind: 'hud-process', label: 'Detached HUD watcher', detail: 'Host process 4321: omx hud --watch' },
    { id: 'branch-1', kind: 'merged-branch', label: 'feature/done', detail: 'Merged branch in Project' },
    { id: 'closed-branch-1', kind: 'closed-pr-branch', label: 'feature/closed', detail: 'Closed PR (not merged) in Project; deleting this branch discards unmerged work' }
  ];

  await page.addInitScript(() => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    class TestNotification { static permission: NotificationPermission = 'granted'; }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); }
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending, agents: [{ id: 'current-agent', sessionId: 'socket:$1', home: '/worktrees/current', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/current-agent/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/current-agent/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ json: { targets } });
    if (url.pathname === '/api/cleanup' && request.method() === 'POST') {
      submittedIds = (request.postDataJSON() as { targetIds: string[] }).targetIds;
      submissions += 1;
      // keep failed selections pending so retry consent can be verified
      if (submissions === 1) {
        cleanupPending = 2;
        return route.fulfill({ json: { targets: [targets[1], targets[5]] } });
      }
      cleanupPending = 0;
      return route.fulfill({ json: { targets: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/#cleanup');
  const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications)).toEqual([
    expect.objectContaining({ title: 'Cleanup available', options: expect.objectContaining({ body: '6 cleanup targets are ready.', tag: 'runtime-cleanup', data: expect.objectContaining({ url: '/#cleanup' }) }) })
  ]);

  const cleanupButton = page.getByRole('button', { name: 'Review 6 cleanup targets' });
  await expect(cleanupButton).toBeVisible();
  await expect(cleanupButton).toHaveClass(/cleanup-toggle/);
  // cleanup waits in the Workspace toolbar while it is pending
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Review 6 cleanup targets' })).toBeVisible();
  await expect(cleanupButton.locator('svg.broom-icon')).toBeVisible();
  await expect(cleanupButton.locator('svg.broom-icon')).toHaveCSS('fill', 'rgb(249, 226, 175)');
  await expect(cleanupButton.locator('.cleanup-count')).toHaveText('6');
  await expect(dialog.getByText('Orphaned worker')).toBeVisible();
  await expect(dialog.getByText('Stale agent')).toBeVisible();
  await expect(dialog.getByText('HUD watcher window')).toBeVisible();
  await expect(dialog.getByText('HUD watcher', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Merged branch', { exact: true })).toBeVisible();
  const checks = dialog.getByRole('checkbox');
  await expect(checks).toHaveCount(6);
  await expect(dialog.getByText('Closed PR branch', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Closed PR (not merged) in Project; deleting this branch discards unmerged work', { exact: true })).toBeVisible();
  const closedCheck = dialog.locator('label').filter({ hasText: 'feature/closed' }).getByRole('checkbox');
  await expect(closedCheck).not.toBeChecked();
  // preselect only existing non-closed cleanup kinds
  for (let index = 0; index < 5; index += 1) await expect(checks.nth(index)).toBeChecked();

  await page.getByRole('button', { name: 'Close cleanup' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cleanupButton).toBeFocused();
  await cleanupButton.click();
  await expect(dialog).toBeVisible();
  await expect(closedCheck).not.toBeChecked();

  // clear all cleanup selections
  for (let index = 0; index < 5; index += 1) await checks.nth(index).uncheck();
  await expect(dialog.getByRole('button', { name: 'Dismiss all' })).toBeVisible();
  await checks.nth(1).check();
  await checks.nth(3).check();
  // explicitly consent to removing the unmerged closed PR branch
  await closedCheck.check();
  await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
  await expect.poll(() => submittedIds).toEqual(['agent-1', 'process-1', 'closed-branch-1']);
  await expect(dialog.getByRole('alert')).toHaveText('Some selected targets could not be cleaned up.');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.locator('label').filter({ hasText: 'Stale Codex agent' }).getByRole('checkbox')).toBeChecked();
  await expect(closedCheck).not.toBeChecked();
  // leaving the closed branch unchecked dismisses it without retrying deletion
  await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
  await expect.poll(() => submittedIds).toEqual(['agent-1']);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.cleanup-toggle')).toHaveCount(0);
});

// never turn a failed or malformed cleanup read into a trustworthy empty state
for (const scenario of [
  { name: 'failed', status: 503, payload: { error: 'cleanup unavailable' } },
  { name: 'malformed', status: 200, payload: { targets: [{ id: 'unknown', kind: 'future-kind', label: 'Unknown', detail: 'unsupported' }] } },
]) {
  test(`stops cleanup skeletons without showing false empty content after a ${scenario.name} read`, async ({ page }) => {
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      // restore one controlling browser
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      // expose one pending cleanup target
      if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending: 1, agents: [], projects: [] } });
      if (url.pathname === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ status: scenario.status, json: scenario.payload });
      if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await page.goto('/#cleanup');
    const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
    await expect(dialog.getByRole('alert')).toHaveText('Unable to load cleanup targets.');
    await expect(dialog.locator('.cleanup-skeleton')).toHaveCount(0);
    await expect(dialog.locator('.cleanup-empty')).toHaveCount(0);
    await expect(dialog.getByText('No cleanup targets remain.')).toHaveCount(0);
    await expect(dialog.locator('.cleanup-actions button')).toBeDisabled();
  });
}
