import { expect, test, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

const alphaWorktreeId = 'remoteagents:/worktrees/alpha';
const betaWorktreeId = 'remoteagents:/worktrees/beta';
const alphaWorktreeName = 'Remote Agents · feature/full-worktree-name';
const betaWorktreeName = 'Remote Agents · feature/read-only-last-known-name';
const project = {
  id: 'remoteagents',
  label: 'Remote Agents',
  available: true,
  worktrees: [
    { id: alphaWorktreeId, projectId: 'remoteagents', label: alphaWorktreeName, path: '/worktrees/alpha', main: false, detached: false, locked: false, available: true, pinned: true, order: 0 },
    { id: betaWorktreeId, projectId: 'remoteagents', label: betaWorktreeName, path: '/worktrees/beta', main: false, detached: false, locked: false, available: true, pinned: true, order: 1 }
  ]
};
const agent = { id: 'dashboard-agent', sessionId: 'socket:$1', home: '/worktrees/alpha', title: 'Last known agent', kind: 'codex', worktreeId: alphaWorktreeId, recoveryProcessKey: 'process-alpha' };
const staleAgent = { id: 'stale-dashboard-agent', sessionId: 'socket:$2', home: '/worktrees/beta', title: 'Claude · beta', kind: 'claude', worktreeId: betaWorktreeId, recoveryProcessKey: 'stale-process-beta' };
const dashboard = { generation: 1, agents: [agent, staleAgent], projects: [project] };
const degraded = { generation: 2, agents: [agent, staleAgent], projects: [project], tmuxOutage: { unavailableSockets: 1, since: '2026-11-18T17:00:00Z' } };
const agents = [
  { id: 'recovery-a', kind: 'Codex', label: 'Codex · alpha', pid: 101, recoveryProcessKey: 'process-alpha' },
  { id: 'recovery-b', kind: 'Claude', label: 'Claude · beta', pid: 102, recoveryProcessKey: 'process-beta' }
];
const resources = { sampledAt: '2026-11-18T17:01:00Z', host: { cpuPercent: 75, memory: { usedBytes: 5000, totalBytes: 10000 }, disks: [{ mount: '/', usedBytes: 3000, totalBytes: 10000 }] } };
const wslResources = { sampledAt: '2026-11-18T17:01:00Z', host: null, wsl: { cpuPercent: 37, memory: { usedBytes: 6000, totalBytes: 10000 }, disks: [{ mount: '/', usedBytes: 3000, totalBytes: 10000 }] } };
const windowsHostResources = {
  sampledAt: '2026-11-18T17:01:00Z',
  host: {
    cpuPercent: 64,
    memory: { usedBytes: 24000, totalBytes: 32000 },
    disks: [
      { mount: 'C:\\', usedBytes: 5000, totalBytes: 10000 },
      { mount: 'D:\\', usedBytes: 2500, totalBytes: 10000 }
    ]
  },
  wsl: wslResources.wsl
};
type RecoveryResources = typeof resources | typeof wslResources | typeof windowsHostResources;

// serve recovery and the normal flyout independently
async function mockConsole(page: Page, state: { outage: boolean; canStop: boolean; processes: typeof agents; keys?: Record<string, Record<string, string>>; resources?: RecoveryResources }) {
  const stops: unknown[] = [];
  let normalMetricsRequests = 0;
  await installDashboardSocket(page);
  await page.route('**/healthz', route => route.fulfill({ body: 'ok' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    // mock only the required authenticated and read-only paths
    switch (new URL(request.url()).pathname) {
      case '/api/auth/session': return route.fulfill({ json: { active: true, csrfToken: 'recovery-csrf', deviceName: 'Test device', resourceMonitoring: false } });
      case '/api/dashboard': return route.fulfill({ json: { ...(state.outage ? degraded : dashboard), ...(state.keys === undefined ? {} : { keys: state.keys }) } });
      case '/api/server/recovery': return route.fulfill({ json: { available: true, canStop: state.canStop, agents: state.processes, resources: state.resources ?? resources } });
      case '/api/server/recovery/agents/stop': {
        const body = request.postDataJSON() as { ids: string[] };
        stops.push({ body, csrf: request.headers()['x-csrf-token'] });
        return route.fulfill({ json: { results: body.ids.map(id => ({ id, status: id === 'recovery-a' ? 'signal_sent' : 'stale' })) } });
      }
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

// prove the browser-native modal floats over a translucent blurred backdrop at the viewport center
async function expectModalPresentation(page: Page) {
  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  await expect(recovery).toBeVisible();
  const presentation = await recovery.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const backdrop = getComputedStyle(element, '::backdrop');
    return {
      modal: element.matches(':modal'),
      centerOffsetX: Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
      centerOffsetY: Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2),
      background: backdrop.backgroundColor,
      alpha: Number(/\/\s*([\d.]+)/u.exec(backdrop.backgroundColor)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/u.exec(backdrop.backgroundColor)?.[1] ?? 1),
      filter: backdrop.backdropFilter || backdrop.getPropertyValue('-webkit-backdrop-filter')
    };
  });
  expect(presentation.modal).toBe(true);
  expect(presentation.centerOffsetX).toBeLessThanOrEqual(4);
  expect(presentation.centerOffsetY).toBeLessThanOrEqual(4);
  expect(presentation.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(presentation.alpha).toBeGreaterThan(0);
  expect(presentation.alpha).toBeLessThan(1);
  expect(presentation.filter).toMatch(/blur\(/u);
  return recovery;
}

// preview recovery from its unbound command without replacing or enabling the dashboard underneath
test('previews consolidated recovery in a centered modal and permits an explicit stop', async ({ page }) => {
  const state = { outage: false, canStop: true, processes: agents };
  const { stops } = await mockConsole(page, state);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  await page.keyboard.press('Meta+Alt+t');
  await expect(page.getByRole('dialog', { name: 'Console recovery' })).toHaveCount(0);
  await page.keyboard.press('Control+b');
  await page.keyboard.press(':');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const previewCommand = palette.getByRole('option', { name: /Preview tmux disconnected screen/u });
  await expect(previewCommand).toContainText('preview-tmux-recovery');
  await previewCommand.click();

  const recovery = await expectModalPresentation(page);
  await expect(recovery.getByRole('heading', { name: 'tmux is not responding' })).toBeVisible();
  await expect(recovery.getByText(/^Preview:/u)).toHaveCount(0);
  await expect(recovery.getByText('Recovery reads the host directly, without tmux.')).toHaveCount(0);
  await expect(recovery.getByText('The console will resume when the dashboard is available.')).toHaveCount(0);
  await expect(recovery.getByRole('region', { name: 'Server resource monitoring' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '75');
  const agentsList = recovery.getByRole('group', { name: 'Agents', exact: true });
  await expect(agentsList).toBeVisible();
  await expect(recovery.locator('fieldset')).toHaveCount(1);

  const alphaCheckbox = agentsList.getByRole('checkbox', { name: /Codex · Remote Agents · feature\/full-worktree-name · Last known agent · PID 101/u });
  const alphaRow = alphaCheckbox.locator('xpath=ancestor::*[contains(@class,"tmux-recovery-agent")][1]');
  await expect(alphaCheckbox).toBeEnabled();
  await expect(alphaRow).toContainText('Last known agent');
  await expect(alphaRow.getByText(alphaWorktreeName, { exact: true })).toBeVisible();
  await expect(alphaRow.getByRole('img', { name: 'Codex', exact: true })).toBeVisible();
  await expect(alphaRow.getByText('alpha', { exact: true })).toHaveCount(0);
  await expect(agentsList.getByText(/· PID /u)).toHaveCount(0);

  const betaRow = agentsList.getByRole('checkbox', { name: /Claude · beta · PID 102/u }).locator('xpath=ancestor::*[contains(@class,"tmux-recovery-agent")][1]');
  await expect(betaRow.getByText('beta', { exact: true })).toBeVisible();
  await expect(betaRow.getByText('Claude · beta', { exact: true })).toHaveCount(0);
  await expect(betaRow.getByRole('img', { name: 'Claude', exact: true })).toBeVisible();
  await expect(betaRow).not.toContainText(betaWorktreeName);
  const staleRow = agentsList.locator('.tmux-recovery-agent', { hasText: betaWorktreeName });
  await expect(staleRow.getByText(betaWorktreeName, { exact: true })).toBeVisible();
  await expect(staleRow.getByRole('img', { name: 'Claude', exact: true })).toBeVisible();
  await expect(staleRow).toContainText('Last known · no verified process');
  await expect(staleRow.getByRole('checkbox')).toHaveCount(0);

  const dashboardTab = page.locator('[role="tab"]', { hasText: alphaWorktreeName });
  await expect(dashboardTab).toBeVisible();
  await dashboardTab.focus();
  expect(await recovery.evaluate(element => element.contains(document.activeElement))).toBe(true);

  await alphaCheckbox.check();
  await recovery.getByRole('button', { name: 'Stop selected agents' }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Stop selected agents?' });
  await expect(confirmation.getByText('Codex · alpha · PID 101')).toBeVisible();
  await confirmation.getByRole('button', { name: 'Stop 1 agent' }).click();
  await expect(recovery.getByText(/alpha.*Stop signal sent/u)).toBeVisible();
  expect(stops).toEqual([{ body: { ids: ['recovery-a'] }, csrf: 'recovery-csrf' }]);

  await emitDashboard(page, { ...dashboard, generation: 2 });
  await expect(recovery).toBeVisible();
  await recovery.getByRole('button', { name: 'Return to dashboard' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);
});

// a genuine outage replaces preview-only safety and returns to normal automatic recovery afterward
test('opens preview from a configured Win+Alt+t binding and yields to a real outage', async ({ page }) => {
  const state = { outage: false, canStop: true, processes: agents, keys: { root: { 'M-Super-t': 'preview-tmux-recovery' } } };
  const { stops } = await mockConsole(page, state);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  await page.keyboard.press('Meta+Alt+t');
  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByText(/^Preview:/u)).toHaveCount(0);
  await expect(recovery.getByRole('checkbox', { name: /Codex.*101/u })).toBeEnabled();

  state.outage = true;
  await emitDashboard(page, { ...degraded, keys: state.keys });
  await expect(recovery.getByText(/^Preview:/u)).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Return to dashboard' })).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Retry dashboard' })).toBeVisible();
  await recovery.getByRole('checkbox', { name: /Codex.*101/u }).check();
  await expect(recovery.getByRole('button', { name: 'Stop selected agents' })).toBeEnabled();

  state.outage = false;
  await emitDashboard(page, { ...dashboard, generation: 3, keys: state.keys });
  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
  expect(stops).toEqual([]);
});

// enter from a live dashboard and verify that only the explicit selection can be stopped
test('keeps host recovery usable during tmux outage with monitoring disabled', async ({ page }) => {
  const state = { outage: false, canStop: true, processes: agents };
  const { stops, metricsCalls } = await mockConsole(page, state);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  state.outage = true;
  await emitDashboard(page, degraded);

  const recovery = await expectModalPresentation(page);
  await expect(recovery.getByRole('heading', { name: 'tmux is not responding' })).toBeVisible();
  await expect(recovery.getByText('Recovery reads the host directly, without tmux.')).toHaveCount(0);
  await expect(recovery.getByText('The console will resume when the dashboard is available.', { exact: true })).toBeVisible();
  await expect(recovery.getByRole('region', { name: 'Server resource monitoring' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '75');
  await expect(page.locator('[role="tab"]', { hasText: alphaWorktreeName })).toBeVisible();
  await expect(recovery.getByText(/Last known dashboard/u)).toHaveCount(0);
  const agentsList = recovery.getByRole('group', { name: 'Agents', exact: true });
  await expect(agentsList.locator('.tmux-recovery-agent', { hasText: 'Last known agent' })).toContainText(alphaWorktreeName);
  await expect(agentsList.locator('.tmux-recovery-agent', { hasText: betaWorktreeName }).getByRole('checkbox')).toHaveCount(0);

  const stopSelected = recovery.getByRole('button', { name: 'Stop selected agents' });
  await expect(stopSelected).toBeDisabled();
  await agentsList.getByRole('checkbox', { name: /Codex.*101/u }).check();
  await agentsList.getByRole('checkbox', { name: /Claude.*102/u }).check();
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
  await expect(page.getByRole('tab', { name: new RegExp(alphaWorktreeName, 'u') })).toBeVisible();
});

// a cold real outage must render the independent WSL CPU and root disk sample immediately
test('shows CPU and root disk usage on cold-start tmux outage', async ({ page }) => {
  const state = { outage: true, canStop: true, processes: agents, resources: wslResources };
  const { metricsCalls } = await mockConsole(page, state);
  await page.goto('/');

  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  const monitoring = recovery.getByRole('region', { name: 'Server resource monitoring' });
  await expect(recovery).toBeVisible();
  await expect(monitoring.getByRole('group', { name: 'WSL resources' })).toBeVisible();
  await expect(monitoring.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '37');
  await expect(monitoring.getByRole('meter', { name: '/ usage' })).toHaveAttribute('aria-valuenow', '30');
  expect(metricsCalls()).toBe(0);
});

// a cold outage resolves cached agents through canonical worktree IDs rather than path basenames
test('uses cached full worktree names and provider badges on cold-start tmux outage', async ({ page }) => {
  const state = { outage: true, canStop: true, processes: agents };
  await mockConsole(page, state);
  await page.goto('/');

  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  const agentsList = recovery.getByRole('group', { name: 'Agents', exact: true });
  const verifiedCheckbox = agentsList.getByRole('checkbox', { name: /Codex · Remote Agents · feature\/full-worktree-name · Last known agent · PID 101/u });
  const verifiedRow = verifiedCheckbox.locator('xpath=ancestor::*[contains(@class,"tmux-recovery-agent")][1]');
  await expect(verifiedRow.getByText(alphaWorktreeName, { exact: true })).toBeVisible();
  await expect(verifiedRow.getByText('alpha', { exact: true })).toHaveCount(0);
  await expect(verifiedRow.getByRole('img', { name: 'Codex', exact: true })).toBeVisible();

  const lastKnownRow = agentsList.locator('.tmux-recovery-agent-unverified', { hasText: betaWorktreeName });
  await expect(lastKnownRow.getByText(betaWorktreeName, { exact: true })).toBeVisible();
  await expect(lastKnownRow.getByRole('img', { name: 'Claude', exact: true })).toBeVisible();
  await expect(lastKnownRow.getByRole('checkbox')).toHaveCount(0);
});

// only a dashboard-identified scratch agent should replace the process folder with scratch
test('uses Scratch as the recovery title for a matched Scratch agent', async ({ page }) => {
  const processes = [{ ...agents[0], label: 'Codex · tmp' }, { ...agents[1], kind: 'Codex', label: 'Codex · tmp' }];
  const { stops } = await mockConsole(page, { outage: true, canStop: true, processes });
  await page.route('**/api/dashboard', route => {
    // retain the reserved place id even on a cold outage without a place catalog
    return route.fulfill({ json: { ...degraded, projects: [], agents: [{
      id: 'scratch-session', home: '/tmp', title: 'A scratch conversation', displayLabel: '~ Scratch',
      kind: 'codex', placeId: 'scratch:/tmp', recoveryProcessKey: 'process-alpha'
    }] } });
  });
  await page.goto('/');

  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  const scratch = recovery.getByRole('checkbox', { name: 'Codex · Scratch · PID 101', exact: true });
  await expect(scratch.locator('xpath=ancestor::label[1]').getByText('Scratch', { exact: true })).toBeVisible();
  await expect(recovery.getByText('~ Scratch', { exact: true })).toHaveCount(0);
  const unrelated = recovery.getByRole('checkbox', { name: 'Codex · tmp · PID 102', exact: true });
  await expect(unrelated.locator('xpath=ancestor::label[1]').getByText('tmp', { exact: true })).toBeVisible();
  expect(stops).toEqual([]);
});

// a real outage keeps independently collected Windows and WSL resources in separate groups
test('shows Windows host resources alongside WSL resources during tmux outage', async ({ page }) => {
  const state = { outage: true, canStop: true, processes: agents, resources: windowsHostResources };
  const { metricsCalls } = await mockConsole(page, state);
  await page.goto('/');

  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  const monitoring = recovery.getByRole('region', { name: 'Server resource monitoring' });
  const wsl = monitoring.getByRole('group', { name: 'WSL resources' });
  const host = monitoring.getByRole('group', { name: 'Host resources' });
  await expect(monitoring.getByText('Host resources unavailable.', { exact: true })).toHaveCount(0);
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '37');
  await expect(wsl.getByRole('meter', { name: '/ usage' })).toHaveAttribute('aria-valuenow', '30');
  await expect(host.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '64');
  await expect(host.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '75');
  await expect(host.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuenow', '50');
  await expect(host.getByRole('meter', { name: 'D:\\ usage' })).toHaveAttribute('aria-valuenow', '25');
  await expect(monitoring.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')))).resolves.toEqual(['WSL resources', 'Host resources']);
  expect(metricsCalls()).toBe(0);
});

// a phone can scroll the independent process list even without a stop bridge
test('shows a scrollable read-only host list on cold start without a signalling bridge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 644 });
  const processes = Array.from({ length: 20 }, (_, index) => ({ ...agents[0], id: `process-${index}`, pid: 100 + index, label: `Codex · worktree-${index}`, recoveryProcessKey: `process-worktree-${index}` }));
  const state = { outage: true, canStop: false, processes };
  const { stops } = await mockConsole(page, state);
  await page.goto('/');
  const recovery = await expectModalPresentation(page);
  expect(await recovery.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expect(recovery.getByRole('checkbox')).toHaveCount(20);
  await expect(recovery.getByRole('button', { name: 'Stop selected agents' })).toBeDisabled();
  await expect(recovery.getByRole('checkbox').first()).toBeDisabled();
  const last = recovery.getByText('worktree-19', { exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(last.locator('xpath=ancestor::label[1]').getByRole('img', { name: 'Codex', exact: true })).toBeVisible();

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
