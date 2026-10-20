import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";
import { confirmSettingsDiscard } from "./settings-confirmation-helpers.js";
import { expectProgressBorder } from "./progress-border-assertions.js";

type SettingsPatch = {
  op: "set" | "remove" | "insert" | "move";
  path: string[];
  value?: unknown;
  index?: number;
  from?: number;
  to?: number;
};
type SettingsChange = {
  sourceId: string;
  revisionId: string;
  patches?: SettingsPatch[];
  content?: string;
  remove?: boolean;
  migration?: { mode: string };
};
type SettingsRequest = { changes: SettingsChange[] };
type Gate = Promise<{ status: number; valid?: boolean }>;

const baselineApp = {
  title: "Alpha service",
  credential: { __racProtected: true, present: true, hasValue: true },
  items: ["one", "two"],
  ...Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [
      `extra${index}`,
      `value ${index}`,
    ]),
  ),
};
const baselineContent = `${JSON.stringify(baselineApp, null, 2)}\n`;

// resolve a controlled request later
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// publish the application source with enough fields to exercise scrolling
function applicationSource(
  value: Record<string, unknown>,
  content: string,
  revision: number,
) {
  const extras = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [
      `extra${index}`,
      { type: "string", label: `Extra ${index}` },
    ]),
  );
  return {
    id: "app",
    label: "Application configuration",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: `app-r${revision}`,
    apply: "rac-restart",
    value,
    content,
    schema: {
      type: "object",
      label: "Application configuration",
      properties: {
        title: { type: "string", label: "Service title" },
        credential: { type: "string", label: "Credential", protected: true },
        items: {
          type: "array",
          label: "Items",
          items: { type: "string", label: "Item" },
        },
        ...extras,
      },
    },
  };
}

// publish safe and protected environment rows in one source
function environmentSource(editor: string, revision: number) {
  return {
    id: "env",
    label: "Environment & keys",
    path: "/synthetic/.env",
    format: "env",
    exists: true,
    writable: true,
    protected: true,
    tracked: false,
    revisionId: `env-r${revision}`,
    apply: "rac-restart",
    origin: "synthetic .env",
    fields: [
      {
        key: "EDITOR_COMMAND",
        value: editor,
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "Editor command used by the fixture.",
      },
      {
        key: "RAC_TOKEN",
        protected: true,
        present: true,
        apply: "rac-restart",
        description: "Protected fixture token.",
      },
    ],
  };
}

// set one nested scalar in a fixture value
function setAt(value: unknown, path: string[], nextValue: unknown): unknown {
  // replace the addressed root
  if (path.length === 0) return nextValue;
  const [head, ...tail] = path;
  const collection = Array.isArray(value)
    ? [...value]
    : { ...(value as Record<string, unknown>) };
  (collection as Record<string, unknown>)[head!] = setAt(
    (collection as Record<string, unknown>)[head!],
    tail,
    nextValue,
  );
  return collection;
}

// project one settings transaction into the synthetic saved baseline
function applyChanges(state: HeaderFixtureState, changes: SettingsChange[]) {
  // preserve source order in the shared transaction
  for (const change of changes) {
    // replace whole application bytes
    if (change.sourceId === "app" && change.content !== undefined) {
      state.appContent = change.content;
      state.appValue = JSON.parse(change.content) as Record<string, unknown>;
      continue;
    }
    // apply structured application patches
    if (change.sourceId === "app") {
      for (const patch of change.patches ?? []) {
        // set one fixture scalar
        if (patch.op === "set")
          state.appValue = setAt(
            state.appValue,
            patch.path,
            patch.value,
          ) as Record<string, unknown>;
        // move one fixture array member
        else if (
          patch.op === "move" &&
          patch.from !== undefined &&
          patch.to !== undefined
        ) {
          const array = patch.path.reduce<unknown>(
            (current, segment) => (current as Record<string, unknown>)[segment],
            state.appValue,
          );
          if (Array.isArray(array)) {
            const [entry] = array.splice(patch.from, 1);
            if (entry !== undefined) array.splice(patch.to, 0, entry);
          }
        }
      }
      state.appContent = `${JSON.stringify(state.appValue, null, 2)}\n`;
    }
    // apply the safe environment edit
    if (change.sourceId === "env") {
      const editor = change.patches?.find(
        (patch) => patch.op === "set" && patch.path[0] === "EDITOR_COMMAND",
      );
      if (typeof editor?.value === "string") state.editor = editor.value;
    }
  }
}

