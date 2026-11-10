import { expect, test, type Page, type Route } from '@playwright/test';

const currentKey = Array.from({ length: 65 }, (_, index) => (index + 1) % 256);
const oldKey = Array.from({ length: 65 }, (_, index) => (index + 2) % 256);
const encodedCurrentKey = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEE';

type BrowserSetup = {
  permission?: NotificationPermission;
  existingKey?: number[];
  withPushManager?: boolean;
  online?: boolean;
  registration?: 'available' | 'missing' | 'never-ready' | 'reject';
  stall?: 'public-key' | 'subscriptions' | 'auth-refresh';
};

type PushStats = {
  getSubscription: number;
  subscribe: number;
  unsubscribe: number;
  registrations: number;
  stalledRequests: number;
  aborts: number;
};

// install one controllable browser push surface
async function installPushBrowser(page: Page, setup: BrowserSetup = {}) {
  await page.addInitScript(({ currentKey, existingKey, permission, withPushManager, online, registrationState, initialStall }) => {
    const stats: PushStats = { getSubscription: 0, subscribe: 0, unsubscribe: 0, registrations: 0, stalledRequests: 0, aborts: 0 };
    let stalledPath = initialStall === 'public-key' ? '/api/push/public-key' : initialStall === 'subscriptions' ? '/api/push/subscriptions' : initialStall === 'auth-refresh' ? '/api/auth/session' : undefined;
    let authSessionReads = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      // distinguish bootstrap from a later enrollment refresh
      if (path === '/api/auth/session') authSessionReads += 1;
      // stall only the selected enrollment endpoint until its real signal aborts
      if (path === stalledPath && (initialStall !== 'auth-refresh' || authSessionReads > 1)) return await new Promise<Response>((_resolve, reject) => {
        stats.stalledRequests += 1;
        const abort = () => { stats.aborts += 1; reject(new DOMException('aborted', 'AbortError')); };
        // reject immediately if cancellation won the race
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
      // keep the successful prerequisite in-page while only enrollment is stalled
      if (initialStall === 'subscriptions' && path === '/api/push/public-key') {
        const publicKey = btoa(String.fromCharCode(...currentKey)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
        return new Response(JSON.stringify({ publicKey }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return await nativeFetch(input, init);
    };
    const makeSubscription = (key: number[], generation: number) => {
      const subscription = {
        endpoint: `https://push.invalid/subscription-${generation}`,
        expirationTime: null,
        options: { applicationServerKey: Uint8Array.from(key).buffer },
        // serialize one exact fake credential generation
        toJSON: () => ({ endpoint: `https://push.invalid/subscription-${generation}`, expirationTime: null, keys: { auth: `auth-${generation}`, p256dh: `p256dh-${generation}` } }),
        // remove only this current generation
        unsubscribe: async () => { stats.unsubscribe += 1; if (currentSubscription === subscription) currentSubscription = null; return true; }
      };
      return subscription;
    };
    let generation = 1;
    let currentSubscription: ReturnType<typeof makeSubscription> | null = existingKey === undefined ? null : makeSubscription(existingKey, generation);
    const pushManager = {
      // expose the current browser generation
      getSubscription: async () => { stats.getSubscription += 1; return currentSubscription; },
      // create one generation under the requested key
      subscribe: async ({ applicationServerKey }: { applicationServerKey: ArrayBuffer }) => {
        stats.subscribe += 1;
        generation += 1;
        currentSubscription = makeSubscription(Array.from(new Uint8Array(applicationServerKey)), generation);
        return currentSubscription;
      }
    };
    const registration = {
      ...(withPushManager === false ? {} : { pushManager }),
      active: null,
      getNotifications: async () => [],
      showNotification: async () => undefined
    };
    let activeRegistration = registrationState === 'available' ? registration : undefined;
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; register: () => Promise<typeof registration>; getRegistration: () => Promise<typeof registration | undefined> };
    serviceWorkers.ready = activeRegistration === undefined ? new Promise(() => { /* remain unresolved */ }) : Promise.resolve(activeRegistration);
    serviceWorkers.getRegistration = registrationState === 'never-ready' ? undefined as unknown as () => Promise<typeof registration | undefined> : async () => activeRegistration;
    serviceWorkers.register = async () => {
      stats.registrations += 1;
      // preserve one rejected startup registration
      if (registrationState === 'reject') throw new Error('registration rejected');
      return registration;
    };
    class NotificationFixture {
      static permission: NotificationPermission = permission;
      // grant only when the test requests permission
      static requestPermission = async () => NotificationFixture.permission;
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationFixture });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
    Object.defineProperty(window, '__pushStats', { configurable: true, value: stats });
    Object.defineProperty(window, '__pushLifecycle', {
      configurable: true,
      value: {
        // emit one service-worker controller replacement
        controllerchange: () => serviceWorkers.dispatchEvent(new Event('controllerchange')),
        // emit one network recovery edge
        online: () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); },
        // emit one page-cache restoration edge
        pageshow: () => window.dispatchEvent(new Event('pageshow')),
        // emit one visible resume edge
        visible: () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); },
        // simulate an independently replaced exact credential generation
        replace: () => { generation += 1; currentSubscription = makeSubscription(currentKey, generation); },
        // make a missing registration available for a later lifecycle edge
        register: () => { activeRegistration = registration; serviceWorkers.getRegistration = async () => activeRegistration; serviceWorkers.dispatchEvent(new Event('controllerchange')); },
        // release a stalled page request for the next lifecycle edge
        recover: () => { stalledPath = undefined; window.dispatchEvent(new Event('pageshow')); }
      }
    });
  }, { currentKey, existingKey: setup.existingKey, permission: setup.permission ?? 'granted', withPushManager: setup.withPushManager ?? true, online: setup.online ?? true, registrationState: setup.registration ?? 'available', initialStall: setup.stall });
}

