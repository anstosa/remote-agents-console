import { expect, test, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { createServer, request as sendRequest } from 'node:http';
import { ProjectProxy } from '../../server/src/project-proxy.js';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

const consoleOrigin = 'http://127.0.0.1:4173';
const managedOrigin = 'https://project.example.com';
const otherManagedOrigin = 'https://other-project.example.com';
const directOrigin = 'https://external-preview.example';
const managedFrameName = 'rac-managed-preview-v1';

type ProviderState = {
  geolocationGets: number;
  geolocationWatches: number;
  geolocationClears: number[];
  notificationRequests: Array<{ active: boolean }>;
  notifications: Array<{ title: string; body?: string; closed: boolean }>;
  clipboardReads: Array<{ method: 'readText' | 'read'; active: boolean }>;
  clipboardWrites: Array<{ method: 'writeText' | 'write'; active: boolean; text?: string; items?: Array<Array<{ type: string; text: string; size: number }>> }>;
  clipboardText: string;
  clipboardItems: Array<Array<{ type: string; text: string; size: number }>>;
};

// load the production bridge through its real proxy endpoint
const projectBrowserBridge = async () => {
  const proxy = new ProjectProxy(() => [{ projectUrl: managedOrigin, projectPort: 1 }], consoleOrigin);
  const server = createServer((request, response) => {
    // reject unrelated virtual hosts and paths
    if (!proxy.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      // reject unexpected non-tcp listeners
      if (address === null || typeof address === 'string') { reject(new Error('missing browser bridge listener')); return; }
      resolve(address.port);
    });
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = sendRequest({ hostname: '127.0.0.1', port, path: '/__rac/browser-bridge.js', headers: { host: 'project.example.com' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.once('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

// install deterministic parent providers without replacing the broker
const installParentProviders = async (context: BrowserContext) => {
  await context.setGeolocation({ latitude: 47.6062, longitude: -122.3321, accuracy: 12 });
  await context.grantPermissions(['geolocation'], { origin: consoleOrigin });
  await context.addInitScript(parentOrigin => {
    // leave preview-native apis for the production bridge to replace
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = {
      geolocationGets: 0,
      geolocationWatches: 0,
      geolocationClears: [],
      notificationRequests: [],
      notifications: [],
      clipboardReads: [],
      clipboardWrites: [],
      clipboardText: 'parent clipboard text',
      clipboardItems: [[
        { type: 'text/plain', text: 'parent plain text', size: 17 },
        { type: 'text/html', text: '<b>parent html</b>', size: 18 }
      ]]
    };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    const geolocation = navigator.geolocation;
    const getCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
    const watchPosition = geolocation.watchPosition.bind(geolocation);
    const clearWatch = geolocation.clearWatch.bind(geolocation);
    Object.defineProperties(geolocation, {
      getCurrentPosition: {
        configurable: true,
        // record one parent location lookup
        value: (...args: Parameters<Geolocation['getCurrentPosition']>) => { state.geolocationGets += 1; return getCurrentPosition(...args); }
      },
      watchPosition: {
        configurable: true,
        // record one parent location watch
        value: (...args: Parameters<Geolocation['watchPosition']>) => { state.geolocationWatches += 1; return watchPosition(...args); }
      },
      clearWatch: {
        configurable: true,
        // record one parent watch cancellation
        value: (id: number) => { state.geolocationClears.push(id); clearWatch(id); }
      }
    });
    class ParentNotification extends EventTarget {
      static permission: NotificationPermission = 'default';
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ParentNotification.permission = 'granted';
        return ParentNotification.permission;
      }
      readonly title: string;
      readonly options?: NotificationOptions;
      readonly index: number;
      onshow: ((event: Event) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      // retain one native notification request
      constructor(title: string, options?: NotificationOptions) {
        super();
        this.title = title;
        this.options = options;
        this.index = state.notifications.push({ title, ...(options?.body === undefined ? {} : { body: options.body }), closed: false }) - 1;
        queueMicrotask(() => {
          const event = new Event('show');
          this.dispatchEvent(event);
          this.onshow?.(event);
        });
      }
      // expose native close propagation
      close() {
        state.notifications[this.index]!.closed = true;
        const event = new Event('close');
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ParentNotification });
    type ClipboardMethod = 'readText' | 'writeText' | 'read' | 'write';
    type ClipboardFailure = { method: ClipboardMethod; name: string; message: string };
    // read one configured native failure
    const failure = () => (window as typeof window & { __clipboardFailure?: ClipboardFailure }).__clipboardFailure;
    // reject one configured native operation
    const rejectConfigured = (method: ClipboardMethod) => {
      const configured = failure();
      // leave other native operations unchanged
      if (configured?.method !== method) return;
      Reflect.deleteProperty(window, '__clipboardFailure');
      throw new DOMException(configured.message, configured.name);
    };
    // serialize one native clipboard item
    const serializeClipboardItem = async (item: ClipboardItem) => {
      const formats: Array<{ type: string; text: string; size: number }> = [];
      // retain every advertised representation
      for (const type of [...item.types].sort()) {
        const blob = await item.getType(type);
        formats.push({ type, text: await blob.text(), size: blob.size });
      }
      return formats;
    };
    // expose deterministic native clipboard methods
    const clipboard = {
      // read deterministic parent text
      readText: async () => {
        state.clipboardReads.push({ method: 'readText', active: navigator.userActivation.isActive });
        rejectConfigured('readText');
        return state.clipboardText;
      },
      // write deterministic parent text
      writeText: async (text: string) => {
        state.clipboardWrites.push({ method: 'writeText', active: navigator.userActivation.isActive, text });
        rejectConfigured('writeText');
        state.clipboardText = text;
      },
      // read deterministic rich parent items
      read: async () => {
        state.clipboardReads.push({ method: 'read', active: navigator.userActivation.isActive });
        rejectConfigured('read');
        // custom format keys keep their prefix while their blobs keep the underlying mime type
        return state.clipboardItems.map(item => new ClipboardItem(Object.fromEntries(item.map(format => [format.type, new Blob([format.text], { type: format.type.startsWith('web ') ? format.type.slice(4) : format.type })]))));
      },
      // write and retain rich native items
      write: async (items: ClipboardItem[]) => {
        state.clipboardWrites.push({ method: 'write', active: navigator.userActivation.isActive });
        rejectConfigured('write');
        const serialized = [];
        // serialize every item before committing the native result
        for (const item of items) serialized.push(await serializeClipboardItem(item));
        state.clipboardItems = serialized;
        state.clipboardWrites.at(-1)!.items = serialized;
      }
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  }, consoleOrigin);
};

// install absent parent capabilities while retaining a call record
const installUnsupportedParentProviders = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [], clipboardReads: [], clipboardWrites: [], clipboardText: '', clipboardItems: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Reflect.deleteProperty(window, 'Notification');
  }, consoleOrigin);
};

// retain child-native identities before any document script runs
const installNativePermissionReferenceCapture = async (context: BrowserContext) => {
  await context.addInitScript(origin => {
    // leave unrelated documents unchanged
    if (location.origin !== origin) return;
    const geolocation = navigator.geolocation;
    Object.defineProperty(window, '__nativePermissionApis', { configurable: true, value: {
      geolocation,
      getCurrentPosition: geolocation?.getCurrentPosition,
      watchPosition: geolocation?.watchPosition,
      clearWatch: geolocation?.clearWatch,
      notification: window.Notification,
      notificationRequestPermission: window.Notification?.requestPermission,
      clipboard: navigator.clipboard,
      clipboardReadText: navigator.clipboard?.readText,
      clipboardWriteText: navigator.clipboard?.writeText,
      clipboardRead: navigator.clipboard?.read,
      clipboardWrite: navigator.clipboard?.write,
      clipboardItem: window.ClipboardItem
    } });
  }, managedOrigin);
};

// compare every api identity the production bridge can replace
const nativePermissionApisPreserved = (frame: FrameLocator) => frame.locator('body').evaluate(() => {
  const native = (window as typeof window & { __nativePermissionApis: {
    geolocation: Geolocation | undefined;
    getCurrentPosition: Geolocation['getCurrentPosition'] | undefined;
    watchPosition: Geolocation['watchPosition'] | undefined;
    clearWatch: Geolocation['clearWatch'] | undefined;
    notification: typeof Notification | undefined;
    notificationRequestPermission: typeof Notification.requestPermission | undefined;
    clipboard: Clipboard | undefined;
    clipboardReadText: Clipboard['readText'] | undefined;
    clipboardWriteText: Clipboard['writeText'] | undefined;
    clipboardRead: Clipboard['read'] | undefined;
    clipboardWrite: Clipboard['write'] | undefined;
    clipboardItem: typeof ClipboardItem | undefined;
  } }).__nativePermissionApis;
  return {
    geolocation: native.geolocation === navigator.geolocation,
    getCurrentPosition: native.getCurrentPosition === navigator.geolocation?.getCurrentPosition,
    watchPosition: native.watchPosition === navigator.geolocation?.watchPosition,
    clearWatch: native.clearWatch === navigator.geolocation?.clearWatch,
    notification: native.notification === window.Notification,
    notificationRequestPermission: native.notificationRequestPermission === window.Notification?.requestPermission,
    clipboard: native.clipboard === navigator.clipboard,
    clipboardReadText: native.clipboardReadText === navigator.clipboard?.readText,
    clipboardWriteText: native.clipboardWriteText === navigator.clipboard?.writeText,
    clipboardRead: native.clipboardRead === navigator.clipboard?.read,
    clipboardWrite: native.clipboardWrite === navigator.clipboard?.write,
    clipboardItem: native.clipboardItem === window.ClipboardItem
  };
});

// install a delayed service-worker display fallback
const installServiceWorkerNotificationProvider = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [], clipboardReads: [], clipboardWrites: [], clipboardText: '', clipboardItems: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    class ThrowingNotification {
      static permission: NotificationPermission = 'default';
      // preserve native activation evidence
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ThrowingNotification.permission = 'granted';
        return ThrowingNotification.permission;
      }
      // force the mobile-style worker fallback
      constructor() { throw new Error('foreground notifications unavailable'); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ThrowingNotification });
    const registration = {
      // retain worker-backed display attempts
      showNotification: async (title: string, options?: NotificationOptions) => { state.notifications.push({ title, ...(options?.body === undefined ? {} : { body: options.body }), closed: false }); },
      getNotifications: async () => []
    };
    let resolveRegistration!: (value: typeof registration) => void;
    const pendingRegistration = new Promise<typeof registration>(resolve => { resolveRegistration = resolve; });
    Object.defineProperty(window, '__resolvePreviewRegistration', { configurable: true, value: () => resolveRegistration(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => pendingRegistration, ready: pendingRegistration, register: async () => registration } });
  }, consoleOrigin);
};

// install a worker provider that records dismissal and same-tag replacement
const installReconcilingWorkerProvider = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [], clipboardReads: [], clipboardWrites: [], clipboardText: '', clipboardItems: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    class ThrowingNotification {
      static permission: NotificationPermission = 'default';
      // grant the one parent-owned native prompt
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ThrowingNotification.permission = 'granted';
        return ThrowingNotification.permission;
      }
      // force every display through the worker provider
      constructor() { throw new Error('foreground notifications unavailable'); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ThrowingNotification });
    type WorkerRecord = { title: string; tag: string; data?: Record<string, unknown>; reason?: string };
    const active = new Map<string, WorkerRecord & { close: () => void }>();
    const shows: WorkerRecord[] = [];
    const removed: WorkerRecord[] = [];
    let getNotifications = 0;
    // remove one worker notification with evidence
    const remove = (record: WorkerRecord & { close: () => void }, reason: string) => {
      // ignore duplicate dismissal signals
      if (active.get(record.tag) !== record) return;
      active.delete(record.tag);
      removed.push({ title: record.title, tag: record.tag, data: record.data, reason });
    };
    const registration = {
      // model os replacement by worker tag
      showNotification: async (title: string, options?: NotificationOptions) => {
        const tag = options?.tag ?? '';
        const replaced = active.get(tag);
        // remove the prior os-owned display for one reused tag
        if (replaced !== undefined) remove(replaced, 'replaced');
        const record = { title, tag, data: options?.data as Record<string, unknown> | undefined, close: () => remove(record, 'closed') };
        active.set(tag, record);
        shows.push({ title, tag, data: record.data });
      },
      // expose only notifications the os still displays
      getNotifications: async ({ tag }: { tag?: string } = {}) => {
        getNotifications += 1;
        return [...active.values()].filter(record => tag === undefined || record.tag === tag);
      }
    };
    Object.defineProperty(window, '__dismissPreviewWorkerNotifications', { configurable: true, value: () => {
      // dismiss every currently displayed worker notification
      for (const record of [...active.values()]) remove(record, 'dismissed');
    } });
    Object.defineProperty(window, '__previewWorkerSnapshot', { configurable: true, value: () => ({
      active: [...active.values()].map(({ title, tag, data }) => ({ title, tag, data })),
      shows: shows.map(record => ({ ...record })),
      removed: removed.map(record => ({ ...record })),
      getNotifications
    }) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration, ready: Promise.resolve(registration), register: async () => registration } });
  }, consoleOrigin);
};

