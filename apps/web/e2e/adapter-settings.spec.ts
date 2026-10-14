import { expect, test } from '@playwright/test';

// stub a controlled console whose dashboard carries the given adapter capabilities
async function openSettings(page: import('@playwright/test').Page, adapters: unknown, options: { defaultAgent?: string; davo?: { enabled: boolean; available: boolean; name: string; context: string }; onDefaultAgent?: (kind: string) => void; onDavo?: (settings: { enabled: boolean; name: string; context: string }) => void; agentUpdates?: Array<{ kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string }>; onAgentUpdate?: (kind: string) => { kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string }; emptyWorkspace?: boolean; open?: boolean } = {}) {
  const davo = options.davo ?? { enabled: false, available: true, name: 'Davo', context: 'Existing Davo persona.' };
  let agentUpdates = options.agentUpdates ?? [];
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'adapter-csrf', active: true, deviceName: 'Test device', ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }), davo, server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // persist one selected default agent
    if (url.pathname === '/api/server/default-agent' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { kind: string };
      options.onDefaultAgent?.(payload.kind);
      return route.fulfill({ json: { defaultAgent: payload.kind } });
    }
    // publish and mutate agent versions
    if (url.pathname === '/api/agents/updates' && route.request().method() === 'GET') return route.fulfill({ json: { agents: agentUpdates } });
    const agentUpdate = /^\/api\/agents\/([^/]+)\/update$/u.exec(url.pathname);
    // execute one mocked update
    if (agentUpdate !== null && route.request().method() === 'POST') {
      const kind = decodeURIComponent(agentUpdate[1]!);
      const updated = options.onAgentUpdate?.(kind) ?? { kind, currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false };
      agentUpdates = [...agentUpdates.filter(status => status.kind !== kind), updated];
      return route.fulfill({ json: { agent: updated } });
    }
    // persist one voice settings update
    if (url.pathname === '/api/server/davo' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { enabled: boolean; name: string; context: string };
      options.onDavo?.(payload);
      return route.fulfill({ json: { davo: { ...payload, available: davo.available } } });
    }
    // provide an agentless worktree for the two full-size launch controls
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: options.emptyWorkspace ? [] : [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: options.emptyWorkspace ? [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'worktree' } }] }] : [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: 'a1b2c3d4e5f6789012345678901234567890abcd', committedAt: '2026-09-06T14:22:31-07:00' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  // open settings unless the caller needs to inspect the aggregate indicator first
  if (options.open !== false) await page.getByRole('button', { name: 'Global settings' }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

// open the shared agent chooser from the persistent toolbar
async function openAgentMenu(page: import('@playwright/test').Page) {
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^Choose agent/u }).click();
  return page.getByRole('menu', { name: 'Choose agent' });
}

test('moves Codex accounts from settings into the launcher submenu', async ({ page }) => {
  const settingsPage = await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: '/opt/claude is not an executable file', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex' });
  await expect(settingsPage.getByRole('radiogroup', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('heading', { name: 'Accounts' })).toHaveCount(0);
  await settingsPage.getByRole('button', { name: 'Close settings' }).click();
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Codex accounts' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Codex accounts' }).click();
  const accounts = menu.getByRole('group', { name: 'Codex accounts' });
  await expect(accounts.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(accounts.getByRole('button', { name: '+ Add account' })).toBeVisible();
  await accounts.getByRole('button', { name: /Back to agents/u }).click();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem').first()).toBeVisible();
});

