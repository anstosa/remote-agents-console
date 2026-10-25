import { expect, test, type Page, type Route } from '@playwright/test';
import { dropPane, installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// share stable responses while leaving scenario-specific state at each call site
async function mockConsoleRoutes(page: Page, available: () => boolean, overrides: Record<string, (route: Route) => Promise<void>> = {}) {
  await page.route('**/healthz', async route => {
    // model reachability independently of ownership
    if (!available()) return route.abort('failed');
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/**', async route => {
    // keep every endpoint offline with the console transport
    if (!available()) return route.abort('failed');
    const path = new URL(route.request().url()).pathname;
    const override = overrides[path];
    // apply only the endpoint behavior supplied by the scenario
    if (override !== undefined) return override(route);
    // retain the current controlling browser by default
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide one visible controlled session
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the mocked pane stream
    if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // leave saved prompts empty
    if (path === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// restore the opaque client status while retaining mounted console panes
test('blocks the console with a reconnecting overlay until the tunnel recovers', async ({ page }) => {
  test.setTimeout(60_000);
  await installPaneMock(page);
  let tunnelAvailable = true;
  let takeoverRequests = 0;
  await mockConsoleRoutes(page, () => tunnelAvailable, {
    // observe accidental ownership claims during recovery
    '/api/auth/take-control': async route => {
      takeoverRequests += 1;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    }
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  await expect(agentTab).toBeVisible();
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'CACHED-OUTPUT\r\n');
  const output = page.locator('.log-canvas .xterm-rows');
  await expect(output).toContainText('CACHED-OUTPUT');

  tunnelAvailable = false;
  // trigger the public reachability probe without racing the blocking overlay
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();
  // avoid duplicate notices when the pane disconnects during a console outage
  await dropPane(page, 'agent-1');
  const paneStatus = page.locator('.log-canvas .streamed-terminal-status');
  await expect(paneStatus).toHaveText('Reconnecting…');
  await expect(paneStatus).toBeHidden();
  const [bounds, viewport] = await Promise.all([overlay.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBe(0);
  expect(bounds!.y).toBe(0);
  expect(bounds!.width).toBe(viewport.width);
  expect(bounds!.height).toBe(viewport.height);
  await expect(agentTab).toHaveCount(1);
  await expect(output).toContainText('CACHED-OUTPUT');
  await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(overlay).toHaveCSS('background-image', /radial-gradient\(circle at 50% 42%,/u);
  await expect(overlay.locator('.auth-glow')).toBeVisible();
  const message = overlay.locator('.loading-line');
  await expect(message).toHaveText('Reconnecting to console');
  const progress = overlay.locator('.loading-console.progress-border');
  await expect(progress).toHaveAttribute('aria-busy', 'true');
  await expect(progress.locator(':scope > .update-progress-ring')).toBeVisible();
  await expect(overlay.locator('.loading-bars')).toHaveCount(0);
  // inspect the restored full-client grid treatment
  const grid = await overlay.evaluate(element => {
    const before = getComputedStyle(element, '::before');
    return { background: before.backgroundImage, opacity: before.opacity };
  });
  expect(grid.background).toContain('linear-gradient');
  expect(grid.opacity).toBe('0.28');
  // keep the opaque reconnect status centered on desktop and phone
  for (const viewport of [{ label: 'desktop', width: 1440, height: 900 }, { label: 'phone', width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    const consoleBounds = await overlay.locator('.loading-console').boundingBox();
    expect(consoleBounds).not.toBeNull();
    expect(consoleBounds!.x + consoleBounds!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(consoleBounds!.y + consoleBounds!.height / 2).toBeCloseTo(viewport.height / 2, 0);
    await page.screenshot({ path: test.info().outputPath(`console-reconnecting-${viewport.label}.png`) });
  }

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(agentTab).toBeVisible();
  await expect(output).toContainText('CACHED-OUTPUT');
  await expect(paneStatus).toBeVisible();
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'FRESH-OUTPUT\r\n');
  await expect(output).toContainText('FRESH-OUTPUT');
  await expect(paneStatus).toBeHidden();
  expect(takeoverRequests).toBe(0);
});

// keep a displaced client blocked through every passive recovery path
test('requires an explicit takeover after a disconnected controller is displaced', async ({ page }) => {
  test.setTimeout(60_000);
  await installPaneMock(page);
  let tunnelAvailable = true;
  let hasControl = true;
  let sessionRequests = 0;
  let takeoverRequests = 0;
  await mockConsoleRoutes(page, () => tunnelAvailable, {
    // publish the ownership held by the current browser session
    '/api/auth/session': async route => {
      sessionRequests += 1;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: hasControl, deviceName: 'Test device', ...(hasControl ? {} : { controllingDeviceName: 'Other device' }) } });
    },
    // restore ownership only after the user clicks take control
    '/api/auth/take-control': async route => {
      takeoverRequests += 1;
      hasControl = true;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    }
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  const takeControl = page.getByRole('button', { name: 'Take control', exact: true });
  await expect(agentTab).toBeVisible();

  tunnelAvailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(overlay).toBeVisible();
  hasControl = false;
  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(takeControl).toBeVisible();
  await expect(page.getByText('Other device is active', { exact: true })).toBeVisible();
  expect(takeoverRequests).toBe(0);

  const sessionsBeforeFocus = sessionRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => sessionRequests).toBeGreaterThan(sessionsBeforeFocus);
  await expect(takeControl).toBeVisible();
  expect(takeoverRequests).toBe(0);

  await page.reload();
  await expect(takeControl).toBeVisible();
  await expect(agentTab).toHaveCount(0);
  expect(takeoverRequests).toBe(0);

  tunnelAvailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(overlay).toBeVisible();
  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(takeControl).toBeVisible();
  expect(takeoverRequests).toBe(0);

  await takeControl.click();
  await expect.poll(() => takeoverRequests).toBe(1);
  await expect(agentTab).toBeVisible();
});

// resume initial authentication when reachability returns
test('restores the session automatically when the tunnel is down during startup', async ({ page }) => {
  test.setTimeout(60_000);
  let tunnelAvailable = false;
  await mockConsoleRoutes(page, () => tunnelAvailable);

  await page.goto('/');
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole('tab', { name: /^Ready/u })).toBeVisible();
  await expect(page.getByText('Unable to connect to the console')).toHaveCount(0);
});

// distinguish a slow refresh from a disconnected console
test('keeps the console visible when a dashboard refresh times out', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  await mockConsoleRoutes(page, () => true, {
    // hold only later dashboard responses past the client request deadline
    '/api/dashboard': async route => {
      dashboardRequests += 1;
      // leave the initial dashboard responsive
      if (dashboardRequests > 1) {
        await new Promise(resolve => setTimeout(resolve, 9_000));
        return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } }).catch(() => undefined);
      }
      return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    }
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(agentTab).toBeVisible();
  await expect.poll(() => dashboardRequests, { timeout: 8_000 }).toBeGreaterThan(1);
  await page.waitForTimeout(8_500);
  await expect(overlay).toHaveCount(0);
  await expect(agentTab).toBeVisible();
});
