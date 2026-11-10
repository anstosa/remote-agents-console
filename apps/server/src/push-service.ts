import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import type { PushMessage } from './notifications.js';
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

const deliveryAttempts = 3;
const deliveryTimeoutMs = 10_000;
const maximumRetryAfterMs = 30_000;
const providerPendingThresholdMs = 10_000;
const repairHintLifetimeMs = 24 * 60 * 60 * 1_000;
const maximumRepairHints = 256;

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

// manage ordered push delivery and persisted subscriptions
export class PushService {
  private keys?: { publicKey: string; privateKey: string };
  private initialization?: Promise<void>;
  private readonly legacyKeys = { publicKey: process.env.RAC_VAPID_PUBLIC_KEY, privateKey: process.env.RAC_VAPID_PRIVATE_KEY };
  private readonly file: string;
  private readonly now: () => number;
  private readonly generationKey: Buffer;
  private readonly repairHints = new Map<string, RepairHint>();
  private storeOperations: Promise<void> = Promise.resolve();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly latestEvents = new Map<string, AbortController>();
  private readonly diagnosticOperations = new Set<Promise<void>>();
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
