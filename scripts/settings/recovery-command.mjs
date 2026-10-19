import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { atomicWriteFile, inspectOwnedPath, readJsonFile, safeError } from "./fs.mjs";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION } from "./constants.mjs";

const MARKER = "# rac-settings-recovery:managed";

// require this exact recovery operation to finish successfully
export async function requireRecoveryCompletion(controlRoot, id, options = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/u.test(id)) throw safeError("invalid-request");
  const deadline = Date.now() + (options.timeoutMs ?? 35 * 60_000);
  const path = resolve(controlRoot, "status", `${id}.json`);
  // allow a watcher that won the lock to publish the same terminal receipt
  while (true) {
    if (existsSync(path)) {
      const status = readJsonFile(path, 2 * MAX_REQUEST_BYTES);
      if (status.version !== PROTOCOL_VERSION || status.id !== id || status.kind !== "recover") throw safeError("recovery-status-invalid");
      if (status.state === "complete" && status.phase === "recovered") return;
      if (!["queued", "running"].includes(status.state)) throw safeError("recovery-failed");
    }
    if (Date.now() >= deadline) throw safeError("recovery-pending");
    await new Promise(resolvePromise => setTimeout(resolvePromise, options.pollMs ?? 250));
  }
}

// install one discoverable host-only recovery command
export function installRecoveryCommand({ repository, node, binDirectory = resolve(homedir(), ".local/bin") }) {
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  inspectOwnedPath(binDirectory, { regular: false, writable: true });
  const destination = resolve(binDirectory, "rac-settings-recover");
  // never overwrite an unrelated operator command
  if (existsSync(destination)) {
    inspectOwnedPath(destination);
    if (!readFileSync(destination, "utf8").includes(MARKER)) throw safeError("recovery-command-conflict");
  }
  const content = `#!/bin/sh\n${MARKER}\nexec ${shellQuote(node)} ${shellQuote(resolve(repository, "scripts/settings-recovery.mjs"))} "$@"\n`;
  atomicWriteFile(destination, content, 0o700);
  return destination;
}

// quote fixed installer-selected paths without interpreting shell text
function shellQuote(value) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) throw safeError("invalid-recovery-command");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
