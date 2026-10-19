import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { discoverComposeOptions, installSettingsApplier } from "./install.mjs";

const ENVIRONMENT_KEYS = [
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "COMPOSE_FILE",
  "COMPOSE_ENV_FILES",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_PARALLEL_LIMIT",
  "COMPOSE_COMPATIBILITY",
  "RAC_INSTALLATION_ID"
];

// preserve process settings around the isolated installer
function preserveEnvironment() {
  return Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
}

// restore every process setting exactly
function restoreEnvironment(saved) {
  // restore each isolated variable
  for (const key of ENVIRONMENT_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

test("Compose option discovery preserves unlimited parallelism", () => {
  const saved = preserveEnvironment();
  try {
    delete process.env.COMPOSE_PARALLEL_LIMIT;
    delete process.env.COMPOSE_COMPATIBILITY;
    assert.deepEqual(discoverComposeOptions({ COMPOSE_PARALLEL_LIMIT: "-1" }), { parallel: -1 });
    // reject every unsupported numeric shape
    for (const parallel of ["0", "-2", "1.5", "65"]) {
      assert.throws(() => discoverComposeOptions({ COMPOSE_PARALLEL_LIMIT: parallel }), /invalid-compose-parallel/);
    }
  } finally {
    restoreEnvironment(saved);
  }
});

test("installer refuses unsupported Compose graphs before publishing capability", async () => {
  const saved = preserveEnvironment();
  const root = mkdtempSync(resolve(tmpdir(), "rac-install-preflight-"));
  const repository = resolve(root, "repository");
  const state = resolve(root, "state");
  const userConfig = resolve(root, "user-config");
  const config = resolve(repository, "config");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const compose = resolve(repository, "compose.yaml");
  const override = resolve(repository, "compose.override.yaml");
  const originalOverride = "services:\n  remote-agent-console:\n    volumes: []\n";
  writeFileSync(resolve(repository, ".env"), "RAC_CONFIG=/workspace/config/app.json\n", { mode: 0o600 });
  writeFileSync(resolve(config, "app.json"), "{}\n", { mode: 0o600 });
  writeFileSync(compose, "include:\n  - compose.shared.yaml\nservices: {}\n", { mode: 0o600 });
  writeFileSync(override, originalOverride, { mode: 0o600 });
  process.env.XDG_STATE_HOME = state;
  process.env.XDG_CONFIG_HOME = userConfig;
  // clear host Compose selectors
  for (const key of ENVIRONMENT_KEYS.slice(2)) {
    delete process.env[key];
  }
  const calls = [];
  // emulate only fixed prerequisite and identity commands
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "loginctl") {
      return result("yes\n");
    }
    if (command === "docker" && args[0] === "compose" && args.includes("version")) {
      return result("Docker Compose version fixture\n");
    }
    if (command === "docker" && args[0] === "compose" && args.includes("ps")) {
      return result("0123456789abcdef0123456789abcdef\n");
    }
    if (command === "docker" && args[0] === "inspect") {
      const labels = {
        "com.docker.compose.project": "preflight-test",
        "com.docker.compose.project.working_dir": repository,
        "com.docker.compose.project.config_files": `${compose},${override}`
      };
      return result(`${JSON.stringify(labels)} ${process.pid}\n`);
    }
    return result("");
  };
  try {
    await assert.rejects(
      () => installSettingsApplier({
        repository,
        kind: "compose",
        installationId: "preflight-install-0001",
        runner
      }),
      { code: "unsupported-compose-dependency" }
    );
    const control = resolve(state, "remote-agent-console/installations/preflight-install-0001");
    assert.equal(existsSync(resolve(control, "installation.json")), false);
    assert.equal(existsSync(resolve(repository, "config/remote-agent-console.installation.json")), false);
    assert.equal(readFileSync(override, "utf8"), originalOverride);
    assert.equal(calls.some(({ command, args }) => command === "systemctl" && args.includes("enable")), false);
  } finally {
    restoreEnvironment(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer repair refuses unsupported graphs before promotion or activation", async () => {
  const saved = preserveEnvironment();
  const root = mkdtempSync(resolve(tmpdir(), "rac-repair-preflight-"));
  const repository = resolve(root, "repository");
  const state = resolve(root, "state");
  const userConfig = resolve(root, "user-config");
  const config = resolve(repository, "config");
  const icons = resolve(config, "instance-icons");
  mkdirSync(icons, { recursive: true, mode: 0o700 });
  const compose = resolve(repository, "compose.yaml");
  const env = resolve(repository, ".env");
  const app = resolve(config, "app.json");
  const heart = resolve(icons, "heart.svg");
  const installationId = "repair-preflight-0001";
  const control = resolve(state, "remote-agent-console/installations", installationId);
  const descriptorPath = resolve(control, "installation.json");
  writeFileSync(env, "RAC_CONFIG=/workspace/config/app.json\n", { mode: 0o600 });
  writeFileSync(app, "{}\n", { mode: 0o600 });
  writeFileSync(heart, "<svg/>\n", { mode: 0o600 });
  writeFileSync(compose, "services:\n  remote-agent-console:\n    extends:\n      file: compose.shared.yaml\n", { mode: 0o600 });
  mkdirSync(control, { recursive: true, mode: 0o700 });
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    installationId,
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: "compose",
    hostControlRoot: control,
    hostCheckout: repository,
    serverCheckout: "/workspace",
    allowedRoots: [repository],
    sources: {
      app: { path: app, serverPath: "/workspace/config/app.json", kind: "json", apply: "rac-restart" },
      env: { path: env, serverPath: "/workspace/.env", kind: "env", apply: "rac-restart" },
      compose: { path: compose, serverPath: "/workspace/compose.yaml", kind: "compose", apply: "rac-restart" },
      "icon-heart": { path: heart, serverPath: "/workspace/config/instance-icons/heart.svg", kind: "svg", apply: "rac-restart" }
    },
    compose: { projectDirectory: repository, projectName: "repair-preflight", files: [compose], envFiles: [env], profiles: [], options: {} }
  }, null, 2)}\n`, { mode: 0o600 });
  process.env.XDG_STATE_HOME = state;
  process.env.XDG_CONFIG_HOME = userConfig;
  const calls = [];
  // emulate only fixed prerequisite commands
  const runner = async (command, args) => {
    calls.push({ command, args });
    return result(command === "loginctl" ? "yes\n" : "");
  };
  try {
    await assert.rejects(
      () => installSettingsApplier({
        repository,
        kind: "compose",
        installationId,
        recoveryBinDirectory: resolve(root, "bin"),
        runner
      }),
      { code: "unsupported-compose-dependency" }
    );
    assert.equal(JSON.parse(readFileSync(descriptorPath, "utf8")).sources["icon-heart"].apply, "rac-restart");
    assert.equal(existsSync(resolve(root, "bin/rac-settings-recover")), false);
    assert.equal(calls.some(({ command, args }) => command === "systemctl" && args.includes("enable")), false);
  } finally {
    restoreEnvironment(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

// return one bounded fake command result
function result(stdout) {
  return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}
