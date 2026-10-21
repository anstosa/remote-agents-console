import { expect, test, type Locator, type Page } from "@playwright/test";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";
import type {
  SettingsPatch,
  SettingsSource,
} from "../src/settings/contracts.js";
import { mockAccountSocket } from "./account-fixture.js";

const protectedValue = {
  __racProtected: true,
  present: true,
  hasValue: true,
} as const;

type SavedChange = {
  sourceId: string;
  revisionId: string;
  patches?: SettingsPatch[];
};

type AgentEnvFixtureState = {
  saves: Array<{ changes: SavedChange[] }>;
  validations: Array<{ changes: SavedChange[] }>;
  validationIssues: Array<{
    sourceId: string;
    path: string[];
    code: string;
    message: string;
  }>;
  reveals: Array<{ sourceId: string; path: string[] }>;
  remasks: unknown[];
  revealWait?: Promise<void>;
};

// hold one synthetic response until the test releases it
function deferredResponse() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// return one authoritative application source with configured and omitted adapters
function applicationSource(): SettingsSource {
  const value = {
    name: "Agent environment fixture",
    publicOrigin: "https://agent-environment.test",
    adapters: {
      codex: {
        program: "/usr/local/bin/codex",
        env: {
          CODEX_HOME: "/home/fixture/.codex",
          ADAPTER_TOKEN: protectedValue,
        },
      },
      omx: {
        program: "/usr/local/bin/omx",
        env: { OMX_PROFILE: "fixture" },
      },
    },
  };
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
    content: `${JSON.stringify(value)}\n`,
    value,
    schema: applicationSettingsSchema(),
  };
}

// return dotenv metadata split between Codex, Claude, and the general Env page
function environmentSource(): SettingsSource {
  return {
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
    content:
      "RAC_CODEX_BIN=/usr/local/bin/codex\nRAC_HOST_CODEX_BIN=/host/bin/codex\nRAC_OPENAI_ADMIN_KEY=********\nRAC_CLAUDE_BIN=/usr/local/bin/claude\nGENERAL_SETTING=general\n",
    hasProtectedContent: true,
    fields: [
      {
        key: "RAC_CODEX_BIN",
        value: "/usr/local/bin/codex",
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "Codex executable override.",
      },
      {
        key: "RAC_HOST_CODEX_BIN",
        value: "/host/bin/codex",
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "Host Codex executable override.",
      },
      {
        key: "RAC_OPENAI_ADMIN_KEY",
        protected: true,
        present: true,
        hasValue: true,
        apply: "rac-restart",
        description: "OpenAI administration credential.",
      },
      {
        key: "RAC_OPENAI_API_KEY_IDS",
        protected: false,
        present: false,
        apply: "rac-restart",
        description: "OpenAI key identifier mapping.",
        fallback: { value: "Unavailable", kind: "derived" },
      },
      {
        key: "CODEX_VERSION",
        value: "0.160.0",
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "Codex container version.",
      },
      {
        key: "RAC_CLAUDE_BIN",
        value: "/usr/local/bin/claude",
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "Claude executable override.",
      },
      {
        key: "RAC_CLAUDE_CONFIG_DIR",
        protected: false,
        present: false,
        apply: "rac-restart",
        description: "Claude configuration directory.",
        fallback: { value: "/home/node/.claude", kind: "literal" },
      },
      {
        key: "GENERAL_SETTING",
        value: "general",
        protected: false,
        present: true,
        apply: "rac-restart",
        description: "General deployment variable.",
      },
    ],
  };
}

