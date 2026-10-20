import { expect, test } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner, expectStationaryStatus } from './progress-border-assertions';

test.describe.configure({ timeout: 60_000 });

// keep work motion around steady status content
test('moves only the working tab border while its icon, label and dot stay steady', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  await expect(workingTab).toBeVisible();
  await expectProgressBorder(workingTab, 'peach');
  await expect(workingTab.locator('.tab-kind-stack')).toBeVisible();
  const treatment = await workingTab.evaluate(element => {
    const dot = getComputedStyle(element, '::after');
    const label = getComputedStyle(element.querySelector('.tab-label')!);
    // classify movement by the painted part rather than its keyframe name
    const movingParts = element.getAnimations({ subtree: true }).map(animation => {
      const effect = animation.effect as KeyframeEffect;
      // separate descendant label motion
      if ((effect.target as Element | null)?.classList.contains('update-progress-ring')) return 'border';
      if (effect.target !== element) return 'content';
      return 'tab-or-dot';
    });
    return {
      movingParts,
      dotColor: dot.backgroundColor,
      dotWidth: dot.width,
      dotHeight: dot.height,
      labelColor: label.color
    };
  });

  expect(treatment.movingParts).toEqual(['border']);
  expect([treatment.dotWidth, treatment.dotHeight]).toEqual(['6px', '6px']);
  expect(treatment.dotColor).toBe(treatment.labelColor);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTab = page.getByRole('tab', { name: 'Cora — Working' });
  // wait for the phone chooser before testing or opening it
  await expect(phoneTab).toHaveAttribute('aria-haspopup', 'dialog');
  await expectProgressBorder(phoneTab, 'peach');
  await phoneTab.click();
  const phoneRow = page.locator('.workspace-sheet-row').filter({ hasText: 'Cora' });
  await expectProgressBorder(phoneRow, 'peach');
  await expect(phoneRow.locator('.tab-kind-stack')).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-loading-border-working-sheet-phone.png' });
});

// completion keeps its green attention color without pretending to work
test('keeps completed tabs static while preserving their icon, label and dot', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: 'Ready', kind: 'codex' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true, kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
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

// use compact spinners only for active work while either motion preference is enabled
test('reduced motion swaps working borders for spinners while waiting statuses stay still', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true, kind: 'codex' }, { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', worktreeLabel: 'Echo', title: 'Question', attention: 'question', kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[123]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
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
  await expectClockwiseProgressBorder(workingTab);
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionSpinner(workingTab, 'peach');
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorder(workingTab, 'peach');
  await expectClockwiseProgressBorder(workingTab);

  // exercise the live app preference boundary used by the settings toggle
  await page.evaluate(() => {
    localStorage.setItem('rac.reduced-motion', 'enabled');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', newValue: 'enabled' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await expectReducedMotionSpinner(workingTab, 'peach');
  await expectStationaryStatus(successTab);
  await expectStationaryStatus(questionTab);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionSpinner(workingTab, 'peach');
  await page.evaluate(() => {
    localStorage.removeItem('rac.reduced-motion');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.reduced-motion', oldValue: 'enabled' }));
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
  await expectReducedMotionSpinner(workingTab, 'peach');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorder(workingTab, 'peach');
  await expectClockwiseProgressBorder(workingTab);

  const colors = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({ border: getComputedStyle(tab).borderColor, dot: getComputedStyle(tab, '::after').backgroundColor, label: getComputedStyle(tab.querySelector('.tab-label')!).color })));
  expect(colors[0].label).toBe(colors[0].dot);
  expect(colors[1].border).toBe(colors[1].dot);
  expect(colors[1].label).toBe(colors[1].dot);
});
