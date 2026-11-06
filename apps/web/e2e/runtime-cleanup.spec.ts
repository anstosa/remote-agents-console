import { expect, test, type Page } from '@playwright/test';

// retain explicit choices and unresolved rows on desktop and phone
for (const width of [1280, 390]) {
  test(`keeps cleanup in More with persistent choices and quiet badges at ${width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    let submissions = 0;
    let submittedIds: string[] = [];
    let targets = [
      { id: 'worker-1', kind: 'orphan-worker', label: 'Orphan OMX worker', detail: 'worker-2 in tmux session feature-team' },
      { id: 'agent-1', kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old-agent at /worktrees/removed' },
      { id: 'pane-1', kind: 'hud-pane', label: 'HUD watcher', detail: 'hud in tmux session monitoring' },
      { id: 'process-1', kind: 'hud-process', label: 'Detached HUD watcher', detail: 'Host process 4321: omx hud --watch' },
      { id: 'branch-1', kind: 'merged-branch', label: 'feature/done', detail: 'Merged branch in Project' },
      { id: 'closed-branch-1', kind: 'closed-pr-branch', label: 'feature/closed', detail: 'Closed PR (not merged) in Project; deleting this branch discards unmerged work' }
    ];
    await page.addInitScript(() => {
      const notifications: Array<{ options?: NotificationOptions }> = [];
      Object.defineProperty(window, '__testNotifications', { value: notifications });
      class TestNotification { static permission: NotificationPermission = 'granted'; }
      Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
      const registration = { getNotifications: async () => [], showNotification: async (_title: string, options?: NotificationOptions) => { notifications.push({ options }); } };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      // restore a controlling browser and a cached cleanup scan
      if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      if (path === '/api/push/public-key') return route.fulfill({ json: {} });
      if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending: targets.length, cleanupTargets: targets, agents: [{ id: 'current-agent', sessionId: 'socket:$1', home: '/worktrees/current', title: 'Ready' }], projects: [] } });
      if (path === '/api/agents/current-agent/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
      if (path === '/api/agents/current-agent/saved-prompts') return route.fulfill({ json: { prompts: [] } });
      if (path === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ json: { targets } });
      // keep unchecked resources and one failed selection available for retry
      if (path === '/api/cleanup' && request.method() === 'POST') {
        submittedIds = (request.postDataJSON() as { targetIds: string[] }).targetIds;
        submissions += 1;
        targets = targets.filter(target => !submittedIds.includes(target.id) || submissions === 1 && target.id === 'agent-1');
        return route.fulfill({ json: { targets } });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });
    await page.goto('/');
    const more = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' });
    const cleanup = page.locator('.place-menu').getByRole('button', { name: 'Cleanup', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
    // expose counts without opening or scanning the cleanup dialog
    await expect(page.locator('.cleanup-toggle')).toHaveCount(0);
    await expect(more.locator('.cleanup-summary-count')).toHaveText('5');
    await expect(more).toHaveAccessibleDescription('5 checked cleanup items');
    await more.click();
    await expect(cleanup).toBeVisible();
    await expect(cleanup.locator('.cleanup-count.unchecked')).toHaveText('1');
    await expect(cleanup.locator('.cleanup-count.checked')).toHaveText('5');
    await expect(cleanup).toHaveAccessibleDescription('5 checked and 1 unchecked cleanup items');
    await expect(cleanup).toHaveCSS('animation-name', 'none');
    await expect(more.locator('.cleanup-summary-count')).toHaveCSS('animation-name', 'none');
    await cleanup.click();
    const checks = dialog.getByRole('checkbox');
    // inspect durable consent separately from the rendered checkbox state
    const storedChoices = () => page.evaluate(() => JSON.parse(localStorage.getItem('rac.cleanup-choices') ?? '[]'));
    const worker = dialog.locator('label').filter({ hasText: 'Orphan OMX worker' }).getByRole('checkbox');
    const pane = dialog.locator('label').filter({ hasText: 'HUD watcher window' }).getByRole('checkbox');
    const closed = dialog.locator('label').filter({ hasText: 'feature/closed' }).getByRole('checkbox');
    await expect(checks).toHaveCount(6);
    await expect(closed).not.toBeChecked();
    // contain keyboard navigation after the flyout action loses its node
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close cleanup' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await more.click();
    await cleanup.click();
    // manual opt-outs survive fresh reads and a full browser reload
    await worker.uncheck();
    await pane.uncheck();
    await expect.poll(storedChoices).toEqual([['worker-1', false], ['pane-1', false]]);
    await dialog.getByRole('button', { name: 'Close cleanup' }).click();
    await expect(more).toBeFocused();
    await expect(more.locator('.cleanup-summary-count')).toHaveText('3');
    await more.click();
    await expect(cleanup.locator('.cleanup-count.unchecked')).toHaveText('3');
    await cleanup.click();
    await expect(worker).not.toBeChecked();
    await expect(pane).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Close cleanup' }).click();
    await page.reload();
    await expect(more.locator('.cleanup-summary-count')).toHaveText('3');
    await more.click();
    await cleanup.click();
    await expect(worker).not.toBeChecked();
    await expect(pane).not.toBeChecked();
    await expect(closed).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
    await expect.poll(() => submittedIds).toEqual(['agent-1', 'process-1', 'branch-1']);
    await expect(dialog.getByRole('alert')).toHaveText('Some selected targets could not be cleaned up.');
    await expect(checks).toHaveCount(4);
    await expect(worker).not.toBeChecked();
    await expect(pane).not.toBeChecked();
    await expect(closed).not.toBeChecked();
    // manually consent to the closed branch, leaving ignored rows untouched
    await closed.check();
    await expect.poll(storedChoices).toEqual([['worker-1', false], ['pane-1', false], ['closed-branch-1', true]]);
    await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
    await expect.poll(() => submittedIds).toEqual(['agent-1', 'closed-branch-1']);
    // resolved positive consent disappears without erasing unrelated opt-outs
    await expect.poll(storedChoices).toEqual([['worker-1', false], ['pane-1', false]]);
    await expect(checks).toHaveCount(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Dismiss all' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close cleanup' }).click();
    await expect(more.locator('.cleanup-summary-count')).toHaveCount(0);
    await more.click();
    await expect(cleanup.locator('.cleanup-count.unchecked')).toHaveText('2');
    await expect(cleanup.locator('.cleanup-count.checked')).toHaveCount(0);
    await cleanup.click();
    // only a manual check restores previously unchecked work to the yellow count
    await worker.check();
    await pane.check();
    await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(more).toBeFocused();
    await more.click();
    await expect(cleanup).toBeVisible();
    await expect(cleanup.locator('.cleanup-count')).toHaveCount(0);
    await cleanup.click();
    await expect(dialog.getByText('No cleanup targets remain.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications.filter(notification => notification.options?.tag === 'runtime-cleanup'))).toEqual([]);
  });
}

// never turn a failed or malformed cleanup read into a trustworthy empty state
for (const scenario of [
  { name: 'failed', status: 503, payload: { error: 'cleanup unavailable' } },
  { name: 'malformed', status: 200, payload: { targets: [{ id: 'unknown', kind: 'future-kind', label: 'Unknown', detail: 'unsupported' }] } },
]) {
  test(`stops cleanup skeletons without showing false empty content after a ${scenario.name} read`, async ({ page }) => {
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      // restore one controlling browser
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      // expose one pending cleanup target
      if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending: 1, agents: [], projects: [] } });
      if (url.pathname === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ status: scenario.status, json: scenario.payload });
      if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await page.goto('/#cleanup');
    const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
    await expect(dialog.getByRole('alert')).toHaveText('Unable to load cleanup targets.');
    await expect(dialog.locator('.cleanup-skeleton')).toHaveCount(0);
    await expect(dialog.locator('.cleanup-empty')).toHaveCount(0);
    await expect(dialog.getByText('No cleanup targets remain.')).toHaveCount(0);
    await expect(dialog.locator('.cleanup-actions button')).toBeDisabled();
  });
}

// cleanup remains available when the console has no workspaces or suggestions
test('keeps an empty Cleanup entry in the empty console More menu', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    // mount an authenticated empty console
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { agents: [], projects: [], cleanupPending: 0, cleanupTargets: [] } });
    if (path === '/api/cleanup') return route.fulfill({ json: { targets: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const more = page.getByRole('button', { name: 'More options' });
  await expect(more).toBeVisible();
  await expect(more.locator('.cleanup-count')).toHaveCount(0);
  await more.click();
  const cleanup = page.locator('.place-menu').getByRole('button', { name: 'Cleanup', exact: true });
  await expect(cleanup).toBeVisible();
  await expect(cleanup.locator('.cleanup-count')).toHaveCount(0);
  await cleanup.click();
  await expect(page.getByRole('dialog', { name: 'Cleanup', exact: true }).getByText('No cleanup targets remain.')).toBeVisible();
});

type CleanupFixture = { targets: Array<{ id: string; kind: string; label: string; detail: string }>; version: { epoch: number; revision: number } };
// share only the authenticated cleanup boundary for failure and ordering cases
async function installCleanupApi(page: Page, state: CleanupFixture) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // expose a cached ordered scan without opening a live workspace
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [], cleanupTargets: state.targets, cleanupPending: state.targets.length, cleanupVersion: state.version } });
    if (path === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ json: { targets: state.targets, version: state.version } });
    // only selected successful actions advance this mock cache
    if (path === '/api/cleanup' && request.method() === 'POST') {
      const selected = (request.postDataJSON() as { targetIds: string[] }).targetIds;
      state.targets = state.targets.filter(target => !selected.includes(target.id));
      state.version = { epoch: state.version.epoch, revision: state.version.revision + 1 };
      return route.fulfill({ json: { targets: state.targets, version: state.version } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

// reject superseded scans while accepting a restarted server's lower revision
for (const scenario of [
  { name: 'older revision', version: { epoch: 2, revision: 1 }, accepted: false },
  { name: 'older epoch with higher revision', version: { epoch: 1, revision: 100 }, accepted: false },
  { name: 'unversioned legacy', version: undefined, accepted: false },
  { name: 'newer epoch with lower revision', version: { epoch: 3, revision: 0 }, accepted: true }
]) {
  test(`handles a ${scenario.name} dashboard cleanup snapshot delivered after cleanup`, async ({ page }) => {
    const state: CleanupFixture = { targets: [
      { id: 'old-worker', kind: 'orphan-worker', label: 'Worker to clean', detail: 'old worker' },
      { id: 'kept-worker', kind: 'orphan-worker', label: 'Worker to keep', detail: 'kept worker' }
    ], version: { epoch: 2, revision: 1 } };
    await installCleanupApi(page, state);
    let reads = 0;
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayedRead = new Promise<void>(resolve => { started = resolve; });
    // vary only the delayed snapshot's cleanup ordering metadata
    await page.route('**/api/dashboard', async route => {
      const snapshot = { generation: 1, agents: [], projects: [], cleanupTargets: state.targets, cleanupPending: state.targets.length, cleanupVersion: state.version as CleanupFixture['version'] | undefined };
      // hold the second snapshot until after the action changes the cache
      if (++reads === 2) { snapshot.cleanupVersion = scenario.version; started(); await gate; }
      return route.fulfill({ json: snapshot });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.locator('.place-menu').getByRole('button', { name: 'Cleanup', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
    await dialog.getByRole('checkbox', { name: /Worker to keep/u }).uncheck();
    await delayedRead;
    try {
      await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
      await expect(dialog.getByRole('checkbox')).toHaveCount(1);
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/dashboard');
      release();
      await (await response).finished();
      // inspect after the delayed response has had an opportunity to commit
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(dialog.getByRole('checkbox')).toHaveCount(scenario.accepted ? 2 : 1);
      await expect(dialog.getByRole('checkbox', { name: /Worker to clean/u })).toHaveCount(scenario.accepted ? 1 : 0);
      await expect(dialog.getByRole('checkbox', { name: /Worker to keep/u })).not.toBeChecked();
      const badge = page.locator('.cleanup-summary-count');
      await expect(badge).toHaveCount(scenario.accepted ? 1 : 0);
      // a genuinely newer scan may discover one checked target again
      if (scenario.accepted) await expect(badge).toHaveText('1');
    } finally {
      // release discovery during assertion failures and teardown
      release();
    }
  });
}

// preferences fail visibly instead of silently reversing a destructive opt-out
for (const failure of ['read', 'write', 'corrupt'] as const) {
  test(`reports ${failure} failures for cleanup preferences`, async ({ page }) => {
    // observe raw storage without allowing the read-denial simulation to hide writes
    await page.addInitScript(mode => {
      const key = 'rac.cleanup-choices';
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      const writes: string[] = [];
      // seed protected data before recording application writes
      if (mode !== 'write') set.call(localStorage, key, mode === 'corrupt' ? '{broken' : '[["kept-worker",false]]');
      Object.defineProperty(window, '__cleanupPreferences', { value: { writes, read: () => get.call(localStorage, key) } });
      // simulate only the cleanup preference read boundary
      Storage.prototype.getItem = function (name) {
        if (mode === 'read' && name === key) throw new DOMException('denied', 'SecurityError');
        return get.call(this, name);
      };
      // observe attempted writes even when the simulated quota rejects them
      Storage.prototype.setItem = function (name, value) {
        // leave unrelated browser preferences alone
        if (name === key) {
          writes.push(value);
          // reject only cleanup writes in the quota case
          if (mode === 'write') throw new DOMException('full', 'QuotaExceededError');
        }
        return set.call(this, name, value);
      };
    }, failure);
    // read the original bytes and write log outside the simulated failure
    const storedPreference = () => page.evaluate(() => {
      const preferences = (window as unknown as { __cleanupPreferences: { writes: string[]; read: () => string | null } }).__cleanupPreferences;
      return { writes: preferences.writes, value: preferences.read() };
    });
    const original = failure === 'corrupt' ? '{broken' : failure === 'read' ? '[["kept-worker",false]]' : null;
    await installCleanupApi(page, { targets: [{ id: 'kept-worker', kind: 'orphan-worker', label: 'Worker to keep', detail: 'kept worker' }], version: { epoch: 1, revision: 1 } });
    await page.goto('/');
    const more = page.getByRole('button', { name: 'More options' });
    await expect(more).toBeVisible();
    await expect.poll(storedPreference).toEqual({ writes: [], value: original });
    await more.click();
    const cleanup = page.locator('.place-menu').getByRole('button', { name: 'Cleanup', exact: true });
    await cleanup.click();
    const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
    const checkbox = dialog.getByRole('checkbox');
    // retain in-memory opt-outs even when writing storage is unavailable
    if (failure === 'write') {
      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
      await expect(dialog.getByRole('alert')).toHaveText('Cleanup choices could not be saved in this browser. They may reset after reload.');
      await expect.poll(storedPreference).toEqual({ writes: ['[["kept-worker",false]]'], value: null });
    } else {
      await expect(checkbox).not.toBeChecked();
      await expect(dialog.getByRole('alert')).toHaveText('Cleanup choices could not be restored. Review your selections; preferences may reset after reload.');
      await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeDisabled();
      await expect.poll(storedPreference).toEqual({ writes: [], value: original });
      await dialog.getByRole('button', { name: 'Close cleanup' }).click();
      await more.click();
      const rescan = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/cleanup');
      await cleanup.click();
      await (await rescan).finished();
      await expect(dialog.locator('.cleanup-skeleton')).toHaveCount(0);
      await expect(checkbox).not.toBeChecked();
      await expect.poll(storedPreference).toEqual({ writes: [], value: original });
      // the first explicit choice is the first permitted replacement of stored data
      await checkbox.check();
      await expect.poll(storedPreference).toEqual({ writes: ['[["kept-worker",true]]'], value: '[["kept-worker",true]]' });
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeEnabled();
    }
  });
}
