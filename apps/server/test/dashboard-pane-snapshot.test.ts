import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { DashboardUpdates, type DashboardPayload } from '../src/dashboard/updates.js';
import { testConfig, testWorktree } from './helpers/config.js';

// exercise the production dashboard loader and shutdown hook together
describe('dashboard pane snapshot wiring', () => {
  it('hands the fresh scan to stack display and closes command connections', async () => {
    const worktree = testWorktree();
    const snapshots = new Map([['/fixture/socket', { status: 'available' as const, panes: [] }]]);
    const dashboardUpdates = new DashboardUpdates<DashboardPayload>();
    const discovery = {
      worktreesNow: () => [worktree],
      dashboard: vi.fn(async () => ({ generation: 1, serverStartedAt: 0, places: [], adapters: {}, projects: [], agents: [] }))
    };
    const tmux = { paneSnapshotsNow: vi.fn(() => snapshots), closeCommands: vi.fn() };
    const worktreeCommands = { actions: () => [], state: vi.fn(async () => ({})) };
    const app = await buildApp(testConfig(), {
      auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 36).toString('base64url')),
      discovery: discovery as never,
      tmux: tmux as never,
      worktreeCommands: worktreeCommands as never,
      launch: { launchResolutions: async () => new Map() } as never,
      dashboardUpdates,
      reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never
    });
    try {
      await dashboardUpdates.refresh();
      expect(discovery.dashboard).toHaveBeenCalledWith(false, true, expect.any(Object));
      expect(worktreeCommands.state).toHaveBeenCalledWith(worktree, snapshots);
      expect(tmux.closeCommands).not.toHaveBeenCalled();
    } finally { await app.close(); }
    expect(tmux.closeCommands).toHaveBeenCalledOnce();
  });
});
