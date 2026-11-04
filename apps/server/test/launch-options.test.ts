import { describe, expect, it, vi } from 'vitest';
import type { AdapterConfigs } from '../src/adapters/types.js';
import type { CodexProtocolClient } from '../src/accounts/protocol.js';
import { discoverCodexModels, LaunchOptionsError, LaunchOptionsService, resolveReviewLaunchModel, resolveAllowedLaunchModel, resolveLaunchModelPolicy } from '../src/launch/options.js';

const piModels = [
  { id: 'openai/a', name: 'A', provider: 'openai', efforts: ['off', 'high'], defaultEffort: 'off' },
  { id: 'openai/b', name: 'B', provider: 'openai', efforts: ['off', 'high'], defaultEffort: 'high' },
  { id: 'openai/c', name: 'C', provider: 'openai', efforts: ['off', 'high'], defaultEffort: 'off' }
];

// create one configured Pi launch service fixture
function piService(allowedModels?: Array<{ model: string; effort?: string }>, defaultModel: { model: string; effort?: string } | undefined = { model: 'openai/a', effort: 'off' }): LaunchOptionsService {
  const configs: AdapterConfigs = { pi: { program: process.execPath, args: [], env: {}, launchable: true, ...(allowedModels === undefined ? {} : { allowedModels }) } };
  return new LaunchOptionsService(configs, {
    piModels: { listDetailed: vi.fn(async () => piModels), defaultSetting: vi.fn(() => defaultModel) },
    capabilities: vi.fn(async () => ({}))
  });
}

