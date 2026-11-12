import { expect, test, type Page } from '@playwright/test';

// capture browser notifications without requesting permission
async function captureNotifications(page: Page, initial: { permission?: NotificationPermission; display?: 'success' | 'reject' | 'stall' } = {}) {
  await page.addInitScript(({ initialPermission, initialDisplay }) => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    let permission = initialPermission;
    let display = initialDisplay;
    let attempts = 0;
    Object.defineProperty(window, '__testNotifications', { configurable: true, value: notifications });
    Object.defineProperty(window, '__testNotificationFixture', { configurable: true, value: {
      // update permission without reloading the page
      setPermission: (next: NotificationPermission) => { permission = next; },
      // recover a rejected or stalled display path
      setDisplay: (next: 'success' | 'reject' | 'stall') => { display = next; },
      // expose exact display attempts for pending coalescing
      attempts: () => attempts
    } });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return permission; } } });
    const registration = {
      active: null,
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => {
        attempts += 1;
        // retain a pending display until the page-side bound expires
        if (display === 'stall') return await new Promise<void>(() => { /* remain unresolved */ });
        // reject without recording a browser display
        if (display === 'reject') throw new Error('display rejected');
        notifications.push({ title, options });
      }
    };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; getRegistration: () => Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.getRegistration = async () => registration;
    serviceWorkers.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
  }, { initialPermission: initial.permission ?? 'granted', initialDisplay: initial.display ?? 'success' });
}

// serve the minimum authenticated console shell
async function serveConsole(page: Page, updates: unknown[], serverUpdate: { available: boolean; commitCount: number; targetSha?: string }) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render settings on an empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'both', turnCapture: true, inlineQuestions: true, commands: true, sandbox: false } }, agents: [], projects: [] } });
    // expose configured agent versions
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: updates } });
    // expose the upstream commit count
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: serverUpdate });
    // disable subscription writes
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('announces agent updates and opens the launcher from the notification route', async ({ page }) => {
  // allow all cold reloads while preserving exact once-only announcement checks
  test.setTimeout(60_000);
  await captureNotifications(page);
  const updates: Array<{ kind: string; currentVersion: string; latestVersion: string; updateAvailable: boolean }> = [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }];
  await serveConsole(page, updates, { available: false, commitCount: 0 });

  await page.goto('/');

  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts()), { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications), { timeout: 15_000 }).toEqual([
    expect.objectContaining({ title: 'Codex update available', options: expect.objectContaining({ body: '0.152.1 -> 0.153.2', tag: 'agent-update-codex', data: expect.objectContaining({ url: '/#launch' }) }) })
  ]);
  await page.evaluate(() => { location.hash = '#launch'; });
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toBeVisible();
  // dismissing the launcher consumes only its notification destination
  await page.locator('.flyout-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  // settle the unchanged target before mutating the next response
  const unchangedAgents = page.waitForResponse('**/api/agents/updates');
  await page.reload();
  await (await unchangedAgents).finished();
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  // announce one different target after the cold reload
  updates.splice(0, updates.length, { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.154.0', updateAvailable: true });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('0.152.1 -> 0.154.0');
  // clear the durable fingerprint when the update resolves
  updates.splice(0, updates.length, { kind: 'codex', currentVersion: '0.154.0', latestVersion: '0.154.0', updateAvailable: false });
  await page.reload();
  // wait for the resolved response to clear storage before changing the fixture again
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { agents?: Record<string, string> }).agents?.codex)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  updates.splice(0, updates.length, { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.154.0', updateAvailable: true });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ title: string }> }).__testNotifications.map(notification => notification.title))).toEqual(['Codex update available']);
});

test('announces upstream Remote Agent Console commits', async ({ page }) => {
  await captureNotifications(page);
  const update = { available: true, commitCount: 3, targetSha: '3'.repeat(40) };
  await serveConsole(page, [], update);

  await page.goto('/');

  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts()), { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications), { timeout: 15_000 }).toEqual([
    expect.objectContaining({ title: 'Remote Agent Console update available', options: expect.objectContaining({ body: '3 commits upstream', tag: 'rac-update', data: expect.objectContaining({ url: '/#server-update' }) }) })
  ]);
  // settle the unchanged target before mutating the next response
  const unchangedServer = page.waitForResponse('**/api/server/update-available');
  await page.reload();
  await (await unchangedServer).finished();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  // announce a new target sha exactly once
  update.commitCount = 4;
  update.targetSha = '4'.repeat(40);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('4 commits upstream');
  // a corrupt oversized record cannot hide a later update
  await page.evaluate(() => localStorage.setItem('rac.notification-update-fingerprints.v1', 'x'.repeat(5_000)));
  update.commitCount = 5;
  update.targetSha = '5'.repeat(40);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('5 commits upstream');
});

test('commits an agent fingerprint only after the unchanged target displays', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await captureNotifications(page, { permission: 'default' });
  const updates = [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }];
  await serveConsole(page, updates, { available: false, commitCount: 0 });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('rac.notification-update-fingerprints.v1'))).toBeNull();
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setPermission: (permission: NotificationPermission) => void } }).__testNotificationFixture.setPermission('granted'));
  await page.clock.fastForward(15 * 60_000);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { agents?: Record<string, string> }).agents?.codex)).toBe('0.152.1->0.153.2');
  // retain one display across later unchanged polls
  await page.clock.fastForward(15 * 60_000);
  expect(await page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(1);
});

test('retries an agent fingerprint after rejected and stalled displays', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await captureNotifications(page, { display: 'reject' });
  const updates = [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }];
  await serveConsole(page, updates, { available: false, commitCount: 0 });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('rac.notification-update-fingerprints.v1'))).toBeNull();
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setDisplay: (display: 'stall') => void } }).__testNotificationFixture.setDisplay('stall'));
  await page.clock.fastForward(15 * 60_000);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(2);
  await page.clock.fastForward(5_000);
  expect(await page.evaluate(() => localStorage.getItem('rac.notification-update-fingerprints.v1'))).toBeNull();
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setDisplay: (display: 'success') => void } }).__testNotificationFixture.setDisplay('success'));
  await page.clock.fastForward(15 * 60_000);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { agents?: Record<string, string> }).agents?.codex)).toBe('0.152.1->0.153.2');
});

test('commits a rac fingerprint only after permission and display recover', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') });
  await captureNotifications(page, { permission: 'denied' });
  const update = { available: true, commitCount: 2, targetSha: '2'.repeat(40) };
  await serveConsole(page, [], update);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('rac.notification-update-fingerprints.v1'))).toBeNull();
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setPermission: (permission: NotificationPermission) => void; setDisplay: (display: 'reject') => void } }).__testNotificationFixture.setPermission('granted'));
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setDisplay: (display: 'reject') => void } }).__testNotificationFixture.setDisplay('reject'));
  await page.clock.fastForward(5 * 60_000);
  expect(await page.evaluate(() => localStorage.getItem('rac.notification-update-fingerprints.v1'))).toBeNull();
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setDisplay: (display: 'success') => void } }).__testNotificationFixture.setDisplay('success'));
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(update.targetSha);
});
