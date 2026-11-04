import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { PiUpdatePromptCoordinatorLike } from '../src/agent-updates/pi-update-prompt.js';
import type { Agent } from '../src/domain/models.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

describe('Pi update prompt API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // close each isolated HTTP server
  afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('requires authentication and CSRF before submitting one closed prompt request', async () => {
    const submit = vi.fn<PiUpdatePromptCoordinatorLike['submit']>(async () => ({ outcome: 'submitted', agentId: 'agent-1', worktreeId: 'proj:/repo' }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), piUpdatePrompts: { submit } });
    const payload = { requestId: 'pi-update-request-1', currentVersion: '1.4.0', targetVersion: '1.5.0' };
    const denied = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers: { host: testHost, origin: 'https://agents.example.com' }, payload });
    const headers = await authenticatedHeaders(app);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers: { host: headers.host, cookie: headers.cookie, origin: headers.origin }, payload });
    const submitted = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload });
    expect(denied.statusCode).toBe(401);
    expect(noCsrf.statusCode).toBe(403);
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toEqual({ agentId: 'agent-1', worktreeId: 'proj:/repo' });
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.any(String), payload);
  }, 15_000);

  it('rejects hidden input and maps stale, unavailable and failed outcomes', async () => {
    const submit = vi.fn<PiUpdatePromptCoordinatorLike['submit']>();
    app = await buildApp(testConfig(), { auth: await testAuthService(), piUpdatePrompts: { submit } });
    const headers = await authenticatedHeaders(app);
    const base = { requestId: 'pi-update-request-1', currentVersion: '1.4.0', targetVersion: '1.5.0' };
    const invalid = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload: { ...base, command: 'pnpm add pi' } });
    expect(invalid.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();

    submit.mockResolvedValueOnce({ outcome: 'stale', error: 'stale' });
    submit.mockResolvedValueOnce({ outcome: 'unavailable', error: 'unavailable' });
    submit.mockResolvedValueOnce({ outcome: 'failed', error: 'failed' });
    const stale = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload: base });
    const unavailable = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload: { ...base, requestId: 'pi-update-request-2' } });
    const failed = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload: { ...base, requestId: 'pi-update-request-3' } });
    expect([stale.statusCode, unavailable.statusCode, failed.statusCode]).toEqual([409, 503, 502]);
    expect([stale.json(), unavailable.json(), failed.json()]).toEqual([{ error: 'stale' }, { error: 'unavailable' }, { error: 'failed' }]);
  }, 15_000);

  it('wires the default coordinator to the exact bridged RAC Agent without invoking update engines', async () => {
    vi.stubEnv('RAC_SERVER_CHECKOUT', '/workspace');
    vi.stubEnv('RAC_HOST_REPOSITORY', '/host/rac');
    const worktree = testWorktree({ id: 'rac:/workspace', projectId: 'rac', identity: '/workspace', hostPath: '/host/rac' });
    const target: Agent = { id: 'rac-agent', transport: 'tmux', panel: 'terminal', home: '/workspace', title: 'Ready', kind: 'codex', attention: 'finished', worktreeId: worktree.id };
    const unrelated: Agent = { ...target, id: 'other-agent', home: '/other', worktreeId: 'other:/other' };
    const discovery = {
      worktreesNow: () => [worktree],
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [unrelated, target], projects: [] })
    };
    const submitPrompt = vi.fn(async () => true);
    const update = vi.fn(async () => ({ outcome: 'unavailable' as const }));
    const startUpdate = vi.fn(() => ({ outcome: 'unavailable' as const }));
    const startServerUpdate = vi.fn();
    const agentUpdates = { statuses: async () => [{ kind: 'pi' as const, currentVersion: '1.4.0', latestVersion: '1.5.0', updateAvailable: true, pinned: true as const }], update, startUpdate, updateStatus: () => undefined };
    const serverAdmin = { revision: () => undefined, startUpdate: startServerUpdate };
    const config = testConfig({ projects: [testProject({ id: 'rac', path: '/workspace', hostPath: '/host/rac' })] });
    app = await buildApp(config, { auth: await testAuthService(), discovery: discovery as never, prompts: { submit: submitPrompt } as never, agentUpdates, serverAdmin: serverAdmin as never });
    const headers = await authenticatedHeaders(app);
    const response = await app.inject({ method: 'POST', url: '/api/agents/pi/update-prompt', headers, payload: { requestId: 'pi-update-request-1', currentVersion: '1.4.0', targetVersion: '1.5.0' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ agentId: target.id, worktreeId: worktree.id });
    expect(submitPrompt).toHaveBeenCalledExactlyOnceWith(target.id, expect.stringContaining('Update the bundled Pi dependency'));
    expect(update).not.toHaveBeenCalled();
    expect(startUpdate).not.toHaveBeenCalled();
    expect(startServerUpdate).not.toHaveBeenCalled();
  }, 15_000);
});
