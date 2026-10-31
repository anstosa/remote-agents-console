import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushExit, dropPane, paneAckTotal, paneConnectCount, paneInputText } from './pane-stream-mock.js';
import { clickPanelAction, expectPanelAction } from './panel-header';
import { chooseSplit, openSplitMenu, tapSplit } from './split-menu.js';

// Terminal panels (First-class terminal panes, Console shells): the composer's terminal icon
// picker lists a Worktree's panes, opening one adds a resizable column beside the agent, a
// focused Terminal takes typed keys while the composer stays the Agent's, minimizing hides the
// panel and an `exit` frame removes it, New shell creates a Console shell, storage reopens
// live panels after a reload, and an agentless Worktree can open a Terminal too.

type Pane = { paneId: string; session: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
// retain created note content across mocked requests
type Note = { id: string; text: string; title?: string };

const agentPanes: Pane[] = [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%2', session: '$1', window: '@0', command: 'htop', path: '/worktrees/cora', title: '', agent: false },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false },
  { paneId: '%6', session: '$1', window: '@2', command: 'vim', path: '/worktrees/cora/src', title: '', agent: false },
  // a hand-split sibling of %6: same window @2, so opening %6 must disable %7 (one claim per window)
  { paneId: '%7', session: '$1', window: '@2', command: 'less', path: '/worktrees/cora/src', title: '', agent: false }
];

// A live-mutable pane set + prompt capture, so a spec can change what the panes API returns
// (a reload dropping a gone pane, a New shell appearing) between navigations. A DELETE prunes
// the ended pane and records its query, a PATCH renames one, mirroring the real panes API.
const routeApi = (page: Page, options: { panes: () => Pane[]; onShell?: () => string; prompts?: string[]; deleted?: string[]; deleteStatus?: (paneId: string, confirmed: boolean) => number | { status: number; busy?: boolean }; renamed?: { paneId: string; name: string }[]; notes?: Note[]; savedNotes?: string[]; noteCreateStatus?: () => number } = { panes: () => agentPanes }) =>
  page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // list this scenario's persisted notes
    if (path === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: options.notes ?? [] } });
    // create a note through the shared persistence boundary
    if (path === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const status = options.noteCreateStatus?.() ?? 201;
      // retain selection after a rejected note create
      if (status < 200 || status >= 300) return route.fulfill({ status, json: { error: 'create failed' } });
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-terminal-${(options.notes?.length ?? 0) + 1}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      options.notes?.unshift(note);
      return route.fulfill({ status, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(path);
    // persist editor autosaves for created notes
    if (noteMatch && request.method() === 'PUT') {
      const text = (request.postDataJSON() as { text: string }).text;
      const note = options.notes?.find(candidate => candidate.id === noteMatch[1]);
      // reject saves for notes outside this scenario
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing note' } });
      note.text = text;
      options.savedNotes?.push(text);
      return route.fulfill({ json: note });
    }
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes: options.panes() } });
    if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') return route.fulfill({ status: 201, json: { paneId: options.onShell ? options.onShell() : '%9' } });
    if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'PATCH') {
      const paneId = decodeURIComponent(path.split('/').pop()!);
      const name = (request.postDataJSON() as { name: string }).name;
      options.renamed?.push({ paneId, name });
      const pane = options.panes().find(candidate => candidate.paneId === paneId);
      if (pane !== undefined) pane.name = name;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'DELETE') {
      const paneId = decodeURIComponent(path.split('/').pop()!);
      options.deleted?.push(paneId + url.search);
      const deletion = options.deleteStatus?.(paneId, url.searchParams.get('confirm') === '1') ?? 204;
      const status = typeof deletion === 'number' ? deletion : deletion.status;
      const failure = typeof deletion === 'number' ? { error: 'delete failed' } : { error: 'delete failed', busy: deletion.busy };
      // keep failed deletions visible
      if (status < 200 || status >= 300) return route.fulfill({ status, json: failure });
      const panes = options.panes();
      const index = panes.findIndex(candidate => candidate.paneId === paneId);
      if (index >= 0) panes.splice(index, 1);
      return route.fulfill({ status });
    }
    if (path === '/api/agents/agent-1/prompt' && request.method() === 'POST') { options.prompts?.push((request.postDataJSON() as { prompt: string }).prompt); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

const openPicker = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Open a terminal' }).click();

// drag across live terminal text
const selectTerminalText = async (page: Page, terminal: Locator, text: string) => {
  const row = terminal.locator('.xterm-rows > div', { hasText: text });
  await expect(row).toBeVisible();
  await terminal.locator('.xterm-helper-textarea').focus();
  const bounds = await row.boundingBox();
  expect(bounds).not.toBeNull();
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(bounds!.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + Math.min(100, bounds!.width / 3), y, { steps: 5 });
  await page.mouse.up();
  return { row, bounds: bounds! };
};

// create a phone-native browser range
const selectTerminalNativeRange = (row: Locator, start: number, end: number) => row.evaluate((element, offsets) => {
  const range = document.createRange();
  range.setStart(element.firstChild!, offsets.start);
  range.setEnd(element.firstChild!, offsets.end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}, { start, end });

// measure parent and panel together after responsive footer changes settle
const expectFullSplitHeight = async (panel: Locator) => {
  // retry against one consistent browser layout
  await expect.poll(() => panel.evaluate(element => {
    const panelBox = element.getBoundingClientRect();
    const splitBox = element.parentElement!.getBoundingClientRect();
    return { top: Math.round(panelBox.y - splitBox.y), height: Math.round(panelBox.height - splitBox.height) };
  })).toEqual({ top: 0, height: 0 });
};

// the toolbar's Terminal button: labelled on desktop, a square icon button on the phone
test('terminal picker is the toolbar’s Terminal button on desktop and phone', async ({ page }) => {
  // opt in for terminal picker marker checks
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // check both composer layouts
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const trigger = page.getByRole('button', { name: 'Open a terminal', exact: true });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveClass(/\btoolbar-button\b/u);
    await expect(trigger).toHaveAttribute('title', 'Open a terminal');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger.locator('.flyout-caret')).toBeVisible();
    await expect(trigger.locator('svg[aria-hidden="true"]')).toBeVisible();
    await expect(trigger.locator('.terminal-minimized-count')).toHaveText('1');
    // match the terminal glyph to its neighboring action icons
    await expect(trigger.locator('svg')).toHaveCSS('width', '16px');
    await expect(trigger.locator('svg')).toHaveCSS('height', '16px');

    const more = page.getByRole('button', { name: 'More options', exact: true });
    const referenceBox = await more.boundingBox();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(referenceBox).not.toBeNull();
    expect(triggerBox!.height).toBeCloseTo(referenceBox!.height, 1);
    const phone = viewport.width < 600;
    // the label shows beside the glyph on desktop and folds away on the phone
    await expect(trigger.locator('.toolbar-label')).toBeVisible({ visible: !phone });
    if (phone) expect(triggerBox!.width).toBeCloseTo(triggerBox!.height, 1);
    else expect(triggerBox!.width).toBeGreaterThan(triggerBox!.height);

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu', { name: 'Open a terminal' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menu', { name: 'Open a terminal' })).toHaveCount(0);
  }
});

test('lists panes with the agent and a claimed window disabled, and opens a column with a resizer', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker).toBeVisible();
  // the agent's own pane and a pane sharing the agent's claimed window are both disabled
  await expect(picker.getByRole('menuitem', { name: /codex/u })).toBeDisabled();
  await expect(picker.getByRole('menuitem', { name: /htop/u })).toBeDisabled();
  // a pickable Console shell reads its name
  const shell = picker.getByRole('menuitem', { name: /build/u });
  await expect(shell).toBeEnabled();

  await shell.click();
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  await expect(column.getByText('build')).toBeVisible();
  const header = column.locator(':scope > .panel-header .panel-header-title');
  const status = header.locator('.pane-status');
  // until the seed lands the header reads the stream's status, ahead of the name
  await expect(status).toHaveText('Connecting');
  await expect(header.locator(':scope > *').first()).toHaveClass(/\bpane-status\b/u);
  await expect(status).toHaveAttribute('role', 'status');
  await expect(header.locator('.pane-dot, .pane-live')).toHaveCount(0);
  const outputStatus = column.locator('.streamed-terminal-status');
  await expect(outputStatus).toBeVisible();
  await expect(outputStatus).toHaveAttribute('aria-busy', 'true');
  const terminalSkeleton = outputStatus.locator('.output-skeleton-terminal');
  await expect(terminalSkeleton).toBeVisible();
  await expect(terminalSkeleton.locator('.output-skeleton-command')).not.toHaveCount(0);
  await expect.poll(() => terminalSkeleton.locator('.output-skeleton-output-row').count()).toBeGreaterThanOrEqual(6);
  await expect.poll(() => terminalSkeleton.locator('.skeleton').count()).toBeGreaterThanOrEqual(6);
  await expect(outputStatus.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  // resolve the theme yellow
  const yellow = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--yellow)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(status).toHaveCSS('background-color', yellow);
  // share the agent panel's connection pill styling (the pill only shows while
  // the agent's stream is not live, so probe one in the agent panel's title pill)
  await page.locator('.agent-panel .panel-header-title').evaluate(title => { const probe = document.createElement('span'); probe.className = 'status log-status connecting agent-status-probe'; probe.textContent = 'Connecting'; title.append(probe); });
  const agentStatus = page.locator('.agent-status-probe');
  for (const property of ['color', 'background-color', 'border-radius', 'box-shadow', 'font-family', 'font-weight', 'text-transform']) {
    const reference = await agentStatus.evaluate((element, key) => getComputedStyle(element).getPropertyValue(key), property);
    await expect(status).toHaveCSS(property, reference);
  }
  await expect(status).toHaveCSS('height', '20px');
  // both header pills are the same size: the agent's connection pill and the shell's status
  const agentStatusBox = (await agentStatus.boundingBox())!;
  const shellStatusBox = (await status.boundingBox())!;
  expect(shellStatusBox.height).toBeCloseTo(agentStatusBox.height, 0);
  const agentFontSize = await agentStatus.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  const shellFontSize = await status.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(shellFontSize).toBeCloseTo(agentFontSize, 3);
  // a live stream shows no status
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell ready\r\n');
  await expect(status).toHaveCount(0);
  // a dropped stream shows its reconnect until the fresh seed lands
  const connects = await paneConnectCount(page, '%5');
  await dropPane(page, '%5');
  await expect(status).toHaveText('Reconnecting…');
  await expect(outputStatus).toBeVisible();
  await expect(outputStatus).toHaveAttribute('aria-busy', 'true');
  await expect(outputStatus).toContainText('Reconnecting…');
  await expect(outputStatus.locator('.output-skeleton-terminal')).toBeVisible();
  await expect(outputStatus.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  await expect.poll(() => paneConnectCount(page, '%5'), { timeout: 5000 }).toBeGreaterThan(connects);
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell back\r\n');
  await expect(outputStatus).toBeHidden();
  await expect(status).toHaveCount(0);
  await expect(page.locator('.log-split.has-terminals')).toBeVisible();
  // a resizer sits between the agent and the new column
  await expect(page.locator('.log-split .split-resizer')).toHaveCount(1);
});

