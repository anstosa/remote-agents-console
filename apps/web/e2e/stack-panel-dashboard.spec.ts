import { expect, test, type Page, type Request } from '@playwright/test';

const processActions = ['start', 'stop', 'restart'];
const staticWorktree = { id: 'site:/worktrees/static', projectId: 'site', label: 'Static Site', path: '/worktrees/static', main: true, detached: false, locked: false, branch: 'master', available: true, pinned: false, order: 1, stack: { actions: processActions, running: false, processes: [{ name: 'static', state: 'stopped' }] } };
// Cora's `api` runs and uses Static's `static`, which is stopped; `web` needs `api`
const coraStack = { actions: processActions, processes: [{ name: 'api', state: 'running', uses: [{ worktreeId: staticWorktree.id, label: 'Static Site / Main', process: 'static', state: 'stopped' }] }, { name: 'web', state: 'stopped', dependsOn: ['api'] }] };
const cora = { id: 'app:/worktrees/cora', projectId: 'app', label: 'App · cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: false, order: 0, stack: coraStack };
type MutationRequest = { method: string; path: string; contentType?: string; body: string | null };
type MockOptions = { mutations?: MutationRequest[] };

// match the server's json-only mutation framing
const acceptsEmptyJson = (request: Request) => request.headers()['content-type'] === 'application/json' && request.postData() === '{}';
// retain each mutation for framing assertions
const recordMutation = (request: Request, path: string, mutations: MutationRequest[] | undefined) => mutations?.push({ method: request.method(), path, contentType: request.headers()['content-type'], body: request.postData() });

// An Agent at Cora, and Static with no Agent and no tab. `requests` collects the process actions
// and output reads the console was sent.
async function mockConsole(page: Page, requests: string[], options: MockOptions = {}) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') {
      const agents = [{ id: 'agent-1', sessionId: 'socket:$1', home: cora.path, placeId: cora.id, worktreeId: cora.id, projectId: 'app', title: 'Ready', branch: 'cora', kind: 'claude', queuedPromptCount: 0, stack: coraStack }];
      return route.fulfill({ json: { generation: 1, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [cora] }, { id: 'site', label: 'Static Site', available: true, worktrees: [staticWorktree] }] } });
    }
    // authorize dashboard push only for an explicit json mutation
    if (path === '/api/dashboard/ticket' && request.method() === 'POST') {
      // keep unrelated stack tests on their inert dashboard socket
      if (options.mutations === undefined) return route.fulfill({ status: 404, json: {} });
      recordMutation(request, path, options.mutations);
      return acceptsEmptyJson(request) ? route.fulfill({ json: { ticket: 'dashboard-ticket' } }) : route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    const output = /^\/api\/worktrees\/([^/]+:[^]+?)\/processes\/([^/]+)\/output$/u.exec(path);
    if (output !== null) {
      // clear output only for an explicit json mutation
      if (request.method() === 'DELETE') {
        recordMutation(request, path, options.mutations);
        return acceptsEmptyJson(request) ? route.fulfill({ status: 204 }) : route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      }
      requests.push(`output ${output[1]} ${output[2]}`);
      return route.fulfill({ json: { name: output[2], state: 'running', output: `${output[2]} output from ${output[1]}` } });
    }
    if (/\/processes\/[^/]+\/(start|stop|restart)$/u.test(path) && request.method() === 'POST') {
      requests.push(`POST ${path}`);
      recordMutation(request, path, options.mutations);
      return acceptsEmptyJson(request) ? route.fulfill({ status: 202 }) : route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
    }
    // accept whole-stack actions only with explicit json framing
    if (/\/commands\/(start|stop|restart)$/u.test(path) && request.method() === 'POST') {
      recordMutation(request, path, options.mutations);
      return acceptsEmptyJson(request) ? route.fulfill({ status: 202 }) : route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
    }
    const agentRoute = /^\/api\/agents\/([^/]+)\/(.+)$/u.exec(path);
    if (agentRoute !== null) {
      const [, id, rest] = agentRoute;
      if (rest === 'tickets') return route.fulfill({ json: { ticket: `log-${id}` } });
      if (rest === 'prompt-history' || rest === 'queued-prompts') return route.fulfill({ json: { prompts: [] } });
      if (rest === 'conversation') return route.fulfill({ json: {} });
    }
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(path)) return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/worktrees\/[^/]+\/panes$/u.test(path)) return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const stackPanel = (page: Page) => page.locator('.log-split > .stack-pane');

test("Show output opens the Stack panel as a Workspace column, remembered per Worktree", async ({ page }) => {
  const requests: string[] = [];
  await mockConsole(page, requests);
  await page.goto('/');
  await page.getByRole('button', { name: /^Stack controls: 1 of 2 running, warning: static in Static Site \/ Main is not running/u }).click();
  await page.locator('.stack-menu [aria-label="api process"] > .stack-row').click();
  await page.getByRole('button', { name: 'Show api output', exact: true }).click();

  await expect(stackPanel(page)).toBeVisible();
  await expect(page.locator('.log-split')).toHaveClass(/has-stack/u);
  await expect(stackPanel(page).locator('.panel-header-title')).toContainText('Stack · App / cora');
  await expect(stackPanel(page).getByLabel('Process output')).toHaveText('api output from app:/worktrees/cora');

  // the panel stays open across a reload, on its first process
  await page.reload();
  await expect(stackPanel(page)).toBeVisible();
  await expect(stackPanel(page).locator('.stack-pane-item[aria-current="true"]')).toContainText('api');
  await stackPanel(page).getByRole('button', { name: 'Close Stack panel', exact: true }).click();
  await expect(stackPanel(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Stack controls/u })).toBeVisible();
  await expect(stackPanel(page)).toHaveCount(0);
});

