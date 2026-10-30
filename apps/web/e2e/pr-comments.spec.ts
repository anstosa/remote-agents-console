import { expect, test, type Page, type Route } from '@playwright/test';

const pullRequest = { number: 142, title: 'Retry GitHub queries', status: 'open', url: 'https://github.com/octo/repo/pull/142', checks: 'passed', issues: { unresolvedComments: true }, unresolvedThreads: 2 };
const worktree = {
  id: 'active', projectId: 'repo', label: 'Active', path: '/worktrees/active', main: true, detached: false, locked: false, available: true, pinned: true, order: 0,
  branch: 'feature/retries', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, gitPrStatus: { base: 'origin/main', files: 2 }, pullRequest
};
const agent = { id: 'agent-active', sessionId: 'socket:$1', home: '/worktrees/active', projectId: 'repo', worktreeId: 'active', title: 'Ready', queuedPromptCount: 0, branch: worktree.branch, gitStatus: worktree.gitStatus, gitPrStatus: worktree.gitPrStatus, pullRequest };
const comment = (id: string, author: string, body: string, bot = false) => ({ id, author, bot, body, createdAt: '2026-10-16T10:00:00Z', url: `https://github.com/octo/repo/pull/142#${id}` });
const comments = {
  number: 142,
  url: pullRequest.url,
  threads: [
    { id: 'T2', path: 'src/service.ts', line: 318, startLine: 312, resolved: false, outdated: false, diffHunk: '@@ -309,2 +309,4 @@\n+const remaining = header();\n+if (remaining < 50) return cached;', comments: [comment('r2', 'jlee', 'Guard on the header being present.')] },
    { id: 'T1', path: 'src/github.ts', line: 112, resolved: false, outdated: false, diffHunk: '@@ -104 +104 @@\n+await sleep(250 * attempt);', comments: [comment('r1', 'mkaplan', 'The first retry is immediate.'), comment('r1b', 'tony', 'Not intended.')] },
    { id: 'T3', path: 'src/old.ts', line: 4, resolved: true, outdated: false, diffHunk: '', comments: [comment('r3', 'mkaplan', 'Resolved already.')] }
  ],
  reviews: [{ ...comment('v1', 'mkaplan', 'Please add a note to the setup docs.'), state: 'CHANGES_REQUESTED' }],
  comments: [comment('c1', 'jlee', 'Does this cover the REST calls too?'), comment('c2', 'codecov', 'Coverage 71%', true)]
};

// mount one agent whose worktree branch has an open pull request
async function mount(page: Page, onComments: () => void = () => {}, loadRepository: (route: Route) => Promise<unknown> = route => route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } })) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [agent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[^/]+\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/worktrees\/[^/]+\/switch-prs$/u.test(url.pathname)) return loadRepository(route);
    if (url.pathname === '/api/worktrees/active/pull-request/comments') {
      onComments();
      return route.fulfill({ json: comments });
    }
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
}

async function openComments(page: Page) {
  await page.getByRole('button', { name: /^Git status: feature\/retries/u }).click();
  await page.getByRole('button', { name: 'Show PR comments (2 unresolved)' }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await expect(panel.getByText('PR comments', { exact: true })).toBeVisible();
  return panel;
}

test('adds one unresolved review thread to the prompt from the PR card', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  let reads = 0;
  await mount(page, () => { reads += 1; });
  const panel = await openComments(page);

  // threads sort by path; the resolved one and the bot comment are hidden
  const threads = panel.getByRole('region', { name: 'Review threads' });
  await expect(threads.locator('.pr-comments-file')).toHaveText(['src/github.ts', 'src/service.ts']);
  await expect(threads.getByText('Resolved already.')).toHaveCount(0);
  await expect(threads.getByText('1 hidden')).toBeVisible();
  await expect(threads.getByText('+1 reply')).toBeVisible();
  // review summaries and conversation start folded
  await expect(panel.getByRole('button', { name: /Review summaries/u })).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByText('Please add a note to the setup docs.')).toHaveCount(0);

  await threads.getByRole('button', { name: 'Show code + thread' }).first().click();
  await expect(threads.getByText('Not intended.')).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/desktop.png` });
  await threads.getByRole('button', { name: 'Add to prompt' }).first().click();

  await expect(panel).toHaveCount(0);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveValue([
    'Address this feedback on PR #142:',
    '',
    'Review thread on src/github.ts:112',
    'https://github.com/octo/repo/pull/142#r1',
    '',
    '```diff',
    '@@ -104 +104 @@',
    '+await sleep(250 * attempt);',
    '```',
    '',
    '> @mkaplan: The first retry is immediate.',
    '>',
    '> @tony: Not intended.'
  ].join('\n'));
  expect(reads).toBe(1);
});

test('replaces open comments with a retryable repository failure', async ({ page }) => {
  let finishRepositoryRead!: () => void;
  // hold the repository read until comments are visible
  const repositoryReadFinished = new Promise<void>(resolve => { finishRepositoryRead = resolve; });
  await mount(page, () => {}, async route => {
    await repositoryReadFinished;
    return route.fulfill({ status: 502, json: { error: 'GitHub is unavailable' } });
  });

  const commentsPanel = await openComments(page);
  finishRepositoryRead();

  await expect(commentsPanel.getByText('PR comments', { exact: true })).toHaveCount(0);
  const branchFlyout = page.getByRole('region', { name: 'Changed files' });
  await expect(branchFlyout.getByRole('alert')).toContainText('GitHub is unavailable');
  await expect(branchFlyout.getByRole('button', { name: 'Retry repository choices' })).toBeVisible();
  await expect(branchFlyout.getByRole('tab', { name: 'Working', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('adds several picked comments as one numbered prompt and shows filtered ones on request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const panel = await openComments(page);

  await panel.getByRole('button', { name: 'Bots', exact: true }).click();
  await panel.getByRole('button', { name: /Conversation/u }).click();
  await expect(panel.getByText('Coverage 71%')).toBeVisible();
  await panel.getByRole('button', { name: 'Resolved', exact: true }).click();
  await expect(panel.getByText('Resolved already.')).toBeVisible();

  await panel.getByRole('checkbox', { name: 'Select review thread by @jlee' }).check();
  await panel.getByRole('checkbox', { name: 'Select comment by @jlee' }).check();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/phone.png` });
  await panel.getByRole('button', { name: 'Add 2 to prompt' }).click();

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveValue(/^Address this feedback on PR #142:\n\n1\. Review thread on src\/service\.ts:312-318\n/u);
  await expect(prompt).toHaveValue(/\n\n2\. Comment from @jlee\n   https:\/\/github\.com\/octo\/repo\/pull\/142#c1\n\n   > Does this cover the REST calls too\?$/u);
});
