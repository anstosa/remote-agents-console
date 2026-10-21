import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

type ShellReply =
  | { kind: 'success' }
  | { kind: 'failure'; status?: number; error?: string }
  | { kind: 'held'; release: Promise<{ status: number; error: string }> };

type NativeEditorOptions = {
  configured?: boolean;
  workspace?: boolean;
  retainedCode?: boolean;
  shellReplies?: ShellReply[];
};

type NativeEditorState = {
  shellBodies: unknown[];
  saves: number;
  validations: number;
  reveals: number;
  remasks: number;
  restarts: number;
};

const protectedMarker = `__RAC_PROTECTED_${'B'.repeat(43)}__`;
const disclosedSecret = 'fixture-native-editor-secret';
const savedAppContent = '{\n  "advanced": {\n    "mode": "saved"\n  },\n  "name": "Framework"\n}\n';
const savedComposeContent = `services:\n  remote-agent-console:\n    environment:\n      RAC_TOKEN: "${protectedMarker}"\n`;

// provide source capabilities without placing real installation bytes in the browser fixture
const settingsSources = () => [
  {
    id: 'app', label: 'Application config', path: '/synthetic/config/config.json', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'app-revision-current', apply: 'rac-restart',
    value: { advanced: { mode: 'saved' }, name: 'Framework' }, content: savedAppContent, hasProtectedContent: false,
    schema: { type: 'object', label: 'Application config', properties: {
      advanced: { type: 'json', label: 'Advanced JSON', description: 'Free-form application metadata.' },
      name: { type: 'string', label: 'Server name' }
    } }
  },
  {
    id: 'compose', label: 'Base Compose', path: '/synthetic/compose.yaml', format: 'compose', exists: true, writable: false, protected: true, tracked: true, revisionId: 'compose-base-revision-current', apply: 'rac-restart', hasProtectedContent: true,
    content: `services:\n  remote-agent-console:\n    image: ghcr.io/example/rac:base\n    environment:\n      RAC_TOKEN: "${protectedMarker}"\n`
  },
  {
    id: 'compose-override', label: 'Docker', path: '/synthetic/compose.override.yaml', format: 'compose', exists: true, writable: true, protected: false, tracked: false, revisionId: 'compose-override-revision-current', apply: 'rac-restart', hasProtectedContent: true,
    content: savedComposeContent
  },
  {
    id: 'wrapper', label: 'Installation wrapper', path: '/synthetic/config/installation-wrapper.sh', format: 'wrapper', exists: false, writable: true, protected: true, tracked: false, revisionId: 'wrapper-revision-current', apply: 'rac-restart', hasProtectedContent: false
  },
  {
    id: 'locked', label: 'Read-only source', path: '/synthetic/config/locked.json', format: 'json', exists: true, writable: false, protected: false, tracked: false, revisionId: 'locked-revision-current', apply: 'rac-restart', hasProtectedContent: false,
    content: '{"locked":true}\n'
  }
];

// return one active workspace so Settings receives the nearest terminal-editor capability
const dashboard = (configured: boolean, workspace: boolean) => ({
  generation: 1,
  editor: configured,
  adapters: {},
  agents: workspace ? [{
    id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/synthetic/worktree', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false, queuedPromptCount: 0
  }] : [],
  projects: [],
  cleanupPending: 0,
  reviews: [],
  reviewTour: { available: false, reason: 'generator_unavailable' }
});

// fulfill one queued shell response while recording the exact browser payload
async function fulfillShell(route: Route, reply: ShellReply | undefined, index: number) {
  // hold a request until the test advances the simulated server
  if (reply?.kind === 'held') {
    const failure = await reply.release;
    await route.fulfill({ status: failure.status, json: { error: failure.error } });
    return;
  }
  // expose one stable product failure for retry coverage
  if (reply?.kind === 'failure') {
    await route.fulfill({ status: reply.status ?? 500, json: { error: reply.error ?? 'The terminal editor is temporarily unavailable.' } });
    return;
  }
  await route.fulfill({ status: 201, json: { paneId: `%${index + 8}` } });
}

