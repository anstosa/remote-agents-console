import { expect, test, type Page } from '@playwright/test';
import { expectProgressBorder, expectStationaryStatus } from './progress-border-assertions';

type MockAgent = { id: string; kind: 'claude' | 'codex'; attention?: 'working' | 'finished' | 'question'; hasMessageQuestion?: true; unread?: boolean; conversation?: string | null; history?: string[] };
type Console = { agents: MockAgent[]; dismissed: string[] };

const worktree = { id: 'app:/worktrees/cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: false, order: 0 };
const delta = { ...worktree, id: 'app:/worktrees/delta', label: 'Delta', path: '/worktrees/delta', branch: 'delta', pinned: true, order: 1 };

// Two Agents at the Cora Worktree and a pinned, agentless Delta. The dashboard is served from
// `state`, so a test changes the Agents between refreshes.
async function mockConsole(page: Page, state: Console) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') {
      const agents = state.agents.map(agent => ({ id: agent.id, sessionId: 'socket:$1', home: '/worktrees/cora', placeId: worktree.id, worktreeId: worktree.id, projectId: 'app', title: 'Ready', branch: 'cora', kind: agent.kind, queuedPromptCount: 0, ...(agent.attention === undefined ? {} : { attention: agent.attention }), ...(agent.hasMessageQuestion === true ? { hasMessageQuestion: true } : {}), ...(agent.unread === true ? { unread: true } : {}) }));
      return route.fulfill({ json: { generation: 1, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree, delta] }] } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    const agentRoute = /^\/api\/agents\/([^/]+)\/(.+)$/u.exec(path);
    if (agentRoute !== null) {
      const [, id, rest] = agentRoute;
      if (rest === 'tickets') return route.fulfill({ json: { ticket: `log-${id}` } });
      if (rest === 'prompt-history') return route.fulfill({ json: { prompts: (state.agents.find(agent => agent.id === id)?.history ?? []).map((text, index) => ({ id: `${id}-${index}`, text, createdAt: '2026-09-24T00:00:00.000Z' })) } });
      if (rest === 'queued-prompts') return route.fulfill({ json: { prompts: [] } });
      // viewing an Agent dismisses its notifications, which clears its unread output on the server
      if (rest === 'notifications/dismiss') {
        state.dismissed.push(id!);
        state.agents = state.agents.map(agent => agent.id === id ? { ...agent, unread: false } : agent);
        return route.fulfill({ status: 204 });
      }
      if (rest === 'conversation') {
        // `null` stands for an untitled conversation: the server reports no name
        const name = state.agents.find(agent => agent.id === id)?.conversation;
        return route.fulfill({ json: name === null ? {} : { name: name ?? `Conversation ${id}` } });
      }
    }
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(path)) return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/worktrees\/[^/]+\/panes$/u.test(path)) return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const agentPanel = (page: Page) => page.locator('.log-split > .log-output');
const switcher = (page: Page) => agentPanel(page).getByRole('button', { name: /^Switch Agent at Cora/u });

test('two Agents at one Place share one tab with stacked kind marks', async ({ page }) => {
  await mockConsole(page, { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }, { id: 'agent-2', kind: 'codex', attention: 'finished' }], dismissed: [] });
  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const cora = page.getByRole('tab', { name: /^Cora — / });
  await expect(cora.locator('.tab-kind-stack .launch-tab-badge')).toHaveCount(2);
  await expect(cora.locator('.tab-kind-stack .launch-tab-badge.launch-kind-claude')).toBeVisible();
  await expect(cora.locator('.tab-kind-stack .launch-tab-badge.launch-kind-codex')).toBeVisible();
  // an agentless pinned Place shows the empty mark
  await expect(page.getByRole('tab', { name: /^Delta — / }).locator('.tab-kind-stack .tab-place-mark.empty')).toBeVisible();

  // the switcher names the current conversation and counts the Agents here
  await expect(switcher(page)).toContainText('Conversation agent-1');
  await expect(switcher(page).locator('.agent-switcher-count')).toHaveText('2');
});

