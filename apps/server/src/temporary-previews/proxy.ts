import { request as sendHttpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TemporaryPreviewTarget } from './service.js';

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const privateRequestHeaders = new Set(['authorization', 'cookie', 'origin', 'referer', 'x-csrf-token']);
const privateResponseHeaders = new Set(['clear-site-data', 'content-security-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'set-cookie', 'x-frame-options']);
const upstreamTimeoutMs = 30_000;
const previewSandbox = 'sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts';

// forward only non-credential request headers
const upstreamHeaders = (headers: IncomingHttpHeaders, port: number) => {
  const forwarded: IncomingHttpHeaders = {};
  // retain safe end-to-end headers
  for (const [name, value] of Object.entries(headers)) {
    // strip transport and RAC credential headers
    if (hopByHopHeaders.has(name) || privateRequestHeaders.has(name) || name === 'host') continue;
    forwarded[name] = value;
  }
  forwarded.host = `127.0.0.1:${port}`;
  return forwarded;
};

// isolate one temporary response from the RAC origin
const downstreamHeaders = (headers: IncomingHttpHeaders, accessCookie: string | undefined) => {
  const forwarded: IncomingHttpHeaders = {};
  // retain safe end-to-end headers
  for (const [name, value] of Object.entries(headers)) {
    // strip transport and origin-mutating headers
    if (hopByHopHeaders.has(name) || privateResponseHeaders.has(name)) continue;
    forwarded[name] = value;
  }
  forwarded['cache-control'] = 'no-store';
  forwarded['content-security-policy'] = previewSandbox;
  forwarded['cross-origin-opener-policy'] = 'same-origin';
  forwarded['cross-origin-resource-policy'] = 'cross-origin';
  forwarded['permissions-policy'] = 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()';
  forwarded['referrer-policy'] = 'no-referrer';
  forwarded['x-content-type-options'] = 'nosniff';
  forwarded['x-frame-options'] = 'DENY';
  forwarded['x-robots-tag'] = 'noindex, nofollow, noarchive';
  // grant sandboxed subresources access only to this preview path
  if (accessCookie !== undefined) forwarded['set-cookie'] = [accessCookie];
  return forwarded;
};

// keep loopback redirects inside one preview prefix
const previewLocation = (value: string | undefined, prefix: string, port: number) => {
  // preserve absent locations unchanged
  if (typeof value !== 'string') return value;
  // prefix origin-relative redirects
  if (value.startsWith('/') && !value.startsWith('//')) return `${prefix}${value}`;
  let location: URL;
  // preserve relative and malformed redirects
  try { location = new URL(value); }
  catch { return value; }
  const loopback = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]';
  // preserve external redirects
  if (!loopback || Number(location.port || 80) !== port) return value;
  return `${prefix}${location.pathname}${location.search}${location.hash}`;
};

export class TemporaryPreviewProxy {
  // proxy one authenticated preview request to loopback
  handle(request: IncomingMessage, response: ServerResponse, target: TemporaryPreviewTarget, upstreamPath: string, prefix: string, accessCookie?: string): void {
    const upstream = sendHttpRequest({ hostname: '127.0.0.1', port: target.port, method: request.method, path: upstreamPath, headers: upstreamHeaders(request.headers, target.port) }, upstreamResponse => {
      const headers = downstreamHeaders(upstreamResponse.headers, accessCookie);
      const location = previewLocation(upstreamResponse.headers.location, prefix, target.port);
      // rewrite only present redirects
      if (location !== undefined) headers.location = location;
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      // bound stalled response bodies
      upstreamResponse.setTimeout(upstreamTimeoutMs, () => upstreamResponse.destroy(new Error('temporary preview timed out')));
      upstreamResponse.once('error', () => response.destroy());
    });
    // bound connection and response-header waits
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('temporary preview timed out')));
    response.once('close', () => upstream.destroy());
    // return one generic gateway failure
    upstream.once('error', () => {
      // avoid writing after an upstream response began
      if (response.headersSent) { response.destroy(); return; }
      const headers = downstreamHeaders({}, accessCookie);
      headers['content-type'] = 'text/plain; charset=utf-8';
      response.writeHead(502, headers);
      response.end('temporary preview unavailable');
    });
    request.pipe(upstream);
  }
}
