import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runBounded } from "./command.mjs";
import { frameFields, openLocal, sealLocal, sha256 } from "./crypto.mjs";
import { atomicWriteFile, readBoundedFile, readJsonFile, safeError } from "./fs.mjs";

// enumerate the complete fixed host protocol instead of accepting authored imports
export const CHECKOUT_RUNTIME_FILES = [
  "scripts/apply-settings.mjs", "scripts/settings-recovery.mjs", "scripts/update-server.sh",
  "scripts/settings/baseline.mjs", "scripts/settings/checkout-handover.mjs", "scripts/settings/command.mjs",
  "scripts/settings/constants.mjs", "scripts/settings/contracts.mjs", "scripts/settings/crypto.mjs",
  "scripts/settings/dependencies.mjs", "scripts/settings/fs.mjs", "scripts/settings/inspection.mjs",
  "scripts/settings/install.mjs", "scripts/settings/lock.mjs", "scripts/settings/migrations.mjs",
  "scripts/settings/operations.mjs", "scripts/settings/queue.mjs", "scripts/settings/recovery-command.mjs",
  "scripts/settings/update.mjs", "scripts/settings/validate.mjs",
  "systemd/remote-agent-console.service.in", "systemd/remote-agent-settings-apply.service.in",
  "systemd/remote-agent-settings-apply.path.in"
];

// require byte-compatible recovery and queue code at the adopted checkout
export function validateCheckoutHandover(active, desired) {
  if (active.hostCheckout === desired.hostCheckout) return;
  if (runtimeHash(active.hostCheckout) !== runtimeHash(desired.hostCheckout)) throw safeError("checkout-helper-incompatible");
  // native relocation also needs a built application at its fixed entrypoint
  if (desired.kind === "systemd") readBoundedFile(resolve(desired.hostCheckout, "apps/server/dist/index.js"), 2_097_152);
}

// hash framed path mode and source bytes through no-follow reads
function runtimeHash(checkout) {
  const fields = ["rac-settings-checkout/v1"];
  // inspect every transitively loaded protocol artifact
  for (const relative of CHECKOUT_RUNTIME_FILES) {
    const path = resolve(checkout, relative);
    fields.push(relative, String(lstatSync(path).mode & 0o777), sha256(readBoundedFile(path, 2_097_152)));
  }
  return sha256(frameFields(fields));
}

// switch fixed helper artifacts only after the desired runtime is proved
export async function handoverControlPlane(active, desired, options = {}) {
  if (active.hostCheckout === desired.hostCheckout) return;
  validateCheckoutHandover(active, desired);
  await recoverControlPlaneHandover(active, options);
  const unitRoot = options.handoverUnitDirectory ?? resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "systemd/user");
  const binRoot = options.recoveryBinDirectory ?? resolve(homedir(), ".local/bin");
  const node = options.handoverNode ?? process.execPath;
  const servicePath = resolve(unitRoot, "remote-agent-settings-apply.service");
  const recoveryPath = resolve(binRoot, "rac-settings-recover");
  const service = renderService(desired, node);
  const recovery = renderRecovery(desired, node);
  const entries = [artifact(servicePath, service, 0o600), artifact(recoveryPath, recovery, 0o700)];
  // require exact installed active renders rather than adopting current manual edits
  const activeService = Buffer.from(entries[0].before, "base64").toString("utf8");
  if (![renderService(active, node), renderService(active, node, true)].includes(activeService) || entries[0].beforeMode !== 0o600 || Buffer.from(entries[1].before, "base64").toString("utf8") !== renderRecovery(active, node) || entries[1].beforeMode !== 0o700) throw safeError("manual-recovery-required");
  const journal = { version: 1, from: active.hostCheckout, to: desired.hostCheckout, fromGeneration: active.generation, toGeneration: desired.generation, phase: "prepared", entries };
  writeHandover(active, journal);
  try {
    // journal each atomic replacement before mutating its fixed artifact
    for (const entry of entries) {
      assertArtifact(entry, "before");
      atomicWriteFile(entry.path, Buffer.from(entry.after, "base64"), entry.afterMode);
      journal.phase = entry.path === servicePath ? "helper-written" : "recovery-written";
      writeHandover(active, journal);
      options.afterHandoverPhase?.(journal.phase);
    }
    await reloadUnits(options);
    const shown = await (options.runner ?? runBounded)("systemctl", ["--user", "show", "remote-agent-settings-apply.service", "--property=WorkingDirectory", "--property=ExecStart"], { maxBytes: 65_536 });
    const metadata = shown.stdout.toString("utf8");
    if (shown.code !== 0 || !metadata.includes(`WorkingDirectory=${desired.hostCheckout}\n`) || !metadata.includes(resolve(desired.hostCheckout, "scripts/apply-settings.mjs"))) throw safeError("checkout-helper-proof-failed");
    validateCheckoutHandover(active, desired);
    journal.phase = "proved";
    writeHandover(active, journal);
  } catch (error) {
    await recoverControlPlaneHandover(active, options);
    throw error;
  }
}

