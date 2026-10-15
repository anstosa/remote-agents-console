import { expect, test } from '@playwright/test';

// require one rendered element box
function requireBounds(bounds: { x: number; y: number; width: number; height: number } | null, label: string): asserts bounds is { x: number; y: number; width: number; height: number } {
  expect(bounds, `${label} bounds`).not.toBeNull();
  if (bounds === null) throw new Error(`${label} bounds unavailable`);
}

const currentId = 'aaaaaaaa-2222-4333-8444-555555555555';
const now = Date.now();
const conversations = [
  { kind: 'claude', id: currentId, name: 'Diagnose the shell', automatic: false, lastActiveAt: now - 3_600_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: true },
  { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'tmux fish shell issue', automatic: true, lastActiveAt: now - 86_400_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: false },
  { kind: 'claude', id: 'cccccccc-2222-4333-8444-555555555555', name: 'Release plan review', automatic: false, lastActiveAt: now - 172_800_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: false },
];

// stub every route the live-agent view preloads, plus the conversations list
async function mockConsole(page: import('@playwright/test').Page, onConversations?: (url: URL) => void) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/conversations' && request.method() === 'GET') {
      onConversations?.(url);
      return route.fulfill({ json: { conversations, canResume: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// keep the opposing conversation bubbles distinct from the note sheet
test('shows two opposing conversation bubbles on desktop and phone', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/');
  // preserve the icon and its interaction in both layouts
  for (const viewport of [{ width: 900, height: 780 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const control = page.getByRole('button', { name: 'Conversations (0)', exact: true });
    const icon = control.locator('svg');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon).toHaveCSS('fill', 'none');
    await expect(icon.locator('path')).toHaveCount(2);
    await expect(icon.locator('path').nth(0)).toHaveAttribute('d', 'M4 3h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-5 4V5a2 2 0 0 1 2-2Z');
    await expect(icon.locator('path').nth(1)).toHaveAttribute('d', 'M20 8a2 2 0 0 1 2 2v11l-4-3h-7a2 2 0 0 1-2-2');
    // keep the glyph centered within the control on both layouts
    const controlBounds = await control.boundingBox();
    const iconBounds = await icon.boundingBox();
    requireBounds(controlBounds, 'conversations control');
    requireBounds(iconBounds, 'conversations icon');
    expect(Math.abs(iconBounds.x + iconBounds.width / 2 - controlBounds.x - controlBounds.width / 2)).toBeLessThan(0.5);
    expect(Math.abs(iconBounds.y + iconBounds.height / 2 - controlBounds.y - controlBounds.height / 2)).toBeLessThan(0.5);
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.conversations-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(control).toHaveAttribute('aria-expanded', 'false');
  }
});

test('lists named conversations in a searchable dialog on the desktop', async ({ page }) => {
  let listedWithAgent = false;
  await mockConsole(page, url => { listedWithAgent = url.searchParams.get('agentId') === 'agent-1'; });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');

  const control = page.getByRole('button', { name: 'Conversations' });
  // the closed control counts the console-named conversations (none yet)
  await expect(control).toHaveAccessibleName('Conversations (0)');
  await control.click();
  const menu = page.locator('.conversations-menu');
  await menu.locator('.conversations-all').click();
  // the live agent is passed so the current row resolves
  await expect.poll(() => listedWithAgent).toBe(true);

  const dialog = page.locator('.conversations-dialog');
  await expect(dialog.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  // the block that applies to every row is stated once at the top
  await expect(dialog.locator('.conversations-note')).toBeVisible();
  const rows = dialog.locator('.conversation-row');
  await expect(rows).toHaveCount(3);
  // newest-active first, as the server ordered them
  await expect(rows.first()).toContainText('Diagnose the shell');
  // the current row carries the CURRENT pill and aria-current
  const currentRow = dialog.locator('.conversation-row.current');
  await expect(currentRow).toHaveAttribute('aria-current', 'true');
  await expect(currentRow.locator('.conversation-pill')).toHaveText('CURRENT');
  // an automatic title renders in italics
  const automaticRow = dialog.locator('.conversation-row.automatic');
  await expect(automaticRow).toContainText('tmux fish shell issue');
  await expect(automaticRow.locator('.conversation-copy strong')).toHaveCSS('font-style', 'italic');
  // a Claude row shows its kind glyph and relative age
  await expect(currentRow.locator('.conversation-copy small')).toContainText('Claude');

  // search narrows on the conversation name
  await dialog.getByRole('searchbox').fill('release');
  await expect(dialog.locator('.conversation-row')).toHaveCount(1);
  await expect(dialog.locator('.conversation-row')).toContainText('Release plan review');
  await dialog.getByRole('searchbox').fill('');
  await expect(dialog.locator('.conversation-row')).toHaveCount(3);

  await dialog.getByRole('button', { name: 'Close conversations' }).click();
  await expect(dialog).toBeHidden();
});

const owenId = 'dddddddd-2222-4333-8444-555555555555';
const orphanId = 'eeeeeeee-2222-4333-8444-555555555555';
const codexId = 'ffffffff-2222-4333-8444-555555555555';
// a richer list: current, resumable-here, a sibling-Worktree row, an orphaned row, and an
// unlaunchable-kind row, across two Worktrees of one Project
const resumableConversations = [
  { kind: 'claude', id: currentId, name: 'Diagnose the shell', automatic: false, lastActiveAt: now - 3_600_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: true },
  { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'Release plan review', automatic: false, lastActiveAt: now - 7_200_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: false },
  { kind: 'claude', id: owenId, name: 'Owen investigation', automatic: false, lastActiveAt: now - 10_800_000, directory: '/worktrees/owen', worktreeId: 'owen', consoleNamed: false, reviewRun: false, current: false },
  { kind: 'claude', id: orphanId, name: 'Old scratch chat', automatic: false, lastActiveAt: now - 14_400_000, directory: '/gone/away', consoleNamed: false, reviewRun: false, current: false },
  { kind: 'codex', id: codexId, name: 'Retired codex thread', lastActiveAt: now - 18_000_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: false },
];

// two agents on two Worktrees of one Project; Claude is launchable, Codex is not
async function mockResumableConsole(page: import('@playwright/test').Page, onSwitch: (worktreeId: string, body: unknown) => void, switchError?: string) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const switchMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/conversations\/switch$/u);
    if (switchMatch !== null && request.method() === 'POST') {
      onSwitch(switchMatch[1]!, request.postDataJSON());
      if (switchError !== undefined) return route.fulfill({ status: 409, json: { error: switchError } });
      return route.fulfill({ status: 201, json: { agentId: `resumed-${switchMatch[1]}` } });
    }
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { claude: { launchable: true }, codex: { launchable: false } }, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' },
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/conversations') && request.method() === 'GET') return route.fulfill({ json: { conversations: resumableConversations, canResume: true } });
    if (url.pathname.endsWith('/notes') && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname.endsWith('/saved-prompts')) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname.endsWith('/prompt-history')) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the full-screen dialog from the active (Cora) agent's Conversations control
async function openDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^Conversations/ }).click();
  await page.locator('.conversations-menu').locator('.conversations-all').click();
  return page.locator('.conversations-dialog');
}

