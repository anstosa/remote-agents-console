import { expect, test } from '@playwright/test';

// A Worktree carries a Console-shell count (`consoleShells`) on its dashboard row. The launcher
// row shows it, the Remove control is refused with a reason while shells are open, and an idle
// (agentless, unpinned) Worktree keeps its tab as long as the count is above zero — so stopping
// the Agent never hides the operator's terminals. (First-class terminal panes, Console shells.)
test('shows the Console-shell count, blocks Remove, and retains an agentless tab', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
        { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
        // an idle, unpinned Worktree with open Console shells — no draft
        { id: 'repo:/repo/feature', projectId: 'repo', label: 'Feature', path: '/repo/feature', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feature', consoleShells: 2 }
      ] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');

  // the agentless Worktree keeps a tab purely because it has open Console shells
  await expect(page.getByRole('tab', { name: /Feature/u })).toBeVisible();

  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const featureRow = launcher.locator('.launcher-row', { hasText: 'Feature' });

  // the row shows the open-terminal count
  await expect(featureRow.locator('.launcher-shells')).toHaveText('2');
  await expect(featureRow.locator('.launcher-shells')).toHaveAttribute('aria-label', '2 open terminals');

  // Remove is refused with the reason while shells are open
  const remove = featureRow.locator('.launcher-remove');
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute('title', 'End the open terminals before removing this worktree');
});

// A directory-Project or Scratch Place carries its Console-shell count and Pinned flag in
// `places[]`. The launcher's Project-level and Scratch rows show the count and a pin toggle that
// pins through the Place's pin route, and a Place with a Console shell or a pin keeps an
// agentless tab with no Agent running there.
test('a directory-Project and a Scratch Place show their shell count and pin, and keep agentless tabs', async ({ page }) => {
  const pins: { path: string; body: unknown }[] = [];
  const launches: string[] = [];
  // pins the dashboard reports back, so a pin toggle is seen through a real refresh
  const pinned = new Set(['scratch:/srv/tools']);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'notes', label: 'Notes', mode: 'directory', available: true, manageWorktrees: false, stalePaths: [], worktrees: [], launch: { kind: 'codex', origin: 'project' } }], adapters: { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, scratchLaunch: { kind: 'codex', origin: 'scratch' }, places: [
        { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: pinned.has('notes:/data/notes'), consoleShells: 2 },
        { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch', pinned: pinned.has('scratch:/home/me/scratch') },
        // a pinned ad-hoc folder with nothing running keeps its tab too
        { id: 'scratch:/srv/tools', kind: 'scratch', projectId: 'scratch', label: 'tools', home: '/srv/tools', adhoc: true, pinned: pinned.has('scratch:/srv/tools') }
      ] } });
    }
    if (request.method() === 'POST' && url.pathname === '/api/projects/notes/launch') {
      launches.push(url.pathname);
      return route.fulfill({ status: 409, json: { error: 'not launched in this test' } });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/pin')) {
      const body = request.postDataJSON() as { pinned: boolean };
      pins.push({ path: url.pathname, body });
      const id = decodeURIComponent(url.pathname.split('/')[3]!);
      if (body.pinned) pinned.add(id); else pinned.delete(id);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (request.method() === 'GET' && url.pathname.endsWith('/notes')) return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');

  // the directory Project keeps a tab for its Console shells, the ad-hoc folder for its pin;
  // the empty, unpinned Scratch folder has none
  await expect(page.getByRole('tab', { name: /^Notes/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^tools/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Scratch/u })).toHaveCount(0);

  // the directory Place's toolbar offers its pin (in the ⋮) and launches its Project in place
  await page.getByRole('tab', { name: /^Notes/u }).click();
  // the agentless Place view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();
  const prompt = page.getByRole('region', { name: 'Workspace toolbar' });
  const placeMenu = page.locator('.place-menu');
  await prompt.getByRole('button', { name: 'More options' }).click();
  await expect(placeMenu.getByRole('button', { name: 'Pin folder' })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await prompt.getByRole('button', { name: /^Launch/u }).click();
  await expect.poll(() => launches).toEqual(['/api/projects/notes/launch']);
  // the ad-hoc folder's tab can be unpinned but has no Launch
  await page.getByRole('tab', { name: /^tools/u }).click();
  await prompt.getByRole('button', { name: 'More options' }).click();
  await expect(placeMenu.getByRole('button', { name: 'Unpin folder' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  // fall back to the global scratch launch
  await expect(prompt.getByRole('button', { name: 'Launch Codex' })).toBeEnabled();
  await expect(prompt.getByRole('button', { name: 'Launch Codex' })).toHaveAttribute('title', 'Codex — last used for scratch');

  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const notesRow = launcher.getByRole('group', { name: 'Notes' }).locator('.launcher-row');
  await expect(notesRow.locator('.launcher-shells')).toHaveText('2');
  await expect(notesRow.locator('.launcher-shells')).toHaveAttribute('aria-label', '2 open terminals');

  // the pin toggle pins the Place through its own pin route
  const pin = notesRow.getByRole('button', { name: 'Pin Notes' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect.poll(() => pins).toEqual([{ path: `/api/worktrees/${encodeURIComponent('notes:/data/notes')}/pin`, body: { pinned: true } }]);

  // the refreshed dashboard shows the Place pinned
  await expect(notesRow.getByRole('button', { name: 'Unpin Notes' })).toHaveAttribute('aria-pressed', 'true');

  // the launcher stays open; the Scratch row pins the configured Scratch folder the same way, and
  // the now-pinned Scratch folder gains a tab
  await launcher.getByRole('button', { name: 'Pin ~ Scratch' }).click();
  await expect.poll(() => pins.map(entry => entry.path)).toContain(`/api/worktrees/${encodeURIComponent('scratch:/home/me/scratch')}/pin`);
  await expect(page.getByRole('tab', { name: /Scratch/u })).toBeVisible();
});
