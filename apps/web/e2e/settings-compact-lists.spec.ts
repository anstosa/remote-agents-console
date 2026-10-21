import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";
import { confirmSettingsDiscard } from "./settings-confirmation-helpers.js";
import { applyAuthoredProjectPatch } from "../../server/src/settings/project-normalization.js";
import { sourceSchema } from "../../server/src/config/schema.js";

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
type ValidationIssue = {
  sourceId: string;
  path: string[];
  code: string;
  message: string;
};
type FixtureOptions = {
  writable?: boolean;
  validationIssues?: ValidationIssue[];
  revealGate?: Promise<void>;
  saveGate?: Promise<void>;
  value?: Record<string, unknown>;
};

const protectedValue = { __racProtected: true, present: true, hasValue: true };
const initialValue = {
  aliases: ["alpha", "beta"],
  unlabeled: [{ value: "first" }],
  projects: [
    {
      label: "Atlas",
      path: "/srv/atlas",
      tags: ["stable", "primary"],
      credential: protectedValue,
    },
    {
      label: "Beacon",
      path: "/srv/beacon",
      tags: ["preview"],
      credential: protectedValue,
    },
  ],
  remoteServers: [
    { url: "https://framework.example.test/" },
    { url: "https://lab.example.test", name: "Local Lab", icon: "heart" },
  ],
  endpoints: {
    primary: { name: "Primary API", url: "https://api.example.test" },
    backup: { name: "Backup API", url: "https://backup.example.test" },
  },
  overlapping: [{ name: "Vault entry", pin: "union-secret-pin" }],
};

const appSchema = {
  type: "object",
  label: "Application",
  properties: {
    aliases: {
      type: "array",
      label: "Aliases",
      items: { type: "string", label: "Alias" },
    },
    unlabeled: {
      type: "array",
      label: "Unlabeled items",
      items: {
        type: "object",
        properties: { value: { type: "string", label: "Value" } },
      },
    },
    projects: {
      type: "array",
      label: "Projects",
      items: {
        type: "object",
        label: "Project",
        default: {
          label: "New project",
          path: "",
          tags: [],
          credential: undefined,
        },
        properties: {
          label: { type: "string", label: "Name" },
          path: { type: "string", label: "Path" },
          tags: {
            type: "array",
            label: "Tags",
            items: { type: "string", label: "Tag" },
          },
          worktreeOrder: {
            type: "array",
            label: "Worktree order",
            optional: true,
            items: { type: "string", label: "Worktree path" },
          },
          credential: {
            type: "string",
            label: "Credential",
            protected: true,
            optional: true,
          },
        },
      },
    },
    remoteServers: {
      type: "array",
      label: "Remote servers",
      items: {
        type: "object",
        label: "Remote server",
        properties: {
          url: { type: "string", label: "URL" },
          name: { type: "string", label: "Name", optional: true },
          icon: {
            type: "enum",
            label: "Icon",
            optional: true,
            options: ["terminal", "potato", "heart"],
          },
        },
      },
    },
    endpoints: {
      type: "record",
      label: "Endpoints",
      items: {
        type: "object",
        label: "Endpoint",
        default: { name: "", url: "" },
        properties: {
          name: { type: "string", label: "Name" },
          url: { type: "string", label: "URL" },
        },
      },
    },
    overlapping: {
      type: "array",
      label: "Overlapping records",
      items: {
        type: "union",
        label: "Overlapping record",
        variants: [
          {
            type: "object",
            properties: { name: { type: "string" }, pin: { type: "string" } },
          },
          {
            type: "object",
            properties: {
              name: { type: "string" },
              pin: { type: "string", protected: true },
            },
          },
        ],
      },
    },
  },
};

// clone fixture data before exposing or mutating it
const clone = <T>(value: T): T => structuredClone(value);

// resolve one value beneath a patch path
function patchParent(root: Record<string, unknown>, path: string[]) {
  let target: unknown = root;
  // walk only existing fixture containers
  for (const key of path.slice(0, -1)) {
    target = Array.isArray(target)
      ? target[Number(key)]
      : (target as Record<string, unknown>)[key];
  }
  return {
    target: target as Record<string, unknown> | unknown[],
    key: path.at(-1)!,
  };
}

