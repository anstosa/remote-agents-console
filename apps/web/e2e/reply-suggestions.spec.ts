import { expect, test, type Page } from '@playwright/test';
import { dropPaneSocket, installPaneMock, paneInputCount, pushMetadata, pushQuestion, seedPaneSize } from './pane-stream-mock.js';

type ReplySuggestion = { label: string; text: string };
type MockAgent = {
  id: string;
  kind: 'codex' | 'omx' | 'claude' | 'pi';
  panel: 'terminal' | 'transcript';
  attention: 'working' | 'finished' | 'question';
  hasMessageQuestion?: true;
  messageReplySuggestionKey?: string;
};
type SuggestionResponse = { sourceKey?: string; suggestions?: unknown; status?: number; wait?: Promise<void>; abort?: true };
type ConsoleState = {
  generation: number;
  agents: MockAgent[];
  notes?: Array<{ id: string; text: string }>;
  promptPosts: Array<{ agentId: string; prompt: string; attachments: unknown[] }>;
  suggestionPosts?: Array<{ agentId: string; body: unknown }>;
  suggestionResponses?: Record<string, SuggestionResponse>;
};

const worktree = { id: 'app:/worktrees/cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
const longReply = 'Use PostgreSQL for the durable store, keep the repository boundary intact, and include a reversible migration.';
const tradeoffReply = 'Explain the SQLite and PostgreSQL tradeoffs before changing the implementation.';
const suggestions: ReplySuggestion[] = [
  { label: 'Use PostgreSQL', text: longReply },
  { label: 'Explain tradeoffs', text: tradeoffReply }
];

// serve one mutable dashboard across terminal and transcript cases
async function mockConsole(page: Page, state: ConsoleState) {
  await installPaneMock(page);
  // contain every console request in the fixture
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // authenticate the mocked console
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose canonical suggestion metadata
    if (path === '/api/dashboard') {
      // shape both supported panel transports
      const agents = state.agents.map(agent => ({
        id: agent.id,
        home: worktree.path,
        placeId: worktree.id,
        worktreeId: worktree.id,
        projectId: 'app',
        title: 'Ready',
        branch: 'cora',
        kind: agent.kind,
        panel: agent.panel,
        attention: agent.attention,
        queuedPromptCount: 0,
        ...(agent.hasMessageQuestion === true ? { hasMessageQuestion: true } : {}),
        ...(agent.messageReplySuggestionKey === undefined ? {} : { messageReplySuggestionKey: agent.messageReplySuggestionKey }),
        ...(agent.panel === 'terminal'
          ? { sessionId: `socket:${agent.id}` }
          : { transport: 'structured', structured: { lifecycle: 'live', revision: 1 } })
      }));
      const pi = { launchable: true, program: '/node', stateSource: 'reported', turnCapture: true, conversations: false, naming: false, inlineQuestions: true, steer: true, commands: false, sandbox: false };
      const terminal = { ...pi, program: '/native-cli', steer: false };
      return route.fulfill({ json: { generation: state.generation, adapters: {
        pi: { ...pi, transport: 'structured', transports: { structured: pi } },
        codex: { ...terminal, transport: 'tmux', transports: { tmux: terminal } },
        omx: { ...terminal, transport: 'tmux', transports: { tmux: terminal } },
        claude: { ...terminal, transport: 'tmux', transports: { tmux: terminal, structured: pi } }
      }, agents, projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
    }
    // mint the shared pane socket
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // disable unrelated push setup
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // generate suggestions only after the visible composer requests its opaque key
    if (/^\/api\/agents\/[^/]+\/reply-suggestions$/u.test(path) && request.method() === 'POST') {
      const agentId = decodeURIComponent(path.split('/')[3]!);
      const body = request.postDataJSON() as unknown;
      state.suggestionPosts ??= [];
      state.suggestionPosts.push({ agentId, body });
      const sourceKey = typeof body === 'object' && body !== null && 'sourceKey' in body && typeof body.sourceKey === 'string' ? body.sourceKey : '';
      const response = state.suggestionResponses?.[sourceKey];
      // keep delayed responses pending until their race fixture releases them
      if (response?.wait !== undefined) await response.wait;
      // network failures stay local to the optional suggestion request
      if (response?.abort === true) return route.abort('failed');
      // return configured provider failures without suggestions
      if (response?.status !== undefined) return route.fulfill({ status: response.status, json: { error: 'suggestions unavailable' } });
      return route.fulfill({ json: { sourceKey: response?.sourceKey ?? sourceKey, suggestions: response?.suggestions ?? suggestions } });
    }
    // capture explicit sends and clear commands
    if (/^\/api\/agents\/[^/]+\/prompt$/u.test(path) && request.method() === 'POST') {
      const agentId = decodeURIComponent(path.split('/')[3]!);
      const body = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      state.promptPosts.push({ agentId, ...body });
      // clear canonical message metadata after a new conversation
      if (body.prompt === '/clear') {
        state.generation += 1;
        state.agents = state.agents.map(agent => agent.id === agentId ? { ...agent, hasMessageQuestion: undefined, messageReplySuggestionKey: undefined } : agent);
      }
      return route.fulfill({ status: 204 });
    }
    // return an empty transcript for structured agents
    if (/^\/api\/agents\/[^/]+\/transcript$/u.test(path)) return route.fulfill({ json: { items: [], earlier: 0, status: { extension: [] } } });
    // keep composer resources empty
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    // keep command catalogs empty
    if (/^\/api\/agents\/[^/]+\/commands$/u.test(path)) return route.fulfill({ json: { commands: [] } });
    // name agents in the switcher
    if (/^\/api\/agents\/[^/]+\/conversation$/u.test(path)) return route.fulfill({ json: { name: `Conversation ${decodeURIComponent(path.split('/')[3]!)}` } });
    // accept notification cleanup
    if (/^\/api\/agents\/[^/]+\/notifications\/dismiss$/u.test(path)) return route.fulfill({ status: 204 });
    // expose only notes explicitly needed by panel-visibility cases
    if (/^\/api\/worktrees\/[^/]+\/(?:notes|panes)$/u.test(path)) return route.fulfill({ json: path.endsWith('/notes') ? { notes: state.notes ?? [] } : { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// refresh the dashboard after mutating fixture state
async function refreshDashboard(page: Page, state: ConsoleState) {
  state.generation += 1;
  const generation = state.generation;
  // wait for this exact fixture revision
  const refreshed = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/dashboard'
    && (await response.json().catch(() => undefined) as { generation?: unknown } | undefined)?.generation === generation);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
}

// expose one manually released async response for stale-result races
function deferred() {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

// a paused OMX goal does not need an assistant question or model generation
test('paused OMX goals offer a standalone command without requesting AI suggestions', async ({ page }) => {
  const state: ConsoleState = { generation: 1, agents: [
    { id: 'agent-1', kind: 'omx', panel: 'terminal', attention: 'finished' },
    { id: 'agent-2', kind: 'codex', panel: 'terminal', attention: 'finished' }
  ], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  await seedPaneSize(page, 'agent-1');
  const resume = page.getByRole('group', { name: 'Suggested replies' }).getByRole('button', { name: '/goal resume', exact: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(resume).toHaveCount(0);
  await pushMetadata(page, 'agent-1', '', false, true);
  await expect(resume).toBeVisible();
  await prompt.fill('Keep this draft.');
  await expect(resume).toBeDisabled();
  await prompt.clear();

  // an attachment-only draft is still occupied
  await page.locator('.prompt input[type="file"]').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
  const removeAttachment = page.getByRole('button', { name: 'Remove keep.txt', exact: true });
  await expect(removeAttachment).toBeVisible();
  await expect(resume).toBeDisabled();
  await removeAttachment.click();

  // permission mode retains its explicit controls even if footer metadata is present
  await pushQuestion(page, 'agent-1', { id: 'permission-question', text: 'Allow this action?', permission: true, field: { kind: 'choice', choices: ['Allow', 'Deny'] }, source: 'parsed' });
  await expect(page.getByText('Permission request', { exact: true })).toBeVisible();
  await expect(resume).toHaveCount(0);
  await pushQuestion(page, 'agent-1', null);
  await expect(resume).toBeEnabled();

  await resume.click();
  await expect(prompt).toHaveValue('/goal resume');
  await expect(prompt).toBeFocused();
  expect(state.promptPosts).toEqual([]);
  expect(await paneInputCount(page, 'agent-1')).toBe(0);

  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => state.promptPosts).toEqual([{ agentId: 'agent-1', prompt: '/goal resume', attachments: [] }]);
  await pushMetadata(page, 'agent-1', '');
  await expect(resume).toHaveCount(0);

  // a disconnect retires the shortcut until new live metadata arrives
  await pushMetadata(page, 'agent-1', '', false, true);
  await expect(resume).toBeVisible();
  await dropPaneSocket(page);
  await expect(resume).toHaveCount(0);

  await page.getByRole('button', { name: /^Switch Agent at Cora/u }).click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /agent-2/u }).click();
  await seedPaneSize(page, 'agent-2');
  await pushMetadata(page, 'agent-2', '', false, true);
  await expect(resume).toHaveCount(0);
  expect(state.suggestionPosts ?? []).toEqual([]);
});

// a current provider failure cannot remove the footer command
test('paused OMX goals keep the command alongside AI replies and through provider failure', async ({ page }) => {
  const state: ConsoleState = {
    generation: 1,
    agents: [{ id: 'agent-1', kind: 'omx', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'ready-source' }],
    promptPosts: [],
    suggestionResponses: {
      'ready-source': { suggestions: [...suggestions, { label: 'Duplicate command', text: '/goal resume' }] },
      'failed-source': { status: 503 }
    }
  };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  await seedPaneSize(page, 'agent-1');
  await expect(page.getByRole('button', { name: 'Duplicate command' })).toBeVisible();
  await pushMetadata(page, 'agent-1', '', false, true);

  const group = page.getByRole('group', { name: 'Suggested replies' });
  await expect(group.getByRole('button')).toHaveText(['/goal resume', 'Use PostgreSQL', 'Explain tradeoffs']);
  state.agents[0] = { ...state.agents[0]!, messageReplySuggestionKey: 'failed-source' };
  await refreshDashboard(page, state);
  await expect.poll(() => state.suggestionPosts?.at(-1)?.body).toEqual({ sourceKey: 'failed-source' });
  await expect(group.getByRole('button')).toHaveText(['/goal resume']);
  expect(state.promptPosts).toEqual([]);
});

// verify draft-only selection and explicit submission
test('suggested replies populate and focus the draft without submitting it', async ({ page }) => {
  const state: ConsoleState = { generation: 1, agents: [{ id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' }], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  await seedPaneSize(page, 'agent-1');

  const group = page.getByRole('group', { name: 'Suggested replies' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const first = group.getByRole('button', { name: 'Use PostgreSQL', exact: true });
  await expect(group).toBeVisible();
  await expect(first).toHaveAttribute('type', 'button');
  await expect(first).toHaveAttribute('title', longReply);
  await expect(first).toHaveAttribute('aria-description', longReply);
  await expect(prompt).toHaveValue('');
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'source-1' } }]);
  expect(state.promptPosts).toEqual([]);
  expect(await paneInputCount(page, 'agent-1')).toBe(0);

  await first.focus();
  await page.keyboard.press('Enter');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(longReply);
  expect(state.promptPosts).toEqual([]);
  expect(await paneInputCount(page, 'agent-1')).toBe(0);

  // every repeated selection appends another editable draft
  await first.click();
  await expect(prompt).toHaveValue(`${longReply}\n\n${longReply}`);
  expect(state.promptPosts).toEqual([]);

  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => state.promptPosts).toEqual([{ agentId: 'agent-1', prompt: `${longReply}\n\n${longReply}`, attachments: [] }]);
});

// verify every suggestion appends after existing drafts and later edits
test('switching pills appends after the complete existing draft', async ({ page }) => {
  const state: ConsoleState = { generation: 1, agents: [{ id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' }], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  const group = page.getByRole('group', { name: 'Suggested replies' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep the API stable.');
  await group.getByRole('button', { name: 'Use PostgreSQL', exact: true }).click();
  await expect(prompt).toHaveValue(`Keep the API stable.\n\n${longReply}`);
  await group.getByRole('button', { name: 'Explain tradeoffs', exact: true }).click();
  await expect(prompt).toHaveValue(`Keep the API stable.\n\n${longReply}\n\n${tradeoffReply}`);

  // edits remain in place before the next appended suggestion
  await prompt.press('End');
  await prompt.type(' Keep this note.');
  await group.getByRole('button', { name: 'Use PostgreSQL', exact: true }).click();
  await expect(prompt).toHaveValue(`Keep the API stable.\n\n${longReply}\n\n${tradeoffReply} Keep this note.\n\n${longReply}`);
  expect(state.promptPosts).toEqual([]);
});

// keep equal text isolated between agent-owned drafts
test('switching agents never treats an equal draft as the previous agent suggestion', async ({ page }) => {
  await page.addInitScript(text => localStorage.setItem('remote-agent-console:prompt-draft:agent-2', text), longReply);
  const state: ConsoleState = { generation: 1, agents: [
    { id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' },
    { id: 'agent-2', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-2' }
  ], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  await page.getByRole('group', { name: 'Suggested replies' }).getByRole('button', { name: 'Use PostgreSQL', exact: true }).click();
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'source-1' } }]);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(longReply);
  const switcher = page.getByRole('button', { name: /^Switch Agent at Cora/u });
  await switcher.click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /agent-2/u }).click();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveValue(longReply);
  await page.getByRole('group', { name: 'Suggested replies' }).getByRole('button', { name: 'Explain tradeoffs', exact: true }).click();
  await expect.poll(() => state.suggestionPosts).toEqual([
    { agentId: 'agent-1', body: { sourceKey: 'source-1' } },
    { agentId: 'agent-2', body: { sourceKey: 'source-2' } }
  ]);
  await expect(prompt).toHaveValue(`${longReply}\n\n${tradeoffReply}`);
  expect(state.promptPosts).toEqual([]);
});

// verify phone containment and source order
test('suggested replies scroll within the composer without widening a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSuggestions: ReplySuggestion[] = [
    ...suggestions,
    { label: 'Keep SQLite', text: 'Keep SQLite and add focused locking tests.' },
    { label: 'Show migration steps', text: 'Show the migration steps before making changes.' }
  ];
  const state: ConsoleState = { generation: 1, agents: [{ id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'mobile-source' }], promptPosts: [], suggestionResponses: { 'mobile-source': { suggestions: mobileSuggestions } } };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const group = composer.getByRole('group', { name: 'Suggested replies' });
  const prompt = composer.getByRole('textbox', { name: 'Prompt' });
  await expect(group).toBeVisible();
  // measure compact targets inside the scroll row
  const geometry = await group.evaluate(element => {
    const groupBox = element.getBoundingClientRect();
    const promptBox = element.parentElement!.querySelector('textarea')!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    // retain the closest adjacent target centers
    const minimumCenterSeparation = buttons.slice(1).reduce((minimum, box, index) => {
      const previous = buttons[index]!;
      return Math.min(minimum, box.left + box.width / 2 - (previous.left + previous.width / 2));
    }, Number.POSITIVE_INFINITY);
    const standardControlSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--standard-control-size')) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const sendBox = element.parentElement!.querySelector<HTMLButtonElement>('.agent-composer-column .queue')!.getBoundingClientRect();
    return {
      first: element.parentElement?.firstElementChild === element,
      above: groupBox.bottom <= promptBox.top,
      scrolls: element.scrollWidth > element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
      pillHeight: buttons[0]!.height,
      expectedPillHeight: standardControlSize / 2,
      sendHeight: sendBox.height,
      expectedSendHeight: standardControlSize,
      minimumCenterSeparation
    };
  });
  expect(geometry).toMatchObject({ first: true, above: true, scrolls: true, overflowX: 'auto', pageFits: true });
  expect(geometry.pillHeight).toBeCloseTo(geometry.expectedPillHeight, 0);
  expect(geometry.sendHeight).toBeCloseTo(geometry.expectedSendHeight, 0);
  expect(geometry.minimumCenterSeparation).toBeGreaterThanOrEqual(24);
  const labels = await group.getByRole('button').allTextContents();
  expect(labels.every(label => label.trim().split(/\s+/u).length <= 3)).toBe(true);
  await expect(prompt).toHaveValue('');
});

// verify canonical lifecycle and native-question precedence
test('suggestions follow the selected finished prose question and clear for native or new conversations', async ({ page }) => {
  const state: ConsoleState = { generation: 1, agents: [
    { id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' },
    { id: 'agent-2', kind: 'codex', panel: 'terminal', attention: 'finished' }
  ], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  await seedPaneSize(page, 'agent-1');
  const group = page.getByRole('group', { name: 'Suggested replies' });
  await expect(group).toBeVisible();

  // resumed work hides stale metadata
  state.agents[0] = { ...state.agents[0]!, attention: 'working' };
  await refreshDashboard(page, state);
  await expect(group).toHaveCount(0);
  // a finished statement remains suggestion-free
  state.agents[0] = { ...state.agents[0]!, attention: 'finished', hasMessageQuestion: undefined };
  await refreshDashboard(page, state);
  await expect(group).toHaveCount(0);
  // the canonical question restores its replies
  state.agents[0] = { ...state.agents[0]!, hasMessageQuestion: true };
  await refreshDashboard(page, state);
  await expect(group).toBeVisible();

  await pushQuestion(page, 'agent-1', { id: 'native-question', text: 'Which path?', field: { kind: 'choice', choices: ['First', 'Second'] }, source: 'parsed' });
  await expect(page.getByRole('region', { name: 'Agent question' })).toBeVisible();
  await expect(group).toHaveCount(0);
  await pushQuestion(page, 'agent-1', null);
  await expect(group).toBeVisible();

  const switcher = page.getByRole('button', { name: /^Switch Agent at Cora/u });
  await switcher.click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /agent-2/u }).click();
  await expect(group).toHaveCount(0);
  await switcher.click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /agent-1/u }).click();
  await expect(group).toBeVisible();

  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Clear' }).click();
  await expect.poll(() => state.promptPosts.map(post => post.prompt)).toEqual(['/clear']);
  await refreshDashboard(page, state);
  await expect(group).toHaveCount(0);
});

// verify transcript agents use dashboard metadata alone
test('structured transcript agents offer the same draft-only replies', async ({ page }) => {
  const state: ConsoleState = { generation: 1, agents: [{ id: 'agent-1', kind: 'pi', panel: 'transcript', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' }], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  const group = page.getByRole('group', { name: 'Suggested replies' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Explain tradeoffs', exact: true }).click();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(tradeoffReply);
  expect(state.promptPosts).toEqual([]);
});

// gate background requests on document and agent visibility without blocking the composer
test('suggestions request only while the selected finished composer is visible', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as Window & { testVisibility?: string }).testVisibility ?? 'hidden' });
  });
  const state: ConsoleState = { generation: 1, agents: [
    { id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-1' },
    { id: 'agent-2', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'source-2' }
  ], promptPosts: [] };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeEditable();
  await page.waitForTimeout(100);
  expect(state.suggestionPosts ?? []).toEqual([]);

  // a visible edge admits exactly the selected agent's opaque key
  await page.evaluate(() => {
    (window as Window & { testVisibility?: string }).testVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'source-1' } }]);
  await expect(page.getByRole('group', { name: 'Suggested replies' })).toBeVisible();

  // working state removes suggestions without another provider request
  state.agents[0] = { ...state.agents[0]!, attention: 'working', messageReplySuggestionKey: undefined };
  await refreshDashboard(page, state);
  await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0);
  expect(state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'source-1' } }]);
  await expect(prompt).toBeEditable();
});

