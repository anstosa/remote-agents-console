import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAccountSocket } from "./account-fixture.js";
import { confirmSettingsDiscard } from "./settings-confirmation-helpers.js";

type IconName = "terminal" | "potato" | "heart";
type RemoteConfig = { url: string; name?: string; icon?: IconName };
type RemoteMetadata = {
  url: string;
  name: string;
  icon?: IconName;
  defaultName?: string;
  defaultIcon?: IconName;
};
type SettingsPatch = {
  op: "set" | "remove" | "insert" | "move";
  path: string[];
  value?: unknown;
  index?: number;
  from?: number;
  to?: number;
};
type SavedRequest = {
  changes: Array<{
    sourceId: string;
    revisionId: string;
    patches?: SettingsPatch[];
  }>;
};
type FixtureOptions = {
  remotes: RemoteConfig[];
  metadata?: RemoteMetadata[];
  writable?: boolean;
  heldMetadata?: Promise<RemoteMetadata[]>;
};

// publish one settled or restart-pending settings state
const status = (pending = false) => ({
  pending,
  targets: pending ? ["rac"] : [],
  effective: "known",
  restartAvailable: true,
});

// clone one fixture value before exposing it to the application
const clone = <T>(value: T): T => structuredClone(value);

// apply the remote-array patches returned by the structured editor
function applyPatches(
  remotes: RemoteConfig[],
  patches: SettingsPatch[],
): RemoteConfig[] {
  const next = clone(remotes);
  // preserve patch order within one settings transaction
  for (const patch of patches) {
    // mutate one array member
    if (
      patch.path[0] === "remoteServers" &&
      patch.path.length === 2 &&
      /^\d+$/u.test(patch.path[1] ?? "")
    ) {
      const index = Number(patch.path[1]);
      // remove the addressed server
      if (patch.op === "remove") next.splice(index, 1);
      continue;
    }
    // mutate one remote identity leaf
    if (
      patch.path[0] === "remoteServers" &&
      patch.path.length === 3 &&
      /^\d+$/u.test(patch.path[1] ?? "")
    ) {
      const index = Number(patch.path[1]);
      const key = patch.path[2] as keyof RemoteConfig;
      const current = next[index];
      // ignore stale indexes
      if (current === undefined) continue;
      // restore or replace one override
      if (patch.op === "remove") delete current[key];
      else if (patch.op === "set" && typeof patch.value === "string")
        current[key] = patch.value as never;
      continue;
    }
    // mutate the remote collection
    if (patch.path.length === 1 && patch.path[0] === "remoteServers") {
      // insert or move one entry
      if (patch.op === "insert")
        next.splice(
          patch.index ?? next.length,
          0,
          clone(patch.value as RemoteConfig),
        );
      else if (
        patch.op === "move" &&
        patch.from !== undefined &&
        patch.to !== undefined
      ) {
        const [entry] = next.splice(patch.from, 1);
        // retain a valid moved entry
        if (entry !== undefined) next.splice(patch.to, 0, entry);
      }
    }
  }
  return next;
}

