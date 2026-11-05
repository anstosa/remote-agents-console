import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationAdmissionService, federationForwarder, signFederationBody, verifyControllerPresenceResponse, type ControllerPresenceRequest, type FederationPayload } from '../src/integrations/federation/index.js';

const secret = Buffer.alloc(32, 9).toString('base64url');
const origin = 'https://local.example.com';
const destination = 'https://peer.example.com';

afterEach(() => { vi.useRealTimers(); });

// build one valid delegation for admission tests
function payload(epoch: string, nonce = 'n'.repeat(22), now = Date.now()): FederationPayload {
  return { version: 2, origin_instance_id: origin, destination_instance_id: destination, destination_epoch: epoch, nonce, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 15_000).toISOString(), audience: { kind: 'oauth', subject_id: 'user', client_id: 'chatgpt', scopes: ['status:read'] }, name: 'list_agents', arguments: {} };
}

describe('integration federation', () => {
  it('discovers a signed epoch and forwards a tagged delegation without bearer material', async () => {
    const target = new FederationAdmissionService(secret, destination, new Set([origin]));
    let admitted: FederationPayload | undefined;
    let metadataCalls = 0;
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as unknown;
      expect(headers.has('authorization')).toBe(false);
      if (requestUrl.endsWith('/metadata')) {
        metadataCalls += 1;
        const signed = target.issueEpochMetadata(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
        if (signed === undefined) return new Response('', { status: 401 });
        return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
      }
      const verified = target.verifyDelegation(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return new Response('', { status: 503 });
      admitted = verified.payload;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }), { status: 200 });
    };
    const forward = federationForwarder([{ name: 'Peer', url: new URL(destination) }], secret, origin, fetcher as typeof fetch);
    let authorityChecks = 0;
    const result = await forward(destination, { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: `${origin}/mcp`, scopes: ['status:read'] }, 'list_agents', {}, { authorize: () => { authorityChecks += 1; return true; } });
    await expect(forward(destination, { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: `${origin}/mcp`, scopes: ['status:read'] }, 'list_agents', {}, { authorize: () => { authorityChecks += 1; return true; } })).resolves.toBeDefined();
    expect(result?.structuredContent).toEqual({ ok: true });
    expect(admitted).toMatchObject({ version: 2, audience: { kind: 'oauth', subject_id: 'user', client_id: 'chatgpt', scopes: ['status:read'] }, name: 'list_agents' });
    expect(JSON.stringify(admitted)).not.toContain('authorization');
    expect(authorityChecks).toBe(2);
    expect(metadataCalls).toBe(1);
  });

  it('namespaces verified Realtime owners and leases by origin and target', () => {
    const otherOrigin = 'https://other.example.com';
    const target = new FederationAdmissionService(secret, destination, new Set([origin, otherOrigin]));
    const rawOwner = 'o'.repeat(43);
    const rawLease = 'l'.repeat(43);
    const issuedAt = Date.now();
    const create = (source: string, nonce: string): FederationPayload => ({ ...payload(target.destinationEpoch, nonce, issuedAt), origin_instance_id: source, audience: { kind: 'realtime', stable_owner_key: rawOwner, lease_key: rawLease, lease_expires_at: issuedAt + 15_000, scopes: ['status:read'] } });
    const first = create(origin, 'a'.repeat(22));
    const second = create(otherOrigin, 'b'.repeat(22));
    const signedFirst = signFederationBody(secret, first);
    const signedSecond = signFederationBody(secret, second);
    const admittedFirst = target.verifyDelegation(signedFirst.timestamp, signedFirst.signature, first);
    const admittedSecond = target.verifyDelegation(signedSecond.timestamp, signedSecond.signature, second);
    expect(admittedFirst.ok).toBe(true);
    expect(admittedSecond.ok).toBe(true);
    if (!admittedFirst.ok || !admittedSecond.ok) throw new Error('delegation unavailable');
    expect(admittedFirst.principal.stableOwnerKey).not.toBe(rawOwner);
    expect(admittedFirst.principal.leaseKey).not.toBe(rawLease);
    expect(admittedFirst.principal.stableOwnerKey).not.toBe(admittedSecond.principal.stableOwnerKey);
    expect(admittedFirst.principal.leaseKey).not.toBe(admittedSecond.principal.leaseKey);
    expect(admittedFirst.principal.federated?.originStableOwnerKey).toBe(rawOwner);
  });

  it('caps a signed Realtime delegation at the authenticated lease expiry', async () => {
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    const leaseExpiresAt = now + 4_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const target = new FederationAdmissionService(secret, destination, new Set([origin]));
    let admitted: Extract<FederationPayload['audience'], { kind: 'realtime' }> | undefined;
    let reconstructedExpiresAt: number | undefined;
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as FederationPayload;
      if (String(url).endsWith('/metadata')) {
        const signed = target.issueEpochMetadata(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
        if (signed === undefined) return new Response('', { status: 401 });
        return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
      }
      const verified = target.verifyDelegation(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
      if (!verified.ok) return new Response('', { status: 503 });
      admitted = verified.payload.audience as Extract<FederationPayload['audience'], { kind: 'realtime' }>;
      reconstructedExpiresAt = verified.principal.expiresAt;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }), { status: 200 });
    };
    const forward = federationForwarder([{ name: 'Peer', url: new URL(destination) }], secret, origin, fetcher as typeof fetch);
    await expect(forward(destination, { authentication: 'realtime', subjectId: 'voice', stableOwnerKey: 'o'.repeat(43), leaseKey: 'l'.repeat(43), expiresAt: leaseExpiresAt, audience: 'realtime', scopes: ['status:read'] }, 'list_agents', {}, { authorize: () => true })).resolves.toBeDefined();
    expect(admitted).toMatchObject({ kind: 'realtime', lease_expires_at: leaseExpiresAt });
    expect(reconstructedExpiresAt).toBe(leaseExpiresAt);
  });

  it('admits one issued Realtime call only inside its lease-capped window', () => {
    const issuedAt = Date.parse('2026-11-05T00:00:00.000Z');
    const leaseExpiresAt = issuedAt + 4_000;
    let now = issuedAt + 3_999;
    const target = new FederationAdmissionService(secret, destination, new Set([origin]), () => now);
    const realtime = (nonce: string, expiresAt: number): FederationPayload => ({ ...payload(target.destinationEpoch, nonce, issuedAt), expires_at: new Date(expiresAt).toISOString(), audience: { kind: 'realtime', stable_owner_key: 'o'.repeat(43), lease_key: 'l'.repeat(43), lease_expires_at: leaseExpiresAt, scopes: ['status:read'] } });
    const inside = realtime('a'.repeat(22), leaseExpiresAt);
    const signedInside = signFederationBody(secret, inside, issuedAt);
    expect(target.verifyDelegation(signedInside.timestamp, signedInside.signature, inside)).toMatchObject({ ok: true, principal: { expiresAt: leaseExpiresAt, federated: { expiresAt: leaseExpiresAt } } });
    const widened = realtime('b'.repeat(22), issuedAt + 15_000);
    const signedWidened = signFederationBody(secret, widened, issuedAt);
    expect(target.verifyDelegation(signedWidened.timestamp, signedWidened.signature, widened)).toMatchObject({ ok: false, reason: 'invalid' });
    now = leaseExpiresAt;
    const expired = realtime('c'.repeat(22), leaseExpiresAt);
    const signedExpired = signFederationBody(secret, expired, issuedAt);
    expect(target.verifyDelegation(signedExpired.timestamp, signedExpired.signature, expired)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects replay, old process epochs, and saturation without live eviction', () => {
    let now = 1_800_000_000_000;
    const target = new FederationAdmissionService(secret, destination, new Set([origin]), () => now);
    const first = payload(target.destinationEpoch, 'a'.repeat(22), now);
    const signedFirst = signFederationBody(secret, first, now);
    expect(target.verifyDelegation(signedFirst.timestamp, signedFirst.signature, first).ok).toBe(true);
    expect(target.verifyDelegation(signedFirst.timestamp, signedFirst.signature, first)).toMatchObject({ ok: false, reason: 'replay' });

    const restarted = new FederationAdmissionService(secret, destination, new Set([origin]), () => now);
    expect(restarted.verifyDelegation(signedFirst.timestamp, signedFirst.signature, first)).toMatchObject({ ok: false, reason: 'epoch_mismatch' });

    for (let index = 1; index < 512; index += 1) {
      const candidate = payload(target.destinationEpoch, index.toString(36).padStart(22, '0'), now);
      const signed = signFederationBody(secret, candidate, now);
      expect(target.verifyDelegation(signed.timestamp, signed.signature, candidate).ok).toBe(true);
    }
    const overflow = payload(target.destinationEpoch, 'z'.repeat(22), now);
    const signedOverflow = signFederationBody(secret, overflow, now);
    expect(target.verifyDelegation(signedOverflow.timestamp, signedOverflow.signature, overflow)).toMatchObject({ ok: false, code: 'federation_temporarily_unavailable', reason: 'capacity' });
    expect(target.verifyDelegation(signedFirst.timestamp, signedFirst.signature, first)).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('refreshes one stale epoch with a fresh authority check and nonce', async () => {
    let target = new FederationAdmissionService(secret, destination, new Set([origin]));
    let delegationCalls = 0;
    const nonces: string[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as FederationPayload;
      if (String(url).endsWith('/metadata')) {
        const signed = target.issueEpochMetadata(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
        if (signed === undefined) return new Response('', { status: 401 });
        return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
      }
      delegationCalls += 1;
      nonces.push(body.nonce);
      if (delegationCalls === 1) {
        target = new FederationAdmissionService(secret, destination, new Set([origin]));
        return new Response('', { status: 409 });
      }
      expect(target.verifyDelegation(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body).ok).toBe(true);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }), { status: 200 });
    };
    let authorityChecks = 0;
    const forward = federationForwarder([{ name: 'Peer', url: new URL(destination) }], secret, origin, fetcher as typeof fetch);
    await expect(forward(destination, { authentication: 'oauth', subjectId: 'user', audience: `${origin}/mcp`, scopes: ['status:read'] }, 'list_agents', {}, { authorize: () => { authorityChecks += 1; return true; } })).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(authorityChecks).toBe(2);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('rechecks Realtime expiry before a stale-epoch retry', async () => {
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    const leaseExpiresAt = now + 4_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let target = new FederationAdmissionService(secret, destination, new Set([origin]));
    let metadataCalls = 0;
    let delegationCalls = 0;
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as FederationPayload;
      if (String(url).endsWith('/metadata')) {
        metadataCalls += 1;
        // expire the source lease while refreshing the stale target epoch
        if (metadataCalls === 2) vi.setSystemTime(leaseExpiresAt);
        const signed = target.issueEpochMetadata(headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), body);
        if (signed === undefined) return new Response('', { status: 401 });
        return new Response(JSON.stringify(signed.body), { status: 200, headers: { 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature } });
      }
      delegationCalls += 1;
      target = new FederationAdmissionService(secret, destination, new Set([origin]));
      return new Response('', { status: 409 });
    };
    let authorityChecks = 0;
    const forward = federationForwarder([{ name: 'Peer', url: new URL(destination) }], secret, origin, fetcher as typeof fetch);
    const principal = { authentication: 'realtime' as const, subjectId: 'voice', stableOwnerKey: 'o'.repeat(43), leaseKey: 'l'.repeat(43), expiresAt: leaseExpiresAt, audience: 'realtime', scopes: ['status:read' as const] };
    await expect(forward(destination, principal, 'list_agents', {}, { authorize: () => { authorityChecks += 1; return Date.now() < leaseExpiresAt; } })).resolves.toBeUndefined();
    expect({ authorityChecks, metadataCalls, delegationCalls }).toEqual({ authorityChecks: 2, metadataCalls: 2, delegationCalls: 1 });
  });

  it('binds controller-presence responses to exact opaque owners and target epoch', () => {
    const originAdmission = new FederationAdmissionService(secret, origin, new Set([destination]));
    const request: ControllerPresenceRequest = { version: 1, origin_instance_id: origin, target_instance_id: destination, target_epoch: 'e'.repeat(43), request_nonce: 'r'.repeat(22), owners: ['o'.repeat(43)] };
    const signedRequest = signFederationBody(secret, request);
    const response = originAdmission.issueControllerPresence(signedRequest.timestamp, signedRequest.signature, request, owner => owner === request.owners[0]);
    expect(response).toBeDefined();
    expect(verifyControllerPresenceResponse(secret, response?.timestamp, response?.signature, response?.body, request)).toMatchObject({ owners: [{ owner_id: request.owners[0], present: true }] });
    expect(verifyControllerPresenceResponse(secret, response?.timestamp, response?.signature, response?.body, { ...request, request_nonce: 'x'.repeat(22) })).toBeUndefined();
  });
});
