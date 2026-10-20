import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, paneAckTotal, paneInputText, seedPaneSize, pushBytes } from './pane-stream-mock.js';
import { chooseSplit } from './split-menu.js';

// The selection toolbar over the streamed pane: selecting output (a terminal drag on
// desktop, a native long-press selection on a phone) reveals the create-note / append /
// add-to-prompt / copy actions and the yank + Ctrl+Shift+C copy shortcuts, and the
// composer keeps its own copy shortcuts. The component owns the terminal, touch scroll
// and tap-to-focus; this asserts the app wiring around a pane selection.

// serve the minimal agent panel contract for selection-only regressions
const routeSelectionApi = (page: Page) => page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  // authenticate the test console
  if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  // expose one selectable agent
  if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/workspace', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
  // disable optional push setup
  if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
  // authorize the mocked pane
  if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  // return no saved prompts
  if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
  // return no prompt history
  if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
  // serve file links opened from selected output
  if (url.pathname === '/api/agents/agent-1/file-preview') return route.fulfill({ json: { path: 'src/app.ts', size: 24, binary: false, truncated: false, content: 'export const ready = true;\n' } });
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

// create the browser range left by a native long press
const selectNativeRange = (row: Locator, start: number, end: number) => row.evaluate((element, offsets) => {
  // resolve flattened text offsets across the fixed-cell spans
  const resolveOffset = (offset: number) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = offset;
    // walk each selectable text node in row order
    while (node !== null) {
      const length = node.textContent?.length ?? 0;
      // use the first node containing the requested offset
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      node = walker.nextNode();
    }
    throw new Error(`native row offset ${offset} exceeds its text`);
  };
  const startPoint = resolveOffset(offsets.start);
  const endPoint = resolveOffset(offsets.end);
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}, { start, end });

// read browser range evidence from the owned selection surface
const nativeSelectionState = (page: Page) => page.evaluate(() => {
  const selection = window.getSelection();
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const anchorElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
  const focusElement = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
  return {
    text: selection?.toString() ?? '',
    rectCount: range === null ? 0 : range.getClientRects().length,
    owned: anchorElement != null && focusElement != null && anchorElement.closest('.terminal-selection-surface') !== null && focusElement.closest('.terminal-selection-surface') !== null
  };
});

// clear the browser range and notify selection observers
const clearNativeSelection = (page: Page) => page.evaluate(() => {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
});

// measure one rendered terminal cell for exact mouse gestures
const terminalCellWidth = (container: Locator) => container.locator('.xterm-char-measure-element').first().evaluate(element => {
  const bounds = element.getBoundingClientRect();
  return bounds.width / (element.textContent?.length ?? 1);
});

// select complete owned rows across visual wrapping boundaries
const selectNativeRows = (page: Page, firstText: string, lastText: string) => page.locator('.terminal-selection-surface').evaluate((surface, text) => {
  const rows = [...surface.querySelectorAll<HTMLElement>('.terminal-selection-row')];
  const first = rows.find(row => row.textContent === text.first);
  const last = rows.find(row => row.textContent === text.last);
  // require both logical endpoints before creating the range
  if (first === undefined || last === undefined) throw new Error('native selection rows are missing');
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}, { first: firstText, last: lastText });

test('shows selection actions for a terminal drag selection and adds to the prompt', async ({ page }) => {
  await installPaneMock(page);
  await routeSelectionApi(page);

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Several rows down so the selectable row sits well inside the output (the stream
  // writes top-down; the old snapshot bottom-aligned its text).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nSelectable output text\r\n');
  // the agent panel's header drops its connection pill once the stream is live
  await expect(page.locator('.log-output .log-status')).toHaveCount(0);
  const screen = page.locator('.log-canvas .xterm-screen');
  await expect(screen).toBeVisible();
  const selectedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Selectable output text' });
  const [screenBounds, selectedRowBounds, cell] = await Promise.all([
    screen.boundingBox(),
    selectedRow.boundingBox(),
    page.locator('.log-canvas .xterm-char-measure-element').first().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width / (element.textContent?.length ?? 1), height: bounds.height };
    })
  ]);
  const y = selectedRowBounds!.y + cell.height / 2;
  await page.mouse.move(screenBounds!.x + cell.width, y);
  await page.mouse.down();
  await page.mouse.move(screenBounds!.x + cell.width * 10, y, { steps: 4 });
  await page.mouse.up();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log-output')).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create note' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
  // the action closes the toolbar and deselects the text
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.log-canvas .xterm-selection > div')).toHaveCount(0);
  await expect(page.locator('.log-output')).not.toHaveClass(/selection-active/u);
});

