import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import type { DavoNotification, PushMessage } from './notifications.js';
import type { NotificationEvent } from './notification-events.js';
import { defaultPushDiagnosticsFile, PushDiagnostics, type PushDiagnosticRecord, type PushDiagnosticStage } from './push-diagnostics.js';
import { loadVapidKeys } from './push-vapid.js';

type Stored = Record<string, PushSubscription>;
// inspect provider failures without logging response contents
type DeliveryFailure = { headers?: Record<string, string>; statusCode?: number };
// require the coalescing key for internal delivery
type DeliveryOptions = RequestOptions & { topic: string };
type DeliveryOutcome = 'accepted' | 'auth_rejected' | 'expired' | 'failed' | 'superseded';
// retain the exact registration and settled provider outcome
type DeliveryResult = { outcome: DeliveryOutcome; subscription: PushSubscription };
// distinguish storage failure stages
type StoreOperation = 'parse' | 'read' | 'write';
type RepairAdvice = 'push_subscription_expired' | 'push_provider_auth_rejected';
type RepairHint = { advice: RepairAdvice; endpoint: string; expiresAt: number };
export type PushSubscriptionResult = { accepted: true } | { accepted: false; error: 'invalid_push_subscription' | RepairAdvice };
type PushServiceOptions = { diagnostics?: PushDiagnostics; file?: string; now?: () => number; generationKey?: Buffer };
type DavoPushTargetState = 'ready' | 'dispatching' | 'accepted' | 'ambiguous';
type DavoPushTarget = { subscriptionDigest: string; state: DavoPushTargetState; updatedAt: string };
type DavoPushEvent = { eventId: string; messageDigest: string; createdAt: string; expiresAt: string; targets: DavoPushTarget[] };
type DavoPushStore = { schemaVersion: 1; events: DavoPushEvent[] };

export type DavoPushDeliveryCounts = { definitelyNotSent: number; acceptedAtLeastOnce: number; ambiguous: number };
export type DavoPushErrorCode = 'davo_push_conflict' | 'davo_push_capacity' | 'davo_push_expired' | 'davo_push_invalid';

export class DavoPushError extends Error {
  // expose one bounded coordinator-facing failure code
  constructor(readonly code: DavoPushErrorCode) {
    super(code);
    this.name = 'DavoPushError';
  }
}

const deliveryAttempts = 3;
const deliveryTimeoutMs = 10_000;
const maximumRetryAfterMs = 30_000;
const providerPendingThresholdMs = 10_000;
const repairHintLifetimeMs = 24 * 60 * 60 * 1_000;
const maximumRepairHints = 256;
const davoPushSchemaVersion = 1;
const maximumDavoPushBytes = 4 * 1024 * 1024;
const maximumDavoPushEvents = 4_096;

// derive a provider-safe coalescing key without exposing the application tag
const messageTopic = (tag: string): string => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

// derive a short diagnostic identity without exposing the push endpoint
const endpointFingerprint = (endpoint: string): string => createHash('sha256').update(endpoint).digest('base64url').slice(0, 12);

// encode credential fields without ambiguous separators
const credentialGenerationInput = (subscription: PushSubscription): string => [
  subscription.endpoint,
  subscription.expirationTime === undefined || subscription.expirationTime === null ? 'null' : String(subscription.expirationTime),
  subscription.keys.auth,
  subscription.keys.p256dh
].map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('');

// identify response statuses that may recover on a later attempt
const retryableStatus = (status: number | undefined): boolean => status === undefined || status === 408 || status === 429 || status >= 500;

// parse a provider delay in either seconds or HTTP-date form
const retryAfterMs = (error: DeliveryFailure, now: number): number | undefined => {
  // locate the case-insensitive provider header
  const entry = Object.entries(error.headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after');
  // use local backoff when the provider omitted the header
  if (entry === undefined) return undefined;
  const seconds = Number(entry[1]);
  // accept non-negative delta-seconds
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(entry[1]);
  // ignore malformed dates
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
};

// compare a stored subscription with the exact delivery target
const sameSubscription = (left: PushSubscription | undefined, right: PushSubscription): boolean => left?.endpoint === right.endpoint
  && left.expirationTime === right.expirationTime
  && left.keys.auth === right.keys.auth
  && left.keys.p256dh === right.keys.p256dh;

// hash one exact durable subscription snapshot without storing its secrets again
const subscriptionDigest = (subscription: PushSubscription): string => createHash('sha256').update(JSON.stringify({ endpoint: subscription.endpoint, ...(subscription.expirationTime === undefined ? {} : { expirationTime: subscription.expirationTime }), keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh } })).digest('base64url');

