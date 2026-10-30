import { expect, test, type Page } from '@playwright/test';
import { fileIconName } from '../src/files-panel/file-icon.js';
import type { FileEntry } from '../src/files-panel/contracts.js';
import { installFilesFixture } from './files-panel-fixture.js';
import { installPaneMock } from './pane-stream-mock.js';

// exercise every vendored icon against a real filesystem entry shape
const iconCases = [
  { name: 'folder.json', kind: 'directory', icon: 'folder' },
  { name: 'unknown.custom', kind: 'file', icon: 'file' },
  { name: 'index.ts', kind: 'file', icon: 'file-code' },
  { name: 'settings.json', kind: 'file', icon: 'json' },
  { name: 'readme.md', kind: 'file', icon: 'file-text' },
  { name: 'report.PDF', kind: 'file', icon: 'file-pdf' },
  { name: 'photo.png', kind: 'file', icon: 'file-media' },
  { name: 'backup.tar.gz', kind: 'file', icon: 'file-zip' },
  { name: 'program.bin', kind: 'file', icon: 'file-binary' },
  { name: 'folder-shortcut', kind: 'symlink', symlinkTargetKind: 'directory', icon: 'file-symlink-directory' },
  { name: 'file-shortcut.ts', kind: 'symlink', symlinkTargetKind: 'file', icon: 'file-symlink-file' }
] as const;

// publish attribution alongside the self-hosted icon artwork
test('serves the vendored icon license and upstream attribution', async ({ request }) => {
  const license = await request.get('/icons/codicons/LICENSE.txt');
  const attribution = await request.get('/icons/codicons/README.md');
  expect(license.ok()).toBe(true);
  expect(attribution.ok()).toBe(true);
  expect(await license.text()).toContain('Attribution 4.0 International');
  expect(await attribution.text()).toContain('microsoft/vscode-codicons');
});

// keep physical object types authoritative over filename extensions
test('selects VS Code icons with case-insensitive names and safe fallbacks', () => {
  // cover every artwork category
  for (const entry of iconCases) expect(fileIconName(entry)).toBe(entry.icon);
  expect(fileIconName({ name: 'JSON', kind: 'file' })).toBe('file');
  expect(fileIconName({ name: '.env', kind: 'file' })).toBe('file-text');
  expect(fileIconName({ name: 'Dockerfile', kind: 'file' })).toBe('file-code');
  expect(fileIconName({ name: 'LICENSE', kind: 'file' })).toBe('file-text');
  expect(fileIconName({ name: 'unknown', kind: 'file' })).toBe('file');
  expect(fileIconName({ name: 'broken.ts', kind: 'symlink', symlinkTargetKind: 'missing' })).toBe('file-symlink-file');
  expect(fileIconName({ name: 'private', kind: 'symlink', symlinkTargetKind: 'inaccessible' })).toBe('file-symlink-file');
  expect(fileIconName({ name: 'pipe.json', kind: 'fifo' })).toBe('file-binary');
});

// provide all icon categories without modifying the shared Files fixture
async function installIconFixture(page: Page) {
  await installPaneMock(page);
  await installFilesFixture(page);
  const entries: FileEntry[] = iconCases.map(entry => ({
    ...entry,
    hostPath: `/home/ubuntu/project/${entry.name}`,
    owner: { uid: 1000, label: 'ubuntu' },
    permissions: entry.kind === 'directory' ? 'drwxr-xr-x' : entry.kind === 'symlink' ? 'lrwxrwxrwx' : '-rw-r--r--',
    mode: entry.kind === 'directory' ? 0o40755 : entry.kind === 'symlink' ? 0o120777 : 0o100644,
    modifiedAt: '2026-10-06T12:34:00.000Z',
    size: 1536,
    objectToken: `icon-token:${entry.name}`
  }));
  await page.route('**/api/worktrees/cora/files/list', route => route.fulfill({ json: {
    path: '/home/ubuntu/project', parent: '/home/ubuntu', destinationDirectoryToken: 'directory:/home/ubuntu/project',
    directoryEntry: { ...entries[0], name: 'project', hostPath: '/home/ubuntu/project', objectToken: 'current-directory-token' },
    entries,
    inaccessibleEntries: 0
  } }));
  await page.route('**/api/worktrees/cora/file-favorites', route => route.fulfill({ json: { favorites: [
    { id: 'favorite-folder-0001', path: entries[0].hostPath, state: 'available', entry: entries[0] },
    { id: 'favorite-text-0001', path: entries[4].hostPath, state: 'available', entry: entries[4] },
    { id: 'favorite-missing-0001', path: '/missing/report.pdf', state: 'unavailable' }
  ] } }));
  await page.goto('/');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // open mobile Files through the existing overflow menu
  if ((page.viewportSize()?.width ?? 1440) < 600) await toolbar.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  return page.getByRole('region', { name: 'Files' });
}

// render the same icon set in compact and full-size Files layouts
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`renders self-hosted themed icons for files and favorites at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const panel = await installIconFixture(page);
    // check every icon's real layout and local artwork response
    for (const entry of iconCases) {
      const row = panel.locator('.files-row').filter({ has: page.getByRole('button', { name: entry.name, exact: true }) });
      const icon = row.getByRole('img', { name: entry.kind, exact: true });
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute('data-icon', entry.icon);
      const style = await icon.evaluate(element => {
        const css = getComputedStyle(element);
        return { width: css.width, height: css.height, mask: css.maskImage, color: css.color, background: css.backgroundColor, rowColor: getComputedStyle(element.closest('.files-row')!).color };
      });
      expect(style.width).toBe('16px');
      expect(style.height).toBe('16px');
      expect(style.mask).toContain(`/icons/codicons/${entry.icon}.svg`);
      expect(style.background).toBe(style.color);
      expect(style.color).toBe(style.rowColor);
      const response = await page.request.get(`/icons/codicons/${entry.icon}.svg`);
      expect(response.ok()).toBe(true);
      expect(response.headers()['content-type']).toContain('image/svg+xml');
      expect(await response.text()).toContain('viewBox="0 0 16 16"');
    }

    // icon clicks still select rows rather than activating files
    const textRow = panel.locator('.files-row').filter({ has: page.getByRole('button', { name: 'readme.md', exact: true }) });
    await textRow.getByRole('img').click();
    await expect(textRow).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'File preview' })).toHaveCount(0);

    // favorites share the artwork without changing their accessible labels
    await panel.getByRole('button', { name: 'Favorites', exact: true }).click();
    const favorites = page.getByRole('menu', { name: 'Favorites' });
    await expect(favorites.getByRole('menuitem', { name: 'folder.json', exact: true }).locator('.files-kind')).toHaveAttribute('data-icon', 'folder');
    await expect(favorites.getByRole('menuitem', { name: 'readme.md', exact: true }).locator('.files-kind')).toHaveAttribute('data-icon', 'file-text');
    const unavailable = favorites.getByRole('menuitem', { name: 'report.pdf unavailable', exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable.locator('.files-kind')).toHaveAttribute('data-icon', 'file-pdf');
    await expect(favorites.getByRole('img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
