import { expect, test, type Page } from '@playwright/test';
import { mockAccountSocket, openCodexAccounts } from './account-fixture';

type Spend = { status: 'available'; todayUsd: number; weekUsd: number; asOf: number } | { status: 'unconfigured' | 'unavailable' };
type Account = {
  id: string;
  label: string;
  active: boolean;
  authMode?: 'apikey';
  spend?: Spend;
  email?: string;
  planType?: string;
  primary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
  secondary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
  resetCount?: number;
  error?: string;
};
type RenameFailure = 'http' | 'network';

// allow first-load compilation on shared CI hosts
test.describe.configure({ timeout: 180_000 });

// create one isolated settings backend
async function setupAccountSettings(page: Page, initialAccounts: Account[], renameFailures: RenameFailure[] = []) {
  const state = {
    accounts: structuredClone(initialAccounts),
    accountQueries: 0,
    patches: [] as Array<{ id: string; body: unknown; csrf: string }>,
    renameFailures: [...renameFailures],
  };
  // keep fixture sockets connected without a real backend
  await mockAccountSocket(page);
  // provide only synthetic local responses
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'account-settings-csrf', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // expose configured Codex without live agents
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'codex', origin: 'default' }, cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // authorize the inert dashboard socket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // avoid unrelated update indicators
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // reload the server-owned labels whenever settings opens
    if (path === '/api/codex/accounts' && request.method() === 'GET') {
      state.accountQueries += 1;
      return route.fulfill({ json: { accounts: state.accounts } });
    }
    const renameMatch = path.match(/^\/api\/codex\/accounts\/([^/]+)$/u);
    // handle one account-label update
    if (renameMatch !== null && request.method() === 'PATCH') {
      const id = decodeURIComponent(renameMatch[1]);
      const body = request.postDataJSON() as { label?: unknown };
      state.patches.push({ id, body, csrf: request.headers()['x-csrf-token'] ?? '' });
      const failure = state.renameFailures.shift();
      // return one controlled HTTP failure
      if (failure === 'http') return route.fulfill({ status: 503, json: { error: 'Rename denied.' } });
      // simulate one lost transport
      if (failure === 'network') return route.abort('failed');
      const account = state.accounts.find(candidate => candidate.id === id);
      // reject fixture mistakes explicitly
      if (account === undefined || typeof body.label !== 'string') return route.fulfill({ status: 404, json: { error: 'Account unavailable.' } });
      account.label = body.label;
      // invert selection to prove the client merges only the returned label
      return route.fulfill({ json: { account: { id: account.id, label: account.label, active: !account.active, ...(account.authMode === undefined ? {} : { authMode: account.authMode }) } } });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}

