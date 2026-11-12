import { expect, test, type Page, type Route } from '@playwright/test';

// build the configured transport capability
const adapter = (program: string, extra: Record<string, unknown> = {}, transport: 'tmux' | 'structured' = 'tmux') => {
  const structured = transport === 'structured';
  const capability = { launchable: true, program, stateSource: 'reported', turnCapture: structured, inlineQuestions: structured, commands: !structured, sandbox: structured, ...(structured ? { conversations: true, naming: true, steer: true } : {}), ...extra };
  return { ...capability, transport, transports: { [transport]: capability } };
};
const codex = adapter('/bin/codex', { stateSource: 'both', turnCapture: true });
const claude = adapter('/bin/claude');

type Dashboard = Record<string, unknown>;
type LaunchPost = { path: string; body: unknown };

// Mount the app against a stubbed dashboard, recording every launch-family POST body.
async function mount(page: Page, dashboard: Dashboard, options?: unknown, updates: unknown = { agents: [] }): Promise<LaunchPost[]> {
  const posts: LaunchPost[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (request.method() === 'GET' && url.pathname === '/api/agents/updates') return route.fulfill({ json: updates });
    // return target-specific semantic launch options when a scenario supplies them
    if (request.method() === 'POST' && url.pathname === '/api/launch/options') return options === undefined ? route.fulfill({ status: 503, json: { error: 'catalog unavailable' } }) : route.fulfill({ json: options });
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

// promote the remembered kind while leaving the remaining configured adapters in registry order
for (const origin of ['worktree', 'project', 'scratch', 'default']) {
  test(`puts the resolved ${origin} adapter first without an origin badge`, async ({ page }) => {
    const posts = await mount(page, { generation: 1, adapters: { codex, omx: adapter('/bin/omx'), claude, pi: adapter('/bin/pi', {}, 'structured'), opencode: adapter('/bin/opencode') }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'pi', origin })] }] });
    await toolbar(page).getByRole('button', { name: 'Choose agent', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Choose agent' });
    await expect(menu.locator('.launch-card-summary strong')).toHaveText(['Pi', 'Codex', 'OMX', 'Claude', 'OpenCode']);
    await expect(menu.locator('.launch-card-summary em')).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Launch Pi', exact: true }).click();
    await expect.poll(() => posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ kind: 'pi' });
  });
}

// avoid inventing a card when there is no configured remembered kind
for (const resolution of [{}, { kind: 'pi', origin: 'worktree' }]) {
  test(`retains registry order when the resolved adapter is ${'kind' in resolution ? 'unconfigured' : 'absent'}`, async ({ page }) => {
    await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree(resolution)] }] });
    await toolbar(page).getByRole('button', { name: 'Choose agent', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Choose agent' }).locator('.launch-card-summary strong')).toHaveText(['Codex', 'Claude']);
  });
}

// keep the remembered adapter first on the single-button phone chooser as well
test('mobile lists the last-used adapter first without a text badge', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, { generation: 1, adapters: { codex, omx: adapter('/bin/omx'), claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  await toolbar(page).getByRole('button', { name: 'Launch agent', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent' });
  await expect(menu.locator('.launch-card-summary strong')).toHaveText(['Claude', 'Codex', 'OMX']);
  await expect(menu).not.toContainText('last used here');
  await page.screenshot({ path: testInfo.outputPath('last-used-first-mobile.png'), fullPage: true });
});

test('launches the resolved kind in one click and lists every configured kind in the menu', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  const primary = toolbar(page).getByRole('button', { name: 'Launch Claude' });
  await expect(primary).toBeEnabled();
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(page.locator('body > .flyout-backdrop')).toHaveCount(1);
  await expect(menu.getByText('Launch · Cora')).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).locator('.launch-row')).toBeVisible();
  // the remembered kind leads the list without an inline origin badge
  await expect(menu.locator('.launch-agent-line').first()).toHaveAttribute('aria-label', 'Claude agent');
  await expect(menu.getByRole('group', { name: 'Claude agent' }).locator('.launch-card-summary')).not.toContainText('last used here');
  await menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true }).click();
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
  await expect(menu.locator('.launch-agent-line').first()).toHaveAttribute('aria-label', 'Claude agent');
  await expect(menu.getByRole('group', { name: 'Claude agent' }).locator('.launch-card-summary')).not.toContainText('last used here');
  // opening and dismissing the selector never starts an agent
  expect(posts).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(chooser).toHaveAttribute('aria-expanded', 'false');
  await chooser.click();
  await menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true }).click();
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
  await expect(page.locator('.launch-menu').getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
  expect(posts).toEqual([]);
  await page.mouse.click(4, 4);
  await expect(page.locator('.launch-menu')).toHaveCount(0);
  expect(posts).toEqual([]);

  // the empty card shares the phone chooser instead of launching immediately
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  const emptyLaunch = empty.getByRole('button', { name: 'Launch agent' });
  await expect(emptyLaunch).toBeVisible();
  await expect(empty.locator('.launch-menu-only button')).toHaveCount(1);
  await expect(emptyLaunch).toHaveAttribute('aria-haspopup', 'menu');
  await expect(empty.locator('.launch-primary, .launch-chevron')).toHaveCount(0);
  await emptyLaunch.click();
  expect(posts).toEqual([]);
  await page.getByRole('menu', { name: 'More workspace actions' }).getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true }).click();
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
  await page.locator('.launch-menu').getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true }).click();
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
  await expect(page.locator('.launch-menu').getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
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
  // both kinds remain available without generic sandbox descriptions
  await expect(menu.getByRole('group', { name: 'Codex agent' }).locator('.launch-row')).toBeVisible();
  const omxRow = menu.getByRole('menuitem', { name: 'Launch OMX', exact: true });
  await expect(menu.locator('.launch-agent-line').first()).toHaveAttribute('aria-label', 'OMX agent');
  await expect(menu.getByRole('group', { name: 'OMX agent' }).locator('.launch-card-summary')).not.toContainText('last used here');
  await expect(menu.getByText("Uses Codex's own sandbox", { exact: true })).toHaveCount(0);
  await omxRow.click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'omx', sandboxed: false } }]);
});

test('one click on the primary launches the resolved kind unsandboxed', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });
  await toolbar(page).getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

