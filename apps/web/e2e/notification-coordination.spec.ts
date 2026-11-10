import { expect, test, type CDPSession, type Page, type Route } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

const origin = 'http://127.0.0.1:4173';
const epoch = '00000000-0000-4000-8000-000000000001';

type Event = {
  schemaVersion: 1;
  eventId: string;
  eventEpoch: string;
  eventSequence: number;
  entityId: string;
  agentId: string;
  kind: 'finished' | 'question';
  generatedAt: number;
  tag: string;
  displayTag: string;
  worktreeId: string;
  url: string;
  title: string;
  body: string;
};
type Ack = { protocolVersion: number; outcome: string; audibleClaim: boolean; eventId?: string };
type Notice = { tag: string; data: Record<string, unknown> };
type NoticePresentation = { title: string; body: string; tag: string };

// use chromium's actual notification and service-worker implementation
test.use({ channel: 'chromium' });

// retain exact logical identity while varying agent and turn
function event(sequence = 1, agentId = 'agent-1'): Event {
  const tag = `agent-status-${agentId}`;
  return { schemaVersion: 1, eventId: `completion-${agentId}-${sequence}`, eventEpoch: epoch, eventSequence: sequence, entityId: `agent:${agentId}`, agentId, kind: 'finished', generatedAt: Date.now(), tag, displayTag: `rac-v1-${tag}`, worktreeId: 'shared-worktree', url: `/#agent=${agentId}`, title: `Done ${agentId}`, body: 'A completed turn is ready.' };
}

// register emitted worker code without contacting a live application backend
async function register(page: Page, session: CDPSession) {
  let registrationId: string | undefined;
  // capture the real chromium registration used for synthetic push dispatch
  session.on('ServiceWorker.workerRegistrationUpdated', update => {
    registrationId = update.registrations.find(entry => entry.scopeURL === `${origin}/` && !entry.isDeleted)?.registrationId ?? registrationId;
  });
  await session.send('ServiceWorker.enable');
  await page.route('**/notification-coordination-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Notification coordination</title>' }));
  await page.goto('/notification-coordination-harness');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrationId).toBeTruthy();
  return registrationId!;
}

// keep each request correlated through its own message channel
async function rpc(page: Page, operation: string, values: Record<string, unknown>): Promise<Ack> {
  return page.evaluate(async ({ operation, values }) => {
    const registration = await navigator.serviceWorker.ready;
    // fail explicitly instead of silently using a mocked worker
    if (registration.active === null) throw new Error('active worker unavailable');
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    return new Promise<Ack>((resolve, reject) => {
      const timer = window.setTimeout(() => { channel.port1.close(); reject(new Error(`worker ${operation} acknowledgement missing`)); }, 5_000);
      // only the matching versioned response may settle this request
      channel.port1.onmessage = message => {
        const ack = message.data;
        // unrelated or malformed messages must not count as protocol evidence
        if (ack?.protocolVersion !== 1 || ack.requestId !== requestId) return;
        window.clearTimeout(timer);
        channel.port1.close();
        resolve(ack as Ack);
      };
      registration.active!.postMessage({ protocolVersion: 1, requestId, operation, ...values }, [channel.port2]);
    });
  }, { operation, values });
}

// deliver through chromium rather than invoking the worker handler directly
const push = (session: CDPSession, registrationId: string, value: Event) => session.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(value) });

// inspect the notifications actually retained by the browser
const notices = (page: Page): Promise<Notice[]> => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(notification => ({ tag: notification.tag, data: notification.data as Record<string, unknown> })));

// inspect user-visible copy without coupling existing identity assertions to presentation fields
const noticePresentations = (page: Page): Promise<NoticePresentation[]> => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(notification => ({ title: notification.title, body: notification.body, tag: notification.tag })));

// deliver one server-shaped generic Davo alert through the real worker
const pushDavo = (session: CDPSession, registrationId: string, eventId: string, body: 'Your request is complete' | 'Your input is needed') => session.send('ServiceWorker.deliverPushMessage', {
  origin,
  registrationId,
  data: JSON.stringify({ kind: 'davo', title: 'Davo update', body, tag: `davo-${eventId}`, url: '/#davo', sentAt: Date.now() })
});

