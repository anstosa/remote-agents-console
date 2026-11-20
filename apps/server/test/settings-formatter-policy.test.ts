import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = { name: 'Formatter policy fixture', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };

describe('settings formatter content security policy', () => {
  // grant WebAssembly to the isolated worker without allowing JavaScript evaluation
  it('limits WebAssembly compilation to the formatter and highlight worker entries', async () => {
    const app = await buildApp(config, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      for (const url of ['/assets/shell-format-worker-Abc_123.js?v=1', '/assets/diff-highlight-worker-Abc_123.js']) {
        const worker = await app.inject({ method: 'GET', url, headers: { host: 'agents.example.com' } });
        const workerPolicy = String(worker.headers['content-security-policy']);
        expect(workerPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(workerPolicy).not.toContain("'unsafe-eval'");
      }
      // retain the strict page, API, asset, and sandbox policies
      for (const url of ['/', '/api/auth/bootstrap', '/assets/index-Abc_123.js', '/assets/other-shell-format-worker-Abc_123.js', '/assets/shell-format-worker-Abc_123.js/extra', '/assets/other-diff-highlight-worker-Abc_123.js', '/favicon.svg']) {
        const response = await app.inject({ method: 'GET', url, headers: { host: 'agents.example.com' } });
        expect(response.headers['content-security-policy']).not.toContain("'wasm-unsafe-eval'");
        expect(response.headers['content-security-policy']).not.toContain("'unsafe-eval'");
      }
    } finally {
      await app.close();
    }
  });
});