// a restored phone split must not bill the offscreen agent composer
test('phone carousel waits to request suggestions until the agent panel is selected', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ worktreeId, noteId }) => {
    localStorage.setItem('rac.worktree-id-reset:v1', '1');
    localStorage.setItem(`rac.note-view:${worktreeId}`, JSON.stringify({ noteId, expanded: false }));
    localStorage.setItem(`rac.last-split:${worktreeId}`, 'note');
  }, { worktreeId: worktree.id, noteId: 'note-1' });
  const state: ConsoleState = {
    generation: 1,
    agents: [{ id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'phone-offscreen' }],
    notes: [{ id: 'note-1', text: 'Keep the note in view.' }],
    promptPosts: []
  };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note).toBeInViewport({ ratio: 0.99 });
  await expect(page.locator('.log-output')).not.toBeInViewport();
  await page.waitForTimeout(100);
  expect(state.suggestionPosts ?? []).toEqual([]);

  // selecting the agent admits exactly one opaque-key request
  const panels = page.getByRole('group', { name: 'Panels' });
  await panels.getByRole('button', { name: 'Choose split' }).click();
  await page.getByRole('menuitem', { name: 'Agent output' }).click();
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'phone-offscreen' } }]);
  await expect(page.getByRole('group', { name: 'Suggested replies' })).toBeVisible();
});

