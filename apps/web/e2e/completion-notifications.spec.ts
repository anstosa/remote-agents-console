import { expect, test } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

test('suppresses an intermediate completion when the next queued prompt starts', async ({ page }) => {
  test.setTimeout(45_000);
  let dashboardRequests = 0;
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
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      const working = dashboardRequests === 1 || dashboardRequests === 3 || dashboardRequests === 4;
      const queuedPromptCount = dashboardRequests === 2 ? 1 : 0;
      return route.fulfill({
        json: {
          agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', title: working ? '⠋ Working' : 'Ready', attention: working ? 'working' : 'finished', worktreeLabel: 'Cora', queuedPromptCount }],
          projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }] }]
        }
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => dashboardRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: unknown[] }
  ).__testNotifications.length)).toBe(0);
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
    const question = questionKind === 'structured' ? { id: 'question-1', text: 'Choose a deployment target?', choices: ['Staging', 'Production'], paneId: '%1' } : undefined;
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
