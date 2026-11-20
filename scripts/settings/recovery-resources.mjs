import { resolve } from "node:path";
import { runBounded } from "./command.mjs";
import { safeError } from "./fs.mjs";

const MAX_RESOURCE_BYTES = 512_000;
const MAX_RESOURCE_TIMEOUT_MS = 3_500;
const RESOURCE_KEYS = new Set(["cpuPercent", "memory", "disks", "diskError"]);
const MEMORY_KEYS = new Set(["usedBytes", "totalBytes"]);
const DISK_KEYS = new Set(["mount", "usedBytes", "totalBytes"]);

// recognize one ordinary JSON record
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// reject fields outside one fixed public resource shape
function exactKeys(value, allowed, required) {
  // inspect every supplied field
  for (const key of Object.keys(value)) {
    // caller-controlled extensions are never part of telemetry
    if (!allowed.has(key)) return false;
  }
  return required.every((key) => Object.hasOwn(value, key));
}

// accept only exact non-negative byte counters
function byteValue(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// validate one bounded Windows volume record
function resourceDisk(value) {
  // require the complete fixed disk shape
  if (!record(value) || !exactKeys(value, DISK_KEYS, ["mount", "usedBytes", "totalBytes"]) || typeof value.mount !== "string" || value.mount.length < 1 || value.mount.length > 256) return false;
  // keep unavailable disk counters consistently paired
  if ((value.usedBytes === null) !== (value.totalBytes === null)) return false;
  // an explicitly unavailable volume has no numeric ordering to validate
  if (value.usedBytes === null) return true;
  return byteValue(value.usedBytes) && byteValue(value.totalBytes) && value.usedBytes <= value.totalBytes;
}

// parse one fixed recovery resource response without retaining private output
export function parseRecoveryResources(stdout) {
  let value;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw safeError("recovery-resources-failed");
  }
  // require the complete top-level resource contract
  if (!record(value) || !exactKeys(value, RESOURCE_KEYS, ["cpuPercent", "memory", "disks"]) || !Array.isArray(value.disks) || value.disks.length > 128 || !value.disks.every(resourceDisk)) {
    throw safeError("recovery-resources-failed");
  }
  // accept only null or a bounded CPU percentage
  if (value.cpuPercent !== null && (typeof value.cpuPercent !== "number" || !Number.isFinite(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 100)) {
    throw safeError("recovery-resources-failed");
  }
  // validate available memory as one exact internally consistent record
  if (value.memory !== null && (!record(value.memory) || !exactKeys(value.memory, MEMORY_KEYS, ["usedBytes", "totalBytes"]) || !byteValue(value.memory.usedBytes) || !byteValue(value.memory.totalBytes) || value.memory.usedBytes > value.memory.totalBytes)) {
    throw safeError("recovery-resources-failed");
  }
  // bound the only optional human-readable field
  if (value.diskError !== undefined && (typeof value.diskError !== "string" || value.diskError.length < 1 || value.diskError.length > 256)) {
    throw safeError("recovery-resources-failed");
  }
  return value;
}

// execute only the repository-owned Windows recovery collector before its deadline
export async function collectRecoveryResources(descriptor, request, options = {}) {
  const remaining = request.resourceSample.deadline - Date.now();
  // never launch stale queued telemetry
  if (remaining <= 0) throw safeError("recovery-resource-expired");
  const helper = resolve(descriptor.hostCheckout, "scripts/resource-monitor.mjs");
  let result;
  try {
    result = await (options.recoveryResourceRunner ?? runBounded)(process.execPath, [helper, "--recovery-host"], {
      cwd: descriptor.hostCheckout,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      timeoutMs: Math.min(MAX_RESOURCE_TIMEOUT_MS, remaining),
      maxBytes: MAX_RESOURCE_BYTES,
      signal: options.signal
    });
  } catch {
    // collector absence and timeouts are valid host unavailability
    return { phase: "unavailable", hostResources: null };
  }
  // a fixed collector failure does not grant any fallback execution path
  if (result.code !== 0) return { phase: "unavailable", hostResources: null };
  return { phase: "sampled", hostResources: parseRecoveryResources(result.stdout) };
}
