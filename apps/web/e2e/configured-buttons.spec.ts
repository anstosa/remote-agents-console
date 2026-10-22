import { expect, test } from '@playwright/test';

const palette = {
  crust: 'rgb(17, 17, 27)',
  green: 'rgb(166, 227, 161)',
  lavender: 'rgb(180, 190, 254)',
  maroon: 'rgb(235, 160, 172)',
  mauve: 'rgb(203, 166, 247)',
  rosewater: 'rgb(245, 224, 220)',
  sapphire: 'rgb(116, 199, 236)',
  sky: 'rgb(137, 220, 235)'
} as const;

// require solid buttons to retain their selected palette fill
async function expectSolid(locator: import('@playwright/test').Locator, color: keyof typeof palette) {
  await expect(locator).toHaveCSS('background-color', palette[color]);
  await expect(locator).toHaveCSS('border-top-color', palette[color]);
  await expect(locator).toHaveCSS('color', palette.crust);
}

// require outline buttons to retain their selected palette foreground
async function expectOutline(locator: import('@playwright/test').Locator, color: keyof typeof palette) {
  await expect(locator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(locator).toHaveCSS('color', palette[color]);
  expect(await locator.evaluate(element => getComputedStyle(element).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
}

const slots = () => ({
  tabLead: [], leftNav: [], rightNav: [], navMenu: [], pullRequest: [],
  'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': []
});
const button = (id: string, text: string, color: string, style: 'outline' | 'solid', actionKind: 'shell' | 'prompt' = 'shell') => ({ id, text, icon: 'M5 12h14', color, style, actionKind });
const effective = {
  ...slots(),
  tabLead: [button('tab-action', 'Tab action', 'rosewater', 'outline')],
  leftNav: [button('left-action', 'Left action', 'green', 'solid')],
  rightNav: [button('right-action', 'Right action', 'sapphire', 'outline')],
  navMenu: [button('menu-action', 'Menu action', 'maroon', 'solid', 'prompt')],
  pullRequest: [button('push-action', 'Commit/Push', 'mauve', 'solid', 'prompt'), button('fixup-action', '$fixup', 'lavender', 'outline', 'prompt')],
  'split:agent': [button('agent-action', 'Agent action', 'sky', 'outline', 'prompt')]
};
const worktree = { id: 'wt-1', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/buttons', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } };
const dashboard = {
  generation: 1,
  serverStartedAt: 17,
  agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: worktree.path, worktreeId: worktree.id, placeId: worktree.id, projectId: 'repo', title: 'Ready', queuedPromptCount: 0, branch: worktree.branch, gitStatus: worktree.gitStatus }],
  projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [worktree] }],
  buttons: { revision: 'buttons-v1', application: effective, projects: { repo: effective } }
};

