import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deriveDesiredDescriptor, deriveMigrationPlan, executeMigrationPlans, preflightMigrationPlans, recoverMigrationPlans, rollbackMigrationPlans } from "./migrations.mjs";
import { CHECKOUT_RUNTIME_FILES } from "./checkout-handover.mjs";
import { atomicWriteFile } from "./fs.mjs";

// adopt a compatible checkout without traversing unused package-manager links
test("checkout adoption validates the fixed runtime graph without walking node_modules", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-checkout-adopt-"));
  const active = resolve(root, "active"); const target = resolve(root, "target");
  try {
    for (const checkout of [active, target]) {
      for (const relative of CHECKOUT_RUNTIME_FILES) {
        const destination = resolve(checkout, relative); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(resolve(relative), destination); chmodSync(destination, statSync(destination).mode & 0o755);
      }
    }
    symlinkSync("unused-package-link", resolve(target, "node_modules"));
    const descriptor = { kind: "compose", hostCheckout: active, allowedRoots: [root] };
    const plan = { key: "host.checkout", from: active, to: target, directory: true, adoptOnly: true, mode: "adopt" };
    await preflightMigrationPlans(descriptor, [plan]);
    assert.deepEqual(executeMigrationPlans(descriptor, [plan], "checkout_adopt_operation_01"), []);
    await assert.rejects(preflightMigrationPlans(descriptor, [{ ...plan, key: "RAC_ADAPTER_FILES_DIR", adoptOnly: false }]), { code: "unsafe-migration-source" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration paths come only from changed candidate selectors", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-"));
  chmodSync(root, 0o700);
  const config = resolve(root, "config");
  mkdirSync(config, { mode: 0o700 });
  const oldApp = resolve(config, "old.json");
  const newApp = resolve(config, "new.json");
  const env = resolve(root, ".env");
  const candidate = resolve(root, "candidate.env");
  atomicWriteFile(oldApp, '{"version":1}\n', 0o600);
  atomicWriteFile(env, "RAC_CONFIG=/workspace/config/old.json\nRAC_CONFIG_WRITE_PATH=/workspace/config/old.json\n", 0o600);
  atomicWriteFile(candidate, "RAC_CONFIG=/workspace/config/new.json\nRAC_CONFIG_WRITE_PATH=/workspace/config/new.json\n", 0o600);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: {
      env: { path: env, kind: "env" },
      app: { path: oldApp, serverPath: "/workspace/config/old.json", kind: "json" }
    }
  };
  const request = { sources: [{ id: "env", migration: { mode: "copy" } }] };
  const plans = deriveMigrationPlan(descriptor, request, new Map([["env", candidate]]), {
    RAC_CONFIG: { candidateWins: true },
    RAC_CONFIG_WRITE_PATH: { candidateWins: true }
  });
  assert.deepEqual(plans, [{
    key: "RAC_CONFIG",
    from: oldApp,
    to: newApp,
    kind: "json",
    mode: "copy"
  }]);
  const created = executeMigrationPlans(descriptor, plans, "migration_operation_1");
  assert.equal(readFileSync(newApp, "utf8"), '{"version":1}\n');
  rollbackMigrationPlans(created);
  assert.throws(() => readFileSync(newApp));
});

test("changed selectors require an explicit migration mode", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-required-"));
  chmodSync(root, 0o700);
  const config = resolve(root, "config");
  mkdirSync(config, { mode: 0o700 });
  const env = resolve(root, ".env");
  const candidate = resolve(root, "candidate.env");
  atomicWriteFile(resolve(config, "old.json"), '{}\n', 0o600);
  atomicWriteFile(env, "RAC_CONFIG=/workspace/config/old.json\n", 0o600);
  atomicWriteFile(candidate, "RAC_CONFIG=/workspace/config/new.json\n", 0o600);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: { env: { path: env, kind: "env" } }
  };
  const request = { sources: [{ id: "env" }] };
  assert.throws(
    () => deriveMigrationPlan(descriptor, request, new Map([["env", candidate]]), {
      RAC_CONFIG: { candidateWins: true }
    }),
    (error) => error.code === "migration-required"
  );
});

