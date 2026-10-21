import { expect, test, type Locator, type Page } from "@playwright/test";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";
import { mockAccountSocket } from "./account-fixture.js";

type SettingsPatch = {
  op: "set" | "remove" | "insert" | "move";
  path: string[];
  value?: unknown;
};

type ShellFixtureState = {
  saves: Array<{
    changes: Array<{ sourceId: string; patches?: SettingsPatch[] }>;
  }>;
  validations: unknown[];
  reveals: unknown[];
  remasks: unknown[];
  executionRequests: string[];
  pageErrors: string[];
  consoleErrors: string[];
};

const multilineCommand =
  'command --name "two words" --retry -3 --flag --next=value -- https://shell-command-must-not-run.invalid/value alpha beta';

const protectedMarker = {
  __racProtected: true,
  present: true,
  hasValue: true,
} as const;

// ignore Chromium's plain-http mapped-host policy diagnostic
const actionableConsoleErrors = (state: ShellFixtureState) =>
  state.consoleErrors.filter(
    (message) => !message.includes("Cross-Origin-Opener-Policy"),
  );

const applicationValue = {
  name: "Shell command fixture",
  publicOrigin: "https://shell-settings.test",
  editor: multilineCommand,
  adapters: {
    codex: {
      program: "/usr/local/bin/codex",
      args: ["--profile", "fixture"],
      env: { CODEX_HOME: "/home/fixture/.codex" },
      setup: "printf '%s\\n' setup",
      teardown: "printf '%s\\n' teardown",
      updates: {
        current: "codex --version",
        latest: "npm view @openai/codex version",
        run: "npm install --global @openai/codex@latest",
      },
    },
  },
  integrations: {
    enabled: false,
    mcp: {
      readEnabled: true,
      writeEnabled: false,
      dangerousEnabled: false,
    },
    realtime: {
      enabled: false,
      name: "Davo",
      context: "",
      writeToolsEnabled: false,
    },
    multiInstance: { enabled: false },
  },
  keys: {
    prefix: {
      t: { terminal: multilineCommand, reuse: true },
      p: { terminal: protectedMarker, reuse: false },
    },
  },
  projects: [
    {
      id: "atlas",
      label: "Atlas",
      path: "/srv/atlas",
      hostPath: "/host/atlas",
      worktreeOrder: ["feature/ordered"],
      worktreeOverrides: [
        {
          path: "feature/override",
          commands: {
            build: "pnpm build:override",
            processes: {
              worker: {
                command: "pnpm worker:override",
                dependsOn: ["api"],
              },
            },
          },
        },
      ],
      commands: {
        start: multilineCommand,
        stop: "pnpm stop",
        build: "pnpm build",
        restart: "pnpm restart",
        migrate: "pnpm migrate",
        status: "pnpm status",
        setup: "pnpm setup",
        processes: {
          web: "pnpm dev",
          api: { command: "pnpm api", dependsOn: ["web"] },
        },
      },
      newTask: "codex exec --task {taskId}",
      push: { label: "Ship", prompt: "review, commit, and push" },
    },
  ],
};

// return a fresh redacted source for every settings read
function appSource() {
  return {
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
    value: structuredClone(applicationValue),
    schema: applicationSettingsSchema(),
  };
}

