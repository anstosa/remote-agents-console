import { expect, test, type Page } from '@playwright/test';

// Configured buttons in the GitHub panel: the `pullRequest` slot on my pull request checked out
// here, `reviewRequest` on someone else's, `issue` on an Issue whose Worktree is here, and
// `split:github` in the panel header. Picked Review threads go to this Worktree's Agent only.

const worktree = (id: string, label: string, branch: string, main: boolean, order: number) => ({ id, projectId: 'repo', label, path: id.slice(id.indexOf(':') + 1), main, detached: false, locked: false, available: true, pinned: true, order, branch });
const button = (id: string, text: string, actionKind: 'shell' | 'prompt' = 'prompt') => ({ id, text, color: 'mauve', style: 'outline', actionKind });
const slots = {
  tabLead: [], leftNav: [], rightNav: [], navMenu: [],
  pullRequest: [button('push', 'Commit/Push'), button('fixup', '$fixup'), button('ship', 'Push now', 'shell')],
  reviewRequest: [button('review', '$review'), button('fetch', 'Fetch', 'shell')],
  issue: [button('plan', '$plan')],
  'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': [],
  'split:github': [button('gh', 'gh status', 'shell')]
};
const dashboard = {
  generation: 1,
  githubRevision: 1,
  agents: [],
  projects: [{ id: 'repo', label: 'Repo', github: 'octo/repo', available: true, worktrees: [worktree('repo:/repo', 'Repo', 'main', true, 0), worktree('repo:/repo/wts/feature', 'feature', 'feature', false, 1), worktree('repo:/repo/wts/pr-90', 'pr-90', 'branch-90', false, 2)] }],
  buttons: { revision: 'buttons-v1', application: slots, projects: { repo: slots } }
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const feature = { kind: 'worktree', worktreeId: 'repo:/repo/wts/feature', label: 'feature' };
const review = { kind: 'worktree', worktreeId: 'repo:/repo/wts/pr-90', label: 'pr-90' };
const row = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, updatedAt: minutesAgo(10), reasons: [], ...extra });
const lists = {
  mine: [row(214, 'Serve GitHub lists from one cached poll', { destination: feature }), row(230, 'Quiet work')],
  reviews: [row(90, 'Handle redacted events', { author: 'kai', destination: review })],
  other: [], done: [row(203, 'Scheduled prompts', { state: 'merged', destination: feature })],
  assigned: [row(201, 'GitHub PR dashboard', { url: 'https://github.com/octo/repo/issues/201', destination: feature }), row(11, 'Launcher search ignores Notes', { url: 'https://github.com/octo/repo/issues/11' })],
  issues: [],
  fetchedAt: Date.now()
};
const comment = (id: string, author: string, body: string, extra: Record<string, unknown> = {}) => ({ id, author, bot: false, body, createdAt: minutesAgo(30), url: `https://github.com/octo/repo/pull/214#${id}`, ...extra });
const thread = (id: string, path: string, line: number, diffHunk: string, comments: unknown[], extra: Record<string, unknown> = {}) => ({ id, path, line, resolved: false, outdated: false, diffHunk, comments, ...extra });
const pullDetail = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  repository: 'octo/repo', number, title, url: `https://github.com/octo/repo/pull/${number}`, state: 'open', draft: false, author: 'tony', mine: true, updatedAt: minutesAgo(10),
  branch: `branch-${number}`, baseBranch: 'main', mergeable: 'mergeable', checks: 'passed', threads: [], reviews: [], comments: [], checkRuns: [], reviewers: [], linkedIssues: [], ...extra
});
const details: Record<string, unknown> = {
  'pulls/214': { fetchedAt: Date.now(), pullRequest: pullDetail(214, 'Serve GitHub lists from one cached poll', { branch: 'feature', destination: feature, threads: [
    thread('t1', 'src/github/service.ts', 42, '@@ -40,3 +40,3 @@\n-  old()\n+  poll()', [comment('c1', 'mira', 'Why one poll?'), comment('c2', 'tony', 'Budget.', { mine: true })]),
    thread('t2', 'src/github/github.ts', 7, '@@ -7 +7 @@\n+client', [comment('c4', 'coderabbit', 'Consider a timeout.', { bot: true })]),
    thread('t3', 'src/app.ts', 3, '', [comment('c5', 'kai', 'Done.')], { resolved: true })
  ] }) },
  'pulls/230': { fetchedAt: Date.now(), pullRequest: pullDetail(230, 'Quiet work', { threads: [thread('t7', 'src/a.ts', 1, '', [comment('c7', 'mira', 'Hm.')])] }) },
  'pulls/90': { fetchedAt: Date.now(), pullRequest: pullDetail(90, 'Handle redacted events', { author: 'kai', mine: false, branch: 'branch-90', destination: review, threads: [thread('t9', 'src/events.ts', 12, '', [comment('c9', 'tony', 'Why redact here?', { mine: true })]), thread('t10', 'src/redact.ts', 4, '', [comment('c10', 'tony', 'Name it.', { mine: true })])] }) },
  'pulls/203': { fetchedAt: Date.now(), pullRequest: pullDetail(203, 'Scheduled prompts', { state: 'merged', branch: 'feature', destination: feature, threads: [thread('t11', 'src/b.ts', 2, '', [comment('c11', 'mira', 'Later.')])] }) },
  'issues/11': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 11, title: 'Launcher search ignores Notes', url: 'https://github.com/octo/repo/issues/11', state: 'open', author: 'jo', body: '', labels: [], linkedPullRequests: [] } },
  'issues/201': { fetchedAt: Date.now(), issue: { repository: 'octo/repo', number: 201, title: 'GitHub PR dashboard', url: 'https://github.com/octo/repo/issues/201', state: 'open', author: 'jo', body: 'One place for every PR.', labels: [], linkedPullRequests: [], destination: feature } }
};