// serve the minimum authenticated console and checked push endpoints
async function serveLifecycle(page: Page, options: {
  subscriptionResponses?: Array<{ status: number; error?: string }>;
  publicKeyResponses?: Array<{ status: number; publicKey?: string }>;
  active?: boolean;
  onSubscriptionRequest?: (count: number) => Promise<void>;
} = {}) {
  const subscriptionBodies: unknown[] = [];
  let sessionRequests = 0;
  let publicKeyRequests = 0;
  let subscriptionRequests = 0;
  let controlRequests = 0;
  let active = options.active ?? true;
  const respond = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one signed active or inactive session
    if (path === '/api/auth/session') { sessionRequests += 1; return route.fulfill({ json: { csrfToken: `csrf-${sessionRequests}`, active, deviceName: 'Lifecycle fixture' } }); }
    // render an empty authenticated console
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 100, agents: [], projects: [] } });
    // return each configured fresh key result
    if (path === '/api/push/public-key') {
      const response = options.publicKeyResponses?.[Math.min(publicKeyRequests, options.publicKeyResponses.length - 1)] ?? { status: 200, publicKey: encodedCurrentKey };
      publicKeyRequests += 1;
      return route.fulfill({ status: response.status, json: response.publicKey === undefined ? {} : { publicKey: response.publicKey } });
    }
    // retain exact posted browser generations
    if (path === '/api/push/subscriptions') {
      subscriptionRequests += 1;
      subscriptionBodies.push(request.postDataJSON());
      // allow one controlled exact-generation race
      if (options.onSubscriptionRequest !== undefined) await options.onSubscriptionRequest(subscriptionRequests);
      const response = options.subscriptionResponses?.[Math.min(subscriptionRequests - 1, options.subscriptionResponses.length - 1)] ?? { status: 204 };
      return route.fulfill({ status: response.status, ...(response.error === undefined ? {} : { json: { error: response.error } }) });
    }
    // accept bounded receipt flushes
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    // keep unrelated update polling quiet
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    // detect forbidden control takeover
    if (path.includes('take-control')) { controlRequests += 1; return route.fulfill({ status: 500 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  };
  await page.route('**/api/**', respond);
  return {
    subscriptionBodies,
    // change control state without taking over another session
    setActive: (next: boolean) => { active = next; },
    // expose exact request counters
    counters: () => ({ sessionRequests, publicKeyRequests, subscriptionRequests, controlRequests })
  };
}

// read deterministic browser push operation counts
const pushStats = (page: Page): Promise<PushStats> => page.evaluate(() => (window as typeof window & { __pushStats: PushStats }).__pushStats);

// emit one named lifecycle trigger
const trigger = (page: Page, name: 'controllerchange' | 'online' | 'pageshow' | 'visible' | 'register' | 'recover') => page.evaluate(name => (window as typeof window & { __pushLifecycle: Record<string, () => void> }).__pushLifecycle[name]!(), name);

test('checks and reuses a matching subscription without cooldown churn', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page);
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
  await Promise.all([trigger(page, 'pageshow'), trigger(page, 'visible'), trigger(page, 'controllerchange'), trigger(page, 'online')]);
  await page.waitForTimeout(100);
  expect(server.counters().subscriptionRequests).toBe(1);
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
});

test('replaces a proved application-server-key mismatch once', async ({ page }) => {
  await installPushBrowser(page, { existingKey: oldKey });
  const server = await serveLifecycle(page);
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 1, unsubscribe: 1 });
  expect(server.subscriptionBodies).toHaveLength(1);
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
});

