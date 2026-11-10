const PROTOCOL_VERSION = 1;
const MAX_RPC_BYTES = 8 * 1024;
const MAX_RECONCILE_BYTES = 64 * 1024;
const MAX_RECONCILE_ENTRIES = 100;
const MAX_INVENTORY_ACK_BYTES = 64 * 1024;
const MAX_INVENTORY_ENTRIES = 100;
const DIAGNOSTIC_DATABASE = 'rac-notification-diagnostics';
const DIAGNOSTIC_STORE = 'events';
const DIAGNOSTIC_LIMIT = 200;
const DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_LIFETIME_MS = 250;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._~:@/-]+$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UNSAFE_PRESENTATION_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STRICT_TAG_PREFIX = 'rac-v1-';
const COMPAT_TAG_PREFIX = 'rac-v1-compat-';
const VALID_KINDS = new Set(['question', 'finished']);
const VALID_OPERATIONS = new Set(['display', 'close', 'reconcile', 'inventory', 'sound-fallback']);

let operationTail = Promise.resolve();
const pendingDiagnostics = new Set();

// publish an always-fulfilled tail while preserving this operation's result
function enqueueOperation(operation) {
  const result = operationTail.then(operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}

// accept plain records only
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// validate bounded content-free identifiers
function isIdentifier(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && SAFE_IDENTIFIER.test(value);
}

// validate bounded display metadata strings
function isBoundedText(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.length >= 1) && value.length <= maximum && !CONTROL_CHARACTER.test(value);
}

// validate bounded presentation text while allowing normal multiline content
function isPresentationText(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.length >= 1) && value.length <= maximum && !UNSAFE_PRESENTATION_CHARACTER.test(value);
}

// validate positive safe integers
function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// retain same-origin relative routes only
function safeRoute(value) {
  // reject missing and protocol-relative destinations
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || CONTROL_CHARACTER.test(value)) return '/';
  try {
    const parsed = new URL(value, self.location.origin);
    // reject any parsed cross-origin route
    if (parsed.origin !== self.location.origin) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

// prefer durable worktree routing
function notificationRoute(value) {
  // preserve valid worktree destinations
  if (isBoundedText(value.worktreeId, 512)) return `/#worktree=${encodeURIComponent(value.worktreeId)}`;
  return safeRoute(value.url);
}

// normalize strict v1 event metadata
function strictEvent(value, requirePresentation) {
  // reject non-record payloads
  if (!isRecord(value)) return undefined;
  // require the frozen v1 identity contract
  if (value.schemaVersion !== PROTOCOL_VERSION
    || typeof value.eventId !== 'string' || value.eventId.length > 128 || !SAFE_EVENT_ID.test(value.eventId)
    || !isBoundedText(value.eventEpoch, 64) || value.eventEpoch.length < 16
    || !isPositiveSafeInteger(value.eventSequence)
    || !isBoundedText(value.entityId, 256)
    || !VALID_KINDS.has(value.kind)
    || !isPositiveSafeInteger(value.generatedAt)
    || !isBoundedText(value.tag, 256)
    || !isBoundedText(value.displayTag, 256)
    || !value.displayTag.startsWith(STRICT_TAG_PREFIX)
    || !isBoundedText(value.agentId, 256)
    || safeRoute(value.url) !== value.url
    || (value.worktreeId !== undefined && !isBoundedText(value.worktreeId, 512, true))) return undefined;
  // require bounded presentation fields for display operations
  if (requirePresentation && (!isPresentationText(value.title, 256) || !isPresentationText(value.body, 2048, true))) return undefined;
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId: value.eventId,
    eventEpoch: value.eventEpoch,
    eventSequence: value.eventSequence,
    entityId: value.entityId,
    kind: value.kind,
    generatedAt: value.generatedAt,
    tag: value.tag,
    displayTag: value.displayTag,
    agentId: value.agentId,
    url: value.url,
    ...(value.worktreeId === undefined ? {} : { worktreeId: value.worktreeId }),
    ...(requirePresentation ? { title: value.title, body: value.body } : {})
  };
}

