import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectProgressBorder } from "./progress-border-assertions";
import { mockAccountSocket } from "./account-fixture";
import {
  confirmSettingsClose,
  confirmSettingsDiscard,
} from "./settings-confirmation-helpers.js";
import { isProtectedValue } from "../src/settings/contracts.js";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";

const authoritativeProjectsSchema =
  applicationSettingsSchema().properties!.projects!;

// choose only an explicitly clicked custom option
async function chooseSettingsOption(selector: Locator, value: string) {
  await selector.click();
  await selector
    .page()
    .getByRole("listbox")
    .locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
    .click();
}

// inspect a popup without changing its selected value
async function expectSettingsOptions(
  selector: Locator,
  count: number,
  groups?: number,
) {
  await selector.click();
  const popup = selector.page().getByRole("listbox");
  await expect(popup.getByRole("option")).toHaveCount(count);
  // inspect labelled groups when the case specifies them
  if (groups !== undefined)
    await expect(popup.getByRole("group")).toHaveCount(groups);
  await selector.page().keyboard.press("Escape");
}

// navigate through the visible mobile or desktop control
async function selectSettingsSection(
  settings: Locator,
  id: string,
  label: string,
) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones replace source buttons with the custom selector
  if (await selector.isVisible()) await chooseSettingsOption(selector, id);
  else {
    // retain precise navigation when a source has an unsaved indicator
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    await settings
      .getByRole("navigation", { name: "Settings sources" })
      .getByRole("button", {
        name: new RegExp(`^${escaped}(?: (?:· )?Unsaved changes)?$`, "u"),
      })
      .click();
  }
}

// stage an Installation migration through its supported whole-file editor
async function stageInstallationWholeSource(
  settings: Locator,
  environmentFile: string,
) {
  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const input = settings.getByLabel("Installation source content", {
    exact: true,
  });
  const content = await input.inputValue();
  await input.fill(content.replace("/checkout/.env", environmentFile));
  return input;
}

type PendingStatus = {
  pending: boolean;
  targets: Array<"rac" | "cloudflared">;
  effective: "known" | "unknown";
  restartAvailable: boolean;
  recoveryCommand?: string;
  operation?: {
    id: string;
    state: "queued" | "running" | "complete" | "failed";
    phase?: string;
    error?: string;
  };
};

type SettingsReadPlan = {
  wait?: Promise<void>;
  status?: number;
};

const settingsSourcePlaceholders = [
  { id: "app", label: "Application configuration" },
  { id: "projects", label: "Projects" },
  { id: "tmux", label: "TMUX" },
  { id: "env", label: "Environment & keys" },
  { id: "installation", label: "Installation" },
  { id: "compose-override", label: "Docker" },
  { id: "cloudflared", label: "Cloudflare tunnel" },
  { id: "cloudflared-credentials", label: "Cloudflare credentials" },
] as const;
const protectedSourceMarker = `__RAC_PROTECTED_${"A".repeat(43)}__`;

// control one delayed fixture response
function deferredResponse() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// mount a controlled console with a complete redacted settings catalog
async function setupSettings(
  page: Page,
  openApplication = true,
  includeIcons = false,
  voiceEnabled = false,
  settingsReadPlans: SettingsReadPlan[] = [],
  wrapper: "none" | "missing" | "protected" = "none",
  installationKind: "compose" | "systemd" = "compose",
  useAuthoritativeProjectsSchema = false,
) {
  await mockAccountSocket(page);
  // paint portable synthetic icons without reading installation artwork
  await page.route("**/instance-icons/*.svg*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#cba6f7"/></svg>',
    }),
  );
  const state = {
    authUnavailable: false,
    validationValid: true,
    migrationRequiredSourceIds: [] as string[],
    saveStatus: 200,
    status: {
      pending: false,
      targets: [],
      effective: "known",
      restartAvailable: true,
    } as PendingStatus,
    validations: [] as unknown[],
    saves: [] as unknown[],
    reveals: [] as unknown[],
    remasks: [] as unknown[],
    voiceSaves: [] as unknown[],
    restarts: 0,
    revealTtlMs: 60_000,
    settingsReads: 0,
  };
  const sources = [
    {
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
      pathRevisions: { '["identity","name"]': "identity-name-r1" },
      content:
        '{"identity":{"name":"Framework"},"tmux":{"pollIntervalMs":500}}\n',
      value: {
        identity: { name: "Framework" },
        adapter: { command: "/usr/bin/codex", args: ["--fixture-flag"] },
        keys: {
          prefix: { r: { terminal: "/usr/bin/tool --flag", reuse: true } },
        },
        name: "Framework",
        defaultAgent: "codex",
        tmux: { pollIntervalMs: 500 },
        ...(includeIcons ? { icon: "heart" } : {}),
        integrations: {
          realtime: {
            enabled: voiceEnabled,
            name: "Davo",
            context: "Speak plainly.",
            writeToolsEnabled: false,
          },
        },
        projects: [
          {
            label: "Atlas",
            path: "/code/atlas",
            id: "atlas",
            port: 4173,
            ...(useAuthoritativeProjectsSchema
              ? { commands: { processes: { web: "pnpm dev" } } }
              : {}),
          },
          { label: "Beacon", path: "/code/beacon", id: "beacon" },
        ],
      },
      schema: {
        type: "object",
        label: "Application config",
        properties: {
          identity: {
            type: "object",
            label: "Identity and network",
            properties: { name: { type: "string", label: "Server name" } },
          },
          adapter: {
            type: "object",
            label: "Agent adapter",
            properties: {
              command: { type: "string", label: "Shell command" },
              args: {
                type: "array",
                label: "Arguments",
                apply: "rac-restart",
                items: { type: "string", label: "Argument" },
              },
            },
          },
          keys: {
            type: "record",
            optional: true,
            label: "Key tables",
            apply: "rac-restart",
            items: {
              type: "record",
              label: "Bindings",
              items: {
                type: "union",
                nullable: true,
                variants: [
                  {
                    type: "enum",
                    options: ["next-panel", "show-bindings"],
                    label: "Built-in action",
                  },
                  {
                    type: "object",
                    label: "Switch table",
                    properties: { table: { type: "string" } },
                  },
                  {
                    type: "object",
                    label: "Terminal command",
                    properties: {
                      terminal: { type: "string" },
                      reuse: { type: "boolean", optional: true },
                    },
                  },
                ],
              },
            },
          },
          name: { type: "string", label: "Configuration server name" },
          defaultAgent: { type: "string", label: "Default agent" },
          tmux: {
            type: "object",
            label: "TMUX",
            properties: {
              pollIntervalMs: {
                type: "number",
                label: "Poll interval ms",
                apply: "rac-restart",
              },
            },
          },
          ...(includeIcons
            ? {
                icon: {
                  type: "enum",
                  label: "Icon",
                  optional: true,
                  options: ["terminal", "potato", "heart"],
                },
              }
            : {}),
          integrations: {
            type: "object",
            properties: {
              realtime: {
                type: "object",
                label: "Voice configuration",
                properties: {
                  enabled: { type: "boolean", label: "Enable voice" },
                  name: { type: "string", label: "Voice name" },
                  context: { type: "string", label: "Voice context" },
                  writeToolsEnabled: {
                    type: "boolean",
                    label: "Write tools enabled",
                  },
                },
              },
            },
          },
          projects: useAuthoritativeProjectsSchema ? authoritativeProjectsSchema : {
            type: "array",
            label: "Projects",
            items: {
              type: "object",
              label: "Project",
              default: { id: "new-project", label: "New project", path: "" },
              properties: {
                id: {
                  type: "string",
                  description: "Stable Project key.",
                },
                label: {
                  type: "string",
                  optional: true,
                  description: "Friendly project name.",
                },
                path: {
                  type: "string",
                  description: "Repository or directory path.",
                },
                hostPath: {
                  type: "string",
                  optional: true,
                  description: "Host-visible repository path.",
                },
                port: {
                  type: "number",
                  optional: true,
                  description: "Preview port override.",
                },
                hostname: {
                  type: "string",
                  optional: true,
                  description: "Preview hostname override.",
                },
                worktreeOrder: {
                  type: "array",
                  optional: true,
                  label: "Worktree order",
                  description: "Checkout paths to show first.",
                  items: { type: "string", label: "Worktree path" },
                },
                worktreeOverrides: {
                  type: "array",
                  optional: true,
                  label: "Worktree overrides",
                  description: "Per-checkout settings.",
                  items: {
                    type: "object",
                    label: "Worktree override",
                    properties: {
                      path: {
                        type: "string",
                        description: "Checkout to override.",
                      },
                    },
                  },
                },
                commands: {
                  type: "object",
                  optional: true,
                  label: "Commands",
                  description: "Default trusted shell commands.",
                  properties: {
                    start: {
                      type: "string",
                      optional: true,
                      description: "Trusted Start command.",
                    },
                    processes: {
                      type: "record",
                      optional: true,
                      label: "Processes",
                      description: "Named foreground processes.",
                      items: { type: "string", label: "Process command" },
                    },
                  },
                },
              },
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
      content: `RAC_PORT=8787\nEDITOR_COMMAND=code --wait\nRAC_TMUX_BIN=/usr/bin/tmux\nRAC_HOST_TMUX_DIR=/run/host-tmux\nRAC_HOST_TMUX_SOURCE=/home/test/.local/state/tmux\nRAC_HOST_UNIX_SOCKETS=/host/proc/net/unix\nHOST_TMUX_DIR=/home/test/.local/state/tmux\nHOST_TMUX_BIN=/usr/bin/tmux\nRAC_HOST_PROC=/host/proc\nRAC_HOST_UID=1000\nHOST_UID=1000\nRAC_HOST_INTERACTIVE_SHELL=/usr/bin/zsh\nRAC_HOST_PATH=/usr/local/bin:/usr/bin\nRAC_SESSION_SECRET=${protectedSourceMarker}\n`,
      hasProtectedContent: true,
      origin: "compose env_file: .env",
      overriddenBy: "services.remote-agent-console.environment.RAC_PORT",
      fields: [
        {
          key: "EDITOR_COMMAND",
          value: "code --wait",
          protected: false,
          present: true,
          apply: "rac-restart",
          origin: "compose env_file: .env",
          overriddenBy: "legacy process environment",
        },
        {
          key: "RAC_PORT",
          value: "8787",
          protected: false,
          present: true,
          apply: "rac-restart",
          winningSource: "Compose environment",
          origin: "compose env_file: .env",
          overriddenBy: "services.remote-agent-console.environment.RAC_PORT",
          description:
            "Saved file value; Compose currently overrides this key.",
        },
        {
          key: "RAC_SESSION_SECRET",
          protected: true,
          present: true,
          apply: "rac-restart",
          winningSource: "Compose environment",
          origin: "compose env_file: .env",
          overriddenBy:
            "services.remote-agent-console.environment.RAC_SESSION_SECRET",
          description: "Signs browser sessions.",
        },
        {
          key: "RAC_INSTANCE_STATUS_SECRET",
          protected: true,
          present: false,
          hasValue: false,
          apply: "rac-restart",
          description: "Authenticates status requests between RAC servers.",
          fallback: {
            value: "Uses RAC_SESSION_SECRET",
            kind: "derived",
          },
        },
        {
          key: "RAC_LISTEN_HOST",
          protected: false,
          present: false,
          apply: "rac-restart",
          description: "Network interface used by the RAC server.",
          fallback: { value: "127.0.0.1", kind: "literal" },
        },
        {
          key: "RAC_TMUX_BIN",
          value: "/usr/bin/tmux",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "tmux executable used by RAC.",
          fallback: { value: "/usr/local/bin/tmux", kind: "compose" },
        },
        {
          key: "RAC_HOST_TMUX_DIR",
          value: "/run/host-tmux",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Mounted host tmux socket directory.",
        },
        {
          key: "RAC_HOST_TMUX_SOURCE",
          value: "/home/test/.local/state/tmux",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host tmux socket source directory.",
        },
        {
          key: "RAC_HOST_UNIX_SOCKETS",
          value: "/host/proc/net/unix",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host Unix socket table.",
        },
        {
          key: "HOST_TMUX_DIR",
          value: "/home/test/.local/state/tmux",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host tmux socket bind source.",
        },
        {
          key: "HOST_TMUX_BIN",
          value: "/usr/bin/tmux",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host tmux binary bind source.",
        },
        {
          key: "RAC_HOST_PROC",
          value: "/host/proc",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Mounted host procfs root.",
        },
        {
          key: "RAC_HOST_UID",
          value: "1000",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host user ID used for process validation.",
        },
        {
          key: "HOST_UID",
          value: "1000",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Compose host user ID.",
        },
        {
          key: "RAC_HOST_INTERACTIVE_SHELL",
          value: "/usr/bin/zsh",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host interactive shell.",
        },
        {
          key: "RAC_HOST_PATH",
          value: "/usr/local/bin:/usr/bin",
          protected: false,
          present: true,
          apply: "rac-restart",
          description: "Host PATH used by bridged commands.",
        },
      ],
    },
    {
      id: "installation",
      label: "Installation",
      path: "/checkout/config/settings-installation.json",
      format: "installation",
      exists: true,
      writable: true,
      protected: false,
      tracked: false,
      revisionId: "install-r1",
      apply: "source-migration",
      content:
        '{"native":{"environmentFile":"/checkout/.env"},"compose":{"projectName":"rac"},"sources":{"wrapper":"/checkout/config/installation-wrapper.sh"}}\n',
      value: {
        native: { environmentFile: "/checkout/.env" },
        compose: { projectName: "rac" },
        sources: { wrapper: "/checkout/config/installation-wrapper.sh" },
      },
      schema: {
        type: "object",
        label: "Installation",
        properties: {
          native: {
            type: "object",
            properties: {
              environmentFile: { type: "string", label: "Environment file" },
            },
          },
          compose: {
            type: "object",
            properties: {
              projectName: { type: "string", label: "Project name" },
            },
          },
          sources: {
            type: "object",
            label: "Sources",
            properties: {
              wrapper: {
                type: "string",
                label: "Wrapper source",
              },
            },
          },
        },
      },
    },
    {
      id: "compose",
      label: "Base Compose",
      path: "/checkout/compose.yaml",
      format: "compose",
      exists: true,
      writable: false,
      protected: true,
      tracked: true,
      revisionId: "compose-base-r1",
      apply: "rac-restart",
      content: `services:\n  remote-agent-console:\n    image: ghcr.io/example/rac:base\n    environment:\n      RAC_SESSION_SECRET: ${protectedSourceMarker}\n`,
      hasProtectedContent: true,
    },
    {
      id: "compose-override",
      label: "Docker",
      path: "/checkout/compose.override.yaml",
      format: "compose",
      exists: true,
      writable: true,
      protected: true,
      tracked: true,
      revisionId: "compose-override-r1",
      apply: "rac-restart",
      content:
        "services:\n  remote-agent-console:\n    environment:\n      RAC_PORT: 8787\n",
      hasProtectedContent: false,
    },
    // add the optional wrapper only for wrapper-specific regressions
    ...(wrapper === "none"
      ? []
      : [
          {
            id: "wrapper",
            label: "Installation wrapper",
            path: "/checkout/config/installation-wrapper.sh",
            format: "wrapper",
            exists: wrapper === "protected",
            writable: true,
            protected: true,
            tracked: false,
            revisionId: "wrapper-r1",
            apply: "rac-restart",
            content:
              wrapper === "protected"
                ? `#!/usr/bin/env bash\nRAC_SESSION_SECRET=${protectedSourceMarker}\n`
                : undefined,
            hasProtectedContent: wrapper === "protected",
          },
        ]),
    // expose actual icon capabilities without installation artwork or credentials
    ...(includeIcons
      ? [
          {
            id: "icon-heart",
            label: "Heart icon",
            path: "/checkout/config/instance-icons/heart.svg",
            format: "svg",
            exists: true,
            writable: true,
            protected: false,
            tracked: false,
            revisionId: "heart-r1",
            apply: "live",
            content:
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10"/></svg>\n',
            hasProtectedContent: false,
          },
          {
            id: "icon-potato",
            label: "Potato icon",
            path: "/checkout/config/instance-icons/potato.svg",
            format: "svg",
            exists: false,
            writable: true,
            protected: false,
            tracked: false,
            revisionId: "potato-r1",
            apply: "live",
            value: "",
            hasProtectedContent: false,
          },
        ]
      : []),
  ];
  // serve all application and settings requests from one stateful fixture
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // model a transient read failure after a successful settings commit
    if (path === "/api/auth/session" && state.authUnavailable)
      return route.fulfill({
        status: 503,
        json: { error: "fixture unavailable" },
      });
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "settings-csrf",
          active: true,
          deviceName: "Test browser",
          server: {
            name: "Framework",
            url: "https://framework.santosa.dev",
            remotes: [],
          },
          davo: {
            ...sources[0]!.value!.integrations.realtime,
            available: true,
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
      return route.fulfill({ json: { ticket: "dashboard-ticket" } });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({ json: state.status });
    // retain the existing immediate voice write boundary
    if (path === "/api/server/davo" && request.method() === "PATCH") {
      const davo = request.postDataJSON() as {
        enabled: boolean;
        name: string;
        context: string;
      };
      state.voiceSaves.push(davo);
      return route.fulfill({ json: { davo: { ...davo, available: true } } });
    }
    if (path === "/api/settings" && request.method() === "GET") {
      const plan = settingsReadPlans[state.settingsReads];
      state.settingsReads += 1;
      // hold only the configured catalog request
      if (plan?.wait !== undefined) await plan.wait;
      // return the configured catalog failure
      if (plan?.status !== undefined && plan.status !== 200)
        return route.fulfill({
          status: plan.status,
          json: { error: "fixture settings unavailable" },
        });
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "snapshot-r1",
          installationKind,
          sources,
          status: state.status,
        },
      });
    }
    if (path === "/api/settings/validate" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        changes: Array<{
          sourceId: string;
          migration?: { mode: "copy" | "adopt" | "empty" };
        }>;
      };
      state.validations.push(body);
      // require only the handovers selected by this authoritative fixture
      const migrationIssues = state.migrationRequiredSourceIds.flatMap(
        (sourceId) => {
          const change = body.changes.find(
            (candidate) => candidate.sourceId === sourceId,
          );
          if (change === undefined || change.migration !== undefined) return [];
          const source = sources.find((candidate) => candidate.id === sourceId);
          return [
            {
              sourceId,
              path: [],
              code: "migration_required",
              message: `${source?.label ?? sourceId} needs a source handover.`,
            },
          ];
        },
      );
      return route.fulfill({
        json: {
          valid: state.validationValid && migrationIssues.length === 0,
          issues: migrationIssues,
          warnings: ["Tracked Compose edits can affect updates."],
        },
      });
    }
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.saves.push({ body, csrf: request.headers()["x-csrf-token"] });
      // retain all drafts when the commit rejects its revision
      if (state.saveStatus !== 200)
        return route.fulfill({
          status: state.saveStatus,
          json: { error: "fixture conflict" },
        });
      // project successful structured writes into the authoritative fixture
      for (const change of body.changes) {
        const source = sources.find(
          (candidate) => candidate.id === change.sourceId,
        );
        if (!source) continue;
        // project successful whole-file writes into the next catalog snapshot
        if (typeof change.content === "string") {
          const rawSource = source as { content?: string; exists: boolean };
          rawSource.content = change.content;
          rawSource.exists = true;
        }
        for (const patch of change.patches ?? []) {
          if (patch.op !== "set" || source.value === undefined) continue;
          let target = source.value as Record<string, unknown>;
          for (const key of patch.path.slice(0, -1)) {
            // let synthetic writes create the same missing object containers as the host
            if (
              typeof target[key] !== "object" ||
              target[key] === null ||
              Array.isArray(target[key])
            )
              target[key] = {};
            target = target[key] as Record<string, unknown>;
          }
          target[patch.path.at(-1)] = patch.value;
        }
      }
      // icon and basic voice saves do not require a service restart
      const restart = body.changes.some(
        (change: { sourceId: string; patches?: Array<{ path: string[] }> }) =>
          !change.sourceId.startsWith("icon-") &&
          !(
            change.sourceId === "app" &&
            change.patches?.every((patch) =>
              [
                "integrations.realtime.enabled",
                "integrations.realtime.name",
                "integrations.realtime.context",
              ].includes(patch.path.join(".")),
            )
          ),
      );
      state.status = {
        pending: restart,
        targets: restart ? ["rac"] : [],
        effective: "known",
        restartAvailable: true,
        recoveryCommand:
          "~/.local/bin/rac-settings-recover fixture-installation",
      };
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "snapshot-r2",
          installationKind,
          sources: sources.map((source) => ({
            ...source,
            revisionId: `${source.id}-r2`,
          })),
          status: state.status,
        },
      });
    }
    if (path === "/api/settings/reveal" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        sourceId: string;
        path?: string[];
        revisionId: string;
      };
      state.reveals.push(body);
      const value =
        body.sourceId === "env"
          ? body.path === undefined
            ? "RAC_PORT=8787\nRAC_SESSION_SECRET=fixture-session-secret\n"
            : body.path?.[0] === "RAC_MULTILINE_SECRET"
              ? "line one\n# literal\nline three\n"
              : "fixture-session-secret"
          : body.sourceId === "app"
            ? ["--fixture-flag"]
            : body.sourceId === "wrapper"
              ? "#!/usr/bin/env bash\nRAC_SESSION_SECRET=fixture-session-secret\n"
              : "services:\n  remote-agent-console:\n    environment:\n      RAC_PORT: 8787\n";
      return route.fulfill({
        json: {
          value,
          revisionId: body.revisionId,
          leaseId: `lease-${state.reveals.length}`,
          expiresAt: new Date(Date.now() + state.revealTtlMs).toISOString(),
        },
      });
    }
    if (path === "/api/settings/remask" && request.method() === "POST") {
      state.remasks.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === "/api/settings/restart" && request.method() === "POST") {
      state.restarts += 1;
      state.status = {
        pending: true,
        targets: ["rac"],
        effective: "known",
        restartAvailable: true,
        operation: {
          id: "restart-1",
          state: "queued",
          phase: "Waiting for the host applier",
        },
      };
      return route.fulfill({ json: state.status });
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
  // keep file-editor scenarios focused on their authoritative source
  if (openApplication)
    await selectSettingsSection(settings, "app", "Application config");
  return { state, settings, sources };
}

type MutableInstallationFixtureSource = {
  id: string;
  value?: unknown;
  schema?: unknown;
  content?: string;
  hasProtectedContent?: boolean;
  fields?: Array<Record<string, unknown>>;
  writable?: boolean;
};

// expose every installation branch without changing its persisted source identity
function configureInstallationFixture(
  sources: MutableInstallationFixtureSource[],
) {
  const installation = sources.find((source) => source.id === "installation")!;
  installation.value = {
    version: 1,
    native: { environmentFile: "/checkout/.env" },
    compose: {
      projectDirectory: "/checkout",
      projectName: "rac",
      files: ["/checkout/compose.yaml", "/checkout/compose.override.yaml"],
      envFiles: [],
      profiles: [],
      options: { parallel: 2, compatibility: false },
    },
    sources: {
      wrapper: "/checkout/config/installation-wrapper.sh",
      icons: {
        heart: "/checkout/config/instance-icons/heart.svg",
        potato: "/checkout/config/instance-icons/potato.svg",
      },
    },
  };
  installation.schema = {
    type: "object",
    label: "Installation",
    properties: {
      version: { type: "number", label: "Version" },
      host: {
        type: "object",
        label: "Host",
        optional: true,
        properties: {
          checkout: { type: "string", label: "Checkout" },
        },
      },
      native: {
        type: "object",
        label: "Native",
        properties: {
          environmentFile: { type: "string", label: "Environment file" },
        },
      },
      compose: {
        type: "object",
        label: "Docker",
        properties: {
          projectDirectory: { type: "string", label: "Project directory" },
          projectName: { type: "string", label: "Project name" },
          files: {
            type: "array",
            label: "Compose files",
            items: { type: "string", label: "Compose file" },
          },
          envFiles: {
            type: "array",
            label: "Environment files",
            items: { type: "string", label: "Environment file" },
          },
          profiles: {
            type: "array",
            label: "Profiles",
            items: { type: "string", label: "Profile" },
          },
          options: {
            type: "object",
            label: "Options",
            optional: true,
            properties: {
              parallel: {
                type: "number",
                label: "Parallel",
                optional: true,
                default: -1,
                description:
                  "Maximum parallel Docker operations. Use -1 for unlimited.",
              },
              compatibility: {
                type: "boolean",
                label: "Compatibility",
                optional: true,
                default: false,
                description: "Enable Docker Compose compatibility mode.",
              },
            },
          },
        },
      },
      sources: {
        type: "object",
        label: "Sources",
        properties: {
          wrapper: { type: "string", label: "Wrapper source" },
          icons: {
            type: "object",
            label: "Icons",
            properties: {
              heart: { type: "string", label: "Heart icon" },
              potato: { type: "string", label: "Potato icon" },
            },
          },
        },
      },
    },
  };
  installation.content = `${JSON.stringify(installation.value)}\n`;
  installation.hasProtectedContent = false;
  return installation;
}

