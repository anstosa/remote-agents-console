import { expect, test } from '@playwright/test';
import { stackActionLabel, stackOperationLabel } from '../src/stack-operations';
import { expectProgressBorder } from './progress-border-assertions';

test('uses action-specific stack operation labels', () => {
  expect(stackActionLabel('build')).toBe('Build stack');
  expect(stackOperationLabel('start')).toBe('Starting');
  expect(stackOperationLabel('stop')).toBe('Stopping');
  expect(stackOperationLabel('build')).toBe('Building');
  expect(stackOperationLabel('restart')).toBe('Restarting');
  expect(stackOperationLabel('migrate')).toBe('Migrating');
});

test('keeps the stack flyout available during an operation', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="busy-root"></div>');
  await page.evaluate(async () => {
    const { renderProjectOpen } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpen(document.querySelector<HTMLElement>('#busy-root')!);
  });
  const toggle = page.getByRole('button', { name: 'Stack controls: working' });
  await expect(toggle).toBeEnabled();
  await expect(toggle.locator('.project-stack-server-icon')).toBeVisible();
  await expect(toggle.locator('.project-stack-status-dot.status-working')).toBeVisible();
  await expectProgressBorder(toggle, 'peach');
  await toggle.click();
  const link = page.getByRole('link', { name: 'Open', exact: true });
  await expect(link).not.toHaveAttribute('aria-busy');
  await expect(link.locator(':scope > .update-progress-ring')).toHaveCount(0);
  await expect(link.locator('svg')).toBeVisible();
  await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Building…' })).toBeDisabled();
});

test('consolidates managed project controls into one server flyout', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  const toggle = root.getByRole('button', { name: 'Stack controls: down' });
  await expect(root.locator('.project-open-group > .project-stack-trigger')).toHaveCount(1);
  await expect(root.getByRole('link')).toHaveCount(0);
  await expect(root.getByRole('button')).toHaveCount(1);
  const [toggleBounds, dotBounds] = await Promise.all([toggle.boundingBox(), toggle.locator('.project-stack-status-dot').boundingBox()]);
  expect(toggleBounds).not.toBeNull();
  expect(dotBounds).not.toBeNull();
  // pin the status dot to the button's upper-right corner
  expect(Math.abs(dotBounds!.x + dotBounds!.width - (toggleBounds!.x + toggleBounds!.width - 3.2))).toBeLessThanOrEqual(1);
  expect(Math.abs(dotBounds!.y - (toggleBounds!.y + 3.2))).toBeLessThanOrEqual(1);
  await toggle.click();
  const footer = page.getByRole('group', { name: 'Project view controls' });
  const external = footer.getByRole('link', { name: 'Open', exact: true });
  const browser = footer.getByRole('button', { name: 'Split', exact: true });
  await expect(external).toHaveAttribute('href', 'https://project.example.com');
  await expect(external).toHaveCSS('white-space', 'nowrap');
  await expect(external.locator('svg')).toBeVisible();
  await expect(browser.locator('svg')).toBeVisible();
  await expect(footer).toHaveCSS('border-top-width', '1px');
  await expect(browser).toHaveCSS('border-left-width', '1px');
  const [externalBounds, browserBounds] = await Promise.all([external.boundingBox(), browser.boundingBox()]);
  expect(externalBounds).not.toBeNull();
  expect(browserBounds).not.toBeNull();
  expect(Math.abs(externalBounds!.x + externalBounds!.width - browserBounds!.x)).toBeLessThanOrEqual(1);
  const lastActionBounds = await page.getByRole('button', { name: 'Restart stack', exact: true }).boundingBox();
  const footerBounds = await footer.boundingBox();
  expect(lastActionBounds).not.toBeNull();
  expect(footerBounds).not.toBeNull();
  expect(lastActionBounds!.y + lastActionBounds!.height).toBeLessThan(footerBounds!.y);
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build stack', exact: true })).toBeVisible();
  await browser.click();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Build stack', exact: true }).click();
  await expect(root.locator('.project-stack-trigger')).toHaveAccessibleName('Stack controls: working');
});

