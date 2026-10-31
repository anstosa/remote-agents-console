import { expect, test, type Locator, type Page } from '@playwright/test';

// tolerate the shared host's first Vite transform
test.setTimeout(90_000);

type Note = {
  id: string;
  text: string;
  title?: string;
  allWorkspaces?: boolean;
  attachments?: Array<{ name: string; size: number }>;
};

type DeletedNote = { worktreeId: string; note: Note; order: number };

type NoteApi = {
  notes: Record<string, Note[]>;
  deletes: string[];
  undos: string[];
  puts?: Array<{ noteId: string; text: string }>;
  patches?: Array<{ noteId: string; title: string }>;
  listSnapshots?: Note[][];
  failDelete: boolean;
  failUndo: boolean;
  undoGate?: Promise<void>;
  putGate?: Promise<void>;
  patchGate?: Promise<void>;
  listGate?: Promise<void>;
  malformedDelete?: 'missing-token' | 'wrong-id';
};

// clone fixture values so restored metadata cannot share mutable references
const clone = <Value,>(value: Value): Value => structuredClone(value);

// find the toast for one specific deletion
const deletionToast = (page: Page, name: string): Locator => page.locator('.toast').filter({ hasText: `Note “${name}” was deleted` });

// serve two workspaces and the delete/undo contract
const mockNotes = async (page: Page, api: NoteApi) => {
  const deleted = new Map<string, DeletedNote>();
  const originalOrder = new Map(Object.entries(api.notes).flatMap(([worktreeId, notes]) => notes.map((note, index) => [`${worktreeId}:${note.id}`, index] as const)));
  let tokenSequence = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate this browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose two active workspaces so a toast can survive a switch
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-owen', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
    ], projects: [] } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-(?:cora|owen)\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-(?:cora|owen)\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // return each workspace's current note list
    const listMatch = /^\/api\/worktrees\/(cora|owen)\/notes$/u.exec(url.pathname);
    if (listMatch && request.method() === 'GET') {
      // capture the server view before a controlled response delay
      const snapshot = clone(api.notes[listMatch[1]!] ?? []);
      api.listSnapshots?.push(snapshot);
      await api.listGate;
      return route.fulfill({ json: { notes: snapshot } });
    }
    // delete one note and return its server-owned undo token
    const deleteMatch = /^\/api\/worktrees\/(cora|owen)\/notes\/([^/]+)$/u.exec(url.pathname);
    if (deleteMatch && request.method() === 'PUT') {
      const note = (api.notes[deleteMatch[1]!] ?? []).find(candidate => candidate.id === deleteMatch[2]);
      // require one current fixture note
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      const text = (request.postDataJSON() as { text: string }).text;
      api.puts?.push({ noteId: note.id, text });
      // hold the write after the request has captured its text
      await api.putGate;
      note.text = text;
      return route.fulfill({ json: clone(note) });
    }
    if (deleteMatch && request.method() === 'PATCH') {
      const note = (api.notes[deleteMatch[1]!] ?? []).find(candidate => candidate.id === deleteMatch[2]);
      // require one current fixture note
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      const title = (request.postDataJSON() as { title: string }).title;
      api.patches?.push({ noteId: note.id, title });
      // hold the rename after the request has captured its title
      await api.patchGate;
      note.title = title;
      return route.fulfill({ json: clone(note) });
    }
    if (deleteMatch && request.method() === 'DELETE') {
      // reject untyped mutations as the production chunked transport does
      if (request.headers()['content-type'] !== 'application/json' || request.postData() !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      const worktreeId = deleteMatch[1]!;
      const noteId = deleteMatch[2]!;
      api.deletes.push(`${worktreeId}:${noteId}`);
      if (api.failDelete) return route.fulfill({ status: 503, json: { error: 'temporary delete failure' } });
      const notes = api.notes[worktreeId] ?? [];
      const index = notes.findIndex(note => note.id === noteId);
      // reject stale fixture deletes
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      // exercise malformed successful responses without mutating fixture storage
      if (api.malformedDelete === 'missing-token') return route.fulfill({ json: clone(notes[index]!) });
      if (api.malformedDelete === 'wrong-id') return route.fulfill({ json: { ...clone(notes[index]!), id: 'note-identifier-wrong', undoToken: `undo-token-${++tokenSequence}` } });
      const [note] = notes.splice(index, 1);
      const undoToken = `undo-token-${++tokenSequence}`;
      deleted.set(undoToken, { worktreeId, note: clone(note!), order: originalOrder.get(`${worktreeId}:${noteId}`) ?? index });
      return route.fulfill({ json: { ...clone(note!), undoToken } });
    }
    // restore only the snapshot represented by this token
    const undoMatch = /^\/api\/notes\/deletions\/([^/]+)\/undo$/u.exec(url.pathname);
    if (undoMatch && request.method() === 'POST') {
      // exercise the same parser boundary before restoring any snapshot
      if (request.headers()['content-type'] !== 'application/json' || request.postData() !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      const token = undoMatch[1]!;
      api.undos.push(token);
      // expose pending restore feedback when a test supplies a response gate
      await api.undoGate;
      if (api.failUndo) return route.fulfill({ status: 503, json: { error: 'temporary restore failure' } });
      const snapshot = deleted.get(token);
      // reject consumed or unknown tokens
      if (snapshot === undefined) return route.fulfill({ status: 404, json: { error: 'note deletion unavailable' } });
      const restored = clone(snapshot.note);
      const notes = api.notes[snapshot.worktreeId] ?? (api.notes[snapshot.worktreeId] = []);
      const index = notes.findIndex(note => (originalOrder.get(`${snapshot.worktreeId}:${note.id}`) ?? Number.MAX_SAFE_INTEGER) > snapshot.order);
      notes.splice(index < 0 ? notes.length : index, 0, restored);
      deleted.delete(token);
      return route.fulfill({ json: restored });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

test('undoes a pane deletion with all note metadata after switching workspaces', async ({ page }) => {
  const original: Note = {
    id: 'note-identifier-001',
    title: 'Release evidence',
    text: 'Keep the release evidence with its attachment.',
    allWorkspaces: true,
    attachments: [{ name: 'evidence.md', size: 42 }]
  };
  const api: NoteApi = { notes: { cora: [clone(original)], owen: [] }, deletes: [], undos: [], failDelete: false, failUndo: false };
  await page.clock.install();
  await mockNotes(page, api);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // freeze wall time before starting the five-second undo window
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Release evidence', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  await pane.getByLabel('Note preview').click();
  await pane.getByRole('textbox', { name: 'Note content' }).fill('Keep the latest unsaved release evidence.');
  await pane.getByRole('button', { name: 'Delete note', exact: true }).click();

  await expect.poll(() => api.deletes).toEqual(['cora:note-identifier-001']);
  const toast = deletionToast(page, 'Release evidence');
  await expect(toast).toContainText('Note “Release evidence” was deleted');
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  const timer = toast.locator('.toast-timer-bar');
  await expect(timer).toBeVisible();
  await expect(timer).toHaveCSS('animation-name', 'key-indicator-drain');
  await expect(timer).toHaveCSS('animation-duration', '5s');
  const palette = await toast.evaluate(element => {
    // resolve theme colors through the rendered document
    const resolveColor = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const button = element.querySelector('button')!;
    const bar = element.querySelector<HTMLElement>('.toast-timer-bar')!;
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      button: getComputedStyle(button).color,
      timer: getComputedStyle(bar).backgroundColor,
      red: resolveColor('var(--red)'),
      redBackground: resolveColor('color-mix(in srgb, var(--mantle) 90%, var(--red))'),
      redBorder: resolveColor('color-mix(in srgb, var(--red) 65%, var(--surface-1))')
    };
  });
  expect(palette.background).toBe(palette.redBackground);
  expect(palette.border).toBe(palette.redBorder);
  expect(palette.button).toBe(palette.red);
  expect(palette.timer).toBe(palette.red);
  await expect(pane).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes (0)' })).toBeVisible();
  await page.screenshot({ path: '/tmp/note-delete-undo-desktop.png', fullPage: true });

  // preserve the original countdown when the toast remounts in another workspace
  await page.clock.fastForward(1_000);
  // keep the actionable toast mounted when another workspace becomes active
  await page.getByRole('tab', { name: 'Owen — Prompt done' }).click();
  await expect(toast).toBeVisible();
  await expect(timer).toHaveCSS('animation-delay', '-1s');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await toast.boundingBox();
  // require one fully reachable mobile toast
  expect(bounds).not.toBeNull();
  if (bounds === null) throw new Error('note deletion toast has no layout bounds');
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  // honor the in-app reduced-motion preference used by the key overlay
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  await expect(timer).toHaveCSS('animation-name', 'none');
  await page.evaluate(() => { delete document.documentElement.dataset.motion; });
  await page.screenshot({ path: '/tmp/note-delete-undo-mobile.png', fullPage: true });

  // the remainder of the original five-second window stays actionable
  await page.clock.fastForward(3_999);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.undos).toEqual(['undo-token-1']);
  await expect(toast).toHaveCount(0);
  expect(api.notes.cora).toEqual([{ ...original, text: 'Keep the latest unsaved release evidence.' }]);

  // restored metadata and attachments return with the note
  await page.getByRole('tab', { selected: true }).click();
  await page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: /^Cora\s/u }).click();
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Release evidence', exact: true }).click();
  const restoredPane = page.getByRole('dialog', { name: 'Note' });
  await expect(restoredPane).toContainText('Keep the latest unsaved release evidence.');
  await expect(restoredPane.getByText('All workspaces', { exact: true })).toBeVisible();
  await expect(restoredPane.getByRole('button', { name: 'Preview note attachment: evidence.md' })).toBeVisible();
});

