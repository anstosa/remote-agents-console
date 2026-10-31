import { expect, test } from '@playwright/test';

test('renders each pull request card as its status icon and number, linking to GitHub', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="root"></div>');
  await page.evaluate(async () => {
    const { renderPullRequestCards } = await import('/e2e/pull-request-card-fixture.tsx');
    renderPullRequestCards(document.querySelector<HTMLElement>('#root')!);
  });

  const cards = page.locator('#root');
  const draft = cards.getByRole('link', { name: 'Draft pull request #7: Draft card' });
  const open = cards.getByRole('link', { name: 'Open pull request #8: Open card' });
  const merged = cards.getByRole('link', { name: 'Merged pull request #9: Merged card' });
  await expect(draft).toHaveAttribute('href', 'https://github.com/octo/repo/pull/7');
  await expect(open).toHaveText('#8');
  await expect(merged).toHaveText('#9');
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
  const mergeConflict = cards.getByRole('img', { name: 'Merge conflicts' });
  await expect(mergeConflict).toBeVisible();
  await expect(mergeConflict.locator('path')).toHaveAttribute('d', 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9v3a6 6 0 0 0 6 6h3M6 9v12');
  await expect(cards.getByRole('img', { name: 'CI checks passed' })).toBeVisible();
  await expect(cards.getByRole('img', { name: 'CI checks running' })).toBeVisible();
  await expect(cards.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(cards.getByRole('img', { name: 'CI checks passed' }).locator('path')).toHaveAttribute('d', 'm5 12 4 4L19 6');
  await expect(cards.getByRole('img', { name: 'CI checks running' }).locator('circle')).toHaveCount(1);
  await expect(cards.getByRole('img', { name: 'CI checks failed' }).locator('path')).toHaveAttribute('d', 'M7 7l10 10M17 7 7 17');
  await expect(cards.getByRole('img', { name: 'Failing checks' })).toHaveCount(0);
  await expect(cards.getByRole('img', { name: 'CI checks passed' })).toHaveCSS('color', 'rgb(166, 227, 161)');
  await expect(cards.getByRole('img', { name: 'CI checks running' })).toHaveCSS('color', 'rgb(250, 179, 135)');
  await expect(cards.getByRole('img', { name: 'CI checks failed' })).toHaveCSS('color', 'rgb(243, 139, 168)');
  await expect(cards.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  // the cards hold no indicators or actions of their own
  await expect(cards.locator('.pull-request-card :is(button, .pull-request-issues)')).toHaveCount(0);
});