// mount settings with all writes retained inside the browser fixture
async function setupShellSettings(page: Page) {
  await mockAccountSocket(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state: ShellFixtureState = {
    saves: [],
    validations: [],
    reveals: [],
    remasks: [],
    executionRequests: [],
    pageErrors: [],
    consoleErrors: [],
  };
  // retain rendered production failures without treating warnings as errors
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (message) => {
    // capture only browser error diagnostics
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  // fail closed if browser formatting or saving evaluates a fixture command
  await page.route("https://shell-command-must-not-run.invalid/**", (route) => {
    state.executionRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "shell-settings-csrf",
          active: true,
          deviceName: "Shell settings browser",
          server: {
            name: "Shell command fixture",
            url: "https://shell-settings.test",
            remotes: [],
          },
          davo: { enabled: false, available: false, name: "Davo", context: "" },
        },
      });
    // keep dashboard state separate from file-backed drafts
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
          keys: {},
        },
      });
    if (path === "/api/dashboard/ticket")
      return route.fulfill({ json: { ticket: "shell-settings-ticket" } });
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
    if (path === "/api/settings/cloudflare" && request.method() === "GET")
      return route.fulfill({
        json: {
          supported: false,
          mode: "unconfigured",
          enabled: false,
          tokenPresent: false,
          serviceUrl: "http://127.0.0.1:8787",
        },
      });
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-r1",
          installationKind: "compose",
          sources: [appSource()],
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
      state.saves.push(
        request.postDataJSON() as ShellFixtureState["saves"][number],
      );
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "settings-r2",
          installationKind: "compose",
          sources: [appSource()],
          status: {
            pending: true,
            targets: ["rac"],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // reveal only the synthetic masked keyboard command
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      const body = request.postDataJSON() as { revisionId: string };
      state.reveals.push(body);
      return route.fulfill({
        json: {
          value: 'curl "https://shell-command-must-not-run.invalid/revealed"',
          revisionId: body.revisionId,
          leaseId: `shell-command-lease-${state.reveals.length}`,
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
  await page.goto("/");
  await page.getByRole("button", { name: "Global settings" }).first().click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  return { settings, state };
}

// navigate through the desktop settings source rail
async function selectSection(settings: Locator, label: string) {
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", {
      name: new RegExp(`^${label}(?: · Unsaved changes)?$`, "u"),
    })
    .click();
}

// require one schema field to use the shell code editor
async function expectShellEditor(settings: Locator, path: string) {
  const field = settings.locator(
    `.settings-field-shell[data-settings-path="${path}"]`,
  );
  await expect(field).toBeVisible();
  await expect(field.locator(":scope > .settings-code-editor")).toHaveCount(1);
  await expect(field.locator(".syntax-command").first()).toBeVisible();
  return field.locator(":scope > .settings-code-editor");
}

// require one schema field to remain an ordinary scalar input
async function expectPlainInput(settings: Locator, path: string) {
  const field = settings.locator(`[data-settings-path="${path}"]`);
  await expect(field.locator(":scope > input")).toHaveCount(1);
  await expect(field.locator(":scope > .settings-code-editor")).toHaveCount(0);
}

test("edits only executable application values as shell code", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { settings, state } = await setupShellSettings(page);

  await selectSection(settings, "Application");
  const editor = await expectShellEditor(settings, "editor");
  const editorInput = editor.getByRole("textbox", { name: "Editor" });
  await expect(editorInput).toHaveAttribute(
    "placeholder",
    "Disabled when unset",
  );
  await expect(editor.locator(".settings-code-editor-toolbar")).toBeVisible();
  await expect(editor.locator(".syntax-line-number")).toHaveCount(1);
  await editor.getByRole("button", { name: "Format" }).click();
  await expect(editorInput).not.toHaveValue(/\n/u);

  await selectSection(settings, "Agents");
  for (const path of [
    "adapters.codex.setup",
    "adapters.codex.teardown",
    "adapters.codex.updates.current",
    "adapters.codex.updates.latest",
    "adapters.codex.updates.run",
  ])
    await expectShellEditor(settings, path);
  await expectPlainInput(settings, "adapters.codex.program");
  const args = settings.locator('[data-settings-path="adapters.codex.args"]');
  await args.locator(".settings-collection-edit").first().click();
  await expectPlainInput(settings, "adapters.codex.args.0");
  await expectPlainInput(settings, "adapters.codex.env.CODEX_HOME");

  await selectSection(settings, "Projects");
  await settings
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  for (const path of [
    "projects.0.commands.start",
    "projects.0.commands.stop",
    "projects.0.commands.build",
    "projects.0.commands.restart",
    "projects.0.commands.migrate",
    "projects.0.commands.status",
    "projects.0.commands.setup",
    "projects.0.newTask",
  ])
    await expectShellEditor(settings, path);
  await expectPlainInput(settings, "projects.0.path");
  await expectPlainInput(settings, "projects.0.hostPath");
  await expectPlainInput(settings, "projects.0.push.prompt");

  const worktreeOrder = settings.locator(
    '[data-settings-path="projects.0.worktreeOrder"]',
  );
  await worktreeOrder.locator(".settings-collection-edit").first().click();
  await expectPlainInput(settings, "projects.0.worktreeOrder.0");

  const processes = settings.locator(
    '[data-settings-path="projects.0.commands.processes"]',
  );
  await processes.getByRole("button", { name: "Edit web" }).click();
  await expectShellEditor(settings, "projects.0.commands.processes.web");
  await processes.getByRole("button", { name: "Edit api" }).click();
  await expectShellEditor(
    settings,
    "projects.0.commands.processes.api.command",
  );
  const dependencies = settings.locator(
    '[data-settings-path="projects.0.commands.processes.api.dependsOn"]',
  );
  await dependencies.locator(".settings-collection-edit").first().click();
  await expectPlainInput(
    settings,
    "projects.0.commands.processes.api.dependsOn.0",
  );

  const overrides = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides"]',
  );
  await overrides.locator(".settings-collection-edit").first().click();
  await expectPlainInput(settings, "projects.0.worktreeOverrides.0.path");
  await expectShellEditor(
    settings,
    "projects.0.worktreeOverrides.0.commands.build",
  );
  const overrideProcesses = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides.0.commands.processes"]',
  );
  await overrideProcesses.getByRole("button", { name: "Edit worker" }).click();
  await expectShellEditor(
    settings,
    "projects.0.worktreeOverrides.0.commands.processes.worker.command",
  );
  const overrideDependencies = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides.0.commands.processes.worker.dependsOn"]',
  );
  await overrideDependencies
    .locator(".settings-collection-edit")
    .first()
    .click();
  await expectPlainInput(
    settings,
    "projects.0.worktreeOverrides.0.commands.processes.worker.dependsOn.0",
  );

  const stackEditor = await expectShellEditor(
    settings,
    "projects.0.commands.start",
  );
  const stackInput = stackEditor.getByRole("textbox", { name: "Start" });
  await expect(stackInput).toHaveAttribute(
    "placeholder",
    "Not configured when unset",
  );
  await expect(
    stackEditor.locator(".settings-code-editor-toolbar"),
  ).toBeVisible();
  await stackEditor.getByRole("button", { name: "Format" }).click();
  await expect(stackInput).toHaveValue(/\n/u);
  await expect(stackInput).toHaveValue(
    /https:\/\/shell-command-must-not-run\.invalid/u,
  );
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-shell-commands-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await stackEditor.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await stackEditor.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      // keep the editor inside its mobile viewport
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    }),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-shell-commands-mobile.png",
  });

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.executionRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(actionableConsoleErrors(state)).toEqual([]);
  expect(state.saves[0]!.changes[0]!.patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "set",
        path: ["projects", "0", "commands", "start"],
      }),
    ]),
  );
});