test("missing handovers report every requested source owner", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-owners-"));
  chmodSync(root, 0o700);
  const env = resolve(root, ".env");
  const candidateEnv = resolve(root, "candidate.env");
  const installation = resolve(root, "installation.json");
  const candidateInstallation = resolve(root, "candidate-installation.json");
  atomicWriteFile(env, `RAC_NOTES_FILE=${resolve(root, "old-notes.json")}\n`, 0o600);
  atomicWriteFile(candidateEnv, `RAC_NOTES_FILE=${resolve(root, "new-notes.json")}\n`, 0o600);
  atomicWriteFile(installation, `${JSON.stringify({ version: 1, sources: { wrapper: resolve(root, "old-wrapper") } })}\n`, 0o600);
  atomicWriteFile(candidateInstallation, `${JSON.stringify({ version: 1, sources: { wrapper: resolve(root, "new-wrapper") } })}\n`, 0o600);
  const descriptor = {
    kind: "systemd",
    hostCheckout: root,
    allowedRoots: [root],
    sources: {
      env: { path: env, kind: "env" },
      installation: { path: installation, kind: "installation" }
    }
  };
  assert.throws(
    () => deriveMigrationPlan(
      descriptor,
      { sources: [{ id: "env" }, { id: "installation" }] },
      new Map([["env", candidateEnv], ["installation", candidateInstallation]])
    ),
    (error) => error.code === "migration-required" && assert.deepEqual(error.sourceIds, ["env", "installation"]) === undefined
  );
});

test("shadowed Compose selectors save without migration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-shadowed-selector-"));
  chmodSync(root, 0o700);
  const env = resolve(root, ".env");
  const candidate = resolve(root, "candidate.env");
  atomicWriteFile(env, "RAC_CONFIG=/workspace/config/old.json\n", 0o600);
  atomicWriteFile(candidate, "RAC_CONFIG=/workspace/config/new.json\n", 0o600);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: { env: { path: env, kind: "env" } }
  };
  const request = { sources: [{ id: "env", migration: { mode: "copy" } }] };
  const plans = deriveMigrationPlan(descriptor, request, new Map([["env", candidate]]), {
    RAC_CONFIG: { candidateWins: false, explicitlyShadowed: true }
  });
  assert.deepEqual(plans, []);
});

test("new persistence selectors require an explicit handover", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-new-selector-"));
  chmodSync(root, 0o700);
  const env = resolve(root, ".env");
  const candidate = resolve(root, "candidate.env");
  const notes = resolve(root, "notes.json");
  atomicWriteFile(env, "UNCHANGED=1\n", 0o600);
  atomicWriteFile(candidate, `UNCHANGED=1\nRAC_NOTES_FILE=${notes}\n`, 0o600);
  const descriptor = { kind: "systemd", hostCheckout: root, allowedRoots: [root], sources: { env: { path: env, kind: "env" } } };
  const candidates = new Map([["env", candidate]]);
  assert.throws(
    () => deriveMigrationPlan(descriptor, { sources: [{ id: "env" }] }, candidates),
    { code: "migration-required" }
  );
  const plans = deriveMigrationPlan(descriptor, { sources: [{ id: "env", migration: { mode: "empty" } }] }, candidates);
  executeMigrationPlans(descriptor, plans, "new_selector_empty001");
  assert.equal(readFileSync(notes, "utf8"), "");
});

test("installation runtime options do not require migration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-installation-options-"));
  chmodSync(root, 0o700);
  const installation = resolve(root, "remote-agent-console.installation.json");
  const candidate = resolve(root, "candidate.json");
  const original = {
    version: 1,
    host: { checkout: root },
    compose: {
      projectDirectory: root,
      projectName: "rac",
      files: [resolve(root, "compose.yaml")],
      envFiles: [resolve(root, ".env")],
      profiles: [],
      options: {}
    },
    sources: { wrapper: resolve(root, "wrapper.sh"), icons: {} }
  };
  atomicWriteFile(installation, `${JSON.stringify(original)}\n`, 0o600);
  atomicWriteFile(candidate, `${JSON.stringify({
    ...original,
    compose: {
      ...original.compose,
      projectName: "rac-next",
      profiles: ["tunnel"],
      options: { parallel: 8, compatibility: true }
    }
  })}\n`, 0o600);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: { installation: { path: installation, kind: "installation" } }
  };
  const request = { sources: [{ id: "installation" }] };
  assert.deepEqual(
    deriveMigrationPlan(descriptor, request, new Map([["installation", candidate]])),
    []
  );
});

