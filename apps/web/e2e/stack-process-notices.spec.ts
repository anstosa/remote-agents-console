import { expect, test, type Page } from '@playwright/test';

const processActions = ['start', 'stop', 'restart'];
const staticWorktree = { id: 'site:/worktrees/static', projectId: 'site', label: 'Static', path: '/worktrees/static', main: true, detached: false, locked: false, branch: 'master', available: true, pinned: false, order: 1, stack: { actions: processActions, running: false, processes: [{ name: 'static', state: 'stopped' }] } };
// Cora's `api` reports that Static's `static` is down
const cora = { id: 'app:/worktrees/cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: false, order: 0, stack: { actions: processActions, running: true, processes: [{ name: 'api', state: 'running', notices: [{ level: 'warning', message: 'static is not running', target: { worktreeId: staticWorktree.id, label: 'Static', process: 'static', state: 'stopped' } }] }] } };

// An Agent at Cora, and Static with no Agent and no tab. `starts` collects the process Starts the
// console was sent; the first is refused as busy and the rest accepted.
async function mockConsole(page: Page, starts: string[]) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') {
      const agents = [{ id: 'agent-1', sessionId: 'socket:$1', home: cora.path, placeId: cora.id, worktreeId: cora.id, projectId: 'app', title: 'Ready', branch: 'cora', kind: 'claude', queuedPromptCount: 0, stack: cora.stack }];
      return route.fulfill({ json: { generation: 1, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [cora] }, { id: 'site', label: 'Site', available: true, worktrees: [staticWorktree] }] } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/worktrees\/[^/]+\/processes\/[^/]+\/start$/u.test(path) && request.method() === 'POST') {
      starts.push(decodeURIComponent(path));
      return starts.length === 1 ? route.fulfill({ status: 409, json: { error: 'stack operation already running' } }) : route.fulfill({ status: 202 });
    }
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    const agentRoute = /^\/api\/agents\/([^/]+)\/(.+)$/u.exec(path);
    if (agentRoute !== null) {
      const [, , rest] = agentRoute;
      if (rest === 'prompt-history' || rest === 'queued-prompts') return route.fulfill({ json: { prompts: [] } });
      if (rest === 'conversation') return route.fulfill({ json: {} });
    }
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(path)) return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/worktrees\/[^/]+\/panes$/u.test(path)) return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const staticNotice = (page: Page) => page.getByRole('list', { name: 'api notices' }).getByRole('listitem').filter({ hasText: 'static is not running' });

test("a notice's Start sends the other Worktree's process Start, showing the console's refusal and then its acceptance", async ({ page }) => {
  const starts: string[] = [];
  await mockConsole(page, starts);
  await page.goto('/');
  await page.getByRole('button', { name: /^Stack controls: running, warning/u }).click();
  await staticNotice(page).getByRole('button', { name: 'Start static in Static', exact: true }).click();
  await expect(staticNotice(page).getByRole('alert')).toHaveText('Start failed: stack operation already running');
  expect(starts).toEqual(['/api/worktrees/site:/worktrees/static/processes/static/start']);
  // an accepted Start (202, no body) shows Starting until the next state hides the notice
  await staticNotice(page).getByRole('button', { name: 'Start static in Static', exact: true }).click();
  await expect(staticNotice(page).getByRole('status')).toHaveText('Starting static…');
  await page.waitForTimeout(1000);
  await expect(staticNotice(page).getByRole('status')).toHaveText('Starting static…');
  await expect(staticNotice(page).getByRole('alert')).toHaveCount(0);
  expect(starts).toHaveLength(2);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Cora/u);
});

test("a notice's Open selects the other Worktree in a new tab with its stack menu open", async ({ page }) => {
  await mockConsole(page, []);
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: /^Stack controls: running, warning/u }).click();
  await staticNotice(page).getByRole('button', { name: 'Open Static', exact: true }).click();

  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Static/u);
  await expect(page.getByRole('button', { name: 'Stack controls: stopped', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.stack-menu').getByRole('button', { name: 'Start stack', exact: true })).toBeEnabled();
  // the tab is transient: leaving it closes it
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
