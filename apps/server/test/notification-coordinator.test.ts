import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { captureNotificationInventory, displayNotificationEvent, disposeNotificationCoordinator, listenForWorkerNotificationDisplays, reconcileNotificationSnapshot } from '../../web/src/notification-coordinator.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const otherEpoch = '22222222-2222-4222-8222-222222222222';

// keep a complete server event while varying its exact identity
const event = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, entityId: 'agent:one', agentId: 'one', eventId: 'turn-one', eventEpoch: epoch, eventSequence: 2, generatedAt: 1_800_000_000_000, kind: 'finished' as const, tag: 'agent-status-one', displayTag: 'rac-v1-agent-status-one', url: '/#agent=one', ...overrides });

// expose only the worker inventory's content-free fields
const entry = (overrides: Record<string, unknown> = {}) => ({ displayTag: 'rac-v1-agent-status-one', entityId: 'agent:one', eventId: 'turn-one', eventEpoch: epoch, eventSequence: 2, kind: 'finished' as const, ...overrides });

type Message = { operation: string; requestId: string; snapshotToken?: string; cursor?: string; event?: ReturnType<typeof event>; entries?: ReturnType<typeof entry>[] };
type Reply = Record<string, unknown>;

// exercise the page protocol without replacing its ownership or relevance logic
const browser = (respond: (message: Message) => Reply | Promise<Reply>) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const messages: Message[] = [];
  class Channel {
    port1 = { onmessage: null as ((message: { data: unknown }) => void) | null, close: vi.fn() };
    port2 = { postMessage: (data: unknown) => { queueMicrotask(() => this.port1.onmessage?.({ data })); } };
  }
  const registration = {
    active: { postMessage: (message: Message, ports: Channel['port2'][]) => {
      messages.push(structuredClone(message));
      void Promise.resolve(respond(message)).then(reply => ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, ...reply }));
    } },
    getNotifications: vi.fn(async () => []),
    showNotification: vi.fn(async () => undefined)
  };
  class NotificationFixture { static permission = 'granted'; }
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('MessageChannel', Channel);
  vi.stubGlobal('Notification', NotificationFixture);
  const serviceWorkers = Object.assign(new EventTarget(), { getRegistration: async () => registration, ready: Promise.resolve(registration) });
  vi.stubGlobal('navigator', { serviceWorker: serviceWorkers });
  return { messages, registration, serviceWorkers };
};

// acknowledge exact closure with the caller's snapshot boundary
const reconciled = (message: Message): Reply => ({ outcome: 'closed', audibleClaim: false, snapshotToken: message.snapshotToken });

