import { expect, test, type Page, type Request, type Locator } from '@playwright/test';
import { installPaneMock, paneInputText, pushBytes, pushQuestion, seedPaneSize } from './pane-stream-mock.js';

type Mutation = { method: string; path: string; body: unknown };
// retain browser globals alongside the injected clipboard fixture
type ClipboardWindow = typeof window & { __contextClipboard: {
  text: string;
  image: boolean;
  denied: boolean;
  writeDenied: boolean;
  deferWrite: boolean;
  pendingWrites: number;
  releaseWrite?: () => void;
  writes: string[];
} };

const coraId = 'repo:/repo/wts/cora';
const idleId = 'repo:/repo/wts/idle';
const cora = { id: coraId, projectId: 'repo', label: 'Cora', path: '/repo/wts/cora', main: false, detached: false, locked: false, branch: 'feature/context-menu', available: true, pinned: false, order: 0 };
const idle = { id: idleId, projectId: 'repo', label: 'Idle', path: '/repo/wts/idle', main: false, detached: false, locked: false, branch: 'idle', available: true, pinned: true, order: 1 };
const davo = { enabled: true, available: true, name: 'Davo', context: 'Be concise.' };
type FileDavo = Pick<typeof davo, 'enabled' | 'name' | 'context'>;
const codePatch = {
  kind: 'working', base: 'HEAD', gitBase: 'HEAD', fingerprint: 'context-menu-code', truncated: false,
  files: [{
    change: { code: ' M', path: 'src/context.ts', additions: 1, deletions: 1 }, kind: 'tracked', capped: false,
    patch: 'diff --git a/src/context.ts b/src/context.ts\nindex 1111111..2222222 100644\n--- a/src/context.ts\n+++ b/src/context.ts\n@@ -1 +1 @@\n-export const contextSelection = false;\n+export const contextSelection = true;\n'
  }]
};

// install a controllable rich Async Clipboard fixture before the app loads
async function installClipboardMock(page: Page, text = '', image = false) {
  await page.addInitScript(({ initialText, initialImage }) => {
    const state = {
      text: initialText,
      image: initialImage,
      denied: false,
      writeDenied: false,
      deferWrite: false,
      pendingWrites: 0,
      releaseWrite: undefined as (() => void) | undefined,
      writes: [] as string[]
    };
    const clipboard = {
      // expose rich text and image representations to context-menu paste
      read: async () => {
        // emulate a browser permission denial on demand
        if (state.denied) throw new DOMException('Clipboard access denied', 'NotAllowedError');
        const types = [...(state.text ? ['text/plain'] : []), ...(state.image ? ['image/png'] : [])];
        // represent an empty clipboard with no items
        if (types.length === 0) return [];
        return [{
          types,
          // return only advertised fixture formats
          getType: async (type: string) => {
            if (type === 'text/plain') return new Blob([state.text], { type });
            if (type === 'image/png') return new Blob([new Uint8Array([137, 80, 78, 71])], { type });
            throw new DOMException('Unsupported fixture type', 'NotFoundError');
          }
        }];
      },
      readText: async () => state.text,
      writeText: async (value: string) => {
        // emulate an asynchronous clipboard write rejection on demand
        if (state.writeDenied) throw new DOMException('Clipboard write denied', 'NotAllowedError');
        // hold a write so the source can change while clipboard access is pending
        if (state.deferWrite) await new Promise<void>(resolve => {
          state.pendingWrites += 1;
          state.releaseWrite = () => {
            state.pendingWrites -= 1;
            state.releaseWrite = undefined;
            resolve();
          };
        });
        state.writes.push(value);
      }
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    Object.defineProperty(window, '__contextClipboard', { configurable: true, value: state });
  }, { initialText: text, initialImage: image });
}

// capture one request mutation without relying on Request.postDataJSON throwing for empty bodies
function mutation(request: Request): Mutation {
  let body: unknown;
  try { body = request.postDataJSON(); }
  catch { body = request.postData(); }
  return { method: request.method(), path: decodeURIComponent(new URL(request.url()).pathname), body };
}

// serve two workspaces, a live Agent, one shell and one Note for contextual-action coverage
async function mountConsole(page: Page, { coraPinned = cora.pinned, sessionDavo = davo, authoritativeDavo = davo, enabledPathRevision }: { coraPinned?: boolean; sessionDavo?: typeof davo; authoritativeDavo?: FileDavo; enabledPathRevision?: string } = {}) {
  const mutations: Mutation[] = [];
  const fixtureCora = { ...cora, pinned: coraPinned };
  const settingsState = { davo: { enabled: authoritativeDavo.enabled, name: authoritativeDavo.name, context: authoritativeDavo.context } };
  let runtimeDavo = { ...sessionDavo };
  let settingsRevision = 1;
  const settingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
  const appSource = {
    id: 'app', label: 'Application config', path: '/fixture/config/config.json', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: `app-context-r${settingsRevision}`, apply: 'rac-restart',
    ...(enabledPathRevision === undefined ? {} : { pathRevisions: { '["integrations","realtime","enabled"]': enabledPathRevision } }),
    value: { integrations: { realtime: { ...settingsState.davo } } },
    schema: { type: 'object', properties: { integrations: { type: 'object', properties: { realtime: { type: 'object', properties: { enabled: { type: 'boolean' }, name: { type: 'string' }, context: { type: 'string' } } } } } } }
  };
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    // retain every write so non-destructive menu actions can be proven
    if (request.method() !== 'GET') mutations.push(mutation(request));
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'context-csrf', active: true, deviceName: 'Test device', davo: runtimeDavo, server: { name: 'Framework', url: 'https://framework.test', remotes: [] } } });
    // provide the authoritative application source used by contextual voice actions
    if (path === '/api/settings/status') return route.fulfill({ json: settingsStatus });
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: `context-settings-r${settingsRevision}`, sources: [appSource], status: settingsStatus } });
    // apply only the requested voice feature gate and retain newer file values
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { changes?: Array<{ sourceId?: string; patches?: Array<{ op?: string; path?: string[]; value?: unknown }> }> };
      const patch = body.changes?.find(change => change.sourceId === 'app')?.patches?.find(candidate => candidate.path?.join('.') === 'integrations.realtime.enabled');
      // reject a malformed contextual disable instead of masking a regression
      if (patch?.op !== 'set' || typeof patch.value !== 'boolean') return route.fulfill({ status: 400, json: { error: 'Expected one voice enabled patch.' } });
      settingsState.davo = { ...settingsState.davo, enabled: patch.value };
      appSource.value.integrations.realtime = { ...settingsState.davo };
      settingsRevision += 1;
      appSource.revisionId = `app-context-r${settingsRevision}`;
      runtimeDavo = { ...settingsState.davo, available: true };
      return route.fulfill({ json: { version: 1, revisionId: `context-settings-r${settingsRevision}`, sources: [appSource], status: settingsStatus } });
    }
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: cora.path, placeId: coraId, worktreeId: coraId, projectId: 'repo', worktreeLabel: cora.label, title: 'Ready', branch: cora.branch, projectUrl: 'https://project.example.test', queuedPromptCount: 0 }],
      projects: [{ id: 'repo', label: 'Repo', available: true, manageWorktrees: true, worktrees: [fixtureCora, idle] }]
    } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/server/revision') return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    if (path === '/api/server-statuses') return route.fulfill({ json: { servers: [] } });
    if (path === '/api/agents/agent-1/tickets' || path === `/api/worktrees/${coraId}/tickets`) return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (path === `/api/worktrees/${coraId}/notes` && request.method() === 'GET') return route.fulfill({ json: { notes: [{ id: 'note-1', title: 'Plan', text: 'Context menu plan' }] } });
    if (path.endsWith('/notes') && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (path === `/api/worktrees/${coraId}/comparison`) return route.fulfill({ json: codePatch });
    if (path === `/api/worktrees/${coraId}/panes`) return route.fulfill({ json: { panes: [{ paneId: '%5', session: '$1', window: '@5', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: 'build', agent: false }] } });
    if (path.endsWith('/panes')) return route.fulfill({ json: { panes: [] } });
    if (path.endsWith('/pin') && request.method() === 'POST') return route.fulfill({ status: 204, body: '' });
    if (path.endsWith('/label') && request.method() === 'PATCH') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  return { mutations, settingsState };
}

