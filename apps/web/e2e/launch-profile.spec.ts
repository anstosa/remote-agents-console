import { expect, test, type Page, type Route } from '@playwright/test';

// A configured, launchable adapter capability with the given program.
const adapter = (program: string, extra: Record<string, unknown> = {}) => ({ launchable: true, program, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false, ...extra });
const codex = adapter('/bin/codex', { stateSource: 'both', turnCapture: true });
const claude = adapter('/bin/claude');

type Dashboard = Record<string, unknown>;
type LaunchPost = { path: string; body: unknown };

// Mount the app against a stubbed dashboard, recording every launch-family POST body.
async function mount(page: Page, dashboard: Dashboard): Promise<LaunchPost[]> {
  const posts: LaunchPost[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // record and satisfy the three launch-family routes the controls call
    if (request.method() === 'POST' && (url.pathname === '/api/agents/launch' || /\/api\/worktrees\/[^/]+\/launch$/u.test(url.pathname) || /\/api\/agents\/[^/]+\/restart$/u.test(url.pathname))) {
      posts.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { agentId: 'agent-launched' } });
    }
    if (request.method() === 'GET') return route.fulfill({ json: {} });
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  return posts;
}

const pinnedWorktree = (launch: unknown, overrides: Record<string, unknown> = {}) => ({ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch, ...overrides });
// the Workspace toolbar; an empty Workspace repeats its Launch in the body
const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });

test('launches the resolved kind in one click and lists every configured kind in the menu', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  const primary = toolbar(page).getByRole('button', { name: 'Launch Claude' });
  await expect(primary).toBeEnabled();
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Launch · Cora')).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).locator('.launch-row')).toBeVisible();
  // the resolved kind is annotated with why it resolved
  await expect(menu.getByText('last used here')).toBeVisible();
  await menu.getByRole('group', { name: 'Codex agent' }).locator('.launch-row').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

// keep the empty card's chooser beside its one-click launch
test('empty worktree Launch dropdown chooses another configured agent', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  await expect(empty.getByRole('button', { name: 'Launch Cora' })).toBeEnabled();
  const chooser = empty.getByRole('button', { name: 'More workspace actions' });
  await expect(chooser).toHaveAttribute('aria-haspopup', 'menu');
  await chooser.click();
  await expect(chooser).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(menu.getByRole('group', { name: 'Claude agent' }).getByRole('menuitem', { name: /^Claude/u })).toContainText('last used here');
  // opening and dismissing the selector never starts an agent
  expect(posts).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(chooser).toHaveAttribute('aria-expanded', 'false');
  await chooser.click();
  await menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: /^Codex/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
  await expect(menu).toHaveCount(0);
});

// retain the resolved default on the desktop primary
test('empty worktree primary still launches its resolved agent in one click', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  await page.getByRole('region', { name: 'Empty workspace' }).getByRole('button', { name: 'Launch Cora' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: false } }]);
});

