import { expect, test } from '@playwright/test';

test('deletes empty and whitespace-only notes when they are closed', async ({ page }) => {
  const notes: Array<{ id: string; text: string }> = [];
  let created = 0;
  const deleted: string[] = [];

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const match = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (match && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === match[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    if (match && request.method() === 'DELETE') {
      deleted.push(match[1]!);
      const index = notes.findIndex(candidate => candidate.id === match[1]);
      const [note] = index < 0 ? [] : notes.splice(index, 1);
      return note === undefined ? route.fulfill({ status: 404, json: { error: 'missing' } }) : route.fulfill({ json: { ...note, undoToken: 'undo-deleted-note' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notesButton = page.getByRole('button', { name: 'Notes (0)' });
  await notesButton.click();
  await page.getByRole('button', { name: '+ New note' }).click();
  await page.getByRole('button', { name: 'Close note' }).click();
  await expect.poll(() => deleted).toEqual(['note-identifier-001']);
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  await notesButton.click();
  await page.getByRole('button', { name: '+ New note' }).click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('   \n\t');
  await editor.press('Escape');
  await expect.poll(() => deleted).toEqual(['note-identifier-001', 'note-identifier-002']);
  await expect(page.getByRole('dialog', { name: 'Note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes (0)' })).toBeFocused();
});
