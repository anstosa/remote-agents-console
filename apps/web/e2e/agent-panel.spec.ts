import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { expectSplitProgressBorder } from './progress-border-assertions.js';

type MockAgent = { attention?: 'working' | 'finished' | 'question'; kind?: 'claude' | 'codex' };
type MockOptions = { conversationName?: string; notes?: Array<{ id: string; text: string }> };

// stub the routes a live Worktree agent (or, with no agent, its pinned Worktree) preloads
async function mockConsole(page: Page, agent: MockAgent | undefined, { conversationName, notes = [] }: MockOptions = {}) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
      const agents = agent === undefined ? [] : [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', branch: 'cora', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, kind: agent.kind ?? 'claude', ...(agent.attention === undefined ? {} : { attention: agent.attention }), queuedPromptCount: 0 }];
      return route.fulfill({ json: { generation: 1, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: conversationName === undefined ? {} : { name: conversationName } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    if (url.pathname === '/api/agents/agent-1/deactivate') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const agentPanel = (page: Page) => page.locator('.log-split > .log-output');
const workspaceControls = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });

test('the agent output is a panel with a floating header and the composer at its foot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockConsole(page, { attention: 'finished' });
  await page.goto('/');
  const panel = agentPanel(page);
  await expect(panel).toBeVisible();

  // the title pill: the kind mark, the conversation title and the Agent's state
  const title = panel.locator('.panel-header-title');
  await expect(title.locator('.launch-tab-badge.launch-kind-claude')).toBeVisible();
  await expect(title).toContainText('Cora');
  await expect(title.locator('.agent-state-pill')).toHaveText('Idle');

  // the action pill: conversations, expand and the power menu; no Cancel while idle
  const actions = panel.getByRole('toolbar', { name: 'Agent output actions' });
  await expect(actions.getByRole('button', { name: 'Conversations (0)', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Expand agent output' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Cancel agent' })).toHaveCount(0);
  const power = actions.getByRole('button', { name: 'Agent power options' });
  await power.click();
  const menu = page.getByRole('menu', { name: 'Agent power options' });
  // hide project actions that have no configured command
  await expect(menu.getByRole('menuitem')).toHaveText(['Restart', 'Clear', 'Turn off']);
  await expect(menu.getByRole('menuitem', { name: 'New Task' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 400);
  await expect(menu).toHaveCount(0);

  // the composer sits inside the panel, below the output: history above attach on the left,
  // queued prompts above send on the right
  const composer = panel.getByRole('region', { name: 'Prompt composer' });
  const prompt = composer.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  const outputBox = (await panel.locator('.log-canvas').boundingBox())!;
  const promptBox = (await prompt.boundingBox())!;
  expect(promptBox.y).toBeGreaterThanOrEqual(outputBox.y + outputBox.height - 1);
  const history = (await composer.getByRole('button', { name: 'Prompt history (0)' }).boundingBox())!;
  const attach = (await composer.getByRole('button', { name: 'Attach files' }).boundingBox())!;
  const queued = composer.getByRole('button', { name: 'Queued prompts (0)' });
  await expect(queued).toBeDisabled();
  const queuedBox = (await queued.boundingBox())!;
  const send = (await composer.getByRole('button', { name: 'Queue', exact: true }).boundingBox())!;
  expect(history.y).toBeLessThan(attach.y);
  expect(Math.abs(history.x - attach.x)).toBeLessThanOrEqual(1);
  expect(history.x + history.width).toBeLessThanOrEqual(promptBox.x + 1);
  expect(queuedBox.y).toBeLessThan(send.y);
  expect(Math.abs(queuedBox.x - send.x)).toBeLessThanOrEqual(1);
  expect(queuedBox.x).toBeGreaterThanOrEqual(promptBox.x + promptBox.width - 1);

  // what left the composer stays reachable from the row beneath the tab row
  const row = workspaceControls(page);
  await expect(row.getByRole('button', { name: 'More options' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(row.locator('.git-status-summary')).toBeVisible();
  const tabs = (await page.getByRole('tablist').boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
  await expect(composer.getByRole('button', { name: 'More options' })).toHaveCount(0);
});

test('a working agent offers Cancel beside its hidden power menu', async ({ page }) => {
  await mockConsole(page, { attention: 'working' });
  await page.goto('/');
  const actions = agentPanel(page).getByRole('toolbar', { name: 'Agent output actions' });
  const cancel = actions.getByRole('button', { name: 'Cancel agent' });
  await expect(cancel).toBeVisible();
  const power = actions.locator('.agent-power');
  await expect(power).toBeDisabled();
  await expect(power).toBeHidden();
  expect(await cancel.evaluate(element => element.nextElementSibling?.classList.contains('power-menu-wrap'))).toBe(true);
  const expand = await actions.getByRole('button', { name: 'Expand agent output' }).boundingBox();
  const stop = await cancel.boundingBox();
  expect(stop!.x).toBeGreaterThan(expand!.x);
  await expect(agentPanel(page).locator('.agent-state-pill')).toHaveText('Working');
});

test('the composer stays inside the agent panel on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsole(page, { attention: 'finished' });
  await page.goto('/');
  const composer = agentPanel(page).getByRole('region', { name: 'Prompt composer' });
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(workspaceControls(page).getByRole('button', { name: 'More options' })).toBeVisible();
});

test('turning off the last agent closes the agent panel and keeps a pinned tab', async ({ page }) => {
  let agent: MockAgent | undefined = { attention: 'finished' };
  await mockConsole(page, undefined);
  // serve the dashboard from the mutable agent so Turn off takes effect on the next refresh
  await page.route('**/api/dashboard', route => {
    const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
    const agents = agent === undefined ? [] : [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'claude', attention: 'finished', queuedPromptCount: 0 }];
    return route.fulfill({ json: { generation: 1, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
  });
  await page.route('**/api/agents/agent-1/deactivate', route => { agent = undefined; return route.fulfill({ status: 204 }); });
  await page.goto('/');
  await agentPanel(page).getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Turn off' }).click();
  await expect(agentPanel(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Cora/u })).toBeVisible();
  await expect(workspaceControls(page).getByRole('button', { name: /^Launch/u }).first()).toBeVisible();
});

test('the title names the current conversation and the header shows the connection until it is live', async ({ page }) => {
  await installPaneMock(page);
  await mockConsole(page, { attention: 'finished' }, { conversationName: 'Fix the login redirect' });
  await page.goto('/');
  const title = agentPanel(page).locator('.panel-header-title');
  await expect(title.locator('.agent-panel-title')).toHaveText('Fix the login redirect');
  // before the first bytes the connection status rides beside the state
  await expect(title.locator('.log-status')).toBeVisible();
  await expect(title.locator('.log-status')).not.toHaveText('Live');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'ready\r\n');
  await expect(title.locator('.log-status')).toHaveCount(0);
  await expect(title.locator('.agent-state-pill')).toHaveText('Idle');
});

// startup frames the whole split without blocking its draft composer
test('a starting launch shows the agent panel with its notice and the composer holding the draft', async ({ page }) => {
  await mockConsole(page, undefined);
  // hold the launch open so the Worktree stays starting
  await page.route('**/api/worktrees/cora/launch', () => new Promise<void>(() => { /* never answers */ }));
  await page.goto('/');
  await expect(agentPanel(page)).toHaveCount(0);
  await workspaceControls(page).getByRole('button', { name: /^Launch/u }).first().click();
  const panel = agentPanel(page);
  await expect(panel.locator('.panel-header-title .agent-panel-title')).toHaveText('Cora');
  await expect(panel.locator('.panel-header-title .agent-state-pill')).toHaveText('Starting');
  const notice = panel.locator(':scope > .log-loading');
  await expect(notice).toContainText('Starting agent at Cora…');
  await expect(notice).toContainText('Your prompt waits in the composer');
  await expect(panel.locator('.agent-output')).toBeEmpty();
  await expectSplitProgressBorder(panel, 'blue');
  const prompt = panel.getByRole('region', { name: 'Prompt composer' }).getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Run the tests');
  await expect(prompt).toHaveValue('Run the tests');
  // keep the preparing output's split edge above its usable draft composer
  const borderPlacement = await panel.evaluate(element => {
    const output = element.querySelector<HTMLElement>('.agent-output');
    const composer = element.querySelector<HTMLElement>('.agent-composer');
    // require both rows in the pending panel
    if (output === null || composer === null) throw new Error('pending Agent rows are missing');
    return {
      outputBorder: getComputedStyle(output).borderBottomWidth,
      panelBorder: getComputedStyle(element).borderBottomWidth,
      gap: composer.getBoundingClientRect().top - output.getBoundingClientRect().bottom
    };
  });
  expect(borderPlacement).toEqual({ outputBorder: '1px', panelBorder: '0px', gap: 0 });
  // a starting panel has no discard: the draft stays until the Agent takes it
  await expect(panel.getByRole('button', { name: 'Discard draft' })).toHaveCount(0);
});

test('an agentless Workspace gives an open note the whole width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockConsole(page, undefined, { notes: [{ id: 'note-1', text: 'Deploy checklist' }] });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  await workspaceControls(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.locator('.notes-menu .note-choice').first().click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toHaveCount(0);
  const [noteBox, workspaceBox] = await Promise.all([note.boundingBox(), page.locator('.log').boundingBox()]);
  expect(noteBox!.width).toBeGreaterThan(workspaceBox!.width - 4);
});
