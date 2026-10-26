import { expect, test } from '@playwright/test';

test('bundles and uses every JetBrains Mono Nerd Font face', async ({ page }) => {
  await page.goto('/');
  // open credential entry through the public homepage
  await page.getByRole('button', { name: 'Log in', exact: true }).click();

  await expect(page.locator('body')).toHaveCSS('font-family', /JetBrainsMono Nerd Font/u);
  await expect(page.getByRole('heading', { name: 'Console access' })).toHaveCSS('font-family', /JetBrainsMono Nerd Font/u);
  await expect(page.getByLabel('Password')).toHaveCSS('font-family', /JetBrainsMono Nerd Font/u);

  const loadedFaces = await page.evaluate(async () => {
    const family = '"JetBrainsMono Nerd Font"';
    const faces = [
      `500 16px ${family}`,
      `italic 500 16px ${family}`,
      `700 16px ${family}`,
      `italic 700 16px ${family}`
    ];
    return await Promise.all(faces.map(async face => (await document.fonts.load(face, 'Agent 󰊤')).length));
  });

  expect(loadedFaces).toEqual([1, 1, 1, 1]);
});
