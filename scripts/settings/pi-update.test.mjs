import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";
import { MAX_COMMAND_BYTES, MAX_SOURCE_BYTES } from "./constants.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { safeError } from "./fs.mjs";
import { loadDesiredDescriptor } from "./operations.mjs";
import { prepareHostPiRuntime } from "./pi-update.mjs";

const PREPARE_TIMEOUT_MS = 10 * 60_000;
const temporaryRoots = [];

// remove only fixture roots created by this test process
afterEach(() => {
  // keep cleanup independent of assertion success
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true });
});

// create one minimal preparation descriptor
function fixture(application = { adapters: { pi: {} } }, kind = "compose") {
  const root = mkdtempSync(resolve(tmpdir(), "rac-pi-update-"));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const app = resolve(root, "app.json");
  writeFileSync(app, `${JSON.stringify(application)}\n`, { mode: 0o600 });
  return {
    root,
    app,
    descriptor: {
      kind,
      hostCheckout: root,
      sources: { app: { path: app } },
      compose: {
        projectDirectory: root,
        projectName: "rac-test",
        files: [resolve(root, "compose.yaml")],
        envFiles: [resolve(root, ".env")],
        profiles: ["tunnel"],
        options: {}
      }
    }
  };
}

// return one successful bounded command result
function success(stdout = "") {
  return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

// skip native installations before reading app or Compose state
test("native installations skip host Pi preparation", async () => {
  const calls = [];
  const result = await prepareHostPiRuntime({ kind: "systemd", sources: { app: { path: "/missing" } } }, {
    // reject any unexpected subprocess
    runner: async (...args) => {
      calls.push(args);
      return success();
    }
  });
  assert.deepEqual(result, { prepared: false, reason: "native" });
  assert.deepEqual(calls, []);
});

// skip absent and malformed Pi adapter entries
test("unconfigured Pi installations skip host preparation", async () => {
  // cover every value that is not a configured object
  for (const application of [{}, { adapters: {} }, { adapters: { pi: null } }, { adapters: { pi: [] } }]) {
    const current = fixture(application);
    let calls = 0;
    const result = await prepareHostPiRuntime(current.descriptor, {
      // count forbidden render calls
      runner: async () => {
        calls += 1;
        return success();
      }
    });
    assert.deepEqual(result, { prepared: false, reason: "pi-disabled" });
    assert.equal(calls, 0);
  }
});

// skip Pi when the rendered Compose model has no host socket bridge
test("container-only Pi skips dependency preparation", async () => {
  const current = fixture();
  const calls = [];
  const result = await prepareHostPiRuntime(current.descriptor, {
    // return one object-shaped container environment
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return success(JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_PORT: "3000" } } } }));
    }
  });
  assert.deepEqual(result, { prepared: false, reason: "container-only" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(calls[0].args.slice(-3), ["config", "--format", "json"]);
  assert.deepEqual(calls[0].options, { cwd: current.root, maxBytes: MAX_COMMAND_BYTES, timeoutMs: 30_000 });
});

// install and build the exact bridged checkout in order
test("bridged Pi installs dependencies before building the server", async () => {
  const current = fixture();
  const calls = [];
  const result = await prepareHostPiRuntime(current.descriptor, {
    // record the fixed command sequence
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "docker"
        ? success(JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_HOST_TMUX_DIR: "/host-tmux" } } } }))
        : success();
    }
  });
  assert.deepEqual(result, { prepared: true });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["docker", [
      "compose",
      "--project-directory", current.root,
      "--project-name", "rac-test",
      "--env-file", resolve(current.root, ".env"),
      "--profile", "tunnel",
      "-f", resolve(current.root, "compose.yaml"),
      "config", "--format", "json"
    ]],
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["--filter", "@rac/server", "build"]]
  ]);
  assert.deepEqual(calls.slice(1).map(({ options }) => options), [
    { cwd: current.root, maxBytes: MAX_SOURCE_BYTES, timeoutMs: PREPARE_TIMEOUT_MS },
    { cwd: current.root, maxBytes: MAX_SOURCE_BYTES, timeoutMs: PREPARE_TIMEOUT_MS }
  ]);
});

// fail closed when Compose cannot prove an object-shaped environment
test("malformed or failed Compose rendering fails closed", async () => {
  const cases = [
    success("{"),
    success(JSON.stringify([])),
    success(JSON.stringify({ services: [] })),
    success(JSON.stringify({ services: {} })),
    success(JSON.stringify({ services: { "remote-agent-console": { environment: [] } } })),
    { code: 1, stdout: Buffer.from("private"), stderr: Buffer.from("secret") }
  ];
  // reject each unproven rendered model
  for (const rendered of cases) {
    const current = fixture();
    let calls = 0;
    await assert.rejects(() => prepareHostPiRuntime(current.descriptor, {
      // expose only the selected test result
      runner: async () => {
        calls += 1;
        return rendered;
      }
    }), (error) => {
      assert.equal(error.code, "pi-host-bridge-proof-failed");
      assert.deepEqual(Object.keys(error), ["code"]);
      return true;
    });
    assert.equal(calls, 1);
  }
});

