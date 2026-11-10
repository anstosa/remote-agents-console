import { expect, test } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

// apply pushed snapshots without redundant polling
test('falls back until the first push, then applies snapshots without frequent HTTP refreshes', async ({ page }) => {
  await page.clock.install();
  await installDashboardSocket(page);
  // an empty real-protocol inventory never needs an authority retry
  await page.addInitScript(() => {
    const active = {
      // return one bounded empty inventory through the actual message channel
      postMessage: (message: { requestId: string; operation: string }, ports: MessagePort[]) => {
        if (message.operation === 'inventory') ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'listed', audibleClaim: false, entries: [] });
      }
    };
    const registration = { active };
    const serviceWorkers = Object.assign(new EventTarget(), {
      // expose one already active worker without a push subscription surface
      getRegistration: async () => registration,
      // retain legacy notification readiness without loading another worker
      ready: Promise.resolve(registration),
      // keep startup registration local to this fixture
      register: async () => registration
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
  });

  let dashboardRequests = 0;
  let ticketRequests = 0;
  let currentHttpDashboard: Record<string, unknown> | undefined;
  const worktree = (label: string) => ({ id: 'cora', label, path: '/worktrees/cora', available: true, pinned: true, order: 0 });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({ json: currentHttpDashboard ?? { generation: 100, serverStartedAt: 1_000, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('Old label')] }] } });
    }
    if (url.pathname === '/api/dashboard/ticket') {
      ticketRequests += 1;
      return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Old label/u })).toBeVisible();
  await expect.poll(() => ticketRequests).toBe(1);
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardRequests).toBeGreaterThan(1);

  await emitDashboard(page, {
    generation: 101,
    serverStartedAt: 1_000,
    agents: [],
    projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('Synchronized label')] }]
  });
  await expect(page.getByRole('tab', { name: /Synchronized label/u })).toBeVisible();
  const synchronizedRequests = dashboardRequests;
  await page.clock.fastForward(20_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(dashboardRequests).toBe(synchronizedRequests);

  await emitDashboard(page, {
    generation: 102,
    serverStartedAt: 1_000,
    agents: [],
    projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('Pushed label')] }]
  });
  await expect(page.getByRole('tab', { name: /Pushed label/u })).toBeVisible();
  expect(dashboardRequests).toBe(synchronizedRequests);

  await emitDashboard(page, {
    generation: 1,
    serverStartedAt: 2_000,
    agents: [],
    projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('Restarted server label')] }]
  });
  await expect(page.getByRole('tab', { name: /Restarted server label/u })).toBeVisible();

  await page.clock.fastForward(61_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardRequests).toBeGreaterThan(synchronizedRequests);
  await expect(page.getByRole('tab', { name: /Restarted server label/u })).toBeVisible();
  // an old-process response cannot renew accepted snapshot freshness
  currentHttpDashboard = { generation: 2, serverStartedAt: 2_000, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('Safety synchronized label')] }] };
  // let the next safety poll accept the current server before suppressing polling
  await page.clock.runFor(5_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('tab', { name: /Safety synchronized label/u })).toBeVisible({ timeout: 15_000 });
  const safetyRequests = dashboardRequests;
  await page.clock.fastForward(20_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(dashboardRequests).toBe(safetyRequests);
});
