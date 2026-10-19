import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { basename, resolve } from "node:path";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, SOURCE_IDS } from "./constants.mjs";
import { readRequest, validateDescriptor } from "./contracts.mjs";
import { sha256 } from "./crypto.mjs";
import { atomicWriteFile, inspectOwnedPath, readBoundedFile, readJsonFile, safeError, syncDirectory } from "./fs.mjs";
import { processOperation, recoverClaimedTransaction, removeOperationStage } from "./operations.mjs";
import { recoverControlPlaneHandover } from "./checkout-handover.mjs";

const REQUEST_NAME = /^([A-Za-z0-9_-]{20,64})\.json$/;
const TERMINAL = new Set(["complete", "failed"]);

// drain claimed work before atomically claiming queued work
export async function drainQueue(descriptor, options = {}) {
  removeExpiredDisclosureStatuses(descriptor);
  removeObsoleteOperationArtifacts(descriptor);
  await recoverControlPlaneHandover(descriptor, options);
  let emptyPasses = 0;
  while (emptyPasses < 2) {
    const claimed = listRequests(resolve(descriptor.controlRoot, "claimed"));
    const queued = listRequests(resolve(descriptor.controlRoot, "queued"));
    if (claimed.length === 0 && queued.length === 0) {
      emptyPasses += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.emptyDelayMs ?? 25));
      continue;
    }
    emptyPasses = 0;
    // reconcile old claims first
    for (const name of claimed) {
      const current = reloadDescriptor(descriptor);
      await processClaim(resolve(current.controlRoot, "claimed", name), current, options);
    }
    // claim queued requests in lexical order
    for (const name of queued) {
      const queuedPath = resolve(descriptor.controlRoot, "queued", name);
      const claimedPath = resolve(descriptor.controlRoot, "claimed", name);
      try {
        renameSync(queuedPath, claimedPath);
        syncDirectory(resolve(descriptor.controlRoot, "queued"));
        syncDirectory(resolve(descriptor.controlRoot, "claimed"));
      } catch (error) {
        // another helper may have won the claim
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const current = reloadDescriptor(descriptor);
      await processClaim(claimedPath, current, options);
    }
  }
  removeObsoleteOperationArtifacts(reloadDescriptor(descriptor));
}

// bound obsolete terminal metadata while preserving every live or referenced identity
export function removeObsoleteOperationArtifacts(descriptor, options = {}) {
  const root = descriptor.controlRoot;
  const retained = new Set([...listRequests(resolve(root, "queued")), ...listRequests(resolve(root, "claimed"))].map(name => REQUEST_NAME.exec(name)[1]));
  // retain the current user-visible receipt and pending recovery identity
  for (const name of ["latest.json", "latest-deploy.json", "pending.json"]) {
    try {
      const record = readJsonFile(resolve(root, name), MAX_REQUEST_BYTES);
      for (const id of [record.id, record.recoveryId]) if (/^[A-Za-z0-9_-]{20,64}$/u.test(id ?? "")) retained.add(id);
    } catch {
      // missing or malformed pointers never grant deletion authority
    }
  }
  const completed = [];
  // inspect only terminal canonical operation files
  for (const name of listRequests(resolve(root, "status"))) {
    const id = REQUEST_NAME.exec(name)[1];
    try {
      const status = readJsonFile(resolve(root, "status", name), MAX_REQUEST_BYTES * 2);
      if (status.version !== PROTOCOL_VERSION || status.id !== id || !TERMINAL.has(status.state) || retained.has(id)) continue;
      const journalPath = resolve(root, "journal", name);
      const journal = existsSync(journalPath) ? readJsonFile(journalPath, MAX_REQUEST_BYTES * 2) : undefined;
      // transaction originals are redundant after a durable terminal journal
      if (journal?.id === id && ["complete", "rolled-back"].includes(journal.phase)) {
        const recovery = resolve(root, "recovery", name);
        if (existsSync(recovery)) { inspectOwnedPath(recovery); unlinkSync(recovery); }
      }
      const time = Date.parse(status.updatedAt);
      if (Number.isFinite(time) && (!journal || ["complete", "rolled-back"].includes(journal.phase))) completed.push({ id, name, time, journalPath, journal });
    } catch {
      // keep ambiguous artifacts for explicit recovery instead of guessing
    }
  }
  completed.sort((left, right) => right.time - left.time);
  // preserve recent replay receipts within a bounded count and age
  for (const [index, entry] of completed.entries()) {
    if (index < (options.maxTerminal ?? 200) && entry.time + (options.maxAgeMs ?? 86_400_000) > (options.now ?? Date.now())) continue;
    if (entry.journal) { inspectOwnedPath(entry.journalPath); unlinkSync(entry.journalPath); }
    const statusPath = resolve(root, "status", entry.name);
    inspectOwnedPath(statusPath); unlinkSync(statusPath);
  }
}

