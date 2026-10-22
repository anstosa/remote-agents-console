import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectProgressBorder } from "./progress-border-assertions";
import { mockAccountSocket } from "./account-fixture";
import {
  confirmSettingsClose,
  confirmSettingsDiscard,
} from "./settings-confirmation-helpers.js";
import {
  isProtectedValue,
  type SettingsEnvField,
  type SettingsPatch,
  type SettingsSchema,
} from "../src/settings/contracts.js";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";
import {
  buttonColors,
  defaultButtons,
} from "../../server/src/config/buttons.js";
import { environmentFallback } from "../../server/src/settings/catalog.js";
import { applyPatch } from "../../server/src/settings/patches.js";
import { applyAuthoredProjectPatch } from "../../server/src/settings/project-normalization.js";

const authoritativeProjectsSchema =
  applicationSettingsSchema().properties!.projects!;
const authoritativeButtonsSchema =
  applicationSettingsSchema().properties!.buttons!;

// choose only an explicitly clicked custom option
async function chooseSettingsOption(selector: Locator, value: string) {
  await selector.click();
  await selector
    .page()
    .getByRole("listbox", { name: "Settings section options", exact: true })
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
  const popup = selector.page().getByRole("listbox", {
    name: "Settings section options",
    exact: true,
  });
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
    const visibleLabel = id === "app" ? "Application" : label;
    const escaped = visibleLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    await settings
      .getByRole("navigation", { name: "Settings sources" })
      .getByRole("button", {
        name: new RegExp(`^${escaped}(?: (?:· )?Unsaved changes)?$`, "u"),
      })
      .click();
  }
}

// verify every split slot uses its concise product label
async function expectSplitButtonLabels(container: Locator) {
  const labels = [
    "Agent",
    "Terminal",
    "Note",
    "Browser",
    "Files",
    "Code",
    "Review",
    "Stack",
    "Settings",
  ];
  // inspect every split slot independently
  for (const label of labels) {
    await expect(container.getByText(label, { exact: true })).toBeVisible();
    await expect(
      container.getByText(`${label} split`, { exact: true }),
    ).toHaveCount(0);
  }
}

type SettingsPageHeaderExpectation = {
  id: string;
  title: string;
  eyebrow:
    | "Application settings"
    | "Browser settings"
    | "Server settings"
    | "Deployment settings";
  description?: string;
  sourcePath?: string;
};

const settingsPageHeaderExpectations: SettingsPageHeaderExpectation[] = [
  {
    id: "browser",
    title: "This browser",
    eyebrow: "Browser settings",
    description: "Manage this browser’s name and identity.",
  },
  { id: "voice", title: "Voice", eyebrow: "Server settings" },
  {
    id: "keyboard",
    title: "Keyboard shortcuts",
    eyebrow: "Server settings",
  },
  {
    id: "app",
    title: "Application",
    eyebrow: "Server settings",
    sourcePath: "/checkout/config/config.json",
  },
  {
    id: "interface",
    title: "Interface",
    eyebrow: "Application settings",
    description:
      "Customize this browser’s appearance and configure application-wide buttons.",
  },
  { id: "agents", title: "Agents", eyebrow: "Server settings" },
  {
    id: "projects",
    title: "Projects",
    eyebrow: "Server settings",
    description:
      "Configure repositories, worktrees, project-specific commands, and this browser’s launcher behavior.",
  },
  { id: "reviews", title: "Reviews", eyebrow: "Server settings" },
  { id: "tmux", title: "TMUX", eyebrow: "Server settings" },
  { id: "storage", title: "Storage", eyebrow: "Server settings" },
  {
    id: "env",
    title: "Environment & keys",
    eyebrow: "Deployment settings",
    sourcePath: "/checkout/.env",
  },
  {
    id: "installation",
    title: "Installation",
    eyebrow: "Deployment settings",
    sourcePath: "/checkout/config/settings-installation.json",
  },
  {
    id: "compose-override",
    title: "Docker",
    eyebrow: "Deployment settings",
    sourcePath: "/checkout/compose.override.yaml",
  },
  {
    id: "cloudflare",
    title: "Cloudflare",
    eyebrow: "Deployment settings",
  },
];

// require one complete shared page header without matching nested section copy
async function expectStandardSettingsHeader(
  settings: Locator,
  expected: SettingsPageHeaderExpectation,
) {
  const panel = settings.getByRole("region", {
    name: `${expected.title} settings content`,
    exact: true,
  });
  const header = panel.locator(":scope > .settings-source-header");
  await expect(header).toHaveCount(1);
  await expect(header.locator(".settings-source-kicker")).toHaveText(
    expected.eyebrow,
  );
  await expect(
    header.getByRole("heading", {
      name: expected.title,
      exact: true,
      level: 2,
    }),
  ).toHaveCount(1);
  const description = header.locator(".settings-preference-description");
  await expect(description).toHaveCount(1);
  await expect(description).toHaveText(expected.description ?? /\S/u);
  const metadata = header.locator(".settings-source-metadata");
  await expect(metadata).toHaveCount(expected.sourcePath === undefined ? 0 : 1);
  // source-backed pages retain subordinate file identity
  if (expected.sourcePath !== undefined)
    await expect(metadata).toContainText(expected.sourcePath);
  return { description, header, panel };
}

// measure one editor against its owning settings scroller
async function settingsEditorGeometry(editor: Locator) {
  return editor.locator(".settings-code-editor-surface").evaluate((surface) => {
    const panel = surface.closest(".settings-source-panel");
    const textarea = surface.querySelector("textarea");
    // reject detached editor geometry
    if (panel === null || textarea === null)
      throw new Error("Settings editor is missing its source panel");
    const surfaceBox = surface.getBoundingClientRect();
    const surfaceStyle = getComputedStyle(surface);
    const textareaStyle = getComputedStyle(textarea);
    const presentation = surface.querySelector<HTMLElement>(
      ".syntax-highlight-presentation",
    );
    // reject incomplete editor composition
    if (presentation === null)
      throw new Error("Settings editor is missing its presentation layer");
    const textareaBorderHeight =
      Number.parseFloat(textareaStyle.borderTopWidth) +
      Number.parseFloat(textareaStyle.borderBottomWidth);
    const textareaScrollbarHeight = Math.max(
      0,
      textarea.offsetHeight - textarea.clientHeight - textareaBorderHeight,
    );
    const naturalHeight =
      presentation.querySelectorAll(".syntax-line").length *
        Number.parseFloat(textareaStyle.lineHeight) +
      Number.parseFloat(textareaStyle.paddingTop) +
      Number.parseFloat(textareaStyle.paddingBottom) +
      Number.parseFloat(surfaceStyle.borderTopWidth) +
      Number.parseFloat(surfaceStyle.borderBottomWidth) +
      textareaScrollbarHeight;
    return {
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      naturalHeight,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      panelScrollTop: panel.scrollTop,
      surfaceHeight: surfaceBox.height,
    };
  });
}

// measure vertical containment while preserving horizontal code overflow
async function settingsEditorContentGeometry(input: Locator) {
  return input.evaluate((textarea) => {
    const surface = textarea.closest(".settings-code-editor-surface");
    const panel = textarea.closest(".settings-source-panel");
    const presentation = surface?.querySelector<HTMLElement>(
      ".syntax-highlight-presentation",
    );
    const lastLine = presentation?.querySelector<HTMLElement>(
      ".syntax-line:last-child",
    );
    // reject incomplete editor composition
    if (
      surface === null ||
      panel === null ||
      presentation === undefined ||
      presentation === null
    )
      throw new Error("Settings editor content is missing its layout owner");
    const panelBox = panel.getBoundingClientRect();
    const lastLineBox = lastLine?.getBoundingClientRect();
    return {
      clientHeight: textarea.clientHeight,
      clientWidth: textarea.clientWidth,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      lastLineBottom: lastLineBox?.bottom,
      lastLineTop: lastLineBox?.top,
      panelBottom: panelBox.bottom,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      panelScrollTop: panel.scrollTop,
      panelTop: panelBox.top,
      presentationClientHeight: presentation.clientHeight,
      presentationScrollHeight: presentation.scrollHeight,
      presentationScrollTop: presentation.scrollTop,
      scrollHeight: textarea.scrollHeight,
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
      scrollWidth: textarea.scrollWidth,
      surfaceHeight: surface.getBoundingClientRect().height,
    };
  });
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

const settingsUnavailableSections = [
  { id: "app", label: "Application" },
  { id: "agents", label: "Agents" },
  { id: "reviews", label: "Reviews" },
  { id: "tmux", label: "TMUX" },
  { id: "storage", label: "Storage" },
  { id: "env", label: "Environment & keys" },
  { id: "installation", label: "Installation" },
  { id: "compose-override", label: "Docker" },
  { id: "cloudflare", label: "Cloudflare" },
] as const;
const protectedSourceMarker = `__RAC_PROTECTED_${"A".repeat(43)}__`;
const agentEnvironmentKeys = [
  "RAC_CODEX_BIN",
  "RAC_CLAUDE_BIN",
  "RAC_CLAUDE_CONFIG_DIR",
  "RAC_HOST_CODEX_BIN",
  "RAC_OPENAI_ADMIN_KEY",
  "RAC_OPENAI_API_KEY_IDS",
  "CODEX_VERSION",
] as const;
const storageEnvironmentKeys = [
  "RAC_ADAPTER_FILES_DIR",
  "RAC_SERVER_ADMIN_STATUS_DIR",
  "RAC_TEMP_PREVIEWS_DIR",
  "RAC_DEVICE_NAMES_FILE",
  "RAC_CONSOLE_NAMED_FILE",
  "RAC_WORKTREES_FILE",
  "RAC_SAVED_PROMPTS_FILE",
  "RAC_PROMPT_HISTORY_FILE",
  "RAC_QUEUED_PROMPTS_FILE",
  "RAC_NOTES_FILE",
  "RAC_REVIEW_TOURS_FILE",
  "RAC_PUSH_SUBSCRIPTIONS_FILE",
  "RAC_FILE_FAVORITES_FILE",
  "RAC_FILE_OPERATION_JOURNAL",
  "RAC_INTEGRATION_AUTH_FILE",
  "RAC_INTEGRATION_STATE_FILE",
  "RAC_INTEGRATION_AUDIT_FILE",
  "RAC_BOOKMARKS_FILE",
] as const;

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
          projects: useAuthoritativeProjectsSchema
            ? authoritativeProjectsSchema
            : {
                type: "array",
                label: "Projects",
                items: {
                  type: "object",
                  label: "Project",
                  default: {
                    id: "new-project",
                    label: "New project",
                    path: "",
                  },
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
          key: "RAC_HOST_NODE_BIN",
          protected: false,
          present: false,
          apply: "rac-restart",
          description:
            "Host-visible Node.js executable used to run the host Files broker.",
          fallback: { value: "node from host PATH", kind: "derived" },
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
    // expose safe tunnel metadata before its page first opens
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
        // preserve the backend's remove and ordered-patch semantics in saved responses
        for (const patch of change.patches ?? []) {
          // sources without a structured value retain their existing content-only behavior
          if (source.value === undefined) continue;
          source.value =
            source.id === "app"
              ? applyAuthoredProjectPatch(source.value, patch)
              : applyPatch(source.value, patch);
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

type LegacyFederationSchemaMode = "declared" | "inferred";

// expose legacy federation metadata beside current remote and integration controls
function configureLegacyFederationFixture(
  sources: MutableInstallationFixtureSource[],
  mode: LegacyFederationSchemaMode,
  enabled: boolean,
  remoteCount: 0 | 1,
) {
  const application = sources.find((source) => source.id === "app")!;
  const value = application.value as Record<string, unknown>;
  const integrations = value.integrations as Record<string, unknown>;
  application.value = {
    ...value,
    integrations: {
      ...integrations,
      multiInstance: { enabled },
      mcp: { endpoint: "https://mcp.example.test" },
    },
    remoteServers:
      remoteCount === 0 ? [] : [{ url: "https://remote.example.test/" }],
  };
  application.content = `${JSON.stringify(application.value)}\n`;
  // cover catalogs that omit all presentation metadata
  if (mode === "inferred") {
    delete application.schema;
    return;
  }
  const schema = application.schema as {
    type: string;
    properties: Record<string, unknown>;
  };
  const integrationSchema = schema.properties.integrations as {
    type: string;
    properties: Record<string, unknown>;
  };
  schema.properties.integrations = {
    ...integrationSchema,
    label: "Integrations",
    properties: {
      ...integrationSchema.properties,
      multiInstance: {
        type: "object",
        label: "Multi instance",
        description: "Legacy federation setting from generated metadata.",
        properties: {
          enabled: { type: "boolean", label: "Enable multi instance" },
        },
      },
      mcp: {
        type: "object",
        label: "Mcp",
        properties: {
          endpoint: { type: "string", label: "Mcp endpoint" },
        },
      },
    },
  };
  schema.properties.remoteServers = {
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
  };
}

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
  const adapterEnvironmentSchema =
    applicationSettingsSchema().properties!.adapters!.properties!.codex!
      .properties!.env!;
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
              env: adapterEnvironmentSchema,
            },
          },
          claude: {
            type: "object",
            label: "Claude",
            optional: true,
            properties: {
              program: { type: "string", label: "Claude program" },
              env: adapterEnvironmentSchema,
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
    RAC_CLAUDE_CONFIG_DIR: "/override/claude-config",
    RAC_ADAPTER_FILES_DIR: "/override/adapter-files",
    RAC_OPENAI_ADMIN_KEY: protectedSourceMarker,
    RAC_OPENAI_API_KEY_IDS: '{"atlas":"key-id"}',
    CODEX_VERSION: "0.144.5",
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
  const existing = new Map(
    (env.fields ?? []).map((field) => [field.key, field]),
  );
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
  const adminKey = env.fields.find(
    (field) => field.key === "RAC_OPENAI_ADMIN_KEY",
  )!;
  // preserve the protected contract without returning synthetic plaintext
  Object.assign(adminKey, { protected: true, hasValue: true });
  delete adminKey.value;
  env.content = `${env.content ?? ""}${Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")}`;
  env.hasProtectedContent = true;
  return { app, env };
}

// expose Storage fields without authoring omission defaults into either source
function configureStorageFixture(sources: MutableInstallationFixtureSource[]) {
  const app = sources.find((source) => source.id === "app")!;
  const appValue = app.value as Record<string, unknown>;
  delete appValue.scratchDirectory;
  const appSchema = app.schema as {
    properties: Record<string, unknown>;
  };
  appSchema.properties.scratchDirectory = {
    type: "string",
    optional: true,
    label: "Scratch directory",
    placeholder: "/home/test (from host home)",
    apply: "rac-restart",
  };
  const env = sources.find((source) => source.id === "env")!;
  const retained = (env.fields ?? []).filter(
    (field) =>
      typeof field.key !== "string" ||
      !storageEnvironmentKeys.includes(
        field.key as (typeof storageEnvironmentKeys)[number],
      ),
  );
  env.fields = [
    ...retained,
    ...storageEnvironmentKeys.map((key) => ({
      key,
      protected: false,
      present: false,
      apply: key === "RAC_BOOKMARKS_FILE" ? "saved-only" : "source-migration",
      description: `${key} fixture path.`,
      fallback: environmentFallback(key),
    })),
  ];
  return { app, env };
}

// expose voice credentials beside unrelated OpenAI billing configuration without real secret bytes
function addVoiceEnvironmentFixture(
  sources: MutableInstallationFixtureSource[],
) {
  const application = sources.find((source) => source.id === "app")!;
  const applicationValue = application.value as Record<string, unknown>;
  const applicationSchema = application.schema as {
    type: string;
    properties: Record<string, unknown>;
  };
  application.value = {
    ...applicationValue,
    adapters: { codex: { program: "/usr/bin/codex" } },
  };
  application.schema = {
    ...applicationSchema,
    properties: {
      ...applicationSchema.properties,
      adapters: applicationSettingsSchema().properties!.adapters!,
    },
  };
  const environment = sources.find((source) => source.id === "env")!;
  environment.fields!.push(
    ...[
      "RAC_OPENAI_API_KEY",
      "RAC_REALTIME_MCP_TOKEN",
      "RAC_OPENAI_ADMIN_KEY",
      "RAC_OPENAI_API_KEY_IDS",
    ].map((key) => ({
      key,
      protected: true,
      present: key === "RAC_OPENAI_API_KEY",
      hasValue: key === "RAC_OPENAI_API_KEY",
      apply: "rac-restart" as const,
      fallback: environmentFallback(key),
    })),
  );
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
  test(`omits the main Settings introduction without removing controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const consoleErrors: string[] = [];
    // capture browser failures while checking navigation and transaction controls
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const { settings, state } = await setupSettings(page);
    await expect(
      settings.getByText("CONSOLE, SERVER AND INSTALLATION", { exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("heading", {
        name: "Preferences and configuration",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      settings.getByText(
        "Save changes applies browser preferences and saves server and file edits.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(settings.locator(".settings-center-header")).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);

    // keep search, per-tab identity and source navigation available
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await expect(search).toHaveAttribute("placeholder", "Search all settings");
    await expect(
      settings.getByText("Search settings", { exact: true }),
    ).toHaveCount(0);
    await selectSettingsSection(settings, "env", "Environment & keys");
    await expect(
      settings.getByRole("heading", {
        name: "Environment & keys",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-no-main-intro-${width}.png`,
    });

    // expose save only while a normal field edit remains dirty
    await settings
      .getByRole("textbox", { name: "RAC_HOST_PROC", exact: true })
      .fill("/host/updated-proc");
    const save = settings.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => state.saves.length).toBe(1);
    await expect(save).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });
}

