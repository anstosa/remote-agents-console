import assert from "node:assert/strict";
import {
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { validateDescriptor } from "./contracts.mjs";
import { frameFields, openLocal, sealLocal, sha256 } from "./crypto.mjs";
import { atomicWriteFile, safeError } from "./fs.mjs";
import { addManagedControlMount, installSettingsApplier } from "./install.mjs";
import { currentSourceManifest, ensureRecoveryKey, recoverClaimedTransaction } from "./operations.mjs";
import { applyTargets, processOperation } from "./operations.mjs";
import { drainQueue, enqueueRequest, processClaim, removeExpiredDisclosureStatuses } from "./queue.mjs";
import { composePrefix, validateComposeCandidates, validateInstallationSettings, validateSvg } from "./validate.mjs";
import { RESTART_WATCHDOG_TIMEOUT_MS } from "./restart-watchdog.mjs";

const TEST_AUTH_ENV = "RAC_PASSWORD_HASH='$argon2id$fixture'\nRAC_SESSION_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";

// provide one deterministic restart deadline per operation
function restartClock(start = 20_000) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, delay) => {
      const selected = { id: ++sequence, callback, at: now + delay };
      timers.set(selected.id, selected);
      return selected.id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    advance: (milliseconds) => {
      now += milliseconds;
      const dueTimers = [...timers.values()].filter((timer) => timer.at <= now).sort((left, right) => left.at - right.at || left.id - right.id);
      // fire each due timer at most once
      for (const due of dueTimers) {
        timers.delete(due.id);
        due.callback();
      }
    },
    pending: () => timers.size > 0
  };
}

// wait for one bounded asynchronous test condition
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  // poll only through the real test deadline
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return predicate();
}

// invalid request bodies cannot orphan their filename-owned plaintext stage
test("invalid claimed requests clean only their own filename stage", async () => {
  const current = fixture();
  const foreignId = "foreign_operation_000001";
  const foreignStage = resolve(current.controlRoot, "staging", foreignId);
  mkdirSync(foreignStage, { mode: 0o700 });
  atomicWriteFile(resolve(foreignStage, "env"), "foreign sentinel", 0o600);
  // cover malformed JSON and a mismatched body identity
  for (const variant of ["malformed", "mismatched"]) {
    const fileId = `invalid_${variant}_operation_000001`;
    const stage = resolve(current.controlRoot, "staging", fileId);
    mkdirSync(stage, { mode: 0o700 });
    atomicWriteFile(resolve(stage, "env"), "private staged sentinel", 0o600);
    const path = resolve(current.controlRoot, "claimed", `${fileId}.json`);
    atomicWriteFile(path, variant === "malformed" ? "{" : JSON.stringify({ version: 1, id: foreignId, kind: "inspect", generation: 1, inspect: { sourceId: "app" } }), 0o600);
    await processClaim(path, current.descriptor);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(foreignStage), true);
    assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${fileId}.json`), "utf8")).state, "failed");
  }
});

test("migration-required statuses expose only requested source identities", async () => {
  const current = fixture();
  const id = "migration_metadata_00001";
  current.descriptor.sources.env = { path: current.app, serverPath: current.app, kind: "env", apply: "rac-restart" };
  const path = resolve(current.controlRoot, "claimed", `${id}.json`);
  atomicWriteFile(path, JSON.stringify({
    version: 1,
    id,
    kind: "validate",
    generation: 1,
    sources: [
      { id: "app", contentHash: sha256(readFileSync(current.app)), candidate: "app" },
      { id: "env", contentHash: sha256(readFileSync(current.app)), candidate: "env" }
    ]
  }), 0o600);
  await processClaim(path, current.descriptor, {
    withMutation: async () => {
      const error = safeError("migration-required");
      error.sourceIds = ["env", "env", "compose", "../../private", "app"];
      throw error;
    }
  });
  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  const latest = JSON.parse(readFileSync(resolve(current.controlRoot, "latest.json"), "utf8"));
  assert.deepEqual(status.errorMetadata, { sourceIds: ["env", "app"] });
  assert.equal(Object.hasOwn(latest, "errorMetadata"), false);
});

test("restart status persists the watchdog deadline through terminal success", async () => {
  const current = fixture();
  const id = "restart_status_success01";
  const clock = restartClock(30_000);
  const claimed = resolve(current.controlRoot, "claimed", `${id}.json`);
  atomicWriteFile(claimed, `${JSON.stringify({
    version: 1,
    id,
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac"]
  })}\n`, 0o600);
  await processClaim(claimed, current.descriptor, {
    restartWatchdogClock: clock,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    runner: async (_command, args) => {
      // require durable progress before the mutating restart command
      if (args.includes("restart")) {
        const running = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
        assert.deepEqual(running.restart, { recoveryDeadline: 30_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "restarting" });
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async () => ({ bootNonce: "fresh-boot" })
  });

  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  const latest = JSON.parse(readFileSync(resolve(current.controlRoot, "latest.json"), "utf8"));
  assert.deepEqual(status.restart, { recoveryDeadline: 30_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "restarted" });
  assert.deepEqual(latest.restart, status.restart);
});

test("claimed restart replay preserves prior progress through failure", async () => {
  const current = fixture();
  const id = "restart_status_replay001";
  const restart = { recoveryDeadline: 123_456, state: "restarting" };
  const request = {
    version: 1,
    id,
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac"]
  };
  const claimed = resolve(current.controlRoot, "claimed", `${id}.json`);
  atomicWriteFile(claimed, `${JSON.stringify(request)}\n`, 0o600);
  atomicWriteFile(resolve(current.controlRoot, "status", `${id}.json`), `${JSON.stringify({ version: 1, id, kind: "restart", state: "running", restart })}\n`, 0o600);
  await processClaim(claimed, current.descriptor, {
    withMutation: async () => {
      const running = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
      assert.deepEqual(running.restart, restart);
      throw safeError("replay-failed");
    }
  });

  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  const latest = JSON.parse(readFileSync(resolve(current.controlRoot, "latest.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.deepEqual(status.restart, restart);
  assert.deepEqual(latest.restart, restart);
});

// create one private isolated installation
function fixture(options = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-"));
  chmodSync(root, 0o700);
  const controlRoot = resolve(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  for (const name of ["queued", "claimed", "status", "staging", "journal", "recovery"]) {
    mkdirSync(resolve(controlRoot, name), { mode: 0o700 });
  }
  const app = resolve(root, "app.json");
  atomicWriteFile(app, '{"name":"before"}\n', 0o600);
  const descriptorValue = {
    version: 1,
    installationId: "test-installation-0001",
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: "systemd",
    hostControlRoot: controlRoot,
    hostCheckout: root,
    serverCheckout: root,
    allowedRoots: [root],
    sources: {
      app: { path: app, serverPath: app, kind: "json", apply: "rac-restart" }
    },
    native: { unit: "remote-agent-console.service", environmentFile: app }
  };
  const descriptorPath = resolve(controlRoot, "installation.json");
  atomicWriteFile(descriptorPath, `${JSON.stringify(descriptorValue)}\n`, 0o600);
  ensureRecoveryKey(controlRoot);
  // seed ordinary fixtures with one previously proven RAC baseline
  if (options.baseline !== false) {
    const key = readFileSync(resolve(controlRoot, "recovery.key"));
    const bundle = {
      version: 1,
      target: "rac",
      generation: 1,
      descriptor: descriptorValue,
      originals: [{ id: "app", existed: true, mode: 0o600, bytes: readFileSync(app).toString("base64") }]
    };
    atomicWriteFile(resolve(controlRoot, "recovery/effective-rac.json"), `${JSON.stringify(sealLocal(key, bundle))}\n`, 0o600);
  }
  return {
    root,
    controlRoot,
    app,
    descriptor: validateDescriptor(descriptorValue, descriptorPath)
  };
}

// add one encrypted native Cloudflare recovery baseline
function addNativeCloudBaseline(current) {
  const config = resolve(current.root, "cloudflared.yml");
  const credentials = resolve(current.root, "cloudflared.credentials.json");
  const tunnelId = "00000000-0000-0000-0000-000000000000";
  const configBytes = Buffer.from(`tunnel: ${tunnelId}\ncredentials-file: ${credentials}\n`);
  const credentialBytes = Buffer.from(`${JSON.stringify({ AccountTag: "fixture", TunnelSecret: Buffer.alloc(32, 1).toString("base64"), TunnelID: tunnelId })}\n`);
  atomicWriteFile(config, configBytes, 0o600);
  atomicWriteFile(credentials, credentialBytes, 0o600);
  current.descriptor.sources.cloudflared = { path: config, serverPath: config, kind: "cloudflared", apply: "cloudflared-recreate" };
  current.descriptor.sources["cloudflared-credentials"] = { path: credentials, serverPath: credentials, kind: "credentials", apply: "cloudflared-recreate" };
  current.descriptor.native.cloudflaredUnit = "cloudflared.service";
  const authority = { ...current.descriptor };
  delete authority.controlRoot;
  const command = ["/usr/bin/cloudflared", "tunnel", "--config", config, "--credentials-file", credentials, "run"];
  const bundle = {
    version: 1,
    target: "cloudflared",
    generation: 1,
    descriptor: authority,
    originals: [
      { id: "cloudflared", existed: true, mode: 0o600, bytes: configBytes.toString("base64") },
      { id: "cloudflared-credentials", existed: true, mode: 0o600, bytes: credentialBytes.toString("base64") }
    ],
    proof: {
      nativeCommand: command
    }
  };
  const key = readFileSync(resolve(current.controlRoot, "recovery.key"));
  atomicWriteFile(resolve(current.controlRoot, "recovery/effective-cloudflared.json"), `${JSON.stringify(sealLocal(key, bundle))}\n`, 0o600);
  return { config, credentials, configBytes, credentialBytes, key, command, tunnelId };
}

// build one relocated native Cloudflare descriptor
function nativeCloudDesired(current, cloud) {
  const directory = resolve(current.root, "relocated-cloud");
  mkdirSync(directory, { mode: 0o700 });
  const config = resolve(directory, "cloudflared.yml");
  const credentials = resolve(directory, "cloudflared.credentials.json");
  const configBytes = Buffer.from(`tunnel: ${cloud.tunnelId}\ncredentials-file: ${credentials}\n`);
  atomicWriteFile(config, configBytes, 0o600);
  atomicWriteFile(credentials, cloud.credentialBytes, 0o600);
  const descriptor = {
    ...current.descriptor,
    generation: 2,
    sources: {
      ...current.descriptor.sources,
      cloudflared: { ...current.descriptor.sources.cloudflared, path: config, serverPath: config },
      "cloudflared-credentials": { ...current.descriptor.sources["cloudflared-credentials"], path: credentials, serverPath: credentials }
    },
    native: { ...current.descriptor.native }
  };
  const authority = { ...descriptor };
  delete authority.controlRoot;
  return { descriptor, authority, config, credentials, configBytes };
}

// runtime paths are references, not ownership transfers of system files
test("runtime executable and bridge paths save without ownership migration", async () => {
  const current = fixture();
  const envPath = resolve(current.root, ".env");
  atomicWriteFile(envPath, TEST_AUTH_ENV, 0o600);
  current.descriptor.sources.env = { path: envPath, kind: "env", apply: "rac-restart" };
  const candidate = resolve(current.root, "runtime.env");
  atomicWriteFile(candidate, `${TEST_AUTH_ENV}RAC_INTERACTIVE_SHELL=/bin/sh\nRAC_TMUX_BIN=/usr/bin/tmux\nRAC_HOST_PROC=/proc\nRAC_HOST_PATH=/usr/bin:/bin\nHOST_TMUX_BIN=/usr/bin/tmux\n`, 0o600);
  const { deriveMigrationPlan } = await import("./migrations.mjs");
  const plans = deriveMigrationPlan(current.descriptor, { sources: [{ id: "env" }] }, new Map([["env", candidate]]));
  assert.deepEqual(plans, []);
});

test("validate reports missing migration intent before commit", async () => {
  const current = fixture();
  const env = resolve(current.root, ".env");
  const oldNotes = resolve(current.root, "old-notes.json");
  const newNotes = resolve(current.root, "new-notes.json");
  const currentEnv = `${TEST_AUTH_ENV}RAC_NOTES_FILE=${oldNotes}\n`;
  atomicWriteFile(oldNotes, "{}\n", 0o600);
  atomicWriteFile(env, currentEnv, 0o600);
  current.descriptor.sources.env = { path: env, serverPath: env, kind: "env", apply: "rac-restart" };
  current.descriptor.native.environmentFile = env;
  const id = "validate_migration_0001";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "env"), `${TEST_AUTH_ENV}RAC_NOTES_FILE=${newNotes}\n`, 0o600);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id,
    kind: "validate",
    generation: 1,
    sources: [{ id: "env", contentHash: sha256(Buffer.from(currentEnv)), candidate: "env" }]
  }), { code: "migration-required" });
  assert.equal(existsSync(newNotes), false);
  assert.equal(readFileSync(env, "utf8"), currentEnv);
});

test("validate preflights migration targets and paired native selectors", async () => {
  const current = fixture();
  const env = resolve(current.root, ".env");
  const human = resolve(current.root, "human.json");
  const missing = resolve(current.root, "missing.json");
  const currentEnv = `${TEST_AUTH_ENV}RAC_CONFIG=${current.app}\nRAC_CONFIG_WRITE_PATH=${current.app}\n`;
  atomicWriteFile(env, currentEnv, 0o600);
  atomicWriteFile(human, "{\"human\":true}\n", 0o600);
  current.descriptor.sources.env = { path: env, serverPath: env, kind: "env", apply: "rac-restart" };
  current.descriptor.native.environmentFile = env;
  // submit one isolated validation candidate
  const validate = async (id, candidate) => {
    const stage = resolve(current.controlRoot, "staging", id);
    mkdirSync(stage, { mode: 0o700 });
    atomicWriteFile(resolve(stage, "env"), candidate, 0o600);
    return processOperation(current.descriptor, {
      version: 1,
      id,
      kind: "validate",
      generation: 1,
      sources: [{ id: "env", contentHash: sha256(Buffer.from(currentEnv)), candidate: "env", migration: { mode: "copy" } }]
    });
  };
  await assert.rejects(
    () => validate("validate_existing_0001", `${TEST_AUTH_ENV}RAC_CONFIG=${human}\nRAC_CONFIG_WRITE_PATH=${human}\n`),
    { code: "migration-target-exists" }
  );
  assert.equal(readFileSync(human, "utf8"), "{\"human\":true}\n");
  await assert.rejects(
    () => validate("validate_mismatch_0001", `${TEST_AUTH_ENV}RAC_CONFIG=${current.app}\nRAC_CONFIG_WRITE_PATH=${missing}\n`),
    { code: "selector-not-winning-source" }
  );
  assert.equal(existsSync(missing), false);
});

test("validate rejects a native credential path handover without its paired config edit", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const env = resolve(current.root, ".env");
  const installation = resolve(current.root, "remote-agent-console.installation.json");
  const relocatedCredentials = resolve(current.root, "relocated.credentials.json");
  atomicWriteFile(env, `${TEST_AUTH_ENV}RAC_CONFIG=${current.app}\nRAC_CONFIG_WRITE_PATH=${current.app}\n`, 0o600);
  const settings = {
    version: 1,
    host: { checkout: current.root },
    native: {
      environmentFile: env,
      cloudflaredConfig: cloud.config,
      cloudflaredCredentials: cloud.credentials,
      cloudflaredUnit: "cloudflared.service"
    },
    sources: { icons: {} }
  };
  atomicWriteFile(installation, `${JSON.stringify(settings)}\n`, 0o600);
  current.descriptor.sources.env = { path: env, serverPath: env, kind: "env", apply: "rac-restart" };
  current.descriptor.sources.installation = { path: installation, serverPath: installation, kind: "installation", apply: "rac-restart" };
  current.descriptor.native.environmentFile = env;
  const id = "native_cloud_pair_validate1";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "installation"), `${JSON.stringify({
    ...settings,
    native: { ...settings.native, cloudflaredCredentials: relocatedCredentials }
  })}\n`, 0o600);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id,
    kind: "validate",
    generation: 1,
    sources: [{
      id: "installation",
      existed: true,
      contentHash: sha256(readFileSync(installation)),
      candidate: "installation",
      migration: { mode: "copy" }
    }]
  }), { code: "cloudflared-credential-selector-mismatch" });
  assert.equal(existsSync(relocatedCredentials), false);
  assert.equal(JSON.parse(readFileSync(installation, "utf8")).native.cloudflaredCredentials, cloud.credentials);
});

// app-only bind changes need a new process even when the image and Compose hash match
test("RAC settings apply forces replacement for unchanged Compose service inputs", async () => {
  const current = fixture();
  const descriptor = { ...current.descriptor, kind: "compose", compose: { projectDirectory: current.root, projectName: "test", files: [resolve(current.root, "compose.yaml")], envFiles: [], profiles: [] } };
  const calls = [];
  await applyTargets(descriptor, ["rac"], { runner: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: Buffer.from(args.includes("ps") ? "a".repeat(64) : ""), stderr: Buffer.alloc(0) }; } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "docker");
  assert.equal(calls[0].args.includes("--force-recreate"), true);
  assert.equal(calls[0].args.at(-1), "remote-agent-console");
});

test("native RAC apply pins the selected checkout and fixed entrypoint", async () => {
  const current = fixture();
  const unitRoot = resolve(current.root, "systemd-user");
  const node = resolve(current.root, "bin/node");
  await applyTargets(current.descriptor, ["rac"], {
    nativeUnitDirectory: unitRoot,
    handoverNode: node,
    runner: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  });
  const dropIn = readFileSync(resolve(unitRoot, "remote-agent-console.service.d/20-rac-settings-environment.conf"), "utf8");
  assert.match(dropIn, new RegExp(`WorkingDirectory="${current.root}"`, "u"));
  assert.match(dropIn, new RegExp(`ExecStart="${node}" "${resolve(current.root, "apps/server/dist/index.js")}" --settings-control "${current.controlRoot}"`, "u"));
});

test("native Cloudflare apply retargets only the proven config selectors", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const desired = nativeCloudDesired(current, cloud);
  const unitRoot = resolve(current.root, "systemd-user");
  const calls = [];
  await applyTargets(desired.descriptor, ["cloudflared"], {
    activeDescriptor: current.descriptor,
    nativeCloudflaredCommand: cloud.command,
    nativeCloudflaredCommandDescriptor: current.descriptor,
    nativeUnitDirectory: unitRoot,
    runner: async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
  });
  const dropIn = readFileSync(resolve(unitRoot, "cloudflared.service.d/20-rac-settings-cloudflared.conf"), "utf8");
  assert.match(dropIn, new RegExp(`--config" "${desired.config}"`, "u"));
  assert.match(dropIn, new RegExp(`--credentials-file" "${desired.credentials}"`, "u"));
  assert.equal(dropIn.includes(cloud.config), false);
  assert.equal(calls.findIndex((args) => args.includes("daemon-reload")) < calls.findIndex((args) => args.includes("restart")), true);
});

