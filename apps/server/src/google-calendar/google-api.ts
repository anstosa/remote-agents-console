import { readGoogleObject } from './bounded-response.js';
import type { CalendarActivity, GoogleCalendarTarget } from './provider-types.js';
import { GoogleCalendarError } from './provider-types.js';

const calendarApi = 'https://www.googleapis.com/calendar/v3';
const retryStatuses = new Set([500, 502, 503, 504]);
const retryReasons = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);

export type DeliveryResult =
  | { kind: 'delivered' }
  | { kind: 'retry'; delayMs: number; reason: 'retry_scheduled' }
  | { kind: 'authorization_required' }
  | { kind: 'target_missing' }
  | { kind: 'ownership_conflict' }
  | { kind: 'deleted_by_user' }
  | { kind: 'permanent'; reason: string };

// validate a bounded visible calendar name
export function calendarName(value: unknown): string {
  const name = value === undefined ? 'RAC Agent Work' : value;
  // require one visible scalar-bounded label
  if (typeof name !== 'string' || [...name].length < 1 || [...name].length > 120 || /[\u0000-\u001f\u007f]/u.test(name) || name.trim().length === 0) throw new GoogleCalendarError('invalid_calendar_name', 400);
  return name.trim();
}

// create exactly one app-owned secondary calendar
export async function createGoogleCalendar(fetcher: typeof fetch, accessToken: string, value?: unknown): Promise<GoogleCalendarTarget> {
  const summary = calendarName(value);
  let response: Response;
  try {
    response = await fetcher(`${calendarApi}/calendars`, { method: 'POST', headers: authorization(accessToken), body: JSON.stringify({ summary }) });
  } catch { throw new GoogleCalendarError('calendar_create_outcome_unknown', 503); }
  // classify definite rejections without consuming an untrusted body
  if (!response.ok) {
    if (response.status === 401) throw new GoogleCalendarError('authorization_required', 401);
    if (response.status >= 500) throw new GoogleCalendarError('calendar_create_outcome_unknown', 503);
    throw new GoogleCalendarError('google_request_rejected', response.status === 403 ? 403 : 400);
  }
  let payload: Record<string, any>;
  try { payload = await readGoogleObject(response, 256 * 1024); }
  catch { throw new GoogleCalendarError('calendar_create_outcome_unknown', 503); }
  // a malformed success may already have created the calendar
  if (typeof payload.id !== 'string' || payload.id.length === 0 || payload.id.length > 1024 || /[\u0000-\u001f\u007f]/u.test(payload.id)) throw new GoogleCalendarError('calendar_create_outcome_unknown', 503);
  return { id: payload.id, name: summary };
}

// insert one immutable completed event and reconcile uncertain outcomes by exact id
export async function deliverGoogleEvent(fetcher: typeof fetch, accessToken: string, activity: CalendarActivity, random: () => number = Math.random): Promise<DeliveryResult> {
  // require a fully snapshotted ready record
  if (activity.target === undefined || activity.eventId === undefined || activity.marker === undefined || activity.summary === undefined || activity.startAt === undefined || activity.endAt === undefined) return { kind: 'permanent', reason: 'missing_lifecycle_evidence' };
  const endpoint = `${calendarApi}/calendars/${encodeURIComponent(activity.target.id)}/events`;
  const body = {
    id: activity.eventId,
    summary: activity.summary,
    start: { dateTime: activity.startAt, timeZone: 'UTC' },
    end: { dateTime: activity.endAt, timeZone: 'UTC' },
    extendedProperties: { private: { racActivity: activity.marker } }
  };
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: 'POST', headers: authorization(accessToken), body: JSON.stringify(body) });
  } catch {
    return await reconcileGoogleEvent(fetcher, accessToken, activity, random);
  }
  // accept only the exact successful identity
  if (response.ok) {
    let payload: Record<string, any>;
    try { payload = await readGoogleObject(response, 256 * 1024); }
    catch { return await reconcileGoogleEvent(fetcher, accessToken, activity, random, response); }
    return payload.id === activity.eventId ? { kind: 'delivered' } : await reconcileGoogleEvent(fetcher, accessToken, activity, random, response);
  }
  // reconcile conflict and unknown server outcomes
  if (response.status === 409 || retryStatuses.has(response.status)) return await reconcileGoogleEvent(fetcher, accessToken, activity, random, response);
  return classifyFailure(response, activity.attempts, random);
}