test('keeps multiple menu deletion undos and five-second dismiss timers independent', async ({ page }) => {
  const api: NoteApi = { notes: { cora: [
    { id: 'note-identifier-001', title: 'Alpha note', text: 'Alpha' },
    { id: 'note-identifier-002', title: 'Beta note', text: 'Beta' }
  ], owen: [] }, deletes: [], undos: [], failDelete: false, failUndo: false };
  await page.clock.install();
  await mockNotes(page, api);
  await page.goto('/');
  // freeze wall time before starting independent undo windows
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));

  await page.getByRole('button', { name: 'Notes (2)' }).click();
  const menu = page.getByLabel('Worktree notes');
  await menu.getByRole('button', { name: 'Delete note: Alpha note' }).click();
  await menu.getByRole('button', { name: 'Delete note: Beta note' }).click();
  const alpha = deletionToast(page, 'Alpha note');
  const beta = deletionToast(page, 'Beta note');
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(alpha.locator('.toast-timer-bar')).toHaveCount(1);
  await expect(beta.locator('.toast-timer-bar')).toHaveCount(1);
  // dismiss the notes flyout above the toasts
  await page.keyboard.press('Escape');

  // each Undo restores only its own note and leaves the other action intact
  await alpha.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.notes.cora.map(note => note.title)).toEqual(['Alpha note']);
  await expect(alpha).toHaveCount(0);
  await expect(beta).toBeVisible();
  await beta.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.notes.cora.map(note => note.title)).toEqual(['Alpha note', 'Beta note']);
  await expect(beta).toHaveCount(0);

  // stagger two later deletions to prove each gets its own five-second timer
  await page.getByRole('button', { name: 'Notes (2)' }).click();
  await menu.getByRole('button', { name: 'Delete note: Alpha note' }).click();
  await expect(alpha).toBeVisible();
  await expect(alpha.locator('.toast-timer-bar')).toHaveCount(1);
  await page.clock.fastForward(1_000);
  await menu.getByRole('button', { name: 'Delete note: Beta note' }).click();
  await expect(beta).toBeVisible();
  await expect(beta.locator('.toast-timer-bar')).toHaveCount(1);
  await page.clock.fastForward(3_999);
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  // run nested React timers across the expiry boundary
  await page.clock.runFor(2);
  await expect(alpha).toHaveCount(0);
  await expect(beta).toBeVisible();
  await page.clock.fastForward(998);
  await expect(beta).toBeVisible();
  // run nested React timers across the expiry boundary
  await page.clock.runFor(2);
  await expect(beta).toHaveCount(0);
});

