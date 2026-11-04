import { expect, test, type Locator, type Page } from '@playwright/test';

type VoiceSettings = { enabled: boolean; available: boolean; name: string; context: string };
type SettingsPatch = { op: string; path: string[]; value?: unknown };
type SettingsSave = { changes: Array<{ sourceId: string; revisionId: string; patches?: SettingsPatch[] }> };
type PiUpdatePrompt = { requestId: string; currentVersion: string; targetVersion: string };
type PiUpdatePromptResponse = { status?: number; json: { agentId?: string; error?: string } } | { abort: true };

// stub a controlled console whose dashboard carries the given adapter capabilities
async function openSettings(page: import('@playwright/test').Page, adapters: unknown, options: { defaultAgent?: string; davo?: VoiceSettings; onDefaultAgent?: (kind: string) => void; onDavo?: (settings: Omit<VoiceSettings, 'available'>) => void; onSettingsSave?: (settings: SettingsSave) => void; agentUpdates?: Array<{ kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string; pinned?: true }>; onAgentUpdate?: (kind: string) => { kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string }; onPiUpdatePrompt?: (prompt: PiUpdatePrompt) => PiUpdatePromptResponse | Promise<PiUpdatePromptResponse>; onDashboard?: (read: number) => Record<string, unknown>; emptyWorkspace?: boolean; open?: boolean } = {}) {
  let davo = options.davo ?? { enabled: false, available: true, name: 'Davo', context: 'Existing Davo persona.' };
  let settingsRevision = 1;
  let dashboardReads = 0;
  let agentUpdates = options.agentUpdates ?? [];
  const settingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
  const appSource = {
    id: 'app', label: 'Application config', path: '/fixture/config/config.json', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: `app-voice-r${settingsRevision}`, apply: 'rac-restart',
    value: { integrations: { realtime: { enabled: davo.enabled, name: davo.name, context: davo.context, writeToolsEnabled: false } } },
    schema: { type: 'object', label: 'Application config', properties: { integrations: { type: 'object', properties: { realtime: { type: 'object', label: 'Voice configuration', properties: { enabled: { type: 'boolean', label: 'Enable voice' }, name: { type: 'string', label: 'Voice name' }, context: { type: 'string', label: 'Voice context' }, writeToolsEnabled: { type: 'boolean', label: 'Write tools enabled' } } } } } } }
  };
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
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'adapter-csrf', active: true, deviceName: 'Test device', ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }), davo, server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // expose one stateful application source for unified voice drafts
    if (url.pathname === '/api/settings/status') return route.fulfill({ json: settingsStatus });
    if (url.pathname === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: `adapter-settings-r${settingsRevision}`, sources: [appSource], status: settingsStatus } });
    if (url.pathname === '/api/settings/validate' && request.method() === 'POST') return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    // commit all staged voice fields through the one global settings write
    if (url.pathname === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as SettingsSave;
      options.onSettingsSave?.(body);
      const voicePatches = body.changes.find(change => change.sourceId === 'app')?.patches?.filter(patch => patch.op === 'set' && patch.path[0] === 'integrations' && patch.path[1] === 'realtime') ?? [];
      const enabled = voicePatches.find(patch => patch.path[2] === 'enabled')?.value;
      const name = voicePatches.find(patch => patch.path[2] === 'name')?.value;
      const context = voicePatches.find(patch => patch.path[2] === 'context')?.value;
      const writeToolsEnabled = voicePatches.find(patch => patch.path[2] === 'writeToolsEnabled')?.value;
      // apply only well-typed fixture values
      if (typeof enabled === 'boolean') appSource.value.integrations.realtime.enabled = enabled;
      // apply only well-typed fixture values
      if (typeof name === 'string') appSource.value.integrations.realtime.name = name;
      // apply only well-typed fixture values
      if (typeof context === 'string') appSource.value.integrations.realtime.context = context;
      // apply only well-typed fixture values
      if (typeof writeToolsEnabled === 'boolean') appSource.value.integrations.realtime.writeToolsEnabled = writeToolsEnabled;
      // publish current basic voice metadata only after the global commit
      if (voicePatches.some(patch => patch.path[2] === 'enabled' || patch.path[2] === 'name' || patch.path[2] === 'context')) {
        davo = { ...davo, enabled: appSource.value.integrations.realtime.enabled, name: appSource.value.integrations.realtime.name, context: appSource.value.integrations.realtime.context };
        options.onDavo?.({ enabled: davo.enabled, name: davo.name, context: davo.context });
      }
      settingsRevision += 1;
      appSource.revisionId = `app-voice-r${settingsRevision}`;
      return route.fulfill({ json: { version: 1, revisionId: `adapter-settings-r${settingsRevision}`, sources: [appSource], status: settingsStatus } });
    }
    // persist one selected default agent
    if (url.pathname === '/api/server/default-agent' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { kind: string };
      options.onDefaultAgent?.(payload.kind);
      return route.fulfill({ json: { defaultAgent: payload.kind } });
    }
    // publish and mutate agent versions
    if (url.pathname === '/api/agents/updates' && route.request().method() === 'GET') return route.fulfill({ json: { agents: agentUpdates } });
    // submit one server-owned Pi pin-update prompt
    if (url.pathname === '/api/agents/pi/update-prompt' && route.request().method() === 'POST') {
      const result = await options.onPiUpdatePrompt?.(route.request().postDataJSON() as PiUpdatePrompt) ?? { json: { agentId: 'agent-pi-update' } };
      // reproduce a lost response without inventing an application error
      if ('abort' in result) return route.abort('connectionreset');
      return route.fulfill({ status: result.status ?? 200, json: result.json });
    }
    const agentUpdate = /^\/api\/agents\/([^/]+)\/update$/u.exec(url.pathname);
    // execute one mocked update
    if (agentUpdate !== null && route.request().method() === 'POST') {
      const kind = decodeURIComponent(agentUpdate[1]!);
      const updated = options.onAgentUpdate?.(kind) ?? { kind, currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false };
      agentUpdates = [...agentUpdates.filter(status => status.kind !== kind), updated];
      return route.fulfill({ json: { agent: updated } });
    }
    // publish either the default fixture or one stateful dashboard sequence
    if (url.pathname === '/api/dashboard') {
      dashboardReads += 1;
      const dashboard = options.onDashboard?.(dashboardReads) ?? { generation: 1, adapters, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: options.emptyWorkspace ? [] : [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: options.emptyWorkspace ? [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'worktree' } }] }] : [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } };
      return route.fulfill({ json: dashboard });
    }
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: 'a1b2c3d4e5f6789012345678901234567890abcd', committedAt: '2026-09-06T14:22:31-07:00' } });
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
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
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(?:Choose|Launch) agent/u }).click();
  return page.getByRole('menu', { name: 'Choose agent' });
}

