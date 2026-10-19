import { basename, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { parseEnv } from "node:util";
import { MAX_COMMAND_BYTES, MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "./constants.mjs";
import { runBounded } from "./command.mjs";
import { sha256 } from "./crypto.mjs";
import { readBoundedFile, readJsonFile, safeError } from "./fs.mjs";
import { composePrefix, renderedEnvironmentValue, validateCloudflareCredentialSelector } from "./validate.mjs";

const CONTAINER_ID = /^[0-9a-f]{12,64}$/u;
const INSPECT_FORMAT = "{{.State.Running}}\n{{if .State.Health}}{{.State.Health.Status}}{{end}}\n{{index .Config.Labels \"com.docker.compose.project\"}}\n{{index .Config.Labels \"com.docker.compose.service\"}}\n{{json .Mounts}}";
const CLOUD_PATHS = new Map([
  ["cloudflared", "/etc/cloudflared/config.yml"],
  ["cloudflared-credentials", "/etc/cloudflared/credentials.json"]
]);

// prove the current target without replacing it
export async function proveInitialTargetBaseline(descriptor, target, options = {}) {
  try {
    const hashes = sourceHashes(descriptor);
    // permit deterministic proof injection only through direct helper callers
    if (options.baselineProve) {
      const injected = await options.baselineProve(descriptor, target);
      return { ...injected, hashes };
    }
    if (target === "rac") {
      return { ...await proveRacBaseline(descriptor, hashes, options), hashes };
    }
    if (target === "cloudflared") {
      return { ...await proveCloudflaredBaseline(descriptor, hashes, options), hashes };
    }
    throw safeError("baseline-required");
  } catch {
    throw safeError("baseline-required");
  }
}

// prove the running RAC boot against every locally visible source
async function proveRacBaseline(descriptor, hashes, options) {
  await proveRacService(descriptor, options.runner ?? runBounded);
  const boot = readJsonFile(resolve(descriptor.controlRoot, "boot.json"), 2 * MAX_SOURCE_BYTES);
  // require the active installation identity
  if (
    boot.version !== PROTOCOL_VERSION ||
    boot.generation !== descriptor.generation ||
    typeof boot.bootNonce !== "string" ||
    !boot.hashes ||
    typeof boot.hashes !== "object"
  ) {
    throw safeError("baseline-required");
  }
  // match every source the running process could attest
  for (const [id, source] of Object.entries(descriptor.sources)) {
    if (source.serverPath !== undefined && boot.hashes[id] !== hashes[id]) {
      throw safeError("baseline-required");
    }
  }
  const environmentProof = await proveEnvironment(descriptor, boot, options);
  const healthy = options.healthProbe
    ? await options.healthProbe(boot.listen)
    : await probeLocalHealth(boot.listen);
  // require the exact boot to answer locally
  if (!healthy) {
    throw safeError("baseline-required");
  }
  return {
    bootNonce: boot.bootNonce,
    ...(boot.semanticHashes ? { semanticHashes: boot.semanticHashes } : {}),
    environmentHashes: boot.environmentHashes,
    ...environmentProof
  };
}

// prove the fixed RAC service identity
async function proveRacService(descriptor, runner) {
  if (descriptor.kind === "systemd") {
    await requireSuccess(await runner("systemctl", ["--user", "is-active", "--quiet", descriptor.native.unit], { maxBytes: 1024 }));
    const files = await runner("systemctl", ["--user", "show", descriptor.native.unit, "--property=EnvironmentFiles", "--value"], { maxBytes: MAX_SOURCE_BYTES });
    // require the immutable environment selector in the effective unit
    if (files.code !== 0 || !files.stdout.toString("utf8").includes(descriptor.native.environmentFile)) {
      throw safeError("baseline-required");
    }
    return;
  }
  await inspectComposeContainer(descriptor, "remote-agent-console", runner, true);
}

// prove file-owned and winning environment values
async function proveEnvironment(descriptor, boot, options) {
  if (!boot.environmentHashes || typeof boot.environmentHashes !== "object") {
    throw safeError("baseline-required");
  }
  const fileValues = parseEnv(readBoundedFile(descriptor.sources.env.path, MAX_SOURCE_BYTES).toString("utf8"));
  const environmentFileHashes = hashValues(fileValues);
  // require the running process to attest the exact selected file values
  if (!sameHashes(boot.environmentFileHashes, environmentFileHashes)) {
    throw safeError("baseline-required");
  }
  if (descriptor.kind === "compose") {
    const runner = options.runner ?? runBounded;
    const rendered = await runner("docker", [...composePrefix(descriptor.compose), "config", "--format", "json"], {
      cwd: descriptor.compose.projectDirectory,
      maxBytes: MAX_COMMAND_BYTES
    });
    if (rendered.code !== 0) {
      throw safeError("baseline-required");
    }
    let model;
    try {
      model = JSON.parse(rendered.stdout.toString("utf8"));
    } catch {
      throw safeError("baseline-required");
    }
    const winning = hashValues(model.services?.["remote-agent-console"]?.environment ?? {}, true);
    // require every rendered winning value in the current process
    if (!hashSubset(boot.environmentHashes, winning)) {
      throw safeError("baseline-required");
    }
  } else if (!Object.keys(environmentFileHashes).every((key) => typeof boot.environmentHashes[key] === "string")) {
    throw safeError("baseline-required");
  }
  const shadowedEnvironmentKeys = Object.keys(environmentFileHashes)
    .filter((key) => boot.environmentHashes[key] !== environmentFileHashes[key])
    .sort();
  return { environmentFileHashes, ...(shadowedEnvironmentKeys.length ? { shadowedEnvironmentKeys } : {}) };
}

// prove an active or intentionally stopped Cloudflare target
async function proveCloudflaredBaseline(descriptor, hashes, options) {
  const runner = options.runner ?? runBounded;
  // prove native consumption without replacing the running unit
  if (descriptor.kind === "systemd") {
    return proveNativeCloudflaredBaseline(descriptor, hashes, options, runner);
  }
  if (!descriptor.sources.cloudflared) {
    throw safeError("baseline-required");
  }
  const enabled = descriptor.compose.profiles.includes("tunnel");
  const prefix = enabled
    ? composePrefix(descriptor.compose)
    : composePrefix({ ...descriptor.compose, profiles: [...descriptor.compose.profiles, "tunnel"] });
  const listed = await runner("docker", [...prefix, "ps", "-q", "cloudflared"], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: 1024
  });
  const containerId = listed.stdout.toString("utf8").trim();
  // prove an intentionally dormant target by exact absence
  if (!enabled && listed.code === 0 && containerId === "") {
    return { targetProofs: { cloudflared: { stopped: true } } };
  }
  if (!enabled || listed.code !== 0 || !CONTAINER_ID.test(containerId)) {
    throw safeError("baseline-required");
  }
  const inspected = await inspectContainer(descriptor, "cloudflared", containerId, runner, true);
  const consumedSources = {};
  // prove every configured direct bind through container-consumed bytes
  for (const [id, containerPath] of CLOUD_PATHS) {
    const source = descriptor.sources[id];
    if (!source) {
      continue;
    }
    assertReadOnlyBind(inspected.mounts, source.path, containerPath);
    const copied = await runner("docker", ["cp", `${containerId}:${containerPath}`, "-"], {
      maxBytes: MAX_SOURCE_BYTES + 64 * 1024
    });
    if (copied.code !== 0) {
      throw safeError("baseline-required");
    }
    const consumed = extractDockerCopyPayload(copied.stdout);
    hashes[id] = sha256(consumed);
    consumedSources[id] = consumed.toString("base64");
  }
  return { consumedSources, targetProofs: { cloudflared: { containerId } } };
}

// prove one fixed native cloudflared process and its unchanged inputs
async function proveNativeCloudflaredBaseline(descriptor, hashes, options, runner) {
  const unit = descriptor.native.cloudflaredUnit;
  const configSource = descriptor.sources.cloudflared;
  const credentialSource = descriptor.sources["cloudflared-credentials"];
  // require the complete immutable native target
  if (!unit || !configSource || !credentialSource) {
    throw safeError("baseline-required");
  }
  const firstService = await readNativeServiceState(unit, runner, options);
  const procRoot = options.procRoot ?? "/proc";
  const processRoot = resolve(procRoot, String(firstService.pid));
  const firstProcess = readProcessIdentity(processRoot, firstService.pid);
  const configBefore = stableFileIdentity(configSource.path);
  const credentialsBefore = stableFileIdentity(credentialSource.path);
  const startNanoseconds = BigInt(firstService.startedAt) * 1_000_000n;
  // reject inputs whose inode metadata changed after process consumption
  if (configBefore.ctimeNs > startNanoseconds || credentialsBefore.ctimeNs > startNanoseconds) {
    throw safeError("baseline-required");
  }
  const configBytes = readBoundedFile(configSource.path, MAX_SOURCE_BYTES);
  const credentialBytes = readBoundedFile(credentialSource.path, MAX_SOURCE_BYTES);
  const command = parseCloudflaredCommand(firstProcess.command, configSource.path, credentialSource.path);
  validateCloudflareCredentialSelector(configBytes, credentialSource.path);
  const configuredMetrics = command.metrics ?? parseYamlScalar(configBytes, "metrics", false);
  // require configured readiness to answer on loopback
  if (configuredMetrics) {
    const listen = parseMetricsListen(configuredMetrics);
    const healthy = options.cloudflaredHealthProbe
      ? await options.cloudflaredHealthProbe(listen)
      : await probeCloudflaredHealth(listen);
    // reject an unready configured endpoint
    if (!healthy) {
      throw safeError("baseline-required");
    }
  }
  const secondProcess = readProcessIdentity(processRoot, firstService.pid);
  const secondService = await readNativeServiceState(unit, runner, options);
  const configAfter = stableFileIdentity(configSource.path);
  const credentialsAfter = stableFileIdentity(credentialSource.path);
  // close PID reuse and source replacement races after bounded reads
  if (
    secondService.pid !== firstService.pid ||
    secondService.startedAt !== firstService.startedAt ||
    secondProcess.startTicks !== firstProcess.startTicks ||
    secondProcess.commandHash !== firstProcess.commandHash ||
    !sameFileIdentity(configBefore, configAfter) ||
    !sameFileIdentity(credentialsBefore, credentialsAfter)
  ) {
    throw safeError("baseline-required");
  }
  hashes.cloudflared = sha256(configBytes);
  hashes["cloudflared-credentials"] = sha256(credentialBytes);
  return {
    nativeCommand: [...firstProcess.command],
    targetProofs: {
      cloudflared: {
        unit,
        pid: firstService.pid,
        startedAt: firstService.startedAt
      }
    }
  };
}

// retarget only proven native cloudflared selector arguments
export function retargetNativeCloudflaredCommand(command, activeDescriptor, desiredDescriptor) {
  // bound the private argv before reuse
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 256 ||
    !command.every((value) => typeof value === "string" && value.length <= 16 * 1024 && !/[\0\r\n]/u.test(value)) ||
    command.reduce((total, value) => total + Buffer.byteLength(value), 0) > 64 * 1024
  ) {
    throw safeError("cloudflared-command-proof-unavailable");
  }
  const activeConfig = activeDescriptor.sources.cloudflared?.path;
  const activeCredentials = activeDescriptor.sources["cloudflared-credentials"]?.path;
  const desiredConfig = desiredDescriptor.sources.cloudflared?.path;
  const desiredCredentials = desiredDescriptor.sources["cloudflared-credentials"]?.path;
  // require complete fixed native source identities
  if (!activeConfig || !activeCredentials || !desiredConfig || !desiredCredentials) {
    throw safeError("cloudflared-command-proof-unavailable");
  }
  const parsed = parseCloudflaredCommand(command, activeConfig, activeCredentials);
  let updated = replaceCommandOption(command, "--config", desiredConfig, true);
  // preserve an explicitly proven credential option when present
  if (parsed.credentials !== undefined) {
    updated = replaceCommandOption(updated, "--credentials-file", desiredCredentials, true);
  }
  parseCloudflaredCommand(updated, desiredConfig, desiredCredentials);
  return updated;
}

