import { expect, test, type Page } from '@playwright/test';

// A structured (Pi) Agent's transcript Panel, variant D: one group per prompt, one line per tool call.

type Transcript = { items: unknown[]; earlier?: number; status?: { extension: string[]; cost?: number; contextPercent?: number } };

// stub a console whose one Worktree runs a Pi Agent, serving `transcript` and each item in `full`
async function mockPi(page: Page, transcript: Transcript, { attention = 'finished', full = {} }: { attention?: 'working' | 'finished'; full?: Record<string, unknown> } = {}) {
  const requested: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
      const agent = { id: 'agent-1', transport: 'structured', panel: 'transcript', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: '', branch: 'cora', kind: 'pi', attention, structured: { lifecycle: 'live', revision: 4 }, queuedPromptCount: 0 };
      return route.fulfill({ json: { generation: 1, agents: [agent], projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
    }
    if (url.pathname === '/api/agents/agent-1/transcript') {
      requested.push(url.search);
      const item = url.searchParams.get('item');
      if (item !== null) return full[item] === undefined ? route.fulfill({ status: 404, json: { error: 'transcript item unavailable' } }) : route.fulfill({ json: { item: full[item] } });
      return route.fulfill({ json: { earlier: 0, status: { extension: [] }, ...transcript } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return requested;
}

const log = (page: Page) => page.locator('.log-split > .log-output').getByRole('log', { name: 'Transcript' });
const tool = (page: Page, name: string) => log(page).getByRole('button', { name, exact: true });

test('each prompt starts a group that ends with its tool calls and cost; the working group is marked live', async ({ page }) => {
  await mockPi(page, { items: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Hide the empty badge' },
    { id: 'r1', kind: 'tool', name: 'Read', summary: 'queued-prompts.tsx', state: 'done', durationMs: 3, result: '42 lines' },
    { id: 'm2', kind: 'message', role: 'assistant', text: 'Guarded the badge.' },
    { id: 'e1', kind: 'settled', outcome: 'done', cost: 0.0123, toolCalls: 1 },
    { id: 'm3', kind: 'message', role: 'user', text: 'Then commit it', queued: true },
    { id: 'm4', kind: 'message', role: 'user', text: 'Also check main.tsx', steer: true },
    { id: 'b1', kind: 'tool', name: 'Run', summary: 'git commit', state: 'running' },
    { id: 'e2', kind: 'settled', outcome: 'cancelled', cost: 0.001, toolCalls: 1 },
    // a Turn an extension started, with no prompt: its own group, never the one before
    { id: 'x1', kind: 'tool', name: 'Read', summary: 'notes.txt', state: 'running' }
  ] }, { attention: 'working' });
  await page.goto('/');
  const groups = log(page).locator('.transcript-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(1).locator('.transcript-group-end')).toHaveText('cancelled · 1 tool call · $0.001');
  await expect(groups.nth(2).locator('.transcript-prompt')).toHaveCount(0);
  await expect(groups.nth(2)).toHaveClass(/live/u);
  await expect(groups.nth(0).locator('.transcript-prompt')).toHaveText('›Hide the empty badge');
  await expect(groups.nth(0).locator('.transcript-group-end')).toHaveText('done · 1 tool call · $0.012');
  await expect(groups.nth(0)).not.toHaveClass(/live/u);
  // a prompt from the queue says so; a steer sits inside its group
  await expect(groups.nth(1).locator('.transcript-prompt')).toHaveText('›Then commit it (from the queue)');
  await expect(groups.nth(1).locator('.transcript-steer')).toHaveText('⤷Also check main.tsx (steer)');
  await expect(groups.nth(1)).not.toHaveClass(/live/u);
  const rule = await groups.nth(2).evaluate(element => getComputedStyle(element).borderLeftColor);
  const peach = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--peach)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
  expect(rule).toBe(peach);
});

test('a tool line shows its verb, target, duration and one result line, and expands to its full output', async ({ page }) => {
  const output = Array.from({ length: 12 }, (_, line) => `test ${line + 1} ok`).join('\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPi(page, { items: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Run the tests' },
    { id: 'b1', kind: 'tool', name: 'Run', summary: 'pnpm test', state: 'done', durationMs: 4612, tail: 'test 8 ok\ntest 9 ok\ntest 10 ok\ntest 11 ok\ntest 12 ok', outputLines: 12 },
    { id: 'g1', kind: 'tool', name: 'Search', summary: 'saved-prompts-count', state: 'done', durationMs: 18, result: '2 matches' },
    { id: 'd1', kind: 'tool', name: 'Edit', summary: 'apps/web/src/queued-prompts.tsx', state: 'done', durationMs: 11, diff: { path: 'apps/web/src/queued-prompts.tsx', patch: '--- apps/web/src/queued-prompts.tsx\n+++ apps/web/src/queued-prompts.tsx\n@@ -15,2 +15,2 @@\n-      <span>{count}</span>\n+      {count > 0 && <span>{count}</span>}\n----\n+++i;\n' } },
    { id: 'b2', kind: 'tool', name: 'Run', summary: 'pnpm build', state: 'running', tail: 'a\nb\nc\nd\ne', outputLines: 7 }
  ] }, { attention: 'working', full: { b1: { id: 'b1', kind: 'tool', name: 'Run', summary: 'pnpm test', state: 'done', durationMs: 4612, output } } });
  await page.goto('/');

  const run = tool(page, 'Run(pnpm test) 4.6s');
  await expect(run).toHaveAttribute('aria-expanded', 'false');
  // a finished command shows its last 3 lines, a running one its last 5
  const runResult = log(page).locator('.transcript-result').nth(0);
  await expect(runResult.locator('pre')).toHaveText('test 10 ok\ntest 11 ok\ntest 12 ok');
  await expect(runResult.getByRole('button', { name: '… 9 earlier lines · show all' })).toBeVisible();
  await expect(log(page).locator('.transcript-result').nth(3).locator('pre')).toHaveText('a\nb\nc\nd\ne');
  await expect(log(page).locator('.transcript-result').nth(1)).toHaveText('└2 matches');
  // an edit's compact diff, with a way to see it in context
  const diff = log(page).locator('.transcript-result').nth(2);
  // only the file header is dropped: a removed `---` line and an added `++i;` stay
  await expect(diff.locator('.transcript-diff-line')).toHaveText(['@@ -15,2 +15,2 @@', '-      <span>{count}</span>', '+      {count > 0 && <span>{count}</span>}', '----', '+++i;']);
  await expect(diff.locator('.transcript-diff-file')).toHaveText('apps/web/src/queued-prompts.tsx+2−2Code panel ↗');
  await expect(diff.getByRole('button', { name: 'Code panel ↗' })).toBeVisible();

  // the chevron is a real touch target on a phone
  const chevron = (await run.locator('.transcript-chevron').boundingBox())!;
  expect(chevron.width).toBeGreaterThanOrEqual(36);
  expect(chevron.height).toBeGreaterThanOrEqual(36);

  await runResult.getByRole('button', { name: '… 9 earlier lines · show all' }).click();
  await expect(run).toHaveAttribute('aria-expanded', 'true');
  await expect(log(page).locator('.transcript-open pre')).toHaveText(output);
  await run.click();
  await expect(run).toHaveAttribute('aria-expanded', 'false');
  await expect(log(page).locator('.transcript-open')).toHaveCount(0);

  await diff.getByRole('button', { name: 'Code panel ↗' }).click();
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible();
});

test('a script shows as Script(N tool calls) with its calls beneath it and its source when open', async ({ page }) => {
  const source = 'const hits = await tools.grep({ pattern: "badge" });\ntext(hits);';
  await mockPi(page, { items: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Check every badge' },
    { id: 'c1', kind: 'tool', name: 'Script', summary: '2 tool calls', state: 'done', durationMs: 200, result: 'Script completed' },
    { id: 'c1/1', kind: 'tool', name: 'Search', summary: 'badge', state: 'done', parentId: 'c1', durationMs: 18, kept: false },
    { id: 'c1/2', kind: 'tool', name: 'Read', summary: 'main.tsx', state: 'done', parentId: 'c1', durationMs: 9, kept: false },
    { id: 'x9/1', kind: 'tool', name: 'Read', summary: 'orphan.tsx', state: 'done', parentId: 'x9' },
    { id: 'e1', kind: 'settled', outcome: 'done', cost: 0.004, toolCalls: 3 }
  ] }, { full: { c1: { id: 'c1', kind: 'tool', name: 'Script', summary: '2 tool calls', state: 'done', durationMs: 200, source, output: 'Script completed\nOutput:\n2 hits' } } });
  await page.goto('/');

  const script = tool(page, 'Script(2 tool calls) 200ms');
  await expect(script).toBeVisible();
  // the script's calls sit indented beneath it; after a reload their results were not kept
  const children = log(page).locator('.transcript-children .transcript-tool-line');
  await expect(children).toHaveText([/^Search\(badge\) 18ms · result not kept/u, /^Read\(main\.tsx\) 9ms · result not kept/u]);
  const scriptBox = (await script.boundingBox())!;
  expect((await children.nth(0).boundingBox())!.x).toBeGreaterThan(scriptBox.x);
  // a call with a parent never becomes a top-level line, even when its parent is not shown
  await expect(log(page).getByText('orphan.tsx')).toHaveCount(0);
  await expect(log(page).locator('.transcript-group-end')).toHaveText('done · 3 tool calls · $0.004');

  await script.click();
  await expect(log(page).locator('.transcript-open .transcript-source')).toHaveText(source);
  await expect(log(page).locator('.transcript-open .transcript-output')).toHaveText('Script completed\nOutput:\n2 hits');
});

