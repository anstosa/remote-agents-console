import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  prepareComposeDependencyInputs,
  preflightComposeDependencyGraph,
  projectComposeDependencies,
  verifyComposeDependencies
} from "./dependencies.mjs";
import { validateComposeCandidates, validateComposeModel } from "./validate.mjs";

// create one isolated dependency graph fixture
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rac-compose-dependencies-"));
  const stage = resolve(root, "stage");
  mkdirSync(stage, { mode: 0o700 });
  const paths = {
    compose: resolve(root, "compose.yaml"),
    env: resolve(root, ".env"),
    config: resolve(root, "service.conf"),
    secret: resolve(root, "service.secret"),
    credential: resolve(root, "credential.json")
  };
  writeFileSync(paths.compose, "services: {}\n", { mode: 0o600 });
  writeFileSync(paths.env, "VALUE=live\n", { mode: 0o600 });
  writeFileSync(paths.config, "config-live\n", { mode: 0o600 });
  writeFileSync(paths.secret, "secret-live\n", { mode: 0o600 });
  writeFileSync(paths.credential, "credential-live\n", { mode: 0o600 });
  const descriptor = {
    version: 1,
    allowedRoots: [root],
    hostCheckout: root,
    hostControlRoot: root,
    sources: {
      compose: { path: paths.compose, kind: "compose", apply: "rac-restart" },
      env: { path: paths.env, kind: "env", apply: "rac-restart" }
    },
    compose: {
      projectDirectory: root,
      projectName: "dependency-test",
      files: [paths.compose],
      envFiles: [paths.env],
      profiles: [],
      options: {}
    }
  };
  return { root, stage, paths, descriptor };
}

// render the fixed RAC invariants plus optional dependency nodes
function composeModel(current, dependencies = true) {
  const service = {
    healthcheck: { test: ["CMD", "true"] },
    environment: {
      RAC_CONFIG: "/workspace/config.json",
      RAC_CONFIG_WRITE_PATH: "/workspace/config.json",
      RAC_PASSWORD_HASH: "$argon2id$fixture",
      RAC_SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    },
    volumes: [
      { source: current.root, target: "/workspace", read_only: false },
      { source: current.root, target: "/run/rac-settings-control", read_only: false }
    ]
  };
  // omit optional dependency nodes
  if (!dependencies) {
    return { services: { "remote-agent-console": service } };
  }
  service.env_file = [current.paths.env];
  service.credential_spec = { file: current.paths.credential };
  return {
    services: { "remote-agent-console": service },
    configs: { app: { file: current.paths.config } },
    secrets: { app: { file: current.paths.secret } }
  };
}

// remove every temporary fixture after a test
function cleanup(current) {
  rmSync(current.root, { recursive: true, force: true });
}

test("stages direct and normalized dependencies then detects drift", () => {
  const current = fixture();
  try {
    const candidateEnv = resolve(current.stage, "candidate.env");
    writeFileSync(candidateEnv, "VALUE=candidate\n", { mode: 0o600 });
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map([["env", candidateEnv]]), current.stage);
    assert.notEqual(prepared.baselineFiles[0], current.paths.compose);
    assert.notEqual(prepared.candidateEnvFiles[0], candidateEnv);
    assert.equal(readFileSync(prepared.candidateEnvFiles[0], "utf8"), "VALUE=candidate\n");
    const baseline = composeModel(current);
    const candidate = structuredClone(baseline);
    const snapshot = projectComposeDependencies(prepared, baseline, candidate);
    assert.equal(statSync(resolve(current.stage, "compose-dependencies")).mode & 0o777, 0o700);
    assert.equal(statSync(resolve(current.stage, "compose-dependencies/snapshot.json")).mode & 0o777, 0o600);
    assert.notEqual(candidate.services["remote-agent-console"].env_file[0], current.paths.env);
    assert.equal(readFileSync(candidate.services["remote-agent-console"].env_file[0], "utf8"), "VALUE=candidate\n");
    assert.equal(readFileSync(candidate.configs.app.file, "utf8"), "config-live\n");
    assert.equal(readFileSync(candidate.secrets.app.file, "utf8"), "secret-live\n");
    assert.equal(readFileSync(candidate.services["remote-agent-console"].credential_spec.file, "utf8"), "credential-live\n");
    verifyComposeDependencies(snapshot, current.descriptor);
    writeFileSync(current.paths.config, "changed\n", { mode: 0o600 });
    assert.throws(() => verifyComposeDependencies(snapshot, current.descriptor), { code: "compose-dependency-conflict" });
  } finally {
    cleanup(current);
  }
});

