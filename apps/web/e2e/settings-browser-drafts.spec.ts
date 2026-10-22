import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";
import {
  confirmSettingsClose,
  confirmSettingsDiscard,
} from "./settings-confirmation-helpers.js";

type SettingsPatch = { op: "set" | "remove"; path: string[]; value?: unknown };
type SettingsChange = {
  sourceId: string;
  revisionId: string;
  patches?: SettingsPatch[];
};
type SettingsRequest = { changes: SettingsChange[] };
type Gate = Promise<{ status: number }>;

type BrowserFixtureState = {
  deviceName: string;
  fileTitle: string;
  revision: number;
  validations: SettingsRequest[];
  fileSaves: SettingsRequest[];
  renames: Array<{ deviceName: string }>;
  validationValid: boolean;
  fileSaveStatus: number;
  renameStatus: number;
  renameGate?: Gate;
};

// resolve a held browser rename from the test
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// publish one file source for combined browser, voice and file transactions
function applicationSource(state: BrowserFixtureState) {
  return {
    id: "app",
    label: "Application",
    path: "/synthetic/config.json",
    format: "json",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: `app-r${state.revision}`,
    apply: "rac-restart",
    value: {
      title: state.fileTitle,
      items: ["Saved item"],
      integrations: { realtime: { enabled: false, name: "Davo", context: "" } },
      keys: {
        root: { "C-b": { table: "prefix" } },
        prefix: { "C-b": "send-prefix" },
      },
    },
    schema: {
      type: "object",
      label: "Application",
      properties: {
        title: { type: "string", label: "Service title" },
        items: {
          type: "array",
          label: "Items",
          items: { type: "string", label: "Item" },
        },
        integrations: {
          type: "object",
          properties: {
            realtime: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  label: "Enable voice",
                  apply: "live",
                },
                name: { type: "string", label: "Voice name", apply: "live" },
                context: {
                  type: "string",
                  label: "Voice context",
                  apply: "live",
                },
              },
            },
          },
        },
        keys: {
          type: "record",
          label: "Key tables",
          apply: "rac-restart",
          items: {
            type: "record",
            label: "Bindings",
            items: {
              type: "union",
              nullable: true,
              variants: [
                { type: "enum", options: ["send-prefix"] },
                { type: "object", properties: { table: { type: "string" } } },
              ],
            },
          },
        },
      },
    },
  };
}

// apply the small structured fixture surface after a successful file save
function applyFileChanges(
  state: BrowserFixtureState,
  request: SettingsRequest,
) {
  // inspect each saved source
  for (const change of request.changes) {
    // ignore unrelated fixture sources
    if (change.sourceId !== "app") continue;
    // apply each authored patch
    for (const patch of change.patches ?? []) {
      // project the fixture title only
      if (
        patch.op === "set" &&
        patch.path.join(".") === "title" &&
        typeof patch.value === "string"
      )
        state.fileTitle = patch.value;
    }
  }
}

