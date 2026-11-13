import { expect, test, type Page } from '@playwright/test';

// capture browser notifications without requesting permission
async function captureNotifications(page: Page, initial: { permission?: NotificationPermission; display?: 'success' | 'reject' | 'stall'; holdDisplay?: boolean } = {}) {
  await page.addInitScript(({ initialPermission, initialDisplay, initialHoldDisplay }) => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    let permission = initialPermission;
    let display = initialDisplay;
    let attempts = 0;
    let nextRegistrationGate: { started: () => void; released: Promise<void> } | undefined;
    let registrationLookupsInFlight = 0;
    let registrationGateStarts = 0;
    let releaseRegistration: (() => void) | undefined;
    let nextDisplayGate: { started: () => void; released: Promise<void> } | undefined;
    let displayGateStarts = 0;
    let releaseDisplay: (() => void) | undefined;
    let nextDisplayResult: 'success' | 'reject' | 'stall' | undefined;
    const notificationLookupGates: Array<{ released: Promise<void>; release: () => void }> = [];
    const nextNotificationLookupGates: Array<{ released: Promise<void>; release: () => void }> = [];
    let notificationLookupStarts = 0;
    const activeNotifications: Array<{ title: string; options?: NotificationOptions; data?: unknown; close: () => void }> = [];
    // hold the first display only when the scenario needs an initial gate
    if (initialHoldDisplay) {
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      nextDisplayGate = { started: () => { displayGateStarts += 1; }, released };
      releaseDisplay = release;
    }
    Object.defineProperty(window, '__testNotifications', { configurable: true, value: notifications });
    Object.defineProperty(window, '__testNotificationFixture', { configurable: true, value: {
      // update permission without reloading the page
      setPermission: (next: NotificationPermission) => { permission = next; },
      // recover a rejected or stalled display path
      setDisplay: (next: 'success' | 'reject' | 'stall') => { display = next; },
      // control the result of one later display without changing a pending display
      setNextDisplayResult: (next: 'success' | 'reject' | 'stall') => { nextDisplayResult = next; },
      // hold the next registration lookup without affecting earlier enrollment
      holdNextRegistration: () => {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        nextRegistrationGate = { started: () => { registrationGateStarts += 1; }, released };
        releaseRegistration = release;
      },
      // release the exact held registration lookup
      releaseHeldRegistration: () => { releaseRegistration?.(); releaseRegistration = undefined; },
      // expose registration gate handoffs for stale-owner assertions
      registrationLookupsInFlight: () => registrationLookupsInFlight,
      registrationGateStarts: () => registrationGateStarts,
      // release the exact held notification display
      releaseHeldDisplay: () => { releaseDisplay?.(); releaseDisplay = undefined; },
      // expose display gate handoffs and active same-tag notifications
      displayGateStarts: () => displayGateStarts,
      activeNotificationDetails: () => activeNotifications.map(notification => ({ title: notification.title, body: notification.options?.body, tag: notification.options?.tag, ownerId: (notification.options?.data as { ownerId?: unknown } | undefined)?.ownerId })),
      // hold and release registration notification enumeration independently
      holdNextNotificationLookup: () => {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const gate = { released, release };
        notificationLookupGates.push(gate);
        nextNotificationLookupGates.push(gate);
        return notificationLookupGates.length - 1;
      },
      releaseNotificationLookup: (index: number) => { notificationLookupGates[index]?.release(); },
      notificationLookupStarts: () => notificationLookupStarts,
      // expose exact display attempts for pending coalescing
      attempts: () => attempts
    } });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return permission; } } });
    const registration = {
      active: null,
      getNotifications: async (filter?: { tag?: string }) => {
        const gate = nextNotificationLookupGates.shift();
        // delay one enumeration so ownership can change before the result is used
        if (gate !== undefined) {
          notificationLookupStarts += 1;
          await gate.released;
        }
        return filter?.tag === undefined ? activeNotifications : activeNotifications.filter(notification => notification.options?.tag === filter.tag);
      },
      showNotification: async (title: string, options?: NotificationOptions) => {
        attempts += 1;
        const displayResult = nextDisplayResult ?? display;
        nextDisplayResult = undefined;
        const displayGate = nextDisplayGate;
        nextDisplayGate = undefined;
        // defer one browser display while allowing newer notifications through
        if (displayGate !== undefined) {
          displayGate.started();
          await displayGate.released;
        }
        // retain a pending display until the page-side bound expires
        if (displayResult === 'stall') return await new Promise<void>(() => { /* remain unresolved */ });
        // reject without recording a browser display
        if (displayResult === 'reject') throw new Error('display rejected');
        let notification!: { title: string; options?: NotificationOptions; data?: unknown; close: () => void };
        // expose native notification metadata for exact-owner dismissal
        notification = { title, options, data: options?.data, close: () => {
          const index = activeNotifications.indexOf(notification);
          // remove only this active notification
          if (index >= 0) activeNotifications.splice(index, 1);
        } };
        // replace only an active notification with the same tag
        for (const current of [...activeNotifications].filter(candidate => candidate.options?.tag === options?.tag)) current.close();
        activeNotifications.push(notification);
        notifications.push({ title, options });
      }
    };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; getRegistration: () => Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.getRegistration = async () => {
      registrationLookupsInFlight += 1;
      const gate = nextRegistrationGate;
      nextRegistrationGate = undefined;
      // defer exactly one registration to exercise ownership rechecks
      try {
        if (gate !== undefined) {
          gate.started();
          await gate.released;
        }
        return registration;
      } finally {
        // release the pending count even when a gated lookup fails
        registrationLookupsInFlight -= 1;
      }
    };
    serviceWorkers.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
  }, { initialPermission: initial.permission ?? 'granted', initialDisplay: initial.display ?? 'success', initialHoldDisplay: initial.holdDisplay ?? false });
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

