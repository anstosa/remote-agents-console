import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock.js';

type FixturePane = { paneId: string; name: string; path: string; managed?: boolean };
type FixtureWorkspace = { id: string; label: string; agentId?: string; pane?: FixturePane };
type FixtureNote = { id: string; title: string; text: string };
type MountOptions = {
  notes?: { state: 'ready' | 'delayed' | 'failed'; values?: FixtureNote[]; delete?: 'ready' | 'delayed' | 'failed' };
  lateShell?: { workspaceId: string; pane: FixturePane };
  storedReview?: { workspaceId: string; state: 'delayed' };
};

const coraId = 'repo:/repo/wts/cora';
const owenId = 'repo:/repo/wts/owen';
const shellId = 'repo:/repo/wts/shell';
const splitId = 'repo:/repo/wts/split';
const emptyId = 'repo:/repo/wts/empty';
const storedReviewTour = {
  title: 'Delayed stored review',
  overview: 'Resume the saved implementation walkthrough.',
  scope: 'pr',
  base: 'origin/main',
  includeTests: false,
  includeDocs: false,
  fingerprint: 'workspace-visibility-stored-review',
  changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }],
  steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }]
};
const workspaces: FixtureWorkspace[] = [
  { id: coraId, label: 'Cora', agentId: 'agent-cora', pane: { paneId: '%5', name: 'build', path: '/repo/wts/cora' } },
  { id: owenId, label: 'Owen', agentId: 'agent-owen' },
  { id: shellId, label: 'Shell', pane: { paneId: '%7', name: 'server', path: '/repo/wts/shell' } },
  { id: splitId, label: 'Split', pane: { paneId: '%8', name: 'logs', path: '/repo/wts/split', managed: false } },
  { id: emptyId, label: 'Empty' }
];

// retain fixture writes so empty-workspace recovery stays non-creative
function requestMutation(request: Request) {
  return { method: request.method(), path: decodeURIComponent(new URL(request.url()).pathname) };
}

// seed one browser-local preference before the app reads workspace state
async function seedStorage(page: Page, entries: Record<string, string>) {
  await page.addInitScript(values => {
    // keep product writes authoritative after the fixture's first document
    if (sessionStorage.getItem('rac.e2e.workspace-visibility-seeded') === '1') return;
    // restore every requested fixture preference
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    sessionStorage.setItem('rac.e2e.workspace-visibility-seeded', '1');
  }, entries);
}