test("native Cloudflare apply preserves a marked but edited fixed drop-in", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const desired = nativeCloudDesired(current, cloud);
  const unitRoot = resolve(current.root, "systemd-user");
  const dropIn = resolve(unitRoot, "cloudflared.service.d/20-rac-settings-cloudflared.conf");
  mkdirSync(resolve(dropIn, ".."), { recursive: true, mode: 0o700 });
  const edited = "[Service]\n# rac-settings-cloudflared:managed\nExecStart=\nExecStart=\"/operator/edited\"\n";
  atomicWriteFile(dropIn, edited, 0o600);
  let calls = 0;
  await assert.rejects(() => applyTargets(desired.descriptor, ["cloudflared"], {
    activeDescriptor: current.descriptor,
    nativeCloudflaredCommand: cloud.command,
    nativeCloudflaredCommandDescriptor: current.descriptor,
    nativeUnitDirectory: unitRoot,
    // record any forbidden service mutation
    runner: async () => {
      calls += 1;
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
  }), { code: "cloudflared-drop-in-conflict" });
  assert.equal(readFileSync(dropIn, "utf8"), edited);
  assert.equal(calls, 0);
});

test("native Cloudflare recovery accepts the desired render before a zero-PID rollback", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const desired = nativeCloudDesired(current, cloud);
  atomicWriteFile(resolve(current.controlRoot, "desired-installation.json"), `${JSON.stringify(desired.authority)}\n`, 0o600);
  const unitRoot = resolve(current.root, "systemd-user");
  const renderedCommands = [];
  const runner = async (_command, args) => {
    // record each applied managed command
    if (args.includes("restart")) {
      renderedCommands.push(readFileSync(resolve(unitRoot, "cloudflared.service.d/20-rac-settings-cloudflared.conf"), "utf8"));
    }
    // emulate a restarted unit whose main process already failed
    if (args.includes("show")) {
      return { code: 0, stdout: Buffer.from("MainPID=0\nActiveState=failed\nSubState=failed\nExecMainStartTimestamp=n/a\n"), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "native_cloud_zero_pid01",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["cloudflared"]
  }, {
    runner,
    nativeUnitDirectory: unitRoot,
    recoveryTargetProve: async () => ({
      hashes: {
        cloudflared: sha256(cloud.configBytes),
        "cloudflared-credentials": sha256(cloud.credentialBytes)
      },
      targetProofs: { cloudflared: { unit: "cloudflared.service", pid: 61 } }
    })
  }), { code: "cloudflared-proof-failed" });
  assert.equal(renderedCommands.length, 2);
  assert.equal(renderedCommands[0].includes(desired.config), true);
  assert.equal(renderedCommands[1].includes(cloud.config), true);
  assert.equal(renderedCommands[1].includes(desired.config), false);
});