// all delivery orderings must converge without collapsing distinct turns
for (const order of ['page-first', 'push-first', 'concurrent'] as const) {
  test(`real page RPC and push coordinate the same event ${order}`, async ({ context, page }) => {
    await context.grantPermissions(['notifications'], { origin });
    const session = await context.newCDPSession(page);
    const registrationId = await register(page, session);
    const first = event();
    let ack: Ack;
    // cover each independently asynchronous channel order
    if (order === 'page-first') {
      ack = await rpc(page, 'display', { event: first, soundRequested: true });
      expect(ack.audibleClaim).toBe(true);
      await push(session, registrationId, first);
    } else if (order === 'push-first') {
      await push(session, registrationId, first);
      await expect.poll(() => notices(page)).toContainEqual(expect.objectContaining({ tag: first.displayTag }));
      ack = await rpc(page, 'display', { event: first, soundRequested: true });
      expect(ack.audibleClaim).toBe(false);
    } else {
      [ack] = await Promise.all([rpc(page, 'display', { event: first, soundRequested: true }), push(session, registrationId, first)]);
    }
    expect(ack.outcome).not.toBe('invalid');
    await expect.poll(() => notices(page)).toEqual([{ tag: first.displayTag, data: expect.objectContaining({ eventId: first.eventId, eventEpoch: epoch, eventSequence: 1 }) }]);
    const duplicate = await rpc(page, 'display', { event: first, soundRequested: true });
    expect(duplicate.audibleClaim).toBe(false);
    const next = event(2);
    const nextAck = await rpc(page, 'display', { event: next, soundRequested: true });
    expect(nextAck.audibleClaim).toBe(true);
    await expect.poll(() => notices(page)).toEqual([{ tag: next.displayTag, data: expect.objectContaining({ eventId: next.eventId, eventSequence: 2 }) }]);
    await session.detach();
  });
}

// an exact old close cannot delete the newer display occupying the same logical slot
test('delayed push and stale close preserve the newer exact event', async ({ context, page }) => {
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  const registrationId = await register(page, session);
  const first = event();
  const next = event(2);
  await rpc(page, 'display', { event: first, soundRequested: false });
  await rpc(page, 'display', { event: next, soundRequested: false });
  await push(session, registrationId, first);
  await expect.poll(async () => (await notices(page)).find(notice => notice.tag === next.displayTag)?.data.eventId).toBe(next.eventId);
  await expect.poll(async () => (await notices(page)).some(notice => notice.tag.startsWith('rac-v1-compat-'))).toBe(true);
  await rpc(page, 'close', { event: first });
  await expect.poll(async () => (await notices(page)).find(notice => notice.tag === next.displayTag)?.data.eventId).toBe(next.eventId);
  await session.detach();
});

// legacy writers and independent agents cannot mutate the strict current resource
test('legacy page tags and sibling agents do not replace strict current notifications', async ({ context, page }) => {
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  await register(page, session);
  const first = event();
  const sibling = event(1, 'agent-2');
  await rpc(page, 'display', { event: first, soundRequested: false });
  await rpc(page, 'display', { event: sibling, soundRequested: false });
  await page.evaluate(async tag => {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('Old page', { tag, silent: true });
    const legacy = await registration.getNotifications({ tag });
    // simulate the exact legacy tag-only dismissal without touching new namespaces
    for (const notification of legacy) notification.close();
  }, first.tag);
  await expect.poll(async () => (await notices(page)).map(notice => notice.tag).sort()).toEqual([first.displayTag, sibling.displayTag].sort());
  await session.detach();
});