test('keeps project view controls available while the stack is stopped', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStoppedProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderStoppedProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  await expect(root.getByRole('link')).toHaveCount(0);
  const toggle = root.getByRole('button', { name: 'Stack controls: down' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('link', { name: 'Open', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
});

test('keeps direct project controls visible independently of managed stack state', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="direct-root"></div><div id="unavailable-root"></div></div>');
  await page.evaluate(async () => {
    const { renderDirectProjectOpenControls, renderUnavailableDirectProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderDirectProjectOpenControls(document.querySelector<HTMLElement>('#direct-root')!);
    renderUnavailableDirectProjectOpenControls(document.querySelector<HTMLElement>('#unavailable-root')!);
  });

  const direct = page.locator('#direct-root');
  await expect(direct.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://external-preview.example/map/');
  // the Workspace toolbar's Browser button opens the split, so a direct project shows only its link
  await expect(direct.getByRole('button')).toHaveCount(0);

  const unavailable = page.locator('#unavailable-root');
  const unavailableToggle = unavailable.getByRole('button', { name: 'Stack controls: down' });
  await expect(unavailableToggle).toBeVisible();
  await expect(unavailable.getByRole('link')).toHaveCount(0);
  await unavailableToggle.click();
  const unavailableFooter = page.getByRole('group', { name: 'Project view controls' });
  await expect(unavailableFooter.getByRole('link', { name: 'Open', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(unavailableFooter.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
});

test('shows stack controls when the worktree has commands but no project URL', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStackOnlyControls } = await import('/e2e/project-open-fixture.tsx');
    renderStackOnlyControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  await expect(root.getByRole('link')).toHaveCount(0);
  const toggle = root.getByRole('button', { name: 'Stack controls' });
  await expect(toggle).toBeVisible();
  const cornerRadius = await toggle.evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius));
  expect(cornerRadius).toBeGreaterThan(0);
  await toggle.click();
  await page.getByRole('button', { name: 'Restart stack', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Stack controls: working');
});

test('shows accessible running, stopped, and unknown states on stack-only controls', async ({ page }) => {
  // render every published running state
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStackOnlyStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderStackOnlyStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const running = page.getByRole('button', { name: 'Stack controls: running' });
  const stopped = page.getByRole('button', { name: 'Stack controls: stopped' });
  const unknown = page.getByRole('button', { name: 'Stack controls: unknown' });
  await expect(running.locator('.project-stack-status-dot.status-running')).toBeVisible();
  await expect(stopped.locator('.project-stack-status-dot.status-stopped')).toBeVisible();
  await expect(unknown.locator('.project-stack-status-dot.status-unknown')).toBeVisible();
  // compare rendered state colors
  const statusColors = await Promise.all([running, stopped, unknown].map(control => control.locator('.project-stack-status-dot').evaluate(element => getComputedStyle(element).backgroundColor)));
  expect(new Set(statusColors).size).toBe(3);
  await expect(running).toHaveAttribute('title', 'Stack controls · running');
  await expect(stopped).toHaveAttribute('title', 'Stack controls · stopped');
  await expect(unknown).toHaveAttribute('title', 'Stack controls · unknown');
});

// a Start that is still waiting on its tunnel can be stopped or restarted, but not started again
test('offers Stop and Restart while the stack is Starting', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStartingProcessControls } = await import('/e2e/project-open-fixture.tsx');
    renderStartingProcessControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const toggle = page.getByRole('button', { name: 'Stack controls: working' });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restart stack', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop stack', exact: true }).click();
  // the Stop in flight locks the menu and names itself
  await toggle.click();
  await expectProgressBorder(toggle, 'red');
  await expect(toggle.locator('.project-stack-server-icon')).toBeVisible();
  const stopping = page.getByRole('button', { name: 'Stopping…' });
  await expect(stopping).toBeDisabled();
  await expectProgressBorder(stopping, 'red');
  await expect(page.getByRole('button', { name: 'Restart stack', exact: true })).toBeDisabled();
});

// a Stack process stopped on purpose reads stopped, whatever its tunnel last said; a failing
// tunnel still reads down for a running process and for a daemon-style stack
test('shows a stopped Stack process as stopped ahead of its tunnel', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStoppedProcessStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderStoppedProcessStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  await expect(page.locator('.project-stack-status-text')).toHaveText(['stopped', 'stopped', 'down', 'down']);
});

// a crashed Stack process reads apart from a deliberate stop, and its code is in the tooltip
test('shows an exited Stack process with its exit code, ahead of a down tunnel', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderExitedProcessStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderExitedProcessStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const crashed = page.getByRole('button', { name: 'Stack controls: dev exited (127)', exact: true });
  const signalled = page.getByRole('button', { name: 'Stack controls: dev exited', exact: true });
  await expect(crashed).toHaveAttribute('title', 'Stack controls · dev exited (127)');
  await expect(signalled).toHaveAttribute('title', 'Stack controls · dev exited');
  await expect(crashed.locator('.project-stack-status-text')).toHaveText('exited');
  await expect(crashed.locator('.project-stack-status-dot.status-exited')).toBeVisible();
  // Start reruns it from the menu
  await crashed.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeEnabled();
});