test("shadowed Compose env edits commit without a restart target", async () => {
  const current = fixture();
  const env = resolve(current.root, ".env");
  const compose = resolve(current.root, "compose.yaml");
  const currentEnv = `${TEST_AUTH_ENV}RAC_CONFIG=/workspace/old.json\nRAC_CONFIG_WRITE_PATH=/workspace/old.json\n`;
  const candidateEnv = `${TEST_AUTH_ENV}RAC_CONFIG=/workspace/new.json\nRAC_CONFIG_WRITE_PATH=/workspace/new.json\n`;
  atomicWriteFile(env, currentEnv, 0o600);
  atomicWriteFile(compose, "services: {}\n", 0o600);
  current.descriptor.kind = "compose";
  current.descriptor.serverCheckout = "/workspace";
  delete current.descriptor.native;
  current.descriptor.sources.env = { path: env, kind: "env", apply: "rac-restart" };
  current.descriptor.sources.compose = { path: compose, kind: "compose", apply: "rac-restart" };
  current.descriptor.compose = {
    projectDirectory: current.root,
    projectName: "shadowed-env-test",
    files: [compose],
    envFiles: [env],
    profiles: [],
    options: {}
  };
  const operationId = "shadowed_env_commit_0001";
  const stage = resolve(current.controlRoot, "staging", operationId);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "env"), candidateEnv, 0o600);
  const model = {
    services: {
      "remote-agent-console": {
        healthcheck: { test: ["CMD", "true"] },
        environment: {
          RAC_CONFIG: "/workspace/fixed.json",
          RAC_CONFIG_WRITE_PATH: "/workspace/fixed.json",
          RAC_SERVER_CHECKOUT: "/workspace",
          RAC_PASSWORD_HASH: "$argon2id$fixture",
          RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        volumes: [
          { source: current.root, target: "/workspace", read_only: false },
          { source: current.controlRoot, target: "/run/rac-settings-control", read_only: false }
        ]
      }
    }
  };
  // emulate normalized Compose without reading a live engine model
  const runner = async (_command, args) => ({
    code: 0,
    stdout: args.includes("--format") ? Buffer.from(JSON.stringify(model)) : Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  });
  const committed = await processOperation(current.descriptor, {
    version: 1,
    id: operationId,
    kind: "commit",
    generation: 1,
    sources: [{ id: "env", contentHash: sha256(Buffer.from(currentEnv)), candidate: "env" }]
  }, { runner });
  assert.deepEqual(committed.receipt.targets, []);
  assert.equal(committed.receipt.shadowedEnvironmentKeys.includes("RAC_CONFIG"), true);
  assert.match(committed.receipt.environmentFileHashes.RAC_CONFIG, /^[0-9a-f]{64}$/u);
  assert.equal(readFileSync(env, "utf8"), candidateEnv);
});

test("commit validates, journals and saves without applying", async () => {
  const current = fixture();
  const id = "commit_operation_00000001";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "app"), '{"name":"after"}\n', 0o600);
  enqueueRequest(current.controlRoot, {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", contentHash: sha256(readFileSync(current.app)), candidate: "app" }]
  });
  let deployments = 0;
  await drainQueue(current.descriptor, {
    emptyDelayMs: 0,
    runner: async () => {
      deployments += 1;
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
  });
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"after"}\n');
  assert.equal(deployments, 0);
  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  assert.equal(status.state, "complete");
  assert.equal(status.phase, "committed");
  assert.deepEqual(JSON.parse(readFileSync(resolve(current.controlRoot, "pending.json"), "utf8")).targets, ["rac"]);
});

test("stale commit fails without overwriting source", async () => {
  const current = fixture();
  const id = "commit_operation_00000002";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "app"), '{"name":"after"}\n', 0o600);
  enqueueRequest(current.controlRoot, {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", contentHash: "0".repeat(64), candidate: "app" }]
  });
  await drainQueue(current.descriptor, { emptyDelayMs: 0 });
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"before"}\n');
  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  assert.equal(status.state, "failed");
  assert.equal(status.error, "source-conflict");
});

test("host read persists ciphertext only and matches the wire contract", async () => {
  const current = fixture();
  const id = "reveal_operation_000001";
  const recipient = generateKeyPairSync("x25519");
  const expiry = Date.now() + 30_000;
  const publicKey = recipient.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const nonce = Buffer.alloc(32, 7).toString("base64url");
  const context = { bootNonce: "synthetic_boot_nonce_00001", sessionBinding: "s".repeat(43), revisionId: "r".repeat(43), contentHash: sha256(readFileSync(current.app)), existed: true };
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), JSON.stringify({ version: 1, generation: 1, bootNonce: context.bootNonce }), 0o600);
  const binding = frameFields([current.descriptor.installationId, 1, context.bootNonce, context.sessionBinding, id, "app", context.revisionId, context.contentHash, context.existed, nonce, expiry, publicKey]).toString("base64url");
  enqueueRequest(current.controlRoot, {
    version: 1,
    id,
    kind: "read",
    generation: 1,
    reveal: {
      ...context,
      sourceId: "app",
      publicKey,
      nonce,
      binding,
      expiresAt: expiry
    }
  });
  await drainQueue(current.descriptor, { emptyDelayMs: 0 });
  const raw = readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8");
  assert.equal(raw.includes("before"), false);
  const envelope = JSON.parse(raw).response;
  assert.deepEqual(Object.keys(envelope).sort(), ["binding", "ciphertext", "expiresAt", "iv", "publicKey", "salt", "tag", "version"]);
  const sender = (await import("node:crypto")).createPublicKey({ key: Buffer.from(envelope.publicKey, "base64url"), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: recipient.privateKey, publicKey: sender });
  const aad = Buffer.from(binding, "utf8");
  const info = Buffer.concat([Buffer.from("rac-settings-reveal/v1"), createHash("sha256").update(aad).digest()]);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64url"), info, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
  assert.equal(plaintext.toString("utf8"), '{"name":"before"}\n');
});

// reject substituted disclosure context before any response can disclose plaintext
test("disclosure rejects stale boot, altered binding, expired lease and source drift", async () => {
  const current = fixture();
  const recipient = generateKeyPairSync("x25519");
  const publicKey = recipient.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const bootNonce = "synthetic_boot_nonce_00001";
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), JSON.stringify({ version: 1, generation: 1, bootNonce }), 0o600);
  const variants = ["boot", "binding", "expiry", "hash"];
  // validate each isolated context substitution
  for (const variant of variants) {
    const id = `disclosure_context_${variant}_000001`;
    const reveal = { sourceId: "app", bootNonce: variant === "boot" ? "substituted_boot_nonce_001" : bootNonce, sessionBinding: "s".repeat(43), revisionId: "r".repeat(43), contentHash: variant === "hash" ? "0".repeat(64) : sha256(readFileSync(current.app)), existed: true, nonce: "n".repeat(43), expiresAt: Date.now() + (variant === "expiry" ? -1000 : 30000), publicKey };
    const binding = frameFields([current.descriptor.installationId, 1, reveal.bootNonce, reveal.sessionBinding, id, reveal.sourceId, reveal.revisionId, reveal.contentHash, reveal.existed, reveal.nonce, reveal.expiresAt, publicKey]).toString("base64url");
    enqueueRequest(current.controlRoot, { version: 1, id, kind: "reveal", generation: 1, reveal: { ...reveal, binding: variant === "binding" ? `${binding.slice(0, -1)}!` : binding } });
    await drainQueue(current.descriptor, { emptyDelayMs: 0 });
    const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
    assert.equal(status.state, "failed");
    assert.equal(status.response, undefined);
    assert.equal(JSON.stringify(status).includes("before"), false);
  }
});

test("installation selectors reject competing values", () => {
  assert.doesNotThrow(() => validateInstallationSettings(Buffer.from(JSON.stringify({
    version: 1,
    host: { checkout: "/srv/rac" },
    sources: { wrapper: "/srv/rac/config/host-tmux", icons: { heart: "/srv/rac/heart.svg" } }
  }))));
  assert.throws(() => validateInstallationSettings(Buffer.from('{"version":1,"password":"secret"}')), /invalid-installation-settings/);
});

test("installation Compose parallel accepts unlimited and rejects invalid limits", () => {
  const installation = (parallel) => Buffer.from(JSON.stringify({
    version: 1,
    compose: { projectDirectory: "/srv/rac", projectName: "rac", files: ["/srv/rac/compose.yaml"], envFiles: ["/srv/rac/.env"], profiles: [], options: { parallel, compatibility: false } }
  }));
  assert.doesNotThrow(() => validateInstallationSettings(installation(-1)));
  // reject every unsupported numeric shape
  for (const parallel of [0, -2, 1.5, 65]) {
    assert.throws(() => validateInstallationSettings(installation(parallel)), /invalid-installation-settings/);
  }
  assert.deepEqual(composePrefix({ projectDirectory: "/srv/rac", projectName: "rac", files: ["/srv/rac/compose.yaml"], envFiles: [], profiles: [], options: { parallel: -1, compatibility: false } }).slice(0, 3), ["compose", "--parallel", "-1"]);
});

test("installed Compose descriptors accept only supported parallel limits", () => {
  const current = fixture();
  const path = resolve(current.controlRoot, "installation.json");
  const descriptor = JSON.parse(readFileSync(path, "utf8"));
  descriptor.kind = "compose";
  delete descriptor.native;
  descriptor.compose = { projectDirectory: current.root, projectName: "rac", files: [current.app], envFiles: [], profiles: [], options: { parallel: -1, compatibility: false } };
  assert.equal(validateDescriptor(descriptor, path).compose.options.parallel, -1);
  // reject every unsupported numeric shape
  for (const parallel of [0, -2, 1.5, 65]) {
    descriptor.compose.options.parallel = parallel;
    assert.throws(() => validateDescriptor(descriptor, path), /invalid-descriptor/);
  }
});

