import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as sendRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { TemporaryPreviewService } from '../src/temporary-previews/service.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

const servers: Server[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

// listen on one ephemeral loopback port
const listen = async (server: Server) => await new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    // require a TCP listener
    if (address === null || typeof address === 'string') { reject(new Error('missing listener')); return; }
    resolve(address.port);
  });
});

// send one host-routed request
const request = async (port: number, path: string, headers: IncomingHttpHeaders = {}) => await new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
  const outgoing = sendRequest({ hostname: '127.0.0.1', port, path, headers: { host: testHost, ...headers } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
  });
  outgoing.once('error', reject);
  outgoing.end();
});

// close every test listener
afterEach(async () => {
  // close RAC applications first
  for (const app of apps.splice(0)) await app.close();
  // close preview origins second
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  // remove temporary registration stores
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('temporary preview registrations', () => {
  // retain only valid and unexpired registrations
  it('resolves a bounded loopback target and removes an expired entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-temporary-previews-'));
    directories.push(directory);
    const current = Date.parse('2026-09-07T17:00:00.000Z');
    const activeToken = 'A'.repeat(32);
    const expiredToken = 'B'.repeat(32);
    const futureToken = 'F'.repeat(32);
    await writeFile(join(directory, `${activeToken}.json`), JSON.stringify({ version: 1, port: 8899, createdAt: '2026-09-07T16:00:00.000Z', expiresAt: '2026-09-07T18:00:00.000Z' }), { mode: 0o600 });
    await writeFile(join(directory, `${expiredToken}.json`), JSON.stringify({ version: 1, port: 8900, createdAt: '2026-09-07T15:00:00.000Z', expiresAt: '2026-09-07T16:00:00.000Z' }), { mode: 0o600 });
    await writeFile(join(directory, `${futureToken}.json`), JSON.stringify({ version: 1, port: 8901, createdAt: '2027-09-07T15:00:00.000Z', expiresAt: '2027-09-07T16:00:00.000Z' }), { mode: 0o600 });
    const previews = new TemporaryPreviewService(directory, () => current);

    await expect(previews.resolve(activeToken)).resolves.toEqual({ port: 8899, createdAt: '2026-09-07T16:00:00.000Z', expiresAt: '2026-09-07T18:00:00.000Z' });
    await expect(previews.resolve(expiredToken)).resolves.toBeUndefined();
    await expect(previews.resolve(futureToken)).resolves.toBeUndefined();
    await expect(previews.resolve('../outside')).resolves.toBeUndefined();
    await expect(readFile(join(directory, `${expiredToken}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('authenticated temporary preview proxy', () => {
  // proxy registered content without exposing RAC credentials
  it('requires login, grants scoped asset access, and isolates preview responses', async () => {
    const upstreamRequests: Array<{ authorization?: string; cookie?: string; csrf?: string; host?: string; url?: string }> = [];
    const upstream = createServer((incoming, response) => {
      upstreamRequests.push({ authorization: incoming.headers.authorization, cookie: incoming.headers.cookie, csrf: incoming.headers['x-csrf-token'] as string | undefined, host: incoming.headers.host, url: incoming.url });
      // exercise redirect rewriting
      if (incoming.url === '/redirect') {
        response.writeHead(302, { location: '/download' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'unsafe=preview; Path=/', 'clear-site-data': '"cookies"', 'content-disposition': 'inline; filename="preview.html"' });
      response.end('<!doctype html><title>Temporary result</title>');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const token = 'C'.repeat(32);
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const temporaryPreviews = { resolve: async (candidate: string) => candidate === token ? { port: upstreamPort, createdAt: new Date().toISOString(), expiresAt } : undefined };
    const app = await buildApp(testConfig(), { auth: await testAuthService(), temporaryPreviews });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    // require the live RAC listener
    if (address === null || typeof address === 'string') throw new Error('missing RAC listener');

    const denied = await request(address.port, `/preview/${token}/`);
    expect(denied.status).toBe(401);
    expect(upstreamRequests).toEqual([]);

    const authenticated = await authenticatedHeaders(app);
    const page = await request(address.port, `/preview/${token}/result?mode=full`, { cookie: authenticated.cookie, authorization: 'Bearer rac-secret', 'x-csrf-token': authenticated['x-csrf-token'] });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Temporary result</title>');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.headers['x-frame-options']).toBe('DENY');
    // keep temporary content outside the managed permission bridge
    expect(page.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()');
    expect(page.headers['clear-site-data']).toBeUndefined();
    expect(page.headers['content-disposition']).toBe('inline; filename="preview.html"');
    const setCookies = Array.isArray(page.headers['set-cookie']) ? page.headers['set-cookie'] : [page.headers['set-cookie']];
    const grant = setCookies.find(value => value?.startsWith('rac-preview='));
    expect(grant).toContain(`Path=/preview/${token}/`);
    expect(setCookies.join(';')).not.toContain('unsafe=preview');
    expect(upstreamRequests).toEqual([{ authorization: undefined, cookie: undefined, csrf: undefined, host: `127.0.0.1:${upstreamPort}`, url: '/result?mode=full' }]);

    // require the scoped grant before the asset request
    if (grant === undefined) throw new Error('missing preview grant');
    const grantCookie = grant.split(';')[0];
    const asset = await request(address.port, `/preview/${token}/asset.css`, { cookie: grantCookie });
    expect(asset.status).toBe(200);
    const racApi = await request(address.port, '/api/auth/session', { cookie: grantCookie });
    expect(racApi.status).toBe(401);

    const redirected = await request(address.port, `/preview/${token}/redirect`, { cookie: grantCookie });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.location).toBe(`/preview/${token}/download`);

    const missing = await request(address.port, `/preview/${'D'.repeat(32)}/`, { cookie: authenticated.cookie });
    expect(missing.status).toBe(404);
  }, 15_000);
});
