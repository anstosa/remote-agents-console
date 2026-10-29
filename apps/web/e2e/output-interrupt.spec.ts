import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, paneInputText } from './pane-stream-mock.js';

// The streamed pane is a real terminal: focusing it marks the panel input-active and
// forwards typed control keys as pane input; when it is not focused the keys stay with
// whatever owns them (the composer, an editor, a dialog). The component spec covers the
// raw input/device-query wire; this asserts the app wiring around the pane — the
// input-active treatment, focus scoping, the file-preview link, and the mobile keys.

const routeApi = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [{ path: 'apps/web/src/main.tsx', size: 1_234 }] } });
    if (url.pathname === '/api/agents/agent-1/file-preview') return route.fulfill({ json: { path: 'apps/web/src/main.tsx', size: 1_234, binary: false, truncated: false, content: 'export const ready = true;\n' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// dispatch a real one-finger vertical drag through Chromium
const dragTouch = async (page: import('@playwright/test').Page, target: import('@playwright/test').Locator, deltaY: number) => {
  const bounds = await target.boundingBox();
  // require a rendered touch target
  if (bounds === null) throw new Error('agent output has no touch bounds');
  const session = await page.context().newCDPSession(page);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    // move gradually so Chromium recognizes a drag
    for (let step = 1; step <= 12; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + deltaY * step / 12 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
};

test('focusing the pane marks it input-active and forwards typed control keys', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Push the file mention several rows down so its Preview link clears the top-left
  // server switcher (the stream writes top-down; the old snapshot bottom-aligned).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nUpdated apps/web/src/main.tsx.\r\n');

  // Clicking the pane focuses it and marks the panel input-active (which collapses the
  // composer to the terminal helper keys on a phone).
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  // Control keys typed into the focused pane go out as input, byte for byte.
  await page.keyboard.press('Control+c');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03');
  await page.keyboard.press('Escape');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b\t');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
});

test('keys stay local when the composer or Code panel owns focus', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Push the file mention several rows down so its Preview link clears the top-left
  // server switcher (the stream writes top-down; the old snapshot bottom-aligned).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nUpdated apps/web/src/main.tsx.\r\n');

  // Focusing the composer blurs the pane; Escape there never reaches it.
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await expect(page.locator('.log-output')).not.toHaveClass(/input-active/u);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await paneInputText(page, 'agent-1')).toBe('');

  // the output file opens in the Code panel, not the retired preview dialog
  const previewLink = page.getByRole('link', { name: 'Preview apps/web/src/main.tsx' });
  await previewLink.click();
  const codePanel = page.getByRole('region', { name: 'Code changes' });
  await expect(codePanel.getByRole('button', { name: 'Close file' })).toBeVisible();
  await codePanel.getByRole('button', { name: 'Close file' }).focus();
  await page.keyboard.press('Escape');
  await expect(codePanel).toBeVisible();
  expect(await paneInputText(page, 'agent-1')).toBe('');
});

test('the mobile terminal keys drive the pane, including the Ctrl latch', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.setViewportSize({ width: 428, height: 900 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'ready\r\n');

  // Focus the pane so the panel is input-active and the mobile keys show.
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await expect(page.getByLabel('Terminal keys')).toBeVisible();
  // the keys take the prompt's row inside the output; the static toolbar stays intact
  const output = page.locator('.log-output');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(output.getByLabel('Terminal keys')).toBeVisible();
  await expect(toolbar.getByLabel('Terminal keys')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'More options' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prompt composer' })).toBeHidden();
  // the pane footer joins the toolbar without a divider
  await expect.poll(() => page.locator('.log').evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px');
  // Direct controls, then modifiers, then arrows, left to right; Esc above Ctrl+C.
  const [controlBounds, modifierBounds, arrowBounds, escBounds, ctrlCBounds] = await Promise.all([
    page.locator('.mobile-control-keys').boundingBox(),
    page.locator('.mobile-key-modifiers').boundingBox(),
    page.locator('.mobile-arrow-keys').boundingBox(),
    page.getByRole('button', { name: 'Esc', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'Ctrl+C', exact: true }).boundingBox()
  ]);
  expect(controlBounds!.x).toBeLessThan(modifierBounds!.x);
  expect(modifierBounds!.x).toBeLessThan(arrowBounds!.x);
  expect(escBounds!.x).toBeCloseTo(ctrlCBounds!.x, 0);
  expect(escBounds!.y).toBeLessThan(ctrlCBounds!.y);

  // Latching Ctrl then typing c on the soft keyboard produces ETX through the modifier
  // transform; the buttons keep focus on the pane (pointerdown is prevented).
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.keyboard.press('c');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03');

  // The Esc and Ctrl+C buttons forward their bytes directly.
  await page.getByRole('button', { name: 'Esc', exact: true }).click();
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b\x03');
});

// compare working desktop wheel input with the phone touch path
test('desktop wheel reaches a mouse-reporting Agent output', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hmouse reporting');
  await expect(page.getByLabel('Live log').locator('.xterm-rows')).toContainText('mouse reporting');

  const host = page.locator('.log-output .streamed-terminal-host');
  const bounds = await host.boundingBox();
  // require a rendered wheel target
  if (bounds === null) throw new Error('agent output has no wheel bounds');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => paneInputText(page, 'agent-1')).toMatch(/\x1b\[<64;\d+;\d+M/u);
});

// a link overlay sits over the terminal; the wheel under it must still scroll
test.describe('desktop wheel over an output link', () => {
  const history = Array.from({ length: 60 }, (_, index) => `line ${String(index).padStart(3, '0')}`).join('\r\n');
  const link = (page: import('@playwright/test').Page) => page.locator('.log-output .output-link-overlay');
  const wheelOverLink = async (page: import('@playwright/test').Page) => {
    await expect(link(page)).toHaveCount(1);
    const bounds = await link(page).boundingBox();
    // require a rendered overlay to point at
    if (bounds === null) throw new Error('output link has no bounds');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -120);
  };

  test('scrolls the browser scrollback', async ({ page }) => {
    await installPaneMock(page);
    await routeApi(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', `${history}\r\nsee https://example.com/docs`);
    const rows = page.getByLabel('Live log').locator('.xterm-rows');
    await expect(rows).toContainText('example.com/docs');
    const top = () => rows.locator('div').first().textContent();
    const before = await top();
    await wheelOverLink(page);
    await expect.poll(top).not.toBe(before);
  });

  test('reaches a mouse-reporting program', async ({ page }) => {
    await installPaneMock(page);
    await routeApi(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hsee https://example.com/docs');
    await expect(page.getByLabel('Live log').locator('.xterm-rows')).toContainText('example.com/docs');
    await wheelOverLink(page);
    await expect.poll(() => paneInputText(page, 'agent-1')).toMatch(/\x1b\[<64;\d+;\d+M/u);
  });
});

// use a touch-capable phone context
test.describe('phone Agent output scrolling', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });

  // forward both touch directions without stealing focus
  test('touch drag reaches a mouse-reporting Agent output', async ({ page }, testInfo) => {
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hmouse reporting');
    await expect(page.getByLabel('Live log').locator('.xterm-rows')).toContainText('mouse reporting');

    const output = page.locator('.log-output');
    const host = output.locator('.streamed-terminal-host');
    const textarea = output.locator('.xterm-helper-textarea');
    await expect(textarea).not.toBeFocused();
    await dragTouch(page, host, 120);
    const afterUp = await paneInputText(page, 'agent-1');
    await testInfo.attach('touch-up-input.txt', { body: JSON.stringify(afterUp), contentType: 'text/plain' });
    await page.screenshot({ path: testInfo.outputPath('agent-output-touch-scroll.png'), fullPage: true });
    expect(afterUp).toMatch(/\x1b\[<64;\d+;\d+M/u);
    await expect(textarea).not.toBeFocused();

    await textarea.focus();
    const beforeDown = await paneInputText(page, 'agent-1');
    await dragTouch(page, host, -120);
    const afterDown = (await paneInputText(page, 'agent-1')).slice(beforeDown.length);
    await testInfo.attach('touch-down-input.txt', { body: JSON.stringify(afterDown), contentType: 'text/plain' });
    expect(afterDown).toMatch(/\x1b\[<65;\d+;\d+M/u);
    await expect(textarea).toBeFocused();
  });
});

// exercise the native phone controls and xterm input path
test.describe('mobile Fn input', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });

  // map only a single soft-keyboard digit
  test('the mobile Fn latch maps only single digits in Agent output', async ({ page }, testInfo) => {
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', 'ready\r\n');

    const output = page.locator('.log-output');
    // tap visible output rather than an accessibility node beneath the selection surface
    await output.locator('.xterm-screen').tap();
    const textarea = output.locator('.xterm-helper-textarea');
    const keys = output.getByLabel('Terminal keys');
    const modifiers = keys.locator('.mobile-key-modifiers');
    const fn = keys.getByRole('button', { name: 'Fn', exact: true });
    const shift = keys.getByRole('button', { name: 'Shift', exact: true });
    const ctrl = keys.getByRole('button', { name: 'Ctrl', exact: true });
    const alt = keys.getByRole('button', { name: 'Alt', exact: true });
    // model Android's keycode-229 textarea mutation
    const insertImeText = (value: string) => textarea.evaluate((element, text) => {
      // require xterm's textarea
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('xterm input is not a textarea');
      const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Unidentified' });
      Object.defineProperty(keydown, 'keyCode', { value: 229 });
      element.dispatchEvent(keydown);
      // mutate before xterm's deferred diff
      element.value += text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      const keyup = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' });
      Object.defineProperty(keyup, 'keyCode', { value: 229 });
      element.dispatchEvent(keyup);
    }, value);
    await expect(fn).toBeVisible();
    await expect(fn).toHaveAttribute('aria-pressed', 'false');
    await expect(textarea).toBeFocused();

    await fn.tap();
    await expect(fn).toHaveAttribute('aria-pressed', 'true');
    await expect(textarea).toBeFocused();
    await insertImeText('5');
    await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x1b[15~');
    await fn.tap();
    await page.keyboard.type('1');
    await fn.tap();
    await page.keyboard.type('1234567890');
    await fn.tap();
    await expect(fn).toHaveAttribute('aria-pressed', 'false');
    await expect(textarea).toBeFocused();
    await page.keyboard.type('0');

    await fn.tap();
    await ctrl.tap();
    await page.keyboard.type('1');
    await ctrl.tap();
    await shift.tap();
    await page.keyboard.type('5');
    await ctrl.tap();
    await alt.tap();
    await page.keyboard.type('0');
    await ctrl.tap();
    await shift.tap();
    await alt.tap();

    // preserve non-digits, multi-character input and xterm escape sequences
    await page.keyboard.type('a');
    await insertImeText('12');
    await page.keyboard.press('ArrowUp');
    const escape = '\x1b';
    const functionKeys = `${escape}OP${escape}OQ${escape}OR${escape}OS${escape}[15~${escape}[17~${escape}[18~${escape}[19~${escape}[20~${escape}[21~`;
    await expect.poll(() => paneInputText(page, 'agent-1')).toBe(`${escape}[15~1${functionKeys}0${escape}[1;5P${escape}[15;2~${escape}[21;8~a12${escape}[A`);

    const [keyBounds, modifierBounds, fnBounds, shiftBounds, altBounds] = await Promise.all([
      keys.boundingBox(),
      modifiers.boundingBox(),
      fn.boundingBox(),
      shift.boundingBox(),
      alt.boundingBox()
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
    expect(keyBounds.x + keyBounds.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('mobile-fn-output-390.png'), fullPage: true });
  });
});

// preserve the current mode for desktop clicks and mobile taps
for (const touch of [false, true]) {
  // give touch activation a real touch-capable browser context
  test.describe(`jump to latest with ${touch ? 'touch' : 'mouse'}`, () => {
    test.use({ hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1400, height: 900 } });
    // cover both reading/composer and terminal-input modes
    for (const inputActive of [false, true]) {
      // jump changes scroll position without moving keyboard focus or changing modes
      test(`preserves ${inputActive ? 'terminal input' : 'reading'} mode`, async ({ page }) => {
        await installPaneMock(page);
        await routeApi(page);
        await page.goto('/');
        await seedPaneSize(page, 'agent-1', 80, 24);
        // create enough history to expose the jump control
        await pushBytes(page, 'agent-1', Array.from({ length: 160 }, (_, index) => `output row ${index}\r\n`).join(''));
        const log = page.locator('.log');
        const outputPanel = log.locator('.log-output');
        const focusTarget = inputActive ? log.locator('.xterm-helper-textarea') : page.getByRole('textbox', { name: 'Prompt', exact: true });
        await focusTarget.focus();
        // use the device's actual scroll gesture
        if (touch) {
          await dragTouch(page, log.locator('.streamed-terminal-host'), 120);
        } else {
          const hostBounds = await log.locator('.streamed-terminal-host').boundingBox();
          // require a rendered wheel target
          if (hostBounds === null) throw new Error('agent output has no wheel bounds');
          await page.mouse.move(hostBounds.x + hostBounds.width / 2, hostBounds.y + hostBounds.height / 2);
          await page.mouse.wheel(0, -800);
        }
        const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
        await expect(jump).toBeVisible();
        await expect(focusTarget).toBeFocused();
        // exercise the native pointer activation for this device
        if (touch) await jump.tap();
        else await jump.click();
        await expect(jump).toBeHidden();
        await expect(focusTarget).toBeFocused();
        // preserve the mode that controls the output border and mobile composer
        if (inputActive) await expect(outputPanel).toHaveClass(/input-active/u);
        else await expect(outputPanel).not.toHaveClass(/input-active/u);
        // keep subsequent output pinned to the latest line
        await pushBytes(page, 'agent-1', 'new output after jump\r\n');
        await expect(jump).toBeHidden();
      });
    }
  });
}