// read parent-only provider calls
const providerState = (page: Page) => page.evaluate(() => (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState);

// reject the next selected parent clipboard operation
const failNextClipboardOperation = (page: Page, method: 'readText' | 'writeText' | 'read' | 'write', name: string, message: string) => page.evaluate(failure => {
  Object.defineProperty(window, '__clipboardFailure', { configurable: true, value: failure });
}, { method, name, message });

// snapshot RAC-owned browser storage without assuming one key layout
const localStorageSnapshot = (page: Page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).sort(([left], [right]) => left.localeCompare(right))));

// address one versioned persistent approval by exact origin and capability
type TestedPermissionCapability = 'geolocation' | 'notifications' | 'clipboard-read' | 'clipboard-write';

const storedApprovalKey = (origin: string, capability: TestedPermissionCapability) => `rac.browser-permission:v1:${encodeURIComponent(origin)}:${capability}`;

// read the canonical pointer and its token-scoped approval record
const storedApproval = (page: Page, origin: string, capability: TestedPermissionCapability) => page.evaluate(baseKey => {
  const token = localStorage.getItem(baseKey);
  return { token, grant: token === null ? null : localStorage.getItem(`${baseKey}:${token}`) };
}, storedApprovalKey(origin, capability));

// compare unrelated RAC preferences without treating inert ordering metadata as a grant
const storageWithoutApproval = (snapshot: Record<string, string>, origin: string, capability: TestedPermissionCapability) => {
  const baseKey = storedApprovalKey(origin, capability);
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== baseKey && !key.startsWith(`${baseKey}:`)));
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// render standard-api controls inside one managed preview document
const managedPreview = (path: string) => `<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body>
  <main>Managed permission preview <span id="path">${path}</span></main>
  <button id="get">Get location</button><output id="get-result">idle</output>
  <button id="watch">Watch location</button><button id="clear">Clear watch</button><output id="watch-result">idle</output>
  <button id="permission">Request notifications</button><output id="permission-result">idle</output>
  <button id="show">Show notification</button><button id="close">Close notification</button><output id="notification-result">idle</output>
  <button id="clipboard-read-text">Read clipboard text</button><output id="clipboard-read-text-result">idle</output>
  <button id="clipboard-write-text">Write clipboard text</button><output id="clipboard-write-text-result">idle</output>
  <button id="clipboard-read">Read rich clipboard</button><output id="clipboard-read-result">idle</output>
  <button id="clipboard-write">Write rich clipboard</button><output id="clipboard-write-result">idle</output>
  <button id="navigate">Navigate preview</button>
  <script>
    let watchId;
    let notice;
    const watchEvents = [];
    const locationError = error => 'error:' + error.code + ':' + error.message;
    document.querySelector('#get').onclick = () => navigator.geolocation.getCurrentPosition(
      position => { document.querySelector('#get-result').textContent = 'ok:' + position.coords.latitude.toFixed(4) + ',' + position.coords.longitude.toFixed(4) + ':' + position.coords.accuracy; },
      error => { document.querySelector('#get-result').textContent = locationError(error); }
    );
    document.querySelector('#watch').onclick = () => {
      watchId = navigator.geolocation.watchPosition(
        position => { watchEvents.push(position.coords.latitude.toFixed(4) + ',' + position.coords.longitude.toFixed(4)); document.querySelector('#watch-result').textContent = 'ok:' + watchEvents.join('|'); },
        error => { document.querySelector('#watch-result').textContent = locationError(error); }
      );
      document.querySelector('#watch-result').textContent = 'watching';
    };
    document.querySelector('#clear').onclick = () => { navigator.geolocation.clearWatch(watchId); document.querySelector('#watch-result').textContent += ':cleared'; };
    document.querySelector('#permission').onclick = async () => {
      try { document.querySelector('#permission-result').textContent = await Notification.requestPermission(); }
      catch (error) { document.querySelector('#permission-result').textContent = 'error:' + error.name; }
    };
    document.querySelector('#show').onclick = () => {
      try {
        notice = new Notification('Build complete', { body: 'Preview task finished', tag: 'preview-build' });
        document.querySelector('#notification-result').textContent = 'created';
        notice.addEventListener('show', () => { document.querySelector('#notification-result').textContent += ':show'; });
        notice.addEventListener('close', () => { document.querySelector('#notification-result').textContent += ':close'; });
        // expose broker-denied displays to the fixture
        notice.addEventListener('error', () => { document.querySelector('#notification-result').textContent += ':error'; });
      } catch (error) { document.querySelector('#notification-result').textContent = 'error:' + error.name; }
    };
    document.querySelector('#close').onclick = () => { notice?.close(); };
    // exercise one standard text read
    document.querySelector('#clipboard-read-text').onclick = async () => {
      try { document.querySelector('#clipboard-read-text-result').textContent = 'ok:' + await navigator.clipboard.readText(); }
      catch (error) { document.querySelector('#clipboard-read-text-result').textContent = 'error:' + error.name + ':' + error.message; }
    };
    // exercise one standard text write
    document.querySelector('#clipboard-write-text').onclick = async () => {
      try { await navigator.clipboard.writeText('managed clipboard text'); document.querySelector('#clipboard-write-text-result').textContent = 'ok'; }
      catch (error) { document.querySelector('#clipboard-write-text-result').textContent = 'error:' + error.name + ':' + error.message; }
    };
    // exercise one standard rich read
    document.querySelector('#clipboard-read').onclick = async () => {
      try {
        const items = await navigator.clipboard.read();
        const serialized = [];
        // serialize every returned item
        for (const item of items) {
          const formats = [];
          // serialize every returned format
          for (const type of [...item.types].sort()) formats.push(type + '=' + await (await item.getType(type)).text());
          serialized.push(formats.join(','));
        }
        document.querySelector('#clipboard-read-result').textContent = 'ok:' + serialized.join('|');
      } catch (error) { document.querySelector('#clipboard-read-result').textContent = 'error:' + error.name + ':' + error.message; }
    };
    // exercise one standard rich write
    document.querySelector('#clipboard-write').onclick = async () => {
      try {
        const items = [
          new ClipboardItem({ 'text/plain': new Blob(['first plain'], { type: 'text/plain' }), 'text/html': new Blob(['<b>first html</b>'], { type: 'text/html' }) }),
          new ClipboardItem({ 'web application/json': new Blob(['{\"second\":true}'], { type: 'application/json' }), 'text/plain': new Blob(['second plain'], { type: 'text/plain' }) })
        ];
        await navigator.clipboard.write(items);
        document.querySelector('#clipboard-write-result').textContent = 'ok';
      } catch (error) { document.querySelector('#clipboard-write-result').textContent = 'error:' + error.name + ':' + error.message; }
    };
    document.querySelector('#navigate').onclick = () => { location.assign(location.pathname === '/next' ? '/third' : '/next'); };
  </script>
</body></html>`;

// send one valid-looking request from a nested non-owner window
const spoofPreview = `<script>
  const clientId = crypto.randomUUID();
  window.top.postMessage({ type: 'rac-browser-permission-request', clientId, id: crypto.randomUUID(), operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30000, maximumAge: 0 } }, '${consoleOrigin}');
  window.top.postMessage({ type: 'rac-browser-permission-request', clientId, id: crypto.randomUUID(), operation: 'clipboard-read-text' }, '${consoleOrigin}');
</script>`;

// load the production bridge before retaining the forged nested request
const nestedBridgeSpoofPreview = `<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body>
  <main>Nested proxied project document</main>
  ${spoofPreview}
</body></html>`;

// render native controls without the managed bridge
const directPreview = `<!doctype html><html><body>
  <main>Direct permission preview</main>
  <button id="get">Get direct location</button><output id="get-result">idle</output>
  <button id="permission">Request direct notifications</button><output id="permission-result">idle</output>
  <script>
    document.querySelector('#get').onclick = () => navigator.geolocation.getCurrentPosition(
      () => { document.querySelector('#get-result').textContent = 'unexpected-success'; },
      error => { document.querySelector('#get-result').textContent = 'error:' + error.code; }
    );
    document.querySelector('#permission').onclick = async () => {
      try { document.querySelector('#permission-result').textContent = await Notification.requestPermission(); }
      catch (error) { document.querySelector('#permission-result').textContent = 'error:' + error.name; }
    };
  </script>
</body></html>`;

