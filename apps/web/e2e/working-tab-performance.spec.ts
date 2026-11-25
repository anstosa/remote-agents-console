import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { expectProgressBorder } from './progress-border-assertions';

// keep working motion continuous without repainting the status gradient
test('keeps working tab motion continuous with transform-only keyframes', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: '⠋ Working in Cora', attention: 'working', kind: 'codex' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', title: '⠙ Working in Delta', attention: 'working', kind: 'codex' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/echo', title: '⠹ Working in Echo', attention: 'working', kind: 'codex' }
        ],
        projects: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[1-3]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  // observe the startup cue before waiting for the first terminal paint
  const activeTabAnimations = () => tabs.evaluateAll(elements => elements.flatMap(element => element.getAnimations({ subtree: true })).length);
  await expect.poll(activeTabAnimations).toBe(3);
  await seedPaneSize(page, 'agent-1', 100, 30);
  await pushBytes(page, 'agent-1', 'Quiet output\r\n');
  await expect(page.locator('.log-loading')).toHaveCount(0);

  // cross the former three-turn cutoff while the real working controls stay mounted
  await page.waitForTimeout(6_100);
  await expect.poll(activeTabAnimations).toBe(3);
  await expectProgressBorder(tabs.first(), 'peach');
  const ring = tabs.first().locator(':scope > .update-progress-ring');
  // require a static gradient and compositor-friendly animation properties
  const border = await ring.evaluate(element => {
    const effect = element.getAnimations({ subtree: true })[0]?.effect as KeyframeEffect;
    const style = getComputedStyle(effect.target as Element, '::before');
    return { iterations: style.animationIterationCount, paint: style.backgroundImage, properties: effect.getKeyframes().map(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))) };
  });
  expect(border).toEqual({ iterations: 'infinite', paint: expect.stringContaining('conic-gradient'), properties: [['transform'], ['transform'], ['transform']] });
});

// sample rendering work without polling animation styles during the trace
async function traceWorkingFrames(page: Page) {
  const client = await page.context().newCDPSession(page);
  let paints = 0;
  let layouts = 0;
  let rasters = 0;
  let frames = 0;
  // count main-thread paint and style/layout updates, not compositor frames
  client.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) {
      if (event.name === 'Paint') paints += 1;
      // count rasterization separately from composited draws
      if (event.name === 'RasterTask') rasters += 1;
      if (event.name === 'DrawFrame') frames += 1;
      if (event.name === 'UpdateLayoutTree' || event.name === 'Layout') layouts += 1;
    }
  });
  await client.send('Tracing.start', { categories: 'devtools.timeline,cc,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReportEvents' });
  const complete = new Promise<void>(resolve => client.once('Tracing.tracingComplete', () => resolve()));
  // sample a running animation over many frames without querying computed style
  await page.waitForTimeout(1_500);
  await client.send('Tracing.end');
  await complete;
  await client.detach();
  return { paints, layouts, rasters, frames };
}

// measure browser painting while isolated status borders continue moving
test('working status borders do not repaint on every animation frame', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium tracing is required');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // isolate the production CSS from polling, terminal output and other UI motion
  await page.route('**/working-orbit-fixture', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html>
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs">${Array.from({ length: 7 }, (_, index) => `<button role="tab" class="status-working progress-border progress-peach" aria-busy="true"><span class="update-progress-ring"><span class="working-progress-mask"></span></span><span class="tab-label">Workspace ${index}</span></button>`).join('')}</nav>
    <div class="workspace-sheet-row progress-border progress-peach" style="width: 320px; height: 38px"><span class="update-progress-ring"><span class="working-progress-mask"></span></span>Working</div>
    <button class="agent-switcher-row progress-border progress-peach" style="width: 320px; height: 38px"><span class="update-progress-ring"><span class="working-progress-mask"></span></span>Working</button>
    <span class="agent-state-pill working progress-border progress-peach"><span class="update-progress-ring"><span class="working-progress-mask"></span></span>Working</span>
  ` }));
  await page.goto('/working-orbit-fixture');
  const rings = page.locator('.update-progress-ring');
  await expect(rings).toHaveCount(10);
  // give the browser time to create and rasterize the rotating layers once
  await page.waitForTimeout(1_000);
  const { paints, layouts, rasters, frames } = await traceWorkingFrames(page);
  expect(paints).toBeLessThan(5);
  expect(layouts).toBeLessThan(5);
  expect(rasters).toBeLessThan(10);
  expect(frames).toBeGreaterThan(10);
  // a quiet main thread must not mean that animation has stopped
  const active = await rings.evaluateAll(elements => elements.every(element => element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity)));
  expect(active).toBe(true);
  // sample a stable asymmetric control, including the glow outside its border
  const control = page.locator('.agent-switcher-row');
  const bounds = (await control.boundingBox())!;
  const clip = { x: bounds.x, y: bounds.y - 5, width: bounds.width + 5, height: bounds.height + 10 };
  // pause all rings so another indicator cannot affect the screenshot
  await rings.evaluateAll(elements => elements.flatMap(element => element.getAnimations({ subtree: true })).forEach(animation => {
    animation.pause();
    animation.currentTime = 0;
  }));
  const before = await page.screenshot({ clip });
  expect(await page.screenshot({ clip })).toEqual(before);
  await control.locator('.update-progress-ring').evaluate(element => { /* seek a quarter turn */ element.getAnimations({ subtree: true })[0].currentTime = 500; });
  const after = await page.screenshot({ clip });
  expect(after).not.toEqual(before);
  // disabling the outer filter removes visible glow beyond the fixed mask
  await control.locator('.update-progress-ring').evaluate(element => { /* remove only the glow */ (element as HTMLElement).style.filter = 'none'; });
  expect(await page.screenshot({ clip })).not.toEqual(after);

  // suppress the feature gate to exercise the visible legacy fallback
  const removed = await page.evaluate(() => {
    // remove only the supports block for the rotating status mask
    for (const sheet of document.styleSheets) {
      const index = Array.from(sheet.cssRules).findIndex(rule => rule instanceof CSSSupportsRule && rule.conditionText.includes('100cqmax'));
      if (index >= 0) { sheet.deleteRule(index); return true; }
    }
    return false;
  });
  expect(removed).toBe(true);
  await expect.poll(() => rings.evaluateAll(elements => elements.every(element => element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSAnimation && animation.animationName === 'update-border-orbit' && animation.playState === 'running')))).toBe(true);
  // the reference angle path must incur the repainting that the optimized path avoids
  const fallback = await traceWorkingFrames(page);
  expect(fallback.paints).toBeGreaterThanOrEqual(5);
  expect(fallback.rasters).toBeGreaterThanOrEqual(10);
});
