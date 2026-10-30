import { expect, test, type Page } from '@playwright/test';

const currentId = 'aaaaaaaa-2222-4333-8444-555555555555';
const now = Date.now();
type ConversationRow = {
  kind: 'claude' | 'codex';
  id: string;
  name: string;
  automatic: boolean;
  lastActiveAt: number;
  directory: string;
  worktreeId?: string;
  consoleNamed: boolean;
  reviewRun: boolean;
  current: boolean;
};

const baseRows: ConversationRow[] = Array.from({ length: 7 }, (_, index) => ({
  kind: 'claude',
  id: index === 0 ? currentId : `${index}bbbbbbb-2222-4333-8444-555555555555`,
  name: index === 0 ? 'Diagnose the shell' : `Historical conversation ${index}`,
  automatic: false,
  lastActiveAt: now - (index + 1) * 3_600_000,
  directory: index === 0 ? '/worktrees/cora' : `/worktrees/archive-${index}`,
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
  onRemove?: (kind: string, id: string) => void;
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
    const removeMatch = url.pathname.match(/^\/api\/worktrees\/cora\/conversations\/([^/]+)\/([^/]+)$/u);
    if (removeMatch !== null && request.method() === 'DELETE') {
      options.onRemove?.(removeMatch[1]!, removeMatch[2]!);
      rows = rows.map(row => row.kind === removeMatch[1] && row.id === removeMatch[2] ? { ...row, consoleNamed: false } : row);
      return route.fulfill({ status: 204, body: '' });
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

// lock the flyout-first loading contract
test('opens the searchable flyout immediately and settles into a 4.5-row list', async ({ page }) => {
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
    await expect(flyout.locator('.conversation-row-skeleton')).toHaveCount(5);
    await expect(flyout.getByRole('button', { name: 'All conversations' })).toHaveCount(0);
    await expect(page.locator('.conversations-dialog')).toHaveCount(0);
    // capture the held desktop loading state on demand
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-desktop.png` });
  } finally {
    // release the held read during failed assertions too
    releaseConversations();
  }

  const list = flyout.locator('.conversations-list');
  const rows = list.locator('.conversation-row');
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toContainText('/worktrees/cora');
  await expect(rows.first()).toContainText(/\d+\s+h ago/u);
  await expect(rows.first().getByRole('button', { name: /Edit/u })).toBeEnabled();
  await expect(rows.nth(1).getByRole('button', { name: /Edit/u })).toBeDisabled();
  await expect(rows.nth(1).getByRole('button', { name: /Edit/u })).toHaveAttribute('title', /active conversation/u);
  const geometry = await list.evaluate(element => {
    const row = element.querySelector<HTMLElement>('.conversation-row');
    if (row === null) throw new Error('conversation row missing');
    const rowHeight = row.getBoundingClientRect().height;
    const listHeight = element.getBoundingClientRect().height;
    return { ratio: listHeight / rowHeight, scrolls: element.scrollHeight > element.clientHeight };
  });
  expect(geometry.ratio).toBeGreaterThan(4.35);
  expect(geometry.ratio).toBeLessThan(4.75);
  expect(geometry.scrolls).toBe(true);
});

// match ordinary conversations by name, cwd, or kind and gate review runs behind search
test('filters the flyout by name, cwd, and kind while hiding review runs from the default list', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const search = flyout.getByRole('searchbox', { name: 'Search conversations' });
  const rows = flyout.locator('.conversation-row');
  await expect(rows).toHaveCount(7);
  await expect(flyout).not.toContainText('Tour repository layout');
  await search.fill('archive-3');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Historical conversation 3');
  await search.fill('claude');
  await expect(rows).toHaveCount(8);
  await expect(rows.filter({ hasText: 'Tour repository layout' })).toHaveCount(1);
  await search.fill('tour');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Tour repository layout');
});

// keep a failed list distinct from a confirmed empty list and make it retryable
test('shows only an actionable error after a failed conversation read and retries in place', async ({ page }) => {
  await mockConsole(page, { readFailures: 1 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.getByRole('alert')).toContainText('Unable to load conversations');
  await expect(flyout).not.toContainText('No named conversations in this project yet.');
  await expect(flyout.locator('.conversation-row-skeleton')).toHaveCount(0);
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toHaveCount(0);
  await expect(flyout.locator('.conversation-edit')).toHaveCount(0);
  await flyout.getByRole('button', { name: 'Retry' }).click();
  await expect(flyout.getByRole('alert')).toHaveCount(0);
  await expect(flyout.locator('.conversation-row')).toHaveCount(7);
  await expect(flyout.locator('.conversation-row.current .conversation-edit')).toBeEnabled();
  await expect(flyout.locator('.conversation-row:not(.current) .conversation-edit:enabled')).toHaveCount(0);
});

// preserve naming after a successful list confirms no current row
test('offers current conversation naming after a valid empty list', async ({ page }) => {
  await mockConsole(page, { rows: [] });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  await expect(flyout.getByRole('alert')).toHaveCount(0);
  await expect(flyout).toContainText('No named conversations in this project yet.');
  await expect(flyout.getByRole('button', { name: 'Name current conversation' })).toBeEnabled();
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

// retain resume guards while limiting edits to the current conversation
test('keeps current, orphaned, and unlaunchable rows inert while historical edits stay disabled', async ({ page }) => {
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
  await expect(flyout.locator('.conversation-row.current .conversation-choice')).toBeDisabled();
  await expect(flyout.locator('.conversation-row', { hasText: 'Historical conversation 1' }).locator('.conversation-choice')).toBeEnabled();
  await expect(flyout.locator('.conversation-row', { hasText: 'Orphaned conversation' }).locator('.conversation-choice')).toBeDisabled();
  await expect(flyout.locator('.conversation-row', { hasText: 'Unlaunchable Codex conversation' }).locator('.conversation-choice')).toBeDisabled();
  await expect(flyout.locator('.conversation-row:not(.current) .conversation-edit')).toHaveCount(3);
  await expect(flyout.locator('.conversation-row:not(.current) .conversation-edit:enabled')).toHaveCount(0);
  await expect(page.locator('.conversations-dialog')).toHaveCount(0);
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
  await expect(page.locator('.conversations-dialog')).toHaveCount(0);
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
  await page.locator('.conversations-menu .conversation-row', { hasText: 'Owen investigation' }).locator('.conversation-choice').click();
  await expect(page.getByRole('tab', { name: /Owen/u })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => switches).toEqual([{ worktreeId: 'owen', body: { kind: 'claude', id: sibling.id } }]);
});

// remove only the console record while leaving the conversation list intact
test('removes a console-named conversation from the flyout', async ({ page }) => {
  const removed: string[] = [];
  await mockConsole(page, { onRemove: (kind, id) => removed.push(`${kind}/${id}`) });
  await page.goto('/');
  await page.getByRole('button', { name: /^Conversations/u }).click();
  const flyout = page.locator('.conversations-menu');
  const historical = flyout.locator('.conversation-row', { hasText: 'Historical conversation 1' });
  await historical.getByRole('button', { name: /Remove Historical conversation 1/u }).click();
  await expect.poll(() => removed).toEqual([`claude/${baseRows[1]!.id}`]);
  await expect(historical.getByRole('button', { name: /Remove/u })).toHaveCount(0);
  await expect(historical).toBeVisible();
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

// keep the phone flyout inside the viewport without introducing a modal
test('keeps the conversation flyout scrollable inside a phone viewport', async ({ page }) => {
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
  await expect(flyout.locator('.conversations-list')).toHaveCSS('overflow-y', 'auto');
  await expect(page.locator('.conversations-dialog')).toHaveCount(0);
  // capture the phone flyout on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/conversations-phone.png` });
});
