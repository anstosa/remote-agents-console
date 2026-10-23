import { expect, test, type Locator, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

type Note = { id: string; title: string; text: string; locked?: boolean; allWorkspaces?: boolean };
type NoteCountsFixture = { notes: Note[]; notesRevision: number };
type NoteCategoryCounts = { shared: number; locked: number; other: number };

// build two-digit exclusive note categories
const categoryNotes = (): Note[] => [
  ...Array.from({ length: 12 }, (_, index) => { // create one shared note
    return { id: `shared-${index}`, title: `Shared note ${index + 1}`, text: 'Shared', allWorkspaces: true, ...(index === 0 ? { locked: true } : {}) };
  }),
  ...Array.from({ length: 11 }, (_, index) => { // create one locked note
    return { id: `locked-${index}`, title: `Locked note ${index + 1}`, text: 'Locked', locked: true };
  }),
  ...Array.from({ length: 10 }, (_, index) => { // create one other note
    return { id: `other-${index}`, title: `Other note ${index + 1}`, text: 'Other' };
  })
];

// build the current dashboard revision
const dashboardSnapshot = (fixture: NoteCountsFixture) => ({
  generation: 1,
  serverStartedAt: 1,
  notesRevision: fixture.notesRevision,
  agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }],
  projects: []
});

