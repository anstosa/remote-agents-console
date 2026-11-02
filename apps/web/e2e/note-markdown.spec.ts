import { expect, test } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock.js';

// preserve both table formats and existing note interactions
test('renders saved notes with stable tables, lists, links, selection actions, and inferred select/edit modes', async ({ page }) => {
  const markdown = [
    '# Release notes',
    '',
    'Review **carefully** and use [the guide](https://example.com/docs).',
    '',
    '- ~~First item~~',
    '- [x] Verified',
    '',
    '1. First ordered item',
    '',
    '2. ~Second ordered item~',
    '   with a continuation line',
    '3. Third ordered item',
    '   - ~Nested detail~',
    '',
    'Bare links work at https://example.com/bare and www.example.org/docs.',
    'Open [the worktree](#worktree=wt%3A1) here.',
    'Keep ~literal tildes~ outside lists.',
    '',
    '> Important',
    '',
    '```ts',
    'const ready = true;',
    '```',
    '',
    '<script>window.__noteScriptRan = true</script>',
    '',
    ' Area                 Your console        Competitive',
    '                                          position',
    '━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━',
    ' Remote/mobile        Browser, PWA,       Strong; better',
    ' supervision          voice, software     than most',
    '                      keyboard, push      terminal-only',
    '                      alerts              tools',
    '───────────────────  ──────────────────  ───────────────────',
    ' Existing-session     Automatically       Major advantage;',
    ' discovery            finds Codex/OMX     many competitors',
    '                      tmux sessions       only understand',
    '                                          sessions they',
    '                                          created',
    '───────────────────  ──────────────────  ───────────────────',
    ' Durable history      Notes and saved     Behind',
    '                      prompts',
    '',
    '| Feature | State |',
    '| --- | --- |',
    '| Markdown tables | Rendered |'
  ].join('\n');
  const note = { id: 'note-identifier-001', text: markdown };

  await installPaneMock(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as unknown as { __copiedNoteSelection: string }).__copiedNoteSelection = value; } }
    });
    Object.defineProperty(window, '__copiedNoteSelection', { configurable: true, writable: true, value: '' });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === `/api/worktrees/cora/notes/${note.id}` && request.method() === 'PUT') {
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.locator('.notes-menu .note-choice').click();

  const preview = page.getByLabel('Note preview');
  await expect(preview).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Note' })).toContainText('Note');
  await expect(page.getByRole('dialog', { name: 'Worktree note' })).toHaveCount(0);
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(?:Edit|Select) note$/u })).toHaveCount(0);
  const outputFontSize = await page.locator('.log-canvas .xterm').evaluate(element => getComputedStyle(element).fontSize);
  await expect(preview).toHaveCSS('font-size', outputFontSize);
  await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  await expect(preview.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('carefully');
  await expect(preview.getByRole('link', { name: 'the guide' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(preview.getByRole('link', { name: 'https://example.com/bare' })).toHaveAttribute('href', 'https://example.com/bare');
  await expect(preview.getByRole('link', { name: 'www.example.org/docs' })).toHaveAttribute('href', 'https://www.example.org/docs');
  await expect(preview.getByRole('link', { name: 'the worktree' })).toHaveAttribute('href', '#worktree=wt%3A1');
  await expect(preview.getByRole('link', { name: 'the worktree' })).not.toHaveAttribute('target');
  await expect(preview.locator(':scope > ul > li')).toHaveCount(2);
  await expect(preview.locator(':scope > ol')).toHaveCount(1);
  await expect(preview.locator(':scope > ol > li')).toHaveText([
    'First ordered item',
    'Second ordered item with a continuation line',
    'Third ordered itemNested detail'
  ]);
  await expect(preview.locator(':scope > ol > li').nth(2).locator('ul > li')).toHaveText('Nested detail');
  await expect(preview.locator('li del')).toHaveText(['First item', 'Second ordered item', 'Nested detail']);
  await expect(preview.locator('del')).toHaveCount(3);
  await expect(preview.locator('li del').first()).toHaveCSS('text-decoration-line', 'line-through');
  await expect(preview).toContainText('Keep ~literal tildes~ outside lists.');
  await expect(preview.getByRole('checkbox')).toBeChecked();
  await expect(preview.locator('blockquote')).toHaveText('Important');
  await expect(preview.locator('pre code')).toHaveText('const ready = true;');
  await expect(preview).toContainText('<script>window.__noteScriptRan = true</script>');
  await expect(page.locator('.note-markdown script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noteScriptRan?: boolean }).__noteScriptRan)).toBeUndefined();
  await expect(preview.getByRole('table')).toHaveCount(2);
  const table = preview.getByRole('table').first();
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Area', 'Your console', 'Competitive position']);
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText(['Remote/mobile supervision', 'Browser, PWA, voice, software keyboard, push alerts', 'Strong; better than most terminal-only tools']);
  await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Existing-session discovery', 'Automatically finds Codex/OMX tmux sessions', 'Major advantage; many competitors only understand sessions they created']);
  await expect(table.getByRole('row').nth(3).getByRole('cell')).toHaveText(['Durable history', 'Notes and saved prompts', 'Behind']);
  const pipeTable = preview.getByRole('table').nth(1);
  await expect(pipeTable.getByRole('columnheader')).toHaveText(['Feature', 'State']);
  await expect(pipeTable.getByRole('cell')).toHaveText(['Markdown tables', 'Rendered']);
  const scrollRange = await preview.evaluate(element => element.scrollHeight - element.clientHeight);
  expect(scrollRange).toBeGreaterThan(0);
  await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await preview.evaluate(element => { element.scrollTop = 0; });

  await preview.locator('p').first().evaluate(element => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Review carefully');
  const selectionActions = page.getByRole('toolbar', { name: 'Note selection actions' });
  await expect(selectionActions).toBeVisible();
  await expect(selectionActions.getByRole('button', { name: 'Create note' })).toHaveCount(0);
  await expect(selectionActions.getByRole('button', { name: 'Append to note' })).toHaveCount(0);
  await expect(selectionActions.getByRole('button', { name: 'Add to prompt' })).toBeVisible();
  await expect(selectionActions.getByRole('button', { name: 'Copy' })).toBeVisible();
  await selectionActions.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Review carefully and use the guide.');
  await selectionActions.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedNoteSelection: string }).__copiedNoteSelection)).toBe('Review carefully and use the guide.');
  await expect(preview).toHaveClass(/selection-copied/u);
  await expect(preview).not.toHaveClass(/selection-copied/u);

  await preview.click();
  await expect(preview).toBeVisible();
  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('font-size', outputFontSize);
  await expect(editor).toHaveValue(markdown);
  await page.getByRole('button', { name: 'Copy note' }).focus();
  await expect(preview).toBeVisible();

  // a very narrow note folds its secondary actions into the header ⋮, so its actions stay on screen
  await page.setViewportSize({ width: 240, height: 640 });
  const toolbar = page.getByRole('toolbar', { name: 'Note actions' });
  await expect(toolbar.getByRole('button', { name: 'More note actions' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Close note' })).toBeInViewport({ ratio: 1 });
  const bounds = await toolbar.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(240);
  // the title pill shrinks rather than sliding under the actions
  const title = await page.getByRole('dialog', { name: 'Note' }).locator('.panel-header-title').boundingBox();
  expect(title!.x + title!.width).toBeLessThanOrEqual(bounds!.x);
});