// normalize the exact closable tuple
function exactReference(value) {
  // reject non-record or incomplete identity
  if (!isRecord(value)
    || !isBoundedText(value.displayTag, 256)
    || !value.displayTag.startsWith(STRICT_TAG_PREFIX)
    || typeof value.eventId !== 'string' || value.eventId.length > 128 || !SAFE_EVENT_ID.test(value.eventId)
    || !isBoundedText(value.eventEpoch, 64) || value.eventEpoch.length < 16
    || !isPositiveSafeInteger(value.eventSequence)) return undefined;
  return {
    displayTag: value.displayTag,
    eventId: value.eventId,
    eventEpoch: value.eventEpoch,
    eventSequence: value.eventSequence
  };
}

// compare exact notification identities
function exactMatch(left, right) {
  return left.displayTag === right.displayTag
    && left.eventId === right.eventId
    && left.eventEpoch === right.eventEpoch
    && left.eventSequence === right.eventSequence;
}

// classify freshness without ordering opaque epochs or ids
function eventOrder(incoming, current) {
  // reject a mismatched entity as unknown
  if (incoming.entityId !== current.entityId) return 'unknown';
  // preserve exact identity
  if (incoming.eventId === current.eventId && incoming.eventEpoch === current.eventEpoch && incoming.eventSequence === current.eventSequence) return 'exact';
  // refuse to order different process epochs
  if (incoming.eventEpoch !== current.eventEpoch) return 'unknown';
  // compare only sequences within one epoch and entity
  if (incoming.eventSequence > current.eventSequence) return 'newer';
  // retain a known newer event
  if (incoming.eventSequence < current.eventSequence) return 'older';
  return 'conflict';
}

// encode the frozen length-prefixed digest tuple
function digestInput(value) {
  const parts = [value.schemaVersion, value.entityId, value.eventId, value.eventEpoch, value.eventSequence].map(part => String(part ?? ''));
  return parts.map(part => `${new TextEncoder().encode(part).byteLength}:${part}`).join('');
}

// require one canonical compatibility identity
function hasCompatibilityIdentity(value) {
  // reject incomplete or unbounded future identities
  if (!isRecord(value)
    || !isPositiveSafeInteger(value.schemaVersion)
    || !isBoundedText(value.entityId, 256)
    || typeof value.eventId !== 'string' || value.eventId.length > 128 || !SAFE_EVENT_ID.test(value.eventId)
    || !isBoundedText(value.eventEpoch, 64) || value.eventEpoch.length < 16
    || !isPositiveSafeInteger(value.eventSequence)) return false;
  return true;
}

