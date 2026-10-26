import { googleCalendarStartMoments, googleCalendarEndMoments } from './contracts.js';
import { calendarActivityStatuses } from './provider-types.js';
import { closeSync, constants, fsyncSync, openSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ActivityDocument, CalendarActivity, EncryptedRecord, GoogleAuthState, TokenKey } from './provider-types.js';
import { decryptRecord, encryptRecord } from './crypto.js';
import { readBounded, writePrivate } from '../settings/files.js';
import { renderCalendarTitle, validateTitleTemplate } from './title.js';
import { calendarEventIdentity } from './event-identity.js';

const maximumActivityBytes = 32 * 1024 * 1024;
const maximumPending = 10_000;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;
const activityKeys = new Set(['version', 'id', 'agentId', 'kind', 'submittedAt', 'labels', 'policy', 'target', 'principalSub', 'status', 'reason', 'sentAt', 'startedAt', 'questionAt', 'finishedAt', 'startAt', 'endAt', 'summary', 'eventId', 'marker', 'attempts', 'firstAttemptAt', 'nextAttemptAt', 'completedAt', 'lastError']);
const deliveryStatuses = new Set<CalendarActivity['status']>(['ready', 'delivering', 'delivered', 'authorization_required', 'retry_scheduled', 'dead_letter', 'ownership_conflict', 'deleted_by_user', 'target_missing']);
const completedStatuses = new Set<CalendarActivity['status']>(['delivered', 'suppressed', 'awaiting_evidence', 'authorization_required', 'dead_letter', 'ownership_conflict', 'deleted_by_user', 'target_missing']);

