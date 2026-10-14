import { expect, test, type Page, type Route } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock';

// install the shared streamed-pane fixture so the review console's agent panel mounts
async function installAgentWebSocket(page: Page): Promise<void> {
  await installPaneMock(page);
}

// serve common agent dependencies
async function fulfillAgentSupport(route: Route, pathname: string): Promise<boolean> {
  // disable push registration
  if (pathname === '/api/push/public-key') { await route.fulfill({ json: {} }); return true; }
  // seed the agent log ticket
  if (pathname === '/api/agents/agent-1/tickets') { await route.fulfill({ json: { ticket: 'log-ticket' } }); return true; }
  // return no saved prompts
  if (pathname === '/api/agents/agent-1/saved-prompts') { await route.fulfill({ json: { prompts: [] } }); return true; }
  // return no prompt history
  if (pathname === '/api/agents/agent-1/prompt-history') { await route.fulfill({ json: { prompts: [] } }); return true; }
  // return no queued prompts
  if (pathname === '/api/agents/agent-1/queued-prompts') { await route.fulfill({ json: { prompts: [] } }); return true; }
  // return no installed skills
  if (pathname === '/api/agents/agent-1/commands') { await route.fulfill({ json: { commands: [] } }); return true; }
  return false;
}

// serve one authenticated review console
async function fulfillReviewConsole(route: Route, pathname: string, editor = false): Promise<boolean> {
  // serve the authenticated browser
  if (pathname === '/api/auth/session') { await route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } }); return true; }
  // expose one reviewable agent
  if (pathname === '/api/dashboard') {
    await route.fulfill({ json: { generation: 1, reviewTour: { available: true }, ...(editor ? { editor: true } : {}), agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] } }], projects: [] } });
    return true;
  }
  return await fulfillAgentSupport(route, pathname);
}

// wide enough that the review panel beside the agent panel keeps its step columns
test.use({ viewport: { width: 1600, height: 900 } });

// open the start sheet from the Git flyout's Review button and start with its defaults
async function startReview(page: Page): Promise<void> {
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await sheet.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

// verify generation, notification, and feedback flow
test('guides a human through active-scope implementation changes and sends consolidated feedback', async ({ page }) => {
  const jobRequests: Array<{ scope: string; includeTests: boolean; includeDocs: boolean }> = [];
  const prompts: string[] = [];
  // create a vertically overflowing, horizontally wide diff fixture (a full git patch so the diff
  // library parses it into a rendered file, the way the server's captured patches arrive)
  const longBody = ['@@ -1,121 +1,121 @@', '-old route', `+new route ${'wide-content-'.repeat(40)}`, ...Array.from({ length: 120 }, (_, index) => ` context line ${index + 1}`)].join('\n');
  const longPatch = `diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n${longBody}\n`;
  let comparisonFingerprint = 'comparison-1234567890';
  let releaseGeneration = false;
  let fingerprintRequests = 0;
  let latestReadyJob = 0;
  await installAgentWebSocket(page);
  await page.addInitScript(() => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { configurable: true, value: notifications });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    // capture browser alerts
    const registration = { getNotifications: async () => [], showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the active console fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour: { available: true }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'remote-agents', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/route.ts', additions: 8, deletions: 2, category: 'implementation' }, { code: ' M', path: 'test/route.test.ts', additions: 4, deletions: 1, category: 'test' }] }, gitPrStatus: { base: 'origin/main', files: 2, changes: [{ code: 'M ', path: 'src/route.ts', additions: 12, deletions: 3, category: 'implementation' }, { code: 'M ', path: 'docs/review.md', additions: 6, deletions: 0, category: 'doc' }] } }], projects: [{ id: 'remote-agents', label: 'Remote Agents', available: true, worktrees: [{ id: 'cora', projectId: 'remote-agents', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0 }] }] } });
    // serve common agent dependencies
    if (await fulfillAgentSupport(route, url.pathname)) return;
    // start one bounded tour job
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') {
      jobRequests.push(request.postDataJSON() as typeof jobRequests[number]);
      return route.fulfill({ status: 202, json: { status: 'pending', job: { id: `job-${jobRequests.length}`, expiresAt: '2026-08-07T20:00:00.000Z', retryAfterMs: 10 } } });
    }
    const jobMatch = url.pathname.match(/^\/api\/review-tour\/jobs\/job-(\d+)$/u);
    if (jobMatch !== null && request.method() === 'GET') {
      if (!releaseGeneration) return route.fulfill({ status: 202, json: { status: 'pending' } });
      latestReadyJob = Math.max(latestReadyJob, Number(jobMatch[1]));
      return route.fulfill({ json: { status: 'ready', tour: { title: 'Mobile layout', overview: 'Follow the request from the route into the service.', scope: 'pr', base: 'origin/main', includeTests: jobRequests.at(-1)?.includeTests ?? false, includeDocs: jobRequests.at(-1)?.includeDocs ?? false, fingerprint: comparisonFingerprint, changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: longPatch }, { id: 'chg_service01', file: 'src/service.ts', category: 'implementation', kind: 'hunk', patch: 'diff --git a/src/service.ts b/src/service.ts\nindex 3333333..4444444 100644\n--- a/src/service.ts\n+++ b/src/service.ts\n@@ -4 +4 @@\n-old service\n+new service\n' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route validates input before delegating.', changeIds: ['chg_route0001'] }, { id: 'service', title: 'Apply the operation', explanation: 'The service performs the requested state transition.', changeIds: ['chg_service01'] }] } } });
    }
    if (/^\/api\/review-tour\/jobs\/job-\d+$/u.test(url.pathname) && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') {
      fingerprintRequests += 1;
      return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: comparisonFingerprint } } });
    }
    // capture the final batch request
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      prompts.push((request.postDataJSON() as { prompt: string }).prompt);
      if (prompts.length === 1) return route.fulfill({ status: 400, json: { error: 'invalid prompt' } });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  await expect(statusPanel.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(statusPanel.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
  await statusPanel.getByRole('button', { name: 'Review', exact: true }).click();
  // the button opens the start sheet first: the scope defaults to the flyout's, Tests and Docs are off
  const startSheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(startSheet.getByRole('button', { name: 'Working' })).toBeFocused();
  await expect(startSheet.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
  await expect(startSheet.getByLabel('Tests')).not.toBeChecked();
  await expect(startSheet.getByLabel('Docs')).not.toBeChecked();
  await expect(startSheet.getByText('Narrated by Codex')).toBeVisible();
  expect(jobRequests).toHaveLength(0);
  // Escape closes it without starting
  await page.keyboard.press('Escape');
  await expect(startSheet).toHaveCount(0);
  expect(jobRequests).toHaveLength(0);
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Review', exact: true }).click();
  await startSheet.getByRole('button', { name: 'Start', exact: true }).click();

  const loadingDialog = page.getByRole('region', { name: 'Generating change tour' });
  await expect(loadingDialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Open (generating |out-of-date )?guided review/u })).toHaveCount(0);
  await expect(branchButton).toHaveAttribute('aria-busy', 'true');
  await expect(branchButton).not.toHaveCSS('animation-name', 'none');
  // the branch icon gives way to a spinner, which still shows when reduced motion stills the glow
  await expect(branchButton.locator('.git-review-spinner')).toBeVisible();
  await expect(branchButton.locator('.git-branch-icon')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(branchButton).toHaveCSS('animation-name', 'none');
  await expect(branchButton.locator('.git-review-spinner')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await branchButton.click();
  // the flyout's review button says it is generating, yet still opens the progress dialog
  const generatingButton = statusPanel.getByRole('button', { name: 'Generating…' });
  await expect(generatingButton).toBeEnabled();
  await expect(generatingButton).toHaveAttribute('aria-busy', 'true');
  await generatingButton.click();
  await expect(loadingDialog).toBeVisible();
  expect(jobRequests).toHaveLength(1);
  // the review is a panel in the Workspace's split, beside the agent panel rather than over it
  const reviewPane = page.locator('.log-split > .review-pane');
  await expect(reviewPane).toBeFocused();
  await expect(page.locator('.log-split > .log-output')).toBeVisible();
  const loadingBounds = await loadingDialog.boundingBox();
  expect(loadingBounds!.x).toBeGreaterThan(300);
  expect(loadingBounds!.width).toBeLessThan(1000);
  await expect(loadingDialog.getByRole('button', { name: 'Expand guided review' })).toBeVisible();
  await loadingDialog.getByRole('button', { name: 'Minimize guided review' }).click();
  await expect(loadingDialog).toBeHidden();
  await expect(reviewPane).toHaveCount(0);
  await expect(branchButton).toBeFocused();
  await expect(branchButton).toHaveAttribute('aria-busy', 'true');

  releaseGeneration = true;
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  await expect(branchButton.locator('.git-branch-icon')).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }
  ).__testNotifications.map(notification => ({ title: notification.title, body: notification.options?.body, tag: notification.options?.tag, data: notification.options?.data })))).toEqual([{ title: 'Review ready in Remote Agents', body: 'Cora is ready for review', tag: 'review-ready-cora', data: { url: '/#agent=agent-1', kind: 'system', worktreeId: 'cora' } }]);
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Implementation walkthrough' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('All PR review')).toBeVisible();
  // the tour opens on its overview page, ahead of the first step's diffs
  await expect(dialog.getByText('Overview', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Follow the request from the route into the service.')).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Tour steps' }).getByRole('listitem')).toHaveText(['Accept the request', 'Apply the operation']);
  await expect(dialog.getByLabel('Relevant changes')).toHaveCount(0);
  // the panel shares the split, so expanding it fills the Workspace and leaves room for the step's columns
  await dialog.getByRole('button', { name: 'Expand guided review' }).click();
  await expect(page.locator('.log-split > .log-output')).toBeHidden();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  // the Comparison is a read-only line under the content; changing it means starting again
  const comparisonLine = dialog.locator('.review-tour-comparison');
  await expect(comparisonLine).toHaveText('All PR · tests excluded · docs excluded · vs origin/main');
  await expect(dialog.getByLabel('Tests')).toHaveCount(0);
  const toolbarBelowContent = await comparisonLine.evaluate((toolbar, content) => Boolean(content.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING), await dialog.locator('.review-tour-content').elementHandle());
  expect(toolbarBelowContent).toBe(true);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  const reviewStep = dialog.locator('.review-tour-step');
  // measure the review columns of a wide panel
  const desktopColumns = await reviewStep.evaluate(element => {
    const step = element.getBoundingClientRect();
    const narration = element.querySelector('.review-tour-narration')!.getBoundingClientRect();
    const files = element.querySelector('.review-tour-diffs')!.getBoundingClientRect();
    return { step: { left: step.left, right: step.right }, narration: { left: narration.left, right: narration.right, width: narration.width }, files: { left: files.left, right: files.right, width: files.width } };
  });
  expect(Math.abs(desktopColumns.narration.left - desktopColumns.step.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopColumns.files.left - desktopColumns.narration.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopColumns.files.right - desktopColumns.step.right)).toBeLessThanOrEqual(1);
  expect(desktopColumns.files.width).toBeGreaterThan(desktopColumns.narration.width);
  const diffPane = dialog.getByLabel('Relevant changes');
  // the step's Change renders through the diff library (a shadow-DOM diffs-container), headed by the changed file
  await expect(diffPane.locator('diffs-container [data-title]')).toContainText('route.ts');
  // both sides of the change show as real diff lines (the library strips the +/- prefix)
  await expect(diffPane.getByText('old route')).toBeVisible();
  await expect(diffPane.getByText(/new route wide-content/u)).toBeVisible();
  // the wide diff line stays inside the panel — the page never gains a horizontal scrollbar
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // the wide desktop diff pane offers the Code panel's Unified / Split choice
  const diffLayout = diffPane.getByRole('group', { name: 'Diff layout' });
  await expect(diffLayout.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diffPane.locator('[data-diff-type="single"]')).toHaveCount(1);
  await diffLayout.getByRole('button', { name: 'Split' }).click();
  await expect(diffPane.locator('[data-diff-type="split"]')).toHaveCount(1);
  await diffLayout.getByRole('button', { name: 'Unified' }).click();
  await expect(diffPane.locator('[data-diff-type="single"]')).toHaveCount(1);
  expect(jobRequests).toEqual([{ scope: 'pr', includeTests: false, includeDocs: false }]);
  const nextButton = dialog.getByRole('button', { name: 'Next' });
  const nextColors = await nextButton.evaluate(button => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--crust)';
    document.body.append(probe);
    const colors = [getComputedStyle(button).color, getComputedStyle(probe).color];
    probe.remove();
    return colors;
  });
  expect(nextColors[0]).toBe(nextColors[1]);
  const stepFeedback = dialog.getByLabel('Feedback for this change');
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await stepFeedback.fill('x'.repeat(4_000));
  await expect(dialog.getByText('4,000 character limit reached')).toBeVisible();
  await stepFeedback.fill('');
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await expect(branchButton).not.toHaveAttribute('aria-busy');

  await dialog.getByLabel('Feedback for this change').fill('Keep the route error copy aligned with the existing API.');
  comparisonFingerprint = 'comparison-updated-567890';
  const previousFingerprintRequests = fingerprintRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => fingerprintRequests).toBeGreaterThan(previousFingerprintRequests);
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
  await expect(branchButton).toBeFocused();
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await dialog.getByRole('button', { name: 'Regenerate' }).click();
  // Regenerate starts again with the same launch, back at the new tour's overview
  await expect.poll(() => jobRequests.length).toBe(2);
  expect(jobRequests[1]).toEqual({ scope: 'pr', includeTests: false, includeDocs: false });
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  await expect(dialog.getByLabel('Feedback for this change')).toHaveValue('Keep the route error copy aligned with the existing API.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  // on a phone the review is one panel of the carousel; reopening it brings it into view
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  // on a phone the diff fills the step under a bar naming it; the narration column is gone
  const notesBar = dialog.getByRole('button', { name: 'Show step notes' });
  await expect(notesBar).toContainText('Accept the request');
  await expect(notesBar).toContainText('Feedback');
  await expect(dialog.getByLabel('Feedback for this change')).toHaveCount(0);
  const mobilePanes = await reviewStep.evaluate(element => {
    const step = element.getBoundingClientRect();
    const bar = element.querySelector('.review-tour-notes-bar')!.getBoundingClientRect();
    const files = element.querySelector('.review-tour-diffs')!.getBoundingClientRect();
    return { viewport: window.innerWidth, step: { top: step.top, bottom: step.bottom }, bar: { top: bar.top, bottom: bar.bottom }, files: { left: files.left, right: files.right, top: files.top, bottom: files.bottom } };
  });
  expect(Math.abs(mobilePanes.bar.top - mobilePanes.step.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobilePanes.files.top - mobilePanes.bar.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobilePanes.files.bottom - mobilePanes.step.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobilePanes.files.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobilePanes.files.right - mobilePanes.viewport)).toBeLessThanOrEqual(1);
  // a phone-width diff pane has no room for split, so the layout choice is gone
  await expect(dialog.getByRole('group', { name: 'Diff layout' })).toHaveCount(0);
  // the bar opens the narration and feedback as a left drawer, which Escape closes
  await notesBar.click();
  const notesDrawer = dialog.getByRole('dialog', { name: 'Step notes' });
  await expect(notesDrawer).toBeFocused();
  await expect(notesDrawer.getByText('The route validates input before delegating.')).toBeVisible();
  await expect(notesDrawer.getByLabel('Feedback for this change')).toHaveValue('Keep the route error copy aligned with the existing API.');
  const drawerBounds = await notesDrawer.boundingBox();
  expect(Math.abs(drawerBounds!.x)).toBeLessThanOrEqual(1);
  expect(drawerBounds!.width).toBeLessThan(390);
  await page.keyboard.press('Escape');
  await expect(notesDrawer).toHaveCount(0);
  await expect(notesBar).toBeFocused();
  await expect(dialog).toBeVisible();
  // the backdrop closes it too
  await notesBar.click();
  await dialog.locator('.review-tour-notes-backdrop').click({ position: { x: 380, y: 400 } });
  await expect(notesDrawer).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(notesBar).toContainText('Apply the operation');
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review complete' })).toBeVisible();
  const draft = dialog.getByLabel('Consolidated change request');
  const originalDraft = await draft.inputValue();
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await draft.fill('x'.repeat(30_000));
  await expect(dialog.getByText('30,000 character limit reached')).toBeVisible();
  await draft.fill(originalDraft);
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  const dispatchError = dialog.getByRole('alert');
  await expect(dispatchError).toHaveText('Shorten the change request before sending.');
  await expect(dispatchError).toBeFocused();
  await expect(draft).toHaveValue(/Keep the route error copy aligned with the existing API\./u);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect(dialog.getByText('Change request sent to the implementation agent.')).toBeVisible();
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('guided review of All PR changes against origin/main');
  expect(prompts[0]).toContain('Tour: Implementation walkthrough');
  expect(prompts[0]).not.toContain('Mobile layout');
  expect(prompts[0]).toContain('Keep the route error copy aligned with the existing API.');

  await dialog.getByRole('button', { name: 'Finish' }).click();
  await expect(dialog).toBeHidden();
  await expect(branchButton).toBeFocused();
  const cachedRequests = jobRequests.length;
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review complete' })).toBeVisible();
  expect(jobRequests).toHaveLength(cachedRequests);
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
});