// a restored desktop expansion must hide its mounted sibling before requests begin
test('desktop expanded sibling waits to request suggestions until the agent panel is restored', async ({ page }) => {
  await page.addInitScript(({ worktreeId, noteId }) => {
    localStorage.setItem('rac.worktree-id-reset:v1', '1');
    localStorage.setItem(`rac.note-view:${worktreeId}`, JSON.stringify({ noteId, expanded: true }));
  }, { worktreeId: worktree.id, noteId: 'note-1' });
  const state: ConsoleState = {
    generation: 1,
    agents: [{ id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'desktop-offscreen' }],
    notes: [{ id: 'note-1', text: 'Keep this note expanded.' }],
    promptPosts: []
  };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');

  await expect(page.getByRole('button', { name: 'Restore note' })).toBeVisible();
  await expect(page.locator('.log-output')).toBeHidden();
  await page.waitForTimeout(100);
  expect(state.suggestionPosts ?? []).toEqual([]);

  // restoring siblings makes the composer visible and eligible
  await page.getByRole('button', { name: 'Restore note' }).click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'desktop-offscreen' } }]);
  const group = page.getByRole('group', { name: 'Suggested replies' });
  await expect(group).toBeVisible();

  // hiding the mounted composer clears the row without another request
  await page.getByRole('button', { name: 'Expand note' }).click();
  await expect(group).toHaveCount(0);
  expect(state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'desktop-offscreen' } }]);
});