// mount a controlled Settings workspace and retain every source-bound request
async function setupAgentEnv(page: Page, width = 1440) {
  await mockAccountSocket(page);
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  const sources = [applicationSource(), environmentSource()];
  const state: AgentEnvFixtureState = {
    saves: [],
    validations: [],
    validationIssues: [],
    reveals: [],
    remasks: [],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate one controlling browser
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "agent-env-csrf",
          active: true,
          deviceName: "Agent environment browser",
          server: {
            name: "Agent environment fixture",
            url: "https://agent-environment.test",
            remotes: [],
          },
          davo: { enabled: false, available: false, name: "Davo", context: "" },
        },
      });
    // keep dashboard state independent from settings files
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
      return route.fulfill({ json: { ticket: "agent-env-ticket" } });
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
          revisionId: "snapshot-r1",
          installationKind: "compose",
          sources,
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as { changes: SavedChange[] };
      state.validations.push(body);
      return route.fulfill({
        json: {
          valid: state.validationIssues.length === 0,
          issues: state.validationIssues,
          warnings: [],
        },
      });
    }
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { changes: SavedChange[] };
      state.saves.push(body);
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${state.saves.length + 1}`,
          installationKind: "compose",
          sources,
          status: {
            pending: true,
            targets: ["rac"],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        sourceId: string;
        path: string[];
      };
      state.reveals.push(body);
      const revealNumber = state.reveals.length;
      // keep one requested disclosure pending across structural removal
      if (state.revealWait !== undefined) {
        await state.revealWait;
        state.revealWait = undefined;
      }
      const nested = body.sourceId === "app";
      return route.fulfill({
        json: {
          value: nested ? "fixture-adapter-token" : "fixture-admin-key",
          revisionId: nested ? "app-r1" : "env-r1",
          leaseId: `agent-env-lease-${revealNumber}`,
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
  return { settings, sources, state };
}

// navigate through either desktop navigation or the compact section picker
async function selectSection(settings: Locator, id: string, label: string) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // use the mobile section picker when the source rail is hidden
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
    .getByRole("button", {
      name: new RegExp(`^${label}(?: · Unsaved changes)?$`, "u"),
    })
    .click();
}

// scope repeated adapter controls to one visible adapter section
function adapterSection(settings: Locator, kind: string) {
  return settings.locator(`[data-settings-path="adapters.${kind}"]`);
}

// locate one exact saved source change
function savedChange(
  state: AgentEnvFixtureState,
  sourceId: string,
): SavedChange | undefined {
  return state.saves[0]?.changes.find((change) => change.sourceId === sourceId);
}

test("shows permanent lifecycle and Environment & keys only inside configured adapters", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");

  const codex = adapterSection(settings, "codex");
  const omx = adapterSection(settings, "omx");
  await expect(
    codex.getByRole("heading", { name: "Codex", exact: true, level: 3 }),
  ).toBeVisible();
  await expect(
    omx.getByRole("heading", { name: "OMX", exact: true, level: 3 }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Add Claude", exact: true }),
  ).toBeVisible();

  const codexEnv = codex.getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  const omxEnv = omx.getByRole("region", { name: "OMX Environment & keys", exact: true });
  for (const region of [codexEnv, omxEnv])
    await expect(
      region.getByRole("heading", { name: "Environment & keys", exact: true }),
    ).toBeVisible();
  await expect(
    settings.getByRole("region", {
      name: "Claude Environment & keys",
      exact: true,
    }),
  ).toHaveCount(0);

  await expect(codexEnv.getByLabel("CODEX_HOME", { exact: true })).toHaveValue(
    "/home/fixture/.codex",
  );
  for (const key of [
    "RAC_CODEX_BIN",
    "RAC_HOST_CODEX_BIN",
    "RAC_OPENAI_ADMIN_KEY",
    "RAC_OPENAI_API_KEY_IDS",
    "CODEX_VERSION",
  ])
    await expect(codexEnv.getByText(key, { exact: true })).toBeVisible();
  await expect(omxEnv.getByLabel("OMX_PROFILE", { exact: true })).toHaveValue(
    "fixture",
  );
  await expect(omxEnv.getByText("RAC_CODEX_BIN", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    codexEnv.getByRole("button", {
      name: "Add environment variable",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    omxEnv.getByRole("button", {
      name: "Add environment variable",
      exact: true,
    }),
  ).toBeEnabled();
  for (const label of ["Setup", "Teardown"]) {
    const lifecycle = codex.locator(
      `[data-settings-path="adapters.codex.${label.toLowerCase()}"]`,
    );
    await expect(
      lifecycle.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue("");
    await expect(
      lifecycle.getByRole("button", { name: `Add ${label}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      lifecycle.getByRole("button", { name: `Remove ${label}`, exact: true }),
    ).toHaveCount(0);
  }
  await expect(
    settings.getByRole("region", {
      name: "Agents environment settings",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    codex.getByRole("button", { name: "Remove Codex", exact: true }),
  ).toBeVisible();
  await expect(
    codex.getByRole("button", { name: "Remove section", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-agent-env-desktop.png",
  });
  expect(state.saves).toEqual([]);
});

test("reveals Environment & keys only while an adapter is configured", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const environment = settings.getByRole("region", {
    name: "Claude Environment & keys",
    exact: true,
  });
  const add = settings.getByRole("button", {
    name: "Add Claude",
    exact: true,
  });

  await expect(environment).toHaveCount(0);
  await add.click();
  await expect(environment).toBeVisible();
  await expect(
    environment.getByLabel("RAC_CLAUDE_BIN", { exact: true }),
  ).toHaveValue("/usr/local/bin/claude");
  await expect(
    environment.getByLabel("RAC_CLAUDE_CONFIG_DIR", { exact: true }),
  ).toHaveValue("");
  await expect(
    environment.getByRole("button", {
      name: "Add environment variable",
      exact: true,
    }),
  ).toBeEnabled();

  await adapterSection(settings, "claude")
    .getByRole("button", { name: "Remove Claude", exact: true })
    .click();
  await expect(environment).toHaveCount(0);
  await expect(add).toBeVisible();
  await add.click();
  await expect(environment).toBeVisible();
  expect(state.saves).toEqual([]);
});

