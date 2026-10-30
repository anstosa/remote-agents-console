import { expect, test, type Page } from '@playwright/test';

// A structured (Pi) Agent's composer: Steer while it works, its pending steers, the steers a cancel
// gives back, its paged Inline questions, and text it offers for the draft.

type Question = { id: string; text: string; field: { kind: 'choice'; choices: string[] } | { kind: 'text'; multiline: boolean; prefill?: string; placeholder?: string }; expiresAt?: number };
type Structured = { questions?: Question[]; steers?: string[]; draft?: { id: number; text: string } };

// stub a console whose one Worktree runs a Pi Agent that can steer; steers, cancels and answers are recorded
async function mockPi(page: Page, { attention = 'working', structured = {}, cancelled = [] }: { attention?: 'working' | 'finished' | 'question'; structured?: Structured; cancelled?: string[] } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && /^\/api\/agents\/agent-1\/(?:steer|cancel|question|prompt|conversations\/new)$/u.test(url.pathname)) {
      posts.push({ path: url.pathname.slice('/api/agents/agent-1/'.length), body: request.postData() === null ? undefined : request.postDataJSON() as unknown });
      return url.pathname.endsWith('/cancel') ? route.fulfill({ json: { steers: cancelled } }) : route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      const worktree = { id: 'cora', projectId: 'app', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'cora', available: true, pinned: true, order: 0 };
      const questions = structured.questions ?? [];
      const shaped = questions.map(question => ({ ...question, source: 'structured', choices: question.field.kind === 'choice' ? question.field.choices : [] }));
      const agent = { id: 'agent-1', transport: 'structured', panel: 'transcript', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'app', worktreeLabel: 'Cora', worktreeOrder: 0, title: '', branch: 'cora', kind: 'pi', attention, ...(shaped[0] === undefined ? {} : { question: shaped[0] }), structured: { lifecycle: 'live', revision: 1, ...structured, ...(shaped.length === 0 ? {} : { questions: shaped }) }, queuedPromptCount: 0 };
      const pi = { launchable: true, program: '/node', stateSource: 'reported', turnCapture: true, conversations: false, naming: false, inlineQuestions: true, steer: true, commands: false, sandbox: false };
      return route.fulfill({ json: { generation: 1, adapters: { pi }, agents: [agent], projects: [{ id: 'app', label: 'App', available: true, worktrees: [worktree] }] } });
    }
    if (url.pathname === '/api/agents/agent-1/transcript') return route.fulfill({ json: { items: [], earlier: 0, status: { extension: [] } } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return posts;
}

const composer = (page: Page) => page.getByRole('region', { name: 'Prompt composer' });
const prompt = (page: Page) => composer(page).getByRole('textbox', { name: 'Prompt' });

test('while the Agent works, Alt+Enter steers it with the draft and the pending steers show apart from the queue', async ({ page }) => {
  const posts = await mockPi(page, { structured: { steers: ['Use tabs'] } });
  await page.goto('/');
  await expect(composer(page).getByRole('status')).toHaveText('1 steer pending');
  await expect(composer(page).getByRole('button', { name: 'Alt+Enter steers' })).toBeDisabled();

  await prompt(page).fill('And add tests');
  await prompt(page).press('Alt+Enter');
  await expect.poll(() => posts).toEqual([{ path: 'steer', body: { prompt: 'And add tests' } }]);
  await expect(prompt(page)).toHaveValue('');

  // the queue flyout opens on the pending steers alone, marked as not queued
  await composer(page).getByRole('button', { name: 'Queued prompts (0)' }).click();
  const steers = page.getByLabel('Pending steers');
  await expect(steers).toContainText('held by the agent, not in the queue');
  await expect(steers.getByRole('listitem')).toHaveText(['Use tabs']);
});

test('the Steer hint is tappable and steers the draft', async ({ page }) => {
  const posts = await mockPi(page);
  await page.goto('/');
  await prompt(page).fill('Stop and explain');
  await composer(page).getByRole('button', { name: 'Alt+Enter steers' }).click();
  await expect.poll(() => posts).toEqual([{ path: 'steer', body: { prompt: 'Stop and explain' } }]);
});

test('an idle Agent offers no Steer', async ({ page }) => {
  await mockPi(page, { attention: 'finished' });
  await page.goto('/');
  await expect(prompt(page)).toBeVisible();
  await expect(composer(page).getByRole('button', { name: 'Alt+Enter steers' })).toHaveCount(0);
});

test('cancelling puts the steers the Agent dropped back in the composer', async ({ page }) => {
  const posts = await mockPi(page, { structured: { steers: ['Use tabs'] }, cancelled: ['Use tabs'] });
  await page.goto('/');
  await prompt(page).fill('My draft');
  await page.getByRole('button', { name: 'Cancel agent' }).click();
  await expect(prompt(page)).toHaveValue('Use tabs\n\nMy draft');
  expect(posts.map(post => post.path)).toEqual(['cancel']);
});

test('several open questions page one at a time: a choice, a text answer from its prefill with a countdown, and Dismiss', async ({ page }) => {
  const expiresAt = Date.now() + 90_000;
  const posts = await mockPi(page, { attention: 'question', structured: { questions: [
    { id: 'q1', text: 'Which branch?', field: { kind: 'choice', choices: ['main', 'dev'] } },
    { id: 'q2', text: 'Commit message?', field: { kind: 'text', multiline: true, prefill: 'Fix the badge' }, expiresAt },
    { id: 'q3', text: 'Push now?', field: { kind: 'choice', choices: ['Yes', 'No'] } }
  ] } });
  await page.goto('/');
  const box = page.getByRole('region', { name: 'Agent question' });
  await expect(box).toContainText('Which branch?');
  await expect(box).toContainText('1 of 3');
  await box.getByRole('button', { name: /dev/u }).click();
  await box.getByRole('button', { name: 'next' }).click();

  await expect(box).toContainText('Commit message?');
  await expect(box).toContainText('2 of 3');
  await expect(box.getByRole('timer')).toHaveText(/ · (89|90)s left/u);
  const answer = box.getByRole('textbox', { name: 'Answer' });
  await expect(answer).toHaveValue('Fix the badge');
  await answer.fill('Fix the empty badge');
  await box.getByRole('button', { name: 'Answer' }).click();
  await box.getByRole('button', { name: 'next' }).click();

  await expect(box).toContainText('Push now?');
  await expect(box.getByRole('timer')).toHaveCount(0);
  await box.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => posts).toEqual([
    { path: 'question', body: { questionId: 'q1', index: 1 } },
    { path: 'question', body: { questionId: 'q2', text: 'Fix the empty badge' } },
    { path: 'question', body: { questionId: 'q3', dismiss: true } }
  ]);
});

test('text the Agent offers fills an empty composer', async ({ page }) => {
  await mockPi(page, { attention: 'finished', structured: { draft: { id: 1, text: 'Suggested next step' } } });
  await page.goto('/');
  await expect(prompt(page)).toHaveValue('Suggested next step');
});

test('text the Agent offers never replaces a draft', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('remote-agent-console:prompt-draft:agent-1', 'My own draft'));
  await mockPi(page, { attention: 'finished', structured: { draft: { id: 1, text: 'Suggested next step' } } });
  await page.goto('/');
  await expect(prompt(page)).toHaveValue('My own draft');
});

test('Clear starts a new Conversation, since a structured Agent takes no slash commands', async ({ page }) => {
  const posts = await mockPi(page, { attention: 'finished' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Clear' }).click();
  await expect.poll(() => posts).toEqual([{ path: 'conversations/new', body: undefined }]);
  await expect(page.getByRole('status').filter({ hasText: 'Cora cleared' })).toContainText('new conversation');
});
