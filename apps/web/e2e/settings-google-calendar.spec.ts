import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';
import type { GoogleCalendarSummary, SettingsPatch, SettingsSource, SettingsStatus } from '../src/settings/contracts.js';

type CalendarFixtureState = {
  summary: GoogleCalendarSummary;
  settingsStatus: SettingsStatus;
  mutations: Array<{ path: string; body: Record<string, unknown> }>;
  previews: string[];
  saves: Array<{ changes: Array<{ sourceId: string; patches?: SettingsPatch[] }> }>;
};

// return the generated-shape application source used by the dedicated page
const applicationSource = (): SettingsSource => ({
  id: 'app',
  label: 'Application configuration',
  format: 'json',
  exists: true,
  writable: true,
  protected: false,
  tracked: false,
  revisionId: 'calendar-app-r1',
  apply: 'rac-restart',
  value: {
    name: 'Calendar fixture',
    googleCalendar: {
      enabled: false,
      titleTemplate: '{worktree}',
      startMoment: 'work_started',
      endMoment: 'work_finished'
    }
  },
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', label: 'Server name' },
      googleCalendar: {
        type: 'object',
        label: 'Google Calendar',
        apply: 'rac-restart',
        properties: {
          enabled: { type: 'boolean', default: false, apply: 'rac-restart' },
          titleTemplate: { type: 'string', default: '{worktree}', apply: 'rac-restart' },
          startMoment: { type: 'enum', default: 'work_started', options: ['prompt_submitted', 'prompt_sent', 'work_started'], apply: 'rac-restart' },
          endMoment: { type: 'enum', default: 'work_finished', options: ['first_question_or_finished', 'work_finished'], apply: 'rac-restart' }
        }
      }
    }
  }
});

// return masked credential metadata without exposing fixture secret bytes
const environmentSource = (): SettingsSource => ({
  id: 'env',
  label: 'Environment & keys',
  format: 'env',
  exists: true,
  writable: true,
  protected: true,
  tracked: false,
  revisionId: 'calendar-env-r1',
  apply: 'rac-restart',
  hasProtectedContent: true,
  fields: [
    ['RAC_GOOGLE_CALENDAR_CLIENT_ID', false],
    ['RAC_GOOGLE_CALENDAR_CLIENT_SECRET', false],
    ['RAC_GOOGLE_CALENDAR_TOKEN_KEY', false],
    ['RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY', true]
  ].map(([key, optional]) => ({
    key: String(key),
    protected: true,
    present: optional !== true,
    hasValue: optional !== true,
    apply: 'rac-restart',
    description: optional === true ? 'Previous encryption key used only during rotation.' : 'Private Google Calendar setup value.'
  }))
});

// use the same page destination across desktop and narrow Settings navigation
async function selectSection(settings: Locator, label: string) {
  const selector = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  const name = new RegExp(`^${label}(?:\\s|$)`, 'u');
  // select through the visible navigation surface only
  if (await selector.isVisible()) {
    await selector.click();
    await settings.page().getByRole('listbox', { name: 'Settings section options', exact: true }).getByRole('option', { name }).click();
  } else {
    await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name }).click();
  }
}

