import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "./constants.mjs";
import { runBounded } from "./command.mjs";
import { encryptReveal, openLocal, sealLocal, sha256 } from "./crypto.mjs";
import { atomicWriteFile, inspectOwnedPath, readBoundedFile, readJsonFile, safeError, unlinkIfIdentity } from "./fs.mjs";
import {
  candidateMapFromRequest,
  composePrefix,
  renderedEnvironmentValue,
  validateCandidate,
  validateCloudflareCredentialSelector,
  validateCloudflarePair,
  validateComposeCandidates
} from "./validate.mjs";
import { resolveCandidate, validateDescriptor } from "./contracts.mjs";
import {
  deriveDesiredDescriptor,
  deriveMigrationPlan,
  executeMigrationPlans,
  preflightMigrationPlans,
  recoverMigrationPlans,
  rollbackMigrationPlans,
  validateNativeCandidateSelectors
} from "./migrations.mjs";
import { inspectSource } from "./inspection.mjs";
import { verifyComposeDependencies } from "./dependencies.mjs";
import { probeRacHealth, proveInitialTargetBaseline, retargetNativeCloudflaredCommand } from "./baseline.mjs";
import { handoverControlPlane, recoverControlPlaneHandover, validateCheckoutHandover } from "./checkout-handover.mjs";
import { withRestartWatchdog } from "./restart-watchdog.mjs";
import { processCloudflareRequest } from "./cloudflare.mjs";
import { projectMountsChanged, synchronizeProjectMounts } from "./project-mounts.mjs";

// retain helper-only effective source proof data
const EFFECTIVE_SOURCES = Symbol("effectiveSources");
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const APP_SOURCE_MIGRATION = "push-to-buttons-v1";

// dispatch one claimed operation
export async function processOperation(descriptor, request, options = {}) {
  switch (request.kind) {
    case "inspect":
      return inspectSource(descriptor, request);
    case "read":
    case "reveal":
      return revealSource(descriptor, request);
    case "validate":
      await validateRequest(descriptor, request, options);
      return { phase: "validated" };
    case "commit":
      return commitRequest(descriptor, request, options);
    case "restart":
      return restartRequest(descriptor, request, options);
    case "reconcile":
      return reconcileRequest(descriptor, request, options);
    case "recover":
      return recoverRequest(descriptor, request, options);
    case "cloudflare": {
      let nestedRestart;
      const cloudflareOptions = {
        ...options,
        // retain the RAC deadline for activation rollback after restart success
        onRestartProgress: (progress) => {
          options.onRestartProgress?.(progress);
          nestedRestart = progress;
        }
      };
      // keep rollback reporting from changing rollback behavior
      const publishNestedRestartProgress = (state, operationOptions) => {
        // suppress progress for connector-only operations
        if (nestedRestart?.recoveryDeadline === undefined) return;
        try {
          operationOptions.onRestartProgress?.({ recoveryDeadline: nestedRestart.recoveryDeadline, state });
        } catch {
          // observability cannot own runtime recovery
        }
      };
      return processCloudflareRequest(descriptor, request, cloudflareOptions, {
        // capture RAC recovery before public-origin mutation
        ensureRacBaseline: (current, operationOptions) => ensureRecoveryBaselines(current, ["rac"], operationOptions),
        // reuse the guarded replacement workflow
        restartRac: (current, restart, operationOptions) => restartRequest(current, restart, operationOptions),
        // reuse the last-effective recovery proof after a late failure
        recoverRac: async (current, sources, operationOptions) => {
          publishNestedRestartProgress("recovering", operationOptions);
          try {
            await recoverLastEffective(current, ["rac"], sources, operationOptions);
            publishNestedRestartProgress("recovered", operationOptions);
          } catch (error) {
            publishNestedRestartProgress("recovery-failed", operationOptions);
            throw error;
          }
        }
      });
    }
    default:
      throw safeError("invalid-request");
  }
}

// return one source through ciphertext only
function revealSource(descriptor, request) {
  const requested = request.sources?.[0];
  const sourceId = request.reveal.sourceId;
  const source = descriptor.sources[sourceId];
  if (!source || !existsSync(source.path)) {
    throw safeError("disclosure-failed");
  }
  inspectOwnedPath(source.path);
  const bytes = readBoundedFile(source.path, MAX_SOURCE_BYTES);
  // bind ciphertext to the requested exact source revision and existence
  if (request.reveal.contentHash !== sha256(bytes) || request.reveal.existed !== true) throw safeError("disclosure-failed");
  if (requested && sha256(bytes) !== requested.contentHash) {
    throw safeError("disclosure-failed");
  }
  return { response: encryptReveal({ descriptor, request, sourceId, plaintext: bytes }), phase: "revealed" };
}

// validate all staged source bytes and cross-file Compose state
export async function validateRequest(descriptor, request, options = {}) {
  const candidates = candidateMapFromRequest(
    descriptor,
    request,
    (path) => resolveCandidate(descriptor.controlRoot, request.id, path)
  );
  // validate every nonremoved candidate
  for (const [sourceId, candidate] of candidates) {
    await validateCandidate(descriptor.sources[sourceId], candidate, options);
  }
  // derive Project mounts only inside an enlisted Compose override transaction
  if (descriptor.kind === "compose" && candidates.has("app")) {
    const currentApplication = readBoundedFile(descriptor.sources.app.path, MAX_SOURCE_BYTES).toString("utf8");
    const candidateApplication = readBoundedFile(candidates.get("app"), MAX_SOURCE_BYTES).toString("utf8");
    // synchronize only an actual mount projection change
    if (projectMountsChanged(currentApplication, candidateApplication)) {
      // require one crash-recoverable cross-file transaction
      if (!candidates.has("compose-override")) throw safeError("project-mount-override-required");
      const stageDirectory = resolve(descriptor.controlRoot, "staging", request.id);
      const before = await validateComposeCandidates(descriptor, candidates, stageDirectory, options.runner ?? runBounded, true);
      const override = candidates.get("compose-override");
      const original = readBoundedFile(override, MAX_SOURCE_BYTES).toString("utf8");
      const synchronized = synchronizeProjectMounts(original, currentApplication, candidateApplication, before.resolvedModel, descriptor.compose.projectDirectory);
      // preserve the source-size boundary after derivation
      if (Buffer.byteLength(synchronized) > MAX_SOURCE_BYTES) throw safeError("source-too-large");
      // replace only changed private candidate bytes
      if (synchronized !== original) atomicWriteFile(override, synchronized, 0o600);
    }
  }
  const touchesCompose = [...candidates].some(([sourceId]) => ["compose", "env"].includes(descriptor.sources[sourceId].kind));
  let dependencySnapshot;
  let winningEnvironment = {};
  let shadowedEnvironmentKeys = [];
  let environmentFileHashes = {};
  let composeSelectors = {};
  if (descriptor.kind === "compose" && touchesCompose) {
    const composeValidation = await validateComposeCandidates(
      descriptor,
      candidates,
      resolve(descriptor.controlRoot, "staging", request.id),
      options.runner ?? runBounded
    );
    dependencySnapshot = composeValidation.dependencySnapshot;
    winningEnvironment = composeValidation.winningEnvironment;
    shadowedEnvironmentKeys = composeValidation.shadowedEnvironmentKeys;
    environmentFileHashes = composeValidation.environmentFileHashes;
    composeSelectors = composeValidation.composeSelectors;
  }
  const cloudConfig = candidates.get("cloudflared") ?? descriptor.sources.cloudflared?.path;
  const cloudCredentials = candidates.get("cloudflared-credentials") ?? descriptor.sources["cloudflared-credentials"]?.path;
  if (cloudConfig && cloudCredentials && existsSync(cloudConfig) && existsSync(cloudCredentials)) {
    validateCloudflarePair(
      readBoundedFile(cloudConfig, MAX_SOURCE_BYTES),
      readBoundedFile(cloudCredentials, MAX_SOURCE_BYTES)
    );
  }
  const migrationPlans = deriveMigrationPlan(descriptor, request, candidates, winningEnvironment, composeSelectors);
  await preflightMigrationPlans(descriptor, migrationPlans, { ...options, transactionId: request.id });
  validateNativeCandidateSelectors(descriptor, candidates);
  validateMigrationCloudflarePair(descriptor, migrationPlans);
  return { candidates, dependencySnapshot, winningEnvironment, shadowedEnvironmentKeys, environmentFileHashes, composeSelectors, migrationPlans };
}

