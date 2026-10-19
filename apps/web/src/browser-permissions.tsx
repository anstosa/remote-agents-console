import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { beginBrowserPermissionApproval, forgetBrowserPermission, forgetBrowserPermissions, hasSavedBrowserPermission, isCurrentBrowserPermissionApproval, saveBrowserPermission, savedBrowserPermissionToken, type BrowserPermissionCapability } from './browser-permission-grants.js';

import { clipboardCapability, clipboardError, parseClipboardItems, performClipboard, validClipboardText, type ClipboardOperation, type ClipboardPayload } from './browser-clipboard.js';

type BrowserPermissionOperation = ClipboardOperation | 'clipboard-cancel' | 'connect' | 'geolocation-get' | 'geolocation-watch' | 'geolocation-clear' | 'notification-permission' | 'notification-show' | 'notification-close';
type BrowserPermissionStatus = 'ok' | 'denied' | 'error';
type BrowserPermissionError = { code: 1 | 2 | 3; message: string; name?: string };
type BrowserPermissionRequest = ClipboardPayload & {
  type: 'rac-browser-permission-request';
  clientId: string;
  id: string;
  operation: BrowserPermissionOperation;
  options?: unknown;
  watchId?: string;
  notificationId?: string;
  title?: string;
  requestId?: string;
};
type BrowserPosition = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};
type BrowserPermissionResponse = ClipboardPayload & {
  type: 'rac-browser-permission-response';
  clientId: string;
  id: string;
  status: BrowserPermissionStatus;
  permission?: NotificationPermission;
  position?: BrowserPosition;
  error?: BrowserPermissionError;
  event?: 'show' | 'click' | 'close' | 'error';
  watchId?: string;
  notificationId?: string;
};
type GeolocationRequestOptions = { enableHighAccuracy: boolean; timeout: number; maximumAge: number };
type NativeNotificationOutcome = { status: 'ok'; permission: NotificationPermission } | { status: 'error'; error: unknown };
type PreviewNotificationOptions = { body?: string; tag?: string; silent?: boolean; requireInteraction?: boolean };
type ParsedRequest = BrowserPermissionRequest & { geoOptions?: GeolocationRequestOptions; notificationOptions?: PreviewNotificationOptions };
type ActiveDocument = {
  clientId: string;
  ownerId: string;
  generation: number;
  source: Window;
  origin: string;
  deniedCapabilities: Set<BrowserPermissionCapability>;
  notificationConsentRevision: number;
  requests: Map<string, BrowserPermissionOperation>;
};
type QueuedPermission = { capability: BrowserPermissionCapability; request: ParsedRequest; document: ActiveDocument };
type ActiveWatch = { nativeId: number; generation: number };
type ActiveNotification = { generation: number; native?: Notification; serviceWorkerTag?: string; previewOwnerId?: string; previewClientId?: string; previewNotificationId?: string; pending?: boolean };
type WorkerNotificationOwner = { serviceWorkerTag: string; previewOwnerId: string; previewClientId: string; previewNotificationId: string };
type BrowserPermissionBrokerOptions = {
  frameRef: RefObject<HTMLIFrameElement | null>;
  homeOrigin: string;
  isManaged: () => boolean;
};
type BrowserPermissionBroker = {
  consent: ReactElement | null;
  error: string | undefined;
  forgetGrants: () => boolean;
  revoke: () => void;
  frameLoaded: () => void;
};

const maxPendingRequests = 16;
const maxInFlightRequests = 16;
const maxWatches = 8;
const maxNotifications = 16;
const maxRememberedRequestIds = 128;
const parentCapabilityOwners = new Set<object>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestKeys = new Set(['type', 'clientId', 'id', 'operation', 'options', 'watchId', 'notificationId', 'title', 'text', 'items', 'requestId']);
const disconnectKeys = new Set(['type', 'clientId', 'id']);
const operations = new Set<BrowserPermissionOperation>(['connect', 'geolocation-get', 'geolocation-watch', 'geolocation-clear', 'notification-permission', 'notification-show', 'notification-close', 'clipboard-read-text', 'clipboard-write-text', 'clipboard-read', 'clipboard-write', 'clipboard-cancel']);
const notificationOptionKeys = new Set(['body', 'tag', 'silent', 'requireInteraction']);
const geolocationOptionKeys = new Set(['enableHighAccuracy', 'timeout', 'maximumAge']);
const capabilityNames: Record<BrowserPermissionCapability, string> = { geolocation: 'location', notifications: 'notifications', 'clipboard-read': 'clipboard reading', 'clipboard-write': 'clipboard writing' };
const capabilityDescriptions: Record<BrowserPermissionCapability, string> = {
  geolocation: 'wants to use your location in this preview.',
  notifications: 'wants Remote Agent Console to show notifications for this preview. Notifications identify this preview and are displayed by Remote Agent Console.',
  'clipboard-read': 'wants to read your clipboard contents in this preview.',
  'clipboard-write': 'wants to replace your clipboard contents from this preview.'
};


// read native notification permission with an unsupported-browser fallback
const currentNotificationPermission = (): NotificationPermission => 'Notification' in window ? Notification.permission : 'denied';

// reserve opaque parent-lifetime slots that survive preview hook replacement
const reserveParentCapabilityOwners = (count: number): object[] | undefined => {
  // reject native work before exceeding the parent window's fixed capacity
  if (count < 1 || parentCapabilityOwners.size + count > maxInFlightRequests) return undefined;
  const owners = Array.from({ length: count }, () => ({}));
  // retain every logical operation until its native work actually settles
  for (const owner of owners) parentCapabilityOwners.add(owner);
  return owners;
};

// release native-operation slots independently of preview document liveness
const releaseParentCapabilityOwners = (owners: readonly object[]): void => {
  // release every logical operation in one native batch
  for (const owner of owners) parentCapabilityOwners.delete(owner);
};

// narrow unknown structured-clone values before reading protocol fields
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// accept protocol nonces only in canonical uuid form
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);

// reject extra fields so large or active notification payloads never cross the broker
const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => {
  // inspect every own enumerable field
  for (const key of Object.keys(value)) {
    // fail closed on fields outside the operation schema
    if (!allowed.has(key)) return false;
  }
  return true;
};

// validate bounded geolocation options and supply parent-owned defaults
const parseGeolocationOptions = (value: unknown): GeolocationRequestOptions | undefined => {
  // use conservative native defaults when the preview omits options
  if (value === undefined) return { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 };
  // reject arrays, null, and unknown option fields
  if (!isRecord(value) || !hasOnlyKeys(value, geolocationOptionKeys)) return undefined;
  const enableHighAccuracy = value.enableHighAccuracy ?? false;
  const timeout = value.timeout ?? 30_000;
  const maximumAge = value.maximumAge ?? 0;
  // require exact primitive types and finite bounded durations
  if (typeof enableHighAccuracy !== 'boolean'
    || typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > 60_000
    || typeof maximumAge !== 'number' || !Number.isFinite(maximumAge) || maximumAge < 0 || maximumAge > 86_400_000) return undefined;
  return { enableHighAccuracy, timeout, maximumAge };
};

