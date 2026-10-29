import { expect, test } from '@playwright/test';
import { installPaneMock, paneInputText, pushQuestion, seedPaneSize } from './pane-stream-mock.js';

const palette = {
  crust: 'rgb(17, 17, 27)',
  green: 'rgb(166, 227, 161)',
  lavender: 'rgb(180, 190, 254)',
  maroon: 'rgb(235, 160, 172)',
  mauve: 'rgb(203, 166, 247)',
  rosewater: 'rgb(245, 224, 220)',
  sapphire: 'rgb(116, 199, 236)',
  sky: 'rgb(137, 220, 235)'
} as const;

// require solid buttons to retain their selected palette fill
async function expectSolid(locator: import('@playwright/test').Locator, color: keyof typeof palette) {
  await expect(locator).toHaveCSS('background-color', palette[color]);
  await expect(locator).toHaveCSS('border-top-color', palette[color]);
  await expect(locator).toHaveCSS('color', palette.crust);
}

// require outline buttons to retain their selected palette foreground
async function expectOutline(locator: import('@playwright/test').Locator, color: keyof typeof palette) {
  await expect(locator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(locator).toHaveCSS('color', palette[color]);
  expect(await locator.evaluate(element => getComputedStyle(element).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
}

const slots = () => ({
  tabLead: [], leftNav: [], rightNav: [], navMenu: [], pullRequest: [],
  'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': []
});
const button = (id: string, text: string, color: string, style: 'outline' | 'solid', actionKind: 'shell' | 'prompt' = 'shell') => ({ id, text, icon: 'M5 12h14', color, style, actionKind });
const effective = {
  ...slots(),
  tabLead: [button('tab-action', 'Tab action', 'rosewater', 'outline')],
  leftNav: [button('left-action', 'Left action', 'green', 'solid')],
  rightNav: [button('right-action', 'Right action', 'sapphire', 'outline')],
  navMenu: [button('menu-action', 'Menu action', 'maroon', 'solid', 'prompt')],
  pullRequest: [button('push-action', 'Commit/Push', 'mauve', 'solid', 'prompt'), button('fixup-action', '$fixup', 'lavender', 'outline', 'shell')],
  'split:agent': [button('agent-action', 'Agent action', 'sky', 'outline', 'prompt')],
  'split:terminal': [button('terminal-action', 'Terminal action', 'green', 'outline', 'shell')]
};
const worktree = { id: 'wt-1', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/buttons', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } };
const dashboard = {
  generation: 1,
  serverStartedAt: 17,
  agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: worktree.path, worktreeId: worktree.id, placeId: worktree.id, projectId: 'repo', title: 'Ready', queuedPromptCount: 0, branch: worktree.branch, gitStatus: worktree.gitStatus }],
  projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [worktree] }],
  buttons: { revision: 'buttons-v1', application: effective, projects: { repo: effective } }
};

type Pane = { paneId: string; session: string; window: string; role: 'shell'; name: string; command: string; path: string; title: string; agent: false; busy: false };
type FixtureState = { dashboard: typeof dashboard; panes: Pane[] };
type DraftResult = { status?: number; json: unknown };
type MountOptions = {
  agents?: typeof dashboard.agents;
  panes?: Pane[];
  storedTerminals?: Array<{ paneId: string; name: string }>;
  worktreePrompt?: string;
  createdPane?: Pane;
  draft?: (body: Record<string, unknown>, state: FixtureState) => DraftResult | Promise<DraftResult>;
};

const buildPane = (paneId: string, name: string, window: string): Pane => ({ paneId, session: '$1', window, role: 'shell', name, command: 'zsh', path: worktree.path, title: '', agent: false, busy: false });

