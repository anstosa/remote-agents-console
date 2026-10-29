import { expect, test, type Locator, type Page } from "@playwright/test";
import { defaultButtons, type ConfiguredButton } from "../../server/src/config/buttons.js";
import type { SettingsInput } from "../../server/src/settings/contracts.js";
import { applicationSettingsSchema } from "../../server/src/settings/schema.js";
import { mockAccountSocket } from "./account-fixture.js";

type FixtureOptions = {
  applicationButtons?: boolean;
  projectButtons?: boolean;
  writable?: boolean;
};

const applicationShell = {
  text: "Application shell",
  icon: "M5 12h14",
  color: "green",
  style: "outline",
  action: { shellCommand: "echo application" },
} satisfies ConfiguredButton;

const sharedApplication = {
  text: "Shared action",
  color: "blue",
  style: "outline",
  action: { agentPrompt: "application prompt" },
} satisfies ConfiguredButton;

const sharedProject = {
  text: "Shared action",
  color: "peach",
  style: "solid",
  action: { shellCommand: "echo project" },
} satisfies ConfiguredButton;

const applicationAgent = {
  text: "Agent helper",
  color: "sky",
  style: "solid",
  action: { agentPrompt: "help with this workspace" },
} satisfies ConfiguredButton;

const authoritativeSchema = applicationSettingsSchema();
const settingsSchema = {
  type: "object" as const,
  label: "Application",
  properties: {
    buttons: authoritativeSchema.properties!.buttons!,
    projects: authoritativeSchema.properties!.projects!,
  },
};

const initialValue = {
  buttons: {
    leftNav: [applicationShell, sharedApplication],
    splits: { agent: [applicationAgent] },
  },
  projects: [
    {
      id: "atlas",
      label: "Atlas",
      path: "/srv/atlas",
      buttons: {
        leftNav: [sharedProject],
        splits: { agent: [] },
      },
    },
  ],
};

// clone fixture values before they cross the browser boundary
const clone = <T>(value: T): T => structuredClone(value);

// derive one source value with explicit omission coverage
function applicationValue(options: FixtureOptions) {
  const value: Omit<typeof initialValue, "buttons"> & {
    buttons?: typeof initialValue.buttons;
  } = clone(initialValue);
  // exercise the schema-owned application defaults independently
  if (options.applicationButtons === false) delete value.buttons;
  // exercise the first project override without a pre-authored button container
  if (options.projectButtons === false)
    delete (value.projects[0]! as { buttons?: unknown }).buttons;
  return value;
}

// publish the focused application source without unrelated settings controls
function applicationSource(options: FixtureOptions) {
  return {
    id: "app",
    label: "Application",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable: options.writable !== false,
    protected: false,
    tracked: false,
    revisionId: "app-r1",
    apply: "rac-restart",
    value: applicationValue(options),
    schema: settingsSchema,
  };
}

