import { expect, test, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner } from './progress-border-assertions.js';
import type { SettingsStatus } from '../src/settings/contracts.js';

// isolate host restart, recovery and offline transitions from the running stack
async function setup(page: Page) {
  await mockAccountSocket(page);
  await page.clock.install({ time: new Date('2026-10-19T12:00:00Z') });
  const state = {
    status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true, recoveryCommand: '~/.local/bin/rac-settings-recover fixture' } as SettingsStatus,
    reads: 0,
    restarts: 0,
    offline: false,
    restartMode: 'accepted' as 'accepted' | 'rejected' | 'interrupted',
    restartFrames: [] as Array<{ opacity: string; overlays: number; rootInert: boolean }>
  };
  // keep the reconnect overlay honest during the simulated outage
  await page.route('**/healthz', route => state.offline ? route.abort('failed') : route.fulfill({ json: { ok: true } }));
  // keep every browser request inside the synthetic fixture
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // fail every API while the synthetic host is unreachable
    if (state.offline) {
      if (path === '/api/settings/status') state.reads += 1;
      return route.abort('failed');
    }
    // publish an authenticated controlling browser without push enrollment
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'restart-csrf', active: true, deviceName: 'Restart fixture', server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'restart-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key' || path === '/api/ui-version') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // simulate a genuine failed fetch while retaining the last published deadline
    if (path === '/api/settings/status') {
      state.reads += 1;
      if (state.offline) return route.abort('failed');
      return route.fulfill({ json: state.status });
    }
    // queueing alone does not arm the host watchdog
    if (path === '/api/settings/restart') {
      state.restarts += 1;
      state.restartFrames.push(await page.evaluate(() => ({ opacity: getComputedStyle(document.querySelector('.reconnecting-overlay')!).opacity, overlays: document.querySelectorAll('.reconnecting-overlay').length, rootInert: document.getElementById('root')?.inert === true })));
      // reject before any host work or lose only the acknowledgement after queueing
      if (state.restartMode === 'rejected') return route.fulfill({ status: 409, json: { error: 'Restart is unavailable.' } });
      state.status = { ...state.status, operation: { id: `restart-${state.restarts}`, state: 'queued', phase: 'Waiting for the host applier' } };
      if (state.restartMode === 'interrupted') return route.abort('failed');
      return route.fulfill({ json: state.status.operation });
    }
    if (path === '/api/settings') return route.fulfill({ json: { version: 1, revisionId: 'restart-snapshot', sources: [{ id: 'app', label: 'Application configuration', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'restart-app', apply: 'rac-restart', value: { title: 'Fixture' }, schema: { type: 'object', properties: { title: { type: 'string', label: 'Service title' } } } }], status: state.status } });
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, mode: 'unconfigured', enabled: false, tokenPresent: false, serviceUrl: 'http://127.0.0.1:8787' } });
    if (path === '/api/settings/remask') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings', exact: true }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
  // freeze ahead of transport latency rather than racing the current clock tick
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5_000));
  // refresh durable status without advancing the countdown
  const refresh = async () => {
    const before = state.reads;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => state.reads).toBeGreaterThan(before);
  };
  // advance the entry animation while the watchdog clock remains under test control
  const startRestart = async () => {
    // let the compositor run the real css transition
    await page.clock.resume();
    await page.getByRole('status', { name: 'Restart pending', exact: true }).getByRole('button', { name: 'Restart', exact: true }).click();
    await expect.poll(() => state.restarts).toBe(1);
    // freeze the clock again before testing host-owned deadlines
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  };
  return { state, settings, refresh, startRestart };
}

