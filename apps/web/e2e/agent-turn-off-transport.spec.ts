import { expect, test, type Page } from '@playwright/test';

type TurnOffScope = 'worktree' | 'scratch';
type CapturedTransport = { method: string; contentType: string | undefined; body: string | null };

// allow the first browser load to transform the large dashboard bundle
test.describe.configure({ timeout: 60_000 });

// mount one synthetic idle agent behind a json-enforcing transport
const mountTurnOffTransport = async (page: Page, scope: TurnOffScope) => {
  let running = true;
  let transport: CapturedTransport | undefined;
  const agentId = `agent-${scope}`;
  const configured = scope === 'worktree';
  const label = configured ? 'Cora' : '~ Scratch';
  const endpoint = configured ? `/api/agents/${agentId}/deactivate` : `/api/agents/${agentId}`;
  const method = configured ? 'POST' : 'DELETE';
  const agent = {
    id: agentId,
    sessionId: 'socket:$synthetic',
    home: configured ? '/worktrees/cora' : '/tmp/scratch',
    title: 'Ready',
    attention: 'finished',
    queuedPromptCount: 0,
    displayLabel: label,
    ...(configured ? { worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, projectId: 'proj', launch: { kind: 'codex', origin: 'worktree' } } : {})
  };
  const projects = configured
    ? [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0, launch: { kind: 'codex', origin: 'worktree' } }] }]
    : [];

  // intercept only this synthetic api surface
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the agent until a valid turn-off request lands
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: running ? 1 : 2, agents: running ? [agent] : [], projects, places: [] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide the live agent ticket
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide empty agent collections
    if (new RegExp(`^/api/agents/${agentId}/(?:saved-prompts|queued-prompts|prompt-history)$`, 'u').test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // model the chunked tunnel parser's explicit-json requirement
    if (url.pathname === endpoint && request.method() === method) {
      transport = { method: request.method(), contentType: request.headers()['content-type'], body: request.postData() };
      // reject the media type bug
      if (transport.contentType !== 'application/json' || transport.body !== '{}') return route.fulfill({ status: 415, json: { error: 'Unsupported Media Type' } });
      running = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { transport: () => transport };
};

// choose turn off from the rendered power menu
const turnOff = async (page: Page) => {
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Turn off' }).click();
};

// verify configured deactivation sends empty json and preserves the worktree
test('turns off a configured worktree agent with an empty json request', async ({ page }) => {
  const harness = await mountTurnOffTransport(page, 'worktree');
  await turnOff(page);

  await expect.poll(harness.transport).toEqual({ method: 'POST', contentType: 'application/json', body: '{}' });
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Empty workspace' })).toBeVisible();
});

// verify scratch removal sends empty json and closes its transient workspace
test('turns off a scratch agent with an empty json request', async ({ page }) => {
  const harness = await mountTurnOffTransport(page, 'scratch');
  await turnOff(page);

  await expect.poll(harness.transport).toEqual({ method: 'DELETE', contentType: 'application/json', body: '{}' });
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
});