test("empty handover is limited to persistence targets", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-empty-migration-"));
  chmodSync(root, 0o700);
  const oldNotes = resolve(root, "old-notes.json");
  const newNotes = resolve(root, "new-notes.json");
  const oldConfig = resolve(root, "old-config.json");
  const newConfig = resolve(root, "new-config.json");
  const env = resolve(root, ".env");
  const persistenceCandidate = resolve(root, "persistence.env");
  const configCandidate = resolve(root, "config.env");
  atomicWriteFile(oldNotes, '{}\n', 0o600);
  atomicWriteFile(oldConfig, '{}\n', 0o600);
  atomicWriteFile(env, `RAC_NOTES_FILE=${oldNotes}\nRAC_CONFIG=${oldConfig}\n`, 0o600);
  atomicWriteFile(persistenceCandidate, `RAC_NOTES_FILE=${newNotes}\nRAC_CONFIG=${oldConfig}\n`, 0o600);
  atomicWriteFile(configCandidate, `RAC_NOTES_FILE=${oldNotes}\nRAC_CONFIG=${newConfig}\n`, 0o600);
  const descriptor = { kind: "systemd", hostCheckout: root, allowedRoots: [root], sources: { env: { path: env, kind: "env" } } };
  const persistence = deriveMigrationPlan(
    descriptor,
    { sources: [{ id: "env", migration: { mode: "empty" } }] },
    new Map([["env", persistenceCandidate]])
  );
  executeMigrationPlans(descriptor, persistence, "empty_persistence_001");
  assert.equal(readFileSync(newNotes, "utf8"), "");
  const required = deriveMigrationPlan(
    descriptor,
    { sources: [{ id: "env", migration: { mode: "empty" } }] },
    new Map([["env", configCandidate]])
  );
  assert.throws(() => executeMigrationPlans(descriptor, required, "empty_required_00001"), { code: "empty-target-not-allowed" });
});

test("native cloudflared unit remains installer-owned", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-native-unit-"));
  chmodSync(root, 0o700);
  const installation = resolve(root, "installation.json");
  const candidate = resolve(root, "candidate.json");
  atomicWriteFile(installation, '{"version":1,"native":{"cloudflaredUnit":"cloudflared.service"}}\n', 0o600);
  atomicWriteFile(candidate, '{"version":1,"native":{"cloudflaredUnit":"unrelated.service"}}\n', 0o600);
  const descriptor = {
    kind: "systemd",
    hostCheckout: root,
    allowedRoots: [root],
    native: { cloudflaredUnit: "cloudflared.service" },
    sources: { installation: { path: installation, kind: "installation" } }
  };
  assert.throws(() => deriveMigrationPlan(
    descriptor,
    { sources: [{ id: "installation" }] },
    new Map([["installation", candidate]])
  ), { code: "immutable-cloudflared-unit" });
});

test("Compose-owned selectors reject silent adoption and support explicit copy or adopt", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-compose-selector-"));
  chmodSync(root, 0o700);
  const oldApp = resolve(root, "old-app.json");
  const oldConfig = resolve(root, "old-cloudflared.yml");
  const oldCredentials = resolve(root, "old-credentials.json");
  const newApp = resolve(root, "new-app.json");
  const newConfig = resolve(root, "new-cloudflared.yml");
  const newCredentials = resolve(root, "new-credentials.json");
  atomicWriteFile(oldApp, "{}\n", 0o600);
  atomicWriteFile(oldConfig, "tunnel: old\n", 0o600);
  atomicWriteFile(oldCredentials, "{}\n", 0o600);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: {
      compose: { path: resolve(root, "compose.yaml"), kind: "compose" },
      app: { path: oldApp, kind: "json" },
      cloudflared: { path: oldConfig, kind: "cloudflared" },
      "cloudflared-credentials": { path: oldCredentials, kind: "credentials" }
    }
  };
  const candidates = new Map([["compose", resolve(root, "candidate-compose.yaml")]]);
  const selectors = {
    app: { path: newApp },
    cloudflared: { path: newConfig },
    "cloudflared-credentials": { path: newCredentials }
  };
  assert.throws(
    () => deriveMigrationPlan(descriptor, { sources: [{ id: "compose" }] }, candidates, {}, selectors),
    (error) => error.code === "migration-required" && assert.deepEqual(error.sourceIds, ["compose"]) === undefined
  );
  descriptor.sources["compose-override"] = { path: resolve(root, "compose.override.yaml"), kind: "compose" };
  assert.throws(
    () => deriveMigrationPlan(descriptor, { sources: [{ id: "compose" }, { id: "compose-override" }] }, candidates, {}, selectors),
    (error) => error.code === "migration-required" && assert.deepEqual(error.sourceIds, ["compose-override"]) === undefined
  );
  const copyPlans = deriveMigrationPlan(descriptor, { sources: [{ id: "compose", migration: { mode: "copy" } }] }, candidates, {}, selectors);
  const copied = executeMigrationPlans(descriptor, copyPlans, "compose_selector_copy01");
  assert.equal(readFileSync(newApp, "utf8"), "{}\n");
  assert.equal(readFileSync(newConfig, "utf8"), "tunnel: old\n");
  rollbackMigrationPlans(copied);
  atomicWriteFile(newApp, "{\"adopted\":true}\n", 0o600);
  atomicWriteFile(newConfig, "tunnel: adopted\n", 0o600);
  atomicWriteFile(newCredentials, "{\"adopted\":true}\n", 0o600);
  const adoptPlans = deriveMigrationPlan(descriptor, { sources: [{ id: "compose", migration: { mode: "adopt" } }] }, candidates, {}, selectors);
  assert.deepEqual(executeMigrationPlans(descriptor, adoptPlans, "compose_selector_adopt1"), []);
  assert.equal(readFileSync(newApp, "utf8"), "{\"adopted\":true}\n");
});

