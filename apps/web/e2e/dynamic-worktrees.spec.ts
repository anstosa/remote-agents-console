import { expect, test } from '@playwright/test';

// build one launcher worktree fixture
const worktree = (id: string, projectId: string, label: string, main: boolean) => ({ id, projectId, label, path: `/worktrees/${id}`, main, detached: false, locked: false, available: true, pinned: false, order: main ? 0 : 1, branch: main ? 'main' : 'feature/second', launch: { kind: 'codex', origin: 'project' } });

// stub one single-worktree and one multi-worktree project
async function stubDynamicWorktrees(page: import('@playwright/test').Page, soloStale = false) {
  const solo = worktree('solo-main', 'solo', 'Solo main', true);
  const multiMain = worktree('multi-main', 'multi', 'Multi main', true);
  const multiSecond = worktree('multi-second', 'multi', 'Multi second', false);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // return one controlled browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // return the launcher projects
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: 'agent-solo', sessionId: 'socket:$1', home: solo.path, worktreeId: solo.id, worktreeLabel: solo.label, title: 'Ready', kind: 'codex' }], projects: [{ id: 'solo', label: 'Solo', available: true, manageWorktrees: true, worktrees: [solo], ...(soloStale ? { stalePaths: ['/worktrees/stale'] } : {}) }, { id: 'multi', label: 'Multi', available: true, manageWorktrees: true, worktrees: [multiMain, multiSecond] }] } });
    // return agent bootstrap data
    if (url.pathname === '/api/agents/agent-solo/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty agent collections
    if (url.pathname === '/api/agents/agent-solo/saved-prompts' || url.pathname === '/api/agents/agent-solo/queued-prompts' || url.pathname === '/api/agents/agent-solo/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // return no agent commands
    if (url.pathname === '/api/agents/agent-solo/commands') return route.fulfill({ json: { commands: [] } });
    // return no notes
    if (url.pathname === '/api/worktrees/solo-main/notes') return route.fulfill({ json: { notes: [] } });
    // return an empty version comparison
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // return the deployed revision
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: 'a1b2c3d4e5f6789012345678901234567890abcd', committedAt: '2026-09-06T14:22:31-07:00' } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// open the projects settings page at either responsive breakpoint
async function openProjectsSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Global settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const selector = settings.getByRole('combobox', { name: 'Settings section', exact: true });
  // use the compact section picker on narrow viewports
  if (await selector.isVisible()) {
    await selector.click();
    await page.getByRole('listbox', { name: 'Settings section options', exact: true }).locator('[role="option"][data-value="projects"]').click();
  } else {
    await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Projects', exact: true }).click();
  }
  return settings;
}

// persist density changes and compact only single-worktree projects
test('dynamic worktrees defaults on and compacts single-worktree projects when disabled', async ({ page }) => {
  await stubDynamicWorktrees(page);
  await page.goto('/');

  const settings = await openProjectsSettings(page);
  const dynamicWorktrees = settings.getByRole('switch', { name: 'Dynamic worktrees' });
  await expect(dynamicWorktrees).toBeChecked();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  let launcher = page.getByRole('group', { name: 'Agent launcher' });
  const expandedSoloProject = launcher.getByRole('group', { name: 'Solo', exact: true });
  await expect(expandedSoloProject.getByRole('button', { name: 'New worktree…' })).toBeVisible();
  await expect(expandedSoloProject.getByRole('group', { name: 'Solo worktree controls' })).toHaveCount(0);
  await expect(expandedSoloProject.getByRole('button', { name: 'Open Solo main' })).toBeVisible();
  await page.keyboard.press('Escape');

  await openProjectsSettings(page);
  await dynamicWorktrees.uncheck();
  await expect(dynamicWorktrees).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('rac.dynamic-worktrees'))).toBeNull();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('rac.dynamic-worktrees'))).toBe('disabled');
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await page.getByRole('button', { name: 'Launch agent', exact: true }).click();
  launcher = page.getByRole('group', { name: 'Agent launcher' });
  await expect(launcher.getByRole('button', { name: 'New worktree…' })).toHaveCount(0);
  const soloProject = launcher.getByRole('group', { name: 'Solo', exact: true });
  const soloHeader = soloProject.locator('.launcher-project-header');
  const soloControls = soloHeader.getByRole('group', { name: 'Solo worktree controls' });
  await expect(soloControls.getByRole('button', { name: 'Open Solo main' })).toBeVisible();
  await expect(soloControls.getByRole('button', { name: 'Pin Solo main' })).toBeVisible();
  await expect(soloControls.getByRole('button', { name: 'Rename Solo main' })).toBeVisible();
  await expect(soloControls.getByRole('button', { name: 'Remove Solo main' })).toBeVisible();
  // Open is the default of the same split control Launch uses, so the two line up
  const [nameBounds, openBounds] = await Promise.all([soloHeader.locator(':scope > span').boundingBox(), soloControls.getByRole('group', { name: 'Launch agent' }).boundingBox()]);
  // require rendered inline controls
  if (nameBounds === null || openBounds === null) throw new Error('inline worktree controls did not render');
  expect(Math.abs(nameBounds.y + nameBounds.height / 2 - (openBounds.y + openBounds.height / 2))).toBeLessThanOrEqual(1);
  const multiProject = launcher.getByRole('group', { name: 'Multi', exact: true });
  const multiLaunches = multiProject.getByRole('group', { name: 'Launch agent' });
  await expect(multiProject.getByRole('button', { name: 'Pin Multi main' })).toBeVisible();
  await expect(multiProject.getByRole('button', { name: 'Pin Multi second' })).toBeVisible();
  await expect(multiLaunches).toHaveCount(2);
  const [launchBounds, soloPinBounds, multiPinBounds] = await Promise.all([multiLaunches.first().boundingBox(), soloControls.getByRole('button', { name: 'Pin Solo main' }).boundingBox(), multiProject.getByRole('button', { name: 'Pin Multi main' }).boundingBox()]);
  // keep action widths and adjacent icon columns aligned
  if (launchBounds === null || soloPinBounds === null || multiPinBounds === null) throw new Error('launcher controls did not render');
  expect(Math.abs(openBounds.width - launchBounds.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(soloPinBounds.x - multiPinBounds.x)).toBeLessThanOrEqual(1);

  await page.reload();
  await openProjectsSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('switch', { name: 'Dynamic worktrees' })).not.toBeChecked();
});

// keep compact stale projects inside a narrow launcher
test('a stale single-worktree project stays contained when compacted', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await stubDynamicWorktrees(page, true);
  await page.goto('/');

  const settings = await openProjectsSettings(page);
  await settings.getByRole('switch', { name: 'Dynamic worktrees' }).uncheck();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();

  const soloProject = page.getByRole('group', { name: 'Agent launcher' }).getByRole('group', { name: 'Solo', exact: true });
  const soloHeader = soloProject.locator('.launcher-project-header');
  const soloControls = soloHeader.getByRole('group', { name: 'Solo worktree controls' });
  await expect(soloControls.getByRole('button', { name: 'Open Solo main' })).toBeVisible();
  await expect(soloHeader.getByRole('button', { name: '1 stale · Prune' })).toBeVisible();
  const overflow = await soloHeader.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