// remove only expired terminal ciphertext envelopes
export function removeExpiredDisclosureStatuses(descriptor, now = Date.now()) {
  const statusRoot = resolve(descriptor.controlRoot, "status");
  // inspect canonical operation status files only
  for (const name of listRequests(statusRoot)) {
    const path = resolve(statusRoot, name);
    try {
      inspectOwnedPath(path);
      const status = readJsonFile(path, 2 * MAX_REQUEST_BYTES);
      // abandoned identity inspections are ephemeral, not deployment receipts
      if (status.version === PROTOCOL_VERSION && TERMINAL.has(status.state) && status.kind === "inspect" && Number.isFinite(Date.parse(status.updatedAt)) && Date.parse(status.updatedAt) + 60_000 <= now) {
        unlinkSync(path);
        continue;
      }
      if (
        status.version === PROTOCOL_VERSION &&
        status.state === "complete" &&
        ["read", "reveal"].includes(status.kind) &&
        status.response &&
        Number.isSafeInteger(status.response.expiresAt) &&
        status.response.expiresAt <= now
      ) {
        unlinkSync(path);
      }
    } catch {
      // leave malformed or concurrently consumed statuses untouched
    }
  }
}

// reload promoted generations between queued operations
function reloadDescriptor(descriptor) {
  const path = resolve(descriptor.controlRoot, "installation.json");
  return validateDescriptor(readJsonFile(path, MAX_REQUEST_BYTES), path);
}