// persist a journaled per-file transaction without applying it
async function commitRequest(descriptor, request, options) {
  const {
    candidates,
    dependencySnapshot,
    winningEnvironment,
    shadowedEnvironmentKeys,
    environmentFileHashes,
    migrationPlans
  } = await validateRequest(descriptor, request, options);
  const originals = [];
  // recheck all expected bytes before the first mutation
  for (const requested of request.sources) {
    const source = descriptor.sources[requested.id];
    const existed = existsSync(source.path);
    const bytes = existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
    if ((requested.existed !== undefined && requested.existed !== existed) || sha256(bytes) !== requested.contentHash) {
      throw safeError("source-conflict");
    }
    if (!existed && !source.optional) {
      throw safeError("missing-source");
    }
    originals.push({
      id: requested.id,
      existed,
      mode: existed ? lstatSync(source.path).mode & 0o777 : 0o600,
      bytes: bytes.toString("base64")
    });
  }
  const baselineTargets = requiredCommitBaselineTargets(descriptor, request, migrationPlans);
  // seal every affected current target before source mutation
  await ensureRecoveryBaselines(descriptor, baselineTargets, options);
  const recoveryPath = resolve(descriptor.controlRoot, "recovery", `${request.id}.json`);
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  const key = readRecoveryKey(descriptor.controlRoot);
  atomicWriteFile(recoveryPath, `${JSON.stringify(sealLocal(key, { version: 1, originals }))}\n`, 0o600);
  const written = [];
  const sourcePublications = [];
  let migrated = [];
  const migrationOwnership = [];
  writeJournal(journalPath, request, "prepared", written, undefined, migrationPlans, undefined, sourcePublications);
  try {
    if (dependencySnapshot) {
      verifyComposeDependencies(dependencySnapshot, descriptor);
    }
    executeMigrationPlans(descriptor, migrationPlans, request.id, {
      // durably bind each staged inode before publication
      onPublishing: (record) => {
        migrationOwnership.push(record);
        writeJournal(journalPath, request, "prepared", written, undefined, migrationPlans, migrationOwnership, sourcePublications);
      },
      // discard a record when no publication occurred
      onPublishAborted: (record) => {
        const index = migrationOwnership.findIndex((candidate) => candidate.path === record.path);
        if (index !== -1) {
          migrationOwnership.splice(index, 1);
        }
        writeJournal(journalPath, request, "prepared", written, undefined, migrationPlans, migrationOwnership, sourcePublications);
      },
      // retain in-process ownership for ordinary rollback
      onPublished: (record) => {
        migrated.push(record);
      }
    });
    await validateMigrationTargets(migrationPlans, options);
    let desiredDependencyProof;
    if (candidates.has("installation") || descriptor.kind === "systemd" && candidates.has("env")) {
      const candidateDescriptor = await deriveDesiredDescriptor(descriptor, {
        ...options,
        ...(candidates.has("installation") ? { installationSettingsPath: candidates.get("installation") } : {}),
        ...(descriptor.kind === "systemd" && candidates.has("env") ? { environmentFilePath: candidates.get("env") } : {}),
        validateComposeDescriptor: async (candidateDescriptor) => {
          const validation = await validateDeploymentGraph(candidateDescriptor, `${request.id}-desired`, options);
          desiredDependencyProof = { snapshot: validation?.dependencySnapshot, descriptor: candidateDescriptor };
        }
      });
      // reject an incompatible relocated helper before any authoritative rename
      validateCheckoutHandover(descriptor, candidateDescriptor);
    }
    if (desiredDependencyProof?.snapshot) {
      verifyComposeDependencies(desiredDependencyProof.snapshot, desiredDependencyProof.descriptor);
    }
    // commit each independently atomic file
    for (const requested of request.sources) {
      const source = descriptor.sources[requested.id];
      const existed = existsSync(source.path);
      const selected = requested.remove && existed ? inspectOwnedPath(source.path) : undefined;
      const current = existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
      if ((requested.existed !== undefined && requested.existed !== existed) || sha256(current) !== requested.contentHash) {
        throw safeError("source-conflict");
      }
      const createsWrapper = !requested.remove && !existed && source.kind === "wrapper";
      // expose the postproof race seam without widening production behavior
      if (createsWrapper) {
        options.beforeSourceWrite?.(requested.id, source.path);
        sourcePublications.push({ id: requested.id });
      }
      written.push(requested.id);
      writeJournal(journalPath, request, "committing", written, undefined, migrationPlans, migrated, sourcePublications);
      if (requested.remove) {
        if (!source.optional) {
          throw safeError("required-source");
        }
        if (existsSync(source.path)) {
          // reject a file created after the absence recheck
          if (!selected) {
            throw safeError("source-conflict");
          }
          unlinkIfIdentity(source.path, { stat: selected.stat, contentHash: sha256(current) });
        }
      } else {
        const candidate = candidates.get(requested.id);
        // keep existing mode selection and make only new wrappers executable
        const mode = existed ? lstatSync(source.path).mode & 0o777 : source.kind === "wrapper" ? 0o700 : 0o600;
        const candidateBytes = readBoundedFile(candidate, MAX_SOURCE_BYTES);
        // create only absent wrappers through no-clobber publication
        if (createsWrapper) {
          const publication = sourcePublications.find((record) => record.id === requested.id);
          atomicWriteFile(source.path, candidateBytes, mode, {
            noClobber: true,
            // journal the staged inode before it can become visible
            onPublishing: (identity) => {
              publication.identity = identity;
              writeJournal(journalPath, request, "committing", written, undefined, migrationPlans, migrated, sourcePublications);
            },
            // retain expected absence when another writer wins
            onPublishAborted: () => {
              delete publication.identity;
              writeJournal(journalPath, request, "committing", written, undefined, migrationPlans, migrated, sourcePublications);
            },
            beforePublish: () => options.beforeSourcePublish?.(requested.id, source.path)
          });
        } else {
          atomicWriteFile(source.path, candidateBytes, mode);
        }
      }
    }
    const desiredDescriptor = await deriveDesiredDescriptor(descriptor, options);
    validateNativeCloudflareSelector(desiredDescriptor);
    // validate a relocated helper only after migration targets exist
    if (desiredDescriptor.hostCheckout !== descriptor.hostCheckout) {
      validateCheckoutHandover(descriptor, desiredDescriptor);
    }
    for (const plan of migrationPlans) {
      const sourceId = ["RAC_CONFIG", "RAC_CONFIG_WRITE_PATH", "compose.RAC_CONFIG"].includes(plan.key)
        ? "app"
        : plan.key === "compose.cloudflared.config"
          ? "cloudflared"
          : plan.key === "compose.cloudflared.credentials"
            ? "cloudflared-credentials"
            : undefined;
      // require every derived selector to win after source publication
      if (sourceId && desiredDescriptor.sources[sourceId]?.path !== plan.to) {
        throw safeError("selector-not-winning-source");
      }
    }
    const hashes = currentHashes(desiredDescriptor, request.sources.map((source) => source.id));
    const targets = [...new Set(request.sources
      .filter((requested) => requestedSourceAffectsRuntime(descriptor, requested, winningEnvironment))
      .map((requested) => descriptor.sources[requested.id].apply)
      .filter((apply) => apply === "rac-restart" || apply === "cloudflared-recreate")
      .map((apply) => apply === "rac-restart" ? "rac" : "cloudflared"))];
    // direct tunnel selector changes require their own replacement proof
    if (migrationPlans.some((plan) => plan.key.startsWith("compose.cloudflared.")) && !targets.includes("cloudflared")) {
      targets.push("cloudflared");
    }
    if (
      descriptor.kind === "compose" &&
      descriptor.compose.profiles.includes("tunnel") !== desiredDescriptor.compose.profiles.includes("tunnel") &&
      desiredDescriptor.sources.cloudflared
    ) {
      if (!targets.includes("cloudflared")) {
        targets.push("cloudflared");
      }
    }
    atomicWriteFile(resolve(descriptor.controlRoot, "pending.json"), `${JSON.stringify({
      version: PROTOCOL_VERSION,
      generation: desiredDescriptor.generation,
      recoveryId: request.id,
      hashes,
      targets,
      savedAt: new Date().toISOString()
    })}\n`, 0o600);
    if (desiredDescriptor.generation !== descriptor.generation) {
      const promoted = { ...desiredDescriptor };
      delete promoted.controlRoot;
      atomicWriteFile(resolve(descriptor.controlRoot, "desired-installation.json"), `${JSON.stringify(promoted, null, 2)}\n`, 0o600);
    }
    const receipt = {
      generation: desiredDescriptor.generation,
      hashes,
      targets,
      ...(shadowedEnvironmentKeys.length ? { shadowedEnvironmentKeys } : {}),
      ...(Object.keys(environmentFileHashes).length ? { environmentFileHashes } : {}),
      completedAt: new Date().toISOString()
    };
    writeJournal(journalPath, request, "complete", written, receipt, migrationPlans, migrated, sourcePublications);
    return { phase: "committed", receipt };
  } catch (error) {
    let rollbackError;
    try {
      rollbackWritten(descriptor, originals, written, candidates, sourcePublications);
    } catch (caught) {
      rollbackError = caught;
    }
    try {
      rollbackMigrationPlans(migrationOwnership);
    } catch (caught) {
      rollbackError ??= caught;
    }
    // retain exact ownership proof when automatic rollback is unsafe
    if (rollbackError) {
      writeJournal(journalPath, request, written.length ? "committing" : "prepared", written, undefined, migrationPlans, migrationOwnership, sourcePublications);
    } else {
      writeJournal(journalPath, request, "rolled-back", written, undefined, migrationPlans, undefined, sourcePublications);
    }
    throw rollbackError ?? error;
  }
}