// repaint xterm's selection rather than only toggling a native selection class
test('flashes a copied desktop selection green then restores its highlight', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const rawSelection = '01Copy feedback selection';
  const copiedSelection = rawSelection.slice(2);
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}${rawSelection}`);
  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: rawSelection });
  await expect(row).toBeVisible();
  const [bounds, cellWidth] = await Promise.all([
    row.boundingBox(),
    terminalCellWidth(page.locator('.log-canvas'))
  ]);
  // require rendered geometry before dragging exact terminal cells
  if (bounds === null) throw new Error('desktop copy row has no rendered bounds');
  const selectedY = bounds.y + bounds.height / 2;
  const selectRow = async () => {
    await page.mouse.move(bounds.x + cellWidth * 0.25, selectedY);
    await page.mouse.down();
    await page.mouse.move(bounds.x + cellWidth * (rawSelection.length - 0.25), selectedY, { steps: 4 });
    await page.mouse.up();
  };
  await selectRow();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  const highlight = page.locator('.log-canvas .xterm-selection > div').first();
  await expect(highlight).toHaveCSS('background-color', 'rgb(203, 166, 247)');

  // the focused terminal shortcuts flash the selection and keep it
  for (const action of ['Control+c', 'y', 'Control+Shift+c']) {
    // clear clipboard evidence before each copy path
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.locator('.log-canvas .xterm-helper-textarea').focus();
    await page.keyboard.press(action);
    await expect(highlight).toHaveCSS('background-color', 'rgb(166, 227, 161)');
    // wait for clipboard completion independently of the visible flash
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedSelection);
    await expect(highlight).toHaveCSS('background-color', 'rgb(203, 166, 247)');
    await expect(toolbar).toBeVisible();
  }

  // the toolbar's Copy repaints an inactive xterm selection too, then deselects it and closes
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect(highlight).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedSelection);
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.log-canvas .xterm-selection > div')).toHaveCount(0);

  // Add to prompt takes the uncropped selection, then deselects it and closes
  await selectRow();
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(rawSelection);
  await expect(toolbar).toBeHidden();
});

// keep native selection intact through copy feedback and follow-up actions
test('a native output selection creates and appends notes, copies, and guards the composer', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const savedNotes: string[] = [];
  let createdNotes = 0;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-identifier-00${++createdNotes}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.text = (request.postDataJSON() as { text: string }).text;
      savedNotes.push(note.text);
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const outputLine = '01Prefix text before Selectable output text';
  await pushBytes(page, 'agent-1', `${outputLine}\r\n`);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  // select one word from the phone's owned native projection,
  // exactly as a native long-press would leave the browser range
  const selectableRow = page.locator('.log-canvas .terminal-selection-row', { hasText: outputLine });
  await expect(selectableRow).toHaveText(outputLine);
  // restore the same word after note and prompt actions
  const selectWord = () => selectNativeRange(selectableRow, '01Prefix text before '.length, '01Prefix text before Selectable'.length);
  await selectWord();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');

  // The selection does not steal terminal focus, and the toolbar offers the note/prompt
  // actions (Append is absent until a note is open).
  await expect(page.locator('.log-output')).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create note' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Append to note' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Add to prompt' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Copy' })).toBeVisible();

  // full-row mobile copy removes only the terminal margin columns
  await selectNativeRange(selectableRow, 0, outputLine.length);
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(outputLine.slice(2));
  await selectWord();
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  await expect(page.locator('.log')).toHaveClass(/selection-copied/u);
  await expect(page.locator('.log')).not.toHaveClass(/selection-copied/u);
  // once the copied flash has shown, the range is dropped and the toolbar closes
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(toolbar).toBeHidden();

  await selectWord();
  await toolbar.getByRole('button', { name: 'Create note' }).click();
  await expect(toolbar).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Note' }).locator('.note-picker strong')).toHaveText('Selectable');
  const notePreview = page.getByLabel('Note preview');
  await expect(notePreview).toContainText('Selectable');
  const noteEditor = page.getByRole('textbox', { name: 'Note content' });
  await notePreview.click();
  await expect(noteEditor).toHaveValue('Selectable');
  await chooseSplit(page, 'Agent output');
  await expect(page.getByRole('dialog', { name: 'Note' })).not.toBeInViewport();
  await expect.poll(() => savedNotes).toContain('Selectable');

  // With a note open, Append is offered and appends.
  await selectWord();
  await expect(toolbar.getByRole('button', { name: 'Append to note' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Append to note' }).click();
  await expect.poll(() => savedNotes).toContain('Selectable\n\nSelectable');
  await expect(toolbar).toBeHidden();

  // Add to prompt fills the composer.
  await selectWord();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Selectable');
  await expect(toolbar).toBeHidden();

  // The yank and Ctrl+Shift+C copy shortcuts do not fire while the composer owns keys.
  await page.evaluate(() => navigator.clipboard.writeText('prompt-shortcut-guard'));
  const guardedPrompt = page.getByRole('textbox', { name: 'Prompt' });
  await guardedPrompt.focus();
  await guardedPrompt.fill('Draft');
  await guardedPrompt.press('y');
  await expect(guardedPrompt).toHaveValue('Drafty');
  await guardedPrompt.press('Control+Shift+c');
  await expect(guardedPrompt).toHaveValue('Drafty');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('prompt-shortcut-guard');
  // ordinary composer copy keeps its complete selected text
  await guardedPrompt.selectText();
  await guardedPrompt.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Drafty');
  await guardedPrompt.blur();

  // With the composer unfocused, yank and Ctrl+Shift+C copy the output selection and flash.
  await selectWord();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('y');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  const log = page.locator('.log');
  await expect(log).toHaveClass(/selection-copied/u);
  await expect(log).not.toHaveClass(/selection-copied/u);
  // a shortcut copy keeps the range: restoring highlight colors must not replace its text node
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');
  await selectWord();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  await expect(log).toHaveClass(/selection-copied/u);

  await context.close();
});

// preserve logical newlines while copying browser-native wrapped output
test('native wrapped output copies and appends exact logical text', async ({ context, page }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const softLine = `01soft-wrap-${'0123456789'.repeat(10)}`;
  const hardLine = '01hard-break-tail';
  const rawExpected = `${softLine}\n${hardLine}`;
  const copiedExpected = `${softLine.slice(2, 80)}${softLine.slice(82)}\n${hardLine.slice(2)}`;
  await pushBytes(page, 'agent-1', `\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H${softLine}\r\n${hardLine}`);

  const rows = page.locator('.log-canvas .terminal-selection-row');
  await expect(rows.filter({ hasText: softLine.slice(0, 80) })).toBeVisible();
  await expect(rows.filter({ hasText: hardLine })).toBeVisible();
  await selectNativeRows(page, softLine.slice(0, 80), hardLine);
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  const rawSelectedText = await page.evaluate(() => window.getSelection()?.toString() ?? '');

  // exercise the browser-native copy shortcut
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedExpected);
  const shortcutClipboard = await page.evaluate(() => navigator.clipboard.readText());

  // exercise toolbar copy independently
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedExpected);
  const toolbarClipboard = await page.evaluate(() => navigator.clipboard.readText());
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(rawExpected);
  await testInfo.attach('wrapped-native-copy.json', {
    body: JSON.stringify({ rawExpected, copiedExpected, rawSelectedText, shortcutClipboard, toolbarClipboard }),
    contentType: 'application/json'
  });
});

// respect terminal cell columns for native unicode and partial selections
test('native Windows copy removes only selected margin cells', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const wideLine = '界Wide margin content';
  const combiningLine = 'e\u0301xCombining margin content';
  const partialLine = '01Partial selection content';
  await pushBytes(page, 'agent-1', `\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H${wideLine}\r\n${combiningLine}\r\n${partialLine}`);

  const expectedUnicodeCopy = 'Wide margin content\nCombining margin content';
  await selectNativeRows(page, wideLine, combiningLine);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUnicodeCopy);

  // exercise the native copy event used by the browser context menu
  await page.evaluate(() => navigator.clipboard.writeText(''));
  const nativeCopyHandled = await page.evaluate(() => document.execCommand('copy'));
  expect(nativeCopyHandled).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUnicodeCopy);

  const partialRow = page.locator('.log-canvas .terminal-selection-row', { hasText: partialLine });
  await selectNativeRange(partialRow, 1, partialLine.length);
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(partialLine.slice(2));
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(partialLine.slice(1));

  // keep selections beginning after the two margin columns unchanged
  await selectNativeRange(partialRow, 2, partialLine.length);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('y');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(partialLine.slice(2));

  // empty transformed text must replace rather than fall back to raw margins
  await selectNativeRange(partialRow, 0, 2);
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  const emptyCopyHandled = await page.evaluate(() => document.execCommand('copy'));
  expect(emptyCopyHandled).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('');
});

// keep rectangular xterm selections aligned to each physical row
test('desktop column selection removes each selected margin', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  const firstLine = '01alpha-tail';
  const secondLine = '01beta-tail';
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}${firstLine}\r\n${secondLine}`);
  const firstRow = page.locator('.log-canvas .xterm-rows > div', { hasText: firstLine });
  const secondRow = page.locator('.log-canvas .xterm-rows > div', { hasText: secondLine });
  const [firstBounds, secondBounds, cellWidth] = await Promise.all([
    firstRow.boundingBox(),
    secondRow.boundingBox(),
    terminalCellWidth(page.locator('.log-canvas'))
  ]);
  // require both rendered rows before the alt-drag
  if (firstBounds === null || secondBounds === null) throw new Error('column selection rows have no rendered bounds');
  await page.keyboard.down('Alt');
  await page.mouse.move(firstBounds.x + cellWidth * 0.25, firstBounds.y + firstBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBounds.x + cellWidth * 6.75, secondBounds.y + secondBounds.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha\nbeta-');
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('01alpha\n01beta-');
});

