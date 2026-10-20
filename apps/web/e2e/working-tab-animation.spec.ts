import { expect, test } from '@playwright/test';
import { expectProgressBorder } from './progress-border-assertions';

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
  await expectProgressBorder(phoneTab, 'peach');
  await phoneTab.click();
  const phoneRow = page.locator('.workspace-sheet-row').filter({ hasText: 'Cora' });
  await expectProgressBorder(phoneRow, 'peach');
  await expect(phoneRow.locator('.tab-kind-stack')).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-loading-border-working-sheet-phone.png' });
});

// move completion around steady content
test('orbits only the completed border while its icon, label and dot stay steady', async ({ page }) => {
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
  await expectProgressBorder(successTab, 'green', false);
  await expect(successTab.locator('.tab-kind-stack')).toBeVisible();
  const treatment = await successTab.evaluate(element => {
    const tab = getComputedStyle(element);
    const dot = getComputedStyle(element, '::after');
    // classify movement by its rendered target
    const movingParts = element.getAnimations({ subtree: true }).map(animation => {
      const effect = animation.effect as KeyframeEffect;
      // identify the intended completion orbit
      if ((effect.target as Element | null)?.classList.contains('update-progress-ring')) return 'border';
      return effect.pseudoElement === '::after' ? 'dot' : 'tab';
    });
    return { movingParts, borderColor: tab.borderColor, dotColor: dot.backgroundColor, dotWidth: dot.width, dotHeight: dot.height };
  });
  expect(treatment.movingParts).toEqual(['border']);
  expect(treatment.borderColor).toBe(treatment.dotColor);
  expect([treatment.dotWidth, treatment.dotHeight]).toEqual(['6px', '6px']);
});

// preserve status colors while the motion preference stills every treatment
test('the Reduced motion setting preserves working and completed status without movement', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.reduced-motion', 'enabled'));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working', kind: 'codex' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true, kind: 'codex' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  const successTab = page.getByRole('tab', { name: 'Delta — Prompt done — Unread' });
  await expect(workingTab).toBeVisible();
  await expect(successTab).toBeVisible();
  expect(await workingTab.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await successTab.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expectProgressBorder(workingTab, 'peach');
  await expectProgressBorder(successTab, 'green', false);
  const colors = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({ border: getComputedStyle(tab).borderColor, dot: getComputedStyle(tab, '::after').backgroundColor, label: getComputedStyle(tab.querySelector('.tab-label')!).color })));
  expect(colors[0].label).toBe(colors[0].dot);
  expect(colors[1].border).toBe(colors[1].dot);
  expect(colors[1].label).toBe(colors[1].dot);
});
