import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";
import { applyPatch } from "../../server/src/settings/patches.js";

type ReviewPreset = {
  id: string;
  label: string;
  agent: "codex" | "claude";
  model?: string;
  effort?: string;
  prompt: string;
};

type ReviewValue = {
  agents?: {
    codex?: { mode?: "headless" | "interactive" };
    claude?: { mode?: "headless" | "interactive" };
  };
  tour?: {
    agent?: "codex" | "claude";
    model?: string;
    effort?: string;
    prompt?: string;
  };
  presets?: ReviewPreset[];
  defaultPreset?: string;
};

type ReviewPatch = {
  op: "set" | "remove" | "insert" | "move";
  path: string[];
  value?: unknown;
  index?: number;
  from?: number;
  to?: number;
};

type ReviewSettingsRequest = {
  changes: Array<{
    sourceId: string;
    revisionId: string;
    patches?: ReviewPatch[];
  }>;
};

type ReviewFixture = {
  app: {
    id: string;
    label: string;
    path: string;
    format: "json";
    exists: boolean;
    writable: boolean;
    protected: boolean;
    tracked: boolean;
    revisionId: string;
    apply: "rac-restart";
    content: string;
    value: Record<string, unknown>;
    schema: ReturnType<typeof applicationSettingsSchema>;
  };
  settings: Locator;
  state: {
    saves: ReviewSettingsRequest[];
    validations: ReviewSettingsRequest[];
    rejectBlankPreset: boolean;
  };
};

const status = {
  pending: false,
  targets: [],
  effective: "known",
  restartAvailable: true,
} as const;

// choose one responsive Settings page without depending on the current viewport
async function selectSettingsPage(
  settings: Locator,
  id: string,
  label: string,
) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones replace the left navigation with one custom select
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
    .getByRole("button", {
      name: new RegExp(`^${label}(?: (?:· )?Unsaved changes)?$`, "u"),
    })
    .click();
}

// choose one generated enum option inside its canonical field
async function chooseFieldOption(
  field: Locator,
  label: string,
  value: string,
) {
  await field.getByRole("combobox", { name: label, exact: true }).click();
  await field
    .page()
    .getByRole("listbox", { name: `${label} options`, exact: true })
    .locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
    .click();
}

// find one settings field by canonical application path
const fieldAt = (settings: Locator, path: string) =>
  settings.locator(`[data-settings-path=${JSON.stringify(path)}]`);

// mount one mutable application catalog around the Review settings source
async function setupReviewSettings(
  page: Page,
  options: { review?: ReviewValue; writable?: boolean } = {},
): Promise<ReviewFixture> {
  await mockAccountSocket(page);
  const schema = applicationSettingsSchema();
  const value: Record<string, unknown> = {
    publicOrigin: "https://framework.example.test",
    ...(options.review === undefined ? {} : { review: options.review }),
  };
  const app = {
    id: "app",
    label: "Application config",
    path: "/checkout/config/config.json",
    format: "json" as const,
    exists: true,
    writable: options.writable ?? true,
    protected: false,
    tracked: false,
    revisionId: "app-r1",
    apply: "rac-restart" as const,
    content: `${JSON.stringify(value)}\n`,
    value,
    schema,
  };
  const state = {
    saves: [] as ReviewSettingsRequest[],
    validations: [] as ReviewSettingsRequest[],
    rejectBlankPreset: false,
  };

  // serve the authenticated console and one application settings file
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate the fixture without reading any host session
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "reviews-csrf",
          active: true,
          deviceName: "Reviews fixture",
          server: {
            name: "Framework",
            url: "https://framework.santosa.dev",
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
      return route.fulfill({ json: { ticket: "reviews-ticket" } });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({ json: status });
    if (path === "/api/settings/cloudflare" && request.method() === "GET")
      return route.fulfill({
        json: {
          supported: false,
          reason: "fixture",
          mode: "unconfigured",
          enabled: false,
          tokenPresent: false,
        },
      });
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "reviews-snapshot-r1",
          installationKind: "compose",
          sources: [app],
          status,
        },
      });
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as ReviewSettingsRequest;
      state.validations.push(body);
      const appChange = body.changes.find((change) => change.sourceId === "app");
      const inserted = appChange?.patches?.find(
        (patch) =>
          patch.op === "insert" && patch.path.join(".") === "review.presets",
      );
      const index = inserted?.index ?? 0;
      // preserve server ownership of required preset validation
      if (state.rejectBlankPreset)
        return route.fulfill({
          json: {
            valid: false,
            issues: [
              {
                sourceId: "app",
                path: ["review", "presets", String(index), "id"],
                code: "too_small",
                message: "Preset ID is required.",
              },
            ],
            warnings: [],
          },
        });
      return route.fulfill({
        json: { valid: true, issues: [], warnings: [] },
      });
    }
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as ReviewSettingsRequest;
      state.saves.push(body);
      // project successful patches into the next authoritative snapshot
      for (const change of body.changes) {
        // ignore unrelated future settings sources in this focused fixture
        if (change.sourceId !== "app") continue;
        for (const patch of change.patches ?? [])
          app.value = applyPatch(app.value, patch);
      }
      app.revisionId = "app-r2";
      app.content = `${JSON.stringify(app.value)}\n`;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "reviews-snapshot-r2",
          installationKind: "compose",
          sources: [app],
          status: { ...status, pending: true, targets: ["rac"] },
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
  return { app, settings, state };
}