test("sets and clears permanent lifecycle fields without authoring blank defaults", async ({
  page,
}) => {
  const { settings, sources, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");
  const setup = codex.getByRole("textbox", { name: "Setup", exact: true });
  const teardown = codex.getByRole("textbox", {
    name: "Teardown",
    exact: true,
  });

  await setup.fill("echo prepare");
  await setup.fill("   ");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await setup.fill("echo prepare");
  await teardown.fill("echo cleanup");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["adapters", "codex", "setup"],
        value: "echo prepare",
      },
      {
        op: "set",
        path: ["adapters", "codex", "teardown"],
        value: "echo cleanup",
      },
    ]),
  );

  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as {
    adapters: { codex: Record<string, unknown> };
  };
  appValue.adapters.codex.setup = "echo prepare";
  appValue.adapters.codex.teardown = "echo cleanup";
  state.saves = [];
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await codex.getByRole("textbox", { name: "Setup", exact: true }).fill("");
  await codex
    .getByRole("textbox", { name: "Teardown", exact: true })
    .fill("   ");
  await expect(
    codex.getByRole("textbox", { name: "Setup", exact: true }),
  ).toHaveValue("");
  await expect(
    codex.getByRole("textbox", { name: "Teardown", exact: true }),
  ).toHaveValue("");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      { op: "remove", path: ["adapters", "codex", "setup"] },
      { op: "remove", path: ["adapters", "codex", "teardown"] },
    ]),
  );
});

