import { expect, test, type CDPSession, type Page } from '@playwright/test';

const origin = process.env.RAC_PUSH_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
const harnessPath = '/push-worker-harness';

// use full chromium so headless notification permissions remain available
test.use({ channel: 'chromium' });

type WorkerNotification = {
  title: string;
  body: string;
  tag: string;
  timestamp: number;
  requireInteraction: boolean;
  silent: boolean | null;
  data: Record<string, unknown>;
};

// create one strict provider payload
function strictEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-a',
    eventEpoch: '11111111-1111-4111-8111-111111111111',
    eventSequence: 1,
    entityId: 'agent:agent-a',
    generatedAt: Date.now() - 60_000,
    kind: 'question',
    agentId: 'agent-a',
    tag: 'agent-status-agent-a',
    displayTag: 'rac-v1-agent-status-agent-a',
    url: '/#agent=agent-a',
    worktreeId: 'shared-worktree',
    title: 'Question in Remote Agents',
    body: 'Choose a deployment target?',
    ...overrides
  };
}

// register the shipped worker and return its chromium registration id
async function registerPushWorker(page: Page, session: CDPSession) {
  let registrationId: string | undefined;
  // retain the matching registration from chromium updates
  session.on('ServiceWorker.workerRegistrationUpdated', event => {
    registrationId = event.registrations.find(registration => registration.scopeURL === `${origin}/` && !registration.isDeleted)?.registrationId ?? registrationId;
  });
  await session.send('ServiceWorker.enable');
  // keep the harness independent from the application backend
  await page.route(`**${harnessPath}`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>push worker harness</title>' }));
  await page.goto(`${origin}${harnessPath}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrationId).toBeTruthy();
  return registrationId!;
}

// deliver one synthetic push through chromium's worker pipeline
async function deliverPush(session: CDPSession, registrationId: string, payload: object, page?: Page) {
  await session.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(payload) });
  // fence later pushes behind this worker queue position
  if (page !== undefined) await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    // reject a missing active worker explicitly
    if (registration?.active === null || registration?.active === undefined) throw new Error('active service worker unavailable');
    const requestId = `push-fence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const acknowledgement = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error('worker queue fence timed out'));
      }, 15_000);
      channel.port1.onmessage = event => {
        window.clearTimeout(timer);
        channel.port1.close();
        resolve(event.data as Record<string, unknown>);
      };
      registration.active!.postMessage({ protocolVersion: 1, requestId, operation: 'inventory' }, [channel.port2]);
    });
    // require one correlated inventory response
    if (acknowledgement.requestId !== requestId || acknowledgement.outcome !== 'listed') throw new Error('worker queue fence rejected');
  });
}

// inspect notifications retained by the real browser registration
async function readNotifications(page: Page): Promise<WorkerNotification[]> {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    // reject a broken harness explicitly
    if (registration === undefined) throw new Error('service worker registration unavailable');
    const notifications = await registration.getNotifications();
    return notifications.map(notification => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      timestamp: (notification as Notification & { timestamp?: number }).timestamp,
      requireInteraction: notification.requireInteraction,
      silent: notification.silent,
      data: notification.data as Record<string, unknown>
    }));
  });
}

// exercise closed-window delivery and strict freshness in chromium
test('retains strict current and compatibility notifications while the app is closed', async ({ context, page }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  const registrationId = await registerPushWorker(page, session);
  const eventA = strictEvent();

  await page.goto('about:blank');
  expect(context.pages().filter(candidate => candidate.url().startsWith(origin))).toHaveLength(0);
  await deliverPush(session, registrationId, eventA);

  await page.goto(`${origin}${harnessPath}`);
  await expect.poll(async () => await readNotifications(page)).toEqual([expect.objectContaining({
    title: eventA.title,
    body: eventA.body,
    tag: eventA.displayTag,
    timestamp: eventA.generatedAt,
    requireInteraction: true,
    data: expect.objectContaining({
      eventId: eventA.eventId,
      eventEpoch: eventA.eventEpoch,
      eventSequence: eventA.eventSequence,
      tag: eventA.tag,
      logicalTag: eventA.tag,
      displayTag: eventA.displayTag,
      url: '/#worktree=shared-worktree'
    })
  })]);

  await deliverPush(session, registrationId, eventA, page);
  await expect.poll(async () => (await readNotifications(page)).filter(notification => notification.tag === eventA.displayTag)).toHaveLength(1);

  const sibling = strictEvent({
    eventId: 'event-sibling',
    entityId: 'agent:agent-sibling',
    agentId: 'agent-sibling',
    tag: 'agent-status-agent-sibling',
    displayTag: 'rac-v1-agent-status-agent-sibling',
    url: '/#agent=agent-sibling',
    title: 'Sibling question',
    body: 'Sibling needs input'
  });
  await deliverPush(session, registrationId, sibling, page);
  await expect.poll(async () => (await readNotifications(page)).filter(notification => notification.tag.startsWith('rac-v1-agent-status-'))).toHaveLength(2);

  const eventB = strictEvent({ eventId: 'event-b', eventSequence: 2, kind: 'finished', title: 'Done working', body: 'Ready for a new prompt' });
  await deliverPush(session, registrationId, eventB, page);
  await expect.poll(async () => (await readNotifications(page)).find(notification => notification.tag === eventA.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b', eventSequence: 2 }));

  await deliverPush(session, registrationId, eventA, page);
  await expect.poll(async () => (await readNotifications(page)).filter(notification => notification.tag.startsWith('rac-v1-compat-'))).toHaveLength(1);
  const afterDelayed = await readNotifications(page);
  expect(afterDelayed.find(notification => notification.tag === eventA.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b', eventSequence: 2 }));
  expect(afterDelayed.find(notification => notification.tag.startsWith('rac-v1-compat-'))).toEqual(expect.objectContaining({
    silent: true,
    data: expect.objectContaining({ eventId: 'event-a', eventSequence: 1 })
  }));

  await deliverPush(session, registrationId, strictEvent({ eventId: 'event-conflict', eventSequence: 2, title: 'Conflicting event' }), page);
  await deliverPush(session, registrationId, strictEvent({ eventId: 'event-new-epoch', eventEpoch: '22222222-2222-4222-8222-222222222222', title: 'New epoch event' }), page);
  await expect.poll(async () => (await readNotifications(page)).filter(notification => notification.tag.startsWith('rac-v1-compat-'))).toHaveLength(3);

  await deliverPush(session, registrationId, { title: 'Legacy alert', body: 'Still visible', tag: 'rac-update', kind: 'system', url: '/#server-update' }, page);
  await expect.poll(async () => (await readNotifications(page)).some(notification => notification.tag === 'rac-update')).toBe(true);
  expect((await readNotifications(page)).find(notification => notification.tag === eventA.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));

  // retain distinct incomplete future alerts without replacing strict current
  await deliverPush(session, registrationId, { schemaVersion: 2, title: 'Future alert one', body: 'First identityless alert', tag: eventA.displayTag }, page);
  await deliverPush(session, registrationId, { schemaVersion: 2, title: 'Future alert two', body: 'Second identityless alert', tag: eventA.displayTag }, page);
  await expect.poll(async () => (await readNotifications(page)).filter(notification => notification.title.startsWith('Future alert'))).toEqual([
    expect.objectContaining({ title: 'Future alert one', tag: '', silent: true }),
    expect.objectContaining({ title: 'Future alert two', tag: '', silent: true })
  ]);
  expect((await readNotifications(page)).find(notification => notification.tag === eventA.displayTag)?.data).toEqual(expect.objectContaining({ eventId: 'event-b' }));
  await session.detach();
});
