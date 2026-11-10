import { expect, test } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

test('suppresses an intermediate completion when the next queued prompt starts', async ({ page }) => {
  test.setTimeout(45_000);
  await installDashboardSocket(page);
  const project = { id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }] };
  const working = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: '⠋ Working', attention: 'working', worktreeLabel: 'Cora', queuedPromptCount: 0 };
  let dashboard = { generation: 1, agents: [working], projects: [project] };
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    class TestNotification {
      static permission: NotificationPermission = 'granted';
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => {
        notifications.push({ title, options });
      }
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  const queuedCompletion = { ...working, title: 'Ready', attention: 'finished', queuedPromptCount: 1 };
  await emitDashboard(page, { generation: 2, agents: [queuedCompletion], projects: [project] });
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
  await emitDashboard(page, { generation: 3, agents: [working], projects: [project] });
  await expect(page.getByRole('tab', { name: 'Cora — Working' })).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: unknown[] }
  ).__testNotifications.length)).toBe(0);
  dashboard = { generation: 4, agents: [{ ...queuedCompletion, queuedPromptCount: 0 }], projects: [project] };
  await emitDashboard(page, dashboard);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string }> }
  ).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Done working in Remote Agents']);
});

// a muted browser still notifies, without the chime or a native sound
for (const muted of [false, true]) test(`notifies when the visible focused agent finishes${muted ? ' with sounds off' : ''}`, async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  let dismissals = 0;
  await page.addInitScript(muted => {
    if (muted) localStorage.setItem('rac.notification-sounds', 'disabled');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    const sounds: string[] = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    Object.defineProperty(window, '__testSounds', { value: sounds });
    class TestNotification {
      static permission: NotificationPermission = 'granted';
    }
    class TestAudio {
      volume = 1;
      // retain each requested asset
      constructor(source: string) { sounds.push(source); }
      // allow deterministic playback
      async play() { return undefined; }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    Object.defineProperty(window, 'Audio', { configurable: true, value: TestAudio });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => {
        notifications.push({ title, options });
      }
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  }, muted);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({
        json: {
          agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: dashboardRequests === 1 ? '⠋ Working' : 'Ready', attention: dashboardRequests === 1 ? 'working' : 'finished', worktreeLabel: 'Cora' }],
          projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }] }]
        }
      });
    }
    if (url.pathname === '/api/agents/agent-1/notifications/dismiss') {
      dismissals += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string }> }
  ).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Done working in Remote Agents']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('Cora is ready for a new prompt');
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testSounds: string[] }).__testSounds)).toEqual(muted ? [] : ['/notification-success.wav']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.silent)).toBe(true);
  expect(dismissals).toBe(0);
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect.poll(() => dismissals).toBe(1);
});