test('opening a Terminal disables the other panes sharing its window', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // %6 and %7 both live in window @2; neither is claimed yet
  await openPicker(page);
  let picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker.getByRole('menuitem', { name: /less/u })).toBeEnabled();
  await picker.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%6"]')).toBeVisible();

  // now that %6 holds window @2's claim, its sibling %7 is no longer pickable, but %5 (@1) is
  await openPicker(page);
  picker = page.getByRole('menu', { name: 'Open a terminal' });
  const sibling = picker.getByRole('menuitem', { name: /less/u });
  await expect(sibling).toBeDisabled();
  await expect(sibling).toHaveAttribute('title', 'Another terminal already uses this window');
  await expect(picker.getByRole('menuitem', { name: /build/u })).toBeEnabled();
});

test('New shell creates a Console shell and opens it as a Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const created: Pane = { paneId: '%9', session: '$1', window: '@3', role: 'shell', name: '', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false };
  const panes = [...agentPanes];
  await routeApi(page, { panes: () => panes, onShell: () => { panes.push(created); return '%9'; } });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: 'New shell' }).click();
  await seedPaneSize(page, '%9', 80, 24);
  await pushBytes(page, '%9', 'new shell\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toBeVisible();
});

test('a focused Terminal takes typed keys while the composer still submits to the Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const prompts: string[] = [];
  await routeApi(page, { panes: () => agentPanes, prompts });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await column.locator('.xterm-screen').click();
  await expect(column).toHaveClass(/focused/u);
  await page.keyboard.type('ls');
  await expect.poll(() => paneInputText(page, '%5')).toContain('ls');

  // the composer stays bound to the Agent
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.fill('deploy please');
  await composer.press('Enter');
  await expect.poll(() => prompts).toContain('deploy please');
});

// cover desktop selection ownership, copy feedback and ordered release
test('a Terminal selection freezes only its pane and keeps keyboard ownership local', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1600, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', `${'\r\n'.repeat(8)}Freeze selected terminal output`);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await pushBytes(page, '%6', `${'\r\n'.repeat(8)}Independent terminal output`);

  const build = page.locator('.terminal-pane[data-panel-key="%5"]');
  const vim = page.locator('.terminal-pane[data-panel-key="%6"]');
  const selection = await selectTerminalText(page, build, 'Freeze selected terminal output');
  const toolbar = build.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  await expect(build).toHaveClass(/\bfocused\b/u);
  await expect(build).toHaveClass(/\bselection-active\b/u);
  await expect(vim).not.toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();

  // selection gray replaces the focused sky ring
  const colors = await build.evaluate(element => {
    const probe = document.createElement('span');
    document.body.append(probe);
    probe.style.color = 'var(--subtext-0)';
    const gray = getComputedStyle(probe).color;
    probe.style.color = 'var(--sky)';
    const sky = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(element, '::after').borderTopColor, gray, sky };
  });
  expect(colors.border).toBe(colors.gray);
  expect(colors.border).not.toBe(colors.sky);

  const buildText = await selection.row.textContent();
  const buildAck = await paneAckTotal(page, '%5');
  const vimAck = await paneAckTotal(page, '%6');
  await pushBytes(page, '%5', '\r\x1b[2Kqueued build output');
  await pushBytes(page, '%6', '\r\x1b[2Klive vim output');
  await page.waitForTimeout(100);
  await expect(selection.row).toHaveText(buildText!);
  expect(await paneAckTotal(page, '%5')).toBe(buildAck);
  await expect(vim.locator('.xterm-rows > div', { hasText: 'live vim output' })).toBeVisible();
  await expect.poll(() => paneAckTotal(page, '%6')).toBeGreaterThan(vimAck);

  const highlight = build.locator('.xterm-selection > div').first();
  const originalHighlight = await highlight.evaluate(element => getComputedStyle(element).backgroundColor);
  // a shortcut copy flashes and keeps the selection (the toolbar's Copy would deselect it)
  await build.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  const selectedText = await page.evaluate(() => navigator.clipboard.readText());
  await expect(highlight).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await page.waitForTimeout(350);
  await expect(highlight).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await expect(highlight).toHaveCSS('background-color', originalHighlight, { timeout: 900 });
  await expect(build).toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();

  // every terminal copy shortcut preserves selection and skips stdin
  const buildInputBeforeCopies = await paneInputText(page, '%5');
  for (const shortcut of ['Control+c', 'Meta+c', 'y', 'Control+Shift+c']) {
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await build.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press(shortcut);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
    await expect(build).toHaveClass(/\bselection-copied\b/u);
    await expect(build).not.toHaveClass(/\bselection-copied\b/u);
    await expect(build).toHaveClass(/\bselection-active\b/u);
  }
  expect(await paneInputText(page, '%5')).toBe(buildInputBeforeCopies);

  // stale selection never owns another pane or text input
  await page.evaluate(() => navigator.clipboard.writeText('selection-guard'));
  await vim.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('y');
  await expect.poll(() => paneInputText(page, '%6')).toContain('y');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('selection-guard');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('dra');
  await prompt.press('y');
  await expect(prompt).toHaveValue('dray');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('selection-guard');
  await clickPanelAction(build, 'Rename terminal build');
  const rename = build.getByRole('textbox', { name: 'Name for terminal build', exact: true });
  await rename.fill('deplo');
  await rename.press('y');
  await expect(rename).toHaveValue('deploy');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('selection-guard');
  await rename.press('Escape');
  await expect(toolbar).toBeVisible();

  // clearing selection releases queued bytes, then Ctrl+C returns to interrupt
  await page.mouse.click(selection.bounds.x + selection.bounds.width * .8, selection.bounds.y + selection.bounds.height / 2);
  await expect(toolbar).toBeHidden();
  await expect(build).not.toHaveClass(/\bselection-active\b/u);
  await expect(build.locator('.xterm-rows > div', { hasText: 'queued build output' })).toBeVisible();
  await expect.poll(() => paneAckTotal(page, '%5')).toBeGreaterThan(buildAck);
  await build.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await expect.poll(() => paneInputText(page, '%5')).toContain(String.fromCharCode(3));
});

// cover long-press selection persistence on a phone
test('a native Terminal selection freezes output through copied feedback', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'Freeze native terminal output');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  const row = terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'Freeze native terminal output' });
  await expect(row).toHaveText('Freeze native terminal output');
  await selectTerminalNativeRange(row, 0, 'Freeze'.length);
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  await expect(terminal).toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Freeze');

  const acknowledged = await paneAckTotal(page, '%5');
  await pushBytes(page, '%5', '\r\x1b[2Kqueued native output');
  await page.waitForTimeout(100);
  expect(await paneAckTotal(page, '%5')).toBe(acknowledged);
  await expect(row).toHaveText('Freeze native terminal output');

  await toolbar.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Freeze');
  await expect(terminal).toHaveClass(/\bselection-copied\b/u);
  await page.waitForTimeout(350);
  await expect(terminal).toHaveClass(/\bselection-copied\b/u);
  await expect(terminal).not.toHaveClass(/\bselection-copied\b/u, { timeout: 900 });

  // once the copied flash has shown, Copy drops the range and closes the toolbar, which
  // releases the queued output in order
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(terminal).not.toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeHidden();
  await expect(terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'queued native output' })).toBeVisible();
  await expect.poll(() => paneAckTotal(page, '%5')).toBeGreaterThan(acknowledged);
  await context.close();
});

// desktop selection actions preserve drafts and open notes from fullscreen
test('Terminal selection actions append to the prompt and create a note from fullscreen', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const notes: Note[] = [];
  const savedNotes: string[] = [];
  const prompts: string[] = [];
  await routeApi(page, { panes: () => agentPanes, notes, savedNotes, prompts });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('existing draft');
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', `${'\r\n'.repeat(8)}Selected terminal note text`);

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await selectTerminalText(page, terminal, 'Selected terminal note text');
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  // expose every terminal selection action by its exact label
  for (const label of ['Create note', 'Add to prompt', 'Copy']) await expect(toolbar.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create note', exact: true })).toBeEnabled();

  await toolbar.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  const selectedText = await page.evaluate(() => navigator.clipboard.readText());
  // Copy deselects once its flash has shown, closing the toolbar
  await expect(toolbar).toBeHidden();
  await expect(terminal).not.toHaveClass(/\bselection-active\b/u);

  await selectTerminalText(page, terminal, 'Selected terminal note text');
  await toolbar.getByRole('button', { name: 'Add to prompt', exact: true }).click();
  await expect(prompt).toHaveValue(`existing draft\n\n${selectedText}`);
  expect(prompts).toEqual([]);
  await expect(toolbar).toBeHidden();
  await expect(terminal.locator('.xterm-selection > div')).toHaveCount(0);

  await selectTerminalText(page, terminal, 'Selected terminal note text');
  await terminal.getByRole('button', { name: 'Expand terminal build' }).click();
  await expect(terminal).toHaveClass(/\bexpanded\b/u);
  await toolbar.getByRole('button', { name: 'Create note', exact: true }).click();
  const notePane = page.getByRole('dialog', { name: 'Note' });
  await expect(notePane).toBeVisible();
  await expect(terminal).not.toHaveClass(/\bexpanded\b/u);
  await expect(notePane.locator('.note-picker strong')).toHaveText(selectedText);
  await expect(page.getByLabel('Note preview')).toContainText(selectedText);
  await expect.poll(() => savedNotes).toContain(selectedText);
  expect(notes[0]).toMatchObject({ text: selectedText, title: selectedText });
  expect(prompts).toEqual([]);
  await expect(toolbar).toBeHidden();
  await expect(terminal.locator('.xterm-selection > div')).toHaveCount(0);
});

