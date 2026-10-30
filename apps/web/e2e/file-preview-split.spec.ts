import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { installFilesFixture } from './files-panel-fixture.js';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type PreviewRoute = (route: Route) => void | Promise<void>;

const previewPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// open one authenticated Files split with an optional preview override
async function openFiles(page: Page, previewRoute?: PreviewRoute, withMobileBrowser = false): Promise<Locator> {
  await installPaneMock(page);
  await installFilesFixture(page);
  // restore the browser's fixed phone-width viewport beside desktop splits
  if (withMobileBrowser) {
    await page.addInitScript(() => {
      localStorage.setItem('rac.worktree-id-reset:v1', '1');
      localStorage.setItem('rac.browser-split:cora', 'open');
      localStorage.setItem('rac.browser-viewport:cora', 'mobile');
    });
    await page.route('https://preview.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Project preview</main>' }));
    await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/home/ubuntu/project', placeId: 'cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'main', queuedPromptCount: 0, projectUrl: 'https://preview.example.test/', projectProxied: false }], projects: [] } }));
  }
  // override only preview responses while retaining the shared fixture
  if (previewRoute !== undefined) await page.route('**/api/worktrees/cora/files/preview', previewRoute);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // use the responsive overflow when direct panel buttons are hidden
  if ((page.viewportSize()?.width ?? 1_280) <= 600) {
    await toolbar.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
  } else {
    await toolbar.getByRole('button', { name: 'Files', exact: true }).click();
  }
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files.getByRole('grid')).toBeVisible();
  return files;
}

// retain generic resizable columns beside a fixed-width project browser
test('keeps Preview aligned beside a mobile-viewport browser after Files closes', async ({ page }) => {
  await page.setViewportSize({ width: 1_800, height: 900 });
  const files = await openFiles(page, undefined, true);
  const browser = page.getByRole('dialog', { name: 'Browser', exact: true });
  await expect(browser).toHaveClass(/mobile/u);
  await previewFile(page, files, 'alpha.txt');
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByText('outside root preview')).toBeVisible();
  await files.getByRole('button', { name: 'Close files', exact: true }).click();
  await expect(files).toHaveCount(0);
  const [agentBox, browserBox, previewBox] = await Promise.all([page.locator('.agent-panel').boundingBox(), browser.boundingBox(), preview.boundingBox()]);
  expect(agentBox).not.toBeNull();
  expect(browserBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(browserBox!.width).toBeCloseTo(390, 0);
  expect(previewBox!.y).toBeCloseTo(agentBox!.y, 0);
  expect(previewBox!.height).toBeCloseTo(agentBox!.height, 0);
  expect(previewBox!.x).toBeGreaterThan(browserBox!.x + browserBox!.width);
  expect(previewBox!.width).toBeGreaterThanOrEqual(390);
});

// locate one exact file row
const fileRow = (files: Locator, name: string): Locator => files.locator('.files-row').filter({ hasText: name });

// choose the explicit Preview action for one file
async function previewFile(page: Page, files: Locator, name: string): Promise<void> {
  await fileRow(files, name).getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menu', { name: `Actions for ${name}` }).getByRole('menuitem', { name: 'Preview', exact: true }).click();
}

// keep Preview independent from the retained Code comparison
test('opens Preview beside Code and closing either split retains the other', async ({ page }) => {
  await page.setViewportSize({ width: 1_800, height: 900 });
  const files = await openFiles(page);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await toolbar.getByRole('button', { name: 'Code', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code).toBeVisible();

  await previewFile(page, files, 'alpha.txt');
  let preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByText('outside root preview')).toBeVisible();
  await expect(code).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-preview-code-desktop.png', fullPage: true });
  await preview.getByRole('button', { name: 'Close file', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(code).toBeVisible();

  await previewFile(page, files, 'alpha.txt');
  preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByText('outside root preview')).toBeVisible();
  await code.getByRole('button', { name: 'Close code changes', exact: true }).click();
  await expect(code).toHaveCount(0);
  await expect(preview.getByText('outside root preview')).toBeVisible();
});

// render text through the highlighted file view and images through bounded data urls
test('renders syntax-highlighted text and raster images in Preview', async ({ page }) => {
  const files = await openFiles(page, async route => {
    const body = route.request().postDataJSON() as { objectToken?: string };
    // return an image for the binary fixture row
    if (body.objectToken === 'object-token:zeta.bin:00000000') {
      await route.fulfill({ json: { path: '/home/ubuntu/project/pixel.png', size: Buffer.from(previewPng, 'base64').byteLength, binary: true, truncated: false, image: { mediaType: 'image/png', base64: previewPng } } });
      return;
    }
    await route.fulfill({ json: { path: '/home/ubuntu/project/app.ts', size: 26, binary: false, truncated: false, content: 'export const answer = 42;\n' } });
  });

  await previewFile(page, files, 'alpha.txt');
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByText('export const answer = 42;')).toBeVisible();
  // require token markup inside the diff library's shadow-root code view
  await expect.poll(() => preview.locator('diffs-container').evaluate(element => element.shadowRoot?.querySelectorAll('code span').length ?? 0)).toBeGreaterThan(0);

  await previewFile(page, files, 'zeta.bin');
  const image = preview.getByRole('img', { name: 'Preview of /home/ubuntu/project/pixel.png' });
  await expect(image).toBeVisible();
  // prove the raster decoded rather than showing a broken-image placeholder
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(preview.locator('diffs-container')).toHaveCount(0);
});

