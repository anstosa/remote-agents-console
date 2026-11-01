import { describe, expect, it, vi } from 'vitest';
import { ConductorModelCatalog } from '../src/settings/conductor-models.js';

type TestModel = { id: string; name: string; provider: string; type?: string };

// create one injected Pi runtime with observable refresh boundaries
function runtimeFixture(options: { providers?: string[]; configured?: string[]; models?: TestModel[]; refresh?: ReturnType<typeof vi.fn> } = {}) {
  const providers = options.providers ?? ['openai'];
  const configured = new Set(options.configured ?? providers);
  const refresh = options.refresh ?? vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
  const getAvailable = vi.fn(async () => options.models ?? []);
  return {
    runtime: {
      getProviders: vi.fn(() => providers.map(id => ({ id }))),
      hasConfiguredAuth: vi.fn((providerId: string) => configured.has(providerId)),
      refresh,
      getError: vi.fn((): string | undefined => undefined),
      getAvailable
    },
    refresh,
    getAvailable
  };
}

describe('ConductorModelCatalog', () => {
  // refresh only credentialed providers and map Pi chat metadata exactly once
  it('loads authenticated chat models from the forced network catalog', async () => {
    const fixture = runtimeFixture({
      providers: ['openai', 'anthropic'],
      configured: ['openai'],
      models: [
        { id: 'gpt-6', name: 'GPT-6', provider: 'openai' },
        { id: 'gpt-image', name: 'GPT Image', provider: 'openai', type: 'image' },
        { id: 'claude', name: 'Claude', provider: 'anthropic' },
        { id: 'gpt-6', name: 'duplicate', provider: 'openai' }
      ]
    });
    const signal = new AbortController().signal;
    const catalog = new ConductorModelCatalog({ runtime: async () => fixture.runtime as never, signal: vi.fn(() => signal) });

    await expect(catalog.list()).resolves.toEqual([{
      id: 'openai/gpt-6',
      name: 'GPT-6',
      provider: 'openai'
    }]);
    expect(fixture.refresh).toHaveBeenNthCalledWith(1, { allowNetwork: false, signal });
    expect(fixture.refresh).toHaveBeenNthCalledWith(2, { providers: ['openai'], allowNetwork: true, force: true, signal });
    expect(fixture.getAvailable).toHaveBeenCalledExactlyOnceWith(undefined, { signal });
  });

  // return no invented choices when Pi has no configured provider credentials
  it('returns an empty catalog without a network request when no provider is credentialed', async () => {
    const fixture = runtimeFixture({ providers: ['openai'], configured: [] });
    const catalog = new ConductorModelCatalog({ runtime: async () => fixture.runtime as never });

    await expect(catalog.list()).resolves.toEqual([]);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).toHaveBeenCalledWith({ allowNetwork: false, signal: expect.any(AbortSignal) });
    expect(fixture.getAvailable).not.toHaveBeenCalled();
  });

  // Pi records availability failures separately from the refresh result
  it('rejects a swallowed credential failure without caching it and retries safely', async () => {
    const fixture = runtimeFixture({ configured: [] });
    fixture.runtime.getError.mockReturnValueOnce('private credential read failure');
    const catalog = new ConductorModelCatalog({ runtime: async () => fixture.runtime });

    await expect(catalog.list()).rejects.toMatchObject({ code: 'conductor_models_unavailable', statusCode: 503, message: 'conductor_models_unavailable' });
    expect(fixture.getAvailable).not.toHaveBeenCalled();
    await expect(catalog.list()).resolves.toEqual([]);
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
    await expect(catalog.list()).resolves.toEqual([]);
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
  });

  // replace upstream API and credential diagnostics with one retryable settings code
  it('fails safely instead of falling back to built-in models', async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce({ aborted: false, errors: new Map<string, Error>() })
      .mockResolvedValueOnce({ aborted: false, errors: new Map([['openai', new Error('secret upstream response')]]) });
    const fixture = runtimeFixture({
      refresh,
      models: [{ id: 'fallback', name: 'Fallback', provider: 'openai' }]
    });
    const catalog = new ConductorModelCatalog({ runtime: async () => fixture.runtime as never });

    await expect(catalog.list()).rejects.toMatchObject({ code: 'conductor_models_unavailable', statusCode: 503, message: 'conductor_models_unavailable' });
    expect(fixture.getAvailable).not.toHaveBeenCalled();
  });

  // retry a transient SDK initialization failure instead of memoizing it forever
  it('recreates the runtime after initialization fails', async () => {
    const fixture = runtimeFixture({ configured: [] });
    const runtime = vi.fn()
      .mockRejectedValueOnce(new Error('private credential read failure'))
      .mockResolvedValueOnce(fixture.runtime);
    const catalog = new ConductorModelCatalog({ runtime });

    await expect(catalog.list()).rejects.toMatchObject({ code: 'conductor_models_unavailable', statusCode: 503 });
    await expect(catalog.list()).resolves.toEqual([]);
    expect(runtime).toHaveBeenCalledTimes(2);
  });

  // apply the bounded deadline to every SDK phase and surface an aborted refresh safely
  it('uses the configured timeout signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const refresh = vi.fn(async () => ({ aborted: true, errors: new Map<string, Error>() }));
    const fixture = runtimeFixture({ refresh });
    const signal = vi.fn(() => controller.signal);
    const catalog = new ConductorModelCatalog({ runtime: async () => fixture.runtime as never, timeoutMs: 321, signal });

    await expect(catalog.list()).rejects.toMatchObject({ code: 'conductor_models_unavailable', statusCode: 503 });
    expect(signal).toHaveBeenCalledExactlyOnceWith(321);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false, signal: controller.signal });
  });

  // deduplicate concurrent loads and refresh once after the freshness window expires
  it('deduplicates in-flight requests and honors its TTL', async () => {
    let release: (() => void) | undefined;
    let now = 1_000;
    let networkRefreshes = 0;
    const refresh = vi.fn(async (options: { allowNetwork: boolean }) => {
      // hold only the first network refresh so the second caller can join it
      if (options.allowNetwork && networkRefreshes++ === 0) await new Promise<void>(resolve => { release = resolve; });
      return { aborted: false, errors: new Map<string, Error>() };
    });
    const fixture = runtimeFixture({ refresh, models: [{ id: 'gpt-6', name: 'GPT-6', provider: 'openai' }] });
    const catalog = new ConductorModelCatalog({ ttlMs: 50, now: () => now, runtime: async () => fixture.runtime as never });

    const first = catalog.list();
    const second = catalog.list();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: 'openai/gpt-6', name: 'GPT-6', provider: 'openai' }],
      [{ id: 'openai/gpt-6', name: 'GPT-6', provider: 'openai' }]
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);

    now = 1_049;
    await catalog.list();
    expect(refresh).toHaveBeenCalledTimes(2);

    now = 1_050;
    await catalog.list();
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(fixture.getAvailable).toHaveBeenCalledTimes(2);
  });
});
