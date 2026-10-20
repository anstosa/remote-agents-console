import { expect, test } from '@playwright/test';
import { createServer, request as sendRequest } from 'node:http';
import { ProjectProxy } from '../../server/src/project-proxy.js';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';
import { clickPanelAction, expectPanelAction } from './panel-header';
import { chooseSplit, openSplitMenu } from './split-menu.js';
import { expectProgressBorder } from './progress-border-assertions';

// load the production browser bridge through its real proxy endpoint
const projectBrowserBridge = async () => {
  const proxy = new ProjectProxy(() => [{ projectUrl: 'https://project.example.com', projectPort: 1 }], 'http://127.0.0.1:4173');
  const server = createServer((request, response) => {
    // reject unrelated virtual hosts and paths
    if (!proxy.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      // reject unexpected non-TCP listeners
      if (address === null || typeof address === 'string') { reject(new Error('missing browser bridge listener')); return; }
      resolve(address.port);
    });
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = sendRequest({ hostname: '127.0.0.1', port, path: '/__rac/browser-bridge.js', headers: { host: 'project.example.com' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.once('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

// verify direct external preview routing
test('loads direct external previews without managed proxy endpoints', async ({ page }) => {
  const directUrl = 'https://external-preview.example/map/?site=portable';
  const projectRequests: string[] = [];
  const requestPaths: string[] = [];
  // record every requested endpoint
  page.on('request', request => { requestPaths.push(new URL(request.url()).pathname); });
  await page.setViewportSize({ width: 1400, height: 850 });
  await installPaneMock(page);
  // serve the portable external target
  await page.context().route('https://external-preview.example/**', async route => {
    projectRequests.push(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<main>Direct external preview</main><script>parent.postMessage({ type: "rac-browser-location", url: "https://external-preview.example/forged" }, "*")</script>' });
  });
  // serve one direct-preview dashboard
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish an authenticated session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish the direct project target
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-direct', sessionId: 'socket:$1', home: '/worktrees/external-preview', worktreeId: 'external-preview', worktreeLabel: 'External preview', worktreeOrder: 0, title: 'Ready', projectUrl: directUrl, projectProxied: false, stack: { actions: ['start', 'stop', 'restart'], running: true, tunnel: true } }], projects: [] } });
    // serve the required log ticket
    if (path === '/api/agents/agent-direct/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty agent collections
    if (path === '/api/agents/agent-direct/saved-prompts' || path === '/api/agents/agent-direct/prompt-history' || path === '/api/agents/agent-direct/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // serve empty worktree notes
    if (path === '/api/worktrees/external-preview/notes') return route.fulfill({ json: { notes: [] } });
    // serve an unavailable push key
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // Stream the pane a few rows down so the Open link clears the top-left server switcher.
  await seedPaneSize(page, 'agent-direct', 80, 24);
  await pushBytes(page, 'agent-direct', '\r\n\r\n\r\nAdmin https://external-preview.example/admin\r\n');
  const controls = page.getByRole('group', { name: 'Project controls' });
  const stackControls = controls.getByRole('button', { name: 'Stack controls: healthy' });
  await expect(stackControls).toBeVisible();
  const adminLink = page.getByRole('link', { name: 'Open https://external-preview.example/admin' });
  await expect(adminLink).toBeVisible();
  const closedPopupPromise = page.waitForEvent('popup');
  await adminLink.click();
  const closedPopup = await closedPopupPromise;
  await expect(closedPopup).toHaveURL('https://external-preview.example/admin');
  await closedPopup.close();
  await stackControls.click();
  await expect(page.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute('href', directUrl);
  const split = page.getByRole('button', { name: 'Split', exact: true });
  await expect(split).toBeVisible();
  await split.click();

  const browser = page.getByRole('dialog', { name: 'Browser' });
  const frame = browser.locator('iframe[title="Project browser"]');
  await expect(frame).toHaveAttribute('src', directUrl);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Direct external preview')).toBeVisible();
  await stackControls.click();
  const closeSplit = page.getByRole('button', { name: 'Close', exact: true });
  await expect(closeSplit).toHaveAttribute('aria-pressed', 'true');
  await closeSplit.click();
  await expect(browser).toBeHidden();
  await stackControls.click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(browser).toBeVisible();
  const address = browser.getByRole('textbox', { name: 'Browser address' });
  await expect(address).toHaveValue(directUrl);
  const home = browser.getByRole('button', { name: 'Go to project home' });
  await expect(home).toBeDisabled();
  await address.fill('https://external-preview.example/map/details?site=portable');
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', 'https://external-preview.example/map/details?site=portable');
  await expect(home).toBeEnabled();
  await home.click();
  await expect(frame).toHaveAttribute('src', directUrl);
  await expect(address).toHaveValue(directUrl);
  const viewport = browser.getByRole('button', { name: 'Use mobile viewport' });
  const requestCountBeforeResize = projectRequests.length;
  await viewport.click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  expect(projectRequests).toHaveLength(requestCountBeforeResize);
  await expect(frame).toHaveAttribute('src', directUrl);
  const refresh = browser.getByRole('button', { name: 'Refresh browser' });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => projectRequests.length).toBeGreaterThan(requestCountBeforeResize);
  await expect(frame).toHaveAttribute('src', directUrl);
  expect(projectRequests.map(request => new URL(request).pathname).some(path => path.startsWith('/__rac/'))).toBe(false);
  expect(requestPaths.filter(path => path.includes('/__rac/browser-') || /browser.*device.*token/u.test(path))).toEqual([]);
  let splitPopupOpened = false;
  // detect a duplicate top-level navigation
  page.once('popup', popup => { splitPopupOpened = true; void popup.close(); });
  await adminLink.click();
  await expect(frame).toHaveAttribute('src', 'https://external-preview.example/admin');
  await expect(address).toHaveValue('https://external-preview.example/admin');
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Direct external preview')).toBeVisible();
  expect(splitPopupOpened).toBe(false);
});

// verify managed browser chrome and safe external address navigation
test('themes browser chrome and retains safe external addresses', async ({ page }) => {
  test.setTimeout(75_000);
  const managedTheme = '#123456';
  const externalUrl = 'https://outside.example.com/reference?from=address#section';
  const deviceRequests: string[] = [];
  const externalRequests: string[] = [];
  const bridge = await projectBrowserBridge();
  await page.setViewportSize({ width: 1400, height: 850 });
  await installPaneMock(page);
  // serve the managed project and its cooperative browser messages
  await page.route('https://project.example.com/**', async route => {
    const requestUrl = new URL(route.request().url());
    // serve the production bridge from its project-owned path
    if (requestUrl.pathname === '/__rac/browser-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
    let destination = requestUrl;
    let deviceTransition = '';
    // emulate the local device bridge
    if (requestUrl.pathname === '/__rac/browser-device') {
      deviceRequests.push(requestUrl.href);
      destination = new URL(requestUrl.searchParams.get('location') ?? '/', requestUrl.origin);
      deviceTransition = `<script>history.replaceState({}, '', ${JSON.stringify(`${destination.pathname}${destination.search}${destination.hash}`)})</script>`;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `${deviceTransition}<html style="background-color: rgb(4, 5, 6)"><head><meta name="theme-color" content="${managedTheme}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#506070" media="(prefers-color-scheme: dark)"><meta name="msapplication-navbutton-color" content="#234567"><script src="/__rac/browser-bridge.js"></script></head><body><main>Managed project</main><a href="https://outside.example.com/from-managed-link">Leave managed project</a></body></html>`
    });
  });
  // serve an external page that cannot control managed browser chrome
  await page.route('https://outside.example.com/**', route => {
    const requestUrl = new URL(route.request().url());
    externalRequests.push(requestUrl.href);
    return route.fulfill({
      contentType: 'text/html',
      body: '<main>External reference</main><a href="https://project.example.com/">Return to managed project</a><script>parent.postMessage({ type: "rac-browser-location", url: "https://outside.example.com/forged" }, "*"); parent.postMessage({ type: "rac-browser-theme", color: "#ff0000" }, "*");</script>'
    });
  });
  // serve one active project workspace
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish an authenticated session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish one managed project target
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-themed', sessionId: 'socket:$1', home: '/worktrees/themed', worktreeId: 'themed', worktreeLabel: 'Themed', worktreeOrder: 0, title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start'], running: true, tunnel: true } }], projects: [] } });
    // serve the required log ticket
    if (path === '/api/agents/agent-themed/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty agent collections
    if (path === '/api/agents/agent-themed/saved-prompts' || path === '/api/agents/agent-themed/prompt-history' || path === '/api/agents/agent-themed/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // serve empty worktree notes
    if (path === '/api/worktrees/themed/notes') return route.fulfill({ json: { notes: [] } });
    // serve an unavailable push key
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-themed', 80, 24);
  const controls = page.getByRole('group', { name: 'Project controls' });
  await controls.getByRole('button', { name: 'Stack controls: healthy' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  const address = browser.getByRole('textbox', { name: 'Browser address' });
  const frame = browser.locator('iframe[title="Project browser"]');
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('form', { name: 'Browser address navigation' })).toBeVisible();
  // preserve the single bordered pill while supporting native keyboard submission
  await expect(address).toHaveCSS('border-top-width', '1px');
  await expect(browser).toHaveCSS('background-color', 'rgb(18, 52, 86)');

  // react to color-scheme changes using the matching theme metadata
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(browser).toHaveCSS('background-color', 'rgb(80, 96, 112)');
  const preview = page.frameLocator('iframe[title="Project browser"]');
  // fall through transparent theme colors to an opaque configured source
  await preview.locator('html').evaluate(root => {
    // make every theme-color candidate fully transparent
    for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = 'transparent';
  });
  await expect(browser).toHaveCSS('background-color', 'rgb(35, 69, 103)');
  // reject zero-alpha functional colors through the same fallback
  await preview.locator('html').evaluate(root => {
    // make every theme-color candidate fully transparent
    for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = 'rgb(1 2 3 / 0)';
  });
  await expect(browser).toHaveCSS('background-color', 'rgb(35, 69, 103)');
  // fall through invalid theme metadata to the configured navigation color
  await preview.locator('html').evaluate(root => {
    // invalidate every theme-color candidate
    for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = 'not-a-color';
  });
  await expect(browser).toHaveCSS('background-color', 'rgb(35, 69, 103)');
  // prefer enabled Apple status metadata after navigation metadata disappears
  await preview.locator('html').evaluate(root => {
    root.querySelector('meta[name="msapplication-navbutton-color"]')?.remove();
    const capable = document.createElement('meta');
    capable.name = 'apple-mobile-web-app-capable';
    capable.content = 'yes';
    const status = document.createElement('meta');
    status.name = 'apple-mobile-web-app-status-bar-style';
    status.content = 'black-translucent';
    root.querySelector('head')?.append(capable, status);
  });
  await expect(browser).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  // fall back to the computed HTML background and track root theme changes
  await preview.locator('html').evaluate(root => {
    root.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
    root.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.remove();
  });
  await expect(browser).toHaveCSS('background-color', 'rgb(4, 5, 6)');
  await preview.locator('html').evaluate(root => { root.style.backgroundColor = 'rgb(7, 8, 9)'; });
  await expect(browser).toHaveCSS('background-color', 'rgb(7, 8, 9)');
  await page.emulateMedia({ colorScheme: 'light' });

  // ignore same-origin messages that do not come from the managed frame
  await page.evaluate(() => window.postMessage({ type: 'rac-browser-theme', color: '#00ff00' }, '*'));
  await expect(browser).toHaveCSS('background-color', 'rgb(7, 8, 9)');

  await address.fill(externalUrl);
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', externalUrl);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('External reference')).toBeVisible();
  await expect(address).toHaveValue(externalUrl);
  expect(deviceRequests).toHaveLength(1);
  await expect.poll(() => browser.evaluate(element => element.style.getPropertyValue('--browser-chrome-color'))).toBe('');
  await expect(browser).not.toHaveCSS('background-color', 'rgb(255, 0, 0)');

  // recover managed state when ordinary iframe navigation returns to the project origin
  await page.frameLocator('iframe[title="Project browser"]').getByRole('link', { name: 'Return to managed project' }).click();
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Managed project', { exact: true })).toBeVisible();
  await expect(address).toHaveValue('https://project.example.com/');
  await expect(browser).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(browser.getByRole('button', { name: 'Use mobile viewport and user agent' })).toBeVisible();
  const externalRequestsBeforeManagedRefresh = externalRequests.length;
  const deviceRequestsBeforeManagedRefresh = deviceRequests.length;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect.poll(() => deviceRequests.length).toBeGreaterThan(deviceRequestsBeforeManagedRefresh);
  expect(externalRequests).toHaveLength(externalRequestsBeforeManagedRefresh);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Managed project', { exact: true })).toBeVisible();

  // return to an external address for direct-mode behavior checks
  await address.fill(externalUrl);
  await address.press('Enter');
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('External reference')).toBeVisible();
  const deviceRequestsBeforeExternalActions = deviceRequests.length;

  // resize and refresh external pages without sending them through the local device bridge
  await browser.getByRole('button', { name: 'Use mobile viewport' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  expect(deviceRequests).toHaveLength(deviceRequestsBeforeExternalActions);
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect(frame).toHaveAttribute('src', externalUrl);
  expect(deviceRequests).toHaveLength(deviceRequestsBeforeExternalActions);

  // reject active-content, embedded-data, and credential-bearing addresses
  await address.fill('javascript:document.body.textContent="owned"');
  await address.press('Enter');
  await expect(address).toHaveValue(externalUrl);
  await expect(frame).toHaveAttribute('src', externalUrl);
  await address.fill('data:text/html,<main>owned</main>');
  await address.press('Enter');
  await expect(address).toHaveValue(externalUrl);
  await expect(frame).toHaveAttribute('src', externalUrl);
  await address.fill('https://user:secret@outside.example.com/private');
  await address.press('Enter');
  await expect(address).toHaveValue(externalUrl);
  await expect(frame).toHaveAttribute('src', externalUrl);

  // restore the external address after the console remounts
  await page.reload();
  await expect(browser).toBeVisible();
  await expect(address).toHaveValue(externalUrl);
  await expect(frame).toHaveAttribute('src', externalUrl);
  expect(deviceRequests).toHaveLength(deviceRequestsBeforeExternalActions);

  // home navigation returns to managed device emulation
  const managedRequestsBeforeHome = deviceRequests.length;
  await clickPanelAction(browser, 'Go to project home');
  await expect.poll(() => deviceRequests.length).toBeGreaterThan(managedRequestsBeforeHome);
  expect(new URL(deviceRequests.at(-1)!).searchParams.get('mode')).toBe('mobile');
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Managed project', { exact: true })).toBeVisible();
  await expect(browser).toHaveCSS('background-color', 'rgb(18, 52, 86)');

  // clear managed chrome when the framed page itself leaves the local origin
  await page.frameLocator('iframe[title="Project browser"]').getByRole('link', { name: 'Leave managed project' }).click();
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('External reference')).toBeVisible();
  await expect.poll(() => browser.evaluate(element => element.style.getPropertyValue('--browser-chrome-color'))).toBe('');
  await expect(browser).not.toHaveCSS('background-color', 'rgb(255, 0, 0)');
  // establish retained external state before exercising another in-frame return home
  await address.fill(externalUrl);
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', externalUrl);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('External reference')).toBeVisible();
  // recover the selected mobile mode when ordinary iframe navigation returns home
  const deviceRequestsBeforeMobileReturn = deviceRequests.length;
  await page.frameLocator('iframe[title="Project browser"]').getByRole('link', { name: 'Return to managed project' }).click();
  await expect(address).toHaveValue('https://project.example.com/');
  await expect.poll(() => deviceRequests.length).toBeGreaterThan(deviceRequestsBeforeMobileReturn);
  expect(new URL(deviceRequests.at(-1)!).searchParams.get('mode')).toBe('mobile');
  await expect(frame).toHaveAttribute('src', /\/__rac\/browser-device\?.*mode=mobile/u);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Managed project', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectPanelAction(browser, 'Use desktop viewport and user agent', toggle => expect(toggle).toBeVisible());
  await expect(browser).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  const externalRequestsBeforeMobileReturnRefresh = externalRequests.length;
  const deviceRequestsBeforeMobileReturnRefresh = deviceRequests.length;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect.poll(() => deviceRequests.length).toBeGreaterThan(deviceRequestsBeforeMobileReturnRefresh);
  expect(externalRequests).toHaveLength(externalRequestsBeforeMobileReturnRefresh);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Managed project', { exact: true })).toBeVisible();
});

// verify retained browser navigation
test('opens the configured project in desktop and mobile split views', async ({ page }) => {
  test.setTimeout(75_000);
  let previewLoads = 0;
  const requestedDevices: string[] = [];
  let holdNextPreviewLoad = false;
  let releasePreviewLoad: (() => void) | undefined;
  await page.setViewportSize({ width: 1600, height: 900 });
  await installPaneMock(page);
  // serve reported and unreported project navigation
  await page.route('https://project.example.com/**', async route => {
    let projectUrl = new URL(route.request().url());
    let deviceTransition = '';
    // emulate the project proxy device redirect
    if (projectUrl.pathname === '/__rac/browser-device') {
      const mode = projectUrl.searchParams.get('mode');
      const location = projectUrl.searchParams.get('location');
      requestedDevices.push(mode ?? 'missing');
      projectUrl = new URL(location ?? '/', projectUrl.origin);
      deviceTransition = `<script>history.replaceState({}, '', ${JSON.stringify(`${projectUrl.pathname}${projectUrl.search}${projectUrl.hash}`)})</script>`;
    }
    previewLoads += 1;
    // hold one reload for stop coverage
    if (holdNextPreviewLoad) {
      holdNextPreviewLoad = false;
      await new Promise<void>(resolve => { releasePreviewLoad = resolve; });
    }
    const location = `${projectUrl.pathname}${projectUrl.search}`;
    const links = projectUrl.pathname === '/' ? '<a href="/details?view=files#changed">View details</a><a href="/unreported">Open unreported page</a><a href="/spa">Open SPA page</a>' : '';
    const locationReport = projectUrl.pathname === '/unreported' ? '' : '<script>parent.postMessage({ type: \'rac-browser-location\', url: location.href }, \'*\')</script>';
    const keyboardBridge = '<script>window.addEventListener(\'keydown\', event => { /* reload only the embedded browser */ if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === \'r\') { event.preventDefault(); parent.postMessage({ type: \'rac-browser-refresh\' }, \'*\'); } });</script>';
    const spaNavigation = projectUrl.pathname === '/' ? `<script>document.querySelector('a[href="/spa"]').addEventListener('click', event => { event.preventDefault(); history.pushState({}, '', '/spa'); document.querySelector('main').dataset.location = '/spa'; parent.postMessage({ type: 'rac-browser-location', url: location.href }, '*'); });</script>` : '';
    await route.fulfill({ contentType: 'text/html', body: `${deviceTransition}<main data-location="${location}">Project preview ${previewLoads}</main>${links}${locationReport}${keyboardBridge}${spaNavigation}` }).catch(() => undefined);
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], running: true, tunnel: true } }], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1, projectUrl: 'https://project.example.com', stack: { actions: [], running: true, tunnel: true } }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Keep notes beside the browser.' }] } });
    if (url.pathname === '/api/worktrees/delta/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // Stream the pane the project links a few rows down, clear of the server switcher.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\nHome https://project.example.com/\r\nLocal https://project.example.com/from-output?view=files#changed\r\nExternal https://outside.example.com/resource\r\n');
  const projectControls = page.getByRole('group', { name: 'Project controls' });
  const stackControls = projectControls.getByRole('button', { name: 'Stack controls: healthy' });
  await expect(projectControls.locator('.project-stack-trigger')).toHaveCount(1);
  const localOutputLink = page.getByRole('link', { name: 'Open https://project.example.com/from-output?view=files#changed' });
  await expect(localOutputLink).toBeVisible();
  const closedSplitPopupPromise = page.waitForEvent('popup');
  await localOutputLink.click();
  const closedSplitPopup = await closedSplitPopupPromise;
  await closedSplitPopup.close();
  await stackControls.click();
  const split = page.getByRole('button', { name: 'Split', exact: true });
  await expect(split).toBeVisible();
  await split.click();

  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('toolbar', { name: 'Browser actions' })).not.toContainText('Browser');
  const deviceToggle = browser.locator('.browser-device-toggle');
  await expect(deviceToggle).toHaveCount(1);
  await expect(deviceToggle).toHaveAttribute('aria-label', 'Use mobile viewport and user agent');
  await expect(deviceToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(deviceToggle.locator('svg')).toHaveCount(1);
  await expect(deviceToggle.locator('svg')).toHaveAttribute('data-device', 'desktop');
  expect(requestedDevices.at(-1)).toBe('desktop');
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeDisabled();

  await page.evaluate(() => { (window as typeof window & { topLevelRetained?: boolean }).topLevelRetained = true; });
  const loadsBeforeShortcutRefresh = previewLoads;
  // dispatch one iframe-scoped reload chord
  const shortcutPrevented = await preview.locator('main').evaluate(element => !element.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(shortcutPrevented).toBe(true);
  await expect.poll(() => previewLoads).toBeGreaterThan(loadsBeforeShortcutRefresh);
  expect(await page.evaluate(() => (window as typeof window & { topLevelRetained?: boolean }).topLevelRetained)).toBe(true);

  await localOutputLink.click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/from-output?view=files');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/from-output?view=files#changed');
  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');

  const externalOutputLink = page.getByRole('link', { name: 'Open https://outside.example.com/resource' }).first();
  await expect(externalOutputLink).toHaveAttribute('href', 'https://outside.example.com/resource');
  const popupPromise = page.waitForEvent('popup');
  await externalOutputLink.click();
  const popup = await popupPromise;
  await popup.close();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');

  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Keep notes beside the browser.…', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  const output = page.locator('.log-output');
  const noteDivider = page.getByRole('separator', { name: 'Resize agent and note panels' });
  const browserDivider = page.getByRole('separator', { name: 'Resize note and browser panels' });
  await expect(note).toBeVisible();
  await expect(noteDivider).toBeVisible();
  await expect(browserDivider).toBeVisible();
  const initialPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(initialPanels[0]!.x).toBeLessThan(initialPanels[1]!.x);
  expect(initialPanels[1]!.x).toBeLessThan(initialPanels[2]!.x);

  const dividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(dividerBounds!.x + dividerBounds!.width / 2, dividerBounds!.y + dividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBounds!.x + 90, dividerBounds!.y + dividerBounds!.height / 2);
  await page.mouse.up();
  const resizedPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(resizedPanels[0]!.width).toBeGreaterThan(initialPanels[0]!.width + 50);
  expect(resizedPanels[1]!.width).toBeLessThan(initialPanels[1]!.width - 50);
  expect(Math.abs(resizedPanels[2]!.width - initialPanels[2]!.width)).toBeLessThan(5);

  const browserDividerBounds = await browserDivider.boundingBox();
  await page.mouse.move(browserDividerBounds!.x + browserDividerBounds!.width / 2, browserDividerBounds!.y + browserDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(browserDividerBounds!.x - 70, browserDividerBounds!.y + browserDividerBounds!.height / 2);
  await page.mouse.up();
  const browserResizedPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(Math.abs(browserResizedPanels[0]!.width - resizedPanels[0]!.width)).toBeLessThan(5);
  expect(browserResizedPanels[1]!.width).toBeLessThan(resizedPanels[1]!.width - 40);
  expect(browserResizedPanels[2]!.width).toBeGreaterThan(resizedPanels[2]!.width + 40);

  // retain user-sized panel weights for this client and workspace
  const retainedSplit = await page.locator('.log-split').evaluate(element => {
    const style = (element as HTMLElement).style;
    return {
      agent: style.getPropertyValue('--agent-split'),
      note: style.getPropertyValue('--note-split'),
      browser: style.getPropertyValue('--browser-split')
    };
  });
  await page.reload();
  await expect(note).toBeVisible();
  await expect(browser).toBeVisible();
  // restore the exact saved layout after the workspace remounts
  await expect.poll(async () => await page.locator('.log-split').evaluate(element => {
    const style = (element as HTMLElement).style;
    return {
      agent: style.getPropertyValue('--agent-split'),
      note: style.getPropertyValue('--note-split'),
      browser: style.getPropertyValue('--browser-split')
    };
  })).toEqual(retainedSplit);

  const resizedNoteDividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(resizedNoteDividerBounds!.x + resizedNoteDividerBounds!.width / 2, resizedNoteDividerBounds!.y + resizedNoteDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, resizedNoteDividerBounds!.y + resizedNoteDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await output.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  const resizedBrowserDividerBounds = await browserDivider.boundingBox();
  await page.mouse.move(resizedBrowserDividerBounds!.x + resizedBrowserDividerBounds!.width / 2, resizedBrowserDividerBounds!.y + resizedBrowserDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1600, resizedBrowserDividerBounds!.y + resizedBrowserDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await browser.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  const finalNoteDividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(finalNoteDividerBounds!.x + finalNoteDividerBounds!.width / 2, finalNoteDividerBounds!.y + finalNoteDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1600, finalNoteDividerBounds!.y + finalNoteDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await note.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  await preview.getByRole('link', { name: 'View details' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/details?view=files');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/details?view=files#changed');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeVisible());

  await clickPanelAction(browser, 'Go to project home');
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeDisabled());
  const loadsBeforeSpaNavigation = previewLoads;
  await preview.getByRole('link', { name: 'Open SPA page' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/spa');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeEnabled());
  expect(previewLoads).toBe(loadsBeforeSpaNavigation);

  await clickPanelAction(browser, 'Use mobile viewport and user agent');
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expectPanelAction(browser, 'Use desktop viewport and user agent', async toggle => {
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle.locator('svg')).toHaveAttribute('data-device', 'mobile');
  });
  expect(requestedDevices.at(-1)).toBe('mobile');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeVisible());
  await expect(browserDivider).toBeHidden();
  await expect(noteDivider).toBeVisible();
  const [frameWidth, shellWidth, paneWidth, outputWidth, addressBounds, deviceBounds] = await Promise.all([
    browser.locator('iframe').evaluate(element => element.getBoundingClientRect().width),
    browser.locator('.browser-frame-shell').evaluate(element => element.getBoundingClientRect().width),
    browser.evaluate(element => element.getBoundingClientRect().width),
    page.locator('.log-output').evaluate(element => element.getBoundingClientRect().width),
    browser.locator('.browser-address').boundingBox(),
    // the narrow column folds the device toggle into the header ⋮, which shares the address centerline
    browser.locator('.panel-header-more').boundingBox()
  ]);
  expect(frameWidth).toBeLessThanOrEqual(391);
  expect(Math.abs(frameWidth - shellWidth)).toBeLessThanOrEqual(2);
  expect(paneWidth).toBeLessThanOrEqual(391);
  expect(outputWidth).toBeGreaterThan(paneWidth);
  const addressCenter = addressBounds!.y + addressBounds!.height / 2;
  const deviceCenter = deviceBounds!.y + deviceBounds!.height / 2;
  expect(Math.abs(addressCenter - deviceCenter)).toBeLessThanOrEqual(4);

  await clickPanelAction(browser, 'Use desktop viewport and user agent');
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/desktop/u);
  await expectPanelAction(browser, 'Use mobile viewport and user agent', async toggle => {
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle.locator('svg')).toHaveAttribute('data-device', 'desktop');
  });
  expect(requestedDevices.at(-1)).toBe('desktop');
  await clickPanelAction(browser, 'Use mobile viewport and user agent');
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  expect(requestedDevices.at(-1)).toBe('mobile');

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect(note).toBeVisible();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/desktop/u);
  await browser.getByRole('button', { name: 'Close browser' }).click();

  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await projectControls.getByRole('button', { name: 'Stack controls: healthy' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(browser).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await page.reload();
  await expect(browser).toBeVisible();
  await expect(note).toBeVisible();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');
  const restoredPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(restoredPanels[0]!.x).toBeLessThan(restoredPanels[1]!.x);
  expect(restoredPanels[1]!.x).toBeLessThan(restoredPanels[2]!.x);

  holdNextPreviewLoad = true;
  const loadsBeforeStop = previewLoads;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  const stopLoading = browser.getByRole('button', { name: 'Stop loading browser' });
  await expect(stopLoading).toBeVisible();
  await expect(stopLoading).toHaveClass(/loading/u);
  await expectProgressBorder(stopLoading, 'blue');
  await expect(stopLoading.locator('path')).toHaveAttribute('d', 'm6 6 12 12M18 6 6 18');
  await expect.poll(() => previewLoads).toBeGreaterThan(loadsBeforeStop);
  await stopLoading.click();
  const refresh = browser.getByRole('button', { name: 'Refresh browser' });
  await expect(refresh).toBeVisible();
  await expect(refresh).not.toHaveClass(/loading/u);
  releasePreviewLoad?.();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  const loadsBeforeRefresh = previewLoads;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect.poll(() => previewLoads).toBeGreaterThan(loadsBeforeRefresh);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await clickPanelAction(browser, 'Go to project home');
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeDisabled());

  await preview.getByRole('link', { name: 'Open unreported page' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/unreported');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeVisible());
  // Re-stream the project links here: the many split/device/fullscreen resizes above
  // reflow the pane, and unlike tmux the mock does not persist earlier output, so the
  // panel's live buffer is re-seeded for this interaction the way the server would.
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nHome https://project.example.com/\r\n');
  const homeOutputLink = page.getByRole('link', { name: 'Open https://project.example.com/', exact: true });
  await expect(homeOutputLink).toBeVisible();
  await homeOutputLink.click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expectPanelAction(browser, 'Go to project home', home => expect(home).toBeDisabled());
  await browser.getByRole('button', { name: 'Expand browser' }).click();
  await expect(browser).toHaveClass(/expanded/u);
  await expect(page.locator('.log-output')).toBeHidden();
  await expect(note).toBeHidden();

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(note).toBeVisible();
});

// verify browser-only geometry without a leading phantom divider track
test('fills an agentless workspace when the browser is its only panel', async ({ page }, testInfo) => {
  test.setTimeout(75_000);
  const worktreeId = 'browser-only';
  await page.setViewportSize({ width: 1400, height: 850 });
  // serve the embedded project preview
  await page.route('https://project.example.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><main>Browser-only preview</main>'
  }));
  // serve one inactive project workspace
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    // serve the authenticated browser client
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve the browser-only workspace fixture
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'project', label: 'Project', available: true, worktrees: [{ id: worktreeId, projectId: 'project', label: 'Browser only', path: '/worktrees/browser-only', available: true, pinned: true, order: 0, projectUrl: 'https://project.example.com' }] }] } });
    // serve empty workspace notes
    if (path === `/api/worktrees/${worktreeId}/notes`) return route.fulfill({ json: { notes: [] } });
    // serve empty workspace panes
    if (path === `/api/worktrees/${worktreeId}/panes`) return route.fulfill({ json: { panes: [] } });
    // serve an unavailable push key
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto(`/#worktree=${worktreeId}`);
  await page.getByRole('region', { name: 'Empty workspace' }).getByRole('button', { name: 'Browser', exact: true }).click();
  const split = page.locator('.log-split');
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect(split.locator(':scope > .split-resizer')).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Browser-only preview')).toBeVisible();
  const [desktopSplit, desktopBrowser, desktopFrame] = await Promise.all([split.boundingBox(), browser.boundingBox(), browser.locator('iframe').boundingBox()]);
  // fail clearly when a desktop surface has no measurable bounds
  if (desktopSplit === null || desktopBrowser === null || desktopFrame === null) throw new Error('Browser-only desktop bounds are unavailable');
  expect(desktopBrowser.x).toBeCloseTo(desktopSplit.x, 0);
  expect(desktopBrowser.width).toBeCloseTo(desktopSplit.width, 0);
  expect(desktopBrowser.height).toBeCloseTo(desktopSplit.height, 0);
  expect(Math.abs(desktopFrame.width - desktopBrowser.width)).toBeLessThanOrEqual(2);
  const desktopScreenshot = testInfo.outputPath('browser-only-desktop.png');
  await page.screenshot({ path: desktopScreenshot });
  await testInfo.attach('browser-only-desktop', { path: desktopScreenshot, contentType: 'image/png' });

  // click once before the narrower header folds and renames this action
  await browser.getByRole('button', { name: 'Use mobile viewport and user agent', exact: true }).click();
  await expect(browser).toHaveClass(/\bmobile\b/u);
  const [mobileSplit, mobileBrowser, mobileFrame] = await Promise.all([split.boundingBox(), browser.boundingBox(), browser.locator('iframe').boundingBox()]);
  // fail clearly when a mobile preview surface has no measurable bounds
  if (mobileSplit === null || mobileBrowser === null || mobileFrame === null) throw new Error('Browser-only mobile bounds are unavailable');
  expect(mobileBrowser.width).toBeCloseTo(390, 0);
  expect(mobileBrowser.height).toBeCloseTo(mobileSplit.height, 0);
  expect(mobileFrame.width).toBeGreaterThanOrEqual(388);
  expect(mobileFrame.width).toBeLessThanOrEqual(390);
  const mobileScreenshot = testInfo.outputPath('browser-only-mobile-preview.png');
  await page.screenshot({ path: mobileScreenshot });
  await testInfo.attach('browser-only-mobile-preview', { path: mobileScreenshot, contentType: 'image/png' });

  // restore the open mobile preview after remounting the workspace
  await page.reload();
  await expect(browser).toBeVisible();
  await expect(browser).toHaveClass(/\bmobile\b/u);
  await expect(page.frameLocator('iframe[title="Project browser"]').getByText('Browser-only preview')).toBeVisible();
});