// mount browser settings with optional file APIs and controlled failures
async function setupBrowserDrafts(page: Page, files = false) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const state: BrowserFixtureState = {
    deviceName: "Fixture browser",
    fileTitle: "Alpha service",
    revision: 1,
    validations: [],
    fileSaves: [],
    renames: [],
    validationValid: true,
    fileSaveStatus: 200,
    renameStatus: 200,
  };
  const status = {
    pending: false,
    targets: [],
    effective: "known",
    restartAvailable: true,
  };
  // build the current file snapshot
  const snapshot = () => ({
    version: 1,
    revisionId: `snapshot-r${state.revision}`,
    sources: files ? [applicationSource(state)] : [],
    status,
  });

  // isolate browser and file writes from the live console
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish the current browser identity
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "browser-draft-csrf",
          active: true,
          deviceName: state.deviceName,
          server: {
            name: "Fixture",
            url: "https://fixture.example.test",
            remotes: [],
          },
          davo: { enabled: false, available: true, name: "Davo", context: "" },
        },
      });
    // capture a browser identity commit
    if (path === "/api/auth/device-name" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { deviceName: string };
      state.renames.push(body);
      const outcome =
        state.renameGate === undefined
          ? { status: state.renameStatus }
          : await state.renameGate;
      // reject configured rename failures
      if (outcome.status !== 200)
        return route.fulfill({
          status: outcome.status,
          json: { error: "synthetic rename failure" },
        });
      state.deviceName = body.deviceName;
      return route.fulfill({
        json: {
          csrfToken: "browser-draft-csrf",
          active: true,
          deviceName: state.deviceName,
          server: {
            name: "Fixture",
            url: "https://fixture.example.test",
            remotes: [],
          },
          davo: { enabled: false, available: true, name: "Davo", context: "" },
        },
      });
    }
    // keep the dashboard empty
    if (path === "/api/dashboard")
      return route.fulfill({
        json: {
          generation: 1,
          editor: false,
          adapters: {},
          agents: [],
          projects: [],
          cleanupPending: 0,
          reviews: [],
          reviewTour: { available: false, reason: "generator_unavailable" },
        },
      });
    // bootstrap the dashboard socket
    if (path === "/api/dashboard/ticket")
      return route.fulfill({ json: { ticket: "browser-draft-ticket" } });
    // disable agent updates
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    // hide server updates
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    // publish a settled runtime
    if (path === "/api/settings/status") return route.fulfill({ json: status });
    // expose files only to combined cases
    if (path === "/api/settings" && request.method() === "GET")
      return files
        ? route.fulfill({ json: snapshot() })
        : route.fulfill({
            status: 503,
            json: { error: "No settings files in browser-only fixture" },
          });
    // capture file validation
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as SettingsRequest;
      state.validations.push(body);
      return route.fulfill({
        json: { valid: state.validationValid, issues: [], warnings: [] },
      });
    }
    // capture file persistence
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as SettingsRequest;
      state.fileSaves.push(body);
      // reject configured file conflicts
      if (state.fileSaveStatus !== 200)
        return route.fulfill({
          status: state.fileSaveStatus,
          json: { error: "synthetic file save failure" },
        });
      applyFileChanges(state, body);
      state.revision += 1;
      return route.fulfill({ json: snapshot() });
    }
    // accept disclosure cleanup
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
  await selectSection(settings, "interface", "Interface");
  return { settings, state };
}

// navigate with whichever settings selector is visible
async function selectSection(settings: Locator, id: string, label: string) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // use the compact selector when visible
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox", { name: "Settings section options", exact: true })
      .locator(`[role="option"][data-value=${JSON.stringify(id)}]`)
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: new RegExp(`^${label}`, "u") })
    .click();
}

// stage every browser-backed preference across its owning pages
async function stageAllBrowserPreferences(settings: Locator) {
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Larger terminal font", exact: true })
    .click();
  await settings
    .getByRole("switch", { name: "Reduced motion", exact: true })
    .check();
  await settings
    .getByRole("switch", { name: "Flyout markers", exact: true })
    .check();
  await selectSection(settings, "projects", "Projects");
  await settings
    .getByRole("switch", { name: "Dynamic worktrees", exact: true })
    .uncheck();
  await selectSection(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = settings
    .page()
    .getByRole("dialog", { name: "Rename browser" });
  await rename.getByLabel("Name", { exact: true }).fill("Staged browser");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await selectSection(settings, "interface", "Interface");
}

// retain the upstream sound preference on its new interface page
test("saves notification sounds from Interface without changing files", async ({ page }) => {
  const { settings, state } = await setupBrowserDrafts(page, true);
  const sounds = settings.getByRole("switch", { name: "Notification sounds", exact: true });
  await expect(sounds).toBeChecked();
  await sounds.uncheck();
  await settings.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("rac.notification-sounds"))).toBe("disabled");
  expect(state.fileSaves).toHaveLength(0);
  await selectSection(settings, "browser", "This browser");
  await expect(sounds).toHaveCount(0);
  await selectSection(settings, "interface", "Interface");
  await expect(sounds).not.toBeChecked();
});

// read only applied browser state outside the settings draft
const appliedBrowserState = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    font: localStorage.getItem("rac.terminal-font-size"),
    motion: document.documentElement.dataset.motion ?? null,
    flyout: document.documentElement.dataset.flyoutMarkers ?? null,
    dynamic: localStorage.getItem("rac.dynamic-worktrees"),
  }));

// locate the global transaction actions
const actions = (settings: Locator) => ({
  validate: settings.getByRole("button", { name: "Validate", exact: true }),
  discard: settings.getByRole("button", {
    name: "Discard changes",
    exact: true,
  }),
  save: settings.getByRole("button", { name: /^(?:Save changes|Saving…)$/u }),
});