// derive a deterministic content-free event tag
async function compatibilityTag(value) {
  const bytes = new TextEncoder().encode(digestInput(value));
  const digest = new Uint8Array(await self.crypto.subtle.digest('SHA-256', bytes)).slice(0, 16);
  let binary = '';
  // encode each digest byte without exposing event content
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${COMPAT_TAG_PREFIX}${encoded}`;
}

// normalize displayed strict data after worker restarts
function displayedEvent(notification) {
  const parsed = strictEvent(notification?.data, false);
  // require the stored actual tag to equal the tray resource
  if (parsed === undefined || parsed.displayTag !== notification.tag) return undefined;
  return { ...parsed, nativeFallbackAttempted: notification.data.nativeFallbackAttempted === true };
}

// construct bounded notification data without presentation content
function strictNotificationData(event, actualDisplayTag, nativeFallbackAttempted) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId: event.eventId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    entityId: event.entityId,
    kind: event.kind,
    generatedAt: event.generatedAt,
    tag: event.tag,
    logicalTag: event.tag,
    displayTag: actualDisplayTag,
    agentId: event.agentId,
    url: notificationRoute(event),
    ...(event.worktreeId === undefined ? {} : { worktreeId: event.worktreeId }),
    nativeFallbackAttempted
  };
}

// read the mirrored sound preference without gating visibility
async function soundPreference() {
  try {
    return { known: true, muted: Boolean(await caches.match('/__rac/notification-sounds-muted', { cacheName: 'rac-preferences' })) };
  } catch {
    return { known: false, muted: false };
  }
}

// create an opaque local journal id
function diagnosticId() {
  const random = typeof self.crypto.randomUUID === 'function' ? self.crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `w-${Date.now().toString(36)}-${random}`.slice(0, 128);
}

// open the bounded diagnostic database
function openDiagnosticDatabase() {
  return new Promise((resolve, reject) => {
    // reject unavailable local storage
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb unavailable'));
      return;
    }
    const request = indexedDB.open(DIAGNOSTIC_DATABASE, 1);
    // create the frozen v1 store
    request.onupgradeneeded = () => {
      const database = request.result;
      // create the store once
      if (!database.objectStoreNames.contains(DIAGNOSTIC_STORE)) database.createObjectStore(DIAGNOSTIC_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
  });
}

// append one allowlisted diagnostic record and enforce retention
async function writeDiagnostic(fields) {
  const database = await openDiagnosticDatabase();
  const record = { id: diagnosticId(), stage: fields.stage, at: Date.now() };
  // copy only bounded event identity
  if (isIdentifier(fields.eventId, 128)) record.eventId = fields.eventId;
  // copy only bounded event epoch
  if (isIdentifier(fields.eventEpoch, 64)) record.eventEpoch = fields.eventEpoch;
  // copy only a valid sequence
  if (isPositiveSafeInteger(fields.eventSequence)) record.eventSequence = fields.eventSequence;
  // copy only a known kind
  if (VALID_KINDS.has(fields.kind)) record.kind = fields.kind;
  // copy only bounded status classes
  if (isIdentifier(fields.status, 128)) record.status = fields.status;
  // copy only bounded attempt counts
  if (Number.isSafeInteger(fields.attempt) && fields.attempt > 0 && fields.attempt <= 2) record.attempt = fields.attempt;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DIAGNOSTIC_STORE, 'readwrite');
      const store = transaction.objectStore(DIAGNOSTIC_STORE);
      const request = store.getAll();
      // prune expired and excess records before insertion
      request.onsuccess = () => {
        const cutoff = Date.now() - DIAGNOSTIC_MAX_AGE_MS;
        const existing = Array.isArray(request.result) ? request.result : [];
        const retained = [];
        // remove expired records
        for (const candidate of existing) {
          // delete malformed or expired records
          if (!isRecord(candidate) || !isPositiveSafeInteger(candidate.at) || candidate.at < cutoff) store.delete(candidate?.id);
          else retained.push(candidate);
        }
        retained.sort((left, right) => left.at - right.at);
        const overflow = Math.max(0, retained.length + 1 - DIAGNOSTIC_LIMIT);
        // remove the oldest records over the cap
        for (let index = 0; index < overflow; index += 1) store.delete(retained[index].id);
        store.put(record);
      };
      request.onerror = () => reject(request.error ?? new Error('indexeddb read failed'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb write aborted'));
    });
  } finally {
    database.close();
  }
}

// isolate journal failures from notification delivery
async function journal(fields) {
  try {
    await writeDiagnostic(fields);
  } catch {
    // ignore diagnostic failures
  }
}

// track best-effort persistence outside the operation queue
function startJournal(fields) {
  const operation = journal(fields);
  pendingDiagnostics.add(operation);
  void operation.finally(() => pendingDiagnostics.delete(operation));
  return operation;
}

// bound event lifetime without blocking later queue positions
function diagnosticLifetime() {
  const operations = [...pendingDiagnostics];
  // skip the timer when no persistence remains
  if (operations.length === 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, DIAGNOSTIC_LIFETIME_MS);
    void Promise.allSettled(operations).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// keep diagnostic metadata content-free
function diagnosticFields(event) {
  // omit identity for legacy or malformed events
  if (event === undefined) return {};
  return {
    eventId: event.eventId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    kind: event.kind
  };
}

// attempt one visible display and one minimal retry
async function showWithMinimalRetry(title, options, event, recordReceipt) {
  const fields = diagnosticFields(event);
  let first;
  try {
    first = Promise.resolve(self.registration.showNotification(title, options));
  } catch (error) {
    first = Promise.reject(error);
  }
  const started = Promise.all([
    ...(recordReceipt ? [startJournal({ stage: 'worker_received', ...fields })] : []),
    startJournal({ stage: 'show_started', attempt: 1, ...fields })
  ]);
  void started;
  try {
    await first;
    void startJournal({ stage: 'show_succeeded', attempt: 1, status: 'shown', ...fields });
    return;
  } catch {
    void startJournal({ stage: 'show_failed', attempt: 1, status: 'show-rejected', ...fields });
  }
  const minimalOptions = {
    body: typeof options.body === 'string' ? options.body : 'An agent is ready.',
    ...(options.tag === undefined ? {} : { tag: options.tag }),
    silent: options.silent === true,
    renotify: false,
    // retain exact ownership even when optional presentation settings fail
    data: event === undefined ? { url: safeRoute(options.data?.url) } : strictNotificationData(event, options.tag, options.data?.nativeFallbackAttempted === true)
  };
  let second;
  try {
    second = Promise.resolve(self.registration.showNotification(title, minimalOptions));
  } catch (error) {
    second = Promise.reject(error);
  }
  void startJournal({ stage: 'show_started', attempt: 2, ...fields });
  try {
    await second;
    void startJournal({ stage: 'show_succeeded', attempt: 2, status: 'shown-minimal', ...fields });
  } catch (error) {
    void startJournal({ stage: 'show_failed', attempt: 2, status: 'show-rejected', ...fields });
    throw error;
  }
}

// enumerate notifications inside the serialized critical section
async function currentNotifications() {
  return await self.registration.getNotifications();
}

// show one validated event under strict or compatibility identity
async function displayStrictEvent(event, source) {
  let notifications;
  let enumerationAvailable = true;
  try {
    notifications = await currentNotifications();
  } catch (error) {
    // page callers must fail open outside the strict namespace
    if (source === 'page') throw error;
    notifications = [];
    enumerationAvailable = false;
  }
  const occupied = notifications.find(notification => notification.tag === event.displayTag);
  const current = displayedEvent(occupied);
  const order = occupied === undefined ? 'new' : current === undefined ? 'unknown' : eventOrder(event, current);
  // avoid re-showing an exact page duplicate
  if (source === 'page' && order === 'exact') return { outcome: 'duplicate', audibleClaim: false, displayTag: event.displayTag, event };
  // reject a provably older page request
  if (source === 'page' && order === 'older') return { outcome: 'stale', audibleClaim: false, displayTag: event.displayTag, event };
  const compatible = !enumerationAvailable || order === 'older' || order === 'conflict' || order === 'unknown';
  const actualDisplayTag = compatible ? await compatibilityTag(event) : event.displayTag;
  const preference = await soundPreference();
  const pageDisplay = source === 'page';
  const exactDuplicate = order === 'exact';
  const preserveFallback = exactDuplicate && current?.nativeFallbackAttempted === true;
  const silent = pageDisplay || compatible || exactDuplicate || preference.muted;
  const renotify = !pageDisplay && order === 'newer' && !preference.muted;
  const data = strictNotificationData(event, actualDisplayTag, preserveFallback);
  await showWithMinimalRetry(event.title, {
    body: event.body,
    tag: actualDisplayTag,
    icon: '/favicon.svg',
    badge: '/notification-badge.png',
    timestamp: event.generatedAt,
    silent,
    renotify,
    requireInteraction: event.kind === 'question',
    data
  }, event, source === 'push');
  return {
    outcome: 'displayed',
    // the page still gates its claim on the current local sound preference
    audibleClaim: pageDisplay && !preference.muted,
    displayTag: actualDisplayTag,
    event
  };
}

// make malformed and legacy pushes visibly conservative
async function displayLoosePush(value) {
  const payload = isRecord(value) ? value : {};
  const isVersioned = payload.schemaVersion !== undefined || (typeof payload.tag === 'string' && payload.tag.startsWith(STRICT_TAG_PREFIX));
  const actualTag = isVersioned
    ? hasCompatibilityIdentity(payload) ? await compatibilityTag(payload) : undefined
    : isBoundedText(payload.tag, 256) ? payload.tag : undefined;
  const title = isPresentationText(payload.title, 256) ? payload.title : 'Remote Agent Console';
  const body = isPresentationText(payload.body, 2048, true) ? payload.body : 'An agent is ready.';
  const worktreeId = isBoundedText(payload.worktreeId, 512) ? payload.worktreeId : undefined;
  const route = worktreeId === undefined ? safeRoute(payload.url) : `/#worktree=${encodeURIComponent(worktreeId)}`;
  const timestamp = isPositiveSafeInteger(payload.sentAt) ? payload.sentAt : undefined;
  const preference = await soundPreference();
  await showWithMinimalRetry(title, {
    body,
    ...(actualTag === undefined ? {} : { tag: actualTag }),
    icon: '/favicon.svg',
    badge: '/notification-badge.png',
    timestamp,
    silent: isVersioned || preference.muted,
    renotify: false,
    requireInteraction: payload.kind === 'question',
    data: { url: route, kind: typeof payload.kind === 'string' ? payload.kind : undefined, worktreeId }
  }, undefined, true);
}

