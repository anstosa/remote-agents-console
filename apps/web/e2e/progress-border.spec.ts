import { expect, test, type Page, type Route } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner } from './progress-border-assertions';

test.describe.configure({ timeout: 60_000 });

type RestartStatus = {
  pending: boolean;
  targets: Array<'rac' | 'cloudflared'>;
  effective: 'known' | 'unknown';
  restartAvailable: boolean;
  operation?: { id: string; state: 'queued' | 'running' | 'complete' | 'failed'; phase?: string; error?: string };
};

type RestartFixture = {
  status: RestartStatus;
  restartRequests: number;
};

type Gate = {
  promise: Promise<void>;
  release: () => void;
};

// hold one mocked boundary until its pending state is observable
function createGate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// mount one authenticated console with only settings mutations mocked
async function mountRestartFixture(page: Page, fixture: RestartFixture, restart: (route: Route, fixture: RestartFixture) => Promise<void>) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render the empty dashboard shell
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // expose the mutable restart lifecycle
    if (path === '/api/settings/status') return route.fulfill({ json: fixture.status });
    // isolate the restart mutation from the host
    if (path === '/api/settings/restart' && request.method() === 'POST') {
      fixture.restartRequests += 1;
      return restart(route, fixture);
    }
    // disable agent updates
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable host updates
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // keep visibility refreshes from latching a client update
    if (path === '/api/ui-version') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });
  await page.goto('/');
}

