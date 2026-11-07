import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = { name: 'Static caching fixture', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };
const host = 'agents.example.com';

// reads the built web app, like the app.test.ts bundle check
describe('static file caching', () => {
  it('caches hashed assets forever, revalidates other static files, and never stores the rest', async () => {
    const app = await buildApp(config, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      const bundle = String((await app.inject({ method: 'GET', url: '/api/ui-version', headers: { host } })).json().version);
      const asset = await app.inject({ method: 'GET', url: `${bundle}?v=1`, headers: { host, 'accept-encoding': 'gzip, deflate, br' } });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers).toMatchObject({ 'cache-control': 'public, max-age=31536000, immutable', 'content-encoding': 'br', 'content-type': 'application/javascript; charset=utf-8', vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff' });

      const worker = await app.inject({ method: 'GET', url: '/sw.js', headers: { host } });
      expect(worker.statusCode).toBe(200);
      expect(worker.headers['cache-control']).toBe('no-cache');
      expect(worker.headers.etag).toBeDefined();
      const revalidated = await app.inject({ method: 'GET', url: '/sw.js', headers: { host, 'if-none-match': String(worker.headers.etag) } });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.headers['cache-control']).toBe('no-cache');

      for (const url of ['/', '/api/auth/bootstrap', '/assets/missing-Abc_123.js']) {
        const response = await app.inject({ method: 'GET', url, headers: { host } });
        expect(response.headers['cache-control'], url).toBe('no-store');
      }
    } finally {
      await app.close();
    }
  });
});
