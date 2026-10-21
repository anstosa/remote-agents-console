import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import type { PushMessage } from './notifications.js';
import { loadVapidKeys } from './push-vapid.js';

type Stored = Record<string, PushSubscription>;
// inspect provider failures without logging response contents
type DeliveryFailure = { headers?: Record<string, string>; statusCode?: number };
// require the coalescing key for internal delivery
type DeliveryOptions = RequestOptions & { topic: string };
// retain rejected registrations for safe pruning
type DeliveryResult = { stale: boolean; subscription: PushSubscription };
// distinguish storage failure stages
type StoreOperation = 'parse' | 'read' | 'write';

const deliveryAttempts = 3;
const deliveryTimeoutMs = 10_000;
const maximumRetryAfterMs = 30_000;

// derive a provider-safe coalescing key without exposing the application tag
const messageTopic = (tag: string): string => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

// derive a short diagnostic identity without exposing the push endpoint
const endpointFingerprint = (endpoint: string): string => createHash('sha256').update(endpoint).digest('base64url').slice(0, 12);

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
  private readonly file = process.env.RAC_PUSH_SUBSCRIPTIONS_FILE ?? '.data/push-subscriptions.json';
  private storeOperations: Promise<void> = Promise.resolve();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly latestEvents = new Map<string, AbortController>();

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
    // reject malformed registrations before initializing storage
    if (!this.valid(subscription)) return false;
    await this.initialize();
    await this.mutate(async all => {
      all[subscription.endpoint] = subscription;
    });
    return true;
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
      const payload = JSON.stringify({ ...message, sentAt: Date.now() });
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
      const stale: PushSubscription[] = [];
      // collect provider-expired endpoints
      for (const result of results) {
        // retain only rejected registrations
        if (result.stale) stale.push(result.subscription);
      }
      // remove provider-expired targets in one serialized mutation
      if (stale.length > 0) await this.prune(stale);
    } finally {
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
    // cap provider attempts for one endpoint
    for (let attempt = 1; attempt <= deliveryAttempts; attempt += 1) {
      // suppress an older event before any later attempt
      if (this.latestEvents.get(options.topic) !== event) return { stale: false, subscription };
      try {
        await webpush.sendNotification(subscription, payload, options);
        return { stale: false, subscription };
      } catch (error) {
        const failure = error as DeliveryFailure;
        const status = typeof failure.statusCode === 'number' ? failure.statusCode : undefined;
        // let the caller prune expired provider registrations
        if (status === 404 || status === 410) {
          this.logFailure(subscription, status, attempt, kind, false);
          return { stale: true, subscription };
        }
        const canRetry = attempt < deliveryAttempts && retryableStatus(status);
        const providerDelay = retryAfterMs(failure, Date.now());
        const delay = providerDelay ?? 500 * 2 ** (attempt - 1);
        const willRetry = canRetry && delay <= maximumRetryAfterMs;
        this.logFailure(subscription, status, attempt, kind, willRetry);
        // stop on permanent, exhausted, or unreasonable-delay failures
        if (!willRetry) return { stale: false, subscription };
        // release the queue promptly when a newer event supersedes this retry
        if (!await this.waitForRetry(delay, event.signal)) return { stale: false, subscription };
      }
    }
    return { stale: false, subscription };
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

  // validate the browser subscription shape
  private valid(value: PushSubscription): value is PushSubscription {
    return typeof value?.endpoint === 'string'
      && value.endpoint.startsWith('https://')
      && typeof value.keys?.p256dh === 'string'
      && typeof value.keys.auth === 'string';
  }

  // read after all mutations already queued by this instance
  private async snapshot(): Promise<Stored> {
    const snapshot = this.storeOperations.then(async () => await this.read());
    // preserve invocation order and recover the store queue after failure
    this.storeOperations = snapshot.then(() => {}, () => {});
    return await snapshot;
  }

  // remove only registrations unchanged since the failed delivery
  private async prune(stale: PushSubscription[]): Promise<void> {
    await this.mutate(async all => {
      // preserve replacements registered during delivery
      for (const subscription of stale) {
        // remove only the exact rejected credentials
        if (sameSubscription(all[subscription.endpoint], subscription)) delete all[subscription.endpoint];
      }
    });
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
