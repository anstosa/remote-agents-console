import { expect, test } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

// keep viewed completions read across navigation and subsequent dashboard updates
test('dismisses a newly selected agent tab but waits for prompt focus on the already active tab', async ({ page }) => {
  // allow the complete multi-tab interaction sequence on cold production assets
  test.setTimeout(60_000);
  const remoteDismissals: Array<{ path: string; completionId?: string }> = [];
  const dashboard = { generation: 1, agents: [
    { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', attention: 'finished', unread: true, completionId: 'first-completion' },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready', attention: 'finished', unread: true, completionId: 'first-completion' }
  ], projects: [] };
  const unreadSnapshot = structuredClone(dashboard);
  await installDashboardSocket(page);
  await page.addInitScript(() => {
    const localDismissals: string[] = [];
    Object.defineProperty(window, '__localDismissals', { configurable: true, value: localDismissals });
    const registration = {
      getNotifications: async ({ tag }: { tag?: string } = {}) => [{ close: () => { if (tag) localDismissals.push(tag); } }],
      showNotification: async () => {}
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve the server-owned dismissal state on every refresh
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    // authorize the controllable dashboard stream
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // persist each dismissal instead of replaying an unchanged unread fixture
    if (/^\/api\/agents\/agent-[12]\/notifications\/dismiss$/u.test(url.pathname) && request.method() === 'POST') {
      const { completionId } = request.postDataJSON() as { completionId?: string };
      remoteDismissals.push({ path: url.pathname, completionId });
      // the server clears only the observed completion, not a newer turn
      dashboard.agents = dashboard.agents.map(agent => url.pathname.includes(`/${agent.id}/`) && agent.completionId === completionId ? { ...agent, unread: false } : agent);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.bringToFront();
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => remoteDismissals).toEqual([]);
  const activeUnread = page.getByRole('tab', { name: 'Cora — Prompt done — Unread' });
  await expect(activeUnread).toHaveClass(/unread/u);
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-1/notifications/dismiss', completionId: 'first-completion' });
  const unread = page.getByRole('tab', { name: 'Owen — Prompt done — Unread' });
  await expect(unread).toHaveClass(/unread/u);
  await unread.click();
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-2/notifications/dismiss', completionId: 'first-completion' });
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __localDismissals: string[] }
  ).__localDismissals)).toEqual(expect.arrayContaining(['worktree-status-owen', 'agent-status-agent-2']));
  // leaving a read worktree must not re-arm its completed highlight
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  // replay an already-emitted completion alongside unrelated metadata changes
  await emitDashboard(page, { ...unreadSnapshot, generation: 2, notesRevision: 1 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  // a reload also reads the server's persisted dismissal
  await page.reload();
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  // only a new completed turn makes the other worktree unread again
  dashboard.agents[1] = { ...dashboard.agents[1]!, title: '⠋ Working', attention: 'working' };
  await emitDashboard(page, { ...dashboard, generation: 3 });
  await expect(page.getByRole('tab', { name: 'Owen — Working' })).toBeVisible();
  dashboard.agents[1] = { ...dashboard.agents[1]!, title: 'Ready', attention: 'finished', unread: true, completionId: 'second-completion' };
  await emitDashboard(page, { ...dashboard, generation: 4 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done — Unread' })).toHaveClass(/unread/u);
  // a completion remains new even if the browser missed the intervening work
  await page.getByRole('tab', { name: 'Owen — Prompt done — Unread' }).click();
  await expect.poll(() => remoteDismissals.filter(dismissal => dismissal.path.includes('/agent-2/')).map(dismissal => dismissal.completionId)).toEqual(['first-completion', 'second-completion']);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: true, completionId: 'third-completion' };
  await emitDashboard(page, { ...dashboard, generation: 5 });
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done — Unread' })).toHaveClass(/unread/u);
  // a turn viewed during grace stays read when its unread publication arrives
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: false, completionId: 'pending-completion' };
  await emitDashboard(page, { ...dashboard, generation: 6 });
  const pending = page.getByRole('tab', { name: 'Owen — Prompt done' });
  await expect(pending).not.toHaveClass(/unread/u);
  await pending.click();
  await expect.poll(() => remoteDismissals).toContainEqual({ path: '/api/agents/agent-2/notifications/dismiss', completionId: 'pending-completion' });
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  dashboard.agents[1] = { ...dashboard.agents[1]!, unread: true };
  await emitDashboard(page, { ...dashboard, generation: 7 });
  await expect(pending).not.toHaveClass(/unread/u);
});

test('routes an exact completion read through the worker without a direct strict close', async ({ page }) => {
  const epoch = '00000000-0000-4000-8000-000000000001';
  const event = { schemaVersion: 1 as const, eventId: 'completion-a', eventEpoch: epoch, eventSequence: 1, entityId: 'agent:agent-1', generatedAt: Date.now(), kind: 'finished' as const, agentId: 'agent-1', tag: 'agent-status-agent-1', displayTag: 'rac-v1-agent-status-agent-1', url: '/#agent=agent-1', worktreeId: 'cora' };
  await page.addInitScript(() => {
    const operations: Array<{ operation: string; eventId?: string }> = [];
    const directStrictClosures: string[] = [];
    Object.defineProperty(window, '__exactOperations', { configurable: true, value: operations });
    Object.defineProperty(window, '__directStrictClosures', { configurable: true, value: directStrictClosures });
    const active = {
      // acknowledge one exact worker operation
      postMessage: (message: { requestId: string; operation: string; soundRequested?: boolean; event?: { displayTag?: string; eventId?: string; eventEpoch?: string; eventSequence?: number }; snapshotToken?: string }, ports: MessagePort[]) => {
        operations.push({ operation: message.operation, eventId: message.event?.eventId });
        const exact = message.event === undefined ? {} : {
          displayTag: message.event.displayTag,
          eventId: message.event.eventId,
          eventEpoch: message.event.eventEpoch,
          eventSequence: message.event.eventSequence
        };
        // return one empty worker inventory
        if (message.operation === 'inventory') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'listed', audibleClaim: false, entries: [] });
          return;
        }
        // preserve reconciliation correlation
        if (message.operation === 'reconcile') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'closed', audibleClaim: false, snapshotToken: message.snapshotToken });
          return;
        }
        const outcome = message.operation === 'close' ? 'closed' : 'displayed';
        ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome, audibleClaim: message.operation === 'display' && message.soundRequested === true, ...exact });
      }
    };
    const registration = {
      active,
      // expose any forbidden strict page enumeration
      getNotifications: async ({ tag }: { tag?: string } = {}) => [{ close: () => { if (tag?.startsWith('rac-v1-')) directStrictClosures.push(tag); } }],
      showNotification: async () => undefined
    };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // restore one authenticated client
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 100, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', unread: true, completionId: event.eventId, notificationEvent: event, notificationState: { eventEpoch: epoch, eventSequence: 1 }, queuedPromptCount: 0 }], projects: [] } });
    if (path.endsWith('/notifications/dismiss')) return route.fulfill({ status: 204 });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __exactOperations: Array<{ operation: string; eventId?: string }> }).__exactOperations)).toContainEqual({ operation: 'close', eventId: event.eventId });
  expect(await page.evaluate(() => (window as typeof window & { __directStrictClosures: string[] }).__directStrictClosures)).toEqual([]);
});

