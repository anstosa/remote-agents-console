import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
const origin = 'https://agents.example.com';

type NotificationOptions = Record<string, unknown> & { data?: Record<string, unknown>; tag?: string };
type StoredNotification = NotificationOptions & { title: string; body?: string; close: ReturnType<typeof vi.fn> };

// create one strict event fixture
function strictEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-a',
    eventEpoch: '11111111-1111-4111-8111-111111111111',
    eventSequence: 1,
    entityId: 'agent:agent-a',
    generatedAt: 1_800_000_000_000,
    kind: 'question',
    agentId: 'agent-a',
    tag: 'agent-status-agent-a',
    displayTag: 'rac-v1-agent-status-agent-a',
    url: '/#agent=agent-a',
    worktreeId: 'worktree-a',
    title: 'Question in Remote Agents',
    body: 'Choose a deployment target?',
    ...overrides
  };
}

// create one browser-retained notification fixture
function storedNotification(event: ReturnType<typeof strictEvent>, data: Record<string, unknown> = event): StoredNotification {
  return {
    title: event.title as string,
    body: event.body as string,
    tag: event.displayTag as string,
    silent: true,
    data: structuredClone(data),
    close: vi.fn()
  };
}

// mirror the frozen worker and page compatibility digest
function compatibilityTag(event: Record<string, unknown>) {
  const canonical = [String(event.schemaVersion), event.entityId, event.eventId, event.eventEpoch, String(event.eventSequence)]
    .map(value => `${Buffer.byteLength(String(value), 'utf8')}:${String(value)}`)
    .join('');
  return `rac-v1-compat-${createHash('sha256').update(canonical).digest().subarray(0, 16).toString('base64url')}`;
}

// expose deterministic promise barriers
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

// provide a small IndexedDB surface for journal assertions
function diagnosticDatabase() {
  const records = new Map<string, Record<string, unknown>>();
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    close: vi.fn(),
    // complete one readwrite transaction asynchronously
    transaction: () => {
      const transaction: Record<string, unknown> = {};
      const store = {
        // return the current journal snapshot
        getAll: () => {
          const request: Record<string, unknown> = { result: [...records.values()] };
          queueMicrotask(() => {
            (request.onsuccess as (() => void) | undefined)?.();
            queueMicrotask(() => (transaction.oncomplete as (() => void) | undefined)?.());
          });
          return request;
        },
        delete: (id: string) => records.delete(id),
        put: (record: Record<string, unknown>) => records.set(record.id as string, structuredClone(record))
      };
      transaction.objectStore = () => store;
      return transaction;
    }
  };
  const indexedDB = {
    // open the single worker journal database
    open: vi.fn(() => {
      const request: Record<string, unknown> = { result: database };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    })
  };
  return { indexedDB, records };
}

// exercise the shipped worker with mutable browser state
function worker(options: { journal?: ReturnType<typeof diagnosticDatabase>; windows?: boolean } = {}) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const notifications: StoredNotification[] = [];
  const clientMessages: unknown[] = [];
  const showBehaviors: Array<(title: string, options: NotificationOptions) => Promise<void>> = [];
  const getBehaviors: Array<() => Promise<StoredNotification[]>> = [];
  const cachedPreference = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue({ focus });
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const client = { url: `${origin}/`, navigate, focus, postMessage: vi.fn((message: unknown) => clientMessages.push(message)) };
  const clients = { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue(options.windows === false ? [] : [client]), openWindow };
  const storeNotification = async (title: string, rawOptions: NotificationOptions) => {
    const behavior = showBehaviors.shift();
    // run the next injected provider behavior
    if (behavior !== undefined) await behavior(title, rawOptions);
    const notification = { title, body: rawOptions.body as string | undefined, ...structuredClone(rawOptions) } as StoredNotification;
    notification.close = vi.fn(() => {
      const index = notifications.indexOf(notification);
      // remove only this exact displayed instance
      if (index >= 0) notifications.splice(index, 1);
    });
    const existing = typeof notification.tag === 'string' ? notifications.findIndex(candidate => candidate.tag === notification.tag) : -1;
    // replace the exact browser tag
    if (existing >= 0) notifications.splice(existing, 1, notification);
    else notifications.push(notification);
  };
  const showNotification = vi.fn(storeNotification);
  const getNotifications = vi.fn(async () => {
    const behavior = getBehaviors.shift();
    return behavior === undefined ? [...notifications] : await behavior();
  });
  const self = {
    // retain registered event handlers
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients,
    crypto: webcrypto,
    location: { origin },
    registration: { showNotification, getNotifications }
  };
  runInNewContext(source, {
    self,
    clients,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    caches: { match: cachedPreference },
    indexedDB: options.journal?.indexedDB,
    structuredClone
  });
  // start one event without forcing its lifetime to settle
  const start = (name: string, event: Record<string, unknown>) => {
    const promises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => promises.push(promise));
    listeners.get(name)!({ ...event, waitUntil });
    return { promises, waitUntil };
  };
  // await every lifetime promise for one event
  const dispatch = async (name: string, event: Record<string, unknown>) => {
    const started = start(name, event);
    await Promise.all(started.promises);
    return started;
  };
  // send one same-origin page RPC and capture its acknowledgement
  const message = async (data: Record<string, unknown>, sourceUrl = `${origin}/`) => {
    const replies: unknown[] = [];
    await dispatch('message', { data, source: { url: sourceUrl }, ports: [{ postMessage: (reply: unknown) => replies.push(reply) }] });
    return replies[0] as Record<string, unknown>;
  };
  // deliver one JSON push
  const push = async (data: Record<string, unknown>) => await dispatch('push', { data: { json: () => data } });
  return { dispatch, start, message, push, showNotification, getNotifications, notifications, showBehaviors, getBehaviors, navigate, focus, openWindow, cachedPreference, clientMessages };
}

