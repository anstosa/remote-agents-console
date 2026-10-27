import { calendarEventIdentity } from '../src/google-calendar/event-identity.js';
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, constants, fsyncSync, openSync, renameSync } from 'node:fs';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { ActivityStore, AuthStore } from '../src/google-calendar/store.js';
import type { CalendarActivity, GoogleAuthState } from '../src/google-calendar/provider-types.js';
import { tempDir } from './helpers/codex-fixtures.js';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import { GoogleCalendarLifecycle } from '../src/google-calendar/lifecycle.js';

// observe the real filesystem publication boundary without replacing storage behavior
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, renameSync: vi.fn(actual.renameSync), openSync: vi.fn(actual.openSync), fsyncSync: vi.fn(actual.fsyncSync), closeSync: vi.fn(actual.closeSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
// isolate one-shot storage failures and call ordering between cases
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  vi.mocked(closeSync).mockReset().mockImplementation(actualFs.closeSync);
});

const config = { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started' as const, endMoment: 'work_finished' as const };

// build one minimal durable activity
function activity(id: string): CalendarActivity {
  return { version: 1, id, agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', labels: { worktree: 'Cora', agent: 'Codex' }, policy: config, target: { id: 'calendar', name: 'RAC Work' }, principalSub: 'subject', status: 'admitted', attempts: 0 };
}

// build one internally consistent finalized activity
function readyActivity(id: string): CalendarActivity {
  const target = { id: 'calendar', name: 'RAC Work' };
  return { ...activity(id), target, principalSub: 'subject', status: 'ready', startedAt: '2026-10-23T17:01:00.000Z', finishedAt: '2026-10-23T17:02:00.000Z', startAt: '2026-10-23T17:01:00.000Z', endAt: '2026-10-23T17:02:00.000Z', summary: 'Cora', ...calendarEventIdentity(target.id, id), nextAttemptAt: 1 };
}

// build one internally consistent estimated outbox record
function estimatedActivity(id: string) {
  const target = { id: 'calendar', name: 'RAC Work' };
  return { ...activity(id), target, principalSub: 'subject', status: 'ready' as const, startedAt: '2026-10-23T17:01:00.000Z', startAt: '2026-10-23T17:01:00.000Z', endAt: '2026-10-23T17:16:00.000Z', estimatedInterval: true as const, summary: 'Cora', ...calendarEventIdentity(target.id, id), nextAttemptAt: 1 };
}

// restore real service admission against isolated durable rows and a fake provider
async function connectedService(records: CalendarActivity[] = []) {
  const directory = await tempDir('rac-google-calendar-');
  const key = `active:${randomBytes(32).toString('base64url')}`;
  const authPath = join(directory, 'auth.json');
  const activitiesPath = join(directory, 'activities.json');
  const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' };
  await new AuthStore(authPath, parseTokenKey(key)).save(auth);
  await writeFile(activitiesPath, JSON.stringify({ version: 1, activities: records }), { mode: 0o600 });
  const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath, fetch: vi.fn(async () => new Response(JSON.stringify({ id: 'created' }), { status: 200 })) as typeof fetch });
  return service;
}

