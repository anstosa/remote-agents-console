import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { runBounded, runQuiet } from "./command.mjs";
import { MAX_COMMAND_BYTES, MAX_SOURCE_BYTES } from "./constants.mjs";
import { prepareComposeDependencyInputs, projectComposeDependencies } from "./dependencies.mjs";
import { sha256 } from "./crypto.mjs";
import { atomicWriteFile, safeError } from "./fs.mjs";

// validate one candidate without executing its authored content
export async function validateCandidate(source, candidatePath, context = {}) {
  const bytes = readFileSync(candidatePath);
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw safeError("source-too-large");
  }
  switch (source.kind) {
    case "json":
      parseJson(bytes);
      break;
    case "credentials":
      validateCredentials(bytes);
      break;
    case "installation":
      validateInstallationSettings(bytes);
      break;
    case "env":
      validateEnv(bytes);
      break;
    case "wrapper":
      await validateWrapper(candidatePath, context.runner);
      break;
    case "svg":
      validateSvg(bytes);
      break;
    case "cloudflared":
      await validateCloudflared(candidatePath, context.runner);
      break;
    case "compose":
      break;
    default:
      throw safeError("unsupported-source");
  }
}

// parse JSON with one bounded failure
function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw safeError("invalid-json");
  }
}

// validate the known credential document shape
export function validateCredentials(bytes) {
  const value = parseJson(bytes);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.AccountTag !== "string" ||
    typeof value.TunnelSecret !== "string" ||
    typeof value.TunnelID !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.TunnelID) ||
    value.TunnelSecret.length < 16 ||
    Buffer.from(value.TunnelSecret, "base64").length < 16
  ) {
    throw safeError("invalid-credentials");
  }
}

// require Cloudflare config and credential identities to agree
export function validateCloudflarePair(configBytes, credentialBytes) {
  const credentials = parseJson(credentialBytes);
  validateCredentials(credentialBytes);
  const config = configBytes.toString("utf8");
  const match = /^\s*tunnel\s*:\s*["']?([0-9a-f-]{36})["']?\s*(?:#.*)?$/im.exec(config);
  if (!match || match[1].toLowerCase() !== credentials.TunnelID.toLowerCase()) {
    throw safeError("cloudflared-identity-mismatch");
  }
}

// require one exact native credential selector
export function validateCloudflareCredentialSelector(configBytes, expectedPath) {
  const text = configBytes.toString("utf8");
  // reject malformed text before selector matching
  if (text.includes("\0") || !Buffer.from(text).equals(configBytes)) {
    throw safeError("cloudflared-credential-selector-mismatch");
  }
  const pattern = /^\s*credentials-file\s*:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]+?))\s*(?:#.*)?$/gmu;
  const values = [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]?.trim());
  // require the desired host credential path exactly once
  if (values.length !== 1 || values[0] !== expectedPath) {
    throw safeError("cloudflared-credential-selector-mismatch");
  }
}