// a phone has one full-size Launch target; choosing a row, not tapping the target, starts an Agent
test('mobile Launch is one menu button in the toolbar and empty Workspace', async ({ page }) => {
  // opt in for marker geometry checks
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await page.setViewportSize({ width: 390, height: 844 });
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  const trigger = toolbar(page).locator('.launch-menu-only button');
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-label', 'Launch agent');
  // the phone launch icon uses a top caret instead of an inline chevron
  await expect(trigger.locator('.launch-chevron-icon')).toHaveCount(0);
  const caret = trigger.locator(':scope > .flyout-caret');
  await expect(caret).toBeVisible();
  const [buttonBox, caretBox] = await Promise.all([trigger.boundingBox(), caret.boundingBox()]);
  expect(Math.abs(caretBox!.x + caretBox!.width / 2 - buttonBox!.x - buttonBox!.width / 2)).toBeLessThanOrEqual(1);
  expect(caretBox!.y + caretBox!.height).toBeLessThan(buttonBox!.y + buttonBox!.height / 3);
  await expect(page.locator('.workspace-toolbar-actions .launch-primary, .workspace-toolbar-actions .launch-chevron')).toHaveCount(0);
  expect((await trigger.boundingBox())?.width).toBeCloseTo((await toolbar(page).getByRole('button', { name: 'Open a terminal' }).boundingBox())?.width ?? 0, 1);
  await trigger.click();
  await expect(page.locator('.launch-menu').getByRole('menuitem', { name: /^Claude(?! accounts)/u })).toBeVisible();
  expect(posts).toEqual([]);
  await page.mouse.click(4, 4);

  // the empty card shares the phone chooser instead of launching immediately
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  const emptyLaunch = empty.getByRole('button', { name: 'Launch agent' });
  await expect(emptyLaunch).toBeVisible();
  await expect(empty.locator('.launch-menu-only button')).toHaveCount(1);
  await expect(emptyLaunch).toHaveAttribute('aria-haspopup', 'menu');
  await expect(empty.locator('.launch-primary, .launch-chevron')).toHaveCount(0);
  await emptyLaunch.click();
  expect(posts).toEqual([]);
  await page.getByRole('menu', { name: 'More workspace actions' }).getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: /^Codex/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

// even without a resolved default, the phone Launch target opens the configured-agent chooser
test('mobile Launch opens its menu without a resolved default', async ({ page }) => {
  // opt in for marker visibility checks
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await page.setViewportSize({ width: 700, height: 844 });
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree(undefined)] }] });
  const trigger = toolbar(page).locator('.launch-menu-only button');
  await expect(trigger).toHaveCount(1);
  await expect(trigger.locator(':scope > .flyout-caret')).toBeVisible();
  await trigger.click();
  expect(posts).toEqual([]);
  await page.locator('.launch-menu').getByRole('group', { name: 'Codex agent' }).locator('.launch-row').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

// the chooser remains available for explanation even when no kind can be launched
test('mobile Launch opens an empty agent menu when no adapters are configured', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts = await mount(page, { generation: 1, adapters: {}, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({})] }] });
  const trigger = toolbar(page).locator('.launch-menu-only button');
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.locator('.launch-menu')).toContainText('No agents configured');
  expect(posts).toEqual([]);
});

// the toolbar beside a running Agent uses the same one-target chooser
test('mobile Launch remains one menu button beside a running Agent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] });
  const launchControl = toolbar(page).locator('.launch-menu-only.quiet');
  await expect(launchControl.locator('button')).toHaveCount(1);
  await launchControl.getByRole('button', { name: 'Launch agent' }).click();
  await expect(page.locator('.launch-menu').getByRole('menuitem', { name: /^Claude(?! accounts)/u })).toBeVisible();
  expect(posts).toEqual([]);
});

test('OMX is its own kind: badged ◈, listed beside Codex, and launched as omx', async ({ page }) => {
  const omx = adapter('/bin/omx', { stateSource: 'title', turnCapture: true, inlineQuestions: true });
  const posts = await mount(page, { generation: 1, adapters: { codex, omx }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'omx', origin: 'worktree' })] }] });
  const primary = toolbar(page).getByRole('button', { name: 'Launch OMX' });
  await expect(primary).toBeEnabled();
  await expect(primary.locator('.launch-kind-omx')).toHaveText('◈');
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  // both kinds are offered; OMX runs the Codex TUI, so it names Codex's own sandbox like Codex does
  await expect(menu.getByRole('group', { name: 'Codex agent' }).locator('.launch-row')).toBeVisible();
  const omxRow = menu.getByRole('menuitem', { name: /^OMX/ });
  await expect(omxRow).toContainText('last used here');
  await expect(omxRow).toContainText("Uses Codex's own sandbox");
  await omxRow.click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'omx', sandboxed: false } }]);
});

test('one click on the primary launches the resolved kind unsandboxed', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });
  await toolbar(page).getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