// keep application source repair compact without changing its secure draft boundary
for (const width of [320, 390, 1440]) {
  test(`keeps the Application base-file action compact and source-safe at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, sources, state } = await setupSettings(page);
    const application = sources.find((source) => source.id === "app")!;
    application.value = {
      ...application.value,
      credential: {
        __racProtected: true,
        present: true,
        hasValue: true,
      },
      mcp: { endpoint: "https://mcp.example.test" },
    };
    application.content = `{"identity":{"name":"Framework"},"credential":"${protectedSourceMarker}","mcp":{"endpoint":"https://mcp.example.test"}}\n`;
    application.hasProtectedContent = true;
    application.schema!.properties = {
      ...application.schema!.properties,
      credential: {
        type: "string",
        label: "Application credential",
        protected: true,
      },
      mcp: {
        type: "object",
        label: "Mcp",
        properties: {
          endpoint: { type: "string", label: "Mcp endpoint" },
        },
      },
    };
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();

    // desktop and mobile navigation expose only the product page name
    const selector = settings.getByRole("combobox", {
      name: "Settings section",
      exact: true,
    });
    if (await selector.isVisible()) {
      await expect(selector).toContainText("Application");
      await expect(selector).not.toContainText("Application config");
      await selector.click();
      const options = page.getByRole("listbox", {
        name: "Settings section options",
        exact: true,
      });
      await expect(
        options.getByRole("option", { name: "Application", exact: true }),
      ).toBeVisible();
      await expect(
        options.getByRole("option", {
          name: "Application config",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    } else {
      const navigation = settings.getByRole("navigation", {
        name: "Settings sources",
        exact: true,
      });
      await expect(
        navigation.getByRole("button", {
          name: "Application",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        navigation.getByRole("button", {
          name: "Application config",
          exact: true,
        }),
      ).toHaveCount(0);
    }

    const panel = settings.getByRole("region", {
      name: "Application settings content",
      exact: true,
    });
    await expect(
      panel.getByRole("heading", {
        name: "Application",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", {
        name: /Application config(?:uration)?/u,
        level: 3,
      }),
    ).toHaveCount(0);
    await expect(panel.locator(".settings-raw-mode")).toHaveCount(0);
    const edit = panel.getByRole("button", {
      name: "Edit base file",
      exact: true,
    });
    const alignment = await edit.evaluate((button) => {
      const header = button.closest(".settings-source-header");
      const title = header?.querySelector("h2");
      // fail loudly when the action escapes its page header
      if (header === null || title === null)
        throw new Error("Application base-file action is missing its header");
      const headerBox = header.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      return {
        buttonRight: headerBox.right - buttonBox.right,
        buttonWidth: buttonBox.width,
        headerWidth: headerBox.width,
        rightOfTitle: buttonBox.left > titleBox.left,
      };
    });
    expect(alignment.buttonRight).toBeLessThanOrEqual(1);
    expect(alignment.buttonWidth).toBeLessThan(alignment.headerWidth / 2);
    expect(alignment.rightOfTitle).toBe(true);

    // section titles use the light purple token without recoloring field labels
    const sectionTitles = [
      panel.getByRole("heading", {
        name: "Integrations",
        exact: true,
        level: 3,
      }),
      panel.getByRole("heading", { name: "Mcp", exact: true, level: 3 }),
    ];
    const lightPurple = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--lavender)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    for (const title of sectionTitles) {
      await expect(title).toBeVisible();
      expect(await title.evaluate((element) => getComputedStyle(element).color)).toBe(
        lightPurple,
      );
    }
    const fieldLabel = panel
      .locator('[data-settings-path="mcp.endpoint"] .settings-field-copy > label')
      .first();
    await expect(fieldLabel).toHaveText("Mcp endpoint");
    expect(
      await fieldLabel.evaluate((element) => getComputedStyle(element).color),
    ).not.toBe(lightPurple);
    await settings.screenshot({
      path: `/tmp/remoteagents-application-structured-${width}.png`,
    });

    // raw editing stays masked and does not bypass the shared save transaction
    await page.route("**/api/settings/reveal", async (route) => {
      const body = route.request().postDataJSON() as {
        sourceId: string;
        path?: string[];
        revisionId: string;
      };
      // override only the whole Application source disclosure
      if (body.sourceId !== "app" || (body.path?.length ?? 0) !== 0)
        return route.fallback();
      state.reveals.push(body);
      return route.fulfill({
        json: {
          value:
            '{"identity":{"name":"Framework"},"credential":"synthetic-app-secret","mcp":{"endpoint":"https://mcp.example.test"}}\n',
          revisionId: body.revisionId,
          leaseId: "application-source-lease",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    });
    await edit.click();
    const raw = panel.getByLabel("Application config source content", {
      exact: true,
    });
    await expect(raw).toBeVisible();
    await expect(raw).toHaveAttribute("readonly", "");
    await expect(raw).not.toHaveValue(/synthetic-app-secret/u);
    await expect(panel.locator(".settings-raw-mode")).toHaveCount(0);
    await expect(
      panel.getByRole("button", {
        name: "Use structured editor",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    expect(state.validations).toEqual([]);
    expect(state.saves).toEqual([]);
    await panel
      .getByRole("button", { name: "Reveal keys", exact: true })
      .click();
    await expect(raw).toHaveValue(/synthetic-app-secret/u);
    await raw.fill('{"identity":{"name":"Raw-only draft"}}\n');
    await settings.screenshot({
      path: `/tmp/remoteagents-application-base-file-${width}.png`,
    });
    await panel
      .getByRole("button", {
        name: "Use structured editor",
        exact: true,
      })
      .click();
    await expect(panel.getByLabel("Server name", { exact: true })).toHaveValue(
      "Framework",
    );
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => state.remasks).toContainEqual({
      leaseId: "application-source-lease",
    });
    expect(state.saves).toEqual([]);

    // Docker keeps its existing base preview and editor contract
    await selectSettingsSection(settings, "compose-override", "Docker");
    await expect(
      settings.getByRole("heading", {
        name: "Docker",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", {
        name: "View base compose.yaml",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Edit base file", exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByLabel("Docker source content", { exact: true }),
    ).toBeEditable();
  });
}

for (const width of [390, 1440]) {
  test(`standardizes every Settings page header at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, state } = await setupSettings(page, false);
    const screenshotPages = new Set([
      "browser",
      "app",
      "compose-override",
      "cloudflare",
    ]);

    // visit each destination through its rendered responsive navigation
    for (const expected of settingsPageHeaderExpectations) {
      await selectSettingsSection(settings, expected.id, expected.title);
      const { description, header, panel } =
        await expectStandardSettingsHeader(settings, expected);
      const metadata = header.locator(".settings-source-metadata");
      const ordering = await header.evaluate((element) => {
        const copy = element.querySelector(".settings-preference-description")!;
        const source = element.querySelector(".settings-source-metadata");
        return {
          descriptionBeforeMetadata:
            source === null ||
            Boolean(copy.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING),
          overflow: element.scrollWidth - element.clientWidth,
        };
      });
      expect(ordering.descriptionBeforeMetadata).toBe(true);
      expect(ordering.overflow).toBeLessThanOrEqual(0);

      const actionName =
        expected.id === "app"
          ? "Edit base file"
          : expected.id === "compose-override"
            ? "View base compose.yaml"
            : undefined;
      const directActions = header.locator(":scope > button");
      await expect(directActions).toHaveCount(actionName === undefined ? 0 : 1);
      // title actions stay on their row while description spans beneath them
      if (actionName !== undefined) {
        const action = header.getByRole("button", {
          name: actionName,
          exact: true,
        });
        await expect(action).toBeVisible();
        const geometry = await header.evaluate((element) => {
          const title = element.querySelector("h2")!.getBoundingClientRect();
          const action = element.querySelector("button")!.getBoundingClientRect();
          const description = element
            .querySelector(".settings-preference-description")!
            .getBoundingClientRect();
          const header = element.getBoundingClientRect();
          return {
            actionAfterTitle: action.left >= title.right,
            actionInside: action.right <= header.right + 1,
            descriptionBelow:
              description.top >= Math.max(title.bottom, action.bottom),
            descriptionSpansAction: description.right >= action.right - 1,
            descriptionStartsWithTitle: description.left <= title.left + 1,
          };
        });
        expect(geometry).toEqual({
          actionAfterTitle: true,
          actionInside: true,
          descriptionBelow: true,
          descriptionSpansAction: true,
          descriptionStartsWithTitle: true,
        });
      }
      await expect(description).toBeVisible();
      // capture the representative browser, server and deployment headers
      if (screenshotPages.has(expected.id))
        await settings.screenshot({
          path: `/tmp/remoteagents-settings-page-header-${expected.id}-${width}.png`,
        });
      // metadata never replaces the human-readable header description
      if (expected.sourcePath !== undefined) await expect(metadata).toBeVisible();
      expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
    }
    expect(state.saves).toEqual([]);
    expect(state.validations).toEqual([]);
    expect(state.restarts).toBe(0);
  });
}

for (const scenario of [
  { width: 390, mode: "declared", enabled: false, remoteCount: 0 },
  { width: 1440, mode: "inferred", enabled: true, remoteCount: 1 },
] as const) {
  test(`hides legacy Multi instance metadata with ${scenario.mode} schema at ${scenario.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const { settings, sources, state } = await setupSettings(page);
    configureLegacyFederationFixture(
      sources,
      scenario.mode,
      scenario.enabled,
      scenario.remoteCount,
    );
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();

    const application = settings.getByRole("region", {
      name: "Application settings content",
      exact: true,
    });
    await expect(
      application.getByRole("heading", {
        name: "Application",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      application.locator('[data-settings-path="integrations.multiInstance"]'),
    ).toHaveCount(0);
    await expect(
      application.getByRole("heading", { name: "Multi instance", exact: true }),
    ).toHaveCount(0);
    await expect(
      application.getByRole("button", { name: /Add Multi instance/u }),
    ).toHaveCount(0);
    await expect(
      application.getByRole("switch", { name: /multi instance/iu }),
    ).toHaveCount(0);
    await expect(
      application.getByRole("heading", { name: "Mcp", exact: true }),
    ).toBeVisible();
    await expect(
      application
        .locator('[data-settings-path="integrations.mcp.endpoint"]')
        .getByRole("textbox"),
    ).toBeEditable();

    const addRemote = application.getByRole("button", {
      name: "+ Add Remote server",
      exact: true,
    });
    await expect(addRemote).toBeEnabled();
    // inspect the inherited remote row without authoring a network change
    if (scenario.remoteCount === 1) {
      const row = application.getByRole("group", {
        name: "Remote server 1",
        exact: true,
      });
      await row
        .getByRole("button", { name: "Edit Remote server 1", exact: true })
        .click();
      await expect(
        row.getByRole("textbox", { name: "URL", exact: true }),
      ).toBeEditable();
    } else {
      await expect(
        application.getByRole("group", { name: /^Remote server \d+$/u }),
      ).toHaveCount(0);
    }
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-auto-federation-application-${scenario.width}.png`,
    });

    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await search.fill("multi instance");
    const results = page.getByRole("listbox", {
      name: "Settings search results",
      exact: true,
    });
    await expect(results.getByRole("option")).toHaveCount(0);
    await expect(
      results.getByText("No matching settings.", { exact: true }),
    ).toBeVisible();
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-auto-federation-search-${scenario.width}.png`,
    });
    await search.fill("federation");
    await expect(results.getByRole("option")).toHaveCount(0);
    await search.fill("");

    await selectSettingsSection(settings, "voice", "Voice");
    await expect(
      settings.getByRole("switch", { name: "Enable Davo", exact: true }),
    ).toBeVisible();
    expect(state.saves).toEqual([]);
    expect(state.validations).toEqual([]);
  });
}

test("advertises only Docker while Compose sources are still loading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = deferredResponse();
  const { settings, state } = await setupSettings(page, false, false, false, [
    { wait: initial.promise },
  ]);
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

// keep one-line raw editors intrinsic across split sizes
for (const width of [1440, 390]) {
  test(`keeps a one-line Docker editor at natural height at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1200 });
    const { settings, state } = await setupSettings(page, false);
    await settings
      .getByRole("button", { name: "Expand settings", exact: true })
      .click();
    await selectSettingsSection(settings, "compose-override", "Docker");
    const input = settings.getByLabel("Docker source content", { exact: true });
    const editor = input.locator("..").locator("..");
    await input.fill("services: {}");
    await expect
      .poll(async () => {
        const geometry = await settingsEditorGeometry(editor);
        return Math.abs(geometry.surfaceHeight - geometry.naturalHeight);
      })
      .toBeLessThanOrEqual(1);
    const shorter = await settingsEditorGeometry(editor);
    expect(shorter.documentScrollTop).toBe(0);
    await page.setViewportSize({ width, height: 1400 });
    await expect
      .poll(
        async () => (await settingsEditorGeometry(editor)).panelClientHeight,
      )
      .toBeGreaterThan(shorter.panelClientHeight);
    const taller = await settingsEditorGeometry(editor);
    expect(
      Math.abs(taller.surfaceHeight - taller.naturalHeight),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(taller.surfaceHeight - shorter.surfaceHeight),
    ).toBeLessThanOrEqual(1);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-editor-docker-${width}.png`,
    });

    await page.setViewportSize({ width, height: 700 });
    await expect
      .poll(
        async () => (await settingsEditorGeometry(editor)).panelClientHeight,
      )
      .toBeLessThan(taller.panelClientHeight);
    const compact = await settingsEditorGeometry(editor);
    expect(
      Math.abs(compact.surfaceHeight - compact.naturalHeight),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(compact.surfaceHeight - shorter.surfaceHeight),
    ).toBeLessThanOrEqual(1);
    const panel = settings.locator(".settings-source-panel");
    await panel.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect(input).toBeVisible();
    expect((await settingsEditorGeometry(editor)).documentScrollTop).toBe(0);
    expect(state.saves).toEqual([]);
  });
}

// move long source height into the parent panel instead of nesting vertical scroll
for (const width of [1440, 390]) {
  test(`uses natural Docker content height at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const { settings, state } = await setupSettings(page, false);
    await settings
      .getByRole("button", { name: "Expand settings", exact: true })
      .click();
    await selectSettingsSection(settings, "compose-override", "Docker");
    const input = settings.getByLabel("Docker source content", { exact: true });
    const editor = input.locator("..").locator("..");
    const initial = await settingsEditorContentGeometry(input);
    const longContent = `${Array.from(
      { length: 64 },
      (_, index) => `# fixture line ${index + 1}`,
    ).join("\n")}\nLONG_VALUE: "${"x".repeat(600)}"\n`;
    await input.fill(longContent);
    await expect
      .poll(
        async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
      )
      .toBeGreaterThan(initial.surfaceHeight);
    const long = await settingsEditorContentGeometry(input);
    expect(long.scrollHeight).toBeLessThanOrEqual(long.clientHeight + 1);
    expect(long.presentationScrollHeight).toBeLessThanOrEqual(
      long.presentationClientHeight + 1,
    );
    expect(long.scrollTop).toBe(0);
    expect(long.presentationScrollTop).toBe(0);
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);

    await input.evaluate((textarea) => {
      textarea.scrollLeft = textarea.scrollWidth;
      textarea.dispatchEvent(new Event("scroll"));
    });
    const horizontal = await settingsEditorContentGeometry(input);
    expect(horizontal.scrollLeft).toBeGreaterThan(0);
    expect(horizontal.scrollTop).toBe(0);

    const expandedContent = `${longContent}${Array.from(
      { length: 12 },
      (_, index) => `# added line ${index + 1}`,
    ).join("\n")}\n`;
    await input.fill(expandedContent);
    await expect
      .poll(
        async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
      )
      .toBeGreaterThan(long.surfaceHeight);
    const expanded = await settingsEditorContentGeometry(input);
    expect(expanded.scrollHeight).toBeLessThanOrEqual(
      expanded.clientHeight + 1,
    );
    expect(expanded.scrollTop).toBe(0);

    await input.fill(longContent);
    await expect
      .poll(
        async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
      )
      .toBeLessThan(expanded.surfaceHeight);
    const panel = settings.locator(".settings-source-panel");
    await panel.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    const bottom = await settingsEditorContentGeometry(input);
    expect(bottom.panelScrollHeight).toBeGreaterThan(bottom.panelClientHeight);
    expect(bottom.panelScrollTop).toBeGreaterThan(0);
    expect(bottom.scrollTop).toBe(0);
    expect(bottom.documentScrollTop).toBe(0);
    expect(bottom.lastLineTop).toBeGreaterThanOrEqual(bottom.panelTop - 1);
    expect(bottom.lastLineBottom).toBeLessThanOrEqual(bottom.panelBottom + 1);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-editor-natural-docker-${width}.png`,
    });

    await input.fill("services:\n  fixture:\n    image: local\n");
    await expect
      .poll(
        async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
      )
      .toBeLessThan(long.surfaceHeight);
    expect((await settingsEditorContentGeometry(input)).scrollTop).toBe(0);
    expect(state.saves).toEqual([]);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeVisible();
    await expect(editor).toBeVisible();
  });
}

// apply the same natural height to a nested structured JSON editor
test("expands nested structured JSON without internal vertical scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const { settings, sources, state } = await setupSettings(page, false);
  await settings
    .getByRole("button", { name: "Expand settings", exact: true })
    .click();
  const application = sources.find((source) => source.id === "app")!;
  application.value = { fixture: { debugPayload: { ready: true } } };
  application.content = '{"fixture":{"debugPayload":{"ready":true}}}\n';
  application.schema = {
    type: "object",
    label: "Application config",
    properties: {
      fixture: {
        type: "object",
        label: "Fixture",
        properties: {
          debugPayload: { type: "json", label: "Debug payload" },
        },
      },
    },
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "app", "Application config");
  const input = settings.getByLabel("Debug payload", { exact: true });
  const initial = await settingsEditorContentGeometry(input);
  const longJson = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`fixture_${index + 1}`, index]),
    ),
    null,
    2,
  );
  await input.fill(`${longJson}\n`);
  await expect
    .poll(
      async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
    )
    .toBeGreaterThan(initial.surfaceHeight);
  const long = await settingsEditorContentGeometry(input);
  expect(long.scrollHeight).toBeLessThanOrEqual(long.clientHeight + 1);
  expect(long.presentationScrollHeight).toBeLessThanOrEqual(
    long.presentationClientHeight + 1,
  );
  expect(long.scrollTop).toBe(0);
  const panel = settings.locator(".settings-source-panel");
  await panel.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(
    settings.getByText(
      "Custom artwork sources are unavailable in this installation.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  expect((await settingsEditorContentGeometry(input)).documentScrollTop).toBe(
    0,
  );

  await input.fill('{\n  "ready": true\n}');
  await expect
    .poll(
      async () => (await settingsEditorContentGeometry(input)).surfaceHeight,
    )
    .toBeLessThan(long.surfaceHeight);
  expect(state.saves).toEqual([]);
});

// keep a second artwork editor reachable after the application whole-source editor
test("keeps multiple application editors and collapsed artwork reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 2400 });
  const { settings, state } = await setupSettings(page, true, true);
  await settings
    .getByRole("button", { name: "Expand settings", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  const applicationInput = settings.getByLabel(
    "Application config source content",
    { exact: true },
  );
  const applicationEditor = applicationInput.locator("..").locator("..");
  const artwork = settings
    .locator(".settings-icon-source")
    .filter({ hasText: "View / edit Heart icon" });
  const nextArtwork = settings
    .locator(".settings-icon-source")
    .filter({ hasText: "View / edit Potato icon" });
  const summary = artwork.locator("summary");
  const [collapsedArtwork, collapsedSummary] = await Promise.all([
    artwork.boundingBox(),
    summary.boundingBox(),
  ]);
  expect(collapsedArtwork).not.toBeNull();
  expect(collapsedSummary).not.toBeNull();
  expect(
    collapsedArtwork!.height - collapsedSummary!.height,
  ).toBeLessThanOrEqual(2);
  await summary.click();
  const artworkInput = artwork.getByLabel("Heart icon source content", {
    exact: true,
  });
  const artworkEditor = artworkInput.locator("..").locator("..");
  await expect(artworkInput).toBeVisible();
  await expect(settings.locator(".settings-code-editor")).toHaveCount(2);
  const [collapsedNextArtwork, collapsedNextSummary] = await Promise.all([
    nextArtwork.boundingBox(),
    nextArtwork.locator("summary").boundingBox(),
  ]);
  expect(collapsedNextArtwork).not.toBeNull();
  expect(collapsedNextSummary).not.toBeNull();
  expect(
    collapsedNextArtwork!.height - collapsedNextSummary!.height,
  ).toBeLessThanOrEqual(2);
  const tallPanelHeight = (await settingsEditorGeometry(applicationEditor))
    .panelClientHeight;
  // keep both open surfaces intrinsic
  for (const editor of [applicationEditor, artworkEditor]) {
    const geometry = await settingsEditorGeometry(editor);
    expect(
      Math.abs(geometry.surfaceHeight - geometry.naturalHeight),
    ).toBeLessThanOrEqual(1);
    expect(geometry.documentScrollTop).toBe(0);
  }
  const panel = settings.locator(".settings-source-panel");
  await panel.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(nextArtwork.locator("summary")).toBeVisible();
  const scrolled = await settingsEditorGeometry(artworkEditor);
  expect(scrolled.documentScrollTop).toBe(0);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-editors-artwork-tall.png",
  });

  await page.setViewportSize({ width: 1440, height: 700 });
  await expect
    .poll(
      async () =>
        (await settingsEditorGeometry(applicationEditor)).panelClientHeight,
    )
    .toBeLessThan(tallPanelHeight);
  await panel.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(nextArtwork.locator("summary")).toBeVisible();
  expect(
    (await settingsEditorGeometry(artworkEditor)).panelScrollTop,
  ).toBeGreaterThan(0);
  // keep both surfaces intrinsic in a short split
  for (const editor of [applicationEditor, artworkEditor]) {
    const geometry = await settingsEditorGeometry(editor);
    expect(
      Math.abs(geometry.surfaceHeight - geometry.naturalHeight),
    ).toBeLessThanOrEqual(1);
    expect(geometry.documentScrollTop).toBe(0);
  }
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-editors-artwork-short.png",
  });
  await summary.click();
  const [closedArtwork, closedSummary] = await Promise.all([
    artwork.boundingBox(),
    summary.boundingBox(),
  ]);
  expect(closedArtwork).not.toBeNull();
  expect(closedSummary).not.toBeNull();
  expect(closedArtwork!.height - closedSummary!.height).toBeLessThanOrEqual(2);
  expect(state.saves).toEqual([]);
});

// keep Installation and wrapper editors intrinsic inside the tab scroller
test("keeps Installation and TMUX source editors intrinsic and reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  const { settings, sources, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  await settings
    .getByRole("button", { name: "Expand settings", exact: true })
    .click();
  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const installationInput = settings.getByLabel("Installation source content", {
    exact: true,
  });
  const installationEditor = installationInput.locator("..").locator("..");
  const installationGeometry = await settingsEditorGeometry(installationEditor);
  expect(
    Math.abs(
      installationGeometry.surfaceHeight - installationGeometry.naturalHeight,
    ),
  ).toBeLessThanOrEqual(1);

  await selectSettingsSection(settings, "tmux", "TMUX");
  const wrapperInput = settings.getByLabel(
    "Installation wrapper source content",
    { exact: true },
  );
  const wrapperEditor = wrapperInput.locator("..").locator("..");
  const wrapperGeometry = await settingsEditorGeometry(wrapperEditor);
  expect(
    Math.abs(wrapperGeometry.surfaceHeight - wrapperGeometry.naturalHeight),
  ).toBeLessThanOrEqual(1);
  await wrapperInput.scrollIntoViewIfNeeded();
  await expect(wrapperInput).toBeVisible();
  const visibleWrapper = await settingsEditorGeometry(wrapperEditor);
  expect(visibleWrapper.documentScrollTop).toBe(0);
  expect(state.saves).toEqual([]);
});

