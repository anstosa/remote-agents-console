import { describe, expect, it, vi } from 'vitest';
import {
  DavoProviderCalls,
  ProviderRequestNotSentError,
  type DavoProviderCallPersistence,
  type DavoProviderCallPersistenceState
} from '../src/davo/provider-calls.js';

// create one serialized in-memory port
function persistence(initial: DavoProviderCallPersistenceState = { providerCalls: [] }) {
  let state = structuredClone(initial);
  const snapshots: DavoProviderCallPersistenceState[] = [];
  const port: DavoProviderCallPersistence = {
    mode: 0o600,
    read: async () => structuredClone(state),
    mutate: async mutation => {
      const next = mutation(structuredClone(state));
      state = structuredClone(next.state);
      snapshots.push(structuredClone(state));
      return next.result;
    }
  };
  return { port, snapshots, state: () => structuredClone(state) };
}

const negotiation = {
  voiceSessionId: 'voice-1',
  ownerHash: 'owner-hash',
  generation: 7,
  hardCutoffAt: '2026-11-06T11:00:00.000Z',
  offer: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1',
  session: { model: 'gpt-realtime-2.1' }
};
const creationFenceUntil = '2026-11-05T23:00:15.000Z';

// create one exact persisted call record
function call(overrides: Partial<DavoProviderCallPersistenceState['providerCalls'][number]> = {}): DavoProviderCallPersistenceState['providerCalls'][number] {
  return {
    callId: 'rtc_test123',
    voiceSessionId: 'voice-1',
    ownerHash: 'owner',
    generation: 7,
    hardCutoffAt: '2026-11-07T11:00:00.000Z',
    createdAt: '2026-11-05T22:00:00.000Z',
    providerMaximumEndsAt: '2026-11-05T23:00:00.000Z',
    hangup: { state: 'ready', definitelyNotSentRetries: 0 },
    ...overrides
  };
}

