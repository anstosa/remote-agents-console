import { expect, test, type Page } from "@playwright/test";
import { installPaneMock } from "./pane-stream-mock.js";

const agents = [
  {
    id: "agent-cora",
    paneId: "%1",
    sessionId: "socket:$1",
    socketFingerprint: "socket",
    home: "/worktrees/cora",
    worktreeId: "cora",
    worktreeLabel: "Cora",
    worktreeOrder: 0,
    title: "Ready",
    unread: false,
  },
  {
    id: "agent-owen",
    paneId: "%2",
    sessionId: "socket:$2",
    socketFingerprint: "socket",
    home: "/worktrees/owen",
    worktreeId: "owen",
    worktreeLabel: "Owen",
    worktreeOrder: 1,
    title: "Ready",
    unread: false,
  },
] as const;

const protectedMarker = `__RAC_PROTECTED_${"A".repeat(43)}__`;

type WorktreeSettingsState = {
  reveals: unknown[];
  remasks: unknown[];
  validations: unknown[];
  saves: unknown[];
  settingsReads: number;
  completedSettingsReads: string[];
  serverName: string;
  appContent?: string;
  revision: number;
  validationGate?: Promise<void>;
  validationIssues?: Array<{
    sourceId: string;
    path: string[];
    code: string;
    message: string;
  }>;
  nextSettingsRead?: {
    wait: Promise<void>;
    serverName: string;
    revision: number;
  };
};

// hold one synthetic request until the test releases it
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// expose one ordinary structured draft and one protected raw disclosure
const settingsSources = (
  serverName: string,
  revision: number,
  appContent?: string,
) => [
  {
    id: "app",
    label: "Application config",
    path: "/checkout/config/config.json",
    format: "json",
    exists: true,
    writable: true,
    protected: false,
    tracked: false,
    revisionId: `app-r${revision}`,
    apply: "rac-restart",
    ...(appContent === undefined ? {} : { content: appContent }),
    value: { identity: { name: serverName } },
    schema: {
      type: "object",
      properties: {
        identity: {
          type: "object",
          properties: {
            name: { type: "string", label: "Server name" },
          },
        },
      },
    },
  },
  {
    id: "env",
    label: "Environment & keys",
    path: "/checkout/.env",
    format: "env",
    exists: true,
    writable: true,
    protected: true,
    tracked: false,
    revisionId: "env-r1",
    apply: "rac-restart",
    content: `EDITOR_COMMAND=code --wait\nRAC_SESSION_SECRET=${protectedMarker}\n`,
    hasProtectedContent: true,
    fields: [
      {
        key: "EDITOR_COMMAND",
        value: "code --wait",
        protected: false,
        present: true,
        apply: "rac-restart",
      },
      {
        key: "RAC_SESSION_SECRET",
        protected: true,
        present: true,
        apply: "rac-restart",
      },
    ],
  },
];