// expose duplicate environment values beside their authoritative structured controls
function configureDuplicateEnvironmentFixture(
  sources: MutableInstallationFixtureSource[],
) {
  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as Record<string, unknown>;
  const appSchema = app.schema as {
    type: string;
    properties: Record<string, unknown>;
  };
  app.value = {
    ...appValue,
    listen: { host: "127.0.0.1", port: 8787 },
    adapters: {
      codex: { program: "/usr/bin/codex" },
      claude: { program: "/usr/bin/claude" },
    },
  };
  app.schema = {
    ...appSchema,
    properties: {
      ...appSchema.properties,
      listen: {
        type: "object",
        label: "Listener",
        properties: {
          host: { type: "string", label: "Listen host" },
          port: { type: "number", label: "Listen port" },
        },
      },
      adapters: {
        type: "object",
        label: "Adapters",
        optional: true,
        properties: {
          codex: {
            type: "object",
            label: "Codex",
            optional: true,
            properties: {
              program: { type: "string", label: "Codex program" },
            },
          },
          claude: {
            type: "object",
            label: "Claude",
            optional: true,
            properties: {
              program: { type: "string", label: "Claude program" },
            },
          },
        },
      },
    },
  };
  configureInstallationFixture(sources);
  const env = sources.find((source) => source.id === "env")!;
  const values: Record<string, string> = {
    RAC_LISTEN_HOST: "0.0.0.0",
    RAC_LISTEN_PORT: "9999",
    RAC_CODEX_BIN: "/override/codex",
    RAC_CLAUDE_BIN: "/override/claude",
    COMPOSE_FILE: "/override/compose.yaml",
    COMPOSE_ENV_FILES: "/override/.env",
    COMPOSE_PROJECT_NAME: "override-project",
    COMPOSE_PARALLEL_LIMIT: "4",
    COMPOSE_COMPATIBILITY: "true",
    RAC_ENV_FILE: "/override/native.env",
    RAC_HOST_CODEX_BIN: "/host/codex",
    COMPOSE_PROFILES: "tunnel,custom",
    CLOUDFLARED_CREDENTIALS_FILE: "/run/secrets/cloudflare.json",
    RAC_CONFIG: "/override/config.json",
    RAC_CONFIG_WRITE_PATH: "/override/config-write.json",
    NODE_BIN: "/usr/bin/node",
    CUSTOM_VISIBLE_SETTING: "custom-value",
  };
  const existing = new Map((env.fields ?? []).map((field) => [field.key, field]));
  env.fields = [
    ...existing.values(),
    ...Object.keys(values)
      .filter((key) => !existing.has(key))
      .map((key) => ({
        key,
        protected: false,
        present: true,
        apply: "rac-restart",
        description: `${key} fixture value.`,
      })),
  ].map((field) =>
    typeof field.key === "string" && Object.hasOwn(values, field.key)
      ? { ...field, value: values[field.key], present: true }
      : field,
  );
  env.content = `${env.content ?? ""}${Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")}`;
  return { app, env };
}

// add the same Cloudflare source while varying only its runtime apply authority
function addCloudflareFixtureSource(
  sources: MutableInstallationFixtureSource[],
  apply: "cloudflared-recreate" | "saved-only",
) {
  (sources as Array<Record<string, unknown>>).push(
    {
      id: "cloudflared",
      label: "Cloudflare tunnel",
      path: "/checkout/config/cloudflared.yml",
      format: "cloudflared",
      exists: true,
      writable: true,
      protected: false,
      tracked: false,
      revisionId: "cloudflared-r1",
      apply,
      content: "tunnel: fixture-tunnel\ningress: []\n",
      hasProtectedContent: false,
    },
    {
      id: "cloudflared-credentials",
      label: "Cloudflare credentials",
      path: "/checkout/config/cloudflared.credentials.json",
      format: "credentials",
      exists: true,
      writable: true,
      protected: false,
      tracked: false,
      revisionId: "cloudflared-credentials-r1",
      apply,
      content: '{"TunnelID":"fixture-tunnel"}\n',
      hasProtectedContent: false,
    },
  );
}

test.describe.configure({ timeout: 180_000 });

// retain useful settings chrome without a redundant page introduction
for (const width of [390, 1440]) {
  test(`omits the main Settings introduction without removing controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const consoleErrors: string[] = [];
    // capture browser failures while checking navigation and transaction controls
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const { settings, state } = await setupSettings(page);
    const header = settings.locator(".settings-center-header");
    await expect(settings.getByText("CONSOLE, SERVER AND INSTALLATION", { exact: true })).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "Preferences and configuration", exact: true })).toHaveCount(0);
    await expect(settings.getByText("Save changes applies browser preferences and saves server and file edits.", { exact: true })).toHaveCount(0);
    await expect(header.locator("small, h2, p")).toHaveCount(0);
    await expect(header.getByText("No unsaved changes", { exact: true })).toBeVisible();

    // keep search, per-tab identity and source navigation available
    const search = settings.getByRole("searchbox", { name: "Search settings", exact: true });
    await search.fill("environment");
    await selectSettingsSection(settings, "env", "Environment & keys");
    await expect(settings.getByRole("heading", { name: "Environment & keys", exact: true })).toBeVisible();
    await search.fill("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settings.screenshot({ path: `/tmp/remoteagents-settings-no-main-intro-${width}.png` });

    // preserve the status and save action after a normal field edit
    await settings.getByRole("textbox", { name: "RAC_HOST_PROC", exact: true }).fill("/host/updated-proc");
    await expect(header.getByText("1 file source changed", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => state.saves.length).toBe(1);
    await expect(header.getByText("No unsaved changes", { exact: true })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
}

test("advertises only Docker while Compose sources are still loading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = deferredResponse();
  const { settings, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [{ wait: initial.promise }],
  );
  try {
    await expect.poll(() => state.settingsReads).toBe(1);
    const nav = settings.getByRole("navigation", {
      name: "Settings sources",
    });
    await expect(
      nav.getByRole("button", { name: "Base Compose", exact: true }),
    ).toHaveCount(0);
    const docker = nav.getByRole("button", {
      name: "Docker",
      exact: true,
    });
    await expect(docker).toBeVisible();
    await expect(docker).toBeDisabled();
    await expect(docker).toHaveAttribute("aria-busy", "true");
  } finally {
    initial.resolve();
  }
});

test("previews the redacted base Compose beside an unsaved Docker draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const previewRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    if (/\/(?:file-)?preview(?:\?|$)/u.test(request.url()))
      previewRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state, sources } = await setupSettings(page, false);
  await selectSettingsSection(settings, "compose-override", "Docker");
  const header = settings.locator(".settings-source-header");
  const preview = header.getByRole("button", {
    name: "View base compose.yaml",
    exact: true,
  });
  const base = sources.find((source) => source.id === "compose")!;
  const baseContent = base.content;

  // missing base bytes keep the action visible but unavailable
  base.content = undefined;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(preview).toBeDisabled();
  base.content = baseContent;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(preview).toBeEnabled();

  // the title action stays separate from the editable override
  const heading = header.getByRole("heading", { name: "Docker", exact: true });
  const docker = settings.getByLabel("Docker source content");
  const draft =
    "services:\n  remote-agent-console:\n    environment:\n      LOCAL_ONLY: unsaved-docker-draft\n";
  await docker.fill(draft);
  await expect(
    settings.getByText(/Save changes stores this override\./u),
  ).toHaveCount(0);
  await expect(
    settings.getByText("Source content", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Remove source", exact: true }),
  ).toHaveCount(0);
  await expect(docker).toHaveAccessibleName("Docker source content");
  await expect(
    settings.getByText(/Restart .* applies it together with the base Compose file\./u),
  ).toHaveCount(0);
  await expect(
    settings.getByText(
      /If this moves configuration or credential files, Save changes will ask how to prepare them\./u,
    ),
  ).toHaveCount(0);

  // preserve one outlined blue line at every supported title width
  for (const [width, screenshot] of [
    [1440, "/tmp/remoteagents-settings-docker-desktop.png"],
    [760, "/tmp/remoteagents-settings-docker-narrow.png"],
    [375, "/tmp/remoteagents-settings-docker-mobile.png"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(preview).toBeVisible();
    await settings
      .locator(".settings-source-panel")
      .evaluate((element) => element.scrollTo({ top: 0 }));
    const [headingBox, headerBox, previewBox, appearance, overflow] =
      await Promise.all([
        heading.boundingBox(),
        header.boundingBox(),
        preview.boundingBox(),
        preview.evaluate((button) => {
          const style = getComputedStyle(button);
          const blue = document.createElement("span");
          blue.style.color = "var(--blue)";
          document.body.append(blue);
          const blueColor = getComputedStyle(blue).color;
          blue.remove();
          const range = document.createRange();
          range.selectNodeContents(button);
          const textLines = [...range.getClientRects()].filter(
            (rect) => rect.width > 0 && rect.height > 0,
          ).length;
          return {
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            borderColor: style.borderTopColor,
            borderStyle: style.borderTopStyle,
            borderWidth: style.borderTopWidth,
            blueColor,
            boxShadow: style.boxShadow,
            color: style.color,
            textLines,
            whiteSpace: style.whiteSpace,
          };
        }),
        settings.evaluate((element) => ({
          clientWidth: element.clientWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          scrollWidth: element.scrollWidth,
        })),
      ]);
    expect(headingBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width);
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(
      headerBox!.x + headerBox!.width + 1,
    );
    expect(appearance).toMatchObject({
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
      borderColor: appearance.blueColor,
      borderStyle: "solid",
      boxShadow: "none",
      color: appearance.blueColor,
      textLines: 1,
      whiteSpace: "nowrap",
    });
    expect(Number.parseFloat(appearance.borderWidth)).toBeGreaterThan(0);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(
      overflow.documentClientWidth + 1,
    );
    await settings.screenshot({ path: screenshot });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await preview.click();
  const code = page.getByRole("region", { name: "Code changes" });
  await expect(code).toBeVisible();
  await expect(
    code.getByRole("button", { name: "‹ Settings", exact: true }),
  ).toBeVisible();
  await expect(code.locator(".code-pane-crumb-current")).toHaveText(
    "compose.yaml",
  );
  await expect(code.getByText("ghcr.io/example/rac:base")).toBeVisible();
  await expect(code.getByText(/RAC_SESSION_SECRET:\s+\*{8}/u)).toBeVisible();
  await expect(
    code.getByRole("button", { name: /Open .* in the editor/u }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(protectedSourceMarker);
  await expect(settings).toBeVisible();
  await expect(docker).toHaveValue(draft);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-base-compose-preview.png",
  });
  expect(previewRequests).toEqual([]);
  expect(state.saves).toEqual([]);
  expect(state.validations).toEqual([]);
  expect(state.reveals).toEqual([]);
  expect(state.restarts).toBe(0);
  expect(consoleErrors).toEqual([]);

  await code.getByRole("button", { name: "‹ Settings", exact: true }).click();
  await expect(code).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(docker).toHaveValue(draft);

  // generic raw sources retain their ordinary title and removal action
  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await expect(
    settings.getByText("Source content", { exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Remove source", exact: true }),
  ).toBeVisible();
  await selectSettingsSection(settings, "compose-override", "Docker");
  await expect(docker).toHaveValue(draft);

  // closing dirty Settings also retires its transient fallback Code preview
  await preview.click();
  await expect(code).toBeVisible();
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await confirmSettingsClose(page);
  await expect(settings).toHaveCount(0);
  await expect(code).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "‹ Settings", exact: true }),
  ).toHaveCount(0);
});

// prove Docker saves only create a durable restart decision
test("saves Docker changes as restart pending without executing code", async ({
  page,
}) => {
  const sideEffects: string[] = [];
  // record only explicit execution boundaries
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // ignore ordinary validation and persistence traffic
    if (path === "/api/settings/restart" || path.endsWith("/execute"))
      sideEffects.push(path);
  });
  const { settings, state } = await setupSettings(page, false);
  const notice = page.getByRole("status", {
    name: "Restart pending",
    exact: true,
  });
  await expect(notice).toHaveCount(0);
  await selectSettingsSection(settings, "compose-override", "Docker");
  await expect(
    settings.getByText("Trusted code", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByText("Tracked file", { exact: true }),
  ).toBeVisible();
  const content =
    "services:\n  remote-agent-console:\n    environment:\n      RAC_PORT: 8788\n";
  await settings.getByLabel("Docker source content").fill(content);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({
    body: {
      changes: [
        {
          sourceId: "compose-override",
          revisionId: "compose-override-r1",
          content,
        },
      ],
    },
  });
  await expect(notice).toBeVisible();
  const restart = notice.getByRole("button", {
    name: "Restart",
    exact: true,
  });
  await expect(restart).toBeEnabled();
  expect(state.restarts).toBe(0);
  expect(sideEffects).toEqual([]);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-docker-restart-pending.png",
  });

  // execution remains a separate explicit product action
  await restart.click();
  await expect.poll(() => state.restarts).toBe(1);
  expect(sideEffects).toEqual(["/api/settings/restart"]);
});

// prove rejected Docker bytes never manufacture pending state
test("keeps Docker restart clean when persistence fails", async ({ page }) => {
  const sideEffects: string[] = [];
  // record only explicit execution boundaries
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // ignore ordinary validation and persistence traffic
    if (path === "/api/settings/restart" || path.endsWith("/execute"))
      sideEffects.push(path);
  });
  const { settings, state } = await setupSettings(page, false);
  state.saveStatus = 409;
  await selectSettingsSection(settings, "compose-override", "Docker");
  await settings
    .getByLabel("Docker source content")
    .fill(
      "services:\n  remote-agent-console:\n    environment:\n      RAC_PORT: 8789\n",
    );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toHaveCount(0);
  expect(state.status.pending).toBe(false);
  expect(state.restarts).toBe(0);
  expect(sideEffects).toEqual([]);
});

// keep the virtual TMUX page free of path selectors and destructive field controls
test("keeps TMUX controls removal-free and uses only the installed wrapper source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  const tmuxNav = nav.getByRole("button", { name: "TMUX", exact: true });
  await expect.soft(tmuxNav.locator("svg path")).toHaveAttribute(
    "d",
    "M3 4h18v16H3zm9 0v16M3 12h9",
  );
  await tmuxNav.click();
  const tmux = settings.locator(".settings-tmux");

  await expect.soft(tmux.locator(".settings-remove-button")).toHaveCount(0);
  await expect.soft(tmux.locator('[data-settings-path="sources.wrapper"]')).toHaveCount(0);
  await expect.soft(tmux.getByLabel("Wrapper path", { exact: true })).toHaveCount(0);
  await expect.soft(tmux.locator(".settings-tmux-path")).toHaveCount(0);
  await expect.soft(
    tmux.getByText("/checkout/config/installation-wrapper.sh", { exact: true }),
  ).toHaveCount(0);
  await expect(tmux.getByLabel("Installation wrapper source content")).toHaveValue("");
  await expect(tmux.getByLabel("Installation wrapper source content")).toBeEditable();
});

// prove an absent wrapper is an ordinary clean blank editor
test("creates a missing Installation wrapper directly from its blank editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const sideEffects: string[] = [];
  const consoleErrors: string[] = [];
  // retain browser failures and explicit execution boundaries
  page.on("console", (message) => {
    // keep only actionable browser errors
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // ignore ordinary validation and persistence traffic
    if (path === "/api/settings/restart" || path.endsWith("/execute"))
      sideEffects.push(path);
  });
  const { settings, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  await selectSettingsSection(settings, "tmux", "TMUX");
  const input = settings.getByLabel("Installation wrapper source content");
  const save = settings.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await expect(input).toBeEditable();
  await expect(input).toHaveValue("");
  await expect(save).toHaveCount(0);
  await expect(settings.getByText("Trusted code", { exact: true })).toHaveCount(
    0,
  );
  await expect(settings.getByText("Source content", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings.getByText("Source does not exist", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Create source", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Remove source", exact: true }),
  ).toHaveCount(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-wrapper-narrow.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  const overflow = await settings.evaluate((element) => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    settings: element.scrollWidth - element.clientWidth,
  }));
  expect(overflow).toEqual({ page: 0, settings: 0 });
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-wrapper-phone.png",
  });

  // returning an authored value to blank restores the pristine state
  await input.fill("# temporary wrapper draft\n");
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await input.fill("");
  await expect(save).toHaveCount(0);

  // one nonempty wrapper payload persists without running it
  const content =
    "#!/usr/bin/env bash\nexec node /workspace/apps/server/dist/index.js\n";
  await input.fill(content);
  await expect(save).toBeVisible();
  await save.click();
  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({
    body: {
      changes: [
        {
          sourceId: "wrapper",
          revisionId: "wrapper-r1",
          content,
        },
      ],
    },
  });
  const notice = page.getByRole("status", {
    name: "Restart pending",
    exact: true,
  });
  await expect(notice).toBeVisible();
  await expect(
    notice.getByRole("button", { name: "Restart", exact: true }),
  ).toBeEnabled();
  expect(state.restarts).toBe(0);
  expect(sideEffects).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// prove a rejected wrapper creation keeps the authored bytes local
test("retains a missing Installation wrapper draft after save failure", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  state.saveStatus = 409;
  await selectSettingsSection(settings, "tmux", "TMUX");
  const input = settings.getByLabel("Installation wrapper source content");
  const content = "#!/usr/bin/env bash\necho keep-this-draft\n";
  await input.fill(content);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  await expect.poll(() => state.saves.length).toBe(1);
  await expect(input).toHaveValue(content);
  await expect(input).toBeEditable();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toHaveCount(0);
  expect(state.status.pending).toBe(false);
  expect(state.restarts).toBe(0);
});

// keep one virtual TMUX page over the original persisted source identities
test("moves structured TMUX settings into one Application tab and saves original sources", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sideEffects: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // observe only explicit runtime execution boundaries
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // ignore ordinary Settings validation and persistence
    if (path === "/api/settings/restart" || path.endsWith("/execute"))
      sideEffects.push(path);
  });
  const { settings, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  const labels = await nav.getByRole("button").allTextContents();
  expect(labels.indexOf("Projects")).toBe(
    labels.indexOf("Application config") + 1,
  );
  expect(labels.indexOf("TMUX")).toBe(labels.indexOf("Projects") + 1);
  await expect(
    nav.getByRole("button", { name: "Installation wrapper", exact: true }),
  ).toHaveCount(0);

  // moved structured controls disappear without removing whole-source repair
  await selectSettingsSection(settings, "app", "Application config");
  await expect(
    settings.locator('[data-settings-path="tmux.pollIntervalMs"]'),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await expect(settings.getByLabel("Application config source content")).toHaveValue(
    /"tmux":\{"pollIntervalMs":500\}/u,
  );
  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of [
    "RAC_TMUX_BIN",
    "RAC_HOST_TMUX_DIR",
    "RAC_HOST_TMUX_SOURCE",
    "RAC_HOST_UNIX_SOCKETS",
    "HOST_TMUX_DIR",
    "HOST_TMUX_BIN",
  ])
    await expect(settings.getByLabel(key, { exact: true })).toHaveCount(0);
  for (const key of [
    "RAC_HOST_PROC",
    "RAC_HOST_UID",
    "HOST_UID",
    "RAC_HOST_INTERACTIVE_SHELL",
    "RAC_HOST_PATH",
  ])
    await expect(settings.getByLabel(key, { exact: true })).toBeVisible();
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const rawEnvironment = settings.getByLabel(
    "Environment & keys source content",
  );
  await expect(rawEnvironment).toHaveValue(/RAC_TMUX_BIN=\/usr\/bin\/tmux/u);
  await expect(rawEnvironment).toHaveValue(/HOST_TMUX_DIR=/u);
  await selectSettingsSection(settings, "installation", "Installation");
  await expect(
    settings.locator('[data-settings-path="sources.wrapper"]'),
  ).toHaveCount(0);

  // the virtual page stages each owner without inventing a TMUX API source
  await selectSettingsSection(settings, "tmux", "TMUX");
  const poll = settings
    .locator('[data-settings-path="tmux.pollIntervalMs"]')
    .getByRole("spinbutton");
  const tmuxBinary = settings.getByLabel("RAC_TMUX_BIN", { exact: true });
  const wrapper = settings.getByLabel("Installation wrapper source content");
  await expect(poll).toHaveValue("500");
  await expect(tmuxBinary).toHaveValue("/usr/bin/tmux");
  await expect(wrapper).toBeEditable();
  await expect(wrapper).toHaveValue("");
  for (const key of [
    "RAC_HOST_PROC",
    "RAC_HOST_UID",
    "HOST_UID",
    "RAC_HOST_INTERACTIVE_SHELL",
    "RAC_HOST_PATH",
  ])
    await expect(settings.getByLabel(key, { exact: true })).toHaveCount(0);
  await poll.fill("650");
  await tmuxBinary.fill("/opt/tmux/bin/tmux");
  const wrapperContent = "#!/usr/bin/env bash\nexec /opt/tmux/bin/tmux \"$@\"\n";
  await wrapper.fill(wrapperContent);
  await expect(
    nav.getByRole("button", { name: /^TMUX.*Unsaved changes$/u }),
  ).toBeVisible();
  await settings
    .locator(".settings-source-panel")
    .evaluate((panel) => panel.scrollTo({ top: 0 }));
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-tmux-desktop.png",
  });

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Choose source handover" }),
  ).toHaveCount(0);
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        revisionId: string;
        patches?: unknown[];
        content?: string;
        migration?: { mode: string };
      }>;
    };
  };
  expect(save.body.changes).toEqual(
    expect.arrayContaining([
      {
        sourceId: "app",
        revisionId: "app-r1",
        patches: [
          { op: "set", path: ["tmux", "pollIntervalMs"], value: 650 },
        ],
      },
      {
        sourceId: "env",
        revisionId: "env-r1",
        patches: [
          { op: "set", path: ["RAC_TMUX_BIN"], value: "/opt/tmux/bin/tmux" },
        ],
      },
      {
        sourceId: "wrapper",
        revisionId: "wrapper-r1",
        content: wrapperContent,
      },
    ]),
  );
  expect(save.body.changes).toHaveLength(3);
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toBeVisible();
  expect(state.restarts).toBe(0);
  expect(sideEffects).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// describe safe environment fallbacks without materializing file assignments
test("shows Environment and TMUX fallback values without staging defaults", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser runtime errors as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "env", "Environment & keys");
  const listenHost = settings.locator(
    '[data-settings-path="RAC_LISTEN_HOST"]',
  );
  await expect(listenHost.getByLabel("RAC_LISTEN_HOST", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    listenHost.getByLabel("RAC_LISTEN_HOST", { exact: true }),
  ).toHaveAttribute("placeholder", "127.0.0.1");
  const statusSecret = settings.locator(
    '[data-settings-path="RAC_INSTANCE_STATUS_SECRET"]',
  );
  await expect(
    statusSecret.getByLabel("RAC_INSTANCE_STATUS_SECRET", { exact: true }),
  ).toHaveAttribute("placeholder", "Uses RAC_SESSION_SECRET");
  await expect(statusSecret).not.toContainText("fixture-session-secret");
  await expect(
    settings.getByText(/Default when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await expect(
    settings
      .locator('[data-settings-path="EDITOR_COMMAND"]')
      .getByText(/when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-defaults-desktop.png",
  });

  await selectSettingsSection(settings, "tmux", "TMUX");
  const tmuxBinary = settings.locator('[data-settings-path="RAC_TMUX_BIN"]');
  await expect(tmuxBinary.getByLabel("RAC_TMUX_BIN", { exact: true })).toHaveValue(
    "/usr/bin/tmux",
  );
  await expect(
    tmuxBinary.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toHaveAttribute("placeholder", "/usr/local/bin/tmux");
  await expect(
    settings.getByText(/Default when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-tmux-defaults-desktop.png",
  });

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-tmux-defaults-mobile.png",
  });
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await listenHost.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-defaults-mobile.png",
  });
  expect(consoleErrors).toEqual([]);
});

// removing an explicit assignment must leave its fallback as display-only guidance
test("keeps a fallback visible after clearing an explicit TMUX value", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "tmux", "TMUX");
  const tmuxBinary = settings.locator('[data-settings-path="RAC_TMUX_BIN"]');
  const input = tmuxBinary.getByLabel("RAC_TMUX_BIN", { exact: true });
  await input.fill("");
  await expect(input).toHaveValue("");
  await expect(
    input,
  ).toHaveAttribute("placeholder", "/usr/local/bin/tmux");
  await expect(
    settings.getByText(/Default when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const changes = (state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        revisionId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  }).body.changes;
  expect(changes).toEqual([
    {
      sourceId: "env",
      revisionId: "env-r1",
      patches: [{ op: "remove", path: ["RAC_TMUX_BIN"] }],
    },
  ]);
});

// keep duplicate assignments in raw source while structured owners provide their controls
test("hides Environment rows represented by active structured settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser runtime errors as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources, state } = await setupSettings(page);
  configureDuplicateEnvironmentFixture(sources);
  await settings.getByRole("button", { name: "Refresh files" }).click();

  await selectSettingsSection(settings, "app", "Application config");
  for (const path of [
    "listen.host",
    "listen.port",
    "adapters.codex.program",
    "adapters.claude.program",
  ])
    await expect(settings.locator(`[data-settings-path="${path}"]`)).toBeVisible();
  await selectSettingsSection(settings, "installation", "Installation");
  for (const path of [
    "compose.files",
    "compose.envFiles",
    "compose.projectName",
    "compose.options.parallel",
    "compose.options.compatibility",
  ])
    await expect(settings.locator(`[data-settings-path="${path}"]`)).toBeVisible();

  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of [
    "RAC_LISTEN_HOST",
    "RAC_LISTEN_PORT",
    "RAC_CODEX_BIN",
    "RAC_CLAUDE_BIN",
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(0);
  for (const key of [
    "RAC_ENV_FILE",
    "RAC_HOST_CODEX_BIN",
    "COMPOSE_PROFILES",
    "CLOUDFLARED_CREDENTIALS_FILE",
    "RAC_CONFIG",
    "RAC_CONFIG_WRITE_PATH",
    "NODE_BIN",
    "CUSTOM_VISIBLE_SETTING",
    "RAC_SESSION_SECRET",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toBeVisible();
  await settings
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await settings.getByLabel("Variable", { exact: true }).fill("RAC_LISTEN_HOST");
  await settings.getByLabel("Value", { exact: true }).fill("duplicate");
  await expect(
    settings.getByRole("button", { name: "Add variable", exact: true }),
  ).toBeDisabled();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-deduplicated-desktop.png",
  });
  await settings
    .locator(".settings-source-panel")
    .evaluate((panel) => panel.scrollTo({ top: 0 }));
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-deduplicated-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = settings.getByLabel("Environment & keys source content", {
    exact: true,
  });
  await expect(raw).toHaveValue(/RAC_LISTEN_HOST=0\.0\.0\.0/u);
  await expect(raw).toHaveValue(/COMPOSE_PARALLEL_LIMIT=4/u);
  expect(state.saves).toEqual([]);
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  await settings.getByLabel("EDITOR_COMMAND", { exact: true }).fill("nano --wait");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          revisionId: string;
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
    }).body.changes,
  ).toEqual([
    {
      sourceId: "env",
      revisionId: "env-r1",
      patches: [
        { op: "set", path: ["EDITOR_COMMAND"], value: "nano --wait" },
      ],
    },
  ]);
  expect(consoleErrors).toEqual([]);
});

// retain rows whose structured owner is missing, inactive, or in whole-source mode
test("keeps Environment rows when their structured alternative is unavailable", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app } = configureDuplicateEnvironmentFixture(sources);
  const appValue = app.value as {
    adapters: { codex?: unknown; claude?: unknown };
  };
  delete appValue.adapters.codex;
  const appSchema = app.schema as {
    properties: {
      listen?: unknown;
    };
  };
  delete appSchema.properties.listen;
  const installation = sources.find((source) => source.id === "installation")!;
  const installationSchema = installation.schema as {
    properties: {
      compose: {
        properties: {
          projectName?: unknown;
        };
      };
    };
  };
  delete installationSchema.properties.compose.properties.projectName;
  await settings.getByRole("button", { name: "Refresh files" }).click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of [
    "RAC_LISTEN_HOST",
    "RAC_LISTEN_PORT",
    "RAC_CODEX_BIN",
    "COMPOSE_PROJECT_NAME",
    "RAC_ENV_FILE",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toBeVisible();
  for (const key of [
    "RAC_CLAUDE_BIN",
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(0);

  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.locator('[data-settings-path="RAC_CLAUDE_BIN"]'),
  ).toBeVisible();
  expect(state.saves).toEqual([]);
});

// readonly peers cannot replace an editable environment assignment
test("keeps Environment rows when their structured owners are read-only", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app } = configureDuplicateEnvironmentFixture(sources);
  app.writable = false;
  const installation = sources.find((source) => source.id === "installation")!;
  installation.writable = false;
  await settings.getByRole("button", { name: "Refresh files" }).click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of [
    "RAC_LISTEN_HOST",
    "RAC_LISTEN_PORT",
    "RAC_CODEX_BIN",
    "RAC_CLAUDE_BIN",
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toBeVisible();
  expect(state.saves).toEqual([]);
});

// switch only the duplicate rows backed by the installed native branch
test("uses the active installation mode when hiding Environment rows", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "systemd",
  );
  configureDuplicateEnvironmentFixture(sources);
  await settings.getByRole("button", { name: "Refresh files" }).click();
  await selectSettingsSection(settings, "installation", "Installation");
  await expect(
    settings.locator('[data-settings-path="native.environmentFile"]'),
  ).toBeVisible();
  await expect(settings.locator('[data-settings-path="compose.files"]')).toHaveCount(
    0,
  );
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(settings.locator('[data-settings-path="RAC_ENV_FILE"]')).toHaveCount(0);
  for (const key of [
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toBeVisible();
  expect(state.saves).toEqual([]);
});

// keep project configuration in its own virtual Application section
test("moves Projects into its own Application section on desktop and mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupSettings(page);
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  const labels = await nav.getByRole("button").allTextContents();
  expect(labels.indexOf("Projects")).toBe(
    labels.indexOf("Application config") + 1,
  );
  expect(labels.indexOf("TMUX")).toBe(labels.indexOf("Projects") + 1);

  await selectSettingsSection(settings, "app", "Application config");
  await expect(settings.locator('[data-settings-path="projects"]')).toHaveCount(
    0,
  );
  await selectSettingsSection(settings, "projects", "Projects");
  await expect(settings.locator('[data-settings-path="projects"]')).toBeVisible();
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect.poll(() => state.settingsReads).toBe(2);
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Projects", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await settings
    .getByRole("group", { name: /^Project \d+$/u })
    .first()
    .getByRole("button", { name: /^Edit Project \d+$/u })
    .click();
  await settings
    .locator('[data-settings-path="projects.0.label"] input')
    .fill("Atlas draft");
  await expect(
    nav.getByRole("button", { name: /^Projects.*Unsaved changes$/u }),
  ).toBeVisible();
  await selectSettingsSection(settings, "app", "Application config");
  await selectSettingsSection(settings, "projects", "Projects");
  await settings
    .getByRole("group", { name: /^Project \d+$/u })
    .first()
    .getByRole("button", { name: /^Edit Project \d+$/u })
    .click();
  await expect(
    settings.locator('[data-settings-path="projects.0.label"] input'),
  ).toHaveValue("Atlas draft");
  expect(state.saves).toEqual([]);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-projects-desktop.png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await expect(selector).toHaveAttribute("data-value", "projects");
  await selector.click();
  await expect(
    page
      .getByRole("listbox", { name: "Settings section options", exact: true })
      .locator('[role="option"][data-value="projects"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-projects-mobile.png",
  });
});

// fail closed when the Application catalog cannot describe project entries
test("keeps malformed Projects metadata unavailable without drafting files", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const application = sources.find((source) => source.id === "app") as {
    schema: { properties: Record<string, unknown> };
  };
  delete application.schema.properties.projects;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "projects", "Projects");
  await expect(
    settings.getByRole("note").filter({
      hasText: "Project settings are unavailable in this configuration.",
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "+ Add Project", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// persist every project collection operation through the original application source
test("saves Project edits, additions, moves, and confirmed removal through app", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "projects", "Projects");
  await settings
    .getByRole("group", { name: /^Project \d+$/u })
    .first()
    .getByRole("button", { name: /^Edit Project \d+$/u })
    .click();
  await settings
    .locator('[data-settings-path="projects.0.label"] input')
    .fill("Atlas edited");
  await settings
    .getByRole("button", { name: "+ Add Project", exact: true })
    .click();
  await settings
    .locator('[data-settings-path="projects.2.label"] input')
    .fill("Canary");
  await settings
    .locator('[data-settings-path="projects.2.path"] input')
    .fill("/code/canary");
  await settings
    .getByRole("button", { name: "Move Projects 3 up", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Remove Projects 1", exact: true })
    .click();
  await settings
    .getByRole("alertdialog", { name: /^Remove Project \d+$/u })
    .getByRole("button", { name: "Confirm remove", exact: true })
    .click();
  expect(state.saves).toEqual([]);

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const changes = (state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{
          op: string;
          path: string[];
          index?: number;
          from?: number;
          to?: number;
        }>;
      }>;
    };
  }).body.changes;
  expect(changes.map((change) => change.sourceId)).toEqual(["app"]);
  expect(changes[0]?.patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: "set", path: ["projects", "0", "label"] }),
      expect.objectContaining({ op: "insert", path: ["projects"], index: 2 }),
      { op: "move", path: ["projects"], from: 2, to: 1 },
      { op: "remove", path: ["projects", "0"] },
    ]),
  );
  expect(state.restarts).toBe(0);
});

// remove redundant project row copy without weakening accessible indexed actions
test("shows Project rows without a visible eyebrow or Path prefix", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  const copy = project.locator(
    ":scope > .settings-array-entry-header > .settings-collection-entry-copy",
  );
  await expect(copy.locator(":scope > strong")).toHaveCount(0);
  await expect(copy.locator(":scope > small")).toHaveText("/code/atlas");
  await expect(copy).not.toContainText("Path:");
  await expect(
    project.getByRole("button", { name: "Edit Project 1", exact: true }),
  ).toBeVisible();
});

// reserve internal project ids only when validation rejects an attempted save
test("shows reserved Project ID errors only after save validation", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const reservedMessage =
    "Project IDs “agent” and “scratch” are reserved. Choose another ID.";
  await page.route("**/api/settings/validate", async (route) => {
    // mirror the server's field-scoped reserved-id validation response
    const body = route.request().postDataJSON() as {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
    state.validations.push(body);
    const id = body.changes
      .find((change) => change.sourceId === "app")
      ?.patches?.find(
        (patch) =>
          patch.op === "set" &&
          patch.path.join(".") === "projects.0.id",
      )?.value;
    const reserved = id === "agent" || id === "scratch";
    await route.fulfill({
      json: {
        valid: !reserved,
        issues: reserved
          ? [
              {
                sourceId: "app",
                path: ["projects", "0", "id"],
                code: "custom",
                message: reservedMessage,
              },
            ]
          : [],
        warnings: [],
      },
    });
  });
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  const idField = project.locator('[data-settings-path="projects.0.id"]');
  const id = idField.getByLabel("Id", { exact: true });
  await expect(idField).not.toContainText(/reserved/iu);
  await id.fill("agent");
  await expect(settings.getByText(reservedMessage, { exact: true })).toHaveCount(
    0,
  );

  const save = settings.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await save.click();
  await expect(idField.getByRole("alert")).toHaveText(reservedMessage);
  expect(state.saves).toHaveLength(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-project-reserved-id-error.png",
  });

  await id.fill("scratch");
  await save.click();
  await expect(idField.getByRole("alert")).toHaveText(reservedMessage);
  expect(state.saves).toHaveLength(0);

  await id.fill("atlas-valid");
  await save.click();
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(settings.getByText(reservedMessage, { exact: true })).toHaveCount(
    0,
  );
  expect(state.validations).toHaveLength(3);
  expect(consoleErrors).toEqual([]);
});

// omit unused application settings while retaining their saved bytes
test("hides unused application fields and marks unsupported adapters unimplemented", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources, state } = await setupSettings(page);
  const app = sources.find((source) => source.id === "app")!;
  app.value = {
    ...app.value,
    proxy: { trustedSourceIps: ["127.0.0.1", "::1"] },
    adapters: {
      codex: { program: "/usr/bin/codex" },
      pi: { program: "/usr/bin/pi" },
    },
  };
  app.schema!.properties!.proxy = {
    type: "object",
    label: "Proxy",
    properties: {
      trustedSourceIps: {
        type: "array",
        label: "Trusted source IPs",
        items: { type: "string", label: "IP address" },
      },
    },
  };
  app.schema!.properties!.adapters = {
    type: "object",
    label: "Agent adapters",
    properties: {
      codex: {
        type: "object",
        optional: true,
        label: "Codex",
        properties: { program: { type: "string", label: "Program" } },
      },
      pi: {
        type: "object",
        optional: true,
        label: "Pi",
        properties: { program: { type: "string", label: "Program" } },
      },
      opencode: {
        type: "object",
        optional: true,
        label: "OpenCode",
        properties: { program: { type: "string", label: "Program" } },
      },
    },
  };
  app.content = `${JSON.stringify(app.value)}\n`;
  const env = sources.find((source) => source.id === "env")!;
  env.fields!.push({
    key: "RAC_LOG_LEVEL",
    value: "debug",
    protected: false,
    present: true,
    apply: "rac-restart",
  });
  env.content = `${env.content ?? ""}RAC_LOG_LEVEL=debug\n`;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();

  const panel = settings.locator(".settings-source-panel");
  await expect(panel.locator('[data-settings-path="proxy"]')).toHaveCount(0);
  for (const [path, label] of [
    ["adapters.pi", "Pi"],
    ["adapters.opencode", "OpenCode"],
  ] as const) {
    const adapter = panel.locator(
      `[data-settings-path=${JSON.stringify(path)}]`,
    );
    await expect(adapter).toBeVisible();
    await expect(adapter).toHaveAttribute("aria-disabled", "true");
    await expect(adapter.getByText(label, { exact: true })).toBeVisible();
    await expect(adapter.getByText("Unimplemented", { exact: true })).toBeVisible();
    for (const control of await adapter.locator("input, textarea, button").all())
      await expect(control).toBeDisabled();
  }
  await panel.locator('[data-settings-path="adapters.pi"]').scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unimplemented-adapters-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await panel.locator('[data-settings-path="adapters.pi"]').scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unimplemented-adapters-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await panel.getByLabel("Shell command", { exact: true }).fill("/usr/bin/agent");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const appChange = (state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ path: string[]; value?: unknown }>;
      }>;
    };
  }).body.changes.find((change) => change.sourceId === "app");
  expect(appChange?.patches).toEqual([
    { op: "set", path: ["adapter", "command"], value: "/usr/bin/agent" },
  ]);
  expect(appChange?.patches?.some((patch) => patch.path[0] === "proxy")).toBe(
    false,
  );
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await expect(
    panel.getByLabel("Application config source content", { exact: true }),
  ).toHaveValue(/"proxy":\{"trustedSourceIps":\["127\.0\.0\.1","::1"\]\}/u);
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();

  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    panel.locator('[data-settings-path="RAC_LOG_LEVEL"]'),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await panel.getByLabel("Variable", { exact: true }).fill("RAC_LOG_LEVEL");
  await panel.getByLabel("Value", { exact: true }).fill("trace");
  await expect(
    panel.getByRole("button", { name: "Add variable", exact: true }),
  ).toBeDisabled();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unused-fields-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unused-fields-mobile.png",
  });
  expect(consoleErrors).toEqual([]);
});

// show sparse project settings directly without authoring their blank defaults
test("shows every Project field and omits untouched optional blanks on save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();

  const label = project
    .locator('[data-settings-path="projects.0.label"]')
    .getByLabel("Label", { exact: true });
  const hostPath = project
    .locator('[data-settings-path="projects.0.hostPath"]')
    .getByLabel("Host Path", { exact: true });
  await expect(label).toHaveValue("Atlas");
  await expect(
    project
      .locator('[data-settings-path="projects.0.id"]')
      .getByLabel("Id", { exact: true }),
  ).toHaveValue("atlas");
  await expect(
    project
      .locator('[data-settings-path="projects.0.path"]')
      .getByLabel("Path", { exact: true }),
  ).toHaveValue("/code/atlas");
  await expect(hostPath).toHaveValue("");
  await expect(
    project
      .locator('[data-settings-path="projects.0.port"]')
      .getByLabel("Port", { exact: true }),
  ).toHaveValue("4173");
  await expect(
    project
      .locator('[data-settings-path="projects.0.hostname"]')
      .getByLabel("Hostname", { exact: true }),
  ).toHaveValue("");
  const projectProperties = authoritativeProjectsSchema.items!.properties!;
  for (const key of Object.keys(projectProperties))
    await expect(
      project.locator(`[data-settings-path="projects.0.${key}"]`),
    ).toBeVisible();
  for (const description of Object.values(projectProperties)
    .map((schema) => schema.description)
    .filter((value): value is string => value !== undefined))
    await expect(project.getByText(description, { exact: true })).toBeVisible();
  for (const description of Object.values(
    projectProperties.commands!.properties!,
  )
    .map((schema) => schema.description)
    .filter((value): value is string => value !== undefined))
    await expect(project.getByText(description, { exact: true })).toBeVisible();
  await expect(project.locator(".settings-optional-field")).toHaveCount(0);
  const worktreeOrder = project.locator(
    '[data-settings-path="projects.0.worktreeOrder"]',
  );
  await expect(worktreeOrder.locator(".settings-collection-add-button")).toBeVisible();
  await expect(
    project
      .locator('[data-settings-path="projects.0.worktreeOverrides"]')
      .locator(".settings-collection-add-button"),
  ).toBeVisible();
  const processes = project.locator(
    '[data-settings-path="projects.0.commands.processes"]',
  );
  await expect(processes.getByRole("textbox", { name: "New key" })).toBeVisible();
  await expect(processes.getByRole("button", { name: "Add entry" })).toBeDisabled();
  await expect(
    project.getByRole("button", { name: "Remove Projects 1", exact: true }),
  ).toBeVisible();
  await expect(
    processes.getByRole("button", { name: "Remove web", exact: true }),
  ).toBeVisible();
  await expect(
    project.locator(
      ".settings-field-actions > .settings-remove-button, .settings-schema-section > header .settings-remove-button",
    ),
  ).toHaveCount(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-project-fields-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await project.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-project-fields-mobile.png",
  });

  await label.fill("***");
  await expect(label).toHaveValue("***");
  await hostPath.fill("temporary");
  await hostPath.fill("");
  await label.fill("Atlas renamed");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = (state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  }).body.changes.find((change) => change.sourceId === "app")?.patches;
  expect(patches).toEqual([
    {
      op: "set",
      path: ["projects", "0", "label"],
      value: "Atlas renamed",
    },
  ]);
});

// retain required collection entries until their structural action is reversed
test("keeps required Project collection items explicit and omits an emptied Processes map", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  const worktreeOrder = project.locator(
    '[data-settings-path="projects.0.worktreeOrder"]',
  );
  await worktreeOrder.locator(".settings-collection-add-button").click();
  const orderedPath = worktreeOrder.getByRole("textbox").last();
  await expect(orderedPath).toHaveValue("");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  await orderedPath.fill("feature/temporary");
  await orderedPath.fill("");
  await worktreeOrder
    .getByRole("button", { name: "Remove Worktree Order 1", exact: true })
    .click();
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);

  const processes = project.locator(
    '[data-settings-path="projects.0.commands.processes"]',
  );
  await processes.getByRole("button", { name: "Remove web", exact: true }).click();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = (state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  }).body.changes.find((change) => change.sourceId === "app")?.patches;
  expect(patches).toEqual(
    expect.arrayContaining([
      {
        op: "remove",
        path: ["projects", "0", "commands", "processes", "web"],
      },
    ]),
  );
  expect(patches).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "set",
        path: ["projects", "0", "commands", "processes"],
        value: {},
      }),
    ]),
  );
  expect(patches).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "set",
        path: ["projects", "0", "commands"],
        value: {},
      }),
    ]),
  );
});

// keep derived installation controls out of the generic schema without losing raw repair
test("keeps Installation version and icon metadata raw while an absent Host stays editable", async ({
  page,
}) => {
  const { settings, sources } = await setupSettings(page, false, true);
  configureInstallationFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");
  const panel = settings.locator(".settings-source-panel");

  await expect(panel.locator('[data-settings-path="version"]')).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Host", exact: true })).toHaveCount(
    0,
  );
  await expect(panel.getByLabel("Checkout", { exact: true })).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Add Host" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Remove Host" })).toHaveCount(0);
  await expect(panel.locator('[data-settings-path="sources.icons"]')).toHaveCount(0);
  await expect(panel.getByLabel("Heart icon", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Potato icon", { exact: true })).toHaveCount(0);

  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = panel.getByLabel("Installation source content");
  await expect(raw).toHaveValue(/"version":1/u);
  await expect(raw).toHaveValue(/"icons":\{"heart":/u);
});

for (const [installationKind, selectedPath, otherPath, selectedLabel, otherLabel] of [
  ["compose", "compose", "native", "Docker", "Native"],
  ["systemd", "native", "compose", "Native", "Docker"],
] as const) {
  // make the server-reported deployment kind authoritative without changing either saved branch
  test(`shows only the ${selectedLabel} installation branch for ${installationKind} metadata`, async ({
    page,
  }) => {
    const { settings, sources } = await setupSettings(
      page,
      false,
      false,
      false,
      [],
      "none",
      installationKind,
    );
    const installation = configureInstallationFixture(sources) as {
      value: { native: Record<string, unknown> };
      schema: {
        properties: {
          native: { properties: Record<string, unknown> };
        };
      };
      content: string;
    };
    installation.value.native = {
      ...installation.value.native,
      cloudflaredUnit: "cloudflared.service",
      cloudflaredConfig: "/etc/cloudflared/config.yml",
      cloudflaredCredentials: "/etc/cloudflared/tunnel.json",
    };
    installation.schema.properties.native.properties = {
      ...installation.schema.properties.native.properties,
      cloudflaredUnit: { type: "string", label: "Cloudflare unit" },
      cloudflaredConfig: { type: "string", label: "Cloudflare config" },
      cloudflaredCredentials: {
        type: "string",
        label: "Cloudflare credentials",
      },
    };
    installation.content = `${JSON.stringify(installation.value)}\n`;
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "installation", "Installation");
    const panel = settings.locator(".settings-source-panel");
    const modes = panel.getByRole("group", { name: "Installation mode" });
    const checkout = panel.getByLabel("Checkout", { exact: true });

    await expect(
      panel.getByRole("heading", { name: "Installation", exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Host", exact: true })).toHaveCount(
      0,
    );
    await expect(
      panel.getByRole("heading", { name: "Docker", exact: true }),
    ).toHaveCount(0);
    expect(
      await checkout.evaluate((input) => input.getBoundingClientRect().bottom),
    ).toBeLessThan(
      await modes.evaluate((group) => group.getBoundingClientRect().top),
    );
    const selectedMode = modes.getByRole("radio", {
      name: selectedLabel,
      exact: true,
    });
    const otherMode = modes.getByRole("radio", {
      name: otherLabel,
      exact: true,
    });
    await expect(selectedMode).toBeChecked();
    await expect(selectedMode).toBeDisabled();
    await expect(otherMode).not.toBeChecked();
    await expect(otherMode).toBeDisabled();
    await expect(checkout).toBeEnabled();
    await expect(
      panel.getByRole("note").filter({ hasText: /file/iu }),
    ).toBeVisible();
    const selectedSection = panel.locator(
      `[data-settings-path="${selectedPath}"]`,
    );
    await expect(selectedSection).toBeVisible();
    await expect(panel.locator(`[data-settings-path="${otherPath}"]`)).toHaveCount(0);
    const modeField =
      installationKind === "compose"
        ? selectedSection.getByLabel("Project name", { exact: true })
        : selectedSection.getByLabel("Environment file", { exact: true });
    await expect(modeField).toBeDisabled();
    for (const path of [
      "native.cloudflaredUnit",
      "native.cloudflaredConfig",
      "native.cloudflaredCredentials",
    ])
      await expect(
        panel.locator(`[data-settings-path=${JSON.stringify(path)}]`),
      ).toHaveCount(0);
    await selectedSection.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/remoteagents-settings-installation-${installationKind}.png`,
    });
    await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
    await settings
      .getByRole("button", { name: "Edit whole source", exact: true })
      .click();
    const raw = panel.getByLabel("Installation source content", { exact: true });
    await expect(raw).toBeEditable();
    await expect(raw).toHaveValue(/"cloudflaredUnit":"cloudflared\.service"/u);
    await settings
      .getByRole("button", { name: "Use structured editor", exact: true })
      .click();
    await selectSettingsSection(settings, "tmux", "TMUX");
    for (const key of ["HOST_TMUX_DIR", "HOST_TMUX_BIN"])
      await expect(
        panel.locator(`[data-settings-path=${JSON.stringify(key)}]`),
      ).toHaveCount(installationKind === "compose" ? 1 : 0);
  });
}

