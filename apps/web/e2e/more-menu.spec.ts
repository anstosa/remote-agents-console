import { expect, test } from '@playwright/test';

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
  await expect(loadingActions).toBeDisabled();
  await expect(loadingActions).toHaveAttribute('aria-busy', 'true');
  await expect(loadingActions.locator('.skeleton')).toHaveCount(1);
  await expect(loadingActions).not.toHaveClass(/progress-border/u);
  await expect(loadingActions.locator('.update-progress-ring')).toHaveCount(0);
  finishGithubActions();
  await expect(menu.getByRole('link', { name: 'GitHub Actions', exact: true })).toHaveAttribute('href', 'https://github.com/octo/repo/actions');
  await page.keyboard.press('Escape');

  // new task now waits in the agent power flyout
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  const loadingNewTask = powerMenu.getByRole('menuitem', { name: 'Loading New Task availability', exact: true });
  await expect(loadingNewTask).toBeDisabled();
  await expect(loadingNewTask).toHaveAttribute('aria-busy', 'true');
  await expect(loadingNewTask.locator('.skeleton')).toHaveCount(1);
  await expect(loadingNewTask).not.toHaveClass(/progress-border/u);
  await expect(powerMenu.locator('.new-task-option .more-menu-reason')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(loadingNewTask.locator('.skeleton')).toHaveCount(1);
  expect(await loadingNewTask.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  finishNewTask();
  await expect(powerMenu.getByRole('menuitem', { name: 'New Task', exact: true })).toBeEnabled();
  await expect(powerMenu.locator('.new-task-option .more-menu-reason')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await attachmentShortcut.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });
  await expect(page.getByLabel('Selected attachments')).toContainText('notes.txt');
});
