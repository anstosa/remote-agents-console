import { expect, test, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';

// reject even hidden homepage DOM while preserving semantic selectors
async function expectHomepageAbsent(page: Page) {
  await expect(page.getByRole('heading', { name: 'Remote Agent Console', exact: true, includeHidden: true })).toHaveCount(0);
}

// keep restoration and authenticated states free of anonymous entry controls
async function expectAnonymousEntryAbsent(page: Page) {
  await expectHomepageAbsent(page);
  await expect(page.getByRole('heading', { name: 'Console access', exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
}

// isolate public entry and password login from real sessions and credentials
async function mockEntry(page: Page, initiallyAuthenticated = false) {
  await mockAccountSocket(page);
  let authenticated = initiallyAuthenticated;
  let bootstrapRequests = 0;
  const passwords: string[] = [];
  const server = { name: 'Fixture', url: 'http://127.0.0.1:4173', remotes: [] };
  const session = { csrfToken: 'entry-csrf', active: true, deviceName: 'Test browser', server };
  // exercise the real entry state machine against deterministic API responses
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // restore existing sessions before exposing any anonymous entry screen
    if (path === '/api/auth/session') return authenticated ? route.fulfill({ json: session }) : route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    // provide anonymous CSRF metadata without logging in
    if (path === '/api/auth/bootstrap') {
      bootstrapRequests += 1;
      return route.fulfill({ json: { csrfToken: 'entry-csrf', server } });
    }
    // require deliberate password submission instead of treating the homepage CTA as login
    if (path === '/api/auth/login') {
      const password = route.request().postDataJSON().password as string;
      passwords.push(password);
      // reject only the invalid synthetic password
      if (password !== 'synthetic-password') return route.fulfill({ status: 401, json: { error: 'invalid credentials' } });
      authenticated = true;
      return route.fulfill({ json: session });
    }
    // expose an empty signed-in console without any real operations
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // avoid unrelated notification and update work
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return { passwords, bootstrapRequests: () => bootstrapRequests };
}

// retain public product, Google data and legal information at all supported widths
for (const width of [1440, 390, 320]) test(`shows a descriptive public homepage before password entry at ${width}px`, async ({ page }) => {
  const state = await mockEntry(page);
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  await page.goto('/');

  const home = page.getByRole('main');
  await expect(home.getByRole('heading', { name: 'Remote Agent Console', exact: true })).toBeVisible();
  await expect(home.getByRole('heading', { name: 'Optional Google Calendar integration', exact: true })).toBeVisible();
  await expect(home.getByRole('heading', { name: 'Run agents', exact: true })).toBeVisible();
  await expect(home.getByRole('heading', { name: 'Manage repositories', exact: true })).toBeVisible();
  await expect(home).toContainText('account ID and email');
  await expect(home).toContainText('encrypted access and refresh tokens');
  await expect(home).toContainText('calendar.app.created');
  await expect(home).toContainText('not automatically put prompts, responses, file contents or filesystem paths');
  await expect(home).toContainText('Console password login is separate from Google authorization');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  expect(state.passwords).toEqual([]);

  const policies = home.getByRole('navigation', { name: 'Legal policies', exact: true });
  await expect(policies.getByRole('link', { name: 'Privacy Policy', exact: true })).toHaveAttribute('href', '/privacy');
  await expect(policies.getByRole('link', { name: 'Terms of Service', exact: true })).toHaveAttribute('href', '/terms');
  expect(await home.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  await home.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Console access', exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  expect(state.passwords).toEqual([]);
  await page.getByLabel('Password', { exact: true }).fill('discarded-synthetic-password');
  await page.getByRole('button', { name: 'Back to homepage', exact: true }).click();
  await expect(home.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await home.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

// restore named authenticated sessions directly into the console, including on reload
for (const width of [1440, 390]) test(`skips the homepage for an existing session at ${width}px`, async ({ page }) => {
  const state = await mockEntry(page, true);
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No sessions', exact: true })).toBeVisible();
  await expectAnonymousEntryAbsent(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No sessions', exact: true })).toBeVisible();
  await expectAnonymousEntryAbsent(page);
  expect(state.bootstrapRequests()).toBe(0);
  expect(state.passwords).toEqual([]);
});

// support the native no-javascript homepage's login destination after scripts are enabled
test('opens direct login links and returns to a clean homepage URL', async ({ page }) => {
  await mockEntry(page);
  await page.goto('/#login');
  await expect(page.getByRole('heading', { name: 'Console access', exact: true })).toBeVisible();
  await expectHomepageAbsent(page);
  await page.getByRole('button', { name: 'Back to homepage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Agent Console', exact: true })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
});

// avoid briefly exposing the homepage while a valid session is still being restored
test('keeps session restoration ahead of the public homepage', async ({ page }) => {
  await mockEntry(page, true);
  let releaseSession!: () => void;
  // hold the session response until the checking screen has rendered
  const restored = new Promise<void>(resolve => { releaseSession = resolve; });
  // override only the initial session probe with an explicitly delayed valid response
  await page.route('**/api/auth/session', async route => {
    await restored;
    return route.fulfill({ json: { csrfToken: 'entry-csrf', active: true, deviceName: 'Test browser' } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Restoring secure session', { exact: true })).toBeVisible();
  await expectAnonymousEntryAbsent(page);
  releaseSession();
  await expect(page.getByRole('heading', { name: 'No sessions', exact: true })).toBeVisible();
  await expectAnonymousEntryAbsent(page);
});

// retain intended workspace destinations and recover from rejected passwords
test('logs in after an explicit CTA and preserves a pending workspace hash', async ({ page }) => {
  const state = await mockEntry(page);
  await page.goto('/#worktree=pending-worktree');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/#worktree=pending-worktree$/u);
  await page.getByLabel('Password', { exact: true }).fill('wrong-synthetic-password');
  await page.getByRole('button', { name: 'Authenticate', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
  await expectHomepageAbsent(page);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Authenticate', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No sessions', exact: true })).toBeVisible();
  await expectAnonymousEntryAbsent(page);
  expect(state.passwords).toEqual(['wrong-synthetic-password', 'synthetic-password']);
});
