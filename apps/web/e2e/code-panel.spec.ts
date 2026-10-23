import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { codeViewOption, openCodeViewMenu } from './panel-header';
import type { ComparisonFile, ComparisonFileContents, ComparisonPatch, FilePreviewView, RevisionFile } from '../src/code-panel/comparison';

// a minimal but valid git unified diff for one modified file, enough for parsePatchFiles
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
// the same diff shape with a chosen new line, so a live update can change one file's content — and
// so its content version — without changing its rendered height
const modifiedPatchTo = (path: string, line: string) => `diff --git a/${path} b/${path}\nindex 1111111..4444444 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+${line}\n const c = 4;\n`;
// preserve git's quoted UTF-8 path form for collapse-key coverage
const quotedUnicodePatch = 'diff --git "a/src/\\303\\251.ts" "b/src/\\303\\251.ts"\nindex 1111111..4444444 100644\n--- "a/src/\\303\\251.ts"\n+++ "b/src/\\303\\251.ts"\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const unicode = 3;\n const c = 4;\n';

const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const trackedFileTo = (path: string, line: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatchTo(path, line), capped: false });
const cappedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path }, kind: 'tracked', patch: '', capped: true });

// the fingerprint tracks path *and* patch text so a live update that edits a file's content — not
// just the file set — reads as a changed Comparison, the way the server's content-sensitive one does
const patchOf = (files: ComparisonFile[], truncated = false): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => `${file.change.path}:${file.patch}`).join('|'), truncated });

// The whole file behind `modifiedPatch`, with lines past the hunk (the `sentinel` line) that only
// Plain-file and Full-context modes should surface.
const baseFile = 'const a = 1;\nconst b = 2;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const workingFile = 'const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const revision = (path: string, content: string): RevisionFile => ({ path, size: content.length, binary: false, truncated: false, content });
const contentsOf = (path: string, base: string, working: string): ComparisonFileContents => ({ path, base: revision(path, base), working: revision(path, working) });

// mount the isolated Code panel with a scripted Comparison (and optional per-file revision contents)
const mountPanel = async (page: Page, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}, startExpanded = false, rootWidth?: number, editor = false) => {
  await page.goto('/');
  await page.evaluate(async ({ scripted, files, expanded, width, withEditor }) => {
    const { renderCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    // stretch the panel to fill the root so its 1fr diff row is bounded and can scroll, the way the
    // real split sizes it (a bare block child would size to content and never overflow)
    root.style.display = 'grid';
    // a narrow root forces the changed-file list into its slide-over drawer (below RAIL_BREAKPOINT),
    // regardless of the viewport
    if (width !== undefined) root.style.width = `${width}px`;
    document.body.replaceChildren(root);
    renderCodePanel(root, scripted, files, expanded, withEditor);
  }, { scripted: patch, files: loaded, expanded: startExpanded, width: rootWidth, withEditor: editor });
};

// push a fresh Comparison (and optional per-file contents) into the mounted panel, standing in for a
// live change-summary update from the dashboard
const updatePanel = async (page: Page, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}) => {
  await page.evaluate(async ({ scripted, files }) => {
    const { updateCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    updateCodePanel(scripted, files);
  }, { scripted: patch, files: loaded });
};

// mount the REAL useCodePanel controller (with a stubbed comparison fetch) behind the panel, so a spec
// can drive its soft refresh; `page.evaluate(window.__ctrl…)` reads fetch/patch-change counts and
// pushes the next Comparison and change signal.
const mountController = async (page: Page, patch: ComparisonPatch) => {
  await page.goto('/');
  await page.evaluate(async ({ scripted }) => {
    const { renderCodeController } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    root.style.display = 'grid';
    document.body.replaceChildren(root);
    renderCodeController(root, scripted);
  }, { scripted: patch });
};
type Ctrl = { fetches: number; patchChanges: number; fileFetches: number; setNext(patch: ComparisonPatch): void; setFiles(files: Record<string, ComparisonFileContents>): void; open(): void; bump(signal: string): void; openFile(path: string, content: string): void; closeFile(): void; openCommit(sha: string, subject: string): void; missingCommits: boolean; close(): void; remount(): Promise<void>; swap(): Promise<void> };
const controls = (page: Page) => page.evaluate(() => { const c = (window as unknown as { __ctrl: Ctrl }).__ctrl; return { fetches: c.fetches, patchChanges: c.patchChanges }; });

const panel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const diffHeaders = (page: Page) => page.locator('.code-pane diffs-container [data-title]');

// mount the panel showing a static File view (a response file or terminal link), for the render states
const mountFilePreview = async (page: Page, filePreview: FilePreviewView, editor = false) => {
  await page.goto('/');
  await page.evaluate(async ({ view, withEditor }) => {
    const { renderFilePreview } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    root.style.display = 'grid';
    document.body.replaceChildren(root);
    renderFilePreview(root, view, withEditor);
  }, { view: filePreview, withEditor: editor });
};

test('renders each File view state: text through the library, image inline, binary/error placeholders', async ({ page }) => {
  // a text file is a plain-file view rendered by the diff library (real highlighting), with a back crumb
  await mountFilePreview(page, { path: 'src/app.ts', state: 'ready', preview: { path: 'src/app.ts', size: 40, truncated: false, binary: false, content: 'export const answer = 42;\n' } });
  await expect(panel(page).getByRole('button', { name: '‹ Changes' })).toBeVisible();
  await expect(panel(page).getByText('app.ts', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('export const answer = 42;')).toBeVisible();

  // an over-cap text file keeps a truncation notice
  await mountFilePreview(page, { path: 'src/big.ts', state: 'ready', preview: { path: 'src/big.ts', size: 300_000, truncated: true, binary: false, content: 'const head = 1;\n' } });
  await expect(panel(page).getByText(/Preview limited to the first 256 KB/u)).toBeVisible();

  // an image previews inline as a plain (non-library) view
  await mountFilePreview(page, { path: 'shot.png', state: 'ready', preview: { path: 'shot.png', size: 68, truncated: false, binary: true, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } } });
  await expect(panel(page).getByRole('img', { name: 'Preview of shot.png' })).toBeVisible();

  // a non-image binary file is a placeholder, not garbage
  await mountFilePreview(page, { path: 'blob.bin', state: 'ready', preview: { path: 'blob.bin', size: 10, truncated: false, binary: true } });
  await expect(panel(page).getByText(/Binary file/u)).toBeVisible();

  // a failed preview reports it
  await mountFilePreview(page, { path: 'gone.ts', state: 'error' });
  await expect(panel(page).getByText(/Preview unavailable/u)).toBeVisible();
});

// the editor jumps the file headers asked for (mounted with an editor configured)
const editorJumps = (page: Page) => page.evaluate(() => (window as unknown as { __editorJumps?: unknown[] }).__editorJumps ?? []);

test('opens a changed file in the configured editor at its first change or the selected line', async ({ page }) => {
  const deleted: ComparisonFile = { change: { code: ' D', path: 'src/gone.ts', additions: 0, deletions: 2 }, kind: 'tracked', patch: 'diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const x = 1;\n-const y = 2;\n', capped: false };
  await mountPanel(page, patchOf([trackedFile('src/a.ts'), deleted]), {}, false, undefined, true);
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  // with nothing selected the header opens the diff's first change
  const open = panel(page).getByRole('button', { name: /^Open src\/a\.ts at line \d+ in the editor$/u });
  await expect(open).toHaveAccessibleName('Open src/a.ts at line 2 in the editor');
  // a deleted file has no working-tree copy to open
  await expect(panel(page).getByRole('button', { name: /^Open src\/gone\.ts/u })).toHaveCount(0);
  // a selected line number moves the jump to that line
  await panel(page).locator('[data-column-number="3"]').first().click();
  await expect(open).toHaveAccessibleName('Open src/a.ts at line 3 in the editor');
  await open.click();
  expect(await editorJumps(page)).toEqual([{ file: 'src/a.ts', line: 3 }]);
});

test('offers no editor jump without a configured editor', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/a.ts')]));
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /in the editor$/u })).toHaveCount(0);
});

