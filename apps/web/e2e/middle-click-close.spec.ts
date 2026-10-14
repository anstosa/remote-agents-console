import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

type Attention = 'working' | 'finished' | 'question';
type Agent = {
  id: string;
  sessionId: string;
  home: string;
  placeId: string;
  title: string;
  kind: 'claude' | 'codex';
  attention: Attention;
  queuedPromptCount: number;
  displayLabel?: string;
  worktreeId?: string;
  worktreeLabel?: string;
  worktreeOrder?: number;
  projectId?: string;
  branch?: string;
  projectUrl?: string;
};
type Pane = { paneId: string; session: string; window: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
type Worktree = { id: string; projectId: string; label: string; path: string; available: boolean; pinned: boolean; order: number; branch: string; projectUrl?: string; launch?: { kind: 'codex'; origin: 'worktree' } };
type Place = { id: string; kind: 'directory' | 'scratch'; projectId: string; label: string; home: string; pinned: boolean; consoleShells?: number };
type Project = { id: string; label: string; available: boolean; worktrees: Worktree[]; mode?: 'directory'; manageWorktrees?: boolean; launch?: { kind: 'codex'; origin: 'project' } };
type LifecycleRequest = { method: string; path: string; contentType: string | undefined; body: string | null };
type Scenario = {
  agents: Agent[];
  projects: Project[];
  places?: Place[];
  panes: Record<string, Pane[]>;
  editor?: boolean;
  notes?: Record<string, Array<{ id: string; text: string; title?: string }>>;
  deletePane?: (pane: Pane, request: LifecycleRequest, attempt: number) => number | Promise<number>;
  turnOffAgent?: (agent: Agent, request: LifecycleRequest, attempt: number) => number | Promise<number>;
  competingOperation?: (kind: 'launch' | 'restart' | 'clear', request: LifecycleRequest, attempt: number) => number | Promise<number>;
  createShell?: (kind: 'shell' | 'editor', request: LifecycleRequest, attempt: number) => number | Promise<number>;
  runNote?: (placeId: string, noteId: string, request: LifecycleRequest, attempt: number) => { status: number; agentId?: string } | Promise<{ status: number; agentId?: string }>;
  restartReplacementId?: string;
  controlLost?: boolean;
};

type ConsoleHarness = {
  lifecycle: LifecycleRequest[];
  destructive: LifecycleRequest[];
  paneAttempts: Map<string, number>;
  agentAttempts: Map<string, number>;
  operationAttempts: Map<string, number>;
  shellAttempts: Map<string, number>;
  noteRunAttempts: Map<string, number>;
};

// allow the first browser load to transform the dashboard bundle
test.describe.configure({ timeout: 60_000 });

const cora: Worktree = { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0, branch: 'cora', projectUrl: 'https://preview.example/', launch: { kind: 'codex', origin: 'worktree' } };
const delta: Worktree = { id: 'delta', projectId: 'repo', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1, branch: 'delta', launch: { kind: 'codex', origin: 'worktree' } };

// build one configured worktree agent
const worktreeAgent = (id: string, worktree: Worktree, attention: Attention = 'finished', kind: Agent['kind'] = 'codex'): Agent => ({
  id,
  sessionId: `socket:$${id}`,
  home: worktree.path,
  placeId: worktree.id,
  worktreeId: worktree.id,
  worktreeLabel: worktree.label,
  worktreeOrder: worktree.order,
  projectId: worktree.projectId,
  branch: worktree.branch,
  projectUrl: worktree.projectUrl,
  title: 'Ready',
  kind,
  attention,
  queuedPromptCount: 0
});

// build one directory or scratch agent
const placeAgent = (id: string, place: Place): Agent => ({
  id,
  sessionId: `socket:$${id}`,
  home: place.home,
  placeId: place.id,
  projectId: place.kind === 'directory' ? place.projectId : undefined,
  displayLabel: place.label,
  title: 'Ready',
  kind: 'codex',
  attention: 'finished',
  queuedPromptCount: 0
});

// read one required route capture
const routeCapture = (match: RegExpExecArray, index: number) => {
  const capture = match[index];
  // reject incomplete fixture routes
  if (capture === undefined) throw new Error(`Missing route capture ${index} for ${match[0]}`);
  return decodeURIComponent(capture);
};

// provide the dashboard, pane APIs and lifecycle transport for one scenario
const routeApi = async (page: Page, scenario: Scenario): Promise<ConsoleHarness> => {
  const lifecycle: LifecycleRequest[] = [];
  const destructive: LifecycleRequest[] = [];
  const paneAttempts = new Map<string, number>();
  const agentAttempts = new Map<string, number>();
  const operationAttempts = new Map<string, number>();
  const shellAttempts = new Map<string, number>();
  const noteRunAttempts = new Map<string, number>();
  await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'text/html', body: '<main>project preview</main>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // authenticate the browser
    if (path === '/api/auth/session') return route.fulfill({ json: scenario.controlLost === true
      ? { csrfToken: 'csrf-token', active: false, deviceName: 'Test device', controllingDeviceName: 'Other device' }
      : { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // reclaim mocked control without authenticating a real console
    if (path === '/api/auth/take-control' && request.method() === 'POST') {
      scenario.controlLost = false;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', controllingDeviceName: 'Test device' } });
    }
    // expose mutable agents and shell counts
    if (path === '/api/dashboard') {
      // unmount the dashboard through its real inactive-control boundary
      if (scenario.controlLost === true) return route.fulfill({ status: 423, json: { error: 'another device is active' } });
      const places = scenario.places?.map(place => ({ ...place, consoleShells: scenario.panes[place.id]?.filter(pane => pane.role === 'shell' && !pane.agent).length ?? 0 }));
      const adapters = { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
      return route.fulfill({ json: { generation: lifecycle.length + 1, adapters, agents: scenario.agents, projects: scenario.projects, ...(places === undefined ? {} : { places }), ...(scenario.editor === true ? { editor: true } : {}) } });
    }
    // disable push setup
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });

    const agentResource = /^\/api\/agents\/([^/]+)(?:\/(.+))?$/u.exec(path);
    // serve agent-local reads
    if (agentResource !== null) {
      const id = routeCapture(agentResource, 1);
      const rest = agentResource[2];
      if (rest === 'tickets') return route.fulfill({ json: { ticket: `ticket-${id}` } });
      if (rest === 'saved-prompts' || rest === 'queued-prompts' || rest === 'prompt-history') return route.fulfill({ json: { prompts: [] } });
      if (rest === 'conversation') return route.fulfill({ json: { name: `Conversation ${id}` } });
      if (rest === 'commands') return route.fulfill({ json: { commands: [] } });
      if (rest === 'notifications/dismiss') return route.fulfill({ status: 204 });

      const agent = scenario.agents.find(candidate => candidate.id === id);
      const operation = rest === 'restart' ? 'restart' : rest === 'prompt' ? 'clear' : undefined;
      // exercise competing agent mutations through their real endpoints
      if (agent !== undefined && operation !== undefined && request.method() === 'POST') {
        const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
        lifecycle.push(capture);
        const attempt = (operationAttempts.get(operation) ?? 0) + 1;
        operationAttempts.set(operation, attempt);
        const status = await (scenario.competingOperation?.(operation, capture, attempt) ?? (operation === 'restart' ? 201 : 204));
        if (status < 200 || status >= 300) return route.fulfill({ status, json: { error: `${operation} failed` } });
        if (operation === 'restart') {
          // model the old agent disappearing before its replacement is discovered
          scenario.agents.splice(scenario.agents.indexOf(agent), 1);
          return route.fulfill({ status, json: { agentId: scenario.restartReplacementId ?? `${id}-restarted` } });
        }
        return route.fulfill({ status });
      }
      const configured = rest === 'deactivate';
      const transient = rest === undefined;
      // handle only the configured POST or transient DELETE shutdown boundary
      if (agent !== undefined && (configured || transient)) {
        const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
        lifecycle.push(capture);
        const validMethod = configured ? request.method() === 'POST' : request.method() === 'DELETE';
        if (!validMethod) return route.fulfill({ status: 405, json: { error: 'wrong method' } });
        const attempt = (agentAttempts.get(id) ?? 0) + 1;
        agentAttempts.set(id, attempt);
        const status = await (scenario.turnOffAgent?.(agent, capture, attempt) ?? 204);
        // retain failed agents for a visible retry
        if (status >= 200 && status < 300) scenario.agents.splice(scenario.agents.indexOf(agent), 1);
        return route.fulfill(status === 204 ? { status } : { status, json: { error: 'turn off failed' } });
      }
    }

    const worktreeLaunch = /^\/api\/worktrees\/(.+)\/launch$/u.exec(path);
    // exercise toolbar launch through the existing worktree endpoint
    if (worktreeLaunch !== null && request.method() === 'POST') {
      const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
      lifecycle.push(capture);
      const attempt = (operationAttempts.get('launch') ?? 0) + 1;
      operationAttempts.set('launch', attempt);
      const status = await (scenario.competingOperation?.('launch', capture, attempt) ?? 201);
      if (status < 200 || status >= 300) return route.fulfill({ status, json: { error: 'launch failed' } });
      return route.fulfill({ status, json: { agentId: 'launched-agent' } });
    }

    const paneList = /^\/api\/worktrees\/(.+)\/panes$/u.exec(path);
    // list every pane at the exact place
    if (paneList !== null && request.method() === 'GET') {
      const placeId = routeCapture(paneList, 1);
      return route.fulfill({ json: { panes: scenario.panes[placeId] ?? [] } });
    }
    const ticket = /^\/api\/worktrees\/(.+)\/tickets$/u.exec(path);
    if (ticket !== null) return route.fulfill({ json: { ticket: 'pane-ticket' } });
    const shellCreate = /^\/api\/worktrees\/(.+)\/shells$/u.exec(path);
    // create a regular or editor shell through the shared endpoint
    if (shellCreate !== null && request.method() === 'POST') {
      const placeId = routeCapture(shellCreate, 1);
      const body = request.postDataJSON() as { editor?: boolean } | null;
      const kind = body?.editor === true ? 'editor' : 'shell';
      const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
      lifecycle.push(capture);
      const attempt = (shellAttempts.get(kind) ?? 0) + 1;
      shellAttempts.set(kind, attempt);
      const status = await (scenario.createShell?.(kind, capture, attempt) ?? 201);
      if (status < 200 || status >= 300) return route.fulfill({ status, json: { error: `${kind} create failed` } });
      const paneId = kind === 'editor' ? '%12' : '%11';
      scenario.panes[placeId] ??= [];
      scenario.panes[placeId].push({ paneId, session: '$new', window: kind === 'editor' ? '@12' : '@11', role: 'shell', name: kind, command: kind === 'editor' ? 'code' : 'zsh', path: scenario.agents.find(agent => agent.placeId === placeId)?.home ?? '', title: '', agent: false, busy: false });
      return route.fulfill({ status, json: { paneId } });
    }
    const notes = /^\/api\/worktrees\/(.+)\/notes$/u.exec(path);
    // return persisted notes without granting deletion
    if (notes !== null && request.method() === 'GET') {
      const placeId = routeCapture(notes, 1);
      return route.fulfill({ json: { notes: scenario.notes?.[placeId] ?? [] } });
    }
    const noteRun = /^\/api\/worktrees\/(.+)\/notes\/([^/]+)\/run$/u.exec(path);
    // launch an agent from one persisted note
    if (noteRun !== null && request.method() === 'POST') {
      const placeId = routeCapture(noteRun, 1);
      const noteId = routeCapture(noteRun, 2);
      const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
      const attempt = (noteRunAttempts.get(placeId) ?? 0) + 1;
      noteRunAttempts.set(placeId, attempt);
      const result = await (scenario.runNote?.(placeId, noteId, capture, attempt) ?? { status: 201, agentId: 'note-agent' });
      if (result.status < 200 || result.status >= 300) return route.fulfill({ status: result.status, json: { error: 'note run failed' } });
      return route.fulfill({ status: result.status, json: { agentId: result.agentId ?? 'note-agent' } });
    }
    const paneResource = /^\/api\/worktrees\/(.+)\/panes\/([^/]+)$/u.exec(path);
    // delete only a managed pane through the existing transport
    if (paneResource !== null && request.method() === 'DELETE') {
      const placeId = routeCapture(paneResource, 1);
      const paneId = routeCapture(paneResource, 2);
      const capture = { method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() };
      lifecycle.push(capture);
      const panes = scenario.panes[placeId] ?? [];
      const pane = panes.find(candidate => candidate.paneId === paneId);
      if (pane === undefined) return route.fulfill({ status: 404, json: { error: 'missing pane' } });
      const attempt = (paneAttempts.get(paneId) ?? 0) + 1;
      paneAttempts.set(paneId, attempt);
      let status = await (scenario.deletePane?.(pane, capture, attempt) ?? (pane.busy && url.searchParams.get('confirm') !== '1' ? 409 : 204));
      // report a busy conflict for stale shell state
      if (status === 409) return route.fulfill({ status, json: { error: 'busy shell', busy: true } });
      // remove only successful panes
      if (status >= 200 && status < 300) panes.splice(panes.indexOf(pane), 1);
      return route.fulfill(status === 204 ? { status } : { status, json: { error: 'delete failed' } });
    }

    // record forbidden worktree and note deletion attempts
    if (request.method() === 'DELETE' && (/^\/api\/worktrees\/[^/]+$/u.test(path) || /\/notes\//u.test(path))) {
      destructive.push({ method: request.method(), path: `${path}${url.search}`, contentType: request.headers()['content-type'], body: request.postData() });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return { lifecycle, destructive, paneAttempts, agentAttempts, operationAttempts, shellAttempts, noteRunAttempts };
};

// mount the dashboard with deterministic pane streams
const mountConsole = async (page: Page, scenario: Scenario, hash = '') => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installPaneMock(page);
  const harness = await routeApi(page, scenario);
  await page.goto(`/${hash}`);
  return harness;
};

// open one console shell as a terminal split
const openShell = async (page: Page, name: string, paneId: string): Promise<Locator> => {
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: new RegExp(name, 'u') }).click();
  await seedPaneSize(page, paneId, 80, 24);
  const terminal = page.locator(`.terminal-pane[data-panel-key="${paneId}"]`);
  await expect(terminal).toBeVisible();
  return terminal;
};

// attempt one power action unless the shared operation disables the whole control
const attemptPowerAction = async (page: Page, name: 'Clear' | 'Restart') => {
  const power = page.getByRole('button', { name: 'Agent power options' });
  // a disabled control is an equally safe refusal
  if (await power.isDisabled()) {
    await expect(power).toBeDisabled();
    return;
  }
  await power.click();
  const menu = page.getByRole('menu', { name: 'Agent power options' });
  await menu.getByRole('menuitem', { name, exact: true }).click({ force: true });
  // release the portal backdrop before the next attempted action
  await page.keyboard.press('Escape');
  await expect(page.locator('.flyout-backdrop')).toHaveCount(0);
};

// read only lifecycle mutations
const mutations = (harness: ConsoleHarness) => harness.lifecycle.map(request => `${request.method} ${decodeURIComponent(request.path)}`);

test('middle-clicking a worktree tab stops every idle agent and managed shell, then closes its panels', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('cora-2', cora, 'finished', 'claude'), worktreeAgent('delta-1', delta)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora, delta] }],
    panes: {
      cora: [
        { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: cora.path, title: '', agent: true },
        { paneId: '%2', session: '$2', window: '@1', command: 'claude', path: cora.path, title: '', agent: true },
        { paneId: '%5', session: '$1', window: '@2', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false },
        { paneId: '%9', session: '$1', window: '@3', role: 'shell', name: 'watch', command: 'zsh', path: cora.path, title: '', agent: false, busy: false },
        { paneId: '%6', session: '$1', window: '@4', command: 'vim', path: cora.path, title: '', agent: false }
      ],
      delta: [{ paneId: '%3', session: '$3', window: '@0', command: 'codex', path: delta.path, title: '', agent: true }]
    },
    notes: { cora: [{ id: 'note-1', title: 'Persistent note', text: 'keep this note' }] }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  await openShell(page, 'build', '%5');
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Persistent note', exact: true }).click();
  await expect(page.locator('.terminal-pane, .browser-pane, .note-pane')).toHaveCount(3);

  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });

  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toEqual(expect.arrayContaining([
    'DELETE /api/worktrees/cora/panes/%5',
    'DELETE /api/worktrees/cora/panes/%9',
    'POST /api/agents/cora-1/deactivate',
    'POST /api/agents/cora-2/deactivate'
  ]));
  expect(mutations(harness)).not.toEqual(expect.arrayContaining([
    'DELETE /api/worktrees/cora/panes/%6',
    'POST /api/agents/delta-1/deactivate'
  ]));
  const agentRequests = harness.lifecycle.filter(request => request.path.includes('/api/agents/cora-'));
  expect(agentRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', contentType: 'application/json', body: '{}' }),
    expect.objectContaining({ method: 'POST', contentType: 'application/json', body: '{}' })
  ]));
  await expect(page.locator('.terminal-pane, .browser-pane, .note-pane')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
  expect(harness.destructive).toEqual([]);
  expect(scenario.notes?.cora).toEqual([{ id: 'note-1', title: 'Persistent note', text: 'keep this note' }]);
});

