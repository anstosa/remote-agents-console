import { expect, test, type Locator, type Page } from '@playwright/test';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';
import { applyPatch } from '../../server/src/settings/patches.js';
import type { SettingsPatch } from '../src/settings/contracts.js';
import { mockAccountSocket } from './account-fixture.js';

type AllowedModel = { model: string; effort?: string };
type AgentModelsFixtureOptions = {
  allowedModels?: AllowedModel[];
  omitAllowedModels?: boolean;
  conductorEnabled?: boolean;
  catalogFailures?: number;
  pi?: Record<string, unknown>;
  adapters?: Record<string, Record<string, unknown>>;
  defaultAgent?: string;
  readOnly?: boolean;
  expandPi?: boolean;
};
type SettingsRequest = { changes: Array<{ sourceId: string; patches?: SettingsPatch[] }> };

const piCatalog = [
  { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex', provider: 'OpenAI', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'anthropic/claude-opus-4.1', name: 'Claude Opus 4.1', provider: 'Anthropic', efforts: ['medium', 'high'], defaultEffort: 'high' },
  { id: 'meta/llama-4', name: 'Llama 4', provider: 'Meta', efforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', provider: 'Google', efforts: ['low', 'high'], defaultEffort: 'low' }
];

// hold one synthetic response until the test releases it
function deferredResponse() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// mount one isolated Agents settings catalog
async function setupAgentModels(page: Page, options: AgentModelsFixtureOptions = {}) {
  await mockAccountSocket(page);
  const schema = applicationSettingsSchema();
  const saves: SettingsRequest[] = [];
  const reveals: unknown[] = [];
  const remasks: unknown[] = [];
  let launchRequests = 0;
  const configured = options.allowedModels ?? [{ model: 'openai/gpt-5.1-codex', effort: 'high' }, { model: 'anthropic/claude-opus-4.1', effort: 'medium' }];
  const pi = { ...options.pi, ...(options.omitAllowedModels ? {} : { allowedModels: configured }) };
  const value: Record<string, any> = {
    name: 'Fixture',
    adapters: { ...options.adapters, pi },
    ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }),
    projects: [{ id: 'conductor-home', path: '/tmp/conductor-home' }],
    conductor: { enabled: options.conductorEnabled ?? true, kind: 'pi', project: 'conductor-home', model: 'openai/gpt-5.1-codex', spawnKinds: ['pi'], maxWorkers: 4, maxSelfStartedTurnsPerHour: 30, scriptDeadlineMinutes: 10 }
  };
  const source = {
    id: 'app', label: 'Application config', path: '/fixture/config.json', format: 'json', exists: true,
    writable: options.readOnly !== true, protected: false, tracked: false, revisionId: 'app-r1', apply: 'rac-restart',
    content: `${JSON.stringify(value, null, 2)}\n`, value, schema
  };
  // keep every settings request inside the browser fixture
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // provide authenticated shell dependencies
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Fixture browser', server: { name: 'Fixture', url: 'https://fixture.invalid', remotes: [] }, davo: { enabled: false, name: 'Davo', context: '', available: false } } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'fixture' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'fixture-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    if (path === '/api/launch/options') {
      launchRequests += 1;
      // fail only requested discovery attempts
      if (launchRequests <= (options.catalogFailures ?? 0)) return route.fulfill({ status: 503, json: { error: 'fixture models unavailable' } });
      const allowed = options.omitAllowedModels ? [] : configured.map(entry => ({ ...entry, available: true }));
      return route.fulfill({ json: { kinds: [{
        kind: 'pi', optionsRevision: `pi-${launchRequests}`,
        modelPolicy: { state: options.omitAllowedModels ? 'native-default' : 'explicit', allowed, defaultSelection: { mode: 'model', id: 'openai/gpt-5.1-codex' }, catalog: piCatalog, catalogStatus: 'ready' },
        security: { controls: [], defaults: {}, constraints: [], status: 'ready' }
      }] } });
    }
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'snapshot-r1', installationKind: 'compose', sources: [source], status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
    if (path === '/api/settings/validate' && request.method() === 'POST') return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    if (path === '/api/settings/reveal' && request.method() === 'POST') {
      reveals.push(request.postDataJSON());
      return route.fulfill({ json: { value: 'fixture-secret-value', revisionId: 'app-r1', leaseId: `adapter-card-lease-${reveals.length}`, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    if (path === '/api/settings/remask' && request.method() === 'POST') {
      remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as SettingsRequest;
      saves.push(body);
      // project application patches into the refreshed snapshot
      for (const change of body.changes) {
        // ignore unrelated fixture sources
        if (change.sourceId !== 'app') continue;
        // apply every staged semantic patch
        for (const patch of change.patches ?? []) source.value = applyPatch(source.value, patch) as Record<string, any>;
      }
      source.content = `${JSON.stringify(source.value, null, 2)}\n`;
      source.revisionId = `app-r${saves.length + 1}`;
      return route.fulfill({ json: { version: 1, revisionId: `snapshot-r${saves.length + 1}`, installationKind: 'compose', sources: [source], status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true } } });
    }
    if (path === '/api/settings/conductor/models') return route.fulfill({ json: { models: piCatalog } });
    if (path === '/api/settings/cloudflare/health') return route.fulfill({ json: { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false } });
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, mode: 'unconfigured', enabled: false, connected: false, tokenPresent: false } });
    if (path === '/api/settings/google-calendar') return route.fulfill({ json: { enabled: false, available: false, connected: false, status: 'disabled', calendars: [], setup: { clientId: false, clientSecret: false, tokenKey: false, redirectUri: 'http://127.0.0.1/' }, counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 } } });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const agentsNavigation = settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Agents', exact: true });
  // use the responsive section control when desktop navigation is hidden
  if (await agentsNavigation.isVisible()) await agentsNavigation.click();
  else await chooseOption(settings.getByRole('combobox', { name: 'Settings section', exact: true }), 'agents');
  await expect(settings.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible();
  const piCard = settings.locator('details[data-settings-path="adapters.pi"]');
  await expect(piCard).toBeVisible();
  // open only the adapter required by focused field-editing scenarios
  if (options.expandPi !== false) {
    await piCard.locator('summary').click();
    await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"]')).toBeVisible();
  }
  return { settings, saves, source, reveals, remasks, launchRequestCount: () => launchRequests };
}

