import { expect, test, type Locator, type Page } from '@playwright/test';

type NoteAttachmentSummary = { name: string; size: number };
type NoteAttachment = { name: string; data: string };
type NoteSummary = { id: string; text: string; title?: string; attachments?: NoteAttachmentSummary[] };
type PreviewReply = { status?: number; json: unknown };

type NoteFixture = {
  note: NoteSummary;
  attachments: NoteAttachment[];
  attachmentReads: number;
  attachmentWrites: NoteAttachment[][];
  attachmentDeletes: string[];
  noteDeletes: number;
  prompts: Array<{ prompt: string; attachments: NoteAttachment[] }>;
  failAttachmentRead: boolean;
  failAttachmentWrite: boolean;
  failAttachmentDelete: boolean;
  previewRequests: string[];
  previewResponse?: (name: string) => PreviewReply | Promise<PreviewReply>;
};

// build one mutable note fixture
const noteFixture = (note: NoteSummary, attachments: NoteAttachment[] = []): NoteFixture => ({
  note,
  attachments,
  attachmentReads: 0,
  attachmentWrites: [],
  attachmentDeletes: [],
  noteDeletes: 0,
  prompts: [],
  failAttachmentRead: false,
  failAttachmentWrite: false,
  failAttachmentDelete: false,
  previewRequests: []
});

// keep note metadata synchronized with stored bytes
const summarizeAttachments = (fixture: NoteFixture) => {
  fixture.note.attachments = fixture.attachments.map(attachment => ({ name: attachment.name, size: Buffer.from(attachment.data, 'base64').byteLength }));
};

// serve one active worktree and its note attachment contract
const mockNoteApi = async (page: Page, fixture: NoteFixture) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // return summaries without attachment bytes
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [fixture.note] } });
    if (url.pathname === `/api/worktrees/cora/notes/${fixture.note.id}` && request.method() === 'PUT') {
      fixture.note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: fixture.note });
    }
    if (url.pathname === `/api/worktrees/cora/notes/${fixture.note.id}` && request.method() === 'DELETE') {
      fixture.noteDeletes += 1;
      return route.fulfill({ json: { ...fixture.note, undoToken: 'undo-deleted-note' } });
    }
    const attachmentBase = `/api/worktrees/cora/notes/${fixture.note.id}/attachments`;
    // preview one persisted attachment through the shared bounded contract
    if (url.pathname === `${attachmentBase}/preview` && request.method() === 'POST') {
      const name = (request.postDataJSON() as { path: string }).path;
      fixture.previewRequests.push(name);
      if (fixture.previewResponse === undefined) return route.fulfill({ status: 404, json: { error: 'preview not mocked' } });
      const response = await fixture.previewResponse(name);
      return route.fulfill({ status: response.status ?? 200, json: response.json });
    }
    // hydrate attachment bytes only through the dedicated endpoint
    if (url.pathname === attachmentBase && request.method() === 'GET') {
      fixture.attachmentReads += 1;
      if (fixture.failAttachmentRead) return route.fulfill({ status: 503, json: { error: 'temporary read failure' } });
      return route.fulfill({ json: { attachments: fixture.attachments } });
    }
    // append selected bytes and return the updated summary
    if (url.pathname === attachmentBase && request.method() === 'POST') {
      const payload = request.postDataJSON() as { attachments: NoteAttachment[] };
      fixture.attachmentWrites.push(payload.attachments);
      if (fixture.failAttachmentWrite) return route.fulfill({ status: 503, json: { error: 'temporary upload failure' } });
      fixture.attachments.push(...payload.attachments);
      summarizeAttachments(fixture);
      return route.fulfill({ json: fixture.note });
    }
    // remove one named attachment and return the updated summary
    if (url.pathname === attachmentBase && request.method() === 'DELETE') {
      const name = url.searchParams.get('name')!;
      fixture.attachmentDeletes.push(name);
      if (fixture.failAttachmentDelete) return route.fulfill({ status: 503, json: { error: 'temporary delete failure' } });
      fixture.attachments = fixture.attachments.filter(attachment => attachment.name !== name);
      summarizeAttachments(fixture);
      return route.fulfill({ json: fixture.note });
    }
    // capture the hydrated prompt submission
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      fixture.prompts.push(request.postDataJSON() as { prompt: string; attachments: NoteAttachment[] });
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// open one named note from the flyout
const openNote = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name: 'Note' });
};

