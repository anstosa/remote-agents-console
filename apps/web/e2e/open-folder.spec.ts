import { expect, test, type Page } from '@playwright/test';
import { installFilesFixture } from './files-panel-fixture.js';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

type OpenRecord = { path: string; action: string; kind?: string; sandboxed?: boolean };

const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
const scratch = { id: 'scratch:/home/ubuntu', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: '/home/ubuntu', pinned: false };
const configured = { id: 'cora-main', projectId: 'cora', label: 'Cora', path: '/srv/cora', main: true, detached: false, locked: false, available: true, pinned: false, order: 0, branch: 'main', launch: { kind: 'codex', origin: 'project' } };
// the implicit Project an opened repository becomes, and the ad-hoc Place an opened plain folder becomes
const repo = { id: 'repo-0123abcd', projectId: 'repo-0123abcd', label: 'repo', path: '/home/ubuntu/repo', main: true, detached: false, locked: false, available: true, pinned: false, order: 0, branch: 'main' };
const notes = { id: 'scratch:/home/ubuntu/notes', kind: 'scratch', projectId: 'scratch', label: 'notes', home: '/home/ubuntu/notes', adhoc: true, pinned: false };

// stub a console whose dashboard gains the Place each successful open names
async function stubConsole(page: Page, { openStatus = 201, openError, needsOperator }: { openStatus?: number; openError?: string; needsOperator?: string } = {}) {
  const opens: OpenRecord[] = [];
  const forgotten: string[] = [];
  let recents = [{ path: '/home/ubuntu/repo', openedAt: '2026-10-22T10:00:00.000Z', kind: 'git' }, { path: '/home/ubuntu/notes', openedAt: '2026-10-21T10:00:00.000Z', kind: 'folder' }];
  let repoAgent = false;
  let repoPinned = false;
  let notesShells = 0;
  let notesPinned = false;
  let generation = 1;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Open folder test' } });
    if (url.pathname === '/api/dashboard') {
      const agents = repoAgent ? [{ id: 'agent-repo', sessionId: 'socket:$4', home: repo.path, placeId: repo.id, projectId: repo.projectId, worktreeId: repo.id, title: 'Ready', kind: 'codex', queuedPromptCount: 0 }] : [];
      const projects = [{ id: 'cora', label: 'Cora', available: true, worktrees: [configured] }, ...(repoAgent || repoPinned ? [{ id: repo.projectId, implicit: true, label: 'repo', available: true, worktrees: [{ ...repo, pinned: repoPinned }] }] : [])];
      const places = [scratch, ...(notesShells > 0 || notesPinned ? [{ ...notes, pinned: notesPinned, consoleShells: notesShells }] : [])];
      return route.fulfill({ json: { generation, adapters, agents, projects, places, scratchLaunch: { kind: 'codex', origin: 'default' } } });
    }
    if (url.pathname === '/api/folders/recent') return route.fulfill({ json: { folders: recents } });
    if (url.pathname === '/api/folders/forget') {
      forgotten.push(String(body?.path));
      recents = recents.filter(entry => entry.path !== body?.path);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/folders/open') {
      opens.push(body as OpenRecord);
      if (openStatus !== 201) return route.fulfill({ status: openStatus, json: { error: openError } });
      const path = String(body?.path);
      generation += 1;
      // a path inside the repository opens its Worktree
      if (path === repo.path || path.startsWith(`${repo.path}/`)) {
        if (body?.action === 'agent') repoAgent = true;
        if (body?.action === 'empty') repoPinned = true;
        return route.fulfill({ status: 201, json: { placeId: repo.id, ...(body?.action === 'agent' ? { agentId: 'agent-repo', ...(needsOperator === undefined ? {} : { needsOperator }) } : {}) } });
      }
      if (body?.action === 'terminal') notesShells = 1;
      if (body?.action === 'empty') notesPinned = true;
      return route.fulfill({ status: 201, json: { placeId: notes.id, ...(body?.action === 'terminal' ? { paneId: '%9' } : {}) } });
    }
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/worktrees\/[^/]+\/panes$/u.test(url.pathname)) return route.fulfill({ json: { panes: [] } });
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/agents\/agent-repo\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return { opens, forgotten };
}