test('opens a File view in the editor only for a path inside the Place', async ({ page }) => {
  await mountFilePreview(page, { path: 'src/app.ts', state: 'ready', preview: { path: 'src/app.ts', size: 40, truncated: false, binary: false, content: 'export const answer = 42;\n' } }, true);
  await expect(panel(page).getByText('export const answer = 42;')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Open src/app.ts at line 1 in the editor' }).click();
  expect(await editorJumps(page)).toEqual([{ file: 'src/app.ts', line: 1 }]);
  // a file elsewhere (an absolute path) cannot be opened in the Place
  await mountFilePreview(page, { path: '/tmp/notes.txt', state: 'ready', preview: { path: '/tmp/notes.txt', size: 6, truncated: false, binary: false, content: 'notes\n' } }, true);
  await expect(panel(page).getByText('notes', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /in the editor$/u })).toHaveCount(0);
});

test('maps a diff line to the working-tree line the editor opens', async ({ page }) => {
  await page.goto('/');
  const lines = await page.evaluate(async () => {
    const { diffItemForPatch } = await import('/src/code-panel/items.ts');
    const { diffJumpLine, newSideLine } = await import('/src/code-panel/editor-jump.tsx');
    // two hunks: line 3 removed (old 1-5 → new 1-4), then lines 21-22 added after old 18 (new 17)
    const patch = 'diff --git a/f.ts b/f.ts\nindex 1111111..2222222 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1,5 +1,4 @@\n l1\n l2\n-l3\n l4\n l5\n@@ -17,3 +16,5 @@\n l17\n l18\n+n1\n+n2\n l19\n';
    const item = diffItemForPatch('f.ts', patch);
    if (item === undefined || item.type !== 'diff') throw new Error('unparsed');
    const diff = item.fileDiff;
    return {
      first: diffJumpLine(diff, undefined),
      removed: newSideLine(diff, 'deletions', 3),
      context: newSideLine(diff, 'deletions', 4),
      between: newSideLine(diff, 'deletions', 10),
      after: newSideLine(diff, 'deletions', 30),
      added: newSideLine(diff, 'additions', 18),
      crossSide: diffJumpLine(diff, { start: 3, side: 'deletions', end: 4, endSide: 'additions' })
    };
  });
  // the first change is the removal of old line 3, now where new line 3 (old l4) stands
  expect(lines).toEqual({ first: 3, removed: 3, context: 3, between: 9, after: 31, added: 18, crossSide: 3 });
});

