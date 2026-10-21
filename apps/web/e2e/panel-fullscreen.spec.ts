import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import type { ComparisonFile, ComparisonPatch } from '../src/code-panel/comparison';

// a minimal valid unified diff for one modified file, enough for the panel's parser
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const patchOf = (files: ComparisonFile[]): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => file.change.path).join('|'), truncated: false });

const codePanel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const agentOutput = (page: Page) => page.locator('.log-output');

// A running agent, whose Working changes open in the Code panel beside the live output. Full-screen
// promotes the focused panel to fill the split (the `:has()` rule hides its siblings) and restores it.
test('promotes a panel to full screen in a running split and restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/fullscreen', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patchOf([trackedFile('src/app.ts')]) });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');

  // open the Working changes from the Git flyout — now the agent output and the Code panel share the split
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(codePanel(page)).toBeVisible();
  await expect(agentOutput(page)).toBeVisible();
  // the header names the Comparison, its file count and the branch, and offers the Agent's review
  await expect(codePanel(page).getByText('Working changes')).toBeVisible();
  await expect(codePanel(page).locator('.code-pane-branch')).toHaveText('feature/fullscreen');
  await expect(codePanel(page).getByRole('button', { name: 'Review', exact: true })).toBeVisible();

  // promote the Code panel: it fills the workspace and the agent output is hidden
  await codePanel(page).getByRole('button', { name: 'Expand code panel' }).click();
  await expect(codePanel(page)).toHaveClass(/\bexpanded\b/u);
  await expect(agentOutput(page)).toBeHidden();

  // restore: both panels are back
  await codePanel(page).getByRole('button', { name: 'Restore code panel' }).click();
  await expect(codePanel(page)).not.toHaveClass(/\bexpanded\b/u);
  await expect(agentOutput(page)).toBeVisible();

  // the agent output has its own full-screen control that hides the Code panel
  await page.getByRole('button', { name: 'Expand agent output' }).click();
  await expect(agentOutput(page)).toHaveClass(/\bexpanded\b/u);
  await expect(codePanel(page)).toBeHidden();
  // Escape originating inside the terminal canvas must NOT collapse full screen — the shell owns Esc
  await page.locator('.log-canvas').dispatchEvent('keydown', { key: 'Escape', bubbles: true });
  await expect(agentOutput(page)).toHaveClass(/\bexpanded\b/u);
  // but Esc from the restore control (outside the canvas) does restore
  await page.getByRole('button', { name: 'Restore agent output' }).press('Escape');
  await expect(agentOutput(page)).not.toHaveClass(/\bexpanded\b/u);
  await expect(codePanel(page)).toBeVisible();
});

// A Worktree with no running Agent has no agent output worth splitting against, so opening its changes
// puts the Code view straight into the full-screen host — it fills the workspace, hiding the inactive
// placeholder.
test('opens the Code view full screen for a Worktree with no running agent', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const worktree = { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/fullscreen', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] } };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/worktrees\/cora\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    if (/^\/api\/worktrees\/cora\/panes$/u.test(url.pathname)) return route.fulfill({ json: { panes: [] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patchOf([trackedFile('src/app.ts')]) });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // the inactive worktree has no agent panel: its Workspace is empty until changes are opened
  const empty = page.getByRole('region', { name: 'Empty workspace' });
  await expect(empty).toBeVisible();
  await expect(agentOutput(page)).toHaveCount(0);
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();

  // the Code view opens already promoted, filling the workspace in place of the empty notice
  await expect(codePanel(page)).toBeVisible();
  await expect(codePanel(page)).toHaveClass(/\bexpanded\b/u);
  await expect(codePanel(page).getByRole('button', { name: 'Restore code panel' })).toHaveAttribute('aria-pressed', 'true');
  await expect(empty).toHaveCount(0);
  // with no Agent the review is offered but disabled, with the reason
  const review = codePanel(page).getByRole('button', { name: 'Review', exact: true });
  await expect(review).toBeDisabled();
  await expect(review).toHaveAttribute('title', 'Launch agent to review');

  // and it restores to the split like any other panel
  await codePanel(page).getByRole('button', { name: 'Restore code panel' }).click();
  await expect(codePanel(page)).not.toHaveClass(/\bexpanded\b/u);
  await expect(codePanel(page)).toBeVisible();
  await expect(agentOutput(page)).toHaveCount(0);
});