// read the visible attention contract instead of sampling animation frames
async function updateAttention(control: Locator) {
  return control.evaluate(element => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
}

// sample the registered angle at deterministic points without relying on wall-clock timing
async function sampleUpdateOrbit(ring: Locator) {
  return ring.evaluate(element => {
    const animation = element.getAnimations({ subtree: true })[0];
    // require one live ring animation
    if (animation === undefined) throw new Error('update progress ring is not orbiting');
    const duration = animation.effect?.getComputedTiming().duration;
    // require a finite cycle before sampling its quarter turn
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('update progress ring has no finite duration');
    animation.pause();
    animation.currentTime = 0;
    const startAngle = Number.parseFloat(getComputedStyle(element, '::before').getPropertyValue('--update-orbit-angle'));
    animation.currentTime = duration / 4;
    const quarterAngle = Number.parseFloat(getComputedStyle(element, '::before').getPropertyValue('--update-orbit-angle'));
    animation.play();
    return { startAngle, quarterAngle };
  });
}

// start one codex update that remains active for visual state checks
async function startRunningCodexUpdate(page: Page) {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  await page.route('**/api/agents/codex/update', route => route.fulfill({ status: 202, json: { update: { id: 'update-orbit', kind: 'codex', state: 'running' } } }));
  await page.route('**/api/agents/codex/update/update-orbit', route => route.fulfill({ json: { update: { id: 'update-orbit', kind: 'codex', state: 'running' } } }));
  const menu = await openAgentMenu(page);
  await menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' }).click();
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: /Choose agent — update in progress$/u })).toBeVisible();
  return { toolbar, ring: toolbar.locator('.update-progress-ring') };
}

const piAdapter = { program: '/usr/bin/node', launchable: true, stateSource: 'reported', turnCapture: true, inlineQuestions: true, commands: false, sandbox: false };
const piAvailable = [{ kind: 'pi', currentVersion: '1.4.0', latestVersion: '1.5.0', updateAvailable: true, pinned: true } as const];