test("saves nested launch variables and dotenv keys to their owning sources", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codexEnv = adapterSection(settings, "codex").getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });

  await codexEnv
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await codexEnv.getByLabel("Variable", { exact: true }).fill("CUSTOM_LAUNCH");
  await codexEnv.getByLabel("Value", { exact: true }).fill("launch-value");
  await codexEnv
    .getByRole("button", { name: "Add variable", exact: true })
    .click();
  await expect(
    codexEnv.getByLabel("CUSTOM_LAUNCH", { exact: true }),
  ).toHaveValue("launch-value");
  await codexEnv
    .getByLabel("RAC_CODEX_BIN", { exact: true })
    .fill("/custom/bin/codex");

  await codexEnv
    .getByRole("button", { name: "Reveal ADAPTER_TOKEN", exact: true })
    .click();
  await codexEnv
    .getByRole("textbox", { name: "ADAPTER_TOKEN", exact: true })
    .fill("adapter-token-next");
  await codexEnv
    .getByRole("button", {
      name: "Reveal RAC_OPENAI_ADMIN_KEY",
      exact: true,
    })
    .click();
  await codexEnv
    .getByRole("textbox", { name: "RAC_OPENAI_ADMIN_KEY", exact: true })
    .fill("admin-key-next");

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.reveals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceId: "app",
        path: ["adapters", "codex", "env", "ADAPTER_TOKEN"],
      }),
      expect.objectContaining({
        sourceId: "env",
        path: ["RAC_OPENAI_ADMIN_KEY"],
      }),
    ]),
  );
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["adapters", "codex", "env", "CUSTOM_LAUNCH"],
        value: "launch-value",
      },
      {
        op: "set",
        path: ["adapters", "codex", "env", "ADAPTER_TOKEN"],
        value: "adapter-token-next",
      },
    ]),
  );
  expect(savedChange(state, "env")?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["RAC_CODEX_BIN"],
        value: "/custom/bin/codex",
      },
      {
        op: "set",
        path: ["RAC_OPENAI_ADMIN_KEY"],
        value: "admin-key-next",
      },
    ]),
  );
});

