import { expect, test, type Page } from '@playwright/test';
import { expectProgressBorder } from './progress-border-assertions';

// verify lifecycle feedback names the chosen launch agent
test('keeps agent on/off progress visible across lifecycle transitions', async ({ page }) => {
  let agentRunning = true;
  let agentId = 'agent-1';
  let finishDeactivate!: () => void;
  let finishLaunch!: () => void;
  const deactivateFinished = new Promise<void>(resolve => { finishDeactivate = resolve; });
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });
  const adapters = {
    codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { launchable: true, program: '/bin/omx', stateSource: 'title', turnCapture: true, inlineQuestions: true, commands: true, sandbox: false }
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: agentRunning
          ? { generation: agentId === 'agent-1' ? 1 : 3, adapters, agents: [{ id: agentId, sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', launch: { kind: 'codex', origin: 'worktree' } }], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }] }
          : { generation: 2, adapters, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0, launch: { kind: 'codex', origin: 'worktree' } }, { id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }] }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/deactivate' && request.method() === 'POST') {
      await deactivateFinished;
      agentRunning = false;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/worktrees/cora/launch' && request.method() === 'POST') {
      await launchFinished;
      agentRunning = true;
      agentId = 'agent-2';
      return route.fulfill({ json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem', { name: 'Sleep' })).toHaveCount(0);
  await powerMenu.getByRole('menuitem', { name: 'Turn off' }).click();

  const pendingOff = page.getByRole('status').filter({ hasText: 'Turning off Cora' });
  await expect(pendingOff).toContainText('Stopping the agent while keeping the worktree available');
  await expect(pendingOff.locator('.toast-timer-bar')).toHaveCount(0);
  const turningOffTab = page.getByRole('tab', { name: 'Cora — Turning off' });
  await expectProgressBorder(turningOffTab, 'red');
  await expect(turningOffTab.locator('.tab-kind-stack')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTurningOff = page.getByRole('tab', { name: 'Cora — Turning off' });
  await expectProgressBorder(phoneTurningOff, 'red');
  await phoneTurningOff.click();
  const phoneTurningOffRow = page.locator('.workspace-sheet-row').filter({ hasText: 'Cora' });
  await expectProgressBorder(phoneTurningOffRow, 'red');
  await expect(phoneTurningOffRow.locator('.tab-kind-stack')).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-loading-border-turning-off-sheet-phone.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(pendingOff).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Turning off' }).click();
  await expect(pendingOff).toBeVisible();

  finishDeactivate();
  const offSuccess = page.getByRole('status').filter({ hasText: 'Cora is off' });
  await expect(offSuccess).toContainText('Launch agent whenever you want to turn it back on');
  await expect(offSuccess.locator('.toast-timer-bar')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  // the agentless Worktree view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();

  await page.locator('.workspace-toolbar-actions').getByRole('button', { name: 'Choose agent' }).click();
  await page.getByRole('menu', { name: 'Choose agent' }).getByRole('menuitem', { name: /^OMX/u }).click();
  const pendingLaunch = page.getByRole('status').filter({ hasText: 'Starting Cora' });
  await expect(pendingLaunch).toContainText('waiting for the agent session to become ready');
  await expect(pendingLaunch.locator('.toast-timer-bar')).toHaveCount(0);
  const startingTab = page.getByRole('tab', { name: 'Cora — Starting agent' });
  await expectProgressBorder(startingTab, 'blue');
  await expect(startingTab.locator('.tab-kind-stack')).toBeVisible();
  await expect(page.getByText('Starting OMX at Cora…', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(pendingLaunch).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Starting agent' }).click();
  await expect(pendingLaunch).toBeVisible();

  finishLaunch();
  const launchSuccess = page.getByRole('status').filter({ hasText: 'Cora is starting' });
  await expect(launchSuccess).toContainText('output is connecting');
  await expect(launchSuccess.locator('.toast-timer-bar')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});

// keep fallback launch failures timed after their scoped operation toast leaves view
test('shows a timed fallback launch error after leaving its workspace', async ({ page }) => {
  const adapters = {
    codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { launchable: true, program: '/bin/omx', stateSource: 'title', turnCapture: true, inlineQuestions: true, commands: true, sandbox: false }
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // provide authenticated application state
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active and one launchable workspace
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', launch: { kind: 'codex', origin: 'worktree' } }], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1, launch: { kind: 'codex', origin: 'worktree' } }] }] } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/worktrees\/delta\/(?:notes|panes)$/u.test(url.pathname)) return route.fulfill({ json: url.pathname.endsWith('/notes') ? { notes: [] } : { panes: [] } });
    // reject the selected empty-workspace launch
    if (url.pathname === '/api/worktrees/delta/launch' && request.method() === 'POST') return route.fulfill({ status: 500, json: { error: 'launch failed' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Launch Delta' }).click();
  const scopedError = page.getByRole('alert').filter({ hasText: 'Delta could not start' });
  await expect(scopedError).toBeVisible();
  await expect(scopedError.locator('.toast-timer-bar')).toHaveCount(0);

  // replace the hidden scoped error with its timed fallback
  await page.getByRole('tab', { name: /^Cora/u }).click();
  const fallback = page.locator('.toast-error').filter({ hasText: 'launch failed' });
  await expect(fallback).toBeVisible();
  await expect(fallback.locator('.toast-timer-bar')).toHaveCSS('animation-name', 'key-indicator-drain');
  await expect(fallback.locator('.toast-timer-bar')).toHaveCSS('animation-duration', '5s');
});

// verify non-destructive power actions
test('clears and restarts an idle agent from the power menu', async ({ page }) => {
  let agentId = 'agent-1';
  let clearPrompt: unknown;
  let restartRequests = 0;
  let finishClear!: () => void;
  let finishRestart!: () => void;
  const clearFinished = new Promise<void>(resolve => { finishClear = resolve; });
  const restartFinished = new Promise<void>(resolve => { finishRestart = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: agentId === 'agent-1' ? 1 : 2, adapters: { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }, claude: { launchable: true, program: '/bin/claude', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: agentId, sessionId: agentId === 'agent-1' ? 'socket:$1' : 'socket:$2', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', attention: 'finished', launch: { kind: 'codex', origin: 'worktree' } }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // hold clear while its progress state is visible
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      clearPrompt = request.postDataJSON();
      await clearFinished;
      return route.fulfill({ status: 204 });
    }
    // hold restart while its progress state is visible
    if (url.pathname === '/api/agents/agent-1/restart' && request.method() === 'POST') {
      restartRequests += 1;
      // require explicit json framing like a chunked tunnel transport
      if (request.headers()['content-type'] !== 'application/json' || request.postData() !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      await restartFinished;
      agentId = 'agent-2';
      return route.fulfill({ status: 201, json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem', { name: 'Restart', exact: true })).toBeVisible();
  await expect(powerMenu.getByRole('menuitem', { name: 'Restart as…' })).toBeVisible();
  await expect(powerMenu.getByRole('menuitem', { name: 'Clear' })).toBeVisible();
  await powerMenu.getByRole('menuitem', { name: 'Clear' }).click();

  await expect.poll(() => clearPrompt).toEqual({ prompt: '/clear', attachments: [] });
  await expect(page.getByRole('status').filter({ hasText: 'Clearing Cora' })).toContainText('Sending /clear');
  await expectProgressBorder(page.getByRole('tab', { name: 'Cora — Clearing' }), 'red');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();

  finishClear();
  await expect(page.getByRole('status').filter({ hasText: 'Cora cleared' })).toContainText('conversation is resetting');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();

  await page.getByRole('button', { name: 'Agent power options' }).click();
  await powerMenu.getByRole('menuitem', { name: 'Restart', exact: true }).click();

  await expect.poll(() => restartRequests).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Restarting Cora' })).toContainText('running the resume alias');
  await expectProgressBorder(page.getByRole('tab', { name: 'Cora — Restarting' }), 'yellow');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();

  finishRestart();
  await expect(page.getByRole('status').filter({ hasText: 'Cora restarted' })).toContainText('conversation resumed');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});

// serve one idle agent in Cora whose Turn off closes it, with Cora pinned or not
const mountTurnOff = async (page: Page, pinned: boolean) => {
  let running = true;
  let turnOffRequests = 0;
  const cora = { id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned, order: 0 };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the agent until it is turned off
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: running ? 1 : 2, agents: running ? [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }] : [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [cora] }] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide live agent resources
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // provide empty worktree notes
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // close the agent
    if (url.pathname === '/api/agents/agent-1/deactivate' && request.method() === 'POST') {
      turnOffRequests += 1;
      running = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { turnOffRequests: () => turnOffRequests };
};

// verify Turn off is the only way to stop an idle agent, and a Pinned Worktree keeps its tab
test('turns off an idle agent and keeps the tab of its pinned worktree', async ({ page }) => {
  const harness = await mountTurnOff(page, true);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  // keep unconfigured project actions out of the power menu
  await expect(powerMenu.getByRole('menuitem')).toHaveText(['Restart', 'Clear', 'Turn off']);
  await powerMenu.getByRole('menuitem', { name: 'Turn off' }).click();

  await expect.poll(harness.turnOffRequests).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  // the agentless Worktree view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake up' })).toHaveCount(0);
  // with no agent panel, Remove stays in Place actions and Rename stays by the worktree
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  const placeMenu = page.locator('.place-menu');
  await expect(placeMenu.getByRole('button', { name: 'Remove worktree…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.new-agent-tab').click();
  await expect(page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Rename Cora' })).toBeVisible();
});

// verify an unpinned Worktree's tab closes with its agent
test('turns off an idle agent and drops the tab of its unpinned worktree', async ({ page }) => {
  const harness = await mountTurnOff(page, false);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Turn off' }).click();

  await expect.poll(harness.turnOffRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
});

// verify a failed restart stays visible after the unpinned worktree's tab closes
test('reports a failed restart even when the unpinned worktree tab closes', async ({ page }) => {
  let running = true;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: running ? 1 : 2, agents: running ? [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }] : [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, order: 0 }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-1\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // the server closes the agent, then the resume fails
    if (url.pathname === '/api/agents/agent-1/restart' && request.method() === 'POST') {
      running = false;
      return route.fulfill({ status: 409, json: { error: 'The agent closed, but it could not be resumed.' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Restart', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Cora could not restart' })).toContainText('could not be resumed');
});
