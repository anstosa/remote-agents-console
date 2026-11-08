import { expect, test } from '@playwright/test';

test('restores each workspace open note and fullscreen state after switching tabs', async ({ page }) => {
  const notes = {
    cora: [{ id: 'note-cora-000001', text: 'Cora retained note' }],
    owen: [{ id: 'note-owen-000001', text: 'Owen retained note' }]
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-owen', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-(?:cora|owen)\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-(?:cora|owen)\/notifications\/dismiss$/u.test(url.pathname)) return route.fulfill({ status: 204 });
    const noteList = /^\/api\/worktrees\/(cora|owen)\/notes$/u.exec(url.pathname);
    if (noteList && request.method() === 'GET') return route.fulfill({ json: { notes: notes[noteList[1] as keyof typeof notes] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Note' });
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Cora retained note…', exact: true }).click();
  await expect(dialog).toContainText('Cora retained note');
  await page.getByRole('button', { name: 'Expand note' }).click();
  await expect(dialog).toHaveClass(/expanded/u);

  await page.getByRole('tab', { name: 'Owen — Prompt done' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Owen retained note…', exact: true }).click();
  await expect(dialog).toContainText('Owen retained note');
  await expect(page.getByRole('button', { name: 'Expand note' })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(dialog).toContainText('Cora retained note');
  await expect(dialog).toHaveClass(/expanded/u);
  await expect(page.getByRole('button', { name: 'Restore note' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Owen — Prompt done' }).click();
  await expect(dialog).toContainText('Owen retained note');
  await expect(dialog).not.toHaveClass(/expanded/u);
  await expect(page.getByRole('button', { name: 'Expand note' })).toHaveAttribute('aria-pressed', 'false');

  await page.reload();
  await expect(dialog).toContainText('Owen retained note');
  await expect(dialog).not.toHaveClass(/expanded/u);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(dialog).toContainText('Cora retained note');
  await expect(dialog).toHaveClass(/expanded/u);
});