test('renders implementation changes and exposes View docs as an unchecked checkbox', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/widget.ts'), trackedFile('src/app.test.ts')]));

  // the panel title is the Comparison picker, seeded to Working
  await panel(page).locator('.code-pane-picker').click();
  await expect(page.getByRole('menu', { name: 'Comparison' }).getByRole('menuitemradio', { name: 'Working changes' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Comparison' })).toHaveCount(0);
  await expect(panel(page).locator('.code-pane-count')).toHaveText('3');
  // only the two implementation files render; the test file is behind the collapsed group
  await expect(diffHeaders(page)).toHaveCount(2);

  const menu = await openCodeViewMenu(panel(page));
  const toggle = menu.getByRole('checkbox', { name: /View docs \(1\)/iu });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  // checking View docs appends the test file to the same scroll
  await expect(diffHeaders(page)).toHaveCount(3);
});

test('keeps the Comparison picker when a Comparison resolves with no files', async ({ page }) => {
  // an empty Comparison (e.g. switching to Working when everything is committed) must not strand the
  // reviewer: the mode/layout controls hide with no files, but the Comparison picker stays so they
  // can switch back to the Comparison that had changes
  await mountPanel(page, patchOf([]));

  await expect(panel(page).getByText('No changes to show.')).toBeVisible();
  await panel(page).locator('.code-pane-picker').click();
  await expect(page.getByRole('menu', { name: 'Comparison' }).getByRole('menuitemradio', { name: 'All PR changes' })).toBeEnabled();
  // the file-dependent controls are correctly absent
  await expect(panel(page).getByRole('button', { name: 'Hunks' })).toHaveCount(0);
});

// two hunks far apart leave a large collapsed gap between them in Hunks mode
const bigBaseLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
const bigWorkingLines = bigBaseLines.map((line, index) => (index === 1 ? 'line 2 changed' : index === 49 ? 'line 50 changed' : line));
const twoHunkPatch = ['diff --git a/src/big.ts b/src/big.ts', 'index 1111111..2222222 100644', '--- a/src/big.ts', '+++ b/src/big.ts', '@@ -1,5 +1,5 @@', ' line 1', '-line 2', '+line 2 changed', ' line 3', ' line 4', ' line 5', '@@ -47,7 +47,7 @@', ' line 47', ' line 48', ' line 49', '-line 50', '+line 50 changed', ' line 51', ' line 52', ' line 53'].join('\n') + '\n';
const bigFile: ComparisonFile = { change: { code: ' M', path: 'src/big.ts', additions: 2, deletions: 2 }, kind: 'tracked', patch: twoHunkPatch, capped: false };
const bigContents: ComparisonFileContents = { path: 'src/big.ts', base: revision('src/big.ts', `${bigBaseLines.join('\n')}\n`), working: revision('src/big.ts', `${bigWorkingLines.join('\n')}\n`) };
const bigGap = (page: Page) => panel(page).locator('diffs-container').getByText(/unmodified lines/iu).first();

test('expands a collapsed hunk gap in Hunks mode without first visiting Full context', async ({ page }) => {
  await mountPanel(page, patchOf([bigFile]), { 'src/big.ts': bigContents });
  await panel(page).getByTitle('src/big.ts').click();

  // Hunks (default): a line inside the gap is hidden
  await expect(panel(page).getByText('line 25', { exact: true })).toHaveCount(0);
  // the gap is expandable straight away — previously it only worked after a Full-context round trip
  // hydrated the partial patch (loadDiffFiles is now provided in every mode, not just Full context)
  await expect(bigGap(page)).toBeVisible();
  await bigGap(page).click();
  await expect(panel(page).getByText('line 25', { exact: true })).toBeVisible();
});

test('keeps view controls directly in the top-level header flyout on a narrow panel', async ({ page }) => {
  // a narrow root (below the header's fold width) stands in for a phone / squeezed column
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/widget.ts')]), {}, false, 380);

  // the diff modes are never inline or behind a second View options action
  await expect(panel(page).getByRole('button', { name: 'Hunks' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'View options' })).toHaveCount(0);
  // the Comparison picker stays in the header
  await expect(panel(page).locator('.code-pane-title')).toHaveText('Working changes');
  const flyout = await openCodeViewMenu(panel(page));
  await expect(flyout.getByRole('button', { name: 'Hunks' })).toHaveAttribute('aria-pressed', 'true');
  // the shared flyout row styles must not erase segmented-control dividers
  await expect(flyout.getByRole('button', { name: 'Full ctx' })).toHaveCSS('border-left-width', '1px');
  await expect(flyout.getByRole('checkbox', { name: 'Wrap lines' })).not.toBeChecked();
  // choosing an option applies it and closes the top-level flyout
  await flyout.getByRole('button', { name: 'Full ctx' }).click();
  await expect(flyout).toBeHidden();
  // reopening shows the chosen mode
  await expect(await codeViewOption(panel(page), 'Full ctx')).toHaveAttribute('aria-pressed', 'true');
});

test('Esc from the Code panel More control closes its flyout before it restores the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  const options = region.getByRole('button', { name: 'More code panel actions' });
  await options.click();
  const flyout = page.getByRole('group', { name: 'More code panel actions' });
  await expect(flyout).toBeVisible();
  await options.press('Escape');
  await expect(flyout).toBeHidden();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  // the next Escape restores
  await options.press('Escape');
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
});

test('on a desktop the top-level view controls drop from the header as a card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  const options = region.getByRole('button', { name: 'More code panel actions' });
  await options.click();
  const flyout = page.getByRole('group', { name: 'More code panel actions' });
  await expect(flyout).toBeVisible();
  const [flyoutBox, regionBox, optionsBox] = await Promise.all([flyout.boundingBox(), region.boundingBox(), options.boundingBox()]);
  expect(flyoutBox!.height).toBeLessThan(regionBox!.height / 2);
  // it sits just beneath the header, its right edge by the button that opened it
  expect(flyoutBox!.y).toBeGreaterThanOrEqual(optionsBox!.y + optionsBox!.height);
  expect(flyoutBox!.y - (optionsBox!.y + optionsBox!.height)).toBeLessThan(40);
  expect(flyoutBox!.x + flyoutBox!.width).toBeGreaterThanOrEqual(optionsBox!.x + optionsBox!.width);
  expect(flyoutBox!.x + flyoutBox!.width).toBeLessThanOrEqual(regionBox!.x + regionBox!.width);
});

test('remembers the last Unified / Split pick across reloads, but a narrow panel stays unified', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const patch = patchOf([trackedFile('src/app.ts')]);
  await mountPanel(page, patch);
  const region = panel(page);
  await expect(region.locator('[data-diff-type="single"]')).toHaveCount(1);
  await (await openCodeViewMenu(region)).getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Split' }).click();
  await expect(region.locator('[data-diff-type="split"]')).toHaveCount(1);
  await mountPanel(page, patch);
  await expect(region.locator('[data-diff-type="split"]')).toHaveCount(1);
  await expect((await openCodeViewMenu(region)).getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
  await mountPanel(page, patch, {}, false, 560);
  await expect(region.locator('[data-diff-type="single"]')).toHaveCount(1);
  await expect((await openCodeViewMenu(region)).getByRole('group', { name: 'Diff layout' })).toHaveCount(0);
});

test('covers a size-capped file with a Load anyway placeholder instead of a diff', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), cappedFile('src/generated.ts')]));

  // the capped file is a placeholder, not a rendered diff
  await expect(panel(page).getByText('src/generated.ts')).toBeVisible();
  await expect(panel(page).getByText('File too large to preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load anyway' })).toBeVisible();
  // only the non-capped file rendered a diff
  await expect(diffHeaders(page)).toHaveCount(1);
});

test('filters to one file from the rail and restores scroll on the way back', async ({ page }) => {
  const files = Array.from({ length: 8 }, (_, index) => trackedFile(`src/mod${index}.ts`));
  await mountPanel(page, patchOf(files));
  // the rail lists every changed file (it is not virtualized like the diff scroll)
  await expect(panel(page).locator('.code-pane-file-row')).toHaveCount(8);
  await expect(panel(page).locator('.code-pane-count')).toHaveText('8');
  await expect(diffHeaders(page).first()).toBeVisible();

  // scroll the all-files list down, then leave it for one file
  const view = panel(page).locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const before = await view.evaluate(element => element.scrollTop);

  await panel(page).getByTitle('src/mod4.ts').click();
  await expect(panel(page).getByRole('button', { name: 'All files', exact: true })).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(1);

  // the breadcrumb returns to every file and lands back at the captured (item, offset) anchor: close
  // to where we left off, not the top and not overshooting
  await panel(page).getByRole('button', { name: 'All files', exact: true }).click();
  await expect(panel(page).locator('.code-pane-count')).toHaveText('8');
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), before)).toBeLessThan(24);
});

