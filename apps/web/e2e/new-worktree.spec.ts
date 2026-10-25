import { expect, test } from '@playwright/test';

// the Add-a-Worktree flow: each project section carries a "New worktree…" control that
// opens a dialog with a new-branch and an existing-branch mode, and POSTs the choice
const dashboard = {
  generation: 1,
  reviewTour: { available: true },
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, setup: true, worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] },
    { id: 'ro', label: 'Mounted Elsewhere', available: true, manageWorktrees: false, manageWorktreesReason: 'the container does not mount this project at its host path, so git cannot manage its worktrees', worktrees: [
      { id: 'ro:/ro', projectId: 'ro', label: 'Mounted Elsewhere', path: '/ro', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }
  ]
};

// the Project's repository-wide list: own PRs, others' PRs, and who already holds each
const pullRequest = (number: number, title: string, branch: string, extra = {}) => ({ number, title, branch, draft: false, url: `https://github.com/acme/repo/pull/${number}`, checkedOut: false, ...extra });
const switchPrs = {
  pullRequests: [
    pullRequest(12, 'Fix login redirect', 'fix-login'),
    pullRequest(15, 'Dark mode', 'dark-mode', { checkedOut: true, openIn: { worktreeId: 'repo:/repo/wts/dark-mode', worktreeName: 'Repo · dark-mode' } })
  ],
  otherPullRequests: [pullRequest(20, 'Contributor docs', 'docs')],
  branches: [],
  pullRequestsSupported: true
};

async function stub(page: import('@playwright/test').Page, onCreate: (body: unknown) => void) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/projects/repo/branches') return route.fulfill({ json: { branches: [
      { name: 'main', ref: 'main', remote: false, checkedOut: true },
      { name: 'feature', ref: 'feature', remote: false, checkedOut: false },
      { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }
    ], defaultBranch: 'main' } });
    if (url.pathname === '/api/projects/repo/switch-prs') return route.fulfill({ json: switchPrs });
    if (url.pathname === '/api/projects/repo/worktrees' && request.method() === 'POST') {
      onCreate(request.postDataJSON());
      return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the Repo Project's New worktree dialog from the launcher
async function openNewWorktree(page: import('@playwright/test').Page) {
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' }).click();
  return page.getByRole('dialog', { name: 'New worktree' });
}

test('creates a worktree for a new branch with the default base pre-filled', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // the manageable project offers New worktree…; the bridge-unmounted one has it disabled
  const manageable = launcher.getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' });
  await expect(manageable).toBeEnabled();
  const blocked = launcher.getByRole('group', { name: 'Mounted Elsewhere' }).getByRole('button', { name: 'New worktree…' });
  await expect(blocked).toBeDisabled();
  await expect(blocked).toHaveAttribute('title', /does not mount this project/u);

  await manageable.click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog).toBeVisible();
  // the base is a picker over every branch — the checked-out default included — pre-selected
  // to the resolved default branch
  const baseSelect = dialog.getByLabel('Base');
  await expect(baseSelect.locator('option')).toHaveText(['main', 'feature', 'hotfix (remote)']);
  await expect(baseSelect).toHaveValue('main');
  // a branch name is not a credential: password managers are told to leave the field alone
  const branchName = dialog.getByLabel('Branch name');
  await expect(branchName).toHaveAttribute('autocomplete', 'off');
  await expect(branchName).toHaveAttribute('data-1p-ignore', 'true');
  await branchName.fill('feature/login');
  // an Agent opens in the new worktree unless the operator chooses otherwise
  await expect(dialog.getByRole('radiogroup', { name: 'Open in the new worktree' }).getByRole('radio', { name: 'Agent' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'new', branch: 'feature/login', base: 'main', open: 'agent' });
  // the dialog closes once the worktree is created
  await expect(dialog).toBeHidden();
});

test('bases a new branch on a chosen branch, sending the ref that resolves it', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  const dialog = await openNewWorktree(page);

  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByLabel('Base').selectOption('origin/hotfix');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'new', branch: 'feature/login', base: 'origin/hotfix', open: 'agent' });
});

test('explains that setup is running while a create blocks on it', async ({ page }) => {
  await stub(page, () => {});
  // the create blocks on setup, so delay the response to observe the pending state
  await page.route('**/api/projects/repo/worktrees', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise(resolve => setTimeout(resolve, 500));
    return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login' } });
  });
  await page.goto('/');
  const dialog = await openNewWorktree(page);

  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();
  // while the blocking create runs, the dialog tells the operator setup is running
  await expect(dialog.getByText(/Running the setup command/u)).toBeVisible();
  // once it resolves, the dialog closes
  await expect(dialog).toBeHidden();
});

test('surfaces a setup failure returned alongside the created worktree', async ({ page }) => {
  await stub(page, () => {});
  await page.route('**/api/projects/repo/worktrees', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login', setupError: 'setup command exited with status 1' } });
  });
  await page.goto('/');
  const dialog = await openNewWorktree(page);

  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();
  // the worktree stands, but a banner reports that setup failed (so no agent started)
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Worktree created, setup failed')).toBeVisible();
  await expect(page.getByText('setup command exited with status 1')).toBeVisible();
});

