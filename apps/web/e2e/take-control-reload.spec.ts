import { expect, test, type Page } from '@playwright/test';

type ConsoleScenario = {
  active: boolean;
  version?: string;
  rejectTakeover: boolean;
  takeoverGate: Promise<void>;
  takeoverRequests: number;
  serverUpdateChecks: number;
  navigations: number;
  browserErrors: string[];
};

// hold one external response until the scenario explicitly releases it
function responseGate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// share boundary responses while keeping scenario choices visible in each test
async function mockConsole(page: Page) {
  const scenario: ConsoleScenario = { active: false, rejectTakeover: false, takeoverGate: Promise.resolve(), takeoverRequests: 0, serverUpdateChecks: 0, navigations: 0, browserErrors: [] };
  page.on('pageerror', error => scenario.browserErrors.push(error.message));
  page.on('console', message => {
    // allow only the deliberately rejected takeover response
    const expectedRejection = scenario.rejectTakeover && message.location().url.endsWith('/api/auth/take-control') && message.text().includes('409');
    // retain every other console error including failed resources
    if (message.type() === 'error' && !expectedRejection) scenario.browserErrors.push(message.text());
  });
  page.on('framenavigated', frame => {
    // count full-document navigation only
    if (frame === page.mainFrame()) scenario.navigations += 1;
  });
  // keep the dashboard stream connected without sending unrelated updates
  await page.routeWebSocket('**/ws/dashboard', () => {});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish ownership without implicitly taking control
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: scenario.active, deviceName: 'Test device', ...(scenario.active ? {} : { controllingDeviceName: 'Other device' }) } });
    // apply ownership only after the explicit claim succeeds
    if (path === '/api/auth/take-control') {
      scenario.takeoverRequests += 1;
      await scenario.takeoverGate;
      // preserve the inactive session on a rejected claim
      if (scenario.rejectTakeover) return route.fulfill({ status: 409, json: { error: 'Other device still controls this console.' } });
      scenario.active = true;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', controllingDeviceName: 'Test device' } });
    }
    // expose the scenario's deployed bundle version
    if (path === '/api/ui-version') return route.fulfill({ json: { version: scenario.version } });
    // observe ready-only host checks without starting an update
    if (path === '/api/server/update-available') {
      scenario.serverUpdateChecks += 1;
      return route.fulfill({ json: { available: false } });
    }
    // provide the empty controlling console
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // authorize the inert dashboard stream
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // report no pending settings restart
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: false } });
    // leave agent installers idle
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    scenario.browserErrors.push(`Unexpected request: ${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return scenario;
}

// wait for response consumption and the resulting react commit
const settleBrowserFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// complete the version check in the browser before changing takeover state
async function checkUiVersion(page: Page) {
  const response = page.waitForResponse('**/api/ui-version');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await (await response).finished();
  await settleBrowserFrames(page);
}

// complete a passive ownership refresh without claiming control
async function refreshSession(page: Page) {
  const response = page.waitForResponse('**/api/auth/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await (await response).finished();
  await settleBrowserFrames(page);
}

// observe visible reload feedback while the new document is held at the boundary
async function holdReload(page: Page) {
  const gate = responseGate();
  const reload = { requests: 0, visible: false, release: gate.release };
  await page.route('**/', async route => {
    // leave non-navigation traffic alone
    if (!route.request().isNavigationRequest()) return route.continue();
    reload.requests += 1;
    await gate.promise;
    await route.continue();
  });
  await page.exposeFunction('reportTakeoverReload', () => { reload.visible = true; });
  await page.evaluate(() => {
    // record observable feedback rather than private transition classes
    const publish = () => {
      const loader = document.querySelector<HTMLElement>('[role="alert"][aria-label="Reloading UI"]');
      // wait until the reload cover is fully visible
      if (loader === null || getComputedStyle(loader).opacity !== '1') return;
      const bounds = loader.getBoundingClientRect();
      // ignore hidden or empty feedback
      if (bounds.width === 0 || bounds.height === 0) return;
      observer.disconnect();
      void (window as unknown as { reportTakeoverReload: () => Promise<void> }).reportTakeoverReload();
    };
    const observer = new MutationObserver(publish);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    publish();
  });
  return reload;
}

// prove one reload happens before any stale dashboard work begins
async function expectReload(page: Page, reload: Awaited<ReturnType<typeof holdReload>>, scenario: ConsoleScenario, previousHostChecks: number) {
  try {
    await expect.poll(() => reload.visible).toBe(true);
    await expect.poll(() => reload.requests).toBe(1);
    expect(scenario.serverUpdateChecks).toBe(previousHostChecks);
  } finally {
    // release navigation even when an assertion fails
    reload.release();
  }
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  expect(scenario.browserErrors).toEqual([]);
}

// reload a stale inactive client only after explicit control succeeds
test('reloads a stale inactive client only after successful explicit takeover', async ({ page }) => {
  const scenario = await mockConsole(page);
  scenario.version = '/assets/index-new.js';
  const takeover = responseGate();
  scenario.takeoverGate = takeover.promise;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  await checkUiVersion(page);
  await refreshSession(page);
  expect(scenario.takeoverRequests).toBe(0);
  expect(scenario.navigations).toBe(1);

  const reload = await holdReload(page);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => scenario.takeoverRequests).toBe(1);
  await expect(page.getByRole('alert', { name: 'Reloading UI' })).toHaveCount(0);
  expect(reload.requests).toBe(0);
  takeover.release();
  await expectReload(page, reload, scenario, 0);
});

// retain the pending reload when an active console loses control
test('reloads a stale client retained from the previously active console', async ({ page }) => {
  const scenario = await mockConsole(page);
  scenario.active = true;
  scenario.version = '/assets/index-new.js';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await checkUiVersion(page);
  await expect(page.getByRole('status', { name: 'UI update available' })).toBeVisible();

  scenario.active = false;
  await refreshSession(page);
  const takeControl = page.getByRole('button', { name: 'Take control', exact: true });
  await expect(takeControl).toBeVisible();
  await expect(page.getByRole('status', { name: 'UI update available' })).toHaveCount(0);
  const previousHostChecks = scenario.serverUpdateChecks;
  const reload = await holdReload(page);
  await takeControl.click();
  await expect.poll(() => scenario.takeoverRequests).toBe(1);
  await expectReload(page, reload, scenario, previousHostChecks);
});

// keep a failed claim on the stale control screen without reloading
test('does not reload a stale inactive client when explicit takeover fails', async ({ page }) => {
  const scenario = await mockConsole(page);
  scenario.version = '/assets/index-new.js';
  scenario.rejectTakeover = true;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  await checkUiVersion(page);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => scenario.takeoverRequests).toBe(1);
  await expect(page.getByRole('alert')).toHaveText('Other device still controls this console.');
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
  expect(scenario.navigations).toBe(1);
  expect(scenario.browserErrors).toEqual([]);
});

// honor a stale update discovered while the explicit claim is pending
test('reloads when the UI becomes stale during an in-flight takeover', async ({ page }) => {
  const scenario = await mockConsole(page);
  const takeover = responseGate();
  scenario.takeoverGate = takeover.promise;
  await page.goto('/');
  const reload = await holdReload(page);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => scenario.takeoverRequests).toBe(1);
  scenario.version = '/assets/index-new.js';
  await checkUiVersion(page);
  await expect(page.getByRole('alert', { name: 'Reloading UI' })).toHaveCount(0);
  expect(reload.requests).toBe(0);
  takeover.release();
  await expectReload(page, reload, scenario, 0);
});

// leave current clients on the normal takeover path
test('does not reload after passive checks or successful takeover on the current UI', async ({ page }) => {
  const scenario = await mockConsole(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  scenario.version = await page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    return script === null ? undefined : new URL(script.src).pathname;
  });
  expect(scenario.version).toBeTruthy();
  await checkUiVersion(page);
  await refreshSession(page);
  expect(scenario.takeoverRequests).toBe(0);
  expect(scenario.navigations).toBe(1);

  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => scenario.takeoverRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Reloading UI' })).toHaveCount(0);
  expect(scenario.navigations).toBe(1);
  expect(scenario.browserErrors).toEqual([]);
});