// verify a change whose patch is not a renderable diff falls back to a placeholder, not an empty diff
test('renders a placeholder for a binary or unparseable change', async ({ page }) => {
  // a git binary-file notice carries no unified hunk, so the diff library recovers no file and the
  // tour must show a labelled placeholder instead of a blank diff pane
  const tour = { title: 'Asset refresh tour', overview: 'Review the replaced asset.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'binary-fingerprint-123456', changes: [{ id: 'chg_logo00001', file: 'assets/logo.png', category: 'implementation', kind: 'binary', patch: 'Binary files a/assets/logo.png and b/assets/logo.png differ\n' }], steps: [{ id: 'logo', title: 'Replace the logo', explanation: 'The logo asset was swapped for the new brand mark.', changeIds: ['chg_logo00001'] }] };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // return the ready binary-change tour
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-binary', expiresAt: '2099-08-24T23:00:00.000Z', retryAfterMs: 10 } } });
    if (url.pathname === '/api/review-tour/jobs/job-binary' && request.method() === 'GET') return route.fulfill({ json: { status: 'ready', tour } });
    if (url.pathname === '/api/review-tour/jobs/job-binary' && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    // keep the loaded tour fresh
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: tour.fingerprint } } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Working' }).click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Asset refresh tour' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  const diffPane = dialog.getByLabel('Relevant changes');
  // the unrenderable change shows as a labelled placeholder, and nothing renders through the library
  await expect(diffPane.locator('.review-tour-diff-placeholders')).toContainText('assets/logo.png');
  await expect(diffPane.getByText('Binary file')).toBeVisible();
  await expect(diffPane.locator('diffs-container')).toHaveCount(0);
});

// open a ready two-step tour whose first step is a small parseable patch, for the inline-comment tests
async function openCommentTour(page: Page, { editor = false, explanation = 'The route renames its constants.', tour: custom, files = {} }: { editor?: boolean; explanation?: string; tour?: object; files?: Record<string, string> } = {}): Promise<{ dialog: ReturnType<Page['getByRole']>; prompts: string[]; shells: unknown[] }> {
  const routePatch = 'diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -10,4 +10,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;\n export {};\n';
  const servicePatch = 'diff --git a/src/service.ts b/src/service.ts\nindex 3333333..4444444 100644\n--- a/src/service.ts\n+++ b/src/service.ts\n@@ -4 +4 @@\n-old service\n+new service\n';
  const tour = custom ?? { title: 'Comment tour', overview: 'Review the route constants.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'comment-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: routePatch }, { id: 'chg_service01', file: 'src/service.ts', category: 'implementation', kind: 'hunk', patch: servicePatch }], steps: [{ id: 'route', title: 'Accept the request', explanation, changeIds: ['chg_route0001'] }, { id: 'service', title: 'Apply the operation', explanation: 'The service performs the transition.', changeIds: ['chg_service01'] }] };
  const prompts: string[] = [];
  const shells: unknown[] = [];
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // with an editor configured, record the editor's shells
    if (editor && url.pathname === '/api/worktrees/owen/shells' && request.method() === 'POST') { shells.push(request.postDataJSON()); return route.fulfill({ status: 201, json: { paneId: '%9' } }); }
    if (editor && url.pathname === '/api/worktrees/owen/panes') return route.fulfill({ json: { panes: [{ paneId: '%9', role: 'shell', agent: false, name: 'nvim' }] } });
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname, editor)) return;
    // serve the working tree's text of a file whose unchanged lines are expanded
    if (url.pathname === '/api/worktrees/owen/comparison/file' && request.method() === 'POST') {
      const { path } = request.postDataJSON() as { path: string };
      const content = files[path];
      return content === undefined ? route.fulfill({ status: 404, json: { error: 'file unavailable' } }) : route.fulfill({ json: { path, base: null, working: { path, size: content.length, binary: false, truncated: false, content } } });
    }
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-comment', expiresAt: '2099-08-24T23:00:00.000Z', retryAfterMs: 10 } } });
    if (url.pathname === '/api/review-tour/jobs/job-comment' && request.method() === 'GET') return route.fulfill({ json: { status: 'ready', tour } });
    if (url.pathname === '/api/review-tour/jobs/job-comment' && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: tour.fingerprint } } });
    // capture the change request
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') { prompts.push((request.postDataJSON() as { prompt: string }).prompt); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Working' }).click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: (tour as { title: string }).title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  return { dialog, prompts, shells };
}