test("uses single-line shell editors for safe and protected terminal bindings", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { settings, state } = await setupShellSettings(page);
  await selectSection(settings, "Keyboard shortcuts");
  await settings.getByRole("combobox", { name: "Key table" }).click();
  await page
    .getByRole("listbox", { name: "Key table options" })
    .getByRole("option", { name: "prefix", exact: true })
    .click();

  const safeRow = settings.locator(
    '[data-key-table="prefix"] [data-key-chord="t"]',
  );
  await safeRow.getByRole("button", { name: "Edit binding" }).click();
  const safeForm = settings.getByRole("group", {
    name: "Edit binding t in prefix",
  });
  const safeEditor = safeForm.locator(".settings-code-editor");
  const safeInput = safeEditor.getByRole("textbox", {
    name: "New terminal command",
  });
  await expect(safeEditor.locator(".syntax-command").first()).toBeVisible();
  await safeInput.fill(`${multilineCommand} --keyboard`);
  await safeEditor.getByRole("button", { name: "Format" }).click();
  await expect(safeInput).not.toHaveValue(/\n/u);
  await safeForm
    .getByRole("button", { name: "Apply binding", exact: true })
    .click();

  const protectedRow = settings.locator(
    '[data-key-table="prefix"] [data-key-chord="p"]',
  );
  await expect(protectedRow.getByLabel("Terminal command masked")).toHaveText(
    "••••••••",
  );
  await expect(protectedRow.locator(".settings-code-editor")).toHaveCount(0);
  await protectedRow
    .getByRole("button", { name: "Reveal Terminal command" })
    .click();
  const protectedEditor = protectedRow.locator(".settings-code-editor");
  const protectedInput = protectedEditor.getByRole("textbox", {
    name: "Terminal command",
  });
  await expect(protectedInput).toHaveValue(
    'curl "https://shell-command-must-not-run.invalid/revealed"',
  );
  await expect(
    protectedEditor.locator(
      ".settings-code-editor-toolbar [aria-label='Mask Terminal command']",
    ),
  ).toBeVisible();
  await expect(protectedEditor.locator(".syntax-command")).toContainText(
    "curl",
  );
  await protectedEditor.getByRole("button", { name: "Format" }).click();
  await expect(protectedInput).not.toHaveValue(/\n/u);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-protected-shell-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await protectedEditor.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-protected-shell-mobile.png",
  });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.executionRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(actionableConsoleErrors(state)).toEqual([]);
  expect(state.saves[0]!.changes[0]!.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["keys", "prefix", "t"],
        value: expect.objectContaining({
          terminal: expect.not.stringContaining("\n"),
        }),
      },
    ]),
  );
});