// phone-native selection actions remain reachable and reveal the updated draft
test('a phone Terminal selection adds text to the agent prompt and switches panels', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  await installPaneMock(page);
  const prompts: string[] = [];
  await routeApi(page, { panes: () => agentPanes, prompts, notes: [] });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('mobile draft');
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'Prefix Mobile terminal action');

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  const accessibilityTree = terminal.locator('.xterm-accessibility-tree');
  // synthesize the native range boundary beyond one viewport of scrollback
  await accessibilityTree.evaluate((tree, length) => {
    const probe = document.createElement('div');
    probe.dataset.selectionLimitProbe = 'true';
    probe.textContent = 'x'.repeat(length);
    tree.append(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, 30_001);
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  await expect(toolbar.getByRole('button', { name: 'Create note', exact: true })).toBeDisabled();
  await accessibilityTree.locator('[data-selection-limit-probe="true"]').evaluate(probe => {
    window.getSelection()?.removeAllRanges();
    probe.remove();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(toolbar).toBeHidden();

  const row = terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'Prefix Mobile terminal action' });
  await expect(row).toHaveText('Prefix Mobile terminal action');
  await selectTerminalNativeRange(row, 'Prefix '.length, 'Prefix Mobile'.length);
  // keep note, draft and copy actions touch-reachable
  for (const label of ['Create note', 'Add to prompt', 'Copy']) await expect(toolbar.getByRole('button', { name: label, exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt', exact: true }).tap();

  await expect(terminal).not.toBeInViewport();
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect(prompt).toBeInViewport();
  await expect(prompt).toHaveValue('mobile draft\n\nMobile');
  await expect(toolbar).toBeHidden();
  expect(prompts).toEqual([]);
  await context.close();
});

// failed phone note creation preserves selection for a successful retry
test('a phone Terminal keeps its selected text when note creation fails', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  await installPaneMock(page);
  const notes: Note[] = [];
  const savedNotes: string[] = [];
  let rejectCreate = true;
  await routeApi(page, { panes: () => agentPanes, notes, savedNotes, noteCreateStatus: () => rejectCreate ? 503 : 201 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'Prefix Retryable terminal note');

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  const row = terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'Prefix Retryable terminal note' });
  await expect(row).toHaveText('Prefix Retryable terminal note');
  await selectTerminalNativeRange(row, 'Prefix '.length, 'Prefix Retryable'.length);
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  const create = toolbar.getByRole('button', { name: 'Create note', exact: true });
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/worktrees/cora/notes' && response.request().method() === 'POST' && response.status() === 503);
  await Promise.all([rejected, create.tap()]);

  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();
  await expect(create).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Retryable');
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0);
  expect(notes).toEqual([]);

  rejectCreate = false;
  await create.tap();
  const notePane = page.getByRole('dialog', { name: 'Note' });
  await expect(notePane).toBeInViewport({ ratio: 0.99 });
  await expect(terminal).not.toBeInViewport();
  await expect(notePane.locator('.note-picker strong')).toHaveText('Retryable');
  await expect(page.getByLabel('Note preview')).toContainText('Retryable');
  await expect.poll(() => savedNotes).toContain('Retryable');
  expect(notes[0]).toMatchObject({ text: 'Retryable', title: 'Retryable' });
  await context.close();
});