// mount Settings with isolated fake Google and source-backed API responses
async function setup(page: Page, width = 1440) {
  await mockAccountSocket(page);
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  await page.addInitScript(() => localStorage.clear());
  const sources = [applicationSource(), environmentSource()];
  const state: CalendarFixtureState = {
    summary: {
      enabled: false,
      available: true,
      connected: true,
      status: 'ready',
      accountEmail: 'calendar-operator@example.test',
      calendars: [{ id: 'calendar-primary', name: 'RAC Agent Work' }, { id: 'calendar-secondary', name: 'RAC Work Log' }],
      selectedCalendarId: 'calendar-primary',
      setup: {
        clientId: true,
        clientSecret: true,
        tokenKey: true,
        redirectUri: 'http://127.0.0.1:4173/api/settings/google-calendar/callback'
      },
      counts: { pending: 2, delivered: 7, failed: 1, suppressed: 3 },
      lastSuccessAt: '2026-10-23T17:00:00.000Z'
    },
    settingsStatus: { pending: false, targets: [], effective: 'known', restartAvailable: true },
    mutations: [],
    previews: [],
    saves: []
  };

  // intercept every application and provider request before navigation
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // expose one authenticated controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'calendar-csrf', active: true, deviceName: 'Calendar fixture', server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    // keep unrelated dashboard data empty
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'calendar-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (path === '/api/settings/status') return route.fulfill({ json: state.settingsStatus });
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, reason: 'fixture', mode: 'unconfigured', enabled: false, tokenPresent: false, serviceUrl: 'http://127.0.0.1:8787' } });
    if (path === '/api/settings/google-calendar/title-preview') {
      const body = request.postDataJSON() as { template: string };
      state.previews.push(body.template);
      return route.fulfill({ json: { title: body.template.replaceAll('{worktree}', 'feature/calendar').replaceAll('{project}', 'remoteagents').replaceAll('{agent}', 'Codex') } });
    }
    if (path === '/api/settings/google-calendar/connect' && request.method() === 'POST') {
      state.mutations.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture' } });
    }
    if (path === '/api/settings/google-calendar/calendars' && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string };
      state.mutations.push({ path, body });
      state.summary.calendars = [...state.summary.calendars, { id: 'calendar-created', name: body.name }];
      return route.fulfill({ json: state.summary });
    }
    if (path === '/api/settings/google-calendar/select' && request.method() === 'POST') {
      const body = request.postDataJSON() as { calendarId: string };
      state.mutations.push({ path, body });
      state.summary.selectedCalendarId = body.calendarId;
      return route.fulfill({ json: state.summary });
    }
    if (path === '/api/settings/google-calendar/retry' && request.method() === 'POST') {
      state.mutations.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      state.summary.counts = { ...state.summary.counts, failed: 0, pending: state.summary.counts.pending + 1 };
      return route.fulfill({ json: state.summary });
    }
    if (path === '/api/settings/google-calendar/disconnect' && request.method() === 'POST') {
      state.mutations.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      state.summary.connected = false;
      state.summary.status = 'setup_required';
      delete state.summary.accountEmail;
      return route.fulfill({ json: state.summary });
    }
    if (path === '/api/settings/google-calendar') return route.fulfill({ json: state.summary });
    if (path === '/api/settings/validate' && request.method() === 'POST') return route.fulfill({ json: { valid: true, issues: [] } });
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as CalendarFixtureState['saves'][number];
      state.saves.push(body);
      state.settingsStatus = { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true };
      return route.fulfill({ json: { version: 1, installationKind: 'compose', revisionId: 'calendar-snapshot-r2', sources, status: state.settingsStatus } });
    }
    if (path === '/api/settings') return route.fulfill({ json: { version: 1, installationKind: 'compose', revisionId: 'calendar-snapshot-r1', sources, status: state.settingsStatus } });
    if (path === '/api/settings/remask') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { error: 'unmocked_fixture_request' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
  await selectSection(settings, 'Google Calendar');
  await expect(settings.getByRole('heading', { name: 'Google Calendar', exact: true })).toBeVisible();
  await expect(settings.getByText('Loading Google Calendar…', { exact: true })).toHaveCount(0);
  return { settings, state };
}