// dispatch a file drop onto the note pane
const dropFile = async (target: Locator, name: string, contents: string) => target.evaluate((element, file) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([file.contents], file.name, { type: 'text/plain' }));
  return element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, { name, contents });

test('adds, removes, autosaves, and reloads note attachments without embedding bytes in summaries', async ({ page }) => {
  const fixture = noteFixture(
    { id: 'note-identifier-001', title: 'Release context', text: 'Review the release context.', attachments: [{ name: 'existing.txt', size: 8 }] },
    [{ name: 'existing.txt', data: Buffer.from('existing').toString('base64') }]
  );
  await mockNoteApi(page, fixture);

  // summary responses expose metadata only
  expect(JSON.stringify(fixture.note)).not.toContain(fixture.attachments[0]!.data);
  await page.goto('/');
  let dialog = await openNote(page, 'Release context');
  await expect(dialog.getByRole('toolbar', { name: 'Note actions' }).getByRole('button', { name: 'Attach files to note' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Note attachments' }).getByRole('button', { name: 'Add attachment' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: existing.txt' })).toBeVisible();

  await dialog.getByLabel('Note attachment files').setInputFiles({ name: 'steps.md', mimeType: 'text/markdown', buffer: Buffer.from('# release steps') });
  await expect.poll(() => fixture.attachmentWrites).toEqual([[{ name: 'steps.md', data: Buffer.from('# release steps').toString('base64') }]]);
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: steps.md' })).toBeVisible();

  await page.getByLabel('Note preview').click();
  await dialog.getByRole('textbox', { name: 'Note content' }).fill('Review the updated release context.');
  await expect.poll(() => fixture.note.text).toBe('Review the updated release context.');
  await dialog.getByRole('button', { name: 'Close note' }).click();

  // text saves and pane lifecycle retain attachments
  await page.reload();
  dialog = await openNote(page, 'Release context');
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: existing.txt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: steps.md' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove note attachment: steps.md' }).click();
  await expect.poll(() => fixture.attachmentDeletes).toEqual(['steps.md']);
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: steps.md' })).toHaveCount(0);
});

// verify toolbar picker placement and visibility
test('places an icon-only attachment picker beside Send and shows the second picker only with files', async ({ page }) => {
  const fixture = noteFixture({ id: 'note-identifier-001', title: 'Toolbar attachments', text: 'Attach files from either control.' });
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Toolbar attachments');
  const toolbar = dialog.getByRole('toolbar', { name: 'Note actions' });
  const toolbarAttach = toolbar.getByRole('button', { name: 'Attach files to note' });
  const send = toolbar.getByRole('button', { name: 'Send note as prompt' });

  await expect(toolbarAttach).toHaveText('');
  await expect(toolbarAttach.locator('svg')).toBeVisible();
  await expect(send).toBeVisible();
  await expect(toolbar.locator('button[aria-label="Attach files to note"] + button[aria-label="Send note as prompt"], button[aria-label="Send note as prompt"] + button[aria-label="Attach files to note"]')).toHaveCount(1);
  await expect(dialog.getByRole('group', { name: 'Note attachments' })).toHaveCount(0);
  await expect(dialog.getByLabel('Note attachment files')).toHaveCount(1);

  // open the shared hidden picker from the toolbar
  const toolbarChooser = page.waitForEvent('filechooser');
  await toolbarAttach.click();
  await (await toolbarChooser).setFiles({ name: 'toolbar.txt', mimeType: 'text/plain', buffer: Buffer.from('toolbar context') });
  await expect.poll(() => fixture.attachmentWrites.flat()).toEqual([{ name: 'toolbar.txt', data: Buffer.from('toolbar context').toString('base64') }]);

  const attachmentGroup = dialog.getByRole('group', { name: 'Note attachments' });
  const groupAttach = attachmentGroup.getByRole('button', { name: 'Add attachment' });
  await expect(groupAttach).toHaveText('Add attachment');
  await expect(groupAttach.locator('svg')).toBeVisible();
  // open the same picker from the populated attachment strip
  const groupChooser = page.waitForEvent('filechooser');
  await groupAttach.click();
  await (await groupChooser).setFiles({ name: 'strip.txt', mimeType: 'text/plain', buffer: Buffer.from('strip context') });
  await expect.poll(() => fixture.attachmentWrites.flat()).toEqual([
    { name: 'toolbar.txt', data: Buffer.from('toolbar context').toString('base64') },
    { name: 'strip.txt', data: Buffer.from('strip context').toString('base64') }
  ]);
});

