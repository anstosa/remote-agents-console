import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { chooseSplit } from './split-menu.js';

// The phone Workspace: its panels sit in a horizontal swipe carousel, one panel per screen. The
// toolbar's dots track the panel in view and open a titled split menu; a panel opened from the
// toolbar scrolls into view; Browser and Code move into the ⋮; and a panel's expand hides the tab
// row and toolbar until it is restored.

test.use({ viewport: { width: 428, height: 880 }, hasTouch: true, isMobile: true });

const panes = [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
];

const coraAgent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/phone', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready', projectUrl: 'https://project.example.com', stack: { running: true, tunnel: true }, queuedPromptCount: 0 };

const routeApi = (page: Page, agents = [coraAgent]) => page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects: [] } });
  if (path === '/api/push/public-key') return route.fulfill({ json: {} });
  if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  if (/^\/api\/agents\/agent-[12]\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
  if (/^\/api\/agents\/agent-[12]\/message-files$/u.test(path)) return route.fulfill({ json: { files: [] } });
  // create one blank note for focus-preservation coverage
  if (path === '/api/worktrees/cora/notes' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 'note-cora-new', text: '' } });
  // retain the existing note fixture for picker navigation
  if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } });
  if (path === '/api/worktrees/owen/notes') return route.fulfill({ json: { notes: [] } });
  if (path === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes } });
  if (path === '/api/worktrees/owen/panes') return route.fulfill({ json: { panes: [] } });
  if (path === '/api/worktrees/cora/comparison') return route.fulfill({ json: { kind: 'working', base: 'HEAD', gitBase: 'HEAD', files: [], fingerprint: '', truncated: false } });
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
const dots = (page: Page) => toolbar(page).getByRole('group', { name: 'Panels' });
const carousel = (page: Page) => page.locator('.log-split');
const agentPanel = (page: Page) => page.locator('.log-output');
const terminalPanel = (page: Page) => page.locator('.terminal-pane[data-panel-key="%5"]');
// require one surface-0 border on a split's content edge
const expectBottomBorder = async (target: Locator, label: string) => {
  const border = await target.evaluate(element => {
    const probe = document.createElement('span');
    probe.style.borderBottom = '1px solid var(--surface-0)';
    document.body.append(probe);
    const expectedColor = getComputedStyle(probe).borderBottomColor;
    probe.remove();
    const computed = getComputedStyle(element);
    return { width: computed.borderBottomWidth, style: computed.borderBottomStyle, color: computed.borderBottomColor, expectedColor };
  });
  expect(border.width, label).toBe('1px');
  expect(border.style, label).toBe('solid');
  expect(border.color, label).toBe(border.expectedColor);
};

// mobile panels stay borderless without suppressing their focus pseudo-elements
const expectNoSplitBorder = async (target: Locator, label: string) => {
  const edges = await target.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.boxShadow];
  });
  expect(edges, label).toEqual(['0px', '0px', '0px', '0px', 'none']);
};

// the carousel sits on a panel boundary: one panel fills the screen
const expectSnapped = (page: Page) => expect.poll(() => carousel(page).evaluate(element => element.scrollLeft % element.clientWidth)).toBe(0);
// the panel whose dot is current
const expectCurrentDot = (page: Page, name: string) => expect(dots(page).locator(`.panel-dot[title="${name}"]`)).toHaveAttribute('data-current', 'true');
// require keyboard focus to follow an explicit split destination
const expectPanelFocused = (panel: Locator) => expect.poll(() => panel.evaluate(element => element === document.activeElement || element.contains(document.activeElement))).toBe(true);
// a one-finger swipe across the middle of `over`, `distance` pixels (positive moves the finger
// right). A quick swipe flings; a `slow` one drags and stops before lifting, so it carries no
// velocity and the carousel snaps to the nearest panel. Small controls start at their centre.
const swipe = async (page: Page, over: Locator, distance: number, slow = false, fromCenter = false) => {
  const box = (await over.boundingBox())!;
  const x = Math.round(box.x + box.width / 2 - (fromCenter ? 0 : distance / 2));
  const y = Math.round(box.y + box.height / 2);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.round(distance * step / 12), y }] });
    if (slow) await page.waitForTimeout(30);
  }
  if (slow) await page.waitForTimeout(300);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
};

