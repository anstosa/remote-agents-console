import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  APPLY_CLASSES,
  MAX_REQUEST_BYTES,
  MAX_REVEAL_TTL_MS,
  PROTOCOL_VERSION,
  REQUEST_KINDS,
  SOURCE_IDS,
  SOURCE_KINDS,
  TARGETS
} from "./constants.mjs";
import { assertAllowedSource, inspectOwnedPath, readJsonFile, safeError } from "./fs.mjs";
import { timingSafeEqual } from "node:crypto";
import { frameFields } from "./crypto.mjs";

const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INSTALLATION_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;
const SAFE_UNIT_PATTERN = /^[A-Za-z0-9_.@-]{1,128}\.service$/;

// reject unrecognized object keys
function assertKeys(value, allowed) {
  // inspect every supplied key
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw safeError("invalid-request");
    }
  }
}

// require an ordinary JSON record
function assertRecord(value, code = "invalid-request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError(code);
  }
  return value;
}

// validate the immutable installation descriptor
export function validateDescriptor(raw, descriptorPath) {
  const descriptor = assertRecord(raw, "invalid-descriptor");
  assertKeys(descriptor, new Set([
    "version",
    "installationId",
    "generation",
    "uid",
    "gid",
    "kind",
    "hostControlRoot",
    "hostCheckout",
    "serverCheckout",
    "allowedRoots",
    "sources",
    "compose",
    "native"
  ]));
  if (
    descriptor.version !== PROTOCOL_VERSION ||
    !INSTALLATION_PATTERN.test(descriptor.installationId ?? "") ||
    !Number.isSafeInteger(descriptor.generation) ||
    descriptor.generation < 1 ||
    !Number.isSafeInteger(descriptor.uid) ||
    !Number.isSafeInteger(descriptor.gid) ||
    !["compose", "systemd"].includes(descriptor.kind) ||
    typeof descriptor.hostControlRoot !== "string" ||
    typeof descriptor.hostCheckout !== "string" ||
    typeof descriptor.serverCheckout !== "string" ||
    !Array.isArray(descriptor.allowedRoots) ||
    descriptor.allowedRoots.length === 0
  ) {
    throw safeError("invalid-descriptor");
  }
  if (process.getuid?.() !== descriptor.uid || process.getgid?.() !== descriptor.gid) {
    throw safeError("wrong-owner");
  }
  const roots = descriptor.allowedRoots.map((root) => inspectOwnedPath(root, { regular: false }).path);
  const hostCheckout = assertAllowedSource(descriptor.hostCheckout, roots, { regular: false });
  const sources = assertRecord(descriptor.sources, "invalid-descriptor");
  const normalizedSources = {};
  // validate every fixed source identity
  for (const [id, sourceValue] of Object.entries(sources)) {
    const source = assertRecord(sourceValue, "invalid-descriptor");
    assertKeys(source, new Set(["path", "serverPath", "kind", "optional", "apply"]));
    if (
      !SOURCE_IDS.has(id) ||
      typeof source.path !== "string" ||
      (source.serverPath !== undefined && typeof source.serverPath !== "string") ||
      (source.serverPath !== undefined && !isAbsolute(source.serverPath)) ||
      !SOURCE_KINDS.has(source.kind) ||
      (source.optional !== undefined && typeof source.optional !== "boolean") ||
      !APPLY_CLASSES.has(source.apply)
    ) {
      throw safeError("invalid-descriptor");
    }
    const sourcePath = existsSync(source.path)
      ? assertAllowedSource(source.path, roots)
      : assertAllowedSource(source.path, roots, { regular: true });
    if (!existsSync(sourcePath) && !source.optional) {
      throw safeError("missing-source");
    }
    normalizedSources[id] = { ...source, path: sourcePath };
  }
  const normalized = { ...descriptor, hostCheckout, allowedRoots: roots, sources: normalizedSources };
  if (descriptor.kind === "compose") {
    normalized.compose = validateComposeDescriptor(descriptor.compose, roots);
  } else {
    normalized.native = validateNativeDescriptor(descriptor.native, roots);
  }
  const controlRoot = dirname(descriptorPath);
  inspectOwnedPath(controlRoot, { regular: false });
  if (realpathSync(descriptor.hostControlRoot) !== realpathSync(controlRoot)) {
    throw safeError("invalid-control-root");
  }
  return { ...normalized, controlRoot };
}