test('middle-clicking browser chrome closes its split while iframe clicks stay inside the preview', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [] }
  };
  await mountConsole(page, scenario, '#agent=cora-1');
  const browserButton = page.getByRole('button', { name: 'Browser', exact: true });

  await browserButton.click();
  const browser = page.locator('.browser-pane');
  await expect(browser).toBeVisible();
  await browser.locator('.panel-header-title').click({ button: 'middle' });
  await expect(browser).toHaveCount(0);

  await browserButton.click();
  await expect(browser).toBeVisible();
  await page.frameLocator('iframe[title="Project browser"]').getByText('project preview', { exact: true }).click({ button: 'middle' });
  await expect(browser).toBeVisible();
});

test('middle-clicking an inactive worktree shuts it down without changing the active tab', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('delta-1', delta)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora, delta] }],
    panes: {
      cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }],
      delta: []
    }
  };
  const harness = await mountConsole(page, scenario, '#agent=delta-1');
  const deltaTab = page.getByRole('tab', { name: /^Delta —/u });
  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });

  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toEqual(expect.arrayContaining([
    'DELETE /api/worktrees/cora/panes/%5',
    'POST /api/agents/cora-1/deactivate'
  ]));
  await expect(deltaTab).toHaveAttribute('aria-selected', 'true');
  expect(mutations(harness)).not.toContain('POST /api/agents/delta-1/deactivate');
});