test('preserves notes after delete and undo failures and allows retry', async ({ page }) => {
  const api: NoteApi = { notes: { cora: [{ id: 'note-identifier-001', title: 'Retry note', text: 'Do not lose this note.' }], owen: [] }, deletes: [], undos: [], failDelete: true, failUndo: false };
  await page.clock.install();
  await mockNotes(page, api);
  await page.goto('/');
  // freeze wall time so a failed undo can renew its full timeout
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));

  await page.getByRole('button', { name: 'Notes (1)' }).click();
  const menu = page.getByLabel('Worktree notes');
  await menu.getByRole('button', { name: 'Delete note: Retry note' }).click();
  await expect(menu.getByRole('alert')).toHaveText('Unable to delete note');
  await expect(menu.getByRole('button', { name: 'Delete note: Retry note' })).toBeVisible();
  await expect(deletionToast(page, 'Retry note')).toHaveCount(0);

  // a later successful delete exposes an undo that survives a transient restore failure
  api.failDelete = false;
  await menu.getByRole('button', { name: 'Delete note: Retry note' }).click();
  const toast = deletionToast(page, 'Retry note');
  await expect(toast).toBeVisible();
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(1);
  // dismiss the notes flyout above the toast
  await page.keyboard.press('Escape');
  let releaseUndo = () => { /* expose the restore response gate */ };
  api.undoGate = new Promise<void>(resolve => { releaseUndo = resolve; });
  api.failUndo = true;
  const pendingUndo = toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.undos).toEqual(['undo-token-1']);
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(0);
  releaseUndo();
  await pendingUndo;
  await expect(toast.getByRole('alert')).toContainText('Unable to restore note');
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(toast.locator('.toast-timer-bar')).toHaveCount(1);
  await expect(toast.locator('.toast-timer-bar')).toHaveCSS('animation-delay', '0s');
  expect(api.notes.cora).toEqual([]);

  // retry the same still-valid token rather than inventing a client-side note
  await page.clock.fastForward(4_999);
  await expect(toast).toBeVisible();
  api.undoGate = undefined;
  api.failUndo = false;
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.notes.cora.map(note => note.title)).toEqual(['Retry note']);
  await expect(toast).toHaveCount(0);
  expect(api.undos).toEqual(['undo-token-1', 'undo-token-1']);
});