test('collapses and expands each file without hiding the other diffs', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFileTo('src/app.ts', 'const app = 3;'), trackedFileTo('src/widget.ts', 'const widget = 3;')]));
  await expect(panel(page).getByText('const app = 3;')).toBeVisible();
  await expect(panel(page).getByText('const widget = 3;')).toBeVisible();

  const collapse = panel(page).getByRole('button', { name: 'Collapse src/app.ts' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(panel(page).getByText('const app = 3;')).toHaveCount(0);
  await expect(panel(page).getByText('const widget = 3;')).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(2);

  const expand = panel(page).getByRole('button', { name: 'Expand src/app.ts' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(panel(page).getByText('const app = 3;')).toBeVisible();
});

test('collapses and expands a file whose Git patch path is quoted', async ({ page }) => {
  const file: ComparisonFile = { change: { code: ' M', path: 'src/é.ts', additions: 1, deletions: 1 }, kind: 'tracked', patch: quotedUnicodePatch, capped: false };
  await mountPanel(page, patchOf([file]));
  const changedLine = panel(page).getByText('const unicode = 3;');
  await expect(changedLine).toBeVisible();

  const toggle = panel(page).locator('.code-pane-file-collapse');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(changedLine).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(changedLine).toBeVisible();
});

test('keeps wrapping off by default and applies it from the top-level flyout', async ({ page }) => {
  const longLine = `const longValue = '${'wrapped '.repeat(30)}';`;
  await mountPanel(page, patchOf([trackedFileTo('src/app.ts', longLine)]), {}, false, 560);
  const region = panel(page);
  const menu = await openCodeViewMenu(region);
  const wrap = menu.getByRole('checkbox', { name: 'Wrap lines' });
  const changedLine = region.locator('diffs-container [data-line]').filter({ hasText: 'const longValue' }).last();
  await expect(changedLine).toBeVisible();
  const unwrappedHeight = (await changedLine.boundingBox())!.height;
  await expect(wrap).not.toBeChecked();
  await expect(region).not.toHaveAttribute('data-wrap-lines', 'true');
  await wrap.click();
  await expect(region).toHaveAttribute('data-wrap-lines', 'true');
  await expect(region.getByText(longLine)).toBeVisible();
  // the line itself grows as its text wraps instead of scrolling sideways
  await expect.poll(async () => (await changedLine.boundingBox())?.height ?? 0).toBeGreaterThan(unwrappedHeight + 5);
  await expect((await openCodeViewMenu(region)).getByRole('checkbox', { name: 'Wrap lines' })).toBeChecked();
});

test('uses the terminal font setting for diff text', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const changedLine = panel(page).getByText('const b = 3;');
  await expect(changedLine).toHaveCSS('font-size', '11px');

  await page.evaluate(async () => {
    const { setTerminalFontSize } = await import('/src/terminal-font-size.ts');
    setTerminalFontSize(18);
  });
  await expect(changedLine).toHaveCSS('font-size', '18px');
});

test('color codes file statuses and shows added and deleted line totals', async ({ page }) => {
  // build one rendered patch for each status presentation
  const fileWith = (path: string, code: string, additions: number, deletions: number): ComparisonFile => ({ change: { code, path, additions, deletions }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
  await mountPanel(page, patchOf([
    fileWith('src/added.ts', 'A ', 3, 0),
    fileWith('src/modified.ts', ' M', 4, 2),
    fileWith('src/deleted.ts', 'D ', 0, 7),
    fileWith('src/renamed.ts', 'R ', 1, 1)
  ]));

  const added = panel(page).locator('.code-pane-file-row', { hasText: 'added.ts' });
  const modified = panel(page).locator('.code-pane-file-row', { hasText: 'modified.ts' });
  const deleted = panel(page).locator('.code-pane-file-row', { hasText: 'deleted.ts' });
  const renamed = panel(page).locator('.code-pane-file-row', { hasText: 'renamed.ts' });
  await expect(added).toContainText('+3−0');
  await expect(modified).toContainText('+4−2');
  await expect(deleted).toContainText('+0−7');
  await expect(added.getByLabel('3 lines added, 0 lines deleted')).toBeVisible();
  // sample the active theme tokens for semantic status colors
  const palette = await page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    // resolve each CSS variable to the browser's computed RGB form
    const sample = (name: string) => { probe.style.color = `var(--${name})`; return getComputedStyle(probe).color; };
    const colors = { green: sample('green'), red: sample('red'), yellow: sample('yellow'), mauve: sample('mauve') };
    probe.remove();
    return colors;
  });
  const statusColors = await Promise.all([added, modified, deleted, renamed].map(row => row.locator('.code-pane-file-code').evaluate(element => getComputedStyle(element).color)));
  expect(statusColors).toEqual([palette.green, palette.yellow, palette.red, palette.mauve]);
  const lineColors = await modified.locator('.code-pane-file-lines > span').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  expect(lineColors).toEqual([palette.green, palette.red]);
});

test('switches a file between hunks, plain, and full-context modes', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile) });

  // Plain file is single-file only, so it is disabled in the all-files view
  await expect(await codeViewOption(panel(page), 'Plain file')).toBeDisabled();
  await panel(page).getByRole('button', { name: 'More code panel actions' }).press('Escape');

  await panel(page).getByTitle('src/app.ts').click();
  await expect(panel(page).getByRole('button', { name: 'All files', exact: true })).toBeVisible();

  // Hunks (default): only the patched lines render, so a line past the hunk stays hidden
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect(panel(page).getByText('const sentinel = 999;')).toHaveCount(0);

  // Full context: still a diff (a header renders), but the unchanged lines expand by hydrating from
  // the file-at-revision endpoint — so the out-of-hunk line appears and a fresh fetch fired for it.
  await page.evaluate(() => { (window as unknown as { __codeLoads?: string[] }).__codeLoads = []; });
  await (await codeViewOption(panel(page), 'Full ctx')).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __codeLoads?: string[] }).__codeLoads ?? [])).toContain('src/app.ts');

  // Plain file: the whole *current* file renders — the out-of-hunk line stays visible, but the
  // deleted old line (shown by the Hunks/Full diffs) is gone because this is the working file, not a diff
  await (await codeViewOption(panel(page), 'Plain file')).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  await expect(panel(page).getByText('const b = 2;')).toHaveCount(0);
});

test('promotes the Code panel to full screen and restores it (control + Esc)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  const expand = region.getByRole('button', { name: 'Expand code panel' });
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
  await expect(expand).toHaveAttribute('aria-pressed', 'false');

  // the control promotes the panel
  await expand.click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  const restore = region.getByRole('button', { name: 'Restore code panel' });
  await expect(restore).toHaveAttribute('aria-pressed', 'true');

  // Esc restores
  await restore.press('Escape');
  await expect(region).not.toHaveClass(/\bexpanded\b/u);

  // and the control restores too
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  await region.getByRole('button', { name: 'Restore code panel' }).click();
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
});

test('opens already promoted when startExpanded is set on a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), {}, true);
  const region = panel(page);
  await expect(region).toHaveClass(/\bexpanded\b/u);
  await expect(region.getByRole('button', { name: 'Restore code panel' })).toHaveAttribute('aria-pressed', 'true');
});

test('ignores startExpanded on a phone viewport, where the control offers full screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), {}, true);
  const region = panel(page);
  // the panel is not promoted (the desktop-only seed is gated off)
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
  // on a phone the control hides the tab row and toolbar instead of filling the Workspace
  await expect(page.locator('.panel-header-expand')).toBeVisible();
  await expect(page.locator('.panel-header-expand')).toHaveAttribute('title', 'Full screen');
});