test('a sandbox-capable kind defaults to a locked launch and offers a without-sandbox row', async ({ page }) => {
  // simulate the chunk-4 wire: a launchable Claude that reports a console-enforceable sandbox
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { codex, claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  // the primary names the sandboxed default with a lock
  await expect(toolbar(page).getByRole('button', { name: 'Launch Claude' }).locator('.launch-lock')).toBeVisible();
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Sandbox enforced by console')).toBeVisible();
  await expect(menu.getByText('Without sandbox — this launch only')).toBeVisible();
  // the without-sandbox row launches the same kind unsandboxed
  await menu.locator('.launch-row-unsandboxed').filter({ hasText: 'Claude' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: false } }]);
});

test('the primary launches a sandbox-capable kind sandboxed', async ({ page }) => {
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  await toolbar(page).getByRole('button', { name: 'Launch Claude' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: true } }]);
});

test('an unavailable kind is disabled in the menu with its reason', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const claudeRow = page.locator('.launch-menu').getByRole('menuitem', { name: /^Claude(?! accounts)/u });
  await expect(claudeRow).toBeDisabled();
  await expect(claudeRow).toContainText('/bin/claude is not executable');
});

test('zero configured adapters disables the primary with the config hint and a disabled chevron', async ({ page }) => {
  await mount(page, { generation: 1, adapters: {}, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({})] }] });
  // scope to the card's split button — the "+" launcher tab shares the "Launch agent" name
  const primary = page.locator('.workspace-toolbar-actions .launch-primary');
  await expect(primary).toHaveText('Launch agent');
  await expect(primary).toBeDisabled();
  await expect(page.locator('.workspace-toolbar-actions .launch-chevron')).toBeDisabled();
  await expect(toolbar(page).getByText('No agents configured — add an adapters entry to the console config.')).toBeVisible();
});

test('configured but none launchable disables the primary yet still opens the menu', async ({ page }) => {
  const brokenCodex = adapter('/bin/codex', { launchable: false, unavailableReason: '/bin/codex is not executable' });
  await mount(page, { generation: 1, adapters: { codex: brokenCodex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({})] }] });
  await expect(page.locator('.workspace-toolbar-actions .launch-primary')).toBeDisabled();
  await expect(toolbar(page).getByText('No configured agent is launchable right now')).toBeVisible();
  await page.locator('.workspace-toolbar-actions .launch-chevron').click();
  await expect(page.locator('.launch-menu').getByRole('group', { name: 'Codex agent' }).locator('.launch-row')).toBeDisabled();
});

test('a remembered kind that is no longer launchable is skipped with a footnote', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default', skipped: { kind: 'claude', origin: 'worktree', reason: '/bin/claude is not executable' } })] }] });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  await expect(page.locator('.launch-menu-note')).toContainText('Remembered Claude (here) skipped — /bin/claude is not executable');
});

