import { expect, test, type Page } from '@playwright/test';

// The streamed terminal component, mounted alone against real xterm 6.0 and driven by
// a scripted socket (see streamed-terminal-fixture.ts). These assert what crosses the
// contract boundary — rendered DOM, the frames the component sends — never its
// internals.

const MOBILE = {
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
  viewport: { width: 390, height: 780 }
} as const;

// Call an exported fixture function in the page and return its (serializable) result.
const drive = <T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(async ({ name, args }) => {
    const module = await import('/e2e/streamed-terminal-fixture.ts');
    return (module as Record<string, (...a: unknown[]) => unknown>)[name]!(...args) as T;
  }, { name, args });

const setup = async (page: Page, options: Record<string, unknown> = {}) => {
  await page.goto('/');
  // Clear the app's DOM but keep the <head> the app injected: the Catppuccin palette
  // <style> lives there, and the component reads its theme from those `:root` tokens
  // exactly as it does in the app. page.setContent() would replace the whole document
  // and drop that <style> — Vite dedupes the already-loaded CSS module, so re-importing
  // styles.css in the fixture would not re-inject it — leaving `--base` unresolved and
  // the terminal theme stuck on xterm's black default.
  await page.evaluate(async options => {
    document.body.replaceChildren();
    const mount = document.createElement('div');
    mount.id = 'term';
    document.body.append(mount);
    const module = await import('/e2e/streamed-terminal-fixture.ts');
    await module.renderStreamedTerminal(mount, options);
  }, options);
  await expect(page.locator('#term')).toHaveAttribute('data-ready', 'true');
};

test('applies the seed then live bytes in order after the first size', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'SEED-LINE\r\n');
  await drive(page, 'pushBytes', 'LIVE-LINE\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('SEED-LINE');
  const text = await drive<string>(page, 'screenText');
  expect(text.indexOf('SEED-LINE')).toBeLessThan(text.indexOf('LIVE-LINE'));
});

// keep first-command output beside a restored shell prompt
test('restores the prompt cursor after blank seed rows and on reseed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const seed = `\x1b[H\x1b[2J$ ${'\r\n'.repeat(9)}\x1b[1;3H`;

  // exercise the initial snapshot and a fresh snapshot on reseed
  for (const reseed of [false, true]) {
    // discard the previous shell display on reseed
    if (reseed) await drive(page, 'pushReseed');
    await drive(page, 'pushBytes', seed);
    await drive(page, 'pushBytes', 'echo first\r\nfirst\r\n$ ');
    // read the rendered lines after all stream bytes are consumed
    await expect.poll(() => drive(page, 'screenText')).toBe(`$ echo first\nfirst\n$ ${'\n'.repeat(7)}`);
  }
});

test('masks the terminal with the themed background until the first seed renders', async ({ page }) => {
  await setup(page);
  // Pre-seed: a cover sits over the terminal so the operator never sees an empty grid or
  // xterm's pre-paint flash before content arrives.
  await expect(page.locator('#term .streamed-terminal-cover')).toBeVisible();
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'SEEDED\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('SEEDED');
  // Once the seed has painted, the cover is removed and never masks the live pane.
  await expect(page.locator('#term .streamed-terminal-cover')).toHaveCount(0);
});

test('conforms to the reported size and letterboxes a smaller pane', async ({ page }) => {
  await setup(page, { width: '640px', height: '320px' });
  await drive(page, 'pushSize', 20, 6);
  await expect.poll(() => drive(page, 'cols')).toBe(20);
  expect(await drive(page, 'rows')).toBe(6);
  const screenWidth = await drive<number>(page, 'screenWidth');
  const hostWidth = await drive<number>(page, 'hostWidth');
  expect(screenWidth).toBeGreaterThan(0);
  // Rendered at its natural grid, not stretched to fill the container.
  expect(screenWidth).toBeLessThan(hostWidth);
});

test('letterboxes the smaller pane in the terminal background, not xterm black', async ({ page }) => {
  // A pane shorter than the panel leaves a strip below the last row. xterm's own
  // `.xterm-viewport` is a full-height, hardcoded-black overlay, so without an override
  // that strip shows solid black instead of the themed background — the "black bar at
  // the bottom" operators saw. The strip must paint `--base` like the rest of the pane.
  await setup(page, { width: '640px', height: '320px' });
  await drive(page, 'pushSize', 20, 6);
  await drive(page, 'pushBytes', 'TOP-ROW\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('TOP-ROW');
  const strip = await drive<string>(page, 'letterboxStripColor');
  expect(strip).not.toBe('rgb(0, 0, 0)');
  expect(strip).toBe(await drive<string>(page, 'themeBaseColor'));
});

test('a reseed clears the scrollback and re-renders from the fresh seed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'OLD-CONTENT\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('OLD-CONTENT');
  await drive(page, 'pushReseed');
  await drive(page, 'pushBytes', 'FRESH-SEED\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('FRESH-SEED');
  expect(await drive<string>(page, 'screenText')).not.toContain('OLD-CONTENT');
});

test('acks the bytes it consumes', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'hello'); // five bytes
  await expect.poll(() => drive(page, 'ackedBytes')).toContain(5);
});