// keep backend fixtures isolated while allowing the actual page notification helper to run
async function mountConsole(page: Page, rejectAudio = false, receipts?: (route: Route) => Promise<unknown>, initialAgents?: Array<Record<string, unknown>>) {
  await installDashboardSocket(page);
  await page.addInitScript(rejectAudio => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const sounds: string[] = [];
    const operations: unknown[] = [];
    Object.defineProperty(window, '__coordinationOperations', { value: operations });
    const dashboardReads: number[] = [];
    Object.defineProperty(window, '__coordinationDashboardReads', { value: dashboardReads });
    const nativeFetch = window.fetch;
    // retain the ordering of inventory replies and authoritative HTTP reads
    window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // record only the isolated dashboard request boundary
      if (new URL(url, location.origin).pathname === '/api/dashboard') dashboardReads.push(performance.now());
      return Reflect.apply(nativeFetch, window, args);
    };
    const NativeChannel = MessageChannel;
    // retain real worker acknowledgements for ordering evidence
    class CapturedChannel extends NativeChannel {
      constructor() {
        super();
        this.port1.addEventListener('message', event => {
          // ignore unrelated scheduler traffic on other native channels
          if (event.data?.protocolVersion === 1) operations.push({ direction: 'ack', at: performance.now(), value: event.data });
        });
      }
    }
    Object.defineProperty(window, 'MessageChannel', { configurable: true, value: CapturedChannel });
    const send = ServiceWorker.prototype.postMessage;
    // trace actual application RPCs without replacing worker behavior
    ServiceWorker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      operations.push({ direction: 'request', at: performance.now(), value: message });
      return Reflect.apply(send, this, [message, transfer]);
    };
    // record only custom playback; native notification attempts stay in the real worker
    class AudioFixture {
      volume = 1;
      // preserve the asset requested by the production helper
      constructor(readonly src: string) {}
      // retain the real helper's successful playback request
      async play() {
        sounds.push(this.src);
        // model a browser autoplay refusal after the worker's silent display
        if (rejectAudio) throw new DOMException('playback denied', 'NotAllowedError');
      }
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: AudioFixture });
    Object.defineProperty(window, '__coordinationSounds', { value: sounds });
  }, rejectAudio);
  const baseAgent = { id: 'agent-1', sessionId: 'socket:$1', panel: 'terminal', kind: 'codex', home: '/fixtures/worktree', title: 'Working', attention: 'working', worktreeId: 'shared-worktree', queuedPromptCount: 0, notificationState: { eventEpoch: epoch, eventSequence: 1 } };
  let dashboard: object = { generation: 1, serverStartedAt: 100, agents: initialAgents ?? [baseAgent], projects: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // authenticate the isolated console without requesting a real subscription
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Coordination fixture' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return receipts === undefined ? route.fulfill({ status: 204 }) : receipts(route);
    if (path === '/api/dashboard/ticket' || path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'fixture-ticket' } });
    if (/\/(?:queued-prompts|prompt-history|saved-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (path.endsWith('/notifications/dismiss')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  // allow cold production assets and worker startup to settle
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // observe the working baseline before publishing a completion transition
  if (initialAgents === undefined) {
    await expect(page.getByRole('tab', { name: / — Working$/u })).toBeVisible({ timeout: 15_000 });
    // flush the baseline render's passive effects before synthetic transitions
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  // publish one authoritative completed turn through both HTTP and socket paths
  return async (value: Event) => {
    dashboard = { generation: 2, serverStartedAt: 100, agents: [{ ...baseAgent, title: 'Ready', attention: 'finished', unread: true, completionId: value.eventId, notificationEvent: value, notificationState: { eventEpoch: epoch, eventSequence: value.eventSequence } }], projects: [] };
    await emitDashboard(page, dashboard);
  };
}

// davo-owned questions retain strict reconciliation identity but display only generic davo copy
test('suppresses ordinary question alerts for Davo-owned work while retaining the generic push', async ({ context, page }) => {
  test.setTimeout(45_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  let registrationId: string | undefined;
  // capture the application worker used by the generic push
  session.on('ServiceWorker.workerRegistrationUpdated', update => {
    registrationId = update.registrations.find(entry => entry.scopeURL === `${origin}/` && !entry.isDeleted)?.registrationId ?? registrationId;
  });
  await session.send('ServiceWorker.enable');
  await mountConsole(page);
  await expect.poll(() => registrationId).toBeTruthy();
  // keep the active Agent from suppressing the ordinary path for an unrelated focus reason
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); });
  const privateQuestion = 'Deploy the private customer database now?';
  const questionEvent = { ...event(2), kind: 'question' as const, eventId: 'davo-choice-2', title: 'Question in Remote Agents', body: privateQuestion };
  const questionAgent = {
    id: 'agent-1', sessionId: 'socket:$1', panel: 'terminal', kind: 'codex', home: '/fixtures/worktree', title: 'Ready', attention: 'question', worktreeId: 'shared-worktree', queuedPromptCount: 0,
    question: { id: questionEvent.eventId, text: privateQuestion, field: { kind: 'text', multiline: false }, source: 'structured' }, unread: true,
    notificationEvent: questionEvent, notificationState: { eventEpoch: epoch, eventSequence: questionEvent.eventSequence }, notificationSuppressed: true
  };
  await emitDashboard(page, { generation: 2, serverStartedAt: 100, agents: [questionAgent], projects: [] });
  await expect(page.getByRole('tab', { name: / — Action required$/u })).toBeVisible();
  // fence page effects ahead of the later generic worker push
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await rpc(page, 'inventory', {});
  await pushDavo(session, registrationId!, questionEvent.eventId, 'Your input is needed');
  await expect.poll(() => noticePresentations(page)).toEqual([{ title: 'Davo update', body: 'Your input is needed', tag: `davo-${questionEvent.eventId}` }]);
  // retain only page-display attempts for this exact question
  const pageDisplays = await page.evaluate(eventId => {
    const records = (window as typeof window & { __coordinationOperations: Array<{ direction: string; value: { operation?: string; event?: { eventId?: string } } }> }).__coordinationOperations;
    return records.filter(record => record.direction === 'request' && record.value.operation === 'display' && record.value.event?.eventId === eventId);
  }, questionEvent.eventId);
  expect(pageDisplays).toEqual([]);
  expect((await noticePresentations(page)).some(notice => notice.body.includes(privateQuestion))).toBe(false);
  expect(await page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds)).toEqual([]);
  await session.detach();
});