// replace one already validated argv selector without shell parsing
function replaceCommandOption(command, name, value, required) {
  const updated = [...command];
  let replacements = 0;
  // preserve the proven option representation and argument order
  for (let index = 1; index < updated.length; index += 1) {
    // replace one separated selector value
    if (updated[index] === name && index + 1 < updated.length) {
      updated[index + 1] = value;
      replacements += 1;
      index += 1;
    // replace one joined selector value
    } else if (updated[index].startsWith(`${name}=`)) {
      updated[index] = `${name}=${value}`;
      replacements += 1;
    }
  }
  // reject missing or duplicate proof selectors
  if (replacements !== 1 && (required || replacements !== 0)) {
    throw safeError("cloudflared-command-proof-unavailable");
  }
  return updated;
}

// read exact active unit identity without exposing its command or environment
async function readNativeServiceState(unit, runner, options) {
  const result = await runner("systemctl", [
    "--user",
    "show",
    unit,
    "--property=MainPID",
    "--property=ActiveState",
    "--property=SubState",
    "--property=ExecMainStartTimestamp",
    "--no-pager"
  ], { maxBytes: 8 * 1024 });
  // require one readable fixed unit
  if (result.code !== 0) {
    throw safeError("baseline-required");
  }
  const properties = parseProperties(result.stdout);
  const pid = Number(properties.MainPID);
  const startedAt = Date.parse(properties.ExecMainStartTimestamp ?? "");
  const now = options.now?.() ?? Date.now();
  // require an active nonfuture main process
  if (
    properties.ActiveState !== "active" ||
    properties.SubState !== "running" ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !Number.isSafeInteger(startedAt) ||
    startedAt > now + 1_000
  ) {
    throw safeError("baseline-required");
  }
  return { pid, startedAt };
}