// freeze visual events while keeping nonvisual pane notifications live
test('selection pause defers bytes, sizes, and acknowledgements until replay', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushBytes', '\r\x1b[2KBUFFERED');
  await drive(page, 'pushBytes', '-AFTER');
  await drive(page, 'pushFrame', { type: 'question', question: { prompt: 'Still live' } });
  await expect.poll(() => drive(page, 'questionsSeen')).toContainEqual({ prompt: 'Still live' });
  await page.waitForTimeout(100);
  expect(await drive(page, 'cols')).toBe(40);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('BUFFERED');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('BUFFERED-AFTER');
  expect(await drive(page, 'cols')).toBe(30);
  expect(await drive(page, 'rows')).toBe(8);
  await expect.poll(() => drive(page, 'ackedBytes')).toEqual([...acknowledgements, '\r\x1b[2KBUFFERED-AFTER'.length]);
});

// pause before xterm's asynchronous parser consumes an already received chunk
test('selection pause gates a write already scheduled for parsing', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  // deliver output and start selection within the same browser task
  await page.evaluate(async () => {
    const fixture = await import('/e2e/streamed-terminal-fixture.ts');
    fixture.pushBytes('\r\x1b[2KBUFFERED');
    fixture.setOutputPaused(true);
  });
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('BUFFERED');
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('BUFFERED');
});

// parse bytes at their original grid before applying the following resize
test('selection replay preserves bytes-before-size ordering', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', '\r\x1b[2K\x1b[1;80HX');
  await drive(page, 'pushSize', 80, 10);
  await drive(page, 'pushBytes', '\x1b[2;1HY');
  await drive(page, 'setOutputPaused', false);
  // inspect the complete row so a wider-grid cursor cannot match as a suffix
  await expect.poll(async () => (await drive<string>(page, 'screenText')).split('\n').slice(0, 2)).toEqual([`${' '.repeat(39)}X`, 'Y']);
  expect(await drive(page, 'cols')).toBe(80);
});

// discard obsolete bytes when the server replaces its snapshot during selection
test('a paused reseed supersedes queued output without losing the latest grid', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'DISCARDED-PRE-SEED');
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushReseed');
  await drive(page, 'pushBytes', 'FRESH-SEED');
  await drive(page, 'pushBytes', '-LIVE');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('FRESH-SEED-LIVE');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('DISCARDED');
  expect(await drive(page, 'cols')).toBe(30);
  await expect.poll(() => drive(page, 'ackedBytes')).toEqual([...acknowledgements, 'FRESH-SEED-LIVE'.length]);
});

// an oversized burst must not force selection to end or replay a truncated stream
test('paused output overflow refreshes from a new seed after selection ends', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'x'.repeat(300 * 1024));
  await drive(page, 'pushBytes', 'INCOMPLETE-TAIL');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  expect(await drive(page, 'connectCalls')).toBe(1);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'connectCalls')).toBe(2);
  await drive(page, 'pushSize', 40, 10);
  // a fresh live snapshot can itself exceed the selection backlog cap
  await drive(page, 'pushBytes', `${' \r'.repeat(150 * 1024)}RECOVERED`);
  await expect.poll(() => drive(page, 'screenText')).toContain('RECOVERED');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('INCOMPLETE-TAIL');
  expect(await drive(page, 'connectCalls')).toBe(2);
});

// reconnects can refresh the pending snapshot without disturbing the frozen display
test('selection remains frozen across a reconnect until the replacement seed is released', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 10 });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'STALE-QUEUED');
  await drive(page, 'pushClose', 1006, 'lost');
  await expect.poll(() => drive(page, 'connectCalls')).toBe(2);
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushBytes', 'RECONNECTED');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('RECONNECTED');
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('RECONNECTED');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('STALE-QUEUED');
  expect(await drive(page, 'cols')).toBe(30);
});

test('typed keys are sent as input frames through the panel modifier transform', async ({ page }) => {
  await setup(page, { upperCaseInput: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'focusTerminal');
  await page.keyboard.type('hi');
  await expect.poll(() => drive(page, 'inputData')).toBe('HI');
});

test('an exit keeps the terminal mounted and shows a status', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 60_000 });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'before-exit\r\n');
  await drive(page, 'pushExit', 'pane closed');
  await expect(page.locator('#term')).toHaveAttribute('data-status', 'pane closed');
  expect(await drive(page, 'terminalMounted')).toBe(true);
});