// validate the otherwise-ownerless selector source
export function validateInstallationSettings(bytes) {
  const value = parseJson(bytes);
  const allowedRoot = new Set(["version", "host", "native", "compose", "sources"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw safeError("invalid-installation-settings");
  }
  // reject hidden competing settings
  for (const key of Object.keys(value)) {
    if (!allowedRoot.has(key)) {
      throw safeError("invalid-installation-settings");
    }
  }
  if (value.host !== undefined && (!isRecord(value.host) || (value.host.checkout !== undefined && typeof value.host.checkout !== "string"))) {
    throw safeError("invalid-installation-settings");
  }
  if (value.native !== undefined) {
    if (!isRecord(value.native)) {
      throw safeError("invalid-installation-settings");
    }
    const allowed = new Set(["environmentFile", "cloudflaredConfig", "cloudflaredCredentials", "cloudflaredUnit"]);
    if (!Object.keys(value.native).every((key) => allowed.has(key)) || !Object.values(value.native).every((item) => typeof item === "string")) {
      throw safeError("invalid-installation-settings");
    }
  }
  if (value.compose !== undefined) {
    const compose = value.compose;
    const allowed = new Set(["projectDirectory", "projectName", "files", "envFiles", "profiles", "options"]);
    if (
      !isRecord(compose) ||
      !Object.keys(compose).every((key) => allowed.has(key)) ||
      (compose.projectDirectory !== undefined && typeof compose.projectDirectory !== "string") ||
      (compose.projectName !== undefined && typeof compose.projectName !== "string") ||
      !optionalStrings(compose.files) ||
      !optionalStrings(compose.envFiles) ||
      !optionalStrings(compose.profiles) ||
      (compose.options !== undefined && (
        !isRecord(compose.options) ||
        !Object.keys(compose.options).every((key) => ["parallel", "compatibility"].includes(key)) ||
        (compose.options.parallel !== undefined && (!Number.isInteger(compose.options.parallel) || compose.options.parallel !== -1 && (compose.options.parallel < 1 || compose.options.parallel > 64))) ||
        (compose.options.compatibility !== undefined && typeof compose.options.compatibility !== "boolean")
      ))
    ) {
      throw safeError("invalid-installation-settings");
    }
  }
  if (value.sources !== undefined) {
    const allowed = new Set(["wrapper", "icons"]);
    if (
      !isRecord(value.sources) ||
      !Object.keys(value.sources).every((key) => allowed.has(key)) ||
      (value.sources.wrapper !== undefined && typeof value.sources.wrapper !== "string") ||
      (value.sources.icons !== undefined && (
        !isRecord(value.sources.icons) ||
        !Object.keys(value.sources.icons).every((key) => new Set(["heart", "potato"]).has(key)) ||
        !Object.values(value.sources.icons).every((item) => typeof item === "string")
      ))
    ) {
      throw safeError("invalid-installation-settings");
    }
  }
}

// require one ordinary object
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// validate optional string lists
function optionalStrings(value) {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

// parse env syntax without mutating the helper environment
export function validateEnv(bytes) {
  const text = bytes.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text).equals(bytes)) {
    throw safeError("invalid-env");
  }
  try {
    const env = parseEnv(text);
    if (!env.RAC_PASSWORD_HASH || !env.RAC_PASSWORD_HASH.startsWith("$argon2id$")) {
      throw safeError("required-authentication-settings");
    }
    if (!env.RAC_SESSION_SECRET || !/^[A-Za-z0-9_-]+$/u.test(env.RAC_SESSION_SECRET) || Buffer.from(env.RAC_SESSION_SECRET, "base64url").length < 32) {
      throw safeError("required-authentication-settings");
    }
  } catch (error) {
    // preserve stable validation failures
    if (error?.code && error.message === error.code) {
      throw error;
    }
    throw safeError("invalid-env");
  }
}

// ask bash to parse but never run the wrapper
async function validateWrapper(path, runner = runQuiet) {
  await runner("bash", ["-n", path], { errorCode: "invalid-wrapper" });
}

// reject active SVG content before persistence
export function validateSvg(bytes) {
  const text = bytes.toString("utf8");
  // reject declarations, references and invalid utf8
  if (bytes.length === 0 || bytes.length > 256 * 1024 || text.includes("\0") || !Buffer.from(text).equals(bytes) || /<!|<\?|&|\b(?:href|style|on[a-z]+)\s*=|url\s*\(|(?:javascript|data):/iu.test(text)) {
    throw safeError("invalid-svg");
  }
  const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc"]);
  const attributes = new Set(["xmlns", "viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity", "transform", "id", "role", "aria-label"]);
  const stack = [];
  let end = 0;
  // validate each static markup token
  for (const match of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^<>]*?)\/?\s*>/gu)) {
    // allow text only within descriptions
    if (text.slice(end, match.index).trim() !== "" && !["title", "desc"].includes(stack.at(-1) ?? "")) {
      throw safeError("invalid-svg");
    }
    const name = match[1];
    if (!tags.has(name)) {
      throw safeError("invalid-svg");
    }
    // validate closing structure
    if (match[0].startsWith("</")) {
      if (stack.pop() !== name || match[2].trim() !== "") {
        throw safeError("invalid-svg");
      }
    } else {
      const rest = match[2].trim();
      let consumed = 0;
      // require quoted allowlisted attributes
      for (const attribute of rest.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*=\s*("[^"]*"|'[^']*')/gu)) {
        if (rest.slice(consumed, attribute.index).trim() !== "" || !attributes.has(attribute[1])) {
          throw safeError("invalid-svg");
        }
        consumed = attribute.index + attribute[0].length;
      }
      if (rest.slice(consumed).trim() !== "") {
        throw safeError("invalid-svg");
      }
      if (stack.length === 0 && (name !== "svg" || (end !== 0 && text.slice(0, end).trim() !== ""))) {
        throw safeError("invalid-svg");
      }
      if (!/\/\s*>$/u.test(match[0])) {
        stack.push(name);
      }
    }
    end = match.index + match[0].length;
  }
  // reject unparsed or unfinished markup
  if (end === 0 || stack.length !== 0 || text.slice(end).trim() !== "") {
    throw safeError("invalid-svg");
  }
}