test('promotes the File view to full screen and restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountFilePreview(page, { path: 'src/app.ts', state: 'ready', preview: { path: 'src/app.ts', size: 40, truncated: false, binary: false, content: 'export const answer = 42;\n' } });
  const fileView = page.locator('.code-pane-file');
  await expect(fileView).not.toHaveClass(/\bexpanded\b/u);
  await panel(page).getByRole('button', { name: 'Expand code panel' }).click();
  await expect(fileView).toHaveClass(/\bexpanded\b/u);
  // Esc restores from the File view too
  await panel(page).getByRole('button', { name: 'Restore code panel' }).press('Escape');
  await expect(fileView).not.toHaveClass(/\bexpanded\b/u);
});

test('the square files trigger opens a drawer that closes from its backdrop or Esc', async ({ page }) => {
  // a desktop viewport (control visible) but a narrow panel (the file list is a drawer, not a rail)
  await page.setViewportSize({ width: 1200, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/app.test.ts')]), {}, false, 560);
  const region = panel(page);
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  const trigger = region.getByRole('button', { name: 'Show changed files' });
  const triggerBox = await trigger.boundingBox();
  if (triggerBox === null) throw new Error('Changed-files trigger has no layout bounds');
  expect(Math.abs(triggerBox.width - triggerBox.height)).toBeLessThanOrEqual(1);
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Changed files' });
  await expect(drawer).toBeVisible();
  const backdrop = region.locator('.code-pane-drawer-backdrop');
  const backdropBox = await backdrop.boundingBox();
  if (backdropBox === null) throw new Error('Changed-files backdrop has no layout bounds');
  await backdrop.click({ position: { x: backdropBox.width - 4, y: 4 } });
  await expect(drawer).toBeHidden();

  await trigger.click();
  await expect(drawer).toBeVisible();
  // one Escape closes only the drawer; the panel stays full screen (the drawer stops the key bubbling)
  await drawer.getByRole('button', { name: 'Close changed files' }).press('Escape');
  await expect(drawer).toBeHidden();
  await expect(region).toHaveClass(/\bexpanded\b/u);
});

test('opens a Code panel of the Working changes from the Git flyout', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // one active, changed worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }, { code: ' M', path: 'src/app.test.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // the Working Comparison for the panel
    if (url.pathname === '/api/worktrees/cora/comparison') {
      expect(request.postDataJSON()).toEqual({ kind: 'working' });
      return route.fulfill({ json: patchOf([trackedFile('src/app.ts'), trackedFile('src/app.test.ts')]) });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();

  // the panel opens on the Working Comparison the flyout was showing
  await expect(panel(page).locator('.code-pane-title')).toHaveText('Working changes');
  // the implementation file renders; the test file stays behind the collapsed supporting group
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect((await openCodeViewMenu(panel(page))).getByRole('checkbox', { name: /View docs \(1\)/iu })).not.toBeChecked();
});

test('deep-links a flyout file row into the panel and picks Working / All PR', async ({ page }) => {
  await installPaneMock(page);
  const prFile = (path: string): ComparisonFile => ({ ...trackedFile(path), change: { code: 'M ', path, additions: 2, deletions: 0 } });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // an active worktree with both a Working diff and an All PR Comparison available
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/pr-only.ts', additions: 2, deletions: 0 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // each Comparison returns a distinct file, so the header toggle is observable
    if (url.pathname === '/api/worktrees/cora/comparison') {
      const working = request.postDataJSON().kind === 'working';
      return route.fulfill({ json: working ? patchOf([trackedFile('src/app.ts')]) : { ...patchOf([prFile('src/pr-only.ts')]), kind: 'pr', base: 'origin/main', gitBase: 'origin/main' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  // the flyout defaults to All PR because a merge target exists, so it lists the PR's file
  await page.getByRole('button', { name: /^Git status:/u }).click();
  // a changed-file row deep-links the panel straight to that file's diff, in the flyout's Comparison
  await page.getByRole('button', { name: 'View changes to src/pr-only.ts' }).click();
  await expect(panel(page).getByRole('button', { name: 'All files', exact: true })).toBeVisible();
  await expect(panel(page).locator('.code-pane-title')).toHaveText('All PR changes');
  await expect(diffHeaders(page)).toHaveText([/pr-only\.ts/u]);

  // the header picker switches the whole Comparison to Working, keeping the selected file — which
  // the Working Comparison doesn't contain, so the panel reports it is not in these changes
  await panel(page).locator('.code-pane-picker').click();
  await page.getByRole('menu', { name: 'Comparison' }).getByRole('menuitemradio', { name: 'Working changes' }).click();
  await expect(panel(page).locator('.code-pane-title')).toHaveText('Working changes');
  await expect(panel(page).getByText(/isn't part of the current changes/u)).toBeVisible();

  // back to every file shows the Working Comparison's own file
  await panel(page).getByRole('button', { name: 'All files', exact: true }).click();
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);
});

const codeLoads = (page: Page) => page.evaluate(() => (window as unknown as { __codeLoads?: string[] }).__codeLoads ?? []);

test('refreshes a changed file in place and reuses unchanged files without rehydrating them', async ({ page }) => {
  const contents = { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile), 'src/util.ts': contentsOf('src/util.ts', baseFile, workingFile) };
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/util.ts')]), contents);
  await expect(diffHeaders(page)).toHaveCount(2);

  // Full context hydrates every file from its two revisions — one loadFile per file
  await (await codeViewOption(panel(page), 'Full ctx')).click();
  await expect.poll(() => codeLoads(page)).toContain('src/app.ts');
  await expect.poll(() => codeLoads(page)).toContain('src/util.ts');
  await expect(panel(page).getByText('const sentinel = 999;').first()).toBeVisible();

  // from here watch which files re-fetch; a reused (unchanged) file must not hydrate again
  await page.evaluate(() => { (window as unknown as { __codeLoads?: string[] }).__codeLoads = []; });

  // a live update where only util.ts changed content and revisions
  const editedWorking = workingFile.replace('const b = 3;', 'const b = 9;');
  await updatePanel(page, patchOf([trackedFile('src/app.ts'), trackedFileTo('src/util.ts', 'const b = 9;')]), {
    'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile),
    'src/util.ts': contentsOf('src/util.ts', baseFile, editedWorking)
  });

  // the edited file rebuilds and shows its new content; the untouched file keeps a stable content
  // version, so the library never re-hydrates it (no fresh fetch) and its expansion survives. (Version
  // stability, not object identity, is what the library reconciles on; this pins that we hand a stable
  // version for an unchanged file and a moved one for an edit.)
  await expect(panel(page).getByText('const b = 9;')).toBeVisible();
  await expect.poll(() => codeLoads(page)).toContain('src/util.ts');
  await expect(diffHeaders(page)).toHaveCount(2);
  expect(await codeLoads(page)).not.toContain('src/app.ts');
});

// drive the real useCodePanel controller: open it (a hard load), then move its change signal (the
// production live-update trigger) and read its fetch / patch-change counts
const openController = async (page: Page) => {
  await page.waitForFunction(() => Boolean((window as unknown as { __ctrl?: Ctrl }).__ctrl));
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.open());
  await expect(diffHeaders(page).first()).toBeVisible();
};
const bumpSignal = async (page: Page, next: ComparisonPatch, signal: string) => {
  await page.evaluate(patch => (window as unknown as { __ctrl: Ctrl }).__ctrl.setNext(patch), next);
  await page.evaluate(sig => (window as unknown as { __ctrl: Ctrl }).__ctrl.bump(sig), signal);
};

test('a moved change signal soft-refreshes the open Comparison in place', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  const before = await controls(page);

  // the live change signal moves and the next Comparison carries new content
  await bumpSignal(page, patchOf([trackedFileTo('src/app.ts', 'const b = 9;')]), 's1');

  // the panel refetched and swapped in the new content without a mode switch or reopen
  await expect(panel(page).getByText('const b = 9;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toHaveCount(0);
  expect((await controls(page)).fetches).toBeGreaterThan(before.fetches);
});

test('an unchanged-fingerprint refresh refetches but does not repaint', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  const before = await controls(page);

  // the signal moves but the Comparison is byte-identical (a change confined to the other Comparison)
  await bumpSignal(page, patchOf([trackedFile('src/app.ts')]), 's1');

  // it did refetch, but the identical fingerprint means the patch reference is reused — no repaint
  await expect.poll(() => controls(page).then(current => current.fetches)).toBeGreaterThan(before.fetches);
  expect((await controls(page)).patchChanges).toBe(before.patchChanges);
});

test('preserves the reviewer scroll position across a soft refresh', async ({ page }) => {
  const files = Array.from({ length: 8 }, (_, index) => trackedFile(`src/mod${index}.ts`));
  await mountController(page, patchOf(files));
  await openController(page);
  await expect(panel(page).locator('.code-pane-file-row')).toHaveCount(8);

  const view = panel(page).locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const before = await view.evaluate(element => element.scrollTop);
  const stats = await controls(page);

  // a live edit to one file (same height) arrives via the soft refresh — which keeps the patch mounted
  // rather than blanking to a spinner, so the reviewer's place holds
  const updated = files.map((file, index) => index === 3 ? trackedFileTo('src/mod3.ts', 'const b = 9;') : file);
  await bumpSignal(page, patchOf(updated), 's1');

  // the patch actually swapped (a new fingerprint) and scroll held
  await expect.poll(() => controls(page).then(current => current.patchChanges)).toBeGreaterThan(stats.patchChanges);
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), before)).toBeLessThan(24);
});

test('keeps a full-context file expanded while its live rebuild is in flight', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile) });
  await panel(page).getByTitle('src/app.ts').click();
  await (await codeViewOption(panel(page), 'Full ctx')).click();

  // Full context expands the unchanged lines: the out-of-hunk sentinel shows, alongside the current
  // changed line (b = 3)
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();

  // close the load gate so the non-partial rebuild cannot complete, then push a live edit to app.ts
  await page.evaluate(async () => { const { holdLoads } = await import('/e2e/code-panel-fixture.tsx'); holdLoads(); });
  const editedWorking = workingFile.replace('const b = 3;', 'const b = 7;');
  await updatePanel(page, patchOf([trackedFileTo('src/app.ts', 'const b = 7;')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, editedWorking) });

  // with the rebuild held, the file holds its prior expanded view — no blink back to hunks-only — so
  // the expanded sentinel stays and the new (b = 7) content has not yet replaced the old
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 7;')).toHaveCount(0);

  // releasing the gate swaps in the non-partial rebuild: the new content appears and the file is still
  // fully expanded, never having collapsed to hunks-only
  await page.evaluate(async () => { const { releaseLoads } = await import('/e2e/code-panel-fixture.tsx'); releaseLoads(); });
  await expect(panel(page).getByText('const b = 7;')).toBeVisible();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
});

