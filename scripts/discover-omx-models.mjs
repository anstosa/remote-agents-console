#!/usr/bin/env node
import { access, lstat, readFile, realpath, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// retain the oldest supported stable release without an upper version bound
const minimumOmxVersion = [0n, 21n, 46n];
const maxRequestBytes = 64 * 1024;
const maxProtocolLineBytes = 1024 * 1024;
const maxOutputBytes = 900 * 1024;
const maxProtocolSessionBytes = 2 * maxOutputBytes;
const maxPages = 10;
const maxModels = 500;
const safeErrors = new Set([
  "invalid_request",
  "omx_unproven",
  "omx_version_unsupported",
  "omx_project_scope_unsupported",
  "codex_unavailable",
  "codex_capabilities_unproven",
  "codex_protocol_invalid",
  "discovery_timeout"
]);

// create one fixed failure without retaining native diagnostics
function failure(code) {
  const error = new Error(code);
  error.code = safeErrors.has(code) ? code : "codex_protocol_invalid";
  return error;
}

// require one bounded private request file
export async function readDiscoveryRequest(path) {
  // require an absolute descriptor
  if (!isAbsolute(path)) throw failure("invalid_request");
  const identity = await lstat(path).catch(() => undefined);
  // reject unsafe descriptor identities
  if (identity === undefined || !identity.isFile() || identity.isSymbolicLink() || identity.size > maxRequestBytes || (identity.mode & 0o077) !== 0) throw failure("invalid_request");
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw failure("invalid_request"); }
  // reject malformed request fields
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || value.kind !== undefined && value.kind !== "omx" && value.kind !== "codex" || typeof value.program !== "string" || !isAbsolute(value.program) || value.program.length > 4096 || value.program.includes("\0") || !Array.isArray(value.args) || value.args.length > 128 || !value.args.every(arg => typeof arg === "string" && arg.length <= 8192 && !arg.includes("\0")) || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || value.cwd.length > 4096 || value.cwd.includes("\0") || value.home !== undefined && (typeof value.home !== "string" || !isAbsolute(value.home) || value.home.length > 4096 || value.home.includes("\0")) || value.env === null || typeof value.env !== "object" || Array.isArray(value.env) || Object.keys(value.env).length > 128 || !Object.entries(value.env).every(([key, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof entry === "string" && entry.length <= 32_768 && !entry.includes("\0")) || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 10_000 || value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) || Object.keys(value).some(key => !["version", "kind", "program", "args", "cwd", "home", "env", "timeoutMs", "expiresAt"].includes(key))) throw failure("invalid_request");
  return value;
}