// suppress runtime work when a Compose env edit cannot affect the service
function requestedSourceAffectsRuntime(descriptor, requested, winningEnvironment) {
  const source = descriptor.sources[requested.id];
  // preserve non-env apply behavior
  if (descriptor.kind !== "compose" || source.kind !== "env") {
    return true;
  }
  return Object.values(winningEnvironment).some((ownership) => ownership.candidateChanged && !ownership.explicitlyShadowed);
}

// identify current targets whose source graph this commit can affect
function requiredCommitBaselineTargets(descriptor, request, migrationPlans) {
  const targets = new Set();
  // map every runtime-affecting source to its installed target
  for (const requested of request.sources) {
    const source = descriptor.sources[requested.id];
    if (source.apply === "rac-restart") {
      targets.add("rac");
    } else if (source.apply === "cloudflared-recreate") {
      targets.add("cloudflared");
    }
    // structural Compose sources can change the Cloudflare target too
    if (descriptor.sources.cloudflared && ["installation", "compose", "compose-override"].includes(requested.id)) {
      targets.add("cloudflared");
    }
  }
  // include credential selector handovers consumed by Cloudflare
  if (descriptor.sources.cloudflared && migrationPlans.some((plan) => plan.key === "CLOUDFLARED_CREDENTIALS_FILE")) {
    targets.add("cloudflared");
  }
  return [...targets];
}

// restore transaction-owned paths only
function rollbackWritten(descriptor, originals, written, candidates, sourcePublications) {
  // reverse partial commits
  for (const sourceId of [...written].reverse()) {
    const source = descriptor.sources[sourceId];
    const candidate = candidates.get(sourceId);
    const original = originals.find((entry) => entry.id === sourceId);
    const currentExists = existsSync(source.path);
    const current = currentExists ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
    const committedHash = candidate ? sha256(readBoundedFile(candidate, MAX_SOURCE_BYTES)) : sha256(Buffer.alloc(0));
    const originalBytes = Buffer.from(original.bytes, "base64");
    // remove new wrappers only with durable inode ownership proof
    if (!original.existed && source.kind === "wrapper" && sourcePublications !== undefined) {
      if (!currentExists) {
        continue;
      }
      const publication = Array.isArray(sourcePublications)
        ? sourcePublications.find((record) => record?.id === sourceId)
        : undefined;
      // preserve a destination when publication never occurred
      if (!publication?.identity) {
        continue;
      }
      const selected = inspectOwnedPath(source.path);
      if (!matchesPublicationIdentity(selected.stat, publication.identity) || sha256(current) !== committedHash) {
        throw safeError("manual-recovery-required");
      }
      unlinkIfIdentity(source.path, { stat: selected.stat, contentHash: committedHash });
      continue;
    }
    if (sha256(current) === sha256(originalBytes)) {
      continue;
    }
    if (sha256(current) !== committedHash) {
      throw safeError("manual-recovery-required");
    }
    if (original.existed) {
      atomicWriteFile(source.path, originalBytes, original.mode);
    } else if (existsSync(source.path)) {
      unlinkCurrentSource(source.path);
    }
  }
}

// compare one journal-safe filesystem identity
function matchesPublicationIdentity(stat, identity) {
  return typeof identity?.device === "string" && typeof identity?.inode === "string" && String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
}

// publish a content-free journal state
function writeJournal(path, request, phase, written, receipt, migrations = [], migrated = [], sourcePublications) {
  atomicWriteFile(path, `${JSON.stringify({
    version: PROTOCOL_VERSION,
    id: request.id,
    kind: request.kind,
    generation: request.generation,
    phase,
    written,
    migrations,
    ...(migrated.length ? { migrated } : {}),
    ...(sourcePublications !== undefined ? { sourcePublications } : {}),
    ...(receipt ? { receipt } : {}),
    updatedAt: new Date().toISOString()
  })}\n`, 0o600);
}

// reconcile a claimed commit after helper termination
export function recoverClaimedTransaction(descriptor, request) {
  if (request.kind !== "commit") {
    return undefined;
  }
  const journalPath = resolve(descriptor.controlRoot, "journal", `${request.id}.json`);
  if (!existsSync(journalPath)) {
    return undefined;
  }
  const journal = readJsonFile(journalPath, MAX_SOURCE_BYTES);
  if (journal.id !== request.id || journal.generation !== request.generation) {
    throw safeError("journal-mismatch");
  }
  if (journal.phase === "complete" && journal.receipt) {
    return journal.receipt;
  }
  if (!["prepared", "committing"].includes(journal.phase)) {
    return undefined;
  }
  if (journal.phase === "committing") {
    const envelope = readJsonFile(resolve(descriptor.controlRoot, "recovery", `${request.id}.json`), 2 * MAX_SOURCE_BYTES * Object.keys(descriptor.sources).length);
    const bundle = openLocal(readRecoveryKey(descriptor.controlRoot), envelope);
    const candidates = candidateMapFromRequest(descriptor, request, (path) => resolveCandidate(descriptor.controlRoot, request.id, path));
    rollbackWritten(descriptor, bundle.originals, journal.written ?? [], candidates, journal.sourcePublications);
  }
  recoverMigrationPlans(journal.migrations ?? [], request.id, journal.migrated ?? []);
  writeJournal(journalPath, request, "rolled-back", journal.written ?? [], undefined, journal.migrations ?? [], undefined, journal.sourcePublications);
  return undefined;
}

// read the installer-created local recovery key
function readRecoveryKey(controlRoot) {
  const key = readBoundedFile(resolve(controlRoot, "recovery.key"), 32);
  if (key.length !== 32) {
    throw safeError("recovery-unavailable");
  }
  return key;
}

// hash current bytes without exposing content
export function currentHashes(descriptor, sourceIds = Object.keys(descriptor.sources)) {
  const hashes = {};
  // hash each fixed source identity
  for (const id of sourceIds) {
    const path = descriptor.sources[id]?.path;
    if (!path) {
      throw safeError("invalid-source");
    }
    hashes[id] = sha256(existsSync(path) ? readBoundedFile(path, MAX_SOURCE_BYTES) : Buffer.alloc(0));
  }
  return hashes;
}

// build the complete desired manifest for fixed host deployments
export function currentSourceManifest(descriptor) {
  const desired = loadDesiredDescriptor(descriptor);
  return Object.entries(desired.sources).map(([id, source]) => {
    const existed = existsSync(source.path);
    const bytes = existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0);
    return { id, existed, contentHash: sha256(bytes) };
  });
}