// davo-owned completions survive the grace refresh without an ordinary alert or chime
test('suppresses ordinary completion alerts for Davo-owned work while retaining the generic push', async ({ context, page }) => {
  test.setTimeout(45_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  let registrationId: string | undefined;
  // capture the application worker used by the generic push
  session.on('ServiceWorker.workerRegistrationUpdated', update => {
    registrationId = update.registrations.find(entry => entry.scopeURL === `${origin}/` && !entry.isDeleted)?.registrationId ?? registrationId;
  });
  await session.send('ServiceWorker.enable');
  await mountConsole(page);
  await expect.poll(() => registrationId).toBeTruthy();
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); });
  const completed = { ...event(2), eventId: 'davo-done-2' };
  const completedAgent = {
    id: 'agent-1', sessionId: 'socket:$1', panel: 'terminal', kind: 'codex', home: '/fixtures/worktree', title: 'Ready', attention: 'finished', worktreeId: 'shared-worktree', queuedPromptCount: 0, unread: true,
    completionId: completed.eventId, notificationEvent: completed, notificationState: { eventEpoch: epoch, eventSequence: completed.eventSequence }, notificationSuppressed: true
  };
  let dashboard = { generation: 2, serverStartedAt: 100, agents: [completedAgent], projects: [] };
  // serve the suppressed state when the completion grace timer refreshes
  await page.route('**/api/dashboard', route => route.fulfill({ json: dashboard }));
  const readsBeforeCompletion = await page.evaluate(() => (window as typeof window & { __coordinationDashboardReads: number[] }).__coordinationDashboardReads.length);
  await emitDashboard(page, dashboard);
  await expect(page.getByRole('tab', { name: / — Prompt done — Unread$/u })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __coordinationDashboardReads: number[] }).__coordinationDashboardReads.length), { timeout: 10_000 }).toBeGreaterThan(readsBeforeCompletion);
  // fence the grace refresh's page effects before checking the worker
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await rpc(page, 'inventory', {});
  await pushDavo(session, registrationId!, completed.eventId, 'Your request is complete');
  await expect.poll(() => noticePresentations(page)).toEqual([{ title: 'Davo update', body: 'Your request is complete', tag: `davo-${completed.eventId}` }]);
  // repeat the exact current snapshot without multiplying either notification path
  dashboard = { ...dashboard, generation: 3 };
  await emitDashboard(page, dashboard);
  await rpc(page, 'inventory', {});
  await expect.poll(() => noticePresentations(page)).toEqual([{ title: 'Davo update', body: 'Your request is complete', tag: `davo-${completed.eventId}` }]);
  // retain only page-display attempts for this exact completion
  const pageDisplays = await page.evaluate(eventId => {
    const records = (window as typeof window & { __coordinationOperations: Array<{ direction: string; value: { operation?: string; event?: { eventId?: string } } }> }).__coordinationOperations;
    return records.filter(record => record.direction === 'request' && record.value.operation === 'display' && record.value.event?.eventId === eventId);
  }, completed.eventId);
  expect(pageDisplays).toEqual([]);
  expect(await page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds)).toEqual([]);
  await session.detach();
});