// apply ordered patches like the settings host
function applyPatches(root: Record<string, unknown>, patches: SettingsPatch[]) {
  // preserve mutation barriers around collection moves
  for (const patch of patches) {
    // mutate one complete ordered collection
    if (patch.op === "move" || patch.op === "insert") {
      const collection = patch.path.reduce<unknown>(
        (value, key) =>
          Array.isArray(value)
            ? value[Number(key)]
            : (value as Record<string, unknown>)[key],
        root,
      );
      // ignore malformed fixture operations
      if (!Array.isArray(collection)) continue;
      // insert one new item
      if (patch.op === "insert")
        collection.splice(
          patch.index ?? collection.length,
          0,
          clone(patch.value),
        );
      // move one existing item
      if (
        patch.op === "move" &&
        patch.from !== undefined &&
        patch.to !== undefined
      ) {
        const [entry] = collection.splice(patch.from, 1);
        // retain only a present entry
        if (entry !== undefined) collection.splice(patch.to, 0, entry);
      }
      continue;
    }
    const { target, key } = patchParent(root, patch.path);
    // remove an array member or record property
    if (patch.op === "remove") {
      // preserve array ordering during deletion
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
      continue;
    }
    // replace one scalar or object leaf
    if (patch.op === "set") target[key] = clone(patch.value);
  }
}

// publish the collection-heavy application source
function applicationSource(
  value: Record<string, unknown>,
  revision: number,
  writable: boolean,
) {
  return {
    id: "app",
    label: "Application",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable,
    protected: false,
    tracked: false,
    revisionId: `app-r${revision}`,
    apply: "rac-restart",
    value: clone(value),
    schema: appSchema,
  };
}