test('a sandbox-capable kind retains its primary lock without flyout noise and exposes a launch-only override', async ({ page }) => {
  // simulate the chunk-4 wire: a launchable Claude that reports a console-enforceable sandbox
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const options = { kinds: [{ kind: 'claude', optionsRevision: 'security-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable', message: 'Claude uses its native default.' }, security: { controls: [{ id: 'sandbox', label: 'Sandbox', icon: 'shield', options: [{ id: 'on', label: 'Sandbox on', risk: 'normal', detail: 'Sandbox enforced by console' }, { id: 'off', label: 'Sandbox off', risk: 'danger', detail: 'Sandbox disabled for this launch' }] }], defaults: { sandbox: 'on' }, constraints: [], status: 'ready' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] }, options);
  // the primary names the sandboxed default with a lock
  await expect(toolbar(page).getByRole('button', { name: 'Launch Claude' }).locator('.launch-lock')).toBeVisible();
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Sandbox enforced by console')).toHaveCount(0);
  await expect(menu.locator('.launch-lock')).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio', { name: /^Make .* default$/u })).toHaveCount(0);
  await expect(menu.getByText('Without sandbox — this launch only')).toHaveCount(0);
  // the security trigger replaces the duplicate without-sandbox row
  const claude = menu.getByRole('group', { name: 'Claude agent' });
  await claude.getByRole('button', { name: /^Claude security/u }).click();
  await menu.getByLabel('Sandbox off').check();
  await page.keyboard.press('Escape');
  await claude.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', model: { mode: 'native-default' }, security: { sandbox: 'off' }, optionsRevision: 'security-rev' } }]);
});

test('the primary launches a sandbox-capable kind sandboxed', async ({ page }) => {
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] });
  await toolbar(page).getByRole('button', { name: 'Launch Claude' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: true } }]);
});

test('an unavailable kind is disabled in the menu with its reason', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  const posts = await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const card = page.locator('.launch-menu').getByRole('group', { name: 'Claude agent' });
  const launch = card.getByRole('menuitem', { name: 'Launch Claude', exact: true });
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveAttribute('title', '/bin/claude is not executable');
  await expect(card.locator('.launch-card-summary')).toContainText('/bin/claude is not executable');
  await card.locator('.launch-card-summary').click();
  expect(posts).toEqual([]);
});

test('keeps the explicit Launch action disabled while launch options load', async ({ page }) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'loading-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'ready' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });
  await page.route('**/api/launch/options', async route => { await pending; await route.fulfill({ json: options }); });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const launch = page.getByRole('menu', { name: 'Choose agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true });
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveAttribute('title', 'Launch Codex');
  expect(posts).toEqual([]);
  release?.();
  await expect(launch).toBeEnabled();
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
  await expect(page.locator('.launch-menu').getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeDisabled();
});

test('an explicit deny-all model policy disables primary and card launch actions', async ({ page }) => {
  const denyAll = adapter('/bin/codex', { launchable: false, unavailableReason: 'No models are allowed for this Agent.', allowedModels: [] });
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'deny-all', modelPolicy: { state: 'empty', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'ready', message: 'No models are allowed for this Agent.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex: denyAll }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({})] }] }, options);

  await expect(page.locator('.workspace-toolbar-actions .launch-primary')).toBeDisabled();
  await page.locator('.workspace-toolbar-actions .launch-chevron').click();
  const card = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Codex agent' });
  await expect(card).toContainText('No models are allowed for this Agent.');
  await expect(card.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeDisabled();
  expect(posts).toEqual([]);
});

test('the configured fallback keeps deny-all launch actions disabled', async ({ page }) => {
  const denyAll = adapter('/bin/codex', { allowedModels: [] });
  const posts = await mount(page, { generation: 1, adapters: { codex: denyAll }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] });

  await expect(toolbar(page).getByRole('button', { name: 'Launch Codex' })).toBeDisabled();
  await page.locator('.workspace-toolbar-actions .launch-chevron').click();
  const card = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Codex agent' });
  await expect(page.getByText('catalog unavailable Showing configured fallback options.')).toBeVisible();
  await expect(card).toContainText('No models are allowed for this Agent.');
  await expect(card.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeDisabled();
  expect(posts).toEqual([]);
});

test('a remembered kind that is no longer launchable is skipped with a footnote', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default', skipped: { kind: 'claude', origin: 'worktree', reason: '/bin/claude is not executable' } })] }] });
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  await expect(page.locator('.launch-menu-note').filter({ hasText: 'Remembered Claude' })).toContainText('Remembered Claude (here) skipped — /bin/claude is not executable');
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
  await expect(choices.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeVisible();
  await expect(choices.getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
  await expect(choices.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/remoteagents-plus-chooser-desktop.png' });
  await choices.getByRole('menuitem', { name: 'Launch Codex', exact: true }).click();
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
test('mobile running worktrees keep agent choices through the workspace picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] });
  // the workspace picker remains an alternative way into the launcher
  await page.locator('.workspace-dropdown').click();
  await page.getByRole('button', { name: /New Workspace/u }).click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const open = launcher.getByRole('button', { name: 'Open Cora' });
  await expect(open).toBeVisible();
  await expect(open.locator('.launch-kind-mark')).toHaveCount(0);
  await open.locator('..').getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(choices.getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-plus-chooser-mobile.png' });
  await choices.getByRole('menuitem', { name: 'Launch Claude', exact: true }).click();
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
  await page.getByRole('menu', { name: 'More workspace actions' }).getByRole('menuitem', { name: 'Launch Claude', exact: true }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/launch', body: { kind: 'claude', sandboxed: false } }]);
});

// keep agent glyphs full-size and colored only in the persistent Launch chooser
test('the far-left Launch chooser owns every agent glyph and sandbox mark', async ({ page }) => {
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const adapters = { codex, omx: adapter('/bin/omx'), claude: sandboxedClaude, pi: adapter('/bin/pi', {}, 'structured'), opencode: adapter('/bin/opencode') };
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
    const mark = menu.getByRole('group', { name: `${kind.label} agent` }).locator('.launch-card-summary .launch-kind-mark');
    await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(mark).toHaveCSS('color', kind.color);
    await expect(mark).toHaveCSS('font-size', '18.4px');
  }
  await expect(menu.locator('.launch-lock')).toHaveCount(0);
});

// the launcher rows open the same anchored flyout every other Launch control opens: one
// fixed-width menu hung off the row, dismissed by a press anywhere outside it — including
// one inside the launcher, whose own backdrop only covers presses outside itself
test('a + row menu keeps agent states and workspace actions, then closes outside', async ({ page }) => {
  const unavailableCodex = adapter('/bin/codex', { launchable: false, unavailableReason: '/bin/codex is not executable' });
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { codex: unavailableCodex, claude: sandboxedClaude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }], scratchLaunch: { kind: 'claude', origin: 'scratch' } });
  await page.getByRole('button', { name: 'Launch agent' }).click();
  const launcher = page.locator('.launcher-menu');
  const menu = page.locator('.launch-menu');
  const row = launcher.locator('.launcher-row').filter({ hasText: 'Cora' });
  await row.getByRole('button', { name: 'More workspace actions' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeDisabled();
  await expect(menu.locator('.launch-agent-line').first()).toHaveAttribute('aria-label', 'Claude agent');
  await expect(menu.getByRole('group', { name: 'Claude agent' }).locator('.launch-card-summary')).not.toContainText('last used here');
  await expect(menu.getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
  await expect(menu.getByText('Sandbox enforced by console', { exact: true })).toHaveCount(0);
  await expect(menu.locator('.launch-lock')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /^Terminal/u })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Empty workspace/u })).toBeVisible();
  await expect(menu.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update')).toHaveCount(0);
  await expect(page.locator('body > .flyout-backdrop')).toHaveCount(2);
  const popupBounds = await menu.boundingBox();
  expect(popupBounds).not.toBeNull();
  const backgroundActions = [
    launcher.getByRole('button', { name: 'Other locations', exact: true }),
    launcher.getByRole('button', { name: 'Launch ~ Scratch', exact: true }),
    row.getByRole('button', { name: 'Launch Cora', exact: true }),
  ];
  let backgroundPoint: { x: number; y: number } | undefined;
  // choose a real launcher action whose center is outside the inner popup
  for (const action of backgroundActions) {
    const bounds = await action.boundingBox();
    if (bounds === null) continue;
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const insidePopup = point.x >= popupBounds!.x && point.x <= popupBounds!.x + popupBounds!.width && point.y >= popupBounds!.y && point.y <= popupBounds!.y + popupBounds!.height;
    if (!insidePopup) {
      backgroundPoint = point;
      break;
    }
  }
  expect(backgroundPoint, 'one background launcher action must sit outside the inner popup').toBeDefined();
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.classList.contains('flyout-backdrop') ?? false, backgroundPoint!)).toBe(true);
  await page.mouse.click(backgroundPoint!.x, backgroundPoint!.y);
  await expect(menu).toHaveCount(0);
  await expect(launcher).toBeVisible();
  expect(posts).toEqual([]);
  // reopening preserves the same mixed choice menu
  await row.getByRole('button', { name: 'More workspace actions' }).click();
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
});

test('an idle agent restarts as another kind from its power menu', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], projects: [] });
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  // the Launch menu opens as a second page within the power-menu flyout
  const menu = page.locator('.agent-power-menu');
  await expect(menu.getByText('Restart · Cora')).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Restart Claude', exact: true }).click();
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
  await expect(menu.getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeVisible();
  await expect(placeEntries).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // a failed Scratch launch's retry
  await page.locator('.new-agent-tab').click();
  await page.locator('.launcher-row').filter({ hasText: 'Scratch' }).getByRole('button', { name: 'Launch ~ Scratch' }).click();
  await expect(page.getByText('Agent did not start')).toBeVisible();
  await page.locator('.workspace-toolbar').getByRole('button', { name: 'Choose agent' }).click();
  await expect(menu.getByText('Launch · Scratch')).toBeVisible();
  await expect(placeEntries).toHaveCount(0);
});