// native dialogs and ordinary message questions share notification behavior
for (const questionKind of ['structured', 'message'] as const) {
  // keep prose questions in the normal composer while surfacing their warning
  test(`uses a warning chime for a ${questionKind} question`, async ({ page }) => {
    test.setTimeout(30_000);
    await installDashboardSocket(page);
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
      const sounds: string[] = [];
      const closed: string[] = [];
      Object.defineProperty(window, '__testNotifications', { value: notifications });
      Object.defineProperty(window, '__testSounds', { value: sounds });
      Object.defineProperty(window, '__testClosed', { value: closed });
      class TestNotification { static permission: NotificationPermission = 'granted'; }
      class TestAudio {
        volume = 1;
        // retain each requested asset
        constructor(source: string) { sounds.push(source); }
        // allow deterministic playback
        async play() { return undefined; }
      }
      Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
      Object.defineProperty(window, 'Audio', { configurable: true, value: TestAudio });
      const registration = {
        getNotifications: async ({ tag }: { tag?: string } = {}) => [{ close: () => {
          // retain tagged closures
          if (tag) closed.push(tag);
        } }],
        showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); }
      };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      // restore one authenticated client
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
      if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
      // establish the pre-question working state
      if (url.pathname === '/api/dashboard') {
        return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: '⠋ Working', attention: 'working', worktreeLabel: 'Cora' }], projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }, { id: 'dave', projectId: 'remote-agents', label: 'Dave', path: '/worktrees/dave', main: false, detached: false, locked: false, available: true, pinned: true, order: 1 }] }] } });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await page.goto('/');
    await expect.poll(() => dashboardSocketReady(page)).toBe(true);
    const question = questionKind === 'structured' ? { id: 'question-1', text: 'Choose a deployment target?', field: { kind: 'choice', choices: ['Staging', 'Production'] }, pane: { targetPaneId: '%1' } } : undefined;
    await emitDashboard(page, { generation: 2, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: question === undefined ? 'Ready' : 'Action required', attention: question === undefined ? 'finished' : 'question', hasMessageQuestion: questionKind === 'message' ? true : undefined, worktreeLabel: 'Cora', question }], projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }, { id: 'dave', projectId: 'remote-agents', label: 'Dave', path: '/worktrees/dave', main: false, detached: false, locked: false, available: true, pinned: true, order: 1 }] }] });

    await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ title: string }> }).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Question in Remote Agents']);
    await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe(questionKind === 'message' ? 'Cora: has a question' : 'Cora: Choose a deployment target?');
    await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testSounds: string[] }).__testSounds)).toEqual(['/notification-warning.wav']);
    await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.silent)).toBe(true);

    // a cleared prose question dismisses its notification even without another working turn
    if (questionKind === 'message') {
      const closedBefore = await page.evaluate(() => (window as unknown as { __testClosed: string[] }).__testClosed.length);
      await emitDashboard(page, { generation: 3, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: 'Ready', attention: 'finished', worktreeLabel: 'Cora' }], projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }, { id: 'dave', projectId: 'remote-agents', label: 'Dave', path: '/worktrees/dave', main: false, detached: false, locked: false, available: true, pinned: true, order: 1 }] }] });
      await expect.poll(() => page.evaluate(offset => (window as unknown as { __testClosed: string[] }).__testClosed.slice(offset), closedBefore)).toContain('worktree-status-cora');
    }
  });
}

test('requests one exact worker native fallback after strict custom playback rejects', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  const event = { schemaVersion: 1 as const, eventId: 'completion-agent-1-2', eventEpoch: '00000000-0000-4000-8000-000000000001', eventSequence: 2, entityId: 'agent:agent-1', generatedAt: Date.now(), kind: 'finished' as const, agentId: 'agent-1', tag: 'agent-status-agent-1', displayTag: 'rac-v1-agent-status-agent-1', url: '/#agent=agent-1', worktreeId: 'cora' };
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const operations: Array<{ operation: string; event?: { eventId?: string } }> = [];
    const directDisplays: string[] = [];
    Object.defineProperty(window, '__workerOperations', { configurable: true, value: operations });
    Object.defineProperty(window, '__directDisplays', { configurable: true, value: directDisplays });
    class NotificationFixture { static permission: NotificationPermission = 'granted'; }
    class AudioFixture {
      volume = 1;
      // retain no content while forcing native fallback
      async play() { throw new Error('autoplay rejected'); }
    }
    const active = {
      // acknowledge each exact page operation through its transferred port
      postMessage: (message: { requestId: string; operation: string; soundRequested?: boolean; event?: { displayTag?: string; eventId?: string; eventEpoch?: string; eventSequence?: number }; snapshotToken?: string }, ports: MessagePort[]) => {
        operations.push({ operation: message.operation, event: message.event });
        const exact = message.event === undefined ? {} : {
          displayTag: message.event.displayTag,
          eventId: message.event.eventId,
          eventEpoch: message.event.eventEpoch,
          eventSequence: message.event.eventSequence
        };
        // return one empty worker inventory
        if (message.operation === 'inventory') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'listed', audibleClaim: false, entries: [] });
          return;
        }
        // preserve reconciliation correlation
        if (message.operation === 'reconcile') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'closed', audibleClaim: false, snapshotToken: message.snapshotToken });
          return;
        }
        const outcome = message.operation === 'close' ? 'closed' : 'displayed';
        ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome, audibleClaim: message.operation === 'display' && message.soundRequested === true, ...exact });
      }
    };
    const registration = { active, getNotifications: async () => [], showNotification: async (title: string) => { directDisplays.push(title); } };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.register = async () => registration;
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationFixture });
    Object.defineProperty(window, 'Audio', { configurable: true, value: AudioFixture });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // restore one authenticated fixture
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    if (path === '/api/dashboard') {
      dashboardRequests += 1;
      const finished = dashboardRequests > 1;
      return route.fulfill({ json: { generation: dashboardRequests, serverStartedAt: 100, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: finished ? 'Ready' : 'Working', attention: finished ? 'finished' : 'working', unread: finished, completionId: finished ? event.eventId : undefined, notificationEvent: finished ? event : undefined, notificationState: { eventEpoch: event.eventEpoch, eventSequence: finished ? 2 : 1 }, queuedPromptCount: 0 }], projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }] }] } });
    }
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  // allow the fallback polling cadence before asserting event delivery
  await expect.poll(() => dashboardRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  // reconciliation is independent of the exact display and sound claim
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __workerOperations: Array<{ operation: string; event?: { eventId?: string } }> }).__workerOperations.filter(operation => operation.operation === 'display' || operation.operation === 'sound-fallback').map(operation => [operation.operation, operation.event?.eventId])), { timeout: 15_000 }).toEqual([['display', event.eventId], ['sound-fallback', event.eventId]]);
  expect(await page.evaluate(() => (window as typeof window & { __directDisplays: string[] }).__directDisplays)).toEqual([]);
});

