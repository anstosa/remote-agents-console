import { expect, test, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

const agent = { id: 'dashboard-agent', sessionId: 'socket:$1', home: '/worktrees/alpha', title: 'Last known agent' };
const dashboard = { generation: 1, agents: [agent], projects: [] };
const degraded = { generation: 2, agents: [], projects: [], tmuxOutage: { unavailableSockets: 1, since: '2026-11-18T17:00:00Z' } };
const agents = [
  { id: 'recovery-a', kind: 'Codex', label: 'Codex · alpha', pid: 101 },
  { id: 'recovery-b', kind: 'Claude', label: 'Claude · beta', pid: 102 }
];
const resources = { sampledAt: '2026-11-18T17:01:00Z', host: { cpuPercent: 75, memory: { usedBytes: 5000, totalBytes: 10000 }, disks: [{ mount: '/', usedBytes: 3000, totalBytes: 10000 }] } };

// serve recovery and the normal flyout independently
async function mockConsole(page: Page, state: { outage: boolean; canStop: boolean; processes: typeof agents }) {
  const stops: unknown[] = [];
  let normalMetricsRequests = 0;
  await installDashboardSocket(page);
  await page.route('**/healthz', route => route.fulfill({ body: 'ok' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    // mock only the required authenticated and read-only paths
    switch (new URL(request.url()).pathname) {
      case '/api/auth/session': return route.fulfill({ json: { active: true, csrfToken: 'recovery-csrf', deviceName: 'Test device', resourceMonitoring: false } });
      case '/api/dashboard': return route.fulfill({ json: state.outage ? degraded : dashboard });
      case '/api/server/recovery': return route.fulfill({ json: { available: true, canStop: state.canStop, agents: state.processes, resources } });
      case '/api/server/recovery/agents/stop':
        stops.push({ body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
        return route.fulfill({ json: { results: [{ id: 'recovery-a', status: 'signal_sent' }, { id: 'recovery-b', status: 'stale' }] } });
      case '/api/server/resources/disks':
      case '/api/server/resources/metrics':
      case '/api/server/resources/live':
        normalMetricsRequests += 1;
        break;
      case '/api/push/public-key': return route.fulfill({ json: {} });
      case '/api/dashboard/ticket': return route.fulfill({ json: { ticket: 'test-dashboard' } });
      case '/api/panes/ticket': return route.fulfill({ json: { ticket: 'test-pane' } });
      default: break;
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return { stops, metricsCalls: () => normalMetricsRequests };
}

// enter from a live dashboard and verify that only the explicit selection can be stopped
test('keeps host recovery usable during tmux outage with monitoring disabled', async ({ page }) => {
  const state = { outage: false, canStop: true, processes: agents };
  const { stops, metricsCalls } = await mockConsole(page, state);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /^Last known agent/u })).toBeVisible();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  state.outage = true;
  await emitDashboard(page, degraded);

  const recovery = page.getByRole('region', { name: 'Console recovery' });
  await expect(recovery.getByRole('heading', { name: 'tmux is not responding' })).toBeVisible();
  await expect(recovery.getByRole('region', { name: 'Server resource monitoring' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '75');
  await expect(page.getByRole('tab', { name: /^Last known agent/u })).toHaveCount(0);
  await recovery.getByText('Last known dashboard · 1 agent', { exact: true }).click();
  await expect(recovery.getByText('Last known agent', { exact: true })).toBeVisible();

  const stopSelected = recovery.getByRole('button', { name: 'Stop selected agents' });
  await expect(stopSelected).toBeDisabled();
  await recovery.getByRole('checkbox', { name: /Codex.*101/u }).check();
  await recovery.getByRole('checkbox', { name: /Claude.*102/u }).check();
  await stopSelected.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Stop selected agents?' });
  await expect(confirmation.getByText('Codex · alpha · PID 101')).toBeVisible();
  await expect(confirmation.getByText('Claude · beta · PID 102')).toBeVisible();
  expect(stops).toEqual([]);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toHaveCount(0);
  expect(stops).toEqual([]);
  await stopSelected.click();
  await confirmation.getByRole('button', { name: 'Stop 2 agents' }).click();
  await expect(recovery.getByText(/alpha.*Stop signal sent/u)).toBeVisible();
  await expect(recovery.getByText(/beta.*Process changed; not stopped/u)).toBeVisible();
  expect(stops).toEqual([{ body: { ids: ['recovery-a', 'recovery-b'] }, csrf: 'recovery-csrf' }]);
  expect(metricsCalls()).toBe(0);

  state.outage = false;
  await emitDashboard(page, { ...dashboard, generation: 3 });
  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Last known agent/u })).toBeVisible();
});

// a phone can scroll the independent process list even without a stop bridge
test('shows a scrollable read-only host list on cold start without a signalling bridge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 644 });
  const processes = Array.from({ length: 20 }, (_, index) => ({ ...agents[0], id: `process-${index}`, pid: 100 + index, label: `Codex · worktree-${index}` }));
  const state = { outage: true, canStop: false, processes };
  const { stops } = await mockConsole(page, state);
  await page.goto('/');
  const recovery = page.getByRole('region', { name: 'Console recovery' });
  await expect(recovery).toBeFocused();
  await expect(recovery.getByRole('checkbox')).toHaveCount(20);
  await expect(recovery.getByRole('button', { name: 'Stop selected agents' })).toBeDisabled();
  await expect(recovery.getByRole('checkbox').first()).toBeDisabled();
  const last = recovery.getByText('Codex · worktree-19', { exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();

  // keep the confirmation and its safe action in view from the end of a long list
  state.canStop = true;
  await recovery.getByRole('button', { name: 'Refresh recovery data' }).click();
  await recovery.getByRole('checkbox', { name: /worktree-19.*119/u }).check();
  await recovery.getByRole('button', { name: 'Stop selected agents' }).click();
  const cancel = page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeInViewport();
  await expect(cancel).toBeFocused();
  await cancel.click();
  expect(stops).toEqual([]);
});
