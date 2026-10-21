import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assertAllowedSource, isPathInside, safeError } from "./fs.mjs";
import { composePrefix, validateCandidate, validateComposeModel, validateInstallationSettings } from "./validate.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { runBounded } from "./command.mjs";
import { validateCheckoutHandover } from "./checkout-handover.mjs";

const ENV_PATH_KEYS = new Map([
  ["RAC_CONFIG", { kind: "json" }],
  ["RAC_CONFIG_WRITE_PATH", { kind: "json" }],
  ["RAC_CLAUDE_CONFIG_DIR", { directory: true, allowEmpty: true }],
  ["RAC_ADAPTER_FILES_DIR", { directory: true, allowEmpty: true }],
  ["RAC_SERVER_ADMIN_STATUS_DIR", { directory: true, allowEmpty: true }],
  ["RAC_TEMP_PREVIEWS_DIR", { directory: true, allowEmpty: true }],
  ["RAC_DEVICE_NAMES_FILE", { allowEmpty: true }],
  ["RAC_CONSOLE_NAMED_FILE", { allowEmpty: true }],
  ["RAC_WORKTREES_FILE", { allowEmpty: true }],
  ["RAC_SAVED_PROMPTS_FILE", { allowEmpty: true }],
  ["RAC_PROMPT_HISTORY_FILE", { allowEmpty: true }],
  ["RAC_QUEUED_PROMPTS_FILE", { allowEmpty: true }],
  ["RAC_NOTES_FILE", { allowEmpty: true }],
  ["RAC_REVIEW_TOURS_FILE", { allowEmpty: true }],
  ["RAC_PUSH_SUBSCRIPTIONS_FILE", { allowEmpty: true }],
  ["RAC_FILE_FAVORITES_FILE", { allowEmpty: true }],
  ["RAC_FILE_OPERATION_JOURNAL", { allowEmpty: true }],
  ["RAC_INTEGRATION_AUTH_FILE", { allowEmpty: true }],
  ["RAC_INTEGRATION_STATE_FILE", { allowEmpty: true }],
  ["RAC_INTEGRATION_AUDIT_FILE", { allowEmpty: true }],
  ["RAC_BOOKMARKS_FILE", { allowEmpty: true }],
  ["RAC_GH_HOSTS", { allowEmpty: true }],
  ["CLOUDFLARED_CREDENTIALS_FILE", { kind: "credentials" }],
  ["RAC_ENV_FILE", { kind: "env" }]
]);

const MIGRATION_PUBLISHER = "/usr/bin/mv";
let migrationPublisherVerified = false;

// require an atomic no-clobber rename implementation
export function preflightMigrationPublisher() {
  if (migrationPublisherVerified) {
    return;
  }
  let stat;
  try {
    stat = lstatSync(realpathSync(MIGRATION_PUBLISHER));
  } catch {
    throw safeError("migration-publisher-unavailable");
  }
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw safeError("migration-publisher-unavailable");
  }
  const version = spawnSync(MIGRATION_PUBLISHER, ["--version"], { encoding: "utf8", maxBuffer: 64 * 1024 });
  const match = /^mv \(GNU coreutils\) (\d+)\.(\d+)/u.exec(version.stdout ?? "");
  if (version.status !== 0 || !match || Number(match[1]) < 9 || Number(match[1]) === 9 && Number(match[2]) < 4) {
    throw safeError("migration-publisher-unavailable");
  }
  const help = spawnSync(MIGRATION_PUBLISHER, ["--help"], { encoding: "utf8", maxBuffer: 256 * 1024 });
  // coreutils 9.4 has no-clobber and no-copy but not update=none-fail
  if (help.status !== 0 || !help.stdout.includes("--no-clobber") || !help.stdout.includes("--no-copy")) {
    throw safeError("migration-publisher-unavailable");
  }
  migrationPublisherVerified = true;
}

