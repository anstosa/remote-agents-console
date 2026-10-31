import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";

type ConfirmationFixtureState = {
  deviceName: string;
  fileTitle: string;
  revision: number;
  renames: Array<{ deviceName: string }>;
  saves: unknown[];
  settingsReads: number;
  nextSettingsRead?: Promise<void>;
  renameGate?: Promise<void>;
};

// resolve one deliberately held fixture operation
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// publish one small editable source for async discard and save boundaries
function applicationSource(state: ConfirmationFixtureState) {
  return {
    id: "app",
    label: "Application configuration",
    path: "/synthetic/config.json",
    format: "json",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: `app-r${state.revision}`,
    apply: "rac-restart",
    value: { title: state.fileTitle },
    schema: {
      type: "object",
      label: "Application configuration",
      properties: {
        title: { type: "string", label: "Service title" },
      },
    },
  };
}

// choose one Settings page through either responsive navigation surface
async function selectSettingsPage(
  settings: Locator,
  id: string,
  label: string,
) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // use the compact section picker on narrow viewports
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox", {
        name: "Settings section options",
        exact: true,
      })
      .locator(`[role="option"][data-value=${JSON.stringify(id)}]`)
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: new RegExp(`^${label}`, "u") })
    .click();
}

// mount browser-only Settings without touching the live console
async function setupConfirmationSettings(page: Page, files = false) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const state: ConfirmationFixtureState = {
    deviceName: "Confirmation browser",
    fileTitle: "Saved title",
    revision: 1,
    renames: [],
    saves: [],
    settingsReads: 0,
  };
  const status = {
    pending: false,
    targets: [],
    effective: "known",
    restartAvailable: true,
  };
  // isolate every application request behind a synthetic controller
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish an authenticated browser identity
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "confirmation-csrf",
          active: true,
          deviceName: state.deviceName,
          server: {
            name: "Fixture",
            url: "https://fixture.example.test",
            remotes: [],
          },
          davo: {
            enabled: false,
            available: true,
            name: "Davo",
            context: "",
          },
        },
      });
    // capture only explicit browser identity saves
    if (path === "/api/auth/device-name" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { deviceName: string };
      state.renames.push(body);
      // hold only the configured rename transaction
      if (state.renameGate !== undefined) await state.renameGate;
      state.deviceName = body.deviceName;
      return route.fulfill({
        json: {
          csrfToken: "confirmation-csrf",
          active: true,
          deviceName: state.deviceName,
          server: {
            name: "Fixture",
            url: "https://fixture.example.test",
            remotes: [],
          },
          davo: {
            enabled: false,
            available: true,
            name: "Davo",
            context: "",
          },
        },
      });
    }
    // keep the surrounding dashboard empty
    if (path === "/api/dashboard")
      return route.fulfill({
        json: {
          generation: 1,
          adapters: {},
          agents: [],
          projects: [],
          cleanupPending: 0,
          reviews: [],
          reviewTour: { available: false, reason: "generator_unavailable" },
        },
      });
    if (path === "/api/dashboard/ticket")
      return route.fulfill({ json: { ticket: "confirmation-ticket" } });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({ json: status });
    // keep background tunnel monitoring inside the fixture
    if (
      path === "/api/settings/cloudflare/health" &&
      request.method() === "GET"
    )
      return route.fulfill({
        json: {
          state: "disabled",
          failures: 0,
          reconnecting: false,
          canReconnect: false,
        },
      });
    // keep background calendar status inside the fixture
    if (path === "/api/settings/google-calendar" && request.method() === "GET")
      return route.fulfill({
        json: {
          enabled: false,
          available: false,
          connected: false,
          status: "disabled",
          calendars: [],
          setup: {
            clientId: false,
            clientSecret: false,
            tokenKey: false,
            redirectUri:
              "http://127.0.0.1:4173/api/settings/google-calendar/callback",
          },
          counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 },
        },
      });
    // keep tunnel metadata inside the synthetic fixture
    if (path === "/api/settings/cloudflare" && request.method() === "GET")
      return route.fulfill({
        json: {
          supported: true,
          mode: "unconfigured",
          enabled: false,
          connected: false,
          tokenPresent: false,
          serviceUrl: "http://127.0.0.1:9876",
        },
      });
    // publish or reject the controlled file catalog
    if (path === "/api/settings" && request.method() === "GET") {
      state.settingsReads += 1;
      // hold only refreshes after initial setup
      if (state.settingsReads > 1 && state.nextSettingsRead !== undefined)
        await state.nextSettingsRead;
      return files
        ? route.fulfill({
            json: {
              version: 1,
              revisionId: `snapshot-r${state.revision}`,
              sources: [applicationSource(state)],
              status,
            },
          })
        : route.fulfill({
            status: 503,
            json: { error: "Synthetic settings unavailable" },
          });
    }
    if (path === "/api/settings/validate" && request.method() === "POST")
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as {
        changes: Array<{
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
      state.saves.push(body);
      const title = body.changes
        .flatMap((change) => change.patches ?? [])
        .find(
          (candidate) =>
            candidate.op === "set" && candidate.path.join(".") === "title",
        );
      // project the saved title into the next snapshot
      if (typeof title?.value === "string") state.fileTitle = title.value;
      state.revision += 1;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: [applicationSource(state)],
          status,
        },
      });
    }
    if (path === "/api/settings/remask" && request.method() === "POST")
      return route.fulfill({ status: 204, body: "" });
    return route.fulfill({
      status: 404,
      json: { error: `not mocked: ${path}` },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Global settings" }).first().click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByRole("searchbox", { name: "Search settings", exact: true }),
  ).toBeVisible();
  await selectSettingsPage(settings, "interface", "Interface");
  return { settings, state };
}