test('the switcher swaps the output, draft and history between the Agents at a Place', async ({ page }) => {
  await mockConsole(page, { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }, { id: 'agent-2', kind: 'codex', attention: 'finished', history: ['first', 'second'] }], dismissed: [] });
  const outputTickets: string[] = [];
  page.on('request', request => { const match = /\/api\/agents\/([^/]+)\/tickets$/u.exec(new URL(request.url()).pathname); if (match !== null) outputTickets.push(match[1]!); });
  await page.goto('/');
  const prompt = agentPanel(page).getByRole('textbox', { name: 'Prompt' });
  await expect(agentPanel(page).getByRole('button', { name: 'Prompt history (0)' })).toBeVisible();
  await prompt.fill('draft for the first agent');

  await switcher(page).click();
  const menu = page.getByRole('menu', { name: 'Agents at Cora' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await menu.getByRole('menuitemradio', { name: /Conversation agent-2/u }).click();
  await expect(switcher(page)).toContainText('Conversation agent-2');
  await expect(agentPanel(page).locator('.panel-header-title > .launch-tab-badge.launch-kind-codex')).toBeVisible();
  await expect(prompt).toHaveValue('');
  await expect(page).toHaveURL(/#agent=agent-2$/u);
  // the output streams the chosen Agent's pane, and the composer carries its history
  await expect.poll(() => outputTickets.includes('agent-2')).toBe(true);
  await expect(agentPanel(page).getByRole('button', { name: 'Prompt history (2)' })).toBeVisible();

  await switcher(page).click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /Conversation agent-1/u }).click();
  await expect(prompt).toHaveValue('draft for the first agent');
});

test('an untitled conversation reads as untitled in the switcher, beside the named one', async ({ page }) => {
  await mockConsole(page, { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished', conversation: null }, { id: 'agent-2', kind: 'claude', attention: 'finished', conversation: 'Testing' }], dismissed: [] });
  await page.goto('/');
  await switcher(page).click();
  // each row names its conversation, with the Agent's kind and state beneath
  await expect(page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio')).toHaveText([/Untitled conversation\s*Claude · Idle$/u, /Testing\s*Claude · Idle$/u]);
});

test('the tab rolls up the most urgent state and viewing an Agent through the switcher marks it read', async ({ page }) => {
  const state: Console = { agents: [{ id: 'agent-1', kind: 'claude', attention: 'working' }, { id: 'agent-2', kind: 'codex', attention: 'finished', unread: true }], dismissed: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  const cora = page.getByRole('tab', { name: /^Cora — / });
  // unread outranks working, and another Agent here has news
  await expect(cora).toHaveClass(/unread/u);
  await expectStationaryStatus(cora);
  await expect(switcher(page).locator('.agent-switcher-attention')).toBeVisible();

  const dismissedBefore = state.dismissed.length;
  await switcher(page).click();
  const menu = page.getByRole('menu', { name: 'Agents at Cora' });
  const done = menu.getByRole('menuitemradio', { name: /Conversation agent-2/u });
  await expectStationaryStatus(done);
  await expectProgressBorder(menu.getByRole('menuitemradio', { name: /Conversation agent-1/u }), 'peach');
  await done.click();
  await expect(cora).not.toHaveClass(/unread/u);
  await expect(cora).toHaveClass(/status-working/u);
  await expect(switcher(page).locator('.agent-switcher-attention')).toHaveCount(0);
  // the server is told which Agent was viewed, so a later refresh keeps it read
  await expect.poll(() => state.dismissed.slice(dismissedBefore)).toEqual(['agent-2']);

  // a question outranks everything, unread output included
  state.agents = [{ id: 'agent-1', kind: 'claude', attention: 'question' }, { id: 'agent-2', kind: 'codex', attention: 'working', unread: true }];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(cora).toHaveClass(/status-action-required/u, { timeout: 10_000 });
  await expectStationaryStatus(cora);
  await switcher(page).click();
  const question = menu.getByRole('menuitemradio', { name: /Conversation agent-1/u });
  await expectStationaryStatus(question);
  await question.click();
  const questionStatus = agentPanel(page).locator('.panel-header-title > .agent-state-pill');
  await expect(questionStatus).toHaveText('Needs answer');
  await expectStationaryStatus(questionStatus);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTab = page.getByRole('tab', { name: 'Cora — Action required' });
  // wait for the phone chooser instead of racing the desktop tab replacement
  await expect(phoneTab).toHaveAttribute('aria-haspopup', 'dialog');
  await expectStationaryStatus(phoneTab);
  await phoneTab.click();
  await expectStationaryStatus(page.locator('.workspace-sheet-row').filter({ hasText: 'Cora' }));
});

test('an #agent= link opens its Place and selects it in the switcher; #worktree= opens the Place', async ({ page }) => {
  await mockConsole(page, { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }, { id: 'agent-2', kind: 'codex', attention: 'finished' }], dismissed: [] });
  await page.goto('/#agent=agent-2');
  await expect(page.getByRole('tab', { name: /^Cora — / })).toHaveAttribute('aria-selected', 'true');
  await expect(switcher(page)).toContainText('Conversation agent-2');

  await page.evaluate(() => { location.hash = `worktree=${encodeURIComponent('app:/worktrees/delta')}`; });
  await expect(page.getByRole('tab', { name: /^Delta — / })).toHaveAttribute('aria-selected', 'true');
});

test('turning off one of two Agents leaves the panel on the other, and marks it read', async ({ page }) => {
  const state: Console = { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }, { id: 'agent-2', kind: 'codex', attention: 'finished', unread: true }], dismissed: [] };
  await mockConsole(page, state);
  await page.route('**/api/agents/agent-1/deactivate', route => { state.agents = state.agents.filter(agent => agent.id !== 'agent-1'); return route.fulfill({ status: 204 }); });
  await page.goto('/#agent=agent-1');
  await expect(switcher(page)).toContainText('Conversation agent-1');
  await agentPanel(page).getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Turn off' }).click();
  await expect(agentPanel(page).locator('.agent-panel-title')).toHaveText('Conversation agent-2');
  await expect(page.getByRole('tab', { name: /^Cora — / })).toHaveAttribute('aria-selected', 'true');
  await expect(switcher(page).locator('.agent-switcher-count')).toHaveCount(0);
  await expect.poll(() => state.dismissed).toContain('agent-2');
  await expect(page.getByRole('tab', { name: /^Cora — / })).not.toHaveClass(/unread/u);
});