// cover physical outside presses at both persistent-toolbar layouts
for (const viewport of [{ label: 'desktop', width: 1280, height: 800 }, { label: 'phone', width: 390, height: 844 }]) {
  test.describe(`${viewport.label} account submenu input`, () => {
    test.use({ hasTouch: viewport.label === 'phone' });
    test(`blocks ${viewport.label} toolbar actions behind the account submenu`, async ({ page }) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      let shellStarts = 0;
      const worktreeId = 'repo:/repo/wts/cora';
      // collect uncaught and console-level browser failures
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => {
        // retain only actual console errors
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await setupAccountSettings(page, [{ id: 'personal-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro' }]);
      // expose one idle worktree with a directly actionable terminal control
      await page.route('**/api/dashboard', route => route.fulfill({ json: {
        generation: 1,
        adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } },
        agents: [],
        projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: worktreeId, projectId: 'repo', label: 'Cora', path: '/repo/wts/cora', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'default' } }] }],
        scratchLaunch: { kind: 'codex', origin: 'default' },
        cleanupPending: 0,
        reviews: [],
        reviewTour: { available: false, reason: 'generator_unavailable' },
      } }));
      // record real shell creation without starting a host process
      await page.route('**/api/**', async route => {
        const request = route.request();
        const path = decodeURIComponent(new URL(request.url()).pathname);
        // create one synthetic shell
        if (path === `/api/worktrees/${worktreeId}/shells` && request.method() === 'POST') {
          shellStarts += 1;
          return route.fulfill({ status: 201, json: { paneId: '%12' } });
        }
        // keep the direct-create branch free of existing panes
        if (path === `/api/worktrees/${worktreeId}/panes`) return route.fulfill({ json: { panes: [] } });
        return route.fallback();
      });

      await page.goto('/');
      const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
      const chooser = toolbar.getByRole('button', { name: /^(Choose agent|Launch agent)$/u });
      const terminal = toolbar.getByRole('button', { name: 'Open a terminal' });
      const terminalBounds = await terminal.boundingBox();
      // require a physical target before coordinate input
      if (terminalBounds === null) throw new Error('terminal toolbar button has no bounds');
      const terminalPoint = { x: terminalBounds.x + terminalBounds.width / 2, y: terminalBounds.y + terminalBounds.height / 2 };
      // use the active device's physical coordinate input
      const pressTerminal = () => viewport.label === 'phone' ? page.touchscreen.tap(terminalPoint.x, terminalPoint.y) : page.mouse.click(terminalPoint.x, terminalPoint.y);

      await chooser.click();
      const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
      await menu.getByRole('menuitem', { name: 'Codex accounts', exact: true }).click();
      const accounts = menu.getByRole('group', { name: 'Codex accounts', exact: true });
      await expect(accounts).toBeVisible();

      await pressTerminal();
      await expect(menu).toHaveCount(0);
      expect(shellStarts).toBe(0);

      await pressTerminal();
      await expect.poll(() => shellStarts).toBe(1);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  });
}

