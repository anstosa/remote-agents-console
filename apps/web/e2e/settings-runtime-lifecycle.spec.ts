import { expect, test, type Page } from '@playwright/test';
import type { SettingsStatus } from '../src/settings/contracts.js';

// create one active restart status with distinct recovery guidance
function runningStatus(id: string, phase: string, recoveryCommand: string): SettingsStatus {
  return {
    pending: true,
    targets: ['rac'],
    effective: 'unknown',
    restartAvailable: true,
    operation: { id, state: 'running', phase, restart: { state: 'restarting', recoveryDeadline: Date.now() + 60_000 } },
    recoveryCommand
  };
}

// create one freshly proved terminal restart status
function terminalStatus(id: string): SettingsStatus {
  return {
    pending: false,
    targets: [],
    effective: 'known',
    restartAvailable: true,
    operation: { id, state: 'complete', phase: 'Restart complete', restart: { state: 'restarted', recoveryDeadline: Date.now() } }
  };
}

// mount the isolated production provider and action loader
async function mountRuntime(page: Page, reducedMotion = true) {
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  // keep the detached application root unauthenticated and free of dashboard portals
  await page.route('**/api/auth/session', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.route('**/api/auth/bootstrap', route => route.fulfill({ json: { csrfToken: 'fixture-csrf' } }));
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true } }));
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderSettingsRuntimeFixture } = await import('/e2e/settings-runtime-fixture.tsx');
    const root = document.createElement('div');
    root.id = 'root';
    document.body.replaceChildren(root);
    renderSettingsRuntimeFixture(root);
  });
  await expect(page.getByRole('region', { name: 'Settings runtime lifecycle' })).toBeVisible();
}

// read current fixture facts without interacting with the inert application root
const runtimeSnapshot = (page: Page) => page.evaluate(async () => {
  const { readRuntimeSnapshot } = await import('/e2e/settings-runtime-fixture.tsx');
  return readRuntimeSnapshot();
});

test('an old authenticated restart cannot repaint or unlock a newer restart', async ({ page }) => {
  await mountRuntime(page);
  const first = await page.evaluate(async () => {
    const { startRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    return startRuntimeRestart();
  });
  await expect.poll(async () => (await runtimeSnapshot(page)).postCount).toBe(1);
  await expect(page.getByRole('alert', { name: 'Preparing restart' })).toBeVisible();

  // authentication loss drops the old cover and retires its held attempt
  await page.evaluate(async () => {
    const { setRuntimeEnabled } = await import('/e2e/settings-runtime-fixture.tsx');
    await setRuntimeEnabled(false);
  });
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  await expect.poll(async () => (await runtimeSnapshot(page)).enabled).toBe(false);

  // a new authenticated session may own a fresh restart
  await page.evaluate(async () => {
    const { setRuntimeEnabled } = await import('/e2e/settings-runtime-fixture.tsx');
    await setRuntimeEnabled(true);
  });
  const second = await page.evaluate(async () => {
    const { startRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    return startRuntimeRestart();
  });
  await expect.poll(async () => (await runtimeSnapshot(page)).postCount).toBe(2);
  await expect(page.getByRole('alert', { name: 'Preparing restart' })).toBeVisible();

  // the old response cannot restore its phase, recovery command, or release the new lock
  const stale = runningStatus('old-restart', 'STALE OLD PHASE', 'old-recovery-command');
  await page.evaluate(async ({ first, stale }) => {
    const { resolveRuntimePost, waitRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    resolveRuntimePost(first, stale);
    await waitRuntimeRestart(first);
  }, { first, stale });
  await expect(page.getByRole('alert', { name: 'Preparing restart' })).toBeVisible();
  await expect(page.getByText('STALE OLD PHASE')).toHaveCount(0);
  await expect(page.getByText(/old-recovery-command/u)).toHaveCount(0);
  expect((await runtimeSnapshot(page)).status?.operation).toBeUndefined();
  await page.evaluate(async () => {
    const { startRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    startRuntimeRestart();
  });
  await expect.poll(async () => (await runtimeSnapshot(page)).postCount).toBe(2);

  // only the new response and a fresh terminal status may clear its cover
  const running = runningStatus('new-restart', 'Restarting current session', 'new-recovery-command');
  await page.evaluate(async ({ second, running }) => {
    const { resolveRuntimePost, waitRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    resolveRuntimePost(second, running);
    await waitRuntimeRestart(second);
  }, { second, running });
  await expect(page.getByRole('alert', { name: 'Restarting server' })).toBeVisible();
  const terminal = terminalStatus('new-restart');
  await page.evaluate(async terminal => {
    const { refreshRuntimeStatus, setRuntimeServerStatus } = await import('/e2e/settings-runtime-fixture.tsx');
    setRuntimeServerStatus(terminal);
    await refreshRuntimeStatus();
  }, terminal);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  await expect.poll(async () => (await runtimeSnapshot(page)).action).toBeUndefined();
});

test('control changes cancel only pre-submit restarts and retain submitted tracking', async ({ page }) => {
  await mountRuntime(page, false);
  await page.evaluate(async () => {
    const { setRuntimeCanMutate, startRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    startRuntimeRestart();
    await setRuntimeCanMutate(false);
  });

  // losing control during the fade prevents the mutation and releases its cover
  await expect.poll(async () => (await runtimeSnapshot(page)).postCount).toBe(0);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0, { timeout: 2_000 });
  await page.evaluate(async () => {
    const { setRuntimeCanMutate } = await import('/e2e/settings-runtime-fixture.tsx');
    await setRuntimeCanMutate(true);
  });

  // losing control after submission keeps durable restart tracking visible
  const submittedAttempt = await page.evaluate(async () => {
    const { startRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    return startRuntimeRestart();
  });
  await expect.poll(async () => (await runtimeSnapshot(page)).postCount).toBe(1);
  await page.evaluate(async () => {
    const { setRuntimeCanMutate } = await import('/e2e/settings-runtime-fixture.tsx');
    await setRuntimeCanMutate(false);
  });
  await expect(page.getByRole('alert', { name: 'Preparing restart' })).toBeVisible();
  expect((await runtimeSnapshot(page)).action).toBe('restart');

  const running = runningStatus('submitted-restart', 'Restart already submitted', 'submitted-recovery-command');
  const submittedPost = 0;
  await page.evaluate(async ({ submittedAttempt, submittedPost, running }) => {
    const { resolveRuntimePost, waitRuntimeRestart } = await import('/e2e/settings-runtime-fixture.tsx');
    resolveRuntimePost(submittedPost, running);
    await waitRuntimeRestart(submittedAttempt);
  }, { submittedAttempt, submittedPost, running });
  await expect(page.getByRole('alert', { name: 'Restarting server' })).toBeVisible();
  const terminal = terminalStatus('submitted-restart');
  await page.evaluate(async terminal => {
    const { refreshRuntimeStatus, setRuntimeServerStatus } = await import('/e2e/settings-runtime-fixture.tsx');
    setRuntimeServerStatus(terminal);
    await refreshRuntimeStatus();
  }, terminal);
  await expect(page.locator('.fullscreen-loader')).toHaveCount(0);
  expect((await runtimeSnapshot(page)).canMutate).toBe(false);
});