// open one checkbox picker from its settings field
async function openModels(settings: Locator) {
  const adapter = settings.locator('details[data-settings-path="adapters.pi"]');
  // section navigation remounts cards with their collapsed default
  if (await adapter.getAttribute('open') === null) await adapter.locator('summary').click();
  await settings.getByRole('button', { name: 'Pi allowed models', exact: true }).click();
  return settings.page().getByRole('dialog', { name: 'Pi allowed models', exact: true });
}

// choose one menu-only settings option
async function chooseOption(control: Locator, value: string) {
  await control.click();
  await control.page().getByRole('listbox', { name: `${await control.getAttribute('aria-label')} options`, exact: true }).locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}

// omission keeps registry priority without writing configuration
test('shows an automatic default adapter above collapsed cards on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, saves } = await setupAgentModels(page, { conductorEnabled: false, expandPi: false });
  const field = settings.locator('[data-settings-path="defaultAgent"]');
  const control = field.getByRole('combobox', { name: 'Default adapter', exact: true });
  await expect(control).toHaveAttribute('data-value', '');
  await expect(control).toContainText('Automatic (first available)');
  await expect(settings.locator('.settings-adapter-card[open]')).toHaveCount(0);
  const fieldBounds = await field.boundingBox();
  const cardBounds = await settings.locator('.settings-adapter-card').first().boundingBox();
  expect(fieldBounds).not.toBeNull();
  expect(cardBounds).not.toBeNull();
  expect(fieldBounds!.x).toBeGreaterThanOrEqual(8);
  expect(fieldBounds!.x + fieldBounds!.width).toBeLessThanOrEqual(382);
  expect(fieldBounds!.y + fieldBounds!.height).toBeLessThan(cardBounds!.y);
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  expect(saves).toEqual([]);
});

// one explicit choice stages only the application default adapter
test('saves a configured default adapter and marks the Agents page dirty', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    expandPi: false,
    adapters: { codex: {} }
  });
  const control = settings.getByRole('combobox', { name: 'Default adapter', exact: true });
  await control.click();
  const options = page.getByRole('listbox', { name: 'Default adapter options', exact: true });
  await expect(options.getByRole('option')).toHaveCount(3);
  await expect(options.getByRole('option', { name: 'Automatic (first available)', exact: true })).toBeVisible();
  await expect(options.getByRole('option', { name: 'Codex', exact: true })).toBeVisible();
  await expect(options.getByRole('option', { name: 'Pi', exact: true })).toBeVisible();
  await options.locator('[role="option"][data-value="codex"]').click();
  const navigation = settings.getByRole('navigation', { name: 'Settings sources' });
  await expect(navigation.getByRole('button', { name: 'Agents Unsaved changes', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? [])).toEqual([
    expect.objectContaining({ op: 'set', path: ['defaultAgent'], value: 'codex' })
  ]);
  expect(source.value.defaultAgent).toBe('codex');
});