// publish one application settings source with the real remote-server schema shape
function applicationSource(
  remotes: RemoteConfig[],
  writable: boolean,
  revision: number,
) {
  return {
    id: "app",
    label: "Application configuration",
    path: "/synthetic/config/config.json",
    format: "json",
    exists: true,
    writable,
    protected: false,
    tracked: false,
    revisionId: `app-r${revision}`,
    apply: "rac-restart",
    value: {
      name: "Fixture console",
      publicOrigin: "https://console.example.test",
      remoteServers: clone(remotes),
    },
    schema: {
      type: "object",
      label: "Application configuration",
      properties: {
        name: { type: "string", label: "Name", apply: "live" },
        publicOrigin: { type: "string", label: "Public origin" },
        remoteServers: {
          type: "array",
          label: "Remote servers",
          apply: "rac-restart",
          items: {
            type: "object",
            label: "Remote server",
            properties: {
              url: { type: "string", label: "Url" },
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
      },
    },
  };
}

// mount Settings over isolated API and websocket fixtures
async function setupRemoteSettings(page: Page, options: FixtureOptions) {
  await mockAccountSocket(page);
  let remotes = clone(options.remotes);
  let metadata = clone(options.metadata ?? []);
  let revision = 1;
  let settingsPending = false;
  let statusRequests = 0;
  const saves: SavedRequest[] = [];
  const validations: SavedRequest[] = [];
  const externalRequests: string[] = [];

  // paint deterministic icon previews
  await page.route("**/instance-icons/*.svg*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1h8v8H1z"/></svg>',
    }),
  );
  // fail closed if an edited remote URL causes browser-side discovery
  await page.route(
    /^https:\/\/(?:framework|lab|offline)\.example\.test(?:\/.*)?$/u,
    (route) => {
      externalRequests.push(route.request().url());
      return route.abort();
    },
  );
  // isolate all console requests from the live installation
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const server = {
      name: "Fixture console",
      url: "https://console.example.test",
      remotes: clone(metadata),
    };
    // publish authenticated identity metadata
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          csrfToken: "remote-settings-csrf",
          active: true,
          deviceName: "Remote settings fixture",
          server,
          davo: { enabled: false, available: true, name: "Davo", context: "" },
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
    if (path === "/api/dashboard/ticket")
      return route.fulfill({
        json: { ticket: "remote-settings-dashboard-ticket" },
      });
    // publish peer metadata updates through the normal status poll
    if (path === "/api/server-statuses") {
      statusRequests += 1;
      // release a controlled metadata refresh
      if (options.heldMetadata !== undefined)
        metadata = clone(await options.heldMetadata);
      return route.fulfill({
        json: {
          servers: [
            {
              name: "Fixture console",
              url: "https://console.example.test",
              icon: "terminal",
              attention: "idle",
            },
            ...metadata.map((remote) => ({ ...remote, attention: "idle" })),
          ],
        },
      });
    }
    // disable unrelated background requests
    if (path === "/api/agents/updates")
      return route.fulfill({ json: { agents: [] } });
    if (path === "/api/push/public-key") return route.fulfill({ json: {} });
    if (path === "/api/server/update-available")
      return route.fulfill({ json: { available: false } });
    if (path === "/api/settings/status")
      return route.fulfill({ json: status(settingsPending) });
    // return the current authoritative config snapshot
    if (path === "/api/settings" && request.method() === "GET")
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${revision}`,
          sources: [
            applicationSource(remotes, options.writable !== false, revision),
          ],
          status: status(settingsPending),
        },
      });
    // validate without mutating the fixture
    if (path === "/api/settings/validate" && request.method() === "POST") {
      validations.push(request.postDataJSON() as SavedRequest);
      return route.fulfill({ json: { valid: true, issues: [], warnings: [] } });
    }
    // persist only the application patches under test
    if (path === "/api/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as SavedRequest;
      saves.push(body);
      const patches =
        body.changes.find((change) => change.sourceId === "app")?.patches ?? [];
      remotes = applyPatches(remotes, patches);
      revision += 1;
      settingsPending = true;
      return route.fulfill({
        json: {
          version: 1,
          revisionId: `snapshot-r${revision}`,
          sources: [
            applicationSource(remotes, options.writable !== false, revision),
          ],
          status: status(true),
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
  await selectApplication(settings);
  return {
    settings,
    saves,
    validations,
    externalRequests,
    get statusRequests() {
      return statusRequests;
    },
  };
}

// select Application through the responsive settings navigator
async function selectApplication(settings: Locator) {
  const selector = settings.getByRole("combobox", {
    name: "Settings section",
    exact: true,
  });
  // phones use the custom source dropdown
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
    .getByRole("button", { name: /^Application/u })
    .click();
}

// choose one exact custom-select value
async function chooseValue(select: Locator, value: string) {
  await select.click();
  await select
    .page()
    .getByRole("listbox")
    .locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
    .click();
}

// address duplicate accessible fieldsets by position
const remoteRows = (settings: Locator) =>
  settings.getByRole("group", { name: /^Remote server \d+$/u });

// reveal one remote's full identity controls
async function editRemote(row: Locator) {
  await row.getByRole("button", { name: /^Edit Remote server \d+$/u }).click();
}

// resolve one deferred metadata response
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test.describe.configure({ timeout: 90_000 });

for (const width of [320, 390, 1440, 2560]) {
  test(`renders default remote identity controls without indexes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { settings, saves, validations } = await setupRemoteSettings(page, {
      remotes: [{ url: "https://framework.example.test/" }],
      metadata: [
        {
          url: "https://framework.example.test",
          name: "Framework",
          icon: "heart",
          defaultName: "Framework",
          defaultIcon: "heart",
        },
      ],
    });
    const row = remoteRows(settings).first();
    await expect(row).toBeVisible();
    await expect(row.locator(".settings-collection-summary")).toContainText(
      "framework.example.test",
    );
    await expect(
      row.locator(".settings-collection-entry-copy > strong"),
    ).toHaveText("Remote server");
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await editRemote(row);
    const url = row.getByRole("textbox", { name: "URL", exact: true });
    const name = row.getByRole("textbox", { name: "Name", exact: true });
    const icon = row.getByRole("combobox", { name: "Icon", exact: true });
    await expect(url).toHaveValue("https://framework.example.test/");
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "Framework (from Remote server identity)");
    // keep inheritance guidance inside the controls
    await expect(row.getByText("Leave blank to use the other server’s name.", { exact: true })).toHaveCount(0);
    await expect(row.getByText("Server Default uses the other server’s icon.", { exact: true })).toHaveCount(0);
    await expect(icon).toHaveAttribute("data-value", "server-default");
    await expect(icon).toContainText("Server Default");
    await expect(icon.locator("img")).toHaveAttribute(
      "src",
      /\/instance-icons\/heart\.svg/u,
    );
    await icon.click();
    const iconOptions = page.getByRole("listbox", {
      name: "Icon options",
      exact: true,
    });
    await expect(iconOptions.getByRole("option")).toHaveText([
      "Server Default",
      "Terminal",
      "Potato",
      "Heart",
    ]);
    await expect(iconOptions.locator("img")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(
      row.getByRole("button", { name: /^(?:Add|Remove) (?:Name|Icon)$/u }),
    ).toHaveCount(0);
    const [nameBounds, iconBounds, overflow] = await Promise.all([
      name.boundingBox(),
      icon.boundingBox(),
      row.evaluate((element) => element.scrollWidth - element.clientWidth),
    ]);
    expect(nameBounds).not.toBeNull();
    expect(iconBounds).not.toBeNull();
    // stack remote identity fields at every viewport width
    expect(iconBounds!.y).toBeGreaterThanOrEqual(nameBounds!.y + nameBounds!.height);
    expect(Math.abs(nameBounds!.x - iconBounds!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(nameBounds!.width - iconBounds!.width)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(nameBounds!.height - iconBounds!.height),
    ).toBeLessThanOrEqual(1);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    expect(saves).toHaveLength(0);
    expect(validations).toHaveLength(0);
  });
}

