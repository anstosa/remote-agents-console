import { expect, test } from '@playwright/test';
import { instanceIconSvg } from '../../server/src/instance-icon.js';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

test('keeps the active tab, output, and prompt controls inside a narrow viewport', async ({ page }) => {
  // opt in for marker geometry checks
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await page.setViewportSize({ width: 428, height: 952 });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/dave', displayLabel: '🥔 Dave', title: 'Ready' },
          { id: 'agent-4', sessionId: 'socket:$4', home: '/worktrees/eric', displayLabel: '🥔 Eric', title: 'Ready' },
          { id: 'agent-5', sessionId: 'socket:$5', home: '/worktrees/remote-agents', worktreeId: 'remote-agents', branch: 'feature/output-git-summary', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 1, conflicted: 0 }, displayLabel: '📱 Remote Agents', title: 'Ready', attention: 'finished', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], tunnel: true }, pullRequest: { number: 42, title: 'Move the worktree tabs', status: 'open', url: 'https://github.com/octo/repo/pull/42' } }
        ],
        projects: []
      }
    });
    // provide a real terminal choice for the flyout marker geometry
    if (url.pathname === '/api/worktrees/remote-agents/panes') return route.fulfill({ json: { panes: [{ paneId: '%7', session: '$7', window: '@7', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/remote-agents', title: '', agent: false }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[1-5]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[1-5]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [{ id: 'saved-1', text: 'Saved prompt' }] } });
    if (url.pathname === '/api/worktrees/remote-agents/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // a phone picks its Workspace from the current-Workspace dropdown's sheet
  const dropdown = page.locator('.tabs .workspace-dropdown');
  await dropdown.click();
  await page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: /^📱 Remote Agents/u }).click();
  await expect(dropdown).toContainText('📱 Remote Agents');
  await expect(page.getByLabel('Live log')).toBeVisible();
  // the phone tab row opens on the server selector, an icon-only Call and settings
  const lead = page.locator('.tabs > .tab-row-lead');
  await expect(lead.getByRole('button', { name: 'Call Davo' }).locator('svg')).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Call Davo' }).locator('span')).toBeHidden();
  await expect(lead.locator('.server-selector-name')).toBeHidden();
  // the phone toolbar keeps Launch, Terminal and Notes; Browser and Code move into its ⋮, and a
  // Workspace with one panel shows no position dots
  const workspaceToolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // point each caret toward the flyout on the nearest button edge
  const flyoutIcons = [
    { button: lead.locator('.server-selector'), side: 'above' },
    { button: page.locator('.tabs .new-agent-tab'), side: 'above' },
    { button: workspaceToolbar.locator('.terminal-picker-toggle'), side: 'above' },
    { button: workspaceToolbar.locator('.notes-toggle'), side: 'above' },
    { button: workspaceToolbar.locator('.git-status-summary'), side: 'above' },
    { button: workspaceToolbar.locator('.project-stack-trigger'), side: 'above' },
    { button: workspaceToolbar.locator('.more'), side: 'above' },
    { button: page.locator('.agent-panel .agent-power'), side: 'below' },
    { button: page.locator('.agent-composer .prompt-history-toggle'), side: 'above' },
    { button: page.locator('.agent-composer .queued-prompts-toggle'), side: 'above' },
  ];
  // check every mobile flyout trigger against its closest edge
  for (const { button, side } of flyoutIcons) {
    const caret = button.locator(':scope > .flyout-caret');
    await expect(caret).toBeVisible();
    const [buttonBox, caretBox] = await Promise.all([button.boundingBox(), caret.boundingBox()]);
    expect(caretBox!.height).toBe(3.5);
    expect(Math.abs(caretBox!.x + caretBox!.width / 2 - buttonBox!.x - buttonBox!.width / 2)).toBeLessThanOrEqual(1);
    // compare the caret to its flyout-facing edge
    if (side === 'above') expect(caretBox!.y + caretBox!.height).toBeLessThan(buttonBox!.y + buttonBox!.height / 3);
    else expect(caretBox!.y).toBeGreaterThan(buttonBox!.y + buttonBox!.height * 2 / 3);
    const shape = await caret.evaluate(element => ({ mask: getComputedStyle(element).maskImage, clip: getComputedStyle(element).clipPath }));
    expect(shape.mask).toContain(side === 'above' ? 'M1 2.8 5 .75 9 2.8' : 'M1 .75 5 2.8 9 .75');
    expect(shape.mask).toContain("stroke-width='1.1'");
    expect(shape.clip).toBe('none');
  }
  // keep the server caret at the upper edge when this bottom tab row opens above
  const serverTrigger = lead.locator('.server-selector');
  await serverTrigger.click();
  await expect(serverTrigger).toHaveAttribute('data-flyout-side', 'above');
  const serverMenuBox = await page.getByRole('group', { name: 'Remote Agents servers' }).boundingBox();
  const serverTriggerBox = await serverTrigger.boundingBox();
  expect(serverMenuBox!.y + serverMenuBox!.height).toBeLessThan(serverTriggerBox!.y);
  await page.keyboard.press('Escape');
  await expect(serverTrigger).not.toHaveAttribute('data-flyout-side');
  await expect(workspaceToolbar.getByRole('button', { name: 'Browser', exact: true }).locator('.flyout-caret')).toHaveCount(0);
  await expect(workspaceToolbar.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(workspaceToolbar.getByRole('button', { name: 'Browser', exact: true })).toHaveCount(0);
  await expect(workspaceToolbar.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
  await expect(workspaceToolbar.getByRole('group', { name: 'Panels' })).toHaveCount(0);
  await workspaceToolbar.getByRole('button', { name: 'More options' }).click();
  await expect(workspaceToolbar.locator('.more-wrap')).toHaveAttribute('data-flyout-side', 'above');
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Browser', exact: true })).toBeVisible();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await expect(page.locator('.place-menu')).toHaveCount(0);
  const gitStatus = page.getByLabel('Git status: feature/output-git-summary; 3 changes (1 staged file, 2 unstaged files, 1 untracked file)');
  await expect(gitStatus).toBeVisible();
  await gitStatus.click();
  await expect(page.getByRole('region', { name: 'Changed files' })).toContainText('Changed-file details unavailable');
  await expect(page.getByRole('button', { name: 'Collapse git status' })).toHaveCount(0);
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await expect(page.locator('.log-status i')).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      activeTab: bounds('.tabs .workspace-dropdown'),
      output: bounds('.log'),
      outputBorder: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.log')!);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      })(),
      headerTitle: bounds('.agent-panel .panel-header-title'),
      headerActions: bounds('.agent-panel .panel-header-actions'),
      power: bounds('.agent-panel .agent-power'),
      composer: bounds('.agent-composer'),
      history: bounds('.agent-composer .prompt-history-toggle'),
      attachment: bounds('.agent-composer .attachment-button'),
      queued: bounds('.agent-composer .queued-prompts-toggle'),
      send: bounds('.agent-composer .queue'),
      prompt: bounds('.agent-composer textarea'),
      gitSummary: bounds('.workspace-toolbar .git-status-summary'),
      gitBranchDisplay: getComputedStyle(document.querySelector<HTMLElement>('.workspace-toolbar .git-branch')!).display,
      tabRowLead: bounds('.tab-row-lead'),
      serverSettings: bounds('.tabs > .server-switcher-settings-wrap .server-switcher-settings'),
      tabs: bounds('.tabs'),
      tabsBorder: getComputedStyle(document.querySelector<HTMLElement>('.tabs')!).borderBottomWidth,
      tabsShadow: getComputedStyle(document.querySelector<HTMLElement>('.tabs')!).boxShadow,
      tabsGap: getComputedStyle(document.querySelector<HTMLElement>('.tabs')!).gap,
      leadGap: getComputedStyle(document.querySelector<HTMLElement>('.tab-row-lead')!).gap,
      bar: bounds('.workspace-toolbar'),
      barActions: bounds('.workspace-toolbar .workspace-toolbar-actions'),
      spacer: bounds('.workspace-toolbar-actions > .toolbar-spacer'),
      barGap: getComputedStyle(document.querySelector<HTMLElement>('.workspace-toolbar-actions')!).gap,
      promptGap: getComputedStyle(document.querySelector<HTMLElement>('.agent-composer-column')!).gap,
      controls: [...document.querySelectorAll<HTMLElement>('.workspace-toolbar .workspace-toolbar-actions button, .workspace-toolbar .workspace-toolbar-actions .project-open')].map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.activeTab.left).toBeGreaterThanOrEqual(0);
  expect(layout.activeTab.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(Math.abs(layout.output.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.output.width - layout.viewportWidth)).toBeLessThanOrEqual(1);
  // the visible prompt and static controls share one undivided bottom surface
  expect(layout.outputBorder).toEqual({ top: '0px', bottom: '0px' });
  // the agent panel's header pills float over its top corners, power last
  expect(Math.abs(layout.headerTitle.top - layout.output.top - 6.4)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.headerTitle.left - layout.output.left - 6.4)).toBeLessThanOrEqual(1);
  expect(layout.headerActions.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.power.right).toBeLessThanOrEqual(layout.headerActions.right);
  // the composer sits inside the panel: history above attach on the left, queued above send on the right
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.output.bottom + 1);
  expect(Math.abs(layout.history.left - layout.attachment.left)).toBeLessThanOrEqual(1);
  expect(layout.history.bottom).toBeLessThanOrEqual(layout.attachment.top);
  expect(layout.attachment.right).toBeLessThanOrEqual(layout.prompt.left);
  expect(Math.abs(layout.queued.left - layout.send.left)).toBeLessThanOrEqual(1);
  expect(layout.queued.bottom).toBeLessThanOrEqual(layout.send.top);
  expect(layout.send.left).toBeGreaterThanOrEqual(layout.prompt.right);
  expect(layout.send.right).toBeLessThanOrEqual(layout.viewportWidth);
  // the server selector and Call balance the launcher and trailing settings button
  expect(Math.abs(layout.tabRowLead.left - layout.tabs.left - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.tabRowLead.top - layout.tabs.top - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.activeTab.left + layout.activeTab.width / 2 - layout.tabs.left - layout.tabs.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.right - layout.tabs.right + 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.height - layout.activeTab.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.width - layout.serverSettings.height)).toBeLessThanOrEqual(1);
  // the prompt box and workspace dropdown have the same gap as the buttons
  expect(Math.abs(layout.tabs.top - layout.output.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.activeTab.top - layout.prompt.bottom - parseFloat(layout.promptGap))).toBeLessThanOrEqual(1);
  // no divider separates the outlined tabs from the buttons beneath them
  expect(layout.tabsBorder).toBe('0px');
  expect(layout.tabsShadow).not.toContain('inset');
  await expect(page.locator('.log-topbar')).toHaveCount(0);
  await expect(page.locator('.agent-view > .pull-request-card')).toHaveCount(0);
  // the Workspace's controls sit on one row beneath the tabs, git shrunk to its icon and state dot
  expect(layout.bar.top).toBeGreaterThanOrEqual(layout.tabs.bottom - 1);
  expect(layout.gitBranchDisplay).toBe('none');
  expect(layout.gitSummary.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.controls.every(control => control.left >= 0 && control.right <= layout.viewportWidth)).toBe(true);
  expect(new Set(layout.controls.map(control => Math.round(control.top))).size).toBe(1);
  // both rows and their vertical separation match the prompt-button interval
  expect(layout.tabsGap).toBe(layout.promptGap);
  expect(layout.leadGap).toBe(layout.promptGap);
  expect(layout.barGap).toBe(layout.promptGap);
  expect(Math.abs(layout.barActions.top - layout.activeTab.bottom - parseFloat(layout.promptGap))).toBeLessThanOrEqual(1);
  // the one active split still reserves the area used by multi-split position controls
  expect(layout.spacer.width).toBeGreaterThan(20);
  const buttonGaps = layout.controls.slice(1).map((control, index) => control.left - layout.controls[index].right);
  const reservedGap = Math.max(...buttonGaps);
  expect(reservedGap).toBeGreaterThan(layout.spacer.width);
  expect(buttonGaps.filter(gap => gap !== reservedGap).every(gap => Math.abs(gap - parseFloat(layout.promptGap)) <= 1)).toBe(true);
  expect(Math.abs(layout.barActions.left - layout.controls[0].left)).toBeLessThanOrEqual(1);

  const promptBox = page.getByRole('textbox', { name: 'Prompt' });
  await promptBox.fill(Array.from({ length: 10 }, (_, index) => `Growing line ${index + 1}`).join('\n'));
  await expect.poll(async () => (await promptBox.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  const grown = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    return { prompt: bounds('.agent-composer textarea'), send: bounds('.agent-composer .queue'), bar: bounds('.workspace-toolbar') };
  });
  // grow the prompt upward without moving send or the row beneath the tabs
  expect(grown.prompt.top).toBeLessThan(layout.prompt.top);
  expect(Math.abs(grown.prompt.bottom - layout.prompt.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.send.bottom - layout.send.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.bar.top - layout.bar.top)).toBeLessThanOrEqual(1);
});

// keep desktop flyout affordances directional without covering button content
test('desktop flyout triggers show edge carets and remain clickable', async ({ page }, testInfo) => {
  // opt in for marker geometry checks
  await page.addInitScript(() => localStorage.setItem('rac.flyout-markers', 'enabled'));
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  // serve the bundled server artwork instead of Vite's html fallback
  // serve the shared terminal artwork
  await page.route('**/instance-icons/terminal.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: instanceIconSvg() }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // keep the desktop session active
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one agent with every toolbar section
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', branch: 'feature/carets', gitStatus: { files: 2, staged: 1, unstaged: 1, untracked: 0, conflicted: 0 }, displayLabel: '🥔 Cora', title: 'Ready', attention: 'finished', stack: { actions: ['start'], tunnel: false } }], projects: [] } });
    // skip optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // exercise the terminal flyout with an actual selectable shell
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [{ paneId: '%7', session: '$7', window: '@7', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false }] } });
    // connect the visible agent output
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // make prompt-history controls available
    if (/^\/api\/agents\/agent-1\/(saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [{ id: 'saved-1', text: 'Saved prompt' }] } });
    // keep git detail loading bounded
    if (url.pathname === '/api/worktrees/cora/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\x1b[2J\x1b[HDesktop flyout caret fixture ready');

  const tabs = page.locator('.tabs');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const serverImage = tabs.locator('.server-selector img');
  await expect.poll(() => serverImage.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'Desktop flyout caret fixture ready' })).toBeVisible();
  const triggers = [
    { button: tabs.locator('.server-selector'), anchor: tabs.locator('.server-selector'), menu: page.locator('.server-menu'), side: 'above' },
    { button: tabs.locator('.new-agent-tab'), anchor: tabs.locator('.launcher'), menu: page.locator('.launcher-menu'), side: 'above' },
    { button: toolbar.locator('.terminal-picker-toggle'), anchor: toolbar.locator('.terminal-picker-wrap'), menu: page.locator('.terminal-picker'), side: 'above' },
    { button: page.locator('.agent-panel .agent-power'), anchor: page.locator('.agent-panel .power-menu-wrap'), menu: page.locator('.agent-power-menu'), side: 'below' }
  ] as const;
  // exercise flyouts above and below through their real desktop triggers
  for (const { button, anchor, menu, side } of triggers) {
    await expect(button).toBeVisible();
    const caret = button.locator(':scope > .flyout-caret');
    await expect(caret).toBeVisible();
    const [buttonBox, caretBox] = await Promise.all([button.boundingBox(), caret.boundingBox()]);
    // require rendered geometry before comparing the control edges
    if (buttonBox === null || caretBox === null) throw new Error('desktop flyout trigger has no bounds');
    expect(await caret.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    expect(Math.abs(caretBox.x + caretBox.width / 2 - buttonBox.x - buttonBox.width / 2)).toBeLessThanOrEqual(1);
    await button.click();
    await expect(menu).toBeVisible();
    await expect(anchor).toHaveAttribute('data-flyout-side', side);
    const mask = await caret.evaluate(element => getComputedStyle(element).maskImage);
    expect(mask).toContain(side === 'above' ? 'M1 2.8 5 .75 9 2.8' : 'M1 .75 5 2.8 9 .75');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }

  const contentChecks = [
    tabs.locator('.server-selector'),
    toolbar.locator('.terminal-picker-toggle')
  ];
  await page.screenshot({ path: testInfo.outputPath('desktop-flyout-carets.png'), fullPage: true });
  // keep the edge mark clear of each trigger's icon and label
  for (const button of contentChecks) {
    const caret = button.locator(':scope > .flyout-caret');
    const content = button.locator(':scope > :is(svg, .toolbar-label, .server-selector-name, .server-selector-chevron):visible');
    const caretBox = await caret.boundingBox();
    // require the edge mark before checking its content separation
    if (caretBox === null) throw new Error('desktop flyout caret has no bounds');
    const contentGeometry = await content.evaluateAll((elements, box) => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.getAttribute('class') ?? element.tagName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, overlaps: rect.left < box.x + box.width && rect.right > box.x && rect.top < box.y + box.height && rect.bottom > box.y };
    }), caretBox);
    expect(contentGeometry.filter(item => item.overlaps), JSON.stringify({ caretBox, contentGeometry })).toEqual([]);
  }
  const launchSplit = toolbar.locator('.launch-split');
  await expect(launchSplit.locator('.launch-chevron')).toBeVisible();
  await expect(launchSplit.locator('.launch-chevron .flyout-caret')).toHaveCount(0);
});

