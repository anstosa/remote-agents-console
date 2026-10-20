import { expect, test } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder } from './progress-border-assertions';

// keep one composited border orbit per working tab
test('uses one border animation per working tab without animated content', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: '⠋ Working in Cora', attention: 'working', kind: 'codex' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', title: '⠙ Working in Delta', attention: 'working', kind: 'codex' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', title: '⠹ Working in Echo', attention: 'working', kind: 'codex' }
        ],
        projects: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[123]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[123]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.tab-label')).toHaveCount(3);
  await expect(page.locator('.tab-label-letter')).toHaveCount(0);
  // verify each visible work state
  for (const tab of await page.getByRole('tab').all()) {
    await expectProgressBorder(tab, 'peach');
    await expectClockwiseProgressBorder(tab);
  }
  await expect(page.locator('.tab-kind-stack')).toHaveCount(3);
  expect(await page.locator('.tab-label').evaluateAll(labels => labels.flatMap(label => label.getAnimations()))).toHaveLength(0);
});
