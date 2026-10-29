import { expect, test, type Page } from '@playwright/test';

// a console with a Pi Agent in the Worktree Cora and the Conductor in its directory Project
async function mockConsole(page: Page, lifecycle: 'live' | 'exited' = 'live') {
  const posted: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' && url.pathname.startsWith('/api/agents/')) posted.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
      const place = { id: 'home:/srv/conductor', kind: 'directory', projectId: 'home', label: 'Conductor', home: '/srv/conductor', pinned: true };
      const model = { id: 'openai/gpt-5.6', name: 'GPT-5.6', effort: 'medium' };
      const worker = { id: 'agent-1', transport: 'structured', panel: 'transcript', home: '/worktrees/cora', worktreeId: 'cora', placeId: 'cora', projectId: 'app', title: '', kind: 'pi', attention: 'finished', structured: { lifecycle: 'live', revision: 1, model, switchable: true }, queuedPromptCount: 0 };
      const conductor = { id: 'conductor-1', transport: 'structured', panel: 'transcript', home: place.home, placeId: place.id, projectId: 'home', title: '', kind: 'pi', sandboxed: true, attention: 'finished', structured: { lifecycle, role: 'conductor', revision: 1, model, switchable: false }, queuedPromptCount: 0 };
      return route.fulfill({ json: { generation: 1, agents: [worker, conductor], places: [place], projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }, { id: 'home', label: 'Conductor', mode: 'directory', available: true, worktrees: [] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/transcript')) return route.fulfill({ json: { items: [], status: { extension: [] } } });
    if (url.pathname.endsWith('/restart')) return route.fulfill({ status: 204 });
    if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { conversations: [], canResume: true } });
    if (url.pathname.endsWith('/prompt-history') || url.pathname.endsWith('/queued-prompts')) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname.endsWith('/conversation')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/notes')) return route.fulfill({ json: { notes: [] } });
    if (url.pathname.endsWith('/panes')) return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return posted;
}

test('the Conductor\'s tab comes first, and its Panel offers Restart but no Clear, Turn off or model switch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const posted = await mockConsole(page);
  await page.goto('/');
  await expect(page.getByRole('tab').first()).toContainText('Conductor');
  const header = page.locator('.log-split > .log-output .panel-header');
  await expect(header.locator('.model-chip')).toHaveText('GPT-5.6 · medium');
  await expect(header.getByRole('button', { name: /GPT-5\.6/u })).toHaveCount(0);

  await header.getByRole('button', { name: 'Agent power options' }).click();
  const menu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Restart']);
  await menu.getByRole('menuitem', { name: 'Restart' }).click();
  await expect.poll(() => posted).toEqual(['POST /api/agents/conductor-1/restart']);
});

test('an Exited Conductor offers Resume and no Close', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockConsole(page, 'exited');
  await page.goto('/');
  const exited = page.locator('.transcript-exited');
  await expect(exited.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(exited.getByRole('button', { name: 'Close' })).toHaveCount(0);
});
