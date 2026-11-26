import { expect, test } from '@playwright/test';
import { expectBreathingProgressBorder, expectProgressBorder, expectProgressBorderGroup, expectReducedMotionProgress, expectStationaryStatus } from './progress-border-assertions';

test.describe.configure({ timeout: 60_000 });

// keep work motion on composited border and status-indicator properties
test('breathes the working tab border while orbiting in the existing status slot', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  await expect(workingTab).toBeVisible();
  await expectProgressBorder(workingTab, 'peach');
  await expectBreathingProgressBorder(workingTab, 'working');
  await expect(workingTab).toHaveClass(/(?:^|\s)progress-status-button(?:\s|$)/u);
  await expect(workingTab.locator('.tab-kind-stack')).toBeVisible();
  const treatment = await workingTab.evaluate(element => {
    const dot = getComputedStyle(element, '::after');
    const label = getComputedStyle(element.querySelector('.tab-label')!);
    return {
      activeProgressAnimations: element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation && animation.animationName.startsWith('progress-') && (animation.playState === 'running' || animation.pending)).length,
      dotBackground: dot.backgroundColor,
      dotColor: dot.borderTopColor,
      dotWidth: dot.width,
      dotHeight: dot.height,
      labelColor: label.color,
      hasLegacyRunner: element.querySelector('.working-progress-runner') !== null
    };
  });

  expect(treatment.activeProgressAnimations).toBe(0);
  expect(treatment.hasLegacyRunner).toBe(false);
  expect(treatment.dotBackground).toBe('rgba(0, 0, 0, 0)');
  expect(Number.parseFloat(treatment.dotWidth)).toBeGreaterThan(0);
  expect(treatment.dotHeight).toBe(treatment.dotWidth);
  expect(treatment.dotColor).toBe(treatment.labelColor);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTab = page.getByRole('tab', { name: 'Cora — Working' });
  // wait for the phone chooser before testing or opening it
  await expect(phoneTab).toHaveAttribute('aria-haspopup', 'dialog');
  await expectProgressBorder(phoneTab, 'peach');
  await expectBreathingProgressBorder(phoneTab, 'working');
  await expect(phoneTab).toHaveClass(/(?:^|\s)progress-status-button(?:\s|$)/u);
  await phoneTab.click();
  const phoneRow = page.locator('.workspace-sheet-row').filter({ hasText: 'Cora' });
  await expectProgressBorder(phoneRow, 'peach');
  await expectBreathingProgressBorder(phoneRow, 'working');
  await expect(phoneRow).toHaveClass(/(?:^|\s)progress-status-button(?:\s|$)/u);
  await expect(phoneRow.locator('.tab-kind-stack')).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-loading-border-working-sheet-phone.png' });
});