test("rejects a newly introduced dependency without an installed source identity", () => {
  const current = fixture();
  try {
    const unapproved = resolve(current.root, "new.env");
    writeFileSync(unapproved, "NEW=value\n", { mode: 0o600 });
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage);
    const baseline = composeModel(current, false);
    const candidate = composeModel(current, false);
    candidate.services["remote-agent-console"].env_file = [unapproved];
    assert.throws(() => projectComposeDependencies(prepared, baseline, candidate), { code: "unmapped-compose-dependency" });
  } finally {
    cleanup(current);
  }
});

test("rejects duplicate installed source identities", () => {
  const current = fixture();
  try {
    current.descriptor.sources.duplicate = { path: current.paths.env, kind: "env", apply: "rac-restart" };
    assert.throws(
      () => prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage),
      { code: "ambiguous-compose-dependency" }
    );
  } finally {
    cleanup(current);
  }
});

test("resolves explicit Compose dependency interpolation without persisting values", () => {
  const current = fixture();
  try {
    const variable = "RAC_SETTINGS_TEST_DEPENDENCY_PATH_4C36D8";
    writeFileSync(current.paths.env, `${variable}=${current.paths.config}\n`, { mode: 0o600 });
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage);
    const baseline = composeModel(current, false);
    baseline.services["remote-agent-console"].env_file = [`\${${variable}:?missing}`];
    const candidate = structuredClone(baseline);
    const snapshot = projectComposeDependencies(prepared, baseline, candidate);
    const projected = candidate.services["remote-agent-console"].env_file[0];
    assert.equal(readFileSync(projected, "utf8"), "config-live\n");
    assert.ok(!JSON.stringify(snapshot).includes("config-live"));
  } finally {
    cleanup(current);
  }
});

test("rejects an unset required dependency interpolation", () => {
  const current = fixture();
  try {
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage);
    const baseline = composeModel(current, false);
    baseline.services["remote-agent-console"].env_file = ["${RAC_SETTINGS_MISSING_DEPENDENCY:?required}"];
    const candidate = structuredClone(baseline);
    assert.throws(
      () => projectComposeDependencies(prepared, baseline, candidate),
      { code: "required-compose-dependency-unset" }
    );
  } finally {
    cleanup(current);
  }
});

test("resolves a Compose dependency default against the actual project directory", () => {
  const current = fixture();
  try {
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage);
    const baseline = composeModel(current, false);
    baseline.services["remote-agent-console"].env_file = ["${RAC_SETTINGS_MISSING_DEPENDENCY:-service.conf}"];
    const candidate = structuredClone(baseline);
    projectComposeDependencies(prepared, baseline, candidate);
    assert.equal(readFileSync(candidate.services["remote-agent-console"].env_file[0], "utf8"), "config-live\n");
  } finally {
    cleanup(current);
  }
});

test("projects normalized bind templates before the resolved Compose pass", () => {
  const current = fixture();
  try {
    const variable = "RAC_SETTINGS_TEST_CREDENTIAL_PATH_857A1E";
    writeFileSync(current.paths.env, `${variable}=${current.paths.credential}\n`, { mode: 0o600 });
    const prepared = prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage);
    const baseline = composeModel(current, false);
    const candidate = structuredClone(baseline);
    candidate.services.cloudflared = {
      volumes: [{
        type: "bind",
        source: resolve(current.root, `\${${variable}:-./credential.json}`),
        target: "/etc/cloudflared/credentials.json",
        read_only: true
      }]
    };
    projectComposeDependencies(prepared, baseline, candidate);
    assert.equal(candidate.services.cloudflared.volumes[0].source, current.paths.credential);
  } finally {
    cleanup(current);
  }
});