// serve isolated workspaces with live agents, one reusable shell and one genuine empty state
async function mountWorkspace(page: Page, selected: string, storage: Record<string, string> = {}, options: MountOptions = {}) {
  const mutations: ReturnType<typeof requestMutation>[] = [];
  // clone mutable note state per test
  let notes = (options.notes?.values ?? []).map(note => ({ ...note }));
  let releaseNotesRequest: (() => void) | undefined;
  let releaseNoteDeleteRequest: (() => void) | undefined;
  let releaseShellRequest: (() => void) | undefined;
  let releaseStoredReviewRequest: (() => void) | undefined;
  let lateShellCreated = false;
  const notesRequest = new Promise<void>(resolve => { releaseNotesRequest = resolve; });
  const noteDeleteRequest = new Promise<void>(resolve => { releaseNoteDeleteRequest = resolve; });
  const shellRequest = new Promise<void>(resolve => { releaseShellRequest = resolve; });
  const storedReviewRequest = new Promise<void>(resolve => { releaseStoredReviewRequest = resolve; });
  const settingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
  const settingsSource = {
    id: 'app',
    label: 'Application config',
    path: '/fixture/config/config.json',
    format: 'json',
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: 'workspace-visibility-settings-r1',
    value: {},
    schema: { type: 'object', properties: {} }
  };
  await installPaneMock(page);
  await seedStorage(page, storage);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // retain only state-changing requests
    if (request.method() !== 'GET') mutations.push(requestMutation(request));
    // authenticate the local fixture
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'workspace-visibility-csrf', active: true, deviceName: 'Test device' } });
    // serve minimal settings reads for dirty-close confirmation
    if (path === '/api/settings/status') return route.fulfill({ json: settingsStatus });
    // expose one writable source without accepting unrelated settings writes
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'workspace-visibility-settings-r1', sources: [settingsSource], status: settingsStatus } });
    // provide the four independent workspace scopes
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      ...(options.storedReview === undefined ? {} : {
        reviewTour: { available: true },
        reviews: [{
          worktreeId: options.storedReview.workspaceId,
          branch: `feature/${workspaces.find(workspace => workspace.id === options.storedReview?.workspaceId)?.label.toLowerCase()}`,
          savedAt: '2026-10-29T18:00:00.000Z',
          title: storedReviewTour.title,
          scope: storedReviewTour.scope,
          includeTests: storedReviewTour.includeTests,
          includeDocs: storedReviewTour.includeDocs,
          fingerprint: storedReviewTour.fingerprint
        }]
      }),
      agents: workspaces.flatMap(workspace => workspace.agentId === undefined ? [] : [{
        id: workspace.agentId,
        sessionId: `socket:$${workspace.agentId}`,
        home: workspace.pane?.path ?? `/repo/wts/${workspace.label.toLowerCase()}`,
        placeId: workspace.id,
        worktreeId: workspace.id,
        projectId: 'repo',
        worktreeLabel: workspace.label,
        title: 'Ready',
        branch: `feature/${workspace.label.toLowerCase()}`,
        queuedPromptCount: 0,
        ...(options.storedReview?.workspaceId === workspace.id ? {
          gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
          gitPrStatus: { base: 'origin/main', files: 1 }
        } : {})
      }]),
      projects: [{ id: 'repo', label: 'Repo', available: true, manageWorktrees: true, worktrees: workspaces.map((workspace, order) => ({
        id: workspace.id,
        projectId: 'repo',
        label: workspace.label,
        path: workspace.pane?.path ?? `/repo/wts/${workspace.label.toLowerCase()}`,
        branch: `feature/${workspace.label.toLowerCase()}`,
        available: true,
        pinned: true,
        order,
        consoleShells: workspace.pane === undefined ? 0 : 1
      })) }]
    } });
    // disable browser push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // omit optional revision polling
    if (path === '/api/server/revision') return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    // keep remote server status empty
    if (path === '/api/server-statuses') return route.fulfill({ json: { servers: [] } });
    // mint pane stream tickets for both agent and terminal panels
    if (path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'workspace-visibility-ticket' } });
    // keep prompt collections empty
    if (path.endsWith('/saved-prompts') || path.endsWith('/queued-prompts') || path.endsWith('/prompt-history')) return route.fulfill({ json: { prompts: [] } });
    // hold one durable review restore across dirty-close confirmation
    if (options.storedReview !== undefined && path === `/api/worktrees/${options.storedReview.workspaceId}/review-tour` && request.method() === 'GET') {
      await storedReviewRequest;
      const workspace = workspaces.find(candidate => candidate.id === options.storedReview?.workspaceId);
      return route.fulfill({ json: { status: 'ready', review: { worktreeId: options.storedReview.workspaceId, branch: `feature/${workspace?.label.toLowerCase()}`, savedAt: '2026-10-29T18:00:00.000Z', tour: storedReviewTour } } });
    }
    // keep the restored review fresh after its delayed response
    if (options.storedReview !== undefined && path.endsWith('/review-tour/fingerprint')) return route.fulfill({ json: { status: 'comparison', comparison: { scope: storedReviewTour.scope, base: storedReviewTour.base, includeTests: false, includeDocs: false, fingerprint: storedReviewTour.fingerprint } } });
    // control initial note hydration for recovery and close-all races
    if (path.endsWith('/notes') && request.method() === 'GET') {
      // hold the first read until close-all has committed
      if (options.notes?.state === 'delayed') await notesRequest;
      // surface a failed read without inventing note content
      if (options.notes?.state === 'failed') return route.fulfill({ status: 500, json: { error: 'notes unavailable' } });
      return route.fulfill({ json: { notes } });
    }
    // match a note resource without truncating workspace ids
    const notePrefix = workspaces.map(workspace => `/api/worktrees/${workspace.id}/notes/`).find(prefix => path.startsWith(prefix));
    // model blank-note cleanup as an awaited server mutation
    if (notePrefix !== undefined && request.method() === 'DELETE') {
      const noteId = path.slice(notePrefix.length);
      const note = notes.find(candidate => candidate.id === noteId);
      // reject unknown fixture notes explicitly
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing note' } });
      // hold one deletion across close-all transaction assertions
      if (options.notes?.delete === 'delayed') await noteDeleteRequest;
      // retain server state when deletion fails
      if (options.notes?.delete === 'failed') return route.fulfill({ status: 500, json: { error: 'note delete failed' } });
      notes = notes.filter(candidate => candidate.id !== noteId);
      return route.fulfill({ json: { ...note, undoToken: `workspace-visibility-delete-${note.id}` } });
    }
    const workspace = workspaces.find(candidate => path === `/api/worktrees/${candidate.id}/panes`);
    // expose the one managed shell only in its owning workspace
    if (workspace !== undefined) {
      const latePane = lateShellCreated && options.lateShell?.workspaceId === workspace.id ? options.lateShell.pane : undefined;
      const panes = [workspace.pane, latePane].flatMap(pane => pane === undefined ? [] : [{
        paneId: pane.paneId,
        session: `$${pane.paneId.slice(1)}`,
        window: `@${pane.paneId.slice(1)}`,
        role: pane.managed === false ? 'split' : 'shell',
        name: pane.name,
        command: 'zsh',
        path: pane.path,
        title: pane.name,
        agent: false,
        busy: false
      }]);
      return route.fulfill({ json: { panes } });
    }
    // delay one explicit shell creation until a newer close-all commits
    if (options.lateShell !== undefined && path === `/api/worktrees/${options.lateShell.workspaceId}/shells` && request.method() === 'POST') {
      await shellRequest;
      lateShellCreated = true;
      return route.fulfill({ json: { paneId: options.lateShell.pane.paneId } });
    }
    // expose accidental shell creation as a fixture failure signal
    if (path.endsWith('/shells') && request.method() === 'POST') return route.fulfill({ status: 500, json: { error: 'unexpected shell creation' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(`/#worktree=${selected}`);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${workspaces.find(workspace => workspace.id === selected)?.label} —`, 'u'), { timeout: 10_000 });
  return {
    mutations,
    // release only the fixture request selected by this test
    releaseNotes: () => releaseNotesRequest?.(),
    releaseNoteDelete: () => releaseNoteDeleteRequest?.(),
    releaseShell: () => releaseShellRequest?.(),
    releaseStoredReview: () => releaseStoredReviewRequest?.()
  };
}

// switch workspaces through the phone-only workspace sheet
async function switchPhoneWorkspace(page: Page, label: string) {
  await page.getByRole('tab', { selected: true }).click();
  await page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${label}\\b`, 'u') }).click();
}