// retry the original capability after a preview failure
test('shows preview errors and retries the same file capability', async ({ page }) => {
  let attempts = 0;
  const files = await openFiles(page, async route => {
    attempts += 1;
    // fail only the initial request
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { error: 'synthetic preview failure' } });
      return;
    }
    await route.fulfill({ json: { path: '/home/ubuntu/project/alpha.txt', size: 18, binary: false, truncated: false, content: 'retry succeeded\n' } });
  });

  await previewFile(page, files, 'alpha.txt');
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('alert')).toContainText('Preview unavailable.');
  await preview.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.getByText('retry succeeded')).toBeVisible();
  expect(attempts).toBe(2);
});

// ignore a delayed response after a newer file replaces it
test('keeps the newest Preview when an older response settles late', async ({ page }) => {
  let startFirst!: () => void;
  let releaseFirst!: () => void;
  let finishFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { startFirst = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstFinished = new Promise<void>(resolve => { finishFirst = resolve; });
  const files = await openFiles(page, async route => {
    const body = route.request().postDataJSON() as { objectToken?: string };
    // hold the first file until the replacement has rendered
    if (body.objectToken === 'object-token:alpha.txt:00000000') {
      startFirst();
      await firstGate;
      await route.fulfill({ json: { path: '/home/ubuntu/project/alpha.txt', size: 14, binary: false, truncated: false, content: 'stale response\n' } }).catch(() => undefined);
      finishFirst();
      return;
    }
    await route.fulfill({ json: { path: '/home/ubuntu/project/zeta.bin', size: 16, binary: false, truncated: false, content: 'newest response\n' } });
  });

  await previewFile(page, files, 'alpha.txt');
  await firstStarted;
  await previewFile(page, files, 'zeta.bin');
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByText('newest response')).toBeVisible();
  releaseFirst();
  await firstFinished;
  await expect(preview.getByText('newest response')).toBeVisible();
  await expect(preview.getByText('stale response')).toHaveCount(0);
});

test.describe('phone Preview carousel', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // retain Preview while navigating between phone splits
  test('shows Preview in the split chooser and returns to Files', async ({ page }) => {
    const files = await openFiles(page);
    await files.getByRole('button', { name: 'alpha.txt', exact: true }).tap();
    const preview = page.getByRole('region', { name: 'File preview' });
    await expect(preview.getByText('outside root preview')).toBeVisible();
    await expect(preview).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: '/tmp/remoteagents-preview-mobile.png', fullPage: true });

    const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
    await expect(toolbar.getByRole('group', { name: 'Panels' }).locator('.preview-dot')).toHaveAttribute('data-current', 'true');
    await toolbar.getByRole('button', { name: 'Choose split' }).tap();
    const splits = page.getByRole('menu', { name: 'Splits' });
    await expect(splits.getByRole('menuitem', { name: 'Preview', exact: true })).toHaveAttribute('aria-current', 'true');
    await splits.getByRole('menuitem', { name: 'Files', exact: true }).tap();
    await expect(files).toBeInViewport({ ratio: 0.9 });
    await expect(preview).toHaveCount(1);

    await toolbar.getByRole('button', { name: 'Choose split' }).tap();
    await page.getByRole('menu', { name: 'Splits' }).getByRole('menuitem', { name: 'Preview', exact: true }).tap();
    await expect(preview).toBeInViewport({ ratio: 0.9 });
    await preview.getByRole('button', { name: '‹ Files', exact: true }).tap();
    await expect(files).toBeInViewport({ ratio: 0.9 });
    await expect(preview).toHaveCount(0);
  });
});