// omit Docker host aliases when installation kind is unavailable
test("hides Docker-only TMUX aliases without installation metadata", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "none",
    "systemd",
  );
  await page.route("**/api/settings", async (route) => {
    // omit only installation kind from the refreshed snapshot
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        version: 1,
        revisionId: "snapshot-without-kind",
        sources,
        status: state.status,
      },
    });
  });
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "tmux", "TMUX");
  for (const key of ["HOST_TMUX_DIR", "HOST_TMUX_BIN"])
    await expect(
      settings.locator(`[data-settings-path=${JSON.stringify(key)}]`),
    ).toHaveCount(0);
  await expect(settings.getByLabel("RAC_TMUX_BIN", { exact: true })).toBeVisible();
  expect(state.saves).toEqual([]);
});

// keep installation naming and source shortcuts independent of checkout location
test("simplifies Installation around pinned source files", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources, state } = await setupSettings(page, false);
  const installation = configureInstallationFixture(sources) as {
    content: string;
    value: {
      version: number;
      host?: { checkout: string };
      native: { environmentFile: string };
      compose: {
        projectDirectory: string;
        projectName: string;
        files: string[];
        envFiles: string[];
      };
    };
  };
  const base = sources.find((source) => source.id === "compose")!;
  const override = sources.find((source) => source.id === "compose-override")!;
  const environment = sources.find((source) => source.id === "env")!;
  base.path = "/srv/custom-stack/compose.yaml";
  override.path = "/srv/custom-stack/compose.override.yaml";
  environment.path = "/srv/custom-stack/.env";
  installation.value.host = { checkout: "/srv/custom-stack" };
  installation.value.compose.projectDirectory = "/srv/custom-stack";
  installation.value.compose.files = [
    base.path,
    override.path,
    "/srv/custom-stack/compose.extra.yaml",
  ];
  installation.value.compose.envFiles = [
    environment.path,
    "/srv/custom-stack/.env.local",
  ];
  installation.content = `${JSON.stringify(installation.value)}\n`;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();

  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    nav.getByRole("button", { name: "Installation", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", {
      name: "Environment & keys",
      exact: true,
    }),
  ).toBeVisible();
  await expect(nav).not.toContainText("Installation paths");
  await expect(nav).not.toContainText("Installation & source locations");
  await expect(nav).not.toContainText("Environment & Credentials");

  await selectSettingsSection(settings, "installation", "Installation");
  const panel = settings.locator(".settings-source-panel");
  await expect(panel.getByRole("heading", { name: "Installation" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Host" })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Docker" })).toHaveCount(0);
  const checkout = panel.getByLabel("Checkout", { exact: true });
  const modes = panel.getByRole("group", { name: "Installation mode" });
  expect(
    await checkout.evaluate((input) => input.getBoundingClientRect().bottom),
  ).toBeLessThan(
    await modes.evaluate((group) => group.getBoundingClientRect().top),
  );
  await expect(modes.getByRole("radio", { name: "Docker" })).toBeChecked();
  await expect(modes.getByRole("radio", { name: "Docker" })).toBeDisabled();
  await expect(modes.getByRole("radio", { name: "Native" })).toBeDisabled();
  await expect(checkout).toBeEnabled();
  await expect(panel.locator('[data-settings-path="compose"]')).toBeVisible();
  await expect(panel.locator('[data-settings-path="native"]')).toHaveCount(0);

  const composeFiles = panel.locator('[data-settings-path="compose.files"]');
  const composeRows = composeFiles.locator(
    ".settings-array-list > .settings-array-entry",
  );
  await expect(composeRows).toHaveCount(3);
  await expect(composeRows.nth(0)).toContainText(base.path);
  await expect(composeRows.nth(1)).toContainText(override.path);
  for (const pinned of [composeRows.nth(0), composeRows.nth(1)]) {
    await expect(pinned.getByRole("textbox")).toHaveCount(0);
    await expect(
      pinned.getByRole("button", { name: /^(Edit|Move|Remove) /u }),
    ).toHaveCount(0);
    await expect(
      pinned
        .getByRole("button", {
          name: "View and edit in Docker",
          exact: true,
        })
        .or(
          pinned.getByRole("link", {
            name: "View and edit in Docker",
            exact: true,
          }),
        ),
    ).toBeVisible();
  }
  await expect(
    composeRows.nth(2).getByRole("button", {
      name: /^Move Compose files 3 up$/u,
    }),
  ).toBeDisabled();
  const extraCompose = composeRows.nth(2);
  await expect(
    extraCompose.getByRole("button", {
      name: /^Edit Compose file 3$/u,
    }),
  ).toBeEnabled();
  await expect(
    extraCompose.getByRole("button", {
      name: /^Remove Compose files 3$/u,
    }),
  ).toBeDisabled();
  await extraCompose
    .getByRole("button", { name: /^Edit Compose file 3$/u })
    .click();
  await expect(extraCompose.getByRole("textbox")).toBeDisabled();
  const dockerShortcut = composeRows
    .nth(1)
    .getByRole("button", {
      name: "View and edit in Docker",
      exact: true,
    })
    .or(
      composeRows.nth(1).getByRole("link", {
        name: "View and edit in Docker",
        exact: true,
      }),
    );
  await expect(dockerShortcut).toBeVisible();
  await composeFiles.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-pinned-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await composeFiles.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-pinned-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dockerShortcut.click();
  await expect(
    settings.getByRole("heading", { name: "Docker", exact: true }),
  ).toBeVisible();
  expect(state.saves).toHaveLength(0);

  await selectSettingsSection(settings, "installation", "Installation");
  const environmentFiles = panel.locator(
    '[data-settings-path="compose.envFiles"]',
  );
  const environmentRows = environmentFiles.locator(
    ".settings-array-list > .settings-array-entry",
  );
  await expect(environmentRows).toHaveCount(2);
  await expect(environmentRows.nth(0)).toContainText(environment.path);
  await expect(environmentRows.nth(0).getByRole("textbox")).toHaveCount(0);
  await expect(
    environmentRows.nth(1).getByRole("button", {
      name: /^Move Environment files 2 up$/u,
    }),
  ).toBeDisabled();
  const environmentShortcut = environmentRows
    .nth(0)
    .getByRole("button", {
      name: "Edit in Environment & keys",
      exact: true,
    })
    .or(
      environmentRows.nth(0).getByRole("link", {
        name: "Edit in Environment & keys",
        exact: true,
      }),
    );
  await environmentShortcut.click();
  await expect(
    settings.getByRole("heading", {
      name: "Environment & keys",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.saves).toHaveLength(0);

  // retain saved file-only values while leaving whole-source repair available
  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = panel.getByLabel("Installation source content", { exact: true });
  await expect(raw).toBeEditable();
  await expect(raw).toHaveValue(/compose\.extra\.yaml/u);
  await expect(raw).toHaveValue(/\.env\.local/u);
  expect(state.saves).toHaveLength(0);
  expect(consoleErrors).toEqual([]);
});

