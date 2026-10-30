import { expect, test, type Page } from '@playwright/test';
import { latestCompletedAssistantMessage } from '../../server/src/adapters/codex-turns.js';
import { installPaneMock, paneInputList, pushBytes, pushMetadata, pushQuestion } from './pane-stream-mock';

// open the reviewed host update from the current server submenu
const openUpstreamUpdate = async (page: Page) => {
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available/u);
  await selector.click();
  const server = page.getByRole('group', { name: 'Current server details' });
  await server.getByRole('button', { name: 'View upstream update' }).click();
};

// let React consume one completed mock response and paint its resulting state
const settleBrowserFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// use semantic skeletons for version metadata reads without borrowing mutation rings
test('skeletonizes agent and server versions while their reads are pending', async ({ page }) => {
  let releaseAgents!: () => void;
  let releaseRevision!: () => void;
  const agentsFinished = new Promise<void>(resolve => { releaseAgents = resolve; });
  const revisionFinished = new Promise<void>(resolve => { releaseRevision = resolve; });
  const revisionSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session and named server
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // expose one configured agent kind
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'codex', origin: 'default' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    // hold the background provider version read
    if (url.pathname === '/api/agents/updates') {
      await agentsFinished;
      return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.154.0', updateAvailable: true }] } });
    }
    // hold the server revision read opened from its selector
    if (url.pathname === '/api/server/revision') {
      await revisionFinished;
      return route.fulfill({ json: { sha: revisionSha, committedAt: '2026-09-06T14:22:31-07:00' } });
    }
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(Choose agent|Launch agent)$/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  const codex = menu.getByRole('group', { name: 'Codex agent' });
  try {
    await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(1);
    await expect(codex.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  } finally {
    // release the provider read during failed assertions too
    releaseAgents();
  }
  await expect(codex.locator('.launch-agent-version')).toHaveText('v0.153.2 → v0.154.0');
  await page.keyboard.press('Escape');

  const selector = page.getByRole('button', { name: /^Switch server/u });
  await selector.click();
  const server = page.getByRole('group', { name: 'Current server details' });
  try {
    await expect(server.getByLabel('Loading server revision')).toBeVisible();
    await expect(server.locator('.server-menu-revision-skeleton .skeleton')).toHaveCount(2);
    await expect(server.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await server.locator('.server-menu-revision-skeleton').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  } finally {
    // release the revision read during failed assertions too
    releaseRevision();
  }
  await expect(server.getByText(revisionSha.slice(0, 7))).toBeVisible();
});

// serialize periodic version reads and publish only the newest scheduled result
test('coalesces agent-version polling without publishing stale or failed snapshots', async ({ page }) => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let releaseFailure!: () => void;
  let updateReads = 0;
  const firstFinished = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondFinished = new Promise<void>(resolve => { releaseSecond = resolve; });
  const failureFinished = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.clock.install({ time: new Date('2026-10-29T12:00:00-07:00') });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one configured agent kind
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], scratchLaunch: { kind: 'codex', origin: 'default' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    if (url.pathname === '/api/agents/updates') {
      updateReads += 1;
      // hold each scheduled owner independently
      if (updateReads === 1) {
        await firstFinished;
        return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '0.150.0', latestVersion: '0.150.0', updateAvailable: false }] } });
      }
      if (updateReads === 2) {
        await secondFinished;
        return route.fulfill({ json: { agents: [{ kind: 'codex', currentVersion: '0.154.0', latestVersion: '0.155.0', updateAvailable: true }] } });
      }
      await failureFinished;
      return route.fulfill({ status: 503, json: { error: 'version provider unavailable' } });
    }
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(Choose agent|Launch agent)$/u }).click();
  const codex = page.getByRole('menu', { name: 'Choose agent', exact: true }).getByRole('group', { name: 'Codex agent' });
  await expect.poll(() => updateReads).toBe(1);
  await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(1);

  await page.clock.fastForward(15 * 60 * 1_000);
  expect(updateReads).toBe(1);
  releaseFirst();
  await expect.poll(() => updateReads).toBe(2);
  await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(1);
  await expect(codex).not.toContainText('v0.150.0');
  releaseSecond();
  await expect(codex.locator('.launch-agent-version')).toHaveText('v0.154.0 → v0.155.0');
  await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(0);

  await page.clock.fastForward(15 * 60 * 1_000);
  await expect.poll(() => updateReads).toBe(3);
  await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(1);
  releaseFailure();
  await expect(codex.locator('.launch-agent-version-skeleton')).toHaveCount(0);
  await expect(codex.locator('.launch-agent-version')).toHaveText('v0.154.0 → v0.155.0');
});

