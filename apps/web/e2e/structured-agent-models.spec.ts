import { expect, test, type Page } from '@playwright/test';

const gpt = { id: 'openai/gpt-5.6', name: 'GPT-5.6', provider: 'openai', inputPrice: 1.25, outputPrice: 10, contextWindow: 400_000, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const opus = { id: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus', provider: 'openrouter', inputPrice: 5, outputPrice: 25, contextWindow: 200_000, efforts: ['off', 'low', 'medium', 'high'] };

type Structured = { model?: { id: string; name?: string; effort?: string }; models: boolean };

// a console whose Worktree holds one live Pi Agent; every switch and new Conversation it is asked for is recorded
async function mockConsole(page: Page, { attention = 'finished', structured = { model: { id: gpt.id, name: gpt.name, effort: 'medium' }, models: true }, transcript = [] }: { attention?: 'working' | 'finished'; structured?: Structured; transcript?: unknown[] } = {}) {
  const posted: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.startsWith('/api/agents/')) posted.push({ path: url.pathname, body: request.postDataJSON() as unknown });
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
      const agent = { id: 'agent-1', transport: 'structured', panel: 'transcript', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: '', branch: 'cora', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, kind: 'pi', attention, structured: { lifecycle: 'live', revision: 1, ...structured }, queuedPromptCount: 0 };
      return route.fulfill({ json: { generation: 1, agents: [agent], projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/transcript') return route.fulfill({ json: { items: transcript } });
    if (url.pathname === '/api/agents/agent-1/models') return route.fulfill({ json: { models: [gpt, opus], current: { model: gpt.id, effort: 'medium' } } });
    if (url.pathname === '/api/agents/agent-1/model' || url.pathname === '/api/agents/agent-1/conversations/new') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/agents/agent-1/conversations') return route.fulfill({ json: { conversations: [], canResume: true } });
    if (url.pathname === '/api/agents/agent-1/prompt-history' || url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return posted;
}

const panelTitle = (page: Page) => page.locator('.log-split > .log-output .panel-header-title');

test('the model chip opens a picker of Allowed models and switches model and Effort', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const posted = await mockConsole(page);
  await page.goto('/');
  const chip = panelTitle(page).getByRole('button', { name: 'GPT-5.6 · medium' });
  await expect(chip).toBeVisible();

  await chip.click();
  const picker = page.getByRole('dialog', { name: 'Model and Effort' });
  const rows = picker.locator('.model-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('GPT-5.6');
  await expect(rows.nth(0)).toContainText('$1.25 in · $10 out per 1M · 400k context');
  await expect(rows.nth(1)).toContainText('Claude Opus');
  await expect(rows.nth(1)).toContainText('openrouter');
  // Effort offers only the current model's levels
  await expect(picker.getByRole('group', { name: 'Effort' }).getByRole('button')).toHaveText(gpt.efforts);
  await expect(picker.getByRole('button', { name: 'medium', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await picker.getByRole('button', { name: 'high', exact: true }).click();
  await expect.poll(() => posted.map(post => post.body)).toEqual([{ model: gpt.id, effort: 'high' }]);
  await chip.click();
  await page.getByRole('dialog', { name: 'Model and Effort' }).locator('.model-row').nth(1).click();
  await expect.poll(() => posted.map(post => post.body)).toEqual([{ model: gpt.id, effort: 'high' }, { model: opus.id }]);
});

test('the picker says to cancel the turn while the Agent works, and switches nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const posted = await mockConsole(page, { attention: 'working' });
  await page.goto('/');
  await panelTitle(page).getByRole('button', { name: 'GPT-5.6 · medium' }).click();
  const picker = page.getByRole('dialog', { name: 'Model and Effort' });
  await expect(picker.getByText('Cancel the turn to switch')).toBeVisible();
  await expect(picker.locator('.model-row').nth(1)).toBeDisabled();
  await expect(picker.getByRole('button', { name: 'high', exact: true })).toBeDisabled();
  expect(posted).toEqual([]);
});

test('with no Allowed models the chip only shows the model', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockConsole(page, { structured: { model: { id: 'openai/gpt-5.6', effort: 'off' }, models: false } });
  await page.goto('/');
  await expect(panelTitle(page).locator('.model-chip')).toHaveText('openai/gpt-5.6 · off');
  await expect(panelTitle(page).getByRole('button', { name: /gpt-5\.6/u })).toHaveCount(0);
});

test('a Pi Agent starts a new Conversation from the Conversations menu, and its transcript marks a model switch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const posted = await mockConsole(page, { transcript: [{ id: 'notice-1', kind: 'notice', text: 'Model → Claude Opus, effort medium', tone: 'info' }] });
  await page.goto('/');
  await expect(page.locator('.transcript-notice')).toContainText('Model → Claude Opus, effort medium');

  await page.locator('.log-split > .log-output').getByRole('button', { name: 'Conversations (0)', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect.poll(() => posted.map(post => post.path)).toEqual(['/api/agents/agent-1/conversations/new']);
  await expect(page.getByRole('button', { name: 'New conversation' })).toHaveCount(0);
});