// derive migration paths only from candidate-owned selectors
export function deriveMigrationPlan(descriptor, request, candidates, winningEnvironment = {}, composeSelectors = {}) {
  const plans = [];
  const missingOwners = [];
  for (const requested of request.sources ?? []) {
    const source = descriptor.sources[requested.id];
    const candidate = candidates.get(requested.id);
    // derive merged Compose selectors after ordinary sources
    if (source.kind === "compose") {
      continue;
    }
    if (!candidate || !["env", "installation"].includes(source.kind)) {
      if (requested.migration) {
        throw safeError("invalid-migration");
      }
      continue;
    }
    const changes = source.kind === "env"
      ? envSelectorChanges(descriptor, source.path, candidate, winningEnvironment)
      : installationSelectorChanges(descriptor, source.path, candidate);
    const unique = deduplicateChanges(changes);
    if (unique.length > 0 && !requested.migration) {
      missingOwners.push(requested.id);
      continue;
    }
    if (unique.length === 0 && (!requested.migration || descriptor.kind === "compose" && source.kind === "env")) {
      continue;
    }
    if (unique.length === 0) {
      throw safeError("ambiguous-migration");
    }
    // apply the explicit handover to every changed selector
    for (const change of unique) {
      plans.push({ ...change, mode: requested.migration.mode });
    }
  }
  const composeMigration = composeSelectorMigrationPlans(descriptor, request, composeSelectors);
  plans.push(...composeMigration.plans);
  // include the single merged Compose owner when needed
  if (composeMigration.missingOwner) {
    missingOwners.push(composeMigration.missingOwner);
  }
  // report every source that needs an explicit handover choice
  if (missingOwners.length > 0) {
    throw migrationRequired(missingOwners);
  }
  return plans;
}

// attach only source identities to a handover requirement
function migrationRequired(sourceIds) {
  const error = safeError("migration-required");
  error.sourceIds = [...new Set(sourceIds)];
  return error;
}

// prove every handover is safe before reporting validation success
export async function preflightMigrationPlans(descriptor, plans, options = {}) {
  const targets = new Set();
  // validate each target and its selected source
  for (const plan of plans) {
    assertMigrationPaths(descriptor, plan);
    // reject colliding plans before any publication
    if (targets.has(plan.to)) {
      throw safeError("ambiguous-migration");
    }
    targets.add(plan.to);
    // enforce mode-specific target state
    if (plan.mode === "adopt") {
      if (!existsSync(plan.to)) {
        throw safeError("adopt-target-missing");
      }
      inspectAdoptTarget(descriptor, plan);
      if (plan.kind) {
        await validateCandidate({ kind: plan.kind }, plan.to, options);
      }
      continue;
    }
    if (existsSync(plan.to)) {
      throw safeError("migration-target-exists");
    }
    const temporary = resolve(dirname(plan.to), `.${options.transactionId ?? "validation"}.migration`);
    if (existsSync(temporary)) {
      throw safeError("migration-stage-exists");
    }
    if (plan.mode === "empty") {
      if (!plan.allowEmpty) {
        throw safeError("empty-target-not-allowed");
      }
      continue;
    }
    if (plan.mode !== "copy" || !plan.from || !existsSync(plan.from)) {
      throw safeError("migration-source-missing");
    }
    inspectTree(plan.from);
    if (plan.kind) {
      await validateCandidate({ kind: plan.kind }, plan.from, options);
    }
  }
}

// require native selectors to describe one effective installation identity
export function validateNativeCandidateSelectors(descriptor, candidates) {
  if (descriptor.kind !== "systemd" || !candidates.has("env") && !candidates.has("installation")) {
    return;
  }
  let hostCheckout = descriptor.hostCheckout;
  // derive the paired checkout selector without touching its destination
  if (candidates.has("installation")) {
    const bytes = readFileSync(candidates.get("installation"));
    validateInstallationSettings(bytes);
    const settings = JSON.parse(bytes.toString("utf8"));
    hostCheckout = hostPath(descriptor, settings.host?.checkout ?? descriptor.hostCheckout);
  }
  const environmentPath = candidates.get("env") ?? descriptor.native.environmentFile;
  validateNativeEnvironmentSelectors(descriptor, environmentPath, hostCheckout);
}