// a stack of several processes counts the running ones, names each exited one, and offers each
// process's own output
test("summarises several Stack processes on the badge, and opens the Stack panel on one", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderSeveralProcessStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderSeveralProcessStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const partial = page.getByRole('button', { name: 'Stack controls: 2 of 3 running', exact: true });
  await expect(partial.locator('.project-stack-status-text')).toHaveText('2 of 3 running');
  await expect(partial.locator('.project-stack-status-dot.status-partial')).toBeVisible();
  const exited = page.getByRole('button', { name: 'Stack controls: api exited (1), web exited (2)', exact: true });
  await expect(exited.locator('.project-stack-status-text')).toHaveText('exited');

  await partial.click();
  const menu = page.locator('.stack-menu');
  await expect(menu.locator('.stack-menu-heading .stack-process-state')).toHaveText('2 of 3 running');
  await expect(menu.locator('.stack-row-name')).toHaveText(['sync', 'api', 'web']);
  await menu.locator('[aria-label="web process"] > .stack-row').click();
  await page.getByRole('button', { name: 'Show web output', exact: true }).click();
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { openedPanels?: unknown }).openedPanels)).toEqual([{ kind: 'process', name: 'web' }]);
});

// the last one-shot command's output shows in the log dialog; a process's own is the Stack panel's
test("shows the last one-shot command's output in the log dialog, and opens the Stack panel from the menu", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const toggle = page.getByRole('button', { name: 'Stack controls: running' });
  await toggle.click();
  await page.getByRole('button', { name: 'Show last command output' }).click();
  const commandDialog = page.getByRole('dialog', { name: 'Stack output' });
  await expect(commandDialog.locator('pre')).toHaveText('built in 3s');
  await expect(commandDialog.locator('header strong')).toHaveText('Build stack output');
  await commandDialog.getByRole('button', { name: 'Close stack output' }).click();
  await expect(commandDialog).toHaveCount(0);

  await toggle.click();
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await expect(page.locator('.stack-menu')).toHaveCount(0);
  // on its first process
  expect(await page.evaluate(() => (window as unknown as { openedPanels?: unknown }).openedPanels)).toEqual([{ kind: 'process', name: 'dev' }]);
});

test('offers no last command output without one-shot commands, and shows an exited process with its code', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderExitedProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderExitedProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: dev exited (127)' }).click();
  await expect(page.getByRole('button', { name: 'Show last command output' })).toHaveCount(0);
  await expect(page.locator('.stack-menu .stack-row .stack-process-state')).toHaveText('exited 127');
});

