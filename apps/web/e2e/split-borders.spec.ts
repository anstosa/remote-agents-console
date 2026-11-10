import { expect, test } from '@playwright/test';

const panels = ['note-pane', 'browser-pane', 'files-pane', 'code-pane', 'review-pane', 'stack-pane', 'github-pane', 'terminal-pane', 'client-settings-page'];

// exercise both sides of the existing mobile carousel breakpoint
for (const width of [390, 768, 769, 1440]) {
  test(`shows split borders only outside mobile at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 880 });
    // isolate style coverage from application authentication and background reads
    await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'fixture' } }));
    await page.goto('/');
    const stylesheet = process.env.RAC_E2E_PRODUCTION_POLICY === '1'
      ? await page.locator('link[rel="stylesheet"]').first().getAttribute('href')
      : '/src/styles.css';
    expect(stylesheet).not.toBeNull();
    // load actual emitted styles in production rather than an unavailable source URL
    await page.setContent(`<link rel="stylesheet" href="${stylesheet}">
      <div class="log" style="height:50vh"><div class="log-split" style="height:100%">
        ${panels.map(name => `<section class="${name}" style="padding-top:3rem"><span class="panel-header-pill">${name}</span><div class="terminal-canvas">Content</div><fieldset style="border:1px solid">Inner card</fieldset></section>`).join('')}
        <section class="note-pane editing"><span class="panel-header-pill">Editing Note</span></section>
        <section class="log-output agent-panel"><div class="agent-output">Agent content</div></section>
      </div></div>`);
    const mobile = width <= 768;
    // wait for the stylesheet before measuring every frame
    await expect(page.locator('.panel-header-pill').first()).toHaveCSS('border-top-width', '1px');
    // retain each desktop split divider while removing all mobile frame edges and inset shadows
    for (const name of panels) {
      const panel = page.locator(`.log-split > .${name}:not(.editing)`);
      // leave internal cards and control outlines alone
      await expect(panel.locator('fieldset')).toHaveCSS('border-top-width', '1px');
      await expect(panel).toHaveCSS('border-left-width', mobile ? '0px' : '1px');
      // desktop accent layouts remain unchanged
      if (!mobile) continue;
      const edges = await panel.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.boxShadow];
      });
      expect(edges, name).toEqual(['0px', '0px', '0px', '0px', 'none']);
    }
    // editing has a stronger container-rule accent than the base note state
    const editingEdges = await page.locator('.note-pane.editing').evaluate(element => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.boxShadow];
    });
    // mobile overrides the editing accent without changing its desktop treatment
    if (mobile) expect(editingEdges).toEqual(['0px', '0px', '0px', '0px', 'none']);
    else {
      expect(editingEdges[0]).toBe('1px');
      expect(editingEdges[3]).toBe('0px');
      expect(editingEdges[4]).not.toBe('none');
    }
    // input footers do not reintroduce split separators on mobile
    await expect(page.locator('.agent-output')).toHaveCSS('border-bottom-width', mobile ? '0px' : '1px');
    await expect(page.locator('.terminal-pane > .terminal-canvas')).toHaveCSS('border-bottom-width', mobile ? '0px' : '1px');
    await page.screenshot({ path: testInfo.outputPath(`split-borders-${width}.png`) });
  });
}