// preserve legacy delivery while adding strict worker arbitration
describe('push service worker', () => {
  // honor cached mute without suppressing legacy visibility
  it.each([false, true])('displays legacy notifications with cached sound muting set to %s', async muted => {
    const harness = worker();
    harness.cachedPreference.mockResolvedValue(muted ? {} : undefined);
    await harness.push({ title: 'Done' });
    expect(harness.showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ silent: muted }));
  });

  // preserve delivery across malformed payload and preference failures
  it('uses legacy defaults when JSON and preference storage fail', async () => {
    const harness = worker();
    harness.cachedPreference.mockRejectedValue(new Error('cache unavailable'));
    await harness.dispatch('push', { data: { json: () => { throw new Error('invalid json'); } } });
    expect(harness.showNotification).toHaveBeenCalledWith('Remote Agent Console', expect.objectContaining({
      body: 'An agent is ready.',
      silent: false,
      requireInteraction: false,
      data: { url: '/', kind: undefined, worktreeId: undefined }
    }));
  });

  // show strict pushes with no window client dependency
  it('displays a strict push under its versioned tag with no window client', async () => {
    const harness = worker({ windows: false });
    harness.cachedPreference.mockResolvedValue({});
    const event = strictEvent();
    const lifetime = await harness.push(event);
    expect(lifetime.waitUntil).toHaveBeenCalledOnce();
    expect(harness.showNotification).toHaveBeenCalledWith(event.title, expect.objectContaining({
      body: event.body,
      tag: event.displayTag,
      silent: true,
      requireInteraction: true,
      timestamp: event.generatedAt,
      data: expect.objectContaining({ eventId: event.eventId, eventEpoch: event.eventEpoch, eventSequence: event.eventSequence, tag: event.tag, logicalTag: event.tag, displayTag: event.displayTag, nativeFallbackAttempted: false })
    }));
    expect(harness.clientMessages).toEqual([]);
  });

  // post only content-free event identity after push display
  it('posts a content-free display event to controlled clients', async () => {
    const harness = worker();
    const event = strictEvent();
    await harness.push(event);
    expect(harness.clientMessages).toEqual([{
      type: 'rac-notification-displayed', protocolVersion: 1, eventId: event.eventId, eventEpoch: event.eventEpoch,
      eventSequence: event.eventSequence, entityId: event.entityId, displayTag: event.displayTag
    }]);
    expect(JSON.stringify(harness.clientMessages)).not.toContain(event.title);
    expect(JSON.stringify(harness.clientMessages)).not.toContain(event.body);
    expect(JSON.stringify(harness.clientMessages)).not.toContain(event.url);
  });

  // preserve normal multiline structured question presentation
  it('keeps tabs and newlines in strict question bodies', async () => {
    const harness = worker({ windows: false });
    const event = strictEvent({ body: 'First line\n\tSecond line\r\nThird line' });
    await harness.push(event);
    expect(harness.showNotification).toHaveBeenCalledWith(event.title, expect.objectContaining({ body: event.body, tag: event.displayTag }));
    expect(harness.notifications[0]?.data).toEqual(expect.objectContaining({ eventId: event.eventId }));
  });

  // preserve a strict current event across duplicates and delayed pushes
  it('handles A to B to A with quiet exact replacement and compatibility visibility', async () => {
    const harness = worker();
    const eventA = strictEvent();
    const eventB = strictEvent({ eventId: 'event-b', eventSequence: 2, kind: 'finished', title: 'Done', body: 'Ready' });
    await harness.push(eventA);
    await harness.push(eventA);
    expect(harness.showNotification.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ tag: eventA.displayTag, silent: true, renotify: false }));
    await harness.push(eventB);
    await harness.push(eventA);
    const strict = harness.notifications.find(notification => notification.tag === eventA.displayTag);
    const compatible = harness.notifications.find(notification => notification.tag?.startsWith('rac-v1-compat-'));
    expect(strict?.data).toEqual(expect.objectContaining({ eventId: 'event-b', eventSequence: 2 }));
    expect(compatible?.tag).toBe(compatibilityTag(eventA));
    expect(compatible?.data).toEqual(expect.objectContaining({ eventId: 'event-a', eventSequence: 1 }));
    expect(compatible).toEqual(expect.objectContaining({ silent: true, renotify: false }));
  });

  // keep conflicts and incomparable epochs off the strict current tag
  it.each([
    ['equal sequence conflict', { eventId: 'event-conflict', eventSequence: 2 }],
    ['cross epoch', { eventId: 'event-new-epoch', eventEpoch: '22222222-2222-4222-8222-222222222222', eventSequence: 1 }]
  ])('uses compatibility visibility for %s', async (_label, overrides) => {
    const harness = worker();
    const current = strictEvent({ eventId: 'event-b', eventSequence: 2 });
    await harness.push(current);
    await harness.push(strictEvent(overrides));
    expect(harness.notifications.find(notification => notification.tag === current.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));
    expect(harness.notifications.some(notification => notification.tag?.startsWith('rac-v1-compat-'))).toBe(true);
  });

  // retain strict current state beside legacy namespaces
  it('keeps a legacy push visible without replacing strict current state', async () => {
    const harness = worker();
    await harness.push(strictEvent());
    await harness.push({ title: 'Legacy', tag: 'agent-status-agent-a', kind: 'finished', url: '/#agent=agent-a' });
    expect(harness.notifications.map(notification => notification.tag).sort()).toEqual(['agent-status-agent-a', 'rac-v1-agent-status-agent-a']);
  });

  // retain separate identityless future alerts beside strict current state
  it('omits tags for incomplete versioned identities without replacing strict current', async () => {
    const harness = worker();
    const current = strictEvent();
    await harness.push(current);
    await harness.push({ schemaVersion: 2, title: 'Future one', body: 'First future alert', tag: 'rac-v1-future' });
    await harness.push({ schemaVersion: 2, title: 'Future two', body: 'Second future alert', tag: 'rac-v1-future' });
    await harness.push({ schemaVersion: 1, title: 'Malformed current', body: 'Missing identity', tag: current.displayTag });
    const loose = harness.notifications.filter(notification => notification.tag === undefined);
    expect(loose.map(notification => notification.title)).toEqual(['Future one', 'Future two', 'Malformed current']);
    expect(harness.showNotification.mock.calls.slice(1).every(call => !Object.hasOwn(call[1] as object, 'tag'))).toBe(true);
    expect(harness.notifications.find(notification => notification.tag === current.displayTag)?.data).toEqual(expect.objectContaining({ eventId: current.eventId }));
  });

  // preserve deterministic compatibility identity for complete future tuples
  it('uses a content-free compatibility tag for a complete future identity', async () => {
    const harness = worker();
    const future = strictEvent({ schemaVersion: 2, title: 'Future alert', body: 'Future presentation' });
    await harness.push(future);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.tag).toBe(compatibilityTag(future));
    expect(harness.notifications[0]?.tag).not.toContain('Future');
  });

  // grant only one page-origin audible claim
  it('returns an audible claim for a new page display and quietly deduplicates it', async () => {
    const harness = worker();
    const event = strictEvent();
    const first = await harness.message({ protocolVersion: 1, requestId: 'display-a', operation: 'display', event, soundRequested: true });
    const duplicate = await harness.message({ protocolVersion: 1, requestId: 'display-a-again', operation: 'display', event, soundRequested: true });
    expect(first).toEqual(expect.objectContaining({ outcome: 'displayed', audibleClaim: true, displayTag: event.displayTag }));
    expect(duplicate).toEqual(expect.objectContaining({ outcome: 'duplicate', audibleClaim: false }));
    expect(harness.showNotification).toHaveBeenCalledOnce();
    expect(harness.showNotification.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ silent: true }));
  });

  // avoid audible claims when preference state is unavailable
  it('retains display and the page sound claim when preference storage fails', async () => {
    const harness = worker();
    harness.cachedPreference.mockRejectedValue(new Error('cache unavailable'));
    const reply = await harness.message({ protocolVersion: 1, requestId: 'display-a', operation: 'display', event: strictEvent(), soundRequested: true });
    expect(reply).toEqual(expect.objectContaining({ outcome: 'displayed', audibleClaim: true }));
    expect(harness.showNotification).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ silent: true }));
  });

  // re-read exact identity after a newer queued display settles
  it('does not let a raced close for A remove B', async () => {
    const harness = worker();
    const eventA = strictEvent();
    const eventB = strictEvent({ eventId: 'event-b', eventSequence: 2, title: 'Done', body: 'Ready', kind: 'finished' });
    await harness.push(eventA);
    const barrier = deferred();
    harness.showBehaviors.push(async () => await barrier.promise);
    const displayB = harness.start('message', {
      data: { protocolVersion: 1, requestId: 'display-b', operation: 'display', event: eventB, soundRequested: true }, source: { url: `${origin}/` }, ports: [{ postMessage: vi.fn() }]
    });
    const closeReplies: unknown[] = [];
    const closeA = harness.start('message', {
      data: { protocolVersion: 1, requestId: 'close-a', operation: 'close', event: eventA }, source: { url: `${origin}/` }, ports: [{ postMessage: (reply: unknown) => closeReplies.push(reply) }]
    });
    await vi.waitFor(() => expect(harness.showNotification).toHaveBeenCalledTimes(2));
    expect(harness.getNotifications).toHaveBeenCalledTimes(2);
    barrier.resolve();
    await Promise.all([...displayB.promises, ...closeA.promises]);
    expect(closeReplies[0]).toEqual(expect.objectContaining({ outcome: 'retained', eventId: 'event-a' }));
    expect(harness.notifications.find(notification => notification.tag === eventA.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));
  });

  // recover the queue after enumeration rejects
  it('runs B on the same worker after A enumeration rejects', async () => {
    const harness = worker();
    const barrier = deferred<StoredNotification[]>();
    harness.getBehaviors.push(async () => await barrier.promise);
    const close = harness.message({ protocolVersion: 1, requestId: 'close-a', operation: 'close', event: strictEvent() });
    const display = harness.message({ protocolVersion: 1, requestId: 'display-b', operation: 'display', event: strictEvent({ eventId: 'event-b', eventSequence: 2 }), soundRequested: true });
    await vi.waitFor(() => expect(harness.getNotifications).toHaveBeenCalledOnce());
    expect(harness.showNotification).not.toHaveBeenCalled();
    barrier.reject(new Error('enumeration failed'));
    await expect(close).resolves.toEqual(expect.objectContaining({ outcome: 'unavailable' }));
    await expect(display).resolves.toEqual(expect.objectContaining({ outcome: 'displayed' }));
    expect(harness.showNotification).toHaveBeenCalledOnce();
  });

  // minimal presentation retries retain exact cleanup and sound-fallback ownership
  it('retains strict identity after a minimal retry succeeds', async () => {
    const harness = worker();
    const event = strictEvent();
    harness.showBehaviors.push(async () => { throw new Error('optional presentation failed'); });
    const display = await harness.message({ protocolVersion: 1, requestId: 'minimal-a', operation: 'display', event, soundRequested: true });
    expect(display).toEqual(expect.objectContaining({ outcome: 'displayed', audibleClaim: true }));
    expect(harness.notifications[0]?.data).toEqual(expect.objectContaining({ eventId: event.eventId, eventEpoch: event.eventEpoch, eventSequence: event.eventSequence, displayTag: event.displayTag }));
    const sound = await harness.message({ protocolVersion: 1, requestId: 'minimal-sound-a', operation: 'sound-fallback', event });
    expect(sound).toEqual(expect.objectContaining({ outcome: 'displayed' }));
    expect(harness.notifications[0]?.silent).toBe(false);
    const close = await harness.message({ protocolVersion: 1, requestId: 'minimal-close-a', operation: 'close', event });
    expect(close).toEqual(expect.objectContaining({ outcome: 'closed' }));
    expect(harness.notifications).toHaveLength(0);
  });

  // recover the queue after both visible attempts reject
  it('runs B on the same worker after A exhausts primary and minimal display', async () => {
    const harness = worker();
    const barrier = deferred();
    harness.showBehaviors.push(async () => { throw new Error('primary failed'); }, async () => await barrier.promise);
    const failedA = harness.start('push', { data: { json: () => strictEvent() } });
    const successfulB = harness.start('push', { data: { json: () => strictEvent({ eventId: 'event-b', eventSequence: 2 }) } });
    const failedAResult = expect(Promise.all(failedA.promises)).rejects.toThrow('minimal failed');
    await vi.waitFor(() => expect(harness.showNotification).toHaveBeenCalledTimes(2));
    expect(harness.notifications).toHaveLength(0);
    barrier.reject(new Error('minimal failed'));
    await failedAResult;
    await expect(Promise.all(successfulB.promises)).resolves.toBeDefined();
    expect(harness.showNotification).toHaveBeenCalledTimes(3);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));
  });

  // close only exact identities from reconciliation
  it('reconciles exact entries and retains newer occupants', async () => {
    const harness = worker();
    const eventA = strictEvent();
    await harness.push(strictEvent({ eventId: 'event-b', eventSequence: 2 }));
    const retained = await harness.message({
      protocolVersion: 1, requestId: 'reconcile-a', operation: 'reconcile', snapshotToken: 'snapshot-1',
      entries: [{ displayTag: eventA.displayTag, eventId: eventA.eventId, eventEpoch: eventA.eventEpoch, eventSequence: eventA.eventSequence }]
    });
    expect(retained).toEqual({ protocolVersion: 1, requestId: 'reconcile-a', outcome: 'retained', audibleClaim: false, snapshotToken: 'snapshot-1' });
    expect(harness.notifications).toHaveLength(1);
  });

  // page strict inventory with bounded actual-tag cursors
  it('lists only allowlisted strict identities across 100-entry pages', async () => {
    const harness = worker();
    const expectedTags: string[] = [];
    // seed more identities than one page can return
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const event = strictEvent({
        eventId: `event-${suffix}`,
        eventSequence: index + 1,
        entityId: `agent:agent-${suffix}`,
        agentId: `agent-${suffix}`,
        tag: `agent-status-agent-${suffix}`,
        displayTag: `rac-v1-agent-status-agent-${suffix}`
      });
      expectedTags.push(event.displayTag as string);
      harness.notifications.push(storedNotification(event, { ...event, secret: `private-${suffix}` }));
    }
    const future = strictEvent({ schemaVersion: 2, displayTag: 'rac-v1-future' });
    harness.notifications.push(storedNotification(future));
    harness.notifications.push({ title: 'Legacy', tag: 'legacy-alert', data: { eventId: 'legacy' }, close: vi.fn() });
    const mismatched = strictEvent({ displayTag: 'rac-v1-mismatched-stored' });
    harness.notifications.push({ ...storedNotification(mismatched), tag: 'rac-v1-mismatched-actual' });

    const first = await harness.message({ protocolVersion: 1, requestId: 'inventory-1', operation: 'inventory' });
    const firstEntries = first.entries as Array<Record<string, unknown>>;
    expect(first).toEqual(expect.objectContaining({ outcome: 'listed', audibleClaim: false, nextCursor: expectedTags[99] }));
    expect(firstEntries).toHaveLength(100);
    expect(firstEntries.map(entry => entry.displayTag)).toEqual(expectedTags.slice(0, 100));
    expect(Object.keys(firstEntries[0] ?? {}).sort()).toEqual(['displayTag', 'entityId', 'eventEpoch', 'eventId', 'eventSequence', 'kind']);
    expect(JSON.stringify(first)).not.toContain('private-');
    expect(JSON.stringify(first)).not.toContain('Question in Remote Agents');
    expect(JSON.stringify(first)).not.toContain('/#agent=');

    const second = await harness.message({ protocolVersion: 1, requestId: 'inventory-2', operation: 'inventory', cursor: first.nextCursor });
    expect(second).toEqual({
      protocolVersion: 1,
      requestId: 'inventory-2',
      outcome: 'listed',
      audibleClaim: false,
      entries: [expect.objectContaining({ displayTag: expectedTags[100] })]
    });
  });

  // include valid strict data under compatibility and fail-open tags
  it('lists strict, compatibility, and enumeration fail-open resources', async () => {
    const harness = worker();
    const compatibilityEvent = strictEvent();
    harness.notifications.push({ title: 'Opaque occupant', tag: compatibilityEvent.displayTag as string, data: { url: '/' }, close: vi.fn() });
    const compatibility = await harness.message({ protocolVersion: 1, requestId: 'display-compat', operation: 'display', event: compatibilityEvent, soundRequested: true });
    const failOpenEvent = strictEvent({
      eventId: 'event-fail-open',
      entityId: 'agent:fail-open',
      agentId: 'fail-open',
      tag: 'agent-status-fail-open',
      displayTag: 'rac-v1-agent-status-fail-open'
    });
    harness.getBehaviors.push(async () => { throw new Error('enumeration failed'); });
    await harness.push(failOpenEvent);
    const strict = strictEvent({
      eventId: 'event-strict',
      entityId: 'agent:strict',
      agentId: 'strict',
      tag: 'agent-status-strict',
      displayTag: 'rac-v1-agent-status-strict'
    });
    await harness.push(strict);

    const listed = await harness.message({ protocolVersion: 1, requestId: 'inventory-tags', operation: 'inventory' });
    expect((listed.entries as Array<Record<string, unknown>>).map(entry => entry.displayTag).sort()).toEqual([
      compatibility.displayTag,
      compatibilityTag(failOpenEvent),
      strict.displayTag
    ].sort());
  });

  // stop inventory before its serialized acknowledgement byte ceiling
  it('bounds inventory acknowledgements to 64 KiB', async () => {
    const harness = worker();
    // maximize only allowlisted identity fields
    for (let index = 0; index < 100; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const event = strictEvent({
        eventId: `${suffix}-${'i'.repeat(120)}`,
        eventEpoch: `${suffix}${'p'.repeat(60)}`,
        eventSequence: index + 1,
        entityId: `agent:${suffix}:${'e'.repeat(240)}`,
        agentId: `agent-${suffix}`,
        tag: `agent-status-${suffix}`,
        displayTag: `rac-v1-${suffix}-${'d'.repeat(235)}`
      });
      harness.notifications.push(storedNotification(event));
    }
    const reply = await harness.message({ protocolVersion: 1, requestId: 'inventory-large', operation: 'inventory' });
    const entries = reply.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(100);
    expect(reply.nextCursor).toBe(entries.at(-1)?.displayTag);
    expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  // keep inventory enumeration failures nondestructive and retryable
  it('retains notifications when inventory enumeration fails', async () => {
    const harness = worker();
    const event = strictEvent();
    await harness.push(event);
    harness.getBehaviors.push(async () => { throw new Error('enumeration failed'); });
    const failed = await harness.message({ protocolVersion: 1, requestId: 'inventory-failed', operation: 'inventory' });
    expect(failed).toEqual({ protocolVersion: 1, requestId: 'inventory-failed', outcome: 'unavailable', audibleClaim: false });
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.close).not.toHaveBeenCalled();
    const retried = await harness.message({ protocolVersion: 1, requestId: 'inventory-retry', operation: 'inventory' });
    expect(retried).toEqual(expect.objectContaining({ outcome: 'listed', entries: [expect.objectContaining({ displayTag: event.displayTag })] }));
  });

  // enforce request origin, entry count, and byte bounds
  it('rejects foreign, oversized, and over-count RPCs with content-free acknowledgements', async () => {
    const harness = worker();
    const foreign = await harness.message({ protocolVersion: 1, requestId: 'foreign', operation: 'display', event: strictEvent(), soundRequested: true }, 'https://evil.example/');
    const oversized = await harness.message({ protocolVersion: 1, requestId: 'oversized', operation: 'display', event: strictEvent({ body: 'x'.repeat(9_000) }), soundRequested: true });
    const entries = Array.from({ length: 101 }, (_value, index) => ({ displayTag: `rac-v1-agent-${index}`, eventId: `event-${index}`, eventEpoch: '11111111-1111-4111-8111-111111111111', eventSequence: index + 1 }));
    const overCount = await harness.message({ protocolVersion: 1, requestId: 'over-count', operation: 'reconcile', snapshotToken: 'snapshot-1', entries });
    const invalidCursor = await harness.message({ protocolVersion: 1, requestId: 'bad-cursor', operation: 'inventory', cursor: 'legacy-alert' });
    expect(foreign).toEqual({ protocolVersion: 1, requestId: 'foreign', outcome: 'invalid', audibleClaim: false });
    expect(oversized).toEqual({ protocolVersion: 1, requestId: 'oversized', outcome: 'invalid', audibleClaim: false });
    expect(overCount).toEqual({ protocolVersion: 1, requestId: 'over-count', outcome: 'invalid', audibleClaim: false });
    expect(invalidCursor).toEqual({ protocolVersion: 1, requestId: 'bad-cursor', outcome: 'invalid', audibleClaim: false });
    expect(JSON.stringify([foreign, oversized, overCount, invalidCursor])).not.toContain('Question in Remote Agents');
  });

  // allow one native fallback and preserve the attempt marker
  it('attempts native sound once for exact current A', async () => {
    const harness = worker();
    const event = strictEvent();
    await harness.message({ protocolVersion: 1, requestId: 'display-a', operation: 'display', event, soundRequested: true });
    const first = await harness.message({ protocolVersion: 1, requestId: 'sound-a', operation: 'sound-fallback', event });
    await harness.push(event);
    const second = await harness.message({ protocolVersion: 1, requestId: 'sound-a-again', operation: 'sound-fallback', event });
    expect(first).toEqual(expect.objectContaining({ outcome: 'displayed', audibleClaim: false }));
    expect(second).toEqual(expect.objectContaining({ outcome: 'duplicate', audibleClaim: false }));
    expect(harness.showNotification.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ silent: false, renotify: true, data: expect.objectContaining({ nativeFallbackAttempted: true }) }));
    expect(harness.showNotification.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ silent: true, renotify: false, data: expect.objectContaining({ nativeFallbackAttempted: true }) }));
  });

  // use the acknowledged compatibility resource for one native fallback
  it('attempts native sound once for an exact compatibility display', async () => {
    const harness = worker();
    const event = strictEvent();
    const opaque = { title: 'Opaque occupant', tag: event.displayTag as string, data: { url: '/' }, close: vi.fn() };
    harness.notifications.push(opaque);
    const displayed = await harness.message({ protocolVersion: 1, requestId: 'display-compat', operation: 'display', event, soundRequested: true });
    const actualTag = displayed.displayTag as string;
    const exactCompatibility = { ...event, displayTag: actualTag };
    expect(actualTag).toBe(compatibilityTag(event));

    const first = await harness.message({ protocolVersion: 1, requestId: 'sound-compat', operation: 'sound-fallback', event: exactCompatibility });
    const repeated = await harness.message({ protocolVersion: 1, requestId: 'sound-compat-again', operation: 'sound-fallback', event: exactCompatibility });
    expect(first).toEqual(expect.objectContaining({ outcome: 'displayed', displayTag: actualTag }));
    expect(repeated).toEqual(expect.objectContaining({ outcome: 'duplicate', displayTag: actualTag }));
    expect(harness.showNotification).toHaveBeenCalledTimes(2);
    expect(harness.showNotification.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ tag: actualTag, silent: false, data: expect.objectContaining({ nativeFallbackAttempted: true }) }));
    expect(harness.notifications.find(notification => notification.tag === event.displayTag)).toBe(opaque);
  });

  // fence compatibility sound only behind greater same-epoch progress
  it.each([
    ['newer same epoch', { eventId: 'event-b', eventSequence: 2 }, 'stale', 2],
    ['equal sequence', { eventId: 'event-conflict', eventSequence: 1 }, 'displayed', 3],
    ['different epoch', { eventId: 'event-other-epoch', eventEpoch: '22222222-2222-4222-8222-222222222222', eventSequence: 20 }, 'displayed', 3]
  ])('classifies compatibility fallback with %s', async (_label, overrides, outcome, expectedShows) => {
    const harness = worker();
    const eventA = strictEvent();
    harness.notifications.push({ title: 'Opaque occupant', tag: eventA.displayTag as string, data: { url: '/' }, close: vi.fn() });
    const displayed = await harness.message({ protocolVersion: 1, requestId: 'display-compat', operation: 'display', event: eventA, soundRequested: true });
    const occupiedIndex = harness.notifications.findIndex(notification => notification.tag === eventA.displayTag);
    // replace only the opaque strict occupant
    if (occupiedIndex >= 0) harness.notifications.splice(occupiedIndex, 1);
    await harness.push(strictEvent(overrides));
    const fallback = await harness.message({
      protocolVersion: 1,
      requestId: 'sound-compat',
      operation: 'sound-fallback',
      event: { ...eventA, displayTag: displayed.displayTag }
    });
    expect(fallback).toEqual(expect.objectContaining({ outcome }));
    expect(harness.showNotification).toHaveBeenCalledTimes(expectedShows);
  });

  // honor a mute that changes after compatibility display
  it('refuses muted compatibility sound fallback', async () => {
    const harness = worker();
    const event = strictEvent();
    harness.notifications.push({ title: 'Opaque occupant', tag: event.displayTag as string, data: { url: '/' }, close: vi.fn() });
    const displayed = await harness.message({ protocolVersion: 1, requestId: 'display-compat', operation: 'display', event, soundRequested: true });
    harness.cachedPreference.mockResolvedValue({});
    const muted = await harness.message({
      protocolVersion: 1,
      requestId: 'sound-compat-muted',
      operation: 'sound-fallback',
      event: { ...event, displayTag: displayed.displayTag }
    });
    expect(muted).toEqual(expect.objectContaining({ outcome: 'muted' }));
    expect(harness.showNotification).toHaveBeenCalledOnce();
  });

  // refuse stale and muted native sound without mutating newer state
  it('refuses sound fallback after newer B and after mute', async () => {
    const staleHarness = worker();
    const eventA = strictEvent();
    await staleHarness.push(eventA);
    await staleHarness.push(strictEvent({ eventId: 'event-b', eventSequence: 2 }));
    const stale = await staleHarness.message({ protocolVersion: 1, requestId: 'sound-a', operation: 'sound-fallback', event: eventA });
    expect(stale).toEqual(expect.objectContaining({ outcome: 'stale' }));
    expect(staleHarness.showNotification).toHaveBeenCalledTimes(2);
    const mutedHarness = worker();
    await mutedHarness.push(eventA);
    mutedHarness.cachedPreference.mockResolvedValue({});
    const muted = await mutedHarness.message({ protocolVersion: 1, requestId: 'sound-muted-a', operation: 'sound-fallback', event: eventA });
    expect(muted).toEqual(expect.objectContaining({ outcome: 'muted' }));
    expect(mutedHarness.showNotification).toHaveBeenCalledOnce();
  });

  // recover the shared queue after the native sound provider rejects
  it('runs B after a sound fallback show rejects', async () => {
    const harness = worker();
    const eventA = strictEvent();
    await harness.push(eventA);
    harness.showBehaviors.push(async () => { throw new Error('native sound failed'); });
    const failedSound = harness.message({ protocolVersion: 1, requestId: 'sound-a', operation: 'sound-fallback', event: eventA });
    const eventB = strictEvent({ eventId: 'event-b', eventSequence: 2 });
    const displayB = harness.message({ protocolVersion: 1, requestId: 'display-b', operation: 'display', event: eventB, soundRequested: true });
    await expect(failedSound).resolves.toEqual(expect.objectContaining({ outcome: 'unavailable' }));
    await expect(displayB).resolves.toEqual(expect.objectContaining({ outcome: 'displayed' }));
    expect(harness.notifications[0]?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));
  });

  // record allowlisted worker stages after display initiation
  it('journals receipt and show stages without presentation content', async () => {
    const database = diagnosticDatabase();
    const harness = worker({ journal: database });
    await harness.push(strictEvent());
    await vi.waitFor(() => expect(database.records.size).toBe(3));
    const records = [...database.records.values()];
    expect(records.map(record => record.stage)).toEqual(['worker_received', 'show_started', 'show_succeeded']);
    expect(records.every(record => Object.keys(record).every(key => ['id', 'stage', 'at', 'eventId', 'eventEpoch', 'eventSequence', 'kind', 'status', 'attempt'].includes(key)))).toBe(true);
    expect(JSON.stringify(records)).not.toContain('Question in Remote Agents');
    expect(JSON.stringify(records)).not.toContain('Choose a deployment target');
    expect(JSON.stringify(records)).not.toContain('/#agent=');
  });

  // enforce the worker journal count and age limits
  it('prunes expired diagnostics and caps the journal at 200 records', async () => {
    const database = diagnosticDatabase();
    database.records.set('expired', { id: 'expired', stage: 'worker_received', at: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    const harness = worker({ journal: database });
    // generate enough three-stage legacy displays to exceed the cap
    for (let index = 0; index < 67; index += 1) await harness.push({ title: `Legacy ${index}` });
    await vi.waitFor(() => expect(database.records.size).toBe(200));
    expect(database.records.size).toBe(200);
    expect(database.records.has('expired')).toBe(false);
  });

  // keep the arbiter moving when journal storage never settles
  it('displays later pushes and returns RPC acks while IndexedDB is blocked', async () => {
    const database = diagnosticDatabase();
    database.indexedDB.open.mockImplementation(() => ({}));
    const harness = worker({ journal: database, windows: false });
    const pushA = harness.start('push', { data: { json: () => strictEvent() } });
    await vi.waitFor(() => expect(harness.showNotification).toHaveBeenCalledOnce());
    const pushB = harness.start('push', { data: { json: () => strictEvent({ eventId: 'event-b', eventSequence: 2 }) } });
    await vi.waitFor(() => expect(harness.showNotification).toHaveBeenCalledTimes(2));
    const eventC = strictEvent({ eventId: 'event-c', eventSequence: 3 });
    const acknowledgement = await harness.message({ protocolVersion: 1, requestId: 'display-c', operation: 'display', event: eventC, soundRequested: true });
    await Promise.all([...pushA.promises, ...pushB.promises]);
    expect(harness.showNotification).toHaveBeenCalledTimes(3);
    expect(acknowledgement).toEqual(expect.objectContaining({ outcome: 'displayed', eventId: 'event-c' }));
    expect(harness.notifications[0]?.data).toEqual(expect.objectContaining({ eventId: 'event-c' }));
  });

  // retain visible display when local journal storage fails
  it('does not let diagnostic storage failure block push display', async () => {
    const database = diagnosticDatabase();
    database.indexedDB.open.mockImplementation(() => { throw new Error('storage failed'); });
    const harness = worker({ journal: database });
    await harness.push(strictEvent());
    expect(harness.showNotification).toHaveBeenCalledOnce();
  });

  // preserve original legacy timestamps and safe same-origin click routing
  it('keeps legacy timestamp and refuses cross-origin click routes', async () => {
    const harness = worker();
    const sentAt = Date.now() - 60_000;
    await harness.push({ title: 'Done', sentAt });
    expect(harness.showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ timestamp: sentAt }));
    const close = vi.fn();
    await harness.dispatch('notificationclick', { notification: { close, data: { url: 'https://evil.example/steal' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(`${origin}/`);
    expect(harness.focus).toHaveBeenCalledOnce();
    expect(harness.openWindow).not.toHaveBeenCalled();
  });
});