test('keeps agent management in the far-left toolbar while + dropdowns only choose agents', async ({ page }) => {
  await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex', emptyWorkspace: true, open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(page.getByRole('region', { name: 'Empty workspace' }).getByRole('button', { name: 'Choose agent' })).toHaveCount(0);
  // the persistent Launch control leads every other static action
  await expect(toolbar.locator('.workspace-toolbar-actions > :first-child')).toHaveClass(/launch-split/u);
  const menu = await openAgentMenu(page);
  const codex = menu.getByRole('group', { name: 'Codex agent' });
  await expect(codex.locator(':scope > button')).toHaveText([/Codex/u, /Accounts/u, 'Update', '★']);
  await codex.getByRole('menuitem', { name: 'Codex accounts' }).click();
  await expect(menu.getByRole('group', { name: 'Codex accounts' }).getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Choose agent' }).click();
  await page.getByRole('button', { name: 'Launch agent', exact: true }).click();
  const plus = page.getByRole('group', { name: 'Agent launcher' });
  const worktreeLaunch = plus.getByRole('button', { name: 'Launch Cora' });
  await expect(worktreeLaunch).toBeVisible();
  const worktree = worktreeLaunch.locator('..');
  await worktree.getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(choices.getByRole('menuitem', { name: /^Codex/u })).toBeVisible();
  await expect(choices.locator('.launch-agent-details, .launch-agent-default, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  await expect(choices.getByRole('menuitem', { name: 'Codex accounts' })).toHaveCount(0);
  await expect(plus.getByRole('button', { name: 'Choose agent' })).toHaveCount(0);
});

test('changes the default agent from the launch menu', async ({ page }) => {
  let selected: string | undefined;
  await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex', onDefaultAgent: kind => { selected = kind; }, open: false });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('menuitemradio', { name: 'Make Codex default' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Make Claude default' }).click();
  await expect.poll(() => selected).toBe('claude');
  await expect(menu.getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
});

test('shows agent versions and updates in launch menu with indicator on launch button', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    defaultAgent: 'omx', open: false,
    agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.21.3', updateAvailable: false }
    ],
    onAgentUpdate: kind => ({ kind, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false })
  });
  const launch = page.getByRole('region', { name: 'Workspace toolbar' }).locator('.launch-split');
  const plus = page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true });
  const settings = page.getByRole('button', { name: 'Global settings' });
  await expect(launch.locator('.launch-update-dot')).toBeVisible();
  await expect(launch.getByRole('button', { name: 'Choose agent — update available' })).toBeVisible();
  // the pulse keeps a hard outline and a standard corner status dot
  const attention = await launch.evaluate(element => {
    const dot = element.querySelector<HTMLElement>('.launch-update-dot')!;
    const frame = element.getBoundingClientRect();
    const marker = dot.getBoundingClientRect();
    return { outline: getComputedStyle(element).outlineWidth, size: marker.width, height: marker.height, top: marker.top - frame.top, right: frame.right - marker.right };
  });
  expect(attention.outline).toBe('1px');
  expect(attention.size).toBe(6);
  expect(attention.height).toBe(6);
  expect(attention.top).toBeCloseTo(4);
  expect(attention.right).toBeCloseTo(4);
  await expect(plus.locator('.new-agent-update-dot')).toHaveCount(0);
  await expect(plus).not.toHaveClass(/updates-available/u);
  await expect(settings.locator('.server-switcher-settings-update-dot')).toHaveCount(0);
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(launch.locator('.launch-update-dot')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const menu = await openAgentMenu(page);
  const codexLine = menu.getByRole('group', { name: 'Codex agent' });
  await expect(codexLine.getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();
  await expect(codexLine.locator(':scope > button')).toHaveText([/Codex/u, /Accounts/u, 'Update', '☆']);
  // hover treatment fades across the launch action and its controls together
  const idleBackground = await codexLine.evaluate(element => getComputedStyle(element).backgroundColor);
  await codexLine.getByRole('menuitem', { name: /^Codex ·/u }).hover();
  await expect.poll(() => codexLine.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idleBackground);
  await page.waitForTimeout(200);
  const hoverBackground = await codexLine.evaluate(element => getComputedStyle(element).backgroundColor);
  await codexLine.getByRole('menuitem', { name: 'Codex accounts' }).hover();
  await expect(codexLine).toHaveCSS('background-color', hoverBackground);
  await codexLine.getByRole('menuitem', { name: 'Update Codex to 0.153.2' }).hover();
  await expect(codexLine).toHaveCSS('background-color', hoverBackground);
  await codexLine.getByRole('menuitemradio', { name: 'Make Codex default' }).hover();
  await expect(codexLine).toHaveCSS('background-color', hoverBackground);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(75);
  await expect(codexLine).toHaveCSS('background-color', idleBackground);
  await expect(codexLine).toHaveCSS('transition-property', 'background-color');
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.21.3', { exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' }).click();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Update Codex/u })).toHaveCount(0);
  await expect(launch.locator('.launch-update-dot')).toHaveCount(0);
  await expect(launch.getByRole('button', { name: 'Choose agent', exact: true })).toBeVisible();
});