test("merged Compose handovers reject ambiguous noncanonical owners", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-compose-owner-"));
  chmodSync(root, 0o700);
  const descriptor = {
    kind: "compose",
    hostCheckout: root,
    allowedRoots: [root],
    sources: {
      "compose-a": { path: resolve(root, "a.yaml"), kind: "compose" },
      "compose-b": { path: resolve(root, "b.yaml"), kind: "compose" },
      app: { path: resolve(root, "old.json"), kind: "json" }
    }
  };
  assert.throws(
    () => deriveMigrationPlan(
      descriptor,
      { sources: [{ id: "compose-a" }, { id: "compose-b" }] },
      new Map(),
      {},
      { app: { path: resolve(root, "new.json") } }
    ),
    { code: "ambiguous-migration" }
  );
});

// preserve raced files without reporting them as published migrations
test("migration publication never overwrites a raced destination", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-race-"));
  chmodSync(root, 0o700);
  const from = resolve(root, "from.json");
  const to = resolve(root, "to.json");
  atomicWriteFile(from, "{\"source\":true}\n", 0o600);
  const descriptor = { allowedRoots: [root] };
  const plan = { key: "test", from, to, kind: "json", mode: "copy" };
  const aborted = [];
  assert.throws(
    () => executeMigrationPlans(descriptor, [plan], "migration_publish_race1", {
      // insert an unrelated target at the publication boundary
      beforePublish: () => atomicWriteFile(to, "human bytes\n", 0o600),
      // retire only the unfulfilled publication intent
      onPublishAborted: (record) => aborted.push(record),
      // a skipped rename must never invoke success callbacks
      afterPublish: () => assert.fail("skipped migration was reported as published"),
      // retain the same boundary for durable publication records
      onPublished: () => assert.fail("skipped migration was journaled as published")
    }),
    { code: "migration-target-exists" }
  );
  assert.equal(readFileSync(to, "utf8"), "human bytes\n");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].path, to);
  assert.equal(existsSync(resolve(root, ".migration_publish_race1.migration")), false);
});