// open all non-Agent split kinds through the same visible controls a user operates
async function openWorkspaceSplits(page: Page) {
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await toolbar.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Browser', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await expect(page.locator('.note-pane')).toBeVisible();
  await expect(page.locator('.browser-pane')).toBeVisible();
  await expect(page.locator('.code-pane')).toBeVisible();
}

// dispatch a real MouseEvent at an exact viewport point for clamping checks
const contextAt = (page: Page, selector: string, x: number, y: number) => page.locator(selector).evaluate((element, point) => {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: point.x, clientY: point.y }));
}, { x, y });

test('shared context menu clamps to the viewport and dismisses by Escape or outside press', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await mountConsole(page);
  const tab = page.getByRole('tab', { name: /^Cora —/u });
  await contextAt(page, '#tab-0', 1278, 758);
  const menu = page.getByRole('menu', { name: 'Cora workspace' });
  await expect(menu).toBeVisible();
  const pin = menu.getByRole('menuitemcheckbox', { name: 'Pin workspace' });
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  await expect(pin.locator('.context-menu-mark svg')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  const agentSplit = menu.getByRole('menuitem', { name: 'Agent output', exact: true });
  await expect(agentSplit.locator('.context-menu-mark').locator('svg, span')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: /^Jump to /u })).toHaveCount(0);
  await expect.poll(() => menu.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 8 && bounds.top >= 8 && bounds.right <= 1272 && bounds.bottom <= 752;
  })).toBe(true);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  await page.screenshot({ path: '/tmp/context-menu-desktop.png' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await tab.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.locator('.workspace-toolbar').click({ position: { x: 2, y: 2 } });
  await expect(menu).toHaveCount(0);
});

test('right click opens split-button flyouts without running their primary action', async ({ page }) => {
  await mountConsole(page);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const primary = toolbar.getByRole('button', { name: /^Launch/u }).first();
  const launchesBefore = await page.locator('.agent-panel').count();
  await primary.click({ button: 'right' });
  await expect(page.getByRole('group', { name: /Launch agent/u })).toBeVisible();
  expect(await page.locator('.agent-panel').count()).toBe(launchesBefore);
});

