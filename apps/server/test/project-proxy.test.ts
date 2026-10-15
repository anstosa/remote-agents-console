import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as sendRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { injectProjectBrowserBridge, ProjectProxy } from '../src/project-proxy.js';
import { testWorktree } from './helpers/config.js';

const servers: Server[] = [];

// listen on an ephemeral loopback port
const listen = async (server: Server) => await new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    // reject unexpected non-TCP listeners
    if (address === null || typeof address === 'string') { reject(new Error('missing listener')); return; }
    resolve(address.port);
  });
});

// send one request through a test proxy
const request = async (port: number, path: string, options: { method?: string; body?: string; headers?: IncomingHttpHeaders } = {}) => await new Promise<{ status: number; body: string; contentType?: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
  const outgoing = sendRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: 'project.example.com', ...options.headers, ...(options.body === undefined ? {} : { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(options.body) }) } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), contentType: response.headers['content-type'], headers: response.headers }));
  });
  outgoing.once('error', reject);
  // forward an optional request body
  if (options.body !== undefined) outgoing.write(options.body);
  outgoing.end();
});

// execute one injected bridge against a mobile navigator
const executeBridge = (source: string, lockUserAgent = false) => {
  const messages: Array<{ properties?: string[]; type?: string }> = [];
  const userAgentData = {
    brands: [{ brand: 'Chromium', version: '140' }],
    mobile: true,
    platform: 'Android',
    // expose contradictory mobile high-entropy hints
    getHighEntropyValues: async (_hints: string[]) => ({ architecture: 'arm', bitness: '64', formFactors: ['Mobile'], mobile: true, model: 'Pixel 9', platform: 'Android', platformVersion: '15.0.0', wow64: false }),
    // serialize the original mobile identity
    toJSON: () => ({ brands: [{ brand: 'Chromium', version: '140' }], mobile: true, platform: 'Android' })
  };
  const navigator = { appVersion: '5.0 (Linux; Android 15; Pixel 9) Mobile', platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36', userAgentData };
  // force one observable override failure
  if (lockUserAgent) Object.defineProperty(navigator, 'userAgent', { configurable: false, value: navigator.userAgent });
  const window = {
    addEventListener: () => undefined,
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { href: 'https://project.example.com/dashboard' },
    navigator,
    parent: { postMessage: (message: { properties?: string[]; type?: string }) => messages.push(message) },
    queueMicrotask: (callback: () => void) => callback()
  };
  runInNewContext(source, { window });
  return {
    messages,
    navigator,
    // retry a bridge script included later by project html
    executeAgain: () => runInNewContext(source, { window })
  };
};

type ThemeMeta = { content: string; media?: string; name: string };
type ThemeMessage = { color?: string | null; type?: string };

// execute one injected bridge against a mutable document theme
const executeThemeBridge = (source: string, initial: { dark?: boolean; metas?: ThemeMeta[]; rootBackground?: string } = {}) => {
  let dark = initial.dark ?? false;
  let metas = initial.metas ?? [];
  let rootBackground = initial.rootBackground ?? 'rgba(0, 0, 0, 0)';
  const messages: Array<{ message: ThemeMessage; target: string }> = [];
  const events = new Map<string, Array<(event?: unknown) => void>>();
  const mediaQueries: Array<{ listeners: Set<() => void>; matches: boolean; query: string }> = [];
  const head = {};
  const documentElement = {
    // attach a temporary CSS color probe
    append: (node: { connected?: boolean }) => { node.connected = true; }
  };
  const cssColor = (value: string) => {
    const normalized = value.trim().toLowerCase();
    const named: Record<string, string> = { black: 'rgb(0, 0, 0)', navy: 'rgb(0, 0, 128)', red: 'rgb(255, 0, 0)', transparent: 'rgba(0, 0, 0, 0)' };
    // resolve supported named test colors
    if (named[normalized] !== undefined) return named[normalized];
    const shortHex = /^#([\da-f])([\da-f])([\da-f])$/u.exec(normalized);
    // expand a short hexadecimal color
    if (shortHex !== null) return `rgb(${parseInt(`${shortHex[1]}${shortHex[1]}`, 16)}, ${parseInt(`${shortHex[2]}${shortHex[2]}`, 16)}, ${parseInt(`${shortHex[3]}${shortHex[3]}`, 16)})`;
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/u.exec(normalized);
    // resolve a hexadecimal test color
    if (hex !== null) return `rgb(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)})`;
    return /^rgba?\([^)]+\)$/u.test(normalized) ? normalized : undefined;
  };
  const document = {
    documentElement,
    head,
    // create one validating CSS color probe
    createElement: () => {
      let color = '';
      // model values accepted by an inline color property
      const accepted = (value: string) => cssColor(value) !== undefined || /^(?:inherit|initial|unset|revert(?:-layer)?|var\(|env\()/iu.test(value);
      const style = {
        // expose the accepted source color
        get color() { return color; },
        // model direct browser color assignment
        set color(value: string) { color = accepted(value) ? value : ''; },
        // expose one retained style property
        getPropertyValue: (name: string) => name === 'color' ? color : '',
        // model important inline style assignment
        setProperty: (name: string, value: string) => { color = name === 'color' && accepted(value) ? value : color; }
      };
      return { connected: false, remove: () => undefined, style };
    },
    // return metadata in document order
    querySelectorAll: () => metas.map(meta => ({
      // expose metadata attributes
      getAttribute: (name: string) => name === 'name' ? meta.name : name === 'content' ? meta.content : name === 'media' ? meta.media ?? null : null
    }))
  };
  class MutationObserver {
    private target?: object;
    // retain one mutation callback
    constructor(private readonly callback: () => void) { observers.push(this); }
    // observe one theme-bearing node
    observe(target: object) { this.target = target; }
    // notify matching document mutations
    notify(target: object) { if (this.target === target) this.callback(); }
  }
  const observers: MutationObserver[] = [];
  const parent = { postMessage: (message: ThemeMessage, target: string) => messages.push({ message, target }) };
  const window = {
    // retain bridge lifecycle listeners
    addEventListener: (name: string, callback: (event?: unknown) => void) => { events.set(name, [...events.get(name) ?? [], callback]); },
    // resolve CSS colors and the HTML background
    getComputedStyle: (node: { style?: { color?: string } }) => {
      // expose the HTML background separately
      if (node === documentElement) return { backgroundColor: rootBackground };
      const source = node.style?.color ?? '';
      const inherited = /^(?:inherit|initial|unset|revert(?:-layer)?|var\(|env\()/iu.test(source) ? 'rgb(99, 99, 99)' : '';
      return { color: cssColor(source) ?? inherited };
    },
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { href: 'https://project.example.com/dashboard' },
    matchMedia: (query: string) => {
      const matches = query.includes('prefers-color-scheme: dark') ? dark : query.includes('prefers-color-scheme: light') ? !dark : true;
      const media = { listeners: new Set<() => void>(), matches, query };
      mediaQueries.push(media);
      return {
        matches,
        // retain modern media listeners
        addEventListener: (_name: string, callback: () => void) => media.listeners.add(callback),
        // retain legacy media listeners
        addListener: (callback: () => void) => media.listeners.add(callback),
        // remove modern media listeners
        removeEventListener: (_name: string, callback: () => void) => media.listeners.delete(callback),
        // remove legacy media listeners
        removeListener: (callback: () => void) => media.listeners.delete(callback)
      };
    },
    navigator: {},
    parent,
    queueMicrotask: (callback: () => void) => callback()
  };
  runInNewContext(source, { document, MutationObserver, window });
  return {
    messages,
    // dispatch one parent theme request with controlled authority
    requestTheme: (origin: string, trusted = true) => { for (const listener of events.get('message') ?? []) listener({ data: { type: 'rac-browser-theme-request' }, origin, source: trusted ? parent : {} }); },
    // replace metadata and notify the head observer
    replaceMetas: (next: ThemeMeta[]) => { metas = next; for (const observer of observers) observer.notify(head); },
    // replace the HTML background and notify the root observer
    setRootBackground: (color: string) => { rootBackground = color; for (const observer of observers) observer.notify(documentElement); },
    // toggle color scheme and notify changed media listeners
    setDark: (next: boolean) => {
      dark = next;
      // notify only queries whose match state changed
      for (const media of mediaQueries) {
        const matches = media.query.includes('prefers-color-scheme: dark') ? dark : media.query.includes('prefers-color-scheme: light') ? !dark : true;
        // skip stable media queries
        if (matches === media.matches) continue;
        media.matches = matches;
        // notify every retained listener
        for (const listener of [...media.listeners]) listener();
      }
    }
  };
};

afterEach(async () => {
  // close every ephemeral listener
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('project browser proxy', () => {
  // inject before app scripts even when project content mentions or loads the bridge later
  it('does not mistake bridge text or a late script for early injection', () => {
    const bridge = '<script src="/__rac/browser-bridge.js"></script>';
    const mentioned = '<html><head><script>const path="/__rac/browser-bridge.js";</script></head><body>preview</body></html>';
    const late = `<html><head><script src="/app.js"></script>${bridge}</head></html>`;
    expect(injectProjectBrowserBridge(mentioned)).toContain(`<head>${bridge}<script>const path=`);
    expect(injectProjectBrowserBridge(late)).toContain(`<head>${bridge}<script src="/app.js">`);
    const injected = injectProjectBrowserBridge(mentioned);
    expect(injectProjectBrowserBridge(injected)).toBe(injected);
    expect(injectProjectBrowserBridge(bridge + 'preview')).toBe(bridge + 'preview');
  });

  // reject arbitrary upstream destinations
  it('allows only local project gateways', () => {
    expect(() => new ProjectProxy(() => [], 'https://agents.example.com', 'example.com')).toThrow('invalid project proxy host');
  });

  // verify HTML injection and transparent forwarding
  it('injects the navigation bridge and forwards project traffic', async () => {
    const upstream = createServer((request, response) => {
      // echo non-page requests
      if (request.url !== '/') { request.pipe(response); return; }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>Project</title></head><body>Preview</body></html>');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const worktree = testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const projectProxy = new ProjectProxy(() => [worktree], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const page = await request(proxyPort, '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<head><script src="/__rac/browser-bridge.js"></script>');

    const bridge = await request(proxyPort, '/__rac/browser-bridge.js');
    const repeatedBridge = executeBridge(bridge.body);
    const initialMessages = repeatedBridge.messages.length;
    repeatedBridge.executeAgain();
    expect(repeatedBridge.messages).toHaveLength(initialMessages);
    expect(bridge.status).toBe(200);
    expect(bridge.contentType).toContain('text/javascript');
    expect(bridge.body).toContain("wrap('pushState')");
    expect(bridge.body).toContain("type: 'rac-browser-refresh'");
    expect(bridge.body).toContain("window.addEventListener('keydown', refresh)");
    expect(bridge.body).toContain('"https://agents.example.com"');

    const theme = executeThemeBridge(bridge.body, {
      dark: true,
      metas: [
        { name: 'theme-color', content: '#eeeeee', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#102030', media: '(prefers-color-scheme: dark)' },
        { name: 'msapplication-navbutton-color', content: 'navy' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black' }
      ],
      rootBackground: 'rgb(4, 5, 6)'
    });
    expect(theme.messages).toContainEqual({ message: { type: 'rac-browser-theme', color: 'rgb(16, 32, 48)' }, target: 'https://agents.example.com' });
    const reportCount = theme.messages.length;
    theme.replaceMetas([
      { name: 'theme-color', content: 'var(--brand)' },
      { name: 'msapplication-navbutton-color', content: 'navy' }
    ]);
    expect(theme.messages.at(-1)).toEqual({ message: { type: 'rac-browser-theme', color: 'rgb(0, 0, 128)' }, target: 'https://agents.example.com' });
    // fall through transparent metadata to the next visible color
    theme.replaceMetas([
      { name: 'theme-color', content: 'transparent' },
      { name: 'msapplication-navbutton-color', content: 'navy' }
    ]);
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(0, 0, 128)' });
    // preserve the HTML fallback for zero-alpha metadata
    theme.replaceMetas([{ name: 'theme-color', content: 'rgba(4, 5, 6, 0)' }]);
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(4, 5, 6)' });
    theme.replaceMetas([
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }
    ]);
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(0, 0, 0)' });
    theme.replaceMetas([{ name: 'apple-mobile-web-app-status-bar-style', content: 'black' }]);
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(4, 5, 6)' });
    theme.replaceMetas([]);
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(4, 5, 6)' });
    theme.setRootBackground('rgb(7, 8, 9)');
    expect(theme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(7, 8, 9)' });
    const dynamicCount = theme.messages.length;
    theme.setRootBackground('rgb(7, 8, 9)');
    expect(theme.messages).toHaveLength(dynamicCount);
    expect(dynamicCount).toBeGreaterThan(reportCount);

    const mediaTheme = executeThemeBridge(bridge.body, {
      metas: [
        { name: 'theme-color', content: '#eee', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#111', media: '(prefers-color-scheme: dark)' }
      ]
    });
    expect(mediaTheme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(238, 238, 238)' });
    mediaTheme.setDark(true);
    expect(mediaTheme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(17, 17, 17)' });

    const parsedTheme = executeThemeBridge(bridge.body, { rootBackground: 'rgba(4, 5, 6, 0)' });
    expect(parsedTheme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: null });
    parsedTheme.replaceMetas([{ name: 'theme-color', content: 'red' }]);
    expect(parsedTheme.messages.at(-1)?.message).toEqual({ type: 'rac-browser-theme', color: 'rgb(255, 0, 0)' });
    const restoredCount = parsedTheme.messages.length;
    parsedTheme.requestTheme('https://evil.example.com');
    parsedTheme.requestTheme('https://agents.example.com', false);
    expect(parsedTheme.messages).toHaveLength(restoredCount);
    parsedTheme.requestTheme('https://agents.example.com');
    expect(parsedTheme.messages.slice(restoredCount)).toEqual([
      { message: { type: 'rac-browser-location', url: 'https://project.example.com/dashboard' }, target: 'https://agents.example.com' },
      { message: { type: 'rac-browser-theme', color: 'rgb(255, 0, 0)' }, target: 'https://agents.example.com' }
    ]);

    const forwarded = await request(proxyPort, '/echo', { method: 'POST', body: 'retained request body' });
    expect(forwarded.body).toBe('retained request body');
  });

  // require fresh representations without changing write or range preconditions
  it('bypasses read validators while retaining application preconditions', async () => {
    const received: Array<{ method: string | undefined; headers: IncomingHttpHeaders }> = [];
    const upstream = createServer((incoming, response) => {
      received.push({ method: incoming.method, headers: incoming.headers });
      response.setHeader('content-type', 'application/json');
      response.setHeader('etag', '"current"');
      response.end('{"fresh":true}');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const projectProxy = new ProjectProxy(() => [testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort })], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => { projectProxy.handle(incoming, response); });
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const preconditions = { 'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT', 'if-match': '"current"', 'if-unmodified-since': 'Wed, 01 Jan 2025 00:00:00 GMT', 'if-range': '"current"', range: 'bytes=0-9' };

    // bypass cache validation only for reads, not conditional writes
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      const result = await request(proxyPort, '/api/item', { method, headers: { ...preconditions, 'cache-control': 'only-if-cached, max-age=3600' } });
      const forwarded = received.at(-1)?.headers;
      const read = method === 'GET' || method === 'HEAD';
      expect(received.at(-1)?.method).toBe(method);
      expect(forwarded?.['cache-control']).toBe('no-cache, no-store');
      expect(forwarded?.['if-none-match']).toBe(read ? undefined : preconditions['if-none-match']);
      expect(forwarded?.['if-modified-since']).toBe(read ? undefined : preconditions['if-modified-since']);
      expect(forwarded).toMatchObject({ 'if-match': preconditions['if-match'], 'if-unmodified-since': preconditions['if-unmodified-since'], 'if-range': preconditions['if-range'], range: preconditions.range });
      expect(result.headers.etag).toBe('"current"');
    }
  });

  // prevent storage of every managed preview resource and generated response
  it('overrides cacheable documents, assets, data, redirects and errors', async () => {
    const upstream = createServer((incoming, response) => {
      response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      response.setHeader('content-type', incoming.url === '/' ? 'text/html' : 'text/plain');
      // emulate a conditional cache hit that must not reach the project
      if (incoming.headers['if-none-match'] !== undefined || incoming.headers['if-modified-since'] !== undefined) { response.writeHead(304); response.end(); return; }
      // retain upstream redirect semantics
      if (incoming.url === '/redirect') { response.writeHead(302, { location: '/destination' }); response.end(); return; }
      // retain cacheable upstream errors
      if (incoming.url === '/missing') response.statusCode = 404;
      response.end(incoming.url === '/' ? '<html><head></head><body>fresh</body></html>' : 'fresh');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const projectProxy = new ProjectProxy(() => [testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort })], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // leave unmatched hosts outside the preview cache policy
      if (!projectProxy.handle(incoming, response)) { response.writeHead(200, { 'cache-control': 'max-age=60' }); response.end('console'); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    // include generated proxy responses as well as upstream representations
    for (const [path, status] of [['/', 200], ['/app.js', 200], ['/style.css', 200], ['/api/item', 200], ['/redirect', 302], ['/missing', 404], ['/__rac/browser-bridge.js', 200], ['/__rac/browser-device', 400], ['/__rac/browser-device?mode=desktop&location=%2F', 302]] as const) {
      const result = await request(proxyPort, path, { headers: { 'if-none-match': '"old"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' } });
      expect(result.status).toBe(status);
      expect(result.headers['cache-control']).toBe('no-store');
      // still inject the bridge into the fresh document
      if (path === '/') expect(result.body).toContain('<head><script src="/__rac/browser-bridge.js"></script>');
    }
    const consoleResponse = await request(proxyPort, '/', { headers: { host: 'agents.example.com' } });
    expect(consoleResponse.headers['cache-control']).toBe('max-age=60');
  });

  // verify paired viewport identities
  it('applies mobile and desktop identities to project traffic', async () => {
    const receivedHeaders: IncomingHttpHeaders[] = [];
    const upstream = createServer((request, response) => {
      receivedHeaders.push(request.headers);
      response.setHeader('content-type', 'text/plain');
      response.end('profiled');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const worktree = testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const projectProxy = new ProjectProxy(() => [worktree], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const mobileRedirect = await request(proxyPort, '/__rac/browser-device?mode=mobile&location=%2Fdashboard%3Ftab%3Done%23results');
    expect(mobileRedirect.status).toBe(302);
    expect(mobileRedirect.headers.location).toBe('/dashboard?tab=one#results');
    expect(mobileRedirect.headers['set-cookie']).toEqual(['__rac_browser_device=mobile; Path=/; HttpOnly; Secure; SameSite=None; Partitioned']);

    const rejectedDeviceUrls = [
      '/__rac/browser-device',
      '/__rac/browser-device?mode=mobile',
      '/__rac/browser-device?mode=tablet&location=%2F',
      '/__rac/browser-device?mode=mobile&location=https%3A%2F%2Fevil.example',
      '/__rac/browser-device?mode=mobile&location=%2F%2Fevil.example',
      '/__rac/browser-device?mode=mobile&location=%2F%5Cevil.example',
      '/__rac/browser-device?mode=mobile&location=%E0%A4%A'
    ];
    // reject every malformed or cross-origin transition
    for (const path of rejectedDeviceUrls) {
      const rejected = await request(proxyPort, path);
      expect(rejected.status).toBe(400);
      expect(rejected.headers.location).toBeUndefined();
      expect(rejected.headers['set-cookie']).toBeUndefined();
    }

    const mobile = await request(proxyPort, '/dashboard', { headers: { cookie: 'project=value; __rac_browser_device=mobile', 'sec-ch-ua-arch': '"x86"', 'sec-ch-ua-bitness': '"32"', 'sec-ch-ua-form-factors': '"Desktop"', 'sec-ch-ua-model': '"Desktop"', 'sec-ch-ua-platform-version': '"6.0.0"', 'sec-ch-ua-wow64': '?1', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Safari/537.36' } });
    expect(mobile.status).toBe(200);
    expect(receivedHeaders.at(-1)?.['user-agent']).toContain('Chrome/140.1.2.3 Mobile');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-mobile']).toBe('?1');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-arch']).toBe('"arm"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-form-factors']).toBe('"Mobile"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform']).toBe('"Android"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform-version']).toBe('"10.0.0"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-model']).toBe('""');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-wow64']).toBe('?0');
    expect(receivedHeaders.at(-1)?.cookie).toBe('project=value');

    await request(proxyPort, '/dashboard', { headers: { cookie: '__rac_browser_device=desktop', 'sec-ch-ua-arch': '"arm"', 'sec-ch-ua-form-factors': '"Mobile"', 'sec-ch-ua-model': '"Pixel 9"', 'sec-ch-ua-platform-version': '"15.0.0"', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Mobile Safari/537.36' } });
    expect(receivedHeaders.at(-1)?.['user-agent']).toContain('X11; Linux x86_64');
    expect(receivedHeaders.at(-1)?.['user-agent']).not.toContain(' Mobile ');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-mobile']).toBe('?0');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-arch']).toBe('"x86"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-form-factors']).toBe('"Desktop"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-model']).toBe('""');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform']).toBe('"Linux"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform-version']).toBe('"6.0.0"');

    const desktopBridge = await request(proxyPort, '/__rac/browser-bridge.js', { headers: { cookie: '__rac_browser_device=desktop', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Mobile Safari/537.36' } });
    const executed = executeBridge(desktopBridge.body);
    expect(executed.navigator.userAgent).toContain('X11; Linux x86_64');
    expect(executed.navigator.userAgent).not.toContain(' Mobile ');
    expect(executed.navigator.appVersion).toContain('X11; Linux x86_64');
    expect(executed.navigator.appVersion).not.toContain('Android');
    expect(executed.navigator.platform).toBe('Linux x86_64');
    expect(executed.navigator.userAgentData.mobile).toBe(false);
    expect(executed.navigator.userAgentData.platform).toBe('Linux');
    expect(executed.navigator.userAgentData.toJSON()).toMatchObject({ mobile: false, platform: 'Linux' });
    await expect(executed.navigator.userAgentData.getHighEntropyValues(['architecture', 'formFactors', 'model', 'platformVersion'])).resolves.toMatchObject({ architecture: 'x86', formFactors: ['Desktop'], mobile: false, model: '', platform: 'Linux', platformVersion: '6.0.0' });

    const failed = executeBridge(desktopBridge.body, true);
    expect(failed.messages).toContainEqual({ type: 'rac-browser-device-error', properties: ['userAgent'] });
  });

  // preserve shared previews when worktrees inherit the same project default
  it('serves one Project preview from the Worktree records of concurrently running branches', async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('whichever stack bound the port');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const main = testWorktree({ projectId: 'proj', path: '/worktrees/main', projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const branch = testWorktree({ projectId: 'proj', path: '/worktrees/branch', main: false, branch: 'feature', projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    // a direct external preview has no loopback proxy target
    const external = testWorktree({ projectId: 'other', path: '/worktrees/other', projectUrl: 'https://other.example.com' });
    let records = [main, branch, external];
    const projectProxy = new ProjectProxy(() => records, 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    // both Worktrees resolve the Project's one preview target
    expect((await request(proxyPort, '/')).body).toBe('whichever stack bound the port');
    expect((await request(proxyPort, '/', { headers: { host: 'other.example.com' } })).status).toBe(404);

    // a same-length snapshot replacement that only moves the port is picked up —
    // the memoization keys on snapshot identity, never on shape
    const moved = createServer((_request, response) => { response.setHeader('content-type', 'text/plain'); response.end('the moved stack'); });
    servers.push(moved);
    const movedPort = await listen(moved);
    records = records.map(record => ({ ...record, projectPort: record.projectPort === undefined ? undefined : movedPort }));
    expect((await request(proxyPort, '/')).body).toBe('the moved stack');

    // discovery replacing its snapshot (Worktrees removed, Project unavailable) is
    // picked up without rebuilding the proxy
    records = [];
    expect((await request(proxyPort, '/')).status).toBe(404);
  });

  // route sibling checkout hostnames to their own loopback ports
  it('serves independent previews for worktrees in one project', async () => {
    // identify the main upstream
    const main = createServer((_incoming, response) => { response.end('main stack'); });
    // identify the sibling upstream
    const feature = createServer((_incoming, response) => { response.end('feature stack'); });
    servers.push(main, feature);
    const mainPort = await listen(main);
    const featurePort = await listen(feature);
    let records = [
      testWorktree({ path: '/repo', projectUrl: 'https://main.example.com', projectPort: mainPort }),
      testWorktree({ path: '/repo-feature', projectUrl: 'https://feature.example.com', projectPort: featurePort }),
      testWorktree({ path: '/repo-readonly' })
    ];
    const projectProxy = new ProjectProxy(() => records, 'https://agents.example.com');
    // expose only configured preview hosts
    const proxy = createServer((incoming, response) => {
      // reject disabled and unconfigured previews
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    expect((await request(proxyPort, '/', { headers: { host: 'main.example.com' } })).body).toBe('main stack');
    expect((await request(proxyPort, '/', { headers: { host: 'feature.example.com' } })).body).toBe('feature stack');
    expect((await request(proxyPort, '/', { headers: { host: 'readonly.example.com' } })).status).toBe(404);
    records = [records[0]!];
    expect((await request(proxyPort, '/', { headers: { host: 'feature.example.com' } })).status).toBe(404);
    expect((await request(proxyPort, '/', { headers: { host: 'main.example.com' } })).body).toBe('main stack');
  });
});
