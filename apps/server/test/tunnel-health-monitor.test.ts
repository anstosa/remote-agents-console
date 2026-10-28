import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeTunnelRoute, TunnelHealthMonitor, type TunnelProbe } from '../src/settings/tunnel-health.js';

// return one queued probe sequence
function sequence(values: TunnelProbe[]) {
  let index = 0;
  return vi.fn(async () => values[Math.min(index++, values.length - 1)]!);
}

describe('continuous tunnel health monitor', () => {
  // distinguish transient capability loss from authoritative decommission
  it('latches degradation only across transient tunnel unavailability', async () => {
    const transient = sequence([
      { outcome: 'unavailable', canReconnect: false },
      { outcome: 'public-failed', canReconnect: true },
      { outcome: 'identity-mismatch', canReconnect: true },
      { outcome: 'unavailable', canReconnect: false },
      { outcome: 'healthy', canReconnect: true }
    ]);
    const monitor = new TunnelHealthMonitor(transient, { now: () => Date.parse('2026-10-28T20:00:00.000Z') });

    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'disabled', failures: 0, canReconnect: false });
    await monitor.checkNow();
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'degraded', failures: 2, error: 'tunnel_identity_mismatch', canReconnect: true });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'degraded', failures: 2, error: 'tunnel_identity_mismatch', canReconnect: false });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'healthy', failures: 0, canReconnect: true });

    const decommissioned = sequence([
      { outcome: 'public-failed', canReconnect: true },
      { outcome: 'public-failed', canReconnect: true },
      { outcome: 'disabled', canReconnect: false }
    ]);
    const disabled = new TunnelHealthMonitor(decommissioned);
    await disabled.checkNow();
    await disabled.checkNow();
    await disabled.checkNow();
    expect(disabled.snapshot()).toMatchObject({ state: 'disabled', failures: 0, canReconnect: false });
  });

  // require consecutive public failures around healthy origin evidence
  it('does not bridge the degradation threshold across origin downtime', async () => {
    const probe = sequence([
      { outcome: 'public-failed', canReconnect: true },
      { outcome: 'origin-failed', canReconnect: true },
      { outcome: 'public-failed', canReconnect: true }
    ]);
    const monitor = new TunnelHealthMonitor(probe, { now: () => Date.parse('2026-10-28T20:00:00.000Z') });

    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 1, error: 'tunnel_unreachable' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 0, error: 'origin_unavailable' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 1, error: 'tunnel_unreachable' });
  });

  // require consecutive public failures around monitor exceptions
  it('does not bridge the degradation threshold across a probe exception', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ outcome: 'public-failed', canReconnect: true })
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce({ outcome: 'public-failed', canReconnect: true });
    const monitor = new TunnelHealthMonitor(probe, { now: () => Date.parse('2026-10-28T20:00:00.000Z') });

    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 1, error: 'tunnel_unreachable' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 0, error: 'origin_unavailable' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', failures: 1, error: 'tunnel_unreachable' });
  });

  // latch proved degradation until exact public identity recovers
  it('degrades after two failures, survives origin uncertainty, and clears on proof', async () => {
    const probe = sequence([
      { outcome: 'public-failed', canReconnect: true },
      { outcome: 'identity-mismatch', canReconnect: true },
      { outcome: 'origin-failed', canReconnect: true },
      { outcome: 'healthy', canReconnect: true }
    ]);
    const monitor = new TunnelHealthMonitor(probe, { now: () => Date.parse('2026-10-28T20:00:00.000Z') });

    await monitor.checkNow(); await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'degraded', failures: 2, error: 'tunnel_identity_mismatch' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toMatchObject({ state: 'degraded', failures: 2, error: 'tunnel_identity_mismatch' });
    await monitor.checkNow();
    expect(monitor.snapshot()).toEqual({ state: 'healthy', checkedAt: '2026-10-28T20:00:00.000Z', lastHealthyAt: '2026-10-28T20:00:00.000Z', failures: 0, reconnecting: false, canReconnect: true });
  });

  // coalesce a slow probe instead of overlapping checks
  it('runs at most one check at a time', async () => {
    let finish: ((value: TunnelProbe) => void) | undefined;
    const probe = vi.fn(async () => await new Promise<TunnelProbe>(resolve => { finish = resolve; }));
    const monitor = new TunnelHealthMonitor(probe);

    const first = monitor.checkNow();
    await monitor.checkNow();
    expect(probe).toHaveBeenCalledTimes(1);
    finish!({ outcome: 'healthy', canReconnect: true });
    await first;
    expect(monitor.snapshot()).toMatchObject({ state: 'healthy' });
  });

  // bound stalled dns and allow the next scheduled probe
  it('recovers from a resolver that never settles', async () => {
    const local = vi.fn(async () => new Response(JSON.stringify({ ok: true, proof: 'a'.repeat(64) }), { status: 200 }));
    const probe = vi.fn(async () => await probeTunnelRoute({ localOrigin: 'http://127.0.0.1:8787', hostname: 'agents.example.com' }, {
      fetch: local,
      lookup: async () => await new Promise<never>(() => {}),
      timeoutMs: 25
    }));
    const monitor = new TunnelHealthMonitor(probe);

    await monitor.checkNow();
    await monitor.checkNow();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(monitor.snapshot()).toMatchObject({ state: 'degraded', failures: 2, error: 'tunnel_unreachable' });
  });

  // reject every nonpublic or ambiguous dns answer before tls
  it.each([
    ['loopback ipv4', [{ address: '127.0.0.1', family: 4 }]],
    ['rfc1918 ipv4', [{ address: '10.20.30.40', family: 4 }]],
    ['link-local ipv4', [{ address: '169.254.10.20', family: 4 }]],
    ['mapped ipv6', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    ['translation ipv6', [{ address: '64:ff9b:1::7f00:1', family: 6 }]],
    ['transition ipv6', [{ address: '2002:7f00:1::', family: 6 }]],
    ['mixed public and private', [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.2', family: 4 }]],
    ['malformed address', [{ address: 'not-an-ip', family: 4 }]],
    ['mislabeled family', [{ address: '8.8.8.8', family: 6 }]]
  ] as const)('rejects %s dns answers without a public request', async (_name, records) => {
    const local = vi.fn(async () => new Response(JSON.stringify({ ok: true, proof: 'a'.repeat(64) }), { status: 200 }));
    const requester = vi.fn();

    await expect(probeTunnelRoute({ localOrigin: 'http://127.0.0.1:8787', hostname: 'agents.example.com' }, {
      fetch: local,
      lookup: async () => [...records],
      httpsRequest: requester as never
    })).resolves.toEqual({ outcome: 'public-failed', canReconnect: true });
    expect(requester).not.toHaveBeenCalled();
  });

  // pin proof to the exact configured public port and host
  it('checks the exact nondefault public origin', async () => {
    let requested: Record<string, unknown> | undefined;
    let pinnedAddresses: unknown;
    let publicChallenge: string | null = null;
    let localChallenge: string | null = null;
    // emulate one pinned tls response
    const requester = ((options: Record<string, unknown>, receive: (response: EventEmitter & { statusCode: number }) => void) => {
      requested = options;
      const pinnedLookup = options.lookup as (hostname: string, lookupOptions: { all: boolean }, callback: (error: Error | null, addresses: unknown) => void) => void;
      // exercise the deployed node address-list lookup form
      pinnedLookup('agents.example.com', { all: true }, (_error, addresses) => { pinnedAddresses = addresses; });
      const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
      const request = Object.assign(new EventEmitter(), {
        // deliver one complete challenged response after handlers attach
        end: () => {
          receive(response);
          publicChallenge = new URL(`https://agents.example.com${String(options.path)}`).searchParams.get('racChallenge');
          response.emit('data', Buffer.from(JSON.stringify({ ok: true, proof: publicChallenge })));
          response.emit('end');
        },
        destroy: vi.fn()
      });
      return request;
    }) as never;
    // echo the local boot challenge
    const local = vi.fn(async (url: string | URL | Request) => {
      localChallenge = new URL(String(url)).searchParams.get('racChallenge');
      return new Response(JSON.stringify({ ok: true, proof: localChallenge }), { status: 200 });
    });
    // resolve one fixed public address
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];

    const outcome = await probeTunnelRoute({ localOrigin: 'http://127.0.0.1:8787', hostname: 'agents.example.com', port: 8443 }, {
      fetch: local as typeof fetch,
      lookup,
      httpsRequest: requester
    });
    expect(requested).toBeDefined();
    expect(publicChallenge).toBe(localChallenge);
    expect(outcome).toEqual({ outcome: 'healthy', canReconnect: true });
    expect(pinnedAddresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(requested).toMatchObject({ hostname: 'agents.example.com', servername: 'agents.example.com', port: 8443, headers: { host: 'agents.example.com:8443' } });
  });

  // lock the default cadence, no-overlap, and exact timer cleanup
  it('runs one nonoverlapping check every fifteen seconds and clears its timer', async () => {
    const finishes: Array<(value: TunnelProbe) => void> = [];
    const probe = vi.fn(async () => await new Promise<TunnelProbe>(resolve => { finishes.push(resolve); }));
    let scheduled: (() => void) | undefined;
    let delay: number | undefined;
    const timer = { unref: vi.fn() };
    // capture one production interval registration
    const setInterval = vi.fn((callback: () => void, interval: number) => { scheduled = callback; delay = interval; return timer; }) as never;
    const clearInterval = vi.fn();
    const monitor = new TunnelHealthMonitor(probe, { setInterval, clearInterval: clearInterval as never });

    monitor.start();
    expect(delay).toBe(15_000);
    expect(probe).toHaveBeenCalledTimes(1);
    scheduled!();
    expect(probe).toHaveBeenCalledTimes(1);
    finishes.shift()!({ outcome: 'healthy', canReconnect: true });
    await vi.waitFor(() => expect(monitor.snapshot().state).toBe('healthy'));
    scheduled!();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    monitor.stop();
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(timer);
    finishes.shift()!({ outcome: 'public-failed', canReconnect: true });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    expect(monitor.snapshot().state).toBe('healthy');
  });
});