// route one dashboard and its preview document
const setupDashboard = async (page: Page, options: { bridge: string; direct?: boolean; previewOrigin?: string }) => {
  const previewOrigin = options.previewOrigin ?? (options.direct === true ? directOrigin : managedOrigin);
  await installPaneMock(page);
  await page.context().route(`${previewOrigin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    // serve only managed previews with the production bridge
    if (!options.direct && requestUrl.pathname === '/__rac/browser-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: options.bridge });
    // serve one nested source spoof with the production bridge
    if (!options.direct && requestUrl.pathname === '/spoof-source') return route.fulfill({ contentType: 'text/html', body: nestedBridgeSpoofPreview });
    const target = requestUrl.pathname === '/__rac/browser-device' ? new URL(requestUrl.searchParams.get('location') ?? '/', requestUrl.origin) : requestUrl;
    const transition = requestUrl.pathname === '/__rac/browser-device' ? `<script>history.replaceState({}, '', ${JSON.stringify(`${target.pathname}${target.search}${target.hash}`)})</script>` : '';
    return route.fulfill({ contentType: 'text/html', body: options.direct ? directPreview : `${transition}${managedPreview(target.pathname)}` });
  });
  // serve an origin-spoofing nested document for managed-frame checks
  if (!options.direct) await page.context().route(`${directOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: spoofPreview }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish an authenticated session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish one preview target
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-permissions', sessionId: 'socket:$1', home: '/worktrees/permissions', worktreeId: 'permissions', worktreeLabel: 'Permissions', worktreeOrder: 0, title: 'Ready', projectUrl: previewOrigin, ...(options.direct ? { projectProxied: false } : {}), stack: { actions: ['start'], running: true, tunnel: true } }], projects: [] } });
    // serve the required log ticket
    if (path === '/api/agents/agent-permissions/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty agent collections
    if (path === '/api/agents/agent-permissions/saved-prompts' || path === '/api/agents/agent-permissions/prompt-history' || path === '/api/agents/agent-permissions/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // serve empty worktree notes
    if (path === '/api/worktrees/permissions/notes') return route.fulfill({ json: { notes: [] } });
    // disable console push setup
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// open the configured preview in BrowserPane
const openBrowser = async (page: Page) => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-permissions', 80, 24);
  const browser = page.getByRole('dialog', { name: 'Browser' });
  // preserve BrowserPane state shared through RAC storage
  if (await browser.isVisible()) return;
  await page.getByRole('group', { name: 'Project controls' }).getByRole('button', { name: 'Stack controls: healthy' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(browser).toBeVisible();
};

// reopen the BrowserPane without replacing RAC storage
const reopenBrowser = async (page: Page) => {
  const browser = page.getByRole('dialog', { name: 'Browser' });
  // preserve BrowserPane state restored by a full RAC reload
  if (await browser.isVisible()) return;
  await page.getByRole('group', { name: 'Project controls' }).getByRole('button', { name: 'Stack controls: healthy' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(browser).toBeVisible();
};

// select one visible permission decision
const decide = async (page: Page, name: string, decision: 'Allow once' | 'allow always' | 'deny') => {
  const consent = page.getByRole('dialog', { name });
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: decision, exact: true }).click();
  await expect(consent).toBeHidden();
};

// resolve one native reset confirmation before its click can finish
const resetPreviewPermissions = async (page: Page, accept: boolean): Promise<string> => {
  const reset = page.getByRole('dialog', { name: 'Browser' }).getByRole('button', { name: 'Reset preview permissions' });
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = reset.click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('confirm');
  const message = dialog.message();
  // follow the scenario's explicit confirmation choice
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  await clickPromise;
  return message;
};

type PermissionProtocolResponse = { clientId?: string; id: string; status: string; error?: { code?: number; name?: string; message?: string }; position?: unknown; text?: string; items?: unknown };

// create one canonical deterministic protocol id
const protocolId = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

// make managed preview documents reconnect with one known client nonce
const installPermissionClientId = (context: BrowserContext, clientId: string) => context.addInitScript(({ origin, client }) => {
  // leave parent and unrelated frames unchanged
  if (location.origin !== origin) return;
  let sequence = 1;
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => sequence++ === 1 ? client : `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` });
}, { origin: managedOrigin, client: clientId });

// capture broker responses inside the owning managed frame
const startPermissionResponseCapture = (preview: FrameLocator) => preview.locator('body').evaluate(() => {
  const record = window as typeof window & { __permissionResponses?: PermissionProtocolResponse[] };
  record.__permissionResponses = [];
  window.addEventListener('message', event => {
    // retain only broker responses
    if (event.data?.type === 'rac-browser-permission-response') record.__permissionResponses?.push(event.data);
  });
});

// send one trusted-frame protocol request
const postPermissionRequest = (preview: FrameLocator, message: Record<string, unknown>) => preview.locator('body').evaluate((_, { payload, target }) => window.parent.postMessage(payload, target), { payload: message, target: consoleOrigin });

// send ordered trusted-frame protocol requests in one task
const postPermissionRequests = (preview: FrameLocator, messages: Array<Record<string, unknown>>) => preview.locator('body').evaluate((_, { payloads, target }) => {
  // retain request order at the message boundary
  for (const payload of payloads) window.parent.postMessage(payload, target);
}, { payloads: messages, target: consoleOrigin });

// read the captured response stream
const permissionResponses = (preview: FrameLocator) => preview.locator('body').evaluate(() => (window as typeof window & { __permissionResponses: PermissionProtocolResponse[] }).__permissionResponses);

test('brokers geolocation only after consent and revokes watches across preview lifetimes', async ({ context, page }) => {
  test.setTimeout(75_000);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consentName = 'Allow location?';

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: consentName })).toContainText(managedOrigin);
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, consentName, 'deny');
  await expect(preview.locator('#get-result')).toHaveText(/^error:1:/u);
  expect((await providerState(page)).geolocationGets).toBe(0);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');

  await preview.getByRole('button', { name: 'Get location' }).click();
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, consentName, 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  expect((await providerState(page)).geolocationGets).toBe(1);

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, consentName, 'allow always');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(3);

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(preview.locator('#watch-result')).toContainText('47.6062,-122.3321');
  await context.setGeolocation({ latitude: 37.7749, longitude: -122.4194, accuracy: 8 });
  await expect(preview.locator('#watch-result')).toContainText('37.7749,-122.4194');
  await preview.getByRole('button', { name: 'Clear watch' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(1);
  const clearedOutput = await preview.locator('#watch-result').textContent();
  await context.setGeolocation({ latitude: 40.7128, longitude: -74.0060, accuracy: 6 });
  await page.waitForTimeout(250);
  await expect(preview.locator('#watch-result')).toHaveText(clearedOutput ?? '');

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(2);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/third');
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(2);
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(4);

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  expect((await providerState(page)).geolocationGets).toBe(4);

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(3);
  const clearCount = (await providerState(page)).geolocationClears.length;
  await page.getByRole('dialog', { name: 'Browser' }).getByRole('button', { name: 'Close browser' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(clearCount + 1);
});

// preserve only explicit origin-scoped approval across preview visits
test('persists allow always by exact origin and capability across future visits', async ({ context, page }) => {
  test.setTimeout(90_000);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const browser = page.getByRole('dialog', { name: 'Browser' });
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow location?' });

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent.getByRole('button')).toHaveText(['Allow once', 'allow always', 'deny']);
  const beforeOnce = await localStorageSnapshot(page);
  await decide(page, 'Allow location?', 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  const afterOnce = await localStorageSnapshot(page);
  expect(storageWithoutApproval(afterOnce, managedOrigin, 'geolocation')).toEqual(storageWithoutApproval(beforeOnce, managedOrigin, 'geolocation'));
  const onceGeolocation = await storedApproval(page, managedOrigin, 'geolocation');
  expect(onceGeolocation.token).toMatch(uuidPattern);
  expect(onceGeolocation.grant).toBeNull();

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).geolocationGets).toBe(1);
  await decide(page, 'Allow location?', 'deny');
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).geolocationGets).toBe(1);

  const beforeAlways = await localStorageSnapshot(page);
  await decide(page, 'Allow location?', 'allow always');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  const savedAlways = await localStorageSnapshot(page);
  expect(savedAlways).not.toEqual(beforeAlways);
  const savedGeolocation = await storedApproval(page, managedOrigin, 'geolocation');
  expect(savedGeolocation.token).toMatch(uuidPattern);
  expect(savedGeolocation.grant).toBe('allow');
  expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual({ token: null, grant: null });
  expect(await storedApproval(page, otherManagedOrigin, 'geolocation')).toEqual({ token: null, grant: null });

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(3);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/third');
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(4);

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(1);
  const clearCount = (await providerState(page)).geolocationClears.length;
  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(clearCount + 1);
  await reopenBrowser(page);
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(5);

  await page.reload();
  await seedPaneSize(page, 'agent-permissions', 80, 24);
  await reopenBrowser(page);
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(1);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  expect((await providerState(page)).notificationRequests).toEqual([]);
  await decide(page, 'Allow notifications?', 'deny');

  const otherPage = await context.newPage();
  await setupDashboard(otherPage, { bridge, previewOrigin: otherManagedOrigin });
  await openBrowser(otherPage);
  const otherBrowser = otherPage.getByRole('dialog', { name: 'Browser' });
  await otherBrowser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(otherBrowser.getByRole('textbox', { name: 'Browser address' })).toHaveValue(`${otherManagedOrigin}/`);
  const otherPreview = otherPage.frameLocator('iframe[title="Project browser"]');
  await otherPreview.getByRole('button', { name: 'Get location' }).click();
  await expect(otherPage.getByRole('dialog', { name: 'Allow location?' })).toContainText(otherManagedOrigin);
  expect((await providerState(otherPage)).geolocationGets).toBe(0);
  await otherPage.close();
});

// clear saved approval and stop resources before a confirmed reload
test('reset preview permissions clears saved approval and revokes active resources', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'allow always');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  const savedApproval = await localStorageSnapshot(page);
  const savedGeolocation = await storedApproval(page, managedOrigin, 'geolocation');
  expect(savedGeolocation.token).toMatch(uuidPattern);
  expect(savedGeolocation.grant).toBe('allow');
  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(preview.locator('#watch-result')).toContainText('47.6062,-122.3321');
  const clearCount = (await providerState(page)).geolocationClears.length;

  await resetPreviewPermissions(page, true);
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(clearCount + 1);
  await expect(preview.locator('#get-result')).toHaveText('idle');
  const resetStorage = await localStorageSnapshot(page);
  expect(resetStorage).not.toEqual(savedApproval);
  const resetGeolocation = await storedApproval(page, managedOrigin, 'geolocation');
  expect(resetGeolocation.token).toMatch(uuidPattern);
  expect(resetGeolocation.token).not.toBe(savedGeolocation.token);
  expect(resetGeolocation.grant).toBeNull();
  expect(resetStorage[`${storedApprovalKey(managedOrigin, 'geolocation')}:${savedGeolocation.token}`]).toBeUndefined();

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeVisible();
  expect((await providerState(page)).geolocationGets).toBe(1);
});