test("clears identity overrides through remove patches while keeping controls available across discard and save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, saves } = await setupRemoteSettings(page, {
    remotes: [
      {
        url: "https://framework.example.test",
        name: "Workshop",
        icon: "heart",
      },
    ],
    metadata: [
      {
        url: "https://framework.example.test",
        name: "Workshop",
        icon: "heart",
        defaultName: "Framework",
        defaultIcon: "potato",
      },
    ],
  });
  let row = remoteRows(settings).first();
  await editRemote(row);
  let name = row.getByRole("textbox", { name: "Name", exact: true });
  let icon = row.getByRole("combobox", { name: "Icon", exact: true });
  await expect(name).toHaveValue("Workshop");
  await expect(name).toHaveAttribute("placeholder", "Framework (from Remote server identity)");
  await expect(icon).toHaveAttribute("data-value", "heart");

  await name.fill("   ");
  await chooseValue(icon, "server-default");
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await confirmSettingsDiscard(page);
  row = remoteRows(settings).first();
  await expect(
    row.getByRole("button", { name: /^Edit Remote server \d+$/u }),
  ).toBeVisible();
  await editRemote(row);
  name = row.getByRole("textbox", { name: "Name", exact: true });
  icon = row.getByRole("combobox", { name: "Icon", exact: true });
  await expect(name).toHaveValue("Workshop");
  await expect(icon).toHaveAttribute("data-value", "heart");

  await name.fill("");
  await chooseValue(icon, "server-default");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes).toEqual([
    expect.objectContaining({
      sourceId: "app",
      patches: expect.arrayContaining([
        { op: "remove", path: ["remoteServers", "0", "name"] },
        { op: "remove", path: ["remoteServers", "0", "icon"] },
      ]),
    }),
  ]);
  expect(JSON.stringify(saves[0])).not.toContain("server-default");
  row = remoteRows(settings).first();
  await editRemote(row);
  await expect(
    row.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("");
  await expect(
    row.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "Framework (from Remote server identity)");
  await expect(
    row.getByRole("combobox", { name: "Icon", exact: true }),
  ).toHaveAttribute("data-value", "server-default");
  await expect(
    row.getByRole("combobox", { name: "Icon", exact: true }).locator("img"),
  ).toHaveAttribute("src", /\/instance-icons\/potato\.svg/u);
  await expect(
    page.getByRole("status", { name: "Restart pending" }),
  ).toBeVisible();
});

