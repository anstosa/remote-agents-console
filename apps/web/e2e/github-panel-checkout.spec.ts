import { expect, test, type Page } from '@playwright/test';

// The GitHub panel's Worktree strip: checking a pull request out here, moving it here from the
// Worktree holding it, and removing a merged or closed pull request's Worktree through the Remove
// worktree dialog.

const clean = { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
const worktree = (id: string, label: string, branch: string, extra: Record<string, unknown> = {}) => ({ id: `repo:/repo/wts/${id}`, projectId: 'repo', label, path: `/repo/wts/${id}`, main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch, gitStatus: clean, ...extra });
// an Agent in the feature Worktree, which a guided review needs
const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/repo/wts/feature', projectId: 'repo', worktreeId: 'repo:/repo/wts/feature', worktreeLabel: 'feature', branch: 'feature', title: 'Ready', gitStatus: clean, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/route.ts', additions: 2, deletions: 1, category: 'implementation' }] } };
const dashboard = (dirty: boolean, withAgent: boolean) => ({
  generation: 1,
  githubRevision: 1,
  reviewTour: { available: true },
  agents: withAgent ? [agent] : [],
  projects: [{
    id: 'repo', label: 'Repo', github: 'octo/repo', available: true, worktrees: [
      { ...worktree('main', 'Repo', 'main'), id: 'repo:/repo', path: '/repo', main: true, order: 0 },
      worktree('feature', 'feature', 'feature', dirty ? { gitStatus: { ...clean, files: 2, unstaged: 2 } } : {}),
      worktree('other', 'other', 'branch-90', { order: 2 }),
      worktree('shipped', 'shipped', 'branch-203', { order: 3 })
    ]
  }]
});
const at = (id: string, label: string) => ({ kind: 'worktree', worktreeId: `repo:/repo/wts/${id}`, label });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, author: 'kai', updatedAt: minutesAgo(10), reasons: [], ...extra });
const lists = {
  mine: [row(214, 'Serve GitHub lists from one cached poll', { author: 'tony', destination: at('feature', 'feature') })],
  reviews: [row(90, 'Handle redacted events', { destination: at('other', 'other') }), row(91, 'Retry webhooks')],
  other: [], assigned: [], issues: [],
  done: [row(203, 'Scheduled prompts', { state: 'merged', destination: at('shipped', 'shipped') })],
  fetchedAt: Date.now()
};
const detail = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  fetchedAt: Date.now(), pullRequest: {
    repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, state: 'open', draft: false, author: 'kai', mine: false, updatedAt: minutesAgo(10),
    branch: `branch-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40), headOnOrigin: true, mergeable: 'mergeable', checks: 'passed',
    threads: [], reviews: [], comments: [], checkRuns: [], reviewers: [], linkedIssues: [], ...extra
  }
});
const details: Record<string, unknown> = {
  214: detail(214, 'Serve GitHub lists from one cached poll', { author: 'tony', mine: true, branch: 'feature', destination: at('feature', 'feature') }),
  90: detail(90, 'Handle redacted events', { destination: at('other', 'other') }),
  91: detail(91, 'Retry webhooks'),
  203: detail(203, 'Scheduled prompts', { state: 'merged', destination: at('shipped', 'shipped') })
};

type Call = { method: string; path: string; body?: unknown };
// stub the console; every worktree action lands in `calls`, and `refuse` answers one with a 409
async function mount(page: Page, { dirty = false, withAgent = false, calls = [], refuse, removal = {} }: { dirty?: boolean; withAgent?: boolean; calls?: Call[]; refuse?: string; removal?: Record<string, unknown> } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard(dirty, withAgent) });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: lists });
    const number = /^\/api\/projects\/repo\/github\/pulls\/(\d+)$/u.exec(path)?.[1];
    if (number !== undefined) return route.fulfill({ json: details[number] });
    if (path.startsWith('/api/worktrees/') && (request.method() !== 'GET' || path.endsWith('/removal'))) {
      calls.push({ method: request.method(), path, ...(request.postData() === null ? {} : { body: request.postDataJSON() }) });
      if (refuse !== undefined && path.endsWith(refuse)) return route.fulfill({ status: 409, json: { error: 'An agent in this worktree is busy. Wait for it to finish, then switch again.' } });
      if (path.endsWith('/removal')) return route.fulfill({ json: { main: false, detached: false, locked: false, branch: 'branch-203', dirtyCount: 0, pushed: true, merged: true, blockers: [], stopsProcesses: [], ...removal } });
      if (request.method() === 'DELETE') return route.fulfill({ json: { removed: true, branchDeleted: (request.postDataJSON() as { deleteBranch?: boolean }).deleteBranch === true } });
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
const panel = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true });
const strip = (page: Page) => page.locator('.github-detail .github-strip').first();
// open the panel in one Worktree's Workspace and pick a pull request
async function show(page: Page, tab: RegExp, number: number) {
  await page.goto('/');
  await page.getByRole('tab', { name: tab }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('button', { name: new RegExp(`^Pull request #${number}`, 'u') }).click();
  await expect(page.locator('.github-detail').getByRole('heading')).toContainText(`#${number}`);
}

