import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyPatch } from '../../server/src/settings/patches.js';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';
import type { SettingsPatch } from '../src/settings/contracts.js';
import { mockAccountSocket } from './account-fixture.js';
import { confirmSettingsDiscard } from './settings-confirmation-helpers.js';

type SettingsRequest = { changes: Array<{ sourceId: string; revisionId: string; patches?: SettingsPatch[] }> };
type FixtureState = {
  value: Record<string, unknown>;
  revision: number;
  pending: boolean;
  effective: boolean;
  metricRequests: number;
  saves: SettingsRequest[];
  validations: SettingsRequest[];
};
type StorageWindow = Window & { __resourceMonitoringStorageWrites: string[] };

// publish the current restart state
const settingsStatus = (state: FixtureState) => ({ pending: state.pending, targets: state.pending ? ['rac'] : [], effective: 'known', restartAvailable: true });

// publish the current application file revision
function applicationSource(state: FixtureState, writable: boolean) {
  return {
    id: 'app',
    label: 'Application config',
    path: '/fixture/config.json',
    format: 'json',
    exists: true,
    writable,
    protected: false,
    tracked: false,
    revisionId: `app-r${state.revision}`,
    apply: 'rac-restart',
    content: `${JSON.stringify(state.value, null, 2)}\n`,
    value: structuredClone(state.value),
    schema: applicationSettingsSchema()
  };
}

// mount one stateful server setting fixture
async function setupResourceMonitoringSettings(page: Page, options: { enabled?: boolean; writable?: boolean } = {}) {
  await mockAccountSocket(page);
  await page.addInitScript(() => {
    localStorage.setItem('rac.resource-monitoring', 'legacy-browser-value');
    const writes: string[] = [];
    Object.defineProperty(window, '__resourceMonitoringStorageWrites', { value: writes });
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    // record obsolete preference writes
    Storage.prototype.setItem = function (key, value) {
      // capture only the retired preference
      if (key === 'rac.resource-monitoring') writes.push(`set:${value}`);
      return setItem.call(this, key, value);
    };
    // record obsolete preference removals
    Storage.prototype.removeItem = function (key) {
      // capture only the retired preference
      if (key === 'rac.resource-monitoring') writes.push('remove');
      return removeItem.call(this, key);
    };
  });
  const writable = options.writable !== false;
  const state: FixtureState = {
    value: {
      publicOrigin: 'https://fixture.example.test',
      ...(options.enabled === undefined ? {} : { resourceMonitoring: options.enabled })
    },
    revision: 1,
    pending: false,
    effective: options.enabled === true,
    metricRequests: 0,
    saves: [],
    validations: []
  };

  // isolate every console request from the live stack
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling fixture browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Fixture browser', resourceMonitoring: state.effective, server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, name: 'Davo', context: '', available: false } } });
    // observe monitoring without running the real collector
    if (path === '/api/server/resources/metrics') {
      state.metricRequests += 1;
      return route.fulfill({ json: {} });
    }
    // keep the dashboard inert
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'fixture' } } });
    // satisfy shared dashboard startup
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'fixture-ticket' } });
    // disable unrelated background updates
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // disable update notices
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // expose the current settings runtime
    if (path === '/api/settings/status') return route.fulfill({ json: settingsStatus(state) });
    // activate the persisted setting at the restart boundary
    if (path === '/api/settings/restart' && request.method() === 'POST') {
      state.effective = state.value.resourceMonitoring === true;
      state.pending = false;
      return route.fulfill({ json: settingsStatus(state) });
    }
    // publish the latest persisted application source
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${state.revision}`, installationKind: 'compose', sources: [applicationSource(state, writable)], status: settingsStatus(state) } });
    // accept only the staged setting transaction
    if (path === '/api/settings/validate' && request.method() === 'POST') {
      state.validations.push(structuredClone(request.postDataJSON() as SettingsRequest));
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    }
    // persist submitted patches through the production reducer
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as SettingsRequest;
      state.saves.push(structuredClone(body));
      let persisted: unknown = state.value;
      // preserve backend patch ordering
      for (const change of body.changes) {
        // ignore unrelated sources in this application fixture
        if (change.sourceId !== 'app') continue;
        // apply every authored application patch
        for (const patch of change.patches ?? []) persisted = applyPatch(persisted, patch);
      }
      state.value = persisted as Record<string, unknown>;
      state.revision += 1;
      state.pending = true;
      return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${state.revision}`, installationKind: 'compose', sources: [applicationSource(state, writable)], status: settingsStatus(state) } });
    }
    // keep connector setup outside this fixture
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, mode: 'unconfigured', enabled: false, connected: false, tokenPresent: false } });
    // keep connector health outside this fixture
    if (path === '/api/settings/cloudflare/health') return route.fulfill({ json: { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false } });
    // keep calendar setup outside this fixture
    if (path === '/api/settings/google-calendar') return route.fulfill({ json: { enabled: false, available: false, connected: false, status: 'disabled', calendars: [], setup: { clientId: false, clientSecret: false, tokenKey: false, redirectUri: 'http://127.0.0.1/' }, counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 } } });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('searchbox', { name: 'Search settings', exact: true })).toBeVisible();
  return { settings, state };
}

