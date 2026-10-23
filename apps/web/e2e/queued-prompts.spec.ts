import { expect, test } from '@playwright/test';

// verify queue editing, persistence and unread notes feedback
test('manages waiting prompts from the queue-add control connected to Queue', async ({ page }) => {
  const requested: string[] = [];
  const queued = [
    { id: 'queued-prompt-001', text: 'First queued prompt', createdAt: '2026-08-04T01:00:00.000Z' },
    { id: 'queued-prompt-002', text: 'Second queued prompt', createdAt: '2026-08-04T01:01:00.000Z', attachments: [{ name: 'context.txt', size: 7 }] }
  ];
  const saved: Array<{ id: string; text: string; attachments?: Array<{ name: string; size: number }> }> = [];
  const notes: Array<{ id: string; title: string; text: string }> = [];
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requested.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: '⠋ Working', attention: 'working' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: queued } });
    const saveMatch = /^\/api\/agents\/agent-1\/queued-prompts\/([^/]+)\/save$/u.exec(url.pathname);
    if (saveMatch && request.method() === 'POST') {
      const index = queued.findIndex(prompt => prompt.id === saveMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      const [prompt] = queued.splice(index, 1);
      const note = { id: `note-${prompt!.id}`, title: "10/18 7:37pm in 🥔 Flowchart: 'Edited queued prompt'", text: prompt!.text, source: 'queued-prompt' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const match = /^\/api\/agents\/agent-1\/queued-prompts\/([^/]+)(\/move)?$/u.exec(url.pathname);
    if (match?.[2] === '/move' && request.method() === 'POST') {
      const index = queued.findIndex(prompt => prompt.id === match[1]);
      const direction = (request.postDataJSON() as { direction: 'earlier' | 'later' }).direction;
      const next = direction === 'earlier' ? index - 1 : index + 1;
      if (index >= 0 && next >= 0 && next < queued.length) [queued[index], queued[next]] = [queued[next]!, queued[index]!];
      return route.fulfill({ json: { prompts: queued } });
    }
    if (match && request.method() === 'PUT') {
      const prompt = queued.find(candidate => candidate.id === match[1]);
      if (prompt === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      prompt.text = (request.postDataJSON() as { prompt: string }).prompt;
      return route.fulfill({ json: prompt });
    }
    if (match && request.method() === 'DELETE') {
      const index = queued.findIndex(prompt => prompt.id === match[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      queued.splice(index, 1);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const prompt = (request.postDataJSON() as { prompt: string }).prompt;
      queued.push({ id: `queued-prompt-00${queued.length + 1}`, text: prompt, createdAt: '2026-08-04T01:02:00.000Z' });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => requested).toContain('GET /api/agents/agent-1/queued-prompts');
  // the composer's right column: queued prompts above send
  const submissionControls = page.getByRole('group', { name: 'Prompt submission controls' });
  const queue = submissionControls.getByRole('button', { name: 'Queue', exact: true });
  const queueAdd = submissionControls.getByRole('button', { name: 'Queued prompts (2)' });
  await expect(queueAdd).toBeVisible();
  await expect(queueAdd).toHaveScreenshot('queue-add-control.png');
  const [queueBounds, queueAddBounds] = await Promise.all([queue.boundingBox(), queueAdd.boundingBox()]);
  expect(Math.abs(queueBounds!.x - queueAddBounds!.x)).toBeLessThanOrEqual(1);
  expect(queueAddBounds!.y + queueAddBounds!.height).toBeLessThanOrEqual(queueBounds!.y);

  await queueAdd.click();
  const menu = page.getByLabel('Queued prompts', { exact: true });
  const copies = menu.locator('.queued-prompt-copy');
  const positions = menu.locator('.queued-prompt-position');
  await expect(copies).toHaveCount(2);
  await expect(copies.first()).toContainText('First queued prompt');
  await expect(copies.last()).toContainText('Second queued prompt');
  await expect(copies.last()).toContainText('context.txt');
  await expect(positions).toHaveText(['1', '2']);
  await expect(menu).not.toContainText('Oldest runs first');
  // the menu spans its agent panel, inset by the flyout margin, rather than the whole viewport
  const [menuBounds, panelBounds] = await Promise.all([menu.boundingBox(), page.locator('.agent-panel').boundingBox()]);
  expect(Math.abs(menuBounds!.x - (panelBounds!.x + 8))).toBeLessThanOrEqual(1);
  expect(Math.abs(menuBounds!.width - (panelBounds!.width - 16))).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Move queued prompt earlier: Second queued prompt' }).click();
  await expect(copies.first()).toContainText('Second queued prompt');
  await expect(positions).toHaveText(['1', '2']);
  await copies.first().click();
  const editor = page.getByRole('textbox', { name: 'Edit queued prompt: Second queued prompt' });
  await editor.fill('Edited queued prompt');
  await page.getByRole('button', { name: 'Save queued prompt changes: Second queued prompt' }).click();
  await expect(copies.first()).toContainText('Edited queued prompt');

  const saveAsNote = page.getByRole('button', { name: 'Save queued prompt as note: Edited queued prompt' });
  await expect(saveAsNote).toHaveAttribute('title', 'Save as note');
  await saveAsNote.click();
  await expect(page.getByRole('button', { name: 'Queued prompts (1)' })).toBeVisible();
  await expect(copies).toHaveCount(1);
  expect(requested).toContain('POST /api/agents/agent-1/queued-prompts/queued-prompt-002/save');
  // dismiss through the click-blocking backdrop, then open Notes: the saved prompt is now a note
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });
  const notesButton = page.getByRole('button', { name: /^Notes \(/u });
  const notesBadge = notesButton.locator('.notes-count-other');
  await expect(notesButton).toHaveClass(/unread-queued-prompts/u);
  await expect(notesButton).toHaveCSS('color', 'rgb(243, 139, 168)');
  await expect(notesBadge).toHaveCSS('background-color', 'rgb(203, 166, 247)');
  await notesButton.click();
  await expect(page.getByLabel('Worktree notes')).toContainText("10/18 7:37pm in 🥔 Flowchart: 'Edited queued prompt'");
  await expect(notesButton).not.toHaveClass(/unread-queued-prompts/u);
  await expect(notesBadge).toHaveCSS('background-color', 'rgb(203, 166, 247)');

  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Third queued prompt');
  await queue.click();
  const updatedQueueAdd = page.getByRole('button', { name: 'Queued prompts (2)' });
  await expect(updatedQueueAdd).toBeVisible();
  // reopen the queue only when the previous action closed it
  if (!await menu.isVisible()) await updatedQueueAdd.click();
  await expect(menu).toBeVisible();
  await expect(copies.last()).toContainText('Third queued prompt');
  await page.getByRole('button', { name: 'Cancel queued prompt: First queued prompt' }).click();
  await expect(page.getByRole('button', { name: 'Queued prompts (1)' })).toBeVisible();
  await expect(copies).toHaveCount(1);
});