// represent the active environment owner without creating an installation draft
test("shows an inert default environment row when envFiles is empty", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page, false);
  const installation = configureInstallationFixture(sources) as {
    value: { compose: { projectDirectory: string; envFiles: string[] } };
  };
  const environment = sources.find((source) => source.id === "env")!;
  environment.path = "/srv/alternate/runtime.env";
  installation.value.compose.projectDirectory = "/srv/alternate";
  installation.value.compose.envFiles = [];
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");

  const environmentFiles = settings.locator(
    '[data-settings-path="compose.envFiles"]',
  );
  const rows = environmentFiles.locator(
    ".settings-array-list > .settings-array-entry",
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Default");
  await expect(rows.first()).toContainText(environment.path);
  await expect(rows.first().getByRole("textbox")).toHaveCount(0);
  await expect(
    rows.first().getByRole("button", {
      name: /^(?:Edit Environment file|Move Environment files|Remove Environment files) \d/u,
    }),
  ).toHaveCount(0);
  await expect(
    rows
      .first()
      .getByRole("button", {
        name: "Edit in Environment & keys",
        exact: true,
      })
      .or(
        rows.first().getByRole("link", {
          name: "Edit in Environment & keys",
          exact: true,
        }),
      ),
  ).toBeVisible();
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(0);
});

// keep Docker file metadata visible without exposing it as a structured mutation
test("keeps Docker options permanent and file-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources, state } = await setupSettings(page, false);
  const installation = configureInstallationFixture(sources) as {
    value: {
      compose: {
        profiles: string[];
        options?: { parallel?: number; compatibility?: boolean };
      };
    };
  };
  installation.value.compose.profiles = ["metrics"];
  delete installation.value.compose.options;
  addCloudflareFixtureSource(sources, "cloudflared-recreate");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");

  const panel = settings.locator(".settings-source-panel");
  await expect(panel.locator('[data-settings-path="compose.profiles"]')).toHaveCount(
    0,
  );
  const options = panel.locator('[data-settings-path="compose.options"]');
  const parallel = panel
    .locator('[data-settings-path="compose.options.parallel"]')
    .getByRole("spinbutton");
  const compatibility = panel
    .locator('[data-settings-path="compose.options.compatibility"]')
    .getByRole("switch");
  await expect(options).toBeVisible();
  await expect(parallel).toHaveValue("-1");
  await expect(parallel).toBeDisabled();
  await expect(compatibility).not.toBeChecked();
  await expect(compatibility).toBeDisabled();
  await expect(options).toContainText(/unlimited/iu);
  await expect(options).toContainText(/legacy Compose behavior/iu);
  for (const name of [
    "Add Options",
    "Remove Options",
    "Add Parallel",
    "Remove Parallel",
    "Add Compatibility",
    "Remove Compatibility",
  ])
    await expect(
      options.getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await selectSettingsSection(settings, "compose-override", "Docker");
  await selectSettingsSection(settings, "installation", "Installation");
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(0);

  await options.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-options-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await options.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-options-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(installation.value.compose.profiles).toEqual(["metrics"]);
  expect(state.saves).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// preserve explicit Docker values without treating saved Cloudflare files as active
test("preserves explicit Docker options without enabling an inactive tunnel", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page, false);
  const installation = configureInstallationFixture(sources) as {
    value: {
      compose: {
        profiles: string[];
        options: { parallel: number; compatibility: boolean };
      };
    };
  };
  installation.value.compose.profiles = ["metrics"];
  installation.value.compose.options = { parallel: 6, compatibility: true };
  addCloudflareFixtureSource(sources, "saved-only");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");

  const panel = settings.locator(".settings-source-panel");
  const parallel = panel
    .locator('[data-settings-path="compose.options.parallel"]')
    .getByRole("spinbutton");
  const compatibility = panel
    .locator('[data-settings-path="compose.options.compatibility"]')
    .getByRole("switch");
  await expect(panel.locator('[data-settings-path="compose.profiles"]')).toHaveCount(
    0,
  );
  await expect(parallel).toHaveValue("6");
  await expect(parallel).toBeDisabled();
  await expect(compatibility).toBeChecked();
  await expect(compatibility).toBeDisabled();
  await expect(settings.getByText("No unsaved changes", { exact: true })).toBeVisible();
  expect(installation.value.compose.profiles).toEqual(["metrics"]);
  expect(state.saves).toEqual([]);
});

// keep installation list rows and their compact controls visually distinct without filled cards
test("renders outlined transparent Installation lists with centered icon actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources } = await setupSettings(page, false);
  const installation = configureInstallationFixture(sources) as {
    value: { compose: { files: string[] } };
  };
  installation.value.compose.files.push("/checkout/compose.extra.yaml");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");
  const panel = settings.locator(".settings-source-panel");
  const composeFiles = panel.locator('[data-settings-path="compose.files"]');
  const entry = composeFiles.locator(
    ".settings-array-list > .settings-array-entry",
  ).nth(2);
  await expect(entry).toBeVisible();
  expect(
    await entry.evaluate((element) => {
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

  const actions = entry.locator(".settings-collection-actions > button");
  await expect(actions).toHaveCount(4);
  for (const action of await actions.all()) {
    const geometry = await action.evaluate((button) => {
      const icon = button.querySelector("svg")!;
      const buttonRect = button.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
        display: style.display,
        squareDelta: Math.abs(buttonRect.width - buttonRect.height),
        centerDeltaX: Math.abs(
          buttonRect.left + buttonRect.width / 2 -
            (iconRect.left + iconRect.width / 2),
        ),
        centerDeltaY: Math.abs(
          buttonRect.top + buttonRect.height / 2 -
            (iconRect.top + iconRect.height / 2),
        ),
      };
    });
    expect(geometry.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.borderStyle).toBe("solid");
    expect(geometry.display).toBe("grid");
    expect(geometry.squareDelta).toBeLessThanOrEqual(1);
    expect(geometry.centerDeltaX).toBeLessThanOrEqual(1);
    expect(geometry.centerDeltaY).toBeLessThanOrEqual(1);
  }

  for (const path of ["compose.files", "compose.envFiles"]) {
    const collection = panel.locator(`[data-settings-path="${path}"]`);
    const add = collection.locator(".settings-collection-add-button");
    await expect(add).toBeVisible();
    const style = await add.evaluate((button) => {
      const computed = getComputedStyle(button);
      const parent = button.parentElement!.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return {
        backgroundColor: computed.backgroundColor,
        borderStyle: computed.borderStyle,
        borderColor: computed.borderColor,
        pseudoBackground: getComputedStyle(button, "::before").backgroundImage,
        pseudoPointerEvents: getComputedStyle(button, "::before").pointerEvents,
        widthDelta: Math.abs(parent.width - rect.width),
      };
    });
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.borderStyle).toBe("solid");
    expect(style.borderColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.pseudoBackground).toContain("repeating-linear-gradient");
    expect(style.pseudoPointerEvents).toBe("none");
    expect(style.widthDelta).toBeLessThanOrEqual(1);
  }
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-desktop.png",
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await composeFiles.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-mobile.png",
  });
  expect(consoleErrors).toEqual([]);
});

// move icon locations beside their Application artwork while retaining Installation ownership
test("saves Application icon paths through the Installation source and blocks raw competitors", async ({
  page,
}) => {
  const sideEffects: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // observe only explicit execution boundaries
    if (path === "/api/settings/restart" || path.endsWith("/execute"))
      sideEffects.push(path);
  });
  const { settings, sources, state } = await setupSettings(page, true, true);
  configureInstallationFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const artwork = settings.getByRole("group", { name: "Local icon artwork" });
  await artwork.getByText("View / edit Heart icon", { exact: true }).click();
  const heartPath = artwork.getByLabel("Heart icon path", { exact: true });
  await expect(heartPath).toHaveValue(
    "/checkout/config/instance-icons/heart.svg",
  );
  await heartPath.fill("/checkout/config/instance-icons/heart-next.svg");
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    nav.getByRole("button", { name: /^Application config.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: /^Installation.*Unsaved changes$/u }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        revisionId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  };
  expect(save.body.changes).toEqual([
    {
      sourceId: "installation",
      revisionId: "install-r1",
      patches: [
        {
          op: "set",
          path: ["sources", "icons", "heart"],
          value: "/checkout/config/instance-icons/heart-next.svg",
        },
      ],
    },
  ]);
  expect(sideEffects).toEqual([]);
  expect(state.restarts).toBe(0);

  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = settings.getByLabel("Installation source content");
  await raw.fill(`${await raw.inputValue()} `);
  await selectSettingsSection(settings, "app", "Application config");
  await settings.getByText("View / edit Heart icon", { exact: true }).click();
  const heartDetails = settings
    .locator(".settings-icon-source")
    .filter({ hasText: "View / edit Heart icon" });
  await expect(heartDetails.getByLabel("Heart icon path", { exact: true })).toBeDisabled();
  await expect(
    heartDetails.getByText(
      "Finish or discard the Installation whole-source draft or removal before editing icon paths.",
      { exact: true },
    ),
  ).toBeVisible();
});

// retain source-local masking and whole-file ownership inside the virtual page
test("keeps TMUX raw-draft and masking guards scoped to their original sources", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "protected",
  );
  const environment = sources.find((source) => source.id === "env")!;
  environment.protected = false;
  environment.hasProtectedContent = false;
  environment.content = environment.content
    ?.split("\n")
    .filter((line) => !line.startsWith("RAC_SESSION_SECRET="))
    .join("\n");
  environment.fields = environment.fields?.filter(
    (field) => field.key !== "RAC_SESSION_SECRET",
  );
  const installation = sources.find((source) => source.id === "installation")!;
  installation.content = `${JSON.stringify(installation.value)}\n`;
  installation.hasProtectedContent = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const appRaw = settings.getByLabel("Application config source content");
  const appDraft =
    '{"identity":{"name":"Framework"},"tmux":{"pollIntervalMs":700}}\n';
  await appRaw.fill(appDraft);
  await selectSettingsSection(settings, "projects", "Projects");
  await expect(
    settings.getByRole("button", { name: "+ Add Project", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Move Projects 2 up", exact: true }),
  ).toBeDisabled();
  await settings
    .getByRole("group", { name: /^Project \d+$/u })
    .first()
    .getByRole("button", { name: /^Edit Project \d+$/u })
    .click();
  await expect(
    settings.locator('[data-settings-path="projects.0.label"] input'),
  ).toBeDisabled();
  await selectSettingsSection(settings, "tmux", "TMUX");
  const poll = settings
    .locator('[data-settings-path="tmux.pollIntervalMs"]')
    .getByRole("spinbutton");
  await expect(poll).toBeDisabled();
  await expect(settings.getByLabel("RAC_TMUX_BIN", { exact: true })).toBeEnabled();
  await expect(settings.locator('[data-settings-path="sources.wrapper"]')).toHaveCount(0);
  const wrapper = settings.getByLabel("Installation wrapper source content");
  await expect(wrapper).toHaveAttribute("readonly", "");
  await expect(wrapper).toHaveValue(
    "#!/usr/bin/env bash\nRAC_SESSION_SECRET=********\n",
  );
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await expect(wrapper).toBeEditable();
  await expect(wrapper).toHaveValue(/fixture-session-secret/u);

  // an Environment raw draft blocks only its own TMUX fields
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const envRaw = settings.getByLabel(
    "Environment & keys source content",
  );
  const envDraft = `${await envRaw.inputValue()}# retained environment draft\n`;
  await envRaw.fill(envDraft);
  await selectSettingsSection(settings, "tmux", "TMUX");
  await expect(settings.getByLabel("RAC_TMUX_BIN", { exact: true })).toBeDisabled();
  await expect(settings.locator('[data-settings-path="sources.wrapper"]')).toHaveCount(0);
  await expect(
    settings.getByLabel("Installation wrapper source content"),
  ).toHaveAttribute("readonly", "");

  // raw Installation repair retains legacy metadata without replacing the installed wrapper source
  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const installationRaw = settings.getByLabel(
    "Installation source content",
  );
  await expect(installationRaw).toHaveValue(/"sources":\{"wrapper":/u);
  const installationDraft =
    '{"native":{"environmentFile":"/checkout/.env"},"compose":{"projectName":"rac"},"sources":{"wrapper":"/checkout/config/raw-wrapper.sh"}}\n';
  await installationRaw.fill(installationDraft);
  await selectSettingsSection(settings, "tmux", "TMUX");
  await expect(settings.locator('[data-settings-path="sources.wrapper"]')).toHaveCount(0);
  await expect(
    settings.getByLabel("Installation wrapper source content"),
  ).toHaveAttribute("readonly", "");
  await selectSettingsSection(settings, "app", "Application config");
  await expect(settings.getByLabel("Application config source content")).toHaveValue(
    appDraft,
  );
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(envDraft);
  await selectSettingsSection(settings, "installation", "Installation");
  await expect(settings.getByLabel("Installation source content")).toHaveValue(
    installationDraft,
  );
  expect(state.saves).toEqual([]);
});

test("keeps source handover choices out of every inline source panel", async ({
  page,
}) => {
  const { settings } = await setupSettings(page, false);
  for (const [id, label] of [
    ["env", "Environment & keys"],
    ["installation", "Installation"],
    ["compose-override", "Docker"],
  ] as const) {
    await selectSettingsSection(settings, id, label);
    await expect(settings.locator(".settings-migration")).toHaveCount(0);
    await expect(
      settings.getByRole("group", { name: /Source handover/u }),
    ).toHaveCount(0);
  }
});

test("saves ordinary settings without asking for source handover", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await settings.getByLabel("Server name").fill("Ordinary settings edit");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Choose source handover" }),
  ).toHaveCount(0);
  await expect.poll(() => state.validations.length).toBe(1);
  await expect.poll(() => state.saves.length).toBe(1);
});

test("asks for one authoritative handover only at save time", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  state.migrationRequiredSourceIds = ["installation"];
  await settings.getByRole("radio", { name: "Light theme" }).click();
  const installationRaw = await stageInstallationWholeSource(
    settings,
    "/checkout/config/runtime.env",
  );
  const save = settings.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  const dialog = page.getByRole("alertdialog", {
    name: "Choose source handover",
    exact: true,
  });

  // validation reports the save-time decision without opening a modal
  await settings
    .getByRole("button", { name: "Validate", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    settings.getByText("Save changes to choose a source handover.", {
      exact: true,
    }),
  ).toBeVisible();

  // cancellation keeps every participant staged without persisting anything
  await save.click();
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", {
    name: "Continue and save",
    exact: true,
  });
  const installation = dialog.getByRole("group", {
    name: "Installation",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await expect(installation.getByRole("radio")).toHaveCount(3);
  for (const radio of await installation.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  expect(state.saves).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("rac.color-theme")),
  ).toBeNull();
  await installation
    .getByRole("radio", { name: "Copy current", exact: true })
    .check();
  await expect(confirm).toBeEnabled();
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  await expect(installationRaw).toHaveValue(/\/checkout\/config\/runtime\.env/u);
  expect(state.saves).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("rac.color-theme")),
  ).toBeNull();

  // Escape is the same safe cancellation and does not retain a hidden choice
  await save.click();
  await expect(dialog).toBeVisible();
  for (const radio of await installation.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  await installation
    .getByRole("radio", { name: "Adopt existing", exact: true })
    .check();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(installationRaw).toHaveValue(/\/checkout\/config\/runtime\.env/u);
  expect(state.saves).toEqual([]);

  // one explicit choice revalidates the captured transaction and commits once
  await save.click();
  for (const radio of await installation.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  await installation
    .getByRole("radio", { name: "Copy current", exact: true })
    .check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.saves.length).toBe(1);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rac.color-theme")))
    .toBe("latte");
  await expect(
    page
      .locator('body > .toast-region .operation-feedback.success[role="status"]')
      .filter({ hasText: "Saved" }),
  ).toContainText("Settings updated.");
  await expect(settings.getByText("Saved.", { exact: true })).toHaveCount(0);
  expect(state.validations).toHaveLength(5);
  const transaction = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        migration?: { mode: string };
      }>;
    };
  };
  expect(
    transaction.body.changes.find(
      (change) => change.sourceId === "installation",
    )?.migration,
  ).toEqual({ mode: "copy" });
});

test("collects every typed and Compose handover inside the mobile Settings split", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state } = await setupSettings(page, false);
  state.migrationRequiredSourceIds = ["installation", "compose-override"];
  await stageInstallationWholeSource(
    settings,
    "/checkout/config/mobile-runtime.env",
  );
  await selectSettingsSection(settings, "compose-override", "Docker");
  await settings
    .getByLabel("Docker source content")
    .fill(
      "services:\n  remote-agent-console:\n    environment:\n      RAC_CONFIG: /workspace/config/mobile.json\n",
    );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  const dialog = page.getByRole("alertdialog", {
    name: "Choose source handover",
    exact: true,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", {
    name: "Continue and save",
    exact: true,
  });
  const groups = dialog.locator(".settings-handover-options");
  const installation = groups.nth(0);
  const docker = groups.nth(1);
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAccessibleName("Installation");
  await expect(groups.nth(1)).toHaveAccessibleName("Docker");
  await expect(dialog.getByRole("radio")).toHaveCount(6);
  for (const radio of await dialog.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  const installationCopy = installation.getByRole("radio", {
    name: "Copy current",
    exact: true,
  });
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-handover-mobile.png",
  });
  const mobileGeometry = await dialog.evaluate((element) => {
    const overlay = element.closest<HTMLElement>(".split-confirmation-overlay")!;
    const card = element.closest<HTMLElement>(".split-confirmation-card")!;
    const radio = element.querySelector<HTMLInputElement>("input[type=radio]")!;
    const bounds = (target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    };
    let parent = radio.parentElement;
    let inertAncestor: string | undefined;
    while (parent !== null) {
      if (parent.inert) {
        inertAncestor = parent.className;
        break;
      }
      parent = parent.parentElement;
    }
    const radioRect = radio.getBoundingClientRect();
    return {
      card: bounds(card),
      cardClientHeight: card.clientHeight,
      cardScrollHeight: card.scrollHeight,
      cardScrollTop: card.scrollTop,
      inertAncestor,
      overlay: bounds(overlay),
      overlayClientHeight: overlay.clientHeight,
      overlayScrollHeight: overlay.scrollHeight,
      overlayScrollTop: overlay.scrollTop,
      radio: bounds(radio),
      radioInViewport:
        radioRect.bottom > 0 &&
        radioRect.top < document.documentElement.clientHeight,
    };
  });
  expect(mobileGeometry.inertAncestor).toBeUndefined();
  expect(mobileGeometry.radioInViewport).toBe(true);
  await expect(installationCopy).toBeVisible();
  await expect(installationCopy).toBeEnabled();
  await installationCopy.check();
  await expect(confirm).toBeDisabled();
  await docker
    .getByRole("radio", { name: "Adopt existing", exact: true })
    .check();
  await expect(confirm).toBeEnabled();

  // modal focus and bounds stay inside the dark mobile Settings split
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(":focus")).toHaveCount(1);
  const isolation = await settings.evaluate((element) => {
    const overlay = element.querySelector<HTMLElement>(
      ".split-confirmation-overlay",
    )!;
    const card = overlay.querySelector<HTMLElement>(
      ".split-confirmation-card",
    )!;
    const split = element.getBoundingClientRect();
    const bounds = overlay.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    return {
      background: cardStyle.backgroundColor,
      bottom: bounds.bottom <= split.bottom + 1,
      coveredChildrenInert: Array.from(element.children)
        .filter((child) => child !== overlay)
        .every((child) => (child as HTMLElement).inert),
      left: bounds.left >= split.left - 1,
      overflow: element.scrollWidth - element.clientWidth,
      right: bounds.right <= split.right + 1,
      top: bounds.top >= split.top - 1,
    };
  });
  expect(isolation).toEqual({
    background: expect.not.stringMatching(/rgba\([^)]*,\s*0\)/u),
    bottom: true,
    coveredChildrenInert: true,
    left: true,
    overflow: 0,
    right: true,
    top: true,
  });
  await confirm.click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.validations).toHaveLength(2);
  const transaction = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        migration?: { mode: string };
      }>;
    };
  };
  expect(
    transaction.body.changes.find(
      (change) => change.sourceId === "installation",
    )?.migration,
  ).toEqual({ mode: "copy" });
  expect(
    transaction.body.changes.find(
      (change) => change.sourceId === "compose-override",
    )?.migration,
  ).toEqual({ mode: "adopt" });
  expect(consoleErrors).toEqual([]);
});

test("cancels a paused source handover when Settings unmounts", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  state.migrationRequiredSourceIds = ["installation"];
  await settings.getByRole("radio", { name: "Light theme" }).click();
  await stageInstallationWholeSource(
    settings,
    "/checkout/config/unmounted-runtime.env",
  );
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

  // unmounting rejects the paused consent without writing either participant
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(state.saves).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("rac.color-theme")),
  ).toBeNull();
});

