import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { installFilesFixture } from './files-panel-fixture.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// preserve touch selection inside the standard horizontally scrollable table
test('opens Files from Workspace More options and toggles multiple row bodies', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: 'Files' })).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel).toBeInViewport({ ratio: 0.9 });
  const hidden = panel.locator('.files-row').filter({ hasText: '.hidden' });
  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  const grid = panel.getByRole('grid');
  const header = grid.locator('.files-grid-head');
  await expect(header).toBeVisible();
  await expect(header.getByRole('columnheader')).toHaveCount(6);
  await expect(panel.getByRole('toolbar', { name: 'Sort files' })).toHaveCount(0);
  // keep metadata in aligned columns rather than wrapping it into cards
  const layout = await hidden.evaluate(row => {
    // measure the data cells in this row
    const cells = Array.from(row.children).map(cell => cell.getBoundingClientRect());
    // compare against the shared header columns
    const headers = Array.from(row.parentElement!.querySelector('.files-grid-head')!.children).map(cell => cell.getBoundingClientRect());
    return {
      // every cell stays on the same visual line
      centers: cells.map(cell => cell.top + cell.height / 2),
      // header and body share each column boundary
      aligned: cells.every((cell, index) => Math.abs(cell.left - headers[index]!.left) <= 1 && Math.abs(cell.width - headers[index]!.width) <= 1)
    };
  });
  expect(Math.max(...layout.centers) - Math.min(...layout.centers)).toBeLessThanOrEqual(1);
  expect(layout.aligned).toBe(true);
  // constrain horizontal overflow to the grid
  expect(await grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  // expose the complete final column through table-only horizontal scrolling
  await grid.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(header.getByRole('columnheader', { name: 'Actions', exact: true })).toBeInViewport({ ratio: .95 });
  await expect(alpha.getByRole('button', { name: 'Actions for alpha.txt', exact: true })).toBeInViewport({ ratio: .95 });
  // retain date and accessible object type metadata
  await expect(hidden.locator('[data-label="Modified"]')).toBeVisible();
  await expect(hidden.getByRole('img', { name: 'file', exact: true })).toBeVisible();
  await hidden.locator('[data-label="Owner"]').tap();
  await alpha.locator('[data-label="Owner"]').tap();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await hidden.locator('[data-label="Owner"]').tap();
  await expect(hidden).toHaveAttribute('aria-selected', 'false');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  // table scrolling must not create horizontal page overflow
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(toolbar.getByRole('group', { name: 'Panels' }).locator('.files-dot')).toHaveAttribute('data-current', 'true');
  // keep a boundary swipe inside the table on narrow phones
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(panel).toBeInViewport({ ratio: .95 });
  await grid.evaluate(element => { element.scrollLeft = 0; });
  const bounds = (await grid.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  // verify native browser scroll ownership
  try {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 60, y: bounds.y + 75 }] });
    // let the browser own the horizontal touch gesture
    for (let step = 1; step <= 12; step += 1) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + 60 + step * 15, y: bounds.y + 75 }] });
      await page.waitForTimeout(16);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // allow native fling and carousel snap to settle before checking containment
    await page.waitForTimeout(400);
    await expect(panel).toBeInViewport({ ratio: .95 });
    await expect(toolbar.getByRole('group', { name: 'Panels' }).locator('.files-dot')).toHaveAttribute('data-current', 'true');
  } finally {
    // release browser control after the gesture
    await touch.detach();
  }
});

test('file-name taps open Preview and back returns to Files in the carousel', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: 'Files' });
  await files.getByRole('button', { name: 'alpha.txt', exact: true }).tap();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview).toBeInViewport({ ratio: 0.9 });
  await preview.getByRole('button', { name: '‹ Files' }).tap();
  await expect(files).toBeInViewport({ ratio: 0.9 });
});

test('file-name taps reveal Preview beside an already-mounted off-screen Code panel', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // mount Code first, then leave it off-screen behind Files
  await toolbar.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeInViewport({ ratio: 0.9 });
  await toolbar.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files).toBeInViewport({ ratio: 0.9 });
  await files.getByRole('button', { name: 'alpha.txt', exact: true }).tap();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview).toBeInViewport({ ratio: 0.9 });
  await expect(preview.getByText('outside root preview')).toBeVisible();
});

// use the same column-header sorting controls on phones
test('mobile table headers retain directories above files in descending order', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: 'Files' });
  const grid = files.getByRole('grid');
  const sort = grid.getByRole('button', { name: 'Sort by Size', exact: true });
  await expect(sort).toBeVisible();
  await sort.tap();
  await sort.tap();
  const names = await files.locator('.files-row .files-name').allTextContents();
  expect(names).toEqual(['sub', 'zeta.bin', 'alpha.txt', '.hidden']);
  await expect(grid.getByRole('columnheader', { name: 'Sort by Size', exact: true })).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