test("accepts Compose-rendered escaping for a valid Argon2id hash", () => {
  const current = fixture();
  try {
    const model = composeModel(current, false);
    model.services["remote-agent-console"].environment.RAC_PASSWORD_HASH = "$$argon2id$$fixture";
    validateComposeModel(model, current.descriptor);
  } finally {
    cleanup(current);
  }
});

test("fails closed on dependency graphs the normalized CLI cannot enumerate", () => {
  const current = fixture();
  try {
    writeFileSync(current.paths.compose, "include:\n  - compose.shared.yaml\nservices: {}\n", { mode: 0o600 });
    assert.throws(
      () => prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage),
      { code: "unsupported-compose-dependency" }
    );
    writeFileSync(current.paths.compose, '{"includ\\u0065":["compose.shared.yaml"],"services":{}}\n', { mode: 0o600 });
    assert.throws(
      () => prepareComposeDependencyInputs(current.descriptor, new Map(), current.stage),
      { code: "unsupported-compose-dependency" }
    );
  } finally {
    cleanup(current);
  }
});

test("preflights every unsupported installed graph key", () => {
  const current = fixture();
  try {
    // reject each graph reader before capability activation
    for (const key of ["include", "extends", "label_file"]) {
      writeFileSync(current.paths.compose, `${key}: graph-source\nservices: {}\n`, { mode: 0o600 });
      assert.throws(
        () => preflightComposeDependencyGraph([current.paths.compose]),
        { code: "unsupported-compose-dependency" }
      );
    }
    writeFileSync(current.paths.compose, "services: {}\n", { mode: 0o600 });
    preflightComposeDependencyGraph([current.paths.compose]);
  } finally {
    cleanup(current);
  }
});

