import { expect, test, type Locator, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

// pin the zone so the server-supplied nextRun renders as a fixed local sentence
test.use({ timezoneId: 'America/Los_Angeles' });

// The server refreshes the dashboard after every Run outcome, but a Schedule's lastRun and nextRun are
// REST-only, not on the dashboard payload. So while the notes fly-out or a note pane is open, a dashboard
// generation change must refetch this tab's notes, updating the clock badge and the "Last run" footnote.

// push generation and note-revision changes through the shared channel
const emitGeneration = (page: Page, generation: number, agents: unknown[], projects: unknown[] = [], notesRevision?: number, serverStartedAt?: number) =>
  emitDashboard(page, { generation, agents, projects, notesRevision, serverStartedAt });
const noteAlertRed = 'rgb(243, 139, 168)';

// require the persistent red treatment shared by animated and reduced-motion alerts
const expectStaticNoteAlert = async (toggle: Locator) => {
  await expect(toggle).toHaveCSS('border-color', noteAlertRed);
  await expect(toggle).not.toHaveCSS('box-shadow', 'none');
};

// require the same pulse cadence as the cleanup alert
const expectAnimatedNoteAlert = async (toggle: Locator) => {
  await expectStaticNoteAlert(toggle);
  await expect(toggle).not.toHaveCSS('animation-name', 'none');
  await expect(toggle).toHaveCSS('animation-duration', '1.6s');
  await expect(toggle).toHaveCSS('animation-timing-function', 'ease-in-out');
  await expect(toggle).toHaveCSS('animation-iteration-count', 'infinite');
};

// require ordinary and acknowledged notes to retain the neutral control treatment
const expectNoNoteAlert = async (toggle: Locator) => {
  await expect(toggle).not.toHaveCSS('border-color', noteAlertRed);
  await expect(toggle).toHaveCSS('animation-name', 'none');
};

test('refetches the fly-out badge on a generation change, and catches up on reopen after one while closed', async ({ page }) => {
  await installDashboardSocket(page);
  const agents = [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }];
  const schedule = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'cora' }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00' };
  let runFailed = false;
  let notesGets = 0;
  const note = () => ({ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly report', nextRun: '2026-01-02T17:00:00.000Z', schedule: { ...schedule, lastRun: runFailed ? { at: '2026-01-01T17:00:00.000Z', status: 'failed', detail: 'launch refused' } : { at: '2026-01-01T17:00:00.000Z', status: 'launched', agentId: 'agent-1' } } });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects: [] } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') { notesGets += 1; return route.fulfill({ json: { notes: [note()] } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByTitle('Scheduled')).toBeVisible();
  await expect.poll(() => notesGets).toBe(1);
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  // a Run failed and the server bumped the generation; with the fly-out open, the tab refetches and reddens
  runFailed = true;
  await emitGeneration(page, 2, agents);
  await expect(page.getByTitle('Last run needs attention')).toBeVisible();
  await expect.poll(() => notesGets).toBe(2);

  // close the fly-out, advance the generation while closed (a later Run recovered), then reopen: the effect
  // left its baseline stale while closed, so reopening catches up and the badge returns to plain
  await page.locator('.flyout-backdrop').click();
  await expect(page.getByTitle('Last run needs attention')).toBeHidden();
  runFailed = false;
  await emitGeneration(page, 3, agents);
  await expect.poll(() => notesGets).toBe(2);
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByTitle('Scheduled')).toBeVisible();
  await expect.poll(() => notesGets).toBe(3);
});

test('refreshes the open note pane\'s Last run footnote on a generation change', async ({ page }) => {
  test.setTimeout(60_000);
  await installDashboardSocket(page);
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  const agents = [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }];
  const projects = [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }];
  const schedule = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00' };
  let runFailed = false;
  const note = () => ({ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly', nextRun: '2026-09-07T09:00:00-07:00', schedule: { ...schedule, lastRun: runFailed ? { at: '2026-01-01T17:00:00.000Z', status: 'failed', detail: 'launch refused' } : { at: '2026-01-01T17:00:00.000Z', status: 'launched', agentId: 'agent-1' } } });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note()] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.locator('.note-choice').filter({ hasText: 'Weekly' }).click();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  await expect(editor.locator('.schedule-last')).toContainText('launched');
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);

  // a later scheduled Run failed and bumped the generation; the open pane refetches and reddens the footnote
  runFailed = true;
  await emitGeneration(page, 2, agents, projects);
  await expect(editor.locator('.schedule-last')).toContainText('failed, launch refused');
  await expect(editor.locator('.schedule-last')).toHaveClass(/bad/);
});