// preserve raced directories as well as ordinary file destinations
test("migration publication aborts when a destination directory appears", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-directory-race-"));
  const from = resolve(root, "from");
  const to = resolve(root, "to");
  const aborted = [];
  try {
    mkdirSync(from, { mode: 0o700 });
    atomicWriteFile(resolve(from, "source.txt"), "source bytes\n", 0o600);
    const plan = { key: "test", from, to, directory: true, mode: "copy" };
    assert.throws(
      () => executeMigrationPlans({ allowedRoots: [root] }, [plan], "migration_directory_race1", {
        // publish an unrelated directory immediately before the atomic rename
        beforePublish: () => {
          mkdirSync(to, { mode: 0o700 });
          atomicWriteFile(resolve(to, "human.txt"), "human bytes\n", 0o600);
        },
        // retire only the unfulfilled publication intent
        onPublishAborted: (record) => aborted.push(record),
        // a skipped rename must never invoke success callbacks
        afterPublish: () => assert.fail("skipped migration was reported as published"),
        // retain the same boundary for durable publication records
        onPublished: () => assert.fail("skipped migration was journaled as published")
      }),
      { code: "migration-target-exists" }
    );
    assert.equal(readFileSync(resolve(to, "human.txt"), "utf8"), "human bytes\n");
    assert.equal(existsSync(resolve(to, "source.txt")), false);
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0].path, to);
    assert.equal(existsSync(resolve(root, ".migration_directory_race1.migration")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback refuses a replaced migration target", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-replace-"));
  chmodSync(root, 0o700);
  const from = resolve(root, "from.json");
  const to = resolve(root, "to.json");
  atomicWriteFile(from, "{\"source\":true}\n", 0o600);
  const records = executeMigrationPlans(
    { allowedRoots: [root] },
    [{ key: "test", from, to, kind: "json", mode: "copy" }],
    "migration_replace_late1"
  );
  rmSync(to);
  atomicWriteFile(to, "human replacement\n", 0o600);
  assert.throws(() => rollbackMigrationPlans(records), { code: "manual-recovery-required" });
  assert.equal(readFileSync(to, "utf8"), "human replacement\n");
});

test("published ownership records survive a later plan failure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-partial-"));
  chmodSync(root, 0o700);
  const from = resolve(root, "from.json");
  const first = resolve(root, "first.json");
  const human = resolve(root, "human.json");
  atomicWriteFile(from, "{\"source\":true}\n", 0o600);
  atomicWriteFile(human, "human bytes\n", 0o600);
  const published = [];
  assert.throws(() => executeMigrationPlans(
    { allowedRoots: [root] },
    [
      { key: "first", from, to: first, kind: "json", mode: "copy" },
      { key: "second", from, to: human, kind: "json", mode: "copy" }
    ],
    "migration_partial_fail1",
    { onPublished: (record) => published.push(record) }
  ), { code: "migration-target-exists" });
  assert.equal(published.length, 1);
  rollbackMigrationPlans(published);
  assert.throws(() => readFileSync(first));
  assert.equal(readFileSync(human, "utf8"), "human bytes\n");
});

test("prepublication records recover both sides of the process-death seam", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-death-seam-"));
  chmodSync(root, 0o700);
  const from = resolve(root, "from.json");
  const published = resolve(root, "published.json");
  const absent = resolve(root, "absent.json");
  atomicWriteFile(from, "{\"source\":true}\n", 0o600);
  const descriptor = { allowedRoots: [root] };
  const publishedPlan = { key: "published", from, to: published, kind: "json", mode: "copy" };
  const publishedRecords = [];
  assert.throws(() => executeMigrationPlans(descriptor, [publishedPlan], "migration_death_after1", {
    onPublishing: (record) => publishedRecords.push(record),
    afterPublish: () => {
      throw new Error("simulated-process-death");
    },
    onPublished: () => assert.fail("postpublication callback must not run")
  }), /simulated-process-death/u);
  assert.equal(readFileSync(published, "utf8"), "{\"source\":true}\n");
  recoverMigrationPlans([publishedPlan], "migration_death_after1", publishedRecords);
  assert.equal(existsSync(published), false);
  const fromDirectory = resolve(root, "from-directory");
  const publishedDirectory = resolve(root, "published-directory");
  mkdirSync(fromDirectory, { mode: 0o700 });
  atomicWriteFile(resolve(fromDirectory, "owned.txt"), "owned bytes\n", 0o600);
  const directoryPlan = { key: "published-directory", from: fromDirectory, to: publishedDirectory, directory: true, mode: "copy" };
  const directoryRecords = [];
  assert.throws(() => executeMigrationPlans(descriptor, [directoryPlan], "migration_dir_death001", {
    onPublishing: (record) => directoryRecords.push(record),
    afterPublish: () => {
      throw new Error("simulated-process-death");
    }
  }), /simulated-process-death/u);
  assert.equal(readFileSync(resolve(publishedDirectory, "owned.txt"), "utf8"), "owned bytes\n");
  recoverMigrationPlans([directoryPlan], "migration_dir_death001", directoryRecords);
  assert.equal(existsSync(publishedDirectory), false);
  const absentPlan = { key: "absent", from, to: absent, kind: "json", mode: "copy" };
  const absentRecords = [];
  assert.throws(() => executeMigrationPlans(descriptor, [absentPlan], "migration_death_before", {
    onPublishing: (record) => {
      absentRecords.push(record);
      throw new Error("simulated-process-death");
    }
  }), /simulated-process-death/u);
  recoverMigrationPlans([absentPlan], "migration_death_before", absentRecords);
  assert.equal(existsSync(absent), false);
});