test("a used process's Start and output go to its own Worktree, and Open switches to it, where the panel is not open", async ({ page }) => {
  const requests: string[] = [];
  await mockConsole(page, requests);
  await page.goto('/');
  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await stackPanel(page).locator('.stack-pane-item', { hasText: 'static' }).click();

  const used = stackPanel(page).getByRole('group', { name: 'static in Static Site / Main' });
  await expect(used.getByLabel('Process output')).toHaveText('static output from site:/worktrees/static');
  await used.getByRole('button', { name: 'Start static in Static Site / Main', exact: true }).click();
  await expect.poll(() => requests.filter(entry => entry.startsWith('POST'))).toEqual(['POST /api/worktrees/site:/worktrees/static/processes/static/start']);
  await used.getByRole('button', { name: 'Open Static Site / Main', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Static/u);
  await expect(page.getByRole('button', { name: 'Stack controls: stopped', exact: true })).toHaveAttribute('aria-expanded', 'true');
  // the panel is remembered open for Cora only
  await expect(stackPanel(page)).toHaveCount(0);
});

// keep bodyless mutations compatible with json-only servers
test('frames dashboard and Stack mutations as json', async ({ page }) => {
  const requests: string[] = [];
  const mutations: MutationRequest[] = [];
  await mockConsole(page, requests, { mutations });
  await page.goto('/');
  await expect.poll(() => mutations.filter(request => request.path === '/api/dashboard/ticket')).not.toHaveLength(0);

  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('button', { name: 'Start stack', exact: true }).click();
  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('group', { name: 'web process', exact: true }).getByRole('button', { expanded: false }).click();
  await page.getByRole('button', { name: 'Start web', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await page.getByRole('navigation', { name: 'Stack processes' }).getByRole('button', { name: /^static/u }).click();
  const used = page.getByRole('region', { name: 'Stack', exact: true }).getByRole('group', { name: 'static in Static Site / Main' });
  await used.getByRole('button', { name: 'Start static in Static Site / Main', exact: true }).click();
  await used.getByRole('button', { name: 'Clear static in Static Site / Main output', exact: true }).click();

  await expect.poll(() => mutations.filter(request => request.path !== '/api/dashboard/ticket')).toHaveLength(4);
  expect(mutations).toEqual(expect.arrayContaining([
    { method: 'POST', path: '/api/dashboard/ticket', contentType: 'application/json', body: '{}' },
    { method: 'POST', path: '/api/worktrees/app:/worktrees/cora/commands/start', contentType: 'application/json', body: '{}' },
    { method: 'POST', path: '/api/worktrees/app:/worktrees/cora/processes/web/start', contentType: 'application/json', body: '{}' },
    { method: 'POST', path: '/api/worktrees/site:/worktrees/static/processes/static/start', contentType: 'application/json', body: '{}' },
    { method: 'DELETE', path: '/api/worktrees/site:/worktrees/static/processes/static/output', contentType: 'application/json', body: '{}' }
  ]));
});

test('keeps the selected process across a Workspace switch', async ({ page }) => {
  await mockConsole(page, []);
  await page.goto('/');
  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  const selected = stackPanel(page).locator('.stack-pane-item[aria-current="true"]');
  await expect(selected).toContainText('api');
  await stackPanel(page).locator('.stack-pane-item', { hasText: 'static' }).click();
  // leave Cora for Static, and come back
  await stackPanel(page).getByRole('button', { name: 'Open Static Site / Main', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Static/u);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /cora/u }).click();
  await expect(selected).toContainText('static');
  await expect(stackPanel(page).getByRole('group', { name: 'static in Static Site / Main' }).getByLabel('Process output')).toHaveText('static output from site:/worktrees/static');
});

test("an inactive tab's menu lists its open Stack panel, and Close all splits closes it", async ({ page }) => {
  await mockConsole(page, []);
  await page.goto('/');
  await page.getByRole('button', { name: /^Stack controls/u }).click();
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await expect(stackPanel(page)).toBeVisible();
  // leave Cora for Static, so Cora's tab is inactive
  await stackPanel(page).locator('.stack-pane-item', { hasText: 'static' }).click();
  await stackPanel(page).getByRole('button', { name: 'Open Static Site / Main', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Static/u);
  // Open shows Static with its stack menu open
  await page.keyboard.press('Escape');

  const cora = page.getByRole('tab', { name: /cora/u });
  await cora.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: /workspace$/u });
  await expect(menu.getByRole('menuitem', { name: 'Stack', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Close all splits' }).click();
  await cora.click();
  await expect(page.getByRole('button', { name: /^Stack controls/u })).toBeVisible();
  await expect(stackPanel(page)).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the ⋮ opens the Stack panel into view', async ({ page }) => {
    await mockConsole(page, []);
    await page.goto('/');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.locator('.stack-panel-row').click();
    await expect(stackPanel(page)).toBeInViewport();
    await expect(page.locator('.log-split')).toHaveClass(/mobile-stack-view/u);
  });
});