// hash one fixed-order generic Davo payload
const davoMessageDigest = (message: DavoNotification): string => createHash('sha256').update(JSON.stringify({ kind: message.kind, title: message.title, body: message.body, tag: message.tag, url: message.url })).digest('base64url');

// validate one bounded opaque event identity
const validDavoEventId = (value: string): boolean => value.length > 0 && value.length <= 256 && !value.includes('\0');

// validate one generic Davo payload without request text
const validDavoMessage = (eventId: string, message: DavoNotification): boolean => message?.kind === 'davo'
  && message.title === 'Davo update'
  && (message.body === 'Your request is complete' || message.body === 'Your input is needed')
  && message.tag === `davo-${eventId}`
  && message.url === '/#davo';

// summarize only durable delivery certainty
const davoCounts = (event: DavoPushEvent | undefined): DavoPushDeliveryCounts => ({
  definitelyNotSent: event?.targets.filter(target => target.state === 'ready').length ?? 0,
  acceptedAtLeastOnce: event?.targets.filter(target => target.state === 'accepted').length ?? 0,
  ambiguous: event?.targets.filter(target => target.state === 'ambiguous' || target.state === 'dispatching').length ?? 0
});

// manage ordered push delivery and persisted subscriptions
export class PushService {
  private keys?: { publicKey: string; privateKey: string };
  private initialization?: Promise<void>;
  private readonly legacyKeys = { publicKey: process.env.RAC_VAPID_PUBLIC_KEY, privateKey: process.env.RAC_VAPID_PRIVATE_KEY };
  private readonly file: string;
  private readonly now: () => number;
  private readonly generationKey: Buffer;
  private readonly repairHints = new Map<string, RepairHint>();
  private readonly davoAttemptsFile = process.env.RAC_DAVO_PUSH_ATTEMPTS_FILE ?? '.data/davo-push-attempts.json';
  private storeOperations: Promise<void> = Promise.resolve();
  private davoStoreOperations: Promise<void> = Promise.resolve();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly latestEvents = new Map<string, AbortController>();
  private readonly diagnosticOperations = new Set<Promise<void>>();
  private readonly davoEventQueues = new Map<string, Promise<void>>();
  readonly diagnostics: PushDiagnostics;

  // retain process-local repair advice while keeping durable VAPID state unchanged
  constructor(options: PushServiceOptions = {}) {
    this.file = options.file ?? process.env.RAC_PUSH_SUBSCRIPTIONS_FILE ?? '.data/push-subscriptions.json';
    this.now = options.now ?? (() => Date.now());
    this.generationKey = options.generationKey ?? randomBytes(32);
    this.diagnostics = options.diagnostics ?? new PushDiagnostics({ file: defaultPushDiagnosticsFile(this.file) });
  }