// keep every permanent Review setting in the dedicated page without authoring defaults
test("shows the complete omitted Reviews form without mutation controls or a draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupReviewSettings(page);
  await selectSettingsPage(settings, "reviews", "Reviews");

  const panel = settings.getByRole("region", {
    name: "Reviews settings content",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "Reviews", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(panel.locator(":scope > .settings-source-header")).toContainText(
    "Server settings",
  );
  for (const path of [
    "review.agents",
    "review.agents.codex",
    "review.agents.codex.mode",
    "review.agents.claude",
    "review.agents.claude.mode",
    "review.tour",
    "review.tour.agent",
    "review.tour.model",
    "review.tour.effort",
    "review.tour.prompt",
    "review.presets",
    "review.defaultPreset",
  ]) {
    // require each sparse Review path to retain a visible permanent control
    await expect(fieldAt(panel, path)).toBeVisible();
  }
  await expect(fieldAt(panel, "review.presets")).toContainText(
    "Correctness (from built-in Review preset)",
  );
  await expect(
    panel.getByRole("button", {
      name: /^(?:Add|Remove) (?:Reviews|Review agents|Codex|Claude|Review tour|Review presets|Default preset)$/iu,
    }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
  expect(state.validations).toEqual([]);
  const model = fieldAt(panel, "review.tour.model").getByRole("textbox");
  await model.fill("gpt-6-review");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await model.fill("");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-reviews-desktop.png",
  });

  await selectSettingsPage(settings, "app", "Application");
  const application = settings.getByRole("region", {
    name: "Application settings content",
    exact: true,
  });
  await expect(
    application.getByRole("heading", { name: "Reviews", exact: true }),
  ).toHaveCount(0);
  await expect(application.locator('[data-settings-path^="review"]')).toHaveCount(
    0,
  );
});

// omit authored optional values and built-in defaults when they are cleared
test("serializes blank Review values as removal while retaining required preset validation", async ({
  page,
}) => {
  const { app, settings, state } = await setupReviewSettings(page, {
    review: {
      agents: {
        codex: { mode: "interactive" },
        claude: { mode: "interactive" },
      },
      tour: {
        agent: "claude",
        model: "claude-sonnet-4-5",
        effort: "high",
        prompt: "Tour the settings implementation.",
      },
      presets: [
        {
          id: "security",
          label: "Security",
          agent: "codex",
          prompt: "Review security boundaries.",
        },
      ],
      defaultPreset: "security",
    },
  });
  await selectSettingsPage(settings, "reviews", "Reviews");

  await fieldAt(settings, "review.tour.model").getByRole("textbox").fill("");
  await fieldAt(settings, "review.tour.effort").getByRole("textbox").fill("");
  await fieldAt(settings, "review.tour.prompt").getByRole("textbox").fill("");
  await fieldAt(settings, "review.defaultPreset")
    .getByRole("textbox")
    .fill("");
  await chooseFieldOption(
    fieldAt(settings, "review.agents.codex.mode"),
    "Mode",
    "",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = state.saves[0]!.changes[0]!.patches!;
  for (const path of [
    ["review", "tour", "model"],
    ["review", "tour", "effort"],
    ["review", "tour", "prompt"],
    ["review", "defaultPreset"],
  ]) {
    // blank and built-in selections restore omission instead of empty authored bytes
    expect(patches).toContainEqual({ op: "remove", path });
  }
  expect(patches).toContainEqual({
    op: "remove",
    path: ["review", "agents", "codex"],
  });
  const savedReview = app.value.review as ReviewValue;
  expect(savedReview.agents?.codex?.mode).toBeUndefined();
  expect(savedReview.tour?.model).toBeUndefined();
  expect(savedReview.tour?.effort).toBeUndefined();
  expect(savedReview.tour?.prompt).toBeUndefined();
  expect(savedReview.defaultPreset).toBeUndefined();

  state.rejectBlankPreset = true;
  await settings
    .getByRole("button", { name: "+ Add Review preset", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(fieldAt(settings, "review.presets.1.id").getByRole("alert")).toHaveText(
    "Preset ID is required.",
  );
  expect(state.saves).toHaveLength(1);
});

// collapse a cancelled first preset back to the untouched built-in fallback
test("restores the built-in preset after deleting the only newly added row", async ({
  page,
}) => {
  const { settings, state } = await setupReviewSettings(page);
  await selectSettingsPage(settings, "reviews", "Reviews");
  const presets = fieldAt(settings, "review.presets");
  await expect(presets).toContainText(
    "Correctness (from built-in Review preset)",
  );
  await presets
    .getByRole("button", { name: "+ Add Review preset", exact: true })
    .click();
  for (const path of ["id", "label", "agent", "prompt"]) {
    // adding the row reveals every required field without inventing saved values
    await expect(fieldAt(presets, `review.presets.0.${path}`)).toBeVisible();
  }
  await presets
    .getByRole("button", {
      name: "Remove Review presets 1",
      exact: true,
    })
    .click();
  await expect(fieldAt(presets, "review.presets.0.id")).toHaveCount(0);
  await expect(presets).toContainText(
    "Correctness (from built-in Review preset)",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
  expect(state.validations).toEqual([]);
});

// distinguish invalid required blanks from removable optional preset values
test("keeps a cleared preset ID invalid while removing its optional model", async ({
  page,
}) => {
  const { settings, state } = await setupReviewSettings(page, {
    review: {
      presets: [
        {
          id: "security",
          label: "Security",
          agent: "codex",
          model: "gpt-6-review",
          prompt: "Review security boundaries.",
        },
      ],
    },
  });
  state.rejectBlankPreset = true;
  await selectSettingsPage(settings, "reviews", "Reviews");
  await fieldAt(settings, "review.presets.0.id").getByRole("textbox").fill("");
  await fieldAt(settings, "review.presets.0.model")
    .getByRole("textbox")
    .fill("");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  const patches = state.validations[0]!.changes[0]!.patches!;
  expect(patches).toContainEqual({
    op: "set",
    path: ["review", "presets", "0", "id"],
    value: "",
  });
  expect(patches).toContainEqual({
    op: "remove",
    path: ["review", "presets", "0", "model"],
  });
  await expect(
    fieldAt(settings, "review.presets.0.id").getByRole("alert"),
  ).toHaveText("Preset ID is required.");
  expect(state.saves).toEqual([]);
});

// retain explicit collection actions only for operator-authored Review preset rows
test("adds, reorders, and removes expanded Review preset rows in the shared application save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupReviewSettings(page, {
    review: {
      presets: [
        {
          id: "security",
          label: "Security",
          agent: "codex",
          prompt: "Review security boundaries.",
        },
      ],
    },
  });
  await selectSettingsPage(settings, "reviews", "Reviews");

  const presets = fieldAt(settings, "review.presets");
  await expect(fieldAt(presets, "review.presets.0.id")).toBeVisible();
  await expect(presets.getByRole("button", { name: /Edit|Close/iu })).toHaveCount(
    0,
  );
  await presets.scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-reviews-preset-desktop.png",
  });
  await presets
    .getByRole("button", { name: "+ Add Review preset", exact: true })
    .click();
  await fieldAt(presets, "review.presets.1.id").getByRole("textbox").fill(
    "correctness",
  );
  await fieldAt(presets, "review.presets.1.label")
    .getByRole("textbox")
    .fill("Correctness");
  await chooseFieldOption(
    fieldAt(presets, "review.presets.1.agent"),
    "Agent",
    "claude",
  );
  await fieldAt(presets, "review.presets.1.prompt")
    .getByRole("textbox")
    .fill("Review functional correctness.");
  await presets
    .getByRole("button", {
      name: "Move Review presets 2 up",
      exact: true,
    })
    .click();
  await presets
    .getByRole("button", {
      name: "Remove Review presets 2",
      exact: true,
    })
    .click();

  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]!.changes).toHaveLength(1);
  expect(state.saves[0]!.changes[0]!.sourceId).toBe("app");
  expect(state.saves[0]!.changes[0]!.patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "insert",
        path: ["review", "presets"],
        index: 1,
      }),
      { op: "move", path: ["review", "presets"], from: 1, to: 0 },
      { op: "remove", path: ["review", "presets", "1"] },
    ]),
  );
});

