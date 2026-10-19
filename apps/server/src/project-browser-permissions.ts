// generate the managed browser-permission shim
export const projectBrowserPermissions = (parentOrigin: string) => `(() => {
  // retain native APIs outside the direct managed frame and supported documents
  if (typeof window !== 'object' || window.parent === window || window.parent !== window.top || window.name !== 'rac-managed-preview-v1' || window.isSecureContext !== true || !window.crypto || typeof window.crypto.randomUUID !== 'function' || typeof window.setTimeout !== 'function' || typeof window.clearTimeout !== 'function' || !window.navigator || typeof window.addEventListener !== 'function') return;
  const parentOrigin = ${JSON.stringify(parentOrigin)};
  const parentWindow = window.parent;
  let clientId = window.crypto.randomUUID();
  const pending = new Map();
  const notifications = new Map();
  const consentTimeout = 120000;
  const maximumLocationTimeout = 60000;
  const maximumLocationAge = 86400000;
  const maximumPendingConsent = 16;
  const maximumPendingOperations = 32;
  const maximumWatches = 8;
  const maximumClipboardText = 1048576;
  const maximumClipboardItems = 4;
  const maximumClipboardRepresentations = 8;
  const maximumClipboardBytes = 4194304;
  const maximumClipboardTypeLength = 128;
  const NativeBlob = window.Blob;
  const NativeClipboardItem = window.ClipboardItem;
  const NativeDOMException = window.DOMException;
  let notificationPermission = 'default';
  let disconnected = false;
  let pageHidden = false;
  let nextWatchId = 1;

  // create one protocol identifier
  const identifier = () => window.crypto.randomUUID();
  // constrain one finite numeric option
  const boundedNumber = (value, fallback, maximum) => {
    // use the documented default for invalid values
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, 0), maximum);
  };
  // read one external option without trusting accessors
  const optionValue = (options, name) => {
    // ignore non-object option bags
    if (options === null || typeof options !== 'object') return undefined;
    try { return options[name]; }
    catch { return undefined; }
  };
  // normalize geolocation options for the broker
  const locationOptions = (options) => ({
    enableHighAccuracy: optionValue(options, 'enableHighAccuracy') === true,
    timeout: boundedNumber(optionValue(options, 'timeout'), 30000, maximumLocationTimeout),
    maximumAge: boundedNumber(optionValue(options, 'maximumAge'), 0, maximumLocationAge)
  });
  // constrain one external text value
  const limitedText = (value, maximum, fallback = '') => {
    // retain the fallback for absent values
    if (value === undefined || value === null) return fallback;
    try { return String(value).slice(0, maximum); }
    catch { return fallback; }
  };
  // normalize the allowed notification payload
  const notificationOptions = (options) => ({
    body: limitedText(optionValue(options, 'body'), 2000),
    tag: limitedText(optionValue(options, 'tag'), 128),
    requireInteraction: optionValue(options, 'requireInteraction') === true,
    silent: optionValue(options, 'silent') === true
  });
  // create a browser-shaped location error
  const locationError = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  // identify capacity failures independently of their wording
  const capacityError = (message) => ({ ...locationError(2, message), name: 'QuotaExceededError' });
  // validate one serialized broker error
  const serializedError = (value) => {
    // reject malformed error payloads
    if (value === null || typeof value !== 'object' || (value.code !== 1 && value.code !== 2 && value.code !== 3) || typeof value.message !== 'string') return undefined;
    return locationError(value.code, value.message.slice(0, 1000));
  };
  // validate one nullable coordinate
  const nullableCoordinate = (value) => value === null || typeof value === 'number' && Number.isFinite(value);
  // validate one nullable nonnegative coordinate
  const nullableNonnegativeCoordinate = (value) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
  // validate one nullable compass heading
  const nullableHeading = (value) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360;
  // validate and copy one serialized position
  const serializedPosition = (value) => {
    // require the complete position shape
    if (value === null || typeof value !== 'object' || value.coords === null || typeof value.coords !== 'object' || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) || value.timestamp < 0) return undefined;
    const coords = value.coords;
    // require bounded required coordinates
    if (typeof coords.latitude !== 'number' || !Number.isFinite(coords.latitude) || coords.latitude < -90 || coords.latitude > 90 || typeof coords.longitude !== 'number' || !Number.isFinite(coords.longitude) || coords.longitude < -180 || coords.longitude > 180 || typeof coords.accuracy !== 'number' || !Number.isFinite(coords.accuracy) || coords.accuracy < 0) return undefined;
    // require safe nullable coordinates
    if (!nullableCoordinate(coords.altitude) || !nullableNonnegativeCoordinate(coords.altitudeAccuracy) || !nullableHeading(coords.heading) || !nullableNonnegativeCoordinate(coords.speed)) return undefined;
    return {
      coords: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        altitude: coords.altitude,
        altitudeAccuracy: coords.altitudeAccuracy,
        heading: coords.heading,
        speed: coords.speed
      },
      timestamp: value.timestamp
    };
  };
  // post one scoped broker request
  const postRequest = (message) => parentWindow.postMessage({ type: 'rac-browser-permission-request', clientId, ...message }, parentOrigin);
  // cancel one abandoned geolocation request
  const cancelGeolocation = (requestId) => {
    try { postRequest({ id: identifier(), operation: 'geolocation-clear', watchId: requestId }); }
    catch { /* the parent is already unavailable */ }
  };
  // cancel one abandoned notification request
  const cancelNotification = (requestId) => {
    try { postRequest({ id: identifier(), operation: 'notification-close', notificationId: requestId }); }
    catch { /* the parent is already unavailable */ }
  };
  // cancel one abandoned clipboard request
  const cancelClipboard = (requestId) => {
    try { postRequest({ id: identifier(), operation: 'clipboard-cancel', requestId }); }
    catch { /* the parent is already unavailable */ }
  };
  // synchronously revoke one document session
  const disconnectDocument = () => {
    pageHidden = true;
    try { parentWindow.postMessage({ type: 'rac-browser-permission-disconnect', clientId, id: identifier() }, parentOrigin); }
    catch { /* the parent is already unavailable */ }
    disconnect();
  };
  // reconnect one document restored from the back-forward cache
  const restoreDocument = () => {
    // ignore the initial and ordinary visible-page lifecycle event
    if (!pageHidden) return;
    clientId = identifier();
    notificationPermission = 'default';
    disconnected = false;
    pageHidden = false;
    nextWatchId = 1;
    pending.clear();
    notifications.clear();
    connect();
  };
  // clear one pending deadline
  const clearDeadline = (entry) => {
    // release an active deadline once
    if (entry.timer !== undefined) window.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.awaitingConsent = false;
  };
  // count pending requests matching one predicate
  const pendingCount = (matches) => {
    let count = 0;
    // count every matching retained operation
    for (const entry of pending.values()) {
      // skip operations outside the requested class
      if (!matches(entry)) continue;
      count += 1;
    }
    return count;
  };
  // remove one pending request
  const removePending = (id) => {
    const entry = pending.get(id);
    // ignore unknown and already-settled requests
    if (entry === undefined) return undefined;
    pending.delete(id);
    clearDeadline(entry);
    return entry;
  };
  // report an uncaught listener failure asynchronously
  const reportListenerFailure = (error) => window.setTimeout(() => { throw error; }, 0);
  // invoke one application callback without blocking sibling listeners
  const invokeCallback = (callback, receiver, argument) => {
    try { callback.call(receiver, argument); }
    catch (error) { reportListenerFailure(error); }
  };
  // fail all work after the broker disconnects
  const disconnect = (error = locationError(2, 'permission broker disconnected')) => {
    // preserve the first disconnect reason
    if (disconnected) return;
    disconnected = true;
    const entries = [...pending.values()];
    pending.clear();
    // settle every retained callback
    for (const entry of entries) {
      clearDeadline(entry);
      entry.fail(error);
    }
    notifications.clear();
  };
  // register and send one deadline-bound request
  const startRequest = (message, entry, timeout = consentTimeout) => {
    // settle immediately when the parent is unavailable
    if (disconnected) { entry.fail(locationError(2, 'permission broker disconnected'), false); return false; }
    // enforce the total retained-operation bound
    if (pending.size >= maximumPendingOperations) { entry.fail(capacityError('permission broker operation limit reached'), false); return false; }
    // enforce the parent consent-queue bound
    if (entry.awaitingConsent === true && pendingCount(value => value.awaitingConsent === true) >= maximumPendingConsent) { entry.fail(capacityError('permission broker consent limit reached'), false); return false; }
    entry.timer = window.setTimeout(() => {
      // ignore a request settled before its deadline
      if (pending.get(message.id) !== entry) return;
      pending.delete(message.id);
      entry.timer = undefined;
      entry.fail(locationError(3, 'permission broker timed out'));
    }, timeout);
    pending.set(message.id, entry);
    try { postRequest(message); }
    catch {
      removePending(message.id);
      entry.fail(locationError(2, 'permission broker unavailable'), false);
      return false;
    }
    return true;
  };
  // dispatch one forwarded notification event
  const emitNotification = (notification, type) => {
    const event = { type, target: notification, currentTarget: notification };
    const handler = notification['on' + type];
    // notify the property handler first
    if (typeof handler === 'function') invokeCallback(handler, notification, event);
    const listeners = notification.__listeners.get(type);
    // stop when no listeners are registered
    if (listeners === undefined) return;
    // notify a stable listener snapshot
    for (const listener of [...listeners]) {
      // support function listeners
      if (typeof listener === 'function') invokeCallback(listener, notification, event);
      // support event-listener objects
      else if (listener && typeof listener.handleEvent === 'function') invokeCallback(listener.handleEvent, listener, event);
    }
  };
  // handle one geolocation lookup response
  const locationLookupEntry = (id, success, failure) => ({
    kind: 'geolocation-get',
    timer: undefined,
    awaitingConsent: true,
    // settle one lookup failure
    fail: (error, cancel = true) => { if (cancel) cancelGeolocation(id); if (typeof failure === 'function') invokeCallback(failure, undefined, error); },
    // validate and settle one lookup response
    handle: (response) => {
      // map an explicit denial to the browser permission code
      if (response.status === 'denied') { removePending(id); if (typeof failure === 'function') invokeCallback(failure, undefined, locationError(1, response.error?.message || 'location permission denied')); return; }
      // map one well-formed broker error
      if (response.status === 'error') {
        const error = serializedError(response.error);
        // ignore malformed broker errors
        if (error === undefined) return;
        removePending(id);
        if (typeof failure === 'function') invokeCallback(failure, undefined, error);
        return;
      }
      const position = serializedPosition(response.position);
      // ignore malformed successful payloads
      if (position === undefined) return;
      removePending(id);
      invokeCallback(success, undefined, position);
    }
  });
  // handle one retained geolocation watch response
  const locationWatchEntry = (id, watchId, success, failure) => ({
    kind: 'geolocation-watch',
    timer: undefined,
    awaitingConsent: true,
    watchId,
    // terminate one failed watch
    fail: (error, cancel = true) => { if (cancel) cancelGeolocation(id); if (typeof failure === 'function') invokeCallback(failure, undefined, error); },
    // validate and forward one watch response
    handle: (response) => {
      // reject a mismatched broker watch identifier
      if (response.watchId !== undefined && response.watchId !== id) return;
      // terminate an explicitly denied watch
      if (response.status === 'denied') { removePending(id); if (typeof failure === 'function') invokeCallback(failure, undefined, locationError(1, response.error?.message || 'location permission denied')); return; }
      // forward one well-formed watch error
      if (response.status === 'error') {
        const error = serializedError(response.error);
        // ignore malformed broker errors
        if (error === undefined) return;
        clearDeadline(pending.get(id));
        // terminate permission-denied watches
        if (error.code === 1) removePending(id);
        if (typeof failure === 'function') invokeCallback(failure, undefined, error);
        return;
      }
      const position = serializedPosition(response.position);
      // ignore malformed successful payloads
      if (position === undefined) return;
      clearDeadline(pending.get(id));
      invokeCallback(success, undefined, position);
    }
  });
  // request one current managed position
  const getCurrentPosition = (success, failure, options) => {
    // require the standard success callback
    if (typeof success !== 'function') throw new TypeError('success callback is required');
    const normalized = locationOptions(options);
    const id = identifier();
    startRequest({ id, operation: 'geolocation-get', options: normalized }, locationLookupEntry(id, success, failure), consentTimeout + normalized.timeout);
  };
  // begin one managed position watch
  const watchPosition = (success, failure, options) => {
    // require the standard success callback
    if (typeof success !== 'function') throw new TypeError('success callback is required');
    const normalized = locationOptions(options);
    const id = identifier();
    const watchId = nextWatchId;
    nextWatchId = nextWatchId >= 2147483647 ? 1 : nextWatchId + 1;
    // refuse watches beyond the broker resource cap
    if (pendingCount(entry => entry.kind === 'geolocation-watch') >= maximumWatches) { if (typeof failure === 'function') invokeCallback(failure, undefined, locationError(2, 'permission broker watch limit reached')); return watchId; }
    startRequest({ id, operation: 'geolocation-watch', options: normalized }, locationWatchEntry(id, watchId, success, failure), consentTimeout + normalized.timeout);
    return watchId;
  };
  // stop one managed position watch
  const clearWatch = (watchId) => {
    let requestId;
    // find the numeric watch mapping
    for (const [id, entry] of pending) {
      // retain only a matching geolocation watch
      if (entry.kind !== 'geolocation-watch' || entry.watchId !== watchId) continue;
      requestId = id;
      break;
    }
    // ignore unknown and already-cleared watches
    if (requestId === undefined) return;
    removePending(requestId);
    const id = identifier();
    startRequest({ id, operation: 'geolocation-clear', watchId: requestId }, {
      kind: 'geolocation-clear',
      timer: undefined,
      // discard a clear failure
      fail: () => undefined,
      // settle the clear acknowledgement
      handle: () => { removePending(id); }
    });
  };
  // create one notification permission exception
  const permissionException = () => {
    const error = new Error('notification permission has not been granted');
    error.name = 'NotAllowedError';
    return error;
  };
  // create one broker transport exception
  const transportException = (error) => {
    const exception = new Error(error?.message || 'permission broker operation failed');
    exception.name = 'AbortError';
    return exception;
  };
  // create one broker capacity exception
  const capacityException = (message) => {
    const exception = new Error(message);
    exception.name = 'QuotaExceededError';
    return exception;
  };
  // create one browser-shaped clipboard exception
  const clipboardException = (message, name) => {
    const boundedMessage = limitedText(message, 1000, 'clipboard operation failed');
    // prefer the document's native dom exception
    if (typeof NativeDOMException === 'function') {
      try { return new NativeDOMException(boundedMessage, name); }
      catch { /* fall back to an ordinary named error */ }
    }
    const exception = new Error(boundedMessage);
    exception.name = name;
    return exception;
  };
  // retain one bounded dom exception name
  const clipboardErrorName = (value, fallback) => {
    // reject names that cannot be safely exposed
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9]*Error$/u.test(value)) return fallback;
    return value;
  };
  // convert one local broker failure to a clipboard exception
  const clipboardTransportException = (error) => {
    const message = typeof error?.message === 'string' ? error.message : 'clipboard operation failed';
    return clipboardException(message, clipboardErrorName(error?.name, 'AbortError'));
  };
  // validate one serialized clipboard failure
  const serializedClipboardException = (value) => {
    // reject malformed broker errors
    if (value === null || typeof value !== 'object' || Array.isArray(value) || (value.code !== 1 && value.code !== 2 && value.code !== 3) || typeof value.message !== 'string' || value.name !== undefined && typeof value.name !== 'string') return undefined;
    const fallback = value.code === 1 ? 'NotAllowedError' : 'AbortError';
    return clipboardException(value.message, clipboardErrorName(value.name, fallback));
  };
  // reject one invalid clipboard input
  const invalidClipboardInput = (message) => new TypeError(message);
  // reject one oversized clipboard input
  const oversizedClipboardInput = (message) => clipboardException(message, 'QuotaExceededError');
  // retain one supported clipboard presentation style
  const clipboardPresentationStyle = (value) => value === 'unspecified' || value === 'inline' || value === 'attachment' ? value : undefined;
  // retain and time one rich clipboard write before serialization
  const reserveClipboardRequest = (id, entry) => {
    // settle immediately when the parent is unavailable
    if (disconnected) { entry.fail(locationError(2, 'permission broker disconnected'), false); return false; }
    // enforce the total retained-operation bound
    if (pending.size >= maximumPendingOperations) { entry.fail(capacityError('permission broker operation limit reached'), false); return false; }
    // enforce the parent consent-queue bound
    if (pendingCount(value => value.awaitingConsent === true) >= maximumPendingConsent) { entry.fail(capacityError('permission broker consent limit reached'), false); return false; }
    entry.timer = window.setTimeout(() => {
      // ignore a request settled before its deadline
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      entry.timer = undefined;
      entry.fail(locationError(3, 'permission broker timed out'));
    }, consentTimeout);
    pending.set(id, entry);
    return true;
  };
  // validate rich clipboard write descriptors before awaiting data
  const clipboardWriteDescriptors = (items) => {
    // require a nonempty native item array
    if (!Array.isArray(items) || items.length === 0) throw invalidClipboardInput('clipboard items must be a nonempty array');
    // reject excess items without truncation
    if (items.length > maximumClipboardItems) throw oversizedClipboardInput('clipboard item limit exceeded');
    const descriptors = [];
    // validate every item before reserving pending work
    for (const item of items) {
      // require the clipboard item interface
      if (item === null || typeof item !== 'object') throw invalidClipboardInput('invalid clipboard item');
      const presentationStyle = item.presentationStyle ?? 'unspecified';
      // require one supported presentation style
      if (clipboardPresentationStyle(presentationStyle) === undefined) throw invalidClipboardInput('invalid clipboard presentation style');
      const getType = item.getType;
      // require one stable representation getter
      if (typeof getType !== 'function') throw invalidClipboardInput('invalid clipboard item');
      const itemTypes = item.types;
      // require a nonempty native type array
      if (!Array.isArray(itemTypes) || itemTypes.length === 0) throw invalidClipboardInput('invalid clipboard item');
      // reject excess representations without truncation
      if (itemTypes.length > maximumClipboardRepresentations) throw oversizedClipboardInput('clipboard representation limit exceeded');
      const types = [];
      const uniqueTypes = new Set();
      // validate every declared representation
      for (const type of itemTypes) {
        // require one bounded mime type
        if (typeof type !== 'string' || type.length === 0 || type.length > maximumClipboardTypeLength) throw invalidClipboardInput('invalid clipboard representation type');
        // reject duplicate representations
        if (uniqueTypes.has(type)) throw invalidClipboardInput('duplicate clipboard representation type');
        uniqueTypes.add(type);
        types.push(type);
      }
      descriptors.push({ getType, item, presentationStyle, types });
    }
    return descriptors;
  };
  // create one pending clipboard promise entry
  const clipboardRequestEntry = (id, resolve, reject, parse, posted = true) => {
    let settled = false;
    const entry = {
      kind: 'clipboard',
      timer: undefined,
      awaitingConsent: true,
      posted,
      // reject one local or native clipboard failure
      reject: (error) => {
        // ignore duplicate settlement
        if (settled) return;
        settled = true;
        reject(error);
      },
      // reject one unavailable clipboard request
      fail: (error, cancel = true) => {
        // ignore duplicate settlement
        if (settled) return;
        settled = true;
        // cancel only a request already posted to the parent
        if (cancel && entry.posted) cancelClipboard(id);
        reject(clipboardTransportException(error));
      },
      // validate and settle one clipboard response
      handle: (response) => {
        // reject clipboard failures carrying successful payloads
        if (response.status !== 'ok' && (response.text !== undefined || response.items !== undefined)) return;
        // map explicit denials to the browser permission exception
        if (response.status === 'denied') {
          removePending(id);
          settled = true;
          const message = typeof response.error?.message === 'string' ? response.error.message : 'clipboard permission denied';
          reject(clipboardException(message, 'NotAllowedError'));
          return;
        }
        // validate one explicit broker failure
        if (response.status === 'error') {
          const exception = serializedClipboardException(response.error);
          // ignore malformed broker failures until the deadline
          if (exception === undefined) return;
          removePending(id);
          settled = true;
          reject(exception);
          return;
        }
        let parsed;
        try { parsed = parse(response); }
        catch (error) {
          removePending(id);
          settled = true;
          reject(error);
          return;
        }
        // ignore malformed successful payloads until the deadline
        if (parsed === undefined) return;
        removePending(id);
        settled = true;
        resolve(parsed.value);
      }
    };
    return entry;
  };
  // start one immediately serializable clipboard operation
  const startClipboardRequest = (operation, fields, parse) => new Promise((resolve, reject) => {
    const id = identifier();
    const entry = clipboardRequestEntry(id, resolve, reject, parse);
    startRequest({ id, operation, ...fields }, entry);
  });
  // custom format keys retain their web prefix while blobs retain their mime type
  const clipboardBlobType = (type) => type.startsWith('web ') ? type.slice(4) : type;
  // validate one broker blob representation
  const clipboardRepresentation = (value, uniqueTypes, byteState) => {
    // require the exact representation shape
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.type !== 'string' || value.type.length === 0 || value.type.length > maximumClipboardTypeLength || !Object.prototype.hasOwnProperty.call(value, 'blob')) return undefined;
    // require unique declared types
    if (uniqueTypes.has(value.type)) return undefined;
    // require a native blob with a matching type
    if (typeof NativeBlob !== 'function' || !(value.blob instanceof NativeBlob) || value.blob.type !== clipboardBlobType(value.type) || typeof value.blob.size !== 'number' || !Number.isFinite(value.blob.size) || value.blob.size < 0) return undefined;
    uniqueTypes.add(value.type);
    byteState.total += value.blob.size;
    // reject oversized aggregate data without truncation
    if (byteState.total > maximumClipboardBytes) return undefined;
    return { type: value.type, blob: value.blob };
  };
  // reconstruct one rich clipboard read response
  const parseClipboardItems = (response) => {
    // require only one bounded item array
    if (!Array.isArray(response.items) || response.items.length > maximumClipboardItems || response.text !== undefined || response.error !== undefined || typeof NativeClipboardItem !== 'function') return undefined;
    const normalizedItems = [];
    const byteState = { total: 0 };
    // validate every returned clipboard item
    for (const item of response.items) {
      // require the exact item envelope
      if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !Object.prototype.hasOwnProperty.call(item, 'presentationStyle') || !Object.prototype.hasOwnProperty.call(item, 'representations')) return undefined;
      const presentationStyle = clipboardPresentationStyle(item.presentationStyle);
      // reject unknown presentation styles
      if (presentationStyle === undefined) return undefined;
      const itemRepresentations = item.representations;
      // require a bounded nonempty representation array
      if (!Array.isArray(itemRepresentations) || itemRepresentations.length === 0 || itemRepresentations.length > maximumClipboardRepresentations) return undefined;
      const uniqueTypes = new Set();
      const representations = Object.create(null);
      // validate every returned representation
      for (const value of itemRepresentations) {
        const representation = clipboardRepresentation(value, uniqueTypes, byteState);
        // reject malformed returned representations
        if (representation === undefined) return undefined;
        representations[representation.type] = representation.blob;
      }
      normalizedItems.push(new NativeClipboardItem(representations, { presentationStyle }));
    }
    return { value: normalizedItems };
  };
  // read plain text through the permission broker
  const readClipboardText = () => startClipboardRequest('clipboard-read-text', {}, (response) => {
    // require only one bounded text payload
    if (typeof response.text !== 'string' || response.text.length > maximumClipboardText || response.items !== undefined || response.error !== undefined) return undefined;
    return { value: response.text };
  });
  // write plain text through the permission broker
  const writeClipboardText = function(text) {
    const argumentCount = arguments.length;
    return new Promise((resolve, reject) => {
      // preserve required dom string conversion before asking for clipboard access
      if (argumentCount === 0 || typeof text === 'symbol') { reject(invalidClipboardInput('clipboard text must be a supplied string-convertible value')); return; }
      let normalized;
      try { normalized = String(text); }
      catch (error) { reject(error); return; }
      // reject oversized text without truncation
      if (normalized.length > maximumClipboardText) { reject(oversizedClipboardInput('clipboard text limit exceeded')); return; }
      startClipboardRequest('clipboard-write-text', { text: normalized }, (response) => {
        // require an empty successful write acknowledgement
        if (response.text !== undefined || response.items !== undefined || response.error !== undefined) return undefined;
        return { value: undefined };
      }).then(resolve, reject);
    });
  };
  // read rich data through the permission broker
  const readClipboard = (options) => {
    // reject unsupported read option bags explicitly
    if (options !== undefined) return Promise.reject(invalidClipboardInput('clipboard read options are not supported'));
    // fail rich reads when reconstruction is unavailable
    if (typeof NativeClipboardItem !== 'function' || typeof NativeBlob !== 'function') return Promise.reject(clipboardException('rich clipboard reads are not supported', 'NotSupportedError'));
    return startClipboardRequest('clipboard-read', {}, parseClipboardItems);
  };
  // write rich data through the permission broker
  const writeClipboard = (items) => new Promise((resolve, reject) => {
    let descriptors;
    try { descriptors = clipboardWriteDescriptors(items); }
    catch (error) { reject(error); return; }
    // fail rich writes when blob validation is unavailable
    if (typeof NativeBlob !== 'function') { reject(clipboardException('rich clipboard writes are not supported', 'NotSupportedError')); return; }
    const id = identifier();
    const entry = clipboardRequestEntry(id, resolve, reject, (response) => {
      // require an empty successful write acknowledgement
      if (response.text !== undefined || response.items !== undefined || response.error !== undefined) return undefined;
      return { value: undefined };
    }, false);
    // stop before materialization when no pending capacity remains
    if (!reserveClipboardRequest(id, entry)) return;
    void (async () => {
      const serializedItems = [];
      let totalBytes = 0;
      try {
        // materialize every validated clipboard item
        for (const descriptor of descriptors) {
          const representations = [];
          // await every declared native representation
          for (const type of descriptor.types) {
            const blob = await descriptor.getType.call(descriptor.item, type);
            // stop late serialization after timeout or navigation
            if (pending.get(id) !== entry) return;
            // require native blobs with exact declared types
            if (!(blob instanceof NativeBlob) || blob.type !== clipboardBlobType(type) || typeof blob.size !== 'number' || !Number.isFinite(blob.size) || blob.size < 0) throw invalidClipboardInput('clipboard blob type does not match its representation');
            totalBytes += blob.size;
            // reject oversized aggregate data without truncation
            if (totalBytes > maximumClipboardBytes) throw oversizedClipboardInput('clipboard data limit exceeded');
            representations.push({ type, blob });
          }
          serializedItems.push({ presentationStyle: descriptor.presentationStyle, representations });
        }
      }
      catch (error) {
        // ignore late native failures after another settlement
        if (pending.get(id) !== entry) return;
        removePending(id);
        entry.reject(error);
        return;
      }
      // stop late serialization after timeout or navigation
      if (pending.get(id) !== entry) return;
      try {
        postRequest({ id, operation: 'clipboard-write', items: serializedItems });
        entry.posted = true;
      }
      catch {
        removePending(id);
        entry.fail(locationError(2, 'permission broker unavailable'), false);
      }
    })();
  });
  // request managed notification permission
  const requestNotificationPermission = (callback) => new Promise((resolve, reject) => {
    let settled = false;
    // settle the promise and deprecated callback once
    const finish = (permission) => {
      // ignore duplicate broker responses
      if (settled) return;
      settled = true;
      resolve(permission);
      // retain deprecated callback compatibility
      if (typeof callback === 'function') invokeCallback(callback, undefined, permission);
    };
    // reject one unavailable broker operation
    const fail = (error, cancel = true) => {
      // ignore duplicate broker responses
      if (settled) return;
      settled = true;
      if (cancel) cancelNotification(id);
      reject(transportException(error));
    };
    const id = identifier();
    startRequest({ id, operation: 'notification-permission' }, {
      kind: 'notification-permission',
      timer: undefined,
      awaitingConsent: true,
      // resolve unavailable requests conservatively
      fail,
      // settle one permission response
      handle: (response) => {
        // retain an explicit broker denial
        if (response.status === 'denied') { notificationPermission = 'denied'; removePending(id); finish('denied'); return; }
        // conservatively settle broker errors
        if (response.status === 'error') { removePending(id); settled = true; reject(transportException(response.error)); return; }
        // ignore malformed permission values
        if (response.permission !== 'default' && response.permission !== 'granted' && response.permission !== 'denied') return;
        notificationPermission = response.permission;
        removePending(id);
        finish(response.permission);
      }
    });
  });
  // model one managed Notification instance
  class BrokerNotification {
    // construct and show one notification through the parent
    constructor(title, options) {
      // enforce the document-local permission state
      if (notificationPermission !== 'granted') throw permissionException();
      // leave room for parent reconciliation of dismissed worker notifications
      if (pending.size >= maximumPendingOperations || pendingCount(entry => entry.awaitingConsent === true) >= maximumPendingConsent) throw capacityException('permission broker operation limit reached');
      const normalized = notificationOptions(options);
      const id = identifier();
      this.title = limitedText(title, 200);
      this.body = normalized.body;
      this.tag = normalized.tag;
      this.requireInteraction = normalized.requireInteraction;
      this.silent = normalized.silent;
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
      this.__id = id;
      this.__closed = false;
      this.__listeners = new Map();
      notifications.set(id, this);
      startRequest({ id, operation: 'notification-show', title: this.title, options: normalized }, {
        kind: 'notification-show',
        timer: undefined,
        awaitingConsent: true,
        notification: this,
        // surface a show failure
        fail: (_error, cancel = true) => { if (cancel) cancelNotification(id); notifications.delete(id); emitNotification(this, 'error'); },
        // validate and forward one notification response
        handle: (response) => {
          // reject a mismatched broker notification identifier
          if (response.notificationId !== undefined && response.notificationId !== id) return;
          // terminate denied or failed notifications
          if (response.status === 'denied' || response.status === 'error') { removePending(id); notifications.delete(id); emitNotification(this, 'error'); return; }
          // accept an acknowledgement without a lifecycle event
          if (response.event === undefined) { clearDeadline(pending.get(id)); return; }
          // reject unknown lifecycle events
          if (response.event !== 'show' && response.event !== 'click' && response.event !== 'close' && response.event !== 'error') return;
          clearDeadline(pending.get(id));
          emitNotification(this, response.event);
          // release terminal notification events
          if (response.event === 'close' || response.event === 'error') { removePending(id); notifications.delete(id); }
        }
      });
    }
    // register one notification listener
    addEventListener(type, listener) {
      // ignore unsupported listener shapes
      if (typeof listener !== 'function' && (!listener || typeof listener.handleEvent !== 'function')) return;
      const name = String(type);
      const listeners = this.__listeners.get(name) || new Set();
      listeners.add(listener);
      this.__listeners.set(name, listeners);
    }
    // remove one notification listener
    removeEventListener(type, listener) {
      const listeners = this.__listeners.get(String(type));
      // ignore absent listener groups
      if (listeners === undefined) return;
      listeners.delete(listener);
    }
    // dispatch one application-created notification event
    dispatchEvent(event) {
      // require one event type
      if (!event || typeof event.type !== 'string') throw new TypeError('event type is required');
      emitNotification(this, event.type);
      return true;
    }
    // close one managed notification
    close() {
      // send at most one close request
      if (this.__closed) return;
      this.__closed = true;
      const id = identifier();
      const notificationId = this.__id;
      startRequest({ id, operation: 'notification-close', notificationId }, {
        kind: 'notification-close',
        timer: undefined,
        // cancel late events after an unacknowledged close
        fail: () => { removePending(notificationId); notifications.delete(notificationId); emitNotification(this, 'error'); },
        // settle one close response
        handle: (response) => {
          // reject a mismatched broker notification identifier
          if (response.notificationId !== undefined && response.notificationId !== notificationId) return;
          removePending(id);
          // cancel late events after a rejected close
          if (response.status !== 'ok') { removePending(notificationId); notifications.delete(notificationId); emitNotification(this, 'error'); }
        }
      });
    }
    // expose the document-local permission state
    static get permission() { return notificationPermission; }
    // expose the promise-based permission request
    static requestPermission(callback) { return requestNotificationPermission(callback); }
  }
  // validate and route one parent response
  const receiveResponse = (event) => {
    // require the configured parent authority
    if (event.source !== parentWindow || event.origin !== parentOrigin) return;
    const response = event.data;
    // require one scoped protocol response
    if (response === null || typeof response !== 'object' || Array.isArray(response) || response.type !== 'rac-browser-permission-response' || response.clientId !== clientId || typeof response.id !== 'string' || (response.status !== 'ok' && response.status !== 'denied' && response.status !== 'error')) return;
    const entry = pending.get(response.id);
    // ignore unknown, settled, and forged identifiers
    if (entry === undefined) return;
    try { entry.handle(response); }
    catch { /* ignore malformed structured-clone payloads */ }
  };
  // install the managed geolocation surface
  const installGeolocation = () => {
    const geolocation = { getCurrentPosition, watchPosition, clearWatch };
    try { Object.defineProperty(window.navigator, 'geolocation', { configurable: true, value: geolocation }); }
    catch {
      // fall back to ordinary assignment when permitted
      try { window.navigator.geolocation = geolocation; }
      catch { /* retain the native surface when it is immutable */ }
    }
  };
  // install the managed notification surface
  const installNotification = () => {
    try { Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: BrokerNotification }); }
    catch {
      // fall back to ordinary assignment when permitted
      try { window.Notification = BrokerNotification; }
      catch { /* retain the native surface when it is immutable */ }
    }
  };
  // install the managed clipboard surface
  const installClipboard = () => {
    const clipboard = { readText: readClipboardText, writeText: writeClipboardText, read: readClipboard, write: writeClipboard };
    try { Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard }); }
    catch {
      // fall back to ordinary assignment when permitted
      try { window.navigator.clipboard = clipboard; }
      catch { /* retain the native surface when it is immutable */ }
    }
  };
  // start one broker session
  const connect = () => {
    const id = identifier();
    startRequest({ id, operation: 'connect' }, {
      kind: 'connect',
      timer: undefined,
      // disconnect after a missing handshake
      fail: (error) => disconnect(error),
      // accept only a successful handshake
      handle: (response) => {
        removePending(id);
        // disconnect rejected sessions
        if (response.status !== 'ok') disconnect(locationError(2, 'permission broker rejected the session'));
        // restore only notification permission explicitly returned by the trusted parent
        else if (response.permission === 'granted' || response.permission === 'denied' || response.permission === 'default') notificationPermission = response.permission;
      }
    });
  };

  window.addEventListener('message', receiveResponse);
  window.addEventListener('pagehide', disconnectDocument);
  window.addEventListener('pageshow', restoreDocument);
  installGeolocation();
  installNotification();
  installClipboard();
  connect();
})();`;
