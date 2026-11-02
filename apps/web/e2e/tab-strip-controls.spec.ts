import { expect, test } from '@playwright/test';

// align outlined tab-strip controls with the shared control height
test('keeps phone icon controls square and aligned with the workspace tab', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs workspace-dropdown-row" role="tablist">
      <div class="tab-row-lead">
        <button class="server-switcher-button server-selector" aria-label="Switch server"><img src="/instance-icons/terminal.svg" alt=""><span class="server-selector-name">Server</span><svg class="server-selector-chevron" viewBox="0 0 24 24"></svg><i class="server-switcher-attention working"></i></button>
        <button class="server-switcher-button server-switcher-voice" aria-label="Call"><svg viewBox="0 0 24 24"></svg><span>Call</span></button>
      </div>
      <button class="workspace-dropdown active" role="tab" aria-selected="true"><span class="tab-kind-stack"><span class="tab-place-mark">◈</span></span><span class="workspace-dropdown-label">Workspace</span><svg class="workspace-dropdown-chevron" viewBox="0 0 24 24"></svg></button>
      <span class="launcher"><button class="new-agent-tab" aria-label="Launch agent"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></button></span>
      <span class="server-switcher-settings-wrap"><button class="server-switcher-button server-switcher-settings" aria-label="Settings"><svg viewBox="0 0 24 24"></svg></button></span>
    </nav>
  `);
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = [page.getByRole('button', { name: 'Switch server' }), page.getByRole('button', { name: 'Call' }), page.getByRole('button', { name: 'Settings' }), page.getByRole('button', { name: 'Launch agent' })];
  const tab = page.getByRole('tab', { name: /Workspace/u });
  const tabBox = await tab.boundingBox();
  expect(tabBox).not.toBeNull();
  // compare the visible buttons rather than their layout wrappers
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(41.6, 1);
    expect(box!.height).toBeCloseTo(41.6, 1);
    expect(box!.y).toBeCloseTo(tabBox!.y, 1);
    // the server icon alone is edge-to-edge, unlike the outlined peer controls
    await expect(control).toHaveCSS('border-top-width', control === controls[0] ? '0px' : '1px');
    await expect(control).not.toHaveCSS('border-radius', '0px');
  }
  expect(tabBox!.height).toBeCloseTo(41.6, 1);
  const phoneNav = await page.locator('.tabs').boundingBox();
  // balance the two left controls against launch and settings on the right
  expect(tabBox!.x + tabBox!.width / 2).toBeCloseTo(phoneNav!.x + phoneNav!.width / 2, 1);
  expect((await controls[2].boundingBox())!.x).toBeGreaterThan((await controls[3].boundingBox())!.x);
  await expect(tab).toHaveCSS('border-top-width', '1px');
  // preserve the server status dot inset
  const [serverBox, serverDotBox] = await Promise.all([controls[0].boundingBox(), controls[0].locator('.server-switcher-attention').boundingBox()]);
  expect(serverDotBox!.y - serverBox!.y).toBeCloseTo(4, 1);
  expect(serverBox!.x + serverBox!.width - serverDotBox!.x - serverDotBox!.width).toBeCloseTo(4, 1);
  // keep the outlined row inside a narrow viewport
  expect(await page.locator('.tabs').evaluate(nav => nav.scrollWidth <= nav.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopTab = await tab.boundingBox();
  const [settingsBox, plusBox] = await Promise.all([controls[2].boundingBox(), controls[3].boundingBox()]);
  expect(desktopTab).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(plusBox).not.toBeNull();
  expect(settingsBox!.height).toBeCloseTo(desktopTab!.height, 1);
  expect(plusBox!.height).toBeCloseTo(desktopTab!.height, 1);
  expect(settingsBox!.width).toBeCloseTo(settingsBox!.height, 1);
  expect(plusBox!.width).toBeCloseTo(plusBox!.height, 1);
  const desktopNav = await page.locator('.tabs').boundingBox();
  expect(settingsBox!.x + settingsBox!.width).toBeCloseTo(desktopNav!.x + desktopNav!.width - 6, 1);

  await page.setViewportSize({ width: 390, height: 844 });
  const withCallTab = await tab.boundingBox();
  const callBox = await controls[1].boundingBox();
  const leadGap = await page.locator('.tab-row-lead').evaluate(element => Number.parseFloat(getComputedStyle(element).gap));
  // removing Davo gives its entire button slot to the Workspace dropdown
  await page.getByRole('button', { name: 'Call' }).evaluate(button => button.remove());
  const noCallTab = await tab.boundingBox();
  expect(noCallTab!.width - withCallTab!.width).toBeCloseTo(callBox!.width + leadGap, 1);
  expect(noCallTab!.x + noCallTab!.width).toBeCloseTo(withCallTab!.x + withCallTab!.width, 1);
  expect(noCallTab!.x).toBeCloseTo(serverBox!.x + serverBox!.width + leadGap, 1);

  // keep enrollment visible below the expanded control row
  await page.locator('.launcher').evaluate(element => element.insertAdjacentHTML('beforebegin', '<button class="notification-control">Enable alerts</button>'));
  const enrollment = await page.locator('.notification-control').boundingBox();
  const enrollmentTab = await tab.boundingBox();
  expect(enrollment!.y).toBeGreaterThanOrEqual(enrollmentTab!.y + enrollmentTab!.height);
  expect(enrollmentTab!.x).toBeCloseTo(noCallTab!.x, 1);
  expect(enrollmentTab!.width).toBeCloseTo(noCallTab!.width, 1);
  // a long Workspace name truncates rather than wrapping settings onto its own row
  await page.locator('.workspace-dropdown-label').evaluate(label => { label.textContent = 'Workspace for the Remote Agent Console long branch'; });
  expect((await controls[2].boundingBox())!.y).toBeCloseTo((await tab.boundingBox())!.y, 1);
  expect((await tab.boundingBox())!.width).toBeCloseTo(noCallTab!.width, 1);

  // keep denied status on the second row too
  await page.locator('.notification-control').evaluate(element => { element.outerHTML = '<span class="notification-status">Alerts blocked</span>'; });
  const blocked = await page.locator('.notification-status').boundingBox();
  const blockedTab = await tab.boundingBox();
  expect(blocked!.y).toBeGreaterThanOrEqual(blockedTab!.y + blockedTab!.height);
  expect(blockedTab!.x).toBeCloseTo(noCallTab!.x, 1);
  expect(blockedTab!.width).toBeCloseTo(noCallTab!.width, 1);
});

// keep neutral icon paint aligned across the tab, prompt and workspace controls
test('uses the same icon and border grays for enabled and disabled controls', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs"><div class="tab-row-lead"><button class="server-switcher-button server-switcher-voice" aria-label="Call"><svg viewBox="0 0 24 24"></svg></button></div><span class="launcher"><button class="new-agent-tab" aria-label="Launch agent"><svg viewBox="0 0 24 24"></svg></button></span><span class="server-switcher-settings-wrap"><button class="server-switcher-button server-switcher-settings" aria-label="Settings"><svg viewBox="0 0 24 24"></svg></button></span></nav>
    <section class="agent-composer-column"><button class="attachment-button icon-button" aria-label="Attach files"><svg viewBox="0 0 24 24"></svg></button></section>
    <section class="workspace-toolbar-actions"><button class="toolbar-button" aria-label="Open a terminal"><svg viewBox="0 0 24 24"></svg></button><button class="more icon-button" aria-label="More options"><svg viewBox="0 0 24 24"></svg></button></section>
  `);
  const controls = page.getByRole('button', { name: /^(Call|Launch agent|Settings|Attach files|Open a terminal|More options)$/u });
  // compare actual computed icon and outline colors rather than palette names
  await expect.poll(async () => controls.evaluateAll(elements => new Set(elements.map(element => {
    const style = getComputedStyle(element);
    return `${style.color}/${style.borderTopColor}`;
  })).size)).toBe(1);
  const enabledPaint = await controls.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { icon: style.color, border: style.borderTopColor };
  }));
  expect(enabledPaint).toHaveLength(6);
  expect(enabledPaint).toEqual(Array.from({ length: 6 }, () => enabledPaint[0]));

  // the plus button hovers like its neutral peers rather than becoming a gradient
  await controls.first().hover();
  const hoveredPaint = await controls.first().evaluate(element => {
    const style = getComputedStyle(element);
    return { icon: style.color, border: style.borderTopColor, background: style.backgroundColor };
  });
  expect(hoveredPaint.icon).not.toBe(enabledPaint[0].icon);
  expect(hoveredPaint.border).not.toBe(enabledPaint[0].border);
  for (const control of await controls.all()) {
    await control.hover();
    await expect(control).toHaveCSS('border-top-color', hoveredPaint.border);
    await expect(control).toHaveCSS('color', hoveredPaint.icon);
    await expect(control).toHaveCSS('background-color', hoveredPaint.background);
    await expect(control).toHaveCSS('background-image', 'none');
  }

  // disabling each icon control preserves its neutral paint and dims it equally
  await page.mouse.move(0, 0);
  await controls.evaluateAll(elements => elements.forEach(element => { (element as HTMLButtonElement).disabled = true; }));
  await expect.poll(async () => controls.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { icon: style.color, border: style.borderTopColor, opacity: style.opacity };
  }))).toEqual(enabledPaint.map(paint => ({ ...paint, opacity: '0.45' })));
  // disabled controls stay gray when hovered
  for (const [index, control] of (await controls.all()).entries()) {
    await control.hover({ force: true });
    await expect(control).toHaveCSS('color', enabledPaint[index].icon);
    await expect(control).toHaveCSS('border-top-color', enabledPaint[index].border);
    await expect(control).toHaveCSS('background-image', 'none');
  }
});