// hidden agent output releases its selection behind terminal fullscreen
test('terminal fullscreen clears an agent selection and releases queued output', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Agent selection before fullscreen`);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);

  const output = page.locator('.log-output');
  await selectTerminalText(page, output, 'Agent selection before fullscreen');
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log-output')).toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();
  const acknowledged = await paneAckTotal(page, 'agent-1');
  await pushBytes(page, 'agent-1', '\r\x1b[2Kagent output released behind fullscreen');
  await page.waitForTimeout(100);
  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledged);

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.getByRole('button', { name: 'Expand terminal build' }).click();
  await expect(output).toBeHidden();
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.log-output')).not.toHaveClass(/\bselection-active\b/u);
  await expect(output.locator('.xterm-selection > div')).toHaveCount(0);
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledged);

  await terminal.getByRole('button', { name: 'Restore terminal build' }).click();
  await expect(output.locator('.xterm-rows > div', { hasText: 'agent output released behind fullscreen' })).toBeVisible();
  await expect(toolbar).toBeHidden();
  // the pane's resize on restoring must not repaint the selection it dropped while hidden
  await page.waitForTimeout(300);
  await expect(output.locator('.xterm-selection > div')).toHaveCount(0);
});

// real touch switches release a hidden terminal selection before returning
test('a phone panel switch clears native Terminal selection and releases queued output', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'Native terminal selection before switch');

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  const row = terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'Native terminal selection before switch' });
  await expect(row).toHaveText('Native terminal selection before switch');
  await selectTerminalNativeRange(row, 0, 'Native'.length);
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  await expect(terminal).toHaveClass(/\bselection-active\b/u);
  await expect(toolbar).toBeVisible();
  const acknowledged = await paneAckTotal(page, '%5');
  await pushBytes(page, '%5', '\r\x1b[2Kterminal output released behind agent');
  await page.waitForTimeout(100);
  expect(await paneAckTotal(page, '%5')).toBe(acknowledged);

  await tapSplit(page, 'Agent output');
  await expect(terminal).not.toBeInViewport();
  await expect(toolbar).toBeHidden();
  await expect(terminal).not.toHaveClass(/\bselection-active\b/u);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await expect.poll(() => paneAckTotal(page, '%5')).toBeGreaterThan(acknowledged);

  await tapSplit(page, 'Terminal build');
  await expect(terminal).toBeInViewport({ ratio: 0.99 });
  await expect(terminal.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: 'terminal output released behind agent' })).toBeVisible();
  await expect(toolbar).toBeHidden();
  await context.close();
});

test('minimizing keeps a shell running, persists across reload, and updates the trigger badge', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  const panes: Pane[] = [...agentPanes.map(pane => ({ ...pane })), { paneId: '%8', session: '$1', window: '@4', role: 'shell', name: 'server', command: 'node', path: '/worktrees/cora', title: '', agent: false, busy: true }];
  await routeApi(page, { panes: () => panes, deleted });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  const trigger = page.getByRole('button', { name: 'Open a terminal', exact: true });
  const badge = trigger.locator('.terminal-minimized-count');
  // count only hidden console shells
  await expect(badge).toHaveText('2');
  await expect(trigger).toHaveAttribute('aria-description', '2 minimized shells');
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  await expect(badge).toHaveText('1');
  await expect(trigger).toHaveAttribute('aria-description', '1 minimized shell');

  // minimize hides without deleting
  const minimize = column.getByRole('button', { name: 'Minimize terminal build', exact: true });
  await expect(minimize.locator('svg[aria-hidden="true"]')).toBeVisible();
  await minimize.click();
  await expect(column).toHaveCount(0);
  await expect(badge).toHaveText('2');
  await expect(trigger).toHaveAttribute('aria-description', '2 minimized shells');
  expect(deleted).toEqual([]);

  // minimized state survives reload
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await expect(column).toHaveCount(0);
  await expect(badge).toHaveText('2');
  await expect(trigger).toHaveAttribute('aria-description', '2 minimized shells');

  // reopening reduces the count
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(column).toBeVisible();
  await expect(badge).toHaveText('1');
  await expect(trigger).toHaveAttribute('aria-description', '1 minimized shell');

  // exit does not create a minimized shell
  await pushExit(page, '%5', 'pane closed');
  await expect(column).toHaveCount(0);
  await expect(badge).toHaveText('1');
  await expect(trigger).toHaveAttribute('aria-description', '1 minimized shell');
});

test('a reload reopens panels whose pane still exists and drops those that do not', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  let panes = [...agentPanes];
  await routeApi(page, { panes: () => panes });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // open two Terminals
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane')).toHaveCount(2);

  // the vim pane is gone when the page reloads
  panes = agentPanes.filter(pane => pane.paneId !== '%6');
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await expect(page.locator('.terminal-pane[data-panel-key="%6"]')).toHaveCount(0);
});

test('two Terminals plus the agent resize independently within the minimum width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  await expect(page.locator('.log-split .split-resizer')).toHaveCount(2);

  const widths = async () => page.evaluate(() => ({
    agent: document.querySelector('.log-output')!.getBoundingClientRect().width,
    a: document.querySelector('.terminal-pane[data-panel-key="%5"]')!.getBoundingClientRect().width,
    b: document.querySelector('.terminal-pane[data-panel-key="%6"]')!.getBoundingClientRect().width
  }));
  const before = await widths();
  // each column respects the 390px minimum
  expect(Math.min(before.agent, before.a, before.b)).toBeGreaterThanOrEqual(389);

  // drag the resizer between the agent and the first Terminal; the third column is untouched
  const resizer = page.locator('.log-split .split-resizer').first();
  const box = (await resizer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await widths();
  expect(after.agent).toBeGreaterThan(before.agent + 40);
  expect(Math.abs(after.b - before.b)).toBeLessThan(20);

  // dragging the %5|%6 divider far right cannot shrink %6 below the 390px floor
  const between = page.locator('.log-split .split-resizer').nth(1);
  const box2 = (await between.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 500, box2.y + box2.height / 2, { steps: 10 });
  await page.mouse.up();
  const clamped = await widths();
  expect(clamped.b).toBeGreaterThanOrEqual(389);
});

// cover every combination that previously left empty grid rows
for (const panels of ['note', 'browser', 'note and browser']) {
  // keep mixed desktop panels and the selected phone panel full-height
  test(`a shell with ${panels} uses the full split height`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    await installPaneMock(page);
    await routeApi(page);
    // provide a browser target alongside the existing pane fixture
    await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0, projectUrl: 'https://preview.example/', projectProxied: false }], projects: [] } }));
    // provide one saved note
    await page.route('**/api/worktrees/cora/notes', route => route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Mixed split note' }] } }));
    // avoid external navigation in the embedded browser
    await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Split preview</main>' }));
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', 'agent ready\r\n');

    // open the requested supplemental panels before the shell
    if (panels.includes('browser')) await page.getByRole('button', { name: 'Browser', exact: true }).click();
    // select the saved note when this combination includes it
    if (panels.includes('note')) {
      await page.getByRole('button', { name: 'Notes (1)' }).click();
      await page.getByRole('button', { name: 'Mixed split note…', exact: true }).click();
    }
    await openPicker(page);
    await page.getByRole('menuitem', { name: /build/u }).click();
    await seedPaneSize(page, '%5', 80, 24);
    await pushBytes(page, '%5', 'shell ready\r\n');

    const split = page.locator('.log-split');
    await expect(split).toHaveClass(/\bhas-terminals\b/u);
    const visiblePanels = split.locator(':scope > :is(.log-output, .terminal-pane, .note-pane, .browser-pane):visible');
    await expect(visiblePanels).toHaveCount(panels === 'note and browser' ? 4 : 3);
    // every desktop column fills the same available output area
    for (const panel of await visiblePanels.all()) await expectFullSplitHeight(panel);

    const terminalHeader = split.locator('.terminal-pane[data-panel-key="%5"] > .panel-header');
    const referenceHeader = split.locator(panels.includes('browser') ? '.browser-pane > .panel-header' : '.note-pane > .panel-header').first();
    // align shell chrome with adjacent splits
    await expect.poll(async () => {
      const terminalBox = await terminalHeader.boundingBox();
      const referenceBox = await referenceHeader.boundingBox();
      return Math.round((terminalBox?.height ?? 0) - (referenceBox?.height ?? 0));
    }).toBe(0);
    const referenceHeaderHeight = (await referenceHeader.boundingBox())!.height;
    const minimize = terminalHeader.getByRole('button', { name: 'Minimize terminal build', exact: true });
    const referenceButton = referenceHeader.getByRole('button', { name: panels.includes('browser') ? 'Close browser' : 'Close note', exact: true });
    await expect(minimize).toHaveCSS('width', await referenceButton.evaluate(element => getComputedStyle(element).width));
    await expect(minimize).toHaveCSS('height', await referenceButton.evaluate(element => getComputedStyle(element).height));
    await expect(minimize).toHaveCSS('border-style', 'solid');
    await expect(minimize).toHaveCSS('background-color', await referenceButton.evaluate(element => getComputedStyle(element).backgroundColor));
    const minimizeIcon = minimize.locator('svg[aria-hidden="true"]');
    await expect(minimizeIcon).toBeVisible();
    await expect(minimizeIcon.locator('path')).toHaveAttribute('d', 'M5 12h14');
    // compare rendered icon centers
    const minimizeAlignment = await minimizeIcon.evaluate(element => {
      const svg = element as SVGSVGElement;
      const buttonBox = svg.parentElement!.getBoundingClientRect();
      const svgBox = svg.getBoundingClientRect();
      const pathBox = (svg.querySelector('path') as SVGGraphicsElement).getBBox();
      return {
        button: buttonBox.y + buttonBox.height / 2 - (svgBox.y + svgBox.height / 2),
        path: pathBox.y + pathBox.height / 2 - (svg.viewBox.baseVal.y + svg.viewBox.baseVal.height / 2)
      };
    });
    expect(Math.abs(minimizeAlignment.button)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(minimizeAlignment.path)).toBeLessThanOrEqual(0.5);

    // exercise terminal fullscreen parity once
    if (panels === 'note and browser') {
      const terminal = split.locator('.terminal-pane[data-panel-key="%5"]');
      const canvas = terminal.locator('.terminal-canvas');
      const expand = terminalHeader.locator('.panel-header-expand');
      await expect(expand).toHaveAccessibleName('Expand terminal build');
      await expect(expand).toHaveAttribute('aria-pressed', 'false');
      // mark the live canvas across toggles
      await canvas.evaluate(element => { element.dataset.fullscreenProbe = 'preserved'; });
      await expand.click();
      await expect(terminal).toHaveClass(/\bexpanded\b/u);
      await expect(expand).toHaveAccessibleName('Restore terminal build');
      await expect(expand).toHaveAttribute('aria-pressed', 'true');
      await expect(visiblePanels).toHaveCount(1);
      await expect(split.locator(':scope > .split-resizer:visible')).toHaveCount(0);
      const expandedBox = (await terminal.boundingBox())!;
      const splitBox = (await split.boundingBox())!;
      expect(expandedBox.width).toBeCloseTo(splitBox.width, 0);
      expect(expandedBox.height).toBeCloseTo(splitBox.height, 0);
      await expect(canvas).toHaveAttribute('data-fullscreen-probe', 'preserved');

      // the toggle restores sibling panels
      await expand.click();
      await expect(terminal).not.toHaveClass(/\bexpanded\b/u);
      await expect(expand).toHaveAccessibleName('Expand terminal build');
      await expect(visiblePanels).toHaveCount(4);
      await expect(canvas).toHaveAttribute('data-fullscreen-probe', 'preserved');

      // canvas Escape remains terminal input
      await expand.click();
      await canvas.locator('.xterm-screen').click();
      await page.keyboard.press('Escape');
      await expect.poll(() => paneInputText(page, '%5')).toContain(String.fromCharCode(27));
      await expect(terminal).toHaveClass(/\bexpanded\b/u);

      // header Escape restores the split
      await expand.focus();
      await page.keyboard.press('Escape');
      await expect(terminal).not.toHaveClass(/\bexpanded\b/u);
      await expect(visiblePanels).toHaveCount(4);

      // minimizing fullscreen restores siblings
      await expand.click();
      await minimize.click();
      await expect(terminal).toHaveCount(0);
      await expect(visiblePanels).toHaveCount(3);
      await expect(split.locator('.log-output')).toBeVisible();
      await expect(split.locator('.note-pane')).toBeVisible();
      await expect(split.locator('.browser-pane')).toBeVisible();
      await openPicker(page);
      await page.getByRole('menuitem', { name: /build/u }).click();
      await seedPaneSize(page, '%5', 80, 24);
      await expect(visiblePanels).toHaveCount(4);
    }

    // remove the browser divider and its grid track together in mobile preview mode
    if (panels.includes('browser')) {
      const browser = split.locator('.browser-pane');
      const divider = split.locator('.browser-resizer');
      await clickPanelAction(browser, 'Use mobile viewport');
      await expect(divider).toBeHidden();
      await expect(browser).toHaveCSS('width', '390px');
      const frameBox = (await browser.locator('iframe').boundingBox())!;
      expect(frameBox.width).toBeGreaterThanOrEqual(388);
      expect(frameBox.width).toBeLessThanOrEqual(390);
      const mobileBrowserBox = (await browser.boundingBox())!;
      const mobilePreviewSplit = (await split.boundingBox())!;
      expect(mobileBrowserBox.height).toBeCloseTo(mobilePreviewSplit.height, 0);
      expect(mobileBrowserBox.x + mobileBrowserBox.width).toBeCloseTo(mobilePreviewSplit.x + mobilePreviewSplit.width, 0);

      await browser.getByRole('button', { name: 'Expand browser' }).click();
      await expect(browser).toHaveCSS('width', '1800px');
      await browser.getByRole('button', { name: 'Restore browser' }).click();
      await expect(browser).toHaveCSS('width', '390px');

      await clickPanelAction(browser, 'Use desktop viewport');
      await expect(divider).toBeVisible();
      const desktopBrowserBox = (await browser.boundingBox())!;
      expect(desktopBrowserBox.width).toBeGreaterThanOrEqual(390);
    }

    // collapse fullscreen at the phone breakpoint
    if (panels === 'note and browser') {
      await terminalHeader.locator('.panel-header-expand').click();
      await expect(split.locator('.terminal-pane[data-panel-key="%5"]')).toHaveClass(/\bexpanded\b/u);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneTerminal = split.locator('.terminal-pane[data-panel-key="%5"]');
    await expect(phoneTerminal).not.toHaveClass(/\bexpanded\b/u);
    // on the phone expand offers full screen instead
    await expect(terminalHeader.locator('.panel-header-expand')).toBeVisible();
    // one panel per screen: the last opened, the Terminal
    await expect(phoneTerminal).toBeInViewport({ ratio: 0.99 });
    await expect(split.locator('.log-output')).not.toBeInViewport();
    await expectFullSplitHeight(phoneTerminal);
    const phoneHeaderHeight = (await terminalHeader.boundingBox())!.height;
    expect(phoneHeaderHeight).toBeCloseTo(referenceHeaderHeight, 0);
    await chooseSplit(page, 'Agent output');
    await expect(split.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
    await expectFullSplitHeight(split.locator('.log-output'));
    await chooseSplit(page, 'Terminal build');
    await expect(phoneTerminal).toBeInViewport({ ratio: 0.99 });
    await expectFullSplitHeight(phoneTerminal);
    await chooseSplit(page, 'Agent output');
    await expect(split.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  });
}

// open the agent, a browser, a note and a Terminal side by side on a wide desktop
const openFourPanels = async (page: Page) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0, projectUrl: 'https://preview.example/', projectProxied: false }], projects: [] } }));
  await page.route('**/api/worktrees/cora/notes', route => route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Expandable note' }, { id: 'note-cora-000002', text: 'Second note' }] } }));
  await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Split preview</main>' }));
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'agent ready\r\n');
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Notes (2)' }).click();
  await page.getByRole('button', { name: 'Expandable note…', exact: true }).click();
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const split = page.locator('.log-split');
  const visiblePanels = split.locator(':scope > :is(.log-output, .terminal-pane, .note-pane, .browser-pane):visible');
  await expect(visiblePanels).toHaveCount(4);
  return { split, visiblePanels };
};

// Every panel kind expands through one shared mechanism: its expand fills the Workspace with it,
// Esc restores the rest, and closing an expanded panel restores the rest without re-expanding it later.
test('every panel kind expands to fill the Workspace and Esc restores its siblings', async ({ page }) => {
  const { split, visiblePanels } = await openFourPanels(page);
  for (const [selector, label] of [['.log-output', 'agent output'], ['.terminal-pane', 'terminal build'], ['.note-pane', 'note'], ['.browser-pane', 'browser']]) {
    const panel = split.locator(selector);
    await panel.getByRole('button', { name: `Expand ${label}`, exact: true }).click();
    await expect(panel).toHaveClass(/\bexpanded\b/u);
    await expect(visiblePanels).toHaveCount(1);
    await expect(panel).toBeVisible();
    const restore = panel.getByRole('button', { name: `Restore ${label}`, exact: true });
    await expect(restore).toHaveAttribute('aria-pressed', 'true');
    // Esc restores the siblings without closing the panel (a note or browser closes on Escape otherwise)
    await restore.press('Escape');
    await expect(panel).not.toHaveClass(/\bexpanded\b/u);
    await expect(visiblePanels).toHaveCount(4);
  }

  // switching notes from an expanded note's picker keeps it expanded
  const note = split.locator('.note-pane');
  await note.getByRole('button', { name: 'Expand note', exact: true }).click();
  await note.getByRole('button', { name: /^Switch note \(2 here\)/u }).click();
  await page.getByRole('group', { name: 'Notes here' }).getByRole('button', { name: /Second note/u }).click();
  await expect(note).toContainText('Second note');
  await expect(note).toHaveClass(/\bexpanded\b/u);
  await note.getByRole('button', { name: 'Restore note', exact: true }).click();
  await expect(visiblePanels).toHaveCount(4);

  // closing the expanded panel restores the rest, and reopening it does not expand it again
  const browser = split.locator('.browser-pane');
  await browser.getByRole('button', { name: 'Expand browser', exact: true }).click();
  await expect(visiblePanels).toHaveCount(1);
  await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
  await expect(visiblePanels).toHaveCount(3);
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser).toBeVisible();
  await expect(browser).not.toHaveClass(/\bexpanded\b/u);
  await expect(visiblePanels).toHaveCount(4);
});

// A panel narrower than the fold width keeps its secondary actions in its header's ⋮; a wide one
// shows them inline. Esc closes an open ⋮ without closing the panel.
test('a narrow panel folds its secondary actions into the header ⋮', async ({ page }) => {
  const { split, visiblePanels } = await openFourPanels(page);
  const browser = split.locator('.browser-pane');
  const more = browser.getByRole('button', { name: 'More browser actions', exact: true });
  await expect(more).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Go to project home', exact: true })).toHaveCount(0);
  // the primary actions stay in the pill
  await expect(browser.getByRole('button', { name: 'Refresh browser', exact: true })).toBeVisible();
  await expect(browser.getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute('href', 'https://preview.example/');

  await more.click();
  const menu = page.getByRole('group', { name: 'More browser actions' });
  await expect(menu.getByRole('button', { name: 'Go to project home', exact: true })).toContainText('Go to project home');
  await expect(menu.getByRole('button', { name: 'Use mobile viewport', exact: true })).toBeVisible();
  await more.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(browser).toBeVisible();
  await expect(visiblePanels).toHaveCount(4);

  // a row runs its action and closes the ⋮
  await more.click();
  await menu.getByRole('button', { name: 'Use mobile viewport', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);

  // the same note header folds too, and its ⋮ keeps Esc from closing the note
  const note = split.locator('.note-pane');
  await note.getByRole('button', { name: 'More note actions', exact: true }).click();
  const lock = page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Lock note', exact: true });
  await expect(lock).toBeVisible();
  await lock.press('Escape');
  await expect(page.getByRole('group', { name: 'More note actions' })).toHaveCount(0);
  await expect(note).toBeVisible();

  // expanded to the Workspace's width the header has room, so secondary actions are inline again
  await note.getByRole('button', { name: 'Expand note', exact: true }).click();
  await expect(note.getByRole('button', { name: 'Lock note', exact: true })).toBeVisible();
  const expandedMore = note.getByRole('button', { name: 'More note actions', exact: true });
  await expect(expandedMore).toBeVisible();
  await expandedMore.click();
  const expandedMenu = page.getByRole('group', { name: 'More note actions' });
  await expect(expandedMenu.getByRole('button', { name: 'Schedule note', exact: true })).toBeVisible();
  await expect(expandedMenu.getByRole('button', { name: 'Lock note', exact: true })).toHaveCount(0);
});

test('on a phone the carousel gains a dot for the Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);

  // the newly opened Terminal is the phone panel in view; the dots offer the agent
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeInViewport({ ratio: 0.99 });
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);
  const dots = page.getByRole('group', { name: 'Panels' });
  await expect(dots).toBeVisible();
  await chooseSplit(page, 'Agent output');
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect(column).not.toBeInViewport();
  // panel switching is not minimizing
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);
  // the Terminal's dot returns to it
  await chooseSplit(page, 'Terminal build');
  await expect(column).toBeInViewport({ ratio: 0.99 });
});

test('an agentless Worktree tab restores its existing Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const panes: Pane[] = [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
      { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (path === '/api/worktrees/cora/launch-resolution') return route.fulfill({ json: { adapters: [] } });
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /Cora/u }).click();

  // an otherwise empty workspace restores its existing managed shell
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell in an agentless worktree\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
});

// with no agent panel, a phone's Terminal keeps its helper keys in the split
test('on a phone an agentless Workspace keeps its toolbar below the Terminal helper keys', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installPaneMock(page);
  const panes: Pane[] = [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
      { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (path === '/api/worktrees/cora/launch-resolution') return route.fulfill({ json: { adapters: [] } });
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');

  const workspaceToolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(workspaceToolbar.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  // an otherwise empty workspace restores its existing managed shell
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeInViewport({ ratio: 0.99 });

  // the in-split keys and static toolbar remain separate and both accessible
  await expect(page.locator('.terminal-pane[data-panel-key="%5"] .mobile-terminal-keys')).toBeVisible();
  await expect(workspaceToolbar.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(workspaceToolbar.getByRole('button', { name: 'More options' })).toBeVisible();
  await expect.poll(() => page.locator('.log').evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px');
});

// agentless terminal actions retain worktree-local notes and launch drafts
test('an agentless Worktree Terminal can create a note and prepare its prompt', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const panes: Pane[] = [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }];
  const notes: Note[] = [];
  const savedNotes: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
      { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (path === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-agentless-${notes.length + 1}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(path);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing note' } });
      note.text = (request.postDataJSON() as { text: string }).text;
      savedNotes.push(note.text);
      return route.fulfill({ json: note });
    }
    if (path === '/api/worktrees/cora/launch-resolution') return route.fulfill({ json: { adapters: [] } });
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /Cora/u }).click();
  // an otherwise empty workspace restores its existing managed shell
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', `${'\r\n'.repeat(8)}Agentless terminal selection`);

  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await selectTerminalText(page, terminal, 'Agentless terminal selection');
  const toolbar = terminal.getByRole('toolbar', { name: 'Selection actions for terminal build' });
  await toolbar.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  const selectedText = await page.evaluate(() => navigator.clipboard.readText());
  await expect(toolbar).toBeHidden();

  await selectTerminalText(page, terminal, 'Agentless terminal selection');
  await toolbar.getByRole('button', { name: 'Add to prompt', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue(selectedText);
  await expect(toolbar).toBeHidden();
  // the opened draft composer carries the Worktree's git status
  await expect(page.getByRole('button', { name: /^Git status:/u })).toBeVisible();

  await selectTerminalText(page, terminal, 'Agentless terminal selection');
  await toolbar.getByRole('button', { name: 'Create note', exact: true }).click();
  const notePane = page.getByRole('dialog', { name: 'Note' });
  await expect(notePane).toBeVisible();
  await expect(notePane.locator('.note-picker strong')).toHaveText(selectedText);
  await expect.poll(() => savedNotes).toContain(selectedText);
  expect(notes[0]).toMatchObject({ text: selectedText, title: selectedText });
});

test('the picker groups hidden Console shells and reopens one when chosen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  // the Agent's panes sit under Session panes, the shell in its own Console shells group
  await expect(picker.getByText('Session panes')).toBeVisible();
  await expect(picker.getByText('Console shells')).toBeVisible();
  const shell = picker.getByRole('menuitem', { name: /build/u });
  await expect(shell).toBeEnabled();
  await shell.click();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();

  // once open it is no longer a hidden shell, so the group disappears (the picker still opens)
  await openPicker(page);
  const reopened = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(reopened.getByText('Session panes')).toBeVisible();
  await expect(reopened.getByText('Console shells')).toHaveCount(0);
});

test('only a Console shell offers a rename affordance', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // %6 (vim) is a hand-split pane, not a Console shell — the panes API cannot rename it
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  const vim = page.locator('.terminal-pane[data-panel-key="%6"]');
  await expect(vim).toBeVisible();
  await expect(vim.getByRole('button', { name: /Rename terminal/u })).toHaveCount(0);
  // rename is the Terminal's only folding action, so unmanaged panes need no More
  await expect(vim.locator('.panel-header-more')).toHaveCount(0);

  // a Console shell does offer it
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await expectPanelAction(page.locator('.terminal-pane[data-panel-key="%5"]'), /Rename terminal/u, rename => expect(rename).toBeVisible());
});

test('a managed shell header deletes through the pane endpoint while failed deletion stays open', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  const panes: Pane[] = [
    { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
    { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false },
    { paneId: '%6', session: '$1', window: '@2', command: 'vim', path: '/worktrees/cora/src', title: '', agent: false }
  ];
  await routeApi(page, { panes: () => panes, deleted, deleteStatus: paneId => paneId === '%8' ? 500 : 204 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const build = page.locator('.terminal-pane[data-panel-key="%5"]');
  const removeBuild = build.getByRole('button', { name: 'Delete terminal build', exact: true });
  // keep Delete in the top-right header even when Rename folds on a phone
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(build.getByRole('toolbar', { name: 'Terminal build actions' }).getByRole('button', { name: 'Delete terminal build' })).toBeVisible();
  await expect(build.getByRole('button', { name: 'More terminal build actions' })).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(removeBuild.locator('svg[aria-hidden="true"]')).toBeVisible();
  await removeBuild.click();
  await expect.poll(() => deleted).toContain('%5');
  await expect(build).toHaveCount(0);
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);

  // add one busy managed shell
  panes.push({ paneId: '%8', session: '$1', window: '@4', role: 'shell', name: 'server', command: 'node', path: '/worktrees/cora', title: '', agent: false, busy: true });
  await openPicker(page);
  await expect(page.locator('.terminal-minimized-count')).toHaveText('1');
  await page.getByRole('menuitem', { name: /server/u }).click();
  await seedPaneSize(page, '%8', 80, 24);
  const server = page.locator('.terminal-pane[data-panel-key="%8"]');
  const removeServer = server.getByRole('button', { name: 'Delete terminal server', exact: true });
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);

  let acceptDeletion = false;
  let dialogs = 0;
  // exercise cancel and acceptance
  page.on('dialog', dialog => {
    dialogs++;
    // choose the current attempt
    if (acceptDeletion) void dialog.accept();
    else void dialog.dismiss();
  });
  await removeServer.click();
  await expect.poll(() => dialogs).toBe(1);
  expect(deleted).not.toContain('%8?confirm=1');
  await expect(server).toBeVisible();
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);

  // rejected requests retain the open shell
  acceptDeletion = true;
  await removeServer.click();
  await expect.poll(() => deleted).toContain('%8?confirm=1');
  await expect(server).toBeVisible();
  await expect(server.getByRole('alert')).toHaveClass(/\bpane-status\b.*\berror\b/u);
  await expect(server.getByRole('alert')).toHaveText('Delete failed');
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);

  // unmanaged panes never gain deletion
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  const vim = page.locator('.terminal-pane[data-panel-key="%6"]');
  await expect(vim).toBeVisible();
  await expect(vim.getByRole('button', { name: /Delete terminal/u })).toHaveCount(0);
  await expect(vim.locator('.panel-header-more')).toHaveCount(0);
});

test('a stale idle shell asks before retrying a busy DELETE conflict', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  const panes: Pane[] = [
    { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
    { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
  ];
  await routeApi(page, { panes: () => panes, deleted, deleteStatus: (_paneId, confirmed) => confirmed ? 204 : { status: 409, busy: true } });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const build = page.locator('.terminal-pane[data-panel-key="%5"]');
  const removeBuild = build.getByRole('button', { name: 'Delete terminal build', exact: true });

  let acceptRetry = false;
  let dialogs = 0;
  // control the conflict retry
  page.on('dialog', dialog => {
    dialogs++;
    // choose the current attempt
    if (acceptRetry) void dialog.accept();
    else void dialog.dismiss();
  });

  await removeBuild.click();
  await expect.poll(() => dialogs).toBe(1);
  expect(deleted).toEqual(['%5']);
  await expect(build).toBeVisible();
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);

  // acceptance sends the confirmed retry
  acceptRetry = true;
  await removeBuild.click();
  await expect.poll(() => deleted).toEqual(['%5', '%5', '%5?confirm=1']);
  await expect(build).toHaveCount(0);
  await expect(page.locator('.terminal-minimized-count')).toHaveCount(0);
});

test('renaming a Console shell from its panel updates the head and the picker row', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const renamed: { paneId: string; name: string }[] = [];
  const panes = agentPanes.map(pane => ({ ...pane }));
  await routeApi(page, { panes: () => panes, renamed });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column.getByText('build')).toBeVisible();

  // rename from the panel head; the endpoint is called and the head shows the new name
  await clickPanelAction(column, /Rename terminal/u);
  const nameField = column.getByRole('textbox', { name: /Name for terminal/u });
  await nameField.fill('deploy');
  await nameField.press('Enter');
  await expect.poll(() => renamed).toContainEqual({ paneId: '%5', name: 'deploy' });
  await expect(column.getByText('deploy')).toBeVisible();

  // minimizing leaves the shell running; it returns to the picker under its new name
  await column.getByRole('button', { name: 'Minimize terminal deploy', exact: true }).click();
  await expect(column).toHaveCount(0);
  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker.getByText('Console shells')).toBeVisible();
  await expect(picker.getByRole('menuitem', { name: /deploy/u })).toBeVisible();
});

test('renaming a Console shell renames its phone dot', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  const renamed: { paneId: string; name: string }[] = [];
  const panes = agentPanes.map(pane => ({ ...pane }));
  await routeApi(page, { panes: () => panes, renamed });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();

  await clickPanelAction(column, /Rename terminal/u);
  const nameField = column.getByRole('textbox', { name: /Name for terminal/u });
  await nameField.fill('deploy');
  await nameField.press('Enter');
  await expect.poll(() => renamed).toContainEqual({ paneId: '%5', name: 'deploy' });

  // the Terminal's dot names the renamed shell
  const dots = page.getByRole('group', { name: 'Panels' });
  await chooseSplit(page, 'Agent output');
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect((await openSplitMenu(page)).getByRole('menuitem', { name: 'Terminal deploy' })).toBeVisible();
});

test('on a phone a visible Terminal shows in-split keys and the agent dot restores the composer', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);

  // the newly opened Terminal is the visible phone panel with its own helper keys
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeInViewport({ ratio: 0.99 });
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  const escKey = page.getByRole('button', { name: 'Esc' });
  await expect(escKey).toBeVisible();
  await expect(composer).not.toBeInViewport();
  // the static toolbar keeps its controls and the dots still switch panels
  const workspaceToolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(column.getByLabel('Terminal keys')).toBeVisible();
  await expect(workspaceToolbar.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(workspaceToolbar.getByRole('group', { name: 'Panels' })).toBeVisible();
  // keep every footer junction free of a divider
  const dividers = await page.evaluate(() => ({
    static: getComputedStyle(document.querySelector<HTMLElement>('.log')!).borderBottomWidth,
    agent: getComputedStyle(document.querySelector<HTMLElement>('.agent-composer')!).borderTopWidth,
    terminal: getComputedStyle(document.querySelector<HTMLElement>('.terminal-pane > .mobile-terminal-keys')!).borderTopWidth
  }));
  expect(dividers).toEqual({ static: '0px', agent: '0px', terminal: '0px' });

  // switching back to the agent panel brings the Agent's composer back and hides the keys;
  // the dots still offer the way back to the Terminal
  const dots = page.getByRole('group', { name: 'Panels' });
  await chooseSplit(page, 'Agent output');
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect(dots.locator('.terminal-dot')).toBeVisible();
  await expect(composer).toBeInViewport();
  await expect(escKey).toBeHidden();
});

// keep every bottom control row on the static workspace surface
test('bottom controls share the static workspace surface without extra row gaps', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // read both the css layers and the visible control-to-control gaps
  const readSurface = (controlContainerSelector: string, controlSelector: string) => page.evaluate(({ controlContainerSelector, controlSelector }) => {
    // require one rendered surface element
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      // fail with the missing selector rather than a null dereference
      if (element === null) throw new Error(`missing bottom surface: ${selector}`);
      return element;
    };
    // retain the properties that can paint a distinct footer layer
    const paint = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        backdropFilter: style.backdropFilter,
        boxShadow: style.boxShadow,
        borderTopWidth: style.borderTopWidth,
        borderBottomWidth: style.borderBottomWidth
      };
    };
    // find the first ancestor that visibly paints behind a row
    const effectiveSurface = (element: HTMLElement) => {
      let current: HTMLElement | null = element;
      // stop at the nearest visible color or image layer
      while (current !== null) {
        const style = getComputedStyle(current);
        const transparent = style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent';
        // retain the layer that determines the rendered footer tone
        if (!transparent || style.backgroundImage !== 'none') return { color: style.backgroundColor, image: style.backgroundImage };
        current = current.parentElement;
      }
      throw new Error('bottom surface has no painted ancestor');
    };
    // collapse all visible controls into one vertical span
    const visibleSpan = (elements: Element[]) => {
      const boxes = elements.map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
      // require visible controls in every tested mode
      if (boxes.length === 0) throw new Error('bottom surface has no visible controls');
      return { top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) };
    };
    const controls = required(controlContainerSelector);
    const tabs = required('.tabs');
    const toolbar = required('.workspace-toolbar');
    const tabControl = required('.tabs button[role="tab"].active');
    const crustProbe = document.createElement('span');
    crustProbe.style.backgroundColor = 'var(--crust)';
    document.body.append(crustProbe);
    const themeSurfaceColor = getComputedStyle(crustProbe).backgroundColor;
    crustProbe.remove();
    const controlSpan = visibleSpan([...controls.querySelectorAll(controlSelector)]);
    const tabSpan = visibleSpan([tabControl]);
    const toolbarSpan = visibleSpan([...toolbar.querySelectorAll('button')]);
    return {
      controls: paint(controls),
      tabs: paint(tabs),
      toolbar: paint(toolbar),
      effectiveControls: effectiveSurface(controls),
      effectiveTabs: effectiveSurface(tabs),
      effectiveToolbar: effectiveSurface(toolbar),
      themeSurfaceColor,
      controlToTabsGap: tabs.getBoundingClientRect().top - controls.getBoundingClientRect().bottom,
      controlToTabButtonGap: tabSpan.top - controlSpan.bottom,
      tabToToolbarButtonGap: toolbarSpan.top - tabSpan.bottom
    };
  }, { controlContainerSelector, controlSelector });
  const samples: { name: string; surface: Awaited<ReturnType<typeof readSurface>> }[] = [];
  // capture each rendered state before evaluating the shared contract
  const capture = async (name: string, controlContainerSelector: string, controlSelector: string) => {
    samples.push({ name, surface: await readSurface(controlContainerSelector, controlSelector) });
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  };

  await page.setViewportSize({ width: 1400, height: 900 });
  await capture('bottom-surface-dark-desktop-prompt', '.agent-composer', 'textarea, button');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('bottom-surface-dark-phone-prompt', '.agent-composer', 'textarea, button');

  const output = page.locator('.log-output');
  await output.locator('.xterm-screen').click();
  await expect(output).toHaveClass(/input-active/u);
  await capture('bottom-surface-dark-phone-agent-keys', '.log-output > .mobile-terminal-keys', 'button');

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(terminal).toBeInViewport({ ratio: 0.99 });
  await capture('bottom-surface-dark-phone-terminal-keys', '.terminal-pane[data-panel-key="%5"] > .mobile-terminal-keys', 'button');

  // switch the live theme so the same transparency contract covers latte
  await page.evaluate(() => {
    localStorage.setItem('rac.color-theme', 'latte');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.color-theme', newValue: 'latte' }));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('latte');
  await capture('bottom-surface-light-phone-terminal-keys', '.terminal-pane[data-panel-key="%5"] > .mobile-terminal-keys', 'button');
  await chooseSplit(page, 'Agent output');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await capture('bottom-surface-light-phone-prompt', '.agent-composer', 'textarea, button');
  await page.setViewportSize({ width: 1400, height: 900 });
  await capture('bottom-surface-light-desktop-prompt', '.agent-composer', 'textarea, button');
  await testInfo.attach('bottom-surface-measurements.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });

  // measure one hidden-row footer against the viewport edge
  const readHiddenFooter = (selector: string) => page.evaluate(target => {
    const buttons = [...document.querySelectorAll<HTMLElement>(`${target} button`)].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    // require visible controls before measuring their gutter
    if (buttons.length === 0) throw new Error(`hidden footer has no visible buttons: ${target}`);
    return {
      tabs: getComputedStyle(document.querySelector<HTMLElement>('.tabs')!).display,
      toolbar: getComputedStyle(document.querySelector<HTMLElement>('.workspace-toolbar')!).display,
      buttonCount: buttons.length,
      rowCount: new Set(buttons.map(rect => Math.round(rect.top))).size,
      bottomGap: innerHeight - Math.max(...buttons.map(rect => rect.bottom)),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    };
  }, selector);
  // keep the helper keys inside the viewport when the software keyboard hides both lower rows
  await page.setViewportSize({ width: 390, height: 844 });
  await output.locator('.xterm-screen').click();
  await expect(output).toHaveClass(/input-active/u);
  await page.evaluate(() => document.documentElement.classList.add('software-keyboard-open'));
  const keyboardLayout = await readHiddenFooter('.log-output > .mobile-terminal-keys');
  await page.screenshot({ path: testInfo.outputPath('bottom-surface-light-phone-keyboard-open.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('software-keyboard-open'));

  // keep the same gutter when expansion hides the tab and toolbar rows
  await chooseSplit(page, 'Terminal build');
  await terminal.getByRole('button', { name: 'Expand terminal build', exact: true }).click();
  await expect(terminal).toHaveClass(/\bexpanded\b/u);
  const expandedLayout = await readHiddenFooter('.terminal-pane[data-panel-key="%5"] > .mobile-terminal-keys');
  await page.screenshot({ path: testInfo.outputPath('bottom-surface-light-phone-terminal-expanded.png'), fullPage: true });

  expect(keyboardLayout.tabs).toBe('none');
  expect(keyboardLayout.toolbar).toBe('none');
  expect(keyboardLayout.buttonCount).toBe(14);
  expect(keyboardLayout.rowCount).toBe(2);
  expect.soft(keyboardLayout.bottomGap).toBeCloseTo(6, 0);
  expect(keyboardLayout.documentWidth).toBeLessThanOrEqual(keyboardLayout.viewportWidth);
  expect(expandedLayout.tabs).toBe('none');
  expect(expandedLayout.toolbar).toBe('none');
  expect(expandedLayout.buttonCount).toBe(14);
  expect(expandedLayout.rowCount).toBe(2);
  expect.soft(expandedLayout.bottomGap).toBeCloseTo(6, 0);
  expect(expandedLayout.documentWidth).toBeLessThanOrEqual(expandedLayout.viewportWidth);

  // every footer row must resolve to the static toolbar's approved crust tone
  for (const { name, surface } of samples) {
    expect(surface.effectiveToolbar.color, name).toBe(surface.themeSurfaceColor);
    expect(surface.effectiveToolbar.image, name).toBe('none');
    expect(surface.effectiveControls.color, name).toBe(surface.themeSurfaceColor);
    expect(surface.effectiveControls.image, name).toBe('none');
    expect(surface.effectiveTabs.color, name).toBe(surface.themeSurfaceColor);
    expect(surface.effectiveTabs.image, name).toBe('none');
    expect(surface.toolbar.backgroundImage, name).toBe('none');
    expect(surface.toolbar.backdropFilter, name).toBe('none');
    expect(surface.toolbar.boxShadow, name).toBe('none');
    expect(surface.toolbar.borderTopWidth, name).toBe('0px');
    expect(surface.toolbar.borderBottomWidth, name).toBe('0px');
    expect(surface.controls.backgroundImage, name).toBe('none');
    expect(surface.controls.backdropFilter, name).toBe('none');
    expect(surface.controls.boxShadow, name).toBe('none');
    expect(surface.tabs.backgroundImage, name).toBe('none');
    expect(surface.tabs.backdropFilter, name).toBe('none');
    expect(surface.tabs.boxShadow, name).toBe('none');
    expect(surface.controls.borderTopWidth, name).toBe('0px');
    expect(surface.tabs.borderTopWidth, name).toBe('0px');
    expect(surface.tabs.borderBottomWidth, name).toBe('0px');
    expect(surface.controlToTabsGap, name).toBe(0);
    expect(surface.controlToTabButtonGap, name).toBeCloseTo(6, 0);
    expect(surface.tabToToolbarButtonGap, name).toBeCloseTo(6, 0);
  }
});

test('on a phone the helper keys drive the visible Terminal, and the Agent pane on the agent panel', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();

  const esc = String.fromCharCode(27);
  // the Terminal is the visible panel, so its helper keys reach the Terminal's socket
  await page.getByRole('button', { name: 'Esc' }).click();
  await expect.poll(() => paneInputText(page, '%5')).toContain(esc);
  expect(await paneInputText(page, 'agent-1')).not.toContain(esc);

  // back on the agent panel, focusing the pane surfaces the keys and they drive the Agent
  await chooseSplit(page, 'Agent output');
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await page.locator('.log-output .xterm-screen').click();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await page.getByRole('button', { name: 'Esc' }).click();
  await expect.poll(() => paneInputText(page, 'agent-1')).toContain(esc);
});

// a tablet without its keyboard is wide but types on a software keyboard
test('on a wide screen the helper keys follow the software keyboard and Paste reaches the Terminal', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1180, height: 820 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  const keys = column.getByLabel('Terminal keys');
  await column.locator('.xterm-screen').click();
  await expect(column).toHaveClass(/focused/u);
  // a physical keyboard raises no software keyboard, so the keys stay hidden
  await expect(keys).toBeHidden();

  await page.evaluate(() => document.documentElement.classList.add('software-keyboard-open'));
  await expect(keys).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted'));
  await keys.getByRole('button', { name: 'Paste' }).click();
  await expect.poll(() => paneInputText(page, '%5')).toContain('echo pasted');
  // the tap keeps the terminal focused so the software keyboard stays up
  await expect(column).toHaveClass(/focused/u);
});

// an iPad's floating keyboard leaves the viewport whole, so touch alone shows the keys
test('on a wide touch screen the helper keys show until a physical keyboard key arrives', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 1180, height: 820 } });
  const page = await context.newPage();
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  const keys = column.getByLabel('Terminal keys');
  // a coarse pointer turns on xterm's screen-reader layer, which takes the tap above the screen
  await column.locator('.terminal-canvas').tap();
  await expect(column).toHaveClass(/focused/u);
  await expect(keys).toBeVisible();
  // letters prove nothing; an arrow key only exists on a physical keyboard
  await page.keyboard.type('ls');
  await expect(keys).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(keys).toBeHidden();
  // a docked on-screen keyboard brings them back after the physical one is detached
  await page.evaluate(() => document.documentElement.classList.add('software-keyboard-open'));
  await expect(keys).toBeVisible();
  await context.close();
});

// verify Fn stays isolated and resets with unmounted phone controls
test('on a phone Fn stays scoped to its Agent or Terminal pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.xterm-screen').click();
  const modifiers = terminal.locator('.mobile-key-modifiers');
  const terminalFn = terminal.getByRole('button', { name: 'Fn', exact: true });
  const terminalShift = terminal.getByRole('button', { name: 'Shift', exact: true });
  const terminalAlt = terminal.getByRole('button', { name: 'Alt', exact: true });
  await expect(terminalFn).toHaveAttribute('aria-pressed', 'false');
  await terminalFn.click();
  await expect(terminalFn).toHaveAttribute('aria-pressed', 'true');
  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('1');
  await expect.poll(() => paneInputText(page, '%5')).toBe('\x1bOP');

  await chooseSplit(page, 'Agent output');
  const output = page.locator('.log-output');
  await output.locator('.xterm-screen').click();
  const agentFn = output.getByRole('button', { name: 'Fn', exact: true });
  await expect(agentFn).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.type('2');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('2');
  await agentFn.click();
  await page.keyboard.type('2');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe(`2\x1bOQ`);

  await chooseSplit(page, 'Terminal build');
  await expect(terminalFn).toHaveAttribute('aria-pressed', 'false');
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('3');
  await expect.poll(() => paneInputText(page, '%5')).toBe('\x1bOP3');
  await terminalFn.click();
  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('3');
  await expect.poll(() => paneInputText(page, '%5')).toBe('\x1bOP3\x1bOR');

  const [keyBounds, modifierBounds, fnBounds, shiftBounds, altBounds] = await Promise.all([
    terminal.getByLabel('Terminal keys').boundingBox(),
    modifiers.boundingBox(),
    terminalFn.boundingBox(),
    terminalShift.boundingBox(),
    terminalAlt.boundingBox()
  ]);
  // require measurable two-row controls
  if (keyBounds === null || modifierBounds === null || fnBounds === null || shiftBounds === null || altBounds === null) throw new Error('mobile Fn keys have no layout bounds');
  expect(fnBounds.x).toBeGreaterThan(shiftBounds.x + shiftBounds.width);
  expect(fnBounds.x).toBeGreaterThan(altBounds.x + altBounds.width);
  expect(fnBounds.y).toBeCloseTo(shiftBounds.y, 1);
  expect(fnBounds.y + fnBounds.height).toBeCloseTo(altBounds.y + altBounds.height, 1);
  expect(fnBounds.y).toBeCloseTo(modifierBounds.y, 1);
  expect(fnBounds.y + fnBounds.height).toBeCloseTo(modifierBounds.y + modifierBounds.height, 1);
  expect(keyBounds.x).toBeGreaterThanOrEqual(0);
  expect(keyBounds.x + keyBounds.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('mobile-fn-terminal-320.png'), fullPage: true });
});

test('on a phone a tap on a Terminal focuses its textarea', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  // a tap focuses xterm's hidden textarea so the soft keyboard opens on the pane
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  await column.locator('.xterm-screen').click();
  await expect(column.locator('.xterm-helper-textarea')).toBeFocused();

  // the focus must land synchronously inside the click handler (iOS only raises the keyboard
  // for a focus() made from the tap's own click): dispatch a click and read activeElement in
  // the same tick, with no await between, so a deferred focus would fail this.
  await column.locator('.xterm-helper-textarea').evaluate(area => area.blur());
  const focusedSynchronously = await page.evaluate(() => {
    const screen = document.querySelector('.terminal-pane[data-panel-key="%5"] .xterm-screen');
    screen?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.activeElement?.classList.contains('xterm-helper-textarea') ?? false;
  });
  expect(focusedSynchronously).toBe(true);
});

test('on a phone minimizing a Terminal returns to the agent panel and drops its dot', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();

  // minimizing returns the phone view to the agent and removes its dot
  await column.getByRole('button', { name: 'Minimize terminal build', exact: true }).click();
  await expect(column).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect(page.locator('.panel-dots .terminal-dot')).toHaveCount(0);
  await expect(page.locator('.terminal-minimized-count')).toHaveText('1');
  // the composer is back now that no Terminal is the visible panel
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
});

test.describe('phone touch scrolling', () => {
  test.use({ hasTouch: true });
  test('a touch drag scrolls a Terminal\'s scrollback', async ({ page }) => {
    await page.setViewportSize({ width: 428, height: 880 });
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);

    await openPicker(page);
    await page.getByRole('menuitem', { name: /build/u }).click();
    await seedPaneSize(page, '%5', 80, 24);
    // fill well past the 24-row viewport so there is scrollback to reveal
    await pushBytes(page, '%5', Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n');

    const column = page.locator('.terminal-pane[data-panel-key="%5"]');
    await expect(column).toBeVisible();
    // following the live tail: no jump control, and the last line is on screen
    const jump = column.getByRole('button', { name: 'Jump to latest' });
    const visibleRows = () => page.evaluate(() => document.querySelector('.terminal-pane[data-panel-key="%5"] .xterm-rows')?.textContent ?? '');
    await expect(jump).toBeHidden();
    await expect.poll(visibleRows).toContain('line 119');
    const before = await visibleRows();

    // a one-finger drag downward reveals older output (the console owns touch scrolling)
    await page.evaluate(() => {
      const host = document.querySelector('.terminal-pane[data-panel-key="%5"] .streamed-terminal-host') as HTMLElement;
      const rect = host.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const at = (clientY: number) => new Touch({ identifier: 1, target: host, clientX: x, clientY, pageX: x, pageY: clientY });
      const fire = (type: string, touches: Touch[], changed: Touch[]) => host.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed }));
      const startTouch = at(y);
      fire('touchstart', [startTouch], [startTouch]);
      const movedTouch = at(y + 220);
      fire('touchmove', [movedTouch], [movedTouch]);
      fire('touchend', [], [movedTouch]);
    });

    // the scrollback moved: older rows are now on screen (rendered rows changed) and the
    // jump-to-latest control appears because the pane is no longer following the tail
    await expect.poll(visibleRows).not.toBe(before);
    await expect(jump).toBeVisible();
  });
});

test('End removes an idle Console shell silently and confirms a busy one', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  const panes: Pane[] = [
    { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
    { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false },
    { paneId: '%8', session: '$1', window: '@4', role: 'shell', name: 'server', command: 'node', path: '/worktrees/cora', title: '', agent: false, busy: true }
  ];
  await routeApi(page, { panes: () => panes, deleted });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; void dialog.accept(); });

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  // an idle shell ends with no confirmation, and its row disappears
  await picker.getByRole('button', { name: 'End build' }).click();
  await expect.poll(() => deleted).toContain('%5');
  expect(dialogs).toBe(0);
  await expect(picker.getByRole('menuitem', { name: /build/u })).toHaveCount(0);

  // a busy shell asks first, then ends with confirm=1
  await picker.getByRole('button', { name: 'End server' }).click();
  await expect.poll(() => deleted).toContain('%8?confirm=1');
  expect(dialogs).toBe(1);
  await expect(picker.getByRole('menuitem', { name: /server/u })).toHaveCount(0);
});

// A directory-Project or Scratch Place: Terminals, pane lists, Console shells and notes are all
// keyed by the Place id, whether an Agent runs there or not.
const notesPlaceId = 'notes:/data/notes';
const notesPlacePath = `/api/worktrees/${encodeURIComponent(notesPlaceId)}`;
const notesProject = { id: 'notes', label: 'Notes', mode: 'directory', available: true, manageWorktrees: false, stalePaths: [], worktrees: [] };
const notesPlace = (consoleShells: number) => ({ id: notesPlaceId, kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: false, ...(consoleShells > 0 ? { consoleShells } : {}) });
const notesAgent = { id: 'agent-9', sessionId: 'socket:$4', home: '/data/notes', placeId: notesPlaceId, displayLabel: 'Notes', title: 'Ready', attention: 'finished', queuedPromptCount: 0 };
// a Scratch Agent elsewhere, whose tab sorts after the directory Agent's
const scratchAgent = { id: 'agent-7', sessionId: 'socket:$7', home: '/home/me/scratch', placeId: 'scratch:/home/me/scratch', displayLabel: '~ Scratch', title: 'Ready', attention: 'finished', queuedPromptCount: 0 };

// route one directory-Project Place, recording every request path; `agentRunning` flips when the
// Agent is deleted, so the next dashboard read reports the Place without it
const routePlace = (page: Page, panes: Pane[], requests: string[], options: { agentRunning: boolean; onShell?: () => string }) =>
  page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [...options.agentRunning ? [notesAgent] : [], scratchAgent], projects: [notesProject], places: [notesPlace(panes.filter(pane => pane.role === 'shell').length)] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/agents/agent-9/tickets' || path === `${notesPlacePath}/tickets`) return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/agents/agent-9/saved-prompts' || path === '/api/agents/agent-9/prompt-history' || path === '/api/agents/agent-9/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (path === '/api/agents/agent-9' && request.method() === 'DELETE') { options.agentRunning = false; return route.fulfill({ status: 204 }); }
    if (path === `${notesPlacePath}/notes` && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (path === `${notesPlacePath}/panes` && request.method() === 'GET') return route.fulfill({ json: { panes } });
    if (path === `${notesPlacePath}/shells` && request.method() === 'POST') return route.fulfill({ status: 201, json: { paneId: options.onShell ? options.onShell() : '%9' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

// keep directory-shell creation on its direct empty-state path
test('a directory-Project Agent opens Terminals and notes at its Place', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const created: Pane = { paneId: '%9', session: '$4', window: '@3', role: 'shell', name: '', command: 'zsh', path: '/data/notes', title: '', agent: false, busy: false };
  const panes: Pane[] = [{ paneId: '%8', session: '$4', window: '@0', command: 'codex', path: '/data/notes', title: '', agent: true }];
  const requests: string[] = [];
  await routePlace(page, panes, requests, { agentRunning: true, onShell: () => { panes.push(created); return '%9'; } });
  await page.goto('/');
  await seedPaneSize(page, 'agent-9', 80, 24);

  // the Agent's notes are the Place's notes
  await expect.poll(() => requests).toContain(`GET ${notesPlacePath}/notes`);

  // no pickable pane means the button creates and opens a shell directly
  await openPicker(page);
  await expect.poll(() => requests).toContain(`POST ${notesPlacePath}/shells`);
  await expect(page.getByRole('menu', { name: 'Open a terminal' })).toHaveCount(0);
  await seedPaneSize(page, '%9', 80, 24);
  await pushBytes(page, '%9', 'shell at the notes place\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toBeVisible();
  expect(requests).toContain(`POST ${notesPlacePath}/shells`);
  // the open Terminal is remembered under the Place id
  expect(await page.evaluate(key => localStorage.getItem(key), `rac.terminals:${notesPlaceId}`)).toContain('%9');

  // the Agent's More menu pins its Place
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: 'Pin folder' })).toHaveAttribute('aria-pressed', 'false');

  // the git-only routes are never asked of a Place that is no Worktree, and the Agent's own notes
  // route is not used in place of the Place's
  expect(requests.filter(entry => /\/(comparison|conversations)|GET \/api\/agents\/agent-9\/notes/u.test(entry))).toEqual([]);
});

test('a directory-Project Place with a Console shell keeps a tab after its Agent is turned off, and it can open a Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const panes: Pane[] = [
    { paneId: '%8', session: '$4', window: '@0', command: 'codex', path: '/data/notes', title: '', agent: true },
    { paneId: '%5', session: '$4', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/data/notes', title: '', agent: false, busy: false }
  ];
  const requests: string[] = [];
  await routePlace(page, panes, requests, { agentRunning: true });
  await page.goto('/');
  await seedPaneSize(page, 'agent-9', 80, 24);
  // the running Agent's tab stands for its Place; there is no second tab for it
  await expect(page.getByRole('tab', { name: /^Notes/u })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^Notes/u })).toHaveAttribute('aria-selected', 'true');

  // turning off the directory-Project Agent leaves its Place's tab, since a Console shell is open
  // there, and the selection moves to it rather than to the Scratch Agent's tab that slides into
  // the deleted tab's position
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Turn off' }).click();
  panes.shift();
  await expect(page.getByRole('tab', { name: 'Notes — Agent closed' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^Notes/u })).toHaveCount(1);

  // the agentless tab opens the Place's Console shell as a Terminal
  // an otherwise empty workspace restores its existing managed shell
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell in an agentless place\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
});
