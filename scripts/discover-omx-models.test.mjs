import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { discoverCodexModels, discoverNativeModels, discoverOmxModels, normalizeCodexContextArgs, normalizeOmxContextArgs, proveOmxPackage, readDiscoveryRequest, resolveCodexProgram } from "./discover-omx-models.mjs";

const script = resolve("scripts/discover-omx-models.mjs");

// create one isolated supported wrapper and protocol process
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "rac-omx-discovery-"));
  const packageRoot = join(root, "node_modules/oh-my-codex");
  const entry = join(packageRoot, "dist/cli/omx.js");
  const bin = join(root, "bin");
  const cwd = join(root, "repo");
  await mkdir(dirname(entry), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: options.name ?? "oh-my-codex", version: options.version ?? "0.21.46", type: "module", bin: { omx: "dist/cli/omx.js" } }));
  await writeFile(entry, "#!/usr/bin/env node\n");
  await writeFile(join(packageRoot, "dist/cli/codex-home.js"), `import { readFileSync } from "node:fs"; import { dirname, join } from "node:path";
export function resolveCodexHomeForLaunch(cwd, env) { if (env.CODEX_HOME?.trim()) return env.CODEX_HOME; let current = cwd; while (true) { try { const value = JSON.parse(readFileSync(join(current, ".omx/setup-scope.json"), "utf8")); return value.scope === "project" ? join(current, ".codex") : undefined; } catch {} const parent = dirname(current); if (parent === current) return undefined; current = parent; } }\n`);
  const codex = join(bin, "codex");
  await writeFile(codex, `#!${process.execPath}
if (process.env.SPAWN_SENTINEL) require("node:fs").writeFileSync(process.env.SPAWN_SENTINEL, "spawned");
const args = process.argv.slice(2);
if (process.env.HANG_HELP === "1" && args.includes("--help")) setTimeout(() => {}, 60_000);
else if (args.includes("--help")) { process.stdout.write("--model MODEL --config KEY=VALUE\\n"); }
else if (process.env.FLOOD_STDOUT === "1") { process.stdout.write("native-secret".repeat(200_000)); setInterval(() => {}, 60_000); }
else if (process.env.MALFORMED_PROTOCOL === "1") { process.stdout.write("native-secret\\n"); setInterval(() => {}, 60_000); }
else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); if (message.id === undefined) continue; if (process.env.EARLY_EXIT === "1" && message.method === "initialize") { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n", () => process.exit(0)); continue; } let result = {}; if (message.method === "config/read") result = { config: { model: "configured", observedProgram: process.argv[1], observedHome: process.env.HOME, observedPath: process.env.PATH, observedCodexHome: process.env.CODEX_HOME, observedAccount: process.env.ACCOUNT, observedMarker: process.env.MARKER, observedAdmin: process.env.RAC_OPENAI_ADMIN_KEY ?? "absent", observedApiIds: process.env.RAC_OPENAI_API_KEY_IDS ?? "absent", observedCwd: process.cwd(), observedArgs: args } }; if (message.method === "model/list") { const page = Number(message.params?.cursor ?? 0); const pages = Number(process.env.PAGE_COUNT ?? 1); result = { data: [{ model: "model-" + page, displayName: "Model " + page, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: page === 0 }], nextCursor: page + 1 < pages ? String(page + 1) : null }; } process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n"); } });
}
`);
  await chmod(codex, 0o700);
  const program = join(bin, "omx");
  await symlink(entry, program);
  return { root, packageRoot, program, codex, bin, cwd, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

// form one exact helper request
function request(fx, overrides = {}) {
  return { version: 1, program: fx.program, args: [], cwd: fx.cwd, home: join(fx.root, "home"), env: { PATH: fx.bin, MARKER: "expected" }, timeoutMs: 5_000, ...overrides };
}

// run the public CLI and capture only its bounded contract
async function cli(requestPath, extraEnv = {}) {
  return await new Promise((resolveCli, reject) => {
    const child = spawn(process.execPath, [script, "--request", requestPath], { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolveCli({ code, stdout, stderr }));
  });
}

test("normalizes supported OMX context without forwarding launch policy or prompts", () => {
  assert.deepEqual(normalizeOmxContextArgs(["--madmax", "-c", "check_for_update_on_startup=false"]), ["-c", "check_for_update_on_startup=false"]);
  assert.deepEqual(normalizeOmxContextArgs(["--direct", "--madmax", "-c", "model_reasoning_effort=low", "--high", "--xhigh", "--spark", "--profile", "work", "--model", "gpt", "--", "--unknown-after-delimiter"]), ["-c", "model_reasoning_effort=low", "--profile", "work", "--model", "gpt", "-c", "model_reasoning_effort=\"xhigh\""]);
  assert.deepEqual(normalizeOmxContextArgs(["--madmax-spark", "--yolo", "--search", "--no-alt-screen", "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval=never", "--enable=feature", "--disable", "other", "--strict-config", "ignored prompt"]), ["--enable=feature", "--disable", "other", "--strict-config"]);
  assert.throws(() => normalizeOmxContextArgs(["--ultra"]), error => error.code === "omx_unproven");
  assert.throws(() => normalizeOmxContextArgs(["--unknown"]), error => error.code === "omx_unproven");
  assert.throws(() => normalizeOmxContextArgs(["--worktree", "branch"]), error => error.code === "omx_unproven");
});

test("normalizes Codex context without accepting wrapper or context-changing flags", () => {
  assert.deepEqual(normalizeCodexContextArgs(["-c", "check_for_update_on_startup=false", "--no-daemon", "--dangerously-bypass-approvals-and-sandbox"]), ["-c", "check_for_update_on_startup=false"]);
  assert.deepEqual(normalizeCodexContextArgs(["--profile", "work", "--model=configured", "--enable", "hooks", "prompt"]), ["--profile", "work", "--model=configured", "--enable", "hooks"]);
  // reject wrapper and native context changes
  for (const args of [["--madmax"], ["--high"], ["--cd", "/other"], ["--oss"], ["--worktree"], ["--unknown"]]) assert.throws(() => normalizeCodexContextArgs(args), error => error.code === "omx_unproven");
});

test("proves OMX package identity and its minimum supported version", async () => {
  const supported = await fixture();
  const wrongVersion = await fixture({ version: "0.21.45" });
  const wrongName = await fixture({ name: "other" });
  try {
    assert.equal((await proveOmxPackage(supported.program)).root, supported.packageRoot);
    await assert.rejects(proveOmxPackage(wrongVersion.program), error => error.code === "omx_version_unsupported");
    await assert.rejects(proveOmxPackage(wrongName.program), error => error.code === "omx_unproven");
  } finally { await Promise.all([supported.cleanup(), wrongVersion.cleanup(), wrongName.cleanup()]); }
});

// retain model discovery after the audited wrapper update
test("discovers models and effort with OMX 0.21.48", async () => {
  const fx = await fixture({ version: "0.21.48" });
  try {
    assert.equal((await proveOmxPackage(fx.program)).root, fx.packageRoot);
    const result = await discoverOmxModels(request(fx, { args: ["--madmax", "--xhigh"] }), {});
    assert.deepEqual(result.capabilities, { model: true, effort: true });
    assert.deepEqual(result.args, ["-c", "model_reasoning_effort=\"xhigh\""]);
    assert.equal(result.pages[0].data[0].model, "model-0");
    assert.equal(result.config.config.observedHome, join(fx.root, "home"));
  } finally { await fx.cleanup(); }
});

// prove model discovery for the currently installed audited wrapper
test("discovers models and effort with OMX 0.22.6", async () => {
  const fx = await fixture({ version: "0.22.6" });
  try {
    assert.equal((await proveOmxPackage(fx.program)).root, fx.packageRoot);
    const result = await discoverOmxModels(request(fx, { args: ["--madmax", "-c", "check_for_update_on_startup=false"] }), {});
    assert.deepEqual(result.capabilities, { model: true, effort: true });
    assert.deepEqual(result.args, ["-c", "check_for_update_on_startup=false"]);
    assert.equal(result.pages[0].data[0].model, "model-0");
    assert.equal(result.config.config.observedHome, join(fx.root, "home"));
    assert.equal(result.config.config.observedCwd, await realpath(fx.cwd));
  } finally { await fx.cleanup(); }
});

// accept newer patch, minor, major, and prerelease versions without an allowlist
for (const version of ["0.21.47", "0.21.100", "0.22.7", "0.22.10", "0.30.0", "1.0.0", "20.0.0", "0.22.0-rc.1", "0.21.46+build.2", "v0.22.6"]) {
  // prove version acceptance without repeating native discovery
  test(`proves OMX ${version} at or above the minimum`, async () => {
    const fx = await fixture({ version });
    try {
      assert.equal((await proveOmxPackage(fx.program)).root, fx.packageRoot);
    } finally { await fx.cleanup(); }
  });
}

// reject only releases below the stable minimum or malformed version labels
for (const version of ["0.21.45", "0.20.99", "0.21.46-rc.1", "0.21.46\n", "unknown", "0.22", "0.22.7.1", "01.22.6", "0.22.7-01", "0.22.7+", ""]) {
  // stop invalid version proof before any native executable runs
  test(`rejects unsupported OMX version ${JSON.stringify(version)} before discovery`, async () => {
    const fx = await fixture({ version });
    const sentinel = join(fx.root, "spawned");
    try {
      await assert.rejects(discoverOmxModels(request(fx, { env: { PATH: fx.bin, SPAWN_SENTINEL: sentinel } }), {}), error => error.code === "omx_version_unsupported");
      await assert.rejects(access(sentinel), error => error.code === "ENOENT");
    } finally { await fx.cleanup(); }
  });
}

test("resolves the first literal executable on the effective PATH", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.cwd, "codex"), `#!${process.execPath}\n`);
    await chmod(join(fx.cwd, "codex"), 0o700);
    assert.equal(await resolveCodexProgram(`:${fx.bin}`, fx.cwd), await realpath(join(fx.cwd, "codex")));
  } finally { await fx.cleanup(); }
});