// queued-note attention survives refreshes but ends only when the notes list is visible
test('keeps queued-note controls red until notes are opened and shares acknowledgements across worktrees', async ({ page }) => {
  test.setTimeout(60_000);
  await installDashboardSocket(page);
  const agents = [
    { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
    { id: 'agent-owen', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
  ];
  // a matching title alone must not mark an ordinary note unread
  const ordinaryTitle = 'Queued prompt in Cora · 9:41 AM';
  const notes: Array<{ id: string; title: string; text: string; source?: 'queued-prompt' }> = [
    { id: 'ordinary-note-001', title: ordinaryTitle, text: 'An ordinary note with a queue-like title' }
  ];
  let generation = 1;
  let notesRevision = 0;
  let serverStartedAt = 1_000;
  // serve shared project notes through either worktree route
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // keep authentication local to the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // preserve the latest generation across reloads
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation, notesRevision, serverStartedAt, agents, projects: [] } });
    // enable controlled dashboard pushes
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable push registration
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // allow both log panels to mount
    if (/^\/api\/agents\/agent-(?:cora|owen)\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt lists without triggering unrelated requests
    if (/^\/api\/agents\/agent-(?:cora|owen)\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // allow ordinary tab selection acknowledgements
    if (/^\/api\/agents\/agent-(?:cora|owen)\/notifications\/dismiss$/u.test(url.pathname)) return route.fulfill({ status: 204 });
    // read the same note group through both worktree views
    if (/^\/api\/worktrees\/(?:cora|owen)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  // simulate automatic queue recovery without changing any agent fields
  const recoverPrompt = async (title: string) => {
    notesRevision += 1;
    // queue additions can leave discovery generation unchanged
    notes.unshift({ id: `queued-note-${notesRevision}`, title, text: `Recovered prompt ${notesRevision}`, source: 'queued-prompt' });
    await expect.poll(() => dashboardSocketReady(page)).toBe(true);
    await emitGeneration(page, generation, agents, [], notesRevision, serverStartedAt);
  };

  await page.goto('/');
  const toggle = page.getByRole('button', { name: /^Notes \(/u });
  const badge = toggle.locator('.notes-count-other');
  await expect(toggle).toHaveAccessibleName('Notes (1)');
  await expectNoNoteAlert(toggle);

  await recoverPrompt('Queued prompt in Cora · 1:05 PM');
  await expect(toggle).toHaveAccessibleName('Notes (2)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(badge).toHaveCSS('background-color', 'rgb(203, 166, 247)');
  await expect(toggle).toHaveCSS('color', noteAlertRed);
  await expectAnimatedNoteAlert(toggle);
  await page.locator('.notes-control').screenshot({ path: test.info().outputPath('queued-note-unread.png') });

  // background reloads must not acknowledge the recovered prompt
  await page.reload();
  await expectStaticNoteAlert(toggle);
  await toggle.click();
  await expect(page.getByLabel('Worktree notes')).toContainText('Queued prompt in Cora · 1:05 PM');
  await expectNoNoteAlert(toggle);
  await page.locator('.flyout-backdrop').click();
  await page.reload();
  await expect(toggle).toHaveAccessibleName('Notes (2)');
  await expectNoNoteAlert(toggle);

  // a different open note pane is not an acknowledgement of a new queued note
  await toggle.click();
  await page.locator('.note-choice').filter({ hasText: ordinaryTitle }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  await recoverPrompt('A renamed recovered prompt');
  await expect(toggle).toHaveAccessibleName('Notes (3)');
  await expectAnimatedNoteAlert(toggle);
  await toggle.click();
  await expectNoNoteAlert(toggle);

  // entries arriving in the visible list are already seen
  await recoverPrompt('Queued prompt in Cora · 1:07 PM');
  await expect(page.getByLabel('Worktree notes')).toContainText('Queued prompt in Cora · 1:07 PM');
  await expect(toggle).toHaveAccessibleName('Notes (4)');
  await expectNoNoteAlert(toggle);
  await page.locator('.flyout-backdrop').click();

  // project-shared notes stay acknowledged in another worktree
  await page.getByRole('tab', { name: 'Owen — Prompt done' }).click();
  await expect(toggle).toHaveAccessibleName('Notes (4)');
  await expectNoNoteAlert(toggle);
  await page.reload();
  await expect(toggle).toHaveAccessibleName('Notes (4)');
  await expectNoNoteAlert(toggle);

  // restarting the server may reuse a numeric revision but must still reveal new notes
  notes.unshift({ id: 'queued-after-restart', title: 'Queued prompt in Owen · 1:08 PM', text: 'Recovered after restart', source: 'queued-prompt' });
  serverStartedAt = 2_000;
  generation = 1;
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitGeneration(page, generation, agents, [], notesRevision, serverStartedAt);
  await expect(toggle).toHaveAccessibleName('Notes (5)');
  await expectAnimatedNoteAlert(toggle);

  // reduced motion keeps the red alert visible without pulsing
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectStaticNoteAlert(toggle);
  await expect(toggle).toHaveCSS('animation-name', 'none');

  // keep the control visible at phone and desktop widths
  for (const viewport of [{ label: 'phone', width: 320, height: 640 }, { label: 'desktop', width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    // measure once the resized layout has settled with the control on screen
    await expect(page.locator('.notes-control')).toBeInViewport({ ratio: 1 });
    const bounds = await page.locator('.notes-control').boundingBox();
    expect(bounds).not.toBeNull();
    // stop coordinate checks when Playwright reports no rendered box
    if (bounds === null) continue;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    const padding = 24;
    const x = Math.max(0, bounds.x - padding);
    const y = Math.max(0, bounds.y - padding);
    const right = Math.min(viewport.width, bounds.x + bounds.width + padding);
    const bottom = Math.min(viewport.height, bounds.y + bounds.height + padding);
    await page.screenshot({ path: test.info().outputPath(`queued-note-unread-${viewport.label}.png`), clip: { x, y, width: right - x, height: bottom - y } });
  }
});

// acknowledgements from separate browser tabs must converge without losing either project
test('merges queued-note acknowledgements across browser tabs', async ({ page, context }) => {
  test.setTimeout(60_000);
  const other = await context.newPage();
  await installDashboardSocket(page);
  await installDashboardSocket(other);
  const agents = [
    { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
    { id: 'agent-owen', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
  ];
  const coraNotes = [{ id: 'queued-cora-001', text: 'First project prompt', source: 'queued-prompt' }];
  const owenNotes = [{ id: 'queued-owen-001', text: 'Second project prompt', source: 'queued-prompt' }];
  // share real browser storage while keeping project note collections distinct
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // establish the same active session in both tabs
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // keep discovery stable while note revisions advance
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, notesRevision: 0, agents, projects: [] } });
    // enable dashboard pushes
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // return each project's independent notes
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: coraNotes } });
    if (path === '/api/worktrees/owen/notes') return route.fulfill({ json: { notes: owenNotes } });
    // allow log panels and prompt history
    if (path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (path.endsWith('/prompt-history')) return route.fulfill({ json: { prompts: [] } });
    // allow tab selection
    if (path.endsWith('/notifications/dismiss')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await other.goto('/');
  await other.getByRole('tab', { name: 'Owen — Prompt done' }).click();
  const toggle = page.getByRole('button', { name: /^Notes \(/u });
  const otherToggle = other.getByRole('button', { name: /^Notes \(/u });
  await expectStaticNoteAlert(toggle);
  await expectStaticNoteAlert(otherToggle);
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expectNoNoteAlert(toggle);
  await other.getByRole('button', { name: 'Notes (1)' }).click();
  await expectNoNoteAlert(otherToggle);

  // the second tab's write must retain the first tab's acknowledgement
  await page.reload();
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeEnabled();
  await expectNoNoteAlert(toggle);

  // reading a new note in one tab also clears the other live tab's attention
  await other.locator('.flyout-backdrop').click();
  await other.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  coraNotes.unshift({ id: 'queued-cora-002', text: 'Another project prompt', source: 'queued-prompt' });
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await expect.poll(() => dashboardSocketReady(other)).toBe(true);
  await emitGeneration(page, 1, agents, [], 1);
  await emitGeneration(other, 1, agents, [], 1);
  await expectStaticNoteAlert(toggle);
  await expectStaticNoteAlert(otherToggle);
  await page.getByRole('button', { name: 'Notes (2)' }).click();
  await expectNoNoteAlert(toggle);
  await expectNoNoteAlert(otherToggle);
});

// late mount responses must not overwrite newer manual and dashboard refreshes
test('keeps a queued note when the initial notes response arrives last', async ({ page }) => {
  test.setTimeout(60_000);
  await installDashboardSocket(page);
  const agents = [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Working', attention: 'working' }];
  type Note = { id: string; text: string; source?: 'queued-prompt' };
  const notes: Note[] = [{ id: 'ordinary-note-001', text: 'Existing note' }];
  const queued = [{ id: 'queued-prompt-001', text: 'Recovered queue entry', createdAt: '2026-09-20T09:00:00Z' }];
  let notesGets = 0;
  let releaseInitial: () => void = () => undefined;
  const initialHeld = new Promise<void>(resolve => { releaseInitial = resolve; });
  // capture the first response before saving, then deliver it after two newer reads
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // establish one active console session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one working agent and a stable generation
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, notesRevision: 0, agents, projects: [] } });
    // enable revision-only pushes
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // allow the terminal panel to mount
    if (path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide an empty prompt history
    if (path.endsWith('/prompt-history')) return route.fulfill({ json: { prompts: [] } });
    // expose the queued prompt independently of the blocked notes request
    if (path.endsWith('/queued-prompts')) return route.fulfill({ json: { prompts: queued } });
    // persist a queue-created note and consume the queued copy
    if (path.endsWith('/queued-prompts/queued-prompt-001/save')) {
      const note: Note = { id: 'saved-queued-note', text: queued[0]!.text, source: 'queued-prompt' };
      notes.unshift(note);
      queued.splice(0);
      return route.fulfill({ status: 201, json: note });
    }
    // hold only the stale mount response, not subsequent refreshes
    if (path === '/api/worktrees/cora/notes') {
      notesGets += 1;
      const body = JSON.stringify({ notes });
      // keep the initial snapshot stale until explicitly released
      if (notesGets === 1) await initialHeld;
      return route.fulfill({ contentType: 'application/json', body });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect.poll(() => notesGets).toBe(1);
  await page.getByRole('button', { name: 'Queued prompts (1)' }).click();
  await page.getByRole('button', { name: 'Save queued prompt as note: Recovered queue entry' }).click();
  const toggle = page.getByRole('button', { name: /^Notes \(/u });
  await expect(toggle).toHaveAccessibleName('Notes (2)');
  await expect.poll(() => notesGets).toBe(2);
  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  const updated = page.waitForResponse(response => response.url().endsWith('/worktrees/cora/notes'));
  await emitGeneration(page, 1, agents, [], 1);
  await (await updated).finished();
  await expect.poll(() => notesGets).toBe(3);
  const stale = page.waitForResponse(response => response.url().endsWith('/worktrees/cora/notes'));
  releaseInitial();
  await (await stale).finished();
  // let the released response reach react before checking the latest snapshot
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(toggle).toHaveAccessibleName('Notes (2)');
  await expectStaticNoteAlert(toggle);
  await toggle.click();
  await expect(page.getByLabel('Worktree notes')).toContainText('Recovered queue entry');
});