// retain only proven metadata context arguments
function normalizeContextArgs(args, kind) {
  const context = [];
  let effort;
  const ignoredSwitches = new Set(["--yolo", "--full-auto", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--search", "--no-alt-screen", "--no-daemon"]);
  // accept audited OMX-only launch controls
  if (kind === "omx") for (const flag of ["--direct", "--tmux", "--madmax", "--spark", "--madmax-spark"]) ignoredSwitches.add(flag);
  const ignoredValues = new Set(["-s", "--sandbox", "-a", "--ask-for-approval", "--add-dir"]);
  // accept only proven launch flags before the native delimiter
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // stop before prompt arguments
    if (arg === "--") break;
    // reject context-changing flags
    if (arg === "--worktree" || arg === "-w" || arg.startsWith("--worktree=") || arg.startsWith("-w=") || arg.startsWith("-w") && arg.length > 2 || arg === "-C" || arg === "--cd" || arg.startsWith("-C") && arg.length > 2 || arg.startsWith("--cd=") || arg === "--oss" || arg === "--local-provider" || arg.startsWith("--local-provider=") || arg === "--remote" || arg.startsWith("--remote=") || arg === "--remote-auth-token-env" || arg.startsWith("--remote-auth-token-env=")) throw failure("omx_unproven");
    // discard launch-only switches
    if (ignoredSwitches.has(arg)) continue;
    // consume launch-only values
    if (ignoredValues.has(arg)) {
      const value = args[index + 1];
      // require one explicit value
      if (value === undefined || value.startsWith("-")) throw failure("omx_unproven");
      index += 1;
      continue;
    }
    // discard inline launch policy
    if (/^(?:-s=?(?:read-only|workspace-write|danger-full-access)|-a=?(?:on-request|never)|--sandbox=.+|--ask-for-approval=.+|--add-dir=.+)$/u.test(arg)) continue;
    // retain OMX effort shorthands only
    if (kind === "omx" && (arg === "--high" || arg === "--xhigh")) { effort = arg.slice(2); continue; }
    // reject unsupported effort aliases
    if (arg === "--max" || arg === "--ultra") throw failure("omx_unproven");
    // retain separated context values
    if (["-c", "--config", "-p", "--profile", "--enable", "--disable", "-m", "--model"].includes(arg)) {
      const value = args[index + 1];
      // require one explicit value
      if (value === undefined || value.startsWith("-")) throw failure("omx_unproven");
      context.push(arg, value);
      index += 1;
      continue;
    }
    // retain inline context values
    if (/^(?:-c.+|--config=.+|-p.+|--profile=.+|--enable=.+|--disable=.+|-m.+|--model=.+|--strict-config)$/u.test(arg)) { context.push(arg); continue; }
    // reject every unknown flag
    if (arg.startsWith("-")) throw failure("omx_unproven");
  }
  // the last shorthand overrides earlier explicit effort configuration
  if (effort !== undefined) context.push("-c", `model_reasoning_effort=\"${effort}\"`);
  return context;
}

// reproduce the supported OMX launch shorthands
export function normalizeOmxContextArgs(args) {
  return normalizeContextArgs(args, "omx");
}

// retain the configured Codex metadata context
export function normalizeCodexContextArgs(args) {
  return normalizeContextArgs(args, "codex");
}

// compare semantic release numbers against the stable compatibility floor
function meetsMinimumOmxVersion(version) {
  // reject malformed metadata without capping the supported release number
  if (typeof version !== "string" || version.length > 256) return false;
  const parts = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
  // require a complete semantic version
  if (parts === null) return false;
  // numeric prerelease identifiers cannot contain leading zeroes
  if (parts[4]?.split(".").some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) return false;
  // compare numeric components rather than lexicographic version strings
  for (let index = 0; index < minimumOmxVersion.length; index += 1) {
    const observed = BigInt(parts[index + 1]);
    // a higher core release remains newer even when it is a prerelease
    if (observed !== minimumOmxVersion[index]) return observed > minimumOmxVersion[index];
  }
  // an equal-core prerelease precedes the stable minimum; build metadata is irrelevant
  return parts[4] === undefined;
}

// prove the configured program is a supported OMX package
export async function proveOmxPackage(program) {
  const entry = await realpath(program).catch(() => undefined);
  // require the canonical entry suffix
  if (entry === undefined || !entry.endsWith("/dist/cli/omx.js")) throw failure("omx_unproven");
  const root = dirname(dirname(dirname(entry)));
  let metadata;
  try { metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { throw failure("omx_unproven"); }
  // require the exact package identity
  if (metadata?.name !== "oh-my-codex" || metadata?.type !== "module" || metadata?.bin?.omx !== "dist/cli/omx.js") throw failure("omx_unproven");
  // require the known minimum while accepting every newer release
  if (!meetsMinimumOmxVersion(metadata.version)) throw failure("omx_version_unsupported");
  const declared = await realpath(join(root, metadata.bin.omx)).catch(() => undefined);
  // require one canonical bin target
  if (declared !== entry) throw failure("omx_unproven");
  return { root, entry };
}

// resolve literal codex exactly as the supported OMX launcher does
export async function resolveCodexProgram(path, cwd = process.cwd()) {
  // scan path entries in order
  for (const directory of String(path ?? "").split(":")) {
    const candidate = resolve(cwd, directory || ".", "codex");
    try {
      const identity = await lstat(candidate);
      // skip non-executable identities
      if (!identity.isFile() && !identity.isSymbolicLink()) continue;
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch { /* try the next exact path entry */ }
  }
  throw failure("codex_unavailable");
}

// verify one exact configured Codex executable
async function configuredCodexProgram(program) {
  const identity = await lstat(program).catch(() => undefined);
  // require one file or symlink identity
  if (identity === undefined || !identity.isFile() && !identity.isSymbolicLink()) throw failure("codex_unavailable");
  try { await access(program, fsConstants.X_OK); } catch { throw failure("codex_unavailable"); }
  const target = await realpath(program).catch(() => undefined);
  const targetIdentity = target === undefined ? undefined : await lstat(target).catch(() => undefined);
  // require one executable file target
  if (targetIdentity === undefined || !targetIdentity.isFile()) throw failure("codex_unavailable");
  return program;
}

// reproduce nearest-marker scope resolution while distinguishing invalid markers
async function setupScope(cwd) {
  let current = resolve(cwd);
  // stop at the first marker exactly like the supported OMX resolver
  while (true) {
    const path = join(current, ".omx", "setup-scope.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      // reject invalid nearest markers
      if (value?.scope !== "user" && value?.scope !== "project") throw failure("omx_unproven");
      return value.scope;
    } catch (error) {
      // fail closed on present markers
      if (error?.code !== "ENOENT") {
        // preserve fixed probe errors
        if (safeErrors.has(error?.code)) throw error;
        throw failure("omx_unproven");
      }
    }
    const parent = dirname(current);
    // stop at the filesystem root
    if (parent === current) return undefined;
    current = parent;
  }
}

// run one bounded native help surface without publishing diagnostics
async function help(program, args, env, cwd, remaining) {
  return await new Promise((resolveHelp, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(failure("discovery_timeout")); }, Math.max(1, remaining()));
    timer.unref();
    // cap collected help output
    const collect = chunk => { if (output.length <= 256 * 1024) output += chunk.toString("utf8"); };
    // collect both help streams
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    // map spawn failures safely
    child.on("error", () => { clearTimeout(timer); reject(failure("codex_unavailable")); });
    // resolve bounded help text
    child.on("close", () => { clearTimeout(timer); resolveHelp(output.slice(0, 256 * 1024)); });
  });
}

// query only config and model metadata over the Codex JSONL protocol
async function queryCodex(program, contextArgs, env, cwd, remaining) {
  const child = spawn(program, [...contextArgs, "app-server", "--listen", "stdio://"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let nextId = 1;
  let protocolFailure;
  let buffer = "";
  let protocolBytes = 0;
  // stop the child and reject every pending request
  const abort = code => {
    if (protocolFailure === undefined) protocolFailure = failure(code);
    child.kill("SIGKILL");
    for (const waiter of pending.values()) waiter.reject(protocolFailure);
    pending.clear();
  };
  // resolve only bounded matching protocol responses
  const receive = line => {
    // reject oversized records
    if (Buffer.byteLength(line) > maxProtocolLineBytes) { abort("codex_protocol_invalid"); return; }
    let value;
    try { value = JSON.parse(line); } catch { abort("codex_protocol_invalid"); return; }
    const waiter = Number.isSafeInteger(value?.id) ? pending.get(value.id) : undefined;
    // ignore unrelated notifications
    if (waiter === undefined) return;
    pending.delete(value.id);
    // reject native protocol errors
    if (value.error !== undefined) waiter.reject(failure("codex_protocol_invalid"));
    else waiter.resolve(value.result);
  };
  child.stdout.setEncoding("utf8");
  // reject an unterminated oversized protocol record
  child.stdout.on("data", chunk => {
    protocolBytes += Buffer.byteLength(chunk);
    // bound the whole metadata session
    if (protocolBytes > maxProtocolSessionBytes) { abort("codex_protocol_invalid"); return; }
    buffer += chunk;
    let newline;
    // consume complete bounded records immediately
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      receive(line);
      // stop after protocol failure
      if (protocolFailure !== undefined) return;
    }
    // reject oversized partial records
    if (Buffer.byteLength(buffer) > maxProtocolLineBytes) abort("codex_protocol_invalid");
  });
  // send one correlated request
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    // reject requests after abort
    if (protocolFailure !== undefined) { reject(protocolFailure); return; }
    const id = nextId++;
    pending.set(id, { resolve: resolveRequest, reject });
    child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`, error => {
      // reject native write failures
      if (error) abort("codex_protocol_invalid");
    });
  });
  const timer = setTimeout(() => { abort("discovery_timeout"); }, Math.max(1, remaining()));
  timer.unref();
  // reject pending spawn failures
  child.on("error", () => { abort("codex_unavailable"); });
  // absorb and map native stdin failures
  child.stdin.on("error", () => { abort("codex_protocol_invalid"); });
  // reject pending early exits
  child.on("close", () => { const error = protocolFailure ?? failure("codex_protocol_invalid"); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  try {
    await request("initialize", { clientInfo: { name: "remote-agent-console", title: "Remote Agent Console", version: "1.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const config = await request("config/read", { cwd, includeLayers: false });
    const pages = [];
    let cursor;
    let models = 0;
    // paginate within the same limits as the server parser
    for (let page = 0; page < maxPages; page += 1) {
      const result = await request("model/list", { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      // validate each native page
      if (result === null || typeof result !== "object" || !Array.isArray(result.data) || result.data.length > 100) throw failure("codex_protocol_invalid");
      models += result.data.length;
      // bound aggregate models
      if (models > maxModels) throw failure("codex_protocol_invalid");
      pages.push(result);
      cursor = result.nextCursor;
      // stop after the final page
      if (cursor === undefined || cursor === null || cursor === "") break;
      // reject invalid pagination
      if (typeof cursor !== "string" || page === maxPages - 1) throw failure("codex_protocol_invalid");
    }
    return { config, pages };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    child.stdin.destroy();
  }
}

// prepare one bounded native discovery context
async function prepareDiscovery(request, inherited) {
  const started = Date.now();
  const deadline = Math.min(started + request.timeoutMs, request.expiresAt ?? Number.MAX_SAFE_INTEGER);
  const remaining = () => deadline - Date.now();
  // account for host queue time before starting any native process
  if (remaining() <= 0) throw failure("discovery_timeout");
  // match the physical cwd seen by the launched process
  const cwd = await realpath(request.cwd).catch(() => { throw failure("invalid_request"); });
  const cwdIdentity = await lstat(cwd).catch(() => undefined);
  // require one existing physical directory
  if (cwdIdentity === undefined || !cwdIdentity.isDirectory()) throw failure("invalid_request");
  const env = { ...inherited, ...(request.home === undefined ? {} : { HOME: request.home }), ...request.env };
  // exclude server-only billing authority from every native child
  delete env.RAC_OPENAI_ADMIN_KEY;
  delete env.RAC_OPENAI_API_KEY_IDS;
  return { cwd, env, remaining };
}

// query one proven Codex metadata process
async function discoverMetadata(codex, contextArgs, env, cwd, remaining) {
  // preserve the global deadline
  if (remaining() <= 0) throw failure("discovery_timeout");
  const fresh = await help(codex, [...contextArgs, "--help"], env, cwd, remaining);
  // preserve the global deadline
  if (remaining() <= 0) throw failure("discovery_timeout");
  const resumed = await help(codex, [...contextArgs, "resume", "--help"], env, cwd, remaining);
  const model = fresh.includes("--model") && resumed.includes("--model");
  const effort = fresh.includes("--config") && resumed.includes("--config");
  // require proven model grammar
  if (!model) throw failure("codex_capabilities_unproven");
  // preserve the global deadline
  if (remaining() <= 0) throw failure("discovery_timeout");
  const metadata = await queryCodex(codex, contextArgs, env, cwd, remaining);
  return { version: 1, ...metadata, args: contextArgs, capabilities: { model: true, ...(effort ? { effort: true } : {}) } };
}

// discover one exact supported OMX metadata context
export async function discoverOmxModels(request, inherited = process.env) {
  const { cwd, env, remaining } = await prepareDiscovery(request, inherited);
  const { root } = await proveOmxPackage(request.program);
  const resolver = await import(pathToFileURL(join(root, "dist/cli/codex-home.js")).href);
  // require the audited pure resolver
  if (typeof resolver.resolveCodexHomeForLaunch !== "function") throw failure("omx_unproven");
  const explicitCodexHome = env.CODEX_HOME?.trim();
  const scope = explicitCodexHome ? undefined : await setupScope(cwd);
  // refuse ephemeral project homes
  if (scope === "project") throw failure("omx_project_scope_unsupported");
  const codexHome = resolver.resolveCodexHomeForLaunch(cwd, env);
  // project scope needs OMX's mutating ephemeral credential projection
  if (codexHome !== undefined && env.CODEX_HOME?.trim() === "") throw failure("omx_project_scope_unsupported");
  // refuse implicit home projections
  if (codexHome !== undefined && env.CODEX_HOME === undefined) throw failure("omx_project_scope_unsupported");
  // require the explicit home exactly
  if (codexHome !== undefined && resolve(codexHome) !== resolve(env.CODEX_HOME)) throw failure("omx_unproven");
  const contextArgs = normalizeOmxContextArgs(request.args);
  const codex = await resolveCodexProgram(env.PATH, cwd);
  return await discoverMetadata(codex, contextArgs, env, cwd, remaining);
}

// discover one exact configured Codex metadata context
export async function discoverCodexModels(request, inherited = process.env) {
  const { cwd, env, remaining } = await prepareDiscovery(request, inherited);
  const contextArgs = normalizeCodexContextArgs(request.args);
  const codex = await configuredCodexProgram(request.program);
  return await discoverMetadata(codex, contextArgs, env, cwd, remaining);
}

// dispatch the private descriptor without adapter borrowing
export async function discoverNativeModels(request, inherited = process.env) {
  const kind = request.kind ?? "omx";
  // accept only the two supported native adapters
  if (kind !== "omx" && kind !== "codex") throw failure("invalid_request");
  return kind === "codex" ? await discoverCodexModels(request, inherited) : await discoverOmxModels(request, inherited);
}

// keep imports side-effect free for unit tests
async function main(argv = process.argv.slice(2)) {
  let output;
  try {
    // require one private descriptor
    if (argv.length !== 2 || argv[0] !== "--request") throw failure("invalid_request");
    const request = await readDiscoveryRequest(argv[1]);
    // minimize credential retention before starting native discovery
    await unlink(argv[1]).catch(() => { throw failure("invalid_request"); });
    output = await discoverNativeModels(request);
    // keep host transport output below its fixed stdout ceiling
    if (Buffer.byteLength(JSON.stringify(output)) > maxOutputBytes) throw failure("codex_protocol_invalid");
  } catch (error) {
    // publish only fixed safe failures
    output = { version: 1, error: safeErrors.has(error?.code) ? error.code : "codex_protocol_invalid" };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// run only as the direct entrypoint
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