// retain an unavailable saved choice until the operator changes it
test('preserves an unconfigured explicit default adapter without writing', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    expandPi: false,
    defaultAgent: 'claude'
  });
  const control = settings.getByRole('combobox', { name: 'Default adapter', exact: true });
  await expect(control).toHaveAttribute('data-value', 'claude');
  await expect(control).toContainText('Claude (unavailable)');
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  expect(source.value.defaultAgent).toBe('claude');
  expect(saves).toEqual([]);
});

// read-only application settings keep the visible default choice locked
test('disables the default adapter selector for read-only settings', async ({ page }) => {
  const { settings, saves } = await setupAgentModels(page, { conductorEnabled: false, expandPi: false, readOnly: true });
  await expect(settings.getByRole('combobox', { name: 'Default adapter', exact: true })).toBeDisabled();
  expect(saves).toEqual([]);
});

test('selects catalog models, reorders the default, and preserves per-model effort metadata', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, { conductorEnabled: false });
  const rows = settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row');
  const picker = await openModels(settings);
  await expect(picker.getByRole('group', { name: 'Pi allowed models choices', exact: true })).toBeVisible();
  await expect(picker.locator('[role="option"]')).toHaveCount(0);
  const search = picker.getByRole('searchbox', { name: 'Search Pi allowed models', exact: true });
  await expect(search).toBeFocused();
  await search.fill('Gemini');
  await picker.getByRole('checkbox', { name: /Gemini 3 Pro/u }).check();
  await search.fill('Llama');
  await picker.getByRole('checkbox', { name: /Llama 4/u }).check();
  await expect(rows.nth(2)).toContainText('Llama 4');
  await expect(rows.nth(3)).toContainText('Gemini 3 Pro');
  await search.fill('Gemini');
  await expect(picker.getByRole('button')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await settings.getByRole('button', { name: 'Make google/gemini-3-pro default', exact: true }).click();

  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Gemini 3 Pro');
  await expect(rows.first()).toContainText('Default for new agents');
  await chooseOption(rows.first().getByRole('combobox', { name: 'google/gemini-3-pro default effort', exact: true }), 'high');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patch = saves[0]!.changes.flatMap(change => change.patches ?? []).find(candidate => candidate.path.join('.') === 'adapters.pi.allowedModels');
  expect(patch).toMatchObject({ op: 'set', value: [
    { model: 'google/gemini-3-pro', effort: 'high' },
    { model: 'openai/gpt-5.1-codex', effort: 'high' },
    { model: 'anthropic/claude-opus-4.1', effort: 'medium' },
    { model: 'meta/llama-4' }
  ] });
  expect(source.value.adapters.pi.allowedModels).toEqual((patch as Extract<SettingsPatch, { op: 'set' }>).value);
});

test('chooses the default from selected-model stars without changing membership or effort', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page);
  const field = settings.locator('[data-settings-path="adapters.pi.allowedModels"]');
  const rows = field.locator('.settings-agent-model-row');
  const current = field.getByRole('button', { name: 'openai/gpt-5.1-codex is the default model', exact: true });
  const next = field.getByRole('button', { name: 'Make anthropic/claude-opus-4.1 default', exact: true });
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(current.locator('svg')).not.toHaveCSS('fill', 'none');
  await expect(next).toHaveAttribute('aria-pressed', 'false');
  await expect(next.locator('svg')).toHaveCSS('fill', 'none');
  const bounds = await next.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(28);
  expect(bounds!.width).toBeLessThanOrEqual(31);
  expect(bounds!.height).toBeGreaterThanOrEqual(28);
  expect(bounds!.height).toBeLessThanOrEqual(31);

  await next.focus();
  await next.press('Enter');
  const selected = field.getByRole('button', { name: 'anthropic/claude-opus-4.1 is the default model', exact: true });
  await expect(selected).toBeFocused();
  await expect(rows.first()).toContainText('Claude Opus');
  await expect(rows.first()).toContainText('Default for new agents');
  await expect(rows.nth(1)).toContainText('Required by Conductor');

  const picker = await openModels(settings);
  await expect(picker.getByRole('checkbox', { name: /GPT-5.1 Codex.*Required by Conductor/u })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /Claude Opus/u })).toBeChecked();
  await page.keyboard.press('Escape');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(source.value.adapters.pi.allowedModels).toEqual([
    { model: 'anthropic/claude-opus-4.1', effort: 'medium' },
    { model: 'openai/gpt-5.1-codex', effort: 'high' }
  ]);

  // wait for the saved revision before deciding whether its card needs reopening
  await expect(page.getByRole('status').filter({ hasText: 'Settings updated.' })).toBeVisible();
  const adapter = settings.locator('details[data-settings-path="adapters.pi"]');
  // saved settings remount with adapter cards collapsed
  if (await adapter.getAttribute('open') === null) await adapter.locator('summary').click();
  await field.getByRole('button', { name: 'anthropic/claude-opus-4.1 is the default model', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  expect(saves).toHaveLength(1);
});

