import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, pushMetadata } from './pane-stream-mock';

const targetSha = '3'.repeat(40);
const longPath = 'config/hosts/an-extremely-long-installation-specific-directory-name/compose.override.yaml';
const longSubject = 'Refactor the server update coordinator while preserving host-specific configuration, tunnel credentials, and exceptionally long workspace paths';
const longAuthor = 'A very long contributor display name from the platform engineering team';

// build realistic long commit rows
const commits = ['2', '3', '4', '5', '6', '7', '8', '9'].map((digit, index) => ({
  sha: digit.repeat(40),
  subject: `${longSubject} ${index + 1}`,
  author: longAuthor,
  authoredAt: '2026-08-27T12:00:00-07:00'
}));

// open the flagged update review
const openUpstreamUpdate = async (page: Page) => {
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector).toHaveAccessibleName(/update available/u, { timeout: 30_000 });
  await selector.click();
  await page.getByRole('group', { name: 'Current server details' }).getByRole('button', { name: 'View upstream update' }).click();
};

// install the isolated update fixture
const installUpdateFixture = async (page: Page) => {
  let advisorLaunched = false;
  let updateStarts = 0;
  await installPaneMock(page);
  // fulfill every dashboard request locally
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // reveal the modal-owned advisor after launch
    if (url.pathname === '/api/dashboard') {
      const agents = advisorLaunched ? [{ id: 'update-advisor', panel: 'terminal', pane: { paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket' }, home: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: 'Ready', queuedPromptCount: 0 }] : [];
      return route.fulfill({ json: { generation: advisorLaunched ? 2 : 1, agents, projects: [] } });
    }
    // authorize dashboard streaming
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // advertise one upstream update
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // publish the installed revision
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: '1'.repeat(40), committedAt: '2026-09-06T14:22:31-07:00' } });
    // return long review content
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: commits.length, commits, commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: [longPath, '.env.example'] }] } } });
    // launch only the mocked advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunched = true;
      return route.fulfill({ status: 201, json: { agentId: 'update-advisor', targetSha } });
    }
    // authorize advisor output
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'advisor-ticket' } });
    // return empty advisor stores
    if (/^\/api\/agents\/update-advisor\/(?:saved-prompts|prompt-history|queued-prompts|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
    // reject accidental host mutations
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 500, json: { error: 'unexpected update start' } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return {
    // expose the mutation counter
    updateStarts: () => updateStarts
  };
};

// expose mutable keyboard viewport metrics
const installVisualViewportMock = (page: Page) => page.addInitScript(() => {
  let height = window.innerHeight;
  let offsetTop = 0;
  const viewport = new EventTarget();
  Object.defineProperties(viewport, {
    height: { get: () => height },
    offsetTop: { get: () => offsetTop },
    offsetLeft: { get: () => 0 },
    pageTop: { get: () => offsetTop },
    pageLeft: { get: () => 0 },
    scale: { get: () => 1 },
    width: { get: () => window.innerWidth }
  });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  // dispatch the matching viewport events
  Object.defineProperty(window, '__setUpdateVisualViewport', {
    value: (next: { height: number; offsetTop: number }) => {
      const resized = height !== next.height;
      const scrolled = offsetTop !== next.offsetTop;
      height = next.height;
      offsetTop = next.offsetTop;
      // report keyboard resizing
      if (resized) viewport.dispatchEvent(new Event('resize'));
      // report browser panning
      if (scrolled) viewport.dispatchEvent(new Event('scroll'));
    }
  });
});

// change the emulated browser viewport
const setVisualViewport = (page: Page, height: number, offsetTop: number) => page.evaluate(metrics => {
  (window as unknown as { __setUpdateVisualViewport: (next: { height: number; offsetTop: number }) => void }).__setUpdateVisualViewport(metrics);
}, { height, offsetTop });

// read the visible and rendered bounds
const readViewportBounds = (dialog: Locator) => dialog.evaluate(element => {
  const visualViewport = window.visualViewport!;
  const overlay = element.getBoundingClientRect();
  const surface = element.firstElementChild!.getBoundingClientRect();
  const header = element.querySelector<HTMLElement>(':scope > div > header')!.getBoundingClientRect();
  const footer = element.querySelector<HTMLElement>(':scope > div > footer')!.getBoundingClientRect();
  const feedback = element.querySelector<HTMLTextAreaElement>('.update-advisor-feedback textarea')!.getBoundingClientRect();
  const close = element.querySelector<HTMLElement>('button[aria-label="Close server update"]')!;
  const send = element.querySelector<HTMLElement>('.update-advisor-feedback button')!;
  const update = element.querySelector<HTMLElement>(':scope > div > footer button')!;
  // confirm visual controls own their center points
  const ownsCenter = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    const owner = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return owner !== null && target.contains(owner);
  };
  return {
    visual: { top: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height, height: visualViewport.height },
    overlay: { top: overlay.top, bottom: overlay.bottom, height: overlay.height },
    surface: { top: surface.top, bottom: surface.bottom, height: surface.height },
    header: { top: header.top, bottom: header.bottom },
    footer: { top: footer.top, bottom: footer.bottom },
    feedback: { top: feedback.top, bottom: feedback.bottom },
    controls: { close: ownsCenter(close), send: ownsCenter(send), update: ownsCenter(update) }
  };
});