type HeaderFixtureState = {
  appValue: Record<string, unknown>;
  appContent: string;
  editor: string;
  revision: number;
  pending: boolean;
  validations: SettingsRequest[];
  saves: SettingsRequest[];
  settingsGets: number;
  remasks: unknown[];
  getGate?: Gate;
  getOutcomes: Array<{ status: number }>;
  validationGate?: Gate;
  saveGate?: Gate;
};

// mount the real Settings panel over isolated file and session APIs
async function setupHeaderSettings(page: Page) {
  await mockAccountSocket(page);
  await page.addInitScript(() => localStorage.clear());
  const state: HeaderFixtureState = {
    appValue: structuredClone(baselineApp),
    appContent: baselineContent,
    editor: "code --wait",
    revision: 1,
    pending: false,
    validations: [],
    saves: [],
    settingsGets: 0,
    remasks: [],
    getOutcomes: [],
  };
  const status = () => ({
    pending: state.pending,
    targets: state.pending ? ["rac"] : [],
    effective: "known",
    restartAvailable: true,
  });
  const sources = () => [
    applicationSource(state.appValue, state.appContent, state.revision),
    environmentSource(state.editor, state.revision),
  ];

  // isolate every browser request from the live console
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish one authenticated browser session
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "header-actions-csrf",
          active: true,
          deviceName: "Header actions fixture",
          server: {
            name: "Fixture",
            url: "https://fixture.example.test",
            remotes: [],
          },
          davo: { enabled: false, available: true, name: "Davo", context: "" },
        },
      });
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
    if (path === "/api/dashboard/ticket")
      return route.fulfill({
        json: { ticket: "header-actions-dashboard-ticket" },
      });
    // disable unrelated background surfaces
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({ json: status() });
    // publish the current saved files
    if (path === "/api/settings" && request.method() === "GET") {
      state.settingsGets += 1;
      const outcome =
        state.getGate === undefined
          ? (state.getOutcomes.shift() ?? { status: 200 })
          : await state.getGate;
      // expose retryable refresh failures without disturbing the initial fixture load
      if (outcome.status !== 200)
        return route.fulfill({
          status: outcome.status,
          json: { error: "synthetic refresh failure" },
        });
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: sources(),
          status: status(),
        },
      });
    }
    // reveal only the synthetic protected field
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      const body = request.postDataJSON() as { sourceId: string };
      return route.fulfill({
        json: {
          value: "fixture-secret",
          revisionId: `${body.sourceId}-r${state.revision}`,
          leaseId: "header-actions-lease",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    if (path === "/api/settings/remask" && request.method() === "POST") {
      state.remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    // hold or resolve validation without saving
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as SettingsRequest;
      state.validations.push(body);
      const outcome =
        state.validationGate === undefined
          ? { status: 200, valid: true }
          : await state.validationGate;
      return route.fulfill({
        status: outcome.status,
        json:
          outcome.status === 200
            ? { valid: outcome.valid ?? true, issues: [], warnings: [] }
            : { error: "synthetic validation failure" },
      });
    }
    // hold, reject, or persist the shared file transaction
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as SettingsRequest;
      state.saves.push(body);
      const outcome =
        state.saveGate === undefined ? { status: 200 } : await state.saveGate;
      if (outcome.status !== 200)
        return route.fulfill({
          status: outcome.status,
          json: { error: "synthetic save failure" },
        });
      applyChanges(state, body.changes);
      state.revision += 1;
      state.pending = body.changes.some(
        (change) => change.sourceId === "app" || change.sourceId === "env",
      );
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: sources(),
          status: status(),
        },
      });
    }
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
  await selectSection(settings, "app", "Application configuration");
  return { settings, state };
}