test('opens a file in the File view through the real controller and returns to the Comparison', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);

  // open a file via the real controller — a genuine openFilePreview fetch through the isFilePreview guard
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.openFile('README.md', 'hello from the file view'));
  await expect(panel(page).getByRole('button', { name: '‹ Changes' })).toBeVisible();
  await expect(panel(page).getByText('hello from the file view')).toBeVisible();
  // the File view takes over the panel: only the opened file shows, not the Comparison's app.ts diff
  await expect(diffHeaders(page)).toHaveText([/README\.md/u]);

  // leaving the File view reveals the Comparison the panel had loaded underneath (no reopen)
  await panel(page).getByRole('button', { name: '‹ Changes' }).click();
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);
  await expect(panel(page).getByText('hello from the file view')).toHaveCount(0);
});

// Switching Workspaces unmounts the whole card, so the controller and panel mount fresh on the way
// back; `remount` stands in for that round trip.
const remount = (page: Page) => page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.remount());
const eightFiles = Array.from({ length: 8 }, (_, index) => trackedFile(`src/mod${index}.ts`));

test('restores the view settings and scroll position after a Workspace switch', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await (await openCodeViewMenu(region)).getByRole('checkbox', { name: 'Wrap lines' }).click();
  await region.getByRole('button', { name: 'Collapse src/mod1.ts' }).click();
  const view = region.locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const before = await view.evaluate(element => element.scrollTop);

  await remount(page);

  await expect(region).toHaveAttribute('data-wrap-lines', 'true');
  await expect(region.getByRole('button', { name: 'Expand src/mod1.ts' })).toBeVisible();
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), before)).toBeLessThan(24);
});

test('restores the commit and file being read after a Workspace switch', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.openCommit('abc1234', 'Fix the widget'));
  await expect(region.getByText('Fix the widget')).toBeVisible();
  const view = region.locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const listTop = await view.evaluate(element => element.scrollTop);
  await region.getByTitle('src/mod4.ts').click();
  await expect(region.getByRole('button', { name: 'All files', exact: true })).toBeVisible();

  await remount(page);

  await expect(region.locator('.code-pane-crumb-current')).toHaveText('mod4.ts');
  await expect(diffHeaders(page)).toHaveText([/mod4\.ts/u]);
  // the breadcrumb still returns to where the all-files scroll was left
  await region.getByRole('button', { name: 'All files', exact: true }).click();
  await expect(region.locator('.code-pane-title')).toHaveText('Fix the widget');
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), listTop)).toBeLessThan(24);
});

test('restores the diff mode and hidden file rail after a Workspace switch', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await (await codeViewOption(region, 'Full ctx')).click();
  await region.getByRole('button', { name: 'Hide changed files' }).click();
  await expect(region.locator('.code-pane-rail')).toHaveCount(0);

  await remount(page);

  await expect(region.getByRole('button', { name: 'Show changed files' })).toBeVisible();
  await expect(region.locator('.code-pane-rail')).toHaveCount(0);
  await expect(await codeViewOption(region, 'Full ctx')).toHaveAttribute('aria-pressed', 'true');
});