test('Davo context action disables Davo without opening a call', async ({ page }) => {
  const fixture = await mountConsole(page);
  const call = page.locator('.tab-row-lead').getByRole('button', { name: 'Call Davo' });
  await call.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Davo options' });
  await expect(menu).toBeVisible();
  await expect(page.locator('.voice-dialog')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Disable Davo' }).click();
  await expect.poll(() => fixture.mutations.filter(entry => entry.path === '/api/settings')).toEqual([
    { method: 'PATCH', path: '/api/settings', body: { changes: [{ sourceId: 'app', revisionId: 'app-context-r1', patches: [{ op: 'set', path: ['integrations', 'realtime', 'enabled'], value: false }] }] } }
  ]);
  expect(fixture.mutations.filter(entry => entry.path === '/api/server/davo')).toEqual([]);
  expect(fixture.settingsState.davo).toEqual({ enabled: false, name: 'Davo', context: 'Be concise.' });
  await expect(page.locator('.voice-dialog')).toHaveCount(0);
  await expect(call).toHaveCount(0);
});

// disable from the authoritative source when runtime voice metadata is stale
test('Davo context action preserves newer file-backed identity and context', async ({ page }) => {
  const fixture = await mountConsole(page, {
    sessionDavo: { enabled: true, available: true, name: 'Davo', context: 'Old runtime context.' },
    authoritativeDavo: { enabled: true, name: 'Riley', context: 'New file-backed context.' },
    enabledPathRevision: 'voice-enabled-r7'
  });
  const call = page.locator('.tab-row-lead').getByRole('button', { name: 'Call Davo' });
  await call.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Davo options' }).getByRole('menuitem', { name: 'Disable Davo' }).click();

  await expect.poll(() => fixture.mutations.filter(entry => entry.path === '/api/settings')).toEqual([
    { method: 'PATCH', path: '/api/settings', body: { changes: [{ sourceId: 'app', revisionId: 'app-context-r1', patches: [{ op: 'set', path: ['integrations', 'realtime', 'enabled'], value: false, revisionId: 'voice-enabled-r7' }] }] } }
  ]);
  expect(fixture.mutations.filter(entry => entry.path === '/api/server/davo')).toEqual([]);
  expect(fixture.settingsState.davo).toEqual({ enabled: false, name: 'Riley', context: 'New file-backed context.' });
  await expect(call).toHaveCount(0);
});

// retain workspace and agent actions across responsive layouts
test('workspace actions target inactive tabs, restore splits and keep responsive launch counts anchored', async ({ page }) => {
  const fixture = await mountConsole(page);
  await openWorkspaceSplits(page);
  const idleTab = page.getByRole('tab', { name: /^Idle —/u });
  await idleTab.click();
  await idleTab.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Idle workspace' });
  const pinned = menu.getByRole('menuitemcheckbox', { name: 'Unpin workspace' });
  await expect(pinned).toHaveAttribute('aria-checked', 'true');
  await expect(pinned.locator('.context-menu-mark svg')).toHaveCount(1);
  await expect(pinned.locator('.context-menu-mark')).not.toContainText('✓');
  await page.screenshot({ path: '/tmp/context-menu-desktop-pinned.png' });
  await page.keyboard.press('Escape');

  const coraTab = page.getByRole('tab', { name: /^Cora —/u });
  await coraTab.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Cora workspace' });
  const pin = menu.getByRole('menuitemcheckbox', { name: 'Pin workspace' });
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  await expect(pin.locator('.context-menu-mark svg')).toHaveCount(0);
  await pin.click();
  await expect.poll(() => fixture.mutations.some(entry => entry.path === `/api/worktrees/${coraId}/pin`)).toBe(true);
  expect(fixture.mutations.some(entry => entry.path === `/api/worktrees/${idleId}/pin`)).toBe(false);

  await coraTab.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Cora workspace' });
  await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename worktree' });
  await rename.getByRole('textbox', { name: 'Worktree name' }).fill('Cora Context');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => fixture.mutations.some(entry => entry.path === `/api/worktrees/${coraId}/label` && (entry.body as { label?: string } | null)?.label === 'Cora Context')).toBe(true);

  const renamedTab = page.getByRole('tab', { name: /^Cora Context —/u });
  await renamedTab.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Cora Context workspace' });
  // verify every retained split keeps its type glyph beside the verb-free label
  for (const splitLabel of ['Agent output', 'Terminal build', 'Project browser', 'Code changes', 'Note']) {
    const split = menu.getByRole('menuitem', { name: splitLabel, exact: true });
    await expect(split).toBeVisible();
    await expect(split.locator('.context-menu-mark').locator('svg, span')).toHaveCount(1);
  }
  await expect(menu.getByRole('menuitem', { name: /^Jump to /u })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Project browser', exact: true }).click();
  await expect(renamedTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.browser-pane')).toBeFocused();

  await renamedTab.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Cora Context workspace' });
  await menu.getByRole('menuitem', { name: 'Close all splits' }).click();
  await expect(page.locator('.log-output, .terminal-pane, .note-pane, .browser-pane, .code-pane')).toHaveCount(0);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: 'Show agent' })).toBeVisible();
  expect(fixture.mutations.some(entry => entry.method === 'DELETE' || entry.path.endsWith('/deactivate'))).toBe(false);
  await toolbar.getByRole('button', { name: 'Show agent' }).click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(toolbar.locator('.launch-minimized-count')).toHaveCount(0);

  // retain a visible terminal while exercising the minimized agent launcher
  await page.setViewportSize({ width: 1440, height: 900 });
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: /build/u }).click();
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  // the agent header minimizes with a sibling, and launch restores it without launching
  await page.getByRole('button', { name: 'Minimize agent output' }).click();
  await expect(page.locator('.log-output')).toHaveCount(0);
  await expect(toolbar.locator('.launch-minimized-count')).toHaveText('1');
  let phoneAnchor: { top: number; right: number } | undefined;
  // cover both the label breakpoint and the separate responsive launch branch
  for (const width of [390, 600, 601, 768, 769, 1440]) {
    // label the failing viewport without duplicating the fixture
    await test.step(`${width}px minimized launcher`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const menuOnly = width <= 768;
      const launch = toolbar.locator('.launch-split');
      const primary = launch.locator(menuOnly ? ':scope > .launch-menu-trigger' : ':scope > .launch-primary');
      const badge = launch.locator('.launch-minimized-count');
      await expect(primary).toHaveAccessibleName('Show agent');
      await expect(launch.locator(':scope > button')).toHaveCount(menuOnly ? 1 : 2);
      await expect(primary.locator('.launch-menu-trigger-label, .launch-primary-label')).toBeVisible({ visible: width > 600 });
      await expect(badge).toHaveText('1');
      await expect(badge).toBeInViewport({ ratio: 1 });
      const [ownerBox, badgeBox] = await Promise.all([launch.boundingBox(), badge.boundingBox()]);
      // require rendered controls before comparing their edges
      if (ownerBox === null || badgeBox === null) throw new Error('Expected a visible launch control and count');
      expect(badgeBox.y).toBeLessThan(ownerBox.y);
      expect(badgeBox.y + badgeBox.height).toBeGreaterThan(ownerBox.y);
      expect(badgeBox.x).toBeLessThan(ownerBox.x + ownerBox.width);
      expect(badgeBox.x + badgeBox.width).toBeGreaterThan(ownerBox.x + ownerBox.width);
      // icon-only launchers stay square while labels expand the control
      if (width <= 600) expect(Math.abs(ownerBox.width - ownerBox.height)).toBeLessThanOrEqual(1);
      else expect(ownerBox.width).toBeGreaterThan(ownerBox.height);
      const anchor = { top: badgeBox.y - ownerBox.y, right: ownerBox.x + ownerBox.width - badgeBox.x - badgeBox.width };
      // retain the first phone anchor across both responsive dom branches
      phoneAnchor ??= anchor;
      expect(anchor.top).toBeCloseTo(phoneAnchor.top, 1);
      expect(anchor.right).toBeCloseTo(phoneAnchor.right, 1);
    });
  }
  await toolbar.getByRole('button', { name: 'Show agent' }).click();
  await expect(page.locator('.log-output')).toBeVisible();
  expect(fixture.mutations.some(entry => entry.method === 'DELETE' || entry.path.endsWith('/deactivate') || entry.path.endsWith('/launch'))).toBe(false);
});

