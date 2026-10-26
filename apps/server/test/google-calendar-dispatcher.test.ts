import { calendarEventIdentity } from '../src/google-calendar/event-identity.js';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import { ActivityStore, AuthStore } from '../src/google-calendar/store.js';
import type { CalendarActivity, GoogleAuthState } from '../src/google-calendar/provider-types.js';
import type { OperationAuthority } from '../src/google-calendar/service.js';
import { tempDir } from './helpers/codex-fixtures.js';

// grant one stable controller authority to direct service tests
function authority(): OperationAuthority {
  return { sessionId: 'session', reservationGeneration: 'generation', reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true };
}

// sign one synthetic oidc identity for reconnect races
function idToken(clientId: string, nonce: string, subject: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: subject, email: `${subject}@example.com`, nonce, exp: Math.floor(Date.now() / 1_000) + 600 })).toString('base64url');
  return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url')}`;
}

// build one internally consistent ready outbox record
function readyActivity(id: string, targetId: string, now: number): CalendarActivity {
  const target = { id: targetId, name: targetId };
  return { version: 1, id, agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' }, policy: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, target, principalSub: 'subject', status: 'ready', startedAt: '2026-10-23T17:01:00.000Z', finishedAt: '2026-10-23T17:02:00.000Z', startAt: '2026-10-23T17:01:00.000Z', endAt: '2026-10-23T17:02:00.000Z', summary: 'Cora', ...calendarEventIdentity(target.id, id), attempts: 0, nextAttemptAt: now };
}

// cover the completed-event outbox and immutable policy snapshot
describe('Google Calendar dispatcher', () => {
  // concurrent worker entry must not duplicate a held external delivery
  it('serializes concurrent dispatch calls for one durable activity', async () => {
    const directory = await tempDir('rac-google-calendar-overlap-');
    const key = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const now = 100_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: now + 3_600_000 }, calendars: [{ id: 'one', name: 'one' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(key)).save(auth);
    const activity = readyActivity('concurrent', 'one', 0);
    await new ActivityStore(activitiesPath, () => now).add(activity);
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => await held);
    const service = await createGoogleCalendarService({ config: activity.policy, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath, fetch: fetcher as typeof fetch, now: () => now });
    const first = service.dispatch();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    try {
      await service.dispatch();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      release(new Response(JSON.stringify({ id: activity.eventId }), { status: 200 }));
      await first;
    }
    await service.dispatch();
    const reloaded = new ActivityStore(activitiesPath, () => now);
    await reloaded.load();
    expect(reloaded.get('concurrent')).toMatchObject({ status: 'delivered', attempts: 1, completedAt: now });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  // persist a refreshed grant before delivery and stop durably on revoked refresh grants
  it.each([200, 400, 401])('handles expired access credentials with refresh response %s', async status => {
    const directory = await tempDir('rac-google-calendar-refresh-');
    const key = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const now = 100_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'expired', refreshToken: 'refresh-secret', expiresAt: 1 }, calendars: [{ id: 'one', name: 'one' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(key)).save(auth);
    await new ActivityStore(activitiesPath, () => now).add(readyActivity('refresh', 'one', 0));
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      // keep refresh classification distinct from event delivery classification
      if (String(input).includes('/token')) return new Response(JSON.stringify(status === 200 ? { access_token: 'replacement', expires_in: 3600 } : { error: 'invalid_grant' }), { status });
      const persisted = await new AuthStore(authPath, parseTokenKey(key)).load();
      expect(persisted?.tokens).toEqual({ accessToken: 'replacement', refreshToken: 'refresh-secret', expiresAt: now + 3_600_000 });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer replacement' });
      return new Response(JSON.stringify({ id: JSON.parse(String(init?.body)).id }), { status: 200 });
    });
    const service = await createGoogleCalendarService({ config: readyActivity('refresh', 'one', 0).policy, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath, fetch: fetcher as typeof fetch, now: () => now });
    await service.dispatch();
    await service.dispatch();
    const reloaded = new ActivityStore(activitiesPath, () => now);
    await reloaded.load();
    expect(reloaded.get('refresh')).toMatchObject({ status: status === 200 ? 'delivered' : 'authorization_required', completedAt: now, attempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(status === 200 ? 2 : 1);
  });
  // retain provider terminal state durably instead of acknowledging or endlessly retrying it
  it.each([[401, 'authorization_required'], [404, 'target_missing']] as const)('persists terminal status %s as %s across restart', async (status, expected) => {
    const directory = await tempDir('rac-google-calendar-');
    const key = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const now = 100_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: now + 3_600_000 }, calendars: [{ id: 'one', name: 'one' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(key)).save(auth);
    await new ActivityStore(activitiesPath, () => now).add(readyActivity('terminal', 'one', 0));
    const fetcher = vi.fn(async () => new Response('{}', { status }));
    const service = await createGoogleCalendarService({ config: readyActivity('terminal', 'one', 0).policy, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath, fetch: fetcher as typeof fetch, now: () => now });
    await service.dispatch();
    await service.dispatch();
    const reloaded = new ActivityStore(activitiesPath, () => now);
    await reloaded.load();
    expect(reloaded.get('terminal')).toMatchObject({ status: expected, completedAt: now, attempts: 1, lastError: expected });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(service.summary().counts.failed).toBe(1);
  });
  // deliver one final event after exact start and matching finish
  it('persists and delivers one stable completed event', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(join(directory, 'auth.json'), parseTokenKey(keyText)).save(auth);
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    });
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree} {agent}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    expect(await service.admit({ id: 'activity', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Admission', agent: 'hostile pane title' } })).toBe(true);
    await service.signal({ id: 'activity', type: 'started', at: '2026-10-23T17:10:00.000Z', labels: { worktree: 'Cora', agent: 'secret conversation content' } });
    await service.signal({ id: 'activity', type: 'finished', at: '2026-10-23T17:15:00.000Z' });
    await vi.waitFor(() => expect(service.summary().counts.delivered).toBe(1));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(bodies[0]).toMatchObject({ summary: 'Cora Agent', start: { dateTime: '2026-10-23T17:10:00.000Z' }, end: { dateTime: '2026-10-23T17:15:00.000Z' } });
    expect((bodies[0] as { id: string }).id).toMatch(/^[0-9a-f]{52}$/u);
    // lock the persisted v1 namespaces and encodings independently of implementation helpers
    expect(bodies[0]).toMatchObject({ id: '9e55f65f0887a1408813d6ed296aef0b985130f3e49737bd448f', extendedProperties: { private: { racActivity: 'WYJ2kOu3G_mtQZ9J7xoGWlzlViGi__WUsjlju1P8YSA' } } });
  });

  // suppress disconnected admission permanently rather than backfilling it
  it('keeps no-target admission suppressed after later setup', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: vi.fn() as unknown as typeof fetch });
    expect(await service.admit({ id: 'no-target', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' } })).toBe(false);
    expect(service.summary().counts.suppressed).toBe(1);
  });

  // expose the newest bounded durable lifecycle failure after restart
  it('publishes unsupported and capture-store evidence reasons in status', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    let now = 1_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: 10_000_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const options = { config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started' as const, endMoment: 'work_finished' as const }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: vi.fn() as unknown as typeof fetch, now: () => now };
    const service = await createGoogleCalendarService(options);
    await service.admit({ id: 'unsupported', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' } });
    await service.signal({ id: 'unsupported', type: 'invalid', reason: 'unsupported_lifecycle_contract' });
    expect(service.summary().lastError).toBe('unsupported_lifecycle_contract');
    now += 1;
    await service.admit({ id: 'capture-store', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' } });
    await service.signal({ id: 'capture-store', type: 'invalid', reason: 'capture_store_unavailable' });
    expect(service.summary().lastError).toBe('capture_store_unavailable');
    const restarted = await createGoogleCalendarService(options);
    expect(restarted.summary().lastError).toBe('capture_store_unavailable');
  });

  // preserve token-free target lineage across disconnect and restart
  it('retains encrypted app-created calendar tombstones without credentials', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject', email: 'private@example.com' }, tokens: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const options = { config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started' as const, endMoment: 'work_finished' as const }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as typeof fetch };
    const service = await createGoogleCalendarService(options);
    expect((await service.disconnect(authority()))).toMatchObject({ connected: false, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' });
    const restarted = await createGoogleCalendarService(options);
    expect(restarted.summary()).toMatchObject({ connected: false, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' });
    expect(JSON.stringify(restarted.summary())).not.toContain('private@example.com');
  });

  // reject failed durable signal writes and preserve evidence for retry
  it('does not acknowledge or dispatch an unpersisted lifecycle transition', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => new Response(JSON.stringify({ id: JSON.parse(String(init?.body)).id }), { status: 200 }));
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as typeof fetch });
    await service.admit({ id: 'retryable', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' } });
    await chmod(directory, 0o500);
    try {
      await expect(service.signal({ id: 'retryable', type: 'started', at: '2026-10-23T17:01:00.000Z' })).rejects.toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await chmod(directory, 0o700);
    }
    await service.signal({ id: 'retryable', type: 'started', at: '2026-10-23T17:01:00.000Z' });
    await service.signal({ id: 'retryable', type: 'finished', at: '2026-10-23T17:02:00.000Z' });
    await vi.waitFor(() => expect(service.summary().counts.delivered).toBe(1));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  // retry quota rejection later with the same immutable event identity
  it('retries reason-aware transient rejection without changing event id', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: 10_000_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const eventIds: string[] = [];
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      eventIds.push(body.id);
      // retry only the first quota rejection
      if (eventIds.length === 1) return new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403 });
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    });
    let now = 1_000_000;
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as typeof fetch, now: () => now });
    await service.admit({ id: 'quota', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' } });
    await service.signal({ id: 'quota', type: 'started', at: '2026-10-23T17:01:00.000Z' });
    await service.signal({ id: 'quota', type: 'finished', at: '2026-10-23T17:02:00.000Z' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    now += 3_000;
    await service.dispatch();
    expect(service.summary().counts.delivered).toBe(1);
    expect(eventIds).toHaveLength(2);
    expect(eventIds[1]).toBe(eventIds[0]);
  });

  // snapshot handover kind and renamed worktree only at proven work start
  it('uses safe replacement-kind labels once across queued handover', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    let body: Record<string, any> = {};
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ id: body.id }), { status: 200 }); });
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree} {agent}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as typeof fetch });
    await service.admit({ id: 'handover', agentId: 'old-agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Old name', agent: 'Codex' } });
    await service.signal({ id: 'handover', type: 'started', at: '2026-10-23T17:01:00.000Z', labels: { worktree: 'Renamed', agent: 'Claude' } });
    await service.signal({ id: 'handover', type: 'started', at: '2026-10-23T17:01:01.000Z', labels: { worktree: 'Later rewrite', agent: 'Codex' } });
    await service.signal({ id: 'handover', type: 'finished', at: '2026-10-23T17:02:00.000Z' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(body.summary).toBe('Renamed Claude');
  });

  // prevent a held refresh from resurrecting credentials after disconnect
  it('discards held token refresh after a concurrent disconnect', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'old-subject' }, tokens: { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 }, calendars: [{ id: 'old-calendar', name: 'Old' }], selectedCalendarId: 'old-calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    let releaseRefresh!: (response: Response) => void;
    const heldRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      // hold only the stale refresh request
      if (String(input).includes('/token') && body.includes('grant_type=refresh_token')) return await heldRefresh;
      // permit best-effort revocation to finish
      if (String(input).includes('/revoke')) return new Response('', { status: 200 });
      throw new Error('unexpected request');
    });
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const creation = service.createCalendar('Orphan', authority());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await service.disconnect(authority());
    releaseRefresh(new Response(JSON.stringify({ access_token: 'stale-access', expires_in: 3600 }), { status: 200 }));
    await expect(creation).rejects.toThrow('authorization_changed');
    expect(service.summary()).toMatchObject({ connected: false, calendars: [{ id: 'old-calendar', name: 'Old' }] });
    const stored = await new AuthStore(authPath, parseTokenKey(keyText)).load();
    expect(stored).toMatchObject({ disconnected: true, tokens: { accessToken: '', expiresAt: 0 } });
  });

  // prevent a held old-account refresh from overwriting an account switch
  it('discards held token refresh after a concurrent account switch', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const clientId = 'client';
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const auth: GoogleAuthState = { version: 1, clientId, principal: { sub: 'old-subject' }, tokens: { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 }, calendars: [{ id: 'old-calendar', name: 'Old' }], selectedCalendarId: 'old-calendar' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'new-key';
    let nonce = '';
    let releaseRefresh!: (response: Response) => void;
    const heldRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? '');
      // hold only the old account refresh
      if (url.includes('/token') && body.includes('grant_type=refresh_token')) return await heldRefresh;
      // complete the replacement account code exchange
      if (url.includes('/token') && body.includes('grant_type=authorization_code')) return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, id_token: idToken(clientId, nonce, 'new-subject', pair.privateKey, kid) }), { status: 200 });
      // provide the exact replacement signing key
      if (url.includes('/certs')) return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      throw new Error('unexpected request');
    });
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: clientId, RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const creation = service.createCalendar('Orphan', authority());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const authorization = new URL(service.beginConnect('session', 'generation'));
    nonce = authorization.searchParams.get('nonce')!;
    await service.completeConnect({ ...authority(), code: 'replacement-code', state: authorization.searchParams.get('state')! });
    releaseRefresh(new Response(JSON.stringify({ access_token: 'stale-access', expires_in: 3600 }), { status: 200 }));
    await expect(creation).rejects.toThrow('authorization_changed');
    expect(service.summary()).toMatchObject({ connected: true, accountEmail: 'new-subject@example.com', calendars: [] });
    const stored = await new AuthStore(authPath, parseTokenKey(keyText)).load();
    expect(stored).toMatchObject({ principal: { sub: 'new-subject' }, tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' }, calendars: [] });
  });

  // abort the current request and exit before the next queued target on shutdown
  it('bounds shutdown without draining the due queue', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'one', name: 'one' }, { id: 'two', name: 'two' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const records = new ActivityStore(activitiesPath);
    await records.add(readyActivity('one', 'one', 0));
    await records.add(readyActivity('two', 'two', 0));
    const held = new Promise<Response>(() => undefined);
    const fetcher = vi.fn(async () => await held);
    const service = await createGoogleCalendarService({ config: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' }, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as typeof fetch });
    const dispatch = service.dispatch();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await service.stop();
    await dispatch;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  // dead-letter expired age and attempt budgets before provider requests
  it('enforces retry budgets before external delivery', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const now = 100_000_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: now + 3_600_000 }, calendars: [{ id: 'one', name: 'one' }, { id: 'two', name: 'two' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const expired = { ...readyActivity('expired', 'one', 0), status: 'retry_scheduled' as const, attempts: 1, firstAttemptAt: now - 24 * 60 * 60 * 1_000 };
    const exhausted = { ...readyActivity('exhausted', 'two', 0), status: 'retry_scheduled' as const, attempts: 8, firstAttemptAt: now - 1_000 };
    const records = new ActivityStore(activitiesPath, () => now);
    await records.add(expired);
    await records.add(exhausted);
    const fetcher = vi.fn();
    const service = await createGoogleCalendarService({ config: expired.policy, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: fetcher as unknown as typeof fetch, now: () => now });
    await service.dispatch();
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.summary().counts.failed).toBe(2);
  });

  // clear terminal fields when eligible failed rows return to ready
  it('releases authorization and retryable dead-letter rows durably', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const now = 100_000;
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: now + 3_600_000 }, calendars: [{ id: 'one', name: 'one' }, { id: 'two', name: 'two' }], selectedCalendarId: 'one' };
    await new AuthStore(authPath, parseTokenKey(keyText)).save(auth);
    const authorization = { ...readyActivity('authorization', 'one', 0), status: 'authorization_required' as const, attempts: 1, firstAttemptAt: now - 1_000, completedAt: now - 500, lastError: 'authorization_required', reason: 'missing_lifecycle_evidence' };
    const deadLetter = { ...readyActivity('dead-letter', 'two', 0), status: 'dead_letter' as const, attempts: 8, firstAttemptAt: now - 2_000, completedAt: now - 400, lastError: 'retry_scheduled', reason: 'missing_lifecycle_evidence' };
    const records = new ActivityStore(activitiesPath, () => now);
    await records.add(authorization);
    await records.add(deadLetter);
    const service = await createGoogleCalendarService({ config: authorization.policy, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath, fetch: vi.fn() as unknown as typeof fetch, now: () => now });
    await service.stop();
    await service.retry(authority());
    const reloaded = new ActivityStore(activitiesPath, () => now);
    await reloaded.load();
    for (const id of ['authorization', 'dead-letter']) {
      // require a clean ready retry without terminal residue
      expect(reloaded.get(id)).toMatchObject({ status: 'ready', attempts: 0, nextAttemptAt: now });
      expect(reloaded.get(id)?.completedAt).toBeUndefined();
      expect(reloaded.get(id)?.reason).toBeUndefined();
      expect(reloaded.get(id)?.lastError).toBeUndefined();
    }
  });
});