// open one existing note through the workspace picker
async function openExistingNote(page: Page, title: string) {
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
}

// stage one unsaved interface preference for close confirmation
async function openDirtySettings(page: Page) {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Interface', exact: true }).click();
  await settings.getByRole('radio', { name: 'Light theme', exact: true }).click();
  return settings;
}

// start the workspace close-all action from its tab menu
async function invokeCloseAll(page: Page, label: string) {
  await page.getByRole('tab', { name: new RegExp(`^${label} —`, 'u') }).click({ button: 'right' });
  await page.getByRole('menu', { name: `${label} workspace` }).getByRole('menuitem', { name: 'Close all splits' }).click();
}

// read only whether this workspace has deliberate empty intent
const isIntentionallyEmpty = (page: Page, workspaceId: string) => page.evaluate(key => localStorage.getItem(key) !== null, `rac.workspace-empty:place-${workspaceId}`);

// address the shared transient minimize failure without matching exact product copy
const minimizeError = (page: Page) => page.locator('body > .toast-region .operation-feedback.error[role="alert"]').filter({ hasText: /split.*visible|visible.*split/iu });

// require the rendered error treatment and its five-second countdown
async function expectTimedRedError(error: Locator) {
  await expect(error.locator('.operation-feedback-icon')).toHaveCSS('color', 'rgb(243, 139, 168)');
  await expect(error.locator('.toast-timer-bar')).toHaveCSS('animation-duration', '5s');
  await expect(error).toHaveCount(0, { timeout: 6_500 });
}

