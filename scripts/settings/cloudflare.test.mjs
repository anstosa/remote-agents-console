import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readRequest, validateDescriptor } from "./contracts.mjs";
import { sha256 } from "./crypto.mjs";
import { atomicWriteFile, safeError } from "./fs.mjs";
import { ensureRecoveryKey, processOperation } from "./operations.mjs";
import { processClaim } from "./queue.mjs";
import { deriveDesiredDescriptor } from "./migrations.mjs";
import { publicHealthProof } from "./cloudflare.mjs";

const TOKEN = "eyJhIjoiZml4dHVyZSIsInQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJzIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9In0=";
const RAC_CONTAINER = "a".repeat(64);
const TOKEN_CONTAINER = "b".repeat(64);

// create one isolated Compose installation
function fixture(options = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "rac-cloudflare-"));
  chmodSync(root, 0o700);
  const controlRoot = resolve(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  // create every helper-owned queue directory
  for (const name of ["queued", "claimed", "status", "staging", "journal", "recovery"]) {
    mkdirSync(resolve(controlRoot, name), { mode: 0o700 });
  }
  mkdirSync(resolve(root, "config"), { mode: 0o700 });
  const app = resolve(root, "config/app.json");
  const installation = resolve(root, "config/remote-agent-console.installation.json");
  const compose = resolve(root, "compose.yaml");
  const env = resolve(root, ".env");
  const cloudflared = resolve(root, "config/cloudflared.yml");
  atomicWriteFile(app, `${JSON.stringify({ publicOrigin: "https://old.example.com", listen: { host: "127.0.0.1", port: 8787 } }, null, 2)}\n`, 0o600);
  atomicWriteFile(installation, `${JSON.stringify({ version: 1, host: { checkout: root }, compose: { projectDirectory: root, projectName: "fixture", files: [compose], envFiles: [env], profiles: [], options: {} }, sources: {} }, null, 2)}\n`, 0o600);
  atomicWriteFile(compose, "services:\n  remote-agent-console:\n    image: fixture\n", 0o600);
  atomicWriteFile(env, "RAC_SESSION_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", 0o600);
  // provide a fixed native tunnel source only for status fixtures
  if (options.nativeCloudflare) {
    atomicWriteFile(cloudflared, "tunnel: fixture\n", 0o600);
  }
  const value = {
    version: 1,
    installationId: "cloudflare-test-installation",
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: options.kind ?? "compose",
    hostControlRoot: controlRoot,
    hostCheckout: root,
    serverCheckout: "/workspace",
    allowedRoots: [root],
    sources: {
      app: { path: app, serverPath: "/workspace/config/app.json", kind: "json", apply: "rac-restart" },
      installation: { path: installation, serverPath: "/workspace/config/remote-agent-console.installation.json", kind: "installation", apply: "rac-restart" },
      env: { path: env, serverPath: "/workspace/.env", kind: "env", apply: "rac-restart" },
      compose: { path: compose, serverPath: "/workspace/compose.yaml", kind: "compose", apply: "rac-restart" },
      ...(options.nativeCloudflare ? { cloudflared: { path: cloudflared, serverPath: cloudflared, kind: "cloudflared", apply: "cloudflared-recreate" } } : {})
    },
    ...(options.kind === "systemd"
      ? { serverCheckout: root, native: { unit: "remote-agent-console.service", environmentFile: env, ...(options.nativeCloudflare ? { cloudflaredUnit: "cloudflared.service" } : {}) } }
      : { compose: { projectDirectory: root, projectName: "fixture", files: [compose], envFiles: [env], profiles: [], options: {} } })
  };
  const descriptorPath = resolve(controlRoot, "installation.json");
  atomicWriteFile(descriptorPath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  ensureRecoveryKey(controlRoot);
  return { root, controlRoot, app, installation, descriptorPath, descriptor: validateDescriptor(value, descriptorPath) };
}

// reload host authority after connector setup
function reload(current) {
  return validateDescriptor(JSON.parse(readFileSync(current.descriptorPath, "utf8")), current.descriptorPath);
}

// stage one private discriminated setup candidate
function request(current, id, action, body, sources = true) {
  const stage = resolve(current.controlRoot, "staging", id);
  mkdirSync(stage, { mode: 0o700 });
  atomicWriteFile(resolve(stage, "cloudflare-connect"), `${JSON.stringify({ action, ...body })}\n`, 0o600);
  return {
    version: 1,
    id,
    kind: "cloudflare",
    generation: current.descriptor.generation,
    ...(sources ? { sources: [current.app, current.installation].map((path, index) => ({ id: index === 0 ? "app" : "installation", existed: true, contentHash: sha256(readFileSync(path)) })) } : {}),
    cloudflare: { action, candidate: "cloudflare-connect" }
  };
}

// create one selector-only connector restart request
function reconnectRequest(current, id) {
  return { version: 1, id, kind: "cloudflare", generation: current.descriptor.generation, cloudflare: { action: "reconnect" } };
}

// render the installer-owned token service
function composeModel(current, overrides = {}) {
  return {
    services: {
      "remote-agent-console": {
        healthcheck: { test: ["CMD", "true"] },
        environment: {
          RAC_CONFIG: "/workspace/config/app.json",
          RAC_CONFIG_WRITE_PATH: "/workspace/config/app.json",
          RAC_SERVER_CHECKOUT: "/workspace",
          RAC_PASSWORD_HASH: "$$argon2id$$fixture",
          RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        volumes: [
          { type: "bind", source: current.root, target: "/workspace" },
          { type: "bind", source: current.controlRoot, target: "/run/rac-settings-control" }
        ]
      },
      "cloudflared-token": {
        image: "cloudflare/cloudflared:latest",
        profiles: ["tunnel-token"],
        user: "0:0",
        network_mode: "host",
        restart: "unless-stopped",
        read_only: true,
        security_opt: ["no-new-privileges:true"],
        command: ["tunnel", "--no-autoupdate", "run", "--token-file", "/run/secrets/cloudflared-token"],
        volumes: [{ type: "bind", source: resolve(current.root, "config/cloudflared.token"), target: "/run/secrets/cloudflared-token", read_only: true, bind: { create_host_path: false } }],
        ...overrides
      }
    }
  };
}

// record fixed Docker calls without exposing token bytes
function runner(current, options = {}) {
  const calls = [];
  let tokenContainer = options.running ? "c".repeat(64) : "";
  let tokenExists = options.running || options.stopped;
  let localContainer = options.localRunning ? "d".repeat(64) : "";
  let localExists = options.localRunning || options.localStopped;
  let tokenStartedAt = tokenExists ? "2026-10-28T20:00:00.000000000Z" : "";
  let localStartedAt = localExists ? "2026-10-28T20:00:00.000000000Z" : "";
  let restartSequence = 0;
  let racFailures = options.racFailures ?? (options.racFailure ? Number.POSITIVE_INFINITY : 0);
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    // return the normalized Compose graph
    if (args.includes("config") && args.includes("--format")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify(options.model ?? composeModel(current))), stderr: Buffer.alloc(0) };
    }
    // track connector lifecycle
    if (args.includes("ps") && args.at(-1) === "cloudflared-token") {
      return { code: options.psFailure ? 1 : 0, stdout: Buffer.from(args.includes("--all") && tokenExists ? TOKEN_CONTAINER : tokenContainer), stderr: Buffer.alloc(0) };
    }
    // expose the legacy connector independently from managed token mode
    if (args.includes("ps") && args.at(-1) === "cloudflared") {
      return { code: 0, stdout: Buffer.from(args.includes("--all") && localExists ? "d".repeat(64) : localContainer), stderr: Buffer.alloc(0) };
    }
    // return one process start identity for replay proof
    if (command === "docker" && args[0] === "inspect") {
      const startedAt = args.at(-1) === TOKEN_CONTAINER ? tokenStartedAt : localStartedAt;
      return { code: startedAt === "" ? 1 : 0, stdout: Buffer.from(startedAt), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up") && args.at(-1) === "cloudflared-token") {
      tokenContainer = TOKEN_CONTAINER;
      tokenExists = true;
      tokenStartedAt = "2026-10-28T20:00:01.000000000Z";
      return { code: options.connectorFailure ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args.includes("stop") && args.at(-1) === "cloudflared-token") {
      tokenContainer = "";
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // restart only an existing managed connector container
    if (args.includes("restart") && args.at(-1) === "cloudflared-token") {
      tokenContainer = tokenExists ? TOKEN_CONTAINER : "";
      if (tokenExists && !options.connectorFailure) tokenStartedAt = `2026-10-28T20:00:${String(2 + restartSequence++).padStart(2, "0")}.000000000Z`;
      return { code: options.connectorFailure ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // restart only an existing local connector container
    if (args.includes("restart") && args.at(-1) === "cloudflared") {
      localContainer = localExists ? "d".repeat(64) : "";
      if (localExists && !options.connectorFailure) localStartedAt = `2026-10-28T20:00:${String(2 + restartSequence++).padStart(2, "0")}.000000000Z`;
      return { code: options.connectorFailure ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // prove the RAC replacement
    if (args.includes("up") && args.at(-1) === "remote-agent-console") {
      const failing = racFailures > 0;
      racFailures -= 1;
      return { code: failing ? 1 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args.includes("ps") && args.at(-1) === "remote-agent-console") {
      return { code: 0, stdout: Buffer.from(RAC_CONTAINER), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { run, calls, tokenContainer: () => tokenContainer };
}

// persist simulated connector state across an abrupt helper exit
function persistentRunner(current, marker) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    // return the normalized installer-owned graph
    if (args.includes("config") && args.includes("--format")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify(composeModel(current))), stderr: Buffer.alloc(0) };
    }
    // read the durable simulated connector process identity
    if (args.includes("ps") && args.at(-1) === "cloudflared-token") {
      return { code: 0, stdout: existsSync(marker) ? readFileSync(marker) : Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // replace the simulated connector with a distinct identity
    if (args.includes("up") && args.at(-1) === "cloudflared-token") {
      const previous = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      atomicWriteFile(marker, previous.startsWith("d") ? "e".repeat(64) : "d".repeat(64), 0o600);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // stop only the simulated managed connector
    if (args.includes("stop") && args.at(-1) === "cloudflared-token") {
      if (existsSync(marker)) unlinkSync(marker);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    // prove the simulated RAC replacement
    if (args.includes("up") && args.at(-1) === "remote-agent-console") {
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args.includes("ps") && args.at(-1) === "remote-agent-console") {
      return { code: 0, stdout: Buffer.from(RAC_CONTAINER), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { run, calls };
}

// terminate a child helper at one durable transaction seam
function crashAfterPublication(current, operation, publication, marker) {
  const requestPath = resolve(current.controlRoot, "crash-request.json");
  const modelPath = resolve(current.controlRoot, "crash-compose-model.json");
  atomicWriteFile(requestPath, `${JSON.stringify(operation)}\n`, 0o600);
  atomicWriteFile(modelPath, `${JSON.stringify(composeModel(current))}\n`, 0o600);
  const program = `
    import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
    import { resolve } from "node:path";
    import { processOperation } from "./scripts/settings/operations.mjs";
    import { validateDescriptor } from "./scripts/settings/contracts.mjs";
    const descriptorPath = resolve(process.env.CRASH_CONTROL_ROOT, "installation.json");
    const descriptor = validateDescriptor(JSON.parse(readFileSync(descriptorPath, "utf8")), descriptorPath);
    const request = JSON.parse(readFileSync(process.env.CRASH_REQUEST_PATH, "utf8"));
    const model = readFileSync(process.env.CRASH_MODEL_PATH);
    const marker = process.env.CRASH_MARKER;
    const runner = async (_command, args) => {
      // return the fixed normalized graph
      if (args.includes("config") && args.includes("--format")) return { code: 0, stdout: model, stderr: Buffer.alloc(0) };
      // expose the durable simulated connector identity
      if (args.includes("ps") && args.at(-1) === "cloudflared-token") return { code: 0, stdout: existsSync(marker) ? readFileSync(marker) : Buffer.alloc(0), stderr: Buffer.alloc(0) };
      // replace only the simulated managed connector
      if (args.includes("up") && args.at(-1) === "cloudflared-token") {
        const previous = existsSync(marker) ? readFileSync(marker, "utf8") : "";
        writeFileSync(marker, previous.startsWith("d") ? "${"e".repeat(64)}" : "${"d".repeat(64)}", { mode: 0o600 });
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      // stop only the simulated managed connector
      if (args.includes("stop") && args.at(-1) === "cloudflared-token") {
        // preserve a proved stopped state
        if (existsSync(marker)) unlinkSync(marker);
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      // prove the simulated RAC process identity
      if (args.includes("ps") && args.at(-1) === "remote-agent-console") return { code: 0, stdout: Buffer.from("${RAC_CONTAINER}"), stderr: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    await processOperation(descriptor, request, {
      runner,
      cloudflareHealthProof: async () => true,
      baselineProve: async () => ({ bootNonce: "before", semanticHashes: {}, environmentHashes: {}, environmentFileHashes: {}, targetProofs: { rac: { containerId: "${RAC_CONTAINER}" } } }),
      prove: async () => ({ bootNonce: "after", semanticHashes: {}, environmentHashes: {}, environmentFileHashes: {} }),
      recoveryProve: async () => ({ bootNonce: "recovered" }),
      afterCloudflarePublish: (id) => { if (id === process.env.CRASH_PUBLICATION) process.kill(process.pid, "SIGKILL"); },
      afterCloudflareComplete: () => { if (process.env.CRASH_PUBLICATION === "complete") process.kill(process.pid, "SIGKILL"); }
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CRASH_CONTROL_ROOT: current.controlRoot,
      CRASH_REQUEST_PATH: requestPath,
      CRASH_MODEL_PATH: modelPath,
      CRASH_MARKER: marker,
      CRASH_PUBLICATION: publication
    },
    encoding: "utf8"
  });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

// inject fixed RAC recovery and replacement proofs
function proofOptions(run, extra = {}) {
  return {
    runner: run,
    baselineProve: async () => ({ bootNonce: "before", semanticHashes: {}, environmentHashes: {}, environmentFileHashes: {}, targetProofs: { rac: { containerId: RAC_CONTAINER } } }),
    prove: async () => ({ bootNonce: "after", semanticHashes: {}, environmentHashes: {}, environmentFileHashes: {} }),
    recoveryProve: async () => ({ bootNonce: "recovered" }),
    ...extra
  };
}

test("connector setup stores a private token and starts only the token sidecar", async () => {
  const current = fixture();
  const docker = runner(current);
  const restartProgress = [];
  const operation = request(current, "cloudflare_connect_0001", "connect", { token: TOKEN });
  const beforeApp = readFileSync(current.app);
  const beforeInstallation = readFileSync(current.installation);
  const result = await processOperation(current.descriptor, operation, proofOptions(docker.run, {
    onRestartProgress: (progress) => restartProgress.push(progress)
  }));
  assert.equal(result.phase, "connector-ready");
  assert.equal(result.cloudflare.mode, "token");
  assert.equal(result.cloudflare.tokenPresent, true);
  assert.deepEqual(restartProgress, []);
  assert.equal(result.cloudflare.serviceUrl, "http://127.0.0.1:8787");
  assert.equal(Object.hasOwn(result.cloudflare, "token"), false);
  assert.deepEqual(readFileSync(current.app), beforeApp);
  assert.deepEqual(readFileSync(current.installation), beforeInstallation);
  assert.equal(lstatSync(resolve(current.root, "config/cloudflared.token")).mode & 0o777, 0o600);
  assert.equal(readFileSync(resolve(current.root, "config/cloudflared.token"), "utf8"), `${TOKEN}\n`);
  assert.equal(reload(current).compose.profiles.includes("tunnel-token"), true);
  assert.equal(docker.calls.some((call) => call.args.at(-1) === "cloudflared"), false);
  assert.equal(JSON.stringify(docker.calls).includes(TOKEN), false);
  assert.equal(readFileSync(resolve(current.controlRoot, "journal/cloudflare_connect_0001.json"), "utf8").includes(TOKEN), false);
  assert.equal(readFileSync(resolve(current.controlRoot, "recovery/cloudflare_connect_0001.json"), "utf8").includes(TOKEN), false);
});

test("connector setup reuses a saved token without restaging it", async () => {
  const current = fixture();
  atomicWriteFile(resolve(current.root, "config/cloudflared.token"), `${TOKEN}\n`, 0o600);
  const docker = runner(current, { running: true });
  const result = await processOperation(current.descriptor, request(current, "cloudflare_reuse_000001", "connect", {}), proofOptions(docker.run));
  assert.equal(result.cloudflare.tokenPresent, true);
  assert.equal(readFileSync(resolve(current.root, "config/cloudflared.token"), "utf8"), `${TOKEN}\n`);
});

test("later installation derivation cannot silently remove managed token activation", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_persist_0001", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const desired = await deriveDesiredDescriptor(current.descriptor, { runner: docker.run });
  assert.equal(desired.compose.profiles.includes("tunnel-token"), true);
  assert.equal(desired.generation, current.descriptor.generation);
});

test("connector setup accepts a trimmed opaque token without guessing its format", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_opaque_00001", "connect", { token: "  short opaque token  " }), proofOptions(docker.run));
  assert.equal(readFileSync(resolve(current.root, "config/cloudflared.token"), "utf8"), "short opaque token\n");
});

test("connector replay recovers every write-ahead crash seam before retrying the same request", async () => {
  // exercise each private publication from an absent stopped predecessor
  for (const publication of ["token", "descriptor", "state"]) {
    const current = fixture();
    const marker = resolve(current.controlRoot, "simulated-token-container");
    const docker = persistentRunner(current, marker);
    const operation = request(current, `cloudflare_crash_${publication}_01`, "connect", { token: TOKEN });
    const descriptorBefore = readFileSync(current.descriptorPath);
    crashAfterPublication(current, operation, publication, marker);
    const journal = JSON.parse(readFileSync(resolve(current.controlRoot, `journal/${operation.id}.json`), "utf8"));
    assert.equal(typeof journal.beforeHashes[publication], "string");
    assert.equal(typeof journal.hashes[publication], "string");
    // force replay to stop after recovery so the predecessor is observable
    atomicWriteFile(resolve(current.controlRoot, "staging", operation.id, "cloudflare-connect"), `${JSON.stringify({ action: "wrong" })}\n`, 0o600);
    const crashedDescriptor = reload(current);
    await assert.rejects(() => processOperation(crashedDescriptor, operation, proofOptions(docker.run)), { code: "invalid-cloudflare-candidate" });
    assert.equal(existsSync(resolve(current.root, "config/cloudflared.token")), false);
    assert.deepEqual(readFileSync(current.descriptorPath), descriptorBefore);
    assert.equal(existsSync(resolve(current.controlRoot, "cloudflare.json")), false);
    assert.equal(existsSync(marker), false);
    assert.equal(docker.calls.some((call) => call.args.at(-1) === "cloudflared" && (call.args.includes("up") || call.args.includes("stop"))), false);
    // retry the identical operation id after restoring its private candidate
    atomicWriteFile(resolve(current.controlRoot, "staging", operation.id, "cloudflare-connect"), `${JSON.stringify({ action: "connect", token: TOKEN })}\n`, 0o600);
    const result = await processOperation(reload(current), operation, proofOptions(docker.run));
    assert.equal(result.phase, "connector-ready");
    assert.equal(result.cloudflare.connected, true);
  }
});

test("connector crash recovery preserves a previously running managed connector", async () => {
  const current = fixture();
  const marker = resolve(current.controlRoot, "simulated-token-container");
  const docker = persistentRunner(current, marker);
  atomicWriteFile(resolve(current.root, "config/cloudflared.token"), "previous opaque token\n", 0o600);
  atomicWriteFile(marker, "c".repeat(64), 0o600);
  const operation = request(current, "cloudflare_running_crash1", "connect", { token: TOKEN });
  crashAfterPublication(current, operation, "descriptor", marker);
  atomicWriteFile(resolve(current.controlRoot, "staging", operation.id, "cloudflare-connect"), `${JSON.stringify({ action: "wrong" })}\n`, 0o600);
  await assert.rejects(() => processOperation(reload(current), operation, proofOptions(docker.run)), { code: "invalid-cloudflare-candidate" });
  assert.equal(readFileSync(resolve(current.root, "config/cloudflared.token"), "utf8"), "previous opaque token\n");
  assert.equal(existsSync(marker), true);
  assert.equal(docker.calls.some((call) => call.args.includes("stop") && call.args.at(-1) === "cloudflared-token"), false);
  assert.equal(docker.calls.some((call) => call.args.at(-1) === "cloudflared" && (call.args.includes("up") || call.args.includes("stop"))), false);
});

test("activation verifies the same public RAC before changing origin", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_0002", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const restartProgress = [];
  const activation = request(current, "cloudflare_activate_001", "activate", { hostname: "agents.example.com" });
  const result = await processOperation(current.descriptor, activation, proofOptions(docker.run, {
    cloudflareHealthProof: async ({ hostname }) => hostname === "agents.example.com",
    onRestartProgress: (progress) => restartProgress.push(progress)
  }));
  assert.equal(result.phase, "activated");
  assert.equal(JSON.parse(readFileSync(current.app, "utf8")).publicOrigin, "https://agents.example.com");
  assert.equal(result.cloudflare.hostname, "agents.example.com");
  assert.match(result.cloudflare.verifiedAt, /^\d{4}-/u);
  assert.equal(docker.calls.some((call) => call.args.at(-1) === "remote-agent-console" && call.args.includes("up")), true);
  assert.deepEqual(restartProgress.map((progress) => progress.state), ["restarting", "restarted"]);
  assert.equal(restartProgress[0].recoveryDeadline, restartProgress[1].recoveryDeadline);
});

test("activation records verification without restarting when public origin already matches", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_setup_matching1", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const before = readFileSync(current.app);
  const beforeHash = sha256(before);
  const racStarts = docker.calls.filter((call) => call.args.includes("up") && call.args.at(-1) === "remote-agent-console").length;
  const result = await processOperation(current.descriptor, request(current, "cloudflare_activate_match1", "activate", { hostname: "old.example.com" }), proofOptions(docker.run, {
    cloudflareHealthProof: async () => true,
    baselineProve: async () => {
      throw new Error("unchanged origin must not require a restart baseline");
    }
  }));
  assert.equal(result.phase, "activated");
  assert.deepEqual(result.receipt.targets, []);
  assert.equal(sha256(readFileSync(current.app)), beforeHash);
  assert.deepEqual(readFileSync(current.app), before);
  assert.equal(docker.calls.filter((call) => call.args.includes("up") && call.args.at(-1) === "remote-agent-console").length, racStarts);
});

test("activation rollback ignores restart progress reporting failures", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_report1", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const restartProgress = [];
  let recoveryProofs = 0;
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_activate_report1", "activate", { hostname: "agents.example.com" }), proofOptions(docker.run, {
    cloudflareHealthProof: async () => true,
    recoveryProve: async () => { recoveryProofs += 1; },
    afterCloudflareComplete: () => { throw safeError("late-publication-failed"); },
    onRestartProgress: (progress) => {
      restartProgress.push(progress.state);
      if (progress.state === "recovering") throw safeError("status-write-failed");
    }
  })), { code: "late-publication-failed" });
  assert.equal(recoveryProofs, 1);
  assert.deepEqual(restartProgress, ["restarting", "restarted", "recovering", "recovered"]);
  assert.equal(restartProgress.includes("recovery-failed"), false);
});

test("activation replay restores app and redacted state at every write-ahead crash seam", async () => {
  // exercise both activation publications while leaving the connector running
  for (const publication of ["app", "state"]) {
    const current = fixture();
    const marker = resolve(current.controlRoot, "simulated-token-container");
    const docker = persistentRunner(current, marker);
    await processOperation(current.descriptor, request(current, `cloudflare_setup_${publication}_01`, "connect", { token: TOKEN }), proofOptions(docker.run));
    current.descriptor = reload(current);
    const operation = request(current, `cloudflare_activate_crash_${publication}`, "activate", { hostname: "agents.example.com" });
    const appBefore = readFileSync(current.app);
    const statePath = resolve(current.controlRoot, "cloudflare.json");
    const stateBefore = readFileSync(statePath);
    crashAfterPublication(current, operation, publication, marker);
    const journal = JSON.parse(readFileSync(resolve(current.controlRoot, `journal/${operation.id}.json`), "utf8"));
    assert.equal(typeof journal.beforeHashes[publication], "string");
    assert.equal(typeof journal.hashes[publication], "string");
    await assert.rejects(() => processOperation(reload(current), operation, proofOptions(docker.run, {
      cloudflareHealthProof: async () => false
    })), { code: "cloudflare-health-proof-failed" });
    assert.deepEqual(readFileSync(current.app), appBefore);
    assert.deepEqual(readFileSync(statePath), stateBefore);
    assert.equal(existsSync(marker), true);
    assert.equal(docker.calls.some((call) => call.args.includes("up") && call.args.at(-1) === "remote-agent-console"), false);
    // retry the same request after recovery and prove normal activation still works
    const result = await processOperation(reload(current), operation, proofOptions(docker.run, {
      cloudflareHealthProof: async () => true
    }));
    assert.equal(result.phase, "activated");
    assert.equal(result.cloudflare.connected, true);
  }
});

test("activation replays a complete journal without repeating the RAC transition", async () => {
  const current = fixture();
  const marker = resolve(current.controlRoot, "simulated-token-container");
  const setupDocker = persistentRunner(current, marker);
  await processOperation(current.descriptor, request(current, "cloudflare_setup_complete1", "connect", { token: TOKEN }), proofOptions(setupDocker.run));
  current.descriptor = reload(current);
  const operation = request(current, "cloudflare_activate_complete1", "activate", { hostname: "agents.example.com" });
  crashAfterPublication(current, operation, "complete", marker);
  const activatedBytes = readFileSync(current.app);
  const replayDocker = persistentRunner(current, marker);
  const result = await processOperation(reload(current), operation, proofOptions(replayDocker.run, {
    cloudflareHealthProof: async () => {
      throw new Error("terminal replay must not reverify");
    }
  }));
  assert.equal(result.phase, "activated");
  assert.equal(result.cloudflare.hostname, "agents.example.com");
  assert.deepEqual(readFileSync(current.app), activatedBytes);
  assert.equal(replayDocker.calls.length, 0);
});

test("failed public proof leaves the connector ready and origin untouched", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_0003", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const before = readFileSync(current.app);
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_activate_002", "activate", { hostname: "agents.example.com" }), proofOptions(docker.run, {
    cloudflareHealthProof: async () => false
  })), { code: "cloudflare-health-proof-failed" });
  assert.deepEqual(readFileSync(current.app), before);
  assert.equal(docker.tokenContainer(), TOKEN_CONTAINER);
  const status = await processOperation(current.descriptor, { version: 1, id: "cloudflare_status_00001", kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, proofOptions(docker.run));
  assert.equal(status.cloudflare.enabled, true);
  assert.equal(status.cloudflare.connected, true);
  assert.equal(status.cloudflare.verifiedAt, undefined);
});

test("configured token mode reports a stopped connector without losing verification history", async () => {
  const current = fixture();
  const setupDocker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_stop1", "connect", { token: TOKEN }), proofOptions(setupDocker.run));
  current.descriptor = reload(current);
  atomicWriteFile(resolve(current.controlRoot, "cloudflare.json"), `${JSON.stringify({ mode: "token", hostname: "agents.example.com", verifiedAt: "2026-10-18T00:00:00.000Z" })}\n`, 0o600);
  atomicWriteFile(current.app, `${JSON.stringify({ publicOrigin: "https://replacement.example.com:8443", listen: { host: "127.0.0.1", port: 8787 } })}\n`, 0o600);
  const stoppedDocker = runner(current);
  const result = await processOperation(current.descriptor, { version: 1, id: "cloudflare_stopped_status1", kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, proofOptions(stoppedDocker.run));
  assert.equal(result.cloudflare.enabled, true);
  assert.equal(result.cloudflare.connected, false);
  assert.equal(result.cloudflare.endpoint, "https://agents.example.com");
  assert.equal(result.cloudflare.hostname, "agents.example.com");
  assert.equal(result.cloudflare.verifiedAt, "2026-10-18T00:00:00.000Z");
});

test("legacy Compose status keeps the configured public endpoint while the connector changes state", async () => {
  const current = fixture();
  current.descriptor.compose.profiles.push("tunnel");
  atomicWriteFile(current.app, `${JSON.stringify({ publicOrigin: "https://agents.example.com:8443", listen: { host: "127.0.0.1", port: 8787 } })}\n`, 0o600);
  // report the same configured endpoint for both proved runtime states
  for (const [localRunning, connected] of [[true, true], [false, false]]) {
    const docker = runner(current, { localRunning });
    const result = await processOperation(current.descriptor, { version: 1, id: `cloudflare_local_${connected ? "running" : "stopped"}01`, kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, proofOptions(docker.run));
    assert.equal(result.cloudflare.mode, "local");
    assert.equal(result.cloudflare.connected, connected);
    assert.equal(result.cloudflare.endpoint, "https://agents.example.com:8443");
    assert.equal(result.cloudflare.hostname, "agents.example.com");
    assert.equal(result.cloudflare.serviceUrl, "http://127.0.0.1:8787");
  }
});

test("native tunnel status reports only proved active and inactive states", async () => {
  // exercise both proved states plus an unavailable status result
  for (const [code, connected] of [[0, true], [3, false], [4, undefined]]) {
    const current = fixture({ kind: "systemd", nativeCloudflare: true });
    const calls = [];
    const result = await processOperation(current.descriptor, { version: 1, id: `cloudflare_native_${connected ? "active" : "inactive"}01`, kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, {
      runner: async (command, args) => {
        calls.push({ command, args });
        return { code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    });
    assert.equal(result.cloudflare.mode, "local");
    assert.equal(result.cloudflare.connected, connected);
    assert.equal(Object.hasOwn(result.cloudflare, "connected"), connected !== undefined);
    assert.equal(result.cloudflare.endpoint, "https://old.example.com");
    assert.equal(result.cloudflare.hostname, "old.example.com");
    assert.deepEqual(calls, [{ command: "systemctl", args: ["--user", "is-active", "--quiet", "cloudflared.service"] }]);
  }
});

test("status omits public endpoint data when the configured origin is missing or malformed", async () => {
  // reject every noncanonical saved origin without inventing an endpoint
  for (const app of [
    { listen: { host: "127.0.0.1", port: 8787 } },
    { publicOrigin: "not a url", listen: { host: "127.0.0.1", port: 8787 } },
    { publicOrigin: "https://user:secret@agents.example.com/path", listen: { host: "127.0.0.1", port: 8787 } }
  ]) {
    const current = fixture();
    current.descriptor.compose.profiles.push("tunnel");
    atomicWriteFile(current.app, `${JSON.stringify(app)}\n`, 0o600);
    const docker = runner(current);
    const result = await processOperation(current.descriptor, { version: 1, id: `cloudflare_invalid_origin_${Math.random().toString(36).slice(2, 8)}`, kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, proofOptions(docker.run));
    assert.equal(Object.hasOwn(result.cloudflare, "endpoint"), false);
    assert.equal(Object.hasOwn(result.cloudflare, "hostname"), false);
  }
});

test("failed RAC restart rolls back the origin but keeps connector setup", async () => {
  const current = fixture();
  const setupDocker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_0004", "connect", { token: TOKEN }), proofOptions(setupDocker.run));
  current.descriptor = reload(current);
  const before = readFileSync(current.app);
  const failingDocker = runner(current, { running: true, racFailures: 1 });
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_activate_003", "activate", { hostname: "agents.example.com" }), proofOptions(failingDocker.run, {
    cloudflareHealthProof: async () => true
  })), { code: "apply-failed" });
  assert.deepEqual(readFileSync(current.app), before);
  assert.equal(existsSync(resolve(current.root, "config/cloudflared.token")), true);
  assert.equal(reload(current).compose.profiles.includes("tunnel-token"), true);
  assert.equal(failingDocker.calls.filter((call) => call.args.includes("up") && call.args.at(-1) === "remote-agent-console").length, 2);
});

test("invalid tokens and hostname forms fail before Docker mutation", async () => {
  const invalidHosts = ["http://agents.example.com", "127.0.0.1", "localhost", "agents.example.com:443", "metadata.google.internal"];
  // isolate each rejected candidate
  for (const [index, hostname] of invalidHosts.entries()) {
    const current = fixture();
    const docker = runner(current);
    await assert.rejects(() => processOperation(current.descriptor, request(current, `cloudflare_bad_host_${index}000`, "activate", { hostname }), proofOptions(docker.run)), { code: "invalid-cloudflare-hostname" });
    assert.equal(docker.calls.some((call) => call.args.includes("up") || call.args.includes("stop")), false);
  }
  const current = fixture();
  const docker = runner(current);
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_bad_token_001", "connect", { token: "cloudflared service install copied-token" }), proofOptions(docker.run)), { code: "invalid-cloudflare-token" });
  assert.equal(docker.calls.some((call) => call.args.includes("up") || call.args.includes("stop")), false);
});

test("custom token service overrides fail closed before connector start", async () => {
  const current = fixture();
  const docker = runner(current, { model: composeModel(current, { command: ["tunnel", "run", "unsafe-token"] }) });
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_override_0001", "connect", { token: TOKEN }), proofOptions(docker.run)), { code: "cloudflare-service-unsupported" });
  assert.equal(docker.calls.some((call) => call.args.includes("up")), false);
});

test("native installations report setup unavailable without invoking cloudflared", async () => {
  const current = fixture({ kind: "systemd" });
  const calls = [];
  const result = await processOperation(current.descriptor, { version: 1, id: "cloudflare_native_status1", kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, {
    runner: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
  });
  assert.equal(result.cloudflare.supported, false);
  assert.equal(result.cloudflare.reason, "cloudflare-token-compose-only");
  assert.equal(calls.length, 0);
});

test("reconnect restarts only the exact managed token connector", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_restart1", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const before = docker.calls.length;

  const result = await processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_token1"), proofOptions(docker.run));
  const reconnectCalls = docker.calls.slice(before);

  assert.equal(result.phase, "connector-reconnected");
  assert.equal(reconnectCalls.some((call) => call.command === "docker" && call.args.includes("restart") && call.args.at(-1) === "cloudflared-token"), true);
  assert.equal(reconnectCalls.some((call) => call.args.includes("up") || call.args.includes("build") || call.args.includes("--force-recreate") || call.args.at(-1) === "remote-agent-console"), false);
});

test("reconnect starts a stopped configured token connector without recreating it", async () => {
  const current = fixture();
  const setup = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_stopped1", "connect", { token: TOKEN }), proofOptions(setup.run));
  current.descriptor = reload(current);
  const docker = runner(current, { stopped: true });

  const result = await processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_stop01"), proofOptions(docker.run));

  assert.equal(result.phase, "connector-reconnected");
  assert.equal(docker.calls.some((call) => call.args.includes("restart") && call.args.at(-1) === "cloudflared-token"), true);
  assert.equal(docker.calls.some((call) => call.args.includes("up")), false);
});

test("reconnect replay proves the first restart instead of restarting twice", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_replay01", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const operation = reconnectRequest(current, "cloudflare_reconnect_replay1");

  await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(docker.run, {
    // simulate helper death after restart command success
    afterCloudflareReconnect: () => { throw safeError("simulated-helper-death"); }
  })), { code: "simulated-helper-death" });
  const result = await processOperation(current.descriptor, operation, proofOptions(docker.run));
  const replay = await processOperation(current.descriptor, operation, proofOptions(docker.run));
  const restarts = docker.calls.filter((call) => call.args.includes("restart") && call.args.at(-1) === "cloudflared-token");

  assert.equal(result.phase, "connector-reconnected");
  assert.deepEqual(replay, result);
  assert.equal(restarts.length, 1);
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, `journal/${operation.id}.json`), "utf8")).phase, "complete");
});

test("reconnect replay closes unavailable runtime proof for retention", async () => {
  const current = fixture();
  const setup = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_replay02", "connect", { token: TOKEN }), proofOptions(setup.run));
  current.descriptor = reload(current);
  const operation = reconnectRequest(current, "cloudflare_reconnect_replay2");
  const journalPath = resolve(current.controlRoot, `journal/${operation.id}.json`);
  atomicWriteFile(journalPath, `${JSON.stringify({ version: 1, id: operation.id, kind: "cloudflare", action: "reconnect", generation: operation.generation, phase: "restarting", runtime: { kind: "compose", service: "cloudflared-token", profile: "tunnel-token", container: TOKEN_CONTAINER, startedAt: "2026-10-28T20:00:01.000000000Z", running: true }, updatedAt: "2026-10-28T20:00:01.000Z" })}\n`, 0o600);

  await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(runner(current, { running: true, psFailure: true }).run)), { code: "cloudflare-connector-status-unavailable" });

  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).phase, "rolled-back");
});

test("reconnect preserves a mismatched journal for explicit recovery", async () => {
  const current = fixture();
  current.descriptor.compose.profiles = ["tunnel-token"];
  const operation = reconnectRequest(current, "cloudflare_reconnect_mismatch");
  const journalPath = resolve(current.controlRoot, `journal/${operation.id}.json`);
  const substituted = `${JSON.stringify({ version: 1, id: "different_reconnect_identity", kind: "cloudflare", action: "reconnect", generation: operation.generation, phase: "restarting", runtime: { kind: "unavailable" } })}\n`;
  atomicWriteFile(journalPath, substituted, 0o600);

  await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(runner(current, { running: true }).run)), { code: "journal-mismatch" });

  assert.equal(readFileSync(journalPath, "utf8"), substituted);
});

test("reconnect rejects forged compose terminal journals before Docker mutation", async () => {
  const validStatus = { supported: true, mode: "token", enabled: true, tokenPresent: true, serviceUrl: "http://127.0.0.1:8787", connected: true };
  const validRuntime = { kind: "compose", service: "cloudflared-token", profile: "tunnel-token", container: TOKEN_CONTAINER, startedAt: "2026-10-28T20:00:01.000000000Z", running: true };
  const forgeries = [
    ["version", { version: 2 }],
    ["unknown journal field", { forged: true }],
    ["missing updated time", { updatedAt: undefined }],
    ["impossible updated time", { updatedAt: "2026-02-30T20:00:02.000Z" }],
    ["service", { runtime: { ...validRuntime, service: "remote-agent-console" } }],
    ["profile", { phase: "rolled-back", cloudflare: undefined, runtime: { ...validRuntime, profile: "tunnel" } }],
    ["runtime field", { runtime: { ...validRuntime, command: ["restart", "remote-agent-console"] } }],
    ["runtime type", { runtime: { ...validRuntime, running: "true" } }],
    ["impossible runtime time", { runtime: { ...validRuntime, startedAt: "2026-02-30T20:00:01.000000000Z" } }],
    ["expanded status", { cloudflare: { ...validStatus, token: TOKEN } }],
    ["impossible status time", { cloudflare: { ...validStatus, verifiedAt: "2026-02-30T20:00:02.000Z" } }],
    ["credentialed status", { cloudflare: { ...validStatus, serviceUrl: "http://operator:secret@127.0.0.1:8787" } }],
    ["non-complete status", { phase: "rolled-back" }]
  ];
  // reject each terminal substitution before consulting docker
  for (const [index, [name, changes]] of forgeries.entries()) {
    const current = fixture();
    current.descriptor.compose.profiles = ["tunnel-token"];
    const operation = reconnectRequest(current, `cloudflare_forged_compose_${String(index).padStart(2, "0")}`);
    const journalPath = resolve(current.controlRoot, `journal/${operation.id}.json`);
    const journal = {
      version: 1,
      id: operation.id,
      kind: "cloudflare",
      action: "reconnect",
      generation: operation.generation,
      phase: "complete",
      runtime: validRuntime,
      cloudflare: validStatus,
      updatedAt: "2026-10-28T20:00:02.000Z",
      ...changes
    };
    // model forbidden fields through omission rather than undefined json values
    if (changes.updatedAt === undefined && Object.hasOwn(changes, "updatedAt")) delete journal.updatedAt;
    // retain forbidden status on the rolled-back phase
    if (name === "non-complete status") journal.cloudflare = validStatus;
    const bytes = `${JSON.stringify(journal)}\n`;
    atomicWriteFile(journalPath, bytes, 0o600);
    const docker = runner(current, { running: true });

    await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(docker.run)), { code: "journal-mismatch" }, name);
    assert.equal(docker.calls.length, 0, name);
    assert.equal(readFileSync(journalPath, "utf8"), bytes, name);
  }
});

test("reconnect rejects forged native terminal journals before systemd mutation", async () => {
  const validStatus = { supported: false, reason: "cloudflare-token-compose-only", mode: "local", enabled: true, tokenPresent: false, serviceUrl: "http://127.0.0.1:8787", connected: true };
  const validRuntime = { kind: "native", unit: "cloudflared.service", invocation: "a".repeat(32), active: true };
  const forgeries = [
    ["unit", { ...validRuntime, unit: "remote-agent-console.service" }],
    ["invocation", { ...validRuntime, invocation: "a".repeat(33) }],
    ["active", { ...validRuntime, active: 1 }],
    ["runtime field", { ...validRuntime, args: ["--token", TOKEN] }]
  ];
  // reject each native runtime substitution without consulting systemd
  for (const [index, [name, runtime]] of forgeries.entries()) {
    const current = fixture({ kind: "systemd", nativeCloudflare: true });
    const operation = reconnectRequest(current, `cloudflare_forged_native_${String(index).padStart(2, "0")}`);
    const journalPath = resolve(current.controlRoot, `journal/${operation.id}.json`);
    const bytes = `${JSON.stringify({ version: 1, id: operation.id, kind: "cloudflare", action: "reconnect", generation: operation.generation, phase: "complete", runtime, cloudflare: validStatus, updatedAt: "2026-10-28T20:00:02.000Z" })}\n`;
    atomicWriteFile(journalPath, bytes, 0o600);
    const calls = [];
    // record any forbidden systemd consultation
    const run = async (command, args) => {
      calls.push({ command, args: [...args] });
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    await assert.rejects(() => processOperation(current.descriptor, operation, { runner: run }), { code: "journal-mismatch" }, name);
    assert.equal(calls.length, 0, name);
    assert.equal(readFileSync(journalPath, "utf8"), bytes, name);
  }
});

test("reconnect fails closed when the configured connector does not exist or restart fails", async () => {
  const current = fixture();
  const setup = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_missing1", "connect", { token: TOKEN }), proofOptions(setup.run));
  current.descriptor = reload(current);

  const missing = reconnectRequest(current, "cloudflare_reconnect_miss01");
  const failed = reconnectRequest(current, "cloudflare_reconnect_fail01");
  await assert.rejects(() => processOperation(current.descriptor, missing, proofOptions(runner(current).run)), { code: "cloudflare-reconnect-failed" });
  const failingDocker = runner(current, { stopped: true, connectorFailure: true });
  await assert.rejects(() => processOperation(current.descriptor, failed, proofOptions(failingDocker.run)), { code: "cloudflare-reconnect-failed" });
  const failedCalls = failingDocker.calls.length;
  await assert.rejects(() => processOperation(current.descriptor, failed, proofOptions(failingDocker.run)), { code: "cloudflare-reconnect-failed" });
  assert.equal(existsSync(resolve(current.controlRoot, `journal/${missing.id}.json`)), false);
  assert.equal(failingDocker.calls.length, failedCalls);
  assert.equal(JSON.parse(readFileSync(resolve(current.controlRoot, `journal/${failed.id}.json`), "utf8")).phase, "rolled-back");
});

test("reconnect restarts only the enabled local compose connector", async () => {
  const current = fixture({ nativeCloudflare: true });
  current.descriptor.compose.profiles = ["tunnel"];
  const docker = runner(current, { localRunning: true });

  const result = await processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_local1"), proofOptions(docker.run));

  assert.equal(result.phase, "connector-reconnected");
  assert.equal(docker.calls.some((call) => call.args.includes("restart") && call.args.at(-1) === "cloudflared"), true);
  assert.equal(docker.calls.some((call) => call.args.includes("up") || call.args.at(-1) === "remote-agent-console"), false);
});

test("native reconnect restarts only a distinct configured cloudflared unit", async () => {
  const current = fixture({ kind: "systemd", nativeCloudflare: true });
  const calls = [];
  let invocation = "a".repeat(32);
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    // expose one changing systemd invocation identity
    if (args.includes("--property=InvocationID")) return { code: 0, stdout: Buffer.from(invocation), stderr: Buffer.alloc(0) };
    // change only the exact restarted connector identity
    if (args.includes("restart")) invocation = "b".repeat(32);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  const result = await processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_native"), { runner: run });

  assert.equal(result.phase, "connector-reconnected");
  assert.equal(calls.some((call) => call.command === "systemctl" && call.args.includes("restart") && call.args.at(-1) === "cloudflared.service"), true);
  assert.equal(calls.some((call) => call.args.includes("restart") && call.args.at(-1) === current.descriptor.native.unit), false);
  current.descriptor.native.cloudflaredUnit = current.descriptor.native.unit;
  await assert.rejects(() => processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_same01"), { runner: run }), { code: "cloudflare-reconnect-unavailable" });
});

test("reconnect request validation rejects expanded authority", () => {
  const current = fixture();
  const requests = [
    { ...reconnectRequest(current, "cloudflare_reconnect_schema1"), cloudflare: { action: "reconnect", candidate: "cloudflare-connect" } },
    { ...reconnectRequest(current, "cloudflare_reconnect_schema2"), sources: [] },
    { ...reconnectRequest(current, "cloudflare_reconnect_schema3"), targets: ["cloudflared"] }
  ];
  // reject every added selector independently
  for (const invalid of requests) {
    const path = resolve(current.controlRoot, "queued", `${invalid.id}.json`);
    atomicWriteFile(path, `${JSON.stringify(invalid)}\n`, 0o600);
    assert.throws(() => readRequest(path, current.descriptor), { code: "invalid-request" });
  }
});

test("reconnect rejects an unconfigured compose selector without commands", async () => {
  const current = fixture();
  const docker = runner(current);

  await assert.rejects(() => processOperation(current.descriptor, reconnectRequest(current, "cloudflare_reconnect_none01"), proofOptions(docker.run)), { code: "cloudflare-reconnect-unavailable" });
  assert.equal(docker.calls.length, 0);
});

test("queue validation rejects expanded source authority and publishes redacted status", async () => {
  const current = fixture();
  const docker = runner(current);
  const id = "cloudflare_queued_00001";
  const valid = request(current, id, "connect", { token: TOKEN });
  const claimed = resolve(current.controlRoot, "claimed", `${id}.json`);
  atomicWriteFile(claimed, `${JSON.stringify(valid)}\n`, 0o600);
  await processClaim(claimed, current.descriptor, proofOptions(docker.run));
  const status = JSON.parse(readFileSync(resolve(current.controlRoot, "status", `${id}.json`), "utf8"));
  assert.equal(status.state, "complete");
  assert.equal(status.cloudflare.mode, "token");
  assert.equal(JSON.stringify(status).includes(TOKEN), false);

  const invalidId = "cloudflare_invalid_0001";
  const invalid = request(current, invalidId, "connect", { token: TOKEN });
  invalid.sources.push({ id: "env", existed: true, contentHash: sha256(Buffer.alloc(0)) });
  const invalidPath = resolve(current.controlRoot, "queued", `${invalidId}.json`);
  atomicWriteFile(invalidPath, `${JSON.stringify(invalid)}\n`, 0o600);
  assert.throws(() => readRequest(invalidPath, reload(current)), { code: "invalid-request" });
});

test("connector start failure restores token and profile state without touching legacy service", async () => {
  const current = fixture();
  const docker = runner(current, { connectorFailure: true });
  const descriptorBefore = readFileSync(current.descriptorPath);
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_start_fail01", "connect", { token: TOKEN }), proofOptions(docker.run)), { code: "cloudflare-connector-start-failed" });
  assert.equal(existsSync(resolve(current.root, "config/cloudflared.token")), false);
  assert.deepEqual(readFileSync(current.descriptorPath), descriptorBefore);
  assert.equal(docker.calls.some((call) => call.args.at(-1) === "cloudflared" && (call.args.includes("up") || call.args.includes("stop"))), false);
});

test("connector setup fails closed when predecessor process state is unavailable", async () => {
  const current = fixture();
  const docker = runner(current, { psFailure: true });
  const descriptorBefore = readFileSync(current.descriptorPath);
  await assert.rejects(() => processOperation(current.descriptor, request(current, "cloudflare_ps_failure001", "connect", { token: TOKEN }), proofOptions(docker.run)), { code: "cloudflare-connector-status-unavailable" });
  assert.equal(existsSync(resolve(current.root, "config/cloudflared.token")), false);
  assert.deepEqual(readFileSync(current.descriptorPath), descriptorBefore);
  assert.equal(docker.calls.some((call) => call.args.includes("up") || call.args.includes("stop")), false);
});

test("activation rejects private DNS before local or public health requests", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_0005", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const before = readFileSync(current.app);
  const blocked = [
    { address: "127.0.0.1", family: 4 },
    { address: "::7f00:1", family: 6 },
    { address: "64:ff9b:1::7f00:1", family: 6 },
    { address: "fec0::1", family: 6 },
    { address: "2002:7f00:1::", family: 6 },
    { address: "2001:0:4136:e378:8000:63bf:3fff:fdd2", family: 6 },
    { address: "3ffe::1", family: 6 }
  ];
  // reject every local-use or embedded transition destination
  for (const [index, record] of blocked.entries()) {
    await assert.rejects(() => processOperation(current.descriptor, request(current, `cloudflare_private_dns_${index}`, "activate", { hostname: "agents.example.com" }), proofOptions(docker.run, {
      resolveHostname: async () => [record]
    })), { code: "cloudflare-private-address" });
  }
  assert.deepEqual(readFileSync(current.app), before);
});

test("public health proof enforces an absolute deadline against slow-drip responses", async () => {
  let interval;
  let pinnedAddresses;
  const requester = (options, receive) => {
    // exercise the deployed node address-list lookup form
    options.lookup("agents.example.com", { all: true }, (_error, addresses) => { pinnedAddresses = addresses; });
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.statusCode = 200;
    request.end = () => {
      receive(response);
      // keep the socket active without ever completing a bounded response
      interval = setInterval(() => response.emit("data", Buffer.from(" ")), 2);
    };
    request.destroy = () => {
      clearInterval(interval);
      response.emit("aborted");
    };
    return request;
  };
  const started = Date.now();
  await assert.rejects(() => publicHealthProof("agents.example.com", { address: "8.8.8.8", family: 4 }, "a".repeat(64), {
    httpsRequest: requester,
    cloudflareHttpsTimeoutMs: 20
  }), { code: "cloudflare-health-proof-failed" });
  assert.ok(Date.now() - started < 250);
  assert.deepEqual(pinnedAddresses, [{ address: "8.8.8.8", family: 4 }]);
  clearInterval(interval);
});

test("stale application CAS fails before connector mutation", async () => {
  const current = fixture();
  const docker = runner(current);
  const operation = request(current, "cloudflare_stale_app001", "connect", { token: TOKEN });
  atomicWriteFile(current.app, `${JSON.stringify({ publicOrigin: "https://changed.example.com", listen: { host: "127.0.0.1", port: 8787 } })}\n`, 0o600);
  await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(docker.run)), { code: "source-conflict" });
  assert.equal(docker.calls.some((call) => call.args.includes("up") || call.args.includes("stop")), false);
  assert.equal(existsSync(resolve(current.root, "config/cloudflared.token")), false);
});

test("activation rechecks application CAS after the public health proof", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_race1", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const operation = request(current, "cloudflare_activate_race1", "activate", { hostname: "agents.example.com" });
  await assert.rejects(() => processOperation(current.descriptor, operation, proofOptions(docker.run, {
    cloudflareHealthProof: async () => {
      atomicWriteFile(current.app, `${JSON.stringify({ publicOrigin: "https://manual.example.com", listen: { host: "127.0.0.1", port: 8787 } })}\n`, 0o600);
      return true;
    }
  })), { code: "source-conflict" });
  assert.equal(JSON.parse(readFileSync(current.app, "utf8")).publicOrigin, "https://manual.example.com");
  assert.equal(docker.calls.some((call) => call.args.includes("up") && call.args.at(-1) === "remote-agent-console"), false);
});

test("managed token mode fails closed before a checkout handover can strand its credential", async () => {
  const current = fixture();
  const docker = runner(current);
  await processOperation(current.descriptor, request(current, "cloudflare_connect_move1", "connect", { token: TOKEN }), proofOptions(docker.run));
  current.descriptor = reload(current);
  const target = resolve(current.root, "next-checkout");
  mkdirSync(target, { mode: 0o700 });
  const authored = JSON.parse(readFileSync(current.installation, "utf8"));
  authored.host.checkout = target;
  atomicWriteFile(current.installation, `${JSON.stringify(authored, null, 2)}\n`, 0o600);
  await assert.rejects(() => deriveDesiredDescriptor(current.descriptor, { runner: docker.run }), { code: "cloudflare-token-checkout-handover-unsupported" });
});

test("status prefers the effective boot listener for copyable route instructions", async () => {
  const current = fixture();
  atomicWriteFile(resolve(current.controlRoot, "boot.json"), `${JSON.stringify({ version: 1, generation: 1, listen: { host: "127.0.0.1", port: 9443 } })}\n`, 0o600);
  const docker = runner(current);
  const result = await processOperation(current.descriptor, { version: 1, id: "cloudflare_boot_status01", kind: "cloudflare", generation: 1, cloudflare: { action: "status" } }, proofOptions(docker.run));
  assert.equal(result.cloudflare.serviceUrl, "http://127.0.0.1:9443");
});