test("remasks deleted launch secrets and preserves protected add-field semantics", async ({
  page,
}) => {
  const { settings, sources, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codexEnv = adapterSection(settings, "codex").getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  await codexEnv
    .getByRole("button", { name: "Reveal ADAPTER_TOKEN", exact: true })
    .click();
  await expect(
    codexEnv.getByRole("textbox", { name: "ADAPTER_TOKEN", exact: true }),
  ).toHaveValue("fixture-adapter-token");
  await codexEnv
    .getByRole("button", { name: "Remove ADAPTER_TOKEN", exact: true })
    .click();
  await expect(
    codexEnv.getByRole("button", { name: "Reveal ADAPTER_TOKEN", exact: true }),
  ).toHaveCount(0);
  await expect(codexEnv.getByLabel("CODEX_HOME", { exact: true })).toHaveValue(
    "/home/fixture/.codex",
  );
  await expect.poll(() => state.remasks.length).toBe(1);
  expect(state.remasks[0]).toEqual({ leaseId: "agent-env-lease-1" });
  await codexEnv
    .getByRole("button", { name: "Remove CODEX_HOME", exact: true })
    .click();
  await expect(codexEnv.getByLabel("CODEX_HOME", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    codexEnv.getByRole("heading", { name: "Environment & keys", exact: true }),
  ).toBeVisible();
  await expect(
    codexEnv.getByLabel("RAC_CODEX_BIN", { exact: true }),
  ).toBeEditable();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "remove",
        path: ["adapters", "codex", "env"],
      },
    ]),
  );

  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as {
    adapters: Record<string, unknown>;
  };
  appValue.adapters.claude = { program: "/usr/local/bin/claude" };
  state.saves = [];
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const claudeEnv = adapterSection(settings, "claude").getByRole("region", {
    name: "Claude Environment & keys",
    exact: true,
  });
  await claudeEnv
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await claudeEnv
    .getByLabel("Variable", { exact: true })
    .fill("NEW_PASSWORD");
  await expect(claudeEnv.getByLabel("Value", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await claudeEnv.getByLabel("Value", { exact: true }).fill("new-secret");
  await claudeEnv
    .getByRole("button", { name: "Add variable", exact: true })
    .click();
  await expect(
    claudeEnv.getByLabel("NEW_PASSWORD masked", { exact: true }),
  ).toBeVisible();
  await claudeEnv
    .getByRole("button", { name: "Remove NEW_PASSWORD", exact: true })
    .click();
  await expect(
    claudeEnv.getByRole("heading", { name: "Environment & keys", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);

  await claudeEnv
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await claudeEnv
    .getByLabel("Variable", { exact: true })
    .fill("PUBLIC_VALUE");
  await expect(claudeEnv.getByLabel("Value", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await claudeEnv
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});

test("revokes accepted nested and dotenv secrets when an adapter is removed", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");
  const codexEnv = codex.getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  await codexEnv
    .getByRole("button", { name: "Reveal ADAPTER_TOKEN", exact: true })
    .click();
  await expect(
    codexEnv.getByRole("textbox", { name: "ADAPTER_TOKEN", exact: true }),
  ).toHaveValue("fixture-adapter-token");
  await codexEnv
    .getByRole("button", {
      name: "Reveal RAC_OPENAI_ADMIN_KEY",
      exact: true,
    })
    .click();
  await expect(
    codexEnv.getByRole("textbox", {
      name: "RAC_OPENAI_ADMIN_KEY",
      exact: true,
    }),
  ).toHaveValue("fixture-admin-key");
  await codex
    .getByRole("button", { name: "Remove Codex", exact: true })
    .click();
  await expect(
    settings.locator('[data-settings-path="adapters.codex.program"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("region", {
      name: "Codex Environment & keys",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect.poll(() => state.remasks.length).toBe(2);
  expect(state.remasks).toEqual(
    expect.arrayContaining([
      { leaseId: "agent-env-lease-1" },
      { leaseId: "agent-env-lease-2" },
    ]),
  );
  await expect(settings).not.toContainText("fixture-adapter-token");
  await expect(settings).not.toContainText("fixture-admin-key");
});

test("revokes late nested and dotenv secret responses after adapter removal", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");
  const codexEnv = codex.getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  const delayed = deferredResponse();
  state.revealWait = delayed.promise;
  await codexEnv
    .getByRole("button", { name: "Reveal ADAPTER_TOKEN", exact: true })
    .click();
  await codexEnv
    .getByRole("button", {
      name: "Reveal RAC_OPENAI_ADMIN_KEY",
      exact: true,
    })
    .click();
  await expect.poll(() => state.reveals.length).toBe(2);
  await codex
    .getByRole("button", { name: "Remove Codex", exact: true })
    .click();
  await expect(
    settings.locator('[data-settings-path="adapters.codex.program"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("region", {
      name: "Codex Environment & keys",
      exact: true,
    }),
  ).toHaveCount(0);
  delayed.resolve();
  await expect.poll(() => state.remasks.length).toBe(2);
  expect(state.remasks).toEqual(
    expect.arrayContaining([
      { leaseId: "agent-env-lease-1" },
      { leaseId: "agent-env-lease-2" },
    ]),
  );
  await expect(settings).not.toContainText("fixture-adapter-token");
  await expect(settings).not.toContainText("fixture-admin-key");
});

// revoke lifecycle command leases before permanent fields return to blank
test("clears accepted and pending protected lifecycle commands through blank values", async ({
  page,
}) => {
  const { settings, sources, state } = await setupAgentEnv(page);
  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as {
    adapters: {
      codex: Record<string, unknown>;
    };
  };
  appValue.adapters.codex.setup = protectedValue;
  appValue.adapters.codex.teardown = protectedValue;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");

  const setup = codex.locator('[data-settings-path="adapters.codex.setup"]');
  await setup
    .getByRole("button", { name: "Reveal Setup", exact: true })
    .click();
  await expect(setup.getByRole("textbox", { name: "Setup" })).toHaveValue(
    "fixture-adapter-token",
  );
  await setup.getByRole("textbox", { name: "Setup" }).fill("   ");
  await expect(
    setup.getByRole("button", { name: "Remove Setup", exact: true }),
  ).toHaveCount(0);
  await expect(
    setup.getByRole("button", { name: "Add Setup", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => state.remasks.length).toBe(1);
  expect(state.remasks[0]).toEqual({ leaseId: "agent-env-lease-1" });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      { op: "remove", path: ["adapters", "codex", "setup"] },
    ]),
  );

  const teardown = codex.locator(
    '[data-settings-path="adapters.codex.teardown"]',
  );
  const delayed = deferredResponse();
  state.revealWait = delayed.promise;
  await teardown
    .getByRole("button", { name: "Reveal Teardown", exact: true })
    .click();
  await expect.poll(() => state.reveals.length).toBe(2);
  await teardown
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
  const replacement = teardown.getByRole("textbox", {
    name: "New Teardown",
    exact: true,
  });
  await replacement.fill("echo temporary");
  await teardown
    .getByRole("textbox", { name: "Teardown", exact: true })
    .fill("   ");
  await expect(
    teardown.getByRole("button", { name: "Remove Teardown", exact: true }),
  ).toHaveCount(0);
  await expect(
    teardown.getByRole("button", { name: "Add Teardown", exact: true }),
  ).toHaveCount(0);
  delayed.resolve();
  await expect.poll(() => state.remasks.length).toBe(2);
  expect(state.remasks[1]).toEqual({ leaseId: "agent-env-lease-2" });
  await expect(settings).not.toContainText("fixture-adapter-token");
});

test("keeps Args and Updates visible without materializing defaults", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");
  const args = codex.locator('[data-settings-path="adapters.codex.args"]');
  const updates = codex.locator(
    '[data-settings-path="adapters.codex.updates"]',
  );

  await expect(args).toBeVisible();
  await expect(
    args.getByRole("button", { name: "+ Add Arg", exact: true }),
  ).toBeVisible();
  await expect(updates).toBeVisible();
  for (const label of [
    "Get current version command",
    "Get latest version command",
    "Update command",
  ])
    await expect(updates.getByRole("textbox", { name: label })).toHaveValue("");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);

  await args.getByRole("button", { name: "+ Add Arg", exact: true }).click();
  await args
    .locator('[data-settings-path="adapters.codex.args.0"] input')
    .fill("--profile");
  await args
    .getByRole("button", { name: "Remove Args 1", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);

  const current = updates.getByRole("textbox", {
    name: "Get current version command",
  });
  await current.fill("codex --version");
  await current.fill("");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("retains incomplete Update commands for server validation", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "agents", "Agents");
  const updates = adapterSection(settings, "codex").locator(
    '[data-settings-path="adapters.codex.updates"]',
  );
  await updates
    .getByRole("textbox", { name: "Get current version command" })
    .fill("codex --version");
  state.validationIssues = [
    {
      sourceId: "app",
      path: ["adapters", "codex", "updates", "latest"],
      code: "invalid_value",
      message: "Configure every Update command or clear all three.",
    },
  ];
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    settings.getByText("Configure every Update command or clear all three.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    updates.getByRole("textbox", { name: "Get current version command" }),
  ).toHaveValue("codex --version");
  expect(state.saves).toEqual([]);
});

test("clears a masked Update triplet as one optional object", async ({
  page,
}) => {
  const { settings, sources, state } = await setupAgentEnv(page);
  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as {
    adapters: {
      codex: Record<string, unknown>;
    };
  };
  appValue.adapters.codex.updates = {
    current: protectedValue,
    latest: "npm view @openai/codex version",
    run: "npm install --global @openai/codex@latest",
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSection(settings, "agents", "Agents");
  const updates = adapterSection(settings, "codex").locator(
    '[data-settings-path="adapters.codex.updates"]',
  );
  await expect(
    updates.getByLabel("Get current version command masked", { exact: true }),
  ).toBeVisible();
  await expect(
    updates.getByRole("textbox", { name: "Get latest version command" }),
  ).toHaveValue("npm view @openai/codex version");
  await expect(
    updates.getByRole("textbox", { name: "Update command" }),
  ).toHaveValue("npm install --global @openai/codex@latest");
  for (const label of [
    "Get current version command",
    "Get latest version command",
    "Update command",
  ])
    await expect(
      updates.getByRole("button", { name: `Remove ${label}`, exact: true }),
    ).toHaveCount(0);

  await updates
    .getByRole("button", {
      name: "Reveal Get current version command",
      exact: true,
    })
    .click();
  const current = updates.getByRole("textbox", {
    name: "Get current version command",
  });
  await expect(current).toHaveValue("fixture-adapter-token");
  await current.fill("   ");
  state.validationIssues = [
    {
      sourceId: "app",
      path: ["adapters", "codex", "updates", "current"],
      code: "invalid_value",
      message: "Use a non-whitespace Update command.",
    },
  ];
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    updates
      .locator('[data-settings-path="adapters.codex.updates.current"]')
      .getByText("Use a non-whitespace Update command.", { exact: true }),
  ).toBeVisible();
  expect(state.saves).toEqual([]);
  state.validationIssues = [];
  await current.fill("");
  await updates
    .getByRole("textbox", { name: "Get latest version command" })
    .fill("");
  await updates.getByRole("textbox", { name: "Update command" }).fill("");
  await expect.poll(() => state.remasks.length).toBe(1);
  expect(state.remasks[0]).toEqual({ leaseId: "agent-env-lease-1" });
  for (const label of [
    "Get current version command",
    "Get latest version command",
    "Update command",
  ])
    await expect(updates.getByRole("textbox", { name: label })).toHaveValue("");

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(savedChange(state, "app")?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "remove",
        path: ["adapters", "codex", "updates"],
      },
    ]),
  );
});