test('offers the bundled Pi prompt independently of RAC updates and cancels without mutation', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { /* retain only forbidden update mutations */ if (request.method() === 'POST' && (request.url().includes('/api/server/update') || /\/api\/agents\/pi\/update$/u.test(new URL(request.url()).pathname))) posts.push(new URL(request.url()).pathname); });
  await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable });
  const menu = await openAgentMenu(page);
  const update = menu.getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0', exact: true });
  await expect(update).toBeVisible();
  await update.click();
  const dialog = page.getByRole('dialog', { name: 'Update bundled Pi' });
  await expect(dialog).toContainText('Pi is bundled in RAC');
  await expect(dialog).toContainText('1.4.0 → 1.5.0');
  await expect(dialog).toContainText('Create a local change to update the pinned version?');
  await expect(dialog).toContainText('It does not update RAC from upstream or deploy the change.');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Submit prompt' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close Pi update' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Submit prompt' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([]);
  await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
  await page.getByRole('dialog', { name: 'Update bundled Pi' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Update bundled Pi' })).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('submits the Pi change prompt once and blocks dismissal while its result is pending', async ({ page }) => {
  let release: ((result: PiUpdatePromptResponse) => void) | undefined;
  const prompts: PiUpdatePrompt[] = [];
  const pending = new Promise<PiUpdatePromptResponse>(resolve => { release = resolve; });
  await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable, onPiUpdatePrompt: prompt => { prompts.push(prompt); return pending; } });
  await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update bundled Pi' });
  await dialog.getByRole('button', { name: 'Submit prompt' }).click();
  await expect(dialog.getByRole('button', { name: 'Submitting…' })).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ currentVersion: '1.4.0', targetVersion: '1.5.0' });
  expect(prompts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  release?.({ json: { agentId: 'agent-pi-update' } });
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#agent=agent-pi-update$/u);
  expect(prompts).toHaveLength(1);
});

test('retries a rejected Pi prompt with the same request identity', async ({ page }) => {
  const prompts: PiUpdatePrompt[] = [];
  await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable, onPiUpdatePrompt: prompt => {
    prompts.push(prompt);
    return prompts.length === 1 ? { status: 409, json: { error: 'The available Pi release changed.' } } : { json: { agentId: 'agent-pi-retry' } };
  } });
  await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update bundled Pi' });
  await dialog.getByRole('button', { name: 'Submit prompt' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The available Pi release changed.');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Submit prompt' }).click();
  await expect(page).toHaveURL(/#agent=agent-pi-retry$/u);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toEqual(prompts[0]);
});

