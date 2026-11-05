import { expect, test } from '@playwright/test';

const openTitle = 'Open card with a complete title that stays available while the visible label truncates';
const openLabel = `Open pull request #8: ${openTitle}`;

test('renders each pull request card with its complete linked title and status indicators', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="root"></div>');
  await page.evaluate(async () => {
    const { renderPullRequestCards } = await import('/e2e/pull-request-card-fixture.tsx');
    renderPullRequestCards(document.querySelector<HTMLElement>('#root')!);
  });

  const cards = page.locator('#root');
  const draft = cards.getByRole('link', { name: 'Draft pull request #7: Draft card' });
  const open = cards.getByRole('link', { name: openLabel });
  const merged = cards.getByRole('link', { name: 'Merged pull request #9: Merged card' });
  const draftCard = cards.locator('.pull-request-card.status-draft');
  const openCard = cards.locator('.pull-request-card.status-open');
  const mergedCard = cards.locator('.pull-request-card.status-merged');
  await expect(draft).toHaveAttribute('href', 'https://github.com/octo/repo/pull/7');
  await expect(open).toHaveAttribute('href', 'https://github.com/octo/repo/pull/8');
  await expect(open).toHaveAttribute('title', openLabel);
  await expect(open.getByText('#8', { exact: true })).toBeVisible();
  await expect(merged.getByText('#9', { exact: true })).toBeVisible();
  const title = openCard.locator('.pull-request-card-title');
  await expect(title).toHaveText(openTitle);
  await expect(title).toHaveCSS('overflow', 'hidden');
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  await expect(title).toHaveCSS('white-space', 'nowrap');
  expect(await title.evaluate(element => /* measure title truncation */ element.scrollWidth > element.clientWidth)).toBe(true);
  await page.mouse.move(1000, 1000);
  await expect(draft).toHaveCSS('color', 'rgb(147, 153, 178)');
  await expect(open).toHaveCSS('color', 'rgb(166, 227, 161)');
  await expect(merged).toHaveCSS('color', 'rgb(203, 166, 247)');

  const verticalCenters = await open.locator('.pull-request-card-icon, strong').evaluateAll(elements => {
    const card = elements[0].closest('.pull-request-card')!.getBoundingClientRect();
    const cardCenter = card.top + card.height / 2;
    return elements.map(element => {
      const bounds = element.getBoundingClientRect();
      return Math.abs(bounds.top + bounds.height / 2 - cardCenter);
    });
  });
  expect(verticalCenters.every(offset => offset <= 1)).toBe(true);
  await expect(open.locator('.pull-request-card-icon')).toHaveCSS('mask-image', /github-favicon\.svg/);
  await expect(open.locator('.pull-request-card-icon')).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await expect(draftCard.getByRole('img', { name: 'CI checks passed' })).toBeVisible();
  await expect(mergedCard.getByRole('img', { name: 'CI checks running' })).toBeVisible();
  await expect(openCard.getByRole('img')).toHaveCount(3);
  const mergeConflict = openCard.getByRole('img', { name: 'Merge conflicts' });
  await expect(mergeConflict).toBeVisible();
  await expect(mergeConflict.locator('path')).toHaveAttribute('d', 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9v3a6 6 0 0 0 6 6h3M6 9v12');
  await expect(openCard.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(openCard.getByRole('img', { name: 'CI checks failed' }).locator('path')).toHaveAttribute('d', 'M7 7l10 10M17 7 7 17');
  await expect(openCard.getByRole('img', { name: 'Failing checks' })).toHaveCount(0);
  await expect(openCard.getByRole('img', { name: 'CI checks failed' })).toHaveCSS('color', 'rgb(243, 139, 168)');
  await expect(openCard.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  // locate the card-owned status corner
  const indicatorCorner = await openCard.evaluate(element => {
    const card = element.getBoundingClientRect();
    const issues = element.querySelector<HTMLElement>('.pull-request-issues')!.getBoundingClientRect();
    return {
      right: card.right - issues.right,
      bottom: card.bottom - issues.bottom,
      rightHalf: issues.left + issues.width / 2 > card.left + card.width / 2,
      bottomHalf: issues.top + issues.height / 2 > card.top + card.height / 2
    };
  });
  expect(indicatorCorner.right).toBeGreaterThanOrEqual(0);
  expect(indicatorCorner.right).toBeLessThanOrEqual(12);
  expect(indicatorCorner.bottom).toBeGreaterThanOrEqual(0);
  expect(indicatorCorner.bottom).toBeLessThanOrEqual(12);
  expect(indicatorCorner.rightHalf).toBe(true);
  expect(indicatorCorner.bottomHalf).toBe(true);
  await expect(cards.locator('.pull-request-card button')).toHaveCount(0);
});