test.describe('phone browser split', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 900 }
  });

  // verify phone-only rendering in a mobile browser context
  test('uses full-width mobile and scaled desktop device modes', async ({ page }) => {
    test.setTimeout(45_000);
    const requestedDevices: string[] = [];
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
        constructor() { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
        // ignore unused phone socket messages
        send() { /* no output required */ }
        // close the simulated socket
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    });
    await page.route('https://project.example.com/**', async route => {
      let projectUrl = new URL(route.request().url());
      // emulate the project proxy redirect
      if (projectUrl.pathname === '/__rac/browser-device') {
        requestedDevices.push(projectUrl.searchParams.get('mode') ?? 'missing');
        projectUrl = new URL(projectUrl.searchParams.get('location') ?? '/', projectUrl.origin);
      }
      const location = `${projectUrl.pathname}${projectUrl.search}${projectUrl.hash}`;
      await route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width, initial-scale=1"><main data-location="${location}">Phone preview</main>` });
    });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      // serve the active phone session
      if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      // serve one project-enabled agent
      if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', projectUrl: 'https://project.example.com', stack: { running: true, tunnel: true } }], projects: [] } });
      // serve the required log ticket
      if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
      // serve empty agent collections
      if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
      // serve one mobile note
      if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Keep notes beside the browser.' }] } });
      // serve an unavailable push key
      if (path === '/api/push/public-key') return route.fulfill({ json: {} });
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await page.goto('/');
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Mobile');
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    // on the phone the Browser is in the toolbar's ⋮; the newly opened panel scrolls into view
    await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();

    const browser = page.getByRole('dialog', { name: 'Browser' });
    const output = page.locator('.log-output');
    const dots = page.getByRole('group', { name: 'Panels' });
    const splitTrigger = dots.getByRole('button', { name: 'Choose split' });
    await expect(browser).toBeInViewport({ ratio: 0.99 });
    await expect(output).not.toBeInViewport();
    await expect(splitTrigger).toBeVisible();

    // switch directly among output, note, and browser panes
    await chooseSplit(page, 'Agent output');
    await expect(output).toBeInViewport({ ratio: 0.99 });
    await page.getByRole('button', { name: 'Notes (1)' }).click();
    await page.getByRole('button', { name: 'Keep notes beside the browser.…', exact: true }).click();
    const note = page.getByRole('dialog', { name: 'Note' });
    await expect(note).toBeInViewport({ ratio: 0.99 });
    await expect(output).not.toBeInViewport();
    await expect(browser).not.toBeInViewport();
    await expect(splitTrigger).toBeVisible();
    await chooseSplit(page, 'Project browser');
    await expect(browser).toBeInViewport({ ratio: 0.99 });
    await expect(note).not.toBeInViewport();
    await expect((await openSplitMenu(page)).getByRole('menuitem', { name: 'Note' })).toBeVisible();
    await page.getByRole('menu', { name: 'Splits' }).getByRole('menuitem', { name: 'Note' }).click();
    await expect(note).toBeInViewport({ ratio: 0.99 });
    await note.getByRole('button', { name: 'Close note' }).click();
    await expect(output).toBeInViewport({ ratio: 0.99 });
    await expect(note).toHaveCount(0);
    await chooseSplit(page, 'Project browser');

    const preview = page.frameLocator('iframe[title="Project browser"]');
    await expect(browser).toBeInViewport({ ratio: 0.99 });
    await expect(output).not.toBeInViewport();
    await expect(splitTrigger).toBeVisible();
    // on the phone expand offers full screen
    await expect(browser.getByRole('button', { name: 'Expand browser' })).toBeVisible();
    await expectPanelAction(browser, 'Use mobile viewport and user agent', async toggle => {
      await expect(toggle.locator('svg')).toHaveCount(1);
      await expect(toggle.locator('svg')).toHaveAttribute('data-device', 'desktop');
    });
    expect(requestedDevices.at(-1)).toBe('desktop');
    expect(await preview.locator('main').evaluate(() => window.innerWidth)).toBe(980);

    await clickPanelAction(browser, 'Use mobile viewport and user agent');
    await expectPanelAction(browser, 'Use desktop viewport and user agent', async toggle => {
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle.locator('svg')).toHaveAttribute('data-device', 'mobile');
    });
    expect(requestedDevices.at(-1)).toBe('mobile');
    const [frameWidth, shellWidth, layoutWidth] = await Promise.all([
      browser.locator('iframe').evaluate(element => element.getBoundingClientRect().width),
      browser.locator('.browser-frame-shell').evaluate(element => element.getBoundingClientRect().width),
      preview.locator('main').evaluate(() => window.innerWidth)
    ]);
    expect(Math.abs(frameWidth - shellWidth)).toBeLessThanOrEqual(2);
    expect(layoutWidth).toBeLessThanOrEqual(428);

    await clickPanelAction(browser, 'Use desktop viewport and user agent');
    await expectPanelAction(browser, 'Use mobile viewport and user agent', async toggle => {
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(toggle.locator('svg')).toHaveAttribute('data-device', 'desktop');
    });
    expect(requestedDevices.at(-1)).toBe('desktop');
    expect(await preview.locator('main').evaluate(() => window.innerWidth)).toBe(980);

    await chooseSplit(page, 'Agent output');
    await expect(output).toBeInViewport({ ratio: 0.99 });
    await expect(browser).not.toBeInViewport();
    await expect(splitTrigger).toBeVisible();

    await chooseSplit(page, 'Project browser');
    await expect(browser).toBeInViewport({ ratio: 0.99 });
    await expect(output).not.toBeInViewport();

    // a reload restores the last viewed browser split
    await page.reload();
    await expect(browser).toBeInViewport({ ratio: 0.99 });
    await expect(output).not.toBeInViewport();
    await expect(splitTrigger).toBeVisible();
  });
});