// reject the final visible agent split on the desktop without hiding it
test('last visible Agent stays open with a timed red error on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, owenId);
  const output = page.locator('.agent-panel');
  await expect(output).toBeVisible();
  await page.getByRole('button', { name: 'Minimize agent output' }).click();
  await expect(output).toBeVisible();
  const error = minimizeError(page);
  await expect(error).toBeVisible();
  await expectTimedRedError(error);
});

// reject the final visible terminal split on the phone without hiding it
test('last visible Terminal stays open with a timed red error on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountWorkspace(page, shellId, {
    [`rac.terminals:${shellId}`]: JSON.stringify([{ paneId: '%7', name: 'server' }])
  });
  const terminal = page.locator('.terminal-pane[data-panel-key="%7"]');
  await expect(terminal).toBeVisible();
  await page.getByRole('button', { name: 'Minimize terminal server' }).click();
  await expect(terminal).toBeVisible();
  const error = minimizeError(page);
  await expect(error).toBeVisible();
  await expectTimedRedError(error);
});

// guard the keyboard close alias when it maps to unmanaged terminal minimization
test('keyboard close keeps the last unmanaged Terminal visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, splitId, {
    [`rac.terminals:${splitId}`]: JSON.stringify([{ paneId: '%8', name: 'logs' }])
  });
  const terminal = page.locator('.terminal-pane[data-panel-key="%8"]');
  await expect(terminal).toBeVisible();
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  await page.keyboard.press('y');
  await expect(terminal).toBeVisible();
  await expect(minimizeError(page)).toBeVisible();
});

// allow either split to minimize while its sibling remains visible
test('minimizing Agent and Terminal succeeds while a visible sibling remains', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, coraId, {
    [`rac.terminals:${coraId}`]: JSON.stringify([{ paneId: '%5', name: 'build' }])
  });
  const output = page.locator('.agent-panel');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(output).toBeVisible();
  await expect(terminal).toBeVisible();

  await page.getByRole('button', { name: 'Minimize agent output' }).click();
  await expect(output).toHaveCount(0);
  await expect(terminal).toBeVisible();
  await expect(minimizeError(page)).toHaveCount(0);

  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Show agent' }).click();
  await expect(output).toBeVisible();
  await page.getByRole('button', { name: 'Minimize terminal build' }).click();
  await expect(terminal).toHaveCount(0);
  await expect(output).toBeVisible();
  await expect(minimizeError(page)).toHaveCount(0);
});

// repair legacy all-minimized state from existing content only
test('legacy hidden Agent and live shell recover when their workspaces activate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, coraId, {
    [`rac.hidden-agent:place-${coraId}`]: '1',
    [`rac.terminals:${coraId}`]: '[]',
    [`rac.terminals:${shellId}`]: '[]'
  });
  await expect(page.locator('.agent-panel')).toBeVisible();

  await page.getByRole('tab', { name: /^Shell —/u }).click();
  await expect(page.locator('.terminal-pane[data-panel-key="%7"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toHaveCount(0);
});

// let known agent and shell candidates recover even when notes cannot load
test('failed Notes read does not block legacy Agent or shell recovery', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, coraId, {
    [`rac.hidden-agent:place-${coraId}`]: '1',
    [`rac.terminals:${shellId}`]: '[]'
  }, { notes: { state: 'failed' } });
  await expect(page.locator('.agent-panel')).toBeVisible();

  await page.getByRole('tab', { name: /^Shell —/u }).click();
  await expect(page.locator('.terminal-pane[data-panel-key="%7"]')).toBeVisible();
});