// every Agent card owns transient target-specific model, Effort and security controls
test('launch card controls send semantic choices and reset when reopened', async ({ page }) => {
  const pi = adapter('/usr/bin/node', { allowedModels: [{ model: 'openai/gpt-5.6', effort: 'medium' }, { model: 'openrouter/~anthropic/claude-opus-latest' }], efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }, 'structured');
  const options = { kinds: [
    { kind: 'claude', optionsRevision: 'rev-1', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable', message: 'Claude uses its native default.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported', message: 'Uses Claude native security.' } },
    { kind: 'pi', optionsRevision: 'rev-1', modelPolicy: { state: 'explicit', allowed: [{ model: 'openai/gpt-5.6', effort: 'medium' }, { model: 'openrouter/~anthropic/claude-opus-latest' }], defaultSelection: { mode: 'model', id: 'openai/gpt-5.6' }, catalog: [{ id: 'openai/gpt-5.6', name: 'GPT 5.6', provider: 'OpenAI', efforts: ['low', 'medium'] }, { id: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus', provider: 'OpenRouter', efforts: ['low', 'high'] }], catalogStatus: 'ready' }, security: { controls: [{ id: 'sandbox', label: 'Sandbox', icon: 'shield', options: [{ id: 'on', label: 'Sandbox on', risk: 'normal', detail: 'Bounded worktree writes' }, { id: 'off', label: 'Sandbox off', risk: 'danger', detail: 'Native tools are unrestricted' }] }], defaults: { sandbox: 'on' }, constraints: [], status: 'ready' } }
  ] };
  const posts = await mount(page, { generation: 1, adapters: { claude, pi }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] }] }, options);
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Pi on a model — this launch only')).toHaveCount(0);
  await expect(menu.locator('.launch-model-trigger')).toHaveCount(2);
  await expect(menu.locator('.launch-security-trigger')).toHaveCount(2);
  const piCard = menu.getByRole('group', { name: 'Pi agent' });
  await piCard.getByRole('button', { name: /Pi model and Effort/u }).click();
  expect(posts).toEqual([]);
  let modelPanel = menu.getByRole('dialog', { name: 'Pi model and Effort', exact: true });
  await expect(modelPanel.getByPlaceholder('Search models')).toHaveCount(0);
  const back = modelPanel.getByRole('button', { name: /Back to agents/u });
  await expect(back).toHaveClass(/launch-submenu-back/u);
  await expect(modelPanel.locator(':scope > button').first()).toHaveText('‹ Back to agents');
  await expect(back).toBeFocused();
  await modelPanel.getByRole('radio', { name: /Claude Opus/u }).click();
  await expect(modelPanel).toBeVisible();
  await back.click();
  await expect(piCard.getByRole('button', { name: /Pi model and Effort: Claude Opus/u })).toBeFocused();
  // closing the containing picker discards the card draft
  await page.keyboard.press('Escape');
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  await expect(page.getByRole('group', { name: 'Pi agent' }).getByRole('button', { name: /Pi model and Effort: GPT 5\.6/u })).toBeVisible();
  const reopenedPi = menu.getByRole('group', { name: 'Pi agent' });
  await reopenedPi.getByRole('button', { name: /Pi model and Effort/u }).click();
  modelPanel = menu.getByRole('dialog', { name: 'Pi model and Effort', exact: true });
  await modelPanel.getByRole('radio', { name: /Claude Opus/u }).click();
  const effort = modelPanel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(modelPanel.locator('select')).toHaveCount(0);
  await effort.click();
  const effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await effortOptions.getByRole('option', { name: 'high', exact: true }).click();
  await expect(modelPanel).toBeVisible();
  await modelPanel.getByRole('button', { name: /Back to agents/u }).click();
  await reopenedPi.getByRole('button', { name: /Pi model and Effort/u }).click();
  await expect(menu.getByRole('dialog', { name: 'Pi model and Effort', exact: true }).getByRole('combobox', { name: 'Effort' })).toContainText('high');
  await menu.getByRole('dialog', { name: 'Pi model and Effort', exact: true }).getByRole('button', { name: /Back to agents/u }).click();
  await reopenedPi.getByRole('button', { name: /^Pi security/u }).click();
  await menu.getByLabel('Sandbox off').check();
  await page.keyboard.press('Escape');
  expect(posts).toEqual([]);
  await reopenedPi.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'pi', model: { mode: 'model', id: 'openrouter/~anthropic/claude-opus-latest' }, effort: { mode: 'effort', id: 'high' }, security: { sandbox: 'off' }, optionsRevision: 'rev-1' } }]);
});