// swap the startup border for a compact spinner under either reduced-motion preference
test('frames startup with a clockwise border or reduced-motion spinner', async ({ page }) => {
  const sessionGate = createGate();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // hold authentication on the initial loading screen
  await page.route('**/api/auth/session', async route => {
    await sessionGate.promise;
    return route.fulfill({ json: { csrfToken: 'csrf-token', active: false } });
  });
  await page.goto('/');

  const loader = page.locator('main.loading-screen .loading-console.progress-border');
  const ring = loader.locator(':scope > .update-progress-ring');
  try {
    await expect(loader).toContainText('Restoring secure session');
    await expect(loader.locator('.loading-bars')).toHaveCount(0);
    await expectProgressBorder(loader, 'mauve');
    await expectClockwiseProgressBorder(loader);
    await expect.poll(() => loader.locator('.loading-line').evaluate(element => ({ animations: element.getAnimations().length, transform: getComputedStyle(element).transform }))).toEqual({ animations: 0, transform: 'none' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectReducedMotionSpinner(loader, 'mauve');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectProgressBorder(loader, 'mauve');
    await expectClockwiseProgressBorder(loader);
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
    await expectReducedMotionSpinner(loader, 'mauve');
    await page.evaluate(() => { delete document.documentElement.dataset.motion; });
    await expectProgressBorder(loader, 'mauve');
    await expectClockwiseProgressBorder(loader);
  } finally {
    // release authentication during failed assertions too
    sessionGate.release();
  }
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  await expect(ring).toHaveCount(0);
});

// keep the blue pending border painted before the real document reload begins
test('paints reload progress before navigating to the fresh client', async ({ page }) => {
  const fixture: RestartFixture = {
    status: { pending: false, targets: [], effective: 'known', restartAvailable: true },
    restartRequests: 0
  };
  let navigations = 0;
  page.on('framenavigated', frame => {
    // count only document navigation
    if (frame === page.mainFrame()) navigations += 1;
  });
  await mountRestartFixture(page, fixture, async route => route.fulfill({ status: 500, json: { error: 'unexpected restart' } }));
  const initialNavigations = navigations;
  await page.route('**/api/ui-version', route => route.fulfill({ json: { version: '/assets/index-new.js' } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  const notification = page.getByRole('status', { name: 'UI update available' });
  const reload = notification.getByRole('button', { name: 'Reload UI' });
  await expect(reload).toBeVisible();
  await expect(reload).toHaveAttribute('aria-busy', 'false');
  await expect(reload.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(reload.locator('.spinner')).toHaveCount(0);
  // compare the action with the current theme rather than one fixed palette
  const expectedBlue = await reload.evaluate(element => getComputedStyle(element).getPropertyValue('--blue').trim());

  type ReloadPaint = {
    busy: string | null;
    disabled: boolean;
    progress: string;
    parentAnimations: number;
    parentTransform: string;
    ringAnimations: number;
    ringVisible: boolean;
  };
  let painted: ReloadPaint | undefined;
  await page.exposeFunction('reportReloadPaint', (snapshot: ReloadPaint) => { painted = snapshot; });
  await reload.evaluate((button: HTMLButtonElement) => {
    const observer = new MutationObserver(() => {
      // report only the committed pending state
      if (button.getAttribute('aria-busy') !== 'true') return;
      observer.disconnect();
      window.requestAnimationFrame(() => {
        const ring = button.querySelector<HTMLElement>(':scope > .update-progress-ring');
        // identify a missing pending indicator before reading its rendered state
        if (ring === null) throw new Error('pending reload button has no progress border');
        const style = getComputedStyle(button);
        const bounds = ring.getBoundingClientRect();
        void (window as unknown as { reportReloadPaint: (snapshot: ReloadPaint) => Promise<void> }).reportReloadPaint({
          busy: button.getAttribute('aria-busy'),
          disabled: button.disabled,
          progress: style.getPropertyValue('--progress-ring-color').trim(),
          parentAnimations: button.getAnimations().length,
          parentTransform: style.transform,
          ringAnimations: ring.getAnimations({ subtree: true }).length,
          ringVisible: bounds.width > 0 && bounds.height > 0 && getComputedStyle(ring).visibility === 'visible'
        });
      });
    });
    observer.observe(button, { attributes: true, childList: true, subtree: true });
  });

  const click = reload.click({ noWaitAfter: true });
  await expect.poll(() => painted).toEqual({
    busy: 'true',
    disabled: true,
    progress: expectedBlue,
    parentAnimations: 0,
    parentTransform: 'none',
    ringAnimations: 1,
    ringVisible: true
  });
  await expect.poll(() => navigations).toBeGreaterThan(initialNavigations);
  await click;
  expect(fixture.restartRequests).toBe(0);
});

// keep restart progress in the fullscreen handoff until durable status settles
test('keeps restart progress fullscreen until the operation settles', async ({ page }) => {
  const restartGate = createGate();
  const fixture: RestartFixture = {
    status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true },
    restartRequests: 0
  };
  // hold the mutation before publishing the queued operation
  await mountRestartFixture(page, fixture, async route => {
    await restartGate.promise;
    fixture.status = { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true, operation: { id: 'restart-1', state: 'queued', phase: 'Waiting for the host applier' } };
    await route.fulfill({ json: fixture.status });
  });

  const notice = page.getByRole('status', { name: 'Restart pending' });
  const restart = notice.getByRole('button', { name: 'Restart', exact: true });
  await expect(restart).toBeEnabled();
  await expect(restart.locator('.update-progress-ring')).toHaveCount(0);

  const loader = page.getByRole('alert', { name: 'Preparing restart', exact: true });
  const card = loader.locator(':scope > .fullscreen-card');
  try {
    await restart.click();
    await expect.poll(() => fixture.restartRequests).toBe(1);
    await expect(loader).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expectProgressBorder(card, 'mauve');
    await expectClockwiseProgressBorder(card);
  } finally {
    // release the mocked restart during failed assertions too
    restartGate.release();
  }
  await expect(loader).toContainText('Waiting for the host applier');
  fixture.status = { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true, operation: { id: 'restart-1', state: 'running', phase: 'Restarting RAC' } };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(loader).toContainText('Restarting RAC');
  await expectProgressBorder(card, 'mauve');

  fixture.status = { pending: false, targets: [], effective: 'known', restartAvailable: true, operation: { id: 'restart-1', state: 'complete' } };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(loader).toHaveCount(0);
  await expect(page.locator('.fullscreen-loader .update-progress-ring')).toHaveCount(0);
});

// keep a failed retry inside the reduced-motion fullscreen handoff
test('shows a reduced-motion fullscreen retry spinner and stops it after failure', async ({ page }) => {
  const restartGate = createGate();
  const fixture: RestartFixture = {
    status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true, operation: { id: 'restart-1', state: 'failed', error: 'First restart failed.' } },
    restartRequests: 0
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // hold the retry before returning its second failure
  await mountRestartFixture(page, fixture, async route => {
    await restartGate.promise;
    await route.fulfill({ status: 503, json: { error: 'Retry rejected by fixture.' } });
  });

  const notice = page.getByRole('alert', { name: 'Restart pending' });
  const retry = notice.getByRole('button', { name: 'Retry restart', exact: true });
  await expect(retry).toBeEnabled();
  await expect(retry.locator('.update-progress-ring')).toHaveCount(0);

  const loader = page.getByRole('alert', { name: 'Preparing restart', exact: true });
  const card = loader.locator(':scope > .fullscreen-card');
  try {
    await retry.click();
    await expect.poll(() => fixture.restartRequests).toBe(1);
    await expect(loader).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expectReducedMotionSpinner(card, 'mauve');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
    await expectReducedMotionSpinner(card, 'mauve');
    await page.evaluate(() => { delete document.documentElement.dataset.motion; });
    await expectProgressBorder(card, 'mauve');
    await expectClockwiseProgressBorder(card);
  } finally {
    // release the mocked retry during failed assertions too
    restartGate.release();
  }
  await expect(loader).toHaveCount(0);
  await expect(retry).toBeEnabled();
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry.locator('.update-progress-ring')).toHaveCount(0);
  await expect(notice).toContainText('First restart failed.');
});