test('disables rows that cannot be resumed: the current one, an orphaned one, and an unlaunchable kind', async ({ page }) => {
  await mockResumableConsole(page, () => {});
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  const dialog = await openDialog(page);
  const button = (name: string) => dialog.locator('.conversation-row', { hasText: name }).locator('button.conversation-choice');
  // the current Conversation, an orphaned directory, and an unconfigured kind are inert
  await expect(button('Diagnose the shell')).toBeDisabled();
  await expect(button('Old scratch chat')).toBeDisabled();
  await expect(button('Retired codex thread')).toBeDisabled();
  // a homed Conversation of a launchable kind resumes, here or on a sibling Worktree
  await expect(button('Release plan review')).toBeEnabled();
  await expect(button('Owen investigation')).toBeEnabled();
});

test('resumes a same-Worktree Conversation in place and closes the dialog', async ({ page }) => {
  const switches: Array<{ worktreeId: string; body: unknown }> = [];
  await mockResumableConsole(page, (worktreeId, body) => switches.push({ worktreeId, body }));
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  const dialog = await openDialog(page);
  await dialog.locator('.conversation-row', { hasText: 'Release plan review' }).locator('button.conversation-choice').click();
  // the switch runs on the current Worktree with the row's kind and id
  await expect.poll(() => switches).toEqual([{ worktreeId: 'cora', body: { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555' } }]);
  await expect(dialog).toBeHidden();
});

test('keeps the dialog open and shows the reason when a same-Worktree resume fails', async ({ page }) => {
  await mockResumableConsole(page, () => {}, 'Close duplicate worktree agents before switching chats.');
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  const dialog = await openDialog(page);
  await dialog.locator('.conversation-row', { hasText: 'Release plan review' }).locator('button.conversation-choice').click();
  // the dialog stays put and surfaces the server's reason inline on a same-Worktree resume
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.conversations-error')).toContainText('Close duplicate worktree agents');
});

test('resumes a sibling-Worktree Conversation by navigating to that Worktree first', async ({ page }) => {
  const switches: Array<{ worktreeId: string; body: unknown }> = [];
  await mockResumableConsole(page, (worktreeId, body) => switches.push({ worktreeId, body }));
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  // Cora is the active tab to begin with
  await expect(page.getByRole('tab', { name: /Cora/ })).toHaveAttribute('aria-selected', 'true');
  const dialog = await openDialog(page);
  await dialog.locator('.conversation-row', { hasText: 'Owen investigation' }).locator('button.conversation-choice').click();
  // the console navigates to Owen's tab and switches there
  await expect(page.getByRole('tab', { name: /Owen/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => switches).toEqual([{ worktreeId: 'owen', body: { kind: 'claude', id: owenId } }]);
});

// a Project-wide list with a live Cora agent, some rows already named through the console, and
// a POST /name that confirms (or not) and a DELETE that forgets the record. The conversations
// GET reflects the record changes so a reload shows the quick list update.
async function mockNamingConsole(page: import('@playwright/test').Page, options: { confirm?: boolean; rows?: typeof conversations } = {}) {
  const { confirm = true, rows = conversations } = options;
  const state = { names: [] as unknown[], removed: [] as string[], namedCurrent: false };
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/agents/agent-1/conversations/name' && request.method() === 'POST') {
      state.names.push(request.postDataJSON());
      if (!confirm) return route.fulfill({ status: 409, json: { error: 'The agent did not confirm the name.' } });
      state.namedCurrent = true;
      return route.fulfill({ status: 201, json: { conversation: { ...rows[0], consoleNamed: true } } });
    }
    const removeMatch = url.pathname.match(/^\/api\/worktrees\/cora\/conversations\/([^/]+)\/([^/]+)$/u);
    if (removeMatch !== null && request.method() === 'DELETE') { state.removed.push(`${removeMatch[1]}/${removeMatch[2]}`); return route.fulfill({ status: 204, body: '' }); }
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { claude: { launchable: true } }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname.endsWith('/saved-prompts')) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname.endsWith('/prompt-history')) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname.endsWith('/notes') && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname.endsWith('/conversations') && request.method() === 'GET') {
      const listed = rows.map(row => row.current ? { ...row, consoleNamed: state.namedCurrent } : row);
      return route.fulfill({ json: { conversations: listed, canResume: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return state;
}

test('names the current conversation from the fly-out and shows it in the quick list', async ({ page }) => {
  const state = await mockNamingConsole(page);
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/ }).click();
  const menu = page.locator('.conversations-menu');
  // the Name field placeholder offers to rename the current conversation
  const input = menu.getByRole('textbox', { name: 'Name this conversation' });
  await expect(input).toHaveAttribute('placeholder', /Diagnose the shell/);
  await input.fill('Shell diagnosis');
  await menu.getByRole('button', { name: 'Name conversation' }).click();
  // the console submits the name; on confirm the list reloads and the row joins the quick list
  await expect.poll(() => state.names).toEqual([{ name: 'Shell diagnosis' }]);
  await expect(menu.locator('.conversation-rows .conversation-row')).toHaveText(/Diagnose the shell/);
  await expect(page.getByRole('button', { name: /^Conversations/ })).toHaveAccessibleName('Conversations (1)');
});

test('shows the reason inline when the agent does not confirm the name', async ({ page }) => {
  await mockNamingConsole(page, { confirm: false });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/ }).click();
  const menu = page.locator('.conversations-menu');
  await menu.getByRole('textbox', { name: 'Name this conversation' }).fill('Shell diagnosis');
  await menu.getByRole('button', { name: 'Name conversation' }).click();
  await expect(menu.locator('.conversation-error')).toContainText('did not confirm');
  // nothing joined the quick list
  await expect(menu.locator('.conversation-rows')).toHaveCount(0);
});

// six console-named rows across the Project, newest-active first, to exercise the five-row cap
const consoleNamedRows = Array.from({ length: 6 }, (_, index) => ({
  kind: 'claude', id: `1${index}111111-2222-4333-8444-555555555555`, name: `Named ${index}`,
  automatic: false, lastActiveAt: now - index * 3_600_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: true, reviewRun: false, current: false,
}));

test('the fly-out shows at most five console-named rows, newest first, each removable', async ({ page }) => {
  const state = await mockNamingConsole(page, { rows: consoleNamedRows });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/ }).click();
  const menu = page.locator('.conversations-menu');
  const rows = menu.locator('.conversation-rows .conversation-row');
  await expect(rows).toHaveCount(5);
  // newest-active first, as the server ordered them
  await expect(rows.first()).toContainText('Named 0');
  await expect(rows.nth(4)).toContainText('Named 4');
  // removing a row forgets the record; the sixth row takes its place, still capped at five
  await rows.first().locator('.conversation-remove').click();
  await expect.poll(() => state.removed).toEqual(['claude/10111111-2222-4333-8444-555555555555']);
  await expect(menu.locator('.conversation-rows')).not.toContainText('Named 0');
  await expect(rows).toHaveCount(5);
  await expect(rows.last()).toContainText('Named 5');
});