test('shows model search only above five allowed models and preserves drafts through Back', async ({ page }) => {
  const five = Array.from({ length: 5 }, (_, index) => ({ id: `codex-${index}`, name: `Codex Model ${index}`, efforts: ['low', 'high'] }));
  const six = Array.from({ length: 6 }, (_, index) => ({ id: `pi-${index}`, name: `Pi Model ${index}`, efforts: ['low', 'high'] }));
  const policy = (catalog: typeof five) => ({ state: 'explicit', allowed: catalog.map(model => ({ model: model.id })), defaultSelection: { mode: 'model', id: catalog[0]!.id }, catalog, catalogStatus: 'ready' });
  const unsupportedSecurity = { controls: [], defaults: {}, constraints: [], status: 'unsupported' };
  const options = { kinds: [
    { kind: 'codex', optionsRevision: 'five-models', modelPolicy: policy(five), security: unsupportedSecurity },
    { kind: 'pi', optionsRevision: 'six-models', modelPolicy: policy(six), security: unsupportedSecurity }
  ] };
  const pi = adapter('/usr/bin/node', {}, 'structured');
  await mount(page, { generation: 1, adapters: { codex, pi }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent' });
  const codexCard = menu.getByRole('group', { name: 'Codex agent' });
  const codexTrigger = codexCard.getByRole('button', { name: /Codex model and Effort/u });
  await codexTrigger.click();
  let panel = menu.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  const codexBack = panel.getByRole('button', { name: /Back to agents/u });
  await expect(panel.getByPlaceholder('Search models')).toHaveCount(0);
  await expect(codexBack).toBeFocused();
  await panel.getByRole('radio', { name: /Codex Model 4/u }).click();
  await expect(panel).toBeVisible();
  const effort = panel.getByRole('combobox', { name: 'Effort', exact: true });
  await effort.click();
  await page.getByRole('listbox', { name: 'Effort options', exact: true }).getByRole('option', { name: 'high', exact: true }).click();
  await codexBack.click();
  await expect(codexTrigger).toBeFocused();
  await expect(codexTrigger).toContainText('Codex Model 4');
  await codexTrigger.click();
  panel = menu.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Effort' })).toContainText('high');
  await panel.getByRole('button', { name: /Back to agents/u }).click();

  const piCard = menu.getByRole('group', { name: 'Pi agent' });
  const piTrigger = piCard.getByRole('button', { name: /Pi model and Effort/u });
  await piTrigger.click();
  panel = menu.getByRole('dialog', { name: 'Pi model and Effort', exact: true });
  const search = panel.getByPlaceholder('Search models');
  await expect(search).toBeFocused();
  await search.fill('Pi Model 5');
  await expect(panel.getByRole('radio')).toHaveCount(1);
  await panel.getByRole('radio', { name: /Pi Model 5/u }).click();
  await expect(panel).toBeVisible();
  await expect(search).toHaveValue('Pi Model 5');
  await expect(panel.getByRole('radio')).toHaveCount(1);
  await panel.getByRole('button', { name: /Back to agents/u }).click();
  await expect(piTrigger).toBeFocused();
  await expect(piTrigger).toContainText('Pi Model 5');
});

// preserve current-model Effort when a restart card was not edited
test('an untouched same-kind restart omits Effort from its keep-current choice', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'restart-rev', modelPolicy: { state: 'explicit', allowed: [{ model: 'gpt-current', effort: 'low' }], defaultSelection: { mode: 'keep-current' }, currentModel: 'gpt-current', currentEffort: 'high', effortDefaults: { 'gpt-current': 'low' }, catalog: [{ id: 'gpt-current', name: 'GPT Current', efforts: ['low', 'high'], defaultEffort: 'low' }], catalogStatus: 'ready', message: 'Keep current gpt-current model.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported', message: 'Uses Codex native security.' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [agent], projects: [] }, options);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  const card = page.locator('.agent-power-menu').getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  const panel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  const effort = panel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toContainText('high');
  await effort.click();
  const effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(effortOptions.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(effortOptions.getByRole('option', { name: 'Model default', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await panel.getByRole('radio', { name: /GPT Current/u }).click();
  await expect(panel).toBeVisible();
  await expect(effort).toContainText('low');
  await panel.getByRole('radio', { name: /Keep current gpt-current model/u }).click();
  await expect(effort).toContainText('high');
  await panel.getByRole('button', { name: /Back to agents/u }).click();
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/agent-1/restart', body: { kind: 'codex', model: { mode: 'keep-current' }, optionsRevision: 'restart-rev' } }]);
});

// resolve old keep-current labels by exact identity rather than a matching model prefix
test('legacy restart metadata selects the exact model effort without prefix collisions', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'legacy-effort', modelPolicy: { state: 'explicit', allowed: [{ model: 'gpt-5' }, { model: 'gpt-5.1' }], defaultSelection: { mode: 'keep-current' }, catalog: [{ id: 'gpt-5', name: 'GPT 5', efforts: ['low'], defaultEffort: 'low' }, { id: 'gpt-5.1', name: 'GPT 5.1', efforts: ['medium', 'high'], defaultEffort: 'high' }], catalogStatus: 'ready', message: 'Keep current — gpt-5.1. Catalog status follows.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported' } }] };
  await mount(page, { generation: 1, adapters: { codex }, agents: [agent], projects: [] }, options);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  await page.locator('.agent-power-menu').getByRole('button', { name: /Codex model and Effort/u }).click();
  const effort = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true }).getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toContainText('high');
  await effort.click();
  const levels = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(levels.getByRole('option')).toHaveText(['medium', 'high']);
  await expect(levels.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('aria-selected', 'true');
});