// mount Settings over a stateful synthetic settings host
async function setupCompactLists(page: Page, options: FixtureOptions = {}) {
  await mockAccountSocket(page);
  let saved = clone(options.value ?? initialValue) as Record<string, unknown>;
  let revision = 1;
  const state = {
    saves: [] as SettingsRequest[],
    validations: [] as SettingsRequest[],
    remasks: [] as unknown[],
    reveals: 0,
  };
  // paint deterministic icon previews
  await page.route("**/instance-icons/*.svg*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    }),
  );
  // isolate every console request from installation state
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish one authenticated controller and remote metadata
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "compact-list-csrf",
          active: true,
          deviceName: "Compact list fixture",
          server: {
            name: "Fixture console",
            url: "https://console.example.test",
            remotes: [
              {
                url: "https://framework.example.test",
                name: "Framework",
                defaultName: "Framework",
                defaultIcon: "potato",
              },
              {
                url: "https://lab.example.test",
                name: "Laboratory",
                defaultName: "Laboratory",
                defaultIcon: "terminal",
              },
            ],
          },
          davo: { enabled: false, available: false, name: "Davo", context: "" },
        },
      });
    // keep the dashboard empty and stable
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
      return route.fulfill({ json: { ticket: "compact-list-ticket" } });
    // disable unrelated notices
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    // disable server update notices
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    // keep remote status polling inside the synthetic fixture
    if (path === "/api/server-statuses")
      return route.fulfill({ json: { servers: [] } });
    // publish a settled settings status
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: false,
          targets: [],
          effective: "known",
          restartAvailable: true,
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
    // return the authoritative fixture snapshot
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${revision}`,
          sources: [
            applicationSource(saved, revision, options.writable !== false),
          ],
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    // publish requested validation issues without saving
    if (path === "/api/settings/validate" && request.method() === "POST") {
      state.validations.push(clone(request.postDataJSON() as SettingsRequest));
      const issues = options.validationIssues ?? [];
      return route.fulfill({
        json: { valid: issues.length === 0, issues, warnings: [] },
      });
    }
    // persist the ordered application transaction
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as SettingsRequest;
      state.saves.push(clone(body));
      // expose a held operation for control-lock coverage
      if (options.saveGate !== undefined) await options.saveGate;
      const patches =
        body.changes.find((change) => change.sourceId === "app")?.patches ?? [];
      applyPatches(saved, patches);
      revision += 1;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${revision}`,
          sources: [
            applicationSource(saved, revision, options.writable !== false),
          ],
          status: {
            pending: true,
            targets: ["rac"],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // disclose a synthetic credential only after the optional gate
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      state.reveals += 1;
      // hold plaintext for the late-response boundary
      if (options.revealGate !== undefined) await options.revealGate;
      return route.fulfill({
        json: {
          value: "collection-secret-value",
          revisionId: `app-r${revision}`,
          leaseId: `collection-lease-${state.reveals}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    // record disclosure revocation
    if (path === "/api/settings/remask" && request.method() === "POST") {
      state.remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({
      status: 404,
      json: { error: `not mocked: ${path}` },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Global settings" }).first().click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await selectApplication(settings);
  return { settings, state };
}

// select Application in either responsive navigator
async function selectApplication(settings: Locator) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // use the mobile source selector when visible
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox", { name: "Settings section options", exact: true })
      .locator('[role="option"][data-value="app"]')
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: "Application", exact: true })
    .click();
}

// select the virtual Projects section backed by the application source
async function selectProjects(settings: Locator) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // use the mobile source selector when visible
  if (await selector.isVisible()) {
    await selector.click();
    await settings
      .page()
      .getByRole("listbox", { name: "Settings section options", exact: true })
      .locator('[role="option"][data-value="projects"]')
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
}

// match one indexed array row while keeping its visible title unnumbered
const indexedRowName = (name: string) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\d+$`, "u");

// match one indexed array editor action
const indexedActionName = (action: "Edit" | "Close", name: string) =>
  new RegExp(
    `^${action} ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\d+$`,
    "u",
  );

// locate one duplicate collection row by its visible summary text
const rowWithSummary = (settings: Locator, name: string, text: string) =>
  settings.getByRole("group", { name: indexedRowName(name) }).filter({
    has: settings
      .page()
      .locator(".settings-collection-summary", { hasText: text }),
  });

// resolve one deferred fixture operation
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test.describe.configure({ timeout: 90_000 });

// distinguish saved collection rows from the add-new placeholders
test("uses solid existing rows and long-dash add placeholders", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    // retain the failing URL behind otherwise anonymous resource errors
    if (response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  const { settings } = await setupCompactLists(page);
  const existingRows = [
    rowWithSummary(settings, "Alias", "alpha").first(),
    settings.getByRole("group", { name: "primary", exact: true }),
  ];
  for (const row of existingRows) {
    await expect(row).toBeVisible();
    expect(
      await row.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          borderStyle: style.borderStyle,
          backgroundColor: style.backgroundColor,
        };
      }),
    ).toEqual({
      borderStyle: "solid",
      backgroundColor: "rgba(0, 0, 0, 0)",
    });
  }

  const arrayAdd = settings.getByRole("button", { name: "+ Add Alias" });
  const recordAdd = settings.locator(
    ".settings-record-add.settings-collection-add",
  );
  for (const placeholder of [arrayAdd, recordAdd]) {
    await expect(placeholder).toBeVisible();
    const style = await placeholder.evaluate((element) => {
      const base = getComputedStyle(element);
      const border = getComputedStyle(element, "::before");
      return {
        backgroundColor: base.backgroundColor,
        borderStyle: base.borderStyle,
        borderColor: base.borderColor,
        content: border.content,
        backgroundImage: border.backgroundImage,
        pointerEvents: border.pointerEvents,
      };
    });
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.borderStyle).toBe("solid");
    expect(style.borderColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.content).not.toBe("none");
    expect(style.backgroundImage.match(/repeating-linear-gradient/gu)).toHaveLength(
      4,
    );
    expect(style.backgroundImage).toContain("10px");
    expect(style.backgroundImage).toContain("18px");
    expect(style.pointerEvents).toBe("none");
  }

  await expect(arrayAdd).toHaveCSS("font-weight", "400");
  await expect(arrayAdd).toHaveCSS("font-size", "9.92px");
  await expect(recordAdd.locator("label")).toHaveCSS("font-weight", "400");
  await expect(recordAdd.locator("label")).toHaveCSS("font-size", "9.6px");
  await expect(recordAdd.getByRole("button", { name: "Add entry" })).toHaveCSS(
    "font-weight",
    "400",
  );
  await expect(recordAdd.getByRole("button", { name: "Add entry" })).toHaveCSS(
    "font-size",
    "9.92px",
  );

  // keep the placeholder usable without turning its decorative border into a hit target
  await arrayAdd.hover();
  expect(
    await arrayAdd.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      borderImage: getComputedStyle(element, "::before").backgroundImage,
    })),
  ).toEqual({
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderImage: expect.stringContaining("repeating-linear-gradient"),
  });
  await arrayAdd.evaluate((element) => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    controls[controls.indexOf(element as HTMLElement) - 1]?.focus();
  });
  await page.keyboard.press("Tab");
  await expect(arrayAdd).toBeFocused();
  expect(
    await arrayAdd.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");

  // preserve the fixed collection layout at every supported navigation shape
  for (const width of [1440, 760, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await arrayAdd.scrollIntoViewIfNeeded();
    await expect(arrayAdd).toBeVisible();
    await expect(recordAdd).toBeVisible();
    expect(
      await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        viewport: innerWidth,
      })),
    ).toEqual({
      document: expect.any(Number),
      body: expect.any(Number),
      viewport: width,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/remoteagents-settings-compact-lists-${width}.png`,
    });
    // retain one phone artifact with the record-add placeholder in view
    if (width === 375) {
      await recordAdd.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: "/tmp/remoteagents-settings-compact-lists-375-record.png",
      });
    }
  }
  expect({ consoleErrors, failedResponses }).toEqual({
    consoleErrors: [],
    failedResponses: [],
  });
});

// retain a native visible border when gradient decorations are unavailable
test("falls back to native dashed placeholders in forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  const { settings } = await setupCompactLists(page);
  const placeholders = [
    settings.getByRole("button", { name: "+ Add Alias" }),
    settings.locator(".settings-record-add.settings-collection-add"),
  ];
  for (const placeholder of placeholders) {
    await expect(placeholder).toBeVisible();
    expect(
      await placeholder.evaluate((element) => ({
        borderStyle: getComputedStyle(element).borderStyle,
        pseudoDisplay: getComputedStyle(element, "::before").display,
        pseudoBackground: getComputedStyle(element, "::before").backgroundImage,
      })),
    ).toEqual({
      borderStyle: "dashed",
      pseudoDisplay: "none",
      pseudoBackground: expect.stringMatching(/^(none)(, none)*$/u),
    });
  }
});

// keep numeric list identity in accessibility labels instead of visible edit headings
test("hides inferred array indexes while an unlabeled item is edited", async ({
  page,
}) => {
  const { settings } = await setupCompactLists(page);
  const item = settings.getByRole("group", {
    name: "Unlabeled item 1",
    exact: true,
  });
  await item
    .getByRole("button", { name: "Edit Unlabeled item 1", exact: true })
    .click();
  await expect(
    item
      .locator(".settings-collection-editor")
      .getByRole("heading", { name: /^\d+$/u }),
  ).toHaveCount(0);
  await expect(item.getByRole("textbox", { name: "Value", exact: true })).toHaveValue(
    "first",
  );
});

// keep every ordered shape compact across responsive layouts
for (const width of [320, 390, 1440]) {
  test(`collapses primitive, object, remote, nested, and record rows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings } = await setupCompactLists(page);
    const alias = rowWithSummary(settings, "Alias", "alpha").first();
    const remote = rowWithSummary(
      settings,
      "Remote server",
      "framework.example.test",
    ).first();
    const record = settings.getByRole("group", {
      name: "primary",
      exact: true,
    });
    await expect(alias).toBeVisible();
    await expect(remote).toBeVisible();
    await expect(record).toContainText(/Primary API|api\.example\.test/u);
    // keep numeric identity in accessibility labels, not visible titles
    for (const title of await settings
      .locator(".settings-collection-entry-copy > strong")
      .all()) {
      await expect(title).not.toHaveText(/\s\d+$/u);
    }
    await expect(alias.getByRole("textbox")).toHaveCount(0);
    await expect(remote.getByRole("textbox")).toHaveCount(0);
    await expect(record.getByRole("textbox")).toHaveCount(0);

    await selectProjects(settings);
    const project = rowWithSummary(settings, "Project", "Atlas").first();
    await expect(project).toBeVisible();
    await expect(project.getByRole("textbox")).toHaveCount(0);
    await project
      .getByRole("button", { name: indexedActionName("Edit", "Project") })
      .click();
    const nested = rowWithSummary(project, "Tag", "stable").first();
    await expect(nested).toBeVisible();
    await expect(nested.getByRole("textbox")).toHaveCount(0);
    await expect(
      project.getByRole("button", {
        name: indexedActionName("Close", "Project"),
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });
}

test("keeps closed drafts, opens additions, and preserves record controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupCompactLists(page);
  const alias = rowWithSummary(settings, "Alias", "alpha").first();
  await alias
    .getByRole("button", { name: indexedActionName("Edit", "Alias") })
    .click();
  await alias.getByRole("textbox").fill("alpha-next");
  await alias
    .getByRole("button", { name: indexedActionName("Close", "Alias") })
    .click();
  await expect(alias.getByRole("textbox")).toHaveCount(0);
  await expect(alias.locator(".settings-collection-summary")).toContainText(
    "alpha-next",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(state.saves).toHaveLength(0);

  await settings
    .getByRole("button", { name: "+ Add Alias", exact: true })
    .click();
  const aliases = settings.getByRole("group", {
    name: indexedRowName("Alias"),
  });
  await expect(aliases).toHaveCount(3);
  await expect(aliases.last()).toHaveCSS("border-style", "solid");
  await expect(
    aliases
      .last()
      .getByRole("button", { name: indexedActionName("Close", "Alias") }),
  ).toBeVisible();
  await expect(aliases.last().getByRole("textbox")).toBeVisible();

  const newKey = settings.getByRole("textbox", {
    name: "New key",
    exact: true,
  });
  await newKey.fill("canary");
  await settings
    .getByRole("button", { name: "Add entry", exact: true })
    .click();
  const canary = settings.getByRole("group", { name: "canary", exact: true });
  await expect(canary).toHaveCSS("border-style", "solid");
  await expect(
    canary.getByRole("button", { name: "Close canary", exact: true }),
  ).toBeVisible();
  await expect(
    canary.getByRole("button", { name: "Remove canary", exact: true }),
  ).toBeVisible();
});

test("preserves edits on both sides of a move barrier and saves their final order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupCompactLists(page);
  await selectProjects(settings);
  const atlas = rowWithSummary(settings, "Project", "Atlas").first();
  await atlas
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await atlas
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Atlas edited");
  await atlas
    .getByRole("button", { name: indexedActionName("Close", "Project") })
    .click();
  await atlas
    .getByRole("button", { name: "Move Projects 1 down", exact: true })
    .click();

  const beacon = rowWithSummary(settings, "Project", "Beacon").first();
  await beacon
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await beacon
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Beacon edited");
  await beacon
    .getByRole("button", { name: indexedActionName("Close", "Project") })
    .click();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]!.changes[0]!.patches).toEqual(
    expect.arrayContaining([
      { op: "set", path: ["projects", "0", "label"], value: "Atlas edited" },
      { op: "move", path: ["projects"], from: 0, to: 1 },
      { op: "set", path: ["projects", "0", "label"], value: "Beacon edited" },
    ]),
  );
  await expect(
    settings
      .getByRole("group", { name: indexedRowName("Project") })
      .nth(0)
      .locator(".settings-collection-summary"),
  ).toContainText("Beacon edited");
  await expect(
    settings
      .getByRole("group", { name: indexedRowName("Project") })
      .nth(1)
      .locator(".settings-collection-summary"),
  ).toContainText("Atlas edited");
});

