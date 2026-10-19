import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "./constants.mjs";
import { assertAllowedSource, atomicWriteFile, inspectOwnedPath, readBoundedFile, safeError } from "./fs.mjs";

const MAX_DEPENDENCIES = 512;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const UNSUPPORTED_GRAPH_KEY = /(?:^[ \t]*(?:-\s*)?|[,{][ \t]*)["']?(?:include|extends|label_file)["']?\s*:/mu;
const UNSUPPORTED_EXPLICIT_KEY = /^[ \t]*\?[ \t]*["']?(?:include|extends|label_file)["']?[ \t]*$/mu;
const DYNAMIC_MAPPING_KEY = /^(?:[ \t]*\?[ \t]*)?(?:\*[A-Za-z0-9_-]+|"[^"\n]*\\[^"\n]*"|'[^'\n]*\\[^'\n]*')[ \t]*:/mu;
const UNSUPPORTED_KEYS = new Set(["include", "extends", "label_file"]);

// reject installed graphs the fixed validator cannot enumerate
export function preflightComposeDependencyGraph(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 16) {
    throw safeError("unsupported-compose-dependency");
  }
  // inspect every installed Compose source before activation
  for (const path of files) {
    if (typeof path !== "string" || hasUnsupportedGraph(readSelected(path))) {
      throw safeError("unsupported-compose-dependency");
    }
  }
}

// stage direct inputs before Compose can inspect them
export function prepareComposeDependencyInputs(descriptor, candidates, stageRoot) {
  const dependencyRoot = resolve(stageRoot, "compose-dependencies");
  mkdirSync(dependencyRoot, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(stageRoot);
  requirePrivateDirectory(dependencyRoot);
  const context = {
    descriptor,
    candidates,
    dependencyRoot,
    live: new Map(),
    records: new Map(),
    staged: new Map(),
    sourceIds: sourceIdsByPath(descriptor),
    sequence: 0
  };
  const baselineFiles = descriptor.compose.files.map((path) => stageDirectInput(context, "compose-file", path, false, ".yaml"));
  const candidateFiles = descriptor.compose.files.map((path) => stageDirectInput(context, "compose-file", path, true, ".yaml"));
  const baselineEnvFiles = descriptor.compose.envFiles.map((path) => stageDirectInput(context, "interpolation-env", path, false, ".env"));
  const candidateEnvFiles = descriptor.compose.envFiles.map((path) => stageDirectInput(context, "interpolation-env", path, true, ".env"));
  return {
    context,
    baselineFiles,
    candidateFiles,
    baselineEnvFiles,
    candidateEnvFiles,
    baselineInterpolation: interpolationEnvironment(baselineEnvFiles),
    candidateInterpolation: interpolationEnvironment(candidateEnvFiles),
    // rerender every changed authored or interpolation input
    distinctModelInputs: [...descriptor.compose.files, ...descriptor.compose.envFiles]
      .some((path) => selectedPath(context, path) !== canonicalDependencyPath(context, path))
  };
}

// require a helper-private staging directory
function requirePrivateDirectory(path) {
  try {
    const inspected = inspectOwnedPath(path, { regular: false, writable: true });
    // reject disclosure through group or public bits
    if ((inspected.stat.mode & 0o077) !== 0) {
      throw safeError("unsafe-compose-stage");
    }
  } catch (error) {
    if (error?.code === "unsafe-compose-stage") {
      throw error;
    }
    throw safeError("unsafe-compose-stage");
  }
}

// replace every normalized file dependency with one private snapshot
export function projectComposeDependencies(prepared, baselineModel, candidateModel) {
  const { context } = prepared;
  const baseline = collectModelDependencies(baselineModel, context, prepared.baselineInterpolation);
  const baselineKeys = new Set(baseline.map((entry) => dependencyKey(entry.kind, entry.path)));
  const baselinePaths = new Set(baseline.map((entry) => entry.path));
  const dependencies = collectModelDependencies(candidateModel, context, prepared.candidateInterpolation);
  projectBindVolumeSources(candidateModel, context, prepared.candidateInterpolation);
  // project each candidate dependency without rereading live state
  for (const dependency of dependencies) {
    const sourceId = context.sourceIds.get(dependency.path);
    const approved = baselineKeys.has(dependencyKey(dependency.kind, dependency.path)) || baselinePaths.has(dependency.path) || sourceId !== undefined;
    // reject graph expansion without an installed identity
    if (!approved) {
      throw safeError("unmapped-compose-dependency");
    }
    const inputPath = sourceId && context.candidates.has(sourceId)
      ? context.candidates.get(sourceId)
      : dependency.path;
    dependency.assign(stageSelected(context, dependency.kind, dependency.path, inputPath, ".data"));
  }
  const snapshot = composeDependencySnapshot(context);
  atomicWriteFile(resolve(context.dependencyRoot, "snapshot.json"), `${JSON.stringify(snapshot)}\n`, 0o600);
  verifyComposeDependencies(snapshot, context.descriptor);
  return snapshot;
}

// resolve normalized bind templates before validating the private projection
function projectBindVolumeSources(model, context, interpolation) {
  const services = model.services ?? {};
  // inspect every normalized service
  for (const service of Object.values(services)) {
    const volumes = Array.isArray(service?.volumes) ? service.volumes : [];
    // project only bind sources with deferred interpolation
    for (const volume of volumes) {
      if (volume?.type === "bind" && typeof volume.source === "string" && volume.source.includes("$")) {
        volume.source = resolveNormalizedModelPath(context, volume.source, interpolation);
      }
    }
  }
}

// build the fixed interpolation environment without exporting values
function interpolationEnvironment(envFiles) {
  const values = {};
  // preserve explicit env-file order
  for (const path of envFiles) {
    try {
      Object.assign(values, parseEnv(readSelected(path).toString("utf8")));
    } catch {
      throw safeError("invalid-compose-interpolation-environment");
    }
  }
  // preserve shell precedence over env files
  return (name) => Object.hasOwn(process.env, name) ? process.env[name] : values[name];
}

// recheck every privately recorded live input before mutation or apply
export function verifyComposeDependencies(snapshot, descriptor) {
  validateSnapshot(snapshot);
  // reject any dependency drift since validation
  for (const dependency of snapshot.dependencies) {
    const path = approvedDependencyPath(descriptor, dependency.path);
    const bytes = readDependency(path);
    // reject changed dependency bytes
    if (sha256(bytes) !== dependency.hash) {
      throw safeError("compose-dependency-conflict");
    }
  }
}

// resolve source candidates by their immutable live identity
function sourceIdsByPath(descriptor) {
  const ids = new Map();
  // index each installed source once
  for (const [id, source] of Object.entries(descriptor.sources)) {
    // reject ambiguous candidate identities
    if (ids.has(source.path)) {
      throw safeError("ambiguous-compose-dependency");
    }
    ids.set(source.path, id);
  }
  return ids;
}

// snapshot one direct Compose or interpolation input
function stageDirectInput(context, kind, path, useCandidate, suffix) {
  const canonical = canonicalDependencyPath(context, path);
  const input = useCandidate ? selectedPath(context, canonical) : canonical;
  recordLiveDependency(context, kind, canonical);
  const bytes = input === canonical ? liveBytes(context, canonical) : readSelected(input);
  // fail before Compose can follow hidden graph edges
  if (kind === "compose-file" && hasUnsupportedGraph(bytes)) {
    throw safeError("unsupported-compose-dependency");
  }
  return stageBytes(context, `${kind}\0${input}`, bytes, suffix);
}

// detect graph readers that the fixed CLI cannot enumerate safely
function hasUnsupportedGraph(bytes) {
  const text = bytes.toString("utf8");
  // reject explicit and computed hidden graph keys
  if (UNSUPPORTED_GRAPH_KEY.test(text) || UNSUPPORTED_EXPLICIT_KEY.test(text) || DYNAMIC_MAPPING_KEY.test(text)) {
    return true;
  }
  const trimmed = text.trimStart();
  // inspect escaped keys in JSON-form Compose files
  if (trimmed.startsWith("{")) {
    try {
      return objectHasUnsupportedKey(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }
  return false;
}

// traverse JSON keys without retaining source content
function objectHasUnsupportedKey(value) {
  // stop at scalar values
  if (!value || typeof value !== "object") {
    return false;
  }
  // inspect every array element
  if (Array.isArray(value)) {
    return value.some((entry) => objectHasUnsupportedKey(entry));
  }
  // inspect every mapping key and value
  for (const [key, nested] of Object.entries(value)) {
    // reject graph keys at any depth
    if (UNSUPPORTED_KEYS.has(key) || objectHasUnsupportedKey(nested)) {
      return true;
    }
  }
  return false;
}

// choose an explicitly staged source candidate when present
function selectedPath(context, path) {
  const canonical = canonicalDependencyPath(context, path);
  const sourceId = context.sourceIds.get(canonical);
  return sourceId && context.candidates.has(sourceId) ? context.candidates.get(sourceId) : canonical;
}

// collect the normalized file nodes that Compose exposes safely
function collectModelDependencies(model, context, interpolation) {
  // require one normalized model
  if (!isRecord(model)) {
    throw safeError("invalid-compose");
  }
  const dependencies = [];
  const services = model.services ?? {};
  // require normalized service mappings
  if (!isRecord(services)) {
    throw safeError("invalid-compose");
  }
  // collect service-level file readers
  for (const service of Object.values(services)) {
    // reject malformed services
    if (!isRecord(service)) {
      throw safeError("invalid-compose");
    }
    collectServiceEnvFiles(service, context, interpolation, dependencies);
    collectCredentialFile(service, context, interpolation, dependencies);
  }
  collectTopLevelFiles(model.configs, "config-file", context, interpolation, dependencies);
  collectTopLevelFiles(model.secrets, "secret-file", context, interpolation, dependencies);
  return dependencies;
}

// collect normalized service env-file references
function collectServiceEnvFiles(service, context, interpolation, dependencies) {
  // skip absent env files
  if (service.env_file === undefined) {
    return;
  }
  // require normalized lists
  if (!Array.isArray(service.env_file)) {
    throw safeError("invalid-compose");
  }
  // preserve long and short syntax while changing only paths
  for (let index = 0; index < service.env_file.length; index += 1) {
    const entry = service.env_file[index];
    const path = typeof entry === "string" ? entry : entry?.path;
    // require an explicit file identity
    if (typeof path !== "string") {
      throw safeError("invalid-compose");
    }
    const canonical = canonicalModelPath(context, path, interpolation);
    dependencies.push({
      kind: "service-env",
      path: canonical,
      assign(replacement) {
        service.env_file[index] = typeof entry === "string" ? replacement : { ...entry, path: replacement };
      }
    });
  }
}

// collect service credential-spec file references
function collectCredentialFile(service, context, interpolation, dependencies) {
  const credential = service.credential_spec;
  // skip nonfile credential specs
  if (credential?.file === undefined) {
    return;
  }
  // require the normalized long form
  if (!isRecord(credential) || typeof credential.file !== "string") {
    throw safeError("invalid-compose");
  }
  const canonical = canonicalModelPath(context, credential.file, interpolation);
  dependencies.push({
    kind: "credential-file",
    path: canonical,
    assign(replacement) {
      credential.file = replacement;
    }
  });
}

// collect top-level config and secret file references
function collectTopLevelFiles(collection, kind, context, interpolation, dependencies) {
  // skip an absent collection
  if (collection === undefined) {
    return;
  }
  // require a normalized mapping
  if (!isRecord(collection)) {
    throw safeError("invalid-compose");
  }
  // capture only file-backed entries
  for (const definition of Object.values(collection)) {
    // ignore external definitions
    if (!isRecord(definition) || definition.file === undefined) {
      continue;
    }
    // require an explicit file identity
    if (typeof definition.file !== "string") {
      throw safeError("invalid-compose");
    }
    const canonical = canonicalModelPath(context, definition.file, interpolation);
    dependencies.push({
      kind,
      path: canonical,
      assign(replacement) {
        definition.file = replacement;
      }
    });
  }
}

// reject dynamic paths and constrain normalized paths to installer roots
function canonicalModelPath(context, path, interpolation) {
  // reject authored invalid path bytes
  if (path.includes("\0")) {
    throw safeError("dynamic-compose-dependency");
  }
  const expanded = resolveNormalizedModelPath(context, path, interpolation);
  // reject invalid path bytes
  if (expanded.includes("\0")) {
    throw safeError("dynamic-compose-dependency");
  }
  return canonicalDependencyPath(context, expanded);
}

// reverse noninterpolating path resolution before applying candidate values
function resolveNormalizedModelPath(context, path, interpolation) {
  const projectPrefix = `${context.descriptor.compose.projectDirectory}/`;
  const expression = path.includes("$") && path.startsWith(projectPrefix)
    ? path.slice(projectPrefix.length)
    : path;
  const expanded = interpolateDependencyPath(expression, interpolation);
  return resolve(context.descriptor.compose.projectDirectory, expanded);
}

// expand the bounded Compose forms supported for dependency identities
function interpolateDependencyPath(path, lookup) {
  const escapedDollar = "\0RAC_ESCAPED_DOLLAR\0";
  let value = path.replaceAll("$$", escapedDollar);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])(.*?))?\}/gu, (_match, name, operator, operand = "") => interpolateValue(lookup(name), operator, operand));
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name) => lookup(name) ?? "");
  // reject nested or malformed substitutions
  if (value.includes("${") || /\$[A-Za-z_]/u.test(value)) {
    throw safeError("dynamic-compose-dependency");
  }
  return value.replaceAll(escapedDollar, "$");
}

