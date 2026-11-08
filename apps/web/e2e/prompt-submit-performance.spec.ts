import { expect, test } from '@playwright/test';

test('releases prompt submission as soon as the server accepts it', async ({ page }) => {
  let submitted = false;
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>(resolve => { releaseRefresh = resolve; });

  await page.addInitScript(() => {
    // keep the live-output connection local
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the active session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' }], projects: [] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // issue the pane socket ticket
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return static composer resources
    if (url.pathname === '/api/agents/agent-1/commands') return route.fulfill({ json: { commands: [] } });
    // return static saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // accept the prompt before slow refreshes finish
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      submitted = true;
      return route.fulfill({ status: 204 });
    }
    // delay only post-submit history and queue refreshes
    if (url.pathname === '/api/agents/agent-1/prompt-history' || url.pathname === '/api/agents/agent-1/queued-prompts') {
      if (submitted) await refreshReleased;
      return route.fulfill({ json: { prompts: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('First prompt');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => submitted).toBe(true);

  await prompt.fill('Second prompt');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Queueing' })).toHaveCount(0);
  releaseRefresh();
});