// guard current-state indexes across parent and nested reorders
test("submits current indexes through repeated project and nested list moves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const baseline = {
    publicOrigin: "https://console.example.test",
    projects: [
      { id: "atlas", label: "Atlas", path: "/srv/atlas" },
      { id: "beacon", label: "Beacon", path: "/srv/beacon" },
      {
        id: "cinder",
        label: "Cinder",
        path: "/srv/cinder",
        worktreeOrder: ["main", "feature", "release"],
      },
    ],
  };
  const { settings, state } = await setupCompactLists(page, {
    value: baseline,
  });
  await selectProjects(settings);
  await rowWithSummary(settings, "Project", "Cinder")
    .getByRole("button", { name: "Move Projects 3 up", exact: true })
    .click();
  await rowWithSummary(settings, "Project", "Cinder")
    .getByRole("button", { name: "Move Projects 2 up", exact: true })
    .click();

  let cinder = rowWithSummary(settings, "Project", "Cinder");
  await cinder
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await cinder
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Cinder moved");
  await cinder
    .getByRole("button", { name: "Move Worktree order 3 up", exact: true })
    .click();
  await cinder
    .getByRole("button", { name: "Move Worktree order 2 up", exact: true })
    .click();
  await cinder
    .getByRole("button", { name: indexedActionName("Close", "Project") })
    .click();
  await cinder
    .getByRole("button", { name: "Move Projects 1 down", exact: true })
    .click();

  cinder = rowWithSummary(settings, "Project", "Cinder");
  await cinder
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await cinder
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Cinder final");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);

  const patches = state.validations[0]!.changes[0]!.patches!;
  expect(patches).toEqual([
    { op: "move", path: ["projects"], from: 2, to: 1 },
    { op: "move", path: ["projects"], from: 1, to: 0 },
    {
      op: "set",
      path: ["projects", "0", "label"],
      value: "Cinder moved",
    },
    {
      op: "move",
      path: ["projects", "0", "worktreeOrder"],
      from: 2,
      to: 1,
    },
    {
      op: "move",
      path: ["projects", "0", "worktreeOrder"],
      from: 1,
      to: 0,
    },
    { op: "move", path: ["projects"], from: 0, to: 1 },
    {
      op: "set",
      path: ["projects", "1", "label"],
      value: "Cinder final",
    },
  ]);
  const candidate = patches.reduce(applyAuthoredProjectPatch, baseline);
  expect(sourceSchema.safeParse(candidate).success).toBe(true);
  expect(candidate).toMatchObject({
    projects: [
      { id: "atlas", label: "Atlas" },
      {
        id: "cinder",
        label: "Cinder final",
        worktreeOrder: ["release", "main", "feature"],
      },
      { id: "beacon", label: "Beacon" },
    ],
  });
  await expect(settings.getByText(/^Validation passed\./u)).toHaveCount(0);
});