test('thinking stays hidden but for a live line, and ⋮ → Show thinking reveals it', async ({ page }) => {
  await mockPi(page, { items: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Look into it' },
    { id: 't1', kind: 'thinking', text: 'The badge renders unconditionally.' },
    { id: 'm2', kind: 'message', role: 'assistant', text: 'Found it.' },
    { id: 't2', kind: 'thinking', text: '', live: true }
  ] }, { attention: 'working' });
  await page.goto('/');
  await expect(log(page).locator('.transcript-thinking')).toHaveText(['∴thinking…']);
  await expect(log(page).getByText('The badge renders unconditionally.')).toHaveCount(0);

  await page.locator('.log-split > .log-output').getByRole('button', { name: 'More agent output actions' }).click();
  await page.getByRole('button', { name: 'Show thinking' }).click();
  await expect(log(page).locator('.transcript-thinking')).toHaveText(['∴The badge renders unconditionally.', '∴thinking…']);
});

test('a status line above the composer shows the extension status, context and cost; a notify is an inline line', async ({ page }) => {
  await mockPi(page, { items: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Run the tests' },
    { id: 'n1', kind: 'notice', text: 'Tests passed', tone: 'info' },
    { id: 'e1', kind: 'settled', outcome: 'done', cost: 0.02, toolCalls: 0 }
  ], status: { extension: ['sandbox: on'], cost: 0.0812, contextPercent: 31.4 } });
  await page.goto('/');
  await expect(log(page).locator('.transcript-notice')).toHaveText('※Tests passed');
  const panel = page.locator('.log-split > .log-output');
  const status = panel.getByRole('status', { name: 'Status line' });
  await expect(status).toHaveText('sandbox: onctx 31%$0.081');
  const statusBox = (await status.boundingBox())!;
  const promptBox = (await panel.getByRole('region', { name: 'Prompt composer' }).boundingBox())!;
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(promptBox.y + 1);
});

test('a long transcript starts with Load earlier, which reads more of it', async ({ page }) => {
  const requested = await mockPi(page, { earlier: 340, items: [{ id: 'm1', kind: 'message', role: 'user', text: 'Latest prompt' }] });
  await page.goto('/');
  const earlier = log(page).getByRole('button', { name: 'Load earlier' });
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect.poll(() => requested.at(-1)).toBe('?limit=400');
});

test('on a wide screen the transcript keeps a reading width', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await mockPi(page, { items: [{ id: 'm1', kind: 'message', role: 'user', text: 'Hello' }] });
  await page.goto('/');
  const width = (await log(page).locator('.transcript-group').boundingBox())!.width;
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(width).toBeLessThanOrEqual(52 * rem);
});