test('cancelling dirty Settings preflight leaves every close-all sibling mounted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mountConsole(page);
  await openWorkspaceSplits(page);
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Interface', exact: true }).click();
  await settings.getByRole('radio', { name: 'Light theme', exact: true }).click();

  const tab = page.getByRole('tab', { name: /^Cora —/u });
  await tab.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Cora workspace' })
    .getByRole('menuitem', { name: 'Close all splits', exact: true })
    .click();
  const confirmation = settings.getByRole('alertdialog', {
    name: 'Close Settings with unsaved changes?',
    exact: true,
  });
  await expect(confirmation).toBeVisible();

  // a sibling remains interactive while only Settings is covered
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.xterm-screen').click();
  await expect(terminal).toHaveClass(/focused/u);
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();

  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole('radio', { name: 'Light theme', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.locator('.log-output, .terminal-pane, .note-pane, .browser-pane, .code-pane'),
  ).toHaveCount(5);
  expect(await page.evaluate(key => localStorage.getItem(key), `rac.workspace-empty:place-${coraId}`)).toBeNull();
  expect(
    fixture.mutations.some(
      entry => entry.method === 'DELETE' || entry.path.endsWith('/deactivate'),
    ),
  ).toBe(false);
});

test('mobile workspace context menu stays on screen and right click does not open the workspace sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountConsole(page);
  const tab = page.getByRole('tab', { selected: true });
  await contextAt(page, `#${await tab.getAttribute('id')}`, 388, 842);
  const menu = page.getByRole('menu', { name: 'Cora workspace' });
  await expect(menu).toBeVisible();
  const pin = menu.getByRole('menuitemcheckbox', { name: 'Pin workspace' });
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  await expect(pin.locator('.context-menu-mark svg')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Agent output', exact: true }).locator('.context-menu-mark').locator('svg, span')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Workspaces' })).toHaveCount(0);
  await expect.poll(() => menu.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 8 && bounds.top >= 8 && bounds.right <= 382 && bounds.bottom <= 836;
  })).toBe(true);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  await page.screenshot({ path: '/tmp/context-menu-mobile.png' });
});

test('mobile workspace context menu renders the pinned icon instead of a checkmark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountConsole(page, { coraPinned: true });
  const tab = page.getByRole('tab', { selected: true });
  await contextAt(page, `#${await tab.getAttribute('id')}`, 388, 842);
  const pinnedMenu = page.getByRole('menu', { name: 'Cora workspace' });
  const pinned = pinnedMenu.getByRole('menuitemcheckbox', { name: 'Unpin workspace' });
  await expect(pinned).toHaveAttribute('aria-checked', 'true');
  await expect(pinned.locator('.context-menu-mark svg')).toHaveCount(1);
  await expect(pinned.locator('.context-menu-mark')).not.toContainText('✓');
  await expect(pinnedMenu.getByRole('menuitem', { name: 'Agent output', exact: true }).locator('.context-menu-mark').locator('svg, span')).toHaveCount(1);
  await page.screenshot({ path: '/tmp/context-menu-mobile-pinned.png' });
});

test('prompt menu preserves selection and distinguishes rich paste, plain paste and an empty clipboard', async ({ page }) => {
  await installClipboardMock(page, 'clipboard text', true);
  await mountConsole(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('alpha beta');
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
  await prompt.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu).toBeVisible();
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([6, 10]);
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste plain', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'New note' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add to prompt' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual(['beta']);

  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
  await prompt.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Prompt actions' });
  await menu.getByRole('menuitem', { name: 'Paste plain', exact: true }).click();
  await expect(prompt).toHaveValue('alpha clipboard text');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);

  await page.evaluate(() => { const state = (window as unknown as ClipboardWindow).__contextClipboard; state.text = ''; state.image = true; });
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
  await prompt.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste plain', exact: true })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect(page.getByLabel('Selected attachments')).toContainText('pasted-image-1.png');

  await page.evaluate(() => { const state = (window as unknown as ClipboardWindow).__contextClipboard; state.text = ''; state.image = false; });
  await prompt.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste plain', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.denied = true; });
  await prompt.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu.getByRole('menuitem', { name: 'Paste unavailable' })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste plain' })).toBeDisabled();
});