// a rejected custom chime must retain one native audible attempt on the exact event
test('application audio rejection invokes the real worker native fallback', async ({ context, page }) => {
  test.setTimeout(45_000);
  await context.grantPermissions(['notifications'], { origin });
  const finish = await mountConsole(page, true);
  const completed = event(2);
  await finish(completed);
  await expect.poll(async () => (await notices(page)).find(notice => notice.tag === completed.displayTag)?.data.nativeFallbackAttempted, { timeout: 15_000 }).toBe(true);
  const displayed = await page.evaluate(async tag => (await (await navigator.serviceWorker.ready).getNotifications({ tag })).map(notification => ({ silent: notification.silent, eventId: notification.data?.eventId })), completed.displayTag);
  expect(displayed).toEqual([{ silent: false, eventId: completed.eventId }]);
  expect(await page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds)).toEqual(['/notification-success.wav']);
});

// the application must discover notifications displayed before any application module existed
for (const mode of ['read', 'resolved-question', 'unread', 'pending', 'cross-epoch', 'future', 'removed', 'unknown-entity'] as const) {
  test(`cold application reconciles worker-only ${mode} notification`, async ({ context, page }) => {
    test.setTimeout(45_000);
    await context.grantPermissions(['notifications'], { origin });
    const session = await context.newCDPSession(page);
    const registrationId = await register(page, session);
    const stored = { ...event(2), ...(mode === 'resolved-question' ? { kind: 'question' as const } : {}), ...(mode === 'unknown-entity' ? { entityId: 'future:unknown' } : {}) };
    await page.goto('about:blank');
    expect(context.pages().filter(candidate => candidate.url().startsWith(origin))).toHaveLength(0);
    await push(session, registrationId, stored);
    // a non-application probe verifies tray display without loading page notification memory
    await page.goto('/notification-coordination-harness');
    await expect.poll(async () => (await notices(page)).some(notice => notice.data.eventId === stored.eventId)).toBe(true);
    const base = { id: 'agent-1', sessionId: 'socket:$1', panel: 'terminal', kind: 'codex', home: '/fixtures/worktree', title: 'Ready', attention: 'finished', worktreeId: 'shared-worktree', queuedPromptCount: 0, unread: false, notificationState: { eventEpoch: epoch, eventSequence: 3 } };
    const current = mode === 'unread' || mode === 'pending'
      ? { ...base, unread: mode === 'unread', completionId: stored.eventId, notificationEvent: stored, notificationState: { eventEpoch: epoch, eventSequence: 2 } }
      : mode === 'cross-epoch' ? { ...base, notificationState: { eventEpoch: '00000000-0000-4000-8000-000000000002', eventSequence: 1 } }
        : mode === 'future' ? { ...base, attention: 'working', notificationState: { eventEpoch: epoch, eventSequence: 1 } } : base;
    await mountConsole(page, false, route => route.fulfill({ status: 503 }), mode === 'removed' || mode === 'unknown-entity' ? [] : [current]);
    // retained diagnostics prove the post-inventory reconciliation finished before assertions
    await expect.poll(async () => (await journalRecords(page)).some(record => record.stage === 'reconciled'), { timeout: 15_000 }).toBe(true);
    const retained = mode === 'unread' || mode === 'pending' || mode === 'cross-epoch' || mode === 'future' || mode === 'unknown-entity';
    await expect.poll(async () => (await notices(page)).some(notice => notice.data.eventId === stored.eventId), { timeout: 15_000 }).toBe(retained);
    const ordering = await page.evaluate(() => {
      const fixture = window as typeof window & { __coordinationOperations: Array<{ direction: string; at: number; value: { outcome?: string } }>; __coordinationDashboardReads: number[] };
      return { inventoryAt: fixture.__coordinationOperations.find(record => record.direction === 'ack' && record.value.outcome === 'listed')?.at, dashboardAt: fixture.__coordinationDashboardReads[0] };
    });
    expect(ordering.inventoryAt).toBeDefined();
    expect(ordering.dashboardAt).toBeGreaterThanOrEqual(ordering.inventoryAt!);
    await session.detach();
  });
}