// mount configured actions with mutable dashboard, pane and draft fixtures
async function mount(page: import('@playwright/test').Page, options: MountOptions = {}) {
  const starts: Array<Record<string, unknown>> = [];
  const drafts: Array<Record<string, unknown>> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const answers: Array<Record<string, unknown>> = [];
  const shellCreates: Array<Record<string, unknown>> = [];
  const state: FixtureState = { dashboard: structuredClone(dashboard), panes: [...options.panes ?? []] };
  state.dashboard.agents = structuredClone(options.agents ?? dashboard.agents);
  let dashboardReads = 0;
  let menuComplete = false;
  await installPaneMock(page);
  // restore only the terminals this fixture explicitly opens
  if (options.storedTerminals !== undefined) await page.addInitScript(({ key, terminals }) => localStorage.setItem(key, JSON.stringify(terminals)), { key: `rac.terminals:${worktree.id}`, terminals: options.storedTerminals });
  // restore one agentless worktree draft before its pending composer mounts
  if (options.worktreePrompt !== undefined) await page.addInitScript(({ key, prompt }) => localStorage.setItem(key, prompt), { key: `remote-agent-console:prompt-draft:worktree-prompt:${worktree.id}`, prompt: options.worktreePrompt });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') { dashboardReads += 1; return route.fulfill({ json: state.dashboard }); }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/(?:agents\/[^/]+|worktrees\/[^/]+)\/tickets$/u.test(path)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/[^/]+\/prompt$/u.test(path) && request.method() === 'POST') { prompts.push(request.postDataJSON() as Record<string, unknown>); return route.fulfill({ status: 204 }); }
    if (/^\/api\/agents\/[^/]+\/question$/u.test(path) && request.method() === 'POST') { answers.push(request.postDataJSON() as Record<string, unknown>); return route.fulfill({ status: 204 }); }
    if (path === `/api/worktrees/${worktree.id}/panes`) return route.fulfill({ json: { panes: state.panes } });
    // create one discoverable managed shell for edit-before-submit
    if (path === `/api/worktrees/${worktree.id}/shells` && request.method() === 'POST') {
      shellCreates.push(request.postDataJSON() as Record<string, unknown>);
      const created = options.createdPane ?? buildPane('%9', 'shell', '@9');
      if (!state.panes.some(pane => pane.paneId === created.paneId)) state.panes.push(created);
      return route.fulfill({ status: 201, json: { paneId: created.paneId } });
    }
    if (path === `/api/worktrees/${worktree.id}/notes`) return route.fulfill({ json: { notes: [] } });
    // prepare trusted text without exposing it through the dashboard
    if (path === '/api/button-actions/draft' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      drafts.push(body);
      const result = options.draft === undefined
        ? { json: { draft: { kind: 'shell', text: 'echo ready', placeId: worktree.id } } }
        : await options.draft(body, state);
      return route.fulfill({ status: result.status ?? 200, json: result.json });
    }
    // record one configured action dispatch
    if (path === '/api/button-actions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown> & { actionId: string };
      starts.push(body);
      return route.fulfill({ status: 202, json: { operation: { id: `operation-${body.actionId}`, state: ['menu-action', 'push-action', 'fixup-action'].includes(body.actionId) ? 'running' : 'complete', ...(body.actionId === 'agent-action' ? { phase: 'submitted' } : {}) } } });
    }
    if (path === '/api/button-actions/operation-menu-action') return route.fulfill({ json: { operation: { id: 'operation-menu-action', state: menuComplete ? 'complete' : 'running', ...(menuComplete ? { phase: 'submitted' } : {}) } } });
    // retain git action progress across flyout remounts
    if (path === '/api/button-actions/operation-push-action' || path === '/api/button-actions/operation-fixup-action') return route.fulfill({ json: { operation: { id: path.slice('/api/button-actions/'.length), state: 'running' } } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { starts, drafts, prompts, answers, shellCreates, state, dashboardReads: () => dashboardReads, completeMenu: () => { menuComplete = true; } };
}

// open the custom action's edit path without invoking its primary click
async function editBeforeSubmit(page: import('@playwright/test').Page, source: import('@playwright/test').Locator, beforeSelect?: () => void | Promise<void>) {
  await source.click({ button: 'right' });
  const edit = page.getByRole('menuitem', { name: 'Edit before submit', exact: true });
  await expect(edit).toBeVisible();
  await beforeSelect?.();
  await edit.click();
}

test('renders configured slots and retains closed flyout progress without executable request data', async ({ page }) => {
  const controls = await mount(page);
  const tabAction = page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' });
  await expect(tabAction).toBeVisible();
  await expectOutline(tabAction, 'rosewater');
  await expect(page.locator('.workspace-toolbar-actions > .configured-left-nav + .toolbar-spacer')).toHaveCount(1);
  await expect(page.locator('.workspace-toolbar-actions > .toolbar-spacer + .configured-right-nav')).toHaveCount(1);
  await expectSolid(page.locator('.configured-left-nav').getByRole('button', { name: 'Left action' }), 'green');
  await expectOutline(page.locator('.configured-right-nav').getByRole('button', { name: 'Right action' }), 'sapphire');
  const agentAction = page.locator('.agent-panel .panel-header-actions').getByRole('button', { name: 'Agent action' });
  await expect(agentAction).toBeVisible();
  await expectOutline(agentAction, 'sky');
  await agentAction.click();
  const immediateSubmission = page.locator('.operation-feedback').filter({ hasText: 'Agent action submitted' });
  await expect(immediateSubmission).toContainText('Prompt submitted to the agent.');

  const more = page.getByRole('button', { name: 'More options' });
  await more.click();
  const menuAction = page.getByRole('button', { name: 'Menu action' });
  await expectSolid(menuAction, 'maroon');
  await menuAction.click();
  await expect(page.locator('.place-menu')).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-busy', 'true');
  expect(controls.starts).toHaveLength(2);
  const menuStart = controls.starts.find(start => start.actionId === 'menu-action');
  expect(menuStart).toMatchObject({ actionId: 'menu-action', configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'navMenu', agentId: 'agent-1' });
  expect(menuStart).not.toHaveProperty('command');
  expect(menuStart).not.toHaveProperty('prompt');
  expect(menuStart).not.toHaveProperty('cwd');
  await more.click();
  const busyMenuAction = page.getByRole('button', { name: 'Menu action' });
  await expect(busyMenuAction).toHaveAttribute('aria-busy', 'true');
  await expect(busyMenuAction).toBeDisabled();
  await expectSolid(busyMenuAction, 'maroon');
  await page.keyboard.press('Escape');
  await expect(page.locator('.place-menu')).toHaveCount(0);
  controls.completeMenu();
  await expect(more).not.toHaveAttribute('aria-busy', 'true', { timeout: 4_000 });
  const polledSubmission = page.locator('.operation-feedback').filter({ hasText: 'Menu action submitted' });
  await expect(polledSubmission).toContainText('Prompt submitted to the agent.');

  await page.getByRole('button', { name: /^Git status: feature\/buttons/u }).click();
  const actions = page.getByRole('region', { name: 'Changed files' }).locator('.git-status-actions');
  const push = actions.getByRole('button', { name: 'Commit/Push' });
  const fixup = actions.getByRole('button', { name: '$fixup', exact: true });
  await expect(push).toBeVisible();
  await expect(fixup).toBeVisible();
  await expectSolid(push, 'mauve');
  await expectOutline(fixup, 'lavender');
  await expect(actions.getByRole('button', { name: /Push/u })).toHaveCount(1);
  await expect(actions.locator('.git-status-push, .pull-request-fixup')).toHaveCount(0);
  await page.getByRole('region', { name: 'Changed files' }).screenshot({ path: '/tmp/remoteagents-configured-pr-colors.png' });
});

// verify git actions dismiss on dispatch without losing retained progress
test('dismisses the Git flyout when prompt and shell actions start while retaining their progress', async ({ page }) => {
  const controls = await mount(page);
  const branch = page.getByRole('button', { name: /^Git status: feature\/buttons/u });
  const expectedActions = [
    { id: 'push-action', name: 'Commit/Push' },
    { id: 'fixup-action', name: '$fixup' }
  ];

  // exercise both configured action kinds through the same flyout boundary
  for (const expected of expectedActions) {
    await branch.click();
    const panel = page.getByRole('region', { name: 'Changed files' });
    await expect(panel).toBeVisible();
    await expect(branch).toHaveAttribute('aria-expanded', 'true');
    await panel.getByRole('button', { name: expected.name, exact: true }).click();
    await expect.poll(() => controls.starts.filter(start => start.actionId === expected.id).length).toBe(1);
    await expect(panel).toHaveCount(0);
    await expect(branch).toHaveAttribute('aria-expanded', 'false');
    await expect(branch).toHaveAttribute('aria-busy', 'true');

    await branch.click();
    const runningAction = page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: expected.name, exact: true });
    await expect(runningAction).toHaveAttribute('aria-busy', 'true');
    await expect(runningAction).toBeDisabled();
    await page.keyboard.press('Escape');
  }

  expect(controls.starts).toHaveLength(2);
  // verify the dispatch contract without executable request data
  for (const expected of expectedActions) {
    const starts = controls.starts.filter(start => start.actionId === expected.id);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ actionId: expected.id, configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'pullRequest', agentId: 'agent-1' });
    expect(starts[0]).not.toHaveProperty('command');
    expect(starts[0]).not.toHaveProperty('prompt');
    expect(starts[0]).not.toHaveProperty('cwd');
  }
});

