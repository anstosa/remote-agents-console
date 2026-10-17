import { expect, test, type Page } from '@playwright/test';

type BranchFixture = {
  branch: string;
  checkedOut: boolean;
  commitSummary?: unknown;
};

const fiftyCharacters = '0123456789'.repeat(5);
const unicodePrefix = 'a'.repeat(49);
const branches: BranchFixture[] = [
  { branch: 'feature/single', checkedOut: false, commitSummary: { subject: 'Seed branch setup', count: 1 } },
  { branch: 'feature/multi', checkedOut: false, commitSummary: { subject: `${fiftyCharacters}trailing text\nignored detail`, count: 3 } },
  { branch: 'feature/unicode', checkedOut: false, commitSummary: { subject: `${unicodePrefix}🧪trailing`, count: 2 } },
  { branch: 'feature/combining', checkedOut: false, commitSummary: { subject: `${unicodePrefix}e\u0301trailing`, count: 2 } },
  { branch: 'feature/modifier', checkedOut: false, commitSummary: { subject: `${unicodePrefix}👍🏽trailing`, count: 2 } },
  { branch: 'feature/joined', checkedOut: false, commitSummary: { subject: `${unicodePrefix}👨‍👩‍👧‍👦trailing`, count: 2 } },
  { branch: 'feature/zero', checkedOut: false, commitSummary: { subject: 'Do not render this', count: 0 } },
  { branch: 'feature/malformed', checkedOut: false, commitSummary: { subject: 42, count: 2 } },
  { branch: 'feature/absent', checkedOut: false }
];

// mock one branch list and its checkout action
async function mockBranches(page: Page, onCheckout?: (body: unknown) => void) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // provide one authenticated console session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide one selected worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready' }], projects: [] } });
    // satisfy shared startup data
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // satisfy terminal ticket loading
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // satisfy saved prompt loading
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // return branch summaries exactly as the server boundary supplies them
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], pullRequestsSupported: true, branches } });
    // record one branch checkout
    if (url.pathname === '/api/worktrees/cora/switch-branch' && request.method() === 'POST') {
      onCheckout?.(request.postDataJSON());
      return route.fulfill({ status: 202 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the branch list in the git status flyout
async function openBranches(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await panel.getByRole('tab', { name: 'Branches', exact: true }).click();
  return panel;
}

// read the rendered one-line geometry
async function summaryGeometry(summary: ReturnType<Page['locator']>) {
  return summary.evaluate(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const suffix = element.querySelector('.switch-branch-summary-more')?.getBoundingClientRect();
    return {
      height: box.height,
      lineHeight: Number.parseFloat(style.lineHeight),
      suffixInside: suffix === undefined || (suffix.left >= box.left - 0.5 && suffix.right <= box.right + 0.5 && suffix.top >= box.top - 0.5 && suffix.bottom <= box.bottom + 0.5)
    };
  });
}

// preserve summary content and checkout actions across optional metadata failures
test('renders valid commit summaries without hiding branches with invalid summaries', async ({ page }) => {
  let checkedOut: unknown;
  await mockBranches(page, body => { checkedOut = body; });
  const panel = await openBranches(page);

  const single = panel.getByRole('group', { name: 'feature/single', exact: true });
  await expect(single.locator('.switch-branch-summary')).toHaveText('Seed branch setup');
  await expect(single.locator('.switch-branch-summary')).toHaveAttribute('title', 'Seed branch setup');

  const multi = panel.getByRole('group', { name: 'feature/multi', exact: true });
  await expect(multi.locator('.switch-branch-summary')).toHaveText(`${fiftyCharacters} and 2 more`);
  await expect(multi.locator('.switch-branch-summary')).toHaveAttribute('title', `${fiftyCharacters}trailing text and 2 more`);
  await expect(multi.locator('.switch-branch-summary-more')).toHaveText(' and 2 more');

  const unicode = panel.getByRole('group', { name: 'feature/unicode', exact: true });
  await expect(unicode.locator('.switch-branch-summary')).toHaveText(`${unicodePrefix}🧪 and 1 more`);
  await expect(unicode.locator('.switch-branch-summary')).toHaveAttribute('title', `${unicodePrefix}🧪trailing and 1 more`);

  // truncate only between user-perceived characters
  for (const [branch, grapheme] of [['combining', 'e\u0301'], ['modifier', '👍🏽'], ['joined', '👨‍👩‍👧‍👦']]) {
    const option = panel.getByRole('group', { name: `feature/${branch}`, exact: true });
    await expect(option.locator('.switch-branch-summary')).toHaveText(`${unicodePrefix}${grapheme} and 1 more`);
  }

  // keep malformed optional metadata from removing the branch actions
  for (const branch of ['feature/zero', 'feature/malformed', 'feature/absent']) {
    const option = panel.getByRole('group', { name: branch, exact: true });
    await expect(option).toBeVisible();
    await expect(option.locator('.switch-branch-summary')).toHaveCount(0);
    await expect(option.getByRole('button', { name: 'Checkout' })).toBeEnabled();
  }

  await panel.getByRole('group', { name: 'feature/malformed', exact: true }).getByRole('button', { name: 'Checkout' }).click();
  await expect.poll(() => checkedOut).toEqual({ branch: 'feature/malformed' });
  await expect(panel).toBeHidden();
});

// preserve one-line summaries and their count at both responsive sizes
test('keeps long branch summaries to one line on desktop and mobile', async ({ page }, testInfo) => {
  await mockBranches(page);
  const panel = await openBranches(page);
  const multi = panel.getByRole('group', { name: 'feature/multi', exact: true }).locator('.switch-branch-summary');
  const unicode = panel.getByRole('group', { name: 'feature/unicode', exact: true }).locator('.switch-branch-summary');

  // verify both responsive flyout widths
  for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(multi).toBeVisible();
    await expect(multi.locator('.switch-branch-summary-more')).toHaveText(' and 2 more');
    await expect(unicode.locator('.switch-branch-summary-more')).toHaveText(' and 1 more');
    // require one rendered line and an unclipped count
    for (const summary of [multi, unicode]) {
      // wait for responsive layout to settle after resizing
      await expect.poll(async () => {
        const geometry = await summaryGeometry(summary);
        return { oneLine: geometry.height <= geometry.lineHeight + 1, suffixInside: geometry.suffixInside };
      }).toEqual({ oneLine: true, suffixInside: true });
    }
    await panel.screenshot({ path: testInfo.outputPath(`branch-summaries-${viewport.name}.png`) });
  }
});