test('an inactive workspace shutdown failure stays visible without selecting that tab', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('delta-1', delta)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora, delta] }],
    panes: {
      cora: [],
      delta: [{ paneId: '%5', session: '$2', window: '@1', role: 'shell', name: 'delta-build', command: 'zsh', path: delta.path, title: '', agent: false, busy: false }]
    },
    turnOffAgent: agent => agent.id === 'delta-1' ? 500 : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const coraTab = page.getByRole('tab', { name: /^Cora —/u });
  await expect(coraTab).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: /^Delta —/u }).click({ button: 'middle' });

  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);
  await expect.poll(() => harness.agentAttempts.get('delta-1')).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: 'Delta could not be turned off' })).toBeVisible();
  await expect(coraTab).toHaveAttribute('aria-selected', 'true');
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();
  expect(scenario.agents.map(agent => agent.id)).toContain('delta-1');
  expect(scenario.panes.delta).toEqual([]);
});

test('an active scratch workspace shutdown failure remains visible and leaves its session open', async ({ page }) => {
  const scratch: Place = { id: 'scratch:/tmp/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/tmp/scratch', pinned: true };
  const scenario: Scenario = {
    agents: [placeAgent('scratch-1', scratch)],
    projects: [],
    places: [scratch],
    panes: { [scratch.id]: [] },
    turnOffAgent: () => 500
  };
  const harness = await mountConsole(page, scenario, '#agent=scratch-1');
  const tab = page.getByRole('tab', { name: /^~ Scratch —/u });

  await tab.click({ button: 'middle' });

  await expect.poll(() => harness.agentAttempts.get('scratch-1')).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: '~ Scratch could not be turned off' })).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.agent-panel')).toBeVisible();
  expect(scenario.agents.map(agent => agent.id)).toEqual(['scratch-1']);
});

