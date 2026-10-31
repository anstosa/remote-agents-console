import { expect, test } from '@playwright/test';

// dispatch configured pr repair without exposing executable request data
test('dispatches a configured $fixup beside a pull request with detected issues', async ({ page }) => {
  const emptyButtonSlots = {
    tabLead: [], leftNav: [], rightNav: [], navMenu: [], pullRequest: [],
    'split:agent': [], 'split:terminal': [], 'split:note': [], 'split:browser': [], 'split:files': [], 'split:code': [], 'split:review': [], 'split:stack': [], 'split:settings': []
  };
  const starts: Array<Record<string, unknown>> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose a pr and its configured action
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', placeId: 'cora', projectId: 'repo', branch: 'feature/fixup', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, title: 'Ready', pullRequest: { number: 42, title: 'Repair this PR', status: 'open', url: 'https://github.com/octo/repo/pull/42', issues: { failingChecks: true } } }],
      projects: [],
      buttons: { revision: 'buttons-v1', application: { ...emptyButtonSlots, pullRequest: [{ id: 'fixup-action', text: '$fixup', color: 'lavender', style: 'outline', actionKind: 'shell' }] }, projects: {} }
    } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the agent stream
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // keep prompt collections empty
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // keep repository choices empty
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // record opaque configured action dispatch
    if (url.pathname === '/api/button-actions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      starts.push(body);
      return route.fulfill({ status: 202, json: { operation: { id: 'operation-fixup-action', state: 'complete', phase: 'submitted' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  await expect(panel.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  const fixup = panel.getByRole('button', { name: '$fixup', exact: true });
  await expect(fixup).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Queue $fixup' })).toHaveCount(0);
  await expect(panel.locator('.pull-request-fixup')).toHaveCount(0);
  await fixup.click();

  await expect.poll(() => starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ actionId: 'fixup-action', configRevision: 'buttons-v1', placeId: 'cora', slot: 'pullRequest', agentId: 'agent-1' });
  expect(starts[0]).not.toHaveProperty('command');
  expect(starts[0]).not.toHaveProperty('prompt');
  expect(starts[0]).not.toHaveProperty('cwd');
  await expect(panel).toHaveCount(0);
});
