import { expect, test } from '@playwright/test';

test('converts images pasted into the prompt into queued attachments', async ({ page }) => {
  let queued: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queued = request.postDataJSON();
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Describe this screenshot.');
  const defaultAllowed = await prompt.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' }));
    return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });

  expect(defaultAllowed).toBe(false);
  await expect(prompt).toHaveValue('Describe this screenshot.');
  await expect(page.getByLabel('Selected attachments')).toContainText('clipboard.png');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => queued).toEqual({
    prompt: 'Describe this screenshot.',
    attachments: [{ name: 'clipboard.png', data: 'iVBORw==' }]
  });
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});