// search hidden sparse and collection descendants without mutating their values
test("lands search results on permanent Review fields and expanded preset descendants", async ({
  page,
}) => {
  const { settings, state } = await setupReviewSettings(page, {
    review: {
      presets: [
        {
          id: "security",
          label: "Security",
          agent: "codex",
          prompt: "Review security boundaries.",
        },
      ],
    },
  });
  const search = settings.getByRole("searchbox", {
    name: "Search settings",
    exact: true,
  });
  await search.fill("review tour prompt");
  await page
    .getByRole("listbox", { name: "Settings search results", exact: true })
    .getByRole("option")
    .filter({ hasText: /Prompt.*Reviews.*Review tour/su })
    .click();
  await expect(fieldAt(settings, "review.tour.prompt")).toBeVisible();
  await expect(fieldAt(settings, "review.tour.prompt")).toHaveAttribute(
    "data-settings-search-highlight",
    "true",
  );

  await search.fill("review preset prompt");
  await page
    .getByRole("listbox", { name: "Settings search results", exact: true })
    .getByRole("option")
    .filter({ hasText: /Prompt.*Review presets.*Review preset 1/su })
    .click();
  await expect(fieldAt(settings, "review.presets.0.prompt")).toBeVisible();
  await expect(fieldAt(settings, "review.presets.0.prompt")).toHaveAttribute(
    "data-settings-search-highlight",
    "true",
  );
  expect(state.saves).toEqual([]);
  expect(state.validations).toEqual([]);
});

