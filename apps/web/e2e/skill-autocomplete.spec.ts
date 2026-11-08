import { expect, test } from '@playwright/test';

test('includes repo-local skills in prompt autocomplete', async ({ page }) => {
  // serve one complete command catalog
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/ferry.fyi', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // return runtime and built-in commands
    if (url.pathname === '/api/agents/agent-1/commands') return route.fulfill({ json: { commands: [{ value: '$oh-my-codex:plan', description: 'Plan through the installed plugin.' }, { value: '$push', description: 'Review, commit, and push the current branch.' }, { value: '/permissions', description: 'Choose what Codex is allowed to do' }, { value: '/fast', description: '1.5x speed, increased usage' }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('$');
  await expect(page.getByRole('option', { name: /\$oh-my-codex:plan/u })).toBeVisible();
  await prompt.fill('/');
  await expect(page.getByRole('option', { name: /\/permissions/u })).toBeVisible();
  await expect(page.getByRole('option', { name: /\/fast/u })).toBeVisible();
  await prompt.fill('$pu');

  const option = page.getByRole('option', { name: /\$push/u });
  await expect(option).toBeVisible();

  await option.click();
  await expect(prompt).toHaveValue('$push');
});