// parse push data without allowing malformed JSON to consume delivery
function pushPayload(event) {
  try {
    const parsed = event.data?.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// notify controlled pages using event identity only
async function postDisplayedEvent(result) {
  const event = result.event;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false }).catch(() => []);
  // notify every controlled window without presentation content
  for (const client of windows) {
    try {
      client.postMessage({
        type: 'rac-notification-displayed',
        protocolVersion: PROTOCOL_VERSION,
        eventId: event.eventId,
        eventEpoch: event.eventEpoch,
        eventSequence: event.eventSequence,
        entityId: event.entityId,
        displayTag: result.displayTag
      });
    } catch {
      // ignore a page that disappeared after enumeration
    }
  }
}

// handle one received push inside its own queue position
async function handlePush(event) {
  const payload = pushPayload(event);
  const parsed = strictEvent(payload, true);
  // retain legacy and malformed visibility
  if (parsed === undefined) {
    await displayLoosePush(payload);
    return;
  }
  const result = await displayStrictEvent(parsed, 'push');
  await postDisplayedEvent(result);
}

// measure serialized request bytes
function requestBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// validate one page-to-worker request
function workerRequest(value) {
  // reject malformed common fields
  if (!isRecord(value)
    || value.protocolVersion !== PROTOCOL_VERSION
    || !isIdentifier(value.requestId, 128)
    || !VALID_OPERATIONS.has(value.operation)
    || (value.soundRequested !== undefined && typeof value.soundRequested !== 'boolean')) return undefined;
  const byteLimit = value.operation === 'reconcile' ? MAX_RECONCILE_BYTES : MAX_RPC_BYTES;
  // reject oversized serialized requests
  if (requestBytes(value) > byteLimit) return undefined;
  // validate a display event
  if (value.operation === 'display') {
    const event = strictEvent(value.event, true);
    // reject invalid display metadata
    if (event === undefined) return undefined;
    return { protocolVersion: PROTOCOL_VERSION, requestId: value.requestId, operation: value.operation, event, soundRequested: value.soundRequested === true };
  }
  // validate an exact close or sound request
  if (value.operation === 'close' || value.operation === 'sound-fallback') {
    const event = exactReference(value.event);
    // reject incomplete closable identity
    if (event === undefined) return undefined;
    return { protocolVersion: PROTOCOL_VERSION, requestId: value.requestId, operation: value.operation, event, soundRequested: value.soundRequested === true };
  }
  // validate an optional actual-tag inventory cursor
  if (value.operation === 'inventory') {
    // reject unbounded or foreign cursors
    if (value.cursor !== undefined && (!isBoundedText(value.cursor, 256) || !value.cursor.startsWith(STRICT_TAG_PREFIX))) return undefined;
    return { protocolVersion: PROTOCOL_VERSION, requestId: value.requestId, operation: value.operation, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
  }
  // reject oversized or malformed reconciliation batches
  if (!Array.isArray(value.entries) || value.entries.length > MAX_RECONCILE_ENTRIES || !isIdentifier(value.snapshotToken, 128)) return undefined;
  const entries = value.entries.map(exactReference);
  // reject any invalid candidate
  if (entries.some(entry => entry === undefined)) return undefined;
  return { protocolVersion: PROTOCOL_VERSION, requestId: value.requestId, operation: value.operation, entries, snapshotToken: value.snapshotToken };
}

// verify that a message source belongs to this origin
function validMessageSource(source) {
  try {
    return typeof source?.url === 'string' && new URL(source.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

// return bounded acknowledgement identity
function eventResult(outcome, event, audibleClaim = false, displayTag = event.displayTag) {
  return {
    outcome,
    audibleClaim,
    eventId: event.eventId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    displayTag
  };
}

// close one exact displayed notification
async function closeExact(event) {
  const notifications = await currentNotifications();
  const candidate = notifications.find(notification => notification.tag === event.displayTag);
  // report an absent tray resource
  if (candidate === undefined) return eventResult('not-found', event);
  const displayed = exactReference(candidate.data);
  // retain a mismatched or malformed occupant
  if (displayed === undefined || !exactMatch(displayed, event) || candidate.tag !== displayed.displayTag) return eventResult('retained', event);
  candidate.close();
  return eventResult('closed', event);
}

// reconcile only exact obsolete candidates
async function reconcileExact(request) {
  const notifications = await currentNotifications();
  let closed = 0;
  let retained = 0;
  // inspect each page-proved obsolete identity
  for (const event of request.entries) {
    const candidate = notifications.find(notification => notification.tag === event.displayTag);
    // skip absent notifications
    if (candidate === undefined) continue;
    const displayed = exactReference(candidate.data);
    // retain mismatched occupants
    if (displayed === undefined || !exactMatch(displayed, event) || candidate.tag !== displayed.displayTag) {
      retained += 1;
      continue;
    }
    candidate.close();
    closed += 1;
  }
  return { outcome: closed > 0 ? 'closed' : retained > 0 ? 'retained' : 'not-found', audibleClaim: false, snapshotToken: request.snapshotToken };
}

// expose one content-free strict inventory identity
function inventoryEntry(notification) {
  const event = displayedEvent(notification);
  // omit legacy, future, and ambiguous stored data
  if (event === undefined) return undefined;
  return {
    displayTag: event.displayTag,
    entityId: event.entityId,
    eventId: event.eventId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    kind: event.kind
  };
}

// list one bounded page of worker-owned identities
async function listInventory(request) {
  const notifications = await currentNotifications();
  const available = notifications
    .map(inventoryEntry)
    .filter(entry => entry !== undefined && (request.cursor === undefined || entry.displayTag > request.cursor))
    .sort((left, right) => left.displayTag < right.displayTag ? -1 : left.displayTag > right.displayTag ? 1 : 0);
  const entries = [];
  // stop before either response bound
  for (const entry of available) {
    // reserve the cursor when another entry would remain
    const wouldHaveMore = entries.length + 1 < available.length || entries.length + 1 >= MAX_INVENTORY_ENTRIES;
    const nextEntries = [...entries, entry];
    const candidate = acknowledgement(request.requestId, {
      outcome: 'listed',
      audibleClaim: false,
      entries: nextEntries,
      ...(wouldHaveMore ? { nextCursor: entry.displayTag } : {})
    });
    // retain the last response below the byte ceiling
    if (requestBytes(candidate) > MAX_INVENTORY_ACK_BYTES) break;
    entries.push(entry);
    // enforce the count ceiling
    if (entries.length >= MAX_INVENTORY_ENTRIES) break;
  }
  const hasMore = entries.length < available.length;
  return {
    outcome: 'listed',
    audibleClaim: false,
    entries,
    ...(hasMore && entries.length > 0 ? { nextCursor: entries[entries.length - 1].displayTag } : {})
  };
}

// attempt native sound once for an exact current display
async function soundFallback(event) {
  const notifications = await currentNotifications();
  const candidate = notifications.find(notification => notification.tag === event.displayTag);
  // report an absent tray resource
  if (candidate === undefined) return eventResult('not-found', event);
  const displayed = strictEvent(candidate.data, false);
  // refuse to mutate a newer or malformed occupant
  if (displayed === undefined || !exactMatch(displayed, event) || candidate.tag !== displayed.displayTag) return eventResult('stale', event);
  // fence a compatibility alert behind strict same-epoch progress
  const newerDisplayed = notifications.some(notification => {
    const current = displayedEvent(notification);
    return current !== undefined
      && current.entityId === displayed.entityId
      && current.eventEpoch === displayed.eventEpoch
      && current.eventSequence > displayed.eventSequence;
  });
  // refuse stale sound without ordering equal or cross-epoch alerts
  if (newerDisplayed) return eventResult('stale', event);
  const preference = await soundPreference();
  // refuse fallback when mute cannot be authoritatively rechecked
  if (!preference.known) return eventResult('unavailable', event);
  // honor the current muted preference
  if (preference.muted) return eventResult('muted', event);
  // refuse a repeated native attempt after restart or retry
  if (candidate.data.nativeFallbackAttempted === true) return eventResult('duplicate', event);
  const data = { ...candidate.data, nativeFallbackAttempted: true };
  let show;
  try {
    show = Promise.resolve(self.registration.showNotification(candidate.title, {
      body: candidate.body,
      tag: candidate.tag,
      icon: candidate.icon || '/favicon.svg',
      badge: candidate.badge || '/notification-badge.png',
      timestamp: candidate.timestamp,
      silent: false,
      renotify: true,
      requireInteraction: candidate.requireInteraction,
      data
    }));
  } catch (error) {
    show = Promise.reject(error);
  }
  const fields = diagnosticFields(displayed);
  void startJournal({ stage: 'show_started', attempt: 1, ...fields });
  try {
    await show;
    void startJournal({ stage: 'show_succeeded', attempt: 1, status: 'native-fallback', ...fields });
  } catch (error) {
    void startJournal({ stage: 'show_failed', attempt: 1, status: 'show-rejected', ...fields });
    throw error;
  }
  return eventResult('displayed', event, false);
}

// execute one validated page operation
async function handleWorkerRequest(request) {
  // display through the same serialized arbiter
  if (request.operation === 'display') {
    const result = await displayStrictEvent(request.event, 'page');
    return eventResult(result.outcome, request.event, result.audibleClaim && request.soundRequested, result.displayTag);
  }
  // close only exact identity
  if (request.operation === 'close') return await closeExact(request.event);
  // reconcile only page-proved obsolete identity
  if (request.operation === 'reconcile') return await reconcileExact(request);
  // list worker-owned identities without mutation
  if (request.operation === 'inventory') return await listInventory(request);
  return await soundFallback(request.event);
}

// build an allowlisted worker acknowledgement
function acknowledgement(requestId, result) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    outcome: result.outcome,
    audibleClaim: result.audibleClaim === true,
    ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
    ...(result.eventEpoch === undefined ? {} : { eventEpoch: result.eventEpoch }),
    ...(result.eventSequence === undefined ? {} : { eventSequence: result.eventSequence }),
    ...(result.displayTag === undefined ? {} : { displayTag: result.displayTag }),
    ...(result.snapshotToken === undefined ? {} : { snapshotToken: result.snapshotToken }),
    ...(result.entries === undefined ? {} : { entries: result.entries }),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor })
  };
}