test('keeps version errors visible while changing the default agent', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'codex', open: false, agentUpdates: [{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }] });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
  await menu.getByRole('group', { name: 'Claude agent' }).getByRole('menuitemradio', { name: 'Make Claude default' }).click();
  await expect(menu.getByRole('group', { name: 'Claude agent' }).getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
});

test('marks an unavailable persisted default in the launch menu', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: 'Not executable', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'claude', open: false });
  const menu = await openAgentMenu(page);
  const claude = menu.getByRole('group', { name: 'Claude agent' });
  await expect(claude.getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
  await expect(claude.getByRole('menuitemradio', { name: 'Make Claude default' })).toBeDisabled();
  await expect(claude.getByRole('menuitem', { name: /^Claude(?! accounts)/u })).toBeDisabled();
});

test('enables Davo and saves a configurable name and context', async ({ page }) => {
  const updates: Array<{ enabled: boolean; name: string; context: string }> = [];
  const settingsPage = await openSettings(page, {}, { onDavo: settings => { updates.push(settings); } });
  const enabled = settingsPage.getByRole('switch', { name: 'Enable Davo' });
  const davoSection = settingsPage.locator('.client-settings-davo');
  const switchTrack = davoSection.locator('.client-settings-switch-track');

  await expect(enabled).not.toBeChecked();
  const [davoBounds, switchBounds] = await Promise.all([davoSection.boundingBox(), switchTrack.boundingBox()]);
  // keep the switch on the setting's right edge
  if (davoBounds === null || switchBounds === null) throw new Error('Davo switch has no layout bounds');
  expect(Math.abs(davoBounds.x + davoBounds.width - switchBounds.x - switchBounds.width)).toBeLessThanOrEqual(1);
  const offBackground = await switchTrack.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(settingsPage.getByLabel('Davo name')).toHaveCount(0);
  await enabled.check();
  await expect(switchTrack).not.toHaveCSS('background-color', offBackground);
  await expect(settingsPage.getByLabel('Davo name')).toHaveValue('Davo');
  const context = settingsPage.getByLabel('Davo context');
  await expect(context).toHaveValue('Existing Davo persona.');
  // grow and shrink the voice prompt without an inner scrollbar
  await context.fill(Array.from({ length: 16 }, (_, index) => `Context line ${index + 1}`).join('\n'));
  await expect.poll(() => context.evaluate(element => ({ fits: element.clientHeight >= element.scrollHeight, height: element.clientHeight }))).toMatchObject({ fits: true });
  const expandedHeight = await context.evaluate(element => element.clientHeight);
  await context.fill('Speak plainly and keep the tone dry.');
  await expect.poll(() => context.evaluate(element => element.clientHeight)).toBeLessThan(expandedHeight);
  await settingsPage.getByLabel('Davo name').fill('Riley');
  await expect(settingsPage.getByRole('heading', { name: 'Riley' })).toBeVisible();
  await expect(settingsPage.getByRole('switch', { name: 'Enable Riley' })).toBeChecked();
  await expect(context).toHaveValue('Speak plainly and keep the tone dry.');
  await settingsPage.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => updates).toEqual([
    { enabled: true, name: 'Davo', context: 'Existing Davo persona.' },
    { enabled: true, name: 'Riley', context: 'Speak plainly and keep the tone dry.' }
  ]);
  await expect(settingsPage.getByText('Saved.')).toBeVisible();
  await expect(settingsPage).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Call Riley' }).first()).toBeVisible();
});