// apply one Compose variable operator without exposing its value
function interpolateValue(current, operator, operand) {
  const set = current !== undefined;
  const nonempty = set && current !== "";
  switch (operator) {
    case undefined:
      return current ?? "";
    case ":-":
      return nonempty ? current : operand;
    case "-":
      return set ? current : operand;
    case ":+":
      return nonempty ? operand : "";
    case "+":
      return set ? operand : "";
    case ":?":
      // require a set nonempty value
      if (!nonempty) {
        throw safeError("required-compose-dependency-unset");
      }
      return current;
    case "?":
      // require a set value
      if (!set) {
        throw safeError("required-compose-dependency-unset");
      }
      return current;
    default:
      throw safeError("dynamic-compose-dependency");
  }
}

// canonicalize one dependency through the immutable allowlist
function canonicalDependencyPath(context, path) {
  return approvedDependencyPath(context.descriptor, path);
}

// map path inspection failures to one nonrevealing dependency result
function approvedDependencyPath(descriptor, path) {
  try {
    return assertAllowedSource(path, descriptor.allowedRoots);
  } catch {
    throw safeError("unapproved-compose-dependency");
  }
}

// read one bounded dependency without exposing its bytes
function readDependency(path) {
  try {
    return readBoundedFile(path, MAX_SOURCE_BYTES);
  } catch (error) {
    // preserve the bounded-size category
    if (error?.code === "source-too-large") {
      throw error;
    }
    throw safeError("compose-dependency-unavailable");
  }
}