test("svg validator permits static artwork and rejects active content", () => {
  assert.doesNotThrow(() => validateSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>')));
  assert.throws(() => validateSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /invalid-svg/);
  assert.throws(() => validateSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com">x</a></svg>')), /invalid-svg/);
});

test("installer preserves override bytes while adding one fixed control binding", () => {
  const source = "services:\n  remote-agent-console:\n    environment:\n      EXISTING: yes\n    volumes:\n      - ./config:/config:ro\n";
  const first = addManagedControlMount(source, "/home/test/control");
  const second = addManagedControlMount(first, "/home/test/control");
  assert.equal(first, second);
  assert.match(first, /EXISTING: yes/);
  assert.match(first, /target: \/run\/rac-settings-control/);
  assert.match(first, /RAC_HOST_SETTINGS_CONTROL_ROOT/);
});

test("compose validation projects staged service env before the quiet pass", async () => {
  const current = fixture();
  const env = resolve(current.root, ".env");
  const compose = resolve(current.root, "compose.yaml");
  const override = resolve(current.root, "compose.override.yaml");
  const control = current.controlRoot;
  atomicWriteFile(env, "VALUE=old\n", 0o600);
  atomicWriteFile(compose, "services: {}\n", 0o600);
  atomicWriteFile(override, "services: {}\n", 0o600);
  const candidateEnv = resolve(control, "staging/candidate-env");
  mkdirSync(resolve(control, "staging"), { recursive: true, mode: 0o700 });
  atomicWriteFile(candidateEnv, "VALUE=new\n", 0o600);
  const descriptor = {
    ...current.descriptor,
    kind: "compose",
    serverCheckout: "/workspace",
    sources: {
      env: { path: env, kind: "env", apply: "rac-restart" },
      compose: { path: compose, kind: "compose", apply: "rac-restart" },
      "compose-override": { path: override, kind: "compose", apply: "rac-restart" }
    },
    compose: { projectDirectory: current.root, projectName: "test", files: [compose, override], envFiles: [env], profiles: [] }
  };
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    // return the normalized model for both private JSON passes
    if (args.includes("--format")) {
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify({
          services: {
            "remote-agent-console": {
              healthcheck: { test: ["CMD", "true"] },
              environment: {
                RAC_CONFIG: "/workspace/a",
                RAC_CONFIG_WRITE_PATH: "/workspace/a",
                RAC_SERVER_CHECKOUT: "/workspace",
                RAC_PASSWORD_HASH: "$argon2id$fixture",
                RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
              },
              env_file: [env],
              volumes: [
                { source: current.root, target: "/workspace", read_only: false },
                { source: control, target: "/run/rac-settings-control", read_only: false }
              ]
            }
          }
        })),
        stderr: Buffer.alloc(0)
      };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  await validateComposeCandidates(descriptor, new Map([["env", candidateEnv]]), resolve(control, "staging"), runner);
  const projectedPath = calls[2][calls[2].indexOf("-f") + 1];
  const projectedEnv = JSON.parse(readFileSync(projectedPath, "utf8")).services["remote-agent-console"].env_file[0];
  assert.notEqual(projectedEnv, candidateEnv);
  assert.equal(readFileSync(projectedEnv, "utf8"), readFileSync(candidateEnv, "utf8"));
  assert.ok(calls[0].includes("--no-interpolate"));
  assert.ok(calls[1].includes("--no-interpolate"));
  assert.ok(calls[2].includes("--quiet"));
  assert.ok(calls[3].includes("--format"));
});

test("source migration promotes only after replacement proof", async () => {
  const current = fixture();
  const installation = resolve(current.root, "config/remote-agent-console.installation.json");
  const configDirectory = resolve(current.root, "config");
  mkdirSync(configDirectory, { mode: 0o700 });
  const oldEnv = resolve(current.root, "old.env");
  const newEnv = resolve(current.root, "new.env");
  atomicWriteFile(oldEnv, `${TEST_AUTH_ENV}RAC_CONFIG=${current.app}\n`, 0o600);
  atomicWriteFile(installation, `${JSON.stringify({ version: 1, native: { environmentFile: oldEnv } })}\n`, 0o600);
  current.descriptor.sources.env = { path: oldEnv, serverPath: oldEnv, kind: "env", apply: "rac-restart" };
  current.descriptor.sources.installation = { path: installation, serverPath: installation, kind: "installation", apply: "rac-restart" };
  current.descriptor.native.environmentFile = oldEnv;
  const commitId = "migration_commit_0000001";
  const stage = resolve(current.controlRoot, "staging", commitId);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "installation"), `${JSON.stringify({ version: 1, native: { environmentFile: newEnv } })}\n`, 0o600);
  const commit = await processOperation(current.descriptor, {
    version: 1,
    id: commitId,
    kind: "commit",
    generation: 1,
    sources: [{
      id: "installation",
      contentHash: sha256(readFileSync(installation)),
      candidate: "installation",
      migration: { mode: "copy" }
    }]
  });
  assert.equal(commit.receipt.generation, 2);
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, "installation.json"), "utf8")).generation, 1);
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, "desired-installation.json"), "utf8")).generation, 2);
  let restartUnit;
  await processOperation(current.descriptor, {
    version: 1,
    id: "migration_restart_00001",
    kind: "restart",
    generation: 1,
    sources: [{ id: "installation", contentHash: sha256(readFileSync(installation)) }],
    targets: ["rac"]
  }, {
    nativeUnitDirectory: resolve(current.root, "systemd"),
    runner: async (_command, args) => {
      restartUnit = args.at(-1);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async (descriptor) => ({
      bootNonce: "boot-generation-two",
      generation: descriptor.generation,
      hashes: { installation: sha256(readFileSync(installation)) },
      environmentHashes: {}
    })
  });
  assert.equal(restartUnit, "remote-agent-console.service");
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, "installation.json"), "utf8")).generation, 2);
  assert.equal(readFileSync(newEnv, "utf8"), readFileSync(oldEnv, "utf8"));
});

test("native installer creates desired source before publishing descriptor", async () => {
  const repository = mkdtempSync(resolve(tmpdir(), "rac-install-"));
  chmodSync(repository, 0o700);
  mkdirSync(resolve(repository, "config"), { mode: 0o700 });
  mkdirSync(resolve(repository, "config/instance-icons"), { mode: 0o700 });
  mkdirSync(resolve(repository, "systemd"), { mode: 0o700 });
  const app = resolve(repository, "config/app.json");
  const env = resolve(repository, ".env");
  atomicWriteFile(app, '{"name":"test"}\n', 0o600);
  atomicWriteFile(env, `RAC_CONFIG=${app}\n`, 0o600);
  for (const name of ["remote-agent-settings-apply.path.in", "remote-agent-settings-apply.service.in"]) {
    atomicWriteFile(resolve(repository, "systemd", name), readFileSync(resolve(process.cwd(), "systemd", name)), 0o600);
  }
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = resolve(repository, "state");
  process.env.XDG_CONFIG_HOME = resolve(repository, "xdg-config");
  const runner = async (command, args) => ({
    code: 0,
    stdout: Buffer.from(command === "loginctl" ? "yes\n" : ""),
    stderr: Buffer.alloc(0),
    args
  });
  try {
    const installed = await installSettingsApplier({
      repository,
      kind: "systemd",
      environmentFile: env,
      recoveryBinDirectory: resolve(repository, "bin"),
      runner
    });
    assert.equal(JSON.parse(readFileSync(resolve(repository, "config/remote-agent-console.installation.json"), "utf8")).version, 1);
    const installedDescriptorPath = resolve(installed.controlRoot, "installation.json");
    const installedDescriptor = JSON.parse(readFileSync(installedDescriptorPath, "utf8"));
    assert.equal(installedDescriptor.hostControlRoot, installed.controlRoot);
    assert.equal(installedDescriptor.sources["icon-heart"].apply, "live");
    installedDescriptor.sources["icon-heart"].apply = "rac-restart";
    installedDescriptor.sources["icon-potato"].apply = "rac-restart";
    atomicWriteFile(installedDescriptorPath, `${JSON.stringify(installedDescriptor, null, 2)}\n`, 0o600);
    const repaired = await installSettingsApplier({
      repository,
      kind: "systemd",
      installationId: installed.installationId,
      environmentFile: env,
      recoveryBinDirectory: resolve(repository, "bin"),
      runner
    });
    assert.equal(repaired.descriptor.sources["icon-heart"].apply, "live");
    assert.equal(repaired.descriptor.sources["icon-potato"].apply, "live");
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

// build one fresh boot attesting the supported app migration
function migratedAppBoot(port, fromHash, toHash, overrides = {}) {
  return {
    version: 1,
    generation: 1,
    bootNonce: overrides.bootNonce ?? "migrated-app-boot",
    hashes: { app: toHash, ...(overrides.hashes ?? {}) },
    sourceMigrations: {
      app: { kind: "push-to-buttons-v1", fromHash, toHash },
      ...(overrides.sourceMigrations ?? {})
    },
    environmentHashes: {},
    listen: { host: "127.0.0.1", port }
  };
}

test("replacement proof records an attested app migration as effective", async () => {
  const current = fixture();
  const fromHash = sha256(readFileSync(current.app));
  const migrated = Buffer.from('{"name":"before","buttons":[]}\n');
  const toHash = sha256(migrated);
  const server = createServer((_request, response) => response.writeHead(200).end("ok"));
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    const result = await processOperation(current.descriptor, {
      version: 1,
      id: "restart_app_migration01",
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args) => {
        // publish the migrated bytes with the replacement boot
        if (args.includes("restart")) {
          atomicWriteFile(current.app, migrated, 0o600);
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(migratedAppBoot(address.port, fromHash, toHash))}\n`, 0o600);
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    });

    assert.equal(result.phase, "effective");
    assert.equal(result.receipt.hashes.app, toHash);
    const effective = JSON.parse(readFileSync(resolve(current.controlRoot, "effective.json"), "utf8"));
    assert.equal(effective.targets.rac.hashes.app, toHash);
    const envelope = JSON.parse(readFileSync(resolve(current.controlRoot, "recovery/effective-rac.json"), "utf8"));
    const snapshot = openLocal(readFileSync(resolve(current.controlRoot, "recovery.key")), envelope);
    assert.equal(sha256(Buffer.from(snapshot.originals.find((entry) => entry.id === "app").bytes, "base64")), toHash);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("replacement proof rejects malformed or non-app migration attestations", async () => {
  const variants = ["kind", "from", "to", "live", "nonapp", "existence"];
  // exercise every rejected migration dimension independently
  for (const variant of variants) {
    const current = fixture();
    const before = readFileSync(current.app);
    const fromHash = sha256(before);
    const migrated = Buffer.from('{"name":"before","buttons":[]}\n');
    const toHash = sha256(migrated);
    const unrelated = Buffer.from('{"name":"external"}\n');
    let healthChecks = 0;
    const server = createServer((_request, response) => {
      healthChecks += 1;
      response.writeHead(200).end("unexpected");
    });
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    assert.equal(typeof address, "object");
    let restarts = 0;
    try {
      const sources = currentSourceManifest(current.descriptor);
      // reject a migration without an exact preexisting app claim
      if (variant === "existence") delete sources.find((source) => source.id === "app").existed;
      await assert.rejects(() => processOperation(current.descriptor, {
        version: 1,
        id: `invalid_app_migration_${variant}`,
        kind: "restart",
        generation: 1,
        sources,
        targets: ["rac"]
      }, {
        restartWatchdogTimeoutMs: 30,
        nativeUnitDirectory: resolve(current.root, "systemd"),
        expectedEnvironmentHashes: {},
        runner: async (_command, args, commandOptions = {}) => {
          // stage only the invalid replacement boot on the first restart
          if (args.includes("restart") && restarts++ === 0) {
            const live = variant === "live" ? unrelated : (variant === "nonapp" ? before : migrated);
            atomicWriteFile(current.app, live, 0o600);
            const boot = migratedAppBoot(address.port, fromHash, toHash);
            // alter exactly one attestation constraint
            if (variant === "kind") boot.sourceMigrations.app.kind = "unsupported-migration";
            if (variant === "from") boot.sourceMigrations.app.fromHash = "0".repeat(64);
            if (variant === "to") boot.sourceMigrations.app.toHash = "0".repeat(64);
            if (variant === "nonapp") {
              boot.hashes.app = fromHash;
              boot.sourceMigrations = { env: boot.sourceMigrations.app };
            }
            atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(boot)}\n`, 0o600);
            commandOptions.signal?.addEventListener("abort", () => atomicWriteFile(current.app, before, 0o600), { once: true });
          }
          return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
        recoveryProve: async () => ({ bootNonce: "recovered-invalid-proof" })
      }), (error) => ["health-proof-failed", "restart-watchdog-expired"].includes(error.code));
      assert.equal(healthChecks, 0);
      assert.equal(readFileSync(current.app, "utf8"), before.toString("utf8"));
    } finally {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  }
});