test('never types a reply back into the pane for device queries', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  const beforeAcks = (await drive<number[]>(page, 'ackedBytes')).length;
  const queries = [
    '\x1b[c', '\x1b[>c', '\x1b[5n', '\x1b[6n', '\x1b[?6n',
    '\x1b[4$p', '\x1b[?2026$p', '\x1bP$qm\x1b\\',
    '\x1b]4;1;?\x07', '\x1b]10;?\x07', '\x1b]11;?\x07', '\x1b]12;?\x07'
  ];
  for (const query of queries) await drive(page, 'pushBytes', query);
  await page.waitForTimeout(150);
  // The bytes were consumed (acked) — so "no input frame" is a real result, not vacuous.
  expect((await drive<number[]>(page, 'ackedBytes')).length).toBeGreaterThan(beforeAcks);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
});

test('device-query suppression survives the reset on a reseed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'seed\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('seed');
  await drive(page, 'pushReseed');
  const before = await drive<number>(page, 'inputFrameCount');
  // The fresh seed clears the screen (reset) then begins with device queries; the
  // registered safety handlers must survive the reset and still suppress them.
  await drive(page, 'pushBytes', '\x1b[6n\x1b[c\x1b[5n');
  await page.waitForTimeout(150);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
});

test('OSC 52 cannot type into the pane and does not read the clipboard', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __clipReads: number }).__clipReads = 0;
    try {
      const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
      if (read) navigator.clipboard.readText = () => { (window as unknown as { __clipReads: number }).__clipReads += 1; return read(); };
    } catch { /* no clipboard API in this context */ }
  });
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  const beforeAcks = (await drive<number[]>(page, 'ackedBytes')).length;
  await drive(page, 'pushBytes', '\x1b]52;c;?\x07');
  await drive(page, 'pushBytes', '\x1b]52;c;aGVsbG8=\x07');
  await page.waitForTimeout(150);
  expect((await drive<number[]>(page, 'ackedBytes')).length).toBeGreaterThan(beforeAcks);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __clipReads: number }).__clipReads)).toBe(0);
});

// native OSC fallback preserves navigation buttons without treating context click as activation
test('native OSC fallback ignores right click when cell metadata is unavailable', async ({ page }) => {
  const target = 'https://example.com/native-osc-fallback';
  await page.context().route(target, route => route.fulfill({ contentType: 'text/html', body: '<main>controlled native OSC target</main>' }));
  await setup(page, { missingCellMetadata: true, captureOpenUrls: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', `\x1b]8;;${target}\x07Open docs\x1b]8;;\x07`);
  await expect.poll(() => drive<string>(page, 'screenText')).toContain('Open docs');
  await expect(page.locator('#term .output-link-overlay')).toHaveCount(0);

  const row = page.locator('#term .xterm-rows > div', { hasText: 'Open docs' });
  const [rowBounds, screenBounds] = await Promise.all([
    row.boundingBox(),
    page.locator('#term .xterm-screen').boundingBox()
  ]);
  // require real native-link geometry
  if (rowBounds === null || screenBounds === null) throw new Error('native OSC link has no visible geometry');
  const point = { x: screenBounds.x + screenBounds.width / 40 * 4.5, y: rowBounds.y + rowBounds.height / 2 };
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('#term .xterm-screen')).toHaveClass(/xterm-cursor-pointer/u);
  const pagesBeforeContextClick = page.context().pages().length;
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForTimeout(100);
  expect(page.context().pages()).toHaveLength(pagesBeforeContextClick);
  expect(await drive<string[]>(page, 'openedUrlList')).toEqual([]);

  // plain left click stays on the app-owned URL seam
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => drive<string[]>(page, 'openedUrlList')).toEqual([target]);

  // native middle click opens the same controlled external destination
  const middlePagePromise = page.context().waitForEvent('page');
  await page.mouse.click(point.x, point.y, { button: 'middle' });
  const middlePage = await middlePagePromise;
  await expect(middlePage).toHaveURL(target);
  await expect(middlePage.getByText('controlled native OSC target', { exact: true })).toBeVisible();
  await middlePage.close();
});

test('OSC 10/11/12 sets leave the terminal theme alone', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  // Positive control: the observable is the live theme background, not a static value —
  // so a set that slipped through would actually change it.
  const before = await drive<string>(page, 'scrollableBackground');
  expect(before).not.toBe('');
  expect(before).not.toBe('rgb(0, 0, 0)');
  await drive(page, 'pushBytes', '\x1b]11;rgb:ffff/0000/0000\x07'); // background red, if it were applied
  await drive(page, 'pushBytes', '\x1b]10;rgb:0000/ffff/0000\x07'); // foreground green
  await drive(page, 'pushBytes', '\x1b]12;rgb:0000/0000/ffff\x07'); // cursor blue
  await page.waitForTimeout(150);
  expect(await drive<string>(page, 'scrollableBackground')).toBe(before);
});

test('a huge REP or SU completes without hanging the page', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[2147483647b'); // REP
  await drive(page, 'pushBytes', '\x1b[1000000S'); // SU
  await drive(page, 'pushBytes', 'STILL-ALIVE\r\n');
  await expect.poll(() => drive(page, 'screenText'), { timeout: 5000 }).toContain('STILL-ALIVE');
});