test('retains a cross-epoch unknown completion until a later identified turn follows working', async ({ page }) => {
  await installDashboardSocket(page);
  const firstEpoch = '00000000-0000-4000-8000-000000000001';
  const secondEpoch = '00000000-0000-4000-8000-000000000002';
  const event = { schemaVersion: 1 as const, eventId: 'completion-a', eventEpoch: firstEpoch, eventSequence: 1, entityId: 'agent:agent-1', generatedAt: Date.now(), kind: 'finished' as const, agentId: 'agent-1', tag: 'agent-status-agent-1', displayTag: 'rac-v1-agent-status-agent-1', url: '/#agent=agent-1' };
  await page.addInitScript(() => {
    const reconciliations: Array<Array<{ eventId: string }>> = [];
    Object.defineProperty(window, '__reconciliations', { configurable: true, value: reconciliations });
    const active = {
      // acknowledge only serialized reconciliation
      postMessage: (message: { requestId: string; operation: string; soundRequested?: boolean; event?: { displayTag?: string; eventId?: string; eventEpoch?: string; eventSequence?: number }; entries?: Array<{ eventId: string }>; snapshotToken?: string }, ports: MessagePort[]) => {
        if (message.operation === 'reconcile') reconciliations.push(message.entries ?? []);
        const exact = message.event === undefined ? {} : {
          displayTag: message.event.displayTag,
          eventId: message.event.eventId,
          eventEpoch: message.event.eventEpoch,
          eventSequence: message.event.eventSequence
        };
        // return one empty worker inventory
        if (message.operation === 'inventory') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'listed', audibleClaim: false, entries: [] });
          return;
        }
        // preserve reconciliation correlation
        if (message.operation === 'reconcile') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'closed', audibleClaim: false, snapshotToken: message.snapshotToken });
          return;
        }
        const outcome = message.operation === 'close' ? 'closed' : 'displayed';
        ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome, audibleClaim: message.operation === 'display' && message.soundRequested === true, ...exact });
      }
    };
    const registration = { active, getNotifications: async () => [], showNotification: async () => undefined };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
  });
  const initial = { generation: 1, serverStartedAt: 100, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', unread: true, completionId: event.eventId, notificationEvent: event, notificationState: { eventEpoch: firstEpoch, eventSequence: 1 }, queuedPromptCount: 0 }], projects: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // serve the authoritative baseline and dashboard stream
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: initial });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await emitDashboard(page, { generation: 1, serverStartedAt: 200, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', notificationState: { eventEpoch: secondEpoch, eventSequence: 1 }, queuedPromptCount: 0 }], projects: [] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { __reconciliations: unknown[] }).__reconciliations)).toEqual([]);
  await emitDashboard(page, { generation: 2, serverStartedAt: 200, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Working', attention: 'working', notificationState: { eventEpoch: secondEpoch, eventSequence: 2 }, queuedPromptCount: 0 }], projects: [] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { __reconciliations: unknown[] }).__reconciliations)).toEqual([]);
  const later = { ...event, eventId: 'completion-b', eventEpoch: secondEpoch, eventSequence: 3, generatedAt: Date.now() + 1 };
  await emitDashboard(page, { generation: 3, serverStartedAt: 200, agents: [{ id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', unread: true, completionId: later.eventId, notificationEvent: later, notificationState: { eventEpoch: secondEpoch, eventSequence: 3 }, queuedPromptCount: 0 }], projects: [] });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __reconciliations: Array<Array<{ eventId: string }>> }).__reconciliations)).toEqual([[expect.objectContaining({ eventId: event.eventId })]]);
});

test('retains an active message question and reconciles it only after resolution', async ({ page }) => {
  await installDashboardSocket(page);
  const epoch = '00000000-0000-4000-8000-000000000001';
  const event = { schemaVersion: 1 as const, eventId: 'message-question-1', eventEpoch: epoch, eventSequence: 1, entityId: 'agent:agent-1', generatedAt: Date.now(), kind: 'question' as const, agentId: 'agent-1', tag: 'agent-status-agent-1', displayTag: 'rac-v1-agent-status-agent-1', url: '/#agent=agent-1' };
  await page.addInitScript(() => {
    const reconciliations: string[][] = [];
    Object.defineProperty(window, '__messageQuestionReconciliations', { configurable: true, value: reconciliations });
    const active = {
      // retain exact reconciliation evidence
      postMessage: (message: { requestId: string; operation: string; soundRequested?: boolean; event?: { displayTag?: string; eventId?: string; eventEpoch?: string; eventSequence?: number }; entries?: Array<{ eventId: string }>; snapshotToken?: string }, ports: MessagePort[]) => {
        if (message.operation === 'reconcile') reconciliations.push((message.entries ?? []).map(entry => entry.eventId));
        const exact = message.event === undefined ? {} : {
          displayTag: message.event.displayTag,
          eventId: message.event.eventId,
          eventEpoch: message.event.eventEpoch,
          eventSequence: message.event.eventSequence
        };
        // return one empty worker inventory
        if (message.operation === 'inventory') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'listed', audibleClaim: false, entries: [] });
          return;
        }
        // preserve reconciliation correlation
        if (message.operation === 'reconcile') {
          ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome: 'closed', audibleClaim: false, snapshotToken: message.snapshotToken });
          return;
        }
        const outcome = message.operation === 'close' ? 'closed' : 'displayed';
        ports[0]!.postMessage({ protocolVersion: 1, requestId: message.requestId, outcome, audibleClaim: message.operation === 'display' && message.soundRequested === true, ...exact });
      }
    };
    const registration = { active, getNotifications: async () => [], showNotification: async () => undefined };
    const serviceWorkers = new EventTarget() as EventTarget & { ready: Promise<typeof registration>; register: () => Promise<typeof registration> };
    serviceWorkers.ready = Promise.resolve(registration);
    serviceWorkers.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorkers });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
  });
  const activeQuestion = { id: 'agent-1', panel: 'terminal', home: '/worktrees/cora', title: 'Ready', attention: 'finished', hasMessageQuestion: true, notificationEvent: event, notificationState: { eventEpoch: epoch, eventSequence: 1 }, queuedPromptCount: 0 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // establish one active prose question
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, serverStartedAt: 100, agents: [activeQuestion], projects: [] } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/push/receipts') return route.fulfill({ status: 204 });
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false, commitCount: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect.poll(() => dashboardSocketReady(page), { timeout: 15_000 }).toBe(true);
  await emitDashboard(page, { generation: 2, serverStartedAt: 100, agents: [activeQuestion], projects: [] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { __messageQuestionReconciliations: string[][] }).__messageQuestionReconciliations)).toEqual([]);
  await emitDashboard(page, { generation: 3, serverStartedAt: 100, agents: [{ ...activeQuestion, hasMessageQuestion: undefined, notificationEvent: undefined, notificationState: { eventEpoch: epoch, eventSequence: 2 } }], projects: [] });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __messageQuestionReconciliations: string[][] }).__messageQuestionReconciliations)).toEqual([[event.eventId]]);
});
