import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/auth/service.js';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { registerGoogleCalendarRoutes } from '../src/google-calendar/routes.js';
import type { GoogleCalendarService } from '../src/google-calendar/service.js';
import { GoogleCalendarError } from '../src/google-calendar/provider-types.js';
import type { GoogleAuthState } from '../src/google-calendar/provider-types.js';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import { AuthStore } from '../src/google-calendar/store.js';
import { tempDir } from './helpers/codex-fixtures.js';

const apps: ReturnType<typeof Fastify>[] = [];
const summary = { enabled: true, available: true, connected: false, status: 'setup_required' as const, calendars: [], setup: { clientId: true, clientSecret: true, tokenKey: true, redirectUri: 'https://agents.example.com/api/settings/google-calendar/oauth/callback' }, counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 } };

afterEach(async () => {
  // close each isolated route fixture
  for (const app of apps.splice(0)) await app.close();
});

// build one secret-free service fixture
function fixture(): GoogleCalendarService {
  return {
    summary: () => summary,
    admit: async () => false,
    signal: async () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    beginConnect: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?state=secret-state'),
    completeConnect: vi.fn(async () => undefined),
    createCalendar: vi.fn(async () => summary),
    selectCalendar: vi.fn(async () => summary),
    disconnect: vi.fn(async () => summary),
    retry: vi.fn(async () => summary),
    preview: vi.fn(() => 'Cora'),
    dispatch: async () => undefined
  };
}