test("keeps overlapping union summaries opaque when any matching branch is protected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings } = await setupCompactLists(page);
  const row = settings
    .getByRole("group", { name: indexedRowName("Overlapping record") })
    .first();
  await expect(row.locator(".settings-collection-summary")).toHaveText(
    "Protected value configured",
  );
  await expect(row).not.toContainText("union-secret-pin");
  await expect(row.getByRole("textbox")).toHaveCount(0);
});

test("keeps editor identity through moves and deletes then resets it on discard and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings } = await setupCompactLists(page);
  await selectProjects(settings);
  let atlas = rowWithSummary(settings, "Project", "Atlas").first();
  await atlas
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await atlas
    .getByRole("button", { name: "Move Projects 1 down", exact: true })
    .click();
  atlas = rowWithSummary(settings, "Project", "Atlas").first();
  await expect(
    atlas.getByRole("button", { name: indexedActionName("Edit", "Project") }),
  ).toBeVisible();
  await expect(
    rowWithSummary(settings, "Project", "Beacon").getByRole("button", {
      name: indexedActionName("Edit", "Project"),
    }),
  ).toBeVisible();

  await atlas
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await expect(
    atlas.getByRole("button", { name: indexedActionName("Close", "Project") }),
  ).toBeVisible();

  const beacon = rowWithSummary(settings, "Project", "Beacon");
  await beacon
    .getByRole("button", { name: "Remove Projects 1", exact: true })
    .click();
  const confirmation = settings.getByRole("alertdialog", {
    name: /^Remove Project \d+$/u,
  });
  await expect(confirmation).toContainText(
    "Repositories, Worktrees, state, agents, and stacks will not be deleted.",
  );
  await confirmation
    .getByRole("button", { name: "Confirm remove", exact: true })
    .click();
  atlas = rowWithSummary(settings, "Project", "Atlas").first();
  await expect(
    atlas.getByRole("button", { name: indexedActionName("Edit", "Project") }),
  ).toBeVisible();

  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(
    settings.getByRole("button", {
      name: indexedActionName("Close", "Project"),
    }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("group", { name: indexedRowName("Project") }),
  ).toHaveCount(2);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: indexedActionName("Close", "Project"),
    }),
  ).toHaveCount(0);
});