test('hides agent and Codex account settings on an observe-only console', async ({ page }) => {
  const settingsPage = await openSettings(page, {});
  await expect(settingsPage.getByRole('radiogroup', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toHaveCount(0);
  // client settings remain while server administration lives in its selector
  await expect(settingsPage.getByRole('group', { name: 'Client' })).toBeVisible();
  await expect(settingsPage.getByRole('group', { name: 'Server' })).toHaveCount(0);
});

test('shows settings above the static controls on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 812 });
  const settingsPage = await openSettings(page, {});
  const trigger = page.getByRole('button', { name: 'Global settings' });
  const content = page.locator('.log-shell').first();
  const tabs = page.getByRole('tablist', { name: 'Agents and worktrees' });
  const toolbar = page.locator('.workspace-toolbar').first();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(trigger.locator('svg')).toHaveCount(1);
  await expect(trigger).toHaveText('');
  await expect(page.getByRole('menu', { name: 'Global settings' })).toHaveCount(0);
  const bounds = await settingsPage.boundingBox();
  const contentBounds = await content.boundingBox();
  const tabsBounds = await tabs.boundingBox();
  const toolbarBounds = await toolbar.boundingBox();
  // require the settings slide to fill only the flexible content row
  if (bounds === null || contentBounds === null || tabsBounds === null || toolbarBounds === null) throw new Error('Settings split has no layout bounds');
  expect(Math.abs(bounds.x - contentBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y - contentBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.width - 428)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.height - contentBounds.height)).toBeLessThanOrEqual(1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(tabsBounds.y + 1);
  expect(tabsBounds.y + tabsBounds.height).toBeLessThanOrEqual(toolbarBounds.y + 1);
  await expect(settingsPage).not.toHaveAttribute('aria-modal', 'true');
  await expect(tabs).toBeVisible();
  await expect(toolbar).toBeVisible();
  const clientBounds = await settingsPage.getByRole('group', { name: 'Client' }).boundingBox();
  const terminalBounds = await settingsPage.getByRole('group', { name: 'Terminal font' }).boundingBox();
  const themeBounds = await settingsPage.getByRole('group', { name: 'Theme' }).boundingBox();
  // retain visible breathing room between flat settings
  if (clientBounds === null || terminalBounds === null || themeBounds === null) throw new Error('Settings have no layout bounds');
  const clientTerminalGap = terminalBounds.y - (clientBounds.y + clientBounds.height);
  const terminalThemeGap = themeBounds.y - (terminalBounds.y + terminalBounds.height);
  expect(clientTerminalGap).toBeGreaterThanOrEqual(12);
  expect(terminalThemeGap).toBeGreaterThanOrEqual(12);
  expect(Math.abs(clientTerminalGap - terminalThemeGap)).toBeLessThanOrEqual(4);
  const back = settingsPage.getByRole('button', { name: 'Close settings' });
  await back.focus();
  await page.keyboard.press('Escape');
  await expect(settingsPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // a toolbar action leaves the settings slide for its own panel
  await trigger.click();
  await toolbar.locator('.terminal-picker-toggle').click();
  await expect(settingsPage).toHaveCount(0);
});

test('opens settings as the right-hand content split on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const settingsPage = await openSettings(page, {});
  // reuse the floating title and action pills from other workspace splits
  await expect(settingsPage.locator('.panel-header .panel-header-pill')).toHaveCount(2);
  const titlePill = settingsPage.locator('.panel-header-title');
  await expect(titlePill.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // keep text equally inset from both title-pill edges
  const titleInset = await titlePill.evaluate(element => {
    const style = getComputedStyle(element);
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  });
  expect(titleInset.right).toBeGreaterThan(0);
  expect(titleInset.right).toBe(titleInset.left);
  const consoleView = page.locator('main.console');
  // check content panes and static controls at wide and near-minimum split widths
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 800 });
    const settingsBounds = await settingsPage.boundingBox();
    const consoleBounds = await consoleView.boundingBox();
    const logBounds = await consoleView.locator('.log').first().boundingBox();
    const tabsBounds = await consoleView.locator('nav.tabs').first().boundingBox();
    const toolbarBounds = await consoleView.locator('.workspace-toolbar').first().boundingBox();
    const terminalBounds = await consoleView.locator('.workspace-toolbar-actions .terminal-picker-toggle').first().boundingBox();
    // require every split surface to have measurable bounds
    if (settingsBounds === null || consoleBounds === null || logBounds === null || tabsBounds === null || toolbarBounds === null || terminalBounds === null) throw new Error('Split panes have no layout bounds');
    expect(consoleBounds.x).toBe(0);
    expect(consoleBounds.width).toBe(width);
    expect(settingsBounds.width).toBeGreaterThanOrEqual(384);
    expect(settingsBounds.width).toBeLessThanOrEqual(448);
    expect(logBounds.x).toBe(0);
    expect(Math.abs(settingsBounds.x - logBounds.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(settingsBounds.x + settingsBounds.width - width)).toBeLessThanOrEqual(1);
    expect(settingsBounds.y + settingsBounds.height).toBeLessThanOrEqual(tabsBounds.y + 1);
    expect(tabsBounds.x).toBe(0);
    expect(tabsBounds.width).toBe(width);
    expect(tabsBounds.y + tabsBounds.height).toBeLessThanOrEqual(toolbarBounds.y + 1);
    expect(toolbarBounds.x).toBeGreaterThanOrEqual(0);
    expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual(width + 1);
    expect(terminalBounds.x).toBeGreaterThanOrEqual(0);
    expect(terminalBounds.x + terminalBounds.width).toBeLessThanOrEqual(width + 1);
  }
  await expect(settingsPage).not.toHaveAttribute('aria-modal', 'true');
  await expect(consoleView.getByRole('tabpanel')).toBeVisible();
  // leave the settings pane without a modal focus trap
  await page.getByRole('button', { name: 'Global settings' }).focus();
  await expect(page.getByRole('button', { name: 'Global settings' })).toBeFocused();
  await settingsPage.getByRole('button', { name: 'Close settings' }).click();
  await expect(consoleView.locator('.log').first()).toHaveCSS('width', '800px');
});

