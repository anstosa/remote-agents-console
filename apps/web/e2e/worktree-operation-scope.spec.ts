import { expect, test, type Locator, type Page } from '@playwright/test';

// the "+" launcher toggle in the tab bar
const launcherToggle = (page: Page): Locator => page.locator('.new-agent-tab');
// the launch button in a launcher row identified by its worktree label (the split-button primary)
const launcherRowButton = (page: Page, name: string): Locator => page.getByRole('group', { name: 'Agent launcher' }).locator('.launcher-row').filter({ hasText: name }).getByRole('button', { name: `Launch ${name}` });

test('keeps a queued prompt pending only on its originating agent tab', async ({ page }) => {
  let finishQueue!: () => void;
  const queueFinished = new Promise<void>(resolve => { finishQueue = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: {
          agents: [
            { id: 'agent-alpha', sessionId: 'socket:$1', home: '/worktrees/alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' },
            { id: 'agent-bravo', sessionId: 'socket:$2', home: '/worktrees/bravo', worktreeLabel: 'Bravo', worktreeOrder: 2, title: 'Ready' }
          ],
          projects: []
        }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-alpha/prompt') {
      await queueFinished;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/agents\/agent-(?:alpha|bravo)\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Run the alpha checks');
  await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Queueing' })).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  await expect(prompt).toBeEnabled();
  await prompt.fill('Work independently on bravo');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeEnabled();

  await page.getByRole('tab', { name: /^Alpha/u }).click();
  await expect(page.getByRole('button', { name: 'Queueing' })).toBeDisabled();

  finishQueue();
  await expect(prompt).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Queueing' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();
});

test('keeps launch state on its worktree tab and does not pull focus back after navigation', async ({ page }) => {
  let finishLaunch!: () => void;
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });
  let launched = false;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: launched ? {
          agents: [{ id: 'agent-alpha', sessionId: 'socket:$1', home: '/worktrees/alpha', worktreeId: 'alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' }],
          projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'bravo', label: 'Bravo', path: '/worktrees/bravo', available: true, pinned: true, order: 2 }] }]
        } : {
          agents: [],
          projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [
            { id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: true, order: 1 },
            { id: 'bravo', label: 'Bravo', path: '/worktrees/bravo', available: true, pinned: true, order: 2 }
          ] }]
        }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/alpha/launch') {
      await launchFinished;
      launched = true;
      return route.fulfill({ json: { agentId: 'agent-alpha' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launchButton = page.locator('.workspace-toolbar-actions .queue');
  await launchButton.click();
  await expect(launchButton).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  await expect(launchButton).toBeEnabled();

  await page.getByRole('tab', { name: /^Alpha/u }).click();
  await expect(launchButton).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  finishLaunch();
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Bravo/u })).toHaveAttribute('aria-selected', 'true');
  await expect(launchButton).toBeEnabled();
});