test('Shift+Arrow cycles between Workspaces, not Agents', async ({ page }) => {
  await mockConsole(page, { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }, { id: 'agent-2', kind: 'codex', attention: 'finished' }], dismissed: [] });
  await page.goto('/');
  await page.getByRole('tab', { name: /^Cora — / }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: /^Delta — / })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: /^Cora — / })).toHaveAttribute('aria-selected', 'true');
});

test('the toolbar launches another Agent at a Worktree that has one, and the switcher shows it', async ({ page }) => {
  const state: Console = { agents: [{ id: 'agent-1', kind: 'claude', attention: 'finished' }], dismissed: [] };
  await mockConsole(page, state);
  const launches: string[] = [];
  await page.route('**/api/worktrees/*/launch', route => {
    launches.push(new URL(route.request().url()).pathname);
    state.agents = [...state.agents, { id: 'agent-2', kind: 'claude', attention: 'finished' }];
    return route.fulfill({ status: 201, json: { agentId: 'agent-2' } });
  });
  await page.goto('/');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const launch = toolbar.getByRole('button', { name: /^Launch/u }).first();
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(switcher(page)).toContainText('Conversation agent-2');
  await expect(switcher(page).locator('.agent-switcher-count')).toHaveText('2');
  expect(launches).toEqual([`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`]);
  await expect(page.getByRole('tab')).toHaveCount(2);
});

// desktop tabs and the phone dropdown share the question signal without an answer picker
for (const width of [1280, 390]) {
  // preserve the normal composer for questions asked in ordinary assistant prose
  test(`latest-message questions keep the normal composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const state: Console = { agents: [{ id: 'agent-1', kind: 'codex', attention: 'finished', hasMessageQuestion: true }], dismissed: [] };
    await mockConsole(page, state);
    await page.goto('/#agent=agent-1');
    const cora = page.getByRole('tab', { name: /^Cora — /u });
    await expect(cora).toHaveAccessibleName('Cora — Action required');
    await expect(agentPanel(page).getByText('Needs answer', { exact: true })).toBeVisible();
    const prompt = agentPanel(page).getByRole('textbox', { name: 'Prompt', exact: true });
    await expect(prompt).toBeVisible();
    await expect(page.getByRole('region', { name: 'Agent question' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toHaveCount(0);
    await prompt.fill('Use staging.');

    // resumed work clears the warning and keeps the ordinary reply draft intact
    state.agents = [{ id: 'agent-1', kind: 'codex', attention: 'working' }];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(cora).toHaveAccessibleName('Cora — Working', { timeout: 10_000 });
    await expect(agentPanel(page).getByText('Needs answer', { exact: true })).toHaveCount(0);
    await expect(prompt).toHaveValue('Use staging.');
  });
}
