import { expect, test, type Page } from '@playwright/test';

// mount production SettingsSelect controls in isolated local state
async function mountSettingsSelectControls(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderSettingsSelectControlFixture } = await import('/e2e/settings-select-control-fixture.tsx');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    renderSettingsSelectControlFixture(root);
  });
  await expect(page.getByRole('switch', { name: 'Two-way mode', exact: true })).toBeVisible();
}

test('renders exactly two choices as one labeled switch and changes only on input', async ({ page }) => {
  await mountSettingsSelectControls(page);
  const control = page.getByRole('switch', { name: 'Two-way mode', exact: true });
  const changes = page.getByRole('status', { name: 'Change log', exact: true });

  await expect(page.getByRole('combobox', { name: 'Two-way mode', exact: true })).toHaveCount(0);
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await expect(control).toHaveAttribute('data-value', 'left');
  await expect(control.locator('.settings-select-switch-choice')).toHaveText(['Key tables', 'Command shortcuts']);
  await expect(control.locator('.settings-select-switch-icon')).toHaveCount(2);
  await expect(control.locator('.settings-select-switch-choice').first()).toHaveAttribute('title', 'First group: Key tables');
  await expect(control.locator('.settings-select-switch-choice').first()).toHaveAttribute('data-has-issues', 'true');
  await expect(control).toHaveAccessibleDescription(/Unchecked selects Key tables in First group.*Checked selects Command shortcuts in Second group/);
  await expect(control.locator('.settings-select-switch-choice').last()).toHaveCSS('white-space', 'normal');
  await expect(changes).toHaveText('');

  await control.click();
  await expect(control).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('status', { name: 'Two-way value', exact: true })).toHaveText('right');
  await expect(changes).toHaveText('two-way:right');

  await control.press('Space');
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('status', { name: 'Two-way value', exact: true })).toHaveText('left');
  await expect(changes).toHaveText('two-way:right,two-way:left');

  await control.press('Enter');
  await expect(control).toHaveAttribute('aria-checked', 'true');
  await expect(changes).toHaveText('two-way:right,two-way:left,two-way:right');
});

test('recovers unknown two-choice values before switching to the binary control', async ({ page }) => {
  await mountSettingsSelectControls(page);
  const unknown = page.getByRole('combobox', { name: 'Unknown mode', exact: true });
  const changes = page.getByRole('status', { name: 'Change log', exact: true });

  await expect(unknown).toHaveAttribute('data-value', 'legacy');
  await expect(unknown.locator('.settings-select-current-label')).toHaveText('legacy');
  await expect(page.getByRole('switch', { name: 'Unknown mode', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Unknown value', exact: true })).toHaveText('legacy');
  await expect(changes).toHaveText('');
  await expect(page.getByRole('switch', { name: 'Blocked destination', exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Locked mode', exact: true })).toBeDisabled();

  await unknown.press('Enter');
  const options = page.getByRole('listbox', { name: 'Unknown mode options', exact: true });
  await expect(options.locator('[role="option"][data-value="left"]')).toHaveAttribute('data-active', 'true');
  await expect(options.locator('[role="option"][data-value="right"]')).toHaveAttribute('aria-disabled', 'true');
  await unknown.press('Enter');

  const recovered = page.getByRole('switch', { name: 'Unknown mode', exact: true });
  await expect(recovered).toHaveAttribute('aria-checked', 'false');
  await expect(recovered).toHaveAttribute('data-value', 'left');
  await expect(page.getByRole('combobox', { name: 'Unknown mode', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Unknown value', exact: true })).toHaveText('left');
  await expect(changes).toHaveText('unknown:left');
});

test('keeps three-choice selectors as icon-capable dropdowns', async ({ page }) => {
  await mountSettingsSelectControls(page);
  const control = page.getByRole('combobox', { name: 'Three-way mode', exact: true });
  await expect(page.getByRole('switch', { name: 'Three-way mode', exact: true })).toHaveCount(0);
  await expect(control).toHaveAttribute('data-value', 'beta');

  await control.click();
  const options = page.getByRole('listbox', { name: 'Three-way mode options', exact: true });
  await expect(options).toHaveAttribute('data-has-icons', 'true');
  await expect(options.getByRole('option')).toHaveCount(3);
  await expect(options.locator('.settings-select-option-icon')).toHaveCount(3);
  await expect(options.locator('[role="option"][data-value="gamma"]')).toHaveAttribute('aria-disabled', 'true');
  await options.locator('[role="option"][data-value="alpha"]').click();
  await expect(control).toHaveAttribute('data-value', 'alpha');
  await expect(page.getByRole('status', { name: 'Three-way value', exact: true })).toHaveText('alpha');
  await expect(page.getByRole('status', { name: 'Change log', exact: true })).toHaveText('three-way:alpha');
});
