import type { NotificationEvent, NotificationState } from '../../server/src/notification-events.js';
import { recordNotificationJournal } from './notification-journal.js';

type NotificationWorkerOutcome = 'displayed' | 'duplicate' | 'stale' | 'muted' | 'not-found' | 'closed' | 'retained' | 'listed' | 'unavailable' | 'invalid';
type NotificationWorkerAck = {
  protocolVersion: 1;
  requestId: string;
  outcome: NotificationWorkerOutcome;
  audibleClaim: boolean;
  eventId?: string;
  eventEpoch?: string;
  eventSequence?: number;
  displayTag?: string;
  snapshotToken?: string;
  entries?: NotificationInventoryEntry[];
  nextCursor?: string;
};
type ExactNotificationEntry = Pick<NotificationEvent, 'displayTag' | 'eventId' | 'eventEpoch' | 'eventSequence'>;
type NotificationIdentity = Pick<NotificationEvent, 'entityId' | 'eventId' | 'eventEpoch' | 'eventSequence'>;
type NotificationInventoryEntry = ExactNotificationEntry & Pick<NotificationEvent, 'entityId' | 'kind'>;
export type CapturedNotificationInventory = { entries: readonly NotificationInventoryEntry[] };
type SnapshotAgent = {
  id: string;
  attention?: 'working' | 'finished' | 'question';
  hasMessageQuestion?: true;
  unread?: boolean;
  completionId?: string;
  notificationEvent?: NotificationEvent;
  notificationState?: NotificationState;
};
type SnapshotAgentState = SnapshotAgent & { event?: NotificationEvent; observedWorking?: NotificationState };
type WorkerDisplayedMessage = {
  type: 'rac-notification-displayed';
  protocolVersion: 1;
  eventId: string;
  eventEpoch: string;
  eventSequence: number;
  entityId: string;
  displayTag: string;
};

const protocolVersion = 1;
const acknowledgementTimeoutMs = 1_500;
const maximumBatchBytes = 65_536;
const noControls = /^[^\u0000-\u001f\u007f]+$/u;
const safeIdentifier = /^[A-Za-z0-9._:-]{1,128}$/u;
const outcomes = new Set<NotificationWorkerOutcome>(['displayed', 'duplicate', 'stale', 'muted', 'not-found', 'closed', 'retained', 'listed', 'unavailable', 'invalid']);
const currentEvents = new Map<string, NotificationEvent>();
const previousAgents = new Map<string, SnapshotAgentState>();
const obsoleteEvents = new Map<string, ExactNotificationEntry>();
const displayedEntries = new Map<string, Map<string, ExactNotificationEntry>>();
const inventoriedEvents = new Map<string, { event: NotificationInventoryEntry; observedWorking?: NotificationState }>();
const pendingRequests = new Set<() => void>();
const entityRequests = new Map<string, Set<() => void>>();
let requestCounter = 0;
let latestSnapshotToken = '';
let inventorySequence = 0;
let inventoryCursor: string | undefined;

// validate exact browser-side event metadata without importing node runtime code
export const isBrowserNotificationEvent = (value: unknown): value is NotificationEvent => {
  // require one bounded event object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<NotificationEvent>;
  return event.schemaVersion === 1
    && typeof event.eventId === 'string' && safeIdentifier.test(event.eventId)
    && typeof event.eventEpoch === 'string' && event.eventEpoch.length >= 16 && event.eventEpoch.length <= 64 && noControls.test(event.eventEpoch)
    && Number.isSafeInteger(event.eventSequence) && (event.eventSequence ?? 0) > 0
    && typeof event.entityId === 'string' && event.entityId.length <= 256 && noControls.test(event.entityId)
    && Number.isSafeInteger(event.generatedAt) && (event.generatedAt ?? 0) > 0
    && (event.kind === 'question' || event.kind === 'finished')
    && typeof event.agentId === 'string' && event.agentId.length <= 256 && noControls.test(event.agentId)
    && typeof event.tag === 'string' && event.tag.length <= 256 && noControls.test(event.tag)
    && typeof event.displayTag === 'string' && event.displayTag.length <= 256 && noControls.test(event.displayTag)
    && typeof event.url === 'string' && event.url.startsWith('/') && !event.url.startsWith('//') && event.url.length <= 2_048 && noControls.test(event.url)
    && (event.worktreeId === undefined || typeof event.worktreeId === 'string' && event.worktreeId.length <= 512 && noControls.test(event.worktreeId));
};