test('disables selected-model stars when agent settings are read-only', async ({ page }) => {
  const { settings } = await setupAgentModels(page, { conductorEnabled: false, readOnly: true });
  const stars = settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-default-button');
  await expect(stars).toHaveCount(2);
  await expect(stars.nth(0)).toBeDisabled();
  await expect(stars.nth(1)).toBeDisabled();
});

test('keeps the Conductor model required until Conductor is staged off', async ({ page }) => {
  const { settings } = await setupAgentModels(page);
  let picker = await openModels(settings);
  const required = picker.getByRole('checkbox', { name: /GPT-5.1 Codex.*Required by Conductor/u });
  await expect(required).toBeChecked();
  await expect(required).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row').first()).toContainText('Required by Conductor');

  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Conductor', exact: true }).click();
  await settings.getByRole('switch', { name: 'Conductor enabled', exact: true }).uncheck();
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Agents', exact: true }).click();
  picker = await openModels(settings);
  await expect(picker.getByRole('checkbox', { name: /GPT-5.1 Codex/u })).toBeEnabled();
  await picker.getByRole('checkbox', { name: /GPT-5.1 Codex/u }).uncheck();
  await page.keyboard.press('Escape');
  await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row').first()).toContainText('Claude Opus');
});

test('shows only the exact native default for an omitted policy and writes only after input', async ({ page }) => {
  const { settings, saves } = await setupAgentModels(page, { omitAllowedModels: true, conductorEnabled: false });
  const field = settings.locator('[data-settings-path="adapters.pi.allowedModels"]');
  await expect(field.locator('.settings-agent-model-row')).toHaveCount(1);
  await expect(field.locator('.settings-agent-model-row')).toContainText('GPT-5.1 Codex');
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  const picker = await openModels(settings);
  await picker.getByRole('checkbox', { name: /Claude Opus/u }).check();
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? []).find(candidate => candidate.path.join('.') === 'adapters.pi.allowedModels')).toMatchObject({ op: 'set', value: [{ model: 'openai/gpt-5.1-codex' }, { model: 'anthropic/claude-opus-4.1' }] });
});