// exercise platform-specific xterm selection notification paths
for (const platform of ['Linux x86_64', 'Win32', 'MacIntel']) {
  // preserve terminal selection while live output waits behind it
  test(`freezes desktop output while a terminal selection is active on ${platform}`, async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // choose xterm's platform behavior before loading the application
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Freeze selected output`);
    // the agent panel's header drops its connection pill once the stream is live
  await expect(page.locator('.log-output .log-status')).toHaveCount(0);

    const selectedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Freeze selected output' });
    await expect(selectedRow).toBeVisible();
    // settle focus changes before beginning the drag
    await page.locator('.log-canvas .xterm-helper-textarea').focus();
    await page.waitForTimeout(100);
    const selectedRowBounds = await selectedRow.boundingBox();
    const selectedY = selectedRowBounds!.y + selectedRowBounds!.height / 2;
    await page.mouse.move(selectedRowBounds!.x + 1, selectedY);
    await page.mouse.down();
    await page.mouse.move(selectedRowBounds!.x + selectedRowBounds!.width / 8, selectedY, { steps: 4 });
    const renderedBeforeMouseUp = await selectedRow.textContent();
    const acknowledgedBeforeMouseUp = await paneAckTotal(page, 'agent-1');
    await pushBytes(page, 'agent-1', '\r\x1b[2Karrived during drag');
    // give the real parser a chance to overwrite the row while the mouse stays down
    await page.waitForTimeout(100);
    await expect(selectedRow).toHaveText(renderedBeforeMouseUp!);
    expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforeMouseUp);
    await page.mouse.up();

    const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
    await expect(page.locator('.log-output')).toHaveClass(/selection-active/u);
    await expect(toolbar).toBeVisible();
    // a shortcut copy keeps the selection (the toolbar's Copy would deselect it)
    await page.keyboard.press('Control+Shift+c');
    // read the first copied selection
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
    const selectedText = await page.evaluate(() => navigator.clipboard.readText());
    const renderedText = await selectedRow.textContent();
    const acknowledgedBeforePause = await paneAckTotal(page, 'agent-1');

    await pushBytes(page, 'agent-1', '\r\x1b[2Kbuffered first');
    await pushBytes(page, 'agent-1', ' + second\r\n');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('Control+Shift+c');

    await expect(selectedRow).toHaveText(renderedText!);
    // read the selection copied after output arrived
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
    expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforePause);

    await page.mouse.click(selectedRowBounds!.x + selectedRowBounds!.width * .75, selectedY);
    await expect(toolbar).toBeHidden();
    await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'buffered first + second' })).toBeVisible();
    // wait for the ordered flush to be acknowledged
    await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforePause);
  });
}

// release temporary pauses even when a mouse gesture never creates selected text
for (const ending of ['pointerup', 'pointercancel', 'blur']) {
  // exercise each gesture completion path without an existing selection
  test(`resumes output after an empty selection gesture ends with ${ending}`, async ({ page }) => {
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Original output`);
    const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Original output' });
    await expect(row).toBeVisible();
    const bounds = (await row.boundingBox())!;
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await pushBytes(page, 'agent-1', '\r\x1b[2KReleased output');
    // finish normally or reproduce the browser's cancellation/focus-loss signal
    if (ending === 'pointerup') await page.mouse.up();
    else await page.evaluate(type => window.dispatchEvent(new Event(type)), ending);
    await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'Released output' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeHidden();
    await page.mouse.up();
  });
}