test("surfaces descendant validation issues while their row remains collapsed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const issue = {
    sourceId: "app",
    path: ["projects", "0", "path"],
    code: "invalid_path",
    message: "Choose an existing project path.",
  };
  const { settings, state } = await setupCompactLists(page, {
    validationIssues: [issue],
  });
  await selectProjects(settings);
  const atlas = rowWithSummary(settings, "Project", "Atlas").first();
  await atlas
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await atlas
    .getByRole("textbox", { name: "Path", exact: true })
    .fill("/missing");
  await atlas
    .getByRole("button", { name: indexedActionName("Close", "Project") })
    .click();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  expect(state.saves).toEqual([]);
  await expect(atlas.getByRole("alert")).toContainText(
    "Choose an existing project path.",
  );
  await expect(atlas.getByRole("textbox")).toHaveCount(0);
  await expect(
    atlas.getByRole("button", { name: indexedActionName("Edit", "Project") }),
  ).toBeVisible();
});

test("keeps read-only rows viewable while locking every mutation action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const readOnly = await setupCompactLists(page, { writable: false });
  await selectProjects(readOnly.settings);
  const project = rowWithSummary(readOnly.settings, "Project", "Atlas").first();
  await expect(
    project.getByRole("button", { name: indexedActionName("Edit", "Project") }),
  ).toBeEnabled();
  await project
    .getByRole("button", { name: indexedActionName("Edit", "Project") })
    .click();
  await expect(
    project.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeDisabled();
  await expect(
    project.getByRole("button", {
      name: indexedActionName("Close", "Project"),
    }),
  ).toBeEnabled();
  await expect(
    readOnly.settings.getByRole("button", {
      name: "+ Add Project",
      exact: true,
    }),
  ).toBeDisabled();
  const disabledAdd = readOnly.settings.getByRole("button", {
    name: "+ Add Project",
    exact: true,
  });
  expect(
    await disabledAdd.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      pseudoBorder: getComputedStyle(element, "::before").backgroundImage,
    })),
  ).toEqual({
    backgroundColor: "rgba(0, 0, 0, 0)",
    pseudoBorder: expect.stringContaining("repeating-linear-gradient"),
  });
  await expect(
    readOnly.settings.getByRole("button", {
      name: "Move Projects 2 up",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    readOnly.settings.getByRole("button", {
      name: "Remove Projects 1",
      exact: true,
    }),
  ).toBeDisabled();
});

