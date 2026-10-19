import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture";
import { confirmSettingsDiscard } from "./settings-confirmation-helpers.js";

type SettingsPatch = { op: "set" | "remove"; path: string[]; value?: unknown };
type ShortcutFixtureState = {
  runtimeKeys: Record<string, unknown>;
  savedKeys: Record<string, unknown>;
  saves: Array<{
    changes: Array<{ sourceId: string; patches: SettingsPatch[] }>;
  }>;
  validations: unknown[];
  reveals: unknown[];
  remasks: unknown[];
  saveStatus: number;
};
type ShortcutWatchWindow = typeof window & {
  __shortcutSecretSeen?: boolean;
  __shortcutSecretTimer?: number;
};

const appSource = (state: ShortcutFixtureState) => ({
  id: "app",
  label: "Application config",
  path: "/checkout/config/config.json",
  format: "json",
  exists: true,
  writable: true,
  protected: false,
  tracked: false,
  revisionId: "app-r1",
  apply: "rac-restart",
  value: {
    name: "Shortcut server",
    keys: state.savedKeys,
    integrations: {
      realtime: {
        enabled: false,
        name: "Davo",
        context: "",
        writeToolsEnabled: false,
      },
    },
  },
  schema: {
    type: "object",
    properties: {
      name: { type: "string", label: "Server name" },
      keys: {
        type: "json",
        label: "Key tables",
        description: "Advanced key-table configuration.",
        optional: true,
        apply: "rac-restart",
      },
      integrations: {
        type: "object",
        properties: {
          realtime: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              context: { type: "string" },
              writeToolsEnabled: { type: "boolean" },
            },
          },
        },
      },
    },
  },
});