test('cancelling a busy-shell workspace shutdown performs no partial mutation', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('cora-2', cora, 'finished', 'claude')],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: {
      cora: [
        { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false },
        { paneId: '%8', session: '$1', window: '@2', role: 'shell', name: 'server', command: 'node', path: cora.path, title: '', agent: false, busy: true }
      ]
    }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs += 1; void dialog.dismiss(); });

  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });

  await expect.poll(() => dialogs).toBe(1);
  await page.waitForTimeout(100);
  expect(mutations(harness)).toEqual([]);
  expect(scenario.agents.map(agent => agent.id)).toEqual(['cora-1', 'cora-2']);
  expect(scenario.panes.cora?.map(pane => pane.paneId)).toEqual(['%5', '%8']);
  await expect(page.locator('.agent-panel')).toBeVisible();
});

test('duplicate workspace middle-clicks coalesce while a terminal deletion is pending', async ({ page }) => {
  let finishDelete!: (status: number) => void;
  const heldDelete = new Promise<number>(resolve => { finishDelete = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    deletePane: (_pane, _request, attempt) => attempt === 1 ? heldDelete : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const tab = page.getByRole('tab', { name: /^Cora —/u });

  await tab.click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);
  await tab.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.paneAttempts.get('%5')).toBe(1);
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();

  finishDelete(204);
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
});