// mount the real Settings split over synthetic redacted API responses
async function setupNativeEditor(page: Page, options: NativeEditorOptions = {}) {
  await mockAccountSocket(page);
  // override the inert account socket with the binary terminal fixture
  await installPaneMock(page);
  const configured = options.configured !== false;
  const workspace = options.workspace !== false;
  const sources = settingsSources();
  const state: NativeEditorState = { shellBodies: [], saves: 0, validations: 0, reveals: 0, remasks: 0, restarts: 0 };
  const panes: Array<Record<string, unknown>> = workspace ? [{ paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/synthetic/worktree', title: '', agent: true }] : [];
  const replies = [...(options.shellReplies ?? [])];

  // isolate every product request from the live console
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish the selected control state
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'native-editor-csrf', active: true, deviceName: 'Native editor fixture', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    // mount one workspace with the configured-editor capability
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard(configured, workspace) });
    // authorize dashboard streaming
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'native-editor-dashboard-ticket' } });
    // authorize agent and terminal streaming
    if (path === '/api/agents/agent-cora/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'native-editor-pane-ticket' } });
    // keep prompt collections empty
    if (path === '/api/agents/agent-cora/saved-prompts' || path === '/api/agents/agent-cora/queued-prompts' || path === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // keep slash commands empty
    if (path === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    // keep prompt attachments empty
    if (path === '/api/agents/agent-cora/message-files') return route.fulfill({ json: { files: [] } });
    // keep workspace notes empty
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // publish every created terminal
    if (path === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes } });
    // return a stable empty comparison for retained Code lifecycle coverage
    if (path === '/api/worktrees/cora/comparison' && request.method() === 'POST') return route.fulfill({ json: { kind: 'working', base: 'HEAD', gitBase: 'HEAD', files: [], fingerprint: 'native-editor-empty', truncated: false } });
    // create only a terminal; settings file resolution remains a server concern
    if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') {
      state.shellBodies.push(request.postDataJSON());
      const index = state.shellBodies.length;
      const reply = replies.shift();
      // make successful shells discoverable
      if (reply?.kind === 'success' || reply === undefined) panes.push({ paneId: `%${index + 8}`, session: '$editor', window: `@${index}`, command: 'nvim', path: '/synthetic/worktree', title: '', agent: false, role: 'shell', name: `editor ${index}` });
      await fulfillShell(route, reply, index);
      return;
    }
    // report one settled settings runtime
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    // publish the redacted catalog
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'settings-snapshot-current', sources, status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
    // record every settings side effect that opening a terminal must avoid
    if (path === '/api/settings' && request.method() === 'PATCH') { state.saves += 1; return route.fulfill({ status: 500, json: { error: 'The fixture never saves.' } }); }
    // reject unintended validation
    if (path === '/api/settings/validate') { state.validations += 1; return route.fulfill({ status: 500, json: { error: 'The fixture never validates.' } }); }
    // disclose the protected source only after its explicit editor action
    if (path === '/api/settings/reveal' && request.method() === 'POST') {
      const body = request.postDataJSON() as { sourceId: string; revisionId: string };
      state.reveals += 1;
      const source = sources.find(candidate => candidate.id === body.sourceId);
      return route.fulfill({ json: { value: source?.content?.replaceAll(protectedMarker, disclosedSecret) ?? '', revisionId: body.revisionId, leaseId: `native-editor-lease-${state.reveals}`, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    // record whole-source lease revocation separately from persistence
    if (path === '/api/settings/remask' && request.method() === 'POST') { state.remasks += 1; return route.fulfill({ status: 204, body: '' }); }
    // reject unintended restart
    if (path === '/api/settings/restart') { state.restarts += 1; return route.fulfill({ status: 500, json: { error: 'The fixture never restarts.' } }); }
    // disable agent update notices
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // disable server update notices
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });
  // retain Code independently from a transient Settings-owned preview
  if (options.retainedCode === true) await page.addInitScript(() => localStorage.setItem('rac.code-open:cora', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('searchbox', { name: 'Search settings', exact: true })).toBeVisible();
  return { settings, state };
}

// select one synthetic installation source
async function selectSource(settings: Locator, label: string) {
  const visibleLabel = label === 'Application config' ? 'Application' : label;
  const escaped = visibleLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const name = new RegExp(`^${escaped}(?: (?:· )?Unsaved changes)?$`, 'u');
  const selector = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  // use the mobile dropdown at phone and tablet widths
  if (await selector.isVisible()) {
    await selector.click();
    await selector.page().getByRole('listbox', { name: 'Settings section options', exact: true }).getByRole('option', { name }).click();
  } else await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name }).click();
}