// select Agent output from gesture start even when codex owns terminal mouse reporting
test('ordinary Windows drag selects mouse-reporting Agent output before live repaint', async ({ context, page }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HSelectable Windows Codex output');

  const output = page.locator('.log-output');
  const outputContent = output.locator('.agent-output');
  const nativeRow = page.locator('.log-canvas .terminal-selection-row', { hasText: 'Selectable Windows Codex output' });
  const renderedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Selectable Windows Codex output' });
  await expect(nativeRow).toBeVisible();
  await expect(renderedRow).toBeVisible();
  const [nativeBounds, renderedBounds] = await Promise.all([nativeRow.boundingBox(), renderedRow.boundingBox()]);
  // require aligned native and visible rows for the real mouse gesture
  if (nativeBounds === null || renderedBounds === null) throw new Error('windows codex output has no row bounds');
  expect(Math.abs(nativeBounds.x - renderedBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(nativeBounds.y - renderedBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(nativeBounds.height - renderedBounds.height)).toBeLessThanOrEqual(1);
  const selectableText = 'Selectable Windows Codex output';
  const [nativeTextBounds, cellWidth] = await Promise.all([
    nativeRow.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }),
    terminalCellWidth(output)
  ]);
  expect(Math.abs(nativeTextBounds.x - renderedBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(nativeTextBounds.width - cellWidth * selectableText.length)).toBeLessThanOrEqual(2);
  const bounds = renderedBounds;
  const start = { x: bounds.x + 10, y: bounds.y + bounds.height / 2 };
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('.terminal-selection-row') !== null, start)).toBe(true);
  const acknowledgedBeforeDrag = await paneAckTotal(page, 'agent-1');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2, { steps: 4 });
  await page.waitForTimeout(50);
  const duringDrag = await output.evaluate(element => ({
    selectionActive: element.classList.contains('selection-active')
  }));
  const selectionColor = await outputContent.evaluate(element => {
    const probe = document.createElement('span');
    document.body.append(probe);
    probe.style.color = 'var(--subtext-0)';
    const gray = getComputedStyle(probe).color;
    probe.style.color = 'var(--sky)';
    const sky = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(element, '::after').borderTopColor, gray, sky };
  });
  const nativeDuringDrag = await nativeSelectionState(page);
  await pushBytes(page, 'agent-1', '\r\x1b[2KWindows repaint queued during ordinary drag');
  await page.waitForTimeout(100);
  const repaintedDuringDrag = await page.locator('.log-canvas .xterm-rows > div', { hasText: 'Windows repaint queued during ordinary drag' }).isVisible();
  const acknowledgedDuringDrag = await paneAckTotal(page, 'agent-1');
  await page.mouse.up();
  await page.waitForTimeout(250);
  const persisted = {
    selectionActive: await output.evaluate(element => element.classList.contains('selection-active')),
    ...await nativeSelectionState(page)
  };
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  const toolbarVisible = await toolbar.isVisible();
  await testInfo.attach('windows-ordinary-selection.json', {
    body: JSON.stringify({ geometry: { nativeBounds, renderedBounds, nativeTextBounds, cellWidth }, duringDrag, selectionColor, nativeDuringDrag, repaintedDuringDrag, acknowledgedBeforeDrag, acknowledgedDuringDrag, persisted, toolbarVisible }),
    contentType: 'application/json'
  });
  await page.screenshot({ path: testInfo.outputPath('windows-ordinary-selection.png'), fullPage: true });

  expect.soft(duringDrag.selectionActive, 'selection mode should begin during the drag').toBe(true);
  expect.soft(selectionColor.border, 'the drag ring should be gray').toBe(selectionColor.gray);
  expect.soft(selectionColor.border, 'the drag ring should not be blue').not.toBe(selectionColor.sky);
  expect.soft(nativeDuringDrag.text, 'native text should highlight during the drag').not.toBe('');
  expect.soft(nativeDuringDrag.rectCount, 'native highlight should have visible rectangles').toBeGreaterThan(0);
  expect.soft(nativeDuringDrag.owned, 'native highlight should use the owned selection surface').toBe(true);
  expect.soft(repaintedDuringDrag, 'selection should freeze streaming repaint').toBe(false);
  expect.soft(acknowledgedDuringDrag, 'selection should defer stream acknowledgement').toBe(acknowledgedBeforeDrag);
  expect.soft(persisted.selectionActive, 'selection mode should persist after mouseup').toBe(true);
  expect.soft(persisted.text, 'native text should persist after mouseup').not.toBe('');
  expect.soft(persisted.rectCount, 'native highlight should persist after mouseup').toBeGreaterThan(0);
  expect.soft(persisted.owned, 'persisted text should use the owned selection surface').toBe(true);
  expect.soft(toolbarVisible, 'selection actions should persist after mouseup').toBe(true);
  // exercise copy and prompt actions once the selection is available
  if (toolbarVisible) {
    await toolbar.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
    await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await expect(prompt).not.toHaveValue('');

    // a plain click clears selection and deliberately returns to terminal input
    await page.mouse.click(bounds.x + bounds.width * .8, bounds.y + bounds.height / 2);
    await expect(toolbar).toBeHidden();
    await expect(output.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(output).toHaveClass(/input-active/u);
    await prompt.focus();
    await expect(output).not.toHaveClass(/input-active/u);

    // reverse selection spans a wrapped row and the following logical line
    const wrapped = `Wrapped selection begins 界 e\u0301 ${'alpha '.repeat(14)}omega\r\nSecond selection line ends here`;
    await pushBytes(page, 'agent-1', `\x1b[2J\x1b[H${wrapped}`);
    const selectionRows = output.locator('.terminal-selection-row');
    const firstRow = selectionRows.filter({ hasText: 'Wrapped selection begins' });
    const lastRow = selectionRows.filter({ hasText: 'Second selection line ends here' });
    await expect(firstRow).toBeVisible();
    await expect(lastRow).toBeVisible();
    const [firstBounds, lastBounds] = await Promise.all([firstRow.boundingBox(), lastRow.boundingBox()]);
    // require both ends of the reverse multiline gesture
    if (firstBounds === null || lastBounds === null) throw new Error('wrapped Windows selection has no row bounds');
    await page.mouse.move(lastBounds.x + lastBounds.width * .75, lastBounds.y + lastBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBounds.x + firstBounds.width * .1, firstBounds.y + firstBounds.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(toolbar).toBeVisible();
    await expect(output).toHaveClass(/selection-active/u);
    await expect.poll(async () => (await nativeSelectionState(page)).owned).toBe(true);
    await expect.poll(async () => (await nativeSelectionState(page)).rectCount).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('界 e\u0301');
    await page.screenshot({ path: testInfo.outputPath('windows-reverse-wrapped-selection.png'), fullPage: true });
  }
});