test('shows API-key spend and persists trimmed account and API-key names', async ({ page }) => {
  const pageErrors: string[] = [];
  // collect uncaught browser failures
  page.on('pageerror', error => pageErrors.push(error.message));
  const longKeyName = 'Production API key for the extraordinarily long west-coast autonomous research workspace';
  const resetAt = Math.floor(Date.now() / 1_000) + 86_400;
  const spendAsOf = Math.floor(Date.now() / 1_000);
  const state = await setupAccountSettings(page, [
    { id: 'chatgpt-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro', primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: resetAt }, secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: resetAt + 432_000 }, resetCount: 2 },
    { id: 'paid-key', label: 'Production API', active: false, authMode: 'apikey', spend: { status: 'available', todayUsd: 12.345, weekUsd: 80.1, asOf: spendAsOf } },
    { id: 'zero-key', label: 'Zero API', active: false, authMode: 'apikey', spend: { status: 'available', todayUsd: 0, weekUsd: 0, asOf: spendAsOf } },
    { id: 'missing-key', label: 'Unconfigured API', active: false, authMode: 'apikey', spend: { status: 'unconfigured' } },
    { id: 'unknown-key', label: 'Unknown billing API', active: false, authMode: 'apikey' },
    { id: 'failed-key', label: 'Unavailable API', active: false, authMode: 'apikey', spend: { status: 'unavailable' } },
  ]);
  let settings = await openCodexAccounts(page);
  const chatgpt = settings.getByRole('radio').filter({ hasText: 'personal@example.com' });
  const paid = settings.getByRole('radio').filter({ hasText: 'Production API' });
  const zero = settings.getByRole('radio').filter({ hasText: 'Zero API' });
  const unconfigured = settings.getByRole('radio').filter({ hasText: 'Unconfigured API' });
  const unknown = settings.getByRole('radio').filter({ hasText: 'Unknown billing API' });
  const unavailable = settings.getByRole('radio').filter({ hasText: 'Unavailable API' });

  await expect(settings.getByText('API-key spend is in USD, using UTC days and weeks starting Monday. OpenAI reporting may be delayed.')).toBeVisible();
  await expect(paid.getByText('Production API (API Key)', { exact: true })).toBeVisible();
  await expect(paid.getByText('Spent today', { exact: true })).toBeVisible();
  await expect(paid.getByText('Spent this week', { exact: true })).toBeVisible();
  await expect(paid.getByText('$12.35', { exact: true })).toBeVisible();
  await expect(paid.getByText('$80.10', { exact: true })).toBeVisible();
  await expect(paid).toContainText(/As of .+ UTC/u);
  await expect(zero.getByText('$0.00', { exact: true })).toHaveCount(2);
  await expect(unconfigured.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unconfigured).toContainText('OpenAI billing is not configured for this key.');
  await expect(unknown.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unknown).toContainText('Billing totals unavailable. Reopen settings to refresh.');
  await expect(unknown).not.toContainText('not configured');
  await expect(unavailable.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unavailable).toContainText('Billing query failed. Reopen settings to retry.');
  await expect(unavailable).not.toContainText('$0.00');

  await settings.getByRole('button', { name: 'Rename Personal', exact: true }).click();
  let rename = page.getByRole('dialog', { name: 'Rename account', exact: true });
  const accountName = rename.getByLabel('account name', { exact: true });
  await expect(accountName).toHaveValue('Personal');
  await rename.getByRole('button', { name: 'Close rename account' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rename).toHaveCount(0);
  expect(state.patches).toEqual([]);

  await settings.getByRole('button', { name: 'Rename Personal', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename account', exact: true });
  await rename.getByLabel('account name', { exact: true }).fill('   ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await rename.getByLabel('account name', { exact: true }).fill('  Family Workspace  ');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(chatgpt).toContainText('Family Workspace (Pro)');
  await expect(chatgpt).toContainText('personal@example.com');
  await expect(chatgpt).toContainText('41% consumed');
  await expect(chatgpt).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('status')).toContainText('Renamed to Family Workspace.');

  await settings.getByRole('button', { name: 'Rename Production API', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  const keyName = rename.getByLabel('API key name', { exact: true });
  await expect(keyName).toHaveValue('Production API');
  await keyName.fill(`  ${longKeyName}  `);
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(paid).toContainText(`${longKeyName} (API Key)`);
  await expect(paid.getByText('$12.35', { exact: true })).toBeVisible();
  await expect(paid.getByText('$80.10', { exact: true })).toBeVisible();
  await expect(paid).toHaveAttribute('aria-checked', 'false');
  expect(state.patches).toEqual([
    { id: 'chatgpt-account', body: { label: 'Family Workspace' }, csrf: 'account-settings-csrf' },
    { id: 'paid-key', body: { label: longKeyName }, csrf: 'account-settings-csrf' },
  ]);
  await page.screenshot({ path: '/tmp/remoteagents-account-settings-desktop.png' });

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  settings = await openCodexAccounts(page, false);
  await expect(settings.getByRole('radio').filter({ hasText: 'Family Workspace' })).toContainText('personal@example.com');
  await expect(settings.getByRole('radio').filter({ hasText: `${longKeyName} (API Key)` })).toContainText('$80.10');
  await expect.poll(() => state.accountQueries).toBe(2);

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch agent' })).toBeVisible();
  const mobileLongName = settings.getByText(`${longKeyName} (API Key)`, { exact: true });
  await mobileLongName.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
  await expect(mobileLongName).toBeInViewport();
  const horizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontalMetrics.document).toBeLessThanOrEqual(horizontalMetrics.viewport);
  expect(horizontalMetrics.body).toBeLessThanOrEqual(horizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-account-settings-mobile.png' });
  expect(pageErrors).toEqual([]);
});

test('keeps rename drafts through cancel, HTTP failure, network failure, and retry', async ({ page }) => {
  const pageErrors: string[] = [];
  // collect uncaught browser failures
  page.on('pageerror', error => pageErrors.push(error.message));
  const state = await setupAccountSettings(page, [
    { id: 'retry-key', label: 'Retry API', active: true, authMode: 'apikey', spend: { status: 'available', todayUsd: 1.25, weekUsd: 4.5, asOf: Math.floor(Date.now() / 1_000) }, error: 'Retained provider warning' },
  ], ['http', 'network']);
  const settings = await openCodexAccounts(page);

  await settings.getByRole('button', { name: 'Rename Retry API', exact: true }).click();
  let rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  await rename.getByLabel('API key name', { exact: true }).fill('Cancelled name');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(settings.getByRole('radio').filter({ hasText: 'Retry API' })).toBeVisible();
  expect(state.patches).toEqual([]);

  await settings.getByRole('button', { name: 'Rename Retry API', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  const input = rename.getByLabel('API key name', { exact: true });
  await input.fill('  Durable retry name  ');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename.getByRole('alert')).toHaveText('Rename denied.');
  await expect(input).toHaveValue('  Durable retry name  ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename.getByRole('alert')).toHaveText('Console unavailable');
  await expect(input).toHaveValue('  Durable retry name  ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  const renamed = settings.getByRole('radio').filter({ hasText: 'Durable retry name' });
  await expect(renamed).toHaveAttribute('aria-checked', 'true');
  await expect(renamed).toContainText('$1.25');
  await expect(renamed).toContainText('$4.50');
  await expect(renamed).toContainText('Retained provider warning');
  await expect(settings.getByRole('status')).toContainText('Renamed to Durable retry name.');
  expect(state.patches).toEqual([
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
  ]);
  expect(pageErrors).toEqual([]);
});

test('rejects a malformed API-key spend contract instead of showing zero dollars', async ({ page }) => {
  const malformed = { id: 'malformed-key', label: 'Malformed API', active: true, authMode: 'apikey' as const, spend: { status: 'available', todayUsd: 0, asOf: 1_800_000_000 } };
  await setupAccountSettings(page, [malformed as unknown as Account]);
  const settings = await openCodexAccounts(page);
  await expect(settings.getByRole('status')).toHaveText('Unable to load ChatGPT accounts.');
  await expect(settings.getByRole('radiogroup', { name: 'ChatGPT accounts' }).getByRole('radio')).toHaveCount(0);
  await expect(settings).not.toContainText('$0.00');
});

test('stops labeling yesterday totals as today and requeries after UTC rollover', async ({ page }) => {
  const startingTime = new Date('2026-09-11T23:50:00.000Z');
  const rolloverTime = new Date('2026-09-11T23:59:59.500Z');
  const spendAsOf = Math.floor(rolloverTime.valueOf() / 1_000);
  await page.clock.install({ time: startingTime });
  const state = await setupAccountSettings(page, [
    { id: 'rollover-key', label: 'Rollover API', active: true, authMode: 'apikey', spend: { status: 'available', todayUsd: 7, weekUsd: 21, asOf: spendAsOf } },
  ]);
  const settings = await openCodexAccounts(page);
  const row = settings.getByRole('radio').filter({ hasText: 'Rollover API' });
  await expect(row.getByText('$7.00', { exact: true })).toBeVisible();
  expect(state.accountQueries).toBe(1);

  await page.clock.pauseAt(rolloverTime);
  await page.clock.runFor(1_000);
  await expect.poll(() => state.accountQueries).toBeGreaterThanOrEqual(2);
  await expect(row.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(row).toContainText('Previous-day totals hidden. Reopen settings to refresh.');
  await expect(row).not.toContainText('$7.00');
});

test('keeps all ChatGPT account actions on one row at desktop and mobile widths', async ({ page }) => {
  await setupAccountSettings(page, [
    { id: 'action-account', label: 'Action account', email: 'actions@example.com', active: true, planType: 'pro', primary: { usedPercent: 100 }, resetCount: 1, error: 'Account query failed' },
  ]);
  const settings = await openCodexAccounts(page);
  const actions = settings.getByRole('group', { name: 'Actions for Action account', exact: true });
  const rename = actions.getByRole('button', { name: 'Rename Action account', exact: true });
  const reset = actions.getByRole('button', { name: 'Use reset for Action account', exact: true });
  const relogin = actions.getByRole('button', { name: 'Re-login to Action account', exact: true });
  await expect(actions.getByRole('button')).toHaveCount(3);
  await expect(actions.getByRole('button')).toHaveText(['Rename', 'Use reset', 'Re-login']);
  await actions.scrollIntoViewIfNeeded();
  await expect(actions).toBeInViewport();

  const desktopRename = await rename.boundingBox();
  const desktopReset = await reset.boundingBox();
  const desktopRelogin = await relogin.boundingBox();
  expect(desktopRename).not.toBeNull();
  expect(desktopReset).not.toBeNull();
  expect(desktopRelogin).not.toBeNull();
  expect(Math.abs(desktopRename!.y - desktopReset!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopReset!.y - desktopRelogin!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopRename!.height - desktopReset!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopReset!.height - desktopRelogin!.height)).toBeLessThanOrEqual(1);
  expect(desktopRename!.x + desktopRename!.width).toBeLessThan(desktopReset!.x);
  expect(desktopReset!.x + desktopReset!.width).toBeLessThan(desktopRelogin!.x);
  await page.screenshot({ path: '/tmp/remoteagents-account-actions-desktop.png' });

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch agent' })).toBeVisible();
  await actions.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
  await expect(actions).toBeInViewport();
  const mobileRename = await rename.boundingBox();
  const mobileReset = await reset.boundingBox();
  const mobileRelogin = await relogin.boundingBox();
  expect(mobileRename).not.toBeNull();
  expect(mobileReset).not.toBeNull();
  expect(mobileRelogin).not.toBeNull();
  expect(Math.abs(mobileRename!.y - mobileReset!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileReset!.y - mobileRelogin!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileRename!.height - mobileReset!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileReset!.height - mobileRelogin!.height)).toBeLessThanOrEqual(1);
  expect(mobileRename!.x + mobileRename!.width).toBeLessThan(mobileReset!.x);
  expect(mobileReset!.x + mobileReset!.width).toBeLessThan(mobileRelogin!.x);
  const horizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontalMetrics.document).toBeLessThanOrEqual(horizontalMetrics.viewport);
  expect(horizontalMetrics.body).toBeLessThanOrEqual(horizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-account-actions-mobile.png' });
});

// verify active account identity beside the installed Codex version
test('shows the active Codex account beside its version in launch menus', async ({ page }) => {
  const longName = 'Autonomous research workspace account with an intentionally long saved display name';
  const versionLabel = 'v0.153.2 → v0.154.0';
  const state = await setupAccountSettings(page, [
    { id: 'personal-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro' },
    { id: 'work-account', label: 'Work', email: 'work@example.com', active: false, planType: 'business' },
  ]);
  let switchBody: unknown;
  let switchCsrf = '';
  // publish current and available Codex versions for the launch row
  await page.route('**/api/agents/updates', route => route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.154.0', updateAvailable: true }] } }));
  // switch the selected account without changing the shared settings fixture
  await page.route('**/api/codex/accounts/switch', route => {
    const request = route.request();
    switchBody = request.postDataJSON();
    switchCsrf = request.headers()['x-csrf-token'] ?? '';
    const id = (switchBody as { id?: unknown }).id;
    // select only the requested fixture account
    for (const account of state.accounts) account.active = account.id === id;
    const account = state.accounts.find(candidate => candidate.active);
    // reject a malformed fixture request
    if (account === undefined) return route.fulfill({ status: 404, json: { error: 'Account unavailable.' } });
    return route.fulfill({ json: { account, restarts: [] } });
  });

  await page.goto('/');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: /^(Choose agent|Launch agent)(?: — update available)?$/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  let codex = menu.getByRole('group', { name: 'Codex agent' });
  const versionLine = codex.locator('.launch-agent-details');
  const version = versionLine.getByText(versionLabel, { exact: true });
  let activeName = versionLine.getByText('Personal', { exact: true });
  await expect(version).toBeVisible();
  await expect(activeName).toBeVisible();
  await expect(codex.getByText('personal@example.com', { exact: true })).toHaveCount(0);
  await expect.poll(() => state.accountQueries).toBe(1);
  const versionBounds = await version.boundingBox();
  const activeBounds = await activeName.boundingBox();
  expect(versionBounds).not.toBeNull();
  expect(activeBounds).not.toBeNull();
  expect(activeBounds!.x).toBeGreaterThan(versionBounds!.x + versionBounds!.width);
  expect(Math.abs((activeBounds!.y + activeBounds!.height / 2) - (versionBounds!.y + versionBounds!.height / 2))).toBeLessThanOrEqual(1);
  const [activeColor, codexColor] = await Promise.all([
    activeName.evaluate(element => getComputedStyle(element).color),
    codex.locator('.launch-kind-codex').evaluate(element => getComputedStyle(element).color),
  ]);
  expect(activeColor).toBe(codexColor);

  await codex.getByRole('menuitem', { name: 'Codex accounts', exact: true }).click();
  let accounts = menu.getByRole('group', { name: 'Codex accounts', exact: true });
  const work = accounts.getByRole('radio').filter({ hasText: 'Work' });
  await expect(work).toHaveAttribute('aria-checked', 'false');
  await work.click();
  await expect(work).toHaveAttribute('aria-checked', 'true');
  expect(switchBody).toEqual({ id: 'work-account' });
  expect(switchCsrf).toBe('account-settings-csrf');
  expect(state.accountQueries).toBe(1);
  await accounts.getByRole('button', { name: /Back to agents/u }).click();
  codex = menu.getByRole('group', { name: 'Codex agent' });
  await expect(codex.locator('.launch-agent-account')).toHaveText('Work');

  await codex.getByRole('menuitem', { name: 'Codex accounts', exact: true }).click();
  accounts = menu.getByRole('group', { name: 'Codex accounts', exact: true });
  await accounts.getByRole('button', { name: 'Rename Work', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename account', exact: true });
  await rename.getByLabel('account name', { exact: true }).fill(longName);
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(accounts.getByRole('status')).toContainText(`Renamed to ${longName}.`);
  await accounts.getByRole('button', { name: /Back to agents/u }).click();
  codex = menu.getByRole('group', { name: 'Codex agent' });
  activeName = codex.locator('.launch-agent-account');
  await expect(activeName).toHaveText(longName);
  await expect(activeName).toHaveAttribute('title', longName);
  expect(state.accountQueries).toBe(1);
  await page.screenshot({ path: '/tmp/remoteagents-launch-account-desktop.png' });

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(activeName).toBeVisible();
  await expect(activeName).toHaveCSS('overflow', 'hidden');
  await expect(activeName).toHaveCSS('text-overflow', 'ellipsis');
  await expect(activeName).toHaveCSS('white-space', 'nowrap');
  const [mobileVersionBounds, mobileAccountBounds, mobileLineBounds] = await Promise.all([
    codex.getByText(versionLabel, { exact: true }).boundingBox(),
    activeName.boundingBox(),
    codex.locator('.launch-agent-details').boundingBox(),
  ]);
  expect(mobileVersionBounds).not.toBeNull();
  expect(mobileAccountBounds).not.toBeNull();
  expect(mobileLineBounds).not.toBeNull();
  expect(mobileAccountBounds!.x).toBeGreaterThan(mobileVersionBounds!.x + mobileVersionBounds!.width);
  expect(mobileAccountBounds!.x + mobileAccountBounds!.width).toBeLessThanOrEqual(mobileLineBounds!.x + mobileLineBounds!.width + 1);
  const [mobileLaunchBounds, mobileAccountsBounds, mobileUpdateBounds, mobileDefaultBounds] = await Promise.all([
    codex.locator(':scope > .launch-row').boundingBox(),
    codex.locator(':scope > .launch-agent-accounts').boundingBox(),
    codex.locator(':scope > .launch-agent-update').boundingBox(),
    codex.locator(':scope > .launch-agent-default').boundingBox(),
  ]);
  expect(mobileLaunchBounds).not.toBeNull();
  expect(mobileAccountsBounds).not.toBeNull();
  expect(mobileUpdateBounds).not.toBeNull();
  expect(mobileDefaultBounds).not.toBeNull();
  expect(mobileLaunchBounds!.x + mobileLaunchBounds!.width).toBeLessThanOrEqual(mobileAccountsBounds!.x + 1);
  expect(mobileAccountsBounds!.x + mobileAccountsBounds!.width).toBeLessThanOrEqual(mobileUpdateBounds!.x + 1);
  expect(mobileUpdateBounds!.x + mobileUpdateBounds!.width).toBeLessThanOrEqual(mobileDefaultBounds!.x + 1);
  const mobileAccountWidths = await activeName.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(mobileAccountWidths.scroll).toBeGreaterThan(mobileAccountWidths.client);
  const horizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontalMetrics.document).toBeLessThanOrEqual(horizontalMetrics.viewport);
  expect(horizontalMetrics.body).toBeLessThanOrEqual(horizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-launch-account-mobile.png' });

  // refresh the menu with no selected account and keep the version honest
  for (const account of state.accounts) account.active = false;
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await toolbar.getByRole('button', { name: /^(Choose agent|Launch agent)(?: — update available)?$/u }).click();
  await expect.poll(() => state.accountQueries).toBe(2);
  codex = page.getByRole('menu', { name: 'Choose agent', exact: true }).getByRole('group', { name: 'Codex agent' });
  await expect(codex.getByText(versionLabel, { exact: true })).toBeVisible();
  await expect(codex.locator('.launch-agent-account')).toHaveCount(0);
  expect(state.patches).toEqual([{ id: 'work-account', body: { label: longName }, csrf: 'account-settings-csrf' }]);
});

// verify the signed-in Claude account and its usage reuse the Codex launcher slot
test('shows the Claude account and usage in launch menus', async ({ page }) => {
  await setupAccountSettings(page, []);
  let claudeQueries = 0;
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  // configure Claude beside Codex
  await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }, claude: { program: '/usr/local/bin/claude', launchable: true, stateSource: 'reported', turnCapture: true, inlineQuestions: true, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'claude', origin: 'default' }, cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } }));
  // report one signed-in account with both usage windows
  await page.route('**/api/claude/accounts', route => {
    claudeQueries += 1;
    return route.fulfill({ json: { accounts: [{ id: 'claude', label: 'tony@example.com', active: true, email: 'tony@example.com', planType: 'max_20x', primary: { usedPercent: 37, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 82, windowDurationMins: 10_080 } }] } });
  });

  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(Choose agent|Launch agent)(?: — update available)?$/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  const claude = menu.getByRole('group', { name: 'Claude agent' });
  await expect(claude.locator('.launch-agent-account')).toHaveText('tony@example.com');
  expect(claudeQueries).toBe(1);

  await claude.getByRole('menuitem', { name: 'Claude accounts', exact: true }).click();
  const accounts = menu.getByRole('group', { name: 'Claude accounts', exact: true });
  await expect(accounts.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(accounts.getByText('tony@example.com (Max 20x)', { exact: true })).toBeVisible();
  await expect(accounts.getByRole('progressbar', { name: '5h limit consumed' })).toHaveAttribute('value', '37');
  await expect(accounts.getByRole('progressbar', { name: '7d limit consumed' })).toHaveAttribute('value', '82');
  await expect(accounts.getByText(/^Resets in 0d 0[23]h/u)).toBeVisible();
  await expect(accounts.getByRole('radio')).toHaveCount(0);
  await accounts.getByRole('button', { name: /Back to agents/u }).click();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Codex accounts', exact: true })).toBeVisible();
});

// keep restart choices independent from toolbar-only account state
test('keeps Restart as choice-only and defers account loading to the toolbar', async ({ page }) => {
  const state = await setupAccountSettings(page, [
    { id: 'personal-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro' },
  ]);
  // provide one ready configured Agent and its worktree
  await page.route('**/api/dashboard', route => route.fulfill({ json: {
    generation: 1,
    adapters: {
      codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
      claude: { program: '/usr/local/bin/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false },
    },
    agents: [{ id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'project', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } }],
    projects: [{ id: 'project', label: 'Project', available: true, worktrees: [{ id: 'cora', projectId: 'project', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'worktree' } }] }],
    scratchLaunch: { kind: 'codex', origin: 'default' },
    cleanupPending: 0,
    reviews: [],
    reviewTour: { available: false, reason: 'generator_unavailable' },
  } }));
  // keep toolbar-only version and update state available
  await page.route('**/api/agents/updates', route => route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.154.0', updateAvailable: true }] } }));

  await page.goto('/');
  expect(state.accountQueries).toBe(0);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const menu = page.getByRole('menu', { name: 'Agent power options' });
  const compactBounds = await menu.boundingBox();
  expect(compactBounds).not.toBeNull();
  expect(compactBounds!.width).toBeCloseTo(208, 0);
  await menu.getByRole('menuitem', { name: 'Restart as…', exact: true }).click();
  const pickerBounds = await menu.boundingBox();
  expect(pickerBounds).not.toBeNull();
  expect(pickerBounds!.width).toBeCloseTo(208, 0);
  const codex = menu.getByRole('group', { name: 'Codex agent' });
  await expect(codex.getByRole('menuitem', { name: /^Codex/u })).toBeVisible();
  await expect(menu.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  expect(state.accountQueries).toBe(0);
  await page.screenshot({ path: '/tmp/remoteagents-restart-choices-desktop.png' });

  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const mobileCompactBounds = await menu.boundingBox();
  expect(mobileCompactBounds).not.toBeNull();
  expect(mobileCompactBounds!.width).toBeCloseTo(208, 0);
  await menu.getByRole('menuitem', { name: 'Restart as…', exact: true }).click();
  const [mobileMenuBounds, mobileRowBounds] = await Promise.all([menu.boundingBox(), codex.locator(':scope > .launch-row').boundingBox()]);
  expect(mobileMenuBounds).not.toBeNull();
  expect(mobileRowBounds).not.toBeNull();
  expect(mobileMenuBounds!.width).toBeCloseTo(208, 0);
  expect(mobileRowBounds!.x).toBeGreaterThanOrEqual(mobileMenuBounds!.x);
  expect(mobileRowBounds!.x + mobileRowBounds!.width).toBeLessThanOrEqual(mobileMenuBounds!.x + mobileMenuBounds!.width);
  await expect(menu.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  expect(state.accountQueries).toBe(0);
  const mobileHorizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(mobileHorizontalMetrics.document).toBeLessThanOrEqual(mobileHorizontalMetrics.viewport);
  expect(mobileHorizontalMetrics.body).toBeLessThanOrEqual(mobileHorizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-restart-choices-mobile.png' });

  await page.keyboard.press('Escape');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: /^(Choose agent|Launch agent)(?: — update available)?$/u }).click();
  await expect.poll(() => state.accountQueries).toBe(1);
  const toolbarCodex = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Codex agent' });
  await expect(toolbarCodex.locator('.launch-agent-version')).toHaveText('v0.153.2 → v0.154.0');
  await expect(toolbarCodex.locator('.launch-agent-account')).toHaveText('Personal');
  await expect(toolbarCodex.getByRole('menuitem', { name: 'Codex accounts' })).toBeVisible();
  await expect(toolbarCodex.getByRole('menuitem', { name: 'Update Codex to 0.154.0' })).toBeVisible();
  await expect(toolbarCodex.getByRole('menuitemradio', { name: 'Make Codex default' })).toBeVisible();
});

// keep + choices detached from toolbar-only account state
test('defers account loading through + choices until the toolbar opens', async ({ page }) => {
  const state = await setupAccountSettings(page, [
    { id: 'personal-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro' },
  ]);

  await page.goto('/');
  expect(state.accountQueries).toBe(0);
  const plusTrigger = page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true });
  await plusTrigger.click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const scratch = launcher.locator('.launcher-row').filter({ hasText: 'Scratch' });
  await scratch.getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  const plusCodex = choices.getByRole('group', { name: 'Codex agent' });
  await expect(plusCodex.getByRole('menuitem', { name: /^Codex/u })).toBeVisible();
  await expect(choices.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  expect(state.accountQueries).toBe(0);

  await page.keyboard.press('Escape');
  await expect(choices).toHaveCount(0);
  await expect(launcher).toHaveCount(0);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: /^(Choose agent|Launch agent)(?: — update available)?$/u }).click();
  await expect.poll(() => state.accountQueries).toBe(1);
  const toolbarCodex = page.getByRole('menu', { name: 'Choose agent' }).getByRole('group', { name: 'Codex agent' });
  await expect(toolbarCodex.locator('.launch-agent-account')).toHaveText('Personal');
  await expect(toolbarCodex.getByText('personal@example.com', { exact: true })).toHaveCount(0);
  expect(state.accountQueries).toBe(1);
});