// apply fixed targets and prove a replacement boot
async function restartRequest(descriptor, request, options) {
  const activeDescriptor = descriptor;
  const desiredDescriptor = loadDesiredDescriptor(descriptor);
  // revalidate checkout compatibility before any deployment mutation
  if (desiredDescriptor.hostCheckout !== activeDescriptor.hostCheckout) {
    validateCheckoutHandover(activeDescriptor, desiredDescriptor);
  }
  validateNativeCloudflareSelector(desiredDescriptor);
  verifyRequestedHashes(desiredDescriptor, request.sources ?? []);
  // require recovery before any settings-driven replacement
  await ensureRecoveryBaselines(activeDescriptor, request.targets, options);
  const deploymentOptions = { ...options, activeDescriptor };
  // load native argv only from the encrypted proven baseline
  if (desiredDescriptor.kind === "systemd" && request.targets.includes("cloudflared")) {
    const bundle = readEffectiveBundle(activeDescriptor, "cloudflared");
    deploymentOptions.nativeCloudflaredCommand = bundle?.proof?.nativeCommand;
    deploymentOptions.nativeCloudflaredCommandDescriptor = bundle?.descriptor;
  }
  const previousBoot = readOptionalJson(resolve(descriptor.controlRoot, "boot.json"));
  const expectedEnvironment = request.targets.includes("rac") ? await expectedEnvironmentHashes(desiredDescriptor, options) : {};
  let effectiveSources = request.sources ?? [];
  // retain the manifest accepted by the real boot proof
  const captureProofEffectiveSources = (sources) => { effectiveSources = sources; };
  const recoveryTargets = new Set();
  let controlPlaneHandedOver = false;
  let restartProgress;
  // publish only progress anchored to the real replacement deadline
  const publishRestartProgress = (state) => {
    // suppress recovery copy before RAC replacement
    if (restartProgress?.recoveryDeadline === undefined) return;
    const next = { recoveryDeadline: restartProgress.recoveryDeadline, state };
    try {
      options.onRestartProgress?.(next);
    } catch {
      // observability cannot own runtime recovery
    }
    restartProgress = next;
  };
  try {
    const composeValidation = await validateDeploymentGraph(desiredDescriptor, request.id, options);
    // recheck the live graph immediately before deployment
    if (composeValidation) {
      verifyComposeDependencies(composeValidation.dependencySnapshot, desiredDescriptor);
    }
    const targetProofs = {};
    const snapshotProofs = {};
    let proof = previousBoot ?? { bootNonce: undefined };
    const applyCloudflared = async () => {
      recoveryTargets.add("cloudflared");
      Object.assign(targetProofs, await applyTargets(desiredDescriptor, ["cloudflared"], deploymentOptions));
      // prove the exact Cloudflare inputs consumed by the replacement
      const cloudflaredProof = await proveAppliedCloudflared(desiredDescriptor, options, "apply");
      verifyAppliedTargetProof(desiredDescriptor, "cloudflared", cloudflaredProof, request.sources ?? [], targetProofs.cloudflared);
      snapshotProofs.cloudflared = cloudflaredProof;
      targetProofs.cloudflared = cloudflaredProof.targetProofs.cloudflared;
    };
    const applyRac = async () => {
      proof = await withRestartWatchdog(async (watchdog) => {
        const forwardController = new AbortController();
        const forwardSignal = AbortSignal.any([watchdog.signal, forwardController.signal]);
        let reachRestartBoundary;
        const restartBoundary = new Promise((resolvePromise) => { reachRestartBoundary = resolvePromise; });
        const guardedOptions = {
          ...deploymentOptions,
          runner: watchdogRunner(deploymentOptions.runner ?? runBounded, forwardSignal),
          signal: forwardSignal,
          proofClock: watchdog.clock,
          beforeRacRestart: () => {
            const boundaryBoot = readOptionalJson(resolve(descriptor.controlRoot, "boot.json"));
            const starting = { recoveryDeadline: watchdog.start(), state: "restarting" };
            // require durable progress before allowing the mutating command
            options.onRestartProgress?.(starting);
            restartProgress = starting;
            recoveryTargets.add("rac");
            reachRestartBoundary(boundaryBoot);
          }
        };
        let firstError;
        const settle = async (action) => {
          try {
            return { value: await action() };
          } catch (error) {
            // cancel and settle the peer before recovery
            firstError ??= error;
            forwardController.abort(error);
            return { error };
          }
        };
        // observe availability while the deployment command remains in flight
        const applied = settle(() => applyTargets(desiredDescriptor, ["rac"], guardedOptions));
        const proved = settle(async () => {
          const boundaryBoot = await waitForRestartBoundary(restartBoundary, forwardSignal);
          const value = options.prove
            ? await options.prove(desiredDescriptor, request, boundaryBoot, { ...watchdog, signal: forwardSignal })
            : await waitForProof(desiredDescriptor, request, boundaryBoot, expectedEnvironment, {
                ...guardedOptions,
                deadline: watchdog.deadline
              }, captureProofEffectiveSources);
          watchdog.markProved();
          return { boundaryBoot, value };
        });
        const [applyOutcome, proofOutcome] = await Promise.all([applied, proved]);
        // surface the first failure only after both paths settle
        if (firstError) throw firstError;
        Object.assign(targetProofs, applyOutcome.value);
        // recheck live health after the deployment command settles
        if (!options.prove) {
          const settledProof = await waitForProof(desiredDescriptor, request, proofOutcome.value.boundaryBoot, expectedEnvironment, {
            ...options,
            deadline: undefined,
            signal: undefined,
            proofClock: undefined
          }, captureProofEffectiveSources);
          return settledProof;
        }
        return proofOutcome.value.value;
      }, {
        clock: options.restartWatchdogClock,
        timeoutMs: options.restartWatchdogTimeoutMs,
        deferStart: true
      });
    };
    // preserve Compose's RAC-first replacement order
    if (desiredDescriptor.kind === "compose") {
      if (request.targets.includes("rac")) await applyRac();
      if (request.targets.includes("cloudflared")) await applyCloudflared();
    } else {
      // preserve native Cloudflare-first replacement order
      if (request.targets.includes("cloudflared")) await applyCloudflared();
      if (request.targets.includes("rac")) await applyRac();
    }
    // move the helper only after the desired RAC runtime is proved
    if (request.targets.includes("rac") && desiredDescriptor.hostCheckout !== activeDescriptor.hostCheckout) {
      await handoverControlPlane(activeDescriptor, desiredDescriptor, options);
      controlPlaneHandedOver = true;
    }
    // reject edits after the attested migration proof
    const consumedSourceIds = new Set(Object.values(snapshotProofs).flatMap((targetProof) => Object.keys(targetProof.consumedSources ?? {})));
    verifyRequestedHashes(desiredDescriptor, effectiveSources.filter((source) => !consumedSourceIds.has(source.id)));
    const hashes = Object.fromEntries(effectiveSources.map((source) => [source.id, source.contentHash]));
    // report consumed Cloudflare bytes rather than a renamed host path
    if (snapshotProofs.cloudflared) {
      for (const id of Object.keys(hashes)) {
        if (snapshotProofs.cloudflared.hashes[id] !== undefined) {
          hashes[id] = snapshotProofs.cloudflared.hashes[id];
        }
      }
    }
    const receipt = {
      operationId: request.id,
      generation: desiredDescriptor.generation,
      hashes,
      targets: request.targets,
      bootNonce: proof.bootNonce,
      ...(proof.semanticHashes ? { semanticHashes: proof.semanticHashes } : {}),
      ...(proof.environmentHashes ? { environmentHashes: proof.environmentHashes } : {}),
      ...((proof.shadowedEnvironmentKeys ?? composeValidation?.shadowedEnvironmentKeys)?.length ? { shadowedEnvironmentKeys: proof.shadowedEnvironmentKeys ?? composeValidation.shadowedEnvironmentKeys } : {}),
      ...(Object.keys(proof.environmentFileHashes ?? composeValidation?.environmentFileHashes ?? {}).length ? { environmentFileHashes: proof.environmentFileHashes ?? composeValidation.environmentFileHashes } : {}),
      ...(Object.keys(targetProofs).length ? { targetProofs } : {}),
      completedAt: new Date().toISOString()
    };
    await captureEffectiveSnapshots(desiredDescriptor, request.targets, snapshotProofs, effectiveSources);
    if (desiredDescriptor.generation !== activeDescriptor.generation) {
      promoteDescriptor(activeDescriptor, desiredDescriptor);
    }
    recordEffectiveReceipt(desiredDescriptor, receipt);
    clearPendingTargets(desiredDescriptor, request.targets);
    publishRestartProgress("restarted");
    return { phase: "effective", receipt };
  } catch (error) {
    // expose recovery only after the RAC replacement boundary was crossed
    publishRestartProgress("recovering");
    try {
      // roll back a proved helper handover when promotion did not complete
      if (controlPlaneHandedOver) {
        await recoverControlPlaneHandover(activeDescriptor, options);
      }
      // recover only targets that reached a mutation boundary
      if (recoveryTargets.size > 0) {
        await recoverLastEffective(activeDescriptor, request.targets.filter((target) => recoveryTargets.has(target)), effectiveSources, options);
      }
      publishRestartProgress("recovered");
    } catch (recoveryError) {
      publishRestartProgress("recovery-failed");
      throw recoveryError;
    }
    throw error;
  }
}

// carry watchdog cancellation without freezing its proof deadline
function watchdogRunner(runner, signal) {
  return (command, args, commandOptions = {}) => runner(command, args, {
    ...commandOptions,
    signal
  });
}

// wait until apply reaches the exact service replacement boundary
function waitForRestartBoundary(boundary, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    // reject setup failure before service replacement
    if (signal.aborted) {
      rejectPromise(safeError("command-aborted"));
      return;
    }
    const onAbort = () => rejectPromise(safeError("command-aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    boundary.then((boot) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(boot);
    });
  });
}

