export type PushEnrollmentHealth = 'idle' | 'syncing' | 'retrying' | 'healthy' | 'blocked' | 'attention' | 'unsupported';
type PushEnrollmentTrigger = 'load' | 'permission' | 'pageshow' | 'visible' | 'controllerchange' | 'online' | 'pushsubscriptionchange';

type LifecycleRequest = (url: string, init?: RequestInit) => Promise<Response>;
type LifecycleDependencies = {
  request: LifecycleRequest;
  refreshAuthentication: (signal: AbortSignal) => Promise<boolean>;
  onResume: () => void;
};

type SubscriptionPostResult = 'healthy' | 'expired' | 'provider-auth' | 'auth' | 'transient' | 'failed';
type EnrollmentResponse = { status: number; ok: boolean; payload: unknown };

const retryDelays = [1_000, 5_000] as const;
const successCooldownMs = 60_000;
const registrationTimeoutMs = 1_500;
const enrollmentRequestTimeoutMs = 8_000;

// compare one application-server key without string conversions
const sameBytes = (left: ArrayBuffer | ArrayBufferView, right: Uint8Array): boolean => {
  const bytes = ArrayBuffer.isView(left) ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength) : new Uint8Array(left);
  // reject different key lengths first
  if (bytes.byteLength !== right.byteLength) return false;
  // compare every key byte
  for (let index = 0; index < bytes.byteLength; index += 1) {
    // stop on the first mismatch
    if (bytes[index] !== right[index]) return false;
  }
  return true;
};

// decode one url-safe vapid public key
const decodePublicKey = (value: string): Uint8Array | undefined => {
  // reject unbounded or malformed key text
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(value)) return undefined;
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
  } catch { return undefined; }
};

// compare exact browser subscription generations
const sameSubscription = (left: PushSubscription | null, right: PushSubscription): boolean => {
  // reject a missing replacement
  if (left === null) return false;
  try { return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON()); }
  catch { return false; }
};

// classify one checked subscription response
const classifyPost = (response: EnrollmentResponse): SubscriptionPostResult => {
  // preserve the established no-content success contract
  if (response.status === 204) return 'healthy';
  const payload = response.payload as { error?: unknown } | undefined;
  // rotate only the exact expired-generation result
  if (response.status === 409 && payload?.error === 'push_subscription_expired') return 'expired';
  // surface provider authentication health without rotation
  if (response.status === 409 && payload?.error === 'push_provider_auth_rejected') return 'provider-auth';
  // keep browser authentication separate from provider health
  if (response.status === 401 || response.status === 403) return 'auth';
  // retry only bounded transient failures
  if (response.status === 408 || response.status === 429 || response.status >= 500) return 'transient';
  return 'failed';
};

// coordinate checked push enrollment across page lifecycle triggers
export class PushSubscriptionLifecycle {
  private health: PushEnrollmentHealth = 'idle';
  private listeners = new Set<(health: PushEnrollmentHealth) => void>();
  private running: { generation: number; promise: Promise<void> } | undefined;
  private queued = false;
  private stopped = true;
  private generation = 0;
  private lastSuccessAt = 0;
  private timers = new Map<number, () => void>();
  private removers: Array<() => void> = [];

  // retain the page-owned network and auth boundaries
  constructor(private readonly dependencies: LifecycleDependencies) {}

  // expose the current compact health state
  getHealth = (): PushEnrollmentHealth => this.health;

