import { expect, test, type Locator, type Page } from '@playwright/test';

type Axis = 'both' | 'vertical';
type ViewportCase = { name: 'desktop' | 'mobile'; width: number; height: number };

const viewports: ViewportCase[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

const fixtureStyles = `
  .client-settings-page { height: 100dvh; }
  .client-settings-page-content, .settings-center { height: 100%; }
  .settings-center-layout { height: calc(100dvh - 3rem); max-height: calc(100dvh - 3rem); }
  .settings-source-nav, .settings-source-panel { height: 100%; max-height: 100%; }
  .settings-code-editor { width: min(36rem, calc(100vw - 3rem)); }
  .qa-dialog-body { height: min(68vh, 32rem); }
  .qa-dialog-content { width: 76rem; height: 58rem; padding: 1rem; }
  .qa-nested-scroll, .qa-fullscreen-log, .qa-workspace-scroll { width: min(18rem, calc(100vw - 6rem)); height: 9rem; overflow: auto; border: 1px solid var(--surface-2); }
  .qa-nested-content, .qa-fullscreen-log-content, .qa-workspace-content { width: 48rem; height: 34rem; padding: .75rem; }
  .qa-dialog-spacer { width: 76rem; height: 44rem; }
  .qa-fullscreen-content { width: 52rem; height: 54rem; padding: .75rem; }
  .qa-settings-wide { width: 88rem; height: 54rem; padding-top: 1rem; }
  .qa-settings-card { height: 6rem; margin-bottom: .5rem; border: 1px solid var(--surface-1); padding: .75rem; }
  .qa-workspace-scroll { position: fixed; inset: 1rem auto auto 1rem; background: var(--base); color: var(--text); }
`;

// build enough repeated content to force both scroll axes
function repeatedRows(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => `<div>${prefix} ${index + 1} ${'content '.repeat(18)}</div>`).join('');
}