// apply only fixed installation targets
export async function applyTargets(descriptor, targets, options = {}) {
  const runner = options.runner ?? runBounded;
  const targetProofs = {};
  if (descriptor.kind === "compose") {
    const prefix = composePrefix(descriptor.compose);
    if (targets.includes("rac")) {
      // bind-mounted config changes still require an actual replacement boot
      options.beforeRacRestart?.();
      await requireSuccess(await runner("docker", [...prefix, "up", "-d", "--build", "--wait", "--force-recreate", "remote-agent-console"], {
        cwd: descriptor.compose.projectDirectory,
        maxBytes: MAX_SOURCE_BYTES,
        timeoutMs: options.applyTimeoutMs ?? 10 * 60_000
      }), "apply-failed");
      const running = await runner("docker", [...prefix, "ps", "-q", "remote-agent-console"], {
        cwd: descriptor.compose.projectDirectory,
        maxBytes: 1024
      });
      const containerId = running.stdout.toString("utf8").trim();
      if (running.code !== 0 || !/^[0-9a-f]{12,64}$/.test(containerId)) {
        throw safeError("rac-service-proof-failed");
      }
      targetProofs.rac = { containerId };
    }
    if (targets.includes("cloudflared")) {
      if (!descriptor.sources.cloudflared) {
        throw safeError("target-unavailable");
      }
      const cloudPrefix = descriptor.compose.profiles.includes("tunnel")
        ? prefix
        : composePrefix({ ...descriptor.compose, profiles: [...descriptor.compose.profiles, "tunnel"] });
      const before = await runner("docker", [...cloudPrefix, "ps", "-q", "cloudflared"], {
        cwd: descriptor.compose.projectDirectory,
        maxBytes: 1024
      });
      const cloudAction = descriptor.compose.profiles.includes("tunnel")
        ? [...cloudPrefix, "up", "-d", "--force-recreate", "--no-deps", "cloudflared"]
        : [...cloudPrefix, "stop", "cloudflared"];
      await requireSuccess(await runner("docker", cloudAction, {
        cwd: descriptor.compose.projectDirectory,
        maxBytes: MAX_SOURCE_BYTES,
        timeoutMs: options.applyTimeoutMs ?? 5 * 60_000
      }), "apply-failed");
      const after = await runner("docker", [...cloudPrefix, "ps", "-q", "cloudflared"], {
        cwd: descriptor.compose.projectDirectory,
        maxBytes: 1024
      });
      const previousId = before.stdout.toString("utf8").trim();
      const currentId = after.stdout.toString("utf8").trim();
      const enabledProofFailed = descriptor.compose.profiles.includes("tunnel") && (!/^[0-9a-f]{12,64}$/.test(currentId) || currentId === previousId);
      const disabledProofFailed = !descriptor.compose.profiles.includes("tunnel") && currentId !== "";
      if (after.code !== 0 || enabledProofFailed || disabledProofFailed) {
        throw safeError("cloudflared-proof-failed");
      }
      targetProofs.cloudflared = descriptor.compose.profiles.includes("tunnel") ? { containerId: currentId } : { stopped: true };
    }
    return targetProofs;
  }
  if (targets.includes("cloudflared")) {
    if (!descriptor.native.cloudflaredUnit || !descriptor.sources.cloudflared) {
      throw safeError("target-unavailable");
    }
    validateNativeCloudflareSelector(descriptor);
    const activeCommandDescriptor = options.nativeCloudflaredCommandDescriptor ?? options.activeDescriptor ?? descriptor;
    const expectedCommandDescriptor = options.nativeCloudflaredExpectedCommandDescriptor ?? options.activeDescriptor ?? activeCommandDescriptor;
    const command = retargetNativeCloudflaredCommand(options.nativeCloudflaredCommand, activeCommandDescriptor, descriptor);
    const expectedCommand = retargetNativeCloudflaredCommand(options.nativeCloudflaredCommand, activeCommandDescriptor, expectedCommandDescriptor);
    installNativeCloudflaredDropIn(
      descriptor,
      command,
      expectedCommand,
      options.nativeUnitDirectory,
      options.nativeCloudflaredRequireExistingDropIn === true
    );
    await requireSuccess(await runner("systemctl", ["--user", "daemon-reload"], { maxBytes: MAX_SOURCE_BYTES }), "apply-failed");
    await requireSuccess(await runner("systemctl", ["--user", "restart", descriptor.native.cloudflaredUnit], { maxBytes: MAX_SOURCE_BYTES }), "apply-failed");
    await requireSuccess(await runner("systemctl", ["--user", "is-active", "--quiet", descriptor.native.cloudflaredUnit], { maxBytes: MAX_SOURCE_BYTES }), "cloudflared-proof-failed");
    targetProofs.cloudflared = { unit: descriptor.native.cloudflaredUnit };
  }
  if (targets.includes("rac")) {
    installNativeEnvironmentDropIn(descriptor, options.nativeUnitDirectory, options.handoverNode ?? process.execPath);
    await requireSuccess(await runner("systemctl", ["--user", "daemon-reload"], { maxBytes: MAX_SOURCE_BYTES }), "apply-failed");
    options.beforeRacRestart?.();
    await requireSuccess(await runner("systemctl", ["--user", "restart", descriptor.native.unit], { maxBytes: MAX_SOURCE_BYTES }), "apply-failed");
    targetProofs.rac = { unit: descriptor.native.unit };
  }
  return targetProofs;
}

// install the descriptor-owned native environment selector
function installNativeEnvironmentDropIn(descriptor, configuredUnitDirectory, nodeExecutable) {
  const unitRoot = configuredUnitDirectory ?? resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "systemd/user");
  const directory = resolve(unitRoot, `${descriptor.native.unit}.d`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workingDirectory = systemdQuote(descriptor.hostCheckout);
  const environmentFile = systemdQuote(descriptor.native.environmentFile);
  const executable = systemdQuote(nodeExecutable);
  const entrypoint = systemdQuote(resolve(descriptor.hostCheckout, "apps/server/dist/index.js"));
  const controlRoot = systemdQuote(descriptor.controlRoot);
  atomicWriteFile(resolve(directory, "20-rac-settings-environment.conf"), `[Service]\nWorkingDirectory=${workingDirectory}\nEnvironmentFile=\nEnvironmentFile=${environmentFile}\nExecStart=\nExecStart=${executable} ${entrypoint} --settings-control ${controlRoot}\n`, 0o600);
}

// install one exact managed native cloudflared command override
function installNativeCloudflaredDropIn(descriptor, command, expectedCommand, configuredUnitDirectory, requireExisting) {
  const unitRoot = configuredUnitDirectory ?? resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "systemd/user");
  const directory = resolve(unitRoot, `${descriptor.native.cloudflaredUnit}.d`);
  const path = resolve(directory, "20-rac-settings-cloudflared.conf");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const expected = renderNativeCloudflaredDropIn(expectedCommand);
  // fail before staging when the managed predecessor drifted
  assertNativeCloudflaredDropIn(path, expected, requireExisting);
  atomicWriteFile(path, renderNativeCloudflaredDropIn(command), 0o600, {
    // recheck exact bytes and mode at the atomic replacement boundary
    beforeRename: () => assertNativeCloudflaredDropIn(path, expected, requireExisting)
  });
}

// render the sole managed systemd command format
function renderNativeCloudflaredDropIn(command) {
  const execStart = command.map((value) => systemdQuote(value)).join(" ");
  return `[Service]\n# rac-settings-cloudflared:managed\nExecStart=\nExecStart=${execStart}\n`;
}

// require the exact predecessor or an allowed first takeover
function assertNativeCloudflaredDropIn(path, expected, requireExisting) {
  try {
    // allow absence only for the first managed takeover
    if (!existsSync(path)) {
      // require the transaction-produced desired predecessor on recovery
      if (requireExisting) {
        throw safeError("cloudflared-drop-in-conflict");
      }
      return;
    }
    const before = lstatSync(path);
    const bytes = readBoundedFile(path, MAX_SOURCE_BYTES);
    const after = lstatSync(path);
    // reject altered content, type, ownership mode or special bits
    if (
      !before.isFile() ||
      !sameDropInIdentity(before, after) ||
      (after.mode & 0o7777) !== 0o600 ||
      !bytes.equals(Buffer.from(expected))
    ) {
      throw safeError("cloudflared-drop-in-conflict");
    }
  } catch {
    throw safeError("cloudflared-drop-in-conflict");
  }
}

// compare the exact file identity surrounding validation
function sameDropInIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

