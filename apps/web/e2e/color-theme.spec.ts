import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';

// A console whose one agent renders a Live log, so both the terminal and the
// Global settings are on screen. `stored` seeds the localStorage key before
// the app loads, which is how the seeded-Latte case stages the persisted choice.
async function openConsole(page: Page, stored?: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installPaneMock(page);
  await page.addInitScript(seed => { if (seed !== null) localStorage.setItem('rac.color-theme', seed); }, stored ?? null);
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
  // Bring the pane live so the open terminal is mounted and painted.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'agent-1 output line\r\nagent-1 second line\r\n');
}

// The document's flavour attribute: 'latte' when set, undefined when absent (Mocha).
const themeAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

// The resolved background colour of the root element (`background: var(--crust)`),
// a real element whose paint flips with the flavour.
const rootBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

// The mobile browser-chrome colour the app advertises.
const metaThemeColor = (page: Page) => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'));

// The open terminal's painted background: xterm mirrors its theme's background
// onto the scrollable element's inline `background-color`, rewriting it whenever
// `options.theme` changes. (In xterm 6.0 this moved from `.xterm-viewport`, now a
// static-black overview-ruler sibling, to `.xterm-scrollable-element`.) Reading the
// on-screen (active) frame proves an already-open terminal repainted, using xterm's
// own DOM rather than any production-only hook.
const terminalBackground = (page: Page) => page.evaluate(() => {
  const scrollable = document.querySelector<HTMLElement>('.log-canvas .xterm-scrollable-element');
  return scrollable?.style.backgroundColor ?? '';
});

// open interface settings
const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Interface', exact: true }).click();
};

test('the toggle flips the whole UI between Dark and Light', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  // Mocha is the default: no attribute, dark crust, Mocha base advertised.
  expect(await themeAttr(page)).toBeUndefined();
  const mochaBackground = await rootBackground(page);
  expect(await metaThemeColor(page)).toBe('#1e1e2e');

  await openSettings(page);
  const dark = page.getByRole('radio', { name: 'Dark theme' });
  const light = page.getByRole('radio', { name: 'Light theme' });
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  await expect(light).toHaveAttribute('aria-checked', 'false');

  await light.click();
  // retain the draft without recolouring the applied browser
  expect(await themeAttr(page)).toBeUndefined();
  expect(await rootBackground(page)).toBe(mochaBackground);
  expect(await metaThemeColor(page)).toBe('#1e1e2e');
  await expect(light).toHaveAttribute('aria-checked', 'true');
  await expect(dark).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  // apply the staged theme without reloading
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  const latteBackground = await rootBackground(page);
  expect(latteBackground).not.toBe(mochaBackground);
  expect(await metaThemeColor(page)).toBe('#eff1f5');

  await dark.click();
  expect(await themeAttr(page)).toBe('latte');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  // apply the dark default cleanly
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBeUndefined();
  expect(await rootBackground(page)).toBe(mochaBackground);
  expect(await metaThemeColor(page)).toBe('#1e1e2e');
});

test('the choice persists across a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await openSettings(page);
  await page.getByRole('radio', { name: 'Light theme' }).click();
  expect(await page.evaluate(() => localStorage.getItem('rac.color-theme'))).toBeNull();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  expect(await page.evaluate(() => localStorage.getItem('rac.color-theme'))).toBe('latte');

  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  expect(await metaThemeColor(page)).toBe('#eff1f5');
});

test('a second tab of the same browser follows a storage change', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  expect(await themeAttr(page)).toBeUndefined();
  // Simulate another tab choosing Latte: the store re-reads localStorage on the
  // storage event and reflavours the document.
  await page.evaluate(() => {
    localStorage.setItem('rac.color-theme', 'latte');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.color-theme', newValue: 'latte' }));
  });
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  expect(await metaThemeColor(page)).toBe('#eff1f5');
});

test('switching back to Dark forgets the stored key', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page, 'latte');
  // A seeded Latte flavour is applied once the app mounts.
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  await openSettings(page);
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  expect(await themeAttr(page)).toBe('latte');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBeUndefined();
  // Mocha is the key's absence, so returning to Dark clears storage.
  expect(await page.evaluate(() => localStorage.getItem('rac.color-theme'))).toBeNull();
});

test('an already-open terminal repaints live when the flavour flips', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  // The terminal is open and painted Mocha before any toggle.
  await expect.poll(() => terminalBackground(page), { timeout: 10_000 }).not.toBe('');
  const mochaTerminal = await terminalBackground(page);

  await openSettings(page);
  await page.getByRole('radio', { name: 'Light theme' }).click();
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).toBe(mochaTerminal);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  // the already-open terminal follows the saved switch without reconnecting
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).not.toBe(mochaTerminal);
  const latteTerminal = await terminalBackground(page);
  expect(latteTerminal).not.toBe('');

  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).toBe(latteTerminal);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  // save dark and repaint the same open terminal again
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).toBe(mochaTerminal);
});

test('the pre-paint head script flavours the document before the app mounts', async ({ page }) => {
  test.setTimeout(60_000);
  // Seed the persisted Latte choice, then block the app's entry module so nothing
  // but the render-blocking /theme-init.js head script can set the attribute. If
  // Latte is present with the React app never mounted, it was applied at first
  // paint — proving the no-FOUC path.
  await page.addInitScript(() => localStorage.setItem('rac.color-theme', 'latte'));
  await page.route('**/src/main.tsx**', route => route.abort());
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  // The head script also flavours the mobile browser chrome, so the address bar
  // never flashes the Mocha default before the store takes over on mount.
  expect(await metaThemeColor(page)).toBe('#eff1f5');
  // Guard the isolation: the entry module was blocked, so React never mounted and
  // the flavour above can only have come from the head script — not the store.
  expect(await page.locator('#root > :not(noscript)').count()).toBe(0);
});