// validate fixed Compose invocation data
function validateComposeDescriptor(value, roots) {
  const compose = assertRecord(value, "invalid-descriptor");
  assertKeys(compose, new Set(["projectDirectory", "projectName", "files", "envFiles", "profiles", "options"]));
  if (
    typeof compose.projectDirectory !== "string" ||
    typeof compose.projectName !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(compose.projectName) ||
    !Array.isArray(compose.files) ||
    compose.files.length === 0 ||
    !Array.isArray(compose.envFiles) ||
    !Array.isArray(compose.profiles) ||
    !compose.files.every((item) => typeof item === "string") ||
    !compose.envFiles.every((item) => typeof item === "string") ||
    !compose.profiles.every((item) => typeof item === "string" && /^[A-Za-z0-9_.-]+$/.test(item)) ||
    !validComposeOptions(compose.options)
  ) {
    throw safeError("invalid-descriptor");
  }
  const projectDirectory = assertAllowedSource(compose.projectDirectory, roots, { regular: false });
  const files = compose.files.map((path) => assertAllowedSource(path, roots));
  const envFiles = compose.envFiles.map((path) => assertAllowedSource(path, roots));
  return { ...compose, projectDirectory, files, envFiles, options: compose.options ?? {} };
}

// validate the fixed supported Compose option set
function validComposeOptions(value) {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).every((key) => ["parallel", "compatibility"].includes(key))) {
    return false;
  }
  return (
    (value.parallel === undefined || (Number.isInteger(value.parallel) && (value.parallel === -1 || value.parallel >= 1 && value.parallel <= 64))) &&
    (value.compatibility === undefined || typeof value.compatibility === "boolean")
  );
}

// validate fixed native unit data
function validateNativeDescriptor(value, roots) {
  const native = assertRecord(value, "invalid-descriptor");
  assertKeys(native, new Set(["unit", "environmentFile", "cloudflaredUnit"]));
  if (!SAFE_UNIT_PATTERN.test(native.unit ?? "") || typeof native.environmentFile !== "string") {
    throw safeError("invalid-descriptor");
  }
  if (native.cloudflaredUnit !== undefined && !SAFE_UNIT_PATTERN.test(native.cloudflaredUnit)) {
    throw safeError("invalid-descriptor");
  }
  return { ...native, environmentFile: assertAllowedSource(native.environmentFile, roots) };
}

// parse and validate a strict queued request
export function readRequest(path, descriptor) {
  const request = assertRecord(readJsonFile(path, MAX_REQUEST_BYTES));
  assertKeys(request, new Set(["version", "id", "kind", "generation", "sources", "targets", "reveal", "inspect", "cloudflare"]));
  if (
    request.version !== PROTOCOL_VERSION ||
    !ID_PATTERN.test(request.id ?? "") ||
    !REQUEST_KINDS.has(request.kind) ||
    request.generation !== descriptor.generation
  ) {
    throw safeError("invalid-request");
  }
  if (request.sources !== undefined) {
    if (!Array.isArray(request.sources) || request.sources.length > SOURCE_IDS.size) {
      throw safeError("invalid-request");
    }
    const ids = new Set();
    request.sources = request.sources.map((sourceValue) => {
      const source = assertRecord(sourceValue);
      assertKeys(source, new Set(["id", "contentHash", "existed", "candidate", "remove", "migration"]));
      if (
        !SOURCE_IDS.has(source.id) ||
        !descriptor.sources[source.id] ||
        !HASH_PATTERN.test(source.contentHash ?? "") ||
        (source.existed !== undefined && typeof source.existed !== "boolean") ||
        (source.candidate !== undefined && (typeof source.candidate !== "string" || source.candidate.length > 256)) ||
        (source.remove !== undefined && typeof source.remove !== "boolean") ||
        (source.remove && source.candidate !== undefined) ||
        (source.remove && source.migration !== undefined) ||
        (source.migration !== undefined && !["validate", "commit"].includes(request.kind)) ||
        (!source.remove && ["validate", "commit"].includes(request.kind) && source.candidate === undefined) ||
        (source.migration !== undefined && (
          !source.migration ||
          typeof source.migration !== "object" ||
          Array.isArray(source.migration) ||
          Object.keys(source.migration).length !== 1 ||
          !["copy", "adopt", "empty"].includes(source.migration.mode)
        )) ||
        ids.has(source.id)
      ) {
        throw safeError("invalid-request");
      }
      ids.add(source.id);
      return source;
    });
  }
  if (request.targets !== undefined) {
    if (!Array.isArray(request.targets) || request.targets.length > TARGETS.size || !request.targets.every((target) => TARGETS.has(target))) {
      throw safeError("invalid-request");
    }
    request.targets = [...new Set(request.targets)];
  }
  if (["read", "reveal"].includes(request.kind)) {
    validateReveal(request, descriptor);
    if (request.sources !== undefined && (request.sources.length !== 1 || request.sources[0].id !== request.reveal.sourceId)) {
      throw safeError("invalid-request");
    }
  } else if (request.reveal !== undefined) {
    throw safeError("invalid-request");
  }
  // constrain metadata inspection to one fixed installed source
  if (request.kind === "inspect") {
    const inspect = assertRecord(request.inspect);
    assertKeys(inspect, new Set(["sourceId"]));
    if (!descriptor.sources[inspect.sourceId]) throw safeError("invalid-request");
  } else if (request.inspect !== undefined) throw safeError("invalid-request");
  if (["validate", "commit"].includes(request.kind) && !request.sources?.length) {
    throw safeError("invalid-request");
  }
  if (request.kind === "restart" && !request.targets?.length) {
    throw safeError("invalid-request");
  }
  // validate the fixed Cloudflare control union
  if (request.kind === "cloudflare") {
    validateCloudflareRequest(request, descriptor);
  } else if (request.cloudflare !== undefined) {
    throw safeError("invalid-request");
  }
  return request;
}