// cover atomic private persistence and key rotation
describe('Google Calendar stores', () => {
  // connected lifecycle rows need the immutable destination pair before rehydration
  it.each(['admitted', 'awaiting_evidence', 'suppressed'] as const)('validates destination identity for %s rows', async status => {
    const directory = await tempDir('rac-google-calendar-admission-schema-');
    // exercise both partial pairs as well as connected and disconnected identities
    for (const pair of ['both', 'target', 'principal', 'neither'] as const) {
      const row: CalendarActivity = { ...activity(pair), status, ...(status === 'admitted' ? {} : { completedAt: Date.now() }) };
      // remove exactly the selected persisted identity members
      if (pair === 'principal' || pair === 'neither') delete row.target;
      // one-sided identities are never a valid disconnected suppression
      if (pair === 'target' || pair === 'neither') delete row.principalSub;
      const file = join(directory, `${pair}.json`);
      await writeFile(file, JSON.stringify({ version: 1, activities: [row] }), { mode: 0o600 });
      const store = new ActivityStore(file);
      // only suppression can omit the complete connected identity
      if (pair === 'both' || status === 'suppressed' && pair === 'neither') {
        await store.load();
        expect(store.get(pair)).toMatchObject({ id: pair, status });
      } else {
        await expect(store.load()).rejects.toThrow('activity_store_invalid');
        expect(store.list()).toEqual([]);
      }
    }
  });

  // valid admitted state must still finalize after reloading its private destination
  it('reloads an admitted identity before signaling a completed interval', async () => {
    const directory = await tempDir('rac-google-calendar-admitted-restart-');
    const key = `active:${randomBytes(32).toString('base64url')}`;
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    await new AuthStore(authPath, parseTokenKey(key)).save({ version: 1, clientId: 'client', principal: { sub: 'subject' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }, calendars: [{ id: 'calendar', name: 'RAC Work' }], selectedCalendarId: 'calendar' });
    await writeFile(activitiesPath, JSON.stringify({ version: 1, activities: [activity('restart')] }), { mode: 0o600 });
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath });
    await service.stop();
    await service.signal({ id: 'restart', type: 'started', at: '2026-10-23T17:01:00.000Z' });
    await service.signal({ id: 'restart', type: 'finished', at: '2026-10-23T17:02:00.000Z' });
    const restored = new ActivityStore(activitiesPath);
    await restored.load();
    expect(restored.get('restart')).toMatchObject({ status: 'ready', target: { id: 'calendar', name: 'RAC Work' }, principalSub: 'subject' });
  });

  // reload estimated ready and delivered intervals without weakening exact rows
  it.each(['ready', 'delivered'] as const)('reloads a valid fifteen-minute estimated %s interval', async status => {
    const file = join(await tempDir('rac-google-calendar-estimated-restart-'), 'activities.json');
    const row = { ...estimatedActivity(status), status, ...(status === 'delivered' ? { attempts: 1, firstAttemptAt: 1, completedAt: 2 } : {}) };
    await writeFile(file, JSON.stringify({ version: 1, activities: [row] }), { mode: 0o600 });
    const store = new ActivityStore(file, () => 100);
    await store.load();
    expect(store.get(status)).toMatchObject({ status, estimatedInterval: true, startAt: '2026-10-23T17:01:00.000Z', endAt: '2026-10-23T17:16:00.000Z' });
  });

  // keep a broken storage collaborator from turning finalization into a raw dereference
  it('contains malformed in-memory admission identity before finalization', async () => {
    const service = await connectedService([activity('malformed')]);
    await service.stop();
    const spy = vi.spyOn(ActivityStore.prototype, 'update').mockImplementationOnce(async (_id, update) => {
      const row = { ...activity('malformed'), target: undefined, startedAt: '2026-10-23T17:01:00.000Z' };
      update(row);
      return row;
    });
    try {
      await expect(service.signal({ id: 'malformed', type: 'finished', at: '2026-10-23T17:02:00.000Z' })).rejects.toMatchObject({ code: 'capture_store_unavailable' });
    } finally { spy.mockRestore(); }
  });
  // reject malformed private bytes before decoding or publishing any provider state
  it.each([['auth', 255], ['auth', 0], ['activities', 255], ['activities', 0]] as const)('fails closed for %s with byte %s', async (kind, byte) => {
    const directory = await tempDir('rac-google-calendar-invalid-bytes-');
    const authPath = join(directory, 'auth.json');
    const activitiesPath = join(directory, 'activities.json');
    const key = `active:${randomBytes(32).toString('base64url')}`;
    const source = kind === 'auth' ? JSON.stringify({ version: 1, kid: 'BYTE_MARKER', iv: '', tag: '', ciphertext: '' }) : JSON.stringify({ version: 1, activities: [{ ...activity('invalid'), labels: { worktree: 'BYTE_MARKER', agent: 'Codex' } }] });
    const [prefix, suffix] = source.split('BYTE_MARKER');
    await writeFile(kind === 'auth' ? authPath : activitiesPath, Buffer.concat([Buffer.from(prefix!), Buffer.from([byte]), Buffer.from(suffix!)]), { mode: 0o600 });
    const store = kind === 'auth' ? new AuthStore(authPath, parseTokenKey(key)) : new ActivityStore(activitiesPath);
    await expect(store.load()).rejects.toThrow('private_store_invalid');
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: key }, authPath, activitiesPath });
    expect(service.summary()).toMatchObject({ available: false, connected: false, lastError: 'private_store_invalid' });
    await expect(service.admit({ id: 'unpublished', agentId: 'agent', kind: 'codex', submittedAt: new Date().toISOString(), labels: { worktree: 'Main', agent: 'Codex' } })).resolves.toBe(false);
  });
  // prune only settled metadata strictly older than the documented cutoff
  it('compacts expired delivered and suppressed rows while retaining unresolved work', async () => {
    const file = join(await tempDir('rac-google-calendar-retention-'), 'activities.json');
    const day = 24 * 60 * 60 * 1_000;
    const now = 40 * day;
    const cutoff = now - 30 * day;
    const rows: CalendarActivity[] = [];
    // keep exact-boundary and fresh rows for both compactable states
    for (const status of ['delivered', 'suppressed'] as const) {
      // expired is strictly before the cutoff rather than equal to it
      for (const [age, completedAt] of [['expired', cutoff - 1], ['boundary', cutoff], ['fresh', cutoff + 1]] as const) {
        const id = `${status}-${age}`;
        rows.push(status === 'delivered' ? { ...readyActivity(id), status, attempts: 1, firstAttemptAt: 1, completedAt } : { ...activity(id), status, completedAt });
      }
    }
    rows.push(
      { ...activity('evidence'), status: 'awaiting_evidence', reason: 'missing_lifecycle_evidence', completedAt: cutoff - 1 },
      { ...readyActivity('authorization'), status: 'authorization_required', attempts: 1, firstAttemptAt: 1, completedAt: cutoff - 1 },
      { ...readyActivity('dead-letter'), status: 'dead_letter', attempts: 1, firstAttemptAt: 1, completedAt: cutoff - 1 },
      { ...readyActivity('retry'), status: 'retry_scheduled', attempts: 1, firstAttemptAt: 1, nextAttemptAt: 1 }
    );
    await writeFile(file, JSON.stringify({ version: 1, activities: rows }), { mode: 0o600 });
    const reloaded = new ActivityStore(file, () => now);
    await reloaded.load();
    const expected = rows.filter(row => !row.id.endsWith('-expired')).map(row => row.id);
    expect(reloaded.list().map(row => row.id)).toEqual(expected);
    expect(JSON.parse(await readFile(file, 'utf8')).activities.map((row: CalendarActivity) => row.id)).toEqual(expected);
  });
  // acknowledge only a compatible durable admission rather than current connection state
  it.each(['admitted', 'suppressed', 'awaiting_evidence', 'delivered'] as const)('replays a durable %s row without inventing admission', async status => {
    const row = status === 'delivered' ? readyActivity('duplicate') : { ...activity('duplicate'), target: { id: 'calendar', name: 'RAC Work' }, principalSub: 'subject' };
    row.status = status;
    // retain valid terminal bookkeeping in the seeded document
    if (status !== 'admitted') row.completedAt = Date.now();
    // represent an already delivered event with a real attempt
    if (status === 'delivered') { row.attempts = 1; row.firstAttemptAt = Date.now(); }
    const service = await connectedService([row]);
    const input = { id: row.id, agentId: row.agentId, kind: row.kind, submittedAt: row.submittedAt, labels: row.labels };
    expect(await service.admit(input)).toBe(status === 'admitted');
    expect(await service.admit({ ...input, agentId: 'different-agent' })).toBe(false);
    expect(service.summary().counts.pending).toBe(status === 'admitted' ? 1 : 0);
    const lifecycle = new GoogleCalendarLifecycle({ file: join(await tempDir('rac-google-calendar-'), 'lifecycle.json'), sink: service, labels: async () => row.labels });
    await lifecycle.admit(input);
    await lifecycle.beforeSend({ ...input, prompt: 'synthetic work', baseline: { rollout: '/private/rollout.jsonl', ordinal: 0 }, socketFingerprint: 'socket', socketPath: '/missing/socket', paneId: '%7', sentAt: '2026-10-23T17:00:01.000Z' });
    expect(await lifecycle.pending()).toEqual(status === 'admitted' ? [{ id: row.id, agentId: row.agentId, kind: row.kind }] : []);
  });

  // enforce the pending bound inside the same serialized mutation as insertion
  it('admits only one of two concurrent captures at the pending limit', async () => {
    const rows = Array.from({ length: 9_999 }, (_, index) => activity(`pending-${index}`));
    const service = await connectedService(rows);
    const row = activity('next');
    const input = { id: row.id, agentId: row.agentId, kind: row.kind, submittedAt: row.submittedAt, labels: row.labels };
    expect(await Promise.all([service.admit(input), service.admit({ ...input, id: 'last' })])).toEqual([true, false]);
    expect(service.summary().counts).toMatchObject({ pending: 10_000, suppressed: 1 });
  });

  // keep the final authority fence immediately ahead of durable directory publication
  it('syncs the canonical directory after a fenced rename and before memory publication', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const file = join(directory, 'activities.json');
    const store = new ActivityStore(file);
    await store.add(activity('one'));
    const fence = vi.fn();
    await store.updateAllFenced(rows => { rows[0]!.sentAt = '2026-10-23T17:00:01.000Z'; }, fence);
    expect(openSync).toHaveBeenCalledWith(directory, constants.O_RDONLY);
    expect(fsyncSync).toHaveBeenCalledOnce();
    expect(closeSync).toHaveBeenCalledWith(vi.mocked(openSync).mock.results[0]!.value);
    expect(fence.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]!);
    expect(vi.mocked(renameSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fsyncSync).mock.invocationCallOrder[0]!);
    expect(store.get('one')?.sentAt).toBe('2026-10-23T17:00:01.000Z');
  });

  // never acknowledge a private transition whose publication or durability barrier failed
  it.each(['rename', 'sync'])('retains in-memory state after a fenced %s failure', async failure => {
    const store = new ActivityStore(join(await tempDir('rac-google-calendar-'), 'activities.json'));
    await store.add(activity('one'));
    const boundary = failure === 'rename' ? renameSync : fsyncSync;
    vi.mocked(boundary).mockImplementationOnce(() => { throw new Error('synthetic_publication_failure'); });
    await expect(store.updateAllFenced(rows => { rows[0]!.sentAt = '2026-10-23T17:00:01.000Z'; }, () => undefined)).rejects.toThrow('synthetic_publication_failure');
    expect(store.get('one')?.sentAt).toBeUndefined();
  });

  // keep connected calendar identity unchanged when encrypted publication is not acknowledged
  it.each(['rename', 'sync'])('does not publish authorization after a staged %s failure', async failure => {
    const service = await connectedService();
    const boundary = failure === 'rename' ? renameSync : fsyncSync;
    vi.mocked(boundary).mockImplementationOnce(() => { throw new Error('synthetic_publication_failure'); });
    await expect(service.createCalendar('New calendar', { sessionId: 'session', reservationGeneration: 'generation', reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true })).rejects.toThrow();
    expect(boundary).toHaveBeenCalledOnce();
    expect(service.summary().calendars).toEqual([{ id: 'calendar', name: 'RAC Work' }]);
  });
  // publish activity transitions in one mode-0600 document
  it('persists one idempotent activity and atomic state update', async () => {
    const file = join(await tempDir('rac-google-calendar-'), 'activities.json');
    const store = new ActivityStore(file);
    expect(await store.add(activity('one'))).toBe(true);
    expect(await store.add(activity('one'))).toBe(false);
    await store.update('one', record => { record.sentAt = '2026-10-23T17:00:01.000Z'; });
    expect(store.get('one')?.sentAt).toBe('2026-10-23T17:00:01.000Z');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reloaded = new ActivityStore(file);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });

  // rotate previous-key authorization without exposing plaintext
  it('loads and rotates encrypted authorization to the active key', async () => {
    const file = join(await tempDir('rac-google-calendar-'), 'auth.json');
    const previous = parseTokenKey(`old:${randomBytes(32).toString('base64url')}`);
    const active = parseTokenKey(`new:${randomBytes(32).toString('base64url')}`);
    const auth: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: 'subject', email: 'user@example.com' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 }, calendars: [] };
    await new AuthStore(file, previous).save(auth);
    expect(await new AuthStore(file, active, previous).load()).toEqual(auth);
    const ciphertext = await readFile(file, 'utf8');
    expect(ciphertext).toContain('"kid":"new"');
    expect(ciphertext).not.toContain('access');
  });

  // reject corrupt and unknown-version state instead of guessing
  it('degrades on malformed durable documents', async () => {
    const file = join(await tempDir('rac-google-calendar-'), 'activities.json');
    await writeFile(file, '{"version":2,"activities":[]}', { mode: 0o600 });
    await expect(new ActivityStore(file).load()).rejects.toThrow('activity_store_invalid');
  });

  // reject provider metadata that is not derivable from closed lifecycle state
  it('rejects tampered recursive and status-specific activity fields', async () => {
    const file = join(await tempDir('rac-google-calendar-'), 'activities.json');
    const cases = [
      { ...readyActivity('summary'), summary: 'injected metadata' },
      { ...readyActivity('target'), target: { id: 'calendar', name: 'RAC Work', description: 'private' } },
      { ...activity('incomplete'), status: 'ready', summary: 'Cora' },
      { ...estimatedActivity('estimated-duration'), endAt: '2026-10-23T17:15:59.999Z' },
      { ...estimatedActivity('estimated-anchor'), startAt: '2026-10-23T17:00:00.000Z', endAt: '2026-10-23T17:15:00.000Z' },
      { ...estimatedActivity('estimated-target'), target: { id: 'other-calendar', name: 'RAC Work' } },
      { ...estimatedActivity('estimated-event'), eventId: '0'.repeat(52) },
      { ...estimatedActivity('estimated-marker'), marker: 'A'.repeat(43) },
      { ...estimatedActivity('estimated-marker-removed'), estimatedInterval: undefined },
      { ...estimatedActivity('estimated-start-removed'), startedAt: undefined },
      { ...estimatedActivity('estimated-false'), estimatedInterval: false },
      { ...readyActivity('exact-marked-estimated'), finishedAt: '2026-10-23T17:16:00.000Z', endAt: '2026-10-23T17:16:00.000Z', estimatedInterval: true },
      { ...activity('estimated-incomplete'), estimatedInterval: true }
    ];
    for (const record of cases) {
      // isolate each malformed persisted document
      await writeFile(file, JSON.stringify({ version: 1, activities: [record] }), { mode: 0o600 });
      await expect(new ActivityStore(file).load(), record.id).rejects.toThrow('activity_store_invalid');
    }
  });
});
