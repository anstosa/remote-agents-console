import { expect, test } from '@playwright/test';
import { expectProgressBorder } from './progress-border-assertions';

// the projects[] wire: the "+" launcher groups idle Worktrees under one section per Project
// — a header, one row per Worktree (name, Pin, Rename, Remove, Launch), then New worktree…
// — and each row's Pin toggle POSTs to /api/worktrees/:id/pin
test('launcher lists per-project sections and pins a worktree', async ({ page }) => {
  const pins: Array<{ id: string; pinned: boolean }> = [];
  const labels: Array<{ id: string; label: string | null }> = [];
  let worktreeLabel = '🥔 Dave';
  let delayRenamedDashboard = false;
  let releaseLabelRequest = () => {};
  const labelRequestGate = new Promise<void>(resolve => { releaseLabelRequest = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      // hold reconciliation so the saved label must update optimistically
      if (delayRenamedDashboard) {
        delayRenamedDashboard = false;
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
        { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
        { id: 'repo:/repo/feature', projectId: 'repo', label: worktreeLabel, path: '/repo/feature', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feature' }
      ] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    const pinMatch = /^\/api\/worktrees\/([^/]+)\/pin$/u.exec(url.pathname);
    if (pinMatch && request.method() === 'POST') {
      pins.push({ id: decodeURIComponent(pinMatch[1]), pinned: (request.postDataJSON() as { pinned: boolean }).pinned });
      return route.fulfill({ status: 204 });
    }
    const labelMatch = /^\/api\/worktrees\/([^/]+)\/label$/u.exec(url.pathname);
    // capture custom-label mutations
    if (labelMatch && request.method() === 'PATCH') {
      const label = (request.postDataJSON() as { label: string | null }).label;
      labels.push({ id: decodeURIComponent(labelMatch[1]), label });
      worktreeLabel = label ?? 'Repo · feature';
      delayRenamedDashboard = true;
      // expose the pending save treatment until the test inspects it
      await labelRequestGate;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // the main Worktree is pinned, so it already has a tab
  await expect(page.getByRole('tab', { name: /^Repo —/u })).toBeVisible();
  // open the launcher and confirm the per-project section lists both idle Worktrees
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const projectLabel = launcher.locator('.launcher-project-header > span');
  await expect(projectLabel).toHaveText('Repo');
  // match Project typography to Worktree names while retaining the purple hierarchy
  const projectStyle = await projectLabel.evaluate(element => {
    const project = element.closest('.launcher-project');
    const header = element.closest('.launcher-project-header');
    const worktree = project?.querySelector('.launcher-row-label');
    const worktreeRow = project?.querySelector('.launcher-row');
    const palette = document.createElement('span');
    palette.style.color = 'var(--mauve)';
    document.body.append(palette);
    const style = { fontSize: getComputedStyle(element).fontSize, worktreeFontSize: worktree === null || worktree === undefined ? undefined : getComputedStyle(worktree).fontSize, height: header?.getBoundingClientRect().height, worktreeHeight: worktreeRow?.getBoundingClientRect().height, color: getComputedStyle(element).color, purple: getComputedStyle(palette).color };
    palette.remove();
    return style;
  });
  expect(projectStyle.fontSize).toBe(projectStyle.worktreeFontSize);
  // compact project headers remain readable beside their larger launch rows
  expect(projectStyle.height).toBeGreaterThan(30);
  expect(projectStyle.color).toBe(projectStyle.purple);
  // rows sit under that header, so Main uses its branch while a custom linked name stays exact
  await expect(launcher.locator('.launcher-row-label')).toHaveText(['Scratch', 'main', '🥔 Dave']);
  // New worktree… closes the section, below the last row
  await expect(launcher.locator('.launcher-project > :last-child')).toHaveClass(/launcher-new-worktree/u);
  // the pinned Main worktree offers an Unpin toggle; the idle feature offers a Pin toggle.
  // Both are icon-only, so the accessible name and the tooltip carry the wording
  const pin = launcher.getByRole('button', { name: 'Pin 🥔 Dave' });
  const unpin = launcher.getByRole('button', { name: 'Unpin Repo', exact: true });
  const rename = launcher.getByRole('button', { name: 'Rename 🥔 Dave' });
  await expect(unpin).toBeVisible();
  await expect(pin).toHaveText('');
  await expect(pin).toHaveAttribute('title', 'Pin worktree');
  await expect(pin.locator('path')).toHaveAttribute('d', 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 15v5');
  await expect(rename.locator('path')).toHaveAttribute('d', 'm4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3');
  // inspect the rendered icon paint
  const pinPaint = await pin.evaluate(element => { const button = getComputedStyle(element); const icon = getComputedStyle(element.querySelector('svg')!); return { background: button.backgroundColor, border: button.borderColor, color: icon.color, fill: icon.fill, stroke: icon.stroke }; });
  expect(pinPaint.background).toBe('rgba(0, 0, 0, 0)');
  expect(pinPaint.border).toBe('rgba(0, 0, 0, 0)');
  expect(pinPaint.fill).toBe('none');
  expect(pinPaint.stroke).toBe(pinPaint.color);
  // the toggle reads pressed or not without being hovered: `pinned` is the filled state
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  await expect(unpin).toHaveClass(/\bpinned\b/u);
  await expect(pin).not.toHaveClass(/\bpinned\b/u);
  await pin.click();
  await expect.poll(() => pins).toContainEqual({ id: 'repo:/repo/feature', pinned: true });
  // custom names can be changed without editing the Project config
  await rename.click();
  const dialog = page.getByRole('dialog', { name: 'Rename worktree' });
  await expect(dialog.getByRole('textbox', { name: 'Worktree name' })).toHaveValue('🥔 Dave');
  await dialog.getByRole('textbox', { name: 'Worktree name' }).fill('🥔 David');
  const save = dialog.locator('button[type="submit"]');
  await expect(save).toHaveText('Save');
  await save.click();
  await expect(save).toHaveText('Saving…');
  await expectProgressBorder(save, 'blue');
  releaseLabelRequest();
  await expect.poll(() => labels).toContainEqual({ id: 'repo:/repo/feature', label: '🥔 David' });
  // the dialog and visible row update without waiting for dashboard polling
  await expect(dialog).toHaveCount(0, { timeout: 500 });
  await expect(launcher.locator('.launcher-row-label').nth(2)).toHaveText('🥔 David', { timeout: 500 });
});

test('launcher keeps a worktree visible while its agent is already open', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/home/ubuntu/remoteagents', projectId: 'remoteagents', worktreeId: 'remoteagents:/workspace', title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 }],
      projects: [{ id: 'remoteagents', label: '📱 Remote Agents', available: true, worktrees: [{ id: 'remoteagents:/workspace', projectId: 'remoteagents', label: '📱 Remote Agents', customLabel: true, path: '/workspace', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }] }]
    } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const project = launcher.getByRole('group', { name: '📱 Remote Agents' });
  // the active Main worktree stays listed and opens its existing agent
  await expect(project.locator('.launcher-row-label')).toHaveText('📱 Remote Agents');
  const open = project.getByRole('button', { name: 'Open 📱 Remote Agents' });
  await expect(open).toBeVisible();
  await open.click();
  await expect(launcher).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^📱 Remote Agents —/u })).toHaveAttribute('aria-selected', 'true');
});

// A dashboard of one Project with a pinned Main and an idle `feature` Worktree, whose Console
// shells, pins and running Agent a test can change; the panes and shells routes of every
// Worktree answer from the same state, so a New shell is seen through a real refresh.
type Shell = { paneId: string; name: string };
async function mountWorkspaces(page: import('@playwright/test').Page, options: { shells?: Record<string, Shell[]>; agentAt?: string } = {}) {
  const shells: Record<string, Shell[]> = { 'repo:/repo': [], 'repo:/repo/feature': [], ...options.shells };
  const pinned = new Set(['repo:/repo']);
  const created: string[] = [];
  const pins: Array<{ id: string; pinned: boolean }> = [];
  let nextPane = 9;
  const worktree = (id: string, label: string, path: string, order: number, branch: string) => ({ id, projectId: 'repo', label, path, main: order === 0, detached: false, locked: false, available: true, pinned: pinned.has(id), order, branch, consoleShells: shells[id]!.length, launch: { kind: 'codex', origin: 'worktree' } });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      adapters: { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } },
      agents: options.agentAt === undefined ? [] : [{ id: 'agent-1', sessionId: 'socket:$1', home: '/repo/feature', projectId: 'repo', worktreeId: options.agentAt, placeId: options.agentAt, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 }],
      projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [worktree('repo:/repo', 'Repo', '/repo', 0, 'main'), worktree('repo:/repo/feature', 'Feature', '/repo/feature', 1, 'feature')] }]
    } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    const match = /^\/api\/worktrees\/([^/]+)\/(panes|shells|pin|notes)$/u.exec(path);
    const id = match === null ? undefined : decodeURIComponent(match[1]!);
    // as the real route does, the Agent's own pane and a hand-made landing shell come before the Console shells
    const others = id === options.agentAt ? [{ paneId: '%1', session: '$7', window: '@0', command: 'codex', path: '/repo/feature', title: '', agent: true }, { paneId: '%2', session: '$7', window: '@0', command: 'zsh', path: '/repo/feature', title: '', agent: false }] : [];
    if (match?.[2] === 'panes' && request.method() === 'GET') return route.fulfill({ json: { panes: [...others, ...(shells[id!] ?? []).map(shell => ({ paneId: shell.paneId, session: '$7', window: `@${shell.paneId.slice(1)}`, role: 'shell', name: shell.name, command: 'zsh', path: '/repo', title: '', agent: false, busy: false }))] } });
    if (match?.[2] === 'shells' && request.method() === 'POST') {
      created.push(id!);
      const shell = { paneId: `%${nextPane++}`, name: 'shell' };
      shells[id!]!.push(shell);
      return route.fulfill({ status: 201, json: { paneId: shell.paneId } });
    }
    if (match?.[2] === 'pin' && request.method() === 'POST') {
      const body = request.postDataJSON() as { pinned: boolean };
      pins.push({ id: id!, pinned: body.pinned });
      if (body.pinned) pinned.add(id!); else pinned.delete(id!);
      return route.fulfill({ status: 204 });
    }
    if (match?.[2] === 'notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { created, pins };
}