// validate the intentionally small notification surface
const parseNotificationOptions = (value: unknown): PreviewNotificationOptions | undefined => {
  // treat an omitted options object as empty
  if (value === undefined) return {};
  // reject active fields such as data, actions, icons, and urls
  if (!isRecord(value) || !hasOnlyKeys(value, notificationOptionKeys)) return undefined;
  const { body, tag, silent, requireInteraction } = value;
  // enforce bounded text and exact booleans
  if (body !== undefined && (typeof body !== 'string' || body.length > 2_000)
    || tag !== undefined && (typeof tag !== 'string' || tag.length > 128)
    || silent !== undefined && typeof silent !== 'boolean'
    || requireInteraction !== undefined && typeof requireInteraction !== 'boolean') return undefined;
  return {
    ...(body === undefined ? {} : { body }),
    ...(tag === undefined ? {} : { tag }),
    ...(silent === undefined ? {} : { silent }),
    ...(requireInteraction === undefined ? {} : { requireInteraction })
  };
};

// parse one request without retaining attacker-controlled object references
const parseRequest = (value: unknown): ParsedRequest | undefined => {
  // require the shared envelope and reject oversized schemas
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)
    || value.type !== 'rac-browser-permission-request'
    || !isUuid(value.clientId) || !isUuid(value.id)
    || typeof value.operation !== 'string' || !operations.has(value.operation as BrowserPermissionOperation)) return undefined;
  const operation = value.operation as BrowserPermissionOperation;
  const request: BrowserPermissionRequest = {
    type: 'rac-browser-permission-request',
    clientId: value.clientId,
    id: value.id,
    operation,
    ...(value.options === undefined ? {} : { options: value.options }),
    ...(value.watchId === undefined ? {} : { watchId: value.watchId as string }),
    ...(value.notificationId === undefined ? {} : { notificationId: value.notificationId as string }),
    ...(value.title === undefined ? {} : { title: value.title as string })
  };
  // clipboard messages carry only their own operation-specific payload
  if (clipboardCapability(operation) !== undefined || operation === 'clipboard-cancel') {
    // reject fields belonging to unrelated capability protocols
    if (value.options !== undefined || value.watchId !== undefined || value.notificationId !== undefined || value.title !== undefined) return undefined;
    // cancellation names exactly one owned clipboard request
    if (operation === 'clipboard-cancel') return isUuid(value.requestId) && value.text === undefined && value.items === undefined ? { ...request, requestId: value.requestId } : undefined;
    // clipboard operations cannot name other requests
    if (value.requestId !== undefined) return undefined;
    // text writes require an exact bounded string
    if (operation === 'clipboard-write-text') return validClipboardText(value.text) && value.items === undefined ? { ...request, text: value.text } : undefined;
    // rich writes retain only validated cloneable representations
    if (operation === 'clipboard-write') {
      const items = parseClipboardItems(value.items);
      return items !== undefined && value.text === undefined ? { ...request, items } : undefined;
    }
    return value.text === undefined && value.items === undefined ? request : undefined;
  }
  // prevent clipboard payloads from hitchhiking on other capability requests
  if (value.text !== undefined || value.items !== undefined || value.requestId !== undefined) return undefined;
  // connect carries no operation payload
  if (operation === 'connect') return value.options === undefined && value.watchId === undefined && value.notificationId === undefined && value.title === undefined ? request : undefined;
  // validate geolocation starts separately from clear
  if (operation === 'geolocation-get' || operation === 'geolocation-watch') {
    const geoOptions = parseGeolocationOptions(value.options);
    // reject malformed or unrelated fields
    if (geoOptions === undefined || value.watchId !== undefined || value.notificationId !== undefined || value.title !== undefined) return undefined;
    return { ...request, geoOptions };
  }
  // require the existing watch nonce for clear
  if (operation === 'geolocation-clear') return isUuid(value.watchId) && value.options === undefined && value.notificationId === undefined && value.title === undefined ? { ...request, watchId: value.watchId } : undefined;
  // notification permission carries no display data
  if (operation === 'notification-permission') return value.options === undefined && value.watchId === undefined && value.notificationId === undefined && value.title === undefined ? request : undefined;
  // validate notification text and passive options
  if (operation === 'notification-show') {
    const notificationOptions = parseNotificationOptions(value.options);
    // reject missing or oversized titles and unrelated identifiers
    if (typeof value.title !== 'string' || value.title.length > 200 || notificationOptions === undefined || value.watchId !== undefined || value.notificationId !== undefined) return undefined;
    return { ...request, title: value.title, notificationOptions };
  }
  // require the original notification nonce for close
  if (operation === 'notification-close') return isUuid(value.notificationId) && value.options === undefined && value.watchId === undefined && value.title === undefined ? { ...request, notificationId: value.notificationId } : undefined;
  return undefined;
};

// recognize an unloading document's immediate capability revocation signal
const isDisconnectMessage = (value: unknown): value is { type: 'rac-browser-permission-disconnect'; clientId: string; id: string } => isRecord(value)
  && hasOnlyKeys(value, disconnectKeys)
  && value.type === 'rac-browser-permission-disconnect'
  && isUuid(value.clientId)
  && isUuid(value.id);

// close only worker notifications that still carry this exact preview owner
const closeOwnedWorkerNotifications = async (registration: ServiceWorkerRegistration, owner: WorkerNotificationOwner): Promise<void> => {
  const displayed = await registration.getNotifications({ tag: owner.serviceWorkerTag });
  // filter again because tags intentionally implement replacement semantics
  for (const notification of displayed) {
    const data = notification.data;
    // preserve a newer same-tag notification owned by another request
    if (notification.tag !== owner.serviceWorkerTag || !isRecord(data) || data.previewOwnerId !== owner.previewOwnerId || data.previewClientId !== owner.previewClientId || data.previewNotificationId !== owner.previewNotificationId) continue;
    notification.close();
  }
};

// convert browser permission errors to the bridge's bounded shape
const bridgeError = (message: string, code: 1 | 2 | 3 = 2): BrowserPermissionError => ({ code, message: Array.from(message).slice(0, 500).join('') });

// copy nullable coordinate fields without exposing native prototypes
const finiteCoordinate = (value: number | null): number | null | undefined => value === null ? null : Number.isFinite(value) ? value : undefined;

// copy required coordinate fields without accepting nonfinite values
const finiteRequiredCoordinate = (value: number): number | undefined => Number.isFinite(value) ? value : undefined;

// serialize a native position into plain finite values
const serializePosition = (position: GeolocationPosition): BrowserPosition | undefined => {
  const latitude = finiteRequiredCoordinate(position.coords.latitude);
  const longitude = finiteRequiredCoordinate(position.coords.longitude);
  const accuracy = finiteRequiredCoordinate(position.coords.accuracy);
  const altitude = finiteCoordinate(position.coords.altitude);
  const altitudeAccuracy = finiteCoordinate(position.coords.altitudeAccuracy);
  const heading = finiteCoordinate(position.coords.heading);
  const speed = finiteCoordinate(position.coords.speed);
  // reject any nonfinite coordinate or timestamp
  if (latitude === undefined || longitude === undefined || accuracy === undefined || altitude === undefined || altitudeAccuracy === undefined || heading === undefined || speed === undefined || !Number.isFinite(position.timestamp)) return undefined;
  return { coords: { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed }, timestamp: position.timestamp };
};

// map native geolocation failures without passing mutable browser objects
const serializeGeolocationError = (error: GeolocationPositionError): BrowserPermissionError => {
  const code = error.code === 1 || error.code === 2 || error.code === 3 ? error.code : 2;
  return bridgeError(error.message || 'Location is unavailable', code);
};

