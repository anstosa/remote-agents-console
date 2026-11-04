import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LaunchOptionsContext } from '../src/launch/options.js';
import * as nativeCatalog from '../src/launch/omx-catalog.js';
import * as command from '../src/tmux/command.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

// restore bridge and command seams after the authenticated server fixture
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('unavailable launch HOME API', () => {
  // keep read APIs available while target metadata refuses repository-derived account guesses
  it('boots with null HOME and resolves a worktree without native discovery or tmux spawn', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    vi.stubEnv('HOME', '/container/root');
    const run = vi.spyOn(command, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const codexProbe = vi.spyOn(nativeCatalog, 'probeCodexCatalog');
    const project = testProject({
      id: 'proj',
      path: '/container/project',
      identity: '/container/project/.git',
      hostPath: '/srv/repositories/project'
    });
    const worktree = testWorktree({
      id: 'proj:main',
      projectId: project.id,
      path: '/container/project',
      identity: '/container/project',
      hostPath: '/srv/repositories/project'
    });
    const config = testConfig({
      launchHome: null,
      projects: [project],
      adapters: {
        codex: { program: '/host/bin/codex', args: ['--profile', 'team'], env: {}, launchable: true },
        pi: { program: process.execPath, args: [], env: { HOME: '/explicit/pi' }, launchable: true, sandbox: { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], env: [] } }
      }
    });
    const contexts: LaunchOptionsContext[] = [];
    const close = vi.fn(async () => true);
    const add = vi.fn();
    const agent = {
      id: 'agent-1',
      kind: 'codex',
      home: worktree.identity,
      projectId: project.id,
      worktreeId: worktree.id,
      title: 'Ready',
      attention: 'finished'
    };
    const launchOptions = {
      // record only server-resolved target metadata
      list: vi.fn(async (context: LaunchOptionsContext) => { contexts.push(context); return { kinds: [] }; })
    };
    const discovery = {
      worktreesNow: () => [worktree],
      projectsNow: () => [project],
      dashboard: vi.fn(async () => ({ agents: [agent] })),
      useStructuredAgents: () => undefined
    };
    const dashboardUpdates = {
      setLoader: vi.fn(),
      refresh: vi.fn(async () => ({ ok: true })),
      close: vi.fn()
    };
    const settingsSnapshot = { version: 1, revisionId: 'home-unavailable', sources: [], status: { pending: false, targets: [], effective: 'running', restartAvailable: false } };
    const settings = { snapshot: vi.fn(async () => settingsSnapshot) };
    const app = await buildApp(config, {
      auth: await testAuthService(),
      discovery: discovery as never,
      dashboardUpdates: dashboardUpdates as never,
      launchOptions: launchOptions as never,
      prompts: { close } as never,
      worktreeManagement: { add } as never,
      settings: settings as never
    });
    try {
      const headers = await authenticatedHeaders(app);
      const readHeaders = { host: headers.host, cookie: headers.cookie };
      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: readHeaders });
      const settingsResponse = await app.inject({ method: 'GET', url: '/api/settings', headers: readHeaders });
      const options = await app.inject({
        method: 'POST',
        url: '/api/launch/options',
        headers,
        payload: { type: 'worktree', id: worktree.id }
      });
      const restart = await app.inject({
        method: 'POST',
        url: `/api/agents/${agent.id}/restart`,
        headers,
        payload: { kind: 'codex' }
      });
      const addWorktree = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/worktrees`,
        headers,
        payload: { mode: 'new', branch: 'test/no-home', open: 'agent', choice: { kind: 'codex' } }
      });

      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toEqual({ ok: true });
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toEqual(settingsSnapshot);
      expect(options.statusCode).toBe(200);
      expect(options.json()).toEqual({ kinds: [] });
      expect(restart.statusCode).toBe(409);
      expect(restart.json()).toEqual({ error: 'launch_home_unavailable' });
      expect(addWorktree.statusCode).toBe(409);
      expect(addWorktree.json()).toEqual({ error: 'launch_home_unavailable' });
      expect(contexts).toEqual([{
        cwd: '/container/project',
        hostCwd: '/srv/repositories/project',
        home: undefined
      }]);
      expect(config.adapters.pi?.env.HOME).toBe('/explicit/pi');
      expect(close).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(codexProbe).not.toHaveBeenCalled();
      expect(run.mock.calls.filter(call => (call[1] as string[]).some(argument => ['new-session', 'new-window', 'respawn-pane', 'run-shell'].includes(argument)))).toEqual([]);
    } finally {
      await app.close();
    }
  }, 15_000);
});
