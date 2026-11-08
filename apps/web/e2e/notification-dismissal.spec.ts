import { expect, test } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

// keep viewed completions read across navigation and subsequent dashboard updates
test('dismisses a newly selected agent tab but waits for prompt focus on the already active tab', async ({ page }) => {
  const remoteDismissals: Array<{ path: string; completionId?: string }> = [];
  const dashboard = { generation: 1, agents: [
    { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', attention: 'finished', unread: true, completionId: 'first-completion' },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready', attention: 'finished', unread: true, completionId: 'first-completion' }
  ], projects: [] };
  const unreadSnapshot = structuredClone(dashboard);
  await installDashboardSocket(page);
  await page.addInitScript(() => {
    const localDismissals: string[] = [];
    Object.defineProperty(window, '__localDismissals', { configurable: true, value: localDismissals });
    const registration = {
      getNotifications: async ({ tag }: { tag?: string } = {}) => [{ close: () => { if (tag) localDismissals.push(tag); } }],
      showNotification: async () => {}
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve the server-owned dismissal state on every refresh
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    // authorize the controllable dashboard stream
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // persist each dismissal instead of replaying an unchanged unread fixture
    if (/^\/api\/agents\/agent-[12]\/notifications\/dismiss$/u.test(url.pathname) && request.method() === 'POST') {
      const { completionId } = request.postDataJSON() as { completionId?: string };
      remoteDismissals.push({ path: url.pathname, completionId });
      // the server clears only the observed completion, not a newer turn
      dashboard.agents = dashboard.agents.map(agent => url.pathname.includes(`/${agent.id}/`) && agent.completionId === completionId ? { ...agent, unread: false } : agent);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.bringToFront();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await expect.poll(() => remoteDismissals).toEqual([]);
  const activeUnread = page.getByRole('tab', { name: 'Cora — Prompt done — Unread' });
  await expect(activeUnread).toHaveClass(/unread/u);
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-1/notifications/dismiss', completionId: 'first-completion' });
  const unread = page.getByRole('tab', { name: 'Owen — Prompt done — Unread' });
  await expect(unread).toHaveClass(/unread/u);
  await unread.click();
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-2/notifications/dismiss', completionId: 'first-completion' });
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __localDismissals: string[] }
  ).__localDismissals)).toEqual(expect.arrayContaining(['worktree-status-owen', 'agent-status-agent-2']));
  // leaving a read worktree must not re-arm its completed highlight
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  // replay an already-emitted completion alongside unrelated metadata changes
  await emitDashboard(page, { ...unreadSnapshot, generation: 2, notesRevision: 1 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  // a reload also reads the server's persisted dismissal
  await page.reload();
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  // only a new completed turn makes the other worktree unread again
  dashboard.agents[1] = { ...dashboard.agents[1]!, title: '⠋ Working', attention: 'working' };
  await emitDashboard(page, { ...dashboard, generation: 3 });
  await expect(page.getByRole('tab', { name: 'Owen — Working' })).toBeVisible();
  dashboard.agents[1] = { ...dashboard.agents[1]!, title: 'Ready', attention: 'finished', unread: true, completionId: 'second-completion' };
  await emitDashboard(page, { ...dashboard, generation: 4 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done — Unread' })).toHaveClass(/unread/u);
  // a completion remains new even if the browser missed the intervening work
  await page.getByRole('tab', { name: 'Owen — Prompt done — Unread' }).click();
  await expect.poll(() => remoteDismissals.filter(dismissal => dismissal.path.includes('/agent-2/')).map(dismissal => dismissal.completionId)).toEqual(['first-completion', 'second-completion']);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: true, completionId: 'third-completion' };
  await emitDashboard(page, { ...dashboard, generation: 5 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done — Unread' })).toHaveClass(/unread/u);
  // a turn viewed during grace stays read when its unread publication arrives
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: false, completionId: 'pending-completion' };
  await emitDashboard(page, { ...dashboard, generation: 6 });
  const pending = page.getByRole('tab', { name: 'Owen — Prompt done' });
  await expect(pending).not.toHaveClass(/unread/u);
  await pending.click();
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-2/notifications/dismiss', completionId: 'pending-completion' });
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: true };
  await emitDashboard(page, { ...dashboard, generation: 7 });
  await expect(pending).not.toHaveClass(/unread/u);
});
