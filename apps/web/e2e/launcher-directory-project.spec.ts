import { expect, test, type Page, type Route } from '@playwright/test';

// A non-git `directory` Project (config `projects[]` pointing at a path that is not a git
// checkout) has no worktrees, so the launcher renders a Project-level Launch button in place
// of worktree rows, keeps "New worktree…" disabled with its reason, and launches through
// POST /api/projects/:id/launch — the same in-place spawn Scratch uses.
// publish the current tmux capability contract
const codexTransport = { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false };
const codex = { ...codexTransport, transport: 'tmux', transports: { tmux: codexTransport } };
const noWorktreesReason = 'this project is not a git repository, so it has no worktrees to manage';

type LaunchPost = { path: string; body: unknown };

// Mount the app against a stubbed dashboard, recording every project launch POST body.
async function mount(page: Page, dashboard: Record<string, unknown>): Promise<LaunchPost[]> {
  const posts: LaunchPost[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (request.method() === 'POST' && /^\/api\/projects\/[^/]+\/launch$/u.test(url.pathname)) {
      posts.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { agentId: 'agent-directory' } });
    }
    if (request.method() === 'GET') return route.fulfill({ json: {} });
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  return posts;
}

const directoryProject = () => ({ id: 'notes', label: 'Notes', mode: 'directory', available: true, manageWorktrees: false, manageWorktreesReason: noWorktreesReason, stalePaths: [], worktrees: [], launch: { kind: 'codex', origin: 'project' } });

// retain scratch alongside the project-level launch target
test('a non-git directory Project offers an in-place Launch and keeps New worktree… disabled', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [directoryProject()] });

  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // the Project section shows its label and a Project-level Launch row (its single launch target)
  await expect(launcher.locator('.launcher-project-header > span')).toHaveText('Notes');
  await expect(launcher.locator('.launcher-row-label')).toHaveText(['Scratch', 'Notes']);

  // "New worktree…" stays disabled, explaining there are no worktrees to manage
  const newWorktree = launcher.getByRole('button', { name: 'New worktree…' });
  await expect(newWorktree).toBeDisabled();
  await expect(newWorktree).toHaveAttribute('title', noWorktreesReason);

  // the Project-level Launch button launches the resolved kind in place, in one click
  const projectRow = launcher.locator('.launcher-project .launcher-row').last();
  await projectRow.getByRole('button', { name: 'Launch Notes' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/projects/notes/launch', body: { kind: 'codex', sandboxed: false } }]);
});

// Terminal from + at a directory Project and at Scratch: the Place's Workspace opens with its
// Terminal focused, creating a Console shell only where the Place has none.
test('Terminal from + works at a directory Project and at Scratch, creating a shell only where none exists', async ({ page }) => {
  const shells: Record<string, string[]> = { 'notes:/data/notes': [], 'scratch:/home/me/scratch': ['%4'] };
  const created: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex }, agents: [], projects: [directoryProject()], scratchLaunch: { kind: 'codex', origin: 'scratch' }, places: [
      { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: false, consoleShells: shells['notes:/data/notes']!.length },
      { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch', pinned: false, consoleShells: shells['scratch:/home/me/scratch']!.length }
    ] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    const match = /^\/api\/worktrees\/([^/]+)\/(panes|shells|notes)$/u.exec(path);
    const id = match === null ? undefined : decodeURIComponent(match[1]!);
    if (match?.[2] === 'panes') return route.fulfill({ json: { panes: (shells[id!] ?? []).map(paneId => ({ paneId, session: '$7', window: `@${paneId.slice(1)}`, role: 'shell', command: 'zsh', path: '/data', title: '', agent: false, busy: false })) } });
    if (match?.[2] === 'shells' && request.method() === 'POST') {
      created.push(id!);
      shells[id!]!.push('%9');
      return route.fulfill({ status: 201, json: { paneId: '%9' } });
    }
    if (match?.[2] === 'notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  // Scratch already holds a shell, so it has a tab; the directory Project has none yet
  await expect(page.getByRole('tab')).toHaveCount(1);

  const terminalFrom = async (row: string) => {
    await page.locator('.new-agent-tab').click();
    const launcher = page.getByRole('group', { name: 'Agent launcher' });
    await launcher.locator('.launcher-row').filter({ hasText: row }).getByRole('button', { name: 'More workspace actions' }).click();
    await page.locator('.launch-menu').getByRole('menuitem', { name: /^Terminal/u }).click();
  };

  await terminalFrom('Notes');
  await expect(page.getByRole('tab', { name: /^Notes —/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toHaveClass(/\bfocused\b/u);
  expect(created).toEqual(['notes:/data/notes']);

  await terminalFrom('Scratch');
  await expect(page.getByRole('tab', { name: /^~ Scratch —/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-pane[data-panel-key="%4"]')).toHaveClass(/\bfocused\b/u);
  expect(created).toEqual(['notes:/data/notes']);
});

// Empty workspace from + at a directory Project names the folder and offers Pin
test('Empty workspace from + at a directory Project shows its path and warns until something runs there', async ({ page }) => {
  await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [directoryProject()], places: [{ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: false }] });
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.locator('.launcher-row').filter({ hasText: 'Notes' }).getByRole('button', { name: 'More workspace actions' }).click();
  await page.locator('.launch-menu').getByRole('menuitem', { name: /^Empty workspace/u }).click();
  await expect(page.getByRole('tab', { name: /^Notes —/u })).toHaveAttribute('aria-selected', 'true');
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  await expect(empty).toContainText('/data/notes');
  await expect(empty.getByRole('button', { name: 'Launch Notes' })).toBeVisible();
  // a Place without git has no Code panel
  await expect(empty.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
  await expect(empty).toContainText('closes when you switch away');
  await expect(empty.getByRole('button', { name: 'Pin it' })).toBeVisible();
});

// a directory-Project row whose Place has an Agent opens it rather than launching another
test('a directory-Project row with an Agent at its Place offers Open', async ({ page }) => {
  const agent = { id: 'agent-notes', sessionId: 'socket:$3', home: '/data/notes', placeId: 'notes:/data/notes', title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 };
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [agent], projects: [directoryProject()], places: [{ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: false }] });
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.locator('.launcher-row').filter({ hasText: 'Notes' }).getByRole('button', { name: 'Open Notes' }).click();
  await expect(launcher).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Notes —/u })).toHaveAttribute('aria-selected', 'true');
  expect(posts).toEqual([]);
});
