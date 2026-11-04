import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { openCodeViewMenu } from './panel-header.js';

const filePath = 'src/app.ts';
const workspace = '/home/ubuntu/project';
const operationId = 'operation-delete-00000001';

type RequestRecord = { path: string; method: string; body?: unknown };
type Gate = { started: Promise<void>; release: () => void };
type ComparisonKind = 'working' | 'pr' | 'commit';
type Scenario = {
  initial?: 'modified' | 'deleted' | 'binary';
  nested?: 'normal' | 'outside-root' | 'directory';
  prepareFailure?: boolean;
  executeFailure?: boolean;
  holdPrepare?: boolean;
  holdExecute?: boolean;
};
type Mounted = {
  panel: Locator;
  records: RequestRecord[];
  comparisonReads: () => number;
  prepareGate?: Gate;
  executeGate?: Gate;
};

// build one externally controlled request gate
function gate(): Gate & { wait: Promise<void>; markStarted: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  return { wait, started, release, markStarted };
}

// describe one valid file-system entry
function entry(name: string, kind: 'file' | 'directory', parent: string, token = `object-token:${name}:00000000`) {
  return {
    name,
    hostPath: `${parent}/${name}`,
    kind,
    owner: { uid: 1000, label: 'ubuntu' },
    permissions: kind === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--',
    mode: kind === 'directory' ? 0o40755 : 0o100644,
    modifiedAt: '2026-11-04T12:00:00.000Z',
    size: kind === 'directory' ? 4096 : 48,
    objectToken: token
  };
}

// describe one valid directory listing
function listing(path: string, entries: ReturnType<typeof entry>[]) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  return {
    path,
    parent,
    destinationDirectoryToken: `directory-token:${path}`,
    directoryEntry: { ...entry(name, 'directory', parent, `object-token:directory:${path}`), hostPath: path },
    entries,
    inaccessibleEntries: 0,
    truncated: false
  };
}

// produce one comparison revision for the requested file state
function comparison(state: NonNullable<Scenario['initial']>, deletedAfterMutation = false, kind: ComparisonKind = 'working') {
  const deleted = deletedAfterMutation || state === 'deleted';
  const change = { code: deleted ? ' D' : state === 'binary' ? ' M' : ' M', path: filePath, additions: deleted ? 0 : 1, deletions: 1 };
  const patch = deleted
    ? `diff --git a/${filePath} b/${filePath}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${filePath}\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const app = false;\n`
    : state === 'binary'
      ? `diff --git a/${filePath} b/${filePath}\nindex 1111111..2222222 100644\nBinary files a/${filePath} and b/${filePath} differ\n`
      : `diff --git a/${filePath} b/${filePath}\nindex 1111111..2222222 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-export const app = false;\n+export const app = true;\n`;
  return { kind, base: kind === 'working' ? 'HEAD' : 'origin/main', gitBase: 'HEAD', truncated: false, fingerprint: `${kind}:${deleted ? 'deleted' : state}`, files: [{ change, kind: state === 'binary' && !deleted ? 'binary' : 'tracked', capped: false, patch }] };
}

