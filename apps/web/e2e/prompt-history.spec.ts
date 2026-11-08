import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';

test('shows worktree prompt history and cycles it from the composer', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  let createdNotes = 0;
  const history = [
    { id: 'history-entry-002', text: 'Second prompt', createdAt: '2026-08-04T01:02:00.000Z', answer: '## Second final answer\n\n- completed successfully', answeredAt: '2026-08-04T01:02:30.000Z' },
    { id: 'history-entry-001', text: 'First prompt', createdAt: '2026-08-04T01:01:00.000Z' }
  ];
  let historyRequests = 0;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // track background history refreshes
    if (url.pathname === '/api/agents/agent-1/prompt-history' && request.method() === 'GET') {
      historyRequests += 1;
      return route.fulfill({ json: { prompts: history } });
    }
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-identifier-00${++createdNotes}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const prompt = (request.postDataJSON() as { prompt: string }).prompt;
      history.unshift({ id: `history-entry-${history.length + 1}`.padStart(17, '0'), text: prompt, createdAt: '2026-08-04T01:03:00.000Z' });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.addStyleTag({ content: '.prompt-history-list { max-height: 5rem; } .prompt-history-list button { min-height: 4rem; }' });
  // the recent-prompt text button is gone; history is reached from the composer-row icon
  await expect(page.getByRole('button', { name: 'Last prompt', exact: true })).toHaveCount(0);
  const historyToggle = page.getByRole('button', { name: 'Prompt history (2)' });
  // history sits above attach in the composer's left column
  const attach = page.getByRole('region', { name: 'Prompt composer' }).getByRole('button', { name: 'Attach files' });
  await expect(historyToggle).toBeVisible();
  const [historyBounds, attachBounds] = await Promise.all([historyToggle.boundingBox(), attach.boundingBox()]);
  expect(historyBounds).not.toBeNull();
  expect(attachBounds).not.toBeNull();
  expect(Math.abs(historyBounds!.x - attachBounds!.x)).toBeLessThanOrEqual(1);
  expect(historyBounds!.y + historyBounds!.height).toBeLessThanOrEqual(attachBounds!.y);
  await historyToggle.click();
  const historyMenu = page.getByLabel('Prompt history', { exact: true });
  const historyHeader = historyMenu.locator('header');
  const historyList = historyMenu.locator('.prompt-history-list');
  await expect(historyMenu).toBeVisible();
  await expect(historyHeader).toHaveCSS('position', 'sticky');
  await expect(historyList).toHaveCSS('overflow-y', 'auto');
  const historyPrompts = historyMenu.locator('.prompt-history-prompt');
  const answerButtons = historyMenu.locator('.prompt-history-answer-toggle');
  await expect(historyPrompts).toHaveCount(2);
  await expect(historyPrompts.first()).toContainText('First prompt');
  await expect(historyPrompts.last()).toContainText('Second prompt');
  await expect(historyPrompts.last().locator('span')).toHaveCSS('font-weight', '400');
  await expect(answerButtons).toHaveCount(2);
  await expect(answerButtons.first()).toBeDisabled();
  // simulate reading older prompts
  await historyList.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => historyList.evaluate(element => element.scrollTop)).toBe(0);
  const refreshBaseline = historyRequests;
  await expect.poll(() => historyRequests).toBeGreaterThanOrEqual(refreshBaseline + 2);
  expect(await historyList.evaluate(element => element.scrollTop)).toBe(0);
  await answerButtons.last().click();
  const secondAnswer = historyMenu.getByRole('region', { name: 'Answer for Second prompt' });
  await expect(secondAnswer).toContainText('## Second final answer\n\n- completed successfully');
  // observe the note creation
  const noteCreated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/worktrees/cora/notes' && response.request().method() === 'POST');
  await secondAnswer.getByRole('button', { name: 'Save as note' }).click();
  expect((await noteCreated).ok()).toBe(true);
  const notePane = page.getByRole('dialog', { name: 'Note' });
  await expect(historyMenu).toBeHidden();
  await expect(notePane.locator('.note-picker strong')).toHaveText('Second final answer');
  await expect(page.getByLabel('Note preview')).toContainText('Second final answer');
  await page.getByRole('button', { name: 'Close note' }).click();
  await historyToggle.click();
  await expect.poll(() => historyList.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
  Object.assign(history[1]!, { answer: 'First late answer', answeredAt: '2026-08-04T01:01:30.000Z' });
  await expect(answerButtons.first()).toBeEnabled({ timeout: 3_000 });
  await answerButtons.first().click();
  await expect(historyMenu.getByRole('region', { name: 'Answer for First prompt' }).locator('.prompt-history-answer-text')).toHaveText('First late answer');

  const composer = page.getByRole('textbox', { name: 'Prompt' });
  // dismiss through the click-blocking backdrop
  await page.locator('.flyout-backdrop').click({ position: { x: 4, y: 4 } });
  await composer.click();
  await expect(historyMenu).toBeHidden();
  await composer.fill('Current draft');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Current draft');

  await historyToggle.click();
  await expect.poll(() => historyMenu.locator('.prompt-history-list').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
  await historyMenu.locator('.prompt-history-prompt').first().click();
  await expect(composer).toHaveValue('First prompt');
  await expect(historyMenu).toBeHidden();

  await composer.fill('Third prompt');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const updatedHistoryToggle = page.getByRole('button', { name: 'Prompt history (3)' });
  await expect(updatedHistoryToggle).toBeVisible();
  await updatedHistoryToggle.click();
  await expect(historyMenu.locator('.prompt-history-prompt').first()).toContainText('First prompt');
  await expect(historyMenu.locator('.prompt-history-prompt').last()).toContainText('Third prompt');
  await expect.poll(() => historyMenu.locator('.prompt-history-list').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);

  // Escape closes the history popup
  await page.keyboard.press('Escape');
  await expect(historyMenu).toBeHidden();
  await expect(updatedHistoryToggle).toHaveAttribute('aria-expanded', 'false');
});