test('interrupts a delayed action response from an old server boot', async ({ page }) => {
  await mount(page);
  let releaseStart!: () => void;
  const heldStart = new Promise<void>(resolve => { releaseStart = resolve; });
  let posts = 0;
  let postFinished = false;
  // hold the accepted response beyond the next dashboard boot
  await page.route('**/api/button-actions', async route => {
    posts += 1;
    await heldStart;
    await route.fulfill({ status: 202, json: { operation: { id: 'operation-tab-action', state: 'complete' } } });
    postFinished = true;
  });
  const tabAction = page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' });
  await tabAction.click();
  await expect(tabAction).toHaveAttribute('aria-busy', 'true');

  let dashboardReads = 0;
  // publish a new boot through the normal visible-dashboard refresh
  await page.route('**/api/dashboard', route => {
    dashboardReads += 1;
    return route.fulfill({ json: { ...dashboard, generation: 2, serverStartedAt: 18 } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardReads).toBeGreaterThan(0);
  await expect(tabAction).not.toHaveAttribute('aria-busy', 'true');

  releaseStart();
  await expect.poll(() => postFinished).toBe(true);
  // let the retained provider consume the fulfilled old-boot response
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.operation-feedback').filter({ hasText: 'Tab action finished' })).toHaveCount(0);
  expect(posts).toBe(1);
});

// preserve the current draft while opening an agent action for editing
test('stages an existing-agent prompt from a panel action without submitting it', async ({ page }) => {
  const prepared = 'Review the current diff, then wait for approval.';
  const controls = await mount(page, { draft: body => ({ json: { draft: { kind: 'prompt', text: prepared, placeId: String(body.placeId), agentId: String(body.agentId) } } }) });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this context');

  const agentAction = page.locator('.agent-panel .panel-header-actions').getByRole('button', { name: 'Agent action' });
  await editBeforeSubmit(page, agentAction, () => {
    // opening the menu must not prepare or execute its source action
    expect(controls.drafts).toEqual([]);
    expect(controls.starts).toEqual([]);
    expect(controls.prompts).toEqual([]);
  });

  await expect(prompt).toHaveValue(`Keep this context\n\n${prepared}`);
  await expect(prompt).toBeFocused();
  expect(controls.drafts).toEqual([{ actionId: 'agent-action', configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'split:agent', agentId: 'agent-1' }]);
  expect(controls.starts).toEqual([]);
  expect(controls.prompts).toEqual([]);
  expect(JSON.stringify(controls.state.dashboard)).not.toContain(prepared);
});

// carry agentless text into the newly launched agent without submitting
test('preserves an agentless worktree draft when a prepared prompt launches its agent', async ({ page }) => {
  const prepared = 'Inspect the failing build and report the cause.';
  const existing = 'Keep the prior investigation notes';
  const launched = { ...dashboard.agents[0]!, id: 'agent-2', sessionId: 'socket:$2', title: 'Starting' };
  const controls = await mount(page, {
    agents: [],
    worktreePrompt: 'Open the pending composer',
    draft: (_body, state) => {
      // expose the agent only after preparation starts it
      state.dashboard.agents = [launched];
      return { json: { draft: { kind: 'prompt', text: prepared, placeId: worktree.id, agentId: launched.id } } };
    }
  });
  const readsBeforeDraft = controls.dashboardReads();
  const pendingPrompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(pendingPrompt).toBeVisible();
  await pendingPrompt.fill(existing);

  await page.getByRole('button', { name: 'More options' }).click();
  await editBeforeSubmit(page, page.getByRole('button', { name: 'Menu action' }), () => {
    // a configured list menu is inert until its explicit edit row is selected
    expect(controls.drafts).toEqual([]);
    expect(controls.starts).toEqual([]);
    expect(controls.prompts).toEqual([]);
  });

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveValue(`${existing}\n\n${prepared}`);
  await expect(prompt).toBeFocused();
  await expect.poll(controls.dashboardReads).toBeGreaterThan(readsBeforeDraft);
  expect(controls.drafts).toEqual([{ actionId: 'menu-action', configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'navMenu' }]);
  expect(controls.starts).toEqual([]);
  expect(controls.prompts).toEqual([]);
  expect(JSON.stringify(controls.state.dashboard)).not.toContain(prepared);
});

// accept only the exact agent discovered during this preparation
test('accepts a launched agent published before its held draft response', async ({ page }) => {
  const prepared = 'Continue from the newly discovered session.';
  const launched = { ...dashboard.agents[0]!, id: 'agent-early', sessionId: 'socket:$early', title: 'Ready' };
  let markDraftStarted!: () => void;
  let releaseDraft!: () => void;
  const draftStarted = new Promise<void>(resolve => { markDraftStarted = resolve; });
  const heldDraft = new Promise<void>(resolve => { releaseDraft = resolve; });
  const controls = await mount(page, {
    agents: [],
    draft: async (_body, state) => {
      // publish discovery before the request carrying trusted bytes completes
      state.dashboard.agents = [launched];
      markDraftStarted();
      await heldDraft;
      return { json: { draft: { kind: 'prompt', text: prepared, placeId: worktree.id, agentId: launched.id } } };
    }
  });

  await page.getByRole('button', { name: 'More options' }).click();
  const editing = editBeforeSubmit(page, page.getByRole('button', { name: 'Menu action' }));
  await draftStarted;
  const readsBeforeRefresh = controls.dashboardReads();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(controls.dashboardReads).toBeGreaterThan(readsBeforeRefresh);
  const prompt = page.locator(`textarea[data-prompt-id="${launched.id}"]`);
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue('');

  releaseDraft();
  await editing;
  await expect(prompt).toHaveValue(prepared);
  await expect(prompt).toBeFocused();
  expect(controls.starts).toEqual([]);
  expect(controls.prompts).toEqual([]);
});

// edit a normal prompt without answering the active question
test('reveals the normal prompt when editing an action during a structured question', async ({ page }) => {
  const prepared = 'Use this as a normal follow-up instead.';
  const controls = await mount(page, { draft: () => ({ json: { draft: { kind: 'prompt', text: prepared, placeId: worktree.id, agentId: 'agent-1' } } }) });
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushQuestion(page, 'agent-1', { id: 'configured-question', text: 'Which path?', field: { kind: 'choice', choices: ['First', 'Second'] }, source: 'structured' });
  await expect(page.getByRole('region', { name: 'Agent question' })).toBeVisible();

  await editBeforeSubmit(page, page.locator('.agent-panel .panel-header-actions').getByRole('button', { name: 'Agent action' }));

  const prompt = page.locator('textarea[data-prompt-id="agent-1"]');
  await expect(prompt).toHaveValue(prepared);
  await expect(prompt).toBeFocused();
  await expect(page.getByRole('button', { name: 'Switch to answer mode' })).toBeVisible();
  expect(controls.answers).toEqual([]);
  expect(controls.prompts).toEqual([]);
  expect(controls.starts).toEqual([]);
});

// keep multiline bytes out of the shell until explicit submission
test('creates a terminal editor for multiline shell bytes and sends only the explicit edited submission', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const prepared = 'printf "one\\n"\nprintf "two\\n"\n';
  const edited = 'printf "edited\\n"\nprintf "two\\n"\n';
  const created = buildPane('%9', 'draft shell', '@9');
  const controls = await mount(page, {
    createdPane: created,
    draft: () => ({ json: { draft: { kind: 'shell', text: prepared, placeId: worktree.id } } })
  });

  await editBeforeSubmit(page, page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' }));
  await expect.poll(() => controls.shellCreates.length).toBe(1);
  await seedPaneSize(page, created.paneId, 80, 24);

  const terminal = page.locator(`.terminal-pane[data-panel-key="${created.paneId}"]`);
  const command = terminal.getByRole('textbox', { name: 'Terminal command' });
  await expect(command).toHaveValue(prepared);
  await expect(command).toBeFocused();
  await expect(terminal.getByRole('button', { name: 'Submit command' })).toBeVisible();
  await expect(terminal.getByRole('button', { name: 'Cancel command edit' })).toBeVisible();
  expect(await paneInputText(page, created.paneId)).toBe('');
  await command.fill(edited);
  await expect(command).toHaveValue(edited);
  expect(await paneInputText(page, created.paneId)).toBe('');

  await terminal.getByRole('button', { name: 'Submit command' }).click();
  await expect.poll(() => paneInputText(page, created.paneId)).toBe(`${edited}\r`);
  await expect(command).toHaveCount(0);
  expect(controls.drafts).toEqual([{ actionId: 'tab-action', configRevision: 'buttons-v1', placeId: 'wt-1', slot: 'tabLead', agentId: 'agent-1' }]);
  expect(controls.starts).toEqual([]);
  expect(controls.prompts).toEqual([]);
  expect(JSON.stringify(controls.state.dashboard)).not.toContain(prepared);
});

// reject oversized edits and appends without losing existing input
test('keeps terminal edits within the shared utf-8 byte limit without sending or truncating', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const pane = buildPane('%5', 'build', '@5');
  let draftCalls = 0;
  const controls = await mount(page, {
    panes: [pane],
    storedTerminals: [{ paneId: pane.paneId, name: pane.name }],
    draft: () => {
      // make the second preparation test total append size
      draftCalls += 1;
      return { json: { draft: { kind: 'shell', text: draftCalls === 1 ? 'echo base' : 'echo next', placeId: worktree.id } } };
    }
  });
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, pane.paneId, 80, 24);
  await editBeforeSubmit(page, page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' }));
  const panel = page.locator(`.terminal-pane[data-panel-key="${pane.paneId}"]`);
  const command = panel.getByRole('textbox', { name: 'Terminal command' });
  await expect(command).toHaveValue('echo base');

  await command.fill('x'.repeat(262_145));
  await expect(command).toHaveValue('echo base');
  await expect(panel.getByRole('alert')).toContainText('Commands are limited to 256 KiB');
  await command.fill('é'.repeat(131_073));
  await expect(command).toHaveValue('echo base');
  await expect(panel.getByRole('alert')).toContainText('Commands are limited to 256 KiB');
  await command.fill('x'.repeat(262_144));
  await expect.poll(() => command.evaluate((element: HTMLTextAreaElement) => element.value.length)).toBe(262_144);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await command.fill('x'.repeat(262_143));
  await expect.poll(() => command.evaluate((element: HTMLTextAreaElement) => element.value.length)).toBe(262_143);
  expect(await paneInputText(page, pane.paneId)).toBe('');

  await editBeforeSubmit(page, page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' }));
  await expect.poll(() => controls.drafts.length).toBe(2);
  await expect.poll(() => command.evaluate((element: HTMLTextAreaElement) => element.value.length)).toBe(262_143);
  await expect(page.getByRole('alert').filter({ hasText: 'Tab action could not be edited' })).toContainText('Commands are limited to 256 KiB');
  expect(await paneInputText(page, pane.paneId)).toBe('');
  expect(controls.shellCreates).toEqual([]);
  expect(controls.starts).toEqual([]);
});

// route folded header actions to their exact terminal
test('targets a folded terminal-header action exactly and otherwise reuses the current terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const build = buildPane('%5', 'build', '@5');
  const testPane = buildPane('%6', 'tests', '@6');
  const controls = await mount(page, {
    panes: [build, testPane],
    storedTerminals: [{ paneId: build.paneId, name: build.name }, { paneId: testPane.paneId, name: testPane.name }],
    draft: body => ({ json: { draft: { kind: 'shell', text: body.actionId === 'terminal-action' ? 'npm run build' : 'npm test', placeId: worktree.id } } })
  });
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, build.paneId, 80, 24);
  await seedPaneSize(page, testPane.paneId, 80, 24);
  const buildPanel = page.locator(`.terminal-pane[data-panel-key="${build.paneId}"]`);
  const testPanel = page.locator(`.terminal-pane[data-panel-key="${testPane.paneId}"]`);

  await testPanel.locator('.xterm-screen').click();
  await expect(testPanel).toHaveClass(/\bfocused\b/u);
  const folded = buildPanel.getByRole('button', { name: 'More terminal build actions' });
  await expect(folded).toBeVisible();
  await folded.evaluate(element => (element as HTMLButtonElement).click());
  const terminalAction = page.getByRole('button', { name: 'Terminal action' });
  await terminalAction.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Edit before submit', exact: true }).click();

  await expect(buildPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveValue('npm run build');
  await expect(testPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveCount(0);
  await buildPanel.getByRole('button', { name: 'Cancel command edit' }).click();

  await testPanel.locator('.xterm-screen').click();
  await editBeforeSubmit(page, page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' }));
  await expect(testPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveValue('npm test');
  await expect(buildPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveCount(0);
  expect(await paneInputText(page, build.paneId)).toBe('');
  expect(await paneInputText(page, testPane.paneId)).toBe('');
  expect(controls.shellCreates).toEqual([]);
  expect(controls.starts).toEqual([]);
});

// fail closed when the captured terminal disappears
test('does not redirect a vanished terminal-header target into another pane', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const build = buildPane('%5', 'build', '@5');
  const testPane = buildPane('%6', 'tests', '@6');
  const controls = await mount(page, {
    panes: [build, testPane],
    storedTerminals: [{ paneId: build.paneId, name: build.name }, { paneId: testPane.paneId, name: testPane.name }],
    draft: (_body, state) => {
      // remove the captured pane before the client resolves its exact destination
      state.panes = [testPane];
      return { json: { draft: { kind: 'shell', text: 'npm run build', placeId: worktree.id } } };
    }
  });
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, build.paneId, 80, 24);
  await seedPaneSize(page, testPane.paneId, 80, 24);
  const buildPanel = page.locator(`.terminal-pane[data-panel-key="${build.paneId}"]`);
  const testPanel = page.locator(`.terminal-pane[data-panel-key="${testPane.paneId}"]`);
  const folded = buildPanel.getByRole('button', { name: 'More terminal build actions' });
  await folded.evaluate(element => (element as HTMLButtonElement).click());

  await editBeforeSubmit(page, page.getByRole('button', { name: 'Terminal action' }));

  await expect(page.getByRole('alert').filter({ hasText: 'Terminal action could not be edited' })).toContainText('selected terminal is no longer available');
  await expect(buildPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveCount(0);
  await expect(testPanel.getByRole('textbox', { name: 'Terminal command' })).toHaveCount(0);
  expect(await paneInputText(page, build.paneId)).toBe('');
  expect(await paneInputText(page, testPane.paneId)).toBe('');
  expect(controls.shellCreates).toEqual([]);
  expect(controls.starts).toEqual([]);
});

// discard old terminal identities after a confirmed server restart
test('clears a staged terminal command when the dashboard changes server boot', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const pane = buildPane('%5', 'build', '@5');
  const controls = await mount(page, {
    panes: [pane],
    storedTerminals: [{ paneId: pane.paneId, name: pane.name }],
    draft: () => ({ json: { draft: { kind: 'shell', text: 'echo old boot', placeId: worktree.id } } })
  });
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, pane.paneId, 80, 24);
  const stagingRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard' && response.request().method() === 'GET');
  await editBeforeSubmit(page, page.locator('.tab-row-lead').getByRole('button', { name: 'Tab action' }));
  const panel = page.locator(`.terminal-pane[data-panel-key="${pane.paneId}"]`);
  const command = panel.getByRole('textbox', { name: 'Terminal command' });
  await expect(command).toHaveValue('echo old boot');
  expect(await paneInputText(page, pane.paneId)).toBe('');
  const stagingResponse = await stagingRefresh;
  await stagingResponse.finished();
  // let refresh release its in-flight coalescing guard
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const readsBeforeBoot = controls.dashboardReads();
  controls.state.dashboard.serverStartedAt = 18;
  controls.state.dashboard.generation = 2;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(controls.dashboardReads).toBeGreaterThan(readsBeforeBoot);
  await expect(command).toHaveCount(0);
  expect(await paneInputText(page, pane.paneId)).toBe('');
  expect(controls.starts).toEqual([]);
});

// reject both transport failures and stale trusted-byte envelopes
for (const scenario of [
  { name: 'failed preparation', result: { status: 409, json: { error: 'button_config_stale' } } },
  { name: 'retargeted response', result: { json: { draft: { kind: 'prompt', text: 'must not stage', placeId: 'wt-stale', agentId: 'agent-1' } } } }
] as const) {
  // failed preparation must leave the current editor unchanged
  test(`does not stage or execute a prompt after a ${scenario.name}`, async ({ page }) => {
    const controls = await mount(page, { draft: () => scenario.result });
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Existing draft');

    await editBeforeSubmit(page, page.locator('.agent-panel .panel-header-actions').getByRole('button', { name: 'Agent action' }));

    await expect(prompt).toHaveValue('Existing draft');
    await expect(page.getByRole('alert').filter({ hasText: 'Agent action could not be edited' })).toBeVisible();
    expect(controls.starts).toEqual([]);
    expect(controls.prompts).toEqual([]);
  });
}