// retain existing nodes while late tabs adopt the same css-only animation contracts
test('keeps breathing contracts consistent across late tabs and motion restarts', async ({ page }) => {
  let includeLateTab = false;
  let dashboardRequests = 0;
  const agents = [
    { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: '⠙ Working', attention: 'working', kind: 'codex' },
    { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', worktreeLabel: 'Echo', title: '⠹ Working', attention: 'working', kind: 'codex' }
  ];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // add the late working tab on the next refresh
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({ json: { generation: includeLateTab ? 2 : 1, agents: agents.slice(0, includeLateTab ? 3 : 2), projects: [] } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize each agent stream
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide empty saved prompts
    if (/^\/api\/agents\/agent-[123]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTabs = page.locator('.tabs [role="tab"][aria-busy="true"]');
  await expectProgressBorderGroup(workingTabs, 2, 'working');
  const originalRing = await workingTabs.first().locator(':scope > .update-progress-ring').evaluateHandle(element => element);
  // join the late tab without resetting the original animations
  const requestsBeforeLateTab = dashboardRequests;
  includeLateTab = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardRequests).toBeGreaterThan(requestsBeforeLateTab);
  await expectProgressBorderGroup(workingTabs, 3, 'working');
  expect(await workingTabs.first().locator(':scope > .update-progress-ring').evaluate((element, original) => element === original, originalRing)).toBe(true);
  await originalRing.dispose();
  const lateTab = page.getByRole('tab', { name: 'Echo — Working' });
  await expectProgressBorder(lateTab, 'peach', 'working');
  await expectBreathingProgressBorder(lateTab, 'working');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectProgressBorderGroup(workingTabs, 3, 'working', true);
  await expectReducedMotionProgress(workingTabs.last(), 'peach', 'working');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorderGroup(workingTabs, 3, 'working');

  // restart motion through the app preference boundary
  await page.evaluate(() => {
    localStorage.setItem('rac.reduced-motion', 'enabled');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', newValue: 'enabled' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await expectProgressBorderGroup(workingTabs, 3, 'working', true);
  await page.evaluate(() => {
    localStorage.removeItem('rac.reduced-motion');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', oldValue: 'enabled' }));
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  await expectProgressBorderGroup(workingTabs, 3, 'working');
});

// completion keeps its green attention color without pretending to work
test('keeps completed tabs static while preserving their icon, label and dot', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: 'Ready', kind: 'codex' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true, kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const successTab = page.getByRole('tab', { name: 'Delta — Prompt done — Unread' });
  await expect(successTab).toBeVisible();
  await expectStationaryStatus(successTab);
  await expect(successTab.locator('.tab-kind-stack')).toBeVisible();
  const treatment = await successTab.evaluate(element => {
    const tab = getComputedStyle(element);
    const dot = getComputedStyle(element, '::after');
    return { borderColor: tab.borderColor, dotColor: dot.backgroundColor, dotWidth: dot.width, dotHeight: dot.height };
  });
  expect(treatment.borderColor).toBe(treatment.dotColor);
  expect([treatment.dotWidth, treatment.dotHeight]).toEqual(['6px', '6px']);
  await page.setViewportSize({ width: 390, height: 844 });
  // the phone workspace chooser keeps waiting rows still too
  const phoneTab = page.getByRole('tab', { name: 'Cora — Prompt done' });
  await expect(phoneTab).toHaveAttribute('aria-haspopup', 'dialog');
  await phoneTab.click();
  const completedRow = page.locator('.workspace-sheet-row').filter({ hasText: 'Delta' });
  await expectStationaryStatus(completedRow);
});

// reduced motion keeps the same affordance without looping effects
test('reduced motion keeps static working borders and indicators while waiting statuses stay still', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true, kind: 'codex' }, { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', worktreeLabel: 'Echo', title: 'Question', attention: 'question', kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[123]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  const successTab = page.getByRole('tab', { name: 'Delta — Prompt done — Unread' });
  const questionTab = page.getByRole('tab', { name: 'Echo — Action required' });
  await expect(workingTab).toBeVisible();
  await expect(successTab).toBeVisible();
  await expectProgressBorder(workingTab, 'peach');
  await expectBreathingProgressBorder(workingTab);
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionProgress(workingTab, 'peach');
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorder(workingTab, 'peach');
  await expectBreathingProgressBorder(workingTab);

  // exercise the live app preference boundary used by the settings toggle
  await page.evaluate(() => {
    localStorage.setItem('rac.reduced-motion', 'enabled');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', newValue: 'enabled' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await expectReducedMotionProgress(workingTab, 'peach');
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionProgress(workingTab, 'peach');
  await page.evaluate(() => {
    localStorage.removeItem('rac.reduced-motion');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', oldValue: 'enabled' }));
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  await expectReducedMotionProgress(workingTab, 'peach');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorder(workingTab, 'peach');
  await expectBreathingProgressBorder(workingTab);

  const colors = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => {
    const dot = getComputedStyle(tab, '::after');
    return { border: getComputedStyle(tab).borderColor, dot: tab.classList.contains('progress-border') ? dot.borderTopColor : dot.backgroundColor, label: getComputedStyle(tab.querySelector('.tab-label')!).color };
  }));
  expect(colors[0].label).toBe(colors[0].dot);
  expect(colors[1].border).toBe(colors[1].dot);
  expect(colors[1].label).toBe(colors[1].dot);
});
