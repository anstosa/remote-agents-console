import { expect, test, type Page } from '@playwright/test';

// isolate update availability from other console requests
async function serveConsole(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // restore a controlling session with one configured agent
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // render the toolbar on an empty workspace
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'codex', origin: 'default' } } });
    // omit extra account entries
    if (path === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    // keep unrelated version reads inert
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // keep unrelated upstream checks inert
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // resolve revision metadata independently
    if (path === '/api/server/revision') return route.fulfill({ json: { sha: '1'.repeat(40), committedAt: '2026-09-06T14:22:31-07:00' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// allow close-related effects to settle without advancing the polling interval
const settleFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('opening and reopening the server flyout checks upstream availability', async ({ page }) => {
  await serveConsole(page);
  let reads = 0;
  await page.route('**/api/server/update-available', route => {
    reads += 1;
    // discover availability only on the first opening
    return route.fulfill({ json: { available: reads === 2, commitCount: reads === 2 ? 1 : 0, targetSha: '2'.repeat(40) } });
  });
  const initial = page.waitForResponse('**/api/server/update-available');
  await page.goto('/');
  await (await initial).finished();
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName('Switch server (Test server)');
  expect(reads).toBe(1);

  // opening finds an update without advancing the polling interval
  await selector.click();
  const details = page.getByRole('group', { name: 'Current server details' });
  await expect(details.getByText('Update available', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'View upstream update' })).toBeVisible();
  expect(reads).toBe(2);

  // closing does not check again
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await settleFrames(page);
  expect(reads).toBe(2);

  // reopening clears the previous availability badge using the fresh result
  await selector.click();
  await expect(details.getByText('Up to date', { exact: true })).toBeVisible();
  await expect(selector).toHaveAccessibleName('Switch server (Test server)');
  await expect(details.getByRole('button', { name: 'View upstream update' })).toHaveCount(0);
  expect(reads).toBe(3);
});

// exercise both controls that display agent versions
for (const width of [1280, 390]) {
  test(`opening and reopening the agent flyout bypasses cached agent versions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await serveConsole(page);
    const refreshes: Array<string | null> = [];
    await page.route(url => url.pathname === '/api/agents/updates', route => {
      refreshes.push(new URL(route.request().url()).searchParams.get('refresh'));
      const reads = refreshes.length;
      // simulate a newly published version and a subsequent installation
      return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: reads === 3 ? '1.1.0' : '1.0.0', latestVersion: reads === 1 ? '1.0.0' : '1.1.0', updateAvailable: reads === 2 }] } });
    });
    const initial = page.waitForResponse('**/api/agents/updates');
    await page.goto('/');
    await (await initial).finished();
    const chooser = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(?:Choose|Launch) agent(?: — update available)?$/u });
    await expect(chooser).toBeVisible();
    expect(refreshes).toEqual([null]);

    // opening reads current upstream versions instead of the cached startup result
    await chooser.click();
    const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
    const codex = menu.getByRole('group', { name: 'Codex agent' });
    await expect(codex.locator('.launch-agent-version')).toHaveText('v1.0.0 → v1.1.0');
    await expect(chooser).toHaveAccessibleName(/update available$/u);
    expect(refreshes).toEqual([null, 'true']);

    // closing does not start another provider check
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await settleFrames(page);
    expect(refreshes).toEqual([null, 'true']);

    // reopening replaces the old available update with the newly installed version
    await chooser.click();
    await expect(codex.locator('.launch-agent-version')).toHaveText('v1.1.0');
    await expect(chooser).toHaveAccessibleName(/^(?:Choose|Launch) agent$/u);
    expect(refreshes).toEqual([null, 'true', 'true']);
  });
}

// share one pending ordinary read and retain its confirmed evidence on a later failure
test('server flyout opening coalesces behind an outstanding availability check', async ({ page }) => {
  await serveConsole(page);
  let reads = 0;
  let releaseInitial!: () => void;
  const held = new Promise<void>(resolve => { releaseInitial = resolve; });
  await page.route('**/api/server/update-available', async route => {
    reads += 1;
    // hold the startup check while the selector is opened repeatedly
    if (reads === 1) {
      await held;
      return route.fulfill({ json: { available: true, commitCount: 1, targetSha: '3'.repeat(40) } });
    }
    // fail the queued refresh without replacing the last confirmed availability
    if (reads === 2) return route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } });
    return route.fulfill({ json: { available: false, commitCount: 0, targetSha: '3'.repeat(40) } });
  });
  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const details = page.getByRole('group', { name: 'Current server details' });
  try {
    await expect.poll(() => reads).toBe(1);
    await selector.click();
    await expect(details).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await selector.click();
    await expect(details).toBeVisible();
    // coalesce a visibility-triggered check with both opening intents
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await settleFrames(page);
    // no concurrent request even with more than one opening intent
    expect(reads).toBe(1);
  } finally {
    // always let the held request finish
    releaseInitial();
  }
  await expect.poll(() => reads).toBe(2);
  await expect(details.getByText('Update available', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await settleFrames(page);
  expect(reads).toBe(2);
  await selector.click();
  await expect(details.getByText('Up to date', { exact: true })).toBeVisible();
  expect(reads).toBe(3);
});

// retain a queued forced intent even when a scheduled check is requested later
test('agent flyout queues a forced check behind a pending provider read', async ({ page }) => {
  await serveConsole(page);
  await page.clock.install();
  const refreshes: Array<string | null> = [];
  let releaseInitial!: () => void;
  const held = new Promise<void>(resolve => { releaseInitial = resolve; });
  await page.route(url => url.pathname === '/api/agents/updates', async route => {
    refreshes.push(new URL(route.request().url()).searchParams.get('refresh'));
    // retain the initial provider read until the scheduled intent arrives
    if (refreshes.length === 1) await held;
    return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }] } });
  });
  await page.goto('/');
  const chooser = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(?:Choose|Launch) agent/u });
  try {
    await expect.poll(() => refreshes.length).toBe(1);
    await chooser.click();
    await expect(page.getByRole('status', { name: 'Loading Codex version' })).toBeVisible();
    await page.clock.fastForward(15 * 60_000);
    expect(refreshes).toEqual([null]);
  } finally {
    // release the first read even if the queued-state assertions fail
    releaseInitial();
  }
  await expect(chooser).toHaveAccessibleName(/update available$/u);
  expect(refreshes).toEqual([null, 'true']);
});