// keep native selection attached while xterm updates its own delayed trees
test('ordinary Windows selection survives an immediate streamed row update', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HInitial Windows row');
  await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'Initial Windows row' })).toBeVisible();

  await pushBytes(page, 'agent-1', '\x1b[2J\x1b[HUpdated Windows row immediately');
  const updatedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Updated Windows row immediately' });
  await expect(updatedRow).toBeVisible();
  const bounds = await updatedRow.boundingBox();
  // require the newly rendered row for the immediate gesture
  if (bounds === null) throw new Error('updated Windows row has no bounds');
  const y = bounds.y + bounds.height / 2;
  await expect.poll(() => page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('.terminal-selection-row')?.textContent ?? '', { x: bounds.x + 10, y })).toContain('Updated Windows row');
  await page.mouse.move(bounds.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 175, y, { steps: 6 });
  const selectedImmediately = await nativeSelectionState(page);
  const acknowledgedBeforeQueuedLines = await paneAckTotal(page, 'agent-1');
  await pushBytes(page, 'agent-1', '\r\nQueued follow row one\r\nQueued follow row two');
  await page.waitForTimeout(100);
  const selectedAfterQueuedLines = await nativeSelectionState(page);
  const acknowledgedAfterQueuedLines = await paneAckTotal(page, 'agent-1');
  const queuedLinesVisible = await page.locator('.log-canvas .xterm-rows > div', { hasText: 'Queued follow row' }).count();
  await page.waitForTimeout(1_300);
  const selectedAfterRefresh = await nativeSelectionState(page);
  const selectionActiveAfterRefresh = await page.locator('.log-output').evaluate(element => element.classList.contains('selection-active'));
  await page.mouse.up();
  const selectedAfterMouseup = await nativeSelectionState(page);
  const toolbarVisible = await page.getByRole('toolbar', { name: 'Output selection actions' }).isVisible();
  await testInfo.attach('windows-immediate-update-selection.json', {
    body: JSON.stringify({ selectedImmediately, selectedAfterQueuedLines, acknowledgedBeforeQueuedLines, acknowledgedAfterQueuedLines, queuedLinesVisible, selectedAfterRefresh, selectionActiveAfterRefresh, selectedAfterMouseup, toolbarVisible }),
    contentType: 'application/json'
  });
  await page.screenshot({ path: testInfo.outputPath('windows-immediate-update-selection.png'), fullPage: true });

  expect.soft(selectedImmediately).toMatchObject({ owned: true });
  expect.soft(selectedImmediately.text).toContain('Windows row immed');
  expect.soft(selectedImmediately.rectCount).toBeGreaterThan(0);
  expect.soft(selectedAfterQueuedLines).toMatchObject({ owned: true });
  expect.soft(selectedAfterQueuedLines.text).toBe(selectedImmediately.text);
  expect.soft(selectedAfterQueuedLines.rectCount).toBeGreaterThan(0);
  expect.soft(acknowledgedAfterQueuedLines, 'newline output should remain unacknowledged while selection is active').toBe(acknowledgedBeforeQueuedLines);
  expect.soft(queuedLinesVisible, 'newline output should not auto-follow while selection is active').toBe(0);
  expect.soft(selectedAfterRefresh).toMatchObject({ owned: true });
  expect.soft(selectedAfterRefresh.text).toBe(selectedImmediately.text);
  expect.soft(selectedAfterRefresh.rectCount).toBeGreaterThan(0);
  expect.soft(selectionActiveAfterRefresh).toBe(true);
  expect.soft(selectedAfterMouseup).toMatchObject({ owned: true });
  expect.soft(selectedAfterMouseup.text).toBe(selectedImmediately.text);
  expect.soft(selectedAfterMouseup.rectCount).toBeGreaterThan(0);
  expect.soft(toolbarVisible).toBe(true);
});

// xterm ends a drag only when the mouseup reaches the document
test('ends a terminal drag selection released over an output link', async ({ page }) => {
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\r\n\r\nSelectable output then src/app.ts and a long tail of more text\r\n');
  const screen = page.locator('.log-canvas .xterm-screen');
  const fileLink = page.locator('.log-canvas .output-link-overlay[data-output-file-path="src/app.ts"]');
  await expect(fileLink).toBeVisible();
  const [screenBounds, linkBounds] = await Promise.all([screen.boundingBox(), fileLink.boundingBox()]);
  const y = linkBounds!.y + linkBounds!.height / 2;
  await page.mouse.move(screenBounds!.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(linkBounds!.x + linkBounds!.width / 2, y, { steps: 4 });
  await page.mouse.up();
  const selection = page.locator('.log-canvas .xterm-selection > div');
  const selectedWidth = () => selection.evaluateAll(boxes => boxes.reduce((total, box) => total + box.getBoundingClientRect().width, 0));
  await expect.poll(selectedWidth).toBeGreaterThan(0);
  const released = await selectedWidth();
  await page.mouse.move(screenBounds!.x + screenBounds!.width - 4, y + linkBounds!.height * 3, { steps: 4 });
  await page.waitForTimeout(100);
  expect(await selectedWidth()).toBe(released);
});

// let a Windows output drag cross semantic file and URL overlays without becoming a link drag
test('ordinary Windows drag selects Codex output starting on a file link', async ({ page }, testInfo) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hsrc/app.ts then https://example.com selectable tail');

  const output = page.locator('.log-output');
  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'src/app.ts then https://example.com selectable tail' });
  const fileLink = page.locator('.log-canvas .output-link-overlay[data-output-file-path="src/app.ts"]');
  const urlLink = page.locator('.log-canvas .output-link-overlay:not([data-output-file-path])');
  await expect(row).toBeVisible();
  await expect(fileLink).toBeVisible();
  await expect(urlLink).toBeVisible();
  await expect.poll(() => page.locator('.log-canvas .terminal-selection-surface').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('auto');
  const [fileBounds, urlBounds] = await Promise.all([fileLink.boundingBox(), urlLink.boundingBox()]);
  // require both semantic overlays for the cross-link gesture
  if (fileBounds === null || urlBounds === null) throw new Error('codex link overlays have no bounds');
  const start = { x: fileBounds.x + fileBounds.width / 2, y: fileBounds.y + fileBounds.height / 2 };
  const target = await page.evaluate(point => {
    const element = document.elementFromPoint(point.x, point.y);
    return { tag: element?.tagName ?? '', className: element?.className ?? '', path: (element as HTMLElement | null)?.dataset.outputFilePath ?? '' };
  }, start);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const endX = urlBounds.x + urlBounds.width + 40;
  // move at human drag cadence across both semantic overlays
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(start.x + (endX - start.x) * step / 12, start.y);
    await page.waitForTimeout(10);
  }
  await page.waitForTimeout(50);
  const duringDrag = {
    selectionActive: await output.evaluate(element => element.classList.contains('selection-active')),
    ...await nativeSelectionState(page)
  };
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterDrag = {
    selectionActive: await output.evaluate(element => element.classList.contains('selection-active')),
    ...await nativeSelectionState(page),
    toolbarVisible: await page.getByRole('toolbar', { name: 'Output selection actions' }).isVisible()
  };
  await testInfo.attach('windows-link-selection.json', { body: JSON.stringify({ target, duringDrag, afterDrag }), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('windows-link-selection.png'), fullPage: true });

  expect(target).toMatchObject({ tag: 'A', path: 'src/app.ts' });
  expect.soft(duringDrag.selectionActive, 'link drag should enter selection mode').toBe(true);
  expect.soft(duringDrag.text, 'link drag should select native text').not.toBe('');
  expect.soft(duringDrag.rectCount, 'link drag should create visible range rectangles').toBeGreaterThan(0);
  expect.soft(duringDrag.owned, 'link drag should use the owned selection surface').toBe(true);
  expect.soft(afterDrag.selectionActive, 'link selection should persist after mouseup').toBe(true);
  expect.soft(afterDrag.text, 'link text should persist after mouseup').not.toBe('');
  expect.soft(afterDrag.rectCount, 'link highlight should persist after mouseup').toBeGreaterThan(0);
  expect.soft(afterDrag.owned, 'persisted link text should use the owned selection surface').toBe(true);
  expect.soft(afterDrag.toolbarVisible, 'link selection actions should persist after mouseup').toBe(true);

  // clear the test selection before exercising ordinary semantic link behavior
  await clearNativeSelection(page);
  await expect(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeHidden();
  await page.mouse.click(start.x, start.y, { button: 'right' });
  const contextMenu = page.getByRole('menu', { name: 'Agent actions' });
  await expect(contextMenu).toBeVisible();
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(contextMenu).toHaveCount(0);
  await fileLink.click();
  await expect(page.getByRole('region', { name: 'Code changes' }).getByRole('button', { name: 'Close file' })).toBeVisible();
});