test('the + flyout keeps direct Place actions while its dropdown chooses configured agents', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }], scratchLaunch: { kind: 'codex', origin: 'scratch' } });
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  const launcher = page.locator('.launcher-menu');
  await expect(launcher.getByText('Scratch', { exact: true })).toBeVisible();
  // each row keeps its plain direct action
  const worktreeRow = launcher.locator('.launcher-row').filter({ hasText: 'Cora' });
  const rowLaunch = worktreeRow.getByRole('button', { name: 'Launch Cora' });
  await expect(rowLaunch).toBeVisible();
  // the wrapper paints one gradient beneath both transparent button segments
  const fullSplit = page.locator('.workspace-toolbar-actions .launch-split');
  const compactSplit = worktreeRow.locator('.launch-split.compact');
  await expect(fullSplit).toHaveCSS('background-image', /linear-gradient/);
  await expect(compactSplit).toHaveCSS('background-image', /linear-gradient/);
  await expect(fullSplit.locator('.launch-primary')).toHaveCSS('background-image', 'none');
  await expect(fullSplit.locator('.launch-chevron')).toHaveCSS('background-image', 'none');
  await expect(compactSplit.locator('.launch-primary')).toHaveCSS('background-image', 'none');
  await expect(compactSplit.locator('.launch-chevron')).toHaveCSS('background-image', 'none');
  await expect(fullSplit.locator('.launch-chevron')).toHaveCSS('border-left-width', '1px');
  await expect(compactSplit.locator('.launch-chevron')).toHaveCSS('border-left-width', '1px');
  // keep the new-task action compact without losing its aligned fixed column
  const compactBox = await compactSplit.boundingBox();
  expect(compactBox).toBeDefined();
  expect(compactBox?.width).toBeLessThanOrEqual(130);
  // hover brightness belongs to the shared gradient wrapper, not both segments
  await rowLaunch.hover();
  await expect(rowLaunch).toHaveCSS('filter', 'none');
  await expect(compactSplit).not.toHaveCSS('filter', 'none');
  // resolved compact Launch identifies its direct agent without widening the fixed column
  const compactMark = worktreeRow.locator('.launch-primary .launch-kind-mark');
  await expect(compactMark).toHaveText('✳');
  await expect(compactMark).toHaveCSS('color', 'rgb(250, 179, 135)');
  const [primaryBox, markBox, labelBox, chevronBox] = await Promise.all([
    rowLaunch.boundingBox(),
    compactMark.boundingBox(),
    rowLaunch.locator('.launch-primary-label').boundingBox(),
    compactSplit.locator('.launch-chevron').boundingBox(),
  ]);
  expect(primaryBox).not.toBeNull();
  expect(markBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(chevronBox).not.toBeNull();
  expect(markBox!.x + markBox!.width).toBeLessThanOrEqual(labelBox!.x);
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(primaryBox!.x + primaryBox!.width);
  expect(primaryBox!.x + primaryBox!.width).toBeLessThanOrEqual(chevronBox!.x + 1);
  await expect(page.locator('.workspace-toolbar .launch-split:not(.compact)').getByRole('button', { name: 'Launch Claude' }).locator('.launch-kind-mark')).toHaveText('✳');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(compactMark).toBeVisible();
  const [mobileSplitBox, mobileMarkBox, mobileLabelBox, mobileChevronBox] = await Promise.all([
    compactSplit.boundingBox(),
    compactMark.boundingBox(),
    rowLaunch.locator('.launch-primary-label').boundingBox(),
    compactSplit.locator('.launch-chevron').boundingBox(),
  ]);
  expect(mobileSplitBox).not.toBeNull();
  expect(mobileMarkBox).not.toBeNull();
  expect(mobileLabelBox).not.toBeNull();
  expect(mobileChevronBox).not.toBeNull();
  expect(mobileSplitBox!.width).toBeLessThanOrEqual(130);
  expect(mobileMarkBox!.x + mobileMarkBox!.width).toBeLessThanOrEqual(mobileLabelBox!.x);
  expect(mobileLabelBox!.x + mobileLabelBox!.width).toBeLessThanOrEqual(mobileChevronBox!.x + 1);
  await page.screenshot({ path: '/tmp/remoteagents-plus-primary-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });

  await worktreeRow.getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(choices.getByRole('menuitem', { name: /^Codex/u })).toBeVisible();
  await expect(choices.getByRole('menuitem', { name: /^Claude/u })).toBeVisible();
  await expect(choices.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/remoteagents-plus-chooser-desktop.png' });
  await choices.getByRole('menuitem', { name: /^Codex/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);

  // the scratch row primary launches its own resolved kind
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  await launcher.locator('.launcher-row').filter({ hasText: 'Scratch' }).getByRole('button', { name: 'Launch ~ Scratch' }).click();
  await expect.poll(() => posts).toEqual([
    { path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } },
    { path: '/api/agents/launch', body: { kind: 'codex', sandboxed: false } },
  ]);
});

// keep running-worktree choices available from a phone without changing Open
test('mobile + Open keeps configured-agent choices for a running worktree', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] });
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const open = launcher.getByRole('button', { name: 'Open Cora' });
  await expect(open).toBeVisible();
  await expect(open.locator('.launch-kind-mark')).toHaveCount(0);
  await open.locator('..').getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(choices.getByRole('menuitem', { name: /^Claude/u })).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-plus-chooser-mobile.png' });
  await choices.getByRole('menuitem', { name: /^Claude/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: false } }]);
});