test('pending workspace shutdown blocks launch, restart and clear mutations', async ({ page }) => {
  let finishDelete!: (status: number) => void;
  const heldDelete = new Promise<number>(resolve => { finishDelete = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    deletePane: (_pane, _request, attempt) => attempt === 1 ? heldDelete : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);

  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const launch = toolbar.getByRole('button', { name: /^Launch/u }).first();
  // an enabled launch must still refuse at the shared operation boundary
  if (await launch.isEnabled()) await launch.click();
  else await expect(launch).toBeDisabled();
  await attemptPowerAction(page, 'Clear');
  await attemptPowerAction(page, 'Restart');
  await page.waitForTimeout(100);

  expect(harness.operationAttempts.size).toBe(0);
  expect(mutations(harness)).toEqual(['DELETE /api/worktrees/cora/panes/%5']);
  finishDelete(204);
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
});

test('pending launch blocks workspace middle-click shutdown until the launch finishes', async ({ page }) => {
  let finishLaunch!: (status: number) => void;
  const heldLaunch = new Promise<number>(resolve => { finishLaunch = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    competingOperation: (kind, _request, attempt) => kind === 'launch' && attempt === 1 ? heldLaunch : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const tab = page.getByRole('tab', { name: /^Cora —/u });

  await toolbar.getByRole('button', { name: /^Launch/u }).first().click();
  await expect.poll(() => harness.operationAttempts.get('launch')).toBe(1);
  await tab.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.paneAttempts.get('%5')).toBeUndefined();
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();

  finishLaunch(500);
  const operationError = page.getByRole('alert').filter({ hasText: /could not start another agent/u });
  await expect(operationError).toBeVisible();
  await expect(operationError.locator('.toast-timer-bar')).toHaveCount(0);
  await tab.click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
});

test('a successful launch response after control loss releases its workspace scope on remount', async ({ page }) => {
  let finishLaunch!: (status: number) => void;
  const heldLaunch = new Promise<number>(resolve => { finishLaunch = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [] },
    competingOperation: (kind, _request, attempt) => kind === 'launch' && attempt === 1 ? heldLaunch : 201
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: /^Launch/u }).first().click();
  await expect.poll(() => harness.operationAttempts.get('launch')).toBe(1);

  scenario.controlLost = true;
  await expect(page.getByText('Other device is active', { exact: true })).toBeVisible({ timeout: 10_000 });
  finishLaunch(201);
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  const tab = page.getByRole('tab', { name: /^Cora —/u });
  await expect(tab).toBeVisible();

  await tab.click({ button: 'middle' });
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
});

test('restart discovery blocks tab shutdown and hands the current split to the exact replacement', async ({ page }) => {
  const replacementId = 'cora-replacement';
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('cora-sibling', cora, 'finished', 'claude')],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [] },
    restartReplacementId: replacementId
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Restart', exact: true }).click();
  await expect.poll(() => harness.operationAttempts.get('restart')).toBe(1);
  await expect(page.locator('.agent-panel-title')).toHaveText('Conversation cora-sibling');

  const tab = page.getByRole('tab', { name: /^Cora —/u });
  await tab.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();
  expect(harness.agentAttempts.get('cora-sibling')).toBeUndefined();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is off' })).toHaveCount(0);

  scenario.agents.push(worktreeAgent(replacementId, cora));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.agent-panel-title')).toHaveText(`Conversation ${replacementId}`);
  await page.locator('.agent-panel .agent-output').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => harness.agentAttempts.get(replacementId)).toBe(1);
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();
  expect(harness.agentAttempts.get('cora-sibling')).toBeUndefined();
});