test('resizes the file rail by drag and arrow keys, between its minimum and half the panel, and remembers it', async ({ page }) => {
  // a long file name must not hold the rail open past its width
  const files = [trackedFile('src/a.ts'), trackedFile(`src/${'long-file-name-'.repeat(12)}.ts`)];
  await mountPanel(page, patchOf(files), {}, false, 1000);
  const rail = page.locator('.code-pane-rail');
  const handle = page.getByRole('separator', { name: 'Resize changed files' });
  const railWidth = () => rail.evaluate(element => element.getBoundingClientRect().width);
  const start = await railWidth();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(railWidth).toBeCloseTo(start + 120, 0);
  await handle.press('ArrowLeft');
  await expect.poll(railWidth).toBeCloseTo(start + 104, 0);
  // a drag past half the panel stops there
  const moved = (await handle.boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 100);
  await page.mouse.down();
  await page.mouse.move(moved.x + 800, moved.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(railWidth).toBeCloseTo(500, 0);

  await mountPanel(page, patchOf(files), {}, false, 1000);
  await expect.poll(railWidth).toBeCloseTo(500, 0);
  // and a drag past the minimum stops there
  const wide = (await handle.boundingBox())!;
  await page.mouse.move(wide.x + wide.width / 2, wide.y + 100);
  await page.mouse.down();
  await page.mouse.move(wide.x - 600, wide.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(railWidth).toBeCloseTo(160, 0);
});

test('restores expanded hidden lines after a Workspace switch', async ({ page }) => {
  await mountController(page, patchOf([bigFile]));
  await openController(page);
  await page.evaluate(files => (window as unknown as { __ctrl: Ctrl }).__ctrl.setFiles(files), { 'src/big.ts': bigContents });
  const line25 = panel(page).getByText('line 25', { exact: true });
  await bigGap(page).click();
  await expect(line25).toBeVisible();

  await remount(page);

  await expect(diffHeaders(page)).toHaveText([/big\.ts/u]);
  await expect(line25).toBeVisible();
  // only the gap that was opened comes back open: the trailing one stays collapsed
  await expect(panel(page).getByText('line 57', { exact: true })).toHaveCount(0);
});

test('returns to the place read below a diff whose expansion is restored', async ({ page }) => {
  await mountController(page, patchOf([bigFile, ...eightFiles]));
  await openController(page);
  await page.evaluate(files => (window as unknown as { __ctrl: Ctrl }).__ctrl.setFiles(files), { 'src/big.ts': bigContents });
  await bigGap(page).click();
  await expect(panel(page).getByText('line 25', { exact: true })).toBeVisible();
  // read on past the expanded diff, to where a later file's header sits partway down the view
  const view = panel(page).locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 1400; element.dispatchEvent(new Event('scroll')); });
  const viewTop = (await view.boundingBox())?.y ?? 0;
  const headerAt = async () => {
    for (const candidate of await diffHeaders(page).all()) {
      const offset = ((await candidate.boundingBox())?.y ?? 0) - viewTop;
      if (offset > 100 && offset < 500) return { title: (await candidate.textContent()) ?? '', offset };
    }
    return undefined;
  };
  await expect.poll(headerAt).toBeDefined();
  const before = (await headerAt())!;
  const header = diffHeaders(page).filter({ hasText: before.title });
  const offsetInView = async () => ((await header.boundingBox())?.y ?? 0) - viewTop;

  await remount(page);

  await expect.poll(async () => Math.abs(await offsetInView() - before.offset)).toBeLessThan(24);
  // and still there once the expansion above has loaded its files and grown
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.fileFetches)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(Math.abs(await offsetInView() - before.offset)).toBeLessThan(24);
  await view.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(panel(page).getByText('line 25', { exact: true })).toBeVisible();
});

test('a changed patch comes back without the old expansions', async ({ page }) => {
  await mountController(page, patchOf([bigFile]));
  await openController(page);
  await page.evaluate(files => (window as unknown as { __ctrl: Ctrl }).__ctrl.setFiles(files), { 'src/big.ts': bigContents });
  await bigGap(page).click();
  await expect(panel(page).getByText('line 25', { exact: true })).toBeVisible();

  // the second hunk moved, so the saved hunk index no longer names the same gap
  const moved: ComparisonFile = { ...bigFile, patch: bigFile.patch.replace('@@ -47,7 +47,7 @@', '@@ -46,7 +46,7 @@').replace(' line 47', ' line 46\n line 47').replace(' line 53\n', '') };
  await page.evaluate(patch => (window as unknown as { __ctrl: Ctrl }).__ctrl.setNext(patch), patchOf([moved]));
  await remount(page);

  await expect(diffHeaders(page)).toHaveText([/big\.ts/u]);
  await expect(bigGap(page)).toBeVisible();
  // a restore would expand straight away, loading the file again; give it the time to and confirm it did not
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.fileFetches)).toBe(0);
  await expect(panel(page).getByText('line 25', { exact: true })).toHaveCount(0);
});

test('a commit that fails to load outside a restore still shows the error', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await page.evaluate(() => { const c = (window as unknown as { __ctrl: Ctrl }).__ctrl; c.missingCommits = true; c.openCommit('abc1234', 'Fix the widget'); });
  await expect(region.getByRole('alert')).toContainText('Unable to load changes.');
});

test('a card swapped in the same commit does not restore an older snapshot', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await region.getByTitle('src/mod4.ts').click();
  await remount(page);
  await expect(region.locator('.code-pane-crumb-current')).toHaveText('mod4.ts');
  await region.getByTitle('src/mod2.ts').click();
  await expect(region.locator('.code-pane-crumb-current')).toHaveText('mod2.ts');

  // launching an Agent replaces the Worktree's card with an Agent card in one commit
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.swap());

  await expect(region.locator('.code-pane-count')).toHaveText('8');
  await expect(region.locator('.code-pane-crumb-current')).not.toHaveText('mod4.ts');
});

test('falls back to Working changes when the restored commit is gone', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  // a commit opened from All PR still falls back to Working
  await region.locator('.code-pane-picker').click();
  await page.getByRole('menu', { name: 'Comparison' }).getByRole('menuitemradio', { name: 'All PR changes' }).click();
  await expect(region.locator('.code-pane-title')).toHaveText('All PR changes');
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.openCommit('abc1234', 'Fix the widget'));
  await expect(region.locator('.code-pane-title')).toHaveText('Fix the widget');

  // the commit was rebased away while the Workspace was out of view
  await page.evaluate(() => { (window as unknown as { __ctrl: Ctrl }).__ctrl.missingCommits = true; });
  await remount(page);

  await expect(region.locator('.code-pane-title')).toHaveText('Working changes');
  await expect(region.locator('.code-pane-count')).toHaveText('8');
  await expect(region.getByRole('alert')).toHaveCount(0);
});

