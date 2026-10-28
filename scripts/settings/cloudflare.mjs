import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { MAX_COMMAND_BYTES, MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "./constants.mjs";
import { resolveCandidate, validateDescriptor } from "./contracts.mjs";
import { openLocal, sealLocal, sha256 } from "./crypto.mjs";
import { atomicWriteFile, inspectOwnedPath, readBoundedFile, readJsonFile, safeError } from "./fs.mjs";
import { runBounded } from "./command.mjs";
import { composePrefix, validateCandidate } from "./validate.mjs";

const CONNECT_CANDIDATE = "cloudflare-connect";
const TOKEN_PROFILE = "tunnel-token";
const TOKEN_SERVICE = "cloudflared-token";
const TOKEN_PATH = "config/cloudflared.token";
const TOKEN_TARGET = "/run/secrets/cloudflared-token";
const TOKEN_COMMAND = ["tunnel", "--no-autoupdate", "run", "--token-file", TOKEN_TARGET];
const CONTAINER_ID = /^[0-9a-f]{12,64}$/u;
const CHALLENGE = /^[0-9a-f]{64}$/u;
const HEALTH_PROOF = /^[0-9a-f]{64}$/u;
const RESERVED_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/u;
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

// reject nonpublic ipv4 destinations
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
// reject nonpublic ipv6 destinations and mapped rebinding forms
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16],
  ["fc00::", 7], ["fec0::", 10], ["fe80::", 10], ["ff00::", 8]
]) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

// process one redacted Cloudflare host action
export async function processCloudflareRequest(descriptor, request, options = {}, hooks = {}) {
  // return status without staging or host mutation
  if (request.cloudflare.action === "status") {
    return { phase: "inspected", cloudflare: await cloudflareStatus(descriptor, options) };
  }
  // restart only the exact installed connector without staging files
  if (request.cloudflare.action === "reconnect") {
    return await reconnectCloudflare(descriptor, request, options);
  }
  // fail setup closed outside Compose while retaining legacy native management
  if (descriptor.kind !== "compose") {
    throw safeError("cloudflare-token-compose-only");
  }
  try {
    const recovered = await recoverInterruptedCloudflare(descriptor, request, options, hooks);
    // replay a fully journaled result without repeating external work
    if (recovered) {
      return recovered;
    }
    verifyExpectedSources(descriptor, request.sources);
    const candidate = readConnectCandidate(descriptor, request);
    // dispatch only the validated candidate action
    if (candidate.action === "connect") {
      return await connectCloudflare(descriptor, request, candidate, options);
    }
    return await activateCloudflare(descriptor, request, candidate, options, hooks);
  } catch (error) {
    // attach only redacted current state to the durable failure
    try {
      error.cloudflare = await cloudflareStatus(descriptor, options);
    } catch {
      // retain the original stable failure when status is unavailable
    }
    throw error;
  }
}

// restart one exact configured connector without applying saved settings
async function reconnectCloudflare(descriptor, request, options) {
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  const context = { journalPath, runtime: undefined, crashHook: false, ownsJournal: false };
  try { return await reconnectCloudflareAttempt(descriptor, request, options, context); }
  catch (error) {
    // leave only a deliberate crash seam in-flight for replay
    if (!context.crashHook && context.ownsJournal && existsSync(journalPath)) writeReconnectJournal(journalPath, request, "rolled-back", context.runtime ?? { kind: "unavailable" });
    throw error;
  }
}

// attempt one selector-bound restart under outer failure closure
async function reconnectCloudflareAttempt(descriptor, request, options, context) {
  const runner = options.runner ?? runBounded;
  const { journalPath } = context;
  const selector = reconnectSelector(descriptor);
  const journal = existsSync(journalPath) ? readReconnectJournal(journalPath, request, selector) : undefined;
  context.ownsJournal = journal !== undefined;
  context.runtime = journal?.runtime;
  // replay one terminal result without another host mutation
  if (journal?.phase === "complete") return { phase: "connector-reconnected", cloudflare: journal.cloudflare };
  // retain a terminal failure without retrying its side effect
  if (journal?.phase === "rolled-back") throw safeError("cloudflare-reconnect-failed");
  // select only a fixed enabled compose connector
  if (descriptor.kind === "compose") {
    // reject dormant or incomplete tunnel selectors
    if (selector?.kind !== "compose") throw safeError("cloudflare-reconnect-unavailable");
    const { service, profile } = selector;
    const tokenMode = service === TOKEN_SERVICE;
    // validate the managed token service before invoking it
    if (tokenMode) await validateTokenService(descriptor, runner);
    const prefix = tokenMode ? tokenComposePrefix(descriptor) : composePrefix(descriptor.compose);
    const before = journal?.runtime ?? await composeReconnectRuntime(descriptor, service, profile, runner);
    context.runtime = before;
    // reject absent containers and substituted replay selectors
    if (before.kind !== "compose" || before.service !== service || before.profile !== profile || !CONTAINER_ID.test(before.container)) throw safeError("cloudflare-reconnect-failed");
    const current = journal === undefined ? before : await composeReconnectRuntime(descriptor, service, profile, runner);
    // reconcile a completed restart whose terminal journal was interrupted
    if (journal !== undefined && composeRestarted(before, current)) return await completeReconnect(descriptor, request, options, journalPath, before);
    // reject ambiguous runtime drift instead of restarting twice
    if (journal !== undefined && JSON.stringify(current) !== JSON.stringify(before)) throw safeError("cloudflare-reconnect-failed");
    writeReconnectJournal(journalPath, request, "restarting", before);
    context.ownsJournal = true;
    options.onPhase?.("connector-restarting");
    const restarted = await runner("docker", [...prefix, "restart", service], { cwd: descriptor.compose.projectDirectory, maxBytes: MAX_COMMAND_BYTES, timeoutMs: options.applyTimeoutMs ?? 60_000 });
    // require command success before liveness proof
    if (restarted.code !== 0) throw safeError("cloudflare-reconnect-failed");
    context.crashHook = true;
    options.afterCloudflareReconnect?.();
    context.crashHook = false;
    const after = await composeReconnectRuntime(descriptor, service, profile, runner);
    // require a changed process start and running exact container
    if (!composeRestarted(before, after)) throw safeError("cloudflare-reconnect-failed");
    return await completeReconnect(descriptor, request, options, journalPath, before);
  }
  const unit = selector?.kind === "native" ? selector.unit : undefined;
  // require one exact installed native connector selector
  if (!unit) throw safeError("cloudflare-reconnect-unavailable");
  const before = journal?.runtime ?? await nativeReconnectRuntime(unit, runner);
  context.runtime = before;
  // reject substituted replay selectors
  if (before.kind !== "native" || before.unit !== unit) throw safeError("cloudflare-reconnect-failed");
  const current = journal === undefined ? before : await nativeReconnectRuntime(unit, runner);
  // reconcile a completed native restart after interrupted publication
  if (journal !== undefined && nativeRestarted(before, current)) return await completeReconnect(descriptor, request, options, journalPath, before);
  // reject ambiguous runtime drift instead of restarting twice
  if (journal !== undefined && JSON.stringify(current) !== JSON.stringify(before)) throw safeError("cloudflare-reconnect-failed");
  writeReconnectJournal(journalPath, request, "restarting", before);
  context.ownsJournal = true;
  options.onPhase?.("connector-restarting");
  const restarted = await runner("systemctl", ["--user", "restart", unit], { maxBytes: MAX_COMMAND_BYTES, timeoutMs: options.applyTimeoutMs ?? 60_000 });
  // require command success before identity proof
  if (restarted.code !== 0) throw safeError("cloudflare-reconnect-failed");
  context.crashHook = true;
  options.afterCloudflareReconnect?.();
  context.crashHook = false;
  const after = await nativeReconnectRuntime(unit, runner);
  // require a new active invocation
  if (!nativeRestarted(before, after)) throw safeError("cloudflare-reconnect-failed");
  return await completeReconnect(descriptor, request, options, journalPath, before);
}

