import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RemoteServer } from '../../config/schema.js';
import { internalIntegrationScopes, supportedIntegrationScopes, type IntegrationPrincipal, type IntegrationScope, type PublicIntegrationScope } from '../auth/index.js';
import type { ToolCallResult } from '../mcp/gateway.js';

const delegationLifetimeMs = 15_000;
const clockToleranceMs = 5_000;
const maximumNonces = 512;
const maxFederationBodyBytes = 65_536;
const maxMetadataRequestBytes = 2_048;
const maxMetadataResponseBytes = 1_024;
const maxPresenceBodyBytes = 4_096;
const metadataLifetimeMs = 60_000;

type OAuthAudience = { kind: 'oauth'; subject_id: string; client_id?: string; scopes: PublicIntegrationScope[]; control_lease_key?: string };
type RealtimeAudience = { kind: 'realtime'; stable_owner_key: string; lease_key: string; lease_expires_at: number; scopes: IntegrationScope[] };
export type FederationPayload = { version: 2; origin_instance_id: string; destination_instance_id: string; destination_epoch: string; nonce: string; issued_at: string; expires_at: string; audience: OAuthAudience | RealtimeAudience; name: string; arguments: Record<string, unknown> };
export type FederationMetadataRequest = { version: 2; origin_instance_id: string; destination_instance_id: string; request_nonce: string; issued_at: string };
export type FederationMetadataResponse = FederationMetadataRequest & { destination_epoch: string; expires_at: string };
export type ControllerPresenceRequest = { version: 1; origin_instance_id: string; target_instance_id: string; target_epoch: string; request_nonce: string; owners: string[] };
export type ControllerPresenceResponse = Omit<ControllerPresenceRequest, 'owners'> & { checked_at: string; owners: Array<{ owner_id: string; present: boolean }> };
export type SignedFederationBody<T> = { body: T; timestamp: string; signature: string };
export type FederationForwardContext = { controlLeaseKey?: string; authorize?: () => boolean };
export type FederationAdmissionFailure = { ok: false; code: 'federation_temporarily_unavailable'; reason: 'invalid' | 'capacity' | 'replay' | 'epoch_mismatch' };
export type FederationAdmissionSuccess = { ok: true; payload: FederationPayload; principal: IntegrationPrincipal };

// verify and admit signed federation requests for one process epoch
export class FederationAdmissionService {
  readonly destinationEpoch = randomBytes(32).toString('base64url');
  private readonly nonces = new Map<string, number>();

  // retain exact destination identity and configured origins
  constructor(private readonly secret: string, private readonly destinationInstanceId: string, private readonly allowedOrigins: ReadonlySet<string>, private readonly now: () => number = Date.now) {
    // require one strong federation key
    if (Buffer.from(secret, 'base64url').length < 32) throw new Error('federation secret is too short');
  }

  // verify metadata discovery and sign the current boot epoch
  issueEpochMetadata(timestamp: unknown, requestSignature: unknown, value: unknown): SignedFederationBody<FederationMetadataResponse> | undefined {
    const request = verifySignedBody(this.secret, timestamp, requestSignature, value, maxMetadataRequestBytes, isMetadataRequest, this.now());
    // bind discovery to one configured origin and exact destination
    if (request === undefined || !this.allowedOrigins.has(request.origin_instance_id) || request.destination_instance_id !== this.destinationInstanceId || Math.abs(this.now() - Date.parse(request.issued_at)) > clockToleranceMs) return undefined;
    const issuedAt = this.now();
    return signBody(this.secret, { ...request, destination_epoch: this.destinationEpoch, issued_at: new Date(issuedAt).toISOString(), expires_at: new Date(issuedAt + 60_000).toISOString() }, issuedAt);
  }