test('font size and colour theme changes apply live', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'setFont', 20);
  await expect.poll(() => drive(page, 'fontSizePx')).toBe(20);
  const beforeBackground = await drive<string>(page, 'themeBackground');
  await drive(page, 'setTheme', 'latte');
  await expect.poll(() => drive(page, 'themeBackground')).not.toBe(beforeBackground);
  await drive(page, 'setTheme', 'mocha'); // restore shared browser storage
});

test('writes nothing until the first size, then flushes buffered bytes in order', async ({ page }) => {
  await setup(page);
  // No size yet: bytes must be buffered, not rendered.
  await drive(page, 'pushBytes', 'EARLY-A\r\n');
  await drive(page, 'pushBytes', 'EARLY-B\r\n');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).not.toContain('EARLY-A');
  await drive(page, 'pushSize', 40, 10);
  await expect.poll(() => drive(page, 'screenText')).toContain('EARLY-A');
  const text = await drive<string>(page, 'screenText');
  expect(text.indexOf('EARLY-A')).toBeLessThan(text.indexOf('EARLY-B'));
});

// retain sharp cached output until the replacement seed arrives
test('a socket loss reconnects and re-seeds without keeping a stale line', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 50, width: '100%' });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'STALE-LINE\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('STALE-LINE');
  const status = page.locator('#term .streamed-terminal-status');
  await expect(status).toBeHidden();
  await drive(page, 'pushClose', 1006, 'lost');
  await expect.poll(() => drive(page, 'connectCalls')).toBeGreaterThan(1);
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Reconnecting…');
  const message = status.locator('.streamed-terminal-status-message');
  await expect(message).toBeVisible();
  await expect(message).toHaveCSS('background-color', 'rgb(249, 226, 175)');
  await expect(message).toHaveCSS('background-image', 'none');
  await expect(message).toHaveCSS('color', 'rgb(0, 0, 0)');
  expect(await drive<string>(page, 'screenText')).toContain('STALE-LINE');
  await expect(page.locator('#term .streamed-terminal-cover')).toHaveCount(0);
  // measure the solid status itself rather than its full-pane cached-output treatment
  for (const viewport of [{ label: 'desktop', width: 1440, height: 900 }, { label: 'phone', width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    const [badgeBounds, paneBounds] = await Promise.all([message.boundingBox(), page.locator('#term').boundingBox()]);
    // require visible geometry before comparing centers
    if (badgeBounds === null || paneBounds === null) throw new Error('reconnect badge or output pane is not visible');
    expect(badgeBounds.x + badgeBounds.width / 2 - paneBounds.x - paneBounds.width / 2).toBeCloseTo(0, 0);
    expect(badgeBounds.y + badgeBounds.height / 2 - paneBounds.y - paneBounds.height / 2).toBeCloseTo(0, 0);
    // inspect the retained cached-output border and hatching
    const appearance = await status.evaluate(element => {
      const backdrop = getComputedStyle(element, '::before');
      return {
        backdropFilter: backdrop.backdropFilter,
        filter: backdrop.filter,
        background: backdrop.backgroundColor,
        hatching: backdrop.backgroundImage,
        borderWidth: backdrop.borderTopWidth,
        borderStyle: backdrop.borderTopStyle,
        borderColor: backdrop.borderTopColor
      };
    });
    expect(appearance.backdropFilter).toBe('none');
    expect(appearance.filter).toBe('none');
    expect(appearance.background).toBe('rgba(0, 0, 0, 0)');
    expect(appearance.hatching).toContain('repeating-linear-gradient(135deg,');
    expect(appearance.borderWidth).toBe('2px');
    expect(appearance.borderStyle).toBe('solid');
    // tolerate color-mix rounding while checking the yellow palette and opacity
    expect(appearance.borderColor).toMatch(/color\(srgb 0\.97647\d* 0\.88627\d* 0\.68627\d* \/ 0\.58\)/u);
    await page.locator('#term').screenshot({ path: test.info().outputPath(`output-reconnecting-${viewport.label}.png`) });
  }
  await drive(page, 'pushSize', 40, 10);
  await expect(status).toBeVisible();
  await drive(page, 'pushBytes', 'AFTER-RECONNECT\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('AFTER-RECONNECT');
  expect(await drive<string>(page, 'screenText')).not.toContain('STALE-LINE');
  await expect(status).toBeHidden();
});

// keep the jump control centered and clickable across viewport sizes
test('the jump-to-latest control stays bottom-centered and returns to following', async ({ page }) => {
  await setup(page, { scrollback: 500, width: '100%' });
  await drive(page, 'pushSize', 40, 10);
  let payload = '';
  // fill enough scrollback to reveal the jump control
  for (let line = 1; line <= 60; line += 1) payload += `row-${line}\r\n`;
  await drive(page, 'pushBytes', payload);
  // wait for scrollback before scrolling
  await expect.poll(() => drive(page, 'baseY')).toBeGreaterThan(0);
  expect(await drive(page, 'jumpHidden')).toBe(true);

  // check desktop and phone placement with real pointer clicks
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await drive(page, 'scrollUp', 20);
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toBeVisible();
    const panelBox = await page.locator('#term').boundingBox();
    const jumpBox = await jump.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(jumpBox).not.toBeNull();
    expect(jumpBox!.x + jumpBox!.width / 2).toBeCloseTo(panelBox!.x + panelBox!.width / 2, 0);
    expect(panelBox!.y + panelBox!.height - jumpBox!.y - jumpBox!.height).toBeCloseTo(12, 0);
    await jump.click();
    const base = await drive<number>(page, 'baseY');
    // wait for the viewport to follow the latest output
    await expect.poll(() => drive(page, 'viewportY')).toBe(base);
    await expect(jump).toBeHidden();
  }
});