// refresh availability through a new polling owner without waiting for its interval
async function installAvailabilityRefresh(page: Page) {
  let abortNextRevision = false;
  // keep unrelated revision requests on their existing fixture path
  await page.route('**/api/server/revision', async route => {
    // fail one foreground request to replace the availability polling effect
    if (abortNextRevision) {
      abortNextRevision = false;
      return route.abort();
    }
    return route.fallback();
  });
  // wait for the replacement owner's authoritative availability response
  return async () => {
    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === '/api/server/update-available');
    abortNextRevision = true;
    await page.getByRole('button', { name: /^Switch server/u }).click();
    await (await response).finished();
  };
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

// prevent a superseded availability owner from displaying a stale notification
test('suppresses an upstream notification when availability ownership changes during registration', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { permission: 'default' });
  const update = { available: false, commitCount: 0, targetSha: '6'.repeat(40) };
  await serveConsole(page, [], update);
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/^Switch server \(Remote Agents\)$/u);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { registrationLookupsInFlight: () => number } }).__testNotificationFixture.registrationLookupsInFlight())).toBe(0);
  await page.evaluate(() => {
    const fixture = (window as typeof window & { __testNotificationFixture: { setPermission: (permission: NotificationPermission) => void; holdNextRegistration: () => void } }).__testNotificationFixture;
    fixture.setPermission('granted');
    fixture.holdNextRegistration();
  });

  update.available = true;
  update.commitCount = 3;
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { registrationGateStarts: () => number } }).__testNotificationFixture.registrationGateStarts())).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(0);

  update.available = false;
  update.commitCount = 0;
  await page.keyboard.press('Escape');
  await refreshAvailability();
  await expect(selector).toHaveAccessibleName(/^Switch server \(Remote Agents\)$/u);

  // release the exact RAC registration before its timeout after the newer owner clears availability
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldRegistration: () => void } }).__testNotificationFixture.releaseHeldRegistration());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: unknown[] }).__testNotifications.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBeUndefined();
});

// retain a newer same-tag alert when an older browser display finishes late
test('restores the current upstream notification after a stale same-tag display', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { holdDisplay: true });
  const update = { available: true, commitCount: 3, targetSha: '6'.repeat(40) };
  await serveConsole(page, [], update);
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available/u);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { displayGateStarts: () => number } }).__testNotificationFixture.displayGateStarts())).toBe(1);

  update.commitCount = 4;
  update.targetSha = '7'.repeat(40);
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('4 commits upstream');
  const latestOwner = await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails()[0]?.ownerId);
  expect(typeof latestOwner).toBe('string');

  // gate both stale-owner enumerations until the latest alert is restored
  const lookupIndexes = await page.evaluate(() => {
    const fixture = (window as typeof window & { __testNotificationFixture: { holdNextNotificationLookup: () => number } }).__testNotificationFixture;
    return [fixture.holdNextNotificationLookup(), fixture.holdNextNotificationLookup()];
  });
  // let the superseded display replace the newer tag and trigger exact-owner recovery
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldDisplay: () => void } }).__testNotificationFixture.releaseHeldDisplay());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { notificationLookupStarts: () => number } }).__testNotificationFixture.notificationLookupStarts())).toBe(1);
  await page.evaluate(index => (window as typeof window & { __testNotificationFixture: { releaseNotificationLookup: (index: number) => void } }).__testNotificationFixture.releaseNotificationLookup(index), lookupIndexes[0]);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBeGreaterThan(2);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { notificationLookupStarts: () => number } }).__testNotificationFixture.notificationLookupStarts())).toBe(2);
  await page.evaluate(index => (window as typeof window & { __testNotificationFixture: { releaseNotificationLookup: (index: number) => void } }).__testNotificationFixture.releaseNotificationLookup(index), lookupIndexes[1]);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails().map(notification => notification.ownerId))).toEqual([latestOwner]);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(update.targetSha);
});