// quote one literal systemd argument
function systemdQuote(value) {
  if (/[\0\r\n]/.test(value)) {
    throw safeError("invalid-native-environment-path");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
}

// map subprocess details to one public result
function requireSuccess(result, code) {
  if (result.code !== 0) {
    throw safeError(code);
  }
}

// verify request hashes before deployment
function verifyRequestedHashes(descriptor, sources) {
  // reject drift since the server built the manifest
  for (const source of sources) {
    const exists = existsSync(descriptor.sources[source.id]?.path);
    const current = currentHashes(descriptor, [source.id])[source.id];
    if ((source.existed !== undefined && source.existed !== exists) || current !== source.contentHash) {
      throw safeError("source-conflict");
    }
  }
}

// wait for new boot attestation plus local health
async function waitForProof(descriptor, request, previousBoot, expectedEnvironment, options, captureEffectiveSources) {
  const clock = options.proofClock ?? {
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer)
  };
  const deadline = options.deadline ?? clock.now() + (options.healthTimeoutMs ?? 90_000);
  // poll until proof succeeds or the owning deadline expires
  while (clock.now() < deadline) {
    // stop proof work when the restart watchdog fires
    if (options.signal?.aborted) throw safeError("command-aborted");
    const boot = readOptionalJson(resolve(descriptor.controlRoot, "boot.json"));
    const effectiveSources = boot === undefined ? undefined : effectiveProofSources(descriptor, boot, request.sources ?? []);
    if (
      boot?.version === PROTOCOL_VERSION &&
      boot.generation === descriptor.generation &&
      typeof boot.bootNonce === "string" &&
      boot.bootNonce !== previousBoot?.bootNonce &&
      effectiveSources !== undefined &&
      environmentHashesMatch(boot.environmentHashes, expectedEnvironment) &&
      await probeRacHealth(descriptor, boot.listen, {
        runner: options.runner ?? runBounded,
        signal: options.signal,
        remainingMs: deadline - clock.now()
      })
    ) {
      // publish effective hashes before concurrent apply settlement
      captureEffectiveSources?.(effectiveSources);
      return Object.assign(boot, { [EFFECTIVE_SOURCES]: effectiveSources });
    }
    await waitForProofPoll(clock, deadline, options.signal);
  }
  // preserve cancellation as the watchdog's terminal cause
  if (options.signal?.aborted) throw safeError("command-aborted");
  throw safeError("health-proof-failed");
}