// own preview capabilities at the parent frame boundary
export function useBrowserPermissionBroker({ frameRef, homeOrigin, isManaged }: BrowserPermissionBrokerOptions): BrowserPermissionBroker {
  const generationRef = useRef(0);
  const activeDocumentRef = useRef<ActiveDocument | undefined>(undefined);
  const queueRef = useRef<QueuedPermission[]>([]);
  const watchesRef = useRef(new Map<string, ActiveWatch>());
  const notificationsRef = useRef(new Map<string, ActiveNotification>());
  const inFlightRequestsRef = useRef(new Set<string>());
  const cancelledRequestsRef = useRef(new Set<string>());
  const connectSerialRef = useRef(0);
  const handledLoadConnectSerialRef = useRef(0);
  const consentRef = useRef<HTMLElement | null>(null);
  const [prompt, setPrompt] = useState<QueuedPermission>();
  const [error, setError] = useState<string>();
  const previewOrigin = homeOrigin;

  // confirm that the current frame still owns the managed preview authority
  const isLiveDocument = useCallback((document: ActiveDocument): boolean => {
    const frameWindow = frameRef.current?.contentWindow;
    return frameWindow !== null && frameWindow !== undefined
      && frameWindow === document.source
      && document.origin === homeOrigin
      && activeDocumentRef.current === document
      && activeDocumentRef.current.generation === document.generation
      && isManaged();
  }, [frameRef, homeOrigin, isManaged]);

  // send only to the still-current managed document
  const respond = useCallback((document: ActiveDocument, request: Pick<BrowserPermissionRequest, 'clientId' | 'id'>, response: Omit<BrowserPermissionResponse, 'type' | 'clientId' | 'id'>): void => {
    // ignore late native callbacks and navigation races
    if (!isLiveDocument(document) || request.clientId !== document.clientId || cancelledRequestsRef.current.has(request.id)) return;
    document.source.postMessage({ type: 'rac-browser-permission-response', clientId: request.clientId, id: request.id, ...response } satisfies BrowserPermissionResponse, homeOrigin);
  }, [homeOrigin, isLiveDocument]);

  // close all parent resources owned by one preview document
  const clearResources = useCallback((): void => {
    // release every native geolocation watcher
    for (const watch of watchesRef.current.values()) navigator.geolocation?.clearWatch(watch.nativeId);
    watchesRef.current.clear();
    // close every foreground or service-worker notification
    for (const notification of notificationsRef.current.values()) {
      notification.native?.close();
      // service-worker notifications require an asynchronous lookup by parent-generated tag
      if (notification.serviceWorkerTag !== undefined && notification.previewOwnerId !== undefined && notification.previewClientId !== undefined && notification.previewNotificationId !== undefined && 'serviceWorker' in navigator) {
        const owner: WorkerNotificationOwner = { serviceWorkerTag: notification.serviceWorkerTag, previewOwnerId: notification.previewOwnerId, previewClientId: notification.previewClientId, previewNotificationId: notification.previewNotificationId };
        void navigator.serviceWorker.getRegistration().then(async registration => {
          // skip a service worker that no longer owns this app
          if (registration === undefined) return;
          // close only the notification issued for this exact preview request
          await closeOwnedWorkerNotifications(registration, owner);
        }).catch(() => { /* revocation remains best-effort when the browser removes its worker */ });
      }
    }
    notificationsRef.current.clear();
    inFlightRequestsRef.current.clear();
  }, []);

  // revoke one document without replying into a replacement frame
  const resetDocument = useCallback((): void => {
    generationRef.current += 1;
    activeDocumentRef.current = undefined;
    queueRef.current = [];
    cancelledRequestsRef.current.clear();
    setPrompt(undefined);
    clearResources();
  }, [clearResources]);

  // revoke synchronously before a parent-directed source change
  const revoke = useCallback((): void => {
    handledLoadConnectSerialRef.current = connectSerialRef.current;
    resetDocument();
  }, [resetDocument]);

  // clear durable approval before allowing a refreshed preview to reconnect
  const forgetGrants = useCallback((): boolean => {
    const removed = forgetBrowserPermissions(homeOrigin);
    revoke();
    setError(removed ? undefined : 'Saved approvals could not be cleared. Clear RAC site data to revoke them.');
    return removed;
  }, [homeOrigin, revoke]);

  // report storage failures without silently creating a document-wide grant
  const rememberGrant = useCallback((document: ActiveDocument, capability: BrowserPermissionCapability, token: string): boolean => {
    const saved = saveBrowserPermission(document.origin, capability, token);
    setError(saved ? undefined : 'Approval could not be saved. Only the current request was allowed.');
    return saved;
  }, []);

  // revoke unknown navigations while preserving a new document that connected before load
  const frameLoaded = useCallback((): void => {
    // adopt the nonce sent by this newly loaded managed document
    if (activeDocumentRef.current !== undefined && connectSerialRef.current > handledLoadConnectSerialRef.current && isLiveDocument(activeDocumentRef.current)) {
      handledLoadConnectSerialRef.current = connectSerialRef.current;
      return;
    }
    handledLoadConnectSerialRef.current = connectSerialRef.current;
    resetDocument();
  }, [isLiveDocument, resetDocument]);

  // show the next still-live consent request
  const advancePrompt = useCallback((): void => {
    // discard queued requests from replaced documents
    while (queueRef.current.length > 0 && !isLiveDocument(queueRef.current[0].document)) queueRef.current.shift();
    setPrompt(queueRef.current[0]);
  }, [isLiveDocument]);

  // return a bounded geolocation result to the requesting document
  const respondWithPosition = useCallback((document: ActiveDocument, request: ParsedRequest, position: GeolocationPosition): void => {
    const serialized = serializePosition(position);
    // reject unsafe native numeric values
    if (serialized === undefined) { respond(document, request, { status: 'error', error: bridgeError('Location returned invalid coordinates') }); return; }
    respond(document, request, { status: 'ok', position: serialized, ...(request.operation === 'geolocation-watch' ? { watchId: request.id } : {}) });
  }, [respond]);

  // invoke a granted geolocation operation
  const executeGeolocation = useCallback((document: ActiveDocument, request: ParsedRequest): void => {
    // stop transport-cancelled work before invoking native capabilities
    if (cancelledRequestsRef.current.has(request.id)) return;
    // fail cleanly when the host browser has no geolocation provider
    if (navigator.geolocation === undefined || request.geoOptions === undefined) { respond(document, request, { status: 'error', error: bridgeError('Location is unavailable') }); return; }
    const options: PositionOptions = request.geoOptions;
    // run one finite location request
    if (request.operation === 'geolocation-get') {
      // keep native operations independently bounded from replay history
      if (inFlightRequestsRef.current.size >= maxInFlightRequests) { respond(document, request, { status: 'error', error: bridgeError('Too many active permission operations') }); return; }
      const parentOwners = reserveParentCapabilityOwners(1);
      // retain capacity across document replacement until the provider settles
      if (parentOwners === undefined) { respond(document, request, { status: 'error', error: bridgeError('Too many active permission operations') }); return; }
      inFlightRequestsRef.current.add(request.id);
      try {
        navigator.geolocation.getCurrentPosition(
          position => {
            releaseParentCapabilityOwners(parentOwners);
            // leave replacement-document ownership untouched
            if (!isLiveDocument(document)) return;
            inFlightRequestsRef.current.delete(request.id);
            // consume transport cancellation without replying to an abandoned operation
            if (cancelledRequestsRef.current.delete(request.id)) return;
            respondWithPosition(document, request, position);
          },
          error => {
            releaseParentCapabilityOwners(parentOwners);
            // leave replacement-document ownership untouched
            if (!isLiveDocument(document)) return;
            inFlightRequestsRef.current.delete(request.id);
            // consume transport cancellation without replying to an abandoned operation
            if (cancelledRequestsRef.current.delete(request.id)) return;
            respond(document, request, { status: error.code === 1 ? 'denied' : 'error', error: serializeGeolocationError(error) });
          },
          options
        );
      } catch (error) { releaseParentCapabilityOwners(parentOwners); inFlightRequestsRef.current.delete(request.id); respond(document, request, { status: 'error', error: bridgeError(error instanceof Error ? error.message : 'Location request failed') }); }
      return;
    }
    // reserve bounded watcher capacity before invoking native code
    if (request.operation !== 'geolocation-watch' || watchesRef.current.size >= maxWatches) { respond(document, request, { status: 'error', error: bridgeError(request.operation === 'geolocation-watch' ? 'Too many active location watchers' : 'Invalid location operation') }); return; }
    try {
      const nativeId = navigator.geolocation.watchPosition(
        position => {
          // ignore a callback after this watcher was cleared
          if (watchesRef.current.get(request.id)?.generation !== document.generation) return;
          respondWithPosition(document, request, position);
        },
        error => {
          const activeWatch = watchesRef.current.get(request.id);
          // ignore a callback after this watcher was cleared or replaced
          if (activeWatch?.generation !== document.generation) return;
          // release terminal permission-denied watches and their bounded slot
          if (error.code === 1) {
            watchesRef.current.delete(request.id);
            try { navigator.geolocation.clearWatch(activeWatch.nativeId); }
            catch { /* the ownership slot is released even if the provider rejects cleanup */ }
          }
          respond(document, request, { status: error.code === 1 ? 'denied' : 'error', watchId: request.id, error: serializeGeolocationError(error) });
        },
        options
      );
      watchesRef.current.set(request.id, { nativeId, generation: document.generation });
    } catch (error) { respond(document, request, { status: 'error', error: bridgeError(error instanceof Error ? error.message : 'Location watch failed') }); }
  }, [isLiveDocument, respond, respondWithPosition]);

  // reconcile completed worker owners against notifications still displayed by the browser
  const reconcileWorkerNotifications = useCallback(async (document: ActiveDocument, registration: ServiceWorkerRegistration): Promise<boolean> => {
    let displayed: Notification[];
    try { displayed = await registration.getNotifications(); }
    catch { return false; }
    // leave replacement-document ownership untouched after the asynchronous browser query
    if (!isLiveDocument(document)) return false;
    // inspect only the bounded owners for this connected document
    for (const [notificationId, owner] of notificationsRef.current) {
      // retain foreground, pending, and replacement-document owners
      if (owner.generation !== document.generation || owner.native !== undefined || owner.pending !== false || owner.serviceWorkerTag === undefined || owner.previewOwnerId !== document.ownerId || owner.previewClientId !== document.clientId || owner.previewNotificationId !== notificationId) continue;
      const retained = displayed.some(notification => isRecord(notification.data)
        && notification.data.previewOwnerId === owner.previewOwnerId
        && notification.data.previewClientId === owner.previewClientId
        && notification.data.previewNotificationId === owner.previewNotificationId
        && notification.tag === owner.serviceWorkerTag);
      // retain worker notifications verified as still displayed
      if (retained || notificationsRef.current.get(notificationId) !== owner) continue;
      notificationsRef.current.delete(notificationId);
      respond(document, { clientId: document.clientId, id: notificationId }, { status: 'ok', permission: 'granted', event: 'close', notificationId });
    }
    return true;
  }, [isLiveDocument, respond]);

  // emit one foreground notification with parent-owned attribution
  const showNotification = useCallback(async (document: ActiveDocument, request: ParsedRequest): Promise<void> => {
    const options = request.notificationOptions;
    // retain validation guarantees across async permission resolution
    if (options === undefined || request.title === undefined || !isLiveDocument(document) || cancelledRequestsRef.current.has(request.id)) return;
    // require the native permission even after explicit preview consent
    if (currentNotificationPermission() !== 'granted') { respond(document, request, { status: 'denied', permission: 'denied', error: bridgeError('Notifications are not permitted', 1), notificationId: request.id }); return; }
    // bound every asynchronous notification path before native or worker access
    if (inFlightRequestsRef.current.size >= maxInFlightRequests) { respond(document, request, { status: 'error', permission: Notification.permission, error: bridgeError('Too many active permission operations'), notificationId: request.id }); return; }
    const parentOwners = reserveParentCapabilityOwners(1);
    // retain capacity across document replacement until notification work settles
    if (parentOwners === undefined) { respond(document, request, { status: 'error', permission: Notification.permission, error: bridgeError('Too many active permission operations'), notificationId: request.id }); return; }
    inFlightRequestsRef.current.add(request.id);
    try {
      let workerRegistration: ServiceWorkerRegistration | undefined;
      // reconcile only verified worker owners before rejecting a full notification set
      if (notificationsRef.current.size >= maxNotifications && 'serviceWorker' in navigator) {
        try {
          workerRegistration = await navigator.serviceWorker.getRegistration();
          // stop without mutating a replacement document after the lookup
          if (!isLiveDocument(document)) return;
          // stop a transport-cancelled show before native display
          if (cancelledRequestsRef.current.delete(request.id)) return;
          // reconcile only through an installed parent registration
          if (workerRegistration !== undefined) await reconcileWorkerNotifications(document, workerRegistration);
          // stop a close or navigation that occurred during reconciliation
          if (!isLiveDocument(document) || cancelledRequestsRef.current.delete(request.id)) return;
        } catch { /* preserve unverified owners and fail the current request below */ }
      }
      // consume a close that raced a failed capacity reconciliation
      if (!isLiveDocument(document) || cancelledRequestsRef.current.delete(request.id)) return;
      // enforce bounded live notification ownership after verified reconciliation
      if (notificationsRef.current.size >= maxNotifications) { respond(document, request, { status: 'error', permission: Notification.permission, error: bridgeError('Too many active preview notifications'), notificationId: request.id }); return; }
      const attributedTitle = `Preview ${previewOrigin} — ${request.title}`;
      const attributedBody = options.body === undefined || options.body.length === 0 ? 'Shown by Remote Agent Console' : `Shown by Remote Agent Console\n\n${options.body}`;
      const parentTag = options.tag ? `rac-preview:${document.clientId}:tag:${options.tag}` : `rac-preview:${document.clientId}:id:${request.id}`;
      const nativeOptions: NotificationOptions = { body: attributedBody, tag: parentTag, silent: options.silent, requireInteraction: options.requireInteraction };
      // reserve capacity before any asynchronous fallback work begins
      const reservation: ActiveNotification = { generation: document.generation, serviceWorkerTag: parentTag, previewOwnerId: document.ownerId, previewClientId: document.clientId, previewNotificationId: request.id, pending: true };
      notificationsRef.current.set(request.id, reservation);
      // remove only this async notification owner, never a replacement document's reused id
      const deleteReservation = (): void => {
        // preserve a newer owner stored under the same document-local id
        if (notificationsRef.current.get(request.id) === reservation) notificationsRef.current.delete(request.id);
      };
      try {
        const notification = new Notification(attributedTitle, nativeOptions);
        notificationsRef.current.set(request.id, { generation: document.generation, native: notification });
        notification.onshow = () => {
          // ignore events after explicit close removed ownership
          if (notificationsRef.current.get(request.id)?.native !== notification) return;
          respond(document, request, { status: 'ok', permission: 'granted', event: 'show', notificationId: request.id });
        };
        notification.onclick = () => {
          // ignore events after explicit close removed ownership
          if (notificationsRef.current.get(request.id)?.native !== notification) return;
          window.focus();
          respond(document, request, { status: 'ok', permission: 'granted', event: 'click', notificationId: request.id });
        };
        notification.onclose = () => {
          // ignore events after explicit close removed ownership
          if (notificationsRef.current.get(request.id)?.native !== notification) return;
          notificationsRef.current.delete(request.id);
          respond(document, request, { status: 'ok', permission: 'granted', event: 'close', notificationId: request.id });
        };
        notification.onerror = () => {
          // ignore events after explicit close removed ownership
          if (notificationsRef.current.get(request.id)?.native !== notification) return;
          notificationsRef.current.delete(request.id);
          respond(document, request, { status: 'error', permission: Notification.permission, event: 'error', error: bridgeError('Notification display failed'), notificationId: request.id });
        };
        respond(document, request, { status: 'ok', permission: 'granted', notificationId: request.id });
        return;
      } catch {
        // mobile browsers may require the existing parent service worker
      }
      // fail cleanly where neither foreground nor worker notifications exist
      if (!('serviceWorker' in navigator)) { deleteReservation(); respond(document, request, { status: 'error', permission: Notification.permission, error: bridgeError('Notification display is unavailable'), notificationId: request.id }); return; }
      try {
        const registration = workerRegistration ?? await navigator.serviceWorker.getRegistration();
        // leave replacement-document ownership untouched after an old async lookup
        if (!isLiveDocument(document)) { deleteReservation(); return; }
        // consume transport cancellation only for this still-live document
        if (cancelledRequestsRef.current.delete(request.id)) { deleteReservation(); return; }
        // require an already installed parent worker rather than waiting indefinitely
        if (registration === undefined) { deleteReservation(); respond(document, request, { status: 'error', permission: Notification.permission, error: bridgeError('Notification display is unavailable'), notificationId: request.id }); return; }
        await registration.showNotification(attributedTitle, { ...nativeOptions, data: { url: '/', kind: 'preview', previewOwnerId: document.ownerId, previewClientId: document.clientId, previewNotificationId: request.id } });
        // close a display that completed after navigation or transport cancellation
        if (!isLiveDocument(document) || cancelledRequestsRef.current.delete(request.id)) {
          await closeOwnedWorkerNotifications(registration, { serviceWorkerTag: parentTag, previewOwnerId: document.ownerId, previewClientId: document.clientId, previewNotificationId: request.id });
          deleteReservation();
          return;
        }
        // reconcile replaced tags while retaining this pending owner during the query
        await reconcileWorkerNotifications(document, registration);
        // stop a close or navigation that occurred during reconciliation
        if (!isLiveDocument(document) || cancelledRequestsRef.current.delete(request.id) || notificationsRef.current.get(request.id) !== reservation) { deleteReservation(); return; }
        reservation.pending = false;
        respond(document, request, { status: 'ok', permission: 'granted', event: 'show', notificationId: request.id });
      } catch (error) {
        // leave replacement-document ownership untouched after an old async failure
        if (!isLiveDocument(document)) { deleteReservation(); return; }
        // consume cancellation only for this still-live document
        if (cancelledRequestsRef.current.delete(request.id)) { deleteReservation(); return; }
        deleteReservation();
        respond(document, request, { status: 'error', permission: Notification.permission, event: 'error', error: bridgeError(error instanceof Error ? error.message : 'Notification display failed'), notificationId: request.id });
      }
    } finally {
      releaseParentCapabilityOwners(parentOwners);
      // release only this still-current document's shared async slot
      if (isLiveDocument(document)) inFlightRequestsRef.current.delete(request.id);
    }
  }, [isLiveDocument, previewOrigin, reconcileWorkerNotifications, respond]);

  // retain native clipboard authority until completion without leaking stale reads
  const executeClipboard = useCallback((document: ActiveDocument, request: ParsedRequest, mode: 'once' | 'always' | 'saved', approvalToken: string | undefined): void => {
    const capability = clipboardCapability(request.operation);
    // reject stale requests and revoked choices before any clipboard side effect
    if (capability === undefined || !isLiveDocument(document) || cancelledRequestsRef.current.has(request.id)) return;
    // preserve the latest local and cross-tab consent decision
    if (document.deniedCapabilities.has(capability) || !isCurrentBrowserPermissionApproval(document.origin, capability, approvalToken)) {
      respond(document, request, { status: 'denied', error: clipboardError(new DOMException('Clipboard approval changed', 'NotAllowedError')) });
      return;
    }
    // share the native-work ceiling with the other brokered capabilities
    const owners = inFlightRequestsRef.current.size < maxInFlightRequests ? reserveParentCapabilityOwners(1) : undefined;
    // reject new work while outstanding native operations retain every slot
    if (owners === undefined) { respond(document, request, { status: 'error', error: clipboardError(new DOMException('Too many active permission operations', 'QuotaExceededError')) }); return; }
    inFlightRequestsRef.current.add(request.id);
    // start the native call synchronously inside the originating click
    const result = performClipboard(request.operation as ClipboardOperation, request);
    // normalize native outcomes without retrying genuine browser denial
    void result.then(
      data => ({ data, error: undefined }),
      (error: unknown) => ({ data: undefined, error: clipboardError(error) })
    ).then(outcome => {
      releaseParentCapabilityOwners(owners);
      // never send clipboard data into a replacement document
      if (!isLiveDocument(document)) return;
      inFlightRequestsRef.current.delete(request.id);
      // consume cancellation only after the underlying provider settles
      if (cancelledRequestsRef.current.delete(request.id)) return;
      // require the same explicit choice before returning data or persisting approval
      if (document.deniedCapabilities.has(capability) || !isCurrentBrowserPermissionApproval(document.origin, capability, approvalToken)) {
        respond(document, request, { status: 'denied', error: clipboardError(new DOMException('Clipboard approval changed', 'NotAllowedError')) });
        return;
      }
      // propagate native permission and platform failures without guessing their cause
      if (outcome.error !== undefined) { respond(document, request, { status: 'error', error: outcome.error }); return; }
      const saved = mode === 'always' && approvalToken !== undefined && rememberGrant(document, capability, approvalToken);
      // storage writes can observe a newer cross-tab revocation
      if (!isCurrentBrowserPermissionApproval(document.origin, capability, approvalToken)) {
        respond(document, request, { status: 'denied', error: clipboardError(new DOMException('Clipboard approval changed', 'NotAllowedError')) });
        return;
      }
      respond(document, request, { status: 'ok', ...outcome.data });
      // apply durable consent to queued siblings only while native activation remains
      if (saved && navigator.userActivation?.isActive) {
        const matching = queueRef.current.filter(item => item.document === document && item.capability === capability);
        queueRef.current = queueRef.current.filter(item => !matching.includes(item));
        // execute each previously queued request under the same current approval
        for (const item of matching) executeClipboard(document, item.request, 'saved', approvalToken);
      }
      advancePrompt();
    });
  }, [advancePrompt, isLiveDocument, rememberGrant, respond]);

  // execute one request after custom consent has been established
  const executeGranted = useCallback((document: ActiveDocument, request: ParsedRequest): void => {
    // recheck source, origin, nonce, generation, and managed status before native access
    if (!isLiveDocument(document) || cancelledRequestsRef.current.has(request.id)) return;
    // run geolocation through its bounded native adapter
    if (request.operation === 'geolocation-get' || request.operation === 'geolocation-watch') { executeGeolocation(document, request); return; }
    // report the current native notification permission
    if (request.operation === 'notification-permission') {
      const permission = currentNotificationPermission();
      respond(document, request, { status: 'ok', permission });
      return;
    }
    // display only the validated notification request
    if (request.operation === 'notification-show') { void showNotification(document, request); return; }
    respond(document, request, { status: 'error', error: bridgeError('Invalid permission operation') });
  }, [executeGeolocation, isLiveDocument, respond, showNotification]);

  // request explicit consent or reuse a durable origin-scoped approval
  const requestCapability = useCallback((document: ActiveDocument, request: ParsedRequest, capability: BrowserPermissionCapability): void => {
    // deny every later request after an explicit document-scoped denial
    if (document.deniedCapabilities.has(capability)) { respond(document, request, { status: 'denied', error: bridgeError(`${capabilityNames[capability]} denied for this preview`, 1), ...(capability === 'notifications' ? { permission: 'denied' } : {}) }); return; }
    const savedToken = savedBrowserPermissionToken(document.origin, capability);
    const isClipboard = capability === 'clipboard-read' || capability === 'clipboard-write';
    // obtain a fresh parent click when a saved clipboard grant lacks transient activation
    if (isClipboard && savedToken !== undefined && navigator.userActivation?.isActive) { executeClipboard(document, request, 'saved', savedToken); return; }
    const hasSavedApproval = !isClipboard && savedToken !== undefined;
    // native notification access still requires a real click when its grant is missing
    if (hasSavedApproval && (capability !== 'notifications' || currentNotificationPermission() === 'granted')) { executeGranted(document, request); return; }
    // bound queued consent requests per document
    if (queueRef.current.length >= maxPendingRequests) { respond(document, request, { status: 'error', error: bridgeError('Too many pending permission requests') }); return; }
    queueRef.current.push({ capability, request, document });
    advancePrompt();
  }, [advancePrompt, executeClipboard, executeGranted, respond]);

  // resolve a notification consent click without losing native user activation
  const resolveNotificationConsent = useCallback((mode: 'once' | 'always', current: QueuedPermission, consentRevision: number, approvalToken: string | undefined): void => {
    const { document, capability } = current;
    // reject a stale prompt before opening a browser permission surface
    if (!isLiveDocument(document) || capability !== 'notifications') { advancePrompt(); return; }
    const matching = queueRef.current.filter(item => item.document === document && item.capability === capability);
    const selected = mode === 'always' && approvalToken !== undefined ? matching : [current];
    queueRef.current = queueRef.current.filter(item => !selected.includes(item));
    // reject the whole native prompt batch before exceeding bounded provider work
    if (inFlightRequestsRef.current.size + selected.length > maxInFlightRequests) {
      for (const item of selected) respond(document, item.request, { status: 'error', error: bridgeError('Too many active permission operations') });
      advancePrompt();
      return;
    }
    const parentOwners = reserveParentCapabilityOwners(selected.length);
    // reject before opening the native prompt when old documents still hold the parent capacity
    if (parentOwners === undefined) {
      // fail every request selected for this native prompt batch
      for (const item of selected) respond(document, item.request, { status: 'error', error: bridgeError('Too many active permission operations') });
      advancePrompt();
      return;
    }
    // retain cancellation ownership while the native permission prompt is open
    for (const item of selected) inFlightRequestsRef.current.add(item.request.id);
    advancePrompt();
    let nativePermission: Promise<NotificationPermission>;
    try {
      // call requestPermission directly inside the click activation and before any await
      nativePermission = 'Notification' in window ? Promise.resolve(Notification.requestPermission()) : Promise.resolve<NotificationPermission>('denied');
    } catch (error) {
      releaseParentCapabilityOwners(parentOwners);
      // report a synchronous native permission failure as an operation error
      for (const item of selected) {
        inFlightRequestsRef.current.delete(item.request.id);
        respond(document, item.request, { status: 'error', permission: currentNotificationPermission(), error: bridgeError(error instanceof Error ? error.message : 'Notification permission failed') });
      }
      return;
    }
    // normalize only native rejection without replaying failures from request completion
    const nativeOutcome = nativePermission.then<NativeNotificationOutcome, NativeNotificationOutcome>(
      // preserve the native permission result
      permission => ({ status: 'ok', permission }),
      // retain opaque native failures for bounded reporting
      (error: unknown) => ({ status: 'error', error })
    );
    // settle native success and failure through the same ownership and consent boundary
    void nativeOutcome.then(outcome => {
      // release parent capacity before checking document ownership
      releaseParentCapabilityOwners(parentOwners);
      // ignore native completion after the requesting document leaves
      if (!isLiveDocument(document)) return;
      const hasUncancelledRequest = selected.some(item => !cancelledRequestsRef.current.has(item.request.id));
      // require current consent before attempting any durable write
      const choiceBeforeSave = document.notificationConsentRevision === consentRevision && isCurrentBrowserPermissionApproval(document.origin, capability, approvalToken);
      // bind durable approval to this exact choice rather than a newer tab's pointer
      const saved = mode === 'always' && approvalToken !== undefined && outcome.status === 'ok' && outcome.permission === 'granted' && choiceBeforeSave && !document.deniedCapabilities.has(capability) && hasUncancelledRequest && rememberGrant(document, capability, approvalToken);
      // revalidate after storage writes that may have observed an interleaved newer choice
      const currentChoice = choiceBeforeSave && document.notificationConsentRevision === consentRevision && isCurrentBrowserPermissionApproval(document.origin, capability, approvalToken);
      // explain failed verification without overriding denial or abandoned work
      if (!currentChoice && !document.deniedCapabilities.has(capability) && hasUncancelledRequest) setError('Approval changed or could not be verified. Please request again.');
      // retain native denial only for current uncancelled durable consent
      if (mode === 'always' && approvalToken !== undefined && outcome.status === 'ok' && outcome.permission === 'denied' && currentChoice && hasUncancelledRequest) document.deniedCapabilities.add(capability);
      // complete every selected request once through the same policy ordering
      for (const item of selected) {
        inFlightRequestsRef.current.delete(item.request.id);
        // consume transport cancellation without completing the abandoned operation
        if (cancelledRequestsRef.current.delete(item.request.id)) continue;
        // honour explicit denial before any older native outcome
        if (document.deniedCapabilities.has(capability)) { respond(document, item.request, { status: 'denied', permission: 'denied', error: bridgeError('Notifications denied for this preview', 1) }); continue; }
        // settle superseded work without granting permission or displaying a notification
        if (!currentChoice) {
          // keep a stale permission response conservative without persisting denial
          if (item.request.operation === 'notification-permission') respond(document, item.request, { status: 'ok', permission: 'default' });
          else respond(document, item.request, { status: 'denied', permission: 'default', error: bridgeError('Notification approval changed', 1), notificationId: item.request.id });
          continue;
        }
        // report genuine native rejection only after consent remains current
        if (outcome.status === 'error') { respond(document, item.request, { status: 'error', permission: currentNotificationPermission(), error: bridgeError(outcome.error instanceof Error ? outcome.error.message : 'Notification permission failed') }); continue; }
        const permission = outcome.permission;
        // leave siblings awaiting consent when current durable persistence failed
        if (mode === 'always' && permission === 'granted' && !saved && item !== current) { queueRef.current.push(item); continue; }
        // preserve native requestPermission results after current explicit custom consent
        if (item.request.operation === 'notification-permission') respond(document, item.request, { status: 'ok', permission });
        // execute display only after both current custom and native grants
        else if (permission === 'granted') executeGranted(document, item.request);
        else respond(document, item.request, { status: 'denied', permission, error: bridgeError('Notifications are not permitted', 1) });
      }
      advancePrompt();
    });
  }, [advancePrompt, executeGranted, isLiveDocument, rememberGrant, respond]);

  // grant one or every queued capability request from the click activation
  const allow = useCallback((mode: 'once' | 'always'): void => {
    const current = queueRef.current[0];
    // ignore a click after navigation cleared the queue
    if (current === undefined || !isLiveDocument(current.document)) { advancePrompt(); return; }
    // supersede an earlier local native answer before storage or capacity can fail
    const consentRevision = current.capability === 'notifications' ? ++current.document.notificationConsentRevision : 0;
    // bind both one-time and durable consent to one verified cross-tab choice
    const choice = beginBrowserPermissionApproval(current.document.origin, current.capability);
    // stop when captured grant cleanup failed despite a successful pointer rotation
    if (choice.status === 'ready' && !choice.cleared) {
      setError('Approval could not be saved or cleared. Clear RAC site data to revoke it.');
      return;
    }
    // never let a superseded click remove the newer choice or reopen native permission
    if (choice.status === 'superseded') {
      setError('Approval changed in another preview. Please choose again.');
      return;
    }
    // allow a one-time fallback only when storage verifies no prior approval or pending choice
    if (choice.status === 'unavailable') {
      // unreadable or existing authority cannot safely be converted into one-time access
      if (!choice.empty) {
        setError('Approval could not be saved or cleared. Clear RAC site data to revoke it.');
        return;
      }
      setError('Approval could not be saved. Only the current request was allowed.');
    }
    // clear obsolete storage errors only after verified one-time revocation succeeds
    if (mode === 'once' && choice.status === 'ready') setError(undefined);
    const approvalToken = choice.status === 'ready' ? choice.token : undefined;
    // clipboard consent covers native access and persists only after successful completion
    if (current.capability === 'clipboard-read' || current.capability === 'clipboard-write') {
      queueRef.current = queueRef.current.filter(item => item !== current);
      executeClipboard(current.document, current.request, mode, approvalToken);
      advancePrompt();
      return;
    }
    // notifications must open the native permission surface in this click handler
    if (current.capability === 'notifications') { resolveNotificationConsent(mode, current, consentRevision, approvalToken); return; }
    const matching = queueRef.current.filter(item => item.document === current.document && item.capability === current.capability);
    // failed persistence allows only the current request rather than the whole queue
    const saved = mode === 'always' && approvalToken !== undefined && rememberGrant(current.document, current.capability, approvalToken);
    const selected = saved ? matching : [current];
    queueRef.current = queueRef.current.filter(item => !selected.includes(item));
    // invoke geolocation directly inside this activation
    for (const item of selected) executeGranted(current.document, item.request);
    advancePrompt();
  }, [advancePrompt, executeClipboard, executeGranted, isLiveDocument, rememberGrant, resolveNotificationConsent]);

  // deny this capability for the rest of the current preview document
  const deny = useCallback((): void => {
    const current = queueRef.current[0];
    // ignore a click after navigation cleared the queue
    if (current === undefined || !isLiveDocument(current.document)) { advancePrompt(); return; }
    current.document.deniedCapabilities.add(current.capability);
    // supersede native notification answers still waiting on an earlier choice
    if (current.capability === 'notifications') current.document.notificationConsentRevision += 1;
    // remove any older always approval when this capability is explicitly denied
    const removed = forgetBrowserPermission(current.document.origin, current.capability);
    setError(removed ? undefined : 'Saved approval could not be cleared. Clear RAC site data to revoke it.');
    const denied = queueRef.current.filter(item => item.document === current.document && item.capability === current.capability);
    queueRef.current = queueRef.current.filter(item => !denied.includes(item));
    // deny every pending request for this document capability
    for (const item of denied) respond(current.document, item.request, { status: 'denied', error: bridgeError(`${capabilityNames[current.capability]} denied for this preview`, 1), ...(current.capability === 'notifications' ? { permission: 'denied' } : {}) });
    advancePrompt();
  }, [advancePrompt, isLiveDocument, respond]);

  // install the message boundary before the frame can paint and execute app code
  useLayoutEffect(() => {
    // process messages only from the configured managed frame
    const handleMessage = (event: MessageEvent<unknown>): void => {
      const frameWindow = frameRef.current?.contentWindow;
      // ignore every other source, origin, and unmanaged frame
      if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow || event.origin !== homeOrigin || !isManaged()) return;
      // revoke the exact active document immediately when its page begins unloading
      if (isDisconnectMessage(event.data)) {
        const active = activeDocumentRef.current;
        // require the current nonce in addition to the source and origin checks above
        if (active !== undefined && active.clientId === event.data.clientId && isLiveDocument(active)) resetDocument();
        return;
      }
      const request = parseRequest(event.data);
      // reject malformed messages only when enough bounded envelope data exists to answer
      if (request === undefined) {
        // avoid reflecting attacker-controlled identifiers
        if (isRecord(event.data) && isUuid(event.data.clientId) && isUuid(event.data.id)) {
          const active = activeDocumentRef.current;
          // answer only the currently connected nonce
          if (active !== undefined && active.clientId === event.data.clientId && isLiveDocument(active)) respond(active, { clientId: event.data.clientId, id: event.data.id }, { status: 'error', error: bridgeError('Malformed permission request') });
        }
        return;
      }
      // a connect nonce replaces every capability and resource from the prior document
      if (request.operation === 'connect') {
        resetDocument();
        connectSerialRef.current += 1;
        const document: ActiveDocument = { clientId: request.clientId, ownerId: crypto.randomUUID(), generation: generationRef.current, source: frameWindow, origin: event.origin, deniedCapabilities: new Set(), notificationConsentRevision: 0, requests: new Map([[request.id, 'connect']]) };
        activeDocumentRef.current = document;
        // restore the child facade only when both custom and native notification grants exist
        const permission = hasSavedBrowserPermission(document.origin, 'notifications') && currentNotificationPermission() === 'granted' ? 'granted' : 'default';
        respond(document, request, { status: 'ok', permission });
        return;
      }
      const document = activeDocumentRef.current;
      // reject unknown document nonces without transferring authority
      if (document === undefined || document.clientId !== request.clientId || !isLiveDocument(document)) {
        frameWindow.postMessage({ type: 'rac-browser-permission-response', clientId: request.clientId, id: request.id, status: 'error', error: bridgeError('Unknown preview document') } satisfies BrowserPermissionResponse, homeOrigin);
        return;
      }
      // reject duplicate identifiers before pruning completed replay history
      if (document.requests.has(request.id)) { respond(document, request, { status: 'error', error: bridgeError('Duplicate permission request') }); return; }
      // prune the oldest completed request while retaining every cancelable owner
      if (document.requests.size >= maxRememberedRequestIds) {
        const protectedIds = new Set<string>([
          ...queueRef.current.filter(item => item.document === document).map(item => item.request.id),
          ...watchesRef.current.keys(),
          ...notificationsRef.current.keys(),
          ...inFlightRequestsRef.current,
          ...cancelledRequestsRef.current
        ]);
        // remove completed replay entries in insertion order
        for (const [rememberedId, rememberedOperation] of document.requests) {
          // retain the connection and active resource ownership ids
          if (rememberedOperation === 'connect' || protectedIds.has(rememberedId)) continue;
          document.requests.delete(rememberedId);
          break;
        }
      }
      // fail closed only when every retained request is still active
      if (document.requests.size >= maxRememberedRequestIds) { respond(document, request, { status: 'error', error: bridgeError('Too many active permission requests') }); return; }
      document.requests.set(request.id, request.operation);
      // cancel queued or active geolocation work owned by this connected document
      if (request.operation === 'geolocation-clear') {
        const targetId = request.watchId;
        const targetOperation = targetId === undefined ? undefined : document.requests.get(targetId);
        const queued = targetId === undefined ? false : queueRef.current.some(item => item.document === document && item.request.id === targetId && item.capability === 'geolocation');
        const inFlight = targetId === undefined ? false : inFlightRequestsRef.current.has(targetId);
        const watch = targetId === undefined ? undefined : watchesRef.current.get(targetId);
        // reject nonces that never named location work in this document
        if (targetId === undefined || targetOperation !== 'geolocation-get' && targetOperation !== 'geolocation-watch' || !queued && !inFlight && watch === undefined) { respond(document, request, { status: 'error', error: bridgeError('Unknown location request'), watchId: targetId }); return; }
        // clear a native watcher before suppressing any late callbacks
        if (watch !== undefined && watch.generation === document.generation) navigator.geolocation?.clearWatch(watch.nativeId);
        watchesRef.current.delete(targetId);
        // mark only an uncancelable native get for late callback suppression
        if (inFlight && targetOperation === 'geolocation-get') cancelledRequestsRef.current.add(targetId);
        queueRef.current = queueRef.current.filter(item => item.document !== document || item.request.id !== targetId);
        advancePrompt();
        respond(document, request, { status: 'ok', watchId: targetId });
        return;
      }
      // cancel queued, in-flight, or displayed notification work for this document
      if (request.operation === 'notification-close') {
        const targetId = request.notificationId;
        const targetOperation = targetId === undefined ? undefined : document.requests.get(targetId);
        const queued = targetId === undefined ? false : queueRef.current.some(item => item.document === document && item.request.id === targetId && item.capability === 'notifications');
        const inFlight = targetId === undefined ? false : inFlightRequestsRef.current.has(targetId);
        const notification = targetId === undefined ? undefined : notificationsRef.current.get(targetId);
        // reject nonces that never named notification work in this document
        if (targetId === undefined || targetOperation !== 'notification-permission' && targetOperation !== 'notification-show' || !queued && !inFlight && notification === undefined) { respond(document, request, { status: 'error', error: bridgeError('Unknown notification request'), notificationId: targetId }); return; }
        // terminate the original show even when it was still awaiting consent or native display
        if (targetOperation === 'notification-show') respond(document, { clientId: document.clientId, id: targetId }, { status: 'ok', permission: currentNotificationPermission(), event: 'close', notificationId: targetId });
        // suppress native permission or worker-display completion after cancellation
        if (inFlight || notification?.pending === true) cancelledRequestsRef.current.add(targetId);
        notificationsRef.current.delete(targetId);
        notification?.native?.close();
        // close worker notifications by their parent-generated tag
        if (notification?.serviceWorkerTag !== undefined && notification.previewOwnerId !== undefined && notification.previewClientId !== undefined && notification.previewNotificationId !== undefined && 'serviceWorker' in navigator) {
          const owner: WorkerNotificationOwner = { serviceWorkerTag: notification.serviceWorkerTag, previewOwnerId: notification.previewOwnerId, previewClientId: notification.previewClientId, previewNotificationId: notification.previewNotificationId };
          void navigator.serviceWorker.getRegistration().then(async registration => {
            // skip a removed service worker registration
            if (registration === undefined) return;
            await closeOwnedWorkerNotifications(registration, owner);
          }).catch(() => { /* the close response below remains deterministic */ });
        }
        queueRef.current = queueRef.current.filter(item => item.document !== document || item.request.id !== targetId);
        advancePrompt();
        respond(document, request, { status: 'ok', notificationId: targetId });
        return;
      }
      // cancel only queued or in-flight clipboard work owned by this document
      if (request.operation === 'clipboard-cancel') {
        const targetId = request.requestId;
        const operation = targetId === undefined ? undefined : document.requests.get(targetId);
        const queued = queueRef.current.some(item => item.document === document && item.request.id === targetId);
        const inFlight = targetId !== undefined && inFlightRequestsRef.current.has(targetId);
        // reject unrelated request ids rather than transferring cancellation authority
        if (targetId === undefined || operation === undefined || clipboardCapability(operation) === undefined || !queued && !inFlight) { respond(document, request, { status: 'error', error: bridgeError('Unknown clipboard request') }); return; }
        // native clipboard calls cannot be aborted but their results can be suppressed
        if (inFlight) cancelledRequestsRef.current.add(targetId);
        queueRef.current = queueRef.current.filter(item => item.document !== document || item.request.id !== targetId);
        advancePrompt();
        respond(document, request, { status: 'ok' });
        return;
      }
      const clipboard = clipboardCapability(request.operation);
      // keep clipboard read and write approvals distinct
      if (clipboard !== undefined) { requestCapability(document, request, clipboard); return; }
      // gate every native location request behind custom consent
      if (request.operation === 'geolocation-get' || request.operation === 'geolocation-watch') { requestCapability(document, request, 'geolocation'); return; }
      // gate permission reads and notification display behind custom consent
      if (request.operation === 'notification-permission' || request.operation === 'notification-show') { requestCapability(document, request, 'notifications'); return; }
      respond(document, request, { status: 'error', error: bridgeError('Unsupported permission operation') });
    };
    window.addEventListener('message', handleMessage);
    // revoke capabilities and resources when this broker leaves the tree
    return () => { window.removeEventListener('message', handleMessage); resetDocument(); };
  }, [advancePrompt, frameRef, homeOrigin, isLiveDocument, isManaged, requestCapability, resetDocument, respond]);

  // move keyboard focus into each newly displayed consent prompt
  useLayoutEffect(() => {
    // leave focus unchanged when no user decision is pending
    if (prompt === undefined) return;
    consentRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [prompt]);

  // name the queued capability in the visible decision heading
  const capabilityName = prompt === undefined ? '' : capabilityNames[prompt.capability];
  // keep consent inside the browser pane while exposing a labelled keyboard surface
  const consent = prompt === undefined ? null : <section ref={consentRef} className="browser-permission-consent" role="dialog" aria-modal="false" aria-live="assertive" aria-labelledby="browser-permission-title" aria-describedby="browser-permission-description">
    <div className="browser-permission-copy">
      <strong id="browser-permission-title">Allow {capabilityName}?</strong>
      <p id="browser-permission-description"><b>{previewOrigin}</b> {capabilityDescriptions[prompt.capability]} Allow once covers this request. Always approval is remembered for this origin in this browser until you reset preview permissions.{(prompt.capability === 'clipboard-read' || prompt.capability === 'clipboard-write') && ' Your browser may still require another click or native permission.'}</p>
    </div>
    <div className="browser-permission-actions">
      <button type="button" onClick={() => { /* grant only the current request */ allow('once'); }}>Allow once</button>
      <button type="button" onClick={() => { /* remember this capability for future visits */ allow('always'); }}>allow always</button>
      <button className="browser-permission-deny" type="button" onClick={deny}>deny</button>
    </div>
  </section>;
  return { consent, error, forgetGrants, revoke, frameLoaded };
}