// keep long-running codex and omx updates attached to one queued job
test('polls queued Codex and OMX updates through completion', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    open: false, agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.22.0', updateAvailable: true }
    ]
  });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  const posts: Record<string, number> = { codex: 0, omx: 0 };
  const polls: Record<string, number> = { codex: 0, omx: 0 };
  const starts: Record<string, { contentType?: string; body: string | null }> = {};
  const complete = new Set<string>();
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const start = /^\/api\/agents\/(codex|omx)\/update$/u.exec(url.pathname);
    // queue one update without holding the request open
    if (start !== null && request.method() === 'POST') {
      const kind = start[1]!;
      posts[kind] = (posts[kind] ?? 0) + 1;
      const headers = await request.allHeaders();
      const body = request.postData();
      starts[kind] = { contentType: headers['content-type'], body };
      expect(headers.prefer).toBe('respond-async');
      // model the server's json media-type gate
      if (headers['content-type'] !== 'application/json' || body !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type: application/json required' } });
      return route.fulfill({ status: 202, json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    const poll = /^\/api\/agents\/(codex|omx)\/update\/([^/]+)$/u.exec(url.pathname);
    // return only the requested job identity
    if (poll !== null && request.method() === 'GET') {
      const kind = poll[1]!;
      expect(poll[2]).toBe(`update-${kind}`);
      polls[kind] = (polls[kind] ?? 0) + 1;
      // finish only after the test releases the job
      if (complete.has(kind)) return route.fulfill({ json: { update: { id: `update-${kind}`, kind, state: 'complete', agent: { kind, currentVersion: kind === 'codex' ? '0.153.2' : '0.22.0', latestVersion: kind === 'codex' ? '0.153.2' : '0.22.0', updateAvailable: false } } } });
      return route.fulfill({ json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    return route.fallback();
  });

  const codexUpdate = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  const omxUpdate = menu.getByRole('menuitem', { name: 'Update OMX to 0.22.0' });
  await codexUpdate.click();
  await expect.poll(() => starts.codex).toMatchObject({ contentType: 'application/json', body: '{}' });
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => polls.codex).toBeGreaterThan(0);
  await expect(codexUpdate).toContainText('Updating…');
  await expect(codexUpdate).toBeDisabled();
  await expect(omxUpdate).toBeDisabled();
  const codexPolls = polls.codex;
  // outlast the former seven-minute browser deadline
  await page.clock.fastForward(8 * 60_000);
  await expect.poll(() => polls.codex).toBeGreaterThan(codexPolls);
  await expect(codexUpdate).toContainText('Updating…');
  await expect(codexUpdate).toBeDisabled();
  expect(posts.codex).toBe(1);
  complete.add('codex');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(codexUpdate).toHaveCount(0);

  await omxUpdate.click();
  await expect.poll(() => starts.omx).toMatchObject({ contentType: 'application/json', body: '{}' });
  await expect.poll(() => polls.omx).toBeGreaterThan(0);
  await expect(omxUpdate).toContainText('Updating…');
  expect(posts.omx).toBe(1);
  complete.add('omx');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.22.0', { exact: true })).toBeVisible();
  await expect(omxUpdate).toHaveCount(0);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  expect(posts).toEqual({ codex: 1, omx: 1 });
});

// recover one queued update after a proxy timeout page
test('recovers agent update polling after a transient HTML 524 response', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // queue exactly one update
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      expect(request.headers().prefer).toBe('respond-async');
      return route.fulfill({ status: 202, json: { update: { id: 'update-recovery', kind: 'codex', state: 'running' } } });
    }
    // recover after one gateway timeout page
    if (url.pathname === '/api/agents/codex/update/update-recovery' && request.method() === 'GET') {
      polls += 1;
      // simulate a proxy-owned timeout response
      if (polls === 1) return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
      return route.fulfill({ json: { update: { id: 'update-recovery', kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } } });
    }
    return route.fallback();
  });

  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect.poll(() => polls).toBe(1);
  await expect(update).toContainText('Updating…');
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  expect({ posts, polls }).toEqual({ posts: 1, polls: 2 });
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// keep failed updates visible outside their menu until explicitly dismissed
test('shows a dismissible toast after a queued agent update fails with its menu closed', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  let posts = 0;
  let failUpdate = true;
  // capture timers before the first failure creates its toast
  await page.clock.install();
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // queue one failing update
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 202, json: { update: { id: 'update-failed', kind: 'codex', state: 'running' } } });
    }
    // publish one terminal command failure
    if (url.pathname === '/api/agents/codex/update/update-failed' && request.method() === 'GET') {
      // hold an explicit retry pending while its prior notice is checked
      if (!failUpdate) return route.fulfill({ json: { update: { id: 'update-failed', kind: 'codex', state: 'running' } } });
      return route.fulfill({ json: { update: { id: 'update-failed', kind: 'codex', state: 'failed', error: 'Agent update failed after starting.' } } });
    }
    return route.fallback();
  });

  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(update).toContainText('Updating…');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^Choose agent/u }).click();
  await expect(menu).toHaveCount(0);
  const toast = page.getByRole('alert', { name: 'Agent update failed' });
  await page.clock.runFor(1_001);
  await expect(toast).toContainText('Agent update failed after starting.');
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(0);
  // error notices must not expire before dismissal
  await page.clock.fastForward(60_000);
  await expect(toast).toBeVisible();
  await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(update).toBeEnabled();
  expect(posts).toBe(1);
  await toast.getByRole('button', { name: 'Dismiss operation status' }).click();
  await expect(toast).toHaveCount(0);
  await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(toast).toHaveCount(0);
  // show a fresh notice for a later explicit retry
  await update.click();
  await page.clock.runFor(1_001);
  await expect(toast).toContainText('Agent update failed after starting.');
  expect(posts).toBe(2);
  // an explicit retry replaces undismissed feedback without leaving a stale error
  failUpdate = false;
  await update.click();
  await expect(update).toContainText('Updating…');
  await expect(toast).toHaveCount(0);
  expect(posts).toBe(3);
  failUpdate = true;
  await page.clock.runFor(1_001);
  await expect(toast).toContainText('Agent update failed after starting.');
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// surface start refusals without replaying the installer
test('shows a dismissible toast when an agent update cannot start', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  let posts = 0;
  // retain the server's explicit refusal message
  await page.route('**/api/agents/codex/update', route => {
    posts += 1;
    return route.fulfill({ status: 409, json: { error: 'Another agent update is already running.' } });
  });
  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  const toast = page.getByRole('alert', { name: 'Agent update failed' });
  await expect(toast).toContainText('Another agent update is already running.');
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(0);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(update).toBeEnabled();
  await toast.getByRole('button', { name: 'Dismiss operation status' }).click();
  await expect(toast).toHaveCount(0);
  expect(posts).toBe(1);
});