// mount the real Settings surface over an isolated application catalog
async function setupProjectButtons(page: Page, options: FixtureOptions = {}) {
  await mockAccountSocket(page);
  const saves: SettingsInput[] = [];
  const buttonActions: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  // retain uncaught browser failures as explicit fixture evidence
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // retain console failures as separate rendered-browser evidence
  page.on("console", (message) => {
    // collect only error-level browser messages
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // isolate every console request from the current installation
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // publish one authenticated controller
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "project-buttons-csrf",
          active: true,
          deviceName: "Project buttons fixture",
          server: {
            name: "Fixture console",
            url: "https://console.example.test",
            remotes: [],
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
      return route.fulfill({ json: { ticket: "project-buttons-ticket" } });
    // disable unrelated notices
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    // disable push enrollment
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    // disable server update notices
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
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
          supported: false,
          mode: "unconfigured",
          enabled: false,
          connected: false,
          tokenPresent: false,
          serviceUrl: "http://127.0.0.1:9876",
        },
      });
    // keep background tunnel monitoring inside the fixture
    if (
      path === "/api/settings/cloudflare/health" &&
      request.method() === "GET"
    )
      return route.fulfill({
        json: {
          state: "disabled",
          failures: 0,
          reconnecting: false,
          canReconnect: false,
        },
      });
    // keep background calendar status inside the fixture
    if (path === "/api/settings/google-calendar" && request.method() === "GET")
      return route.fulfill({
        json: {
          enabled: false,
          available: false,
          connected: false,
          status: "disabled",
          calendars: [],
          setup: {
            clientId: false,
            clientSecret: false,
            tokenKey: false,
            redirectUri:
              "http://127.0.0.1:4173/api/settings/google-calendar/callback",
          },
          counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 },
        },
      });
    // return the authoritative fixture snapshot
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "snapshot-r1",
          sources: [applicationSource(options)],
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    // accept the focused transaction after recording its exact authored paths
    if (path === "/api/settings/validate" && request.method() === "POST")
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    // record saves without mutating the immutable application fixture
    if (path === "/api/settings" && request.method() === "PATCH") {
      saves.push(clone(request.postDataJSON() as SettingsInput));
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "snapshot-r2",
          sources: [applicationSource(options)],
          status: {
            pending: true,
            targets: ["rac"],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    }
    // reject inherited previews that accidentally execute their application action
    if (path.startsWith("/api/button-actions")) {
      buttonActions.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 418,
        json: { error: "Inherited previews must not execute." },
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
  await expect(settings).toBeVisible();
  await selectProjects(settings);
  const project = settings
    .getByRole("group", { name: /^Project \d+$/u })
    .filter({ hasText: "Atlas" })
    .first();
  await project.getByRole("button", { name: /^Edit Project \d+$/u }).click();
  return { buttonActions, consoleErrors, pageErrors, project, saves, settings };
}

// select the virtual Projects page through its visible responsive navigator
async function selectProjects(settings: Locator) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones use the custom source selector
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

// locate one inherited application button by its stable identity
const inheritedButton = (project: Locator, text: string) =>
  project.locator(
    `.settings-inherited-button[data-settings-inherited-button=${JSON.stringify(text)}]`,
  );

// retain full-color previews and align inheritance copy left of the override action
async function expectInheritedPresentation(row: Locator) {
  const preview = row.locator(".settings-button-preview");
  await expect(preview).toHaveCSS("filter", "none");
  await expect(preview).toHaveCSS("opacity", "1");
  await expect(preview.locator("button")).toHaveCSS("opacity", "1");
  const note = row.locator(".settings-inherited-button-actions > small");
  await expect(note).toHaveText("Inherited from Application");
  const noteBounds = await note.boundingBox();
  const overrideBounds = await row
    .locator(".settings-inherited-button-override")
    .boundingBox();
  expect(noteBounds).not.toBeNull();
  expect(overrideBounds).not.toBeNull();
  expect(noteBounds!.x + noteBounds!.width).toBeLessThan(overrideBounds!.x);
  expect(
    Math.abs(
      noteBounds!.y + noteBounds!.height / 2 -
      overrideBounds!.y - overrideBounds!.height / 2,
    ),
  ).toBeLessThan(1);
}

// copy one direct inherited button and preserve its complete definition
test("shows application buttons in project slots and opens copied overrides for editing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { buttonActions, consoleErrors, pageErrors, project, saves, settings } =
    await setupProjectButtons(page);
  const leftNavigation = project.locator(
    '[data-settings-collection-path="projects.0.buttons.leftNav"]',
  );
  const inheritedShell = inheritedButton(leftNavigation, applicationShell.text);
  await expect(inheritedShell).toBeVisible();
  await expect(
    inheritedShell.locator(".settings-button-preview button"),
  ).toBeDisabled();
  await expectInheritedPresentation(inheritedShell);
  await expect(
    inheritedShell.locator(".settings-button-preview button"),
  ).toHaveCSS("color", "rgb(166, 227, 161)");
  await expect(
    inheritedButton(leftNavigation, sharedApplication.text),
  ).toHaveCount(0);
  await expect(
    leftNavigation.locator('[data-settings-collection-entry="array"]'),
  ).toHaveCount(1);

  await inheritedShell
    .getByRole("button", {
      name: `Override ${applicationShell.text}`,
      exact: true,
    })
    .click();
  await expect(inheritedShell).toHaveCount(0);
  const copiedEditor = project.locator(
    '[data-settings-path="projects.0.buttons.leftNav.1"]',
  );
  await expect(copiedEditor).toBeVisible();
  await expect(
    copiedEditor.getByRole("textbox", { name: "Button text", exact: true }),
  ).toHaveValue(applicationShell.text);
  await expect(
    copiedEditor.getByRole("textbox", {
      name: "Button icon path",
      exact: true,
    }),
  ).toHaveValue(applicationShell.icon!);
  await expect(
    copiedEditor.getByRole("textbox", { name: "Shell command", exact: true }),
  ).toHaveValue(applicationShell.action.shellCommand);
  await copiedEditor
    .getByRole("textbox", { name: "Button text", exact: true })
    .fill("Project shell");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.find(
    (change) => change.sourceId === "app",
  )!.patches!;
  expect(patches).toEqual(
    expect.arrayContaining([
      {
        op: "insert",
        path: ["projects", "0", "buttons", "leftNav"],
        index: 1,
        value: applicationShell,
      },
      {
        op: "set",
        path: ["projects", "0", "buttons", "leftNav", "1", "text"],
        value: "Project shell",
      },
    ]),
  );
  expect(patches.every((patch) => patch.path[0] === "projects")).toBe(true);
  expect(buttonActions).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// copy nested application actions and restore inheritance after removal
test("supports nested overrides and restores inherited rows when project overrides are removed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { buttonActions, consoleErrors, pageErrors, project } =
    await setupProjectButtons(page);
  const agentButtons = project.locator(
    '[data-settings-collection-path="projects.0.buttons.splits.agent"]',
  );
  const inheritedAgent = inheritedButton(agentButtons, applicationAgent.text);
  await expect(inheritedAgent).toBeVisible();
  await inheritedAgent
    .getByRole("button", {
      name: `Override ${applicationAgent.text}`,
      exact: true,
    })
    .click();
  const nestedEditor = project.locator(
    '[data-settings-path="projects.0.buttons.splits.agent.0"]',
  );
  await expect(nestedEditor).toBeVisible();
  await expect(
    nestedEditor.getByRole("textbox", { name: "Agent prompt", exact: true }),
  ).toHaveValue(applicationAgent.action.agentPrompt);

  const leftNavigation = project.locator(
    '[data-settings-collection-path="projects.0.buttons.leftNav"]',
  );
  await expect(inheritedButton(leftNavigation, sharedProject.text)).toHaveCount(
    0,
  );
  await leftNavigation
    .getByRole("button", { name: "Remove Left navigation 1", exact: true })
    .click();
  const restoredShared = inheritedButton(leftNavigation, sharedProject.text);
  await expect(restoredShared).toBeVisible();
  await expect(restoredShared).toContainText("Inherited from Application");
  await expect(
    restoredShared.locator(".settings-button-preview"),
  ).toContainText(sharedApplication.text);
  expect(buttonActions).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

const absentOverrideScenarios = [
  {
    name: "direct",
    collectionPath: "projects.0.buttons.leftNav",
    slotPath: ["projects", "0", "buttons", "leftNav"],
    button: applicationShell,
    actionLabel: "Shell command",
    actionValue: applicationShell.action.shellCommand,
  },
  {
    name: "nested",
    collectionPath: "projects.0.buttons.splits.agent",
    slotPath: ["projects", "0", "buttons", "splits", "agent"],
    button: applicationAgent,
    actionLabel: "Agent prompt",
    actionValue: applicationAgent.action.agentPrompt,
  },
] as const;

// create each first authored slot without requiring pre-existing button ancestry
for (const scenario of absentOverrideScenarios) {
  test(`materializes the first ${scenario.name} override when a project has no button container`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const {
      buttonActions,
      consoleErrors,
      pageErrors,
      project,
      saves,
      settings,
    } = await setupProjectButtons(page, { projectButtons: false });
    const slot = project.locator(
      `[data-settings-collection-path=${JSON.stringify(scenario.collectionPath)}]`,
    );
    const inherited = inheritedButton(slot, scenario.button.text);
    await expect(inherited).toBeVisible();
    await inherited
      .getByRole("button", {
        name: `Override ${scenario.button.text}`,
        exact: true,
      })
      .click();
    const copiedEditor = project.locator(
      `[data-settings-path=${JSON.stringify(`${scenario.collectionPath}.0`)}]`,
    );
    await expect(copiedEditor).toBeVisible();
    await expect(
      copiedEditor.getByRole("textbox", {
        name: "Button text",
        exact: true,
      }),
    ).toHaveValue(scenario.button.text);
    await expect(
      copiedEditor.getByRole("textbox", {
        name: scenario.actionLabel,
        exact: true,
      }),
    ).toHaveValue(scenario.actionValue);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => saves.length).toBe(1);
    const patches = saves[0]!.changes.find(
      (change) => change.sourceId === "app",
    )!.patches!;
    expect(patches).toContainEqual({
      op: "set",
      path: [...scenario.slotPath],
      value: [scenario.button],
    });
    expect(patches.every((patch) => patch.path[0] === "projects")).toBe(true);
    expect(buttonActions).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

// retain schema defaults and mutation locks in the narrow layout
test("shows schema-default buttons and locks responsive inherited actions in read-only projects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { buttonActions, consoleErrors, pageErrors, project } =
    await setupProjectButtons(page, {
      applicationButtons: false,
      projectButtons: false,
      writable: false,
    });
  const pullRequest = project.locator(
    '[data-settings-collection-path="projects.0.buttons.pullRequest"]',
  );
  // verify every built-in application definition remains inherited
  for (const button of defaultButtons.pullRequest) {
    const inherited = inheritedButton(pullRequest, button.text);
    await expect(inherited).toBeVisible();
    await inherited.scrollIntoViewIfNeeded();
    await expectInheritedPresentation(inherited);
    await expect(
      inherited.getByRole("button", {
        name: `Override ${button.text}`,
        exact: true,
      }),
    ).toBeDisabled();
  }
  const defaultButton = defaultButtons.pullRequest[0]!;
  const inheritedDefault = inheritedButton(project, defaultButton.text);
  const metrics = await inheritedDefault.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    parentOverflow:
      element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
    buttonInside:
      element.querySelector("button:last-of-type")!.getBoundingClientRect()
        .right <=
      element.getBoundingClientRect().right + 0.5,
  }));
  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.parentOverflow).toBeLessThanOrEqual(0);
  expect(metrics.buttonInside).toBe(true);
  const panelOverflow = await project
    .locator("xpath=ancestor::*[contains(@class, 'settings-source-panel')]")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(panelOverflow).toBeLessThanOrEqual(0);
  expect(buttonActions).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