// keep a short structured JSON field intrinsic beside following content
test("keeps a structured JSON editor intrinsic and following content reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  const { settings, sources, state } = await setupSettings(page, false);
  await settings
    .getByRole("button", { name: "Expand settings", exact: true })
    .click();
  const application = sources.find((source) => source.id === "app")!;
  application.value = { debugPayload: { ready: true } };
  application.content = '{"debugPayload":{"ready":true}}\n';
  application.schema = {
    type: "object",
    label: "Application config",
    properties: {
      debugPayload: { type: "json", label: "Debug payload" },
    },
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "app", "Application config");
  const input = settings.getByLabel("Debug payload", { exact: true });
  const editor = input.locator("..").locator("..");
  const geometry = await settingsEditorGeometry(editor);
  expect(
    Math.abs(geometry.surfaceHeight - geometry.naturalHeight),
  ).toBeLessThanOrEqual(1);
  const panel = settings.locator(".settings-source-panel");
  await panel.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(
    settings.getByText(
      "Custom artwork sources are unavailable in this installation.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  expect((await settingsEditorGeometry(editor)).documentScrollTop).toBe(0);
  expect(state.saves).toEqual([]);
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
  const description = header.locator(".settings-preference-description");
  await expect(description).toHaveText(/\S/u);
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
    settings.getByText(
      /Restart .* applies it together with the base Compose file\./u,
    ),
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
    await expect(description).toBeVisible();
    const descriptionBox = await description.boundingBox();
    const editorBox = await settings
      .locator(".settings-raw-editor")
      .boundingBox();
    expect(descriptionBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(descriptionBox!.y + descriptionBox!.height).toBeLessThanOrEqual(
      editorBox!.y,
    );
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
  await expect(settings.getByText("Trusted code", { exact: true })).toHaveCount(
    0,
  );
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
  await expect
    .soft(tmuxNav.locator("svg path"))
    .toHaveAttribute("d", "M3 4h18v16H3zm9 0v16M3 12h9");
  await tmuxNav.click();
  const tmux = settings.locator(".settings-tmux");

  await expect.soft(tmux.locator(".settings-remove-button")).toHaveCount(0);
  await expect
    .soft(tmux.locator('[data-settings-path="sources.wrapper"]'))
    .toHaveCount(0);
  await expect
    .soft(tmux.getByLabel("Wrapper path", { exact: true }))
    .toHaveCount(0);
  await expect.soft(tmux.locator(".settings-tmux-path")).toHaveCount(0);
  await expect
    .soft(
      tmux.getByText("/checkout/config/installation-wrapper.sh", {
        exact: true,
      }),
    )
    .toHaveCount(0);
  await expect(
    tmux.getByLabel("Installation wrapper source content"),
  ).toHaveValue("");
  await expect(
    tmux.getByLabel("Installation wrapper source content"),
  ).toBeEditable();
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
  const { settings, sources, state } = await setupSettings(
    page,
    false,
    false,
    false,
    [],
    "missing",
  );
  await selectSettingsSection(settings, "tmux", "TMUX");
  const input = settings.getByLabel("Installation wrapper source content");
  const description = settings
    .getByRole("region", { name: "TMUX wrapper", exact: true })
    .locator("header p");
  // describe wrapper selection and the save-only execution boundary
  await expect(description).toHaveText(
    "Optional shell script used by RAC_TMUX_BIN to launch tmux with installation-specific paths or shared libraries, for example when connecting Docker to host tmux. Saving changes does not run the script.",
  );
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
  await expect(
    settings.getByText("Source content", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByText("Source does not exist", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Create source", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Remove source", exact: true }),
  ).toHaveCount(0);
  // include the wrapper guidance in responsive visual evidence
  await description.scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-wrapper-narrow.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(description).toBeVisible();
  await description.scrollIntoViewIfNeeded();
  await expect(input).toBeVisible();
  const overflow = await settings.evaluate((element) => ({
    page:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
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
  expect(labels.indexOf("Interface")).toBe(
    labels.indexOf("Application") + 1,
  );
  expect(labels.indexOf("Agents")).toBe(labels.indexOf("Interface") + 1);
  expect(labels.indexOf("Projects")).toBe(labels.indexOf("Agents") + 1);
  expect(labels.indexOf("Reviews")).toBe(labels.indexOf("Projects") + 1);
  expect(labels.indexOf("TMUX")).toBe(labels.indexOf("Reviews") + 1);
  expect(labels.indexOf("Storage")).toBe(labels.indexOf("TMUX") + 1);
  await expect(
    nav.getByRole("button", { name: "Installation wrapper", exact: true }),
  ).toHaveCount(0);

  // moved structured controls disappear without removing whole-source repair
  await selectSettingsSection(settings, "app", "Application config");
  await expect(
    settings.locator('[data-settings-path="tmux.pollIntervalMs"]'),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await expect(
    settings.getByLabel("Application config source content"),
  ).toHaveValue(/"tmux":\{"pollIntervalMs":500\}/u);
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
  const wrapperContent = '#!/usr/bin/env bash\nexec /opt/tmux/bin/tmux "$@"\n';
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
        patches: [{ op: "set", path: ["tmux", "pollIntervalMs"], value: 650 }],
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
  const { settings, state, sources } = await setupSettings(page);
  const env = sources.find((source) => source.id === "env")!;
  // mirror the backend's resolved metadata without authoring either value
  const hostNodeField = env.fields!.find((field) => field.key === "RAC_HOST_NODE_BIN")!;
  hostNodeField.fallback = { value: "/host/bin/node (from host PATH)", kind: "derived" };
  env.fields!.push({
    key: "RAC_TEMP_PREVIEW_ORIGIN",
    protected: false,
    present: false,
    apply: "rac-restart",
    fallback: { value: "https://agents.example.com (from Application Public Origin)", kind: "derived" },
  });
  await settings.getByRole("button", { name: "Refresh files", exact: true }).click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  const listenHost = settings.locator('[data-settings-path="RAC_LISTEN_HOST"]');
  await expect(
    listenHost.getByLabel("RAC_LISTEN_HOST", { exact: true }),
  ).toHaveValue("");
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
  const hostNode = settings.getByLabel("RAC_HOST_NODE_BIN", { exact: true });
  await hostNode.scrollIntoViewIfNeeded();
  await expect(hostNode).toHaveValue("");
  await expect(hostNode).toHaveAttribute("placeholder", "/host/bin/node (from host PATH)");
  const previewOrigin = settings.getByLabel("RAC_TEMP_PREVIEW_ORIGIN", { exact: true });
  await expect(previewOrigin).toHaveValue("");
  await expect(previewOrigin).toHaveAttribute("placeholder", "https://agents.example.com (from Application Public Origin)");
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-host-node-placeholder-desktop.png",
  });
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-defaults-desktop.png",
  });

  await selectSettingsSection(settings, "tmux", "TMUX");
  const tmuxBinary = settings.locator('[data-settings-path="RAC_TMUX_BIN"]');
  await expect(
    tmuxBinary.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toHaveValue("/usr/bin/tmux");
  await expect(
    tmuxBinary.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toHaveAttribute("placeholder", "/usr/local/bin/tmux");
  await expect(
    settings.getByText(/Default when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-tmux-defaults-desktop.png",
  });

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-tmux-defaults-mobile.png",
  });
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await listenHost.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-env-defaults-mobile.png",
  });
  await hostNode.scrollIntoViewIfNeeded();
  await expect(hostNode).toHaveValue("");
  await expect(hostNode).toHaveAttribute("placeholder", "/host/bin/node (from host PATH)");
  await expect(previewOrigin).toHaveValue("");
  await expect(previewOrigin).toHaveAttribute("placeholder", "https://agents.example.com (from Application Public Origin)");
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-host-node-placeholder-mobile.png",
  });
  expect(consoleErrors).toEqual([]);
});

// keep bridge defaults visible without creating environment assignments
for (const kind of ["compose", "systemd"] as const) {
  test(`shows all TMUX omission placeholders for ${kind} without drafting values`, async ({
    page,
  }) => {
    const { settings, sources, state } = await setupSettings(
      page,
      false,
      false,
      false,
      [],
      "none",
      kind,
    );
    const env = sources.find((source) => source.id === "env") as {
      fields: Array<{
        key: string;
        value?: string;
        present: boolean;
        fallback?: { value: string; kind: string };
      }>;
    };
    // consume the same public omission metadata returned by the settings service
    for (const field of env.fields) {
      if (
        ["RAC_HOST_TMUX_DIR", "HOST_TMUX_DIR", "HOST_TMUX_BIN"].includes(
          field.key,
        )
      ) {
        delete field.value;
        field.present = false;
        field.fallback = environmentFallback(field.key, kind);
      }
    }
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "tmux", "TMUX");
    const expectedKeys =
      kind === "compose"
        ? ["RAC_HOST_TMUX_DIR", "HOST_TMUX_DIR", "HOST_TMUX_BIN"]
        : ["RAC_HOST_TMUX_DIR"];
    // check only fields consumed by this installation mode
    for (const key of expectedKeys) {
      const input = settings.getByRole("textbox", { name: key, exact: true });
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute(
        "placeholder",
        environmentFallback(key, kind)!.value,
      );
    }
    expect(
      await settings
        .locator(".settings-env-fields input")
        .evaluateAll((inputs) =>
          inputs.every((input) =>
            Boolean(input.getAttribute("placeholder")?.trim()),
          ),
        ),
    ).toBe(true);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await settings.screenshot({
      path: `/tmp/rac-all-placeholders-${kind}-desktop.png`,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await settings.screenshot({
      path: `/tmp/rac-all-placeholders-${kind}-mobile.png`,
    });
    expect(state.saves).toEqual([]);
  });
}

// keep inherited voice configuration visible without authoring its defaults
test("shows omitted voice defaults as placeholders without staging file changes", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    false,
    false,
    true,
  );
  const application = sources.find((source) => source.id === "app") as {
    value: { integrations: { realtime: Record<string, unknown> } };
  };
  delete application.value.integrations.realtime.name;
  delete application.value.integrations.realtime.context;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "voice", "Voice");
  await expect(
    settings.getByRole("textbox", { name: "Davo name", exact: true }),
  ).toHaveValue("");
  await expect(
    settings.getByRole("textbox", { name: "Davo name", exact: true }),
  ).toHaveAttribute("placeholder", "Davo (from active Voice settings)");
  await expect(
    settings.getByRole("textbox", { name: "Davo context", exact: true }),
  ).toHaveValue("");
  await expect(
    settings.getByRole("textbox", { name: "Davo context", exact: true }),
  ).toHaveAttribute(
    "placeholder",
    "Speak plainly. (from active Voice settings)",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
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
  await expect(input).toHaveAttribute("placeholder", "/usr/local/bin/tmux");
  await expect(
    settings.getByText(/Default when omitted|Running Docker supplies/u),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const changes = (
    state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          revisionId: string;
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
    }
  ).body.changes;
  expect(changes).toEqual([
    {
      sourceId: "env",
      revisionId: "env-r1",
      patches: [{ op: "remove", path: ["RAC_TMUX_BIN"] }],
    },
  ]);
});

// hide installer inputs while retaining runtime edits and original source assignments
for (const installationKind of ["compose", "systemd"] as const) {
  test(`hides installer-only inputs without rewriting ${installationKind} environment files`, async ({
    page,
  }) => {
    const { settings, sources, state } = await setupSettings(
      page,
      true,
      false,
      false,
      [],
      "none",
      installationKind,
    );
    const { env } = configureDuplicateEnvironmentFixture(sources);
    const installerKeys = [
      "NODE_BIN",
      "RAC_ENV_FILE",
      "COMPOSE_FILE",
      "COMPOSE_ENV_FILES",
      "COMPOSE_PROJECT_NAME",
      "COMPOSE_PROFILES",
      "COMPOSE_PARALLEL_LIMIT",
      "COMPOSE_COMPATIBILITY",
    ];
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "env", "Environment & keys");
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    // omit ineffective rows and exact-key search targets in either deployment mode
    for (const key of installerKeys) {
      await expect(
        settings.getByRole("textbox", { name: key, exact: true }),
      ).toHaveCount(0);
      await search.fill(key);
      await expect(
        page
          .getByRole("listbox", {
            name: "Settings search results",
            exact: true,
          })
          .locator(".settings-search-result-title > strong")
          .filter({ hasText: new RegExp(`^${key}$`, "u") }),
      ).toHaveCount(0);
    }
    await search.fill("RAC_HOST_NODE_BIN");
    await expect(
      page
        .getByRole("listbox", { name: "Settings search results", exact: true })
        .getByText("RAC_HOST_NODE_BIN", { exact: true }),
    ).toBeVisible();
    await search.fill("");
    // preserve host and custom runtime inputs independently of installation aliases
    for (const key of [
      "RAC_HOST_NODE_BIN",
      "RAC_HOST_PATH",
      "CUSTOM_VISIBLE_SETTING",
    ]) {
      await expect(
        settings.getByRole("textbox", { name: key, exact: true }),
      ).toBeEditable();
    }
    await settings
      .getByRole("button", { name: "Edit whole source", exact: true })
      .click();
    const raw = settings.getByLabel("Environment & keys source content", {
      exact: true,
    });
    const content = await raw.inputValue();
    // leave installer assignments available for file-level administration
    for (const key of installerKeys)
      expect(content).toContain(
        `${key}=${env.fields?.find((field) => field.key === key)?.value}\n`,
      );
    await settings
      .getByRole("button", { name: "Use structured editor", exact: true })
      .click();
    expect(state.saves).toEqual([]);

    // reserve installer names even if an older server omits them from its catalog
    env.fields = env.fields?.filter(
      (field) => !installerKeys.includes(String(field.key)),
    );
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Add environment variable", exact: true })
      .click();
    await settings.getByLabel("Value", { exact: true }).fill("installer-only");
    // reject every ineffective alias rather than silently creating a hidden draft
    for (const key of installerKeys) {
      await settings.getByLabel("Variable", { exact: true }).fill(key);
      await expect(
        settings.getByRole("button", { name: "Add variable", exact: true }),
      ).toBeDisabled();
    }
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await settings
      .getByLabel("EDITOR_COMMAND", { exact: true })
      .fill("nano --wait");
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    expect(state.saves[0]).toMatchObject({
      body: {
        changes: [
          {
            sourceId: "env",
            patches: [
              { op: "set", path: ["EDITOR_COMMAND"], value: "nano --wait" },
            ],
          },
        ],
      },
    });
  });
}

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
  for (const path of ["listen.host", "listen.port"])
    await expect(
      settings.locator(`[data-settings-path="${path}"]`),
    ).toBeVisible();
  for (const path of ["adapters.codex.program", "adapters.claude.program"])
    await expect(
      settings.locator(`[data-settings-path="${path}"]`),
    ).toHaveCount(0);
  await selectSettingsSection(settings, "agents", "Agents");
  for (const path of ["adapters.codex.program", "adapters.claude.program"])
    await expect(
      settings.locator(`[data-settings-path="${path}"]`),
    ).toBeVisible();
  for (const key of agentEnvironmentKeys)
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="RAC_ADAPTER_FILES_DIR"]'),
  ).toHaveCount(0);
  await selectSettingsSection(settings, "storage", "Storage");
  await expect(
    settings.locator('[data-settings-path="RAC_ADAPTER_FILES_DIR"]'),
  ).toBeVisible();
  await selectSettingsSection(settings, "installation", "Installation");
  for (const path of [
    "compose.files",
    "compose.envFiles",
    "compose.projectName",
    "compose.options.parallel",
    "compose.options.compatibility",
  ])
    await expect(
      settings.locator(`[data-settings-path="${path}"]`),
    ).toBeVisible();

  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of [
    "RAC_LISTEN_HOST",
    "RAC_LISTEN_PORT",
    ...agentEnvironmentKeys,
    ...storageEnvironmentKeys,
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
    "RAC_ENV_FILE",
    "COMPOSE_PROFILES",
    "NODE_BIN",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(
      0,
    );
  for (const key of [
    "CLOUDFLARED_CREDENTIALS_FILE",
    "RAC_CONFIG",
    "RAC_CONFIG_WRITE_PATH",
    "CUSTOM_VISIBLE_SETTING",
    "RAC_SESSION_SECRET",
  ])
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  await settings
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await settings
    .getByLabel("Variable", { exact: true })
    .fill("RAC_LISTEN_HOST");
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
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
  await settings
    .getByLabel("EDITOR_COMMAND", { exact: true })
    .fill("nano --wait");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (
      state.saves[0] as {
        body: {
          changes: Array<{
            sourceId: string;
            revisionId: string;
            patches?: Array<{ op: string; path: string[]; value?: unknown }>;
          }>;
        };
      }
    ).body.changes,
  ).toEqual([
    {
      sourceId: "env",
      revisionId: "env-r1",
      patches: [{ op: "set", path: ["EDITOR_COMMAND"], value: "nano --wait" }],
    },
  ]);
  expect(consoleErrors).toEqual([]);
});

// combine adapter configuration and its environment overrides without changing source ownership
test("moves adapter settings into Agents and saves both backing sources together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, sources, state } = await setupSettings(page);
  configureDuplicateEnvironmentFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  const labels = await nav.getByRole("button").allTextContents();
  expect(labels.indexOf("Interface")).toBe(
    labels.indexOf("Application") + 1,
  );
  expect(labels.indexOf("Agents")).toBe(labels.indexOf("Interface") + 1);
  expect(labels.indexOf("Projects")).toBe(labels.indexOf("Agents") + 1);

  await selectSettingsSection(settings, "app", "Application config");
  await expect(settings.locator('[data-settings-path="adapters"]')).toHaveCount(
    0,
  );
  await selectSettingsSection(settings, "env", "Environment & keys");
  for (const key of agentEnvironmentKeys)
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(
      0,
    );

  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("heading", { name: "Agents", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    settings.getByRole("textbox", { name: "Codex program", exact: true }),
  ).toHaveValue("/usr/bin/codex");
  for (const key of agentEnvironmentKeys)
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="RAC_ADAPTER_FILES_DIR"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByLabel("RAC_OPENAI_ADMIN_KEY masked"),
  ).toBeVisible();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-agents-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    settings.getByRole("combobox", { name: "Settings section", exact: true }),
  ).toHaveAttribute("data-value", "agents");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-agents-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await settings
    .getByRole("textbox", { name: "Codex program", exact: true })
    .fill("/opt/codex");
  await settings
    .getByRole("textbox", { name: "RAC_CLAUDE_CONFIG_DIR", exact: true })
    .fill("/config/claude-next");
  const adminKey = settings.locator(
    '[data-settings-path="RAC_OPENAI_ADMIN_KEY"]',
  );
  await adminKey
    .getByRole("button", { name: "Reveal RAC_OPENAI_ADMIN_KEY", exact: true })
    .click();
  await adminKey
    .getByRole("textbox", { name: "RAC_OPENAI_ADMIN_KEY", exact: true })
    .fill("synthetic-admin-key");
  await expect(
    nav.getByRole("button", { name: "Agents Unsaved changes", exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const transaction = state.saves[0] as {
    body: {
      changes: Array<{
        sourceId: string;
        patches?: Array<{ op: string; path: string[]; value?: unknown }>;
      }>;
    };
  };
  expect(transaction.body.changes).toHaveLength(2);
  expect(
    transaction.body.changes.find((change) => change.sourceId === "app")
      ?.patches,
  ).toEqual([
    {
      op: "set",
      path: ["adapters", "codex", "program"],
      value: "/opt/codex",
    },
  ]);
  expect(
    transaction.body.changes.find((change) => change.sourceId === "env")
      ?.patches,
  ).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["RAC_CLAUDE_CONFIG_DIR"],
        value: "/config/claude-next",
      },
      {
        op: "set",
        path: ["RAC_OPENAI_ADMIN_KEY"],
        value: "synthetic-admin-key",
      },
    ]),
  );
  await expect(
    page.getByRole("status", { name: "Restart pending", exact: true }),
  ).toBeVisible();
  expect(state.status.pending).toBe(true);
  expect(state.restarts).toBe(0);
});