describe('launch model policy', () => {
  // untouched card and primary launch share configured default semantics
  it('revalidates a model-default choice with a supported saved effort', async () => {
    const service = piService([{ model: 'openai/b', effort: 'high' }]);
    const context = { cwd: '/repo' };
    const manifest = (await service.list(context)).kinds[0]!;
    const primary = await service.prepare('pi', { kind: 'pi' }, context);
    const card = await service.prepare('pi', { kind: 'pi', model: { mode: 'model', id: 'openai/b' }, effort: { mode: 'model-default' }, optionsRevision: manifest.optionsRevision }, context);
    expect(card.model).toEqual(primary.model);
    expect(card.model).toEqual({ model: 'openai/b', effort: 'high' });
    await expect(service.revalidate(card, context)).resolves.toBeUndefined();
  });

  // automatic review paths must not emit unproven saved effort tokens
  it('preserves explicit review effort and omits unsupported saved defaults', () => {
    const configured = { program: '/codex', args: [], env: {}, launchable: true, allowedModels: [{ model: 'b', effort: 'unsupported-safe-token' }] };
    expect(resolveReviewLaunchModel('codex', configured, {})).toEqual({ model: 'b' });
    expect(resolveReviewLaunchModel('codex', configured, { effort: 'high' })).toEqual({ model: 'b', effort: 'high' });
    expect(() => resolveReviewLaunchModel('codex', configured, { effort: 'unsupported-safe-token' })).toThrowError('launch_option_unsupported');
  });

  // distinguish absent exact, absent opaque, explicit, and empty policy states
  it('resolves every persisted policy state without broadening explicit lists', () => {
    const ready = { status: 'ready' as const, models: piModels, defaultModel: { model: 'openai/a', effort: 'off' } };
    expect(resolveLaunchModelPolicy(undefined, ready, {}, 'pi')).toMatchObject({
      state: 'native-default', allowed: [{ model: 'openai/a' }], defaultSelection: { mode: 'model', id: 'openai/a' }
    });
    expect(resolveLaunchModelPolicy(undefined, { status: 'unavailable', models: [] }, {}, 'pi')).toMatchObject({
      state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }
    });
    expect(resolveLaunchModelPolicy([{ model: 'openai/b' }, { model: 'openai/c' }], ready, {}, 'pi')).toMatchObject({
      state: 'explicit', allowed: [{ model: 'openai/b' }, { model: 'openai/c' }], defaultSelection: { mode: 'model', id: 'openai/b' }
    });
    expect(resolveLaunchModelPolicy([], ready, {}, 'pi')).toMatchObject({ state: 'empty', allowed: [] });
  });

  // expose supported defaults without changing the configured model boundary
  it('prioritizes saved, native, and recommended Effort metadata', () => {
    const catalog = {
      status: 'ready' as const,
      models: [
        { id: 'saved', name: 'Saved', efforts: ['low', 'high'], defaultEffort: 'low' },
        { id: 'native', name: 'Native', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'recommended', name: 'Recommended', efforts: ['high'], defaultEffort: 'high' },
        { id: 'none', name: 'None', efforts: [] },
        { id: 'outside', name: 'Outside', efforts: ['low'], defaultEffort: 'low' }
      ],
      defaultModel: { model: 'native', effort: 'low' },
      effortDefaults: { saved: 'low', native: 'low', recommended: 'high' }
    };

    const policy = resolveLaunchModelPolicy([
      { model: 'saved', effort: 'high' },
      { model: 'native' },
      { model: 'recommended', effort: 'low' },
      { model: 'none', effort: 'high' },
      { model: 'unknown', effort: 'high' }
    ], catalog, {}, 'pi');

    expect(policy.effortDefaults).toEqual({ saved: 'high', native: 'low', recommended: 'high' });
    expect(policy.allowed.map(entry => entry.model)).toEqual(['saved', 'native', 'recommended', 'none', 'unknown']);
    expect(policy.allowed).not.toContainEqual(expect.objectContaining({ model: 'outside' }));
  });

  // identify only an actual same-kind keep-current default
  it('exposes the current model and its supported Effort for restart defaults', () => {
    const ready = {
      status: 'ready' as const,
      models: piModels,
      defaultModel: { model: 'openai/a', effort: 'off' },
      effortDefaults: { 'openai/a': 'off', 'openai/b': 'off', 'openai/c': 'off' }
    };
    const current = resolveLaunchModelPolicy(
      [{ model: 'openai/b', effort: 'off' }, { model: 'openai/c' }],
      ready,
      { restart: true, currentKind: 'pi', currentModel: { model: 'openai/b', effort: 'high' } },
      'pi'
    );
    const unavailable = resolveLaunchModelPolicy(
      [{ model: 'openai/c' }],
      ready,
      { restart: true, currentKind: 'pi', currentModel: { model: 'openai/b', effort: 'high' } },
      'pi'
    );
    const unknownCurrentEffort = resolveLaunchModelPolicy(
      [{ model: 'openai/b' }],
      ready,
      { restart: true, currentKind: 'pi', currentModel: { model: 'openai/b', effort: 'unknown' } },
      'pi'
    );

    expect(current).toMatchObject({
      defaultSelection: { mode: 'keep-current' },
      currentModel: 'openai/b',
      currentEffort: 'high',
      effortDefaults: { 'openai/b': 'off' }
    });
    expect(unavailable.defaultSelection).toEqual({ mode: 'model', id: 'openai/c' });
    expect(unavailable).not.toHaveProperty('currentModel');
    expect(unknownCurrentEffort.effortDefaults).toEqual({ 'openai/b': 'off' });
    expect(unknownCurrentEffort).not.toHaveProperty('currentEffort');
  });

  // omit optional metadata when the native context cannot prove support
  it('does not invent Effort defaults for unknown model metadata', () => {
    const policy = resolveLaunchModelPolicy(
      [{ model: 'opaque', effort: 'high' }],
      { status: 'unavailable', models: [] },
      {},
      'pi'
    );

    expect(policy.allowed).toEqual([{ model: 'opaque', effort: 'high' }]);
    expect(policy).not.toHaveProperty('effortDefaults');
    expect(policy).not.toHaveProperty('currentModel');
  });

  // enforce configured defaults for automated and manual callers alike
  it('never lets an omitted model bypass an explicit list', () => {
    const configured = { program: '/bin/agent', args: [], env: {}, launchable: true, allowedModels: [{ model: 'b', effort: 'high' }, { model: 'c' }] };
    expect(resolveAllowedLaunchModel('codex', configured)).toEqual({ model: 'b' });
    expect(resolveAllowedLaunchModel('codex', configured, { model: 'c' })).toEqual({ model: 'c' });
    expect(() => resolveAllowedLaunchModel('codex', configured, { model: 'a' })).toThrowError(LaunchOptionsError);
    expect(() => resolveAllowedLaunchModel('codex', { ...configured, allowedModels: [] })).toThrowError('model_policy_empty');
    expect(() => resolveAllowedLaunchModel('codex', { ...configured, allowedModels: undefined }, { model: 'a' })).toThrowError('model_not_allowed');
    expect(resolveAllowedLaunchModel('codex', { ...configured, allowedModels: undefined }, { model: 'a' }, { nativeDefaultValidated: true })).toEqual({ model: 'a' });
  });

  // prepare explicit model, Effort, and security under one current revision
  it('prepares and revalidates one explicit Pi launch choice', async () => {
    const service = piService([{ model: 'openai/b', effort: 'high' }, { model: 'openai/c' }]);
    const context = { cwd: '/repo' };
    const manifest = (await service.list(context)).kinds[0]!;
    const prepared = await service.prepare('pi', {
      kind: 'pi', model: { mode: 'model', id: 'openai/c' }, effort: { mode: 'effort', id: 'high' },
      security: { sandbox: 'off' }, optionsRevision: manifest.optionsRevision
    }, context);

    expect(prepared).toEqual({
      kind: 'pi', model: { model: 'openai/c', effort: 'high' }, security: { sandbox: 'off' }, optionsRevision: manifest.optionsRevision
    });
    await expect(service.revalidate(prepared, context)).resolves.toBeUndefined();
  });

  // never let an Effort-only payload silently select the first Allowed model
  it('requires explicit model semantics for an Effort override', async () => {
    const service = piService([{ model: 'openai/b' }, { model: 'openai/c' }]);

    await expect(service.prepare('pi', {
      kind: 'pi', effort: { mode: 'effort', id: 'high' }
    }, { cwd: '/repo' })).rejects.toMatchObject({ code: 'launch_option_unsupported', statusCode: 409 });
  });

  // keep ordinary one-click preparation independent of provider discovery
  it('does not contact Pi providers for a no-revision default launch', async () => {
    const listDetailed = vi.fn(async () => { throw new Error('network must remain lazy'); });
    const defaultSetting = vi.fn(() => { throw new Error('settings must remain lazy'); });
    const service = new LaunchOptionsService({ pi: {
      program: process.execPath, args: [], env: {}, launchable: true, allowedModels: [{ model: 'openai/b' }]
    } }, { piModels: { listDetailed, defaultSetting }, capabilities: vi.fn(async () => ({})) });

    const prepared = await service.prepare('pi', { kind: 'pi' }, { cwd: '/repo' });

    expect(prepared.model).toEqual({ model: 'openai/b' });
    expect(listDetailed).not.toHaveBeenCalled();
    expect(defaultSetting).not.toHaveBeenCalled();
    await expect(service.revalidate(prepared, { cwd: '/repo' })).resolves.toBeUndefined();
    expect(listDetailed).not.toHaveBeenCalled();
  });

  // keep an absent Pi singleton as native authorization rather than a forged list
  it('omits Pi nominal defaults and refuses arbitrary switches under absent policy', async () => {
    const service = piService();
    const context = { cwd: '/repo' };
    const manifest = (await service.list(context)).kinds[0]!;
    await expect(service.prepare('pi', {
      kind: 'pi', model: { mode: 'model', id: 'openai/a' }, optionsRevision: manifest.optionsRevision
    }, context)).resolves.toEqual({ kind: 'pi', nativeDefault: true, security: { sandbox: 'on' }, optionsRevision: manifest.optionsRevision });
    await expect(service.prepare('pi', {
      kind: 'pi', model: { mode: 'model', id: 'openai/b' }, optionsRevision: manifest.optionsRevision
    }, context)).rejects.toMatchObject({ code: 'model_not_allowed', statusCode: 409 });
  });

  // isolate revision counters while reusing account and directory discovery
  it('keeps two restart targets independent in one working directory', async () => {
    const service = piService([{ model: 'openai/b' }, { model: 'openai/c' }]);
    const first = { cwd: '/repo', home: '/account', targetId: 'agent:a', restart: true, currentKind: 'pi' as const, currentModel: { model: 'openai/b' } };
    const second = { ...first, targetId: 'agent:b', currentModel: { model: 'openai/c' } };
    const initial = (await service.list(first)).kinds[0]!;
    const other = (await service.list(second)).kinds[0]!;
    expect(other.optionsRevision).not.toBe(initial.optionsRevision);
    await expect(service.prepare('pi', { kind: 'pi', optionsRevision: initial.optionsRevision }, first)).resolves.toMatchObject({ keepCurrent: true });
    await expect(service.prepare('pi', { kind: 'pi', optionsRevision: initial.optionsRevision }, { ...first, currentModel: second.currentModel })).rejects.toMatchObject({ code: 'launch_options_stale' });
  });

  // bind revisions and keep-current copy to the active restart model
  it('changes the revision when the current restart model changes', async () => {
    const service = piService([{ model: 'openai/b' }, { model: 'openai/c' }]);
    const first = { cwd: '/repo', restart: true as const, currentKind: 'pi' as const, currentModel: { model: 'openai/b' } };
    const initial = (await service.list(first)).kinds[0]!;
    expect(initial.modelPolicy.message).toContain('Keep current — openai/b');
    const changed = { ...first, currentModel: { model: 'openai/c' } };
    const next = (await service.list(changed)).kinds[0]!;
    expect(next.optionsRevision).not.toBe(initial.optionsRevision);
    await expect(service.prepare('pi', { kind: 'pi', optionsRevision: initial.optionsRevision }, changed)).rejects.toMatchObject({ code: 'launch_options_stale' });
  });

  // keep manifest metadata read-only for untouched restart preparation
  it('preserves untouched same-kind restart preparation semantics', async () => {
    const service = piService([{ model: 'openai/b', effort: 'off' }]);
    const context = { cwd: '/repo', restart: true as const, currentKind: 'pi' as const, currentModel: { model: 'openai/b', effort: 'high' } };
    const manifest = (await service.list(context)).kinds[0]!;

    expect(manifest.modelPolicy).toMatchObject({ currentModel: 'openai/b', currentEffort: 'high', effortDefaults: { 'openai/b': 'off' } });
    await expect(service.prepare('pi', { kind: 'pi', optionsRevision: manifest.optionsRevision }, context)).resolves.toMatchObject({
      kind: 'pi', keepCurrent: true, security: { sandbox: 'on' }, optionsRevision: manifest.optionsRevision
    });
    await expect(service.prepare('pi', {
      kind: 'pi', model: { mode: 'model', id: 'openai/b' }, optionsRevision: manifest.optionsRevision
    }, context)).resolves.toMatchObject({
      kind: 'pi', model: { model: 'openai/b', effort: 'off' }, security: { sandbox: 'on' }, optionsRevision: manifest.optionsRevision
    });
  });

  // keep Pi native Effort metadata scoped by model, cwd, and account
  it('does not reuse the Pi default model Effort for another model', async () => {
    const models = [
      { id: 'openai/a', name: 'A', provider: 'openai', efforts: ['off', 'low', 'high'], defaultEffort: 'off' },
      { id: 'openai/b', name: 'B', provider: 'openai', efforts: ['off', 'low', 'high'], defaultEffort: 'high' }
    ];
    const configuredEfforts = vi.fn((cwd: string, _models: typeof models, env: Record<string, string>) => {
      // vary native settings without changing the shared model catalog
      if (cwd === '/repo-a' && env.HOME === '/accounts/a') return { 'openai/a': 'high', 'openai/b': 'low' };
      if (cwd === '/repo-b' && env.HOME === '/accounts/a') return { 'openai/a': 'off', 'openai/b': 'high' };
      return { 'openai/a': 'low', 'openai/b': 'off' };
    });
    const service = new LaunchOptionsService({ pi: {
      program: process.execPath, args: [], env: {}, launchable: true, allowedModels: [{ model: 'openai/a' }, { model: 'openai/b' }]
    } }, {
      piModels: {
        listDetailed: vi.fn(async () => models),
        defaultSetting: vi.fn(() => ({ model: 'openai/a', effort: 'high' })),
        configuredEfforts
      },
      capabilities: vi.fn(async () => ({}))
    });

    const first = (await service.list({ cwd: '/repo-a', home: '/accounts/a' })).kinds[0]!;
    const second = (await service.list({ cwd: '/repo-b', home: '/accounts/a' })).kinds[0]!;
    const third = (await service.list({ cwd: '/repo-a', home: '/accounts/b' })).kinds[0]!;

    expect(first.modelPolicy.effortDefaults).toEqual({ 'openai/a': 'high', 'openai/b': 'low' });
    expect(second.modelPolicy.effortDefaults).toEqual({ 'openai/a': 'off', 'openai/b': 'high' });
    expect(third.modelPolicy.effortDefaults).toEqual({ 'openai/a': 'low', 'openai/b': 'off' });
    await expect(service.prepare('pi', {
      kind: 'pi', model: { mode: 'model', id: 'openai/b' }, optionsRevision: first.optionsRevision
    }, { cwd: '/repo-a', home: '/accounts/a' })).resolves.toEqual({
      kind: 'pi', model: { model: 'openai/b' }, security: { sandbox: 'on' }, optionsRevision: first.optionsRevision
    });
    expect(configuredEfforts).toHaveBeenCalledTimes(3);
  });

  // invalidate cached native state after an account or capability switch
  it('changes the opaque revision after explicit context invalidation', async () => {
    const service = piService([{ model: 'openai/b' }]);
    const first = (await service.list({ cwd: '/repo' })).kinds[0]!;

    service.invalidate('pi');
    const next = (await service.list({ cwd: '/repo' })).kinds[0]!;

    expect(next.optionsRevision).not.toBe(first.optionsRevision);
  });
});

