import { expect, test, type Page } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock.js';

// mount a console with toolbar and panel flyouts
async function stubConsole(page: Page) {
  await installPaneMock(page);
  // isolate console requests from live services
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // provide a named active browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one workspace with flyout controls
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'feature/markers', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }], projects: [] } });
    // connect the agent output
    if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // leave notes and prompt collections empty
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/agents\/agent-1\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    // disable optional push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the browser settings panel
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  return page.getByRole('switch', { name: 'Flyout markers', exact: true });
}

// inspect all rendered marker decorations
const visibleMarkers = (page: Page) => page.locator('button > .flyout-caret:visible');
// read the persistent browser choice
const storedMarkers = (page: Page) => page.evaluate(() => localStorage.getItem('rac.flyout-markers'));

// exercise the same preference on desktop and phone
for (const width of [1400, 390]) {
  // keep marker visibility independent of viewport layout
  test(`markers default off and toggle without changing flyout actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubConsole(page);
    await page.goto('/');
    const server = page.locator('.tabs .server-selector');
    const marker = server.locator(':scope > .flyout-caret');
    await expect(server).toBeVisible();
    await expect(marker).toBeHidden();
    expect(await storedMarkers(page)).toBeNull();
    const markers = await openSettings(page);
    await expect(markers).not.toBeChecked();
    await markers.check();
    await expect(marker).toBeHidden();
    expect(await storedMarkers(page)).toBeNull();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(marker).toBeVisible();
    expect(await storedMarkers(page)).toBe('enabled');
    await page.getByRole('button', { name: 'Close settings' }).click();
    // enabled decorations do not intercept flyout clicks
    await server.click();
    await expect(page.getByRole('group', { name: 'Remote Agents servers' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(marker).toBeVisible();
    const restored = await openSettings(page);
    await expect(restored).toBeChecked();
    await restored.uncheck();
    await expect(marker).toBeVisible();
    expect(await storedMarkers(page)).toBe('enabled');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(visibleMarkers(page)).toHaveCount(0);
    expect(await storedMarkers(page)).toBeNull();
    await page.getByRole('button', { name: 'Close settings' }).click();
    // hidden decorations leave context-menu opening intact
    await server.click({ button: 'right' });
    await expect(page.getByRole('group', { name: 'Remote Agents servers' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(marker).toBeHidden();
    await expect(await openSettings(page)).not.toBeChecked();
  });
}

// consume a personal opt-in without changing the global default
test('the activation link enables this browser once and opens settings', async ({ page }) => {
  await stubConsole(page);
  await page.goto('/?keep=value&flyout-markers=enabled#settings');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const markers = page.getByRole('switch', { name: 'Flyout markers', exact: true });
  await expect(markers).toBeChecked();
  await expect(page).toHaveURL('/?keep=value#settings');
  expect(await storedMarkers(page)).toBe('enabled');
  await markers.uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.reload();
  await expect(markers).not.toBeChecked();
  await expect(visibleMarkers(page)).toHaveCount(0);
});

// synchronize real same-origin tabs including cleared storage
test('open tabs follow enabled, disabled, and cleared preferences', async ({ page, context }) => {
  const peer = await context.newPage();
  await stubConsole(page);
  await stubConsole(peer);
  await page.goto('/');
  await peer.goto('/');
  const markers = await openSettings(page);
  const peerMarkers = await openSettings(peer);
  await markers.check();
  await expect(peerMarkers).not.toBeChecked();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(peerMarkers).toBeChecked();
  await expect(peer.locator('.tabs .server-selector > .flyout-caret')).toBeVisible();
  await markers.uncheck();
  await expect(peerMarkers).toBeChecked();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(peerMarkers).not.toBeChecked();
  await expect(visibleMarkers(peer)).toHaveCount(0);
  await markers.check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(peerMarkers).toBeChecked();
  // clearing browser preferences restores the hidden default
  await page.evaluate(() => localStorage.clear());
  await expect(peerMarkers).not.toBeChecked();
  await expect(visibleMarkers(peer)).toHaveCount(0);
});

// reject stale values rather than silently enabling markers
test('unknown stored values keep markers hidden', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'true'));
  await stubConsole(page);
  await page.goto('/');
  await expect(await openSettings(page)).not.toBeChecked();
  await expect(visibleMarkers(page)).toHaveCount(0);
});

// preserve an in-memory toggle when storage is unavailable
test('blocked storage does not prevent toggling markers', async ({ page }) => {
  // emulate a browser denying preference storage
  await page.addInitScript(() => {
    // deny reads and writes consistently
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      Object.defineProperty(Storage.prototype, method, { value: () => { /* report storage denial */ throw new DOMException('Storage blocked', 'SecurityError'); } });
    }
  });
  await stubConsole(page);
  await page.goto('/');
  const markers = await openSettings(page);
  await expect(markers).not.toBeChecked();
  await markers.check();
  await expect(page.locator('.tabs .server-selector > .flyout-caret')).toBeHidden();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.tabs .server-selector > .flyout-caret')).toBeVisible();
  await markers.uncheck();
  await expect(page.locator('.tabs .server-selector > .flyout-caret')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(visibleMarkers(page)).toHaveCount(0);
});