// stub the console; each configured-button start lands in `starts`
async function mount(page: Page, starts: Record<string, unknown>[] = [], drafts: Record<string, unknown>[] = []) {
  await page.route('**/api/**', async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/github/overview') return route.fulfill({ json: { mine: [], reviews: [], issues: [], totals: { mine: 0, reviews: 0, issues: 0 }, fetchedAt: Date.now() } });
    if (path === '/api/github/overview/seen') return route.fulfill({ status: 204 });
    if (path === '/api/projects/repo/github') return route.fulfill({ json: lists });
    const detail = /^\/api\/projects\/repo\/github\/((?:pulls|issues)\/\d+)$/u.exec(path)?.[1];
    if (detail !== undefined) return route.fulfill({ json: details[detail] });
    if (path === '/api/button-actions/draft') {
      drafts.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 409, json: { error: 'agent_launch_failed' } });
    }
    if (path === '/api/button-actions') {
      starts.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 202, json: { operation: { id: `operation_${'x'.repeat(30)}${starts.length}`, state: 'complete', phase: 'submitted' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
const panel = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true });
const detail = (page: Page) => panel(page).locator('.github-detail');
const composer = (page: Page, worktreeId: string) => page.locator(`textarea[data-prompt-id="worktree-prompt:${worktreeId}"]`);

// the flyout's "Add to prompt" text for the service.ts thread alone
const serviceThread = [
  'Address this feedback on PR #214:',
  '',
  'Review thread on src/github/service.ts:42',
  'https://github.com/octo/repo/pull/214#c1',
  '',
  '```diff',
  '@@ -40,3 +40,3 @@',
  '-  old()',
  '+  poll()',
  '```',
  '',
  '> @mira: Why one poll?',
  '>',
  '> @tony: Budget.'
].join('\n');

test('puts my pull request\'s buttons in its detail and hands picked threads to this Worktree\'s Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const starts: Record<string, unknown>[] = [];
  const drafts: Record<string, unknown>[] = [];
  await mount(page, starts, drafts);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();
  // the panel-wide slot sits in the header
  await expect(panel(page).getByRole('toolbar', { name: 'GitHub actions' }).getByRole('button', { name: 'gh status' })).toBeVisible();

  // my pull request, checked out here: the Pull request slot, not the Review request one
  await expect(detail(page).getByRole('heading')).toHaveText('#214Serve GitHub lists from one cached poll');
  const actions = detail(page).getByRole('group', { name: 'Pull request actions' });
  await expect(actions.getByRole('button')).toHaveText(['Commit/Push', '$fixup', 'Push now']);
  await expect(detail(page).getByRole('button', { name: '$review' })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Commit/Push' }).click();
  await expect.poll(() => starts.map(start => [start.slot, start.actionId, start.append])).toEqual([['pullRequest', 'push', undefined]]);

  // a resolved thread can't be picked
  const threads = detail(page).getByRole('region', { name: 'Review threads' });
  await threads.getByRole('button', { name: /^Resolved/u }).click();
  await expect(threads.getByRole('checkbox')).toHaveCount(2);
  await threads.getByRole('checkbox', { name: 'Select the thread on src/github/service.ts' }).check();
  const bar = threads.getByRole('group', { name: 'Selected threads' });
  await expect(bar).toContainText('1 selected');
  // prompt buttons only, each saying how many threads follow
  await expect(bar.getByRole('button')).toHaveText(['Clear', 'Add 1 to prompt', 'Commit/Push +1', '$fixup +1']);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/desktop.png` });
  // editing one before it is sent keeps the threads with it
  await bar.getByRole('button', { name: '$fixup +1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit before submit', exact: true }).click();
  await expect.poll(() => drafts).toEqual([expect.objectContaining({ slot: 'pullRequest', actionId: 'fixup', append: serviceThread })]);
  await threads.getByRole('checkbox', { name: 'Select the thread on src/github/service.ts' }).check();
  await bar.getByRole('button', { name: '$fixup +1' }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toMatchObject({ slot: 'pullRequest', actionId: 'fixup', append: serviceThread });
  expect(starts).toHaveLength(2);
  await expect(bar).toHaveCount(0);
  await expect(threads.getByRole('checkbox', { name: 'Select the thread on src/github/service.ts' })).not.toBeChecked();

  // "Add N to prompt" drafts them in this Worktree's composer, in the list's order
  await threads.getByRole('checkbox', { name: 'Select the thread on src/github/service.ts' }).check();
  await threads.getByRole('checkbox', { name: 'Select the thread on src/github/github.ts' }).check();
  await bar.getByRole('button', { name: 'Add 2 to prompt' }).click();
  await expect(composer(page, 'repo:/repo/wts/feature')).toHaveValue(/^Address this feedback on PR #214:\n\n1\. Review thread on src\/github\/github\.ts:7\n[^]*\n2\. Review thread on src\/github\/service\.ts:42\n/u);
  await expect(bar).toHaveCount(0);
  expect(starts).toHaveLength(2);

  // an Issue whose Worktree is here offers the Issue slot
  await panel(page).getByRole('button', { name: /^Issue #201/u }).click();
  await expect(detail(page).getByRole('group', { name: 'Issue actions' }).getByRole('button')).toHaveText(['$plan']);
  // one no Worktree holds offers none
  await panel(page).getByRole('button', { name: /^Issue #11/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#11Launcher search ignores Notes');
  await expect(detail(page).getByRole('group', { name: 'Issue actions' }).getByRole('button')).toHaveCount(0);
  // nor does my merged pull request, though its Worktree is here
  await panel(page).getByRole('button', { name: /^Pull request #203/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#203Scheduled prompts');
  await expect(detail(page).getByRole('button', { name: 'Commit/Push' })).toHaveCount(0);
  await expect(detail(page).getByRole('checkbox')).toHaveCount(0);
});

test('keeps prompt actions in the Worktree holding the pull request, and puts the Review request slot on someone else\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const starts: Record<string, unknown>[] = [];
  await mount(page, starts);
  await page.goto('/');
  await page.getByRole('tab', { name: /^feature/u }).click();
  await toolbar(page).getByRole('button', { name: 'GitHub', exact: true }).click();

  // someone else's pull request, checked out in another Worktree
  await panel(page).getByRole('button', { name: /^Pull request #90/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#90Handle redacted events');
  await expect(detail(page).getByRole('checkbox')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: '$review' })).toHaveCount(0);
  await expect(detail(page).locator('.github-prompt-elsewhere')).toHaveText('Selecting threads for a prompt, and this pull request\'s buttons, are in pr-90, so its Agent gets them.');
  // mine, checked out nowhere
  await panel(page).getByRole('button', { name: /^Pull request #230/u }).click();
  await expect(detail(page).getByRole('heading')).toHaveText('#230Quiet work');
  await expect(detail(page).getByRole('button', { name: 'Commit/Push' })).toHaveCount(0);
  await expect(detail(page).locator('.github-prompt-elsewhere')).toHaveText('Selecting threads for a prompt, and this pull request\'s buttons, are in a Worktree for it, so its Agent gets them.');

  // going there brings them
  await panel(page).getByRole('button', { name: /^Pull request #90/u }).click();
  await detail(page).getByRole('button', { name: 'Go to Worktree' }).click();
  await expect(page.getByRole('tab', { name: /^pr-90/u })).toHaveAttribute('aria-selected', 'true');
  const actions = detail(page).getByRole('group', { name: 'Pull request actions' });
  await expect(actions.getByRole('button')).toHaveText(['$review', 'Fetch']);
  await expect(detail(page).getByRole('button', { name: 'Commit/Push' })).toHaveCount(0);
  await detail(page).getByRole('checkbox', { name: 'Select the thread on src/events.ts' }).check();
  const bar = detail(page).getByRole('group', { name: 'Selected threads' });
  await expect(bar.getByRole('button')).toHaveText(['Clear', 'Add 1 to prompt', '$review +1']);
  await bar.getByRole('button', { name: '$review +1' }).click();
  await expect.poll(() => starts.map(start => [start.slot, start.actionId])).toEqual([['reviewRequest', 'review']]);
  expect(starts[0]!.append).toBe('Address this feedback on PR #90:\n\nReview thread on src/events.ts:12\nhttps://github.com/octo/repo/pull/214#c9\n\n> @tony: Why redact here?');
  expect(starts[0]!.placeId).toBe('repo:/repo/wts/pr-90');
});

test('picks threads and runs a button with them on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const starts: Record<string, unknown>[] = [];
  await mount(page, starts);
  await page.goto('/#tab=feature');
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.locator('.place-menu').getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel(page).getByRole('region', { name: 'This Worktree' }).getByRole('button', { name: /^Pull request #214/u }).click();
  await expect(detail(page).getByRole('group', { name: 'Pull request actions' }).getByRole('button', { name: '$fixup' })).toBeVisible();
  await detail(page).getByRole('checkbox', { name: 'Select the thread on src/github/service.ts' }).check();
  const bar = detail(page).getByRole('group', { name: 'Selected threads' });
  await expect(bar).toBeInViewport();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/phone.png` });
  // nothing runs off the side of the screen
  expect(await panel(page).locator('.github-pane-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await bar.getByRole('button', { name: '$fixup +1' }).click();
  await expect.poll(() => starts.map(start => start.append)).toEqual([serviceThread]);
});