  // reuse one durable identity before exposing keys or delivering notifications
  async initialize(): Promise<void> {
    // coalesce initialization and allow recovery after a storage failure
    this.initialization ??= loadVapidKeys(this.file, this.legacyKeys).then(keys => { this.keys = keys; }).catch(error => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  // expose only the browser registration key
  get publicKey() {
    return this.keys?.publicKey;
  }

  // expose whether delivery is configured
  get enabled() {
    return this.keys !== undefined;
  }

  // validate and persist one subscription without racing other mutations
  async subscribe(subscription: PushSubscription) {
    return (await this.subscribeChecked(subscription)).accepted;
  }

  // upsert one exact credential generation or return bounded repair advice
  async subscribeChecked(subscription: PushSubscription): Promise<PushSubscriptionResult> {
    // reject malformed registrations before initializing storage
    if (!this.valid(subscription)) return { accepted: false, error: 'invalid_push_subscription' };
    await this.initialize();
    this.pruneRepairHints();
    const generation = this.generationDigest(subscription);
    const hinted = this.repairHints.get(generation);
    // return advice only for the exact failed credential generation
    if (hinted !== undefined) return { accepted: false, error: hinted.advice };
    await this.mutate(async all => {
      all[subscription.endpoint] = subscription;
    });
    // a replacement clears advice only for older generations at this endpoint
    for (const [digest, hint] of this.repairHints) {
      if (hint.endpoint === subscription.endpoint && digest !== generation) this.repairHints.delete(digest);
    }
    return { accepted: true };
  }

  // deliver one coalesced event to the current subscription snapshot
  async notify(message: PushMessage) {
    // keep Davo off the retrying/coalescing legacy path
    if (message.kind === 'davo') throw new DavoPushError('davo_push_invalid');
    await this.initialize();
    const topic = messageTopic(message.tag);
    const subscriptions = Object.values(await this.snapshot());
    const event = new AbortController();
    const previous = this.latestEvents.get(topic);
    this.latestEvents.set(topic, event);
    // interrupt only retry backoff for the superseded event
    if (previous !== undefined) previous.abort();
    try {
      const payload = JSON.stringify({ ...message, sentAt: this.now() });
      this.recordDiagnostic('generated', message);
      const options: DeliveryOptions = {
        TTL: message.kind === 'finished' ? 15 * 60 : 60 * 60,
        timeout: deliveryTimeoutMs,
        topic,
        urgency: message.kind === 'cleanup' ? 'normal' : 'high',
        // keep signing credentials local to this service rather than global sender state
        vapidDetails: { subject: 'mailto:admin@localhost', publicKey: this.keys!.publicKey, privateKey: this.keys!.privateKey }
      };
      // deliver to independent endpoints concurrently
      const results = await Promise.all(subscriptions.map(async subscription => await this.queuedDelivery(subscription, payload, options, message.kind, event)));
      const rejected = results.filter(result => result.outcome === 'expired' || result.outcome === 'auth_rejected');
      // bind provider advice to generations still current after delivery settles
      if (rejected.length > 0) await this.applyRepairAdvice(rejected);
    } finally {
      // settle this notification's best-effort journal work before returning
      await this.flushDiagnostics();
      // retain a newer event marker
      if (this.latestEvents.get(topic) === event) this.latestEvents.delete(topic);
    }
  }

  // deliver one event once per durable subscription snapshot with explicit certainty
  async notifyDavo(eventId: string, message: DavoNotification, expiresAt: string): Promise<DavoPushDeliveryCounts> {
    // reject malformed new event authority
    if (!validDavoEventId(eventId) || !Number.isFinite(Date.parse(expiresAt))) throw new DavoPushError('davo_push_invalid');
    await this.initialize();
    return await this.serializeDavoEvent(eventId, async () => {
      const digest = davoMessageDigest(message);
      const subscriptions = Object.values(await this.snapshot());
      const byDigest = new Map(subscriptions.map(subscription => [subscriptionDigest(subscription), subscription]));
      const prepared = await this.mutateDavo(store => {
        const now = Date.now();
        this.pruneDavo(store, now);
        const existing = store.events.find(event => event.eventId === eventId);
        // bind every retry to the original body and expiry
        if (existing !== undefined) {
          if (existing.messageDigest !== digest || existing.expiresAt !== expiresAt) throw new DavoPushError('davo_push_conflict');
          // recovered possible sends are permanently ambiguous
          for (const target of existing.targets) {
            if (target.state !== 'dispatching') continue;
            target.state = 'ambiguous';
            target.updatedAt = new Date(now).toISOString();
          }
          return structuredClone(existing);
        }
        // validate content before creating a new durable event
        if (!validDavoMessage(eventId, message)) throw new DavoPushError('davo_push_invalid');
        if (Date.parse(expiresAt) <= now) throw new DavoPushError('davo_push_expired');
        if (store.events.length >= maximumDavoPushEvents) throw new DavoPushError('davo_push_capacity');
        const createdAt = new Date(now).toISOString();
        const event: DavoPushEvent = {
          eventId,
          messageDigest: digest,
          createdAt,
          expiresAt,
          targets: subscriptions.map(subscription => ({ subscriptionDigest: subscriptionDigest(subscription), state: 'ready', updatedAt: createdAt }))
        };
        store.events.push(event);
        return structuredClone(event);
      });
      const payload = JSON.stringify({ ...message, sentAt: Date.now() });
      const ttl = Math.max(0, Math.min(60 * 60, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000)));
      const options: DeliveryOptions = {
        TTL: ttl,
        timeout: deliveryTimeoutMs,
        topic: messageTopic(message.tag),
        urgency: 'high',
        vapidDetails: { subject: 'mailto:admin@localhost', publicKey: this.keys!.publicKey, privateKey: this.keys!.privateKey }
      };
      // attempt only targets still proven ready in the durable snapshot
      for (const target of prepared.targets) {
        if (target.state !== 'ready') continue;
        const subscription = byDigest.get(target.subscriptionDigest);
        // missing exact credentials remain definitely not sent
        if (subscription === undefined) continue;
        const claimed = await this.mutateDavo(store => {
          this.pruneDavo(store, Date.now());
          const stored = store.events.find(event => event.eventId === eventId)?.targets.find(candidate => candidate.subscriptionDigest === target.subscriptionDigest);
          // claim exactly one provider attempt
          if (stored === undefined || stored.state !== 'ready') return false;
          stored.state = 'dispatching';
          stored.updatedAt = new Date().toISOString();
          return true;
        });
        if (!claimed) continue;
        // close the expiry race after fsync and before any provider send
        if (Date.now() >= Date.parse(expiresAt)) { await this.pruneDavoAttempts(); continue; }
        try {
          await webpush.sendNotification(subscription, payload, options);
          await this.settleDavoTarget(eventId, target.subscriptionDigest, 'accepted');
        } catch (error) {
          // davo diagnostics never expose endpoint fingerprints or request metadata
          console.warn('[davo] notification delivery ambiguous');
          await this.settleDavoTarget(eventId, target.subscriptionDigest, 'ambiguous');
        }
      }
      const current = await this.snapshotDavo(eventId);
      return davoCounts(current);
    });
  }

  // serialize one logical event across duplicate local callers
  private async serializeDavoEvent<T>(eventId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.davoEventQueues.get(eventId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.davoEventQueues.set(eventId, settled);
    try { return await current; }
    finally {
      // delete only the latest event queue position
      if (this.davoEventQueues.get(eventId) === settled) this.davoEventQueues.delete(eventId);
    }
  }

  // commit one provider outcome only from its exact dispatching claim
  private async settleDavoTarget(eventId: string, digest: string, state: 'accepted' | 'ambiguous'): Promise<void> {
    await this.mutateDavo(store => {
      this.pruneDavo(store, Date.now());
      const target = store.events.find(event => event.eventId === eventId)?.targets.find(candidate => candidate.subscriptionDigest === digest);
      // never overwrite recovery ambiguity or another terminal result
      if (target === undefined || target.state !== 'dispatching') return;
      target.state = state;
      target.updatedAt = new Date().toISOString();
    });
  }

  // read one current event after prior local store mutations
  private async snapshotDavo(eventId: string): Promise<DavoPushEvent | undefined> {
    return await this.mutateDavo(store => {
      this.pruneDavo(store, Date.now());
      const event = store.events.find(candidate => candidate.eventId === eventId);
      return event === undefined ? undefined : structuredClone(event);
    });
  }

  // serialize one bounded event-store mutation
  private async mutateDavo<T>(operation: (store: DavoPushStore) => T | Promise<T>): Promise<T> {
    const mutation = this.davoStoreOperations.then(async () => {
      const store = await this.readDavo();
      const result = await operation(store);
      this.assertDavoBounds(store);
      await this.writeDavo(store);
      return result;
    });
    this.davoStoreOperations = mutation.then(() => undefined, () => undefined);
    return await mutation;
  }

  // remove only events past their immutable request expiry
  private pruneDavo(store: DavoPushStore, now: number): void {
    store.events = store.events.filter(event => Date.parse(event.expiresAt) > now);
  }

  // erase expired delivery metadata without admitting another notification
  async pruneDavoAttempts(): Promise<void> { await this.mutateDavo(store => { this.pruneDavo(store, Date.now()); }); }

  // load and validate the independent content-free event store
  private async readDavo(): Promise<DavoPushStore> {
    const serialized = await readFile(this.davoAttemptsFile, 'utf8').catch(error => {
      // treat only absence as an empty event store
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (serialized === undefined) return { schemaVersion: davoPushSchemaVersion, events: [] };
    if (Buffer.byteLength(serialized) > maximumDavoPushBytes) throw new DavoPushError('davo_push_capacity');
    const raw = JSON.parse(serialized) as unknown;
    // require one exact schema without payload extension fields
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new DavoPushError('davo_push_invalid');
    const value = raw as { schemaVersion?: unknown; events?: unknown };
    if (!Object.keys(raw).every(key => key === 'schemaVersion' || key === 'events') || value.schemaVersion !== davoPushSchemaVersion || !Array.isArray(value.events) || value.events.length > maximumDavoPushEvents) throw new DavoPushError('davo_push_invalid');
    const events = value.events as unknown[];
    // validate every event and target before use
    if (events.some(event => !this.validDavoEvent(event))) throw new DavoPushError('davo_push_invalid');
    const eventIds = new Set(events.map(event => (event as DavoPushEvent).eventId));
    if (eventIds.size !== events.length) throw new DavoPushError('davo_push_invalid');
    return { schemaVersion: davoPushSchemaVersion, events: events as DavoPushEvent[] };
  }

  // validate one persisted event without accepting payload text
  private validDavoEvent(value: unknown): value is DavoPushEvent {
    // require the exact event record shape
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const event = value as { eventId?: unknown; messageDigest?: unknown; createdAt?: unknown; expiresAt?: unknown; targets?: unknown };
    if (!Object.keys(value).every(key => ['eventId', 'messageDigest', 'createdAt', 'expiresAt', 'targets'].includes(key)) || typeof event.eventId !== 'string' || !validDavoEventId(event.eventId) || typeof event.messageDigest !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(event.messageDigest) || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.expiresAt !== 'string' || !Number.isFinite(Date.parse(event.expiresAt)) || !Array.isArray(event.targets)) return false;
    const targets = event.targets as unknown[];
    // validate every exact subscription snapshot target
    if (targets.some(target => {
      if (target === null || typeof target !== 'object' || Array.isArray(target)) return true;
      const candidate = target as { subscriptionDigest?: unknown; state?: unknown; updatedAt?: unknown };
      return !Object.keys(target).every(key => ['subscriptionDigest', 'state', 'updatedAt'].includes(key))
        || typeof candidate.subscriptionDigest !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.subscriptionDigest)
        || !(['ready', 'dispatching', 'accepted', 'ambiguous'] as readonly unknown[]).includes(candidate.state)
        || typeof candidate.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(candidate.updatedAt));
    })) return false;
    return new Set((targets as DavoPushTarget[]).map(target => target.subscriptionDigest)).size === targets.length;
  }

  // enforce active count and serialized byte caps
  private assertDavoBounds(store: DavoPushStore): void {
    // refuse growth instead of evicting active event certainty
    if (store.events.length > maximumDavoPushEvents || Buffer.byteLength(JSON.stringify(store)) > maximumDavoPushBytes) throw new DavoPushError('davo_push_capacity');
  }

  // atomically fsync one private event store replacement
  private async writeDavo(store: DavoPushStore): Promise<void> {
    await mkdir(dirname(this.davoAttemptsFile), { recursive: true });
    const next = `${this.davoAttemptsFile}.next`;
    const handle = await open(next, 'w', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(store));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(next, this.davoAttemptsFile);
    const directory = await open(dirname(this.davoAttemptsFile), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  }

  // serialize provider requests that can coalesce each other
  private async queuedDelivery(subscription: PushSubscription, payload: string, options: DeliveryOptions, kind: PushMessage['kind'], event: AbortController): Promise<DeliveryResult> {
    const key = `${options.topic}\0${subscription.endpoint}`;
    const previous = this.deliveryQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    // retain this queue position until delivery settles
    const gate = new Promise<void>(resolve => { release = resolve; });
    // append behind the resolving gate owned by the previous position
    const tail = previous.then(async () => await gate);
    this.deliveryQueues.set(key, tail);
    await previous;
    try {
      return await this.deliver(subscription, payload, options, kind, event);
    } finally {
      release();
      // delete only the final queue position
      if (this.deliveryQueues.get(key) === tail) this.deliveryQueues.delete(key);
    }
  }

  // send with bounded transient retries while this event remains newest
  private async deliver(subscription: PushSubscription, payload: string, options: DeliveryOptions, kind: PushMessage['kind'], event: AbortController): Promise<DeliveryResult> {
    const message = JSON.parse(payload) as PushMessage;
    // cap provider attempts for one endpoint
    for (let attempt = 1; attempt <= deliveryAttempts; attempt += 1) {
      // suppress an older event before any later attempt
      if (this.latestEvents.get(options.topic) !== event) return { outcome: 'superseded', subscription };
      this.recordDiagnostic('send_started', message, subscription, attempt);
      let pendingTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // observe a slow open request without imposing an application deadline
        pendingTimer = setTimeout(() => {
          this.recordDiagnostic('provider_pending', message, subscription, attempt, this.latestEvents.get(options.topic) === event ? 'request_active' : 'newer_waiting');
        }, providerPendingThresholdMs);
        pendingTimer.unref?.();
        await webpush.sendNotification(subscription, payload, options);
        this.recordDiagnostic('provider_accepted', message, subscription, attempt, 'accepted');
        return { outcome: 'accepted', subscription };
      } catch (error) {
        const failure = error as DeliveryFailure;
        const status = typeof failure.statusCode === 'number' ? failure.statusCode : undefined;
        this.recordDiagnostic('provider_failed', message, subscription, attempt, status === undefined ? 'network' : `http_${status}`);
        // let the caller prune an exact expired registration
        if (status === 404 || status === 410) {
          this.logFailure(subscription, status, attempt, kind, false);
          return { outcome: 'expired', subscription };
        }
        // preserve current credentials after provider authentication rejection
        if (status === 401 || status === 403) {
          this.logFailure(subscription, status, attempt, kind, false);
          return { outcome: 'auth_rejected', subscription };
        }
        const canRetry = attempt < deliveryAttempts && retryableStatus(status);
        const providerDelay = retryAfterMs(failure, this.now());
        const delay = providerDelay ?? 500 * 2 ** (attempt - 1);
        const willRetry = canRetry && delay <= maximumRetryAfterMs;
        this.logFailure(subscription, status, attempt, kind, willRetry);
        // stop on permanent, exhausted, or unreasonable-delay failures
        if (!willRetry) return { outcome: 'failed', subscription };
        // release the queue promptly when a newer event supersedes this retry
        if (!await this.waitForRetry(delay, event.signal)) return { outcome: 'superseded', subscription };
      } finally {
        // settle the observational timer with the owned provider request
        if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      }
    }
    return { outcome: 'failed', subscription };
  }

  // wait for retry backoff without aborting an in-flight provider request
  private async waitForRetry(delay: number, signal: AbortSignal): Promise<boolean> {
    try {
      await wait(delay, undefined, { signal });
      return true;
    } catch (error) {
      // treat only event supersession as a cancelled retry
      if (signal.aborted) return false;
      throw error;
    }
  }

  // emit only bounded delivery metadata
  private logFailure(subscription: PushSubscription, status: number | undefined, attempt: number, kind: PushMessage['kind'], retry: boolean): void {
    console.warn('[push] provider request failed', {
      attempt,
      endpointFingerprint: endpointFingerprint(subscription.endpoint),
      kind,
      retry,
      status: status ?? 'network'
    });
  }

  // derive a private process-local identity for one full credential generation
  private generationDigest(subscription: PushSubscription): string {
    return createHmac('sha256', this.generationKey).update(credentialGenerationInput(subscription)).digest('base64url');
  }

  // retain one bounded repair hint without persisting credential identity
  private rememberRepairAdvice(subscription: PushSubscription, advice: RepairAdvice): void {
    this.pruneRepairHints();
    const digest = this.generationDigest(subscription);
    this.repairHints.delete(digest);
    this.repairHints.set(digest, { advice, endpoint: subscription.endpoint, expiresAt: this.now() + repairHintLifetimeMs });
    // discard the oldest insertion beyond the fixed process-local cap
    while (this.repairHints.size > maximumRepairHints) {
      const oldest = this.repairHints.keys().next().value as string | undefined;
      // stop only if the map changed unexpectedly
      if (oldest === undefined) break;
      this.repairHints.delete(oldest);
    }
  }

  // expire old advice using the same injected service clock
  private pruneRepairHints(): void {
    const now = this.now();
    // inspect only the bounded process-local registry
    for (const [digest, hint] of this.repairHints) {
      if (hint.expiresAt <= now) this.repairHints.delete(digest);
    }
  }

  // record bounded content-free delivery metadata without gating delivery
  private recordDiagnostic(stage: PushDiagnosticStage, message: PushMessage, subscription?: PushSubscription, attempt?: number, status?: string): void {
    const event = 'eventId' in message ? message as NotificationEvent : undefined;
    const fields: Omit<PushDiagnosticRecord, 'id' | 'stage' | 'at'> = {
      kind: message.kind,
      ...(event === undefined ? {} : {
        eventId: event.eventId,
        eventEpoch: event.eventEpoch,
        eventSequence: event.eventSequence
      }),
      ...(subscription === undefined ? {} : { endpointFingerprint: endpointFingerprint(subscription.endpoint) }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(status === undefined ? {} : { status })
    };
    // isolate journal failures from provider work while retaining shutdown ordering
    const operation = this.diagnostics.record(stage, fields).catch(() => undefined);
    this.diagnosticOperations.add(operation);
    void operation.then(() => { this.diagnosticOperations.delete(operation); });
  }

  // wait only after provider work so journal latency never delays a send attempt
  private async flushDiagnostics(): Promise<void> {
    // include every stage already scheduled for this process tick
    while (this.diagnosticOperations.size > 0) await Promise.all([...this.diagnosticOperations]);
  }

  // validate the browser subscription shape
  private valid(value: PushSubscription): value is PushSubscription {
    return typeof value?.endpoint === 'string'
      && value.endpoint.startsWith('https://')
      && typeof value.keys?.p256dh === 'string'
      && value.keys.p256dh.length > 0
      && typeof value.keys.auth === 'string'
      && value.keys.auth.length > 0
      && (value.expirationTime === undefined || value.expirationTime === null || Number.isSafeInteger(value.expirationTime));
  }

  // read after all mutations already queued by this instance
  private async snapshot(): Promise<Stored> {
    const snapshot = this.storeOperations.then(async () => await this.read());
    // preserve invocation order and recover the store queue after failure
    this.storeOperations = snapshot.then(() => {}, () => {});
    return await snapshot;
  }

  // apply provider advice only while the failed credentials remain current
  private async applyRepairAdvice(rejected: DeliveryResult[]): Promise<void> {
    const current: DeliveryResult[] = [];
    await this.mutate(async all => {
      // preserve replacements registered during an older delivery
      for (const result of rejected) {
        // ignore advice for credentials no longer stored
        if (!sameSubscription(all[result.subscription.endpoint], result.subscription)) continue;
        current.push(result);
        // prune only exact expired credentials
        if (result.outcome === 'expired') delete all[result.subscription.endpoint];
      }
    });
    // publish hints only after the protected mutation succeeds
    for (const result of current) {
      this.rememberRepairAdvice(result.subscription, result.outcome === 'expired' ? 'push_subscription_expired' : 'push_provider_auth_rejected');
    }
  }

  // serialize every read-modify-write operation on the subscription file
  private async mutate(operation: (all: Stored) => void | Promise<void>): Promise<void> {
    const mutation = this.storeOperations.then(async () => {
      const all = await this.read();
      await operation(all);
      await this.write(all);
    });
    // keep later mutations usable after a failed write
    this.storeOperations = mutation.then(() => {}, () => {});
    await mutation;
  }

  // load an empty store when the file is absent
  private async read(): Promise<Stored> {
    let serialized: string;
    try {
      serialized = await readFile(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // treat only an absent store as empty
      if (code === 'ENOENT') return {};
      this.logStoreFailure('read', error);
      throw error;
    }
    try {
      return JSON.parse(serialized) as Stored;
    } catch (error) {
      this.logStoreFailure('parse', error);
      throw error;
    }
  }

  // atomically replace the subscription store
  private async write(value: Stored) {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      await writeFile(next, JSON.stringify(value), { mode: 0o600 });
      await rename(next, this.file);
    } catch (error) {
      this.logStoreFailure('write', error);
      throw error;
    }
  }

  // emit only bounded subscription-store metadata
  private logStoreFailure(operation: StoreOperation, error: unknown): void {
    const failure = error as NodeJS.ErrnoException;
    console.error('[push] subscription store failed', {
      code: typeof failure.code === 'string' ? failure.code : operation === 'parse' ? 'SyntaxError' : 'unknown',
      operation
    });
  }
}