// mirror codex's return control with optional right-side pet space
const codexScrollFrame = (label: string, cols = 40, reservedColumns = 0): string => {
  const padding = ' '.repeat(Math.floor((cols - reservedColumns - label.length) / 2));
  return `\x1b[2J\x1b[HOlder Codex output\x1b[7;1H${padding}${label}\x1b[8;1H> pending draft`;
};

// keep native wheel gestures out of the codex prompt history
test('codex wheel without mouse reporting sends transcript scrolls instead of prompt-history arrows', async ({ page }) => {
  await setup(page, { codexScrollControls: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[?1049hLive Codex output');
  await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
  expect(await drive(page, 'mouseTrackingMode')).toBe('none');
  await drive(page, 'focusTerminal');
  await page.locator('#term .xterm-screen').hover();
  const beforeUp = await drive<string>(page, 'inputData');
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await drive<string>(page, 'inputData')).slice(beforeUp.length)).toBe('\x1b[5~');
  const beforeDown = await drive<string>(page, 'inputData');
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await drive<string>(page, 'inputData')).slice(beforeDown.length)).toBe('\x1b[6~');
  // deliberate keyboard arrows must still navigate the composer normally
  const beforeKeys = await drive<string>(page, 'inputData');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  expect((await drive<string>(page, 'inputData')).slice(beforeKeys.length)).toBe('\x1b[A\x1b[B');
  expect(await drive(page, 'activeIsTerminalTextarea')).toBe(true);
});