// keep navigation stable before the first file catalog is available
for (const width of [390, 1440]) {
  test(`keeps all settings sections visible while initial files load at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = deferredResponse();
    const retry = deferredResponse();
    const { settings, state } = await setupSettings(
      page,
      false,
      false,
      false,
      [
        { wait: initial.promise, status: 503 },
        { wait: retry.promise },
      ],
    );
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
    });
    await expect.poll(() => state.settingsReads).toBe(1);
    const catalogLoading = settings.getByRole("status").filter({
      hasText: "Loading installation files",
    });
    await expectProgressBorder(catalogLoading, "blue");
    // inspect the navigation presentation for this breakpoint
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await expect(selector).toBeEnabled();
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(11);
      const browser = listbox.locator('[role="option"][data-value="browser"]');
      await expect(browser).not.toHaveAttribute("aria-disabled", "true");
      await expect(browser.locator(":scope > .update-progress-ring")).toHaveCount(0);
      for (const id of [
        "voice",
        "keyboard",
        ...settingsSourcePlaceholders.map((source) => source.id),
      ]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).toHaveAttribute("aria-disabled", "true");
        await expectProgressBorder(option, "blue");
      }
      await selector.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        listbox.locator('[role="option"][data-active="true"]'),
      ).toHaveAttribute("data-value", "browser");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(11);
      await expect(
        nav.getByRole("button", { name: "This browser", exact: true }),
      ).toBeEnabled();
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        ...settingsSourcePlaceholders.map((source) => source.label),
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute("aria-busy", "true");
        await expectProgressBorder(button, "blue");
      }
    }
    await settings.screenshot({
      path: `/tmp/remoteagents-loading-borders-settings-${width}.png`,
    });

    // search filters placeholders without removing the current mobile section
    await search.fill("cloudflare");
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(3);
      await expect(
        listbox.locator('[role="option"][data-value="cloudflared"]'),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(
        listbox.locator(
          '[role="option"][data-value="cloudflared-credentials"]',
        ),
      ).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(2);
    }

    initial.resolve();
    await expect(
      settings.getByRole("alert").filter({
        hasText: "Installation files are unavailable",
      }),
    ).toBeVisible();
    await search.fill("");

    // unavailable placeholders persist without claiming active work
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      for (const source of settingsSourcePlaceholders) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(source.id)}]`,
        );
        await expect(option).toHaveAttribute("aria-disabled", "true");
        await expect(option).not.toHaveAttribute("aria-busy", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      for (const id of ["voice", "keyboard"]) {
        await expect(
          listbox.locator(
            `[role="option"][data-value=${JSON.stringify(id)}]`,
          ),
        ).not.toHaveAttribute("aria-disabled", "true");
      }
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      for (const source of settingsSourcePlaceholders) {
        const button = nav.getByRole("button", {
          name: source.label,
          exact: true,
        });
        await expect(button).toBeDisabled();
        await expect(button).not.toHaveAttribute("aria-busy", "true");
        await expect(button.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      await expect(
        nav.getByRole("button", { name: "Voice", exact: true }),
      ).toBeEnabled();
      await expect(
        nav.getByRole("button", {
          name: "Keyboard shortcuts",
          exact: true,
        }),
      ).toBeEnabled();
    }

    await settings.getByRole("button", { name: "Retry files" }).click();
    await expect.poll(() => state.settingsReads).toBe(2);
    await expect(
      settings.getByRole("status").filter({
        hasText: "Loading installation files",
      }),
    ).toBeVisible();
    retry.resolve();
    await expect(
      settings.getByText("Loading installation files", { exact: false }),
    ).toHaveCount(0);

    // the authoritative response replaces every placeholder
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(9);
      for (const id of ["voice", "keyboard", "app", "projects", "tmux", "env", "installation", "compose-override"]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).not.toHaveAttribute("aria-disabled", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      await expect(
        listbox.locator('[role="option"][data-value="cloudflared"]'),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(9);
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        "Application config",
        "Projects",
        "TMUX",
        "Environment & keys",
        "Installation",
        "Docker",
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeEnabled();
        await expect(button.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      await expect(
        nav.getByRole("button", {
          name: "Cloudflare tunnel",
          exact: true,
        }),
      ).toHaveCount(0);
    }
  });
}

// retain the loaded catalog while one refresh is pending
for (const width of [390, 1440]) {
  test(`keeps loaded settings sections visible while files refresh at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const refresh = deferredResponse();
    const { settings, state } = await setupSettings(
      page,
      false,
      false,
      false,
      [{}, { wait: refresh.promise }],
    );
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
    });
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await expect.poll(() => state.settingsReads).toBe(2);
    // refresh disables only the retained file-dependent destinations
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await expect(selector).toBeEnabled();
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(9);
      for (const id of [
        "voice",
        "keyboard",
        "app",
        "projects",
        "tmux",
        "env",
        "installation",
        "compose-override",
      ]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).toHaveAttribute("aria-disabled", "true");
        await expectProgressBorder(option, "blue");
      }
      await selector.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        listbox.locator('[role="option"][data-active="true"]'),
      ).toHaveAttribute("data-value", "browser");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(9);
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        "Application config",
        "Projects",
        "TMUX",
        "Environment & keys",
        "Installation",
        "Docker",
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute("aria-busy", "true");
        await expectProgressBorder(button, "blue");
      }
    }

    // filtering stays available while retained entries are pending
    await search.fill("docker");
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(2);
      const compose = listbox.locator(
        '[role="option"][data-value="compose-override"]',
      );
      await expect(compose).toHaveAttribute("aria-disabled", "true");
      await expectProgressBorder(compose, "blue");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      const compose = nav.getByRole("button", {
        name: "Docker",
        exact: true,
      });
      await expect(nav.getByRole("button")).toHaveCount(1);
      await expect(compose).toBeDisabled();
      await expectProgressBorder(compose, "blue");
    }

    await search.fill("");
    refresh.resolve();
    await expect(
      settings.getByRole("button", { name: "Refresh files", exact: true }),
    ).toBeEnabled();

    // refresh completion restores the retained destinations
    if (width === 390) {
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      for (const id of ["voice", "keyboard", "app", "projects", "tmux", "env", "installation", "compose-override"]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).not.toHaveAttribute("aria-disabled", "true");
        await expect(option).not.toHaveAttribute("aria-busy", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        "Application config",
        "Projects",
        "TMUX",
        "Environment & keys",
        "Installation",
        "Docker",
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveAttribute("aria-busy", "true");
        await expect(button.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
    }
  });
}

// reuse every mobile section glyph in the desktop navigation
test("matches desktop settings icons to mobile navigation without changing names", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refresh = deferredResponse();
  const { settings, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [{}, {}, { wait: refresh.promise }],
  );
  const sections = [
    { id: "browser", label: "This browser" },
    { id: "voice", label: "Voice" },
    { id: "keyboard", label: "Keyboard shortcuts" },
    { id: "app", label: "Application config" },
    { id: "projects", label: "Projects" },
    { id: "tmux", label: "TMUX" },
    { id: "env", label: "Environment & keys" },
    { id: "installation", label: "Installation" },
    { id: "compose-override", label: "Docker" },
  ] as const;
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  const desktopPaths = new Map<string, string>();

  // desktop glyphs remain decorative beside their existing labels
  for (const section of sections) {
    const button = nav.getByRole("button", {
      name: section.label,
      exact: true,
    });
    await expect(button).toHaveAccessibleName(section.label);
    await expect(button.locator(".settings-source-nav-label")).toHaveText(
      section.label,
    );
    const icon = button.locator(".settings-source-nav-icon");
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(icon.locator("svg path")).toHaveCount(1);
    desktopPaths.set(
      section.id,
      (await icon.locator("svg path").getAttribute("d"))!,
    );
  }
  // keep the environment glyph as a readable outlined key instead of a crowded silhouette
  const environmentKeyPath =
    "M11 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM11 12h11m-4 0v4m3-4v3";
  const tmuxPath = "M3 4h18v16H3zm9 0v16M3 12h9";
  await nav
    .getByRole("button", {
      name: "Environment & keys",
      exact: true,
    })
    .screenshot({ path: "/tmp/remoteagents-environment-key-desktop.png" });
  expect(desktopPaths.get("env")).toBe(environmentKeyPath);
  expect(desktopPaths.get("tmux")).toBe(tmuxPath);
  await expect(
    nav.getByRole("button", { name: "Application config", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  // mobile retains the same glyph geometry for every loaded section
  await page.setViewportSize({ width: 390, height: 844 });
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await selector.click();
  const listbox = page.getByRole("listbox", {
    name: "Settings section options",
  });
  for (const section of sections) {
    const path = listbox
      .locator(
        `[role="option"][data-value=${JSON.stringify(section.id)}]`,
      )
      .locator(".settings-select-option-icon svg path");
    await expect(path).toHaveAttribute("d", desktopPaths.get(section.id)!);
  }
  await expect(
    listbox
      .locator('[role="option"][data-value="env"]')
      .locator(".settings-select-option-icon svg path"),
  ).toHaveAttribute("d", environmentKeyPath);
  await listbox
    .locator('[role="option"][data-value="env"]')
    .screenshot({ path: "/tmp/remoteagents-environment-key-mobile.png" });
  await page.keyboard.press("Escape");

  // existing trailing status marks coexist with the new leading icon
  await page.setViewportSize({ width: 1440, height: 900 });
  await settings.getByLabel("Server name").fill("Icon parity draft");
  const application = nav.getByRole("button", {
    name: "Application config Unsaved changes",
    exact: true,
  });
  await expect(application.locator(".settings-source-nav-icon")).toBeVisible();
  await expect(application.locator(".settings-source-nav-label")).toHaveText(
    "Application config",
  );
  await expect(application.getByLabel("Unsaved changes")).toBeVisible();
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  const refreshButton = settings.getByRole("button", {
    name: "Refresh files",
    exact: true,
  });
  await expect(refreshButton).toBeEnabled();
  await refreshButton.click();
  await expect.poll(() => state.settingsReads).toBe(3);
  const pendingApplication = nav.getByRole("button", {
    name: "Application config",
    exact: true,
  });
  await expect(
    pendingApplication.locator(".settings-source-nav-icon"),
  ).toBeVisible();
  await expectProgressBorder(pendingApplication, "blue");
  refresh.resolve();
  await expect(refreshButton).toBeEnabled();

  // preserve icon alignment when the desktop nav becomes horizontal
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(nav).toBeVisible();
  const narrow = await nav.evaluate((element) => {
    const button = element.querySelector<HTMLButtonElement>(
      'button[aria-current="page"]',
    )!;
    const icon = button
      .querySelector(".settings-source-nav-icon")!
      .getBoundingClientRect();
    const label = button
      .querySelector(".settings-source-nav-label")!
      .getBoundingClientRect();
    return {
      direction: getComputedStyle(element).flexDirection,
      iconBeforeLabel: icon.right <= label.left,
      centerDelta: Math.abs(
        icon.top + icon.height / 2 - label.top - label.height / 2,
      ),
      overflow: button.scrollWidth - button.clientWidth,
    };
  });
  expect(narrow.direction).toBe("row");
  expect(narrow.iconBeforeLabel).toBe(true);
  expect(narrow.centerDelta).toBeLessThanOrEqual(1);
  expect(narrow.overflow).toBeLessThanOrEqual(0);
});

// reserve winner copy for explicit, confirmed conflicts only
test("shows winning sources only for confirmed conflicting environment values", async ({
  page,
}) => {
  const { settings, sources } = await setupSettings(page);
  const env = sources.find((source) => source.id === "env")!;
  env.fields!.push(
    {
      key: "RAC_EQUAL_VALUE",
      value: "same-value",
      protected: false,
      present: true,
      apply: "rac-restart",
      origin: "compose env_file: .env",
      overriddenBy: "equal process environment",
    },
    {
      key: "RAC_PENDING_VALUE",
      value: "saved-value",
      protected: false,
      present: true,
      apply: "rac-restart",
      origin: "compose env_file: .env",
      overriddenBy: "pending process environment",
    },
    {
      key: "RAC_ABSENT_VALUE",
      protected: false,
      present: false,
      apply: "rac-restart",
      origin: "compose env_file: .env",
      overriddenBy: "stale process environment",
    },
  );
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");

  const header = settings.locator(".settings-source-header");
  await expect(header).not.toContainText("Winning source:");
  await expect(header).not.toContainText("Overridden by:");

  const plainConflict = settings.locator('[data-settings-path="RAC_PORT"]');
  await expect(plainConflict).toContainText(
    "Winning source: Compose environment",
  );
  await expect(plainConflict).toContainText(
    "Overridden by: services.remote-agent-console.environment.RAC_PORT",
  );

  const protectedConflict = settings.locator(
    '[data-settings-path="RAC_SESSION_SECRET"]',
  );
  await expect(protectedConflict).toContainText(
    "Winning source: Compose environment",
  );
  await expect(protectedConflict).toContainText(
    "Overridden by: services.remote-agent-console.environment.RAC_SESSION_SECRET",
  );

  // stale provenance and warnings never manufacture a winner
  for (const key of [
    "EDITOR_COMMAND",
    "RAC_EQUAL_VALUE",
    "RAC_PENDING_VALUE",
    "RAC_ABSENT_VALUE",
  ]) {
    await expect(
      settings.locator(`[data-settings-path=${JSON.stringify(key)}]`),
    ).not.toContainText("Winning source:");
  }
  await expect(
    settings.locator('[data-settings-path="EDITOR_COMMAND"]'),
  ).toContainText("Overridden by: legacy process environment");

  // draft values no longer have a confirmed effective winner
  await plainConflict.getByLabel("RAC_PORT", { exact: true }).fill("9999");
  await expect(plainConflict).not.toContainText("Winning source:");
  await expect(plainConflict).toContainText(
    "Overridden by: services.remote-agent-console.environment.RAC_PORT",
  );
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(plainConflict).toContainText(
    "Winning source: Compose environment",
  );

  // clearing an assignment is also pending until saved and refetched
  await plainConflict.getByLabel("RAC_PORT", { exact: true }).fill("");
  await expect(plainConflict).not.toContainText("Winning source:");
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(plainConflict).toContainText(
    "Winning source: Compose environment",
  );
});

// keep browser preference copy and actions aligned without spanning grid columns
for (const width of [320, 390, 1440, 2560]) {
  test(`aligns browser preference controls beside their copy at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings } = await setupSettings(page, false);
    const overview = settings.locator(".client-settings-overview");
    const name = overview.getByRole("group", { name: "Name", exact: true });
    await expect(name).toBeVisible({ timeout: 3_000 });
    await expect(name.getByText("This browser", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      name.getByRole("button", { name: "Rename browser name", exact: true }),
    ).toBeVisible();
    const theme = overview.getByRole("group", { name: "Theme", exact: true });
    await expect(theme.locator(".client-settings-setting-copy")).toContainText(
      "Use a dark or light appearance in this browser.",
    );
    const metrics = await overview.evaluate((element) => {
      const grid =
        getComputedStyle(element).gridTemplateColumns.split(" ").length;
      const bounds = element.getBoundingClientRect();
      const terminal = element
        .querySelector(".client-settings-terminal-font")!
        .getBoundingClientRect();
      const rows = Array.from(
        element.querySelectorAll(".client-settings-setting"),
      ).map((row) => {
        const copy = row
          .querySelector(".client-settings-setting-copy")!
          .getBoundingClientRect();
        const control = row
          .querySelector(".client-settings-setting-control")!
          .getBoundingClientRect();
        return {
          separation: control.left - copy.right,
          centerDelta: Math.abs(
            copy.top + copy.height / 2 - control.top - control.height / 2,
          ),
          overflow: row.scrollWidth - row.clientWidth,
        };
      });
      return { grid, width: bounds.width, terminalWidth: terminal.width, rows };
    });
    expect(metrics.rows).toHaveLength(6);
    // prove right alignment and centering for every browser preference
    for (const row of metrics.rows) {
      expect(row.separation).toBeGreaterThanOrEqual(0);
      expect(row.centerDelta).toBeLessThanOrEqual(1);
      expect(row.overflow).toBeLessThanOrEqual(0);
    }
    // keep every preference on its own full-width row
    expect(metrics.grid).toBe(1);
    expect(Math.abs(metrics.terminalWidth - metrics.width)).toBeLessThanOrEqual(1);
  });
}

// keep every form group vertically stacked regardless of available split width
for (const width of [375, 1440, 2560]) {
  test(`stacks every settings form in one column at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { settings, sources, state } = await setupSettings(page, true, false, true);
    const env = sources.find((source) => source.id === "env")!;
    env.fields!.push({ key: "RAC_PASSWORD_HASH", protected: true, present: true, hasValue: true, apply: "rac-restart" });
    await settings.getByRole("button", { name: "Refresh files", exact: true }).click();
    const panel = settings.locator(".settings-source-panel");

    // inspect real grid tracks and child geometry instead of matching CSS text
    const assertSingleColumn = async () => {
      const layouts = await panel.locator(".settings-object-fields, .settings-env-fields, .client-settings-davo-form, .settings-password-replacement").evaluateAll((elements) => {
        // ignore only form containers that have no rendered box
        return elements.filter((element) => element.getBoundingClientRect().width > 0).map((element) => {
          const bounds = element.getBoundingClientRect();
          // compare complete setting rows rather than their inline controls
          const children = Array.from(element.children).filter((child) => child.getBoundingClientRect().width > 0).map((child) => {
            const rect = child.getBoundingClientRect();
            return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
          });
          return { columns: getComputedStyle(element).gridTemplateColumns.split(" ").length, width: bounds.width, children };
        });
      });
      expect(layouts.length).toBeGreaterThan(0);
      // require a full-width row and vertical ordering for every visible group
      for (const layout of layouts) {
        expect(layout.columns).toBe(1);
        for (const [index, child] of layout.children.entries()) {
          expect(Math.abs(child.width - layout.width)).toBeLessThanOrEqual(2);
          if (index > 0) {
            // consecutive settings may not occupy the same row
            expect(child.top).toBeGreaterThanOrEqual(layout.children[index - 1]!.bottom - 1);
            expect(Math.abs(child.left - layout.children[index - 1]!.left)).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };

    // cover each structured editor that shares the form-grid rules
    for (const [id, label] of [["app", "Application config"], ["env", "Environment & keys"], ["tmux", "TMUX"], ["installation", "Installation"], ["projects", "Projects"], ["voice", "Voice"]] as const) {
      await selectSettingsSection(settings, id, label);
      if (id === "projects") {
        // expose nested object fields inside the compact project row
        await settings.getByRole("button", { name: "Edit Project 1", exact: true }).click();
      }
      if (id === "env") {
        // include the password and confirmation fields without authoring a change
        await settings.getByRole("button", { name: "Set new password", exact: true }).click();
      }
      await assertSingleColumn();
      if ((width === 375 || width === 1440) && (id === "env" || id === "voice")) {
        // retain desktop and mobile evidence for ordinary and specialized forms
        await settings.screenshot({ path: `/tmp/remoteagents-settings-single-column-${id}-${width}.png` });
      }
    }
    expect(state.saves).toHaveLength(0);
    await expect(settings.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  });
}

// keep each disclosure glyph synchronized with native click and keyboard toggles
for (const width of [390, 1440]) {
  test(`shows a close icon only while the icon viewer is open at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupSettings(page, true, true);
    const artwork = settings
      .locator(".settings-icon-source")
      .filter({ hasText: "View / edit Heart icon" });
    const summary = artwork.locator("summary");
    const pencil = summary.locator(
      'svg path[d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3"]',
    );
    const close = summary.locator('svg path[d="m6 6 12 12M18 6 6 18"]');
    await expect(pencil).toBeVisible();
    await expect(close).toBeHidden();
    await summary.click();
    await expect(artwork).toHaveAttribute("open", "");
    await expect(close).toBeVisible();
    await expect(pencil).toBeHidden();
    // other icon viewers keep their independent closed state
    const potato = settings
      .locator(".settings-icon-source")
      .filter({ hasText: "View / edit Potato icon" });
    await expect(
      potato.locator(
        'summary svg path[d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3"]',
      ),
    ).toBeVisible();
    const input = artwork.getByRole("textbox", {
      name: "Heart icon source content",
      exact: true,
    });
    const draft =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n';
    await input.fill(draft);
    // the visible X closes the viewer without discarding its draft
    await close.click();
    await expect(artwork).not.toHaveAttribute("open");
    await expect(pencil).toBeVisible();
    await expect(close).toBeHidden();
    await expect(input).toBeHidden();
    // native keyboard activation updates the same glyph without extra state
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(close).toBeVisible();
    await expect(input).toHaveValue(draft);
    await page.keyboard.press("Space");
    await expect(pencil).toBeVisible();
    await expect(close).toBeHidden();
    expect(state.saves).toHaveLength(0);
    expect(state.validations).toHaveLength(0);
    expect(state.reveals).toHaveLength(0);
    expect(state.restarts).toBe(0);
  });
}