// hide agent overrides when their owning adapter is unavailable
test("hides Agents environment controls without a renderable owning adapter", async ({
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
  // keep runtime fallbacks when their structured metadata is unavailable
  for (const key of ["RAC_LISTEN_HOST", "RAC_LISTEN_PORT"])
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  // never restore installer aliases as fallback controls
  for (const key of [
    ...agentEnvironmentKeys,
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
    "COMPOSE_PROFILES",
    "RAC_ENV_FILE",
    "NODE_BIN",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(
      0,
    );

  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.locator('[data-settings-path="adapters.codex.program"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("textbox", { name: "RAC_CODEX_BIN", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.locator('[data-settings-path="adapters.claude.program"]'),
  ).toBeVisible();
  await expect(
    settings.getByRole("textbox", { name: "RAC_CLAUDE_BIN", exact: true }),
  ).toBeEditable();
  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("textbox", { name: "RAC_CLAUDE_BIN", exact: true }),
  ).toBeEditable();
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.locator('[data-settings-path="RAC_CLAUDE_BIN"]'),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// preserve independent source authority on the combined Agents page
test("keeps Agents environment controls editable when application adapters are read-only", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app } = configureDuplicateEnvironmentFixture(sources);
  app.writable = false;
  const installation = sources.find((source) => source.id === "installation")!;
  installation.writable = false;
  await settings.getByRole("button", { name: "Refresh files" }).click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  // read-only peers still leave effective runtime overrides editable
  for (const key of ["RAC_LISTEN_HOST", "RAC_LISTEN_PORT"])
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  // installer-only aliases remain hidden independently of peer authority
  for (const key of [
    ...agentEnvironmentKeys,
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
    "COMPOSE_PROFILES",
    "RAC_ENV_FILE",
    "NODE_BIN",
  ])
    await expect(settings.locator(`[data-settings-path="${key}"]`)).toHaveCount(
      0,
    );
  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("textbox", { name: "Codex program", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_CODEX_BIN", exact: true }),
  ).toBeEditable();
  expect(state.saves).toEqual([]);
});

// lock each Agents source independently when its whole-file editor owns changes
test("keeps Agents source locks independent across raw and read-only states", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app, env } = configureDuplicateEnvironmentFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();

  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("textbox", { name: "Codex program", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_CODEX_BIN", exact: true }),
  ).toBeEditable();

  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("textbox", { name: "Codex program", exact: true }),
  ).toBeEditable();
  await expect(
    settings.getByRole("textbox", { name: "RAC_CODEX_BIN", exact: true }),
  ).toBeDisabled();

  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  app.writable = true;
  env.writable = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("textbox", { name: "Codex program", exact: true }),
  ).toBeEditable();
  await expect(
    settings.getByRole("textbox", { name: "RAC_CODEX_BIN", exact: true }),
  ).toBeDisabled();
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
  await expect(
    settings.locator('[data-settings-path="compose.files"]'),
  ).toHaveCount(0);
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.locator('[data-settings-path="RAC_ENV_FILE"]'),
  ).toHaveCount(0);
  // installer aliases stay hidden independently of the active installation mode
  for (const key of [
    "COMPOSE_FILE",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "COMPOSE_COMPATIBILITY",
    "COMPOSE_PROFILES",
    "NODE_BIN",
  ])
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toHaveCount(0);
  await selectSettingsSection(settings, "agents", "Agents");
  for (const key of agentEnvironmentKeys.filter(
    (candidate) => candidate !== "CODEX_VERSION",
  ))
    await expect(
      settings.locator(`[data-settings-path="${key}"]`),
    ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="CODEX_VERSION"]'),
  ).toHaveCount(0);
  await expect(
    settings.locator('[data-settings-path="RAC_ADAPTER_FILES_DIR"]'),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// combine scratch and data-file paths without changing either persisted source
for (const width of [1440, 390]) {
  test(`moves scratch and data paths into Storage at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, sources, state } = await setupSettings(page);
    configureStorageFixture(sources);
    state.migrationRequiredSourceIds = ["env"];
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();

    const nav = settings.getByRole("navigation", { name: "Settings sources" });
    // desktop exposes the complete ordered sidebar
    if (width === 1440) {
      const labels = await nav.getByRole("button").allTextContents();
      expect(labels.indexOf("Storage")).toBe(labels.indexOf("TMUX") + 1);
    }
    await selectSettingsSection(settings, "app", "Application config");
    await expect(
      settings.locator('[data-settings-path="scratchDirectory"]'),
    ).toHaveCount(0);
    await selectSettingsSection(settings, "agents", "Agents");
    for (const key of storageEnvironmentKeys)
      await expect(
        settings.locator(`[data-settings-path="${key}"]`),
      ).toHaveCount(0);
    await selectSettingsSection(settings, "env", "Environment & keys");
    for (const key of storageEnvironmentKeys)
      await expect(
        settings.locator(`[data-settings-path="${key}"]`),
      ).toHaveCount(0);

    await selectSettingsSection(settings, "storage", "Storage");
    await expect(
      settings.getByRole("heading", { name: "Storage", exact: true, level: 2 }),
    ).toBeVisible();
    const scratch = settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    });
    await expect(scratch).toBeEditable();
    await expect(scratch).toHaveValue("");
    await expect(scratch).toHaveAttribute(
      "placeholder",
      "/home/test (from host home)",
    );
    await expect(
      settings.getByRole("button", {
        name: /^(?:Add|Remove) Scratch directory$/u,
      }),
    ).toHaveCount(0);
    const storageEnvironment = settings.getByRole("region", {
      name: "Storage environment settings",
      exact: true,
    });
    await expect(
      storageEnvironment.getByRole("heading", {
        name: "Environment",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      storageEnvironment.getByRole("heading", {
        name: "Environment & keys",
        exact: true,
      }),
    ).toHaveCount(0);
    const spacing = await settings.evaluate(() => {
      const scratchField = document.querySelector<HTMLElement>(
        '[data-settings-path="scratchDirectory"]',
      )!;
      const environmentHeading = document
        .querySelector<HTMLElement>(
          '[aria-label="Storage environment settings"]',
        )!
        .querySelector<HTMLElement>("h3")!;
      return (
        environmentHeading.getBoundingClientRect().top -
        scratchField.getBoundingClientRect().bottom
      );
    });
    expect(spacing).toBeGreaterThanOrEqual(16);
    for (const key of storageEnvironmentKeys) {
      const input = storageEnvironment.getByRole("textbox", {
        name: key,
        exact: true,
      });
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute(
        "placeholder",
        environmentFallback(key)!.value,
      );
    }
    await expect(
      storageEnvironment.getByRole("textbox", {
        name: "RAC_ADAPTER_FILES_DIR",
        exact: true,
      }),
    ).toHaveAttribute("placeholder", ".data/adapters");
    await expect(
      storageEnvironment.getByRole("textbox", {
        name: "RAC_SERVER_ADMIN_STATUS_DIR",
        exact: true,
      }),
    ).toHaveAttribute("placeholder", ".data");
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    expect(state.saves).toEqual([]);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-storage-${width}.png`,
    });
    // mobile stops before staging a shared-source transaction
    if (width === 390) return;

    await scratch.fill("/var/tmp/rac");
    await storageEnvironment
      .getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true })
      .fill("/data/notes-next.json");
    await expect(
      nav.getByRole("button", { name: "Storage Unsaved changes", exact: true }),
    ).toBeVisible();
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "Choose source handover",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(scratch).toHaveValue("/var/tmp/rac");
    await expect(
      storageEnvironment.getByRole("textbox", {
        name: "RAC_NOTES_FILE",
        exact: true,
      }),
    ).toHaveValue("/data/notes-next.json");
    expect(state.saves).toEqual([]);

    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await dialog
      .getByRole("radio", { name: "Adopt existing", exact: true })
      .check();
    await dialog
      .getByRole("button", { name: "Continue and save", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    const transaction = state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          migration?: { mode: string };
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
    };
    expect(
      transaction.body.changes.find((change) => change.sourceId === "app")
        ?.patches,
    ).toEqual([
      {
        op: "set",
        path: ["scratchDirectory"],
        value: "/var/tmp/rac",
      },
    ]);
    const environmentChange = transaction.body.changes.find(
      (change) => change.sourceId === "env",
    );
    expect(environmentChange?.patches).toEqual([
      {
        op: "set",
        path: ["RAC_NOTES_FILE"],
        value: "/data/notes-next.json",
      },
    ]);
    expect(environmentChange?.migration).toEqual({ mode: "adopt" });
    await expect(
      page.getByRole("status", { name: "Restart pending", exact: true }),
    ).toBeVisible();
    expect(state.restarts).toBe(0);
  });
}