// navigate with the visible responsive control
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

// return the file-action controls only while a net draft exists
const fileActions = (settings: Locator) => ({
  toolbar: settings.getByRole("toolbar", {
    name: "Settings actions",
    exact: true,
  }),
  validate: settings.getByRole("button", { name: "Validate", exact: true }),
  discard: settings.getByRole("button", {
    name: "Discard changes",
    exact: true,
  }),
  save: settings.getByRole("button", { name: /^(?:Save changes|Saving…)$/u }),
  refresh: settings.getByRole("button", { name: "Refresh files", exact: true }),
});

// prove all file actions are entirely absent
async function expectNoFileActions(settings: Locator) {
  const actions = fileActions(settings);
  await expect(actions.validate).toHaveCount(0);
  await expect(actions.discard).toHaveCount(0);
  await expect(actions.save).toHaveCount(0);
  await expect(settings.locator(".settings-save-bar")).toHaveCount(0);
}

// verify the visible center belongs to the intended action
async function expectButtonCenterHit(button: Locator) {
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return hit === element || (hit !== null && element.contains(hit));
      }),
    )
    .toBe(true);
}

// keep a visible global notice beneath the complete settings header
async function expectNoticeBelowHeader(settings: Locator, notice: Locator) {
  const layout = await settings.evaluate((panel) => {
    const panelBounds = panel.getBoundingClientRect();
    const contentBounds = panel
      .querySelector(".client-settings-page-content")!
      .getBoundingClientRect();
    const headerBounds = panel
      .querySelector(".panel-header")!
      .getBoundingClientRect();
    const noticeBounds = document
      .querySelector<HTMLElement>('[aria-label="Restart pending"]')!
      .getBoundingClientRect();
    return {
      contentFromPane: contentBounds.top - panelBounds.top,
      headerBottom: headerBounds.bottom,
      noticeBottomFromPane: noticeBounds.bottom - panelBounds.top,
      noticeTop: noticeBounds.top,
    };
  });
  await expect(notice).toBeVisible();
  expect(layout.noticeTop).toBeGreaterThanOrEqual(layout.headerBottom);
  expect(layout.contentFromPane).toBeGreaterThanOrEqual(
    layout.noticeBottomFromPane - 1,
  );
}

// compare action order through each button's accessible label source
async function expectToolbarActions(toolbar: Locator, names: string[]) {
  await expect
    .poll(() =>
      toolbar
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map(
            (button) =>
              button.getAttribute("aria-label") ??
              button.textContent?.trim() ??
              "",
          ),
        ),
    )
    .toEqual(names);
}

test.describe.configure({ timeout: 90_000 });