// completed connector work must not own a later ordinary settings restart
for (const phase of ['connector-ready', 'activated']) {
  test(`keeps ordinary settings restartable after completed Cloudflare ${phase}`, async ({ page }) => {
    const { state, refresh, startRestart } = await setup(page);
    state.status.operation = { id: 'completed-cloudflare', kind: 'cloudflare', state: 'complete', phase };
    await refresh();

    const pending = page.getByRole('status', { name: 'Restart pending', exact: true });
    await expect(pending.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Review setup', exact: true })).toHaveCount(0);
    await startRestart();
    expect(state.restarts).toBe(1);
  });
}

// keep genuine setup failures visible without making later saved settings unrestartable
test('separates failed Cloudflare setup from later pending settings', async ({ page }) => {
  const { state, refresh, startRestart } = await setup(page);
  state.status = { ...state.status, pending: false, targets: [], operation: { id: 'failed-cloudflare', kind: 'cloudflare', state: 'failed', error: 'cloudflare_connector_failed' } };
  await refresh();
  await expect(page.getByRole('alert', { name: 'Cloudflare setup', exact: true })).toContainText('cloudflare_connector_failed');
  await expect(page.getByRole('link', { name: 'Review setup', exact: true })).toBeVisible();

  state.status = { ...state.status, pending: true, targets: ['rac'] };
  await refresh();
  const pending = page.getByRole('status', { name: 'Restart pending', exact: true });
  await expect(pending.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Review setup', exact: true })).toHaveCount(0);
  await expect(page.getByText('cloudflare_connector_failed', { exact: true })).toHaveCount(0);
  await startRestart();
  expect(state.restarts).toBe(1);
});

// malformed recovery guidance must preserve the last usable status instead of crashing
test('rejects malformed recovery guidance without losing the pending restart', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => { failures.push(error.message); });
  const { state, refresh } = await setup(page);
  state.status = { ...state.status, operation: { id: 'malformed-guidance', state: 'running', restart: { state: 'restarting', recoveryDeadline: Date.now() + 180_000 } }, recoveryCommand: { command: 'not a string' } as never };
  await refresh();

  const pending = page.getByRole('status', { name: 'Restart pending', exact: true });
  await expect(pending.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  await expect(pending).toContainText('Settings status is unavailable.');
  expect(failures).toEqual([]);
});

// prove that a fully painted loader precedes the host mutation at both screen sizes
for (const width of [390, 1440]) {
  test(`fades the fullscreen loader before submitting restart at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { state } = await setup(page);
    await page.addStyleTag({ content: '.reconnecting-overlay { transition-duration: 1s !important; }' });
    // let the browser compositor own the deliberately long fade
    await page.clock.resume();
    await page.getByRole('status', { name: 'Restart pending', exact: true }).getByRole('button', { name: 'Restart', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page.getByRole('alert', { name: 'Preparing restart', exact: true })).toBeVisible();
    const card = page.locator('.fullscreen-loader > .fullscreen-card');
    await expectProgressBorder(card, 'mauve');
    await expectClockwiseProgressBorder(card);
    await page.waitForTimeout(100);
    expect(state.restarts).toBe(0);
    await expect.poll(() => state.restarts, { timeout: 2_500 }).toBe(1);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    expect(state.restartFrames).toEqual([{ opacity: '1', overlays: 1, rootInert: true }]);
    await expect(page.locator('.reconnecting-overlay')).toContainText('Waiting for the host applier');
    await expect(page.getByRole('status', { name: 'Restart pending', exact: true })).toHaveCount(0);
    // prove focus cannot escape into either the app root or a later portal
    if (width === 390) {
      const isolation = await page.evaluate(async () => {
        const portalButton = document.createElement('button');
        portalButton.dataset.loaderPortalProbe = 'true';
        document.body.append(portalButton);
        await new Promise<void>(resolve => queueMicrotask(resolve));
        const backgroundButton = document.querySelector<HTMLElement>('#root button');
        portalButton.focus();
        const portalFocusBlocked = document.activeElement !== portalButton;
        backgroundButton?.focus();
        const backgroundFocusBlocked = document.activeElement !== backgroundButton;
        const portalInert = portalButton.inert;
        portalButton.remove();
        return { backgroundFocusBlocked, portalFocusBlocked, portalInert };
      });
      expect(isolation).toEqual({ backgroundFocusBlocked: true, portalFocusBlocked: true, portalInert: true });
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !document.getElementById('root')?.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: `/tmp/remoteagents-restart-loader-${width}.png` });
  });
}

// keep the restart symbol optically centered at every responsive width
for (const width of [390, 1440]) test(`centers the pending restart symbol at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  const notice = page.getByRole('status', { name: 'Restart pending', exact: true });
  const icon = notice.locator('.settings-restart-icon');
  await expect(icon).toBeVisible();
  await notice.screenshot({ path: `/tmp/remoteagents-restart-pending-${width}.png` });
  // compare the symbol and circle centers directly
  const geometry = await icon.evaluate(element => {
    const iconBounds = element.getBoundingClientRect();
    const symbol = element.querySelector('svg');
    // fail clearly when the restart symbol is missing
    if (symbol === null) throw new Error('The pending restart symbol is missing');
    const symbolBounds = symbol.getBoundingClientRect();
    return {
      xOffset: Math.abs(symbolBounds.left + symbolBounds.width / 2 - (iconBounds.left + iconBounds.width / 2)),
      yOffset: Math.abs(symbolBounds.top + symbolBounds.height / 2 - (iconBounds.top + iconBounds.height / 2))
    };
  });
  expect(geometry.xOffset).toBeLessThanOrEqual(.5);
  expect(geometry.yOffset).toBeLessThanOrEqual(.5);
});

// failed preflight must restore the actionable console instead of trapping the loader
test('releases the fullscreen loader after an explicit restart rejection', async ({ page }) => {
  const { state, startRestart } = await setup(page);
  state.restartMode = 'rejected';
  await startRestart();
  await expect(page.locator('.reconnecting-overlay')).toHaveCount(0);
  const restart = page.getByRole('status', { name: 'Restart pending', exact: true }).getByRole('button', { name: 'Restart', exact: true });
  await expect(restart).toBeEnabled();
  await expect(restart).toBeFocused();
  expect(await page.locator('#root').evaluate(element => element.inert)).toBe(false);
  expect(state.restarts).toBe(1);
});

// lost acknowledgements must not dismiss a restart that the host may have accepted
test('retains the fullscreen loader after an interrupted restart acknowledgement', async ({ page }) => {
  const { state, refresh, startRestart } = await setup(page);
  state.restartMode = 'interrupted';
  await startRestart();
  // an online console must stay covered until fresh status resolves ambiguity
  await expect(page.locator('.reconnecting-overlay')).toHaveCount(1);
  await expect(page.getByRole('alert', { name: 'Preparing restart', exact: true })).toBeVisible();
  expect(await page.locator('#root').evaluate(element => element.inert)).toBe(true);
  // the first authoritative read confirms the queued host operation
  await refresh();
  await expect(page.locator('.reconnecting-overlay')).toContainText('Waiting for the host applier');
  state.status = { ...state.status, pending: false, targets: [], operation: { id: 'restart-1', state: 'complete' } };
  await refresh();
  await expect(page.locator('.reconnecting-overlay')).toHaveCount(0);
  expect(state.restarts).toBe(1);
});

// reduced motion still paints an opaque cover before posting to the host
for (const preference of ['system', 'application']) {
  test(`paints the restart loader before submission with ${preference} reduced motion`, async ({ page }) => {
    // isolate each reduced-motion control from the other
    await page.emulateMedia({ reducedMotion: preference === 'system' ? 'reduce' : 'no-preference' });
    await page.setViewportSize({ width: preference === 'system' ? 390 : 1440, height: 900 });
    const { state, startRestart } = await setup(page);
    // select the application override after the preference synchronizer has mounted
    if (preference === 'application') await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
    await startRestart();
    await expect(page.locator('.reconnecting-overlay')).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.fullscreen-loader .auth-glow')).toHaveCSS('animation-name', 'none');
    await expectReducedMotionSpinner(page.locator('.fullscreen-loader > .fullscreen-card'), 'mauve');
    expect(state.restartFrames).toEqual([{ opacity: '1', overlays: 1, rootInert: true }]);
    await page.screenshot({ path: `/tmp/remoteagents-restart-loader-reduced-${preference}.png` });
  });
}

test('hides recovery before restart and counts down the fixed host deadline through disconnection and reload', async ({ page }) => {
  const { state, refresh, startRestart } = await setup(page);
  const notice = page.getByRole('status', { name: 'Restart pending', exact: true });
  await expect(notice).not.toContainText('recovery');
  await expect(notice.locator('code')).toHaveCount(0);
  await expect(page.getByRole('timer')).toHaveCount(0);
  await startRestart();
  const loader = page.locator('.reconnecting-overlay');
  await expect(loader).toContainText('Waiting for the host applier');
  await expect(loader).not.toContainText('Manual recovery');
  const deadline = await page.evaluate(() => Date.now() + 180_000);
  state.status.operation = { id: 'restart-1', state: 'running', phase: 'Restarting RAC', restart: { state: 'restarting', recoveryDeadline: deadline } };
  await refresh();
  const countdown = page.getByRole('timer', { name: 'Automatic recovery countdown' });
  await expect(countdown).toHaveText('Automatic recovery in 3:00');
  await expect(loader).toContainText('Manual recovery:');
  await expect(loader.getByRole('timer')).toHaveCount(1);
  state.offline = true;
  await refresh();
  await page.clock.fastForward(61_000);
  await expect(countdown).toHaveText('Automatic recovery in 1:59');
  await expect(loader).toContainText(/Console unavailable|Reconnecting to the server/u);
  await expect(page.getByRole('alert', { name: 'Restarting server', exact: true })).toBeVisible();
  await expect(loader).toHaveCount(1);
  // a merely mounted timer must not disappear behind the reconnect screen
  expect(await countdown.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit !== null && element.contains(hit);
  })).toBe(true);
  await page.screenshot({ path: '/tmp/remoteagents-restart-countdown-offline.png' });
  state.offline = false;
  await page.reload();
  await expect(countdown).toHaveText('Automatic recovery in 1:59');
  await page.clock.fastForward(120_000);
  await expect(countdown).toContainText('Automatic recovery in 0:00');
  await expect(countdown).not.toContainText('-');
  state.status.operation = { ...state.status.operation, id: 'restart-1', state: 'running', restart: { state: 'recovering', recoveryDeadline: deadline } };
  await refresh();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(loader).toContainText('Automatic host recovery is in progress');
});