// compare one exact event identity
const sameEvent = (left: NotificationIdentity | undefined, right: NotificationIdentity | undefined): boolean => left !== undefined && right !== undefined
  && left.entityId === right.entityId
  && left.eventId === right.eventId
  && left.eventEpoch === right.eventEpoch
  && left.eventSequence === right.eventSequence;

// derive one exact entry map key
const eventKey = (event: ExactNotificationEntry): string => `${event.displayTag}\n${event.eventId}\n${event.eventEpoch}\n${event.eventSequence}`;

// derive one tag-independent event identity key
const eventIdentityKey = (event: Pick<NotificationEvent, 'entityId' | 'eventId' | 'eventEpoch' | 'eventSequence'>): string => `${event.entityId}\n${event.eventId}\n${event.eventEpoch}\n${event.eventSequence}`;

// retain one actual strict, compatibility, or fail-open display identity
const rememberDisplayedEntry = (event: Pick<NotificationEvent, 'entityId' | 'eventId' | 'eventEpoch' | 'eventSequence'>, displayTag: string): void => {
  // reject unbounded actual display tags
  if (displayTag.length === 0 || displayTag.length > 256 || !displayTag.startsWith('rac-v1-') || !noControls.test(displayTag)) return;
  const key = eventIdentityKey(event);
  const entries = displayedEntries.get(key) ?? new Map<string, ExactNotificationEntry>();
  entries.set(displayTag, { displayTag, eventId: event.eventId, eventEpoch: event.eventEpoch, eventSequence: event.eventSequence });
  displayedEntries.set(key, entries);
};

// forget one exact actual display identity after closure
const forgetDisplayedEntry = (entry: ExactNotificationEntry): void => {
  // inspect the bounded page-known identity sets
  for (const [identity, entries] of displayedEntries) {
    const displayed = entries.get(entry.displayTag);
    // delete only the exact event tuple under this actual tag
    if (displayed !== undefined && eventKey(displayed) === eventKey(entry)) entries.delete(entry.displayTag);
    // release only emptied identity sets
    if (entries.size === 0) { displayedEntries.delete(identity); inventoriedEvents.delete(identity); }
  }
};

// encode the worker's length-prefixed exact identity tuple
const canonicalIdentity = (event: NotificationEvent): string => [String(event.schemaVersion), event.entityId, event.eventId, event.eventEpoch, String(event.eventSequence)]
  .map(value => `${new TextEncoder().encode(value).byteLength}:${value}`)
  .join('');

// derive the deterministic content-free event digest
const notificationEventDigest = async (event: NotificationEvent): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalIdentity(event)))).slice(0, 16);
  let binary = '';
  // convert the bounded digest without spreading a typed array
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

// derive one event-specific fail-open display tag
const notificationFailOpenTag = async (event: NotificationEvent): Promise<string> => `rac-v1-failopen-${await notificationEventDigest(event)}`;