// mount a fixture against the production stylesheets
async function mountFixture(page: Page, markup: string) {
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <link rel="stylesheet" href="/src/settings/settings.css">
    <link rel="stylesheet" href="/src/settings/code-editor.css">
    <style>${fixtureStyles}</style>
    ${markup}
  `);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mauve').trim())).toBe('#cba6f7');
}

// read rendered scrollbar and overflow geometry
async function scrollState(target: Locator) {
  return target.evaluate(element => {
    const style = getComputedStyle(element);
    const webkitScrollbar = getComputedStyle(element, '::-webkit-scrollbar');
    return {
      scrollbarWidth: style.scrollbarWidth,
      webkitDisplay: webkitScrollbar.display,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop
    };
  });
}

// prove a scoped surface hides chrome without losing overflow
async function expectHiddenScroller(target: Locator, axis: Axis = 'both') {
  const state = await scrollState(target);
  expect(state.scrollbarWidth).toBe('none');
  expect(state.webkitDisplay).toBe('none');
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  // require horizontal overflow only for two-axis fixtures
  if (axis === 'both') expect(state.scrollWidth).toBeGreaterThan(state.clientWidth);
}

// prove script-driven scrolling still reaches both requested axes
async function expectProgrammaticScroll(target: Locator, axis: Axis = 'both') {
  await target.evaluate((element, mode) => element.scrollTo({ left: mode === 'both' ? 120 : 0, top: 120 }), axis);
  const state = await scrollState(target);
  expect(state.scrollTop).toBeGreaterThan(0);
  // require horizontal movement only for two-axis fixtures
  if (axis === 'both') expect(state.scrollLeft).toBeGreaterThan(0);
}

// prove native wheel deltas still move a hidden-scrollbar surface
async function expectWheelScroll(page: Page, target: Locator, axis: Axis = 'both') {
  await target.evaluate(element => element.scrollTo(0, 0));
  await target.hover();
  await page.mouse.wheel(axis === 'both' ? 140 : 0, 180);
  await expect.poll(async () => (await scrollState(target)).scrollTop).toBeGreaterThan(0);
  // require horizontal wheel movement only for two-axis fixtures
  if (axis === 'both') await expect.poll(async () => (await scrollState(target)).scrollLeft).toBeGreaterThan(0);
}

// prove arrow and paging keys still scroll focusable overflow
async function expectKeyboardScroll(target: Locator, axis: Axis = 'both') {
  await target.evaluate(element => element.scrollTo(0, 0));
  await target.focus();
  await expect(target).toBeFocused();
  // move horizontally before paging vertically
  if (axis === 'both') await target.press('ArrowRight');
  await target.press('PageDown');
  await expect.poll(async () => (await scrollState(target)).scrollTop).toBeGreaterThan(0);
  // require horizontal keyboard movement only for two-axis fixtures
  if (axis === 'both') await expect.poll(async () => (await scrollState(target)).scrollLeft).toBeGreaterThan(0);
}

// render one generic modal with nested overflow
function dialogFixture() {
  return `
    <section class="dialog" role="dialog" aria-label="Scrollable dialog">
      <div class="qa-dialog-body" tabindex="0" data-testid="dialog-body">
        <div class="qa-dialog-content">
          <div class="qa-nested-scroll" tabindex="0" data-testid="dialog-nested">
            <div class="qa-nested-content">${repeatedRows(24, 'Nested row')}</div>
          </div>
          <div class="qa-dialog-spacer">${repeatedRows(30, 'Dialog row')}</div>
        </div>
      </div>
    </section>
  `;
}

// render the real settings navigation, content and code-editor class structure
function settingsFixture() {
  const navigation = repeatedRows(24, 'Settings page');
  const editorValue = Array.from({ length: 48 }, (_, index) => `line_${index + 1}=${'value_'.repeat(30)}`).join('\n');
  const highlighted = Array.from({ length: 48 }, (_, index) => `<span class="syntax-line"><span class="syntax-line-number">${index + 1}</span><span class="syntax-line-content">line_${index + 1}=${'value_'.repeat(30)}</span></span>`).join('');
  return `
    <section class="client-settings-page settings-center-page" aria-label="Settings fixture">
      <div class="client-settings-page-content">
        <div class="settings-center">
          <div class="settings-center-layout">
            <label class="settings-source-select">Page<select><option>Application</option></select></label>
            <nav class="settings-source-nav" tabindex="0" aria-label="Settings pages">${navigation}</nav>
            <main class="settings-source-panel" tabindex="0" aria-label="Application settings">
              <header class="settings-source-header"><div class="settings-source-heading"><small class="settings-source-kicker">Application</small><h2>Application</h2></div></header>
              <div class="settings-code-editor">
                <div class="settings-code-editor-toolbar"><span>48 lines</span></div>
                <div class="settings-code-editor-surface" style="height: 9rem">
                  <pre class="syntax-highlight-presentation" aria-hidden="true"><code>${highlighted}</code></pre>
                  <textarea wrap="off" spellcheck="false" aria-label="Application source">${editorValue}</textarea>
                </div>
              </div>
              <div class="qa-settings-wide">${repeatedRows(18, 'Setting field')}<div class="qa-settings-card">End of settings</div></div>
            </main>
          </div>
        </div>
      </div>
    </section>
  `;
}

// render the fullscreen recovery card and a nested log
function fullscreenFixture() {
  return `
    <section class="reconnecting-overlay fullscreen-loader-entered">
      <div class="fullscreen-card" tabindex="0" data-testid="fullscreen-card">
        <div class="qa-fullscreen-content">
          <strong>Restarting</strong>
          <div class="qa-fullscreen-log" tabindex="0" data-testid="fullscreen-log">
            <div class="qa-fullscreen-log-content">${repeatedRows(24, 'Recovery row')}</div>
          </div>
          ${repeatedRows(32, 'Restart detail')}
        </div>
      </div>
    </section>
  `;
}

// render one ordinary workspace scroller outside every modal scope
function workspaceFixture() {
  return `<section class="code-pane"><div class="code-pane-view qa-workspace-scroll" tabindex="0" data-testid="workspace-scroll"><div class="qa-workspace-content">${repeatedRows(24, 'Workspace row')}</div></div></section>`;
}

// verify both responsive modal layouts against the same production styles
for (const viewport of viewports) {
  test(`hides modal scrollbars while retaining ${viewport.name} scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/instance-icons/terminal.svg');
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    // capture fixture-time browser diagnostics
    page.on('console', message => message.type() === 'error' && consoleErrors.push(message.text()));
    page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

    await mountFixture(page, dialogFixture());
    const dialogBody = page.getByTestId('dialog-body');
    const dialogNested = page.getByTestId('dialog-nested');
    await expectHiddenScroller(dialogBody);
    await expectHiddenScroller(dialogNested);
    await expectProgrammaticScroll(dialogBody);
    await expectWheelScroll(page, dialogNested);
    await expectKeyboardScroll(dialogBody);

    await mountFixture(page, settingsFixture());
    const settingsNavigation = page.getByRole('navigation', { name: 'Settings pages' });
    const settingsPanel = page.getByRole('main', { name: 'Application settings' });
    const codeEditor = page.getByRole('textbox', { name: 'Application source' });
    await expectHiddenScroller(settingsPanel, 'vertical');
    await expectHiddenScroller(codeEditor);
    await expectWheelScroll(page, settingsPanel, 'vertical');
    await expectProgrammaticScroll(codeEditor);
    // desktop keeps the full navigation scroller while mobile uses its select replacement
    if (viewport.name === 'desktop') {
      await expect(settingsNavigation).toBeVisible();
      await expectHiddenScroller(settingsNavigation, 'vertical');
      await expectKeyboardScroll(settingsNavigation, 'vertical');
    } else {
      await expect(settingsNavigation).toBeHidden();
      await expect(page.locator('.settings-source-select')).toBeVisible();
    }
    await page.screenshot({ path: `/tmp/modal-scrollbars-${viewport.name}.png`, fullPage: true });

    await mountFixture(page, fullscreenFixture());
    const fullscreenCard = page.getByTestId('fullscreen-card');
    const fullscreenLog = page.getByTestId('fullscreen-log');
    await expectHiddenScroller(fullscreenCard);
    await expectHiddenScroller(fullscreenLog);
    await expectProgrammaticScroll(fullscreenCard);
    await expectWheelScroll(page, fullscreenLog);

    await mountFixture(page, workspaceFixture());
    const workspaceScroller = page.getByTestId('workspace-scroll');
    const workspaceState = await scrollState(workspaceScroller);
    expect(workspaceState.scrollbarWidth).not.toBe('none');
    expect(workspaceState.webkitDisplay).not.toBe('none');
    expect(workspaceState.scrollWidth).toBeGreaterThan(workspaceState.clientWidth);
    expect(workspaceState.scrollHeight).toBeGreaterThan(workspaceState.clientHeight);
    await expectWheelScroll(page, workspaceScroller);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
}
