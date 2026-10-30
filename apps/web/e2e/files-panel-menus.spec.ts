import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { installFilesFixture, type FilesFixture } from './files-panel-fixture.js';

// open one authenticated worktree files fixture
async function openFiles(page: Page): Promise<{ fixture: FilesFixture; panel: Locator }> {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('grid')).toBeVisible();
  return { fixture, panel };
}

// find one file row by its exact activation button
const fileRow = (panel: Locator, name: string): Locator => panel.locator('.files-row').filter({ hasText: name });

test('row actions target only their row while selected-row context actions target the selection', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const hidden = fileRow(panel, '.hidden');
  const alpha = fileRow(panel, 'alpha.txt');
  await hidden.locator('[data-label="Owner"]').click();
  await alpha.locator('[data-label="Owner"]').click({ modifiers: ['Control'] });

  // Space on another row's overflow opens it without changing selection
  const zetaActions = fileRow(panel, 'zeta.bin').getByRole('button', { name: 'Actions for zeta.bin' });
  await zetaActions.focus();
  await zetaActions.press('Space');
  await expect(page.getByRole('menu', { name: 'Actions for zeta.bin' })).toBeVisible();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(fileRow(panel, 'zeta.bin')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Escape');

  // the trailing row menu ignores the wider selection
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  const rowMenu = page.getByRole('menu', { name: 'Actions for alpha.txt' });
  await expect(rowMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible();
  await expect(rowMenu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await rowMenu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const oneDelete = page.getByRole('dialog', { name: 'Permanently delete' });
  await expect(oneDelete).toContainText('alpha.txt');
  await expect(oneDelete).not.toContainText('.hidden');
  const rowPrepared = fixture.records.findLast(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'delete');
  expect(rowPrepared?.body).toEqual({ kind: 'delete', sourceTokens: ['object-token:alpha.txt:00000000'] });
  await oneDelete.getByRole('button', { name: 'Cancel' }).click();

  // right-clicking one selected row scopes actions to the whole selection
  await alpha.locator('[data-label="Owner"]').click({ button: 'right' });
  const selectedMenu = page.getByRole('menu', { name: 'Actions for 2 selected items' });
  await expect(selectedMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toHaveCount(0);
  await expect(selectedMenu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await selectedMenu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const selectedDelete = page.getByRole('dialog', { name: 'Permanently delete' });
  await expect(selectedDelete).toContainText('.hidden');
  await expect(selectedDelete).toContainText('alpha.txt');
  await selectedDelete.getByRole('button', { name: 'Delete 2' }).click();
  const prepared = fixture.records.findLast(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'delete');
  expect(prepared?.body).toEqual({ kind: 'delete', sourceTokens: ['object-token:.hidden:00000000', 'object-token:alpha.txt:00000000'] });
});

test('non-selected and blank-area context menus preserve selection and use exact copy scopes', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const hidden = fileRow(panel, '.hidden');
  const alpha = fileRow(panel, 'alpha.txt');
  const zeta = fileRow(panel, 'zeta.bin');
  await hidden.locator('[data-label="Owner"]').click();
  await alpha.locator('[data-label="Owner"]').click({ modifiers: ['Control'] });

  // one non-selected row is the action target without replacing selection
  await zeta.locator('[data-label="Owner"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for zeta.bin' }).getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(zeta).toHaveAttribute('aria-selected', 'false');

  // blank grid chrome exposes only the canonical current-directory actions
  await panel.locator('.files-grid').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 500 })));
  const folderMenu = page.getByRole('menu', { name: 'Current folder actions' });
  await folderMenu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  const prepared = fixture.records.findLast(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'copy');
  expect(prepared?.body).toEqual({ kind: 'copy', sourceTokens: ['object-token:zeta.bin:00000000'], destinationDirectoryToken: 'directory:/home/ubuntu/project' });
});