test('falls back to all files when the restored file left the Comparison', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  await region.getByTitle('src/mod4.ts').click();
  await expect(region.getByRole('button', { name: 'All files', exact: true })).toBeVisible();

  // the file's change was reverted while the Workspace was out of view
  await page.evaluate(patch => (window as unknown as { __ctrl: Ctrl }).__ctrl.setNext(patch), patchOf(eightFiles.filter(file => file.change.path !== 'src/mod4.ts')));
  await remount(page);

  await expect(region.locator('.code-pane-count')).toHaveText('7');
  await expect(region.locator('.code-pane-title')).toHaveText('Working changes');
  await expect(region.getByRole('alert')).toHaveCount(0);
});

test('closing the Code panel forgets its view state', async ({ page }) => {
  await mountController(page, patchOf(eightFiles));
  await openController(page);
  const region = panel(page);
  const wrap = async () => { await (await openCodeViewMenu(region)).getByRole('checkbox', { name: 'Wrap lines' }).click(); await expect(region).toHaveAttribute('data-wrap-lines', 'true'); };
  const close = () => page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.close());
  await wrap();
  await region.getByTitle('src/mod4.ts').click();
  await expect(region.getByRole('button', { name: 'All files', exact: true })).toBeVisible();
  // a restored panel closed and reopened in place starts fresh
  await remount(page);
  await expect(region).toHaveAttribute('data-wrap-lines', 'true');
  await close();
  await expect(region).toHaveCount(0);
  await openController(page);
  await expect(region.locator('.code-pane-count')).toHaveText('8');
  await expect(region).not.toHaveAttribute('data-wrap-lines', 'true');

  // turning a Workspace off closes its panels and its tab in one batch; the switch back starts fresh
  await wrap();
  await page.evaluate(() => { const c = (window as unknown as { __ctrl: Ctrl }).__ctrl; c.close(); return c.remount(); });
  await openController(page);
  await expect(region.locator('.code-pane-count')).toHaveText('8');
  await expect(region).not.toHaveAttribute('data-wrap-lines', 'true');
});

test('asks about lines of a Code panel diff from the gutter, with follow-ups, and keeps the thread across a reload', async ({ page }) => {
  // wide enough for the panel beside the agent to offer the split layout
  await page.setViewportSize({ width: 1800, height: 900 });
  await installPaneMock(page);
  const asked: Array<{ query: string; body: unknown }> = [];
  let turns: Array<{ id: string; question: string; askedAt: string; answer: string }> = [];
  let polls = 0;
  const anchor = { changeId: 'src/app.ts', file: 'src/app.ts', side: 'additions', startLine: 2, endLine: 2, excerpt: ' const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;' };
  const comparison = patchOf([trackedFile('src/app.ts')]);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: comparison });
    // the Working Comparison's questions, kept by scope
    if (url.pathname === '/api/worktrees/cora/comparison/asks' && request.method() === 'POST') {
      asked.push({ query: url.search, body: request.postDataJSON() });
      polls = 0;
      return route.fulfill({ status: 202, json: { status: 'pending', job: { id: `ask-${asked.length}`, expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 250 }, threadId: 'ask_d1' } });
    }
    if (url.pathname === '/api/worktrees/cora/comparison/asks') return route.fulfill({ json: { status: 'ready', threads: turns.length === 0 ? [] : [{ id: 'ask_d1', target: 'diff', kind: 'claude', conversation: 's-1', anchor, turns }], pending: [] } });
    if (url.pathname.startsWith('/api/review-tour/asks/jobs/')) {
      polls += 1;
      const id = url.pathname.split('/').at(-1)!;
      if (polls < 3) return route.fulfill({ status: 202, json: { status: 'pending', job: { id, expiresAt: '2099-01-01T00:00:00.000Z', retryAfterMs: 250 } } });
      const { question } = asked.at(-1)!.body as { question: string };
      turns = [...turns, { id, question, askedAt: '2026-10-22T12:00:00.000Z', answer: question === 'Why 3?' ? 'It was **off by one**.' : 'Because tests expect it.' }];
      return route.fulfill({ json: { status: 'ready' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(diffHeaders(page)).toHaveCount(1);

  // the gutter "+" opens a question box under the picked line; Cancel drops it
  await panel(page).getByText('const b = 3;').hover();
  await panel(page).locator('[data-utility-button]').click();
  const questions = panel(page).getByRole('region', { name: 'Questions for the agent' });
  await expect(questions.getByLabel('Question for the agent')).toBeFocused();
  await questions.getByRole('button', { name: 'Cancel' }).click();
  await expect(questions).toHaveCount(0);
  await panel(page).getByText('const b = 3;').hover();
  await panel(page).locator('[data-utility-button]').click();
  await questions.getByLabel('Question for the agent').fill('Why 3?');
  await questions.getByRole('button', { name: 'Ask' }).click();
  await expect.poll(() => asked).toEqual([{ query: '?kind=working', body: { lines: { changeId: 'src/app.ts', side: 'additions', startLine: 2, endLine: 2 }, question: 'Why 3?', fingerprint: comparison.fingerprint } }]);
  await expect(questions.getByRole('status')).toContainText('The agent is answering');
  await expect(questions.locator('.review-ask-answer')).toContainText('It was off by one.');
  // the Code panel has no comments to copy an answer into
  await expect(questions.getByRole('button', { name: 'Copy to comment' })).toHaveCount(0);
  // a follow-up names its thread
  await questions.getByLabel('Question for the agent').fill('And the tests?');
  await questions.getByRole('button', { name: 'Ask' }).click();
  await expect.poll(() => asked.at(-1)?.body).toEqual({ threadId: 'ask_d1', question: 'And the tests?', fingerprint: comparison.fingerprint });
  await expect(questions.locator('.review-ask-answer')).toHaveCount(2);

  // the thread is the server's, so a reload shows it again under its line
  await page.reload();
  await seedPaneSize(page, 'agent-1');
  await expect(panel(page).getByRole('region', { name: 'Questions for the agent' }).locator('.review-ask-answer')).toHaveText(['It was off by one.', 'Because tests expect it.']);

  // in the split layout, a removed line is asked about on the old side
  await (await openCodeViewMenu(panel(page))).getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Split' }).click();
  await panel(page).getByText('const b = 2;').hover();
  await panel(page).locator('[data-utility-button]').click();
  const draft = panel(page).getByPlaceholder('Ask about these lines');
  await draft.fill('Why drop 2?');
  await draft.press('Control+Enter');
  await expect.poll(() => asked.at(-1)?.body).toEqual({ lines: { changeId: 'src/app.ts', side: 'deletions', startLine: 2, endLine: 2 }, question: 'Why drop 2?', fingerprint: comparison.fingerprint });
});
