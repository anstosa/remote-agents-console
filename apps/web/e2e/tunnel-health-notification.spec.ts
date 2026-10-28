import { expect, test, type Page } from '@playwright/test';
import type { TunnelHealth } from '../src/settings/contracts.js';

const healthy: TunnelHealth = { state: 'healthy', checkedAt: '2026-10-28T22:00:00.000Z', lastHealthyAt: '2026-10-28T22:00:00.000Z', failures: 0, reconnecting: false, canReconnect: true };
const disabled: TunnelHealth = { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false };

// mount the isolated production provider, fullscreen hook and global notice
async function mountTunnelHealth(page: Page, reducedMotion = true): Promise<void> {
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  // keep the detached application root free of dashboard portals
  await page.route('**/api/auth/session', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.route('**/api/auth/bootstrap', route => route.fulfill({ json: { csrfToken: 'fixture-csrf' } }));
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true } }));
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderTunnelHealthFixture } = await import('/e2e/tunnel-health-fixture.tsx');
    const root = document.createElement('div');
    root.id = 'root';
    document.body.replaceChildren(root);
    renderTunnelHealthFixture(root);
  });
  await expect(page.getByRole('region', { name: 'Tunnel health lifecycle' })).toBeVisible();
}

// publish one cached health response through the production parser
const setHealth = (page: Page, health: TunnelHealth) => page.evaluate(async health => {
  const { setTunnelServerHealth } = await import('/e2e/tunnel-health-fixture.tsx');
  await setTunnelServerHealth(health);
}, health);

// inspect fixture lifecycle facts without relying on inert controls
const tunnelSnapshot = (page: Page) => page.evaluate(async () => (await import('/e2e/tunnel-health-fixture.tsx')).readTunnelSnapshot());

// release one held reconnect response through the fixture boundary
const resolveReconnect = (page: Page, index: number, accepted: boolean) => page.evaluate(async ({ index, accepted }) => {
  const { resolveTunnelReconnect } = await import('/e2e/tunnel-health-fixture.tsx');
  resolveTunnelReconnect(index, accepted);
}, { index, accepted });

// dispatch duplicate reconnect input and read the same-task mutation count
const clickReconnectImmediately = (page: Page, selector = '[aria-label="Tunnel degraded"] button') => page.evaluate(async selector => {
  const fixture = await import('/e2e/tunnel-health-fixture.tsx');
  const button = document.querySelector<HTMLButtonElement>(selector);
  // require the intended production control
  if (button === null) throw new Error('Reconnect control is missing');
  button.click();
  button.click();
  return fixture.readTunnelSnapshot().postCount;
}, selector);