test('prompt Cut requires a selection, copies exactly and stays absent from readonly output menus', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('alpha beta');
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));
  await prompt.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu.getByRole('menuitem', { name: 'Cut', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
  await prompt.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Prompt actions' });
  const cut = menu.getByRole('menuitem', { name: 'Cut', exact: true });
  await expect(cut).toBeEnabled();
  await cut.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual(['beta']);
  await expect(prompt).toHaveValue('alpha ');
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([6, 6]);

  const output = page.locator('.log-canvas');
  await output.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(menu.getByRole('menuitem', { name: 'Cut', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.getByText('export const contextSelection = true;', { exact: true })).toBeVisible();
  await contextAt(page, '.code-pane > .panel-header', 200, 200);
  menu = page.getByRole('menu', { name: 'Code options' });
  await expect(menu.getByRole('menuitem', { name: 'Cut', exact: true })).toHaveCount(0);
});

test('prompt Cut never deletes text when clipboard writing fails or its draft changes while pending', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  // reopen Cut against the beta substring for each asynchronous failure case
  const openSelectedCut = async () => {
    await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
    await prompt.click({ button: 'right' });
    return page.getByRole('menu', { name: 'Prompt actions' }).getByRole('menuitem', { name: 'Cut', exact: true });
  };

  await prompt.fill('alpha beta');
  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.writeDenied = true; });
  await (await openSelectedCut()).click();
  await expect(prompt).toHaveValue('alpha beta');
  await expect(page.getByRole('alert')).toHaveText('Unable to cut text. Clipboard access was denied or unavailable.');
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual([]);

  await page.evaluate(() => {
    const state = (window as unknown as ClipboardWindow).__contextClipboard;
    state.writeDenied = false;
    state.deferWrite = true;
  });
  await (await openSelectedCut()).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.pendingWrites)).toBe(1);
  await prompt.fill('newer draft');
  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.releaseWrite?.(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.pendingWrites)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual(['beta']);
  await expect(prompt).toHaveValue('newer draft');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await prompt.fill('alpha beta');
  await page.evaluate(() => {
    const clipboard = navigator.clipboard as Clipboard;
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
  });
  await (await openSelectedCut()).click();
  await expect(prompt).toHaveValue('alpha beta');
  await expect(page.getByRole('alert')).toHaveText('Unable to cut text. Clipboard access was denied or unavailable.');
});

test('mouse-open prompt menu consumes ordinary keys instead of editing a stale selection range', async ({ page }) => {
  await installClipboardMock(page, 'replacement');
  await mountConsole(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('alpha beta');
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
  await prompt.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Prompt actions' });
  await expect(menu).toBeVisible();
  await page.keyboard.type('z');
  await expect(prompt).toHaveValue('alpha beta');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Paste plain', exact: true }).click();
  await expect(prompt).toHaveValue('alpha replacement');
});

test('mouse-open agent menu consumes ordinary keys instead of sending terminal input', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const canvas = page.locator('.log-canvas');
  await canvas.click();
  const inputBefore = await paneInputText(page, 'agent-1');
  await canvas.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(menu).toBeVisible();
  await page.keyboard.type('x');
  await expect(menu).toBeVisible();
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe(inputBefore);
});

test('Answer notes retains its native context menu without redirecting clipboard actions to agent output', async ({ page }) => {
  await mountConsole(page);
  await pushQuestion(page, 'agent-1', { id: 'context-question', text: 'Which option?', field: { kind: 'choice', choices: ['First', 'Second'] }, source: 'structured' });
  await page.getByRole('button', { name: 'Add notes' }).click();
  const notes = page.getByRole('textbox', { name: 'Answer notes' });
  await notes.fill('native notes');
  const inputBefore = await paneInputText(page, 'agent-1');
  const contextEvent = await notes.evaluate(element => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 20, clientY: 20 });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched };
  });
  expect(contextEvent).toEqual({ defaultPrevented: false, dispatched: true });
  await expect(page.getByRole('menu', { name: 'Agent actions' })).toHaveCount(0);
  await expect(notes).toHaveValue('native notes');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe(inputBefore);
});

test('keyboard-open prompt and workspace menus focus actions and restore their invocation targets', async ({ page }) => {
  await installClipboardMock(page);
  const fixture = await mountConsole(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('copy me');
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, element.value.length));
  await prompt.focus();
  await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('menu', { name: 'Prompt actions' });
  const selectAll = menu.getByRole('menuitem', { name: 'Select all' });
  await expect(selectAll).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect(prompt).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual(['copy me']);

  const tab = page.getByRole('tab', { name: /^Cora —/u });
  await tab.focus();
  await page.keyboard.press('ContextMenu');
  menu = page.getByRole('menu', { name: 'Cora workspace' });
  const pin = menu.getByRole('menuitemcheckbox', { name: 'Pin workspace' });
  await expect(pin).toBeFocused();
  await pin.click();
  await expect(tab).toBeFocused();
  await expect.poll(() => fixture.mutations.some(entry => entry.path === `/api/worktrees/${coraId}/pin`)).toBe(true);
});

