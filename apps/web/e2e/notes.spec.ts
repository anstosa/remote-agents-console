import { expect, test, type Locator } from '@playwright/test';
import { chooseSplit } from './split-menu.js';

// require rendered layout geometry
const renderedBounds = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  // reject hidden layout targets
  if (bounds === null) throw new Error('Expected visible layout bounds');
  return bounds;
};

test('creates, previews, edits, autosaves, and deletes per-worktree notes', async ({ page }) => {
  test.setTimeout(60_000);
  const notes: Array<{ id: string; text: string }> = [];
  const savedTexts: string[] = [];
  let created = 0;
  let failNextSave = false;
  let failedSaves = 0;
  let failNextDelete = false;
  let failedDeletes = 0;
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
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const payload = request.postDataJSON() as { text: string };
      if (failNextSave) {
        failNextSave = false;
        failedSaves += 1;
        return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
      }
      const note = notes.find(candidate => candidate.id === noteMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      note.text = payload.text;
      savedTexts.push(payload.text);
      return route.fulfill({ json: note });
    }
    if (noteMatch && request.method() === 'DELETE') {
      if (failNextDelete) {
        failNextDelete = false;
        failedDeletes += 1;
        return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
      }
      const index = notes.findIndex(candidate => candidate.id === noteMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      return route.fulfill({ json: { ...notes.splice(index, 1)[0], undoToken: 'undo-deleted-note' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notesButton = page.getByRole('button', { name: 'Notes' });
  await expect(notesButton).toBeVisible();
  await expect(notesButton).toHaveAccessibleName('Notes (0)');
  await expect(notesButton.locator('.notes-icon-sheet')).toHaveAttribute('d', 'M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z');

  // creating a note must reveal it beside an expanded sibling
  await page.getByRole('button', { name: 'Expand agent output' }).click();
  await expect(page.getByRole('button', { name: 'Restore agent output' })).toBeVisible();
  await notesButton.click();
  await page.getByRole('button', { name: '+ New note' }).click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(pane).toBeVisible();
  await expect(notesButton.locator('.notes-count')).toHaveText('1');
  await expect(editor).toHaveValue('');
  await pane.evaluate(async element => await Promise.all(element.getAnimations().map(animation => animation.finished)));
  const outputPane = page.locator('.log-output');
  const divider = page.getByRole('separator', { name: 'Resize agent and note panels' });
  const [paneBounds, outputBounds, outputPaneBounds, dividerBounds] = await Promise.all([pane.boundingBox(), page.locator('.log').boundingBox(), outputPane.boundingBox(), divider.boundingBox()]);
  expect(outputBounds!.width).toBeGreaterThan(outputBounds!.height);
  expect(outputPaneBounds!.x).toBeCloseTo(outputBounds!.x, 0);
  expect(dividerBounds!.x).toBeCloseTo(outputPaneBounds!.x + outputPaneBounds!.width, 0);
  expect(paneBounds!.x).toBeCloseTo(dividerBounds!.x + dividerBounds!.width, 0);
  expect(outputPaneBounds!.width / outputBounds!.width).toBeGreaterThan(0.45);
  expect(outputPaneBounds!.width / outputBounds!.width).toBeLessThan(0.55);
  expect(paneBounds!.width / outputBounds!.width).toBeGreaterThan(0.45);
  expect(paneBounds!.width / outputBounds!.width).toBeLessThan(0.55);
  expect(paneBounds!.height / outputBounds!.height).toBeGreaterThan(0.95);
  expect(outputPaneBounds!.height / outputBounds!.height).toBeGreaterThan(0.95);

  const expandNote = page.getByRole('button', { name: 'Expand note' });
  await expect(expandNote).toHaveAttribute('aria-pressed', 'false');
  await expandNote.click();
  await expect(page.getByRole('button', { name: 'Restore note' })).toHaveAttribute('aria-pressed', 'true');
  const expandedBounds = await pane.boundingBox();
  expect(expandedBounds!.height / outputBounds!.height).toBeGreaterThan(0.95);
  expect(expandedBounds!.width / outputBounds!.width).toBeGreaterThan(0.95);
  await expect(outputPane).toBeHidden();
  await page.getByRole('button', { name: 'Restore note' }).click();
  await expect(page.getByRole('button', { name: 'Expand note' })).toHaveAttribute('aria-pressed', 'false');
  const restoredBounds = await pane.boundingBox();
  expect(restoredBounds!.width / outputBounds!.width).toBeGreaterThan(0.45);
  expect(restoredBounds!.width / outputBounds!.width).toBeLessThan(0.55);
  await expect(outputPane).toBeVisible();

  await page.getByLabel('Note preview').click();
  await editor.fill('Remember to review the migration plan carefully');
  await expect.poll(() => savedTexts).toContain('Remember to review the migration plan carefully');
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await editor.fill('Remember to review the migration plan carefully before unload');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => savedTexts).toContain('Remember to review the migration plan carefully before unload');
  await page.getByRole('button', { name: 'Close note' }).click();
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Remember to review the migration plan…', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ New note' }).click();
  failNextSave = true;
  await editor.fill('Second useful reminder');
  await page.getByRole('button', { name: 'Close note' }).click();
  await expect.poll(() => failedSaves).toBe(1);

  await notesButton.click();
  await page.getByRole('button', { name: 'Second useful reminder…', exact: true }).click();
  await expect.poll(() => savedTexts).toContain('Second useful reminder');
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await page.getByLabel('Note preview').click();
  await expect(editor).toBeFocused();
  await editor.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  await notesButton.click();
  await expect(page.locator('.notes-menu .note-choice')).toHaveCount(2);
  await expect(notesButton.locator('.notes-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Second useful reminder…', exact: true }).click();
  await page.getByLabel('Note preview').click();
  await expect(editor).toHaveValue('Second useful reminder');
  failNextSave = true;
  await editor.fill('Second useful reminder with a dirty delete');
  await expect.poll(() => failedSaves).toBe(2);
  failNextDelete = true;
  await page.getByRole('button', { name: 'Delete note' }).click();
  await expect.poll(() => failedDeletes).toBe(1);
  await expect(page.getByText('Unable to save', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notes (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Close note' }).click();
  await notesButton.click();
  await page.getByRole('button', { name: 'Second useful reminder with a dirty…', exact: true }).click();
  await page.getByLabel('Note preview').click();
  await expect(editor).toHaveValue('Second useful reminder with a dirty delete');
  await expect.poll(() => savedTexts).toContain('Second useful reminder with a dirty delete');
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete note' }).click();
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();
  await expect(notesButton.locator('.notes-count')).toHaveText('1');
  expect(notes).toEqual([{ id: 'note-identifier-001', text: 'Remember to review the migration plan carefully before unload' }]);
});

// preserve leftward note flyouts inside the output
test('opens note flyouts above the toolbar’s Notes button and shifts long menus onto the screen', async ({ page }) => {
  const originalTitle = 'W'.repeat(120);
  const notes = Array.from({ length: 4 }, (_, index) => ({ id: `note-identifier-${String(index + 1).padStart(3, '0')}`, text: `Sticky note option ${index + 1}`, ...(index === 0 ? { title: originalTitle } : {}) }));
  let visibleNotes: typeof notes = [];
  let renamedNote = '';
  let deletedNote = '';
  await page.setViewportSize({ width: 520, height: 600 });
  // serve the focused note layout fixture
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the active session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one idle worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // serve the log ticket
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // serve the active sticky note set
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: visibleNotes } });
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    // rename one sticky note
    if (noteMatch && request.method() === 'PATCH') {
      const title = (request.postDataJSON() as { title: string }).title;
      const note = visibleNotes.find(candidate => candidate.id === noteMatch[1]);
      // require the fixture note
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      note.title = title;
      renamedNote = title;
      return route.fulfill({ json: note });
    }
    // delete one sticky note
    if (noteMatch && request.method() === 'DELETE') {
      const noteId = noteMatch[1];
      // require the captured note identifier
      if (noteId === undefined) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      deletedNote = noteId;
      const index = visibleNotes.findIndex(candidate => candidate.id === noteId);
      // require the fixture note
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      return route.fulfill({ json: { ...visibleNotes.splice(index, 1)[0], undoToken: 'undo-deleted-note' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notesButton = page.getByRole('button', { name: 'Notes (0)' });
  await notesButton.click();
  const menu = page.getByLabel('Worktree notes');
  await expect(menu).toBeVisible();
  const [menuBounds, notesButtonBounds] = await Promise.all([renderedBounds(menu), renderedBounds(notesButton)]);
  // the Notes button sits at the left of the toolbar, so its flyout opens above it, lined up with
  // its left edge
  expect(Math.abs(menuBounds.x - notesButtonBounds.x)).toBeLessThanOrEqual(1);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(notesButtonBounds.y);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);

  visibleNotes = notes;
  await page.reload();
  const longMenuButton = page.getByRole('button', { name: 'Notes (4)', exact: true });
  await longMenuButton.click();
  const [longMenuBounds, longMenuButtonBounds] = await Promise.all([renderedBounds(menu), renderedBounds(longMenuButton)]);
  // a menu too wide to start at the button shifts left to stay on screen
  expect(longMenuBounds.width).toBeGreaterThan(288);
  expect(longMenuBounds.x).toBeGreaterThanOrEqual(8);
  expect(longMenuBounds.x).toBeLessThanOrEqual(longMenuButtonBounds.x);
  expect(longMenuBounds.x + longMenuBounds.width).toBeLessThanOrEqual(520 - 8 + 1);
  expect(longMenuBounds.y + longMenuBounds.height).toBeLessThanOrEqual(longMenuButtonBounds.y);
  expect(longMenuBounds.y).toBeGreaterThanOrEqual(0);

  await menu.getByRole('button', { name: `Rename note: ${originalTitle}` }).click();
  const noteName = menu.getByRole('textbox', { name: 'Note name' });
  await noteName.fill('Discarded title');
  await noteName.press('Escape');
  await expect(noteName).toBeHidden();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: `Rename note: ${originalTitle}` }).click();
  await noteName.fill('Release coordination checklist');
  await menu.getByRole('button', { name: 'Save note name' }).click();
  await expect.poll(() => renamedNote).toBe('Release coordination checklist');
  await expect(menu.getByRole('button', { name: 'Release coordination checklist', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Delete note: Release coordination checklist' }).click();
  await expect.poll(() => deletedNote).toBe('note-identifier-001');
  await expect(menu.getByRole('button', { name: 'Release coordination checklist', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Notes (3)', exact: true })).toBeVisible();
});

test('switches sticky notes between full-screen mobile panes and a horizontal desktop split', async ({ page }) => {
  const note = { id: 'note-identifier-001', text: 'Keep this note beside the output.' };
  await page.setViewportSize({ width: 428, height: 952 });
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Keep this note beside the output.…', exact: true }).click();
  const log = page.locator('.log');
  const output = page.locator('.log-output');
  // the agent panel's title and state ride in its floating header's top-left pill
  const outputStatus = output.locator('.panel-header .panel-header-title');
  const pane = page.getByRole('dialog', { name: 'Note' });
  await pane.evaluate(async element => await Promise.all(element.getAnimations().map(animation => animation.finished)));
  await expect(outputStatus).toHaveCount(1);
  await expect(page.locator('.log > .log-status')).toHaveCount(0);

  // show one full-size pane per screen on phones, with the toolbar's dots to move between them
  const splitTrigger = page.getByRole('group', { name: 'Panels' }).getByRole('button', { name: 'Choose split' });
  await expect(pane).toBeInViewport({ ratio: 0.99 });
  await expect(output).not.toBeInViewport();
  await expect(splitTrigger).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Resize agent and note panels' })).toBeHidden();
  await expect(pane.getByRole('button', { name: 'Expand note' })).toBeVisible();
  const mobileNote = await Promise.all([renderedBounds(log), renderedBounds(pane)]);
  expect(mobileNote[1].width / mobileNote[0].width).toBeGreaterThan(0.95);
  expect(mobileNote[1].height / mobileNote[0].height).toBeGreaterThan(0.95);

  await chooseSplit(page, 'Agent output');
  await expect(output).toBeInViewport({ ratio: 0.99 });
  await expect(pane).not.toBeInViewport();
  await expect(splitTrigger).toBeVisible();
  const mobileOutput = await Promise.all([renderedBounds(log), renderedBounds(output)]);
  expect(mobileOutput[1].width / mobileOutput[0].width).toBeGreaterThan(0.95);
  expect(mobileOutput[1].height / mobileOutput[0].height).toBeGreaterThan(0.95);
  await chooseSplit(page, 'Note');
  await expect(pane).toBeInViewport({ ratio: 0.99 });
  await expect(output).not.toBeInViewport();

  await page.getByLabel('Note preview').click();
  await expect(page.getByRole('textbox', { name: 'Note content' })).toBeFocused();
  await expect(output).not.toBeInViewport();

  await page.setViewportSize({ width: 1_000, height: 600 });
  await expect.poll(async () => {
    const bounds = await log.boundingBox();
    return bounds === null ? false : bounds.width > bounds.height;
  }).toBe(true);
  const divider = page.getByRole('separator', { name: 'Resize agent and note panels' });
  await expect(page.getByRole('button', { name: 'Expand note' })).toHaveAttribute('aria-pressed', 'false');
  const horizontal = await Promise.all([log.boundingBox(), output.boundingBox(), pane.boundingBox(), outputStatus.boundingBox(), divider.boundingBox()]);
  expect(horizontal[1]!.y).toBeCloseTo(horizontal[0]!.y, 0);
  expect(horizontal[2]!.y).toBeCloseTo(horizontal[0]!.y, 0);
  expect(horizontal[4]!.x).toBeCloseTo(horizontal[1]!.x + horizontal[1]!.width, 0);
  expect(horizontal[2]!.x).toBeCloseTo(horizontal[4]!.x + horizontal[4]!.width, 0);
  expect(horizontal[1]!.height / horizontal[0]!.height).toBeGreaterThan(0.95);
  expect(horizontal[2]!.height / horizontal[0]!.height).toBeGreaterThan(0.95);
  expect(horizontal[3]!.x).toBeGreaterThanOrEqual(horizontal[1]!.x);
  expect(horizontal[3]!.x - horizontal[1]!.x).toBeLessThanOrEqual(10);
  expect(horizontal[3]!.y).toBeGreaterThanOrEqual(horizontal[1]!.y);
  expect(horizontal[3]!.y - horizontal[1]!.y).toBeLessThanOrEqual(60);
});
