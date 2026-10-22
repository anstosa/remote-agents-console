import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, paneInputText, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// The keyboard system: the C-b leader and its prefix table, send-prefix, the table timeout and
// its indicator, the bindings sheet and its ways in, the palette, terminal bindings that name
// the binding and never a command, and the y/n question before closing a panel.

type Pane = { paneId: string; session: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
const panes = (): Pane[] => [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
];

const routeApi = (page: Page, options: { keys?: unknown; shells?: unknown[]; deleted?: string[]; notes?: unknown[] } = {}) => page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [], ...(options.keys === undefined ? {} : { keys: options.keys }) } });
  // expose the authoritative server source to the dedicated shortcut editor
  if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
  if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'keyboard-snapshot', sources: [{ id: 'app', label: 'Application config', path: '/fixture/config/config.json', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'keyboard-app', apply: 'rac-restart', value: { keys: options.keys ?? {} }, schema: { type: 'object', properties: { keys: { type: 'json', label: 'Key tables', optional: true, apply: 'rac-restart' } } } }], status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
  if (path === '/api/push/public-key') return route.fulfill({ json: {} });
  if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
  if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: options.notes ?? [] } });
  if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes: panes() } });
  if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') {
    options.shells?.push(request.postDataJSON());
    return route.fulfill({ status: 201, json: { paneId: '%5' } });
  }
  if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'DELETE') {
    options.deleted?.push(decodeURIComponent(path.split('/').pop()!) + url.search);
    return route.fulfill({ status: 204 });
  }
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

// open the dashboard with the build shell as a focused Terminal panel beside the agent
const openWithTerminal = async (page: Page, options: Parameters<typeof routeApi>[1] = {}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await page.addInitScript(() => localStorage.setItem('rac.terminals:cora', JSON.stringify([{ paneId: '%5', name: 'build' }])));
  await routeApi(page, options);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.xterm-screen').click();
  await expect(terminal).toHaveClass(/focused/u);
  return terminal;
};

// open the server keyboard section in either settings navigation layout
const openKeyboardSettings = async (page: Page) => {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const selector = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  // use the custom selector when the resizable split is narrow
  if (await selector.isVisible()) {
    await selector.click();
    await page.getByRole('listbox').getByRole('option', { name: 'Keyboard shortcuts', exact: true }).click();
  } else await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  // command-oriented scenarios use the exclusive command view
  const view = settings.getByRole('switch', { name: 'Keyboard editor view', exact: true });
  // preserve command view when the same settings split is reopened
  if (await view.getAttribute('aria-checked') !== 'true') await view.click();
  return settings;
};

const indicator = (page: Page) => page.locator('.key-indicator');

