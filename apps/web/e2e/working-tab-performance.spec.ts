import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { expectBreathingProgressBorder, expectProgressBorder, expectProgressBorderGroup } from './progress-border-assertions';

// keep progress presentation bounded while terminal output and user input are active
test('paces shared progress effects through one visibility-aware presentation clock', async ({ page }) => {
  await installPaneMock(page);
  let working = true;
  let dashboardRequests = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // retain five simultaneous busy surfaces until the completion transition
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({ json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: working ? '⠋ Working in Cora' : 'Ready in Cora', attention: working ? 'working' : 'finished', kind: 'codex' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', title: working ? '⠙ Working in Delta' : 'Ready in Delta', attention: working ? 'working' : 'finished', kind: 'codex' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', title: working ? '⠹ Working in Echo' : 'Ready in Echo', attention: working ? 'working' : 'finished', kind: 'codex' },
          { id: 'agent-4', sessionId: 'socket:$4', home: '/worktrees/foxtrot', title: working ? '⠋ Working in Foxtrot' : 'Ready in Foxtrot', attention: working ? 'working' : 'finished', kind: 'codex' },
          { id: 'agent-5', sessionId: 'socket:$5', home: '/worktrees/golf', title: working ? '⠙ Working in Golf' : 'Ready in Golf', attention: working ? 'working' : 'finished', kind: 'codex' }
        ],
        projects: []
      } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize each agent stream
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide empty saved prompts
    if (/^\/api\/agents\/agent-[1-5]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  await expectProgressBorderGroup(tabs, 5, 'working');
  await expect.poll(() => tabs.evaluateAll(elements => elements.every(element => element.classList.contains('progress-status-button')))).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = (await import('/src/progress-animation.ts')).progressAnimationSnapshot();
    return { cadence: snapshot.presentationFramesPerSecond, enoughRegistered: snapshot.registeredRings >= 5, running: snapshot.running };
  })).toEqual({ cadence: 12, enoughRegistered: true, running: true });

  // retain the exact tab row, launcher and ring nodes across a real workspace switch
  const initialNodes = await page.evaluateHandle(() => ({
    launch: document.querySelector('.new-agent-tab'),
    nav: document.querySelector('nav.tabs'),
    ring: document.querySelector('#tab-0 > .update-progress-ring'),
    tab: document.querySelector('#tab-0')
  }));
  const initialGeometry = await tabs.evaluateAll(elements => elements.map(element => {
    const owner = element.getBoundingClientRect();
    const label = element.querySelector('.tab-label')!.getBoundingClientRect();
    return { label: [label.x, label.y, label.width, label.height], owner: [owner.x, owner.y, owner.width, owner.height] };
  }));
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(nodes => nodes.nav === document.querySelector('nav.tabs')
    && nodes.tab === document.querySelector('#tab-0')
    && nodes.ring === document.querySelector('#tab-0 > .update-progress-ring')
    && nodes.launch === document.querySelector('.new-agent-tab'), initialNodes)).toBe(true);
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await initialNodes.dispose();
  await expect.poll(() => tabs.evaluateAll(elements => elements.map(element => {
    const owner = element.getBoundingClientRect();
    const label = element.querySelector('.tab-label')!.getBoundingClientRect();
    return { label: [label.x, label.y, label.width, label.height], owner: [owner.x, owner.y, owner.width, owner.height] };
  }))).toEqual(initialGeometry);

  await seedPaneSize(page, 'agent-1', 100, 30);
  await pushBytes(page, 'agent-1', 'Quiet output\r\n');
  await expect(page.locator('.log-loading')).toHaveCount(0);
  await expectProgressBorder(tabs.first(), 'peach');
  await expectBreathingProgressBorder(tabs.first(), 'working');

  // sustained output shares the sparse four-hertz terminal presentation cadence
  const burst = await page.evaluate(async () => {
    const { progressAnimationSnapshot } = await import('/src/progress-animation.ts');
    const pane = (window as unknown as { __pane: { bytes: (id: string, text: string) => void; ackTotal: (id: string) => number } }).__pane;
    const before = pane.ackTotal('agent-1');
    const started = performance.now();
    let expectedBytes = 0;
    let changes = 0;
    let sparseSamples = 0;
    let lastFrame = progressAnimationSnapshot().currentFrame;
    let lastChange = started;
    let longestGap = 0;
    // generate a two-second high-volume output burst
    for (let index = 0; index < 120; index += 1) {
      const text = `live-output-${index}\r\n`;
      pane.bytes('agent-1', text);
      expectedBytes += new TextEncoder().encode(text).length;
      const target = started + (index + 1) * 1_000 / 60;
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
      const snapshot = progressAnimationSnapshot();
      // count only actual shared presentation updates
      if (snapshot.currentFrame !== lastFrame) {
        changes += 1;
        longestGap = Math.max(longestGap, performance.now() - lastChange);
        lastFrame = snapshot.currentFrame;
        lastChange = performance.now();
      }
      // measure how quickly the clock adopts the sparse contract
      if (snapshot.presentationFramesPerSecond === 4) sparseSamples += 1;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    return { actualBytes: pane.ackTotal('agent-1') - before, changes, expectedBytes, longestGap, sparseSamples };
  });
  expect(burst.actualBytes).toBe(burst.expectedBytes);
  expect(burst.sparseSamples).toBeGreaterThanOrEqual(100);
  expect(burst.changes).toBeGreaterThanOrEqual(6);
  expect(burst.changes).toBeLessThanOrEqual(10);
  expect(burst.longestGap).toBeLessThan(375);

  // pointer input keeps the same sparse budget for its bounded interaction tail
  const interaction = await page.evaluate(async () => {
    const { progressAnimationSnapshot } = await import('/src/progress-animation.ts');
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const started = performance.now();
    let previous = progressAnimationSnapshot().currentFrame;
    let changes = 0;
    let sparseSamples = 0;
    // sample across most of the one-second input lifetime
    for (let index = 0; index < 40; index += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      const snapshot = progressAnimationSnapshot();
      // count clock updates, not polling iterations
      if (snapshot.currentFrame !== previous) {
        previous = snapshot.currentFrame;
        changes += 1;
      }
      // every interaction sample should remain on the sparse budget
      if (snapshot.presentationFramesPerSecond === 4) sparseSamples += 1;
    }
    return { changes, elapsed: performance.now() - started, sparseSamples };
  });
  expect(interaction.elapsed).toBeGreaterThanOrEqual(900);
  expect(interaction.sparseSamples).toBe(40);
  expect(interaction.changes).toBeGreaterThanOrEqual(3);
  expect(interaction.changes).toBeLessThanOrEqual(5);

  // quiet presentation returns to twelve updates per second
  await expect.poll(() => page.evaluate(async () => (await import('/src/progress-animation.ts')).progressAnimationSnapshot().presentationFramesPerSecond)).toBe(12);
  const quiet = await page.evaluate(async () => {
    const { progressAnimationSnapshot } = await import('/src/progress-animation.ts');
    let previous = progressAnimationSnapshot().currentFrame;
    let changes = 0;
    // observe a half-second quiet window without driving production work
    for (let index = 0; index < 25; index += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      const frame = progressAnimationSnapshot().currentFrame;
      // count only new presentation frames
      if (frame !== previous) {
        previous = frame;
        changes += 1;
      }
    }
    return changes;
  });
  expect(quiet).toBeGreaterThanOrEqual(5);
  expect(quiet).toBeLessThanOrEqual(8);

  // hidden documents stop the one clock and leave every painted phase unchanged
  const beforeHidden = await page.evaluate(async () => ({
    phases: Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).map(element => getComputedStyle(element).getPropertyValue('--progress-phase')),
    frame: (await import('/src/progress-animation.ts')).progressAnimationSnapshot().currentFrame
  }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-progress-hidden', '');
  await expect.poll(() => page.evaluate(async () => (await import('/src/progress-animation.ts')).progressAnimationSnapshot().running)).toBe(false);
  await page.waitForTimeout(350);
  expect(await page.evaluate(async () => ({
    phases: Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).map(element => getComputedStyle(element).getPropertyValue('--progress-phase')),
    frame: (await import('/src/progress-animation.ts')).progressAnimationSnapshot().currentFrame
  }))).toEqual(beforeHidden);

  // restoring visibility resumes the clock without recreating the progress effects
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-progress-hidden');
  await expect.poll(() => page.evaluate(async () => (await import('/src/progress-animation.ts')).progressAnimationSnapshot().running)).toBe(true);
  await expect.poll(() => page.evaluate(async before => (await import('/src/progress-animation.ts')).progressAnimationSnapshot().currentFrame !== before, beforeHidden.frame)).toBe(true);

  // finishing every workspace unregisters all effects and retires the shared timer
  const requestsBeforeFinish = dashboardRequests;
  working = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => dashboardRequests).toBeGreaterThan(requestsBeforeFinish);
  await expect.poll(() => tabs.evaluateAll(elements => elements.filter(element => element.getAttribute('aria-busy') === 'true').length)).toBe(0);
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = (await import('/src/progress-animation.ts')).progressAnimationSnapshot();
    return { registered: snapshot.registeredRings, running: snapshot.running };
  })).toEqual({ registered: 0, running: false });
});
