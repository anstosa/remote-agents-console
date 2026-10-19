import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, paneLastViewport } from './pane-stream-mock.js';

// A console whose one agent renders a Live log, so both the terminal and the
// Global settings are on screen. `stored` seeds the localStorage key before
// the app loads, which is how the garbage-value case stages a bad value.
async function openConsole(page: Page, stored?: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installPaneMock(page);
  await page.addInitScript(seed => {
    if (seed !== null) localStorage.setItem('rac.terminal-font-size', seed);
    // Record whether the app's keyboard dispatcher prevented a font shortcut's default. It
    // swallows the key before it bubbles, so keep the event and read it once dispatch is over.
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && ['=', '+', '-', '0'].includes(event.key)) {
        Object.defineProperty(window, '__fontKeyPrevented', { configurable: true, get: () => event.defaultPrevented });
      }
    }, true);
  }, stored ?? null);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  // Bring the pane live so the terminal is mounted and the panel has sent its grid.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'agent-1 output line\r\nagent-1 second line\r\n');
}

// The panel requests a grid on the pane socket (the Size claim) and re-requests it when
// the font changes; the last such request carries the current cols and rows.
const latestViewport = (page: Page) => paneLastViewport(page, 'agent-1');

const terminalFontPx = (page: Page) => page.evaluate(() => {
  const element = document.querySelector<HTMLElement>('.log-canvas .xterm');
  return element === null ? null : getComputedStyle(element).fontSize;
});

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
};

test('the stepper stages a size, applies it on Save, and resets to the default', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const baseline = (await latestViewport(page))!;
  expect(await terminalFontPx(page)).toBe('11px');

  await openSettings(page);
  const settingsPage = page.getByRole('dialog', { name: 'Settings' });
  const terminalSetting = settingsPage.getByRole('group', { name: 'Terminal font', exact: true });
  // compare a following preference in the unified browser panel
  const themeSetting = settingsPage.getByRole('group', { name: 'Theme', exact: true });
  const larger = page.getByRole('button', { name: 'Larger terminal font', exact: true });
  const smaller = page.getByRole('button', { name: 'Smaller terminal font', exact: true });
  const preview = page.getByLabel('Terminal font preview');
  const [terminalBefore, themeBefore] = await Promise.all([terminalSetting.boundingBox(), themeSetting.boundingBox()]);
  // lock the terminal row and following settings in place
  if (terminalBefore === null || themeBefore === null) throw new Error('Font settings have no layout bounds');
  const controlOrder = await settingsPage.locator('.client-settings-terminal-font').evaluate(element => {
    const previewBounds = element.querySelector('.client-settings-terminal-preview')?.getBoundingClientRect();
    const resetBounds = element.querySelector('.client-settings-font-reset')?.getBoundingClientRect();
    const smallerBounds = element.querySelector('[aria-label="Smaller terminal font"]')?.getBoundingClientRect();
    return { previewRight: previewBounds?.right, resetLeft: resetBounds?.left, resetRight: resetBounds?.right, smallerLeft: smallerBounds?.left };
  });
  expect(controlOrder.previewRight).toBeLessThanOrEqual(controlOrder.resetLeft ?? -1);
  expect(controlOrder.resetRight).toBeLessThanOrEqual(controlOrder.smallerLeft ?? -1);
  await expect(preview).toHaveCSS('font-size', '11px');
  await expect.poll(async () => (await latestViewport(page))?.cols ?? baseline.cols!).toBeLessThan(baseline.cols!);
  const settingsBaseline = (await latestViewport(page))!;
  // Reset appears only once the size differs from the default.
  await expect(page.getByRole('button', { name: 'Reset terminal font', exact: true })).toHaveCount(0);
  await larger.click();
  await larger.click();
  await larger.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('14px');
  await expect(preview).toHaveCSS('font-size', '14px');
  const [terminalAfter, themeAfter] = await Promise.all([terminalSetting.boundingBox(), themeSetting.boundingBox()]);
  // keep later settings fixed while the sample grows
  if (terminalAfter === null || themeAfter === null) throw new Error('Font settings have no layout bounds');
  expect(Math.abs(terminalAfter.height - terminalBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(themeAfter.y - themeBefore.y)).toBeLessThanOrEqual(1);
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('11px');
  expect((await latestViewport(page))?.cols).toBe(settingsBaseline.cols);
  await settingsPage.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('14px');
  await expect.poll(async () => (await latestViewport(page))?.cols ?? Infinity, { timeout: 10_000 }).toBeLessThan(settingsBaseline.cols!);

  const reset = page.getByRole('button', { name: 'Reset terminal font', exact: true });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('11px');
  await expect(preview).toHaveCSS('font-size', '11px');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('14px');
  await settingsPage.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('11px');
  await expect(reset).toHaveCount(0);
  // Larger disables at the 24px ceiling (13 steps up from the 11px default).
  for (let step = 0; step < 13; step += 1) await larger.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('24px');
  await expect(larger).toBeDisabled();
  const themeAtMaximum = await themeSetting.boundingBox();
  // retain the same following-setting position at the largest preview
  if (themeAtMaximum === null) throw new Error('Theme setting has no layout bounds');
  expect(Math.abs(themeAtMaximum.y - themeBefore.y)).toBeLessThanOrEqual(1);
  await reset.click();
  // Smaller disables at the 8px floor (3 steps down from the default).
  for (let step = 0; step < 3; step += 1) await smaller.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('8px');
  await expect(smaller).toBeDisabled();
});

test('the keyboard shortcut resizes the terminal and prevents page zoom', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const baseline = (await latestViewport(page))!;

  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('13px');
  await expect.poll(async () => (await latestViewport(page))?.cols ?? Infinity, { timeout: 10_000 }).toBeLessThan(baseline.cols!);
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(true);

  await page.keyboard.press('Control+Minus');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('12px');
  await page.keyboard.press('Control+Digit0');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('11px');
  // Reset forgets the stored key so the default tracks the CSS variable.
  expect(await page.evaluate(() => localStorage.getItem('rac.terminal-font-size'))).toBeNull();
});

test('the shortcut resizes while the terminal pane is focused', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  // xterm holds keyboard focus in a hidden textarea; the shortcut must still
  // resize the pane rather than being mistaken for an editable field.
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.log-canvas .xterm-helper-textarea')?.focus());
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('12px');
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(true);
});

test('the shortcut clamps at the 8px floor and 24px ceiling', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  for (let step = 0; step < 15; step += 1) await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('24px');
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('Control+Minus');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('8px');
});

test('a second tab of the same browser follows a storage change', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  // Simulate another tab writing the key: the store re-reads localStorage on the
  // storage event and re-renders the terminal at the new size.
  await page.evaluate(() => {
    localStorage.setItem('rac.terminal-font-size', '16');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.terminal-font-size', newValue: '16' }));
  });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('16px');
});

test('the size survives a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('14px');
  expect(await page.evaluate(() => localStorage.getItem('rac.terminal-font-size'))).toBe('14');

  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 10_000 }).toBe('14px');
});

test('the prompt composer ignores the shortcut', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.click();
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+Equal');
  // The console leaves the shortcut to the browser while an editable field owns
  // the keys: the font is unchanged and its default was not prevented.
  await expect(page.getByLabel('Live log')).toBeVisible();
  expect(await terminalFontPx(page)).toBe('11px');
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(false);
});

test('a garbage stored value falls back to the default', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page, 'not-a-number');
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 10_000 }).toBe('11px');
  await openSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('11px');
});
