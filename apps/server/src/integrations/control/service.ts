import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IntegrationPrincipal, InternalIntegrationScope } from '../auth/index.js';

const defaultVoiceLeaseMs = 25_000;
const maximumBearerRecords = 64;
const defaultRealtimeScopes: InternalIntegrationScope[] = ['status:read', 'logs:read', 'files:read', 'github:read'];

type VoiceLease = { browserSessionId: string; voiceSessionId: string; stableOwnerKey: string; leaseKey: string; startedAt: number; expiresAt: number };
type BearerRecord = VoiceLease & { digest: Buffer; scopes: InternalIntegrationScope[] };

export type RealtimeLeaseCredential = { bearer: string; stableOwnerKey: string; leaseKey: string; expiresAt: number };
export type ExternalControlSnapshot = { voiceActive: boolean; startedAt?: string; expiresAt?: string };
export type ExternalControlResult = { ok: true; leaseKey: string } | { ok: false; code: 'voice_mode_required' | 'browser_control_changed' | 'voice_lease_changed' };

// gate mutations and ephemeral Realtime credentials on one browser-owned lease
export class IntegrationControlService {
  private voice?: VoiceLease;
  private readonly stopped = new Map<string, number>();
  private readonly bearers = new Map<string, BearerRecord>();
  private readonly ownerSecret: string;

  // retain trusted owner, clock, lifetime, and server secret dependencies
  constructor(private readonly browserOwner: () => string | undefined, private readonly now: () => number = Date.now, private readonly leaseMs = defaultVoiceLeaseMs, ownerSecret = process.env.RAC_SESSION_SECRET ?? '') {
    // keep test and embedded callers secure when no deployment secret is supplied
    this.ownerSecret = ownerSecret.length === 0 ? randomBytes(32).toString('base64url') : ownerSecret;
  }

  // start voice mode without minting an MCP credential
  startVoice(browserSessionId: string, voiceSessionId: string): boolean {
    return this.start(browserSessionId, voiceSessionId) !== undefined;
  }

  // start voice mode and mint one exact per-lease MCP bearer
  startVoiceLease(browserSessionId: string, voiceSessionId: string, scopes: readonly InternalIntegrationScope[] = defaultRealtimeScopes): RealtimeLeaseCredential | undefined {
    const voice = this.start(browserSessionId, voiceSessionId);
    // refuse stale browser or stopped voice sessions
    if (voice === undefined) return undefined;
    const bearer = randomBytes(32).toString('base64url');
    const digest = bearerDigest(bearer);
    this.bearers.set(digest.toString('base64url'), { ...voice, digest, scopes: [...new Set(scopes)] });
    this.prune();
    return { bearer, stableOwnerKey: voice.stableOwnerKey, leaseKey: voice.leaseKey, expiresAt: voice.expiresAt };
  }

  // renew one active voice session and its exact bearer lifetime
  heartbeatVoice(browserSessionId: string, voiceSessionId: string): boolean {
    this.prune();
    // require the same controlling browser and voice session
    if (this.voice?.browserSessionId !== browserSessionId || this.voice.voiceSessionId !== voiceSessionId || this.browserOwner() !== browserSessionId) {
      // revoke the active credential when its heartbeat loses authority
      if (this.voice !== undefined) {
        this.revokeLease(this.voice.leaseKey);
        this.voice = undefined;
      }
      return false;
    }
    this.voice.expiresAt = this.now() + this.leaseMs;
    // extend only credentials for the same exact lease
    for (const record of this.bearers.values()) {
      // retain credentials from no other lease
      if (record.leaseKey !== this.voice.leaseKey) continue;
      record.expiresAt = this.voice.expiresAt;
    }
    return true;
  }

  // stop voice mode and revoke its exact bearer immediately
  stopVoice(browserSessionId: string, voiceSessionId: string): void {
    this.prune();
    this.stopped.set(voiceSessionId, this.now() + this.leaseMs);
    // cap cancellation tombstones
    if (this.stopped.size > maximumBearerRecords) this.stopped.delete(this.stopped.keys().next().value as string);
    const leaseKey = this.voice?.browserSessionId === browserSessionId && this.voice.voiceSessionId === voiceSessionId ? this.voice.leaseKey : undefined;
    // preserve a different browser's newer session
    if (leaseKey !== undefined) this.voice = undefined;
    // revoke only credentials from the stopped lease
    for (const [key, record] of this.bearers) {
      // preserve other exact leases
      if (record.leaseKey !== leaseKey) continue;
      this.bearers.delete(key);
    }
  }