const defaultAppliedState = {
  theme: null,
  font: null,
  motion: null,
  flyout: null,
  dynamic: null,
};

test.describe.configure({ timeout: 90_000 });

test("stages all browser preferences and applies them together without file writes", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  await stageAllBrowserPreferences(settings);
  const navigation = settings.getByRole("navigation", {
    name: "Settings sources",
    exact: true,
  });
  await expect(
    navigation.getByRole("button", {
      name: /^This browser.*Unsaved changes$/u,
    }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: /^Interface.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: /^Projects.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(settings).toContainText("12px");
  await expect(
    settings.getByRole("switch", { name: "Reduced motion", exact: true }),
  ).toBeChecked();
  await expect(
    settings.getByRole("switch", { name: "Flyout markers", exact: true }),
  ).toBeChecked();
  await selectSection(settings, "projects", "Projects");
  await expect(
    settings.getByRole("switch", { name: "Dynamic worktrees", exact: true }),
  ).not.toBeChecked();
  await selectSection(settings, "browser", "This browser");
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Staged browser");
  expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
  expect(state.renames).toEqual([]);

  await actions(settings).save.click();
  await expect(actions(settings).save).toHaveCount(0);
  await expect(
    navigation.getByLabel("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.fileSaves).toEqual([]);
  expect(state.renames).toEqual([{ deviceName: "Staged browser" }]);
  expect(await appliedBrowserState(page)).toEqual({
    theme: "latte",
    font: "12",
    motion: "reduced",
    flyout: "enabled",
    dynamic: "disabled",
  });
});

test("closes open file collection editors after a browser-only save", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page, true);
  await selectSection(settings, "app", "Application");
  let item = settings.getByRole("group", { name: /^Item \d+$/u }).first();
  await item.getByRole("button", { name: /^Edit Item \d+$/u }).click();
  await expect(item.getByRole("textbox")).toHaveValue("Saved item");

  await selectSection(settings, "interface", "Interface");
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await actions(settings).save.click();
  await expect(actions(settings).save).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.fileSaves).toEqual([]);

  await selectSection(settings, "app", "Application");
  item = settings.getByRole("group", { name: /^Item \d+$/u }).first();
  await expect(
    item.getByRole("button", { name: /^Edit Item \d+$/u }),
  ).toBeVisible();
  await expect(item.getByRole("textbox")).toHaveCount(0);
});

test("retains Interface through file refresh and discard", async ({ page }) => {
  const { settings } = await setupBrowserDrafts(page, true);
  await selectSection(settings, "interface", "Interface");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Interface", exact: true }),
  ).toBeVisible();

  await selectSection(settings, "app", "Application");
  await settings
    .getByRole("textbox", { name: "Service title", exact: true })
    .fill("Discarded service title");
  await selectSection(settings, "interface", "Interface");
  await actions(settings).discard.click();
  await confirmSettingsDiscard(page);
  await expect(
    settings.getByRole("heading", { name: "Interface", exact: true }),
  ).toBeVisible();
});

test("updates an untouched rename dialog when the live browser name changes", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  await selectSection(settings, "browser", "This browser");
  state.deviceName = "Alice";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Alice");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  const input = rename.getByLabel("Name", { exact: true });
  await expect(input).toHaveValue("Alice");

  state.deviceName = "Bob";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(input).toHaveValue("Bob");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await expect(actions(settings).save).toHaveCount(0);
  expect(state.renames).toEqual([]);
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Bob");
});

test("preserves an explicit rename edit across a live browser name change", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  await selectSection(settings, "browser", "This browser");
  state.deviceName = "Alice";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Alice");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  const input = rename.getByLabel("Name", { exact: true });
  await input.fill("Personal edit");

  state.deviceName = "Bob";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(input).toHaveValue("Personal edit");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Personal edit");
  await actions(settings).save.click();
  await expect
    .poll(() => state.renames)
    .toEqual([{ deviceName: "Personal edit" }]);
});

test("preserves an externally applied untouched theme while saving another browser draft", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  await settings
    .getByRole("button", { name: "Larger terminal font", exact: true })
    .click();
  await page.evaluate(() => {
    localStorage.setItem("rac.color-theme", "latte");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "rac.color-theme",
        newValue: "latte",
      }),
    );
  });
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => appliedBrowserState(page))
    .toEqual({
      ...defaultAppliedState,
      theme: "latte",
    });

  await actions(settings).save.click();
  expect(state.renames).toEqual([]);
  expect(await appliedBrowserState(page)).toEqual({
    ...defaultAppliedState,
    theme: "latte",
    font: "12",
  });
});