test.describe.configure({ timeout: 90_000 });

test("requires explicit confirmation before discarding browser drafts", async ({
  page,
}) => {
  const { settings, state } = await setupConfirmationSettings(page);
  const light = settings.getByRole("radio", {
    name: "Light theme",
    exact: true,
  });
  await light.click();
  const discard = settings.getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await discard.click();

  const dialog = settings.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await expect(light).toHaveAttribute("aria-checked", "true");
  const backgroundInert = await settings.evaluate((element) => {
    // detect inert ownership through either direct or wrapped backgrounds
    const covered = (target: Element | null) => {
      let current = target as HTMLElement | null;
      while (current !== null && current !== element) {
        if (current.inert) return true;
        current = current.parentElement;
      }
      return false;
    };
    return {
      header: covered(element.querySelector(":scope > .panel-header")),
      content: covered(
        element.querySelector(":scope > .client-settings-page-content"),
      ),
    };
  });
  expect(backgroundInert).toEqual({ header: true, content: true });

  // cycle only through the two confirmation actions
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(discard).toBeFocused();
  await expect(light).toHaveAttribute("aria-checked", "true");

  // backdrop cancellation preserves the same draft
  await discard.click();
  await expect(dialog).toBeVisible();
  await settings
    .locator(".split-confirmation-overlay")
    .click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await expect(light).toHaveAttribute("aria-checked", "true");

  // explicit confirmation discards locally without saving
  await discard.click();
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    settings.getByRole("radio", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(discard).toHaveCount(0);
  expect(state.renames).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("guards every Settings close route while drafts remain", async ({
  page,
}) => {
  const { settings, state } = await setupConfirmationSettings(page);
  const light = settings.getByRole("radio", {
    name: "Light theme",
    exact: true,
  });
  await light.click();
  const close = settings.getByRole("button", {
    name: "Close settings",
    exact: true,
  });
  const closeDialog = settings.getByRole("alertdialog", {
    name: "Close Settings with unsaved changes?",
    exact: true,
  });

  // the header close restores its own focus after cancellation
  await close.click();
  await expect(closeDialog).toBeVisible();
  const cancel = closeDialog.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(closeDialog).toHaveCount(0);
  await expect(close).toBeFocused();
  await expect(light).toHaveAttribute("aria-checked", "true");

  // panel Escape opens the same guard and dialog Escape cancels it
  await page.keyboard.press("Escape");
  await expect(closeDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(closeDialog).toHaveCount(0);
  await expect(light).toHaveAttribute("aria-checked", "true");

  // the persistent gear toggle uses the same guarded close path
  await page
    .getByRole("button", { name: "Global settings", exact: true })
    .click();
  await expect(closeDialog).toBeVisible();
  await closeDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(light).toHaveAttribute("aria-checked", "true");

  // confirmation closes and discards without a persistence request
  await close.click();
  await closeDialog
    .getByRole("button", { name: "Discard and close", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  expect(state.renames).toEqual([]);
  expect(state.saves).toEqual([]);

  await page
    .getByRole("button", { name: "Global settings", exact: true })
    .click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await selectSettingsPage(reopened, "interface", "Interface");
  await expect(
    reopened.getByRole("radio", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    reopened.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
});

test("does not guard clean, reverted, or successfully saved Settings", async ({
  page,
}) => {
  const { settings } = await setupConfirmationSettings(page);
  const close = settings.getByRole("button", {
    name: "Close settings",
    exact: true,
  });

  // a semantic no-op leaves no confirmation boundary
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await settings
    .getByRole("radio", { name: "Dark theme", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  await close.click();
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole("alertdialog", {
      name: "Close Settings with unsaved changes?",
      exact: true,
    }),
  ).toHaveCount(0);

  // a successful save clears the guard before the next close
  await page
    .getByRole("button", { name: "Global settings", exact: true })
    .click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await selectSettingsPage(reopened, "interface", "Interface");
  await reopened
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await reopened
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    reopened.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await reopened
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(reopened).toHaveCount(0);
  await expect(
    page.getByRole("alertdialog", {
      name: "Close Settings with unsaved changes?",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("blocks closing during a captured save transaction", async ({ page }) => {
  const { settings, state } = await setupConfirmationSettings(page);
  await selectSettingsPage(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  await rename
    .getByLabel("Name", { exact: true })
    .fill("Pending confirmation browser");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  const gate = deferred();
  state.renameGate = gate.promise;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.renames.length).toBe(1);

  const close = settings.getByRole("button", {
    name: "Close settings",
    exact: true,
  });
  await close.click({ force: true });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("alertdialog", {
      name: "Close Settings with unsaved changes?",
      exact: true,
    }),
  ).toHaveCount(0);
  gate.resolve();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await close.click();
  await expect(settings).toHaveCount(0);
});

test("prevents duplicate confirmation while async discard is pending", async ({
  page,
}) => {
  const { settings, state } = await setupConfirmationSettings(page, true);
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: "Application", exact: true })
    .click();
  const title = settings.getByRole("textbox", {
    name: "Service title",
    exact: true,
  });
  await title.fill("Pending discard title");
  const gate = deferred();
  state.nextSettingsRead = gate.promise;
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  const dialog = settings.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  const confirm = dialog.getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await confirm.click();
  await expect.poll(() => state.settingsReads).toBe(2);
  await expect(confirm).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await confirm.click({ force: true });
  expect(state.settingsReads).toBe(2);
  gate.resolve();
  await expect(dialog).toHaveCount(0);
  await expect(title).toHaveValue("Saved title");
  expect(state.saves).toEqual([]);
});

// keep the scoped overlay inside Settings across its responsive panel modes
for (const surface of [
  { id: "desktop", width: 1440, height: 900, expand: false },
  { id: "mobile", width: 390, height: 844, expand: false },
  { id: "expanded-scrolled", width: 1440, height: 900, expand: true },
] as const) {
  test(`contains the confirmation inside ${surface.id} Settings`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: surface.width,
      height: surface.height,
    });
    const consoleErrors: string[] = [];
    // retain only browser errors from this rendered confirmation flow
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const { settings } = await setupConfirmationSettings(page, true);
    // exercise the full-screen split independently from ordinary desktop width
    if (surface.expand)
      await settings
        .getByRole("button", { name: "Expand settings", exact: true })
        .click();
    const content = settings.locator(".client-settings-page-content");
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await settings
      .getByRole("radio", { name: "Light theme", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    const overlay = settings.locator(".split-confirmation-overlay");
    const card = settings.getByRole("alertdialog", {
      name: "Discard unsaved changes?",
      exact: true,
    });
    const [settingsBox, overlayBox, cardBox] = await Promise.all([
      settings.boundingBox(),
      overlay.boundingBox(),
      card.boundingBox(),
    ]);
    expect(settingsBox).not.toBeNull();
    expect(overlayBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    await page.screenshot({
      path: `/tmp/remoteagents-settings-confirmation-${surface.id}.png`,
      fullPage: true,
    });
    // the panel border may inset its absolute-positioned content box by one pixel
    expect(overlayBox!.x).toBeGreaterThanOrEqual(settingsBox!.x);
    expect(overlayBox!.x).toBeLessThanOrEqual(settingsBox!.x + 2);
    expect(overlayBox!.y).toBeGreaterThanOrEqual(settingsBox!.y);
    expect(overlayBox!.y).toBeLessThanOrEqual(settingsBox!.y + 2);
    expect(overlayBox!.x + overlayBox!.width).toBeLessThanOrEqual(
      settingsBox!.x + settingsBox!.width,
    );
    expect(overlayBox!.x + overlayBox!.width).toBeGreaterThanOrEqual(
      settingsBox!.x + settingsBox!.width - 2,
    );
    expect(overlayBox!.y + overlayBox!.height).toBeLessThanOrEqual(
      settingsBox!.y + settingsBox!.height,
    );
    expect(overlayBox!.y + overlayBox!.height).toBeGreaterThanOrEqual(
      settingsBox!.y + settingsBox!.height - 2,
    );
    expect(cardBox!.x).toBeGreaterThanOrEqual(overlayBox!.x);
    expect(cardBox!.y).toBeGreaterThanOrEqual(overlayBox!.y);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(
      overlayBox!.x + overlayBox!.width,
    );
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(
      overlayBox!.y + overlayBox!.height,
    );
    expect(consoleErrors).toEqual([]);
  });
}
