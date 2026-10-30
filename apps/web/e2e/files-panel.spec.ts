import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { installFilesFixture } from './files-panel-fixture.js';

// open one authenticated worktree files fixture
async function openFiles(page: Page) {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // reveal the folded Files action on phones
  if (await toolbar.getByRole('button', { name: 'Files', exact: true }).count() === 0) {
    await toolbar.getByRole('button', { name: 'More options', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('grid')).toBeVisible();
  return { fixture, panel };
}

// preserve flush table geometry at desktop and phone widths
for (const width of [1_600, 768, 390, 320]) {
  // check the visible header and selection without tinted row surfaces
  test(`keeps the Files table flush and rows transparent at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { panel } = await openFiles(page);
    const grid = panel.getByRole('grid');
    const rows = grid.locator('.files-row:not(.files-row-skeleton)');
    // preserve the same spacing when the split fills the workspace
    for (const expanded of [false, true]) {
      // expand only after checking the ordinary split
      if (expanded) {
        await panel.getByRole('button', { name: 'Expand files', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Restore files', exact: true })).toBeVisible();
      }
      // wait for the listing after an expanded panel remounts
      await expect(rows).toHaveCount(4);
      await expect(grid.getByRole('columnheader')).toHaveCount(6);
      // measure the same table header at every viewport width
      const geometry = await panel.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const gridBounds = element.querySelector('.files-grid')!.getBoundingClientRect();
        const header = element.querySelector('.panel-header')!.getBoundingClientRect();
        const contentHeader = element.querySelector('.files-grid-head')!;
        return {
          left: gridBounds.left - bounds.left,
          right: bounds.right - gridBounds.right,
          bottom: bounds.bottom - gridBounds.bottom,
          headerGap: contentHeader.getBoundingClientRect().top - header.bottom,
          rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        };
      });
      expect(Math.abs(geometry.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.bottom)).toBeLessThanOrEqual(1);
      expect(geometry.headerGap).toBeGreaterThanOrEqual(geometry.rootFont * .4 - 1);
      // keep square corners and horizontal table borders only
      await expect(grid).toHaveCSS('border-radius', '0px');
      await expect(grid).toHaveCSS('border-left-width', '0px');
      await expect(grid).toHaveCSS('border-right-width', '0px');
      await expect(grid).toHaveCSS('border-top-width', '1px');
      await expect(grid).toHaveCSS('border-bottom-width', '1px');
      await expect(grid).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(grid).toHaveCSS('background-image', 'none');
      await expect(rows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const alpha = rows.filter({ hasText: 'alpha.txt' });
      await alpha.hover();
      await expect(alpha).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await alpha.locator('[data-label="Owner"]').click();
      await expect(alpha).toHaveAttribute('aria-selected', 'true');
      await expect(alpha).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(alpha).toHaveCSS('background-image', 'none');
      // keep the selected edge marker visible
      expect(await alpha.evaluate(element => getComputedStyle(element).boxShadow)).toContain('inset');
      // clear selection consistently before checking another split mode
      await alpha.locator('[data-label="Owner"]').click({ modifiers: ['Control'] });
      await expect(alpha).toHaveAttribute('aria-selected', 'false');
    }
  });
}

test('shows table skeletons for initial and refresh reads without exposing cached rows', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await installPaneMock(page);
  await installFilesFixture(page);
  let activeHold: { started: () => void; wait: Promise<void> } | undefined;
  // prepare one controlled listing response
  const holdNextList = () => {
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    activeHold = { started, wait };
    return { began, release };
  };
  // pause only the explicitly armed list request
  await page.route('**/api/worktrees/cora/files/list', async route => {
    const hold = activeHold;
    activeHold = undefined;
    // preserve every unarmed fixture response
    if (hold !== undefined) { hold.started(); await hold.wait; }
    await route.fallback();
  });
  const initial = holdNextList();
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  await initial.began;
  const panel = page.getByRole('region', { name: 'Files' });
  const grid = panel.getByRole('grid');
  const loadingStatus = panel.getByRole('status', { includeHidden: true }).filter({ hasText: 'Loading files…' });
  await expect(loadingStatus).toHaveCount(1);
  await expect(grid).toHaveAttribute('aria-busy', 'true');
  expect(await loadingStatus.evaluate(element => element.closest('[role="grid"]') === null)).toBe(true);
  const directGridRoles = await grid.locator(':scope > *').evaluateAll(elements => elements.map(element => element.getAttribute('role')));
  expect(directGridRoles.every(role => role === 'row' || role === 'rowgroup')).toBe(true);
  await expect(grid.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(grid.locator('.files-row-skeleton')).toHaveCount(4);
  expect(await grid.locator('.files-row-skeleton').evaluateAll(rows => rows.every(row => row.getAttribute('aria-hidden') === 'true'))).toBe(true);
  await expect(grid.locator('.files-row-skeleton').first().getByRole('gridcell', { includeHidden: true })).toHaveCount(6);
  await expect(grid.locator('.files-row-skeleton').first().locator('.skeleton')).toHaveCount(6);
  const skeletonCellCounts = await grid.locator('.files-row-skeleton').evaluateAll(rows => rows.map(row => row.querySelectorAll('[role="gridcell"] .skeleton').length));
  expect(skeletonCellCounts).toEqual([6, 6, 6, 6]);
  await expect(grid.locator('.files-row:not(.files-row-skeleton)')).toHaveCount(0);
  await expect(grid.locator('.progress-border')).toHaveCount(0);
  // capture the held table loading state on demand
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/files-desktop.png` });
  initial.release();
  await expect(grid.locator('.files-row:not(.files-row-skeleton)')).toHaveCount(4);

  const alpha = grid.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.locator('[data-label="Owner"]').click();
  await grid.getByRole('button', { name: 'Sort by Size' }).click();
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(alpha.getByLabel('Favorite: available')).toBeVisible();

  const refresh = holdNextList();
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await refresh.began;
  await expect(loadingStatus).toHaveCount(1);
  await expect(grid).toHaveAttribute('aria-busy', 'true');
  expect(await loadingStatus.evaluate(element => element.closest('[role="grid"]') === null)).toBe(true);
  await expect(grid.locator('.files-row-skeleton')).toHaveCount(4);
  await expect(grid.locator('.files-row:not(.files-row-skeleton)')).toHaveCount(0);
  await expect(grid).not.toContainText('alpha.txt');
  await expect(grid.getByRole('columnheader', { name: 'Size' })).toHaveAttribute('aria-sort', 'ascending');
  await expect(panel.getByRole('button', { name: 'Refresh files' })).not.toHaveClass(/progress-/u);
  refresh.release();
  const refreshedAlpha = grid.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await expect(refreshedAlpha).toHaveAttribute('aria-selected', 'true');
  await expect(refreshedAlpha.getByLabel('Favorite: available')).toBeVisible();
  await expect(grid.locator('.files-row-skeleton')).toHaveCount(0);
});