test('checks out here a pull request no Worktree holds', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls });
  await show(page, /^feature/u, 91);
  // next to the two new-Worktree actions
  await expect(strip(page)).toHaveText('Not checked out.Check out hereCheck out in a new WorktreeNew Worktree and start a Review tour');
  await strip(page).getByRole('button', { name: 'Check out here' }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/switch-pr', body: { number: 91 } }]);
});

test('checks out and moves pull requests here from a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: Call[] = [];
  await mount(page, { calls });
  // a phone's tabs are a sheet; a link picks the Workspace
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('button', { name: /^Pull request #91/u }).click();
  await strip(page).getByRole('button', { name: 'Check out here' }).click();
  await page.locator('.github-detail').getByRole('button', { name: '‹ All' }).click();
  await panel(page).getByRole('button', { name: /^Pull request #90/u }).click();
  await expect(strip(page)).toHaveText('Checked out in other.Go to WorktreeMove here');
  // nothing in the strip runs off the side of the screen
  expect(await strip(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await strip(page).getByRole('button', { name: 'Move here' }).click();
  await expect.poll(() => calls.map(call => call.path)).toEqual(['/api/worktrees/repo:/repo/wts/feature/switch-pr', '/api/worktrees/repo:/repo/wts/feature/move-pr']);
});

test('moves here a pull request another Worktree holds, saying when the switch refuses', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls, refuse: '/move-pr' });
  await show(page, /^feature/u, 90);
  await expect(strip(page)).toHaveText('Checked out in other.Go to WorktreeMove here');
  await strip(page).getByRole('button', { name: 'Move here' }).click();
  await expect.poll(() => calls).toEqual([{ method: 'POST', path: '/api/worktrees/repo:/repo/wts/feature/move-pr', body: { number: 90 } }]);
  await expect(page.getByText('Pull request could not be moved')).toBeVisible();
  await expect(page.getByText('An agent in this worktree is busy. Wait for it to finish, then switch again.')).toBeVisible();
});

test('offers neither checkout while this Worktree has uncommitted changes, and says why', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, { dirty: true });
  await show(page, /^feature/u, 91);
  await expect(strip(page).getByRole('button', { name: 'Check out here' })).toBeDisabled();
  await expect(strip(page)).toContainText('Commit or stash uncommitted changes first');
  await panel(page).getByRole('button', { name: /^Pull request #90/u }).click();
  await expect(strip(page).getByRole('button', { name: 'Move here' })).toBeDisabled();
  await expect(strip(page)).toContainText('Commit or stash uncommitted changes first');
});

test('offers a Review tour only on the pull request checked out here, once an Agent can run it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page);
  await show(page, /^feature/u, 214);
  await expect(strip(page)).toHaveText('Checked out here, in feature.Start Review tour');
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toBeDisabled();
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toHaveAttribute('title', 'Launch agent to review');
  // nowhere else
  await panel(page).getByRole('button', { name: /^Pull request #90/u }).click();
  await expect(strip(page).getByRole('button', { name: 'Start Review tour' })).toHaveCount(0);
});

test('starts a Review tour of All PR changes from the strip', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mount(page, { withAgent: true });
  await show(page, /^feature/u, 214);
  await strip(page).getByRole('button', { name: 'Start Review tour' }).click();
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
});

test('removes a merged pull request\'s Worktree through the Remove worktree dialog, its branch only when ticked', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls: Call[] = [];
  await mount(page, { calls });
  await show(page, /^feature/u, 203);
  await expect(strip(page)).toHaveText('Merged 10m ago. Worktree shipped is still here.Remove Worktree…');
  const remove = strip(page).getByRole('button', { name: 'Remove Worktree…' });
  // orange, as the launcher's offer
  await expect(remove).toHaveCSS('background-color', 'rgb(250, 179, 135)');
  // Cancel leaves everything as it was
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toContainText('shipped');
  await expect(dialog.getByLabel(/Also delete branch branch-203/u)).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await remove.click();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => calls.map(call => `${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`)).toEqual([
    'GET /api/worktrees/repo:/repo/wts/shipped/removal null',
    'GET /api/worktrees/repo:/repo/wts/shipped/removal null',
    'DELETE /api/worktrees/repo:/repo/wts/shipped {"discardChanges":false,"deleteBranch":false}'
  ]);
  await expect(page.getByText('shipped was removed.')).toBeVisible();
});

test('will not remove a Worktree the removal would harm, saying why', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, { removal: { dirtyCount: 2, pushed: false, merged: false, blockers: ['a running agent'], stopsProcesses: ['web'] } });
  // a phone's tabs are a sheet; a link picks the Workspace
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('button', { name: /^Pull request #203/u }).click();
  await strip(page).getByRole('button', { name: 'Remove Worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Cannot remove while a running agent is running.');
  await expect(dialog).toContainText('2 uncommitted changes');
  await expect(dialog).toContainText('branch-203 is neither pushed nor merged.');
  await expect(dialog).toContainText('Stops web, its running Stack process');
  await expect(dialog.getByLabel(/Also delete branch branch-203/u)).not.toBeChecked();
});