test('checks out an existing branch, hiding checked-out ones and marking remote-only ones', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });

  await dialog.getByRole('tab', { name: 'Existing branch' }).click();
  const select = dialog.getByLabel('Branch', { exact: true });
  await expect(select.locator('option')).toHaveText(['feature', 'hotfix (remote)']);
  await select.selectOption('origin/hotfix');
  // open only a Terminal: the idle shell, no agent, focused as a Terminal panel
  const panes = `/api/worktrees/${encodeURIComponent('repo:/repo/wts/feature-login')}/panes`;
  await page.route(`**${panes}`, route => route.fulfill({ json: { panes: [{ paneId: '%9', session: '$3', role: 'shell', command: 'zsh', path: '/repo/wts/feature-login', title: 'zsh', agent: false }] } }));
  const panesListed = page.waitForRequest(request => new URL(request.url()).pathname === panes);
  await dialog.getByRole('radio', { name: 'Terminal' }).click();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'existing', branch: 'hotfix', open: 'terminal' });
  await panesListed;
  await expect(page.getByText('Worktree created', { exact: true })).toBeVisible();
  await expect(page.getByText('The new worktree is ready with a terminal.')).toBeVisible();
});

test('opens nothing, and remembers that choice for the Project', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  let dialog = await openNewWorktree(page);
  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByRole('radio', { name: 'Nothing' }).click();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'new', branch: 'feature/login', base: 'main', open: 'empty' });
  await expect(dialog).toBeHidden();
  await expect(page.getByText('The new worktree is ready; nothing was opened in it.')).toBeVisible();
  // the next New worktree for this Project starts from the last choice
  dialog = await openNewWorktree(page);
  await expect(dialog.getByRole('radio', { name: 'Nothing' })).toBeChecked();
});

test('names the Terminal when it fails to open', async ({ page }) => {
  await stub(page, () => {});
  await page.route('**/api/projects/repo/worktrees', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login', launchError: 'The worktree was created, but its shell could not be started.' } });
  });
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByRole('radio', { name: 'Terminal' }).click();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect(page.getByText('Worktree created, terminal did not open')).toBeVisible();
});

test('Review launches an agent, then opens the guided review start sheet for it', async ({ page }) => {
  let created: unknown;
  await stub(page, () => {});
  await page.route('**/api/projects/repo/worktrees', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login', agentId: 'agent-new' } });
  });
  // once created, the dashboard lists the new Agent with its PR base
  const agent = { id: 'agent-new', sessionId: 'socket:$9', home: '/repo/wts/feature', projectId: 'repo', worktreeId: 'repo:/repo/wts/feature', worktreeLabel: 'feature', branch: 'feature', title: 'Ready', gitPrStatus: { base: 'origin/main', files: 1 } };
  await page.route('**/api/dashboard', route => route.fulfill({ json: created === undefined ? dashboard : { ...dashboard, agents: [agent] } }));
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await dialog.getByRole('tab', { name: 'Existing branch' }).click();
  await dialog.getByRole('radio', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  // a guided review is bound to an agent, so Review asks the server for one
  await expect.poll(() => created).toEqual({ mode: 'existing', branch: 'feature', open: 'agent' });
  const sheet = page.getByRole('dialog', { name: 'Start guided review' });
  await expect(sheet).toBeVisible();
  // a PR worktree is reviewed against its base, not as working changes
  await expect(sheet.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
});

test('disables Review when guided review is unavailable', async ({ page }) => {
  await stub(page, () => {});
  await page.route('**/api/dashboard', route => route.fulfill({ json: { ...dashboard, reviewTour: undefined } }));
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await expect(dialog.getByRole('radio', { name: 'Review' })).toBeDisabled();
  await expect(dialog.getByTitle('Guided review unavailable on this server')).toHaveText('Review');
});

test('creates a worktree from a pull request chosen in the Pull request tab', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await dialog.getByRole('tab', { name: 'Pull request' }).click();

  // the operator's own PRs come first; others' fold below
  const own = dialog.getByRole('group', { name: '#12: Fix login redirect; Open' });
  await expect(own).toBeVisible();
  await expect(dialog.getByText('Pull requests by others')).toBeVisible();
  const choice = own.getByRole('radio', { name: 'Select #12' });
  await choice.check();
  await expect(choice).toBeChecked();
  await expect(own).toContainText('Selected');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  // the PR is named by number alone; the server resolves its branch
  await expect.poll(() => created).toEqual({ mode: 'pull-request', number: 12, open: 'agent' });
  await expect(dialog).toBeHidden();
});

test('offers a pull request another worktree holds only as a link to that worktree', async ({ page }) => {
  await stub(page, () => {});
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await dialog.getByRole('tab', { name: 'Pull request' }).click();

  const held = dialog.getByRole('group', { name: '#15: Dark mode; Open' });
  await expect(held.getByRole('radio')).toHaveCount(0);
  await held.getByRole('button', { name: 'Switch to Repo · dark-mode' }).click();
  // following the link leaves the dialog for that worktree
  await expect(dialog).toBeHidden();
});

test('hides the Pull request tab for a Project without a GitHub origin', async ({ page }) => {
  await stub(page, () => {});
  await page.route('**/api/projects/repo/switch-prs', route => route.fulfill({ json: { ...switchPrs, pullRequests: [], otherPullRequests: [], pullRequestsSupported: false } }));
  await page.goto('/');
  const listed = page.waitForResponse('**/api/projects/repo/switch-prs');
  const dialog = await openNewWorktree(page);
  await listed;
  await expect(dialog.getByRole('tab', { name: 'Existing branch' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Pull request' })).toHaveCount(0);
});

test('keeps the Pull request tab when the list fails to load, saying so', async ({ page }) => {
  await stub(page, () => {});
  await page.route('**/api/projects/repo/switch-prs', route => route.fulfill({ status: 502, json: { error: 'GitHub is unreachable' } }));
  await page.goto('/');
  const dialog = await openNewWorktree(page);
  await dialog.getByRole('tab', { name: 'Pull request' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not load pull requests.');
  await expect(dialog.getByRole('button', { name: 'Create worktree' })).toBeDisabled();
});