// require one explicit handover for merged Compose-owned selectors
function composeSelectorMigrationPlans(descriptor, request, selectors) {
  if (descriptor.kind !== "compose") {
    return { plans: [] };
  }
  const requested = (request.sources ?? []).filter((entry) => descriptor.sources[entry.id]?.kind === "compose");
  if (requested.length === 0) {
    return { plans: [] };
  }
  const changes = [];
  const identities = [
    ["compose.RAC_CONFIG", "app", "json"],
    ["compose.cloudflared.config", "cloudflared", "cloudflared"],
    ["compose.cloudflared.credentials", "cloudflared-credentials", "credentials"]
  ];
  // compare every installed selector with its candidate identity
  for (const [key, id, kind] of identities) {
    const current = descriptor.sources[id];
    const candidate = selectors[id];
    if (current && candidate && current.path !== candidate.path) {
      changes.push({ key, from: current.path, to: candidate.path, kind });
    }
  }
  const owners = requested.filter((entry) => entry.migration);
  // reject unused or multiply-owned handover intent
  if (changes.length === 0) {
    if (owners.length > 0) {
      throw safeError("ambiguous-migration");
    }
    return { plans: [] };
  }
  if (owners.length === 0) {
    const canonical = requested.find((entry) => entry.id === "compose-override") ?? requested.find((entry) => entry.id === "compose");
    // reject synthetic multi-owner graphs without a canonical Compose owner
    if (canonical === undefined && requested.length !== 1) {
      throw safeError("ambiguous-migration");
    }
    return { plans: [], missingOwner: canonical?.id ?? requested[0].id };
  }
  if (owners.length !== 1) {
    throw safeError("ambiguous-migration");
  }
  return { plans: changes.map((change) => ({ ...change, mode: owners[0].migration.mode })) };
}

// compare allowlisted environment path selectors
function envSelectorChanges(descriptor, currentPath, candidatePath, winningEnvironment) {
  let current;
  let candidate;
  try {
    current = parseEnv(readFileSync(currentPath, "utf8"));
    candidate = parseEnv(readFileSync(candidatePath, "utf8"));
  } catch {
    throw safeError("invalid-migration");
  }
  const changes = [];
  for (const [key, metadata] of ENV_PATH_KEYS) {
    // migrate only selectors proven to be the resolved Compose winner
    if (descriptor.kind === "compose" && !winningEnvironment[key]?.candidateWins) {
      continue;
    }
    // require handover for every new destination
    if (current[key] !== candidate[key] && candidate[key]) {
      const from = current[key] ? hostPath(descriptor, current[key]) : undefined;
      const to = hostPath(descriptor, candidate[key]);
      // ignore textual aliases for the same host identity
      if (from === to) {
        continue;
      }
      changes.push({ key, ...(from ? { from } : {}), to, ...metadata });
    }
  }
  return changes;
}

// compare only installation selector paths
function installationSelectorChanges(descriptor, currentPath, candidatePath) {
  let current;
  let candidate;
  try {
    const currentBytes = readFileSync(currentPath);
    const candidateBytes = readFileSync(candidatePath);
    validateInstallationSettings(currentBytes);
    validateInstallationSettings(candidateBytes);
    current = JSON.parse(currentBytes.toString("utf8"));
    candidate = JSON.parse(candidateBytes.toString("utf8"));
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    throw safeError("invalid-migration");
  }
  if (candidate.native?.cloudflaredUnit !== undefined && candidate.native.cloudflaredUnit !== descriptor.native?.cloudflaredUnit) {
    throw safeError("immutable-cloudflared-unit");
  }
  const selectors = [
    ["host.checkout", current.host?.checkout, candidate.host?.checkout, { directory: true, adoptOnly: true }],
    ["compose.projectDirectory", current.compose?.projectDirectory, candidate.compose?.projectDirectory, { directory: true, adoptOnly: true }],
    ["native.environmentFile", current.native?.environmentFile, candidate.native?.environmentFile, { kind: "env" }],
    ["native.cloudflaredConfig", current.native?.cloudflaredConfig, candidate.native?.cloudflaredConfig, { kind: "cloudflared" }],
    ["native.cloudflaredCredentials", current.native?.cloudflaredCredentials, candidate.native?.cloudflaredCredentials, { kind: "credentials" }],
    ["sources.wrapper", current.sources?.wrapper, candidate.sources?.wrapper, { kind: "wrapper" }],
    ["sources.icons.heart", current.sources?.icons?.heart, candidate.sources?.icons?.heart, { kind: "svg" }],
    ["sources.icons.potato", current.sources?.icons?.potato, candidate.sources?.icons?.potato, { kind: "svg" }]
  ];
  const changes = selectors
    .filter(([, from, to]) => from && to && from !== to)
    .map(([key, from, to, metadata]) => ({ key, from: hostPath(descriptor, from), to: hostPath(descriptor, to), ...metadata }));
  const listSelectors = [
    ["compose.files", current.compose?.files, candidate.compose?.files],
    ["compose.envFiles", current.compose?.envFiles, candidate.compose?.envFiles]
  ];
  for (const [key, from, to] of listSelectors) {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) {
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        throw safeError("ambiguous-migration");
      }
      continue;
    }
    for (let index = 0; index < from.length; index += 1) {
      if (from[index] !== to[index]) {
        changes.push({
          key: `${key}.${index}`,
          from: hostPath(descriptor, from[index]),
          to: hostPath(descriptor, to[index]),
          kind: key === "compose.files" ? "compose" : "env"
        });
      }
    }
  }
  return changes;
}

