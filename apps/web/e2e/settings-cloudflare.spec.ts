import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';
import type { CloudflareStatus, SettingsStatus } from '../src/settings/contracts.js';

// isolate onboarding from live credentials, DNS and Docker
async function setup(page: Page, overrides: Partial<CloudflareStatus> = {}, observer = false, openGuide = true) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const status: SettingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
  const state = {
    active: !observer,
    posts: [] as Record<string, unknown>[],
    failActivation: false,
    holdOperation: false,
    status,
    cloudflare: { supported: true, mode: 'unconfigured', enabled: false, connected: false, tokenPresent: false, serviceUrl: 'http://127.0.0.1:9876', ...overrides } as CloudflareStatus
  };
  const appSource = { id: 'app', label: 'Application configuration', format: 'json', exists: true, writable: !observer, protected: false, tracked: false, revisionId: 'app-1', apply: 'rac-restart', value: { title: 'RAC' }, schema: { type: 'object', properties: { title: { type: 'string', label: 'Service title' } } } };
  const legacySources = overrides.mode === 'local' ? [
    { id: 'cloudflared', label: 'Cloudflare tunnel', format: 'cloudflared', exists: true, writable: true, protected: false, tracked: false, revisionId: 'legacy-config', apply: 'cloudflared-recreate', content: 'tunnel: local-example\n' },
    { id: 'cloudflared-credentials', label: 'Cloudflare credentials', format: 'credentials', exists: false, writable: true, protected: false, tracked: false, revisionId: 'legacy-credentials', apply: 'cloudflared-recreate' }
  ] : [];
  // mock every application API before navigation
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // expose only a synthetic authenticated control identity
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'cloudflare-csrf', active: state.active, deviceName: 'Cloudflare fixture', server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    // keep the surrounding dashboard empty
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'cloudflare-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (path === '/api/settings/status') return route.fulfill({ json: status });
    // model the two deliberate host operations independently
    if (path === '/api/settings/cloudflare' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.posts.push(body);
      const operation = { id: `cloudflare-${state.posts.length}`, kind: 'cloudflare' as const, state: state.holdOperation ? 'running' as const : 'complete' as const, phase: 'Starting connector' };
      state.status.operation = operation;
      // connector startup cannot change the public hostname
      if (body.action === 'connect') Object.assign(state.cloudflare, { mode: 'token', enabled: true, tokenPresent: true, connected: true, operation });
      // failed verification preserves the previously configured hostname
      else if (state.failActivation) state.cloudflare.operation = { ...operation, state: 'failed', error: 'cloudflare_verification_failed' };
      else Object.assign(state.cloudflare, { hostname: body.hostname, connected: true, verifiedAt: '2026-10-18T00:00:00Z', operation });
      return route.fulfill({ status: 202, json: { operation, ...(body.action === 'activate' ? { reconnectOrigin: `https://${body.hostname}` } : {}) } });
    }
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: state.cloudflare });
    if (path === '/api/settings') return route.fulfill({ json: { version: 1, installationKind: state.cloudflare.supported ? 'compose' : 'systemd', revisionId: 'snapshot-1', sources: [appSource, ...legacySources], status } });
    if (path === '/api/settings/remask') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { error: 'unmocked_fixture_request' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByRole('region', { name: 'Cloudflare connection status', exact: true })).toBeVisible();
  await expect(settings.getByText('Loading Cloudflare…', { exact: true })).toHaveCount(0);
  // explicitly reopen setup when a test exercises replacement rather than the summary
  if (openGuide) {
    const replace = settings.getByRole('button', { name: 'Replace tunnel', exact: true });
    if (await replace.isVisible()) await replace.click();
    await expect(settings.getByRole('button', { name: 'Start connector', exact: true })).toBeVisible();
  }
  return { settings, state };
}