test("post-proof app edits are refused and preserved", async () => {
  const current = fixture();
  const fromHash = sha256(readFileSync(current.app));
  const migrated = Buffer.from('{"name":"before","buttons":[]}\n');
  const edited = Buffer.from('{"name":"operator-edit"}\n');
  const toHash = sha256(migrated);
  let healthChecks = 0;
  const server = createServer((_request, response) => {
    healthChecks += 1;
    // race an edit after matching the proof but before it returns
    if (healthChecks === 1) atomicWriteFile(current.app, edited, 0o600);
    response.writeHead(200).end("ok");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    await assert.rejects(() => processOperation(current.descriptor, {
      version: 1,
      id: "post_proof_app_edit001",
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      healthTimeoutMs: 30,
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args) => {
        // publish one valid migrated replacement
        if (args.includes("restart")) {
          atomicWriteFile(current.app, migrated, 0o600);
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(migratedAppBoot(address.port, fromHash, toHash))}\n`, 0o600);
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    }), { code: "manual-recovery-required" });
    assert.equal(healthChecks, 1);
    assert.equal(readFileSync(current.app, "utf8"), edited.toString("utf8"));
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("post-attestation apply failure recovers through baseline remigration", async () => {
  const current = fixture();
  const before = readFileSync(current.app);
  const fromHash = sha256(before);
  const migrated = Buffer.from('{"name":"before","buttons":[]}\n');
  const toHash = sha256(migrated);
  const icon = resolve(current.root, "heart.svg");
  atomicWriteFile(icon, "<svg/>\n", 0o600);
  current.descriptor.sources["icon-heart"] = { path: icon, serverPath: icon, kind: "svg", apply: "live" };
  let firstHealth;
  const firstHealthy = new Promise((resolvePromise) => { firstHealth = resolvePromise; });
  const server = createServer((_request, response) => {
    firstHealth();
    response.writeHead(200).end("ok");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  const clock = restartClock();
  let restarts = 0;
  try {
    await assert.rejects(() => processOperation(current.descriptor, {
      version: 1,
      id: "apply_fail_after_proof01",
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      restartWatchdogClock: clock,
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args) => {
        // emulate desired failure followed by new-binary recovery migration
        if (args.includes("restart")) {
          restarts += 1;
          atomicWriteFile(current.app, migrated, 0o600);
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(migratedAppBoot(address.port, fromHash, toHash, {
            bootNonce: restarts === 1 ? "desired-migrated-boot" : "recovery-migrated-boot"
          }))}\n`, 0o600);
          if (restarts === 1) {
            await firstHealthy;
            assert.equal(await waitFor(() => !clock.pending()), true);
            return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
          }
          atomicWriteFile(icon, "<svg id=\"operator\"/>\n", 0o600);
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    }), { code: "apply-failed" });
    assert.equal(restarts, 2);
    assert.equal(sha256(readFileSync(current.app)), toHash);
    assert.equal(readFileSync(icon, "utf8"), '<svg id="operator"/>\n');
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("recovery restores a proven graph across separate saves", async () => {
  const current = fixture();
  const env = resolve(current.root, ".env");
  atomicWriteFile(env, `${TEST_AUTH_ENV}VALUE=baseline\n`, 0o600);
  current.descriptor.sources.env = { path: env, serverPath: env, kind: "env", apply: "rac-restart" };
  current.descriptor.native.environmentFile = env;
  const baselineSources = [
    { id: "app", existed: true, contentHash: sha256(readFileSync(current.app)) },
    { id: "env", existed: true, contentHash: sha256(readFileSync(env)) }
  ];
  await processOperation(current.descriptor, {
    version: 1,
    id: "baseline_reconcile_00001",
    kind: "reconcile",
    generation: 1,
    sources: baselineSources,
    targets: ["rac"]
  }, { prove: async () => ({ bootNonce: "baseline-boot" }) });

  // save the first source without replacing the recovery baseline
  const appCommit = "separate_app_commit_0001";
  mkdirSync(resolve(current.controlRoot, "staging", appCommit), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", appCommit, "app"), '{"name":"desired"}\n', 0o600);
  await processOperation(current.descriptor, {
    version: 1,
    id: appCommit,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: baselineSources[0].contentHash, candidate: "app" }]
  });

  // save the second source as a separate transaction
  const envCommit = "separate_env_commit_0001";
  mkdirSync(resolve(current.controlRoot, "staging", envCommit), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", envCommit, "env"), `${TEST_AUTH_ENV}VALUE=desired\n`, 0o600);
  await processOperation(current.descriptor, {
    version: 1,
    id: envCommit,
    kind: "commit",
    generation: 1,
    sources: [{ id: "env", existed: true, contentHash: baselineSources[1].contentHash, candidate: "env" }]
  });

  const applied = [];
  const desiredSources = [
    { id: "app", existed: true, contentHash: sha256(readFileSync(current.app)) },
    { id: "env", existed: true, contentHash: sha256(readFileSync(env)) }
  ];
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "failed_restart_recover_1",
    kind: "restart",
    generation: 1,
    sources: desiredSources,
    targets: ["rac"]
  }, {
    expectedEnvironmentHashes: {},
    nativeUnitDirectory: resolve(current.root, "systemd"),
    runner: async (_command, args) => {
      if (args.includes("restart")) {
        applied.push([readFileSync(current.app, "utf8"), readFileSync(env, "utf8")]);
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async () => { throw Object.assign(new Error("health-proof-failed"), { code: "health-proof-failed" }); },
    recoveryProve: async () => ({ bootNonce: "recovered-boot" })
  }), (error) => error.code === "health-proof-failed");
  assert.deepEqual(applied, [
    ['{"name":"desired"}\n', `${TEST_AUTH_ENV}VALUE=desired\n`],
    ['{"name":"before"}\n', `${TEST_AUTH_ENV}VALUE=baseline\n`]
  ]);
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"desired"}\n');
  assert.equal(readFileSync(env, "utf8"), `${TEST_AUTH_ENV}VALUE=desired\n`);
});

test("restart watchdog aborts a hung RAC apply before recovering every requested target", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const clock = restartClock();
  const restarts = [];
  let applyStarted;
  const started = new Promise((resolvePromise) => { applyStarted = resolvePromise; });
  let desiredSettled = false;
  const restartProgress = [];
  const runner = async (_command, args, commandOptions = {}) => {
    // record only service replacement attempts
    if (!args.includes("restart")) return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    restarts.push(args.at(-1));
    // hold only the desired RAC replacement until the watchdog aborts it
    if (args.at(-1) === "remote-agent-console.service" && restarts.filter((unit) => unit === "remote-agent-console.service").length === 1) {
      applyStarted();
      return await new Promise((_resolvePromise, rejectPromise) => {
        commandOptions.signal?.addEventListener("abort", () => {
          desiredSettled = true;
          rejectPromise(safeError("command-aborted"));
        }, { once: true });
      });
    }
    // leave the native Cloudflare prephase outside the RAC watchdog
    if (restarts.length > 1) assert.equal(desiredSettled, true);
    assert.equal(commandOptions.signal, undefined);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const operation = processOperation(current.descriptor, {
    version: 1,
    id: "restart_watchdog_hung01",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac", "cloudflared"]
  }, {
    runner,
    restartWatchdogClock: clock,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    postApplyProve: async () => ({
      hashes: { cloudflared: sha256(cloud.configBytes), "cloudflared-credentials": sha256(cloud.credentialBytes) },
      targetProofs: { cloudflared: { unit: "cloudflared.service" } }
    }),
    recoveryProve: async () => ({ bootNonce: "recovered-rac" }),
    recoveryTargetProve: async () => ({
      hashes: { cloudflared: sha256(cloud.configBytes), "cloudflared-credentials": sha256(cloud.credentialBytes) },
      targetProofs: { cloudflared: { unit: "cloudflared.service" } }
    }),
    onRestartProgress: (progress) => restartProgress.push(progress)
  });
  await started;
  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);

  await assert.rejects(operation, { code: "restart-watchdog-expired" });
  assert.deepEqual(restarts, ["cloudflared.service", "remote-agent-console.service", "remote-agent-console.service", "cloudflared.service"]);
  assert.deepEqual(restartProgress, [
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "restarting" },
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "recovering" },
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "recovered" }
  ]);
  assert.equal(clock.pending(), false);
});

test("restart preflight failure publishes no recovery progress", async () => {
  const current = fixture();
  const restartProgress = [];
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "restart_preflight_fail01",
    kind: "restart",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: "0".repeat(64) }],
    targets: ["rac"]
  }, {
    onRestartProgress: (progress) => restartProgress.push(progress)
  }), { code: "source-conflict" });
  assert.deepEqual(restartProgress, []);
});

test("restart progress publication fails closed before RAC mutation", async () => {
  const current = fixture();
  let restartCommands = 0;
  let desiredProofs = 0;
  let recoveryProofs = 0;
  const restartProgress = [];
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "restart_publish_failure01",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac"]
  }, {
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    runner: async (_command, args) => {
      if (args.includes("restart")) restartCommands += 1;
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async () => { desiredProofs += 1; return { bootNonce: "unexpected" }; },
    recoveryProve: async () => { recoveryProofs += 1; },
    onRestartProgress: (progress) => {
      restartProgress.push(progress.state);
      throw safeError("status-write-failed");
    }
  }), { code: "status-write-failed" });
  assert.deepEqual(restartProgress, ["restarting"]);
  assert.equal(restartCommands, 0);
  assert.equal(desiredProofs, 0);
  assert.equal(recoveryProofs, 0);
});

test("post-boundary progress failures cannot change restart or recovery outcomes", async () => {
  // exercise success plus both recovery progress publications
  for (const throwState of ["restarted", "recovering", "recovered"]) {
    const current = fixture();
    let restartCommands = 0;
    let recoveryProofs = 0;
    const restartProgress = [];
    const operation = processOperation(current.descriptor, {
      version: 1,
      id: `restart_report_${throwState.replace("-", "_")}01`,
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args) => {
        if (args.includes("restart")) restartCommands += 1;
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      prove: async () => {
        // fail only the cases that must recover
        if (throwState !== "restarted") throw safeError("health-proof-failed");
        return { bootNonce: "fresh-boot" };
      },
      recoveryProve: async () => { recoveryProofs += 1; },
      onRestartProgress: (progress) => {
        restartProgress.push(progress.state);
        if (progress.state === throwState) throw safeError("status-write-failed");
      }
    });
    if (throwState === "restarted") {
      assert.equal((await operation).phase, "effective");
      assert.equal(restartCommands, 1);
      assert.equal(recoveryProofs, 0);
      assert.deepEqual(restartProgress, ["restarting", "restarted"]);
    } else {
      await assert.rejects(operation, { code: "health-proof-failed" });
      assert.equal(restartCommands, 2);
      assert.equal(recoveryProofs, 1);
      assert.deepEqual(restartProgress, ["restarting", "recovering", "recovered"]);
    }
    assert.equal(restartProgress.includes("recovery-failed"), false);
  }
});

