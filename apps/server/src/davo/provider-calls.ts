import { randomUUID } from 'node:crypto';
import type { DavoProviderCallV1 } from './contracts.js';

const callsEndpoint = 'https://api.openai.com/v1/realtime/calls';
const maxOfferBytes = 128 * 1024;
const maxSessionBytes = 32 * 1024;
const defaultRequestTimeoutMs = 15_000;
const defaultProviderMaximumMs = 60 * 60 * 1000;

export type DavoProviderCallPrivateRecord = DavoProviderCallV1;

export type DavoProviderCallPersistenceState = {
  providerCalls: DavoProviderCallPrivateRecord[];
  providerQuarantineUntil?: string;
};

export type DavoProviderCallMutation<T> = { state: DavoProviderCallPersistenceState; result: T };

export type DavoProviderCallPersistence = {
  mode: 0o600;
  read(): Promise<DavoProviderCallPersistenceState>;
  mutate<T>(mutation: (state: DavoProviderCallPersistenceState) => DavoProviderCallMutation<T>): Promise<T>;
};

export type DavoProviderSessionConfig = { model: string; clientSecret?: string; [key: string]: unknown };

export type DavoProviderNegotiation = {
  voiceSessionId: string;
  ownerHash: string;
  generation: number;
  hardCutoffAt: string;
  offer: string;
  session: DavoProviderSessionConfig;
};

export type DavoProviderStop = { voiceSessionId: string; generation: number };

export type DavoProviderCallErrorCode =
  | 'davo_provider_unavailable'
  | 'davo_provider_control_unsupported'
  | 'davo_provider_hangup_ambiguous'
  | 'davo_store_unavailable'
  | 'davo_generation_changed';

export type DavoProviderNegotiationResult =
  | { ok: true; answer: string }
  | { ok: false; code: DavoProviderCallErrorCode };

export type DavoProviderStopResult =
  | { ok: true; status: 'closed' | 'absent' }
  | { ok: false; code: DavoProviderCallErrorCode };

export type DavoProviderBulkCloseResult =
  | { ok: true; closed: number }
  | { ok: false; code: DavoProviderCallErrorCode; closed: number };

export type DavoProviderFenceOutcome = { closedCallIds: string[] };

export type DavoProviderCallsOptions = {
  apiKey?: string;
  persistence: DavoProviderCallPersistence;
  fetch?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
  providerMaximumMs?: number;
};

// distinguish a proven pre-transport refusal
export class ProviderRequestNotSentError extends Error {
  // create a content-free transport marker
  constructor() {
    super('provider request not sent');
    this.name = 'ProviderRequestNotSentError';
  }
}

// own trusted provider call handles
export class DavoProviderCalls {
  private readonly apiKey: string | undefined;
  private readonly persistence: DavoProviderCallPersistence;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly providerMaximumMs: number;
  private memoryQuarantineUntil = 0;
  private serial: Promise<void> = Promise.resolve();

  // retain server-only dependencies
  constructor(options: DavoProviderCallsOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.persistence = options.persistence;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = boundedMilliseconds(options.requestTimeoutMs, defaultRequestTimeoutMs, 60_000);
    this.providerMaximumMs = boundedMilliseconds(options.providerMaximumMs, defaultProviderMaximumMs, defaultProviderMaximumMs);
  }

