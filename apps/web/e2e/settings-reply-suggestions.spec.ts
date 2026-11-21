import { expect, test, type Locator, type Page } from '@playwright/test';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';
import { applyPatch } from '../../server/src/settings/patches.js';
import type { SettingsPatch } from '../src/settings/contracts.js';
import { mockAccountSocket } from './account-fixture.js';

type SettingsRequest = { changes: Array<{ sourceId: string; revisionId: string; patches?: SettingsPatch[] }> };
type FixtureState = {
  value: Record<string, unknown>;
  revision: number;
  saves: SettingsRequest[];
  validations: SettingsRequest[];
};

const settledStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true } as const;

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

// mount one stateful application settings fixture
async function setupReplySuggestionSettings(page: Page, options: { enabled?: boolean; autoDeleteSentNotes?: boolean; writable?: boolean } = {}) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const writable = options.writable !== false;
  const state: FixtureState = {
    value: {
      publicOrigin: 'https://fixture.example.test',
      ...(options.enabled === undefined ? {} : { replySuggestions: options.enabled }),
      ...(options.autoDeleteSentNotes === undefined ? {} : { autoDeleteSentNotes: options.autoDeleteSentNotes })
    },
    revision: 1,
    saves: [],
    validations: []
  };

  // isolate every console request from the live stack
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling fixture browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Fixture browser', server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, name: 'Davo', context: '', available: false } } });
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
    // expose a settled settings runtime
    if (path === '/api/settings/status') return route.fulfill({ json: settledStatus });
    // publish the latest persisted application source
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${state.revision}`, installationKind: 'compose', sources: [applicationSource(state, writable)], status: settledStatus } });
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
      return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${state.revision}`, installationKind: 'compose', sources: [applicationSource(state, writable)], status: settledStatus } });
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

// reopen Settings against the persisted fixture value
async function reloadSettings(page: Page) {
  await page.reload();
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('searchbox', { name: 'Search settings', exact: true })).toBeVisible();
  return settings;
}

// verify placement default copy and search ownership
test('places omitted reply suggestions on Agents with an agent-usage warning', async ({ page }) => {
  const { settings, state } = await setupReplySuggestionSettings(page);
  await openPage(settings, 'Application');
  await expect(settings.locator('[data-settings-path="replySuggestions"]')).toHaveCount(0);
  await openPage(settings, 'Agents');
  const setting = settings.locator('[data-settings-path="replySuggestions"]');
  const toggle = setting.getByRole('switch', { name: 'Reply suggestions', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(setting).toContainText(/current model and account\. Warning:.*increases agent usage/u);
  await expect(setting).not.toContainText('Off by default.');
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  expect(state.value).not.toHaveProperty('replySuggestions');

  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('Reply suggestions');
  const result = page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ hasText: 'Reply suggestions' });
  await expect(result).toContainText('Agents');
  await result.click();
  await expect(setting).toHaveAttribute('data-settings-search-highlight', 'true');
});

// verify server ownership placement help search and persistence
test('places and persists automatic sent-note deletion on Notes', async ({ page }) => {
  const { settings, state } = await setupReplySuggestionSettings(page);
  await openPage(settings, 'Application');
  await expect(settings.locator('[data-settings-path="autoDeleteSentNotes"]')).toHaveCount(0);
  await openPage(settings, 'Notes');
  const setting = settings.locator('[data-settings-path="autoDeleteSentNotes"]');
  const toggle = setting.getByRole('switch', { name: 'Auto-delete sent notes', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(setting).toContainText(/send them, queue them, or choose Launch and run.*Locked notes and scheduled runs are unaffected.*Undo/u);
  expect(state.value).not.toHaveProperty('autoDeleteSentNotes');

  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('queued unlocked notes');
  const result = page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ hasText: 'Auto-delete sent notes' });
  await expect(result).toContainText('Notes');
  await result.click();
  await expect(setting).toHaveAttribute('data-settings-search-highlight', 'true');

  await toggle.check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  expect(state.saves[0]!.changes.flatMap(change => change.patches ?? [])).toContainEqual(expect.objectContaining({ op: 'set', path: ['autoDeleteSentNotes'], value: true }));
  expect(state.value.autoDeleteSentNotes).toBe(true);
});

// verify explicit true false and true persistence
test('persists explicit reply suggestion choices across reloads', async ({ page }) => {
  let { settings, state } = await setupReplySuggestionSettings(page, { enabled: true });
  await openPage(settings, 'Agents');
  let toggle = settings.getByRole('switch', { name: 'Reply suggestions', exact: true });
  await expect(toggle).toBeChecked();

  await toggle.uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  expect(state.saves[0]!.changes.flatMap(change => change.patches ?? [])).toContainEqual(expect.objectContaining({ op: 'set', path: ['replySuggestions'], value: false }));
  expect(state.value.replySuggestions).toBe(false);

  settings = await reloadSettings(page);
  await openPage(settings, 'Agents');
  toggle = settings.getByRole('switch', { name: 'Reply suggestions', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]!.changes.flatMap(change => change.patches ?? [])).toContainEqual(expect.objectContaining({ op: 'set', path: ['replySuggestions'], value: true }));
  expect(state.value.replySuggestions).toBe(true);

  settings = await reloadSettings(page);
  await openPage(settings, 'Agents');
  await expect(settings.getByRole('switch', { name: 'Reply suggestions', exact: true })).toBeChecked();
});

// verify installation write ownership reaches the dedicated control
test('disables reply suggestions in read-only catalogs', async ({ page }) => {
  const { settings } = await setupReplySuggestionSettings(page, { enabled: true, writable: false });
  await openPage(settings, 'Agents');
  const replySuggestions = settings.getByRole('region', { name: 'Reply suggestions', exact: true });
  await expect(replySuggestions.getByRole('switch', { name: 'Reply suggestions', exact: true })).toBeDisabled();
  await expect(replySuggestions.getByRole('note')).toHaveText('This setting is read-only in this installation.');
});
