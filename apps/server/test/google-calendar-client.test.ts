import { describe, expect, it, vi } from 'vitest';
import { classifyFailure, createGoogleCalendar, deliverGoogleEvent } from '../src/google-calendar/google-api.js';
import type { CalendarActivity } from '../src/google-calendar/provider-types.js';

const ready: CalendarActivity = {
  version: 1,
  id: 'activity',
  agentId: 'agent',
  kind: 'codex',
  submittedAt: '2026-10-23T17:00:00.000Z',
  labels: { worktree: 'Cora', agent: 'Codex' },
  policy: { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' },
  target: { id: 'calendar-id', name: 'RAC Agent Work' },
  principalSub: 'subject',
  status: 'ready',
  startAt: '2026-10-23T17:00:01.000Z',
  endAt: '2026-10-23T17:00:02.000Z',
  summary: 'Cora',
  eventId: 'a'.repeat(52),
  marker: 'opaque-marker',
  attempts: 0
};

// expose a never-ending unused body with an observable finite cancellation
function pendingResponse(status: number, headers: HeadersInit = {}) {
  const cancel = vi.fn();
  return { response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status, headers }), cancel };
}

// cover least-privilege calendar and immutable event requests
describe('Google Calendar API client', () => {
  // stop at permanent authorization and target failures without inserting another event
  it.each([
    [401, { error: 'unauthorized' }, 'authorization_required'],
    [400, { error: 'invalid_grant' }, 'authorization_required'],
    [404, { error: 'notFound' }, 'target_missing']
  ] as const)('returns a terminal classification for HTTP %s with %j', async (status, body, kind) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    await expect(deliverGoogleEvent(fetcher as typeof fetch, 'synthetic-token', ready)).resolves.toEqual({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  // preserve definitive statuses without reading oversized or broken provider streams
  it.each([
    [401, 'authorization_required', 'oversized'], [401, 'authorization_required', 'broken'],
    [404, 'target_missing', 'oversized'], [404, 'target_missing', 'broken'],
    [429, 'retry', 'broken'], [503, 'retry', 'broken']
  ] as const)('classifies HTTP %s as %s with an unreadable %s body', async (status, kind, bodyKind) => {
    const body = new ReadableStream<Uint8Array>({
      // make any attempted parse fail while leaving status and headers definitive
      start(controller) {
        // exercise stream failure separately from the bounded-size rejection
        if (bodyKind === 'broken') controller.error(new Error('synthetic body failure'));
        else controller.enqueue(new Uint8Array(256 * 1024 + 1));
      }
    });
    const cancel = vi.spyOn(body, 'cancel');
    const response = new Response(body, { status, headers: { 'retry-after': '2' } });
    // direct classification covers retry statuses without insert reconciliation
    if (kind === 'retry') await expect(classifyFailure(response, 1, () => 0)).resolves.toEqual({ kind, reason: 'retry_scheduled', delayMs: 2000 });
    else {
      const fetcher = vi.fn(async () => response);
      await expect(deliverGoogleEvent(fetcher as typeof fetch, 'synthetic-token', ready)).resolves.toEqual({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  // release definite create rejections without reading an irrelevant provider body
  it.each([[401, 'authorization_required'], [403, 'google_request_rejected'], [503, 'calendar_create_outcome_unknown']] as const)('cancels unused create response %s', async (status, code) => {
    const { response, cancel } = pendingResponse(status);
    await expect(createGoogleCalendar((async () => response) as typeof fetch, 'token')).rejects.toMatchObject({ code, statusCode: status });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // dispose both superseded insert and body-independent lookup failures
  it.each([[409, 200], [409, 404], [409, 401], [503, 200], [503, 404], [503, 401]])('disposes insert %s after lookup %s', async (insertStatus, lookupStatus) => {
    const insert = pendingResponse(insertStatus, { 'retry-after': '2' });
    const lookup = lookupStatus === 200
      ? { response: new Response(JSON.stringify({ extendedProperties: { private: { racActivity: ready.marker } } }), { status: 200 }), cancel: undefined }
      : pendingResponse(lookupStatus);
    const fetcher = vi.fn().mockResolvedValueOnce(insert.response).mockResolvedValueOnce(lookup.response);
    const result = await deliverGoogleEvent(fetcher as typeof fetch, 'token', ready, () => 0);
    // retain exact ownership and retry-after classifications during disposal
    if (lookupStatus === 200) expect(result).toEqual({ kind: 'delivered' });
    // a missing lookup still retries the same immutable event identity
    else if (lookupStatus === 404) expect(result).toEqual({ kind: 'retry', reason: 'retry_scheduled', delayMs: 2000 });
    else expect(result).toEqual({ kind: 'authorization_required' });
    expect(insert.cancel).toHaveBeenCalledOnce();
    // successful lookup bodies are bounded-read rather than cancelled
    if (lookupStatus === 200) expect(lookup.response.bodyUsed).toBe(true);
    else expect(lookup.cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // finish fallback reason parsing before disposing its original response
  it('preserves readable conflict reasons when reconciliation is unavailable', async () => {
    const response = new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 409 });
    const fetcher = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(deliverGoogleEvent(fetcher as typeof fetch, 'token', ready)).resolves.toEqual({ kind: 'authorization_required' });
    expect(response.bodyUsed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // cancellation failure must not replace an already definitive provider outcome
  it('preserves create failure classification when cancellation rejects', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel unavailable'));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 });
    await expect(createGoogleCalendar((async () => response) as typeof fetch, 'token')).rejects.toMatchObject({ code: 'authorization_required' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // never accept or overwrite an exact-id event belonging to another activity
  it('rejects a foreign opaque ownership marker during conflict reconciliation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 409 })).mockResolvedValueOnce(new Response(JSON.stringify({ extendedProperties: { private: { racActivity: 'foreign-marker' } } }), { status: 200 }));
    await expect(deliverGoogleEvent(fetcher as typeof fetch, 'synthetic-token', ready)).resolves.toEqual({ kind: 'ownership_conflict' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  // create once without listing or retrying an unknown outcome
  it('creates exactly one named app calendar', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'created-id' }), { status: 200 }));
    await expect(createGoogleCalendar(fetcher as typeof fetch, 'token', 'RAC Work')).resolves.toEqual({ id: 'created-id', name: 'RAC Work' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith('/calendars')).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ summary: 'RAC Work' });
    await expect(createGoogleCalendar((async () => { throw new Error('lost'); }) as typeof fetch, 'token')).rejects.toThrow('calendar_create_outcome_unknown');
  });

  // distinguish definite create rejection from unknown accepted outcomes
  it('classifies calendar create response certainty without retrying', async () => {
    await expect(createGoogleCalendar((async () => new Response('', { status: 401 })) as typeof fetch, 'token')).rejects.toMatchObject({ code: 'authorization_required', statusCode: 401 });
    await expect(createGoogleCalendar((async () => new Response('', { status: 403 })) as typeof fetch, 'token')).rejects.toMatchObject({ code: 'google_request_rejected', statusCode: 403 });
    const broken = new ReadableStream<Uint8Array>({ pull: () => { throw new Error('body lost'); } });
    await expect(createGoogleCalendar((async () => new Response(broken, { status: 200 })) as typeof fetch, 'token')).rejects.toThrow('calendar_create_outcome_unknown');
  });

  // cancel oversized create responses before buffering the complete body
  it('bounds streamed calendar create responses', async () => {
    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      // emit bounded chunks until the client cancels
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
      // record early stream cancellation
      cancel() { cancelled = true; }
    });
    await expect(createGoogleCalendar((async () => new Response(oversized, { status: 200 })) as typeof fetch, 'token')).rejects.toThrow('calendar_create_outcome_unknown');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(6);
  });

  // omit metadata content and reconcile timeout with exact marker lookup
  it('uses a stable exact id and opaque private marker only', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      // simulate a lost insert response
      if (init?.method === 'POST') throw new Error('timeout');
      return new Response(JSON.stringify({ id: ready.eventId, extendedProperties: { private: { racActivity: ready.marker } } }), { status: 200 });
    });
    await expect(deliverGoogleEvent(fetcher as typeof fetch, 'access-token', ready)).resolves.toEqual({ kind: 'delivered' });
    const event = JSON.parse(String(requests[0]!.init?.body));
    expect(event).toEqual({ id: ready.eventId, summary: 'Cora', start: { dateTime: ready.startAt, timeZone: 'UTC' }, end: { dateTime: ready.endAt, timeZone: 'UTC' }, extendedProperties: { private: { racActivity: ready.marker } } });
    expect(JSON.stringify(event)).not.toMatch(/description|location|attendee|subject|path/iu);
    expect(requests[1]!.url).toContain(`/events/${ready.eventId}`);
  });

  // distinguish retryable quota reasons from permanent policy failures
  it('classifies status and reason with bounded retry advice', async () => {
    const quota = new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded', message: 'private detail' }] } }), { status: 403, headers: { 'retry-after': '2' } });
    await expect(classifyFailure(quota, 1, () => 0)).resolves.toEqual({ kind: 'retry', reason: 'retry_scheduled', delayMs: 2000 });
    const policy = new Response(JSON.stringify({ error: { errors: [{ reason: 'forbidden', message: 'private detail' }] } }), { status: 403 });
    await expect(classifyFailure(policy, 1)).resolves.toEqual({ kind: 'permanent', reason: 'google_request_rejected' });
    await expect(classifyFailure(new Response('not json', { status: 429 }), 1, () => 0)).resolves.toMatchObject({ kind: 'retry' });
  });

  // retry the same id when a successful insert body cannot be confirmed
  it('treats malformed success plus failed reconciliation as unknown', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      // return an unusable insert acknowledgement before losing exact get
      if (calls === 1) return new Response('{}', { status: 200 });
      throw new Error('reconciliation unavailable');
    });
    await expect(deliverGoogleEvent(fetcher as typeof fetch, 'token', ready, () => 0)).resolves.toEqual({ kind: 'retry', reason: 'retry_scheduled', delayMs: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
