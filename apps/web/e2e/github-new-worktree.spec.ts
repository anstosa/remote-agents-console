import { expect, test, type Page } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock';

// New Worktrees from GitHub: the Overview's and the GitHub panel's green branch+ on a row no
// Worktree holds, and an Issue's detail, open the New worktree dialog prefilled. A pull request
// opens in Pull request mode (Start a Review tour ticked by the tour action) and lands on the
// GitHub panel focused on it; an Issue opens a new branch named for it on origin's fresh default,
// recorded as the Worktree's, with the Issue drafted in the new Worktree's composer.

type Worktree = { id: string; projectId: string; label: string; path: string; main: boolean; detached: boolean; locked: boolean; available: boolean; pinned: boolean; order: number; branch: string };
const worktree = (id: string, label: string, branch: string, main: boolean, order: number): Worktree => ({ id, projectId: 'repo', label, path: id.slice(id.indexOf(':') + 1), main, detached: false, locked: false, available: true, pinned: true, order, branch });
const main = worktree('repo:/repo', 'Repo', 'main', true, 0);
const feature = worktree('repo:/repo/wts/feature', 'feature', 'feature', false, 1);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inProject = { kind: 'project', worktreeId: main.id, label: 'Repo' };
const inFeature = { kind: 'worktree', worktreeId: feature.id, label: 'feature' };
const pull = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, updatedAt: minutesAgo(10), reasons: [], ...extra });
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/issues/${number}`, author: 'jo', updatedAt: minutesAgo(60), reasons: [], ...extra });
const overview = {
  mine: [
    pull(12, 'Fix login redirect', { destination: inProject }),
    pull(214, 'Serve GitHub lists from one cached poll', { destination: inFeature }),
    // a repository with no Project only opens on github.com
    { ...pull(1412, 'Debounce the search input'), repository: 'acme/web', url: 'https://github.com/acme/web/pull/1412' }
  ],
  reviews: [],
  issues: [issue(7, 'Launcher search ignores Notes!', { destination: inProject })],
  totals: { mine: 3, reviews: 0, issues: 1 }, fetchedAt: Date.now()
};
const lists = {
  mine: [pull(214, 'Serve GitHub lists from one cached poll', { destination: inFeature })],
  reviews: [], other: [pull(205, 'Bump vite', { author: 'dependabot' })], done: [],
  assigned: [], issues: [issue(11, 'Launcher search ignores Notes')],
  fetchedAt: Date.now()
};
const pullDetail = (number: number, title: string) => ({
  repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, state: 'open', draft: false, author: 'tony', mine: true, updatedAt: minutesAgo(10),
  branch: `branch-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40), headOnOrigin: true, mergeable: 'mergeable', checks: 'passed',
  threads: [], reviews: [], comments: [], checkRuns: [], reviewers: [], linkedIssues: []
});
const details: Record<string, unknown> = {
  'pulls/12': { fetchedAt: Date.now(), pullRequest: pullDetail(12, 'Fix login redirect') },
  'pulls/205': { fetchedAt: Date.now(), pullRequest: pullDetail(205, 'Bump vite') },
  'issues/7': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 7, title: 'Launcher search ignores Notes!', url: 'https://github.com/octo/repo/issues/7', state: 'open', author: 'jo', body: 'Typing a Note title finds nothing.', labels: [], linkedPullRequests: [] } },
  'issues/11': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 11, title: 'Launcher search ignores Notes', url: 'https://github.com/octo/repo/issues/11', state: 'open', author: 'jo', body: '', labels: [], linkedPullRequests: [] } }
};
// the dialog's pull request choices
const choice = (number: number, title: string) => ({ number, title, branch: `branch-${number}`, draft: false, url: `https://github.com/octo/repo/pull/${number}`, checkedOut: false });
const switchPrs = { pullRequests: [choice(12, 'Fix login redirect')], otherPullRequests: [choice(205, 'Bump vite')], branches: [], pullRequestsSupported: true };