// verify reviewers can comment on diff lines and the comments reach the change request
test('records inline comments on diff lines and sends them located and quoted', async ({ page }) => {
  const { dialog, prompts } = await openCommentTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const c = 4;')).toBeVisible();

  // hovering a line offers the gutter "+", which opens an editor under that line
  await diffPane.getByText('const c = 4;').hover();
  await diffPane.locator('[data-utility-button]').click();
  const editor = dialog.getByLabel('Comment on line 12');
  await expect(editor).toBeFocused();
  await editor.fill('Rename this constant.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(editor).toHaveCount(0);
  const saved = diffPane.locator('.review-tour-inline-comment');
  await expect(saved).toContainText('Line 12');
  await expect(saved).toContainText('Rename this constant.');

  // selecting a range of line numbers, then the "+", comments on the whole range
  await diffPane.locator('[data-column-number="13"]').first().click();
  await diffPane.locator('[data-column-number="14"]').first().click({ modifiers: ['Shift'] });
  await diffPane.locator('[data-utility-button]').click();
  const rangeEditor = dialog.getByLabel('Comment on lines 13–14');
  await expect(rangeEditor).toBeFocused();
  // closing an empty comment discards it
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(1);
  await diffPane.locator('[data-column-number="13"]').first().click();
  await diffPane.locator('[data-column-number="14"]').first().click({ modifiers: ['Shift'] });
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on lines 13–14').fill('Drop the trailing export.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(2);

  // a saved comment reopens for editing and can be deleted
  await saved.filter({ hasText: 'Drop the trailing export.' }).getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Comment on lines 13–14').fill('Keep the export; drop the blank line.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await diffPane.getByText('const b = 3;').hover();
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on line 11').fill('Throwaway');
  await saved.filter({ hasText: 'Line 11' }).getByRole('button', { name: 'Delete' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(2);

  // Escape closes open comment editors before it would close the review: a written one is kept…
  await diffPane.getByText('const b = 3;').hover();
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on line 11').fill('Escape keeps me.');
  await page.keyboard.press('Escape');
  await expect(dialog.getByLabel('Comment on line 11')).toHaveCount(0);
  await expect(saved.filter({ hasText: 'Escape keeps me.' })).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await saved.filter({ hasText: 'Line 11' }).getByRole('button', { name: 'Delete' }).click();
  // …and an empty one is discarded, even with focus outside the editor
  await diffPane.getByText('const b = 3;').hover();
  await diffPane.locator('[data-utility-button]').click();
  await expect(dialog.getByLabel('Comment on line 11')).toBeFocused();
  await dialog.getByLabel('Feedback for this change').focus();
  await page.keyboard.press('Escape');
  await expect(dialog.getByLabel('Comment on line 11')).toHaveCount(0);
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(2);
  await expect(dialog).toBeVisible();

  // comments belong to their change, so they survive moving between steps
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('heading', { name: 'Apply the operation' })).toBeVisible();
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toHaveCount(2);
  await dialog.getByLabel('Feedback for this change').fill('Constants read well overall.');

  // both steps are visited, so the summary is already offered
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  const draft = dialog.getByLabel('Consolidated change request');
  await expect(draft).toHaveValue(/Constants read well overall\./u);
  const value = await draft.inputValue();
  expect(value).toContain('## Accept the request (visited)\n\nConstants read well overall.\n\n### src/route.ts:12 (new)\n```diff\n+const c = 4;\n```\nRename this constant.\n\n### src/route.ts:13-14 (new)\n```diff\n const d = 5;\n export {};\n```\nKeep the export; drop the blank line.');
  expect(value).not.toContain('Throwaway');
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect(dialog.getByText('Change request sent to the implementation agent.')).toBeVisible();
  expect(prompts).toEqual([value]);
  // with nothing open, Escape leaves the panel open, and restores it only once it is expanded
  await dialog.getByRole('button', { name: 'Finish' }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Expand guided review' }).click();
  await expect(page.locator('.log-split > .log-output')).toBeHidden();
  await dialog.getByRole('button', { name: 'Finish' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.log-split > .log-output')).toBeVisible();
  await expect(dialog).toBeVisible();
});

// verify the jump from a diff to its line in the configured editor
test('opens a diff line in the configured editor from the file header', async ({ page }) => {
  const { dialog, shells } = await openCommentTour(page, { editor: true });
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const c = 4;')).toBeVisible();
  // with nothing selected the header opens the diff's first change
  const open = diffPane.getByRole('button', { name: /^Open src\/route\.ts at line \d+ in the editor$/u });
  await expect(open).toHaveAccessibleName('Open src/route.ts at line 11 in the editor');
  // a selected line number moves the jump to that line
  await diffPane.locator('[data-column-number="13"]').first().click();
  await expect(open).toHaveAccessibleName('Open src/route.ts at line 13 in the editor');
  await open.click();
  await expect.poll(() => shells).toEqual([{ editor: true, file: 'src/route.ts', line: 13 }]);
  // the review panel stays open beside the editor's Terminal panel
  await expect(dialog).toBeVisible();
});

// verify the editor jump is offered only with an editor configured
test('hides the editor jump when no editor is configured', async ({ page }) => {
  const { dialog } = await openCommentTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const c = 4;')).toBeVisible();
  await expect(diffPane.getByRole('button', { name: /in the editor$/u })).toHaveCount(0);
});

// verify a step's hunks of one file share one diff whose gaps expand to the current file, showing
// another step's change there as plain lines that take no comment
test('merges a step\'s hunks of one file into one expandable diff', async ({ page }) => {
  const base = Array.from({ length: 40 }, (_, index) => `const v${index + 1} = ${index + 1};`);
  const working = [...base];
  working[4] = 'const v5 = 50;';
  working[34] = 'const v35 = 350;';
  working.splice(20, 0, 'const extra1 = 1;', 'const extra2 = 2;');
  const header = 'diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n';
  const context = (from: number, to: number) => base.slice(from - 1, to).map(line => ` ${line}`).join('\n');
  const first = `${header}@@ -2,7 +2,7 @@\n${context(2, 4)}\n-${base[4]}\n+const v5 = 50;\n${context(6, 8)}\n`;
  const inserted = `${header}@@ -18,6 +18,8 @@\n${context(18, 20)}\n+const extra1 = 1;\n+const extra2 = 2;\n${context(21, 23)}\n`;
  const last = `${header}@@ -32,7 +34,7 @@\n${context(32, 34)}\n-${base[34]}\n+const v35 = 350;\n${context(36, 38)}\n`;
  const tour = { title: 'Merged tour', overview: 'Review the route values.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'merged-fingerprint-123456', changes: [{ id: 'chg_first0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: first }, { id: 'chg_extra0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: inserted }, { id: 'chg_last00001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: last }], steps: [{ id: 'values', title: 'Change the values', explanation: 'Two values change.', changeIds: ['chg_first0001', 'chg_last00001'] }, { id: 'extras', title: 'Add the extras', explanation: 'Two constants are added.', changeIds: ['chg_extra0001'] }] };
  const { dialog } = await openCommentTour(page, { tour, files: { 'src/route.ts': `${working.join('\n')}\n` } });
  const diffPane = dialog.getByLabel('Relevant changes');
  // both hunks sit in one diff of the file
  await expect(diffPane.getByText('const v5 = 50;')).toBeVisible();
  await expect(diffPane.getByText('const v35 = 350;')).toBeVisible();
  await expect(diffPane.locator('[data-diffs-header]')).toHaveCount(1);
  await expect(diffPane.getByText('const extra1 = 1;')).toHaveCount(0);

  // a removed line in the second hunk still comments on its base line
  await diffPane.getByText('const v35 = 35;').hover();
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on line 35').fill('Why 350?');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toContainText('Line 35');

  // expanding the gap shows the other step's added lines as plain lines of the current file
  await diffPane.locator('[data-separator]', { hasText: '25 unmodified lines' }).locator('[data-expand-button]').first().click();
  await expect(diffPane.getByText('const extra1 = 1;')).toBeVisible();
  await expect(diffPane.locator('[data-line-type="context-expanded"]', { hasText: 'const extra1 = 1;' }).first()).toBeVisible();
  await expect(diffPane.locator('[data-line-type="change-addition"]', { hasText: 'const extra1 = 1;' })).toHaveCount(0);
  await expect(diffPane.getByText('const v35 = 350;')).toBeVisible();
  await expect(diffPane.locator('.review-tour-inline-comment')).toContainText('Why 350?');
  // an expanded line offers no comment
  await diffPane.getByText('const extra1 = 1;').hover();
  await expect(diffPane.locator('[data-utility-button]')).toBeHidden();
  await diffPane.getByText('const v5 = 50;').hover();
  await expect(diffPane.locator('[data-utility-button]')).toBeVisible();
});

// verify a narrow desktop panel folds the step's notes into the drawer, and expanding unfolds them
test('folds the step notes into a drawer while the panel is narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { dialog } = await openCommentTour(page);
  await expect(dialog.getByRole('button', { name: 'Show step notes' })).toBeVisible();
  await expect(dialog.getByLabel('Feedback for this change')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Expand guided review' }).click();
  await expect(dialog.getByRole('button', { name: 'Show step notes' })).toHaveCount(0);
  await expect(dialog.getByLabel('Feedback for this change')).toBeVisible();
});

// verify a write-up taller than the phone drawer pushes the feedback box below it instead of under it
test('keeps a long write-up above the step feedback in the phone drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await openCommentTour(page, { explanation: Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} explains the route constants.`).join('\n\n') });
  await dialog.getByRole('button', { name: 'Show step notes' }).click();
  const notesDrawer = dialog.getByRole('dialog', { name: 'Step notes' });
  const layout = await notesDrawer.evaluate(element => ({ explanation: element.querySelector('.review-tour-explanation')!.getBoundingClientRect().bottom, feedback: element.querySelector('label')!.getBoundingClientRect().top, overflow: element.scrollHeight > element.clientHeight }));
  expect(layout.overflow).toBe(true);
  expect(layout.feedback).toBeGreaterThanOrEqual(layout.explanation);
  await notesDrawer.getByLabel('Feedback for this change').scrollIntoViewIfNeeded();
  await expect(notesDrawer.getByLabel('Feedback for this change')).toBeInViewport();
});

// verify the touch path: tapping a line number reveals the gutter "+" without any hover
test('opens an inline comment from a tapped line number on touch screens', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const { dialog } = await openCommentTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const c = 4;')).toBeVisible();
  await diffPane.locator('[data-column-number="12"]').first().tap();
  await diffPane.locator('[data-utility-button]').tap();
  const editor = dialog.getByLabel('Comment on line 12');
  await expect(editor).toBeVisible();
  await editor.fill('Tapped comment.');
  await dialog.getByRole('button', { name: 'Done' }).tap();
  await expect(diffPane.locator('.review-tour-inline-comment')).toContainText('Tapped comment.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

// verify actionable generator authentication feedback
test('explains when the server Codex login expires', async ({ page }) => {
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // start one bounded tour job
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-auth', expiresAt: '2026-08-17T23:00:00.000Z', retryAfterMs: 10 } } });
    // report the expired generator login
    if (url.pathname === '/api/review-tour/jobs/job-auth' && request.method() === 'GET') return route.fulfill({ status: 503, json: { status: 'error', jobId: 'job-auth', error: { code: 'authentication_required', retryable: false } } });
    // reap obsolete jobs
    if (url.pathname === '/api/review-tour/jobs/job-auth' && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Generating change tour' });
  await expect(dialog.getByText('Unable to build tour', { exact: true })).toBeVisible();
  await expect(dialog.getByText('The server’s Codex login expired. Sign in to Codex on the server, then try again.')).toBeVisible();
});

// verify transient polling recovery
test('keeps polling through temporary console failures', async ({ page }) => {
  let polls = 0;
  const tour = { title: 'Recovered routing tour', overview: 'Follow the recovered request path.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'recovered-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Apply the route', explanation: 'The route applies the recovered change.', changeIds: ['chg_route0001'] }] };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // start one bounded tour job
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-recovered', expiresAt: '2099-08-24T23:00:00.000Z', retryAfterMs: 10 } } });
    // recover after repeated transient poll failures
    if (url.pathname === '/api/review-tour/jobs/job-recovered' && request.method() === 'GET') {
      polls += 1;
      // simulate a temporary console outage
      if (polls <= 5) return route.fulfill({ status: 503, json: { error: 'Console unavailable' } });
      return route.fulfill({ json: { status: 'ready', tour } });
    }
    // reap obsolete jobs
    if (url.pathname === '/api/review-tour/jobs/job-recovered' && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  let reconnectFlashes = 0;
  // capture accessible reconnect appearances
  page.on('console', message => {
    // count only the observer marker
    if (message.text() === 'review-tour-reconnect-flash') reconnectFlashes += 1;
  });
  await page.evaluate(() => {
    let overlayVisible = false;
    // count each reconnect overlay appearance
    const observer = new MutationObserver(() => {
      const visible = document.querySelector('[role="alert"][aria-label="Reconnecting to console"]') !== null;
      // record only new appearances
      if (visible && !overlayVisible) console.debug('review-tour-reconnect-flash');
      overlayVisible = visible;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Working' }).click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  expect(polls).toBe(6);
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  await expect(page.getByRole('region', { name: 'Recovered routing tour' })).toBeVisible();
  expect(reconnectFlashes).toBe(0);
});

// verify transient start recovery
test('retries temporary failures while starting a tour', async ({ page }) => {
  let starts = 0;
  const requestIds: string[] = [];
  const tour = { title: 'Recovered start tour', overview: 'Follow the request after startup recovery.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'recovered-start-1234567890', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Apply the route', explanation: 'The route applies the recovered change.', changeIds: ['chg_route0001'] }] };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // recover after two transient start failures
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') {
      starts += 1;
      requestIds.push(request.headers()['idempotency-key'] ?? '');
      // simulate lost start acknowledgements
      if (starts <= 2) return route.fulfill({ status: 503, json: { error: 'Console unavailable' } });
      return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-start-recovered', expiresAt: '2099-08-24T23:00:00.000Z', retryAfterMs: 10 } } });
    }
    // return the recovered tour
    if (url.pathname === '/api/review-tour/jobs/job-start-recovered' && request.method() === 'GET') return route.fulfill({ json: { status: 'ready', tour } });
    // reap obsolete jobs
    if (url.pathname === '/api/review-tour/jobs/job-start-recovered' && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Working' }).click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  expect(starts).toBe(3);
  expect(new Set(requestIds).size).toBe(1);
  expect(requestIds[0]).not.toBe('');
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  await expect(page.getByRole('region', { name: 'Recovered start tour' })).toBeVisible();
});

// verify cancellation stops scheduled starts
test('does not retry a tour start after cancellation', async ({ page }) => {
  let starts = 0;
  let releaseStartFailure = () => {};
  const startFailure = new Promise<void>(resolve => { releaseStartFailure = resolve; });
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // leave one retry waiting in backoff
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') {
      starts += 1;
      // hold the first response until the dialog opens
      if (starts === 1) await startFailure;
      return route.fulfill({ status: 503, json: { error: 'Console unavailable' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Working' }).click();
  await startReview(page);
  await expect.poll(() => starts).toBe(1);
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Generating…' }).click();
  const dialog = page.getByRole('region', { name: 'Generating change tour' });
  const failedStart = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/agent-1/review-tour/jobs' && response.status() === 503);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  releaseStartFailure();
  await failedStart;
  await expect(dialog.getByText('Tour cancelled', { exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  expect(starts).toBe(1);
});

// verify control-loss feedback
test('explains when another browser controls the console', async ({ page }) => {
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the review console fixture
    if (await fulfillReviewConsole(route, url.pathname)) return;
    // reject a generation after control moves elsewhere
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 423, json: { error: 'another client is active' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await startReview(page);
  await expect(branchButton).not.toHaveAttribute('aria-busy');
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Generating change tour' });
  await expect(dialog.getByText('Unable to build tour', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Another browser controls this console. Take control, then try again.')).toBeVisible();
});

test('restores the worktree review after reload and dismisses it when stale', async ({ page }) => {
  let reviewStored = true;
  let generationRequests = 0;
  const tour = { title: 'Mobile layout', overview: 'Resume the saved implementation walkthrough.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'stored-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the authenticated console fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour: { available: true }, reviews: reviewStored ? [{ worktreeId: 'cora', branch: 'feature/review-tour', savedAt: '2026-08-08T18:00:00.000Z', title: tour.title, scope: tour.scope, includeTests: false, includeDocs: false, fingerprint: tour.fingerprint }] : [], agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, gitPrStatus: { base: 'origin/main', files: 1 } }], projects: [] } });
    // serve common agent dependencies
    if (await fulfillAgentSupport(route, url.pathname)) return;
    // restore the durable artifact
    if (url.pathname === '/api/worktrees/cora/review-tour' && request.method() === 'GET') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'cora', branch: 'feature/review-tour', savedAt: '2026-08-08T18:00:00.000Z', tour } } });
    if (url.pathname === '/api/worktrees/cora/review-tour' && request.method() === 'DELETE') { reviewStored = false; return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'newer-fingerprint-123456' } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs') { generationRequests += 1; return route.fulfill({ status: 500 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await expect(page.getByRole('button', { name: /Open (generating |out-of-date )?guided review/u })).toHaveCount(0);
  await branchButton.click();
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  await expect(statusPanel.getByRole('button', { name: 'Open Review' })).toBeVisible();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Implementation walkthrough' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Mobile layout' })).toHaveCount(0);
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  expect(generationRequests).toBe(0);
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();
  await branchButton.click();
  await expect(statusPanel.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(statusPanel.getByRole('button', { name: 'Open Review' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('button', { name: /Open (generating |out-of-date )?guided review/u })).toHaveCount(0);
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await expect(page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  expect(generationRequests).toBe(0);
});

// the dashboard capabilities a configured Claude tour with Review presets reports
const claudeReviewCapabilities = {
  reviewTour: { available: true, agent: 'claude', effort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codeReview: { defaultPreset: 'correctness', presets: [
    { id: 'correctness', label: 'Correctness', agent: 'claude', effort: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], available: true },
    { id: 'security', label: 'Security', agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], available: true },
    { id: 'performance', label: 'Performance', agent: 'codex', efforts: [], available: false, reason: 'authentication_required' }
  ] }
};
const startSheetAgent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] } };

test('starts a tour with the chosen comparison, tour effort and AI code review', async ({ page }) => {
  const jobRequests: unknown[] = [];
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, agents: [startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') {
      jobRequests.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-1', expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 1_000 }, codeReview: { job: { id: 'review-1', expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 1_000 } } } });
    }
    if (/^\/api\/(review-tour|code-review)\/jobs\/[\w-]+$/u.test(url.pathname)) return route.fulfill({ status: 202, json: { status: 'pending', job: { id: 'job-1', expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 1_000 } } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(sheet.getByText('Narrated by Claude')).toBeVisible();
  await expect(sheet.getByLabel('Tour effort').locator('option').first()).toHaveText('Default (low)');
  const addReview = sheet.getByLabel('Add AI code review');
  await expect(addReview).not.toBeChecked();
  await expect(sheet.getByLabel('Preset')).toHaveCount(0);
  await sheet.getByLabel('Tests').check();
  await sheet.getByLabel('Tour effort').selectOption('high');
  await addReview.check();
  // the default preset opens on its configured effort; an unavailable preset is listed disabled with its reason
  await expect(sheet.getByLabel('Preset')).toHaveValue('correctness');
  await expect(sheet.getByLabel('Review effort')).toHaveValue('high');
  await expect(sheet.getByRole('option', { name: 'Performance (Sign in to Codex on the server)' })).toHaveAttribute('disabled', '');
  await sheet.getByLabel('Preset').selectOption('security');
  await expect(sheet.getByLabel('Review effort')).toHaveValue('');
  await sheet.getByLabel('Review effort').selectOption('medium');
  await sheet.getByLabel('Extra focus').fill('look hard at the migration');
  await sheet.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => jobRequests).toEqual([{ scope: 'pr', includeTests: true, includeDocs: false, effort: 'high', codeReview: { preset: 'security', effort: 'medium', focus: 'look hard at the migration' } }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rac.code-review-choice') ?? 'null'))).toEqual({ preset: 'security', efforts: { security: 'medium' } });

  // the next start opens unchecked, on the last preset and effort, with no extra focus
  await page.reload();
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(sheet.getByLabel('Add AI code review')).not.toBeChecked();
  await sheet.getByLabel('Add AI code review').check();
  await expect(sheet.getByLabel('Preset')).toHaveValue('security');
  await expect(sheet.getByLabel('Review effort')).toHaveValue('medium');
  await expect(sheet.getByLabel('Extra focus')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(jobRequests).toHaveLength(1);
});

test('hides the AI code review without Review presets and shows the start sheet as a phone bottom sheet', async ({ page }) => {
  await installAgentWebSocket(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour: { available: true }, codeReview: { defaultPreset: 'correctness', presets: [] }, agents: [{ ...startSheetAgent, gitPrStatus: undefined }], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(sheet.getByRole('button', { name: 'All PR' })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'All PR' })).toHaveAttribute('title', 'Merge target unavailable');
  await expect(sheet.getByRole('button', { name: 'Working' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByLabel('Add AI code review')).toHaveCount(0);
  await sheet.locator(':scope > div').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const bounds = await sheet.locator(':scope > div').boundingBox();
  expect(Math.abs(bounds!.y + bounds!.height - 844)).toBeLessThanOrEqual(1);
  expect(bounds!.width).toBeGreaterThan(385);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
});

// a one-step stored tour and Code review fixture for the AI review chip
const chipTour = { title: 'Route tour', overview: 'Follow the route change.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'chip-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: 'diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -1 +1 @@\n-old\n+new\n' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
const chipReview = { fingerprint: chipTour.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'claude' }, effort: 'high', findings: [{ id: 'f1', changeId: 'chg_route0001', side: 'additions', startLine: 1, endLine: 1, severity: 'high', title: 'Unchecked input', body: 'The route trusts the body.' }, { id: 'f2', changeId: 'chg_route0001', side: 'deletions', startLine: 1, endLine: 1, severity: 'low', title: 'Lost comment', body: 'The old line explained why.' }], general: [{ id: 'g1', severity: 'medium', title: 'No tests', body: 'Nothing covers the route.', file: null }], completedAt: '2026-10-04T12:00:00.000Z' };
const pendingJob = (id: string) => ({ id, expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 250 });

test('follows the AI review started with the tour, and cancels it with the tour', async ({ page }) => {
  const tourStarts: unknown[] = [];
  const deleted: string[] = [];
  let tourReady = false;
  let reviewReady = false;
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, agents: [startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (request.method() === 'DELETE') { deleted.push(url.pathname); return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs') {
      tourStarts.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob(`job-${tourStarts.length}`), codeReview: { job: pendingJob(`review-${tourStarts.length}`) } } });
    }
    if (url.pathname.startsWith('/api/review-tour/jobs/')) return tourReady ? route.fulfill({ json: { status: 'ready', tour: chipTour } }) : route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job') } });
    if (url.pathname.startsWith('/api/code-review/jobs/')) return reviewReady ? route.fulfill({ json: { status: 'ready', review: chipReview } }) : route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('review') } });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: chipTour.fingerprint } } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await sheet.getByLabel('Add AI code review').check();
  await sheet.getByRole('button', { name: 'Start', exact: true }).click();
  await branchButton.click();
  await statusPanel.getByRole('button', { name: 'Generating…' }).click();
  const loading = page.getByRole('region', { name: 'Generating change tour' });
  await expect(loading.getByText(/^AI review running · \d+s$/u)).toBeVisible();
  // cancelling the tour cancels the review that started with it
  await loading.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => deleted).toEqual(expect.arrayContaining(['/api/review-tour/jobs/job-1', '/api/code-review/jobs/review-1']));
  await expect(loading.getByText(/AI review running/u)).toHaveCount(0);

  // Try again starts the same launch, review included
  tourReady = true;
  await loading.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => tourStarts).toEqual([
    { scope: 'pr', includeTests: false, includeDocs: false, codeReview: { preset: 'correctness', effort: 'high' } },
    { scope: 'pr', includeTests: false, includeDocs: false, codeReview: { preset: 'correctness', effort: 'high' } }
  ]);
  const dialog = page.getByRole('region', { name: 'Route tour' });
  await expect(dialog.getByText(/^AI review running · \d+s$/u)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add AI review' })).toHaveCount(0);
  // a headless run (or an older server) names no pane to open
  await expect(dialog.getByRole('button', { name: 'Open pane' })).toHaveCount(0);
  reviewReady = true;
  await expect(dialog.getByText('AI review · 2 findings · 1 general')).toBeVisible();
  expect(deleted).not.toContain('/api/code-review/jobs/review-2');
});

test('adds an AI review to a restored tour and retries a failed one', async ({ page }) => {
  const reviewStarts: unknown[] = [];
  let pollFailure = true;
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, reviews: [{ worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', title: chipTour.title, scope: 'pr', includeTests: false, includeDocs: false, fingerprint: chipTour.fingerprint }], agents: [startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname === '/api/worktrees/owen/review-tour') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', tour: chipTour } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: chipTour.fingerprint } } });
    if (url.pathname === '/api/agents/agent-1/code-review/jobs' && request.method() === 'POST') {
      reviewStarts.push(request.postDataJSON());
      if (reviewStarts.length === 1) return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('review-1') } });
      return route.fulfill({ status: 409, json: { status: 'error', error: { code: 'stale_during_generation', retryable: true } } });
    }
    if (url.pathname === '/api/code-review/jobs/review-1') return pollFailure ? route.fulfill({ status: 504, json: { status: 'error', jobId: 'review-1', error: { code: 'timed_out', retryable: true } } }) : route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('review-1') } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Route tour' });
  const add = dialog.getByRole('button', { name: 'Add AI review' });
  await expect(add).toBeVisible();
  // Escape closes the review-only sheet without minimizing the review
  await add.click();
  const sheet = page.getByRole('dialog', { name: 'Add AI review' });
  await expect(sheet.getByLabel('Preset')).toBeFocused();
  await expect(sheet.getByLabel('Add AI code review')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await add.click();
  await sheet.getByLabel('Extra focus').fill('the error copy');
  await sheet.getByRole('button', { name: 'Start review' }).click();
  await expect(sheet).toHaveCount(0);
  expect(reviewStarts).toEqual([{ scope: 'pr', includeTests: false, includeDocs: false, fingerprint: chipTour.fingerprint, preset: 'correctness', effort: 'high', focus: 'the error copy' }]);
  await expect(dialog.getByText('AI review failed')).toBeVisible();
  await expect(dialog.getByText('The AI review timed out.')).toBeVisible();
  // Retry runs the same options against the tour's fingerprint; a moved Comparison marks the tour stale
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => reviewStarts).toHaveLength(2);
  expect(reviewStarts[1]).toEqual(reviewStarts[0]);
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await expect(dialog.getByText('The changes moved since this tour was built. Regenerate the tour to add an AI review.')).toBeVisible();
  pollFailure = false;
});