// reject stale and mismatched queued update identities
test('rejects stale and mismatched agent update jobs', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    open: false, agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.22.0', updateAvailable: true }
    ]
  });
  const menu = await openAgentMenu(page);
  const posts: Record<string, number> = { codex: 0, omx: 0 };
  const staleMessage = 'Agent update status is unknown. Check the installed version before retrying.';
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const start = /^\/api\/agents\/(codex|omx)\/update$/u.exec(url.pathname);
    // queue one job for each adapter
    if (start !== null && request.method() === 'POST') {
      const kind = start[1]!;
      posts[kind] = (posts[kind] ?? 0) + 1;
      return route.fulfill({ status: 202, json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    // expire the codex job before its first poll
    if (url.pathname === '/api/agents/codex/update/update-codex' && request.method() === 'GET') return route.fulfill({ status: 404, json: { error: staleMessage } });
    // return a completed job for the wrong identity
    if (url.pathname === '/api/agents/omx/update/update-omx' && request.method() === 'GET') return route.fulfill({ json: { update: { id: 'update-other', kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } } });
    return route.fallback();
  });

  const codexUpdate = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await codexUpdate.click();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).toContainText(staleMessage);
  await expect(codexUpdate).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();

  const omxUpdate = menu.getByRole('menuitem', { name: 'Update OMX to 0.22.0' });
  await omxUpdate.click();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).not.toContainText(staleMessage);
  await expect(omxUpdate).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.21.3 → v0.22.0', { exact: true })).toBeVisible();
  expect(posts).toEqual({ codex: 1, omx: 1 });
});

