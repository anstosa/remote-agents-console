import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { chooseSplit } from './split-menu.js';
import type { ComparisonFile, ComparisonPatch } from '../src/code-panel/comparison';

// a minimal valid unified diff for one modified file, enough for the panel's parser
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const patchOf = (files: ComparisonFile[]): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => file.change.path).join('|'), truncated: false });

const codePanel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const agentOutput = (page: Page) => page.locator('.log-output');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// dispatch one deliberate horizontal touch from a rendered target
const swipe = async (page: Page, start: { x: number; y: number }, distance: number) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  // move in small steps so the browser recognizes a touch gesture
  for (let step = 1; step <= 12; step += 1) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + Math.round(distance * step / 12), y: start.y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
};

// a phone with the agent's Workspace open and its Code panel opened from the git popup
const mount = async (page: Page) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/mobile', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patchOf([trackedFile('src/app.ts')]) });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
};

// On a phone the Code panel must join the panel carousel (like note / browser / terminal) rather
// than stacking on top of the agent output — even when it is the only extra panel open.
test('shows the Code panel as a switchable mobile panel, not stacked on the agent', async ({ page }) => {
  await mount(page);

  // opening the Code panel adds it to the phone carousel and scrolls to it, the newly opened panel
  // (the regression: without the Code panel counting as a panel, it stacked on the agent output).
  // It fills the screen, and the dots offer the way back to the agent.
  const split = page.locator('.log-split');
  await expect(split).toHaveClass(/\bmobile-code-view\b/u);
  await expect(codePanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(agentOutput(page)).not.toBeInViewport();

  // the agent's dot returns to the agent output, moving the Code panel off screen
  await expect(page.getByRole('group', { name: 'Panels' }).getByRole('button', { name: 'Choose split' })).toBeVisible();
  await chooseSplit(page, 'Agent output');
  await expect(split).toHaveClass(/\bmobile-agent-view\b/u);
  await expect(agentOutput(page)).toBeInViewport({ ratio: 0.99 });
  await expect(codePanel(page)).not.toBeInViewport();
});

// the view controls live directly in the header's top-level flyout
test('opens view controls as a card beneath the header without a submenu', async ({ page }) => {
  await mount(page);
  await expect(codePanel(page)).toBeInViewport({ ratio: 0.99 });
  await codePanel(page).getByRole('button', { name: 'More code panel actions' }).click();
  const flyout = page.getByRole('group', { name: 'More code panel actions' });
  await expect(flyout).toBeVisible();
  await expect(flyout.getByRole('button', { name: 'View options' })).toHaveCount(0);
  await expect(flyout.getByRole('button', { name: 'Hunks' })).toBeVisible();
  await expect(flyout.getByRole('checkbox', { name: 'Wrap lines' })).not.toBeChecked();
  const [flyoutBox, panelBox] = await Promise.all([flyout.boundingBox(), codePanel(page).boundingBox()]);
  expect(flyoutBox!.height).toBeLessThan(panelBox!.height / 2);
  expect(flyoutBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(flyoutBox!.x + flyoutBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
});

test('swipes from a wrapped diff to the neighboring split', async ({ page }) => {
  await mount(page);
  await expect(codePanel(page)).toBeInViewport({ ratio: 0.99 });

  await codePanel(page).getByRole('button', { name: 'More code panel actions' }).click();
  const menu = page.getByRole('group', { name: 'More code panel actions' });
  await menu.getByRole('checkbox', { name: 'Wrap lines' }).click();
  await expect(codePanel(page)).toHaveAttribute('data-wrap-lines', 'true');
  // choosing wrap closes the flyout so its backdrop cannot consume the next swipe
  await expect(menu).toHaveCount(0);
  const renderedLine = codePanel(page).locator('diffs-container [data-line]').filter({ hasText: 'const b = 3' }).first();
  await expect(renderedLine).toBeVisible();
  const [lineBox, viewport] = await Promise.all([renderedLine.boundingBox(), Promise.resolve(page.viewportSize())]);
  expect(lineBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  const start = { x: Math.round(lineBox!.x + 4), y: Math.round(lineBox!.y + lineBox!.height / 2) };
  const distance = Math.min(280, viewport!.width - start.x - 8);
  // prove the gesture starts on a line inside the diff web component
  const hit = await page.evaluate(({ x, y }) => {
    const outer = document.elementFromPoint(x, y);
    const container = outer?.closest('diffs-container');
    const inner = container?.shadowRoot?.elementFromPoint(x, y);
    return { outer: outer?.tagName ?? null, inner: inner?.tagName ?? null, onLine: Boolean(inner?.closest('[data-line]')) };
  }, start);
  expect(hit, `unexpected touch target: ${JSON.stringify(hit)}`).toMatchObject({ outer: 'DIFFS-CONTAINER', onLine: true });
  await swipe(page, start, distance);
  await expect(agentOutput(page)).toBeInViewport({ ratio: 0.99 });
  await expect(codePanel(page)).not.toBeInViewport();
});