// preserve trackpad pacing and snapshot boundaries
test('codex fallback accumulates trackpad motion and waits for the current parsed screen', async ({ page }) => {
  await setup(page, { codexScrollControls: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[?1049hLive Codex output');
  await expect(page.locator('#term .xterm-rows')).toContainText('Live Codex output');
  const screen = page.locator('#term .xterm-screen');
  const bounds = await screen.boundingBox();
  // require actual cell geometry before simulating fractional rows
  if (bounds === null) throw new Error('terminal screen has no bounds');
  const position = { clientX: bounds.x + bounds.width / 16, clientY: bounds.y + bounds.height / 4 };
  // dispatch exact wheel units without relying on platform trackpad hardware
  const wheel = (deltaY: number, deltaMode = 0, modifiers: Record<string, boolean> = {}) =>
    screen.dispatchEvent('wheel', { ...position, deltaY, deltaMode, ...modifiers });
  const before = await drive<string>(page, 'inputData');
  const partialRow = -bounds.height / 10 / 2;
  // sub-row pixel events must accumulate rather than scrolling once per event
  for (let event = 0; event < 6; event += 1) await wheel(partialRow);
  expect(await drive<string>(page, 'inputData')).toBe(before);
  await wheel(partialRow);
  expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[5~');
  const afterScroll = await drive<string>(page, 'inputData');
  // browser zoom and horizontal gestures must never become prompt-history keys
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) await wheel(-1, 1, { [modifier]: true });
  await wheel(0, 1);
  expect(await drive<string>(page, 'inputData')).toBe(afterScroll);
  // a retained alternate screen cannot authorize input before the new seed parses
  await drive(page, 'pushReseed');
  await wheel(-1, 1);
  expect(await drive<string>(page, 'inputData')).toBe(afterScroll);
  await drive(page, 'pushBytes', '\x1b[?1049hFresh Codex output');
  await expect(page.locator('#term .xterm-rows')).toContainText('Fresh Codex output');
  await wheel(1, 2);
  expect((await drive<string>(page, 'inputData')).slice(afterScroll.length)).toBe('\x1b[6~');
});

// coalesce touch-generated line events and keep keyboard-safe input in non-mouse overlays
test('codex no-mouse overlays receive paced page keys instead of raw mouse reports', async ({ page }) => {
  await setup(page, { codexScrollControls: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[?1049hStatic pager overlay');
  await expect(page.locator('#term .xterm-rows')).toContainText('Static pager overlay');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const before = await drive<string>(page, 'inputData');
  // dispatch a whole burst in one task without real-time test flakiness
  const burst = (deltaY: number) => page.locator('#term .xterm-screen').evaluate((element, deltaY) => {
    // model the line events generated by a long touch drag
    for (let line = 0; line < 20; line += 1) element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY }));
  }, deltaY);
  await burst(-1);
  expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[5~');
  await page.clock.runFor(149);
  await burst(-1);
  expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[5~');
  await page.clock.runFor(1);
  await burst(-1);
  expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[5~\x1b[5~');
  // a reversed gesture responds immediately instead of waiting for the previous direction
  await burst(1);
  expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[5~\x1b[5~\x1b[6~');
});

// keep phone transcript gestures out of the codex prompt history
test('phone codex scrolling without mouse reporting sends page keys without opening the keyboard', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { codexScrollControls: true, width: '340px', height: '420px' });
    await drive(page, 'pushSize', 40, 10);
    await drive(page, 'pushBytes', '\x1b[?1049hLive Codex output');
    await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
    expect(await drive(page, 'mouseTrackingMode')).toBe('none');
    const beforeUp = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', 120)).toBe(true);
    expect((await drive<string>(page, 'inputData')).slice(beforeUp.length)).toBe('\x1b[5~');
    const beforeDown = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', -120)).toBe(true);
    expect((await drive<string>(page, 'inputData')).slice(beforeDown.length)).toBe('\x1b[6~');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
  } finally {
    // release the emulated phone after every outcome
    await context.close();
  }
});

// route app-owned history back to codex without moving keyboard focus
test('codex embedded scrolling shows jump and returns through the pane input', async ({ page }) => {
  await setup(page, { codexScrollControls: true, width: '100%' });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[?1049h\x1b[?1003h\x1b[?1006h');
  await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeHidden();
  // exercise full and compact labels including unseen activity
  for (const label of ['↓ Back to bottom · esc', '↓ Back to bottom', '↓ Bottom · esc', '↓ Bottom', 'New activity · ↓ Back to bottom · esc', 'New activity · ↓ Bottom', 'New · ↓ Bottom']) {
    await drive(page, 'pushBytes', codexScrollFrame(label));
    await expect(jump).toBeVisible();
    expect(await drive(page, 'viewportY')).toBe(0);
    expect(await drive(page, 'baseY')).toBe(0);
    const before = await drive<string>(page, 'inputData');
    await jump.click();
    expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[1;5F');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    // wait for codex's redraw rather than claiming the application reached the tail
    await expect(jump).toBeVisible();
    await drive(page, 'pushBytes', codexScrollFrame(''));
    await expect(jump).toBeHidden();
  }
  // preserve terminal input mode when returning to the tail
  await drive(page, 'focusTerminal');
  await drive(page, 'pushBytes', codexScrollFrame('↓ Back to bottom · esc'));
  await expect(jump).toBeVisible();
  await jump.click();
  expect(await drive(page, 'activeIsTerminalTextarea')).toBe(true);
  // a fresh seed clears the application-owned jump state
  await drive(page, 'pushReseed');
  await drive(page, 'pushBytes', '\x1b[?1049hLive Codex output');
  await expect(jump).toBeHidden();
});

// preserve the return control when codex reserves right-side columns for its pet
test('codex jump supports a narrower transcript beside an ambient pet', async ({ page }) => {
  await setup(page, { codexScrollControls: true });
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  // cover full and compact labels at desktop and narrow transcript widths
  for (const layout of [
    { cols: 80, reservedColumns: 12, label: 'New activity · ↓ Back to bottom · esc' },
    { cols: 40, reservedColumns: 14, label: '↓ Back to bottom · esc' },
    { cols: 24, reservedColumns: 12, label: '↓ Bottom' }
  ]) {
    await drive(page, 'pushSize', layout.cols, 10);
    await drive(page, 'pushBytes', `\x1b[?1049h${codexScrollFrame(layout.label, layout.cols, layout.reservedColumns)}`);
    await expect(jump).toBeVisible();
    const before = await drive<string>(page, 'inputData');
    await jump.click();
    expect((await drive<string>(page, 'inputData')).slice(before.length)).toBe('\x1b[1;5F');
    await drive(page, 'pushBytes', codexScrollFrame('', layout.cols, layout.reservedColumns));
    await expect(jump).toBeHidden();
  }
});

// never send application shortcuts based on output retained from an earlier stream
test('codex jump waits for a fresh parsed seed after reseed and reconnect', async ({ page }) => {
  await setup(page, { codexScrollControls: true, reconnectDelayMs: 10 });
  await drive(page, 'pushSize', 40, 10);
  const seed = `\x1b[?1049h${codexScrollFrame('↓ Back to bottom · esc')}`;
  await drive(page, 'pushBytes', seed);
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  // a reseed retains the screen as a placeholder but must invalidate its control
  await drive(page, 'pushReseed');
  await expect(jump).toBeHidden();
  const beforeReseed = await drive<string>(page, 'inputData');
  await drive(page, 'clickJump');
  expect(await drive<string>(page, 'inputData')).toBe(beforeReseed);
  await drive(page, 'pushBytes', seed);
  await expect(jump).toBeVisible();
  await jump.click();
  expect((await drive<string>(page, 'inputData')).slice(beforeReseed.length)).toBe('\x1b[1;5F');
  // the replacement connection must also await its own parsed screen before accepting jump
  await drive(page, 'pushClose', 1006, 'lost stream');
  await expect(jump).toBeHidden();
  await expect.poll(() => drive(page, 'connectCalls')).toBe(2);
  await drive(page, 'pushSize', 40, 10);
  const beforeReconnect = await drive<string>(page, 'inputData');
  await drive(page, 'clickJump');
  expect(await drive<string>(page, 'inputData')).toBe(beforeReconnect);
  await drive(page, 'pushBytes', seed);
  await expect(jump).toBeVisible();
  await jump.click();
  expect((await drive<string>(page, 'inputData')).slice(beforeReconnect.length)).toBe('\x1b[1;5F');
});

// retain local scrollback and avoid treating ordinary output as a codex control
test('codex jump detection ignores generic terminals and unsupported marker layouts', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', `\x1b[?1049h${codexScrollFrame('↓ Back to bottom · esc')}`);
  await expect.poll(() => drive<string>(page, 'screenText')).toContain('Back to bottom');
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeHidden();
  await setup(page, { codexScrollControls: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', codexScrollFrame('↓ Back to bottom · esc'));
  await expect.poll(() => drive<string>(page, 'screenText')).toContain('Back to bottom');
  await expect(jump).toBeHidden();
  await drive(page, 'pushBytes', '\x1b[?1049h\x1b[2J\x1b[H↓ Back to bottom · esc');
  await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
  await expect(jump).toBeHidden();
  // codex's left-aligned transcript cannot shift its control right of the grid midpoint
  await drive(page, 'pushBytes', '\x1b[2J\x1b[H                  ↓ Back to bottom');
  await expect.poll(() => drive<string>(page, 'screenText')).toContain('                  ↓ Back to bottom');
  await expect(jump).toBeHidden();
  // arrow-only narrow fallbacks are not unique enough to trigger pane input
  await drive(page, 'pushBytes', codexScrollFrame('↓'));
  await expect.poll(() => drive<string>(page, 'screenText')).toContain('↓');
  await expect(jump).toBeHidden();
});

// retain phone touch scrolling and focus while the application owns its viewport
test('phone codex scrolling reveals the compact jump without opening the keyboard', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { codexScrollControls: true, width: '340px', height: '420px' });
    await drive(page, 'pushSize', 40, 10);
    await drive(page, 'pushBytes', '\x1b[?1049h\x1b[?1003h\x1b[?1006hLive Codex output');
    await expect.poll(() => drive(page, 'mouseTrackingMode')).toBe('any');
    const before = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', 120)).toBe(true);
    expect((await drive<string>(page, 'inputData')).slice(before.length)).toMatch(/\x1b\[<64;\d+;\d+M/u);
    await drive(page, 'pushBytes', codexScrollFrame('New · ↓ Bottom'));
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toBeVisible();
    const beforeJump = await drive<string>(page, 'inputData');
    await jump.tap();
    expect((await drive<string>(page, 'inputData')).slice(beforeJump.length)).toBe('\x1b[1;5F');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    await drive(page, 'pushBytes', codexScrollFrame(''));
    await expect(jump).toBeHidden();
  } finally {
    // release the emulated phone after every outcome
    await context.close();
  }
});

test('server question and metadata frames reach their callbacks, and metadata can be requested', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushFrame', { type: 'question', question: { prompt: 'Pick one' } });
  await expect.poll(() => drive(page, 'questionsSeen')).toContainEqual({ prompt: 'Pick one' });
  await drive(page, 'requestMetadata');
  expect(await drive<string[]>(page, 'sentFrames')).toContain('metadata');
});

test('a large paste is split into multiple input frames within the byte cap', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  await drive(page, 'sendInputRaw', 'x'.repeat(100 * 1024)); // 100 KiB, over the 64 KiB cap
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before + 2);
});

// preserve application mouse gestures in shared Terminal mounts
test('ordinary mouse drag reaches a mouse-reporting Terminal mount', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 80, 24);
  await drive(page, 'pushBytes', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hmouse-reporting Terminal');
  await expect.poll(() => drive(page, 'mouseTrackingMode')).toBe('any');
  const screen = page.locator('#term .xterm-screen');
  await expect(screen).toBeVisible();
  const bounds = await screen.boundingBox();
  // require the shared terminal's real mouse surface
  if (bounds === null) throw new Error('shared terminal has no screen bounds');
  const before = await drive<string>(page, 'inputData');
  await page.mouse.move(bounds.x + 10, bounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 120, bounds.y + 30, { steps: 4 });
  await page.mouse.up();
  const input = (await drive<string>(page, 'inputData')).slice(before.length);
  expect(input).toMatch(/\x1b\[<\d+;\d+;\d+[Mm]/u);
  await expect(page.locator('#term .xterm-selection > div')).toHaveCount(0);
});

// preserve xterm's Shift override in shared Terminal mounts
test('Shift-drag selects mouse-reporting output in a Terminal mount', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 80, 24);
  await drive(page, 'pushBytes', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hselectable mouse-reporting Terminal');
  await expect.poll(() => drive(page, 'mouseTrackingMode')).toBe('any');
  const row = page.locator('#term .xterm-rows > div', { hasText: 'selectable mouse-reporting Terminal' });
  await expect(row).toBeVisible();
  const bounds = await row.boundingBox();
  // require visible terminal text for the real override gesture
  if (bounds === null) throw new Error('shared terminal row has no bounds');
  await page.keyboard.down('Shift');
  try {
    await page.mouse.move(bounds.x + 5, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 150, bounds.y + bounds.height / 2, { steps: 6 });
    await page.mouse.up();
  } finally {
    await page.keyboard.up('Shift');
  }
  await expect(page.locator('#term .xterm-selection > div').first()).toBeVisible();
});

// cover local history and application-owned alternate screens
test('touch scrolling stays local in history and reaches alternate-screen programs', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { width: '340px', height: '420px', scrollback: 500 });
    await drive(page, 'pushSize', 40, 12);
    let payload = '';
    for (let line = 1; line <= 60; line += 1) payload += `line-${String(line).padStart(2, '0')}\r\n`;
    await drive(page, 'pushBytes', payload);
    await expect.poll(() => drive(page, 'baseY')).toBeGreaterThan(0);
    const base = await drive<number>(page, 'baseY');
    expect(await drive<number>(page, 'viewportY')).toBe(base); // pinned to the bottom
    const beforeHistoryInput = await drive<string>(page, 'inputData');
    const owned = await drive<boolean>(page, 'touchDrag', 120); // finger down → history
    expect(owned).toBe(true);
    expect(await drive<number>(page, 'viewportY')).toBeLessThan(base);
    expect(await drive<string>(page, 'inputData')).toBe(beforeHistoryInput);
    // A scroll drag never becomes a click, so it must not focus the terminal — a scroll
    // must not summon the soft keyboard.
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    const beforeSideways = await drive<number>(page, 'viewportY');
    expect(await drive<boolean>(page, 'touchGesture', 120, 10)).toBe(false);
    expect(await drive<number>(page, 'viewportY')).toBe(beforeSideways);
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);

    await drive(page, 'pushBytes', '\x1b[?1049h'); // enter the alternate screen
    await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
    const beforeAltUp = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', 120)).toBe(true);
    const altUp = (await drive<string>(page, 'inputData')).slice(beforeAltUp.length);
    expect(altUp).toMatch(/^(?:\x1b\[A)+$/u);
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    const beforeAltDown = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', -120)).toBe(true);
    const altDown = (await drive<string>(page, 'inputData')).slice(beforeAltDown.length);
    expect(altDown).toMatch(/^(?:\x1b\[B)+$/u);

    await drive(page, 'pushBytes', '\x1b[?1003h\x1b[?1006h');
    await expect.poll(() => drive(page, 'mouseTrackingMode')).toBe('any');
    const beforeMouseUp = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', 120)).toBe(true);
    const mouseUp = (await drive<string>(page, 'inputData')).slice(beforeMouseUp.length);
    expect(mouseUp).toMatch(/\x1b\[<64;\d+;\d+M/u);
    const beforeMouseDown = await drive<string>(page, 'inputData');
    expect(await drive<boolean>(page, 'touchDrag', -120)).toBe(true);
    const mouseDown = (await drive<string>(page, 'inputData')).slice(beforeMouseDown.length);
    expect(mouseDown).toMatch(/\x1b\[<65;\d+;\d+M/u);
  } finally {
    await context.close();
  }
});

test('a tap focuses the terminal textarea so the soft keyboard opens', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { width: '340px', height: '420px' });
    await drive(page, 'pushSize', 40, 12);
    await drive(page, 'pushBytes', 'tap here\r\n');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    // A touch that never becomes a click (a scroll, or a browser-suppressed tap) must not
    // focus: iOS only raises the keyboard for a focus made from the synthesized click, so
    // focusing on touchend would leave the textarea focused without a keyboard.
    await drive(page, 'touchOnly');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    // The synthesized click a genuine tap produces focuses the hidden textarea, mirroring
    // the retired snapshot Log's coarse-pointer affordance that raised the soft keyboard.
    await drive(page, 'tap');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(true);
    // With the tap-summoned keyboard focused, typed characters reach the pane socket.
    await page.keyboard.type('hi');
    await expect.poll(() => drive(page, 'inputData')).toBe('hi');
  } finally {
    await context.close();
  }
});