// a stale http snapshot must not strand its pre-request worker inventory
test('recaptures worker inventory after a newer dashboard frame rejects stale http', async ({ context, page }) => {
  test.setTimeout(45_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  const registrationId = await register(page, session);
  const stored = event(2);
  await push(session, registrationId, stored);
  await expect.poll(async () => (await notices(page)).some(notice => notice.data.eventId === stored.eventId)).toBe(true);
  await installDashboardSocket(page);
  await page.addInitScript(() => {
    const operations: unknown[] = [];
    Object.defineProperty(window, '__inventoryRaceOperations', { configurable: true, value: operations });
    const send = ServiceWorker.prototype.postMessage;
    // trace exact worker requests without replacing worker behavior
    ServiceWorker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      operations.push(message);
      return Reflect.apply(send, this, [message, transfer]);
    };
  });
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
  let dashboardReads = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // authenticate the controlled console
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: true, deviceName: 'Inventory race fixture' } });
    // hold each authoritative snapshot at its race boundary
    if (path === '/api/dashboard') {
      dashboardReads += 1;
      // release generation one only after the websocket accepts generation two
      if (dashboardReads === 1) {
        markFirstStarted();
        await firstGate;
        return route.fulfill({ json: { generation: 1, serverStartedAt: 100, agents: [], projects: [] } });
      }
      markSecondStarted();
      await secondGate;
      return route.fulfill({ json: { generation: 3, serverStartedAt: 100, agents: [], projects: [] } });
    }
    if (path === '/api/dashboard/ticket' || path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'fixture-ticket' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 503 });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await firstStarted;
  // allow cold production assets and worker startup to settle
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await emitDashboard(page, { generation: 2, serverStartedAt: 100, agents: [], projects: [] });
  releaseFirst();
  await secondStarted;
  // the rejected generation cannot classify its captured worker identity
  expect((await notices(page)).some(notice => notice.data.eventId === stored.eventId)).toBe(true);
  const beforeAccepted = await page.evaluate(eventId => {
    const operations = (window as typeof window & { __inventoryRaceOperations: Array<{ operation?: string; entries?: Array<{ eventId?: string }> }> }).__inventoryRaceOperations;
    return {
      inventory: operations.filter(operation => operation.operation === 'inventory').length,
      exactReconciles: operations.filter(operation => operation.operation === 'reconcile' && operation.entries?.some(entry => entry.eventId === eventId)).length
    };
  }, stored.eventId);
  expect(beforeAccepted).toEqual({ inventory: 2, exactReconciles: 0 });
  releaseSecond();
  await expect.poll(async () => (await notices(page)).some(notice => notice.data.eventId === stored.eventId), { timeout: 15_000 }).toBe(false);
  const afterAccepted = await page.evaluate(eventId => {
    const operations = (window as typeof window & { __inventoryRaceOperations: Array<{ operation?: string; entries?: Array<{ eventId?: string }> }> }).__inventoryRaceOperations;
    return operations.filter(operation => operation.operation === 'reconcile' && operation.entries?.some(entry => entry.eventId === eventId)).length;
  }, stored.eventId);
  expect(afterAccepted).toBe(1);
  expect(dashboardReads).toBe(2);
  await session.detach();
});