test('repairs one exact expired generation without a second recreate loop', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, { subscriptionResponses: [{ status: 409, error: 'push_subscription_expired' }, { status: 204 }] });
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(2);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 1, unsubscribe: 1 });
  expect(server.subscriptionBodies).toHaveLength(2);
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
});

test('surfaces provider authentication health without same-key churn', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, { subscriptionResponses: [{ status: 409, error: 'push_provider_auth_rejected' }] });
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
  await expect(page.getByText('Alerts need attention')).toBeVisible();
});

test('reposts a replacement generation after delayed expired advice for the old tuple', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, {
    subscriptionResponses: [{ status: 409, error: 'push_subscription_expired' }, { status: 204 }],
    // replace A with B while A's checked post is in flight
    onSubscriptionRequest: async count => { if (count === 1) await page.evaluate(() => (window as typeof window & { __pushLifecycle: { replace: () => void } }).__pushLifecycle.replace()); }
  });
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(2);
  expect(server.subscriptionBodies).toEqual([expect.objectContaining({ endpoint: 'https://push.invalid/subscription-1' }), expect.objectContaining({ endpoint: 'https://push.invalid/subscription-2' })]);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
});

test('refreshes session and csrf once after a rac authentication rejection', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, { subscriptionResponses: [{ status: 401 }, { status: 204 }] });
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(2);
  expect(server.counters().sessionRequests).toBe(2);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
});

// exercise both authentication refresh entrypoints
for (const rejectedRequest of ['public-key', 'subscription-post'] as const) {
  // recover a stalled signed-session refresh without credential rotation
  test(`retries after a stalled authentication refresh for ${rejectedRequest}`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
    await installPushBrowser(page, { existingKey: currentKey, stall: 'auth-refresh' });
    const server = await serveLifecycle(page, rejectedRequest === 'public-key'
      ? { publicKeyResponses: [{ status: 401 }, { status: 200, publicKey: encodedCurrentKey }] }
      : { subscriptionResponses: [{ status: 401 }, { status: 204 }] });
    await page.goto('/');
    await expect.poll(() => pushStats(page), { timeout: 15_000 }).toMatchObject({ stalledRequests: 1 });
    await page.clock.runFor(8_000);
    await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 1, subscribe: 0, unsubscribe: 0 });
    const expectedPosts = rejectedRequest === 'public-key' ? 1 : 2;
    // advance through the one-second retry only as asynchronous ownership settles
    await expect.poll(async () => { await page.clock.runFor(100); return server.counters().subscriptionRequests; }).toBe(expectedPosts);
    await expect(page.getByText('Alerts need attention')).toHaveCount(0);
    await expect(page.getByText('Restoring alerts…')).toHaveCount(0);
    await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 1, subscribe: 0, unsubscribe: 0 });
    expect(server.counters().sessionRequests).toBe(1);
    expect(server.subscriptionBodies).toHaveLength(expectedPosts);
    // every retry retains the same exact browser credential tuple
    expect(server.subscriptionBodies).toEqual(server.subscriptionBodies.map(() => server.subscriptionBodies[0]));
  });
}

test('uses bounded one and five second retries without a fourth request at thirty seconds', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, { subscriptionResponses: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 204 }] });
  await page.goto('/');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await page.clock.fastForward(999);
  expect(server.counters().subscriptionRequests).toBe(1);
  await page.clock.fastForward(1);
  await expect.poll(() => server.counters().subscriptionRequests).toBe(2);
  await page.clock.fastForward(5_000);
  await expect.poll(() => server.counters().subscriptionRequests).toBe(3);
  await page.clock.fastForward(30_000);
  expect(server.counters().subscriptionRequests).toBe(3);
  await expect(page.getByText('Alerts need attention')).toBeVisible();
});

test('recovers on resume after the initial public-key response is invalid', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey });
  const server = await serveLifecycle(page, { publicKeyResponses: [{ status: 200 }, { status: 200, publicKey: encodedCurrentKey }] });
  await page.goto('/');
  await expect(page.getByText('Alerts need attention')).toBeVisible();
  await trigger(page, 'pageshow');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
});

test('does not retry denied permission or take control for an inactive session', async ({ page }) => {
  await installPushBrowser(page, { permission: 'denied', existingKey: currentKey });
  const server = await serveLifecycle(page, { active: false });
  await page.goto('/');
  await expect(page.getByText('Alerts blocked')).toBeVisible();
  await Promise.all([trigger(page, 'pageshow'), trigger(page, 'online'), trigger(page, 'controllerchange')]);
  await page.waitForTimeout(100);
  expect(server.counters()).toMatchObject({ publicKeyRequests: 0, subscriptionRequests: 0, controlRequests: 0 });
});

test('waits offline and checks the retained subscription on the next online edge', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey, online: false });
  const server = await serveLifecycle(page);
  await page.goto('/');
  expect(server.counters().publicKeyRequests).toBe(0);
  await trigger(page, 'online');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
});