// keep xterm's custom-label hyperlinks clickable through the owned selection surface
test('plain click opens a custom-label OSC 8 link in mouse-reporting Agent output', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  const targetUrl = 'https://example.com/docs';
  // keep the real new-page navigation inside the browser fixture
  await page.context().route(targetUrl, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>OSC 8 destination</title>'
  }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', `\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H\x1b]8;;${targetUrl}\x07Open docs\x1b]8;;\x07`);

  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Open docs' });
  await expect(row).toBeVisible();
  const [bounds, cellWidth] = await Promise.all([
    row.boundingBox(),
    terminalCellWidth(page.locator('.log-canvas'))
  ]);
  // require visible link geometry for the real click
  if (bounds === null) throw new Error('OSC 8 output has no row bounds');
  const openedPagePromise = page.context().waitForEvent('page');
  await page.mouse.click(bounds.x + cellWidth * 4, bounds.y + bounds.height / 2);
  const openedPage = await openedPagePromise;
  await openedPage.waitForLoadState('domcontentloaded');
  expect(openedPage.url()).toBe(targetUrl);
  await openedPage.close();

  // retain the browser-page count to prove the drag does not navigate
  const pagesBeforeDrag = page.context().pages().length;
  await clearNativeSelection(page);
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + cellWidth, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + cellWidth * 7, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const selectedLabel = await nativeSelectionState(page);
  expect(selectedLabel.text).not.toBe('');
  expect(selectedLabel.rectCount).toBeGreaterThan(0);
  expect(selectedLabel.owned).toBe(true);
  await expect(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeVisible();
  expect(page.context().pages()).toHaveLength(pagesBeforeDrag);
  await page.screenshot({ path: testInfo.outputPath('osc8-native-selection.png'), fullPage: true });
});

// leave blue input mode when an ordinary focused Windows drag begins
test('ordinary drag selects focused mouse-reporting Agent output on Windows', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HSelectable Windows Codex output');

  const output = page.locator('.log-output');
  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Selectable Windows Codex output' });
  const selectionRow = page.locator('.log-canvas .terminal-selection-row', { hasText: 'Selectable Windows Codex output' });
  await expect(row).toBeVisible();
  await expect(selectionRow).toBeVisible();
  await output.locator('.xterm-helper-textarea').focus();
  await expect(output).toHaveClass(/input-active/u);
  const bounds = await row.boundingBox();
  // require a rendered row for the real mouse gesture
  if (bounds === null) throw new Error('windows codex output has no row bounds');
  const acknowledgedBeforeDrag = await paneAckTotal(page, 'agent-1');
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2, { steps: 4 });
  await expect(output).toHaveClass(/selection-active/u);
  await expect(output).not.toHaveClass(/input-active/u);
  const duringDrag = await nativeSelectionState(page);
  expect(duringDrag.text).not.toBe('');
  expect(duringDrag.rectCount).toBeGreaterThan(0);
  expect(duringDrag.owned).toBe(true);
  await pushBytes(page, 'agent-1', '\r\x1b[2KWindows repaint queued during focused drag');
  await page.waitForTimeout(100);
  await expect(row).toHaveText('Selectable Windows Codex output');
  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforeDrag);
  await page.mouse.up();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(output).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
});