test("uses the physical cwd for scope, relative PATH and metadata", async () => {
  const fx = await fixture();
  try {
    const logicalParent = join(fx.root, "logical/deep");
    const logicalCwd = join(logicalParent, "repo-link");
    await mkdir(logicalParent, { recursive: true });
    await mkdir(join(fx.root, "logical/.omx"), { recursive: true });
    await writeFile(join(fx.root, "logical/.omx/setup-scope.json"), JSON.stringify({ scope: "project" }));
    await symlink(fx.cwd, logicalCwd, "dir");
    const result = await discoverOmxModels(request(fx, { cwd: logicalCwd, env: { PATH: "../bin", MARKER: "physical" } }), {});
    assert.equal(result.config.config.observedCwd, await realpath(fx.cwd));
    assert.equal(result.config.config.observedMarker, "physical");
  } finally { await fx.cleanup(); }
});

test("discovers Codex through only the exact configured account and executable", async () => {
  const fx = await fixture();
  try {
    const sibling = join(fx.root, "sibling-bin");
    const sentinel = join(fx.root, "sibling-used");
    const account = join(fx.root, "codex-account");
    await mkdir(sibling);
    await mkdir(join(fx.cwd, ".omx"));
    await writeFile(join(fx.cwd, ".omx/setup-scope.json"), JSON.stringify({ scope: "project" }));
    await writeFile(join(sibling, "codex"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "used");\n`);
    await chmod(join(sibling, "codex"), 0o700);
    const result = await discoverCodexModels(request(fx, {
      kind: "codex",
      program: fx.codex,
      args: ["-c", "check_for_update_on_startup=false", "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "--profile", "work", "--model", "configured"],
      home: join(fx.root, "fallback-home"),
      env: { PATH: sibling, HOME: account, ACCOUNT: "codex-account", MARKER: "codex-only" }
    }), { RAC_OPENAI_ADMIN_KEY: "admin-secret", RAC_OPENAI_API_KEY_IDS: "ids-secret" });
    assert.deepEqual(result.args, ["-c", "check_for_update_on_startup=false", "--profile", "work", "--model", "configured"]);
    assert.deepEqual(result.capabilities, { model: true, effort: true });
    assert.equal(result.config.config.observedProgram, fx.codex);
    assert.equal(result.config.config.observedHome, account);
    assert.equal(result.config.config.observedPath, sibling);
    assert.equal(result.config.config.observedAccount, "codex-account");
    assert.equal(result.config.config.observedMarker, "codex-only");
    assert.equal(result.config.config.observedAdmin, "absent");
    assert.equal(result.config.config.observedApiIds, "absent");
    assert.equal(Object.hasOwn(result.config.config, "observedCodexHome"), false);
    assert.deepEqual(result.pages[0].data[0], { model: "model-0", displayName: "Model 0", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true });
    await assert.rejects(access(sentinel), error => error.code === "ENOENT");
  } finally { await fx.cleanup(); }
});

test("discovers paginated metadata in the exact HOME, cwd, environment and context", async () => {
  const fx = await fixture();
  try {
    const result = await discoverOmxModels(request(fx, { args: ["--madmax", "-c", "check_for_update_on_startup=false", "--profile", "work", "--high"], env: { PATH: fx.bin, MARKER: "expected", PAGE_COUNT: "3" } }), { OUTSIDE_SECRET: "never-return-this", RAC_OPENAI_ADMIN_KEY: "admin-secret", RAC_OPENAI_API_KEY_IDS: "ids-secret" });
    assert.deepEqual(result.capabilities, { model: true, effort: true });
    assert.equal(result.pages.length, 3);
    assert.deepEqual(result.pages.map(page => page.data[0].model), ["model-0", "model-1", "model-2"]);
    assert.deepEqual(result.args, ["-c", "check_for_update_on_startup=false", "--profile", "work", "-c", "model_reasoning_effort=\"high\""]);
    assert.deepEqual(result.config.config, {
      model: "configured",
      observedProgram: fx.codex,
      observedHome: join(fx.root, "home"),
      observedPath: fx.bin,
      observedMarker: "expected",
      observedAdmin: "absent",
      observedApiIds: "absent",
      observedCwd: fx.cwd,
      observedArgs: [...result.args, "app-server", "--listen", "stdio://"]
    });
    assert.doesNotMatch(JSON.stringify(result), /never-return-this/u);
  } finally { await fx.cleanup(); }
});

test("rejects unproven context flags before spawning Codex", async () => {
  const fx = await fixture();
  try {
    const cases = [["--cd", join(fx.root, "other")], ["--oss"], ["--local-provider", "ollama"], ["--worktree", "branch"], ["--unknown"]];
    // prove every rejected context leaves the native sentinel absent
    for (let index = 0; index < cases.length; index += 1) {
      const sentinel = join(fx.root, `spawned-${index}`);
      await assert.rejects(discoverOmxModels(request(fx, { args: cases[index], env: { PATH: fx.bin, SPAWN_SENTINEL: sentinel } }), {}), error => error.code === "omx_unproven");
      await assert.rejects(access(sentinel), error => error.code === "ENOENT");
    }
  } finally { await fx.cleanup(); }
});

test("accepts explicit CODEX_HOME and refuses project-scoped ephemeral state", async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.cwd, ".omx"));
    await writeFile(join(fx.cwd, ".omx/setup-scope.json"), JSON.stringify({ scope: "project" }));
    await assert.rejects(discoverOmxModels(request(fx), {}), error => error.code === "omx_project_scope_unsupported");
    const home = join(fx.root, "explicit-codex-home");
    const result = await discoverOmxModels(request(fx, { env: { PATH: fx.bin, CODEX_HOME: home } }), {});
    assert.equal(result.config.config.observedCodexHome, home);
    await writeFile(join(fx.cwd, ".omx/setup-scope.json"), "not-json");
    await assert.rejects(discoverOmxModels(request(fx), {}), error => error.code === "omx_unproven");
  } finally { await fx.cleanup(); }
});

test("bounds private requests and emits only fixed CLI failures", async () => {
  const fx = await fixture({ version: "0.21.45" });
  try {
    const path = join(fx.root, "request.json");
    await writeFile(path, JSON.stringify(request(fx, { env: { PATH: fx.bin, TOKEN: "do-not-print-this" } })), { mode: 0o600 });
    assert.deepEqual(await readDiscoveryRequest(path), request(fx, { env: { PATH: fx.bin, TOKEN: "do-not-print-this" } }));
    const result = await cli(path, { RAC_OPENAI_ADMIN_KEY: "admin-secret", RAC_OPENAI_API_KEY_IDS: "ids-secret" });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { version: 1, error: "omx_version_unsupported" });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-print-this/u);
    await assert.rejects(access(path), error => error.code === "ENOENT");
    await writeFile(path, JSON.stringify(request(fx)), { mode: 0o600 });
    await chmod(path, 0o644);
    await assert.rejects(readDiscoveryRequest(path), error => error.code === "invalid_request");
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify(request(fx, { kind: "other" })));
    await assert.rejects(readDiscoveryRequest(path), error => error.code === "invalid_request");
  } finally { await fx.cleanup(); }
});

test("sanitizes malformed configured Codex executables and protocol", async () => {
  const fx = await fixture();
  try {
    const malformed = join(fx.root, "malformed-codex");
    await writeFile(malformed, `#!${process.execPath}\nprocess.stdout.write("native-secret");\n`);
    await chmod(malformed, 0o700);
    const cases = [
      { program: malformed, env: { PATH: fx.bin }, error: "codex_capabilities_unproven" },
      { program: fx.codex, env: { PATH: fx.bin, MALFORMED_PROTOCOL: "1" }, error: "codex_protocol_invalid" }
    ];
    // require fixed failures without native payloads
    for (let index = 0; index < cases.length; index += 1) {
      const path = join(fx.root, `malformed-request-${index}.json`);
      const { error, ...overrides } = cases[index];
      await writeFile(path, JSON.stringify(request(fx, { kind: "codex", ...overrides })), { mode: 0o600 });
      const result = await cli(path);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { version: 1, error });
      assert.doesNotMatch(result.stdout, /native-secret/u);
    }
  } finally { await fx.cleanup(); }
});