// reserve commit cards while the reviewed host update range is loading
test('shows commit skeleton cards while loading an update preview', async ({ page }) => {
  let releasePreview!: () => void;
  const previewFinished = new Promise<void>(resolve => { releasePreview = resolve; });
  const targetSha = '2'.repeat(40);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session and named server
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: '1'.repeat(40), committedAt: '2026-09-06T14:22:31-07:00' } });
    // hold the exact update range read
    if (url.pathname === '/api/server/update-preview') {
      await previewFinished;
      return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Add safer update review', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openUpstreamUpdate(page);
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  try {
    await expect(dialog.getByRole('status', { name: 'Loading commits' })).toBeVisible();
    await expect(dialog.locator('.commit-skeleton')).toHaveCount(3);
    await expect(dialog.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  } finally {
    // release the preview read during failed assertions too
    releasePreview();
  }
  await expect(dialog.getByText('Add safer update review')).toBeVisible();
  await expect(dialog.locator('.commit-skeleton')).toHaveCount(0);
});

test('keeps the embedded update advisor out of the main agent tabs', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one normal agent beside one recovered update advisor
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', queuedPromptCount: 0 }, { id: 'update-advisor', sessionId: 'socket:$2', home: '/workspace', displayLabel: 'Update Advisor v4 3333333', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    // keep the host repository current
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // authorize the visible agent output
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty visible-agent stores
    if (/^\/api\/agents\/agent-cora\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Cora/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Update Advisor/u })).toHaveCount(0);
});

