import { expect, test, type Locator } from '@playwright/test';

type ControlStyle = {
  backgroundColor: string;
  borderColor: string;
  color: string;
  filter: string;
};

const readStyle = async (locator: Locator): Promise<ControlStyle> => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderTopColor,
    color: style.color,
    filter: style.filter
  };
});

type CornerOffsets = { top: number; right: number };

// measure one decorator against its owning control
const cornerOffsets = async (owner: Locator, decorator: Locator): Promise<CornerOffsets> => {
  const [ownerBox, decoratorBox] = await Promise.all([owner.boundingBox(), decorator.boundingBox()]);
  // require visible controls before measuring their shared edges
  if (ownerBox === null || decoratorBox === null) throw new Error('Expected a visible toolbar control and count');
  expect(decoratorBox.y).toBeLessThan(ownerBox.y);
  expect(decoratorBox.y + decoratorBox.height).toBeGreaterThan(ownerBox.y);
  expect(decoratorBox.x).toBeLessThan(ownerBox.x + ownerBox.width);
  expect(decoratorBox.x + decoratorBox.width).toBeGreaterThan(ownerBox.x + ownerBox.width);
  return {
    top: decoratorBox.y - ownerBox.y,
    right: ownerBox.x + ownerBox.width - decoratorBox.x - decoratorBox.width
  };
};

test('uses consistent Workspace toolbar styles, tints an open panel’s button and keeps the composer send gradient', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <section class="prompt agent-composer">
      <div class="agent-composer-column">
        <button class="queue icon-button" aria-label="Queue"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"></path></svg></button>
      </div>
    </section>
    <section class="workspace-toolbar">
      <div class="workspace-toolbar-actions">
        <button class="terminal-picker-toggle toolbar-button" aria-label="Terminal"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Terminal</span></button>
        <button class="toolbar-button browser-toggle panel-open" aria-label="Browser" aria-pressed="true"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Browser</span></button>
        <button class="more icon-button" aria-label="More"></button>
        <span class="project-open-group">
          <a class="project-open status-healthy" href="#"><i></i>Open</a>
        </span>
        <span class="project-open-group has-stack-actions">
          <button class="project-stack-toggle project-stack-trigger toolbar-button" aria-label="Stack"><svg class="project-stack-server-icon" viewBox="0 0 24 24"></svg><i class="project-stack-status-dot status-healthy"></i></button>
        </span>
      </div>
    </section>
  `);

  const neutral = ['Terminal', 'More', 'Open', 'Stack'].map(name => page.getByRole(name === 'Open' ? 'link' : 'button', { name }));
  await expect.poll(async () => {
    const styles = await Promise.all(neutral.map(readStyle));
    return [
      new Set(styles.map(style => style.backgroundColor)).size,
      new Set(styles.map(style => style.borderColor)).size,
      new Set(styles.map(style => style.color)).size
    ];
  }).toEqual([1, 1, 1]);
  const neutralStyles = await Promise.all(neutral.map(readStyle));
  expect(new Set(neutralStyles.map(style => style.backgroundColor)).size).toBe(1);
  expect(new Set(neutralStyles.map(style => style.borderColor)).size).toBe(1);
  expect(new Set(neutralStyles.map(style => style.color)).size).toBe(1);

  const hoveredStyles: ControlStyle[] = [];
  for (const control of neutral) {
    await control.hover();
    await page.waitForTimeout(175);
    hoveredStyles.push(await readStyle(control));
  }
  expect(new Set(hoveredStyles.map(style => style.backgroundColor)).size).toBe(1);
  expect(new Set(hoveredStyles.map(style => style.borderColor)).size).toBe(1);
  expect(new Set(hoveredStyles.map(style => style.color)).size).toBe(1);
  expect(hoveredStyles[0].backgroundColor).not.toBe(neutralStyles[0].backgroundColor);

  // an open panel's button takes that panel's colour (the browser's blue)
  await page.mouse.move(0, 0);
  const browser = page.getByRole('button', { name: 'Browser' });
  const browserStyle = await readStyle(browser);
  expect(browserStyle.color).toBe('rgb(137, 180, 250)');
  expect(browserStyle.backgroundColor).not.toBe(neutralStyles[0].backgroundColor);

  const queue = page.getByRole('button', { name: 'Queue' });
  await expect(queue.locator('svg')).toHaveCount(1);
  const queueBounds = await queue.boundingBox();
  expect(queueBounds).not.toBeNull();
  expect(Math.abs(queueBounds!.width - queueBounds!.height)).toBeLessThanOrEqual(1);
  await expect(queue).toHaveCSS('background-image', /linear-gradient/u);
  await queue.hover();
  await page.waitForTimeout(175);
  await expect(queue).toHaveCSS('filter', 'brightness(1.08)');
});

// keep standard button counts pinned to the same corners
test('keeps terminal counts on their mobile corner anchors', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <section class="workspace-toolbar-actions">
      <button class="terminal-picker-toggle toolbar-button" aria-label="Terminal"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Terminal</span><span class="saved-prompts-count">2</span></button>
    </section>
  `);

  const terminal = page.getByRole('button', { name: 'Terminal' });
  const badge = terminal.locator('.saved-prompts-count');
  let phoneOffsets: CornerOffsets | undefined;
  // cover phones, the breakpoint edges and a wide desktop
  for (const width of [390, 600, 601, 1440]) {
    await page.setViewportSize({ width, height: 880 });
    await expect(terminal.locator('.toolbar-label')).toBeVisible({ visible: width > 600 });
    await expect(badge).toHaveCSS('position', 'absolute');
    const current = await cornerOffsets(terminal, badge);
    // compare every viewport with the original phone anchor
    phoneOffsets ??= current;
    expect(current.top).toBeCloseTo(phoneOffsets.top, 1);
    expect(current.right).toBeCloseTo(phoneOffsets.right, 1);
  }
});