// distinguish untouched and explicit Effort while keeping exact model policies selectable
test('exact native policies show configured Effort and send it only after an explicit choice', async ({ page }, testInfo) => {
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'exact-rev', modelPolicy: { state: 'native-default', allowed: [{ model: 'gpt-a', effort: 'low' }, { model: 'gpt-b', effort: 'low' }], defaultSelection: { mode: 'model', id: 'gpt-a' }, effortDefaults: { 'gpt-b': 'high' }, catalog: [{ id: 'gpt-a', name: 'GPT A', efforts: ['low', 'high'], defaultEffort: 'high' }, { id: 'gpt-b', name: 'GPT B', efforts: ['low', 'high'], defaultEffort: 'low' }], catalogStatus: 'ready' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported', message: 'Uses Codex native security.' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  const chooser = toolbar(page).getByRole('button', { name: 'Choose agent' });

  // the allowed-model default wins over conflicting catalog metadata
  await chooser.click();
  let card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  let modelPanel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  let effort = modelPanel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(page.getByRole('radio', { name: 'Native default' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /GPT A/u })).toBeVisible();
  await expect(effort).toContainText('low');
  await expect(modelPanel.locator('select')).toHaveCount(0);
  await expect(modelPanel.getByRole('switch', { name: 'Effort', exact: true })).toHaveCount(0);
  await effort.click();
  let effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(effortOptions.getByRole('option')).toHaveCount(2);
  await expect(effortOptions.getByRole('option', { name: 'low', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(effortOptions.getByRole('option', { name: 'Model default', exact: true })).toHaveCount(0);
  // short selected values must not clip the other supported Effort labels
  expect(await effortOptions.locator('.settings-select-option-label').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('configured-effort-selected.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await modelPanel.getByRole('button', { name: /Back to agents/u }).click();
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'model', id: 'gpt-a' }, optionsRevision: 'exact-rev' } }]);
  // reset the mocked launch handoff before starting another independent draft
  await page.reload();

  // closing the whole chooser discards an explicit override
  await chooser.click();
  card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  modelPanel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  effort = modelPanel.getByRole('combobox', { name: 'Effort', exact: true });
  await effort.click();
  await page.getByRole('listbox', { name: 'Effort options', exact: true }).getByRole('option', { name: 'high', exact: true }).click();
  await modelPanel.getByRole('button', { name: /Back to agents/u }).click();
  await page.keyboard.press('Escape');
  await chooser.click();
  card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  modelPanel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  effort = modelPanel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toContainText('low');

  // model changes reset overrides to the authoritative per-model default
  await modelPanel.getByRole('radio', { name: /GPT B/u }).click();
  await expect(modelPanel).toBeVisible();
  await expect(effort).toContainText('high');
  await effort.click();
  await page.getByRole('listbox', { name: 'Effort options', exact: true }).getByRole('option', { name: 'low', exact: true }).click();
  await modelPanel.getByRole('radio', { name: /GPT A/u }).click();
  await expect(effort).toContainText('low');
  await modelPanel.getByRole('radio', { name: /GPT B/u }).click();
  await expect(effort).toContainText('high');
  await modelPanel.getByRole('button', { name: /Back to agents/u }).click();
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toHaveLength(2);
  expect(posts[1]).toEqual({ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'model', id: 'gpt-b' }, optionsRevision: 'exact-rev' } });
  // the fixture does not publish a launched agent into its static dashboard
  await page.reload();

  // explicitly returning to the configured value remains an authored choice
  await chooser.click();
  card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  modelPanel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  effort = modelPanel.getByRole('combobox', { name: 'Effort', exact: true });
  await effort.press('End');
  effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(effortOptions.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('data-active', 'true');
  await effort.press('Enter');
  await expect(effort).toContainText('high');
  await effort.press('Home');
  effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(effortOptions.getByRole('option', { name: 'low', exact: true })).toHaveAttribute('data-active', 'true');
  await expect(effortOptions.getByRole('option', { name: 'Model default', exact: true })).toHaveCount(0);
  await effort.press('Enter');
  await expect(effort).toContainText('low');
  await modelPanel.getByRole('button', { name: /Back to agents/u }).click();
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toHaveLength(3);
  expect(posts[2]).toEqual({ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'model', id: 'gpt-a' }, effort: { mode: 'effort', id: 'low' }, optionsRevision: 'exact-rev' } });
});

test('Effort shows honest placeholders when no configured value or levels are available', async ({ page }) => {
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'effort-placeholders', modelPolicy: { state: 'explicit', allowed: [{ model: 'gpt-unknown' }, { model: 'gpt-catalog' }, { model: 'gpt-no-levels' }], defaultSelection: { mode: 'model', id: 'gpt-unknown' }, catalog: [{ id: 'gpt-unknown', name: 'GPT Unknown', efforts: ['low', 'high'], defaultEffort: 'max' }, { id: 'gpt-catalog', name: 'GPT Catalog', efforts: ['low', 'high'], defaultEffort: 'high' }, { id: 'gpt-no-levels', name: 'GPT No Levels', efforts: [] }], catalogStatus: 'ready' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  await toolbar(page).getByRole('button', { name: 'Choose agent' }).click();
  const card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /Codex model and Effort/u }).click();
  const panel = page.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  let effort = panel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toContainText('Select effort');
  await effort.click();
  const effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
  await expect(effortOptions.getByRole('option')).toHaveCount(2);
  await expect(effortOptions.getByRole('option', { name: 'Select effort', exact: true })).toHaveCount(0);
  await expect(effortOptions.getByRole('option', { selected: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await panel.getByRole('radio', { name: /GPT Catalog/u }).click();
  await expect(effort).toContainText('high');
  await panel.getByRole('radio', { name: /GPT No Levels/u }).click();
  await expect(panel).toBeVisible();
  effort = panel.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toBeDisabled();
  await expect(effort).toContainText('Unavailable');
  await panel.getByRole('radio', { name: /GPT Unknown/u }).click();
  await expect(effort).toBeEnabled();
  await expect(effort).toContainText('Select effort');
  await panel.getByRole('button', { name: /Back to agents/u }).click();
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'model', id: 'gpt-unknown' }, optionsRevision: 'effort-placeholders' } }]);
});

