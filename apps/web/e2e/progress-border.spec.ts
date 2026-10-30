import { expect, test, type Page, type Route } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner } from './progress-border-assertions';
import { mockAccountSocket, openCodexAccounts } from './account-fixture';
import { dropPane, installPaneMock, paneConnectCount, pushBytes, seedPaneSize } from './pane-stream-mock';

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
    await expectProgressBorder(loader, 'mauve', 'loading');
    await expectClockwiseProgressBorder(loader, 'loading');
    await expect.poll(() => loader.locator('.loading-line').evaluate(element => ({ animations: element.getAnimations().length, transform: getComputedStyle(element).transform }))).toEqual({ animations: 0, transform: 'none' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectReducedMotionSpinner(loader, 'mauve', 'loading');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectProgressBorder(loader, 'mauve', 'loading');
    await expectClockwiseProgressBorder(loader, 'loading');
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
    await expectReducedMotionSpinner(loader, 'mauve', 'loading');
    await page.evaluate(() => { delete document.documentElement.dataset.motion; });
    await expectProgressBorder(loader, 'mauve', 'loading');
    await expectClockwiseProgressBorder(loader, 'loading');
  } finally {
    // release authentication during failed assertions too
    sessionGate.release();
  }
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  await expect(ring).toHaveCount(0);
});

// reserve account rows without borrowing mutation motion
test('uses skeleton rows while ChatGPT accounts load', async ({ page }) => {
  const accountsGate = createGate();
  await mockAccountSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose configured Codex without live agents
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title' } }, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: [], projects: [] } });
    // authorize the inert dashboard socket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // hold the real account boundary
    if (path === '/api/codex/accounts' && request.method() === 'GET') {
      await accountsGate.promise;
      return route.fulfill({ json: { accounts: [] } });
    }
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ json: {} });
  });

  const accounts = await openCodexAccounts(page);
  const loader = accounts.getByRole('status', { name: 'Loading accounts and usage' });
  try {
    await expect(loader).toBeVisible();
    await expect(accounts.locator('.account-skeleton')).toHaveCount(3);
    await expect(accounts.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await loader.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  } finally {
    // release the account read during failed assertions too
    accountsGate.release();
  }
  await expect(loader).toHaveCount(0);
});

