import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";

type SelectFixtureState = {
  validations: unknown[];
  saves: Array<{ body: unknown; csrf?: string }>;
};

const appSchema = {
  type: "object",
  label: "Application config",
  properties: {
    title: { type: "string", label: "Title" },
    mode: {
      type: "enum",
      label: "Mode",
      options: ["fast", "balanced", "safe"],
    },
    payload: {
      type: "union",
      label: "Payload",
      variants: [
        { type: "string", label: "Text" },
        { type: "number", label: "Count" },
        {
          type: "object",
          label: "Details",
          properties: { enabled: { type: "boolean", label: "Enabled" } },
        },
      ],
    },
    icon: {
      type: "enum",
      label: "Icon",
      optional: true,
      apply: "live",
      options: ["terminal", "potato", "heart"],
    },
  },
};

// publish custom-selector fields and local icon capabilities without installation data
const settingsSources = () => [
  {
    id: "app",
    label: "Application config",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: "app-select-r1",
    apply: "rac-restart",
    value: {
      title: "Fixture application",
      mode: "balanced",
      payload: "saved text",
      icon: "terminal",
    },
    schema: appSchema,
  },
  {
    id: "locked",
    label: "Read-only config",
    path: "/synthetic/config/locked.json",
    format: "json",
    exists: true,
    writable: false,
    protected: false,
    tracked: false,
    revisionId: "locked-select-r1",
    apply: "saved-only",
    value: { title: "Locked application", mode: "fast", payload: 4 },
    schema: appSchema,
  },
  {
    id: "icon-heart",
    label: "Heart icon",
    path: "/synthetic/config/instance-icons/heart.svg",
    format: "svg",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: "heart-select-r1",
    apply: "live",
    hasProtectedContent: false,
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1h8v8H1z"/></svg>\n',
  },
  {
    id: "icon-potato",
    label: "Potato icon",
    path: "/synthetic/config/instance-icons/potato.svg",
    format: "svg",
    exists: false,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: "potato-select-r1",
    apply: "live",
    value: "",
    hasProtectedContent: false,
  },
];

// mount the real Settings center over a synthetic versioned catalog
async function setupSelectFixture(page: Page) {
  await mockAccountSocket(page);
  const state: SelectFixtureState = { validations: [], saves: [] };
  const sources = settingsSources();
  // paint inert fixture icons without loading host artwork
  await page.route("**/instance-icons/*.svg*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#cba6f7"/></svg>',
    }),
  );
  // isolate the complete settings flow from the live console
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "settings-select-csrf",
          active: true,
          deviceName: "Select fixture",
          server: {
            name: "Framework",
            url: "https://framework.santosa.dev",
            remotes: [],
          },
          davo: { enabled: false, available: true, name: "Davo", context: "" },
        },
      });
    // render Settings in the empty-workspace split
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
    // authorize dashboard hydration
    if (path === "/api/dashboard/ticket")
      return route.fulfill({
        json: { ticket: "settings-select-dashboard-ticket" },
      });
    // expose one settled settings status
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: false,
          targets: [],
          effective: "known",
          restartAvailable: true,
        },
      });
    // return only synthetic sources
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-select-snapshot-r1",
          sources,
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    // record explicit validation
    if (path === "/api/settings/validate" && request.method() === "POST") {
      state.validations.push(request.postDataJSON());
      return route.fulfill({ json: { valid: true, issues: [] } });
    }
    // record only an explicit save
    if (path === "/api/settings" && request.method() === "PATCH") {
      state.saves.push({
        body: request.postDataJSON(),
        csrf: request.headers()["x-csrf-token"],
      });
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-select-snapshot-r2",
          sources: sources.map((source) => ({
            ...source,
            revisionId: `${source.id}-r2`,
          })),
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // disable agent update notices
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    // disable server update notices
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    return route.fulfill({
      status: 404,
      json: { error: `not mocked: ${path}` },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Global settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByRole("searchbox", { name: "Search settings", exact: true }),
  ).toBeVisible();
  return { settings, state };
}

// choose a desktop source without coupling field tests to mobile navigation
async function selectDesktopSource(settings: Locator, label: string) {
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

// choose one source through the active responsive navigator
async function selectSource(settings: Locator, id: string, label: string) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones expose only the custom section selector
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox", { name: "Settings section options", exact: true })
      .locator(`[role="option"][data-value=${JSON.stringify(id)}]`)
      .click();
    return;
  }
  await selectDesktopSource(settings, label);
}