// select only the connector authority installed by the current descriptor
function reconnectSelector(descriptor) {
  // prefer the managed token connector over a legacy local connector
  if (descriptor.kind === "compose") {
    const tokenMode = descriptor.compose.profiles.includes(TOKEN_PROFILE);
    const localMode = descriptor.compose.profiles.includes("tunnel") && descriptor.sources.cloudflared !== undefined;
    // reject dormant or incomplete compose selectors
    if (!tokenMode && !localMode) return undefined;
    return { kind: "compose", service: tokenMode ? TOKEN_SERVICE : "cloudflared", profile: tokenMode ? TOKEN_PROFILE : "tunnel" };
  }
  const unit = descriptor.native?.cloudflaredUnit;
  // require a distinct configured unit backed by a managed source
  if (!unit || unit === descriptor.native.unit || descriptor.sources.cloudflared === undefined) return undefined;
  return { kind: "native", unit };
}

// publish one durable reconnect result
async function completeReconnect(descriptor, request, options, journalPath, runtime) {
  const cloudflare = await cloudflareStatus(descriptor, options);
  writeReconnectJournal(journalPath, request, "complete", runtime, cloudflare);
  return { phase: "connector-reconnected", cloudflare };
}

// require one exact private reconnect journal
function readReconnectJournal(path, request, selector) {
  const journal = readJsonFile(path, 2 * MAX_SOURCE_BYTES);
  const baseKeys = ["version", "id", "kind", "action", "generation", "phase", "runtime", "updatedAt"];
  // require status only on a successful terminal phase
  const keys = journal?.phase === "complete" ? [...baseKeys, "cloudflare"] : baseKeys;
  // reject unknown fields, identity changes and phase substitution
  if (!matchesRecordKeys(journal, keys, keys) || journal.version !== PROTOCOL_VERSION || journal.id !== request.id || journal.kind !== "cloudflare" || journal.action !== "reconnect" || journal.generation !== request.generation || !["restarting", "complete", "rolled-back"].includes(journal.phase) || !validStatusDateTime(journal.updatedAt)) throw safeError("journal-mismatch");
  // bind every phase to the exact current connector selector
  if (!validReconnectRuntime(journal.runtime, selector)) throw safeError("journal-mismatch");
  // require bounded status data only for successful terminal journals
  if (journal.phase === "complete" && !validCloudflareStatus(journal.cloudflare)) throw safeError("journal-mismatch");
  return journal;
}

// require a plain record with all required keys and no unknown keys
function matchesRecordKeys(value, required, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

// validate one descriptor-bound compose or native runtime identity
function validReconnectRuntime(runtime, selector) {
  // reject runtime data when no current connector authority exists
  if (!selector || runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) return false;
  // bind compose replay to its fixed service, profile and container process
  if (selector.kind === "compose") {
    const keys = ["kind", "service", "profile", "container", "startedAt", "running"];
    return matchesRecordKeys(runtime, keys, keys) && runtime.kind === "compose" && runtime.service === selector.service && runtime.profile === selector.profile && typeof runtime.container === "string" && CONTAINER_ID.test(runtime.container) && validStatusDateTime(runtime.startedAt) && typeof runtime.running === "boolean";
  }
  const keys = ["kind", "unit", "invocation", "active"];
  return matchesRecordKeys(runtime, keys, keys) && runtime.kind === "native" && runtime.unit === selector.unit && typeof runtime.invocation === "string" && (runtime.invocation === "" || /^[0-9a-f]{32}$/u.test(runtime.invocation)) && typeof runtime.active === "boolean";
}

// validate one strict redacted cloudflare status record
function validCloudflareStatus(value) {
  const required = ["supported", "mode", "enabled", "tokenPresent", "serviceUrl"];
  const allowed = [...required, "reason", "hostname", "endpoint", "connected", "verifiedAt"];
  // reject expanded or incomplete status records
  if (!matchesRecordKeys(value, required, allowed)) return false;
  // require the public scalar status contract
  if (typeof value.supported !== "boolean" || !["unconfigured", "token", "local"].includes(value.mode) || typeof value.enabled !== "boolean" || typeof value.tokenPresent !== "boolean" || typeof value.serviceUrl !== "string" || value.serviceUrl.length > 512 || !validStatusServiceUrl(value.serviceUrl)) return false;
  // constrain optional public fields independently
  if (value.reason !== undefined && (typeof value.reason !== "string" || !/^[a-z0-9_-]{1,80}$/u.test(value.reason))) return false;
  if (value.hostname !== undefined && !validStatusHostname(value.hostname)) return false;
  if (value.endpoint !== undefined && !validStatusEndpoint(value.endpoint)) return false;
  if (value.connected !== undefined && typeof value.connected !== "boolean") return false;
  if (value.verifiedAt !== undefined && !validStatusDateTime(value.verifiedAt)) return false;
  return true;
}

// recognize one public hostname without exposing validation errors
function validStatusHostname(value) {
  try { return validateHostname(value) === value; }
  catch {
    // reject malformed hostnames without leaking validation details
    return false;
  }
}

// accept only one credential-free root http service url
function validStatusServiceUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    // reject malformed service urls
    return false;
  }
}

