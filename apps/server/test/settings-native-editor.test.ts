import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { SettingsError } from '../src/settings/contracts.js';
import type { Place } from '../src/places/places.js';
import { testConfig } from './helpers/config.js';

const apps: FastifyInstance[] = [];
const place: Place = { id: 'scratch:/home/operator', kind: 'scratch', projectId: 'scratch', label: '~ Operator', home: '/home/operator' };
const host = 'agents.example.com';
const cookie = '__Host-rac=signed';
const headers = { host, origin: `https://${host}`, cookie, 'x-csrf-token': 'csrf' };

// close every isolated server fixture
afterEach(async () => {
  // release servers created by the current test
  for (const app of apps.splice(0)) await app.close();
});

// provide the settings methods registered by buildApp plus native path resolution
function settingsDouble(editorFile = vi.fn(async () => "/srv/rac/config/operator's.yaml")) {
  return {
    snapshot: vi.fn(async () => ({ version: 1 as const, revisionId: 'snapshot', sources: [], status: { pending: false, targets: [], effective: 'known' as const, restartAvailable: true } })),
    status: vi.fn(async () => ({ pending: false, targets: [], effective: 'known' as const, restartAvailable: true })),
    validate: vi.fn(async () => ({ valid: true, issues: [] })),
    save: vi.fn(),
    reveal: vi.fn(),
    remask: vi.fn(),
    restart: vi.fn(),
    operation: vi.fn(),
    updateApplication: vi.fn(),
    editorFile
  };
}

// build one authenticated Place route with narrow launch and discovery doubles
async function start(options: { editor?: string | false; settings?: ReturnType<typeof settingsDouble>; connect?: () => boolean; place?: Place | false } = {}) {
  const createConsoleShell = vi.fn(async () => '%9');
  const settings = options.settings ?? settingsDouble();
  const selectedPlace = options.place === undefined ? place : options.place || undefined;
  const app = await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), ...(options.editor === false ? {} : { editor: options.editor ?? '/usr/bin/nvim -p' }) }), {
    auth: { unsign: (value?: string) => value === 'signed' ? { id: 'session', csrf: 'csrf' } : undefined, get: (session: unknown) => session, csrf: (_session: unknown, value?: string) => value === 'csrf' } as never,
    control: { connect: options.connect ?? (() => true), ownerSessionId: () => 'session' } as never,
    discovery: { worktreesNow: () => [], invalidateWorktrees: () => {}, dashboard: async () => ({ generation: 1, adapters: {}, agents: [], projects: [], places: selectedPlace === undefined ? [] : [selectedPlace] }), place: async (id: string) => selectedPlace?.id === id ? selectedPlace : undefined, target: async () => undefined } as never,
    launch: { createConsoleShell, launchResolutions: async () => new Map(), consoleShellBusy: () => false } as never,
    dashboardUpdates: { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never,
    settings: settings as never
  });
  apps.push(app);
  return { app, createConsoleShell, settings };
}

const url = `/api/worktrees/${encodeURIComponent(place.id)}/shells`;
const selection = { editor: true, settingsSource: { sourceId: 'compose', revisionId: 'opaque-revision' } };