  // subscribe one notification control
  onHealthChange = (listener: (health: PushEnrollmentHealth) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  // publish only actual health transitions
  private setHealth = (health: PushEnrollmentHealth, generation?: number): void => {
    // ignore a superseded lifecycle run
    if (generation !== undefined && !this.isCurrent(generation)) return;
    // suppress redundant renders
    if (health === this.health) return;
    this.health = health;
    // update every mounted compact control
    for (const listener of this.listeners) listener(health);
  };

  // wait through a cancellable retry delay
  private sleep = async (delay: number, generation: number): Promise<boolean> => await new Promise(resolve => {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      resolve(this.isCurrent(generation));
    }, delay);
    this.timers.set(timer, () => resolve(false));
  });

  // recognize only the active start generation
  private isCurrent = (generation: number): boolean => !this.stopped && generation === this.generation;

  // bound one cancellable page operation
  private boundedOperation = async <T>(operation: (signal: AbortSignal) => Promise<T>, timeout: number, generation: number): Promise<T | undefined> => await new Promise(resolve => {
    const controller = new AbortController();
    let settled = false;
    // settle exactly once and release the timeout
    const finish = (value: T | undefined) => {
      // ignore a late operation result
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      this.timers.delete(timer);
      resolve(this.isCurrent(generation) ? value : undefined);
    };
    const timer = window.setTimeout(() => {
      controller.abort();
      finish(undefined);
    }, timeout);
    this.timers.set(timer, () => {
      controller.abort();
      finish(undefined);
    });
    void operation(controller.signal).then(value => finish(value), () => finish(undefined));
  });

  // acquire only the current registration within a finite wait
  private currentRegistration = async (generation: number): Promise<ServiceWorkerRegistration | undefined> => {
    const serviceWorkers = navigator.serviceWorker;
    const registration = await this.boundedOperation(
      () => typeof serviceWorkers.getRegistration === 'function' ? serviceWorkers.getRegistration() : serviceWorkers.ready,
      registrationTimeoutMs,
      generation
    );
    // fence a stop or restart after registration lookup
    if (!this.isCurrent(generation)) return undefined;
    return registration;
  };

  // request one enrollment endpoint with a real abort signal
  private enrollmentRequest = async (url: string, init: RequestInit, generation: number): Promise<EnrollmentResponse | undefined> => {
    const response = await this.boundedOperation(async signal => {
      const fetched = await this.dependencies.request(url, { ...init, signal });
      // stop before reading a body for a superseded run
      if (!this.isCurrent(generation)) throw new DOMException('superseded', 'AbortError');
      // avoid a body read for the exact successful post contract
      const payload = fetched.status === 204 ? undefined : await fetched.json().catch(() => undefined) as unknown;
      // stop before publishing a body for a superseded run
      if (!this.isCurrent(generation)) throw new DOMException('superseded', 'AbortError');
      return { status: fetched.status, ok: fetched.ok, payload };
    }, enrollmentRequestTimeoutMs, generation);
    // fence a stop or restart after network completion
    if (!this.isCurrent(generation)) return undefined;
    return response;
  };

  // refresh authentication within the same request bound
  private refreshAuthentication = async (generation: number): Promise<boolean | undefined> => {
    const refreshed = await this.boundedOperation(signal => this.dependencies.refreshAuthentication(signal), enrollmentRequestTimeoutMs, generation);
    // fence a stop or restart after authentication refresh
    if (!this.isCurrent(generation)) return undefined;
    return refreshed;
  };

  // attach one lifecycle listener with its cleanup
  private listen = (target: EventTarget, type: string, listener: EventListener): void => {
    // retain partial legacy service-worker surfaces without lifecycle events
    if (typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener);
    this.removers.push(() => target.removeEventListener(type, listener));
  };

  // start authenticated lifecycle synchronization
  start = (): void => {
    // keep one listener set across duplicate controls
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.queued = false;
    this.listen(window, 'pageshow', () => { this.dependencies.onResume(); void this.trigger('pageshow'); });
    this.listen(window, 'online', () => { this.dependencies.onResume(); void this.trigger('online'); });
    this.listen(document, 'visibilitychange', () => {
      // sync only on a visible resume
      if (document.visibilityState === 'visible') { this.dependencies.onResume(); void this.trigger('visible'); }
    });
    // recover after the active worker changes
    if ('serviceWorker' in navigator) {
      this.listen(navigator.serviceWorker, 'controllerchange', () => void this.trigger('controllerchange'));
      this.listen(navigator.serviceWorker, 'message', event => {
        const value = (event as MessageEvent).data as { type?: unknown; protocolVersion?: unknown } | undefined;
        // treat the optional worker hint as additive only
        if (value?.type === 'rac-push-subscription-change' && value.protocolVersion === 1) void this.trigger('pushsubscriptionchange');
      });
    }
    void this.trigger('load');
  };

  // release lifecycle timers and listeners
  stop = (): void => {
    this.stopped = true;
    this.generation += 1;
    this.queued = false;
    this.running = undefined;
    // release every registered listener
    for (const remove of this.removers.splice(0)) remove();
    // cancel every outstanding retry timer
    for (const [timer, cancel] of this.timers) { window.clearTimeout(timer); cancel(); }
    this.timers.clear();
  };

  // request permission and immediately check enrollment
  enable = async (): Promise<NotificationPermission | undefined> => {
    // ignore browsers without notification permission support
    if (!('Notification' in window)) return undefined;
    const generation = this.generation;
    const permission = await Notification.requestPermission();
    // fence disposal while the browser prompt was open
    if (!this.isCurrent(generation)) return permission;
    // publish a terminal blocked state without retrying
    if (permission === 'denied') { this.setHealth('blocked'); return permission; }
    // check the granted browser subscription
    if (permission === 'granted') await this.trigger('permission', true);
    return permission;
  };

  // coalesce one lifecycle synchronization intent
  trigger = async (_reason: PushEnrollmentTrigger, force = false): Promise<void> => {
    // stop work after lifecycle disposal
    if (this.stopped) return;
    // never loop on denied permission
    if ('Notification' in window && Notification.permission === 'denied') { this.setHealth('blocked'); return; }
    // wait for an explicit permission choice
    if (!('Notification' in window) || Notification.permission !== 'granted') { this.setHealth('idle'); return; }
    // skip successful churn inside the cooldown
    if (!force && this.health === 'healthy' && Date.now() - this.lastSuccessAt < successCooldownMs) return;
    // coalesce with the active synchronization
    const generation = this.generation;
    if (this.running?.generation === generation) { this.queued = true; return this.running.promise; }
    const promise = this.synchronize(generation);
    this.running = { generation, promise };
    await promise;
    // leave a newer start generation untouched
    if (this.running?.promise === promise) this.running = undefined;
    if (!this.isCurrent(generation)) return;
    // retry a queued lifecycle edge only after a failed run
    if (this.queued) {
      this.queued = false;
      // a healthy cooldown already covers coalesced edges
      if (this.health !== 'healthy') await this.trigger(_reason);
    }
  };

  // post one generation with one bounded auth refresh
  private postSubscription = async (subscription: PushSubscription, repair: { authRefreshed: boolean }, generation: number): Promise<SubscriptionPostResult | undefined> => {
    const post = () => this.enrollmentRequest('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) }, generation);
    const response = await post();
    // stop before classifying a superseded request
    if (!this.isCurrent(generation)) return undefined;
    // retry a current-generation request timeout
    if (response === undefined) return 'transient';
    let result = classifyPost(response);
    // refresh the signed session and csrf once
    if (result === 'auth' && !repair.authRefreshed) {
      repair.authRefreshed = true;
      // retry this exact generation only after a successful refresh
      const refreshed = await this.refreshAuthentication(generation);
      // stop before retrying after a superseded refresh
      if (!this.isCurrent(generation)) return undefined;
      // retry a current-generation authentication timeout
      if (refreshed === undefined) return 'transient';
      if (refreshed) {
        const retried = await post();
        // fence disposal after the retry request
        if (!this.isCurrent(generation)) return undefined;
        // retry a current-generation post timeout
        if (retried === undefined) return 'transient';
        result = classifyPost(retried);
      }
    }
    return result;
  };

  // subscribe with the freshly fetched server key
  private createSubscription = async (pushManager: PushManager, key: Uint8Array): Promise<PushSubscription> => await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(key).buffer });

  // execute one checked synchronization with bounded transient retries
  private synchronize = async (generation: number): Promise<void> => {
    this.setHealth('syncing', generation);
    // wait for network recovery without scheduling loops
    if ('onLine' in navigator && !navigator.onLine) { this.setHealth('retrying', generation); return; }
    let lastResult: SubscriptionPostResult | 'unsupported' = 'unsupported';
    const repair = { recreated: false, authRefreshed: false };
    // cap one trigger to the initial try plus two retry delays
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      // stop a disposed lifecycle
      if (!this.isCurrent(generation)) return;
      // delay only retry attempts
      if (attempt > 0) {
        this.setHealth('retrying', generation);
        // stop when disposal cancels the delay
        if (!await this.sleep(retryDelays[attempt - 1]!, generation)) return;
        // fence disposal after the retry delay
        if (!this.isCurrent(generation)) return;
      }
      const result = await this.synchronizeAttempt(repair, generation);
      // fence every attempt completion before health mutation
      if (result === undefined || !this.isCurrent(generation)) return;
      lastResult = result;
      // publish a checked healthy enrollment
      if (lastResult === 'healthy') { this.lastSuccessAt = Date.now(); this.setHealth('healthy', generation); return; }
      // stop same-key churn on explicit provider health
      if (lastResult === 'provider-auth') { this.setHealth('attention', generation); return; }
      // wait for a later login after one auth refresh
      if (lastResult === 'auth') { this.setHealth('attention', generation); return; }
      // stop permanent or unsupported errors
      if (lastResult !== 'transient') { this.setHealth(lastResult === 'unsupported' ? 'unsupported' : 'attention', generation); return; }
    }
    this.setHealth(lastResult === 'unsupported' ? 'unsupported' : 'attention', generation);
  };

  // perform one fresh-key subscription check
  private synchronizeAttempt = async (repair: { recreated: boolean; authRefreshed: boolean }, generation: number): Promise<SubscriptionPostResult | 'unsupported' | undefined> => {
    try {
      // preserve legacy test and browser surfaces without pushmanager
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const registration = await this.currentRegistration(generation);
      // treat missing registration as a bounded transient state
      if (registration === undefined || !this.isCurrent(generation)) return this.isCurrent(generation) ? 'transient' : undefined;
      const pushManager = 'pushManager' in registration ? registration.pushManager : undefined;
      // do not surface missing push support as permanent enrollment damage
      if (pushManager === undefined) return 'unsupported';
      let keyResponse = await this.enrollmentRequest('/api/push/public-key', { cache: 'no-store' }, generation);
      // fence disposal or a timed-out key request
      if (keyResponse === undefined || !this.isCurrent(generation)) return this.isCurrent(generation) ? 'transient' : undefined;
      // refresh browser authentication once for a rejected rac key read
      if ((keyResponse.status === 401 || keyResponse.status === 403) && !repair.authRefreshed) {
        repair.authRefreshed = true;
        // retry the key read only after a successful refresh
        const refreshed = await this.refreshAuthentication(generation);
        // fence disposal after authentication refresh
        if (!this.isCurrent(generation)) return undefined;
        // retry a current-generation authentication timeout
        if (refreshed === undefined) return 'transient';
        if (refreshed) {
          keyResponse = await this.enrollmentRequest('/api/push/public-key', { cache: 'no-store' }, generation);
          // fence disposal or a timed-out key retry
          if (keyResponse === undefined || !this.isCurrent(generation)) return this.isCurrent(generation) ? 'transient' : undefined;
        }
      }
      // classify key fetches under the same bounded transient policy
      if (!keyResponse.ok) return keyResponse.status === 408 || keyResponse.status === 429 || keyResponse.status >= 500 ? 'transient' : keyResponse.status === 401 || keyResponse.status === 403 ? 'auth' : 'failed';
      const payload = keyResponse.payload as { publicKey?: unknown } | undefined;
      const key = typeof payload?.publicKey === 'string' ? decodePublicKey(payload.publicKey) : undefined;
      // reject malformed key responses without rotating a valid identity
      if (key === undefined) return 'failed';
      let subscription = await pushManager.getSubscription();
      // fence disposal after browser subscription lookup
      if (!this.isCurrent(generation)) return undefined;
      const exposedKey = subscription?.options.applicationServerKey;
      // replace only a proved application-server-key mismatch
      if (subscription !== null && exposedKey !== null && exposedKey !== undefined && !sameBytes(exposedKey, key)) {
        await subscription.unsubscribe();
        // fence disposal after browser mutation
        if (!this.isCurrent(generation)) return undefined;
        subscription = null;
        repair.recreated = true;
      }
      // create only a missing or proved-mismatched subscription
      if (subscription === null) {
        subscription = await this.createSubscription(pushManager, key);
        // fence disposal after browser subscription creation
        if (!this.isCurrent(generation)) return undefined;
      }
      let result = await this.postSubscription(subscription, repair, generation);
      // fence disposal after posting the current generation
      if (result === undefined || !this.isCurrent(generation)) return undefined;
      // keep delayed exact-generation advice off a browser replacement
      if (result === 'expired' || result === 'provider-auth') {
        const current = await pushManager.getSubscription();
        // fence disposal after replacement lookup
        if (!this.isCurrent(generation)) return undefined;
        // check the replacement generation instead of churning it
        if (!sameSubscription(current, subscription)) {
          if (current === null) return 'transient';
          const currentResult = await this.postSubscription(current, repair, generation);
          // fence disposal after replacement post
          if (currentResult === undefined || !this.isCurrent(generation)) return undefined;
          return currentResult;
        }
      }
      // preserve every result except exact expired generation advice
      if (result !== 'expired') return result;
      // never recreate twice within one lifecycle trigger
      if (repair.recreated) return 'failed';
      const current = await pushManager.getSubscription();
      // fence disposal after exact-generation lookup
      if (!this.isCurrent(generation)) return undefined;
      // ignore delayed advice for a replacement generation
      if (!sameSubscription(current, subscription)) {
        if (current === null) return 'transient';
        const currentResult = await this.postSubscription(current, repair, generation);
        // fence disposal after replacement post
        if (currentResult === undefined || !this.isCurrent(generation)) return undefined;
        return currentResult;
      }
      await subscription.unsubscribe();
      // fence disposal after exact-generation removal
      if (!this.isCurrent(generation)) return undefined;
      const replacement = await this.createSubscription(pushManager, key);
      // fence disposal after replacement creation
      if (!this.isCurrent(generation)) return undefined;
      repair.recreated = true;
      result = await this.postSubscription(replacement, repair, generation);
      // fence disposal after replacement post
      if (result === undefined || !this.isCurrent(generation)) return undefined;
      // never recreate twice within one trigger
      return result === 'expired' ? 'failed' : result;
    } catch {
      // treat browser/network exceptions as bounded transient failures
      return 'transient';
    }
  };
}