// keep Scratch choices reachable before the server resolves a direct default
test('the + Scratch dropdown chooses an agent without a Place or resolution', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [] });
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  const scratch = page.getByRole('group', { name: 'Agent launcher' }).locator('.launcher-row').filter({ hasText: 'Scratch' });
  await expect(scratch.getByRole('button', { name: 'Launch ~ Scratch' })).toBeVisible();
  await expect(scratch.locator('.launch-primary .launch-kind-mark')).toHaveCount(0);
  await scratch.getByRole('button', { name: 'More workspace actions' }).click();
  await page.getByRole('menu', { name: 'More workspace actions' }).getByRole('menuitem', { name: /^Claude/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/launch', body: { kind: 'claude', sandboxed: false } }]);
});

// keep agent glyphs full-size and colored only in the persistent Launch chooser
test('the far-left Launch chooser owns every agent glyph and sandbox mark', async ({ page }) => {
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const adapters = { codex, omx: adapter('/bin/omx'), claude: sandboxedClaude, pi: adapter('/bin/pi'), opencode: adapter('/bin/opencode') };
  const kinds = [
    { label: 'Codex', color: 'rgb(166, 227, 161)' },
    { label: 'OMX', color: 'rgb(148, 226, 213)' },
    { label: 'Claude', color: 'rgb(250, 179, 135)' },
    { label: 'Pi', color: 'rgb(137, 220, 235)' },
    { label: 'OpenCode', color: 'rgb(203, 166, 247)' },
  ];
  await mount(page, { generation: 1, adapters, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }], scratchLaunch: { kind: 'codex', origin: 'scratch' } });

  const fullPrimary = page.locator('.workspace-toolbar .launch-split:not(.compact)').getByRole('button', { name: 'Launch Claude' });
  await expect(fullPrimary.locator('.launch-kind-mark')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(fullPrimary.locator('.launch-kind-mark')).toHaveCSS('color', 'rgb(250, 179, 135)');
  await expect(fullPrimary.locator('.launch-kind-mark')).toHaveCSS('font-size', '18.4px');
  await expect(fullPrimary.locator('.launch-lock')).toBeVisible();

  await page.locator('.workspace-toolbar').getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  // verify every chooser glyph fills its space without losing its color
  for (const kind of kinds) {
    const mark = menu.getByRole('menuitem', { name: new RegExp(`^${kind.label}`, 'u') }).first().locator('.launch-kind-mark');
    await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(mark).toHaveCSS('color', kind.color);
    await expect(mark).toHaveCSS('font-size', '18.4px');
  }
  await expect(menu.getByRole('menuitem', { name: /^Claude/u }).first().locator('.launch-lock')).toBeVisible();
});

// the launcher rows open the same anchored flyout every other Launch control opens: one
// fixed-width menu hung off the row, dismissed by a press anywhere outside it — including
// one inside the launcher, whose own backdrop only covers presses outside itself
test('a + row menu keeps agent states and workspace actions, then closes outside', async ({ page }) => {
  const unavailableCodex = adapter('/bin/codex', { launchable: false, unavailableReason: '/bin/codex is not executable' });
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  await mount(page, { generation: 1, adapters: { codex: unavailableCodex, claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }], scratchLaunch: { kind: 'claude', origin: 'scratch' } });
  await page.getByRole('button', { name: 'Launch agent' }).click();
  const launcher = page.locator('.launcher-menu');
  const menu = page.locator('.launch-menu');
  const row = launcher.locator('.launcher-row').filter({ hasText: 'Cora' });
  await row.getByRole('button', { name: 'More workspace actions' }).click();
  await expect(menu.getByRole('menuitem', { name: /^Codex/u })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /^Claude · last used here/u })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Claude.*Sandbox disabled for this launch/u })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Terminal/u })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Empty workspace/u })).toBeVisible();
  await expect(menu.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update')).toHaveCount(0);
  // a press elsewhere in the launcher closes the menu alone, leaving the launcher open
  await launcher.locator('.launcher-project-header').click({ position: { x: 3, y: 3 } });
  await expect(menu).toHaveCount(0);
  await expect(launcher).toBeVisible();
  // reopening preserves the same mixed choice menu
  await row.getByRole('button', { name: 'More workspace actions' }).click();
  await expect(menu.getByRole('menuitem')).toHaveCount(5);
});