// each process is a row that expands to its own Start/Stop/Restart, its relations and its output;
// the whole-stack actions stay at the top
test('lists several Stack processes as rows that expand one at a time, each with its own actions', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessSectionControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessSectionControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: web exited (1)', exact: true }).click();
  const menu = page.locator('.stack-menu');
  await expect(menu.locator('.stack-menu-title')).toHaveText('testing');
  await expect(menu.locator('.stack-menu-heading .stack-process-state')).toHaveText('2 of 4 running');
  await expect(menu.getByRole('button', { name: 'Start stack', exact: true })).toBeEnabled();
  await expect(menu.getByRole('button', { name: 'Restart stack', exact: true })).toBeEnabled();
  const rows = menu.locator('.stack-process > .stack-row');
  await expect(rows.locator('.stack-row-name')).toHaveText(['sync', 'api', 'web', 'docs']);
  await expect(rows.locator('.stack-process-state')).toHaveText(['running', 'running', 'exited 1', 'stopped']);
  const row = (name: string) => menu.locator(`[aria-label="${name} process"] > .stack-row`);
  const group = (name: string) => menu.getByRole('group', { name: `${name} process` });

  // collapsed until clicked, then one at a time
  await expect(menu.locator('.stack-row-body')).toHaveCount(0);
  await row('api').click();
  await expect(row('api')).toHaveAttribute('aria-expanded', 'true');
  const api = group('api');
  await expect(api.getByRole('button', { name: 'Start api', exact: true })).toBeDisabled();
  await expect(api.getByRole('button', { name: 'Stop api', exact: true })).toBeEnabled();
  await expect(api.getByRole('button', { name: 'Restart api', exact: true })).toBeEnabled();
  await expect(api.getByRole('group', { name: 'Needs' }).getByRole('button')).toHaveText(['sync']);
  await expect(api.getByRole('group', { name: 'Needed by' }).getByRole('button')).toHaveText(['web']);
  await row('web').click();
  await expect(row('api')).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.locator('.stack-row-body')).toHaveCount(1);
  const web = group('web');
  // an exited process can be started again, or cleared with Stop
  await expect(web.getByRole('button', { name: 'Start web', exact: true })).toBeEnabled();
  await expect(web.getByRole('button', { name: 'Stop web', exact: true })).toBeEnabled();
  await expect(web.getByRole('group', { name: 'Needed by' })).toHaveCount(0);
  // a chip expands the process it names, and clicking an expanded row collapses it
  await web.getByRole('group', { name: 'Needs' }).getByRole('button', { name: 'api' }).click();
  await expect(row('api')).toHaveAttribute('aria-expanded', 'true');
  await row('api').click();
  await expect(menu.locator('.stack-row-body')).toHaveCount(0);
  // a process that needs nothing, and that nothing needs, shows neither
  await row('docs').click();
  const docs = group('docs');
  await expect(docs.getByRole('group', { name: 'Needs' })).toHaveCount(0);
  await expect(docs.getByRole('group', { name: 'Needed by' })).toHaveCount(0);
  await expect(docs.getByRole('button', { name: 'Stop docs', exact: true })).toBeDisabled();

  // the action in flight shows on its own row, holds every other action, and keeps the menu open
  await row('api').click();
  const restartApi = api.getByRole('button', { name: 'Restart api', exact: true });
  await restartApi.click();
  const restartState = row('api').locator('.stack-process-state');
  await expect(restartState).toHaveText('Restarting…');
  await expectProgressBorder(restartState, 'yellow');
  await expectProgressBorder(restartApi, 'yellow');
  await expect(restartApi.locator('svg')).toBeVisible();
  await expect(api).toHaveAttribute('aria-busy', 'true');
  await expect(api.getByRole('button', { name: 'Restart api', exact: true })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Stop stack', exact: true })).toBeDisabled();
  // settle the mocked operation only after pending assertions finish
  await page.evaluate(() => (window as unknown as { releaseProcessAction: () => void }).releaseProcessAction());
  await expect(row('api').locator('.stack-process-state')).toHaveText('running');
  await expect(api.getByRole('button', { name: 'Restart api', exact: true })).toBeEnabled();
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { processActions?: unknown }).processActions)).toEqual([{ name: 'api', action: 'restart' }]);

  // one process's Stop leaves the rest running
  const stopApi = api.getByRole('button', { name: 'Stop api', exact: true });
  await stopApi.click();
  await expectProgressBorder(stopApi, 'red');
  // complete the separately held stop response
  await page.evaluate(() => (window as unknown as { releaseProcessAction: () => void }).releaseProcessAction());
  await expect(row('api').locator('.stack-process-state')).toHaveText('stopped');
  await expect(api.getByRole('button', { name: 'Stop api', exact: true })).toBeDisabled();
  await expect(rows.locator('.stack-process-state')).toHaveText(['running', 'stopped', 'exited 1', 'stopped']);

  // Show output opens the Stack panel on the process
  await api.getByRole('button', { name: 'Show api output', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { openedPanels?: unknown }).openedPanels)).toEqual([{ kind: 'process', name: 'api' }]);
});