test("collapses reverted browser drafts and discards unapplied values", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  const controls = actions(settings);
  await stageAllBrowserPreferences(settings);
  await settings
    .getByRole("radio", { name: "Dark theme", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Reset terminal font", exact: true })
    .click();
  await settings
    .getByRole("switch", { name: "Reduced motion", exact: true })
    .uncheck();
  await settings
    .getByRole("switch", { name: "Flyout markers", exact: true })
    .uncheck();
  await selectSection(settings, "projects", "Projects");
  await settings
    .getByRole("switch", { name: "Dynamic worktrees", exact: true })
    .check();
  await selectSection(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  await rename.getByLabel("Name", { exact: true }).fill("Fixture browser");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await selectSection(settings, "interface", "Interface");
  await expect(controls.validate).toHaveCount(0);
  await expect(controls.discard).toHaveCount(0);
  await expect(controls.save).toHaveCount(0);

  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Larger terminal font", exact: true })
    .click();
  await expect(controls.validate).toHaveCount(0);
  expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
  expect(state.validations).toEqual([]);
  await controls.discard.click();
  await confirmSettingsDiscard(page);
  await expect(
    settings.getByRole("radio", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(settings).toContainText("11px");
  expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
});

test("drops browser drafts when Settings closes", async ({ page }) => {
  const { settings, state } = await setupBrowserDrafts(page);
  await stageAllBrowserPreferences(settings);
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await confirmSettingsClose(page);
  await expect(settings).toHaveCount(0);
  expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
  expect(state.renames).toEqual([]);

  await page.getByRole("button", { name: "Global settings" }).first().click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await selectSection(reopened, "interface", "Interface");
  await expect(
    reopened.getByRole("radio", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    reopened.getByRole("switch", { name: "Reduced motion", exact: true }),
  ).not.toBeChecked();
  await expect(
    reopened.getByRole("switch", { name: "Flyout markers", exact: true }),
  ).not.toBeChecked();
  await selectSection(reopened, "projects", "Projects");
  await expect(
    reopened.getByRole("switch", { name: "Dynamic worktrees", exact: true }),
  ).toBeChecked();
  await selectSection(reopened, "browser", "This browser");
  await expect(
    reopened.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Fixture browser");
  await expect(actions(reopened).save).toHaveCount(0);
});

test("retains browser, file and voice drafts through settings navigation", async ({
  page,
}) => {
  const { settings } = await setupBrowserDrafts(page, true);
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await selectSection(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  await rename.getByLabel("Name", { exact: true }).fill("Navigation draft");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await selectSection(settings, "app", "Application");
  await settings
    .getByRole("textbox", { name: "Service title", exact: true })
    .fill("File draft");
  await selectSection(settings, "voice", "Voice");
  await settings
    .getByRole("switch", { name: "Enable Davo", exact: true })
    .check();
  await settings
    .getByRole("textbox", { name: "Davo name", exact: true })
    .fill("Voice draft");

  await selectSection(settings, "interface", "Interface");
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await selectSection(settings, "browser", "This browser");
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Navigation draft");
  await selectSection(settings, "app", "Application");
  await expect(
    settings.getByRole("textbox", { name: "Service title", exact: true }),
  ).toHaveValue("File draft");
  await selectSection(settings, "voice", "Voice");
  await expect(
    settings.getByRole("switch", { name: "Enable Voice draft", exact: true }),
  ).toBeChecked();
  await expect(
    settings.getByRole("textbox", { name: "Davo name", exact: true }),
  ).toHaveValue("Voice draft");
  await expect(actions(settings).save).toBeVisible();
});

// verify both file failure boundaries
for (const failure of ["validation", "save"] as const) {
  test(`does not apply browser preferences when file ${failure} fails`, async ({
    page,
  }) => {
    const { settings, state } = await setupBrowserDrafts(page, true);
    // choose one file failure boundary
    if (failure === "validation") state.validationValid = false;
    else state.fileSaveStatus = 409;
    await settings
      .getByRole("radio", { name: "Light theme", exact: true })
      .click();
    await selectSection(settings, "browser", "This browser");
    await settings
      .getByRole("button", { name: "Rename browser name", exact: true })
      .click();
    const rename = page.getByRole("dialog", { name: "Rename browser" });
    await rename.getByLabel("Name", { exact: true }).fill("Blocked browser");
    await rename.getByRole("button", { name: "Done", exact: true }).click();
    await selectSection(settings, "app", "Application");
    await settings
      .getByRole("textbox", { name: "Service title", exact: true })
      .fill("Blocked file");
    await actions(settings).save.click();

    await expect(actions(settings).save).toBeVisible();
    expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
    expect(state.renames).toEqual([]);
    expect(state.validations).toHaveLength(1);
    expect(state.fileSaves).toHaveLength(failure === "save" ? 1 : 0);
    await selectSection(settings, "interface", "Interface");
    await expect(
      settings.getByRole("radio", { name: "Light theme", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await selectSection(settings, "browser", "This browser");
    await expect(
      settings.getByRole("group", { name: "Name", exact: true }),
    ).toContainText("Blocked browser");
  });
}

test("retains browser drafts and reports partial completion when rename fails after file save", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page, true);
  state.renameStatus = 503;
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await selectSection(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename browser" });
  await rename.getByLabel("Name", { exact: true }).fill("Rejected browser");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await selectSection(settings, "app", "Application");
  await settings
    .getByRole("textbox", { name: "Service title", exact: true })
    .fill("Saved file");
  await actions(settings).save.click();

  await expect(page.getByRole("alert")).toContainText(
    /saved.*browser|browser.*(?:not|could)/iu,
  );
  expect(state.validations).toHaveLength(1);
  expect(state.fileSaves).toHaveLength(1);
  expect(state.fileTitle).toBe("Saved file");
  expect(state.renames).toEqual([{ deviceName: "Rejected browser" }]);
  expect(await appliedBrowserState(page)).toEqual(defaultAppliedState);
  await expect(
    settings.getByRole("textbox", { name: "Service title", exact: true }),
  ).toHaveValue("Saved file");
  await selectSection(settings, "interface", "Interface");
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await selectSection(settings, "browser", "This browser");
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Rejected browser");
  await expect(actions(settings).save).toBeVisible();
});

test("locks visible browser controls and page changes while the shared save is pending", async ({
  page,
}) => {
  const { settings, state } = await setupBrowserDrafts(page);
  const held = deferred<{ status: number }>();
  state.renameGate = held.promise;
  await stageAllBrowserPreferences(settings);
  await actions(settings).save.click();
  await expect.poll(() => state.renames.length).toBe(1);
  await expect(
    settings.getByRole("radio", { name: "Dark theme", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Larger terminal font", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("switch", { name: "Reduced motion", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("switch", { name: "Flyout markers", exact: true }),
  ).toBeDisabled();
  await selectSection(settings, "projects", "Projects");
  await expect(
    settings.getByRole("heading", { name: "Interface", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    settings.getByRole("switch", { name: "Dynamic worktrees", exact: true }),
  ).toHaveCount(0);
  await expect(actions(settings).validate).toHaveCount(0);
  await expect(actions(settings).discard).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  held.resolve({ status: 200 });
  await expect(actions(settings).save).toHaveCount(0);
  expect(state.renames).toEqual([{ deviceName: "Staged browser" }]);
  expect(await appliedBrowserState(page)).toEqual({
    theme: "latte",
    font: "12",
    motion: "reduced",
    flyout: "enabled",
    dynamic: "disabled",
  });
});

test("omits apply pills and advance restart guidance from preference pages", async ({
  page,
}) => {
  const { settings } = await setupBrowserDrafts(page, true);
  const panel = settings.locator(".settings-source-panel");
  await expect(panel.locator(".settings-apply-state")).toHaveCount(0);
  await expect(panel).not.toContainText(/\b(?:restart|recreate)\b/iu);
  await selectSection(settings, "voice", "Voice");
  await expect(panel.locator(".settings-apply-state")).toHaveCount(0);
  await expect(panel).not.toContainText(/\b(?:restart|recreate)\b/iu);
  await selectSection(settings, "keyboard", "Keyboard shortcuts");
  await expect(panel.locator(".settings-apply-state")).toHaveCount(0);
  await expect(panel).not.toContainText(/\b(?:restart|recreate)\b/iu);
});
