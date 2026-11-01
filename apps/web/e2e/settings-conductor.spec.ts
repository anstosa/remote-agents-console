import { expect, test, type Locator, type Page } from '@playwright/test';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';
import { conductorOptInScopes, conductorScopes } from '../../server/src/integrations/auth/types.js';
import { mockAccountSocket } from './account-fixture.js';
import { applyPatch } from '../../server/src/settings/patches.js';
import type { SettingsPatch } from '../src/settings/contracts.js';

type AllowedModel = string | { model: string; effort?: string };
type CatalogModel = { id: string; name?: string; provider?: string };
type ConductorFixtureOptions = {
  writable?: boolean;
  effort?: string;
  scopes?: string[];
  model?: string;
  allowedModels?: AllowedModel[];
  enabled?: boolean;
  conductorAbsent?: boolean;
  saveSuccessfully?: boolean;
  catalogFailures?: number;
  catalogModels?: CatalogModel[];
};
type ConductorSettingsRequest = { changes: Array<{ sourceId: string; patches?: SettingsPatch[] }> };

const defaultCatalog: CatalogModel[] = [
  { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex', provider: 'OpenAI' },
  { id: 'anthropic/claude-opus-4.1', name: 'Claude Opus 4.1', provider: 'Anthropic' },
  { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', provider: 'Google' },
  { id: 'openrouter/deepseek-r1', name: 'DeepSeek R1', provider: 'OpenRouter' }
];

// choose one custom settings option by exact value
async function chooseOption(control: Locator, value: string) {
  await control.click();
  await control.page().getByRole('listbox', { name: `${await control.getAttribute('aria-label')} options`, exact: true }).locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}

// mount a settings catalog without touching host configuration
async function setupConductorSettings(page: Page, options: ConductorFixtureOptions = {}) {
  await mockAccountSocket(page);
  const schema = applicationSettingsSchema();
  const validationRequests: ConductorSettingsRequest[] = [];
  const saves: ConductorSettingsRequest[] = [];
  let catalogRequests = 0;
  const allowedModels = options.allowedModels ?? ['openai/gpt-5.1-codex', 'anthropic/claude-opus-4.1'];
  const value: Record<string, unknown> = {
    name: 'Fixture',
    adapters: { pi: { allowedModels: allowedModels.map(entry => typeof entry === 'string' ? { model: entry } : entry) } },
    projects: [{ id: 'conductor-home', path: '/tmp/conductor-home' }]
  };
  // configure only fixtures with an authored Conductor object
  if (!options.conductorAbsent) value.conductor = {
    kind: 'pi',
    project: 'conductor-home',
    model: options.model ?? 'openai/gpt-5.1-codex',
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
    maxWorkers: 4,
    maxSelfStartedTurnsPerHour: 30,
    scriptDeadlineMinutes: 10
  };
  const source = {
    id: 'app', label: 'Application config', path: '/fixture/config.json', format: 'json', exists: true,
    writable: options.writable ?? true, protected: false, tracked: false, revisionId: 'app-r1', apply: 'rac-restart',
    content: `${JSON.stringify(value, null, 2)}\n`, value, schema
  };
  // keep every settings request inside the browser fixture
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // provide the authenticated console identity
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Fixture browser', server: { name: 'Fixture', url: 'https://fixture.invalid', remotes: [] }, davo: { enabled: false, name: 'Davo', context: '', available: false } } });
    // provide the minimal dashboard shell
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'fixture' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'fixture-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    if (path === '/api/settings/conductor/models') {
      catalogRequests += 1;
      // fail only the requested initial attempts
      if (catalogRequests <= (options.catalogFailures ?? 0)) return route.fulfill({ status: 503, json: { error: 'fixture catalog unavailable' } });
      return route.fulfill({ json: { models: options.catalogModels ?? defaultCatalog } });
    }
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'snapshot-r1', installationKind: 'compose', sources: [source], status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
    // capture validation before any write
    if (path === '/api/settings/validate' && request.method() === 'POST') {
      validationRequests.push(request.postDataJSON());
      // allow only explicit successful persistence fixtures
      if (options.saveSuccessfully) return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
      return route.fulfill({ json: { valid: false, issues: [{ sourceId: 'app', path: ['conductor', 'scopes'], code: 'fixture', message: 'Fixture validation issue.' }], warnings: [] } });
    }
    // apply save patches only to this in-memory fixture
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as ConductorSettingsRequest;
      saves.push(body);
      // reject accidental writes from validation-failure fixtures
      if (!options.saveSuccessfully) return route.fulfill({ status: 500, json: { error: 'fixture must not save' } });
      // project each application change into the next snapshot
      for (const change of body.changes) {
        // unrelated sources never belong to this fixture
        if (change.sourceId !== 'app') continue;
        // exercise the same patch semantics used by settings persistence
        for (const patch of change.patches ?? []) source.value = applyPatch(source.value, patch) as Record<string, unknown>;
      }
      source.content = `${JSON.stringify(source.value, null, 2)}\n`;
      source.revisionId = `app-r${saves.length + 1}`;
      return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${saves.length + 1}`, installationKind: 'compose', sources: [source], status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true } } });
    }
    if (path === '/api/settings/cloudflare/health') return route.fulfill({ json: { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false } });
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, mode: 'unconfigured', enabled: false, connected: false, tokenPresent: false } });
    if (path === '/api/settings/google-calendar') return route.fulfill({ json: { enabled: false, available: false, connected: false, status: 'disabled', calendars: [], setup: { clientId: false, clientSecret: false, tokenKey: false, redirectUri: 'http://127.0.0.1/' }, counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 } } });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('searchbox', { name: 'Search settings', exact: true })).toBeVisible();
  return { settings, validationRequests, saves, source, catalogRequestCount: () => catalogRequests };
}

// open the dedicated Conductor settings page
async function openConductor(settings: Locator) {
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Conductor', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Conductor', level: 2 })).toBeVisible();
}

test('uses the full API model catalog and fixed controls without dirtying on discovery', async ({ page }) => {
  const { settings, validationRequests, saves, catalogRequestCount } = await setupConductorSettings(page);
  const nav = settings.getByRole('navigation', { name: 'Settings sources' });
  await nav.getByRole('button', { name: 'Application', exact: true }).click();
  await expect(settings.locator('[data-settings-path="conductor"]')).toHaveCount(0);
  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('Scopes');
  const scopeResult = page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ has: page.locator('.settings-search-result-title strong').filter({ hasText: /^Scopes$/u }) });
  await expect(scopeResult).toHaveCount(1);
  await scopeResult.click();
  await expect(settings).toContainText('configured directory Project');
  await expect(settings.getByRole('switch', { name: 'Conductor enabled', exact: true })).toBeChecked();
  await expect(settings.getByRole('button', { name: /Remove Conductor|Remove section/u })).toHaveCount(0);
  await expect(settings.getByRole('combobox', { name: 'Kind', exact: true })).toHaveCount(0);
  await search.fill('Kind');
  await expect(page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ has: page.locator('.settings-search-result-title strong').filter({ hasText: /^Kind$/u }) })).toHaveCount(0);
  await search.fill('');

  const model = settings.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeEnabled();
  await model.click();
  await expect(page.getByRole('listbox', { name: 'Model options', exact: true }).getByRole('option')).toHaveCount(defaultCatalog.length);
  const modelSearch = page.getByRole('searchbox', { name: 'Search Model options', exact: true });
  await modelSearch.fill('Google');
  await expect(page.getByRole('listbox', { name: 'Model options', exact: true }).getByRole('option')).toHaveAttribute('data-value', 'google/gemini-3-pro');
  await modelSearch.press('Escape');
  await expect(settings.getByRole('note').filter({ hasText: 'all Pi agents' })).toBeVisible();
  expect(catalogRequestCount()).toBe(1);
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

  const effort = settings.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(effort).toHaveAttribute('data-value', '');
  await expect(effort.locator('.settings-select-current-label')).toHaveText('Default');
  const scopeGroup = settings.getByRole('group', { name: 'Scopes', exact: true });
  const canonicalScopes = conductorScopes.filter(scope => !conductorOptInScopes.includes(scope));
  await expect(scopeGroup.getByRole('checkbox')).toHaveCount(conductorScopes.length);
  await expect(settings.locator('[data-settings-path="conductor.scopes"] .settings-field-copy small')).toHaveCount(0);
  // verify the absent presentation default without staging it
  for (const scope of canonicalScopes) await expect(scopeGroup.getByRole('checkbox', { name: scope, exact: true })).toBeChecked();
  // opt-in permissions remain unchecked until explicitly granted
  for (const scope of conductorOptInScopes) await expect(scopeGroup.getByRole('checkbox', { name: scope, exact: true })).not.toBeChecked();
  await expect(settings.getByRole('button', { name: /(?:Add|Move|Remove).*Scopes/u })).toHaveCount(0);
  // author an explicit empty list rather than restoring omission
  for (const scope of canonicalScopes) await scopeGroup.getByRole('checkbox', { name: scope, exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => validationRequests.length).toBe(1);
  expect(validationRequests[0]!.changes.flatMap(change => change.patches ?? []).find(patch => patch.path.join('.') === 'conductor.scopes')).toMatchObject({ op: 'set', value: [] });
  expect(saves).toEqual([]);
});

test('retries catalog failures without changing settings', async ({ page }) => {
  const { settings, catalogRequestCount } = await setupConductorSettings(page, { catalogFailures: 1 });
  await openConductor(settings);
  await expect(settings.getByRole('alert').filter({ hasText: 'fixture catalog unavailable' })).toBeVisible();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  expect(catalogRequestCount()).toBe(2);
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('selects a catalog model and atomically appends the Pi allowlist', async ({ page }) => {
  const originalAllowed: AllowedModel[] = [{ model: 'openai/gpt-5.1-codex', effort: 'high' }, { model: 'anthropic/claude-opus-4.1', effort: 'medium' }];
  const { settings, saves, source } = await setupConductorSettings(page, { allowedModels: originalAllowed, saveSuccessfully: true });
  await openConductor(settings);
  await chooseOption(settings.getByRole('combobox', { name: 'Model', exact: true }), 'google/gemini-3-pro');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.flatMap(change => change.patches ?? []);
  expect(patches.find(patch => patch.path.join('.') === 'conductor.model')).toMatchObject({ op: 'set', value: 'google/gemini-3-pro' });
  expect(patches.find(patch => patch.path.join('.') === 'adapters.pi.allowedModels')).toMatchObject({ op: 'set', value: [...originalAllowed, { model: 'google/gemini-3-pro' }] });
  expect((source.value as Record<string, any>).adapters.pi.allowedModels).toEqual([...originalAllowed, { model: 'google/gemini-3-pro' }]);
  expect((source.value as Record<string, any>).conductor.model).toBe('google/gemini-3-pro');
});

test('preserves unavailable models and enforces the 50-model Pi limit', async ({ page }) => {
  const allowedModels = Array.from({ length: 50 }, (_, index) => ({ model: `fixture/model-${index}`, effort: index === 0 ? 'high' : undefined }));
  const catalogModels = [{ id: 'fixture/model-0' }, { id: 'new/model' }];
  const { settings } = await setupConductorSettings(page, { model: 'legacy/unknown-model', allowedModels, catalogModels });
  await openConductor(settings);
  const model = settings.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeEnabled();
  await expect(model.locator('.settings-select-current-label')).toContainText('legacy/unknown-model (unavailable)');
  await expect(settings.getByRole('note').filter({ hasText: 'maximum 50 allowed models' })).toBeVisible();
  await model.click();
  await expect(page.getByRole('option', { name: 'new/model', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('persists the enabled switch off and on while preserving configuration', async ({ page }) => {
  const { settings, saves, source } = await setupConductorSettings(page, { saveSuccessfully: true });
  await openConductor(settings);
  const enabled = settings.getByRole('switch', { name: 'Conductor enabled', exact: true });
  await enabled.uncheck();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(settings.getByRole('textbox', { name: 'Project', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect((source.value as Record<string, any>).conductor).toMatchObject({ enabled: false, project: 'conductor-home', model: 'openai/gpt-5.1-codex' });
  await enabled.check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect((source.value as Record<string, any>).conductor).toMatchObject({ enabled: true, project: 'conductor-home', model: 'openai/gpt-5.1-codex' });
});

test('treats an absent Conductor as off and initializes only on explicit enable', async ({ page }) => {
  const { settings, validationRequests } = await setupConductorSettings(page, { conductorAbsent: true });
  await openConductor(settings);
  const enabled = settings.getByRole('switch', { name: 'Conductor enabled', exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await enabled.check();
  await expect(settings.getByRole('textbox', { name: 'Project', exact: true })).toHaveValue('');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => validationRequests.length).toBe(1);
  expect(validationRequests[0]!.changes.flatMap(change => change.patches ?? []).find(patch => patch.path.join('.') === 'conductor')).toMatchObject({ op: 'set', value: { enabled: true, kind: 'pi', project: '', model: '' } });
});

test('honors raw and read-only locks', async ({ page }) => {
  const { settings } = await setupConductorSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const section = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  await chooseOption(section, 'conductor');
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  await chooseOption(section, 'app');
  await settings.getByRole('button', { name: 'Edit base file' }).click();
  await settings.getByLabel('Application config source content').fill('{"brokenDraft":true}\n');
  await chooseOption(section, 'conductor');
  await expect(settings.getByRole('note').filter({ hasText: 'whole-source draft' })).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Conductor enabled', exact: true })).toBeDisabled();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
});

test('disables every Conductor control in read-only catalogs', async ({ page }) => {
  const { settings } = await setupConductorSettings(page, { writable: false, scopes: [] });
  await openConductor(settings);
  await expect(settings.getByRole('switch', { name: 'Conductor enabled', exact: true })).toBeDisabled();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(settings.getByRole('group', { name: 'Scopes', exact: true }).locator('input:checked')).toHaveCount(0);
  await expect(settings.getByRole('combobox', { name: 'Effort', exact: true })).toBeDisabled();
  await expect(settings.getByRole('note').filter({ hasText: 'Conductor settings are read-only' })).toBeVisible();
});

test('keeps effort and scopes permanent', async ({ page }) => {
  const { settings, validationRequests } = await setupConductorSettings(page, { effort: 'high', scopes: ['legacy:unknown', 'status:read'] });
  await openConductor(settings);
  const effort = settings.getByRole('combobox', { name: 'Effort', exact: true });
  await chooseOption(effort, '');
  const group = settings.getByRole('group', { name: 'Scopes', exact: true });
  expect(await group.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => input.parentElement?.querySelector('span')?.textContent))).toEqual([...conductorScopes, 'legacy:unknown (unsupported)']);
  await group.getByRole('checkbox', { name: 'logs:read', exact: true }).check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => validationRequests.length).toBe(1);
  const patches = validationRequests[0]!.changes.flatMap(change => change.patches ?? []);
  expect(patches.find(patch => patch.path.join('.') === 'conductor.effort')).toMatchObject({ op: 'remove' });
  expect(patches.find(patch => patch.path.join('.') === 'conductor.scopes')?.value).toEqual(['status:read', 'logs:read', 'legacy:unknown']);
  await expect(settings.getByRole('button', { name: 'Remove Effort' })).toHaveCount(0);
});
