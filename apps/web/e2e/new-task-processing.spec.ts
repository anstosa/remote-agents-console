import { expect, test } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner, expectSplitProgressBorder } from './progress-border-assertions';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock';

// allow the shared host's first dashboard transform before exercising task transport
test.setTimeout(90_000);

// preserve task handoff after the browser sends an explicit empty json mutation
test('keeps a new-task processing indicator visible until the replacement agent appears', async ({ page }) => {
  let oldAgentGone = false;
  let replacementReady = false;
  let dashboardRequests = 0;
  let transport: { contentType: string | undefined; body: string | null; csrf: string | undefined } | undefined;
  let finishNewTask!: () => void;
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });

  await installPaneMock(page);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout;
    // accelerate handoff recovery
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) => nativeSetTimeout(handler, timeout === 30_000 ? 50 : timeout, ...arguments_)) as typeof window.setTimeout;
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      if (replacementReady) return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, newTaskConfigured: true, title: 'Ready', kind: 'codex' }], projects: [] } });
      if (oldAgentGone) return route.fulfill({ json: { generation: dashboardRequests, agents: [], projects: [] } });
      return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, newTaskConfigured: true, title: 'Ready', kind: 'codex' }], projects: [] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') return route.fulfill({ json: { enabled: true } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'POST') {
      // capture the real browser request before accepting a task reset
      transport = { contentType: request.headers()['content-type'], body: request.postData(), csrf: request.headers()['x-csrf-token'] };
      // model the tunnel parser rejecting untyped chunked mutations
      if (transport.contentType !== 'application/json' || transport.body !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      await newTaskFinished;
      return route.fulfill({ status: 202 });
    }
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const panel = page.locator('.log-output.agent-panel');
  const output = panel.locator(':scope > .agent-output');
  // connecting belongs to output only, leaving the header and composer outside
  await expectSplitProgressBorder(output, 'blue');
  await expect(panel.locator(':scope > .log-loading')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectSplitProgressBorder(output, 'blue');
  // reduced motion keeps its compact spinner within the same output surface
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionSpinner(output.locator('.log-loading'), 'blue');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectSplitProgressBorder(output, 'blue');
  await expectClockwiseProgressBorder(output.locator('.log-loading'));
  await page.setViewportSize({ width: 1280, height: 720 });
  // first output clears connecting progress without remounting the split
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready for a prompt\r\n');
  await expect(panel.locator('.log-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'New Task', exact: true }).click();

  await expect.poll(() => transport).toEqual({ contentType: 'application/json', body: '{}', csrf: 'csrf-token' });
  const processing = page.locator('.log-loading[role="status"]');
  await expect(processing).toBeVisible();
  await expect(processing).toContainText('preparing a fresh agent');
  await expectSplitProgressBorder(panel, 'peach');
  await expect(page.getByRole('status').filter({ hasText: 'Starting a new task' })).toContainText('You can keep using other tabs');
  const startingTab = page.getByRole('tab', { name: 'Cora — Starting new task' });
  await expectProgressBorder(startingTab, 'blue');
  await expect(startingTab.locator('.tab-kind-stack')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectSplitProgressBorder(panel, 'peach');
  const phoneStartingTab = page.getByRole('tab', { name: 'Cora — Starting new task' });
  await expectProgressBorder(phoneStartingTab, 'blue');
  await expect(phoneStartingTab.locator('.tab-kind-stack')).toBeVisible();
  // keep the workspace name and transition on distinct readable rows
  const phoneName = phoneStartingTab.locator('.workspace-dropdown-label > span');
  const phoneStatus = phoneStartingTab.locator('.workspace-dropdown-label > small');
  await expect(phoneName).toBeVisible();
  await expect(phoneStatus).toBeVisible();
  const nameBox = await phoneName.boundingBox();
  const statusBox = await phoneStatus.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(nameBox!.y + nameBox!.height).toBeLessThanOrEqual(statusBox!.y);
  await page.screenshot({ path: '/tmp/remoteagents-loading-border-starting-tab-phone.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  oldAgentGone = true;
  const requestsBeforeRemoval = dashboardRequests;
  await expect.poll(() => dashboardRequests, { timeout: 10_000 }).toBeGreaterThan(requestsBeforeRemoval);
  await expect(page.getByRole('tab', { name: 'Cora — Starting new task' })).toBeVisible();
  await expect(processing).toBeVisible();
  await expectSplitProgressBorder(panel, 'blue');

  finishNewTask();
  await expect(page.getByRole('alert').filter({ hasText: 'New task is taking longer than expected' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  replacementReady = true;
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(processing).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'New task is ready' })).toContainText('ready for a fresh prompt');
  // the replacement connects at the same boundary and clears after its first output
  await expectSplitProgressBorder(output, 'blue');
  await seedPaneSize(page, 'agent-2');
  await pushBytes(page, 'agent-2', 'Replacement ready\r\n');
  await expect(panel.locator('.log-loading')).toHaveCount(0);
});

// keep accepted task feedback scoped to the source worktree
test('shows the new-task banner only on its worktree', async ({ page }) => {
  let finishNewTask!: () => void;
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, newTaskConfigured: true, title: 'Ready' }],
      projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }]
    } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') return route.fulfill({ json: { enabled: true } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'POST') {
      // require the same explicit json transport while switching workspaces
      if (request.headers()['content-type'] !== 'application/json' || request.postData() !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      await newTaskFinished;
      return route.fulfill({ status: 202 });
    }
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'New Task', exact: true }).click();

  const banner = page.getByRole('status').filter({ hasText: 'Starting a new task' });
  await expect(banner).toBeVisible();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(banner).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Starting new task' }).click();
  await expect(banner).toBeVisible();
  finishNewTask();
});
