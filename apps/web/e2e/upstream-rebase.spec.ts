import { expect, test } from '@playwright/test';

// verify the standalone notice layout, action feedback and explicit dismissal
test('floats a persistent dismissible rebase notification in the shared toast stack', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="root"></div>');
  await page.evaluate(async () => {
    const { renderUpstreamRebaseNotifications } = await import('/e2e/upstream-rebase-fixture.tsx');
    renderUpstreamRebaseNotifications(document.querySelector<HTMLElement>('#root')!);
  });

  const notification = page.getByRole('status', { name: 'origin/feature has 3 new commits' });
  await expect(notification).toBeVisible();
  await expect(notification).toContainText('origin/feature has 3 new commits. Your branch also has 2 local commits.');
  await expect(page.locator('.upstream-rebase-notification')).toHaveCount(1);
  const desktopLayout = await page.locator('.toast-region').evaluate(element => {
    const region = element.getBoundingClientRect();
    return { position: getComputedStyle(element).position, top: region.top, right: innerWidth - region.right, scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
  });
  expect(desktopLayout.position).toBe('fixed');
  expect(desktopLayout.top).toBeGreaterThan(0);
  expect(desktopLayout.right).toBeLessThanOrEqual(10);
  expect(desktopLayout.scrollHeight).toBeLessThanOrEqual(desktopLayout.viewportHeight);

  // retain the same fixed stack with phone-safe side insets
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.locator('.toast-region').evaluate(element => {
    const region = element.getBoundingClientRect();
    return { position: getComputedStyle(element).position, left: region.left, right: innerWidth - region.right, scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
  });
  expect(mobileLayout).toEqual({ position: 'fixed', left: 8, right: 8, scrollHeight: mobileLayout.viewportHeight, viewportHeight: mobileLayout.viewportHeight });

  const rebase = page.getByRole('button', { name: 'Rebase onto origin/feature' });
  await rebase.click();
  await expect(page.locator('#root')).toHaveAttribute('data-rebase', 'queued');
  await expect(rebase).toContainText('Queued');
  // action feedback resets, but the notification never dismisses itself
  await page.waitForTimeout(5_200);
  await expect(rebase).toContainText('Rebase upstream');
  await expect(notification).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss upstream update notification' }).click();
  await expect(notification).toHaveCount(0);
});

// verify app-level dismissal identity and the existing rebase request
test('persists an unchanged dismissal across tabs and reloads, then offers a changed update', async ({ page }) => {
  let queuedPrompt: unknown;
  let behind = 2;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose two switchable worktrees and a mutable upstream count
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: behind, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'console', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, branch: 'feature/console', gitUpstream: { upstream: 'origin/feature/console', ahead: 1, behind }, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', projectId: 'console', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 2, branch: 'feature/other', title: 'Ready' }
    ], projects: [] } });
    // disable unrelated notification enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // suppress the separate host update flow
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // authorize both output panes
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty agent stores
    if (/^\/api\/agents\/agent-[12]\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [] } });
    // accept foreground notification cleanup
    if (/^\/api\/agents\/agent-[12]\/notifications\/dismiss$/u.test(url.pathname)) return route.fulfill({ status: 204 });
    // force real operation feedback from composer note persistence
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
    // capture the retained rebase action
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const notification = page.getByRole('status', { name: 'origin/feature/console has 2 new commits' });
  await expect(notification).toBeVisible();
  await expect(page.locator('body > .toast-region').locator('.upstream-rebase-notification')).toHaveCount(1);
  await expect(page.locator('.agent-view .upstream-rebase-notification')).toHaveCount(0);

  // phone layout keeps the notification out of workspace flow and against the safe side insets
  await page.setViewportSize({ width: 390, height: 844 });
  // measure safe insets after the notification entry animation settles
  await expect.poll(async () => {
    const bounds = await notification.boundingBox();
    return bounds === null ? null : { left: bounds.x, right: bounds.x + bounds.width };
  }).toEqual({ left: 8, right: 382 });

  // restore desktop tabs before exercising the tab roundtrip
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Dismiss upstream update notification' }).click();
  await expect(notification).toHaveCount(0);
  await page.getByRole('tab', { name: /^Owen/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await expect(notification).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Cora/u })).toBeVisible();
  await expect(notification).toHaveCount(0);

  // a new behind count represents a new upstream update and must surface again
  behind = 3;
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Cora/u })).toBeVisible();
  const changed = page.getByRole('status', { name: 'origin/feature/console has 3 new commits' });
  await expect(changed).toBeVisible();
  await changed.getByRole('button', { name: 'Rebase onto origin/feature/console' }).click();

  await expect.poll(() => queuedPrompt).toEqual({ prompt: '$rebase origin/feature/console', attachments: [] });
  await expect(changed).toBeVisible();

  // real operation feedback shares one stack without displacing the upstream notice
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.fill('Save this as a note');
  await composer.press('Control+s');
  const toastRegion = page.locator('body > .toast-region');
  const feedback = toastRegion.getByRole('alert');
  await expect(toastRegion).toHaveCount(1);
  await expect(feedback).toContainText('Unable to save draft as a note');
  await expect(toastRegion.locator('.upstream-rebase-notification')).toHaveCount(1);
  const feedbackBox = await feedback.boundingBox();
  const notificationBox = await changed.boundingBox();
  expect(feedbackBox).not.toBeNull();
  expect(notificationBox).not.toBeNull();
  expect(feedbackBox!.y + feedbackBox!.height).toBeLessThan(notificationBox!.y);
  await feedback.getByRole('button', { name: 'Dismiss operation status' }).click();
  await expect(feedback).toHaveCount(0);
  await expect(changed).toBeVisible();

  // retire the stale dismissal once a different update has appeared
  behind = 2;
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Cora/u })).toBeVisible();
  const returned = page.getByRole('status', { name: 'origin/feature/console has 2 new commits' });
  await expect(returned).toBeVisible();

  // catching up clears a fresh dismissal so the same count can notify later
  await returned.getByRole('button', { name: 'Dismiss upstream update notification' }).click();
  behind = 0;
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Cora/u })).toBeVisible();
  await expect(page.locator('.upstream-rebase-notification')).toHaveCount(0);
  behind = 2;
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Cora/u })).toBeVisible();
  await expect(returned).toBeVisible();
});