// keep artwork removal in the header without coupling it to disclosure toggling
for (const width of [390, 1440]) {
  test(`stages icon removal from a header trash action at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupSettings(page, true, true);
    const artwork = settings
      .locator(".settings-icon-source")
      .filter({ hasText: "View / edit Heart icon" });
    const summary = artwork.locator("summary");
    const trash = summary.getByRole("button", {
      name: "Remove Heart icon",
      exact: true,
    });
    await expect(trash).toBeVisible();
    await expect(trash).toHaveAttribute("title", "Remove Heart icon");
    await expect(trash.locator("span")).toHaveClass("sr-only");
    await expect(trash.locator("svg path")).toHaveAttribute(
      "d",
      "M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6",
    );
    // measure adjacent actions against the full artwork label and description
    const geometry = await trash.evaluate((button) => {
      const edit = button.previousElementSibling!;
      const summary = button.parentElement!;
      const copy = summary.querySelector("span:not(.settings-icon-thumbnail)")!;
      const action = button.getBoundingClientRect();
      const glyph = edit.getBoundingClientRect();
      const text = copy.getBoundingClientRect();
      const red = document.createElement("span");
      red.style.color = "var(--red)";
      summary.append(red);
      const expectedColor = getComputedStyle(red).color;
      red.remove();
      return {
        gap: action.left - glyph.right,
        centerDelta: Math.abs(
          (action.top + action.bottom - text.top - text.bottom) / 2,
        ),
        squareDelta: Math.abs(action.width - action.height),
        color: getComputedStyle(button).color,
        expectedColor,
        overflow: summary.scrollWidth - summary.clientWidth,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(0);
    expect(geometry.gap).toBeLessThanOrEqual(12);
    expect(geometry.centerDelta).toBeLessThanOrEqual(1);
    expect(geometry.squareDelta).toBeLessThanOrEqual(1);
    expect(geometry.color).toBe(geometry.expectedColor);
    expect(geometry.overflow).toBe(0);
    const potato = settings
      .locator(".settings-icon-source")
      .filter({ hasText: "View / edit Potato icon" });
    await expect(
      potato.getByRole("button", { name: "Remove Potato icon", exact: true }),
    ).toHaveCount(0);
    // removing a closed source stages only and never opens its viewer
    await trash.click();
    await expect(artwork).not.toHaveAttribute("open");
    await expect(trash).toBeDisabled();
    expect(state.saves).toHaveLength(0);
    expect(state.validations).toHaveLength(0);
    await settings
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await confirmSettingsDiscard(page);
    await expect(trash).toBeEnabled();
    await summary.click();
    await expect(artwork).toHaveAttribute("open", "");
    await expect(
      artwork
        .locator(".settings-icon-source-content")
        .getByRole("button", { name: /Remove/u }),
    ).toHaveCount(0);
    await expect(summary.locator(".settings-icon-source-close")).toBeVisible();
    // keyboard activation removes without closing or toggling the viewer
    await trash.focus();
    await page.keyboard.press("Space");
    await expect(artwork).toHaveAttribute("open", "");
    await expect(trash).toBeDisabled();
    expect(state.saves).toHaveLength(0);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    expect(
      (state.saves[0] as { body: { changes: unknown[] } }).body.changes,
    ).toEqual([
      { sourceId: "icon-heart", revisionId: "heart-r1", remove: true },
    ]);
    expect(state.reveals).toHaveLength(0);
    expect(state.restarts).toBe(0);
  });
}

// keep Environment values blankable while reserving destructive controls for custom keys
test("renders Environment keys as blankable assignments with custom-only removal controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state, sources } = await setupSettings(page);
  const env = sources.find((source) => source.id === "env")!;
  env.content = undefined;
  env.hasProtectedContent = true;
  env.fields!.push(
    {
      key: "RAC_OPENAI_API_KEY",
      protected: true,
      present: false,
      apply: "rac-restart",
    },
    {
      key: "RAC_EMPTY_TOKEN",
      protected: true,
      present: true,
      hasValue: false,
      apply: "rac-restart",
    },
  );
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");

  const panel = settings.locator(".settings-source-panel");
  await expect(
    panel.getByRole("heading", { name: "Environment & keys", exact: true }),
  ).toBeVisible();
  for (const key of ["RAC_SESSION_SECRET", "RAC_HOST_PROC", "RAC_HOST_UID"]) {
    await expect(
      panel
        .locator(`[data-settings-path=${JSON.stringify(key)}]`)
        .getByRole("button", { name: `Remove ${key}`, exact: true }),
    ).toHaveCount(0);
  }
  await expect(
    panel.getByRole("button", { name: "Replace without revealing", exact: true }),
  ).toHaveCount(0);
  for (const key of ["RAC_OPENAI_API_KEY", "RAC_EMPTY_TOKEN"]) {
    const field = panel.locator(`[data-settings-path=${JSON.stringify(key)}]`);
    const input = field.getByLabel(key, { exact: true });
    await expect(input).toBeEditable();
    await expect(input).toHaveValue("");
    await expect(field.getByText("Protected", { exact: true })).toHaveCount(0);
    await expect(field.getByRole("button", { name: /Reveal|Mask/u })).toHaveCount(
      0,
    );
  }
  const missing = panel.getByLabel("RAC_OPENAI_API_KEY", { exact: true });
  await missing.fill("synthetic-unsaved-key");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await missing.fill("");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);

  const ordinaryField = panel.locator('[data-settings-path="RAC_HOST_PROC"]');
  // compare environment secrets against ordinary field chrome
  const fieldChrome = async (field: typeof ordinaryField) =>
    field.evaluate((element) => {
      // capture only the wrapper chrome that distinguishes protected cards
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        borderTopWidth: style.borderTopWidth,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        paddingTop: style.paddingTop,
      };
    });
  const ordinaryChrome = await fieldChrome(ordinaryField);
  // cover saved and missing protected environment values
  for (const key of [
    "RAC_SESSION_SECRET",
    "RAC_OPENAI_API_KEY",
    "RAC_EMPTY_TOKEN",
  ]) {
    const field = panel.locator(`[data-settings-path=${JSON.stringify(key)}]`);
    await expect(field.getByText("Protected", { exact: true })).toHaveCount(0);
    expect(await fieldChrome(field)).toEqual(ordinaryChrome);
  }

  const masked = panel.getByLabel("RAC_SESSION_SECRET masked");
  await expect(masked).toBeVisible();
  await expect(
    panel.getByRole("button", {
      name: "Reveal RAC_SESSION_SECRET",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.saves).toHaveLength(0);
  expect(
    await masked.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        alignItems: style.alignItems,
        whiteSpace: style.whiteSpace,
        wraps: element.scrollHeight > element.clientHeight,
      };
    }),
  ).toEqual({
    display: "flex",
    alignItems: "center",
    whiteSpace: "nowrap",
    wraps: false,
  });

  const add = panel.locator(".settings-env-add");
  const addToggle = add.getByRole("button", {
    name: "Add environment variable",
    exact: true,
  });
  await expect(addToggle).toBeVisible();
  const cardStyle = await addToggle.evaluate((element) => {
    const base = getComputedStyle(element);
    const border = getComputedStyle(element, "::before");
    return {
      backgroundColor: base.backgroundColor,
      borderColor: base.borderColor,
      borderStyle: base.borderStyle,
      borderImage: border.backgroundImage,
      pointerEvents: border.pointerEvents,
    };
  });
  expect(cardStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(cardStyle.borderColor).toBe("rgba(0, 0, 0, 0)");
  expect(cardStyle.borderStyle).toBe("solid");
  expect(cardStyle.borderImage.match(/repeating-linear-gradient/gu)).toHaveLength(
    4,
  );
  expect(cardStyle.borderImage).toContain("10px");
  expect(cardStyle.borderImage).toContain("18px");
  expect(cardStyle.pointerEvents).toBe("none");
  await expect(addToggle).toHaveCSS("font-weight", "400");
  await expect(addToggle).toHaveCSS("font-size", "9.92px");
  await addToggle.click();
  await expect(add.getByText("Variable", { exact: true })).toHaveCount(0);
  const variable = add.getByPlaceholder("VARIABLE_NAME", { exact: true });
  const value = add.getByLabel("Value", { exact: true });
  const addVariable = add.getByRole("button", {
    name: "Add variable",
    exact: true,
  });
  await expect(addVariable).toBeDisabled();
  await variable.fill("SYNTHETIC_ADDED_KEY");
  await expect(addVariable).toBeDisabled();
  await value.fill("fixture-value");
  await expect(addVariable).toBeEnabled();
  const cancel = add.getByRole("button", { name: "Cancel", exact: true });
  const formGeometry = await add.evaluate((element) => {
    const form = element.querySelector(".settings-env-add-form")!;
    const variableInput = element.querySelector<HTMLInputElement>(
      'input[placeholder="VARIABLE_NAME"]',
    )!;
    const valueInput = Array.from(element.querySelectorAll("label"))
      .find((label) => label.textContent?.trim().startsWith("Value"))!
      .querySelector("input")!;
    const [cancelButton, addButton] = Array.from(
      element.querySelectorAll<HTMLButtonElement>("button"),
    );
    const formRect = form.getBoundingClientRect();
    const variableRect = variableInput.getBoundingClientRect();
    const valueRect = valueInput.getBoundingClientRect();
    const cancelRect = cancelButton!.getBoundingClientRect();
    const addRect = addButton!.getBoundingClientRect();
    const purple = document.createElement("span");
    purple.style.color = "var(--mauve)";
    element.append(purple);
    const expectedPurple = getComputedStyle(purple).color;
    purple.remove();
    return {
      variableWidth: variableRect.width,
      valueWidth: valueRect.width,
      formWidth: formRect.width,
      stacked: valueRect.top >= variableRect.bottom,
      cancelHeight: cancelRect.height,
      addHeight: addRect.height,
      cancelBackground: getComputedStyle(cancelButton!).backgroundColor,
      addBackground: getComputedStyle(addButton!).backgroundColor,
      expectedPurple,
      overflow: form.scrollWidth - form.clientWidth,
    };
  });
  expect(formGeometry.variableWidth).toBeLessThanOrEqual(240);
  expect(formGeometry.valueWidth).toBeGreaterThan(
    formGeometry.variableWidth * 1.5,
  );
  expect(formGeometry.valueWidth).toBeGreaterThanOrEqual(
    formGeometry.formWidth - 2,
  );
  expect(formGeometry.stacked).toBe(true);
  expect(formGeometry.cancelHeight).toBeLessThanOrEqual(32);
  expect(formGeometry.addHeight).toBeLessThanOrEqual(32);
  expect(formGeometry.cancelBackground).toBe("rgba(0, 0, 0, 0)");
  expect(formGeometry.addBackground).toBe(formGeometry.expectedPurple);
  expect(formGeometry.overflow).toBe(0);
  await add.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-add-expanded-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await add.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-add-expanded-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await cancel.click();
  await expect(addToggle).toBeVisible();
  await add.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-add-collapsed-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await add.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-add-collapsed-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: "Replace without revealing",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Remove source", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByLabel("Environment & keys source content", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();

  await masked.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-keys-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await masked.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-environment-keys-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await panel.getByLabel("EDITOR_COMMAND", { exact: true }).fill("");
  await panel
    .getByRole("button", {
      name: "Reveal RAC_SESSION_SECRET",
      exact: true,
    })
    .click();
  await panel.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");
  await selectSettingsSection(settings, "voice", "Voice");
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.getByLabel("RAC_SESSION_SECRET", { exact: true }),
  ).toHaveValue("");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  };
  expect(
    save.body.changes.find((change) => change.sourceId === "env")?.patches,
  ).toEqual([
    { op: "remove", path: ["EDITOR_COMMAND"] },
    { op: "remove", path: ["RAC_SESSION_SECRET"] },
  ]);
  expect(consoleErrors).toEqual([]);
});

// offer destructive controls only for saved custom assignments and revoke protected leases
test("removes custom public and protected environment assignments with title trash actions", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(page);
  const env = sources.find((source) => source.id === "env")!;
  env.fields!.push({
    key: "CUSTOM_API_KEY",
    protected: true,
    present: true,
    hasValue: true,
    apply: "rac-restart",
  });
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");

  for (const key of [
    "RAC_SESSION_SECRET",
    "RAC_HOST_PROC",
    "RAC_HOST_UID",
  ]) {
    await expect(
      settings
        .locator(`[data-settings-path=${JSON.stringify(key)}]`)
        .getByRole("button", { name: `Remove ${key}`, exact: true }),
    ).toHaveCount(0);
  }

  const publicCustom = settings.locator(
    '[data-settings-path="EDITOR_COMMAND"]',
  );
  const protectedCustom = settings.locator(
    '[data-settings-path="CUSTOM_API_KEY"]',
  );
  const publicRemove = publicCustom.getByRole("button", {
    name: "Remove EDITOR_COMMAND",
    exact: true,
  });
  const protectedRemove = protectedCustom.getByRole("button", {
    name: "Remove CUSTOM_API_KEY",
    exact: true,
  });
  for (const remove of [publicRemove, protectedRemove]) {
    await expect(remove).toBeVisible();
    await expect(remove.locator("svg path")).toHaveCount(1);
    expect(
      await remove.evaluate(
        (button) =>
          button.parentElement?.classList.contains("settings-environment-key") &&
          button.closest(".settings-field-heading") !== null,
      ),
    ).toBe(true);
  }

  await publicRemove.click();
  await protectedCustom
    .getByRole("button", { name: "Reveal CUSTOM_API_KEY", exact: true })
    .click();
  await expect(
    protectedCustom.getByLabel("CUSTOM_API_KEY", { exact: true }),
  ).toHaveValue("fixture-session-secret");
  await protectedRemove.click();
  await expect.poll(() => state.remasks.length).toBe(1);
  await expect(
    protectedCustom.getByRole("button", { name: /Reveal|Mask/u }),
  ).toHaveCount(0);
  await expect(settings).not.toContainText("fixture-session-secret");
  expect(state.saves).toHaveLength(0);

  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[] }>;
      }>;
    };
  };
  expect(
    save.body.changes.find((change) => change.sourceId === "env")?.patches,
  ).toEqual([
    { op: "remove", path: ["EDITOR_COMMAND"] },
    { op: "remove", path: ["CUSTOM_API_KEY"] },
  ]);
});

// surface successful saves through the shared transient toast stack
test("shows a transient Saved toast while restart-required status remains actionable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain browser-visible console failures as explicit evidence
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state } = await setupSettings(page);
  await settings.getByLabel("Server name", { exact: true }).fill("Toast save");
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);

  const toastRegion = page.locator("body > .toast-region");
  const saved = toastRegion
    .locator('.operation-feedback.success[role="status"]')
    .filter({ hasText: "Saved" });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("Settings updated.");
  await expect(saved).toHaveAttribute("aria-live", "polite");
  await expect(
    settings.locator(".settings-feedback").filter({ hasText: /^Saved\.?$/u }),
  ).toHaveCount(0);

  const restart = toastRegion.getByRole("status", {
    name: "Restart pending",
    exact: true,
  });
  await expect(restart).toBeVisible();
  await expect(
    restart.getByRole("button", { name: "Restart", exact: true }),
  ).toBeEnabled();
  await expect(restart).toContainText(
    "Host recovery starts automatically if RAC does not return within 3 minutes.",
  );
  await expect(restart).toContainText("Manual recovery:");
  await expect(restart).toContainText("Recovery keeps saved settings.");
  await expect(restart.locator("code")).toHaveText(
    "~/.local/bin/rac-settings-recover fixture-installation",
  );
  await page.clock.runFor(200);
  const desktopBounds = await toastRegion.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      right: innerWidth - bounds.right,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(desktopBounds.top).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.right).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.overflow).toBe(0);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-saved-toast-desktop.png",
  });

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileBounds = await toastRegion.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: innerWidth - bounds.right,
      overflow: element.scrollWidth - element.clientWidth,
      documentOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(mobileBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.right).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.overflow).toBe(0);
  expect(mobileBounds.documentOverflow).toBe(0);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-saved-toast-mobile.png",
  });

  await page.clock.fastForward(4_799);
  await expect(saved).toBeVisible();
  await page.clock.fastForward(1);
  await expect(saved).toHaveCount(0);
  await expect(restart).toBeVisible();
  await expect(
    restart.getByRole("button", { name: "Restart", exact: true }),
  ).toBeEnabled();
  expect(consoleErrors).toEqual([]);
});

// keep eye toggles inside fields and unset keys free of disclosure controls
for (const width of [390, 1440]) {
  test(`toggles credential eyes inside fields and describes every environment entry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state, sources } = await setupSettings(page);
    const env = sources.find((source) => source.id === "env")!;
    env.fields!.push({
      key: "RAC_OPENAI_API_KEY",
      protected: true,
      present: false,
      apply: "rac-restart",
    });
    env.fields!.push({
      key: "RAC_EMPTY_TOKEN",
      protected: true,
      present: true,
      hasValue: false,
      apply: "rac-restart",
    });
    env.fields!.push({
      key: "RAC_MULTILINE_SECRET",
      protected: true,
      present: true,
      hasValue: true,
      apply: "rac-restart",
    });
    env.fields!.push({
      key: "TZ",
      value: "UTC",
      protected: false,
      present: true,
      apply: "rac-restart",
    });
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "env", "Environment & keys");
    // all known and custom fields explain their purpose without exposing values
    for (const field of await settings
      .locator(".settings-env-fields > .settings-field")
      .all()) {
      await expect(
        field.locator(
          ".settings-field-copy > small:not(.settings-field-origin)",
        ),
      ).toHaveText(/\S/u);
    }
    const unset = settings.locator('[data-settings-path="RAC_OPENAI_API_KEY"]');
    await expect(
      unset.getByRole("button", { name: /Reveal|Mask/u }),
    ).toHaveCount(0);
    const empty = settings.locator('[data-settings-path="RAC_EMPTY_TOKEN"]');
    await expect(
      empty.getByRole("button", { name: /Reveal|Mask/u }),
    ).toHaveCount(0);
    await expect(empty.getByLabel("RAC_EMPTY_TOKEN", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      settings.locator(".settings-env-fields .settings-remove-button"),
    ).toHaveCount(0);
    const secret = settings.locator(
      '[data-settings-path="RAC_SESSION_SECRET"]',
    );
    const reveal = secret.getByRole("button", {
      name: "Reveal RAC_SESSION_SECRET",
      exact: true,
    });
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    await expect(reveal).toHaveText("");
    await expect(reveal.locator("svg path")).toBeVisible();
    const hiddenPath = await reveal.locator("svg path").getAttribute("d");
    // reserve the trailing field area for the eye, not a separate action row
    const placement = await reveal.evaluate((button) => {
      const field = button.closest(".settings-secret-control")!;
      const control = field.getBoundingClientRect();
      const action = button.getBoundingClientRect();
      return {
        inside:
          action.left >= control.left &&
          action.right <= control.right &&
          action.top >= control.top &&
          action.bottom <= control.bottom,
        rightGap: control.right - action.right,
        overflow: field.scrollWidth - field.clientWidth,
      };
    });
    expect(placement.inside).toBe(true);
    expect(placement.rightGap).toBeLessThanOrEqual(12);
    expect(placement.overflow).toBe(0);
    await reveal.focus();
    await page.keyboard.press("Enter");
    const mask = secret.getByRole("button", {
      name: "Mask RAC_SESSION_SECRET",
      exact: true,
    });
    await expect(mask).toHaveAttribute("aria-pressed", "true");
    await expect(mask.locator("svg path")).not.toHaveAttribute(
      "d",
      hiddenPath!,
    );
    await expect(
      secret.getByRole("textbox", { name: "RAC_SESSION_SECRET", exact: true }),
    ).toHaveValue("fixture-session-secret");
    // single-line saved values stay in a one-row input beside the eye
    const scalarRail = await mask.evaluate((button) => {
      const field = button.closest(".settings-secret-control")!;
      const inputElement = field.querySelector("input")!;
      const control = field.getBoundingClientRect();
      const input = inputElement.getBoundingClientRect();
      const eye = button.getBoundingClientRect();
      return {
        eyeWidth: eye.width,
        inputPaddingRight: Number.parseFloat(
          getComputedStyle(inputElement).paddingRight,
        ),
        inside:
          eye.right <= control.right &&
          eye.top >= control.top &&
          eye.bottom <= control.bottom,
        singleLine: field.querySelector("textarea") === null,
        overflow: field.scrollWidth - field.clientWidth,
      };
    });
    expect(scalarRail.inputPaddingRight).toBeGreaterThanOrEqual(
      scalarRail.eyeWidth,
    );
    expect(scalarRail.inside).toBe(true);
    expect(scalarRail.singleLine).toBe(true);
    expect(scalarRail.overflow).toBe(0);
    await mask.click();
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    await expect(secret.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
    await expect.poll(() => state.remasks.length).toBe(1);
    // newly typed replacements start directly in the blank field and never disclose the saved key
    await unset
      .getByLabel("RAC_OPENAI_API_KEY", { exact: true })
      .fill("synthetic-new-key");
    await unset
      .getByRole("button", { name: "Mask RAC_OPENAI_API_KEY", exact: true })
      .click();
    await expect(
      unset.getByRole("textbox", { name: "RAC_OPENAI_API_KEY", exact: true }),
    ).toHaveCount(0);
    await unset
      .getByRole("button", { name: "Reveal RAC_OPENAI_API_KEY", exact: true })
      .click();
    await expect(
      unset.getByRole("textbox", { name: "RAC_OPENAI_API_KEY", exact: true }),
    ).toHaveValue("synthetic-new-key");
    const multiline = settings.locator(
      '[data-settings-path="RAC_MULTILINE_SECRET"]',
    );
    await multiline
      .getByRole("button", {
        name: "Reveal RAC_MULTILINE_SECRET",
        exact: true,
      })
      .click();
    const multilineValue = multiline.getByRole("textbox", {
      name: "RAC_MULTILINE_SECRET",
      exact: true,
    });
    await expect(multilineValue).toHaveValue("line one\n# literal\nline three\n");
    await expect(multilineValue).toHaveJSProperty("tagName", "TEXTAREA");
    const multilineRail = await multiline.evaluate((field) => {
      const textarea = field.querySelector("textarea")!.getBoundingClientRect();
      const eye = field
        .querySelector(".settings-reveal-button")!
        .getBoundingClientRect();
      return {
        clearance: eye.left - textarea.right,
        overflow: field.scrollWidth - field.clientWidth,
      };
    });
    expect(multilineRail.clearance).toBeGreaterThanOrEqual(0);
    expect(multilineRail.overflow).toBe(0);
    expect(state.reveals).toHaveLength(2);
    expect(state.saves).toHaveLength(0);
    expect(state.validations).toHaveLength(0);
  });
}

// keep whole-file credential disclosure in the code field with no duplicate actions
test("places structured secret eyes in the code field without covering its text", async ({
  page,
}) => {
  const { settings, sources } = await setupSettings(page);
  const app = sources.find((source) => source.id === "app")!;
  app.value!.adapter.credentials = { __racProtected: true, present: true };
  app.schema!.properties!.adapter!.properties!.credentials = {
    type: "json",
    label: "Agent credentials",
    protected: true,
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const field = settings.locator('[data-settings-path="adapter.credentials"]');
  await expect(field.getByText("Protected", { exact: true })).toBeVisible();
  // retain the protected card outside environment fields
  const protectedChrome = await field.evaluate((element) => {
    // capture the visible generic protected treatment
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      paddingTop: style.paddingTop,
    };
  });
  expect(protectedChrome.borderTopWidth).not.toBe("0px");
  expect(protectedChrome.paddingTop).not.toBe("0px");
  expect(protectedChrome.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await page.route("**/api/settings/reveal", (route) =>
    route.fulfill({
      json: {
        value: { token: "synthetic-object-key" },
        revisionId: "app-r1",
        leaseId: "structured-eye-lease",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await field
    .getByRole("button", { name: "Reveal Agent credentials", exact: true })
    .click();
  const editor = field.locator(".settings-code-editor");
  const surface = editor.locator(".settings-code-editor-surface");
  const toolbar = editor.locator(".settings-code-editor-toolbar");
  const mask = toolbar
    .locator(".settings-code-editor-field-action")
    .getByRole("button", {
    name: "Mask Agent credentials",
    exact: true,
  });
  await expect(mask).toHaveAttribute("aria-pressed", "true");
  await expect(surface.locator(".settings-code-editor-field-action")).toHaveCount(0);
  const geometry = await mask.evaluate((button) => {
    const toolbar = button.closest(".settings-code-editor-toolbar")!;
    const editor = button.closest(".settings-code-editor")!;
    const frame = toolbar.getBoundingClientRect();
    const surface = editor.querySelector(".settings-code-editor-surface")!.getBoundingClientRect();
    const action = button.getBoundingClientRect();
    return {
      inside:
        action.right <= frame.right &&
        action.top >= frame.top &&
        action.bottom <= frame.bottom,
      clearsCode: surface.top - action.bottom,
      overflow: editor.scrollWidth - editor.clientWidth,
    };
  });
  expect(geometry.inside).toBe(true);
  expect(geometry.clearsCode).toBeGreaterThanOrEqual(0);
  expect(geometry.overflow).toBe(0);
  await mask.click();
  await expect(field.getByRole("textbox")).toHaveCount(0);
  await expect(
    field.getByRole("button", {
      name: "Reveal Agent credentials",
      exact: true,
    }),
  ).toBeVisible();
});

// empty-only saved JSON credentials still make authored raw drafts maskable
test("locally masks raw edits to an empty-only credential source without showing an unset eye", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(page);
  const app = sources.find((source) => source.id === "app")!;
  app.value!.adapter.credentials = {
    __racProtected: true,
    present: true,
    hasValue: false,
  };
  app.content = '{"adapter":{"credentials":""}}';
  app.hasProtectedContent = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Reveal keys", exact: true }),
  ).toHaveCount(0);
  const input = settings.getByLabel("Application config source content");
  const draft = '{"adapter":{"credentials":"synthetic-new-raw-key"}}';
  await input.fill(draft);
  await settings
    .getByRole("button", { name: "Mask keys", exact: true })
    .click();
  await expect(input).toHaveValue(app.content);
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await expect(input).toHaveValue(draft);
  expect(state.reveals).toHaveLength(0);
});

// keep whole-file credential disclosure in the code field with no duplicate actions
test("toggles source credential eyes inside code editors and hides missing-source controls", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(page);
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const code = settings
    .getByLabel("Environment & keys source content")
    .locator("..")
    .locator("..");
  const reveal = code
    .locator(".settings-code-editor-toolbar .settings-code-editor-field-action")
    .getByRole("button", { name: "Reveal keys", exact: true });
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await reveal.click();
  await expect(
    code.getByRole("button", { name: "Mask keys", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/fixture-session-secret/u);
  await code.getByRole("button", { name: "Mask keys", exact: true }).click();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).not.toHaveValue(/fixture-session-secret/u);
  // legacy wholly protected sources use the same in-field toggle before code is shown
  const compose = sources.find((source) => source.id === "compose-override")!;
  compose.content = undefined;
  compose.hasProtectedContent = true;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "compose-override", "Docker");
  await settings
    .getByRole("button", { name: "Reveal Docker", exact: true })
    .click();
  const protectedEditor = settings
    .getByLabel("Docker source content")
    .locator("..")
    .locator("..");
  await protectedEditor
    .getByRole("button", { name: "Mask keys", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: "Reveal Docker",
      exact: true,
    }),
  ).toBeVisible();
  compose.exists = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: /Reveal Docker|Reveal keys|Mask keys/u,
    }),
  ).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
  expect(state.validations).toHaveLength(0);
});

// keep the masked disclosure toolbar separate from code at phone width
test("fits masked raw source disclosure controls on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    // retain only browser failures
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const input = settings.getByLabel(
    "Environment & keys source content",
  );
  const editor = input.locator("..").locator("..");
  const disclosure = editor.locator(".settings-code-editor-field-action");
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toHaveValue(/RAC_SESSION_SECRET=\*{8}/u);
  await expect(disclosure).toContainText("Contains secrets, reveal to edit");
  await expect(
    disclosure.getByRole("button", { name: "Reveal keys", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Format", exact: true }),
  ).toBeDisabled();
  const disclosureBeforeFormat = await editor
    .locator(".settings-code-editor-toolbar")
    .evaluate((toolbar) => {
      const disclosure = toolbar.querySelector(
        ".settings-code-editor-field-action",
      );
      const format = [...toolbar.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Format"),
      );
      return (
        disclosure !== null &&
        format !== undefined &&
        Boolean(
          disclosure.compareDocumentPosition(format) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )
      );
    });
  expect(disclosureBeforeFormat).toBe(true);
  const geometry = await editor.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const action = element
      .querySelector(".settings-code-editor-field-action")!
      .getBoundingClientRect();
    return {
      actionInside:
        action.left >= frame.left &&
        action.right <= frame.right &&
        action.top >= frame.top &&
        action.bottom <= frame.bottom,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(geometry.actionInside).toBe(true);
  expect(geometry.overflow).toBe(0);
  await editor.screenshot({ path: "/tmp/remoteagents-settings-masked-mobile.png" });
  expect(state.saves).toHaveLength(0);
  expect(state.validations).toHaveLength(0);
  expect(consoleErrors).toEqual([]);
});

// validate new metadata without rejecting existing protected-value payloads
test("accepts optional boolean value-presence metadata and rejects malformed markers", () => {
  expect(isProtectedValue({ __racProtected: true, present: true })).toBe(true);
  expect(
    isProtectedValue({ __racProtected: true, present: true, hasValue: false }),
  ).toBe(true);
  expect(
    isProtectedValue({
      __racProtected: true,
      present: true,
      hasValue: "false",
    }),
  ).toBe(false);
});

// keep newly named credentials protected before their first server save
test("protects authored credential records and previews protected removal without revealing", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(page);
  const app = sources.find((source) => source.id === "app")!;
  app.value!.adapter.env = {
    SAVED_TOKEN: { __racProtected: true, present: true },
  };
  app.schema!.properties!.adapter!.properties!.env = {
    type: "record",
    label: "Agent environment",
    items: { type: "string", label: "Agent credential" },
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const record = settings.locator('[data-settings-path="adapter.env"]');
  await record.getByLabel("New key", { exact: true }).fill("NEW_TOKEN");
  await record.getByRole("button", { name: "Add entry", exact: true }).click();
  const authored = settings.locator(
    '[data-settings-path="adapter.env.NEW_TOKEN"]',
  );
  await expect(
    authored.getByRole("button", { name: /Reveal|Mask/u }),
  ).toHaveCount(0);
  await authored
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
  await authored
    .getByLabel("New Agent credential", { exact: true })
    .fill("synthetic-record-key");
  await authored
    .getByRole("button", { name: "Mask Agent credential", exact: true })
    .click();
  await expect(authored.getByRole("textbox")).toHaveCount(0);
  await authored
    .getByRole("button", { name: "Reveal Agent credential", exact: true })
    .click();
  await expect(
    authored.getByLabel("Agent credential", { exact: true }),
  ).toHaveValue("synthetic-record-key");
  const savedRow = record.getByRole("group", {
    name: "SAVED_TOKEN",
    exact: true,
  });
  await savedRow
    .getByRole("button", { name: "Edit SAVED_TOKEN", exact: true })
    .click();
  const saved = settings.locator(
    '[data-settings-path="adapter.env.SAVED_TOKEN"]',
  );
  await saved
    .getByRole("button", { name: "Remove Agent credential", exact: true })
    .click();
  await expect(saved.getByRole("button", { name: /Reveal|Mask/u })).toHaveCount(
    0,
  );
  await expect(saved.getByLabel("Agent credential masked")).toHaveText(
    "Not set",
  );
  expect(state.reveals).toHaveLength(0);
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await record
    .getByRole("group", { name: "SAVED_TOKEN", exact: true })
    .getByRole("button", { name: "Edit SAVED_TOKEN", exact: true })
    .click();
  await expect(
    saved.getByRole("button", { name: "Reveal Agent credential", exact: true }),
  ).toBeVisible();
});

// clearing a disclosed environment value revokes its lease and remains an authored removal
test("revokes active field disclosure when clearing is staged", async ({ page }) => {
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "env", "Environment & keys");
  const field = settings.locator('[data-settings-path="RAC_SESSION_SECRET"]');
  await field
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await field.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");
  await expect.poll(() => state.remasks.length).toBe(1);
  await expect(field.getByLabel("RAC_SESSION_SECRET", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    field.getByRole("button", { name: /Reveal|Mask/u }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (state.saves[0] as { body: { changes: unknown[] } }).body.changes,
  ).toEqual([
    {
      sourceId: "env",
      revisionId: "env-r1",
      patches: [{ op: "remove", path: ["RAC_SESSION_SECRET"] }],
    },
  ]);
});

// preserve an active Mask action until an empty disclosed edit is explicitly hidden
test("retains masking for cleared disclosed keys and safely handles failed lease revocation", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await settings.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");
  const mask = settings.getByRole("button", {
    name: "Mask RAC_SESSION_SECRET",
    exact: true,
  });
  await expect(mask).toHaveAttribute("aria-pressed", "true");
  await page.route("**/api/settings/remask", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "private host diagnostic that must not display" },
    }),
  );
  await mask.click();
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(settings.getByRole("alert")).toHaveText(
    "Value hidden locally, but its server disclosure could not be revoked.",
  );
  await expect(settings).not.toContainText("private host diagnostic");
  expect(errors).toEqual([]);
});