// open one desktop settings page
async function openPage(settings: Locator, label: string) {
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: label, exact: true }).click();
}

// compare only the visible label typography
const labelStyle = (label: Locator) => label.evaluate(element => {
  const { color, fontFamily, fontSize, fontWeight, letterSpacing, textTransform } = getComputedStyle(element);
  return { color, fontFamily, fontSize, fontWeight, letterSpacing, textTransform };
});

// cover both interface navigation layouts
for (const width of [1440, 390]) {
  // match browser labels without changing the shared controls or the next section divider
  test(`matches interface labels and removes the resource divider at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings } = await setupResourceMonitoringSettings(page);
    // open interface through the compact picker on phones
    if (width < 600) {
      await settings.getByRole('combobox', { name: 'Settings section', exact: true }).click();
      await page.getByRole('listbox', { name: 'Settings section options', exact: true }).locator('[data-value="interface"]').click();
    } else await openPage(settings, 'Interface');

    const baseline = settings.locator('[data-settings-path="notificationSounds"] header > small');
    await expect(baseline).toBeVisible();
    const expected = await labelStyle(baseline);
    // check both shared labels against the same browser label
    for (const path of ['flyoutMarkers', 'resourceMonitoring']) {
      const label = settings.locator(`[data-settings-path="${path}"] .settings-field-copy label > strong`);
      await expect(label).toBeVisible();
      expect(await labelStyle(label)).toEqual(expected);
    }
    const resource = settings.getByRole('region', { name: 'Resource monitoring', exact: true });
    await expect(resource).toHaveCSS('border-top-width', '0px');
    await expect(resource).toHaveCSS('padding-top', '0px');
    await expect(settings.getByRole('region', { name: 'Custom buttons', exact: true })).toHaveCSS('border-top-width', '1px');
  });
}

// verify dedicated placement default scope and search ownership
test('places resource monitoring on Interface as a server-wide setting', async ({ page }) => {
  const { settings, state } = await setupResourceMonitoringSettings(page);
  await openPage(settings, 'Application');
  await expect(settings.locator('[data-settings-path="resourceMonitoring"]')).toHaveCount(0);
  await openPage(settings, 'Interface');
  const setting = settings.locator('[data-settings-path="resourceMonitoring"]');
  await expect(setting.getByRole('switch', { name: 'Resource monitoring', exact: true })).not.toBeChecked();
  const resource = settings.getByRole('region', { name: 'Resource monitoring', exact: true });
  await expect(resource).toContainText('CPU and memory update');
  await expect(resource).not.toContainText('This browser');
  expect(state.value).not.toHaveProperty('resourceMonitoring');

  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('CPU memory disks WSL');
  const result = page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ hasText: 'Resource monitoring' });
  await expect(result).toContainText('Interface');
  await result.click();
  await expect(setting).toHaveAttribute('data-settings-search-highlight', 'true');
});

// verify discard save restart and storage ownership
test('persists resource monitoring through Application without browser storage writes', async ({ page }) => {
  const { settings, state } = await setupResourceMonitoringSettings(page);
  await openPage(settings, 'Interface');
  const toggle = settings.getByRole('switch', { name: 'Resource monitoring', exact: true });
  await toggle.check();
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await confirmSettingsDiscard(page);
  await expect(toggle).not.toBeChecked();
  expect(state.saves).toHaveLength(0);

  await toggle.check();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  expect(state.saves[0]!.changes).toEqual([expect.objectContaining({
    sourceId: 'app',
    revisionId: 'app-r1',
    patches: [expect.objectContaining({ op: 'set', path: ['resourceMonitoring'], value: true })]
  })]);
  expect(state.value.resourceMonitoring).toBe(true);
  const restart = page.getByRole('status', { name: 'Restart pending', exact: true });
  await expect(restart).toBeVisible();
  expect(state.metricRequests).toBe(0);

  // refresh the effective flag when the restart settles without a browser reload
  await restart.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(() => state.metricRequests).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as StorageWindow).__resourceMonitoringStorageWrites)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('rac.resource-monitoring'))).toBe('legacy-browser-value');
});

// verify installation write ownership reaches the dedicated control
test('disables resource monitoring in read-only catalogs', async ({ page }) => {
  const { settings } = await setupResourceMonitoringSettings(page, { enabled: true, writable: false });
  await openPage(settings, 'Interface');
  await expect(settings.getByRole('switch', { name: 'Resource monitoring', exact: true })).toBeDisabled();
  await expect(settings.getByRole('region', { name: 'Resource monitoring', exact: true }).getByRole('note')).toContainText('This setting is read-only');
});
