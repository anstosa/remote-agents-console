import { describe, expect, it, vi } from 'vitest';
import { NativeReplySuggestionRuntime } from '../src/reply-suggestions/native-runtime.js';
import type { NativeAccountObservation, NativeGenerationResult, NativeProcessRunner } from '../src/reply-suggestions/native-process.js';
import type { NativeReplySuggestionSource, NativeReplyScope, PiReplySuggestionSource } from '../src/reply-suggestions/types.js';

const scope: NativeReplyScope = {
  kind: 'codex', program: '/native/codex', home: '/home/test', configDir: '/home/test/.codex',
  process: { pid: 101, startTime: '5001' }, fingerprint: 'scope-codex-1'
};

const source: NativeReplySuggestionSource = {
  kind: 'codex', transport: 'tmux', agentId: 'codex-1', identity: 'turn-1', sourceGeneration: 1, processGeneration: 1,
  runtimeGeneration: 'runtime-1', conversationId: '11111111-1111-4111-8111-111111111111',
  model: { model: 'gpt-native', effort: 'high' }, nativeModel: { provider: 'openai', id: 'gpt-native' }, nativeScope: scope,
  messages: [{ id: 'u1', role: 'user', text: 'Keep this local.' }, { id: 'a1', role: 'assistant', text: 'Use staging or production?' }]
};

// build one accepted sanitized account observation
const account = (logicalIdentity = 'a'.repeat(64), credentialGeneration = 'credential-1'): NativeAccountObservation => ({
  kind: 'codex', provider: 'openai', logicalIdentity, profile: 'chatgpt', model: 'gpt-native', effort: 'high',
  programVersion: 'codex-cli 0.169.0', capabilityGeneration: 'capability-1', credentialGeneration
});

// build one zero-effect terminal native result
const completed = (overrides: Partial<NativeGenerationResult> = {}): NativeGenerationResult => ({
  status: 'completed', kind: 'codex', provider: 'openai', model: 'gpt-native', effort: 'high',
  accountBefore: 'a'.repeat(64), accountAfter: 'a'.repeat(64),
  finalText: '{"suggestions":[{"label":"Use staging","text":"Use staging first."}]}',
  finalAnswerCount: 1, terminalStatus: 'completed', toolEvents: 0, rerouteEvents: 0, serverRequests: 0, errorEvents: 0,
  cleanupComplete: true, historyPersisted: false, ...overrides
});

// build one controllable sanitized native process port
function fixture(overrides: { observations?: NativeAccountObservation[]; result?: NativeGenerationResult; metadataTtlMs?: number } = {}) {
  const observations = overrides.observations ?? [account()];
  let index = 0;
  const inspect = vi.fn(async () => observations[Math.min(index++, observations.length - 1)]);
  const generate = vi.fn(async () => overrides.result ?? completed());
  let routeGeneration = 'route-generation-1';
  const runner: NativeProcessRunner = { policyGeneration: 'policy-1', routeGeneration: () => routeGeneration, inspect, generate };
  const inspectScope = vi.fn(async () => scope);
  const runtime = new NativeReplySuggestionRuntime({ runner, inspectScope, metadataTtlMs: overrides.metadataTtlMs ?? 0 });
  // expose one controlled helper-closure rotation
  const setRouteGeneration = (value: string) => { routeGeneration = value; };
  return { runtime, inspect, generate, inspectScope, setRouteGeneration };
}

