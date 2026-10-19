import { expect, test, type Locator, type Page } from '@playwright/test';

type BrowserErrors = string[];

// retain actionable browser failures
function captureBrowserErrors(errors: BrowserErrors, page: Page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    // ignore deliberately unmocked optional resources
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
}

// report whether overlays leave a control pointer-actionable
const isPointerActionable = (locator: Locator) => locator.click({ trial: true, timeout: 1_500 }).then(() => true, () => false);

// keep one latched reload notice across layouts and dismissal attempts
test('keeps a stale UI reload toast visible in the shared upper-right stack', async ({ page }) => {
  const browserErrors: BrowserErrors = [];
  let uiVersion: string | undefined;
  let uiVersionChecks = 0;
  let updateStarts = 0;
  let navigations = 0;
  captureBrowserErrors(browserErrors, page);
  page.on('framenavigated', frame => {
    // count only full-page navigation
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page.clock.install({ time: new Date('2026-10-01T12:00:00-07:00') });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one idle upstream worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'console', label: 'Console', available: true, worktrees: [{ id: 'idle', projectId: 'console', label: 'Idle', path: '/worktrees/idle', main: false, detached: false, locked: false, branch: 'feature/idle', gitUpstream: { upstream: 'origin/feature/idle', ahead: 0, behind: 1 }, available: true, pinned: true, order: 1 }] }] } });
    // return the selected bundle version
    if (url.pathname === '/api/ui-version') {
      uiVersionChecks += 1;
      return route.fulfill({ json: { version: uiVersion } });
    }
    // keep the host update path inactive
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // flag accidental host mutations
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'unexpected-update', kind: 'update', state: 'queued' } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // return empty idle-worktree stores
    if (url.pathname === '/api/worktrees/idle/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/idle/panes') return route.fulfill({ json: { panes: [] } });
    if (url.pathname === '/api/worktrees/idle/launch-resolution') return route.fulfill({ json: { adapters: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const currentVersion = await page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    return script === null ? undefined : new URL(script.src).pathname;
  });
  expect(currentVersion).toBeTruthy();

  // matching assets do not raise the reload notice
  uiVersion = currentVersion;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => uiVersionChecks).toBe(1);
  await expect(page.getByRole('status', { name: 'UI update available' })).toHaveCount(0);

  // a different bundle latches one persistent notice
  uiVersion = '/assets/index-new.js';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => uiVersionChecks).toBe(2);
  const notification = page.getByRole('status', { name: 'UI update available' });
  await expect(notification).toBeVisible();
  await expect(notification.getByRole('heading', { name: 'UI update available' })).toBeVisible();
  const reload = notification.getByRole('button', { name: 'Reload UI' });
  await expect(reload).toBeVisible();
  await expect(notification.getByRole('button')).toHaveCount(1);
  await expect(notification.locator('.toast-timer-bar')).toHaveCount(0);

  // one fixed stack holds both persistent notices
  const upstreamNotification = page.getByRole('status', { name: 'origin/feature/idle has 1 new commit' });
  await expect(upstreamNotification).toBeVisible();
  await expect(upstreamNotification.locator('.toast-timer-bar')).toHaveCount(0);
  const toastRegion = notification.locator('..');
  await expect(toastRegion).toHaveCount(1);
  await expect(toastRegion.getByRole('status', { name: 'origin/feature/idle has 1 new commit' })).toHaveCount(1);
  const desktopLayout = await toastRegion.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { position: getComputedStyle(element).position, top: bounds.top, right: innerWidth - bounds.right, left: bounds.left, bottom: bounds.bottom, width: innerWidth, height: innerHeight };
  });
  expect(desktopLayout.position).toBe('fixed');
  expect(desktopLayout.top).toBeGreaterThan(0);
  expect(desktopLayout.right).toBeLessThanOrEqual(10);
  expect(desktopLayout.left).toBeGreaterThan(desktopLayout.width / 2);
  expect(desktopLayout.bottom).toBeLessThanOrEqual(desktopLayout.height);
  await page.screenshot({ path: '/tmp/client-update-toast-desktop.png', fullPage: true });

  // matching later checks cannot clear the latched notice
  uiVersion = currentVersion;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => uiVersionChecks).toBe(3);
  await expect(notification).toBeVisible();

  // ordinary dismissal paths and elapsed time leave it visible
  await page.keyboard.press('Escape');
  await page.mouse.click(2, 898);
  await page.clock.fastForward(10 * 60_000);
  await expect(notification).toBeVisible();

  // phone layout stays within both side insets
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBounds = await notification.boundingBox();
  expect(phoneBounds).not.toBeNull();
  // stop when layout bounds are unavailable
  if (phoneBounds === null) throw new Error('UI update notice has no layout bounds');
  expect(phoneBounds.x).toBeGreaterThanOrEqual(8);
  expect(phoneBounds.x + phoneBounds.width).toBeLessThanOrEqual(382);
  expect(phoneBounds.y).toBeGreaterThanOrEqual(0);
  expect(phoneBounds.y + phoneBounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: '/tmp/client-update-toast-mobile.png', fullPage: true });

  // displaced stacks still reserve their full top inset
  const insetStyle = await page.addStyleTag({ content: '.toast-region { top: calc(var(--panel-header-clearance) + .5rem + 44px) !important; }' });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  const settingsButton = page.getByRole('button', { name: /Global settings/u });
  await settingsButton.click();
  let settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: /reload/iu })).toHaveCount(0);
  const insetRenameClientActionable = await isPointerActionable(settings.getByRole('button', { name: 'Rename browser name' }));
  await expect(notification).toBeVisible();
  await page.screenshot({ path: '/tmp/client-update-toast-settings-mobile.png', fullPage: true });
  await insetStyle.evaluate(element => element.remove());
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // a large sibling stays bounded behind the reload notice
  await page.setViewportSize({ width: 640, height: 360 });
  const upstreamDetail = upstreamNotification.locator('small');
  const originalUpstreamDetail = await upstreamDetail.textContent();
  await upstreamDetail.evaluate(element => {
    element.textContent = `origin/feature/idle has 1 new commit. ${'This update contains additional migration and deployment context. '.repeat(45)}`;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const shortLayout = await toastRegion.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, viewportHeight: innerHeight };
  });
  const shortReloadBounds = await reload.boundingBox();
  const shortUpstreamBounds = await upstreamNotification.boundingBox();
  const shortReloadVisible = shortReloadBounds !== null && shortReloadBounds.y >= 0 && shortReloadBounds.y + shortReloadBounds.height <= shortLayout.viewportHeight;
  const shortReloadFirst = shortReloadBounds !== null && shortUpstreamBounds !== null && shortReloadBounds.y <= shortUpstreamBounds.y;
  const shortReloadActionable = await isPointerActionable(reload);
  await toastRegion.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const scrolledReloadBounds = await reload.boundingBox();
  const scrolledReloadVisible = scrolledReloadBounds !== null && scrolledReloadBounds.y >= shortLayout.top && scrolledReloadBounds.y + scrolledReloadBounds.height <= shortLayout.bottom;
  const scrolledReloadActionable = await isPointerActionable(reload);
  const shortSettingsTriggerActionable = await isPointerActionable(settingsButton);
  await settingsButton.click();
  settings = page.getByRole('dialog', { name: 'Settings' });
  const shortRenameClientActionable = await isPointerActionable(settings.getByRole('button', { name: 'Rename browser name' }));
  await expect(notification).toBeVisible();
  await page.screenshot({ path: '/tmp/client-update-toast-settings-landscape.png', fullPage: true });
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await upstreamDetail.evaluate((element, original) => { element.textContent = original; }, originalUpstreamDetail);

  expect({
    insetRenameClientActionable,
    shortStackBounded: shortLayout.bottom <= shortLayout.viewportHeight && shortLayout.height <= shortLayout.viewportHeight * .4 + 1,
    shortStackScrollable: shortLayout.scrollHeight > shortLayout.clientHeight,
    shortReloadVisible,
    shortReloadFirst,
    shortReloadActionable,
    scrolledReloadVisible,
    scrolledReloadActionable,
    shortSettingsTriggerActionable,
    shortRenameClientActionable
  }).toEqual({
    insetRenameClientActionable: true,
    shortStackBounded: true,
    shortStackScrollable: true,
    shortReloadVisible: true,
    shortReloadFirst: true,
    shortReloadActionable: true,
    scrolledReloadVisible: true,
    scrolledReloadActionable: true,
    shortSettingsTriggerActionable: true,
    shortRenameClientActionable: true
  });

  // desktop rename stays actionable beneath the toast
  await page.setViewportSize({ width: 1440, height: 900 });
  await settingsButton.click();
  settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Rename browser name' }).click({ trial: true });
  await expect(notification).toBeVisible();
  await page.screenshot({ path: '/tmp/client-update-toast-settings-desktop.png', fullPage: true });
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // reload navigates without starting a server update
  const initialNavigations = navigations;
  await reload.click();
  await expect.poll(() => navigations).toBeGreaterThan(initialNavigations);
  expect(updateStarts).toBe(0);
  expect(browserErrors).toEqual([]);
});
