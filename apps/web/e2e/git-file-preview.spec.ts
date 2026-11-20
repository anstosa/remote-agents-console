import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import type { ComparisonPatch } from '../src/code-panel/comparison';

const filePath = 'apps/server/src/app.ts';
const patch: ComparisonPatch = {
  kind: 'working', base: 'HEAD', gitBase: 'HEAD', truncated: false, fingerprint: filePath,
  files: [{ change: { code: ' M', path: filePath, additions: 1, deletions: 1 }, kind: 'tracked', capped: false,
    patch: `diff --git a/${filePath} b/${filePath}\nindex 1111111..2222222 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,2 +1,2 @@\n-export const app = false;\n+export const app = true;\n const port = 8787;\n` }]
};

// the console's policy for the page, and for a worker allowed to compile WebAssembly
const policy = (url: string, wasm: boolean) => {
  const { protocol, host } = new URL(url);
  return `default-src 'self'; ${wasm ? "script-src 'self' 'wasm-unsafe-eval'; " : ''}connect-src 'self' ${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
};

test('opens a changed file in the Code panel from the git flyout while new output arrives', async ({ page }) => {
  await installPaneMock(page);
  // highlight the diff under the production policy: WebAssembly in the highlight worker, never in the page
  if (process.env.RAC_E2E_PRODUCTION_POLICY === '1')
    await page.route(/^https?:\/\/[^/]+\/$/u, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy(route.request().url(), false) } });
    });
  await page.route(/\/(?:src\/code-panel\/diff-highlight-worker\.ts|assets\/diff-highlight-worker-[\w-]+\.js)(?:\?.*)?$/u, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy(route.request().url(), true) } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // return the authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // return one changed active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/file-preview', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: filePath, additions: 12, deletions: 3 }] }, title: 'Ready' }], projects: [] } });
    // return log authorization
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty auxiliary data
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // return the Working Comparison for the panel, filtered client-side to the clicked file
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patch });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: `View changes to ${filePath}` }).click();

  // the Code panel opens filtered to that one file (a diff, not the old modal dialog)
  const panel = page.getByRole('region', { name: 'Code changes' });
  await expect(panel.getByRole('button', { name: 'All files', exact: true })).toBeVisible();
  await expect(page.locator('.code-pane diffs-container [data-title]')).toHaveText([/app\.ts/u]);
  // highlighted: the changed line's keyword is coloured apart from its identifier
  const changed = panel.locator('diffs-container [data-line]').filter({ hasText: 'export const app = true;' });
  await expect.poll(() => changed.evaluate(row => new Set([...row.querySelectorAll('span')].filter(span => span.children.length === 0 && span.textContent?.trim()).map(span => getComputedStyle(span).color)).size)).toBeGreaterThan(1);

  // new pane output keeps arriving (and renders) while the panel stays open beside it
  await pushBytes(page, 'agent-1', 'Still working\n');
  await expect(page.locator('.log-canvas .xterm-rows')).toContainText('Still working');
  await expect(panel).toBeVisible();
});
