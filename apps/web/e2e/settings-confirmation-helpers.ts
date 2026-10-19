import { expect, type Page } from "@playwright/test";

// confirm one deliberate toolbar discard in synthetic browser tests
export async function confirmSettingsDiscard(page: Page) {
  const dialog = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}

// confirm one deliberate dirty Settings close in synthetic browser tests
export async function confirmSettingsClose(page: Page) {
  const dialog = page.getByRole("alertdialog", {
    name: "Close Settings with unsaved changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard and close", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}