// open the source's whole-file representation
async function openRawSource(settings: Locator, label: string) {
  await selectSource(settings, label);
  const edit = settings.getByRole('button', { name: label === 'Application config' ? 'Edit base file' : 'Edit whole source' });
  // advanced sources already default to their raw representation
  if (await edit.count() > 0) await edit.click();
  return settings.getByLabel(`${label} source content`);
}

// explicitly disclose protected whole-source bytes before editing or launching
async function revealRawSource(settings: Locator) {
  await settings.getByRole('button', { name: 'Reveal keys', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Mask keys', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

// require terminal launches to stay independent of Settings persistence
function expectNoSettingsSideEffects(state: NativeEditorState, expectedDisclosures = { reveals: 0, remasks: 0 }) {
  expect({ saves: state.saves, validations: state.validations, reveals: state.reveals, remasks: state.remasks, restarts: state.restarts }).toEqual({ saves: 0, validations: 0, ...expectedDisclosures, restarts: 0 });
}

// keep the labeled launch beside formatting without covering editable code
async function expectToolbarEditorAction(editor: Locator, expectedButtons = 2) {
  const toolbar = editor.locator('.settings-code-editor-toolbar');
  const launch = toolbar.getByRole('button', { name: 'Open in Editor', exact: true });
  await expect(launch).toBeVisible();
  await expect(launch).toHaveText('Open in Editor');
  await expect(toolbar.getByRole('button')).toHaveCount(expectedButtons);
  await expect(editor.locator('.settings-code-editor-open')).toHaveCount(1);
  await expect(launch.locator('svg path')).toHaveAttribute('d', 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5');
  await expect(editor.locator('.settings-code-editor-surface .settings-code-editor-open')).toHaveCount(0);
  // measure the shared action row at each rendered desktop width
  const geometry = await launch.evaluate(button => {
    const format = button.previousElementSibling;
    const toolbar = button.parentElement;
    // fail explicitly if the action order or row is lost
    if (format === null || toolbar === null) throw new Error('Editor toolbar actions are missing');
    const action = button.getBoundingClientRect();
    const previous = format.getBoundingClientRect();
    const frame = toolbar.getBoundingClientRect();
    return {
      previousLabel: format.textContent,
      gap: action.left - previous.right,
      centerDelta: Math.abs((action.top + action.bottom - previous.top - previous.bottom) / 2),
      labelFits: button.scrollWidth <= button.clientWidth,
      inside: action.left >= frame.left && action.right <= frame.right && action.top >= frame.top && action.bottom <= frame.bottom,
      position: getComputedStyle(button).position,
      overflow: toolbar.scrollWidth - toolbar.clientWidth
    };
  });
  expect(geometry.previousLabel).toBe('Format');
  expect(geometry.gap).toBeGreaterThanOrEqual(0);
  expect(geometry.gap).toBeLessThanOrEqual(12);
  expect(geometry.centerDelta).toBeLessThanOrEqual(1);
  expect(geometry.labelFits).toBe(true);
  expect(geometry.inside).toBe(true);
  expect(geometry.position).toBe('static');
  expect(geometry.overflow).toBe(0);
}

test.describe.configure({ timeout: 90_000 });

test('previews base Compose in the active workspace Code split and returns to Docker', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupNativeEditor(page);
  await selectSource(settings, 'Docker');
  await settings.getByRole('button', { name: 'View base compose.yaml', exact: true }).click();

  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code).toBeVisible();
  await expect(code.getByRole('button', { name: '‹ Settings', exact: true })).toBeVisible();
  await expect(code.locator('.code-pane-crumb-current')).toHaveText('compose.yaml');
  await expect(code.getByText('ghcr.io/example/rac:base')).toBeVisible();
  await expect(code.getByText(/RAC_TOKEN:\s+"\*{8}"/u)).toBeVisible();
  await expect(code.getByRole('button', { name: /Open .* in the editor/u })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(protectedMarker);

  await code.getByRole('button', { name: '‹ Settings', exact: true }).click();
  await expect(code).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Docker', exact: true })).toBeVisible();
  expect(state.shellBodies).toEqual([]);
  expectNoSettingsSideEffects(state);

  // closing Settings retires a transient preview owned by this workspace
  await settings.getByRole('button', { name: 'View base compose.yaml', exact: true }).click();
  await expect(code).toBeVisible();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(code).toHaveCount(0);
  await expect(page.getByRole('button', { name: '‹ Settings', exact: true })).toHaveCount(0);
});

test('returns a retained workspace Code split to its comparison when Settings closes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupNativeEditor(page, { retainedCode: true });
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code.getByText('No changes to show.', { exact: true })).toBeVisible();
  await selectSource(settings, 'Docker');
  await settings.getByRole('button', { name: 'View base compose.yaml', exact: true }).click();
  await expect(code.getByRole('button', { name: '‹ Settings', exact: true })).toBeVisible();

  // only the Settings-owned file view closes; retained Changes remains open
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(code).toBeVisible();
  await expect(code.getByText('No changes to show.', { exact: true })).toBeVisible();
  await expect(code.getByRole('button', { name: '‹ Settings', exact: true })).toHaveCount(0);
  expect(state.shellBodies).toEqual([]);
  expectNoSettingsSideEffects(state);
});

test('opens a saved raw source in a focused terminal while preserving the Settings draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupNativeEditor(page);
  const input = await openRawSource(settings, 'Docker');
  const editor = input.locator('..').locator('..');
  const launch = editor.getByRole('button', { name: 'Open in Editor' });
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveValue(savedComposeContent.replace(protectedMarker, '********'));
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveAttribute('title', 'This field is currently read-only or busy.');
  expect(state.shellBodies).toHaveLength(0);
  await revealRawSource(settings);
  const draft = `services:\n  remote-agent-console:\n    environment:\n      LOCAL_ONLY: browser-draft-must-not-submit\n      RAC_TOKEN: "${disclosedSecret}"\n`;
  await input.fill(draft);
  await expect(launch).toBeVisible();
  await expect(launch).toHaveAttribute('title', 'Open the saved Docker file in the configured terminal editor. Unsaved changes stay here. Keys will be visible in the terminal.');
  await expect(launch).toHaveAccessibleDescription('Open the saved Docker file in the configured terminal editor. Unsaved changes stay here. Keys will be visible in the terminal.');

  await expectToolbarEditorAction(editor, 3);

  // restore an expanded Settings panel before the terminal takes focus
  await settings.getByRole('button', { name: 'Expand settings' }).click();
  await expect(settings).toHaveClass(/expanded/u);
  await launch.click();
  await expect.poll(() => state.shellBodies.length).toBe(1);
  expect(state.shellBodies[0]).toEqual({ editor: true, settingsSource: { sourceId: 'compose-override', revisionId: 'compose-override-revision-current' } });
  const payload = JSON.stringify(state.shellBodies[0]);
  expect(payload).not.toContain('/synthetic/');
  expect(payload).not.toContain('browser-draft-must-not-submit');
  expect(payload).not.toContain(protectedMarker);
  expect(payload).not.toContain(disclosedSecret);
  await expect(settings).toBeVisible();
  await expect(settings).not.toHaveClass(/expanded/u);
  await expect(input).toHaveValue(draft);
  const terminal = page.locator('.terminal-pane[data-panel-key="%9"]');
  await expect(terminal).toBeVisible();
  await seedPaneSize(page, '%9', 80, 24);
  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
  expectNoSettingsSideEffects(state, { reveals: 1, remasks: 0 });
});