test('note menu preserves selection mode, enters edit mode for paste and exposes selection destinations', async ({ page }) => {
  await installClipboardMock(page, ' pasted note text');
  await mountConsole(page);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const preview = page.getByLabel('Note preview');
  await preview.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Note actions' });
  await expect(menu.getByRole('menuitemradio', { name: 'Selection' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'false');
  await menu.getByRole('menuitem', { name: 'Paste plain' }).click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toHaveValue('Context menu plan pasted note text');
  await expect(editor).toBeFocused();

  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 7));
  await editor.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Note actions' });
  await expect(menu.getByRole('menuitemradio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Add to note' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'New note' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add to prompt' })).toBeVisible();
});

// preserve both invocation paths and exercise the keyboard dismissal lifecycle once
test('note context menu keeps editing through selection and dismissal', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByLabel('Note preview').click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toBeFocused();
  const menu = page.getByRole('menu', { name: 'Note actions' });
  const edit = menu.getByRole('menuitemradio', { name: 'Edit', exact: true });
  // both pointer and keyboard menus must keep select-all in edit mode
  for (const invocation of ['pointer', 'keyboard'] as const) {
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 7));
    // open the same actions through each supported desktop gesture
    if (invocation === 'keyboard') await editor.press('Shift+F10');
    else await editor.click({ button: 'right' });
    await expect(edit).toHaveAttribute('aria-checked', 'true');
    // allow keyboard focus to settle before checking the source editor
    if (invocation === 'keyboard') await expect(edit).toBeFocused();
    await expect(editor).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Select all', exact: true }).click();
    await expect(editor).toBeFocused();
    await expect.poll(() => editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 'Context menu plan'.length]);
  }

  // dismissing a keyboard menu restores the unchanged editor
  await editor.press('Shift+F10');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();

  // leaving the keyboard menu for another field still performs an ordinary blur
  await editor.press('Shift+F10');
  await expect(edit).toBeFocused();
  await page.getByRole('textbox', { name: 'Prompt' }).click();
  await expect(menu).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  await expect(page.getByLabel('Note preview')).toBeVisible();

  // explicit mode choices still switch to preview
  await page.getByLabel('Note preview').click();
  await editor.press('Shift+F10');
  await expect(edit).toBeFocused();
  await menu.getByRole('menuitemradio', { name: 'Selection', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByLabel('Note preview')).toBeVisible();

  // tab navigation leaves the menu and editor normally
  await page.getByLabel('Note preview').click();
  await editor.press('Shift+F10');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(editor).toHaveCount(0);
});

// cover native mobile editing separately from desktop context actions
test.describe('touch text context menus', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // check native-menu eligibility without relying on headless operating-system menus
  const nativeContextEvent = (field: Locator) => field.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(0, 7);
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const event = new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, clientX: bounds.x + parseFloat(style.paddingLeft) + 20, clientY: bounds.y + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched };
  });

  // preserve native prompt selection at both mobile viewport widths
  for (const width of [390, 768]) {
    // retain the native prompt menu across the shared mobile breakpoint
    test(`prompt leaves the native context menu available at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mountConsole(page);
      const prompt = page.getByRole('textbox', { name: 'Prompt' });
      await prompt.fill('native prompt');
      expect(await nativeContextEvent(prompt)).toEqual({ defaultPrevented: false, dispatched: true });
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue('native prompt');
      await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 7]);
    });
  }

  // retain dictation without opening a custom prompt menu on touch holds
  test('prompt dictation never opens a custom context menu on mobile', async ({ page }) => {
    // retain the controlled external speech fixture shape
    type SpeechWindow = typeof window & { __contextSpeech: { starts: number } };
    // model only the external speech-recognition lifecycle
    await page.addInitScript(() => {
      const speech = { starts: 0 };
      class MockSpeechRecognition {
        onend: (() => void) | null = null;
        // record dictation startup without requesting a microphone
        start() { speech.starts += 1; }
        // finish recognition through the browser callback
        abort() { this.onend?.(); }
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockSpeechRecognition });
      Object.defineProperty(window, '__contextSpeech', { configurable: true, value: speech });
    });
    await mountConsole(page);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('native prompt');
    await prompt.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 });
    // wait for speech startup instead of a presentation class
    await expect.poll(() => page.evaluate(() => (window as SpeechWindow).__contextSpeech.starts)).toBe(1);
    await nativeContextEvent(prompt);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(prompt).toHaveValue('native prompt');
    await prompt.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 });
    expect(await nativeContextEvent(prompt)).toEqual({ defaultPrevented: false, dispatched: true });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  // leave mobile note selection and editing to the native menu
  test('note edit mode leaves the native context menu available', async ({ page }) => {
    await installClipboardMock(page);
    await mountConsole(page);
    await page.getByRole('button', { name: 'Notes (1)' }).tap();
    await page.getByRole('button', { name: 'Plan', exact: true }).tap();
    await page.getByLabel('Note preview').tap();
    const editor = page.getByRole('textbox', { name: 'Note content' });
    await expect(editor).toBeFocused();
    expect(await nativeContextEvent(editor)).toEqual({ defaultPrevented: false, dispatched: true });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('Context menu plan');
    await expect.poll(() => editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 7]);

    // a native popup can temporarily blur the editor without transferring focus
    await editor.evaluate((element: HTMLTextAreaElement) => element.blur());
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('Context menu plan');
    await expect.poll(() => editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 7]);
    await editor.focus();
    await expect(editor).toBeFocused();

    // a real focus transfer still returns the note to preview
    await page.getByRole('textbox', { name: 'Prompt' }).focus();
    await expect(editor).toHaveCount(0);
    await expect(page.getByLabel('Note preview')).toBeVisible();
  });

  // retain mobile note preview actions outside edit mode
  test('note preview keeps the custom context menu', async ({ page }) => {
    await installClipboardMock(page);
    await mountConsole(page);
    await page.getByRole('button', { name: 'Notes (1)' }).tap();
    await page.getByRole('button', { name: 'Plan', exact: true }).tap();
    await page.getByLabel('Note preview').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Note actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Selection', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByLabel('Note preview')).toBeVisible();
  });
});

// keyboard menu focus must not turn output mode into prompt mode
test('agent keyboard context menu preserves output mode until an explicit mode choice', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const panel = page.locator('.agent-panel');
  const canvas = page.locator('.log-canvas');
  const input = canvas.getByRole('textbox', { name: 'Terminal input' });
  const menu = page.getByRole('menu', { name: 'Agent actions' });
  await canvas.click({ button: 'right' });
  await menu.getByRole('menuitemradio', { name: 'Output', exact: true }).click();
  await expect(input).toBeFocused();
  await expect(panel).toHaveClass(/\binput-active\b/u);
  await input.press('ContextMenu');
  await expect(menu.getByRole('menuitemradio', { name: 'Prompt', exact: true })).toBeFocused();
  await expect(panel).toHaveClass(/\binput-active\b/u);
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(panel).toHaveClass(/\binput-active\b/u);

  // restore the source before choosing a different focus destination
  await input.press('ContextMenu');
  await expect(menu.getByRole('menuitemradio', { name: 'Prompt', exact: true })).toBeFocused();
  await menu.getByRole('menuitemradio', { name: 'Prompt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await expect(panel).not.toHaveClass(/\binput-active\b/u);
});

test('agent output menu preserves selection, copies without gutter columns and pastes in output mode', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const panel = page.locator('.agent-panel');
  const canvas = page.locator('.log-canvas');
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}01Context selection text`);
  const row = canvas.locator('.xterm-rows > div', { hasText: '01Context selection text' });
  await expect(row).toBeVisible();

  await canvas.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Copy URL', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  const bounds = await row.boundingBox();
  expect(bounds).not.toBeNull();
  const cellWidth = await canvas.locator('.xterm-char-measure-element').first().evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.width / (element.textContent?.length ?? 1);
  });
  const selectedY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(bounds!.x + cellWidth * .25, selectedY);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + cellWidth * ('01Context selection text'.length - .25), selectedY, { steps: 4 });
  await page.mouse.up();
  await canvas.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(menu.getByRole('menuitemradio', { name: 'Selection' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'New note' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add to prompt' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes.at(-1))).toBe('Context selection text');

  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.text = 'terminal paste'; });
  await canvas.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(menu.getByRole('menuitem', { name: 'Paste plain', exact: true })).toBeEnabled();
  await menu.getByRole('menuitem', { name: 'Paste plain', exact: true }).click();
  await expect(canvas.locator('textarea')).toBeFocused();
  await expect.poll(() => paneInputText(page, 'agent-1')).toContain('terminal paste');
});