// keep fenced publication synchronous through the canonical directory durability barrier
export function publishPrivateStage(stage: string, path: string): void {
  renameSync(stage, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// retain the Calendar error vocabulary around the shared private-byte boundary
async function readPrivate(path: string, maximum: number): Promise<string | undefined> {
  try { return await readBounded(path, true, true, maximum); }
  catch (error) { throw new Error('private_store_invalid', { cause: error }); }
}

// validate the decrypted auth record before publication
function validateAuth(value: unknown): GoogleAuthState {
  // require the closed auth document shape
  if (!closedObject(value, ['version', 'clientId', 'principal', 'tokens', 'calendars', 'selectedCalendarId', 'disconnected'])) throw new Error('auth_store_invalid');
  const auth = value as GoogleAuthState;
  // require stable principal and token identity
  if (auth.version !== 1 || !safeIdentifier(auth.clientId, 2048) || !closedObject(auth.principal, ['sub', 'email']) || !safeIdentifier(auth.principal.sub, 255) || !closedObject(auth.tokens, ['accessToken', 'refreshToken', 'expiresAt']) || typeof auth.tokens.accessToken !== 'string' || auth.tokens.refreshToken !== undefined && !safeIdentifier(auth.tokens.refreshToken, 8192) || !nonnegativeInteger(auth.tokens.expiresAt) || !Array.isArray(auth.calendars) || auth.disconnected !== undefined && auth.disconnected !== true || auth.selectedCalendarId !== undefined && !safeIdentifier(auth.selectedCalendarId, 1024)) throw new Error('auth_store_invalid');
  // keep the optional display email bounded and free of controls
  if (auth.principal.email !== undefined && (typeof auth.principal.email !== 'string' || auth.principal.email.length > 320 || /[\u0000-\u001f\u007f]/u.test(auth.principal.email))) throw new Error('auth_store_invalid');
  // require disconnected tombstones to contain no usable token material
  if (auth.disconnected === true && (auth.tokens.accessToken !== '' || auth.tokens.refreshToken !== undefined || auth.tokens.expiresAt !== 0)) throw new Error('auth_store_invalid');
  // require connected records to retain one bounded access token
  if (auth.disconnected !== true && (auth.tokens.accessToken.length < 1 || auth.tokens.accessToken.length > 32_768 || auth.tokens.refreshToken !== undefined && auth.tokens.refreshToken.length > 8192)) throw new Error('auth_store_invalid');
  // require only bounded app-created calendar registry rows
  if (!auth.calendars.every(calendar => closedObject(calendar, ['id', 'name']) && safeIdentifier(calendar.id, 1024) && safeDisplay(calendar.name, 120)) || new Set(auth.calendars.map(calendar => calendar.id)).size !== auth.calendars.length) throw new Error('auth_store_invalid');
  // bind selection to the app-created registry
  if (auth.selectedCalendarId !== undefined && !auth.calendars.some(calendar => calendar.id === auth.selectedCalendarId)) throw new Error('auth_store_invalid');
  return auth;
}

export class AuthStore {
  // keep auth persistence isolated behind explicit keys
  constructor(readonly path: string, private readonly active: TokenKey, private readonly previous?: TokenKey) {}

  // load and rotate a valid previous-key record
  async load(): Promise<GoogleAuthState | undefined> {
    const source = await readPrivate(this.path, 1_200_000);
    // preserve a genuinely empty installation
    if (source === undefined) return undefined;
    let parsed: EncryptedRecord;
    try { parsed = JSON.parse(source) as EncryptedRecord; } catch { throw new Error('auth_store_invalid'); }
    const opened = decryptRecord<unknown>(parsed, this.previous === undefined ? [this.active] : [this.active, this.previous]);
    const auth = validateAuth(opened.value);
    // rotate previous-key ciphertext after successful validation
    if (opened.key.kid !== this.active.kid) await this.save(auth);
    return auth;
  }

  // encrypt and publish current authorization state
  async save(auth: GoogleAuthState): Promise<void> { await writePrivate(this.path, JSON.stringify(encryptRecord(validateAuth(auth), this.active))); }

  // remove only local authorization material
  async remove(): Promise<void> { await rm(this.path, { force: true }); }

  // prepare transaction-private ciphertext for a fenced commit
  async stage(auth: GoogleAuthState, suffix: string): Promise<string> {
    const path = `${this.path}.${suffix}.stage`;
    await writePrivate(path, JSON.stringify(encryptRecord(validateAuth(auth), this.active)));
    return path;
  }

  // remove only exact orphaned callback stages beside the canonical store
  async cleanupStages(): Promise<void> {
    const directory = dirname(this.path);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      // ignore an absent not-yet-created private directory
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const prefix = `${basename(this.path)}.`;
    for (const name of names) {
      // delete only transaction-private stage names for this store
      if (name.startsWith(prefix) && name.endsWith('.stage')) await rm(`${directory}/${name}`, { force: true });
    }
  }
}

export class ActivityStore {
  private document: ActivityDocument = { version: 1, activities: [] };
  private serial: Promise<void> = Promise.resolve();

  // retain one durable activity document in memory
  constructor(readonly path: string, private readonly now: () => number = Date.now) {}

  // load and validate the bounded activity document
  async load(): Promise<void> {
    const source = await readPrivate(this.path, maximumActivityBytes);
    // keep a missing store empty without creating it
    if (source === undefined) return;
    let parsed: ActivityDocument;
    try { parsed = JSON.parse(source) as ActivityDocument; } catch { throw new Error('activity_store_invalid'); }
    // reject unknown versions and malformed rows
    if (!closedObject(parsed, ['version', 'activities']) || parsed.version !== 1 || !Array.isArray(parsed.activities) || parsed.activities.some(activity => !validActivity(activity)) || new Set(parsed.activities.map(activity => activity.id)).size !== parsed.activities.length) throw new Error('activity_store_invalid');
    this.document = parsed;
    await this.compact();
  }

  // return detached activity snapshots
  list(): CalendarActivity[] { return this.document.activities.map(activity => structuredClone(activity)); }

  // return one detached activity snapshot
  get(id: string): CalendarActivity | undefined {
    const activity = this.document.activities.find(candidate => candidate.id === id);
    return activity === undefined ? undefined : structuredClone(activity);
  }

  // report whether capture can accept another pending record
  hasCapacity(): boolean {
    const pending = this.document.activities.filter(activity => !terminalForCapacity(activity.status)).length;
    return pending < maximumPending && Buffer.byteLength(JSON.stringify(this.document), 'utf8') < maximumActivityBytes;
  }

  // add one immutable admission identity
  async add(activity: CalendarActivity): Promise<boolean> {
    let added = false;
    await this.mutate(document => {
      // make admission idempotent across caller retries
      if (document.activities.some(candidate => candidate.id === activity.id)) return;
      const next = structuredClone(activity);
      // enforce the pending cap under the same queue as duplicate handling and insertion
      if (next.status === 'admitted' && !this.hasCapacity()) {
        next.status = 'suppressed';
        next.reason = 'capture_capacity_exceeded';
        next.completedAt = this.now();
      }
      document.activities.push(next);
      added = true;
    });
    return added;
  }

  // update one record and publish the transition atomically
  async update(id: string, update: (activity: CalendarActivity) => void): Promise<CalendarActivity | undefined> {
    let output: CalendarActivity | undefined;
    await this.mutate(document => {
      const activity = document.activities.find(candidate => candidate.id === id);
      // ignore signals for unknown activities
      if (activity === undefined) return;
      update(activity);
      output = structuredClone(activity);
    });
    return output;
  }

  // publish one batch only behind a final synchronous authority fence
  async updateAllFenced(update: (activities: CalendarActivity[]) => void, fence: () => void): Promise<void> {
    await this.mutate(document => { update(document.activities); }, fence);
  }

  // compact only old terminal rows
  async compact(): Promise<void> {
    await this.mutate(document => {
      const cutoff = this.now() - retentionMs;
      document.activities = document.activities.filter(activity => activity.completedAt === undefined || activity.completedAt >= cutoff || !compactable(activity.status));
    });
  }

  // serialize every state transition and private write
  private async mutate(change: (document: ActivityDocument) => void, fence?: () => void): Promise<void> {
    const operation = this.serial.then(async () => {
      const next = structuredClone(this.document);
      change(next);
      // reject any transition that escapes the closed private schema
      if (next.activities.some(activity => !validActivity(activity))) throw new Error('activity_store_invalid');
      const serialized = JSON.stringify(next);
      // prevent a transition from crossing the hard local cap
      if (Buffer.byteLength(serialized, 'utf8') > maximumActivityBytes) throw new Error('capture_capacity_exceeded');
      // keep ordinary lifecycle writes on the direct atomic path
      if (fence === undefined) {
        await writePrivate(this.path, serialized);
        this.document = next;
        return;
      }
      const stage = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.stage`;
      try {
        await writePrivate(stage, serialized);
        fence();
        publishPrivateStage(stage, this.path);
        this.document = next;
      } finally {
        await rm(stage, { force: true });
      }
    });
    this.serial = operation.catch(() => undefined);
    await operation;
  }
}

// validate the durable identity and closed status surface
function validActivity(value: unknown): value is CalendarActivity {
  // require the minimum bounded row identity
  if (!closedObject(value, activityKeys)) return false;
  const activity = value as CalendarActivity;
  const labels = activity.labels;
  const policy = activity.policy;
  // require closed safe labels and policy fields
  if (!closedObject(labels, ['worktree', 'project', 'agent']) || !safeDisplay(labels.worktree, 80) || !safeDisplay(labels.agent, 80) || labels.project !== undefined && !safeDisplay(labels.project, 80) || !closedObject(policy, ['enabled', 'titleTemplate', 'startMoment', 'endMoment']) || typeof policy.enabled !== 'boolean' || !safeDisplay(policy.titleTemplate, 160) || validateTitleTemplate(policy.titleTemplate) !== undefined || !googleCalendarStartMoments.includes(policy.startMoment) || !googleCalendarEndMoments.includes(policy.endMoment)) return false;
  // require bounded scalar identity and counters
  if (activity.version !== 1 || !safeIdentifier(activity.id, 256) || !safeIdentifier(activity.agentId, 256, true) || !safeIdentifier(activity.kind, 64) || !validTimestamp(activity.submittedAt) || !calendarActivityStatuses.includes(activity.status) || !nonnegativeInteger(activity.attempts)) return false;
  // validate every optional scalar before status-specific use
  if (!optionalTimestamp(activity.sentAt) || !optionalTimestamp(activity.startedAt) || !optionalTimestamp(activity.questionAt) || !optionalTimestamp(activity.finishedAt) || !optionalTimestamp(activity.startAt) || !optionalTimestamp(activity.endAt) || !optionalInteger(activity.firstAttemptAt) || !optionalInteger(activity.nextAttemptAt) || !optionalInteger(activity.completedAt) || activity.reason !== undefined && !safeIdentifier(activity.reason, 128) || activity.lastError !== undefined && !safeIdentifier(activity.lastError, 128) || activity.principalSub !== undefined && !safeIdentifier(activity.principalSub, 255) || activity.summary !== undefined && !safeDisplay(activity.summary, 512, true) || activity.eventId !== undefined && !/^[0-9a-f]{52}$/u.test(activity.eventId) || activity.marker !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(activity.marker)) return false;
  // every connected admission needs both destination members; only suppression may omit both
  if ((activity.target === undefined) !== (activity.principalSub === undefined) || activity.status !== 'suppressed' && activity.target === undefined) return false;
  // validate the immutable target recursively
  if (activity.target !== undefined && (!closedObject(activity.target, ['id', 'name']) || !safeIdentifier(activity.target.id, 1024) || !safeDisplay(activity.target.name, 120))) return false;
  // require finalized rows to match their derivable interval and identities
  if (deliveryStatuses.has(activity.status) && !validDeliverySnapshot(activity)) return false;
  // forbid pre-final rows from carrying provider metadata
  if (!deliveryStatuses.has(activity.status) && [activity.startAt, activity.endAt, activity.summary, activity.eventId, activity.marker].some(field => field !== undefined)) return false;
  // require terminal rows to retain a completion instant
  if (completedStatuses.has(activity.status) && activity.completedAt === undefined) return false;
  // forbid active rows from carrying a false completion instant
  if (!completedStatuses.has(activity.status) && activity.completedAt !== undefined) return false;
  // bind delivery attempts to their persisted retry phase
  if (activity.status === 'ready' && activity.nextAttemptAt === undefined || activity.status === 'delivering' && (activity.attempts < 1 || activity.firstAttemptAt === undefined) || activity.status === 'retry_scheduled' && (activity.attempts < 1 || activity.firstAttemptAt === undefined || activity.nextAttemptAt === undefined) || completedStatuses.has(activity.status) && deliveryStatuses.has(activity.status) && (activity.attempts < 1 || activity.firstAttemptAt === undefined)) return false;
  // keep pre-delivery evidence free of synthetic attempts
  if (!deliveryStatuses.has(activity.status) && activity.attempts !== 0) return false;
  return true;
}

// validate one fully derived provider payload snapshot
function validDeliverySnapshot(activity: CalendarActivity): boolean {
  // require the immutable target, principal, and lifecycle boundary
  if (activity.target === undefined || activity.principalSub === undefined || activity.startedAt === undefined || activity.startAt === undefined || activity.endAt === undefined || activity.summary === undefined || activity.eventId === undefined || activity.marker === undefined) return false;
  const startEvidence = activity.policy.startMoment === 'prompt_submitted' ? activity.submittedAt : activity.policy.startMoment === 'prompt_sent' ? activity.sentAt : activity.startedAt;
  const endEvidence = activity.policy.endMoment === 'first_question_or_finished' ? activity.questionAt ?? activity.finishedAt : activity.finishedAt;
  // bind delivery fields to persisted lifecycle evidence
  if (startEvidence === undefined || endEvidence === undefined || activity.startAt !== new Date(Date.parse(startEvidence)).toISOString() || activity.endAt !== new Date(Date.parse(endEvidence)).toISOString() || Date.parse(activity.endAt) <= Date.parse(activity.startAt)) return false;
  const { eventId, marker } = calendarEventIdentity(activity.target.id, activity.id);
  return activity.eventId === eventId && activity.marker === marker && activity.summary === renderCalendarTitle(activity.policy.titleTemplate, activity.labels);
}

// require an object with no unrecognized fields
function closedObject(value: unknown, allowed: Iterable<string>): value is Record<string, any> {
  // reject nulls, arrays, and unknown recursive keys
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

// require bounded visible text without control or surrogate code points
function safeDisplay(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && [...value].length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value);
}

// require bounded opaque identifiers without control bytes
function safeIdentifier(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

// require one parseable positive lifecycle instant
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0; }

// validate an optional lifecycle instant
function optionalTimestamp(value: unknown): boolean { return value === undefined || validTimestamp(value); }

// require one nonnegative safe integer
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

// validate an optional nonnegative safe integer
function optionalInteger(value: unknown): boolean { return value === undefined || nonnegativeInteger(value); }

// retain retryable and active rows under the pending cap
function terminalForCapacity(status: CalendarActivity['status']): boolean { return ['delivered', 'suppressed', 'dead_letter', 'ownership_conflict', 'deleted_by_user', 'target_missing'].includes(status); }

// remove only settled success and suppression history
function compactable(status: CalendarActivity['status']): boolean { return status === 'delivered' || status === 'suppressed'; }