// activated bypass constraints restore every disabled security axis
test('security constraints reset earlier axes and prevent conflicting later choices', async ({ page }) => {
  const controls = [
    { id: 'filesystem', label: 'Filesystem', icon: 'file', options: [{ id: 'inherit', label: 'Configured filesystem', risk: 'normal', detail: 'Use configured sandbox' }, { id: 'read-only', label: 'Read only', risk: 'normal', detail: 'Allow reads only' }] },
    { id: 'approvals', label: 'Approvals', icon: 'hand', options: [{ id: 'inherit', label: 'Configured approvals', risk: 'normal', detail: 'Use configured approvals' }, { id: 'never', label: 'Never prompt', risk: 'danger', detail: 'Never request approval' }] },
    { id: 'bypass', label: 'Bypass', icon: 'warning', options: [{ id: 'inherit', label: 'Keep separate', risk: 'normal', detail: 'Keep controls separate' }, { id: 'dangerous', label: 'Dangerous bypass', risk: 'danger', detail: 'Bypass both controls' }] },
  ];
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'constraints-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable' }, security: { controls, defaults: { filesystem: 'inherit', approvals: 'inherit', bypass: 'inherit' }, constraints: [{ when: { bypass: 'dangerous' }, disables: ['filesystem', 'approvals'], message: 'Dangerous bypass replaces filesystem and approval controls.' }], status: 'ready' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  const chooser = toolbar(page).getByRole('button', { name: 'Choose agent' });

  // bypass after axis edits resets both conflicts
  await chooser.click();
  let card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /^Codex security/u }).click();
  await page.getByLabel('Read only').check();
  await page.getByLabel('Never prompt').check();
  await page.getByLabel('Dangerous bypass').check();
  await expect(page.getByLabel('Configured filesystem')).toBeChecked();
  await expect(page.getByLabel('Configured approvals')).toBeChecked();
  await page.keyboard.press('Escape');
  await card.locator('.launch-card-action').click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'native-default' }, security: { filesystem: 'inherit', approvals: 'inherit', bypass: 'dangerous' }, optionsRevision: 'constraints-rev' } }]);
  await page.reload();

  // bypass first disables later conflicting edits
  await chooser.click();
  card = page.getByRole('group', { name: 'Codex agent' });
  await card.getByRole('button', { name: /^Codex security/u }).click();
  await page.getByLabel('Dangerous bypass').check();
  await expect(page.getByLabel('Read only')).toBeDisabled();
  await expect(page.getByLabel('Never prompt')).toBeDisabled();
  await expect(page.getByLabel('Configured filesystem')).toBeChecked();
  await expect(page.getByLabel('Configured approvals')).toBeChecked();
});