test('retries an ambiguous Pi prompt response with the same request identity', async ({ page }) => {
  const prompts: PiUpdatePrompt[] = [];
  await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable, onPiUpdatePrompt: prompt => {
    prompts.push(prompt);
    return prompts.length === 1 ? { abort: true } : { json: { agentId: 'agent-pi-network-retry' } };
  } });
  await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update bundled Pi' });
  await dialog.getByRole('button', { name: 'Submit prompt' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Unable to confirm prompt submission. Retry to check the same request.');
  await dialog.getByRole('button', { name: 'Submit prompt' }).click();
  await expect(page).toHaveURL(/#agent=agent-pi-network-retry$/u);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toEqual(prompts[0]);
});

test('selects the submitted Pi update agent when the same worktree reports it later', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.hidden-agent:place-cora', '1'));
  let revealSubmittedAgent = false;
  const oldAgent = { id: 'agent-cora', panel: 'transcript', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Existing task', kind: 'codex', attention: 'finished', queuedPromptCount: 0, unread: false };
  const submittedAgent = { ...oldAgent, id: 'agent-pi-delayed', title: 'Update bundled Pi' };
  const dashboard = () => ({
    generation: revealSubmittedAgent ? 2 : 1,
    adapters: { pi: piAdapter, codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } },
    scratchLaunch: { kind: 'codex', origin: 'default' },
    agents: revealSubmittedAgent ? [oldAgent, submittedAgent] : [oldAgent],
    projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'worktree' } }] }],
    cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' }
  });
  await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable, onDashboard: dashboard, onPiUpdatePrompt: () => ({ json: { agentId: 'agent-pi-delayed' } }) });
  await page.evaluate(() => { (window as typeof window & { piUpdatePageMarker?: string }).piUpdatePageMarker = 'same-document'; });
  await expect(page.locator('[data-prompt-id="agent-cora"]')).toHaveCount(0);
  await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
  await page.getByRole('dialog', { name: 'Update bundled Pi' }).getByRole('button', { name: 'Submit prompt' }).click();
  await expect(page).toHaveURL(/#agent=agent-pi-delayed$/u);
  await expect(page.locator('[data-prompt-id="agent-pi-delayed"]')).toHaveCount(0);
  revealSubmittedAgent = true;
  await expect(page.locator('[data-prompt-id="agent-pi-delayed"]')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('[data-prompt-id="agent-cora"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { piUpdatePageMarker?: string }).piUpdatePageMarker)).toBe('same-document');
});

// keep the confirmation usable at desktop, phone and minimum supported widths
for (const width of [1280, 390, 208]) {
  test(`keeps the bundled Pi prompt confirmation within ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openSettings(page, { pi: piAdapter }, { open: false, agentUpdates: piAvailable });
    await (await openAgentMenu(page)).getByRole('group', { name: 'Pi agent' }).getByRole('menuitem', { name: 'Update Pi to 1.5.0' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update bundled Pi' });
    const card = dialog.locator(':scope > div');
    await expect(dialog).toBeVisible();
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('pi-update-modal.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });
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
  await expect(codex.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeVisible();
  await expect(codex.getByRole('menuitem', { name: 'Codex accounts' })).toBeVisible();
  await expect(codex.getByRole('menuitem', { name: 'Update Codex to 0.153.2' })).toBeVisible();
  await expect(codex.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await codex.getByRole('menuitem', { name: 'Codex accounts' }).click();
  await expect(menu.getByRole('group', { name: 'Codex accounts' }).getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: 'Launch agent', exact: true }).click();
  const plus = page.getByRole('group', { name: 'Agent launcher' });
  const worktreeLaunch = plus.getByRole('button', { name: 'Launch Cora' });
  await expect(worktreeLaunch).toBeVisible();
  const worktree = worktreeLaunch.locator('..');
  await worktree.getByRole('button', { name: 'More workspace actions' }).click();
  const choices = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(choices.getByRole('menuitem', { name: 'Launch Codex', exact: true })).toBeVisible();
  await expect(choices.locator('.launch-agent-details, .launch-agent-accounts, .launch-agent-update, .launch-menu-error')).toHaveCount(0);
  await expect(choices.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await expect(choices.getByRole('menuitem', { name: 'Codex accounts' })).toHaveCount(0);
  await expect(plus.getByRole('button', { name: 'Choose agent' })).toHaveCount(0);
});

test('does not expose or mutate the default agent from the launch menu', async ({ page }) => {
  const selected: string[] = [];
  await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex', onDefaultAgent: kind => { selected.push(kind); }, open: false });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Codex accounts' }).click();
  await menu.getByRole('group', { name: 'Codex accounts' }).getByRole('button', { name: /Back to agents/u }).click();
  expect(selected).toEqual([]);
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
  expect(await updateAttention(launch)).toEqual({ name: 'settings-update-glow', duration: '1.4s' });
  await expect(plus.locator('.new-agent-update-dot')).toHaveCount(0);
  await expect(plus).not.toHaveClass(/updates-available/u);
  await expect(settings.locator('.server-switcher-settings-update-dot')).toHaveCount(0);
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(launch.locator('.launch-update-dot')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const menu = await openAgentMenu(page);
  const menuBounds = await menu.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.width).toBeLessThan(448);
  expect(menuBounds!.x).toBeGreaterThanOrEqual(8);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 1280) - 8);
  const codexLine = menu.getByRole('group', { name: 'Codex agent' });
  await expect(codexLine.getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();
  const launchAction = codexLine.getByRole('menuitem', { name: 'Launch Codex', exact: true });
  const accountsAction = codexLine.getByRole('menuitem', { name: 'Codex accounts' });
  const updateAction = codexLine.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  const modelAction = codexLine.getByRole('button', { name: /^Codex model and Effort:/u });
  const controls = codexLine.getByLabel('Codex launch options');
  await expect(launchAction).toBeVisible();
  await expect(accountsAction).toBeVisible();
  await expect(updateAction).toBeVisible();
  const controlLabels = await controls.locator(':scope > button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(controlLabels).toEqual([
    expect.stringMatching(/^Codex model and Effort:/u),
    'Update Codex to 0.153.2',
    'Codex accounts',
    'Codex security',
    'Launch Codex',
  ]);
  const typography = await codexLine.evaluate(element => ({
    details: Number.parseFloat(getComputedStyle(element.querySelector('.launch-agent-details')!).fontSize),
    model: Number.parseFloat(getComputedStyle(element.querySelector('.launch-model-trigger')!).fontSize),
    modelTextAlign: getComputedStyle(element.querySelector('.launch-model-trigger > span')!).textAlign,
    modelTextGrow: getComputedStyle(element.querySelector('.launch-model-trigger > span')!).flexGrow,
  }));
  expect(typography.details).toBeGreaterThanOrEqual(typography.model);
  expect(typography.modelTextAlign).toBe('left');
  expect(typography.modelTextGrow).toBe('1');
  expect(await updateAttention(updateAction)).toEqual(await updateAttention(launch));
  await expect(codexLine.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await updateAttention(launch)).name).toBe('none');
  expect((await updateAttention(updateAction)).name).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  expect((await updateAttention(launch)).name).toBe('none');
  expect((await updateAttention(updateAction)).name).toBe('none');
  await page.evaluate(() => { delete document.documentElement.dataset.motion; });
  expect(await updateAttention(updateAction)).toEqual({ name: 'settings-update-glow', duration: '1.4s' });
  const summary = codexLine.locator('.launch-card-summary');
  await expect(summary).toHaveJSProperty('tagName', 'DIV');
  const idleBackground = await summary.evaluate(element => getComputedStyle(element).backgroundColor);
  await launchAction.hover();
  await expect(launchAction).toHaveCSS('background-image', /linear-gradient/u);
  await expect(summary).toHaveCSS('background-color', idleBackground);
  await accountsAction.hover();
  await expect(summary).toHaveCSS('background-color', idleBackground);
  await updateAction.hover();
  await expect(summary).toHaveCSS('background-color', idleBackground);
  await modelAction.hover();
  await expect(summary).toHaveCSS('background-color', idleBackground);
  await page.mouse.move(0, 0);
  await expect(summary).toHaveCSS('background-color', idleBackground);
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.21.3', { exact: true })).toBeVisible();
  await updateAction.click();
  await openAgentMenu(page);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Update Codex/u })).toHaveCount(0);
  await expect(launch.locator('.launch-update-dot')).toHaveCount(0);
  await expect(launch.getByRole('button', { name: 'Choose agent', exact: true })).toBeVisible();
});

test('keeps version errors visible across account disclosure', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'codex', open: false, agentUpdates: [{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }] });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
  await expect(menu.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await menu.getByRole('group', { name: 'Codex agent' }).getByRole('menuitem', { name: 'Codex accounts' }).click();
  await menu.getByRole('group', { name: 'Codex accounts' }).getByRole('button', { name: /Back to agents/u }).click();
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
});

test('keeps an unavailable persisted adapter read-only without default controls', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: 'Not executable', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'claude', open: false });
  const menu = await openAgentMenu(page);
  const claude = menu.getByRole('group', { name: 'Claude agent' });
  await expect(claude.getByRole('menuitemradio', { name: /^Make .+ default$/u })).toHaveCount(0);
  await expect(claude.getByRole('menuitem', { name: 'Launch Claude', exact: true })).toBeDisabled();
  await expect(claude).toContainText('Not executable');
});

test('stages Davo and advanced voice fields until the global settings save', async ({ page }) => {
  const updates: Array<{ enabled: boolean; name: string; context: string }> = [];
  const saves: SettingsSave[] = [];
  const settingsPage = await openSettings(page, {}, { onDavo: settings => { updates.push(settings); }, onSettingsSave: save => { saves.push(save); } });
  await settingsPage.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Voice', exact: true }).click();
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
  // keep the editable assistant name without repeating it as a heading
  await expect(settingsPage.getByRole('heading', { name: 'Riley', exact: true })).toHaveCount(0);
  await expect(settingsPage.getByLabel('Davo name')).toHaveValue('Riley');
  await expect(settingsPage.getByRole('switch', { name: 'Enable Riley' })).toBeChecked();
  await expect(context).toHaveValue('Speak plainly and keep the tone dry.');
  await settingsPage.getByRole('switch', { name: 'Write tools enabled', exact: true }).check();
  await expect(settingsPage.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(updates).toEqual([]);
  expect(saves).toEqual([]);
  await settingsPage.getByRole('button', { name: 'Save changes', exact: true }).click();

  await expect.poll(() => updates).toEqual([{ enabled: true, name: 'Riley', context: 'Speak plainly and keep the tone dry.' }]);
  await expect.poll(() => saves).toHaveLength(1);
  expect(saves[0]?.changes).toHaveLength(1);
  expect(saves[0]?.changes[0]).toMatchObject({ sourceId: 'app', revisionId: 'app-voice-r1' });
  expect(saves[0]?.changes[0]?.patches).toEqual(expect.arrayContaining([
    { op: 'set', path: ['integrations', 'realtime', 'enabled'], value: true },
    { op: 'set', path: ['integrations', 'realtime', 'name'], value: 'Riley' },
    { op: 'set', path: ['integrations', 'realtime', 'context'], value: 'Speak plainly and keep the tone dry.' },
    { op: 'set', path: ['integrations', 'realtime', 'writeToolsEnabled'], value: true }
  ]));
  expect(saves[0]?.changes[0]?.patches).toHaveLength(4);
  await expect(page.getByRole('status').getByText('Saved', { exact: true })).toBeVisible();
  await expect(settingsPage).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Call Riley' }).first()).toBeVisible();
});

// size an already-enabled voice editor whenever its navigation panel mounts
test('fits existing voice context when opening and revisiting its settings page', async ({ page }) => {
  const context = Array.from({ length: 16 }, (_, index) => `Existing voice context line ${index + 1}`).join('\n');
  const settingsPage = await openSettings(page, {}, { davo: { enabled: true, available: true, name: 'Davo', context } });
  const nav = settingsPage.getByRole('navigation', { name: 'Settings sources' });
  await nav.getByRole('button', { name: 'Voice', exact: true }).click();
  const editor = settingsPage.getByLabel('Davo context');
  await expect(editor).toHaveValue(context);
  await expect.poll(() => editor.evaluate(element => element.clientHeight >= element.scrollHeight)).toBe(true);
  await nav.getByRole('button', { name: 'This browser', exact: true }).click();
  await nav.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect.poll(() => editor.evaluate(element => element.clientHeight >= element.scrollHeight)).toBe(true);
});

test('hides agent and Codex account settings on an observe-only console', async ({ page }) => {
  const settingsPage = await openSettings(page, {});
  await expect(settingsPage.getByRole('radiogroup', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toHaveCount(0);
  // client settings remain while server administration lives in its selector
  await expect(settingsPage.getByRole('group', { name: 'Name', exact: true })).toBeVisible();
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
  const clientBounds = await settingsPage.getByRole('group', { name: 'Name', exact: true }).boundingBox();
  await expect(settingsPage.getByRole('group', { name: 'Terminal font' })).toHaveCount(0);
  const selector = settingsPage.getByRole('combobox', { name: 'Settings section', exact: true });
  await selector.click();
  await page.getByRole('listbox', { name: 'Settings section options', exact: true }).getByRole('option', { name: 'Interface', exact: true }).click();
  await expect(settingsPage.getByRole('group', { name: 'Name', exact: true })).toHaveCount(0);
  const terminalBounds = await settingsPage.getByRole('group', { name: 'Terminal font' }).boundingBox();
  const themeBounds = await settingsPage.getByRole('group', { name: 'Theme' }).boundingBox();
  // retain visible breathing room between interface settings
  if (clientBounds === null || terminalBounds === null || themeBounds === null) throw new Error('Settings have no layout bounds');
  const terminalThemeGap = themeBounds.y - (terminalBounds.y + terminalBounds.height);
  expect(terminalThemeGap).toBeGreaterThanOrEqual(12);
  const back = settingsPage.getByRole('button', { name: 'Close settings' });
  await back.focus();
  await page.keyboard.press('Escape');
  await expect(settingsPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // other toolbar controls do not dismiss the settings split
  await trigger.click();
  await toolbar.locator('.terminal-picker-toggle').click();
  await expect(settingsPage).toHaveCount(1);
});

// keep settings mounted in the same resizable and swipeable panel system
test('resizes settings and switches splits without closing it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const settings = await openSettings(page, {});
  const split = page.locator('.log-split').first();
  await expect(split.locator(':scope > .client-settings-page')).toHaveCount(1);
  const divider = split.getByRole('separator', { name: 'Resize agent and settings panels' });
  await expect(divider).toBeVisible();
  const before = await settings.boundingBox();
  const bounds = await divider.boundingBox();
  // require real draggable panel geometry
  if (before === null || bounds === null) throw new Error('Settings split has no bounds');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.up();
  const after = await settings.boundingBox();
  // retain the resized settings panel
  if (after === null) throw new Error('Settings split disappeared');
  expect(before.width - after.width).toBeGreaterThan(50);

  // expand and restore settings through the shared split header
  await settings.getByRole('button', { name: 'Expand settings' }).click();
  await expect(settings).toHaveClass(/expanded/u);
  await expect(split.locator(':scope > .log-output')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(1);
  await expect(settings).not.toHaveClass(/expanded/u);
  await expect(split.locator(':scope > .log-output')).toBeVisible();

  // navigate to output without dismissing the phone settings split
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Choose split' }).click();
  await page.getByRole('menuitem', { name: 'Agent output' }).click();
  await expect(settings).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Global settings' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Choose split' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect.poll(() => split.evaluate(element => element.scrollLeft)).toBeGreaterThan(300);

  // retain an unsaved voice draft during a real touch swipe
  await settings.getByRole('combobox', { name: 'Settings section', exact: true }).click();
  await page.getByRole('listbox', { name: 'Settings section options', exact: true }).getByRole('option', { name: 'Voice', exact: true }).click();
  await settings.getByRole('switch', { name: 'Enable Davo' }).check();
  await settings.getByLabel('Davo context').fill('Retain this unsaved context.');
  await settings.getByLabel('Davo context').blur();
  const swipeTarget = await settings.getByRole('heading', { name: 'Voice', exact: true, level: 2 }).boundingBox();
  // require swipe target geometry
  if (swipeTarget === null) throw new Error('Settings swipe target has no bounds');
  const touch = await page.context().newCDPSession(page);
  const y = Math.round(swipeTarget.y + swipeTarget.height / 2);
  // start outside editable and actionable controls so native selection stays intact
  expect(await page.evaluate(y => document.elementFromPoint(55, y)?.closest('input, textarea, select, button, a, [contenteditable="true"]') === null, y)).toBe(true);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 55, y }] });
  // drag across noninteractive settings content
  for (let step = 1; step <= 12; step += 1) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 55 + step * 24, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect.poll(() => split.evaluate(element => element.scrollLeft)).toBeLessThan(10);
  await expect(settings).toHaveCount(1);
  await page.getByRole('button', { name: 'Choose split' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(settings.getByLabel('Davo context')).toHaveValue('Retain this unsaved context.');

});

const updateFlyoutViewports = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 }
] as const;

// cover both responsive launcher controls with the installer request still pending
for (const viewport of updateFlyoutViewports) {
  test(`closes the agent flyout immediately after starting an update on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
    await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
    let updateStarted = false;
    // hold the mocked installer so closure cannot depend on its response
    await page.route('**/api/agents/codex/update', async () => {
      updateStarted = true;
      await new Promise<void>(() => { /* keep the installer pending */ });
    });
    const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
    const trigger = toolbar.getByRole('button', { name: /^(?:Choose|Launch) agent/u });
    const menu = await openAgentMenu(page);
    await menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' }).click();
    // prove the click reached the installer before checking dismissal
    await expect.poll(() => updateStarted).toBe(true);
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(toolbar.locator('.update-progress-ring')).toBeVisible();
  });
}