// read a staged candidate through the same size ceiling
function readSelected(path) {
  try {
    return readBoundedFile(path, MAX_SOURCE_BYTES);
  } catch (error) {
    // preserve the bounded-size category
    if (error?.code === "source-too-large") {
      throw error;
    }
    throw safeError("compose-dependency-unavailable");
  }
}

// retain the live hash that must remain stable until mutation
function recordLiveDependency(context, kind, path) {
  const key = dependencyKey(kind, path);
  // retain each graph edge once
  if (context.records.has(key)) {
    return;
  }
  const bytes = liveBytes(context, path);
  context.records.set(key, { kind, path, hash: sha256(bytes) });
  // bound private metadata
  if (context.records.size > MAX_DEPENDENCIES) {
    throw safeError("too-many-compose-dependencies");
  }
}

// cache one coherent read of each live dependency
function liveBytes(context, path) {
  // preserve one coherent snapshot read
  if (!context.live.has(path)) {
    context.live.set(path, readDependency(path));
  }
  return context.live.get(path);
}

// stage candidate bytes while recording the corresponding live identity
function stageSelected(context, kind, livePath, inputPath, suffix) {
  recordLiveDependency(context, kind, livePath);
  const bytes = inputPath === livePath ? liveBytes(context, livePath) : readSelected(inputPath);
  return stageBytes(context, `${kind}\0${inputPath}`, bytes, suffix);
}

