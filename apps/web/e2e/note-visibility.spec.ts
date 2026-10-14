import { expect, test, type Locator, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

type Note = { id: string; title: string; text: string; allWorkspaces?: boolean };
type VisibilityRequest = { scope: string; path: string; allWorkspaces: boolean };
type NoteVisibilityFixture = {
  note: Note;
  origin: 'cora' | 'scratch-1';
  visibilityRequests: VisibilityRequest[];
  saveRequests: Array<{ scope: string; text: string }>;
  savedTexts: Array<{ scope: string; text: string }>;
  failNextVisibility: boolean;
  removed: boolean;
  deletes: string[];
  notesRevision: number;
  visibilityGate?: Promise<void>;
  releaseVisibility?: () => void;
  saveGate?: Promise<void>;
  releaseSave?: () => void;
};

// create one mutable visibility fixture
const noteVisibilityFixture = (origin: NoteVisibilityFixture['origin'] = 'cora'): NoteVisibilityFixture => ({
  note: { id: 'note-shared-001', title: 'Release handoff', text: 'Origin workspace draft' },
  origin,
  visibilityRequests: [],
  saveRequests: [],
  savedTexts: [],
  failNextVisibility: false,
  removed: false,
  deletes: [],
  notesRevision: 0
});

// pause one visibility response
const holdNextVisibility = (fixture: NoteVisibilityFixture) => {
  fixture.visibilityGate = new Promise<void>(resolve => { fixture.releaseVisibility = resolve; });
};

// pause one note save response
const holdNextSave = (fixture: NoteVisibilityFixture) => {
  fixture.saveGate = new Promise<void>(resolve => { fixture.releaseSave = resolve; });
};

// build the live two-workspace dashboard
const worktreeDashboard = (fixture: NoteVisibilityFixture) => ({ generation: 1, notesRevision: fixture.notesRevision, agents: [
  { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
  { id: 'agent-owen', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
], projects: [] });

// expose two workspaces around one origin note
const mockWorktreeVisibility = async (page: Page, fixture: NoteVisibilityFixture) => {
  await installDashboardSocket(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate locally
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose both workspaces
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: worktreeDashboard(fixture) });
    // enable controlled dashboard pushes
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize both agent panes
    if (/^\/api\/agents\/agent-(?:cora|owen)\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt resources
    if (/^\/api\/agents\/agent-(?:cora|owen)\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // accept notification dismissal
    if (/^\/api\/agents\/agent-(?:cora|owen)\/notifications\/dismiss$/u.test(url.pathname)) return route.fulfill({ status: 204 });
    const noteList = /^\/api\/worktrees\/(cora|owen)\/notes$/u.exec(url.pathname);
    // list the note where currently visible
    if (noteList !== null && request.method() === 'GET') {
      const scope = noteList[1] ?? '';
      const visible = !fixture.removed && (scope === fixture.origin || fixture.note.allWorkspaces === true);
      return route.fulfill({ json: { notes: visible ? [fixture.note] : [] } });
    }
    const visibility = /^\/api\/worktrees\/(cora|owen)\/notes\/([^/]+)\/visibility$/u.exec(url.pathname);
    // persist shared visibility in the addressed workspace
    if (visibility !== null && request.method() === 'PUT') {
      const scope = visibility[1] ?? '';
      const allWorkspaces = (request.postDataJSON() as { allWorkspaces: boolean }).allWorkspaces;
      fixture.visibilityRequests.push({ scope, path: url.pathname, allWorkspaces });
      const gate = fixture.visibilityGate;
      fixture.visibilityGate = undefined;
      // wait for the controlled pending state
      if (gate !== undefined) await gate;
      fixture.releaseVisibility = undefined;
      // preserve confirmed state on failure
      if (fixture.failNextVisibility) {
        fixture.failNextVisibility = false;
        return route.fulfill({ status: 503, json: { error: 'temporary visibility failure' } });
      }
      // require the expected fixture note
      if (visibility[2] !== fixture.note.id) return route.fulfill({ status: 404, json: { error: 'missing' } });
      // persist only enabled sharing
      if (allWorkspaces) fixture.note.allWorkspaces = true;
      else delete fixture.note.allWorkspaces;
      const visibleHere = scope === fixture.origin || fixture.note.allWorkspaces === true;
      return route.fulfill({ json: { ...fixture.note, visibleHere } });
    }
    const note = /^\/api\/worktrees\/(cora|owen)\/notes\/([^/]+)$/u.exec(url.pathname);
    // autosave through the current workspace
    if (note !== null && request.method() === 'PUT') {
      // require the expected fixture note
      if (note[2] !== fixture.note.id) return route.fulfill({ status: 404, json: { error: 'missing' } });
      const text = (request.postDataJSON() as { text: string }).text;
      fixture.saveRequests.push({ scope: note[1] ?? '', text });
      const gate = fixture.saveGate;
      fixture.saveGate = undefined;
      // wait for the controlled concurrent refresh
      if (gate !== undefined) await gate;
      fixture.releaseSave = undefined;
      fixture.note.text = text;
      fixture.savedTexts.push({ scope: note[1] ?? '', text });
      return route.fulfill({ json: fixture.note });
    }
    // delete the fixture note only through an explicit delete
    if (note !== null && request.method() === 'DELETE') {
      fixture.deletes.push(note[2] ?? '');
      fixture.removed = true;
      return route.fulfill({ json: { ...fixture.note, undoToken: 'undo-deleted-note' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// expose one scratch note at the agent persistence path
const mockScratchVisibility = async (page: Page, fixture: NoteVisibilityFixture) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate locally
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one scratch agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'scratch-1', sessionId: 'socket:$1', home: '/tmp/scratch', displayLabel: 'Scratch', title: 'Ready' }], projects: [] } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the scratch pane
    if (url.pathname === '/api/agents/scratch-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt resources
    if (/^\/api\/agents\/scratch-1\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // list the scratch note
    if (url.pathname === '/api/agents/scratch-1/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [fixture.note] } });
    // persist scratch sharing
    if (url.pathname === `/api/agents/scratch-1/notes/${fixture.note.id}/visibility` && request.method() === 'PUT') {
      const allWorkspaces = (request.postDataJSON() as { allWorkspaces: boolean }).allWorkspaces;
      fixture.visibilityRequests.push({ scope: 'scratch-1', path: url.pathname, allWorkspaces });
      // persist only enabled sharing
      if (allWorkspaces) fixture.note.allWorkspaces = true;
      else delete fixture.note.allWorkspaces;
      return route.fulfill({ json: { ...fixture.note, visibleHere: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// open the fixture note from the notes flyout
const openNote = async (page: Page) => {
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Release handoff', exact: true }).click();
  return page.getByRole('dialog', { name: 'Note' });
};

// open the visibility row from the note actions menu
const openVisibilityOption = async (dialog: Locator, page: Page) => {
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  return page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Show in all workspaces', exact: true });
};

test('shares a note across workspaces, edits it there, then unshares without deleting the origin', async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = noteVisibilityFixture();
  await mockWorktreeVisibility(page, fixture);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  let dialog = await openNote(page);
  let visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'false');
  await visibilityOption.click();
  await expect.poll(() => fixture.visibilityRequests).toEqual([{ scope: 'cora', path: '/api/worktrees/cora/notes/note-shared-001/visibility', allWorkspaces: true }]);
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');

  // capture the confirmed option at desktop width
  visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('shared-note-desktop.png'), fullPage: true });
  await visibilityOption.press('Escape');

  // capture the same confirmed option at phone width
  await page.setViewportSize({ width: 390, height: 844 });
  visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('shared-note-mobile.png'), fullPage: true });
  await visibilityOption.press('Escape');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('tab', { name: /^Owen —/u }).click();
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
  dialog = await openNote(page);
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Edited from the second workspace');
  await expect.poll(() => fixture.savedTexts).toContainEqual({ scope: 'owen', text: 'Edited from the second workspace' });

  await page.reload();
  dialog = page.getByRole('dialog', { name: 'Note' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');
  visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'true');
  await visibilityOption.click();
  await expect.poll(() => fixture.visibilityRequests.at(-1)).toEqual({ scope: 'owen', path: '/api/worktrees/owen/notes/note-shared-001/visibility', allWorkspaces: false });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes (0)' })).toBeVisible();

  await page.getByRole('tab', { name: /^Cora —/u }).click();
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Release handoff', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Note' });
  await expect(dialog).toContainText('Edited from the second workspace');
  await expect(dialog.locator('.panel-header-sub')).toHaveText('Note');
  visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'false');
});

test('keeps the confirmed visibility and live draft after a rejected change', async ({ page }) => {
  const fixture = noteVisibilityFixture();
  fixture.failNextVisibility = true;
  await mockWorktreeVisibility(page, fixture);
  await page.goto('/');

  const dialog = await openNote(page);
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Draft survives failed sharing');
  holdNextVisibility(fixture);
  const visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'false');
  await visibilityOption.click();
  await expect.poll(() => fixture.visibilityRequests).toHaveLength(1);
  await expect(dialog.getByRole('button', { name: 'Close note' })).toBeDisabled();
  await expect(dialog.getByRole('document', { name: 'Note preview' })).toContainText('Draft survives failed sharing');
  fixture.releaseVisibility?.();

  await expect(dialog.getByRole('alert')).toHaveText('Unable to change note visibility. Your draft is preserved. Please try again.');
  await dialog.getByRole('document', { name: 'Note preview' }).click();
  await expect(editor).toHaveValue('Draft survives failed sharing');
  const confirmedOption = await openVisibilityOption(dialog, page);
  await expect(confirmedOption).toHaveAttribute('aria-pressed', 'false');
  expect(fixture.note.allWorkspaces).toBeUndefined();
});

test('retains an empty shared note when its pane closes', async ({ page }) => {
  const fixture = noteVisibilityFixture();
  fixture.note.text = '';
  fixture.note.allWorkspaces = true;
  await mockWorktreeVisibility(page, fixture);
  await page.goto('/');

  const dialog = await openNote(page);
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');
  await dialog.getByRole('button', { name: 'Close note' }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.deletes).toEqual([]);
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
});

test('closes a clean shared note removed remotely from the current workspace', async ({ page }) => {
  const fixture = noteVisibilityFixture();
  fixture.note.allWorkspaces = true;
  await mockWorktreeVisibility(page, fixture);
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  await page.getByRole('tab', { name: /^Owen —/u }).click();
  const dialog = await openNote(page);
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');
  delete fixture.note.allWorkspaces;
  fixture.notesRevision += 1;
  await emitDashboard(page, worktreeDashboard(fixture));

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes (0)' })).toBeVisible();
  await page.getByRole('tab', { name: /^Cora —/u }).click();
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
});

test('refreshes clean shared text but preserves a dirty local draft', async ({ page }) => {
  const fixture = noteVisibilityFixture();
  fixture.note.allWorkspaces = true;
  await mockWorktreeVisibility(page, fixture);
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  await page.getByRole('tab', { name: /^Owen —/u }).click();
  const dialog = await openNote(page);
  fixture.note.text = 'Remote clean revision';
  fixture.notesRevision += 1;
  await emitDashboard(page, worktreeDashboard(fixture));
  await expect(dialog.getByRole('document', { name: 'Note preview' })).toContainText('Remote clean revision');

  await dialog.getByRole('document', { name: 'Note preview' }).click();
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  holdNextSave(fixture);
  await editor.fill('Unsaved local revision');
  await expect.poll(() => fixture.saveRequests).toContainEqual({ scope: 'owen', text: 'Unsaved local revision' });
  fixture.note.text = 'Conflicting remote revision';
  fixture.notesRevision += 1;
  await emitDashboard(page, worktreeDashboard(fixture));
  await expect(editor).toHaveValue('Unsaved local revision');
  fixture.releaseSave?.();
  await expect.poll(() => fixture.savedTexts).toContainEqual({ scope: 'owen', text: 'Unsaved local revision' });
});

test('uses the scratch persistence path for the same visibility option', async ({ page }) => {
  const fixture = noteVisibilityFixture('scratch-1');
  await mockScratchVisibility(page, fixture);
  await page.goto('/');

  const dialog = await openNote(page);
  const visibilityOption = await openVisibilityOption(dialog, page);
  await expect(visibilityOption).toHaveAttribute('aria-pressed', 'false');
  await visibilityOption.click();
  await expect.poll(() => fixture.visibilityRequests).toEqual([{ scope: 'scratch-1', path: '/api/agents/scratch-1/notes/note-shared-001/visibility', allWorkspaces: true }]);
  await expect(dialog.locator('.panel-header-sub')).toHaveText('All workspaces');
});