// copy detected links from both output surfaces without requiring a text selection
test('output link menus copy the target URL', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  await seedPaneSize(page, 'agent-1', 31, 24);
  const agentUrl = 'https://example.test/releases?view=summary';
  await pushBytes(page, 'agent-1', `${agentUrl.slice(0, 31)}\r\n${agentUrl.slice(31)}`);
  const agentLink = page.getByLabel('Live log', { exact: true }).getByRole('link', { name: `Open ${agentUrl}`, exact: true });
  await expect(agentLink).toHaveCount(2);
  await expect(agentLink.last()).toHaveAttribute('href', agentUrl);

  await agentLink.last().click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Agent actions' });
  await menu.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual([agentUrl]);

  // keep the previous clipboard value when URL copying is denied
  const copyFailure = page.waitForEvent('console', { predicate: message => message.type() === 'error' && message.text().includes('Copy URL') });
  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.writeDenied = true; });
  await agentLink.last().click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Agent actions' });
  await menu.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  await copyFailure;
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual([agentUrl]);
  await page.evaluate(() => { (window as unknown as ClipboardWindow).__contextClipboard.writeDenied = false; });

  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const terminalUrl = 'https://example.test/builds/456?view=log';
  await pushBytes(page, '%5', terminalUrl);
  const terminalLink = page.getByRole('link', { name: `Open ${terminalUrl}`, exact: true });
  await expect(terminalLink).toHaveAttribute('href', terminalUrl);

  await terminalLink.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Terminal build actions' });
  await menu.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ClipboardWindow).__contextClipboard.writes)).toEqual([agentUrl, terminalUrl]);
});

test('terminal menu preserves neutral mode until paste explicitly enters output mode', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    // ignore optional API resources this deliberately minimal fixture leaves unmocked
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) browserErrors.push(message.text());
  });
  await installClipboardMock(page, 'shell paste');
  await mountConsole(page);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.terminal-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Terminal build actions' });
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
  await expect(terminal.locator('textarea')).not.toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Paste plain', exact: true })).toBeEnabled();
  await menu.getByRole('menuitem', { name: 'Paste plain', exact: true }).click();
  await expect(terminal.locator('textarea')).toBeFocused();
  await expect.poll(() => paneInputText(page, '%5')).toContain('shell paste');
  // a keyboard-opened menu temporarily borrows terminal focus without changing its mode
  await terminal.locator('textarea').press('ContextMenu');
  await expect(menu.getByRole('menuitemradio', { name: 'Output', exact: true })).toBeFocused();
  await expect(terminal).toHaveClass(/\bfocused\b/u);
  await page.keyboard.press('Escape');
  await expect(terminal.locator('textarea')).toBeFocused();
  expect(browserErrors).toEqual([]);
});

test('Code select all reaches rendered text across diff shadow roots from header and code targets', async ({ page }) => {
  await installClipboardMock(page);
  await mountConsole(page);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Code', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  const rendered = code.getByText('export const contextSelection = true;', { exact: true });
  const header = code.locator(':scope > .panel-header');
  // dispatch through the header because its owning section intentionally overlays pointer hit-testing
  const rightClickHeader = () => header.evaluate(element => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 200, clientY: 200 }));
  });
  await expect(rendered).toBeVisible();

  await rightClickHeader();
  let menu = page.getByRole('menu', { name: 'Code options' });
  await expect(menu.getByRole('menuitemradio', { name: 'Working changes' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem', { name: 'Paste unavailable' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Select all' }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('export const contextSelection = true;');
  await rightClickHeader();
  menu = page.getByRole('menu', { name: 'Code options' });
  const headerCopy = menu.getByRole('menuitem', { name: 'Copy', exact: true });
  await expect(headerCopy).toBeEnabled();
  await headerCopy.click();
  await expect.poll(() => page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes.at(-1) ?? '')).toContain('export const contextSelection = true;');

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await rendered.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Code options' });
  await menu.getByRole('menuitem', { name: 'Select all' }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('export const contextSelection = true;');
  await rendered.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Code options' });
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
});