// reconcile only the snapshotted target and stable event id
async function reconcileGoogleEvent(fetcher: typeof fetch, accessToken: string, activity: CalendarActivity, random: () => number, failed?: Response): Promise<DeliveryResult> {
  const url = `${calendarApi}/calendars/${encodeURIComponent(activity.target!.id)}/events/${encodeURIComponent(activity.eventId!)}`;
  let response: Response;
  try { response = await fetcher(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }); }
  catch {
    // retry an unknown successful insert body and classify known failed responses
    return failed === undefined || failed.ok ? retry(activity.attempts, undefined, random) : classifyFailure(failed, activity.attempts, random);
  }
  // compare only the opaque ownership marker
  if (response.ok) {
    const payload = await readGoogleObject(response, 256 * 1024);
    return payload.extendedProperties?.private?.racActivity === activity.marker ? { kind: 'delivered' } : { kind: 'ownership_conflict' };
  }
  // retry the same id after confirmed initial absence
  if (response.status === 404) return retry(activity.attempts, failed, random);
  return classifyFailure(response, activity.attempts, random);
}

// classify google status and bounded reason without echoing its body
export async function classifyFailure(response: Response, attempts: number, random: () => number = Math.random): Promise<DeliveryResult> {
  // preserve definitive statuses even when their unused body is oversized or broken
  if (response.status === 401 || response.status === 404 || response.status === 429 || retryStatuses.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    // stop on a lost grant without parsing provider content
    if (response.status === 401) return { kind: 'authorization_required' };
    // treat a missing calendar as terminal for its exact target
    if (response.status === 404) return { kind: 'target_missing' };
    return retry(attempts, response, random);
  }
  const payload = await readGoogleObject(response, 256 * 1024);
  const reasons = googleReasons(payload);
  // retain bounded reason-based authorization and quota handling
  if (reasons.includes('invalid_grant')) return { kind: 'authorization_required' };
  // distinguish retryable quota from permanent policy rejections
  if (response.status === 403 && reasons.some(reason => retryReasons.has(reason))) return retry(attempts, response, random);
  return { kind: 'permanent', reason: 'google_request_rejected' };
}

// compute bounded full-jitter backoff and retry-after
function retry(attempts: number, response: Response | undefined, random: () => number): DeliveryResult {
  const exponential = Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(attempts, 12));
  const retryAfter = response === undefined ? 0 : parseRetryAfter(response.headers.get('retry-after'));
  return { kind: 'retry', reason: 'retry_scheduled', delayMs: Math.max(retryAfter, Math.floor(Math.max(0, Math.min(1, random())) * exponential)) };
}

// parse retry-after seconds or dates within one hour
function parseRetryAfter(value: string | null): number {
  // keep missing advice at zero
  if (value === null) return 0;
  const seconds = Number(value);
  // accept bounded integral seconds
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60 * 60 * 1_000, Math.floor(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(60 * 60 * 1_000, date - Date.now())) : 0;
}

// collect bounded nested google error reasons
function googleReasons(payload: Record<string, any>): string[] {
  const errors = payload.error?.errors;
  // ignore malformed error bodies
  if (!Array.isArray(errors)) return typeof payload.error === 'string' && payload.error.length <= 128 ? [payload.error] : [];
  return errors.slice(0, 16).map(error => error?.reason).filter((reason): reason is string => typeof reason === 'string' && reason.length <= 128);
}

// build headers without exposing tokens to caller-visible state
function authorization(accessToken: string): Record<string, string> { return { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' }; }
