import { expect, test, type Page } from '@playwright/test';

const worktree = {
  id: 'active', projectId: 'repo', label: 'Active', path: '/worktrees/active', main: true, detached: false, locked: false, available: true, pinned: true, order: 0,
  branch: 'feature/commits',
  gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/main.tsx', additions: 12, deletions: 4 }] },
  gitPrStatus: { base: 'origin/release/2.x', files: 3, changes: [
    { code: 'M ', path: 'src/main.tsx', additions: 96, deletions: 16 },
    { code: 'A ', path: 'src/log.ts', additions: 142, deletions: 0 },
    { code: 'A ', path: 'test/log.test.ts', additions: 120, deletions: 0 }
  ] }
};
const agent = { id: 'agent-active', sessionId: 'socket:$1', home: '/worktrees/active', projectId: 'repo', worktreeId: 'active', title: 'Ready', queuedPromptCount: 0, branch: worktree.branch, gitStatus: worktree.gitStatus, gitPrStatus: worktree.gitPrStatus };
const commits = {
  base: 'origin/release/2.x', truncated: false, commits: [
    { sha: 'd60c1322400000000000000000000000000000aa', subject: 'Show commit details', body: 'Expanding a commit reveals\nits full message.', author: 'Tony', authoredAt: new Date(Date.now() - 14 * 60_000).toISOString(), merge: false, pushed: false, changes: [{ code: 'M ', path: 'src/main.tsx', additions: 84, deletions: 12 }] },
    { sha: 'e30c2790000000000000000000000000000000bb', subject: "Merge branch 'main' into feature/commits", body: '', author: 'Tony', authoredAt: new Date(Date.now() - 3_600_000).toISOString(), merge: true, pushed: true, changes: [] },
    { sha: 'c40bf6c0000000000000000000000000000000cc', subject: 'Add commit log endpoint', body: '', author: 'Tony', authoredAt: new Date(Date.now() - 7_200_000).toISOString(), merge: false, pushed: true, changes: [{ code: 'A ', path: 'src/log.ts', additions: 142, deletions: 0 }, { code: 'A ', path: 'test/log.test.ts', additions: 120, deletions: 0 }] }
  ]
};