// apply the same direct object patches emitted by the Settings editor
const applyPatch = (root: Record<string, unknown>, patch: SettingsPatch) => {
  // remove the complete keys object explicitly
  if (
    patch.path.length === 1 &&
    patch.path[0] === "keys" &&
    patch.op === "remove"
  ) {
    delete root.keys;
    return;
  }
  let target = root;
  // create intermediate key tables for additions
  for (const key of patch.path.slice(0, -1)) {
    const child = target[key];
    if (child === null || typeof child !== "object" || Array.isArray(child))
      target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  const leaf = patch.path.at(-1)!;
  // preserve remove versus explicit null
  if (patch.op === "remove") delete target[leaf];
  else target[leaf] = structuredClone(patch.value);
};

// provide a complete stateful settings source and a separately running dashboard config
async function setupShortcutSettings(
  page: Page,
  options: {
    runtimeKeys?: Record<string, unknown>;
    savedKeys?: Record<string, unknown>;
    width?: number;
  } = {},
) {
  await mockAccountSocket(page);
  await page.setViewportSize({ width: options.width ?? 1400, height: 900 });
  const state: ShortcutFixtureState = {
    runtimeKeys: structuredClone(options.runtimeKeys ?? {}),
    savedKeys: structuredClone(options.savedKeys ?? {}),
    saves: [],
    validations: [],
    reveals: [],
    remasks: [],
    saveStatus: 200,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "shortcut-csrf",
          active: true,
          deviceName: "Shortcut browser",
          server: {
            name: "Shortcut server",
            url: "https://shortcut.test",
            remotes: [],
          },
          davo: { enabled: false, available: false, name: "Davo", context: "" },
        },
      });
    // keep runtime dispatch independent from unsaved and restart-pending config
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
          keys: state.runtimeKeys,
        },
      });
    if (path === "/api/dashboard/ticket")
      return route.fulfill({ json: { ticket: "shortcut-ticket" } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: state.saves.length > 0,
          targets: state.saves.length > 0 ? ["rac"] : [],
          effective: "known",
          restartAvailable: true,
        },
      });
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-r1",
          sources: [appSource(state)],
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    if (path === "/api/settings/validate" && request.method() === "POST") {
      state.validations.push(request.postDataJSON());
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    }
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as {
        changes: Array<{ sourceId: string; patches: SettingsPatch[] }>;
      };
      state.saves.push(structuredClone(body));
      // preserve the client draft when persistence fails
      if (state.saveStatus !== 200)
        return route.fulfill({
          status: state.saveStatus,
          json: { error: "shortcut fixture conflict" },
        });
      const value = appSource(state).value as Record<string, unknown>;
      // apply only the application source transaction
      for (const change of body.changes) {
        if (change.sourceId !== "app") continue;
        for (const patch of change.patches ?? []) applyPatch(value, patch);
      }
      state.savedKeys = structuredClone(
        (value.keys as Record<string, unknown> | undefined) ?? {},
      );
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-r2",
          sources: [appSource(state)],
          status: {
            pending: true,
            targets: ["rac"],
            effective: "known",
            restartAvailable: true,
            recoveryCommand: "rac-settings-recover fixture",
          },
        },
      });
    }
    // disclose only synthetic fixture text for protected-terminal races
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      const body = request.postDataJSON() as { revisionId: string };
      state.reveals.push(body);
      return route.fulfill({
        json: {
          value: "synthetic-terminal-command",
          revisionId: body.revisionId,
          leaseId: `shortcut-lease-${state.reveals.length}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    if (path === "/api/settings/remask" && request.method() === "POST") {
      state.remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({
      status: 404,
      json: { error: `not mocked: ${path}` },
    });
  });
  // prove legacy browser preferences are ignored by both dispatch and editing
  await page.addInitScript(() =>
    localStorage.setItem(
      "rac.keyboard-shortcuts",
      JSON.stringify({ prefix: { c: ["C-F12"] } }),
    ),
  );
  await page.goto("/");
  return state;
}

// navigate with either desktop buttons or the mobile custom selector
async function selectKeyboardSettings(settings: Locator) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones use the custom dropdown
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox")
      .getByRole("option", { name: "Keyboard shortcuts", exact: true })
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: "Keyboard shortcuts", exact: true })
    .click();
}

// open the dedicated server keyboard section
async function openKeyboardSettings(page: Page) {
  await page.getByRole("button", { name: "Global settings" }).first().click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await selectKeyboardSettings(settings);
  // command-oriented coverage uses the exclusive quick-assignment view
  const view = settings.getByRole("combobox", {
    name: "Keyboard editor view",
    exact: true,
  });
  if (await view.count()) {
    await view.click();
    await page
      .getByRole("listbox", {
        name: "Keyboard editor view options",
        exact: true,
      })
      .getByRole("option", { name: "Command shortcuts", exact: true })
      .click();
  }
  await expect(
    settings.getByRole("region", { name: "Edit keyboard shortcuts" }),
  ).toBeVisible();
  return settings;
}

// open the primary table-oriented keyboard editor
async function openKeyTables(page: Page) {
  const settings = await openKeyboardSettings(page);
  await chooseEditorOption(settings, "Keyboard editor view", "Key tables");
  const editor = settings.getByRole("region", {
    name: "Edit key tables",
    exact: true,
  });
  await expect(editor).toBeVisible();
  return { settings, editor };
}

const command = (page: Page, id: string) =>
  page.locator(`[data-shortcut-command=${JSON.stringify(id)}]`);

// select an explicit option in the shared custom dropdown
async function chooseEditorOption(
  settings: Locator,
  label: string,
  option: string,
) {
  await settings.getByRole("combobox", { name: label, exact: true }).click();
  await settings
    .page()
    .getByRole("listbox", { name: `${label} options`, exact: true })
    .getByRole("option", { name: option, exact: true })
    .click();
}

// align key-table selectors with their adjacent text control
for (const width of [320, 390, 1440]) {
  test(`keeps key-table dropdowns the same height as text controls at ${width}px`, async ({
    page,
  }) => {
    await setupShortcutSettings(page, { width });
    const { settings, editor } = await openKeyTables(page);
    const view = settings.getByRole("combobox", {
      name: "Keyboard editor view",
      exact: true,
    });
    const table = editor.getByRole("combobox", {
      name: "Key table",
      exact: true,
    });
    const name = editor.getByRole("textbox", {
      name: "New table name",
      exact: true,
    });
    const [viewBox, tableBox, nameBox] = await Promise.all([
      view.boundingBox(),
      table.boundingBox(),
      name.boundingBox(),
    ]);
    expect(viewBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(Math.abs(viewBox!.height - nameBox!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(tableBox!.height - nameBox!.height)).toBeLessThanOrEqual(1);
  });
}

// table and binding controls must compile only staged file-backed changes
for (const width of [390, 1440]) {
  test(`configures key tables with captured keys and table dropdowns at ${width}px`, async ({
    page,
  }) => {
    const state = await setupShortcutSettings(page, { width });
    const settings = await openKeyboardSettings(page);
    await chooseEditorOption(settings, "Keyboard editor view", "Key tables");
    const editor = settings.getByRole("region", {
      name: "Edit key tables",
      exact: true,
    });
    await expect(editor.locator("select")).toHaveCount(0);
    await editor
      .getByRole("textbox", { name: "New table name", exact: true })
      .fill("tools");
    await editor
      .getByRole("button", { name: "Add table", exact: true })
      .click();
    await expect(
      editor.getByRole("combobox", { name: "Key table", exact: true }),
    ).toHaveAttribute("data-value", "tools");
    await editor
      .getByRole("button", { name: "Add binding", exact: true })
      .click();
    const form = editor.getByRole("group", {
      name: "New binding in tools",
      exact: true,
    });
    await form
      .getByRole("textbox", { name: "Key for binding in tools", exact: true })
      .press("Control+Shift+k");
    await chooseEditorOption(form, "Binding type", "Action");
    await chooseEditorOption(form, "Action", "Command palette");
    await form
      .getByRole("button", { name: "Apply binding", exact: true })
      .click();
    await expect(editor.locator('[data-key-chord="C-S-k"]')).toBeVisible();
    await chooseEditorOption(editor, "Key table", "root");
    const prefix = editor.locator('[data-key-chord="C-b"]');
    await prefix
      .getByRole("button", { name: "Edit binding", exact: true })
      .click();
    const edit = editor.getByRole("group", {
      name: "Edit binding C-b in root",
      exact: true,
    });
    await chooseEditorOption(edit, "Binding type", "Switch table");
    await chooseEditorOption(edit, "Switch to table", "tools");
    await edit
      .getByRole("button", { name: "Apply binding", exact: true })
      .click();
    await expect(prefix).toContainText("Switch to the tools table");
    expect(state.validations).toHaveLength(0);
    expect(state.saves).toHaveLength(0);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    expect(state.savedKeys).toEqual({
      tools: { "C-S-k": "command-palette" },
      root: { "C-b": { table: "tools" } },
    });
    await expect(
      page.getByRole("status").filter({ hasText: "Restart pending" }),
    ).toBeVisible();
  });
}

test("retains an Add binding form after active chord collisions without staging a draft", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page, {
    savedKeys: { prefix: { v: "new-terminal" } },
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "prefix");
  await editor
    .getByRole("button", { name: "Add binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "New binding in prefix",
    exact: true,
  });
  const recorder = form.getByRole("textbox", {
    name: "Key for binding in prefix",
    exact: true,
  });
  await recorder.press("c");
  await chooseEditorOption(form, "Action", "Command palette");
  await form
    .getByRole("button", { name: "Apply binding", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText("already assigned");
  await expect(form).toBeVisible();
  await expect(
    form.getByRole("combobox", { name: "Action", exact: true }),
  ).toHaveAttribute("data-value", "command-palette");
  // configured rows collide just like inherited defaults
  await recorder.press("v");
  await form
    .getByRole("button", { name: "Apply binding", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText("already assigned");
  await expect(form).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.validations).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
});

test("preserves an unapplied binding form when the active editor and table are reselected", async ({
  page,
}) => {
  await setupShortcutSettings(page);
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "prefix");
  await editor
    .getByRole("button", { name: "Add binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "New binding in prefix",
    exact: true,
  });
  const recorder = form.getByRole("textbox", {
    name: "Key for binding in prefix",
    exact: true,
  });
  await recorder.press("Control+F9");
  await chooseEditorOption(form, "Binding type", "Terminal command");
  await form
    .getByRole("textbox", { name: "New terminal command", exact: true })
    .fill("  printf synthetic-form  ");
  await chooseEditorOption(settings, "Keyboard editor view", "Key tables");
  await expect(form).toBeVisible();
  await chooseEditorOption(editor, "Key table", "prefix");
  await expect(form).toBeVisible();
  await expect(recorder).toHaveValue("Ctrl + F9");
  await expect(
    form.getByRole("textbox", { name: "New terminal command", exact: true }),
  ).toHaveValue("  printf synthetic-form  ");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
});

test("reactivates an explicit null slot at its raw chord and labels custom null removal", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page, {
    savedKeys: { tools: { "S-C-c": null } },
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "tools");
  const disabled = editor.locator('[data-key-chord="C-S-c"]');
  await expect(disabled).toContainText("Disabled binding");
  await expect(
    disabled.getByRole("button", { name: "Remove binding", exact: true }),
  ).toBeEnabled();
  await expect(
    disabled.getByRole("button", { name: "Restore default", exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole("button", { name: "Add binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "New binding in tools",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: "Key for binding in tools", exact: true })
    .press("Control+Shift+c");
  await chooseEditorOption(form, "Action", "Command palette");
  await form
    .getByRole("button", { name: "Apply binding", exact: true })
    .click();
  await expect(editor.locator('[data-key-chord="C-S-c"]')).toContainText(
    "Command palette",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.savedKeys).toEqual({ tools: { "S-C-c": "command-palette" } });
});

test("retargets inbound bindings on table rename and blocks removal until references are repaired", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page, {
    savedKeys: { root: { "C-g": { table: "tools" } }, tools: {} },
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "tools");
  await expect(
    editor.getByText("Entered by: root: Ctrl + G", { exact: true }),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Remove tools table", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "still referenced by root.C-g",
  );
  await editor
    .getByRole("button", { name: "Rename table", exact: true })
    .click();
  await editor
    .getByRole("textbox", { name: "Table name", exact: true })
    .fill("utilities");
  await editor
    .getByRole("button", { name: "Apply table name", exact: true })
    .click();
  await expect(
    editor.getByRole("combobox", { name: "Key table", exact: true }),
  ).toHaveAttribute("data-value", "utilities");
  await expect(
    editor.getByText("Entered by: root: Ctrl + G", { exact: true }),
  ).toBeVisible();
  await chooseEditorOption(editor, "Key table", "root");
  const inbound = editor.locator('[data-key-chord="C-g"]');
  await expect(inbound).toContainText("Switch to the utilities table");
  await inbound
    .getByRole("button", { name: "Edit binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "Edit binding C-g in root",
    exact: true,
  });
  await chooseEditorOption(form, "Binding type", "Action");
  await chooseEditorOption(form, "Action", "Command palette");
  await form
    .getByRole("button", { name: "Apply binding", exact: true })
    .click();
  await chooseEditorOption(editor, "Key table", "utilities");
  await editor
    .getByRole("button", { name: "Remove utilities table", exact: true })
    .click();
  await expect(
    editor.getByRole("combobox", { name: "Key table", exact: true }),
  ).toHaveAttribute("data-value", "root");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.savedKeys).toEqual({ root: { "C-g": "command-palette" } });
});

test("moves a raw-spelled terminal binding without changing command bytes or reuse", async ({
  page,
}) => {
  const terminal = {
    terminal: "  env SYNTHETIC_TOKEN=fake /usr/bin/gh dash  ",
    reuse: false,
  };
  const state = await setupShortcutSettings(page, {
    savedKeys: { tools: { "C-G": terminal } },
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "tools");
  const row = editor.locator('[data-key-chord="C-S-g"]');
  await expect(row).toContainText("Terminal running gh");
  await expect(editor).not.toContainText("SYNTHETIC_TOKEN");
  await row
    .getByRole("button", { name: "Change key C-S-g in tools", exact: true })
    .click();
  await row
    .getByRole("textbox", { name: "New key for C-S-g in tools", exact: true })
    .press("Alt+h");
  await row
    .getByRole("button", { name: "Apply shortcut", exact: true })
    .click();
  await expect(editor.locator('[data-key-chord="M-h"]')).toContainText(
    "Terminal running gh",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = state.saves[0]!.changes[0]!.patches;
  expect(patches).toEqual(
    expect.arrayContaining([
      { op: "remove", path: ["keys", "tools", "C-G"] },
      { op: "set", path: ["keys", "tools", "M-h"], value: terminal },
    ]),
  );
  expect(state.savedKeys).toEqual({ tools: { "M-h": terminal } });
});

test("locks editor navigation during held validation and preserves an unapplied form after failure", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page);
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "prefix");
  await editor
    .getByRole("button", { name: "Disable c in prefix", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Add binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "New binding in prefix",
    exact: true,
  });
  const recorder = form.getByRole("textbox", {
    name: "Key for binding in prefix",
    exact: true,
  });
  await recorder.press("Control+F9");
  await chooseEditorOption(form, "Binding type", "Terminal command");
  const commandInput = form.getByRole("textbox", {
    name: "New terminal command",
    exact: true,
  });
  await commandInput.fill("  printf held-form  ");
  let releaseValidation!: () => void;
  let validationRequests = 0;
  const heldValidation = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  await page.route("**/api/settings/validate", async (route) => {
    validationRequests += 1;
    await heldValidation;
    await route.fulfill({ json: { valid: false, issues: [], warnings: [] } });
  });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => validationRequests).toBe(1);
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("combobox", {
      name: "Keyboard editor view",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("combobox", { name: "Key table", exact: true }),
  ).toBeDisabled();
  await expect(form).toBeVisible();
  await expect(recorder).toHaveValue("Ctrl + F9");
  await expect(commandInput).toHaveValue("  printf held-form  ");
  await expect(commandInput).toBeDisabled();
  releaseValidation();
  await expect(
    settings.getByText("Fix the validation issues before saving.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(form).toBeVisible();
  await expect(commandInput).toBeEnabled();
  await expect(commandInput).toHaveValue("  printf held-form  ");
  await expect(
    settings.getByRole("combobox", {
      name: "Keyboard editor view",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    editor.getByRole("combobox", { name: "Key table", exact: true }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(0);
});

test("revokes a delayed protected terminal reveal when the binding is disabled", async ({
  page,
}) => {
  const protectedTerminal = {
    terminal: { __racProtected: true, present: true },
    reuse: true,
  };
  const state = await setupShortcutSettings(page, {
    savedKeys: { secret: { "C-G": protectedTerminal } },
  });
  let releaseReveal!: () => void;
  let revealRequests = 0;
  const heldReveal = new Promise<void>((resolve) => {
    releaseReveal = resolve;
  });
  await page.route("**/api/settings/reveal", async (route) => {
    revealRequests += 1;
    const body = route.request().postDataJSON() as { revisionId: string };
    await heldReveal;
    await route.fulfill({
      json: {
        value: "synthetic-late-terminal-plaintext",
        revisionId: body.revisionId,
        leaseId: "late-shortcut-lease",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "secret");
  const row = editor.locator('[data-key-chord="C-S-g"]');
  await page.evaluate((secret) => {
    const current = window as ShortcutWatchWindow;
    current.__shortcutSecretSeen = false;
    current.__shortcutSecretTimer = window.setInterval(() => {
      const fieldContainsSecret = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        ),
      ].some((field) => field.value.includes(secret));
      // retain any transient plaintext observation for the final assertion
      if (fieldContainsSecret || document.body.textContent?.includes(secret))
        current.__shortcutSecretSeen = true;
    }, 1);
  }, "synthetic-late-terminal-plaintext");
  await row
    .getByRole("button", { name: "Reveal Terminal command", exact: true })
    .click();
  await expect.poll(() => revealRequests).toBe(1);
  await row
    .getByRole("button", { name: "Disable C-S-g in secret", exact: true })
    .click();
  await expect(row).toContainText("Disabled binding");
  releaseReveal();
  await expect
    .poll(() => state.remasks)
    .toContainEqual({ leaseId: "late-shortcut-lease" });
  const plaintextSeen = await page.evaluate(() => {
    const current = window as ShortcutWatchWindow;
    window.clearInterval(current.__shortcutSecretTimer);
    return current.__shortcutSecretSeen;
  });
  expect(plaintextSeen).toBe(false);
  await expect(settings).not.toContainText("synthetic-late-terminal-plaintext");
  const plaintextField = await settings
    .locator("input, textarea")
    .evaluateAll(
      (fields, secret) =>
        fields.some((field) =>
          (field as HTMLInputElement | HTMLTextAreaElement).value.includes(
            secret,
          ),
        ),
      "synthetic-late-terminal-plaintext",
    );
  expect(plaintextField).toBe(false);
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(row).toContainText("Protected terminal command");
  await expect(
    row.getByRole("button", { name: "Reveal Terminal command", exact: true }),
  ).toBeVisible();
  await expect(settings).not.toContainText("synthetic-late-terminal-plaintext");
  expect(state.saves).toHaveLength(0);
});

for (const delayed of [false, true]) {
  test(`revokes an ${delayed ? "in-flight" : "accepted"} protected terminal reveal when Add table navigates`, async ({
    page,
  }) => {
    const protectedTerminal = {
      terminal: { __racProtected: true, present: true },
      reuse: false,
    };
    const state = await setupShortcutSettings(page, {
      savedKeys: { secret: { s: protectedTerminal } },
    });
    let releaseReveal = () => undefined;
    let revealRequests = 0;
    // delay only the in-flight variant so both disclosure states cross Add table
    if (delayed) {
      const heldReveal = new Promise<void>((resolve) => {
        releaseReveal = resolve;
      });
      await page.route("**/api/settings/reveal", async (route) => {
        revealRequests += 1;
        const body = route.request().postDataJSON() as { revisionId: string };
        await heldReveal;
        await route.fulfill({
          json: {
            value: "synthetic-add-table-plaintext",
            revisionId: body.revisionId,
            leaseId: "add-table-late-lease",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      });
    }
    const { editor } = await openKeyTables(page);
    await chooseEditorOption(editor, "Key table", "secret");
    const protectedRow = editor.locator('[data-key-chord="s"]');
    await protectedRow
      .getByRole("button", { name: "Reveal Terminal command", exact: true })
      .click();
    // wait for either the pending request or accepted disclosure
    if (delayed) await expect.poll(() => revealRequests).toBe(1);
    else
      await expect(
        protectedRow.getByRole("button", {
          name: "Mask Terminal command",
          exact: true,
        }),
      ).toBeVisible();
    await editor
      .getByRole("textbox", { name: "New table name", exact: true })
      .fill(delayed ? "pending-table" : "accepted-table");
    await editor
      .getByRole("button", { name: "Add table", exact: true })
      .click();
    releaseReveal();
    await expect(
      editor.getByRole("combobox", { name: "Key table", exact: true }),
    ).toHaveAttribute(
      "data-value",
      delayed ? "pending-table" : "accepted-table",
    );
    await expect
      .poll(() => state.remasks)
      .toContainEqual({
        leaseId: delayed ? "add-table-late-lease" : "shortcut-lease-1",
      });
    await expect(editor).not.toContainText(
      delayed ? "synthetic-add-table-plaintext" : "synthetic-terminal-command",
    );
    expect(state.saves).toHaveLength(0);
  });
}

for (const action of ["Discard changes", "Refresh files"] as const) {
  test(`${action} clears an unapplied key-table binding form`, async ({
    page,
  }) => {
    await setupShortcutSettings(page);
    const { settings, editor } = await openKeyTables(page);
    await chooseEditorOption(editor, "Key table", "prefix");
    // discard needs one shared draft while refresh intentionally exercises local-only state
    if (action === "Discard changes")
      await editor
        .getByRole("button", { name: "Disable c in prefix", exact: true })
        .click();
    await editor
      .getByRole("button", { name: "Add binding", exact: true })
      .click();
    const form = editor.getByRole("group", {
      name: "New binding in prefix",
      exact: true,
    });
    await form
      .getByRole("textbox", { name: "Key for binding in prefix", exact: true })
      .press("Control+F10");
    await chooseEditorOption(form, "Binding type", "Terminal command");
    await form
      .getByRole("textbox", { name: "New terminal command", exact: true })
      .fill("synthetic-stale-form");
    await settings.getByRole("button", { name: action, exact: true }).click();
    // discard now requires an explicit destructive decision
    if (action === "Discard changes") await confirmSettingsDiscard(page);
    await expect(form).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: "Add binding", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
  });
}

test("locks key-table controls while Refresh waits for an active terminal remask", async ({
  page,
}) => {
  const protectedTerminal = {
    terminal: { __racProtected: true, present: true },
    reuse: true,
  };
  const state = await setupShortcutSettings(page, {
    savedKeys: { secret: { s: protectedTerminal } },
  });
  const { settings, editor } = await openKeyTables(page);
  await chooseEditorOption(editor, "Key table", "secret");
  const row = editor.locator('[data-key-chord="s"]');
  await row
    .getByRole("button", { name: "Reveal Terminal command", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: "Mask Terminal command", exact: true }),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Add binding", exact: true })
    .click();
  const form = editor.getByRole("group", {
    name: "New binding in secret",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: "Key for binding in secret", exact: true })
    .press("Control+F11");
  let releaseRemask!: () => void;
  let remaskRequests = 0;
  const heldRemask = new Promise<void>((resolve) => {
    releaseRemask = resolve;
  });
  await page.route("**/api/settings/remask", async (route) => {
    remaskRequests += 1;
    state.remasks.push(route.request().postDataJSON());
    await heldRemask;
    await route.fulfill({ status: 204, body: "" });
  });
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect.poll(() => remaskRequests).toBe(1);
  const refresh = settings.getByRole("button", {
    name: "Refresh files",
    exact: true,
  });
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(
    settings.getByRole("combobox", {
      name: "Keyboard editor view",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("combobox", { name: "Key table", exact: true }),
  ).toBeDisabled();
  await expect(form).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "Add binding", exact: true }),
  ).toBeDisabled();
  releaseRemask();
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(
    row.getByRole("button", { name: "Reveal Terminal command", exact: true }),
  ).toBeVisible();
  await expect(settings).not.toContainText("synthetic-terminal-command");
  expect(state.remasks).toContainEqual({ leaseId: "shortcut-lease-1" });
});

// replace one visible shortcut through the recorder
async function replaceShortcut(
  page: Page,
  id: string,
  description: string,
  chord: string,
) {
  const row = command(page, id);
  await row.locator(".shortcut-change").first().click();
  const recorder = row.getByRole("textbox", {
    name: `New shortcut for ${description}`,
  });
  await recorder.press(chord);
  await row.getByRole("button", { name: "Apply shortcut" }).click();
}

test("keeps the quick reference read-only and opens the server keyboard settings section", async ({
  page,
}) => {
  await setupShortcutSettings(page, {
    runtimeKeys: { root: { "C-F6": "command-palette" } },
  });
  const settings = await openKeyboardSettings(page);
  await settings.getByRole("button", { name: "View active shortcuts" }).click();
  const reference = page.getByRole("dialog", { name: "Key bindings" });
  await expect(reference).toBeVisible();
  await expect(
    reference.getByRole("button", { name: "Edit shortcuts" }),
  ).toHaveCount(0);
  await expect(
    reference.getByRole("button", { name: "Edit in Settings" }),
  ).toBeVisible();
  await expect(reference.getByLabel("Ctrl + F6")).toBeVisible();
  await reference.getByRole("button", { name: "Edit in Settings" }).click();

  await expect(
    settings.getByRole("region", { name: "Edit keyboard shortcuts" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#settings$/u);
  await expect(page.getByRole("dialog", { name: "Key bindings" })).toHaveCount(
    0,
  );
});

test("stages recorder changes in one config transaction without changing runtime dispatch", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page);
  const settings = await openKeyboardSettings(page);

  await replaceShortcut(
    page,
    "table:prefix",
    "Switch to the prefix table",
    "Control+a",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(0);
  expect(state.validations).toHaveLength(0);
  // unsaved drafts never change the dashboard-provided runtime table
  await settings.getByRole("button", { name: "View active shortcuts" }).click();
  const reference = page.getByRole("dialog", { name: "Key bindings" });
  await expect(
    reference.locator(
      '[data-shortcut-command="table:prefix"] [data-shortcut-chord="C-b"]',
    ),
  ).toBeVisible();
  await expect(
    reference.locator(
      '[data-shortcut-command="table:prefix"] [data-shortcut-chord="C-a"]',
    ),
  ).toHaveCount(0);
  await reference.getByRole("button", { name: "Close key bindings" }).click();

  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  const patches = state.saves[0]!.changes.find(
    (change) => change.sourceId === "app",
  )!.patches;
  expect(patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "set",
        path: ["keys", "root", "C-b"],
        value: null,
      }),
      expect.objectContaining({
        op: "set",
        path: ["keys", "root", "C-a"],
        value: { table: "prefix" },
      }),
    ]),
  );
  await expect(
    page.getByRole("status", { name: "Restart pending" }),
  ).toBeVisible();
});

test("rejects collisions and leaves the existing command intact", async ({
  page,
}) => {
  await setupShortcutSettings(page);
  const settings = await openKeyboardSettings(page);
  const row = command(page, "action:new-terminal");
  await row.locator(".shortcut-change").first().click();
  const recorder = row.getByRole("textbox", {
    name: "New shortcut for New Terminal panel",
  });
  await recorder.press("n");
  await row.getByRole("button", { name: "Apply shortcut" }).click();

  await expect(row.getByRole("alert")).toContainText(
    "already assigned to another command",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
  await expect(
    row.locator('[data-shortcut-table="prefix"][data-shortcut-chord="n"]'),
  ).toHaveCount(0);
});

test("preserves safe terminal commands while displaying only their program name", async ({
  page,
}) => {
  const fullCommand =
    "env RAC_TOKEN=safe-value /usr/bin/gh dash --repo example/private";
  const state = await setupShortcutSettings(page, {
    savedKeys: { prefix: { g: { terminal: fullCommand, reuse: true } } },
    runtimeKeys: { prefix: { g: { terminal: "gh", reuse: true } } },
  });
  const settings = await openKeyboardSettings(page);

  const terminalRow = command(page, "terminal:prefix:g");
  await expect(terminalRow).toContainText("Terminal running gh (reused)");
  await expect(terminalRow).not.toContainText(fullCommand);
  await replaceShortcut(
    page,
    "terminal:prefix:g",
    "Terminal running gh (reused)",
    "Control+F8",
  );
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = state.saves[0]!.changes[0]!.patches;
  expect(patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "set",
        path: ["keys", "prefix", "C-F8"],
        value: { terminal: fullCommand, reuse: true },
      }),
    ]),
  );
});

test("requires advanced controls for masked terminals and supports discard and failed-save retention", async ({
  page,
}) => {
  const state = await setupShortcutSettings(page, {
    savedKeys: {
      prefix: {
        g: { terminal: { __racProtected: true, present: true }, reuse: true },
      },
    },
  });
  const settings = await openKeyboardSettings(page);
  const protectedRow = command(page, "terminal:prefix:g");

  await expect(protectedRow).toContainText("Choose the Key tables editor view");
  await expect(protectedRow.locator(".shortcut-change")).toBeDisabled();
  await command(page, "action:new-terminal")
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await settings.getByRole("button", { name: "Discard changes" }).click();
  await confirmSettingsDiscard(page);
  await expect(
    command(page, "action:new-terminal").getByRole("button", {
      name: "Disable",
      exact: true,
    }),
  ).toBeVisible();
  await command(page, "action:new-terminal")
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  state.saveStatus = 409;
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect(settings.getByRole("alert")).toContainText(
    "changed outside Settings",
  );
  await expect(
    command(page, "action:new-terminal").getByRole("button", {
      name: "Enable",
      exact: true,
    }),
  ).toBeVisible();
  expect(JSON.stringify(state.saves)).not.toContain("__racProtected");
});

test("keeps keyboard drafts isolated to each server settings source", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await setupShortcutSettings(first, {
    savedKeys: { prefix: { v: "new-terminal" } },
  });
  await setupShortcutSettings(second, {
    savedKeys: { prefix: { z: "new-terminal" } },
  });

  await openKeyboardSettings(first);
  await openKeyboardSettings(second);
  await expect(
    command(first, "action:new-terminal").locator(
      '[data-shortcut-table="prefix"][data-shortcut-chord="v"]',
    ),
  ).toBeVisible();
  await expect(
    command(first, "action:new-terminal").locator(
      '[data-shortcut-table="prefix"][data-shortcut-chord="z"]',
    ),
  ).toHaveCount(0);
  await expect(
    command(second, "action:new-terminal").locator(
      '[data-shortcut-table="prefix"][data-shortcut-chord="z"]',
    ),
  ).toBeVisible();
  await expect(
    command(second, "action:new-terminal").locator(
      '[data-shortcut-table="prefix"][data-shortcut-chord="v"]',
    ),
  ).toHaveCount(0);

  await firstContext.close();
  await secondContext.close();
});