// stop polling one uncertain job after the bounded wait
test('stops transient agent update polling at the seventeen-minute deadline', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // accept exactly one installer request
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 202, json: { update: { id: 'update-deadline', kind: 'codex', state: 'running' } } });
    }
    // keep every status read transiently unavailable
    if (url.pathname === '/api/agents/codex/update/update-deadline' && request.method() === 'GET') {
      polls += 1;
      return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
    }
    return route.fallback();
  });

  const unknownStatus = 'Update status is unavailable. The update may still be running; check installed versions before retrying.';
  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(update).toContainText('Updating…');
  await page.clock.runFor(1_001);
  await expect.poll(() => polls).toBeGreaterThan(0);
  await page.clock.fastForward(17 * 60_000);
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).toContainText(unknownStatus);
  await expect(update).toBeEnabled();
  expect(posts).toBe(1);
  expect(polls).toBeGreaterThan(0);
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// never replay one installer after an ambiguous start response
test('does not retry an agent update POST after an HTML 524 response', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // lose the installer acceptance response at the proxy
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
    }
    // count any unsafe follow-up status requests
    if (/^\/api\/agents\/codex\/update\//u.test(url.pathname) && request.method() === 'GET') {
      polls += 1;
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
    return route.fallback();
  });

  const unknownStatus = 'Update status is unavailable. The update may still be running; check installed versions before retrying.';
  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).toContainText(unknownStatus);
  await expect(update).toBeEnabled();
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await page.waitForTimeout(1_100);
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});