// accept only one canonical public https origin
function validStatusEndpoint(value) {
  // apply the server status length bound before url parsing
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/" && validStatusHostname(url.hostname);
  } catch {
    // reject malformed public endpoints
    return false;
  }
}

// accept one bounded utc iso date-time
function validStatusDateTime(value) {
  // reject malformed timestamps before calendar comparison
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // reject impossible dates that javascript would normalize
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

// write one selector-bound reconnect journal
function writeReconnectJournal(path, request, phase, runtime, cloudflare) {
  atomicWriteFile(path, `${JSON.stringify({ version: PROTOCOL_VERSION, id: request.id, kind: "cloudflare", action: "reconnect", generation: request.generation, phase, runtime, ...(cloudflare ? { cloudflare } : {}), updatedAt: new Date().toISOString() })}\n`, 0o600);
}

// expose only redacted tunnel state
export async function cloudflareStatus(descriptor, options = {}) {
  const serviceUrl = localServiceUrl(descriptor);
  const state = readOptionalJson(statePath(descriptor));
  const tokenPresent = validSavedToken(descriptor);
  const configuredEndpoint = configuredPublicEndpoint(descriptor);
  const savedEndpoint = savedTokenEndpoint(state);
  // describe unsupported native installs without invoking host cloudflared
  if (descriptor.kind !== "compose") {
    const local = Boolean(descriptor.native?.cloudflaredUnit && descriptor.sources.cloudflared);
    const connected = local ? await nativeCloudflaredConnected(descriptor.native.cloudflaredUnit, options.runner ?? runBounded) : undefined;
    return {
      supported: false,
      reason: "cloudflare-token-compose-only",
      mode: local ? "local" : "unconfigured",
      enabled: local,
      ...(connected === undefined ? {} : { connected }),
      ...(local ? configuredEndpoint : {}),
      tokenPresent: false,
      serviceUrl
    };
  }
  const runner = options.runner ?? runBounded;
  const tokenContainer = await listedContainer(descriptor, TOKEN_SERVICE, TOKEN_PROFILE, runner);
  const tokenMode = tokenPresent || state?.mode === "token" || descriptor.compose.profiles.includes(TOKEN_PROFILE) || tokenContainer !== "";
  let localContainer = "";
  // inspect local mode only when token mode is not authoritative
  if (!tokenMode) {
    localContainer = await listedContainer(descriptor, "cloudflared", "tunnel", runner);
  }
  const localMode = !tokenMode && (descriptor.compose.profiles.includes("tunnel") || localContainer !== "" || localCloudflareConfigured(descriptor));
  const enabled = tokenMode
    ? descriptor.compose.profiles.includes(TOKEN_PROFILE)
    : localMode && descriptor.compose.profiles.includes("tunnel");
  const connected = tokenMode ? CONTAINER_ID.test(tokenContainer) : CONTAINER_ID.test(localContainer);
  return {
    supported: true,
    mode: tokenMode ? "token" : localMode ? "local" : "unconfigured",
    enabled,
    // connected proves only a running Compose connector process
    connected,
    ...(tokenMode ? savedEndpoint : localMode ? configuredEndpoint : {}),
    tokenPresent,
    serviceUrl,
    ...(savedEndpoint.hostname && state?.verifiedAt ? { verifiedAt: state.verifiedAt } : {})
  };
}

// install or replace one private connector token
async function connectCloudflare(descriptor, request, candidate, options) {
  const runner = options.runner ?? runBounded;
  const tokenPath = managedTokenPath(descriptor);
  const existingToken = existsSync(tokenPath) ? readBoundedFile(tokenPath, MAX_SOURCE_BYTES).toString("utf8").trimEnd() : undefined;
  const token = normalizeToken(candidate.token ?? existingToken);
  await validateTokenService(descriptor, runner);
  const beforeContainer = await listedContainer(descriptor, TOKEN_SERVICE, TOKEN_PROFILE, runner);
  const paths = transactionPaths(descriptor);
  const originals = captureOriginals(paths);
  const recoveryPath = resolve(descriptor.controlRoot, "recovery", `${request.id}.json`);
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  const key = recoveryKey(descriptor);
  atomicWriteFile(recoveryPath, `${JSON.stringify(sealLocal(key, { version: 1, action: "connect", beforeConnected: CONTAINER_ID.test(beforeContainer), originals }))}\n`, 0o600);
  const written = [];
  const beforeHashes = {};
  const hashes = {};
  writeCloudflareJournal(journalPath, request, "prepared", written, beforeHashes, hashes);
  try {
    publishFile(paths.token, Buffer.from(`${token}\n`), 0o600, "token", originals, written, beforeHashes, hashes, journalPath, request, options);
    options.onPhase?.("connector-starting");
    await startTokenService(descriptor, runner);
    const afterContainer = await listedContainer(descriptor, TOKEN_SERVICE, TOKEN_PROFILE, runner);
    // require one running replacement container
    if (!CONTAINER_ID.test(afterContainer) || afterContainer === beforeContainer) {
      throw safeError("cloudflare-connector-proof-failed");
    }
    const active = activeDescriptorWithTokenProfile(descriptor);
    publishFile(paths.descriptor, Buffer.from(`${JSON.stringify(active, null, 2)}\n`), 0o600, "descriptor", originals, written, beforeHashes, hashes, journalPath, request, options);
    const state = { version: PROTOCOL_VERSION, mode: "token", profile: TOKEN_PROFILE, service: TOKEN_SERVICE, updatedAt: new Date().toISOString() };
    publishFile(paths.state, Buffer.from(`${JSON.stringify(state)}\n`), 0o600, "state", originals, written, beforeHashes, hashes, journalPath, request, options);
    const cloudflare = await cloudflareStatus(validateDescriptor(active, paths.descriptor), options);
    const receipt = operationReceipt(descriptor, request);
    writeCloudflareJournal(journalPath, request, "complete", written, beforeHashes, hashes, receipt, cloudflare);
    options.afterCloudflareComplete?.();
    return { phase: "connector-ready", receipt, cloudflare };
  } catch (error) {
    await rollbackConnect(descriptor, request, originals, written, beforeHashes, hashes, beforeContainer, runner, journalPath);
    throw error;
  }
}

// verify and activate one public hostname
async function activateCloudflare(descriptor, request, candidate, options, hooks) {
  const hostname = validateHostname(candidate.hostname);
  const runner = options.runner ?? runBounded;
  normalizeToken(existsSync(managedTokenPath(descriptor)) ? readBoundedFile(managedTokenPath(descriptor), MAX_SOURCE_BYTES).toString("utf8") : undefined);
  await validateTokenService(descriptor, runner);
  const container = await listedContainer(descriptor, TOKEN_SERVICE, TOKEN_PROFILE, runner);
  // require setup completion before dashboard route publication
  if (!CONTAINER_ID.test(container)) {
    throw safeError("cloudflare-connector-not-running");
  }
  options.onPhase?.("verifying-hostname");
  const proved = options.cloudflareHealthProof
    ? await options.cloudflareHealthProof({ hostname, descriptor })
    : await proveSameRac(descriptor, hostname, options);
  // do not mutate the current origin without identity proof
  if (!proved) {
    throw safeError("cloudflare-health-proof-failed");
  }
  // close the health-proof race before any source publication
  verifyExpectedSources(descriptor, request.sources);
  let app = readApplication(descriptor);
  const publicOrigin = `https://${hostname}`;
  const changesOrigin = app.publicOrigin !== publicOrigin;
  // require restart recovery only when activation changes the live origin
  if (changesOrigin) {
    await hooks.ensureRacBaseline?.(descriptor, options);
    // close drift during baseline proof before publication
    verifyExpectedSources(descriptor, request.sources);
    app = readApplication(descriptor);
  }
  const appBytes = changesOrigin ? Buffer.from(`${JSON.stringify({ ...app, publicOrigin }, null, 2)}\n`) : undefined;
  // validate only a changed application document
  if (changesOrigin) {
    const appCandidate = resolve(descriptor.controlRoot, "staging", request.id, "cloudflare-app");
    atomicWriteFile(appCandidate, appBytes, 0o600);
    await validateCandidate(descriptor.sources.app, appCandidate, options);
    // close drift during candidate validation before publication
    verifyExpectedSources(descriptor, request.sources);
  }
  const paths = { app: descriptor.sources.app.path, state: statePath(descriptor) };
  const originals = captureOriginals(paths);
  const recoveryPath = resolve(descriptor.controlRoot, "recovery", `${request.id}.json`);
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  atomicWriteFile(recoveryPath, `${JSON.stringify(sealLocal(recoveryKey(descriptor), { version: 1, action: "activate", originals }))}\n`, 0o600);
  const written = [];
  const beforeHashes = {};
  const hashes = {};
  writeCloudflareJournal(journalPath, request, "prepared", written, beforeHashes, hashes);
  let restartSucceeded = false;
  try {
    // preserve exact application bytes when the hostname is already active
    if (changesOrigin) {
      publishFile(paths.app, appBytes, originalMode(originals, "app"), "app", originals, written, beforeHashes, hashes, journalPath, request, options);
    }
    const previousState = readOptionalJson(paths.state) ?? { version: PROTOCOL_VERSION, mode: "token", profile: TOKEN_PROFILE, service: TOKEN_SERVICE };
    const verifiedAt = new Date().toISOString();
    const state = { ...previousState, version: PROTOCOL_VERSION, mode: "token", profile: TOKEN_PROFILE, service: TOKEN_SERVICE, hostname, verifiedAt, updatedAt: verifiedAt };
    publishFile(paths.state, Buffer.from(`${JSON.stringify(state)}\n`), 0o600, "state", originals, written, beforeHashes, hashes, journalPath, request, options);
    // finish without a RAC replacement when public origin is unchanged
    if (!changesOrigin) {
      const receipt = operationReceipt(descriptor, request);
      const cloudflare = await cloudflareStatus(descriptor, options);
      writeCloudflareJournal(journalPath, request, "complete", written, beforeHashes, hashes, receipt, cloudflare);
      options.afterCloudflareComplete?.();
      return { phase: "activated", receipt, cloudflare };
    }
    options.onPhase?.("restarting-rac");
    writeCloudflareJournal(journalPath, request, "restarting", written, beforeHashes, hashes);
    const restartRequest = {
      version: PROTOCOL_VERSION,
      id: request.id,
      kind: "restart",
      generation: descriptor.generation,
      targets: ["rac"],
      sources: request.sources.map((source) => source.id === "app" ? { ...source, contentHash: sha256(appBytes), existed: true } : source)
    };
    const restarted = await hooks.restartRac(descriptor, restartRequest, options);
    restartSucceeded = true;
    const cloudflare = await cloudflareStatus(descriptor, options);
    writeCloudflareJournal(journalPath, request, "complete", written, beforeHashes, hashes, restarted.receipt, cloudflare);
    options.afterCloudflareComplete?.();
    return { phase: "activated", receipt: restarted.receipt, cloudflare };
  } catch (error) {
    let recoveryError;
    // restore a successfully replaced RAC if final metadata publication failed
    if (restartSucceeded) {
      try {
        await hooks.recoverRac?.(descriptor, request.sources.map((source) => source.id === "app" ? { ...source, contentHash: sha256(appBytes), existed: true } : source), options);
      } catch (caught) {
        recoveryError = caught;
      }
    }
    try {
      restorePublished(originals, written, beforeHashes, hashes);
    } catch (caught) {
      recoveryError ??= caught;
    }
    writeCloudflareJournal(journalPath, request, recoveryError ? "restarting" : "rolled-back", written, beforeHashes, hashes);
    throw recoveryError ?? error;
  }
}

// recover one interrupted action before replaying it
async function recoverInterruptedCloudflare(descriptor, request, options, hooks) {
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  // skip fresh and terminal operations
  if (!existsSync(journalPath)) {
    return;
  }
  const journal = readJsonFile(journalPath, 2 * MAX_SOURCE_BYTES);
  // reject journal identity substitution
  if (journal.id !== request.id || journal.kind !== "cloudflare" || journal.action !== request.cloudflare.action || journal.generation !== request.generation) {
    throw safeError("journal-mismatch");
  }
  // replay only a fully journaled terminal success
  if (journal.phase === "complete") {
    if (!journal.receipt || !journal.cloudflare) {
      throw safeError("journal-mismatch");
    }
    return {
      phase: request.cloudflare.action === "connect" ? "connector-ready" : "activated",
      receipt: journal.receipt,
      cloudflare: journal.cloudflare
    };
  }
  // begin a fresh attempt after a proved rollback
  if (journal.phase === "rolled-back") {
    return;
  }
  const envelope = readJsonFile(resolve(descriptor.controlRoot, "recovery", `${request.id}.json`), 8 * MAX_SOURCE_BYTES);
  const recovery = openLocal(recoveryKey(descriptor), envelope);
  let recoveryError;
  // recover RAC only after the operation reached its restart boundary
  if (recovery.action === "activate" && journal.phase === "restarting") {
    try {
      const expectedSources = request.sources.map((source) => source.id === "app" && typeof journal.hashes?.app === "string"
        ? { ...source, existed: true, contentHash: journal.hashes.app }
        : source);
      await hooks.recoverRac?.(descriptor, expectedSources, options);
    } catch (error) {
      recoveryError = error;
    }
  }
  try {
    restorePublished(recovery.originals, journal.written ?? [], journal.beforeHashes ?? {}, journal.hashes ?? {});
  } catch (error) {
    recoveryError ??= error;
  }
  // restore only the managed token service and never the legacy connector
  if (recovery.action === "connect") {
    try {
      const runner = options.runner ?? runBounded;
      await validateTokenService(descriptor, runner);
      await restoreTokenServiceState(descriptor, recovery.beforeConnected, runner);
    } catch (error) {
      recoveryError ??= error;
    }
  }
  writeCloudflareJournal(journalPath, request, recoveryError ? journal.phase : "rolled-back", journal.written ?? [], journal.beforeHashes ?? {}, journal.hashes ?? {});
  // require manual recovery when an exact rollback could not finish
  if (recoveryError) {
    throw recoveryError;
  }
}

// restore connector setup after a failed start
async function rollbackConnect(descriptor, request, originals, written, beforeHashes, hashes, beforeContainer, runner, journalPath) {
  let rollbackError;
  try {
    restorePublished(originals, written, beforeHashes, hashes);
  } catch (error) {
    rollbackError = error;
  }
  try {
    await restoreTokenServiceState(descriptor, CONTAINER_ID.test(beforeContainer), runner);
  } catch (error) {
    rollbackError ??= error;
  }
  writeCloudflareJournal(journalPath, request, rollbackError ? "committing" : "rolled-back", written, beforeHashes, hashes);
  // surface rollback incompleteness over the forward error
  if (rollbackError) {
    throw rollbackError;
  }
}

// restore and prove only the predecessor token-service state
async function restoreTokenServiceState(descriptor, shouldRun, runner) {
  // recreate the connector only when it was previously running
  if (shouldRun) {
    await startTokenService(descriptor, runner);
  } else {
    await stopTokenService(descriptor, runner);
  }
  const container = await listedContainer(descriptor, TOKEN_SERVICE, TOKEN_PROFILE, runner);
  // require exact running or stopped postconditions
  if (shouldRun ? !CONTAINER_ID.test(container) : container !== "") {
    throw safeError("cloudflare-connector-rollback-failed");
  }
}

// parse one strict private candidate
function readConnectCandidate(descriptor, request) {
  const path = resolveCandidate(descriptor.controlRoot, request.id, request.cloudflare.candidate);
  const candidate = readJsonFile(path, MAX_SOURCE_BYTES);
  const allowed = request.cloudflare.action === "connect" ? new Set(["action", "token"]) : new Set(["action", "hostname"]);
  // require the public discriminated union again inside the private stage
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate.action !== request.cloudflare.action || Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw safeError("invalid-cloudflare-candidate");
  }
  // validate exact field presence per action
  if (candidate.action === "connect") {
    if (candidate.token !== undefined && typeof candidate.token !== "string") {
      throw safeError("invalid-cloudflare-candidate");
    }
  } else if (typeof candidate.hostname !== "string") {
    throw safeError("invalid-cloudflare-candidate");
  }
  return candidate;
}