// use the same section on desktop and narrow split navigation
async function selectSection(settings: Locator, label: string) {
  const selector = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  const name = new RegExp(`^${label}(?:\\s|$)`, 'u');
  // mobile navigation is a custom listbox rather than a native select
  if (await selector.isVisible()) { await selector.click(); await settings.page().getByRole('listbox', { name: 'Settings section options', exact: true }).getByRole('option', { name }).click(); }
  else await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name }).click();
}

// prove instructions and clipboard content at both layout widths
for (const width of [1440, 390]) test(`shows one Cloudflare setup page and copyable values at ${width}px`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 1000 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { settings } = await setup(page);
  await settings.getByRole('textbox', { name: 'Hostname', exact: true }).fill('rac.example.test');
  await settings.getByRole('button', { name: 'Copy service URL', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:9876');
  await settings.getByRole('button', { name: 'Copy setup instructions', exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Start connector');
  expect(copied).toContain('rac.example.test');
  expect(copied).toContain('http://127.0.0.1:9876');
  expect(copied).toContain('Verify and use hostname');
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(settings.getByRole('heading', { name: 'Cloudflare tunnel', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `/tmp/remoteagents-cloudflare-setup-${width}.png` });
});

test('starts only the connector and locks repeated requests', async ({ page }) => {
  const { settings, state } = await setup(page);
  state.holdOperation = true;
  const token = settings.getByLabel('Tunnel token', { exact: true });
  await token.fill('synthetic-connector-credential');
  await expect(token).toHaveAttribute('type', 'password');
  await settings.getByRole('button', { name: 'Start connector', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(Object.keys(state.posts[0]!).sort()).toEqual(['action', 'token']);
  expect(state.posts[0]!.action).toBe('connect');
  expect(state.cloudflare.hostname).toBeUndefined();
  await expect(token).toHaveValue('');
  await expect(settings.getByRole('button', { name: 'Start connector', exact: true })).toBeDisabled();
});

test('reuses a saved token without disclosing it', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', tokenPresent: true });
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveValue('');
  await settings.getByRole('button', { name: 'Start connector', exact: true }).click();
  await expect.poll(() => state.posts).toEqual([{ action: 'connect' }]);
  await expect(settings.getByText('Connector started · hostname not verified', { exact: true })).toBeVisible();
});

test('requires confirmation before verifying and switching hostname', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', tokenPresent: true, enabled: true, connected: true });
  await settings.getByRole('textbox', { name: 'Hostname', exact: true }).fill('rac.example.test');
  await settings.getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  const confirmation = settings.getByRole('alertdialog', { name: 'Use this public hostname?', exact: true });
  await expect(confirmation).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.posts).toHaveLength(0);
  await settings.getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await expect.poll(() => state.posts).toEqual([{ action: 'activate', hostname: 'rac.example.test' }]);
  await expect(settings.getByRole('link', { name: 'https://rac.example.test', exact: true })).toHaveAttribute('href', 'https://rac.example.test');
});

test('keeps a failed hostname draft and current origin for retry', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', tokenPresent: true, enabled: true, connected: true, hostname: 'old.example.test' });
  state.failActivation = true;
  await settings.getByRole('textbox', { name: 'Hostname', exact: true }).fill('new.example.test');
  await settings.getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await settings.getByRole('alertdialog', { name: 'Use this public hostname?', exact: true }).getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await expect(settings.getByText('The hostname did not reach this RAC.', { exact: false })).toBeVisible();
  await expect(settings.getByRole('textbox', { name: 'Hostname', exact: true })).toHaveValue('new.example.test');
  expect(state.cloudflare.hostname).toBe('old.example.test');
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');
  await expect(settings.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible();
});

test('protects entered tokens with the shared discard guard', async ({ page }) => {
  const { settings } = await setup(page);
  await settings.getByLabel('Tunnel token', { exact: true }).fill('synthetic-private-entry');
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  const confirmation = settings.getByRole('alertdialog', { name: 'Close Settings with unsaved changes?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await settings.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveValue('');
});

test('retains masked drafts across tabs and clears token plaintext on reconnect', async ({ page }) => {
  const { settings } = await setup(page);
  const token = settings.getByLabel('Tunnel token', { exact: true });
  await token.fill('synthetic-memory-only-entry');
  await selectSection(settings, 'This browser');
  await selectSection(settings, 'Cloudflare');
  await expect(token).toHaveValue('synthetic-memory-only-entry');
  await expect(token).toHaveAttribute('type', 'password');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(token).toHaveValue('');
});

test('does not retain entered tokens after another browser takes control', async ({ page }) => {
  const { settings, state } = await setup(page);
  await settings.getByLabel('Tunnel token', { exact: true }).fill('synthetic-takeover-entry');
  state.active = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Another device is active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Global settings' })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  state.active = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Global settings' }).first()).toBeVisible();
  // the worktree may restore its already-open Settings split after control returns
  if (!await settings.isVisible()) await page.getByRole('button', { name: 'Global settings' }).first().click();
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveValue('');
});

test('does not report a stopped connector as a live verified hostname', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', tokenPresent: true, enabled: true, connected: false, hostname: 'old.example.test', verifiedAt: '2026-10-18T00:00:00Z' });
  await expect(settings.getByText('Connector stopped', { exact: true })).toBeVisible();
  await expect(settings.getByText('Public hostname verified', { exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Verify and use hostname', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(0);
});

test('keeps legacy advanced editors minimal and missing files blank', async ({ page }) => {
  const { settings } = await setup(page, { mode: 'local', enabled: true, connected: true });
  await settings.getByText('Configuration files', { exact: true }).click();
  await expect(settings.getByText('Trusted code', { exact: true })).toHaveCount(0);
  await expect(settings.getByText('Source content', { exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Remove source', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Replace without revealing', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Create source', exact: true })).toHaveCount(0);
  const empty = settings.getByRole('textbox', { name: 'Cloudflare credentials source content', exact: true });
  await expect(empty).toHaveValue('');
  await expect(empty).toBeEditable();
  await empty.fill('{}');
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
});

test('blocks setup while unrelated drafts exist and on native installations', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', tokenPresent: true, enabled: true });
  await selectSection(settings, 'Application');
  await settings.getByRole('textbox', { name: 'Service title', exact: true }).fill('Changed');
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByRole('button', { name: 'Start connector', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  await page.reload();
  state.cloudflare.supported = false;
  state.cloudflare.reason = 'New tunnel setup is available for Docker installations only.';
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByText(state.cloudflare.reason, { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Start connector', exact: true })).toBeDisabled();
});

// keep existing installations compact on both navigation layouts
for (const width of [1440, 390]) test(`shows an existing tunnel endpoint and status without setup at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const { settings, state } = await setup(page, { mode: 'local', enabled: true, connected: true, endpoint: 'https://configured.example.com', hostname: 'configured.example.com' }, false, false);
  await expect(settings.getByRole('link', { name: 'https://configured.example.com', exact: true })).toHaveAttribute('href', 'https://configured.example.com');
  await expect(settings.getByRole('status', { name: 'Tunnel status', exact: true })).toHaveText('Up');
  await expect(settings.getByRole('heading', { name: '1. Create a tunnel in Cloudflare', exact: true })).toHaveCount(0);
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Copy setup instructions', exact: true })).toHaveCount(0);
  await settings.getByText('Configuration files', { exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'Cloudflare tunnel source content', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Replace tunnel', exact: true }).click();
  await expect(settings.getByRole('heading', { name: '1. Create a tunnel in Cloudflare', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Copy setup instructions', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await settings.getByRole('button', { name: 'Back to tunnel', exact: true }).click();
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveCount(0);
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: `/tmp/remoteagents-cloudflare-existing-${width}.png` });
});

test('keeps a down tunnel compact and replacement drafts open across refreshes and tabs', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', enabled: true, tokenPresent: true, connected: false, endpoint: 'https://saved.example.com', hostname: 'saved.example.com', verifiedAt: '2026-10-18T00:00:00Z' }, false, false);
  await expect(settings.getByRole('status', { name: 'Tunnel status', exact: true })).toHaveText('Down');
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Replace tunnel', exact: true }).click();
  await settings.getByLabel('Tunnel token', { exact: true }).fill('synthetic-replacement-entry');
  await expect(settings.getByRole('button', { name: 'Back to tunnel', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await selectSection(settings, 'This browser');
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveValue('synthetic-replacement-entry');
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveAttribute('type', 'password');
  expect(state.posts).toHaveLength(0);
});

test('removes replacement-only fields from search after discarding a replacement', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', enabled: true, tokenPresent: true, connected: true, endpoint: 'https://saved.example.com', hostname: 'saved.example.com', verifiedAt: '2026-10-18T00:00:00Z' }, false, false);
  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  const results = page.getByRole('listbox', { name: 'Settings search results', exact: true });
  const hostname = results.getByRole('option').filter({ has: page.getByText('Hostname', { exact: true }) }).filter({ has: page.getByText('Field', { exact: true }) });
  const token = results.getByRole('option').filter({ has: page.getByText('Tunnel token', { exact: true }) }).filter({ has: page.getByText('Field', { exact: true }) });

  // compact existing tunnels omit replacement-only fields
  await search.fill('hostname');
  await expect(hostname).toHaveCount(0);
  await settings.getByRole('button', { name: 'Replace tunnel', exact: true }).click();
  await settings.getByLabel('Tunnel token', { exact: true }).fill('synthetic-replacement-entry');
  await search.fill('hostname');
  await expect(hostname).toHaveCount(1);

  // discarding after navigation restores the compact search index
  await search.press('Escape');
  await selectSection(settings, 'This browser');
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await settings.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await search.fill('hostname');
  await expect(hostname).toHaveCount(0);
  await search.fill('tunnel token');
  await expect(token).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test('closes a replacement after its accepted operation completes off page', async ({ page }) => {
  const { settings, state } = await setup(page, { mode: 'token', enabled: true, tokenPresent: true, connected: true, endpoint: 'https://saved.example.com', hostname: 'saved.example.com', verifiedAt: '2026-10-18T00:00:00Z' }, false, false);
  state.holdOperation = true;
  await settings.getByRole('button', { name: 'Replace tunnel', exact: true }).click();
  await settings.getByRole('textbox', { name: 'Hostname', exact: true }).fill('next.example.com');
  await settings.getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await settings.getByRole('alertdialog', { name: 'Use this public hostname?', exact: true }).getByRole('button', { name: 'Verify and use hostname', exact: true }).click();
  await expect.poll(() => state.posts).toEqual([{ action: 'activate', hostname: 'next.example.com' }]);
  await selectSection(settings, 'This browser');
  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  const results = page.getByRole('listbox', { name: 'Settings search results', exact: true });
  await search.fill('hostname');
  const hostname = results.getByRole('option').filter({ has: page.getByText('Hostname', { exact: true }) }).filter({ has: page.getByText('Deployment › Cloudflare › Tunnel setup', { exact: true }) });
  await expect(hostname).toHaveCount(1);

  // reconcile the accepted operation while cloudflare is unmounted
  const completed = { ...state.status.operation!, state: 'complete' as const };
  state.status.operation = completed;
  state.cloudflare.operation = completed;
  await expect(hostname).toHaveCount(0);
  await search.fill('tunnel token');
  const token = results.getByRole('option').filter({ has: page.getByText('Tunnel token', { exact: true }) }).filter({ has: page.getByText('Field', { exact: true }) });
  await expect(token).toHaveCount(0);
  await search.press('Escape');
  await selectSection(settings, 'Cloudflare');
  await expect(settings.getByRole('button', { name: 'Replace tunnel', exact: true })).toBeVisible();
  await expect(settings.getByLabel('Tunnel token', { exact: true })).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: '1. Create a tunnel in Cloudflare', exact: true })).toHaveCount(0);
});