// create one bounded request id
const nextRequestId = (): string => {
  requestCounter += 1;
  return `page-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
};

// resolve one registration inside a bounded display budget
const boundedRegistration = async (timeoutMs: number): Promise<ServiceWorkerRegistration | undefined> => {
  // reject legacy surfaces without a registration container
  if (!('serviceWorker' in navigator)) return undefined;
  const lookup = typeof navigator.serviceWorker.getRegistration === 'function'
    ? navigator.serviceWorker.getRegistration()
    : navigator.serviceWorker.ready;
  return await new Promise(resolve => {
    let settled = false;
    const finish = (registration?: ServiceWorkerRegistration) => {
      // settle only the first lookup or timeout
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(registration);
    };
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    void lookup.then(registration => finish(registration), () => finish(undefined));
  });
};

// accept only bounded protocol acknowledgements
const workerAck = (value: unknown, requestId: string, operation: unknown): NotificationWorkerAck | undefined => {
  // reject unknown or mismatched replies
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ack = value as Partial<NotificationWorkerAck>;
  const allowed = new Set(['protocolVersion', 'requestId', 'outcome', 'audibleClaim', 'eventId', 'eventEpoch', 'eventSequence', 'displayTag', 'snapshotToken', ...(operation === 'inventory' ? ['entries', 'nextCursor'] : [])]);
  // reject content-bearing acknowledgement fields
  if (Object.keys(value).some(key => !allowed.has(key))) return undefined;
  // require the exact request boundary
  if (ack.protocolVersion !== protocolVersion || ack.requestId !== requestId || typeof ack.outcome !== 'string' || !outcomes.has(ack.outcome as NotificationWorkerOutcome) || typeof ack.audibleClaim !== 'boolean') return undefined;
  // validate optional exact identity fields
  if (ack.eventId !== undefined && (typeof ack.eventId !== 'string' || !safeIdentifier.test(ack.eventId))) return undefined;
  if (ack.eventEpoch !== undefined && (typeof ack.eventEpoch !== 'string' || ack.eventEpoch.length < 16 || ack.eventEpoch.length > 64 || !noControls.test(ack.eventEpoch))) return undefined;
  if (ack.eventSequence !== undefined && (!Number.isSafeInteger(ack.eventSequence) || ack.eventSequence <= 0)) return undefined;
  if (ack.displayTag !== undefined && (typeof ack.displayTag !== 'string' || ack.displayTag.length > 256 || !noControls.test(ack.displayTag))) return undefined;
  if (ack.snapshotToken !== undefined && (typeof ack.snapshotToken !== 'string' || ack.snapshotToken.length > 256 || !noControls.test(ack.snapshotToken))) return undefined;
  // bound inventory replies before accepting any nested identity
  if (operation === 'inventory') {
    try {
      // cyclic or oversized messages never acquire reconciliation authority
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBatchBytes) return undefined;
    } catch { return undefined; }
    if (ack.outcome === 'listed' && (ack.audibleClaim || !Array.isArray(ack.entries) || ack.entries.length > 100 || !ack.entries.every(isInventoryEntry))) return undefined;
    if (ack.nextCursor !== undefined && (!isInventoryTag(ack.nextCursor) || ack.entries?.length === 0 || ack.nextCursor !== ack.entries?.at(-1)?.displayTag)) return undefined;
    if (ack.outcome !== 'listed' && (ack.entries !== undefined || ack.nextCursor !== undefined)) return undefined;
  }
  return ack as NotificationWorkerAck;
};

// keep inventory cursors inside the owned versioned namespace
const isInventoryTag = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && value.startsWith('rac-v1-') && noControls.test(value);

// accept only content-free exact worker inventory identities
const isInventoryEntry = (value: unknown): value is NotificationInventoryEntry => {
  // reject non-record and content-bearing entries
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<NotificationInventoryEntry>;
  const keys = new Set(['displayTag', 'entityId', 'eventId', 'eventEpoch', 'eventSequence', 'kind']);
  return Object.keys(value).every(key => keys.has(key))
    && isInventoryTag(entry.displayTag)
    && typeof entry.entityId === 'string' && entry.entityId.length <= 256 && noControls.test(entry.entityId)
    && typeof entry.eventId === 'string' && safeIdentifier.test(entry.eventId)
    && typeof entry.eventEpoch === 'string' && entry.eventEpoch.length >= 16 && entry.eventEpoch.length <= 64 && noControls.test(entry.eventEpoch)
    && Number.isSafeInteger(entry.eventSequence) && (entry.eventSequence ?? 0) > 0
    && (entry.kind === 'question' || entry.kind === 'finished');
};

// cancel every pending request for a superseded entity
const cancelEntityRequests = (entityId: string): void => {
  const requests = entityRequests.get(entityId);
  // skip entities without page requests
  if (requests === undefined) return;
  // cancel timers and discard late acknowledgements
  for (const cancel of [...requests]) cancel();
  entityRequests.delete(entityId);
};

// publish one current event and invalidate an older page operation
const noteCurrentNotificationEvent = (event: NotificationEvent): void => {
  const current = currentEvents.get(event.entityId);
  // retain exact duplicate operations
  if (sameEvent(current, event)) return;
  cancelEntityRequests(event.entityId);
  currentEvents.set(event.entityId, event);
};

// invalidate one page claim only when authoritative state proves that exact event obsolete
const invalidateNotificationEvent = (event: NotificationEvent): void => {
  // preserve a newer event for the same entity
  if (!sameEvent(currentEvents.get(event.entityId), event)) return;
  cancelEntityRequests(event.entityId);
  currentEvents.delete(event.entityId);
};

// test whether an async result still belongs to the current event
const eventIsCurrent = (event: NotificationEvent): boolean => sameEvent(currentEvents.get(event.entityId), event);

// send one bounded operation through the active worker
const requestNotificationWorker = async (message: Record<string, unknown>, options: { entityId?: string; isCurrent?: () => boolean; timeoutMs?: number } = {}): Promise<NotificationWorkerAck | undefined> => {
  const requestId = nextRequestId();
  const payload = { protocolVersion, requestId, ...message };
  // reject oversized page operations before posting
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > (message.operation === 'reconcile' ? maximumBatchBytes : 8_192)) return undefined;
  try {
    // require the active registration arbiter
    if (!('serviceWorker' in navigator) || typeof MessageChannel === 'undefined') return undefined;
    const timeoutMs = options.timeoutMs ?? acknowledgementTimeoutMs;
    const startedAt = performance.now();
    const registration = await boundedRegistration(timeoutMs);
    // fail open after bounded registration lookup
    if (registration === undefined || options.isCurrent?.() === false) return undefined;
    const worker = registration.active;
    // fail open only when no active worker owns the registration
    if (worker === null) return undefined;
    const remainingMs = Math.max(0, timeoutMs - (performance.now() - startedAt));
    // keep readiness inside the same overall acknowledgement budget
    if (remainingMs === 0) return undefined;
    return await new Promise(resolve => {
      const channel = new MessageChannel();
      let settled = false;
      let timer = 0;
      const finish = (ack?: NotificationWorkerAck) => {
        // discard late acknowledgements and cancellations
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        pendingRequests.delete(cancel);
        // release entity-local cancellation ownership
        if (options.entityId !== undefined) {
          const requests = entityRequests.get(options.entityId);
          requests?.delete(cancel);
          // remove only an emptied request set
          if (requests?.size === 0) entityRequests.delete(options.entityId);
        }
        resolve(options.isCurrent?.() === false ? undefined : ack);
      };
      const cancel = () => finish(undefined);
      pendingRequests.add(cancel);
      // bind current-event operations to their entity
      if (options.entityId !== undefined) {
        const requests = entityRequests.get(options.entityId) ?? new Set<() => void>();
        requests.add(cancel);
        entityRequests.set(options.entityId, requests);
      }
      channel.port1.onmessage = event => {
        const ack = workerAck(event.data, requestId, message.operation);
        // ignore malformed replies until the bounded timeout
        if (ack !== undefined) finish(ack);
      };
      timer = window.setTimeout(() => finish(undefined), remainingMs);
      try { worker.postMessage(payload, [channel.port2]); }
      catch { finish(undefined); }
    });
  } catch { return undefined; }
};

// collect bounded worker identities before requesting their authoritative snapshot
export const captureNotificationInventory = async (): Promise<CapturedNotificationInventory | undefined> => {
  const owner = ++inventorySequence;
  const startedAt = performance.now();
  const entries: NotificationInventoryEntry[] = [];
  let cursor = inventoryCursor;
  // cap both work and wall time while retaining continuation for later refreshes
  for (let page = 0; page < 20; page += 1) {
    const remaining = acknowledgementTimeoutMs - (performance.now() - startedAt);
    // defer the remaining inventory instead of delaying dashboard recovery
    if (remaining <= 0) break;
    const ack = await requestNotificationWorker({ operation: 'inventory', ...(cursor === undefined ? {} : { cursor }) }, { timeoutMs: remaining, isCurrent: () => inventorySequence === owner });
    // no partial invalid response may acquire destructive authority
    if (inventorySequence !== owner || ack?.outcome !== 'listed' || ack.entries === undefined) return undefined;
    let previousTag = cursor;
    // validate strict cursor progress and unique actual tags
    for (const entry of ack.entries) {
      // reject duplicate or backward cursor identities
      if (previousTag !== undefined && entry.displayTag <= previousTag) return undefined;
      previousTag = entry.displayTag;
    }
    entries.push(...ack.entries);
    cursor = ack.nextCursor;
    // a complete inventory restarts from the beginning on the next refresh
    if (cursor === undefined) { inventoryCursor = undefined; return { entries }; }
  }
  // continue a valid bounded prefix without starving identities later in the tray
  inventoryCursor = cursor;
  return entries.length === 0 ? undefined : { entries };
};

// show one non-destructive event-specific native fallback
const showFailOpen = async (event: NotificationEvent, title: string, body: string, soundStillRequested: () => boolean, isCurrent: () => boolean): Promise<boolean> => {
  // refuse a superseded event before digest work
  if (!isCurrent()) return false;
  const displayTag = await notificationFailOpenTag(event);
  // refuse a superseded event before display
  if (!isCurrent() || !('Notification' in window) || Notification.permission !== 'granted') return false;
  const options: NotificationOptions = { body, tag: displayTag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: event.kind === 'question', silent: !soundStillRequested(), data: { ...event, displayTag } };
  // capture the actual fail-open tuple before display begins
  rememberDisplayedEntry(event, displayTag);
  // prefer the registration when available
  if ('serviceWorker' in navigator) {
    try {
      const registration = await boundedRegistration(250);
      // use a quickly available registration only
      if (registration !== undefined && isCurrent()) { await registration.showNotification(title, { ...options, silent: !soundStillRequested() }); return true; }
    }
    catch { /* use the window notification fallback */ }
  }
  // refuse a superseded event after registration lookup
  if (!isCurrent()) return false;
  // preserve a visible fallback without a service worker
  try { new Notification(title, { ...options, silent: !soundStillRequested() }); return true; }
  catch { /* notification failure remains non-blocking */ }
  return false;
};

// display one strict agent event through the worker arbiter
export const displayNotificationEvent = async (input: {
  event: NotificationEvent;
  title: string;
  body: string;
  soundRequested: boolean;
  soundStillRequested: () => boolean;
  playCustomSound: () => Promise<boolean>;
}): Promise<boolean> => {
  const { event, title, body, soundRequested, soundStillRequested, playCustomSound } = input;
  // reject malformed server metadata conservatively
  if (!isBrowserNotificationEvent(event)) return false;
  noteCurrentNotificationEvent(event);
  const isCurrent = () => eventIsCurrent(event);
  const wantsSound = () => soundRequested && soundStillRequested();
  const ack = await requestNotificationWorker({ operation: 'display', event: { ...event, title: title.slice(0, 256), body: body.slice(0, 2_048) }, soundRequested: wantsSound() }, { entityId: event.entityId, isCurrent });
  // use only an event-specific native fail-open after worker failure
  if (ack === undefined || ack.outcome === 'unavailable' || ack.outcome === 'invalid') return await showFailOpen(event, title, body, wantsSound, isCurrent);
  const identityMatches = ack.eventId === event.eventId && ack.eventEpoch === event.eventEpoch && ack.eventSequence === event.eventSequence;
  const allowedOutcome = ack.outcome === 'displayed' || ack.outcome === 'duplicate' || ack.outcome === 'stale' || ack.outcome === 'muted';
  const tagMatches = ack.displayTag === event.displayTag || ack.displayTag === `rac-v1-compat-${await notificationEventDigest(event)}`;
  // mismatched replies never grant audio ownership or a strict-tag mutation
  if (!identityMatches || !allowedOutcome || !tagMatches) return await showFailOpen(event, title, body, wantsSound, isCurrent);
  // retain the worker's actual strict or compatibility tag
  if (ack.displayTag !== undefined) rememberDisplayedEntry(event, ack.displayTag);
  // play a custom chime only for the healthy current audible claim
  if (ack.outcome !== 'displayed' && ack.outcome !== 'duplicate') return false;
  if (!wantsSound() || !ack.audibleClaim || !isCurrent()) return true;
  const played = await playCustomSound();
  // keep a successful custom chime as the sole audible claim
  if (played || !isCurrent() || !wantsSound()) return true;
  const fallback = await requestNotificationWorker({ operation: 'sound-fallback', event: { ...event, displayTag: ack.displayTag }, soundRequested: true }, { entityId: event.entityId, isCurrent });
  // preserve authoritative stale and muted refusals
  if (fallback !== undefined && fallback.outcome !== 'unavailable' && fallback.outcome !== 'invalid') return true;
  // a later local mute still permits a visible but silent fail-open
  await showFailOpen(event, title, body, wantsSound, isCurrent);
  return true;
};

// remember one exact obsolete event for retryable reconciliation
const markNotificationEventObsolete = (event: NotificationEvent): void => {
  // retain only validated exact identities
  if (!isBrowserNotificationEvent(event)) return;
  const strict = { displayTag: event.displayTag, eventId: event.eventId, eventEpoch: event.eventEpoch, eventSequence: event.eventSequence };
  obsoleteEvents.set(eventKey(strict), strict);
  const displayed = displayedEntries.get(eventIdentityKey(event));
  // include every actual display variant known to this page
  for (const entry of displayed?.values() ?? []) obsoleteEvents.set(eventKey(entry), entry);
};

// request one exact close without any direct page fallback
export const closeNotificationEvent = async (event: NotificationEvent, resolved = false): Promise<void> => {
  // cancel audible work only when the page proved resolution or read state
  if (resolved) invalidateNotificationEvent(event);
  markNotificationEventObsolete(event);
  const identity = eventIdentityKey(event);
  const candidates = [...obsoleteEvents.values()].filter(candidate => candidate.eventId === event.eventId && candidate.eventEpoch === event.eventEpoch && candidate.eventSequence === event.eventSequence);
  // close every captured actual display identity serially
  for (const candidate of candidates) {
    const ack = await requestNotificationWorker({ operation: 'close', event: candidate }, { timeoutMs: acknowledgementTimeoutMs });
    // retire only a proved exact close or absence
    if (ack?.outcome === 'closed' || ack?.outcome === 'not-found') { obsoleteEvents.delete(eventKey(candidate)); forgetDisplayedEntry(candidate); }
  }
  // release captured display variants after every exact candidate retires
  if (!candidates.some(candidate => obsoleteEvents.has(eventKey(candidate)))) displayedEntries.delete(identity);
};

// compare a current state to one prior event
const newerComparableState = (state: NotificationState | undefined, event: NotificationEvent): boolean => state !== undefined
  && state.eventEpoch === event.eventEpoch
  && state.eventSequence > event.eventSequence;

// normalize prose questions to the same relevance state as structured questions
const snapshotAttention = (agent: SnapshotAgent): SnapshotAgent['attention'] => agent.attention === 'finished' && agent.hasMessageQuestion === true ? 'question' : agent.attention;

// prove one previous event obsolete from authoritative current state
const previousEventObsolete = (previous: NotificationEvent, current: SnapshotAgent): boolean => {
  const event = current.notificationEvent;
  const attention = snapshotAttention(current);
  // current metadata also identifies pending grace, whose unread=false is not a read receipt
  if (sameEvent(previous, event)) return false;
  // a comparable newer working turn resolves either prior alert
  if (attention === 'working' && newerComparableState(current.notificationState, previous)) return true;
  // an identified different question resolves only the old question
  if (previous.kind === 'question' && event?.kind === 'question' && event.eventId !== previous.eventId) return true;
  // a current non-question state resolves an old question across epochs
  if (previous.kind === 'question' && attention !== 'question') return true;
  // a comparable newer revision proves supersession
  if (newerComparableState(current.notificationState, previous)) return event !== undefined || attention !== 'finished' || current.unread === false;
  // exact read evidence closes one completion across snapshots
  if (previous.kind === 'finished' && current.completionId === previous.eventId && current.unread !== true) return true;
  return false;
};

// classify captured tray identities using only post-inventory authoritative evidence
const inventoryEventObsolete = (event: NotificationInventoryEntry, current: SnapshotAgent | undefined, observedWorking: NotificationState | undefined): boolean => {
  // only the known Agent namespace has authoritative removal semantics
  if (current === undefined) return event.entityId.startsWith('agent:');
  const state = current.notificationState;
  const currentEvent = isBrowserNotificationEvent(current.notificationEvent) ? current.notificationEvent : undefined;
  const attention = snapshotAttention(current);
  // a still-current event includes a completion pending its server grace period
  if (sameEvent(event, currentEvent)) return false;
  // an older comparable snapshot cannot classify a future delivery
  if (state?.eventEpoch === event.eventEpoch && state.eventSequence < event.eventSequence) return false;
  // an exact completed-turn read is useful even across process restarts
  if (event.kind === 'finished' && current.completionId === event.eventId && current.unread === false) return true;
  // identified comparable progression supersedes only an older event
  if (currentEvent?.eventEpoch === event.eventEpoch && currentEvent.eventSequence > event.eventSequence) return true;
  // bridge only opaque epochs; comparable identities require a strictly newer revision
  if (observedWorking !== undefined && event.eventEpoch !== observedWorking.eventEpoch && currentEvent !== undefined && !sameEvent(event, currentEvent) && currentEvent.eventEpoch === observedWorking.eventEpoch && currentEvent.eventSequence > observedWorking.eventSequence) return true;
  // opaque epochs and missing revisions retain their still-ambiguous alerts
  if (state?.eventEpoch !== event.eventEpoch || state.eventSequence <= event.eventSequence) return false;
  // a same-process newer non-question revision resolves the old question
  if (event.kind === 'question') return attention !== 'question';
  // working progression or an explicit settled read resolves the old completed turn
  return attention === 'working' || attention === 'finished' && current.unread === false && currentEvent === undefined;
};

// reconcile only exact events proved obsolete by an accepted snapshot
export const reconcileNotificationSnapshot = async (agents: readonly SnapshotAgent[], snapshotToken: string, inventory?: CapturedNotificationInventory): Promise<void> => {
  latestSnapshotToken = snapshotToken;
  // activate identities only alongside the snapshot obtained after their inventory capture
  for (const event of inventory?.entries ?? []) {
    const identity = eventIdentityKey(event);
    const previous = inventoriedEvents.get(identity);
    inventoriedEvents.set(identity, { event, ...(previous?.observedWorking === undefined ? {} : { observedWorking: previous.observedWorking }) });
    rememberDisplayedEntry(event, event.displayTag);
  }
  const currentIds = new Set(agents.map(agent => agent.id));
  const agentsByEntity = new Map<string, SnapshotAgent>();
  // close events for authoritatively removed agents
  for (const [agentId, previous] of previousAgents) {
    // retain agents still represented by this snapshot
    if (currentIds.has(agentId)) continue;
    // remove only an exact schema-owned prior event
    if (previous.event !== undefined) { markNotificationEventObsolete(previous.event); invalidateNotificationEvent(previous.event); }
    previousAgents.delete(agentId);
  }
  // compare every current agent to its prior exact event
  for (const agent of agents) {
    const event = isBrowserNotificationEvent(agent.notificationEvent) ? agent.notificationEvent : undefined;
    const previous = previousAgents.get(agent.id);
    const eventObsolete = event !== undefined && previousEventObsolete(event, { ...agent, notificationEvent: event });
    // a working bridge supersedes only a different event, never its repeated current snapshot
    const workingBridgeSupersedes = previous?.event !== undefined
      && previous.observedWorking !== undefined
      && event !== undefined
      && !sameEvent(previous.event, event)
      && event.eventEpoch === previous.observedWorking.eventEpoch
      && event.eventSequence > previous.observedWorking.eventSequence;
    // prove prior relevance before replacing snapshot memory
    if (previous?.event !== undefined && (previousEventObsolete(previous.event, { ...agent, notificationEvent: event }) || workingBridgeSupersedes)) { markNotificationEventObsolete(previous.event); invalidateNotificationEvent(previous.event); }
    // close a current exact completion already read or resolved question
    if (event !== undefined && eventObsolete) { markNotificationEventObsolete(event); invalidateNotificationEvent(event); }
    // invalidate pending display work only for a proved newer/current event
    if (event !== undefined && !eventObsolete) noteCurrentNotificationEvent(event);
    const observedWorking = snapshotAttention(agent) === 'working' && agent.notificationState !== undefined ? agent.notificationState : previous?.observedWorking;
    previousAgents.set(agent.id, { ...agent, event: event ?? previous?.event, ...(observedWorking === undefined ? {} : { observedWorking }) });
    const entityId = event?.entityId ?? previous?.event?.entityId ?? `agent:${agent.id}`;
    // index only bounded derived entity identities
    if (entityId.length <= 256 && noControls.test(entityId)) agentsByEntity.set(entityId, { ...agent, notificationEvent: event });
  }
  // never classify a newly reported worker identity against a pre-inventory snapshot
  for (const [identity, remembered] of inventoriedEvents) {
    const agent = agentsByEntity.get(remembered.event.entityId);
    const obsolete = inventoryEventObsolete(remembered.event, agent, remembered.observedWorking);
    // retain working evidence for a later identified progression across epochs
    if (agent !== undefined && snapshotAttention(agent) === 'working' && agent.notificationState !== undefined) remembered.observedWorking = agent.notificationState;
    // leave unknown, unread, current, and future resources untouched
    if (!obsolete) continue;
    const current = currentEvents.get(remembered.event.entityId);
    // cancel only this exact obsolete audible claim
    if (current !== undefined && sameEvent(current, remembered.event)) invalidateNotificationEvent(current);
    // close every actual tag for the proved obsolete exact tuple
    for (const entry of displayedEntries.get(identity)?.values() ?? []) obsoleteEvents.set(eventKey(entry), entry);
  }
  const entries = [...obsoleteEvents.values()];
  // avoid worker enumeration without exact candidates
  if (entries.length === 0) { void recordNotificationJournal('reconciled', { status: 'no-op' }); return; }
  const encoder = new TextEncoder();
  const envelopeBytes = encoder.encode(JSON.stringify({ protocolVersion, requestId: 'x'.repeat(128), operation: 'reconcile', entries: [], snapshotToken })).byteLength;
  let offset = 0;
  // serialize count- and byte-bounded chunks while the snapshot remains current
  while (offset < entries.length) {
    // cancel remaining old-snapshot chunks after supersession
    if (latestSnapshotToken !== snapshotToken) return;
    const chunk: ExactNotificationEntry[] = [];
    let bytes = envelopeBytes;
    // inventory pages may combine into more than one valid close request
    while (offset < entries.length && chunk.length < 100) {
      const entry = entries[offset]!;
      const entryBytes = encoder.encode(JSON.stringify(entry)).byteLength + (chunk.length === 0 ? 0 : 1);
      // leave overflow for the next bounded request
      if (bytes + entryBytes > maximumBatchBytes) break;
      chunk.push(entry);
      bytes += entryBytes;
      offset += 1;
    }
    // never spin or widen closure after an impossible oversized identity
    if (chunk.length === 0) return;
    const ack = await requestNotificationWorker({ operation: 'reconcile', entries: chunk, snapshotToken }, { isCurrent: () => latestSnapshotToken === snapshotToken });
    // retain candidates after unavailable or stale acknowledgement
    if (ack === undefined || ack.snapshotToken !== snapshotToken || latestSnapshotToken !== snapshotToken) return;
    // retire only acknowledged exact candidates
    if (ack.outcome === 'closed' || ack.outcome === 'not-found') {
      for (const entry of chunk) { obsoleteEvents.delete(eventKey(entry)); forgetDisplayedEntry(entry); }
    }
  }
  void recordNotificationJournal('reconciled', { status: 'accepted' });
};

// validate one event-only worker display message
const displayedMessage = (value: unknown): value is WorkerDisplayedMessage => {
  // reject content-bearing or malformed messages
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<WorkerDisplayedMessage>;
  return message.type === 'rac-notification-displayed'
    && message.protocolVersion === protocolVersion
    && typeof message.eventId === 'string' && safeIdentifier.test(message.eventId)
    && typeof message.eventEpoch === 'string' && message.eventEpoch.length >= 16 && message.eventEpoch.length <= 64 && noControls.test(message.eventEpoch)
    && Number.isSafeInteger(message.eventSequence) && (message.eventSequence ?? 0) > 0
    && typeof message.entityId === 'string' && message.entityId.length <= 256 && noControls.test(message.entityId)
    && typeof message.displayTag === 'string' && message.displayTag.length <= 256 && noControls.test(message.displayTag);
};

// refresh authoritative state after a worker display
export const listenForWorkerNotificationDisplays = (refresh: () => void | Promise<void>): (() => void) => {
  // skip legacy service-worker surfaces
  if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker.addEventListener !== 'function') return () => {};
  const listener = (event: MessageEvent) => {
    // never reconcile from the stale cached snapshot
    if (displayedMessage(event.data)) {
      // invalidate pagination that may have passed this newly inserted tag
      inventorySequence += 1;
      inventoryCursor = undefined;
      rememberDisplayedEntry(event.data, event.data.displayTag);
      void refresh();
    }
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
};

// cancel every pending timer and late acknowledgement on disposal
export const disposeNotificationCoordinator = (): void => {
  // release every request-owned timer and port
  for (const cancel of [...pendingRequests]) cancel();
  pendingRequests.clear();
  entityRequests.clear();
  currentEvents.clear();
  previousAgents.clear();
  obsoleteEvents.clear();
  displayedEntries.clear();
  inventoriedEvents.clear();
  inventorySequence += 1;
  inventoryCursor = undefined;
  latestSnapshotToken = '';
};