test("validates candidate Compose through private baseline candidate and projection inputs", async () => {
  const current = fixture();
  try {
    const candidateCompose = resolve(current.stage, "candidate.yaml");
    writeFileSync(candidateCompose, "services:\n  remote-agent-console: {}\n", { mode: 0o600 });
    const calls = [];
    // emulate normalized Compose without touching the host engine
    const runner = async (_command, args) => {
      calls.push(args);
      // return private normalized JSON only for model passes
      if (args.includes("--format")) {
        return { code: 0, stdout: Buffer.from(JSON.stringify(composeModel(current, false))), stderr: Buffer.alloc(0) };
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const { dependencySnapshot } = await validateComposeCandidates(
      current.descriptor,
      new Map([["compose", candidateCompose]]),
      current.stage,
      runner
    );
    assert.equal(calls.length, 4);
    assert.ok(calls[0].includes("--no-interpolate"));
    assert.ok(calls[1].includes("--no-env-resolution"));
    assert.ok(calls[2].includes("--quiet"));
    assert.ok(calls[3].includes("--format"));
    assert.ok(!calls.flat().includes(current.paths.compose));
    assert.ok(!calls.flat().includes(current.paths.env));
    assert.ok(dependencySnapshot.dependencies.some((dependency) => dependency.kind === "compose-file"));
  } finally {
    cleanup(current);
  }
});

test("reports fixed shadows and interpolation-owned candidate env keys without values", async () => {
  const current = fixture();
  try {
    writeFileSync(current.paths.env, "RAC_CONFIG=/workspace/old.json\nRAC_NOTES_FILE=/workspace/old-notes.json\nESCAPED=old\nNESTED=old\n", { mode: 0o600 });
    const candidateEnv = resolve(current.stage, "candidate.env");
    writeFileSync(candidateEnv, "RAC_CONFIG=/workspace/new.json\nRAC_NOTES_FILE=/workspace/new-notes.json\nESCAPED=new\nNESTED=new\n", { mode: 0o600 });
    const unresolved = composeModel(current, false);
    unresolved.services["remote-agent-console"].environment.RAC_NOTES_FILE = "${RAC_NOTES_FILE}";
    unresolved.services["remote-agent-console"].environment.ESCAPED = "$$ESCAPED";
    unresolved.services["remote-agent-console"].environment.NESTED = "${OTHER:-${NESTED}}";
    unresolved.services["remote-agent-console"].environment.FUTURE_FIXED = "fixed";
    const resolved = composeModel(current, false);
    resolved.services["remote-agent-console"].environment.RAC_NOTES_FILE = "/workspace/new-notes.json";
    resolved.services["remote-agent-console"].environment.ESCAPED = "$ESCAPED";
    resolved.services["remote-agent-console"].environment.NESTED = "new";
    resolved.services["remote-agent-console"].environment.FUTURE_FIXED = "fixed";
    // emulate private unresolved and resolved Compose passes
    const runner = async (_command, args) => ({
      code: 0,
      stdout: args.includes("--format")
        ? Buffer.from(JSON.stringify(args.includes("--no-interpolate") ? unresolved : resolved))
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    });
    const proof = await validateComposeCandidates(
      current.descriptor,
      new Map([["env", candidateEnv]]),
      current.stage,
      runner
    );
    assert.deepEqual(proof.winningEnvironment.RAC_CONFIG, {
      candidatePresent: true,
      candidateChanged: true,
      candidateWins: false,
      explicitlyShadowed: true
    });
    assert.deepEqual(proof.winningEnvironment.RAC_NOTES_FILE, {
      candidatePresent: true,
      candidateChanged: true,
      candidateWins: true,
      explicitlyShadowed: false
    });
    assert.equal(proof.winningEnvironment.NESTED.candidateWins, true);
    assert.deepEqual(proof.shadowedEnvironmentKeys, [
      "ESCAPED",
      "FUTURE_FIXED",
      "RAC_CONFIG",
      "RAC_CONFIG_WRITE_PATH",
      "RAC_PASSWORD_HASH",
      "RAC_SESSION_SECRET"
    ]);
    assert.match(proof.environmentFileHashes.RAC_CONFIG, /^[0-9a-f]{64}$/u);
    assert.equal(proof.environmentFileHashes.FUTURE_FIXED, undefined);
    assert.equal(JSON.stringify(proof).includes("/workspace/new-notes.json"), false);
  } finally {
    cleanup(current);
  }
});

test("validates changed direct bind selectors against the derived candidate identity", async () => {
  const current = fixture();
  try {
    const candidateCompose = resolve(current.stage, "candidate.yaml");
    const nextConfig = resolve(current.root, "next-cloudflared.yml");
    const nextCredentials = resolve(current.root, "next-credentials.json");
    writeFileSync(candidateCompose, "services: {}\n", { mode: 0o600 });
    writeFileSync(nextConfig, "tunnel: next\n", { mode: 0o600 });
    writeFileSync(nextCredentials, "{}\n", { mode: 0o600 });
    current.descriptor.sources.cloudflared = { path: current.paths.config, kind: "cloudflared", apply: "cloudflared-recreate" };
    current.descriptor.sources["cloudflared-credentials"] = { path: current.paths.credential, kind: "credentials", apply: "cloudflared-recreate" };
    const baseline = composeModel(current, false);
    baseline.services.cloudflared = {
      volumes: [
        { type: "bind", source: current.paths.config, target: "/etc/cloudflared/config.yml", read_only: true },
        { type: "bind", source: current.paths.credential, target: "/etc/cloudflared/credentials.json", read_only: true }
      ]
    };
    const candidate = structuredClone(baseline);
    candidate.services.cloudflared.volumes[0].source = nextConfig;
    candidate.services.cloudflared.volumes[1].source = nextCredentials;
    let modelPass = 0;
    // return baseline then candidate normalized models and the candidate resolution
    const runner = async (_command, args) => {
      if (!args.includes("--format")) {
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const model = args.includes("--no-interpolate") && modelPass++ === 0 ? baseline : candidate;
      return { code: 0, stdout: Buffer.from(JSON.stringify(model)), stderr: Buffer.alloc(0) };
    };
    const validation = await validateComposeCandidates(
      current.descriptor,
      new Map([["compose", candidateCompose]]),
      current.stage,
      runner
    );
    assert.equal(validation.composeSelectors.cloudflared.path, nextConfig);
    assert.equal(validation.composeSelectors["cloudflared-credentials"].path, nextCredentials);
  } finally {
    cleanup(current);
  }
});