test('resumes a stored AI review and a running one with the restored tour', async ({ page }) => {
  let stored: Record<string, unknown> = { codeReview: chipReview };
  let reviewReady = false;
  const deleted: string[] = [];
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, reviews: [{ worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', title: chipTour.title, scope: 'pr', includeTests: false, includeDocs: false, fingerprint: chipTour.fingerprint }], agents: [startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (request.method() === 'DELETE') { deleted.push(url.pathname); return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/worktrees/owen/review-tour') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', tour: chipTour, ...stored } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'moved-fingerprint-123456' } } });
    if (url.pathname === '/api/code-review/jobs/review-9') return reviewReady ? route.fulfill({ json: { status: 'ready', review: { ...chipReview, general: [] } } }) : route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('review-9') } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Route tour' });
  await expect(dialog.getByText('AI review · 2 findings · 1 general')).toBeVisible();
  await page.reload();

  stored = { codeReviewJob: pendingJob('review-9') };
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  await expect(dialog.getByText(/^AI review running · \d+s$/u)).toBeVisible();
  // the stale tour offers no new review, and dismissing it cancels the running one
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => deleted).toEqual(expect.arrayContaining(['/api/code-review/jobs/review-9', '/api/worktrees/owen/review-tour']));
  reviewReady = true;
});