// mount one retained action registry with a controllable flyout operation
async function mount(page: import('@playwright/test').Page) {
  const starts: Array<Record<string, unknown>> = [];
  let menuComplete = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[^/]+\/tickets$/u.test(path)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (path === `/api/worktrees/${worktree.id}/panes`) return route.fulfill({ json: { panes: [] } });
    if (path === `/api/worktrees/${worktree.id}/notes`) return route.fulfill({ json: { notes: [] } });
    if (path === '/api/button-actions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown> & { actionId: string };
      starts.push(body);
      return route.fulfill({ status: 202, json: { operation: { id: `operation-${body.actionId}`, state: body.actionId === 'menu-action' ? 'running' : 'complete', ...(body.actionId === 'agent-action' ? { phase: 'submitted' } : {}) } } });
    }
    if (path === '/api/button-actions/operation-menu-action') return route.fulfill({ json: { operation: { id: 'operation-menu-action', state: menuComplete ? 'complete' : 'running', ...(menuComplete ? { phase: 'submitted' } : {}) } } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { starts, completeMenu: () => { menuComplete = true; } };
}

test('renders configured slots and retains closed flyout progress without executable request data', async ({ page }) => {
  const controls = await mount(page);
  const tabAction = page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' });
  await expect(tabAction).toBeVisible();
  await expectOutline(tabAction, 'rosewater');
  await expect(page.locator('.workspace-toolbar-actions > .configured-left-nav + .toolbar-spacer')).toHaveCount(1);
  await expect(page.locator('.workspace-toolbar-actions > .toolbar-spacer + .configured-right-nav')).toHaveCount(1);
  await expectSolid(page.locator('.configured-left-nav').getByRole('button', { name: 'Left action' }), 'green');
  await expectOutline(page.locator('.configured-right-nav').getByRole('button', { name: 'Right action' }), 'sapphire');
  const agentAction = page.locator('.agent-panel .panel-header-actions').getByRole('button', { name: 'Agent action' });
  await expect(agentAction).toBeVisible();
  await expectOutline(agentAction, 'sky');
  await agentAction.click();
  const immediateSubmission = page.locator('.operation-feedback').filter({ hasText: 'Agent action submitted' });
  await expect(immediateSubmission).toContainText('Prompt submitted to the agent.');

  const more = page.getByRole('button', { name: 'More options' });
  await more.click();
  const menuAction = page.getByRole('button', { name: 'Menu action' });
  await expectSolid(menuAction, 'maroon');
  await menuAction.click();
  await expect(page.locator('.place-menu')).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-busy', 'true');
  expect(controls.starts).toHaveLength(2);
  const menuStart = controls.starts.find(start => start.actionId === 'menu-action');
  expect(menuStart).toMatchObject({ actionId: 'menu-action', configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'navMenu', agentId: 'agent-1' });
  expect(menuStart).not.toHaveProperty('command');
  expect(menuStart).not.toHaveProperty('prompt');
  expect(menuStart).not.toHaveProperty('cwd');
  await more.click();
  const busyMenuAction = page.getByRole('button', { name: 'Menu action' });
  await expect(busyMenuAction).toHaveAttribute('aria-busy', 'true');
  await expect(busyMenuAction).toBeDisabled();
  await expectSolid(busyMenuAction, 'maroon');
  await page.keyboard.press('Escape');
  await expect(page.locator('.place-menu')).toHaveCount(0);
  controls.completeMenu();
  await expect(more).not.toHaveAttribute('aria-busy', 'true', { timeout: 4_000 });
  const polledSubmission = page.locator('.operation-feedback').filter({ hasText: 'Menu action submitted' });
  await expect(polledSubmission).toContainText('Prompt submitted to the agent.');

  await page.getByRole('button', { name: /^Git status: feature\/buttons/u }).click();
  const actions = page.getByRole('region', { name: 'Changed files' }).locator('.git-status-actions');
  const push = actions.getByRole('button', { name: 'Commit/Push' });
  const fixup = actions.getByRole('button', { name: '$fixup', exact: true });
  await expect(push).toBeVisible();
  await expect(fixup).toBeVisible();
  await expectSolid(push, 'mauve');
  await expectOutline(fixup, 'lavender');
  await expect(actions.getByRole('button', { name: /Push/u })).toHaveCount(1);
  await expect(actions.locator('.git-status-push, .pull-request-fixup')).toHaveCount(0);
  await page.getByRole('region', { name: 'Changed files' }).screenshot({ path: '/tmp/remoteagents-configured-pr-colors.png' });
});

test('interrupts a delayed action response from an old server boot', async ({ page }) => {
  await mount(page);
  let releaseStart!: () => void;
  const heldStart = new Promise<void>(resolve => { releaseStart = resolve; });
  let posts = 0;
  let postFinished = false;
  // hold the accepted response beyond the next dashboard boot
  await page.route('**/api/button-actions', async route => {
    posts += 1;
    await heldStart;
    await route.fulfill({ status: 202, json: { operation: { id: 'operation-tab-action', state: 'complete' } } });
    postFinished = true;
  });
  const tabAction = page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' });
  await tabAction.click();
  await expect(tabAction).toHaveAttribute('aria-busy', 'true');

  let dashboardReads = 0;
  // publish a new boot through the normal visible-dashboard refresh
  await page.route('**/api/dashboard', route => {
    dashboardReads += 1;
    return route.fulfill({ json: { ...dashboard, generation: 2, serverStartedAt: 18 } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardReads).toBeGreaterThan(0);
  await expect(tabAction).not.toHaveAttribute('aria-busy', 'true');

  releaseStart();
  await expect.poll(() => postFinished).toBe(true);
  // let the retained provider consume the fulfilled old-boot response
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.operation-feedback').filter({ hasText: 'Tab action finished' })).toHaveCount(0);
  expect(posts).toBe(1);
});