test('pending shell creation blocks workspace middle-click shutdown until creation finishes', async ({ page }) => {
  let finishShell!: (status: number) => void;
  const heldShell = new Promise<number>(resolve => { finishShell = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [] },
    createShell: (kind, _request, attempt) => kind === 'shell' && attempt === 1 ? heldShell : 201
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const tab = page.getByRole('tab', { name: /^Cora —/u });

  await toolbar.getByRole('button', { name: 'Open a terminal' }).click();
  await expect.poll(() => harness.shellAttempts.get('shell')).toBe(1);
  // release the terminal flyout before targeting the workspace tab
  await page.keyboard.press('Escape');
  await expect(page.locator('.flyout-backdrop')).toHaveCount(0);
  await tab.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.paneAttempts.size).toBe(0);
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();

  finishShell(500);
  await expect(page.getByRole('menu', { name: 'Open a terminal' }).getByRole('alert')).toContainText('shell create failed');
  await page.keyboard.press('Escape');
  await expect(page.locator('.flyout-backdrop')).toHaveCount(0);
  await tab.click({ button: 'middle' });
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
});

test('pending workspace shutdown blocks new shell and editor creation', async ({ page }) => {
  let finishDelete!: (status: number) => void;
  const heldDelete = new Promise<number>(resolve => { finishDelete = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    editor: true,
    deletePane: (_pane, _request, attempt) => attempt === 1 ? heldDelete : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);

  await toolbar.getByRole('button', { name: 'Open a terminal' }).click({ force: true });
  await page.getByRole('menu', { name: 'Open a terminal' }).getByRole('menuitem', { name: 'New shell', exact: true }).click({ force: true });
  await toolbar.getByRole('button', { name: 'Open the editor' }).click({ force: true });
  await page.waitForTimeout(100);
  expect(harness.shellAttempts.size).toBe(0);
  expect(mutations(harness)).toEqual(['DELETE /api/worktrees/cora/panes/%5']);

  finishDelete(204);
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
});

test('directory and scratch tabs remove their agents with DELETE without activating the target', async ({ page }) => {
  const docs: Place = { id: 'docs:/data/docs', kind: 'directory', projectId: 'docs', label: 'Docs', home: '/data/docs', pinned: true };
  const scratch: Place = { id: 'scratch:/tmp/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/tmp/scratch', pinned: true };
  const scenario: Scenario = {
    agents: [placeAgent('docs-1', docs), placeAgent('scratch-1', scratch)],
    projects: [{ id: 'docs', label: 'Docs', mode: 'directory', manageWorktrees: false, available: true, worktrees: [] }],
    places: [docs, scratch],
    panes: { [docs.id]: [], [scratch.id]: [] }
  };
  const harness = await mountConsole(page, scenario, '#agent=docs-1');
  const docsTab = page.getByRole('tab', { name: /^Docs —/u });
  await expect(docsTab).toHaveAttribute('aria-selected', 'true');

  await docsTab.click({ button: 'middle' });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('DELETE /api/agents/docs-1');
  await expect(docsTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^~ Scratch —/u }).click({ button: 'middle' });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('DELETE /api/agents/scratch-1');
  await expect(docsTab).toHaveAttribute('aria-selected', 'true');

  const removals = harness.lifecycle.filter(request => request.path === '/api/agents/docs-1' || request.path === '/api/agents/scratch-1');
  expect(removals).toEqual([
    expect.objectContaining({ method: 'DELETE', contentType: 'application/json', body: '{}' }),
    expect.objectContaining({ method: 'DELETE', contentType: 'application/json', body: '{}' })
  ]);
});

