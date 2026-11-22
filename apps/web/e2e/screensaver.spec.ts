import { expect, test, type Page, type Route } from '@playwright/test';
import type { SettingsStatus } from '../src/settings/contracts.js';
import type { ProjectStack } from '../src/stack-controls.js';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';
import { installPaneMock, paneInputText, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type Preview = { kind: 'output' | 'response'; text: string; available: boolean; identity?: string; truncated?: boolean; colors?: unknown };
type AgentFixture = { id: string; previewIdentity: string; displayLabel: string; home: string; placeId?: string; worktreeId?: string; attention?: 'working' | 'finished' | 'question'; unread?: boolean; conversationId?: string; structured?: { lifecycle: 'live'; revision: number }; panel: 'terminal' | 'transcript'; queuedPromptCount: number; title: string };
type ScreensaverHarness = { dashboard: Record<string, unknown>; previews: Map<string, Preview>; previewReads: Map<string, number>; beforePreview?: (id: string) => Promise<number | void>; sessionActive?: boolean; settingsStatus: SettingsStatus; settingsStatusReads: number; mutations: string[] };

// build one agent without coupling scenarios to unrelated dashboard fields
const agent = (id: string, displayLabel: string, target: { placeId?: string; worktreeId?: string }, attention: AgentFixture['attention'] = 'working'): AgentFixture => ({
  id,
  previewIdentity: `${id}:current`,
  displayLabel,
  home: `/workspaces/${target.worktreeId ?? target.placeId ?? id}`,
  ...target,
  attention,
  structured: { lifecycle: 'live', revision: 1 },
  panel: 'transcript',
  queuedPromptCount: 0,
  title: displayLabel
});

// return the default open-workspace inventory with sibling agents and non-git places
const dashboardFixture = (screensaver = { enabled: true, idleMinutes: 0 }): Record<string, unknown> => ({
  generation: 1,
  screensaver,
  agents: [
    agent('cora-primary', 'Cora primary', { worktreeId: 'cora' }),
    agent('cora-review', 'Cora review', { worktreeId: 'cora' }, 'finished'),
    agent('scratch-agent', 'Scratch helper', { placeId: 'scratch' }, 'question')
  ],
  projects: [{
    id: 'remoteagents',
    label: 'Remote Agents',
    available: true,
    worktrees: [
      { id: 'cora', projectId: 'remoteagents', label: 'Cora', path: '/workspaces/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, stack: { actions: ['start', 'stop'], running: true, processes: [{ name: 'web', state: 'running' }, { name: 'worker', state: 'stopped' }] } },
      { id: 'terminal-only', projectId: 'remoteagents', label: 'Terminal only', path: '/workspaces/terminal-only', main: false, detached: false, locked: false, available: true, pinned: false, consoleShells: 1, order: 1 },
      { id: 'unopened', projectId: 'remoteagents', label: 'Unopened', path: '/workspaces/unopened', main: false, detached: false, locked: false, available: true, pinned: false, order: 2 }
    ]
  }],
  places: [
    { id: 'scratch', kind: 'scratch', label: 'Scratch', path: '/scratch', home: '/scratch', available: true, pinned: true },
    { id: 'directory', kind: 'directory', projectId: 'docs', label: 'Docs directory', path: '/docs', home: '/docs', available: true, pinned: true }
  ]
});

// fulfill one json response without repeating headers
const json = (route: Route, payload: unknown, status = 200) => route.fulfill({ status, json: payload });

// expose only the browser contracts the screensaver and mounted workspace consume
const routeScreensaverApi = async (page: Page, harness: ScreensaverHarness): Promise<void> => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // serve the authenticated console shell
    if (path === '/api/auth/session') return json(route, { csrfToken: 'csrf-token', active: harness.sessionActive !== false, deviceName: 'Test device', server: { name: 'Screensaver fixture', url: 'https://fixture.invalid', remotes: [] } });
    // publish mutable status and preview facts
    if (path === '/api/dashboard') return json(route, harness.dashboard);
    // authorize the controlled dashboard socket
    if (path === '/api/dashboard/ticket') return json(route, { ticket: 'dashboard-ticket' });
    const preview = /^\/api\/agents\/([^/]+)\/screensaver$/u.exec(path);
    // count active-only polling by agent identity
    if (preview !== null) {
      const id = decodeURIComponent(preview[1]!);
      harness.previewReads.set(id, (harness.previewReads.get(id) ?? 0) + 1);
      // capture the generation independently of what the browser requested
      const identity = (harness.dashboard.agents as AgentFixture[]).find(candidate => candidate.id === id)?.previewIdentity;
      const reply = harness.previews.get(id) ?? { kind: 'response', text: '', available: false };
      const status = await harness.beforePreview?.(id);
      // model a controller reservation expiring during the capture
      if (status !== undefined) return json(route, { error: 'inactive client' }, status);
      return json(route, { identity, ...reply });
    }
    // keep structured panels settled behind the overlay
    if (/^\/api\/agents\/[^/]+\/transcript$/u.test(path)) return json(route, { items: [], earlier: 0 });
    // leave prompt collections empty
    if (/^\/api\/agents\/[^/]+\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return json(route, { prompts: [] });
    // leave command and attachment collections empty
    if (/^\/api\/agents\/[^/]+\/(commands|message-files)$/u.test(path)) return json(route, path.endsWith('/commands') ? { commands: [] } : { files: [] });
    // leave workspace notes empty
    if (/^\/api\/(worktrees|places)\/[^/]+\/notes$/u.test(path)) return json(route, { notes: [] });
    // suppress unrelated update and notification work
    if (path === '/api/push/public-key') return json(route, {});
    // settle update inventory
    if (path === '/api/agents/updates') return json(route, { agents: [] });
    // settle revision metadata
    if (path === '/api/server/revision') return json(route, { sha: 'a'.repeat(40), committedAt: '2026-11-18T12:00:00.000Z' });
    // publish mutable durable restart state to the application runtime
    if (path === '/api/settings/status') {
      harness.settingsStatusReads += 1;
      return json(route, harness.settingsStatus);
    }
    // record any unexpected mutation for read-only assertions
    if (request.method() !== 'GET' && /^\/api\/(agents|worktrees|places)\//u.test(path)) harness.mutations.push(`${request.method()} ${path}`);
    return json(route, { error: 'not mocked' }, 404);
  });
};

// open the production dashboard with deterministic screensaver responses
const openScreensaverDashboard = async (page: Page, options: { dashboard?: Record<string, unknown>; previews?: Record<string, Preview>; settingsStatus?: SettingsStatus; viewport?: { width: number; height: number } } = {}): Promise<ScreensaverHarness> => {
  const harness: ScreensaverHarness = {
    dashboard: options.dashboard ?? dashboardFixture(),
    previews: new Map(Object.entries(options.previews ?? {
      'cora-primary': { kind: 'output', text: 'zero\none\ntwo\nthree\nfour\nfive\nsix\nseven', available: true },
      'cora-review': { kind: 'response', text: 'The review is complete.', available: true },
      'scratch-agent': { kind: 'output', text: 'Choose the next step.', available: true }
    })),
    previewReads: new Map(),
    settingsStatus: options.settingsStatus ?? { pending: false, targets: [], effective: 'known', restartAvailable: true },
    settingsStatusReads: 0,
    mutations: []
  };
  // expose application errors as explicit test failures
  page.on('pageerror', error => { throw error; });
  await installDashboardSocket(page);
  await page.setViewportSize(options.viewport ?? { width: 1440, height: 900 });
  await routeScreensaverApi(page, harness);
  await page.goto('/');
  await expect(page.getByRole('tablist', { name: 'Agents and worktrees' })).toBeVisible();
  return harness;
};

// enter through the configured default and wait for the passive surface
const enterScreensaver = async (page: Page, chord = 'Control+l') => {
  await page.keyboard.press(chord);
  const overlay = page.getByRole('dialog', { name: 'Screensaver' });
  await expect(overlay).toBeVisible();
  return overlay;
};

// serve one focused terminal so a declined shortcut can prove native pass-through
const openDisabledTerminal = async (page: Page, enabled = false): Promise<void> => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await page.addInitScript(() => localStorage.setItem('rac.terminals:cora', JSON.stringify([{ paneId: '%5', name: 'build' }])));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // serve the disabled feature policy
    if (path === '/api/auth/session') return json(route, { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' });
    // publish one terminal workspace
    if (path === '/api/dashboard') return json(route, { generation: 1, screensaver: { enabled, idleMinutes: 1 }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/workspaces/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Idle', attention: 'finished', panel: 'terminal', queuedPromptCount: 0 }], projects: [] });
    // authorize the pane stream
    if (path === '/api/panes/ticket') return json(route, { ticket: 'pane-ticket' });
    // publish the agent and terminal panes
    if (path === '/api/worktrees/cora/panes') return json(route, { panes: [{ paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/workspaces/cora', title: '', agent: true }, { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/workspaces/cora', title: '', agent: false, busy: false }] });
    // leave prompt collections empty
    if (/^\/api\/agents\/agent-1\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return json(route, { prompts: [] });
    // leave worktree notes empty
    if (path === '/api/worktrees/cora/notes') return json(route, { notes: [] });
    // disable push enrollment
    if (path === '/api/push/public-key') return json(route, {});
    return json(route, { error: 'not mocked' }, 404);
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await seedPaneSize(page, '%5');
  await pushBytes(page, '%5', '$ \r\n');
  await page.locator('.terminal-pane[data-panel-key="%5"] .xterm-screen').click();
};

// disabled policy must decline the action so shell readline keeps ctrl+l
test('disabled screensaver leaves its hotkey and idle timeout inactive', async ({ page }) => {
  await page.clock.install();
  await openDisabledTerminal(page);
  await page.keyboard.press('Control+l');
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
  await expect.poll(() => paneInputText(page, '%5')).toBe('\u000c');
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
});

// modifier dismissal is fenced before either shortcut dispatch or terminal input
test('a modifier chord dismisses without sending bytes to the focused terminal', async ({ page }) => {
  await openDisabledTerminal(page, true);
  await enterScreensaver(page);
  const bytesBeforeDismissal = await paneInputText(page, '%5');
  await page.keyboard.press('Control+a');
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
  await expect.poll(() => paneInputText(page, '%5')).toBe(bytesBeforeDismissal);
});

// inventory coverage proves workspace inclusion, sibling agents and content selection
test('manual entry shows every open workspace and every agent without unopened inventory', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const overlay = await enterScreensaver(page);

  // keep a named dialog without a visual header or an opaque backdrop
  await expect(overlay.getByRole('heading', { name: 'Screensaver' })).toHaveCount(0);
  await expect(overlay).toHaveAccessibleDescription('Move the mouse, click or press any key to return');
  await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.24)');
  await expect(overlay).toHaveCSS('backdrop-filter', 'blur(4px)');

  await expect(overlay.getByRole('region', { name: 'Cora workspace' })).toBeVisible();
  await expect(overlay.getByRole('region', { name: 'Terminal only workspace' })).toBeVisible();
  await expect(overlay.getByRole('region', { name: 'Scratch workspace' })).toBeVisible();
  await expect(overlay.getByRole('region', { name: 'Docs directory workspace' })).toBeVisible();
  await expect(overlay.getByRole('region', { name: 'Unopened workspace' })).toHaveCount(0);
  await expect(overlay.getByRole('article', { name: 'Cora primary' })).toContainText('one\ntwo\nthree\nfour\nfive\nsix\nseven');
  await expect(overlay.getByRole('article', { name: 'Cora review' })).toContainText('The review is complete.');
  await expect(overlay.getByRole('article', { name: 'Scratch helper' }).getByLabel('Live output')).toHaveText('Choose the next step.');
  expect(harness.mutations).toEqual([]);
});

// preserve terminal colors without allowing output to create browser markup
test('live tails use smaller terminal-colored text and update colors safely', async ({ page }) => {
  const text = 'discard\nrecent\nmore\nplain\npalette\ntruecolor\ninverse\n<img data-tail-test onerror="window.tailMarkupRan=true">';
  // address test styles by the same UTF-16 offsets the API uses
  const color = (value: string, style: Record<string, unknown>) => ({ from: text.indexOf(value), to: text.indexOf(value) + value.length, ...style });
  const harness = await openScreensaverDashboard(page, { previews: {
    'cora-primary': { kind: 'output', text, available: true, colors: [
      color('discard', { foreground: 3 }),
      color('palette', { foreground: 1 }),
      color('truecolor', { foreground: '#123456', dim: true }),
      color('inverse', { foreground: 2, background: 4, inverse: true })
    ] },
    'cora-review': { kind: 'response', text: 'The review is complete.', available: true },
    'scratch-agent': { kind: 'output', text: 'Choose the next step.', available: true }
  } });
  const overlay = await enterScreensaver(page);
  const output = overlay.getByRole('article', { name: 'Cora primary' }).getByLabel('Live output');
  const response = overlay.getByLabel('Latest response').first();
  await expect(output).toHaveText('recent\nmore\nplain\npalette\ntruecolor\ninverse\n<img data-tail-test onerror="window.tailMarkupRan=true">');
  const sizes = await Promise.all([output, response].map(locator => locator.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))));
  expect(sizes[0]).toBeLessThan(sizes[1]!);
  // resolve theme colors through the same document that supplies the terminal palette
  const palette = await overlay.evaluate(element => {
    const probe = document.createElement('span');
    element.append(probe);
    const colors = Object.fromEntries(['red', 'green', 'blue'].map(token => {
      probe.style.color = `var(--${token})`;
      return [token, getComputedStyle(probe).color];
    }));
    probe.remove();
    return colors;
  });
  await expect(output.getByText('palette', { exact: true })).toHaveCSS('color', palette.red!);
  await expect(output.getByText('truecolor', { exact: true })).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(output.getByText('truecolor', { exact: true })).toHaveCSS('opacity', '0.65');
  await expect(output.getByText('inverse', { exact: true })).toHaveCSS('color', palette.blue!);
  await expect(output.getByText('inverse', { exact: true })).toHaveCSS('background-color', palette.green!);
  await expect(output.locator('img[data-tail-test]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { tailMarkupRan?: boolean }).tailMarkupRan)).toBeUndefined();

  harness.previews.set('cora-primary', { kind: 'output', text: 'invalid style', available: true, colors: [{ from: 0, to: 7, foreground: 1 }, { from: 4, to: 9, foreground: 2 }] });
  await expect(output).toHaveText('invalid style', { timeout: 7_000 });
  await expect(output.locator('span')).toHaveCount(0);
  harness.previews.set('cora-primary', { kind: 'output', text: 'fresh green', available: true, colors: [{ from: 6, to: 11, foreground: 2 }] });
  await expect(output).toHaveText('fresh green', { timeout: 7_000 });
  await expect(output.getByText('green', { exact: true })).toHaveCSS('color', palette.green!);
});

// keep the most recent response lines visible and remove only a repeated workspace suffix
test('conversation names are distinct and long answers show their newest lines', async ({ page }) => {
  const dashboard = dashboardFixture();
  const [primary, review] = dashboard.agents as (AgentFixture & { structured: NonNullable<AgentFixture['structured']> & { conversationName?: string } })[];
  primary!.displayLabel = 'Cora primary | notes | cora';
  primary!.home = '/workspaces/cora';
  review!.structured.conversationName = 'Review | Cora';
  const text = ['Beginning of response', ...Array.from({ length: 20 }, (_, row) => `Detail ${row + 1}`), 'End of response'].join('\n');
  await openScreensaverDashboard(page, { dashboard, previews: {
    'cora-primary': { kind: 'output', text: 'fresh output', available: true },
    'cora-review': { kind: 'response', text, available: true }
  } });
  const overlay = await enterScreensaver(page);
  const heading = overlay.getByRole('heading', { name: 'Cora primary | notes', exact: true });
  await expect(heading).toBeVisible();
  await expect(overlay.getByText('Cora primary | notes | cora', { exact: true })).toHaveCount(0);
  await expect(overlay.getByRole('heading', { name: 'Review | Cora', exact: true })).toBeVisible();
  const tail = overlay.getByLabel('Live output');
  await expect(tail).toHaveText('fresh output');
  expect(await heading.evaluate(element => getComputedStyle(element).fontFamily)).not.toBe(await tail.evaluate(element => getComputedStyle(element).fontFamily));
  expect(await tail.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThan(10);

  const answer = overlay.getByRole('article', { name: 'Review | Cora' }).getByLabel('Latest response');
  await expect(answer).toHaveText(text);
  // inspect glyph positions rather than treating offscreen text as visible
  const edges = await answer.evaluate(element => {
    const text = element.firstChild!;
    const bounds = element.parentElement!.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const first = range.getBoundingClientRect();
    range.setStart(text, text.textContent!.length - 1);
    range.setEnd(text, text.textContent!.length);
    const last = range.getBoundingClientRect();
    return { beginningClipped: first.bottom < bounds.top, endingVisible: last.top >= bounds.top && last.bottom <= bounds.bottom + 1 };
  });
  expect(edges).toEqual({ beginningClipped: true, endingVisible: true });
});

// verify actual palette colors and right alignment rather than class names alone
test('workspace and stack statuses use console colors on two right-aligned lines', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const overlay = await enterScreensaver(page);
  const cora = overlay.getByRole('region', { name: 'Cora workspace' });
  const workspaceState = cora.locator('.screensaver-workspace-state');
  const stackState = cora.locator('.screensaver-stack-status');
  // resolve theme tokens through the browser so either color theme can run these assertions
  const palette = await overlay.evaluate(element => {
    const probe = document.createElement('span');
    probe.hidden = true;
    element.append(probe);
    // normalize each theme color to Chromium's computed color syntax
    const colors = Object.fromEntries(['peach', 'red', 'yellow', 'green', 'subtext-1'].map(token => {
      probe.style.color = `var(--${token})`;
      return [token, getComputedStyle(probe).color];
    }));
    probe.remove();
    return colors;
  });
  await expect(workspaceState).toHaveText('Working');
  await expect(workspaceState).toHaveCSS('color', palette.peach!);
  await expect(overlay.getByRole('region', { name: 'Scratch workspace' }).locator('.screensaver-workspace-state')).toHaveCSS('color', palette.red!);
  await expect(overlay.getByRole('region', { name: 'Terminal only workspace' }).locator('.screensaver-workspace-state')).toHaveCSS('color', palette['subtext-1']!);
  await expect(stackState).toHaveText('Stack: 1 of 2 running');
  await expect(stackState).toHaveCSS('color', palette.yellow!);
  const workspaceBox = (await workspaceState.boundingBox())!;
  const stackBox = (await stackState.boundingBox())!;
  expect(stackBox.y).toBeGreaterThanOrEqual(workspaceBox.y + workspaceBox.height);
  expect(stackBox.x + stackBox.width).toBeCloseTo(workspaceBox.x + workspaceBox.width);

  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  const worktree = (harness.dashboard.projects as { worktrees: { stack?: ProjectStack }[] }[])[0]!.worktrees[0]!;
  // change stack health through the live dashboard, including a stale healthy tunnel after an exit
  const changes: { stack: ProjectStack; label: string; color: string }[] = [
    { stack: { actions: ['start'], running: true }, label: 'Running', color: 'green' },
    { stack: { tunnel: true, processes: [{ name: 'web', state: 'exited', exitCode: 1 }] }, label: 'Exited', color: 'red' },
    { stack: { operation: 'restart' }, label: 'Restarting', color: 'yellow' }
  ];
  // keep the same card mounted while each newer status arrives
  for (const [index, next] of changes.entries()) {
    worktree.stack = next.stack;
    harness.dashboard.generation = index + 2;
    await emitDashboard(page, harness.dashboard);
    await expect(stackState).toHaveText(`Stack: ${next.label}`);
    await expect(stackState).toHaveCSS('color', palette[next.color]!);
  }
});

// keep cards wide on laptops and cap the desktop layout at two columns
test('cards stack on laptops and use at most two columns on wide screens', async ({ page }) => {
  await openScreensaverDashboard(page, { viewport: { width: 1440, height: 900 } });
  const overlay = await enterScreensaver(page);
  const cards = overlay.locator('.screensaver-workspace');
  await expect(cards).toHaveCount(4);
  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  expect(first.width).toBeGreaterThan(1300);
  expect(second.x).toBe(first.x);
  expect(second.y).toBeGreaterThan(first.y);

  await page.setViewportSize({ width: 2560, height: 1000 });
  const left = (await cards.nth(0).boundingBox())!;
  const right = (await cards.nth(1).boundingBox())!;
  const nextRow = (await cards.nth(2).boundingBox())!;
  expect(left.width).toBeGreaterThan(1100);
  expect(right.x).toBeGreaterThan(left.x);
  expect(right.y).toBe(left.y);
  expect(nextRow.x).toBe(left.x);
  expect(nextRow.y).toBeGreaterThan(left.y);
});

// server key tables remap manual entry without a parallel browser preference
test('the remapped hotkey replaces ctrl+l and still enters screensaver', async ({ page }) => {
  const dashboard = { ...dashboardFixture(), keys: { root: { 'C-l': null, 'C-S-l': 'screensaver' } } };
  await openScreensaverDashboard(page, { dashboard });
  await page.keyboard.press('Control+l');
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
  await enterScreensaver(page, 'Control+Shift+l');
});

// command discovery runs the same guarded action after closing its own modal
test('the command palette starts screensaver when the feature is enabled', async ({ page }) => {
  await openScreensaverDashboard(page);
  await page.keyboard.press('Control+b');
  await page.keyboard.press(':');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('start screensaver');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toBeVisible();
});

// each dismissal path must consume its event and preserve console selection
for (const dismissal of ['keyboard', 'click', 'mousemove'] as const) {
  test(`${dismissal} dismisses the passive overview without navigating or leaking input`, async ({ page }) => {
    await openScreensaverDashboard(page);
    const selected = page.getByRole('tab', { selected: true });
    const selectedName = await selected.getAttribute('aria-label');
    const overlay = await enterScreensaver(page);

    // trigger the requested dismissal independently
    if (dismissal === 'keyboard') await page.keyboard.press('Shift+ArrowRight');
    else if (dismissal === 'click') await overlay.getByRole('article', { name: 'Cora primary' }).click();
    else {
      const bounds = await overlay.boundingBox();
      // require real geometry before emitting movement
      if (bounds === null) throw new Error('screensaver overlay has no geometry');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    }

    await expect(overlay).toHaveCount(0);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-label', selectedName!);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  });
}

// mutable preview replies exercise active-only live replacement without workspace remounts
test('live polling switches between working output, completed response and unavailable content', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const overlay = await enterScreensaver(page);
  const primary = overlay.getByRole('article', { name: 'Cora primary' });
  await expect(primary.getByLabel('Live output')).toHaveText('one\ntwo\nthree\nfour\nfive\nsix\nseven');
  await expect(primary.getByLabel('Live output')).not.toContainText('zero');

  const completed = structuredClone(harness.dashboard) as { generation: number; agents: AgentFixture[] };
  const completedAgent = completed.agents.find(candidate => candidate.id === 'cora-primary');
  // require the exact agent before changing its turn state
  if (completedAgent === undefined || completedAgent.structured === undefined) throw new Error('working agent fixture is missing');
  completed.generation += 1;
  completedAgent.attention = 'finished';
  completedAgent.structured.revision += 1;
  harness.dashboard = completed;
  harness.previews.set('cora-primary', { kind: 'response', text: 'Fresh completed answer.', available: true });
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, completed);
  await expect(primary.getByLabel('Latest response')).toHaveText('Fresh completed answer.', { timeout: 5_000 });
  await expect(primary.getByLabel('Live output')).toHaveCount(0);

  harness.previews.set('cora-primary', { kind: 'response', text: '', available: false });
  await expect(primary).toContainText(/unavailable|no .*available/iu, { timeout: 7_000 });
  const readsAtDismissal = harness.previewReads.get('cora-primary') ?? 0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_500);
  expect(harness.previewReads.get('cora-primary') ?? 0).toBe(readsAtDismissal);
});

// the same agent can change conversations without changing the card's identity
test('never retains the prior conversation response after the agent switches', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const overlay = await enterScreensaver(page);
  const review = overlay.getByRole('article', { name: 'Cora review' });
  await expect(review.getByLabel('Latest response')).toHaveText('The review is complete.');
  const snapshot = structuredClone(harness.dashboard) as { generation: number; agents: AgentFixture[] };
  const agent = snapshot.agents.find(candidate => candidate.id === 'cora-review')!;
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  // replace the conversation while retaining the same agent key
  agent.conversationId = 'new-conversation';
  agent.previewIdentity = 'cora-review:new-conversation';
  snapshot.generation += 1;
  harness.dashboard = snapshot;
  harness.previews.set('cora-review', { kind: 'response', text: '', available: false });
  await emitDashboard(page, snapshot);
  await expect(review).toHaveText(/No response available/u);
  await expect(review).not.toContainText('The review is complete.');

  // publish the new conversation's own response on its next revision
  agent.structured!.revision += 1;
  snapshot.generation += 1;
  harness.previews.set('cora-review', { kind: 'response', text: 'Answer from the new conversation.', available: true });
  await emitDashboard(page, snapshot);
  await expect(review.getByLabel('Latest response')).toHaveText('Answer from the new conversation.');
});

// require matching response provenance and keep slow sibling reads alive
test('rejects a mismatched preview without restarting an unchanged card', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  let release = () => {};
  const stalled = new Promise<void>(resolve => { release = resolve; });
  // hold the first card while the sibling's preview and dashboard advance
  harness.beforePreview = async id => { if (id === 'cora-primary') await stalled; };
  harness.previews.set('cora-review', { kind: 'response', text: 'Another conversation', available: true, identity: 'cora-review:next' });
  const overlay = await enterScreensaver(page);
  const review = overlay.getByRole('article', { name: 'Cora review' });
  await expect(review).toContainText('No response available');
  await expect(review).not.toContainText('Another conversation');
  await expect.poll(() => harness.previewReads.get('cora-primary') ?? 0).toBe(1);

  const dashboard = structuredClone(harness.dashboard) as { generation: number; agents: AgentFixture[] };
  dashboard.generation += 1;
  dashboard.agents.find(candidate => candidate.id === 'cora-review')!.previewIdentity = 'cora-review:next';
  harness.dashboard = dashboard;
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, dashboard);
  await expect(review.getByLabel('Latest response')).toHaveText('Another conversation');
  expect(harness.previewReads.get('cora-primary')).toBe(1);
  release();
  await expect(overlay.getByRole('article', { name: 'Cora primary' }).getByLabel('Live output')).toContainText('seven');
});

