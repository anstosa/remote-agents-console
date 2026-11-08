import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';
import { chooseSplit } from './split-menu.js';

// The soft-keyboard treatment: the tablist hides when the keyboard shrinks the viewport
// while the composer or the pane is focused, and returns when the keyboard closes; streamed
// output arriving while typing never steals focus; and the split-view browser keeps the
// output full-width across keyboard-driven aspect changes.

test('hides the tablist under the keyboard and keeps pane focus across streamed output', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 900 });
  await page.addInitScript(() => {
    let height = window.innerHeight;
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => height },
      offsetTop: { get: () => 0 },
      pageTop: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
      width: { get: () => window.innerWidth }
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, '__setVisualViewportHeight', {
      value: (next: number) => { height = next; viewport.dispatchEvent(new Event('resize')); }
    });
  });
  await installPaneMock(page);
  await page.route('https://project.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Project preview</main>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', projectUrl: 'https://project.example.com', stack: { running: true, tunnel: true }, queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  const setViewportHeight = (next: number) => page.evaluate(height => (window as unknown as { __setVisualViewportHeight: (height: number) => void }).__setVisualViewportHeight(height), next);

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const tabs = page.getByRole('tablist');
  const staticBar = page.getByRole('region', { name: 'Workspace toolbar' });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(tabs).toBeVisible();
  await expect(staticBar).toBeVisible();

  // A shrink with nothing focused is not a keyboard; tabs stay.
  await setViewportHeight(500);
  await expect(tabs).toBeVisible();
  await expect(staticBar).toBeVisible();
  await setViewportHeight(900);

  // Composer focus + shrink hides the tabs; restoring the height brings them back.
  await prompt.focus();
  await setViewportHeight(500);
  await expect(tabs).toBeHidden();
  await expect(staticBar).toBeHidden();
  await setViewportHeight(900);
  await expect(tabs).toBeVisible();
  await expect(staticBar).toBeVisible();

  // Focusing the pane and shrinking hides the tabs too.
  const output = page.getByLabel('Live log');
  const terminalInput = page.locator('.log-canvas .xterm-helper-textarea');
  await output.locator('.xterm-screen').click();
  await expect(terminalInput).toBeFocused();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await setViewportHeight(500);
  await expect(tabs).toBeHidden();
  await expect(staticBar).toBeHidden();

  // Streamed output while typing never steals focus.
  await pushBytes(page, 'agent-1', 'Updated output while typing\r\n');
  await expect(terminalInput).toBeFocused();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await expect(tabs).toBeHidden();

  // Closing the keyboard restores the tabs.
  await setViewportHeight(900);
  await expect(tabs).toBeVisible();
  await expect(staticBar).toBeVisible();

  // On the phone a second panel joins the carousel; typing in the composer shows the agent alone,
  // and closing the keyboard brings the carousel and its dots back where they were.
  // leave the pane, so the toolbar is back from its helper keys
  await terminalInput.evaluate(element => (element as HTMLElement).blur());
  await expect(page.locator('.log-output')).not.toHaveClass(/input-active/u);
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const phoneBrowser = page.getByRole('dialog', { name: 'Browser' });
  await expect(phoneBrowser).toBeInViewport({ ratio: 0.99 });
  const dots = page.getByRole('group', { name: 'Panels' });
  await chooseSplit(page, 'Agent output');
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await prompt.focus();
  await setViewportHeight(500);
  await expect(phoneBrowser).toBeHidden();
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await setViewportHeight(900);
  await expect(dots).toBeVisible();
  await expect(page.locator('.log-output')).toBeInViewport({ ratio: 0.99 });
  await expect(dots.locator('.panel-dot[title="Show agent output"]')).toHaveAttribute('data-current', 'true');
  await chooseSplit(page, 'Project browser');
  await expect(phoneBrowser).toBeInViewport({ ratio: 0.99 });
  // leave the browser closed for the desktop step below
  await phoneBrowser.getByRole('button', { name: 'Close browser' }).click();
  await expect(phoneBrowser).toHaveCount(0);

  // The split-view browser keeps the output full-width across keyboard aspect changes.
  await page.setViewportSize({ width: 900, height: 1200 });
  await setViewportHeight(1200);
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect.poll(() => output.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(899);
  await prompt.focus();
  await setViewportHeight(500);
  await expect(browser).toBeHidden();
  await expect.poll(() => output.evaluate(element => element.getBoundingClientRect().right)).toBeGreaterThanOrEqual(899);
  await setViewportHeight(1200);
  await expect(browser).toBeVisible();
});