  // authenticate one digest-only ephemeral Realtime bearer
  authenticateRealtimeBearer(token: string): IntegrationPrincipal | undefined {
    this.prune();
    // reject malformed bearers before bounded comparison
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const presented = bearerDigest(token);
    let found: BearerRecord | undefined;
    // scan the bounded registry without a content-dependent early exit
    for (const record of this.bearers.values()) {
      // retain the exact digest match
      if (timingSafeEqual(presented, record.digest)) found = record;
    }
    // require the exact active lease
    if (found === undefined || this.voice?.leaseKey !== found.leaseKey) return undefined;
    // revoke rather than resurrect credentials after controller loss
    if (this.browserOwner() !== found.browserSessionId) {
      this.revokeLease(found.leaseKey);
      this.voice = undefined;
      return undefined;
    }
    return { authentication: 'realtime', subjectId: found.stableOwnerKey, stableOwnerKey: found.stableOwnerKey, leaseKey: found.leaseKey, audience: 'realtime', scopes: [...found.scopes], expiresAt: found.expiresAt };
  }

  // authorize one mutation against the current exact lease when supplied
  authorizeMutation(leaseKey?: string): ExternalControlResult {
    this.prune();
    // require a live voice session
    if (this.voice === undefined) return { ok: false, code: 'voice_mode_required' };
    // revoke after browser ownership changes
    if (this.browserOwner() !== this.voice.browserSessionId) {
      this.revokeLease(this.voice.leaseKey);
      this.voice = undefined;
      return { ok: false, code: 'browser_control_changed' };
    }
    // bind Realtime and delegated mutations to their exact captured lease
    if (leaseKey !== undefined && !safeStringEqual(leaseKey, this.voice.leaseKey)) return { ok: false, code: 'voice_lease_changed' };
    return { ok: true, leaseKey: this.voice.leaseKey };
  }

  // expose the server-derived current lease without bearer material
  currentLease(): Omit<VoiceLease, 'browserSessionId' | 'voiceSessionId'> | undefined {
    const authorized = this.authorizeMutation();
    // hide inactive or changed ownership
    if (!authorized.ok || this.voice === undefined) return undefined;
    return { stableOwnerKey: this.voice.stableOwnerKey, leaseKey: this.voice.leaseKey, startedAt: this.voice.startedAt, expiresAt: this.voice.expiresAt };
  }

  // expose only safe voice-gate metadata
  snapshot(): ExternalControlSnapshot {
    this.prune();
    // hide inactive voice state
    if (this.voice === undefined) return { voiceActive: false };
    return { voiceActive: true, startedAt: new Date(this.voice.startedAt).toISOString(), expiresAt: new Date(this.voice.expiresAt).toISOString() };
  }

  // prove one opaque stable owner from the current controlling browser
  controllerPresent(ownerId: string): boolean {
    const browserSessionId = this.browserOwner();
    // reject absent controllers and malformed opaque identities
    if (browserSessionId === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(ownerId)) return false;
    const current = createHmac('sha256', this.ownerSecret).update(`realtime\0${browserSessionId}`).digest('base64url');
    return safeStringEqual(ownerId, current);
  }

  // create one server-derived lease and revoke any replaced lease
  private start(browserSessionId: string, voiceSessionId: string): VoiceLease | undefined {
    this.prune();
    // reject stale or explicitly stopped sessions
    if (this.browserOwner() !== browserSessionId || this.stopped.has(voiceSessionId)) return undefined;
    // revoke the previous lease before replacement
    if (this.voice !== undefined) this.revokeLease(this.voice.leaseKey);
    const now = this.now();
    const stableOwnerKey = createHmac('sha256', this.ownerSecret).update(`realtime\0${browserSessionId}`).digest('base64url');
    this.voice = { browserSessionId, voiceSessionId, stableOwnerKey, leaseKey: randomBytes(32).toString('base64url'), startedAt: now, expiresAt: now + this.leaseMs };
    return this.voice;
  }

  // expire abandoned leases and bounded cancellation records
  private prune(): void {
    const now = this.now();
    // release an expired voice session and its credentials
    if (this.voice !== undefined && this.voice.expiresAt <= now) {
      this.revokeLease(this.voice.leaseKey);
      this.voice = undefined;
    }
    // release expired credentials
    for (const [key, record] of this.bearers) {
      // retain live bearer records
      if (record.expiresAt > now) continue;
      this.bearers.delete(key);
    }
    // release expired cancellation tombstones
    for (const [id, expiresAt] of this.stopped) {
      // retain live cancellation records
      if (expiresAt > now) continue;
      this.stopped.delete(id);
    }
  }

  // revoke every bearer for one exact lease
  private revokeLease(leaseKey: string): void {
    // remove only matching bearer records
    for (const [key, record] of this.bearers) {
      // preserve unrelated leases
      if (record.leaseKey !== leaseKey) continue;
      this.bearers.delete(key);
    }
  }
}

// hash bearer material for registry lookup
function bearerDigest(token: string): Buffer { return createHash('sha256').update(token).digest(); }

// compare lease keys without raw string equality
function safeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