// keep ordinary desktop selection working when Windows also exposes touch hardware
test('ordinary mouse drag selects Codex output on a touch-capable Windows device', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
    viewport: { width: 1400, height: 900 }
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  const page = await context.newPage();
  try {
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HSelectable Surface Codex output');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    const output = page.locator('.log-output');
    const row = page.locator('.log-canvas .terminal-selection-row', { hasText: 'Selectable Surface Codex output' });
    await expect(row).toBeVisible();
    await expect(output).not.toHaveClass(/input-active/u);
    const bounds = await row.boundingBox();
    // require an owned selection row for the real mouse gesture
    if (bounds === null) throw new Error('windows selection output has no row bounds');
    let selectedBeforeRepaint = { text: '', rectCount: 0, owned: false };
    let selectedAfterRepaint = { text: '', rectCount: 0, owned: false };
    let repaintedDuringDrag = false;
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2, { steps: 4 });
    selectedBeforeRepaint = await nativeSelectionState(page);
    await pushBytes(page, 'agent-1', '\r\x1b[2KSurface repaint queued during ordinary drag');
    await page.waitForTimeout(100);
    selectedAfterRepaint = await nativeSelectionState(page);
    repaintedDuringDrag = await page.locator('.log-canvas .terminal-selection-row', { hasText: 'Surface repaint queued during ordinary drag' }).isVisible();
    await page.mouse.up();

    const selectedAfterMouseup = await nativeSelectionState(page);
    await testInfo.attach('windows-touch-selection.json', { body: JSON.stringify({ selectedBeforeRepaint, selectedAfterRepaint, selectedAfterMouseup, repaintedDuringDrag }), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('windows-touch-ordinary-drag.png'), fullPage: true });
    expect.soft(selectedBeforeRepaint.text, 'the drag should create a native selection before repaint').not.toBe('');
    expect.soft(selectedBeforeRepaint.rectCount, 'the drag should create visible range rectangles').toBeGreaterThan(0);
    expect.soft(selectedBeforeRepaint.owned, 'the drag should use the owned selection surface').toBe(true);
    expect.soft(selectedAfterRepaint.text, 'streaming repaint should preserve the native selection').not.toBe('');
    expect.soft(selectedAfterRepaint.rectCount, 'streaming repaint should preserve visible range rectangles').toBeGreaterThan(0);
    expect.soft(selectedAfterRepaint.owned, 'streaming repaint should retain the owned selection').toBe(true);
    expect.soft(selectedAfterMouseup.text, 'the owned row should retain selected text').not.toBe('');
    expect.soft(selectedAfterMouseup.rectCount, 'mouseup should retain visible range rectangles').toBeGreaterThan(0);
    expect.soft(selectedAfterMouseup.owned, 'mouseup should retain the owned selection').toBe(true);
    expect.soft(repaintedDuringDrag, 'selection should freeze streaming repaint').toBe(false);
    await expect.soft(output).toHaveClass(/selection-active/u);
    await expect.soft(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeVisible();
  } finally {
    await context.close();
  }
});

// cover ordinary Agent selection on the other fine-pointer desktop platforms
for (const platform of ['Linux x86_64', 'MacIntel']) {
  test(`ordinary drag selects mouse-reporting Agent output on ${platform}`, async ({ page }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    const text = `Selectable ${platform} Codex output`;
    await pushBytes(page, 'agent-1', `\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H${text}`);

    const output = page.locator('.log-output');
    const renderedRow = output.locator('.xterm-rows > div', { hasText: text });
    const selectionRow = output.locator('.terminal-selection-row', { hasText: text });
    await expect(renderedRow).toBeVisible();
    await expect(selectionRow).toBeVisible();
    const bounds = await renderedRow.boundingBox();
    // require visible glyph geometry for the ordinary gesture
    if (bounds === null) throw new Error(`${platform} codex output has no row bounds`);
    await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2, { steps: 4 });
    await page.mouse.up();

    const selected = await nativeSelectionState(page);
    expect(selected.text).not.toBe('');
    expect(selected.rectCount).toBeGreaterThan(0);
    expect(selected.owned).toBe(true);
    const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
    await expect(output).toHaveClass(/selection-active/u);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
  });
}

// keep native selection-handle gestures out of codex mouse input
test('native phone selection owns handle gestures without breaking touch scroll', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  const page = await context.newPage();
  try {
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HPrefix Selectable phone Codex output');

    const output = page.locator('.log-output');
    const textarea = output.locator('.xterm-helper-textarea');
    const row = page.locator('.log-canvas .terminal-selection-row', { hasText: 'Prefix Selectable phone Codex output' });
    await expect(row).toHaveText('Prefix Selectable phone Codex output');
    await selectNativeRange(row, 'Prefix '.length, 'Prefix Selectable'.length);
    const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
    await expect(toolbar).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');
    await expect(output).not.toHaveClass(/input-active/u);
    await expect(textarea).not.toBeFocused();

    const bounds = await row.boundingBox();
    // require a rendered row for the real touch gesture
    if (bounds === null) throw new Error('phone codex output has no row bounds');
    const x = bounds.x + bounds.width / 3;
    const y = bounds.y + bounds.height / 2;
    // dispatch one real vertical drag with an optional mid-gesture selection
    const dragTouch = async (duringTouch?: () => Promise<void>) => {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await duringTouch?.();
        // move like a vertical native selection handle
        for (let step = 1; step <= 6; step += 1) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 8 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await session.detach();
      }
    };

    const inputBeforeMove = await paneInputText(page, 'agent-1');
    await dragTouch();
    const inputAfterMove = await paneInputText(page, 'agent-1');
    await testInfo.attach('selection-handle-input.txt', { body: JSON.stringify(inputAfterMove.slice(inputBeforeMove.length)), contentType: 'text/plain' });
    expect(inputAfterMove).toBe(inputBeforeMove);
    await expect(toolbar).toBeVisible();
    await expect(output).toHaveClass(/selection-active/u);
    await page.screenshot({ path: testInfo.outputPath('native-phone-codex-selection.png'), fullPage: true });

    // hand off even when selection begins after touchstart
    await clearNativeSelection(page);
    await expect(toolbar).toBeHidden();
    const inputBeforeMidGestureSelection = await paneInputText(page, 'agent-1');
    await dragTouch(() => selectNativeRange(row, 'Prefix '.length, 'Prefix Selectable'.length));
    expect(await paneInputText(page, 'agent-1')).toBe(inputBeforeMidGestureSelection);
    await expect(toolbar).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');

    // clearing selection restores application-owned alternate-screen scrolling
    await clearNativeSelection(page);
    await expect(toolbar).toBeHidden();
    const inputBeforeAlternateScroll = await paneInputText(page, 'agent-1');
    await dragTouch();
    const alternateScrollInput = (await paneInputText(page, 'agent-1')).slice(inputBeforeAlternateScroll.length);
    expect(alternateScrollInput).toMatch(/\x1b\[<64;\d+;\d+M/u);

    // normal-buffer history remains local after selection clears
    await pushBytes(page, 'agent-1', '\x1b[?1006l\x1b[?1003l\x1b[?1049l');
    await pushBytes(page, 'agent-1', Array.from({ length: 80 }, (_, index) => `history-${index}\r\n`).join(''));
    await expect(page.locator('.log-canvas .terminal-selection-row', { hasText: 'history-79' })).toBeVisible();
    const inputBeforeHistoryScroll = await paneInputText(page, 'agent-1');
    await dragTouch();
    expect(await paneInputText(page, 'agent-1')).toBe(inputBeforeHistoryScroll);
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
    await expect(textarea).not.toBeFocused();
  } finally {
    await context.close();
  }
});

