import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { projectBrowserPermissions } from '../src/project-browser-permissions.js';

type PermissionRequest = {
  clientId: string;
  id: string;
  items?: Array<{ presentationStyle: 'unspecified' | 'inline' | 'attachment'; representations: Array<{ blob: Blob; type: string }> }>;
  notificationId?: string;
  operation?: string;
  options?: Record<string, unknown>;
  requestId?: string;
  text?: string;
  title?: string;
  type: string;
  watchId?: string;
};

type PermissionResponse = {
  clientId?: string;
  error?: { code: number; message: string; name?: string };
  event?: string;
  id?: string;
  items?: Array<{ presentationStyle: 'unspecified' | 'inline' | 'attachment'; representations: Array<{ blob: Blob; type: string }> }>;
  notificationId?: string;
  permission?: string;
  position?: unknown;
  status?: string;
  text?: string;
  type?: string;
  watchId?: string;
};

type Timer = { callback: () => void; delay: number };

// yield until cross-context promise work can settle
const settleAsyncWork = () => new Promise<void>(resolve => setImmediate(resolve));

// execute the generated shim against one controlled child window
const executePermissions = (options: { embedded?: boolean; name?: string; nested?: boolean; secure?: boolean } = {}) => {
  const requests: PermissionRequest[] = [];
  const listeners = new Map<string, Array<(event: any) => void>>();
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  let nextUuid = 1;
  const nativeGeolocation = { native: true };
  const nativeClipboard = { native: true };
  const nativePermissions = { native: true };
  class NativeNotification {}
  class NativeClipboardItem {
    readonly presentationStyle: 'unspecified' | 'inline' | 'attachment';
    readonly types: string[];
    readonly #representations: Record<string, Blob>;

    // retain native clipboard item representations
    constructor(representations: Record<string, Blob>, options?: { presentationStyle?: 'unspecified' | 'inline' | 'attachment' }) {
      this.#representations = representations;
      this.presentationStyle = options?.presentationStyle ?? 'unspecified';
      this.types = Object.keys(representations);
    }

    // return one native clipboard item representation
    getType(type: string) {
      const blob = this.#representations[type];
      // reject absent representations like the native surface
      if (blob === undefined) return Promise.reject(new DOMException('representation not found', 'NotFoundError'));
      return Promise.resolve(blob);
    }
  }
  const parent = {
    // retain one outgoing broker request
    postMessage: (message: PermissionRequest, target: string) => {
      expect(target).toBe('https://agents.example.com');
      requests.push(message);
    }
  };
  const window: any = {
    Blob,
    ClipboardItem: NativeClipboardItem,
    DOMException,
    Notification: NativeNotification,
    // retain child-window listeners
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, [...listeners.get(name) ?? [], listener]),
    // release one fake deadline
    clearTimeout: (id: number) => timers.delete(id),
    crypto: {
      // issue stable UUID-shaped protocol identifiers
      randomUUID: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`
    },
    isSecureContext: options.secure ?? true,
    name: options.name ?? 'rac-managed-preview-v1',
    navigator: { clipboard: nativeClipboard, geolocation: nativeGeolocation, permissions: nativePermissions },
    parent,
    top: options.nested === true ? {} : parent,
    // retain one fake deadline
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    }
  };
  // model a top-level window when requested
  if (options.embedded === false) { window.parent = window; window.top = window; }
  runInNewContext(projectBrowserPermissions('https://agents.example.com'), { window });
  // dispatch one window event
  const dispatch = (name: string, event: any) => {
    // notify every retained listener
    for (const listener of listeners.get(name) ?? []) listener(event);
  };
  // return the newest request for one operation
  const request = (operation: string) => {
    const match = [...requests].reverse().find(value => value.operation === operation);
    // fail loudly when production did not send the expected request
    if (match === undefined) throw new Error(`missing ${operation} request`);
    return match;
  };
  // deliver one exact parent response
  const respond = (outgoing: PermissionRequest, response: PermissionResponse = {}, authority: { origin?: string; source?: object } = {}) => dispatch('message', {
    data: {
      type: 'rac-browser-permission-response',
      clientId: outgoing.clientId,
      id: outgoing.id,
      status: 'ok',
      ...response
    },
    origin: authority.origin ?? 'https://agents.example.com',
    source: authority.source ?? parent
  });
  // run every currently retained deadline once
  const expireTimers = () => {
    const retained = [...timers.entries()];
    timers.clear();
    // execute a stable timer snapshot
    for (const [, timer] of retained) timer.callback();
  };
  return { NativeClipboardItem, NativeNotification, dispatch, expireTimers, nativeClipboard, nativeGeolocation, nativePermissions, parent, request, requests, respond, timers, window };
};

// create one complete serialized position
const position = (latitude: number, timestamp: number) => ({
  coords: {
    accuracy: 4,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude,
    longitude: -122.4,
    speed: null
  },
  timestamp
});

describe('project browser permission shim', () => {
  // preserve native APIs outside eligible managed frames
  it('installs only in secure direct console frames and starts a scoped session', () => {
    const embedded = executePermissions();
    expect(embedded.requests).toHaveLength(1);
    expect(embedded.requests[0]).toMatchObject({ type: 'rac-browser-permission-request', operation: 'connect' });
    expect(embedded.requests[0]?.clientId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(embedded.window.navigator.geolocation).not.toBe(embedded.nativeGeolocation);
    expect(embedded.window.navigator.clipboard).not.toBe(embedded.nativeClipboard);
    expect(embedded.window.navigator.permissions).toBe(embedded.nativePermissions);
    expect(embedded.window.ClipboardItem).toBe(embedded.NativeClipboardItem);
    expect(embedded.window.Notification).not.toBe(embedded.NativeNotification);
    expect(embedded.window.Notification.permission).toBe('default');

    const topLevel = executePermissions({ embedded: false });
    expect(topLevel.requests).toEqual([]);
    expect(topLevel.window.navigator.geolocation).toBe(topLevel.nativeGeolocation);
    expect(topLevel.window.navigator.clipboard).toBe(topLevel.nativeClipboard);
    expect(topLevel.window.navigator.permissions).toBe(topLevel.nativePermissions);
    expect(topLevel.window.ClipboardItem).toBe(topLevel.NativeClipboardItem);
    expect(topLevel.window.Notification).toBe(topLevel.NativeNotification);

    const insecure = executePermissions({ secure: false });
    expect(insecure.requests).toEqual([]);
    expect(insecure.window.navigator.geolocation).toBe(insecure.nativeGeolocation);
    expect(insecure.window.navigator.clipboard).toBe(insecure.nativeClipboard);
    expect(insecure.window.navigator.permissions).toBe(insecure.nativePermissions);
    expect(insecure.window.ClipboardItem).toBe(insecure.NativeClipboardItem);
    expect(insecure.window.Notification).toBe(insecure.NativeNotification);
  });

  // preserve native permissions in nested and unrecognized embedding contexts
  it('leaves nested and non-console embeddings untouched', () => {
    const excluded = [
      executePermissions({ nested: true }),
      executePermissions({ name: 'rac-managed-preview-v2' }),
      executePermissions({ name: '' }),
      executePermissions({ name: 'project-frame' })
    ];
    // verify exact native identities without requesting browser permissions
    for (const bridge of excluded) {
      expect(bridge.requests).toEqual([]);
      expect(bridge.window.navigator.geolocation).toBe(bridge.nativeGeolocation);
      expect(bridge.window.navigator.clipboard).toBe(bridge.nativeClipboard);
      expect(bridge.window.navigator.permissions).toBe(bridge.nativePermissions);
      expect(bridge.window.ClipboardItem).toBe(bridge.NativeClipboardItem);
      expect(bridge.window.Notification).toBe(bridge.NativeNotification);
      expect(bridge.timers.size).toBe(0);
    }
  });

  // restore only a validated parent-owned notification grant after connecting
  it('restores remembered notification permission from a successful handshake', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'), { permission: 'granted' });
    expect(bridge.window.Notification.permission).toBe('granted');
    const invalid = executePermissions();
    invalid.respond(invalid.request('connect'), { permission: 'always' });
    expect(invalid.window.Notification.permission).toBe('default');
  });

  // broker all clipboard methods with bounded native blobs
  it('supports plain and rich clipboard round trips without replacing native constructors', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));

    const textRead = bridge.window.navigator.clipboard.readText();
    const readTextRequest = bridge.request('clipboard-read-text');
    expect(Object.keys(readTextRequest).sort()).toEqual(['clientId', 'id', 'operation', 'type']);
    bridge.respond(readTextRequest, { text: 'copied text' });
    await expect(textRead).resolves.toBe('copied text');

    const textWrite = bridge.window.navigator.clipboard.writeText('pasted text');
    const writeTextRequest = bridge.request('clipboard-write-text');
    expect(writeTextRequest.text).toBe('pasted text');
    expect(Object.keys(writeTextRequest).sort()).toEqual(['clientId', 'id', 'operation', 'text', 'type']);
    bridge.respond(writeTextRequest);
    await expect(textWrite).resolves.toBeUndefined();

    const plain = new bridge.window.Blob(['plain'], { type: 'text/plain' });
    const html = new bridge.window.Blob(['<b>plain</b>'], { type: 'text/html' });
    const nativeItem = new bridge.NativeClipboardItem({ 'text/plain': plain, 'text/html': html });
    const richWrite = bridge.window.navigator.clipboard.write([nativeItem]);
    await settleAsyncWork();
    const writeRequest = bridge.request('clipboard-write');
    expect(Object.keys(writeRequest).sort()).toEqual(['clientId', 'id', 'items', 'operation', 'type']);
    expect(writeRequest.items).toEqual([{
      presentationStyle: 'unspecified',
      representations: [{ type: 'text/plain', blob: plain }, { type: 'text/html', blob: html }]
    }]);
    bridge.respond(writeRequest);
    await expect(richWrite).resolves.toBeUndefined();

    const richRead = bridge.window.navigator.clipboard.read();
    const readRequest = bridge.request('clipboard-read');
    expect(Object.keys(readRequest).sort()).toEqual(['clientId', 'id', 'operation', 'type']);
    bridge.respond(readRequest, {
      items: [{
        presentationStyle: 'unspecified',
        representations: [{ type: 'text/plain', blob: plain }, { type: 'text/html', blob: html }]
      }]
    });
    const returnedItems = await richRead;
    expect(returnedItems).toHaveLength(1);
    expect(returnedItems[0]).toBeInstanceOf(bridge.NativeClipboardItem);
    await expect(returnedItems[0].getType('text/plain')).resolves.toBe(plain);
    expect(bridge.window.ClipboardItem).toBe(bridge.NativeClipboardItem);

    const emptyRead = bridge.window.navigator.clipboard.read(undefined);
    bridge.respond(bridge.request('clipboard-read'), { items: [] });
    await expect(emptyRead).resolves.toEqual([]);
  });

  // preserve item presentation metadata across both broker directions
  it('roundtrips presentation styles and rejects invalid native descriptors', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const blob = new Blob(['styled'], { type: 'text/plain' });
    const nativeItem = new bridge.NativeClipboardItem({ 'text/plain': blob }, { presentationStyle: 'attachment' });
    const write = bridge.window.navigator.clipboard.write([nativeItem]);
    await settleAsyncWork();
    const writeRequest = bridge.request('clipboard-write');
    expect(writeRequest.items).toEqual([
      { presentationStyle: 'attachment', representations: [{ type: 'text/plain', blob }] }
    ]);
    bridge.respond(writeRequest);
    await expect(write).resolves.toBeUndefined();

    const read = bridge.window.navigator.clipboard.read();
    const readRequest = bridge.request('clipboard-read');
    bridge.respond(readRequest, {
      items: [{ presentationStyle: 'invalid', representations: [{ type: 'text/plain', blob }] }] as never
    });
    bridge.respond(readRequest, {
      items: [{ presentationStyle: 'inline', representations: [{ type: 'text/plain', blob }], extra: true }] as never
    });
    bridge.respond(readRequest, {
      items: [{ presentationStyle: 'inline', representations: [{ type: 'text/plain', blob }] }]
    });
    const [received] = await read;
    expect(received.presentationStyle).toBe('inline');

    const initialRequestCount = bridge.requests.length;
    const invalid = bridge.window.navigator.clipboard.write([{
      presentationStyle: 'invalid',
      types: ['text/plain'],
      getType: () => Promise.resolve(blob)
    }]).then(() => 'resolved', (error: Error) => error.name);
    await settleAsyncWork();
    expect(bridge.requests).toHaveLength(initialRequestCount);
    await expect(invalid).resolves.toBe('TypeError');
  });

  // retain native argument validation before requesting clipboard authority
  it('rejects missing or symbolic text while preserving explicit undefined', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const initialRequests = bridge.requests.length;
    const invalid = [bridge.window.navigator.clipboard.writeText(), bridge.window.navigator.clipboard.writeText(Symbol('value'))];
    // observe rejection without leaving a pending invalid request unhandled
    const results = invalid.map(promise => promise.then(() => 'resolved', (error: Error) => error.name));
    await settleAsyncWork();
    expect(bridge.requests).toHaveLength(initialRequests);
    await expect(Promise.all(results)).resolves.toEqual(['TypeError', 'TypeError']);
    const explicit = bridge.window.navigator.clipboard.writeText(undefined);
    const request = bridge.request('clipboard-write-text');
    expect(request.text).toBe('undefined');
    bridge.respond(request);
    await expect(explicit).resolves.toBeUndefined();
  });

  // keep custom format identifiers distinct from their underlying blob mime types
  it('roundtrips web custom clipboard representations', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const blob = new Blob(['custom data'], { type: 'application/x-example' });
    const type = 'web application/x-example';
    const item = new bridge.NativeClipboardItem({ [type]: blob });
    const write = bridge.window.navigator.clipboard.write([item]).then(() => 'written', (error: Error) => error.name);
    await settleAsyncWork();
    const request = bridge.request('clipboard-write');
    expect(request.items).toEqual([{
      presentationStyle: 'unspecified',
      representations: [{ type, blob }]
    }]);
    bridge.respond(request);
    await expect(write).resolves.toBe('written');
    const read = bridge.window.navigator.clipboard.read();
    bridge.respond(bridge.request('clipboard-read'), {
      items: [{ presentationStyle: 'unspecified', representations: [{ type, blob }] }]
    });
    const [received] = await read;
    expect(received.types).toEqual([type]);
    await expect(received.getType(type)).resolves.toBe(blob);
  });

  // preserve clipboard denial and dom exception details
  it('maps clipboard denials, broker errors, and pending capacity', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));

    const denied = bridge.window.navigator.clipboard.readText();
    bridge.respond(bridge.request('clipboard-read-text'), { status: 'denied', error: { code: 1, message: 'clipboard blocked', name: 'SecurityError' } });
    await expect(denied).rejects.toMatchObject({ name: 'NotAllowedError', message: 'clipboard blocked' });

    const unsupported = bridge.window.navigator.clipboard.writeText('value');
    bridge.respond(bridge.request('clipboard-write-text'), { status: 'error', error: { code: 2, message: 'not implemented', name: 'NotSupportedError' } });
    await expect(unsupported).rejects.toMatchObject({ name: 'NotSupportedError', message: 'not implemented' });

    const invalidState = bridge.window.navigator.clipboard.readText();
    bridge.respond(bridge.request('clipboard-read-text'), { status: 'error', error: { code: 2, message: 'document inactive', name: 'InvalidStateError' } });
    await expect(invalidState).rejects.toMatchObject({ name: 'InvalidStateError', message: 'document inactive' });

    const cloneFailure = bridge.window.navigator.clipboard.writeText('clone');
    bridge.respond(bridge.request('clipboard-write-text'), { status: 'error', error: { code: 2, message: 'clone failed', name: 'DataCloneError' } });
    await expect(cloneFailure).rejects.toMatchObject({ name: 'DataCloneError', message: 'clone failed' });

    const retained: Array<Promise<string>> = [];
    // fill the shared consent queue
    for (let index = 0; index < 16; index += 1) retained.push(bridge.window.navigator.clipboard.readText());
    await expect(bridge.window.navigator.clipboard.readText()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    let materialized = false;
    const item = {
      types: ['text/plain'],
      // expose any materialization attempted without capacity
      getType: async () => { materialized = true; return new Blob(['value'], { type: 'text/plain' }); }
    };
    await expect(bridge.window.navigator.clipboard.write([item])).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(materialized).toBe(false);
    const requests = bridge.requests.filter(request => request.operation === 'clipboard-read-text').slice(-16);
    // settle the retained clipboard operations
    for (const request of requests) bridge.respond(request, { text: 'done' });
    await expect(Promise.all(retained)).resolves.toEqual(Array.from({ length: 16 }, () => 'done'));
  });

  // reject invalid and oversized clipboard writes before posting
  it('validates clipboard options, text, item shapes, types, and aggregate bytes', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const initialRequestCount = bridge.requests.length;

    await expect(bridge.window.navigator.clipboard.read({})).rejects.toMatchObject({ name: 'TypeError' });
    await expect(bridge.window.navigator.clipboard.write([])).rejects.toMatchObject({ name: 'TypeError' });
    await expect(bridge.window.navigator.clipboard.writeText('x'.repeat(1048577))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(bridge.window.navigator.clipboard.write(Array.from({ length: 5 }, () => ({ types: ['text/plain'], getType: () => Promise.resolve(new Blob([], { type: 'text/plain' })) })))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(bridge.window.navigator.clipboard.write([{ types: ['text/plain', 'text/plain'], getType: () => Promise.resolve(new Blob([], { type: 'text/plain' })) }])).rejects.toMatchObject({ name: 'TypeError' });
    await expect(bridge.window.navigator.clipboard.write([{ types: [''], getType: () => Promise.resolve(new Blob([], { type: '' })) }])).rejects.toMatchObject({ name: 'TypeError' });
    await expect(bridge.window.navigator.clipboard.write([{ types: ['text/plain'], getType: () => Promise.resolve(new Blob([], { type: 'text/html' })) }])).rejects.toMatchObject({ name: 'TypeError' });
    await expect(bridge.window.navigator.clipboard.write([{ types: ['application/octet-stream'], getType: () => Promise.resolve(new Blob([new Uint8Array(4194305)], { type: 'application/octet-stream' })) }])).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(bridge.requests).toHaveLength(initialRequestCount);
  });

  // ignore forged clipboard responses until the exact authority replies
  it('validates clipboard response source, origin, client, and request identifiers', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const promise = bridge.window.navigator.clipboard.readText();
    const outgoing = bridge.request('clipboard-read-text');

    bridge.respond(outgoing, { text: 'wrong origin' }, { origin: 'https://evil.example.com' });
    bridge.respond(outgoing, { text: 'wrong source' }, { source: {} });
    bridge.respond(outgoing, { clientId: '00000000-0000-4000-8000-999999999999', text: 'wrong client' });
    bridge.respond(outgoing, { id: '00000000-0000-4000-8000-999999999998', text: 'wrong request' });
    expect(bridge.requests.filter(request => request.operation === 'clipboard-cancel')).toEqual([]);

    bridge.respond(outgoing, { text: 'trusted' });
    await expect(promise).resolves.toBe('trusted');
  });

  // cancel only posted clipboard work on timeout and navigation
  it('bounds clipboard response and serialization lifecycles', async () => {
    const timed = executePermissions();
    timed.respond(timed.request('connect'));
    const timedRead = timed.window.navigator.clipboard.readText();
    const readRequest = timed.request('clipboard-read-text');
    timed.respond(readRequest, { text: 42 as unknown as string });
    timed.expireTimers();
    await expect(timedRead).rejects.toMatchObject({ name: 'AbortError' });
    const timeoutCancel = timed.request('clipboard-cancel');
    expect(timeoutCancel.requestId).toBe(readRequest.id);
    expect(Object.keys(timeoutCancel).sort()).toEqual(['clientId', 'id', 'operation', 'requestId', 'type']);
    timed.respond(readRequest, { text: 'late' });

    const navigated = executePermissions();
    navigated.respond(navigated.request('connect'));
    const navigatedRead = navigated.window.navigator.clipboard.read();
    const richRequest = navigated.request('clipboard-read');
    navigated.dispatch('pagehide', {});
    await expect(navigatedRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(navigated.request('clipboard-cancel').requestId).toBe(richRequest.id);

    const serializing = executePermissions();
    serializing.respond(serializing.request('connect'));
    let releaseBlob: ((blob: Blob) => void) | undefined;
    const delayedBlob = new Promise<Blob>(resolve => { releaseBlob = resolve; });
    const serializingWrite = serializing.window.navigator.clipboard.write([{ types: ['text/plain'], getType: () => delayedBlob }]);
    await Promise.resolve();
    serializing.dispatch('pagehide', {});
    await expect(serializingWrite).rejects.toMatchObject({ name: 'AbortError' });
    expect(serializing.requests.filter(request => request.operation === 'clipboard-write')).toEqual([]);
    expect(serializing.requests.filter(request => request.operation === 'clipboard-cancel')).toEqual([]);
    releaseBlob?.(new Blob(['late'], { type: 'text/plain' }));
    await settleAsyncWork();
    expect(serializing.requests.filter(request => request.operation === 'clipboard-write')).toEqual([]);
  });

  // validate authority and serialize location traffic
  it('forwards bounded current positions and rejects forged or malformed replies', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const successes: unknown[] = [];
    const errors: Array<{ code: number }> = [];
    bridge.window.navigator.geolocation.getCurrentPosition((value: unknown) => successes.push(value), (error: { code: number }) => errors.push(error), {
      enableHighAccuracy: 'yes',
      maximumAge: Number.POSITIVE_INFINITY,
      timeout: 999999
    });
    const outgoing = bridge.request('geolocation-get');
    expect(outgoing.options).toEqual({ enableHighAccuracy: false, maximumAge: 0, timeout: 60000 });
    expect([...bridge.timers.values()].map(timer => timer.delay)).toContain(180000);

    bridge.respond(outgoing, { position: position(40.7, 10) }, { origin: 'https://evil.example.com' });
    bridge.respond(outgoing, { position: position(40.7, 10) }, { source: {} });
    bridge.respond(outgoing, { clientId: '00000000-0000-4000-8000-999999999999', position: position(40.7, 10) });
    bridge.respond(outgoing, { position: { coords: { latitude: 500 }, timestamp: 10 } });
    expect(successes).toEqual([]);
    expect(errors).toEqual([]);

    bridge.respond(outgoing, { position: position(40.7, 10) });
    expect(successes).toEqual([position(40.7, 10)]);
    bridge.respond(outgoing, { position: position(41, 11) });
    expect(successes).toHaveLength(1);
  });

  // preserve browser denial codes and watch cancellation semantics
  it('reports denials and forwards repeated watch positions until clear', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const denied: Array<{ code: number; message: string }> = [];
    bridge.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number; message: string }) => denied.push(error));
    const lookup = bridge.request('geolocation-get');
    bridge.respond(lookup, { status: 'denied', error: { code: 1, message: 'not approved' } });
    expect(denied).toMatchObject([{ code: 1, message: 'not approved' }]);

    const positions: unknown[] = [];
    const watchId = bridge.window.navigator.geolocation.watchPosition((value: unknown) => positions.push(value), () => undefined, { enableHighAccuracy: true, maximumAge: 50, timeout: 75 });
    const watch = bridge.request('geolocation-watch');
    expect(watchId).toBe(1);
    expect(watch.watchId).toBeUndefined();
    expect(watch.options).toEqual({ enableHighAccuracy: true, maximumAge: 50, timeout: 75 });
    bridge.respond(watch, { position: position(47.6, 20), watchId: watch.id });
    bridge.respond(watch, { position: position(47.7, 21), watchId: watch.id });
    expect(positions).toEqual([position(47.6, 20), position(47.7, 21)]);

    bridge.window.navigator.geolocation.clearWatch(watchId);
    const clear = bridge.request('geolocation-clear');
    expect(clear.id).not.toBe(watch.id);
    expect(clear.watchId).toBe(watch.id);
    bridge.respond(watch, { position: position(47.8, 22), watchId: watch.id });
    expect(positions).toHaveLength(2);
    bridge.respond(clear);
  });

  // model permission, construction, lifecycle events, and close forwarding
  it('provides a constrained Notification surface with forwarded events', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    expect(() => new bridge.window.Notification('blocked')).toThrowError(expect.objectContaining({ name: 'NotAllowedError' }));
    let callbackPermission: string | undefined;
    const permissionPromise = bridge.window.Notification.requestPermission((permission: string) => { callbackPermission = permission; });
    const permission = bridge.request('notification-permission');
    bridge.respond(permission, { permission: 'granted' });
    await expect(permissionPromise).resolves.toBe('granted');
    expect(callbackPermission).toBe('granted');
    expect(bridge.window.Notification.permission).toBe('granted');

    const events: string[] = [];
    const notification = new bridge.window.Notification('t'.repeat(250), {
      actions: [{ action: 'unsafe', title: 'unsafe' }],
      body: 'b'.repeat(2100),
      data: { secret: true },
      icon: 'https://evil.example.com/icon.png',
      requireInteraction: true,
      silent: 'yes',
      tag: 'x'.repeat(140)
    });
    notification.onshow = () => events.push('property-show');
    notification.addEventListener('show', () => events.push('listener-show'));
    notification.addEventListener('click', () => events.push('click'));
    notification.addEventListener('close', () => events.push('close'));
    const show = bridge.request('notification-show');
    expect(show.notificationId).toBeUndefined();
    expect(show.title).toHaveLength(200);
    expect(show.options).toEqual({ body: 'b'.repeat(2000), tag: 'x'.repeat(128), requireInteraction: true, silent: false });
    expect(show.options).not.toHaveProperty('icon');
    expect(show.options).not.toHaveProperty('actions');
    expect(show.options).not.toHaveProperty('data');

    bridge.respond(show, { event: 'show', notificationId: show.id });
    bridge.respond(show, { event: 'click', notificationId: show.id });
    expect(events).toEqual(['property-show', 'listener-show', 'click']);
    notification.close();
    const close = bridge.request('notification-close');
    expect(close.id).not.toBe(show.id);
    expect(close.notificationId).toBe(show.id);
    bridge.respond(close, { notificationId: show.id });
    bridge.respond(show, { event: 'close', notificationId: show.id });
    expect(events).toEqual(['property-show', 'listener-show', 'click', 'close']);
    bridge.respond(show, { event: 'click', notificationId: show.id });
    expect(events).toHaveLength(4);

    const deniedPromise = bridge.window.Notification.requestPermission();
    const denied = bridge.request('notification-permission');
    bridge.respond(denied, { status: 'denied' });
    await expect(deniedPromise).resolves.toBe('denied');
    expect(bridge.window.Notification.permission).toBe('denied');
  });

  // settle retained callbacks on timeout and document disconnect
  it('settles deadlines and disconnects without accepting late responses', async () => {
    const timed = executePermissions();
    timed.respond(timed.request('connect'));
    const timedErrors: number[] = [];
    timed.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number }) => timedErrors.push(error.code), { timeout: 5 });
    const lookup = timed.request('geolocation-get');
    timed.expireTimers();
    expect(timedErrors).toEqual([3]);
    expect(timed.request('geolocation-clear').watchId).toBe(lookup.id);
    timed.respond(lookup, { position: position(40, 30) });
    expect(timedErrors).toEqual([3]);

    const queuedWatch = executePermissions();
    queuedWatch.respond(queuedWatch.request('connect'));
    queuedWatch.window.navigator.geolocation.watchPosition(() => undefined, () => undefined, { timeout: 5 });
    const watch = queuedWatch.request('geolocation-watch');
    queuedWatch.expireTimers();
    const watchCancel = queuedWatch.request('geolocation-clear');
    expect(watchCancel.id).not.toBe(watch.id);
    expect(watchCancel.watchId).toBe(watch.id);

    const permissionTimeout = executePermissions();
    permissionTimeout.respond(permissionTimeout.request('connect'));
    const rejectedPermission = permissionTimeout.window.Notification.requestPermission();
    const permission = permissionTimeout.request('notification-permission');
    permissionTimeout.expireTimers();
    const permissionCancel = permissionTimeout.request('notification-close');
    expect(permissionCancel.notificationId).toBe(permission.id);
    await expect(rejectedPermission).rejects.toMatchObject({ name: 'AbortError', message: 'permission broker timed out' });

    const showTimeout = executePermissions();
    showTimeout.respond(showTimeout.request('connect'));
    const granted = showTimeout.window.Notification.requestPermission();
    showTimeout.respond(showTimeout.request('notification-permission'), { permission: 'granted' });
    await granted;
    const notificationErrors: string[] = [];
    const notification = new showTimeout.window.Notification('timed out');
    notification.addEventListener('error', () => notificationErrors.push('error'));
    const show = showTimeout.request('notification-show');
    showTimeout.expireTimers();
    const showCancel = showTimeout.request('notification-close');
    expect(showCancel.notificationId).toBe(show.id);
    expect(notificationErrors).toEqual(['error']);

    const disconnected = executePermissions();
    disconnected.respond(disconnected.request('connect'));
    const disconnectErrors: number[] = [];
    disconnected.window.navigator.geolocation.watchPosition(() => undefined, (error: { code: number }) => disconnectErrors.push(error.code));
    const disconnectedWatch = disconnected.request('geolocation-watch');
    disconnected.dispatch('pagehide', {});
    expect(disconnectErrors).toEqual([2]);
    expect(disconnected.requests).toContainEqual(expect.objectContaining({ type: 'rac-browser-permission-disconnect', clientId: disconnectedWatch.clientId }));
    expect(disconnected.request('geolocation-clear').watchId).toBe(disconnectedWatch.id);
    await expect(disconnected.window.Notification.requestPermission()).rejects.toMatchObject({ name: 'AbortError' });
    disconnected.dispatch('pageshow', { persisted: true });
    const restoredConnect = disconnected.request('connect');
    expect(restoredConnect.clientId).not.toBe(disconnectedWatch.clientId);
    expect(disconnected.window.Notification.permission).toBe('default');
  });

  // enforce broker-aligned request and resource caps
  it('bounds retained consent, watches, and notifications', async () => {
    const watches = executePermissions();
    watches.respond(watches.request('connect'));
    const watchErrors: number[] = [];
    // fill the active watch allowance
    for (let index = 0; index < 8; index += 1) watches.window.navigator.geolocation.watchPosition(() => undefined, () => undefined);
    const overflowWatchId = watches.window.navigator.geolocation.watchPosition(() => undefined, (error: { code: number }) => watchErrors.push(error.code));
    expect(typeof overflowWatchId).toBe('number');
    expect(watches.requests.filter(request => request.operation === 'geolocation-watch')).toHaveLength(8);
    expect(watchErrors).toEqual([2]);

    const consent = executePermissions();
    consent.respond(consent.request('connect'));
    const consentErrors: number[] = [];
    // fill the pending consent allowance
    for (let index = 0; index < 16; index += 1) consent.window.navigator.geolocation.getCurrentPosition(() => undefined, () => undefined);
    consent.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number }) => consentErrors.push(error.code));
    expect(consent.requests.filter(request => request.operation === 'geolocation-get')).toHaveLength(16);
    expect(consentErrors).toEqual([2]);

    const notifications = executePermissions();
    notifications.respond(notifications.request('connect'));
    const permission = notifications.window.Notification.requestPermission();
    notifications.respond(notifications.request('notification-permission'), { permission: 'granted' });
    await permission;
    // bound retained handles without blocking parent reconciliation after sixteen notices
    for (let index = 0; index < 32; index += 1) {
      new notifications.window.Notification(`notification ${index}`);
      const show = notifications.request('notification-show');
      notifications.respond(show, { notificationId: show.id });
    }
    expect(() => new notifications.window.Notification('overflow')).toThrowError(expect.objectContaining({ name: 'QuotaExceededError' }));
    expect(notifications.requests.filter(request => request.operation === 'notification-show')).toHaveLength(32);
    await expect(notifications.window.navigator.clipboard.readText()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(notifications.window.navigator.clipboard.write([
      new notifications.NativeClipboardItem({ 'text/plain': new Blob(['value'], { type: 'text/plain' }) })
    ])).rejects.toMatchObject({ name: 'QuotaExceededError' });
  });
});