// preserve approval and live preview state when reset is cancelled
test('cancels reset before clearing approval or reloading the preview', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'allow always');
  await expect(preview.locator('#get-result')).toHaveText(/^ok:/u);
  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(preview.locator('#watch-result')).toContainText('47.6062,-122.3321');
  const savedApproval = await storedApproval(page, managedOrigin, 'geolocation');
  expect(savedApproval.token).toMatch(uuidPattern);
  expect(savedApproval.grant).toBe('allow');
  const clearCount = (await providerState(page)).geolocationClears.length;
  const confirmation = await resetPreviewPermissions(page, false);
  await expect(preview.getByRole('button', { name: 'Get location' })).toBeVisible();

  expect.soft(confirmation).toMatch(/reset.+permission/iu);
  expect.soft(confirmation).toMatch(/reload|unsaved|lose/iu);
  expect.soft(await storedApproval(page, managedOrigin, 'geolocation')).toEqual(savedApproval);
  expect.soft((await providerState(page)).geolocationClears).toHaveLength(clearCount);
  await expect.soft(preview.locator('#watch-result')).toContainText('47.6062,-122.3321');
});

// require native permission before remembering notification approval
test('saves notification approval only after native permission is granted', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    // emulate dismissing the native permission surface
    Notification.requestPermission = async () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); return 'default'; };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  const beforeDefault = await localStorageSnapshot(page);
  await decide(page, 'Allow notifications?', 'allow always');
  await expect(preview.locator('#permission-result')).toHaveText('default');
  expect(await localStorageSnapshot(page)).not.toEqual(beforeDefault);
  const defaultApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(defaultApproval.token).toMatch(uuidPattern);
  expect(defaultApproval.grant).toBeNull();
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    // grant only from the next explicit RAC click
    Notification.requestPermission = async () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); (Notification as unknown as { permission: NotificationPermission }).permission = 'granted'; return 'granted'; };
  });
  await decide(page, 'Allow notifications?', 'allow always');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }, { active: true }]);
  const savedApproval = await localStorageSnapshot(page);
  expect(savedApproval).not.toEqual(beforeDefault);
  const savedNotification = await storedApproval(page, managedOrigin, 'notifications');
  expect(savedNotification.token).toMatch(uuidPattern);
  expect(savedNotification.grant).toBe('allow');

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await expect(consent).toBeHidden();
  expect((await providerState(page)).notificationRequests).toHaveLength(2);

  await page.evaluate(() => { (Notification as unknown as { permission: NotificationPermission }).permission = 'denied'; });
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/third');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect.poll(async () => await consent.isVisible() || /^(?:denied|error:)/u.test(await preview.locator('#permission-result').textContent() ?? '')).toBe(true);
  expect((await providerState(page)).notificationRequests).toHaveLength(2);

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await page.evaluate(() => { (Notification as unknown as { permission: NotificationPermission }).permission = 'default'; });
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(2);
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  expect((await providerState(page)).notificationRequests).toHaveLength(3);
  const onceNotification = await storedApproval(page, managedOrigin, 'notifications');
  expect(onceNotification.token).toMatch(uuidPattern);
  expect(onceNotification.token).not.toBe(savedNotification.token);
  expect(onceNotification.grant).toBeNull();
  expect((await localStorageSnapshot(page))[`${storedApprovalKey(managedOrigin, 'notifications')}:${savedNotification.token}`]).toBeUndefined();

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/third');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(3);
});

// discard native permission answers owned by an abandoned document
test('does not save a late native notification grant after preview navigation', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    const scope = window as typeof window & { __nativeNotificationPermissionSettled: boolean };
    let release!: (permission: NotificationPermission) => void;
    scope.__nativeNotificationPermissionSettled = false;
    Object.defineProperty(window, '__releaseNativeNotificationPermission', { configurable: true, value: (permission: NotificationPermission) => {
      release(permission);
      // mark the next task after native completion microtasks settle
      window.setTimeout(() => { scope.__nativeNotificationPermissionSettled = true; }, 0);
    } });
    // defer the native result beyond the requesting preview document
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      return new Promise<NotificationPermission>(resolve => { release = resolve; });
    };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'allow always');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await page.evaluate(() => (window as typeof window & { __releaseNativeNotificationPermission: (permission: NotificationPermission) => void }).__releaseNativeNotificationPermission('granted'));
  // observe the abandoned native settlement before reading storage
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __nativeNotificationPermissionSettled: boolean }).__nativeNotificationPermissionSettled)).toBe(true);

  const abandonedApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(abandonedApproval.token).toMatch(uuidPattern);
  expect(abandonedApproval.grant).toBeNull();
  await expect(preview.locator('#permission-result')).toHaveText('idle');
  await expect.poll(async () => await preview.locator('body').evaluate(() => Notification.permission)).toBe('default');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

// preserve newer once and deny choices against older native answers
test('keeps newer notification choices ahead of an older native Always result', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    const releases: Array<(permission: NotificationPermission) => void> = [];
    const settlements: boolean[] = [];
    Object.defineProperty(window, '__orderedNotificationSettlements', { configurable: true, value: settlements });
    Object.defineProperty(window, '__releaseOrderedNotificationPermission', { configurable: true, value: (index: number, permission: NotificationPermission) => {
      (Notification as unknown as { permission: NotificationPermission }).permission = permission;
      releases[index]?.(permission);
      // mark the next task after the selected native completion settles
      window.setTimeout(() => { settlements[index] = true; }, 0);
    } });
    // retain each native answer until a newer RAC choice is complete
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      settlements.push(false);
      return new Promise<NotificationPermission>(resolve => { releases.push(resolve); });
    };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'allow always');
  const olderAlways = await storedApproval(page, managedOrigin, 'notifications');
  expect(olderAlways.token).toMatch(uuidPattern);
  expect(olderAlways.grant).toBeNull();
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  expect((await providerState(page)).notificationRequests).toHaveLength(2);
  await page.evaluate(() => (window as typeof window & { __releaseOrderedNotificationPermission: (index: number, permission: NotificationPermission) => void }).__releaseOrderedNotificationPermission(1, 'granted'));
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  const newerOnce = await storedApproval(page, managedOrigin, 'notifications');
  expect(newerOnce.token).toMatch(uuidPattern);
  expect(newerOnce.token).not.toBe(olderAlways.token);
  expect(newerOnce.grant).toBeNull();
  await page.evaluate(() => (window as typeof window & { __releaseOrderedNotificationPermission: (index: number, permission: NotificationPermission) => void }).__releaseOrderedNotificationPermission(0, 'granted'));
  // observe the older native settlement before reading its removed record
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __orderedNotificationSettlements: boolean[] }).__orderedNotificationSettlements[0])).toBe(true);
  expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual(newerOnce);
  expect((await localStorageSnapshot(page))[`${storedApprovalKey(managedOrigin, 'notifications')}:${olderAlways.token}`]).toBeUndefined();

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(2);
  await page.evaluate(() => { (Notification as unknown as { permission: NotificationPermission }).permission = 'default'; });
  await decide(page, 'Allow notifications?', 'allow always');
  const olderDeniedAlways = await storedApproval(page, managedOrigin, 'notifications');
  expect(olderDeniedAlways.token).toMatch(uuidPattern);
  expect(olderDeniedAlways.grant).toBeNull();
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'deny');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  expect((await providerState(page)).notificationRequests).toHaveLength(3);
  const newerDeny = await storedApproval(page, managedOrigin, 'notifications');
  expect(newerDeny.token).toMatch(uuidPattern);
  expect(newerDeny.token).not.toBe(olderDeniedAlways.token);
  expect(newerDeny.grant).toBeNull();
  await page.evaluate(() => (window as typeof window & { __releaseOrderedNotificationPermission: (index: number, permission: NotificationPermission) => void }).__releaseOrderedNotificationPermission(2, 'granted'));
  // observe the denied older settlement before reading its removed record
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __orderedNotificationSettlements: boolean[] }).__orderedNotificationSettlements[2])).toBe(true);
  expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual(newerDeny);
  expect((await localStorageSnapshot(page))[`${storedApprovalKey(managedOrigin, 'notifications')}:${olderDeniedAlways.token}`]).toBeUndefined();
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeHidden();
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  expect((await providerState(page)).notificationRequests).toHaveLength(3);
});

// keep a shared reset authoritative across pending native approval
test('does not save an older native Always result after reset in another pane', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    let release!: (permission: NotificationPermission) => void;
    Object.defineProperty(window, '__releaseCrossPaneNotificationPermission', { configurable: true, value: (permission: NotificationPermission) => release(permission) });
    // defer the old pane until another pane resets shared approval
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      return new Promise<NotificationPermission>(resolve => { release = resolve; });
    };
  });
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'allow always');
  const pendingApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(pendingApproval.token).toMatch(uuidPattern);
  expect(pendingApproval.grant).toBeNull();

  const resetPage = await context.newPage();
  await setupDashboard(resetPage, { bridge });
  await openBrowser(resetPage);
  await resetPreviewPermissions(resetPage, true);
  await expect(resetPage.frameLocator('iframe[title="Project browser"]').getByRole('button', { name: 'Get location' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __releaseCrossPaneNotificationPermission: (permission: NotificationPermission) => void }).__releaseCrossPaneNotificationPermission('granted'));
  await expect(preview.locator('#permission-result')).toHaveText('default');
  expect((await providerState(page)).notifications).toEqual([]);

  const resetApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(resetApproval.token).toMatch(uuidPattern);
  expect(resetApproval.token).not.toBe(pendingApproval.token);
  expect(resetApproval.grant).toBeNull();
  expect((await localStorageSnapshot(page))[`${storedApprovalKey(managedOrigin, 'notifications')}:${pendingApproval.token}`]).toBeUndefined();
  const resetPreview = resetPage.frameLocator('iframe[title="Project browser"]');
  await resetPreview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(resetPage.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  expect((await providerState(resetPage)).notificationRequests).toHaveLength(0);
  await resetPage.close();
});

// cover remaining native grants invalidated by another pane's reset
const deferredCrossPanePermissionCases = [
  { label: 'Once', decision: 'Allow once', failStorage: false },
  { label: 'tokenless Always fallback', decision: 'allow always', failStorage: true }
] as const;

