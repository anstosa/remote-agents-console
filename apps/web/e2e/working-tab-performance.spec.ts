import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { expectProgressBorder } from './progress-border-assertions';

// leave a quiet desktop quiet even while other agents remain busy
test('settles working tab motion without losing working status', async ({ page }) => {
  let includeLateAgent = false;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: includeLateAgent ? 2 : 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: '⠋ Working in Cora', attention: 'working', kind: 'codex' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', title: '⠙ Working in Delta', attention: 'working', kind: 'codex' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', title: '⠹ Working in Echo', attention: 'working', kind: 'codex' },
          ...(includeLateAgent ? [{ id: 'agent-4', sessionId: 'socket:$4', home: '/worktrees/foxtrot', title: 'Working in Foxtrot', attention: 'working', kind: 'codex' }] : [])
        ],
        projects: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[1-4]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  // observe the startup cue before waiting for the first terminal paint
  const activeTabAnimations = () => tabs.evaluateAll(elements => elements.flatMap(element => element.getAnimations({ subtree: true })).length);
  await expect.poll(activeTabAnimations).toBe(3);
  await seedPaneSize(page, 'agent-1', 100, 30);
  await pushBytes(page, 'agent-1', 'Quiet output\r\n');
  await expect(page.locator('.log-loading')).toHaveCount(0);

  await expect.poll(activeTabAnimations, { timeout: 8_000 }).toBe(0);
  await expectProgressBorder(tabs.first(), 'peach');
  const ring = tabs.first().locator(':scope > .update-progress-ring');
  // retain the bounded border's paint after its animation finishes
  const border = await ring.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { iterations: style.animationIterationCount, paint: style.backgroundImage };
  });
  expect(border).toEqual({ iterations: '3', paint: expect.stringContaining('conic-gradient') });

  // a new working tab still animates on the shared phase without waking settled tabs
  includeLateAgent = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(tabs).toHaveCount(4);
  await expect.poll(activeTabAnimations).toBe(1);
  await expect.poll(() => tabs.last().evaluate(tab => Number(tab.getAnimations({ subtree: true })[0]?.startTime) % 2_000)).toBe(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(activeTabAnimations).toBe(4);
  await expect.poll(activeTabAnimations).toBe(0);
  // reduced motion also leaves a visible steady glyph
  const glyph = await ring.evaluate(element => {
    const style = getComputedStyle(element, '::after');
    return { display: style.display, border: style.borderTopWidth, iterations: style.animationIterationCount };
  });
  expect(glyph).toEqual({ display: 'block', border: '2px', iterations: '3' });
});
