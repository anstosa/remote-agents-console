import { describe, expect, it, vi } from 'vitest';
import { FederationAdmissionService, RemoteControllerPresenceService } from '../src/integrations/federation/index.js';

const secret = Buffer.alloc(32, 7).toString('base64url');
const origin = 'https://origin.example.com';
const target = 'https://target.example.com';
const owner = 'o'.repeat(43);

describe('remote controller presence', () => {
  it('requires signed proof and preserves it through failures only until receipt freshness expires', async () => {
    let now = 1_800_000_000_000;
    let controlled = true;
    let fail = false;
    const originAdmission = new FederationAdmissionService(secret, origin, new Set([target]), () => now);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fail) throw new Error('offline');
      const headers = new Headers(init?.headers);
      const request = JSON.parse(String(init?.body)) as unknown;
      const signed = originAdmission.issueControllerPresence(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), request, candidate => controlled && candidate === owner);
      if (signed === undefined) return new Response('', { status: 401 });
      return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
    });
    const service = new RemoteControllerPresenceService({ localInstanceId: target, localEpoch: 'e'.repeat(43), remoteServers: [{ name: 'Origin', url: new URL(origin) }], secret, fetch: fetcher as typeof fetch, now: () => now });

    await expect(service.admit(origin, owner)).resolves.toEqual({ ok: true });
    await expect(service.prove(origin, owner)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    fail = true;
    now += 14_999;
    await expect(service.prove(origin, owner)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 2;
    await expect(service.prove(origin, owner)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);

    fail = false;
    controlled = false;
    await expect(service.prove(origin, owner)).resolves.toBe(false);
    controlled = true;
    await expect(service.prove(origin, owner)).resolves.toBe(true);
  });

  it('batches simultaneous owners, refuses a third, and frees capacity explicitly', async () => {
    let requestedOwners: string[] = [];
    const originAdmission = new FederationAdmissionService(secret, origin, new Set([target]));
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const request = JSON.parse(String(init?.body)) as { owners: string[] };
      requestedOwners = request.owners;
      const signed = originAdmission.issueControllerPresence(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), request, () => true)!;
      return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
    });
    const service = new RemoteControllerPresenceService({ localInstanceId: target, localEpoch: 'e'.repeat(43), remoteServers: [{ name: 'Origin', url: new URL(origin) }], secret, fetch: fetcher as typeof fetch });
    const first = 'a'.repeat(43);
    const second = 'b'.repeat(43);
    const third = 'c'.repeat(43);

    await expect(Promise.all([service.prove(origin, first), service.prove(origin, second)])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestedOwners).toEqual([first, second]);
    await expect(service.admit(origin, third)).resolves.toEqual({ ok: false, code: 'owner_presence_capacity' });
    service.forget(origin, first);
    await expect(service.admit(origin, third)).resolves.toEqual({ ok: true });
  });
});