test("keeps duplicate row identity associated by canonical URL through reorder", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings, saves } = await setupRemoteSettings(page, {
    remotes: [
      { url: "https://framework.example.test/" },
      { url: "https://lab.example.test", name: "Local Lab", icon: "heart" },
    ],
    metadata: [
      {
        url: "https://framework.example.test",
        name: "Framework",
        icon: "potato",
        defaultName: "Framework",
        defaultIcon: "potato",
      },
      {
        url: "https://lab.example.test/",
        name: "Local Lab",
        icon: "heart",
        defaultName: "Laboratory",
        defaultIcon: "terminal",
      },
    ],
  });
  await expect(remoteRows(settings)).toHaveCount(2);
  await editRemote(remoteRows(settings).nth(0));
  await expect(
    remoteRows(settings)
      .nth(0)
      .getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "Framework (from Remote server identity)");
  await remoteRows(settings)
    .nth(0)
    .getByRole("button", { name: /^Close Remote server \d+$/u })
    .click();
  await editRemote(remoteRows(settings).nth(1));
  await expect(
    remoteRows(settings)
      .nth(1)
      .getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Local Lab");
  await expect(
    remoteRows(settings)
      .nth(1)
      .getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "Laboratory (from Remote server identity)");
  await remoteRows(settings)
    .nth(1)
    .getByRole("button", { name: "Move Remote servers 2 up", exact: true })
    .click();
  const first = remoteRows(settings).nth(0);
  await editRemote(first);
  await expect(
    first.getByRole("textbox", { name: "URL", exact: true }),
  ).toHaveValue("https://lab.example.test");
  await expect(
    first.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Local Lab");
  await expect(
    first.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "Laboratory (from Remote server identity)");
  await expect(
    first.getByRole("combobox", { name: "Icon", exact: true }),
  ).toHaveAttribute("data-value", "heart");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]!.changes[0]?.patches).toContainEqual({
    op: "move",
    path: ["remoteServers"],
    from: 1,
    to: 0,
  });
});

