import { expect, test } from '@playwright/test';

const dashboard = {
  generation: 1,
  agents: [],
  projects: [{
    id: 'potato',
    label: '🥔 Potato',
    available: true,
    manageWorktrees: true,
    worktrees: [{ id: 'potato:/potato', projectId: 'potato', label: '🥔 Cora', path: '/potato', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }]
  }]
};

// stub launcher endpoints
async function stubLauncher(page: import('@playwright/test').Page) {
  // answer launcher requests
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // return login state
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // return launcher state
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    // omit push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // return branch choices
    if (url.pathname === '/api/projects/potato/branches') return route.fulfill({ json: { branches: [{ name: 'main', ref: 'main', remote: false, checkedOut: true }], base: 'main' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// validate one responsive layout
async function verifyLauncherLabels(page: import('@playwright/test').Page, screenshotPath: string) {
  await stubLauncher(page);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.new-agent-tab').click();

  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const scratchLabel = launcher.locator('.launcher-symbol-label');
  const newWorktree = launcher.getByRole('button', { name: 'New worktree…' });
  await expect(scratchLabel).toHaveText('Scratch');
  await expect(scratchLabel.locator('.launcher-label-icon')).toBeVisible();
  await expect(scratchLabel.locator('.launcher-label-icon > svg')).toBeVisible();
  await expect(scratchLabel.locator('.launcher-label-icon')).toHaveAttribute('aria-hidden', 'true');

  // measure real browser glyph cells
  const measurements = await launcher.evaluate(element => {
    const scratch = element.querySelector<HTMLElement>('.launcher-symbol-label');
    const scratchIcon = scratch?.querySelector<HTMLElement>('.launcher-label-icon');
    const scratchText = scratch?.querySelector<HTMLElement>(':scope > span:last-child');
    const worktree = Array.from(element.querySelectorAll<HTMLElement>('.launcher-row-label')).find(label => label.textContent === '🥔 Cora');
    // require rendered comparison targets
    if (scratch === null || scratchIcon === null || scratchText === null || worktree === undefined || worktree.firstChild?.nodeType !== Node.TEXT_NODE) throw new Error('Launcher label targets did not render');
    const emojiRange = document.createRange();
    emojiRange.setStart(worktree.firstChild, 0);
    emojiRange.setEnd(worktree.firstChild, 2);
    const worktreeTextRange = document.createRange();
    worktreeTextRange.setStart(worktree.firstChild, 3);
    worktreeTextRange.setEnd(worktree.firstChild, 4);
    const scratchIconRect = scratchIcon.getBoundingClientRect();
    return {
      emojiWidth: emojiRange.getBoundingClientRect().width,
      scratchIconWidth: scratchIconRect.width,
      scratchIconHeight: scratchIconRect.height,
      scratchTextLeft: scratchText.getBoundingClientRect().left,
      worktreeTextLeft: worktreeTextRange.getBoundingClientRect().left,
      scratchFontSize: getComputedStyle(scratch).fontSize,
      worktreeFontSize: getComputedStyle(worktree).fontSize
    };
  });

  await page.screenshot({ path: screenshotPath, fullPage: true });

  // allow subpixel glyph rounding
  expect(Math.abs(measurements.scratchIconWidth - measurements.emojiWidth)).toBeLessThan(1);
  expect(Math.abs(measurements.scratchTextLeft - measurements.worktreeTextLeft)).toBeLessThan(1);
  expect(measurements.scratchFontSize).toBe(measurements.worktreeFontSize);

  await newWorktree.click();
  await expect(page.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
  return measurements;
}

// verify desktop geometry
test('launcher label icons align with emoji labels on desktop', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const measurements = await verifyLauncherLabels(page, testInfo.outputPath('launcher-label-icons-desktop.png'));
  testInfo.annotations.push({ type: 'measurements', description: JSON.stringify(measurements) });
});

// verify mobile geometry
test('launcher label icons align with emoji labels on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const measurements = await verifyLauncherLabels(page, testInfo.outputPath('launcher-label-icons-mobile.png'));
  testInfo.annotations.push({ type: 'measurements', description: JSON.stringify(measurements) });
});
