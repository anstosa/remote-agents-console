import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

// a tmux picker opened on an Agent's pane (a `session-closed` → `choose-tree` hook) swallows
// every prompt and keystroke; the panel's notice leaves it through this route
describe('leave pane mode API', () => {
  it('leaves the mode on the Agent\'s own pane, refreshes the dashboard, and refuses unauthorized or unknown targets', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const exitPaneMode = vi.fn(async () => true);
    const refresh = vi.fn(async () => ({}));
    const app = await buildApp(testConfig(), {
      auth: await testAuthService(),
      tmux: { exitPaneMode } as never,
      dashboardUpdates: { refresh, setLoader: () => {}, subscribe: () => () => {}, close: () => {} } as never,
      discovery: {
        target: async (id: string) => id === 'agent-1' ? { agent: { id: 'agent-1', pane: { paneId: '%7' } }, socket } : undefined,
        worktreesNow: () => [],
        dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] })
      } as never
    });
    try {
      const url = '/api/agents/agent-1/pane-mode/exit';
      const unauthenticated = await app.inject({ method: 'POST', url, headers: { host: testHost } });
      expect(unauthenticated.statusCode).not.toBe(204);
      const headers = await authenticatedHeaders(app);
      const missingCsrf = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf-token': '' } });
      expect(missingCsrf.statusCode).toBe(403);
      expect(exitPaneMode).not.toHaveBeenCalled();

      const left = await app.inject({ method: 'POST', url, headers });
      expect(left.statusCode).toBe(204);
      expect(exitPaneMode).toHaveBeenCalledWith(socket, '%7');
      // the notice clears on the pushed snapshot rather than waiting for the next poll
      expect(refresh).toHaveBeenCalled();

      const unknown = await app.inject({ method: 'POST', url: '/api/agents/agent-2/pane-mode/exit', headers });
      expect(unknown.statusCode).toBe(404);
      exitPaneMode.mockResolvedValueOnce(false);
      const failed = await app.inject({ method: 'POST', url, headers });
      expect(failed.statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