// mount two independent worktrees around one global Settings catalog
async function setupWorktreeSettings(page: Page) {
  await installPaneMock(page);
  const state: WorktreeSettingsState = {
    reveals: [],
    remasks: [],
    validations: [],
    saves: [],
    settingsReads: 0,
    completedSettingsReads: [],
    serverName: "Framework",
    revision: 1,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate the synthetic browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "settings-csrf",
          active: true,
          deviceName: "Test browser",
          davo: { available: false },
        },
      });
    // expose both worktrees
    if (path === "/api/dashboard")
      return route.fulfill({
        json: {
          generation: 1,
          adapters: {},
          agents,
          projects: [],
          cleanupPending: 0,
          reviews: [],
          reviewTour: { available: false, reason: "generator_unavailable" },
        },
      });
    // authorize both synthetic panes
    if (/^\/api\/agents\/agent-(?:cora|owen)\/tickets$/u.test(path))
      return route.fulfill({ json: { ticket: "log-ticket" } });
    // keep optional agent collections empty
    if (
      /^\/api\/agents\/agent-(?:cora|owen)\/(?:saved-prompts|queued-prompts|prompt-history)$/u.test(
        path,
      )
    )
      return route.fulfill({ json: { prompts: [] } });
    // keep both note collections empty
    if (/^\/api\/worktrees\/(?:cora|owen)\/notes$/u.test(path))
      return route.fulfill({ json: { notes: [] } });
    // publish a minimal global Settings catalog
    if (path === "/api/settings" && request.method() === "GET") {
      const plan = state.nextSettingsRead;
      state.nextSettingsRead = undefined;
      state.settingsReads += 1;
      const serverName = plan?.serverName ?? state.serverName;
      const revision = plan?.revision ?? state.revision;
      // return the snapshot captured when this request began
      if (plan !== undefined) await plan.wait;
      state.completedSettingsReads.push(serverName);
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${revision}`,
          sources: settingsSources(serverName, revision, state.appContent),
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // hold validation to model a save that outlives its workspace view
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        changes?: Array<{ migration?: { mode?: string } }>;
      };
      state.validations.push(body);
      const gate = state.validationGate;
      // wait only for the gate captured by this validation
      if (gate !== undefined) await gate;
      state.validationGate = undefined;
      const issues = body.changes?.some((change) => change.migration !== undefined)
        ? []
        : (state.validationIssues ?? []);
      return route.fulfill({
        json: { valid: issues.length === 0, issues, warnings: [] },
      });
    }
    // project the saved server name into the global authoritative snapshot
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as {
        changes?: Array<{
          sourceId?: string;
          content?: string;
          patches?: Array<{ op?: string; path?: string[]; value?: unknown }>;
        }>;
      };
      state.saves.push(body);
      const patch = body.changes
        ?.flatMap((change) => change.patches ?? [])
        .find(
          (candidate) =>
            candidate.op === "set" &&
            candidate.path?.join(".") === "identity.name",
        );
      // retain only a valid synthetic server-name write
      if (typeof patch?.value === "string") state.serverName = patch.value;
      const rawApplication = body.changes?.find(
        (change) =>
          change.sourceId === "app" && typeof change.content === "string",
      )?.content;
      // project a valid raw application write into the next snapshot
      if (rawApplication !== undefined) {
        state.appContent = rawApplication;
        const parsed = JSON.parse(rawApplication) as {
          identity?: { name?: unknown };
        };
        if (typeof parsed.identity?.name === "string")
          state.serverName = parsed.identity.name;
      }
      state.revision += 1;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.revision}`,
          sources: settingsSources(
            state.serverName,
            state.revision,
            state.appContent,
          ),
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // disclose only the protected source requested by this fixture
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      state.reveals.push(request.postDataJSON());
      return route.fulfill({
        json: {
          value:
            "EDITOR_COMMAND=code --wait\nRAC_SESSION_SECRET=fixture-session-secret\n",
          revisionId: "env-r1",
          leaseId: `lease-${state.reveals.length}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    // record lease cleanup when a workspace switch unmounts Settings
    if (path === "/api/settings/remask" && request.method() === "POST") {
      state.remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    // expose the matching restart status
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: false,
          targets: [],
          effective: "known",
          restartAvailable: true,
        },
      });
    // disable optional client integrations
    if (path === "/api/push/public-key")
      return route.fulfill({ json: {} });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    return route.fulfill({
      status: 404,
      json: { error: `not mocked: ${path}` },
    });
  });
  await page.goto("/");
  return state;
}

test("remembers whether Settings is open independently for each worktree", async ({
  page,
}) => {
  await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const globalSettings = page
    .getByRole("button", { name: "Global settings" })
    .first();
  const cora = page.getByRole("tab", { name: "Cora — Prompt done" });
  const owen = page.getByRole("tab", { name: "Owen — Prompt done" });

  await globalSettings.click();
  await expect(settings).toBeVisible();
  await owen.click();
  await expect(settings).toHaveCount(0);
  await cora.click();
  await expect(settings).toBeVisible();

  await owen.click();
  await globalSettings.click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
  await cora.click();
  await expect(settings).toBeVisible();
  await owen.click();
  await expect(settings).toHaveCount(0);

  await page.reload();
  await expect(settings).toHaveCount(0);
  await cora.click();
  await expect(settings).toBeVisible();
});

test("retains an ordinary Settings draft but remasks a disclosure across worktree switches", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const cora = page.getByRole("tab", { name: "Cora — Prompt done" });
  const owen = page.getByRole("tab", { name: "Owen — Prompt done" });

  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await settings.getByLabel("Server name", { exact: true }).fill("Cora draft");
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", {
      name: "Environment & keys",
      exact: true,
    })
    .click();
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/fixture-session-secret/u);

  await owen.click();
  await cora.click();
  await expect(settings).toBeVisible();
  await expect.poll(() => state.remasks.length).toBe(1);
  expect(state.reveals).toHaveLength(1);
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await expect(settings.getByLabel("Server name", { exact: true })).toHaveValue(
    "Cora draft",
  );
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^This browser.*Unsaved changes$/u })
    .click();
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", {
      name: "Environment & keys",
      exact: true,
    })
    .click();
  await expect(settings.getByText("Whole source editor")).toBeVisible();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).not.toHaveValue(/fixture-session-secret/u);
  const persistedBrowserState = await page.evaluate(() =>
    Object.values(localStorage).join("\n"),
  );
  expect(persistedBrowserState).not.toContain("Cora draft");
  expect(persistedBrowserState).not.toContain("fixture-session-secret");
});

test("retains and saves a whole-source draft in raw mode after a worktree switch", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
  const raw = '{"identity":{"name":"Raw switch draft"}}';
  await settings
    .getByLabel("Application config source content", { exact: true })
    .fill(raw);

  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("tab", { name: "Cora — Prompt done" }).click();
  await expect(settings).toBeVisible();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await expect(settings.getByText("Whole source editor")).toBeVisible();
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await expect(
    settings.getByLabel("Application config source content", { exact: true }),
  ).toHaveValue(raw);
  expect(state.reveals).toHaveLength(0);

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({
    changes: [
      {
        sourceId: "app",
        revisionId: "app-r1",
        content: raw,
      },
    ],
  });
  await expect(
    settings.getByLabel("Application config source content", { exact: true }),
  ).toHaveValue(raw);
});

test("keeps a shared Settings save locked across a worktree handoff", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await settings
    .getByLabel("Server name", { exact: true })
    .fill("Saved across handoff");
  const gate = deferred();
  state.validationGate = gate.promise;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);

  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("button", { name: "Global settings" }).first().click();
  const theme = settings.getByRole("radio", {
    name: "Light theme",
    exact: true,
  });
  const saving = settings.getByRole("button", {
    name: "Saving…",
    exact: true,
  });
  await expect(theme).toBeDisabled();
  await expect(saving).toBeDisabled();
  await saving.click({ force: true });
  expect(state.validations).toHaveLength(1);
  expect(state.saves).toHaveLength(0);

  gate.resolve();
  await expect.poll(() => state.saves.length).toBe(1);
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  const name = settings.getByLabel("Server name", { exact: true });
  await expect(name).toHaveValue("Saved across handoff");
  await expect(name).toBeEnabled();
  await expect(saving).toHaveCount(0);
});

test("cancels a held shared save after runtime security invalidation", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  await settings
    .getByLabel("Server name", { exact: true })
    .fill("Cancelled across handoff");
  const gate = deferred();
  state.validationGate = gate.promise;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);

  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  gate.resolve();

  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem("rac.color-theme"))).toBeNull();
});

test("does not orphan a source handover prompt after its owner unmounts", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", {
      name: "Environment & keys",
      exact: true,
    })
    .click();
  await settings
    .getByLabel("EDITOR_COMMAND", { exact: true })
    .fill("code --wait --handoff");
  const gate = deferred();
  state.validationGate = gate.promise;
  state.validationIssues = [
    {
      sourceId: "env",
      path: [],
      code: "migration_required",
      message: "Choose how to prepare Environment & keys.",
    },
  ];
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);

  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("button", { name: "Global settings" }).first().click();
  gate.resolve();

  await expect(
    page.getByRole("alertdialog", { name: "Choose source handover" }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(0);
});

test("cancels handover after consent when revalidation outlives its owner", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", {
      name: "Environment & keys",
      exact: true,
    })
    .click();
  await settings
    .getByLabel("EDITOR_COMMAND", { exact: true })
    .fill("code --wait --consented");
  state.validationIssues = [
    {
      sourceId: "env",
      path: [],
      code: "migration_required",
      message: "Choose how to prepare Environment & keys.",
    },
  ];
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Choose source handover",
    exact: true,
  });
  await dialog
    .getByRole("radio", { name: "Copy current", exact: true })
    .check();
  const gate = deferred();
  state.validationGate = gate.promise;
  await dialog
    .getByRole("button", { name: "Continue and save", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(2);

  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  gate.resolve();

  await expect(dialog).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(0);
});

test("ignores an older passive Settings read after a newer worktree reopen", async ({
  page,
}) => {
  const state = await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const gate = deferred();
  state.nextSettingsRead = {
    wait: gate.promise,
    serverName: "Older snapshot",
    revision: 1,
  };
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await expect.poll(() => state.settingsReads).toBe(1);

  state.serverName = "Newer snapshot";
  state.revision = 2;
  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await expect.poll(() => state.settingsReads).toBe(2);
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: /^Application config/u })
    .click();
  const name = settings.getByLabel("Server name", { exact: true });
  await expect(name).toHaveValue("Newer snapshot");

  gate.resolve();
  await expect
    .poll(() => state.completedSettingsReads)
    .toEqual(["Newer snapshot", "Older snapshot"]);
  await page.waitForTimeout(250);
  await expect(name).toHaveValue("Newer snapshot");
});

test("does not leak an explicit Settings hash into the next worktree", async ({
  page,
}) => {
  await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.goto("/#settings");
  await expect(settings).toBeVisible();
  await page.getByRole("tab", { name: "Owen — Prompt done" }).click();
  await expect(settings).toHaveCount(0);
});

test("leaves active dirty Settings alone when closing inactive worktree splits", async ({
  page,
}) => {
  await setupWorktreeSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.getByRole("button", { name: "Global settings" }).first().click();
  await settings
    .getByRole("radio", { name: "Light theme", exact: true })
    .click();

  const owen = page.getByRole("tab", { name: "Owen — Prompt done" });
  await owen.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Owen workspace" })
    .getByRole("menuitem", { name: "Close all splits", exact: true })
    .click();
  await expect(
    settings.getByRole("alertdialog", {
      name: "Close Settings with unsaved changes?",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("radio", { name: "Light theme", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("tab", { name: "Cora — Prompt done" }),
  ).toHaveAttribute("aria-selected", "true");
});