test('keeps legacy service-worker mocks without pushmanager quiet', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installPushBrowser(page, { withPushManager: false });
  const server = await serveLifecycle(page);
  await page.goto('/');
  await page.waitForTimeout(100);
  expect(server.counters().subscriptionRequests).toBe(0);
  await expect(page.getByText('Alerts need attention')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('settles a never-ready registration and recovers on a later controller edge', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await installPushBrowser(page, { existingKey: currentKey, registration: 'never-ready' });
  const server = await serveLifecycle(page);
  await page.goto('/');
  // release the coordinator's bounded registration probe before lifecycle timing begins
  await expect.poll(() => server.counters().sessionRequests).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(1_500);
  await expect(page.getByText('Restoring alerts…')).toBeVisible({ timeout: 15_000 });
  // exhaust three finite registration lookups and two retry delays
  await page.clock.fastForward(1_500);
  await expect(page.getByText('Restoring alerts…')).toBeVisible();
  await page.clock.fastForward(1_000);
  await page.clock.fastForward(1_500);
  await expect(page.getByText('Restoring alerts…')).toBeVisible();
  await page.clock.fastForward(5_000);
  await page.clock.fastForward(1_500);
  await expect(page.getByText('Alerts need attention')).toBeVisible();
  expect(server.counters().publicKeyRequests).toBe(0);
  await trigger(page, 'register');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
});

test('releases a rejected registration run and recovers without duplicate subscribe', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await installPushBrowser(page, { existingKey: currentKey, registration: 'reject' });
  const server = await serveLifecycle(page);
  await page.goto('/');
  await expect(page.getByText('Restoring alerts…')).toBeVisible({ timeout: 15_000 });
  // exhaust the immediate missing-registration attempts
  await page.clock.fastForward(1_000);
  await expect(page.getByText('Restoring alerts…')).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(page.getByText('Alerts need attention')).toBeVisible();
  await trigger(page, 'register');
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ registrations: 1, subscribe: 0, unsubscribe: 0 });
});

for (const stalledEndpoint of ['public-key', 'subscriptions'] as const) {
  test(`aborts a stalled ${stalledEndpoint} request and recovers on the next page edge`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
    await installPushBrowser(page, { existingKey: currentKey, stall: stalledEndpoint });
    const server = await serveLifecycle(page);
    await page.goto('/');
    await expect.poll(() => pushStats(page), { timeout: 15_000 }).toMatchObject({ stalledRequests: 1 });
    // exhaust three eight-second request bounds and both retry delays
    await page.clock.runFor(8_000);
    await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 1 });
    // allow routed prerequisite work to settle after the retry timer
    await page.clock.runFor(1_100);
    // keep clock progress aligned with asynchronous retry scheduling
    await expect.poll(async () => { await page.clock.runFor(100); return await pushStats(page); }).toMatchObject({ stalledRequests: 2 });
    await page.clock.runFor(8_000);
    await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 2 });
    // allow routed prerequisite work to settle after the retry timer
    await page.clock.runFor(5_100);
    // keep clock progress aligned with asynchronous retry scheduling
    await expect.poll(async () => { await page.clock.runFor(100); return await pushStats(page); }).toMatchObject({ stalledRequests: 3 });
    await page.clock.runFor(8_000);
    await expect(page.getByText('Alerts need attention')).toBeVisible();
    await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 3, subscribe: 0, unsubscribe: 0 });
    // prove the settled trigger never schedules a fourth attempt
    await page.clock.runFor(30_000);
    await expect.poll(() => pushStats(page)).toMatchObject({ stalledRequests: 3, aborts: 3 });
    await trigger(page, 'recover');
    await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
    await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
  });
}

test('fences a stopped request generation and restarts cleanly after session recovery', async ({ page }) => {
  await installPushBrowser(page, { existingKey: currentKey, stall: 'public-key' });
  const server = await serveLifecycle(page);
  await page.goto('/');
  await expect.poll(() => pushStats(page), { timeout: 15_000 }).toMatchObject({ stalledRequests: 1 });
  server.setActive(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => server.counters().sessionRequests).toBeGreaterThanOrEqual(2);
  await expect.poll(() => pushStats(page)).toMatchObject({ aborts: 1, subscribe: 0, unsubscribe: 0 });
  // releasing the old request cannot post after its dashboard unmount
  await trigger(page, 'recover');
  await page.waitForTimeout(50);
  expect(server.counters().subscriptionRequests).toBe(0);
  server.setActive(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => server.counters().subscriptionRequests).toBe(1);
  await expect.poll(() => pushStats(page)).toMatchObject({ subscribe: 0, unsubscribe: 0 });
  expect(server.counters().controlRequests).toBe(0);
});