// require current app and installation revisions only
function verifyExpectedSources(descriptor, sources) {
  const ids = sources?.map((source) => source.id).sort();
  // reject missing or expanded host source authority
  if (JSON.stringify(ids) !== JSON.stringify(["app", "installation"])) {
    throw safeError("invalid-request");
  }
  // compare every fixed installed source
  for (const expected of sources) {
    const source = descriptor.sources[expected.id];
    const existed = Boolean(source && existsSync(source.path));
    const bytes = existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
    // reject stale browser state before any external work
    if (expected.existed !== existed || sha256(bytes) !== expected.contentHash) {
      throw safeError("source-conflict");
    }
  }
}

// reject malformed connector tokens without guessing their format
function normalizeToken(value) {
  // keep raw tokens out of errors and normalized command data
  if (typeof value !== "string") {
    throw safeError("invalid-cloudflare-token");
  }
  const token = value.trim();
  // accept opaque tokens while rejecting controls and clear pasted commands
  if (token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f]/u.test(token) || /^(?:docker|cloudflared|sudo|curl|wget)(?:\s|$)/iu.test(token)) {
    throw safeError("invalid-cloudflare-token");
  }
  return token;
}

// normalize one safe public DNS hostname
function validateHostname(value) {
  // reject urls, ip literals, ports and internal suffixes
  if (typeof value !== "string" || value !== value.trim() || value !== value.toLowerCase() || value.length > 253 || isIP(value) !== 0 || RESERVED_SUFFIX.test(value)) {
    throw safeError("invalid-cloudflare-hostname");
  }
  const labels = value.split(".");
  // require a qualified ascii dns name with bounded labels
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw safeError("invalid-cloudflare-hostname");
  }
  return value;
}