test('browses host paths, exposes metadata, selects rows and opens only file names', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const rows = panel.locator('.files-row');
  await expect(rows).toHaveCount(4);
  // directories sort above hidden and ordinary files
  await expect(rows.nth(0).getByRole('button', { name: 'sub', exact: true })).toBeVisible();
  await expect(rows.nth(1).getByRole('button', { name: '.hidden', exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('ubuntu');
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('-rw-r--r--');
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('1.5 KB');

  // row bodies select without previewing
  const hidden = rows.filter({ hasText: '.hidden' });
  await hidden.locator('[role="gridcell"][data-label="Owner"]').click();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'File preview' })).toHaveCount(0);
  const alpha = rows.filter({ hasText: 'alpha.txt' });
  await alpha.locator('[role="gridcell"][data-label="Owner"]').click({ modifiers: ['Control'] });
  await expect(alpha).toHaveAttribute('aria-selected', 'true');

  // an unmodified file-name click sends only its object token to the separate host preview route
  await alpha.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('button', { name: '‹ Files' })).toBeVisible();
  await expect(preview.getByText('outside root preview')).toBeVisible();
  expect(fixture.records.find(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
  await preview.getByRole('button', { name: '‹ Files' }).click();
  await expect(panel).toBeVisible();

  // one header path control replaces the title, breadcrumb and duplicate form
  const path = panel.getByRole('textbox', { name: 'Absolute path' });
  await expect(path).toHaveCount(1);
  await expect(path).toHaveValue('/home/ubuntu/project');
  await expect(panel.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0);
  await expect(panel.locator('.files-breadcrumbs, .files-location, .files-toolbar, .files-favorites')).toHaveCount(0);
  const headerActions = panel.getByRole('toolbar', { name: 'Files actions' }).getByRole('button');
  await expect(headerActions.first()).toHaveAccessibleName('Go to parent folder');

  // folder-name activation and the leading parent action preserve place identity
  await panel.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(panel.getByRole('grid', { name: 'Files in /home/ubuntu/project/sub' })).toBeVisible();
  expect(fixture.currentPath()).toBe('/home/ubuntu/project/sub');
  await expect(path).toHaveValue('/home/ubuntu/project/sub');
  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(rows).toHaveCount(4);

  // Enter navigates the editable header path outside the worktree
  await path.fill('/etc');
  await path.press('Enter');
  await expect(panel.getByRole('grid', { name: 'Files in /etc' })).toBeVisible();
  await expect(path).toHaveValue('/etc');
  expect(fixture.records.findLast(record => record.path.endsWith('/files/list'))?.body).toEqual({ path: '/etc' });
});

