import { expect, test } from '@playwright/test';

// pin the zone so the server-supplied nextRun renders as a fixed local sentence
test.use({ timezoneId: 'America/Los_Angeles' });

type ScheduleBody = { cron: string; kind: string; target: unknown; enabled: boolean };
type StoredNote = { id: string; text: string; title?: string; schedule?: ScheduleBody; nextRun?: string };

test('sets and removes a note Schedule from the pane against a stateful notes stub', async ({ page }) => {
  test.setTimeout(60_000);
  const notes: StoredNote[] = [];
  const scheduleWrites: Array<{ method: string; body?: ScheduleBody }> = [];
  let created = 0;
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const scheduleMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/schedule$/u.exec(url.pathname);
    if (scheduleMatch) {
      const note = notes.find(candidate => candidate.id === scheduleMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as ScheduleBody;
        scheduleWrites.push({ method: 'PUT', body });
        note.schedule = body;
        note.nextRun = '2026-09-07T09:00:00-07:00';
        return route.fulfill({ json: { ...note } });
      }
      if (request.method() === 'DELETE') {
        scheduleWrites.push({ method: 'DELETE' });
        delete note.schedule;
        delete note.nextRun;
        return route.fulfill({ json: { id: note.id, text: note.text, ...(note.title === undefined ? {} : { title: note.title }) } });
      }
    }
    const noteMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'DELETE') {
      const index = notes.findIndex(candidate => candidate.id === noteMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      return route.fulfill({ json: { ...notes.splice(index, 1)[0], undoToken: 'undo-deleted-note' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.getByRole('button', { name: '+ New note' }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  // unscheduled notes keep the creation action in the header menu
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Schedule note' }).click();

  const openFlyout = () => page.getByRole('button', { name: 'Notes' }).click();
  const closeFlyout = () => page.locator('.flyout-backdrop').click();

  // create → the pane shows the sentence and the server's nextRun
  await expect(editor).toContainText('atlas · main worktree');
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('● Runs');
  await expect(editor).toContainText('Next Mon 7 Sep 9:00 AM');
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } });

  // the fly-out row gains a yellow (not paused) clock badge for the enabled Schedule
  await openFlyout();
  await expect(page.locator('.note-schedule-badge')).toHaveCount(1);
  await expect(page.locator('.note-schedule-badge.paused')).toHaveCount(0);
  await closeFlyout();

  // pause → records the disabled write and dims the badge
  await editor.getByRole('switch', { name: 'Schedule enabled' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('○ Paused');
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: false } });
  await openFlyout();
  await expect(page.locator('.note-schedule-badge.paused')).toHaveCount(1);
  await closeFlyout();

  // remove → back to unscheduled, request recorded, badge gone
  await editor.getByRole('button', { name: 'Remove schedule' }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'DELETE' });
  await page.getByRole('button', { name: 'More note actions' }).click();
  await expect(page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Schedule note' })).toBeVisible();
  await closeFlyout();
  await openFlyout();
  await expect(page.locator('.note-schedule-badge')).toHaveCount(0);
});

test('runs a Schedule now, shows the launched footnote with Open agent, against a stateful stub', async ({ page }) => {
  test.setTimeout(60_000);
  const runs: string[] = [];
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  const notes: StoredNote[] = [{ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly', schedule: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true }, nextRun: '2026-09-07T09:00:00-07:00' }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    const runMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/schedule\/run$/u.exec(url.pathname);
    if (runMatch && request.method() === 'POST') {
      runs.push(runMatch[1]);
      const note = notes.find(candidate => candidate.id === runMatch[1])!;
      note.schedule = { ...note.schedule!, lastRun: { at: new Date().toISOString(), status: 'launched', agentId: 'agent-1' } } as ScheduleBody;
      return route.fulfill({ json: { ...note } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.locator('.note-choice').filter({ hasText: 'Weekly' }).click();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  await expect(editor.locator('.schedule-last')).toContainText('Not run yet');

  // Run now → the run route is called and the launched footnote appears with an Open agent link
  await editor.getByRole('button', { name: /Run now/ }).click();
  await expect.poll(() => runs).toEqual(['note-identifier-001']);
  await expect(editor.locator('.schedule-last')).toContainText('launched');
  const openAgent = editor.getByRole('link', { name: 'Open agent' });
  await expect(openAgent).toBeVisible();
  await expect(openAgent).toHaveAttribute('href', '#agent=agent-1');
});

test('reddens the failed footnote and fly-out badge, and hides Open agent for a departed pane', async ({ page }) => {
  test.setTimeout(60_000);
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  // a scheduled note whose last Run failed on an agent that is no longer on the dashboard
  const notes: StoredNote[] = [{ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly', schedule: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, lastRun: { at: new Date().toISOString(), status: 'failed', detail: 'reset did not settle', agentId: 'gone-agent' } } as ScheduleBody, nextRun: '2026-09-07T09:00:00-07:00' }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  // the fly-out badge is red (not merely dim) for an enabled Schedule whose last Run failed
  await expect(page.locator('.note-schedule-badge.bad')).toHaveCount(1);
  await expect(page.locator('.note-schedule-badge.paused')).toHaveCount(0);

  await page.locator('.note-choice').filter({ hasText: 'Weekly' }).click();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  const footnote = editor.locator('.schedule-last');
  await expect(footnote).toContainText('failed, reset did not settle');
  await expect(footnote).toHaveClass(/bad/);
  // the pane the Run used is gone, so no Open agent link is offered
  await expect(editor.getByRole('link', { name: 'Open agent' })).toHaveCount(0);
});

test('picks the Adapter and target from the pane and records each write', async ({ page }) => {
  test.setTimeout(60_000);
  const notes: StoredNote[] = [];
  const scheduleWrites: Array<{ method: string; body?: ScheduleBody }> = [];
  let created = 0;
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude', origin: 'worktree' } };
  const adapters = {
    claude: { launchable: true, program: 'claude', stateSource: 'reported', turnCapture: true, bookmarks: true, inlineQuestions: true, commands: true, sandbox: false },
    codex: { launchable: true, program: 'codex', stateSource: 'title', turnCapture: true, bookmarks: false, inlineQuestions: false, commands: true, sandbox: false },
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const scheduleMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/schedule$/u.exec(url.pathname);
    if (scheduleMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === scheduleMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      const body = request.postDataJSON() as ScheduleBody;
      scheduleWrites.push({ method: 'PUT', body });
      note.schedule = body;
      note.nextRun = '2026-09-07T09:00:00-07:00';
      return route.fulfill({ json: { ...note } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.getByRole('button', { name: '+ New note' }).click();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Schedule note' }).click();
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } });

  // retarget to Scratch (resolves to Codex): the Adapter follows, and the write is recorded
  await editor.getByRole('button', { name: 'Target' }).click();
  await editor.getByRole('dialog', { name: 'Target' }).getByRole('radio', { name: /Scratch/ }).click();
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'codex', target: { scratch: true }, enabled: true } });
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Codex');

  // pin the Adapter back to Claude: the choice is recorded and survives the next retarget
  await editor.getByRole('button', { name: 'Agent' }).click();
  await editor.getByRole('dialog', { name: 'Agent' }).getByRole('radio', { name: 'Claude' }).click();
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true } });
});

test('does not leak the Adapter pin across a note switch', async ({ page }) => {
  test.setTimeout(60_000);
  const writes: Array<{ id: string; body: ScheduleBody }> = [];
  // two pre-existing Schedules on the same worktree (resolved kind Claude): one pinned to Codex
  // (kind ≠ resolved), one still following Claude. Switching between them must not carry the pin.
  const notes: StoredNote[] = [
    { id: 'note-pinned', text: 'Pinned body', title: 'Pinned note', schedule: { cron: '0 9 * * *', kind: 'codex', target: { worktreeId: 'wt-main' }, enabled: true }, nextRun: '2026-09-07T09:00:00-07:00' },
    { id: 'note-following', text: 'Following body', title: 'Following note', schedule: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true }, nextRun: '2026-09-07T09:00:00-07:00' },
  ];
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude', origin: 'worktree' } };
  const adapters = {
    claude: { launchable: true, program: 'claude', stateSource: 'reported', turnCapture: true, bookmarks: true, inlineQuestions: true, commands: true, sandbox: false },
    codex: { launchable: true, program: 'codex', stateSource: 'title', turnCapture: true, bookmarks: false, inlineQuestions: false, commands: true, sandbox: false },
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    const scheduleMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/schedule$/u.exec(url.pathname);
    if (scheduleMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === scheduleMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      const body = request.postDataJSON() as ScheduleBody;
      writes.push({ id: scheduleMatch[1], body });
      note.schedule = body;
      note.nextRun = '2026-09-07T09:00:00-07:00';
      return route.fulfill({ json: { ...note } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  const openNote = (title: string) => page.getByRole('button', { name: 'Notes' }).click().then(() => page.locator('.note-choice').filter({ hasText: title }).click());

  // open the pinned note: its Adapter reads Codex (stored kind ≠ resolved Claude → pinned)
  await openNote('Pinned note');
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Codex');

  // switch to the following note: its Adapter reads Claude
  await openNote('Following note');
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Claude');

  // retarget the following note to Scratch (resolves Codex): the Adapter follows — proving the
  // pinned note's explicit state did not leak into this note's editor (regression: it did)
  await editor.getByRole('button', { name: 'Target' }).click();
  await editor.getByRole('dialog', { name: 'Target' }).getByRole('radio', { name: /Scratch/ }).click();
  await expect.poll(() => writes.at(-1)).toEqual({ id: 'note-following', body: { cron: '0 9 * * *', kind: 'codex', target: { scratch: true }, enabled: true } });
});