test('uses the source revision for nested JSON without committing its browser draft', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const { settings, state } = await setupNativeEditor(page);
  await selectSource(settings, 'Application config');
  const input = settings.getByRole('textbox', { name: 'Advanced JSON' });
  const draft = '{"mode":"local-only","private":"nested-browser-draft"}';
  await input.fill(draft);
  const editor = input.locator('..').locator('..');
  const launch = editor.getByRole('button', { name: 'Open in Editor' });
  await expect(launch).toHaveAttribute('title', 'Open the saved Application config file in the configured terminal editor. Unsaved changes stay here.');
  await expectToolbarEditorAction(editor);
  await launch.click();
  await expect.poll(() => state.shellBodies.length).toBe(1);
  expect(state.shellBodies[0]).toEqual({ editor: true, settingsSource: { sourceId: 'app', revisionId: 'app-revision-current' } });
  expect(JSON.stringify(state.shellBodies[0])).not.toContain('nested-browser-draft');
  await expect(input).toHaveValue(draft);
  expectNoSettingsSideEffects(state);
});

test('maps retryable endpoint failures without changing or disclosing the draft', async ({ page }) => {
  const failures = [
    { status: 409, error: 'settings_conflict', message: 'The saved file changed. Refresh files before opening it in the editor.' },
    { status: 409, error: 'settings_source_unavailable', message: 'This saved source is unavailable. Refresh files before trying again.' },
    { status: 503, error: 'settings_applier_unavailable', message: 'The Settings host bridge is unavailable. Restore it before opening this source.' },
    { status: 503, error: 'The configured editor is temporarily unavailable.', message: 'The configured editor is temporarily unavailable.' }
  ];
  const { settings, state } = await setupNativeEditor(page, { shellReplies: [...failures.map(failure => ({ kind: 'failure' as const, status: failure.status, error: failure.error })), { kind: 'success' }] });
  const input = await openRawSource(settings, 'Application config');
  const draft = '{"local":"retry-draft-must-stay-private"}\n';
  await input.fill(draft);
  const editor = input.locator('..').locator('..');
  const launch = editor.getByRole('button', { name: 'Open in Editor' });
  // keep every stable backend failure actionable and free of raw diagnostics
  for (const failure of failures) {
    await launch.click();
    await expect(editor.getByRole('alert')).toHaveText(failure.message);
    await expect(launch).toBeEnabled();
    await expect(input).toHaveValue(draft);
  }
  await launch.click();
  await expect.poll(() => state.shellBodies.length).toBe(failures.length + 1);
  await expect(editor.getByRole('alert')).toHaveCount(0);
  expect(state.shellBodies).toEqual(Array.from({ length: failures.length + 1 }, () => ({ editor: true, settingsSource: { sourceId: 'app', revisionId: 'app-revision-current' } })));
  expect(JSON.stringify(state.shellBodies)).not.toContain('retry-draft-must-stay-private');
  await expect(input).toHaveValue(draft);
  expectNoSettingsSideEffects(state);
});