// native fallback must target the exact compatibility resource, never its occupied strict slot
test('rejected application audio re-shows only its actual compatibility notification', async ({ context, page }) => {
  test.setTimeout(45_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  const registrationId = await register(page, session);
  const occupied = event(2);
  await rpc(page, 'display', { event: occupied, soundRequested: false });
  const finish = await mountConsole(page, true);
  const incoming = { ...event(2), eventId: 'conflicting-turn' };
  await finish(incoming);
  await expect.poll(async () => (await notices(page)).find(notice => notice.tag.startsWith('rac-v1-compat-') && notice.data.eventId === incoming.eventId)?.data.nativeFallbackAttempted, { timeout: 15_000 }).toBe(true);
  expect((await notices(page)).find(notice => notice.tag === occupied.displayTag)?.data.eventId).toBe(occupied.eventId);
  const actual = (await notices(page)).find(notice => notice.data.eventId === incoming.eventId)!;
  const repeated = await rpc(page, 'sound-fallback', { event: { ...incoming, displayTag: actual.tag } });
  expect(repeated.outcome).toBe('duplicate');
  expect(await page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds)).toEqual(['/notification-success.wav']);
  await session.detach();
});

// exercise real page chimes against the real worker rather than a fake acknowledgement
for (const order of ['page-first', 'push-first'] as const) {
  test(`application helper and push share audible ownership ${order}`, async ({ context, page }) => {
    test.setTimeout(45_000);
    await context.grantPermissions(['notifications'], { origin });
    const session = await context.newCDPSession(page);
    let registrationId: string | undefined;
    // observe the registration created by the actual application entrypoint
    session.on('ServiceWorker.workerRegistrationUpdated', update => {
      registrationId = update.registrations.find(entry => entry.scopeURL === `${origin}/` && !entry.isDeleted)?.registrationId ?? registrationId;
    });
    await session.send('ServiceWorker.enable');
    const finish = await mountConsole(page);
    await expect.poll(() => registrationId).toBeTruthy();
    const completed = event(2);
    // prove the push displayed before publishing the page transition
    if (order === 'push-first') {
      await push(session, registrationId!, completed);
      await expect.poll(async () => (await notices(page)).find(notice => notice.tag === completed.displayTag)?.data.eventId, { timeout: 15_000 }).toBe(completed.eventId);
    }
    await finish(completed);
    await expect.poll(async () => (await notices(page)).find(notice => notice.tag === completed.displayTag)?.data.eventId, { timeout: 15_000 }).toBe(completed.eventId);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds)).toEqual(order === 'page-first' ? ['/notification-success.wav'] : []);
    // wait past page grace so a late duplicate custom chime cannot escape the assertion
    await page.waitForTimeout(2_500);
    if (order === 'page-first') await push(session, registrationId!, completed);
    await expect.poll(() => notices(page)).toEqual([{ tag: completed.displayTag, data: expect.objectContaining({ eventId: completed.eventId }) }]);
    // prove the real page received its ownership decision, not merely that no sound happened yet
    await expect.poll(() => page.evaluate(eventId => {
      const records = (window as typeof window & { __coordinationOperations: Array<{ direction: string; value: { eventId?: string; outcome?: string; audibleClaim?: boolean } }> }).__coordinationOperations;
      return records.filter(record => record.direction === 'ack' && record.value.eventId === eventId).map(record => ({ outcome: record.value.outcome, audibleClaim: record.value.audibleClaim }));
    }, completed.eventId), { timeout: 15_000 }).toContainEqual({ outcome: order === 'page-first' ? 'displayed' : 'duplicate', audibleClaim: order === 'page-first' });
    const evidence = await page.evaluate(() => (window as typeof window & { __coordinationOperations: unknown[] }).__coordinationOperations);
    // repeated current snapshots must not close their still-unread exact alert
    const reconciledCurrent = evidence.filter(record => {
      const operation = record as { direction: string; value: { operation?: string; entries?: Array<{ eventId?: string }> } };
      return operation.direction === 'request' && operation.value.operation === 'reconcile' && operation.value.entries?.some(entry => entry.eventId === completed.eventId);
    });
    expect(reconciledCurrent, JSON.stringify(evidence)).toEqual([]);
    expect(await page.evaluate(() => (window as typeof window & { __coordinationSounds: string[] }).__coordinationSounds), JSON.stringify(evidence)).toEqual(order === 'page-first' ? ['/notification-success.wav'] : []);
    await session.detach();
  });
}