// expose one mutable notes context with metadata writes
const mockNoteCounts = async (page: Page, fixture: NoteCountsFixture) => {
  await installDashboardSocket(page);
  await page.route('**/api/**', async route => {
    // route one fixture request
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one worktree and its note revision
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboardSnapshot(fixture) });
    // enable controlled metadata pushes
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the visible agent pane
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // disable optional agent update notices
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable optional server update notices
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // keep the dev bundle version stable
    if (url.pathname === '/api/ui-version') return route.fulfill({ json: { version: '/src/main.tsx' } });
    // expose a stable settings status
    if (url.pathname === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    // keep agent slash commands empty
    if (url.pathname === '/api/agents/agent-1/commands') return route.fulfill({ json: { commands: [] } });
    // keep conversation metadata empty
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    // keep terminal panes empty
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    // keep prompt collections empty
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // list the current note metadata
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: fixture.notes } });
    const metadata = /^\/api\/worktrees\/cora\/notes\/([^/]+)\/(lock|visibility)$/u.exec(url.pathname);
    // persist lock and sharing changes from the note ui
    if (metadata !== null && request.method() === 'PUT') {
      const note = fixture.notes.find(candidate => { // match one mutable note
        return candidate.id === metadata[1];
      });
      // reject unknown fixture notes
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      // update the addressed metadata field
      if (metadata[2] === 'lock') note.locked = (request.postDataJSON() as { locked: boolean }).locked || undefined;
      else note.allWorkspaces = (request.postDataJSON() as { allWorkspaces: boolean }).allWorkspaces || undefined;
      return route.fulfill({ json: { ...note, ...(metadata[2] === 'visibility' ? { visibleHere: true } : {}) } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// require one rendered rectangle
const renderedBounds = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  // fail clearly when the target has no rendered box
  if (bounds === null) throw new Error('Expected a visible note count control');
  return bounds;
};

// verify exclusive category text and accessible totals
const expectCategoryCounts = async (button: Locator, counts: NoteCategoryCounts) => {
  const total = counts.shared + counts.locked + counts.other;
  await expect(button).toHaveAccessibleName(`Notes (${total})`);
  await expect(button).toHaveAccessibleDescription(`${counts.shared} shared across worktrees, ${counts.locked} locked and not shared, ${counts.other} other notes`);
  const categories = [
    { name: 'shared', count: counts.shared },
    { name: 'locked', count: counts.locked },
    { name: 'other', count: counts.other }
  ];
  // omit only zero-valued visual categories
  for (const category of categories) {
    const badge = button.locator(`.notes-count-${category.name}`);
    await expect(badge).toHaveCount(category.count === 0 ? 0 : 1);
    // check each rendered category value
    if (category.count > 0) await expect(badge).toHaveText(String(category.count));
  }
};

test('splits note totals into shared, locked and other corner circles', async ({ page }, testInfo) => {
  // cover rendered categories and live metadata changes
  test.setTimeout(90_000);
  const runtimeErrors: string[] = [];
  page.on('console', message => { // capture browser console failures
    // retain only error-level console output
    if (message.type() === 'error') runtimeErrors.push(`${message.location().url}: ${message.text()}`);
  });
  page.on('pageerror', error => { // capture uncaught page failures
    runtimeErrors.push(error.message);
  });
  const fixture: NoteCountsFixture = { notes: categoryNotes(), notesRevision: 0 };
  await mockNoteCounts(page, fixture);
  await page.goto('/');

  const button = page.getByRole('button', { name: /^Notes \(\d+\)$/u });
  const group = button.locator('.notes-counts');
  await expectCategoryCounts(button, { shared: 12, locked: 11, other: 10 });
  const anchors: Array<{ top: number; right: number }> = [];
  // compare the same category group on phone and desktop
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(button.locator('.toolbar-label')).toBeVisible({ visible: width > 600 });
    await expect(group).toHaveCSS('position', 'absolute');
    const badges = group.locator(':scope > .notes-count');
    await expect(badges).toHaveCount(3);
    await expect(badges).toHaveText(['12', '11', '10']);
    const [buttonBox, groupBox] = await Promise.all([renderedBounds(button), renderedBounds(group)]);
    anchors.push({ top: groupBox.y - buttonBox.y, right: buttonBox.x + buttonBox.width - groupBox.x - groupBox.width });
    expect(groupBox.x + groupBox.width).toBeGreaterThan(buttonBox.x + buttonBox.width);
    expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(buttonBox.x + buttonBox.width + 8);
    expect(groupBox.x).toBeLessThan(buttonBox.x + buttonBox.width);
    expect(groupBox.y).toBeLessThan(buttonBox.y);
    expect(groupBox.y + groupBox.height).toBeGreaterThan(buttonBox.y);
    let previousRight: number | undefined;
    // keep every two-digit value readable in a round badge
    for (const badge of await badges.all()) {
      const bounds = await renderedBounds(badge);
      expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
      const content = await badge.evaluate(element => { // inspect one badge for clipping
        return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
      expect(content.scrollHeight).toBeLessThanOrEqual(content.clientHeight);
      // overlap each circle slightly with its previous neighbor
      if (previousRight !== undefined) {
        const overlap = previousRight - bounds.x;
        expect(overlap).toBeGreaterThanOrEqual(2);
        expect(overlap).toBeLessThanOrEqual(4);
      }
      previousRight = bounds.x + bounds.width;
    }
    await expect(button.locator('.notes-count-shared')).toHaveCSS('background-color', 'rgb(166, 173, 200)');
    await expect(button.locator('.notes-count-locked')).toHaveCSS('background-color', 'rgb(249, 226, 175)');
    await expect(button.locator('.notes-count-other')).toHaveCSS('background-color', 'rgb(203, 166, 247)');
    await page.screenshot({ path: testInfo.outputPath(`note-counts-${width}.png`), fullPage: true });
  }
  const [phoneAnchor, desktopAnchor] = anchors;
  // require both layouts before comparing their corner placement
  if (phoneAnchor === undefined || desktopAnchor === undefined) throw new Error('Expected phone and desktop note count anchors');
  expect(desktopAnchor.top).toBeCloseTo(phoneAnchor.top, 1);
  expect(desktopAnchor.right).toBeCloseTo(phoneAnchor.right, 1);

  await button.click();
  await page.getByRole('button', { name: 'Other note 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Note' });
  await dialog.getByRole('button', { name: 'Lock note' }).click();
  await expectCategoryCounts(button, { shared: 12, locked: 12, other: 9 });
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  await page.getByRole('group', { name: 'More note actions' }).getByRole('button', { name: 'Show in all workspaces', exact: true }).click();
  await expectCategoryCounts(button, { shared: 13, locked: 11, other: 9 });

  // move every note into the shared category through a remote metadata revision
  fixture.notes.forEach(note => { // share one remotely changed note
    note.allWorkspaces = true;
  });
  fixture.notesRevision += 1;
  await expect.poll(() => { // wait for the dashboard socket
    return dashboardSocketReady(page);
  }).toBe(true);
  await emitDashboard(page, dashboardSnapshot(fixture));
  await expectCategoryCounts(button, { shared: 33, locked: 0, other: 0 });

  // remove every note through a second remote revision
  fixture.notes = [];
  fixture.notesRevision += 1;
  await emitDashboard(page, dashboardSnapshot(fixture));
  await expect(button).toHaveAccessibleName('Notes (0)');
  await expect(button).not.toHaveAttribute('aria-description');
  await expect(group).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