// restore only transaction-produced artifacts or finish a promoted handover
export async function recoverControlPlaneHandover(descriptor, options = {}) {
  const path = resolve(descriptor.controlRoot, "journal/checkout-handover.json");
  if (!existsSync(path)) return;
  const journal = openLocal(readBoundedFile(resolve(descriptor.controlRoot, "recovery.key"), 32), readJsonFile(path, 2_097_152));
  if (journal.version !== 1 || !Array.isArray(journal.entries) || journal.entries.length !== 2) throw safeError("checkout-handover-invalid");
  // a promoted descriptor can only finish forward
  if (descriptor.hostCheckout === journal.to && descriptor.generation === journal.toGeneration) {
    for (const entry of journal.entries) assertArtifact(entry, "after");
    await reloadUnits(options);
    unlinkSync(path);
    return;
  }
  if (descriptor.hostCheckout !== journal.from || descriptor.generation !== journal.fromGeneration) throw safeError("manual-recovery-required");
  // never replace manually edited artifacts while rolling back a partial handover
  for (const entry of [...journal.entries].reverse()) {
    const current = sha256(readBoundedFile(entry.path, 65_536));
    if (current === sha256(Buffer.from(entry.before, "base64"))) continue;
    assertArtifact(entry, "after");
    atomicWriteFile(entry.path, Buffer.from(entry.before, "base64"), entry.beforeMode);
  }
  await reloadUnits(options);
  unlinkSync(path);
}

// snapshot one existing fixed managed artifact without plaintext persistence
function artifact(path, content, mode) {
  return { path, before: readBoundedFile(path, 65_536).toString("base64"), beforeMode: lstatSync(path).mode & 0o777, after: Buffer.from(content).toString("base64"), afterMode: mode };
}

// render exact fixed service bytes including the supported installer legacy form
function renderService(descriptor, node, legacy = false) {
  const template = readBoundedFile(resolve(descriptor.hostCheckout, "systemd/remote-agent-settings-apply.service.in"), 65_536).toString("utf8");
  if (legacy) return template.replaceAll("@REPOSITORY@", descriptor.hostCheckout).replaceAll("@CONTROL_ROOT@", descriptor.controlRoot).replaceAll("@NODE@", node);
  return template.replaceAll("WorkingDirectory=@REPOSITORY@", `WorkingDirectory=${systemdSetting(descriptor.hostCheckout)}`)
    .replaceAll("@REPOSITORY@/scripts/apply-settings.mjs", systemdQuote(resolve(descriptor.hostCheckout, "scripts/apply-settings.mjs")))
    .replaceAll("@CONTROL_ROOT@", systemdQuote(descriptor.controlRoot)).replaceAll("@NODE@", systemdQuote(node));
}

// render the exact managed recovery command without accepting additional shell text
function renderRecovery(descriptor, node) {
  return `#!/bin/sh\n# rac-settings-recovery:managed\nexec ${shellQuote(node)} ${shellQuote(resolve(descriptor.hostCheckout, "scripts/settings-recovery.mjs"))} "$@"\n`;
}

// refuse manual drift at an exact artifact identity
function assertArtifact(entry, side) {
  if (sha256(readBoundedFile(entry.path, 65_536)) !== sha256(Buffer.from(entry[side], "base64")) || (lstatSync(entry.path).mode & 0o777) !== entry[`${side}Mode`]) throw safeError("manual-recovery-required");
}

// persist the bounded handover journal under the installation recovery key
function writeHandover(descriptor, journal) {
  const key = readBoundedFile(resolve(descriptor.controlRoot, "recovery.key"), 32);
  atomicWriteFile(resolve(descriptor.controlRoot, "journal/checkout-handover.json"), `${JSON.stringify(sealLocal(key, journal))}\n`, 0o600);
}

// reload only fixed user unit metadata
async function reloadUnits(options) {
  const result = await (options.runner ?? runBounded)("systemctl", ["--user", "daemon-reload"], { maxBytes: 65_536 });
  if (result.code !== 0) throw safeError("checkout-helper-reload-failed");
}

// quote one fixed systemd argument without specifier expansion
function systemdQuote(value) {
  if (/[\0\r\n]/u.test(value)) throw safeError("invalid-checkout-path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

// escape a fixed directory directive without expanding unit specifiers
function systemdSetting(value) {
  if (/[\0\r\n]/u.test(value)) throw safeError("invalid-checkout-path");
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20").replaceAll("\t", "\\x09").replaceAll("%", "%%");
}

// quote one fixed recovery command argument
function shellQuote(value) {
  if (/[\0\r\n]/u.test(value)) throw safeError("invalid-checkout-path");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