test.describe.configure({ timeout: 60_000 });

// keep every custom selector aligned with ordinary settings inputs
for (const width of [320, 390, 1440]) {
  test(`matches icon and text selector heights with adjacent inputs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 860 });
    const { settings } = await setupSelectFixture(page);
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    const section = settings.getByRole("combobox", {
      name: "Settings section",
      exact: true,
    });
    // compare mobile navigation before leaving the initial section
    if (width <= 780) {
      const [searchBox, sectionBox] = await Promise.all([
        search.boundingBox(),
        section.boundingBox(),
      ]);
      expect(searchBox).not.toBeNull();
      expect(sectionBox).not.toBeNull();
      expect(
        Math.abs(searchBox!.height - sectionBox!.height),
      ).toBeLessThanOrEqual(1);
    }
    await selectSource(settings, "app", "Application config");
    const title = settings.getByRole("textbox", { name: "Title", exact: true });
    const mode = settings.getByRole("combobox", { name: "Mode", exact: true });
    const icon = settings.getByRole("combobox", {
      name: "Server icon",
      exact: true,
    });
    const [titleBox, modeBox, iconBox] = await Promise.all([
      title.boundingBox(),
      mode.boundingBox(),
      icon.boundingBox(),
    ]);
    expect(titleBox).not.toBeNull();
    expect(modeBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    expect(Math.abs(titleBox!.height - modeBox!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(titleBox!.height - iconBox!.height)).toBeLessThanOrEqual(1);
  });
}

test("uses custom enum, union, and icon selectors with exact staged patches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { settings, state } = await setupSelectFixture(page);
  await selectDesktopSource(settings, "Application config");
  await expect(settings.locator("select")).toHaveCount(0);

  const mode = settings.getByRole("combobox", { name: "Mode", exact: true });
  await expect(mode).toHaveAttribute("data-value", "balanced");
  await mode.click();
  const modeOptions = page.getByRole("listbox", { name: "Mode options" });
  await expect(modeOptions.getByRole("option")).toHaveText([
    "fast",
    "balanced",
    "safe",
  ]);
  await expect(
    modeOptions.locator('[role="option"][data-value="balanced"]'),
  ).toHaveAttribute("aria-selected", "true");
  await modeOptions.locator('[role="option"][data-value="safe"]').click();
  await expect(mode).toHaveAttribute("data-value", "safe");

  const payload = settings.getByRole("combobox", {
    name: "Payload type",
    exact: true,
  });
  await expect(payload).toHaveAttribute("data-value", "0");
  await payload.click();
  const payloadOptions = page.getByRole("listbox", {
    name: "Payload type options",
  });
  await expect(payloadOptions.getByRole("option")).toHaveText([
    "Text",
    "Count",
    "Details",
  ]);
  await payloadOptions.locator('[role="option"][data-value="1"]').click();
  await expect(payload).toHaveAttribute("data-value", "1");
  await expect(
    settings.locator('[data-settings-path="payload"] input[type="number"]'),
  ).toHaveValue("0");

  const icon = settings.getByRole("combobox", {
    name: "Server icon",
    exact: true,
  });
  await icon.click();
  const iconOptions = page.getByRole("listbox", {
    name: "Server icon options",
  });
  await expect(iconOptions).toHaveAttribute("data-has-icons", "true");
  await expect(
    iconOptions.locator(".settings-select-option-icon img"),
  ).toHaveCount(3);
  await iconOptions.locator('[role="option"][data-value="heart"]').click();
  await expect(icon).toHaveAttribute("data-value", "heart");

  // selector choices remain local until the explicit save action
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  expect(state.saves[0]).toEqual({
    csrf: "settings-select-csrf",
    body: {
      changes: [
        {
          sourceId: "app",
          revisionId: "app-select-r1",
          patches: [
            { op: "set", path: ["mode"], value: "safe" },
            { op: "set", path: ["payload"], value: 0 },
            { op: "set", path: ["icon"], value: "heart" },
          ],
        },
      ],
    },
  });
});

test("supports keyboard navigation and commits only on Enter or Space", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { settings, state } = await setupSelectFixture(page);
  await selectDesktopSource(settings, "Application config");
  const mode = settings.getByRole("combobox", { name: "Mode", exact: true });

  await mode.focus();
  await mode.press("Space");
  const modeOptions = page.getByRole("listbox", { name: "Mode options" });
  await expect(
    modeOptions.locator('[role="option"][data-value="balanced"]'),
  ).toHaveAttribute("data-active", "true");
  await mode.press("ArrowDown");
  await expect(
    modeOptions.locator('[role="option"][data-value="safe"]'),
  ).toHaveAttribute("data-active", "true");
  await mode.press("Home");
  await expect(
    modeOptions.locator('[role="option"][data-value="fast"]'),
  ).toHaveAttribute("data-active", "true");
  await mode.press("End");
  await expect(
    modeOptions.locator('[role="option"][data-value="safe"]'),
  ).toHaveAttribute("data-active", "true");
  await expect(mode).toHaveAttribute("data-value", "balanced");
  await mode.press("b");
  await expect(
    modeOptions.locator('[role="option"][data-value="balanced"]'),
  ).toHaveAttribute("data-active", "true");
  await expect(mode).toHaveAttribute("data-value", "balanced");
  await mode.press("End");
  await mode.press("Enter");
  await expect(mode).toHaveAttribute("data-value", "safe");

  // Tab closes the popup and follows ordinary field order
  await mode.press("Space");
  await mode.press("Tab");
  const payload = settings.getByRole("combobox", {
    name: "Payload type",
    exact: true,
  });
  await expect(modeOptions).toHaveCount(0);
  await expect(payload).toBeFocused();
  await payload.press("Space");
  const payloadOptions = page.getByRole("listbox", {
    name: "Payload type options",
  });
  await payload.press("End");
  await expect(
    payloadOptions.locator('[role="option"][data-value="2"]'),
  ).toHaveAttribute("data-active", "true");
  await payload.press("c");
  await expect(
    payloadOptions.locator('[role="option"][data-value="1"]'),
  ).toHaveAttribute("data-active", "true");
  await expect(payload).toHaveAttribute("data-value", "0");
  await payload.press("Space");
  await expect(payload).toHaveAttribute("data-value", "1");
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("dismisses with Escape or an outside click without mutating Settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { settings, state } = await setupSelectFixture(page);
  await selectDesktopSource(settings, "Application config");
  const mode = settings.getByRole("combobox", { name: "Mode", exact: true });
  await mode.click();
  await mode.press("ArrowDown");
  await mode.press("Escape");
  await expect(page.getByRole("listbox", { name: "Mode options" })).toHaveCount(
    0,
  );
  await expect(mode).toHaveAttribute("data-value", "balanced");
  await expect(settings).toBeVisible();

  await mode.click();
  await mode.press("End");
  await page.locator(".flyout-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("listbox", { name: "Mode options" })).toHaveCount(
    0,
  );
  await expect(mode).toHaveAttribute("data-value", "balanced");
  await expect(
    settings.getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("disables custom selectors for read-only sources", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { settings, state } = await setupSelectFixture(page);
  await selectDesktopSource(settings, "Read-only config");
  await expect(
    settings.getByRole("combobox", { name: "Mode", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("combobox", { name: "Payload type", exact: true }),
  ).toBeDisabled();
  await expect(settings.locator("select")).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("closes mobile navigation without selection when resize hides its trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, state } = await setupSelectFixture(page);
  const sections = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await expect(sections).toBeVisible();
  await expect(sections).toHaveAttribute("data-value", "browser");
  await sections.click();
  const popup = page.getByRole("listbox", { name: "Settings section options" });
  await expect(popup.getByRole("group")).toHaveCount(3);
  await expect(popup).toHaveAttribute("data-has-icons", "true");
  await sections.press("End");
  await expect(sections).toHaveAttribute("data-value", "browser");

  // desktop CSS removes the trigger and the portal must close without committing
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(popup).toHaveCount(0);
  await expect(sections).toBeHidden();
  await expect(
    settings.getByRole("heading", { name: "This browser", level: 2 }),
  ).toBeVisible();
  await expect(settings).toBeVisible();
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});