// use the installed validator without pulling an image
async function validateCloudflared(path, runner = runQuiet) {
  await runner("cloudflared", ["tunnel", "--config", path, "ingress", "validate"], { errorCode: "invalid-cloudflared" });
}

// build the fixed Compose prefix
export function composePrefix(compose, files = compose.files, envFiles = compose.envFiles) {
  const args = ["compose"];
  if (compose.options?.parallel !== undefined) {
    args.push("--parallel", String(compose.options.parallel));
  }
  if (compose.options?.compatibility === true) {
    args.push("--compatibility");
  }
  args.push("--project-directory", compose.projectDirectory, "--project-name", compose.projectName);
  // preserve every explicit interpolation environment
  for (const envFile of envFiles) {
    args.push("--env-file", envFile);
  }
  // preserve active profile identity
  for (const profile of compose.profiles) {
    args.push("--profile", profile);
  }
  // preserve file merge order
  for (const file of files) {
    args.push("-f", file);
  }
  return args;
}

// run the probed two-pass candidate algorithm
export async function validateComposeCandidates(descriptor, candidates, stageDirectory, runner = runBounded) {
  const compose = descriptor.compose;
  const prepared = prepareComposeDependencyInputs(descriptor, candidates, stageDirectory);
  const baseline = await readComposeModel(compose, prepared.baselineFiles, prepared.baselineEnvFiles, runner);
  const model = prepared.distinctModelInputs
    ? await readComposeModel(compose, prepared.candidateFiles, prepared.candidateEnvFiles, runner)
    : structuredClone(baseline);
  const dependencySnapshot = projectComposeDependencies(prepared, baseline, model);
  const projected = resolve(stageDirectory, "compose-projected.json");
  atomicWriteFile(projected, `${JSON.stringify(model)}\n`, 0o600);
  const secondArgs = [...composePrefix(compose, [projected], prepared.candidateEnvFiles), "config", "--quiet"];
  const second = await runner("docker", secondArgs, { cwd: compose.projectDirectory, maxBytes: MAX_COMMAND_BYTES });
  // expose only one safe validation category
  if (second.code !== 0) {
    throw safeError("invalid-compose");
  }
  const resolvedModel = await readResolvedComposeModel(compose, projected, prepared.candidateEnvFiles, runner);
  const composeSelectors = composeSourceSelectors(descriptor, resolvedModel);
  validateComposeModel(resolvedModel, descriptorWithComposeSelectors(descriptor, composeSelectors));
  const environmentOwnership = composeEnvironmentOwnership(descriptor, candidates, model, resolvedModel);
  return { dependencySnapshot, composeSelectors, ...environmentOwnership };
}

// derive candidate-owned source identities from the resolved model
function composeSourceSelectors(descriptor, model) {
  const racEnvironment = model.services?.["remote-agent-console"]?.environment ?? {};
  const appServerPath = racEnvironment.RAC_CONFIG;
  const writeServerPath = racEnvironment.RAC_CONFIG_WRITE_PATH;
  if (typeof appServerPath !== "string" || appServerPath !== writeServerPath) {
    throw safeError("invalid-compose-invariants");
  }
  const selectors = {
    app: { path: mapWorkspacePath(descriptor.hostCheckout, appServerPath), serverPath: appServerPath }
  };
  const cloudflared = model.services?.cloudflared;
  const config = composeBindSource(cloudflared, "/etc/cloudflared/config.yml", descriptor.compose.projectDirectory);
  const credentials = composeBindSource(cloudflared, "/etc/cloudflared/credentials.json", descriptor.compose.projectDirectory);
  // retain only installed source identities
  if (config && descriptor.sources.cloudflared) {
    selectors.cloudflared = { path: config, serverPath: visibleWorkspacePath(descriptor.hostCheckout, config) };
  }
  if (credentials && descriptor.sources["cloudflared-credentials"]) {
    selectors["cloudflared-credentials"] = { path: credentials, serverPath: visibleWorkspacePath(descriptor.hostCheckout, credentials) };
  }
  return selectors;
}

// derive one normalized direct bind source
function composeBindSource(service, target, projectDirectory) {
  const volume = service?.volumes?.find((candidate) => candidate?.target === target);
  return volume?.type === "bind" && typeof volume.source === "string"
    ? resolve(projectDirectory, volume.source)
    : undefined;
}