test('opens the full settings workspace beside desktop output and above narrow static controls', async ({ page }) => {
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
    // static controls stay measurable at both workspace widths
    if (settingsBounds === null || consoleBounds === null || tabsBounds === null || toolbarBounds === null || terminalBounds === null) throw new Error('Split panes have no layout bounds');
    expect(consoleBounds.x).toBe(0);
    expect(consoleBounds.width).toBe(width);
    // generic splits retain output and a draggable divider at desktop widths
    if (logBounds === null) throw new Error('Desktop output has no layout bounds');
    const outputBounds = await consoleView.locator('.log-output').first().boundingBox();
    if (outputBounds === null) throw new Error('Agent split has no layout bounds');
    expect(settingsBounds.width).toBeGreaterThanOrEqual(390);
    expect(logBounds.width).toBe(width);
    expect(settingsBounds.x - outputBounds.width).toBeGreaterThan(5);
    expect(settingsBounds.x - outputBounds.width).toBeLessThan(10);
    await expect(consoleView.getByRole('separator', { name: 'Resize agent and settings panels' })).toBeVisible();
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

// keep one active update orbiting through responsive launcher replacements
test('keeps the agent update orbit visible across desktop and phone launcher states', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { toolbar, ring } = await startRunningCodexUpdate(page);
  await expect(ring).toBeVisible();
  const ringParent = ring.locator('..');
  await expect.poll(() => ringParent.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect.poll(() => ringParent.getByRole('button').evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBe(true);
  await expect.poll(() => ringParent.getByRole('button').locator('[aria-hidden="true"]').evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBe(true);
  await expect.poll(() => sampleUpdateOrbit(ring)).toEqual({ startAngle: 0, quarterAngle: 90 });
  const busyMenu = await openAgentMenu(page);
  const busyUpdate = busyMenu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await expect(busyUpdate).toHaveAttribute('aria-busy', 'true');
  await expect(busyUpdate).toHaveClass(/progress-border/u);
  expect((await updateAttention(busyUpdate)).name).toBe('none');
  await page.keyboard.press('Escape');

  // keep the same orbit on the phone's single launch control
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(toolbar.getByRole('button', { name: /Launch agent — update in progress$/u })).toBeVisible();
  await expect(ring).toBeVisible();
  await expect.poll(() => sampleUpdateOrbit(ring)).toEqual({ startAngle: 0, quarterAngle: 90 });

  // preserve the orbit while minimizing and restoring the phone agent panel
  // keep another split visible while the agent is minimized
  await page.getByRole('button', { name: 'Global settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Minimize agent output' }).click();
  await expect(page.locator('.log-output')).toHaveCount(0);
  const showAgent = toolbar.getByRole('button', { name: /Show agent — update in progress$/u });
  await expect(showAgent).toBeVisible();
  await expect(ring).toBeVisible();
  await expect.poll(() => sampleUpdateOrbit(ring)).toEqual({ startAngle: 0, quarterAngle: 90 });
  await showAgent.click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(toolbar.getByRole('button', { name: /Launch agent — update in progress$/u })).toBeVisible();
  await expect(ring).toBeVisible();
  await expect.poll(() => sampleUpdateOrbit(ring)).toEqual({ startAngle: 0, quarterAngle: 90 });
});

// replace border motion with a compact spinner for both reduced-motion preferences
test('keeps a compact agent update spinner when motion is reduced', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { ring } = await startRunningCodexUpdate(page);
  await expect(ring).toBeVisible();
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::after').animationName)).not.toBe('none');
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::after').display)).not.toBe('none');

  // apply the in-app preference independently of the operating system
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  await expect(ring).toBeVisible();
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::after').animationName)).not.toBe('none');
  await expect.poll(() => ring.evaluate(element => getComputedStyle(element, '::after').display)).not.toBe('none');
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
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: /Choose agent — update available$/u })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toHaveCount(0);
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
  await expect.poll(() => polls.codex).toBeGreaterThan(0);
  await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  // busy icon actions retain progress semantics without a text label
  await expect(codexUpdate).toHaveAttribute('aria-busy', 'true');
  await expect(codexUpdate).toHaveText('');
  await expect(codexUpdate.locator('.launch-update-icon')).toBeVisible();
  await expect(codexUpdate).toBeDisabled();
  await expect(omxUpdate).toBeDisabled();
  await expect(toolbar.getByRole('button', { name: /Choose agent — update in progress$/u })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toBeVisible();
  const codexPolls = polls.codex;
  // outlast the former seven-minute browser deadline
  await page.clock.fastForward(8 * 60_000);
  await expect.poll(() => polls.codex).toBeGreaterThan(codexPolls);
  await expect(codexUpdate).toHaveAttribute('aria-busy', 'true');
  await expect(codexUpdate).toBeDisabled();
  expect(posts.codex).toBe(1);
  complete.add('codex');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(codexUpdate).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: /Choose agent — update available$/u })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toHaveCount(0);

  await omxUpdate.click();
  await expect.poll(() => starts.omx).toMatchObject({ contentType: 'application/json', body: '{}' });
  await expect.poll(() => polls.omx).toBeGreaterThan(0);
  await openAgentMenu(page);
  await expect(omxUpdate).toHaveAttribute('aria-busy', 'true');
  expect(posts.omx).toBe(1);
  complete.add('omx');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.22.0', { exact: true })).toBeVisible();
  await expect(omxUpdate).toHaveCount(0);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Choose agent', exact: true })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toHaveCount(0);
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
  await openAgentMenu(page);
  await expect(update).toHaveAttribute('aria-busy', 'true');
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
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
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
  await expect(menu).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: /Choose agent — update in progress$/u })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toBeVisible();
  const toast = page.getByRole('alert', { name: 'Agent update failed' });
  await page.clock.runFor(1_001);
  await expect(toast).toContainText('Agent update failed after starting.');
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: /Choose agent — update available$/u })).toBeVisible();
  await expect(toolbar.locator('.update-progress-ring')).toHaveCount(0);
  // error notices must not expire before dismissal
  await page.clock.fastForward(60_000);
  await expect(toast).toBeVisible();
  await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(update).toBeEnabled();
  expect(posts).toBe(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
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
  await openAgentMenu(page);
  await update.click();
  await openAgentMenu(page);
  await expect(update).toHaveAttribute('aria-busy', 'true');
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
  await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(update).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
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
  await openAgentMenu(page);
  await expect(codexUpdate).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();

  const omxUpdate = menu.getByRole('menuitem', { name: 'Update OMX to 0.22.0' });
  await omxUpdate.click();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Agent update failed' })).not.toContainText(staleMessage);
  await openAgentMenu(page);
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
  await openAgentMenu(page);
  await expect(update).toHaveAttribute('aria-busy', 'true');
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
  await openAgentMenu(page);
  await expect(update).toBeEnabled();
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await page.waitForTimeout(1_100);
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});