// cover browser auth and callback redaction
describe('Google Calendar settings API', () => {
  // the connection registry alone authorizes later calendar selection
  it('persists app-created calendars and rejects foreign ids after restart', async () => {
    const directory = await tempDir('rac-google-calendar-registry-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3_600_000 }, calendars: [] };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'created-calendar' }), { status: 200 }));
    const options: Parameters<typeof createGoogleCalendarService>[0] = { config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch };
    const authority = { sessionId: 'session', reservationGeneration: 'generation', reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true };
    const service = await createGoogleCalendarService(options);
    await service.createCalendar('RAC Work', authority);
    expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.calendars).toEqual([{ id: 'created-calendar', name: 'RAC Work' }]);
    expect(await readFile(authPath, 'utf8')).not.toMatch(/created-calendar|access-secret|refresh-secret/);
    await service.selectCalendar('created-calendar', authority);
    const restarted = await createGoogleCalendarService(options);
    expect(restarted.summary()).toMatchObject({ status: 'ready', selectedCalendarId: 'created-calendar', calendars: [{ id: 'created-calendar', name: 'RAC Work' }] });
    const before = await readFile(authPath, 'utf8');
    await expect(restarted.selectCalendar('foreign-calendar', authority)).rejects.toMatchObject({ code: 'calendar_not_available' });
    expect(await readFile(authPath, 'utf8')).toBe(before);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  // require controller and csrf for every mutation
  it('protects mutations and validates exact request bodies', async () => {
    const app = Fastify();
    apps.push(app);
    const service = fixture();
    const controlled = (request: FastifyRequest, mutation = false): Session => {
      // require one authenticated cookie
      if (request.headers.cookie !== 'session=yes') throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      // require csrf on mutation paths
      if (mutation && request.headers['x-csrf-token'] !== 'csrf') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      return { id: 'session', csrf: 'csrf' };
    };
    await registerGoogleCalendarRoutes(app, { service, session: controlled, controlled, reservationGeneration: () => 'generation', renewReservation: () => true, isSessionValid: () => true });
    const denied = await app.inject({ method: 'POST', url: '/api/settings/google-calendar/connect', headers: { cookie: 'session=yes' }, payload: {} });
    expect(denied.statusCode).toBe(403);
    const connected = await app.inject({ method: 'POST', url: '/api/settings/google-calendar/connect', headers: { cookie: 'session=yes', 'x-csrf-token': 'csrf' }, payload: {} });
    expect(connected.json()).toEqual({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=secret-state' });
    const unknown = await app.inject({ method: 'POST', url: '/api/settings/google-calendar/select', headers: { cookie: 'session=yes', 'x-csrf-token': 'csrf' }, payload: { calendarId: 'one', extra: true } });
    expect(unknown).toMatchObject({ statusCode: 400 });
  });

  // redirect every callback without reflecting code, state, or provider failure
  it('contains callback material and redirects to settings', async () => {
    const app = Fastify();
    apps.push(app);
    const service = fixture();
    service.completeConnect = vi.fn(async () => { throw new Error('access-token code-value state-value'); });
    const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => 'generation', renewReservation: () => true, isSessionValid: () => true });
    const response = await app.inject({ method: 'GET', url: '/api/settings/google-calendar/oauth/callback?code=code-value&state=state-value' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/#settings');
    expect(response.body).not.toMatch(/code-value|state-value|access-token/u);
  });

  // consume one-time oauth state even when request authentication fails first
  it('prevents callback replay after an invalid session cookie', async () => {
    const directory = await tempDir('rac-google-calendar-api-');
    const fetcher = vi.fn();
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: fetcher as unknown as typeof fetch });
    const authorization = new URL(service.beginConnect('session', 'generation'));
    const state = authorization.searchParams.get('state')!;
    const app = Fastify();
    apps.push(app);
    const authenticated = (request: FastifyRequest): Session => {
      // accept only the second callback cookie
      if (request.headers.cookie !== 'session=valid') throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      return { id: 'session', csrf: 'csrf' };
    };
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => 'generation', renewReservation: () => true, isSessionValid: () => true });
    const denied = await app.inject({ method: 'GET', url: `/api/settings/google-calendar/oauth/callback?code=code&state=${encodeURIComponent(state)}`, headers: { cookie: 'session=invalid' } });
    expect(denied).toMatchObject({ statusCode: 302, headers: { location: '/#settings' } });
    const replay = await app.inject({ method: 'GET', url: `/api/settings/google-calendar/oauth/callback?code=code&state=${encodeURIComponent(state)}`, headers: { cookie: 'session=valid' } });
    expect(replay).toMatchObject({ statusCode: 302, headers: { location: '/#settings' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  // refuse registry publication when controller authority changes during create
  it('does not publish a held calendar create after controller takeover', async () => {
    const directory = await tempDir('rac-google-calendar-api-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [] };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => await held);
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const app = Fastify();
    apps.push(app);
    let generation = 'old';
    const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => generation, renewReservation: (_session, expected) => generation === expected, isSessionValid: () => true });
    const request = app.inject({ method: 'POST', url: '/api/settings/google-calendar/calendars', headers: { 'x-csrf-token': 'csrf' }, payload: { name: 'RAC Work' } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    generation = 'new';
    release(new Response(JSON.stringify({ id: 'orphan-calendar', summary: 'RAC Work' }), { status: 200 }));
    const response = await request;
    expect(response).toMatchObject({ statusCode: 503 });
    expect(response.json()).toEqual({ error: 'calendar_create_outcome_unknown' });
    expect(service.summary().calendars).toEqual([]);
    const stored = await new AuthStore(authPath, parseTokenKey(keyText)).load();
    expect(stored?.calendars).toEqual([]);
  });

  // refuse selection publication when takeover occurs during encrypted staging
  it('does not publish a held calendar selection after controller takeover', async () => {
    const directory = await tempDir('rac-google-calendar-api-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: vi.fn() as unknown as typeof fetch });
    let release!: () => void;
    let staged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { staged = resolve; });
    const originalStage = AuthStore.prototype.stage;
    const stageSpy = vi.spyOn(AuthStore.prototype, 'stage').mockImplementation(async function (next, suffix) {
      const path = await originalStage.call(this, next, suffix);
      staged();
      await gate;
      return path;
    });
    try {
      const app = Fastify();
      apps.push(app);
      let generation = 'old';
      const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
      await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => generation, renewReservation: (_session, expected) => generation === expected, isSessionValid: () => true });
      const request = app.inject({ method: 'POST', url: '/api/settings/google-calendar/select', headers: { 'x-csrf-token': 'csrf' }, payload: { calendarId: 'two' } });
      await entered;
      generation = 'new';
      release();
      const response = await request;
      expect(response.statusCode).toBe(403);
      expect(service.summary().selectedCalendarId).toBe('one');
      expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.selectedCalendarId).toBe('one');
    } finally {
      stageSpy.mockRestore();
    }
  });

  // refuse local disconnect publication when logout occurs during revocation
  it('does not publish a held disconnect after session logout', async () => {
    const directory = await tempDir('rac-google-calendar-api-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'one', name: 'One' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => await held);
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const app = Fastify();
    apps.push(app);
    let valid = true;
    const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => 'generation', renewReservation: () => valid, isSessionValid: () => valid });
    const request = app.inject({ method: 'POST', url: '/api/settings/google-calendar/disconnect', headers: { 'x-csrf-token': 'csrf' }, payload: {} });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    valid = false;
    release(new Response('', { status: 200 }));
    const response = await request;
    expect(response.statusCode).toBe(403);
    expect(service.summary().connected).toBe(true);
    expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.disconnected).not.toBe(true);
  });

  // reject retry publication when the final controller renewal fails
  it('fences retry release after its filesystem await', async () => {
    const directory = await tempDir('rac-google-calendar-api-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'one', name: 'One' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: vi.fn() as unknown as typeof fetch });
    const app = Fastify();
    apps.push(app);
    let renewals = 0;
    const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => 'generation', renewReservation: () => ++renewals === 1, isSessionValid: () => true });
    const response = await app.inject({ method: 'POST', url: '/api/settings/google-calendar/retry', headers: { 'x-csrf-token': 'csrf' }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(renewals).toBe(2);
  });

  // preserve bounded provider codes for settings recovery actions
  it('returns provider codes without upstream details', async () => {
    const app = Fastify();
    apps.push(app);
    const service = fixture();
    service.createCalendar = vi.fn(async () => { throw new GoogleCalendarError('calendar_create_outcome_unknown', 503); });
    const authenticated = (): Session => ({ id: 'session', csrf: 'csrf' });
    await registerGoogleCalendarRoutes(app, { service, session: authenticated, controlled: authenticated, reservationGeneration: () => 'generation', renewReservation: () => true, isSessionValid: () => true });
    const response = await app.inject({ method: 'POST', url: '/api/settings/google-calendar/calendars', payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'calendar_create_outcome_unknown' });
  });
});