// keep Editor permanent while an empty command means omission
for (const width of [1440, 390]) {
  // cover saved and omitted Editor commands
  for (const configured of [false, true]) {
    test(`keeps Editor visible and resets by clearing at ${width}px with configured=${configured}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { settings, sources, state } = await setupSettings(page);
      const app = sources.find((source) => source.id === "app")!;
      const value = app.value as Record<string, unknown>;
      const schema = app.schema as { properties: Record<string, unknown> };
      schema.properties.editor = applicationSettingsSchema().properties!.editor!;
      // cover both saved commands and an initially omitted Editor
      if (configured) value.editor = "nvim --wait";
      else delete value.editor;
      await settings.getByRole("button", { name: "Refresh files", exact: true }).click();
      const editor = settings.getByRole("textbox", { name: "Editor", exact: true });
      await expect(editor).toBeEditable();
      await expect(editor).toHaveValue(configured ? "nvim --wait" : "");
      await expect(settings.getByRole("button", { name: /^(?:Add|Remove) Editor$/u })).toHaveCount(0);
      // clearing a temporary omitted command must leave no draft behind
      if (!configured) await editor.fill("nvim --temporary");
      await editor.fill("");
      await expect(editor).toHaveValue("");
      await expect(editor).toHaveAttribute("placeholder", "Disabled when unset");
      await expect(settings.getByRole("button", { name: /^(?:Add|Remove) Editor$/u })).toHaveCount(0);
      // an authored command clears by removing its source key rather than saving empty text
      if (configured) {
        await settings.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect.poll(() => state.saves.length).toBe(1);
        expect((state.saves[0] as { body: unknown }).body).toEqual({ changes: [{ sourceId: "app", revisionId: "app-r1", patches: [{ op: "remove", path: ["editor"] }] }] });
        await expect(editor).toBeEditable();
        await expect(editor).toHaveValue("");
      } else {
        await expect(settings.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
        expect(state.saves).toEqual([]);
      }
      // resetting the field must not hide it or prevent a replacement command
      await editor.fill("code --wait");
      await settings.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect.poll(() => state.saves.length).toBe(configured ? 2 : 1);
      const changes = (state.saves.at(-1) as { body: { changes: Array<{ sourceId: string; patches: SettingsPatch[] }> } }).body.changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]!.sourceId).toBe("app");
      const patches = changes[0]!.patches;
      // ordered drafts may retain prior reset boundaries but persist only the final command
      expect(patches.every((patch) => JSON.stringify(patch.path) === '["editor"]')).toBe(true);
      expect(patches.at(-1)).toEqual({ op: "set", path: ["editor"], value: "code --wait" });
      expect(patches.reduce<unknown>((current, patch) => applyPatch(current, patch), {})).toEqual({ editor: "code --wait" });
      await expect(editor).toHaveValue("code --wait");
      await expect(settings.getByRole("button", { name: /^(?:Add|Remove) Editor$/u })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

// clear an authored scratch path back to the omitted host-home default
test("removes an authored Scratch directory without hiding its field", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app } = configureStorageFixture(sources);
  (app.value as Record<string, unknown>).scratchDirectory = "/var/tmp/authored";
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "storage", "Storage");
  const scratch = settings.getByRole("textbox", {
    name: "Scratch directory",
    exact: true,
  });
  await expect(scratch).toHaveValue("/var/tmp/authored");
  await scratch.fill("");
  await expect(scratch).toHaveValue("");
  await expect(scratch).toHaveAttribute(
    "placeholder",
    "/home/test (from host home)",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (
      state.saves[0] as {
        body: {
          changes: Array<{
            sourceId: string;
            patches?: Array<{ op: string; path: string[]; value?: unknown }>;
          }>;
        };
      }
    ).body.changes,
  ).toEqual([
    {
      sourceId: "app",
      revisionId: "app-r1",
      patches: [{ op: "remove", path: ["scratchDirectory"] }],
    },
  ]);
  await expect(
    settings.getByRole("textbox", { name: "Scratch directory", exact: true }),
  ).toBeVisible();
  expect(state.restarts).toBe(0);
});

// cancel a temporary omitted-value edit without retaining an ineffective remove
test("treats typing then clearing an omitted Scratch directory as a no-op", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  configureStorageFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "storage", "Storage");
  const scratch = settings.getByRole("textbox", {
    name: "Scratch directory",
    exact: true,
  });
  await scratch.fill("/var/tmp/temporary");
  await scratch.fill("");
  await expect(scratch).toHaveValue("");
  await expect(scratch).toHaveAttribute(
    "placeholder",
    "/home/test (from host home)",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.validations).toEqual([]);
  expect(state.saves).toEqual([]);
});

// lock the two Storage sources independently across representation and availability changes
test("keeps Storage source locks independent", async ({ page }) => {
  const { settings, sources, state } = await setupSettings(page);
  const { app, env } = configureStorageFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();

  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await selectSettingsSection(settings, "storage", "Storage");
  await expect(
    settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true }),
  ).toBeEditable();

  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await selectSettingsSection(settings, "storage", "Storage");
  await expect(
    settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true }),
  ).toBeDisabled();

  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Use structured editor", exact: true })
    .click();
  app.writable = false;
  env.writable = true;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "storage", "Storage");
  await expect(
    settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true }),
  ).toBeEditable();

  app.writable = true;
  env.writable = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    settings.getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true }),
  ).toBeDisabled();

  sources.splice(sources.indexOf(env), 1);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByRole("textbox", {
      name: "Scratch directory",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    settings.locator('[data-settings-path="RAC_NOTES_FILE"]'),
  ).toHaveCount(0);

  sources.push(env);
  sources.splice(sources.indexOf(app), 1);
  env.writable = true;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.locator('[data-settings-path="scratchDirectory"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("textbox", { name: "RAC_NOTES_FILE", exact: true }),
  ).toBeEditable();
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
  expect(labels.indexOf("Interface")).toBe(
    labels.indexOf("Application") + 1,
  );
  expect(labels.indexOf("Agents")).toBe(labels.indexOf("Interface") + 1);
  expect(labels.indexOf("Projects")).toBe(labels.indexOf("Agents") + 1);
  expect(labels.indexOf("Reviews")).toBe(labels.indexOf("Projects") + 1);
  expect(labels.indexOf("TMUX")).toBe(labels.indexOf("Reviews") + 1);
  expect(labels.indexOf("Storage")).toBe(labels.indexOf("TMUX") + 1);

  await selectSettingsSection(settings, "app", "Application config");
  await expect(settings.locator('[data-settings-path="projects"]')).toHaveCount(
    0,
  );
  await selectSettingsSection(settings, "projects", "Projects");
  await expect(
    settings.getByRole("switch", { name: "Dynamic worktrees" }),
  ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="projects"]'),
  ).toBeVisible();
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

// keep global and project button definitions on their dedicated pages
test("moves custom buttons to Interface and keeps project overrides in Projects", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app")!;
  application.value = {
    ...application.value,
    buttons: structuredClone(defaultButtons),
  };
  application.schema.properties.buttons = authoritativeButtonsSchema;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(settings.locator('[data-settings-path="buttons"]')).toHaveCount(
    0,
  );
  await selectSettingsSection(settings, "interface", "Interface");
  await expect(
    settings.getByRole("region", {
      name: "Interface settings content",
      exact: true,
    }),
  ).toContainText("Custom buttons");
  const globalButtons = settings.locator('[data-settings-path="buttons"]');
  await expect(globalButtons).toBeVisible();
  await expectSplitButtonLabels(
    globalButtons.locator('[data-settings-path="buttons.splits"]'),
  );
  // omit redundant ordering guidance from application button lists
  await expect(settings.getByText("Buttons appear in this order.", { exact: true })).toHaveCount(0);
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  await expect(
    project.locator('[data-settings-path="projects.0.buttons"]'),
  ).toBeVisible();
  await expectSplitButtonLabels(
    project.locator('[data-settings-path="projects.0.buttons.splits"]'),
  );
  // keep project override lists free of the same helper copy
  await expect(settings.getByText("Buttons appear in this order.", { exact: true })).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// preserve passive previews while ordered split rows change
test("keeps global and project split previews ordered through row controls", async ({
  page,
}) => {
  const actionRequests: string[] = [];
  // record only configured action execution attempts
  page.on("request", (request) => {
    // ignore ordinary Settings traffic
    if (new URL(request.url()).pathname === "/api/button-actions")
      actionRequests.push(request.method());
  });
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app")!;
  const buttons = structuredClone(defaultButtons);
  buttons.splits.agent = [
    { ...structuredClone(defaultButtons.pullRequest[0]!), text: "Agent first" },
    { ...structuredClone(defaultButtons.pullRequest[1]!), text: "Agent second" },
  ];
  const projects = (
    application.value?.projects as Array<Record<string, unknown>>
  ).map((project, index) =>
    index === 0
      ? {
          ...project,
          buttons: {
            splits: {
              terminal: [
                {
                  ...structuredClone(defaultButtons.pullRequest[0]!),
                  text: "Project terminal first",
                },
                {
                  ...structuredClone(defaultButtons.pullRequest[1]!),
                  text: "Project terminal second",
                },
              ],
            },
          },
        }
      : project,
  );
  application.value = { ...application.value, buttons, projects };
  application.schema.properties.buttons = authoritativeButtonsSchema;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "interface", "Interface");
  const agent = settings.locator(
    '[data-settings-path="buttons.splits.agent"]',
  );
  const agentRows = agent.locator('[data-settings-entry-index]');
  await expect(agentRows).toHaveCount(2);
  // keep every collapsed global row preview-only
  for (const row of await agentRows.all()) {
    await expect(
      row
        .locator(":scope > .settings-collection-entry-header")
        .getByRole("group", { name: "Button preview" }),
    ).toHaveCount(1);
    await expect(row.locator(".settings-collection-summary")).toHaveCount(0);
    await expect(row.locator(".settings-collection-editor")).toHaveCount(0);
  }
  const agentLabels = agentRows.locator(".configured-button-label");
  await expect(agentLabels).toHaveText(["Agent first", "Agent second"]);
  await agent
    .getByRole("button", { name: "Move Agent 2 up", exact: true })
    .click();
  await expect(agentLabels).toHaveText(["Agent second", "Agent first"]);
  await agent
    .getByRole("button", { name: "Remove Agent 1", exact: true })
    .click();
  await expect(agentLabels).toHaveText(["Agent first"]);

  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings
    .getByRole("group", { name: "Project 1", exact: true })
    .first();
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  const terminal = project.locator(
    '[data-settings-path="projects.0.buttons.splits.terminal"]',
  );
  const terminalRows = terminal.locator('[data-settings-entry-index]');
  await expect(terminalRows).toHaveCount(2);
  // keep every collapsed project row preview-only
  for (const row of await terminalRows.all()) {
    await expect(
      row
        .locator(":scope > .settings-collection-entry-header")
        .getByRole("group", { name: "Button preview" }),
    ).toHaveCount(1);
    await expect(row.locator(".settings-collection-summary")).toHaveCount(0);
    await expect(row.locator(".settings-collection-editor")).toHaveCount(0);
  }
  const terminalLabels = terminalRows.locator(".configured-button-label");
  await expect(terminalLabels).toHaveText([
    "Project terminal first",
    "Project terminal second",
  ]);
  await terminal
    .getByRole("button", { name: "Move Terminal 2 up", exact: true })
    .click();
  await expect(terminalLabels).toHaveText([
    "Project terminal second",
    "Project terminal first",
  ]);
  await terminal
    .getByRole("button", { name: "Remove Terminal 1", exact: true })
    .click();
  await expect(terminalLabels).toHaveText(["Project terminal first"]);
  await terminal
    .getByRole("group", { name: "Button preview" })
    .locator(".configured-button")
    .dispatchEvent("click");
  expect(actionRequests).toEqual([]);
  expect(state.saves).toEqual([]);
});

// preview button appearance without executing its configured action
test("previews button edits with accessible switches and every configured color", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const actionRequests: string[] = [];
  const consoleErrors: string[] = [];
  // record only configured action execution attempts
  page.on("request", (request) => {
    // ignore every ordinary Settings request
    if (new URL(request.url()).pathname === "/api/button-actions")
      actionRequests.push(request.method());
  });
  // retain rendered browser failures for the final assertion
  page.on("console", (message) => {
    // collect only browser errors
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app")!;
  application.value = {
    ...application.value,
    buttons: structuredClone(defaultButtons),
  };
  application.schema.properties.buttons = authoritativeButtonsSchema;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "interface", "Interface");
  const pullRequest = settings.locator(
    '[data-settings-path="buttons.pullRequest"]',
  );
  const row = pullRequest.locator('[data-settings-entry-index="0"]');
  const header = row.locator(":scope > .settings-collection-entry-header");
  const preview = header.getByRole("group", {
    name: "Button preview",
    exact: true,
  });
  const previewButton = preview.locator(".configured-button");
  await expect(row).toHaveAttribute("data-settings-editing", "false");
  await expect(row.getByRole("group", { name: "Button preview" })).toHaveCount(
    1,
  );
  await expect(header.locator(".settings-collection-summary")).toHaveCount(0);
  await expect(row.locator(".settings-collection-editor")).toHaveCount(0);
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await expect(previewButton).toBeDisabled();
  await expect(previewButton).toHaveText("Commit/Push");
  await row
    .getByRole("button", { name: "Edit Button 1", exact: true })
    .click();
  await expect(row).toHaveAttribute("data-settings-editing", "true");
  const editor = row.locator(":scope > .settings-collection-editor");
  await expect(
    editor.getByRole("group", { name: "Button preview", exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole("heading", { name: "Button", exact: true }),
  ).toHaveCount(0);

  await editor
    .getByRole("textbox", { name: "Button text", exact: true })
    .fill("Ship safely");
  await expect(previewButton).toHaveText("Ship safely");
  await editor
    .getByRole("textbox", { name: "Button icon path", exact: true })
    .fill("M4 12h16");
  await expect(previewButton.locator("svg path")).toHaveAttribute(
    "d",
    "M4 12h16",
  );

  const color = editor.getByRole("combobox", {
    name: "Button color",
    exact: true,
  });
  const selectedSwatch = color.locator(".settings-button-color-swatch");
  await color.click();
  const colorOptions = page.getByRole("listbox", {
    name: "Button color options",
    exact: true,
  });
  await expect(colorOptions.getByRole("option")).toHaveCount(
    buttonColors.length,
  );
  await expect(
    colorOptions.locator(".settings-button-color-swatch"),
  ).toHaveCount(buttonColors.length);
  // verify every configured palette row and its live style
  for (const buttonColor of buttonColors) {
    const option = colorOptions.getByRole("option", {
      name: buttonColor,
      exact: true,
    });
    await expect(option).toBeVisible();
    const appearance = await option
      .locator(".settings-button-color-swatch")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.borderTopColor,
        };
      });
    expect(appearance.background).toBe(appearance.border);
    expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
  }
  await colorOptions
    .locator('[role="option"][data-value="green"]')
    .click();
  const solidAppearance = await previewButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
    };
  });
  const solidSwatch = await selectedSwatch.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
    };
  });
  expect(solidAppearance.background).toBe(solidSwatch.background);
  expect(solidAppearance.border).toBe(solidSwatch.border);
  expect(solidAppearance.background).not.toBe("rgba(0, 0, 0, 0)");

  const buttonStyle = editor.getByRole("switch", {
    name: "Button style",
    exact: true,
  });
  await expect(buttonStyle).toHaveAttribute("aria-checked", "true");
  await buttonStyle.click();
  await expect(buttonStyle).toHaveAttribute("aria-checked", "false");
  await expect(previewButton).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  expect(await previewButton.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  await color.click();
  // verify the entire popup follows the staged outline choice
  for (const buttonColor of buttonColors) {
    const option = colorOptions.getByRole("option", {
      name: buttonColor,
      exact: true,
    });
    await expect(option).toBeVisible();
    const appearance = await option
      .locator(".settings-button-color-swatch")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.borderTopColor,
        };
      });
    expect(appearance.background).toBe("rgba(0, 0, 0, 0)");
    expect(appearance.border).not.toBe("rgba(0, 0, 0, 0)");
  }
  await page.keyboard.press("Escape");

  const actionType = editor.getByRole("switch", {
    name: "Action type",
    exact: true,
  });
  await expect(actionType).toHaveAttribute("aria-checked", "true");
  await actionType.click();
  await expect(actionType).toHaveAttribute("aria-checked", "false");
  await expect(
    editor.getByRole("textbox", { name: "Shell command", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("textbox", { name: "Agent prompt", exact: true }),
  ).toHaveCount(0);
  await actionType.click();
  await expect(actionType).toHaveAttribute("aria-checked", "true");
  await expect(
    editor.getByRole("textbox", { name: "Agent prompt", exact: true }),
  ).toBeVisible();
  await previewButton.dispatchEvent("click");
  expect(actionRequests).toEqual([]);
  await row
    .getByRole("button", { name: "Close Button 1", exact: true })
    .click();
  await expect(row).toHaveAttribute("data-settings-editing", "false");
  await expect(row.locator(".settings-collection-editor")).toHaveCount(0);
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await expect(row.getByRole("group", { name: "Button preview" })).toHaveCount(
    1,
  );
  await expect(previewButton).toHaveText("Ship safely");
  await expect(previewButton.locator("svg path")).toHaveAttribute(
    "d",
    "M4 12h16",
  );
  await expect(previewButton).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await row
    .getByRole("button", { name: "Edit Button 1", exact: true })
    .click();
  await expect(row).toHaveAttribute("data-settings-editing", "true");
  await expect(
    editor.getByRole("textbox", { name: "Button text", exact: true }),
  ).toHaveValue("Ship safely");
  await expect(
    editor.getByRole("textbox", { name: "Button icon path", exact: true }),
  ).toHaveValue("M4 12h16");
  await expect(editor.getByRole("switch", { name: "Button style" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(editor.getByRole("switch", { name: "Action type" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({
    path: "/tmp/remoteagents-settings-button-preview-desktop.png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeVisible();
  await expect(buttonStyle).toBeVisible();
  await expect(actionType).toBeVisible();
  const [editorBox, previewBox] = await Promise.all([
    editor.boundingBox(),
    preview.boundingBox(),
  ]);
  expect(editorBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.width).toBeLessThanOrEqual(editorBox!.width + 1);
  await row.screenshot({
    path: "/tmp/remoteagents-settings-button-preview-mobile.png",
  });
  expect(state.saves).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// keep optional button artwork directly editable and resettable
test("keeps button icon fields permanent and saves blank icons as removals", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app")!;
  application.value = {
    ...application.value,
    buttons: structuredClone(defaultButtons),
  };
  application.schema.properties.buttons = authoritativeButtonsSchema;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "interface", "Interface");
  const pullRequest = settings.locator(
    '[data-settings-path="buttons.pullRequest"]',
  );
  await pullRequest
    .getByRole("button", { name: "Edit Button 2", exact: true })
    .click();
  const absentRow = pullRequest.locator(
    '[data-settings-entry-index="1"]',
  );
  const absentEditor = absentRow.locator(
    ":scope > .settings-collection-editor",
  );
  const absentIcon = absentEditor.getByRole("textbox", {
    name: "Button icon path",
    exact: true,
  });
  const absentPreview = absentRow
    .locator(":scope > .settings-collection-entry-header")
    .getByRole("group", { name: "Button preview", exact: true });
  await expect(absentRow.getByRole("group", { name: "Button preview" })).toHaveCount(
    1,
  );
  await expect(
    absentEditor.getByRole("group", { name: "Button preview" }),
  ).toHaveCount(0);
  await expect(absentIcon).toHaveValue("");
  await expect(absentIcon).toHaveAttribute("placeholder", "No icon");
  await expect(absentPreview.locator("svg")).toHaveCount(0);
  await expect(
    absentEditor.getByRole("button", {
      name: /^(?:Add|Remove) Button icon path$/u,
    }),
  ).toHaveCount(0);
  await absentIcon.fill("M3 12h18");
  await expect(absentPreview.locator("svg path")).toHaveAttribute(
    "d",
    "M3 12h18",
  );
  await absentIcon.fill("");
  await expect(absentPreview.locator("svg")).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);

  await pullRequest
    .getByRole("button", { name: "Close Button 2", exact: true })
    .click();
  await pullRequest
    .getByRole("button", { name: "Edit Button 1", exact: true })
    .click();
  const savedRow = pullRequest.locator('[data-settings-entry-index="0"]');
  const savedEditor = savedRow.locator(
    ":scope > .settings-collection-editor",
  );
  const savedIcon = savedEditor.getByRole("textbox", {
    name: "Button icon path",
    exact: true,
  });
  await expect(savedIcon).not.toHaveValue("");
  await savedIcon.fill("");
  await expect(
    savedRow
      .getByRole("group", { name: "Button preview", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{ sourceId: string; patches: SettingsPatch[] }>;
    };
  };
  expect(
    save.body.changes.find((change) => change.sourceId === "app")?.patches,
  ).toContainEqual({
    op: "remove",
    path: ["buttons", "pullRequest", "0", "icon"],
  });
});

// materialize inherited defaults before removing their inherited icon
test("clears an inherited default button icon when buttons are omitted", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app")!;
  application.schema.properties.buttons = authoritativeButtonsSchema;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "interface", "Interface");
  const pullRequest = settings.locator(
    '[data-settings-path="buttons.pullRequest"]',
  );
  await pullRequest
    .getByRole("button", { name: "Edit Button 1", exact: true })
    .click();
  const row = pullRequest.locator('[data-settings-entry-index="0"]');
  const editor = row.locator(":scope > .settings-collection-editor");
  const icon = editor.getByRole("textbox", {
    name: "Button icon path",
    exact: true,
  });
  await expect(icon).not.toHaveValue("");
  await icon.fill("");
  await expect(
    row
      .getByRole("group", { name: "Button preview", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const save = state.saves[0] as {
    body: {
      changes: Array<{ sourceId: string; patches: SettingsPatch[] }>;
    };
  };
  const patches = save.body.changes.find(
    (change) => change.sourceId === "app",
  )?.patches;
  expect(patches).toContainEqual({
    op: "remove",
    path: ["buttons", "pullRequest", "0", "icon"],
  });
  const savedButtons = application.value?.buttons as {
    pullRequest: Array<Record<string, unknown>>;
  };
  expect(savedButtons.pullRequest[0]).not.toHaveProperty("icon");
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
  const changes = (
    state.saves[0] as {
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
    }
  ).body.changes;
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
          patch.op === "set" && patch.path.join(".") === "projects.0.id",
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
  await expect(
    settings.getByText(reservedMessage, { exact: true }),
  ).toHaveCount(0);

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
  await expect(
    settings.getByText(reservedMessage, { exact: true }),
  ).toHaveCount(0);
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
  await selectSettingsSection(settings, "agents", "Agents");
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
    await expect(
      adapter.getByText("Unimplemented", { exact: true }),
    ).toBeVisible();
    for (const control of await adapter
      .locator("input, textarea, button")
      .all())
      await expect(control).toBeDisabled();
  }
  await panel
    .locator('[data-settings-path="adapters.pi"]')
    .scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unimplemented-adapters-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await panel
    .locator('[data-settings-path="adapters.pi"]')
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unimplemented-adapters-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await selectSettingsSection(settings, "app", "Application config");
  await panel
    .getByLabel("Shell command", { exact: true })
    .fill("/usr/bin/agent");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const appChange = (
    state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          patches?: Array<{ path: string[]; value?: unknown }>;
        }>;
      };
    }
  ).body.changes.find((change) => change.sourceId === "app");
  expect(appChange?.patches).toEqual([
    { op: "set", path: ["adapter", "command"], value: "/usr/bin/agent" },
  ]);
  expect(appChange?.patches?.some((patch) => patch.path[0] === "proxy")).toBe(
    false,
  );
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: "/tmp/remoteagents-settings-unused-fields-mobile.png",
  });
  expect(consoleErrors).toEqual([]);
});

// inherit each project's live path without authoring a host override
test("uses live Project path placeholders for Docker Host path overrides", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const app = sources.find((source) => source.id === "app")!;
  const value = app.value as { projects: Array<{ hostPath?: string }> };
  value.projects[1]!.hostPath = "/host/beacon";
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "projects", "Projects");
  const atlas = settings.getByRole("group", { name: "Project 1", exact: true });
  const beacon = settings.getByRole("group", {
    name: "Project 2",
    exact: true,
  });
  await atlas
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  await beacon
    .getByRole("button", { name: "Edit Project 2", exact: true })
    .click();
  const atlasPath = atlas.getByLabel("Path", { exact: true });
  const atlasHost = atlas.getByLabel("Host Path", { exact: true });
  const beaconHost = beacon.getByLabel("Host Path", { exact: true });
  await expect(atlasHost).toHaveValue("");
  await expect(atlasHost).toHaveAttribute(
    "placeholder",
    "/code/atlas (from Project Path)",
  );
  await expect(beaconHost).toHaveValue("/host/beacon");
  await expect(beaconHost).toHaveAttribute(
    "placeholder",
    "/code/beacon (from Project Path)",
  );
  expect(state.saves).toEqual([]);
  await atlasPath.fill("");
  await expect(atlasHost).toHaveAttribute(
    "placeholder",
    "Unavailable (from Project Path)",
  );
  await atlasPath.fill("/code/atlas-renamed");
  await expect(atlasHost).toHaveAttribute(
    "placeholder",
    "/code/atlas-renamed (from Project Path)",
  );
  await expect(atlasHost).toHaveValue("");
  await expect(beaconHost).toHaveValue("/host/beacon");
  await expect(beaconHost).toHaveAttribute(
    "placeholder",
    "/code/beacon (from Project Path)",
  );
  await beacon.getByLabel("Path", { exact: true }).fill("/code/beacon-renamed");
  await expect(beaconHost).toHaveValue("/host/beacon");
  await expect(beaconHost).toHaveAttribute(
    "placeholder",
    "/code/beacon-renamed (from Project Path)",
  );
  await atlasHost.scrollIntoViewIfNeeded();
  await settings.screenshot({
    path: "/tmp/remoteagents-project-host-path-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await atlasHost.scrollIntoViewIfNeeded();
  await expect(atlasHost).toHaveAttribute(
    "placeholder",
    "/code/atlas-renamed (from Project Path)",
  );
  await settings.screenshot({
    path: "/tmp/remoteagents-project-host-path-mobile.png",
  });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({
    body: {
      changes: [
        {
          sourceId: "app",
          patches: [
            {
              op: "set",
              path: ["projects", "0", "path"],
              value: "/code/atlas-renamed",
            },
            {
              op: "set",
              path: ["projects", "1", "path"],
              value: "/code/beacon-renamed",
            },
          ],
        },
      ],
    },
  });
});

// hide Docker-only controls without deleting existing native source values
test("hides native Project Host path controls and preserves saved overrides", async ({
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
    true,
  );
  const app = sources.find((source) => source.id === "app")!;
  const value = app.value as { projects: Array<{ hostPath?: string }> };
  value.projects[0]!.hostPath = "/host/atlas";
  app.content = JSON.stringify(value);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "projects", "Projects");
  const project = settings.getByRole("group", {
    name: "Project 1",
    exact: true,
  });
  await project
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  await expect(
    project.locator('[data-settings-path="projects.0.hostPath"]'),
  ).toHaveCount(0);
  await expect(project.getByLabel("Path", { exact: true })).toHaveValue(
    "/code/atlas",
  );
  const search = settings.getByRole("searchbox", {
    name: "Search settings",
    exact: true,
  });
  await search.fill("Host path");
  await expect(
    page
      .getByRole("listbox", { name: "Settings search results", exact: true })
      .locator(".settings-search-result-title > strong")
      .filter({ hasText: /^Host Path$/u }),
  ).toHaveCount(0);
  await search.fill("");
  await project
    .locator('[data-settings-path="projects.0.label"]')
    .getByLabel("Label", { exact: true })
    .fill("Atlas renamed");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({
    body: {
      changes: [
        {
          sourceId: "app",
          patches: [
            {
              op: "set",
              path: ["projects", "0", "label"],
              value: "Atlas renamed",
            },
          ],
        },
      ],
    },
  });
  await selectSettingsSection(settings, "app", "Application config");
  await settings
    .getByRole("button", { name: "Edit base file", exact: true })
    .click();
  await expect(
    settings.getByLabel("Application config source content", { exact: true }),
  ).toHaveValue(/"hostPath":"\/host\/atlas"/u);
});

// keep file-only preview settings out of the project editor
test("shows Project placeholders and omits untouched optional blanks on save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app") as {
    value: { projects: Array<{ label?: string }> };
  };
  delete application.value.projects[0]!.label;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
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
  const id = project
    .locator('[data-settings-path="projects.0.id"]')
    .getByLabel("Id", { exact: true });
  await expect(label).toHaveValue("");
  await expect(label).toHaveAttribute(
    "placeholder",
    "atlas (from Project ID)",
  );
  await expect(id).toHaveValue("atlas");
  await id.fill("atlas-live");
  await expect(label).toHaveAttribute(
    "placeholder",
    "atlas-live (from Project ID)",
  );
  await id.fill("atlas");
  await expect(
    project
      .locator('[data-settings-path="projects.0.path"]')
      .getByLabel("Path", { exact: true }),
  ).toHaveValue("/code/atlas");
  await expect(hostPath).toHaveValue("");
  await expect(hostPath).toHaveAttribute(
    "placeholder",
    "/code/atlas (from Project Path)",
  );
  await expect(
    project.locator('[data-settings-path="projects.0.port"]'),
  ).toHaveCount(0);
  await expect(
    project.locator('[data-settings-path="projects.0.hostname"]'),
  ).toHaveCount(0);
  await expect(
    project.locator('[data-settings-path="projects.0.defaultBranch"] input'),
  ).toHaveAttribute(
    "placeholder",
    "Unavailable (from resolved branch)",
  );
  await expect(
    project.locator('[data-settings-path="projects.0.push"]'),
  ).toHaveCount(0);
  await expect(
    project
      .locator("small, p")
      .filter({ hasText: /leave blank|blank uses|omit this|default action/iu }),
  ).toHaveCount(0);
  const projectProperties = authoritativeProjectsSchema.items!.properties!;
  // require every remaining declared project control
  for (const key of Object.keys(projectProperties))
    await expect(
      project.locator(`[data-settings-path="projects.0.${key}"]`),
    ).toBeVisible();
  // compare static copy separately from the file-managed preview state
  for (const description of Object.entries(projectProperties)
    .filter(([key]) => key !== "externalUrl")
    .map(([, schema]) => schema.description)
    .filter((value): value is string => value !== undefined))
    await expect(project.getByText(description, { exact: true })).toBeVisible();
  await expect(
    project.locator('[data-settings-path="projects.0.externalUrl"]'),
  ).toContainText("Use Application’s Edit base file action to change it.");
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
  await expect(
    worktreeOrder.locator(".settings-collection-add-button"),
  ).toBeVisible();
  await expect(
    project
      .locator('[data-settings-path="projects.0.worktreeOverrides"]')
      .locator(".settings-collection-add-button"),
  ).toBeVisible();
  const processes = project.locator(
    '[data-settings-path="projects.0.commands.processes"]',
  );
  await expect(
    processes.getByRole("textbox", { name: "New key" }),
  ).toBeVisible();
  await expect(
    processes.getByRole("button", { name: "Add entry" }),
  ).toBeDisabled();
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
  const patches = (
    state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
    }
  ).body.changes.find((change) => change.sourceId === "app")?.patches;
  expect(patches).toEqual([
    {
      op: "set",
      path: ["projects", "0", "label"],
      value: "Atlas renamed",
    },
  ]);
});

// show inheritance only while a complete checkout command override is absent
test("keeps inherited command placeholders out of authored Worktree overrides", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app") as {
    value: { projects: Array<Record<string, unknown>> };
  };
  application.value.projects[0]!.commands = {
    start: "pnpm start",
    stop: "pnpm stop",
  };
  delete application.value.projects[0]!.port;
  application.value.projects[0]!.externalUrl = "https://atlas.example.test";
  application.value.projects[0]!.worktreeOverrides = [
    { path: "feature" },
    { path: "explicit-empty", commands: {} },
  ];
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "projects", "Projects");
  await settings
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  const overrides = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides"]',
  );
  await overrides.locator(".settings-collection-edit").first().click();
  const prefix = "projects.0.worktreeOverrides.0";
  await expect(
    settings.locator(`[data-settings-path="${prefix}.hostname"]`),
  ).toHaveCount(0);
  await expect(
    settings.locator(`[data-settings-path="${prefix}.port"]`),
  ).toHaveCount(0);
  // find command textboxes independently of the code editor's native element
  const start = settings
    .locator(`[data-settings-path="${prefix}.commands.start"]`)
    .getByRole("textbox", { name: "Start", exact: true });
  const stop = settings
    .locator(`[data-settings-path="${prefix}.commands.stop"]`)
    .getByRole("textbox", { name: "Stop", exact: true });
  await expect(start).toHaveValue("");
  await expect(start).toHaveAttribute(
    "placeholder",
    "pnpm start (from Project Start command)",
  );
  await expect(stop).toHaveAttribute(
    "placeholder",
    "pnpm stop (from Project Stop command)",
  );
  const overridePreview = settings.locator(
    `[data-settings-path="${prefix}.externalUrl"] input`,
  );
  await expect(overridePreview).toHaveAttribute(
    "placeholder",
    "https://atlas.example.test (from Project External URL)",
  );
  const projectPreview = settings.locator(
    '[data-settings-path="projects.0.externalUrl"] input',
  );
  await projectPreview.fill("https://draft.example.test");
  await expect(overridePreview).toHaveAttribute(
    "placeholder",
    "https://draft.example.test (from Project External URL)",
  );
  await projectPreview.fill("https://atlas.example.test");
  // inheritance is not a suggested process key
  await expect(
    settings.locator(
      `[data-settings-path="${prefix}.commands.processes"] input`,
    ),
  ).not.toHaveAttribute("placeholder", /Project/u);
  await start.fill("pnpm dev");
  await expect(stop).toHaveAttribute(
    "placeholder",
    "Not configured when unset",
  );
  await overrides.locator(".settings-collection-edit").nth(1).click();
  const explicitEmptyStart = settings
    .locator(
      '[data-settings-path="projects.0.worktreeOverrides.1.commands.start"]',
    )
    .getByRole("textbox", { name: "Start", exact: true });
  await expect(explicitEmptyStart).toHaveAttribute(
    "placeholder",
    "Not configured when unset",
  );
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    (state.saves[0] as { body: { changes: Array<{ patches: unknown[] }> } })
      .body.changes[0]!.patches,
  ).toEqual([
    {
      op: "set",
      path: ["projects", "0", "worktreeOverrides", "0", "commands", "start"],
      value: "pnpm dev",
    },
  ]);
});

// preserve existing file-managed previews without exposing their proxy selectors
test("keeps existing Project and Worktree proxy previews file-only", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    true,
    false,
    false,
    [],
    "none",
    "compose",
    true,
  );
  const application = sources.find((source) => source.id === "app") as {
    value: { projects: Array<Record<string, unknown>> };
  };
  application.value.projects[0]!.hostname = "atlas.example.test";
  application.value.projects[0]!.worktreeOverrides = [
    { path: "feature", hostname: "feature.example.test", port: 3001 },
  ];
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "projects", "Projects");
  await settings
    .getByRole("button", { name: "Edit Project 1", exact: true })
    .click();
  const externalUrl = settings.locator(
    '[data-settings-path="projects.0.externalUrl"] input',
  );
  await expect(externalUrl).toBeDisabled();
  await expect(externalUrl).toHaveAttribute(
    "placeholder",
    "Managed in application file",
  );
  await expect(
    settings.locator('[data-settings-path="projects.0.externalUrl"]'),
  ).toContainText("Use Application’s Edit base file action to change it.");
  const overrides = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides"]',
  );
  await overrides.locator(".settings-collection-edit").click();
  const override = settings.locator(
    '[data-settings-path="projects.0.worktreeOverrides.0.externalUrl"]',
  );
  await expect(override.locator("input")).toBeDisabled();
  await expect(
    override.getByRole("button", {
      name: "Set External URL to null",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Edit Project 2", exact: true })
    .click();
  await expect(
    settings.locator('[data-settings-path="projects.1.externalUrl"] input'),
  ).toBeEditable();
  expect(state.saves).toEqual([]);
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
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);

  const processes = project.locator(
    '[data-settings-path="projects.0.commands.processes"]',
  );
  await processes
    .getByRole("button", { name: "Remove web", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = (
    state.saves[0] as {
      body: {
        changes: Array<{
          sourceId: string;
          patches?: Array<{ op: string; path: string[]; value?: unknown }>;
        }>;
      };
    }
  ).body.changes.find((change) => change.sourceId === "app")?.patches;
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
  await expect(
    panel.getByRole("heading", { name: "Host", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByLabel("Checkout", { exact: true })).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Add Host" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Remove Host" })).toHaveCount(
    0,
  );
  await expect(
    panel.locator('[data-settings-path="sources.icons"]'),
  ).toHaveCount(0);
  await expect(panel.getByLabel("Heart icon", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Potato icon", { exact: true })).toHaveCount(0);

  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const raw = panel.getByLabel("Installation source content");
  await expect(raw).toHaveValue(/"version":1/u);
  await expect(raw).toHaveValue(/"icons":\{"heart":/u);
});

for (const [
  installationKind,
  selectedPath,
  otherPath,
  selectedLabel,
  otherLabel,
] of [
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
    await expect(
      panel.getByRole("heading", { name: "Host", exact: true }),
    ).toHaveCount(0);
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
    await expect(
      panel.locator(`[data-settings-path="${otherPath}"]`),
    ).toHaveCount(0);
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
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Edit whole source", exact: true })
      .click();
    const raw = panel.getByLabel("Installation source content", {
      exact: true,
    });
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
  await expect(
    settings.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toBeVisible();
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
  await expect(
    panel.getByRole("heading", { name: "Installation" }),
  ).toBeVisible();
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
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
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
});

// keep Docker file metadata visible without exposing it as a structured mutation
test("keeps Docker options permanent and file-only", async ({ page }) => {
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
  await expect(
    panel.locator('[data-settings-path="compose.profiles"]'),
  ).toHaveCount(0);
  const options = panel.locator('[data-settings-path="compose.options"]');
  const parallel = panel
    .locator('[data-settings-path="compose.options.parallel"]')
    .getByRole("spinbutton");
  const compatibility = panel
    .locator('[data-settings-path="compose.options.compatibility"]')
    .getByRole("switch");
  await expect(options).toBeVisible();
  await expect(parallel).toHaveValue("");
  await expect(parallel).toHaveAttribute("placeholder", "-1 (from Docker Compose default; unlimited)");
  await expect(parallel).toBeDisabled();
  await expect(compatibility).not.toBeChecked();
  await expect(compatibility).toBeDisabled();
  await expect(
    options
      .locator("small, p")
      .filter({ hasText: /unlimited|leave off|default/iu }),
  ).toHaveCount(0);
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
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await selectSettingsSection(settings, "compose-override", "Docker");
  await selectSettingsSection(settings, "installation", "Installation");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toHaveLength(0);

  await options.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/remoteagents-settings-installation-options-desktop.png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await options.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
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
  await expect(
    panel.locator('[data-settings-path="compose.profiles"]'),
  ).toHaveCount(0);
  await expect(parallel).toHaveValue("6");
  await expect(parallel).toBeDisabled();
  await expect(compatibility).toBeChecked();
  await expect(compatibility).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
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
  const entry = composeFiles
    .locator(".settings-array-list > .settings-array-entry")
    .nth(2);
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
          buttonRect.left +
            buttonRect.width / 2 -
            (iconRect.left + iconRect.width / 2),
        ),
        centerDeltaY: Math.abs(
          buttonRect.top +
            buttonRect.height / 2 -
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
    nav.getByRole("button", { name: /^Application.*Unsaved changes$/u }),
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
  await expect(
    heartDetails.getByLabel("Heart icon path", { exact: true }),
  ).toBeDisabled();
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
  await expect(
    settings.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toBeEnabled();
  await expect(
    settings.locator('[data-settings-path="sources.wrapper"]'),
  ).toHaveCount(0);
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
  const envRaw = settings.getByLabel("Environment & keys source content");
  const envDraft = `${await envRaw.inputValue()}# retained environment draft\n`;
  await envRaw.fill(envDraft);
  await selectSettingsSection(settings, "tmux", "TMUX");
  await expect(
    settings.getByLabel("RAC_TMUX_BIN", { exact: true }),
  ).toBeDisabled();
  await expect(
    settings.locator('[data-settings-path="sources.wrapper"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByLabel("Installation wrapper source content"),
  ).toHaveAttribute("readonly", "");

  // raw Installation repair retains legacy metadata without replacing the installed wrapper source
  await selectSettingsSection(settings, "installation", "Installation");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  const installationRaw = settings.getByLabel("Installation source content");
  await expect(installationRaw).toHaveValue(/"sources":\{"wrapper":/u);
  const installationDraft =
    '{"native":{"environmentFile":"/checkout/.env"},"compose":{"projectName":"rac"},"sources":{"wrapper":"/checkout/config/raw-wrapper.sh"}}\n';
  await installationRaw.fill(installationDraft);
  await selectSettingsSection(settings, "tmux", "TMUX");
  await expect(
    settings.locator('[data-settings-path="sources.wrapper"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByLabel("Installation wrapper source content"),
  ).toHaveAttribute("readonly", "");
  await selectSettingsSection(settings, "app", "Application config");
  await expect(
    settings.getByLabel("Application config source content"),
  ).toHaveValue(appDraft);
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
  await selectSettingsSection(settings, "interface", "Interface");
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
  await expect(installationRaw).toHaveValue(
    /\/checkout\/config\/runtime\.env/u,
  );
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
  await expect(installationRaw).toHaveValue(
    /\/checkout\/config\/runtime\.env/u,
  );
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
      .locator(
        'body > .toast-region .operation-feedback.success[role="status"]',
      )
      .filter({ hasText: "Saved" }),
  ).toContainText("Settings updated.");
  await expect(settings.getByText("Saved.", { exact: true })).toHaveCount(0);
  expect(state.validations).toHaveLength(4);
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
    const overlay = element.closest<HTMLElement>(
      ".split-confirmation-overlay",
    )!;
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
  await selectSettingsSection(settings, "interface", "Interface");
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

// present page and field matches in a popup attached to the search input
for (const width of [390, 1440]) {
  test(`searches every settings page and field with typed result context at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings } = await setupSettings(page, false);
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await expect(search).toHaveAttribute("placeholder", "Search all settings");
    await expect(
      settings.getByText("Search settings", { exact: true }),
    ).toHaveCount(0);

    await search.fill("projects");
    const results = page.getByRole("listbox", {
      name: "Settings search results",
      exact: true,
    });
    await expect(results).toBeVisible();
    const pageResult = results
      .getByRole("option")
      .filter({ has: page.getByText("Projects", { exact: true }) })
      .filter({ has: page.getByText("Page", { exact: true }) });
    await expect(pageResult).toHaveCount(1);
    await expect(pageResult.locator(".settings-search-breadcrumb")).toBeEmpty();
    const [searchBox, resultsBox] = await Promise.all([
      search.boundingBox(),
      results.boundingBox(),
    ]);
    expect(searchBox).not.toBeNull();
    expect(resultsBox).not.toBeNull();
    expect(Math.abs(resultsBox!.x - searchBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(resultsBox!.width - searchBox!.width)).toBeLessThanOrEqual(
      1,
    );
    expect(resultsBox!.y).toBeGreaterThanOrEqual(
      searchBox!.y + searchBox!.height,
    );
    await page.screenshot({
      path: `/tmp/remoteagents-settings-search-${width}.png`,
    });
    await pageResult.click();
    await expect(
      settings.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();

    await search.fill("server name");
    const fieldResult = results
      .getByRole("option")
      .filter({ has: page.getByText("Server name", { exact: true }) })
      .filter({ has: page.getByText("Field", { exact: true }) });
    await expect(fieldResult).toHaveCount(1);
    await expect(fieldResult.locator(".settings-search-breadcrumb")).toHaveText(
      "Application › Identity and network",
    );
    await fieldResult.click();
    await expect(
      settings.getByRole("heading", {
        name: "Application",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      settings.locator('[data-settings-path="identity.name"]'),
    ).toHaveAttribute("data-settings-search-highlight", "true");
  });
}

// route both Storage source classes to their exact virtual-page fields
test("routes Storage search results to scratch and environment paths", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page, false);
  configureStorageFixture(sources);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const search = settings.getByRole("searchbox", {
    name: "Search settings",
    exact: true,
  });
  const results = page.getByRole("listbox", {
    name: "Settings search results",
    exact: true,
  });

  await search.fill("storage");
  const pageResult = results
    .getByRole("option")
    .filter({ has: page.getByText("Storage", { exact: true }) })
    .filter({ has: page.getByText("Page", { exact: true }) });
  await expect(pageResult).toHaveCount(1);
  await pageResult.click();
  await expect(
    settings.getByRole("heading", { name: "Storage", exact: true, level: 2 }),
  ).toBeVisible();

  await search.fill("Scratch directory");
  const scratchResult = results
    .getByRole("option")
    .filter({ has: page.getByText("Scratch directory", { exact: true }) })
    .filter({ has: page.getByText("Field", { exact: true }) });
  await expect(scratchResult).toHaveCount(1);
  await expect(scratchResult.locator(".settings-search-breadcrumb")).toHaveText(
    "Application › Storage",
  );
  await scratchResult.click();
  await expect(
    settings.locator('[data-settings-path="scratchDirectory"]'),
  ).toHaveAttribute("data-settings-search-highlight", "true");

  await search.fill("RAC_NOTES_FILE");
  const notesResult = results
    .getByRole("option")
    .filter({ has: page.getByText("RAC_NOTES_FILE", { exact: true }) })
    .filter({ has: page.getByText("Field", { exact: true }) });
  await expect(notesResult).toHaveCount(1);
  await expect(notesResult.locator(".settings-search-breadcrumb")).toHaveText(
    "Application › Storage › Environment",
  );
  await notesResult.click();
  await expect(
    settings.locator('[data-settings-path="RAC_NOTES_FILE"]'),
  ).toHaveAttribute("data-settings-search-highlight", "true");
  expect(state.saves).toEqual([]);
});

// reveal a searched collection child without staging any project mutation
test("opens, scrolls to and highlights a field inside a collapsed project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  const { settings, state } = await setupSettings(page, false);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await search.fill("repository directory path");
  const results = page.getByRole("listbox", {
    name: "Settings search results",
    exact: true,
  });
  const fieldResult = results
    .getByRole("option")
    .filter({ has: page.getByText("Path", { exact: true }) })
    .filter({ has: page.getByText("Field", { exact: true }) })
    .filter({
      has: page.getByText("Application › Projects › Project 1", {
        exact: true,
      }),
    });
  await expect(fieldResult).toHaveCount(1);
  await expect(fieldResult.locator(".settings-search-breadcrumb")).toHaveText(
    "Application › Projects › Project 1",
  );
  await fieldResult.click();

  const panel = settings.locator(".settings-source-panel");
  const path = settings.locator('[data-settings-path="projects.0.path"]');
  await expect(path).toBeVisible();
  await expect(path).toHaveAttribute("data-settings-search-highlight", "true");
  await expect(path.locator("input")).toHaveValue("/code/atlas");
  await expect
    .poll(() => panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
  ).toBe(0);
  expect(state.saves).toEqual([]);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/remoteagents-settings-search-field.png",
  });
});

// keep protected values outside the metadata index while exposing their field names
test("never includes protected setting values in search results", async ({
  page,
}) => {
  const { settings } = await setupSettings(page, false);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await search.fill("fixture-session-secret");
  const results = page.getByRole("listbox", {
    name: "Settings search results",
    exact: true,
  });
  await expect(results.getByRole("option")).toHaveCount(0);
  await expect(results.getByRole("status")).toHaveText("No matching settings.");

  await search.fill("RAC_SESSION_SECRET");
  const protectedField = results
    .getByRole("option")
    .filter({ has: page.getByText("RAC_SESSION_SECRET", { exact: true }) })
    .filter({ has: page.getByText("Field", { exact: true }) });
  await expect(protectedField).toHaveCount(1);
  await expect(
    protectedField.locator(".settings-search-breadcrumb"),
  ).toHaveText("Environment › Environment & keys");
  await protectedField.click();
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(settings).not.toContainText("fixture-session-secret");
});

// support listbox dismissal and keyboard-only destination selection
test("navigates search results with Escape, ArrowDown and Enter", async ({
  page,
}) => {
  const { settings } = await setupSettings(page, true);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await search.fill("terminal font");
  const results = page.getByRole("listbox", {
    name: "Settings search results",
    exact: true,
  });
  await expect(results).toBeVisible();
  await search.press("Escape");
  await expect(results).toHaveCount(0);
  await expect(search).toHaveValue("terminal font");

  await search.press("ArrowDown");
  await expect(results).toBeVisible();
  await expect(
    results
      .getByRole("option")
      .filter({ has: page.getByText("Terminal font", { exact: true }) }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(results).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Interface", exact: true }),
  ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="terminalFontSize"]'),
  ).toHaveAttribute("data-settings-search-highlight", "true");

  await search.fill("dynamic worktrees");
  const launcherResult = results
    .getByRole("option")
    .filter({ has: page.getByText("Dynamic worktrees", { exact: true }) });
  await expect(launcherResult.locator(".settings-search-breadcrumb")).toHaveText(
    "Application › Projects",
  );
  await launcherResult.click();
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="dynamicWorktrees"]'),
  ).toHaveAttribute("data-settings-search-highlight", "true");
});

// index safe tunnel setup fields before visiting their page
test("finds unconfigured Cloudflare fields before opening Cloudflare", async ({
  page,
}) => {
  const { settings } = await setupSettings(page, false);
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await search.fill("hostname");
  const results = page.getByRole("listbox", {
    name: "Settings search results",
    exact: true,
  });
  const hostname = results
    .getByRole("option")
    .filter({ has: page.getByText("Hostname", { exact: true }) })
    .filter({ has: page.getByText("Field", { exact: true }) })
    .filter({
      has: page.getByText("Deployment › Cloudflare › Tunnel setup", {
        exact: true,
      }),
    });
  await expect(hostname).toHaveCount(1);
  await expect(hostname.locator(".settings-search-breadcrumb")).toHaveText(
    "Deployment › Cloudflare › Tunnel setup",
  );
  await hostname.click();
  await expect(
    settings.getByRole("heading", { name: "Cloudflare", exact: true }),
  ).toBeVisible();
  await expect(
    settings.locator('[data-settings-path="cloudflare.hostname"]'),
  ).toHaveAttribute("data-settings-search-highlight", "true");
});

// keep navigation stable before the first file catalog is available
for (const width of [390, 1440]) {
  test(`keeps all settings sections visible while initial files load at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = deferredResponse();
    const retry = deferredResponse();
    const { settings, state } = await setupSettings(page, false, false, false, [
      { wait: initial.promise, status: 503 },
      { wait: retry.promise },
    ]);
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
    });
    await expect.poll(() => state.settingsReads).toBe(1);
    const catalogLoading = settings.getByRole("status").filter({
      hasText: "Loading installation files",
    });
    await expectProgressBorder(catalogLoading, "blue");
    await expectStandardSettingsHeader(
      settings,
      settingsPageHeaderExpectations.find(
        (candidate) => candidate.id === "browser",
      )!,
    );
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
      await expect(listbox.getByRole("option")).toHaveCount(14);
      const browser = listbox.locator('[role="option"][data-value="browser"]');
      await expect(browser).not.toHaveAttribute("aria-disabled", "true");
      await expect(browser.locator(":scope > .update-progress-ring")).toHaveCount(0);
      // browser-owned pages stay usable before files are ready
      for (const id of ["interface", "projects"]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).not.toHaveAttribute("aria-disabled", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      for (const id of [
        "voice",
        "keyboard",
        ...settingsUnavailableSections.map((source) => source.id),
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
      ).toHaveAttribute("data-value", "interface");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(14);
      await expect(
        nav.getByRole("button", { name: "This browser", exact: true }),
      ).toBeEnabled();
      for (const label of ["Interface", "Projects"])
        await expect(
          nav.getByRole("button", { name: label, exact: true }),
        ).toBeEnabled();
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        ...settingsUnavailableSections.map((source) => source.label),
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

    // search results never remove pending destinations from navigation
    await search.fill("cloudflare");
    if (width === 390) {
      await search.press("Escape");
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(14);
      await expect(
        listbox.locator('[role="option"][data-value="cloudflare"]'),
      ).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(14);
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
      for (const source of settingsUnavailableSections) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(source.id)}]`,
        );
        await expect(option).toHaveAttribute("aria-disabled", "true");
        await expect(option).not.toHaveAttribute("aria-busy", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      for (const id of ["voice", "keyboard", "interface", "projects"]) {
        await expect(
          listbox.locator(`[role="option"][data-value=${JSON.stringify(id)}]`),
        ).not.toHaveAttribute("aria-disabled", "true");
      }
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      for (const source of settingsUnavailableSections) {
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
      for (const label of ["Interface", "Projects"])
        await expect(
          nav.getByRole("button", { name: label, exact: true }),
        ).toBeEnabled();
    }

    // catalog-independent pages retain complete headers after failure
    for (const id of ["voice", "keyboard", "interface", "projects"] as const) {
      const expected = settingsPageHeaderExpectations.find(
        (candidate) => candidate.id === id,
      )!;
      await selectSettingsSection(settings, expected.id, expected.title);
      await expectStandardSettingsHeader(settings, expected);
    }
    await selectSettingsSection(settings, "browser", "This browser");

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
      await expect(listbox.getByRole("option")).toHaveCount(14);
      for (const id of [
        "voice",
        "keyboard",
        "app",
        "interface",
        "agents",
        "projects",
        "reviews",
        "tmux",
        "storage",
        "env",
        "installation",
        "compose-override",
        "cloudflare",
      ]) {
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
      await expect(nav.getByRole("button")).toHaveCount(14);
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        "Application",
        "Interface",
        "Agents",
        "Projects",
        "Reviews",
        "TMUX",
        "Storage",
        "Environment & keys",
        "Installation",
        "Docker",
        "Cloudflare",
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
    const { settings, state } = await setupSettings(page, false, false, false, [
      {},
      { wait: refresh.promise },
    ]);
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
      await expect(listbox.getByRole("option")).toHaveCount(14);
      for (const id of [
        "voice",
        "keyboard",
        "app",
        "agents",
        "reviews",
        "tmux",
        "storage",
        "env",
        "installation",
        "compose-override",
        "cloudflare",
      ]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).toHaveAttribute("aria-disabled", "true");
        await expectProgressBorder(option, "blue");
      }
      for (const id of ["interface", "projects"]) {
        const option = listbox.locator(
          `[role="option"][data-value=${JSON.stringify(id)}]`,
        );
        await expect(option).not.toHaveAttribute("aria-disabled", "true");
        await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
      }
      await selector.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        listbox.locator('[role="option"][data-active="true"]'),
      ).toHaveAttribute("data-value", "interface");
      await page.keyboard.press("Escape");
    } else {
      const nav = settings.getByRole("navigation", {
        name: "Settings sources",
      });
      await expect(nav.getByRole("button")).toHaveCount(14);
      for (const label of [
        "Voice",
        "Keyboard shortcuts",
        "Application",
        "Agents",
        "Reviews",
        "TMUX",
        "Storage",
        "Environment & keys",
        "Installation",
        "Docker",
        "Cloudflare",
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute("aria-busy", "true");
        await expectProgressBorder(button, "blue");
      }
      for (const label of ["Interface", "Projects"]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveAttribute("aria-busy", "true");
      }
    }

    // search results leave every retained destination in navigation
    await search.fill("docker");
    if (width === 390) {
      await search.press("Escape");
      const selector = settings.getByRole("combobox", {
        name: "Settings section",
        exact: true,
      });
      await selector.click();
      const listbox = page.getByRole("listbox", {
        name: "Settings section options",
      });
      await expect(listbox.getByRole("option")).toHaveCount(14);
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
      await expect(nav.getByRole("button")).toHaveCount(14);
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
      for (const id of [
        "voice",
        "keyboard",
        "app",
        "interface",
        "agents",
        "projects",
        "reviews",
        "tmux",
        "storage",
        "env",
        "installation",
        "compose-override",
        "cloudflare",
      ]) {
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
        "Application",
        "Interface",
        "Agents",
        "Projects",
        "Reviews",
        "TMUX",
        "Storage",
        "Environment & keys",
        "Installation",
        "Docker",
        "Cloudflare",
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
  const { settings, state } = await setupSettings(page, true, false, false, [
    {},
    {},
    { wait: refresh.promise },
  ]);
  const sections = [
    { id: "browser", label: "This browser" },
    { id: "voice", label: "Voice" },
    { id: "keyboard", label: "Keyboard shortcuts" },
    { id: "app", label: "Application" },
    { id: "interface", label: "Interface" },
    { id: "agents", label: "Agents" },
    { id: "projects", label: "Projects" },
    { id: "tmux", label: "TMUX" },
    { id: "storage", label: "Storage" },
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
    nav.getByRole("button", { name: "Application", exact: true }),
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
      .locator(`[role="option"][data-value=${JSON.stringify(section.id)}]`)
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
    name: "Application Unsaved changes",
    exact: true,
  });
  await expect(application.locator(".settings-source-nav-icon")).toBeVisible();
  await expect(application.locator(".settings-source-nav-label")).toHaveText(
    "Application",
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
    name: "Application",
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

// keep interface preference copy and actions aligned without spanning grid columns
for (const width of [320, 390, 1440, 2560]) {
  test(`aligns interface preference controls beside their copy at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings } = await setupSettings(page, false);
    const browserOverview = settings.locator(".client-settings-overview");
    const name = browserOverview.getByRole("group", {
      name: "Name",
      exact: true,
    });
    await expect(name).toBeVisible({ timeout: 3_000 });
    await expect(name.getByText("This browser", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      name.getByRole("button", { name: "Rename browser name", exact: true }),
    ).toBeVisible();
    await expect(browserOverview.locator(".client-settings-setting")).toHaveCount(
      1,
    );
    await selectSettingsSection(settings, "interface", "Interface");
    const overview = settings.locator(".client-settings-overview");
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
    // include notification sounds alongside the four appearance controls
    expect(metrics.rows).toHaveLength(5);
    // prove right alignment and centering for every interface preference
    for (const row of metrics.rows) {
      expect(row.separation).toBeGreaterThanOrEqual(0);
      expect(row.centerDelta).toBeLessThanOrEqual(1);
      expect(row.overflow).toBeLessThanOrEqual(0);
    }
    // keep every preference on its own full-width row
    expect(metrics.grid).toBe(1);
    expect(Math.abs(metrics.terminalWidth - metrics.width)).toBeLessThanOrEqual(
      1,
    );
  });
}

// keep every form group vertically stacked regardless of available split width
for (const width of [375, 1440, 2560]) {
  test(`stacks every settings form in one column at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { settings, sources, state } = await setupSettings(
      page,
      true,
      false,
      true,
    );
    const env = sources.find((source) => source.id === "env")!;
    env.fields!.push({
      key: "RAC_PASSWORD_HASH",
      protected: true,
      present: true,
      hasValue: true,
      apply: "rac-restart",
    });
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    const panel = settings.locator(".settings-source-panel");
    let observedLayouts = 0;

    // inspect real grid tracks and child geometry instead of matching CSS text
    const assertSingleColumn = async () => {
      const layouts = await panel
        .locator(
          ".settings-object-fields, .settings-env-fields, .client-settings-davo-form, .settings-password-replacement",
        )
        .evaluateAll((elements) => {
          // ignore only form containers that have no rendered box
          return elements
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              // compare complete setting rows rather than their inline controls
              const children = Array.from(element.children)
                .filter((child) => child.getBoundingClientRect().width > 0)
                .map((child) => {
                  const rect = child.getBoundingClientRect();
                  return {
                    left: rect.left,
                    top: rect.top,
                    bottom: rect.bottom,
                    width: rect.width,
                  };
                });
              return {
                columns:
                  getComputedStyle(element).gridTemplateColumns.split(" ")
                    .length,
                width: bounds.width,
                children,
              };
            });
        });
      observedLayouts += layouts.length;
      // require a full-width row and vertical ordering for every visible group
      for (const layout of layouts) {
        expect(layout.columns).toBe(1);
        for (const [index, child] of layout.children.entries()) {
          expect(Math.abs(child.width - layout.width)).toBeLessThanOrEqual(2);
          if (index > 0) {
            // consecutive settings may not occupy the same row
            expect(child.top).toBeGreaterThanOrEqual(
              layout.children[index - 1]!.bottom - 1,
            );
            expect(
              Math.abs(child.left - layout.children[index - 1]!.left),
            ).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    };

    // cover each structured editor that shares the form-grid rules
    for (const [id, label] of [
      ["app", "Application config"],
      ["agents", "Agents"],
      ["env", "Environment & keys"],
      ["tmux", "TMUX"],
      ["storage", "Storage"],
      ["installation", "Installation"],
      ["projects", "Projects"],
      ["voice", "Voice"],
    ] as const) {
      await selectSettingsSection(settings, id, label);
      if (id === "projects") {
        // expose nested object fields inside the compact project row
        await settings
          .getByRole("button", { name: "Edit Project 1", exact: true })
          .click();
      }
      if (id === "env") {
        // include the password and confirmation fields without authoring a change
        await settings
          .getByRole("button", { name: "Set new password", exact: true })
          .click();
      }
      await assertSingleColumn();
      if (
        (width === 375 || width === 1440) &&
        (id === "env" || id === "voice")
      ) {
        // retain desktop and mobile evidence for ordinary and specialized forms
        await settings.screenshot({
          path: `/tmp/remoteagents-settings-single-column-${id}-${width}.png`,
        });
      }
    }
    expect(observedLayouts).toBeGreaterThan(0);
    expect(state.saves).toHaveLength(0);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
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
      key: "RAC_GITHUB_TOKEN",
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
    panel.getByRole("button", {
      name: "Replace without revealing",
      exact: true,
    }),
  ).toHaveCount(0);
  for (const key of ["RAC_GITHUB_TOKEN", "RAC_EMPTY_TOKEN"]) {
    const field = panel.locator(`[data-settings-path=${JSON.stringify(key)}]`);
    const input = field.getByLabel(key, { exact: true });
    await expect(input).toBeEditable();
    await expect(input).toHaveValue("");
    await expect(field.getByText("Protected", { exact: true })).toHaveCount(0);
    await expect(
      field.getByRole("button", { name: /Reveal|Mask/u }),
    ).toHaveCount(0);
  }
  const missing = panel.getByLabel("RAC_GITHUB_TOKEN", { exact: true });
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
    "RAC_GITHUB_TOKEN",
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
  expect(
    cardStyle.borderImage.match(/repeating-linear-gradient/gu),
  ).toHaveLength(4);
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
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

  for (const key of ["RAC_SESSION_SECRET", "RAC_HOST_PROC", "RAC_HOST_UID"]) {
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
          button.parentElement?.classList.contains(
            "settings-environment-key",
          ) && button.closest(".settings-field-heading") !== null,
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
  await expect(restart).not.toContainText("recovery");
  await expect(restart.locator("code")).toHaveCount(0);
  await expect(restart.getByRole("timer")).toHaveCount(0);
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
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
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
      key: "RAC_GITHUB_TOKEN",
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
    const unset = settings.locator('[data-settings-path="RAC_GITHUB_TOKEN"]');
    await expect(
      unset.getByRole("button", { name: /Reveal|Mask/u }),
    ).toHaveCount(0);
    const empty = settings.locator('[data-settings-path="RAC_EMPTY_TOKEN"]');
    await expect(
      empty.getByRole("button", { name: /Reveal|Mask/u }),
    ).toHaveCount(0);
    await expect(
      empty.getByLabel("RAC_EMPTY_TOKEN", { exact: true }),
    ).toHaveValue("");
    // built-in assignments stay blankable without custom-variable trash actions
    for (const key of ["RAC_GITHUB_TOKEN", "RAC_SESSION_SECRET", "TZ"])
      await expect(
        settings.locator(
          `[data-settings-path="${key}"] .settings-remove-button`,
        ),
      ).toHaveCount(0);
    // custom entries retain their existing independent removal actions
    for (const key of ["RAC_EMPTY_TOKEN", "RAC_MULTILINE_SECRET"])
      await expect(
        settings.getByRole("button", { name: `Remove ${key}`, exact: true }),
      ).toHaveCount(1);
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
      .getByLabel("RAC_GITHUB_TOKEN", { exact: true })
      .fill("synthetic-new-key");
    await unset
      .getByRole("button", { name: "Mask RAC_GITHUB_TOKEN", exact: true })
      .click();
    await expect(
      unset.getByRole("textbox", { name: "RAC_GITHUB_TOKEN", exact: true }),
    ).toHaveCount(0);
    await unset
      .getByRole("button", { name: "Reveal RAC_GITHUB_TOKEN", exact: true })
      .click();
    await expect(
      unset.getByRole("textbox", { name: "RAC_GITHUB_TOKEN", exact: true }),
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
    await expect(multilineValue).toHaveValue(
      "line one\n# literal\nline three\n",
    );
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
  await expect(
    surface.locator(".settings-code-editor-field-action"),
  ).toHaveCount(0);
  const geometry = await mask.evaluate((button) => {
    const toolbar = button.closest(".settings-code-editor-toolbar")!;
    const editor = button.closest(".settings-code-editor")!;
    const frame = toolbar.getBoundingClientRect();
    const surface = editor
      .querySelector(".settings-code-editor-surface")!
      .getBoundingClientRect();
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
test("fits masked raw source disclosure controls on mobile", async ({
  page,
}) => {
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
  const input = settings.getByLabel("Environment & keys source content");
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
  await editor.screenshot({
    path: "/tmp/remoteagents-settings-masked-mobile.png",
  });
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
  await expect(saved).toHaveCount(0);
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
test("revokes active field disclosure when clearing is staged", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await selectSettingsSection(settings, "env", "Environment & keys");
  const field = settings.locator('[data-settings-path="RAC_SESSION_SECRET"]');
  await field
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await field.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");
  await expect.poll(() => state.remasks.length).toBe(1);
  await expect(
    field.getByLabel("RAC_SESSION_SECRET", { exact: true }),
  ).toHaveValue("");
  await expect(field.getByRole("button", { name: /Reveal|Mask/u })).toHaveCount(
    0,
  );
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

// preserve local masking when clearing cannot revoke the server lease
test("clears disclosed keys locally when lease revocation fails", async ({
  page,
}) => {
  const { settings } = await setupSettings(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await page.route("**/api/settings/remask", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "private host diagnostic that must not display" },
    }),
  );
  await settings.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");
  await expect(
    settings.getByRole("button", { name: /Reveal|Mask/u }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText(
    "Value hidden locally, but its server disclosure could not be revoked.",
  );
  await expect(settings).not.toContainText("private host diagnostic");
  expect(errors).toEqual([]);
});

// keep protected wrapper drafts locally maskable without fetching saved bytes
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
  expect(wrapper.exists).toBe(true);
  wrapper.content = undefined;
  wrapper.hasProtectedContent = true;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "tmux", "TMUX");
  const input = settings.getByLabel("Installation wrapper source content");
  await expect(input).toHaveValue("********");
  await expect(input).toHaveAttribute("readonly", "");
  await expect(
    settings.getByRole("button", {
      name: "Reveal Installation wrapper",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Create source", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Replace without revealing", exact: true })
    .click();
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
        name: raw ? "Reveal Installation wrapper" : "Reveal Credential",
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
        raw ? "Installation wrapper source content" : "New Credential",
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
        raw ? "Installation wrapper source content" : "Credential",
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
  await expect(menu.getByRole("option")).toHaveCount(14);
  await expect(
    menu.getByRole("option", { name: /Heart icon|Potato icon/u }),
  ).toHaveCount(0);
  // show a painted glyph in every section choice
  for (const option of await menu.getByRole("option").all())
    await expect(option.locator("svg, img")).not.toHaveCount(0);
  await menu
    .getByRole("option", { name: "Application", exact: true })
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
  const icon = settings.getByRole("combobox", {
    name: "Server icon",
    exact: true,
  });
  await icon.click();
  await page
    .getByRole("listbox", { name: "Server icon options", exact: true })
    .locator('[role="option"][data-value="potato"]')
    .click();
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
    await expectSettingsOptions(selector, 14, 5);
    // keep virtual Application sections together in the mobile group
    await selector.click();
    const application = page
      .getByRole("listbox", {
        name: "Settings section options",
        exact: true,
      })
      .getByRole("group", { name: "Application", exact: true });
    await expect(application.getByRole("option")).toHaveCount(7);
    await expect(
      application.getByRole("option", {
        name: "Application",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Interface", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Agents", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Projects", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Reviews", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "TMUX", exact: true }),
    ).toBeVisible();
    await expect(
      application.getByRole("option", { name: "Storage", exact: true }),
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
      await settings.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
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
    "Application · Unsaved changes",
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

  // searching must not disturb the current section or mobile navigation
  await search.fill("keyboard");
  await expect(selector).toHaveAttribute("data-value", "app");
  await expect(
    selector.locator(".settings-select-current-label"),
  ).toContainText("Application · Unsaved changes");
  await search.press("Escape");
  await expectSettingsOptions(selector, 14);
  await search.fill("no-matching-section");
  await expect(selector).toHaveAttribute("data-value", "app");
  await expect(
    page.locator(
      '[role="listbox"][aria-label="Settings search results"] [role="option"]',
    ),
  ).toHaveCount(0);
  await expect(settings.getByLabel("Server name")).toHaveValue("Mobile draft");
  await search.press("Escape");
  await expectSettingsOptions(selector, 14);
  await search.fill("");
  await expectSettingsOptions(selector, 14);

  // crossing the breakpoint changes only the navigation presentation
  await page.setViewportSize({ width: 781, height: 844 });
  await expect(selector).toHaveCount(0);
  const nav = settings.getByRole("navigation", { name: "Settings sources" });
  await expect(
    nav.getByRole("button", { name: /^Application/u }),
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

// keep distributed browser preferences and file-backed edits in one transaction
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
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Interface", exact: true }).click();
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
  ).toHaveCount(0);
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

  // search browser fields without filtering the source navigation
  await center
    .getByRole("searchbox", { name: "Search settings" })
    .fill("theme");
  await expect(
    nav.getByRole("button", { name: /^Interface.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Voice", exact: true }),
  ).toBeVisible();
  await center.getByRole("searchbox", { name: "Search settings" }).fill("");

  // keep launcher preferences on Projects without splitting the save transaction
  await nav.getByRole("button", { name: "Projects", exact: true }).click();
  await panel.getByRole("switch", { name: "Dynamic worktrees" }).uncheck();
  await expect(
    nav.getByRole("button", { name: /^Projects.*Unsaved changes$/u }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "This browser", exact: true }),
  ).toBeVisible();

  // retain ordinary file drafts while remasking disclosures on section changes
  await nav.getByRole("button", { name: /^Application/u }).click();
  await panel.getByLabel("Server name").fill("Framework Draft");
  await nav
    .getByRole("button", { name: "Environment & keys", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Reveal RAC_SESSION_SECRET", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "RAC_SESSION_SECRET", exact: true }),
  ).toHaveValue("fixture-session-secret");
  await nav
    .getByRole("button", { name: /^Interface.*Unsaved changes$/u })
    .click();
  await expect(center).not.toContainText("fixture-session-secret");
  await expect.poll(() => state.remasks.length).toBeGreaterThan(0);
  await expect(
    panel.getByRole("radio", { name: "Light theme" }),
  ).toHaveAttribute("aria-checked", "true");
  await nav.getByRole("button", { name: /^Application/u }).click();
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
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("rac.dynamic-worktrees")),
    )
    .toBe("disabled");
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
  await nav.getByRole("button", { name: /^Application/u }).click();
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
test("keeps browser preferences and voice settings available when the file catalog fails", async ({
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
      "Installation files are unavailable. Browser preferences remain available in This browser, Interface, and Projects; file settings are unavailable.",
    ),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Interface", exact: true }).click();
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
      .locator(
        'body > .toast-region .operation-feedback.success[role="status"]',
      )
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
  await expectSettingsOptions(selector, 14);
  await selector.click();
  const options = page.getByRole("listbox", {
    name: "Settings section options",
  });
  // failed file placeholders stay unavailable without a loading claim
  for (const source of settingsUnavailableSections) {
    const option = options.locator(
      `[role="option"][data-value=${JSON.stringify(source.id)}]`,
    );
    await expect(option).toHaveAttribute("aria-disabled", "true");
    await expect(option.locator(":scope > .update-progress-ring")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await chooseSettingsOption(selector, "interface");
  await expect(
    settings.getByRole("group", { name: "Terminal font", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("note").filter({
      hasText: "Load Application configuration before editing custom buttons.",
    }),
  ).toBeVisible();
  await chooseSettingsOption(selector, "projects");
  await expect(
    settings.getByRole("switch", { name: "Dynamic worktrees" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("note").filter({
      hasText: "Load Application configuration before editing projects.",
    }),
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
test("owns settings scrolling inside the active source panel", async ({
  page,
}) => {
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
  expect(
    await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
  ).toBe(0);
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
    const search = settings.getByRole("searchbox", { name: "Search settings" });
    const navigation =
      layout.width <= 780
        ? settings.locator(".settings-source-select")
        : settings.getByRole("navigation", { name: "Settings sources" });
    const before = await Promise.all(
      [search, navigation].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );

    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => panel.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const after = await Promise.all(
      [search, navigation].map((locator) =>
        locator.evaluate((element) => element.getBoundingClientRect().top),
      ),
    );
    expect(after).toEqual(before);
    expect(await outer.evaluate((element) => element.scrollTop)).toBe(0);
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    ).toBe(0);

    // excess wheel input stays contained by the already-ended active panel
    await panel.hover();
    await page.mouse.wheel(0, 2_000);
    expect(await outer.evaluate((element) => element.scrollTop)).toBe(0);
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    ).toBe(0);
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
      expect(
        await panel.evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0);
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
      visible: panel.getByRole("group", { name: "Name", exact: true }),
    },
    {
      id: "interface",
      label: "Interface",
      visible: panel.getByRole("group", { name: "Terminal font", exact: true }),
    },
    {
      id: "projects",
      label: "Projects",
      visible: panel.getByRole("switch", { name: "Dynamic worktrees" }),
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
      element.scrollTop = Math.min(
        120,
        element.scrollHeight - element.clientHeight,
      );
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
  await sourceNav.getByRole("button", { name: "Environment & keys" }).click();
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
  await settings.getByLabel("RAC_SESSION_SECRET", { exact: true }).fill("");

  // nested collections remain typed and emit explicit reorder patches
  await sourceNav.getByRole("button", { name: "Application" }).click();
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
  await stageInstallationWholeSource(settings, "/checkout/config/runtime.env");
  await expect(settings.locator(".settings-migration")).toHaveCount(0);

  // advanced sources name their execution trust and tracked-file risk
  await sourceNav.getByRole("button", { name: "Docker" }).click();
  await expect(settings.getByText("Trusted code", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings.getByText("Tracked file", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByLabel("Docker source content")).toHaveValue(
    /RAC_PORT: 8787/u,
  );
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
      .locator(
        'body > .toast-region .operation-feedback.success[role="status"]',
      )
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
  await expect(notice).not.toContainText("recovery");
  await expect(notice.locator("code")).toHaveCount(0);
  await expect(notice.getByRole("timer")).toHaveCount(0);
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
  await expect(page.locator(".fullscreen-loader")).toContainText(
    "Waiting for the host applier",
  );
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
  await page.keyboard.press("e");
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
  await expectSettingsOptions(selector, 14);
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
  await expect(
    panel.getByLabel("Project name", { exact: true }),
  ).toBeDisabled();
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
  await center
    .getByRole("searchbox", { name: "Search settings" })
    .press("Escape");
  await expectSettingsOptions(selector, 14);
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
  const secret = settings.getByRole("textbox", {
    name: "RAC_SESSION_SECRET",
    exact: true,
  });
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
    page.locator(
      'body > .toast-region .operation-feedback.error[role="alert"]',
    ),
  ).toContainText("Fix the validation issues before saving.");
  await expect(
    settings.getByText("Fix the validation issues before saving."),
  ).toHaveCount(0);
  await expect(
    page.locator("body > .toast-region .operation-feedback.success"),
  ).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
  state.validationValid = true;
  state.saveStatus = 409;
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.locator(
      'body > .toast-region .operation-feedback.error[role="alert"]',
    ),
  ).toContainText("changed outside Settings");
  await expect(
    page.locator("body > .toast-region .operation-feedback.success"),
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.validations.length).toBe(1);
  expect(state.validations[0]).toEqual({
    changes: [{ sourceId: "app", revisionId: "app-r1", remove: true }],
  });
  await expect.poll(() => state.saves.length).toBe(1);
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
  await selectSettingsSection(settings, "app", "Application config");
  const application = settings.getByRole("region", {
    name: "Application settings content",
    exact: true,
  });
  await expect(
    application.getByRole("heading", {
      name: "Application",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    application.getByText(
      "The current JSON cannot be parsed. Edit its source to repair it; credential values stay masked.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    application.getByLabel("Application config source content", {
      exact: true,
    }),
  ).toHaveValue("{");
  await expect(
    application.getByRole("button", {
      name: "Use structured editor",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(application.locator(".settings-raw-mode")).toHaveCount(0);
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
    settings.getByRole("textbox", {
      name: "RAC_SESSION_SECRET",
      exact: true,
    }),
  ).toHaveValue("fixture-session-secret");
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(settings.getByLabel("RAC_SESSION_SECRET masked")).toBeVisible();
  await expect(
    settings.getByRole("textbox", {
      name: "RAC_SESSION_SECRET",
      exact: true,
    }),
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
  const editorView = settings.getByRole("switch", {
    name: "Keyboard editor view",
    exact: true,
  });
  // select the second endpoint only when needed
  if ((await editorView.getAttribute("aria-checked")) !== "true")
    await editorView.click();
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
      name: "Application",
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
    .getByRole("button", { name: "Edit base file", exact: true })
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
  const editorView = settings.getByRole("switch", {
    name: "Keyboard editor view",
    exact: true,
  });
  // select the second endpoint only when needed
  if ((await editorView.getAttribute("aria-checked")) !== "true")
    await editorView.click();
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

// render a defaulted listener object without materializing either scalar field
test("shows omitted listener defaults as placeholders instead of zero", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const application = sources.find((source) => source.id === "app") as {
    value: Record<string, unknown>;
    schema: { properties: Record<string, unknown> };
  };
  delete application.value.listen;
  application.schema.properties.listen =
    applicationSettingsSchema().properties!.listen;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  const host = settings.locator('[data-settings-path="listen.host"] input');
  const port = settings.locator('[data-settings-path="listen.port"] input');
  await expect(host).toHaveValue("");
  await expect(host).toHaveAttribute(
    "placeholder",
    "127.0.0.1 (from built-in default)",
  );
  await expect(port).toHaveValue("");
  await expect(port).toHaveAttribute(
    "placeholder",
    "8787 (from built-in default)",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// follow the live first Review preset without authoring its ID as the default
test("updates the default Review preset placeholder from the first draft preset", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const application = sources.find((source) => source.id === "app") as {
    value: Record<string, unknown>;
    schema: { properties: Record<string, unknown> };
  };
  application.schema.properties.review =
    applicationSettingsSchema().properties!.review!;
  application.value.review = {
    presets: [
      {
        id: "security",
        label: "Security",
        agent: "codex",
        prompt: "Review security boundaries.",
      },
    ],
  };
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "reviews", "Reviews");
  const defaultPreset = settings.locator(
    '[data-settings-path="review.defaultPreset"] input',
  );
  await expect(defaultPreset).toHaveValue("");
  await expect(defaultPreset).toHaveAttribute(
    "placeholder",
    "security (from first Review preset)",
  );
  const presets = settings.locator('[data-settings-path="review.presets"]');
  await presets
    .locator('[data-settings-path="review.presets.0.id"] input')
    .fill("correctness-two");
  await expect(defaultPreset).toHaveAttribute(
    "placeholder",
    "correctness-two (from first Review preset)",
  );
  expect(state.saves).toEqual([]);
});

// capitalize product acronyms in display copy without rewriting stored settings values
test("renders MCP and OMX labels while preserving their lowercase application values", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const application = sources.find((source) => source.id === "app") as {
    value: Record<string, unknown>;
    content: string;
    schema: SettingsSchema;
  };
  const authoritative = applicationSettingsSchema();
  application.schema.properties!.adapters =
    authoritative.properties!.adapters!;
  application.schema.properties!.integrations =
    authoritative.properties!.integrations!;
  const currentIntegrations = application.value.integrations as Record<
    string,
    unknown
  >;
  application.value = {
    ...application.value,
    adapters: {
      omx: { program: "/opt/tools/omx", setup: "mcp seed" },
    },
    integrations: {
      ...currentIntegrations,
      mcp: {
        readEnabled: true,
        writeEnabled: false,
        dangerousEnabled: false,
      },
    },
  };
  application.content = `${JSON.stringify(application.value)}\n`;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();

  await selectSettingsSection(settings, "app", "Application");
  await expect(
    settings.getByRole("heading", { name: "MCP", exact: true, level: 3 }),
  ).toBeVisible();
  await expect(
    settings.locator(
      '[data-settings-path="integrations.mcp.readEnabled"]',
    ),
  ).toBeVisible();

  await selectSettingsSection(settings, "agents", "Agents");
  await expect(
    settings.getByRole("heading", { name: "OMX", exact: true, level: 3 }),
  ).toBeVisible();
  const program = settings.locator(
    '[data-settings-path="adapters.omx.program"] input',
  );
  await expect(program).toHaveValue("/opt/tools/omx");
  await program.fill("/custom/bin/omx");
  const setup = settings
    .locator('[data-settings-path="adapters.omx.setup"]')
    .getByRole("textbox");
  await expect(setup).toHaveValue("mcp seed");
  await setup.fill("mcp omx");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => state.saves.length).toBe(1);
  const patches = (
    state.saves[0] as {
      body: { changes: Array<{ sourceId: string; patches?: SettingsPatch[] }> };
    }
  ).body.changes.find((change) => change.sourceId === "app")!.patches!;
  expect(patches).toEqual(
    expect.arrayContaining([
      {
        op: "set",
        path: ["adapters", "omx", "setup"],
        value: "mcp omx",
      },
      {
        op: "set",
        path: ["adapters", "omx", "program"],
        value: "/custom/bin/omx",
      },
    ]),
  );
});

// retain save failures in the shared toast stack without losing the pending edit
for (const failure of [
  "server",
  "conflict",
  "network",
  "unconfirmed",
] as const) {
  test(`keeps a ${failure} settings save error toast until dismissed and permits retry`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { settings, state } = await setupSettings(page);
    await settings
      .getByLabel("Server name", { exact: true })
      .fill("Retry draft");
    // isolate toast geometry from independent validation warnings
    await page.route("**/api/settings/validate", (route) =>
      route.fulfill({ json: { valid: true, issues: [] } }),
    );
    let reject = true;
    await page.route("**/api/settings", (route) => {
      // leave reads and the explicit retry with the authoritative fixture
      if (route.request().method() !== "PATCH" || !reject)
        return route.fallback();
      // simulate transport loss without interrupting unrelated status polling
      if (failure === "network") return route.abort("failed");
      return route.fulfill({
        status:
          failure === "conflict" ? 409 : failure === "unconfirmed" ? 200 : 500,
        json: { error: "Fixture save rejected." },
      });
    });
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    const panel = settings.locator(".settings-source-panel");
    const before = await panel.boundingBox();
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const toast = page.locator(
      'body > .toast-region .operation-feedback.error[role="alert"]',
    );
    await expect(toast).toBeVisible();
    await expect(toast.locator("strong")).toHaveText(
      "Settings save incomplete",
    );
    const detail =
      failure === "conflict"
        ? "changed outside Settings"
        : failure === "network"
          ? "Console unavailable"
          : failure === "unconfirmed"
            ? "their refreshed state is unavailable"
            : "Fixture save rejected.";
    await expect(toast).toContainText(detail);
    await expect(toast).toHaveAttribute("aria-live", "assertive");
    await expect(toast.locator(".toast-timer-bar")).toHaveCount(0);
    await expect(settings.locator(".settings-feedback")).toHaveCount(0);
    await expect(panel).toBeVisible();
    expect(await panel.boundingBox()).toEqual(before);
    await page.clock.fastForward(60_000);
    await expect(toast).toBeVisible();
    await expect(
      settings.getByLabel("Server name", { exact: true }),
    ).toHaveValue("Retry draft");
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
    // inspect a long error at phone width before explicitly dismissing it
    if (failure === "network") {
      await page.screenshot({
        path: "/tmp/rac-settings-save-error-desktop.png",
      });
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(toast).toBeVisible();
      const overflow = await toast.evaluate((element) => ({
        toast: element.scrollWidth - element.clientWidth,
        document:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));
      expect(overflow).toEqual({ toast: 0, document: 0 });
      await page.screenshot({
        path: "/tmp/rac-settings-save-error-mobile.png",
      });
    }
    await toast
      .getByRole("button", { name: "Dismiss operation status", exact: true })
      .click();
    await expect(toast).toHaveCount(0);
    reject = false;
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    const saved = page.locator(
      'body > .toast-region .operation-feedback.success[role="status"]',
    );
    await expect(saved).toContainText("Settings updated.");
    await expect(toast).toHaveCount(0);
    await page.clock.fastForward(5_000);
    await expect(saved).toHaveCount(0);
  });
}

// keep save-time validation errors persistent while field-level repair guidance stays inline
for (const failure of ["invalid", "unavailable"] as const) {
  test(`shows a persistent settings save toast when validation is ${failure}`, async ({
    page,
  }) => {
    const { settings, state } = await setupSettings(page);
    await settings
      .getByLabel("Server name", { exact: true })
      .fill("Invalid draft");
    await page.route("**/api/settings/validate", (route) =>
      route.fulfill(
        failure === "invalid"
          ? {
              json: {
                valid: false,
                issues: [
                  {
                    sourceId: "app",
                    path: ["identity", "name"],
                    code: "invalid_value",
                    message: "Fixture name is invalid.",
                  },
                ],
              },
            }
          : { status: 503, json: { error: "Validation service unavailable." } },
      ),
    );
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const toast = page.locator(
      'body > .toast-region .operation-feedback.error[role="alert"]',
    );
    await expect(toast).toContainText(
      failure === "invalid"
        ? "Fix the validation issues before saving."
        : "Validation service unavailable.",
    );
    await expect(toast.locator("strong")).toHaveText(
      "Settings save incomplete",
    );
    await expect(settings.locator(".settings-feedback")).toHaveCount(0);
    // invalid fields retain their precise repair message beneath the control
    if (failure === "invalid")
      await expect(
        settings.getByText("Fixture name is invalid.", { exact: true }),
      ).toBeVisible();
    await page.clock.fastForward(60_000);
    await expect(toast).toBeVisible();
    await expect(toast.locator(".toast-timer-bar")).toHaveCount(0);
    await expect(
      settings.getByLabel("Server name", { exact: true }),
    ).toHaveValue("Invalid draft");
    expect(state.saves).toEqual([]);
  });
}

// distinguish committed files from the remaining browser rename after a partial save
test("shows a persistent partial settings save error without claiming full success", async ({
  page,
}) => {
  const { settings, state } = await setupSettings(page);
  await settings
    .getByLabel("Server name", { exact: true })
    .fill("Committed file");
  await selectSettingsSection(settings, "browser", "This browser");
  await settings
    .getByRole("button", { name: "Rename browser name", exact: true })
    .click();
  const rename = page.getByRole("dialog", {
    name: "Rename browser",
    exact: true,
  });
  await rename
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Pending browser");
  await rename.getByRole("button", { name: "Done", exact: true }).click();
  await page.route("**/api/auth/device-name", (route) =>
    route.fulfill({ status: 503, json: { error: "Fixture rename rejected." } }),
  );
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const toast = page.locator(
    'body > .toast-region .operation-feedback.error[role="alert"]',
  );
  await expect(toast).toContainText(
    "Files saved, but browser changes remain unsaved. Fixture rename rejected.",
  );
  await expect(toast.locator("strong")).toHaveText("Settings save incomplete");
  await expect(
    page.locator("body > .toast-region .operation-feedback.success"),
  ).toHaveCount(0);
  await expect(settings.locator(".settings-feedback .error")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(toast).toBeVisible();
  await expect(
    settings.getByRole("group", { name: "Name", exact: true }),
  ).toContainText("Pending browser");
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  expect(state.saves).toHaveLength(1);
});

// preserve intentionally empty voice context rather than implying built-in instructions
test("describes explicit empty voice context without claiming the omission default", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(
    page,
    false,
    false,
    true,
  );
  const application = sources.find((source) => source.id === "app") as {
    value: { integrations: { realtime: { context: string } } };
  };
  application.value.integrations.realtime.context = "";
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "voice", "Voice");
  const context = settings.getByRole("textbox", {
    name: "Davo context",
    exact: true,
  });
  await expect(context).toHaveValue("");
  await expect(context).toHaveAttribute(
    "placeholder",
    "No additional voice context",
  );
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toEqual([]);
});

// distinguish a retained empty dotenv value from removing its assignment
test("keeps explicit empty environment hints separate from omission placeholders", async ({
  page,
}) => {
  const { settings, sources, state } = await setupSettings(page);
  const env = sources.find((source) => source.id === "env") as {
    fields: SettingsEnvField[];
  };
  const tmux = env.fields.find((field) => field.key === "RAC_TMUX_BIN")!;
  Object.assign(tmux, {
    value: "",
    present: true,
    fallback: environmentFallback("RAC_TMUX_BIN"),
    emptyValueHint: "Empty (from explicit environment assignment)",
  });
  const instanceSecret = env.fields.find(
    (field) => field.key === "RAC_INSTANCE_STATUS_SECRET",
  )!;
  Object.assign(instanceSecret, {
    value: undefined,
    protected: true,
    present: true,
    hasValue: false,
    apply: "rac-restart",
    fallback: environmentFallback("RAC_INSTANCE_STATUS_SECRET"),
    emptyValueHint: "Empty (from explicit environment assignment)",
  });
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "tmux", "TMUX");
  const binary = settings.getByRole("textbox", {
    name: "RAC_TMUX_BIN",
    exact: true,
  });
  await expect(binary).toHaveValue("");
  await expect(binary).toHaveAttribute(
    "placeholder",
    "Empty (from explicit environment assignment)",
  );
  await binary.fill("/tmp/tmux");
  await binary.fill("");
  await expect(binary).toHaveAttribute("placeholder", "/usr/bin/tmux");
  await selectSettingsSection(settings, "env", "Environment & keys");
  await expect(
    settings.getByRole("textbox", {
      name: "RAC_INSTANCE_STATUS_SECRET",
      exact: true,
    }),
  ).toHaveAttribute("placeholder", "Empty (from explicit environment assignment)");
  expect(state.saves).toEqual([]);
});

// keep the enabled voice controls in task order before their environment source
for (const width of [1440, 390]) {
  test(`orders enabled Voice controls before Environment at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, sources, state } = await setupSettings(page, false);
    addVoiceEnvironmentFixture(sources);
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "voice", "Voice");
    const writeTools = settings.locator(
      '[data-settings-path="integrations.realtime.writeToolsEnabled"]',
    );
    // keep the existing disabled-voice availability before checking enabled layout
    await expect(writeTools.getByRole("switch")).toBeVisible();
    await settings
      .getByRole("switch", { name: "Enable Davo", exact: true })
      .check();
    const context = settings.locator(
      '[data-settings-path="integrations.realtime.context"]',
    );
    const environment = settings.getByRole("region", {
      name: "Voice environment settings",
      exact: true,
    });
    await expect(context).toBeVisible();
    await expect(writeTools).toBeVisible();
    await expect(environment).toBeVisible();
    await expect(
      settings.getByRole("heading", {
        name: "Advanced voice configuration",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      settings.getByText(
        "Save these preferences together with the other voice settings.",
        { exact: true },
      ),
    ).toHaveCount(0);
    const [contextBox, writeToolsBox, environmentBox] = await Promise.all([
      context.boundingBox(),
      writeTools.boundingBox(),
      environment.boundingBox(),
    ]);
    expect(contextBox).not.toBeNull();
    expect(writeToolsBox).not.toBeNull();
    expect(environmentBox).not.toBeNull();
    expect(contextBox!.y + contextBox!.height).toBeLessThanOrEqual(
      writeToolsBox!.y,
    );
    expect(writeToolsBox!.y + writeToolsBox!.height).toBeLessThanOrEqual(
      environmentBox!.y,
    );
    expect(
      environmentBox!.y - (writeToolsBox!.y + writeToolsBox!.height),
    ).toBeGreaterThanOrEqual(16);
    await settings.screenshot({
      path: `/tmp/remoteagents-settings-voice-layout-${width}.png`,
    });

    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await search.fill("Write tools");
    const writeToolsResult = page
      .getByRole("listbox", {
        name: "Settings search results",
        exact: true,
      })
      .getByRole("option")
      .filter({
        has: page
          .locator(".settings-search-result-title strong")
          .filter({ hasText: /^Write tools enabled$/u }),
      })
      .filter({ has: page.getByText("Field", { exact: true }) });
    await expect(writeToolsResult).toHaveCount(1);
    await expect(
      writeToolsResult.locator(".settings-search-breadcrumb"),
    ).toHaveText("Console › Voice");
    await expect(writeToolsResult).not.toContainText(
      "Advanced voice configuration",
    );
    await writeToolsResult.click();
    await expect(writeTools).toHaveAttribute(
      "data-settings-search-highlight",
      "true",
    );
    expect(state.saves).toEqual([]);
  });
}

// move voice-only credentials without enabling voice or changing their environment-file ownership
for (const width of [1440, 375]) {
  test(`edits voice environment credentials only on Voice at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, sources, state } = await setupSettings(page);
    addVoiceEnvironmentFixture(sources);
    await settings
      .getByRole("button", { name: "Refresh files", exact: true })
      .click();
    await selectSettingsSection(settings, "env", "Environment & keys");
    for (const key of [
      "RAC_OPENAI_ADMIN_KEY",
      "RAC_OPENAI_API_KEY_IDS",
      "RAC_OPENAI_API_KEY",
      "RAC_REALTIME_MCP_TOKEN",
    ])
      await expect(
        settings.locator(`[data-settings-path="${key}"]`),
      ).toHaveCount(0);
    await selectSettingsSection(settings, "agents", "Agents");
    // keep account-spend configuration with the agent accounts that consume it
    for (const key of ["RAC_OPENAI_ADMIN_KEY", "RAC_OPENAI_API_KEY_IDS"])
      await expect(
        settings.locator(`[data-settings-path="${key}"]`),
      ).toBeVisible();
    for (const key of ["RAC_OPENAI_API_KEY", "RAC_REALTIME_MCP_TOKEN"])
      await expect(
        settings.locator(`[data-settings-path="${key}"]`),
      ).toHaveCount(0);
    await settings
      .getByRole("searchbox", { name: "Search settings", exact: true })
      .fill("RAC_OPENAI_API_KEY");
    const result = page
      .getByRole("listbox", { name: "Settings search results", exact: true })
      .getByRole("option")
      .filter({
        has: page
          .locator(".settings-search-result-title strong")
          .filter({ hasText: /^RAC_OPENAI_API_KEY$/u }),
      })
      .filter({ has: page.getByText("Field", { exact: true }) });
    await expect(result.locator(".settings-search-breadcrumb")).toHaveText(
      "Console › Voice › Environment & keys",
    );
    await result.click();
    const credentials = settings.getByRole("region", {
      name: "Voice environment settings",
      exact: true,
    });
    const apiField = credentials.locator(
      '[data-settings-path="RAC_OPENAI_API_KEY"]',
    );
    await expect(apiField).toHaveAttribute(
      "data-settings-search-highlight",
      "true",
    );
    await expect(
      settings.getByRole("switch", { name: "Enable Davo", exact: true }),
    ).not.toBeChecked();
    await expect(
      credentials.getByLabel("RAC_OPENAI_API_KEY masked"),
    ).toBeVisible();
    const token = credentials.getByRole("textbox", {
      name: "RAC_REALTIME_MCP_TOKEN",
      exact: true,
    });
    await expect(token).toBeEditable();
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute(
      "placeholder",
      "Derived from RAC_SESSION_SECRET",
    );
    await expect(
      credentials.getByRole("button", {
        name: "Add environment variable",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await settings.screenshot({
      path: `/tmp/rac-voice-environment-${width}.png`,
    });
    // keep masking and the original protected environment save path intact
    await apiField
      .getByRole("button", { name: "Reveal RAC_OPENAI_API_KEY", exact: true })
      .click();
    await apiField
      .getByRole("textbox", { name: "RAC_OPENAI_API_KEY", exact: true })
      .fill("synthetic-voice-key");
    await token.fill("synthetic-voice-token");
    await expect(
      settings.locator(
        '.settings-source-nav button[aria-current="page"] [aria-label="Unsaved changes"]',
      ),
    ).toHaveCount(1);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => state.saves.length).toBe(1);
    const transaction = state.saves[0] as {
      body: { changes: Array<{ sourceId: string; patches: unknown[] }> };
    };
    expect(transaction.body.changes).toHaveLength(1);
    expect(transaction.body.changes[0]?.sourceId).toBe("env");
    expect(transaction.body.changes[0]?.patches).toEqual(
      expect.arrayContaining([
        {
          op: "set",
          path: ["RAC_OPENAI_API_KEY"],
          value: "synthetic-voice-key",
        },
        {
          op: "set",
          path: ["RAC_REALTIME_MCP_TOKEN"],
          value: "synthetic-voice-token",
        },
      ]),
    );
    await expect(
      page.getByRole("status", { name: "Restart pending", exact: true }),
    ).toBeVisible();
    expect(state.voiceSaves).toEqual([]);
    expect(state.restarts).toBe(0);
  });
}

// lock moved credentials against competing raw drafts and unavailable environment sources
test("respects environment source locks on the Voice page", async ({
  page,
}) => {
  const { settings, sources } = await setupSettings(page);
  addVoiceEnvironmentFixture(sources);
  const environment = sources.find((source) => source.id === "env")!;
  environment.content = "TZ=UTC\n";
  environment.hasProtectedContent = false;
  Object.assign(
    environment.fields!.find((field) => field.key === "RAC_OPENAI_API_KEY")!,
    { present: false, hasValue: false },
  );
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await selectSettingsSection(settings, "env", "Environment & keys");
  await settings
    .getByRole("button", { name: "Edit whole source", exact: true })
    .click();
  await settings
    .getByRole("textbox", {
      name: "Environment & keys source content",
      exact: true,
    })
    .fill("TZ=Etc/UTC\n");
  await selectSettingsSection(settings, "voice", "Voice");
  await expect(
    settings.getByText(
      "Finish or discard the Environment & keys whole-source draft before editing voice credentials.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const key of ["RAC_OPENAI_API_KEY", "RAC_REALTIME_MCP_TOKEN"])
    await expect(
      settings.getByRole("textbox", { name: key, exact: true }),
    ).toBeDisabled();
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  await expect(
    settings.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  environment.writable = false;
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByText(
      "Voice environment settings are read-only in this installation.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const key of ["RAC_OPENAI_API_KEY", "RAC_REALTIME_MCP_TOKEN"])
    await expect(
      settings.getByRole("textbox", { name: key, exact: true }),
    ).toBeDisabled();
  sources.splice(sources.indexOf(environment), 1);
  await settings
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    settings.getByText(
      "Load Environment & keys before editing voice credentials.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    settings
      .getByRole("region", { name: "Voice environment settings", exact: true })
      .getByRole("textbox"),
  ).toHaveCount(0);
});