const openTerminal = async (page: Page) => {
  await toolbar(page).getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
};

// select a worktree from the phone's workspace flyout
const switchWorkspace = async (page: Page, name: string) => {
  await page.getByRole('tab', { selected: true }).click();
  await page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${name}\\b`, 'u') }).click();
};

test.beforeEach(async ({ page }) => {
  // opt in before loading split controls
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await installPaneMock(page);
  await page.route('https://project.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Phone preview</main>' }));
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
});

test('swiping moves between panels one screen at a time, and the dots follow', async ({ page }) => {
  // one panel: no dots
  await expect(agentPanel(page)).toBeInViewport();
  await expect(dots(page)).toHaveCount(0);

  // a newly opened Terminal scrolls into view, and each open panel gets a dot
  await openTerminal(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(agentPanel(page)).not.toBeInViewport();
  await expect(dots(page).locator('.panel-dot')).toHaveCount(2);
  await expect(dots(page).getByRole('button', { name: 'Choose split' })).toHaveCount(1);
  await expectCurrentDot(page, 'Show terminal build');

  // a swipe over the Terminal back to the agent panel snaps to it, and its dot becomes current
  await swipe(page, terminalPanel(page).locator('.terminal-canvas'), 300);
  await expectSnapped(page);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(terminalPanel(page)).not.toBeInViewport();
  await expectCurrentDot(page, 'Show agent output');

  // a drag short of half a screen snaps back to the panel it started on
  await swipe(page, agentPanel(page).locator('.log-canvas'), -120, true);
  await expectSnapped(page);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show agent output');

  // a swipe over the agent's output moves on to the Terminal
  await swipe(page, agentPanel(page).locator('.log-canvas'), -300);
  await expectSnapped(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');

  // any blank part of the reserved flex area opens the vertical split chooser
  const trigger = dots(page).getByRole('button', { name: 'Choose split' });
  await expect(trigger.locator(':scope > .flyout-caret')).toBeVisible();
  const triggerBox = (await trigger.boundingBox())!;
  expect(triggerBox.width).toBeGreaterThan(50);
  await trigger.click({ position: { x: 3, y: triggerBox.height / 2 } });
  const menu = page.getByRole('menu', { name: 'Splits' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Agent output', 'Terminal build']);
  // anchor the flyout over the split strip instead of the toolbar's far edge
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.x + menuBox.width / 2 - triggerBox.x - triggerBox.width / 2)).toBeLessThanOrEqual(1);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await menu.getByRole('menuitem', { name: 'Agent output' }).click();
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectSnapped(page);
  await expectCurrentDot(page, 'Show agent output');

  // with the dots in it the phone toolbar keeps to one row: git shrinks to its icon and state dot
  const tops = await toolbar(page).locator('.workspace-toolbar-actions > *').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(toolbar(page).locator('.git-branch')).toBeHidden();
  await expect(toolbar(page).locator('.git-status-dot')).toBeVisible();
  // its content-sized changed-files popup stays on screen, though the button sits at the row's right
  await toolbar(page).getByRole('button', { name: /^Git status/u }).click();
  const changes = page.getByRole('region', { name: 'Changed files' });
  await expect(changes).toBeInViewport({ ratio: 1 });
  await page.mouse.click(4, 4);
  await expect(changes).toHaveCount(0);
});

test('loading a worktree restores its last viewed split even when a note arrives later', async ({ page }) => {
  const owenAgent = { ...coraAgent, id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', branch: 'feature/other' };
  await page.unroute('**/api/**');
  await routeApi(page, [coraAgent, owenAgent]);
  let holdCoraNotes = false;
  let releaseNotes = () => {};
  const notesGate = new Promise<void>(resolve => { releaseNotes = resolve; });
  // delay the returning worktree's note so its saved agent split must survive hydration
  await page.route('**/api/worktrees/cora/notes', async route => {
    if (holdCoraNotes) await notesGate;
    await route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } });
  });
  await page.reload();
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await chooseSplit(page, 'Agent output');
  await expectCurrentDot(page, 'Show agent output');

  await switchWorkspace(page, 'Owen');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expectCurrentDot(page, 'Show project browser');

  holdCoraNotes = true;
  await switchWorkspace(page, 'Cora');
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  releaseNotes();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  await expectCurrentDot(page, 'Show agent output');
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });

  await chooseSplit(page, 'Note');
  await switchWorkspace(page, 'Owen');
  await expectCurrentDot(page, 'Show project browser');
  await expect(page.getByRole('dialog', { name: 'Browser' })).toBeInViewport({ ratio: 0.99 });
  await switchWorkspace(page, 'Cora');
  await expectCurrentDot(page, 'Show note');
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeInViewport({ ratio: 0.99 });

  await page.reload();
  await expectCurrentDot(page, 'Show note');
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeInViewport({ ratio: 0.99 });
});

test('opening a panel during note hydration overrides the saved split', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('rac.last-split:cora', 'agent');
    localStorage.setItem('rac.note-view:cora', JSON.stringify({ noteId: 'note-cora-000001', expanded: false }));
  });
  let releaseNotes = () => {};
  const notesGate = new Promise<void>(resolve => { releaseNotes = resolve; });
  // keep the saved note response pending while the browser is opened
  await page.route('**/api/worktrees/cora/notes', async route => {
    await notesGate;
    await route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } });
  });
  await page.reload();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Browser' })).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show project browser');
  releaseNotes();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Browser' })).toBeInViewport({ ratio: 0.99 });
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Browser' })).toBeInViewport({ ratio: 0.99 });
});

test('a failed note load preserves its last-viewed split for the next load', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('rac.last-split:cora', 'note');
    localStorage.setItem('rac.note-view:cora', JSON.stringify({ noteId: 'note-cora-000001', expanded: false }));
  });
  let notesAvailable = false;
  // fail the first load, then allow the same saved note to return after a reload
  await page.route('**/api/worktrees/cora/notes', async route => {
    if (!notesAvailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } });
  });
  await page.reload();
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  notesAvailable = true;
  await page.reload();
  await expectCurrentDot(page, 'Show note');
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeInViewport({ ratio: 0.99 });
});

test('a successful in-session note retry lets a newly opened note take focus', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('rac.last-split:cora', 'agent'));
  let notesAvailable = false;
  // fail the initial read but let the notes menu retry succeed
  await page.route('**/api/worktrees/cora/notes', route => notesAvailable
    ? route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } })
    : route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await page.reload();
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  notesAvailable = true;
  await toolbar(page).getByRole('button', { name: 'Notes (0)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeInViewport({ ratio: 0.99 });
});

test('the split indicator swipes in both directions without opening its menu', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await chooseSplit(page, 'Agent output');
  await openTerminal(page);
  await chooseSplit(page, 'Note');
  const trigger = dots(page).getByRole('button', { name: 'Choose split' });
  await expectCurrentDot(page, 'Show note');

  // keep the visible marks evenly separated around the active dash
  // include the child dot transitions before measuring their visible edges
  await trigger.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
  const gaps = await trigger.locator('.panel-dot').evaluateAll(elements => elements.slice(1).map((element, index) => {
    const previous = elements[index]!;
    const previousBox = previous.getBoundingClientRect();
    const currentBox = element.getBoundingClientRect();
    const previousWidth = parseFloat(getComputedStyle(previous, '::before').width);
    const currentWidth = parseFloat(getComputedStyle(element, '::before').width);
    return currentBox.left + (currentBox.width - currentWidth) / 2 - (previousBox.right - (previousBox.width - previousWidth) / 2);
  }));
  expect(gaps).toHaveLength(2);
  expect(Math.abs(gaps[0]! - gaps[1]!)).toBeLessThanOrEqual(1);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(5.5);

  await swipe(page, trigger, 90, false, true);
  await expectCurrentDot(page, 'Show terminal build');
  await swipe(page, trigger, -90, false, true);
  await expectCurrentDot(page, 'Show note');
  await swipe(page, trigger, 90, false, true);
  await expectCurrentDot(page, 'Show terminal build');
  await swipe(page, trigger, 90, false, true);
  await expectCurrentDot(page, 'Show agent output');
  await expect(page.getByRole('menu', { name: 'Splits' })).toHaveCount(0);
  // check menu opening separately from the touch swipe click-suppression lifecycle
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Splits' })).toBeVisible();
});

// preserve note navigation and the mobile editor's unsaved draft
test('swiping a note in preview or edit mode changes splits', async ({ page }, testInfo) => {
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note).toBeInViewport({ ratio: 0.99 });

  // the preview yields a horizontal gesture to its parent carousel
  await swipe(page, note.locator('.note-markdown'), 300);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(note.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  await chooseSplit(page, 'Note');
  await note.locator('.note-markdown').click({ position: { x: 20, y: 55 } });
  const editor = note.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toBeVisible();
  // short editing viewports remain borderless even when the wide-container rule applies
  await page.setViewportSize({ width: 428, height: 420 });
  await page.screenshot({ path: testInfo.outputPath('editing-note-short.png') });
  await expectNoSplitBorder(note, 'short phone editing Note');
  await page.setViewportSize({ width: 428, height: 880 });
  await expectNoSplitBorder(note, 'portrait phone editing Note');
  await page.screenshot({ path: testInfo.outputPath('editing-note-portrait.png') });
  await editor.fill('Phone checklist\nSwipe draft');

  // an editing note yields the same horizontal gesture without losing its draft
  await swipe(page, editor, 300);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await chooseSplit(page, 'Note');
  // a native mobile blur retains the editor rather than returning to preview
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Phone checklist\nSwipe draft');
});

test('with only the agent panel, and so no dots, the phone toolbar still keeps to one row', async ({ page }) => {
  await expect(agentPanel(page)).toBeInViewport();
  await expect(dots(page)).toHaveCount(0);
  const actions = toolbar(page).locator('.workspace-toolbar-actions');
  const middles = await actions.locator('> *').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return Math.round(box.top + box.height / 2); }));
  expect(new Set(middles).size).toBe(1);
  expect(await actions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(toolbar(page).locator('.git-branch')).toBeHidden();
  await expect(toolbar(page).locator('.git-status-dot')).toBeVisible();
});

test('tapping a Terminal that has not rendered yet keeps it in view', async ({ page }) => {
  // a Terminal still connecting: its pane has sent no size or bytes, so nothing has rendered
  await toolbar(page).getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menuitem', { name: /build/u }).click();
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');

  // a tap focuses the terminal's input, and Firefox scrolls a focused element into view
  const box = (await terminalPanel(page).locator('.terminal-canvas').boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(terminalPanel(page).locator('.xterm-helper-textarea')).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await expectSnapped(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');
});

test('Browser and Code move into the ⋮, and a panel opened from the toolbar scrolls into view', async ({ page }) => {
  // the phone toolbar keeps Launch, Terminal and Notes; Browser and Code are in the ⋮
  await expect(toolbar(page).getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Browser', exact: true })).toBeHidden();
  await expect(toolbar(page).getByRole('button', { name: 'Code', exact: true })).toBeHidden();

  // a note picked from the toolbar scrolls into view
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show note');

  // so does the browser, from the ⋮
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expect(note).not.toBeInViewport();
  await expectCurrentDot(page, 'Show project browser');

  // and the Code panel
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show code changes');

  // the flyout lists every title vertically and Escape dismisses it without navigating
  await dots(page).getByRole('button', { name: 'Choose split' }).click();
  const menu = page.getByRole('menu', { name: 'Splits' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Agent output', 'Note', 'Project browser', 'Code changes']);
  await expect(menu.getByRole('menuitem', { name: 'Code changes' })).toHaveAttribute('aria-current', 'true');
  const firstRow = (await menu.getByRole('menuitem', { name: 'Agent output' }).boundingBox())!;
  const secondRow = (await menu.getByRole('menuitem', { name: 'Note' }).boundingBox())!;
  expect(secondRow.y).toBeGreaterThan(firstRow.y);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(code).toBeInViewport({ ratio: 0.99 });

  // choosing an open panel from the ⋮ shows it rather than closing it
  await chooseSplit(page, 'Agent output');
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expect(dots(page).locator('.panel-dot')).toHaveCount(4);
});

// explicit content opens select and focus new or retained phone splits
test('explicit opens focus reused notes and browser destinations', async ({ page }) => {
  const toolbarRegion = toolbar(page);
  const note = page.getByRole('dialog', { name: 'Note' });
  const browser = page.getByRole('dialog', { name: 'Browser' });

  await toolbarRegion.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await expect(note).toBeInViewport({ ratio: 0.99 });
  await expectPanelFocused(note);

  await toolbarRegion.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expectPanelFocused(browser);

  // an already-mounted note must still replace the current mobile split
  await toolbarRegion.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await expect(note).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show note');
  await expectPanelFocused(note);

  await chooseSplit(page, 'Agent output');
  await expectPanelFocused(agentPanel(page));
  await pushBytes(page, 'agent-1', '\r\nProject https://project.example.com/details\r\n');
  const projectLink = page.getByRole('link', { name: 'Open https://project.example.com/details', exact: true });
  await projectLink.click();
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show project browser');
  await expectPanelFocused(browser);

  // repeated navigation to the same retained URL must focus the same destination again
  await chooseSplit(page, 'Agent output');
  await projectLink.click();
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expectPanelFocused(browser);

  await toolbarRegion.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: '+ New note', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toBeInViewport({ ratio: 0.9 });
  await expect(editor).toBeFocused();
  await expectCurrentDot(page, 'Show note');
});

// desktop destinations receive focus even though every split remains visible
test.describe('desktop split focus', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1400, height: 900 } });

  test('accepted output links focus an existing browser split every time', async ({ page }) => {
    const toolbarRegion = toolbar(page);
    const browser = page.getByRole('dialog', { name: 'Browser' });
    await toolbarRegion.getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(browser).toBeVisible();
    await expectPanelFocused(browser);

    await pushBytes(page, 'agent-1', '\r\nProject https://project.example.com/details\r\n');
    const projectLink = page.getByRole('link', { name: 'Open https://project.example.com/details', exact: true });
    await projectLink.click();
    await expectPanelFocused(browser);

    // the same retained URL still represents a fresh explicit open
    await page.getByRole('textbox', { name: 'Prompt' }).focus();
    await projectLink.click();
    await expectPanelFocused(browser);
  });
});

// keep each split edge visible while input footers sit below terminal content
test('shows split borders only on desktop while keeping input footers flush', async ({ page }, testInfo) => {
  await openTerminal(page);
  await chooseSplit(page, 'Agent output');
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const agent = agentPanel(page);
  const terminal = terminalPanel(page);
  const note = page.getByRole('dialog', { name: 'Note' });
  const browser = page.getByRole('dialog', { name: 'Browser' });
  const code = page.getByRole('region', { name: 'Code changes' });
  // retain footer placement while limiting content separators to desktop
  const expectBorderAbove = async (panel: Locator, content: Locator, footer: Locator, label: string, bordered = false) => {
    // mobile content stays flush without a decorative separator
    if (bordered) await expectBottomBorder(content, label);
    else await expectNoSplitBorder(content, label);
    const placement = await Promise.all([panel, content, footer].map(locator => locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, borderBottom: getComputedStyle(element).borderBottomWidth };
    })));
    expect(placement[0].borderBottom, label).toBe('0px');
    expect(placement[2].borderBottom, label).toBe('0px');
    expect(Math.abs(placement[1].bottom - placement[2].top), label).toBeLessThanOrEqual(1);
  };

  // desktop panels expose the same content edge without mobile key rows
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('split-bottom-borders-desktop.png'), fullPage: true });
  const prompt = agent.locator('.agent-composer');
  await expect(prompt).toBeVisible();
  await expectBorderAbove(agent, agent.locator('.agent-output'), prompt, 'desktop Agent prompt', true);
  await expect(terminal.getByLabel('Terminal keys')).toBeHidden();
  await expectBottomBorder(terminal.locator('.terminal-canvas'), 'desktop Terminal');
  await expectBottomBorder(note, 'desktop Note');
  await expectBottomBorder(browser, 'desktop Browser');
  await expectBottomBorder(code, 'desktop Code');

  // phone panels omit outer and content-edge borders in every input mode
  await page.setViewportSize({ width: 428, height: 880 });
  await expectNoSplitBorder(note, 'phone Note');
  await expectNoSplitBorder(browser, 'phone Browser');
  await expectNoSplitBorder(code, 'phone Code');
  await chooseSplit(page, 'Agent output');
  await expectBorderAbove(agent, agent.locator('.agent-output'), prompt, 'phone Agent prompt');
  await agent.locator('.terminal-selection-surface').tap();
  const agentKeys = agent.getByLabel('Terminal keys');
  await expect(agentKeys).toBeVisible();
  await expectBorderAbove(agent, agent.locator('.agent-output'), agentKeys, 'phone Agent keys');
  await chooseSplit(page, 'Terminal build');
  const terminalKeys = terminal.getByLabel('Terminal keys');
  await expect(terminalKeys).toBeVisible();
  await expectBorderAbove(terminal, terminal.locator('.terminal-canvas'), terminalKeys, 'phone Terminal keys');
  await page.screenshot({ path: testInfo.outputPath('split-bottom-borders-phone.png'), fullPage: true });
});

test('expand hides the tab row and toolbar for every panel kind, and restore brings them back', async ({ page }) => {
  await openTerminal(page);
  // with the Terminal in view the toolbar is its helper keys (and the dots); back to the agent
  await chooseSplit(page, 'Agent output');
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const tabs = page.getByRole('tablist', { name: 'Agents and worktrees' });
  const panels: [title: string, panel: Locator, content: Locator, label: string][] = [
    ['Agent output', agentPanel(page), agentPanel(page).locator('.agent-output'), 'agent'],
    ['Terminal build', terminalPanel(page), terminalPanel(page).locator('.terminal-canvas'), 'terminal build'],
    ['Note', page.getByRole('dialog', { name: 'Note' }), page.getByRole('dialog', { name: 'Note' }), 'note'],
    ['Project browser', page.getByRole('dialog', { name: 'Browser' }), page.getByRole('dialog', { name: 'Browser' }), 'browser'],
    ['Code changes', page.getByRole('region', { name: 'Code changes' }), page.getByRole('region', { name: 'Code changes' }), 'code']
  ];
  // check expansion for every titled split
  for (const [title, panel, content, label] of panels) {
    await chooseSplit(page, title);
    await expect(panel).toBeInViewport({ ratio: 0.99 });
    const bottom = await panel.evaluate(element => element.getBoundingClientRect().bottom);
    await panel.getByRole('button', { name: `Expand ${label}` }).click();
    await expect(tabs).toBeHidden();
    if (label.startsWith('terminal')) {
      // a full-screen Terminal keeps its helper keys, and only them
      await expect(page.getByRole('button', { name: 'Esc' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: 'Open a terminal' })).toBeHidden();
      await expect(dots(page)).toBeHidden();
    } else await expect(toolbar(page)).toBeHidden();
    await expectNoSplitBorder(content, `expanded ${label}`);
    // the panel grows into the freed space
    await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThan(bottom + 40);
    await panel.getByRole('button', { name: `Restore ${label}` }).click();
    await expect(tabs).toBeVisible();
    await expect(toolbar(page)).toBeVisible();
  }

  // moving to another panel while expanded stays full screen, and the panel in view offers the restore
  await chooseSplit(page, 'Note');
  await page.getByRole('dialog', { name: 'Note' }).getByRole('button', { name: 'Expand note' }).click();
  await carousel(page).evaluate(element => element.scrollTo({ left: element.clientWidth }));
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(tabs).toBeHidden();
  await terminalPanel(page).getByRole('button', { name: 'Restore terminal build' }).click();
  await expect(tabs).toBeVisible();

  // closing the full-screen panel ends full screen
  await terminalPanel(page).getByRole('button', { name: 'Expand terminal build' }).click();
  await expect(tabs).toBeHidden();
  await terminalPanel(page).getByRole('button', { name: 'Minimize terminal build' }).click();
  await expect(terminalPanel(page)).toHaveCount(0);
  await expect(tabs).toBeVisible();
  await expect(toolbar(page)).toBeVisible();
});