// preview supported note attachment formats
test('previews text and image note attachments and restores focus after dismissal', async ({ page }) => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const fixture = noteFixture({
    id: 'note-identifier-001',
    title: 'Preview attachments',
    text: 'Inspect the saved context.',
    attachments: [{ name: 'notes.md', size: 24 }, { name: 'screenshot.png', size: 68 }]
  });
  // return one supported preview by filename
  fixture.previewResponse = name => name === 'notes.md'
    ? { json: { path: name, size: 24, binary: false, truncated: false, content: '# Saved context\nPreview me.' } }
    : { json: { path: name, size: 68, binary: true, truncated: false, image: { mediaType: 'image/png', base64: imageBase64 } } };
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Preview attachments');

  const textTrigger = dialog.getByRole('button', { name: 'Preview note attachment: notes.md' });
  await textTrigger.click();
  const textPreview = page.getByRole('dialog', { name: 'File preview: notes.md' });
  await expect(textPreview.getByLabel('Contents of notes.md')).toContainText('# Saved context');
  const closePreview = textPreview.getByRole('button', { name: 'Close file preview' });
  const copyPath = textPreview.getByRole('button', { name: 'Copy path' });
  await expect(closePreview).toBeFocused();
  // keep scrollable text reachable before wrapping modal focus
  await page.keyboard.press('Tab');
  await expect(textPreview.getByLabel('Contents of notes.md')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(copyPath).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(textPreview.getByLabel('Contents of notes.md')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closePreview).toBeFocused();
  await closePreview.click();
  await expect(textPreview).toHaveCount(0);
  await expect(textTrigger).toBeFocused();

  const imageTrigger = dialog.getByRole('button', { name: 'Preview note attachment: screenshot.png' });
  await imageTrigger.click();
  const imagePreview = page.getByRole('dialog', { name: 'File preview: screenshot.png' });
  const image = imagePreview.getByRole('img', { name: 'Preview of screenshot.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(imagePreview).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(imageTrigger).toBeFocused();
  expect(fixture.previewRequests).toEqual(['notes.md', 'screenshot.png']);
});

// preserve bounded preview failures and stale-response safety
test('shows failed, binary, truncated, and safely closed note attachment previews', async ({ page }) => {
  let finishSlowPreview!: () => void;
  // hold one response beyond its closed dialog
  const slowPreviewFinished = new Promise<void>(resolve => { finishSlowPreview = resolve; });
  const fixture = noteFixture({
    id: 'note-identifier-001',
    title: 'Preview boundaries',
    text: 'Exercise bounded previews.',
    attachments: [
      { name: 'unavailable.txt', size: 4 },
      { name: 'archive.zip', size: 8 },
      { name: 'large.txt', size: 300_000 },
      { name: 'slow.txt', size: 4 }
    ]
  });
  fixture.previewResponse = async name => {
    // return each shared preview state
    if (name === 'unavailable.txt') return { status: 503, json: { error: 'temporary preview failure' } };
    if (name === 'archive.zip') return { json: { path: name, size: 8, binary: true, truncated: false } };
    if (name === 'large.txt') return { json: { path: name, size: 300_000, binary: false, truncated: true, content: 'bounded beginning' } };
    await slowPreviewFinished;
    return { json: { path: name, size: 4, binary: false, truncated: false, content: 'late' } };
  };
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Preview boundaries');

  await dialog.getByRole('button', { name: 'Preview note attachment: unavailable.txt' }).click();
  let preview = page.getByRole('dialog', { name: 'File preview: unavailable.txt' });
  await expect(preview.getByRole('alert')).toHaveText('Preview unavailable');
  await preview.getByRole('button', { name: 'Close file preview' }).click();

  await dialog.getByRole('button', { name: 'Preview note attachment: archive.zip' }).click();
  preview = page.getByRole('dialog', { name: 'File preview: archive.zip' });
  await expect(preview).toContainText('Binary file preview unavailable');
  await preview.getByRole('button', { name: 'Close file preview' }).click();

  await dialog.getByRole('button', { name: 'Preview note attachment: large.txt' }).click();
  preview = page.getByRole('dialog', { name: 'File preview: large.txt' });
  await expect(preview.getByLabel('Contents of large.txt')).toContainText('bounded beginning');
  await expect(preview).toContainText('Preview limited to the first 256 KB.');
  await preview.getByRole('button', { name: 'Close file preview' }).click();

  const slowTrigger = dialog.getByRole('button', { name: 'Preview note attachment: slow.txt' });
  // observe the late response before checking stale state
  const slowResponse = page.waitForResponse(response => response.url().endsWith(`/api/worktrees/cora/notes/${fixture.note.id}/attachments/preview`)
    && response.request().postDataJSON()?.path === 'slow.txt');
  await slowTrigger.click();
  preview = page.getByRole('dialog', { name: 'File preview: slow.txt' });
  await expect(preview.getByRole('status')).toContainText('Loading preview');
  await preview.getByRole('button', { name: 'Close file preview' }).click();
  finishSlowPreview();
  await slowResponse;
  await expect(preview).toHaveCount(0);
  await expect(slowTrigger).toBeFocused();
});

// keep long filenames removable on desktop and mobile
for (const width of [320, 1440]) {
  // contain filename text while keeping the action visible
  test(`keeps long attachment filenames removable at ${width}px`, async ({ page }) => {
    const name = `${'context-'.repeat(20)}.txt`;
    const fixture = noteFixture(
      { id: 'note-identifier-001', title: 'Long filename', text: 'Keep the removal control visible.', attachments: [{ name, size: 4 }] },
      [{ name, data: Buffer.from('file').toString('base64') }]
    );
    await page.setViewportSize({ width, height: 800 });
    await mockNoteApi(page, fixture);
    await page.goto('/');
    const dialog = await openNote(page, 'Long filename');
    const remove = dialog.getByRole('button', { name: `Remove note attachment: ${name}` });
    await expect(remove).toBeInViewport({ ratio: 1 });
    const addAttachment = dialog.getByRole('button', { name: 'Add attachment' });
    await expect(addAttachment).toBeInViewport({ ratio: 1 });
    await expect(addAttachment).toHaveText('Add attachment');
    // match the labeled action to the rendered attachment card
    const cardHeight = await remove.locator('..').evaluate(element => element.getBoundingClientRect().height);
    const buttonHeight = await addAttachment.evaluate(element => element.getBoundingClientRect().height);
    expect(Math.abs(buttonHeight - cardHeight)).toBeLessThanOrEqual(1);
    // require the complete attachment area to fit without horizontal scrolling
    const dimensions = await dialog.getByRole('group', { name: 'Note attachments' }).evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
    await remove.click();
    await expect.poll(() => fixture.attachmentDeletes).toEqual([name]);
  });
}

// retain acknowledged files after failed mutations
test('retains existing files when an attachment upload or removal fails', async ({ page }) => {
  const fixture = noteFixture(
    { id: 'note-identifier-001', title: 'Failure context', text: 'Keep the working files.', attachments: [{ name: 'keep.txt', size: 4 }] },
    [{ name: 'keep.txt', data: Buffer.from('keep').toString('base64') }]
  );
  fixture.failAttachmentWrite = true;
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Failure context');

  await dialog.getByLabel('Note attachment files').setInputFiles({ name: 'failed.txt', mimeType: 'text/plain', buffer: Buffer.from('failed') });
  await expect.poll(() => fixture.attachmentWrites).toHaveLength(1);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: keep.txt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: failed.txt' })).toHaveCount(0);

  fixture.failAttachmentWrite = false;
  fixture.failAttachmentDelete = true;
  await dialog.getByRole('button', { name: 'Remove note attachment: keep.txt' }).click();
  await expect.poll(() => fixture.attachmentDeletes).toEqual(['keep.txt']);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: keep.txt' })).toBeVisible();
});

test('keeps attachment-only notes and hydrates bytes before sending them', async ({ page }) => {
  const image = { name: 'context.png', data: Buffer.from([137, 80, 78, 71]).toString('base64') };
  const fixture = noteFixture(
    { id: 'note-identifier-001', title: 'Screenshot context', text: '', attachments: [{ name: image.name, size: 4 }] },
    [image]
  );
  await mockNoteApi(page, fixture);
  await page.goto('/');

  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByRole('button', { name: 'Send note: Screenshot context' })).toBeEnabled();
  await page.getByRole('button', { name: 'Screenshot context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Note' });
  const send = dialog.getByRole('button', { name: 'Send note as prompt' });
  await expect(send).toBeEnabled();
  expect(fixture.attachmentReads).toBe(0);

  // a hydration failure cannot degrade into a text-only prompt
  fixture.failAttachmentRead = true;
  await send.click();
  await expect.poll(() => fixture.attachmentReads).toBe(1);
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(fixture.prompts).toEqual([]);

  fixture.failAttachmentRead = false;
  await send.click();
  await expect.poll(() => fixture.prompts).toEqual([{ prompt: '', attachments: [image] }]);
  await dialog.getByRole('button', { name: 'Close note' }).click();
  expect(fixture.noteDeletes).toBe(0);
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
});

// persist and send every note attachment beyond the previous count cap
test('uploads more than ten note attachments and retains them across reload and send', async ({ page }) => {
  const fixture = noteFixture({ id: 'note-identifier-001', title: 'Many files', text: 'Read every attachment.' });
  await mockNoteApi(page, fixture);
  await page.goto('/');
  let dialog = await openNote(page, 'Many files');
  // select one batch beyond the previous cap
  const selected = Array.from({ length: 12 }, (_, index) => ({ name: `context-${index + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${index + 1}`) }));
  const expected = selected.map(file => ({ name: file.name, data: file.buffer.toString('base64') }));
  await dialog.getByLabel('Note attachment files').setInputFiles(selected);
  await expect.poll(() => fixture.attachmentWrites).toEqual([expected]);
  await expect(dialog.getByRole('button', { name: /^Remove note attachment:/u })).toHaveCount(12);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dropFile(dialog, 'extra.txt', 'additional context');
  expected.push({ name: 'extra.txt', data: Buffer.from('additional context').toString('base64') });
  await expect.poll(() => fixture.attachments).toEqual(expected);
  await expect(dialog.getByRole('button', { name: /^Remove note attachment:/u })).toHaveCount(13);

  await page.reload();
  dialog = await openNote(page, 'Many files');
  await expect(dialog.getByRole('button', { name: /^Remove note attachment:/u })).toHaveCount(13);
  await dialog.getByRole('button', { name: 'Send note as prompt' }).click();
  await expect.poll(() => fixture.prompts).toEqual([{ prompt: 'Read every attachment.', attachments: expected }]);
});