// validate the model against its derived candidate identities
function descriptorWithComposeSelectors(descriptor, selectors) {
  const sources = { ...descriptor.sources };
  // replace each privately derived source path
  for (const [id, selector] of Object.entries(selectors)) {
    sources[id] = { ...sources[id], ...selector };
  }
  return { ...descriptor, sources };
}

// map container-visible app paths through the fixed workspace bind
function mapWorkspacePath(hostCheckout, serverPath) {
  if (serverPath === "/workspace") {
    return hostCheckout;
  }
  if (!serverPath.startsWith("/workspace/")) {
    throw safeError("unsupported-server-path");
  }
  return resolve(hostCheckout, serverPath.slice("/workspace/".length));
}

// expose host paths to the server only through its workspace bind
function visibleWorkspacePath(hostCheckout, path) {
  return path.startsWith(`${hostCheckout}/`) ? `/workspace/${path.slice(hostCheckout.length + 1)}` : undefined;
}

// derive value-free ownership proof for every selected env key
function composeEnvironmentOwnership(descriptor, candidates, model, resolvedModel) {
  const currentPath = descriptor.sources.env?.path;
  // skip installations without an env source
  if (!currentPath) {
    return { winningEnvironment: {}, shadowedEnvironmentKeys: [], environmentFileHashes: {} };
  }
  let current;
  let candidate;
  try {
    current = parseEnv(readFileSync(currentPath, "utf8"));
    candidate = candidates.has("env") ? parseEnv(readFileSync(candidates.get("env"), "utf8")) : current;
  } catch {
    throw safeError("invalid-compose-environment");
  }
  const explicit = model.services?.["remote-agent-console"]?.environment ?? {};
  const keys = new Set([...Object.keys(current), ...Object.keys(candidate), ...Object.keys(explicit)]);
  // bound private ownership metadata
  if (keys.size > 8_192) {
    throw safeError("too-many-environment-keys");
  }
  const resolved = resolvedModel.services?.["remote-agent-console"]?.environment ?? {};
  const winningEnvironment = {};
  const shadowedEnvironmentKeys = [];
  const environmentFileHashes = {};
  // retain hashes and value-free ownership only
  for (const key of keys) {
    const candidatePresent = Object.hasOwn(candidate, key);
    const candidateChanged = current[key] !== candidate[key];
    const explicitlyShadowed = Object.hasOwn(explicit, key) && !environmentValueDependsOnKey(explicit[key], key);
    // record only proven independent keys
    if (explicitlyShadowed) {
      shadowedEnvironmentKeys.push(key);
    }
    // hash only selected logical values
    if (candidatePresent) {
      environmentFileHashes[key] = sha256(Buffer.from(candidate[key], "utf8"));
    }
    // omit unchanged winning metadata
    if (!candidateChanged) {
      continue;
    }
    const winning = Object.hasOwn(resolved, key) ? renderedEnvironmentValue(resolved[key]) : undefined;
    const candidateWins = !explicitlyShadowed && (candidatePresent ? winning === candidate[key] : winning === undefined);
    winningEnvironment[key] = { candidatePresent, candidateChanged, candidateWins, explicitlyShadowed };
  }
  shadowedEnvironmentKeys.sort();
  return { winningEnvironment, shadowedEnvironmentKeys, environmentFileHashes };
}

// detect only live self-references in explicit Compose environment values
function environmentValueDependsOnKey(value, key) {
  // null environment entries inherit values
  if (value === null || value === undefined) {
    return true;
  }
  // normalized scalar values are fixed
  if (typeof value !== "string") {
    return false;
  }
  // scan Compose dollar expressions without treating escaped dollars as input
  for (let index = 0; index < value.length; index += 1) {
    // skip ordinary characters
    if (value[index] !== "$") {
      continue;
    }
    // skip escaped dollar pairs
    if (value[index + 1] === "$") {
      index += 1;
      continue;
    }
    // inspect braced variable names
    if (value[index + 1] === "{") {
      const end = value.indexOf("}", index + 2);
      // fail closed on malformed interpolation
      if (end === -1) {
        return true;
      }
      const name = /^[_A-Za-z][_A-Za-z0-9]*/u.exec(value.slice(index + 2, end))?.[0];
      // match only the selected env key
      if (name === key) {
        return true;
      }
      continue;
    }
    const name = /^[_A-Za-z][_A-Za-z0-9]*/u.exec(value.slice(index + 1))?.[0];
    // match unbraced self references
    if (name === key) {
      return true;
    }
    // skip the parsed variable name
    if (name) {
      index += name.length;
    }
  }
  return false;
}