// verify every non-durable pending choice observes the shared reset tombstone
for (const { label, decision, failStorage } of deferredCrossPanePermissionCases) {
  // settle one stale native permission request conservatively
  test(`settles a stale native ${label} grant as default after reset in another pane`, async ({ context, page }) => {
    await installParentProviders(context);
    const bridge = await projectBrowserBridge();
    await setupDashboard(page, { bridge });
    await openBrowser(page);
    const preview = page.frameLocator('iframe[title="Project browser"]');
    const consent = page.getByRole('dialog', { name: 'Allow notifications?' });

    // defer the native result beyond the cross-pane reset
    await page.evaluate(() => {
      const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
      let release!: (permission: NotificationPermission) => void;
      Object.defineProperty(window, '__releaseDeferredCrossPanePermission', { configurable: true, value: (permission: NotificationPermission) => release(permission) });
      // retain the pending native grant for explicit release
      Notification.requestPermission = () => {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        return new Promise<NotificationPermission>(resolve => { release = resolve; });
      };
    });
    // force an empty verified fallback without affecting the reset page
    if (failStorage) await page.evaluate(() => {
      const scope = window as typeof window & { __deferredPermissionStorageSetItem: typeof Storage.prototype.setItem };
      scope.__deferredPermissionStorageSetItem = Storage.prototype.setItem;
      // intercept storage while retaining unrelated receivers
      Storage.prototype.setItem = function (key, value) {
        // reject only RAC local persistence
        if (this === localStorage) throw new DOMException('storage full', 'QuotaExceededError');
        return scope.__deferredPermissionStorageSetItem.call(this, key, value);
      };
    });

    await preview.getByRole('button', { name: 'Request notifications' }).click();
    await expect(consent).toBeVisible();
    await decide(page, 'Allow notifications?', decision);
    expect((await providerState(page)).notificationRequests).toHaveLength(1);
    // restore the original page after the tokenless fallback is captured
    if (failStorage) await page.evaluate(() => {
      const scope = window as typeof window & { __deferredPermissionStorageSetItem: typeof Storage.prototype.setItem };
      Storage.prototype.setItem = scope.__deferredPermissionStorageSetItem;
    });
    const pendingApproval = await storedApproval(page, managedOrigin, 'notifications');
    expect(pendingApproval.grant).toBeNull();
    // distinguish the verified-empty fallback from the ordinary Once tombstone
    if (failStorage) expect(pendingApproval.token).toBeNull();
    else expect(pendingApproval.token).toMatch(uuidPattern);

    const resetPage = await context.newPage();
    await setupDashboard(resetPage, { bridge });
    await openBrowser(resetPage);
    await resetPreviewPermissions(resetPage, true);
    await expect(resetPage.frameLocator('iframe[title="Project browser"]').getByRole('button', { name: 'Get location' })).toBeVisible();
    const resetApproval = await storedApproval(page, managedOrigin, 'notifications');
    expect(resetApproval.token).toMatch(uuidPattern);
    expect(resetApproval.token).not.toBe(pendingApproval.token);
    expect(resetApproval.grant).toBeNull();

    // release only after the replacement tombstone is observable
    await page.evaluate(() => (window as typeof window & { __releaseDeferredCrossPanePermission: (permission: NotificationPermission) => void }).__releaseDeferredCrossPanePermission('granted'));
    await expect(preview.locator('#permission-result')).toHaveText('default');
    expect((await providerState(page)).notifications).toEqual([]);
    expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual(resetApproval);
    await resetPage.close();
  });
}

// reject native completion superseded inside its durable grant write
test('settles default when durable notification save is superseded during its write', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });

  // defer the native answer until the durable write interleaving is installed
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    let release!: (permission: NotificationPermission) => void;
    Object.defineProperty(window, '__releaseInterleavedNotificationPermission', { configurable: true, value: (permission: NotificationPermission) => release(permission) });
    // retain the native result for explicit release
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      return new Promise<NotificationPermission>(resolve => { release = resolve; });
    };
  });
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  await decide(page, 'Allow notifications?', 'allow always');
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
  const pendingApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(pendingApproval.token).toMatch(uuidPattern);
  expect(pendingApproval.grant).toBeNull();

  const baseKey = storedApprovalKey(managedOrigin, 'notifications');
  const pendingGrantKey = `${baseKey}:${pendingApproval.token}`;
  // replace the pointer synchronously inside the token-scoped grant write
  await page.evaluate(({ pointer, grant }) => {
    const scope = window as typeof window & { __permissionSaveSetItem: typeof Storage.prototype.setItem; __permissionSaveInterleavings: number };
    scope.__permissionSaveSetItem = Storage.prototype.setItem;
    scope.__permissionSaveInterleavings = 0;
    // interleave one newer tombstone before the old grant lands
    Storage.prototype.setItem = function (key, value) {
      // rotate only the pending choice's grant write
      if (this === localStorage && key === grant) {
        scope.__permissionSaveInterleavings += 1;
        scope.__permissionSaveSetItem.call(this, pointer, crypto.randomUUID());
      }
      return scope.__permissionSaveSetItem.call(this, key, value);
    };
  }, { pointer: baseKey, grant: pendingGrantKey });

  // release after the storage boundary can supersede the cached choice
  await page.evaluate(() => (window as typeof window & { __releaseInterleavedNotificationPermission: (permission: NotificationPermission) => void }).__releaseInterleavedNotificationPermission('granted'));
  await expect.soft(preview.locator('#permission-result')).toHaveText('default');
  await expect.soft(page.getByRole('alert')).toContainText('changed or could not be verified');
  expect((await providerState(page)).notifications).toEqual([]);
  expect(await page.evaluate(() => (window as typeof window & { __permissionSaveInterleavings: number }).__permissionSaveInterleavings)).toBe(1);
  const replacementApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(replacementApproval.token).toMatch(uuidPattern);
  expect(replacementApproval.token).not.toBe(pendingApproval.token);
  expect(replacementApproval.grant).toBeNull();
  expect((await localStorageSnapshot(page))[pendingGrantKey]).toBeUndefined();
  // restore the native storage setter after settlement
  await page.evaluate(() => {
    const scope = window as typeof window & { __permissionSaveSetItem: typeof Storage.prototype.setItem };
    Storage.prototype.setItem = scope.__permissionSaveSetItem;
  });
});

// keep document denial ahead of older native failure
test('retains an explicit same-document denial after an older native rejection', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });
  // defer one native rejection beyond a newer explicit denial
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    const scope = window as typeof window & { __olderNotificationRejectionSettled: boolean };
    let reject!: (reason?: unknown) => void;
    scope.__olderNotificationRejectionSettled = false;
    Object.defineProperty(window, '__rejectOlderNotificationPermission', { configurable: true, value: () => {
      reject(new DOMException('native prompt failed', 'NotAllowedError'));
      // mark the next task after every rejection microtask settles
      window.setTimeout(() => { scope.__olderNotificationRejectionSettled = true; }, 0);
    } });
    // retain the native rejection for explicit release
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      return new Promise<NotificationPermission>((_resolve, rejectPermission) => { reject = rejectPermission; });
    };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  await decide(page, 'Allow notifications?', 'deny');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  expect((await providerState(page)).notificationRequests).toHaveLength(1);

  // reject the older prompt only after denial is established
  await page.evaluate(() => (window as typeof window & { __rejectOlderNotificationPermission: () => void }).__rejectOlderNotificationPermission());
  // observe the provider settlement instead of sleeping
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __olderNotificationRejectionSettled: boolean }).__olderNotificationRejectionSettled)).toBe(true);
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  const deniedApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(deniedApproval.token).toMatch(uuidPattern);
  expect(deniedApproval.grant).toBeNull();
  expect((await providerState(page)).notifications).toEqual([]);
});

// reject notification display after another pane supersedes consent
test('does not display a notification after reset supersedes its pending native grant', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  expect((await providerState(page)).notificationRequests).toHaveLength(1);

  // defer the display's native grant until another pane resets approval
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    let release!: (permission: NotificationPermission) => void;
    Object.defineProperty(window, '__releaseCrossPaneNotificationShowPermission', { configurable: true, value: (permission: NotificationPermission) => release(permission) });
    // retain the second native result across the reset
    Notification.requestPermission = () => {
      state.notificationRequests.push({ active: navigator.userActivation.isActive });
      return new Promise<NotificationPermission>(resolve => { release = resolve; });
    };
  });
  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(consent).toBeVisible();
  await decide(page, 'Allow notifications?', 'Allow once');
  expect((await providerState(page)).notificationRequests).toHaveLength(2);
  const pendingDisplayApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(pendingDisplayApproval.token).toMatch(uuidPattern);
  expect(pendingDisplayApproval.grant).toBeNull();

  const resetPage = await context.newPage();
  await setupDashboard(resetPage, { bridge });
  await openBrowser(resetPage);
  await resetPreviewPermissions(resetPage, true);
  await expect(resetPage.frameLocator('iframe[title="Project browser"]').getByRole('button', { name: 'Get location' })).toBeVisible();
  const resetApproval = await storedApproval(page, managedOrigin, 'notifications');
  expect(resetApproval.token).toMatch(uuidPattern);
  expect(resetApproval.token).not.toBe(pendingDisplayApproval.token);
  expect(resetApproval.grant).toBeNull();

  // release the stale native grant after the reset tombstone is visible
  await page.evaluate(() => (window as typeof window & { __releaseCrossPaneNotificationShowPermission: (permission: NotificationPermission) => void }).__releaseCrossPaneNotificationShowPermission('granted'));
  await expect.soft(preview.locator('#notification-result')).toHaveText('created:error');
  expect.soft((await providerState(page)).notifications).toEqual([]);
  expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual(resetApproval);
  expect((await localStorageSnapshot(page))[`${storedApprovalKey(managedOrigin, 'notifications')}:${pendingDisplayApproval.token}`]).toBeUndefined();

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toHaveLength(2);
  await resetPage.close();
});

// limit verified-empty storage fallback to the current request
test('falls back to one request when persistent approval cannot be stored', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow location?' });

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeVisible();
  await preview.getByRole('button', { name: 'Get location' }).click();
  const beforeApproval = await localStorageSnapshot(page);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      // reject only RAC local persistence
      if (this === localStorage) throw new DOMException('storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await consent.getByRole('button', { name: 'allow always', exact: true }).click();
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await expect(page.getByRole('alert')).toContainText('Approval could not be saved');
  expect(await localStorageSnapshot(page)).toEqual(beforeApproval);
  expect(await storedApproval(page, managedOrigin, 'geolocation')).toEqual({ token: null, grant: null });
  await expect(consent).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-storage-error-desktop.png', fullPage: true });
  expect((await providerState(page)).geolocationGets).toBe(1);
});

// define recovered results without branching inside each scenario
const transientStorageRecoveryCases = [
  { decision: 'Allow once', expectedGets: 2, expectedResult: /^ok:/u },
  { decision: 'deny', expectedGets: 1, expectedResult: /^error:1:/u }
] as const;

