import { expect, test, type Locator, type Page } from '@playwright/test';

const currentId = 'aaaaaaaa-2222-4333-8444-555555555555';
const now = Date.now();
type ConversationRow = {
  kind: 'claude' | 'codex';
  id: string;
  name: string;
  automatic?: boolean;
  lastActiveAt: number;
  directory: string;
  worktreeId?: string;
  consoleNamed: boolean;
  reviewRun: boolean;
  current: boolean;
};

// keep ordinary history in the active cwd while automatic rows exercise expansion
const baseRows: ConversationRow[] = Array.from({ length: 7 }, (_, index) => ({
  kind: 'claude',
  id: index === 0 ? currentId : `${index}bbbbbbb-2222-4333-8444-555555555555`,
  name: index === 0 ? 'Diagnose the shell' : `Historical conversation ${index}`,
  automatic: index >= 2,
  lastActiveAt: now - (index + 1) * 3_600_000,
  directory: '/worktrees/cora',
  worktreeId: 'cora',
  consoleNamed: index < 2,
  reviewRun: false,
  current: index === 0,
}));
const reviewRow: ConversationRow = {
  kind: 'claude',
  id: '99999999-2222-4333-8444-555555555555',
  name: 'Tour repository layout',
  automatic: false,
  lastActiveAt: now - 30_000,
  directory: '/worktrees/cora',
  worktreeId: 'cora',
  consoleNamed: true,
  reviewRun: true,
  current: false,
};

type ConversationMockOptions = {
  rows?: ConversationRow[];
  readGate?: Promise<void>;
  readFailures?: number;
  renameError?: string | (() => string | undefined);
  onName?: (body: unknown) => void;
  switchError?: string;
  onSwitch?: (worktreeId: string, body: unknown) => void;
  onRead?: (url: URL) => void;
  extraAgents?: Array<{ id: string; sessionId: string; home: string; worktreeId: string; worktreeLabel: string; worktreeOrder: number; title: string }>;
};