test('the empty state shows the Name field and the All conversations row only', async ({ page }) => {
  await mockNamingConsole(page, { rows: [conversations[1]!] });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/ }).click();
  const menu = page.locator('.conversations-menu');
  await expect(menu.getByRole('textbox', { name: 'Name this conversation' })).toBeVisible();
  await expect(menu.locator('.conversations-all')).toBeVisible();
  // no console-named rows, so the quick list is absent
  await expect(menu.locator('.conversation-rows')).toHaveCount(0);
});

test('the dialog splits Named here from All named', async ({ page }) => {
  // the console-named row is a non-current one, so the mock's current-row rewrite leaves it be
  const mixed = [
    { ...conversations[0]! },
    { ...conversations[1]!, consoleNamed: true },
    { ...conversations[2]! },
  ];
  await mockNamingConsole(page, { rows: mixed });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  const dialog = await openDialog(page);
  const headings = dialog.locator('.conversations-heading');
  await expect(headings).toHaveText(['Named here', 'All named']);
  // the console-named row sits under Named here with a Remove control
  const namedHere = dialog.locator('.conversation-rows').first();
  await expect(namedHere.locator('.conversation-row')).toHaveCount(1);
  await expect(namedHere.locator('.conversation-remove')).toBeVisible();
});

test('Tour and Review run conversations show only to a search, in their own group', async ({ page }) => {
  const run = { ...conversations[1]!, name: '🗺 Tour · cora', consoleNamed: true, reviewRun: true };
  await mockNamingConsole(page, { rows: [conversations[0]!, run, conversations[2]!] });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  // neither the fly-out's quick list nor its count include the run
  await page.getByRole('button', { name: 'Conversations (0)' }).click();
  await expect(page.locator('.conversations-menu .conversation-rows')).toHaveCount(0);
  await page.locator('.conversations-menu .conversations-all').click();
  const dialog = page.locator('.conversations-dialog');
  await expect(dialog.locator('.conversations-heading')).toHaveText(['All named']);
  await expect(dialog).not.toContainText('🗺 Tour · cora');
  await dialog.getByRole('searchbox', { name: 'Search conversations' }).fill('tour');
  await expect(dialog.locator('.conversations-heading')).toHaveText(['Tour and Review runs']);
  await expect(dialog.locator('.conversation-row')).toContainText('🗺 Tour · cora');
});

test('opens the conversations dialog full-screen on a phone', async ({ page }) => {
  await mockConsole(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Conversations' }).click();
  await page.locator('.conversations-menu').locator('.conversations-all').click();
  const surface = page.locator('.conversations-dialog > div');
  await expect(surface).toBeVisible();
  const bounds = await surface.boundingBox();
  requireBounds(bounds, 'conversations dialog');
  // full-screen: the surface spans the whole phone viewport
  expect(bounds.width).toBe(390);
  expect(bounds.x).toBe(0);
  await expect(page.locator('.conversation-row.current .conversation-pill')).toHaveText('CURRENT');
});