  // atomically verify and claim one v2 delegation before dispatch
  verifyDelegation(timestamp: unknown, requestSignature: unknown, value: unknown): FederationAdmissionSuccess | FederationAdmissionFailure {
    const payload = verifySignedBody(this.secret, timestamp, requestSignature, value, maxFederationBodyBytes, isFederationPayload, this.now());
    // reject malformed, unconfigured, or misdirected delegations
    if (payload === undefined || !this.allowedOrigins.has(payload.origin_instance_id) || payload.destination_instance_id !== this.destinationInstanceId) return refusal('invalid');
    // bind every call to this exact process epoch
    if (!safeEqual(payload.destination_epoch, this.destinationEpoch)) return refusal('epoch_mismatch');
    const issuedAt = Date.parse(payload.issued_at);
    const expiresAt = Date.parse(payload.expires_at);
    const expectedExpiry = payload.audience.kind === 'realtime' ? Math.min(issuedAt + delegationLifetimeMs, payload.audience.lease_expires_at) : issuedAt + delegationLifetimeMs;
    const expiredBeforeIssue = payload.audience.kind === 'realtime' && payload.audience.lease_expires_at <= issuedAt;
    // enforce the lease-capped issuance window and clock tolerance
    if (expiredBeforeIssue || expiresAt !== expectedExpiry || issuedAt > this.now() + clockToleranceMs || expiresAt <= this.now()) return refusal('invalid');
    this.expireNonces();
    const nonceDigest = digestNonce(payload.nonce);
    // conceal replay and capacity behind one external error
    if (this.nonces.has(nonceDigest)) return refusal('replay');
    // never evict a live nonce
    if (this.nonces.size >= maximumNonces) return refusal('capacity');
    const principal = principalFromFederation(this.secret, payload);
    // reject invalid audience projection before consuming capacity
    if (principal === undefined) return refusal('invalid');
    this.nonces.set(nonceDigest, expiresAt + clockToleranceMs);
    return { ok: true, payload, principal };
  }

  // answer a signed origin-controller presence query without returning owner identity
  issueControllerPresence(timestamp: unknown, requestSignature: unknown, value: unknown, present: (ownerId: string) => boolean): SignedFederationBody<ControllerPresenceResponse> | undefined {
    const request = verifySignedBody(this.secret, timestamp, requestSignature, value, maxPresenceBodyBytes, isPresenceRequest, this.now());
    // require configured target identity and this origin identity
    if (request === undefined || !this.allowedOrigins.has(request.target_instance_id) || request.origin_instance_id !== this.destinationInstanceId) return undefined;
    const checkedAt = this.now();
    return signBody(this.secret, { version: 1, origin_instance_id: request.origin_instance_id, target_instance_id: request.target_instance_id, target_epoch: request.target_epoch, request_nonce: request.request_nonce, checked_at: new Date(checkedAt).toISOString(), owners: request.owners.map(ownerId => ({ owner_id: ownerId, present: present(ownerId) })) }, checkedAt);
  }

  // expire nonce entries only after their retention deadline
  private expireNonces(): void {
    // delete only expired replay records
    for (const [nonce, expiresAt] of this.nonces) {
      // retain live records
      if (expiresAt > this.now()) continue;
      this.nonces.delete(nonce);
    }
  }
}

// create one signed cross-instance tool forwarding callback
export function federationForwarder(remoteServers: RemoteServer[], secret: string, originInstanceId: string, fetcher: typeof fetch = fetch) {
  const epochs = new Map<string, { metadata: FederationMetadataResponse; cachedAt: number }>();
  // load one cached or freshly authenticated destination epoch
  const metadataFor = async (server: RemoteServer, instanceId: string, refresh = false): Promise<FederationMetadataResponse | undefined> => {
    const cached = epochs.get(instanceId);
    const now = Date.now();
    // reuse only the exact configured destination inside both freshness bounds
    if (!refresh && cached !== undefined && now - cached.cachedAt < metadataLifetimeMs && Date.parse(cached.metadata.expires_at) > now) return cached.metadata;
    const metadata = await discoverEpoch(server.url, secret, originInstanceId, instanceId, fetcher);
    // retain no unauthenticated or unavailable metadata
    if (metadata === undefined) return undefined;
    epochs.set(instanceId, { metadata, cachedAt: now });
    return metadata;
  };
  // forward only to one configured destination
  return async (instanceId: string, principal: IntegrationPrincipal, name: string, args: Record<string, unknown>, context: FederationForwardContext = {}): Promise<ToolCallResult | undefined> => {
    const server = remoteServers.find(candidate => candidate.url.origin === instanceId);
    // reject unconfigured destinations and missing federation keys
    if (server === undefined || Buffer.from(secret, 'base64url').length < 32) return undefined;
    const metadata = await metadataFor(server, instanceId);
    // fail closed when authenticated epoch discovery is unavailable
    if (metadata === undefined) return undefined;
    // recheck origin authority after asynchronous epoch discovery and immediately before signing
    if (context.authorize !== undefined && !context.authorize()) return undefined;
    const payload = delegation(originInstanceId, instanceId, metadata.destination_epoch, principal, name, args, context);
    // reject audience or argument data that cannot form a v2 delegation
    if (payload === undefined) return undefined;
    const sent = await sendDelegation(server.url, secret, payload, fetcher);
    // return ordinary success or failure without a retry
    if (!sent.staleEpoch) return sent.result;
    const refreshed = await metadataFor(server, instanceId, true);
    // require a fresh epoch and a fresh exact authority check before one retry
    if (refreshed === undefined || context.authorize !== undefined && !context.authorize()) return undefined;
    const retried = delegation(originInstanceId, instanceId, refreshed.destination_epoch, principal, name, args, context);
    // require a newly signed payload and nonce
    if (retried === undefined) return undefined;
    return (await sendDelegation(server.url, secret, retried, fetcher)).result;
  };
}