// ownership loss on a preview request must go through the normal control screen
test('hands off to Take control when a current preview loses its reservation', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  harness.beforePreview = async () => {
    harness.sessionActive = false;
    return 423;
  };
  await page.keyboard.press('Control+l');
  await expect(page.getByRole('button', { name: 'Take control' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
});

// browser-only inactivity must ignore preview refreshes but reset on operator activity
test('automatic entry follows operator inactivity and restarts after dismissal', async ({ page }) => {
  // pause browser time so a busy host cannot skip either side of the idle deadline
  const start = Date.parse('2026-11-18T12:00:00.000Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 5_000);
  // use an accelerated browser-only interval; server validation owns whole minutes
  const dashboard = dashboardFixture({ enabled: true, idleMinutes: 0.01 });
  const harness = await openScreensaverDashboard(page, { dashboard });
  const overlay = page.getByRole('dialog', { name: 'Screensaver' });
  await page.clock.runFor(400);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 })));
  await page.clock.runFor(350);
  harness.previews.set('cora-primary', { kind: 'output', text: 'agent activity does not reset idle', available: true });
  await page.clock.runFor(249);
  await expect(overlay).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(overlay).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await page.clock.runFor(599);
  await expect(overlay).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(overlay).toBeVisible();
});

// a durable restart replaces the passive cover and yields every resource it owned
test('a server restart suppresses screensaver and restores focus and manual entry after recovery', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  const overlay = await enterScreensaver(page);
  await expect.poll(() => harness.previewReads.get('cora-primary') ?? 0).toBeGreaterThan(0);

  // publish the same durable operation that owns the production fullscreen loader
  harness.settingsStatus = {
    pending: true,
    targets: ['rac'],
    effective: 'unknown',
    restartAvailable: true,
    operation: { id: 'screensaver-restart', state: 'running', phase: 'Restarting fixture', restart: { state: 'restarting', recoveryDeadline: Date.now() + 60_000 } }
  };
  const readsBeforeRestart = harness.settingsStatusReads;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => harness.settingsStatusReads).toBeGreaterThan(readsBeforeRestart);
  const loader = page.getByRole('alert', { name: 'Restarting server', exact: true });
  await expect(loader).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(loader).toBeFocused();
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(true);

  // no preview polling or shortcut entry survives under the higher-priority cover
  const readsAtRestart = harness.previewReads.get('cora-primary') ?? 0;
  await page.keyboard.press('Control+l');
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
  expect(harness.previewReads.get('cora-primary') ?? 0).toBe(readsAtRestart);

  const beforeRestoration = harness.mutations.length;
  const completed = structuredClone(harness.dashboard) as { generation: number; agents: (AgentFixture & { completionId?: string })[] };
  completed.generation += 1;
  const selected = completed.agents.find(agent => agent.id === 'cora-primary')!;
  selected.attention = 'finished';
  selected.unread = true;
  selected.completionId = 'completed-under-restart';
  harness.dashboard = completed;
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, completed);

  // a fresh settled status releases inert and restores the pre-screensaver focus
  harness.settingsStatus = {
    pending: false,
    targets: [],
    effective: 'known',
    restartAvailable: true,
    operation: { id: 'screensaver-restart', state: 'complete', phase: 'Restart complete', restart: { state: 'restarted', recoveryDeadline: Date.now() } }
  };
  const readsBeforeRecovery = harness.settingsStatusReads;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => harness.settingsStatusReads).toBeGreaterThan(readsBeforeRecovery);
  await expect(loader).toHaveCount(0);
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await expect(prompt).toBeFocused();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-label', /Prompt done — Unread/u);
  expect(harness.mutations).toHaveLength(beforeRestoration);
  // deliberate focus after restoration still acknowledges the completion
  await page.getByRole('tab', { selected: true }).focus();
  await prompt.focus();
  await expect.poll(() => harness.mutations.slice(beforeRestoration)).toContain('POST /api/agents/cora-primary/notifications/dismiss');
  await enterScreensaver(page);
});

