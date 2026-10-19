import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushMetadata } from './pane-stream-mock.js';

test('saves the newest response with at least fifty words and only highlights current overflowing replies', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const savedTexts: string[] = [];
  // define exact response-size boundaries
  const fortyNineWordResponse = Array.from({ length: 49 }, (_value, index) => `short-${index + 1}`).join(' ');
  const fiftyWordResponse = Array.from({ length: 50 }, (_value, index) => `boundary-${index + 1}`).join(' ');
  const firstResponse = ['Summary', '', '- Run `pnpm test` before saving', ...Array.from({ length: 24 }, (_value, index) => `- Detail ${index + 1}`)].join('\n');
  let historyAnswer = fortyNineWordResponse;
  let created = 0;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // return the current completed history fixture
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [{ id: 'prompt-history-001', text: 'Previous request', createdAt: '2026-08-12T12:00:00.000Z', answer: historyAnswer, answeredAt: '2026-08-12T12:01:00.000Z' }] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-identifier-00${++created}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.text = (request.postDataJSON() as { text: string }).text;
      savedTexts.push(note.text);
      return route.fulfill({ json: note });
    }
    if (noteMatch && request.method() === 'PATCH') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.title = (request.postDataJSON() as { title: string }).title;
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // The latest Turn arrives on the pane socket's metadata frame; seed the stream first.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const notesButton = page.getByRole('button', { name: 'Notes' });
  await expect(notesButton).toBeEnabled({ timeout: 15_000 });
  const emit = (message: string, overflow: boolean) => pushMetadata(page, 'agent-1', message, overflow);

  const saveLatest = page.getByRole('button', { name: 'Save latest response' });
  await emit('Short response', false);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await notesButton.click();
  await expect(saveLatest).toBeDisabled();
  // dismiss through the click-blocking backdrop
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });

  historyAnswer = fiftyWordResponse;
  await notesButton.click();
  await expect(saveLatest).toBeEnabled();
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });

  historyAnswer = firstResponse;
  await notesButton.click();
  await expect(saveLatest).toBeVisible();
  await saveLatest.click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  const noteTitle = pane.locator('.note-picker strong');
  await expect(noteTitle).toHaveText('Summary');
  // renaming is one of the note header's actions
  await pane.getByRole('button', { name: 'Rename note', exact: true }).click();
  const noteName = page.getByRole('textbox', { name: 'Note name' });
  await expect(noteName).toHaveValue('Summary');
  await noteName.fill('Release checklist');
  await page.getByRole('button', { name: 'Save note name' }).click();
  await expect(pane.locator('.note-picker strong')).toHaveText('Release checklist');
  const preview = page.getByLabel('Note preview');
  await expect(preview).toContainText('Summary');
  await expect(preview).toContainText('Detail 1');
  await expect(preview.locator('code')).toHaveText('pnpm test');
  await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toHaveValue(firstResponse);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await expect.poll(() => savedTexts).toContain(firstResponse);

  await page.getByRole('button', { name: 'Close note' }).click();
  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Release checklist', exact: true })).toBeVisible();
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });

  await emit(firstResponse, true);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await notesButton.click();
  await expect(saveLatest).toBeVisible();
  await expect(saveLatest).toBeDisabled();
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });

  const secondResponse = `${firstResponse}\n- New completion`;
  await emit(secondResponse, true);
  await expect(notesButton).toHaveClass(/latest-response-available/u);
  const dot = await notesButton.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { content: style.content, left: Number.parseFloat(style.left), top: Number.parseFloat(style.top), width: Number.parseFloat(style.width) };
  });
  expect(dot.content).not.toBe('none');
  expect(dot.left).toBeLessThan(8);
  expect(dot.top).toBeLessThan(8);
  expect(dot.width).toBeGreaterThan(0);

  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Save latest response' })).toBeVisible();
});