test("native Cloudflare applies before the RAC watchdog arms", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const clock = restartClock();
  let racProved = false;
  let recoveryProofs = 0;
  let racRestarted;
  const racRestart = new Promise((resolvePromise) => { racRestarted = resolvePromise; });
  const result = await processOperation(current.descriptor, {
    version: 1,
    id: "restart_watchdog_both01",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac", "cloudflared"]
  }, {
    restartWatchdogClock: clock,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    runner: async (_command, args, commandOptions = {}) => {
      // preserve native Cloudflare-first ordering outside the RAC deadline
      if (args.includes("restart") && args.at(-1) === "cloudflared.service") {
        assert.equal(racProved, false);
        assert.equal(commandOptions.signal, undefined);
        assert.equal(clock.pending(), false);
      }
      if (args.includes("restart") && args.at(-1) === "remote-agent-console.service" && commandOptions.signal) {
        assert.equal(commandOptions.signal?.aborted, false);
        assert.equal(clock.pending(), true);
        racRestarted();
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async () => {
      await racRestart;
      racProved = true;
      return { bootNonce: "fresh-rac" };
    },
    postApplyProve: async () => ({
      hashes: { cloudflared: sha256(cloud.configBytes), "cloudflared-credentials": sha256(cloud.credentialBytes) },
      targetProofs: { cloudflared: { unit: "cloudflared.service" } }
    }),
    recoveryProve: async () => { recoveryProofs += 1; },
    recoveryTargetProve: async () => { recoveryProofs += 1; }
  });

  assert.equal(result.phase, "effective");
  assert.equal(racProved, true);
  assert.equal(recoveryProofs, 0);
});

test("compose fresh RAC proof clears the watchdog before Cloudflare replacement", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const clock = restartClock();
  const compose = resolve(current.root, "compose.yaml");
  atomicWriteFile(compose, "services: {}\n", 0o600);
  current.descriptor.kind = "compose";
  current.descriptor.serverCheckout = "/workspace";
  delete current.descriptor.native;
  current.descriptor.sources.compose = { path: compose, serverPath: compose, kind: "compose", apply: "rac-restart" };
  current.descriptor.compose = {
    projectDirectory: current.root,
    projectName: "watchdog-test",
    files: [compose],
    envFiles: [],
    profiles: ["tunnel"],
    options: {}
  };
  const model = {
    services: {
      "remote-agent-console": {
        healthcheck: { test: ["CMD", "true"] },
        environment: {
          RAC_CONFIG: "/workspace/app.json",
          RAC_CONFIG_WRITE_PATH: "/workspace/app.json",
          RAC_SERVER_CHECKOUT: "/workspace",
          RAC_PASSWORD_HASH: "$argon2id$fixture",
          RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        volumes: [
          { source: current.root, target: "/workspace", read_only: false },
          { source: current.controlRoot, target: "/run/rac-settings-control", read_only: false }
        ]
      },
      cloudflared: {
        volumes: [
          { type: "bind", source: cloud.config, target: "/etc/cloudflared/config.yml", read_only: true },
          { type: "bind", source: cloud.credentials, target: "/etc/cloudflared/credentials.json", read_only: true }
        ]
      }
    }
  };
  const racContainer = "a".repeat(64);
  const cloudBefore = "b".repeat(64);
  const cloudAfter = "c".repeat(64);
  let cloudQueries = 0;
  let racProved = false;
  let racHealthProofs = 0;
  const sources = currentSourceManifest(current.descriptor);
  const hashes = Object.fromEntries(sources.map((source) => [source.id, source.contentHash]));
  const result = await processOperation(current.descriptor, {
    version: 1,
    id: "restart_watchdog_compose1",
    kind: "restart",
    generation: 1,
    sources,
    targets: ["rac", "cloudflared"]
  }, {
    restartWatchdogClock: clock,
    expectedEnvironmentHashes: {},
    runner: async (_command, args, commandOptions = {}) => {
      // provide the normalized graph for validation and environment proof
      if (args.includes("config") && args.includes("--format")) return { code: 0, stdout: Buffer.from(JSON.stringify(model)), stderr: Buffer.alloc(0) };
      if (args.includes("ps") && args.at(-1) === "remote-agent-console") {
        return { code: 0, stdout: Buffer.from(racContainer), stderr: Buffer.alloc(0) };
      }
      if (args.includes("ps") && args.at(-1) === "cloudflared") {
        cloudQueries += 1;
        return { code: 0, stdout: Buffer.from(cloudQueries === 1 ? cloudBefore : cloudAfter), stderr: Buffer.alloc(0) };
      }
      // publish the fresh boot from the replacement Compose service
      if (args.includes("up") && args.at(-1) === "remote-agent-console") {
        atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({
          version: 1,
          generation: 1,
          bootNonce: "fresh-compose-rac",
          hashes: { app: hashes.app },
          environmentHashes: {},
          listen: { host: "127.0.0.1", port: 8787 }
        })}\n`, 0o600);
      }
      // prove the exact running Compose service before entering its namespace
      if (args[0] === "inspect") {
        return { code: 0, stdout: Buffer.from(`true\nhealthy\nwatchdog-test\nremote-agent-console\n[]\n`), stderr: Buffer.alloc(0) };
      }
      // resolve health only through the selected container loopback
      if (args[0] === "exec") {
        assert.equal(args[1], racContainer);
        assert.equal(args[2], "/usr/local/bin/node");
        assert.equal(args.includes("http://127.0.0.1:8787/healthz"), true);
        racHealthProofs += 1;
        racProved = true;
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      // prove later Cloudflare work is outside the cleared RAC deadline
      if (args.includes("up") && args.at(-1) === "cloudflared") {
        assert.equal(racProved, true);
        assert.equal(commandOptions.signal, undefined);
        assert.equal(clock.pending(), false);
        clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    postApplyProve: async () => ({
      hashes,
      targetProofs: { cloudflared: { containerId: cloudAfter } }
    })
  });

  assert.equal(result.phase, "effective");
  assert.equal(racProved, true);
  assert.equal(racHealthProofs >= 2, true);
  assert.equal(clock.pending(), false);
});

test("RAC watchdog starts at replacement and allows the full fresh-proof deadline", async () => {
  const current = fixture();
  const clock = restartClock();
  let releaseReload;
  let reloadStarted;
  let reloads = 0;
  let restarts = 0;
  let settled = false;
  const reloading = new Promise((resolvePromise) => { reloadStarted = resolvePromise; });
  const operation = processOperation(current.descriptor, {
    version: 1,
    id: "restart_watchdog_stale1",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac"]
  }, {
    restartWatchdogClock: clock,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    runner: async (_command, args) => {
      // hold preparation before the exact replacement boundary
      if (args.includes("daemon-reload")) {
        reloads += 1;
        if (reloads === 1) {
          reloadStarted();
          return await new Promise((resolvePromise) => {
            releaseReload = () => resolvePromise({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
          });
        }
      }
      if (args.includes("restart")) restarts += 1;
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    recoveryProve: async () => ({ bootNonce: "recovered-rac" })
  });
  operation.finally(() => { settled = true; }).catch(() => {});
  await reloading;

  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(restarts, 0);
  assert.equal(clock.pending(), false);
  releaseReload();
  // let the fast replacement enter stale boot polling
  while (restarts === 0) await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS / 2);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(restarts, 1);

  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS / 2);
  await assert.rejects(operation, { code: "restart-watchdog-expired" });
  assert.equal(restarts, 2);
  assert.equal(clock.pending(), false);
});

test("fresh RAC proof disarms recovery while the restart command is still running", async () => {
  const current = fixture();
  const clock = restartClock();
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  const oldBoot = {
    version: 1,
    generation: 1,
    bootNonce: "old-boot",
    hashes: { app: sha256(readFileSync(current.app)) },
    environmentHashes: {},
    listen: { host: "127.0.0.1", port: address.port }
  };
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(oldBoot)}\n`, 0o600);
  let release;
  let releaseReload;
  let reloadStarted;
  let restartStarted;
  let restartSignal;
  let restartDeadline;
  let restarts = 0;
  let recoveryProofs = 0;
  const reloading = new Promise((resolvePromise) => { reloadStarted = resolvePromise; });
  const started = new Promise((resolvePromise) => { restartStarted = resolvePromise; });
  try {
    const operation = processOperation(current.descriptor, {
      version: 1,
      id: "restart_watchdog_proved1",
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      restartWatchdogClock: clock,
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args, commandOptions = {}) => {
        // hold native preparation after an unrelated fresh boot appears
        if (args.includes("daemon-reload")) {
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({ ...oldBoot, bootNonce: "external-boot" })}\n`, 0o600);
          reloadStarted();
          return await new Promise((resolvePromise) => {
            releaseReload = () => resolvePromise({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
          });
        }
        if (!args.includes("restart")) return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        restarts += 1;
        // publish an exact fresh boot while the service manager call is stuck
        if (restarts === 1) {
          restartSignal = commandOptions.signal;
          restartDeadline = commandOptions.deadline;
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({ ...oldBoot, bootNonce: "fresh-boot" })}\n`, 0o600);
          restartStarted();
          return await new Promise((resolvePromise, rejectPromise) => {
            release = () => resolvePromise({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
            commandOptions.signal.addEventListener("abort", () => rejectPromise(safeError("command-aborted")), { once: true });
          });
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      recoveryProve: async () => { recoveryProofs += 1; }
    });
    await reloading;
    clock.advance(500);
    // reject proof from before the exact restart boundary
    for (let attempts = 0; attempts < 10; attempts += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
    assert.equal(clock.pending(), false);
    releaseReload();
    await started;
    // let the fresh local health proof disarm the deadline
    assert.equal(await waitFor(() => !clock.pending()), true);

    clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);
    assert.equal(restartSignal.aborted, false);
    assert.equal(restartDeadline, undefined);
    release();
    const result = await operation;
    assert.equal(result.phase, "effective");
    assert.equal(result.receipt.bootNonce, "fresh-boot");
    assert.equal(restarts, 1);
    assert.equal(recoveryProofs, 0);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("RAC health is rechecked after a concurrently proved restart command settles", async () => {
  const current = fixture();
  const clock = restartClock();
  let healthy = true;
  const server = createServer((_request, response) => {
    response.writeHead(healthy ? 200 : 503).end();
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  const oldBoot = {
    version: 1,
    generation: 1,
    bootNonce: "old-boot",
    hashes: { app: sha256(readFileSync(current.app)) },
    environmentHashes: {},
    listen: { host: "127.0.0.1", port: address.port }
  };
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify(oldBoot)}\n`, 0o600);
  let release;
  let restartStarted;
  let restarts = 0;
  let recoveryProofs = 0;
  const started = new Promise((resolvePromise) => { restartStarted = resolvePromise; });
  try {
    const operation = processOperation(current.descriptor, {
      version: 1,
      id: "restart_watchdog_recheck1",
      kind: "restart",
      generation: 1,
      sources: currentSourceManifest(current.descriptor),
      targets: ["rac"]
    }, {
      restartWatchdogClock: clock,
      healthTimeoutMs: 20,
      nativeUnitDirectory: resolve(current.root, "systemd"),
      expectedEnvironmentHashes: {},
      runner: async (_command, args) => {
        if (!args.includes("restart")) return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        restarts += 1;
        // hold the desired command after publishing its fresh boot
        if (restarts === 1) {
          atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({ ...oldBoot, bootNonce: "fresh-boot" })}\n`, 0o600);
          restartStarted();
          return await new Promise((resolvePromise) => {
            release = () => resolvePromise({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
          });
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      recoveryProve: async () => { recoveryProofs += 1; }
    });
    await started;
    assert.equal(await waitFor(() => !clock.pending()), true);
    healthy = false;
    release();

    await assert.rejects(operation, { code: "health-proof-failed" });
    assert.equal(restarts, 2);
    assert.equal(recoveryProofs, 1);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("restart watchdog surfaces a bounded recovery failure after the hung apply settles", async () => {
  const current = fixture();
  const clock = restartClock();
  let applyStarted;
  const started = new Promise((resolvePromise) => { applyStarted = resolvePromise; });
  let restarts = 0;
  const restartProgress = [];
  const operation = processOperation(current.descriptor, {
    version: 1,
    id: "restart_watchdog_recover1",
    kind: "restart",
    generation: 1,
    sources: currentSourceManifest(current.descriptor),
    targets: ["rac"]
  }, {
    restartWatchdogClock: clock,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    expectedEnvironmentHashes: {},
    runner: async (_command, args, commandOptions = {}) => {
      // fail the recovery replacement only after aborting the desired one
      if (args.includes("restart")) {
        restarts += 1;
        if (restarts === 1) {
          applyStarted();
          return await new Promise((_resolvePromise, rejectPromise) => commandOptions.signal?.addEventListener("abort", () => rejectPromise(safeError("command-aborted")), { once: true }));
        }
        return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    onRestartProgress: (progress) => restartProgress.push(progress)
  });
  await started;
  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);

  await assert.rejects(operation, { code: "apply-failed" });
  assert.equal(restarts, 2);
  assert.deepEqual(restartProgress, [
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "restarting" },
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "recovering" },
    { recoveryDeadline: 20_000 + RESTART_WATCHDOG_TIMEOUT_MS, state: "recovery-failed" }
  ]);
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"before"}\n');
  assert.equal(clock.pending(), false);
});

test("first failed apply recovers from a nonmutating bootstrap baseline", async () => {
  const current = fixture({ baseline: false });
  const beforeHash = sha256(readFileSync(current.app));
  const commitId = "first_baseline_commit001";
  const stage = resolve(current.controlRoot, "staging", commitId);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(stage, "app"), '{"name":"desired"}\n', 0o600);
  let baselineProofs = 0;
  await processOperation(current.descriptor, {
    version: 1,
    id: commitId,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: beforeHash, candidate: "app" }]
  }, {
    baselineProve: async (_descriptor, target) => {
      baselineProofs += 1;
      assert.equal(target, "rac");
      assert.equal(readFileSync(current.app, "utf8"), '{"name":"before"}\n');
      return { bootNonce: "initial-baseline-boot" };
    }
  });
  assert.equal(baselineProofs, 1);
  assert.equal(existsSync(resolve(current.controlRoot, "recovery/effective-rac.json")), true);
  const applied = [];
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "first_baseline_restart01",
    kind: "restart",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: sha256(readFileSync(current.app)) }],
    targets: ["rac"]
  }, {
    expectedEnvironmentHashes: {},
    nativeUnitDirectory: resolve(current.root, "systemd"),
    runner: async (_command, args) => {
      if (args.includes("restart")) applied.push(readFileSync(current.app, "utf8"));
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    prove: async () => { throw Object.assign(new Error("health-proof-failed"), { code: "health-proof-failed" }); },
    recoveryProve: async () => ({ bootNonce: "recovered-initial-boot" })
  }), (error) => error.code === "health-proof-failed");
  assert.deepEqual(applied, ['{"name":"desired"}\n', '{"name":"before"}\n']);
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"desired"}\n');
});

