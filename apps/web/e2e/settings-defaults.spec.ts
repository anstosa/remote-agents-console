import { expect, test, type Locator, type Page } from "@playwright/test";
import { applyPatch } from "../../server/src/settings/patches.js";
import { mockAccountSocket } from "./account-fixture.js";

type SettingsPatch = {
  op: "set" | "remove" | "insert" | "move";
  path: string[];
  value?: unknown;
  index?: number;
  from?: number;
  to?: number;
};
type SettingsRequest = {
  changes: Array<{
    sourceId: string;
    revisionId: string;
    patches?: SettingsPatch[];
  }>;
};
type DefaultsFixtureState = {
  value: Record<string, unknown>;
  revision: number;
  pending: boolean;
  validations: SettingsRequest[];
  saves: SettingsRequest[];
  reveals: number;
  saveGate?: Promise<void>;
};

const secretDefault = "synthetic-default-secret-must-stay-hidden";
const protectedValue = { __racProtected: true, present: true, hasValue: true };

const behaviorSchema = {
  type: "object",
  label: "Behavior defaults",
  description: "Defaults remain visible without writing them to the file.",
  optional: true,
  default: {},
  properties: {
    defaultOff: {
      type: "boolean",
      label: "Default off",
      description: "Disabled unless explicitly enabled.",
      optional: true,
      default: false,
    },
    defaultOn: {
      type: "boolean",
      label: "Default on",
      description: "Enabled unless explicitly disabled.",
      optional: true,
      default: true,
    },
    defaultZero: {
      type: "number",
      label: "Default zero",
      optional: true,
      default: 0,
    },
    defaultEmpty: {
      type: "string",
      label: "Default empty",
      optional: true,
      default: "",
    },
    defaultMap: {
      type: "record",
      label: "Default map",
      optional: true,
      default: {},
      items: { type: "string", label: "Map value" },
    },
    emptyItems: {
      type: "array",
      label: "Empty items",
      optional: true,
      default: [],
      items: { type: "string", label: "Empty item" },
    },
    defaultNull: {
      type: "string",
      label: "Default null",
      optional: true,
      nullable: true,
      default: null,
    },
    nested: {
      type: "object",
      label: "Nested defaults",
      optional: true,
      default: {},
      properties: {
        inner: {
          type: "object",
          label: "Inner defaults",
          optional: true,
          default: {},
          properties: {
            active: {
              type: "boolean",
              label: "Nested active",
              description: "Inherited from nested schema metadata.",
              optional: true,
              default: true,
            },
          },
        },
      },
    },
    preset: {
      type: "object",
      label: "Preset defaults",
      optional: true,
      default: { mode: "safe", limit: 3 },
      properties: {
        mode: { type: "string", label: "Preset mode" },
        limit: { type: "number", label: "Preset limit" },
      },
    },
    rules: {
      type: "array",
      label: "Rules",
      optional: true,
      default: [{ label: "First rule" }, { label: "Second rule" }],
      items: {
        type: "object",
        label: "Rule",
        default: { label: "New rule" },
        properties: {
          label: { type: "string", label: "Rule name" },
          enabled: {
            type: "boolean",
            label: "Rule enabled",
            description: "Runs this rule when selected.",
            optional: true,
            default: true,
          },
        },
      },
    },
    ordinary: {
      type: "string",
      label: "Ordinary optional",
      optional: true,
    },
    secret: {
      type: "string",
      label: "Secret default",
      optional: true,
      protected: true,
      default: secretDefault,
    },
  },
};