// send one acknowledgement without extending queue ownership
function reply(port, message) {
  // ignore missing reply channels
  if (typeof port?.postMessage !== 'function') return;
  port.postMessage(message);
}

// install immediately under the existing update policy
self.addEventListener('install', () => self.skipWaiting());

// claim same-origin pages after activation
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// retain a fetch handler for worker registration behavior
self.addEventListener('fetch', () => {});

// display every received push inside its own operation promise
self.addEventListener('push', event => {
  const operation = enqueueOperation(async () => await handlePush(event));
  const lifetime = operation.then(
    result => diagnosticLifetime().then(() => result),
    error => diagnosticLifetime().then(() => { throw error; })
  );
  event.waitUntil(lifetime);
});

// arbitrate healthy page display, close, reconciliation, and sound fallback
self.addEventListener('message', event => {
  const port = event.ports?.[0];
  const requestId = isIdentifier(event.data?.requestId, 128) ? event.data.requestId : 'invalid';
  const request = validMessageSource(event.source) ? workerRequest(event.data) : undefined;
  // reject invalid requests before queue entry
  if (request === undefined) {
    const response = Promise.resolve().then(() => reply(port, acknowledgement(requestId, { outcome: 'invalid', audibleClaim: false })));
    event.waitUntil?.(response);
    return;
  }
  const operation = enqueueOperation(async () => await handleWorkerRequest(request));
  const response = operation.then(
    result => acknowledgement(request.requestId, result),
    () => acknowledgement(request.requestId, { outcome: 'unavailable', audibleClaim: false, ...(request.event ?? {}), ...(request.snapshotToken === undefined ? {} : { snapshotToken: request.snapshotToken }) })
  );
  const lifetime = response.then(message => reply(port, message)).then(async () => await diagnosticLifetime());
  event.waitUntil?.(lifetime);
});

// request authenticated resynchronization without mutating subscriptions
self.addEventListener('pushsubscriptionchange', event => {
  const operation = self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then(windows => {
    // notify each controlled page with a content-free hint
    for (const client of windows) client.postMessage({ type: 'rac-push-subscription-change', protocolVersion: PROTOCOL_VERSION });
  });
  event.waitUntil(operation);
});

// route clicks to a safe same-origin destination
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = isRecord(event.notification.data) ? event.notification.data : {};
    const destination = notificationRoute(data);
    const url = new URL(destination, self.location.origin).href;
    const existing = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = existing.find(candidate => {
      try {
        return new URL(candidate.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    // focus an existing same-origin window when possible
    if (client !== undefined) {
      const target = await client.navigate(url).catch(() => client);
      return (target?.focus() ?? Promise.resolve()).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  })());
});