// reconstruct one tagged audience from a verified signed delegation only
function principalFromFederation(secret: string, payload: FederationPayload): IntegrationPrincipal | undefined {
  const common = { originInstanceId: payload.origin_instance_id, destinationInstanceId: payload.destination_instance_id, issuedAt: Date.parse(payload.issued_at), expiresAt: Date.parse(payload.expires_at) };
  // preserve OAuth subject, client, public scopes, and issuance authority
  if (payload.audience.kind === 'oauth') return { authentication: 'oauth', subjectId: payload.audience.subject_id, audience: payload.destination_instance_id, scopes: [...payload.audience.scopes], ...(payload.audience.client_id === undefined ? {} : { clientId: payload.audience.client_id }), federated: { ...common, issuedAuthority: payload.audience.control_lease_key === undefined ? 'read' : 'oauth-control' } };
  const stableOwnerKey = namespaceKey(secret, 'owner', payload.origin_instance_id, payload.destination_instance_id, payload.audience.stable_owner_key);
  const leaseKey = namespaceKey(secret, 'lease', payload.origin_instance_id, payload.destination_instance_id, payload.audience.lease_key);
  // namespace target artifacts while retaining only the opaque origin owner for presence
  return { authentication: 'realtime', subjectId: stableOwnerKey, stableOwnerKey, leaseKey, expiresAt: common.expiresAt, audience: 'realtime', scopes: [...payload.audience.scopes], federated: { ...common, issuedAuthority: 'realtime-lease', originStableOwnerKey: payload.audience.stable_owner_key } };
}

// verify a signed controller-presence response at a target
export function verifyControllerPresenceResponse(secret: string, timestamp: unknown, responseSignature: unknown, value: unknown, expected: ControllerPresenceRequest, now: number = Date.now()): ControllerPresenceResponse | undefined {
  const response = verifySignedBody(secret, timestamp, responseSignature, value, maxPresenceBodyBytes, isPresenceResponse, now);
  // bind response identity, nonce, epoch, and freshness
  if (response === undefined || response.origin_instance_id !== expected.origin_instance_id || response.target_instance_id !== expected.target_instance_id || response.target_epoch !== expected.target_epoch || response.request_nonce !== expected.request_nonce || Math.abs(now - Date.parse(response.checked_at)) > clockToleranceMs) return undefined;
  const expectedOwners = new Set(expected.owners);
  // require one exact result for every requested opaque owner
  if (response.owners.length !== expected.owners.length || response.owners.some(owner => !expectedOwners.has(owner.owner_id)) || new Set(response.owners.map(owner => owner.owner_id)).size !== response.owners.length) return undefined;
  return response;
}

// expose exact signing for app-owned metadata and presence routes
export function signFederationBody<T>(secret: string, body: T, now: number = Date.now()): SignedFederationBody<T> { return signBody(secret, body, now); }