// list only canonical request filenames
function listRequests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && REQUEST_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// process one exclusive claimed request
export async function processClaim(path, descriptor, options = {}) {
  inspectOwnedPath(path);
  const bytes = readBoundedFile(path, MAX_REQUEST_BYTES);
  const digest = sha256(bytes);
  const fileMatch = REQUEST_NAME.exec(basename(path));
  if (!fileMatch) {
    throw safeError("invalid-request");
  }
  const fileId = fileMatch[1];
  const statusPath = resolve(descriptor.controlRoot, "status", `${fileId}.json`);
  const existing = existsSync(statusPath) ? readJsonFile(statusPath, MAX_REQUEST_BYTES * 2) : undefined;
  if (existing && TERMINAL.has(existing.state)) {
    if (existing.privateRecord?.requestDigest !== digest) {
      atomicWriteFile(resolve(descriptor.controlRoot, "journal", `${fileId}-rejected.json`), `${JSON.stringify({
        version: PROTOCOL_VERSION,
        id: fileId,
        error: "operation-id-reused",
        rejectedAt: new Date().toISOString()
      })}\n`, 0o600);
      writeStatus(descriptor, fileId, "failed", existing.kind, {
        error: "operation-id-reused",
        requestDigest: digest
      });
    }
    removeOperationStage(descriptor, fileId);
    unlinkSync(path);
    return;
  }
  let request;
  try {
    request = readRequest(path, descriptor);
    if (request.id !== fileId) {
      throw safeError("invalid-request");
    }
    writeStatus(descriptor, request.id, "running", request.kind, { phase: "claimed", requestDigest: digest });
    const recoveredReceipt = recoverClaimedTransaction(descriptor, request);
    if (recoveredReceipt) {
      writeStatus(descriptor, request.id, "complete", request.kind, {
        phase: "committed",
        receipt: recoveredReceipt,
        requestDigest: digest
      });
      return;
    }
    const execute = async () => processOperation(descriptor, request, options);
    const result = options.withMutation ? await options.withMutation(execute, request) : await execute();
    writeStatus(descriptor, request.id, "complete", request.kind, {
      phase: result.phase,
      receipt: result.receipt,
      response: result.response,
      sourceMetadata: result.sourceMetadata,
      requestDigest: digest
    });
  } catch (error) {
    writeStatus(descriptor, fileId, "failed", request?.kind ?? "unknown", {
      error: safeCode(error),
      errorMetadata: migrationErrorMetadata(error, request),
      requestDigest: digest
    });
  } finally {
    // the claimed filename owns cleanup even when its body is invalid
    removeOperationStage(descriptor, fileId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

// publish durable operation and latest status
export function writeStatus(descriptor, id, state, kind, details = {}) {
  const status = {
    version: PROTOCOL_VERSION,
    id,
    state,
    kind,
    updatedAt: new Date().toISOString(),
    ...(details.phase ? { phase: details.phase } : {}),
    ...(details.error ? { error: details.error } : {}),
    ...(details.errorMetadata ? { errorMetadata: details.errorMetadata } : {}),
    ...(details.receipt ? { privateRecord: { ...details.receipt, requestDigest: details.requestDigest } } : { privateRecord: { requestDigest: details.requestDigest } }),
    ...(details.response ? { response: details.response } : {}),
    ...(details.sourceMetadata ? { sourceMetadata: details.sourceMetadata } : {})
  };
  atomicWriteFile(resolve(descriptor.controlRoot, "status", `${id}.json`), `${JSON.stringify(status)}\n`, 0o600);
  const latest = {
    version: PROTOCOL_VERSION,
    id,
    state,
    kind,
    ...(details.phase ? { phase: details.phase } : {}),
    ...(details.error ? { error: details.error } : {}),
    updatedAt: new Date().toISOString()
  };
  atomicWriteFile(resolve(descriptor.controlRoot, "latest.json"), `${JSON.stringify(latest)}\n`, 0o600);
}

// retain only requested fixed source identities for migration prompts
function migrationErrorMetadata(error, request) {
  if (error?.code !== "migration-required" || !["validate", "commit"].includes(request?.kind) || !Array.isArray(error?.sourceIds)) {
    return undefined;
  }
  const requested = new Set((request.sources ?? []).map((source) => source.id));
  const sourceIds = [];
  // filter unknown, foreign and duplicate identities
  for (const sourceId of error.sourceIds) {
    if (typeof sourceId !== "string" || !SOURCE_IDS.has(sourceId) || !requested.has(sourceId) || sourceIds.includes(sourceId)) {
      continue;
    }
    sourceIds.push(sourceId);
    if (sourceIds.length >= requested.size) {
      break;
    }
  }
  return sourceIds.length > 0 ? { sourceIds } : undefined;
}

// expose only stable nonsecret failures
function safeCode(error) {
  const code = typeof error?.code === "string" ? error.code : "operation-failed";
  if (/^[a-z][a-z0-9-]{1,63}$/.test(code)) {
    return code;
  }
  return "operation-failed";
}

// publish a request atomically for tests and recovery CLI
export function enqueueRequest(controlRoot, request) {
  const path = resolve(controlRoot, "queued", `${request.id}.json`);
  if (existsSync(path) || existsSync(resolve(controlRoot, "claimed", `${request.id}.json`))) {
    throw safeError("operation-exists");
  }
  atomicWriteFile(path, `${JSON.stringify(request)}\n`, 0o600);
  return path;
}
