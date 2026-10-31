import { expect, test, type Page } from '@playwright/test';

type LifecycleHarness = {
  agentWrites: () => Array<{ path: string; body: unknown }>;
  attempts: () => number;
  dashboardRequests: () => number;
  finishRequest: () => void;
  revealAgent: () => void;
  refreshDashboard: () => Promise<void>;
};

type PendingSessionHarness = {
  agentId: string;
  agentWrites: () => Array<{ path: string; body: unknown }>;
  dashboardRequests: () => number;
  finishRequest: () => void;
  label: string;
  launchRequests: () => number;
  mutations: () => Array<{ method: string; path: string }>;
  revealAgent: () => void;
  refreshDashboard: () => Promise<void>;
};

const codexAdapter = { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false };

// mount one launch lifecycle
const mountLifecycle = async (page: Page, options: { failFirst?: boolean; holdFailure?: boolean; pinned?: boolean } = {}): Promise<LifecycleHarness> => {
  const agentWrites: Array<{ path: string; body: unknown }> = [];
  let attempts = 0;
  let dashboardRequests = 0;
  let agentVisible = false;
  let finishRequest!: () => void;
  const requestFinished = new Promise<void>(resolve => { finishRequest = resolve; });
  const cora = { id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: options.pinned ?? true, order: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const delta = { id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 };
  const readyAgent = { id: 'agent-ready', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', attention: 'finished', launch: { kind: 'codex', origin: 'worktree' } };

  // serve controlled lifecycle snapshots
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the agent only after handoff
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({
        json: agentVisible
          ? { generation: 2, adapters: { codex: codexAdapter }, agents: [readyAgent], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [delta] }] }
          : { generation: 1, adapters: { codex: codexAdapter }, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [cora, delta] }] }
      });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // allow dashboard socket setup
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // provide inactive worktree resources
    if (/^\/api\/worktrees\/(?:cora|delta)\/bookmarks$/u.test(url.pathname)) return route.fulfill({ json: { bookmarks: [], canResume: false } });
    // provide empty worktree notes
    if (/^\/api\/worktrees\/(?:cora|delta)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    // provide the live output ticket
    if (url.pathname === '/api/agents/agent-ready/tickets') return route.fulfill({ json: { ticket: 'agent-ticket' } });
    // record agent-only prompt writes
    if (request.method() === 'POST' && /^\/api\/agents\/[^/]+\/(?:prompt|saved-prompts)$/u.test(url.pathname)) {
      agentWrites.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    // provide empty live-agent prompt resources
    if (request.method() === 'GET' && /^\/api\/agents\/agent-ready\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // provide an empty command catalog
    if (url.pathname === '/api/agents/agent-ready/commands') return route.fulfill({ json: { commands: [] } });
    // hold the selected start operation
    if (url.pathname === '/api/worktrees/cora/launch' && request.method() === 'POST') {
      attempts += 1;
      // fail only the first launch attempt
      if (options.failFirst && attempts === 1) {
        // allow an unpinned tab to stage its draft before failure
        if (options.holdFailure) await requestFinished;
        return route.fulfill({ status: 409, json: { error: 'Agent launch failed for the test.' } });
      }
      await requestFinished;
      return route.fulfill({ status: 201, json: { agentId: 'agent-ready' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  return {
    agentWrites: () => agentWrites,
    attempts: () => attempts,
    dashboardRequests: () => dashboardRequests,
    finishRequest,
    revealAgent: () => { agentVisible = true; },
    // request one fresh dashboard snapshot
    refreshDashboard: async () => { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }
  };
};

// stage one browser-owned attachment
const attach = async (page: Page, name: string, contents: string) => {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(contents) });
};

// open the tab-strip launcher
const openAgentLauncher = async (page: Page) => {
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: 'Launch agent', exact: true }).click();
};
// select the scratch header or a project place action
const launcherLaunchButton = (page: Page, label: string) => {
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  // scratch is the launcher header rather than a place row
  if (label === 'Scratch') return launcher.getByRole('button', { name: 'Launch ~ Scratch' });
  return launcher.locator('.launcher-row').filter({ hasText: label }).getByRole('button', { name: `Launch ${label}` });
};

// mount one scratch-like lifecycle
const mountPendingSession = async (page: Page, scope: 'scratch' | 'directory', options: { fail?: boolean; withAnchor?: boolean } = {}): Promise<PendingSessionHarness> => {
  const agentId = `${scope}-ready`;
  const label = scope === 'scratch' ? 'Scratch' : 'Docs';
  const agentWrites: Array<{ path: string; body: unknown }> = [];
  const mutations: Array<{ method: string; path: string }> = [];
  let agentVisible = false;
  let dashboardRequests = 0;
  let launchRequests = 0;
  let finishRequest!: () => void;
  const requestFinished = new Promise<void>(resolve => { finishRequest = resolve; });
  const directory = { id: 'docs', label: 'Docs', mode: 'directory', available: true, worktrees: [], launch: { kind: 'codex', origin: 'project' } };
  const anchorAgent = { id: 'anchor', sessionId: 'socket:$1', home: '/tmp/anchor', displayLabel: 'Anchor', title: 'Ready', kind: 'codex', attention: 'finished' };
  const readyAgent = { id: agentId, sessionId: 'socket:$2', home: scope === 'scratch' ? '/tmp/scratch' : '/projects/docs', displayLabel: label, title: 'Ready', kind: 'codex', attention: 'finished', ...(scope === 'directory' ? { projectId: 'docs' } : {}) };

  // serve controlled scratch-like snapshots
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // record every server mutation
    if (request.method() !== 'GET') mutations.push({ method: request.method(), path: url.pathname });
    // authenticate the console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the exact returned agent only after handoff delay
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({ json: { generation: agentVisible ? 2 : 1, adapters: { codex: codexAdapter }, scratchLaunch: { kind: 'codex', origin: 'scratch' }, agents: [...(options.withAnchor ? [anchorAgent] : []), ...(agentVisible ? [readyAgent] : [])], projects: [directory] } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // allow dashboard socket setup
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // provide the live output ticket
    if (/^\/api\/agents\/(?:anchor|scratch-ready|directory-ready)\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'agent-ticket' } });
    // record agent-only prompt writes
    if (request.method() === 'POST' && /^\/api\/agents\/[^/]+\/(?:prompt|saved-prompts)$/u.test(url.pathname)) {
      agentWrites.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    // provide empty live-agent prompt resources
    if (request.method() === 'GET' && /^\/api\/agents\/(?:anchor|scratch-ready|directory-ready)\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // provide an empty command catalog
    if (/^\/api\/agents\/(?:anchor|scratch-ready|directory-ready)\/commands$/u.test(url.pathname)) return route.fulfill({ json: { commands: [] } });
    // hold the selected session launch
    if (url.pathname === (scope === 'scratch' ? '/api/agents/launch' : '/api/projects/docs/launch') && request.method() === 'POST') {
      launchRequests += 1;
      await requestFinished;
      // fail only a true launch rejection
      if (options.fail) return route.fulfill({ status: 409, json: { error: `${label} launch failed for the test.` } });
      return route.fulfill({ status: 201, json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  return {
    agentId,
    agentWrites: () => agentWrites,
    dashboardRequests: () => dashboardRequests,
    finishRequest,
    label,
    launchRequests: () => launchRequests,
    mutations: () => mutations,
    revealAgent: () => { agentVisible = true; },
    // request one fresh dashboard snapshot
    refreshDashboard: async () => {
      const previousRequests = dashboardRequests;
      await expect.poll(async () => {
        /* retry skipped refreshes */
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        return dashboardRequests;
      }).toBeGreaterThan(previousRequests);
    }
  };
};

// verify one scratch-like handoff
const verifyPendingSessionHandoff = async (page: Page, scope: 'scratch' | 'directory') => {
  const harness = await mountPendingSession(page, scope);
  await openAgentLauncher(page);
  await launcherLaunchButton(page, harness.label).click();
  await expect.poll(harness.launchRequests).toBe(1);

  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const attachmentName = `${scope}-context.txt`;
  const attachmentBody = `${scope} context`;
  const promptText = `${harness.label} prepared prompt`;
  await expect(page.getByRole('tab', { name: `${harness.label} — Starting agent` })).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(prompt).toBeEnabled();
  await expect(composer.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  await prompt.fill(promptText);
  await attach(page, attachmentName, attachmentBody);
  await expect(page.getByLabel('Selected attachments')).toContainText(attachmentName);
  await expect(composer.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();

  harness.finishRequest();
  await expect(page.getByRole('status').filter({ hasText: `${harness.label} is starting` })).toBeVisible();
  await expect.poll(harness.dashboardRequests).toBeGreaterThanOrEqual(2);
  await expect(prompt).toHaveValue(promptText);
  await expect(page.getByLabel('Selected attachments')).toContainText(attachmentName);

  harness.revealAgent();
  await harness.refreshDashboard();
  await expect(page.getByRole('tab', { name: `${harness.label} — Prompt done` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(promptText);
  await expect(page.getByLabel('Selected attachments')).toContainText(attachmentName);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(harness.agentWrites).toEqual([{
    path: `/api/agents/${harness.agentId}/prompt`,
    body: { prompt: promptText, attachments: [{ name: attachmentName, data: Buffer.from(attachmentBody).toString('base64') }] }
  }]);
};

// verify delayed desktop launch handoff
test('keeps the complete launch composer editable through tab changes and delayed dashboard handoff', async ({ page }) => {
  const harness = await mountLifecycle(page);
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(harness.attempts).toBe(1);

  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(composer).toBeVisible();
  await expect(prompt).toBeEnabled();
  await expect(composer.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  // the Workspace's More menu lives in the row beneath the tabs, not the composer
  await expect(composer.getByRole('button', { name: 'More options' })).toHaveCount(0);
  await prompt.fill('before  after');
  await attach(page, 'launch-context.txt', 'launch context');
  await expect(page.getByLabel('Selected attachments')).toContainText('launch-context.txt');
  await expect(composer.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();
  await prompt.press('Enter');
  expect(harness.agentWrites()).toEqual([]);
  await expect(prompt).toHaveValue('before  after');

  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(page.getByRole('region', { name: 'Prompt composer' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Starting agent' }).click();
  await expect(prompt).toHaveValue('before  after');
  await expect(page.getByLabel('Selected attachments')).toContainText('launch-context.txt');

  harness.finishRequest();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is starting' })).toBeVisible();
  await expect.poll(harness.dashboardRequests).toBeGreaterThanOrEqual(2);
  await expect(prompt).toHaveValue('before  after');
  await expect(composer.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();

  await prompt.focus();
  await prompt.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(7, 7));
  await page.keyboard.type('mid');
  await expect(prompt).toHaveJSProperty('selectionStart', 10);
  harness.revealAgent();
  await harness.refreshDashboard();

  const readyPrompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
  await expect(readyPrompt).toBeFocused();
  await expect(readyPrompt).toHaveJSProperty('selectionStart', 10);
  await page.keyboard.type('handoff');
  await expect(readyPrompt).toHaveValue('before midhandoff after');
  await expect(page.getByLabel('Selected attachments')).toContainText('launch-context.txt');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(harness.agentWrites).toEqual([{
    path: '/api/agents/agent-ready/prompt',
    body: {
      prompt: 'before midhandoff after',
      attachments: [{ name: 'launch-context.txt', data: Buffer.from('launch context').toString('base64') }]
    }
  }]);
});

// verify retry draft preservation
test('preserves the prepared draft and files after launch failure and retry', async ({ page }) => {
  const harness = await mountLifecycle(page, { failFirst: true });
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(harness.attempts).toBe(1);

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeEnabled();
  await prompt.fill('Retry this prepared prompt');
  await attach(page, 'retry-context.txt', 'retry context');
  await expect(page.locator('.launch-error')).toContainText('Agent launch failed for the test.');
  // the pending-launch view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();
  await expect(prompt).toHaveValue('Retry this prepared prompt');
  await expect(page.getByLabel('Selected attachments')).toContainText('retry-context.txt');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(harness.attempts).toBe(2);
  await expect(page.getByRole('status', { name: 'Starting Cora', exact: true })).toBeVisible();
  await expect(prompt).toHaveValue('Retry this prepared prompt');
  await expect(page.getByLabel('Selected attachments')).toContainText('retry-context.txt');

  harness.revealAgent();
  harness.finishRequest();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Retry this prepared prompt');
  await expect(page.getByLabel('Selected attachments')).toContainText('retry-context.txt');
});

// verify mobile launch layout and handoff
test('shows the editable launch composer without overflowing a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await mountLifecycle(page);
  // the phone launch action opens a chooser before starting the selected agent
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch agent' }).click();
  await page.getByRole('menu', { name: 'Choose agent' }).getByRole('menuitem', { name: /^Codex ·/u }).click();
  await expect.poll(harness.attempts).toBe(1);

  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(composer).toBeVisible();
  await expect(prompt).toBeEnabled();
  await expect(composer.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  await prompt.fill('Mobile launch draft');
  await attach(page, 'mobile-context.txt', 'mobile context');
  await expect(page.getByLabel('Selected attachments')).toContainText('mobile-context.txt');
  await expect(composer.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();

  const layout = await page.evaluate(() => {
    const rect = document.querySelector<HTMLElement>('[aria-label="Prompt composer"]')!.getBoundingClientRect();
    return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, left: rect.left, right: rect.right };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);

  harness.finishRequest();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is starting' })).toBeVisible();
  await expect.poll(harness.dashboardRequests).toBeGreaterThanOrEqual(2);
  await expect(prompt).toHaveValue('Mobile launch draft');
  harness.revealAgent();
  await harness.refreshDashboard();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Mobile launch draft');
  await expect(page.getByLabel('Selected attachments')).toContainText('mobile-context.txt');
});

// verify unpinned failure retention
test('retains an unpinned worktree tab when a held launch fails after drafting', async ({ page }) => {
  const harness = await mountLifecycle(page, { failFirst: true, holdFailure: true, pinned: false });
  await openAgentLauncher(page);
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.locator('.launcher-row').filter({ hasText: 'Cora' }).getByRole('button', { name: 'Launch Cora' }).click();
  await expect.poll(harness.attempts).toBe(1);

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeEnabled();
  await prompt.fill('Keep this unpinned draft');
  await attach(page, 'unpinned-context.txt', 'unpinned context');
  harness.finishRequest();

  await expect(page.getByRole('alert').filter({ hasText: 'Agent launch failed for the test.' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(prompt).toHaveValue('Keep this unpinned draft');
  await expect(page.getByLabel('Selected attachments')).toContainText('unpinned-context.txt');
});

// verify scratch pending controls
test('prepares and hands off a scratch prompt before dashboard discovery', async ({ page }) => {
  await verifyPendingSessionHandoff(page, 'scratch');
});

// verify directory pending controls
test('prepares and hands off a directory prompt before dashboard discovery', async ({ page }) => {
  await verifyPendingSessionHandoff(page, 'directory');
});

// keep a pending scratch session's direct prompt footer above the software keyboard edge
test('a pending scratch session keeps the mobile keyboard gutter', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await mountPendingSession(page, 'scratch');
  await openAgentLauncher(page);
  await page.getByRole('group', { name: 'Agent launcher' }).locator('.launcher-row').filter({ hasText: 'Scratch' }).getByRole('button', { name: 'Launch ~ Scratch' }).click();
  await expect.poll(harness.launchRequests).toBe(1);

  const pendingPanel = page.locator('.log > .log-split > .log-output');
  await expect(pendingPanel).toBeVisible();
  await expect(page.locator('.log > .log-split')).toHaveCount(1);
  await expect(pendingPanel.getByRole('region', { name: 'Prompt composer' })).toBeVisible();
  // keep the direct pending output border above its composer
  const borderPlacement = await pendingPanel.evaluate(element => {
    const output = element.querySelector<HTMLElement>('.agent-output');
    const composer = element.querySelector<HTMLElement>('.agent-composer');
    // require both pending rows
    if (output === null || composer === null) throw new Error('pending session rows are missing');
    return {
      outputBorder: getComputedStyle(output).borderBottomWidth,
      panelBorder: getComputedStyle(element).borderBottomWidth,
      gap: composer.getBoundingClientRect().top - output.getBoundingClientRect().bottom
    };
  });
  expect(borderPlacement).toEqual({ outputBorder: '1px', panelBorder: '0px', gap: 0 });
  await page.evaluate(() => document.documentElement.classList.add('software-keyboard-open'));
  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>('.log > .log-split > .log-output .agent-composer textarea, .log > .log-split > .log-output .agent-composer button')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    // require the pending composer controls
    if (controls.length === 0) throw new Error('pending session prompt controls are missing');
    return {
      tabs: getComputedStyle(document.querySelector<HTMLElement>('.tabs')!).display,
      toolbar: getComputedStyle(document.querySelector<HTMLElement>('.workspace-toolbar')!).display,
      bottomGap: innerHeight - Math.max(...controls.map(rect => rect.bottom)),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    };
  });
  await page.screenshot({ path: testInfo.outputPath('pending-scratch-keyboard-gutter.png'), fullPage: true });
  expect(layout).toEqual({ tabs: 'none', toolbar: 'none', bottomGap: 6, documentWidth: 390, viewportWidth: 390 });
});

// verify late scratch discovery
test('keeps one returned scratch launch pending beyond the discovery timeout', async ({ page }) => {
  await page.clock.install();
  const harness = await mountPendingSession(page, 'scratch');
  await openAgentLauncher(page);
  await launcherLaunchButton(page, 'Scratch').click();
  await expect.poll(harness.launchRequests).toBe(1);

  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Late scratch handoff');
  await attach(page, 'late-context.txt', 'late context');
  harness.finishRequest();
  await expect.poll(harness.dashboardRequests).toBeGreaterThanOrEqual(2);
  await page.clock.fastForward(31_000);

  await expect(page.getByRole('status', { name: 'Starting Scratch' })).toBeVisible();
  await expect(prompt).toHaveValue('Late scratch handoff');
  await expect(page.getByLabel('Selected attachments')).toContainText('late-context.txt');
  // the persistent launch stays visible, while this pending session offers no retry
  await expect(page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Launch Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard failed launch' })).toHaveCount(0);
  expect(harness.launchRequests()).toBe(1);

  harness.revealAgent();
  await harness.refreshDashboard();
  await expect(page.getByRole('tab', { name: 'Scratch — Prompt done' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Late scratch handoff');
  await expect(page.getByLabel('Selected attachments')).toContainText('late-context.txt');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(harness.agentWrites).toEqual([{
    path: '/api/agents/scratch-ready/prompt',
    body: { prompt: 'Late scratch handoff', attachments: [{ name: 'late-context.txt', data: Buffer.from('late context').toString('base64') }] }
  }]);
  expect(harness.launchRequests()).toBe(1);
});

// verify failed directory discard
test('confirms and discards a failed directory launch without server cleanup', async ({ page }) => {
  const harness = await mountPendingSession(page, 'directory', { fail: true, withAnchor: true });
  await openAgentLauncher(page);
  await page.getByRole('group', { name: 'Agent launcher' }).locator('.launcher-row').filter({ hasText: 'Docs' }).getByRole('button', { name: 'Launch Docs' }).click();
  await expect.poll(harness.launchRequests).toBe(1);

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Discard this directory draft');
  await attach(page, 'discard-context.txt', 'discard context');
  const pendingHash = await page.evaluate(() => location.hash);
  const storedDraftKeys = await page.evaluate(() => {
    /* find pending draft storage */
    return Object.keys(localStorage).filter(key => key.startsWith('remote-agent-console:prompt-draft:pending-launch:'));
  });
  expect(storedDraftKeys).toHaveLength(1);
  harness.finishRequest();
  await expect(page.locator('.launch-error')).toContainText('Docs launch failed for the test.');

  const discard = page.getByRole('button', { name: 'Discard failed launch' });
  await expect(discard).toBeVisible();
  const mutationsBeforeDiscard = [...harness.mutations()];
  const cancelDialogPromise = page.waitForEvent('dialog');
  const cancelClickPromise = discard.click();
  const cancelDialog = await cancelDialogPromise;
  expect(cancelDialog.type()).toBe('confirm');
  expect(cancelDialog.message()).toMatch(/discard|lose|draft/iu);
  await cancelDialog.dismiss();
  await cancelClickPromise;
  expect(await page.evaluate(() => location.hash)).toBe(pendingHash);
  await expect(prompt).toHaveValue('Discard this directory draft');
  await expect(page.getByLabel('Selected attachments')).toContainText('discard-context.txt');
  expect(harness.mutations()).toEqual(mutationsBeforeDiscard);

  const acceptDialogPromise = page.waitForEvent('dialog');
  const acceptClickPromise = discard.click();
  const acceptDialog = await acceptDialogPromise;
  expect(acceptDialog.type()).toBe('confirm');
  await acceptDialog.accept();
  await acceptClickPromise;
  await expect(page.getByRole('tab').filter({ hasText: 'Docs' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Anchor — Prompt done' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
  const discardedDraftValues = await page.evaluate(keys => {
    /* inspect discarded draft storage */
    const values: Array<string | null> = [];
    // collect each stored draft
    for (const key of keys) values.push(localStorage.getItem(key));
    return values;
  }, storedDraftKeys);
  expect(discardedDraftValues).toEqual([null]);
  expect(harness.agentWrites()).toEqual([]);
  expect(harness.launchRequests()).toBe(1);
  const unexpectedDiscardMutations = harness.mutations().slice(mutationsBeforeDiscard.length).filter(mutation => {
    /* allow selected-agent bookkeeping */
    return !/^\/api\/agents\/anchor\/(?:tickets|notifications\/dismiss)$/u.test(mutation.path);
  });
  expect(unexpectedDiscardMutations).toEqual([]);
});

// verify early dashboard ordering
test('keeps the scratch composer selected when its agent appears before the launch response', async ({ page }) => {
  const harness = await mountPendingSession(page, 'scratch');
  await openAgentLauncher(page);
  await launcherLaunchButton(page, 'Scratch').click();
  await expect.poll(harness.launchRequests).toBe(1);

  const pendingTab = page.getByRole('tab', { name: 'Scratch — Starting agent' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Early dashboard draft');
  await attach(page, 'early-context.txt', 'early context');
  await prompt.focus();
  await prompt.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(6, 6));
  harness.revealAgent();
  await harness.refreshDashboard();

  await expect(page.getByRole('tab', { name: 'Scratch — Prompt done' })).toHaveAttribute('aria-selected', 'false');
  await expect(pendingTab).toHaveAttribute('aria-selected', 'true');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveJSProperty('selectionStart', 6);
  await expect(prompt).toHaveValue('Early dashboard draft');
  await expect(page.getByLabel('Selected attachments')).toContainText('early-context.txt');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();

  harness.finishRequest();
  await expect(pendingTab).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Scratch — Prompt done' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveJSProperty('selectionStart', 6);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Early dashboard draft');
});

// verify background handoff selection
test('does not steal selection when a scratch launch completes in the background', async ({ page }) => {
  const harness = await mountPendingSession(page, 'scratch', { withAnchor: true });
  await openAgentLauncher(page);
  await launcherLaunchButton(page, 'Scratch').click();
  await expect.poll(harness.launchRequests).toBe(1);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Background scratch draft');
  await attach(page, 'background-context.txt', 'background context');
  const pendingHash = await page.evaluate(() => location.hash);
  expect(pendingHash).toMatch(/^#launch=/u);
  const anchorTab = page.getByRole('tab', { name: 'Anchor — Prompt done' });
  await anchorTab.click();
  await page.evaluate(hash => { location.hash = hash; }, pendingHash);
  await expect(page.getByRole('tab', { name: 'Scratch — Starting agent' })).toHaveAttribute('aria-selected', 'true');
  await anchorTab.click();

  harness.finishRequest();
  await expect.poll(harness.dashboardRequests).toBeGreaterThanOrEqual(2);
  harness.revealAgent();
  await harness.refreshDashboard();
  await expect(anchorTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Scratch — Starting agent' })).toHaveCount(0);
  const scratchTab = page.getByRole('tab', { name: 'Scratch — Prompt done' });
  await expect(scratchTab).toHaveAttribute('aria-selected', 'false');

  await scratchTab.click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Background scratch draft');
  await expect(page.getByLabel('Selected attachments')).toContainText('background-context.txt');
});

// verify dashboard deep links
test('keeps initial and same-document tab links aligned with stable selection keys', async ({ page }) => {
  const cora = { id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', attention: 'finished' };
  const delta = { id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 };
  // serve one agent and one idle worktree
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose both deep-link target kinds
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: codexAdapter }, agents: [cora], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [delta] }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // disable dashboard push retries
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ status: 404, json: {} });
    // provide inactive worktree resources
    if (/^\/api\/worktrees\/delta\/(?:bookmarks|notes)$/u.test(url.pathname)) return route.fulfill({ json: url.pathname.endsWith('/bookmarks') ? { bookmarks: [], canResume: false } : { notes: [] } });
    // provide live-agent resources
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'agent-ticket' } });
    // provide empty prompt lists
    if (/^\/api\/agents\/agent-cora\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/#tab=Delta');
  const deltaTab = page.getByRole('tab', { name: 'Delta — Agent closed' });
  const coraTab = page.getByRole('tab', { name: 'Cora — Prompt done' });
  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { location.hash = '#agent=agent-cora'; });
  await expect(coraTab).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { location.hash = '#worktree=delta'; });
  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
});