// compare one child against its container
const expectContained = async (child: ReturnType<Page['locator']>, container: ReturnType<Page['locator']>) => {
  // read both rendered rectangles together
  const bounds = await child.evaluate((element, containerElement) => {
    const childBounds = element.getBoundingClientRect();
    const containerBounds = (containerElement as Element).getBoundingClientRect();
    return {
      child: { left: childBounds.left, right: childBounds.right, top: childBounds.top, bottom: childBounds.bottom },
      container: { left: containerBounds.left, right: containerBounds.right, top: containerBounds.top, bottom: containerBounds.bottom }
    };
  }, await container.elementHandle());
  expect(bounds.child.left).toBeGreaterThanOrEqual(bounds.container.left - 1);
  expect(bounds.child.right).toBeLessThanOrEqual(bounds.container.right + 1);
};

const viewports = [
  { name: '390px portrait', width: 390, height: 844 },
  { name: '320px portrait', width: 320, height: 568 },
  { name: 'mobile landscape', width: 844, height: 390 },
  { name: 'desktop', width: 1280, height: 900 }
] as const;

// cover narrow and wide dialog layouts
for (const viewport of viewports) {
  // validate one rendered viewport
  test(`keeps the update advisor contained at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await installUpdateFixture(page);
    await page.goto('/');
    await openUpstreamUpdate(page);

    const dialog = page.getByRole('dialog', { name: 'Review update' });
    const surface = dialog.locator(':scope > div');
    const body = dialog.locator('.update-review-body');
    const advisor = dialog.locator('.update-advisor');
    const output = dialog.getByLabel('Update advisor output');
    const feedback = dialog.getByLabel('Approval or feedback');
    const acknowledgement = dialog.getByText('I reviewed the advisor guidance for this exact update.');
    const close = dialog.getByRole('button', { name: 'Close server update' });
    const update = dialog.getByRole('button', { name: 'Update', exact: true });

    await expect(dialog.getByText(commits[0].subject)).toBeVisible();
    await expect(dialog.getByText(longAuthor).first()).toBeVisible();
    await expect(dialog.getByText(longPath)).toBeVisible();
    await expect(output).toBeVisible({ timeout: 30_000 });
    // let the terminal adopt its measured viewport
    await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
    await pushMetadata(page, 'update-advisor', 'No host migration is required for this exact update.');
    await expect(acknowledgement).toBeVisible({ timeout: 30_000 });

    // keep the fixed dialog regions available
    await expect(close).toBeInViewport();
    await expect(update).toBeInViewport();
    await expectContained(surface.locator(':scope > header'), surface);
    await expectContained(surface.locator(':scope > footer'), surface);

    // prevent the scroll body and advisor from widening
    const widths = await body.evaluate(element => {
      const advisorElement = element.querySelector<HTMLElement>('.update-advisor')!;
      return {
        bodyClient: element.clientWidth,
        bodyScroll: element.scrollWidth,
        advisorClient: advisorElement.clientWidth,
        advisorScroll: advisorElement.scrollWidth
      };
    });
    expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient + 1);
    expect(widths.advisorScroll).toBeLessThanOrEqual(widths.advisorClient + 1);
    await expectContained(advisor, body);
    await expectContained(output, advisor);

    // contain the measured terminal canvas
    const terminalBounds = await output.evaluate(element => {
      const outputBounds = element.getBoundingClientRect();
      const screenBounds = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
      return { outputRight: outputBounds.right, outputBottom: outputBounds.bottom, screenRight: screenBounds.right, screenBottom: screenBounds.bottom };
    });
    expect(terminalBounds.screenRight).toBeLessThanOrEqual(terminalBounds.outputRight + 1);
    expect(terminalBounds.screenBottom).toBeLessThanOrEqual(terminalBounds.outputBottom + 1);

    // keep feedback and acknowledgement reachable
    await acknowledgement.scrollIntoViewIfNeeded();
    await expect(feedback).toBeInViewport();
    await expect(acknowledgement).toBeInViewport();
    await expectContained(feedback, body);
    await expectContained(acknowledgement, body);
    await expect(close).toBeInViewport();
    await expect(update).toBeInViewport();
    expect(fixture.updateStarts()).toBe(0);
  });
}

// follow controlled visual viewport changes
test('keeps the update review inside the panned visual viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportMock(page);
  const fixture = await installUpdateFixture(page);
  await page.goto('/');
  await openUpstreamUpdate(page);

  const dialog = page.getByRole('dialog', { name: 'Review update' });
  const feedback = dialog.getByLabel('Approval or feedback');
  const acknowledgement = dialog.getByText('I reviewed the advisor guidance for this exact update.');
  const output = dialog.getByLabel('Update advisor output');
  await expect(output).toBeVisible({ timeout: 30_000 });
  // let the terminal adopt its measured viewport
  await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
  await pushMetadata(page, 'update-advisor', 'No host migration is required for this exact update.');
  await expect(acknowledgement).toBeVisible({ timeout: 30_000 });
  await feedback.focus();
  await expect(feedback).toBeFocused();

  // model a keyboard resize plus browser pan
  await setVisualViewport(page, 430, 120);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim())).toBe('430px');
  await feedback.scrollIntoViewIfNeeded();
  const panned = await readViewportBounds(dialog);
  expect(panned.overlay.top).toBeCloseTo(panned.visual.top, 0);
  expect(panned.overlay.bottom).toBeCloseTo(panned.visual.bottom, 0);
  expect(panned.surface.top).toBeCloseTo(panned.visual.top, 0);
  expect(panned.surface.bottom).toBeCloseTo(panned.visual.bottom, 0);
  expect(panned.surface.height).toBeCloseTo(panned.visual.height, 0);
  expect(panned.header.top).toBeGreaterThanOrEqual(panned.visual.top - 1);
  expect(panned.footer.bottom).toBeLessThanOrEqual(panned.visual.bottom + 1);
  expect(panned.feedback.top).toBeGreaterThanOrEqual(panned.visual.top - 1);
  expect(panned.feedback.bottom).toBeLessThanOrEqual(panned.visual.bottom + 1);
  expect(panned.controls).toEqual({ close: true, send: true, update: true });

  // return the keyboard viewport to the layout top
  await setVisualViewport(page, 430, 0);
  const unpanned = await readViewportBounds(dialog);
  expect(unpanned.surface.top).toBeCloseTo(0, 0);
  expect(unpanned.surface.bottom).toBeCloseTo(430, 0);
  expect(unpanned.footer.bottom).toBeLessThanOrEqual(431);
  expect(unpanned.controls).toEqual({ close: true, send: true, update: true });

  // restore the unobstructed viewport
  await setVisualViewport(page, 844, 0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim())).toBe('844px');
  const restored = await readViewportBounds(dialog);
  expect(restored.surface.top).toBeCloseTo(0, 0);
  expect(restored.surface.bottom).toBeCloseTo(844, 0);
  expect(restored.header.top).toBeGreaterThanOrEqual(-1);
  expect(restored.footer.bottom).toBeLessThanOrEqual(845);
  expect(restored.controls).toEqual({ close: true, send: true, update: true });
  expect(fixture.updateStarts()).toBe(0);
});

// retain the inset tablet dialog treatment
test('contains the update review inside a panned tablet viewport', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 900 });
  await installVisualViewportMock(page);
  const fixture = await installUpdateFixture(page);
  await page.goto('/');
  await openUpstreamUpdate(page);

  const dialog = page.getByRole('dialog', { name: 'Review update' });
  const feedback = dialog.getByLabel('Approval or feedback');
  const acknowledgement = dialog.getByText('I reviewed the advisor guidance for this exact update.');
  const output = dialog.getByLabel('Update advisor output');
  await expect(output).toBeVisible({ timeout: 30_000 });
  // let the terminal adopt its measured viewport
  await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
  await pushMetadata(page, 'update-advisor', 'No host migration is required for this exact update.');
  await expect(acknowledgement).toBeVisible({ timeout: 30_000 });
  await feedback.focus();
  await expect(feedback).toBeFocused();

  // model a wide keyboard viewport
  await setVisualViewport(page, 430, 120);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim())).toBe('430px');
  await feedback.scrollIntoViewIfNeeded();
  const panned = await readViewportBounds(dialog);
  expect(panned.overlay.top).toBeCloseTo(panned.visual.top, 0);
  expect(panned.overlay.bottom).toBeCloseTo(panned.visual.bottom, 0);
  expect(panned.surface.top).toBeGreaterThan(panned.visual.top);
  expect(panned.surface.bottom).toBeLessThan(panned.visual.bottom);
  expect(panned.header.top).toBeGreaterThanOrEqual(panned.visual.top);
  expect(panned.footer.bottom).toBeLessThanOrEqual(panned.visual.bottom);
  expect(panned.feedback.top).toBeGreaterThanOrEqual(panned.visual.top);
  expect(panned.feedback.bottom).toBeLessThanOrEqual(panned.visual.bottom);
  expect(panned.controls).toEqual({ close: true, send: true, update: true });
  expect(fixture.updateStarts()).toBe(0);
});