test("locks only the adapter Environment & keys rows owned by each raw source", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page);
  await selectSection(settings, "app", "Application");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await selectSection(settings, "agents", "Agents");
  let codexEnv = adapterSection(settings, "codex").getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  await expect(codexEnv.getByLabel("CODEX_HOME", { exact: true })).toBeDisabled();
  await expect(
    codexEnv.getByLabel("RAC_CODEX_BIN", { exact: true }),
  ).toBeEnabled();

  await selectSection(settings, "app", "Application");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  await selectSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await selectSection(settings, "agents", "Agents");
  codexEnv = adapterSection(settings, "codex").getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  await expect(codexEnv.getByLabel("CODEX_HOME", { exact: true })).toBeEnabled();
  await expect(
    codexEnv.getByLabel("RAC_CODEX_BIN", { exact: true }),
  ).toBeDisabled();
  expect(state.saves).toEqual([]);
});

test("keeps merged adapter Environment & keys controls inside the mobile Settings panel", async ({
  page,
}) => {
  const { settings, state } = await setupAgentEnv(page, 390);
  await selectSection(settings, "agents", "Agents");
  const codex = adapterSection(settings, "codex");
  const codexEnv = codex.getByRole("region", {
    name: "Codex Environment & keys",
    exact: true,
  });
  await expect(codexEnv).toBeVisible();
  const [panelBox, envBox] = await Promise.all([
    settings.boundingBox(),
    codexEnv.boundingBox(),
  ]);
  if (panelBox === null || envBox === null)
    throw new Error("Mobile Agent Environment & keys layout has no bounds");
  expect(envBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(envBox.x + envBox.width).toBeLessThanOrEqual(
    panelBox.x + panelBox.width + 1,
  );
  await codexEnv
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await expect(codexEnv.getByLabel("Variable", { exact: true })).toBeVisible();
  await expect(codexEnv.getByLabel("Value", { exact: true })).toBeVisible();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-agent-env-mobile.png",
  });
  expect(state.saves).toEqual([]);
});
