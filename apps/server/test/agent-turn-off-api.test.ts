import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testWorktree } from './helpers/config.js';

// cover both shutdown routes behind chunked tunnel framing
describe('agent turn-off transport', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // release each isolated application
  afterEach(async () => { await app?.close(); });

  // preserve shutdown behavior with explicit empty json bodies
  it.each([
    { method: 'POST' as const, url: '/api/agents/agent-1/deactivate', configured: true },
    { method: 'DELETE' as const, url: '/api/agents/agent-1', configured: false }
  ])('accepts $method $url with chunked JSON framing', async ({ method, url, configured }) => {
    const worktree = testWorktree({ id: 'cora', path: '/worktrees/cora' });
    const agent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: worktree.path, title: 'Ready', ...(configured ? { worktreeId: worktree.id } : {}) });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    // isolate discovery from real agent sessions
    const discovery = {
      // configure only the worktree deactivation case
      worktreesNow: () => configured ? [worktree] : [],
      // resolve only the synthetic target
      target: async (id: string) => id === agent.id ? { agent, socket } : undefined
    };
    // observe shutdown without touching tmux
    const close = vi.fn(async () => true);
    app = await buildApp(testConfig(), { auth: await testAuthService(), discovery: discovery as never, tmux: { close } as never });
    const framing: Array<{ transferEncoding?: string; contentLength?: string }> = [];
    // verify the parser receives tunnel-style framing
    app.addHook('onRequest', async request => {
      // exclude authentication requests
      if (request.url !== url) return;
      framing.push({ transferEncoding: request.headers['transfer-encoding'], contentLength: request.headers['content-length'] });
    });
    const headers = { ...await authenticatedHeaders(app), 'transfer-encoding': 'chunked' };

    // stream json so injection does not synthesize a content-length header
    const response = await app.inject({ method, url, headers: { ...headers, 'content-type': 'application/json' }, payload: Readable.from(['{}']) });
    expect(framing).toEqual([{ transferEncoding: 'chunked', contentLength: undefined }]);
    expect(response.statusCode).toBe(204);
    expect(close).toHaveBeenCalledExactlyOnceWith(socket, agent.pane.paneId);
  }, 15_000);
});