// keep stale browser assets actionable only from the persistent toast
test('reloads a stale client without adding a settings action or animation', async ({ page }) => {
  let updateStarts = 0;
  let navigations = 0;
  const revisionSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
  const committedAt = '2026-09-06T14:22:31-07:00';
  // count full-page reloads
  page.on('framenavigated', frame => {
    // ignore child-frame navigation
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render the empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // report a newer browser bundle
    if (url.pathname === '/api/ui-version') return route.fulfill({ json: { version: '/assets/index-new.js' } });
    // keep the host repository current
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // publish deployed server metadata
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: revisionSha, committedAt } });
    // flag accidental host mutations
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const notification = page.getByRole('status', { name: 'UI update available' });
  await expect(notification).toBeVisible();
  const reload = notification.getByRole('button', { name: 'Reload UI' });
  await expect(reload).toBeVisible();
  const initialNavigations = navigations;
  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('button', { name: 'Reload local update' })).toHaveCount(0);
  await expect(tabs.getByRole('button', { name: 'View upstream update' })).toHaveCount(0);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await selector.click();
  const server = page.getByRole('group', { name: 'Current server details' });
  await expect(server.getByText(revisionSha.slice(0, 7))).toBeVisible();
  await expect(server.locator('time')).toHaveAttribute('datetime', committedAt);
  await expect(server.getByRole('button', { name: 'Rename Server' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Remote Agents servers' })).toHaveCount(0);
  const settingsTrigger = page.getByRole('button', { name: /^Global settings/u });
  await expect(settingsTrigger).toHaveAccessibleName('Global settings');
  // keep the entire settings control free of update animations
  expect(await settingsTrigger.evaluate(button => button.getAnimations({ subtree: true }).length)).toBe(0);
  await settingsTrigger.click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('group', { name: 'Server' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /reload/iu })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Rename browser name' }).click({ trial: true });
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await reload.click();

  await expect.poll(() => navigations).toBeGreaterThan(initialNavigations);
  expect(updateStarts).toBe(0);
});

// review commits before explicitly starting a host update
test('opens the commit review before starting and retains update failures in the modal', async ({ page }) => {
  let updateStarts = 0;
  let updateStatusChecks = 0;
  let updateState: 'running'|'failed' = 'running';
  let advisorLaunches = 0;
  const targetSha = '2'.repeat(40);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render one stable agent tab
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // preview one exact fast-forward update
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Add safer update review', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } });
    // reject unexpected advisor launches
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunches += 1;
      return route.fulfill({ status: 500, json: { error: 'unexpected advisor launch' } });
    }
    // start one host update
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // follow one host update while hidden
    if (url.pathname === '/api/server/update/server_update_operation_1234') {
      updateStatusChecks += 1;
      return route.fulfill({ json: { id: 'server_update_operation_1234', kind: 'update', state: updateState } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent output
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt stores
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available$/u);
  await expect(selector.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await openUpstreamUpdate(page);

  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Add safer update review')).toBeVisible();
  await expect(selector).toHaveAccessibleName(/update review open$/u);
  const progressRing = selector.locator(':scope > .update-progress-ring');
  await expect(progressRing).toBeVisible();
  await expect.poll(() => selector.evaluate(element => element.getAnimations().length)).toBe(0);
  const selectorGraphics = selector.locator(':scope > img, :scope > svg');
  await expect(selectorGraphics).toHaveCount(2);
  await expect.poll(() => selectorGraphics.evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBe(true);
  expect(advisorLaunches).toBe(0);
  expect(updateStarts).toBe(0);
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(update).toBeEnabled();
  await update.click();
  await expect.poll(() => updateStarts).toBe(1);
  await expect(dialog.getByText('Pulling the reviewed revision, rebuilding, and restarting…')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close server update' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Minimize server update' }).click();
  await expect(dialog).toBeHidden();
  await expect(selector).toHaveAccessibleName(/update review minimized$/u);
  await expect(progressRing).toBeVisible();
  const visibleStatusChecks = updateStatusChecks;
  await expect.poll(() => updateStatusChecks).toBeGreaterThan(visibleStatusChecks);
  await expect(selector).toBeFocused();
  await expect(selector).toHaveAccessibleName(/update review minimized$/u);
  await selector.click();
  const reopen = page.getByRole('group', { name: 'Current server details' }).getByRole('button', { name: 'Reopen server update' });
  await reopen.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(selector).toHaveAccessibleName(/update review open$/u);
  await expect(dialog.getByRole('button', { name: 'Close server update' })).toBeDisabled();
  expect(updateStarts).toBe(1);
  updateState = 'failed';
  await expect(dialog.getByRole('status').filter({ hasText: 'Update failed. Check the server update log.' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close server update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(selector.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(selector).toHaveAccessibleName(/update available$/u);
});

// embed migration advice and require explicit acknowledgement
test('opens an advisor for flagged update paths before enabling Update', async ({ page }) => {
  const targetSha = '3'.repeat(40);
  // parse the current Codex completion footer through the production handoff
  const completedResponse = latestCompletedAssistantMessage(`• No host migration is required for this update.\n\n\x1b[2m  Worked for 5m 29s • 08:01\x1b[0m`)?.text ?? '';
  let advisorLaunched = false;
  let advisorStops = 0;
  const advisorAnswers: Array<{ questionId?: string; index?: number }> = [];
  await page.setViewportSize({ width: 430, height: 932 });
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // reveal the dedicated advisor after launch
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: advisorLaunched ? 2 : 1, agents: advisorLaunched ? [{ id: 'update-advisor', sessionId: 'socket:$2', home: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: 'Ready', queuedPromptCount: 0 }] : [], projects: [] } });
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // preview one flagged configuration change
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Change server configuration', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } } });
    // launch one pre-prompted advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunched = true;
      return route.fulfill({ status: 201, json: { agentId: 'update-advisor', targetSha } });
    }
    // stop the modal-owned advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'DELETE') {
      advisorStops += 1;
      advisorLaunched = false;
      return route.fulfill({ status: 204 });
    }
    // authorize advisor output
    if (url.pathname === '/api/agents/update-advisor/tickets') return route.fulfill({ json: { ticket: 'advisor-ticket' } });
    // accept one advisor follow-up
    if (url.pathname === '/api/agents/update-advisor/prompt' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'queued' } });
    // capture one approval that arrives before the follow-up response
    if (url.pathname === '/api/agents/update-advisor/question' && request.method() === 'POST') {
      advisorAnswers.push(await request.postDataJSON() as { questionId?: string; index?: number });
      return route.fulfill({ status: 204 });
    }
    // return empty prompt stores for the background agent tab
    if (/^\/api\/agents\/update-advisor\/(?:saved-prompts|prompt-history|queued-prompts|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openUpstreamUpdate(page);
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Change server configuration')).toBeVisible();
  await expect(dialog.getByText('.env.example')).toBeVisible();
  const output = dialog.getByLabel('Update advisor output');
  await expect(output).toBeVisible();
  // do not advertise completion until the advisor publishes reviewable guidance
  await expect(dialog.locator('.update-advisor-state')).toHaveText('Reviewing');
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  await expect(dialog.getByLabel('Approval or feedback')).toBeDisabled();
  // the advisor's pane streams inside a narrow modal: let the terminal measure its own grid
  // (the mock echoes its viewport back as the size) rather than forcing a wide one that would
  // overflow, then paint the reviewed output and publish the response the feedback form gates on
  await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
  // A few blank rows first so the selectable row clears the top-left status badge (the stream
  // writes top-down), then the timestamped completion footer emitted by current Codex clients.
  await pushBytes(page, 'update-advisor', '\r\n\r\n\r\nReview complete\r\n\x1b[2m  Worked for 5m 29s • 08:01\x1b[0m\r\n');
  // visible completion text cannot bypass the parsed response handoff
  await expect(dialog.locator('.update-advisor-state')).toHaveText('Reviewing');
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  await expect(dialog.getByLabel('Approval or feedback')).toBeDisabled();
  // publish the response after the server recognizes the completion footer
  await pushMetadata(page, 'update-advisor', completedResponse);
  const outputBounds = await output.evaluate(element => {
    const output = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
    return { outputRight: output.right, outputBottom: output.bottom, screenRight: screen.right, screenBottom: screen.bottom };
  });
  expect(outputBounds.screenRight).toBeLessThanOrEqual(outputBounds.outputRight + 1);
  expect(outputBounds.screenBottom).toBeLessThanOrEqual(outputBounds.outputBottom + 1);
  // double-click the reviewed word to select it (a pixel drag is unreliable in the narrow modal)
  const selectedRow = output.locator('.xterm-rows > div', { hasText: 'Review complete' });
  const selectedRowBounds = await selectedRow.boundingBox();
  expect(selectedRowBounds).not.toBeNull();
  await page.mouse.dblclick(selectedRowBounds!.x + selectedRowBounds!.width * 0.2, selectedRowBounds!.y + selectedRowBounds!.height / 2);
  const selectionToolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(output.locator('.log-output')).toHaveClass(/selection-active/u);
  await expect(selectionToolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Add to prompt' })).toHaveCount(0);
  await output.getByLabel('Live log').click({ position: { x: 180, y: 80 } });
  await expect(selectionToolbar).toHaveCount(0);
  await pushBytes(page, 'update-advisor', 'src/host-update.ts\r\nhttps://example.com/advisor\r\n');
  // embedded advisor output keeps web links but does not invent a file-opening capability
  await expect(output.getByRole('link', { name: 'Open https://example.com/advisor', exact: true })).toHaveCount(1);
  await expect(output.getByRole('link', { name: 'Preview src/host-update.ts', exact: true })).toHaveCount(0);
  await expect(output.locator('.log-output')).toHaveClass(/input-active/u);
  await expect(output.getByLabel('Terminal keys')).toBeVisible();
  // keep the embedded keys on a solid control palette instead of the base gradient
  const advisorKey = output.getByRole('button', { name: 'Ctrl+C' });
  await expect.poll(() => advisorKey.evaluate(element => getComputedStyle(element).backgroundImage)).toBe('none');
  const restingKeyColor = await advisorKey.evaluate(element => getComputedStyle(element).backgroundColor);
  await advisorKey.hover();
  await expect.poll(() => advisorKey.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(restingKeyColor);
  const inputBounds = await output.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
    return { outputRight: bounds.right, outputBottom: bounds.bottom, screenRight: screen.right, screenBottom: screen.bottom };
  });
  expect(inputBounds.screenRight).toBeLessThanOrEqual(inputBounds.outputRight + 1);
  expect(inputBounds.screenBottom).toBeLessThanOrEqual(inputBounds.outputBottom + 1);
  await output.getByRole('button', { name: 'Ctrl+C' }).click();
  // the interrupt reaches the advisor's pane over its own stream, not a separate input socket
  await expect.poll(() => paneInputList(page, 'update-advisor')).toContain('\x03');
  await expect(page.getByRole('tab', { name: /Update Advisor/u })).toHaveCount(0);
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  // Move focus out of the pane before acknowledging: a focused xterm swallows the first click
  // that lands outside it, and an operator acknowledging is not mid-keystroke in the terminal.
  await dialog.getByRole('heading', { name: 'Host changes need review' }).click();
  await dialog.getByRole('checkbox').check();
  await expect(update).toBeEnabled();
  await dialog.getByLabel('Approval or feedback').fill('Double-check the rollback steps.');
  await expect(output.locator('.log-output')).not.toHaveClass(/input-active/u);
  await expect(output.getByLabel('Terminal keys')).toBeHidden();
  // return the embedded advisor to its tail without losing unsent feedback or focus
  await settleBrowserFrames(page);
  const advisorCols = Number(await output.getByLabel('Live log').getAttribute('data-cols'));
  const returnLabel = '↓ Back to bottom · esc';
  const returnPadding = ' '.repeat(Math.floor((advisorCols - returnLabel.length) / 2));
  await pushBytes(page, 'update-advisor', `\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[7;1H${returnPadding}${returnLabel}\x1b[8;1H> pending draft`);
  const advisorJump = output.getByRole('button', { name: 'Jump to latest' });
  await expect(advisorJump).toBeVisible();
  const beforeAdvisorJump = await paneInputList(page, 'update-advisor');
  await advisorJump.click();
  await expect.poll(() => paneInputList(page, 'update-advisor')).toEqual([...beforeAdvisorJump, '\x1b[1;5F']);
  await expect(dialog.getByLabel('Approval or feedback')).toBeFocused();
  await expect(dialog.getByLabel('Approval or feedback')).toHaveValue('Double-check the rollback steps.');
  // codex's redraw removes the return affordance after reaching the tail
  await pushBytes(page, 'update-advisor', '\x1b[7;1H\x1b[2K');
  await expect(advisorJump).toBeHidden();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  await expect(dialog.getByLabel('Approval or feedback')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  // show a streamed approval even though the prior completed metadata is still the baseline
  const followupApproval = { id: 'followup-approval', text: 'Approve the reviewed host action?', choices: ['Approve', 'Cancel'], source: 'parsed' as const };
  await pushQuestion(page, 'update-advisor', followupApproval);
  await expect(dialog.getByText(followupApproval.text)).toBeVisible();
  await expect(dialog.locator('.update-advisor-state')).toHaveText('Needs input');
  await expect(dialog.getByLabel('Approval or feedback')).toBeEnabled();
  await dialog.getByRole('button', { name: /Approve/u }).click();
  await expect.poll(() => advisorAnswers).toHaveLength(1);
  expect(advisorAnswers[0]).toEqual({ questionId: followupApproval.id, index: 0 });
  await expect(dialog.getByText(followupApproval.text)).toHaveCount(0);
  // ignore the prior response when a stale frame is replayed
  await pushMetadata(page, 'update-advisor', 'No host migration is required for this update.');
  await settleBrowserFrames(page);
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  // unlock review only after a new response arrives
  await pushMetadata(page, 'update-advisor', 'Rollback steps were double-checked; no migration is required.');
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close server update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Switch server/u })).toBeFocused();
  await expect.poll(() => advisorStops).toBe(1);
});

