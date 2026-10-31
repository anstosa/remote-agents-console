import { expect, test, type Page, type Route } from '@playwright/test';

type NoteCreatePayload = { title?: string; text?: string; attachments?: Array<{ name: string; data: string }> };

// serve one composer and delegate its note creation request
const mockComposerNoteSave = async (page: Page, createNote: (route: Route) => Promise<void> | void, options: { notes?: Array<{ id: string; text: string; title?: string }>; dashboard?: object } = {}) => {
  await page.addInitScript(() => {
    // keep the dashboard socket inert
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open the inert socket asynchronously
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close the fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the local console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: options.dashboard ?? { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: options.notes ?? [] } });
    // keep inactive worktree navigation independent of conversation history
    if (url.pathname === '/api/worktrees/cora/bookmarks') return route.fulfill({ json: { bookmarks: [], canResume: false } });
    // let the test control note creation completion
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') return createNote(route);
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// keep both capture actions on one row across desktop and phone widths
for (const width of [1280, 390, 320]) {
  // assert rendered placement rather than a particular layout implementation
  test(`keeps note capture buttons on one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockComposerNoteSave(page, route => route.fulfill({ status: 500, json: { error: 'unexpected save' } }));
    await page.goto('/');
    await page.getByRole('button', { name: /^Notes \(/u }).click();
    const latest = page.getByRole('button', { name: 'Save latest response', exact: true });
    const current = page.getByRole('button', { name: 'Save current prompt', exact: true });
    await expect(latest).toBeVisible();
    await expect(current).toBeVisible();
    await expect(current).toBeDisabled();
    const left = (await latest.boundingBox())!;
    const right = (await current.boundingBox())!;
    expect(Math.abs(left.y - right.y)).toBeLessThan(1);
    expect(left.x + left.width).toBeLessThan(right.x);
    expect(left.x).toBeGreaterThanOrEqual(0);
    expect(right.x + right.width).toBeLessThanOrEqual(width);
    // retain the full labels instead of silently truncating either action
    for (const button of [latest, current]) {
      expect(await button.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
  });
}

// expose a separate prompt action without requiring an assistant response
test('saves the current prompt from the notes flyout with independent empty and pending guards', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  let submitted: NoteCreatePayload | undefined;
  let finishSave!: () => void;
  // retain the request long enough to exercise the visible pending state
  const saveFinished = new Promise<void>(resolve => { finishSave = resolve; });
  await mockComposerNoteSave(page, async route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    await saveFinished;
    const note = { id: 'note-identifier-001', title: submitted.title, text: submitted.text ?? '' };
    notes.push(note);
    return route.fulfill({ status: 201, json: note });
  }, { notes });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const notesButton = page.getByRole('button', { name: /^Notes \(/u });
  const saveLatest = page.getByRole('button', { name: 'Save latest response', exact: true });
  const saveCurrent = page.getByRole('button', { name: 'Save current prompt', exact: true });
  await notesButton.click();
  await expect(saveLatest).toBeVisible();
  await expect(saveLatest).toBeDisabled();
  await expect(saveCurrent).toBeDisabled();
  await page.keyboard.press('Escape');

  await composer.fill(' \n\t ');
  await notesButton.click();
  await expect(saveCurrent).toBeDisabled();
  await page.keyboard.press('Escape');

  await composer.fill('x'.repeat(30_001));
  await notesButton.click();
  await expect(saveCurrent).toBeDisabled();
  await expect(saveCurrent).toHaveAttribute('title', 'Notes are limited to 30,000 characters');
  await page.keyboard.press('Escape');

  const text = 'Save this current prompt\n\nKeep its exact formatting.  ';
  await composer.fill(text);
  await page.locator('.prompt input[type="file"]').setInputFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('attached context') });
  await notesButton.click();
  await expect(saveLatest).toBeDisabled();
  await expect(saveCurrent).toBeEnabled();
  await saveCurrent.click();
  await expect.poll(() => submitted).toEqual({
    title: 'Save this current prompt',
    text,
    attachments: [{ name: 'context.txt', data: Buffer.from('attached context').toString('base64') }]
  });
  await expect(saveCurrent).toBeDisabled();
  await expect(composer).toHaveValue(text);
  finishSave();
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save this current prompt', exact: true })).toBeVisible();
  await expect(saveCurrent).toBeDisabled();
});

// keep retained drafts saveable without mounting the agent panel
test('saves the minimized agent draft and its attachments from Notes', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-000', title: 'Reference note', text: 'Keep one companion split open.' }];
  let submitted: NoteCreatePayload | undefined;
  await mockComposerNoteSave(page, route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    const note = { id: 'note-identifier-001', title: submitted.title, text: submitted.text ?? '' };
    notes.push(note);
    return route.fulfill({ status: 201, json: note });
  }, { notes });
  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Reference note', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await composer.fill('Save this minimized draft');
  await page.locator('.prompt input[type="file"]').setInputFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('retained context') });
  await page.getByRole('button', { name: 'Minimize agent output', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await page.getByRole('button', { name: /^Notes \(/u }).click();
  const saveCurrent = page.getByRole('button', { name: 'Save current prompt', exact: true });
  await expect(saveCurrent).toBeEnabled();
  await saveCurrent.click();
  await expect.poll(() => submitted).toEqual({
    title: 'Save this minimized draft',
    text: 'Save this minimized draft',
    attachments: [{ name: 'context.txt', data: Buffer.from('retained context').toString('base64') }]
  });
  await expect(page.getByRole('button', { name: 'Save this minimized draft', exact: true })).toBeVisible();
  await expect(saveCurrent).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show agent', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// keep a failed flyout save retryable without losing composer contents
test('retains the current prompt after a failed notes flyout save', async ({ page }) => {
  const submitted: NoteCreatePayload[] = [];
  await mockComposerNoteSave(page, route => {
    submitted.push(route.request().postDataJSON() as NoteCreatePayload);
    return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
  });
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await composer.fill('Keep this draft on failure');
  await page.getByRole('button', { name: /^Notes \(/u }).click();
  const saveCurrent = page.getByRole('button', { name: 'Save current prompt', exact: true });
  await saveCurrent.click();
  await expect.poll(() => submitted).toHaveLength(1);
  await expect(saveCurrent).toBeEnabled();
  await expect(composer).toHaveValue('Keep this draft on failure');
  await saveCurrent.click();
  await expect.poll(() => submitted).toHaveLength(2);
  await expect(composer).toHaveValue('Keep this draft on failure');
});

// save a place-owned draft even before an agent has started
test('saves the current prompt from an inactive worktree notes flyout', async ({ page }) => {
  const text = 'Inactive draft to save';
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  await page.addInitScript(value => localStorage.setItem('remote-agent-console:prompt-draft:worktree-prompt:cora', value), text);
  await mockComposerNoteSave(page, route => {
    const payload = route.request().postDataJSON() as NoteCreatePayload;
    const note = { id: 'note-identifier-001', title: payload.title, text: payload.text ?? '' };
    notes.push(note);
    return route.fulfill({ status: 201, json: note });
  }, {
    notes,
    dashboard: {
      generation: 1,
      agents: [],
      projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/cora', launch: { kind: 'codex', origin: 'worktree' } }] }]
    }
  });
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await expect(composer).toHaveValue(text);
  await page.getByRole('button', { name: /^Notes \(/u }).click();
  await expect(page.getByRole('button', { name: 'Save latest response', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save current prompt', exact: true }).click();
  await expect.poll(() => notes).toEqual([{ id: 'note-identifier-001', title: text, text }]);
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: text, exact: true })).toBeVisible();
});

// explain competing workspace operations without losing the retained draft
test('reports a pending workspace launch instead of silently ignoring note capture', async ({ page }) => {
  const text = 'Keep this draft while launching';
  const posted: NoteCreatePayload[] = [];
  let finishLaunch!: () => void;
  let launchStarted = false;
  // retain the workspace lock until the save rejection has been checked
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });
  await page.addInitScript(value => localStorage.setItem('remote-agent-console:prompt-draft:worktree-prompt:cora', value), text);
  await mockComposerNoteSave(page, route => {
    posted.push(route.request().postDataJSON() as NoteCreatePayload);
    return route.fulfill({ status: 201, json: { id: 'note-identifier-001', title: text, text } });
  }, {
    dashboard: {
      generation: 1,
      agents: [],
      projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/cora', launch: { kind: 'codex', origin: 'worktree' } }] }]
    }
  });
  await page.route('**/api/worktrees/cora/launch', async route => {
    launchStarted = true;
    await launchFinished;
    await route.fulfill({ status: 503, json: { error: 'launch failed' } });
  });
  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch Codex', exact: true }).click();
  await expect.poll(() => launchStarted).toBe(true);
  try {
    await page.getByRole('button', { name: /^Notes \(/u }).click();
    await page.getByRole('button', { name: 'Save current prompt', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Draft not saved' })).toContainText('Wait for the current workspace action to finish');
    expect(posted).toEqual([]);
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(text);
  } finally { finishLaunch(); }
});

// Ctrl+S while typing in the composer saves the current text as a new Note and clears the prompt.
test('saves the composer draft as a note and clears the prompt on Ctrl+S', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const posted: Array<{ title?: string; text?: string }> = [];
  let created = 0;
  await page.addInitScript(() => {
    // keep the dashboard socket inert so the composer renders without a live connection
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
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string; text?: string };
      posted.push(payload);
      const note = { id: `note-identifier-00${++created}`, text: payload.text ?? '', ...(payload.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await expect(composer).toBeVisible();

  // an empty composer has no draft to save: Ctrl+S posts nothing
  await composer.focus();
  await composer.press('Control+s');
  await composer.fill('Draft this idea into a note');
  await composer.press('Control+s');

  // the draft is posted as one titled note (title derived from its first line), then the composer clears
  await expect.poll(() => posted).toEqual([{ title: 'Draft this idea into a note', text: 'Draft this idea into a note' }]);
  await expect(composer).toHaveValue('');

  // the new note appears in the refreshed notes fly-out
  const notesButton = page.getByRole('button', { name: 'Notes (1)' });
  await expect(notesButton).toBeVisible();
  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Draft this idea into a note', exact: true })).toBeVisible();
});

test('saves composer attachments atomically and preserves text typed after the submitted snapshot', async ({ page }) => {
  let submitted: NoteCreatePayload | undefined;
  let finishSave!: () => void;
  // hold the response while the user starts a new draft
  const saveFinished = new Promise<void>(resolve => { finishSave = resolve; });
  await mockComposerNoteSave(page, async route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    await saveFinished;
    return route.fulfill({ status: 201, json: { id: 'note-identifier-001', title: submitted.title, text: submitted.text ?? '', attachments: [{ name: 'submitted.txt', size: 17 }] } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  const fileInput = page.locator('.prompt input[type="file"]');
  await composer.fill('Save this draft with its file.');
  await fileInput.setInputFiles({ name: 'submitted.txt', mimeType: 'text/plain', buffer: Buffer.from('submitted context') });
  await composer.press('Control+s');
  await expect.poll(() => submitted).toMatchObject({
    text: 'Save this draft with its file.',
    attachments: [{ name: 'submitted.txt', data: Buffer.from('submitted context').toString('base64') }]
  });

  // preserve text typed after the submitted snapshot
  await composer.fill('A new draft typed while saving.');
  finishSave();
  await expect(composer).toHaveValue('A new draft typed while saving.');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

test('saves attachment-only drafts and retains the entire draft when creation fails', async ({ page }) => {
  let submitted: NoteCreatePayload | undefined;
  await mockComposerNoteSave(page, route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await page.locator('.prompt input[type="file"]').setInputFiles({ name: 'only-context.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment only') });
  await composer.focus();
  await composer.press('Control+s');

  await expect.poll(() => submitted).toMatchObject({
    text: '',
    attachments: [{ name: 'only-context.txt', data: Buffer.from('attachment only').toString('base64') }]
  });
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toContainText('only-context.txt');
});
