import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { LaunchOptionsService } from '../src/launch/options.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

// keep restart revision identities server-bound even when agents share a Place
describe('restart option target identity', () => {
  // independent menus stay valid while changes to the same agent invalidate its menu
  it('isolates two agents in one Place without splitting native discovery', async () => {
    // model each agent's observed native state in the same Place
    const agents = ['a', 'b'].map(id => ({ id, kind: 'pi', home: '/repo', placeId: 'scratch:/repo', structured: { model: { id: `openai/${id}` } } }));
    const config = testConfig({ adapters: { pi: { program: process.execPath, args: [], env: {}, launchable: true, allowedModels: [{ model: 'openai/a' }, { model: 'openai/b' }] } } });
    // keep discovery deterministic without starting a native process
    const listDetailed = vi.fn(async () => ['a', 'b'].map(id => ({ id: `openai/${id}`, name: id, efforts: [] })));
    const options = new LaunchOptionsService(config.adapters, { piModels: { listDetailed, defaultSetting: () => undefined }, capabilities: async () => ({}) });
    const list = vi.spyOn(options, 'list');
    const app = await buildApp(config, {
      auth: await testAuthService(),
      launchOptions: options,
      discovery: { worktreesNow: () => [], projectsNow: () => [], dashboard: async () => ({ agents }), useStructuredAgents: () => undefined } as never,
      dashboardUpdates: { setLoader: () => undefined, refresh: async () => undefined, close: () => undefined } as never
    });
    try {
      const headers = await authenticatedHeaders(app);
      const first = await app.inject({ method: 'POST', url: '/api/launch/options', headers, payload: { type: 'agent', id: 'a' } });
      const second = await app.inject({ method: 'POST', url: '/api/launch/options', headers, payload: { type: 'agent', id: 'b' } });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const revision = first.json().kinds[0].optionsRevision;
      expect(second.json().kinds[0].optionsRevision).not.toBe(revision);
      expect(list.mock.calls[0]![0]).toMatchObject({ targetId: 'agent:a', cwd: '/repo' });
      expect(list.mock.calls[1]![0]).toMatchObject({ targetId: 'agent:b', cwd: '/repo' });
      await expect(options.prepare('pi', { kind: 'pi', optionsRevision: revision }, list.mock.calls[0]![0])).resolves.toMatchObject({ keepCurrent: true });
      expect(listDetailed).toHaveBeenCalledTimes(1);
      agents[0]!.structured.model.id = 'openai/b';
      const changed = await app.inject({ method: 'POST', url: '/api/launch/options', headers, payload: { type: 'agent', id: 'a' } });
      expect(changed.json().kinds[0].optionsRevision).not.toBe(revision);
      await expect(options.prepare('pi', { kind: 'pi', optionsRevision: revision }, list.mock.calls[2]![0])).rejects.toMatchObject({ code: 'launch_options_stale' });
    } finally { await app.close(); }
  });
});