// fetch one authenticated destination boot epoch
async function discoverEpoch(serverUrl: URL, secret: string, originInstanceId: string, destinationInstanceId: string, fetcher: typeof fetch): Promise<FederationMetadataResponse | undefined> {
  const body: FederationMetadataRequest = { version: 2, origin_instance_id: originInstanceId, destination_instance_id: destinationInstanceId, request_nonce: randomBytes(18).toString('base64url'), issued_at: new Date().toISOString() };
  const signed = signBody(secret, body);
  try {
    const response = await fetcher(new URL('/api/integration-federation/metadata', serverUrl), { method: 'POST', headers: headers(signed), body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
    // require one successful bounded signed response
    if (!response.ok) return undefined;
    const text = await boundedText(response, maxMetadataResponseBytes);
    // reject oversized metadata before parsing
    if (text === undefined) return undefined;
    const metadata = verifySignedBody(secret, response.headers.get('x-rac-federation-timestamp'), response.headers.get('x-rac-federation-signature'), JSON.parse(text), maxMetadataResponseBytes, isMetadataResponse);
    // bind exact discovery identities and nonce
    if (metadata === undefined || metadata.origin_instance_id !== originInstanceId || metadata.destination_instance_id !== destinationInstanceId || metadata.request_nonce !== body.request_nonce || Date.parse(metadata.expires_at) <= Date.now()) return undefined;
    return metadata;
  } catch { return undefined; }
}

// form one exact tagged v2 delegation
function delegation(origin: string, destination: string, epoch: string, principal: IntegrationPrincipal, name: string, args: Record<string, unknown>, context: FederationForwardContext): FederationPayload | undefined {
  // reject unsafe names and non-record arguments
  if (!/^[a-z][a-z0-9_]{1,63}$/u.test(name) || args === null || Array.isArray(args)) return undefined;
  const issuedAt = Date.now();
  let expiresAt = issuedAt + delegationLifetimeMs;
  let audience: OAuthAudience | RealtimeAudience;
  // retain only public scopes in OAuth delegations
  if (principal.authentication === 'oauth') {
    // reject internal scopes rather than silently shrinking them
    if (!principal.scopes.every(scope => (supportedIntegrationScopes as readonly string[]).includes(scope))) return undefined;
    audience = { kind: 'oauth', subject_id: principal.subjectId, ...(principal.clientId === undefined ? {} : { client_id: principal.clientId }), scopes: [...principal.scopes] as PublicIntegrationScope[], ...(context.controlLeaseKey === undefined ? {} : { control_lease_key: context.controlLeaseKey }) };
  } else if (principal.authentication === 'realtime') {
    const leaseExpiresAt = principal.expiresAt;
    // require server-derived stable owner, exact lease, and current lease expiry
    if (principal.stableOwnerKey === undefined || principal.leaseKey === undefined || leaseExpiresAt === undefined || !Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= issuedAt || !principal.scopes.every(scope => (internalIntegrationScopes as readonly string[]).includes(scope))) return undefined;
    expiresAt = Math.min(expiresAt, leaseExpiresAt);
    audience = { kind: 'realtime', stable_owner_key: principal.stableOwnerKey, lease_key: principal.leaseKey, lease_expires_at: leaseExpiresAt, scopes: [...principal.scopes] };
  } else return undefined;
  return { version: 2, origin_instance_id: origin, destination_instance_id: destination, destination_epoch: epoch, nonce: randomBytes(18).toString('base64url'), issued_at: new Date(issuedAt).toISOString(), expires_at: new Date(expiresAt).toISOString(), audience, name, arguments: args };
}

// send one signed v2 delegation
async function sendDelegation(serverUrl: URL, secret: string, payload: FederationPayload, fetcher: typeof fetch): Promise<{ result?: ToolCallResult; staleEpoch: boolean }> {
  const signed = signBody(secret, payload);
  try {
    const response = await fetcher(new URL('/api/integration-federation', serverUrl), { method: 'POST', headers: headers(signed), body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    // return only successful bounded tool envelopes
    if (!response.ok) return { staleEpoch: response.status === 409 };
    const text = await boundedText(response, maxFederationBodyBytes);
    // bound peer responses before parsing
    if (text === undefined) return { staleEpoch: false };
    const value = JSON.parse(text) as unknown;
    return isToolCallResult(value) ? { result: value, staleEpoch: false } : { staleEpoch: false };
  } catch { return { staleEpoch: false }; }
}

// build the exact signed transport headers
function headers(signed: SignedFederationBody<unknown>): Record<string, string> { return { 'content-type': 'application/json', 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature }; }

// sign the exact timestamp and JSON payload
function signBody<T>(secret: string, body: T, now: number = Date.now()): SignedFederationBody<T> { const timestamp = String(now); return { body, timestamp, signature: signature(secret, timestamp, JSON.stringify(body)) }; }

// verify one exact signed bounded JSON body
function verifySignedBody<T>(secret: string, timestampHeader: unknown, signatureHeader: unknown, value: unknown, maximumBytes: number, validate: (candidate: unknown) => candidate is T, now: number = Date.now()): T | undefined {
  // require a strong secret and scalar headers
  if (Buffer.from(secret, 'base64url').length < 32 || typeof timestampHeader !== 'string' || typeof signatureHeader !== 'string') return undefined;
  const timestamp = Number(timestampHeader);
  // reject stale and future signed bodies
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 30_000) return undefined;
  const serialized = JSON.stringify(value);
  // reject oversized and incorrectly signed bodies
  if (Buffer.byteLength(serialized) > maximumBytes || !safeEqual(signature(secret, timestampHeader, serialized), signatureHeader)) return undefined;
  return validate(value) ? value : undefined;
}

// create the shared non-oracular refusal
function refusal(reason: FederationAdmissionFailure['reason']): FederationAdmissionFailure { return { ok: false, code: 'federation_temporarily_unavailable', reason }; }

// sign one timestamp and serialized payload
function signature(secret: string, timestamp: string, serialized: string): string { return createHmac('sha256', secret).update(`${timestamp}\n${serialized}`).digest('base64url'); }

// retain only a digest in the one-use nonce cache
function digestNonce(nonce: string): string { return createHash('sha256').update(nonce).digest('base64url'); }

// derive target-local opaque owner and lease keys without cross-origin collision
function namespaceKey(secret: string, kind: 'owner' | 'lease', origin: string, destination: string, value: string): string { return createHmac('sha256', secret).update(`federated-${kind}\0${origin}\0${destination}\0${value}`).digest('base64url'); }

// compare fixed signatures without early exit
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

// validate one exact metadata request
function isMetadataRequest(value: unknown): value is FederationMetadataRequest {
  // require the exact request keys before inspecting fields
  if (!exact(value, ['version', 'origin_instance_id', 'destination_instance_id', 'request_nonce', 'issued_at'])) return false;
  const c = value as Record<string, unknown>;
  return c.version === 2 && validInstance(c.origin_instance_id) && validInstance(c.destination_instance_id) && validNonce(c.request_nonce) && validInstant(c.issued_at);
}

// validate one exact metadata response
function isMetadataResponse(value: unknown): value is FederationMetadataResponse {
  // require the exact response keys before inspecting fields
  if (!exact(value, ['version', 'origin_instance_id', 'destination_instance_id', 'request_nonce', 'issued_at', 'destination_epoch', 'expires_at'])) return false;
  const c = value as Record<string, unknown>;
  return c.version === 2 && validInstance(c.origin_instance_id) && validInstance(c.destination_instance_id) && validNonce(c.request_nonce) && validInstant(c.issued_at) && validKey(c.destination_epoch) && validInstant(c.expires_at);
}

// validate one exact v2 delegation
function isFederationPayload(value: unknown): value is FederationPayload {
  // require the exact delegation keys before inspecting fields
  if (!exact(value, ['version', 'origin_instance_id', 'destination_instance_id', 'destination_epoch', 'nonce', 'issued_at', 'expires_at', 'audience', 'name', 'arguments'])) return false;
  const c = value as Record<string, unknown>;
  return c.version === 2 && validInstance(c.origin_instance_id) && validInstance(c.destination_instance_id) && validKey(c.destination_epoch) && validNonce(c.nonce) && validInstant(c.issued_at) && validInstant(c.expires_at) && typeof c.name === 'string' && /^[a-z][a-z0-9_]{1,63}$/u.test(c.name) && c.arguments !== null && typeof c.arguments === 'object' && !Array.isArray(c.arguments) && isAudience(c.audience);
}

// validate one tagged audience
function isAudience(value: unknown): value is OAuthAudience | RealtimeAudience {
  // require one tagged audience record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  // preserve only public OAuth authority
  if (c.kind === 'oauth') return exact(c, ['kind', 'subject_id', 'scopes'], ['client_id', 'control_lease_key']) && validOpaque(c.subject_id) && (c.client_id === undefined || validOpaque(c.client_id)) && validScopes(c.scopes, supportedIntegrationScopes) && (c.control_lease_key === undefined || validKey(c.control_lease_key));
  // preserve only exact Realtime authority
  if (c.kind === 'realtime') return exact(c, ['kind', 'stable_owner_key', 'lease_key', 'lease_expires_at', 'scopes']) && validKey(c.stable_owner_key) && validKey(c.lease_key) && Number.isSafeInteger(c.lease_expires_at) && Number(c.lease_expires_at) > 0 && validScopes(c.scopes, internalIntegrationScopes);
  return false;
}

// validate one presence request
function isPresenceRequest(value: unknown): value is ControllerPresenceRequest {
  // require the exact presence-query keys
  if (!exact(value, ['version', 'origin_instance_id', 'target_instance_id', 'target_epoch', 'request_nonce', 'owners'])) return false;
  const c = value as Record<string, unknown>;
  return c.version === 1 && validInstance(c.origin_instance_id) && validInstance(c.target_instance_id) && validKey(c.target_epoch) && validNonce(c.request_nonce) && Array.isArray(c.owners) && c.owners.length >= 1 && c.owners.length <= 2 && c.owners.every(validKey) && new Set(c.owners).size === c.owners.length;
}

// validate one presence response
function isPresenceResponse(value: unknown): value is ControllerPresenceResponse {
  // require the exact presence-response keys
  if (!exact(value, ['version', 'origin_instance_id', 'target_instance_id', 'target_epoch', 'request_nonce', 'checked_at', 'owners'])) return false;
  const c = value as Record<string, unknown>;
  return c.version === 1 && validInstance(c.origin_instance_id) && validInstance(c.target_instance_id) && validKey(c.target_epoch) && validNonce(c.request_nonce) && validInstant(c.checked_at) && Array.isArray(c.owners) && c.owners.length >= 1 && c.owners.length <= 2 && c.owners.every(owner => exact(owner, ['owner_id', 'present']) && validKey((owner as Record<string, unknown>).owner_id) && typeof (owner as Record<string, unknown>).present === 'boolean');
}

// validate exact required and optional keys
function exact(value: unknown, required: string[], optional: string[] = []): boolean {
  // require one plain record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return keys.every(key => allowed.has(key)) && required.every(key => keys.includes(key));
}

// validate one configured instance identity
function validInstance(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 240 && !value.includes('\0'); }
// validate one bounded identifier
function validOpaque(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !value.includes('\0'); }
// validate one 32-byte base64url key
function validKey(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value); }
// validate one bounded nonce
function validNonce(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{22,64}$/u.test(value); }
// validate one ISO instant
function validInstant(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
// validate one distinct known scope array
function validScopes(value: unknown, allowed: readonly string[]): boolean { return Array.isArray(value) && value.length <= allowed.length && value.every(scope => typeof scope === 'string' && allowed.includes(scope)) && new Set(value).size === value.length; }

// validate one serialized MCP result
function isToolCallResult(value: unknown): value is ToolCallResult {
  // require one plain result envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  return Array.isArray(r.content) && r.content.every(item => item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string') && r.structuredContent !== null && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent) && (r.isError === undefined || typeof r.isError === 'boolean');
}

// read one peer response without retaining bytes beyond its protocol limit
async function boundedText(response: Response, maximumBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  // handle synthetic responses without a readable stream
  if (reader === undefined) {
    const text = await response.text();
    return Buffer.byteLength(text) <= maximumBytes ? text : undefined;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // stop as soon as the peer exceeds the response bound
  while (true) {
    const part = await reader.read();
    // finish after the final chunk
    if (part.done) break;
    bytes += part.value.byteLength;
    // cancel an oversized peer body without parsing it
    if (bytes > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