test("an unproven initial baseline blocks commit before source mutation", async () => {
  const current = fixture({ baseline: false });
  const id = "baseline_required_commit1";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(stage, "app"), '{"name":"must-not-save"}\n', 0o600);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: sha256(readFileSync(current.app)), candidate: "app" }]
  }, {
    runner: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  }), { code: "baseline-required" });
  assert.equal(readFileSync(current.app, "utf8"), '{"name":"before"}\n');
  assert.equal(existsSync(resolve(current.controlRoot, "journal", `${id}.json`)), false);
});

test("Cloudflare apply rejects stale consumed bytes and recovers the proven baseline", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const desiredConfig = Buffer.from(`tunnel: ${cloud.tunnelId}\ncredentials-file: ${cloud.credentials}\nprotocol: http2\n`);
  atomicWriteFile(cloud.config, desiredConfig, 0o600);
  const sources = [
    { id: "cloudflared", existed: true, contentHash: sha256(desiredConfig) },
    { id: "cloudflared-credentials", existed: true, contentHash: sha256(cloud.credentialBytes) }
  ];
  const applied = [];
  const runner = async (_command, args) => {
    // capture only actual replacement attempts
    if (args.includes("restart")) {
      applied.push(readFileSync(cloud.config, "utf8"));
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "cloud_consumed_drift_001",
    kind: "restart",
    generation: 1,
    sources,
    targets: ["cloudflared"]
  }, {
    runner,
    nativeUnitDirectory: resolve(current.root, "systemd"),
    postApplyProve: async () => ({
      hashes: {
        cloudflared: sha256(cloud.configBytes),
        "cloudflared-credentials": sha256(cloud.credentialBytes)
      },
      consumedSources: { cloudflared: cloud.configBytes.toString("base64") },
      targetProofs: { cloudflared: { unit: "cloudflared.service", pid: 41 } }
    }),
    recoveryTargetProve: async () => ({
      hashes: {
        cloudflared: sha256(cloud.configBytes),
        "cloudflared-credentials": sha256(cloud.credentialBytes)
      },
      targetProofs: { cloudflared: { unit: "cloudflared.service", pid: 42 } }
    })
  }), { code: "cloudflared-proof-failed" });
  assert.deepEqual(applied, [desiredConfig.toString("utf8"), cloud.configBytes.toString("utf8")]);
  assert.equal(readFileSync(cloud.config, "utf8"), desiredConfig.toString("utf8"));
});

test("Cloudflare receipt and recovery snapshot retain consumed bytes after path drift", async () => {
  const current = fixture();
  const cloud = addNativeCloudBaseline(current);
  const desiredConfig = Buffer.from(`tunnel: ${cloud.tunnelId}\ncredentials-file: ${cloud.credentials}\nprotocol: http2\n`);
  const laterDrift = Buffer.from(`tunnel: ${cloud.tunnelId}\ncredentials-file: ${cloud.credentials}\nprotocol: quic\n`);
  atomicWriteFile(cloud.config, desiredConfig, 0o600);
  const sources = [
    { id: "cloudflared", existed: true, contentHash: sha256(desiredConfig) },
    { id: "cloudflared-credentials", existed: true, contentHash: sha256(cloud.credentialBytes) }
  ];
  const result = await processOperation(current.descriptor, {
    version: 1,
    id: "cloud_consumed_snapshot01",
    kind: "restart",
    generation: 1,
    sources,
    targets: ["cloudflared"]
  }, {
    runner: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    nativeUnitDirectory: resolve(current.root, "systemd"),
    postApplyProve: async () => {
      atomicWriteFile(cloud.config, laterDrift, 0o600);
      return {
        hashes: {
          cloudflared: sha256(desiredConfig),
          "cloudflared-credentials": sha256(cloud.credentialBytes)
        },
        consumedSources: { cloudflared: desiredConfig.toString("base64") },
        targetProofs: { cloudflared: { unit: "cloudflared.service", pid: 51 } }
      };
    }
  });
  assert.equal(result.receipt.hashes.cloudflared, sha256(desiredConfig));
  assert.equal(readFileSync(cloud.config, "utf8"), laterDrift.toString("utf8"));
  const envelope = JSON.parse(readFileSync(resolve(current.controlRoot, "recovery/effective-cloudflared.json"), "utf8"));
  const bundle = openLocal(cloud.key, envelope);
  const stored = bundle.originals.find((entry) => entry.id === "cloudflared");
  assert.equal(Buffer.from(stored.bytes, "base64").toString("utf8"), desiredConfig.toString("utf8"));
});

test("cloudflared reconcile cannot create an unproven baseline", async () => {
  const current = fixture();
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "cloud_reconcile_unproven1",
    kind: "reconcile",
    generation: 1,
    sources: [{ id: "app", existed: true, contentHash: sha256(readFileSync(current.app)) }],
    targets: ["cloudflared"]
  }), (error) => error.code === "cloudflared-reconcile-unproven");
  assert.equal(existsSync(resolve(current.controlRoot, "recovery", "effective-cloudflared.json")), false);
});

test("terminal replay removes an orphaned plaintext stage", async () => {
  const current = fixture();
  const id = "terminal_replay_cleanup01";
  const request = {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "app", contentHash: sha256(readFileSync(current.app)), candidate: "app" }]
  };
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
  const claimed = resolve(current.controlRoot, "claimed", `${id}.json`);
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "app"), '{"name":"secret draft"}\n', 0o600);
  atomicWriteFile(claimed, bytes, 0o600);
  atomicWriteFile(resolve(current.controlRoot, "status", `${id}.json`), `${JSON.stringify({
    version: 1,
    id,
    state: "complete",
    kind: "commit",
    privateRecord: { requestDigest: sha256(bytes) }
  })}\n`, 0o600);
  await processClaim(claimed, current.descriptor);
  assert.equal(existsSync(stage), false);
  assert.equal(existsSync(claimed), false);
});

test("expired disclosure cleanup preserves ordinary receipts", () => {
  const current = fixture();
  const expiredId = "expired_disclosure_0001";
  const receiptId = "active_receipt_status01";
  atomicWriteFile(resolve(current.controlRoot, "status", `${expiredId}.json`), `${JSON.stringify({
    version: 1,
    id: expiredId,
    state: "complete",
    kind: "reveal",
    response: { expiresAt: 10, ciphertext: "opaque" }
  })}\n`, 0o600);
  atomicWriteFile(resolve(current.controlRoot, "status", `${receiptId}.json`), `${JSON.stringify({
    version: 1,
    id: receiptId,
    state: "complete",
    kind: "restart",
    privateRecord: { completedAt: "now" }
  })}\n`, 0o600);
  removeExpiredDisclosureStatuses(current.descriptor, 11);
  assert.equal(existsSync(resolve(current.controlRoot, "status", `${expiredId}.json`)), false);
  assert.equal(existsSync(resolve(current.controlRoot, "status", `${receiptId}.json`)), true);
});

test("existence checks reject optional create and delete races", async () => {
  const current = fixture();
  const optional = resolve(current.root, "optional.json");
  current.descriptor.sources["icon-heart"] = { path: optional, serverPath: optional, kind: "svg", optional: true, apply: "rac-restart" };
  const stage = resolve(current.controlRoot, "staging", "optional_race_commit01");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(stage, "icon"), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', 0o600);
  atomicWriteFile(optional, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>', 0o600);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "optional_race_commit01",
    kind: "commit",
    generation: 1,
    sources: [{ id: "icon-heart", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "icon" }]
  }), (error) => error.code === "source-conflict");
  const previousHash = sha256(readFileSync(optional));
  unlinkSync(optional);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: "optional_delete_race1",
    kind: "commit",
    generation: 1,
    sources: [{ id: "icon-heart", existed: true, contentHash: previousHash, remove: true }]
  }), (error) => error.code === "source-conflict");
  atomicWriteFile(optional, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>', 0o600);
  await processOperation(current.descriptor, {
    version: 1,
    id: "optional_delete_success1",
    kind: "commit",
    generation: 1,
    sources: [{ id: "icon-heart", existed: true, contentHash: sha256(readFileSync(optional)), remove: true }]
  });
  assert.equal(existsSync(optional), false);
});