// cover both explicit nonpersistent recovery decisions
for (const { decision, expectedGets, expectedResult } of transientStorageRecoveryCases) {
  // verify one successful decision clears a prior transient warning
  test(`clears a transient storage warning after ${decision}`, async ({ context, page }) => {
    await installParentProviders(context);
    const bridge = await projectBrowserBridge();
    await setupDashboard(page, { bridge });
    await openBrowser(page);
    const preview = page.frameLocator('iframe[title="Project browser"]');
    const consent = page.getByRole('dialog', { name: 'Allow location?' });

    await preview.getByRole('button', { name: 'Get location' }).click();
    await expect(consent).toBeVisible();
    await preview.getByRole('button', { name: 'Get location' }).click();
    // retain the native setter while forcing one persistent write failure
    await page.evaluate(() => {
      const scope = window as typeof window & { __permissionStorageSetItem: typeof Storage.prototype.setItem };
      scope.__permissionStorageSetItem = Storage.prototype.setItem;
      // intercept storage while retaining unrelated receivers
      Storage.prototype.setItem = function (key, value) {
        // reject only RAC local persistence
        if (this === localStorage) throw new DOMException('storage full', 'QuotaExceededError');
        return scope.__permissionStorageSetItem.call(this, key, value);
      };
    });
    await consent.getByRole('button', { name: 'allow always', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Approval could not be saved');
    await expect(preview.locator('#get-result')).toHaveText(/^ok:/u);
    expect((await providerState(page)).geolocationGets).toBe(1);

    // restore successful storage access before the recovery decision
    await page.evaluate(() => {
      const scope = window as typeof window & { __permissionStorageSetItem: typeof Storage.prototype.setItem };
      Storage.prototype.setItem = scope.__permissionStorageSetItem;
    });
    await decide(page, 'Allow location?', decision);

    await expect(preview.locator('#get-result')).toHaveText(expectedResult);
    expect((await providerState(page)).geolocationGets).toBe(expectedGets);
    const recoveryApproval = await storedApproval(page, managedOrigin, 'geolocation');
    expect(recoveryApproval.token).toMatch(uuidPattern);
    expect(recoveryApproval.grant).toBeNull();
    await expect(page.getByRole('alert')).toBeHidden();
  });
}

// retain sibling requests for fresh consent after persistence failure
test('requeues a notification batch when durable approval cannot be stored', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow notifications?' });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(consent).toBeVisible();
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      // reject only RAC local persistence
      if (this === localStorage) throw new DOMException('storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await consent.getByRole('button', { name: 'allow always', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Approval could not be saved');
  await expect(consent).toBeVisible();
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);
  expect(await storedApproval(page, managedOrigin, 'notifications')).toEqual({ token: null, grant: null });
});

// block native work when an older approval cannot be removed
test('blocks Always when an older captured grant record cannot be cleared', async ({ context, page }) => {
  const previousToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const baseKey = storedApprovalKey(managedOrigin, 'geolocation');
  const previousGrantKey = `${baseKey}:${previousToken}`;
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consent = page.getByRole('dialog', { name: 'Allow location?' });

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(consent).toBeVisible();
  await page.evaluate(({ pointer, token, grant }) => {
    localStorage.setItem(pointer, token);
    localStorage.setItem(grant, 'allow');
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      // retain only the captured prior grant record
      if (this === localStorage && key === grant) return;
      removeItem.call(this, key);
    };
  }, { pointer: baseKey, token: previousToken, grant: previousGrantKey });
  await consent.getByRole('button', { name: 'allow always', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Approval could not be saved or cleared');
  await expect(consent).toBeVisible();
  expect((await providerState(page)).geolocationGets).toBe(0);
  const blockedApproval = await storedApproval(page, managedOrigin, 'geolocation');
  expect(blockedApproval.token).toMatch(uuidPattern);
  expect(blockedApproval.token).not.toBe(previousToken);
  expect(blockedApproval.grant).toBeNull();
  expect((await localStorageSnapshot(page))[previousGrantKey]).toBe('allow');
});

test('restores managed permission forwarding after external navigation returns Home', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const browser = page.getByRole('dialog', { name: 'Browser' });
  const frame = page.locator('iframe[title="Project browser"]');
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await expect(frame).toHaveAttribute('name', managedFrameName);
  await browser.getByRole('textbox', { name: 'Browser address' }).fill(`${directOrigin}/away`);
  await browser.getByRole('textbox', { name: 'Browser address' }).press('Enter');
  await expect(frame).toHaveAttribute('src', `${directOrigin}/away`);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);

  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.getByText('Managed permission preview')).toBeVisible();
  await expect(frame).toHaveAttribute('name', managedFrameName);
  await expect.poll(async () => await preview.locator('body').evaluate(() => window.name)).toBe(managedFrameName);
  await preview.getByRole('button', { name: 'Get location' }).click();
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, 'Allow location?', 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  expect((await providerState(page)).geolocationGets).toBe(1);
});

test('releases denied native watches so later preview watches keep their capacity', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    let nextWatchId = 100;
    Object.defineProperties(navigator.geolocation, {
      watchPosition: {
        configurable: true,
        // deny one native watch after allocating its id
        value: (_success: PositionCallback, failure?: PositionErrorCallback | null) => {
          state.geolocationWatches += 1;
          const watchId = nextWatchId;
          nextWatchId += 1;
          queueMicrotask(() => failure?.({ code: 1, message: 'native location denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
          return watchId;
        }
      },
      clearWatch: {
        configurable: true,
        // retain every denied watcher release
        value: (watchId: number) => { state.geolocationClears.push(watchId); }
      }
    });
  });

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await decide(page, 'Allow location?', 'allow always');
  await expect(preview.locator('#watch-result')).toHaveText(/^error:1:/u);
  // exceed the eight-watch cap through sequential native denials
  for (let index = 2; index <= 9; index += 1) {
    await preview.getByRole('button', { name: 'Watch location' }).click();
    await expect(preview.locator('#watch-result')).toHaveText(/^error:1:/u);
    await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(index);
  }
  await expect.poll(async () => (await providerState(page)).geolocationClears).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108]);
});

test('keeps stale same-id geolocation callbacks from escaping a replacement document clear', async ({ context, page }) => {
  const clientId = '00000000-0000-4000-8000-000000000001';
  const requestId = '00000000-0000-4000-8000-000000000010';
  const clearId = '00000000-0000-4000-8000-000000000011';
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    Object.defineProperty(window, '__releasePermissionPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6 + index, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain callbacks across preview document replacement
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);

  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(1);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await startPermissionResponseCapture(preview);

  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(2);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: clearId, operation: 'geolocation-clear', watchId: requestId });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: clearId, status: 'ok' }));

  await page.evaluate(() => {
    const release = (window as typeof window & { __releasePermissionPosition: (index: number) => void }).__releasePermissionPosition;
    // deliver the stale callback before the cancelled replacement callback
    release(0);
    release(1);
  });
  await page.waitForTimeout(100);
  const positionResponses = (await permissionResponses(preview)).filter(response => response.id === requestId && response.position !== undefined);
  expect(positionResponses).toEqual([]);
});

test('keeps parent capability capacity bounded across document replacement', async ({ context, page }) => {
  test.setTimeout(60_000);
  const requestId = protocolId('40000000', 100);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.geolocationGets = 0;
    Object.defineProperty(window, '__releaseParentCapacityPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6 + index, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain native callbacks beyond document replacement
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);
  const connectDocument = async (index: number) => {
    const clientId = protocolId('41000000', index);
    const connectId = protocolId('42000000', index);
    await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: connectId, operation: 'connect' });
    await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId, id: connectId, status: 'ok' }));
    return clientId;
  };
  // fill the parent-wide native capacity across replacement documents
  for (let index = 1; index <= 16; index += 1) {
    const clientId = await connectDocument(index);
    await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
    await decide(page, 'Allow location?', 'Allow once');
  }
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(16);

  const overflowClient = await connectDocument(17);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: overflowClient, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId: overflowClient, id: requestId, status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  expect((await providerState(page)).geolocationGets).toBe(16);

  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(0));
  const currentClient = await connectDocument(18);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: currentClient, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(17);

  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(1));
  const clearId = protocolId('43000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: currentClient, id: clearId, operation: 'geolocation-clear', watchId: requestId });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId: currentClient, id: clearId, status: 'ok' }));
  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(16));
  await page.waitForTimeout(100);
  expect((await permissionResponses(preview)).some(response => response.clientId === currentClient && response.id === requestId && response.position !== undefined)).toBe(false);
});

test('bounds native location work while preserving clear through saturated replay history', async ({ context, page }) => {
  const clientId = protocolId('20000000', 1);
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'allow always');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.geolocationGets = 0;
    Object.defineProperty(window, '__releaseCapacityPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain native work until the test releases it
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);
  const requestIds = Array.from({ length: 140 }, (_, index) => protocolId('21000000', index + 1));
  await postPermissionRequests(preview, requestIds.map(id => ({ type: 'rac-browser-permission-request', clientId, id, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } })));

  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(16);
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds[16], status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  const clearId = protocolId('22000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: clearId, operation: 'geolocation-clear', watchId: requestIds[0] });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: clearId, status: 'ok', watchId: requestIds[0] }));
  await page.evaluate(() => (window as typeof window & { __releaseCapacityPosition: (index: number) => void }).__releaseCapacityPosition(0));
  await page.waitForTimeout(100);
  expect((await permissionResponses(preview)).some(response => response.id === requestIds[0] && response.position !== undefined)).toBe(false);
});