test('discards late editor feedback after the selected source changes', async ({ page }) => {
  let releaseFailure!: (value: { status: number; error: string }) => void;
  const heldFailure = new Promise<{ status: number; error: string }>(resolve => { releaseFailure = resolve; });
  const { settings, state } = await setupNativeEditor(page, { shellReplies: [{ kind: 'held', release: heldFailure }] });
  const composeInput = await openRawSource(settings, 'Docker');
  await revealRawSource(settings);
  await composeInput.fill('services:\n  browser-only: true\n');
  const launch = composeInput.locator('..').locator('..').getByRole('button', { name: 'Open in Editor' });
  await launch.click();
  await expect.poll(() => state.shellBodies.length).toBe(1);
  await selectSource(settings, 'Application config');
  await expect(settings.getByRole('textbox', { name: 'Advanced JSON' })).toBeVisible();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/worktrees/cora/shells' && response.status() === 409);
  releaseFailure({ status: 409, error: 'settings_conflict' });
  await lateResponse;
  await expect.poll(() => settings.getByRole('alert').filter({ hasText: 'saved file changed' }).count()).toBe(0);
  await expect(settings).not.toContainText('settings_conflict');
  await selectSource(settings, 'Docker');
  // returning after disclosure revocation restores only the safe masked source
  await expect(settings.getByLabel('Docker source content')).toHaveAttribute('readonly', '');
  await expect(settings.getByLabel('Docker source content')).toHaveValue(savedComposeContent.replace(protectedMarker, '********'));
  await revealRawSource(settings);
  await expect(settings.getByLabel('Docker source content')).toHaveValue(savedComposeContent.replace(protectedMarker, disclosedSecret));
  await expect(settings.getByLabel('Docker source content')).not.toHaveValue('services:\n  browser-only: true\n');
  expectNoSettingsSideEffects(state, { reveals: 2, remasks: 1 });
});