// prove a fixed installer-owned Compose service graph
async function validateTokenService(descriptor, runner) {
  const rendered = await runner("docker", [...tokenComposePrefix(descriptor), "config", "--format", "json"], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: MAX_COMMAND_BYTES
  });
  // reject unavailable or malformed normalized Compose output
  if (rendered.code !== 0) {
    throw safeError("cloudflare-service-unsupported");
  }
  let model;
  try {
    model = JSON.parse(rendered.stdout.toString("utf8"));
  } catch {
    throw safeError("cloudflare-service-unsupported");
  }
  const service = model.services?.[TOKEN_SERVICE];
  const volume = service?.volumes?.find((entry) => entry?.target === TOKEN_TARGET);
  const expectedSource = managedTokenPath(descriptor);
  // reject overrides that could expose the token or execute another workload
  if (
    !service ||
    service.image !== "cloudflare/cloudflared:latest" ||
    service.entrypoint != null ||
    JSON.stringify(service.command) !== JSON.stringify(TOKEN_COMMAND) ||
    service.network_mode !== "host" ||
    service.user !== "0:0" ||
    service.restart !== "unless-stopped" ||
    service.read_only !== true ||
    !Array.isArray(service.security_opt) ||
    !service.security_opt.includes("no-new-privileges:true") ||
    service.privileged === true ||
    !Array.isArray(service.profiles) ||
    !service.profiles.includes(TOKEN_PROFILE) ||
    service.environment !== undefined ||
    !volume ||
    service.volumes.length !== 1 ||
    volume.type !== "bind" ||
    resolve(volume.source) !== expectedSource ||
    volume.read_only !== true
  ) {
    throw safeError("cloudflare-service-unsupported");
  }
}

