import { expect, test, type Page, type Route } from '@playwright/test';
import { installFilesFixture } from './files-panel-fixture.js';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import type { ComparisonFile, ComparisonPatch } from '../src/code-panel/comparison.js';

// build one ordinary working-tree diff behind the lazy Code module
const trackedFile = (path: string): ComparisonFile => ({
  change: { code: ' M', path, additions: 1, deletions: 1 },
  kind: 'tracked',
  capped: false,
  patch: `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
});

const patch: ComparisonPatch = {
  kind: 'working',
  base: 'HEAD',
  gitBase: 'HEAD',
  files: [trackedFile('src/app.ts')],
  fingerprint: 'code-panel-recovery',
  truncated: false
};

// fail only the shared Code/Preview chunk, in either dev or emitted-asset mode
const isCodeChunk = (route: Route): boolean => {
  const path = new URL(route.request().url()).pathname;
  return path === '/src/code-panel/code-panel.tsx' || /^\/assets\/code-panel-[\w-]+\.js$/u.test(path);
};

// mount one authenticated changed workspace without touching a real worktree
const mountWorkspace = async (page: Page, onCodeChunk: (route: Route) => Promise<void>) => {
  await installPaneMock(page);
  await page.route('**/*', async route => {
    // control the lazy boundary independently of API fixtures
    if (isCodeChunk(route)) return onCodeChunk(route);
    const url = new URL(route.request().url());
    // leave ordinary assets with Vite or the emitted preview server
    if (!url.pathname.startsWith('/api/')) return route.continue();
    // authenticate the fixture client
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide a canonical terminal agent in one active changed workspace
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', panel: 'terminal', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, queuedPromptCount: 0, home: '/worktrees/cora', branch: 'feature/recovery', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: patch.files.map(file => file.change) }, title: 'Ready' }], projects: [] } });
    // open the mocked agent stream
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // keep prompt collections empty
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // keep attachments empty
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // serve the Code panel comparison
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patch });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
};

// isolate a permanently missing Code asset
test('contains a failed Code module inside its split and leaves the workspace usable', async ({ page }) => {
  await mountWorkspace(page, route => route.fulfill({ status: 404, body: 'removed build asset' }));
  const draft = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await draft.fill('keep this sibling draft');
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Code changes' });
  await expect(panel.getByRole('alert')).toHaveText('Unable to open code changes.');
  await expect(page.getByText('Console needs to reconnect', { exact: true })).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(draft).toHaveValue('keep this sibling draft');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);

  // closing the failed split must not require a console reload
  await panel.getByRole('button', { name: 'Close code changes' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();
});

// isolate the same shared-module failure in Preview
test('contains the shared module failure inside Preview and keeps Files usable', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.route('**/*', async route => {
    // remove only the shared Code/Preview build asset
    if (isCodeChunk(route)) return route.fulfill({ status: 404, body: 'removed build asset' });
    return route.fallback();
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');

  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('grid')).toBeVisible();
  const alpha = files.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Preview', exact: true }).click();

  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('alert')).toHaveText('Unable to open file preview.');
  await expect(files.getByRole('grid')).toBeVisible();
  await expect(page.getByText('Console needs to reconnect', { exact: true })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Close file', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(files.getByRole('grid')).toBeVisible();
});

// recover a transient chunk failure only on request
test('reloads explicitly after a transient Code module failure and reopens the panel', async ({ page }) => {
  let requests = 0;
  await mountWorkspace(page, async route => {
    requests += 1;
    // model a stale or interrupted first chunk request only
    if (requests === 1) return route.abort('failed');
    return route.continue();
  });
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const failed = page.getByRole('region', { name: 'Code changes' });
  await expect(failed.getByRole('alert')).toHaveText('Unable to open code changes.');

  await Promise.all([
    page.waitForNavigation(),
    failed.getByRole('button', { name: 'Reload console' }).click()
  ]);

  // allow cold lazy syntax modules to initialize after the saved split reloads
  await expect(page.getByRole('region', { name: 'Code changes' }).getByText('new', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(requests).toBe(2);
  expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON().type)).toBe('reload');
  await expect(page.getByText('Console needs to reconnect', { exact: true })).toHaveCount(0);
});