test('an idle agent restarts as another kind from its power menu', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [] });
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  // the Launch menu opens as a second page within the power-menu flyout
  const menu = page.locator('.agent-power-menu');
  await expect(menu.getByText('Restart · Cora')).toBeVisible();
  await menu.getByRole('menuitem', { name: /Claude/ }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/agent-1/restart', body: { kind: 'claude', sandboxed: false } }]);
});

test('agent tabs carry the kind glyph and a lock when sandboxed, idle worktree tabs carry none', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'claude', attention: 'finished', sandboxed: true, queuedPromptCount: 0 };
  await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' }, { id: 'delta', label: 'Delta', order: 2 })] }] });
  // the Claude agent tab shows its glyph and a lock
  const agentTab = page.getByRole('tab', { name: /Cora/ });
  await expect(agentTab.locator('.launch-tab-badge .launch-kind-mark')).toHaveText('✳');
  await expect(agentTab.locator('.launch-tab-badge .launch-lock')).toBeVisible();
  // the idle worktree tab carries no badge
  await expect(page.getByRole('tab', { name: /Delta/ }).locator('.launch-tab-badge')).toHaveCount(0);
});

// keep every agent tab glyph full-size, unboxed, and close to its label at each supported width
test('agent tab glyphs stay unboxed, full-size, and tightly spaced on desktop and mobile', async ({ page }) => {
  const agents = [
    { id: 'codex-agent', sessionId: 'socket:$1', home: '/worktrees/codex', worktreeId: 'codex', worktreeLabel: 'Codex tab', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 },
    { id: 'omx-agent', sessionId: 'socket:$2', home: '/worktrees/omx', worktreeId: 'omx', worktreeLabel: 'OMX tab', worktreeOrder: 2, title: 'Ready', kind: 'omx', attention: 'finished', queuedPromptCount: 0 },
    { id: 'claude-agent', sessionId: 'socket:$3', home: '/worktrees/claude', worktreeId: 'claude', worktreeLabel: 'Claude tab', worktreeOrder: 3, title: 'Ready', kind: 'claude', attention: 'finished', sandboxed: true, queuedPromptCount: 0 },
    { id: 'pi-agent', sessionId: 'socket:$4', home: '/worktrees/pi', worktreeId: 'pi', worktreeLabel: 'Pi tab', worktreeOrder: 4, title: 'Ready', kind: 'pi', attention: 'finished', queuedPromptCount: 0 },
    { id: 'opencode-agent', sessionId: 'socket:$5', home: '/worktrees/opencode', worktreeId: 'opencode', worktreeLabel: 'OpenCode tab', worktreeOrder: 5, title: 'Ready', kind: 'opencode', attention: 'finished', queuedPromptCount: 0 },
  ];
  const expectedTabs = [
    { label: 'Codex tab', glyph: '◆' },
    { label: 'OMX tab', glyph: '◈' },
    { label: 'Claude tab', glyph: '✳' },
    { label: 'Pi tab', glyph: 'π' },
    { label: 'OpenCode tab', glyph: '◇' },
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { generation: 1, adapters: { codex, claude }, agents, projects: [] });

  // verify both desktop and mobile layouts
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    // verify all five configured tab kinds; a phone's tab row holds only the current Workspace
    for (const expected of viewport.width > 768 ? expectedTabs : expectedTabs.slice(0, 1)) {
      const tab = page.getByRole('tab', { name: new RegExp(expected.label, 'u') });
      const badge = tab.locator('.launch-tab-badge');
      const mark = badge.locator('.launch-kind-mark');
      await expect(mark).toHaveText(expected.glyph);
      await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(mark).toHaveCSS('width', '20px');
      await expect(mark).toHaveCSS('height', '20px');
      await expect(mark).toHaveCSS('font-size', '20px');
      // a desktop tab keeps its glyphs tight; the phone's Workspace dropdown spaces them from its title
      await expect(tab).toHaveCSS('gap', viewport.width > 768 ? '4px' : '9.6px');
      await expect(badge).toHaveCSS('margin-right', '0px');
    }
  }

  // the phone's Workspace sheet shows every tab's glyph at the same full size
  await page.getByRole('tab', { selected: true }).click();
  for (const expected of expectedTabs) {
    const mark = page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(expected.label, 'u') }).locator('.launch-tab-badge .launch-kind-mark');
    await expect(mark).toHaveText(expected.glyph);
    await expect(mark).toHaveCSS('width', '20px');
    await expect(mark).toHaveCSS('font-size', '20px');
  }
  await page.keyboard.press('Escape');

  // keep the sandbox indicator beside its agent glyph
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('tab', { name: /Claude tab/u }).locator('.launch-tab-badge .launch-lock')).toBeVisible();
});