describe('settings native editor launch', () => {
  // launch the configured terminal editor with the service-resolved host path
  it('quotes the fixed host path and never accepts one from the browser', async () => {
    const fixture = await start({ editor: '/usr/bin/nvim -p' });

    const response = await fixture.app.inject({ method: 'POST', url, headers, payload: selection });

    expect(response.statusCode).toBe(201);
    expect(fixture.settings.editorFile).toHaveBeenCalledWith('compose', 'opaque-revision');
    expect(fixture.createConsoleShell).toHaveBeenCalledWith(place, 'nvim', "/usr/bin/nvim -p '/srv/rac/config/operator'\\''s.yaml'");
  });

  // require the established controller mutation boundary before source resolution
  it('requires authentication, origin, csrf, a configured editor, and a valid Place', async () => {
    const fixture = await start();
    const anonymous = await fixture.app.inject({ method: 'POST', url, headers: { host, origin: `https://${host}`, 'x-csrf-token': 'csrf' }, payload: selection });
    const noOrigin = await fixture.app.inject({ method: 'POST', url, headers: { host, cookie, 'x-csrf-token': 'csrf' }, payload: selection });
    const noCsrf = await fixture.app.inject({ method: 'POST', url, headers: { host, origin: `https://${host}`, cookie }, payload: selection });
    expect([anonymous.statusCode, noOrigin.statusCode, noCsrf.statusCode]).toEqual([401, 403, 403]);
    expect(fixture.settings.editorFile).not.toHaveBeenCalled();

    const noEditor = await start({ editor: false });
    expect((await noEditor.app.inject({ method: 'POST', url, headers, payload: selection })).json()).toEqual({ error: 'no editor is configured' });
    expect(noEditor.settings.editorFile).not.toHaveBeenCalled();

    const missingPlace = await start({ place: false });
    expect((await missingPlace.app.inject({ method: 'POST', url, headers, payload: selection })).statusCode).toBe(404);
    expect(missingPlace.settings.editorFile).not.toHaveBeenCalled();
  });

  // reject malformed and mixed target authority before settings resolution
  it('accepts only the exact bounded source selection shape', async () => {
    const fixture = await start();
    const rejected = [
      { editor: false, settingsSource: selection.settingsSource },
      { editor: true, settingsSource: { ...selection.settingsSource, path: '/etc/shadow' } },
      { editor: true, settingsSource: { sourceId: '', revisionId: 'revision' } },
      { editor: true, settingsSource: { sourceId: 'app', revisionId: 'x'.repeat(129) } },
      { editor: true, settingsSource: selection.settingsSource, file: 'config.json' },
      { editor: true, settingsSource: selection.settingsSource, line: 4 },
      { editor: true, settingsSource: selection.settingsSource, objectToken: 'opaque-file' },
      { editor: true, settingsSource: selection.settingsSource, binding: { table: 'root', key: 'e' } }
    ];
    // prove every rejected authority combination launches nothing
    for (const payload of rejected) expect((await fixture.app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
    expect(fixture.settings.editorFile).not.toHaveBeenCalled();
    expect(fixture.createConsoleShell).not.toHaveBeenCalled();
  });

  // preserve bounded settings error codes without launching a shell
  it.each([
    ['unknown source', new SettingsError('settings_source_unavailable', 404), 404, 'settings_source_unavailable'],
    ['missing source', new SettingsError('settings_source_unavailable', 404), 404, 'settings_source_unavailable'],
    ['stale revision', new SettingsError('settings_conflict', 409), 409, 'settings_conflict'],
    ['uninstalled applier', new SettingsError('settings_applier_unavailable', 503), 503, 'settings_applier_unavailable']
  ])('rejects %s safely', async (_label, failure, statusCode, code) => {
    const editorFile = vi.fn(async () => { throw failure; });
    const fixture = await start({ settings: settingsDouble(editorFile) });

    const response = await fixture.app.inject({ method: 'POST', url, headers, payload: selection });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: code });
    expect(fixture.createConsoleShell).not.toHaveBeenCalled();
  });

  // re-check controller ownership after asynchronous source inspection
  it('does not launch after a controller takeover during resolution', async () => {
    let finish: (() => void) | undefined;
    const editorFile = vi.fn(async () => await new Promise<string>(resolve => { finish = () => resolve('/srv/rac/config/app.json'); }));
    let controls = 0;
    const fixture = await start({ settings: settingsDouble(editorFile), connect: () => ++controls === 1 });
    const pending = fixture.app.inject({ method: 'POST', url, headers, payload: selection });
    await vi.waitFor(() => expect(editorFile).toHaveBeenCalled());
    finish!();

    const response = await pending;

    expect(response.statusCode).toBe(423);
    expect(response.json()).toEqual({ error: 'another client is active' });
    expect(fixture.createConsoleShell).not.toHaveBeenCalled();
  });
});
