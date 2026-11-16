import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplySuggestionService } from '../src/reply-suggestions/service.js';
import type { ReplySuggestionSource } from '../src/reply-suggestions/types.js';

// hold provider work independently of the request deadline
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// represent one authoritative current conversation snapshot
function source(agentId = 'pi-1', identity = 'turn-1'): ReplySuggestionSource {
  return {
    kind: 'pi', transport: 'structured', runtimeGeneration: 'fixture-runtime', agentId, identity, sourceGeneration: 1, processGeneration: 1, conversationId: 'conversation-1',
    model: { model: 'openai/test-model', effort: 'high' },
    nativeModel: { provider: 'openai', id: 'test-model', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    messages: [{ id: 'user-1', role: 'user', text: 'Keep the release local.' }, { id: 'assistant-1', role: 'assistant', text: 'Should I run the local test?' }]
  };
}

const replies = [{ label: 'Run local test', text: 'Run the local test without publishing anything.' }];

// restore deadline controls after each isolated coordinator test
afterEach(() => { vi.useRealTimers(); });

describe('reply suggestion demand coordinator', () => {
  // temporary source loss retires pills without buying the same source again
  it.each(['success', 'empty', 'throw'] as const)('does not repeat a %s attempt after source recovery', async outcome => {
    let current: ReplySuggestionSource | undefined = source();
    const generate = vi.fn(async () => {
      // every terminal outcome consumes the semantic attempt
      if (outcome === 'throw') throw new Error('private upstream detail');
      return outcome === 'empty' ? [] : replies;
    });
    const service = new ReplySuggestionService({ source: async () => current, routeFingerprint: async () => 'own-login-1', generate });
    const first = (await service.observe('pi-1'))!;
    await service.request('pi-1', first, () => true);
    current = undefined;
    expect(await service.observe('pi-1')).toBeUndefined();
    current = source();
    const recovered = (await service.observe('pi-1'))!;
    expect(recovered).not.toBe(first);
    expect(await service.request('pi-1', recovered, () => true)).toEqual({ status: 'ready', sourceKey: recovered, suggestions: [] });
    expect(generate).toHaveBeenCalledTimes(1);
    service.stop();
  });

  // rejected preflight is final even when the source becomes readable again
  it('does not repeat a rejected selection barrier after source recovery', async () => {
    let current: ReplySuggestionSource | undefined = source();
    const validate = vi.fn(async () => false);
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => current, routeFingerprint: async () => 'own-login-1', validate, generate });
    await service.request('pi-1', (await service.observe('pi-1'))!, () => true);
    current = undefined;
    await service.observe('pi-1');
    current = source();
    const recovered = (await service.observe('pi-1'))!;
    expect(await service.request('pi-1', recovered, () => true)).toEqual({ status: 'ready', sourceKey: recovered, suggestions: [] });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // an actual new source or credential route may still receive one authorized attempt
  it('allows one attempt for each changed semantic source or route', async () => {
    let current: ReplySuggestionSource | undefined = source();
    let route = 'own-login-1';
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => current, routeFingerprint: async () => route, generate });
    await service.request('pi-1', (await service.observe('pi-1'))!, () => true);
    current = undefined;
    await service.observe('pi-1');
    current = source('pi-1', 'turn-2');
    await service.request('pi-1', (await service.observe('pi-1'))!, () => true);
    route = 'own-login-2';
    const key = (await service.observe('pi-1'))!;
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: replies });
    await service.request('pi-1', key, () => true);
    expect(generate).toHaveBeenCalledTimes(3);
    service.stop();
  });

  // rejected capacity consumes demand even after the occupied slots settle
  it('does not retry a capacity rejection after source recovery', async () => {
    const began = [deferred<void>(), deferred<void>()];
    const held = deferred<typeof replies>();
    let thirdAvailable = true;
    const generate = vi.fn(async () => {
      began[generate.mock.calls.length - 1]?.resolve();
      return await held.promise;
    });
    const service = new ReplySuggestionService({
      source: async id => id === 'pi-3' && !thirdAvailable ? undefined : source(id),
      routeFingerprint: async () => 'own-login-1',
      generate
    });
    const first = service.request('pi-1', (await service.observe('pi-1'))!, () => true);
    await began[0]!.promise;
    const second = service.request('pi-2', (await service.observe('pi-2'))!, () => true);
    await began[1]!.promise;
    const thirdKey = (await service.observe('pi-3'))!;
    expect(await service.request('pi-3', thirdKey, () => true)).toEqual({ status: 'ready', sourceKey: thirdKey, suggestions: [] });
    thirdAvailable = false;
    await service.observe('pi-3');
    held.resolve(replies);
    await Promise.all([first, second]);
    thirdAvailable = true;
    const recovered = (await service.observe('pi-3'))!;
    expect(recovered).not.toBe(thirdKey);
    expect(await service.request('pi-3', recovered, () => true)).toEqual({ status: 'ready', sourceKey: recovered, suggestions: [] });
    expect(generate).toHaveBeenCalledTimes(2);
    service.stop();
  });

  // unsettled attempts remain pinned while bounded settled history turns over
  it('never duplicates an ignored-abort attempt after source recovery and ledger churn', async () => {
    const began = deferred<void>();
    const held = deferred<typeof replies>();
    let originalAvailable = true;
    let epoch = 0;
    const generate = vi.fn(async (current: ReplySuggestionSource) => {
      // keep the original operation alive after its caller is retired
      if (current.agentId === 'pi-1') { began.resolve(); return await held.promise; }
      return replies;
    });
    const service = new ReplySuggestionService({
      source: async id => id === 'pi-1' ? originalAvailable ? source(id) : undefined : source(id, `turn-${epoch}`),
      routeFingerprint: async () => 'own-login-1',
      generate
    });
    const firstKey = (await service.observe('pi-1'))!;
    const pending = service.request('pi-1', firstKey, () => true);
    await began.promise;
    originalAvailable = false;
    await service.observe('pi-1');
    expect(await pending).toEqual({ status: 'stale' });
    // more settled sources than the ledger bound cannot evict active work
    for (epoch = 0; epoch < 1_030; epoch += 1) {
      const nextKey = (await service.observe('pi-2'))!;
      await service.request('pi-2', nextKey, () => true);
    }
    originalAvailable = true;
    const recovered = (await service.observe('pi-1'))!;
    expect(recovered).not.toBe(firstKey);
    expect(await service.request('pi-1', recovered, () => true)).toEqual({ status: 'ready', sourceKey: recovered, suggestions: [] });
    expect(generate).toHaveBeenCalledTimes(1_031);
    held.resolve(replies);
    service.stop();
  });

  // native selection checks never run from dashboard observation
  it('requires a fresh selection barrier before spending provider work', async () => {
    const validate = vi.fn(async () => false);
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', validate, generate });
    const key = (await service.observe('pi-1'))!;
    expect(validate).not.toHaveBeenCalled();
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // a late native selection transition cannot publish otherwise valid drafts
  it('rechecks the native selection after generation and drops changed output', async () => {
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', validate, generate });
    const key = (await service.observe('pi-1'))!;
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
    service.stop();
  });

  // selection observation cannot extend a departed controller reservation
  it('does not dispatch when authority is lost during a native barrier', async () => {
    const began = deferred<void>();
    const held = deferred<boolean>();
    let authorized = true;
    const validate = vi.fn(async () => { began.resolve(); return await held.promise; });
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', validate, generate });
    const key = (await service.observe('pi-1'))!;
    const pending = service.request('pi-1', key, () => authorized);
    await began.promise;
    authorized = false;
    held.resolve(true);
    expect(await pending).toEqual({ status: 'denied' });
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // an ignored-abort selection read cannot escape the shared request deadline
  it('bounds a pending native barrier without dispatching after timeout', async () => {
    vi.useFakeTimers();
    const began = deferred<void>();
    const held = deferred<boolean>();
    let signal: AbortSignal | undefined;
    const validate = vi.fn(async (_source: ReplySuggestionSource, current: AbortSignal) => { signal = current; began.resolve(); return await held.promise; });
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', validate, generate });
    const key = (await service.observe('pi-1'))!;
    const pending = service.request('pi-1', key, () => true);
    await began.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(signal?.aborted).toBe(true);
    held.resolve(true);
    await vi.runAllTimersAsync();
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // dashboard observation resolves identity without spending an inference
  it('observes an opaque stable key without calling the provider', async () => {
    const generate = vi.fn(async () => replies);
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', generate });
    const key = await service.observe('pi-1');
    expect(key).toBeTypeOf('string');
    expect(key).not.toContain('own-login');
    expect(await service.observe('pi-1')).toBe(key);
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // unsupported auth and nonquestions never expose a generation key
  it('hides unavailable routes and statements without a generic fallback', async () => {
    const generate = vi.fn(async () => replies);
    let fingerprint: string | undefined;
    let current = source();
    const service = new ReplySuggestionService({ source: async () => current, routeFingerprint: async () => fingerprint, generate });
    expect(await service.observe('pi-1')).toBeUndefined();
    fingerprint = 'own-login-1';
    current = { ...source(), messages: [{ id: 'done', role: 'assistant', text: 'The local test is complete.' }] };
    expect(await service.observe('pi-1')).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    service.stop();
  });

  // duplicate authorized requests share one provider operation
  it('coalesces requests and caches one attempt for the current key', async () => {
    const began = deferred<void>();
    const held = deferred<typeof replies>();
    const generate = vi.fn(() => { began.resolve(); return held.promise; });
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', generate });
    const key = (await service.observe('pi-1'))!;
    const first = service.request('pi-1', key, () => true);
    const second = service.request('pi-1', key, () => true);
    await began.promise;
    expect(generate).toHaveBeenCalledTimes(1);
    held.resolve(replies);
    const expected = { status: 'ready', sourceKey: key, suggestions: replies };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(await service.request('pi-1', key, () => true)).toEqual(expected);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[2]).toBe('own-login-1');
    service.stop();
  });

  // account replacement cannot reuse a key even when text and model stay equal
  it('retires keys after credential-route changes and away-and-back transitions', async () => {
    let fingerprint = 'own-login-1';
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => fingerprint, generate: async () => replies });
    const first = (await service.observe('pi-1'))!;
    fingerprint = 'own-login-2';
    const second = await service.observe('pi-1');
    fingerprint = 'own-login-1';
    const third = await service.observe('pi-1');
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(await service.request('pi-1', first, () => true)).toEqual({ status: 'stale' });
    service.stop();
  });

  // changed response and native-dialog invalidation abort only background inference
  it.each(['response', 'unavailable', 'invalidate'] as const)('discards held output after %s', async change => {
    let current: ReplySuggestionSource | undefined = source();
    const began = deferred<void>();
    const held = deferred<typeof replies>();
    let signal!: AbortSignal;
    const service = new ReplySuggestionService({
      source: async () => current, routeFingerprint: async () => 'own-login-1',
      generate: async (_source, abort) => { signal = abort; began.resolve(); return await held.promise; }
    });
    const key = (await service.observe('pi-1'))!;
    const result = service.request('pi-1', key, () => true);
    await began.promise;
    // each change represents an independent source retirement path
    if (change === 'response') current = source('pi-1', 'turn-2');
    else if (change === 'unavailable') current = undefined;
    else service.invalidate('pi-1');
    // explicit invalidation is already enough to retire the prior operation
    if (change !== 'invalidate') await service.observe('pi-1');
    expect(signal.aborted).toBe(true);
    held.resolve(replies);
    expect(await result).toEqual({ status: 'stale' });
    service.stop();
  });

  // publication authority never comes from an old admission decision
  it('denies work and output when the initiating authority disappears', async () => {
    let allowed = false;
    const began = deferred<void>();
    const held = deferred<typeof replies>();
    const generate = vi.fn(() => { began.resolve(); return held.promise; });
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', generate });
    const key = (await service.observe('pi-1'))!;
    expect(await service.request('pi-1', key, () => allowed)).toEqual({ status: 'denied' });
    expect(generate).not.toHaveBeenCalled();
    allowed = true;
    const result = service.request('pi-1', key, () => allowed);
    await began.promise;
    allowed = false;
    held.resolve(replies);
    expect(await result).toEqual({ status: 'denied' });
    service.stop();
  });

  // failed output is memoized rather than replaced by generic or alternate work
  it('memoizes a provider failure without retries', async () => {
    const generate = vi.fn(async () => { throw new Error('private upstream detail'); });
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => 'own-login-1', generate });
    const key = (await service.observe('pi-1'))!;
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(await service.request('pi-1', key, () => true)).toEqual({ status: 'ready', sourceKey: key, suggestions: [] });
    expect(generate).toHaveBeenCalledTimes(1);
    service.stop();
  });

  // ignoring cancellation must not free capacity for an unbounded detached call
  it('enforces deadlines while quarantining unsettled provider slots', async () => {
    vi.useFakeTimers();
    const began = [deferred<void>(), deferred<void>()];
    const held = [deferred<typeof replies>(), deferred<typeof replies>()];
    const signals: AbortSignal[] = [];
    let calls = 0;
    const generate = vi.fn(async (_source: ReplySuggestionSource, signal: AbortSignal) => {
      const index = calls++;
      signals.push(signal);
      began[index]?.resolve();
      return await held[index]!.promise;
    });
    const service = new ReplySuggestionService({ source: async id => source(id), routeFingerprint: async () => 'own-login-1', generate });
    const firstKey = (await service.observe('pi-1'))!;
    const secondKey = (await service.observe('pi-2'))!;
    const first = service.request('pi-1', firstKey, () => true);
    const second = service.request('pi-2', secondKey, () => true);
    await Promise.all(began.map(item => item.promise));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toEqual({ status: 'ready', sourceKey: firstKey, suggestions: [] });
    expect(await second).toEqual({ status: 'ready', sourceKey: secondKey, suggestions: [] });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    const thirdKey = (await service.observe('pi-3'))!;
    expect(await service.request('pi-3', thirdKey, () => true)).toEqual({ status: 'ready', sourceKey: thirdKey, suggestions: [] });
    expect(generate).toHaveBeenCalledTimes(2);
    held[0]!.resolve(replies);
    held[1]!.resolve(replies);
    service.stop();
  });

  // a pending route lookup cannot restore an invalidated observation
  it('does not revive a key after removal during asynchronous observation', async () => {
    const began = deferred<void>();
    const route = deferred<string>();
    const service = new ReplySuggestionService({ source: async () => source(), routeFingerprint: async () => { began.resolve(); return await route.promise; }, generate: async () => replies });
    const pending = service.observe('pi-1');
    await began.promise;
    service.invalidate('pi-1');
    route.resolve('own-login-1');
    expect(await pending).toBeUndefined();
    service.stop();
  });
});