test("shows a process action in flight elsewhere on that process's row", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessOperationControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessOperationControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: running', exact: true }).click();
  const api = page.getByRole('group', { name: 'api process' });
  const restarting = api.locator('.stack-row .stack-process-state');
  await expect(restarting).toHaveText('Restarting…');
  await expectProgressBorder(restarting, 'yellow');
  await api.locator('.stack-row').click();
  await expect(api.getByRole('button', { name: 'Restart api', exact: true })).toBeDisabled();
  const sync = page.getByRole('group', { name: 'sync process' });
  await sync.locator('.stack-row').click();
  await expect(sync.getByRole('button', { name: 'Stop sync', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restart stack', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  // a lone process's action shows as the stack's own
  await page.getByRole('button', { name: 'Stack controls: working', exact: true }).click();
  const stopping = page.getByRole('button', { name: 'Stopping…', exact: true });
  await expect(stopping).toBeDisabled();
  await expectProgressBorder(stopping, 'red');
  const stoppingState = page.getByRole('group', { name: 'dev process' }).locator('.stack-row .stack-process-state');
  await expect(stoppingState).toHaveText('Stopping…');
  await expectProgressBorder(stoppingState, 'red');
});

// a single process is the whole stack: its row shows already expanded, with nothing to relate to
test('shows a single Stack process as its row, already expanded, without a chevron or relations', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: running', exact: true }).click();
  const dev = page.getByRole('group', { name: 'dev process' });
  await expect(dev.locator('.stack-row-body')).toBeVisible();
  await expect(dev.locator('button.stack-row')).toHaveCount(0);
  await expect(dev.locator('.stack-row-chevron')).toHaveCount(0);
  await expect(dev.getByRole('group', { name: 'Needs' })).toHaveCount(0);
  await expect(dev.getByRole('button', { name: 'Start dev', exact: true })).toBeDisabled();
  await expect(dev.getByRole('button', { name: 'Stop dev', exact: true })).toBeEnabled();
  await expect(dev.getByRole('button', { name: 'Show dev output', exact: true })).toBeVisible();
});

// a process's notices show in its own row, and a warning marks the row and the badge on top of its state
test("shows a Stack process's notices in its menu row, and a warning marker on the badge", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessNoticeControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessNoticeControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const warned = page.getByRole('button', { name: 'Stack controls: running, warning: static is not running (obsidian-static master)', exact: true });
  await expect(warned.locator('.project-stack-status-text')).toHaveText('running');
  await expect(warned.locator('.project-stack-status-dot.status-running')).toBeVisible();
  await expect(warned.locator('.project-stack-warning')).toBeVisible();
  await expect(warned).toHaveAttribute('title', 'Stack controls · running\n⚠ static is not running (obsidian-static master)');

  await warned.click();
  const api = page.getByRole('group', { name: 'api process' });
  // the row warns, and shows its notices once expanded
  await expect(api.locator('.stack-row-warning')).toBeVisible();
  await api.locator('.stack-row').click();
  await expect(api.getByRole('listitem')).toHaveText(['static is not running (obsidian-static master)', 'using the cached schema']);
  await expect(api.locator('.stack-process-notice.level-warning')).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'web process' }).getByRole('listitem')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // a lone process's row is already expanded with its notices, and info marks nothing
  const lone = page.getByRole('button', { name: 'Stack controls: dev exited (1)', exact: true });
  await expect(lone.locator('.project-stack-warning')).toHaveCount(0);
  await lone.click();
  await expect(page.locator('.stack-menu .stack-row-warning')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'dev notices' }).getByRole('listitem')).toHaveText(['waiting for the database']);
});