describe('native reply suggestion runtime', () => {
  it('uses the exact native account, model and route with no fallback', async () => {
    const { runtime, generate } = fixture();
    const route = await runtime.routeFingerprint(source);
    expect(route).toBeDefined();
    await expect(runtime.generate(source, new AbortController().signal, route!)).resolves.toEqual([{ label: 'Use staging', text: 'Use staging first.' }]);
    expect(generate).toHaveBeenCalledWith(scope, source, expect.any(AbortSignal), 'a'.repeat(64), 'route-generation-1');
  });

  it('rejects pi and cross-kind sources before account inspection', async () => {
    const { runtime, inspect } = fixture();
    const pi: PiReplySuggestionSource = {
      kind: 'pi', transport: 'structured', agentId: 'pi-1', identity: 'pi-turn', sourceGeneration: 1, processGeneration: 1,
      runtimeGeneration: 'pi-runtime', conversationId: 'pi-conversation', model: { model: 'pi-model' },
      nativeModel: { provider: 'openai', id: 'pi-model', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }, messages: []
    };
    expect(await runtime.routeFingerprint(pi)).toBeUndefined();
    expect(await runtime.generate(pi, new AbortController().signal, 'route')).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();

    const crossed = { ...source, kind: 'claude', nativeModel: { provider: 'anthropic', id: 'gpt-native' } } as NativeReplySuggestionSource;
    expect(await runtime.routeFingerprint(crossed)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['model substitution', { model: 'fallback' }],
    ['provider substitution', { provider: 'anthropic' as const }],
    ['tool event', { toolEvents: 1 }],
    ['reroute event', { rerouteEvents: 1 }],
    ['server callback', { serverRequests: 1 }],
    ['native error', { errorEvents: 1 }],
    ['extra final answer', { finalAnswerCount: 2 }],
    ['account replacement', { accountAfter: 'b'.repeat(64) }],
    ['history persistence', { historyPersisted: true }],
    ['cleanup failure', { cleanupComplete: false }],
    ['malformed schema', { finalText: '{"suggestions":[],"extra":true}' }]
  ])('rejects %s without another route', async (_label, override) => {
    const { runtime, generate } = fixture({ result: completed(override) });
    const route = (await runtime.routeFingerprint(source))!;
    expect(await runtime.generate(source, new AbortController().signal, route)).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported native account or source selection before inference', async () => {
    const unsupported = account();
    unsupported.profile = 'claude-pro';
    const { runtime, generate } = fixture({ observations: [unsupported] });
    expect(await runtime.routeFingerprint(source)).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('retires credential refreshes and fences account aba transitions', async () => {
    const same = fixture({ observations: [account('a'.repeat(64), 'credential-1'), account('a'.repeat(64), 'credential-2')] });
    const first = await same.runtime.routeFingerprint(source);
    const refreshed = await same.runtime.routeFingerprint(source);
    expect(refreshed).not.toBe(first);

    const aba = fixture({ observations: [account('a'.repeat(64)), account('b'.repeat(64)), account('a'.repeat(64))] });
    const before = await aba.runtime.routeFingerprint(source);
    const other = await aba.runtime.routeFingerprint(source);
    const returned = await aba.runtime.routeFingerprint(source);
    expect(other).not.toBe(before);
    expect(returned).not.toBe(before);
  });

  it('coalesces stable dashboard metadata and retires helper generation changes', async () => {
    const active = fixture({ metadataTtlMs: 60_000 });
    const first = await active.runtime.routeFingerprint(source);
    expect(await active.runtime.routeFingerprint(source)).toBe(first);
    expect(active.inspect).toHaveBeenCalledTimes(1);
    active.setRouteGeneration('route-generation-2');
    expect(await active.runtime.routeFingerprint(source)).not.toBe(first);
    expect(active.inspect).toHaveBeenCalledTimes(2);
  });

  it('accepts a Claude selected alias only with the exact resolved native model', async () => {
    const claudeScope = { ...scope, kind: 'claude' as const, fingerprint: 'scope-claude-1' };
    const claudeSource: NativeReplySuggestionSource = {
      ...source, kind: 'claude', nativeScope: claudeScope,
      model: { model: 'default', effort: 'high' }, nativeModel: { provider: 'anthropic', id: 'claude-opus-4-5' }
    };
    const observation: NativeAccountObservation = {
      ...account(), kind: 'claude', provider: 'anthropic', profile: 'claude-pro', model: 'claude-opus-4-5'
    };
    const result = completed({ kind: 'claude', provider: 'anthropic', model: 'claude-opus-4-5' });
    const active = fixture({ observations: [observation], result });
    active.inspectScope.mockResolvedValue(claudeScope);
    const route = await active.runtime.routeFingerprint(claudeSource);
    expect(route).toBeDefined();
    await expect(active.runtime.generate(claudeSource, new AbortController().signal, route!)).resolves.toHaveLength(1);
  });

  it('aborts owned metadata helpers and rejects work after shutdown', async () => {
    let aborted = false;
    const inspect = vi.fn(async (_scope: NativeReplyScope, _source: NativeReplySuggestionSource, signal: AbortSignal) => await new Promise<NativeAccountObservation | undefined>(resolve => {
      // resolve only when runtime shutdown reaches this helper
      signal.addEventListener('abort', () => { aborted = true; resolve(undefined); }, { once: true });
    }));
    const runner: NativeProcessRunner = {
      policyGeneration: 'policy-1', routeGeneration: () => 'route-generation-1', inspect,
      generate: vi.fn(async () => completed())
    };
    const runtime = new NativeReplySuggestionRuntime({ runner, inspectScope: async () => scope });
    const pending = runtime.routeFingerprint(source);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    runtime.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(await runtime.routeFingerprint(source)).toBeUndefined();
  });

  it('does not dispatch after cancellation or a changed process scope', async () => {
    const active = fixture();
    const route = (await active.runtime.routeFingerprint(source))!;
    const controller = new AbortController();
    controller.abort();
    expect(await active.runtime.generate(source, controller.signal, route)).toEqual([]);
    expect(active.generate).not.toHaveBeenCalled();

    const changed = fixture();
    changed.inspectScope.mockResolvedValue({ ...scope, fingerprint: 'replacement-process' });
    expect(await changed.runtime.routeFingerprint(source)).toBeUndefined();
    expect(changed.inspect).not.toHaveBeenCalled();
  });
});