// keep a newer alert when an older availability clear finishes late
test('does not clear a newer upstream notification after stale availability resolves', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page);
  const update = { available: true, commitCount: 3, targetSha: '6'.repeat(40) };
  await serveConsole(page, [], update);
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available/u);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails().length)).toBe(1);

  update.available = false;
  update.commitCount = 0;
  const lookupIndex = await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { holdNextNotificationLookup: () => number } }).__testNotificationFixture.holdNextNotificationLookup());
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { notificationLookupStarts: () => number } }).__testNotificationFixture.notificationLookupStarts())).toBe(1);

  update.available = true;
  update.commitCount = 4;
  update.targetSha = '7'.repeat(40);
  await page.keyboard.press('Escape');
  await refreshAvailability();
  const currentOwner = await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails()[0]?.ownerId);
  expect(typeof currentOwner).toBe('string');

  // resume the old clear only after the newer availability owner has displayed
  await page.evaluate(index => (window as typeof window & { __testNotificationFixture: { releaseNotificationLookup: (index: number) => void } }).__testNotificationFixture.releaseNotificationLookup(index), lookupIndex);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails().map(notification => notification.ownerId))).toEqual([currentOwner]);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(update.targetSha);
});

// make a current alert retry after its stale-display repair fails
test('retries the current upstream alert after stale-display recovery fails', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { holdDisplay: true });
  const update = { available: true, commitCount: 3, targetSha: '6'.repeat(40) };
  await serveConsole(page, [], update);
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available/u);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { displayGateStarts: () => number } }).__testNotificationFixture.displayGateStarts())).toBe(1);

  update.commitCount = 4;
  update.targetSha = '7'.repeat(40);
  await page.keyboard.press('Escape');
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.body)).toBe('4 commits upstream');
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setNextDisplayResult: (result: 'reject') => void } }).__testNotificationFixture.setNextDisplayResult('reject'));

  // fail the recovery display from the obsolete request
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldDisplay: () => void } }).__testNotificationFixture.releaseHeldDisplay());
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBeUndefined();

  // reconnect to retry the unchanged target after the failed repair
  await page.keyboard.press('Escape');
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ ownerId?: unknown }> } }).__testNotificationFixture.activeNotificationDetails()[0]?.ownerId)).not.toBeUndefined();
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(update.targetSha);
});

// persist a successful repair even when the newer target's first display failed
test('commits the current upstream fingerprint after a successful stale-display repair', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { holdDisplay: true });
  const update = { available: true, commitCount: 3, targetSha: '6'.repeat(40) };
  await serveConsole(page, [], update);
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { displayGateStarts: () => number } }).__testNotificationFixture.displayGateStarts())).toBe(1);

  // reject the newer target before releasing the obsolete display
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { setNextDisplayResult: (result: 'reject') => void } }).__testNotificationFixture.setNextDisplayResult('reject'));
  update.commitCount = 4;
  update.targetSha = '7'.repeat(40);
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(2);
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldDisplay: () => void } }).__testNotificationFixture.releaseHeldDisplay());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ body?: string }> } }).__testNotificationFixture.activeNotificationDetails().map(notification => notification.body))).toEqual(['4 commits upstream']);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(update.targetSha);

  // an unchanged availability poll must not announce the repaired target again
  const attempts = await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts());
  await page.clock.fastForward(5 * 60_000);
  expect(await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(attempts);
});