test("missing wrappers validate without execution and commit owner-only executable bytes", async () => {
  const current = fixture();
  const wrapper = resolve(current.root, "host-tmux");
  const sentinel = resolve(current.root, "must-not-run");
  const content = `#!/usr/bin/env bash\nprintf authored > ${sentinel}\n`;
  current.descriptor.sources.wrapper = { path: wrapper, serverPath: wrapper, kind: "wrapper", optional: true, apply: "rac-restart" };
  // build one absent-source request for each operation
  const request = (id, kind) => ({
    version: 1,
    id,
    kind,
    generation: 1,
    sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
  });
  // stage the same exact authored bytes for validation and commit
  for (const id of ["missing_wrapper_validate1", "missing_wrapper_commit01"]) {
    const stage = resolve(current.controlRoot, "staging", id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    atomicWriteFile(resolve(stage, "wrapper"), content, 0o600);
  }
  await processOperation(current.descriptor, request("missing_wrapper_validate1", "validate"));
  assert.equal(existsSync(wrapper), false);
  assert.equal(existsSync(sentinel), false);
  const committed = await processOperation(current.descriptor, request("missing_wrapper_commit01", "commit"));
  assert.equal(readFileSync(wrapper, "utf8"), content);
  assert.equal(lstatSync(wrapper).mode & 0o777, 0o700);
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(committed.receipt.targets, ["rac"]);
  assert.deepEqual(JSON.parse(readFileSync(resolve(current.controlRoot, "pending.json"), "utf8")).targets, ["rac"]);
});

test("wrapper replacement preserves mode while invalid and raced creates stay untouched", async () => {
  const current = fixture();
  const wrapper = resolve(current.root, "host-tmux");
  current.descriptor.sources.wrapper = { path: wrapper, serverPath: wrapper, kind: "wrapper", optional: true, apply: "rac-restart" };
  const before = "#!/usr/bin/env bash\necho before\n";
  const after = "#!/usr/bin/env bash\necho after\n";
  atomicWriteFile(wrapper, before, 0o600);
  const replaceId = "existing_wrapper_commit1";
  mkdirSync(resolve(current.controlRoot, "staging", replaceId), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", replaceId, "wrapper"), after, 0o600);
  await processOperation(current.descriptor, {
    version: 1,
    id: replaceId,
    kind: "commit",
    generation: 1,
    sources: [{ id: "wrapper", existed: true, contentHash: sha256(Buffer.from(before)), candidate: "wrapper" }]
  });
  assert.equal(readFileSync(wrapper, "utf8"), after);
  assert.equal(lstatSync(wrapper).mode & 0o777, 0o600);

  unlinkSync(wrapper);
  const invalidId = "invalid_wrapper_commit01";
  mkdirSync(resolve(current.controlRoot, "staging", invalidId), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", invalidId, "wrapper"), "#!/usr/bin/env bash\nif then\n", 0o600);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: invalidId,
    kind: "commit",
    generation: 1,
    sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
  }), { code: "invalid-wrapper" });
  assert.equal(existsSync(wrapper), false);

  const raceId = "raced_wrapper_commit001";
  mkdirSync(resolve(current.controlRoot, "staging", raceId), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", raceId, "wrapper"), after, 0o600);
  atomicWriteFile(wrapper, before, 0o700);
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id: raceId,
    kind: "commit",
    generation: 1,
    sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
  }), { code: "source-conflict" });
  assert.equal(readFileSync(wrapper, "utf8"), before);
  assert.equal(lstatSync(wrapper).mode & 0o777, 0o700);
});

// preserve external files created after the absent-wrapper proof
test("new wrapper publication rejects prewrite and final-link races", async () => {
  const candidateBytes = "#!/usr/bin/env bash\necho candidate\n";
  for (const hook of ["beforeSourceWrite", "beforeSourcePublish"]) {
    const current = fixture();
    const wrapper = resolve(current.root, "host-tmux");
    const id = `wrapper_${hook}_race01`;
    current.descriptor.sources.wrapper = { path: wrapper, serverPath: wrapper, kind: "wrapper", optional: true, apply: "rac-restart" };
    mkdirSync(resolve(current.controlRoot, "staging", id), { recursive: true, mode: 0o700 });
    atomicWriteFile(resolve(current.controlRoot, "staging", id, "wrapper"), candidateBytes, 0o600);
    await assert.rejects(() => processOperation(current.descriptor, {
      version: 1,
      id,
      kind: "commit",
      generation: 1,
      sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
    }, {
      [hook]: () => atomicWriteFile(wrapper, candidateBytes, 0o600)
    }), { code: "source-conflict" });
    assert.equal(readFileSync(wrapper, "utf8"), candidateBytes);
    assert.equal(lstatSync(wrapper).mode & 0o777, 0o600);
    const journal = JSON.parse(readFileSync(resolve(current.controlRoot, "journal", `${id}.json`), "utf8"));
    assert.equal(journal.phase, "rolled-back");
    assert.deepEqual(journal.sourcePublications, [{ id: "wrapper" }]);
  }
});

// recover only a journal-proven wrapper inode after process death
test("wrapper crash recovery preserves an identity-mismatched external file", () => {
  const current = fixture();
  const wrapper = resolve(current.root, "host-tmux");
  const staged = resolve(current.root, "owned-wrapper-stage");
  const id = "wrapper_recovery_race01";
  const candidateBytes = Buffer.from("#!/usr/bin/env bash\necho candidate\n");
  current.descriptor.sources.wrapper = { path: wrapper, serverPath: wrapper, kind: "wrapper", optional: true, apply: "rac-restart" };
  mkdirSync(resolve(current.controlRoot, "staging", id), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", id, "wrapper"), candidateBytes, 0o600);
  atomicWriteFile(staged, candidateBytes, 0o700);
  const owned = lstatSync(staged);
  atomicWriteFile(wrapper, candidateBytes, 0o600);
  const request = {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
  };
  const key = readFileSync(resolve(current.controlRoot, "recovery.key"));
  atomicWriteFile(resolve(current.controlRoot, "recovery", `${id}.json`), `${JSON.stringify(sealLocal(key, {
    version: 1,
    originals: [{ id: "wrapper", existed: false, mode: 0o600, bytes: "" }]
  }))}\n`, 0o600);
  atomicWriteFile(resolve(current.controlRoot, "journal", `${id}.json`), `${JSON.stringify({
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    phase: "committing",
    written: ["wrapper"],
    migrations: [],
    sourcePublications: [{ id: "wrapper", identity: { device: String(owned.dev), inode: String(owned.ino) } }]
  })}\n`, 0o600);
  assert.throws(() => recoverClaimedTransaction(current.descriptor, request), { code: "manual-recovery-required" });
  assert.deepEqual(readFileSync(wrapper), candidateBytes);
  assert.equal(lstatSync(wrapper).mode & 0o777, 0o600);
});

// remove the exact wrapper inode published before process death
test("wrapper crash recovery removes its journal-owned inode", () => {
  const current = fixture();
  const wrapper = resolve(current.root, "host-tmux");
  const id = "wrapper_recovery_owned1";
  const candidateBytes = Buffer.from("#!/usr/bin/env bash\necho candidate\n");
  current.descriptor.sources.wrapper = { path: wrapper, serverPath: wrapper, kind: "wrapper", optional: true, apply: "rac-restart" };
  mkdirSync(resolve(current.controlRoot, "staging", id), { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(current.controlRoot, "staging", id, "wrapper"), candidateBytes, 0o600);
  atomicWriteFile(wrapper, candidateBytes, 0o700);
  const owned = lstatSync(wrapper);
  const request = {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{ id: "wrapper", existed: false, contentHash: sha256(Buffer.alloc(0)), candidate: "wrapper" }]
  };
  const key = readFileSync(resolve(current.controlRoot, "recovery.key"));
  atomicWriteFile(resolve(current.controlRoot, "recovery", `${id}.json`), `${JSON.stringify(sealLocal(key, {
    version: 1,
    originals: [{ id: "wrapper", existed: false, mode: 0o600, bytes: "" }]
  }))}\n`, 0o600);
  atomicWriteFile(resolve(current.controlRoot, "journal", `${id}.json`), `${JSON.stringify({
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    phase: "committing",
    written: ["wrapper"],
    migrations: [],
    sourcePublications: [{ id: "wrapper", identity: { device: String(owned.dev), inode: String(owned.ino) } }]
  })}\n`, 0o600);
  assert.equal(recoverClaimedTransaction(current.descriptor, request), undefined);
  assert.equal(existsSync(wrapper), false);
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, "journal", `${id}.json`), "utf8")).phase, "rolled-back");
});

test("deployment manifests include every desired source and absence", () => {
  const current = fixture();
  const optional = resolve(current.root, "optional.svg");
  current.descriptor.sources["icon-heart"] = { path: optional, serverPath: optional, kind: "svg", optional: true, apply: "rac-restart" };
  assert.deepEqual(currentSourceManifest(current.descriptor), [
    { id: "app", existed: true, contentHash: sha256(readFileSync(current.app)) },
    { id: "icon-heart", existed: false, contentHash: sha256(Buffer.alloc(0)) }
  ]);
});

test("adopt validates the complete target kind before selector commit", async () => {
  const current = fixture();
  const config = resolve(current.root, "config");
  mkdirSync(config, { mode: 0o700 });
  const installation = resolve(config, "remote-agent-console.installation.json");
  const oldEnv = resolve(current.root, "old.env");
  const adoptedEnv = resolve(current.root, "adopted.env");
  atomicWriteFile(oldEnv, `${TEST_AUTH_ENV}RAC_CONFIG=${current.app}\n`, 0o600);
  atomicWriteFile(adoptedEnv, `${TEST_AUTH_ENV}BROKEN=\0\n`, 0o600);
  atomicWriteFile(installation, `${JSON.stringify({ version: 1, native: { environmentFile: oldEnv } })}\n`, 0o600);
  current.descriptor.sources.env = { path: oldEnv, serverPath: oldEnv, kind: "env", apply: "rac-restart" };
  current.descriptor.sources.installation = { path: installation, serverPath: installation, kind: "installation", apply: "rac-restart" };
  current.descriptor.native.environmentFile = oldEnv;
  const id = "invalid_adopt_commit001";
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  atomicWriteFile(resolve(stage, "installation"), `${JSON.stringify({ version: 1, native: { environmentFile: adoptedEnv } })}\n`, 0o600);
  const before = readFileSync(installation, "utf8");
  await assert.rejects(() => processOperation(current.descriptor, {
    version: 1,
    id,
    kind: "commit",
    generation: 1,
    sources: [{
      id: "installation",
      existed: true,
      contentHash: sha256(readFileSync(installation)),
      candidate: "installation",
      migration: { mode: "adopt" }
    }]
  }), (error) => error.code === "invalid-env");
  assert.equal(readFileSync(installation, "utf8"), before);
});