test('mobile launch-card management actions do not overlap and security traps focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'mobile-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable', message: 'Codex uses its native default.' }, security: { controls: [{ id: 'approval', label: 'Approvals', icon: 'hand', options: [{ id: 'ask', label: 'Ask first', risk: 'normal', detail: 'Ask before tool actions' }, { id: 'never', label: 'Never ask', risk: 'warning', detail: 'Run allowed tool actions directly' }] }], defaults: { approval: 'ask' }, constraints: [], status: 'ready' } }] };
  await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  await toolbar(page).getByRole('button', { name: 'Launch agent' }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent' });
  const card = menu.getByRole('group', { name: 'Codex agent' });
  await expect(card.getByRole('menuitem', { name: 'Codex accounts' })).toBeVisible();
  await expect(card.getByRole('menuitemradio', { name: 'Make Codex default' })).toHaveCount(0);
  const account = card.getByRole('menuitem', { name: 'Codex accounts' });
  await expect(account).toHaveText('');
  await expect(account.locator('.launch-account-icon')).toHaveCount(1);
  const boxes = await card.locator('.launch-card-controls > button').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; }));
  // every adjacent control keeps its own hit area
  for (let index = 1; index < boxes.length; index++) expect(boxes[index - 1]!.right <= boxes[index]!.left).toBe(true);
  expect(boxes[1]!.width).toBe(boxes[1]!.height);
  expect(boxes[2]!.width).toBe(boxes[1]!.width);
  expect(boxes[2]!.height).toBe(boxes[1]!.height);
  expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const security = card.getByRole('button', { name: /^Codex security/u });
  await security.focus();
  await page.keyboard.press('Enter');
  const securityDialog = menu.getByRole('dialog', { name: 'Codex security' });
  await expect(security.locator('.flyout-caret')).toHaveCount(1);
  const backdrop = menu.locator('.launch-card-backdrop');
  await expect(backdrop).toHaveJSProperty('tagName', 'DIV');
  await expect(backdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(securityDialog.getByLabel('Ask first')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(securityDialog.getByLabel('Never ask')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(securityDialog).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(security).toBeFocused();
});

// management controls use one full-width compact rail at every supported width
for (const width of [1280, 390, 208]) {
  test(`launch-card rail ends with an explicit action without overflow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const options = { kinds: [{ kind: 'codex', optionsRevision: 'rail-rev', modelPolicy: { state: 'explicit', allowed: [{ model: 'gpt-a' }], defaultSelection: { mode: 'model', id: 'gpt-a' }, catalog: [{ id: 'gpt-a', name: 'GPT A', efforts: ['low', 'high'] }], catalogStatus: 'ready' }, security: { controls: [{ id: 'approval', label: 'Approvals', icon: 'hand', options: [{ id: 'ask', label: 'Ask first', risk: 'normal', detail: 'Ask before tool actions' }] }], defaults: { approval: 'ask' }, constraints: [], status: 'ready' } }] };
    const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options, { agents: [{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }] });
    await toolbar(page).getByRole('button', { name: width > 700 ? /^Choose agent/u : /^Launch agent/u }).click();
    const card = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Codex agent' });
    const controls = card.locator('.launch-card-controls');
    const summary = card.locator('.launch-card-summary');
    const launchAction = controls.getByRole('menuitem', { name: 'Launch Codex', exact: true });
    await expect(card.getByRole('menuitem', { name: 'Update Codex to 1.1.0', exact: true })).toHaveAttribute('title', 'Update Codex to 1.1.0');
    const labels = await controls.locator(':scope > button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
    expect(labels).toEqual(['Codex model and Effort: GPT A', 'Update Codex to 1.1.0', 'Codex accounts', 'Codex security', 'Launch Codex']);
    await expect(controls.locator(':scope > button').last()).toHaveClass(/launch-card-launch/u);
    await expect(launchAction).toHaveAttribute('title', 'Launch Codex');
    await expect(launchAction).toHaveCSS('background-image', /linear-gradient/u);
    const boxes = await controls.locator(':scope > button').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, height: box.height }; }));
    // update, accounts and security share the standard icon hit area
    for (const index of [1, 2, 3]) {
      expect(boxes[index]!.width).toBeCloseTo(boxes[1]!.width, 1);
      expect(boxes[index]!.height).toBeCloseTo(boxes[1]!.height, 1);
      expect(boxes[index]!.width).toBeCloseTo(boxes[index]!.height, 1);
    }
    expect(boxes[0]!.width).toBeGreaterThan(width === 208 ? 20 : boxes[1]!.width);
    const railBounds = await controls.boundingBox();
    const cardBounds = await card.boundingBox();
    const headerBounds = await summary.boundingBox();
    expect(railBounds).not.toBeNull();
    expect(cardBounds).not.toBeNull();
    expect(headerBounds).not.toBeNull();
    await expect(summary).toHaveJSProperty('tagName', 'DIV');
    await expect(summary).not.toHaveAttribute('role');
    expect(railBounds!.x).toBeLessThanOrEqual(cardBounds!.x + 6);
    expect(railBounds!.x + railBounds!.width).toBeGreaterThanOrEqual(cardBounds!.x + cardBounds!.width - 6);
    expect(headerBounds!.y + headerBounds!.height).toBeLessThanOrEqual(railBounds!.y + 1);
    expect(cardBounds!.height).toBeLessThan(width === 208 ? 120 : 76);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await summary.locator('strong').click();
    await summary.locator('.launch-agent-details').click();
    await summary.click({ position: { x: Math.max(1, headerBounds!.width - 2), y: Math.max(1, headerBounds!.height - 2) } });
    expect(posts).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`launch-card-${width}.png`), fullPage: true });
    await launchAction.click();
    await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', model: { mode: 'model', id: 'gpt-a' }, optionsRevision: 'rail-rev' } }]);
  });
}

// restart cards share the same compact rail inside the power menu
test('restart-as card ends with an explicit Restart action at 208px', async ({ page }) => {
  await page.setViewportSize({ width: 208, height: 844 });
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'restart-rail-rev', modelPolicy: { state: 'explicit', allowed: [{ model: 'gpt-a' }], defaultSelection: { mode: 'keep-current' }, catalog: [{ id: 'gpt-a', name: 'GPT A', efforts: ['low', 'high'] }], catalogStatus: 'ready', message: 'Keep the current Codex model.' }, security: { controls: [{ id: 'approval', label: 'Approvals', icon: 'hand', options: [{ id: 'ask', label: 'Ask first', risk: 'normal', detail: 'Ask before tool actions' }] }], defaults: { approval: 'ask' }, constraints: [], status: 'ready' } }] };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [agent], projects: [] }, options);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  const menu = page.locator('.agent-power-menu');
  const card = menu.getByRole('group', { name: 'Codex agent' });
  const controls = card.locator('.launch-card-controls');
  const labels = await controls.locator(':scope > button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(labels).toEqual(['Codex model and Effort: Keep current', 'Codex security', 'Restart Codex']);
  const boxes = await controls.locator(':scope > button').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, height: box.height }; }));
  expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width);
  expect(boxes[1]!.width).toBeCloseTo(boxes[1]!.height, 1);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const restart = card.getByRole('menuitem', { name: 'Restart Codex', exact: true });
  await expect(restart).toHaveAttribute('title', 'Restart Codex');
  await expect(restart).toHaveClass(/launch-card-launch/u);
  const security = card.getByRole('button', { name: 'Codex security' });
  await security.click();
  const dialog = menu.getByRole('dialog', { name: 'Codex security' });
  await expect(dialog.getByLabel('Ask first')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(security).toBeFocused();
  await restart.click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/agent-1/restart', body: { kind: 'codex', model: { mode: 'keep-current' }, optionsRevision: 'restart-rail-rev' } }]);
});

// pinned Pi versions offer a local dependency-change prompt
test('shows the bundled Pi prompt icon only for an available release', async ({ page }) => {
  const pi = adapter('/bin/pi', {}, 'structured');
  const options = { kinds: [{ kind: 'pi', optionsRevision: 'pi-update-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable', message: 'Pi uses its native default.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported', message: 'Pi uses configured security.' } }] };
  await mount(page, { generation: 1, adapters: { pi }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'pi', origin: 'worktree' })] }] }, options, { agents: [{ kind: 'pi', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, pinned: true }] });
  await toolbar(page).getByRole('button', { name: /^Choose agent/u }).click();
  const card = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Pi agent' });
  const update = card.getByRole('menuitem', { name: 'Update Pi to 1.1.0', exact: true });
  await expect(update).toHaveAttribute('title', 'Pi is bundled in RAC. Create a local pin-update prompt.');
  await expect(update.locator('.launch-update-icon')).toBeVisible();
});

test('hides the bundled Pi prompt icon when its npm release is current', async ({ page }) => {
  const pi = adapter('/bin/pi', {}, 'structured');
  const options = { kinds: [{ kind: 'pi', optionsRevision: 'pi-current-rev', modelPolicy: { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: [], catalogStatus: 'unavailable', message: 'Pi uses its native default.' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported', message: 'Pi uses configured security.' } }] };
  await mount(page, { generation: 1, adapters: { pi }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'pi', origin: 'worktree' })] }] }, options, { agents: [{ kind: 'pi', currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false, pinned: true }] });
  await toolbar(page).getByRole('button', { name: /^Choose agent/u }).click();
  const card = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Pi agent' });
  await expect(card.getByRole('menuitem', { name: /^Update Pi/u })).toHaveCount(0);
});

// keep nested selectors painted above scrollable chooser bounds on every layout
for (const width of [1280, 390]) {
  test(`nested launch menus stay visible and transparent outside at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const models = Array.from({ length: 6 }, (_, index) => ({ id: `gpt-${index}`, name: `Model ${index}`, efforts: ['low', 'high'] }));
    const options = { kinds: [{ kind: 'codex', optionsRevision: 'position-rev', modelPolicy: { state: 'explicit', allowed: models.map(model => ({ model: model.id })), defaultSelection: { mode: 'model', id: 'gpt-0' }, catalog: models, catalogStatus: 'ready' }, security: { controls: [{ id: 'approval', label: 'Approvals', icon: 'hand', options: [{ id: 'ask', label: 'Ask first', risk: 'normal', detail: 'Ask before tool actions' }, { id: 'never', label: 'Never ask', risk: 'warning', detail: 'Run allowed actions directly' }] }], defaults: { approval: 'ask' }, constraints: [], status: 'ready' } }] };
    const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] }] }, options);
    await toolbar(page).getByRole('button', { name: width === 390 ? 'Launch agent' : 'Choose agent', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Choose agent' });
    const card = menu.getByRole('group', { name: 'Codex agent' });
    // both panels escape the parent scroll box without creating a second chooser
    for (const name of ['model and Effort', 'security']) {
      const trigger = card.getByRole('button', { name: new RegExp(`^Codex ${name}`, 'u') });
      await trigger.click();
      const dialog = menu.getByRole('dialog', { name: `Codex ${name}`, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS('position', 'fixed');
      // delayed viewport placement must not steal initial keyboard focus
      if (name === 'model and Effort') await expect(dialog.getByPlaceholder('Search models')).toBeFocused();
      else await expect(dialog.getByLabel('Ask first')).toBeFocused();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(7);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 7);
      expect(bounds!.y).toBeGreaterThanOrEqual(7);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(893);
      // align to the model button itself rather than the surrounding control rail
      if (name === 'model and Effort') {
        const triggerBounds = await trigger.boundingBox();
        expect(triggerBounds).not.toBeNull();
        expect(bounds!.x).toBeCloseTo(Math.max(8, Math.min(triggerBounds!.x, width - bounds!.width - 8)), 1);
      }
      // bounding rectangles alone cannot prove the bottom escaped ancestor clipping
      expect(await dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 8));
      })).toBe(true);
      // the custom Effort menu portals above the model panel without dismissing it
      if (name === 'model and Effort') {
        const effort = dialog.getByRole('combobox', { name: 'Effort', exact: true });
        await effort.click();
        const effortOptions = page.getByRole('listbox', { name: 'Effort options', exact: true });
        await expect(effortOptions).toBeVisible();
        await expect(effortOptions).toHaveCSS('position', 'fixed');
        expect(await effortOptions.evaluate(element => element.parentElement === document.body)).toBe(true);
        const effortBounds = await effortOptions.boundingBox();
        expect(effortBounds).not.toBeNull();
        expect(effortBounds!.x).toBeGreaterThanOrEqual(7);
        expect(effortBounds!.x + effortBounds!.width).toBeLessThanOrEqual(width - 7);
        expect(await effortOptions.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        })).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`effort-menu-${width}.png`), fullPage: true });
        await page.keyboard.press('Escape');
        await expect(effortOptions).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(effort).toBeFocused();
      }
      const backdrop = menu.locator('.launch-card-backdrop');
      await expect(backdrop).toHaveJSProperty('tagName', 'DIV');
      await page.mouse.move(width - 3, 3);
      await expect(backdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await page.mouse.click(width - 3, 3);
      await expect(dialog).toHaveCount(0);
      await expect(menu).toBeVisible();
      await expect(trigger).toBeFocused();
      // escape dismisses only the active nested dialog
      await trigger.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(menu).toBeVisible();
      await expect(trigger).toBeFocused();
    }
    expect(posts).toEqual([]);
  });
}