// release page-owned requests before restoring the browser globals
afterEach(() => {
  disposeNotificationCoordinator();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cold notification inventory', () => {
  // a remotely read turn loses its completion id but advances its same-process revision
  it('closes a cold exact-read completion without page enumeration', async () => {
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [entry()] } : reconciled(message));
    const inventory = await captureNotificationInventory();
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'finished', unread: false, notificationState: { eventEpoch: epoch, eventSequence: 3 } }], 'fresh-after-inventory', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile').map(message => message.entries)).toEqual([[entry()]].map(entries => entries.map(({ entityId: _entity, kind: _kind, ...exact }) => exact)));
    expect(harness.registration.getNotifications).not.toHaveBeenCalled();
  });

  // fresh comparable progression proves a question resolved while no window existed
  it('closes a resolved cold question and a removed Agent', async () => {
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [entry({ kind: 'question' }), entry({ displayTag: 'rac-v1-agent-status-removed', entityId: 'agent:removed', eventId: 'removed-question', kind: 'question' })] } : reconciled(message));
    const inventory = await captureNotificationInventory();
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'working', notificationState: { eventEpoch: epoch, eventSequence: 3 } }], 'resolved', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile').flatMap(message => message.entries ?? [])).toHaveLength(2);
  });

  // unknown epochs and future revisions are not evidence of resolution
  it.each(['unread', 'pending', 'cross-epoch', 'future', 'unknown-entity'] as const)('retains a cold %s alert', async mode => {
    const stored = entry(mode === 'unknown-entity' ? { entityId: 'future:one' } : {});
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [stored] } : reconciled(message));
    const inventory = await captureNotificationInventory();
    const current = mode === 'unread' || mode === 'pending'
      ? { id: 'one', attention: 'finished' as const, unread: mode === 'unread', completionId: 'turn-one', notificationEvent: event(), notificationState: { eventEpoch: epoch, eventSequence: 2 } }
      : { id: 'one', attention: 'working' as const, unread: false, notificationState: { eventEpoch: mode === 'cross-epoch' ? otherEpoch : epoch, eventSequence: mode === 'future' ? 1 : 3 } };
    await reconcileNotificationSnapshot([current], mode, inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
  });

  // capture every bounded page before the authoritative read used for classification
  it('paginates more than one hundred identities before closing exact entries', async () => {
    const entries = Array.from({ length: 205 }, (_, index) => entry({ displayTag: `rac-v1-agent-${String(index).padStart(3, '0')}`, entityId: `agent:removed-${index}`, eventId: `turn-${index}` }));
    const harness = browser(message => {
      // serve successive stable actual-tag pages
      if (message.operation === 'inventory') {
        const remaining = entries.filter(value => message.cursor === undefined || value.displayTag > message.cursor);
        const page = remaining.slice(0, 100);
        return { outcome: 'listed', audibleClaim: false, entries: page, ...(remaining.length > page.length ? { nextCursor: page.at(-1)!.displayTag } : {}) };
      }
      return reconciled(message);
    });
    const inventory = await captureNotificationInventory();
    expect(harness.messages.map(message => message.operation)).toEqual(['inventory', 'inventory', 'inventory']);
    await reconcileNotificationSnapshot([], 'after-all-pages', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile').map(message => message.entries?.length)).toEqual([100, 100, 5]);
  });

  // a newly displayed lower tag must invalidate an in-flight continuation
  it.each(['removed', 'resolved'] as const)('restarts partial inventory before a lower tag is %s', async mode => {
    const entries = Array.from({ length: 22 }, (_, index) => entry({ displayTag: `rac-v1-z-${String(index).padStart(3, '0')}`, entityId: `future:${index}` }));
    let deferContinuation = false;
    let release!: (reply: Reply) => void;
    const waiting = new Promise<Reply>(resolve => { release = resolve; });
    const harness = browser(message => {
      // hold one continuation while the worker publishes a lower tag
      if (message.operation === 'inventory') {
        if (deferContinuation) { deferContinuation = false; return waiting; }
        const remaining = entries.filter(value => message.cursor === undefined || value.displayTag > message.cursor);
        const page = remaining.slice(0, 1);
        return { outcome: 'listed', audibleClaim: false, entries: page, ...(remaining.length > page.length ? { nextCursor: page.at(-1)!.displayTag } : {}) };
      }
      return reconciled(message);
    });
    const partial = await captureNotificationInventory();
    expect(partial?.entries).toHaveLength(20);
    deferContinuation = true;
    const inFlight = captureNotificationInventory();
    await vi.waitFor(() => expect(harness.messages.filter(message => message.operation === 'inventory')).toHaveLength(21));
    const refresh = vi.fn();
    const stop = listenForWorkerNotificationDisplays(refresh);
    const lower = entry({ displayTag: 'rac-v1-a-lower' });
    entries.unshift(lower);
    const { kind: _kind, ...identity } = lower;
    harness.serviceWorkers.dispatchEvent(new MessageEvent('message', { data: { type: 'rac-notification-displayed', protocolVersion: 1, ...identity } }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
    release({ outcome: 'listed', audibleClaim: false, entries: [entries.at(-1)!] });
    expect(await inFlight).toBeUndefined();
    const restartedAt = harness.messages.length;
    const inventory = await captureNotificationInventory();
    expect(harness.messages[restartedAt]?.cursor).toBeUndefined();
    expect(inventory?.entries[0]).toEqual(lower);
    const agents = mode === 'removed' ? [] : [{ id: 'one', attention: 'working' as const, notificationState: { eventEpoch: epoch, eventSequence: 3 } }];
    await reconcileNotificationSnapshot(agents, `after-lower-${mode}`, inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile').flatMap(message => message.entries ?? []).map(value => value.displayTag)).toEqual([lower.displayTag]);
    stop();
  });

  // valid inventory pages can still exceed one close request when combined
  it('keeps combined Unicode reconciliation chunks inside the byte bound', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry({ displayTag: `rac-v1-${'😀'.repeat(120)}-${String(index).padStart(3, '0')}`, entityId: `agent:removed-${index}`, eventId: 'x'.repeat(120) + index, eventEpoch: 'e'.repeat(64) }));
    const harness = browser(message => {
      // keep each inventory reply below its independent response bound
      if (message.operation === 'inventory') {
        const remaining = entries.filter(value => message.cursor === undefined || value.displayTag > message.cursor);
        const page = remaining.slice(0, 25);
        return { outcome: 'listed', audibleClaim: false, entries: page, ...(remaining.length > page.length ? { nextCursor: page.at(-1)!.displayTag } : {}) };
      }
      return reconciled(message);
    });
    const inventory = await captureNotificationInventory();
    await reconcileNotificationSnapshot([], 'unicode', inventory);
    const closes = harness.messages.filter(message => message.operation === 'reconcile');
    expect(closes.flatMap(message => message.entries ?? [])).toHaveLength(100);
    expect(closes.every(message => Buffer.byteLength(JSON.stringify(message)) <= 65_536)).toBe(true);
    expect(closes.length).toBeGreaterThan(1);
  });

  // an invalid worker response must never become destructive authority
  it.each(['extra-field', 'oversized', 'byte-oversized', 'wrong-kind', 'looping-cursor', 'enumeration-failed'] as const)('rejects %s inventory without closing', async mode => {
    const harness = browser(() => ({ outcome: mode === 'enumeration-failed' ? 'unavailable' : 'listed', audibleClaim: false, entries: mode === 'oversized' ? Array.from({ length: 101 }, () => entry()) : mode === 'byte-oversized' ? Array.from({ length: 100 }, (_, index) => entry({ entityId: `agent:${'😀'.repeat(120)}`, displayTag: `rac-v1-${'😀'.repeat(120)}${index}`, eventId: 'x'.repeat(128), eventEpoch: 'e'.repeat(64) })) : [entry(mode === 'extra-field' ? { body: 'private question' } : mode === 'wrong-kind' ? { kind: 'future' } : {})], ...(mode === 'looping-cursor' ? { nextCursor: '' } : {}) }));
    const pending = captureNotificationInventory();
    await vi.advanceTimersByTimeAsync(1_501);
    const inventory = await pending;
    await reconcileNotificationSnapshot([], 'invalid-inventory', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
  });

  // a cold unknown epoch becomes superseded only after a separately observed working bridge
  it('retains an unknown epoch until its observed working turn produces a new identity', async () => {
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [entry()] } : reconciled(message));
    const inventory = await captureNotificationInventory();
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'working', notificationState: { eventEpoch: otherEpoch, eventSequence: 1 } }], 'cold-working', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'finished', unread: true, completionId: 'new-turn', notificationEvent: event({ eventId: 'new-turn', eventEpoch: otherEpoch }), notificationState: { eventEpoch: otherEpoch, eventSequence: 2 } }], 'new-turn');
    expect(harness.messages.filter(message => message.operation === 'reconcile').flatMap(message => message.entries ?? []).map(value => value.eventId)).toEqual(['turn-one']);
  });

  // comparable equal-sequence conflicts cannot borrow cross-epoch bridge authority
  it.each(['finished', 'question'] as const)('retains an inventoried %s conflict until strictly newer progression', async kind => {
    const stored = entry({ kind });
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [stored] } : reconciled(message));
    const inventory = await captureNotificationInventory();
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'working', notificationState: { eventEpoch: epoch, eventSequence: 1 } }], 'older-working', inventory);
    const conflicting = event({ kind, eventId: 'equal-conflicting-turn' });
    await reconcileNotificationSnapshot([{ id: 'one', attention: kind, unread: true, completionId: conflicting.eventId, notificationEvent: conflicting, notificationState: { eventEpoch: epoch, eventSequence: 2 } }], 'equal-conflict');
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
    const newer = { ...conflicting, eventId: 'strictly-newer-turn', eventSequence: 3 };
    await reconcileNotificationSnapshot([{ id: 'one', attention: kind, unread: true, completionId: newer.eventId, notificationEvent: newer, notificationState: { eventEpoch: epoch, eventSequence: 3 } }], 'strictly-newer');
    // both previously observed identities are now strictly older
    expect(harness.messages.filter(message => message.operation === 'reconcile').flatMap(message => message.entries ?? []).map(value => value.eventId)).toEqual(['equal-conflicting-turn', 'turn-one']);
  });

  // the newer snapshot owns all remaining chunks after a delayed old acknowledgement
  it('does not dispatch remaining reconcile chunks after snapshot supersession', async () => {
    const entries = Array.from({ length: 205 }, (_, index) => entry({ displayTag: `rac-v1-agent-${String(index).padStart(3, '0')}`, entityId: `agent:removed-${index}`, eventId: `turn-${index}` }));
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const harness = browser(message => {
      // preserve bounded inventory pages while delaying only the old close
      if (message.operation === 'inventory') {
        const remaining = entries.filter(value => message.cursor === undefined || value.displayTag > message.cursor);
        const page = remaining.slice(0, 100);
        return { outcome: 'listed', audibleClaim: false, entries: page, ...(remaining.length > page.length ? { nextCursor: page.at(-1)!.displayTag } : {}) };
      }
      // keep the old request in flight until a newer snapshot takes over
      if (message.snapshotToken === 'old') return barrier.then(() => reconciled(message));
      return reconciled(message);
    });
    const inventory = await captureNotificationInventory();
    const old = reconcileNotificationSnapshot([], 'old', inventory);
    await vi.waitFor(() => expect(harness.messages.some(message => message.snapshotToken === 'old')).toBe(true));
    await reconcileNotificationSnapshot([], 'new');
    release();
    await old;
    expect(harness.messages.filter(message => message.snapshotToken === 'old')).toHaveLength(1);
  });

  // a worker-reported future Agent is not removed merely because an older snapshot omitted it
  it('does not classify newly inventoried B against a previously accepted snapshot', async () => {
    const harness = browser(message => message.operation === 'inventory' ? { outcome: 'listed', audibleClaim: false, entries: [entry()] } : reconciled(message));
    await reconcileNotificationSnapshot([], 'old-before-B');
    const inventory = await captureNotificationInventory();
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
    await reconcileNotificationSnapshot([{ id: 'one', attention: 'finished', unread: true, completionId: 'turn-one', notificationEvent: event(), notificationState: { eventEpoch: epoch, eventSequence: 2 } }], 'new-after-B', inventory);
    expect(harness.messages.filter(message => message.operation === 'reconcile')).toEqual([]);
  });
});

