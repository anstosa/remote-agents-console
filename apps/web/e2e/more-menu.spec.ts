import { expect, test } from '@playwright/test';
import { expectClockwiseProgressBorder, expectProgressBorder, expectReducedMotionSpinner } from './progress-border-assertions';

test('keeps attachments and repository choices out of the more menu', async ({ page }) => {
  let finishGithubActions!: () => void;
  let finishNewTask!: () => void;
  // hold secondary actions through loading assertions
  const githubActionsFinished = new Promise<void>(resolve => { finishGithubActions = resolve; });
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready', terminal: true, newTaskConfigured: true }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // delay the fixed menu actions
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') {
      await newTaskFinished;
      return route.fulfill({ json: { enabled: true } });
    }
    // delay the external actions link
    if (url.pathname === '/api/agents/agent-1/github-actions') {
      await githubActionsFinished;
      return route.fulfill({ json: { url: 'https://github.com/octo/repo/actions' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const attachmentShortcut = page.locator('.agent-composer-column').getByRole('button', { name: 'Attach files', exact: true });
  await expect(attachmentShortcut).toBeVisible();
  // the ⋮ of Place actions ends the Workspace toolbar
  const more = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' });
  await expect(page.locator('.workspace-toolbar-actions > :last-child').locator('svg')).toBeVisible();
  await more.click();
  const menu = page.locator('.more-menu');
  await expect(menu.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0);
  await expect(menu.getByText('Pull requests', { exact: true })).toHaveCount(0);
  await expect(menu.getByText('Branches', { exact: true })).toHaveCount(0);
  const loadingActions = menu.getByRole('button', { name: 'GitHub Actions', exact: true });
  await expectProgressBorder(loadingActions, 'blue');
  await expect(loadingActions.locator('.more-menu-icon')).toBeVisible();
  finishGithubActions();
  await expect(menu.getByRole('link', { name: 'GitHub Actions', exact: true })).toHaveAttribute('href', 'https://github.com/octo/repo/actions');
  await page.keyboard.press('Escape');

  // new task now waits in the agent power flyout
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  const loadingNewTask = powerMenu.getByRole('menuitem', { name: 'New Task', exact: true });
  await expectProgressBorder(loadingNewTask, 'blue', 'loading');
  await expectClockwiseProgressBorder(loadingNewTask, 'loading');
  await expect(loadingNewTask.locator('.more-menu-icon')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectReducedMotionSpinner(loadingNewTask, 'blue', 'loading');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectProgressBorder(loadingNewTask, 'blue', 'loading');
  await expectClockwiseProgressBorder(loadingNewTask, 'loading');
  finishNewTask();
  await expect(powerMenu.locator('.new-task-option .more-menu-reason')).toHaveText('Start a fresh task for this worktree.');
  await page.keyboard.press('Escape');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await attachmentShortcut.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });
  await expect(page.getByLabel('Selected attachments')).toContainText('notes.txt');
});