// compare one rendered color with the active theme token
const expectThemeColor = async (element: Locator, token: '--green' | '--mauve') => {
  const colors = await element.evaluate((node, variable) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${variable})`;
    node.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(node).color, expected };
  }, token);
  expect(colors.actual).toBe(colors.expected);
};

// distinguish a dispatcher match from merely observed input
const expectIndicatorMatch = async (page: Page, matched: boolean) => {
  const badge = indicator(page);
  await expect(badge).toBeVisible();
  expect((await badge.getAttribute('class'))?.split(/\s+/u).includes('matched')).toBe(matched);
  await expect(badge).toHaveCSS('border-style', matched ? 'solid' : 'dashed');
  await expectThemeColor(badge, matched ? '--green' : '--mauve');
};

test('C-b runs a prefix key, swallows an unbound one, and C-b C-b reaches the terminal', async ({ page }) => {
  await openWithTerminal(page);

  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toHaveAccessibleName('Key table Ctrl + B, binding matched');
  await expect(indicator(page)).toContainText('Ctrl + B');
  await expectIndicatorMatch(page, true);
  // an unbound key ends the table and goes nowhere, as in tmux
  await page.keyboard.press('q');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then Q, no binding matched');
  await expect(indicator(page).locator('.key-indicator-next')).toHaveText('→');
  await expectIndicatorMatch(page, false);
  await expect(indicator(page)).toHaveCount(0, { timeout: 2_000 });

  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then Ctrl + B, binding matched');
  await expectIndicatorMatch(page, true);
  await page.keyboard.type('ls');
  await expect.poll(() => paneInputText(page, '%5')).toContain('\u0002ls');
  expect(await paneInputText(page, '%5')).not.toContain('q');

  await page.keyboard.press('Control+b');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();
});

test('ordinary terminal input reaches the terminal without shortcut feedback', async ({ page }) => {
  await openWithTerminal(page);
  await page.keyboard.down('Control');
  await expect(indicator(page)).toHaveCount(0);
  await page.keyboard.up('Control');
  for (const key of ['Control+a', 'Control+e', 'Control+l', 'Escape', 'Shift+ArrowLeft', 'Control+r']) await page.keyboard.press(key);
  // readline's C-a/C-e/C-l/C-r and Vim's Escape go through; Shift+Left reaches xterm with one tab
  await expect.poll(() => paneInputText(page, '%5')).toBe('\u0001\u0005\u000c\u001b\u001b[1;2D\u0012');
  await expect(indicator(page)).toHaveCount(0);
});

test('a table waits ten seconds, with an indicator that drains, then drops back to root', async ({ page }) => {
  await page.clock.install();
  await openWithTerminal(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));

  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toBeVisible();
  const duration = await indicator(page).locator('.key-indicator-bar').evaluate(element => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeGreaterThan(9.5);
  await page.clock.fastForward(1_600);
  await expect(indicator(page)).toBeVisible();
  await expect(indicator(page).locator('.key-indicator-bar')).toHaveCSS('animation-duration', duration);
  await page.clock.fastForward(7_400);
  await expect(indicator(page)).toBeVisible();
  await page.clock.fastForward(1_100);
  await expect(indicator(page)).toHaveCount(0);
  // the expired leader no longer captures the next key
  await page.keyboard.type('c');
  await expect.poll(() => paneInputText(page, '%5')).toContain('c');
});

test('keeps the leader with its suffix above the focused prompt until one shared fade', async ({ page }) => {
  await page.clock.install();
  await openWithTerminal(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('first line\nsecond line\nthird line');
  await page.locator('.terminal-pane[data-panel-key="%5"] .xterm-screen').click();

  await page.keyboard.press('Control+b');
  const leaderDuration = await indicator(page).locator('.key-indicator-bar').evaluate(element => getComputedStyle(element).animationDuration);
  // held leaders neither duplicate the sequence nor restart its deadline
  await prompt.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, repeat: true, bubbles: true, composed: true, cancelable: true })));
  await expect(indicator(page)).toHaveAccessibleName('Key table Ctrl + B, binding matched');
  await expect(indicator(page).locator('.key-indicator-bar')).toHaveCSS('animation-duration', leaderDuration);
  await page.keyboard.down('Shift');
  await expect(indicator(page)).toHaveAccessibleName('Key table Ctrl + B, binding matched');
  await expect(indicator(page).locator('.key-indicator-bar')).toHaveCSS('animation-duration', leaderDuration);
  await page.keyboard.up('Shift');

  await page.keyboard.press('1');
  const badge = indicator(page);
  // release the panel focus scheduled by the shortcut
  await page.clock.fastForward(16);
  await expect(prompt).toBeFocused();
  await expect(badge).toHaveAccessibleName('Key press Ctrl + B then 1, binding matched');
  await expect(badge.locator('.shortcut-keys')).toHaveCount(2);
  await expect(badge.locator('.key-indicator-next')).toHaveText('→');
  await expectIndicatorMatch(page, true);

  const badgeBox = await badge.boundingBox();
  const panelBox = await page.locator('.log-output').boundingBox();
  const composerBox = await page.getByRole('region', { name: 'Prompt composer' }).boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(badgeBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
  expect(badgeBox!.y + badgeBox!.height).toBeLessThanOrEqual(composerBox!.y);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v4-prompt-sequence.png', fullPage: true });

  await page.clock.fastForward(1_483);
  await expect(badge).toBeVisible();
  await page.clock.fastForward(2);
  await expect(badge).toHaveCount(0);

  // global chrome still clears the tallest visible split input
  await page.getByRole('button', { name: 'Global settings' }).focus();
  await page.keyboard.press('z');
  await expect(badge).toHaveAccessibleName('Key press Z, no binding matched');
  const globalBox = await badge.boundingBox();
  const currentComposerBox = await page.getByRole('region', { name: 'Prompt composer' }).boundingBox();
  expect(globalBox).not.toBeNull();
  expect(currentComposerBox).not.toBeNull();
  expect(globalBox!.y + globalBox!.height).toBeLessThanOrEqual(currentComposerBox!.y);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v4-global-chrome.png', fullPage: true });
});

test('keeps nested and repeatable prefix sequences together without growing stale history', async ({ page }) => {
  await page.clock.install();
  const shells: unknown[] = [];
  await openWithTerminal(page, { shells, keys: { prefix: { 'S-g': { table: 'git' } }, git: { l: { terminal: 'lazygit' } } } });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));

  await page.keyboard.press('Control+b');
  await page.keyboard.press('Shift+g');
  await expect(indicator(page)).toHaveAccessibleName('Key table git, binding matched');
  await expect(indicator(page).locator('.shortcut-keys')).toHaveCount(2);
  await page.keyboard.press('l');
  await expect.poll(() => shells).toEqual([{ binding: { table: 'git', key: 'l' } }]);
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then Shift + G then L, binding matched');
  await expect(indicator(page).locator('.shortcut-keys')).toHaveCount(3);
  await expect(indicator(page).locator('.key-indicator-next')).toHaveCount(2);
  await page.clock.fastForward(1_501);
  await expect(indicator(page)).toHaveCount(0);

  await page.keyboard.press('Control+b');
  await page.keyboard.press('ArrowLeft');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then ←, binding matched');
  await page.keyboard.press('ArrowLeft');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then ←, binding matched');
  await expect(indicator(page).locator('.shortcut-keys')).toHaveCount(2);
  await expect(indicator(page).locator('.key-indicator-next')).toHaveText('→');
  await page.clock.fastForward(1_499);
  await expect(indicator(page)).toBeVisible();
  await page.clock.fastForward(2);
  await expect(indicator(page)).toHaveCount(0);
});

test('the bindings sheet opens from Ctrl+?, settings and the palette, and shows where each binding came from', async ({ page }) => {
  await openWithTerminal(page, { keys: { root: { 'C-b': null, 'C-a': { table: 'prefix' }, 'C-g': { table: 'git' }, 'C-0': null, 'Super-0': null }, prefix: { c: 'command-palette' }, git: { l: { terminal: 'lazygit' } } } });
  const sheet = page.getByRole('dialog', { name: 'Key bindings' });

  await page.keyboard.press('Control+?');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-shortcut-command="action:show-bindings"]')).toContainText(/Default$/u);
  const prefixCommand = sheet.locator('[data-shortcut-command="table:prefix"]');
  await expect(prefixCommand).toHaveCount(1);
  await expect(prefixCommand).toHaveAttribute('data-shortcut-origins', /root:C-a/u);
  await expect(prefixCommand).toHaveAttribute('data-shortcut-origins', /root:C-b/u);
  await expect(prefixCommand.getByLabel('Ctrl + A', { exact: true })).toBeVisible();
  await expect(prefixCommand).toContainText('Config');
  await expect(prefixCommand.locator('s')).toHaveCount(0);
  await expect(sheet.locator('[data-shortcut-command="action:command-palette"]')).toContainText('Config, replaces the default');
  await expect(sheet.locator('[data-shortcut-command="terminal:git:l"]')).toContainText('Terminal running lazygit');
  // the quick reference remains read-only and identifies server-disabled commands
  const removedReference = sheet.locator('[data-shortcut-command="action:font-reset"]');
  await expect(removedReference.locator('.shortcut-keys')).toHaveCount(0);
  await expect(removedReference.locator('s')).toHaveText('Reset terminal font size');
  await expect(sheet.getByRole('button', { name: 'Edit shortcuts', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Edit in Settings', exact: true })).toBeVisible();
  // C-? again closes it and hands focus back to the terminal
  await page.keyboard.press('Control+?');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toHaveClass(/focused/u);

  // open the quick reference from settings instead of the workspace toolbar
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Key bindings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Global settings' }).click();
  await openKeyboardSettings(page);
  await page.getByRole('button', { name: 'View active shortcuts', exact: true }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // the removed C-b now reaches the terminal, and the configured leader opens the palette
  await page.locator('.terminal-pane[data-panel-key="%5"] .xterm-screen').click();
  await page.keyboard.press('Control+b');
  await expect.poll(() => paneInputText(page, '%5')).toContain('\u0002');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('c');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('key bindings');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(sheet).toBeVisible();
});

test('opening a keyboard overlay by mouse cancels a stale leader table', async ({ page }) => {
  const shells: unknown[] = [];
  await openWithTerminal(page, { shells });
  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toHaveAccessibleName('Key table Ctrl + B, binding matched');

  await page.getByRole('button', { name: 'Global settings' }).click();
  await openKeyboardSettings(page);
  await page.getByRole('button', { name: 'View active shortcuts', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Key bindings' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Close key bindings' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.locator('.terminal-pane[data-panel-key="%5"] .xterm-screen').click();
  await page.keyboard.press('c');
  await expect.poll(() => paneInputText(page, '%5')).toContain('c');
  expect(shells).toEqual([]);
  await expect(indicator(page)).toHaveCount(0);
});

test('a root binding swallows its key, and send-prefix reaches only a terminal', async ({ page }) => {
  const shells: unknown[] = [];
  await page.addInitScript(() => {
    // keep the last C-g and C-b keydowns, read once dispatch is over
    window.addEventListener('keydown', event => { if (event.ctrlKey && (event.key === 'g' || event.key === 'b')) Object.assign(window, { [`__last_${event.key}`]: event }); }, true);
  });
  await openWithTerminal(page, { shells, keys: { root: { 'C-g': { table: 'git' } }, git: { l: { terminal: 'lazygit' } } } });
  await page.keyboard.press('Control+g');
  await page.keyboard.press('l');
  await expect.poll(() => shells).toEqual([{ binding: { table: 'git', key: 'l' } }]);
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + G then L, binding matched');
  await expectIndicatorMatch(page, true);
  expect(await page.evaluate(() => (window as unknown as { __last_g: KeyboardEvent }).__last_g.defaultPrevented)).toBe(true);
  expect(await paneInputText(page, '%5')).not.toContain('\u0007');

  // from the composer the leader goes nowhere, rather than to the browser (Firefox's bookmarks)
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(() => (window as unknown as { __last_b: KeyboardEvent }).__last_b.defaultPrevented)).toBe(true);
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then Ctrl + B, binding matched');
});

test('a terminal binding names the binding, never the command', async ({ page }) => {
  const shells: unknown[] = [];
  await openWithTerminal(page, { shells });
  await page.keyboard.press('Control+b');
  await page.keyboard.press('g');
  await expect.poll(() => shells).toEqual([{ binding: { table: 'prefix', key: 'g' } }]);
});

test('the palette opens the Code panel and a bound key closes it', async ({ page }) => {
  await openWithTerminal(page, { keys: { prefix: { k: 'toggle-code' } } });
  const code = page.locator('.code-pane');

  await page.keyboard.press('Control+b');
  await page.keyboard.press(':');
  await page.keyboard.type('code panel');
  await page.keyboard.press('Enter');
  await expect(code).toBeVisible();
  await expect(code).toBeFocused();

  await page.keyboard.press('Control+b');
  await page.keyboard.press('k');
  await expect(code).toHaveCount(0);
});

test('closing a panel asks first, and only y closes it', async ({ page }) => {
  const deleted: string[] = [];
  await openWithTerminal(page, { deleted });

  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  await expect(indicator(page)).toHaveAccessibleName('Close Terminal build?, binding matched');
  await page.keyboard.press('n');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then X then N, binding matched');
  await expectIndicatorMatch(page, true);
  await page.waitForTimeout(200);
  expect(deleted).toEqual([]);

  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  await page.keyboard.press('y');
  // an idle shell ends at once; a busy one would still ask before its DELETE is confirmed
  await expect.poll(() => deleted).toEqual(['%5']);
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + B then X then Y, binding matched');
  const completedBox = await indicator(page).boundingBox();
  expect(completedBox).not.toBeNull();
  expect(completedBox!.x).toBeGreaterThanOrEqual(0);
  expect(completedBox!.y).toBeGreaterThanOrEqual(0);
  expect(completedBox!.x + completedBox!.width).toBeLessThanOrEqual(1_400);
  expect(completedBox!.y + completedBox!.height).toBeLessThanOrEqual(900);
});

test('closing dirty Settings by keyboard uses its split confirmation', async ({ page }) => {
  await openWithTerminal(page);
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Interface', exact: true }).click();
  await settings.getByRole('radio', { name: 'Light theme', exact: true }).click();

  // Settings owns the dirty close instead of the generic y/n key prompt
  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  const confirmation = settings.getByRole('alertdialog', {
    name: 'Close Settings with unsaved changes?',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('y');
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole('radio', { name: 'Light theme', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
});

test('shows transient mobile feedback above the focused split input', async ({ page }) => {
  await page.clock.install();
  const terminal = await openWithTerminal(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const minimize = terminal.getByRole('button', { name: 'Minimize terminal build' });
  await minimize.focus();
  await page.keyboard.down('Control');
  await expect(indicator(page)).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(indicator(page)).toHaveAccessibleName('Key press Ctrl + A, no binding matched');
  await expectIndicatorMatch(page, false);
  await page.keyboard.up('Control');
  await page.keyboard.press('z');
  const badge = indicator(page);
  await expect(badge).toHaveAccessibleName('Key press Z, no binding matched');
  await expectIndicatorMatch(page, false);
  const terminalKeys = terminal.getByLabel('Terminal keys');
  const feedbackMetrics = await badge.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      duration: getComputedStyle(element.querySelector('.key-indicator-bar')!).animationDuration
    };
  });
  const inputBox = await terminalKeys.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(feedbackMetrics.bottom).toBeLessThanOrEqual(inputBox!.y);
  expect(feedbackMetrics.left).toBeGreaterThanOrEqual(inputBox!.x);
  expect(feedbackMetrics.right).toBeLessThanOrEqual(inputBox!.x + inputBox!.width);
  expect(Number.parseFloat(feedbackMetrics.duration)).toBeCloseTo(1.5, 1);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v4-indicator-mobile.png', fullPage: true });
  await page.clock.fastForward(1_501);
  await expect(badge).toHaveCount(0);

  // disable only the countdown animation while retaining its JS lifetime
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await minimize.focus();
  await page.keyboard.press('y');
  await expect(badge.locator('.key-indicator-bar')).toHaveCSS('animation-name', 'none');
  await page.clock.fastForward(1_501);
  await expect(badge).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  await page.keyboard.press('x');
  await expect(badge.locator('.key-indicator-bar')).toHaveCSS('animation-name', 'none');
  await page.clock.fastForward(1_501);
  await expect(badge).toHaveCount(0);
  await page.evaluate(() => { delete document.documentElement.dataset.motion; });
});

test('suppresses feedback for prompt, output, Terminal, notes, fields and modal editing', async ({ page }) => {
  const terminal = await openWithTerminal(page, { notes: [{ id: 'note-cora-000001', title: 'Draft note', text: 'Editable note body' }] });
  const badge = indicator(page);

  // terminal input remains application input
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('z');
  await expect.poll(() => paneInputText(page, '%5')).toContain('z');
  await expect(badge).toHaveCount(0);

  // prompt typing remains private while consumed shortcuts remain visible
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('draft');
  await prompt.press('a');
  await expect(prompt).toHaveValue('drafta');
  await expect(badge).toHaveCount(0);
  await prompt.press('Shift+Enter');
  await expect(prompt).toHaveValue('drafta\n');
  await expect(badge).toHaveCount(0);
  await prompt.press('Control+b');
  await expect(badge).toHaveAccessibleName('Key table Ctrl + B, binding matched');
  await prompt.press('1');
  await expect(badge).toHaveAccessibleName('Key press Ctrl + B then 1, binding matched');

  // wait for the consumed shortcut before testing more typing surfaces
  await expect(badge).toHaveCount(0, { timeout: 2_000 });
  const output = page.locator('.log-output .xterm-screen');
  await output.click();
  await page.keyboard.press('v');
  await expect(badge).toHaveCount(0);

  // note editing never echoes its content
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Draft note', exact: true }).click();
  await page.getByLabel('Note preview').click();
  const note = page.getByRole('textbox', { name: 'Note content' });
  await expect(note).toBeFocused();
  await note.press('n');
  await expect(badge).toHaveCount(0);

  // ordinary password fields remain fully silent
  const password = page.locator('input[type="password"][aria-label="Synthetic password"]');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'password';
    input.setAttribute('aria-label', 'Synthetic password');
    document.body.append(input);
  });
  await password.focus();
  await password.press('s');
  await expect(badge).toHaveCount(0);
  await password.press('Control+b');
  await expect(badge).toHaveCount(0);
  await password.press('q');
  await expect(badge).toHaveCount(0);

  // modal controls and config-backed recorders never render global feedback
  await page.getByRole('button', { name: 'Global settings' }).click();
  const keyboardSettings = await openKeyboardSettings(page);
  await keyboardSettings.getByRole('searchbox', { name: 'Find keyboard shortcuts' }).press('r');
  await expect(badge).toHaveCount(0);
  await keyboardSettings.getByRole('searchbox', { name: 'Find keyboard shortcuts' }).fill('Switch to the prefix table');
  await keyboardSettings.locator('[data-shortcut-command="table:prefix"] .shortcut-change').click();
  const recorder = keyboardSettings.getByRole('textbox', { name: 'New shortcut for Switch to the prefix table' });
  await recorder.press('Control+a');
  await expect(recorder).toHaveValue('Ctrl + A');
  await expect(badge).toHaveCount(0);

});

test('prefix keys move between panels and the Workspace picker lists them', async ({ page }) => {
  const terminal = await openWithTerminal(page);
  const composer = page.getByRole('textbox', { name: 'Prompt' });

  await page.keyboard.press('Control+b');
  await page.keyboard.press('1');
  await expect(composer).toBeFocused();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('n');
  await expect(terminal).toHaveClass(/focused/u);
  await page.keyboard.press('Control+b');
  await page.keyboard.press('l');
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+b');
  await page.keyboard.press('w');
  const tree = page.getByRole('dialog', { name: 'Workspaces and panels' });
  await expect(tree.getByRole('option')).toHaveText([/Cora/u, 'Agent output', 'Terminal build']);
  await page.keyboard.type('build');
  await page.keyboard.press('Enter');
  await expect(tree).toHaveCount(0);
  await expect(terminal).toHaveClass(/focused/u);
});