// keep icon artwork editable in context rather than adding source navigation tabs
test("masks authored source drafts locally without discarding or fetching saved bytes", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "protected",
  );
  const wrapper = sources.find((source) => source.id === "wrapper")!;
  wrapper.content = undefined;
  wrapper.hasProtectedContent = true;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "tmux", "TMUX");
  await settings
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
  const input = settings.getByLabel("Installation wrapper source content");
  const draft =
    "EDITOR_COMMAND=local-editor\nRAC_SESSION_SECRET=synthetic-authored-secret\n";
  await input.fill(draft);
  await settings
    .getByRole("button", { name: "Mask keys", exact: true })
    .click();
  await expect(input).not.toHaveValue(/synthetic-authored-secret/u);
  await expect(input).toHaveAttribute("readonly", "");
  await expect(
    settings.getByText(/Unsaved protected source draft is masked/u),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await expect(input).toHaveValue(draft);
  await expect(input).not.toHaveAttribute("readonly");
  // navigation and pagehide remask local drafts while retaining the pending save
  await selectSettingsSection(settings, "voice", "Voice");
  await selectSettingsSection(settings, "tmux", "TMUX");
  await expect(input).not.toHaveValue(/synthetic-authored-secret/u);
  await settings
    .getByRole("button", { name: "Reveal keys", exact: true })
    .click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(input).not.toHaveValue(/synthetic-authored-secret/u);
  expect(state.reveals).toHaveLength(0);
  expect(state.remasks).toHaveLength(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (state.saves[0] as { body: { changes: unknown[] } }).body.changes,
  ).toEqual([
    { sourceId: "wrapper", revisionId: "wrapper-r1", content: draft },
  ]);
});