test("sanitizes oversized output and early native exits for OMX and Codex", async () => {
  const fx = await fixture();
  try {
    const cases = [
      { kind: "omx", program: fx.program, native: { FLOOD_STDOUT: "1" } },
      { kind: "omx", program: fx.program, native: { EARLY_EXIT: "1" } },
      { kind: "codex", program: fx.codex, native: { FLOOD_STDOUT: "1" } },
      { kind: "codex", program: fx.codex, native: { EARLY_EXIT: "1" } }
    ];
    // require fixed failures for every hostile native exit
    for (let index = 0; index < cases.length; index += 1) {
      const path = join(fx.root, `request-${index}.json`);
      await writeFile(path, JSON.stringify(request(fx, { kind: cases[index].kind, program: cases[index].program, env: { PATH: fx.bin, ...cases[index].native } })), { mode: 0o600 });
      const started = Date.now();
      const result = await cli(path);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { version: 1, error: "codex_protocol_invalid" });
      assert.doesNotMatch(result.stdout, /native-secret/u);
      assert.ok(Date.now() - started < 3_000);
      await assert.rejects(access(path), error => error.code === "ENOENT");
    }
  } finally { await fx.cleanup(); }
});

test("kills a metadata probe at its global deadline", async () => {
  const fx = await fixture();
  try {
    const cases = [{ kind: "omx", program: fx.program }, { kind: "codex", program: fx.codex }];
    // enforce the same deadline for both native lanes
    for (const entry of cases) await assert.rejects(discoverNativeModels(request(fx, { ...entry, timeoutMs: 50, env: { PATH: fx.bin, HANG_HELP: "1" } }), {}), error => error.code === "discovery_timeout");
  } finally { await fx.cleanup(); }
});

test("rejects an expired queued request before spawning Codex", async () => {
  const fx = await fixture();
  try {
    const cases = [{ kind: "omx", program: fx.program }, { kind: "codex", program: fx.codex }];
    // reject both lanes before any native spawn
    for (let index = 0; index < cases.length; index += 1) {
      const sentinel = join(fx.root, `spawned-${index}`);
      await assert.rejects(discoverNativeModels(request(fx, { ...cases[index], expiresAt: Date.now() - 1, env: { PATH: fx.bin, SPAWN_SENTINEL: sentinel } }), {}), error => error.code === "discovery_timeout");
      await assert.rejects(access(sentinel), error => error.code === "ENOENT");
    }
  } finally { await fx.cleanup(); }
});