// chooser width follows its selected label instead of a reserved desktop width
test('agent flyouts size to content and keep model labels left aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const longLabel = 'A deliberately longer model label for the current launch';
  const options = { kinds: [{ kind: 'codex', optionsRevision: 'content-size-rev', modelPolicy: { state: 'explicit', allowed: [{ model: 'short' }, { model: 'long' }], defaultSelection: { mode: 'model', id: 'short' }, catalog: [{ id: 'short', name: 'Short', efforts: [] }, { id: 'long', name: longLabel, provider: 'LongProvider'.repeat(14), efforts: [] }], catalogStatus: 'ready' }, security: { controls: [], defaults: {}, constraints: [], status: 'unsupported' } }] };
  await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [pinnedWorktree({ kind: 'codex', origin: 'worktree' })] }] }, options);
  await toolbar(page).getByRole('button', { name: 'Choose agent', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent' });
  const card = menu.getByRole('group', { name: 'Codex agent' });
  let model = card.getByRole('button', { name: 'Codex model and Effort: Short', exact: true });
  await expect(model).toBeVisible();
  await expect(model).toHaveCSS('justify-content', 'flex-start');
  await expect(model.locator('span')).toHaveCSS('text-align', 'left');
  await expect(model).toHaveCSS('font-size', '12px');
  await expect(card.locator('.launch-row-copy strong')).toHaveCSS('font-size', '13.12px');
  const shortBounds = await menu.boundingBox();
  expect(shortBounds).not.toBeNull();
  expect(await menu.evaluate(element => element.style.width)).toBe('max-content');
  await model.click();
  const picker = menu.getByRole('dialog', { name: 'Codex model and Effort', exact: true });
  expect(await picker.evaluate(element => element.style.width)).toBe('max-content');
  await picker.getByRole('radio', { name: new RegExp(longLabel, 'u') }).click();
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Back to agents/u }).click();
  model = card.getByRole('button', { name: `Codex model and Effort: ${longLabel}`, exact: true });
  await expect(model).toBeFocused();
  // resize observation must respond when a selected label changes intrinsic width
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(shortBounds!.width + 30);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await menu.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(374);
  const narrowBounds = await menu.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.x).toBeGreaterThanOrEqual(7);
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(383);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  // responsive chooser replacement starts a new transient card draft
  model = card.getByRole('button', { name: /^Codex model and Effort:/u });
  await expect(model).toHaveCSS('justify-content', 'flex-start');
  await model.click();
  // long provider identifiers wrap within the viewport-sized intrinsic grid
  await expect(picker).toBeVisible();
  expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  // shift wide model menus only as far as the viewport boundary requires
  const pickerBounds = await picker.boundingBox();
  const modelBounds = await model.boundingBox();
  expect(pickerBounds).not.toBeNull();
  expect(modelBounds).not.toBeNull();
  expect(pickerBounds!.x).toBeCloseTo(Math.max(8, Math.min(modelBounds!.x, 390 - pickerBounds!.width - 8)), 1);
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
});