// map invariant container paths back into the host checkout
function hostPath(descriptor, value) {
  if (descriptor.kind === "compose" && value.startsWith("/workspace/")) {
    return resolve(descriptor.hostCheckout, value.slice("/workspace/".length));
  }
  return value.startsWith("/") ? resolve(value) : resolve(descriptor.hostCheckout, value);
}

// collapse paired selectors that name the same source handover
function deduplicateChanges(changes) {
  const result = [];
  const seen = new Set();
  for (const change of changes) {
    const key = `${change.from}\0${change.to}\0${change.directory}\0${change.kind}\0${change.allowEmpty}\0${change.adoptOnly}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(change);
    }
  }
  return result;
}

// perform bounded copy, adopt or empty initialization
export function executeMigrationPlans(descriptor, plans, transactionId, options = {}) {
  preflightMigrationPublisher();
  const created = [];
  for (const plan of plans) {
    assertMigrationPaths(descriptor, plan);
    if (plan.adoptOnly && plan.mode !== "adopt") {
      throw safeError("adopt-required");
    }
    if (plan.mode === "empty" && !plan.allowEmpty) {
      throw safeError("empty-target-not-allowed");
    }
    if (plan.mode === "adopt") {
      if (!existsSync(plan.to)) {
        throw safeError("adopt-target-missing");
      }
      inspectAdoptTarget(descriptor, plan);
      continue;
    }
    if (existsSync(plan.to)) {
      throw safeError("migration-target-exists");
    }
    const temporary = resolve(dirname(plan.to), `.${transactionId}.migration`);
    if (existsSync(temporary)) {
      throw safeError("migration-stage-exists");
    }
    try {
      if (plan.mode === "copy") {
        // require a concrete source for copies
        if (!plan.from || !existsSync(plan.from)) {
          throw safeError("migration-source-missing");
        }
        inspectTree(plan.from);
        stageMigration(plan.from, temporary, Boolean(plan.directory));
      } else if (plan.directory) {
        mkdirSync(temporary, { mode: 0o700 });
      } else {
        closeSync(openSync(temporary, "wx", 0o600));
      }
      inspectTree(temporary);
      // permit deterministic race coverage immediately before publication
      options.beforePublish?.(plan);
      const record = publishMigration(temporary, plan.to, Boolean(plan.directory), options);
      created.push(record);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      if (error?.code === "EEXIST") {
        throw safeError("migration-target-exists");
      }
      throw error;
    }
  }
  return created;
}

// inspect only the fixed graph for checkout adoption instead of unrelated dependencies
function inspectAdoptTarget(descriptor, plan) {
  if (plan.adoptOnly && plan.directory) {
    assertAllowedSource(plan.to, descriptor.allowedRoots, { regular: false });
    // the complete host protocol is independently bounded and byte-compatible
    if (plan.key === "host.checkout") validateCheckoutHandover(descriptor, { ...descriptor, hostCheckout: plan.to });
    return;
  }
  inspectTree(plan.to);
}

// remove only paths created by this transaction
export function rollbackMigrationPlans(created) {
  for (const record of [...created].reverse()) {
    removeOwnedMigration(record);
  }
}

// remove only crash-orphaned migration outputs that still match intent
export function recoverMigrationPlans(plans, transactionId, created = []) {
  const records = new Map(created.map((record) => [record.path, record]));
  for (const plan of [...plans].reverse()) {
    const temporary = resolve(dirname(plan.to), `.${transactionId}.migration`);
    const record = records.get(plan.to);
    if (existsSync(temporary)) {
      // remove only a journaled prepublication stage
      if (!record) {
        throw safeError("manual-recovery-required");
      }
      removeOwnedMigration({ ...record, path: temporary });
    }
    if (plan.mode === "adopt" || !existsSync(plan.to)) {
      continue;
    }
    // never delete a crash output without its exact published identity
    if (!record) {
      throw safeError("manual-recovery-required");
    }
    removeOwnedMigration(record);
  }
}

// stage one bounded source without following links
function stageMigration(source, target, directory) {
  if (directory) {
    mkdirSync(target, { mode: 0o700 });
    materializeDirectory(source, target);
    return;
  }
  copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
  chmodSync(target, lstatSync(source).mode & 0o777);
}

// copy a previously inspected directory through exclusive entries
function materializeDirectory(source, target) {
  for (const name of readdirSync(source)) {
    const from = resolve(source, name);
    const to = resolve(target, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw safeError("unsafe-migration-source");
    }
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: stat.mode & 0o777 });
      materializeDirectory(from, to);
    } else if (stat.isFile()) {
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      chmodSync(to, stat.mode & 0o777);
    } else {
      throw safeError("unsafe-migration-source");
    }
  }
}

// publish one staged inode through atomic no-clobber rename
function publishMigration(temporary, target, directory, options) {
  const identity = migrationIdentity(temporary);
  const digest = treeDigest(temporary);
  const record = { path: target, identity, directory, digest };
  // journal the known staged inode before it can become visible
  options.onPublishing?.(record);
  const moved = spawnSync(MIGRATION_PUBLISHER, ["--no-clobber", "--no-copy", "-T", "--", temporary, target], {
    stdio: "ignore"
  });
  const stageRemains = existsSync(temporary);
  // treat a retained stage as an aborted no-clobber publication
  if (moved.status !== 0 || stageRemains) {
    const targetExists = existsSync(target);
    // accept a completed rename even if the publisher died before exit
    if (targetExists && !stageRemains) {
      try {
        assertMigrationIdentity(target, identity, directory);
        if (treeDigest(target) !== digest) {
          throw safeError("manual-recovery-required");
        }
        options.afterPublish?.(record);
        options.onPublished?.(record);
        return record;
      } catch {
        throw safeError("manual-recovery-required");
      }
    }
    // discard intent only when the staged inode proves no rename occurred
    if (stageRemains) {
      options.onPublishAborted?.(record);
      if (targetExists) {
        throw safeError("migration-target-exists");
      }
      throw safeError("migration-publish-failed");
    }
    throw safeError("manual-recovery-required");
  }
  // prove ownership before recording successful publication
  assertMigrationIdentity(target, identity, directory);
  // retain the complete staged content as part of the publication proof
  if (treeDigest(target) !== digest) {
    throw safeError("manual-recovery-required");
  }
  // simulate termination before the postpublication callback in tests
  options.afterPublish?.(record);
  options.onPublished?.(record);
  return record;
}

// capture one no-follow filesystem identity in JSON-safe form
function migrationIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
    throw safeError("manual-recovery-required");
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

// require the published path to retain its captured object identity
function assertMigrationIdentity(path, identity, directory) {
  const stat = lstatSync(path, { bigint: true });
  const matchesType = directory ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !matchesType || String(stat.dev) !== identity.device || String(stat.ino) !== identity.inode) {
    throw safeError("manual-recovery-required");
  }
}

// delete only the exact unchanged object published by this transaction
function removeOwnedMigration(record) {
  if (!existsSync(record.path)) {
    return;
  }
  const stat = lstatSync(record.path, { bigint: true });
  const matchesIdentity = !stat.isSymbolicLink() && String(stat.dev) === record.identity?.device && String(stat.ino) === record.identity?.inode;
  const matchesType = record.directory ? stat.isDirectory() : stat.isFile();
  if (!matchesIdentity || !matchesType || treeDigest(record.path) !== record.digest) {
    throw safeError("manual-recovery-required");
  }
  rmSync(record.path, { recursive: record.directory });
}

// hash a bounded tree without retaining its bytes
function treeDigest(path) {
  const hash = createHash("sha256");
  const visit = (current, relativePath) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw safeError("unsafe-migration-source");
    }
    hash.update(relativePath);
    hash.update(stat.isDirectory() ? "directory" : "file");
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        visit(resolve(current, name), `${relativePath}/${name}`);
      }
    } else {
      const descriptor = openSync(current, "r");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try {
        let bytes;
        while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, bytes));
        }
      } finally {
        closeSync(descriptor);
      }
    }
  };
  visit(path, ".");
  return hash.digest("hex");
}

// prove both migration endpoints remain installer-contained
function assertMigrationPaths(descriptor, plan) {
  const parent = dirname(plan.to);
  if (!existsSync(parent)) {
    throw safeError("migration-parent-missing");
  }
  const roots = descriptor.allowedRoots;
  if (plan.mode === "copy") {
    // reject source-less copy plans early
    if (!plan.from) {
      throw safeError("migration-source-missing");
    }
    assertAllowedSource(plan.from, roots, { regular: !plan.directory });
  }
  const resolvedParent = assertAllowedSource(parent, roots, { regular: false });
  const target = resolve(resolvedParent, plan.to.slice(parent.length + 1));
  if (!roots.some((root) => isPathInside(root, target))) {
    throw safeError("outside-allowed-root");
  }
  if (plan.adoptOnly && plan.mode !== "adopt") {
    throw safeError("checkout-adopt-required");
  }
}

// reject symlinks and unbounded migration trees
function inspectTree(path) {
  let entries = 0;
  let bytes = 0;
  const visit = (current) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid()) {
      throw safeError("unsafe-migration-source");
    }
    entries += 1;
    bytes += stat.size;
    if (entries > 10_000 || bytes > 512 * 1024 * 1024) {
      throw safeError("migration-too-large");
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) {
        visit(resolve(current, name));
      }
    } else if (!stat.isFile()) {
      throw safeError("unsafe-migration-source");
    }
  };
  visit(path);
}

// derive the next fixed descriptor from authoritative desired selectors
export async function deriveDesiredDescriptor(descriptor, options = {}) {
  if (!descriptor.sources.installation || !existsSync(descriptor.sources.installation.path)) {
    return descriptor;
  }
  const settingsBytes = readFileSync(options.installationSettingsPath ?? descriptor.sources.installation.path);
  validateInstallationSettings(settingsBytes);
  const settings = JSON.parse(settingsBytes.toString("utf8"));
  const hostCheckout = hostPath(descriptor, settings.host?.checkout ?? descriptor.hostCheckout);
  // fail closed until the private token has a proved checkout handover
  if (descriptor.kind === "compose" && descriptor.compose.profiles.includes("tunnel-token") && hostCheckout !== descriptor.hostCheckout) {
    throw safeError("cloudflare-token-checkout-handover-unsupported");
  }
  const next = {
    ...descriptor,
    hostCheckout,
    allowedRoots: [...descriptor.allowedRoots],
    sources: { ...descriptor.sources }
  };
  if (descriptor.kind === "compose") {
    const composeSettings = settings.compose ?? {};
    const compose = {
      projectDirectory: hostPath(descriptor, composeSettings.projectDirectory ?? descriptor.compose.projectDirectory),
      projectName: composeSettings.projectName ?? descriptor.compose.projectName,
      files: (composeSettings.files ?? descriptor.compose.files).map((path) => hostPath(descriptor, path)),
      envFiles: (composeSettings.envFiles ?? descriptor.compose.envFiles).map((path) => hostPath(descriptor, path)),
      profiles: preserveManagedComposeProfiles(descriptor, composeSettings.profiles ?? descriptor.compose.profiles),
      options: composeSettings.options ?? descriptor.compose.options ?? {}
    };
    next.serverCheckout = "/workspace";
    next.compose = compose;
    next.sources.env = sourceAt(descriptor, "env", compose.envFiles[0], "/workspace/.env");
    next.sources.installation = sourceAt(descriptor, "installation", resolve(hostCheckout, "config/remote-agent-console.installation.json"), "/workspace/config/remote-agent-console.installation.json");
    next.sources.compose = sourceAt(descriptor, "compose", compose.files[0], serverPathFor(hostCheckout, compose.files[0]));
    if (compose.files[1]) {
      next.sources["compose-override"] = sourceAt(descriptor, "compose-override", compose.files[1], serverPathFor(hostCheckout, compose.files[1]));
    } else {
      delete next.sources["compose-override"];
    }
    // relocate fixed tunnel sources with checkout migration before validation
    for (const id of ["cloudflared", "cloudflared-credentials"]) {
      const source = descriptor.sources[id];
      if (source && isPathInside(descriptor.hostCheckout, source.path)) {
        const path = resolve(hostCheckout, source.path.slice(descriptor.hostCheckout.length + 1));
        next.sources[id] = sourceAt(descriptor, id, path, serverPathFor(hostCheckout, path));
      }
    }
    if (options.validateComposeDescriptor) {
      await options.validateComposeDescriptor(next);
    }
    const model = await normalizedComposeModel(compose, options.runner ?? runBounded);
    const racEnvironment = model.services?.["remote-agent-console"]?.environment ?? {};
    const appServerPath = racEnvironment.RAC_CONFIG;
    const writeServerPath = racEnvironment.RAC_CONFIG_WRITE_PATH;
    if (typeof appServerPath !== "string" || appServerPath !== writeServerPath) {
      throw safeError("invalid-compose-invariants");
    }
    next.sources.app = sourceAt(descriptor, "app", mapServerPath(hostCheckout, appServerPath), appServerPath);
    const cloudflared = model.services?.cloudflared;
    const cloudConfig = cloudflared?.volumes?.find((volume) => volume?.type === "bind" && volume?.target === "/etc/cloudflared/config.yml")?.source;
    const cloudCredentials = cloudflared?.volumes?.find((volume) => volume?.type === "bind" && volume?.target === "/etc/cloudflared/credentials.json")?.source;
    if (cloudConfig && descriptor.sources.cloudflared) {
      const path = resolve(compose.projectDirectory, cloudConfig);
      next.sources.cloudflared = {
        ...sourceAt(descriptor, "cloudflared", path, visibleServerPath(hostCheckout, path)),
        apply: compose.profiles.includes("tunnel") ? "cloudflared-recreate" : "saved-only"
      };
    }
    if (cloudCredentials && descriptor.sources["cloudflared-credentials"]) {
      const path = resolve(compose.projectDirectory, cloudCredentials);
      next.sources["cloudflared-credentials"] = {
        ...sourceAt(descriptor, "cloudflared-credentials", path, visibleServerPath(hostCheckout, path)),
        apply: compose.profiles.includes("tunnel") ? "cloudflared-recreate" : "saved-only"
      };
    }
    validateComposeModel(model, { ...descriptor, hostCheckout, compose, sources: next.sources });
  } else {
    const environmentFile = hostPath(descriptor, settings.native?.environmentFile ?? descriptor.native.environmentFile);
    const appPath = validateNativeEnvironmentSelectors(descriptor, options.environmentFilePath ?? environmentFile, hostCheckout);
    next.serverCheckout = hostCheckout;
    if (settings.native?.cloudflaredUnit !== undefined && settings.native.cloudflaredUnit !== descriptor.native.cloudflaredUnit) {
      throw safeError("immutable-cloudflared-unit");
    }
    next.native = { ...descriptor.native, environmentFile };
    next.sources.app = sourceAt(descriptor, "app", appPath, appPath);
    next.sources.env = sourceAt(descriptor, "env", environmentFile, environmentFile);
    next.sources.installation = sourceAt(descriptor, "installation", resolve(hostCheckout, "config/remote-agent-console.installation.json"), resolve(hostCheckout, "config/remote-agent-console.installation.json"));
    if (settings.native?.cloudflaredConfig && descriptor.sources.cloudflared) {
      next.sources.cloudflared = sourceAt(descriptor, "cloudflared", hostPath(descriptor, settings.native.cloudflaredConfig), hostPath(descriptor, settings.native.cloudflaredConfig));
    }
    if (settings.native?.cloudflaredCredentials && descriptor.sources["cloudflared-credentials"]) {
      next.sources["cloudflared-credentials"] = sourceAt(descriptor, "cloudflared-credentials", hostPath(descriptor, settings.native.cloudflaredCredentials), hostPath(descriptor, settings.native.cloudflaredCredentials));
    }
  }
  applyOptionalDesiredSources(descriptor, next, settings, hostCheckout);
  const changed = descriptorIdentity(descriptor) !== descriptorIdentity(next);
  next.generation = changed ? descriptor.generation + 1 : descriptor.generation;
  delete next.controlRoot;
  return validateDescriptor(next, resolve(descriptor.controlRoot, "installation.json"));
}

// preserve host-managed token activation across authored installation saves
function preserveManagedComposeProfiles(descriptor, profiles) {
  const selected = [...profiles];
  // retain only an already-active managed token profile
  if (descriptor.compose.profiles.includes("tunnel-token") && !selected.includes("tunnel-token")) {
    selected.push("tunnel-token");
  }
  return selected;
}

// resolve paired native selectors against one desired checkout
function validateNativeEnvironmentSelectors(descriptor, environmentPath, hostCheckout) {
  let env;
  try {
    env = parseEnv(readFileSync(environmentPath, "utf8"));
  } catch {
    throw safeError("invalid-migration");
  }
  const appPath = hostPath(descriptor, env.RAC_CONFIG ?? descriptor.sources.app.path);
  const writePath = hostPath(descriptor, env.RAC_CONFIG_WRITE_PATH ?? env.RAC_CONFIG ?? descriptor.sources.app.path);
  if (appPath !== writePath) {
    throw safeError("selector-not-winning-source");
  }
  const configuredCheckout = env.RAC_SERVER_CHECKOUT ? hostPath(descriptor, env.RAC_SERVER_CHECKOUT) : hostCheckout;
  if (configuredCheckout !== hostCheckout) {
    throw safeError("selector-not-winning-source");
  }
  return appPath;
}

// load normalized Compose privately for winning-source ownership
async function normalizedComposeModel(compose, runner) {
  const result = await runner("docker", [...composePrefix(compose), "config", "--format", "json"], {
    cwd: compose.projectDirectory,
    maxBytes: 16 * 1024 * 1024
  });
  if (result.code !== 0) {
    throw safeError("invalid-compose");
  }
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw safeError("invalid-compose");
  }
}

// retain fixed source metadata while replacing identity
function sourceAt(descriptor, id, path, serverPath) {
  const current = descriptor.sources[id];
  if (!current) {
    throw safeError("missing-source-identity");
  }
  return { ...current, path, serverPath };
}

// map server checkout paths to their host identity
function mapServerPath(hostCheckout, serverPath) {
  if (serverPath === "/workspace") {
    return hostCheckout;
  }
  if (!serverPath.startsWith("/workspace/")) {
    throw safeError("unsupported-server-path");
  }
  return resolve(hostCheckout, serverPath.slice("/workspace/".length));
}

// expose one server path only inside the checkout bind
function serverPathFor(hostCheckout, path) {
  if (!isPathInside(hostCheckout, path)) {
    throw safeError("unsupported-server-path");
  }
  return `/workspace/${path.slice(hostCheckout.length + 1)}`;
}

// expose relocated host sources only when the server can read them
function visibleServerPath(hostCheckout, path) {
  return isPathInside(hostCheckout, path) ? serverPathFor(hostCheckout, path) : undefined;
}

// apply wrapper and icon selector paths
function applyOptionalDesiredSources(descriptor, next, settings, hostCheckout) {
  const paths = {
    wrapper: settings.sources?.wrapper,
    "icon-heart": settings.sources?.icons?.heart,
    "icon-potato": settings.sources?.icons?.potato
  };
  for (const [id, value] of Object.entries(paths)) {
    if (value && descriptor.sources[id]) {
      const path = hostPath(descriptor, value);
      next.sources[id] = sourceAt(descriptor, id, path, descriptor.kind === "compose" ? serverPathFor(hostCheckout, path) : path);
    }
  }
}

// compare promoted identities without derived runtime fields
function descriptorIdentity(descriptor) {
  return JSON.stringify({
    kind: descriptor.kind,
    hostCheckout: descriptor.hostCheckout,
    serverCheckout: descriptor.serverCheckout,
    sources: descriptor.sources,
    compose: descriptor.compose,
    native: descriptor.native
  });
}
