import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushMetadata } from './pane-stream-mock.js';
import { clickPanelAction } from './panel-header';

// pane paths open the code split without retaining a response-files flyout
test('opens pane file links in the Code panel without requesting response-file metadata', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await installPaneMock(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { __copiedPath?: string }).__copiedPath = value; } } });
  });

  let messageFileRequests = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the minimal console fixture (an active worktree agent so the Code panel can open)
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // the panel's background Comparison load has no changes to show
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: { kind: 'working', base: 'HEAD', gitBase: 'HEAD', files: [], fingerprint: '', truncated: false } });
    if (url.pathname === '/api/agents/agent-1/message-files') {
      messageFileRequests += 1;
      return route.fulfill({ status: 410, json: { error: 'response file discovery removed' } });
    }
    if (url.pathname === '/api/agents/agent-1/file-preview') {
      // return one host temporary image preview (the /tmp screenshot bridge stays on the agent route)
      if (request.postDataJSON().path === '/tmp/agent-screenshot.png') return route.fulfill({ json: { path: '/tmp/agent-screenshot.png', size: 68, binary: true, truncated: false, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } } });
      expect(request.postDataJSON()).toEqual({ path: 'apps/web/src/main.tsx' });
      return route.fulfill({ json: { path: 'apps/web/src/main.tsx', size: 1_234, binary: false, truncated: false, content: 'export const ready = true;\nconst count = 42;\n' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // Seed the pane so its output-link overlay scans the terminal buffer; the latest Turn
  // (for the files menu) arrives on the metadata frame.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await expect(page.getByRole('button', { name: 'Notes' })).toBeEnabled({ timeout: 15_000 });
  const emit = async (text: string, message: string) => {
    // Land the path text in the lower rows so its output-link overlay clears the agent
    // panel's floating header pills (a click there would otherwise hit a header control).
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(20)}${text}\r\n`);
    await pushMetadata(page, 'agent-1', message, false);
  };
  await emit('Updated apps/web/src/main.tsx:1444 and docs/setup.md.', 'Updated `apps/web/src/main.tsx:1444` and `docs/setup.md`.');

  const panel = page.getByRole('region', { name: 'Code changes' });
  await expect(page.locator('.agent-panel').getByRole('toolbar', { name: 'Agent output actions' }).getByRole('button', { name: /Files from latest response/u })).toHaveCount(0);
  expect(messageFileRequests).toBe(0);

  // clicking a file link in the pane output opens that file in the Code panel (a plain-file view),
  // never the old modal dialog
  const outputPath = page.getByRole('link', { name: 'Preview apps/web/src/main.tsx' });
  await expect(outputPath).toHaveAttribute('data-output-file-path', 'apps/web/src/main.tsx');
  await outputPath.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '‹ Changes' })).toBeVisible();
  await expect(panel.getByText('main.tsx', { exact: true })).toBeVisible();
  await expect(panel.getByText('export const ready = true;')).toBeVisible();
  // the retired dialog never appears
  await expect(page.locator('.response-file-dialog')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /File preview:/u })).toHaveCount(0);

  // the File view owns copy-path (from the retired dialog)
  await clickPanelAction(panel, 'Copy path');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedPath?: string }).__copiedPath)).toBe('apps/web/src/main.tsx');

  // an image (the /tmp screenshot bridge) previews inline in the panel, not a dialog
  await emit('Screenshots: /tmp/agent-screenshot.png', 'Screenshots: /tmp/agent-screenshot.png');
  await page.getByRole('link', { name: 'Preview /tmp/agent-screenshot.png' }).click();
  const image = panel.getByRole('img', { name: 'Preview of /tmp/agent-screenshot.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.response-file-dialog')).toHaveCount(0);
  expect(messageFileRequests).toBe(0);
});