test("updates inherited peer metadata without replacing local drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const update = deferred<RemoteMetadata[]>();
  const fixture = await setupRemoteSettings(page, {
    remotes: [{ url: "https://framework.example.test", name: "Pinned name" }],
    metadata: [
      {
        url: "https://framework.example.test",
        name: "Pinned name",
        icon: "terminal",
        defaultName: "Old peer",
        defaultIcon: "terminal",
      },
    ],
    heldMetadata: update.promise,
  });
  const row = remoteRows(fixture.settings).first();
  await editRemote(row);
  const url = row.getByRole("textbox", { name: "URL", exact: true });
  const name = row.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("Pinned name");
  await name.fill("Browser draft");
  await url.fill("https://framework.example.test/");
  update.resolve([
    {
      url: "https://framework.example.test",
      name: "Pinned name",
      icon: "heart",
      defaultName: "New peer",
      defaultIcon: "heart",
    },
  ]);
  await expect.poll(() => fixture.statusRequests).toBeGreaterThanOrEqual(1);
  await expect(name).toHaveValue("Browser draft");
  await expect(name).toHaveAttribute("placeholder", "New peer (from Remote server identity)");
  const icon = row.getByRole("combobox", { name: "Icon", exact: true });
  await expect(icon).toHaveAttribute("data-value", "server-default");
  await expect(icon.locator("img")).toHaveAttribute(
    "src",
    /\/instance-icons\/heart\.svg/u,
  );
});

test("falls back to legacy metadata and offline hostnames without fetching edited URLs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { settings, externalRequests } = await setupRemoteSettings(page, {
    remotes: [
      { url: "https://framework.example.test/" },
      { url: "https://offline.example.test" },
    ],
    metadata: [
      {
        url: "https://framework.example.test",
        name: "Legacy Framework",
        icon: "potato",
      },
    ],
  });
  const legacy = remoteRows(settings).nth(0);
  await editRemote(legacy);
  await expect(
    legacy.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "Legacy Framework (from Remote server identity)");
  await expect(
    legacy.getByRole("combobox", { name: "Icon", exact: true }),
  ).toHaveAttribute("data-value", "server-default");
  await expect(
    legacy.getByRole("combobox", { name: "Icon", exact: true }).locator("img"),
  ).toHaveAttribute("src", /\/instance-icons\/potato\.svg/u);
  const offline = remoteRows(settings).nth(1);
  await editRemote(offline);
  await expect(
    offline.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("placeholder", "offline.example.test (from URL hostname)");
  await expect(
    offline.getByRole("combobox", { name: "Icon", exact: true }).locator("img"),
  ).toHaveAttribute("src", /\/instance-icons\/terminal\.svg/u);
  await offline
    .getByRole("textbox", { name: "URL", exact: true })
    .fill("not a valid URL");
  await expect(
    offline.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeVisible();
  await expect(
    offline.getByRole("combobox", { name: "Icon", exact: true }),
  ).toBeVisible();
  expect(externalRequests).toHaveLength(0);
});

test("disables every remote entry action when Application configuration is read-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { settings } = await setupRemoteSettings(page, {
    remotes: [
      { url: "https://framework.example.test" },
      { url: "https://lab.example.test" },
    ],
    metadata: [
      {
        url: "https://framework.example.test",
        name: "Framework",
        defaultName: "Framework",
        defaultIcon: "terminal",
      },
      {
        url: "https://lab.example.test",
        name: "Lab",
        defaultName: "Lab",
        defaultIcon: "potato",
      },
    ],
    writable: false,
  });
  await expect(remoteRows(settings)).toHaveCount(2);
  // check every duplicate row independently
  for (const row of await remoteRows(settings).all()) {
    await editRemote(row);
    await expect(
      row.getByRole("textbox", { name: "URL", exact: true }),
    ).toBeDisabled();
    await expect(
      row.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeDisabled();
    await expect(
      row.getByRole("combobox", { name: "Icon", exact: true }),
    ).toBeDisabled();
  }
  await expect(
    settings.getByRole("button", { name: "+ Add Remote server", exact: true }),
  ).toBeDisabled();
  await expect(
    settings
      .getByRole("button", { name: /Move Remote servers \d (?:up|down)/u })
      .first(),
  ).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: /Remove Remote servers \d/u }).first(),
  ).toBeDisabled();
});