// verify agentless worktrees use the same fixed notification surface
test('floats the same launch-required notification for an idle worktree', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one idle behind worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'console', label: 'Console', available: true, worktrees: [{ id: 'idle', projectId: 'console', label: 'Idle', path: '/worktrees/idle', main: false, detached: false, locked: false, branch: 'feature/idle', gitUpstream: { upstream: 'origin/feature/idle', ahead: 0, behind: 1 }, available: true, pinned: true, order: 1 }] }] } });
    // disable unrelated notification enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // suppress the separate host update flow
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notification = page.getByRole('status', { name: 'origin/feature/idle has 1 new commit' });
  await expect(notification).toBeVisible();
  await expect(page.locator('body > .toast-region').locator('.upstream-rebase-notification')).toHaveCount(1);
  await expect(page.locator('.agent-view .upstream-rebase-notification')).toHaveCount(0);
  const rebase = notification.getByRole('button', { name: 'Rebase onto origin/feature/idle' });
  await expect(rebase).toBeDisabled();
  await expect(rebase).toHaveAttribute('title', 'Launch the agent to rebase upstream');

  await notification.getByRole('button', { name: 'Dismiss upstream update notification' }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Idle/u })).toBeVisible();
  await expect(notification).toHaveCount(0);
});

// keep the reviewed host repository on its dedicated update path
test('hides the branch rebase notification for the Remote Agents host repository', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose a behind host repository agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-remoteagents', sessionId: 'socket:$1', home: '/workspace', projectId: 'remoteagents', worktreeId: 'remoteagents', worktreeLabel: 'Remote Agents', branch: 'main', gitUpstream: { upstream: 'origin/main', ahead: 0, behind: 2 }, title: 'Ready' }], projects: [] } });
    // keep the reviewed host updater current for this banner check
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // authorize the visible agent output
    if (url.pathname === '/api/agents/agent-remoteagents/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt stores
    if (/^\/api\/agents\/agent-remoteagents\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Remote Agents/u })).toBeVisible();
  await expect(page.getByText('Upstream updates available')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rebase onto origin/main' })).toHaveCount(0);
});