// keep approval questions interactive before the advisor publishes a completed response
test('shows and answers advisor questions while completed guidance is pending', async ({ page }) => {
  const targetSha = '5'.repeat(40);
  const initialQuestion = { id: 'initial-approval', text: 'Confirm the deployment window.', choices: ['Proceed', 'Wait'], source: 'structured' as const };
  const dashboardFollowup = { id: 'dashboard-followup', text: 'Use the existing host override?', choices: ['Continue', 'Stop'], source: 'structured' as const };
  const streamFollowup = { id: 'stream-followup', text: 'Approve the final host action?', choices: ['Approve', 'Cancel'], source: 'parsed' as const };
  let advisorLaunched = false;
  let dashboardQuestion: typeof initialQuestion | typeof dashboardFollowup | undefined = initialQuestion;
  let dashboardRequests = 0;
  let promptSubmissions = 0;
  const questionAnswers: Array<{ questionId?: string; index?: number; text?: string }> = [];
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish current advisor state and any server-derived question
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      const agents = advisorLaunched ? [{ id: 'update-advisor', sessionId: 'socket:$2', home: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: dashboardQuestion === undefined ? 'Ready' : 'Question', attention: dashboardQuestion === undefined ? undefined : 'question', question: dashboardQuestion, queuedPromptCount: 0 }] : [];
      return route.fulfill({ json: { generation: 1, agents, projects: [] } });
    }
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // preview one flagged configuration change
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Change server configuration', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } } });
    // launch one pre-prompted advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunched = true;
      return route.fulfill({ status: 201, json: { agentId: 'update-advisor', targetSha } });
    }
    // authorize advisor output
    if (url.pathname === '/api/agents/update-advisor/tickets') return route.fulfill({ json: { ticket: 'advisor-ticket' } });
    // capture question answers independently from queued prompts
    if (url.pathname === '/api/agents/update-advisor/question' && request.method() === 'POST') {
      questionAnswers.push(await request.postDataJSON() as { questionId?: string; index?: number; text?: string });
      return route.fulfill({ status: 204 });
    }
    // flag accidental prompt submissions while a question is open
    if (url.pathname === '/api/agents/update-advisor/prompt' && request.method() === 'POST') {
      promptSubmissions += 1;
      return route.fulfill({ status: 202, json: { status: 'queued' } });
    }
    // return empty prompt stores for the background agent tab
    if (/^\/api\/agents\/update-advisor\/(?:saved-prompts|prompt-history|queued-prompts|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openUpstreamUpdate(page);
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  const advisorState = dialog.locator('.update-advisor-state');
  const feedback = dialog.getByLabel('Approval or feedback');
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(dialog.getByText(initialQuestion.text)).toBeVisible();
  await expect(advisorState).toHaveText('Needs input');
  await expect(feedback).toBeEnabled();
  await expect(feedback).toHaveAttribute('placeholder', 'Reply to the advisor…');
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);

  const paneInputsBeforeAnswer = await paneInputList(page, 'update-advisor');
  await feedback.fill('Proceed after the maintenance notice.');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => questionAnswers).toHaveLength(1);
  expect(questionAnswers[0]).toEqual({ questionId: initialQuestion.id, text: 'Proceed after the maintenance notice.' });
  expect(promptSubmissions).toBe(0);
  await expect(dialog.getByText(initialQuestion.text)).toHaveCount(0);
  // suppress the answered dashboard frame without opening an unsafe raw-input fallback
  const initialReplayRequest = dashboardRequests;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(initialReplayRequest);
  await settleBrowserFrames(page);
  await expect(dialog.getByText(initialQuestion.text)).toHaveCount(0);
  await expect(advisorState).toHaveText('Reviewing');
  await expect(feedback).toBeDisabled();
  expect(await paneInputList(page, 'update-advisor')).toEqual(paneInputsBeforeAnswer);

  // clear both question sources before accepting the same question id as a new turn
  const clearedDashboardRequest = dashboardRequests;
  dashboardQuestion = undefined;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(clearedDashboardRequest);
  await pushQuestion(page, 'update-advisor', null);
  await settleBrowserFrames(page);
  const repeatedDashboardRequest = dashboardRequests;
  dashboardQuestion = initialQuestion;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(repeatedDashboardRequest);
  await pushQuestion(page, 'update-advisor', initialQuestion);
  await expect(dialog.getByText(initialQuestion.text)).toBeVisible();
  await dialog.getByRole('button', { name: /Proceed/u }).click();
  await expect.poll(() => questionAnswers).toHaveLength(2);
  expect(questionAnswers[1]).toEqual({ questionId: initialQuestion.id, index: 0 });

  dashboardQuestion = dashboardFollowup;
  await expect(dialog.getByText(dashboardFollowup.text)).toBeVisible();
  await expect(advisorState).toHaveText('Needs input');
  await dialog.getByRole('button', { name: /Continue/u }).click();
  await expect.poll(() => questionAnswers).toHaveLength(3);
  expect(questionAnswers[2]).toEqual({ questionId: dashboardFollowup.id, index: 0 });
  const followupReplayRequest = dashboardRequests;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(followupReplayRequest);
  await settleBrowserFrames(page);
  await expect(dialog.getByText(dashboardFollowup.text)).toHaveCount(0);

  // move the next question to the stream after explicit source gaps
  const streamGapDashboardRequest = dashboardRequests;
  dashboardQuestion = undefined;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(streamGapDashboardRequest);
  await pushQuestion(page, 'update-advisor', null);
  await pushQuestion(page, 'update-advisor', streamFollowup);
  await expect(dialog.getByText(streamFollowup.text)).toBeVisible();
  await expect(feedback).toBeEnabled();
  await dialog.getByRole('button', { name: /Approve/u }).click();
  await expect.poll(() => questionAnswers).toHaveLength(4);
  expect(questionAnswers[3]).toEqual({ questionId: streamFollowup.id, index: 0 });
  expect(promptSubmissions).toBe(0);
  await expect(dialog.getByText(streamFollowup.text)).toHaveCount(0);
  // ignore a replayed stream frame for the answered question
  await pushQuestion(page, 'update-advisor', streamFollowup);
  await settleBrowserFrames(page);
  await expect(dialog.getByText(streamFollowup.text)).toHaveCount(0);

  // unlock acknowledgement only after fresh metadata completes the pending turn
  const readyDashboardRequest = dashboardRequests;
  dashboardQuestion = undefined;
  await expect.poll(() => dashboardRequests).toBeGreaterThan(readyDashboardRequest);
  await expect(advisorState).toHaveText('Reviewing');
  await pushMetadata(page, 'update-advisor', 'All requested host approvals are complete.');
  await pushQuestion(page, 'update-advisor', null);
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  await expect(advisorState).toHaveText('Ready');
  await expect(update).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(update).toBeEnabled();
});