// render one normalized model without resolving dependency content
async function readComposeModel(compose, files, envFiles, runner) {
  const args = [
    ...composePrefix(compose, files, envFiles),
    "config",
    "--no-interpolate",
    "--no-env-resolution",
    "--format",
    "json"
  ];
  const result = await runner("docker", args, { cwd: compose.projectDirectory, maxBytes: MAX_COMMAND_BYTES });
  // expose only one safe validation category
  if (result.code !== 0) {
    throw safeError("invalid-compose");
  }
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw safeError("invalid-compose");
  }
}

// inspect the fully resolved private projection for fixed invariants
async function readResolvedComposeModel(compose, projected, envFiles, runner) {
  const args = [...composePrefix(compose, [projected], envFiles), "config", "--format", "json"];
  const result = await runner("docker", args, { cwd: compose.projectDirectory, maxBytes: MAX_COMMAND_BYTES });
  // expose only one safe validation category
  if (result.code !== 0) {
    throw safeError("invalid-compose");
  }
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw safeError("invalid-compose");
  }
}

// enforce installation invariants on normalized Compose JSON
export function validateComposeModel(model, descriptor) {
  const rac = model.services?.["remote-agent-console"];
  if (!rac || !rac.healthcheck) {
    throw safeError("invalid-compose-invariants");
  }
  const volumes = Array.isArray(rac.volumes) ? rac.volumes : [];
  const workspace = volumes.find((volume) => volume?.target === "/workspace");
  const control = volumes.find((volume) => volume?.target === "/run/rac-settings-control");
  if (
    !workspace ||
    workspace.read_only === true ||
    resolve(descriptor.compose.projectDirectory, workspace.source ?? "") !== descriptor.hostCheckout ||
    !control ||
    control.read_only === true ||
    resolve(descriptor.compose.projectDirectory, control.source ?? "") !== descriptor.hostControlRoot
  ) {
    throw safeError("invalid-compose-invariants");
  }
  const allVolumes = Object.values(model.services ?? {}).flatMap((service) => Array.isArray(service.volumes) ? service.volumes : []);
  if (allVolumes.some((volume) => `${volume?.source ?? ""} ${volume?.target ?? ""}`.includes("docker.sock"))) {
    throw safeError("invalid-compose-invariants");
  }
  const environment = rac.environment ?? {};
  const passwordHash = renderedEnvironmentValue(environment.RAC_PASSWORD_HASH);
  if (
    environment.RAC_CONFIG !== environment.RAC_CONFIG_WRITE_PATH ||
    environment.RAC_SERVER_CHECKOUT !== descriptor.serverCheckout ||
    typeof passwordHash !== "string" ||
    !passwordHash.startsWith("$argon2id$") ||
    typeof environment.RAC_SESSION_SECRET !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(environment.RAC_SESSION_SECRET) ||
    Buffer.from(environment.RAC_SESSION_SECRET, "base64url").length < 32
  ) {
    throw safeError("invalid-compose-invariants");
  }
  if (descriptor.sources.cloudflared) {
    const tunnel = model.services?.cloudflared;
    const config = tunnel?.volumes?.find((volume) => volume?.target === "/etc/cloudflared/config.yml");
    const credentials = tunnel?.volumes?.find((volume) => volume?.target === "/etc/cloudflared/credentials.json");
    if (
      !tunnel ||
      config?.type !== "bind" ||
      config.read_only !== true ||
      resolve(descriptor.compose.projectDirectory, config.source ?? "") !== descriptor.sources.cloudflared.path ||
      descriptor.sources["cloudflared-credentials"] && (
        credentials?.type !== "bind" ||
        credentials.read_only !== true ||
        resolve(descriptor.compose.projectDirectory, credentials.source ?? "") !== descriptor.sources["cloudflared-credentials"].path
      )
    ) {
      throw safeError("invalid-compose-invariants");
    }
  }
}

// reverse Compose config dollar escaping for validation only
export function renderedEnvironmentValue(value) {
  return typeof value === "string" ? value.replaceAll("$$", "$") : value;
}

// identify a source candidate by fixed id
export function candidateMapFromRequest(descriptor, request, resolver) {
  const candidates = new Map();
  // resolve each request stage once
  for (const source of request.sources ?? []) {
    if (!source.remove) {
      candidates.set(source.id, resolver(source.candidate));
    }
  }
  return candidates;
}