type JournalRecord = { id: string; stage: string; at: number };

// seed the real browser store before the authenticated page mounts
async function seedJournal(page: Page, records: JournalRecord[]) {
  await page.route('**/notification-journal-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Journal fixture</title>' }));
  await page.goto('/notification-journal-harness');
  await page.evaluate(async records => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rac-notification-diagnostics', 1);
      // create the shared page and worker store only when absent
      request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('events', 'readwrite');
      // insert deterministic content-free diagnostic fixtures
      for (const record of records) transaction.objectStore('events').put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, records);
}

// read exact persisted ids rather than inferring upload success from request counts
async function journalRecords(page: Page): Promise<JournalRecord[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rac-notification-diagnostics', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<JournalRecord[]>((resolve, reject) => {
      const request = database.transaction('events', 'readonly').objectStore('events').getAll();
      request.onsuccess = () => resolve(request.result as JournalRecord[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result;
  });
}

// bounded storage and rejected uploads must not gate a real notification display
test('browser journal prunes age and cap while rejected receipts leave alerts independent', async ({ context, page }) => {
  await context.grantPermissions(['notifications'], { origin });
  const now = Date.now();
  const records = Array.from({ length: 215 }, (_, index) => ({ id: `seed-${index}`, stage: 'reconciled', at: now - (index < 10 ? 8 * 86_400_000 : index) }));
  await seedJournal(page, records);
  const uploads: JournalRecord[][] = [];
  const finish = await mountConsole(page, false, async route => {
    uploads.push((route.request().postDataJSON() as { records: JournalRecord[] }).records);
    await route.fulfill({ status: 503 });
  });
  await expect.poll(() => uploads.length).toBeGreaterThan(0);
  await expect.poll(async () => (await journalRecords(page)).length).toBeLessThanOrEqual(200);
  const retained = await journalRecords(page);
  expect(retained.some(record => record.id === 'seed-10')).toBe(true);
  expect(retained.some(record => record.at < now - 7 * 86_400_000)).toBe(false);
  expect(uploads.every(batch => batch.length <= 100 && batch.every(record => record.at >= now - 7 * 86_400_000))).toBe(true);
  const completed = event(2);
  await finish(completed);
  await expect.poll(async () => (await notices(page)).some(notice => notice.data.eventId === completed.eventId), { timeout: 15_000 }).toBe(true);
  expect((await journalRecords(page)).some(record => record.id === 'seed-10')).toBe(true);
});

// acknowledgements delete only their submitted ids and preserve a concurrent new record
test('successful receipt flush preserves records added after its exact batch was read', async ({ page }) => {
  const seed = { id: 'accepted-seed', stage: 'reconciled', at: Date.now() };
  await seedJournal(page, [seed]);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const uploads: JournalRecord[][] = [];
  await mountConsole(page, false, async route => {
    uploads.push((route.request().postDataJSON() as { records: JournalRecord[] }).records);
    await pending;
    await route.fulfill({ status: 204 });
  });
  await expect.poll(() => uploads.length).toBeGreaterThan(0);
  expect(uploads[0]!.some(record => record.id === seed.id)).toBe(true);
  const concurrent = { id: 'concurrent-new', stage: 'reconciled', at: Date.now() };
  // use the same origin store without remounting or triggering another flush
  await page.evaluate(async record => {
    const database = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('rac-notification-diagnostics', 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>(resolve => {
      const transaction = database.transaction('events', 'readwrite');
      transaction.objectStore('events').put(record);
      transaction.oncomplete = () => resolve();
    });
    database.close();
  }, concurrent);
  release();
  await expect.poll(async () => (await journalRecords(page)).some(record => record.id === seed.id)).toBe(false);
  expect((await journalRecords(page)).some(record => record.id === concurrent.id)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect.poll(() => uploads.some(batch => batch.some(record => record.id === concurrent.id))).toBe(true);
  await expect.poll(async () => (await journalRecords(page)).some(record => record.id === concurrent.id)).toBe(false);
});
