import { expect, test } from '@playwright/test';
import { dropPane, installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// restore the opaque client status while retaining mounted console panes
test('blocks the console with a reconnecting overlay until the tunnel recovers', async ({ page }) => {
  test.setTimeout(60_000);
  await installPaneMock(page);
  let tunnelAvailable = true;
  await page.route('**/healthz', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/**', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
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
  await expect(overlay.locator('.loading-bars')).toBeVisible();
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
});

test('restores the session automatically when the tunnel is down during startup', async ({ page }) => {
  test.setTimeout(60_000);
  let tunnelAvailable = false;
  await page.route('**/healthz', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/**', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole('tab', { name: /^Ready/u })).toBeVisible();
  await expect(page.getByText('Unable to connect to the console')).toHaveCount(0);
});

test('keeps the console visible when a dashboard refresh times out', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  await page.route('**/healthz', route => route.fulfill({ status: 200, body: 'ok' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      if (dashboardRequests > 1) {
        await new Promise(resolve => setTimeout(resolve, 9_000));
        return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } }).catch(() => undefined);
      }
      return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
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