// share Application raw and file-permission locks with the dedicated Reviews page
test("locks Reviews through Application raw mode and read-only catalog transitions", async ({
  page,
}) => {
  const { app, settings } = await setupReviewSettings(page, {
    review: {
      tour: { agent: "codex" },
    },
  });
  await selectSettingsPage(settings, "app", "Application");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await selectSettingsPage(settings, "reviews", "Reviews");
  await expect(settings.getByRole("note")).toContainText(
    /structured editor before editing reviews/iu,
  );
  await expect(fieldAt(settings, "review.tour.agent").getByRole("combobox"))
    .toBeDisabled();

  await selectSettingsPage(settings, "app", "Application");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  await selectSettingsPage(settings, "reviews", "Reviews");
  await expect(fieldAt(settings, "review.tour.agent").getByRole("combobox"))
    .toBeEnabled();

  app.writable = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(settings.getByRole("note")).toContainText(/read-only/iu);
  await expect(fieldAt(settings, "review.tour.agent").getByRole("combobox"))
    .toBeDisabled();
});

// preserve the complete permanent form and collection controls in the mobile layout
test("keeps Reviews complete and contained in the mobile settings selector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings } = await setupReviewSettings(page, {
    review: {
      presets: [
        {
          id: "security",
          label: "Security",
          agent: "codex",
          prompt: "Review security boundaries.",
        },
      ],
    },
  });
  await selectSettingsPage(settings, "reviews", "Reviews");
  await expect(
    settings.getByRole("heading", { name: "Reviews", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(fieldAt(settings, "review.agents.codex.mode")).toBeVisible();
  await expect(fieldAt(settings, "review.presets.0.prompt")).toBeVisible();
  const geometry = await settings.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    right: element.getBoundingClientRect().right,
  }));
  expect(geometry.scrollWidth - geometry.clientWidth).toBeLessThanOrEqual(1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-reviews-mobile.png",
  });
  await fieldAt(settings, "review.presets").scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-reviews-preset-mobile.png",
  });
});