// start only the managed connector service
async function startTokenService(descriptor, runner) {
  const result = await runner("docker", [...tokenComposePrefix(descriptor), "up", "-d", "--force-recreate", "--no-deps", TOKEN_SERVICE], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: MAX_COMMAND_BYTES,
    timeoutMs: 5 * 60_000
  });
  // hide Docker output behind one stable failure
  if (result.code !== 0) {
    throw safeError("cloudflare-connector-start-failed");
  }
}

// stop only a connector created by token setup
async function stopTokenService(descriptor, runner) {
  const result = await runner("docker", [...tokenComposePrefix(descriptor), "stop", TOKEN_SERVICE], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: MAX_COMMAND_BYTES
  });
  // hide Docker output behind one stable failure
  if (result.code !== 0) {
    throw safeError("cloudflare-connector-rollback-failed");
  }
}

// inspect one exact Compose service without emitting logs
async function listedContainer(descriptor, service, profile, runner, all = false) {
  const prefix = composePrefix({ ...descriptor.compose, profiles: [...new Set([...descriptor.compose.profiles, profile])] });
  let result;
  try {
    result = await runner("docker", [...prefix, "ps", "-q", ...(all ? ["--all"] : []), service], {
      cwd: descriptor.compose.projectDirectory,
      maxBytes: 1024
    });
  } catch {
    throw safeError("cloudflare-connector-status-unavailable");
  }
  // distinguish a proved stop from an unavailable or ambiguous process state
  if (result.code !== 0) {
    throw safeError("cloudflare-connector-status-unavailable");
  }
  const container = result.stdout.toString("utf8").trim();
  // accept exactly zero or one canonical container id
  if (container !== "" && !CONTAINER_ID.test(container)) {
    throw safeError("cloudflare-connector-status-unavailable");
  }
  return container;
}

// capture one exact Compose connector start identity
async function composeReconnectRuntime(descriptor, service, profile, runner) {
  const container = await listedContainer(descriptor, service, profile, runner, true);
  // retain an absent container as a closed failure state
  if (container === "") return { kind: "compose", service, profile, container, startedAt: "", running: false };
  const running = await listedContainer(descriptor, service, profile, runner) === container;
  const result = await runner("docker", ["inspect", "--format", "{{.State.StartedAt}}", container], { maxBytes: 256 });
  const startedAt = result.stdout.toString("utf8").trim();
  // accept only one bounded Docker timestamp
  if (result.code !== 0 || !/^[0-9T:.+-]{10,64}Z$/u.test(startedAt)) throw safeError("cloudflare-connector-status-unavailable");
  return { kind: "compose", service, profile, container, startedAt, running };
}

// prove one Compose restart through a changed start identity
function composeRestarted(before, after) {
  return after.kind === "compose" && after.service === before.service && after.profile === before.profile && after.container === before.container && after.running === true && after.startedAt !== before.startedAt;
}

// capture one exact native connector invocation identity
async function nativeReconnectRuntime(unit, runner) {
  const identity = await runner("systemctl", ["--user", "show", unit, "--property=InvocationID", "--value"], { maxBytes: 256 });
  const invocation = identity.stdout.toString("utf8").trim();
  // accept an inactive empty identity or one systemd invocation id
  if (identity.code !== 0 || invocation !== "" && !/^[0-9a-f]{32}$/u.test(invocation)) throw safeError("cloudflare-connector-status-unavailable");
  const active = await nativeCloudflaredConnected(unit, runner) === true;
  return { kind: "native", unit, invocation, active };
}

// prove one native restart through a new active invocation
function nativeRestarted(before, after) {
  return after.kind === "native" && after.unit === before.unit && after.active === true && /^[0-9a-f]{32}$/u.test(after.invocation) && after.invocation !== before.invocation;
}

// add the managed profile to fixed Compose invocation data
function tokenComposePrefix(descriptor) {
  return composePrefix({ ...descriptor.compose, profiles: [...new Set([...descriptor.compose.profiles, TOKEN_PROFILE])] });
}

// persist connector activation without changing the RAC generation
function activeDescriptorWithTokenProfile(descriptor) {
  const active = {
    ...descriptor,
    compose: { ...descriptor.compose, profiles: [...new Set([...descriptor.compose.profiles, TOKEN_PROFILE])] }
  };
  delete active.controlRoot;
  return active;
}

// prove public DNS and exact challenged health identity
async function proveSameRac(descriptor, hostname, options) {
  const resolveHostname = options.resolveHostname ?? ((name) => lookup(name, { all: true, verbatim: true }));
  let records;
  try {
    records = await resolveHostname(hostname);
  } catch {
    throw safeError("cloudflare-dns-unavailable");
  }
  // require every answer to remain globally routable
  if (!Array.isArray(records) || records.length === 0 || records.some((record) => !publicAddress(record?.address))) {
    throw safeError("cloudflare-private-address");
  }
  const challenge = randomBytes(32).toString("hex");
  const local = await localHealthProof(descriptor, challenge);
  const remote = await publicHealthProof(hostname, records[0], challenge, options);
  return local === remote;
}

// accept only globally routable dns answers
function publicAddress(address) {
  const family = isIP(address);
  // reject malformed and reserved address ranges
  if (family === 0) {
    return false;
  }
  return family === 4 ? !blockedIpv4.check(address, "ipv4") : !blockedIpv6.check(address, "ipv6");
}