describe('page sound ownership', () => {
  // use the worker's exact displayed tag rather than its occupied logical slot
  it('targets the actual compatibility tag after rejected custom sound', async () => {
    const original = event();
    const identity = [String(original.schemaVersion), original.entityId, original.eventId, original.eventEpoch, String(original.eventSequence)].map(value => `${Buffer.byteLength(value)}:${value}`).join('');
    const compatibility = `rac-v1-compat-${createHash('sha256').update(identity).digest().subarray(0, 16).toString('base64url')}`;
    const harness = browser(message => ({ outcome: 'displayed', audibleClaim: message.operation === 'display', eventId: original.eventId, eventEpoch: original.eventEpoch, eventSequence: original.eventSequence, displayTag: message.operation === 'display' ? compatibility : message.event?.displayTag }));
    await displayNotificationEvent({ event: original, title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => true, playCustomSound: async () => false });
    expect(harness.messages.find(message => message.operation === 'sound-fallback')?.event?.displayTag).toBe(compatibility);
  });

  // a local mute after the display request overrides its initial sound intent
  it('does not play or request native fallback after a later mute', async () => {
    let soundEnabled = true;
    const original = event();
    const harness = browser(() => {
      soundEnabled = false;
      return { outcome: 'displayed', audibleClaim: true, eventId: original.eventId, eventEpoch: original.eventEpoch, eventSequence: original.eventSequence, displayTag: original.displayTag };
    });
    const play = vi.fn(async () => false);
    await displayNotificationEvent({ event: original, title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => soundEnabled, playCustomSound: play });
    expect(play).not.toHaveBeenCalled();
    expect(harness.messages.map(message => message.operation)).toEqual(['display']);
  });

  // a mute during rejected custom playback prevents a later native request
  it('rechecks local mute after custom playback settles', async () => {
    let soundEnabled = true;
    const original = event();
    const harness = browser(() => ({ outcome: 'displayed', audibleClaim: true, eventId: original.eventId, eventEpoch: original.eventEpoch, eventSequence: original.eventSequence, displayTag: original.displayTag }));
    await displayNotificationEvent({ event: original, title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => soundEnabled, playCustomSound: async () => { soundEnabled = false; return false; } });
    expect(harness.messages.map(message => message.operation)).toEqual(['display']);
    expect(harness.registration.showNotification).not.toHaveBeenCalled();
  });

  // a mute while the worker refuses fallback keeps the direct fail-open silent
  it('rechecks local mute before a direct audible fail-open', async () => {
    let soundEnabled = true;
    let release!: (reply: Reply) => void;
    const waiting = new Promise<Reply>(resolve => { release = resolve; });
    const original = event();
    const harness = browser(message => message.operation === 'sound-fallback' ? waiting : { outcome: 'displayed', audibleClaim: true, eventId: original.eventId, eventEpoch: original.eventEpoch, eventSequence: original.eventSequence, displayTag: original.displayTag });
    const displayed = displayNotificationEvent({ event: original, title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => soundEnabled, playCustomSound: async () => false });
    await vi.waitFor(() => expect(harness.messages.some(message => message.operation === 'sound-fallback')).toBe(true));
    soundEnabled = false;
    release({ outcome: 'unavailable', audibleClaim: false });
    await displayed;
    expect(harness.registration.showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ silent: true }));
  });

  // the direct constructor must observe a mute during its registration wait
  it('rechecks mute at the window constructor after unavailable registration', async () => {
    let soundEnabled = true;
    let release!: () => void;
    const waiting = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
    browser(() => ({ outcome: 'unavailable', audibleClaim: false }));
    const direct = vi.fn();
    class DirectNotification {
      static permission = 'granted';
      // capture the final native constructor options
      constructor(title: string, options: NotificationOptions) { direct(title, options); }
    }
    vi.stubGlobal('Notification', DirectNotification);
    let lookups = 0;
    const lookup = vi.fn(async () => {
      lookups += 1;
      // stall only the final fail-open registration boundary
      return lookups === 1 ? undefined : await waiting;
    });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: lookup } });
    const displayed = displayNotificationEvent({ event: event(), title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => soundEnabled, playCustomSound: async () => false });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    soundEnabled = false;
    release();
    expect(await displayed).toBe(true);
    expect(direct).toHaveBeenCalledOnce();
    expect(direct).toHaveBeenCalledWith('Done', expect.objectContaining({ silent: true }));
  });

  // a mismatched acknowledgement cannot grant audible ownership of another event
  it('fails open non-destructively after an acknowledgement identity mismatch', async () => {
    const harness = browser(() => ({ outcome: 'displayed', audibleClaim: true, eventId: 'different-turn', eventEpoch: epoch, eventSequence: 2, displayTag: 'rac-v1-agent-status-one' }));
    const play = vi.fn(async () => true);
    const displayed = displayNotificationEvent({ event: event(), title: 'Done', body: 'Ready', soundRequested: true, soundStillRequested: () => true, playCustomSound: play });
    await vi.advanceTimersByTimeAsync(1_501);
    await displayed;
    expect(play).not.toHaveBeenCalled();
    expect(harness.registration.showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ tag: expect.stringMatching(/^rac-v1-failopen-/u) }));
  });
});
