import { describe, expect, it, vi } from 'vitest';
import { ConductorModelCatalog } from '../src/settings/conductor-models.js';

describe('Pi launch catalog metadata', () => {
  // reuse authenticated chat discovery while preserving the existing settings shape
  it('adds model Efforts and resolves the cwd default without choosing catalog order', async () => {
    const runtime = {
      getProviders: vi.fn(() => [{ id: 'openai' }]),
      getError: vi.fn(() => undefined),
      hasConfiguredAuth: vi.fn(() => true),
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
      getAvailable: vi.fn(async () => [
        { id: 'plain', name: 'Plain', provider: 'openai', reasoning: false },
        { id: 'reasoning', name: 'Reasoning', provider: 'openai', reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: null } }
      ])
    };
    const settings = {
      getDefaultProvider: vi.fn(() => 'openai'),
      getDefaultModel: vi.fn(() => 'reasoning'),
      getDefaultThinkingLevel: vi.fn(() => 'low' as const),
      getModelThinkingLevel: vi.fn(() => 'xhigh' as const)
    };
    const catalog = new ConductorModelCatalog({ runtime: async () => runtime, settings: () => settings });

    await expect(catalog.listDetailed()).resolves.toEqual([
      { id: 'openai/plain', name: 'Plain', provider: 'openai', efforts: ['off'] },
      { id: 'openai/reasoning', name: 'Reasoning', provider: 'openai', efforts: ['off', 'low', 'medium', 'high', 'xhigh'] }
    ]);
    await expect(catalog.list()).resolves.toEqual([
      { id: 'openai/plain', name: 'Plain', provider: 'openai' },
      { id: 'openai/reasoning', name: 'Reasoning', provider: 'openai' }
    ]);
    expect(catalog.defaultSetting('/repo')).toEqual({ model: 'openai/reasoning', effort: 'xhigh' });
  });

  // preserve per-model settings across cwd and account boundaries
  it('projects each configured model Effort in the exact settings context', () => {
    const settings = vi.fn((cwd: string, stateDir: string) => ({
      getDefaultProvider: vi.fn(() => undefined),
      getDefaultModel: vi.fn(() => undefined),
      getDefaultThinkingLevel: vi.fn(() => cwd === '/repo-a' ? 'medium' as const : 'low' as const),
      getModelThinkingLevel: vi.fn((_provider: string, model: string) => {
        // vary overrides by effective Pi account
        if (stateDir === '/state-a' && model === 'a') return 'high' as const;
        if (stateDir === '/state-a' && model === 'b') return 'low' as const;
        if (stateDir === '/state-b' && model === 'a') return 'minimal' as const;
        return undefined;
      })
    }));
    const catalog = new ConductorModelCatalog({ settings });
    const models = [
      { id: 'openai/a', name: 'A', provider: 'openai', efforts: ['off', 'minimal', 'low', 'medium', 'high'] },
      { id: 'openai/b', name: 'B', provider: 'openai', efforts: ['off', 'minimal', 'low', 'medium', 'high'] },
      { id: 'openai/c', name: 'C', provider: 'openai', efforts: ['off', 'minimal', 'low', 'medium', 'high'] }
    ];

    expect(catalog.configuredEfforts('/repo-a', models, { PI_CODING_AGENT_DIR: '/state-a' })).toEqual({
      'openai/a': 'high', 'openai/b': 'low', 'openai/c': 'medium'
    });
    expect(catalog.configuredEfforts('/repo-b', models, { PI_CODING_AGENT_DIR: '/state-a' })).toEqual({
      'openai/a': 'high', 'openai/b': 'low', 'openai/c': 'low'
    });
    expect(catalog.configuredEfforts('/repo-a', models, { PI_CODING_AGENT_DIR: '/state-b' })).toEqual({
      'openai/a': 'minimal', 'openai/b': 'medium', 'openai/c': 'medium'
    });
    expect(settings.mock.calls).toEqual([
      ['/repo-a', '/state-a'], ['/repo-b', '/state-a'], ['/repo-a', '/state-b']
    ]);
  });

  // mirror the pinned runtime fallback only when settings are absent
  it('uses Pi runtime defaults for unset reasoning and plain models', () => {
    const settings = {
      getDefaultProvider: vi.fn(() => undefined),
      getDefaultModel: vi.fn(() => undefined),
      getDefaultThinkingLevel: vi.fn(() => undefined),
      getModelThinkingLevel: vi.fn(() => undefined)
    };
    const catalog = new ConductorModelCatalog({ settings: () => settings });

    expect(catalog.configuredEfforts('/repo', [
      { id: 'openai/reasoning', name: 'Reasoning', provider: 'openai', efforts: ['off', 'low', 'medium', 'high'] },
      { id: 'openai/plain', name: 'Plain', provider: 'openai', efforts: ['off'] },
      { id: 'openai/unusual', name: 'Unusual', provider: 'openai', efforts: ['high'] }
    ])).toEqual({ 'openai/reasoning': 'medium', 'openai/plain': 'off', 'openai/unusual': 'high' });
  });

  // clamp the first configured candidate exactly as the pinned runtime does
  it('clamps unsupported model and global Efforts without skipping priority', () => {
    const perModelSettings = {
      getDefaultProvider: vi.fn(() => undefined),
      getDefaultModel: vi.fn(() => undefined),
      getDefaultThinkingLevel: vi.fn(() => 'high' as const),
      getModelThinkingLevel: vi.fn((_provider: string, model: string) => model === 'a' ? 'minimal' as const : 'max' as const)
    };
    const globalSettings = {
      getDefaultProvider: vi.fn(() => undefined),
      getDefaultModel: vi.fn(() => undefined),
      getDefaultThinkingLevel: vi.fn(() => 'minimal' as const),
      getModelThinkingLevel: vi.fn(() => undefined)
    };
    const models = [
      { id: 'openai/a', name: 'A', provider: 'openai', efforts: ['off', 'low', 'medium', 'high'] },
      { id: 'openai/b', name: 'B', provider: 'openai', efforts: ['off', 'low', 'medium', 'high'] }
    ];

    expect(new ConductorModelCatalog({ settings: () => perModelSettings }).configuredEfforts('/repo', models)).toEqual({
      'openai/a': 'low', 'openai/b': 'high'
    });
    expect(new ConductorModelCatalog({ settings: () => globalSettings }).configuredEfforts('/repo', [models[0]!])).toEqual({ 'openai/a': 'low' });
  });

  // isolate cached Pi runtimes by the server-resolved launch home
  it('keeps effective launch-home catalogs in separate bounded contexts', async () => {
    const runtime = vi.fn(async (env: NodeJS.ProcessEnv) => ({
      getProviders: vi.fn(() => []),
      getError: vi.fn(() => undefined),
      hasConfiguredAuth: vi.fn(() => false),
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
      getAvailable: vi.fn(async () => [])
    }));
    const catalog = new ConductorModelCatalog({ runtime });

    await catalog.listDetailed({ HOME: '/accounts/a', PI_CODING_AGENT_DIR: '' });
    await catalog.listDetailed({ HOME: '/accounts/a', PI_CODING_AGENT_DIR: '' });
    await catalog.listDetailed({ HOME: '/accounts/b', PI_CODING_AGENT_DIR: '' });

    expect(runtime).toHaveBeenCalledTimes(2);
    expect(runtime.mock.calls.map(([env]) => env.HOME)).toEqual(['/accounts/a', '/accounts/b']);
  });
});