test('rejects malformed successful delete responses without removing the note', async ({ page }) => {
  const api: NoteApi = {
    notes: { cora: [{ id: 'note-identifier-001', title: 'Validated note', text: 'Keep this note until deletion is fully acknowledged.' }], owen: [] },
    deletes: [],
    undos: [],
    failDelete: false,
    failUndo: false,
    malformedDelete: 'missing-token'
  };
  await mockNotes(page, api);
  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  const menu = page.getByLabel('Worktree notes');

  // a 2xx response without a usable undo token is not a completed deletion
  await menu.getByRole('button', { name: 'Delete note: Validated note' }).click();
  await expect(menu.getByRole('alert')).toHaveText('Unable to delete note');
  await expect(menu.getByRole('button', { name: 'Delete note: Validated note' })).toBeVisible();
  await expect(deletionToast(page, 'Validated note')).toHaveCount(0);

  // a 2xx response for a different note is rejected the same way
  api.malformedDelete = 'wrong-id';
  await menu.getByRole('button', { name: 'Delete note: Validated note' }).click();
  await expect(menu.getByRole('alert')).toHaveText('Unable to delete note');
  await expect(menu.getByRole('button', { name: 'Delete note: Validated note' })).toBeVisible();
  await expect(deletionToast(page, 'Validated note')).toHaveCount(0);
  expect(api.notes.cora).toHaveLength(1);
});