test('bounds native notification prompts while preserving close through saturated replay history', async ({ context, page }) => {
  const clientId = protocolId('30000000', 1);
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.notificationRequests = [];
    // hold the native prompt open until teardown
    Notification.requestPermission = () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); return new Promise<NotificationPermission>(() => undefined); };
  });
  await startPermissionResponseCapture(preview);
  const requestIds = Array.from({ length: 140 }, (_, index) => protocolId('31000000', index + 1));
  const notificationRequest = (id: string) => ({ type: 'rac-browser-permission-request', clientId, id, operation: 'notification-permission' });
  await postPermissionRequests(preview, requestIds.slice(0, 16).map(notificationRequest));
  await decide(page, 'Allow notifications?', 'allow always');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await postPermissionRequest(preview, notificationRequest(requestIds[16]));
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds[16], status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  await postPermissionRequests(preview, requestIds.slice(17).map(notificationRequest));
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds.at(-1), status: 'error' }));

  const closeId = protocolId('32000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: closeId, operation: 'notification-close', notificationId: requestIds[0] });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: closeId, status: 'ok', notificationId: requestIds[0] }));
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('attributes preview notifications and preserves native click activation', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consentName = 'Allow notifications?';

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  const consent = page.getByRole('dialog', { name: consentName });
  await expect(consent).toContainText(`${managedOrigin} wants Remote Agent Console to show notifications for this preview.`);
  await expect(consent).toContainText('Notifications identify this preview and are displayed by Remote Agent Console.');
  await expect(consent).not.toContainText(/service worker|push/iu);
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-desktop.png', fullPage: true });
  const split = page.locator('.log-split');
  const splitSizing = await split.evaluate(element => {
    const layout = element as HTMLElement;
    const previous = { minimum: layout.style.getPropertyValue('--split-pane-min-width'), browser: layout.style.getPropertyValue('--browser-split') };
    layout.style.setProperty('--split-pane-min-width', '300px');
    layout.style.setProperty('--browser-split', '300px');
    return previous;
  });
  await expect.poll(async () => (await page.getByRole('dialog', { name: 'Browser' }).boundingBox())?.width ?? 0).toBeLessThanOrEqual(301);
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-narrow-desktop.png', fullPage: true });
  const narrowLayout = await consent.evaluate(element => {
    const consentBounds = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, buttonOverflow: buttons.some(bounds => bounds.left < consentBounds.left || bounds.right > consentBounds.right) };
  });
  expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.clientWidth);
  expect(narrowLayout.buttonOverflow).toBe(false);
  await split.evaluate((element, previous) => {
    const layout = element as HTMLElement;
    layout.style.setProperty('--split-pane-min-width', previous.minimum);
    layout.style.setProperty('--browser-split', previous.browser);
  }, splitSizing);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(consent).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1400, height: 850 });
  expect((await providerState(page)).notificationRequests).toEqual([]);
  await decide(page, consentName, 'allow always');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText('created:show');
  await expect.poll(async () => (await providerState(page)).notifications).toEqual([{ title: `Preview ${managedOrigin} — Build complete`, body: 'Shown by Remote Agent Console\n\nPreview task finished', closed: false }]);
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText(':close');
  await expect.poll(async () => (await providerState(page)).notifications[0]?.closed).toBe(true);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('preserves a dismissed native notification prompt as default until explicit denial', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    // emulate dismissing the native permission surface
    Notification.requestPermission = async () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); return 'default'; };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('default');
  await expect.poll(async () => await preview.locator('body').evaluate(() => Notification.permission)).toBe('default');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'deny');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  await expect.poll(async () => await preview.locator('body').evaluate(() => Notification.permission)).toBe('denied');
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('denies clipboard reads and writes without invoking parent providers', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  const readConsent = page.getByRole('dialog', { name: 'Allow clipboard reading?' });
  await expect(readConsent).toContainText(managedOrigin);
  await expect(readConsent.getByRole('button')).toHaveText(['Allow once', 'allow always', 'deny']);
  expect((await providerState(page)).clipboardReads).toEqual([]);
  await decide(page, 'Allow clipboard reading?', 'deny');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText(/^error:NotAllowedError:/u);
  expect((await providerState(page)).clipboardReads).toEqual([]);

  await preview.getByRole('button', { name: 'Write clipboard text' }).click();
  const writeConsent = page.getByRole('dialog', { name: 'Allow clipboard writing?' });
  await expect(writeConsent).toContainText(managedOrigin);
  await expect(writeConsent.getByRole('button')).toHaveText(['Allow once', 'allow always', 'deny']);
  expect((await providerState(page)).clipboardWrites).toEqual([]);
  await decide(page, 'Allow clipboard writing?', 'deny');
  await expect(preview.locator('#clipboard-write-text-result')).toHaveText(/^error:NotAllowedError:/u);
  expect((await providerState(page)).clipboardWrites).toEqual([]);
});

test('forwards one-time clipboard grants through active parent consent clicks', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('ok:parent clipboard text');
  expect((await providerState(page)).clipboardReads).toEqual([{ method: 'readText', active: true }]);
  const readApproval = await storedApproval(page, managedOrigin, 'clipboard-read');
  expect(readApproval.token).toMatch(uuidPattern);
  expect(readApproval.grant).toBeNull();

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeVisible();
  expect((await providerState(page)).clipboardReads).toHaveLength(1);
  await decide(page, 'Allow clipboard reading?', 'deny');

  await preview.getByRole('button', { name: 'Write clipboard text' }).click();
  await decide(page, 'Allow clipboard writing?', 'Allow once');
  await expect(preview.locator('#clipboard-write-text-result')).toHaveText('ok');
  expect((await providerState(page)).clipboardWrites).toEqual([{ method: 'writeText', active: true, text: 'managed clipboard text' }]);
  const writeApproval = await storedApproval(page, managedOrigin, 'clipboard-write');
  expect(writeApproval.token).toMatch(uuidPattern);
  expect(writeApproval.grant).toBeNull();
});

test('persists successful clipboard scopes independently and resets both', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'allow always');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('ok:parent clipboard text');
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBe('allow');
  expect(await storedApproval(page, managedOrigin, 'clipboard-write')).toEqual({ token: null, grant: null });

  await preview.getByRole('button', { name: 'Write clipboard text' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow clipboard writing?' })).toBeVisible();
  await decide(page, 'Allow clipboard writing?', 'allow always');
  await expect(preview.locator('#clipboard-write-text-result')).toHaveText('ok');
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBe('allow');
  expect((await storedApproval(page, managedOrigin, 'clipboard-write')).grant).toBe('allow');

  await resetPreviewPermissions(page, true);
  await expect(preview.getByRole('button', { name: 'Read clipboard text' })).toBeVisible();
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBeNull();
  expect((await storedApproval(page, managedOrigin, 'clipboard-write')).grant).toBeNull();
  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeVisible();
  expect((await providerState(page)).clipboardReads).toHaveLength(1);
});

test('roundtrips rich multi-format clipboard items through native ClipboardItem', async ({ context, page }) => {
  await installParentProviders(context);
  await installNativePermissionReferenceCapture(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Write rich clipboard' }).click();
  await decide(page, 'Allow clipboard writing?', 'Allow once');
  await expect(preview.locator('#clipboard-write-result')).toHaveText('ok');
  expect((await providerState(page)).clipboardWrites).toEqual([{
    method: 'write',
    active: true,
    items: [
      [{ type: 'text/html', text: '<b>first html</b>', size: 17 }, { type: 'text/plain', text: 'first plain', size: 11 }],
      [{ type: 'text/plain', text: 'second plain', size: 12 }, { type: 'web application/json', text: '{"second":true}', size: 15 }]
    ]
  }]);

  await preview.getByRole('button', { name: 'Read rich clipboard' }).click();
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect(preview.locator('#clipboard-read-result')).toHaveText('ok:text/html=<b>first html</b>,text/plain=first plain|text/plain=second plain,web application/json={"second":true}');
  expect((await providerState(page)).clipboardReads).toEqual([{ method: 'read', active: true }]);
  const identities = await nativePermissionApisPreserved(preview);
  expect(identities.clipboardItem).toBe(true);
  expect(identities.clipboard).toBe(false);
});

test('requires fresh parent activation for saved clipboard access and preserves native denial', async ({ context, page }) => {
  test.setTimeout(45_000);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'allow always');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('ok:parent clipboard text');
  await failNextClipboardOperation(page, 'readText', 'NotAllowedError', 'native clipboard denied');
  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('error:NotAllowedError:native clipboard denied');
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeHidden();
  expect((await providerState(page)).clipboardReads).toHaveLength(2);

  await page.evaluate(() => {
    // isolate expired activation from the synthetic gestures granted by playwright evaluations
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false, hasBeenActive: true } });
  });
  await preview.locator('body').evaluate(() => {
    const result = document.querySelector('#clipboard-read-text-result')!;
    result.textContent = 'pending';
    // request saved access while the parent has no usable activation
    void navigator.clipboard.readText().then(
      text => { result.textContent = `ok:${text}`; },
      error => { result.textContent = `error:${error.name}:${error.message}`; }
    );
  });
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeVisible();
  expect((await providerState(page)).clipboardReads).toHaveLength(2);
  // restore the real browser activation before testing the consent click
  await page.evaluate(() => { Reflect.deleteProperty(navigator, 'userActivation'); });
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('ok:parent clipboard text');
  expect((await providerState(page)).clipboardReads).toEqual([
    { method: 'readText', active: true },
    { method: 'readText', active: true },
    { method: 'readText', active: true }
  ]);
});

test('does not persist clipboard approval after native once or always failures', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await failNextClipboardOperation(page, 'readText', 'SecurityError', 'native read blocked');
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('error:SecurityError:native read blocked');
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBeNull();

  await preview.getByRole('button', { name: 'Write clipboard text' }).click();
  await failNextClipboardOperation(page, 'writeText', 'NotReadableError', 'native write failed');
  await decide(page, 'Allow clipboard writing?', 'allow always');
  await expect(preview.locator('#clipboard-write-text-result')).toHaveText('error:NotReadableError:native write failed');
  expect((await storedApproval(page, managedOrigin, 'clipboard-write')).grant).toBeNull();
  expect((await providerState(page)).clipboardWrites).toEqual([{ method: 'writeText', active: true, text: 'managed clipboard text' }]);

  await preview.getByRole('button', { name: 'Write clipboard text' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow clipboard writing?' })).toBeVisible();
  expect((await providerState(page)).clipboardWrites).toHaveLength(1);
});

test('rejects malformed and oversized clipboard protocol payloads before native work', async ({ context, page }) => {
  const clientId = protocolId('51000000', 1);
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await startPermissionResponseCapture(preview);

  await preview.locator('body').evaluate((_, { client, target }) => {
    let index = 1;
    // create one canonical request identifier
    const id = () => `52000000-0000-4000-8000-${String(index++).padStart(12, '0')}`;
    // deliver every invalid boundary case directly to the broker
    const post = (message: Record<string, unknown>) => window.parent.postMessage({ type: 'rac-browser-permission-request', clientId: client, id: id(), ...message }, target);
    post({ operation: 'clipboard-write-text', text: 42 });
    post({ operation: 'clipboard-write-text', text: 'x'.repeat(1_048_577) });
    post({ operation: 'clipboard-read-text', text: 'unexpected' });
    post({ operation: 'clipboard-write', items: Array.from({ length: 5 }, () => ({ presentationStyle: 'unspecified', representations: [{ type: 'text/plain', blob: new Blob(['x'], { type: 'text/plain' }) }] })) });
    post({ operation: 'clipboard-write', items: [{ presentationStyle: 'unspecified', representations: Array.from({ length: 9 }, (_value, typeIndex) => ({ type: `application/x-test-${typeIndex}`, blob: new Blob(['x'], { type: `application/x-test-${typeIndex}` }) })) }] });
    post({ operation: 'clipboard-write', items: [{ presentationStyle: 'unspecified', representations: [{ type: 'application/octet-stream', blob: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'application/octet-stream' }) }] }] });
  }, { client: clientId, target: consoleOrigin });

  // await every rejected request before asserting that consent and native work stayed idle
  await expect.poll(async () => (await permissionResponses(preview))
    .filter(response => response.clientId === clientId && response.status === 'error' && response.error?.code === 2)
    .map(response => response.id).sort()).toEqual(Array.from({ length: 6 }, (_, index) => protocolId('52000000', index + 1)));
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
  expect((await providerState(page)).clipboardReads).toEqual([]);
  expect((await providerState(page)).clipboardWrites).toEqual([]);
});

