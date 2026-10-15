import { expect, test } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ProjectProxy } from '../../server/src/project-proxy.js';

type ManagedMessage = { api: string; asset: string; document: string; kind: string };
type RecordedRequest = { cacheControl: string | undefined; ifModifiedSince: string | undefined; ifNoneMatch: string | undefined; path: string };

const servers: Server[] = [];

// listen on an ephemeral loopback port
const listen = async (server: Server) => await new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    // reject unexpected non-tcp listeners
    if (address === null || typeof address === 'string') { reject(new Error('missing listener')); return; }
    resolve(address.port);
  });
});

// close one fixture listener without retaining sockets
const close = async (server: Server) => await new Promise<void>((resolve, reject) => {
  server.close(error => error === undefined ? resolve() : reject(error));
  server.closeAllConnections();
});

// write one cacheable fixture response
const cacheable = (response: ServerResponse, contentType: string, body: string) => {
  response.writeHead(200, {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': contentType,
    etag: '"fixture-v1"'
  });
  response.end(body);
};

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

// use real HTTP fixtures because request interception would disable browser caching
test('loads fresh managed documents, scripts and data with browser caching enabled', async ({ page }) => {
  const state = {
    controlRequests: 0,
    managedRequests: { api: 0, asset: 0, document: 0 },
    recordedRequests: [] as RecordedRequest[],
    version: 1
  };

  const upstream = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://upstream.invalid').pathname;
    state.recordedRequests.push({
      cacheControl: request.headers['cache-control'],
      ifModifiedSince: request.headers['if-modified-since'],
      ifNoneMatch: request.headers['if-none-match'],
      path
    });
    // serve one cacheable document
    if (path === '/document') {
      state.managedRequests.document += 1;
      cacheable(response, 'text/html; charset=utf-8', `<!doctype html><html data-version="v${state.version}"><head><script src="/asset.js"></script><script>window.addEventListener('load', async () => { const api = await fetch('/api').then(response => response.text()); window.parent.postMessage({ kind: 'managed-cache-fixture', document: document.documentElement.dataset.version, asset: window.assetVersion, api }, '*'); });</script></head><body>fixture</body></html>`);
      return;
    }
    // serve one cacheable script
    if (path === '/asset.js') {
      state.managedRequests.asset += 1;
      cacheable(response, 'text/javascript; charset=utf-8', `window.assetVersion = 'v${state.version}';`);
      return;
    }
    // serve one cacheable fetch result
    if (path === '/api') {
      state.managedRequests.api += 1;
      cacheable(response, 'text/plain; charset=utf-8', `v${state.version}`);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);

  let proxyPort = 0;
  const parent = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://parent.invalid').pathname;
    // serve one nonproxied cache control
    if (path === '/control') {
      state.controlRequests += 1;
      cacheable(response, 'text/plain; charset=utf-8', `v${state.version}`);
      return;
    }
    // serve the iframe host page without caching it
    if (path === '/') {
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body><script>window.managedMessages = []; window.addEventListener('message', event => { if (event.data?.kind === 'managed-cache-fixture') window.managedMessages.push(event.data); }); window.recreateManaged = () => { document.querySelector('iframe')?.remove(); const iframe = document.createElement('iframe'); iframe.src = 'http://127.0.0.1:${proxyPort}/document'; document.body.append(iframe); };</script><iframe src="http://127.0.0.1:${proxyPort}/document"></iframe></body></html>`);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(parent);
  const parentPort = await listen(parent);

  const projectProxy = new ProjectProxy(
    () => [{ projectPort: upstreamPort, projectUrl: `http://127.0.0.1:${proxyPort}` }],
    `http://127.0.0.1:${parentPort}`
  );
  const proxy = createServer((request: IncomingMessage, response: ServerResponse) => {
    // reject fixture requests outside the managed host
    if (!projectProxy.handle(request, response)) response.writeHead(404).end();
  });
  servers.push(proxy);
  proxyPort = await listen(proxy);

  const observedResponses: Array<{ cacheControl: string | undefined; path: string; status: number }> = [];
  page.on('response', response => {
    const url = new URL(response.url());
    // record only proxied upstream resources
    if (url.port !== String(proxyPort) || !['/document', '/asset.js', '/api'].includes(url.pathname)) return;
    observedResponses.push({ cacheControl: response.headers()['cache-control'], path: url.pathname, status: response.status() });
  });

  await page.goto(`http://127.0.0.1:${parentPort}/`);
  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { managedMessages: ManagedMessage[] }).managedMessages.length)).toBe(1);

  const directFirst = await page.evaluate(async () => await (await fetch('/control')).text());
  state.version = 2;
  const directSecond = await page.evaluate(async () => await (await fetch('/control')).text());
  expect({ directFirst, directSecond, requests: state.controlRequests }).toEqual({ directFirst: 'v1', directSecond: 'v1', requests: 1 });

  await page.evaluate(() => (window as typeof window & { recreateManaged: () => void }).recreateManaged());
  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { managedMessages: ManagedMessage[] }).managedMessages.length)).toBe(2);

  const managedMessages = await page.evaluate(() => (window as typeof window & { managedMessages: ManagedMessage[] }).managedMessages);
  expect(managedMessages).toEqual([
    { api: 'v1', asset: 'v1', document: 'v1', kind: 'managed-cache-fixture' },
    { api: 'v2', asset: 'v2', document: 'v2', kind: 'managed-cache-fixture' }
  ]);
  expect(state.managedRequests).toEqual({ api: 2, asset: 2, document: 2 });
  expect(state.recordedRequests).toHaveLength(6);
  expect(state.recordedRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ cacheControl: 'no-cache, no-store', ifModifiedSince: undefined, ifNoneMatch: undefined, path: '/document' }),
    expect.objectContaining({ cacheControl: 'no-cache, no-store', ifModifiedSince: undefined, ifNoneMatch: undefined, path: '/asset.js' }),
    expect.objectContaining({ cacheControl: 'no-cache, no-store', ifModifiedSince: undefined, ifNoneMatch: undefined, path: '/api' })
  ]));
  expect(observedResponses).toHaveLength(6);
  expect(observedResponses.every(response => response.cacheControl === 'no-store' && response.status === 200)).toBe(true);
});
