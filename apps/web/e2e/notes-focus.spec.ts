import { expect, test, type Page } from '@playwright/test';

// mount one focused workspace with an empty notes list
async function mountNotesWorkspace(page: Page) {
  await page.route('**/api/**', async route => {
    // answer only the console requests this focus contract needs
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the test browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active workspace
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' }], projects: [] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    // keep saved prompts empty
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // keep prompt history empty
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // expose an empty notes flyout
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    // reject unrelated requests
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
}

// group touch-specific focus behavior
test.describe('mobile notes focus', () => {
  // emulate the phone touch path
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // dismiss the software keyboard when notes open
  test('moves focus off the prompt when a touch opens the Notes flyout', async ({ page }) => {
    await mountNotesWorkspace(page);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    const notes = page.getByRole('button', { name: 'Notes (0)' });

    await prompt.fill('Keep this draft');
    await expect(prompt).toBeFocused();
    await notes.tap();

    await expect(page.getByLabel('Worktree notes')).toBeVisible();
    await expect(prompt).not.toBeFocused();
    await expect(prompt).toHaveValue('Keep this draft');
  });
});

// group mouse-specific focus behavior
test.describe('desktop notes focus', () => {
  // match a desktop browser without touch emulation
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1400, height: 900 } });

  // align ordinary Notes clicks with the other flyout triggers
  test('moves focus off the prompt on a primary click', async ({ page }) => {
    await mountNotesWorkspace(page);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    const notes = page.getByRole('button', { name: 'Notes (0)' });

    await prompt.fill('Keep this draft');
    await notes.click();

    await expect(page.getByLabel('Worktree notes')).toBeVisible();
    await expect(prompt).not.toBeFocused();
    await expect(prompt).toHaveValue('Keep this draft');
  });

  // retain prompt editing state for the deliberate context-click path
  test('preserves prompt focus and selection on a Notes context click', async ({ page }) => {
    await mountNotesWorkspace(page);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    const notes = page.getByRole('button', { name: 'Notes (0)' });

    await prompt.fill('alpha beta');
    await prompt.evaluate((element: HTMLTextAreaElement) => {
      // select the prompt suffix
      element.setSelectionRange(6, 10);
    });
    await notes.click({ button: 'right' });

    await expect(page.getByLabel('Worktree notes')).toBeVisible();
    await expect(prompt).toBeFocused();
    await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => {
      // read the preserved range
      return [element.selectionStart, element.selectionEnd];
    })).toEqual([6, 10]);
  });
});