// a notice naming another Worktree's stopped process starts it there while this menu stays open
test("starts a notice's process in another Worktree from the stack menu, showing a failure inline", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderNoticeTargetControls } = await import('/e2e/project-open-fixture.tsx');
    renderNoticeTargetControls(document.querySelector<HTMLElement>('#control-root')!);
  });
  const starts = () => page.evaluate(() => (window as unknown as { noticeStarts?: string[] }).noticeStarts);

  await page.getByRole('button', { name: /^Stack controls: running, warning/u }).click();
  const menu = page.locator('.stack-menu');
  await menu.locator('[aria-label="api process"] > .stack-row').click();
  const notices = menu.getByRole('list', { name: 'api notices' }).getByRole('listitem');
  const down = notices.filter({ hasText: 'static is not running' });
  // a resolved target offers Open, and Start only for a declared process that is not running
  await expect(down.getByRole('button', { name: 'Open Static · master', exact: true })).toBeVisible();
  await expect(down.getByRole('button', { name: 'Start static in Static · master', exact: true })).toBeVisible();
  const undeclared = notices.filter({ hasText: 'docs are stale' });
  await expect(undeclared.getByRole('button', { name: 'Open Static · master', exact: true })).toBeVisible();
  await expect(undeclared.getByRole('button', { name: /^Start/u })).toHaveCount(0);
  await expect(notices.filter({ hasText: 'using the cached schema' }).getByRole('button')).toHaveCount(0);
  // a notice naming this stack's own Worktree has nothing to Open
  await expect(notices.filter({ hasText: 'reloading the config' }).getByRole('button')).toHaveCount(0);

  // a failed Start shows its error on the notice and offers Start again
  await page.evaluate(() => { (window as unknown as { noticeStartError?: string }).noticeStartError = 'stack operation already running'; });
  await down.getByRole('button', { name: 'Start static in Static · master', exact: true }).click();
  await expectProgressBorder(down.getByRole('status'), 'green');
  await expect(down.getByRole('status')).toHaveText('Starting static…');
  await expect(down.getByRole('button')).toHaveCount(0);
  await expect(down.getByRole('alert')).toHaveText('Start failed: stack operation already running');
  await expect(down.getByRole('button', { name: 'Start static in Static · master', exact: true })).toBeVisible();
  await expect(menu).toBeVisible();

  // a Start sends the other Worktree's request, shows Starting with the menu open, and the
  // notice hides once the next state shows the process running
  await down.getByRole('button', { name: 'Start static in Static · master', exact: true }).click();
  await expectProgressBorder(down.getByRole('status'), 'green');
  await expect(down.getByRole('status')).toHaveText('Starting static…');
  await expect(down.getByRole('alert')).toHaveCount(0);
  // the request returned, but the state still reads stopped: the notice keeps showing Starting
  await page.waitForFunction(() => (window as unknown as { releaseNoticeStart?: unknown }).releaseNoticeStart !== undefined);
  await page.waitForTimeout(500);
  await expect(down.getByRole('status')).toHaveText('Starting static…');
  await expect(down.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseNoticeStart: () => void }).releaseNoticeStart());
  await expect(down).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(notices).toHaveText(['docs are stale', 'using the cached schema', 'reloading the config'].map(message => new RegExp(`^${message}`, 'u')));
  expect(await starts()).toEqual(['site:/code/static static', 'site:/code/static static']);
  await expect(page.getByRole('button', { name: 'Stack controls: running', exact: true })).toBeVisible();
});