test('an agentless directory note launch blocks tab shutdown until its exact agent is discovered', async ({ page }) => {
  const docs: Place = { id: 'docs:/data/docs', kind: 'directory', projectId: 'docs', label: 'Docs', home: '/data/docs', pinned: true };
  const launchedId = 'docs-note-agent';
  const scenario: Scenario = {
    agents: [],
    projects: [{ id: 'docs', label: 'Docs', mode: 'directory', manageWorktrees: false, available: true, worktrees: [], launch: { kind: 'codex', origin: 'project' } }],
    places: [docs],
    panes: { [docs.id]: [] },
    notes: { [docs.id]: [{ id: 'note-1', title: 'Directory handoff', text: 'Run after discovery' }] },
    runNote: () => ({ status: 201, agentId: launchedId })
  };
  const harness = await mountConsole(page, scenario);
  const tab = page.getByRole('tab', { name: /^Docs —/u });

  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Launch and run note: Directory handoff', exact: true }).click();
  await expect.poll(() => harness.noteRunAttempts.get(docs.id)).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Docs is running the note' })).toBeVisible();

  await tab.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.agentAttempts.get(launchedId)).toBeUndefined();
  await expect(page.getByRole('status').filter({ hasText: 'Docs is off' })).toHaveCount(0);
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  scenario.agents.push(placeAgent(launchedId, docs));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(page.locator('.agent-panel-title')).toHaveText(`Conversation ${launchedId}`);

  await tab.click({ button: 'middle' });
  await expect.poll(() => harness.agentAttempts.get(launchedId)).toBe(1);
  await expect(page.getByRole('tab', { name: 'Docs — Agent closed' })).toBeVisible();
});

test('middle-clicking the agent split title or body turns off only the current idle agent', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora), worktreeAgent('cora-2', cora, 'finished', 'claude')],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@2', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const terminal = await openShell(page, 'build', '%5');

  await page.locator('.log-output .panel-header-title').click({ button: 'middle' });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('POST /api/agents/cora-1/deactivate');
  await expect(page.locator('.agent-panel-title')).toHaveText('Conversation cora-2');
  await expect(terminal).toBeVisible();
  expect(mutations(harness)).not.toContain('POST /api/agents/cora-2/deactivate');
  expect(mutations(harness)).not.toContain('DELETE /api/worktrees/cora/panes/%5');

  await page.locator('.log-output .agent-output').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('POST /api/agents/cora-2/deactivate');
  await expect(page.locator('.agent-panel')).toHaveCount(0);
  await expect(terminal).toBeVisible();
});

test('a failed agent split middle-click keeps the agent visible and succeeds on retry', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [] },
    turnOffAgent: (_agent, _request, attempt) => attempt === 1 ? 500 : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const agentPanel = page.locator('.agent-panel');

  await agentPanel.locator('.agent-output').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: 'Cora could not be turned off' })).toBeVisible();
  await expect(agentPanel).toBeVisible();

  await agentPanel.locator('.agent-output').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(2);
  await expect(agentPanel).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
});