test('keeps a saved edit dirty after undo reload returns an older snapshot', async ({ page }) => {
  const api: NoteApi = {
    notes: { cora: [
      { id: 'note-identifier-undo', title: 'Undo source', text: 'Restore this note.' },
      { id: 'note-identifier-edit', title: 'Editable note', text: 'old text' }
    ], owen: [] },
    deletes: [],
    undos: [],
    puts: [],
    listSnapshots: [],
    failDelete: false,
    failUndo: false
  };
  await mockNotes(page, api);
  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (2)' }).click();
  const menu = page.getByLabel('Worktree notes');
  await menu.getByRole('button', { name: 'Delete note: Undo source' }).click();
  const toast = deletionToast(page, 'Undo source');
  await expect(toast).toBeVisible();
  await menu.getByRole('button', { name: 'Editable note', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  await pane.getByLabel('Note preview').click();

  let releasePut = () => { /* release the captured note write */ };
  api.putGate = new Promise<void>(resolve => { releasePut = resolve; });
  await pane.getByRole('textbox', { name: 'Note content' }).fill('new text');
  await expect.poll(() => api.puts).toEqual([{ noteId: 'note-identifier-edit', text: 'new text' }]);

  let releaseList = () => { /* release the stale list response */ };
  api.listGate = new Promise<void>(resolve => { releaseList = resolve; });
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.listSnapshots?.length).toBe(2);
  expect(api.listSnapshots?.at(-1)?.find(note => note.id === 'note-identifier-edit')?.text).toBe('old text');

  // let the save acknowledge before the older list response lands
  releasePut();
  await expect.poll(() => api.notes.cora.find(note => note.id === 'note-identifier-edit')?.text).toBe('new text');
  releaseList();
  await expect(toast).toHaveCount(0);
  await pane.getByLabel('Note preview').click();
  await pane.getByRole('textbox', { name: 'Note content' }).fill('old text');
  await expect.poll(() => api.puts).toEqual([
    { noteId: 'note-identifier-edit', text: 'new text' },
    { noteId: 'note-identifier-edit', text: 'old text' }
  ]);
  await expect.poll(() => api.notes.cora.find(note => note.id === 'note-identifier-edit')?.text).toBe('old text');
});

test('blocks deletion during rename and restores the renamed title after undo', async ({ page }) => {
  const api: NoteApi = {
    notes: { cora: [{ id: 'note-identifier-001', title: 'Old title', text: 'Keep the renamed note.' }], owen: [] },
    deletes: [],
    undos: [],
    patches: [],
    failDelete: false,
    failUndo: false
  };
  await mockNotes(page, api);
  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Old title', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  await pane.getByRole('button', { name: 'Rename note', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Note name' }).fill('New title');

  let releasePatch = () => { /* release the captured title write */ };
  api.patchGate = new Promise<void>(resolve => { releasePatch = resolve; });
  await pane.getByRole('button', { name: 'Save note name' }).click();
  await expect.poll(() => api.patches).toEqual([{ noteId: 'note-identifier-001', title: 'New title' }]);
  const deleteControl = pane.getByRole('button', { name: 'Delete note', exact: true });
  await expect(deleteControl).toBeDisabled();
  expect(api.deletes).toEqual([]);

  releasePatch();
  await expect(pane.getByRole('button', { name: 'Switch note (1 here): New title' })).toBeVisible();
  await deleteControl.click();
  await expect.poll(() => api.deletes).toEqual(['cora:note-identifier-001']);
  const toast = deletionToast(page, 'New title');
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.notes.cora.map(note => note.title)).toEqual(['New title']);
});