// exercise both advisor request endpoints against the same response-before-HTTP race
for (const requestKind of ['question', 'prompt'] as const) {
  test(`retains fresh advisor metadata received while ${requestKind} submission is pending`, async ({ page }) => {
    const targetSha = '6'.repeat(40);
    const approvalQuestion = { id: 'race-approval', text: 'Approve this host action?', choices: ['Approve', 'Cancel'], source: 'structured' as const };
    let advisorLaunched = false;
    let dashboardQuestion = requestKind === 'question' ? approvalQuestion : undefined;
    let dashboardRequests = 0;
    let requestStarted = false;
    let releaseRequest!: () => void;
    const heldRequest = new Promise<void>(resolve => { releaseRequest = resolve; });
    await installPaneMock(page);
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      // restore one controlling session
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      // publish current advisor state and its optional approval
      if (url.pathname === '/api/dashboard') {
        dashboardRequests += 1;
        const agents = advisorLaunched ? [{ id: 'update-advisor', sessionId: 'socket:$2', home: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: dashboardQuestion === undefined ? 'Ready' : 'Question', attention: dashboardQuestion === undefined ? undefined : 'question', question: dashboardQuestion, queuedPromptCount: 0 }] : [];
        return route.fulfill({ json: { generation: dashboardRequests, agents, projects: [] } });
      }
      // report remote commits on main
      if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
      // preview one flagged configuration change
      if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Change server configuration', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } } });
      // launch one pre-prompted advisor
      if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
        advisorLaunched = true;
        return route.fulfill({ status: 201, json: { agentId: 'update-advisor', targetSha } });
      }
      // authorize advisor output
      if (url.pathname === '/api/agents/update-advisor/tickets') return route.fulfill({ json: { ticket: 'advisor-ticket' } });
      // hold the submitted turn until fresh metadata has already arrived
      if (url.pathname === `/api/agents/update-advisor/${requestKind}` && request.method() === 'POST') {
        requestStarted = true;
        await heldRequest;
        return requestKind === 'question' ? route.fulfill({ status: 204 }) : route.fulfill({ status: 202, json: { status: 'queued' } });
      }
      // return empty prompt stores for the background agent tab
      if (/^\/api\/agents\/update-advisor\/(?:saved-prompts|prompt-history|queued-prompts|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
      // disable push enrollment
      if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await page.goto('/');
    await openUpstreamUpdate(page);
    const dialog = page.getByRole('dialog', { name: 'Review update' });
    const output = dialog.getByLabel('Update advisor output');
    const update = dialog.getByRole('button', { name: 'Update', exact: true });
    await expect(output).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
    // establish a completed baseline only for a normal queued prompt
    if (requestKind === 'prompt') {
      await pushMetadata(page, 'update-advisor', 'Initial review complete.');
      await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
      await dialog.getByLabel('Approval or feedback').fill('Check the host action again.');
      await dialog.getByRole('button', { name: 'Send' }).click();
    } else {
      await expect(dialog.getByText(approvalQuestion.text)).toBeVisible();
      await dialog.getByRole('button', { name: /Approve/u }).click();
    }
    await expect.poll(() => requestStarted).toBe(true);

    const readyDashboardRequest = dashboardRequests;
    dashboardQuestion = undefined;
    await expect.poll(() => dashboardRequests).toBeGreaterThan(readyDashboardRequest);
    await pushQuestion(page, 'update-advisor', null);
    await pushMetadata(page, 'update-advisor', 'Fresh guidance arrived before the HTTP response.');
    await settleBrowserFrames(page);
    await expect(update).toBeDisabled();
    await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);

    releaseRequest();
    await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
    await expect(dialog.locator('.update-advisor-state')).toHaveText('Ready');
  });
}

// retry a failed host rebuild after Git already reached the reviewed target
test('reopens a durable rebuild retry after a post-merge failure', async ({ page }) => {
  const targetSha = '4'.repeat(40);
  let retryStarts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render the empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // preserve the update chip for one failed rebuild
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // expose the durable current-target retry
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: false, rebuildRetryAvailable: true, baseSha: targetSha, targetSha, fastForwardable: true, commitCount: 0, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } });
    // accept one pinned rebuild retry
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      retryStarts += 1;
      expect(request.postDataJSON()).toMatchObject({ expectedTargetSha: targetSha });
      return route.fulfill({ status: 202, json: { id: 'server_update_retry_1234', kind: 'update', state: 'queued', targetSha } });
    }
    // keep the retry operation running
    if (url.pathname === '/api/server/update/server_update_retry_1234') return route.fulfill({ json: { id: 'server_update_retry_1234', kind: 'update', state: 'running', targetSha } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await openUpstreamUpdate(page);
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Host rebuild needs another attempt.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry rebuild' }).click();

  await expect.poll(() => retryStarts).toBe(1);
  await expect(dialog.getByText('Pulling the reviewed revision, rebuilding, and restarting…')).toBeVisible();
});