// prevent delayed initial note hydration from undoing a newer close-all
test('Close all wins over a delayed initial Note restore', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mountWorkspace(page, coraId, {
    [`rac.note-view:${coraId}`]: JSON.stringify({ noteId: 'note-delayed', expanded: false })
  }, { notes: { state: 'delayed', values: [{ id: 'note-delayed', title: 'Delayed', text: 'Retained note' }] } });
  const coraTab = page.getByRole('tab', { name: /^Cora —/u });
  await coraTab.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Cora workspace' }).getByRole('menuitem', { name: 'Close all splits' }).click();
  await expect(page.locator('.agent-panel, .note-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), `rac.note-view:${coraId}`)).toBeNull();

  const notesResponse = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${coraId}/notes`);
  harness.releaseNotes();
  await notesResponse;
  await expect(page.locator('.note-pane')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Show agent' })).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);
});

// commit empty intent only after selected blank-note deletion succeeds
test('Close all waits for blank Note deletion before committing empty intent', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const note = { id: 'note-blank-delayed', title: 'Blank draft', text: '' };
  const harness = await mountWorkspace(page, coraId, {}, { notes: { state: 'ready', values: [note], delete: 'delayed' } });
  await openExistingNote(page, note.title);

  const deleteRequest = page.waitForRequest(request => request.method() === 'DELETE' && decodeURIComponent(new URL(request.url()).pathname) === `/api/worktrees/${coraId}/notes/${note.id}`);
  await invokeCloseAll(page, 'Cora');
  await deleteRequest;
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  await expect(page.locator('.agent-panel')).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(false);

  const deleteResponse = page.waitForResponse(response => response.request().method() === 'DELETE' && decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${coraId}/notes/${note.id}`);
  harness.releaseNoteDelete();
  expect((await deleteResponse).status()).toBe(200);
  await expect(page.locator('.agent-panel, .note-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);

  await page.reload();
  const notesButton = page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Notes (0)' });
  await expect(notesButton).toBeVisible();
  await expect(page.locator('.note-pane')).toHaveCount(0);
  await notesButton.click();
  await expect(page.getByRole('button', { name: note.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New note', exact: true })).toBeVisible();
});

// roll the whole close-all transaction back when blank-note deletion fails
test('failed blank Note deletion keeps the Note and Agent visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const note = { id: 'note-blank-failed', title: 'Blank draft', text: '' };
  await mountWorkspace(page, coraId, {}, { notes: { state: 'ready', values: [note], delete: 'failed' } });
  await openExistingNote(page, note.title);

  const deleteResponse = page.waitForResponse(response => response.request().method() === 'DELETE' && decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${coraId}/notes/${note.id}`);
  await invokeCloseAll(page, 'Cora');
  expect((await deleteResponse).status()).toBe(500);
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  await expect(page.locator('.agent-panel')).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(false);
});

// suppress a late shell panel while retaining its completed process as a picker choice
test('Close all wins over an earlier shell open that completes late', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mountWorkspace(page, owenId, {}, {
    lateShell: { workspaceId: owenId, pane: { paneId: '%9', name: 'late', path: '/repo/wts/owen' } }
  });
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const shellRequest = page.waitForRequest(request => decodeURIComponent(new URL(request.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await shellRequest;

  const owenTab = page.getByRole('tab', { name: /^Owen —/u });
  await owenTab.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Owen workspace' }).getByRole('menuitem', { name: 'Close all splits' }).click();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, owenId)).toBe(true);

  const shellResponse = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  const panesResponse = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/panes`);
  harness.releaseShell();
  await shellResponse;
  await panesResponse;
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Show agent' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Open a terminal' })).toHaveAttribute('aria-haspopup', 'menu');
  expect(await isIntentionallyEmpty(page, owenId)).toBe(true);
});

// include a shell completed behind dirty settings in the confirmed close-all commit
test('Close all closes a shell completed during dirty Settings confirmation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mountWorkspace(page, owenId, {}, {
    lateShell: { workspaceId: owenId, pane: { paneId: '%9', name: 'late', path: '/repo/wts/owen' } }
  });
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const settings = await openDirtySettings(page);
  const shellRequest = page.waitForRequest(request => request.method() === 'POST' && decodeURIComponent(new URL(request.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await shellRequest;

  await invokeCloseAll(page, 'Owen');
  const confirmation = settings.getByRole('alertdialog', { name: 'Close Settings with unsaved changes?', exact: true });
  await expect(confirmation).toBeVisible();
  const shellResponse = page.waitForResponse(response => response.request().method() === 'POST' && decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  const panesResponse = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/panes`);
  harness.releaseShell();
  await shellResponse;
  await panesResponse;
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and close', exact: true }).click();

  await expect(settings).toHaveCount(0);
  await expect(page.locator('.agent-panel, .terminal-pane, .note-pane, .browser-pane, .code-pane, .review-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, owenId)).toBe(true);
  const terminalButton = toolbar.getByRole('button', { name: 'Open a terminal' });
  await expect(terminalButton).toHaveAttribute('aria-haspopup', 'menu');
  await terminalButton.click();
  await expect(page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: /late/u })).toBeVisible();
});

// include a stored review restored behind dirty settings in the confirmed close-all commit
test('Close all closes a stored Review restored during dirty Settings confirmation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mountWorkspace(page, owenId, {}, { storedReview: { workspaceId: owenId, state: 'delayed' } });
  const settings = await openDirtySettings(page);
  const branchButton = page.getByRole('button', { name: /Git status: feature\/owen/u });
  await branchButton.click();
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  const restoreRequest = page.waitForRequest(request => request.method() === 'GET' && decodeURIComponent(new URL(request.url()).pathname) === `/api/worktrees/${owenId}/review-tour`);
  await statusPanel.getByRole('button', { name: 'Open Review', exact: true }).click();
  await restoreRequest;

  await invokeCloseAll(page, 'Owen');
  const confirmation = settings.getByRole('alertdialog', { name: 'Close Settings with unsaved changes?', exact: true });
  await expect(confirmation).toBeVisible();
  const restoreResponse = page.waitForResponse(response => response.request().method() === 'GET' && decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/review-tour`);
  harness.releaseStoredReview();
  expect((await restoreResponse).status()).toBe(200);
  await expect(page.locator('.review-pane')).toBeVisible();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and close', exact: true }).click();

  await expect(settings).toHaveCount(0);
  await expect(page.locator('.agent-panel, .terminal-pane, .note-pane, .browser-pane, .code-pane, .review-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, owenId)).toBe(true);
});

// keep an explicit agent restore newer than an older pending shell open
test('restoring Agent after Close all suppresses an older shell completion', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mountWorkspace(page, owenId, {}, {
    lateShell: { workspaceId: owenId, pane: { paneId: '%9', name: 'late', path: '/repo/wts/owen' } }
  });
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const shellRequest = page.waitForRequest(request => request.method() === 'POST' && decodeURIComponent(new URL(request.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await shellRequest;

  await invokeCloseAll(page, 'Owen');
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  expect(await isIntentionallyEmpty(page, owenId)).toBe(true);
  await toolbar.getByRole('button', { name: 'Show agent' }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
  expect(await isIntentionallyEmpty(page, owenId)).toBe(false);

  const shellResponse = page.waitForResponse(response => response.request().method() === 'POST' && decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/shells`);
  const panesResponse = page.waitForResponse(response => decodeURIComponent(new URL(response.url()).pathname) === `/api/worktrees/${owenId}/panes`);
  harness.releaseShell();
  await shellResponse;
  await panesResponse;
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Open a terminal' })).toHaveAttribute('aria-haspopup', 'menu');
  expect(await isIntentionallyEmpty(page, owenId)).toBe(false);
});

// preserve deliberate emptiness until an explicit restore clears it
test('Close all remains empty across switching and reload until restore reactivates the guard', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountWorkspace(page, coraId, {
    [`rac.terminals:${coraId}`]: JSON.stringify([{ paneId: '%5', name: 'build' }])
  });
  const coraTab = page.getByRole('tab', { name: /^Cora —/u });
  await coraTab.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Cora workspace' }).getByRole('menuitem', { name: 'Close all splits' }).click();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: 'Show agent' })).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);

  await page.getByRole('tab', { name: /^Owen —/u }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toHaveCount(0);
  await coraTab.click();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Show agent' })).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);
  await page.reload();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Show agent' })).toBeVisible();
  expect(await isIntentionallyEmpty(page, coraId)).toBe(true);

  await toolbar.getByRole('button', { name: 'Show agent' }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Minimize agent output' }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(minimizeError(page)).toBeVisible();
});

// leave a genuinely empty workspace empty without launching or creating content
test('genuine empty workspace never auto-creates a split', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await mountWorkspace(page, emptyId);
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);

  await switchPhoneWorkspace(page, 'Owen');
  await switchPhoneWorkspace(page, 'Empty');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  await expect(page.locator('.agent-panel, .terminal-pane')).toHaveCount(0);
  expect(harness.mutations.filter(entry => entry.path.endsWith('/shells') || entry.path.endsWith('/launch') || entry.path === '/api/agents')).toEqual([]);
});