test('cancels clipboard consent on timeout without invoking native work', async ({ context, page }) => {
  test.setTimeout(45_000);
  await page.clock.install();
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeVisible();
  await page.clock.fastForward(120_001);
  await expect(page.getByRole('dialog', { name: 'Allow clipboard reading?' })).toBeHidden();
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText(/^error:AbortError:/u);
  expect((await providerState(page)).clipboardReads).toEqual([]);
});

test('suppresses late clipboard results after navigation and reset', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const releases: Array<(text: string) => void> = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    Object.defineProperty(window, '__releaseClipboardRead', { configurable: true, value: (index: number, text: string) => releases[index]?.(text) });
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      // retain native results beyond preview replacement
      value: () => {
        state.clipboardReads.push({ method: 'readText', active: navigator.userActivation.isActive });
        return new Promise<string>(resolve => { releases.push(resolve); });
      }
    });
  });

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).clipboardReads).toHaveLength(1);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await page.evaluate(() => (window as typeof window & { __releaseClipboardRead: (index: number, text: string) => void }).__releaseClipboardRead(0, 'stale navigation text'));
  await page.waitForTimeout(100);
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('idle');

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).clipboardReads).toHaveLength(2);
  await resetPreviewPermissions(page, true);
  await expect(preview.getByRole('button', { name: 'Read clipboard text' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __releaseClipboardRead: (index: number, text: string) => void }).__releaseClipboardRead(1, 'stale reset text'));
  await page.waitForTimeout(100);
  await expect(preview.locator('#clipboard-read-text-result')).toHaveText('idle');
});

// suppress sensitive data when a later same-document decision revokes consent
test('never returns pending clipboard data after a newer denial', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await startPermissionResponseCapture(preview);
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      // delay sensitive data until after the user changes their decision
      value: () => {
        state.clipboardReads.push({ method: 'readText', active: navigator.userActivation.isActive });
        return new Promise<string>(resolve => {
          Object.defineProperty(window, '__releaseRevokedClipboardRead', { configurable: true, value: () => resolve('private clipboard contents') });
        });
      }
    });
  });

  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'allow always');
  await expect.poll(async () => (await providerState(page)).clipboardReads).toHaveLength(1);
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBeNull();
  await preview.getByRole('button', { name: 'Read clipboard text' }).click();
  await decide(page, 'Allow clipboard reading?', 'deny');
  await page.evaluate(() => (window as typeof window & { __releaseRevokedClipboardRead: () => void }).__releaseRevokedClipboardRead());

  await expect.poll(async () => (await permissionResponses(preview)).filter(response => response.status === 'denied')).toHaveLength(2);
  expect((await permissionResponses(preview)).some(response => response.text !== undefined || response.items !== undefined)).toBe(false);
  expect((await storedApproval(page, managedOrigin, 'clipboard-read')).grant).toBeNull();
  expect((await providerState(page)).clipboardReads).toHaveLength(1);
});

test('rejects spoofed permission requests and leaves direct frames unbrokered', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge, direct: true });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await page.evaluate(() => window.postMessage({ type: 'rac-browser-permission-request', clientId: crypto.randomUUID(), id: crypto.randomUUID(), operation: 'geolocation-get' }, '*'));
  await page.waitForTimeout(100);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);

  await preview.getByRole('button', { name: 'Get direct location' }).click();
  await expect(preview.locator('#get-result')).toHaveText(/^error:/u);
  await preview.getByRole('button', { name: 'Request direct notifications' }).click();
  await expect(preview.locator('#permission-result')).toHaveText(/^(?:denied|error:)/u);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
  expect((await providerState(page)).geolocationGets).toBe(0);
  expect((await providerState(page)).notificationRequests).toEqual([]);
  expect((await providerState(page)).clipboardReads).toEqual([]);
  expect((await providerState(page)).clipboardWrites).toEqual([]);
});

test('rejects correct-origin and foreign-origin requests from nested preview windows', async ({ context, page }) => {
  await installParentProviders(context);
  await installNativePermissionReferenceCapture(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.locator('body').evaluate((body, frameName) => {
    const sameOrigin = document.createElement('iframe');
    sameOrigin.src = '/spoof-source';
    sameOrigin.name = frameName;
    const foreignOrigin = document.createElement('iframe');
    foreignOrigin.src = 'https://external-preview.example/spoof-origin';
    body.append(sameOrigin, foreignOrigin);
  }, managedFrameName);
  await expect(preview.locator('iframe')).toHaveCount(2);
  const nested = preview.frameLocator('iframe[src="/spoof-source"]');
  await expect(nested.getByText('Nested proxied project document')).toBeVisible();
  await expect(nested.locator('script[src="/__rac/browser-bridge.js"]')).toHaveCount(1);
  expect(await nested.locator('body').evaluate(() => ({ marked: window.name, nested: window.parent !== window.top }))).toEqual({ marked: managedFrameName, nested: true });
  expect(await nativePermissionApisPreserved(nested)).toEqual({
    geolocation: true,
    getCurrentPosition: true,
    watchPosition: true,
    clearWatch: true,
    notification: true,
    notificationRequestPermission: true,
    clipboard: true,
    clipboardReadText: true,
    clipboardWriteText: true,
    clipboardRead: true,
    clipboardWrite: true,
    clipboardItem: true
  });
  await page.waitForTimeout(200);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
  expect((await providerState(page)).geolocationGets).toBe(0);
  expect((await providerState(page)).notificationRequests).toEqual([]);
  expect((await providerState(page)).clipboardReads).toEqual([]);
  expect((await providerState(page)).clipboardWrites).toEqual([]);
});

test('preserves native apis in an unnamed proxied frame embedded outside RAC', async ({ context, page }) => {
  await installNativePermissionReferenceCapture(context);
  const bridge = await projectBrowserBridge();
  await context.route(`${managedOrigin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    // serve the production bridge from its managed endpoint
    if (requestUrl.pathname === '/__rac/browser-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body><main>Standalone proxied project document</main></body></html>' });
  });
  await context.route(`${directOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <main>Non-RAC embedding page</main>
    <iframe title="Standalone proxied project" src="${managedOrigin}/standalone"></iframe>
    <script>window.__permissionMessages = []; window.addEventListener('message', event => window.__permissionMessages.push(event.data));</script>
  </body></html>` }));

  await page.goto(`${directOrigin}/embed-proxied`);
  const standalone = page.frameLocator('iframe[title="Standalone proxied project"]');
  await expect(standalone.getByText('Standalone proxied project document')).toBeVisible();
  await expect(standalone.locator('script[src="/__rac/browser-bridge.js"]')).toHaveCount(1);
  expect(await standalone.locator('body').evaluate(() => ({ unnamed: window.name === '', directChild: window.parent === window.top }))).toEqual({ unnamed: true, directChild: true });
  expect(await nativePermissionApisPreserved(standalone)).toEqual({
    geolocation: true,
    getCurrentPosition: true,
    watchPosition: true,
    clearWatch: true,
    notification: true,
    notificationRequestPermission: true,
    clipboard: true,
    clipboardReadText: true,
    clipboardWriteText: true,
    clipboardRead: true,
    clipboardWrite: true,
    clipboardItem: true
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { __permissionMessages: unknown[] }).__permissionMessages)).toEqual([]);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
});

test('cancels queued watches and transport-timed-out consent without native calls', async ({ context, page }) => {
  test.setTimeout(45_000);
  await page.clock.install();
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeVisible();
  await preview.getByRole('button', { name: 'Clear watch' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  expect((await providerState(page)).geolocationWatches).toBe(0);

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeVisible();
  await page.clock.fastForward(150_001);
  await expect(preview.locator('#get-result')).toHaveText(/^error:3:/u);
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  expect((await providerState(page)).geolocationGets).toBe(0);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeHidden();
  await expect(preview.locator('#notification-result')).toHaveText('created:close');
  expect((await providerState(page)).notifications).toEqual([]);

  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  await page.clock.fastForward(120_001);
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeHidden();
  expect((await providerState(page)).notifications).toEqual([]);
});

test('cancels notification display while the service-worker fallback is pending', async ({ context, page }) => {
  await installServiceWorkerNotificationProvider(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'allow always');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(preview.locator('#notification-result')).toHaveText('created');
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText(':close');
  await page.evaluate(() => (window as typeof window & { __resolvePreviewRegistration: () => void }).__resolvePreviewRegistration());
  await page.waitForTimeout(100);
  expect((await providerState(page)).notifications).toEqual([]);
});

test('reconciles dismissed and replaced worker notifications beyond the live owner cap', async ({ context, page }) => {
  test.setTimeout(60_000);
  await installReconcilingWorkerProvider(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'allow always');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  const show = (index: number, tag: string) => preview.locator('body').evaluate((_, input) => new Promise<'show' | 'error'>(resolve => {
    const record = window as typeof window & { __capacityNotifications?: Notification[] };
    const notification = new Notification(`Worker notice ${input.index}`, { body: `body ${input.index}`, tag: input.tag });
    record.__capacityNotifications = [...record.__capacityNotifications ?? [], notification];
    notification.addEventListener('show', () => resolve('show'));
    notification.addEventListener('error', () => resolve('error'));
  }), { index, tag });
  const outcomes: Array<'show' | 'error'> = [];
  // exceed the parent cap while the os dismisses every prior display
  for (let index = 0; index < 20; index += 1) {
    outcomes.push(await show(index, `dismissed-${index}`));
    await page.evaluate(() => (window as typeof window & { __dismissPreviewWorkerNotifications: () => void }).__dismissPreviewWorkerNotifications());
  }
  // exceed the cap again while one worker tag replaces its predecessor
  for (let index = 20; index < 40; index += 1) outcomes.push(await show(index, 'shared-worker-tag'));
  expect(outcomes).toEqual(Array.from({ length: 40 }, () => 'show'));
  const snapshot = await page.evaluate(() => (window as typeof window & { __previewWorkerSnapshot: () => { active: Array<{ data?: Record<string, unknown> }>; shows: unknown[]; removed: Array<{ reason?: string }>; getNotifications: number } }).__previewWorkerSnapshot());
  expect(snapshot.shows).toHaveLength(40);
  expect(snapshot.active).toHaveLength(1);
  expect(snapshot.removed.filter(record => record.reason === 'dismissed')).toHaveLength(20);
  expect(snapshot.removed.filter(record => record.reason === 'replaced')).toHaveLength(19);
  expect(snapshot.getNotifications).toBeGreaterThanOrEqual(40);
  expect(snapshot.active[0]?.data).toEqual(expect.objectContaining({ previewOwnerId: expect.any(String), previewClientId: expect.any(String), previewNotificationId: expect.any(String) }));
});

test('returns clean denials when parent browser capabilities are unavailable', async ({ context, page }) => {
  const pageErrors: string[] = [];
  // retain unexpected top-level failures
  page.on('pageerror', error => pageErrors.push(error.message));
  await installUnsupportedParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText(/^error:\d+:/u);
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  expect(pageErrors).toEqual([]);
});