// wait for one abortable proof interval
function waitForProofPoll(clock, deadline, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    // reject cancellation before scheduling another poll
    if (signal?.aborted) {
      rejectPromise(safeError("command-aborted"));
      return;
    }
    const delay = Math.max(0, Math.min(500, deadline - clock.now()));
    let timer;
    const cleanup = () => {
      clock.clearTimer(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      rejectPromise(safeError("command-aborted"));
    };
    timer = clock.setTimer(() => {
      cleanup();
      resolvePromise();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// derive the exact manifest accepted by one boot proof
function effectiveProofSources(descriptor, boot, sources) {
  const hashes = boot.hashes;
  const migrations = boot.sourceMigrations;
  // reject malformed hashes or migration namespaces
  if (!isRecord(hashes) || (migrations !== undefined && (!isRecord(migrations) || Object.keys(migrations).some((id) => id !== "app")))) {
    return undefined;
  }
  const migration = migrations?.app;
  const requestedApp = sources.find((source) => source.id === "app");
  // bind migration metadata to the requested app source only
  if (migration !== undefined && (!requestedApp || !validAppSourceMigration(descriptor, migration, requestedApp, hashes))) {
    return undefined;
  }
  // require every other boot-consumed source to remain exact
  for (const source of sources) {
    // ignore sources outside the server boot attestation
    if (!["json", "env"].includes(descriptor.sources[source.id]?.kind)) continue;
    // replace only the attested app transition
    if (source.id === "app" && migration !== undefined) continue;
    // reject every unrelated attested hash change
    if (hashes[source.id] !== source.contentHash) return undefined;
  }
  return sources.map((source) => source.id === "app" && migration !== undefined
    ? { ...source, existed: true, contentHash: migration.toHash }
    : source);
}

// validate the only supported boot-time source migration
function validAppSourceMigration(descriptor, migration, requested, hashes) {
  // require an exact closed migration record
  if (
    descriptor.sources.app?.kind !== "json" ||
    !isRecord(migration) ||
    Object.keys(migration).some((key) => !["kind", "fromHash", "toHash"].includes(key)) ||
    migration.kind !== APP_SOURCE_MIGRATION ||
    !HASH_PATTERN.test(migration.fromHash ?? "") ||
    !HASH_PATTERN.test(migration.toHash ?? "") ||
    migration.fromHash === migration.toHash ||
    requested.existed !== true ||
    requested.contentHash !== migration.fromHash ||
    hashes.app !== migration.toHash
  ) {
    return false;
  }
  // bind attestation to the current host bytes
  try {
    return existsSync(descriptor.sources.app.path) && currentHashes(descriptor, ["app"]).app === migration.toHash;
  } catch {
    return false;
  }
}

// recognize one non-array protocol record
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// require every winning environment value to match the new process
function environmentHashesMatch(actual, expected) {
  if (!actual || typeof actual !== "object") {
    return Object.keys(expected).length === 0;
  }
  return Object.entries(expected).every(([key, hash]) => actual[key] === hash);
}

// derive private winning environment hashes from the actual invocation
async function expectedEnvironmentHashes(descriptor, options) {
  if (options.expectedEnvironmentHashes) {
    return options.expectedEnvironmentHashes;
  }
  if (descriptor.kind === "systemd") {
    const values = parseEnv(readFileSync(descriptor.native.environmentFile, "utf8"));
    return hashEnvironment(values);
  }
  const runner = options.runner ?? runBounded;
  const result = await runner("docker", [...composePrefix(descriptor.compose), "config", "--format", "json"], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: 16 * MAX_SOURCE_BYTES
  });
  if (result.code !== 0) {
    throw safeError("environment-proof-unavailable");
  }
  try {
    const model = JSON.parse(result.stdout.toString("utf8"));
    return hashEnvironment(model.services?.["remote-agent-console"]?.environment ?? {}, true);
  } catch {
    throw safeError("environment-proof-unavailable");
  }
}

// retain hashes only for private effective proof
function hashEnvironment(values, composeRendered = false) {
  const hashes = {};
  // hash each present effective environment value
  for (const [key, value] of Object.entries(values)) {
    // skip absent normalized entries
    if (value !== null && value !== undefined) {
      hashes[key] = sha256(Buffer.from(String(composeRendered ? renderedEnvironmentValue(value) : value), "utf8"));
    }
  }
  return hashes;
}

// reconcile a boot without deploying
async function reconcileRequest(descriptor, request, options) {
  verifyRequestedHashes(descriptor, request.sources ?? []);
  // cloudflared needs replacement proof rather than a RAC boot receipt
  if ((request.targets ?? []).includes("cloudflared")) {
    throw safeError("cloudflared-reconcile-unproven");
  }
  // establish an exact initial baseline before weaker request-scoped reconciliation
  await ensureRecoveryBaselines(descriptor, request.targets ?? [], {
    ...options,
    ...(options.prove && !options.baselineProve ? { baselineProve: options.prove } : {})
  });
  const composeValidation = await validateDeploymentGraph(descriptor, request.id, options);
  // recheck the live graph immediately before proof reconciliation
  if (composeValidation) {
    verifyComposeDependencies(composeValidation.dependencySnapshot, descriptor);
  }
  const proof = (request.targets ?? []).includes("rac")
    ? (options.prove
      ? await options.prove(descriptor, request)
      : await waitForProof(descriptor, request, undefined, await expectedEnvironmentHashes(descriptor, options), options))
    : (readOptionalJson(resolve(descriptor.controlRoot, "boot.json")) ?? { bootNonce: undefined });
  const receipt = {
    operationId: request.id,
    generation: descriptor.generation,
    hashes: currentHashes(descriptor, request.sources?.map((source) => source.id)),
    targets: request.targets ?? [],
    bootNonce: proof.bootNonce,
    ...(proof.semanticHashes ? { semanticHashes: proof.semanticHashes } : {}),
    ...(proof.environmentHashes ? { environmentHashes: proof.environmentHashes } : {}),
    ...((proof.shadowedEnvironmentKeys ?? composeValidation?.shadowedEnvironmentKeys)?.length ? { shadowedEnvironmentKeys: proof.shadowedEnvironmentKeys ?? composeValidation.shadowedEnvironmentKeys } : {}),
    ...(Object.keys(proof.environmentFileHashes ?? composeValidation?.environmentFileHashes ?? {}).length ? { environmentFileHashes: proof.environmentFileHashes ?? composeValidation.environmentFileHashes } : {}),
    completedAt: new Date().toISOString()
  };
  await captureEffectiveSnapshots(descriptor, receipt.targets);
  recordEffectiveReceipt(descriptor, receipt);
  clearPendingTargets(descriptor, request.targets ?? []);
  return { phase: "reconciled", receipt };
}

// invoke the fixed latest recovery bundle
async function recoverRequest(descriptor, request, options) {
  await recoverLastEffective(descriptor, request.targets ?? ["rac"], request.sources ?? [], options);
  return { phase: "recovered" };
}

// validate copied or adopted targets before selector commit
async function validateMigrationTargets(plans, options) {
  // validate each typed migration target
  for (const plan of plans) {
    if (["adopt", "copy"].includes(plan.mode) && plan.kind) {
      await validateCandidate({ kind: plan.kind }, plan.to, options);
    }
  }
}

// require native config to select the desired credential source
function validateNativeCloudflareSelector(descriptor) {
  // skip installations without native tunnel ownership
  if (descriptor.kind !== "systemd" || !descriptor.sources.cloudflared) {
    return;
  }
  const credentials = descriptor.sources["cloudflared-credentials"];
  // reject partial native Cloudflare installations
  if (!credentials) {
    throw safeError("cloudflared-credential-selector-mismatch");
  }
  validateCloudflareCredentialSelector(
    readBoundedFile(descriptor.sources.cloudflared.path, MAX_SOURCE_BYTES),
    credentials.path
  );
}

// require migrated Cloudflare documents to retain one tunnel identity
function validateMigrationCloudflarePair(descriptor, plans) {
  const configKeys = ["native.cloudflaredConfig", "compose.cloudflared.config"];
  const credentialKeys = ["native.cloudflaredCredentials", "compose.cloudflared.credentials", "CLOUDFLARED_CREDENTIALS_FILE"];
  const selectedPath = (keys, sourceId) => {
    const plan = plans.find((candidate) => keys.includes(candidate.key));
    // validate the bytes that the selected handover will publish
    if (plan) {
      return plan.mode === "adopt" ? plan.to : plan.from;
    }
    return descriptor.sources[sourceId]?.path;
  };
  const config = selectedPath(configKeys, "cloudflared");
  const credentials = selectedPath(credentialKeys, "cloudflared-credentials");
  if (config && credentials && existsSync(config) && existsSync(credentials)) {
    const configBytes = readBoundedFile(config, MAX_SOURCE_BYTES);
    validateCloudflarePair(
      configBytes,
      readBoundedFile(credentials, MAX_SOURCE_BYTES)
    );
    // require native config to name the post-handover credential identity
    if (descriptor.kind === "systemd") {
      const credentialPlan = plans.find((candidate) => credentialKeys.includes(candidate.key));
      validateCloudflareCredentialSelector(configBytes, credentialPlan?.to ?? descriptor.sources["cloudflared-credentials"].path);
    }
  }
}

// capture encrypted source truth only after target proof
async function captureEffectiveSnapshots(descriptor, targets, proofs = {}, expectedSources = []) {
  const key = readRecoveryKey(descriptor.controlRoot);
  const expected = new Map(expectedSources.map((source) => [source.id, source]));
  // keep independent baselines for separately applied targets
  for (const target of targets) {
    const consumedSources = proofs[target]?.consumedSources ?? {};
    const originals = recoverySourceIds(descriptor, target).map((id) => {
      const current = captureEntry(descriptor.sources[id], id);
      const captured = consumedSources[id] === undefined ? current : { ...current, existed: true, bytes: consumedSources[id] };
      const requested = expected.get(id);
      // bind snapshots to the effective manifest when supplied
      if (requested) {
        assertExpectedEntry(captured, requested);
      }
      // preserve container-consumed bind bytes when the host path already drifted
      return captured;
    });
    const expectedHashes = proofs[target]?.hashes;
    // bind initial snapshots to the nonmutating target proof
    if (expectedHashes && originals.some((entry) => expectedHashes[entry.id] !== sha256(Buffer.from(entry.bytes, "base64")))) {
      throw safeError("baseline-required");
    }
    const authority = { ...descriptor };
    delete authority.controlRoot;
    const bundle = {
      version: PROTOCOL_VERSION,
      target,
      generation: descriptor.generation,
      descriptor: authority,
      originals,
      ...(proofs[target] ? { proof: proofs[target] } : {})
    };
    const path = resolve(descriptor.controlRoot, "recovery", `effective-${target}.json`);
    atomicWriteFile(path, `${JSON.stringify(sealLocal(key, bundle))}\n`, 0o600);
  }
}

// establish missing recovery baselines without changing services
async function ensureRecoveryBaselines(descriptor, targets, options) {
  // prove each target independently
  for (const target of [...new Set(targets)]) {
    const existing = readEffectiveBundle(descriptor, target, true);
    // preserve an already sealed baseline for this active generation
    if (existing?.generation === descriptor.generation && effectiveBundleSupportsTarget(existing, descriptor, target)) {
      continue;
    }
    try {
      const proof = await proveInitialTargetBaseline(descriptor, target, options);
      await captureEffectiveSnapshots(descriptor, [target], { [target]: proof });
      const receipt = {
        generation: descriptor.generation,
        hashes: proof.hashes,
        targets: [target],
        ...(proof.bootNonce ? { bootNonce: proof.bootNonce } : {}),
        ...(proof.semanticHashes ? { semanticHashes: proof.semanticHashes } : {}),
        ...(proof.environmentHashes ? { environmentHashes: proof.environmentHashes } : {}),
        ...(proof.environmentFileHashes ? { environmentFileHashes: proof.environmentFileHashes } : {}),
        ...(proof.shadowedEnvironmentKeys?.length ? { shadowedEnvironmentKeys: proof.shadowedEnvironmentKeys } : {}),
        ...(proof.targetProofs ? { targetProofs: proof.targetProofs } : {}),
        completedAt: new Date().toISOString()
      };
      recordEffectiveReceipt(descriptor, receipt);
    } catch {
      throw safeError("baseline-required");
    }
  }
}

// require encrypted native recovery argv before preserving a baseline
function effectiveBundleSupportsTarget(bundle, descriptor, target) {
  // accept targets without native argv ownership
  if (target !== "cloudflared" || descriptor.kind !== "systemd") {
    return true;
  }
  try {
    retargetNativeCloudflaredCommand(bundle.proof?.nativeCommand, bundle.descriptor, descriptor);
    return true;
  } catch {
    return false;
  }
}

// select the complete source graph consumed by one target
function recoverySourceIds(descriptor, target) {
  const sharedCloudIds = new Set(["env", "installation", "compose", "compose-override", "cloudflared", "cloudflared-credentials"]);
  return Object.entries(descriptor.sources)
    .filter(([id, source]) => target === "rac" ? source.apply === "rac-restart" : source.apply === "cloudflared-recreate" || sharedCloudIds.has(id))
    .map(([id]) => id);
}

// retain exact bytes, absence and mode for recovery
function captureEntry(source, id) {
  const existed = existsSync(source.path);
  return {
    id,
    existed,
    mode: existed ? lstatSync(source.path).mode & 0o777 : 0o600,
    bytes: existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES).toString("base64") : ""
  };
}

// recover each target to its own last proven baseline
async function recoverLastEffective(descriptor, targets, expectedSources, options) {
  let recoveryError;
  // avoid mixing target baselines from different proven generations
  for (const target of targets) {
    try {
      await recoverEffectiveTarget(descriptor, target, expectedSources, options);
    } catch (error) {
      // still attempt every independently recoverable target
      recoveryError ??= error;
    }
  }
  // surface the first incomplete recovery
  if (recoveryError) {
    throw recoveryError;
  }
}

// temporarily apply one proven graph and restore desired truth
async function recoverEffectiveTarget(descriptor, target, expectedSources, options) {
  const bundle = readEffectiveBundle(descriptor, target);
  if (!bundle) {
    throw safeError("recovery-unavailable");
  }
  const baseline = validateDescriptor(bundle.descriptor, resolve(descriptor.controlRoot, "installation.json"));
  const desiredAuthority = loadDesiredDescriptor(descriptor);
  const expected = new Map(expectedSources.map((source) => [source.id, source]));
  const desired = [];
  const restored = [];
  let verifiedRecoverySources;
  const previousBoot = readOptionalJson(resolve(descriptor.controlRoot, "boot.json"));
  try {
    // preserve current desired bytes before temporary restoration
    for (const original of bundle.originals) {
      const source = baseline.sources[original.id];
      const desiredSource = desiredAuthority.sources[original.id];
      if (!source) {
        throw safeError("recovery-unavailable");
      }
      // preserve migrated desired files at their separate identities
      if (desiredSource && desiredSource.path !== source.path) {
        assertEntryUnchanged(source, original);
        continue;
      }
      const current = captureEntry(source, original.id);
      assertExpectedEntry(current, expected.get(original.id));
      desired.push(current);
      restoreEntry(source.path, original);
      restored.push(original);
    }
    const composeValidation = await validateDeploymentGraph(baseline, `recover-${target}`, options);
    // recheck the live graph immediately before recovery deployment
    if (composeValidation) {
      verifyComposeDependencies(composeValidation.dependencySnapshot, baseline);
    }
    // reuse encrypted baseline argv even when the desired process has no PID
    const recoveryOptions = target === "cloudflared" && baseline.kind === "systemd"
      ? {
          ...options,
          nativeCloudflaredCommand: bundle.proof?.nativeCommand,
          nativeCloudflaredCommandDescriptor: bundle.descriptor,
          nativeCloudflaredExpectedCommandDescriptor: desiredAuthority,
          nativeCloudflaredRequireExistingDropIn: true
        }
      : options;
    const targetProofs = await applyTargets(baseline, [target], recoveryOptions);
    // prove Cloudflare recovery consumed the encrypted baseline bytes
    if (target === "cloudflared") {
      const cloudflaredProof = await proveAppliedCloudflared(baseline, options, "recovery");
      const sources = bundle.originals.map((entry) => ({
        id: entry.id,
        existed: entry.existed,
        contentHash: sha256(Buffer.from(entry.bytes, "base64"))
      }));
      verifyAppliedTargetProof(baseline, target, cloudflaredProof, sources, targetProofs.cloudflared);
    }
    if (target === "rac") {
      const sources = bundle.originals.map((entry) => ({
        id: entry.id,
        existed: entry.existed,
        contentHash: sha256(Buffer.from(entry.bytes, "base64"))
      }));
      const recoveryRequest = { kind: "recover", sources, targets: [target] };
      if (options.recoveryProve) {
        await options.recoveryProve(baseline, recoveryRequest, previousBoot);
      } else {
        const recoveryProof = await waitForProof(baseline, recoveryRequest, previousBoot, await expectedEnvironmentHashes(baseline, options), options);
        verifiedRecoverySources = new Map(recoveryProof[EFFECTIVE_SOURCES].map((source) => [source.id, source]));
      }
    }
  } finally {
    // never overwrite edits made while recovery was applying
    let restoreError;
    for (let index = restored.length - 1; index >= 0; index -= 1) {
      const original = restored[index];
      const source = baseline.sources[original.id];
      try {
        const verified = verifiedRecoverySources?.get(original.id);
        // accept only a migration verified by the recovery boot
        if (verified && verified.contentHash !== sha256(Buffer.from(original.bytes, "base64"))) {
          assertExpectedEntry(captureEntry(source, original.id), verified);
        } else {
          assertEntryUnchanged(source, original);
        }
        restoreEntry(source.path, desired.find((entry) => entry.id === original.id));
      } catch (error) {
        restoreError ??= error;
      }
    }
    if (restoreError) {
      throw restoreError;
    }
  }
}

// prove a post-replacement Cloudflare target without bootstrap test injection
async function proveAppliedCloudflared(descriptor, options, phase) {
  const hook = phase === "recovery" ? options.recoveryTargetProve : options.postApplyProve;
  try {
    if (hook) {
      return await hook(descriptor, "cloudflared");
    }
    return await proveInitialTargetBaseline(descriptor, "cloudflared", { ...options, baselineProve: undefined });
  } catch {
    throw safeError("cloudflared-proof-failed");
  }
}

// bind a consumed target proof to the original desired manifest
function verifyAppliedTargetProof(descriptor, target, proof, sources, appliedProof) {
  const expected = new Map(sources.map((source) => [source.id, source]));
  if (!proof?.hashes || !proof.targetProofs?.[target]) {
    throw safeError("cloudflared-proof-failed");
  }
  // require the complete affected graph to match the desired request
  for (const id of recoverySourceIds(descriptor, target)) {
    const requested = expected.get(id);
    const existed = existsSync(descriptor.sources[id].path);
    if (
      !requested ||
      requested.contentHash !== proof.hashes[id] ||
      (requested.existed !== undefined && requested.existed !== existed)
    ) {
      throw safeError("cloudflared-proof-failed");
    }
  }
  const verified = proof.targetProofs[target];
  if (
    appliedProof?.containerId && appliedProof.containerId !== verified.containerId ||
    appliedProof?.stopped === true && verified.stopped !== true ||
    appliedProof?.unit && appliedProof.unit !== verified.unit
  ) {
    throw safeError("cloudflared-proof-failed");
  }
}

// open and validate one encrypted effective target bundle
function readEffectiveBundle(descriptor, target, optional = false) {
  const envelopePath = resolve(descriptor.controlRoot, "recovery", `effective-${target}.json`);
  if (!existsSync(envelopePath)) {
    return undefined;
  }
  try {
    const maximum = 4 * MAX_SOURCE_BYTES * Math.max(1, Object.keys(descriptor.sources).length);
    const bundle = openLocal(readRecoveryKey(descriptor.controlRoot), readJsonFile(envelopePath, maximum));
    if (
      bundle?.version !== PROTOCOL_VERSION ||
      bundle.target !== target ||
      !Number.isSafeInteger(bundle.generation) ||
      !Array.isArray(bundle.originals) ||
      !bundle.descriptor
    ) {
      throw safeError("recovery-unavailable");
    }
    validateDescriptor(bundle.descriptor, resolve(descriptor.controlRoot, "installation.json"));
    return bundle;
  } catch (error) {
    // a missing-quality optional baseline may be safely reproved
    if (optional) {
      return undefined;
    }
    throw error;
  }
}

// validate and recheck the exact live Compose graph before deployment
async function validateDeploymentGraph(descriptor, operationId, options) {
  if (descriptor.kind !== "compose") {
    return undefined;
  }
  const stage = resolve(descriptor.controlRoot, "staging", operationId, "apply-validation");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const validation = await validateComposeCandidates(descriptor, new Map(), stage, options.runner ?? runBounded);
    verifyComposeDependencies(validation.dependencySnapshot, descriptor);
    return validation;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// guard the pre-recovery server manifest when supplied
function assertExpectedEntry(entry, expected) {
  if (!expected) {
    return;
  }
  if ((expected.existed !== undefined && expected.existed !== entry.existed) || expected.contentHash !== sha256(Buffer.from(entry.bytes, "base64"))) {
    throw safeError("manual-recovery-required");
  }
}

// guard against human edits during recovery
function assertEntryUnchanged(source, expected) {
  const current = captureEntry(source, expected.id);
  if (current.existed !== expected.existed || sha256(Buffer.from(current.bytes, "base64")) !== sha256(Buffer.from(expected.bytes, "base64"))) {
    throw safeError("manual-recovery-required");
  }
}

// restore one encrypted bundle entry
function restoreEntry(path, entry) {
  if (entry.existed) {
    atomicWriteFile(path, Buffer.from(entry.bytes, "base64"), entry.mode);
  } else if (existsSync(path)) {
    unlinkCurrentSource(path);
  }
}

// remove one currently selected source through a pinned identity
function unlinkCurrentSource(path) {
  const selected = inspectOwnedPath(path);
  const bytes = readBoundedFile(path, MAX_SOURCE_BYTES);
  unlinkIfIdentity(path, { stat: selected.stat, contentHash: sha256(bytes) });
}

// read optional private metadata
function readOptionalJson(path) {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// create installer recovery material
export function ensureRecoveryKey(controlRoot) {
  const path = resolve(controlRoot, "recovery.key");
  if (!existsSync(path)) {
    atomicWriteFile(path, randomBytes(32), 0o600);
  }
  chmodSync(path, 0o600);
}

// remove plaintext candidates after terminal processing
export function removeOperationStage(descriptor, requestId) {
  rmSync(resolve(descriptor.controlRoot, "staging", requestId), { recursive: true, force: true });
}

// load a validated pending descriptor without promoting it
function loadDesiredDescriptor(descriptor) {
  const path = resolve(descriptor.controlRoot, "desired-installation.json");
  if (!existsSync(path)) {
    return descriptor;
  }
  const desired = readJsonFile(path, 1024 * 1024);
  if (desired.generation !== descriptor.generation + 1 || desired.installationId !== descriptor.installationId) {
    throw safeError("desired-generation-invalid");
  }
  return validateDescriptor(desired, resolve(descriptor.controlRoot, "installation.json"));
}

// promote only after boot and health prove the desired graph
function promoteDescriptor(activeDescriptor, desiredDescriptor) {
  const promoted = { ...desiredDescriptor };
  delete promoted.controlRoot;
  atomicWriteFile(resolve(activeDescriptor.controlRoot, "installation.json"), `${JSON.stringify(promoted, null, 2)}\n`, 0o600);
  const desiredPath = resolve(activeDescriptor.controlRoot, "desired-installation.json");
  if (existsSync(desiredPath)) {
    unlinkSync(desiredPath);
  }
}

// merge separate RAC and Cloudflare proofs
function recordEffectiveReceipt(descriptor, receipt) {
  const path = resolve(descriptor.controlRoot, "effective.json");
  const current = readOptionalJson(path) ?? { version: PROTOCOL_VERSION, targets: {} };
  const targets = { ...(current.targets ?? {}) };
  for (const target of receipt.targets) {
    targets[target] = receipt;
  }
  atomicWriteFile(path, `${JSON.stringify({ version: PROTOCOL_VERSION, targets, updatedAt: receipt.completedAt })}\n`, 0o600);
}

// clear only targets proved by this operation
function clearPendingTargets(descriptor, appliedTargets) {
  const path = resolve(descriptor.controlRoot, "pending.json");
  const pending = readOptionalJson(path);
  if (!pending) {
    return;
  }
  const targets = (pending.targets ?? []).filter((target) => !appliedTargets.includes(target));
  if (targets.length === 0) {
    unlinkSync(path);
    return;
  }
  atomicWriteFile(path, `${JSON.stringify({ ...pending, targets })}\n`, 0o600);
}