// open the Other locations modal from the + flyout's Scratch row
async function openOtherLocations(page: Page) {
  await page.getByRole('button', { name: 'Launch agent', exact: true }).first().click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Other locations' }).click();
  return page.getByRole('dialog', { name: 'Other locations' });
}

test('the Scratch row opens Other locations, listing recent folders', async ({ page }) => {
  await stubConsole(page);
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  const recent = dialog.getByRole('list', { name: 'Recent folders' }).getByRole('listitem');
  await expect(recent).toHaveCount(2);
  await expect(recent.nth(0)).toContainText('repo');
  await expect(recent.nth(0)).toContainText('/home/ubuntu/repo');
  await expect(recent.nth(0).getByRole('img', { name: 'Git repository' })).toBeVisible();
  await expect(recent.nth(1).getByRole('img', { name: 'Folder' })).toBeVisible();
});

test('Enter in the path field opens the folder with an agent and switches to its tab', async ({ page }) => {
  const { opens } = await stubConsole(page);
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  await dialog.getByRole('textbox', { name: 'Folder path' }).fill('/home/ubuntu/repo/src');
  await dialog.getByRole('textbox', { name: 'Folder path' }).press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(opens).toEqual([{ path: '/home/ubuntu/repo/src', action: 'agent' }]);
  await expect(page.getByRole('tab', { name: /^repo — /u, selected: true })).toBeVisible();
});

test('a refused path shows its reason under the field and keeps the modal open', async ({ page }) => {
  await stubConsole(page, { openStatus: 400, openError: 'not a directory' });
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  const field = dialog.getByRole('textbox', { name: 'Folder path' });
  await field.fill('/home/ubuntu/file.txt');
  await field.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('not a directory');
  await expect(field).toHaveValue('/home/ubuntu/file.txt');
});

test('a recent folder opens a Terminal, or its empty Workspace, on its own tab', async ({ page }) => {
  const { opens } = await stubConsole(page);
  await page.goto('/');
  let dialog = await openOtherLocations(page);
  await dialog.getByRole('listitem').filter({ hasText: '/home/ubuntu/notes' }).getByRole('button', { name: 'Terminal' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^notes — /u, selected: true })).toBeVisible();

  dialog = await openOtherLocations(page);
  await dialog.getByRole('listitem').filter({ hasText: '/home/ubuntu/repo' }).getByRole('button', { name: 'Empty workspace' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^repo — /u, selected: true })).toBeVisible();
  expect(opens).toEqual([{ path: '/home/ubuntu/notes', action: 'terminal' }, { path: '/home/ubuntu/repo', action: 'empty' }]);
});

test('a recent folder launches the kind chosen from its launch split', async ({ page }) => {
  const { opens } = await stubConsole(page);
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  const entry = dialog.getByRole('listitem').filter({ hasText: '/home/ubuntu/repo' });
  await entry.getByRole('button', { name: 'More workspace actions' }).click();
  await page.getByRole('menu', { name: 'More workspace actions' }).getByRole('menuitem', { name: /^Codex/u }).click();
  await expect(page.getByRole('tab', { name: /^repo — /u, selected: true })).toBeVisible();
  expect(opens).toEqual([{ path: '/home/ubuntu/repo', action: 'agent', kind: 'codex', sandboxed: false }]);
});

test('Forget removes a folder from the recents', async ({ page }) => {
  const { forgotten } = await stubConsole(page);
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  await dialog.getByRole('button', { name: 'Forget notes' }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('listitem')).toContainText('/home/ubuntu/repo');
  expect(forgotten).toEqual(['/home/ubuntu/notes']);
});