test('middle-clicking terminal title or body ends managed shells, confirms busy work and ignores unmanaged panes', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: {
      cora: [
        { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false },
        { paneId: '%8', session: '$1', window: '@2', role: 'shell', name: 'server', command: 'node', path: cora.path, title: '', agent: false, busy: true },
        { paneId: '%6', session: '$1', window: '@3', command: 'vim', path: `${cora.path}/src`, title: '', agent: false }
      ]
    }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const build = await openShell(page, 'build', '%5');
  const server = await openShell(page, 'server', '%8');
  const vim = await openShell(page, 'vim', '%6');

  await build.locator('.panel-header-title').click({ button: 'middle' });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('DELETE /api/worktrees/cora/panes/%5');
  await expect(build).toHaveCount(0);

  await vim.locator('.terminal-canvas').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect(vim).toBeVisible();
  expect(mutations(harness)).not.toContain('DELETE /api/worktrees/cora/panes/%6');

  let accept = false;
  let dialogs = 0;
  page.on('dialog', dialog => {
    dialogs += 1;
    // choose the current busy-shell attempt
    if (accept) void dialog.accept();
    else void dialog.dismiss();
  });
  await server.locator('.terminal-canvas').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => dialogs).toBe(1);
  await expect(server).toBeVisible();
  expect(mutations(harness)).not.toContain('DELETE /api/worktrees/cora/panes/%8?confirm=1');

  accept = true;
  await server.locator('.terminal-canvas').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect.poll(() => mutations(harness), { timeout: 5_000 }).toContain('DELETE /api/worktrees/cora/panes/%8?confirm=1');
  await expect(server).toHaveCount(0);
  await expect(vim).toBeVisible();
});

test('a failed terminal middle-click stays open, coalesces duplicates and succeeds on retry', async ({ page }) => {
  let finishFailure!: (status: number) => void;
  const firstAttempt = new Promise<number>(resolve => { finishFailure = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    // hold the first failure so a duplicate can race it
    deletePane: (_pane, _request, attempt) => attempt === 1 ? firstAttempt : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const build = await openShell(page, 'build', '%5');

  await build.click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);
  await build.click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.paneAttempts.get('%5')).toBe(1);

  finishFailure(500);
  await expect(build.getByRole('alert')).toHaveText('Delete failed');
  await expect(build).toBeVisible();
  await build.click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(2);
  await expect(build).toHaveCount(0);
});

test('a standalone terminal deletion blocks workspace shutdown until the deletion finishes', async ({ page }) => {
  let finishDelete!: (status: number) => void;
  const heldDelete = new Promise<number>(resolve => { finishDelete = resolve; });
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] },
    deletePane: (_pane, _request, attempt) => attempt === 1 ? heldDelete : 204
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const terminal = await openShell(page, 'build', '%5');

  await terminal.click({ button: 'middle' });
  await expect.poll(() => harness.paneAttempts.get('%5')).toBe(1);
  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle', force: true });
  await page.waitForTimeout(100);
  expect(harness.paneAttempts.get('%5')).toBe(1);
  expect(harness.agentAttempts.get('cora-1')).toBeUndefined();

  finishDelete(204);
  await expect(terminal).toHaveCount(0);
  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });
  await expect.poll(() => harness.agentAttempts.get('cora-1')).toBe(1);
});

test('working agents refuse split and workspace middle-click shutdown without touching shells', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora, 'working'), worktreeAgent('cora-2', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);

  await page.locator('.log-output .agent-output').click({ button: 'middle', position: { x: 40, y: 100 } });
  await expect(page.getByRole('alert').filter({ hasText: /could not be turned off/u })).toContainText(/cancel.*work/iu);
  expect(mutations(harness)).toEqual([]);
  await page.getByRole('tab', { name: /^Cora —/u }).click({ button: 'middle' });
  await expect(page.getByRole('alert').filter({ hasText: /could not be turned off/u })).toContainText(/cancel.*work/iu);
  expect(mutations(harness)).toEqual([]);
  await expect(page.locator('.agent-panel')).toBeVisible();
});

test('left and right clicks never stop agents or delete terminal splits', async ({ page }) => {
  const scenario: Scenario = {
    agents: [worktreeAgent('cora-1', cora)],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [cora] }],
    panes: { cora: [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: cora.path, title: '', agent: false, busy: false }] }
  };
  const harness = await mountConsole(page, scenario, '#agent=cora-1');
  await seedPaneSize(page, 'cora-1', 80, 24);
  const build = await openShell(page, 'build', '%5');
  const tab = page.getByRole('tab', { name: /^Cora —/u });
  const agentBody = page.locator('.log-output .agent-output');

  await tab.click();
  await tab.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await agentBody.click({ position: { x: 40, y: 100 } });
  await agentBody.click({ button: 'right', position: { x: 40, y: 100 } });
  await page.keyboard.press('Escape');
  await build.locator('.terminal-canvas').click({ position: { x: 40, y: 100 } });
  await build.locator('.terminal-canvas').click({ button: 'right', position: { x: 40, y: 100 } });
  await page.keyboard.press('Escape');

  expect(mutations(harness)).toEqual([]);
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(build).toBeVisible();
});