// verify terminal results at narrow and wide split widths
for (const width of [390, 1440]) test(`shows a dismissible success without reappearing on polls or reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const { state, refresh, startRestart } = await setup(page);
  await startRestart();
  state.status = { ...state.status, pending: false, targets: [], operation: { id: 'restart-1', state: 'complete', restart: { state: 'restarted', recoveryDeadline: await page.evaluate(() => Date.now() + 180_000) } } };
  await refresh();
  const result = page.getByRole('status', { name: 'Server restarted successfully', exact: true });
  await expect(result).toBeVisible();
  await expect(page.getByRole('status', { name: 'Restart pending', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(result).toBeVisible();
  await page.screenshot({ path: `/tmp/remoteagents-restart-success-${width}.png` });
  await refresh();
  await expect(result).toHaveCount(1);
  await result.getByRole('button', { name: 'Dismiss restart result', exact: true }).click();
  await refresh();
  await expect(result).toHaveCount(0);
  await page.reload();
  await expect(result).toHaveCount(0);
  // a different operation is never suppressed by the preceding dismissal
  state.status.operation = { id: 'restart-2', state: 'complete', restart: { state: 'restarted', recoveryDeadline: await page.evaluate(() => Date.now() + 180_000) } };
  await refresh();
  await expect(result).toBeVisible();
});

// expire only successful restart results on one fixed per-operation deadline
test('auto-dismisses each successful restart exactly five seconds without poll resurrection', async ({ page }) => {
  const { state, refresh } = await setup(page);
  state.status = { ...state.status, pending: false, targets: [], operation: { id: 'restart-1', state: 'complete', restart: { state: 'restarted', recoveryDeadline: await page.evaluate(() => Date.now() + 180_000) } } };
  await refresh();
  const result = page.getByRole('status', { name: 'Server restarted successfully', exact: true });
  await expect(result).toBeVisible();

  // the ordinary four-second poll must not restart the five-second lifetime
  const readsBeforePoll = state.reads;
  await page.clock.fastForward(4_000);
  await expect.poll(() => state.reads).toBeGreaterThan(readsBeforePoll);
  await refresh();
  await page.clock.fastForward(999);
  await expect(result).toBeVisible();
  await page.clock.fastForward(1);
  await expect(result).toHaveCount(0);
  await refresh();
  await expect(result).toHaveCount(0);
  await page.reload();
  await expect(result).toHaveCount(0);

  // a later operation receives its own complete five-second lifetime
  state.status.operation = { id: 'restart-2', state: 'complete', restart: { state: 'restarted', recoveryDeadline: await page.evaluate(() => Date.now() + 180_000) } };
  await refresh();
  await expect(result).toBeVisible();
  await page.clock.fastForward(4_999);
  await expect(result).toBeVisible();
  await page.clock.fastForward(1);
  await expect(result).toHaveCount(0);
});

// retain every actionable or warning notice until its explicit terminal transition
test('keeps pending, recovery warning, and failure notices persistent past five seconds', async ({ page }) => {
  const { state, refresh } = await setup(page);
  const pending = page.getByRole('status', { name: 'Restart pending', exact: true });
  await page.clock.fastForward(5_000);
  await expect(pending).toBeVisible();

  state.status.operation = { id: 'recovered-1', state: 'failed', error: 'restart-watchdog-expired', restart: { state: 'recovered', recoveryDeadline: await page.evaluate(() => Date.now() - 1) } };
  await refresh();
  const warning = page.getByRole('alert', { name: 'Server recovered after a restart failure', exact: true });
  await expect(warning).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(warning).toBeVisible();

  state.status.operation = { id: 'failed-1', state: 'failed', error: 'validation-failed' };
  await refresh();
  const failure = page.getByRole('alert', { name: 'Restart pending', exact: true });
  await expect(failure).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(failure).toBeVisible();
});

test('warns after proved recovery while preserving the actionable pending changes', async ({ page }) => {
  const { state, refresh } = await setup(page);
  state.status.operation = { id: 'recovered-1', state: 'failed', error: 'restart-watchdog-expired', restart: { state: 'recovered', recoveryDeadline: await page.evaluate(() => Date.now() - 1) } };
  await refresh();
  const warning = page.getByRole('alert', { name: 'Server recovered after a restart failure', exact: true });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Saved settings were kept for review');
  const pending = page.getByRole('status', { name: 'Restart pending', exact: true });
  await expect(pending.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  await expect(pending).not.toContainText('restart-watchdog-expired');
  await expect(pending).not.toContainText('Manual recovery');
  await page.screenshot({ path: '/tmp/remoteagents-restart-recovered.png' });
  await warning.getByRole('button', { name: 'Dismiss restart result', exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(pending).toBeVisible();
});

test('does not claim recovery when the host failed before restart or recovery itself failed', async ({ page }) => {
  const { state, refresh } = await setup(page);
  state.status.operation = { id: 'preflight-1', state: 'failed', error: 'validation-failed' };
  await refresh();
  await expect(page.locator('.settings-restart-result')).toHaveCount(0);
  const failure = page.getByRole('alert', { name: 'Restart pending', exact: true });
  await expect(failure.getByRole('button', { name: 'Retry restart', exact: true })).toBeEnabled();
  await expect(failure).not.toContainText('Manual recovery');
  state.status.operation = { id: 'failed-recovery-1', state: 'failed', error: 'manual-recovery-required', restart: { state: 'recovery-failed', recoveryDeadline: await page.evaluate(() => Date.now() - 1) } };
  await refresh();
  await expect(failure).toContainText('Manual recovery:');
  await expect(page.locator('.settings-restart-result')).toHaveCount(0);
});