describe('DavoProviderCalls', () => {
  // preserve private failure details behind fixed diagnostics
  it.each(['transport', 'rejection'] as const)('logs content-free %s diagnostics without clearing uncertainty', async failure => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = persistence();
      const response = new Response('private provider body with standard-key and SDP', { status: 429 });
      const readBody = vi.spyOn(response, 'text');
      // simulate failure at the real transport boundary
      const provider = vi.fn(async () => {
        // keep exception details out of diagnostics
        if (failure === 'transport') throw new Error('private socket error with standard-key and SDP');
        return response;
      });
      const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

      await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_unavailable' });
      expect(warning.mock.calls).toEqual(failure === 'transport'
        ? [['[davo] provider create transport failed']]
        : [['[davo] provider create rejected', { status: 429 }]]);
      expect(readBody).not.toHaveBeenCalled();
      expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
      await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('registers the trusted provider call before returning the SDP answer', async () => {
    const store = persistence();
    const provider = vi.fn(async () => new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_trusted123' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'v=0\r\nanswer' });
    expect(store.state().providerCalls).toEqual([expect.objectContaining({ voiceSessionId: 'voice-1', ownerHash: 'owner-hash', generation: 7, callId: 'rtc_trusted123', hangup: { state: 'ready', definitelyNotSentRetries: 0 } })]);
    expect(store.snapshots.some(state => state.providerCalls[0]?.callId === 'rtc_trusted123')).toBe(true);
    const [url, init] = provider.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer standard-key' } });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('sdp')).toBe(negotiation.offer);
    expect(JSON.parse(String((init.body as FormData).get('session')))).toEqual({ model: 'gpt-realtime-2.1' });
    expect(JSON.stringify(store.snapshots)).not.toContain(negotiation.offer);
  });

  it('anchors trusted call lifetime to the observed provider response', async () => {
    const store = persistence();
    let now = new Date('2026-11-05T22:00:00.000Z');
    const provider = vi.fn(async () => {
      now = new Date('2026-11-05T22:00:10.000Z');
      return new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_delayed_success' } });
    });
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => now, requestTimeoutMs: 15_000, providerMaximumMs: 60 * 60 * 1000 });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'answer' });
    expect(store.state().providerCalls[0]).toMatchObject({
      createdAt: '2026-11-05T22:00:10.000Z',
      providerMaximumEndsAt: '2026-11-05T23:00:10.000Z'
    });
  });

  it('rejects untrusted Locations and never exposes provider authority', async () => {
    const store = persistence();
    const provider = vi.fn(async () => new Response('secret answer', { status: 201, headers: { location: 'https://evil.example/v1/realtime/calls/rtc_stolen' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    const result = await calls.negotiate(negotiation);
    expect(result).toEqual({ ok: false, code: 'davo_provider_control_unsupported' });
    expect(JSON.stringify(result)).not.toContain('rtc_');
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
  });

  it.each([
    ['non-success', async () => new Response(null, { status: 503 })],
    ['timeout', async () => { throw new Error('cleanup timed out'); }]
  ])('quarantines a created call after %s immediate cleanup', async (_label, cleanup) => {
    const store = persistence();
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 201, headers: { location: '/v1/realtime/calls/rtc_uncertain123' } }))
      .mockImplementationOnce(cleanup);
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_control_unsupported' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
    expect(JSON.stringify(store.state())).not.toContain('rtc_uncertain123');
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
  });

  it('allows a successor only after proven immediate cleanup', async () => {
    const store = persistence();
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 201, headers: { location: '/v1/realtime/calls/rtc_cleaned123' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_successor123' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_control_unsupported' });
    expect(store.state()).toEqual({ providerCalls: [] });
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'answer' });
  });

  it('proves cleanup after an unreadable provider answer', async () => {
    const store = persistence();
    const unreadable = { ok: true, headers: new Headers({ location: '/v1/realtime/calls/rtc_unreadable123' }), text: async () => { throw new Error('body unreadable'); } } as Response;
    const provider = vi.fn().mockResolvedValueOnce(unreadable).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_unavailable' });
    expect(store.state()).toEqual({ providerCalls: [] });
    expect(provider.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/realtime/calls/rtc_unreadable123/hangup');
  });

  it('does not create a call when the pre-transport fence cannot persist', async () => {
    let mutations = 0;
    const port: DavoProviderCallPersistence = {
      mode: 0o600,
      read: async () => ({ providerCalls: [] }),
      mutate: async mutation => {
        mutations += 1;
        // allow the quarantine availability check
        if (mutations === 1) return mutation({ providerCalls: [] }).result;
        throw new Error('disk included secret key standard-key');
      }
    };
    const provider = vi.fn().mockResolvedValueOnce(new Response('answer must stay private', { status: 201, headers: { location: '/v1/realtime/calls/rtc_cleanup123' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: port, fetch: provider as typeof fetch });

    const result = await calls.negotiate(negotiation);
    expect(result).toEqual({ ok: false, code: 'davo_store_unavailable' });
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('standard-key');
    expect(JSON.stringify(result)).not.toContain('rtc_cleanup123');
  });

  it('keeps an in-memory fence when pre-transport persistence fails', async () => {
    let mutations = 0;
    const port: DavoProviderCallPersistence = {
      mode: 0o600,
      read: async () => ({ providerCalls: [] }),
      mutate: async mutation => {
        mutations += 1;
        // allow only the initial availability claim
        if (mutations === 1) return mutation({ providerCalls: [] }).result;
        throw new Error('store unavailable');
      }
    };
    const provider = vi.fn().mockResolvedValueOnce(new Response('private answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_memory123' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_store_unavailable' });
    await expect(calls.recover()).resolves.toEqual({ ok: false, code: 'davo_store_unavailable' });
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_store_unavailable' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('persists a fence after registration failure and ambiguous cleanup', async () => {
    let mutations = 0;
    let state: DavoProviderCallPersistenceState = { providerCalls: [] };
    const port: DavoProviderCallPersistence = {
      mode: 0o600,
      read: async () => structuredClone(state),
      mutate: async mutation => {
        mutations += 1;
        // fail only the private call registration write after the creation fence
        if (mutations === 3) throw new Error('registration unavailable');
        const next = mutation(structuredClone(state));
        state = structuredClone(next.state);
        return next.result;
      }
    };
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response('private answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_durablefence123' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_store_unavailable' });
    expect(state).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
    expect(JSON.stringify(state)).not.toContain('rtc_durablefence123');
  });

  it('quarantines an ambiguous create before transport and restart never retries it', async () => {
    const store = persistence();
    const provider = vi.fn().mockRejectedValueOnce(new Error('socket timeout after send'));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_unavailable' });
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
    const recovered = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:05:00.000Z') });
    await expect(recovered.recover()).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    await expect(recovered.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('covers delayed ambiguous creation through timeout plus provider lifetime', async () => {
    const store = persistence();
    let now = new Date('2026-11-05T22:00:00.000Z');
    const provider = vi.fn()
      .mockImplementationOnce(async () => {
        now = new Date('2026-11-05T22:00:15.000Z');
        throw new Error('socket failed after delayed send');
      })
      .mockResolvedValueOnce(new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_after_delayed_fence' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => now, requestTimeoutMs: 15_000, providerMaximumMs: 60 * 60 * 1000 });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_unavailable' });
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
    now = new Date('2026-11-05T23:00:14.999Z');
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(provider).toHaveBeenCalledTimes(1);
    now = new Date('2026-11-05T23:00:15.001Z');
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'answer' });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('clears only proven not-sent create fences', async () => {
    const store = persistence();
    const provider = vi.fn()
      .mockRejectedValueOnce(new ProviderRequestNotSentError())
      .mockResolvedValueOnce(new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_after_not_sent' } }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_unavailable' });
    expect(store.state()).toEqual({ providerCalls: [] });
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'answer' });
    expect(store.state().providerCalls[0]?.callId).toBe('rtc_after_not_sent');
  });

  it('persists content-free quarantine before cleanup and recovery never retries it', async () => {
    const store = persistence();
    let providerCalls = 0;
    const provider = vi.fn(async () => {
      providerCalls += 1;
      // expose the created call on the first provider request
      if (providerCalls === 1) return new Response('', { status: 201, headers: { location: '/v1/realtime/calls/rtc_crashseam123' } });
      // require durable quarantine before the hangup side effect
      expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: creationFenceUntil });
      expect(JSON.stringify(store.snapshots.at(-1))).not.toContain('rtc_crashseam123');
      return new Response(null, { status: 503 });
    });
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:00:00.000Z') });

    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_control_unsupported' });
    expect(provider).toHaveBeenCalledTimes(2);
    const recovered = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:05:00.000Z') });
    await expect(recovered.recover()).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('persists dispatching before hangup and removes an accepted handle', async () => {
    const store = persistence();
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_live123' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch });
    await calls.negotiate(negotiation);

    await expect(calls.stop({ voiceSessionId: 'voice-1', generation: 7 })).resolves.toEqual({ ok: true, status: 'closed' });
    expect(store.snapshots.some(state => state.providerCalls[0]?.hangup.state === 'prepared')).toBe(true);
    expect(store.snapshots.some(state => state.providerCalls[0]?.hangup.state === 'dispatching')).toBe(true);
    expect(store.state()).toEqual({ providerCalls: [] });
  });

  it('does not let an old stop close a replacement generation', async () => {
    const store = persistence({ providerCalls: [call({ callId: 'rtc_new123', generation: 8 })] });
    const provider = vi.fn();
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch });

    await expect(calls.stop({ voiceSessionId: 'voice-1', generation: 7 })).resolves.toEqual({ ok: true, status: 'absent' });
    expect(provider).not.toHaveBeenCalled();
    expect(store.state().providerCalls).toHaveLength(1);
  });

  it('retries only a proven not-sent live attempt once', async () => {
    const store = persistence({ providerCalls: [call({ callId: 'rtc_retry123' })] });
    const provider = vi.fn().mockRejectedValueOnce(new ProviderRequestNotSentError()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch });

    await expect(calls.stop({ voiceSessionId: 'voice-1', generation: 7 })).resolves.toEqual({ ok: true, status: 'closed' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(store.state().providerCalls).toEqual([]);
  });

  it('quarantines ambiguous sends and blocks successors until expiry', async () => {
    let now = new Date('2026-11-05T22:10:00.000Z');
    const store = persistence({ providerCalls: [call({ callId: 'rtc_ambiguous123' })] });
    const provider = vi.fn().mockRejectedValueOnce(new Error('socket timeout'));
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => now });

    await expect(calls.stop({ voiceSessionId: 'voice-1', generation: 7 })).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: '2026-11-05T23:00:00.000Z' });
    expect(JSON.stringify(store.state())).not.toContain('rtc_');
    await expect(calls.recover()).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(provider).toHaveBeenCalledTimes(1);

    now = new Date('2026-11-05T23:00:00.001Z');
    provider.mockResolvedValueOnce(new Response('answer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_after123' } }));
    await expect(calls.negotiate(negotiation)).resolves.toEqual({ ok: true, answer: 'answer' });
    expect(store.state().providerQuarantineUntil).toBeUndefined();
  });

  it('recovers dispatching as ambiguity without replay', async () => {
    const store = persistence({ providerCalls: [call({ callId: 'rtc_crashed123', hangup: { state: 'dispatching', attemptId: 'attempt-1', attemptedAt: '2026-11-05T22:05:00.000Z', definitelyNotSentRetries: 0 } })] });
    const provider = vi.fn();
    const calls = new DavoProviderCalls({ apiKey: 'standard-key', persistence: store.port, fetch: provider as typeof fetch, now: () => new Date('2026-11-05T22:10:00.000Z') });

    await expect(calls.recover()).resolves.toEqual({ ok: false, code: 'davo_provider_hangup_ambiguous' });
    expect(provider).not.toHaveBeenCalled();
    expect(store.state()).toEqual({ providerCalls: [], providerQuarantineUntil: '2026-11-05T23:00:00.000Z' });
  });
});