// discard delayed and invalid provider responses at the active agent and source boundary
test('stale, failed, empty, and malformed suggestion responses stay hidden', async ({ page }) => {
  const old = deferred();
  const state: ConsoleState = {
    generation: 1,
    agents: [
      { id: 'agent-1', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'old-source' },
      { id: 'agent-2', kind: 'codex', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'new-source' }
    ],
    promptPosts: [],
    suggestionResponses: {
      'old-source': { wait: old.wait, suggestions: [{ label: 'Old stale', text: 'This stale reply must never appear.' }] },
      'new-source': { suggestions: [{ label: 'Current reply', text: 'Use the current agent response.' }] },
      'failed-source': { status: 503 },
      'empty-source': { suggestions: [] },
      'malformed-source': { suggestions: [{ label: 'More than three words', text: 'Reject this malformed reply.' }] },
      'mismatched-source': { sourceKey: 'other-source', suggestions }
    }
  };
  await mockConsole(page, state);
  await page.goto('/#agent=agent-1');
  await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'old-source' } }]);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEditable();

  // switching agents aborts presentation ownership before the old request returns
  await page.getByRole('button', { name: /^Switch Agent at Cora/u }).click();
  await page.getByRole('menu', { name: 'Agents at Cora' }).getByRole('menuitemradio', { name: /agent-2/u }).click();
  await expect(page.getByRole('button', { name: 'Current reply', exact: true })).toBeVisible();
  old.release();
  await expect(page.getByRole('button', { name: 'Old stale', exact: true })).toHaveCount(0);

  // each invalid result clears the row without affecting prompt submission state
  for (const sourceKey of ['failed-source', 'empty-source', 'malformed-source', 'mismatched-source']) {
    state.agents[1] = { ...state.agents[1]!, messageReplySuggestionKey: sourceKey };
    await refreshDashboard(page, state);
    await expect.poll(() => state.suggestionPosts?.at(-1)).toEqual({ agentId: 'agent-2', body: { sourceKey } });
    await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEditable();
  }
  expect(state.promptPosts).toEqual([]);
});