// verify responsive integration grouping, content and defaults
for (const width of [1440, 390]) test(`renders Google Calendar settings safely at ${width}px`, async ({ page }) => {
  const { settings } = await setup(page, width);
  // keep both integration pages together in desktop and mobile navigation
  if (width >= 600) {
    const navigation = settings.getByRole('navigation', { name: 'Settings sources' });
    await expect(navigation.getByRole('heading', { level: 3 })).toHaveText(['Console', 'Application', 'Integrations', 'Deployment', 'Environment']);
    await expect(navigation.getByRole('button', { name: 'Agents', exact: true }).locator('xpath=preceding-sibling::h3[1]')).toHaveText('Integrations');
    await expect(navigation.getByRole('button', { name: 'Google Calendar', exact: true }).locator('xpath=preceding-sibling::h3[1]')).toHaveText('Integrations');
  } else {
    await settings.getByRole('combobox', { name: 'Settings section', exact: true }).click();
    const options = page.getByRole('listbox', { name: 'Settings section options', exact: true });
    await expect(options.getByRole('group', { name: 'Integrations', exact: true }).getByRole('option')).toHaveText(['Agents', 'Google Calendar']);
    await expect(options.getByRole('group', { name: 'Application', exact: true }).getByRole('option', { name: /^(Agents|Google Calendar)$/u })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  await expect(settings.getByText('Server settings', { exact: true })).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Enable Google Calendar', exact: true })).not.toBeChecked();
  await expect(settings.getByRole('textbox', { name: 'Event title template', exact: true })).toHaveValue('{worktree}');
  await expect(settings.getByRole('combobox', { name: 'Start moment', exact: true })).toContainText('Agent work started');
  await expect(settings.getByRole('switch', { name: 'End moment', exact: true })).toHaveAttribute('data-value', 'work_finished');
  await expect(settings.getByRole('status', { name: 'Event title preview', exact: true })).toContainText('feature/calendar');
  await expect(settings.getByText('{worktree}', { exact: true })).toHaveCount(1);
  await expect(settings.getByText('{project}', { exact: true })).toHaveCount(1);
  await expect(settings.getByText('{agent}', { exact: true })).toHaveCount(1);
  await expect(settings.getByLabel('RAC_GOOGLE_CALENDAR_CLIENT_SECRET masked', { exact: true })).toContainText('••••••••');
  await expect(settings.getByText('<kid>:<key>', { exact: true })).toBeVisible();
  await expect(settings.getByText(/seven days/u)).toBeVisible();
  await expect(settings.getByText(/Timely/iu)).toHaveCount(0);
  await expect(settings.getByText(/offset/iu)).toHaveCount(0);
  const account = settings.locator('section[aria-label="Google Calendar account"]');
  const disclosure = account.getByRole('note', { name: 'Google Calendar data disclosure', exact: true });
  await expect(disclosure).toContainText('receives your Google account ID and email');
  await expect(disclosure).toContainText('stores encrypted access and refresh tokens');
  await expect(disclosure).toContainText('only to create and manage RAC-created calendars and events');
  await expect(disclosure).toContainText('configured titles and work start and end times, not prompts or responses');
  await expect(disclosure).toContainText('not used for AI training');
  await expect(disclosure.getByRole('link', { name: 'Privacy Policy', exact: true })).toHaveAttribute('href', '/privacy');
  await expect(disclosure.getByRole('link', { name: 'Terms of Service', exact: true })).toHaveAttribute('href', '/terms');
  await expect(account.locator('.settings-google-calendar-evidence + .settings-google-calendar-actions')).toHaveCount(1);
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('uses shared save validation and blocks live actions while any draft is dirty', async ({ page }) => {
  const { settings, state } = await setup(page);
  const template = settings.getByRole('textbox', { name: 'Event title template', exact: true });
  await template.fill('{prompt}');
  await expect(settings.getByText('Unsupported placeholder {prompt}.', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Reconnect Google account', exact: true })).toBeDisabled();
  await template.fill('{project} · {agent}');
  await expect(settings.getByRole('status', { name: 'Event title preview', exact: true })).toContainText('remoteagents · Codex');
  await expect(settings.getByText('hostile prompt fixture', { exact: false })).toHaveCount(0);
  await settings.getByRole('combobox', { name: 'Start moment', exact: true }).click();
  await page.getByRole('listbox', { name: 'Start moment options', exact: true }).getByRole('option', { name: 'Prompt submitted (includes queue wait)', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = state.saves[0]!.changes.find(change => change.sourceId === 'app')?.patches ?? [];
  expect(patches).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['googleCalendar', 'titleTemplate'], value: '{project} · {agent}' }),
    expect.objectContaining({ path: ['googleCalendar', 'startMoment'], value: 'prompt_submitted' })
  ]));
  await expect(page.getByText('Restart pending', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Reconnect Google account', exact: true })).toBeEnabled();
});

test('creates, selects, retries, and disconnects through explicit live actions', async ({ page }) => {
  const { settings, state } = await setup(page);
  await expect(settings.getByRole('textbox', { name: 'New calendar name', exact: true })).toHaveValue('RAC Agent Work');
  await settings.getByRole('textbox', { name: 'New calendar name', exact: true }).fill('RAC Agent Sessions');
  await settings.getByRole('button', { name: 'Create calendar', exact: true }).click();
  await expect.poll(() => state.mutations.at(-1)).toEqual({ path: '/api/settings/google-calendar/calendars', body: { name: 'RAC Agent Sessions' } });

  const selector = settings.getByRole('combobox', { name: 'RAC-created calendar', exact: true });
  await selector.click();
  await page.getByRole('listbox', { name: 'RAC-created calendar options', exact: true }).getByRole('option', { name: 'RAC Work Log', exact: true }).click();
  await settings.getByRole('button', { name: 'Use selected calendar', exact: true }).click();
  await expect.poll(() => state.mutations.at(-1)).toEqual({ path: '/api/settings/google-calendar/select', body: { calendarId: 'calendar-secondary' } });

  await settings.getByRole('button', { name: 'Retry failed deliveries', exact: true }).click();
  await expect.poll(() => state.mutations.at(-1)?.path).toBe('/api/settings/google-calendar/retry');
  await expect(settings.getByText('Failed', { exact: true }).locator('..').getByRole('definition')).toHaveText('0');

  await settings.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const confirmation = settings.getByRole('alertdialog', { name: 'Disconnect Google Calendar?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => state.mutations.at(-1)?.path).toBe('/api/settings/google-calendar/disconnect');
  await expect(settings.getByRole('button', { name: 'Connect Google account', exact: true })).toBeVisible();
});

test('explains degraded lifecycle, unknown-create, and revoked-auth states without color alone', async ({ page }) => {
  const { settings, state } = await setup(page);
  state.summary.status = 'degraded';
  state.summary.lastError = 'unsupported_lifecycle_contract';
  await settings.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('suppressed instead of using guessed times');

  state.summary.status = 'ready';
  state.summary.lastError = 'calendar_create_outcome_unknown';
  await settings.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('RAC could not prove its ID');

  state.summary.lastError = 'authorization_required';
  await settings.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Reconnect the Google account');
  await expect(settings.getByText('Failed', { exact: true }).locator('..').getByRole('definition')).toHaveText('1');
});

test('starts OAuth with a top-level Google navigation and no popup dependency', async ({ page }) => {
  const { settings, state } = await setup(page);
  await page.route('https://accounts.google.com/**', route => route.abort());
  await settings.getByRole('button', { name: 'Reconnect Google account', exact: true }).click();
  await expect.poll(() => state.mutations.at(-1)).toEqual({ path: '/api/settings/google-calendar/connect', body: {} });
});