// one mask must hide independently authored values even after a late saved disclosure
for (const raw of [false, true]) {
  test(`masks an authored ${raw ? "source" : "field"} after a delayed reveal with one click`, async ({
    page,
  }) => {
    const { settings, state, sources } = await setupSettings(
      page,
      true,
      false,
      false,
      [],
      raw ? "protected" : "none",
    );
    // generic protected fields and whole-file replacement share the same late-lease boundary
    if (raw) {
      const wrapper = sources.find((source) => source.id === "wrapper")!;
      wrapper.content = undefined;
      wrapper.hasProtectedContent = true;
    } else {
      const app = sources.find((source) => source.id === "app")!;
      app.value!.credential = {
        __racProtected: true,
        present: true,
        hasValue: true,
      };
      app.schema!.properties!.credential = {
        type: "string",
        label: "Credential",
        protected: true,
      };
    }
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(
      settings,
      raw ? "tmux" : "app",
      raw ? "TMUX" : "Application config",
    );
    // hold exactly one server lease while the operator authors a replacement
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let requests = 0;
    await page.route("**/api/settings/reveal", async (route) => {
      requests += 1;
      await held;
      await route.fulfill({
        json: {
          value: raw
            ? "RAC_SESSION_SECRET=synthetic-old-key\n"
            : "synthetic-old-key",
          revisionId: raw ? "wrapper-r1" : "app-r1",
          leaseId: "late-authoring-lease",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    });
    await settings
      .getByRole("button", {
        name: raw
          ? "Reveal Installation wrapper"
          : "Reveal Credential",
        exact: true,
      })
      .click();
    await expect.poll(() => requests).toBe(1);
    const draft = raw
      ? "RAC_SESSION_SECRET=synthetic-independent-draft\n"
      : "synthetic-independent-draft";
    // author independently while the saved disclosure is still pending
    await settings
      .getByRole("button", { name: "Replace without revealing", exact: true })
      .click();
    await settings
      .getByLabel(
        raw
          ? "Installation wrapper source content"
          : "New Credential",
        { exact: true },
      )
      .fill(draft);
    finish();
    const mask = settings.getByRole("button", {
      name: raw ? "Mask keys" : "Mask Credential",
      exact: true,
    });
    await expect
      .poll(() =>
        settings
          .getByRole("button", {
            name: raw ? "Mask keys" : "Mask Credential",
            exact: true,
          })
          .getAttribute("aria-pressed"),
      )
      .toBe("true");
    // wait for the lease to settle so the regression exercises the actual race
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.endsWith("/api/settings/reveal"))
              .length,
        ),
      )
      .toBe(1);
    await mask.click();
    await expect.poll(() => state.remasks.length).toBe(1);
    await expect(
      settings.getByRole("button", {
        name: raw ? "Reveal keys" : "Reveal Credential",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    await settings
      .getByRole("button", {
        name: raw ? "Reveal keys" : "Reveal Credential",
        exact: true,
      })
      .click();
    await expect(
      settings.getByLabel(
        raw
          ? "Installation wrapper source content"
          : "Credential",
        { exact: true },
      ),
    ).toHaveValue(draft);
    expect(requests).toBe(1);
    expect(state.saves).toHaveLength(0);
  });
}

// keep icon artwork editable in context rather than adding source navigation tabs
test("edits and previews icon files beside their use with image-bearing custom dropdowns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, state } = await setupSettings(page, false, true);
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await expect(settings.locator("select")).toHaveCount(0, { timeout: 3_000 });
  await selector.click();
  const menu = page.getByRole("listbox", {
    name: "Settings section options",
    exact: true,
  });
  await expect(menu.getByRole("option")).toHaveCount(9);
  await expect(
    menu.getByRole("option", { name: /Heart icon|Potato icon/u }),
  ).toHaveCount(0);
  // show a painted glyph in every section choice
  for (const option of await menu.getByRole("option").all())
    await expect(option.locator("svg, img")).not.toHaveCount(0);
  await menu
    .getByRole("option", { name: "Application config", exact: true })
    .click();
  const icon = settings.getByRole("combobox", {
    name: "Server icon",
    exact: true,
  });
  await icon.click();
  const icons = page.getByRole("listbox", {
    name: "Server icon options",
    exact: true,
  });
  await expect(icons.getByRole("option")).toHaveCount(3);
  // preview actual choices without treating a menu highlight as a save
  for (const option of await icons.getByRole("option").all())
    await expect(option.locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeVisible();
  await expect(icon).toHaveAttribute("data-value", "heart");
  await settings.getByText("View / edit Heart icon", { exact: true }).click();
  const svg = settings.getByRole("textbox", {
    name: "Heart icon source content",
    exact: true,
  });
  await expect(svg).toHaveValue(/M0 0h10/u);
  const changed =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>\n';
  await svg.fill(changed);
  await expect(
    settings
      .getByRole("img", { name: "Heart icon preview", exact: true })
      .first(),
  ).toHaveAttribute(
    "src",
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(changed)}`,
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = state.saves[0] as {
    body: { changes: Array<{ sourceId: string; content: string }> };
  };
  expect(saved.body.changes).toEqual([
    { sourceId: "icon-heart", revisionId: "heart-r1", content: changed },
  ]);
  expect(state.status.pending).toBe(false);
  expect(state.restarts).toBe(0);
});

// retain source capabilities and revision handling inside contextual editors
test("creates missing artwork and saves it with an explicitly changed server icon", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, true, true);
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    nav.getByRole("button", { name: /Heart icon|Potato icon/u }),
  ).toHaveCount(0);
  await settings.getByText("View / edit Potato icon", { exact: true }).click();
  await settings
    .getByRole("button", { name: "Create source", exact: true })
    .click();
  const input = settings.getByRole("textbox", {
    name: "Potato icon source content",
    exact: true,
  });
  const content =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>\n';
  await input.fill(content);
  await chooseSettingsOption(
    settings.getByRole("combobox", { name: "Server icon", exact: true }),
    "potato",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = state.saves[0] as { body: { changes: unknown[] } };
  expect(saved.body.changes).toEqual(
    expect.arrayContaining([
      { sourceId: "icon-potato", revisionId: "potato-r1", content },
      {
        sourceId: "app",
        revisionId: "app-r1",
        patches: [{ op: "set", path: ["icon"], value: "potato" }],
      },
    ]),
  );
  expect(saved.body.changes).toHaveLength(2);
  expect(state.status.pending).toBe(true);
  expect(state.restarts).toBe(0);
});

// keep untrusted draft markup out of active documents and external requests
test("keeps unsafe SVG drafts inert and respects read-only contextual source controls", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(page, true, true);
  let externalRequests = 0;
  // trap any attempt to resolve draft resource references
  await page.route(
    "https://icon-preview-should-not-load.invalid/**",
    (route) => {
      externalRequests += 1;
      return route.abort();
    },
  );
  await settings.getByText("View / edit Heart icon", { exact: true }).click();
  const input = settings.getByRole("textbox", {
    name: "Heart icon source content",
    exact: true,
  });
  const unsafe =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.iconDraftExecuted=true</script><image href="https://icon-preview-should-not-load.invalid/image.png"/></svg>';
  await input.fill(unsafe);
  await expect(
    settings.locator(".settings-icon-preview-unavailable"),
  ).not.toHaveCount(0);
  await expect(input).toHaveValue(unsafe);
  expect(
    await page.evaluate(() => Reflect.get(window, "iconDraftExecuted")),
  ).toBeUndefined();
  expect(externalRequests).toBe(0);
  expect(state.saves).toEqual([]);

  // refresh a read-only capability without allowing source mutation
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  const heart = sources.find((source) => source.id === "icon-heart");
  heart!.writable = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(input).toBeDisabled();
  const artwork = settings
    .locator(".settings-icon-source")
    .filter({ hasText: "View / edit Heart icon" });
  await expect(
    artwork.getByRole("button", { name: "Format", exact: true }),
  ).toBeDisabled();
  await expect(
    artwork.getByRole("button", { name: "Remove Heart icon", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// replace the tab strip throughout the existing mobile breakpoint
for (const width of [390, 780]) {
  test(`uses a grouped settings dropdown at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { settings, state } = await setupSettings(page, false);
    const selector = settings.getByRole("combobox", {
      name: "Settings section",
      exact: true,
    });
    await expect(selector).toBeVisible({ timeout: 3_000 });
    await expect(selector).toHaveAttribute("data-value", "browser");
    await expect(
      settings.getByRole("navigation", { name: "Settings sources" }),
    ).toHaveCount(0);
    await expectSettingsOptions(selector, 9, 5);
    // keep virtual Application sections together in the mobile group
    await selector.click();
    const application = page
      .getByRole("listbox", {
        name: "Settings section options",
        exact: true,
      })
      .getByRole("group", { name: "Application", exact: true });
    await expect(application.getByRole("option")).toHaveCount(3);
    await expect(
      application.getByRole("option", {
        name: "Application config",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Projects", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "TMUX", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await chooseSettingsOption(selector, "tmux");
    await expect(
      settings.getByRole("heading", { name: "TMUX", exact: true }),
    ).toBeVisible();
    await expect(
      settings.locator('[data-settings-path="tmux.pollIntervalMs"]'),
    ).toBeVisible();
    expect(
      await settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await settings.screenshot({
      path:
        width === 390
          ? "/tmp/remoteagents-settings-tmux-mobile.png"
          : "/tmp/remoteagents-settings-tmux-narrow.png",
    });
    await chooseSettingsOption(selector, "voice");
    await expect(
      settings.getByRole("heading", { name: "Voice", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("switch", { name: "Enable Davo" }),
    ).toBeVisible();
    expect(state.saves).toEqual([]);
    expect(state.voiceSaves).toEqual([]);
  });
}

// keep draft ownership and disclosure security identical across navigation layouts
test("preserves mobile section selection, drafts and remasking through search and desktop resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, state } = await setupSettings(page, false);
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await expect(selector).toBeVisible({ timeout: 3_000 });
  await chooseSettingsOption(selector, "app");
  await settings.getByLabel("Server name").fill("Mobile draft");
  await expect(selector.locator(".settings-select-current-label")).toHaveText(
    "Application config · Unsaved changes",
  );
  await chooseSettingsOption(selector, "env");
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await settings
    .getByLabel("RAC_SESSION_SECRET", { exact: true })
    .fill("disclosed-draft");
  await chooseSettingsOption(selector, "app");
  await expect(settings.getByLabel("Server name")).toHaveValue("Mobile draft");
  await expect.poll(() => state.remasks.length).toBe(1);
  await chooseSettingsOption(selector, "env");
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(settings).not.toContainText("disclosed-draft");
  await chooseSettingsOption(selector, "app");

  // a filtered-out selection must not falsely display another section
  await search.fill("keyboard");
  await expect(selector).toHaveAttribute("data-value", "app");
  await expect(
    selector.locator(".settings-select-current-label"),
  ).toContainText("outside search results");
  await expectSettingsOptions(selector, 2);
  await search.fill("no-matching-section");
  await expect(selector).toHaveAttribute("data-value", "app");
  await expect(
    settings.getByText("No matching sections.", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByLabel("Server name")).toHaveValue("Mobile draft");
  await search.fill("");
  await expectSettingsOptions(selector, 9);

  // crossing the breakpoint changes only the navigation presentation
  await page.setViewportSize({ width: 781, height: 844 });
  await expect(selector).toHaveCount(0);
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    nav.getByRole("button", { name: /^Application config/u }),
  ).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Voice", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selector).toHaveAttribute("data-value", "voice");
  await chooseSettingsOption(selector, "app");
  await expect(settings.getByLabel("Server name")).toHaveValue("Mobile draft");
  expect(state.saves).toEqual([]);
  expect(state.validations).toEqual([]);
  expect(state.voiceSaves).toEqual([]);
});

// keep browser preferences and file-backed edits in the same workspace
test("merges browser controls and saves voice with file edits through one transaction", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const { state, settings } = await setupSettings(page, false);
  const center = settings.locator(".settings-center");
  const nav = center.getByRole("navigation", { name: "Settings sources" });
  const panel = center.locator(".settings-source-panel");
  await expect(
    nav.getByRole("button", { name: "This browser", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    panel.getByRole("button", { name: "Rename browser name" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("group", { name: "Terminal font", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("switch", { name: "Reduced motion" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("switch", { name: "Flyout markers" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("switch", { name: "Dynamic worktrees" }),
  ).toBeVisible();
  await expect(
    settings.locator(
      ".client-settings-page-content > .client-settings-console",
    ),
  ).toHaveCount(0);
  await expect(
    settings.locator(".client-settings-page-content > .client-settings-davo"),
  ).toHaveCount(0);
  await panel.getByRole("radio", { name: "Light theme" }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("rac.color-theme")),
  ).toBeNull();
  expect(state.saves).toHaveLength(0);

  // search the browser preferences through the same source navigation
  await center
    .getByRole("searchbox", { name: "Search settings" })
    .fill("theme");
  await expect(
    nav.getByRole("button", { name: /^This browser.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Voice", exact: true }),
  ).toHaveCount(0);
  await center.getByRole("searchbox", { name: "Search settings" }).fill("");

  // retain ordinary file drafts while remasking disclosures on section changes
  await nav.getByRole("button", { name: /^Application config/u }).click();
  await panel.getByLabel("Server name").fill("Framework Draft");
  await nav
    .getByRole("button", { name: "Environment & keys", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await expect(
    panel.locator('textarea[aria-label="RAC_SESSION_SECRET"]'),
  ).toHaveValue("fixture-session-secret");
  await nav
    .getByRole("button", { name: /^This browser.*Unsaved changes$/u })
    .click();
  await expect(center).not.toContainText("fixture-session-secret");
  await expect.poll(() => state.remasks.length).toBeGreaterThan(0);
  await expect(
    panel.getByRole("radio", { name: "Light theme" }),
  ).toHaveAttribute("aria-checked", "true");
  await nav.getByRole("button", { name: /^Application config/u }).click();
  await expect(panel.getByLabel("Server name")).toHaveValue("Framework Draft");

  // leave dedicated server, launcher and voice controls out of application fields
  await expect(panel.locator('[data-settings-path="name"]')).toHaveCount(0);
  await expect(
    panel.locator('[data-settings-path="defaultAgent"]'),
  ).toHaveCount(0);
  await expect(
    panel.locator('[data-settings-path^="integrations.realtime"]'),
  ).toHaveCount(0);

  // commit voice and file drafts together through the sole save action
  await nav.getByRole("button", { name: "Voice", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Rename browser name" }),
  ).toHaveCount(0);
  await panel.getByRole("switch", { name: "Enable Davo" }).check();
  expect(state.voiceSaves).toHaveLength(0);
  await panel.getByLabel("Davo name").fill("Riley");
  await panel.getByLabel("Davo context").fill("Speak briefly.");
  await expect(
    panel.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(1);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  // wait for the browser participant to finish after file persistence
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rac.color-theme")))
    .toBe("latte");
  expect(state.voiceSaves).toHaveLength(0);
  const transaction = state.saves[0] as {
    body: { changes: Array<{ sourceId: string; patches: unknown[] }> };
  };
  expect(transaction.body.changes).toHaveLength(1);
  expect(transaction.body.changes[0]?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["identity", "name"],
        value: "Framework Draft",
        revisionId: "identity-name-r1",
      },
      { op: "set", path: ["integrations", "realtime", "enabled"], value: true },
      { op: "set", path: ["integrations", "realtime", "name"], value: "Riley" },
      {
        op: "set",
        path: ["integrations", "realtime", "context"],
        value: "Speak briefly.",
      },
    ]),
  );
  expect(state.restarts).toBe(0);
  await nav.getByRole("button", { name: /^Application config/u }).click();
  await expect(panel.getByLabel("Server name")).toHaveValue("Framework Draft");
});

// route restart-bound voice flags only through the dedicated voice tab
test("edits advanced voice settings once through the voice tab", async ({
  page,
}) => {
  const { state, settings } = await setupSettings(page);
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    settings.locator('[data-settings-path^="integrations.realtime"]'),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Voice", exact: true }).click();
  const advanced = settings.locator(
    '[data-settings-path="integrations.realtime.writeToolsEnabled"]',
  );
  await expect(advanced).toHaveCount(1);
  await advanced.getByRole("switch").check();
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: { changes: Array<{ sourceId: string; patches?: unknown[] }> };
  };
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({
    op: "set",
    path: ["integrations", "realtime", "writeToolsEnabled"],
    value: true,
  });
  expect(state.voiceSaves).toEqual([]);
});

// leave existing preferences usable when installation metadata cannot load
test("keeps browser and voice settings available when the file catalog fails", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const { settings } = await setupSettings(page, false);
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 503, json: { error: "Settings unavailable" } }),
  );
  await page.reload();
  // restored split visibility must not turn the persistent toggle into a close
  await expect(settings).toBeVisible();
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    settings.getByText(
      "Installation files are unavailable. Browser settings remain available; voice settings are read-only.",
    ),
  ).toBeVisible();
  await settings.getByRole("radio", { name: "Light theme" }).click();
  await expect(
    settings.getByRole("radio", { name: "Light theme" }),
  ).toHaveAttribute("aria-checked", "true");
  await nav.getByRole("button", { name: "Voice", exact: true }).click();
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(1);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  // wait for the browser participant to finish after file persistence
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rac.color-theme")))
    .toBe("latte");
  await expect(
    page
      .locator('body > .toast-region .operation-feedback.success[role="status"]')
      .filter({ hasText: "Saved" }),
  ).toContainText("Browser preferences applied.");
  await expect(settings.getByText("Saved.", { exact: true })).toHaveCount(0);

  // keep preference sections selectable on phones without installation metadata
  await page.setViewportSize({ width: 390, height: 844 });
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await expect(selector).toHaveAttribute("data-value", "voice");
  await expectSettingsOptions(selector, 11);
  await selector.click();
  const options = page.getByRole("listbox", {
    name: "Settings section options",
  });
  // failed file placeholders stay unavailable without a loading claim
  for (const source of settingsSourcePlaceholders) {
    const option = options.locator(
      `[role="option"][data-value=${JSON.stringify(source.id)}]`,
    );
    await expect(option).toHaveAttribute("aria-disabled", "true");
    await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await chooseSettingsOption(selector, "browser");
  await expect(
    settings.getByRole("group", { name: "Terminal font", exact: true }),
  ).toBeVisible();
});

// reopen settings through a same-document link after a reconnect
test("opens settings from hash navigation and preserves the destination on reload", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
  await page.goto("/#settings");
  await expect(settings).toBeVisible();
  await page.reload();
  await expect(
    settings.getByRole("searchbox", { name: "Search settings", exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL(/\/$/u);
});

// keep the complete desktop editor inside its visible panel
test("fits the source editor in the desktop settings panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { settings } = await setupSettings(page);
  const metrics = await settings
    .locator(".settings-source-panel")
    .evaluate((panel) => ({
      visible: panel.clientWidth,
      content: panel.scrollWidth,
    }));
  expect(metrics.visible).toBeGreaterThan(600);
  expect(metrics.content).toBeLessThanOrEqual(metrics.visible);
  const center = await settings
    .locator(".settings-center")
    .evaluate((element) => ({
      visible: element.clientWidth,
      content: element.scrollWidth,
    }));
  expect(center.content).toBeLessThanOrEqual(center.visible);
});

// keep short Settings views fixed while only the selected tab content scrolls
test("owns settings scrolling inside the active source panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  const { settings } = await setupSettings(page);
  const outer = settings.locator(".client-settings-page-content");
  const panel = settings.locator(".settings-source-panel");
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const scrolling = await settings.evaluate((element) => {
    const outer = element.querySelector<HTMLElement>(
      ".client-settings-page-content",
    )!;
    const panel = element.querySelector<HTMLElement>(".settings-source-panel")!;
    return {
      document: document.scrollingElement?.scrollTop ?? 0,
      outer: outer.scrollTop,
      panel: panel.scrollTop,
      panelScrollable: panel.scrollHeight > panel.clientHeight,
      panelOverflow: getComputedStyle(panel).overflowY,
    };
  });
  expect(scrolling).toEqual({
    document: 0,
    outer: 0,
    panel: expect.any(Number),
    panelScrollable: true,
    panelOverflow: "auto",
  });
  expect(scrolling.panel).toBeGreaterThan(0);
  await expect(outer).toBeVisible();

  // keep keyboard scrolling scoped to the named active-tab region
  await panel.evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await outer.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
});

for (const layout of [
  { name: "mobile", width: 390 },
  { name: "narrow desktop", width: 900 },
  { name: "desktop", width: 1440 },
] as const) {
  test(`keeps ${layout.name} settings chrome fixed during active-tab scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: layout.width, height: 520 });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      // retain only browser failures
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const { settings, state } = await setupSettings(page);
    const outer = settings.locator(".client-settings-page-content");
    const panel = settings.locator(".settings-source-panel");
    const header = settings.locator(".settings-center-header");
    const search = settings.getByRole("searchbox", { name: "Search settings" });
    const navigation =
      layout.width <= 780
        ? settings.locator(".settings-source-select")
        : settings.getByRole("navigation", { name: "Settings sources" });
    const before = await Promise.all(
      [header, search, navigation].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );

    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const after = await Promise.all(
      [header, search, navigation].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );
    expect(after).toEqual(before);
    expect(await outer.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);

    // excess wheel input stays contained by the already-ended active panel
    await panel.hover();
    await page.mouse.wheel(0, 2_000);
    expect(await outer.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-inner-scroll-${layout.name.replace(" ", "-")}.png`,
    });

    // the vertical desktop sidebar scrolls independently only when clipped
    if (layout.name === "desktop") {
      const sidebar = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      const sidebarScrollable = await sidebar.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      );
      await sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await sidebar.evaluate((element) => element.scrollTop > 0)).toBe(
        sidebarScrollable,
      );
      expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }
    expect(state.reveals).toHaveLength(0);
    expect(state.remasks).toHaveLength(0);
    expect(state.saves).toHaveLength(0);
    expect(state.validations).toHaveLength(0);
    expect(consoleErrors).toEqual([]);
  });
}

// every preference and file section reuses one bounded panel and starts at its top
test("resets shared active-tab scrolling without losing drafts or leaking secrets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 520 });
  const { settings, state } = await setupSettings(page, false, false, true);
  const panel = settings.locator(".settings-source-panel");
  const sectionChecks = [
    {
      id: "browser",
      label: "This browser",
      visible: panel.getByRole("group", { name: "Terminal font", exact: true }),
    },
    {
      id: "voice",
      label: "Voice",
      visible: panel.getByRole("heading", { name: "Voice", exact: true }),
    },
    {
      id: "keyboard",
      label: "Keyboard shortcuts",
      visible: panel.getByRole("button", {
        name: "View active shortcuts",
        exact: true,
      }),
    },
    {
      id: "app",
      label: "Application config",
      visible: panel.getByLabel("Server name", { exact: true }),
    },
  ];

  for (const section of sectionChecks) {
    await selectSettingsSection(settings, section.id, section.label);
    await expect(section.visible).toBeVisible();
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
    await panel.evaluate((element) => {
      element.scrollTop = Math.min(120, element.scrollHeight - element.clientHeight);
    });
  }
  await panel.getByLabel("Server name", { exact: true }).fill("Scroll draft");
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await selectSettingsSection(settings, "browser", "This browser");
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
  await selectSettingsSection(settings, "app", "Application config");
  await expect(panel.getByLabel("Server name", { exact: true })).toHaveValue(
    "Scroll draft",
  );
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
  expect(state.reveals).toHaveLength(0);
  expect(state.remasks).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
  expect(state.validations).toHaveLength(0);
});

// round-trip every source while keeping protected disclosures scoped
test("edits every source class without leaking masked values and keeps restart pending globally", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { state, settings } = await setupSettings(page);
  state.migrationRequiredSourceIds = ["installation", "compose-override"];
  const sourceNav = settings.getByRole("navigation", {
    name: "Settings sources",
  });

  // protected environment values start masked and disclose only on demand
  await sourceNav
    .getByRole("button", { name: "Environment & keys" })
    .click();
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toHaveText(
    "••••••••",
  );
  await expect(settings).not.toContainText("fixture-session-secret");
  await expect(
    settings.locator('[data-settings-path="RAC_PORT"]'),
  ).toContainText("Winning source: Compose environment");
  await expect(settings.getByText(/Overridden by:/u).first()).toBeVisible();
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await expect.poll(() => state.reveals.length).toBe(1);
  await expect(
    settings.locator('input[aria-label="RAC_SESSION_SECRET"]'),
  ).toHaveValue("fixture-session-secret");
  await settings
    .getByRole("button", { name: "Mask RAC_SESSION_SECRET", exact: true })
    .click();
  await expect(settings).not.toContainText("fixture-session-secret");

  // the whole-env repair escape hatch discards disclosed bytes when masked
  await settings.getByRole("button", { name: "Edit whole source" }).click();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/EDITOR_COMMAND=code --wait/u);
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveAttribute("readonly", "");
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/RAC_SESSION_SECRET=\*{8}/u);
  await settings.getByRole("button", { name: "Reveal keys" }).click();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/RAC_SESSION_SECRET=fixture-session-secret/u);
  await settings
    .getByLabel("Environment & keys source content")
    .fill("RAC_PORT=9999\nRAC_SESSION_SECRET=fixture-session-secret\n");
  await settings.getByRole("button", { name: "Mask keys" }).click();
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).toHaveValue(/RAC_SESSION_SECRET=\*{8}/u);
  await expect(
    settings.getByLabel("Environment & keys source content"),
  ).not.toHaveValue(/fixture-session-secret/u);
  await settings.getByRole("button", { name: "Use structured editor" }).click();
  await settings
    .getByRole("button", {
      name: "Reveal RAC_SESSION_SECRET",
      exact: true,
    })
    .click();
  await settings
    .getByLabel("RAC_SESSION_SECRET", { exact: true })
    .fill("");

  // nested collections remain typed and emit explicit reorder patches
  await sourceNav.getByRole("button", { name: "Application config" }).click();
  await settings.getByLabel("Server name").fill("Framework Next");
  const args = settings.locator('[data-settings-path="adapter.args"]');
  await expect(settings.getByLabel("Shell command")).toHaveValue(
    "/usr/bin/codex",
  );
  await expect(
    args.getByRole("button", { name: "Reveal Arguments", exact: true }),
  ).toHaveCount(0);
  await args.getByRole("button", { name: /^Edit Argument \d+$/u }).click();
  await args.getByRole("textbox").fill("--replacement-flag");
  await sourceNav.getByRole("button", { name: "Projects" }).click();
  await settings.getByRole("button", { name: "Move Projects 2 up" }).click();
  await settings
    .getByRole("group", { name: /^Project \d+$/u })
    .first()
    .getByRole("button", { name: /^Edit Project \d+$/u })
    .click();
  const projectLabels = settings.locator(
    '[data-settings-path^="projects."][data-settings-path$=".label"] input',
  );
  await expect(projectLabels.first()).toHaveValue("Beacon");
  await settings.getByRole("button", { name: "Remove Projects 2" }).click();
  await settings.getByRole("button", { name: "Confirm remove" }).click();

  // path migrations remain ordinary inline drafts until Save asks
  await stageInstallationWholeSource(
    settings,
    "/checkout/config/runtime.env",
  );
  await expect(settings.locator(".settings-migration")).toHaveCount(0);

  // advanced sources name their execution trust and tracked-file risk
  await sourceNav.getByRole("button", { name: "Docker" }).click();
  await expect(
    settings.getByText("Trusted code", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByText("Tracked file", { exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByLabel("Docker source content"),
  ).toHaveValue(/RAC_PORT: 8787/u);
  await expect(
    settings.getByRole("button", { name: "Reveal keys" }),
  ).toHaveCount(0);
  await settings
    .getByLabel("Docker source content")
    .fill(
      "services:\n  remote-agent-console:\n    environment:\n      RAC_CONFIG: /workspace/config/next.json\n      RAC_CONFIG_WRITE_PATH: /workspace/config/next.json\n",
    );
  await expect(settings.locator(".settings-migration")).toHaveCount(0);

  // saving validates, collects every required handover, then persists once
  await settings.getByRole("button", { name: "Save changes" }).click();
  const handover = page.getByRole("alertdialog", {
    name: "Choose source handover",
    exact: true,
  });
  await handover
    .getByRole("group", { name: "Installation", exact: true })
    .getByRole("radio", { name: "Copy current", exact: true })
    .check();
  await handover
    .getByRole("group", { name: "Docker", exact: true })
    .getByRole("radio", { name: "Copy current", exact: true })
    .check();
  await handover
    .getByRole("button", { name: "Continue and save", exact: true })
    .click();
  await expect(
    page
      .locator('body > .toast-region .operation-feedback.success[role="status"]')
      .filter({ hasText: "Saved" }),
  ).toContainText("Settings updated.");
  await expect(settings.getByText("Saved.", { exact: true })).toHaveCount(0);
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{
          op: string;
          path: string[];
          value?: unknown;
          from?: number;
          to?: number;
          revisionId?: string;
        }>;
        migration?: { mode: string };
      }>;
    };
    csrf: string;
  };
  expect(save.csrf).toBe("settings-csrf");
  expect(
    save.body.changes.find((change) => change.sourceId === "env")?.patches,
  ).toContainEqual({ op: "remove", path: ["RAC_SESSION_SECRET"] });
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({ op: "move", path: ["projects"], from: 1, to: 0 });
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({ op: "remove", path: ["projects", "1"] });
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({
    op: "set",
    path: ["identity", "name"],
    value: "Framework Next",
    revisionId: "identity-name-r1",
  });
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({
    op: "set",
    path: ["adapter", "args", "0"],
    value: "--replacement-flag",
  });
  expect(
    save.body.changes.find((change) => change.sourceId === "installation")
      ?.migration,
  ).toEqual({ mode: "copy" });
  expect(
    save.body.changes.find((change) => change.sourceId === "compose-override")
      ?.migration,
  ).toEqual({ mode: "copy" });
  expect(JSON.stringify(save.body)).not.toContain("fixture-session-secret");
  expect(state.validations).toHaveLength(2);

  const notice = page.getByRole("status", { name: "Restart pending" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button")).toHaveText("Restart");
  await expect(
    notice.getByRole("button", { name: /dismiss|close/iu }),
  ).toHaveCount(0);
  await expect(notice).toContainText(
    "Host recovery starts automatically if RAC does not return within 3 minutes.",
  );
  await expect(notice).toContainText("Manual recovery:");
  await expect(notice).toContainText("Recovery keeps saved settings.");
  await expect(notice.locator("code")).toHaveText(
    "~/.local/bin/rac-settings-recover fixture-installation",
  );
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(notice).toBeVisible();

  // the server-backed notice survives a reload and starts only the fixed restart route
  await page.reload();
  await expect(
    page.getByRole("status", { name: "Restart pending" }),
  ).toBeVisible();
  await page
    .getByRole("status", { name: "Restart pending" })
    .getByRole("button", { name: "Restart", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Restart pending" }),
  ).toContainText("Waiting for the host applier");
  expect(state.restarts).toBe(1);

  // protected plaintext never enters browser persistence or navigation state
  expect(
    await page.evaluate(
      () =>
        `${localStorage.getItem("fixture-session-secret") ?? ""}${sessionStorage.getItem("fixture-session-secret") ?? ""}${location.href}`,
    ),
  ).not.toContain("fixture-session-secret");
  expect(errors).toEqual([]);
});

// retain custom keyboard navigation without introducing horizontal overflow
test("keeps the settings center keyboard reachable without horizontal page overflow on phones", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  await page.setViewportSize({ width: 320, height: 640 });
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  await selector.focus();
  await expect(selector).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(selector).toHaveAttribute("data-value", "env");
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  const metrics = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
});

// keep compact collection actions painted independently of font glyphs or first-letter support
for (const width of [390, 1440]) {
  test(`renders usable collection action icons at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupSettings(page);
    await selectSettingsSection(settings, "projects", "Projects");
    const projects = settings.locator('[data-settings-path="projects"]');
    const actions = projects.locator(".settings-array-actions button");
    await expect(actions).toHaveCount(8);
    // verify both enabled and disabled actions retain a visible SVG glyph
    for (const action of await actions.all()) {
      await expect(action.locator("svg")).toHaveCount(1);
      const painted = await action.locator("svg").evaluate((icon) => {
        const rect = icon.getBoundingClientRect();
        const style = getComputedStyle(icon);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.stroke !== "none" &&
          Number.parseFloat(style.strokeWidth) > 0
        );
      });
      expect(painted).toBe(true);
      await expect(action).toHaveAttribute("aria-label", /.+/u);
    }
    await expect(
      settings.getByRole("button", { name: "Move Projects 1 up" }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("button", { name: "Move Projects 2 down" }),
    ).toBeDisabled();

    // retain reorder and removal confirmation without persisting any files
    await settings.getByRole("button", { name: "Move Projects 2 up" }).click();
    await settings
      .getByRole("group", { name: /^Project \d+$/u })
      .first()
      .getByRole("button", { name: /^Edit Project \d+$/u })
      .click();
    await expect(
      settings.locator('[data-settings-path="projects.0.label"] input'),
    ).toHaveValue("Beacon");
    await settings.getByRole("button", { name: "Remove Projects 1" }).click();
    await expect(
      settings.getByRole("alertdialog", { name: /^Remove Project \d+$/u }),
    ).toBeVisible();
    await settings.getByRole("button", { name: "Keep Project" }).click();
    await expect(actions).toHaveCount(8);
    expect(state.saves).toEqual([]);
    expect(state.validations).toEqual([]);
  });
}

// preserve recovered file sections alongside newer shortcut controls on phones
test("shows every settings section and keyboard shortcuts on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, settings } = await setupSettings(page, false);
  const center = settings.locator(".settings-center");
  const selector = center.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  const panel = center.locator(".settings-source-panel");
  await expectSettingsOptions(selector, 9);
  await expect(
    panel.getByRole("group", { name: "Keyboard shortcuts", exact: true }),
  ).toHaveCount(0);

  // reach typed application fields through the mobile source navigation
  await chooseSettingsOption(selector, "app");
  await expect(panel.getByLabel("Server name")).toHaveValue("Framework");
  await chooseSettingsOption(selector, "env");
  await expect(panel.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await chooseSettingsOption(selector, "installation");
  await expect(
    panel.getByRole("radio", { name: "Docker", exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByRole("radio", { name: "Docker", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel("Project name", { exact: true })).toBeDisabled();
  await chooseSettingsOption(selector, "compose-override");
  await expect(panel.getByLabel("Docker source content")).toHaveValue(
    /RAC_PORT: 8787/u,
  );
  await chooseSettingsOption(selector, "voice");
  await expect(
    panel.getByRole("switch", { name: "Enable Davo" }),
  ).toBeVisible();

  // retain the upstream shortcut sheet and search inside the restored workspace
  await chooseSettingsOption(selector, "keyboard");
  await panel.getByRole("button", { name: "View active shortcuts" }).click();
  const sheet = page.getByRole("dialog", { name: "Key bindings" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close key bindings" }).click();
  await center
    .getByRole("searchbox", { name: "Search settings" })
    .fill("keyboard");
  await expectSettingsOptions(selector, 1);
  await expect(selector.locator(".settings-select-current-label")).toHaveText(
    "Keyboard shortcuts",
  );
  const metrics = await center.evaluate((element) => ({
    visible: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(metrics.content).toBeLessThanOrEqual(metrics.visible);
  expect(state.saves).toEqual([]);
  expect(state.reveals).toEqual([]);
  expect(state.restarts).toBe(0);
});

test("keeps pending state visible but disables restart when another browser owns control", async ({
  page,
}) => {
  await mockAccountSocket(page);
  let restarts = 0;
  // expose only redacted status to one observe-only browser
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "observer-csrf",
          active: false,
          deviceName: "Observer",
          controllingDeviceName: "Controlling browser",
          server: {
            name: "Framework",
            url: "https://framework.santosa.dev",
            remotes: [],
          },
        },
      });
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: true,
          targets: ["rac"],
          effective: "known",
          restartAvailable: true,
          reason: "Saved application settings require a restart.",
        },
      });
    if (path === "/api/settings/restart" && request.method() === "POST") {
      restarts += 1;
      return route.fulfill({
        status: 403,
        json: { error: "control required" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
  await page.goto("/");
  await expect(page.getByText("Controlling browser is active")).toBeVisible();
  const notice = page.getByRole("status", { name: "Restart pending" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Restart" })).toBeDisabled();
  await expect(notice.getByRole("button", { name: "Restart" })).toHaveAttribute(
    "title",
    "Take control to restart",
  );
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();
  expect(restarts).toBe(0);
});

test("expires revealed plaintext and disclosure-derived drafts while settings stays open", async ({
  page,
}) => {
  const { state, settings } = await setupSettings(page);
  state.revealTtlMs = 500;
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: "Environment & keys" })
    .click();
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  const secret = settings.locator('textarea[aria-label="RAC_SESSION_SECRET"]');
  await expect(secret).toHaveValue("fixture-session-secret");
  await secret.fill("disclosure-derived-candidate");
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible({
    timeout: 3_000,
  });
  await expect(settings).not.toContainText("disclosure-derived-candidate");
  await expect.poll(() => state.remasks.length).toBeGreaterThan(0);
  await expect(
    settings.getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
});

// keep every staged edit on validation or revision failure without a partial voice write
test("retains unified voice and advanced drafts on validation and commit failures", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  await selectSettingsSection(settings, "voice", "Voice");
  await settings.getByRole("switch", { name: "Enable Davo" }).check();
  await settings.getByLabel("Davo name").fill("Riley");
  await settings
    .locator('[data-settings-path="integrations.realtime.writeToolsEnabled"]')
    .getByRole("switch")
    .check();
  state.validationValid = false;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    settings.getByText("Fix the validation issues before saving."),
  ).toBeVisible();
  await expect(
    page.locator('body > .toast-region .operation-feedback.success'),
  ).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
  state.validationValid = true;
  state.saveStatus = 409;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings.getByRole("alert")).toContainText(
    "changed outside Settings",
  );
  await expect(
    page.locator('body > .toast-region .operation-feedback.success'),
  ).toHaveCount(0);
  await expect(settings.getByLabel("Davo name")).toHaveValue("Riley");
  await expect(
    settings
      .locator('[data-settings-path="integrations.realtime.writeToolsEnabled"]')
      .getByRole("switch"),
  ).toBeChecked();
  expect(state.voiceSaves).toHaveLength(0);
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).not.toBeChecked();
  await expect(
    settings
      .locator('[data-settings-path="integrations.realtime.writeToolsEnabled"]')
      .getByRole("switch"),
  ).not.toBeChecked();
});

// lock the transaction while validation awaits and prevent duplicate commits
test("saves voice and environment together once while validation is pending", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  await selectSettingsSection(settings, "voice", "Voice");
  await settings.getByRole("switch", { name: "Enable Davo" }).check();
  await settings.getByLabel("Davo name").fill(" Riley ");
  await settings.getByLabel("Davo context").fill(" Speak plainly. ");
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByLabel("EDITOR_COMMAND", { exact: true })
    .fill("code --new-window");
  let finishValidation!: () => void;
  const held = new Promise<void>((resolve) => {
    finishValidation = resolve;
  });
  await page.route("**/api/settings/validate", async (route) => {
    state.validations.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
  });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect.poll(() => state.validations.length).toBe(1);
  await expect(
    settings.getByLabel("EDITOR_COMMAND", { exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  finishValidation();
  await expect.poll(() => state.saves.length).toBe(1);
  const transaction = state.saves[0] as {
    body: { changes: Array<{ sourceId: string; patches: unknown[] }> };
  };
  expect(transaction.body.changes.map((change) => change.sourceId)).toEqual([
    "app",
    "env",
  ]);
  expect(transaction.body.changes[0]?.patches).toContainEqual({
    op: "set",
    path: ["integrations", "realtime", "name"],
    value: "Riley",
  });
  expect(transaction.body.changes[0]?.patches).not.toContainEqual({
    op: "set",
    path: ["integrations", "realtime", "context"],
    value: "Speak plainly.",
  });
  expect(state.voiceSaves).toHaveLength(0);
});

// whole-source application drafts must not be silently overwritten by voice controls
test("keeps voice read-only while an application whole-source draft exists", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("textbox", {
      name: "Application config source content",
      exact: true,
    })
    .fill('{"name":"Raw draft"}');
  await selectSettingsSection(settings, "voice", "Voice");
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).toBeDisabled();
  await expect(
    settings.getByText(
      "Finish or discard the Application whole-source draft before editing voice settings.",
    ),
  ).toBeVisible();
});

// preserve a staged source removal across structured voice navigation
test("blocks basic and advanced voice editing while application removal is staged", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Remove source", exact: true })
    .click();
  await selectSettingsSection(settings, "voice", "Voice");
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).toBeDisabled();
  await expect(
    settings
      .locator('[data-settings-path="integrations.realtime.writeToolsEnabled"]')
      .getByRole("switch"),
  ).toBeDisabled();
  await expect(
    settings.getByText(
      "Discard the Application source removal before editing voice settings.",
    ),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Validate", exact: true }).click();
  await expect.poll(() => state.validations.length).toBe(1);
  expect(state.validations[0]).toEqual({
    changes: [{ sourceId: "app", revisionId: "app-r1", remove: true }],
  });
});

// malformed application JSON requires whole-source repair before structured voice edits
test("blocks voice edits until invalid application JSON is repaired", async ({
  page,
}) => {
  const { settings, sources } = await setupSettings(page, false);
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        version: 1,
        revisionId: "invalid",
        sources: sources.map((source) =>
          source.id === "app"
            ? { ...source, value: undefined, content: "{" }
            : source,
        ),
        status: {
          pending: false,
          targets: [],
          effective: "known",
          restartAvailable: true,
        },
      },
    }),
  );
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "voice", "Voice");
  await expect(
    settings.getByRole("switch", { name: "Enable Davo" }),
  ).toBeDisabled();
  await expect(
    settings
      .locator('[data-settings-path="integrations.realtime.writeToolsEnabled"]')
      .getByRole("switch"),
  ).toBeDisabled();
  await expect(
    settings.getByText(
      "Repair the Application whole source before editing voice settings.",
    ),
  ).toBeVisible();
});

// basic voice changes apply live after one mobile save without a restart
test("saves basic voice live once from the floating mobile bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, state } = await setupSettings(page, false);
  await selectSettingsSection(settings, "voice", "Voice");
  await settings.getByRole("switch", { name: "Enable Davo" }).check();
  await settings.getByLabel("Davo name").fill("Riley");
  await expect(settings.getByRole("button", { name: /^Save/u })).toHaveCount(1);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.voiceSaves).toHaveLength(0);
  expect(state.status.pending).toBe(false);
  expect(state.restarts).toBe(0);
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("switch", { name: "Enable Riley" }),
  ).toBeChecked();
});

// revoke late plaintext and prevent duplicate leases after leaving a source
test("revokes a delayed reveal after navigation without resurrecting plaintext", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  await selectSettingsSection(settings, "env", "Environment & keys");
  let finishReveal!: () => void;
  let revealRequests = 0;
  const held = new Promise<void>((resolve) => {
    finishReveal = resolve;
  });
  await page.route("**/api/settings/reveal", async (route) => {
    revealRequests += 1;
    await held;
    const request = route.request().postDataJSON();
    await route.fulfill({
      json: {
        value: "fixture-delayed-secret",
        revisionId: request.revisionId,
        leaseId: "delayed-lease",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect.poll(() => revealRequests).toBe(1);
  await selectSettingsSection(settings, "voice", "Voice");
  finishReveal();
  await expect
    .poll(() => state.remasks)
    .toContainEqual({ leaseId: "delayed-lease" });
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(
    settings.locator('textarea[aria-label="RAC_SESSION_SECRET"]'),
  ).toHaveCount(0);
});

// a failed runtime read must not let context-menu disable overwrite the committed identity
test("preserves saved voice identity when refresh fails and the old call button disables voice", async ({
  page,
}) => {
  const { settings, state, sources } = await setupSettings(
    page,
    false,
    false,
    true,
  );
  await selectSettingsSection(settings, "voice", "Voice");
  await settings.getByLabel("Davo name").fill("Riley");
  await settings.getByLabel("Davo context").fill("New committed context.");
  state.authUnavailable = true;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Call Davo", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Disable Davo", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(2);
  const disable = state.saves[1] as {
    body: { changes: Array<{ patches: unknown[] }> };
  };
  expect(disable.body.changes[0]?.patches).toEqual([
    { op: "set", path: ["integrations", "realtime", "enabled"], value: false },
  ]);
  expect(sources[0]?.value?.integrations.realtime).toMatchObject({
    enabled: false,
    name: "Riley",
    context: "New committed context.",
  });
  expect(state.voiceSaves).toHaveLength(0);
});

// source revision refresh cannot retain plaintext disclosed from an earlier baseline
test("remasks active disclosures before refreshing authoritative files", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page, false);
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await expect(
    settings.locator('textarea[aria-label="RAC_SESSION_SECRET"]'),
  ).toHaveValue("fixture-session-secret");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(
    settings.locator('textarea[aria-label="RAC_SESSION_SECRET"]'),
  ).toHaveCount(0);
  await expect.poll(() => state.remasks.length).toBe(1);
  expect(state.saves).toHaveLength(0);
});

// server shortcuts stage in the same config transaction as other application edits
test("saves keyboard shortcuts in server config through the single floating save action", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await expect(settings.locator('[data-settings-path="keys"]')).toHaveCount(0);
  await settings.getByLabel("Server name").fill("Server with keyboard changes");
  await selectSettingsSection(settings, "keyboard", "Keyboard shortcuts");
  // legacy command coverage selects its exclusive editor representation
  await settings
    .getByRole("combobox", { name: "Keyboard editor view", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "Keyboard editor view options", exact: true })
    .getByRole("option", { name: "Command shortcuts", exact: true })
    .click();
  await expect(
    settings.getByRole("region", { name: "Edit keyboard shortcuts" }),
  ).toBeVisible();
  await expect(settings).toContainText("config.json");
  const next = settings.locator('[data-shortcut-command="action:next-panel"]');
  await next.getByRole("button", { name: "Disable", exact: true }).click();
  expect(state.saves).toHaveLength(0);
  await expect(
    settings.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: { changes: Array<{ sourceId: string; patches: unknown[] }> };
  };
  expect(save.body.changes).toHaveLength(1);
  expect(save.body.changes[0]?.patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["identity", "name"],
        value: "Server with keyboard changes",
        revisionId: "identity-name-r1",
      },
      { op: "set", path: ["keys", "prefix", "n"], value: null },
      { op: "set", path: ["keys", "prefix", "o"], value: null },
    ]),
  );
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("rac.keyboard-shortcuts")),
  ).toBeNull();
});

// consume shortcut navigation once rather than replaying it on every settings opening
test("opens keyboard settings from the reference once and keeps ordinary opening on browser preferences", async ({
  page,
}) => {
  const { settings } = await setupSettings(page, false);
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.keyboard.press("Control+?");
  const reference = page.getByRole("dialog", {
    name: "Key bindings",
    exact: true,
  });
  await reference
    .getByRole("button", { name: "Edit in Settings", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Global settings", exact: true })
    .first()
    .click();
  await expect(
    settings.getByRole("heading", { name: "This browser", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Keyboard shortcuts", exact: true }),
  ).toHaveCount(0);
});

// defer reference navigation until the shared transaction finishes validating and committing
test("retains a keyboard navigation request while a shared save is pending", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await settings.getByLabel("Server name").fill("Held keyboard navigation");
  let finishValidation!: () => void;
  const held = new Promise<void>((resolve) => {
    finishValidation = resolve;
  });
  await page.route("**/api/settings/validate", async (route) => {
    state.validations.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
  });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  await page.keyboard.press("Control+?");
  await page
    .getByRole("dialog", { name: "Key bindings", exact: true })
    .getByRole("button", { name: "Edit in Settings", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", {
      name: "Application config",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  finishValidation();
  await expect.poll(() => state.saves.length).toBe(1);
  await expect(
    settings.getByRole("heading", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
});

// keyboard edits cannot replace an incompatible whole-source application draft
test("keeps keyboard controls read-only while an application whole-source draft is staged", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("textbox", {
      name: "Application config source content",
      exact: true,
    })
    .fill('{"name":"Raw keyboard draft"}');
  await selectSettingsSection(settings, "keyboard", "Keyboard shortcuts");
  await expect(
    settings.getByText(
      "Finish or discard the Application whole-source draft before editing keyboard shortcuts.",
    ),
  ).toBeVisible();
  // read-only browsing can still inspect either keyboard representation
  await settings
    .getByRole("combobox", { name: "Keyboard editor view", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "Keyboard editor view options", exact: true })
    .getByRole("option", { name: "Command shortcuts", exact: true })
    .click();
  await expect(settings.locator(".shortcut-change").first()).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Reset all shortcuts", exact: true }),
  ).toBeDisabled();
  expect(state.saves).toHaveLength(0);
});

// describe voice without repeating the assistant name as a title
for (const width of [390, 1440]) {
  test(`uses a normal feature description instead of the assistant heading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupSettings(page, false);
    await selectSettingsSection(settings, "voice", "Voice");
    const voice = settings.getByRole("region", {
      name: "Voice assistant",
      exact: true,
    });
    await expect(
      settings.getByRole("heading", { name: "Voice", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("heading", { name: "Davo", exact: true }),
    ).toHaveCount(0);
    const description = voice.locator("header > p");
    await expect(description).toHaveText(
      "Talk to your AI assistant using voice, with context from your current workspace.",
    );
    await expect(
      settings.getByText(
        "Save changes applies the voice name, context and enabled state live.",
        { exact: true },
      ),
    ).toHaveCount(0);
    const metrics = await voice.evaluate((element) => {
      const description = element.querySelector("header > p")!;
      const normal = element
        .closest(".settings-source-panel")!
        .querySelector(".settings-preference-description")!;
      const actual = getComputedStyle(description);
      const reference = getComputedStyle(normal);
      const copy = description.getBoundingClientRect();
      const toggle = element
        .querySelector(".client-settings-toggle")!
        .getBoundingClientRect();
      return {
        actual: [
          actual.fontSize,
          actual.lineHeight,
          actual.color,
          actual.fontWeight,
        ],
        reference: [
          reference.fontSize,
          reference.lineHeight,
          reference.color,
          reference.fontWeight,
        ],
        delta: Math.abs(
          copy.top + copy.height / 2 - toggle.top - toggle.height / 2,
        ),
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
    expect(metrics.actual).toEqual(metrics.reference);
    expect(metrics.delta).toBeLessThanOrEqual(1);
    expect(metrics.overflow).toBeLessThanOrEqual(0);
    await voice
      .getByRole("switch", { name: "Enable Davo", exact: true })
      .check();
    await expect(voice.getByLabel("Davo name")).toHaveValue("Davo");
    await expect(voice.getByLabel("Davo context")).toBeVisible();
    await voice.getByLabel("Davo name").fill("Riley");
    await expect(
      settings.getByRole("heading", { name: "Riley", exact: true }),
    ).toHaveCount(0);
    await expect(
      voice.getByRole("switch", { name: "Enable Riley", exact: true }),
    ).toBeChecked();
    expect(state.saves).toHaveLength(0);
    expect(state.voiceSaves).toHaveLength(0);
  });
}
