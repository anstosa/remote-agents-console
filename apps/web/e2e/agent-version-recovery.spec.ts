import { expect, test, type Page } from '@playwright/test';

// isolate version reads from other console requests
async function serveConsole(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // restore a controlled test session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'version-csrf', active: true, deviceName: 'Test device' } });
    // expose one launchable agent without running it
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'codex', origin: 'default' } } });
    // keep background reads outside this regression
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // expose an empty account menu
    if (path === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// recover a failed read without discarding confirmed versions or running an installer
test('retries a failed version check immediately and preserves versions while loading', async ({ page }) => {
  await serveConsole(page);
  let reads = 0;
  let installers = 0;
  let releaseRetry!: () => void;
  const retryFinished = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.clock.install({ time: new Date('2026-11-02T12:00:00-08:00') });
  await page.route('**/api/agents/codex/update', route => { installers += 1; return route.fulfill({ status: 500 }); });
  await page.route('**/api/agents/updates', async route => {
    reads += 1;
    // seed one confirmed available update
    if (reads === 1) return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }] } });
    // reproduce a proxy failure without a json error envelope
    if (reads === 2) return route.fulfill({ status: 524, contentType: 'text/html', body: '<h1>A timeout occurred</h1>' });
    await retryFinished;
    return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false }] } });
  });

  await page.goto('/');
  const launch = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('group', { name: 'Launch agent', exact: true });
  await launch.getByRole('button', { name: /^(?:Choose|Launch) agent/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  const codex = menu.getByRole('group', { name: 'Codex agent', exact: true });
  const version = codex.getByText(/^v1\./u);
  await expect(version).toHaveText('v1.0.0 → v1.1.0');
  await expect(launch).toHaveClass(/updates-available/u);
  await page.clock.fastForward(15 * 60_000);
  await expect(menu.getByRole('alert')).toHaveText('Unable to check agent versions (HTTP 524).');
  await expect(version).toHaveText('v1.0.0 → v1.1.0');
  await expect(launch).toHaveClass(/updates-available/u);
  const retry = menu.getByRole('menuitem', { name: 'Retry version check', exact: true });
  try {
    await retry.click();
    await expect.poll(() => reads).toBe(3);
    await expect(retry).toBeDisabled();
    await expect(menu.locator('.launch-agent-version-skeleton')).toHaveCount(1);
    // a scheduled poll must queue behind the manual retry rather than overlap it
    await page.clock.fastForward(15 * 60_000);
    expect(reads).toBe(3);
  } finally {
    // release the read even when a browser assertion fails
    releaseRetry();
  }
  // release exactly one coalesced poll after the manual request finishes
  await expect.poll(() => reads).toBe(4);
  await expect(version).toHaveText('v1.1.0');
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(launch).not.toHaveClass(/updates-available/u);
  expect({ reads, installers }).toEqual({ reads: 4, installers: 0 });
});

// distinguish invalid snapshots from explicit server failures
test('recovers invalid version responses and preserves explicit server error details', async ({ page }) => {
  await serveConsole(page);
  let reads = 0;
  await page.route('**/api/agents/updates', route => {
    reads += 1;
    // reject a malformed successful response
    if (reads === 1) return route.fulfill({ json: { agents: [{ kind: 'codex', updateAvailable: 'yes' }] } });
    // preserve the server supplied error on retry
    if (reads === 2) return route.fulfill({ status: 503, json: { error: 'Version service unavailable' } });
    return route.fulfill({ json: { agents: [] } });
  });

  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(?:Choose|Launch) agent/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  await expect(menu.getByRole('alert')).toHaveText('Unable to check agent versions: invalid server response.');
  await menu.getByRole('menuitem', { name: 'Retry version check', exact: true }).click();
  await expect(menu.getByRole('alert')).toHaveText('Version service unavailable');
  await menu.getByRole('menuitem', { name: 'Retry version check', exact: true }).click();
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Retry version check', exact: true })).toHaveCount(0);
  expect(reads).toBe(3);
});