// parse bounded systemd properties
function parseProperties(bytes) {
  const properties = {};
  // retain only exact key-value lines
  for (const line of bytes.toString("utf8").split("\n")) {
    const separator = line.indexOf("=");
    // skip only nonproperty lines
    if (separator <= 0) {
      continue;
    }
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

// read stable process command and kernel start identity
function readProcessIdentity(processRoot, expectedPid) {
  const commandBytes = readBoundedFile(resolve(processRoot, "cmdline"), 64 * 1024);
  const command = commandBytes.toString("utf8").split("\0").filter(Boolean);
  const stat = readBoundedFile(resolve(processRoot, "stat"), 16 * 1024).toString("utf8");
  const match = /^(\d+) \(.*\) [A-Z] (.*)$/u.exec(stat.trim());
  const fields = match?.[2].split(" ");
  // require the selected live PID and start tick
  if (Number(match?.[1]) !== expectedPid || !fields || !/^\d+$/u.test(fields[18] ?? "") || command.length === 0) {
    throw safeError("baseline-required");
  }
  return { command, commandHash: sha256(commandBytes), startTicks: fields[18] };
}

// require fixed cloudflared selectors in the actual process argv
function parseCloudflaredCommand(command, configPath, credentialPath) {
  // require the expected daemon command shape
  if (basename(command[0]) !== "cloudflared" || !command.includes("tunnel") || !command.includes("run")) {
    throw safeError("baseline-required");
  }
  const selectedConfig = commandOption(command, "--config", true);
  const selectedCredentials = commandOption(command, "--credentials-file", false);
  const metrics = commandOption(command, "--metrics", false);
  // reject selector overrides to other sources
  if (selectedConfig !== configPath || selectedCredentials && selectedCredentials !== credentialPath) {
    throw safeError("baseline-required");
  }
  return { credentials: selectedCredentials, metrics };
}

// extract one unambiguous command option
function commandOption(command, name, required) {
  const values = [];
  // inspect every fixed argv token
  for (let index = 1; index < command.length; index += 1) {
    // accept the separated option form
    if (command[index] === name && index + 1 < command.length) {
      values.push(command[index + 1]);
      index += 1;
    // accept the joined option form
    } else if (command[index].startsWith(`${name}=`)) {
      values.push(command[index].slice(name.length + 1));
    }
  }
  // reject missing or duplicate selectors
  if (values.length !== 1 && (required || values.length !== 0)) {
    throw safeError("baseline-required");
  }
  return values[0];
}

// extract one plain YAML scalar without interpreting authored tags
function parseYamlScalar(bytes, key, required) {
  const text = bytes.toString("utf8");
  // reject malformed text before matching selectors
  if (text.includes("\0") || !Buffer.from(text).equals(bytes)) {
    throw safeError("baseline-required");
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^#\\r\\n]+?))\\s*(?:#.*)?$`, "gmu");
  const values = [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]?.trim());
  // reject missing or duplicate config selectors
  if (values.length !== 1 && (required || values.length !== 0)) {
    throw safeError("baseline-required");
  }
  return values[0];
}

// reduce configured metrics to one loopback endpoint
function parseMetricsListen(value) {
  const match = /^(?:http:\/\/)?(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/u.exec(value);
  const port = Number(match?.[2]);
  // reject nonloopback or invalid endpoints
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw safeError("baseline-required");
  }
  return { host: match[1] === "[::1]" ? "::1" : match[1], port };
}

// probe only the configured local cloudflared readiness endpoint
async function probeCloudflaredHealth(listen) {
  try {
    const host = listen.host === "::1" ? "[::1]" : listen.host;
    const response = await fetch(`http://${host}:${listen.port}/ready`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// capture one source inode identity with nanosecond timestamps
function stableFileIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  // reject directories and substituted source types
  if (!stat.isFile()) {
    throw safeError("baseline-required");
  }
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

// compare one source identity before and after proof
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

// inspect only nonsecret container identity and mount metadata
async function inspectComposeContainer(descriptor, service, runner, requireHealthy) {
  const listed = await runner("docker", [...composePrefix(descriptor.compose), "ps", "-q", service], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: 1024
  });
  const containerId = listed.stdout.toString("utf8").trim();
  if (listed.code !== 0 || !CONTAINER_ID.test(containerId)) {
    throw safeError("baseline-required");
  }
  await inspectContainer(descriptor, service, containerId, runner, requireHealthy);
  return containerId;
}

// inspect one exact Compose-owned running container
async function inspectContainer(descriptor, service, containerId, runner, requireHealthy) {
  const result = await runner("docker", ["inspect", "--format", INSPECT_FORMAT, containerId], { maxBytes: MAX_SOURCE_BYTES });
  if (result.code !== 0) {
    throw safeError("baseline-required");
  }
  const [running, health, project, actualService, ...mountLines] = result.stdout.toString("utf8").split("\n");
  let mounts;
  try {
    mounts = JSON.parse(mountLines.join("\n").trim());
  } catch {
    throw safeError("baseline-required");
  }
  if (
    running !== "true" ||
    project !== descriptor.compose.projectName ||
    actualService !== service ||
    !Array.isArray(mounts) ||
    (requireHealthy && health !== "" && health !== "healthy")
  ) {
    throw safeError("baseline-required");
  }
  return { containerId, mounts };
}

// require one exact read-only bind identity
function assertReadOnlyBind(mounts, sourcePath, destination) {
  const matches = mounts.filter((mount) => mount?.Type === "bind" && mount.Destination === destination);
  if (
    matches.length !== 1 ||
    matches[0].RW !== false ||
    typeof matches[0].Source !== "string" ||
    realpathSync(matches[0].Source) !== sourcePath
  ) {
    throw safeError("baseline-required");
  }
}

// extract one regular payload from Docker's private tar stream
export function extractDockerCopyPayload(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_SOURCE_BYTES + 64 * 1024) {
    throw safeError("baseline-required");
  }
  const files = [];
  let offset = 0;
  // parse every bounded tar entry
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    // stop at the end marker
    if (header.every((byte) => byte === 0)) {
      break;
    }
    validateTarChecksum(header);
    const size = parseTarOctal(header.subarray(124, 136));
    const type = header[156];
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length || size > MAX_SOURCE_BYTES) {
      throw safeError("baseline-required");
    }
    // retain only ordinary file content
    if (type === 0 || type === 48) {
      files.push(archive.subarray(contentStart, contentEnd));
    } else if (![53, 103, 120, 76, 75].includes(type)) {
      throw safeError("baseline-required");
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (files.length !== 1) {
    throw safeError("baseline-required");
  }
  return Buffer.from(files[0]);
}

// validate one unsigned POSIX tar checksum
function validateTarChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156));
  let actual = 0;
  // checksum with the checksum field treated as spaces
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) {
    throw safeError("baseline-required");
  }
}

