import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';

test.use({ hasTouch: true });

test('opens prompt history from the composer row while git status expands independently, with no last-prompt text', async ({ page }) => {
  const longPrompt = 'Review every changed service and explain the deployment risk before making any edits. '.repeat(8);
  const overflowChanges = Array.from({ length: 47 }, (_, index) => ({ code: ' M', path: `apps/server/src/generated-${index}.ts`, additions: 1, deletions: 0 }));
  await page.setViewportSize({ width: 428, height: 952 });
  // The last-prompt field is retired from the wire; the panel streams its pane instead.
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/full-toolbar-git-status', gitStatus: { files: 54, staged: 2, unstaged: 51, untracked: 1, conflicted: 0, changes: [{ code: 'M ', path: 'apps/server/src/app.ts', additions: 1_212, deletions: 3 }, { code: ' M', path: 'apps/web/src/main.tsx', additions: 8, deletions: 2 }, { code: 'MM', path: 'apps/web/src/styles.css', additions: 5, deletions: 4 }, { code: ' M', path: 'apps/web/e2e/last-prompt.spec.ts', additions: 16, deletions: 5 }, { code: ' M', path: 'README.md', additions: 4, deletions: 1 }, { code: 'R ', path: 'docs/setup.md', originalPath: 'docs/install.md', additions: 3, deletions: 2 }, { code: '??', path: 'notes/release plan.md', additions: 9, deletions: 0 }, ...overflowChanges] }, gitPrStatus: { base: 'origin/main', files: 3, changes: [{ code: 'A ', path: 'apps/server/src/pr-only.ts', additions: 1_200, deletions: 0 }, { code: 'M ', path: 'apps/web/src/main.tsx', additions: 30, deletions: 4 }, { code: 'M ', path: 'docs/pr.md', additions: 5, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [{ id: 'prompt-history-001', text: longPrompt, createdAt: '2026-08-04T01:00:00.000Z' }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await expect(page.getByText('Last prompt:', { exact: false })).toHaveCount(0);
  // the recent-prompt text and the upper toolbar are gone; history lives in the composer row
  await expect(page.getByRole('button', { name: 'Last prompt', exact: true })).toHaveCount(0);
  await expect(page.locator('.toolbar-prompt')).toHaveCount(0);
  await expect(page.locator('.log-topbar')).toHaveCount(0);
  const history = page.getByRole('button', { name: 'Prompt history (1)' });
  const git = page.getByRole('button', { name: /^Git status:/u });
  await expect(history).toBeVisible();
  await expect(git).toBeVisible();

  await history.click();
  await expect(history).toHaveAttribute('aria-expanded', 'true');
  const historyPanel = page.getByLabel('Prompt history', { exact: true });
  await expect(historyPanel).toBeVisible();
  await expect(historyPanel).toContainText(longPrompt);
  await expect(git).toBeVisible();

  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await expect(historyPanel).toBeHidden();
  await page.setViewportSize({ width: 428, height: 420 });
  const collapsedGit = page.getByRole('button', { name: /^Git status:/u });
  await collapsedGit.tap();
  const expandedGit = page.getByRole('button', { name: /^Git status:/u });
  const changedFiles = page.getByRole('region', { name: 'Changed files' });
  await expect(expandedGit).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Prompt history (1)' })).toBeVisible();
  const gitView = changedFiles.getByRole('group', { name: 'Git change view' });
  const workingView = gitView.getByRole('button', { name: 'Working' });
  const prView = gitView.getByRole('button', { name: 'All PR' });
  await expect(prView).toHaveAttribute('aria-pressed', 'true');
  await expect(changedFiles).toContainText('PR changes');
  // omit the implied remote from the comparison label
  await expect(changedFiles).toContainText('Compared with main · 3 files · +1,235 −5');
  await expect(changedFiles).toContainText('apps/server/src/pr-only.ts');
  await expect(changedFiles).not.toContainText('notes/release plan.md');
  await workingView.tap();
  await expect(workingView).toHaveAttribute('aria-pressed', 'true');
  await expect(changedFiles).toContainText('Working changes');
  await expect(changedFiles).toContainText('2 staged files · 51 unstaged files · 1 untracked file');
  await expect(changedFiles).toContainText('apps/server/src/app.ts');
  await expect(changedFiles).toContainText('apps/web/src/main.tsx');
  await expect(changedFiles).toContainText('docs/install.md → docs/setup.md');
  await expect(changedFiles).toContainText('notes/release plan.md');
  const implementation = changedFiles.getByRole('group', { name: 'Implementation files' });
  const supporting = changedFiles.getByRole('group', { name: 'TESTS & DOCS files' });
  await expect(implementation.locator('.git-status-group-header')).toContainText('50 files+1,272−9');
  await expect(implementation.locator('.git-status-group-lines')).toHaveAttribute('aria-label', '1,272 lines added, 9 lines removed');
  await expect(implementation.locator('.git-status-file').first()).toContainText('apps/server/src/app.ts+1,212−3');
  await expect(supporting.locator('.git-status-group-header')).toContainText('4 files+32−8');
  await expect(supporting.locator('.git-status-file').first()).toContainText('apps/web/e2e/last-prompt.spec.ts+16−5');
  const zeroDeletion = implementation.locator('.git-status-file', { hasText: 'apps/server/src/generated-0.ts' });
  await expect(zeroDeletion.locator('.git-lines-added')).toHaveText('+1');
  await expect(zeroDeletion.locator('.git-lines-deleted')).toBeEmpty();
  const textSizes = await changedFiles.evaluate(element => ({
    group: getComputedStyle(element.querySelector<HTMLElement>('.git-status-group-header')!).fontSize,
    file: getComputedStyle(element.querySelector<HTMLElement>('.git-status-file')!).fontSize
  }));
  expect(textSizes).toEqual({ group: '16px', file: '9.92px' });
  const lineColumns = await changedFiles.locator('.git-status-group-lines, .git-status-file-lines').evaluateAll(elements => elements.slice(0, 8).map(element => {
    const added = element.querySelector<HTMLElement>('.git-lines-added')!.getBoundingClientRect();
    const deleted = element.querySelector<HTMLElement>('.git-lines-deleted')!.getBoundingClientRect();
    return { addedRight: added.right, deletedLeft: deleted.left };
  }));
  expect(new Set(lineColumns.map(columns => columns.addedRight.toFixed(1))).size).toBe(1);
  expect(new Set(lineColumns.map(columns => columns.deletedLeft.toFixed(1))).size).toBe(1);
  const groups = await changedFiles.locator('.git-status-group').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(groups).toEqual(['Implementation files', 'TESTS & DOCS files']);
  const changesHeader = changedFiles.locator('.git-status-panel-header');
  const changesContent = changedFiles.locator('.git-status-files');
  const changesFooter = changedFiles.locator('.git-status-panel-footer');
  // short viewports scroll the complete panel
  await expect(changesHeader).toHaveCSS('position', 'static');
  await expect(changesHeader.locator('.git-status-details')).toHaveCSS('text-align', 'right');
  await expect(changesContent).toHaveCSS('overflow-y', 'auto');
  await expect(changesFooter).toHaveCSS('position', 'static');
  await expect(changesFooter.getByRole('group', { name: 'Git change view' })).toBeVisible();
  const headerColumns = await changesHeader.evaluate(element => ({
    titleRight: element.querySelector('strong')!.getBoundingClientRect().right,
    detailsLeft: element.querySelector('.git-status-details')!.getBoundingClientRect().left
  }));
  expect(headerColumns.detailsLeft).toBeGreaterThan(headerColumns.titleRight);
  const overflow = await changesContent.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  const placement = await Promise.all([changedFiles, expandedGit].map(locator => locator.evaluate(element => { const bounds = element.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom }; })));
  expect(placement[0]!.top).toBeCloseTo(0, 0);
  expect(placement[0]!.bottom).toBeLessThanOrEqual(placement[1]!.top);
  const headerTop = (await changesHeader.boundingBox())!.y;
  const footerTop = (await changesFooter.boundingBox())!.y;
  await changesContent.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await changesContent.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect((await changesHeader.boundingBox())!.y).toBeCloseTo(headerTop, 0);
  expect((await changesFooter.boundingBox())!.y).toBeCloseTo(footerTop, 0);

  await expect(page.getByRole('button', { name: 'Collapse git status' })).toHaveCount(0);
  // dismiss through the click-blocking backdrop
  await page.touchscreen.tap(4, 4);
  await expect(changedFiles).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt history (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Prompt history (1)' }).click();
  await expect(page.getByLabel('Prompt history', { exact: true })).toContainText(longPrompt);
});
