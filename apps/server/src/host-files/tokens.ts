import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isHostFileIdentity, isHostFilesPath, sameHostFilesOwner, type HostFileIdentity, type HostFilesOwnerContext } from './contracts.js';

export type HostFileTokenPurpose = 'object'|'destination-directory';
export type HostFileTokenPayload = {
  version: 2;
  purpose: HostFileTokenPurpose;
  owner: HostFilesOwnerContext;
  placeId: string;
  backendGeneration: string;
  path: string;
  identity: HostFileIdentity;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

const maxTokenBytes = 16_384;

// validate one bounded first-class capability owner
function validOwner(value: unknown): value is HostFilesOwnerContext {
  // require one plain owner record
  if (value === null || typeof value !== 'object') return false;
  const owner = value as Partial<HostFilesOwnerContext>;
  return (owner.namespace === 'browser' || owner.namespace === 'davo' || owner.namespace === 'conductor')
    && typeof owner.principalOwnerKey === 'string' && owner.principalOwnerKey.length >= 1 && owner.principalOwnerKey.length <= 512
    && (owner.leaseKey === undefined || typeof owner.leaseKey === 'string' && owner.leaseKey.length >= 1 && owner.leaseKey.length <= 512);
}

// validate one decoded capability payload
function isPayload(value: unknown): value is HostFileTokenPayload {
  // require one plain payload object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.version === 2 && (payload.purpose === 'object' || payload.purpose === 'destination-directory')
    && validOwner(payload.owner)
    && typeof payload.placeId === 'string' && payload.placeId.length >= 1 && payload.placeId.length <= 4096
    && typeof payload.backendGeneration === 'string' && payload.backendGeneration.length >= 1 && payload.backendGeneration.length <= 512
    && isHostFilesPath(payload.path) && isHostFileIdentity(payload.identity)
    && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
    && typeof payload.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(payload.nonce);
}

export class HostFilesTokenService {
  // retain a private signer and bounded token lifetime
  constructor(private readonly secret: string, private readonly generation: () => string, private readonly now: () => number = Date.now, private readonly ttlMs = 15 * 60_000) {
    // refuse predictable empty signing keys
    if (secret.length < 16) throw new Error('host files token secret is too short');
  }

  // issue one session, Place, generation and identity-bound capability
  issue(input: Omit<HostFileTokenPayload, 'version'|'backendGeneration'|'issuedAt'|'expiresAt'|'nonce'> | Omit<HostFileTokenPayload, 'version'|'owner'|'backendGeneration'|'issuedAt'|'expiresAt'|'nonce'> & { sessionId: string }): string {
    const issuedAt = this.now();
    const owner = 'owner' in input ? input.owner : { namespace: 'browser' as const, principalOwnerKey: input.sessionId };
    const { sessionId: _sessionId, ...fields } = input as typeof input & { sessionId?: string };
    const payload: HostFileTokenPayload = {
      version: 2,
      ...fields,
      owner,
      backendGeneration: this.generation(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      nonce: randomBytes(18).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  // verify one capability for its exact request context
  verify(token: string, expected: { purpose: HostFileTokenPurpose; owner: HostFilesOwnerContext; placeId?: string; leaseBound?: boolean } | { purpose: HostFileTokenPurpose; sessionId: string; placeId?: string; leaseBound?: boolean }): HostFileTokenPayload | undefined {
    // reject oversized or malformed envelopes before decoding
    if (typeof token !== 'string' || token.length < 20 || token.length > maxTokenBytes) return undefined;
    const parts = token.split('.');
    // require exactly one body and signature
    if (parts.length !== 2) return undefined;
    const [body, signature] = parts as [string, string];
    // reject noncanonical base64url spellings before signature comparison
    if (!/^[A-Za-z0-9_-]+$/u.test(body) || !/^[A-Za-z0-9_-]+$/u.test(signature)
      || Buffer.from(body, 'base64url').toString('base64url') !== body
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature) return undefined;
    const actual = Buffer.from(signature, 'base64url');
    const wanted = Buffer.from(this.sign(body), 'base64url');
    // compare fixed-size signatures without timing disclosure
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return undefined; }
    // require a current, context-bound payload
    const expectedOwner = 'owner' in expected ? expected.owner : { namespace: 'browser' as const, principalOwnerKey: expected.sessionId };
    if (!isPayload(parsed) || parsed.purpose !== expected.purpose || !sameHostFilesOwner(parsed.owner, expectedOwner, expected.leaseBound) || expected.placeId !== undefined && parsed.placeId !== expected.placeId) return undefined;
    const currentGeneration = this.generation();
    const currentTime = this.now();
    // compare one consistent backend/time snapshot
    if (parsed.backendGeneration !== currentGeneration || parsed.issuedAt > currentTime + 5_000 || parsed.expiresAt < currentTime) return undefined;
    return parsed;
  }

  // sign one encoded token body
  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