const appSchema = {
  type: "object",
  label: "Application configuration",
  properties: {
    name: { type: "string", label: "Configuration server name" },
    publicOrigin: { type: "string", label: "Public URL" },
    behavior: behaviorSchema,
    keys: {
      type: "record",
      label: "Key tables",
      optional: true,
      items: {
        type: "record",
        label: "Bindings",
        items: {
          type: "union",
          nullable: true,
          variants: [
            { type: "string", label: "Built-in action" },
            {
              type: "object",
              label: "Terminal command",
              properties: {
                terminal: { type: "string", protected: true },
                reuse: {
                  type: "boolean",
                  label: "Reuse terminal",
                  optional: true,
                  default: false,
                },
              },
            },
          ],
        },
      },
    },
    integrations: {
      type: "object",
      properties: {
        realtime: {
          type: "object",
          label: "Voice configuration",
          properties: {
            enabled: { type: "boolean", label: "Enable voice", default: false },
            name: { type: "string", label: "Voice name", default: "Davo" },
            context: { type: "string", label: "Voice context", default: "" },
            writeToolsEnabled: {
              type: "boolean",
              label: "Write tools enabled",
              description:
                "Allows voice requests to use configured write tools.",
              optional: true,
              default: false,
            },
          },
        },
      },
    },
  },
};

// resolve a held save after lock assertions
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// publish one redacted source whose optional defaults are absent from file bytes
function applicationSource(state: DefaultsFixtureState, writable: boolean) {
  return {
    id: "app",
    label: "Application configuration",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable,
    protected: false,
    tracked: false,
    revisionId: `app-r${state.revision}`,
    apply: "rac-restart",
    value: structuredClone(state.value),
    content: `${JSON.stringify(state.value, null, 2)}\n`,
    schema: appSchema,
  };
}