// verify the responsive toolbar contract at phone, split, and desktop widths
for (const width of [320, 390, 1440]) {
  test(`keeps dirty file actions in the existing Settings header at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 520 });
    const { settings, state } = await setupHeaderSettings(page);
    const actions = fileActions(settings);
    await expect(
      actions.toolbar.getByRole("button", {
        name: "Close settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      actions.toolbar.getByRole("button", {
        name: "Expand settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(actions.refresh).toBeVisible();
    await expect(actions.refresh).toBeEnabled();
    await expect(actions.refresh).toHaveText("");
    await expect(actions.refresh).toHaveAttribute("title", "Refresh files");
    await expect(actions.refresh).toHaveAttribute("aria-busy", "false");
    await expect(actions.refresh.locator("svg path")).toHaveAttribute(
      "d",
      "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
    );
    await expect(actions.toolbar.getByRole("button")).toHaveCount(3);
    await expect(
      settings.getByRole("button", { name: "Refresh files", exact: true }),
    ).toHaveCount(1);
    await expect(
      settings
        .locator(".client-settings-page-content")
        .getByRole("button", { name: "Refresh files", exact: true }),
    ).toHaveCount(0);
    await expectToolbarActions(actions.toolbar, [
      "Refresh files",
      "Expand settings",
      "Close settings",
    ]);
    await expectNoFileActions(settings);

    const title = settings.getByRole("textbox", {
      name: "Service title",
      exact: true,
    });
    await title.fill("Beta service");
    await expect(actions.validate).toBeVisible();
    await expect(actions.discard).toBeVisible();
    await expect(actions.save).toBeVisible();
    await expect(actions.refresh).toBeDisabled();
    await expect(actions.refresh).toHaveAttribute(
      "title",
      "Discard or save local changes before refreshing files",
    );
    await expect(actions.toolbar.getByRole("button")).toHaveCount(6);
    await expectToolbarActions(actions.toolbar, [
      "Validate",
      "Discard changes",
      "Save changes",
      "Refresh files",
      "Expand settings",
      "Close settings",
    ]);
    await expect(
      settings.getByRole("button", { name: "Validate", exact: true }),
    ).toHaveCount(1);
    await expect(
      settings.getByRole("button", { name: "Discard changes", exact: true }),
    ).toHaveCount(1);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(1);
    await expect(settings.locator(".settings-save-bar")).toHaveCount(0);
    await expect(actions.validate).toHaveText("Validate");
    await expect(actions.validate.locator("svg path")).toHaveAttribute(
      "d",
      "m5 12 4 4L19 6",
    );
    await expect(actions.discard).toHaveText("");
    await expect(actions.discard).toHaveAttribute("title", "Discard changes");
    await expect(actions.discard.locator("svg path")).toHaveAttribute(
      "d",
      "M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6",
    );
    await expect(actions.save).toHaveText("Save changes");
    await expect(actions.save.locator("svg path")).toHaveCount(1);
    const geometry = await actions.toolbar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const title = element
        .parentElement!.querySelector(".panel-header-title")!
        .getBoundingClientRect();
      const discard = element.querySelector('[aria-label="Discard changes"]')!;
      const reference = document.createElement("span");
      reference.style.color = "var(--red)";
      document.body.append(reference);
      const red = getComputedStyle(reference).color;
      reference.remove();
      const overlapsTitle = !(
        bounds.right <= title.left ||
        bounds.left >= title.right ||
        bounds.bottom <= title.top ||
        bounds.top >= title.bottom
      );
      return {
        overflow: element.scrollWidth - element.clientWidth,
        overlapsTitle,
        discard: getComputedStyle(discard).color,
        red,
        top: bounds.top,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.overlapsTitle).toBe(false);
    expect(geometry.discard).toBe(geometry.red);
    const scroller = settings.locator(".settings-source-panel");
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await settings
        .locator(".client-settings-page-content")
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    ).toBe(0);
    await expect(actions.toolbar).toBeVisible();
    const afterScroll = await actions.toolbar.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(Math.abs(afterScroll - geometry.top)).toBeLessThanOrEqual(1);
    expect(state.saves).toHaveLength(0);

    // confirmation controls remain reachable above the independently scrolled tab
    await actions.discard.click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Discard unsaved changes?",
      exact: true,
    });
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(title).toHaveValue("Beta service");

    await title.fill("Alpha service");
    await expectNoFileActions(settings);
    await expect(actions.refresh).toBeEnabled();
    await expect(actions.toolbar.getByRole("button")).toHaveCount(3);
  });
}

// verify refresh security and editor reset boundaries at every supported layout
for (const width of [320, 390, 1440]) {
  test(`refreshes one clean catalog and resets sensitive editor state at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { settings, state } = await setupHeaderSettings(page);
    const actions = fileActions(settings);
    const credential = settings.locator('[data-settings-path="credential"]');
    await credential
      .getByRole("button", { name: "Reveal Credential", exact: true })
      .click();
    await expect(
      credential.getByRole("textbox", { name: "Credential", exact: true }),
    ).toHaveValue("fixture-secret");
    const item = settings.getByRole("group", { name: "Item 1", exact: true });
    await item
      .getByRole("button", { name: "Edit Item 1", exact: true })
      .click();
    const closeItem = item.getByRole("button", {
      name: "Close Item 1",
      exact: true,
    });
    await expect(closeItem).toBeVisible();

    const initialGets = state.settingsGets;
    const heldRefresh = deferred<{ status: number }>();
    state.getGate = heldRefresh.promise;
    await actions.refresh.click();
    await expect.poll(() => state.settingsGets).toBe(initialGets + 1);
    await expect
      .poll(() => state.remasks)
      .toContainEqual({ leaseId: "header-actions-lease" });
    await expect(actions.refresh).toBeDisabled();
    await expect(actions.refresh).toHaveAttribute("aria-busy", "true");
    await expect(actions.refresh).toHaveAttribute(
      "aria-label",
      "Refresh files",
    );
    await expect(actions.refresh).toHaveText("");
    await expect(
      settings.getByRole("textbox", { name: "Service title", exact: true }),
    ).toBeDisabled();
    await expect(closeItem).toBeDisabled();
    await expect(
      credential.getByRole("textbox", { name: "Credential", exact: true }),
    ).toHaveCount(0);
    await expect(
      credential.getByRole("button", {
        name: "Reveal Credential",
        exact: true,
      }),
    ).toBeVisible();
    await actions.refresh.evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    expect(state.settingsGets).toBe(initialGets + 1);

    heldRefresh.resolve({ status: 200 });
    await expect(actions.refresh).toBeEnabled();
    state.getGate = undefined;
    await expect(actions.refresh).toHaveAttribute("aria-busy", "false");
    await expect(settings).toBeFocused();
    await expect(
      item.getByRole("button", { name: "Edit Item 1", exact: true }),
    ).toBeVisible();
    await expect(
      item.getByRole("button", { name: "Close Item 1", exact: true }),
    ).toHaveCount(0);
    expect(state.settingsGets).toBe(initialGets + 1);
  });
}