test('hides the action on phones and disables unsupported desktop launch states', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 820 });
  const { settings } = await setupNativeEditor(page);
  const input = await openRawSource(settings, 'Application config');
  const editor = input.locator('..').locator('..');
  await expect(editor.locator('.settings-code-editor-open')).toBeHidden();
  await expect(editor.getByRole('button', { name: 'Open in Editor' })).toHaveCount(0);

  // the same DOM capability appears at the desktop breakpoint
  await page.setViewportSize({ width: 601, height: 820 });
  await expect(editor.getByRole('button', { name: 'Open in Editor' })).toBeVisible();
  await expectToolbarEditorAction(editor);

  // an unsaved wrapper is immediately editable but cannot launch a host file
  await selectSource(settings, 'TMUX');
  await expect(settings.getByLabel('Installation wrapper source content')).toBeEditable();
  await expect(settings.getByLabel('Installation wrapper source content')).toHaveValue('');
  await expect(settings.getByRole('button', { name: 'Create source' })).toHaveCount(0);
  const missing = settings.locator('.settings-code-editor').getByRole('button', { name: 'Open in Editor' });
  await expect(missing).toBeDisabled();
  await expect(missing).toHaveAttribute('title', 'Save this source before opening it in the editor.');
  await selectSource(settings, 'Read-only source');
  const locked = settings.locator('.settings-code-editor').getByRole('button', { name: 'Open in Editor' });
  await expect(locked).toBeDisabled();
  await expect(locked).toHaveAttribute('title', 'This source is read-only in the current installation.');
  await expect(locked).toHaveAccessibleDescription('This source is read-only in the current installation.');
});

// unconfigured editors have no launch affordance or disabled placeholder
for (const width of [390, 601, 1440]) {
  test(`omits editor launch without a configured editor at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupNativeEditor(page, { configured: false });
    const input = await openRawSource(settings, 'Application config');
    const editor = input.locator('..').locator('..');
    await expect(editor.locator('.settings-code-editor-open')).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Format', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Pretty format', exact: true })).toHaveCount(0);
    await expect(editor.locator('.settings-code-editor-launch-description')).toHaveCount(0);
    expectNoSettingsSideEffects(state);
  });
}

// a configured editor remains informative when its workspace is unavailable
test('disables configured editor launch without a workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const { settings, state } = await setupNativeEditor(page, { workspace: false });
  const input = await openRawSource(settings, 'Application config');
  const editor = input.locator('..').locator('..');
  const launch = editor.getByRole('button', { name: 'Open in Editor', exact: true });
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveText('Open in Editor');
  await expect(launch).toHaveAttribute('title', 'Open a workspace to launch the configured terminal editor.');
  await expect(editor.locator('.settings-code-editor-open')).toHaveCount(1);
  expectNoSettingsSideEffects(state);
});