// constrain Cloudflare setup to its private stage and fixed CAS sources
function validateCloudflareRequest(request, descriptor) {
  const cloudflare = assertRecord(request.cloudflare);
  assertKeys(cloudflare, new Set(["action", "candidate"]));
  // status is read-only and carries no candidate authority
  if (cloudflare.action === "status") {
    if (cloudflare.candidate !== undefined || request.sources !== undefined || request.targets !== undefined) {
      throw safeError("invalid-request");
    }
    return;
  }
  // require one exact private candidate for mutating actions
  if (!["connect", "activate"].includes(cloudflare.action) || cloudflare.candidate !== "cloudflare-connect" || request.targets !== undefined) {
    throw safeError("invalid-request");
  }
  const ids = request.sources?.map((source) => source.id).sort();
  // bind mutations to current app and installation revisions only
  if (JSON.stringify(ids) !== JSON.stringify(["app", "installation"]) || !descriptor.sources.app || !descriptor.sources.installation) {
    throw safeError("invalid-request");
  }
  // reject candidate or migration authority on CAS-only source records
  for (const source of request.sources) {
    if (typeof source.existed !== "boolean" || source.candidate !== undefined || source.remove !== undefined || source.migration !== undefined) {
      throw safeError("invalid-request");
    }
  }
}

// validate bounded recipient material
function validateReveal(request, descriptor) {
  const reveal = assertRecord(request.reveal);
  assertKeys(reveal, new Set(["sourceId", "publicKey", "nonce", "binding", "expiresAt", "bootNonce", "sessionBinding", "revisionId", "contentHash", "existed"]));
  const expiry = reveal.expiresAt;
  if (
    !SOURCE_IDS.has(reveal.sourceId) ||
    typeof reveal.publicKey !== "string" ||
    reveal.publicKey.length > 256 ||
    typeof reveal.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(reveal.nonce) ||
    typeof reveal.binding !== "string" ||
    reveal.binding.length < 16 ||
    reveal.binding.length > 2048 ||
    !ID_PATTERN.test(reveal.bootNonce ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(reveal.sessionBinding ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(reveal.revisionId ?? "") ||
    !HASH_PATTERN.test(reveal.contentHash ?? "") ||
    typeof reveal.existed !== "boolean" ||
    !Number.isSafeInteger(expiry) ||
    expiry <= Date.now() ||
    expiry - Date.now() > MAX_REVEAL_TTL_MS
  ) {
    throw safeError("disclosure-failed");
  }
  // reconstruct the authenticated frame from fixed request context
  const expected = frameFields([descriptor.installationId, request.generation, reveal.bootNonce, reveal.sessionBinding, request.id, reveal.sourceId, reveal.revisionId, reveal.contentHash, reveal.existed, reveal.nonce, reveal.expiresAt, reveal.publicKey]);
  const actual = Buffer.from(reveal.binding, "base64url");
  const boot = readJsonFile(resolve(descriptor.controlRoot, "boot.json"), MAX_REQUEST_BYTES);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || boot.bootNonce !== reveal.bootNonce || boot.generation !== request.generation) throw safeError("disclosure-failed");
}

// resolve a relative candidate only inside this operation stage
export function resolveCandidate(controlRoot, requestId, relativePath) {
  const stagingRoot = resolve(controlRoot, "staging", requestId);
  const candidate = resolve(stagingRoot, relativePath);
  if (!candidate.startsWith(`${stagingRoot}/`) || !existsSync(candidate)) {
    throw safeError("invalid-candidate");
  }
  const canonicalStage = realpathSync(stagingRoot);
  const canonicalCandidate = inspectOwnedPath(candidate).path;
  if (!canonicalCandidate.startsWith(`${canonicalStage}/`)) {
    throw safeError("invalid-candidate");
  }
  return canonicalCandidate;
}