// store one private copy for all equivalent references
function stageBytes(context, key, bytes, suffix) {
  // reuse identical private inputs
  if (context.staged.has(key)) {
    return context.staged.get(key);
  }
  const name = `input-${String(context.sequence).padStart(4, "0")}${suffix}`;
  context.sequence += 1;
  const path = resolve(context.dependencyRoot, name);
  atomicWriteFile(path, bytes, 0o600);
  context.staged.set(key, path);
  return path;
}

// serialize only paths and hashes into the private operation stage
function composeDependencySnapshot(context) {
  return {
    version: PROTOCOL_VERSION,
    dependencies: [...context.records.values()].sort((left, right) => dependencyKey(left.kind, left.path).localeCompare(dependencyKey(right.kind, right.path)))
  };
}

// validate private records before trusting their paths
function validateSnapshot(snapshot) {
  // require the fixed snapshot envelope
  if (!isRecord(snapshot) || Object.keys(snapshot).some((key) => !["version", "dependencies"].includes(key)) || snapshot.version !== PROTOCOL_VERSION || !Array.isArray(snapshot.dependencies) || snapshot.dependencies.length === 0 || snapshot.dependencies.length > MAX_DEPENDENCIES) {
    throw safeError("invalid-compose-dependency-snapshot");
  }
  const seen = new Set();
  // require canonical record fields and unique identities
  for (const dependency of snapshot.dependencies) {
    // reject malformed records
    if (!isRecord(dependency) || !["compose-file", "interpolation-env", "service-env", "config-file", "secret-file", "credential-file"].includes(dependency.kind) || typeof dependency.path !== "string" || !HASH_PATTERN.test(dependency.hash ?? "") || Object.keys(dependency).some((key) => !["kind", "path", "hash"].includes(key))) {
      throw safeError("invalid-compose-dependency-snapshot");
    }
    const key = dependencyKey(dependency.kind, dependency.path);
    // reject duplicate edges
    if (seen.has(key)) {
      throw safeError("invalid-compose-dependency-snapshot");
    }
    seen.add(key);
  }
}

// build one collision-free in-memory graph key
function dependencyKey(kind, path) {
  return `${kind}\0${path}`;
}

// hash exact private bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// require an ordinary JSON object
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