for (const viewport of [
  { label: 'desktop', width: 1440, height: 900, reducedMotion: false },
  { label: 'mobile', width: 390, height: 760, reducedMotion: true }
]) {
  test(`paints tunnel recovery before POST at ${viewport.label} size`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountTunnelHealth(page, viewport.reducedMotion);

    const notice = page.getByRole('alert', { name: 'Tunnel degraded' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Public tunnel checks failed while RAC responded locally.');
    await expect(notice.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();

    // neither normal nor reduced motion may submit in the initiating task
    expect(await clickReconnectImmediately(page)).toBe(0);
    const fullscreen = page.getByRole('alert', { name: 'Reconnecting tunnel' });
    await expect(fullscreen).toBeVisible();
    await expect(page.getByRole('alert', { name: 'Tunnel degraded' })).toHaveCount(0);
    await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
    const observation = (await tunnelSnapshot(page)).posts[0];
    expect(observation).toEqual({ label: 'Reconnecting tunnel', opacity: '1', nestedNoticeCount: 0 });
  });
}

test('serializes reconnect and retains its cover until verified recovery', async ({ page }) => {
  await mountTunnelHealth(page);
  expect(await clickReconnectImmediately(page)).toBe(0);
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();

  // cached healthy data received while the POST is held cannot release the cover
  await setHealth(page, healthy);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();

  // a submitted operation survives controller displacement
  await page.evaluate(async () => {
    const { setTunnelCanMutate } = await import('/e2e/tunnel-health-fixture.tsx');
    await setTunnelCanMutate(false);
  });
  await resolveReconnect(page, 0, true);
  // accepted work cannot reuse the same cached healthy proof
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  await setHealth(page, healthy);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  // a healthy-but-reconnecting snapshot advances the baseline without settling
  const reconnectingHealthy = { ...healthy, checkedAt: '2026-10-28T22:00:01.000Z', lastHealthyAt: '2026-10-28T22:00:01.000Z', reconnecting: true };
  await setHealth(page, reconnectingHealthy);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  await setHealth(page, { ...reconnectingHealthy, reconnecting: false });
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  await setHealth(page, { ...healthy, checkedAt: '2026-10-28T22:00:02.000Z', lastHealthyAt: '2026-10-28T22:00:02.000Z' });
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
});

test('accepts a changed post-reconnect check identity across backward clock correction', async ({ page }) => {
  await mountTunnelHealth(page);
  const futureCheck: TunnelHealth = { state: 'degraded', checkedAt: '2099-01-01T00:00:00.000Z', lastHealthyAt: '2099-01-01T00:00:00.000Z', failures: 2, reconnecting: false, canReconnect: true, error: 'tunnel_unreachable' };
  await setHealth(page, futureCheck);
  await page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await resolveReconnect(page, 0, true);

  // reconnect completion cannot reuse a check observed while the backend was busy
  const sameCheck = { ...futureCheck, state: 'healthy' as const, failures: 0, reconnecting: true, error: undefined };
  await setHealth(page, sameCheck);
  await setHealth(page, { ...sameCheck, reconnecting: false });
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  // a changed valid check identity remains fresh even when the wall clock moves backward
  await setHealth(page, { ...sameCheck, checkedAt: '2026-01-01T00:00:00.000Z', reconnecting: false });
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  expect((await tunnelSnapshot(page)).postCount).toBe(1);
});

test('keeps failed reconnect actionable and permits one explicit retry', async ({ page }) => {
  await mountTunnelHealth(page);
  await page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await resolveReconnect(page, 0, false);

  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  const notice = page.getByRole('alert', { name: 'Tunnel degraded' });
  await expect(notice).toContainText('The reconnect request could not reach RAC. Try again from the local RAC address.');
  const retry = notice.getByRole('button', { name: 'Reconnect', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(2);
});

test('releases an accepted reconnect after the bounded health verification deadline', async ({ page }) => {
  await mountTunnelHealth(page);
  await page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await page.clock.install();
  await resolveReconnect(page, 0, true);
  await expect.poll(async () => (await tunnelSnapshot(page)).health?.reconnecting).toBe(true);
  await page.evaluate(async () => {
    const { failTunnelHealthRead } = await import('/e2e/tunnel-health-fixture.tsx');
    await failTunnelHealthRead();
  });

  // transient health failures retain the submitted operation cover
  await page.clock.runFor(89_000);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  expect((await tunnelSnapshot(page)).postCount).toBe(1);
  // the bounded watchdog returns to one explicit retry without replaying the POST
  await page.clock.runFor(1_001);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  const notice = page.getByRole('alert', { name: 'Tunnel degraded' });
  await expect(notice).toContainText('Tunnel recovery status is unavailable. Try again.');
  await expect(notice.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  expect((await tunnelSnapshot(page)).postCount).toBe(1);
});

test('cancels a prepaint reconnect when authentication is revoked', async ({ page }) => {
  await mountTunnelHealth(page, false);
  const immediatePosts = await page.evaluate(async () => {
    const fixture = await import('/e2e/tunnel-health-fixture.tsx');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Tunnel degraded"] button');
    // require the initiating production control
    if (button === null) throw new Error('Reconnect control is missing');
    button.click();
    await fixture.setTunnelEnabled(false);
    return fixture.readTunnelSnapshot().postCount;
  });
  expect(immediatePosts).toBe(0);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
});

test('cancels a prepaint reconnect when controller authority is revoked', async ({ page }) => {
  await mountTunnelHealth(page, false);
  await page.evaluate(async () => {
    const fixture = await import('/e2e/tunnel-health-fixture.tsx');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Tunnel degraded"] button');
    // require the initiating production control
    if (button === null) throw new Error('Reconnect control is missing');
    button.click();
    await fixture.setTunnelCanMutate(false);
  });
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0, { timeout: 2_000 });
  expect((await tunnelSnapshot(page)).postCount).toBe(0);
  const reconnect = page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true });
  await expect(reconnect).toBeDisabled();
  await expect(reconnect).toHaveAttribute('title', 'Take control to reconnect');
});

test('an old authenticated response cannot release a newer reconnect', async ({ page }) => {
  await mountTunnelHealth(page);
  await page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await page.evaluate(async () => {
    const { setTunnelEnabled } = await import('/e2e/tunnel-health-fixture.tsx');
    await setTunnelEnabled(false);
    await setTunnelEnabled(true);
  });
  await expect(page.getByRole('alert', { name: 'Tunnel degraded' })).toBeVisible();
  await page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(2);

  // the retired request cannot release the new session's cover
  await resolveReconnect(page, 0, false);
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  await resolveReconnect(page, 1, true);
  await setHealth(page, healthy);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
});

test('shows degradation to viewers without granting reconnect authority', async ({ page }) => {
  await mountTunnelHealth(page);
  await page.evaluate(async () => {
    const { setTunnelCanMutate } = await import('/e2e/tunnel-health-fixture.tsx');
    await setTunnelCanMutate(false);
  });

  const reconnect = page.getByRole('alert', { name: 'Tunnel degraded' }).getByRole('button', { name: 'Reconnect', exact: true });
  await expect(reconnect).toBeDisabled();
  await expect(reconnect).toHaveAttribute('title', 'Take control to reconnect');
  await setHealth(page, healthy);
  await page.evaluate(async () => {
    const { setTunnelOverlay } = await import('/e2e/tunnel-health-fixture.tsx');
    await setTunnelOverlay(true);
  });
  const offlineReconnect = page.getByRole('alert', { name: 'Reconnecting to console' }).getByRole('group', { name: 'Public connection lost' }).getByRole('button', { name: 'Reconnect', exact: true });
  await expect(offlineReconnect).toBeDisabled();
  await expect(offlineReconnect).toHaveAttribute('title', 'Take control to reconnect');
});

test('omits healthy and unconfigured tunnel notices', async ({ page }) => {
  await mountTunnelHealth(page);
  await setHealth(page, healthy);
  await expect(page.getByRole('alert', { name: 'Tunnel degraded' })).toHaveCount(0);
  await setHealth(page, disabled);
  await expect(page.getByRole('alert', { name: 'Tunnel degraded' })).toHaveCount(0);
});

test('rejects unbounded tunnel diagnostics without replacing the last safe state', async ({ page }) => {
  await mountTunnelHealth(page);
  const notice = page.getByRole('alert', { name: 'Tunnel degraded' });
  await expect(notice).toBeVisible();
  await page.evaluate(async () => {
    const { setTunnelServerHealth } = await import('/e2e/tunnel-health-fixture.tsx');
    // model an expanded helper response that the public contract must reject
    await setTunnelServerHealth({ state: 'healthy', failures: 0, reconnecting: false, canReconnect: true, error: 'private_helper_detail' } as never);
  });
  await expect(notice).toBeVisible();
});

test('moves passive outage recovery to the dedicated tunnel page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await mountTunnelHealth(page);
  await setHealth(page, healthy);
  await page.evaluate(async () => {
    const { setTunnelOverlay } = await import('/e2e/tunnel-health-fixture.tsx');
    await setTunnelOverlay(true);
  });

  const outage = page.getByRole('alert', { name: 'Reconnecting to console' });
  const recovery = outage.getByRole('group', { name: 'Public connection lost' });
  await expect(recovery).toContainText('Tunnel status is unavailable.');
  await recovery.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const tunnelPage = page.getByRole('alert', { name: 'Reconnecting tunnel' });
  await expect(tunnelPage).toBeVisible();
  await expect(tunnelPage.getByRole('group', { name: 'Public connection lost' })).toHaveCount(0);
  await expect(tunnelPage.locator('.tunnel-health-notice')).toHaveCount(0);
  await expect.poll(async () => (await tunnelSnapshot(page)).postCount).toBe(1);
  await resolveReconnect(page, 0, false);
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' }).getByRole('group', { name: 'Public connection lost' })).toContainText('Try again from the local RAC address.');
});

// verify entrypoint placement, csrf mutation and painted handoff in the real app tree
test('mounts painted tunnel recovery globally and retains outage fallback', async ({ page }) => {
  let offline = false;
  let health: TunnelHealth = { state: 'degraded', checkedAt: '2026-10-28T22:00:00.000Z', lastHealthyAt: '2026-10-28T21:59:00.000Z', failures: 2, reconnecting: false, canReconnect: true, error: 'tunnel_unreachable' };
  let reconnects = 0;
  let postObservation: { label: string | null; opacity: string; nestedNoticeCount: number; noticeCount: number } | undefined;
  await page.route('**/healthz', route => offline ? route.abort('failed') : route.fulfill({ json: { ok: true } }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // model a public tunnel outage across every protected endpoint
    if (offline) return route.abort('failed');
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'tunnel-csrf', active: true, deviceName: 'Tunnel fixture', server: { name: 'Fixture', url: 'https://fixture.example.test', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'tunnel-ticket' } });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/push/public-key' || path === '/api/ui-version') return route.fulfill({ json: {} });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    if (path === '/api/settings/cloudflare/health' && route.request().method() === 'GET') return route.fulfill({ json: health });
    if (path === '/api/settings/cloudflare/reconnect' && route.request().method() === 'POST') {
      postObservation = await page.evaluate(() => {
        const overlay = document.querySelector<HTMLElement>('.fullscreen-loader');
        return { label: overlay?.getAttribute('aria-label') ?? null, opacity: overlay === null ? '' : getComputedStyle(overlay).opacity, nestedNoticeCount: overlay?.querySelectorAll('.tunnel-health-notice').length ?? 0, noticeCount: document.querySelectorAll('.tunnel-health-notice').length };
      });
      reconnects += 1;
      expect(route.request().postData()).toBe('{}');
      expect(route.request().headers()['x-csrf-token']).toBe('tunnel-csrf');
      health = { ...health, state: 'checking', reconnecting: true, error: undefined };
      return route.fulfill({ status: 202, json: { operation: { id: `reconnect-${reconnects}`, kind: 'cloudflare', state: 'queued' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notice = page.getByRole('alert', { name: 'Tunnel degraded' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const tunnelPage = page.getByRole('alert', { name: 'Reconnecting tunnel' });
  await expect(tunnelPage).toBeVisible();
  await expect.poll(() => reconnects).toBe(1);
  expect(postObservation).toEqual({ label: 'Reconnecting tunnel', opacity: '1', nestedNoticeCount: 0, noticeCount: 0 });
  await expect(tunnelPage.locator('.tunnel-health-notice')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Cloudflare setup' })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Restart pending' })).toHaveCount(0);

  // accepted work remains covered until a later health snapshot verifies recovery
  await expect(tunnelPage).toBeVisible();
  health = { ...healthy, checkedAt: '2026-10-28T22:00:01.000Z', lastHealthyAt: '2026-10-28T22:00:01.000Z' };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  await expect(page.getByRole('alert', { name: 'Tunnel degraded' })).toHaveCount(0);

  // a later total outage uses cached managed-tunnel capability without a toast card
  offline = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();
  const recovery = overlay.getByRole('group', { name: 'Public connection lost' });
  await expect(recovery.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  await expect(overlay.locator('.tunnel-health-notice')).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Reconnecting tunnel' })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' }).getByRole('group', { name: 'Public connection lost' })).toContainText('Try again from the local RAC address.');
  expect(reconnects).toBe(1);
});