describe('Codex launch catalog discovery', () => {
  // use the exact configured process context and paginate model metadata
  it('uses configured overrides before config and catalog defaults', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: CodexProtocolClient = {
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        // complete the handshake
        if (method === 'initialize') return {};
        // expose one effective cwd config
        if (method === 'config/read') return { config: { model: 'config-model', model_reasoning_effort: 'low' } };
        // return two bounded pages
        if ((params as { cursor?: string }).cursor === undefined) return { data: [{ model: 'catalog-a', displayName: 'Catalog A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: 'next' };
        return { data: [{ model: 'catalog-b', displayName: 'Catalog B', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', isDefault: false }], nextCursor: null };
      }),
      notify: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined)
    };
    const create = vi.fn(async () => client);
    const config = { program: '/opt/codex', args: ['--profile', 'work', '--model', 'configured-model', '-cmodel_reasoning_effort=xhigh'], env: { HOME: '/accounts/a', CODEX_HOME: '/accounts/a/.codex-custom' }, launchable: true };

    const result = await discoverCodexModels(config, '/repo', create);

    expect(create).toHaveBeenCalledWith('/accounts/a/.codex-custom', {
      command: '/opt/codex',
      args: ['--profile', 'work', '-c', 'model=configured-model', '-cmodel_reasoning_effort=xhigh', 'app-server', '--listen', 'stdio://'],
      env: config.env,
      cwd: '/repo'
    });
    expect(requests.filter(request => request.method === 'model/list').map(request => request.params)).toEqual([{ limit: 100 }, { limit: 100, cursor: 'next' }]);
    expect(result).toEqual({
      status: 'ready',
      models: [
        { id: 'catalog-a', name: 'Catalog A', efforts: ['low'], defaultEffort: 'low' },
        { id: 'catalog-b', name: 'Catalog B', efforts: ['high'], defaultEffort: 'high' }
      ],
      defaultModel: { model: 'configured-model', effort: 'xhigh' }
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  // inherit the launch account home when the adapter does not override it
  it.each([undefined, '', '   '])('uses the server-resolved launch home when Codex HOME is %s', async home => {
    const client: CodexProtocolClient = {
      request: vi.fn(async method => method === 'config/read' ? { config: {} } : method === 'model/list' ? { data: [], nextCursor: null } : {}),
      notify: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined)
    };
    const create = vi.fn(async () => client);
    const config = { program: '/opt/codex', args: [], env: { CUSTOM: 'value', ...(home === undefined ? {} : { HOME: home }) }, launchable: true };

    await discoverCodexModels(config, '/repo', create, 5_000, '/accounts/host');

    expect(create).toHaveBeenCalledWith('/accounts/host/.codex', {
      command: '/opt/codex',
      args: ['app-server', '--listen', 'stdio://'],
      env: { CUSTOM: 'value', HOME: '/accounts/host' },
      cwd: '/repo'
    });
  });
});