// parse one bounded tar octal field
function parseTarOctal(field) {
  const text = field.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw safeError("baseline-required");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw safeError("baseline-required");
  }
  return value;
}

// hash current source bytes without disclosure
function sourceHashes(descriptor) {
  return Object.fromEntries(Object.entries(descriptor.sources).map(([id, source]) => [
    id,
    sha256(existsSync(source.path) ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0))
  ]));
}

// hash selected logical environment values
function hashValues(values, composeRendered = false) {
  return Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [key, sha256(Buffer.from(String(composeRendered ? renderedEnvironmentValue(value) : value), "utf8"))]));
}

// compare exact hash maps
function sameHashes(actual, expected) {
  if (!actual || typeof actual !== "object") {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) => actualKeys[index] === key && actual[key] === expected[key]);
}

// compare an expected subset against actual hashes
function hashSubset(actual, expected) {
  return Object.entries(expected).every(([key, hash]) => actual[key] === hash);
}

// probe only the attested loopback listener
async function probeLocalHealth(listen) {
  if (!listen || !["127.0.0.1", "::1", "localhost"].includes(listen.host) || !Number.isInteger(listen.port)) {
    return false;
  }
  try {
    const host = listen.host === "::1" ? "[::1]" : listen.host;
    const response = await fetch(`http://${host}:${listen.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// require one silent command success
async function requireSuccess(result) {
  if (result.code !== 0) {
    throw safeError("baseline-required");
  }
}