// exercise the address gesture with browser-delivered touch input
test.describe('browser address long press', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // open a loaded preview without external network access
  const openBrowser = async (page: Page) => {
    await installClipboardMock(page);
    await page.route('https://project.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Preview</main>' }));
    await mountConsole(page);
    await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browser', exact: true });
    await expect(browser.locator('iframe')).toHaveAttribute('src', /project\.example\.test/u);
    return { browser, address: browser.getByRole('textbox', { name: 'Browser address' }) };
  };

  // deliver deterministic touch lifecycle events for timer cancellation checks
  const dispatchAddressTouch = (address: Locator, type: string, x = 10) => address.evaluate((input, gesture) => {
    const touches = gesture.type === 'touchstart' || gesture.type === 'touchmove'
      ? [new Touch({ identifier: 1, target: input, clientX: gesture.x, clientY: 10 })] : [];
    input.dispatchEvent(new TouchEvent(gesture.type, { bubbles: true, cancelable: true, touches }));
  }, { type, x });

  // copy the entire address once without submitting edited text or opening another menu
  test('copies the full URL on a touch hold and preserves tap-to-edit navigation', async ({ page }) => {
    const { browser, address } = await openBrowser(page);
    const target = 'https://project.example.test/path?query=one%20two#details';
    await address.tap();
    await expect(address).toBeFocused();
    await address.fill(target);
    await address.press('Enter');
    await expect.poll(async () => new URL((await browser.locator('iframe').getAttribute('src'))!).searchParams.get('location')).toBe('/path?query=one%20two#details');
    const source = (await browser.locator('iframe').getAttribute('src'))!;
    // keep only a substring selected so copying must not depend on the selection
    await address.evaluate(input => (input as HTMLInputElement).setSelectionRange(8, 15));
    const bounds = (await address.boundingBox())!;
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 10, y: bounds.y + bounds.height / 2 }] });
    await expect.poll(() => page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([target]);
    // native contextmenu may follow the hold timer and must not copy twice
    await address.evaluate(input => input.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0 })));
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(browser.getByRole('status')).toHaveText('URL copied');
    await expect(page.getByRole('menu', { name: 'Browser options' })).toHaveCount(0);
    await expect(address).toHaveValue(target);
    await expect(browser.locator('iframe')).toHaveAttribute('src', source);
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([target]);
    await page.screenshot({ path: '/tmp/browser-url-copy-mobile.png' });
    // keyboard menus still offer editing commands after a completed touch hold
    await address.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Browser options' })).toBeVisible();
    await page.keyboard.press('Escape');
    // a new tap remains an ordinary edit rather than another copy
    await address.tap();
    await address.fill('https://project.example.test/next');
    await address.press('Enter');
    await expect.poll(async () => new URL((await browser.locator('iframe').getAttribute('src'))!).searchParams.get('location')).toBe('/next');
    await touch.detach();
  });

  // canceled, moved and short gestures must never reach the clipboard
  test('cancels copying after taps, drags, cancellation and closing the browser', async ({ page }) => {
    const { address } = await openBrowser(page);
    await page.clock.install();
    // isolate each termination path while advancing beyond the hold threshold
    for (const ending of ['touchend', 'touchmove', 'touchcancel']) {
      await dispatchAddressTouch(address, 'touchstart');
      await dispatchAddressTouch(address, ending, 40);
      await page.clock.runFor(1000);
      expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([]);
    }
    // native selection can cancel pointer delivery without ending the stationary touch
    await dispatchAddressTouch(address, 'touchstart');
    await address.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'touch' });
    await page.clock.runFor(500);
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([await address.inputValue()]);
    await dispatchAddressTouch(address, 'touchend');
    await page.evaluate(() => { (window as ClipboardWindow).__contextClipboard.writes = []; });
    await dispatchAddressTouch(address, 'touchstart');
    await page.getByRole('button', { name: 'Close browser', exact: true }).click();
    await page.clock.runFor(1000);
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([]);
  });

  // older clipboard support must not submit a draft through its temporary textarea focus
  test('copies an edited URL through the fallback without navigating or losing selection', async ({ page }) => {
    const { browser, address } = await openBrowser(page);
    const source = await browser.locator('iframe').getAttribute('src');
    const draft = 'https://project.example.test/draft?one=two#three';
    await address.fill(draft);
    await address.evaluate(input => (input as HTMLInputElement).setSelectionRange(8, 15));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      // observe the legacy command while preserving the real temporary focus transfer
      document.execCommand = command => {
        const input = document.activeElement as HTMLTextAreaElement;
        if (command !== 'copy' || input.tagName !== 'TEXTAREA') return false;
        (window as ClipboardWindow).__contextClipboard.writes.push(input.value);
        return true;
      };
    });
    await address.evaluate(input => input.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0 })));
    await expect(browser.getByRole('status')).toHaveText('URL copied');
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(draft);
    expect(await address.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([8, 15]);
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([draft]);
    await expect(browser.locator('iframe')).toHaveAttribute('src', source!);
  });

  // report permission failures honestly and let the next hold retry
  test('reports clipboard denial and allows a later hold to succeed', async ({ page }) => {
    const { browser, address } = await openBrowser(page);
    await page.evaluate(() => { (window as ClipboardWindow).__contextClipboard.writeDenied = true; });
    await address.evaluate(input => input.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0 })));
    await expect(browser.getByRole('alert')).toHaveText('Copy failed');
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([]);
    await page.evaluate(() => { (window as ClipboardWindow).__contextClipboard.writeDenied = false; });
    await dispatchAddressTouch(address, 'touchstart');
    await address.evaluate(input => input.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0 })));
    await dispatchAddressTouch(address, 'touchend');
    await expect(browser.getByRole('status')).toHaveText('URL copied');
    expect(await page.evaluate(() => (window as ClipboardWindow).__contextClipboard.writes)).toEqual([await address.inputValue()]);
  });
});