test('blocks explicit empty policies, restores them on discard, and retries discovery without losing saved values', async ({ page }) => {
  const { settings, launchRequestCount } = await setupAgentModels(page, { conductorEnabled: false, catalogFailures: 1 });
  await expect(settings.getByRole('alert').filter({ hasText: 'fixture models unavailable' })).toBeVisible();
  await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row')).toHaveCount(2);
  await settings.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(launchRequestCount).toBe(2);
  const picker = await openModels(settings);
  await picker.getByRole('checkbox', { name: /GPT-5.1 Codex/u }).uncheck();
  await picker.getByRole('checkbox', { name: /Claude Opus/u }).uncheck();
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('alert').filter({ hasText: 'Choose at least one allowed model' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row')).toHaveCount(2);
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

// keep the dropdown limited to model membership and leave defaults on row stars
test('keeps the model dropdown checkbox-only and restores focus on Escape', async ({ page }) => {
  const { settings } = await setupAgentModels(page, { conductorEnabled: false });
  const trigger = settings.getByRole('button', { name: 'Pi allowed models', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Pi allowed models', exact: true });
  const search = picker.getByRole('searchbox', { name: 'Search Pi allowed models', exact: true });
  await expect(search).toBeFocused();
  await search.fill('Gemini');
  const checkbox = picker.getByRole('checkbox', { name: /Gemini 3 Pro/u });
  await checkbox.focus();
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
  await expect(picker.getByRole('button')).toHaveCount(0);
  await expect(settings.locator('[data-settings-path="adapters.pi.allowedModels"] .settings-agent-model-row').first()).toContainText('GPT-5.1 Codex');
  await search.focus();
  await search.fill('Claude');
  await search.press('Tab');
  await expect(picker.getByRole('checkbox', { name: /Claude Opus/u })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// the viewport hook must not be overruled by a wider css minimum
test('keeps the models checkbox picker inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings } = await setupAgentModels(page);
  const picker = await openModels(settings);
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
});

// configured and unconfigured adapters start collapsed on desktop and mobile
for (const width of [1280, 390]) {
  test(`starts every agent adapter collapsed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, saves } = await setupAgentModels(page, { expandPi: false });
    const cards = settings.locator('.settings-adapter-card');
    await expect(cards).toHaveCount(5);
    await expect(settings.locator('.settings-adapter-card[open]')).toHaveCount(0);
    const pi = settings.locator('details[data-settings-path="adapters.pi"]');
    await expect(pi.getByText('Configured', { exact: true })).toHaveCSS('color', 'rgb(166, 227, 161)');
    await expect(pi.getByRole('button', { name: 'Remove Pi', exact: true })).toHaveCount(0);
    await expect(pi.locator('[data-settings-path="adapters.pi.allowedModels"]')).not.toBeVisible();
    await pi.locator('summary').press('Enter');
    await expect(pi).toHaveAttribute('open', '');
    await expect(pi.getByRole('button', { name: 'Remove Pi', exact: true })).toBeVisible();
    expect(saves).toEqual([]);
  });
}

// adapter cards retain drafts while collapsed and reopen for search destinations
test('groups adapters into expandable cards without losing drafts', async ({ page }) => {
  const { settings } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { args: ['--fixture'], sandbox: { allowedDomains: ['api.example.com'] } }
  });
  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  const codex = settings.locator('details[data-settings-path="adapters.codex"]');
  await expect(pi).toHaveAttribute('open', '');
  await expect(codex).not.toHaveAttribute('open', '');

  const argument = pi.getByLabel('Arg 1', { exact: true });
  await argument.fill('--draft-value');
  await pi.locator('summary').click();
  await expect(pi).not.toHaveAttribute('open', '');
  const configured = pi.getByText('Configured', { exact: true });
  await expect(configured).toHaveClass(/settings-adapter-status-configured/u);
  await expect(configured).toHaveCSS('color', 'rgb(166, 227, 161)');
  await expect(pi.getByRole('button', { name: 'Remove Pi', exact: true })).toHaveCount(0);
  await pi.locator('summary').press('Enter');
  await expect(pi).toHaveAttribute('open', '');
  await expect(configured).toHaveCount(0);
  await expect(pi.getByRole('button', { name: 'Remove Pi', exact: true })).toHaveCount(1);
  await expect(argument).toHaveValue('--draft-value');

  await pi.locator('summary').click();
  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('Allowed domains');
  await page.getByRole('listbox', { name: 'Settings search results', exact: true }).getByRole('option').filter({ hasText: 'Allowed domains' }).first().click();
  await expect(pi).toHaveAttribute('open', '');
  await expect(pi.locator('[data-settings-path="adapters.pi.sandbox.allowedDomains"]')).toHaveAttribute('data-settings-search-highlight', 'true');
});

// configured cards expose removal only in their expanded header
test('replaces configured status with the adapter remove action while open', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, { conductorEnabled: false });
  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  await expect(pi).toHaveAttribute('open', '');
  await expect(pi.getByText('Configured', { exact: true })).toHaveCount(0);
  await pi.getByRole('button', { name: 'Remove Pi', exact: true }).click();
  await expect(pi).toHaveAttribute('open', '');
  await expect(pi.getByRole('button', { name: 'Remove Pi', exact: true })).toHaveCount(0);
  await expect(pi.getByText('Not configured', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? [])).toEqual([
    expect.objectContaining({ op: 'remove', path: ['adapters', 'pi'] })
  ]);
  expect(source.value.adapters.pi).toBeUndefined();
});

// collapsing a card revokes disclosed adapter values without removing drafts
test('remasks disclosed Pi environment values when its adapter card collapses', async ({ page }) => {
  const { settings, remasks } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { env: { API_TOKEN: { __racProtected: true, present: true, hasValue: true } } }
  });
  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  const environment = pi.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await environment.getByRole('button', { name: 'Reveal API_TOKEN', exact: true }).click();
  await expect(environment.getByRole('textbox', { name: 'API_TOKEN', exact: true })).toHaveValue('fixture-secret-value');
  await pi.locator('summary').click();
  await expect.poll(() => remasks.length).toBe(1);
  expect(remasks[0]).toEqual({ leaseId: 'adapter-card-lease-1' });
  await expect(settings).not.toContainText('fixture-secret-value');
});

// pending saves keep disclosed cards open until their transaction unlocks
test('locks adapter card collapse during a pending save before remasking normally', async ({ page }) => {
  const { settings, remasks, saves } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { args: ['--fixture'], env: { API_TOKEN: { __racProtected: true, present: true, hasValue: true } } }
  });
  const validationStarted = deferredResponse();
  const validationRelease = deferredResponse();
  // hold validation after the save captures its disclosure boundary
  await page.route('**/api/settings/validate', async route => {
    validationStarted.resolve();
    await validationRelease.promise;
    await route.fulfill({ status: 503, json: { error: 'fixture validation unavailable' } });
  });
  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  const summary = pi.locator('summary');
  const environment = pi.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await environment.getByRole('button', { name: 'Reveal API_TOKEN', exact: true }).click();
  await expect(environment.getByRole('textbox', { name: 'API_TOKEN', exact: true })).toHaveValue('fixture-secret-value');
  await pi.getByLabel('Arg 1', { exact: true }).fill('--draft-value');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await validationStarted.promise;

  await expect(summary).toHaveAttribute('aria-disabled', 'true');
  await summary.click({ force: true });
  await expect(pi).toHaveAttribute('open', '');
  await summary.press('Enter');
  await expect(pi).toHaveAttribute('open', '');
  expect(remasks).toEqual([]);

  validationRelease.resolve();
  await expect(summary).not.toHaveAttribute('aria-disabled', 'true');
  expect(saves).toEqual([]);
  await summary.click();
  await expect(pi).not.toHaveAttribute('open', '');
  await expect.poll(() => remasks.length).toBe(1);
  expect(remasks[0]).toEqual({ leaseId: 'adapter-card-lease-1' });
  await summary.click();
  await expect(pi.getByLabel('Arg 1', { exact: true })).toHaveValue('--draft-value');
});

// sandbox policy lists stay flat while argument ordering remains editable
test('renders Pi sandbox policy as flat non-reorderable lists', async ({ page }) => {
  const { settings } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: {
      args: ['--first', '--second'],
      sandbox: {
        allowedDomains: ['api.example.com', '*.example.net'],
        deniedDomains: ['blocked.example.com'],
        env: ['API_TOKEN']
      }
    }
  });
  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  await expect(pi.getByLabel('Allowed domain 1', { exact: true })).toHaveValue('api.example.com');
  await expect(pi.getByLabel('Allowed domain 2', { exact: true })).toHaveValue('*.example.net');
  await expect(pi.getByLabel('Denied domain 1', { exact: true })).toHaveValue('blocked.example.com');
  await expect(pi.getByLabel('Environment variable 1', { exact: true })).toHaveValue('API_TOKEN');
  await expect(pi.getByRole('button', { name: /Move (?:Allowed|Denied) domains/u })).toHaveCount(0);
  await expect(pi.getByRole('button', { name: /Move Environment variables/u })).toHaveCount(0);
  await expect(pi.getByRole('button', { name: 'Move Args 2 up', exact: true })).toBeEnabled();
});

// the policy switch authors only the optional policy object
test('toggles Pi custom sandbox policy without changing runtime sandbox choices', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { sandbox: { allowedDomains: ['api.example.com'] } }
  });
  const policy = settings.getByRole('switch', { name: 'Pi sandbox policy overrides', exact: true });
  await expect(settings.getByRole('heading', { name: 'Custom sandbox rules', exact: true })).toBeVisible();
  await expect(settings.getByText(/Off uses shared rules/u)).toHaveCount(0);
  await expect(policy).toBeChecked();
  await policy.uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? [])).toEqual([
    expect.objectContaining({ op: 'remove', path: ['adapters', 'pi', 'sandbox'] })
  ]);
  expect(source.value.adapters.pi.sandbox).toBeUndefined();

  // saving reloads the editor with all adapters collapsed
  const adapter = settings.locator('details[data-settings-path="adapters.pi"]');
  await expect(adapter).not.toHaveAttribute('open', '');
  await adapter.locator('summary').click();
  await settings.getByRole('switch', { name: 'Pi sandbox policy overrides', exact: true }).check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(2);
  const second = saves[1]!.changes.flatMap(change => change.patches ?? []);
  expect(second).toEqual([expect.objectContaining({ op: 'set', path: ['adapters', 'pi', 'sandbox'], value: {} })]);
  expect(second.some(patch => patch.path.includes('sandboxed') || patch.path.includes('security'))).toBe(false);
});

// path rules remain visible without a separate permissions toggle
test('keeps every Pi sandbox path placeholder visible without permission checkboxes', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, { conductorEnabled: false, pi: { sandbox: {} } });
  await expect(settings.getByRole('checkbox', { name: /^(?:Allow write|Deny write|Deny read)$/u })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: '+ Add Write path', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '+ Add Denied write path', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '+ Add Denied read path', exact: true })).toBeVisible();

  await settings.getByRole('button', { name: '+ Add Write path', exact: true }).click();
  await settings.getByLabel('Write path 1', { exact: true }).fill('/tmp');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(source.value.adapters.pi.sandbox.allowWrite).toEqual(['/tmp']);
});

// Pi launch environment values use the adapter source and remain editable
test('edits Pi launch environment values separately from sandbox inheritance names', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { env: { HOME: '/home/fixture' }, sandbox: { env: ['API_TOKEN'] } }
  });
  const piEnvironment = settings.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await expect(piEnvironment.getByLabel('HOME', { exact: true })).toBeEnabled();
  await piEnvironment.getByLabel('HOME', { exact: true }).fill('/home/updated');
  await piEnvironment.getByRole('button', { name: 'Add environment variable', exact: true }).click();
  await piEnvironment.getByLabel('Variable', { exact: true }).fill('API_TOKEN');
  await piEnvironment.getByLabel('Value', { exact: true }).fill('fixture-value');
  await piEnvironment.getByRole('button', { name: 'Add variable', exact: true }).click();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.flatMap(change => change.patches ?? []);
  expect(patches).toEqual(expect.arrayContaining([
    expect.objectContaining({ op: 'set', path: ['adapters', 'pi', 'env', 'HOME'], value: '/home/updated' }),
    expect.objectContaining({ op: 'set', path: ['adapters', 'pi', 'env', 'API_TOKEN'], value: 'fixture-value' })
  ]));
  expect(source.value.adapters.pi.env).toEqual({ HOME: '/home/updated', API_TOKEN: 'fixture-value' });
  expect(source.value.adapters.pi.sandbox.env).toEqual(['API_TOKEN']);
});

// every configured adapter exposes one permanent inherited HOME field
test('shows inherited HOME across configured adapters without authoring an override', async ({ page }) => {
  const { settings, saves } = await setupAgentModels(page, {
    conductorEnabled: false,
    expandPi: false,
    adapters: { codex: {}, omx: {}, claude: {}, opencode: {} }
  });
  const adapters = [
    { key: 'codex', label: 'Codex', disabled: false },
    { key: 'omx', label: 'OMX', disabled: false },
    { key: 'claude', label: 'Claude', disabled: false },
    { key: 'pi', label: 'Pi', disabled: false },
    { key: 'opencode', label: 'OpenCode', disabled: true }
  ];
  // inspect each independently collapsed adapter
  for (const adapter of adapters) {
    const card = settings.locator(`details[data-settings-path="adapters.${adapter.key}"]`);
    await card.locator('summary').click();
    const environment = card.getByRole('region', { name: `${adapter.label} Environment & keys`, exact: true });
    const home = environment.getByLabel('HOME', { exact: true });
    await expect(home).toHaveValue('');
    await expect(home).toHaveAttribute('placeholder', 'Inherited from launch user’s home');
    await expect(environment.getByText('Blank uses the launch user’s home.', { exact: true })).toBeVisible();
    await expect(environment.getByRole('button', { name: 'Remove HOME', exact: true })).toHaveCount(0);
    // preserve the unsupported adapter lock
    if (adapter.disabled) await expect(home).toBeDisabled();
    else await expect(home).toBeEnabled();
    await card.locator('summary').click();
  }

  const pi = settings.locator('details[data-settings-path="adapters.pi"]');
  await pi.locator('summary').click();
  const environment = pi.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await environment.getByRole('button', { name: 'Add environment variable', exact: true }).click();
  await environment.getByLabel('Variable', { exact: true }).fill('HOME');
  await environment.getByLabel('Value', { exact: true }).fill('/duplicate');
  await expect(environment.getByRole('button', { name: 'Add variable', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  expect(saves).toEqual([]);
});

// clearing an explicit HOME removes only the override and keeps inheritance visible
test('removes an explicit HOME override while keeping the permanent field', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { env: { HOME: '/home/fixture' } }
  });
  const card = settings.locator('details[data-settings-path="adapters.pi"]');
  const environment = card.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  const home = environment.getByLabel('HOME', { exact: true });
  await expect(home).toHaveValue('/home/fixture');
  await home.fill('/home/updated');
  await expect(home).toHaveValue('/home/updated');
  await home.fill('');
  await expect(home).toHaveValue('');
  await expect(home).toHaveAttribute('placeholder', 'Inherited from launch user’s home');
  await expect(environment.getByRole('button', { name: 'Remove HOME', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? [])).toEqual(expect.arrayContaining([
    expect.objectContaining({ op: 'remove', path: ['adapters', 'pi', 'env'] })
  ]));
  expect(source.value.adapters.pi.env).toBeUndefined();
  // saved settings remount with adapter cards collapsed
  if (await card.getAttribute('open') === null) await card.locator('summary').click();
  await expect(card.getByRole('region', { name: 'Pi Environment & keys', exact: true }).getByLabel('HOME', { exact: true })).toHaveAttribute('placeholder', 'Inherited from launch user’s home');
});

// removing the final authored custom key must not retain an empty env record
test('removes the final custom adapter variable while retaining inherited HOME', async ({ page }) => {
  const { settings, saves, source } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { env: { CUSTOM_PATH: '/fixture/path' } }
  });
  const environment = settings.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await expect(environment.getByRole('button', { name: 'Remove CUSTOM_PATH', exact: true })).toBeEnabled();
  await environment.getByRole('button', { name: 'Remove CUSTOM_PATH', exact: true }).click();
  await expect(environment.getByLabel('HOME', { exact: true })).toBeVisible();
  await expect(environment.getByRole('button', { name: 'Remove HOME', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes.flatMap(change => change.patches ?? [])).toEqual([
    expect.objectContaining({ op: 'remove', path: ['adapters', 'pi', 'env'] })
  ]);
  expect(source.value.adapters.pi.env).toBeUndefined();
});

// read-only adapter settings retain HOME inheritance without exposing mutations
test('locks the permanent HOME field with read-only agent settings', async ({ page }) => {
  const { settings, saves } = await setupAgentModels(page, { conductorEnabled: false, readOnly: true });
  const environment = settings.getByRole('region', { name: 'Pi Environment & keys', exact: true });
  await expect(environment.getByLabel('HOME', { exact: true })).toBeDisabled();
  await expect(environment.getByRole('button', { name: 'Remove HOME', exact: true })).toHaveCount(0);
  await expect(environment.getByRole('button', { name: 'Add environment variable', exact: true })).toBeDisabled();
  expect(saves).toEqual([]);
});

// adapter cards stay contained on the supported mobile viewport
test('keeps adapter cards and Pi sandbox controls inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings } = await setupAgentModels(page, {
    conductorEnabled: false,
    pi: { sandbox: { allowedDomains: ['api.example.com'], allowWrite: ['/tmp'] } }
  });
  const card = settings.locator('details[data-settings-path="adapters.pi"]');
  const bounds = await card.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
  const removeBounds = await card.getByRole('button', { name: 'Remove Pi', exact: true }).boundingBox();
  expect(removeBounds).not.toBeNull();
  expect(removeBounds!.x + removeBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  for (const star of await card.locator('.settings-agent-default-button').all()) {
    const starBounds = await star.boundingBox();
    expect(starBounds).not.toBeNull();
    expect(starBounds!.x + starBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await expect(settings.getByRole('switch', { name: 'Pi sandbox policy overrides', exact: true })).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: /^(?:Allow write|Deny write|Deny read)$/u })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: '+ Add Denied write path', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '+ Add Denied read path', exact: true })).toBeVisible();
});
