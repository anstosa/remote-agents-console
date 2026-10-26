import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import { AuthStore } from '../src/google-calendar/store.js';
import type { GoogleAuthState } from '../src/google-calendar/provider-types.js';
import { buildApp } from '../src/app.js';
import { tempDir } from './helpers/codex-fixtures.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

const config = { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started' as const, endMoment: 'work_finished' as const };

afterEach(() => {
  // restore isolated runtime credential overrides
  vi.unstubAllEnvs();
});

// cover optional-provider boot isolation
describe('Google Calendar runtime boot', () => {
  // degrade safely for every missing runtime credential
  it.each([
    [{}, 'client_id_missing'],
    [{ RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client' }, 'client_secret_missing'],
    [{ RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret' }, 'token_key_invalid'],
    [{ RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: 'bad' }, 'token_key_invalid']
  ])('stays inert for malformed environment %#', async (env, reason) => {
    const directory = await tempDir('rac-google-calendar-');
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json') });
    expect(service.summary()).toMatchObject({ enabled: true, available: false, status: 'degraded', lastError: reason });
    await expect(service.admit({ id: 'activity', agentId: 'agent', kind: 'codex', submittedAt: new Date().toISOString(), labels: { worktree: 'Cora', agent: 'Codex' } })).resolves.toBe(false);
  });

  // avoid reading or creating private files when source configuration is disabled
  it('keeps disabled builds file-free', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const authPath = join(directory, 'nested', 'auth.json');
    const service = await createGoogleCalendarService({ config: { ...config, enabled: false }, publicOrigin: 'https://agents.example.com', env: {}, authPath, activitiesPath: join(directory, 'nested', 'activities.json') });
    expect(service.summary().status).toBe('disabled');
    expect(service.preview('{worktree} {agent}')).toBe('Cora Codex');
    await expect(access(join(directory, 'nested'))).rejects.toThrow();
  });

  // accept the documented empty optional rotation variable
  it('treats a blank previous key as absent', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}`, RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY: '' }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json') });
    expect(service.summary()).toMatchObject({ available: true, status: 'setup_required', setup: { clientId: true, clientSecret: true, tokenKey: true } });
  });

  // contain corrupt provider state behind the optional boot boundary
  it('degrades on corrupt private authorization state', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const authPath = join(directory, 'auth.json');
    await writeFile(authPath, '{not-json', { mode: 0o600 });
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath, activitiesPath: join(directory, 'activities.json') });
    expect(service.summary()).toMatchObject({ available: false, status: 'degraded', lastError: 'auth_store_invalid' });
  });

  // require reconnect after oauth client replacement
  it('discards authorization issued to a different oauth client', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const authPath = join(directory, 'auth.json');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const old: GoogleAuthState = { version: 1, clientId: 'old-client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 }, calendars: [{ id: 'old-calendar', name: 'Old' }], selectedCalendarId: 'old-calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(old);
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'new-client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json') });
    expect(service.summary()).toMatchObject({ available: true, connected: false, status: 'setup_required', calendars: [], lastError: 'oauth_client_changed' });
    await expect(access(authPath)).rejects.toThrow();
  });

  // keep the real server healthy when optional runtime credentials are absent
  it('keeps buildApp healthy with an inert enabled provider', async () => {
    vi.stubEnv('RAC_GOOGLE_CALENDAR_CLIENT_ID', '');
    vi.stubEnv('RAC_GOOGLE_CALENDAR_CLIENT_SECRET', '');
    vi.stubEnv('RAC_GOOGLE_CALENDAR_TOKEN_KEY', '');
    const app = await buildApp(testConfig({ googleCalendar: config }), { auth: await testAuthService() });
    try {
      const health = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'agents.example.com' } });
      expect(health.statusCode).toBe(200);
      const headers = await authenticatedHeaders(app);
      const status = await app.inject({ method: 'GET', url: '/api/settings/google-calendar', headers });
      expect(status).toMatchObject({ statusCode: 200 });
      expect(status.json()).toMatchObject({ enabled: true, available: false, status: 'degraded', lastError: 'client_id_missing' });
    } finally {
      await app.close();
    }
  }, 15_000);
});