// a one-file unified diff the Code panel can parse
const commitPatch = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const log = [];\n`;

// mount one worktree with an agent, counting commit-log loads (or failing them) and recording the
// comparisons the code panel asks for
async function mount(page: Page, failCommits = false, base = worktree.gitPrStatus.base) {
  const loads = { count: 0 };
  const comparisons: unknown[] = [];
  const gitPrStatus = { ...worktree.gitPrStatus, base };
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // keep the unmodified git ref in dashboard data
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ ...agent, gitPrStatus }], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ ...worktree, gitPrStatus }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[^/]+\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/[^/]+\/switch-prs$/u.test(url.pathname)) return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // let the server choose the comparison base
    if (url.pathname === '/api/worktrees/active/commits') {
      expect(url.search).toBe('');
      loads.count += 1;
      return failCommits ? route.fulfill({ status: 404, json: { error: 'commits unavailable' } }) : route.fulfill({ json: { ...commits, base } });
    }
    // return the same resolved base for whole-branch patches
    if (url.pathname === '/api/worktrees/active/comparison') {
      const body = route.request().postDataJSON() as { kind: string };
      comparisons.push(body);
      const path = body.kind === 'working' ? 'src/main.tsx' : 'src/log.ts';
      const comparisonBase = body.kind === 'pr' ? base : 'HEAD';
      return route.fulfill({ json: { kind: body.kind, base: comparisonBase, gitBase: 'HEAD', truncated: false, fingerprint: path, files: [{ change: { code: 'A ', path, additions: 1, deletions: 0 }, kind: 'tracked', patch: commitPatch(path), capped: false }] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Git status: feature\/commits/u }).click();
  return { panel: page.getByRole('region', { name: 'Changed files' }), loads, comparisons };
}

// retain the resolved non-main base across flyout grouping and code navigation
test('groups the All PR files by commit and remembers the choice', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1180, height: 900 });
  const { panel, loads, comparisons } = await mount(page);
  await expect(panel.getByRole('button', { name: 'All PR' })).toHaveAttribute('title', 'Compare with release/2.x');
  await expect(panel.locator('.git-status-panel-header')).toContainText('PR changes');
  await expect(panel.locator('.git-status-details')).toContainText('Compared with release/2.x');
  const grouping = panel.getByRole('group', { name: 'Group files by' });
  await expect(grouping.getByRole('button', { name: 'By kind' })).toHaveAttribute('aria-pressed', 'true');
  // By kind is today's grouping and loads no commits
  await expect(panel.getByRole('group', { name: 'Implementation files' })).toBeVisible();
  expect(loads.count).toBe(0);

  await grouping.getByRole('button', { name: 'By commit' }).click();
  const sections = panel.locator('.git-commit-section');
  await expect(sections).toHaveCount(4);
  await expect(sections.nth(0)).toContainText('Uncommitted changes');
  await expect(sections.nth(1)).toContainText('Show commit details');
  await expect(sections.nth(1).locator('.git-commit-badge.local')).toBeVisible();
  // allow fixture setup time to advance the relative age
  await expect(sections.nth(1)).toContainText(/d60c132 · \d+ min ago · 1 file/u);
  await expect(panel.locator('.git-status-details')).toContainText('3 commits');
  // a merge starts collapsed and lists no files
  await expect(sections.nth(2)).toHaveClass(/\bcollapsed\b/u);
  await expect(sections.nth(3).getByRole('button', { name: 'View changes to test/log.test.ts' })).toBeVisible();

  // the message toggle shows only on an expanded commit with a body, and reflows its paragraph
  const messageToggle = sections.nth(1).getByRole('button', { name: 'Show commit message' });
  await messageToggle.click();
  await expect(sections.nth(1).locator('.git-commit-message')).toHaveText('Expanding a commit reveals its full message.');
  await expect(sections.nth(3).getByRole('button', { name: 'Show commit message' })).toHaveCount(0);
  await sections.nth(1).getByRole('button', { name: 'Collapse' }).click();
  await expect(sections.nth(1).getByRole('button', { name: /commit message/u })).toHaveCount(0);
  await expect(sections.nth(1).locator('.git-commit-message')).toHaveCount(0);

  // the totals and file rows end their removed-lines column at the same edge
  const head = sections.nth(3).locator('.git-commit-head > .git-status-file-lines > :last-child');
  const row = sections.nth(3).locator('.git-status-file').first().locator('.git-status-file-lines > :last-child');
  const [headBox, rowBox] = await Promise.all([head.boundingBox(), row.boundingBox()]);
  expect(Math.abs((headBox?.x ?? 0) + (headBox?.width ?? 0) - (rowBox?.x ?? 0) - (rowBox?.width ?? 0))).toBeLessThanOrEqual(1);

  await panel.getByRole('button', { name: 'Collapse all' }).click();
  await expect(panel.locator('.git-commit-section.collapsed')).toHaveCount(4);
  await panel.getByRole('button', { name: 'Expand all' }).click();
  await expect(panel.locator('.git-commit-section.collapsed')).toHaveCount(0);

  // a file row opens the Code panel and closes the fly-out
  await sections.nth(3).getByRole('button', { name: 'View changes to src/log.ts' }).click();
  await expect(panel).toHaveCount(0);
  // send only the comparison kind rather than a hardcoded base
  await expect.poll(() => comparisons.at(-1)).toEqual({ kind: 'pr' });
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code.locator('.code-pane-title')).toHaveText('All PR changes');
  await expect(code.getByRole('button', { name: 'src/log.ts', exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Git status: feature\/commits/u }).click();
  await expect(page.getByRole('region', { name: 'Changed files' }).getByRole('group', { name: 'Group files by' }).getByRole('button', { name: 'By commit' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('rac.git-change-grouping'))).toBe('commit');
  if (process.env.SHOT_COMMITS) await page.screenshot({ path: process.env.SHOT_COMMITS });
});

// hide origin in either ref format without changing other prefixes or branch segments
for (const [base, label] of [
  ['refs/remotes/origin/release/2.x', 'release/2.x'],
  ['upstream/release/2.x', 'upstream/release/2.x'],
  ['feature/origin/topic', 'feature/origin/topic']
] as const) {
  // preserve branch identity while omitting the implied remote
  test(`formats the comparison label for ${base}`, async ({ page }) => {
    const { panel } = await mount(page, false, base);
    await expect(panel.getByRole('button', { name: 'All PR' })).toHaveAttribute('title', `Compare with ${label}`);
    await expect(panel.locator('.git-status-details')).toContainText(`Compared with ${label}`);
  });
}

test('opens one commit\'s own changes in the Code panel', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rac.git-change-grouping', 'commit'));
  const { panel, comparisons } = await mount(page);
  const sections = panel.locator('.git-commit-section');
  await expect(sections).toHaveCount(4);
  // the uncommitted changes and a merge have no commit diff of their own to open
  const view = (index: number) => sections.nth(index).getByRole('button', { name: "View this commit's changes" });
  await expect(view(0)).toHaveCount(0);
  await expect(view(2)).toHaveCount(0);
  await expect(view(1)).toBeVisible();

  await view(3).click();
  await expect(panel).toHaveCount(0);
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code.locator('.code-pane-title')).toHaveText('Add commit log endpoint');
  await expect(code.locator('.code-pane-branch')).toHaveText('c40bf6c');
  await expect(code.getByRole('button', { name: 'src/log.ts', exact: false }).first()).toBeVisible();
  expect(comparisons.at(-1)).toEqual({ kind: 'commit', commit: commits.commits[2]!.sha });
  // a guided review does not cover a single commit
  await expect(code.getByRole('button', { name: /Review/u })).toHaveCount(0);
  // the picker marks the commit, not either Comparison, and lists only commits with changes
  await code.locator('.code-pane-picker').click();
  const picker = page.getByRole('menu', { name: 'Comparison' });
  await expect(picker.getByRole('menuitemradio', { name: 'Working changes' })).toHaveAttribute('aria-checked', 'false');
  await expect(picker.getByRole('menuitemradio', { name: 'All PR changes' })).toHaveAttribute('aria-checked', 'false');
  await expect(picker.locator('.code-pane-picker-commit')).toHaveCount(2);
  await expect(picker.getByRole('menuitemradio', { name: /Add commit log endpoint/u })).toHaveAttribute('aria-checked', 'true');
  if (process.env.SHOT_COMMIT_VIEW) await page.screenshot({ path: process.env.SHOT_COMMIT_VIEW });

  // picking a Comparison leaves the commit
  await picker.getByRole('menuitemradio', { name: 'Working changes' }).click();
  await expect(code.locator('.code-pane-title')).toHaveText('Working changes');
  expect(comparisons.at(-1)).toEqual({ kind: 'working' });

  // and picking a commit returns to it
  await code.locator('.code-pane-picker').click();
  await picker.getByRole('menuitemradio', { name: /Add commit log endpoint/u }).click();
  await expect(code.locator('.code-pane-title')).toHaveText('Add commit log endpoint');
  expect(comparisons.at(-1)).toEqual({ kind: 'commit', commit: commits.commits[2]!.sha });
});

test('shows a failure in place of the commit sections', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.git-change-grouping', 'commit'));
  const { panel } = await mount(page, true);
  await expect(panel.getByRole('alert')).toHaveText('Commits unavailable');
  await expect(panel.locator('.git-commit-section')).toHaveCount(1);
});
