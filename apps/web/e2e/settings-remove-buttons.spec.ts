import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture";

type SavedRequest = {
  changes: Array<{
    sourceId: string;
    patches?: Array<{ op: string; path: string[] }>;
  }>;
};

// mount a synthetic catalog that exercises every removable field shape
async function setupRemoveSettings(page: Page) {
  await mockAccountSocket(page);
  const saves: SavedRequest[] = [];
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
      value: {
        optionalText: "enabled",
        advanced: { command: "run" },
        projects: [{ label: "Atlas", path: "/code/atlas" }],
      },
      schema: {
        type: "object",
        label: "Application config",
        properties: {
          optionalText: {
            type: "string",
            label: "Optional feature",
            optional: true,
            description:
              "A deliberately long explanation that wraps so the destructive action must center against the complete label, description, and origin copy instead of only the first line.",
          },
          advanced: {
            type: "object",
            label: "Advanced controls",
            optional: true,
            description:
              "Remove this entire optional section when the installation should use its portable defaults, including installations with a narrow Settings split or unusually long operator guidance that must wrap beneath the label.",
            properties: { command: { type: "string", label: "Command" } },
          },
          projects: {
            type: "array",
            label: "Projects",
            items: {
              type: "object",
              label: "Project",
              properties: {
                label: { type: "string" },
                path: { type: "string", description: "Repository path." },
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
      origin: "compose env_file: .env",
      fields: [
        {
          key: "EDITOR_COMMAND",
          value: "code --wait",
          protected: false,
          present: true,
          apply: "rac-restart",
          description:
            "A deliberately long environment explanation that wraps across lines while the remove action remains centered against all descriptive copy.",
        },
        {
          key: "RAC_SESSION_SECRET",
          protected: true,
          present: true,
          apply: "rac-restart",
          description:
            "Signs browser sessions with a protected value that is never returned by this fixture.",
        },
      ],
    },
  ];
  // serve the minimum authenticated console surface without reading host configuration
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "remove-csrf",
          active: true,
          deviceName: "Remove fixture",
          server: {
            name: "Framework",
            url: "https://framework.santosa.dev",
            remotes: [],
          },
          davo: { enabled: false, available: true, name: "Davo", context: "" },
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
      return route.fulfill({ json: { ticket: "remove-ticket" } });
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({
        json: {
          pending: false,
          targets: [],
          effective: "known",
          restartAvailable: true,
        },
      });
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "remove-snapshot-r1",
          sources,
          status: {
            pending: false,
            targets: [],
            effective: "known",
            restartAvailable: true,
          },
        },
      });
    if (path === "/api/settings/validate" && request.method() === "POST")
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    if (path === "/api/settings" && request.method() === "PATCH") {
      saves.push(request.postDataJSON() as SavedRequest);
      return route.fulfill({
        json: {
          version: 1,
          revisionId: "remove-snapshot-r2",
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
  return { saves, settings };
}

// choose a Settings source through whichever responsive navigator is visible
async function selectSource(settings: Locator, id: string, label: string) {
  const select = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones use the custom popup instead of source tabs
  if (await select.isVisible()) {
    await select.click();
    await settings
      .page()
      .getByRole("listbox")
      .locator(`[role="option"][data-value=${JSON.stringify(id)}]`)
      .click();
    return;
  }
  await settings
    .getByRole("navigation", { name: "Settings sources" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

// prove a remove action paints red with a trash glyph and centers against all copy
async function expectAlignedRemove(container: Locator, buttonName: string) {
  const button = container.getByRole("button", {
    name: buttonName,
    exact: true,
  });
  await expect(button).toBeVisible();
  await expect(button.locator("svg path")).toHaveCount(1);
  const metrics = await container.evaluate((element, name) => {
    const button = Array.from(element.querySelectorAll("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name,
    )!;
    const copy = element.querySelector(".settings-field-copy, header > div")!;
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    const copyBounds = copy.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const description = copy.querySelector(
      "small:not(.settings-field-origin), p",
    ) as HTMLElement | null;
    const descriptionStyle =
      description === null ? undefined : getComputedStyle(description);
    const reference = document.createElement("span");
    reference.style.color = "var(--red)";
    document.body.append(reference);
    const red = getComputedStyle(reference).color;
    reference.remove();
    return {
      centerDelta: Math.abs(
        copyBounds.top +
          copyBounds.height / 2 -
          buttonBounds.top -
          buttonBounds.height / 2,
      ),
      color: getComputedStyle(button).color,
      red,
      iconWidth: icon.width,
      iconHeight: icon.height,
      wrappedDescription:
        description === null ||
        description.getBoundingClientRect().height >
          Number.parseFloat(descriptionStyle!.lineHeight) * 1.5,
      overflow: element.scrollWidth - element.clientWidth,
    };
  }, buttonName);
  expect(metrics.color).toBe(metrics.red);
  expect(metrics.iconWidth).toBeGreaterThan(0);
  expect(metrics.iconHeight).toBeGreaterThan(0);
  expect(metrics.wrappedDescription).toBe(true);
  expect(metrics.centerDelta).toBeLessThanOrEqual(1);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
  return button;
}

for (const width of [390, 1440]) {
  test(`keeps removable settings red, icon-bearing, centered, and explicitly saved at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { saves, settings } = await setupRemoveSettings(page);
    await selectSource(settings, "app", "Application");

    const optional = settings.locator('[data-settings-path="optionalText"]');
    await expect(
      optional.getByText(/deliberately long explanation/u),
    ).toBeVisible();
    const optionalRemove = await expectAlignedRemove(
      optional,
      "Remove Optional feature",
    );
    await optionalRemove.click();
    expect(saves).toHaveLength(0);

    const advanced = settings.locator('[data-settings-path="advanced"]');
    const sectionRemove = await expectAlignedRemove(
      advanced,
      "Remove Advanced controls",
    );
    await sectionRemove.click();
    expect(saves).toHaveLength(0);

    // open the dedicated projects editor
    await selectSource(settings, "projects", "Projects");
    const projectRemove = settings.getByRole("button", {
      name: "Remove Projects 1",
      exact: true,
    });
    await expect(projectRemove.locator("svg path")).toHaveCount(1);
    await projectRemove.click();
    const confirmation = settings.getByRole("alertdialog", {
      name: /^Remove Project \d+$/u,
    });
    await expect(confirmation).toContainText(
      "Repositories, Worktrees, state, agents, and stacks will not be deleted.",
    );
    await confirmation
      .getByRole("button", { name: "Keep Project", exact: true })
      .click();
    expect(saves).toHaveLength(0);

    await selectSource(settings, "env", "Environment & keys");
    // retain custom-variable deletion without exposing removal for built-in secrets
    await expect(
      settings.getByRole("button", { name: "Remove EDITOR_COMMAND", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Remove RAC_SESSION_SECRET", exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", {
        name: "Replace without revealing",
        exact: true,
      }),
    ).toHaveCount(0);

    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]!.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "app",
          patches: expect.arrayContaining([
            { op: "remove", path: ["optionalText"] },
            { op: "remove", path: ["advanced"] },
          ]),
        }),
      ]),
    );
    expect(saves[0]!.changes.some((change) => change.sourceId === "env")).toBe(
      false,
    );
  });
}
