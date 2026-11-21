import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock.js';

// mount a console with toolbar and panel flyouts
async function stubConsole(page: Page, withBadges = false, flyoutMarkers = false) {
  await installPaneMock(page);
  const cleanupTargets = withBadges ? [{ id: 'worker-1', kind: 'orphan-worker', label: 'Orphan worker', detail: 'Test worker' }] : [];
  // isolate console requests from live services
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // provide a named active browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', flyoutMarkers } });
    // expose one workspace with flyout controls
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending: cleanupTargets.length, cleanupTargets, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'feature/markers', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }], projects: [] } });
    // connect the agent output
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // render a notes count only for the layering check
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: withBadges ? [{ id: 'note-1', title: 'Badge note', text: 'Test note' }] : [] } });
    // leave prompt collections empty
    if (/^\/api\/agents\/agent-1\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    // disable optional push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// inspect all rendered marker decorations
const visibleMarkers = (page: Page) => page.locator('button > .flyout-caret:visible');

// compare actual paint order without relying on a particular toolbar width
async function expectBadgeAboveMarker(button: Locator, selector: string) {
  await expect(button.locator(selector)).toHaveText('1');
  await expect(button.locator(':scope > .flyout-caret')).toBeVisible();
  // move the marker over the badge and make both decorations hit-testable
  const { badgeIndex, markerIndex } = await button.evaluate((element, selector) => {
    const badge = element.querySelector<HTMLElement>(selector);
    const marker = element.querySelector<HTMLElement>(':scope > .flyout-caret');
    // report a missing decoration before measuring its bounds
    if (!badge || !marker) throw new Error(`Missing badge or flyout marker for ${selector}`);
    const badgeBox = badge.getBoundingClientRect();
    const markerBox = marker.getBoundingClientRect();
    const x = badgeBox.left + badgeBox.width / 2;
    const y = badgeBox.top + badgeBox.height / 2;
    marker.style.translate = `${x - markerBox.left - markerBox.width / 2}px ${y - markerBox.top - markerBox.height / 2}px`;
    marker.style.mask = 'none';
    marker.style.pointerEvents = 'auto';
    badge.style.pointerEvents = 'auto';
    const layers = document.elementsFromPoint(x, y);
    return { badgeIndex: layers.indexOf(badge), markerIndex: layers.indexOf(marker) };
  }, selector);
  expect(badgeIndex).toBeGreaterThanOrEqual(0);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  expect(badgeIndex).toBeLessThan(markerIndex);
}

// exercise the same server preference on desktop and phone
for (const width of [1400, 390]) {
  // verify a directly attached badge and a wrapped badge group
  test(`button badges paint above server-enabled flyout markers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubConsole(page, true, true);
    await page.goto('/');
    const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
    await expectBadgeAboveMarker(toolbar.getByRole('button', { name: 'More options' }), '.cleanup-summary-count');
    await expectBadgeAboveMarker(toolbar.getByRole('button', { name: 'Notes (1)' }), '.notes-count-other');
  });

  // keep marker visibility independent of viewport layout
  test(`server-disabled markers leave flyout actions intact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubConsole(page);
    await page.goto('/');
    const server = page.locator('.tabs .server-selector');
    await expect(server).toBeVisible();
    await expect(server.locator(':scope > .flyout-caret')).toBeHidden();
    await expect(visibleMarkers(page)).toHaveCount(0);
    // hidden decorations leave context-menu opening intact
    await server.click({ button: 'right' });
    await expect(page.getByRole('group', { name: 'Remote Agents servers' })).toBeVisible();
  });
}

// prefer the authenticated server value over retired browser storage and query flags
test('legacy browser overrides cannot enable flyout markers', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await stubConsole(page);
  await page.goto('/?keep=value&flyout-markers=enabled');
  await expect(visibleMarkers(page)).toHaveCount(0);
  await expect(page).toHaveURL('/?keep=value&flyout-markers=enabled');
});

// restore markers from every authenticated session read
test('server-enabled flyout markers survive reload', async ({ page }) => {
  await stubConsole(page, false, true);
  await page.goto('/');
  const marker = page.locator('.tabs .server-selector > .flyout-caret');
  await expect(marker).toBeVisible();
  await page.reload();
  await expect(marker).toBeVisible();
});