// `fetchError`: origin could not be fetched for the new branch
type Created = { worktree: Worktree; agentId?: string; fetchError?: string };
// stub the console: creating a Worktree answers `created` and adds it (and its Agent) to the
// dashboard; every creation and Review tour start lands in `posts`
async function mount(page: Page, created: Created, posts: { path: string; body: unknown }[]) {
  let made = false;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') {
      const agents = made && created.agentId !== undefined ? [{ id: created.agentId, sessionId: 'socket:$9', home: created.worktree.path, projectId: 'repo', worktreeId: created.worktree.id, worktreeLabel: created.worktree.label, branch: created.worktree.branch, title: 'Ready' }] : [];
      return route.fulfill({ json: { generation: 1, githubRevision: 1, reviewTour: { available: true }, agents, projects: [{ id: 'repo', label: 'Repo', github: 'octo/repo', available: true, manageWorktrees: true, worktrees: [main, feature, ...made ? [created.worktree] : []] }] } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: overview });
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: lists });
    const detail = /^\/api\/projects\/repo\/github\/((?:pulls|issues)\/\d+)$/u.exec(path)?.[1];
    if (detail !== undefined) {
      // an Issue's body arrives late, after a quick Create
      if (detail === 'issues/7') await new Promise(resolve => setTimeout(resolve, 1_500));
      return route.fulfill({ json: details[detail] ?? { problem: { kind: 'failing', message: 'Not found.' } } });
    }
    if (path === '/api/projects/repo/branches') return route.fulfill({ json: { branches: [{ name: 'main', ref: 'main', remote: false, checkedOut: true }, { name: 'feature', ref: 'feature', remote: false, checkedOut: true }], base: 'origin/main' } });
    if (path === '/api/projects/repo/switch-prs') return route.fulfill({ json: switchPrs });
    if (path === '/api/projects/repo/worktrees' && request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() });
      made = true;
      return route.fulfill({ status: 201, json: { worktreeId: created.worktree.id, ...(created.agentId === undefined ? {} : { agentId: created.agentId }), ...(created.fetchError === undefined ? {} : { fetchError: created.fetchError }) } });
    }
    if (path === `/api/agents/${created.agentId}/review-tour/jobs` && request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() });
      return route.fulfill({ status: 503, json: { error: 'not in this test' } });
    }
    if (path === `/api/agents/${created.agentId}/tickets`) return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/[^/]+\/commands$/u.test(path)) return route.fulfill({ json: { commands: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('an Overview row checks a pull request out in a new Worktree with a Review tour, landing on it in the GitHub panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: { path: string; body: unknown }[] = [];
  await mount(page, { worktree: worktree('repo:/repo/wts/pr-12', 'Repo · pr-12', 'branch-12', false, 2), agentId: 'agent-pr' }, posts);
  await page.goto('/#overview');
  const ov = page.getByRole('region', { name: 'Overview' });
  // only a row whose repository has a Project and which no Worktree holds offers one
  await expect(ov.getByRole('button', { name: /^New Worktree for #/u })).toHaveText(['', '']);
  await expect(ov.getByRole('button', { name: 'New Worktree for #214' })).toHaveCount(0);
  await expect(ov.getByRole('button', { name: 'New Worktree for #1412' })).toHaveCount(0);

  const branchPlus = ov.getByRole('button', { name: 'New Worktree for #12' });
  await branchPlus.click();
  await expect(branchPlus).toHaveAttribute('aria-expanded', 'true');
  const menu = ov.getByRole('group', { name: 'New Worktree for #12' });
  await expect(menu.getByRole('button')).toHaveText(['Check out in a new WorktreeRepo · pr-12', 'New Worktree and start a Review tourRepo · pr-12 · the tour/review agent from settings']);
  await menu.getByRole('button', { name: /^New Worktree and start a Review tour/u }).click();
  await expect(menu).toHaveCount(0);

  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('tab', { name: 'Pull request' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radio', { name: 'Select #12' })).toBeChecked();
  const tour = dialog.getByRole('checkbox', { name: 'Start a Review tour' });
  await expect(tour).toBeChecked();
  // the tour runs beside an Agent, so the other openings wait until it is unticked
  const open = dialog.getByRole('radiogroup', { name: 'Open in the new worktree' });
  await expect(open.getByRole('radio', { name: 'Agent' })).toBeChecked();
  await expect(open.getByRole('radio', { name: 'Terminal' })).toBeDisabled();
  await tour.uncheck();
  await expect(open.getByRole('radio', { name: 'Terminal' })).toBeEnabled();
  await tour.check();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => posts.map(post => post.path)).toEqual(['/api/projects/repo/worktrees', '/api/agents/agent-pr/review-tour/jobs']);
  expect(posts[0]!.body).toEqual({ mode: 'pull-request', number: 12, open: 'agent' });
  expect(posts[1]!.body).toMatchObject({ scope: 'pr' });
  await expect(page.getByRole('region', { name: 'Overview' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Repo · pr-12/u })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('article', { name: 'Pull request #12' })).toBeVisible();
});

test('an Issue\'s branch+ on a phone opens a new branch named for it on origin\'s fresh default, and drafts it in the composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts: { path: string; body: unknown }[] = [];
  const created = worktree('repo:/repo/wts/7-launcher-search-ignores-notes', 'Repo · 7-launcher-search-ignores-notes', '7-launcher-search-ignores-notes', false, 2);
  await mount(page, { worktree: created, fetchError: 'fatal: unable to access' }, posts);
  await page.goto('/#overview');
  const ov = page.getByRole('region', { name: 'Overview' });
  await ov.getByRole('tab', { name: /^Issues/u }).click();
  await ov.getByRole('button', { name: 'New Worktree for #7' }).click();
  const menu = ov.getByRole('group', { name: 'New Worktree for #7' });
  await expect(menu.getByRole('button')).toHaveText(['New Worktree for this Issue…Repo · branch 7-launcher-search-ignores-notes']);
  await menu.getByRole('button').click();

  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('tab', { name: 'New branch' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog).toContainText('The new Worktree\'s composer opens with Issue #7, unsent: Launcher search ignores Notes!');
  await expect(dialog.getByLabel('Branch name')).toHaveValue('7-launcher-search-ignores-notes');
  // the base is origin's default, which the server fetches as it creates the branch
  await expect(dialog.getByLabel('Base')).toHaveValue('origin/main');
  await dialog.getByRole('radiogroup', { name: 'Open in the new worktree' }).getByText('Nothing').click();
  // the Issue's body is still on its way (see `mount`); the draft waits for it
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => posts.map(post => post.body)).toEqual([{ mode: 'new', branch: '7-launcher-search-ignores-notes', base: 'origin/main', issue: 7, open: 'empty' }]);
  // a failed fetch leaves the base as last fetched, and says so without blocking
  await expect(page.getByText('Worktree created from origin as last fetched')).toBeVisible();
  await expect(page.getByText('Could not fetch origin: fatal: unable to access')).toBeVisible();
  await expect(page.locator(`textarea[data-prompt-id="worktree-prompt:${created.id}"]`)).toHaveValue('Issue #7: Launcher search ignores Notes!\nhttps://github.com/octo/repo/issues/7\n\nTyping a Note title finds nothing.');
});

test('the GitHub panel offers new Worktrees on its rows and an Issue\'s detail', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, { worktree: worktree('repo:/repo/wts/pr-205', 'Repo · pr-205', 'branch-205', false, 2) }, []);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  // This Worktree's own pull request offers none
  await expect(panel.getByRole('button', { name: 'New Worktree for #214' })).toHaveCount(0);
  await panel.getByRole('button', { name: /^Other open/u }).first().click();
  await panel.getByRole('button', { name: 'New Worktree for #205' }).click();
  await panel.getByRole('group', { name: 'New Worktree for #205' }).getByRole('button', { name: /^Check out in a new Worktree/u }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('radio', { name: 'Select #205' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Start a Review tour' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // a pull request's detail offers both when it is checked out nowhere
  await panel.getByRole('button', { name: /^Pull request #205/u }).click();
  const pullDetail = panel.getByRole('article', { name: 'Pull request #205' });
  await expect(pullDetail.getByRole('button', { name: 'New Worktree and start a Review tour' })).toBeVisible();
  await pullDetail.getByRole('button', { name: 'Check out in a new Worktree' }).click();
  await expect(dialog.getByRole('radio', { name: 'Select #205' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // an Issue's detail with no Worktree offers one
  await panel.getByRole('button', { name: /^Other open/u }).last().click();
  await panel.getByRole('button', { name: /^Issue #11/u }).click();
  await panel.getByRole('article', { name: 'Issue #11' }).getByRole('button', { name: 'New Worktree for this Issue…' }).click();
  await expect(dialog.getByLabel('Branch name')).toHaveValue('11-launcher-search-ignores-notes');
});
