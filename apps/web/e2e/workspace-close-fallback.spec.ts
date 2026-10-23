import { expect, test, type Page } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock';

type Worktree = { id: string; content?: 'agent' | 'shell'; pinned?: boolean };
const empty: Worktree = { id: 'Empty', pinned: true };
const first: Worktree = { id: 'First', content: 'agent' };
const source: Worktree = { id: 'Source', content: 'agent' };
const later: Worktree = { id: 'Later', content: 'agent' };

// keep ordered worktrees discoverable after their final session ends
async function mount(page: Page, worktrees: Worktree[], selected = 'Source') {
  const closed = new Set<string>();
  await installPaneMock(page);
  // restore shell splits without creating real terminals
  await page.addInitScript(entries => {
    // open every fixture shell at its owning worktree
    for (const [index, entry] of entries.entries()) {
      // leave agent-only and empty worktrees unchanged
      if (entry.content === 'shell') localStorage.setItem(`rac.terminals:${entry.id}`, JSON.stringify([{ paneId: `%${index + 1}`, name: entry.id }]));
    }
  }, worktrees);
  // serve session lifecycle changes through the dashboard
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // authenticate the fixture browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // preserve discovery order while dropping closed agents and shells
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: closed.size + 1,
      agents: worktrees.filter(entry => entry.content === 'agent' && !closed.has(entry.id)).map(entry => ({ id: entry.id, sessionId: `socket:$${entry.id}`, home: `/worktrees/${entry.id}`, worktreeId: entry.id, title: 'Ready', attention: 'finished', queuedPromptCount: 0 })),
      projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: worktrees.map((entry, order) => ({ id: entry.id, projectId: 'repo', label: entry.id, path: `/worktrees/${entry.id}`, available: true, pinned: entry.pinned ?? false, order, consoleShells: entry.content === 'shell' && !closed.has(entry.id) ? 1 : 0 })) }]
    } });
    // stop the selected session only after the user closes it
    if ((path === '/api/agents/Source/deactivate' && request.method() === 'POST') || (path.startsWith('/api/worktrees/Source/panes/') && request.method() === 'DELETE')) {
      closed.add('Source');
      return route.fulfill({ status: 204 });
    }
    const paneEntry = worktrees.find(entry => path === `/api/worktrees/${entry.id}/panes`);
    // expose only live managed shells
    if (paneEntry !== undefined) return route.fulfill({ json: { panes: paneEntry.content === 'shell' && !closed.has(paneEntry.id) ? [{ paneId: `%${worktrees.indexOf(paneEntry) + 1}`, session: '$1', window: '@1', role: 'shell', name: paneEntry.id, command: 'bash', path: `/worktrees/${paneEntry.id}`, title: '', agent: false, busy: false }] : [] } });
    // keep notes empty
    if (path.endsWith('/notes')) return route.fulfill({ json: { notes: [] } });
    // connect mock terminal streams
    if (path.endsWith('/tickets')) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // keep prompt collections empty
    if (path.endsWith('/prompt-history') || path.endsWith('/queued-prompts')) return route.fulfill({ json: { prompts: [] } });
    // acknowledge viewed output
    if (path.endsWith('/notifications/dismiss')) return route.fulfill({ status: 204 });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto(`/#worktree=${selected}`);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${selected || worktrees[0]!.id} —`, 'u'));
  return closed;
}

// cover disappeared tabs without changing surviving selections or desktop behavior
for (const scenario of [
  { name: 'mobile chooses the first populated worktree instead of the next neighbor', width: 390, entries: [empty, first, source, later], expected: 'First' },
  { name: 'mobile chooses the first populated worktree instead of the previous neighbor', width: 390, entries: [empty, first, later, source], expected: 'First' },
  { name: 'mobile includes shell-only worktrees in the fallback', width: 390, entries: [empty, { ...first, content: 'shell' as const }, source, later], expected: 'First' },
  { name: 'mobile preserves the selected pinned worktree after its last agent closes', width: 390, entries: [empty, first, { ...source, pinned: true }, later], expected: 'Source' },
  { name: 'desktop preserves the neighboring worktree fallback', width: 1280, entries: [empty, first, source, later], expected: 'Later' },
  { name: 'mobile preserves the fallback when only empty worktrees remain', width: 390, entries: [empty, source, { id: 'Later', pinned: true }], expected: 'Later' }
]) {
  // close the final agent through its normal power control
  test(scenario.name, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    const closed = await mount(page, scenario.entries);
    await page.getByRole('button', { name: 'Agent power options' }).click();
    await page.getByRole('menuitem', { name: 'Turn off', exact: true }).click();
    await expect.poll(() => closed.has('Source')).toBe(true);
    // wait for the pinned workspace to lose its agent before checking selection
    if (scenario.expected === 'Source') await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${scenario.expected} —`, 'u'));
  });
}

// deleting the final shell follows the same mobile fallback as stopping an agent
test('mobile chooses the first populated worktree after deleting the final shell', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const closed = await mount(page, [empty, first, { ...source, content: 'shell' }, later]);
  await page.getByRole('button', { name: 'Delete terminal Source' }).click();
  await expect.poll(() => closed.has('Source')).toBe(true);
  // refresh dashboard shell counts without waiting for the safety poll
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^First —/u, { timeout: 10_000 });
});

// initial selection must not be mistaken for a closed worktree
test('mobile still opens the first empty pinned worktree on initial load', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, [empty, first], '');
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Empty —/u);
});