test('folder menu mutations exchange the clicked directory capability before targeting it', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const sub = fileRow(panel, 'sub');
  await sub.locator('[data-label="Owner"]').click({ button: 'right' });
  const subMenu = page.getByRole('menu', { name: 'Actions for sub' });
  await expect(subMenu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(subMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toHaveCount(0);
  await expect(subMenu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await subMenu.getByRole('menuitem', { name: 'New file here', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create file' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('scoped.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const exchange = fixture.records.findLast(record => record.path.endsWith('/files/list') && (record.body as { objectToken?: string } | undefined)?.objectToken !== undefined);
  expect(exchange?.body).toEqual({ path: '/home/ubuntu/project/sub', objectToken: 'object-token:sub:00000000' });
  const prepared = fixture.records.findLast(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'create-file');
  expect(prepared?.body).toEqual({ kind: 'create-file', name: 'scoped.txt', destinationDirectoryToken: 'directory:/home/ubuntu/project/sub' });
});

test('header flyouts dismiss cleanly and stay inside the viewport', async ({ page }) => {
  const { panel } = await openFiles(page);
  const newButton = panel.getByRole('button', { name: 'New', exact: true });
  await newButton.click();
  const createMenu = page.getByRole('menu', { name: 'New file or folder' });
  const newFile = createMenu.getByRole('menuitem', { name: 'New file', exact: true });
  const newFolder = createMenu.getByRole('menuitem', { name: 'New folder', exact: true });
  await expect(newFile).toBeVisible();
  await expect(newFolder).toBeVisible();
  await expect(newFile).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(newFolder).toBeFocused();
  await page.keyboard.press('Home');
  await expect(newFile).toBeFocused();
  await page.keyboard.press('End');
  await expect(newFolder).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(createMenu).toBeHidden();
  await expect(newButton).toBeFocused();

  await panel.getByRole('button', { name: 'New', exact: true }).click();
  await page.locator('.flyout-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(createMenu).toBeHidden();

  const zetaActions = fileRow(panel, 'zeta.bin').getByRole('button', { name: 'Actions for zeta.bin' });
  await zetaActions.click();
  const rowMenu = page.getByRole('menu', { name: 'Actions for zeta.bin' });
  const box = await rowMenu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press('Escape');
  await expect(zetaActions).toBeFocused();
});

// keep favorite status tied to the current folder rather than flyout visibility
test('favorites menu adds the current directory first and opens saved folders and files', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const favoritesButton = panel.getByRole('button', { name: 'Favorites', exact: true });
  const star = favoritesButton.locator('svg');
  await expect(star).toHaveCSS('fill', 'none');
  await favoritesButton.click();
  let favoritesMenu = page.getByRole('menu', { name: 'Favorites' });
  await favoritesMenu.getByRole('menuitem', { name: 'Add current', exact: true }).click();
  expect(fixture.records.find(record => record.path === '/api/worktrees/cora/file-favorites' && record.method === 'PUT')?.body).toEqual({ objectToken: 'object-token:directory:/home/ubuntu/project' });
  await expect(star).not.toHaveCSS('fill', 'none');
  await favoritesButton.click();
  favoritesMenu = page.getByRole('menu', { name: 'Favorites' });
  await expect(favoritesMenu.getByRole('menuitem').first()).toHaveText('Remove current');
  await expect(favoritesMenu.locator('.files-favorite-menu-row').getByRole('button', { name: /remove/i })).toHaveCount(0);
  // opening and dismissing favorites does not clear the current-folder marker
  await page.keyboard.press('Escape');
  await expect(star).not.toHaveCSS('fill', 'none');
  await favoritesButton.click();
  await favoritesMenu.getByRole('menuitem', { name: 'Remove current', exact: true }).click();
  await expect.poll(() => fixture.records.some(record => record.path === '/api/worktrees/cora/file-favorites/favorite-record-0001' && record.method === 'DELETE')).toBe(true);
  await expect(star).toHaveCSS('fill', 'none');

  await panel.getByRole('button', { name: 'sub', exact: true }).click();
  await panel.getByRole('button', { name: 'Favorites', exact: true }).click();
  favoritesMenu = page.getByRole('menu', { name: 'Favorites' });
  await favoritesMenu.getByRole('menuitem', { name: 'Add current', exact: true }).click();
  await expect(star).not.toHaveCSS('fill', 'none');
  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(star).toHaveCSS('fill', 'none');
  await panel.getByRole('button', { name: 'Favorites', exact: true }).click();
  favoritesMenu = page.getByRole('menu', { name: 'Favorites' });
  await favoritesMenu.getByRole('menuitem', { name: 'sub', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Absolute path' })).toHaveValue('/home/ubuntu/project/sub');
  await expect(star).not.toHaveCSS('fill', 'none');

  // remove a saved folder only after navigating to it
  await favoritesButton.click();
  await favoritesMenu.getByRole('menuitem', { name: 'Remove current', exact: true }).click();
  await expect.poll(() => fixture.records.some(record => record.path === '/api/worktrees/cora/file-favorites/favorite-record-0002' && record.method === 'DELETE')).toBe(true);
  await expect(star).toHaveCSS('fill', 'none');

  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await fileRow(panel, 'alpha.txt').getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  const favoritePuts = fixture.records.filter(record => record.path === '/api/worktrees/cora/file-favorites' && record.method === 'PUT');
  expect(favoritePuts.at(-1)?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
  await panel.getByRole('button', { name: 'Favorites', exact: true }).click();
  favoritesMenu = page.getByRole('menu', { name: 'Favorites' });
  await expect(star).toHaveCSS('fill', 'none');
  await expect(favoritesMenu.locator('.files-favorite-menu-row').getByRole('button', { name: /remove/i })).toHaveCount(0);
  await favoritesMenu.getByRole('menuitem', { name: 'alpha.txt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'File preview' }).getByText('outside root preview')).toBeVisible();
});

// keep native text selection out of range-selection gestures only
test('Shift-click ranges do not create native text selection on rows or file names', async ({ page }) => {
  const { panel } = await openFiles(page);
  const hidden = fileRow(panel, '.hidden');
  const alpha = fileRow(panel, 'alpha.txt');
  const zeta = fileRow(panel, 'zeta.bin');
  // seed the native caret that browsers ordinarily extend on Shift-click
  const seedCaret = async (cell: Locator) => cell.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await hidden.locator('[data-label="Owner"]').click();
  await seedCaret(hidden.locator('[data-label="Owner"]'));
  await zeta.locator('[data-label="Owner"]').click({ modifiers: ['Shift'] });
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(zeta).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

  // modified filename clicks still select without opening Code or highlighting text
  await alpha.locator('[data-label="Owner"]').click();
  await seedCaret(alpha.locator('[data-label="Owner"]'));
  await hidden.getByRole('button', { name: '.hidden', exact: true }).click({ modifiers: ['Shift'] });
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(zeta).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('region', { name: 'File preview' })).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

  // unmodified metadata selection remains available for copying
  await alpha.locator('[data-label="Owner"]').dblclick({ position: { x: 15, y: 10 } });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('ubuntu');
});

test('desktop columns sort in both directions and Shift uses the rendered order', async ({ page }) => {
  const { panel } = await openFiles(page);
  const rows = panel.locator('.files-row');
  // read the current rendered filename order
  const names = (): Promise<string[]> => rows.locator('.files-name').allTextContents();
  await expect(panel.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  expect(await names()).toEqual(['sub', '.hidden', 'alpha.txt', 'zeta.bin']);

  await panel.getByRole('button', { name: 'Sort by Name' }).click();
  await expect(panel.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
  expect(await names()).toEqual(['sub', 'zeta.bin', 'alpha.txt', '.hidden']);
  await panel.getByRole('button', { name: 'Sort by Owner' }).click();
  await expect(panel.getByRole('columnheader', { name: 'Owner' })).toHaveAttribute('aria-sort', 'ascending');
  expect(await names()).toEqual(['sub', '.hidden', 'alpha.txt', 'zeta.bin']);
  await panel.getByRole('button', { name: 'Sort by Permissions' }).click();
  await expect(panel.getByRole('columnheader', { name: 'Permissions' })).toHaveAttribute('aria-sort', 'ascending');
  await panel.getByRole('button', { name: 'Sort by Modified' }).click();
  await expect(panel.getByRole('columnheader', { name: 'Modified' })).toHaveAttribute('aria-sort', 'ascending');
  await panel.getByRole('button', { name: 'Sort by Size' }).click();
  await panel.getByRole('button', { name: 'Sort by Size' }).click();
  await expect(panel.getByRole('columnheader', { name: 'Size' })).toHaveAttribute('aria-sort', 'descending');
  expect(await names()).toEqual(['sub', 'zeta.bin', 'alpha.txt', '.hidden']);

  await fileRow(panel, 'zeta.bin').locator('[data-label="Owner"]').click();
  await fileRow(panel, '.hidden').locator('[data-label="Owner"]').click({ modifiers: ['Shift'] });
  await expect(fileRow(panel, 'zeta.bin')).toHaveAttribute('aria-selected', 'true');
  await expect(fileRow(panel, 'alpha.txt')).toHaveAttribute('aria-selected', 'true');
  await expect(fileRow(panel, '.hidden')).toHaveAttribute('aria-selected', 'true');
  await expect(fileRow(panel, 'sub')).toHaveAttribute('aria-selected', 'false');
});
