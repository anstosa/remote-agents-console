import { expect, test, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

// a tmux picker (a `session-closed` → `choose-tree` hook) can land on the Agent's pane: tmux
// never draws it into the streamed output, and it refuses every prompt and keystroke
const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
const dashboard = (paneMode?: string, generation = 1) => ({ generation, agents: [{ id: 'agent-1', panel: 'terminal', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', ...(paneMode === undefined ? {} : { paneMode }) }, home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', branch: 'cora', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, kind: 'claude', attention: 'finished', queuedPromptCount: 1 }], projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] });

async function mockConsole(page: Page, paneMode: string | undefined, exits: string[], exitStatus = 204) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard(paneMode) });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    if (url.pathname === '/api/agents/agent-1/pane-mode/exit' && request.method() === 'POST') {
      exits.push(request.headers()['x-csrf-token'] ?? '');
      return exitStatus === 204 ? route.fulfill({ status: 204 }) : route.fulfill({ status: exitStatus, json: { error: 'Unable to leave the pane mode.' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const composer = (page: Page) => page.getByRole('region', { name: 'Prompt composer' });

test('a pane held by the session picker says so above the composer and closes it on request', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const exits: string[] = [];
  await installDashboardSocket(page);
  await mockConsole(page, 'tree-mode', exits);
  await page.goto('/');
  await expect(composer(page)).toBeVisible();

  const notice = page.locator('.agent-panel .pane-mode-notice');
  await expect(notice).toContainText('stuck in tmux’s session picker');
  // the notice sits directly above the composer, inside the agent panel
  const noticeBox = (await notice.boundingBox())!;
  const composerBox = (await composer(page).boundingBox())!;
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y + 1);

  await notice.getByRole('button', { name: 'Close it' }).click();
  await expect.poll(() => exits).toEqual(['csrf-token']);
  // the notice follows the dashboard: the next snapshot without a mode clears it
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, dashboard(undefined, 2));
  await expect(notice).toHaveCount(0);
});

test('no notice while the pane is free, and a failed close is reported', async ({ page }) => {
  const exits: string[] = [];
  await mockConsole(page, undefined, exits);
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('.pane-mode-notice')).toHaveCount(0);

  await page.unrouteAll();
  await mockConsole(page, 'client-mode', exits, 503);
  await page.reload();
  const notice = page.locator('.pane-mode-notice');
  await expect(notice).toContainText('tmux’s client picker');
  await notice.getByRole('button', { name: 'Close it' }).click();
  await expect(page.getByText('Could not close tmux’s client picker')).toBeVisible();
  await expect(notice).toBeVisible();
});