const crossAgentPanels = [
  { kind: 'codex', panel: 'terminal' },
  { kind: 'omx', panel: 'terminal' },
  { kind: 'claude', panel: 'terminal' },
  { kind: 'claude', panel: 'transcript' },
  { kind: 'pi', panel: 'transcript' }
] as const;

// every kind and transport uses the same key-only editable-draft boundary
for (const target of crossAgentPanels) {
  // fixtures prove rendering mechanics rather than native login support
  test(`${target.kind} ${target.panel} appends every pill without sending`, async ({ page }) => {
    const id = `agent-${target.kind}-${target.panel}`;
    const state: ConsoleState = { generation: 1, agents: [{ id, ...target, attention: 'finished', hasMessageQuestion: true, messageReplySuggestionKey: 'own-source' }], promptPosts: [] };
    await mockConsole(page, state);
    await page.goto(`/#agent=${id}`);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    const pill = page.getByRole('group', { name: 'Suggested replies' }).getByRole('button', { name: 'Explain tradeoffs', exact: true });
    await expect(pill).toBeVisible();
    await prompt.fill('Keep the existing design.');
    await pill.click();
    await pill.click();
    const draft = `Keep the existing design.\n\n${tradeoffReply}\n\n${tradeoffReply}`;
    await expect(prompt).toHaveValue(draft);
    await expect(prompt).toBeFocused();
    expect(state.promptPosts).toEqual([]);
    expect(state.suggestionPosts).toEqual([{ agentId: id, body: { sourceKey: 'own-source' } }]);
    // terminal transports must never receive direct input from draft activation
    if (target.panel === 'terminal') expect(await paneInputCount(page, id)).toBe(0);
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect.poll(() => state.promptPosts).toEqual([{ agentId: id, prompt: draft, attachments: [] }]);
  });
}