// preserve native phone selection while live output waits behind it
test('freezes coarse-pointer output while a native selection is active', async ({ browser, baseURL }) => {
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
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Freeze native selected output');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const selectedRow = page.locator('.log-canvas .xterm-accessibility-tree [role="listitem"]', { hasText: 'Freeze native selected output' });
  await expect(selectedRow).toHaveText('Freeze native selected output');
  await selectNativeRange(selectedRow, 0, 'Freeze'.length);

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log-output')).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  // a shortcut copy keeps the selection (the toolbar's Copy would deselect it)
  await page.keyboard.press('y');
  // read the cropped native selection before output arrives
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('eeze');
  // exercise native copy from xterm's accessibility row
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  const nativeCopyHandled = await page.evaluate(() => document.execCommand('copy'));
  expect(nativeCopyHandled).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('eeze');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Freeze');
  const acknowledgedBeforePause = await paneAckTotal(page, 'agent-1');

  await pushBytes(page, 'agent-1', '\r\x1b[2Kbuffered first');
  await pushBytes(page, 'agent-1', ' + second\r\n');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('y');

  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforePause);
  await expect(selectedRow).toHaveText('Freeze native selected output');
  // read the live browser selection after output arrives
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Freeze');
  // read the cropped copy action after output arrives
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('eeze');

  // clear the browser range without relying on xterm's inside-row collapse
  await clearNativeSelection(page);
  await expect(toolbar).toBeHidden();
  const flushedRow = page.locator('.log-canvas .terminal-selection-row', { hasText: 'buffered first + second' });
  await expect(flushedRow).toBeVisible();
  // wait for the ordered flush to be acknowledged
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforePause);

  // restore native selection after the first flush
  await selectNativeRange(flushedRow, 0, 'buffered'.length);
  await expect(toolbar).toBeVisible();
  // read the restored native selection
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('buffered');
  const acknowledgedBeforeOutsideClear = await paneAckTotal(page, 'agent-1');
  await pushBytes(page, 'agent-1', '\x1b[1A\r\x1b[2Koutside clear released\r\n');
  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforeOutsideClear);
  await expect(flushedRow).toHaveText('buffered first + second');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  // move the collapsed browser selection outside the output
  await prompt.evaluate(element => {
    window.getSelection()?.collapse(element, 0);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.log-canvas .terminal-selection-row', { hasText: 'outside clear released' })).toBeVisible();
  // wait for the outside clear to release output
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforeOutsideClear);

  await context.close();
});

// clear frozen native ranges before viewport or font geometry moves underneath them
test('coarse Windows clears native selection when history or font geometry changes', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
    viewport: { width: 1400, height: 900 }
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  const page = await context.newPage();
  try {
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', Array.from({ length: 100 }, (_, index) => `geometry-history-${String(index).padStart(3, '0')}\r\n`).join(''));
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    const output = page.locator('.log-output');
    const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
    const rows = page.locator('.log-canvas .terminal-selection-row');
    const selectedHistoryRow = rows.filter({ hasText: 'geometry-history-099' });
    await expect(selectedHistoryRow).toBeVisible();
    await selectNativeRange(selectedHistoryRow, 0, 'geometry-history-099'.length);
    await expect(toolbar).toBeVisible();
    const viewport = page.locator('.log-canvas .xterm-viewport');
    const host = page.locator('.log-canvas .streamed-terminal-host');
    const renderedRows = page.locator('.log-canvas .xterm-rows > div');
    const [scrollTopBefore, hostBounds, renderedBeforeWheel] = await Promise.all([
      viewport.evaluate(element => element.scrollTop),
      host.boundingBox(),
      renderedRows.allTextContents()
    ]);
    // require terminal geometry for the real wheel gesture
    if (hostBounds === null) throw new Error('coarse Windows terminal has no host bounds');
    await page.mouse.move(hostBounds.x + hostBounds.width / 2, hostBounds.y + hostBounds.height / 2);
    await page.mouse.wheel(0, -800);
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
    await expect.poll(() => renderedRows.allTextContents()).not.toEqual(renderedBeforeWheel);
    await page.waitForTimeout(100);
    const afterWheel = await nativeSelectionState(page);
    const [projectedAfterWheel, renderedAfterWheel] = await Promise.all([
      rows.allTextContents(),
      renderedRows.allTextContents()
    ]);
    await page.screenshot({ path: testInfo.outputPath('coarse-history-selection-after-wheel.png'), fullPage: true });
    expect.soft(afterWheel.text, 'history scrolling should clear the old selected text').toBe('');
    expect.soft(afterWheel.rectCount, 'history scrolling should clear range rectangles').toBe(0);
    expect.soft(afterWheel.owned, 'history scrolling should release the owned range').toBe(false);
    await expect.soft(toolbar).toBeHidden();

    // recover after a red wheel assertion so the font branch still gathers evidence
    if ((await nativeSelectionState(page)).text !== '') await clearNativeSelection(page);
    await expect(toolbar).toBeHidden();
    const fontRow = rows.filter({ hasText: /geometry-history-/u }).last();
    await expect(fontRow).toBeVisible();
    const fontRowText = await fontRow.textContent();
    // require text before selecting a font-sensitive row
    if (fontRowText === null || fontRowText.length === 0) throw new Error('font selection row has no text');
    await selectNativeRange(fontRow, 0, fontRowText.length);
    await expect(toolbar).toBeVisible();
    const fontSizeBefore = await output.locator('.xterm').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
    await page.keyboard.press('Control+=');
    await expect.poll(() => output.locator('.xterm').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(fontSizeBefore);
    await page.waitForTimeout(100);
    const afterFontChange = await nativeSelectionState(page);
    await page.screenshot({ path: testInfo.outputPath('coarse-selection-after-font-change.png'), fullPage: true });
    await testInfo.attach('coarse-selection-geometry.json', {
      body: JSON.stringify({ afterWheel, afterFontChange, projectedAfterWheel, renderedAfterWheel, scrollTopBefore }),
      contentType: 'application/json'
    });
    expect.soft(afterFontChange.text, 'font changes should clear the old selected text').toBe('');
    expect.soft(afterFontChange.rectCount, 'font changes should clear range rectangles').toBe(0);
    expect.soft(afterFontChange.owned, 'font changes should release the owned range').toBe(false);
    await expect.soft(toolbar).toBeHidden();
  } finally {
    // close the isolated coarse context
    await context.close();
  }
});