// mount Settings against a stateful synthetic application source
async function setupDefaults(page: Page, options: { writable?: boolean } = {}) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const writable = options.writable !== false;
  const state: DefaultsFixtureState = {
    value: {
      name: "Defaults fixture",
      publicOrigin: "https://defaults.example.test",
      keys: { secret: { s: { terminal: protectedValue } } },
      integrations: {
        realtime: { enabled: false, name: "Davo", context: "" },
      },
    },
    revision: 1,
    pending: false,
    validations: [],
    saves: [],
    reveals: 0,
  };
  const status = () => ({
    pending: state.pending,
    targets: state.pending ? ["rac"] : [],
    effective: "known",
    restartAvailable: true,
  });
  // isolate all browser traffic from the live console
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish one authenticated controlling browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "defaults-csrf",
          active: true,
          deviceName: "Defaults browser",
          server: {
            name: "Defaults fixture",
            url: "https://defaults.example.test",
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
    // keep the dashboard inert
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
    // issue the dashboard ticket used by the shared account socket
    if (path === "/api/dashboard/ticket")
      return route.fulfill({ json: { ticket: "defaults-dashboard-ticket" } });
    // disable unrelated background surfaces
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    // expose the current restart state
    if (path === "/api/settings/status")
      return route.fulfill({ json: status() });
    // return the exact saved file without materializing defaults
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: [applicationSource(state, writable)],
          status: status(),
        },
      });
    // validate only explicitly authored changes
    if (path === "/api/settings/validate" && request.method() === "POST") {
      state.validations.push(request.postDataJSON() as SettingsRequest);
      return route.fulfill({
        json: { valid: true, issues: [], warnings: [] },
      });
    }
    // persist only the submitted paths after an optional lock gate
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as SettingsRequest;
      state.saves.push(structuredClone(body));
      // hold the captured transaction for busy-state assertions
      if (state.saveGate !== undefined) await state.saveGate;
      let persisted: unknown = state.value;
      // project every ordered patch through the production backend patcher
      for (const patch of body.changes[0]?.patches ?? []) {
        persisted = applyPatch(persisted, patch);
      }
      state.value = persisted as Record<string, unknown>;
      state.revision += 1;
      state.pending = true;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: [applicationSource(state, writable)],
          status: status(),
        },
      });
    }
    // record any accidental attempt to disclose a metadata default
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      state.reveals += 1;
      return route.fulfill({
        json: {
          value: "synthetic-saved-secret",
          revisionId: `app-r${state.revision}`,
          leaseId: "defaults-secret-lease",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    // accept security cleanup without retaining plaintext
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
  await selectSection(settings, "app", "Application");
  return { settings, state };
}

// navigate with the visible responsive settings control
async function selectSection(settings: Locator, id: string, label: string) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones use the custom dropdown
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

// prove a standard switch sits to the right and centers on its copy
async function expectRightAlignedSwitch(field: Locator, label: string) {
  const toggle = field.locator(".client-settings-toggle");
  const input = toggle.getByRole("switch", { name: label, exact: true });
  await expect(input).toBeVisible();
  await expect(toggle.locator(".client-settings-switch-track")).toBeVisible();
  const layout = await field.evaluate((element) => {
    const copy = element.querySelector<HTMLElement>(".settings-field-copy")!;
    const toggle = element.querySelector<HTMLElement>(
      ".client-settings-toggle",
    )!;
    const copyBounds = copy.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    return {
      copyRight: copyBounds.right,
      copyCenter: copyBounds.top + copyBounds.height / 2,
      toggleLeft: toggleBounds.left,
      toggleCenter: toggleBounds.top + toggleBounds.height / 2,
    };
  });
  expect(layout.toggleLeft).toBeGreaterThanOrEqual(layout.copyRight - 1);
  expect(Math.abs(layout.toggleCenter - layout.copyCenter)).toBeLessThanOrEqual(
    2,
  );
}

// keep default-backed controls honest across phone, split, and desktop layouts
for (const width of [320, 390, 1440]) {
  test(`renders omitted schema defaults without staging file writes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupDefaults(page);
    const body = settings.locator(".client-settings-page-content");
    const defaultOff = settings.locator(
      '[data-settings-path="behavior.defaultOff"]',
    );
    const defaultOn = settings.locator(
      '[data-settings-path="behavior.defaultOn"]',
    );
    const nestedActive = settings.locator(
      '[data-settings-path="behavior.nested.inner.active"]',
    );

    await expectRightAlignedSwitch(defaultOff, "Default off");
    await expect(defaultOff.getByRole("switch")).not.toBeChecked();
    await expectRightAlignedSwitch(defaultOn, "Default on");
    await expect(defaultOn.getByRole("switch")).toBeChecked();
    await expectRightAlignedSwitch(nestedActive, "Nested active");
    await expect(nestedActive.getByRole("switch")).toBeChecked();
    const defaultZero = settings.getByRole("spinbutton", { name: "Default zero", exact: true });
    await expect(defaultZero).toHaveValue("");
    await expect(defaultZero).toHaveAttribute(
      "placeholder",
      "0 (from built-in default)",
    );
    const defaultEmpty = settings.getByRole("textbox", {
      name: "Default empty",
      exact: true,
    });
    await expect(defaultEmpty).toHaveValue("");
    await expect(defaultEmpty).toHaveAttribute(
      "placeholder",
      "Empty (from built-in default)",
    );
    await expect(
      settings.getByRole("button", { name: "+ Add Empty item", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("textbox", { name: "New key", exact: true }),
    ).toBeVisible();
    await expect(
      settings.locator('[data-settings-path="behavior.defaultNull"]'),
    ).toContainText("null");
    await expect(
      settings.getByRole("button", { name: "Use a value", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("heading", { name: "Nested defaults", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("heading", { name: "Inner defaults", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("textbox", { name: "Preset mode", exact: true }),
    ).toHaveValue("safe");
    await expect(
      settings.getByRole("spinbutton", { name: "Preset limit", exact: true }),
    ).toHaveValue("3");

    const rules = settings.getByRole("group", { name: /^Rule \d+$/u });
    await expect(rules).toHaveCount(2);
    const firstRule = rules.first();
    await firstRule
      .getByRole("button", { name: "Edit Rule 1", exact: true })
      .click();
    const ruleEnabled = firstRule.locator(
      '[data-settings-path="behavior.rules.0.enabled"]',
    );
    await expectRightAlignedSwitch(ruleEnabled, "Rule enabled");
    await expect(ruleEnabled.getByRole("switch")).toBeChecked();
    await firstRule
      .getByRole("button", { name: "Close Rule 1", exact: true })
      .click();

    await expect(
      settings.getByRole("button", { name: "Add Ordinary optional" }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: /^(?:Add|Remove) Default/u }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Remove Behavior defaults" }),
    ).toHaveCount(0);
    await expect(settings.getByLabel("Secret default masked")).toBeVisible();
    await expect(body).not.toContainText(secretDefault);
    // show source identity once in navigation rather than beneath each field
    await expect(settings.locator(".settings-field-origin")).toHaveCount(0);
    await expect(defaultOff).toContainText(
      "Disabled unless explicitly enabled.",
    );
    await expect(body).not.toContainText(/\b(?:restart|recreate)\b/iu);

    await selectSection(settings, "voice", "Voice");
    const writeTools = settings.locator(
      '[data-settings-path="integrations.realtime.writeToolsEnabled"]',
    );
    await expectRightAlignedSwitch(writeTools, "Write tools enabled");
    await expect(writeTools).not.toContainText("Application configuration");
    await expect(writeTools).toContainText(
      "Allows voice requests to use configured write tools.",
    );
    await expect(writeTools.getByRole("switch")).not.toBeChecked();
    await expect(
      writeTools.getByRole("button", {
        name: /^(?:Add|Remove) Write tools enabled$/u,
      }),
    ).toHaveCount(0);
    await expect(body).not.toContainText(/\b(?:restart|recreate)\b/iu);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Validate", exact: true }),
    ).toHaveCount(0);
    expect(state.validations).toHaveLength(0);
    expect(state.saves).toHaveLength(0);
    expect(state.reveals).toBe(0);
  });
}

test("keeps a returned default explicit and saves only its authored path", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  const body = settings.locator(".client-settings-page-content");
  const field = settings.locator('[data-settings-path="behavior.defaultOff"]');
  const toggle = field.getByRole("switch", {
    name: "Default off",
    exact: true,
  });

  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await expect(body).not.toContainText(/\b(?:restart|recreate)\b/iu);

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const expected = {
    changes: [
      {
        sourceId: "app",
        revisionId: "app-r1",
        patches: [
          {
            op: "set",
            path: ["behavior", "defaultOff"],
            value: false,
          },
        ],
      },
    ],
  };
  expect(state.validations).toEqual([expected]);
  expect(state.saves).toEqual([expected]);
  expect(JSON.stringify(state.saves)).not.toContain(secretDefault);
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toBeVisible();
});

test("keeps defaulted collection add, edit, reorder, and delete controls working", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  let rules = settings.getByRole("group", { name: /^Rule \d+$/u });
  const first = rules.first();

  await first.getByRole("button", { name: "Edit Rule 1", exact: true }).click();
  await first
    .getByRole("textbox", { name: "Rule name", exact: true })
    .fill("First edited");
  await settings
    .getByRole("button", { name: "Close Rule 1", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Move Rules 1 down", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Remove Rules 1", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "+ Add Rule", exact: true })
    .click();
  rules = settings.getByRole("group", { name: /^Rule \d+$/u });
  await expect(rules).toHaveCount(2);
  await expect(
    rules.last().getByRole("button", { name: "Close Rule 2", exact: true }),
  ).toBeVisible();
  await expect(
    rules.last().getByRole("textbox", { name: "Rule name", exact: true }),
  ).toHaveValue("New rule");
  await expect(
    rules.last().getByRole("switch", { name: "Rule enabled", exact: true }),
  ).toBeChecked();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(state.saves).toHaveLength(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const savedRules = (
    (state.value.behavior as Record<string, unknown>).rules as Array<{
      label: string;
    }>
  ).map((rule) => rule.label);
  expect(savedRules).toEqual(["First edited", "New rule"]);
  const patches = state.saves[0]!.changes[0]!.patches ?? [];
  expect(patches[0]).toMatchObject({
    op: "set",
    path: ["behavior", "rules"],
  });
  expect(patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: "move", path: ["behavior", "rules"] }),
      expect.objectContaining({ op: "remove" }),
      expect.objectContaining({ op: "insert", path: ["behavior", "rules"] }),
    ]),
  );
});

test("materializes an edited nonempty object default without losing siblings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  await settings
    .getByRole("textbox", { name: "Preset mode", exact: true })
    .fill("strict");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]!.changes[0]!.patches).toEqual([
    {
      op: "set",
      path: ["behavior", "preset"],
      value: { mode: "safe", limit: 3 },
    },
    {
      op: "set",
      path: ["behavior", "preset", "mode"],
      value: "strict",
    },
  ]);
  expect((state.value.behavior as Record<string, unknown>).preset).toEqual({
    mode: "strict",
    limit: 3,
  });
});

// seed once so later sibling edits cannot restore earlier default values
test("retains repeated sibling edits after a default container is materialized", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  const mode = settings.getByRole("textbox", {
    name: "Preset mode",
    exact: true,
  });
  await mode.fill("strict");
  await settings
    .getByRole("spinbutton", { name: "Preset limit", exact: true })
    .fill("7");
  await mode.fill("careful");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect((state.value.behavior as Record<string, unknown>).preset).toEqual({
    mode: "careful",
    limit: 7,
  });
  const patches = state.saves[0]!.changes[0]!.patches ?? [];
  expect(patches[0]).toEqual({
    op: "set",
    path: ["behavior", "preset"],
    value: { mode: "safe", limit: 3 },
  });
  expect(
    patches.filter((patch) => patch.path.join(".") === "behavior.preset"),
  ).toHaveLength(1);
});

test("keeps protected keyboard defaults masked and renders their reuse switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  await selectSection(settings, "keyboard", "Keyboard shortcuts");
  const editor = settings.getByRole("region", { name: "Edit key tables" });
  const protectedRow = editor.locator('[data-key-table="secret"] [data-key-chord="s"]');
  // protected controls keep their description without repeating the source label
  await expect(protectedRow.locator(".settings-field-origin")).toHaveCount(0);
  await expect(protectedRow).toContainText("Protected terminal command");
  await expect(protectedRow).not.toContainText(secretDefault);
  const reuse = settings.locator('[data-settings-path="keys.secret.s.reuse"]');
  await expectRightAlignedSwitch(reuse, "Reuse terminal");
  await expect(reuse.getByRole("switch")).not.toBeChecked();
  await expect(
    reuse.getByRole("button", { name: /^(?:Add|Remove) Reuse terminal$/u }),
  ).toHaveCount(0);
  expect(state.reveals).toBe(0);
  expect(state.saves).toHaveLength(0);
});

test("shows read-only defaults while disabling every mutation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { settings, state } = await setupDefaults(page, { writable: false });
  const defaultOff = settings.locator(
    '[data-settings-path="behavior.defaultOff"]',
  );
  await expect(defaultOff.getByRole("switch")).toBeVisible();
  await expect(defaultOff.getByRole("switch")).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Add Ordinary optional" }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "+ Add Rule", exact: true }),
  ).toBeDisabled();
  const first = settings.getByRole("group", { name: "Rule 1", exact: true });
  await expect(
    first.getByRole("button", { name: "Edit Rule 1", exact: true }),
  ).toBeEnabled();
  await first.getByRole("button", { name: "Edit Rule 1", exact: true }).click();
  await expect(
    first.getByRole("switch", { name: "Rule enabled", exact: true }),
  ).toBeDisabled();
  await expect(
    first.getByRole("button", { name: "Move Rules 1 down", exact: true }),
  ).toBeDisabled();
  await expect(
    first.getByRole("button", { name: "Remove Rules 1", exact: true }),
  ).toBeDisabled();
  expect(state.validations).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
});

test("locks default-backed controls throughout a held save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupDefaults(page);
  const toggle = settings
    .locator('[data-settings-path="behavior.defaultOn"]')
    .getByRole("switch", { name: "Default on", exact: true });
  await toggle.click();
  const held = deferred();
  state.saveGate = held.promise;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(toggle).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Edit Rule 1", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "+ Add Rule", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Refresh files", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  held.resolve();
  state.saveGate = undefined;
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await expect(toggle).toBeEnabled();
});
