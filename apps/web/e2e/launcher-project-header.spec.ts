import { expect, test } from '@playwright/test';

// cover compact and wide launcher layouts
for (const width of [360, 1280]) {
  // keep project names flexible and stale controls compact on every row
  test(`project headers keep prune and New worktree… at the right edge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const projects = [
      { id: 'short', label: 'Short', stalePaths: ['/short/gone', '/short/orphan'] },
      { id: 'long', label: 'VeryLongUnbrokenProjectNameThatMustNotPushThePruneControlOffscreen', stalePaths: ['/long/gone'] },
      { id: 'clean', label: 'AnotherVeryLongUnbrokenProjectNameWithoutAnyStaleWorktrees', stalePaths: [] }
    ];
    // isolate layout checks from live projects and destructive actions
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      // supply one authenticated browser session
      if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
      // expose names with and without stale controls
      if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: projects.map(project => ({ ...project, available: true, manageWorktrees: true, worktrees: [] })) } });
      return route.fulfill({ json: {} });
    });
    await page.goto('/');
    await page.locator('.new-agent-tab').click();
    const launcher = page.getByRole('group', { name: 'Agent launcher' });
    await expect(launcher).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // measure actual painted boxes after fonts and the flyout settle
    for (const project of projects) {
      const header = launcher.getByRole('group', { name: project.label, exact: true }).locator('.launcher-project-header');
      await expect(header.locator(':scope > span')).toHaveText(project.label);
      // compare each label and action with the header's usable content width
      const geometry = await header.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const label = element.querySelector('span')!.getBoundingClientRect();
        const prune = element.querySelector('.launcher-prune')?.getBoundingClientRect();
        const add = element.querySelector('.launcher-new-worktree')!.getBoundingClientRect();
        const contentLeft = bounds.left + parseFloat(style.paddingLeft);
        const contentRight = bounds.right - parseFloat(style.paddingRight);
        return {
          contentLeft, contentRight, gap: parseFloat(style.columnGap),
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          label: { left: label.left, right: label.right, width: label.width },
          prune: prune === undefined ? undefined : { left: prune.left, right: prune.right, width: prune.width },
          add: { left: add.left, right: add.right }
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(geometry.label.width).toBeGreaterThan(0);
      expect(Math.abs(geometry.label.left - geometry.contentLeft)).toBeLessThanOrEqual(1);
      // New worktree… is the header's last control, flush with its right edge
      expect(Math.abs(geometry.add.right - geometry.contentRight)).toBeLessThanOrEqual(1);
      const labelRight = (geometry.prune?.left ?? geometry.add.left) - geometry.gap;
      expect(Math.abs(geometry.label.right - labelRight)).toBeLessThanOrEqual(1);
      // stale controls stay compact just before New worktree… without squeezing the name
      if (geometry.prune !== undefined) {
        expect(Math.abs(geometry.prune.right - (geometry.add.left - geometry.gap))).toBeLessThanOrEqual(1);
        expect(geometry.prune.width).toBeLessThan((geometry.contentRight - geometry.contentLeft) / 2);
        expect(geometry.label.right).toBeLessThan(geometry.prune.left);
      }
    }

    // the compact control still opens the existing confirmation without pruning
    await launcher.getByRole('button', { name: '2 stale · Prune', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('/short/gone', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}