// keep branch skeletons independent from an existing connection loader
test('keeps branch and agent connection skeletons free of loading borders', async ({ page }) => {
  const branchesGate = createGate();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one connected worktree
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // authorize the mocked pane stream
    if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide empty saved prompts
    if (path === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // hold repository choices after the connection loader starts
    if (path === '/api/worktrees/cora/switch-prs') {
      await branchesGate.promise;
      return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const connection = page.locator('.agent-output .log-canvas > .streamed-terminal-status');
  await expect(connection).toBeVisible();
  await expect(connection).toHaveAttribute('aria-busy', 'true');
  const agentSkeleton = connection.locator('.output-skeleton-agent');
  await expect(agentSkeleton).toBeVisible();
  await expect(agentSkeleton.locator('.output-skeleton-prompt')).not.toHaveCount(0);
  await expect(agentSkeleton.locator('.output-skeleton-paragraph')).not.toHaveCount(0);
  await expect(agentSkeleton.locator('.output-skeleton-tool')).not.toHaveCount(0);
  await expect(agentSkeleton.locator('.output-skeleton-terminal, .output-skeleton-command')).toHaveCount(0);
  await expect.poll(() => connection.locator('.skeleton').count()).toBeGreaterThanOrEqual(6);
  await expect(connection.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  const canvas = page.locator('.agent-output .log-canvas');
  // measure full output coverage without including panel chrome or the composer
  const measureAgentSkeleton = async () => {
    const [canvasBox, skeletonBox, shapes] = await Promise.all([
      canvas.boundingBox(),
      agentSkeleton.boundingBox(),
      // serialize every visible placeholder shape for coverage math
      agentSkeleton.locator('.skeleton:visible').evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }))
    ]);
    // return an empty measurement before geometry exists
    if (canvasBox === null || skeletonBox === null || shapes.length === 0) return { coverage: 0, lastShape: 0, shapes: shapes.length };
    const canvasBottom = canvasBox.y + canvasBox.height;
    // exclude shapes fully clipped beyond the output viewport
    const visibleShapes = shapes.filter(shape => shape.y < canvasBottom && shape.y + shape.height > canvasBox.y);
    // return an empty fill when every shape is clipped
    if (visibleShapes.length === 0) return { coverage: skeletonBox.height / canvasBox.height, lastShape: 0, shapes: 0 };
    const lastBottom = Math.max(...visibleShapes.map(shape => Math.min(shape.y + shape.height, canvasBottom)));
    return {
      coverage: skeletonBox.height / canvasBox.height,
      lastShape: (lastBottom - canvasBox.y) / canvasBox.height,
      shapes: visibleShapes.length
    };
  };
  await expect.poll(async () => (await measureAgentSkeleton()).coverage).toBeGreaterThanOrEqual(0.9);
  await expect.poll(async () => (await measureAgentSkeleton()).lastShape).toBeGreaterThanOrEqual(0.9);
  if (process.env.SHOT_DIR) await canvas.screenshot({ path: `${process.env.SHOT_DIR}/connection-agent-desktop.png` });
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(async () => (await measureAgentSkeleton()).coverage).toBeGreaterThanOrEqual(0.9);
  await expect.poll(async () => (await measureAgentSkeleton()).lastShape).toBeGreaterThanOrEqual(0.9);
  const phoneShapeCount = (await measureAgentSkeleton()).shapes;
  if (process.env.SHOT_DIR) await canvas.screenshot({ path: `${process.env.SHOT_DIR}/connection-agent-phone.png` });
  await page.setViewportSize({ width: 320, height: 1200 });
  await expect.poll(async () => (await measureAgentSkeleton()).shapes).toBeGreaterThan(phoneShapeCount);
  await expect.poll(async () => (await measureAgentSkeleton()).lastShape).toBeGreaterThanOrEqual(0.9);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const branchPanel = page.getByRole('region', { name: 'Changed files' });
  const pullRequests = branchPanel.getByRole('tab', { name: 'PRs', exact: true });
  const branches = branchPanel.getByRole('tab', { name: 'Branches', exact: true });
  try {
    await expect(pullRequests).toBeDisabled();
    await expect(branches).toBeDisabled();
    await expect(pullRequests).toHaveAttribute('aria-busy', 'true');
    await expect(branches).toHaveAttribute('aria-busy', 'true');
    await expect(pullRequests.locator('.git-tab-skeleton')).toHaveCount(1);
    await expect(branches.locator('.git-tab-skeleton')).toHaveCount(1);
    await expect(branchPanel.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
    await expect(page.locator('.progress-loading:has(> .update-progress-ring)')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await connection.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await branchPanel.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  } finally {
    // release repository choices during failed assertions too
    branchesGate.release();
  }
  await expect(pullRequests.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(branches.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(connection).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Cached agent output\r\n');
  await expect(connection).toBeHidden();
  const connects = await paneConnectCount(page, 'agent-1');
  await dropPane(page, 'agent-1');
  await expect.poll(() => paneConnectCount(page, 'agent-1')).toBeGreaterThan(connects);
  await expect(connection).toBeVisible();
  await expect(connection).toContainText('Reconnecting…');
  await expect(connection.locator('.output-skeleton-agent')).toBeVisible();
  await expect(connection.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Fresh agent output\r\n');
  await expect(connection).toBeHidden();
});

// distinguish cleanup skeletons from the user-confirmed cleanup mutation
test('uses skeleton rows for cleanup reads and working motion only for cleanup submission', async ({ page }) => {
  const initialReadGate = createGate();
  const cachedReadGate = createGate();
  const submissionGate = createGate();
  let cleanupReads = 0;
  let cleanupSubmissions = 0;
  const targets = [{ id: 'agent-1', kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old-agent at /worktrees/removed' }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one pending cleanup target
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending: 1, agents: [], projects: [] } });
    // hold each cleanup read independently
    if (path === '/api/cleanup' && request.method() === 'GET') {
      cleanupReads += 1;
      await (cleanupReads === 1 ? initialReadGate.promise : cachedReadGate.promise);
      return route.fulfill({ json: { targets } });
    }
    // hold the explicit cleanup action
    if (path === '/api/cleanup' && request.method() === 'POST') {
      cleanupSubmissions += 1;
      await submissionGate.promise;
      return route.fulfill({ json: { targets: [] } });
    }
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const cleanupTrigger = page.getByRole('button', { name: 'Review 1 cleanup target' });
  await cleanupTrigger.click();
  const dialog = page.getByRole('dialog', { name: 'Cleanup', exact: true });
  try {
    await expect(dialog.getByRole('status', { name: 'Loading cleanup targets' })).toBeVisible();
    await expect(dialog.locator('.cleanup-skeleton')).toHaveCount(3);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.locator('.progress-border')).toHaveCount(0);
    await expect(dialog.locator('.cleanup-actions button')).toBeDisabled();
    // capture the held cleanup read on demand
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/cleanup-desktop.png` });
  } finally {
    // release the initial read during failed assertions too
    initialReadGate.release();
  }
  await expect(dialog.getByRole('checkbox', { name: /Stale Codex agent/u })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close cleanup' }).click();
  await cleanupTrigger.click();
  try {
    await expect.poll(() => cleanupReads).toBe(2);
    await expect(dialog.getByRole('status', { name: 'Loading cleanup targets' })).toBeVisible();
    await expect(dialog.locator('.cleanup-skeleton')).toHaveCount(3);
    await expect(dialog.getByText('Stale Codex agent')).toHaveCount(0);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.locator('.progress-border')).toHaveCount(0);
  } finally {
    // release the cached-list read during failed assertions too
    cachedReadGate.release();
  }

  await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
  const footerProgress = dialog.getByRole('button', { name: 'Working…', exact: true });
  try {
    await expect.poll(() => cleanupSubmissions).toBe(1);
    await expectProgressBorder(footerProgress, 'red', 'working');
    await expectClockwiseProgressBorder(footerProgress, 'working');
  } finally {
    // release the mutation during failed assertions too
    submissionGate.release();
  }
  await expect(dialog).toHaveCount(0);
});

// distinguish note list skeletons from explicit note creation
test('uses a toolbar skeleton for note reads and working motion for note creation', async ({ page }) => {
  const readGate = createGate();
  const creationGate = createGate();
  let noteReads = 0;
  let noteCreations = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one worktree with persistent notes
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    // authorize the mocked agent stream
    if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide empty saved prompts
    if (path === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // hold the foreground note read
    if (path === '/api/worktrees/cora/notes' && request.method() === 'GET') {
      noteReads += 1;
      await readGate.promise;
      return route.fulfill({ json: { notes: [] } });
    }
    // hold the explicit create action
    if (path === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      noteCreations += 1;
      await creationGate.promise;
      return route.fulfill({ status: 201, json: { id: 'note-1', text: '' } });
    }
    // disable push enrollment
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notes = page.locator('.notes-toggle');
  try {
    await expect.poll(() => noteReads).toBe(1);
    await expect(notes).toHaveClass(/notes-read-loading/u);
    await expect(notes.locator('.notes-button-skeleton')).toHaveCount(1);
    await expect(notes.locator('.update-progress-ring')).toHaveCount(0);
    await expect(notes).not.toHaveClass(/progress-border/u);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await notes.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    // capture the reduced-motion note skeleton on demand
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/notes-reduced-motion.png` });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } finally {
    // release the note read during failed assertions too
    readGate.release();
  }
  await expect(notes).not.toHaveAttribute('aria-busy');

  await notes.click();
  await page.getByRole('button', { name: '+ New note', exact: true }).click();
  try {
    await expect.poll(() => noteCreations).toBe(1);
    await expectProgressBorder(notes, 'blue', 'working');
    await expectClockwiseProgressBorder(notes, 'working');
  } finally {
    // release note creation during failed assertions too
    creationGate.release();
  }
  await expect(page.getByRole('dialog', { name: 'Note', exact: true })).toBeVisible();
  await expect(notes).not.toHaveAttribute('aria-busy');
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
    kind: 'loading' | 'working';
    progress: string;
    ringAnimationName: string;
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
        const animation = ring.getAnimations({ subtree: true })[0];
        void (window as unknown as { reportReloadPaint: (snapshot: ReloadPaint) => Promise<void> }).reportReloadPaint({
          busy: button.getAttribute('aria-busy'),
          disabled: button.disabled,
          kind: button.classList.contains('progress-loading') ? 'loading' : 'working',
          progress: style.getPropertyValue('--progress-ring-color').trim(),
          ringAnimationName: animation instanceof CSSAnimation ? animation.animationName : '',
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
    kind: 'loading',
    progress: expectedBlue,
    ringAnimationName: 'loading-border-orbit',
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