// verify concurrent launcher handoffs
test('creates loading tabs immediately and keeps the worktree launcher available', async ({ page }) => {
  let alphaRunning = false;
  let alphaLaunchReturned = false;
  let alphaPostResponseDashboards = 0;
  let bravoRunning = false;
  let alphaRequests = 0;
  let bravoRequests = 0;
  let finishAlpha!: () => void;
  let finishBravo!: () => void;
  // hold the first launch response
  const alphaFinished = new Promise<void>(resolve => { finishAlpha = resolve; });
  // hold the second launch response
  const bravoFinished = new Promise<void>(resolve => { finishBravo = resolve; });

  // provide independently controlled launch responses
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose active agents and inactive worktrees
    if (url.pathname === '/api/dashboard') {
      // count delayed dashboard propagation
      if (alphaLaunchReturned && !alphaRunning) alphaPostResponseDashboards += 1;
      const agents = [
        ...(alphaRunning ? [{ id: 'agent-alpha', sessionId: 'socket:$1', home: '/worktrees/alpha', worktreeId: 'alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' }] : []),
        ...(bravoRunning ? [{ id: 'agent-bravo', sessionId: 'socket:$2', home: '/worktrees/bravo', worktreeId: 'bravo', worktreeLabel: 'Bravo', worktreeOrder: 2, title: 'Ready' }] : [])
      ];
      const worktrees = [
        ...(!alphaRunning ? [{ id: 'alpha', projectId: 'proj', label: 'Alpha', path: '/worktrees/alpha', main: false, detached: false, locked: false, available: true, pinned: false, order: 1 }] : []),
        ...(!bravoRunning ? [{ id: 'bravo', projectId: 'proj', label: 'Bravo', path: '/worktrees/bravo', main: false, detached: false, locked: false, available: true, pinned: false, order: 2 }] : [])
      ];
      const projects = worktrees.length === 0 ? [] : [{ id: 'proj', label: 'Proj', available: true, worktrees }];
      return route.fulfill({ json: { generation: 1, agents, projects } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide inactive worktree notes
    if (/^\/api\/worktrees\/(?:alpha|bravo)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    // hold alpha until both launches are visible
    if (url.pathname === '/api/worktrees/alpha/launch') {
      alphaRequests += 1;
      await alphaFinished;
      alphaLaunchReturned = true;
      return route.fulfill({ json: { agentId: 'agent-alpha' } });
    }
    // hold bravo independently
    if (url.pathname === '/api/worktrees/bravo/launch') {
      bravoRequests += 1;
      await bravoFinished;
      bravoRunning = true;
      return route.fulfill({ json: { agentId: 'agent-bravo' } });
    }
    // provide active agent bootstrap data
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-(?:alpha|bravo)\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launcher = launcherToggle(page);
  await launcher.click();
  await launcherRowButton(page, 'Alpha').click();

  const alphaTab = page.getByRole('tab', { name: 'Alpha — Starting agent' });
  await expect(alphaTab).toHaveAttribute('aria-busy', 'true');
  await expect(launcher).toBeEnabled();

  await launcher.click();
  await expect(launcherRowButton(page, 'Alpha')).toBeDisabled();
  await launcherRowButton(page, 'Bravo').click();

  const bravoTab = page.getByRole('tab', { name: 'Bravo — Starting agent' });
  await expect(bravoTab).toHaveAttribute('aria-busy', 'true');
  await expect(bravoTab).toHaveAttribute('aria-selected', 'true');
  // observe both launch requests
  await expect.poll(() => ({ alphaRequests, bravoRequests })).toEqual({ alphaRequests: 1, bravoRequests: 1 });

  finishAlpha();
  await expect.poll(() => alphaPostResponseDashboards).toBeGreaterThan(0);
  await expect(alphaTab).toHaveAttribute('aria-busy', 'true');
  await expect(bravoTab).toHaveAttribute('aria-selected', 'true');
  alphaRunning = true;
  await expect(page.getByRole('tab', { name: 'Alpha — Prompt done' })).toBeVisible({ timeout: 10_000 });

  finishBravo();
  await expect(page.getByRole('tab', { name: 'Bravo — Prompt done' })).toHaveAttribute('aria-selected', 'true');
});

// recover worktrees whose launched agent disappears
test('expires a successful launch that never reaches the dashboard', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // keep the launched agent absent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, order: 1 }] }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // report server-side launch success
    if (url.pathname === '/api/worktrees/alpha/launch') return route.fulfill({ json: { agentId: 'agent-alpha' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launcher = launcherToggle(page);
  await launcher.click();
  await launcherRowButton(page, 'Alpha').click();
  await expect(page.getByRole('tab', { name: 'Alpha — Starting agent' })).toHaveAttribute('aria-busy', 'true');

  await page.clock.fastForward(30_001);
  await expect(page.getByRole('alert')).toContainText('Alpha started, but its agent did not remain discoverable. Try again.');
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toHaveCount(0);
  await launcher.click();
  await expect(launcherRowButton(page, 'Alpha')).toBeEnabled();
});

// preserve launch failures after temporary tabs close
test('shows a failed unpinned worktree launch globally', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one launcher-only worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, order: 1 }] }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // reject the worktree launch
    if (url.pathname === '/api/worktrees/alpha/launch') return route.fulfill({ status: 502, json: { error: 'Alpha launch failed upstream.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await launcherToggle(page).click();
  await launcherRowButton(page, 'Alpha').click();

  await expect(page.getByRole('alert')).toHaveText('Alpha launch failed upstream.');
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toHaveCount(0);
});

// scope Turn off state to its own worktree
test('keeps a pending Turn off on its worktree tab without blocking another agent', async ({ page }) => {
  const turnedOff = new Set<string>();
  let finishTurnOff!: () => void;
  const turnOffFinished = new Promise<void>(resolve => { finishTurnOff = resolve; });
  const agent = (name: string, order: number) => ({ id: `agent-${name}`, sessionId: `socket:$${order}`, home: `/worktrees/${name}`, worktreeId: name, title: 'Ready' });
  const worktree = (name: string, label: string, order: number) => ({ id: name, label, path: `/worktrees/${name}`, available: true, pinned: false, order });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // two idle agents in unpinned worktrees, minus any that were turned off
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1 + turnedOff.size, agents: [agent('alpha', 1), agent('bravo', 2)].filter(candidate => !turnedOff.has(candidate.worktreeId)), projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [worktree('alpha', 'Alpha', 1), worktree('bravo', 'Bravo', 2)] }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // hold Alpha's Turn off
    if (url.pathname === '/api/agents/agent-alpha/deactivate' && request.method() === 'POST') {
      await turnOffFinished;
      turnedOff.add('alpha');
      return route.fulfill({ status: 204 });
    }
    // provide active agent bootstrap data
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-(?:alpha|bravo)\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: /^Alpha/u }).click();
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Turn off' }).click();
  await expect(page.getByRole('tab', { name: 'Alpha — Turning off' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();

  // Bravo stays controllable while Alpha is turning off
  await page.getByRole('tab', { name: /^Bravo/u }).click();
  await expect(page.getByRole('tab', { name: /^Bravo/u })).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeEnabled();

  finishTurnOff();
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Bravo/u })).toBeVisible();
});