// install one complete app boundary and open its selected code file
async function mount(page: Page, scenario: Scenario = {}): Promise<Mounted> {
  const initial = scenario.initial ?? 'modified';
  const records: RequestRecord[] = [];
  const prepare = scenario.holdPrepare ? gate() : undefined;
  const execute = scenario.holdExecute ? gate() : undefined;
  let comparisonReads = 0;
  let deleted = false;
  await installPaneMock(page);
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() === null ? undefined : request.postDataJSON();
    records.push({ path: url.pathname, method: request.method(), body });
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Delete file test' } });
    // publish one active worktree with one changed file
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', placeId: 'cora', worktreeId: 'cora', sessionId: 'socket:$1', home: workspace, branch: 'feature/delete-file', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [comparison(initial).files[0]!.change] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [comparison(initial).files[0]!.change] }, title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    // authorize the agent pane
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // satisfy shared startup reads
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // return empty agent collections
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // return no message attachments
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // return no saved notes
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // return no file favorites
    if (url.pathname === '/api/worktrees/cora/file-favorites') return route.fulfill({ json: { favorites: [] } });
    // preload an empty repository chooser
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // return the current comparison and its post-delete revision
    if (url.pathname === '/api/worktrees/cora/comparison') {
      comparisonReads += 1;
      const requestedKind = (body as { kind?: unknown } | undefined)?.kind;
      const kind: ComparisonKind = requestedKind === 'commit' || requestedKind === 'pr' ? requestedKind : 'working';
      return route.fulfill({ json: comparison(initial, deleted, kind) });
    }
    // return one historical commit for the picker and flyout
    if (url.pathname === '/api/worktrees/cora/commits') return route.fulfill({ json: { base: 'origin/main', truncated: false, commits: [{ sha: 'abc1234000000000000000000000000000000000', subject: 'Historical change', body: '', author: 'Alex', authoredAt: '2026-11-04T11:00:00.000Z', merge: false, pushed: true, changes: [comparison('modified').files[0]!.change] }] } });
    // resolve the canonical workspace before any nested file lookup
    if (url.pathname === '/api/worktrees/cora/files/list') {
      const requested = (body as { path?: string } | undefined)?.path;
      // return the canonical home on an unscoped read
      if (requested === undefined) return route.fulfill({ json: listing(workspace, [entry('src', 'directory', workspace)]) });
      const parent = scenario.nested === 'outside-root' ? '/tmp/escaped' : `${workspace}/src`;
      const kind = scenario.nested === 'directory' ? 'directory' : 'file';
      return route.fulfill({ json: listing(parent, [entry('app.ts', kind, parent, 'object-token:app.ts:00000000')]) });
    }
    // prepare the identity-bound deletion manifest
    if (url.pathname === '/api/worktrees/cora/files/operations/prepare') {
      prepare?.markStarted();
      // hold the exact preparation when requested
      if (prepare !== undefined) await prepare.wait;
      // expose a stale-object preparation failure
      if (scenario.prepareFailure) return route.fulfill({ status: 409, json: { error: { code: 'stale_object', message: 'The file changed; refresh and try again.' } } });
      return route.fulfill({ json: { operationId, kind: 'delete', totalItems: 1, conflicts: [], confirmation: { permanent: true, names: ['app.ts'], count: 1 } } });
    }
    // execute only the explicitly confirmed deletion
    if (url.pathname === `/api/worktrees/cora/files/operations/${operationId}/execute`) {
      execute?.markStarted();
      // hold the exact mutation when requested
      if (execute !== undefined) await execute.wait;
      // expose an ambiguous mutation failure without retrying it
      if (scenario.executeFailure) return route.fulfill({ status: 503, json: { error: { code: 'operation_unknown', message: 'The deletion result is unknown.' } } });
      deleted = true;
      return route.fulfill({ status: 202, json: { operationId, kind: 'delete', state: 'completed', phase: 'complete', completedItems: 1, totalItems: 1, bytesCompleted: 0, bytesTotal: 0, results: [{ sourcePath: `${workspace}/${filePath}`, outcome: 'deleted' }] } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: `Not mocked: ${url.pathname}` } } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  const flyout = page.getByRole('region', { name: 'Changed files' });
  // open the selected working-tree file
  await flyout.getByRole('button', { name: `View changes to ${filePath}` }).click();
  const panel = page.getByRole('region', { name: 'Code changes' });
  await expect(panel).toBeVisible();
  return { panel, records, comparisonReads: () => comparisonReads, ...(prepare === undefined ? {} : { prepareGate: prepare }), ...(execute === undefined ? {} : { executeGate: execute }) };
}

// locate one request family in capture order
function requests(mounted: Mounted, suffix: string): RequestRecord[] {
  return mounted.records.filter(record => record.path.endsWith(suffix));
}

// open the code header menu and return its destructive action
async function deleteAction(panel: Locator): Promise<Locator> {
  return (await openCodeViewMenu(panel)).getByRole('button', { name: 'Delete file', exact: true });
}

// bind confirmation to one file and keep cancellation harmless
test('prepares only the selected file and cancellation never executes it', async ({ page }) => {
  const mounted = await mount(page, { holdPrepare: true });
  await (await deleteAction(mounted.panel)).click();
  const dialog = page.getByRole('alertdialog', { name: 'Permanently delete file?' });
  await expect(dialog).toBeVisible();
  await mounted.prepareGate!.started;
  await expect(dialog.getByRole('button', { name: 'Delete file' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(requests(mounted, '/files/list').map(record => record.body)).toEqual([{}, { path: `${workspace}/src` }]);
  mounted.prepareGate!.release();
  await expect(dialog.getByRole('button', { name: 'Delete file' })).toBeEnabled();
  expect(requests(mounted, '/operations/prepare').at(-1)?.body).toEqual({ kind: 'delete', sourceTokens: ['object-token:app.ts:00000000'] });
  expect(requests(mounted, '/execute')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests(mounted, '/execute')).toHaveLength(0);
  await expect(mounted.panel.getByRole('button', { name: 'More code panel actions' })).toBeFocused();
});

// commit one explicit deletion before refreshing the comparison
test('confirms exactly one deletion and refreshes the selected comparison', async ({ page }) => {
  const mounted = await mount(page, { holdExecute: true });
  await (await deleteAction(mounted.panel)).click();
  const dialog = page.getByRole('alertdialog', { name: 'Permanently delete file?' });
  const confirm = dialog.getByRole('button', { name: 'Delete file' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await mounted.executeGate!.started;
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(requests(mounted, '/execute')).toHaveLength(1);
  mounted.executeGate!.release();
  await expect(dialog).toHaveCount(0);
  expect(requests(mounted, '/execute').at(-1)?.body).toEqual({ decisions: {}, confirmed: true });
  await expect.poll(mounted.comparisonReads).toBeGreaterThanOrEqual(2);
  await expect(await deleteAction(mounted.panel)).toBeDisabled();
});

// reject stale preparations before granting delete authority
test('keeps preparation failures explicit and non-executable', async ({ page }) => {
  const mounted = await mount(page, { prepareFailure: true });
  await (await deleteAction(mounted.panel)).click();
  const dialog = page.getByRole('alertdialog', { name: 'Permanently delete file?' });
  await expect(dialog.getByRole('alert')).toContainText('changed');
  await expect(dialog.getByRole('button', { name: 'Delete file' })).toBeDisabled();
  expect(requests(mounted, '/execute')).toHaveLength(0);
});

// never replay a possibly completed mutation
test('does not retry an ambiguous execute failure', async ({ page }) => {
  const mounted = await mount(page, { executeFailure: true });
  await (await deleteAction(mounted.panel)).click();
  const dialog = page.getByRole('alertdialog', { name: 'Permanently delete file?' });
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(dialog.getByRole('alert')).toContainText('unknown');
  await expect(dialog.getByRole('button', { name: 'Delete file' })).toBeDisabled();
  expect(requests(mounted, '/execute')).toHaveLength(1);
});

// reject both containment and object-kind changes
for (const [name, nested] of [['an escaped parent', 'outside-root'], ['a replacement directory', 'directory']] as const) {
  // preserve containment and file-only deletion for each unsafe target
  test(`refuses deletion when the current object is ${name}`, async ({ page }) => {
    const mounted = await mount(page, { nested });
    await (await deleteAction(mounted.panel)).click();
    const dialog = page.getByRole('alertdialog', { name: 'Permanently delete file?' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete file' })).toBeDisabled();
    expect(requests(mounted, '/operations/prepare')).toHaveLength(0);
    expect(requests(mounted, '/execute')).toHaveLength(0);
  });
}

// omit mutation authority for an already deleted copy
test('disables deletion for a file already removed from the working tree', async ({ page }) => {
  const mounted = await mount(page, { initial: 'deleted' });
  const action = await deleteAction(mounted.panel);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('title', 'This file is already deleted');
});

// a selected path missing from the new comparison cannot authorize file lookup
test('disables deletion for a missing selected file without preparing a mutation', async ({ page }) => {
  const mounted = await mount(page);
  const revision = comparison('modified', false, 'working');
  const otherPath = 'src/other.ts';
  // keep the selected host file available but remove it from the next comparison
  await page.route('**/api/worktrees/cora/comparison', route => route.fulfill({ json: {
    ...revision,
    files: revision.files.map(file => ({ ...file, change: { ...file.change, path: otherPath }, patch: file.patch.replaceAll(filePath, otherPath) }))
  } }));
  await mounted.panel.locator('.code-pane-picker').click();
  await page.getByRole('menu', { name: 'Comparison' }).getByRole('menuitemradio', { name: 'Working changes', exact: true }).click();
  await expect(mounted.panel.getByRole('button', { name: 'All files', exact: true })).toBeVisible();
  await expect(mounted.panel.getByRole('alert')).toBeVisible();
  const action = await deleteAction(mounted.panel);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('title', 'File unavailable');
  expect(requests(mounted, '/files/list')).toHaveLength(0);
  expect(requests(mounted, '/operations/prepare')).toHaveLength(0);
  expect(requests(mounted, '/execute')).toHaveLength(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

// keep historical comparisons read only
test('disables deletion while viewing a historical commit', async ({ page }) => {
  const mounted = await mount(page);
  await mounted.panel.locator('.code-pane-picker').click();
  const picker = page.getByRole('menu', { name: 'Comparison' });
  await picker.getByRole('menuitemradio', { name: /Historical change/u }).click();
  await expect(mounted.panel.locator('.code-pane-branch')).toHaveText('abc1234');
  // select a historical file rather than testing only the all-files guard
  await mounted.panel.getByRole('button', { name: 'Expand code panel', exact: true }).click();
  await mounted.panel.getByRole('tree', { name: 'Changed files' }).getByRole('button', { name: /app\.ts/u }).click();
  const action = await deleteAction(mounted.panel);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('title', 'Historical commits are read only');
});

// require one selected target even without a text renderer
test('keeps binary working files deletable but disables the all-files action', async ({ page }) => {
  const mounted = await mount(page, { initial: 'binary' });
  await expect(await deleteAction(mounted.panel)).toBeEnabled();
  await page.keyboard.press('Escape');
  await mounted.panel.getByRole('button', { name: 'All files', exact: true }).click();
  const action = await deleteAction(mounted.panel);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('title', 'Open a file to delete it');
});
