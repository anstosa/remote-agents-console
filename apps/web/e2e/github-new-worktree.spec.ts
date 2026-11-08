import { expect, test, type Page } from '@playwright/test';
import { openGithubPanel } from './panel-header';
import { installPaneMock } from './pane-stream-mock';

// New Worktrees from GitHub: the shared triage lanes' and the GitHub detail's branch+ on a row no
// Worktree holds, and an Issue's detail, open the New worktree dialog prefilled. A pull request
// opens in Pull request mode, where Start a Review tour can be ticked, and lands on the GitHub
// panel focused on it; an Issue opens a new branch named for it on origin's fresh default,
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
    // a repository with no Project still opens repository-addressed detail
    { ...pull(1412, 'Debounce the search input'), repository: 'acme/web', url: 'https://github.com/acme/web/pull/1412' }
  ],
  reviews: [pull(205, 'Bump vite', { author: 'dependabot' })],
  issues: [issue(7, 'Launcher search ignores Notes!', { destination: inProject }), issue(11, 'Launcher search ignores Notes')],
  totals: { mine: 3, reviews: 1, issues: 2 }, fetchedAt: Date.now()
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
type GithubFixture = { github?: string; githubForkOf?: string; projectLabel?: string; overview?: unknown; switchPrs?: unknown };
// stub the console: creating a Worktree answers `created` and adds it (and its Agent) to the
// dashboard; every creation and Review tour start lands in `posts`
async function mount(page: Page, created: Created, posts: { path: string; body: unknown }[], fixture: GithubFixture = {}) {
  let made = false;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') {
      const agents = made && created.agentId !== undefined ? [{ id: created.agentId, sessionId: 'socket:$9', home: created.worktree.path, projectId: 'repo', worktreeId: created.worktree.id, worktreeLabel: created.worktree.label, branch: created.worktree.branch, title: 'Ready' }] : [];
      return route.fulfill({ json: { generation: 1, serverStartedAt: 1001, githubRevision: 1, reviewTour: { available: true }, agents, projects: [{ id: 'repo', label: fixture.projectLabel ?? 'Repo', github: fixture.github ?? 'octo/repo', ...(fixture.githubForkOf === undefined ? {} : { githubForkOf: fixture.githubForkOf }), available: true, manageWorktrees: true, worktrees: [main, feature, ...made ? [created.worktree] : []] }] } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: fixture.overview ?? overview });
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: lists });
    const detail = /^\/api\/projects\/repo\/github\/((?:pulls|issues)\/\d+)$/u.exec(path)?.[1];
    if (detail !== undefined) {
      // an Issue's body arrives late, after a quick Create
      if (detail === 'issues/7') await new Promise(resolve => setTimeout(resolve, 1_500));
      return route.fulfill({ json: details[detail] ?? { problem: { kind: 'failing', message: 'Not found.' } } });
    }
    if (path === '/api/projects/repo/branches') return route.fulfill({ json: { branches: [{ name: 'main', ref: 'main', remote: false, checkedOut: true }, { name: 'feature', ref: 'feature', remote: false, checkedOut: true }], base: 'origin/main' } });
    if (path === '/api/projects/repo/switch-prs') return route.fulfill({ json: fixture.switchPrs ?? switchPrs });
    if (path === '/api/projects/repo/worktrees' && request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() });
      made = true;
      return route.fulfill({ status: 201, json: { worktreeId: created.worktree.id, ...(created.agentId === undefined ? {} : { agentId: created.agentId }), ...(created.fetchError === undefined ? {} : { fetchError: created.fetchError }) } });
    }
    if (path === `/api/worktrees/${created.worktree.id}/review-tour/jobs` && request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() });
      return route.fulfill({ status: 503, json: { error: 'not in this test' } });
    }
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/[^/]+\/commands$/u.test(path)) return route.fulfill({ json: { commands: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('a repo-scope row opens the New worktree dialog on a pull request, with a Review tour ticked there, landing on it in the GitHub panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: { path: string; body: unknown }[] = [];
  await mount(page, { worktree: worktree('repo:/repo/wts/pr-12', 'Repo · pr-12', 'branch-12', false, 2), agentId: 'agent-pr' }, posts);
  await page.goto('/');
  await openGithubPanel(page);
  const ov = page.getByRole('region', { name: 'GitHub', exact: true });
  const branchPlus = ov.getByRole('button', { name: 'Checkout and actions for pull request #12' });
  await branchPlus.click();
  await expect(branchPlus).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Actions for pull request #12' });
  // the Review tour is ticked in the dialog, not chosen here
  await expect(menu.getByRole('button', { name: /Review tour/u })).toHaveCount(0);
  await menu.getByRole('button', { name: /^Checkout in a new Worktree in Repo/u }).click();
  await expect(menu).toHaveCount(0);

  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('tab', { name: 'Pull request' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radio', { name: 'Select #12' })).toBeChecked();
  const tour = dialog.getByRole('checkbox', { name: 'Start a Review tour' });
  await expect(tour).not.toBeChecked();
  // the tour starts on its own, so only Review's start sheet waits until it is unticked
  const open = dialog.getByRole('radiogroup', { name: 'Open in the new worktree' });
  await tour.check();
  await expect(open.getByRole('radio', { name: 'Agent' })).toBeChecked();
  await expect(open.getByRole('radio', { name: 'Terminal' })).toBeEnabled();
  await expect(open.getByRole('radio', { name: 'Review' })).toBeDisabled();
  await tour.uncheck();
  await expect(open.getByRole('radio', { name: 'Review' })).toBeEnabled();
  await tour.check();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => posts.map(post => post.path)).toEqual(['/api/projects/repo/worktrees', '/api/worktrees/repo:/repo/wts/pr-12/review-tour/jobs']);
  expect(posts[0]!.body).toEqual({ mode: 'pull-request', number: 12, open: 'agent', context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 12 }, targetProjectId: 'repo', expectedHolderWorktreeIds: [] } });
  expect(posts[1]!.body).toMatchObject({ scope: 'pr' });
  await expect(page.getByRole('tab', { name: /^Repo · pr-12/u })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('region', { name: 'GitHub', exact: true });
  await expect(panel.getByRole('article', { name: 'Pull request #12' })).toBeVisible();
});

test('a Review tour starts in a new worktree that opens no Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: { path: string; body: unknown }[] = [];
  await mount(page, { worktree: worktree('repo:/repo/wts/pr-12', 'Repo · pr-12', 'branch-12', false, 2) }, posts);
  await page.goto('/');
  await openGithubPanel(page);
  const ov = page.getByRole('region', { name: 'GitHub', exact: true });
  await ov.getByRole('button', { name: 'Checkout and actions for pull request #12' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #12' }).getByRole('button', { name: /^Checkout in a new Worktree in Repo/u }).click();

  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await dialog.getByRole('checkbox', { name: 'Start a Review tour' }).check();
  await dialog.getByRole('radiogroup', { name: 'Open in the new worktree' }).getByRole('radio', { name: 'Nothing' }).check();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => posts.map(post => post.path)).toEqual(['/api/projects/repo/worktrees', '/api/worktrees/repo:/repo/wts/pr-12/review-tour/jobs']);
  expect(posts[0]!.body).toMatchObject({ open: 'empty' });
  await expect(page.getByRole('tab', { name: /^Repo · pr-12/u })).toHaveAttribute('aria-selected', 'true');
});

test('creates a fork Worktree for an upstream pull request without rewriting its identity', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: { path: string; body: unknown }[] = [];
  const upstream = { ...pull(4978, 'Continue serial podcasts upstream'), repository: 'advplyr/audiobookshelf', url: 'https://github.com/advplyr/audiobookshelf/pull/4978' };
  const forkOverview = { mine: [upstream], reviews: [], issues: [], totals: { mine: 1, reviews: 0, issues: 0 }, fetchedAt: Date.now() };
  const forkChoices = { pullRequests: [{ ...choice(4978, upstream.title), branch: 'ansel/continueSerialPodcasts', url: upstream.url }], otherPullRequests: [], branches: [], pullRequestsSupported: true };
  const created = worktree('repo:/repo/wts/pr-4978', 'Audiobookshelf · pr-4978', 'ansel/continueSerialPodcasts', false, 2);
  await mount(page, { worktree: created }, posts, { github: 'anstosa/audiobookshelf', githubForkOf: 'advplyr/audiobookshelf', projectLabel: 'Audiobookshelf', overview: forkOverview, switchPrs: forkChoices });
  await page.goto('/');
  await openGithubPanel(page);
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  await github.getByRole('button', { name: 'Checkout and actions for pull request #4978' }).click();
  const menu = page.getByRole('group', { name: 'Actions for pull request #4978' });
  await expect(menu.getByRole('link')).toHaveCount(0);
  await menu.getByRole('button', { name: /^Checkout in a new Worktree in Audiobookshelf/u }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('radio', { name: 'Select #4978' })).toBeChecked();
  await dialog.getByRole('radiogroup', { name: 'Open in the new worktree' }).getByText('Nothing').click();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/projects/repo/worktrees', body: { mode: 'pull-request', number: 4978, open: 'empty', context: { identity: { repositoryKey: 'advplyr/audiobookshelf', kind: 'pull', number: 4978 }, targetProjectId: 'repo', expectedHolderWorktreeIds: [] } } }]);
});

test('an Issue\'s branch+ on a phone opens a new branch named for it on origin\'s fresh default, and drafts it in the composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts: { path: string; body: unknown }[] = [];
  const created = worktree('repo:/repo/wts/7-launcher-search-ignores-notes', 'Repo · 7-launcher-search-ignores-notes', '7-launcher-search-ignores-notes', false, 2);
  await mount(page, { worktree: created, fetchError: 'fatal: unable to access' }, posts);
  await page.goto('/');
  await openGithubPanel(page);
  const ov = page.getByRole('region', { name: 'GitHub', exact: true });
  await ov.getByRole('tab', { name: /^Issues/u }).click();
  await ov.getByRole('button', { name: 'Actions for issue #7' }).click();
  const menu = page.getByRole('group', { name: 'Actions for issue #7' });
  await menu.getByRole('button', { name: /^New Worktree in Repo/u }).click();

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
  // this worktree's pull request disables checkout but retains held-new creation
  await panel.getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  const heldMenu = page.getByRole('group', { name: 'Actions for pull request #214' });
  await expect(heldMenu.getByRole('button', { name: 'Already checked out here' })).toBeDisabled();
  await expect(heldMenu.getByRole('button', { name: /^Move checkout to a new Worktree in Repo/u })).toBeVisible();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Checkout and actions for pull request #205' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #205' }).getByRole('button', { name: /^Checkout in a new Worktree in Repo/u }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog.getByRole('radio', { name: 'Select #205' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Start a Review tour' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // a pull request's detail offers one when it is checked out nowhere
  await panel.getByRole('button', { name: /^#205 Bump vite/u }).click();
  const pullDetail = panel.getByRole('article', { name: 'Pull request #205' });
  await pullDetail.getByRole('button', { name: 'Checkout' }).click();
  const pullMenu = page.getByRole('group', { name: 'Actions for pull request #205' });
  await expect(pullMenu.getByRole('button', { name: /Review tour/u })).toHaveCount(0);
  await pullMenu.getByRole('button', { name: /^Checkout in a new Worktree in Repo/u }).click();
  await expect(dialog.getByRole('radio', { name: 'Select #205' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // an Issue's detail with no Worktree offers one
  await panel.getByRole('tab', { name: /^Issues/u }).click();
  await panel.getByRole('button', { name: /^#11 Launcher search ignores Notes/u }).click();
  await panel.getByRole('article', { name: 'Issue #11' }).getByRole('button', { name: 'Worktree' }).click();
  await page.getByRole('group', { name: 'Actions for issue #11' }).getByRole('button', { name: /^New Worktree in Repo/u }).click();
  await expect(dialog.getByLabel('Branch name')).toHaveValue('11-launcher-search-ignores-notes');
});

type HeldAnswer = 'success' | 'boot-refusal' | 'refusal' | 'recovery' | 'malformed' | 'malformed-none';

// serve one held pull request and record its dedicated operation resource
async function mountHeld(page: Page, answer: HeldAnswer, calls: { method: string; path: string; body?: Record<string, unknown> }[], fork = false) {
  const target = worktree('repo:/repo/wts/pr-214-move', 'Repo · pr-214-move', 'feature', false, 2);
  const cloneMain = { ...worktree('clone:/clone', 'Repo Clone', 'main', true, 0), projectId: 'clone' };
  const cloneHolder = { ...worktree('clone:/clone/wts/feature', 'clone feature', 'feature', false, 1), projectId: 'clone' };
  const crossClone = answer === 'malformed' || answer === 'malformed-none';
  let made = false;
  let drifted = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    // return one held source and its later target
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 1001, githubRevision: drifted ? 2 : 1, reviewTour: { available: true }, agents: [], projects: [{ id: 'repo', label: 'Repo', github: 'octo/repo', available: true, manageWorktrees: true, worktrees: [main, feature, ...made ? [target] : []] }, ...crossClone ? [{ id: 'clone', label: 'Repo Clone', github: 'Octo/Repo', available: true, manageWorktrees: true, worktrees: [cloneMain, cloneHolder] }] : []] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [pull(214, 'Serve GitHub lists from one cached poll', { destination: drifted ? { kind: 'worktree', worktreeId: cloneHolder.id, label: cloneHolder.label } : inFeature })], reviews: [], issues: [], totals: { mine: 1, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    if (/^\/api\/projects\/(?:repo|clone)\/github$/u.test(path)) return route.fulfill({ json: lists });
    if (/^\/api\/projects\/(?:repo|clone)\/github\/pulls\/214$/u.test(path)) return route.fulfill({ json: details['pulls/214'] });
    if (/^\/api\/projects\/(?:repo|clone)\/branches$/u.test(path)) return route.fulfill({ json: { branches: [{ name: 'main', ref: 'main', remote: false, checkedOut: true }, { name: 'feature', ref: 'feature', remote: false, checkedOut: true }], base: 'origin/main' } });
    if (/^\/api\/projects\/(?:repo|clone)\/switch-prs$/u.test(path)) {
      const holder = path.includes('/clone/') ? cloneHolder : feature;
      return route.fulfill({ json: { pullRequests: [{ ...choice(214, 'Serve GitHub lists from one cached poll'), checkedOut: true, headOnOrigin: !fork, openIn: { worktreeId: holder.id, worktreeName: holder.label } }], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    }
    if (/^\/api\/projects\/(?:repo|clone)\/worktrees\/move-pull-request$/u.test(path) && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ method: 'POST', path, body });
      const operationId = String(body.operationId);
      // a restarted server refuses before inspecting an earlier operation
      if (answer === 'boot-refusal') return route.fulfill({ status: 409, json: { error: 'The server restarted. Refresh before moving the pull request.', operationId } });
      if (answer === 'refusal') return route.fulfill({ status: 409, json: { error: 'The holder changed. Refresh and inspect before trying again.', operationId, refresh: true } });
      if (answer === 'recovery') return route.fulfill({ status: 409, json: { error: 'The target exists and the move needs inspection.', operationId, sourceWorktreeId: feature.id, recoveryRequired: true, candidateWorktreeId: target.id, source: { exists: true, branch: 'feature', head: '1'.repeat(40), status: 'clean' }, candidate: { pathExists: true, registered: true, discovered: true, branch: 'feature', head: '2'.repeat(40), status: '3 changes' }, currentHolderWorktreeId: target.id, taggedStash: { oid: 'a'.repeat(40), subject: `rac move-to-new ${operationId} feature` }, inferredPhase: 'stashed-source' } });
      // emulate a truncated json refusal after the holder moves to another clone
      if (answer === 'malformed' || answer === 'malformed-none') {
        drifted = true;
        return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":' });
      }
      made = true;
      return route.fulfill({ status: 201, json: { moved: true, worktreeId: target.id, targetResolved: true, operationId } });
    }
    if (/^\/api\/projects\/(?:repo|clone)\/worktrees\/move-pull-request$/u.test(path) && request.method() === 'GET') {
      calls.push({ method: 'GET', path: `${path}?${url.searchParams.toString()}` });
      const operationId = url.searchParams.get('operationId')!;
      const clear = answer === 'malformed-none' || answer === 'boot-refusal';
      return route.fulfill({ json: { operationId, sourceWorktreeId: feature.id, candidateWorktreeId: target.id, source: { exists: true, branch: 'feature', head: '1'.repeat(40), status: 'clean' }, candidate: clear ? { pathExists: false, registered: false, discovered: false, status: 'absent' } : { pathExists: true, registered: true, discovered: true, branch: 'feature', head: '2'.repeat(40), status: '3 changes' }, ...clear ? {} : { currentHolderWorktreeId: target.id, taggedStash: { oid: 'a'.repeat(40), subject: `rac move-to-new ${operationId} feature` } }, inferredPhase: clear ? 'none' : 'stashed-source' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the held-new dialog from the unified card action
async function openHeldDialog(page: Page) {
  await page.goto('/');
  await openGithubPanel(page);
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  await github.getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #214' }).getByRole('button', { name: /^Move checkout to a new Worktree in Repo/u }).click();
  return page.getByRole('dialog', { name: 'New worktree' });
}

// reopen the same canonical item after its holder changes clones
async function reopenHeldDialog(page: Page) {
  const github = page.getByRole('region', { name: 'GitHub', exact: true });
  await github.getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
  await page.getByRole('group', { name: 'Actions for pull request #214' }).getByRole('button', { name: /^Move checkout to a new Worktree in Repo Clone/u }).click();
  return page.getByRole('dialog', { name: 'New worktree' });
}

// submit one boot-fenced held move without an ordinary create first
test('moves a held pull request through the dedicated route with exact contextual identity', async ({ page }) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  await mountHeld(page, 'success', calls);
  const dialog = await openHeldDialog(page);
  await expect(dialog.getByRole('tab', { name: 'Move pull request' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('status')).toContainText('Moves PR #214 and its uncommitted changes from feature into a new worktree. The source worktree is kept.');
  await dialog.getByRole('radiogroup', { name: 'Open in the new worktree' }).getByText('Nothing').click();
  await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
  await expect.poll(() => calls.filter(call => call.method === 'POST')).toHaveLength(1);
  const body = calls[0]!.body!;
  expect(body).toMatchObject({ number: 214, sourceWorktreeId: feature.id, serverStartedAt: 1001, open: 'empty', context: { identity: { repositoryKey: 'octo/repo', kind: 'pull', number: 214 }, targetProjectId: 'repo', expectedHolderWorktreeIds: [feature.id], expectedSourceWorktreeId: feature.id } });
  expect(body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(calls.some(call => call.path === '/api/projects/repo/worktrees')).toBe(false);
  await expect(page.getByRole('tab', { name: /^Repo · pr-214-move/u })).toHaveAttribute('aria-selected', 'true');
});

// retain operation identity across contextual and boot conflicts without replay
for (const answer of ['refusal', 'boot-refusal'] as const) {
  // a refusal on this boot cannot prove that an earlier attempt had no side effects
  test(`retains held move recovery across ${answer} and dialog reopen`, async ({ page }) => {
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    await mountHeld(page, answer, calls);
    let dialog = await openHeldDialog(page);
    await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(answer === 'refusal' ? 'The holder changed. Refresh and inspect before trying again.' : 'The server restarted. Refresh before moving the pull request.');
    const firstPost = calls.find(call => call.method === 'POST')!;
    const operationId = String(firstPost.body!.operationId);
    let interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
    await expect(interrupted).toContainText(`Operation ${operationId} in Project repo`);
    await expect(interrupted).toContainText(`Source ${feature.id}`);
    await expect(interrupted).toContainText(`Inspection: ${answer === 'boot-refusal' ? 'none' : 'stashed-source'}`);
    await expect(dialog.getByRole('button', { name: 'Move to new worktree' })).toBeDisabled();
    await expect.poll(() => calls.filter(call => call.method === 'GET')).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close new worktree' }).click();
    const github = page.getByRole('region', { name: 'GitHub', exact: true });
    await github.getByRole('button', { name: 'Checkout and actions for pull request #214' }).click();
    await page.getByRole('group', { name: 'Actions for pull request #214' }).getByRole('button', { name: /^Move checkout to a new Worktree in Repo/u }).click();
    dialog = page.getByRole('dialog', { name: 'New worktree' });
    interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
    await expect(interrupted).toContainText(`Operation ${operationId} in Project repo`);
    await expect(dialog.getByRole('button', { name: 'Move to new worktree' })).toBeDisabled();
    await interrupted.getByRole('button', { name: 'Inspect interrupted move' }).click();
    await expect.poll(() => calls.filter(call => call.method === 'GET')).toHaveLength(2);
    expect(calls.filter(call => call.method === 'POST')).toEqual([firstPost]);
    expect(calls.filter(call => call.method === 'GET').map(call => call.path)).toEqual(Array(2).fill(`/api/projects/repo/worktrees/move-pull-request?number=214&sourceWorktreeId=${encodeURIComponent(feature.id)}&operationId=${operationId}`));
    await expect(page.getByRole('tab', { name: /^Repo · pr-214-move/u })).toHaveCount(0);
    // only an explicit acknowledgement after a clear inspection permits a new intent
    if (answer === 'boot-refusal') {
      await interrupted.getByRole('button', { name: 'Start a new move' }).click();
      await expect(dialog.getByRole('button', { name: 'Move to new worktree' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
      await expect.poll(() => calls.filter(call => call.method === 'POST')).toHaveLength(2);
      expect(calls.filter(call => call.method === 'POST')[1]!.body!.operationId).not.toBe(operationId);
    }
    else await expect(interrupted.getByRole('button', { name: 'Start a new move' })).toHaveCount(0);
  });
}

// inspect recovery facts without a second mutation
test('inspects held-New recovery by UUID and never retries automatically', async ({ page }) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  await mountHeld(page, 'recovery', calls);
  const dialog = await openHeldDialog(page);
  await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
  const interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
  await expect(interrupted).toContainText('Inspection: stashed-source');
  await expect(interrupted).toContainText(`Source: present · branch feature · status clean · HEAD ${'1'.repeat(40)}`);
  await expect(interrupted).toContainText(`Target: registered · discovered · branch feature · status 3 changes · HEAD ${'2'.repeat(40)}`);
  await expect(interrupted).toContainText('Current holder repo:/repo/wts/pr-214-move');
  await expect(interrupted).toContainText('Changes preserved in stash');
  await expect(dialog.getByRole('button', { name: 'Move to new worktree' })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'GET')).toHaveLength(1);
  await interrupted.getByRole('button', { name: 'Inspect interrupted move' }).click();
  await expect.poll(() => calls.filter(call => call.method === 'GET')).toHaveLength(2);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await expect(interrupted.getByRole('button', { name: 'Start a new move' })).toHaveCount(0);
});

// retain an ambiguous operation across closure and cross-clone holder drift
test('reopens malformed held recovery on the original project and never posts it again', async ({ page }) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  await mountHeld(page, 'malformed', calls);
  let dialog = await openHeldDialog(page);
  await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
  const firstPost = calls.find(call => call.method === 'POST')!;
  const operationId = String(firstPost.body!.operationId);
  let interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
  await expect(interrupted).toContainText(`Operation ${operationId} in Project repo`);
  await expect(interrupted).toContainText(`Source ${feature.id}`);
  await expect(interrupted).toContainText('Inspection: stashed-source');
  await expect(interrupted).toContainText(`Source: present · branch feature · status clean · HEAD ${'1'.repeat(40)}`);
  await expect(interrupted).toContainText(`Target: registered · discovered · branch feature · status 3 changes · HEAD ${'2'.repeat(40)}`);
  await expect(interrupted).toContainText('Current holder repo:/repo/wts/pr-214-move');
  await expect(interrupted).toContainText(`Changes preserved in stash ${'a'.repeat(40)} · rac move-to-new ${operationId} feature`);
  await dialog.getByRole('button', { name: 'Close new worktree' }).click();
  dialog = await reopenHeldDialog(page);
  interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
  await expect(interrupted).toContainText(`Operation ${operationId} in Project repo`);
  await expect(dialog.getByRole('button', { name: 'Move to new worktree' })).toBeDisabled();
  await interrupted.getByRole('button', { name: 'Inspect interrupted move' }).click();
  await expect.poll(() => calls.filter(call => call.method === 'GET')).toHaveLength(2);
  expect(calls.filter(call => call.method === 'POST')).toEqual([firstPost]);
  expect(calls.filter(call => call.method === 'GET').map(call => call.path)).toEqual(Array(2).fill(`/api/projects/repo/worktrees/move-pull-request?number=214&sourceWorktreeId=${encodeURIComponent(feature.id)}&operationId=${operationId}`));
});

// require explicit acknowledgement of a clear inspection before another mutation
test('starts a second held move only after acknowledging an inferred-none projection', async ({ page }) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  await mountHeld(page, 'malformed-none', calls);
  const dialog = await openHeldDialog(page);
  await dialog.getByRole('button', { name: 'Move to new worktree' }).click();
  const interrupted = dialog.getByRole('status', { name: 'Interrupted move' });
  await expect(interrupted).toContainText('Inspection: none');
  const move = dialog.getByRole('button', { name: 'Move to new worktree' });
  await expect(move).toBeDisabled();
  await page.waitForTimeout(300);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  const firstOperation = calls.find(call => call.method === 'POST')!.body!.operationId;
  await interrupted.getByRole('button', { name: 'Start a new move' }).click();
  await expect(move).toBeEnabled();
  await move.click();
  await expect.poll(() => calls.filter(call => call.method === 'POST')).toHaveLength(2);
  expect(calls.filter(call => call.method === 'POST')[1]!.body!.operationId).not.toBe(firstOperation);
});

// force fork held moves to terminal or empty only
test('disables Agent and Review for a held fork while preserving Terminal', async ({ page }) => {
  await mountHeld(page, 'success', [], true);
  const dialog = await openHeldDialog(page);
  const open = dialog.getByRole('radiogroup', { name: 'Open in the new worktree' });
  await expect(open.getByRole('radio', { name: 'Agent' })).toBeDisabled();
  await expect(open.getByRole('radio', { name: 'Review' })).toBeDisabled();
  await expect(open.getByRole('radio', { name: 'Terminal' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Start a Review tour' })).toBeDisabled();
});