// the dashboard the phone Workspace dropdown tests: the current Workspace, two Agents elsewhere that
// wait on the operator (a question, unread output), and an agentless directory Place with shells
const workspacesDashboard = {
  generation: 1,
  agents: [
    { id: 'agent-5', sessionId: 'socket:$5', home: '/worktrees/remote-agents', worktreeId: 'remote-agents', displayLabel: '📱 Remote Agents', title: 'Ready', attention: 'finished', queuedPromptCount: 0 },
    { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready', attention: 'question', queuedPromptCount: 0 },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready', attention: 'finished', unread: true, queuedPromptCount: 0 }
  ],
  places: [{ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: true, consoleShells: 2 }],
  projects: []
};

test('the phone workspace switcher renames a worktree without selecting it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let worktreeLabel = 'Cora';
  const labels: string[] = [];
  // serve the updated label during the rename reconciliation
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    // keep the phone session active
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one worktree and one non-worktree workspace
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: 'cora', projectId: 'repo', label: worktreeLabel, path: '/worktrees/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'cora' }] }], places: [{ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: true, consoleShells: 1 }] } });
    // skip optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // record only the worktree label mutation
    if (url.pathname === '/api/worktrees/cora/label' && request.method() === 'PATCH') {
      worktreeLabel = (request.postDataJSON() as { label: string }).label;
      labels.push(worktreeLabel);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const dropdown = page.getByRole('tab', { selected: true });
  await dropdown.click();
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  await expect(sheet.getByRole('button', { name: /^Cora\s*Empty$/u })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Notes\s*shell$/u })).toBeVisible();
  await sheet.getByRole('button', { name: /^Notes\b/u }).click();
  await expect(dropdown).toContainText('Notes');
  await dropdown.click();
  const rename = sheet.getByRole('button', { name: 'Rename Cora' });
  await expect(rename).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Rename Notes' })).toHaveCount(0);
  await rename.click();
  await expect(sheet).toHaveCount(0);
  await expect(dropdown).toContainText('Notes');
  const dialog = page.getByRole('dialog', { name: 'Rename worktree' });
  await dialog.getByRole('textbox', { name: 'Worktree name' }).fill('Renamed Cora');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => labels).toEqual(['Renamed Cora']);
  await expect(dialog).toHaveCount(0);
  await dropdown.click();
  await expect(sheet.getByRole('button', { name: /^Renamed Cora\b/u })).toBeVisible();
});