  // create and durably register one call
  negotiate(request: DavoProviderNegotiation): Promise<DavoProviderNegotiationResult> {
    return this.serialize(async () => {
      // require trusted storage and credentials
      if (this.persistence.mode !== 0o600 || this.apiKey === undefined) return { ok: false, code: 'davo_provider_unavailable' };
      // reject malformed server-side input
      if (!validNegotiation(request)) return { ok: false, code: 'davo_provider_control_unsupported' };
      // fail closed while an unpersisted uncertainty remains live
      if (this.memoryQuarantineUntil > this.now().getTime()) return { ok: false, code: 'davo_store_unavailable' };
      this.memoryQuarantineUntil = 0;
      const available = await this.clearExpiredQuarantine();
      // block ambiguous or already active transports
      if (!available.ok) return available;
      let existing: DavoProviderCallPersistenceState;
      try { existing = await this.persistence.read(); }
      catch { return { ok: false, code: 'davo_store_unavailable' }; }
      // preserve one active transport frontier
      if (existing.providerCalls.length > 0) return { ok: false, code: 'davo_provider_unavailable' };

      const requestStartedAt = this.now();
      const creationFenceEndsAt = new Date(requestStartedAt.getTime() + this.requestTimeoutMs + this.providerMaximumMs).toISOString();
      const creationFence = await this.persistQuarantine(creationFenceEndsAt);
      // never create provider state without a durable maximum-lifetime fence
      if (creationFence === undefined) return { ok: false, code: 'davo_store_unavailable' };
      const credential = typeof request.session.clientSecret === 'string' && request.session.clientSecret.trim() !== '' ? request.session.clientSecret : this.apiKey;
      const providerSession = { ...request.session };
      delete providerSession.clientSecret;
      const body = new FormData();
      body.set('sdp', request.offer);
      body.set('session', JSON.stringify(providerSession));
      let response: Response;
      try {
        response = await this.fetch(callsEndpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}` },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (error) {
        // clear only explicit proof that the request never crossed the transport boundary
        if (error instanceof ProviderRequestNotSentError) {
          const cleared = await this.clearPostCreateQuarantine(creationFence);
          return { ok: false, code: cleared ? 'davo_provider_unavailable' : 'davo_store_unavailable' };
        }
        return { ok: false, code: 'davo_provider_unavailable' };
      }
      // require successful SDP creation
      if (!response.ok) return { ok: false, code: 'davo_provider_unavailable' };
      const createdAt = this.now();
      const providerMaximumEndsAt = new Date(createdAt.getTime() + this.providerMaximumMs).toISOString();
      const callId = trustedCallId(response.headers.get('location'));
      // quarantine creations without trusted cleanup authority
      if (callId === undefined) return { ok: false, code: 'davo_provider_control_unsupported' };
      let answer: string;
      try { answer = await response.text(); }
      catch {
        return this.cleanupPostCreate(callId, creationFence, 'davo_provider_unavailable');
      }
      // reject unbounded provider answers
      if (utf8Bytes(answer) === 0 || utf8Bytes(answer) > maxOfferBytes) {
        return this.cleanupPostCreate(callId, creationFence, 'davo_provider_control_unsupported');
      }
      const record: DavoProviderCallPrivateRecord = {
        callId,
        voiceSessionId: request.voiceSessionId,
        ownerHash: request.ownerHash,
        generation: request.generation,
        hardCutoffAt: request.hardCutoffAt,
        createdAt: createdAt.toISOString(),
        providerMaximumEndsAt,
        hangup: { state: 'ready', definitelyNotSentRetries: 0 }
      };
      try {
        await this.persistence.mutate(state => {
          // bind successful ownership to this exact unwidened creation fence
          if (!creationFence.clearable || state.providerQuarantineUntil !== creationFence.until) throw new Error('provider creation fence changed');
          const { providerQuarantineUntil: _, ...available } = state;
          return { state: { ...available, providerCalls: [...available.providerCalls, record] }, result: undefined };
        });
      } catch {
        // the creation fence already precedes this cleanup effect
        await this.cleanupPostCreate(callId, creationFence, 'davo_store_unavailable');
        return { ok: false, code: 'davo_store_unavailable' };
      }
      return { ok: true, answer };
    });
  }

  // stop only the exact session generation
  stop(request: DavoProviderStop): Promise<DavoProviderStopResult> {
    return this.serialize(() => this.stopExact(request));
  }

  // stop every selected live call
  closeAll(options: { generation?: number } = {}): Promise<DavoProviderBulkCloseResult> {
    return this.serialize(async () => {
      let records: DavoProviderCallPrivateRecord[];
      try {
        const state = await this.persistence.read();
        records = state.providerCalls.filter(record => options.generation === undefined || record.generation === options.generation);
      } catch {
        return { ok: false, code: 'davo_store_unavailable', closed: 0 };
      }
      let closed = 0;
      // close each cleanup handle serially
      for (const record of records) {
        const result = await this.stopExact({ voiceSessionId: record.voiceSessionId, generation: record.generation });
        // count accepted removals
        if (result.ok && result.status === 'closed') closed += 1;
        // stop after uncertainty
        if (!result.ok) return { ...result, closed };
      }
      return { ok: true, closed };
    });
  }

  // stop calls older than one generation
  expire(options: { beforeGeneration: number }): Promise<DavoProviderBulkCloseResult> {
    return this.serialize(async () => {
      let records: DavoProviderCallPrivateRecord[];
      try {
        const state = await this.persistence.read();
        records = state.providerCalls.filter(record => record.generation < options.beforeGeneration);
      } catch {
        return { ok: false, code: 'davo_store_unavailable', closed: 0 };
      }
      let closed = 0;
      // close every expired cleanup handle
      for (const record of records) {
        const result = await this.stopExact({ voiceSessionId: record.voiceSessionId, generation: record.generation });
        // count accepted removals
        if (result.ok && result.status === 'closed') closed += 1;
        // stop after uncertainty
        if (!result.ok) return { ...result, closed };
      }
      return { ok: true, closed };
    });
  }

  // reconcile crash-interrupted hangups
  recover(): Promise<DavoProviderBulkCloseResult | DavoProviderStopResult> {
    return this.serialize(async () => {
      // recovery cannot erase process-local post-create uncertainty
      if (this.memoryQuarantineUntil > this.now().getTime()) return { ok: false, code: 'davo_store_unavailable' };
      let recoveredAmbiguity = false;
      try {
        await this.persistence.mutate(state => {
          const dispatching = state.providerCalls.filter(record => record.hangup.state === 'dispatching');
          // quarantine all uncertain recovered sends
          if (dispatching.length === 0) return { state, result: undefined };
          recoveredAmbiguity = true;
          const quarantine = latestIso(state.providerQuarantineUntil, ...dispatching.map(record => record.providerMaximumEndsAt));
          return { state: { providerCalls: state.providerCalls.filter(record => record.hangup.state !== 'dispatching'), providerQuarantineUntil: quarantine }, result: undefined };
        });
      } catch {
        return { ok: false, code: 'davo_store_unavailable' };
      }
      // never replay recovered dispatching
      if (recoveredAmbiguity) return { ok: false, code: 'davo_provider_hangup_ambiguous' };
      let state: DavoProviderCallPersistenceState;
      try { state = await this.persistence.read(); }
      catch { return { ok: false, code: 'davo_store_unavailable' }; }
      // preserve and surface an existing content-free uncertainty
      if (state.providerQuarantineUntil !== undefined && Date.parse(state.providerQuarantineUntil) > this.now().getTime()) return { ok: false, code: 'davo_provider_hangup_ambiguous' };
      let closed = 0;
      // recover only definitely unsent states
      for (const record of state.providerCalls) {
        const result = await this.stopExact({ voiceSessionId: record.voiceSessionId, generation: record.generation });
        // count accepted removals
        if (result.ok && result.status === 'closed') closed += 1;
        // stop after uncertainty
        if (!result.ok) return { ...result, closed };
      }
      return { ok: true, closed };
    });
  }

  // dispatch only cutoff claims already persisted as in-flight
  async closeFenced(records: DavoProviderCallPrivateRecord[]): Promise<DavoProviderFenceOutcome> {
    const closedCallIds: string[] = [];
    // never send without a server credential
    if (this.apiKey === undefined) return { closedCallIds };
    // attempt each exact persisted claim once
    for (const record of records) {
      // refuse unclaimed or malformed cutoff authority
      if (record.hangup.state !== 'dispatching' || !validIdentifier(record.callId)) continue;
      try {
        const response = await this.fetch(`${callsEndpoint}/${encodeURIComponent(record.callId)}/hangup`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
        // only provider success proves cutoff cleanup
        if (response.ok) closedCallIds.push(record.callId);
      } catch { /* ambiguous cutoff sends remain quarantined */ }
    }
    return { closedCallIds };
  }

  // run one exact hangup state machine
  private async stopExact(request: DavoProviderStop): Promise<DavoProviderStopResult> {
    let record: DavoProviderCallPrivateRecord | undefined;
    try {
      record = await this.persistence.mutate(state => {
        const match = state.providerCalls.find(item => item.voiceSessionId === request.voiceSessionId && item.generation === request.generation);
        // leave replacement sessions untouched
        if (match === undefined) return { state, result: undefined };
        const prepared = match.hangup.state === 'ready'
          ? { ...match, hangup: { state: 'prepared' as const, attemptId: randomUUID(), definitelyNotSentRetries: match.hangup.definitelyNotSentRetries } }
          : match;
        return { state: { ...state, providerCalls: state.providerCalls.map(item => item === match ? prepared : item) }, result: prepared };
      });
    } catch {
      return { ok: false, code: 'davo_store_unavailable' };
    }
    // report an already absent exact session
    if (record === undefined) return { ok: true, status: 'absent' };
    // quarantine recovered in-flight transport
    if (record.hangup.state === 'dispatching') return this.quarantine(record);

    // permit one bounded proven-not-sent retry
    while (record.hangup.state === 'prepared') {
      let dispatching: DavoProviderCallPrivateRecord;
      try {
        dispatching = await this.persistence.mutate(state => {
          const match = state.providerCalls.find(item => item.callId === record?.callId && item.hangup.state === 'prepared');
          // require the exact prepared claim
          if (match === undefined || match.hangup.state !== 'prepared') throw new Error('provider call state changed');
          const claimed: DavoProviderCallPrivateRecord = { ...match, hangup: { ...match.hangup, state: 'dispatching', attemptedAt: this.now().toISOString() } };
          return { state: { ...state, providerCalls: state.providerCalls.map(item => item === match ? claimed : item) }, result: claimed };
        });
      } catch {
        return { ok: false, code: 'davo_store_unavailable' };
      }
      try {
        const response = await this.fetch(`${callsEndpoint}/${encodeURIComponent(dispatching.callId)}/hangup`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
        // treat only documented HTTP success as severed
        if (!response.ok) return this.quarantine(dispatching);
      } catch (error) {
        // retry only explicit pre-transport proof
        if (error instanceof ProviderRequestNotSentError && dispatching.hangup.state === 'dispatching' && dispatching.hangup.definitelyNotSentRetries === 0) {
          try {
            record = await this.persistence.mutate(state => {
              const match = state.providerCalls.find(item => item.callId === dispatching.callId && item.hangup.state === 'dispatching');
              // require the exact live claim
              if (match === undefined || match.hangup.state !== 'dispatching') throw new Error('provider call state changed');
              const prepared: DavoProviderCallPrivateRecord = { ...match, hangup: { state: 'prepared', attemptId: randomUUID(), definitelyNotSentRetries: 1 } };
              return { state: { ...state, providerCalls: state.providerCalls.map(item => item === match ? prepared : item) }, result: prepared };
            });
            continue;
          } catch {
            return { ok: false, code: 'davo_store_unavailable' };
          }
        }
        return this.quarantine(dispatching);
      }
      try {
        await this.persistence.mutate(state => ({ state: { ...state, providerCalls: state.providerCalls.filter(item => item.callId !== dispatching.callId) }, result: undefined }));
      } catch {
        return this.quarantine(dispatching);
      }
      return { ok: true, status: 'closed' };
    }
    return this.quarantine(record);
  }

  // erase authority and retain only deadline
  private async quarantine(record: DavoProviderCallPrivateRecord): Promise<DavoProviderStopResult> {
    try {
      await this.persistence.mutate(state => ({
        state: {
          providerCalls: state.providerCalls.filter(item => item.callId !== record.callId),
          providerQuarantineUntil: latestIso(state.providerQuarantineUntil, record.providerMaximumEndsAt)
        },
        result: undefined
      }));
    } catch {
      return { ok: false, code: 'davo_store_unavailable' };
    }
    return { ok: false, code: 'davo_provider_hangup_ambiguous' };
  }

  // clear an elapsed content-free fence
  private async clearExpiredQuarantine(): Promise<{ ok: true } | { ok: false; code: DavoProviderCallErrorCode }> {
    try {
      return await this.persistence.mutate<{ ok: true } | { ok: false; code: DavoProviderCallErrorCode }>(state => {
        const until = state.providerQuarantineUntil;
        // allow calls without a current fence
        if (until === undefined) return { state, result: { ok: true } as const };
        // retain a future ambiguity fence
        if (Date.parse(until) > this.now().getTime()) return { state, result: { ok: false, code: 'davo_provider_hangup_ambiguous' } as const };
        const { providerQuarantineUntil: _, ...available } = state;
        return { state: available, result: { ok: true } as const };
      });
    } catch {
      return { ok: false, code: 'davo_store_unavailable' };
    }
  }

  // clean one created call or retain its maximum-duration fence
  private async cleanupPostCreate(callId: string, quarantine: { until: string; clearable: boolean }, code: DavoProviderCallErrorCode): Promise<DavoProviderNegotiationResult> {
    const closed = await this.immediateHangup(callId);
    // clear only the fence introduced by this proven cleanup
    if (closed) await this.clearPostCreateQuarantine(quarantine);
    return { ok: false, code };
  }

  // retain one quarantine durably or fail closed in memory
  private async persistQuarantine(providerMaximumEndsAt: string): Promise<{ until: string; clearable: boolean } | undefined> {
    try {
      return await this.persistence.mutate(state => {
        const until = latestIso(state.providerQuarantineUntil, providerMaximumEndsAt)!;
        const clearable = state.providerQuarantineUntil === undefined;
        return {
          state: {
            providerCalls: state.providerCalls,
            providerQuarantineUntil: until
          },
          result: { until, clearable }
        };
      });
    } catch {
      this.memoryQuarantineUntil = Math.max(this.memoryQuarantineUntil, Date.parse(providerMaximumEndsAt));
      return undefined;
    }
  }

  // clear only an unwidened fence after proven cleanup
  private async clearPostCreateQuarantine(quarantine: { until: string; clearable: boolean }): Promise<boolean> {
    // preserve any pre-existing ambiguity
    if (!quarantine.clearable) return false;
    try {
      return await this.persistence.mutate(state => {
        // preserve a concurrently widened or replaced fence
        if (state.providerQuarantineUntil !== quarantine.until) return { state, result: false };
        const { providerQuarantineUntil: _, ...available } = state;
        return { state: available, result: true };
      });
    } catch {
      return false;
    }
  }

  // prove immediate cleanup before returning no SDP
  private async immediateHangup(callId: string): Promise<boolean> {
    try {
      const response = await this.fetch(`${callsEndpoint}/${encodeURIComponent(callId)}/hangup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // serialize every storage and transport claim
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
}

// validate bounded trusted negotiation input
function validNegotiation(request: DavoProviderNegotiation): boolean {
  // require bounded opaque identifiers
  if (!validIdentifier(request.voiceSessionId) || !validIdentifier(request.ownerHash)) return false;
  // require a monotonic generation
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) return false;
  // require one future-capable ISO cutoff
  if (!validIso(request.hardCutoffAt)) return false;
  // require bounded SDP bytes
  if (utf8Bytes(request.offer) === 0 || utf8Bytes(request.offer) > maxOfferBytes || request.offer.includes('\0')) return false;
  // require the approved model family
  if (request.session.model !== 'gpt-realtime-2.1') return false;
  let session: string;
  try { session = JSON.stringify({ ...request.session, clientSecret: undefined }); }
  catch { return false; }
  // require bounded serializable session config
  if (utf8Bytes(session) > maxSessionBytes) return false;
  // require a bounded optional server-held credential
  if (request.session.clientSecret !== undefined && (typeof request.session.clientSecret !== 'string' || request.session.clientSecret.length > 4096 || request.session.clientSecret.includes('\0'))) return false;
  return true;
}

// extract one same-origin provider authority
function trustedCallId(location: string | null): string | undefined {
  // require an explicit response Location
  if (location === null) return undefined;
  let url: URL;
  try { url = new URL(location, callsEndpoint); }
  catch { return undefined; }
  // require the official exact origin and clean URL
  if (url.origin !== 'https://api.openai.com' || url.username || url.password || url.search || url.hash) return undefined;
  const match = /^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]{3,512})$/u.exec(url.pathname);
  return match?.[1];
}

// recognize bounded opaque identifiers
function validIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
}

// recognize canonical timestamps
function validIso(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

// choose a safe bounded duration
function boundedMilliseconds(value: number | undefined, fallback: number, maximum: number): number {
  // retain the safe default for malformed values
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

// count UTF-8 transport bytes
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// select the latest valid deadline
function latestIso(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  // compare each existing deadline
  for (const value of values) {
    // ignore absent or malformed deadlines
    if (value === undefined || !validIso(value)) continue;
    // retain the later deadline
    if (latest === undefined || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}