// a wide desktop keeps each open workspace panel in one full-height horizontal row, including
// compositions where Note or Browser sits between the Agent and Code panels.
test('keeps Agent, a companion panel, and Code full-height on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1100 });
  await installPaneMock(page);
  const responses: Record<string, unknown> = {
    '/api/auth/session': { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' },
    '/api/dashboard': {
      generation: 1,
      agents: [{
        id: 'agent-1',
        worktreeId: 'cora',
        worktreeLabel: 'Cora',
        sessionId: 'socket:$1',
        home: '/worktrees/cora',
        branch: 'feature/desktop-split',
        projectUrl: 'https://project.example.com',
        gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] },
        title: 'Ready'
      }],
      projects: []
    },
    '/api/agents/agent-1/tickets': { ticket: 'log-ticket' },
    '/api/push/public-key': {},
    '/api/agents/agent-1/saved-prompts': { prompts: [] },
    '/api/agents/agent-1/prompt-history': { prompts: [] },
    '/api/agents/agent-1/queued-prompts': { prompts: [] },
    '/api/agents/agent-1/message-files': { files: [] },
    '/api/worktrees/cora/notes': { notes: [{ id: 'note-identifier-001', title: 'Remote Agents Summary', text: 'Desktop layout regression' }] },
    '/api/worktrees/cora/comparison': patchOf([trackedFile('src/app.ts')])
  };
  // serve the real workspace UI from a compact fixed API fixture
  await page.route('**/api/**', async route => {
    const response = responses[new URL(route.request().url()).pathname];
    // return every endpoint used by this workspace composition
    if (response !== undefined) return route.fulfill({ json: response });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  // keep the embedded project preview local and deterministic
  await page.route('https://project.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Project preview</main>' }));

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.locator('.notes-menu .note-choice').click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const split = page.locator('.log-split');
  const agent = agentOutput(page);
  const note = page.getByRole('dialog', { name: 'Note' });
  const code = codePanel(page);
  // compare rendered panel geometry, not implementation-only class names
  const expectHorizontalFullHeight = async (panels: ReturnType<Page['locator']>[]) => {
    const splitBox = await split.boundingBox();
    expect(splitBox).not.toBeNull();
    const panelBoxes = await Promise.all(panels.map(panel => panel.boundingBox()));
    // require each panel to occupy the split from top to bottom
    for (const panelBox of panelBoxes) {
      expect(panelBox).not.toBeNull();
      expect(Math.abs(panelBox!.y - splitBox!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(panelBox!.height - splitBox!.height)).toBeLessThanOrEqual(1);
    }
    // require successive panels to occupy horizontal columns without wrapping below
    for (let index = 1; index < panelBoxes.length; index += 1) {
      const previous = panelBoxes[index - 1]!;
      const current = panelBoxes[index]!;
      expect(previous.x + previous.width).toBeLessThanOrEqual(current.x + 1);
    }
  };

  await expect(note).toBeVisible();
  await expect(code).toBeVisible();
  await expectHorizontalFullHeight([agent, note, code]);

  // replace Note with Browser to cover the sibling selector that produces the same regression
  await note.getByRole('button', { name: 'Close note' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expectHorizontalFullHeight([agent, browser, code]);

  // cover the four-panel selector while Browser stays open
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.locator('.notes-menu .note-choice').click();
  await expect(note).toBeVisible();
  await expectHorizontalFullHeight([agent, note, browser, code]);
});
