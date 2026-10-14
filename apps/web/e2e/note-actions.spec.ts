import { expect, test } from '@playwright/test';

// tolerate the shared host's first Vite transform
test.setTimeout(90_000);

const sendPath = 'M22 2 11 13M22 2l-7 20-4-9-9-4Z';
const checkPath = 'm5 12 4 4L19 6';
const pencilPath = 'm4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3';
const trashPath = 'M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6';

test('copies a note and sends its current contents as a prompt', async ({ page }) => {
  let copied = '';
  let queuedPrompt: { prompt: string; attachments: unknown[] } | undefined;
  const note = { id: 'note-identifier-001', text: '' };

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as unknown as { __copiedNote: string }).__copiedNote = value; } }
    });
    Object.defineProperty(window, '__copiedNote', { configurable: true, writable: true, value: '' });
  });
  // control the two-second queued confirmation precisely
  await page.clock.install();
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', projectId: 'repo', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') return route.fulfill({ status: 201, json: note });
    if (url.pathname === `/api/worktrees/cora/notes/${note.id}` && request.method() === 'PUT') {
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // freeze wall time before exercising transient feedback
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await page.getByRole('button', { name: 'Notes (0)' }).click();
  await page.getByRole('button', { name: '+ New note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Note' });
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Use this exact note as the next prompt.');

  const copyButton = dialog.getByRole('button', { name: 'Copy note' });
  await expect(copyButton).toHaveText('');
  await expect(copyButton.locator('svg')).toBeVisible();
  await copyButton.click();
  const copiedButton = dialog.getByRole('button', { name: 'Note copied' });
  await expect(copiedButton).toHaveText('');
  await expect(copiedButton.locator('path')).toHaveAttribute('d', 'm5 12 4 4L19 6');
  await expect(dialog.getByText('Copied', { exact: true })).toHaveCount(0);
  copied = await page.evaluate(() => (window as unknown as { __copiedNote: string }).__copiedNote);
  expect(copied).toBe('Use this exact note as the next prompt.');
  await page.clock.fastForward(1_600);
  await expect(dialog.getByRole('button', { name: 'Copy note' })).toBeVisible();

  const send = dialog.getByRole('button', { name: 'Send note as prompt' });
  await expect(send).toHaveAttribute('title', 'Send note as prompt');
  await expect(send.locator('svg')).toBeVisible();
  await expect(send.locator('path')).toHaveAttribute('d', sendPath);
  await expect(send.locator('svg')).toHaveCSS('fill', 'none');
  await expect(send).toHaveCSS('background-image', /linear-gradient/);
  await send.click();
  await expect.poll(() => queuedPrompt).toEqual({ prompt: 'Use this exact note as the next prompt.', attachments: [] });
  const queued = dialog.getByRole('button', { name: 'Note queued', exact: true });
  await expect(queued).toBeVisible();
  await expect(queued.locator('path')).toHaveAttribute('d', checkPath);
  await expect(dialog.getByText('Queued', { exact: true })).toHaveCount(0);
  await page.clock.fastForward(1_999);
  await expect(queued).toBeVisible();
  await page.clock.fastForward(1);
  await expect(dialog.getByRole('button', { name: 'Send note as prompt', exact: true })).toBeVisible();

  const paneEdit = dialog.getByRole('button', { name: 'Rename note', exact: true });
  const paneDelete = dialog.getByRole('button', { name: 'Delete note', exact: true });
  await expect(paneEdit.locator('path')).toHaveAttribute('d', pencilPath);
  await expect(paneDelete.locator('path')).toHaveAttribute('d', trashPath);
  await expect(paneEdit.locator('svg')).toHaveCSS('fill', 'none');
  await expect(paneDelete.locator('svg')).toHaveCSS('fill', 'none');

  // reuse canonical menu actions
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  const menu = page.locator('.notes-menu');
  const menuEdit = menu.getByRole('button', { name: /^Rename note:/u });
  const menuDelete = menu.getByRole('button', { name: /^Delete note:/u });
  await expect(menuEdit.locator('path')).toHaveAttribute('d', pencilPath);
  await expect(menuDelete.locator('path')).toHaveAttribute('d', trashPath);
  await expect(menuEdit.locator('svg')).toHaveCSS('fill', 'none');
  await expect(menuDelete.locator('svg')).toHaveCSS('fill', 'none');

  // reuse the pencil beside the worktree in the launcher
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.locator('.new-agent-tab').click();
  const worktreeEdit = page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Rename Cora' });
  await expect(worktreeEdit.locator('path')).toHaveAttribute('d', pencilPath);
  await expect(worktreeEdit.locator('svg')).toHaveCSS('fill', 'none');
});