test('names the tour agent when guided review is unavailable', async ({ page }) => {
  let reviewTour: Record<string, unknown> = { available: false, reason: 'authentication_required', agent: 'claude', efforts: [] };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour, agents: [startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  for (const [capability, reason] of [
    [{ available: false, reason: 'authentication_required', agent: 'claude', efforts: [] }, 'Authenticate Claude to use guided review'],
    [{ available: false, reason: 'interactive_unavailable', agent: 'claude', efforts: [] }, 'Interactive review runs are not available yet'],
    [{ available: false, reason: 'unsupported_cli', agent: 'codex', efforts: [] }, 'Guided review unavailable: The server\'s Codex CLI is too old']
  ] as const) {
    reviewTour = capability;
    await page.goto('/');
    await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
    const review = page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Review', exact: true });
    await expect(review).toBeDisabled();
    await expect(review).toHaveAttribute('title', reason);
  }
});

// a restored two-step tour (the comment tour's patches) with a stored AI review holding anchored and
// general Findings, for the triage tests; `pendingRun` makes the stored review a running job instead
const triageRoutePatch = 'diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -10,4 +10,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;\n export {};\n';
const triageTour = { title: 'Triage tour', overview: 'Review the route constants.', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'triage-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: triageRoutePatch }, { id: 'chg_service01', file: 'src/service.ts', category: 'implementation', kind: 'hunk', patch: 'diff --git a/src/service.ts b/src/service.ts\nindex 3333333..4444444 100644\n--- a/src/service.ts\n+++ b/src/service.ts\n@@ -4 +4 @@\n-old service\n+new service\n' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route renames its constants.', changeIds: ['chg_route0001'] }, { id: 'service', title: 'Apply the operation', explanation: 'The service performs the transition.', changeIds: ['chg_service01'] }] };
const triageReview = { fingerprint: triageTour.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'claude' }, effort: 'high', completedAt: '2026-10-04T12:00:00.000Z', findings: [
  { id: 'f-const', changeId: 'chg_route0001', side: 'additions', startLine: 12, endLine: 12, severity: 'high', title: 'Unchecked constant', body: 'c is never validated.\nAdd a guard.' },
  { id: 'f-old', changeId: 'chg_route0001', side: 'deletions', startLine: 11, endLine: 11, severity: 'low', title: 'Lost value', body: 'b used to be 2.' },
  { id: 'f-service', changeId: 'chg_service01', side: 'additions', startLine: 4, endLine: 4, severity: 'medium', title: 'Service naming', body: 'Name the operation.' }
], general: [{ id: 'g-tests', severity: 'medium', title: 'No tests', body: 'Nothing covers the route.', file: 'src/route.ts' }] };
async function openTriageTour(page: Page, { stored = { codeReview: triageReview } as Record<string, unknown>, codeReviewPoll }: { stored?: Record<string, unknown>; codeReviewPoll?: (route: Route) => Promise<void> } = {}): Promise<{ dialog: ReturnType<Page['getByRole']>; prompts: string[] }> {
  const prompts: string[] = [];
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, reviews: [{ worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', title: triageTour.title, scope: 'working', includeTests: false, includeDocs: false, fingerprint: triageTour.fingerprint }], agents: [startSheetAgent, { ...startSheetAgent, id: 'agent-review', sessionId: 'socket:$2', title: 'Review · Correctness' }], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname === '/api/worktrees/owen/review-tour') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', tour: triageTour, ...stored } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: triageTour.fingerprint } } });
    if (url.pathname.startsWith('/api/code-review/jobs/') && codeReviewPoll !== undefined) return codeReviewPoll(route);
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') { prompts.push((request.postDataJSON() as { prompt: string }).prompt); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Triage tour' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  return { dialog, prompts };
}