// fetch the private loopback challenge proof
async function localHealthProof(descriptor, challenge) {
  const listen = effectiveListen(descriptor);
  // require a fixed local listener
  if (!listen || !["127.0.0.1", "::1", "localhost"].includes(listen.host) || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535 || !CHALLENGE.test(challenge)) {
    throw safeError("cloudflare-health-proof-failed");
  }
  const host = listen.host === "::1" ? "[::1]" : listen.host;
  try {
    const response = await fetch(`http://${host}:${listen.port}/healthz?racChallenge=${challenge}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
      headers: { "cache-control": "no-store" }
    });
    // reject redirects and nonhealthy responses
    if (!response.ok || response.status < 200 || response.status >= 300) {
      throw safeError("cloudflare-health-proof-failed");
    }
    return parseHealthProof(await response.text());
  } catch (error) {
    // retain only the stable proof failure
    if (error?.code === "cloudflare-health-proof-failed") {
      throw error;
    }
    throw safeError("cloudflare-health-proof-failed");
  }
}

// fetch public tls through one pinned validated address
export function publicHealthProof(hostname, record, challenge, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const requester = options.httpsRequest ?? httpsRequest;
    const timeoutMs = options.cloudflareHttpsTimeoutMs ?? 5_000;
    const setTimer = options.setCloudflareTimer ?? setTimeout;
    const clearTimer = options.clearCloudflareTimer ?? clearTimeout;
    let request;
    let response;
    let deadline;
    let settled = false;
    let onData;
    let onEnd;
    let onResponseFailure;
    const onRequestFailure = () => settle(safeError("cloudflare-health-proof-failed"));
    // close the socket without exposing late transport errors
    const destroyRequest = () => {
      request.once("error", () => {});
      response?.once("error", () => {});
      request.destroy();
    };
    // settle exactly once and release the absolute deadline
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimer(deadline);
      request?.off("error", onRequestFailure);
      response?.off("data", onData);
      response?.off("end", onEnd);
      response?.off("error", onResponseFailure);
      response?.off("aborted", onResponseFailure);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    try {
      request = requester({
        protocol: "https:",
        hostname,
        servername: hostname,
        port: 443,
        method: "GET",
        path: `/healthz?racChallenge=${challenge}`,
        headers: { host: hostname, "cache-control": "no-store" },
        lookup: (_hostname, lookupOptions, callback) => {
          // satisfy node's address-list lookup contract
          if (lookupOptions.all) callback(null, [record]);
          else callback(null, record.address, record.family);
        }
      }, (incoming) => {
        // discard a response delivered after the absolute deadline
        if (settled) {
          incoming.destroy?.();
          return;
        }
        response = incoming;
        const chunks = [];
        let length = 0;
        onData = (chunk) => {
          length += chunk.length;
          // destroy oversized proof responses
          if (length > 8 * 1024) {
            settle(safeError("cloudflare-health-proof-failed"));
            destroyRequest();
            return;
          }
          chunks.push(chunk);
        };
        onEnd = () => {
          // accept only a direct healthy tls response
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            settle(safeError("cloudflare-health-proof-failed"));
            return;
          }
          try {
            settle(undefined, parseHealthProof(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            settle(error);
          }
        };
        onResponseFailure = () => settle(safeError("cloudflare-health-proof-failed"));
        response.on("data", onData);
        response.once("end", onEnd);
        response.once("error", onResponseFailure);
        response.once("aborted", onResponseFailure);
      });
    } catch {
      settle(safeError("cloudflare-health-proof-failed"));
      return;
    }
    // enforce one absolute deadline even when bytes continue arriving
    deadline = setTimer(() => {
      settle(safeError("cloudflare-health-proof-failed"));
      destroyRequest();
    }, timeoutMs);
    request.once("error", onRequestFailure);
    request.end();
  });
}

// parse one bounded challenged health response
function parseHealthProof(body) {
  try {
    const value = JSON.parse(body);
    // require only the expected public proof shape
    if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true || !HEALTH_PROOF.test(value.proof ?? "")) {
      throw safeError("cloudflare-health-proof-failed");
    }
    return value.proof;
  } catch (error) {
    // preserve the stable proof category
    if (error?.code === "cloudflare-health-proof-failed") {
      throw error;
    }
    throw safeError("cloudflare-health-proof-failed");
  }
}

// read the fixed application json
function readApplication(descriptor) {
  try {
    const value = JSON.parse(readBoundedFile(descriptor.sources.app.path, MAX_SOURCE_BYTES).toString("utf8"));
    // require one ordinary application object
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw safeError("invalid-application-config");
    }
    return value;
  } catch (error) {
    // preserve safe configuration failures
    if (error?.code === "invalid-application-config") {
      throw error;
    }
    throw safeError("invalid-application-config");
  }
}

// identify dormant local tunnel configuration
function localCloudflareConfigured(descriptor) {
  return [descriptor.sources.cloudflared?.path, descriptor.sources["cloudflared-credentials"]?.path]
    .some((path) => path && existsSync(path));
}

// inspect one fixed native connector unit without treating command failures as downtime
async function nativeCloudflaredConnected(unit, runner) {
  let result;
  try {
    result = await runner("systemctl", ["--user", "is-active", "--quiet", unit], { maxBytes: 1024 });
  } catch {
    return undefined;
  }
  // accept the documented active state
  if (result.code === 0) return true;
  // accept the documented inactive state
  if (result.code === 3) return false;
  return undefined;
}

// expose only a canonical public application origin
function configuredPublicEndpoint(descriptor) {
  const value = readApplication(descriptor).publicOrigin;
  // omit absent or non-string application values
  if (typeof value !== "string") {
    return {};
  }
  try {
    const url = new URL(value);
    // match the application origin contract and reject nonpublic hostnames
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      return {};
    }
    const hostname = validateHostname(url.hostname);
    return { endpoint: url.origin, hostname };
  } catch {
    return {};
  }
}

// retain only a hostname recorded by successful token activation
function savedTokenEndpoint(state) {
  // an unverified connector must remain in the setup flow
  if (typeof state?.verifiedAt !== "string") {
    return {};
  }
  try {
    const hostname = validateHostname(state.hostname);
    return { endpoint: `https://${hostname}`, hostname };
  } catch {
    return {};
  }
}

// require one valid saved token without disclosing it
function validSavedToken(descriptor) {
  try {
    const path = managedTokenPath(descriptor);
    // distinguish absent setup from invalid private state
    if (!existsSync(path)) {
      return false;
    }
    normalizeToken(readBoundedFile(path, MAX_SOURCE_BYTES).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

// expose the exact local origin operators should route through the tunnel
function localServiceUrl(descriptor) {
  const listen = effectiveListen(descriptor);
  // preserve an empty status when no safe listener is available
  if (!listen) {
    return "";
  }
  const host = listen.host === "::1" ? "[::1]" : listen.host === "localhost" ? "127.0.0.1" : listen.host;
  return `http://${host}:${listen.port}`;
}

// prefer the running boot listener over saved application fallback
function effectiveListen(descriptor) {
  const boot = readOptionalJson(resolve(descriptor.controlRoot, "boot.json"));
  const app = readApplication(descriptor);
  const candidate = boot?.generation === descriptor.generation ? boot.listen : app.listen;
  // accept only one bounded loopback listener
  if (!candidate || !["127.0.0.1", "::1", "localhost"].includes(candidate.host) || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) {
    return undefined;
  }
  return { host: candidate.host, port: candidate.port };
}

// constrain the token to the installed checkout
function managedTokenPath(descriptor) {
  const config = resolve(descriptor.hostCheckout, "config");
  inspectOwnedPath(config, { regular: false, writable: true });
  const path = resolve(descriptor.hostCheckout, TOKEN_PATH);
  // reject unexpected path escape
  if (dirname(path) !== config) {
    throw safeError("invalid-cloudflare-token-path");
  }
  return path;
}

// map fixed transaction-owned files
function transactionPaths(descriptor) {
  return {
    token: managedTokenPath(descriptor),
    descriptor: resolve(descriptor.controlRoot, "installation.json"),
    state: statePath(descriptor)
  };
}

// map the redacted durable state record
function statePath(descriptor) {
  return resolve(descriptor.controlRoot, "cloudflare.json");
}

// capture exact rollback bytes before mutation
function captureOriginals(paths) {
  return Object.entries(paths).map(([id, path]) => {
    const existed = existsSync(path);
    return {
      id,
      path,
      existed,
      mode: existed ? lstatSync(path).mode & 0o777 : 0o600,
      bytes: existed ? readBoundedFile(path, MAX_SOURCE_BYTES).toString("base64") : ""
    };
  });
}

// select a captured mode by fixed identity
function originalMode(originals, id) {
  return originals.find((entry) => entry.id === id)?.mode ?? 0o600;
}

// publish one exact file behind a durable write-ahead intent
function publishFile(path, bytes, mode, id, originals, written, beforeHashes, hashes, journalPath, request, options) {
  const original = originals.find((entry) => entry.id === id);
  // reject publication without an encrypted predecessor
  if (!original || written.includes(id)) {
    throw safeError("manual-recovery-required");
  }
  assertPublicationPredecessor(original);
  written.push(id);
  beforeHashes[id] = sha256(Buffer.from(original.bytes, "base64"));
  hashes[id] = sha256(bytes);
  // persist both legal filesystem identities before the atomic rename
  writeCloudflareJournal(journalPath, request, "committing", written, beforeHashes, hashes);
  atomicWriteFile(path, bytes, mode, {
    // close external edits after the write-ahead intent
    beforeRename: () => assertPublicationPredecessor(original)
  });
  options.afterCloudflarePublish?.(id);
}

// require the encrypted predecessor before forward publication
function assertPublicationPredecessor(original) {
  const exists = existsSync(original.path);
  // reject existence races without changing the external file
  if (exists !== original.existed) {
    throw safeError("source-conflict");
  }
  const current = exists ? readBoundedFile(original.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
  const mode = exists ? lstatSync(original.path).mode & 0o777 : original.mode;
  // reject content or mode drift before replacement
  if (sha256(current) !== sha256(Buffer.from(original.bytes, "base64")) || mode !== original.mode) {
    throw safeError("source-conflict");
  }
}

// restore only transaction-published exact bytes
function restorePublished(originals, written, beforeHashes, hashes) {
  // unwind publications in reverse order
  for (const id of [...written].reverse()) {
    const original = originals.find((entry) => entry.id === id);
    // reject unknown journal identities
    if (!original || typeof beforeHashes[id] !== "string" || typeof hashes[id] !== "string") {
      throw safeError("manual-recovery-required");
    }
    const exists = existsSync(original.path);
    const current = exists ? readBoundedFile(original.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
    const originalBytes = Buffer.from(original.bytes, "base64");
    // bind the public intent to its encrypted predecessor
    if (beforeHashes[id] !== sha256(originalBytes)) {
      throw safeError("manual-recovery-required");
    }
    // preserve an already-restored predecessor
    if (exists === original.existed && sha256(current) === sha256(originalBytes)) {
      continue;
    }
    // reject concurrent edits instead of overwriting them
    if (!exists || sha256(current) !== hashes[id]) {
      throw safeError("manual-recovery-required");
    }
    if (original.existed) {
      atomicWriteFile(original.path, originalBytes, original.mode);
    } else {
      inspectOwnedPath(original.path);
      unlinkSync(original.path);
    }
  }
}

// write a content-free durable transaction journal
function writeCloudflareJournal(path, request, phase, written, beforeHashes, hashes, receipt, cloudflare) {
  atomicWriteFile(path, `${JSON.stringify({
    version: PROTOCOL_VERSION,
    id: request.id,
    kind: "cloudflare",
    action: request.cloudflare.action,
    generation: request.generation,
    phase,
    written,
    beforeHashes,
    hashes,
    ...(receipt ? { receipt } : {}),
    ...(cloudflare ? { cloudflare } : {}),
    updatedAt: new Date().toISOString()
  })}\n`, 0o600);
}

// build one ordinary host receipt without secret material
function operationReceipt(descriptor, request) {
  const hashes = {};
  // retain only requested fixed source hashes
  for (const source of request.sources) {
    hashes[source.id] = sha256(readBoundedFile(descriptor.sources[source.id].path, MAX_SOURCE_BYTES));
  }
  return { operationId: request.id, generation: descriptor.generation, hashes, targets: [], completedAt: new Date().toISOString() };
}

// read the installer-owned recovery key
function recoveryKey(descriptor) {
  const key = readBoundedFile(resolve(descriptor.controlRoot, "recovery.key"), 32);
  // require the exact local encryption key size
  if (key.length !== 32) {
    throw safeError("recovery-unavailable");
  }
  return key;
}

// read optional private json state
function readOptionalJson(path) {
  // return absence without manufacturing state
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return readJsonFile(path, MAX_SOURCE_BYTES);
  } catch {
    throw safeError("cloudflare-state-invalid");
  }
}
