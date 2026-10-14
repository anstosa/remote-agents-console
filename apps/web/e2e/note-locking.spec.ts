import { expect, test, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

type Note = { id: string; title: string; text: string; locked?: boolean };
type LockRequest = { id: string; locked: boolean; path: string };
type NoteLockFixture = {
  base: string;
  notes: Note[];
  lockRequests: LockRequest[];
  deletes: string[];
  prompts: Array<{ prompt: string; attachments: unknown[] }>;
  notesRevision: number;
  failLock: boolean;
  lockGate?: Promise<void>;
  releaseLock?: () => void;
};

// build one mutable worktree or scratch note fixture
const noteLockFixture = (context: 'worktree' | 'scratch', notes: Note[]): NoteLockFixture => ({
  base: context === 'worktree' ? '/api/worktrees/cora' : '/api/agents/scratch-1',
  notes,
  lockRequests: [],
  deletes: [],
  prompts: [],
  notesRevision: 0,
  failLock: false
});

// describe the agent that owns each notes persistence context
const dashboardAgent = (context: 'worktree' | 'scratch') => context === 'worktree'
  ? { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }
  : { id: 'scratch-1', sessionId: 'socket:$1', home: '/tmp/scratch', displayLabel: 'Scratch', title: 'Ready' };

// pause one lock acknowledgement so concurrent draft edits exercise stale-response merging
const holdNextLock = (fixture: NoteLockFixture) => {
  fixture.lockGate = new Promise<void>(resolve => { fixture.releaseLock = resolve; });
};

// serve one notes context with lock, text, delete and prompt boundaries
const mockNoteLocking = async (page: Page, fixture: NoteLockFixture, context: 'worktree' | 'scratch') => {
  await installDashboardSocket(page);

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate locally
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the selected persistence context
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, notesRevision: fixture.notesRevision, agents: [dashboardAgent(context)], projects: [] } });
    // enable controlled dashboard pushes
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the visible pane
    if (url.pathname === `/api/agents/${context === 'worktree' ? 'agent-1' : 'scratch-1'}/tickets`) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt resources
    if (/^\/api\/agents\/(?:agent-1|scratch-1)\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // list current note summaries
    if (url.pathname === `${fixture.base}/notes` && request.method() === 'GET') return route.fulfill({ json: { notes: fixture.notes } });
    const lockMatch = new RegExp(`^${fixture.base}/notes/([^/]+)/lock$`, 'u').exec(url.pathname);
    // toggle one note lock
    if (lockMatch !== null && request.method() === 'PUT') {
      const id = lockMatch[1] ?? '';
      const note = fixture.notes.find(candidate => candidate.id === id);
      const locked = (request.postDataJSON() as { locked: boolean }).locked;
      fixture.lockRequests.push({ id, locked, path: url.pathname });
      const staleText = note?.text ?? '';
      const gate = fixture.lockGate;
      fixture.lockGate = undefined;
      // wait for the controlled concurrent edit
      if (gate !== undefined) await gate;
      fixture.releaseLock = undefined;
      // preserve state after a failed toggle
      if (fixture.failLock) return route.fulfill({ status: 503, json: { error: 'temporary lock failure' } });
      // reject missing notes
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      // persist only true locks
      if (locked) note.locked = true;
      else delete note.locked;
      return route.fulfill({ json: { ...note, text: staleText } });
    }
    const noteMatch = new RegExp(`^${fixture.base}/notes/([^/]+)$`, 'u').exec(url.pathname);
    // autosave current note text
    if (noteMatch !== null && request.method() === 'PUT') {
      const note = fixture.notes.find(candidate => candidate.id === noteMatch[1]);
      // reject missing notes
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    // delete one unlocked note
    if (noteMatch !== null && request.method() === 'DELETE') {
      const id = noteMatch[1] ?? '';
      fixture.deletes.push(id);
      const index = fixture.notes.findIndex(candidate => candidate.id === id);
      const [note] = index < 0 ? [] : fixture.notes.splice(index, 1);
      return note === undefined ? route.fulfill({ status: 404, json: { error: 'missing' } }) : route.fulfill({ json: { ...note, undoToken: 'undo-deleted-note' } });
    }
    // capture locked-note prompt dispatches
    if (url.pathname === `/api/agents/${context === 'worktree' ? 'agent-1' : 'scratch-1'}/prompt` && request.method() === 'POST') {
      fixture.prompts.push(request.postDataJSON() as { prompt: string; attachments: unknown[] });
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// deliver one second-client note metadata mutation through the dashboard channel
const emitNotesRevision = async (page: Page, fixture: NoteLockFixture, context: 'worktree' | 'scratch') => {
  fixture.notesRevision += 1;
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitDashboard(page, { generation: 1, notesRevision: fixture.notesRevision, agents: [dashboardAgent(context)], projects: [] });
};

// open one named note from its sticky-note flyout
const openNote = async (page: Page, count: number, name: string) => {
  await page.getByRole('button', { name: `Notes (${count})` }).click();
  await page.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name: 'Note' });
};

// exercise the local lock lifecycle and protected note actions
test('locks notes without losing drafts, persists the guard, then unlocks before deletion', async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = noteLockFixture('worktree', [
    { id: 'note-editable-001', title: 'Editable note', text: 'Original note text' },
    { id: 'note-locked-002', title: 'Protected note', text: 'Protected text', locked: true }
  ]);
  await mockNoteLocking(page, fixture, 'worktree');
  await page.goto('/');

  const notesToggle = page.getByRole('button', { name: 'Notes (2)' });
  await notesToggle.click();
  const menu = page.getByLabel('Worktree notes');
  await expect(menu.getByRole('button', { name: 'Delete note: Editable note' })).toBeVisible();
  const protectedMarker = menu.getByRole('button', { name: 'Locked note: Protected note' });
  await expect(protectedMarker).toBeDisabled();
  await expect(protectedMarker).toHaveAttribute('title', /open.*unlock/iu);
  const lockedPath = await protectedMarker.locator('path').getAttribute('d');

  await menu.getByRole('button', { name: 'Editable note', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Note' });
  const lock = dialog.getByRole('button', { name: 'Lock note' });
  const remove = dialog.getByRole('button', { name: 'Delete note', exact: true });
  await expect(lock).toHaveText('');
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await expect(lock.locator('svg')).toBeVisible();
  const unlockedPath = await lock.locator('path').getAttribute('d');
  expect(unlockedPath).not.toBe(lockedPath);
  expect(await lock.evaluate(button => button.nextElementSibling?.getAttribute('aria-label'))).toBe('Delete note');

  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Draft before the lock response.');
  holdNextLock(fixture);
  await lock.click();
  await expect.poll(() => fixture.lockRequests).toEqual([{ id: 'note-editable-001', locked: true, path: '/api/worktrees/cora/notes/note-editable-001/lock' }]);
  await expect(remove).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close note' })).toBeDisabled();
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  await editor.fill('Newer draft typed while locking.');
  fixture.releaseLock?.();

  const unlockAfterLock = dialog.getByRole('button', { name: 'Unlock note' });
  await expect(unlockAfterLock).toBeVisible();
  await expect(unlockAfterLock).toHaveAttribute('aria-pressed', 'true');
  await expect(unlockAfterLock.locator('path')).toHaveAttribute('d', lockedPath ?? '');
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
  await expect(editor).toHaveValue('Newer draft typed while locking.');
  await expect(dialog.getByRole('button', { name: 'Send note as prompt' })).toBeEnabled();
  // capture the protected toolbar at phone and desktop widths
  for (const viewport of [{ label: 'phone', width: 320, height: 640 }, { label: 'desktop', width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    // phones fold secondary actions into More
    if (viewport.label === 'phone') {
      const more = dialog.getByRole('button', { name: 'More note actions', exact: true });
      await more.click();
      const actions = page.getByRole('group', { name: 'More note actions' });
      await expect(actions.getByRole('button', { name: 'Unlock note', exact: true })).toBeVisible();
      await more.press('Escape');
      await expect(actions).toHaveCount(0);
    } else await expect(dialog.getByRole('button', { name: 'Unlock note' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close note' })).toBeVisible();
    await dialog.screenshot({ path: test.info().outputPath(`locked-note-${viewport.label}.png`) });
  }
  await dialog.getByRole('button', { name: 'Send note as prompt' }).click();
  await expect.poll(() => fixture.prompts).toEqual([{ prompt: 'Newer draft typed while locking.', attachments: [] }]);
  await expect.poll(() => fixture.notes[0]?.text).toBe('Newer draft typed while locking.');

  await page.reload();
  await notesToggle.click();
  const persistedMarker = page.getByLabel('Worktree notes').getByRole('button', { name: 'Locked note: Editable note' });
  await expect(persistedMarker).toBeDisabled();
  await expect(persistedMarker.locator('path')).toHaveAttribute('d', lockedPath ?? '');
  await page.getByRole('button', { name: 'Editable note', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Note' });
  const unlock = dialog.getByRole('button', { name: 'Unlock note' });
  await unlock.click();
  await expect.poll(() => fixture.lockRequests.at(-1)).toEqual({ id: 'note-editable-001', locked: false, path: '/api/worktrees/cora/notes/note-editable-001/lock' });
  const relock = dialog.getByRole('button', { name: 'Lock note' });
  const unlockedDelete = dialog.getByRole('button', { name: 'Delete note', exact: true });
  await expect(relock).toHaveAttribute('aria-pressed', 'false');
  await expect(relock.locator('path')).toHaveAttribute('d', unlockedPath ?? '');
  await expect(unlockedDelete).toBeVisible();
  expect(await relock.evaluate(button => button.nextElementSibling?.getAttribute('aria-label'))).toBe('Delete note');
  await unlockedDelete.click();
  await expect.poll(() => fixture.deletes).toEqual(['note-editable-001']);
});

// merge remote lock metadata around one live local draft
test('refreshes second-client lock metadata without replacing the open draft', async ({ page }) => {
  const fixture = noteLockFixture('worktree', [{ id: 'note-remote-001', title: 'Remote guard', text: 'Server text before editing' }]);
  await mockNoteLocking(page, fixture, 'worktree');
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  const dialog = await openNote(page, 1, 'Remote guard');
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Unsaved local draft survives remote metadata.');
  expect(fixture.notes[0]?.text).toBe('Server text before editing');

  const remoteNote = fixture.notes[0];
  // require the fixture note before mutating it as another client
  if (remoteNote === undefined) throw new Error('remote note fixture missing');
  remoteNote.locked = true;
  await emitNotesRevision(page, fixture, 'worktree');
  await expect(dialog.getByRole('button', { name: 'Unlock note' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
  await expect(editor).toHaveValue('Unsaved local draft survives remote metadata.');

  const notesToggle = page.getByRole('button', { name: 'Notes (1)' });
  await notesToggle.click();
  const menu = page.getByLabel('Worktree notes');
  await expect(menu.getByRole('button', { name: 'Locked note: Remote guard' })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Delete note: Remote guard' })).toHaveCount(0);
  await page.locator('.flyout-backdrop').click();
  await expect(menu).toHaveCount(0);

  delete remoteNote.locked;
  await emitNotesRevision(page, fixture, 'worktree');
  await expect(dialog.getByRole('button', { name: 'Lock note' })).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toBeVisible();
  await expect(dialog.getByRole('document', { name: 'Note preview' })).toContainText('Unsaved local draft survives remote metadata.');
  await notesToggle.click();
  await expect(menu.getByRole('button', { name: 'Delete note: Remote guard' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Locked note: Remote guard' })).toHaveCount(0);
});

// retain protected blanks and confirmed state after rejected writes
test('retains locked blank notes on close and leaves failed lock attempts unchanged', async ({ page }) => {
  const fixture = noteLockFixture('worktree', [
    { id: 'note-blank-locked', title: 'Locked blank', text: '', locked: true },
    { id: 'note-failure-002', title: 'Lock failure', text: 'Keep this draft' }
  ]);
  await mockNoteLocking(page, fixture, 'worktree');
  await page.goto('/');

  let dialog = await openNote(page, 2, 'Locked blank');
  await expect(dialog.getByRole('button', { name: 'Unlock note' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close note' }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.deletes).toEqual([]);
  await page.getByRole('button', { name: 'Notes (2)' }).click();
  await expect(page.getByRole('button', { name: 'Locked note: Locked blank' })).toBeDisabled();

  await page.getByRole('button', { name: 'Lock failure', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Note' });
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Draft retained after lock failure.');
  fixture.failLock = true;
  await dialog.getByRole('button', { name: 'Lock note' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Lock note' })).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toBeVisible();
  await expect(dialog.getByRole('document', { name: 'Note preview' })).toContainText('Draft retained after lock failure.');
  expect(fixture.notes[1]?.locked).toBeUndefined();
});

// cover the scratch-specific lock resource boundary
test('toggles note locks through the scratch persistence context', async ({ page }) => {
  const fixture = noteLockFixture('scratch', [{ id: 'scratch-note-001', title: 'Scratch guard', text: 'Scratch note', locked: true }]);
  await mockNoteLocking(page, fixture, 'scratch');
  await page.goto('/');

  const dialog = await openNote(page, 1, 'Scratch guard');
  await dialog.getByRole('button', { name: 'Unlock note' }).click();
  await expect.poll(() => fixture.lockRequests).toEqual([{ id: 'scratch-note-001', locked: false, path: '/api/agents/scratch-1/notes/scratch-note-001/lock' }]);
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Lock note' }).click();
  await expect.poll(() => fixture.lockRequests.at(-1)).toEqual({ id: 'scratch-note-001', locked: true, path: '/api/agents/scratch-1/notes/scratch-note-001/lock' });
  await expect(dialog.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
});