// open one + row's dropdown (its chevron), check it, and choose an entry
const chooseFromRow = async (page: import('@playwright/test').Page, row: string, entry: 'Terminal' | 'Empty workspace', check?: (menu: import('@playwright/test').Locator, row: import('@playwright/test').Locator) => Promise<void>) => {
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const rowLocator = launcher.locator('.launcher-row, .launcher-project-worktree-controls').filter({ hasText: row }).first();
  await rowLocator.getByRole('button', { name: 'More workspace actions' }).click();
  const menu = page.locator('.launch-menu');
  await check?.(menu, rowLocator);
  await menu.getByRole('menuitem', { name: new RegExp(`^${entry}`, 'u') }).click();
  await expect(launcher).toHaveCount(0);
};

test('Terminal from + opens an idle Worktree with a new shell, focused, and never a second one', async ({ page }) => {
  const { created } = await mountWorkspaces(page);
  // the row keeps direct Launch while workspace actions follow agent choices
  await chooseFromRow(page, 'Feature', 'Terminal', async (menu, row) => {
    await expect(row.getByRole('button', { name: 'Launch Feature' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^(Terminal|Empty workspace)/u })).toHaveText([/^Terminal/u, /^Empty workspace/u]);
    await expect(menu.getByRole('menuitem', { name: /^Terminal/u })).toContainText('Open the Workspace with a new shell');
  });
  // the Place's tab opens with the new shell as a focused Terminal panel
  await expect(page.getByRole('tab', { name: /^Feature —/u })).toHaveAttribute('aria-selected', 'true');
  const terminal = page.locator('.terminal-pane[data-panel-key="%9"]');
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveClass(/\bfocused\b/u);
  expect(created).toEqual(['repo:/repo/feature']);

  // the shell keeps the Workspace after leaving it, and a second Terminal from + focuses that
  // shell instead of creating another
  await page.getByRole('tab', { name: /^Repo —/u }).click();
  await expect(page.getByRole('tab', { name: /^Feature —/u })).toBeVisible();
  await chooseFromRow(page, 'Feature', 'Terminal', async menu => {
    await expect(menu.getByRole('menuitem', { name: /^Terminal/u })).toContainText('Focus its shell');
  });
  await expect(page.getByRole('tab', { name: /^Feature —/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  await expect(terminal).toHaveClass(/\bfocused\b/u);
  expect(created).toEqual(['repo:/repo/feature']);
});

test('Terminal from + at a Worktree with an Agent opens its minimized shell without creating one', async ({ page }) => {
  const { created } = await mountWorkspaces(page, { agentAt: 'repo:/repo/feature', shells: { 'repo:/repo/feature': [{ paneId: '%5', name: 'build' }] } });
  // a row with a running Agent keeps Open as its default, beside the same dropdown
  await chooseFromRow(page, 'Feature', 'Terminal', async (menu, row) => {
    await expect(row.getByRole('button', { name: 'Open Feature' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^(Terminal|Empty workspace)/u })).toHaveText([/^Terminal/u, /^Empty workspace/u]);
  });
  await expect(page.getByRole('tab', { name: /^Feature —/u })).toHaveAttribute('aria-selected', 'true');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveClass(/\bfocused\b/u);
  expect(created).toEqual([]);
});

test('Empty workspace opens a panel-less Workspace that closes when left, unless pinned', async ({ page }) => {
  const { pins } = await mountWorkspaces(page);
  await expect(page.getByRole('tab')).toHaveCount(1);
  // the pinned Main Workspace is empty, but pinned, so it does not warn
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).not.toContainText('closes when you switch away');

  await chooseFromRow(page, 'Feature', 'Empty workspace');
  const tab = page.getByRole('tab', { name: /^Feature —/u });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  // the body repeats the toolbar's controls and warns the Workspace is transient
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  await expect(empty).toContainText('Feature');
  await expect(empty).toContainText('/repo/feature');
  await expect(empty.getByRole('button', { name: 'Launch Feature' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  // this Worktree has no project URL, so there is no Browser button to repeat
  await expect(empty.getByRole('button', { name: 'Browser' })).toHaveCount(0);
  await expect(empty.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(empty).toContainText('closes when you switch away');
  await expect(page.locator('.terminal-pane, .note-pane')).toHaveCount(0);
  // its Notes opens the Place's notes menu
  await empty.getByRole('button', { name: 'Notes' }).click();
  await expect(page.locator('.notes-menu')).toBeVisible();
  await page.locator('.flyout-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.notes-menu')).toHaveCount(0);

  // leaving it closes it
  await page.getByRole('tab', { name: /^Repo —/u }).click();
  await expect(tab).toHaveCount(0);

  // an existing Workspace is focused as it is, its panels kept
  await chooseFromRow(page, 'main', 'Terminal');
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  // from another Workspace, so Main's remounts from what this device remembers of it
  await chooseFromRow(page, 'Feature', 'Empty workspace');
  await chooseFromRow(page, 'main', 'Empty workspace');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^Repo —/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-pane')).toHaveCount(1);

  // Pin keeps it after leaving
  await chooseFromRow(page, 'Feature', 'Empty workspace');
  await page.getByRole('region', { name: 'Empty workspace' }).getByRole('button', { name: 'Pin it' }).click();
  await expect.poll(() => pins).toEqual([{ id: 'repo:/repo/feature', pinned: true }]);
  await expect(page.getByRole('region', { name: 'Empty workspace' })).not.toContainText('closes when you switch away');
  await page.getByRole('tab', { name: /^Repo —/u }).click();
  await expect(tab).toBeVisible();
});