// replace an obsolete upstream alert with a durable rebuild retry immediately
test('clears upstream notifications when a failed update only needs a rebuild retry', async ({ page }) => {
  await captureNotifications(page);
  const targetSha = '6'.repeat(40);
  const update = { available: true, commitCount: 1, targetSha };
  await serveConsole(page, [], update);
  // preview one pinned update without launching an advisor
  await page.route('**/api/server/update-preview', route => route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Refresh the console', author: 'Ansel', authoredAt: '2026-11-12T12:00:00Z' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } }));
  // model git reaching the target before the host rebuild fails
  await page.route('**/api/server/update', route => {
    update.commitCount = 0;
    return route.fulfill({ status: 202, json: { id: 'failed-update', state: 'running' } });
  });
  // publish a terminal failure that triggers an immediate availability refresh
  await page.route('**/api/server/update/failed-update', route => route.fulfill({ json: { state: 'failed' } }));
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => unknown[] } }).__testNotificationFixture.activeNotificationDetails().length)).toBe(1);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(targetSha);
  await page.evaluate(() => { location.hash = '#server-update'; });
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Update failed.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => unknown[] } }).__testNotificationFixture.activeNotificationDetails().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBeUndefined();
  await dialog.getByRole('button', { name: 'Close server update' }).click();
  await expect(selector).toHaveAccessibleName(/update available$/u);
});

// coalesce a failure refresh with the same target's pending browser registration
test('retains a pending upstream alert when update failure confirms the same target', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { permission: 'default' });
  const targetSha = '6'.repeat(40);
  await serveConsole(page, [], { available: true, commitCount: 1, targetSha });
  const refreshAvailability = await installAvailabilityRefresh(page);
  // preview the still-missing commit after a pre-merge update failure
  await page.route('**/api/server/update-preview', route => route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Refresh the console', author: 'Ansel', authoredAt: '2026-11-12T12:00:00Z' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } }));
  // accept an operation without changing the upstream target
  await page.route('**/api/server/update', route => route.fulfill({ status: 202, json: { id: 'pre-merge-failure', state: 'running' } }));
  // fail immediately so the terminal refresh races the held registration
  await page.route('**/api/server/update/pre-merge-failure', route => route.fulfill({ json: { state: 'failed' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Switch server/u })).toHaveAccessibleName(/update available$/u);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { registrationLookupsInFlight: () => number } }).__testNotificationFixture.registrationLookupsInFlight())).toBe(0);
  // freeze deadlines before holding the notification registration
  await page.clock.pauseAt(new Date('2026-11-12T12:01:00Z'));
  await page.evaluate(() => {
    const fixture = (window as typeof window & { __testNotificationFixture: { setPermission: (permission: NotificationPermission) => void; holdNextRegistration: () => void } }).__testNotificationFixture;
    fixture.setPermission('granted');
    fixture.holdNextRegistration();
  });
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { registrationGateStarts: () => number } }).__testNotificationFixture.registrationGateStarts())).toBe(1);
  await page.evaluate(() => { location.hash = '#server-update'; });
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  const failureRefresh = page.waitForResponse(candidate => new URL(candidate.url()).pathname === '/api/server/update-available');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await (await failureRefresh).finished();
  await expect(dialog.getByRole('status').filter({ hasText: 'Update failed.' })).toBeVisible();

  // finish the original owner without waiting for another availability poll
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldRegistration: () => void } }).__testNotificationFixture.releaseHeldRegistration());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ body?: string }> } }).__testNotificationFixture.activeNotificationDetails().map(notification => notification.body))).toEqual(['1 commit upstream']);
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(targetSha);
  expect(await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { attempts: () => number } }).__testNotificationFixture.attempts())).toBe(1);
});

// transfer a superseded polling owner's pending reservation without dropping its target
test('transfers a pending same-target alert to a restarted polling owner', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await captureNotifications(page, { holdDisplay: true });
  const targetSha = '6'.repeat(40);
  await serveConsole(page, [], { available: true, commitCount: 1, targetSha });
  const refreshAvailability = await installAvailabilityRefresh(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { displayGateStarts: () => number } }).__testNotificationFixture.displayGateStarts())).toBe(1);
  await refreshAvailability();
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(targetSha);
  // release the superseded display only after its replacement has committed
  await page.evaluate(() => (window as typeof window & { __testNotificationFixture: { releaseHeldDisplay: () => void } }).__testNotificationFixture.releaseHeldDisplay());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __testNotificationFixture: { activeNotificationDetails: () => Array<{ body?: string }> } }).__testNotificationFixture.activeNotificationDetails().map(notification => notification.body))).toEqual(['1 commit upstream']);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('rac.notification-update-fingerprints.v1') ?? '{}') as { rac?: string }).rac)).toBe(targetSha);
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