// retain filename and size safeguards without restricting the file count
test('rejects duplicate and oversized note attachments before upload', async ({ page }) => {
  const fixture = noteFixture({ id: 'note-identifier-001', title: 'Bounded context', text: 'Keep attachment limits bounded.' });
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Bounded context');
  const input = dialog.getByLabel('Note attachment files');

  await input.setInputFiles([
    { name: 'duplicate.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
    { name: 'duplicate.txt', mimeType: 'text/plain', buffer: Buffer.from('two') }
  ]);
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(fixture.attachmentWrites).toEqual([]);

  // construct the real oversized file without transferring its bytes over the browser protocol
  await input.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'too-large.bin', { type: 'application/octet-stream' }));
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(fixture.attachmentWrites).toEqual([]);
});

test('uploads pasted images and dropped files through the note pane', async ({ page }) => {
  const fixture = noteFixture({ id: 'note-identifier-001', title: 'Gather context', text: '' });
  await mockNoteApi(page, fixture);
  await page.goto('/');
  const dialog = await openNote(page, 'Gather context');
  const editor = dialog.getByRole('textbox', { name: 'Note content' });

  const pasteAllowed = await editor.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' }));
    return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  expect(pasteAllowed).toBe(false);
  expect((await dropFile(dialog, 'context.txt', 'dropped context'))).toBe(false);

  await expect.poll(() => fixture.attachmentWrites.flat()).toEqual([
    { name: 'clipboard.png', data: Buffer.from([137, 80, 78, 71]).toString('base64') },
    { name: 'context.txt', data: Buffer.from('dropped context').toString('base64') }
  ]);
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: clipboard.png' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove note attachment: context.txt' })).toBeVisible();
});