// mock the live-agent bootstrap and conversation resource
async function mockConsole(page: Page, options: ConversationMockOptions = {}) {
  let rows = options.rows ?? [...baseRows, reviewRow];
  let reads = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // submit the current conversation rename
    if (url.pathname === '/api/agents/agent-1/conversations/name' && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string };
      options.onName?.(body);
      const renameError = typeof options.renameError === 'function' ? options.renameError() : options.renameError;
      // reject only the attempts selected by this scenario
      if (renameError !== undefined) return route.fulfill({ status: 409, json: { error: renameError } });
      rows = rows.some(row => row.current)
        ? rows.map(row => row.current ? { ...row, name: body.name, consoleNamed: true } : row)
        : [{ ...baseRows[0]!, name: body.name, consoleNamed: true }];
      return route.fulfill({ status: 201, json: { conversation: rows.find(row => row.current) } });
    }
    // expose accidental historical resume requests
    const switchMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/conversations\/switch$/u);
    if (switchMatch !== null && request.method() === 'POST') {
      options.onSwitch?.(switchMatch[1]!, request.postDataJSON());
      if (options.switchError !== undefined) return route.fulfill({ status: 409, json: { error: options.switchError } });
      return route.fulfill({ status: 201, json: { agentId: `resumed-${switchMatch[1]}` } });
    }
    // restore one controlling browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one current conversation
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { claude: { launchable: true }, codex: { launchable: false } }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }, ...(options.extraAgents ?? [])], projects: [] } });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    // hold the initial list when a loading assertion needs it
    if (url.pathname === '/api/worktrees/cora/conversations' && request.method() === 'GET') {
      options.onRead?.(url);
      // require one global catalog read with the current-agent context
      if (url.searchParams.get('scope') !== 'all' || url.searchParams.get('agentId') !== 'agent-1') return route.fulfill({ status: 400, json: { error: 'invalid conversation scope' } });
      reads += 1;
      await options.readGate;
      if (reads <= (options.readFailures ?? 0)) return route.fulfill({ status: 503, json: { error: 'conversation list unavailable' } });
      return route.fulfill({ json: { conversations: rows, canResume: true } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// require one rendered element box
function requireBounds(bounds: { x: number; y: number; width: number; height: number } | null, label: string): asserts bounds is { x: number; y: number; width: number; height: number } {
  expect(bounds, `${label} bounds`).not.toBeNull();
  if (bounds === null) throw new Error(`${label} bounds unavailable`);
}

// measure one rendered conversation list without assuming fixed css pixels
async function conversationListGeometry(list: Locator) {
  return await list.evaluate(element => {
    const row = element.querySelector<HTMLElement>('.conversation-row');
    const grid = element.querySelector<HTMLElement>('.conversation-rows');
    // require one rendered row grid
    if (row === null || grid === null) throw new Error('conversation rows missing');
    return {
      rowCount: grid.children.length,
      rowHeight: row.getBoundingClientRect().height,
      rowGap: Number.parseFloat(window.getComputedStyle(grid).rowGap),
      listHeight: element.getBoundingClientRect().height,
      scrolls: element.scrollHeight > element.clientHeight,
    };
  });
}

// require one valid current-row title group with an adjacent compact edit action
async function expectCurrentTitleEdit(row: Locator, title: string) {
  const presentation = row.locator(':scope > .conversation-choice');
  await expect(presentation).toHaveJSProperty('tagName', 'DIV');
  const titleGroup = presentation.locator('.conversation-title');
  const strong = titleGroup.locator(':scope > strong');
  const edit = titleGroup.locator(':scope > strong + .conversation-edit');
  await expect(strong).toHaveText(title);
  await expect(edit).toBeVisible();
  await expect(edit).toHaveCSS('background-image', 'none');
  await expect(edit).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(edit).toHaveCSS('box-shadow', 'none');
  await expect(presentation.locator('button button')).toHaveCount(0);
  const titleBounds = await strong.boundingBox();
  const editBounds = await edit.boundingBox();
  requireBounds(titleBounds, 'conversation title');
  requireBounds(editBounds, 'conversation edit');
  const gap = editBounds.x - titleBounds.x - titleBounds.width;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
  expect(Math.abs(editBounds.y + editBounds.height / 2 - titleBounds.y - titleBounds.height / 2)).toBeLessThan(2);
  expect(editBounds.width).toBeLessThanOrEqual(24);
}

// preserve the opposing-bubble glyph in both toolbar layouts
for (const viewport of [{ width: 900, height: 780 }, { width: 390, height: 844 }]) {
  test(`shows the opposing conversation bubbles at ${viewport.width}px`, async ({ page }) => {
    await mockConsole(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const control = page.getByRole('button', { name: /^Conversations/u });
    const icon = control.locator('svg');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveCSS('fill', 'none');
    await expect(icon.locator('path')).toHaveCount(2);
    const controlBounds = await control.boundingBox();
    const iconBounds = await icon.boundingBox();
    requireBounds(controlBounds, 'conversations control');
    requireBounds(iconBounds, 'conversations icon');
    expect(Math.abs(iconBounds.x + iconBounds.width / 2 - controlBounds.x - controlBounds.width / 2)).toBeLessThan(0.5);
    expect(Math.abs(iconBounds.y + iconBounds.height / 2 - controlBounds.y - controlBounds.height / 2)).toBeLessThan(0.5);
  });
}

// keep the edit glyph attached to the current title at desktop and phone widths
for (const viewport of [{ label: 'desktop', width: 900, height: 780 }, { label: 'phone', width: 390, height: 780 }]) {
  test(`places current Edit immediately after the title on ${viewport.label}`, async ({ page }) => {
    await mockConsole(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: /^Conversations/u }).click();
    await expectCurrentTitleEdit(page.locator('.conversations-menu .conversation-row.current'), 'Diagnose the shell');
  });
}

// truncate a long current title without displacing its edit action
test('keeps Edit visible beside a truncated current title', async ({ page }) => {
  const title = 'A very long generated conversation title that must truncate before the edit glyph on a narrow phone';
  await mockConsole(page, { rows: [{ ...baseRows[0]!, name: title }, baseRows[1]!] });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const current = page.locator('.conversations-menu .conversation-row.current');
  await expectCurrentTitleEdit(current, title);
  const renderedTitle = current.locator('.conversation-title > strong');
  await expect(renderedTitle).toHaveCSS('text-overflow', 'ellipsis');
  expect(await renderedTitle.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
});

// the current presentation never invokes the historical resume action
test('does not resume when the current conversation presentation is clicked', async ({ page }) => {
  const switches: Array<{ worktreeId: string; body: unknown }> = [];
  await mockConsole(page, { onSwitch: (worktreeId, body) => switches.push({ worktreeId, body }) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.locator('.conversation-row.current > .conversation-choice').click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(50);
  expect(switches).toEqual([]);
  await expect(flyout).toBeVisible();
});

// load the authorized global catalog once before applying either client-side scope
test('loads the global catalog once and switches scopes in memory', async ({ page }) => {
  const reads: string[] = [];
  await mockConsole(page, { onRead: url => reads.push(url.search) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.locator('.conversation-row')).toHaveCount(2);
  await expect.poll(() => reads).toHaveLength(1);
  const query = new URLSearchParams(reads[0]!);
  expect(query.get('scope')).toBe('all');
  expect(query.get('agentId')).toBe('agent-1');
  await flyout.getByRole('button', { name: 'all', exact: true }).click();
  await flyout.getByRole('button', { name: 'cwd', exact: true }).click();
  expect(reads).toHaveLength(1);
});

// lock the flyout-first loading contract and collapsed footer
test('opens immediately with console-named rows and expands into the 4.5-row list', async ({ page }) => {
  let releaseConversations!: () => void;
  const conversationsReleased = new Promise<void>(resolve => {
    releaseConversations = resolve;
  });
  await mockConsole(page, { readGate: conversationsReleased });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');
  const control = page.getByRole('button', { name: /^Conversations/u });
  await control.click();
  const flyout = page.locator('.conversations-menu');
  try {
    await expect(flyout).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(flyout.getByRole('searchbox', { name: 'Search conversations' })).toBeFocused();
    const scope = flyout.getByRole('group', { name: 'Conversation scope' });
    await expect(scope.getByRole('button', { name: 'cwd', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(scope.getByRole('button', { name: 'all', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(flyout.locator('.conversation-row-skeleton')).toHaveCount(5);
    await expect(flyout.getByRole('button', { name: 'Show all conversations' })).toHaveCount(0);
    await expect(page.locator('.conversations-dialog')).toHaveCount(0);
    const loadingGeometry = await conversationListGeometry(flyout.locator('.conversations-list'));
    const visibleLoadingRows = (loadingGeometry.listHeight - loadingGeometry.rowGap * 4) / loadingGeometry.rowHeight;
    expect(visibleLoadingRows).toBeGreaterThan(4.35);
    expect(visibleLoadingRows).toBeLessThan(4.75);
    // capture the held desktop loading state on demand
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-desktop.png` });
  } finally {
    // release the held read during failed assertions too
    releaseConversations();
  }

  const list = flyout.locator('.conversations-list');
  const rows = list.locator('.conversation-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('.conversation-cwd')).toHaveCount(0);
  await expect(rows.first()).toContainText(/\d+\s+h ago/u);
  await expect(rows.first().getByRole('button', { name: /Edit/u })).toBeEnabled();
  await expect(rows.nth(1).getByRole('button', { name: /Edit/u })).toHaveCount(0);
  const collapsedGeometry = await conversationListGeometry(list);
  expect(collapsedGeometry.listHeight).toBeCloseTo(collapsedGeometry.rowHeight * 2 + collapsedGeometry.rowGap, 0);
  expect(collapsedGeometry.scrolls).toBe(false);
  // capture the settled cwd list on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-cwd.png` });
  const expand = flyout.getByRole('button', { name: 'Show all conversations' });
  await expect(expand).toHaveCSS('background-image', 'none');
  const listBounds = await list.boundingBox();
  const expandBounds = await expand.boundingBox();
  requireBounds(listBounds, 'conversation list');
  requireBounds(expandBounds, 'conversation expansion');
  expect(expandBounds.y).toBeGreaterThanOrEqual(listBounds.y + listBounds.height);
  await expand.click();
  await expect(rows).toHaveCount(8);
  await expect(rows.filter({ hasText: 'Tour repository layout' })).toHaveCount(1);
  await expect(flyout.getByRole('button', { name: 'Show fewer conversations' })).toBeVisible();
  const geometry = await conversationListGeometry(list);
  const visibleRows = (geometry.listHeight - geometry.rowGap * 4) / geometry.rowHeight;
  expect(visibleRows).toBeGreaterThan(4.35);
  expect(visibleRows).toBeLessThan(4.75);
  expect(geometry.scrolls).toBe(true);
  await flyout.getByRole('button', { name: 'Show fewer conversations' }).click();
  await expect(rows).toHaveCount(2);
});

// search every scoped row while keeping non-recorded and review rows collapsed by default
test('searches automatic and review rows beyond the console-named default list', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const search = flyout.getByRole('searchbox', { name: 'Search conversations' });
  const rows = flyout.locator('.conversation-row');
  await expect(rows).toHaveCount(2);
  await expect(flyout).not.toContainText('Tour repository layout');
  await search.fill('Historical conversation 3');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Historical conversation 3');
  await search.fill('claude');
  await expect(rows).toHaveCount(8);
  await expect(rows.filter({ hasText: 'Tour repository layout' })).toHaveCount(1);
  await search.fill('tour');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Tour repository layout');
  await search.fill('');
  await expect(rows).toHaveCount(2);
  await expect(flyout).not.toContainText('Tour repository layout');
});

// filtering a confirmed current row must not turn it into an unnamed conversation
test('does not offer current naming when a confirmed current row is filtered by search', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('searchbox', { name: 'Search conversations' }).fill('Historical conversation 1');
  await expect(flyout.locator('.conversation-row strong')).toHaveText(['Historical conversation 1']);
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
});

// keep an existing current conversation's edit action attached to its own row
test('does not offer fallback naming when an unrecorded current row is filtered by search', async ({ page }) => {
  const current = { ...baseRows[0]!, automatic: true, consoleNamed: false };
  await mockConsole(page, { rows: [current, baseRows[1]!] });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('searchbox', { name: 'Search conversations' }).fill('Historical conversation 1');
  await expect(flyout.locator('.conversation-row strong')).toHaveText(['Historical conversation 1']);
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
});

// reset to cwd on each open and expose directory metadata only in all scope
test('switches between cwd and all scopes while showing paths only in all', async ({ page }) => {
  const sibling = { ...baseRows[2]!, name: 'Owen investigation', automatic: false, consoleNamed: true, directory: '/worktrees/owen', worktreeId: 'owen' };
  await mockConsole(page, { rows: [baseRows[0]!, baseRows[1]!, sibling] });
  await page.goto('/');
  const control = page.getByRole('button', { name: /^Conversations/u });
  await control.click();
  const flyout = page.locator('.conversations-menu');
  const scope = flyout.getByRole('group', { name: 'Conversation scope' });
  const cwd = scope.getByRole('button', { name: 'cwd', exact: true });
  const all = scope.getByRole('button', { name: 'all', exact: true });
  const rows = flyout.locator('.conversation-row');
  await expect(cwd).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(rows).toHaveCount(2);
  await expect(flyout).not.toContainText('Owen investigation');
  await expect(rows.locator('.conversation-cwd')).toHaveCount(0);
  const cwdGeometry = await conversationListGeometry(flyout.locator('.conversations-list'));

  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(cwd).toHaveAttribute('aria-pressed', 'false');
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('.conversation-cwd')).toHaveCount(3);
  await expect(flyout).toContainText('/worktrees/cora');
  await expect(flyout).toContainText('/worktrees/owen');
  const allGeometry = await conversationListGeometry(flyout.locator('.conversations-list'));
  expect(allGeometry.rowHeight).toBeGreaterThan(cwdGeometry.rowHeight);
  // capture the path-bearing all scope on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-all.png` });

  await page.keyboard.press('Escape');
  await expect(flyout).toHaveCount(0);
  await control.click();
  const reopened = page.locator('.conversations-menu');
  await expect(reopened.getByRole('button', { name: 'cwd', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(reopened.locator('.conversation-row')).toHaveCount(2);
  await expect(reopened.locator('.conversation-cwd')).toHaveCount(0);
});

// model one worktree across browser-visible and host-visible path namespaces
const bridgedCurrent = { ...baseRows[0]!, directory: '/host/cora' };
const bridgedHistorical = { ...baseRows[1]!, directory: '/host/cora' };
const bridgedForeign = { ...baseRows[2]!, name: 'Wrong worktree conversation', automatic: false, consoleNamed: true, directory: '/host/cora', worktreeId: 'owen' };
const bridgedPathCases = [
  { label: 'with a current row', rows: [bridgedCurrent, bridgedHistorical, bridgedForeign], expectedNames: ['Diagnose the shell', 'Historical conversation 1'], namingCount: 0 },
  { label: 'without a current row', rows: [bridgedHistorical, bridgedForeign], expectedNames: ['Historical conversation 1'], namingCount: 1 },
];

// exercise configured cwd identity across host path namespaces
for (const scenario of bridgedPathCases) {
  test(`keeps bridged cwd conversations ${scenario.label}`, async ({ page }) => {
    await mockConsole(page, { rows: scenario.rows });
    await page.goto('/');
    await page.getByRole('button', { name: /^Conversations/u }).click();
    const flyout = page.locator('.conversations-menu');
    const rows = flyout.locator('.conversation-row');
    const names = rows.locator('strong');
    await expect(flyout.getByRole('button', { name: 'cwd', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(names).toHaveText(scenario.expectedNames);
    await expect(rows.locator('.conversation-cwd')).toHaveCount(0);
    await expect(flyout).not.toContainText('Wrong worktree conversation');
    await flyout.getByRole('searchbox', { name: 'Search conversations' }).fill('/host/cora');
    await expect(names).toHaveText(scenario.expectedNames);
    await expect(rows.locator('.conversation-cwd')).toHaveCount(0);
    await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(scenario.namingCount);
  });
}

// trust only the console record as rename provenance across every provider
test('shows only console-named conversations first and expands provider-only names', async ({ page }) => {
  const currentAutomatic = { ...baseRows[0]!, automatic: true, consoleNamed: false, lastActiveAt: now - 5 * 60_000 };
  const providerCustom = { ...baseRows[1]!, name: 'Provider custom title', automatic: false, consoleNamed: false, lastActiveAt: now - 20 * 60_000 };
  const olderNamed = { ...baseRows[2]!, name: 'Older console name', automatic: true, consoleNamed: true, lastActiveAt: now - 4 * 3_600_000 };
  const automatic = { ...baseRows[3]!, name: 'Automatic recent chat', automatic: true, consoleNamed: false, lastActiveAt: now - 10 * 60_000 };
  const codexUnknown: ConversationRow = { kind: 'codex', id: '0198c555-5555-7555-8555-555555555555', name: 'Codex generated title', lastActiveAt: now - 30 * 60_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: false };
  const review = { ...reviewRow, name: 'Recent review run', lastActiveAt: now - 60_000 };
  await mockConsole(page, { rows: [olderNamed, automatic, currentAutomatic, review, providerCustom, codexUnknown] });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const names = flyout.locator('.conversation-row strong');
  await expect(names).toHaveText(['Older console name', 'Diagnose the shell']);
  const current = flyout.locator('.conversation-row.current');
  await expect(current.getByRole('button', { name: 'Edit Diagnose the shell' })).toBeEnabled();
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
  await flyout.getByRole('button', { name: 'Show all conversations' }).click();
  await expect(names).toHaveText(['Older console name', 'Recent review run', 'Diagnose the shell', 'Automatic recent chat', 'Provider custom title', 'Codex generated title']);
  await expect(current.getByRole('button', { name: 'Edit Diagnose the shell' })).toBeEnabled();
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
});

const currentStarterCases: Array<{ label: string; row: ConversationRow }> = [
  { label: 'automatic', row: { ...baseRows[0]!, name: 'Automatic current', automatic: true, consoleNamed: false } },
  { label: 'provenance-unknown Codex', row: { kind: 'codex', id: currentId, name: 'Codex current title', lastActiveAt: now - 5 * 60_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, reviewRun: false, current: true } },
  { label: 'review', row: { ...reviewRow, name: 'Current review run', current: true } },
  { label: 'unmapped', row: { ...baseRows[0]!, name: 'Unmapped current', directory: '/gone/away', worktreeId: undefined, consoleNamed: false } },
];

// include the current row regardless of title provenance while retaining current-only editing
for (const scenario of currentStarterCases) {
  test(`keeps the ${scenario.label} current conversation in the starter list`, async ({ page }) => {
    await mockConsole(page, { rows: [scenario.row, baseRows[1]!] });
    await page.goto('/');
    await page.getByRole('button', { name: /^Conversations/u }).click();
    const flyout = page.locator('.conversations-menu');
    const rows = flyout.locator('.conversation-row');
    await expect(rows.locator('strong')).toHaveText(['Historical conversation 1', scenario.row.name]);
    await expect(rows.filter({ hasText: scenario.row.name }).getByRole('button', { name: `Edit ${scenario.row.name}` })).toBeEnabled();
    await expect(rows.filter({ hasText: 'Historical conversation 1' }).locator('.conversation-edit')).toHaveCount(0);
    await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
  });
}

// build confirmed history without changing current-row provenance
const confirmedHistory = (count: number): ConversationRow[] => Array.from({ length: count }, (_, index) => ({
  ...baseRows[index + 1]!,
  name: `Confirmed conversation ${index + 1}`,
  consoleNamed: true,
  current: false,
}));

// retain the empty and full short-list capacity boundaries
for (const confirmed of [0, 4]) {
  test(`fits ${confirmed} confirmed conversations plus the current row without scrolling`, async ({ page }) => {
    const current = { ...baseRows[0]!, automatic: true, consoleNamed: false };
    await mockConsole(page, { rows: [current, ...confirmedHistory(confirmed)] });
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /^Conversations/u }).click();
    const flyout = page.locator('.conversations-menu');
    const list = flyout.locator('.conversations-list');
    await expect(list.locator('.conversation-row')).toHaveCount(confirmed + 1);
    const geometry = await conversationListGeometry(list);
    const naturalHeight = geometry.rowHeight * geometry.rowCount + geometry.rowGap * Math.max(0, geometry.rowCount - 1);
    expect(Math.abs(geometry.listHeight - naturalHeight)).toBeLessThan(1);
    expect(geometry.scrolls).toBe(false);
    await expect(flyout.locator('.conversation-edit')).toHaveCount(1);
    await expect(flyout.getByRole('button', { name: 'Show all conversations' })).toHaveCount(0);
  });
}

// a confirmed current row occupies one renamed slot rather than adding a duplicate
test('counts a console-named current row once in starter capacity', async ({ page }) => {
  await mockConsole(page, { rows: [{ ...baseRows[0]!, consoleNamed: true }, ...confirmedHistory(3)] });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const list = page.locator('.conversations-menu .conversations-list');
  await expect(list.locator('.conversation-row')).toHaveCount(4);
  await expect(list.locator('.conversation-row.current')).toHaveCount(1);
  const geometry = await conversationListGeometry(list);
  const naturalHeight = geometry.rowHeight * 4 + geometry.rowGap * 3;
  expect(Math.abs(geometry.listHeight - naturalHeight)).toBeLessThan(1);
  expect(geometry.scrolls).toBe(false);
});

// all mode retains five complete rows while directory metadata increases row height
test('fits four confirmed conversations plus the current row in all mode', async ({ page }) => {
  const current = { ...baseRows[0]!, automatic: true, consoleNamed: false };
  await mockConsole(page, { rows: [current, ...confirmedHistory(4)] });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const list = flyout.locator('.conversations-list');
  const cwdGeometry = await conversationListGeometry(list);
  await flyout.getByRole('button', { name: 'all', exact: true }).click();
  await expect(list.locator('.conversation-row')).toHaveCount(5);
  const allGeometry = await conversationListGeometry(list);
  const naturalHeight = allGeometry.rowHeight * 5 + allGeometry.rowGap * 4;
  expect(allGeometry.rowHeight).toBeGreaterThan(cwdGeometry.rowHeight);
  expect(Math.abs(allGeometry.listHeight - naturalHeight)).toBeLessThan(1);
  expect(allGeometry.scrolls).toBe(false);
});

// five confirmed history rows retain the clipped scroll invitation
test('caps five confirmed conversations plus the current row at four and a half rows', async ({ page }) => {
  const current = { ...baseRows[0]!, automatic: true, consoleNamed: false };
  await mockConsole(page, { rows: [current, ...confirmedHistory(5)] });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const list = page.locator('.conversations-menu .conversations-list');
  await expect(list.locator('.conversation-row')).toHaveCount(6);
  const geometry = await conversationListGeometry(list);
  const visibleRows = (geometry.listHeight - geometry.rowGap * 4) / geometry.rowHeight;
  expect(visibleRows).toBeGreaterThan(4.35);
  expect(visibleRows).toBeLessThan(4.75);
  expect(geometry.scrolls).toBe(true);
});

// keep a failed list distinct from a confirmed empty list and make it retryable
test('shows only an actionable error after a failed conversation read and retries in place', async ({ page }) => {
  await mockConsole(page, { readFailures: 1 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.getByRole('alert')).toContainText('Unable to load conversations');
  await expect(flyout).not.toContainText('No named conversations in this folder yet.');
  await expect(flyout.locator('.conversation-row-skeleton')).toHaveCount(0);
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
  await expect(flyout.locator('.conversation-edit')).toHaveCount(0);
  await flyout.getByRole('button', { name: 'Retry' }).click();
  await expect(flyout.getByRole('alert')).toHaveCount(0);
  await expect(flyout.locator('.conversation-row')).toHaveCount(2);
  await expect(flyout.locator('.conversation-row.current .conversation-edit')).toBeEnabled();
  await expect(flyout.locator('.conversation-row:not(.current) .conversation-edit')).toHaveCount(0);
});

// preserve naming after a successful list confirms no current row
test('offers current conversation naming after a valid empty list', async ({ page }) => {
  await mockConsole(page, { rows: [] });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.getByRole('alert')).toHaveCount(0);
  await expect(flyout).toContainText('No named conversations in this folder yet.');
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toBeEnabled();
  const emptyGeometry = await flyout.locator('.conversations-list').evaluate(element => {
    const probe = document.createElement('div');
    probe.style.height = 'var(--conversation-row-height)';
    element.append(probe);
    const rowHeight = probe.getBoundingClientRect().height;
    probe.remove();
    return { listHeight: element.getBoundingClientRect().height, rowHeight };
  });
  expect(Math.abs(emptyGeometry.listHeight - emptyGeometry.rowHeight)).toBeLessThan(1);
  await flyout.getByRole('button', { name: 'all', exact: true }).click();
  await expect(flyout).toContainText('No named conversations in configured folders yet.');
});

// edit a provider-titled current row in place and promote its confirmed rename
test('keeps an unrecorded current conversation visible and promotes its confirmed rename', async ({ page }) => {
  const names: unknown[] = [];
  const currentRow = { ...baseRows[0]!, name: 'Generated current title', automatic: true, consoleNamed: false };
  await mockConsole(page, { rows: [currentRow, baseRows[1]!], onName: body => names.push(body) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.locator('.conversation-row strong')).toHaveText(['Historical conversation 1', 'Generated current title']);
  const current = flyout.locator('.conversation-row.current');
  await current.getByRole('button', { name: 'Edit Generated current title' }).click();
  const input = current.getByRole('textbox', { name: 'Name this conversation' });
  await expect(input).toHaveValue('Generated current title');
  await input.fill('Confirmed current name');
  await input.press('Enter');
  await expect.poll(() => names).toEqual([{ name: 'Confirmed current name' }]);
  await expect(flyout.locator('.conversation-row strong')).toHaveText(['Confirmed current name', 'Historical conversation 1']);
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
});

// retain an unnamed current draft after a rename mutation fails
test('keeps valid-empty naming editable after a failed rename and allows retry', async ({ page }) => {
  const names: unknown[] = [];
  let attempts = 0;
  await mockConsole(page, {
    rows: [],
    onName: body => names.push(body),
    // fail only the first rename mutation
    renameError: () => attempts++ === 0 ? 'The agent did not confirm the name.' : undefined
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('button', { name: 'Name current conversation' }).click();
  const input = flyout.getByRole('textbox', { name: 'Name this conversation' });
  await input.fill('Recovered conversation');
  await input.press('Enter');
  await expect(flyout.getByRole('alert')).toContainText('did not confirm');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Recovered conversation');
  await input.press('Enter');
  await expect.poll(() => names).toEqual([{ name: 'Recovered conversation' }, { name: 'Recovered conversation' }]);
  await expect(flyout.locator('.conversation-row.current')).toContainText('Recovered conversation');
  await expect(input).toHaveCount(0);
});

// rename only the current conversation in place
test('edits the current conversation inline with Escape and Enter semantics', async ({ page }) => {
  const names: unknown[] = [];
  await mockConsole(page, { onName: body => names.push(body) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const current = flyout.locator('.conversation-row.current');
  await current.getByRole('button', { name: /Edit/u }).click();
  const input = current.getByRole('textbox', { name: 'Name this conversation' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Diagnose the shell');
  await input.fill('Discarded rename');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  expect(names).toEqual([]);

  await current.getByRole('button', { name: /Edit/u }).click();
  await current.getByRole('textbox', { name: 'Name this conversation' }).fill('Shell diagnosis');
  await current.getByRole('textbox', { name: 'Name this conversation' }).press('Enter');
  await expect.poll(() => names).toEqual([{ name: 'Shell diagnosis' }]);
  await expect(current).toContainText('Shell diagnosis');
});

// keep rename actions icon-only while preserving stable accessible labels
test('uses check and x icons for inline rename actions', async ({ page }) => {
  const names: unknown[] = [];
  await mockConsole(page, { onName: body => names.push(body) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const current = page.locator('.conversations-menu .conversation-row.current');
  await current.getByRole('button', { name: /Edit/u }).click();
  const submit = current.getByRole('button', { name: 'Name conversation' });
  const cancel = current.getByRole('button', { name: 'Cancel conversation rename' });
  await expect(submit).toHaveText('');
  await expect(cancel).toHaveText('');
  await expect(submit).toHaveCSS('background-image', 'none');
  await expect(cancel).toHaveCSS('background-image', 'none');
  await expect(submit.locator('svg')).toHaveCount(1);
  await expect(cancel.locator('svg')).toHaveCount(1);
  // capture the icon-only edit controls on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-edit.png` });
  await cancel.click();
  await expect(current.getByRole('textbox', { name: 'Name this conversation' })).toHaveCount(0);

  await current.getByRole('button', { name: /Edit/u }).click();
  await current.getByRole('textbox', { name: 'Name this conversation' }).fill('Checked rename');
  await current.getByRole('button', { name: 'Name conversation' }).click();
  await expect.poll(() => names).toEqual([{ name: 'Checked rename' }]);
  await expect(current).toContainText('Checked rename');
});

// keep a rejected rename editable and explain the failure inline
test('keeps inline rename open when the agent rejects the name', async ({ page }) => {
  await mockConsole(page, { renameError: 'The agent did not confirm the name.' });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const current = flyout.locator('.conversation-row.current');
  await current.getByRole('button', { name: /Edit/u }).click();
  const input = current.getByRole('textbox', { name: 'Name this conversation' });
  await input.fill('Unconfirmed name');
  await input.press('Enter');
  await expect(flyout.getByRole('alert')).toContainText('did not confirm');
  await expect(input).toBeVisible();
});

// retain resume guards while presenting the current row without a resume button
test('keeps orphaned and unlaunchable history disabled while current is noninteractive', async ({ page }) => {
  const rows: ConversationRow[] = [
    baseRows[0]!,
    baseRows[1]!,
    { ...baseRows[2]!, worktreeId: undefined, directory: '/gone/away', name: 'Orphaned conversation' },
    { ...baseRows[3]!, kind: 'codex', name: 'Unlaunchable Codex conversation' },
  ];
  await mockConsole(page, { rows });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('button', { name: 'all', exact: true }).click();
  await flyout.getByRole('button', { name: 'Show all conversations' }).click();
  await expectCurrentTitleEdit(flyout.locator('.conversation-row.current'), 'Diagnose the shell');
  await expect(flyout.locator('.conversation-row', { hasText: 'Historical conversation 1' }).locator('.conversation-choice')).toBeEnabled();
  await expect(flyout.locator('.conversation-row', { hasText: 'Orphaned conversation' }).locator('.conversation-choice')).toBeDisabled();
  await expect(flyout.locator('.conversation-row', { hasText: 'Unlaunchable Codex conversation' }).locator('.conversation-choice')).toBeDisabled();
  await expect(flyout.locator('.conversation-row:not(.current) .conversation-edit')).toHaveCount(0);
});

// resume one launchable historical row without opening a second surface
test('resumes a same-worktree conversation from the flyout and closes it on success', async ({ page }) => {
  const switches: Array<{ worktreeId: string; body: unknown }> = [];
  await mockConsole(page, { onSwitch: (worktreeId, body) => switches.push({ worktreeId, body }) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.locator('.conversation-row', { hasText: 'Historical conversation 1' }).locator('.conversation-choice').click();
  await expect.poll(() => switches).toEqual([{ worktreeId: 'cora', body: { kind: 'claude', id: baseRows[1]!.id } }]);
  await expect(flyout).toHaveCount(0);
});

// retain the list and explain a rejected same-worktree resume
test('keeps the flyout open when a same-worktree resume fails', async ({ page }) => {
  await mockConsole(page, { switchError: 'Close duplicate worktree agents before switching chats.' });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.locator('.conversation-row', { hasText: 'Historical conversation 1' }).locator('.conversation-choice').click();
  await expect(flyout).toBeVisible();
  await expect(flyout.getByRole('alert')).toContainText('Close duplicate worktree agents');
});

// navigate before resuming a conversation owned by a sibling worktree
test('resumes a sibling-worktree conversation through its home worktree', async ({ page }) => {
  const sibling = { ...baseRows[1]!, name: 'Owen investigation', directory: '/worktrees/owen', worktreeId: 'owen' };
  const switches: Array<{ worktreeId: string; body: unknown }> = [];
  await mockConsole(page, {
    rows: [baseRows[0]!, sibling],
    extraAgents: [{ id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }],
    onSwitch: (worktreeId, body) => switches.push({ worktreeId, body }),
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('button', { name: 'all', exact: true }).click();
  await flyout.locator('.conversation-row', { hasText: 'Owen investigation' }).locator('.conversation-choice').click();
  await expect(page.getByRole('tab', { name: /Owen/u })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => switches).toEqual([{ worktreeId: 'owen', body: { kind: 'claude', id: sibling.id } }]);
});

// omit remove controls and trailing action columns from every starter row
test('renders conversation rows without remove or trailing action columns', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const rows = flyout.locator('.conversation-row');
  await expect(rows).toHaveCount(2);
  await expect(flyout.locator('.conversation-remove')).toHaveCount(0);
  await expect(flyout.getByRole('button', { name: /^Remove /u })).toHaveCount(0);
  await expect(flyout.locator('.conversation-row > .conversation-edit')).toHaveCount(0);
  await expect(rows.first().locator(':scope > *')).toHaveCount(1);
  await expect(rows.nth(1).locator(':scope > *')).toHaveCount(1);
  const historical = rows.filter({ hasText: 'Historical conversation 1' });
  const rowBounds = await historical.boundingBox();
  const rowClientWidth = await historical.evaluate(element => element.clientWidth);
  const choiceBounds = await historical.locator(':scope > .conversation-choice').boundingBox();
  requireBounds(rowBounds, 'historical conversation row');
  requireBounds(choiceBounds, 'historical conversation choice');
  expect(Math.abs(rowClientWidth - choiceBounds.width)).toBeLessThan(1);
});

// ignore a late list after the flyout closes
test('does not reopen after a dismissed conversation request settles', async ({ page }) => {
  let releaseConversations!: () => void;
  const conversationsReleased = new Promise<void>(resolve => {
    releaseConversations = resolve;
  });
  await mockConsole(page, { readGate: conversationsReleased });
  await page.goto('/');
  const control = page.getByRole('button', { name: /^Conversations/u });
  await control.click();
  await expect(page.locator('.conversations-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.conversations-menu')).toHaveCount(0);
  releaseConversations();
  await page.waitForTimeout(50);
  await expect(page.locator('.conversations-menu')).toHaveCount(0);
  await expect(control).toBeFocused();
});

// keep search, scope, list, and footer inside the phone flyout
test('keeps the conversation controls and footer aligned in a phone viewport', async ({ page }) => {
  await mockConsole(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout).toBeVisible();
  const bounds = await flyout.boundingBox();
  requireBounds(bounds, 'conversation flyout');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(780);
  const searchBounds = await flyout.getByRole('searchbox', { name: 'Search conversations' }).boundingBox();
  const scopeBounds = await flyout.getByRole('group', { name: 'Conversation scope' }).boundingBox();
  requireBounds(searchBounds, 'conversation search');
  requireBounds(scopeBounds, 'conversation scope');
  expect(scopeBounds.x).toBeGreaterThanOrEqual(searchBounds.x + searchBounds.width);
  expect(Math.abs(scopeBounds.y + scopeBounds.height / 2 - searchBounds.y - searchBounds.height / 2)).toBeLessThan(2);
  const list = flyout.locator('.conversations-list');
  await expect(list).toHaveCSS('overflow-y', 'auto');
  const listBounds = await list.boundingBox();
  const footerBounds = await flyout.getByRole('button', { name: 'Show all conversations' }).boundingBox();
  requireBounds(listBounds, 'phone conversation list');
  requireBounds(footerBounds, 'phone conversation footer');
  expect(footerBounds.y).toBeGreaterThanOrEqual(listBounds.y + listBounds.height);
  expect(footerBounds.x + footerBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  // capture the phone flyout on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-phone.png` });
});

// keep expanded history bounded and scrollable in a short phone viewport
test('keeps expanded conversations inside a short phone viewport', async ({ page }) => {
  await mockConsole(page);
  await page.setViewportSize({ width: 390, height: 360 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await flyout.getByRole('button', { name: 'Show all conversations' }).click();
  await expect(flyout.locator('.conversation-row')).toHaveCount(8);
  const bounds = await flyout.boundingBox();
  requireBounds(bounds, 'short conversation flyout');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(360);
  const list = flyout.locator('.conversations-list');
  await expect(list).toHaveCSS('overflow-y', 'auto');
  expect((await conversationListGeometry(list)).scrolls).toBe(true);
  const footerBounds = await flyout.getByRole('button', { name: 'Show fewer conversations' }).boundingBox();
  requireBounds(footerBounds, 'short conversation footer');
  expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
});
