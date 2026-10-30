import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { installFilesFixture } from './files-panel-fixture.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

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
  // mobile rows retain date and accessible object type metadata
  await expect(hidden.locator('[data-label="Modified"]')).toBeVisible();
  await expect(hidden.getByRole('img', { name: 'file', exact: true })).toBeVisible();
  await hidden.locator('[data-label="Owner"]').tap();
  await alpha.locator('[data-label="Owner"]').tap();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await hidden.locator('[data-label="Owner"]').tap();
  await expect(hidden).toHaveAttribute('aria-selected', 'false');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  // compact rows do not force horizontal page overflow
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(toolbar.getByRole('group', { name: 'Panels' }).locator('.files-dot')).toHaveAttribute('data-current', 'true');
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

test('mobile sort controls retain directories above files in descending order', async ({ page }) => {
  await installPaneMock(page);
  await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: 'Files' });
  const sort = files.getByRole('toolbar', { name: 'Sort files' });
  await expect(sort).toBeVisible();
  await sort.getByRole('button', { name: 'Sort by Size' }).tap();
  await sort.getByRole('button', { name: 'Sort by Size' }).tap();
  const names = await files.locator('.files-row .files-name').allTextContents();
  expect(names).toEqual(['sub', 'zeta.bin', 'alpha.txt', '.hidden']);
  await expect(sort.getByRole('button', { name: 'Sort by Size' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