test("locks expanded fields and collection navigation during a held save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gate = deferred();
  const held = await setupCompactLists(page, { saveGate: gate.promise });
  const alias = held.settings
    .getByRole("group", { name: indexedRowName("Alias") })
    .first();
  await alias
    .getByRole("button", { name: indexedActionName("Edit", "Alias") })
    .click();
  await alias.getByRole("textbox").fill("held-alias");
  await held.settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => held.state.saves.length).toBe(1);
  await expect(alias.getByRole("textbox")).toBeDisabled();
  await expect(
    alias.getByRole("button", { name: indexedActionName("Close", "Alias") }),
  ).toBeDisabled();
  await expect(
    held.settings.getByRole("button", { name: "+ Add Alias", exact: true }),
  ).toBeDisabled();
  gate.resolve();
  await expect(
    held.settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
});

// collapsing must revoke both accepted and in-flight plaintext
for (const delayed of [false, true]) {
  test(`keeps credential summaries safe and revokes ${delayed ? "pending" : "accepted"} disclosure on collapse`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const gate = deferred();
    const { settings, state } = await setupCompactLists(page, {
      revealGate: delayed ? gate.promise : undefined,
    });
    await selectProjects(settings);
    const atlas = rowWithSummary(settings, "Project", "Atlas").first();
    await expect(atlas).not.toContainText("collection-secret-value");
    await atlas
      .getByRole("button", { name: indexedActionName("Edit", "Project") })
      .click();
    await atlas
      .getByRole("button", { name: "Reveal Credential", exact: true })
      .click();
    // observe accepted plaintext before collapsing
    if (!delayed)
      await expect(
        atlas.getByRole("textbox", { name: "Credential", exact: true }),
      ).toHaveValue("collection-secret-value");
    await atlas
      .getByRole("button", { name: indexedActionName("Close", "Project") })
      .click();
    gate.resolve();
    await expect.poll(() => state.remasks.length).toBe(1);
    await expect(atlas.getByRole("textbox")).toHaveCount(0);
    await expect(atlas).not.toContainText("collection-secret-value");
  });
}