test("SIGKILL after publication recovers from the durable prepublication record", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-migration-sigkill-"));
  chmodSync(root, 0o700);
  const from = resolve(root, "from.json");
  const target = resolve(root, "target.json");
  const journal = resolve(root, "journal.json");
  const child = resolve(root, "crash.mjs");
  const transactionId = "migration_sigkill_001";
  atomicWriteFile(from, "{\"source\":true}\n", 0o600);
  atomicWriteFile(child, `
import { writeFileSync } from "node:fs";
import { executeMigrationPlans } from ${JSON.stringify(new URL("./migrations.mjs", import.meta.url).href)};
const [root, from, target, journal, transactionId] = process.argv.slice(2);
const plan = { key: "sigkill", from, to: target, kind: "json", mode: "copy" };
executeMigrationPlans({ allowedRoots: [root] }, [plan], transactionId, {
  onPublishing: (record) => writeFileSync(journal, JSON.stringify([record]), { mode: 0o600 }),
  afterPublish: () => process.kill(process.pid, "SIGKILL"),
  onPublished: () => { throw new Error("unreachable-postpublication-callback"); }
});
`, 0o600);
  const terminated = spawnSync(process.execPath, [child, root, from, target, journal, transactionId], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(terminated.signal, "SIGKILL");
  assert.equal(terminated.stdout, "");
  assert.equal(terminated.stderr, "");
  assert.equal(readFileSync(target, "utf8"), "{\"source\":true}\n");
  const records = JSON.parse(readFileSync(journal, "utf8"));
  recoverMigrationPlans([{ key: "sigkill", from, to: target, kind: "json", mode: "copy" }], transactionId, records);
  assert.equal(existsSync(target), false);
});

test("native effective selectors require paired config and checkout identities", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-native-selectors-"));
  chmodSync(root, 0o700);
  const control = resolve(root, "control");
  const config = resolve(root, "config");
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  const oldApp = resolve(config, "old.json");
  const newApp = resolve(config, "new.json");
  const env = resolve(root, ".env");
  const installation = resolve(config, "remote-agent-console.installation.json");
  atomicWriteFile(oldApp, "{}\n", 0o600);
  atomicWriteFile(newApp, "{}\n", 0o600);
  atomicWriteFile(installation, `${JSON.stringify({ version: 1, host: { checkout: root }, native: { environmentFile: env } })}\n`, 0o600);
  const descriptor = {
    version: 1,
    installationId: "native-selector-test1",
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: "systemd",
    hostControlRoot: control,
    controlRoot: control,
    hostCheckout: root,
    serverCheckout: root,
    allowedRoots: [root],
    sources: {
      app: { path: oldApp, serverPath: oldApp, kind: "json", apply: "rac-restart" },
      env: { path: env, serverPath: env, kind: "env", apply: "rac-restart" },
      installation: { path: installation, serverPath: installation, kind: "installation", apply: "rac-restart" }
    },
    native: { unit: "remote-agent-console.service", environmentFile: env }
  };
  atomicWriteFile(env, `RAC_CONFIG=${newApp}\nRAC_CONFIG_WRITE_PATH=${oldApp}\n`, 0o600);
  await assert.rejects(() => deriveDesiredDescriptor(descriptor), { code: "selector-not-winning-source" });
  atomicWriteFile(env, `RAC_CONFIG=${newApp}\nRAC_CONFIG_WRITE_PATH=${newApp}\nRAC_SERVER_CHECKOUT=${resolve(root, "other")}\n`, 0o600);
  await assert.rejects(() => deriveDesiredDescriptor(descriptor), { code: "selector-not-winning-source" });
  atomicWriteFile(env, `RAC_CONFIG=${newApp}\nRAC_CONFIG_WRITE_PATH=${newApp}\nRAC_SERVER_CHECKOUT=${root}\n`, 0o600);
  const desired = await deriveDesiredDescriptor(descriptor);
  assert.equal(desired.sources.app.path, newApp);
});
