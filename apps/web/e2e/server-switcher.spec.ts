import { expect, test, type Locator } from '@playwright/test';
import { instanceIconSvg, isInstanceIcon } from '../../server/src/instance-icon.js';

type BoundingBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

// require rendered locator bounds
const renderedBounds = async (locator: Locator): Promise<BoundingBox> => {
  const bounds = await locator.boundingBox();
  // fail clearly when the element is not rendered
  if (bounds === null) throw new Error('Expected locator to have rendered bounds');
  return bounds;
};

test('shows and switches the configured server on authentication and output screens', async ({ page }) => {
  let screen: 'login'|'control'|'output' = 'login';
  let remoteAttention: 'idle'|'working'|'question'|'completed' = 'working';
  let remoteName = 'Framework';
  let statusAvailable = true;
  const remoteServer = { name: 'Framework', url: 'https://framework.santosa.dev', icon: 'heart' };
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [remoteServer] };
  const revision = { sha: 'a1b2c3d4e5f6789012345678901234567890abcd', committedAt: '2026-09-06T14:22:31-07:00' };
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // connect the dashboard and output fixtures
      constructor(_url: string | URL) {
        window.setTimeout(() => {
          // open each pending socket once
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }
      send() {}
      // close one fixture socket
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // complete remote navigation without network access
    if (url.hostname === 'framework.santosa.dev') return route.fulfill({ contentType: 'text/html', body: '<title>Framework target</title><h1>Framework target</h1>' });
    // render the shared icon fallback instead of vite html
    const icon = /^\/instance-icons\/(\w+)\.svg$/u.exec(url.pathname)?.[1];
    // keep fixture aliases independent of local artwork
    if (icon !== undefined && isInstanceIcon(icon)) return route.fulfill({ contentType: 'image/svg+xml', body: instanceIconSvg() });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/auth/session') {
      if (screen === 'login') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: screen === 'output', deviceName: 'Test device', controllingDeviceName: screen === 'control' ? 'Desk iPad' : undefined, server } });
    }
    if (url.pathname === '/api/auth/bootstrap') return route.fulfill({ json: { csrfToken: 'bootstrap-token', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // publish the current server revision in its selector submenu
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: revision });
    // provide the mutable peer-attention fixture
    if (url.pathname === '/api/server-statuses') {
      // simulate an aggregate outage
      if (!statusAvailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      return route.fulfill({ json: { servers: [{ name: server.name, url: server.url, icon: server.icon, attention: 'working' }, { ...remoteServer, name: remoteName, attention: remoteAttention }] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  // verify direct server targets
  const expectServerTargets = async (remoteLabel?: string) => {
    const group = page.getByRole('group', { name: 'Remote Agents servers' });
    const targets = group.locator('.server-switcher-button:not(.server-switcher-settings)');
    await expect(group).toBeVisible();
    await expect(targets).toHaveText(['X1 Carbon', remoteServer.name]);
    // require the current server on the left
    await expect(targets.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(1)).not.toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(0).locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
    await expect(targets.nth(1).locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
    // preserve Android WebAPK link capture
    await expect(group.locator('button.server-switcher-button:not(.server-switcher-settings)')).toHaveCount(1);
    await expect(group.locator('a.server-switcher-button')).toHaveAttribute('href', remoteServer.url);
    // verify an attention label when requested
    if (remoteLabel !== undefined) await expect(targets.nth(1)).toHaveAccessibleName(remoteLabel);
    return { group, current: targets.nth(0), remote: targets.nth(1) };
  };

  await page.goto('/');
  // keep server selection inside deliberate credential entry
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible();
  await expectServerTargets();
  await expect(page.getByRole('combobox', { name: /Remote Agents server/u })).toHaveCount(0);

  remoteServer.name = 'Framework Workstation';
  remoteName = remoteServer.name;
  screen = 'control';
  await page.reload();
  await expect(page.getByText('Desk iPad is active')).toBeVisible();
  const controlServers = await expectServerTargets(`${remoteName} — Working`);
  // settings need a ready console session, so the takeover screen offers servers only
  await expect(controlServers.group.getByRole('button', { name: 'Global settings' })).toHaveCount(0);
  // preserve takeover-screen status markers
  const controlStatusDots = controlServers.group.locator('.server-switcher-attention.working');
  await expect(controlStatusDots).toHaveCount(2);
  await expect(controlStatusDots.first()).toBeVisible();
  await expect(controlStatusDots.last()).toBeVisible();
  await expect(controlStatusDots.first()).toHaveCSS('opacity', '1');
  await expect(controlStatusDots.last()).toHaveCSS('opacity', '1');
  await expect(controlStatusDots.first()).toHaveCSS('position', 'absolute');
  // pin the compact status badge to the server tab corner
  const [controlServerBounds, controlDotBounds] = await Promise.all([renderedBounds(controlServers.current), renderedBounds(controlStatusDots.first())]);
  expect(Math.abs(controlDotBounds.x + controlDotBounds.width - (controlServerBounds.x + controlServerBounds.width - 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(controlDotBounds.y - (controlServerBounds.y + 4))).toBeLessThanOrEqual(1);
  // match the shared status dot diameter
  expect(controlDotBounds.width).toBe(6);
  // require the takeover card to expand with complete labels
  const [controlCardBounds, controlGroupBounds] = await Promise.all([renderedBounds(page.locator('.console-recovery')), renderedBounds(controlServers.group)]);
  expect(controlCardBounds.width).toBeGreaterThan(320);
  expect(controlCardBounds.width).toBeGreaterThan(controlGroupBounds.width);
  // keep the expanded card within a narrow viewport
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowControlCardBounds = await renderedBounds(page.locator('.console-recovery'));
  expect(narrowControlCardBounds.x).toBeGreaterThanOrEqual(0);
  expect(narrowControlCardBounds.x + narrowControlCardBounds.width).toBeLessThanOrEqual(390);
  const narrowControlLabelsFit = await controlServers.group.locator('.server-switcher-button > span').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth));
  expect(narrowControlLabelsFit).toBe(true);
  const narrowControlScrolls = await controlServers.group.evaluate(group => group.scrollWidth > group.clientWidth);
  // keep the corner badges out of the horizontal layout
  expect(narrowControlScrolls).toBe(false);

  remoteServer.name = 'Framework';
  remoteName = remoteServer.name;
  screen = 'output';
  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  // nothing floats over the output: the selector leads the tab row instead
  await expect(page.locator('.log-output .server-switcher, .output-server-switcher')).toHaveCount(0);
  const tabRow = page.locator('.tabs');
  const lead = tabRow.locator('> .tab-row-lead');
  await expect(tabRow.locator('> :first-child')).toHaveClass(/tab-row-lead/u);
  const selector = lead.getByRole('button', { name: /^Switch server \(X1 Carbon\)/u });
  await expect(lead.locator('> :first-child')).toHaveAccessibleName(/^Switch server/u);
  await expect(tabRow.locator('> .server-switcher-settings-wrap').getByRole('button', { name: 'Global settings' })).toBeVisible();
  await expect(selector.locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
  await expect.poll(async () => selector.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(selector.locator('.server-selector-name')).toBeHidden();
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  // the selector names the most urgent peer while one corner dot cycles through servers
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Working on another server');
  const statusDot = selector.locator(':scope > .server-switcher-attention');
  await expect(statusDot).toBeVisible();
  const [selectorCornerBounds, dotBounds] = await Promise.all([renderedBounds(selector), renderedBounds(statusDot)]);
  expect(dotBounds.width).toBe(6);
  expect(Math.abs(dotBounds.x + dotBounds.width - (selectorCornerBounds.x + selectorCornerBounds.width - 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(dotBounds.y - (selectorCornerBounds.y + 4))).toBeLessThanOrEqual(1);
  const activeTab = page.getByRole('tab', { selected: true });
  const [selectorBounds, tabBounds, outputBounds] = await Promise.all([renderedBounds(selector), renderedBounds(activeTab), renderedBounds(page.locator('.log-output'))]);
  expect(selectorBounds.x).toBeLessThan(tabBounds.x);
  expect(Math.abs(selectorBounds.y - tabBounds.y)).toBeLessThanOrEqual(1);
  expect(selectorBounds.y).toBeGreaterThanOrEqual(outputBounds.y + outputBounds.height - 1);

  // the menu lists the servers with their attention, and nothing else
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Remote Agents servers' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.server-menu-item')).toHaveCount(2);
  const details = menu.getByRole('group', { name: 'Current server details' });
  await expect(details).toContainText('X1 Carbon');
  await expect(details).toContainText('x1carbon.santosa.dev');
  await expect(details.getByText(revision.sha.slice(0, 7))).toBeVisible();
  await expect(details.locator('time')).toHaveAttribute('datetime', revision.committedAt);
  await expect(details).toContainText('Up to date');
  await expect(details.getByRole('button', { name: 'Rename Server' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'View upstream update' })).toHaveCount(0);
  const current = menu.locator('button.server-menu-item');
  const remote = menu.locator('a.server-menu-item');
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toHaveAccessibleName('X1 Carbon — Working');
  await expect(current.locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
  // preserve Android WebAPK link capture
  await expect(remote).toHaveAttribute('href', remoteServer.url);
  await expect(remote).toHaveAccessibleName('Framework — Working');
  await expect(remote.locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
  await expect(menu.locator('.server-switcher-attention.working')).toHaveCount(2);
  // choosing the current server just closes the menu
  await current.click();
  await expect(menu).toHaveCount(0);
  await expect(selector).toHaveAttribute('aria-expanded', 'false');

  remoteName = 'Framework Published';
  remoteAttention = 'completed';
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Completed notification on another server', { timeout: 8_000 });
  await selector.click();
  await expect(remote).toHaveAccessibleName('Framework Published — Completed notification');
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/completed/u);

  statusAvailable = false;
  await expect(remote).toHaveAccessibleName('Framework Published — Server unavailable', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/unavailable/u);
  // an unreachable peer rotates into the one dot without becoming aggregate attention
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon)');
  await expect(selector).toHaveAttribute('aria-description', 'Framework Published — Server unavailable');
  await expect(statusDot).toHaveClass(/unavailable/u);

  statusAvailable = true;
  remoteAttention = 'question';
  await expect(remote).toHaveAccessibleName('Framework Published — Active question', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/question/u);
  await expect(selector).toHaveAttribute('aria-description', 'Framework Published — Active question');
  await expect(statusDot).toHaveClass(/question/u);
  // show a neutral marker when the server needs no attention
  remoteAttention = 'idle';
  await expect(remote).toHaveAccessibleName('Framework Published — Idle', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/idle/u);
  await expect(remote.locator('.server-switcher-attention')).toHaveCSS('background-color', 'rgb(88, 91, 112)');
  // an idle peer still takes a turn in the neutral corner dot
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon)');
  await expect(selector).toHaveAttribute('aria-description', 'Framework Published — Idle');
  await expect(statusDot).toHaveClass(/idle/u);

  // the phone uses the icon edge-to-edge without padding
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selector.locator('.server-selector-name')).toBeHidden();
  await expect(selector.locator('img')).toBeVisible();
  const [iconBounds, buttonBounds] = await Promise.all([renderedBounds(selector.locator('img')), renderedBounds(selector)]);
  expect(buttonBounds.width - iconBounds.width).toBeLessThanOrEqual(2);
  expect(buttonBounds.height - iconBounds.height).toBeLessThanOrEqual(2);
  await expect(selector.locator('img')).toHaveCSS('border-radius', '4.8px');
  await expect(selector).toHaveCSS('padding-left', '0px');
  await expect(selector).toHaveCSS('padding-right', '0px');
  await expect(selector).toHaveCSS('border-top-width', '0px');
  await expect(selector).toHaveCSS('padding-top', '0px');
  const [narrowSelectorBounds, titleBounds, narrowOutputBounds] = await Promise.all([renderedBounds(selector), renderedBounds(page.locator('.agent-panel .panel-header-title')), renderedBounds(page.locator('.log-output'))]);
  // inset the outlined selector with its tab-strip peers
  expect(Math.abs(narrowSelectorBounds.x - 6)).toBeLessThanOrEqual(1);
  // the agent panel's title pill takes the corner the switcher left
  expect(titleBounds.y - narrowOutputBounds.y).toBeLessThan(12);

  await selector.click();
  await remote.click();
  await expect(page).toHaveURL('https://framework.santosa.dev/');
  await expect(page.getByRole('heading', { name: 'Framework target' })).toBeVisible();
});

test('leads the empty console tab row with the server selector', async ({ page }) => {
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [] };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  const lead = page.locator('.tabs > .tab-row-lead');
  await expect(lead.getByRole('button', { name: 'Switch server (X1 Carbon)' })).toBeVisible();
  await expect(page.locator('.tabs > .server-switcher-settings-wrap').getByRole('button', { name: 'Global settings' })).toBeVisible();
  await lead.getByRole('button', { name: 'Switch server (X1 Carbon)' }).click();
  const menu = page.getByRole('group', { name: 'Remote Agents servers' });
  await expect(menu.locator('.server-menu-item')).toHaveCount(1);
  await expect(menu.getByRole('group', { name: 'Current server details' }).getByRole('button', { name: 'Rename Server' })).toBeVisible();
  await expect(menu.locator('button.server-menu-item')).toHaveAttribute('aria-current', 'page');
});

test('rolls the most urgent remote attention onto the closed selector', async ({ page }) => {
  const remotes = [{ name: 'Framework', url: 'https://framework.santosa.dev', icon: 'heart' }, { name: 'Homelab', url: 'https://homelab.santosa.dev', icon: 'terminal' }];
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes };
  let attention = { framework: 'working', homelab: 'question' };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/server-statuses') return route.fulfill({ json: { servers: [{ name: server.name, url: server.url, icon: server.icon, attention: 'idle' }, { ...remotes[0], attention: attention.framework }, { ...remotes[1], attention: attention.homelab }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const selector = page.locator('.tab-row-lead .server-selector');
  const statusDot = selector.locator(':scope > .server-switcher-attention');
  // a question on one remote outranks work on another
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Active question on another server');
  await expect(statusDot).toHaveCount(1);
  await expect(selector).toHaveAttribute('aria-description', 'Framework — Working');
  await expect(statusDot).toHaveClass(/working/u);
  await expect(selector).toHaveAttribute('aria-description', 'Homelab — Active question');
  await expect(statusDot).toHaveClass(/question/u);
  // an unread result outranks work, whichever remote carries it
  attention = { framework: 'completed', homelab: 'working' };
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Completed notification on another server', { timeout: 8_000 });
  await expect(selector).toHaveAttribute('aria-description', 'Framework — Completed notification');
  await expect(statusDot).toHaveClass(/completed/u);
  await expect(selector).toHaveAttribute('aria-description', 'Homelab — Working');
  await expect(statusDot).toHaveClass(/working/u);
});

test('cycles one corner status dot through configured servers at narrow phone width', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 320, height: 780 });
  const remotes = Array.from({ length: 2 }, (_, index) => ({ name: `Remote ${index + 1}`, url: `https://remote-${index + 1}.example.com`, icon: 'terminal' }));
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // serve distinct statuses for the current instance and two peers
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (path === '/api/server-statuses') return route.fulfill({ json: { servers: [{ name: server.name, url: server.url, icon: server.icon, attention: 'idle' }, ...remotes.map((remote, index) => ({ ...remote, attention: index % 2 === 0 ? 'working' : 'question' }))] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const selector = page.locator('.tab-row-lead .server-selector');
  const dot = selector.locator(':scope > .server-switcher-attention');
  await expect(dot).toHaveCount(1);
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Idle');
  await expect(dot).toHaveClass(/idle/u);
  // hold the current status until the one-second boundary
  await page.clock.runFor(999);
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Idle');
  await page.clock.runFor(1);
  await expect(selector).toHaveAttribute('aria-description', 'Remote 1 — Working');
  await expect(dot).toHaveClass(/working/u);
  // advance one configured server per second
  await page.clock.runFor(1_000);
  await expect(selector).toHaveAttribute('aria-description', 'Remote 2 — Active question');
  await expect(dot).toHaveClass(/question/u);
  await page.clock.runFor(1_000);
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Idle');
  await expect(dot).toHaveClass(/idle/u);
  const [buttonBounds, iconBounds, dotBounds] = await Promise.all([renderedBounds(selector), renderedBounds(selector.locator('img')), renderedBounds(dot)]);
  expect(buttonBounds.width).toBe(iconBounds.width);
  expect(buttonBounds.height).toBe(iconBounds.height);
  expect(dotBounds.width).toBe(6);
  expect(dotBounds.x + dotBounds.width).toBeLessThanOrEqual(buttonBounds.x + buttonBounds.width);
  expect(dotBounds.y).toBeGreaterThanOrEqual(buttonBounds.y);
});

test('adds a purple update turn to the server selector status cycle', async ({ page }) => {
  await page.clock.install();
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // keep one configured server and one upstream update
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (path === '/api/server-statuses') return route.fulfill({ json: { servers: [{ ...server, attention: 'idle' }] } });
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  const selector = page.locator('.tab-row-lead .server-selector');
  const dot = selector.locator(':scope > .server-switcher-attention');
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — update available');
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Idle');
  await expect(dot).toHaveClass(/idle/u);
  // update follows the server's own status in the same corner
  await page.clock.runFor(1_000);
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Update available');
  await expect(dot).toHaveClass(/update/u);
  await expect(dot).toHaveCSS('background-color', 'rgb(203, 166, 247)');
  await page.clock.runFor(1_000);
  await expect(selector).toHaveAttribute('aria-description', 'X1 Carbon — Idle');
  await expect(dot).toHaveClass(/idle/u);
  await expect(dot).toHaveCount(1);
});

test('renders a single configured server as the current button', async ({ page }) => {
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // serve the public login metadata
    if (url.pathname === '/api/auth/session') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    if (url.pathname === '/api/auth/bootstrap') return route.fulfill({ json: { csrfToken: 'bootstrap-token', server } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    return route.continue();
  });

  await page.goto('/');
  // reveal the configured server only after choosing password entry
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const group = page.getByRole('group', { name: 'Remote Agents servers' });
  const buttons = group.getByRole('button');
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveText(['X1 Carbon']);
  await expect(buttons.first()).toHaveAttribute('aria-current', 'page');
});