test('the Other locations button sits in the Scratch row without making it taller', async ({ page }) => {
  await stubConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Launch agent', exact: true }).first().click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const rows = launcher.locator('.launcher-row');
  const scratchRow = rows.filter({ hasText: 'Scratch' });
  await expect(scratchRow.getByRole('button', { name: 'Other locations' })).toBeVisible();
  const [scratchBox, worktreeBox] = await Promise.all([scratchRow.boundingBox(), rows.filter({ hasNotText: 'Scratch' }).first().boundingBox()]);
  if (scratchBox === null || worktreeBox === null) throw new Error('launcher rows did not render');
  expect(scratchBox.height).toBeLessThanOrEqual(worktreeBox.height + 0.5);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
  test(`at ${viewport.width}px each recent fits its three actions on one line without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubConsole(page);
    await page.goto('/');
    const dialog = await openOtherLocations(page);
    await dialog.getByRole('textbox', { name: 'Folder path' }).fill('/home/ubuntu/a-rather-long-folder-name/that-keeps-going/and-going');
    const panel = dialog.locator(':scope > div');
    expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    for (const entry of await dialog.getByRole('group', { name: /^Open / }).all()) {
      const boxes = await Promise.all([entry.getByRole('group', { name: 'Launch agent' }), entry.getByRole('button', { name: 'Terminal' }), entry.getByRole('button', { name: 'Empty workspace' })].map(control => control.boundingBox()));
      if (boxes.some(box => box === null)) throw new Error('a folder action did not render');
      const centers = boxes.map(box => box!.y + box!.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      const viewportWidth = page.viewportSize()!.width;
      for (const box of boxes) expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
    }
  });
}

test('a Files panel folder opens Other locations with its path filled in', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  const sub = { id: 'scratch:/home/ubuntu/project/sub', kind: 'scratch', projectId: 'scratch', label: 'sub', home: '/home/ubuntu/project/sub', adhoc: true, pinned: false, consoleShells: 1 };
  const opens: OpenRecord[] = [];
  await page.route('**/api/{dashboard,folders/**}', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/folders/recent') return route.fulfill({ json: { folders: [] } });
    if (url.pathname === '/api/folders/open') {
      opens.push(route.request().postDataJSON() as OpenRecord);
      return route.fulfill({ status: 201, json: { placeId: sub.id, paneId: '%9' } });
    }
    return route.fulfill({ json: { generation: opens.length + 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/home/ubuntu/project', placeId: 'cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'main', queuedPromptCount: 0 }], projects: [], places: opens.length > 0 ? [sub] : [] } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await panel.locator('.files-row').filter({ hasText: 'sub' }).getByRole('button', { name: 'Actions for sub' }).click();
  await page.getByRole('menu', { name: 'Actions for sub' }).getByRole('menuitem', { name: 'Open as Workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Other locations' });
  await expect(dialog.getByRole('textbox', { name: 'Folder path' })).toHaveValue('/home/ubuntu/project/sub');
  await dialog.getByRole('group', { name: 'Open sub' }).getByRole('button', { name: 'Terminal' }).click();
  await expect(page.getByRole('tab', { name: /^sub — /u, selected: true })).toBeVisible();
  expect(opens).toEqual([{ path: '/home/ubuntu/project/sub', action: 'terminal' }]);
});

test('an agent stopped on its first screen is reported as waiting for the operator', async ({ page }) => {
  await stubConsole(page, { needsOperator: 'Claude is asking whether to trust this folder' });
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  await dialog.getByRole('group', { name: 'Open repo' }).getByRole('button', { name: 'Launch repo' }).click();
  await expect(page.getByRole('tab', { name: /^repo — /u, selected: true })).toBeVisible();
  await expect(page.getByText('repo is waiting for you')).toBeVisible();
  await expect(page.getByText('Claude is asking whether to trust this folder')).toBeVisible();
});

test('Escape closes an open launch menu before the modal', async ({ page }) => {
  await stubConsole(page);
  await page.goto('/');
  const dialog = await openOtherLocations(page);
  await dialog.getByRole('group', { name: 'Open repo' }).getByRole('button', { name: 'More workspace actions' }).click();
  const menu = page.getByRole('menu', { name: 'More workspace actions' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