test('creates from the New flyout with destination tokens and explicit collision choices', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  await panel.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menu', { name: 'New file or folder' }).getByRole('menuitem', { name: 'New file', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create file' });
  await create.getByRole('textbox', { name: 'Name' }).fill('existing.txt');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  const collision = page.getByRole('dialog', { name: 'Resolve name conflicts' });
  await expect(collision.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await collision.getByLabel('Keep both').check();
  await collision.getByRole('button', { name: 'Continue' }).click();
  await expect(collision).toHaveCount(0);
  const prepared = fixture.records.find(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'create-file');
  expect(prepared?.body).toEqual({ kind: 'create-file', name: 'existing.txt', destinationDirectoryToken: 'directory:/home/ubuntu/project' });
  const execute = fixture.records.find(record => record.path.endsWith('/execute'));
  expect(execute?.body).toEqual({ decisions: { 'collision-record-0001': 'keep-both' } });
});

test('uploads raw bytes, favorites per Place and downloads through the prepared ticket', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const favoriteReadsBeforeUpload = fixture.records.filter(record => record.path.endsWith('/file-favorites') && record.method === 'GET').length;
  await expect(panel.getByRole('button', { name: 'Upload files' })).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Upload files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'raw.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 1, 2]) });
  await expect(panel.getByText('Uploaded 1 file.')).toBeVisible();
  const uploadPrepare = fixture.records.find(record => record.path.endsWith('/uploads/prepare'));
  expect(uploadPrepare?.body).toEqual({ destinationDirectoryToken: 'directory:/home/ubuntu/project', files: [{ clientId: 'file-0', name: 'raw.bin', size: 4 }] });
  const raw = fixture.records.find(record => record.path.endsWith('/uploads/upload-record-0001/file-0'));
  expect(raw?.headers['x-files-upload-token']).toBe('upload-token');
  expect([...raw!.bytes!]).toEqual([0, 255, 1, 2]);
  expect(fixture.records.filter(record => record.path.endsWith('/file-favorites') && record.method === 'GET').length).toBeGreaterThan(favoriteReadsBeforeUpload);

  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  const favoritePut = fixture.records.find(record => record.path === '/api/worktrees/cora/file-favorites' && record.method === 'PUT');
  expect(favoritePut?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });

  const downloadPromise = page.waitForEvent('download');
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('alpha.txt');
  await expect(panel.getByText('Downloaded alpha.txt.')).toBeVisible();
  expect(fixture.records.find(record => record.path.endsWith('/files/downloads') && record.method === 'POST')?.body).toEqual({ objectTokens: ['object-token:alpha.txt:00000000'] });
});

test('keeps a newer favorite mutation when the initial read finishes late', async ({ page }) => {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  const delayed = fixture.holdNextFavoriteRead();
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  await delayed.started;
  const panel = page.getByRole('region', { name: 'Files' });
  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(alpha.getByLabel('Favorite: available')).toBeVisible();
  delayed.release();
  await delayed.finished;
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await expect(page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /alpha\.txt/u })).toBeVisible();
});

test('refreshes rewritten favorites after rename and surfaces a later refresh failure separately', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(alpha.getByLabel('Favorite: available')).toBeVisible();

  // rename one favorite and require its server-rewritten menu entry
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Rename' }).click();
  const renameAlpha = page.getByRole('dialog', { name: 'Rename alpha.txt' });
  await renameAlpha.getByRole('textbox', { name: 'Name' }).fill('renamed.txt');
  await renameAlpha.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(panel.getByText('1 of 1 items completed.')).toBeVisible();
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await expect(page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /renamed\.txt/u })).toBeVisible();
  await page.keyboard.press('Escape');

  // keep the successful operation result while exposing an invalid refresh
  fixture.queueFavoriteRead({ json: { favorites: [null] } });
  const zeta = panel.locator('.files-row').filter({ hasText: 'zeta.bin' });
  await zeta.getByRole('button', { name: 'Actions for zeta.bin' }).click();
  await page.getByRole('menu', { name: 'Actions for zeta.bin' }).getByRole('menuitem', { name: 'Rename' }).click();
  const renameZeta = page.getByRole('dialog', { name: 'Rename zeta.bin' });
  await renameZeta.getByRole('textbox', { name: 'Name' }).fill('renamed-zeta.bin');
  await renameZeta.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(panel.getByText('1 of 1 items completed.')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveText('The favorites response was invalid.');

  // retry both listing and favorites through the folded header action
  await page.setViewportSize({ width: 900, height: 720 });
  const actions = panel.getByRole('toolbar', { name: 'Files actions' });
  await actions.getByRole('button', { name: 'More files actions' }).click();
  await page.getByRole('group', { name: 'More files actions' }).getByRole('button', { name: 'Refresh files' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /renamed\.txt/u }).click();
  await expect(page.getByRole('region', { name: 'File preview' }).getByText('outside root preview')).toBeVisible();
  expect(fixture.records.findLast(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:renamed.txt:00000000' });
});