// Open switches to the notice's Worktree and opens that Worktree's stack menu
test("opens a notice's Worktree with its stack menu open", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderNoticeTargetControls } = await import('/e2e/project-open-fixture.tsx');
    renderNoticeTargetControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: /^Stack controls: running, warning/u }).click();
  await page.locator('.stack-menu [aria-label="api process"] > .stack-row').click();
  await page.getByRole('list', { name: 'api notices' }).getByRole('listitem').filter({ hasText: 'static is not running' }).getByRole('button', { name: 'Open Static · master', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { openedTargets?: string[] }).openedTargets)).toEqual(['site:/code/static']);
  await expect(page.getByRole('button', { name: 'Stack controls: stopped', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.stack-menu').getByRole('button', { name: 'Start stack', exact: true })).toBeEnabled();
});

// The down rule: a used process that is not running (stopped or exited) counts as down only while
// a process here that uses it runs or is starting, on its row, on the Other worktrees row and on
// the badge; another process here running does not count
test('warns of a used process that is down only while a process using it runs', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderUsesControls } = await import('/e2e/project-open-fixture.tsx');
    renderUsesControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const badge = page.getByRole('button', { name: 'Stack controls: 2 of 3 running, warning: static in Static Site / Main is not running; queue in Queue / Main is not running', exact: true });
  await expect(badge.locator('.project-stack-warning')).toBeVisible();
  await badge.click();
  const menu = page.locator('.stack-menu');
  const api = menu.getByRole('group', { name: 'api process' });
  const web = menu.getByRole('group', { name: 'web process' });
  const worker = menu.getByRole('group', { name: 'worker process' });
  await expect(api.locator('.stack-row-warning')).toBeVisible();
  await expect(web.locator('.stack-row-warning')).toHaveCount(0);
  await expect(worker.locator('.stack-row-warning')).toBeVisible();
  const others = menu.getByRole('group', { name: 'Other worktrees' });
  const othersState = others.locator('.stack-row .stack-process-state');
  await expect(others.locator('.stack-row .stack-row-name')).toHaveText('Other worktrees');
  await expect(othersState).toHaveText('2 down');
  await expect(othersState).toHaveClass(/warn/u);
  await expect(others.locator('.stack-others-dots .stack-process-dot')).toHaveCount(4);

  // once api stops, nothing here that uses static runs, though worker still does
  await api.locator('.stack-row').click();
  await api.getByRole('button', { name: 'Stop api', exact: true }).click();
  await expect(othersState).toHaveText('1 down');
  await expect(api.locator('.stack-row-warning')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stack controls: 1 of 3 running, warning: queue in Queue / Main is not running', exact: true })).toBeVisible();

  // a Start on its way to web, which uses static, makes static matter again
  await page.evaluate(() => (window as unknown as { startWeb: () => void }).startWeb());
  await expect(othersState).toHaveText('2 down');
  await expect(web.locator('.stack-row-warning')).toBeVisible();
});

test("lists a process's uses in its row, and starts, stops and opens them in their own Worktree", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderUsesControls } = await import('/e2e/project-open-fixture.tsx');
    renderUsesControls(document.querySelector<HTMLElement>('#control-root')!);
  });
  const recorded = (key: 'useActions'|'openedWorktrees') => page.evaluate(name => (window as unknown as Record<string, unknown>)[name], key);

  await page.getByRole('button', { name: /^Stack controls/u }).click();
  const menu = page.locator('.stack-menu');
  const api = menu.getByRole('group', { name: 'api process' });
  await api.locator('.stack-row').click();
  const uses = api.getByRole('group', { name: 'Uses' });
  const staticLine = uses.getByRole('group', { name: 'static in Static Site / Main' });
  await expect(staticLine.locator('.stack-use-where')).toHaveText('Static Site / Main');
  // one the console could not place shows by its path, with nothing to act on
  await expect(uses.getByRole('group', { name: 'docs in /code/elsewhere' }).getByRole('button')).toHaveCount(0);
  await staticLine.getByRole('button', { name: 'Start static in Static Site / Main', exact: true }).click();
  // a running used process offers no Start in a row, only Open
  await expect(staticLine.getByRole('button', { name: /^Start static/u })).toHaveCount(0);
  await staticLine.getByRole('button', { name: 'Open Static Site / Main', exact: true }).click();

  // the Other worktrees row lists each used process with what uses it, and stops a running one
  const others = menu.getByRole('group', { name: 'Other worktrees' });
  await others.locator('.stack-row').click();
  const staticOther = others.getByRole('group', { name: 'static in Static Site / Main' });
  await expect(staticOther.locator('.stack-use-users')).toHaveText('used by api, web');
  await expect(others.getByRole('group', { name: 'search in Search / Main' }).locator('.stack-use-users')).toHaveText('used by web');
  await staticOther.getByRole('button', { name: 'Stop static in Static Site / Main', exact: true }).click();
  await expect(staticOther.getByRole('button', { name: 'Start static in Static Site / Main', exact: true })).toBeVisible();
  await expect(menu).toBeVisible();
  expect(await recorded('useActions')).toEqual(['start site:/code/static static', 'stop site:/code/static static']);
  expect(await recorded('openedWorktrees')).toEqual(['site:/code/static']);
});