// a warm tmux outage must take input and pause the old dashboard's preview scheduler
test('tmux recovery takes over active screensaver and restarts the idle interval', async ({ page }) => {
  const start = Date.parse('2026-11-21T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 5_000);
  const harness = await openScreensaverDashboard(page, { dashboard: dashboardFixture({ enabled: true, idleMinutes: 0.01 }) });
  // let the mocked dashboard socket's zero-delay open run on the paused clock
  await expect.poll(async () => { await page.clock.runFor(1); return dashboardSocketReady(page); }).toBe(true);
  const overlay = await enterScreensaver(page);
  await expect(overlay.getByLabel('Live output').first()).toBeVisible();
  await emitDashboard(page, { ...harness.dashboard, generation: 2, tmuxOutage: { unavailableSockets: 1, since: '2026-11-21T12:00:01Z' } });
  const recovery = page.getByRole('dialog', { name: 'Console recovery' });
  await expect(recovery).toBeVisible();
  await expect(overlay).toHaveCount(0);
  const reads = harness.previewReads.get('cora-primary');
  await page.clock.runFor(1_200);
  expect(harness.previewReads.get('cora-primary')).toBe(reads);

  // the first recovery key can retry instead of being consumed as a saver dismissal
  harness.dashboard = { ...harness.dashboard, generation: 3 };
  await recovery.getByRole('button', { name: 'Retry dashboard' }).focus();
  await page.keyboard.press('Enter');
  await expect(recovery).toHaveCount(0);
  await page.clock.runFor(599);
  await expect(overlay).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(overlay).toBeVisible();
});

// completions arriving under the passive cover remain unread through focus restoration
test('entry and dismissal never acknowledge a completion that arrives underneath screensaver', async ({ page }) => {
  const harness = await openScreensaverDashboard(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const focusDismissal = page.waitForRequest(request => new URL(request.url()).pathname === '/api/agents/cora-primary/notifications/dismiss');
  await prompt.focus();
  await focusDismissal;
  await expect.poll(() => harness.mutations.filter(entry => entry.includes('/notifications/dismiss')).length).toBe(1);
  const mutationsBeforeEntry = [...harness.mutations];
  await enterScreensaver(page);

  const completed = structuredClone(harness.dashboard) as { generation: number; agents: AgentFixture[] };
  const completedAgent = completed.agents.find(candidate => candidate.id === 'cora-primary') as AgentFixture & { completionId?: string } | undefined;
  // require the selected agent before publishing its completed turn
  if (completedAgent === undefined || completedAgent.structured === undefined) throw new Error('selected agent fixture is missing');
  // a focused document under the passive cover must not dismiss a new question either
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, { ...completed, generation: completed.generation + 1, agents: completed.agents.map(agent => agent.id === 'cora-primary' ? { ...agent, attention: 'question' } : agent) });
  await expect(page.getByRole('article', { name: 'Cora primary' })).toContainText('Needs answer');
  expect(harness.mutations).toEqual(mutationsBeforeEntry);
  completed.generation += 2;
  completedAgent.attention = 'finished';
  completedAgent.unread = true;
  completedAgent.completionId = 'completion-under-screensaver';
  completedAgent.structured.revision += 1;
  harness.dashboard = completed;
  harness.previews.set('cora-primary', { kind: 'response', text: 'Completed under cover.', available: true });
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, completed);
  await expect(page.getByRole('dialog', { name: 'Screensaver' }).getByRole('article', { name: 'Cora primary' })).toContainText('Done');
  expect(harness.mutations).toEqual(mutationsBeforeEntry);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Screensaver' })).toHaveCount(0);
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-label', /Prompt done — Unread/u);
  await expect(prompt).toBeFocused();
  expect(harness.mutations).toEqual(mutationsBeforeEntry);
});