test("keeps Refresh files retryable after a catalog error", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const { settings, state } = await setupHeaderSettings(page);
  const refresh = fileActions(settings).refresh;
  const initialGets = state.settingsGets;
  state.getOutcomes.push({ status: 503 });

  await refresh.click();
  await expect.poll(() => state.settingsGets).toBe(initialGets + 1);
  await expect(settings.getByRole("alert")).toHaveText(
    "synthetic refresh failure",
  );
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(settings).toBeFocused();

  state.appValue.title = "Recovered service";
  state.appContent = `${JSON.stringify(state.appValue, null, 2)}\n`;
  state.revision += 1;
  await refresh.click();
  await expect.poll(() => state.settingsGets).toBe(initialGets + 2);
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(
    settings.getByRole("textbox", { name: "Service title", exact: true }),
  ).toHaveValue("Recovered service");
  await expect(refresh).toBeEnabled();
  await expect(settings).toBeFocused();
});

// verify persistent notices against the responsive wrapped header
for (const width of [320, 390, 1440]) {
  test(`keeps header actions above Restart pending after a save at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 760 });
    const { settings, state } = await setupHeaderSettings(page);
    const title = settings.getByRole("textbox", {
      name: "Service title",
      exact: true,
    });
    await title.fill("Saved pending title");
    await fileActions(settings).save.click();
    await expect.poll(() => state.saves.length).toBe(1);
    const notice = page.getByRole("status", {
      name: "Restart pending",
      exact: true,
    });
    await expect(notice).toBeVisible();
    await expectNoFileActions(settings);

    await title.fill("Draft above pending restart");
    const actions = fileActions(settings);
    await expect(actions.save).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Number.parseFloat(
              document.documentElement.style.getPropertyValue(
                "--settings-header-toast-clearance",
              ),
            ) || 0,
        ),
      )
      .toBeGreaterThan(0);
    await expectButtonCenterHit(actions.validate);
    await expectButtonCenterHit(actions.discard);
    await expectButtonCenterHit(actions.save);
    await expectNoticeBelowHeader(settings, notice);

    await actions.validate.click();
    await expect.poll(() => state.validations.length).toBe(2);
    await actions.discard.click();
    await confirmSettingsDiscard(page);
    await expectNoFileActions(settings);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Number.parseFloat(
              document.documentElement.style.getPropertyValue(
                "--settings-header-toast-clearance",
              ),
            ) || 0,
        ),
      )
      .toBeGreaterThan(0);
    await expectNoticeBelowHeader(settings, notice);
    await expectButtonCenterHit(actions.refresh);
    await expect(title).toHaveValue("Saved pending title");

    await title.fill("Saved after pending restart");
    await fileActions(settings).save.click();
    await expect.poll(() => state.saves.length).toBe(2);
    await expectNoFileActions(settings);
    await expect(notice).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Number.parseFloat(
              document.documentElement.style.getPropertyValue(
                "--settings-header-toast-clearance",
              ),
            ) || 0,
        ),
      )
      .toBeGreaterThan(0);
    await expectNoticeBelowHeader(settings, notice);
    await expectButtonCenterHit(actions.refresh);
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    await expect(notice).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Number.parseFloat(
              document.documentElement.style.getPropertyValue(
                "--settings-header-toast-clearance",
              ),
            ) || 0,
        ),
      )
      .toBe(0);
  });
}

test("hides file actions for reverted raw bytes, collection order, and browser drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  const { settings, state } = await setupHeaderSettings(page);
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = settings.getByRole("textbox", {
    name: "Application configuration source content",
    exact: true,
  });
  await raw.fill(`${baselineContent} `);
  await expect(fileActions(settings).save).toBeVisible();
  await expect(fileActions(settings).refresh).toBeDisabled();
  await raw.fill(baselineContent);
  await expectNoFileActions(settings);
  await expect(fileActions(settings).refresh).toBeEnabled();
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();

  await settings
    .getByRole("button", { name: "Move Items 2 up", exact: true })
    .click();
  await expect(fileActions(settings).save).toBeVisible();
  await expect(fileActions(settings).refresh).toBeDisabled();
  await settings
    .getByRole("button", { name: "Move Items 1 down", exact: true })
    .click();
  await expectNoFileActions(settings);
  await expect(fileActions(settings).refresh).toBeEnabled();

  await selectSection(settings, "browser", "This browser");
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await expect(fileActions(settings).save).toBeVisible();
  await expect(fileActions(settings).refresh).toBeDisabled();
  await settings
    .getByRole("radio", { name: "Dark theme", exact: true })
    .click();
  await expectNoFileActions(settings);
  await expect(fileActions(settings).refresh).toBeEnabled();
  expect(state.validations).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
});

test("keeps global header actions across sections and discard clears every draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const { settings, state } = await setupHeaderSettings(page);
  await settings
    .getByRole("textbox", { name: "Service title", exact: true })
    .fill("Cross-section title");
  await selectSection(settings, "env", "Environment & keys");
  const editor = settings.getByRole("textbox", {
    name: "EDITOR_COMMAND",
    exact: true,
  });
  await expect(fileActions(settings).save).toBeVisible();
  await editor.fill("nvim --server fixture");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(1);
  await fileActions(settings).discard.click();
  await confirmSettingsDiscard(page);
  await expect(settings).toBeFocused();
  await expect(editor).toHaveValue("code --wait");
  await expectNoFileActions(settings);

  await editor.fill("nvim --server second");
  await editor.focus();
  await fileActions(settings).discard.evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await confirmSettingsDiscard(page);
  await expectNoFileActions(settings);
  await expect(settings).not.toBeFocused();
  await selectSection(settings, "app", "Application configuration");
  await expect(
    settings.getByRole("textbox", { name: "Service title", exact: true }),
  ).toHaveValue("Alpha service");
  expect(state.validations).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
});

test("locks header actions through validation and saving, retains failures, then disappears after success", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  const { settings, state } = await setupHeaderSettings(page);
  const title = settings.getByRole("textbox", {
    name: "Service title",
    exact: true,
  });
  await title.fill("Transactional title");
  const validation = deferred<{ status: number; valid?: boolean }>();
  state.validationGate = validation.promise;
  await fileActions(settings).validate.click();
  await expect.poll(() => state.validations.length).toBe(1);
  const validating = settings.getByRole("button", { name: "Validating…", exact: true });
  await expect(validating).toBeDisabled();
  await expectProgressBorder(validating, "blue");
  await expect(validating.locator("svg")).toBeVisible();
  await expect(fileActions(settings).discard).toBeDisabled();
  await expect(fileActions(settings).save).toBeDisabled();
  await expect(fileActions(settings).refresh).toBeDisabled();
  expect(state.saves).toHaveLength(0);
  validation.resolve({ status: 200, valid: true });
  state.validationGate = undefined;
  const validationMessage = settings.getByText(/^Validation passed\./u);
  await expect(validationMessage).toBeVisible();
  await expect(validationMessage).not.toContainText(
    /\b(?:restart|recreate)\b/iu,
  );
  await expect(fileActions(settings).save).toBeEnabled();

  const rejectedSave = deferred<{ status: number }>();
  state.saveGate = rejectedSave.promise;
  await fileActions(settings).save.click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saving = settings.getByRole("button", { name: "Saving…", exact: true });
  await expect(saving).toBeDisabled();
  await expectProgressBorder(saving, "blue");
  await expect(saving.locator("svg")).toBeVisible();
  await expect(fileActions(settings).validate).toBeDisabled();
  await expect(fileActions(settings).discard).toBeDisabled();
  await expect(fileActions(settings).refresh).toBeDisabled();
  await expect(title).toBeDisabled();
  rejectedSave.resolve({ status: 409 });
  state.saveGate = undefined;
  await expect(settings.getByRole("alert")).toContainText(
    "changed outside Settings",
  );
  await expect(title).toHaveValue("Transactional title");
  await expect(title).toBeEnabled();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(2);
  await expectNoFileActions(settings);
  await expect(settings).toBeFocused();
  await expect(title).toHaveValue("Transactional title");
});

test("omits a disclosed no-op secret when another field in its source changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  const { settings, state } = await setupHeaderSettings(page);
  await selectSection(settings, "env", "Environment & keys");
  const secretField = settings.locator('[data-settings-path="RAC_TOKEN"]');
  await secretField
    .getByRole("button", { name: "Reveal RAC_TOKEN", exact: true })
    .click();
  const secret = secretField.getByRole("textbox", {
    name: "RAC_TOKEN",
    exact: true,
  });
  await expect(secret).toHaveValue("fixture-secret");
  await secret.fill("fixture-secret");
  await settings
    .getByRole("textbox", { name: "EDITOR_COMMAND", exact: true })
    .fill("nvim --clean");

  await fileActions(settings).save.click();
  await expect.poll(() => state.saves.length).toBe(1);
  const ordinaryEdit = {
    changes: [
      {
        sourceId: "env",
        revisionId: "env-r1",
        patches: [
          { op: "set", path: ["EDITOR_COMMAND"], value: "nvim --clean" },
        ],
      },
    ],
  };
  expect(state.validations).toEqual([ordinaryEdit]);
  expect(state.saves).toEqual([ordinaryEdit]);
  expect(
    JSON.stringify({ validations: state.validations, saves: state.saves }),
  ).not.toContain("RAC_TOKEN");
  expect(
    JSON.stringify({ validations: state.validations, saves: state.saves }),
  ).not.toContain("fixture-secret");
  await expectNoFileActions(settings);
  await expect(settings).toBeFocused();
});

test("compares protected drafts conservatively until a disclosed baseline is known", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  const { settings, state } = await setupHeaderSettings(page);
  const field = settings.locator('[data-settings-path="credential"]');
  await expectNoFileActions(settings);
  await field
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
  await field
    .getByRole("textbox", { name: "New Credential", exact: true })
    .fill("fixture-secret");
  await expect(fileActions(settings).save).toBeVisible();
  await fileActions(settings).discard.click();
  await confirmSettingsDiscard(page);
  await expectNoFileActions(settings);

  await field
    .getByRole("button", { name: "Reveal Credential", exact: true })
    .click();
  const disclosed = field.getByRole("textbox", {
    name: "Credential",
    exact: true,
  });
  await expect(disclosed).toHaveValue("fixture-secret");
  await disclosed.fill("fixture-secret");
  await expectNoFileActions(settings);
  await disclosed.fill("changed-secret");
  await expect(fileActions(settings).save).toBeVisible();
  expect(state.saves).toHaveLength(0);
});