for (const fallbackMode of ['never-ready', 'show-rejected'] as const) test(`uses an event-specific fail-open when service-worker ${fallbackMode}`, async ({ page }) => {
  test.setTimeout(30_000);
  await installDashboardSocket(page);
  const event = { schemaVersion: 1 as const, eventId: 'completion-agent-1-2', eventEpoch: '00000000-0000-4000-8000-000000000001', eventSequence: 2, entityId: 'agent:agent-1', generatedAt: Date.now(), kind: 'finished' as const, agentId: 'agent-1', tag: 'agent-status-agent-1', displayTag: 'rac-v1-agent-status-agent-1', url: '/#agent=agent-1' };
  let dashboard: Record<string, unknown> = { generation: 1, serverStartedAt: 100, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Working', attention: 'working', notificationState: { eventEpoch: event.eventEpoch, eventSequence: 1 }, queuedPromptCount: 0 }], projects: [] };
  await page.addInitScript(fallbackMode => {
    const displays: Array<{ title: string; options?: NotificationOptions }> = [];
    const customSounds: string[] = [];
    Object.defineProperty(window, '__boundedDisplays', { configurable: true, value: displays });
    Object.defineProperty(window, '__boundedSounds', { configurable: true, value: customSounds });
    class NotificationFixture {
      static permission: NotificationPermission = 'granted';
      // capture the window-level native fail-open
      constructor(title: string, options?: NotificationOptions) { displays.push({ title, options }); }
    }
    class AudioFixture {
      // custom playback must not claim an unavailable-worker event
      constructor(source: string) { customSounds.push(source); }
      async play() { return undefined; }
    }
    const registration = { active: null, showNotification: async () => { throw new Error('show rejected'); } } as unknown as ServiceWorkerRegistration;
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<ServiceWorkerRegistration>; register: () => Promise<object>; getRegistration?: () => Promise<ServiceWorkerRegistration> };
    serviceWorkers.ready = fallbackMode === 'never-ready' ? new Promise(() => { /* deliberately never ready */ }) : Promise.resolve(registration);
    // expose a registration whose display rejects in the second branch
    if (fallbackMode === 'show-rejected') serviceWorkers.getRegistration = async () => registration;
    serviceWorkers.register = async () => ({});
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationFixture });
    Object.defineProperty(window, 'Audio', { configurable: true, value: AudioFixture });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
  }, fallbackMode);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish one strict completion after a working baseline
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  // establish the delayed http baseline before the websocket completion
  if (fallbackMode === 'never-ready') await expect(page.getByRole('tab', { name: / — Working$/u })).toBeVisible({ timeout: 15_000 });
  dashboard = { generation: 2, serverStartedAt: 100, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', unread: true, completionId: event.eventId, notificationEvent: event, notificationState: { eventEpoch: event.eventEpoch, eventSequence: 2 }, queuedPromptCount: 0 }], projects: [] };
  await emitDashboard(page, dashboard);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __boundedDisplays: Array<{ options?: NotificationOptions }> }).__boundedDisplays), { timeout: 15_000 }).toEqual([expect.objectContaining({ options: expect.objectContaining({ tag: expect.stringMatching(/^rac-v1-failopen-/u), silent: false, data: expect.objectContaining({ eventId: event.eventId }) }) })]);
  expect(await page.evaluate(() => (window as typeof window & { __boundedSounds: string[] }).__boundedSounds)).toEqual([]);
});