// phone evidence guards responsive overflow without weakening desktop assertions
test('phone layout keeps all workspace and agent summaries reachable', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T12:00:00.000Z') });
  const harness = await openScreensaverDashboard(page, { viewport: { width: 390, height: 700 } });
  const prefix = 'wrapping row '.repeat(400);
  harness.previews.set('cora-primary', { kind: 'output', text: prefix + 'NEWEST', available: true, colors: [{ from: prefix.length, to: prefix.length + 6, foreground: 2 }] });
  const overlay = await enterScreensaver(page);
  await expect(overlay.getByRole('article', { name: 'Cora primary' })).toBeVisible();
  await expect(overlay.getByRole('article', { name: 'Cora review' })).toBeVisible();
  await expect(overlay.getByRole('article', { name: 'Scratch helper' })).toBeVisible();
  const tail = overlay.getByLabel('Live output').filter({ hasText: 'NEWEST' });
  await expect(tail).toBeVisible();
  expect(await tail.evaluate(element => {
    const clip = element.parentElement!.getBoundingClientRect();
    const newest = document.createRange();
    const text = element.lastChild!;
    newest.selectNodeContents(text);
    const suffix = [...newest.getClientRects()].at(-1)!;
    return clip.height <= 7 * parseFloat(getComputedStyle(element).lineHeight) + 1 && suffix.bottom <= clip.bottom + 1 && suffix.top >= clip.top - 1;
  })).toBe(true);
  const overflow = await overlay.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const boxes = await overlay.locator('.screensaver-workspace').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
  // each phone card starts after the prior card's full height
  for (let index = 1; index < boxes.length; index += 1) expect(boxes[index]!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height);
  const grid = overlay.locator('.screensaver-grid');
  await expect.poll(() => grid.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await grid.evaluate(element => element.scrollTop)).toBe(0);
  await page.clock.fastForward(10_000);
  expect(await grid.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});