// keep phone working motion behind steady content
test('the phone workspace flyout moves only a working row background and borders its active row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // keep the phone session active
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // show two agents and two shells in one working workspace
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/build', worktreeId: 'build', title: 'Ready', attention: 'working' },
      { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/build', worktreeId: 'build', title: 'Ready', attention: 'finished' }
    ], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: 'build', projectId: 'repo', label: 'Build', path: '/worktrees/build', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'build', consoleShells: 2 }] }] } });
    // skip optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const dropdown = page.getByRole('tab', { selected: true });
  await expect(dropdown).toBeVisible();
  // restrict dropdown motion to its background layer
  const dropdownMotion = await dropdown.evaluate(element => element.getAnimations({ subtree: true }).map(animation => {
    const effect = animation.effect as KeyframeEffect;
    return effect.target === element && effect.pseudoElement === '::before' ? 'background' : 'content-or-dot';
  }));
  expect(dropdownMotion).toEqual(['background']);
  await dropdown.click();
  const row = page.getByRole('dialog', { name: 'Workspaces' }).locator('.workspace-sheet-row.status-working');
  await expect(row.getByRole('button', { name: /^Build\s*2 Agents · 2 shells · Working$/u })).toBeVisible();
  const paint = await row.evaluate(element => {
    const entry = element.querySelector('.workspace-sheet-entry')!;
    const label = entry.querySelector('strong')!;
    // keep only status-related movement from this row
    const movingParts = element.getAnimations({ subtree: true }).flatMap(animation => {
      const effect = animation.effect as KeyframeEffect;
      // retain the working background sweep
      if (effect.target === element && effect.pseudoElement === '::before') return ['background'];
      // surface accidental label motion
      if (effect.target === label) return ['label'];
      // surface accidental dot motion
      if (effect.target === entry && effect.pseudoElement === '::after') return ['dot'];
      return [];
    });
    const dot = getComputedStyle(entry, '::after');
    return { border: getComputedStyle(element).borderColor, dot: dot.backgroundColor, dotMotion: dot.animationName, dotWidth: dot.width, dotHeight: dot.height, labelMotion: getComputedStyle(label).animationName, movingParts };
  });
  expect(paint.border).toBe(paint.dot);
  const dropdownPaint = await page.getByRole('tab', { selected: true }).evaluate(element => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow }));
  expect(dropdownPaint.border).toBe(paint.dot);
  expect(dropdownPaint.shadow).not.toContain('inset');
  expect(paint.movingParts).toEqual(['background']);
  expect(paint.dotMotion).toBe('none');
  expect([paint.dotWidth, paint.dotHeight]).toEqual(['6px', '6px']);
  expect(paint.labelMotion).toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // wait for the browser to apply the changed media preference
  await expect.poll(() => row.evaluate(element => {
    const entry = element.querySelector('.workspace-sheet-entry')!;
    return { animations: element.getAnimations({ subtree: true }).length, dotMotion: getComputedStyle(entry, '::after').animationName, labelMotion: getComputedStyle(entry.querySelector('strong')!).animationName };
  })).toEqual({ animations: 0, dotMotion: 'none', labelMotion: 'none' });
});