// Terminal and Empty workspace belong to the + rows only: the toolbar Launch, Restart as… and a
// failed pending launch's retry share the same menu without them.
test('the Place entries stay out of the launch menus the + rows share', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' }, { id: 'dora', label: 'Dora', path: '/worktrees/dora', order: 2 })] }], scratchLaunch: { kind: 'codex', origin: 'scratch' }, places: [{ id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch', pinned: false }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // a Scratch launch fails, leaving its pending tab to retry
    if (request.method() === 'POST' && url.pathname === '/api/agents/launch') return route.fulfill({ status: 500, json: { error: 'no tmux' } });
    if (request.method() === 'GET') return route.fulfill({ json: {} });
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const menu = page.locator('.launch-menu, .agent-power-menu');
  const placeEntries = menu.getByRole('menuitem', { name: /^(Terminal|Empty workspace)/u });

  // Restart as… on the Agent's power menu
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  await expect(menu.getByText('Restart · Cora')).toBeVisible();
  await expect(placeEntries).toHaveCount(0);
  await page.keyboard.press('Escape');

  // the agentless Worktree toolbar's Launch
  await page.getByRole('tab', { name: /^Dora —/u }).click();
  await page.locator('.workspace-toolbar').getByRole('button', { name: 'Choose agent' }).click();
  await expect(menu.getByText('Launch · Dora')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Claude(?! accounts)/u })).toBeVisible();
  await expect(placeEntries).toHaveCount(0);
  await page.locator('.workspace-toolbar').getByRole('button', { name: 'Choose agent' }).click();

  // a failed Scratch launch's retry
  await page.locator('.new-agent-tab').click();
  await page.locator('.launcher-row').filter({ hasText: 'Scratch' }).getByRole('button', { name: 'Launch ~ Scratch' }).click();
  await expect(page.getByText('Agent did not start')).toBeVisible();
  await page.locator('.workspace-toolbar').getByRole('button', { name: 'Choose agent' }).click();
  await expect(menu.getByText('Launch · Scratch')).toBeVisible();
  await expect(placeEntries).toHaveCount(0);
});

// a kind on Allowed models offers each for this launch only, at the Effort picked beside them
test('launches Pi on a chosen Allowed model and Effort, this launch only', async ({ page }) => {
  const pi = adapter('/usr/bin/node', { allowedModels: [{ model: 'openai/gpt-5.6', effort: 'medium' }, { model: 'openrouter/~anthropic/claude-opus-latest' }], efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });
  const posts = await mount(page, { generation: 1, adapters: { claude, pi }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Pi on a model — this launch only')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /openai\/gpt-5\.6/u })).toContainText('Effort medium');
  await menu.getByRole('combobox').selectOption('high');
  await menu.getByRole('menuitem', { name: /claude-opus-latest/u }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'pi', sandboxed: false, model: 'openrouter/~anthropic/claude-opus-latest', effort: 'high' } }]);
});