// rendered Compose graphs share the authoritative deployment reader limit
test("rendered Compose graphs above the source-file limit still prepare safely", async () => {
  const current = fixture();
  const model = JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_HOST_TMUX_DIR: "/host-tmux" } } }, metadata: "x".repeat(MAX_SOURCE_BYTES + 1) });
  assert.ok(Buffer.byteLength(model) > MAX_SOURCE_BYTES);
  assert.ok(Buffer.byteLength(model) < MAX_COMMAND_BYTES);
  let renders = 0;
  const result = await prepareHostPiRuntime(current.descriptor, {
    // prove the effective render receives the same bounded capacity as deployment
    runner: async (command, _args, options) => {
      // supply a valid graph without running Docker or installing dependencies
      if (command === "docker") {
        renders += 1;
        assert.equal(options.maxBytes, MAX_COMMAND_BYTES);
        return success(model);
      }
      return success();
    }
  });
  assert.deepEqual(result, { prepared: true });
  assert.equal(renders, 1);
});

// preserve bounded runner failures without attempting installation
test("Compose render limits stop before host preparation", async () => {
  // cover output and duration limits from the bounded runner
  for (const code of ["command-output-too-large", "command-timeout"]) {
    const current = fixture();
    let calls = 0;
    await assert.rejects(() => prepareHostPiRuntime(current.descriptor, {
      // reject the initial rendered model command
      runner: async () => {
        calls += 1;
        throw safeError(code);
      }
    }), { code });
    assert.equal(calls, 1);
  }
});

// stop before build when install fails or times out
test("install failure prevents the server build", async () => {
  // cover nonzero and bounded-runner timeout failures
  for (const failure of [success(), safeError("command-timeout")]) {
    const current = fixture();
    const calls = [];
    await assert.rejects(() => prepareHostPiRuntime(current.descriptor, {
      // fail only the dependency installation
      runner: async (command, args) => {
        calls.push([command, args]);
        // allow the bridge proof
        if (command === "docker") {
          return success(JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_HOST_TMUX_DIR: "/host-tmux" } } } }));
        }
        // emulate a bounded timeout
        if (failure instanceof Error) {
          throw failure;
        }
        return { ...failure, code: 1 };
      }
    }), failure instanceof Error ? { code: "command-timeout" } : { code: "pi-host-dependency-install-failed" });
    assert.equal(calls.length, 2);
  }
});

// report a build-specific safe failure after installation succeeds
test("server build failure is reported safely", async () => {
  const current = fixture();
  const calls = [];
  await assert.rejects(() => prepareHostPiRuntime(current.descriptor, {
    // fail only the final build command
    runner: async (command, args) => {
      calls.push([command, args]);
      // allow the bridge proof
      if (command === "docker") {
        return success(JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_HOST_TMUX_DIR: "/host-tmux" } } } }));
      }
      return { ...success(), code: calls.length === 3 ? 1 : 0 };
    }
  }), { code: "pi-host-server-build-failed" });
  assert.equal(calls.length, 3);
});

// prepare from the pending descriptor selected by shared authority
test("desired descriptor selection prepares the validated pending graph", async () => {
  const current = validatedDescriptorFixture();
  const desiredApp = resolve(current.root, "desired-app.json");
  writeFileSync(desiredApp, '{"adapters":{"pi":{}}}\n', { mode: 0o600 });
  const desired = {
    ...current.authority,
    generation: 2,
    sources: {
      app: { path: desiredApp, serverPath: desiredApp, kind: "json", apply: "rac-restart" }
    }
  };
  writeFileSync(resolve(current.controlRoot, "desired-installation.json"), `${JSON.stringify(desired)}\n`, { mode: 0o600 });
  const selected = loadDesiredDescriptor(current.descriptor);
  assert.equal(selected.generation, 2);
  assert.equal(selected.sources.app.path, desiredApp);
  const calls = [];
  const result = await prepareHostPiRuntime(selected, {
    // prove that the desired Pi graph reaches host preparation
    runner: async (command, args) => {
      calls.push([command, args]);
      // return the required rendered bridge proof
      if (command === "docker") {
        return success(JSON.stringify({ services: { "remote-agent-console": { environment: { RAC_HOST_TMUX_DIR: "/host-tmux" } } } }));
      }
      return success();
    }
  });
  assert.deepEqual(result, { prepared: true });
  assert.deepEqual(calls.map(([command]) => command), ["docker", "pnpm", "pnpm"]);
});

// create one descriptor accepted by the shared loader
function validatedDescriptorFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rac-pi-desired-"));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const controlRoot = resolve(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  const app = resolve(root, "app.json");
  writeFileSync(app, "{}\n", { mode: 0o600 });
  const compose = resolve(root, "compose.yaml");
  const environment = resolve(root, ".env");
  writeFileSync(compose, "services: {}\n", { mode: 0o600 });
  writeFileSync(environment, "RAC_PORT=3000\n", { mode: 0o600 });
  const authority = {
    version: 1,
    installationId: "pi-update-test-0001",
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: "compose",
    hostControlRoot: controlRoot,
    hostCheckout: root,
    serverCheckout: root,
    allowedRoots: [root],
    sources: {
      app: { path: app, serverPath: app, kind: "json", apply: "rac-restart" }
    },
    compose: {
      projectDirectory: root,
      projectName: "rac-pi-desired",
      files: [compose],
      envFiles: [environment],
      profiles: [],
      options: {}
    }
  };
  const descriptorPath = resolve(controlRoot, "installation.json");
  writeFileSync(descriptorPath, `${JSON.stringify(authority)}\n`, { mode: 0o600 });
  return { root, controlRoot, authority, descriptor: validateDescriptor(authority, descriptorPath) };
}