test('shows AI review Findings as suggested comments to keep or dismiss', async ({ page }) => {
  const { dialog, prompts } = await openTriageTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const c = 4;')).toBeVisible();
  // each of the step's Findings shows on its lines with its severity, title, body and source
  const suggestion = diffPane.getByRole('group', { name: 'Suggested comment: Unchecked constant' });
  await expect(suggestion).toContainText('high');
  await expect(suggestion).toContainText('c is never validated.\nAdd a guard.');
  await expect(suggestion).toContainText('Line 12 · Correctness · Claude · high');
  await expect(diffPane.getByRole('group', { name: 'Suggested comment: Lost value' })).toContainText('low');
  await expect(diffPane.getByRole('group', { name: /Service naming/u })).toHaveCount(0);
  // the suggestion sits under its line, inside the route diff
  const lineBox = await diffPane.getByText('const c = 4;').boundingBox();
  const suggestionBox = await suggestion.boundingBox();
  expect(suggestionBox!.y).toBeGreaterThan(lineBox!.y);
  expect(suggestionBox!.y - lineBox!.y).toBeLessThan(60);

  // Dismiss collapses it to a row that restores it
  await diffPane.getByRole('group', { name: 'Suggested comment: Lost value' }).getByRole('button', { name: 'Dismiss' }).click();
  const dismissed = diffPane.getByRole('group', { name: 'Dismissed suggestion: Lost value' });
  await expect(dismissed).toHaveText(/Dismissed · Lost value/u);
  await dismissed.getByRole('button', { name: 'Restore' }).click();
  await expect(diffPane.getByRole('group', { name: 'Suggested comment: Lost value' })).toBeVisible();
  await diffPane.getByRole('group', { name: 'Suggested comment: Lost value' }).getByRole('button', { name: 'Dismiss' }).click();

  // Keep turns it into the operator's own open comment, pre-filled; deleting it brings the suggestion back
  await suggestion.getByRole('button', { name: 'Keep' }).click();
  const editor = dialog.getByLabel('Comment on line 12');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Unchecked constant\n\nc is never validated.\nAdd a guard.');
  await expect(suggestion).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(suggestion).toBeVisible();
  // closing it emptied does too
  await suggestion.getByRole('button', { name: 'Keep' }).click();
  await editor.fill('');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(suggestion).toBeVisible();
  await suggestion.getByRole('button', { name: 'Keep' }).click();
  await editor.fill('Validate c before use.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment')).toContainText('Validate c before use.');

  // triage survives minimize and restore
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  await expect(diffPane.getByRole('group', { name: 'Dismissed suggestion: Lost value' })).toBeVisible();
  await expect(diffPane.locator('.review-tour-inline-comment')).toContainText('Validate c before use.');
  await expect(suggestion).toHaveCount(0);

  // the kept comment is sent as the operator's own; the dismissed and untriaged Findings are not
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(diffPane.getByRole('group', { name: 'Suggested comment: Service naming' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  const draft = dialog.getByLabel('Consolidated change request');
  const value = await draft.inputValue();
  expect(value).toContain('### src/route.ts:12 (new)\n```diff\n+const c = 4;\n```\nValidate c before use.');
  expect(value).not.toMatch(/Lost value|Service naming|Correctness|Claude/u);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect.poll(() => prompts).toEqual([value]);
});

test('counts untriaged Findings per step and sends kept general Findings under General', async ({ page }) => {
  const { dialog, prompts } = await openTriageTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  const progress = dialog.locator('.review-tour-progress');
  // the first step holds two anchored Findings and the general one
  await expect(progress.locator('.review-tour-finding-count')).toHaveText('3 findings');
  const general = dialog.getByRole('region', { name: 'General findings' });
  const noTests = general.getByRole('group', { name: 'Suggested comment: No tests' });
  await expect(noTests).toContainText('Nothing covers the route.');
  await expect(noTests).toContainText('src/route.ts · Correctness · Claude · high');

  // on a phone the general Findings sit in the step notes drawer, and its bar says so
  await page.setViewportSize({ width: 390, height: 844 });
  const notesBar = dialog.getByRole('button', { name: 'Show step notes' });
  await expect(notesBar).toContainText('1 general');
  await notesBar.click();
  await expect(dialog.getByRole('dialog', { name: 'Step notes' }).getByRole('group', { name: 'Suggested comment: No tests' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(diffPane.getByRole('group', { name: 'Suggested comment: Unchecked constant' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1600, height: 900 });

  // triage lowers the count; a kept general Finding becomes an editable, pre-filled note
  await diffPane.getByRole('group', { name: 'Suggested comment: Lost value' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(progress.locator('.review-tour-finding-count')).toHaveText('2 findings');
  await noTests.getByRole('button', { name: 'Keep' }).click();
  const note = general.getByLabel('General note: No tests');
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('No tests\n\nNothing covers the route.');
  await expect(progress.locator('.review-tour-finding-count')).toHaveText('1 finding');
  await note.fill('Add a route test.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(progress.locator('.review-tour-finding-count')).toHaveText('1 finding');
  await expect(dialog.getByRole('region', { name: 'General findings' })).toHaveCount(0);
  await diffPane.getByRole('group', { name: 'Suggested comment: Service naming' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(progress.locator('.review-tour-finding-count')).toHaveCount(0);

  // the summary lists the general Findings too and leads the change request with them
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  const draft = dialog.getByLabel('Consolidated change request');
  await expect(draft).toHaveValue(/Comparison: triage-finge\n\n## General\n\n### src\/route\.ts\nAdd a route test\.$/u);
  const summaryGeneral = dialog.getByRole('region', { name: 'General findings' });
  await summaryGeneral.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByText('No feedback was recorded. You can finish without sending anything.')).toBeVisible();
  await summaryGeneral.getByRole('group', { name: 'Suggested comment: No tests' }).getByRole('button', { name: 'Keep' }).click();
  await summaryGeneral.getByLabel('General note: No tests').fill('Cover the route with a test.');
  await expect(draft).toHaveValue(/## General\n\n### src\/route\.ts\nCover the route with a test\.$/u);
  // a hand edit is never rebuilt behind the operator's back; Rebuild from feedback brings the built one back
  await draft.fill('Please add the route test.');
  await summaryGeneral.getByLabel('General note: No tests').fill('Cover the route with tests.');
  await expect(draft).toHaveValue('Please add the route test.');
  await dialog.getByRole('button', { name: 'Rebuild from feedback' }).click();
  await expect(draft).toHaveValue(/## General\n\n### src\/route\.ts\nCover the route with tests\.$/u);
  await expect(dialog.getByRole('button', { name: 'Rebuild from feedback' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect.poll(() => prompts).toHaveLength(1);
  expect(prompts[0]).toContain('## General\n\n### src/route.ts\nCover the route with tests.');
  expect(prompts[0]).not.toMatch(/Unchecked constant|Lost value|Service naming/u);
});

test('keeps triaged general Findings inside the step column', async ({ page }) => {
  const long = (title: string) => ({ severity: 'medium', title, body: `${title}. The lockfile fallback resolves npm 10 from the base image and the worker pins it.`, file: 'scripts/fallback-to-npm10-when-the-lockfile-was-written-by-npm12.sh' });
  const general = [{ id: 'g-one', ...long('The fallback reinstalls npm on every run even when the image already has the pinned version') }, { id: 'g-two', ...long('Nothing checks that the pinned npm version still reads lockfiles written by npm twelve') }];
  const { dialog } = await openTriageTour(page, { stored: { codeReview: { ...triageReview, general } } });
  const narration = dialog.locator('.review-tour-narration');
  const fits = () => narration.evaluate(element => element.scrollWidth <= element.clientWidth);
  expect(await fits()).toBe(true);
  const findings = dialog.getByRole('region', { name: 'General findings' });
  await findings.getByRole('group', { name: /^Suggested comment: The fallback/u }).getByRole('button', { name: 'Dismiss' }).click();
  expect(await fits()).toBe(true);
  await findings.getByRole('group', { name: /^Suggested comment: Nothing checks/u }).getByRole('button', { name: 'Keep' }).click();
  await findings.getByLabel(/^General note: Nothing checks/u).fill('Add a check that npm 10 reads an npm 12 lockfile.');
  expect(await fits()).toBe(true);
});

test('counts the Findings not reviewed on the summary and jumps back to them', async ({ page }) => {
  const { dialog } = await openTriageTour(page);
  const diffPane = dialog.getByLabel('Relevant changes');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  const untriaged = dialog.locator('.review-tour-untriaged');
  await expect(untriaged).toContainText('4 findings not reviewed');
  await expect(dialog.locator('.review-tour-summary li').nth(0).locator('.review-tour-finding-count')).toHaveText('3');
  await expect(dialog.locator('.review-tour-summary li').nth(1).locator('.review-tour-finding-count')).toHaveText('1');
  // the jump lands on the first step holding one
  await untriaged.getByRole('button', { name: 'Review findings' }).click();
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  await diffPane.getByRole('group', { name: 'Suggested comment: Unchecked constant' }).getByRole('button', { name: 'Dismiss' }).click();
  await diffPane.getByRole('group', { name: 'Suggested comment: Lost value' }).getByRole('button', { name: 'Dismiss' }).click();
  await dialog.getByRole('region', { name: 'General findings' }).getByRole('button', { name: 'Dismiss' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(untriaged).toContainText('1 finding not reviewed');
  await untriaged.getByRole('button', { name: 'Review findings' }).click();
  await expect(dialog.getByText('Step 2 of 2')).toBeVisible();
  await diffPane.getByRole('group', { name: 'Suggested comment: Service naming' }).getByRole('button', { name: 'Dismiss' }).click();
  // a general Finding left alone brings a phone back to the first step's notes drawer
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByRole('region', { name: 'General findings' }).getByRole('button', { name: 'Restore' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(untriaged).toContainText('1 finding not reviewed');
  await untriaged.getByRole('button', { name: 'Review findings' }).click();
  const drawer = dialog.getByRole('dialog', { name: 'Step notes' });
  await expect(drawer.getByRole('group', { name: 'Suggested comment: No tests' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Dismiss' }).click();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review complete' })).toBeVisible();
  await expect(untriaged).toHaveCount(0);
});

test('links a running interactive AI review to its pane and counts from its start', async ({ page }) => {
  let needsInput = false;
  const startedAt = new Date(Date.now() - 125_000).toISOString();
  const { dialog } = await openTriageTour(page, { stored: { codeReviewJob: pendingJob('review-run') }, codeReviewPoll: route => route.fulfill({ status: 202, json: { status: 'pending', job: { ...pendingJob('review-run'), startedAt }, run: { agentId: 'agent-review', needsInput } } }) });
  // the elapsed time counts from the server's start, not from when this page saw the job
  await expect(dialog.getByText(/^AI review running · 2m \d+s/u)).toBeVisible();
  await expect(dialog.locator('.review-tour-ai').getByRole('button', { name: 'Open pane' })).toBeVisible();
  needsInput = true;
  await expect(dialog.locator('.review-tour-ai')).toHaveText(/^AI review needs input·Open pane$/u);
  // Open pane selects the run's Agent; the review panel stays open beside it
  await dialog.locator('.review-tour-ai').getByRole('button', { name: 'Open pane' }).click();
  await expect(page).toHaveURL(/#agent=agent-review$/u);
});

test('links a tour run waiting on the operator to its pane', async ({ page }) => {
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, agents: [startSheetAgent, { ...startSheetAgent, id: 'agent-tour', sessionId: 'socket:$2', title: 'Tour · feature/review-tour' }], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs') return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job-run') } });
    if (url.pathname === '/api/review-tour/jobs/job-run' && request.method() === 'GET') return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job-run'), run: { agentId: 'agent-tour', needsInput: true } } });
    if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const branchButton = page.getByRole('button', { name: /Git status: feature\/review-tour/ });
  await branchButton.click();
  await startReview(page);
  await branchButton.click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Generating…' }).click();
  const loading = page.getByRole('region', { name: 'Generating change tour' });
  await expect(loading.getByText('The tour needs input')).toBeVisible();
  await expect(loading.getByText('Claude asked a question in its pane. Answer it there to continue.')).toBeVisible();
  await loading.getByRole('button', { name: 'Open pane' }).click();
  await expect(page).toHaveURL(/#agent=agent-tour$/u);
});

test('binds a guided review started from a Review run\'s pane to the Worktree\'s own agent', async ({ page }) => {
  const jobPaths: string[] = [];
  const reviewer = { ...startSheetAgent, id: 'agent-review', sessionId: 'socket:$2', title: 'Review · Correctness', reviewRun: 'run_abcdefgh1234' };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, agents: [reviewer, startSheetAgent], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname.endsWith('/review-tour/jobs') && request.method() === 'POST') { jobPaths.push(url.pathname); return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job-1') } }); }
    if (url.pathname === '/api/review-tour/jobs/job-1') return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job-1') } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  // the Review run's own pane is the one shown
  await page.goto('/#agent=agent-review');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await startReview(page);
  // the read-only reviewer, which closes with its run, never becomes the review's agent
  await expect.poll(() => jobPaths).toEqual(['/api/agents/agent-1/review-tour/jobs']);
});

// An All PR tour whose route hunk has an added line above a later removed one: `+const x` is new 5
// and `-const y` old 7, two rows apart, so a range across them runs new 5 to old 7. The service hunk
// has the usual shape, `-old service` (old 4) above `+new service` (new 4).
const postRoutePatch = 'diff --git a/src/route.ts b/src/route.ts\nindex 1111111..2222222 100644\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -4,4 +4,4 @@\n const a = 1;\n+const x = 9;\n const b = 2;\n const c = 3;\n-const y = 8;\n';
const postTour = { title: 'Post tour', overview: 'Review the route constants.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'post-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: postRoutePatch }, { id: 'chg_service01', file: 'src/service.ts', category: 'implementation', kind: 'hunk', patch: 'diff --git a/src/service.ts b/src/service.ts\nindex 3333333..4444444 100644\n--- a/src/service.ts\n+++ b/src/service.ts\n@@ -4 +4 @@\n-old service\n+new service\n' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route renames its constants.', changeIds: ['chg_route0001'] }, { id: 'service', title: 'Apply the operation', explanation: 'The service performs the transition.', changeIds: ['chg_service01'] }] };
const openPullRequest = { number: 123, title: 'Review tour', status: 'open', url: 'https://github.com/owner/repo/pull/123' };
type PrReviewPost = { scope: string; includeTests: boolean; includeDocs: boolean; fingerprint: string; pullRequestNumber: number; sections: { key: string; markdown: string }[]; comments: { id: string; changeId: string; startSide: string; startLine: number; endSide: string; endLine: number; body: string }[] };
const draftReview = { url: 'https://github.com/owner/repo/pull/123/files', pullRequest: { number: 123, url: openPullRequest.url } };
// a post GitHub takes whole: every section, and every comment on its lines
const postedWhole = (post: PrReviewPost, route: Route) => route.fulfill({ json: { status: 'ok', review: draftReview, sections: post.sections.map(({ key }) => ({ key, posted: true })), comments: post.comments.map(comment => ({ id: comment.id, result: 'line' })) } });
// the post's fixed fields for the post tour; a test adds its sections and comments
const postEnvelope = { scope: 'pr', includeTests: false, includeDocs: false, fingerprint: postTour.fingerprint, pullRequestNumber: 123 };

// Restore the post tour on a Worktree with a pull request (or, with null, none), with `stored`
// beside it in the stored review (a Code review, say); `respond` answers each post. The returned `comparison` is the Worktree's current one: moving its fingerprint makes the
// tour stale, and Regenerate builds the tour again with it.
async function openPostTour(page: Page, { scope = 'pr', pullRequest = openPullRequest as Record<string, unknown> | null, stored = {}, respond = (_post: PrReviewPost, route: Route) => route.fulfill({ status: 500, json: { status: 'error', error: { code: 'post_failed', retryable: false } } }) }: { scope?: 'pr' | 'working'; pullRequest?: Record<string, unknown> | null; stored?: Record<string, unknown>; respond?: (post: PrReviewPost, route: Route) => Promise<void> } = {}): Promise<{ dialog: ReturnType<Page['getByRole']>; posts: PrReviewPost[]; prompts: string[]; comparison: { fingerprint: string } }> {
  const posts: PrReviewPost[] = [];
  const prompts: string[] = [];
  const tour = { ...postTour, scope, base: scope === 'pr' ? 'origin/main' : 'HEAD' };
  const comparison = { fingerprint: tour.fingerprint };
  await installAgentWebSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, ...claudeReviewCapabilities, reviews: [{ worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', title: tour.title, scope, includeTests: false, includeDocs: false, fingerprint: tour.fingerprint }], agents: [{ ...startSheetAgent, ...(pullRequest === null ? {} : { pullRequest }) }], projects: [] } });
    if (await fulfillAgentSupport(route, url.pathname)) return;
    if (url.pathname === '/api/worktrees/owen/review-tour') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'owen', branch: 'feature/review-tour', savedAt: '2026-10-04T12:00:00.000Z', tour, ...stored } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'comparison', comparison: { scope, base: tour.base, includeTests: false, includeDocs: false, fingerprint: comparison.fingerprint } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: pendingJob('job-regen') } });
    if (url.pathname === '/api/review-tour/jobs/job-regen') return request.method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.fulfill({ json: { status: 'ready', tour: { ...tour, fingerprint: comparison.fingerprint } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/pr-review' && request.method() === 'POST') { const post = request.postDataJSON() as PrReviewPost; posts.push(post); return respond(post, route); }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') { prompts.push((request.postDataJSON() as { prompt: string }).prompt); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('region', { name: 'Post tour' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  return { dialog, posts, prompts, comparison };
}

// comment on one line of the visible step's diff
async function commentOnLine(dialog: ReturnType<Page['getByRole']>, text: string, label: string, body: string): Promise<void> {
  const diffPane = dialog.getByLabel('Relevant changes');
  await diffPane.getByText(text, { exact: true }).hover();
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel(`Comment on ${label}`).fill(body);
  await dialog.getByRole('button', { name: 'Done' }).click();
}

test('offers Post to PR only for an All PR tour of a branch with an open or draft pull request', async ({ page }) => {
  for (const [options, offered] of [[{ pullRequest: null }, false], [{ scope: 'working' as const }, false], [{ pullRequest: { ...openPullRequest, status: 'merged' } }, false], [{ pullRequest: { ...openPullRequest, status: 'draft' } }, true]] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const { dialog } = await openPostTour(page, options);
    await dialog.getByLabel('Feedback for this change').fill('Route reads well.');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Review summary' }).click();
    await expect(dialog.getByRole('button', { name: 'Send change request' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Post to PR #123' })).toHaveCount(offered ? 1 : 0);
  }
});

test('posts inline comments and notes to the pull request as a draft review and retries the failed ones', async ({ page }) => {
  const { dialog, posts, prompts } = await openPostTour(page, { respond: (post, route) => {
    const byBody = (body: string) => post.comments.find(comment => comment.body === body)?.id ?? '';
    // the first post places one comment on its lines, one as a file-level comment and fails one
    if (posts.length === 1) return route.fulfill({ json: { status: 'ok', review: draftReview, sections: post.sections.map(({ key }) => ({ key, posted: true })), comments: [{ id: byBody('Guard x.'), result: 'line' }, { id: byBody('Name a.'), result: 'file', reason: 'The lines are not in the pull request diff.' }, { id: byBody('Rename the service.'), result: 'failed', reason: 'GitHub rejected the thread.' }] } });
    return postedWhole(post, route);
  } });
  await commentOnLine(dialog, 'const x = 9;', 'line 5', 'Guard x.');
  await commentOnLine(dialog, 'const a = 1;', 'line 4', 'Name a.');
  await dialog.getByLabel('Feedback for this change').fill('Route reads well.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await commentOnLine(dialog, 'new service', 'line 4', 'Rename the service.');
  await dialog.getByRole('button', { name: 'Review summary' }).click();

  // the post carries the notes, without the agent-directed intro, and every comment with its lines
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(1);
  const [guardId, nameId, failedId] = posts[0]!.comments.map(comment => comment.id);
  expect(posts[0]).toEqual({ ...postEnvelope, sections: [{ key: 'step:route', markdown: '## Accept the request\n\nRoute reads well.' }], comments: [
    { id: guardId, changeId: 'chg_route0001', startSide: 'additions', startLine: 5, endSide: 'additions', endLine: 5, body: 'Guard x.' },
    { id: nameId, changeId: 'chg_route0001', startSide: 'additions', startLine: 4, endSide: 'additions', endLine: 4, body: 'Name a.' },
    { id: failedId, changeId: 'chg_service01', startSide: 'additions', startLine: 4, endSide: 'additions', endLine: 4, body: 'Rename the service.' }
  ] });

  // the summary links the draft review and lists the file-level and failed comments with their reasons
  const posted = dialog.getByRole('region', { name: 'Draft review on GitHub' });
  const link = posted.getByRole('link', { name: 'Draft review on PR #123 — finish it on GitHub' });
  await expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/123/files');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(posted).toContainText('1 line comment · 1 file-level comment · notes in the review body');
  await expect(posted.getByRole('list', { name: 'File-level comments' })).toContainText('src/route.ts:4 (new)The lines are not in the pull request diff.');
  await expect(posted.getByRole('status').filter({ hasText: '1 comment failed' })).toBeVisible();
  await expect(posted.getByRole('list', { name: 'Failed comments' })).toContainText('src/service.ts:4 (new)GitHub rejected the thread.');
  await expect(posted).toContainText('Comments and notes already posted are not updated by later edits');
  await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/review-pr-post-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(posted.getByRole('button', { name: 'Retry failed' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/review-pr-post-phone.png` });
  await page.setViewportSize({ width: 1600, height: 900 });

  // with a new comment and a first-time note waiting, Retry still re-posts only the failed comment
  await dialog.getByRole('button', { name: 'Back to tour' }).click();
  await commentOnLine(dialog, 'old service', 'line 4', 'Why drop it?');
  await dialog.getByLabel('Feedback for this change').fill('Service looks fine.');
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(posted).toContainText('1 comment and 1 note not posted yet.');
  await posted.getByRole('button', { name: 'Retry failed' }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ ...postEnvelope, sections: [], comments: [posts[0]!.comments[2]] });
  await expect(posted).toContainText('2 line comments · 1 file-level comment · notes in the review body');
  await expect(posted.getByRole('list', { name: 'Failed comments' })).toHaveCount(0);

  // the next Post sends the new comment and only the new note's section
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]).toEqual({ ...postEnvelope, sections: [{ key: 'step:service', markdown: '## Apply the operation\n\nService looks fine.' }], comments: [{ id: posts[2]!.comments[0]?.id, changeId: 'chg_service01', startSide: 'deletions', startLine: 4, endSide: 'deletions', endLine: 4, body: 'Why drop it?' }] });
  // with everything posted the button says so, and sending to the agent still works
  await expect(dialog.getByRole('button', { name: 'Posted to PR #123' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toContain('Guard x.');

  // a changed note is posted again on its own
  await dialog.getByRole('button', { name: 'Back to tour' }).click();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByLabel('Feedback for this change').fill('Route reads very well.');
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(4);
  expect(posts[3]).toEqual({ ...postEnvelope, sections: [{ key: 'step:route', markdown: '## Accept the request\n\nRoute reads very well.' }], comments: [] });
});

test('explains a refused post and offers to try again only when retrying can help', async ({ page }) => {
  const refusals = [
    { status: 409, error: { code: 'head_mismatch', retryable: true, message: 'Your local commit does not match the pull request\'s head on GitHub. Push your commits (or pull), then post again.', localHead: 'abc1234def567', pullRequestHead: '9876543fedcba' } },
    { status: 502, error: { code: 'github_failed', retryable: true, message: 'GitHub could not add the comments: Bad gateway' } },
    { status: 409, error: { code: 'pull_request_mismatch', retryable: false, message: 'The branch\'s pull request is now #124, not #123. Reopen the review, then post again.' } }
  ];
  const { dialog, posts } = await openPostTour(page, { respond: (_post, route) => { const { status, error } = refusals[posts.length - 1]!; return route.fulfill({ status, json: { status: 'error', error } }); } });
  await commentOnLine(dialog, 'const x = 9;', 'line 5', 'Guard x.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  const post = dialog.getByRole('button', { name: 'Post to PR #123' });
  await post.click();
  // the server's message is shown, and the failure takes focus
  const failure = dialog.getByRole('alert').filter({ has: page.locator('.review-tour-error') });
  await expect(failure).toContainText('Your local commit does not match the pull request\'s head on GitHub. Push your commits (or pull), then post again.');
  await expect(failure).toBeFocused();
  await expect(dialog.getByRole('region', { name: 'Draft review on GitHub' })).toHaveCount(0);
  await expect(post).toBeEnabled();
  // a retryable failure offers Try again; GitHub's 502 is the post's failure, not a lost console, so
  // the reconnecting overlay never shows, even briefly
  await page.evaluate(() => {
    const seen = window as unknown as { reconnectingSeen?: boolean };
    seen.reconnectingSeen = false;
    new MutationObserver(() => { if (document.querySelector('[aria-label="Reconnecting to console"]') !== null) seen.reconnectingSeen = true; }).observe(document.body, { childList: true, subtree: true });
  });
  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(failure).toContainText('GitHub could not add the comments: Bad gateway');
  expect(await page.evaluate(() => (window as unknown as { reconnectingSeen?: boolean }).reconnectingSeen)).toBe(false);
  await expect(dialog).toBeVisible();
  // a final refusal offers no Try again
  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(failure).toContainText('The branch\'s pull request is now #124, not #123.');
  await expect(failure.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(posts).toHaveLength(3);
  expect(posts.every(candidate => candidate.comments.length === 1 && candidate.comments[0]!.body === 'Guard x.')).toBe(true);
});

test('posts notes alone, each section under its own heading', async ({ page }) => {
  const general = [{ id: 'g-route', severity: 'medium', title: 'No tests', body: 'Nothing covers the route.', file: 'src/route.ts' }, { id: 'g.docs', severity: 'low', title: 'No docs', body: 'Nothing documents it.' }];
  const { dialog, posts } = await openPostTour(page, { respond: postedWhole, stored: { codeReview: { fingerprint: postTour.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'claude' }, completedAt: '2026-10-04T12:00:00.000Z', findings: [], general } } });
  const findings = dialog.getByRole('region', { name: 'General findings' });
  await findings.getByRole('group', { name: 'Suggested comment: No tests' }).getByRole('button', { name: 'Keep' }).click();
  await findings.getByLabel('General note: No tests').fill('Add a route test.');
  await findings.getByRole('group', { name: 'Suggested comment: No docs' }).getByRole('button', { name: 'Keep' }).click();
  await findings.getByLabel('General note: No docs').fill('Document the route.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel('Feedback for this change').fill('Service looks fine.');
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(1);
  // each section stands alone, since the server appends it as its own chunk; an id outside the key
  // alphabet is keyed by its digest
  expect(posts[0]).toEqual({ ...postEnvelope, sections: [
    { key: 'general:g-route', markdown: '## General — src/route.ts\n\nAdd a route test.' },
    { key: expect.stringMatching(/^general:h[0-9a-f]+$/u), markdown: '## General\n\nDocument the route.' },
    { key: 'step:service', markdown: '## Apply the operation\n\nService looks fine.' }
  ], comments: [] });
  const posted = dialog.getByRole('region', { name: 'Draft review on GitHub' });
  await expect(posted).toContainText('0 line comments · 0 file-level comments · notes in the review body');
  await expect(dialog.getByRole('button', { name: 'Posted to PR #123' })).toBeDisabled();
});

test('orders a comment range across both sides by its rows in the diff', async ({ page }) => {
  const { dialog, posts } = await openPostTour(page, { respond: postedWhole });
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect(diffPane.getByText('const y = 8;', { exact: true })).toBeVisible();
  // `+const x` (new 5) sits above `-const y` (old 7), picked top-down or bottom-up
  const added = diffPane.locator('[data-line-type="change-addition"][data-column-number="5"]');
  const removed = diffPane.locator('[data-line-type="change-deletion"][data-column-number="7"]');
  await added.click();
  await removed.click({ modifiers: ['Shift'] });
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on lines new 5 – old 7').fill('Top down.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await removed.click();
  await added.click({ modifiers: ['Shift'] });
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on lines new 5 – old 7').fill('Bottom up.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(diffPane.locator('.review-tour-inline-comment').filter({ hasText: 'Lines new 5 – old 7' })).toHaveCount(2);
  // the usual shape, `-old service` above `+new service`, picked bottom-up, starts on the removed line
  await dialog.getByRole('button', { name: 'Next' }).click();
  await diffPane.locator('[data-line-type="change-addition"][data-column-number="4"]').click();
  await diffPane.locator('[data-line-type="change-deletion"][data-column-number="4"]').click({ modifiers: ['Shift'] });
  await diffPane.locator('[data-utility-button]').click();
  await dialog.getByLabel('Comment on lines old 4 – new 4').fill('Usual shape.');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  // the change request quotes the rows between them, and the post sends each range in that order
  await expect(dialog.getByLabel('Consolidated change request')).toHaveValue(/### src\/route\.ts new 5 – old 7\n```diff\n\+const x = 9;\n const b = 2;\n const c = 3;\n-const y = 8;\n```\nTop down\./u);
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(Object.keys(posts[0]!).sort()).toEqual(['comments', 'fingerprint', 'includeDocs', 'includeTests', 'pullRequestNumber', 'scope', 'sections']);
  expect(posts[0]!.comments.map(({ startSide, startLine, endSide, endLine, body }) => ({ startSide, startLine, endSide, endLine, body }))).toEqual([
    { startSide: 'additions', startLine: 5, endSide: 'deletions', endLine: 7, body: 'Top down.' },
    { startSide: 'additions', startLine: 5, endSide: 'deletions', endLine: 7, body: 'Bottom up.' },
    { startSide: 'deletions', startLine: 4, endSide: 'additions', endLine: 4, body: 'Usual shape.' }
  ]);
});

test('posts all of the feedback again after the tour is regenerated', async ({ page }) => {
  const { dialog, posts, comparison } = await openPostTour(page, { respond: postedWhole });
  await commentOnLine(dialog, 'const x = 9;', 'line 5', 'Guard x.');
  await dialog.getByLabel('Feedback for this change').fill('Route reads well.');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect(dialog.getByRole('button', { name: 'Posted to PR #123' })).toBeDisabled();

  // the Worktree moves, the tour goes stale, and Regenerate rebuilds it with the same steps and Changes
  comparison.fingerprint = 'post-fingerprint-regenerated';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await dialog.getByRole('button', { name: 'Regenerate' }).click();
  await dialog.getByRole('button', { name: 'Start tour' }).click();
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(dialog.getByRole('region', { name: 'Draft review on GitHub' })).toHaveCount(0);
  // the regenerated tour posts its comments and notes again, for a draft that may have been replaced
  await dialog.getByRole('button', { name: 'Post to PR #123' }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ ...posts[0], fingerprint: 'post-fingerprint-regenerated' });
});