test('a phone shows only the current Workspace, as a dropdown over a sheet of every Workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let dashboard = workspacesDashboard;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');

  const tabs = page.locator('nav.tabs');
  // the row's one tab is the current Workspace, and it opens a sheet rather than switching
  const dropdown = tabs.getByRole('tab');
  await expect(dropdown).toHaveCount(1);
  await expect(dropdown).toHaveAccessibleName('📱 Remote Agents — Prompt done');
  await expect(dropdown).toHaveAttribute('aria-selected', 'true');
  await expect(dropdown).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(dropdown).toHaveAccessibleDescription('Other Workspaces: 1 need an answer, 1 unread');
  // verify the real launch, settings and switcher glyphs share the control-icon scale
  const controlIcons = tabs.locator('.new-agent-tab svg, .server-switcher-settings svg, .workspace-dropdown-chevron');
  await expect(controlIcons).toHaveCount(3);
  const iconPaint = await controlIcons.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return [style.width, style.height, Number.parseFloat(style.strokeWidth)];
  }));
  expect(iconPaint).toEqual(Array.from({ length: 3 }, () => ['16px', '16px', 2]));
  // the badge counts the Agents in other Workspaces waiting on the operator, red while any has a question
  const badge = dropdown.locator('.workspace-dropdown-badge');
  await expect(badge).toHaveText('2');
  await expect(badge).toHaveClass(/\bquestion\b/u);
  // the marks stand apart from the title
  await expect(dropdown).toHaveCSS('gap', '9.6px');

  // one outlined row with balanced controls around the centered Workspace dropdown
  const row = await tabs.evaluate(nav => {
    const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, middle: Math.round(rect.top + rect.height / 2) }; };
    return { overflow: nav.scrollWidth - nav.clientWidth, width: nav.getBoundingClientRect().width, lead: box(nav.querySelector('.tab-row-lead')!), dropdown: box(nav.querySelector('.workspace-dropdown')!), plus: box(nav.querySelector('.launcher')!), settings: box(nav.querySelector('.server-switcher-settings-wrap')!) };
  });
  expect(row.overflow).toBeLessThanOrEqual(0);
  expect(new Set([row.lead.middle, row.dropdown.middle, row.plus.middle, row.settings.middle]).size).toBe(1);
  expect(Math.abs(row.dropdown.left - row.lead.right - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(row.plus.left - row.dropdown.right - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(row.settings.left - row.plus.right - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(row.settings.right - (row.width - 6))).toBeLessThanOrEqual(1);
  expect(Math.abs((row.dropdown.left + row.dropdown.right) / 2 - row.width / 2)).toBeLessThanOrEqual(1);

  // the sheet omits zero and singular counts while retaining each workspace state
  await dropdown.click();
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  const entries = sheet.getByRole('button');
  await expect(entries).toHaveText([
    /📱 Remote Agents\s*Agent$/u,
    /🥔 Cora\s*Agent · Needs answer$/u,
    /🥔 Owen\s*Agent · Unread$/u,
    /Notes\s*2 shells$/u,
    /New Workspace…\s*Launch, Terminal or Empty workspace$/u
  ]);
  await expect(entries.first()).toHaveAttribute('aria-current', 'true');
  // compare rendered status colors and motion across the flyout rows
  const statusPaint = await sheet.locator('.workspace-sheet-row').evaluateAll(rows => rows.map(row => {
    const entry = row.querySelector('.workspace-sheet-entry')!;
    const dot = getComputedStyle(entry, '::after');
    const label = getComputedStyle(entry.querySelector('strong')!);
    return { border: getComputedStyle(row).borderColor, rowMotion: getComputedStyle(row).animationName, dot: dot.backgroundColor, dotWidth: dot.width, dotHeight: dot.height, label: label.color, dotMotion: dot.animationName, labelMotion: label.animationName };
  }));
  expect(statusPaint[0].border).toBe(statusPaint[0].dot);
  // a ready but read workspace keeps the same idle tone as an empty one
  expect(statusPaint[0].dot).toBe(statusPaint[3].dot);
  expect(statusPaint[0].label).toBe(statusPaint[3].label);
  // the new workspace action uses the ordinary idle label color
  await expect(sheet.locator('.workspace-sheet-new strong')).toHaveCSS('color', statusPaint[3].label);
  expect(statusPaint[0].dotMotion).toBe('none');
  expect(statusPaint[0].labelMotion).toBe('none');
  await expect(dropdown).toHaveCSS('border-color', statusPaint[0].dot);
  expect(await dropdown.evaluate(element => getComputedStyle(element).boxShadow)).not.toContain('inset');
  expect(statusPaint[1].label).toBe(statusPaint[1].dot);
  expect(statusPaint[2].label).toBe(statusPaint[2].dot);
  expect(statusPaint[2].dot).not.toBe(statusPaint[0].dot);
  expect(statusPaint[1].dot).not.toBe(statusPaint[2].dot);
  expect(statusPaint[1].dotMotion).toBe('none');
  expect(statusPaint[1].labelMotion).toBe('none');
  expect(statusPaint[2].border).toBe(statusPaint[2].dot);
  expect(statusPaint[2].rowMotion).toBe('none');
  expect([statusPaint[2].dotWidth, statusPaint[2].dotHeight]).toEqual(['6px', '6px']);
  expect(statusPaint[2].dotMotion).toBe('none');
  expect(statusPaint[2].labelMotion).not.toBe('none');
  expect(statusPaint[3].dotMotion).toBe('none');
  expect(statusPaint[3].labelMotion).toBe('none');
  // disable completion motion without changing workspace state
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // wait for the media preference and active transitions to settle
  await expect.poll(() => sheet.locator('.workspace-sheet-row').evaluateAll(rows => rows.flatMap(row => row.getAnimations({ subtree: true })).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // a sheet across the screen's bottom edge, once it has risen into place
  await expect.poll(async () => { const box = (await sheet.boundingBox())!; return [box.x, box.width, box.y + box.height].map(Math.round); }).toEqual([0, 390, 844]);

  // picking Cora switches to it, leaving only Owen's unread output elsewhere: a green badge
  await entries.filter({ hasText: 'Cora' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dropdown).toContainText('🥔 Cora');
  await expect(dropdown).toHaveCSS('border-color', statusPaint[1].dot);
  await expect(badge).toHaveText('1');
  await expect(badge).not.toHaveClass(/\bquestion\b/u);
  // picking Owen reads its output, so only Cora's question waits elsewhere
  await dropdown.click();
  await entries.filter({ hasText: 'Owen' }).click();
  await expect(dropdown).toContainText('🥔 Owen');
  // opening unread output marks it read and returns the border to idle
  await expect(dropdown).toHaveCSS('border-color', statusPaint[0].dot);
  await expect(badge).toHaveText('1');
  await expect(badge).toHaveClass(/\bquestion\b/u);
  // once Cora's question is answered elsewhere, the next dashboard clears the badge
  dashboard = { ...workspacesDashboard, generation: 2, agents: workspacesDashboard.agents.map(agent => agent.id === 'agent-1' ? { ...agent, attention: 'finished' } : agent.unread ? { ...agent, unread: false } : agent) };
  await expect(badge).toHaveCount(0, { timeout: 10_000 });

  // New Workspace… opens the + menu
  await dropdown.click();
  await entries.filter({ hasText: 'New Workspace…' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toBeVisible();
  await page.keyboard.press('Escape');

  // a desktop keeps the full tab row
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(tabs.locator('.workspace-dropdown')).toHaveCount(0);
});