const failedSuggestionCases = ['pending', 'http', 'network', 'empty', 'malformed', 'stale', 'unsupported'] as const;

// optional generation never takes control of the normal send path
for (const failure of failedSuggestionCases) {
  // exercise an actual prompt action instead of only checking editability
  test(`normal Send remains usable while suggestions are ${failure}`, async ({ page }) => {
    const pending = deferred();
    const response: SuggestionResponse = failure === 'pending' ? { wait: pending.wait }
      : failure === 'http' ? { status: 503 }
      : failure === 'network' ? { abort: true }
      : failure === 'malformed' ? { suggestions: [{ label: 'Invalid four word label', text: 'Ignore this malformed draft.' }] }
      : failure === 'stale' ? { sourceKey: 'another-source', suggestions }
      : { suggestions: [] };
    const state: ConsoleState = {
      generation: 1,
      agents: [{ id: 'agent-1', kind: 'claude', panel: 'terminal', attention: 'finished', hasMessageQuestion: true, ...(failure === 'unsupported' ? {} : { messageReplySuggestionKey: 'source-1' }) }],
      promptPosts: [], suggestionResponses: { 'source-1': response }
    };
    await mockConsole(page, state);
    try {
      await page.goto('/#agent=agent-1');
      const prompt = page.getByRole('textbox', { name: 'Prompt' });
      await expect(prompt).toBeEditable();
      // unsupported sources must not dispatch an inference request
      if (failure !== 'unsupported') await expect.poll(() => state.suggestionPosts).toEqual([{ agentId: 'agent-1', body: { sourceKey: 'source-1' } }]);
      await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0);
      await prompt.fill(`Continue manually during ${failure}.`);
      expect(state.promptPosts).toEqual([]);
      await page.getByRole('button', { name: 'Queue', exact: true }).click();
      await expect.poll(() => state.promptPosts).toEqual([{ agentId: 'agent-1', prompt: `Continue manually during ${failure}.`, attachments: [] }]);
      // lack of a generation route must leave the provider completely untouched
      if (failure === 'unsupported') expect(state.suggestionPosts ?? []).toEqual([]);
    } finally {
      pending.release();
    }
  });
}
