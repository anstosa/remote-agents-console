import { randomBytes } from 'node:crypto';
import type { RemoteServer } from '../../config/schema.js';
import { signFederationBody, verifyControllerPresenceResponse, type ControllerPresenceRequest } from './service.js';

const proofFreshnessMs = 15_000;
const requestTimeoutMs = 3_000;
const maximumOrigins = 20;
const maximumOwnersPerOrigin = 2;
const maximumOwners = 40;
const maximumConcurrency = 4;
const maximumBodyBytes = 4_096;

type PresenceEntry = { ownerId: string; present?: boolean; receivedAt?: number };
export type PresenceAdmission = { ok: true } | { ok: false; code: 'owner_presence_capacity' | 'owner_presence_unavailable' };
export type RemoteControllerPresenceOptions = { localInstanceId: string; localEpoch: string; remoteServers: readonly RemoteServer[]; secret: string; fetch?: typeof fetch; now?: () => number };

// coordinate bounded signed remote-controller presence proofs
export class RemoteControllerPresenceService {
  private readonly entries = new Map<string, Map<string, PresenceEntry>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private active = 0;

  // retain configured origins and trusted transport dependencies
  constructor(private readonly options: RemoteControllerPresenceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    // reject unsafe or unexpectedly broad configuration
    if (!/^[A-Za-z0-9_-]{43}$/u.test(options.localEpoch) || Buffer.from(options.secret, 'base64url').length < 32 || options.remoteServers.length > maximumOrigins) throw new Error('invalid controller-presence configuration');
  }

  // require a fresh positive proof before a remote Watch is persisted
  async admit(originInstanceId: string, ownerId: string): Promise<PresenceAdmission> {
    const added = this.entries.get(originInstanceId)?.has(ownerId) !== true;
    // reserve capacity before any remote or durable work
    if (!this.track(originInstanceId, ownerId)) return { ok: false, code: 'owner_presence_capacity' };
    const present = await this.prove(originInstanceId, ownerId);
    // release only a reservation that did not produce a Watch
    if (!present && added) this.forget(originInstanceId, ownerId);
    return present ? { ok: true } : { ok: false, code: 'owner_presence_unavailable' };
  }

  // return a fresh proof while coalescing one query for each origin
  async prove(originInstanceId: string, ownerId: string): Promise<boolean> {
    // enroll retained Watches after target restart within exact capacity
    if (!this.track(originInstanceId, ownerId)) return false;
    const entry = this.entries.get(originInstanceId)!.get(ownerId)!;
    // reuse only a positive proof fresh from target receipt
    if (this.fresh(entry)) return true;
    await this.refreshOrigin(originInstanceId);
    return this.fresh(entry);
  }

  // release one owner after its final retained Watch is removed
  forget(originInstanceId: string, ownerId: string): void {
    const owners = this.entries.get(originInstanceId);
    // ignore unknown owner records
    if (owners === undefined) return;
    owners.delete(ownerId);
    // remove empty origin buckets
    if (owners.size === 0) this.entries.delete(originInstanceId);
  }

  // track one owner without evicting any live cache record
  private track(originInstanceId: string, ownerId: string): boolean {
    // require a configured origin and opaque stable owner
    if (this.server(originInstanceId) === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(ownerId)) return false;
    let owners = this.entries.get(originInstanceId);
    // create one origin bucket only within configured bounds
    if (owners === undefined) {
      if (this.entries.size >= maximumOrigins) return false;
      owners = new Map();
      this.entries.set(originInstanceId, owners);
    }
    // retain an existing owner idempotently
    if (owners.has(ownerId)) return true;
    // refuse a third owner or global overflow before mutation
    if (owners.size >= maximumOwnersPerOrigin || this.ownerCount() >= maximumOwners) return false;
    owners.set(ownerId, { ownerId });
    return true;
  }

  // coalesce and defer one origin refresh to collect simultaneous owners
  private async refreshOrigin(originInstanceId: string): Promise<void> {
    const active = this.inFlight.get(originInstanceId);
    // share an existing signed query
    if (active !== undefined) return await active;
    const operation = Promise.resolve().then(async () => await this.queryWithLimit(originInstanceId)).finally(() => this.inFlight.delete(originInstanceId));
    this.inFlight.set(originInstanceId, operation);
    await operation;
  }

  // bound aggregate remote-origin query concurrency
  private async queryWithLimit(originInstanceId: string): Promise<void> {
    await this.acquire();
    try { await this.queryOrigin(originInstanceId); }
    finally { this.release(); }
  }

  // acquire one of four exact transport slots
  private async acquire(): Promise<void> {
    // claim an immediately available slot
    if (this.active < maximumConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  // transfer one slot to a waiter or return it to the pool
  private release(): void {
    const next = this.waiting.shift();
    // retain the active count while handing the slot directly to one waiter
    if (next !== undefined) next();
    else this.active -= 1;
  }

  // query one configured origin and update only authenticated results
  private async queryOrigin(originInstanceId: string): Promise<void> {
    const server = this.server(originInstanceId);
    const owners = this.entries.get(originInstanceId);
    // refuse unknown or empty origin buckets
    if (server === undefined || owners === undefined || owners.size === 0) return;
    const request: ControllerPresenceRequest = { version: 1, origin_instance_id: originInstanceId, target_instance_id: this.options.localInstanceId, target_epoch: this.options.localEpoch, request_nonce: randomBytes(18).toString('base64url'), owners: [...owners.keys()] };
    // enforce the exact transport body bound before dispatch
    if (Buffer.byteLength(JSON.stringify(request)) > maximumBodyBytes) return;
    const signed = signFederationBody(this.options.secret, request, this.now());
    let response: Response | undefined;
    try {
      response = await this.fetch(new URL('/api/integration-federation/controller-presence', server.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-rac-federation-timestamp': signed.timestamp, 'x-rac-federation-signature': signed.signature }, body: JSON.stringify(request), signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch { response = undefined; }
    // transport and authentication failures cannot assert absence
    if (response?.ok !== true) return;
    const text = await boundedText(response, maximumBodyBytes);
    // reject missing or oversized bodies before parsing
    if (text === undefined) return;
    const receivedAt = this.now();
    let verified: ReturnType<typeof verifyControllerPresenceResponse>;
    try { verified = verifyControllerPresenceResponse(this.options.secret, response.headers.get('x-rac-federation-timestamp'), response.headers.get('x-rac-federation-signature'), JSON.parse(text), request, receivedAt); }
    catch { verified = undefined; }
    // unauthenticated responses cannot alter cached state
    if (verified === undefined) return;
    const byOwner = new Map(verified.owners.map(owner => [owner.owner_id, owner.present]));
    // store every authenticated result at target receipt time
    for (const entry of owners.values()) {
      const present = byOwner.get(entry.ownerId);
      // ignore owners enrolled after this exact request was constructed
      if (present === undefined) continue;
      entry.present = present;
      entry.receivedAt = receivedAt;
    }
  }

  // test one positive proof against target receipt freshness
  private fresh(entry: PresenceEntry): boolean { return entry.present === true && entry.receivedAt !== undefined && this.now() - entry.receivedAt <= proofFreshnessMs; }

  // locate one exact configured origin
  private server(originInstanceId: string): RemoteServer | undefined { return this.options.remoteServers.find(candidate => candidate.url.origin === originInstanceId); }

  // count every tracked owner across configured origins
  private ownerCount(): number {
    let count = 0;
    // add each bounded origin bucket
    for (const owners of this.entries.values()) count += owners.size;
    return count;
  }
}

// read a response without retaining bytes beyond the protocol limit
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
