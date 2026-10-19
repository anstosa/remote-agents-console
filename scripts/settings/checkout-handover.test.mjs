import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { CHECKOUT_RUNTIME_FILES, handoverControlPlane, recoverControlPlaneHandover, validateCheckoutHandover } from "./checkout-handover.mjs";

// prepare two identical protocol checkouts and fixed private artifacts
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rac-checkout-handover-"));
  const from = resolve(root, "old"); const to = resolve(root, "new"); const controlRoot = resolve(root, "control");
  // copy the explicit runtime manifest without unrelated repository files
  for (const relative of CHECKOUT_RUNTIME_FILES) {
    for (const checkout of [from, to]) { const target = resolve(checkout, relative); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); cpSync(resolve(relative), target); chmodSync(target, statSync(target).mode & 0o755); }
  }
  const unitRoot = resolve(root, "units"); const binRoot = resolve(root, "bin");
  for (const path of [unitRoot, binRoot, controlRoot, resolve(controlRoot, "journal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(controlRoot, "recovery.key"), Buffer.alloc(32, 1), { mode: 0o600 });
  const oldService = readFileSync(resolve(from, "systemd/remote-agent-settings-apply.service.in"), "utf8").replaceAll("@REPOSITORY@", from).replaceAll("@CONTROL_ROOT@", controlRoot).replaceAll("@NODE@", process.execPath);
  const oldRecovery = `#!/bin/sh\n# rac-settings-recovery:managed\nexec '${process.execPath}' '${from}/scripts/settings-recovery.mjs' "$@"\n`;
  writeFileSync(resolve(unitRoot, "remote-agent-settings-apply.service"), oldService, { mode: 0o600 });
  writeFileSync(resolve(binRoot, "rac-settings-recover"), oldRecovery, { mode: 0o700 });
  const active = { hostCheckout: from, controlRoot, generation: 1, kind: "compose" };
  const desired = { ...active, hostCheckout: to, generation: 2 };
  // verify only fixed nonsecret unit metadata in the isolated test
  const runner = async (_command, args) => ({ code: 0, stdout: Buffer.from(args.includes("show") ? `WorkingDirectory=${to}\nExecStart=${to}/scripts/apply-settings.mjs\n` : ""), stderr: Buffer.alloc(0) });
  return { root, from, to, controlRoot, unitRoot, binRoot, oldService, oldRecovery, active, desired, options: { handoverUnitDirectory: unitRoot, recoveryBinDirectory: binRoot, runner } };
}

// reject incompatible target helpers before switching any installation artifacts
test("checkout adoption requires the exact host runtime protocol", () => {
  const current = fixture();
  try {
    validateCheckoutHandover(current.active, current.desired);
    writeFileSync(resolve(current.to, "scripts/settings/queue.mjs"), "incompatible helper", { mode: 0o644 });
    assert.throws(() => validateCheckoutHandover(current.active, current.desired), { code: "checkout-helper-incompatible" });
    assert.equal(readFileSync(resolve(current.unitRoot, "remote-agent-settings-apply.service"), "utf8"), current.oldService);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

// complete a proved handover without retaining the previous checkout locator
test("promoted checkout keeps queue and recovery locators after the old checkout disappears", async () => {
  const current = fixture();
  try {
    await handoverControlPlane(current.active, current.desired, current.options);
    assert.ok(existsSync(resolve(current.controlRoot, "journal/checkout-handover.json")));
    await recoverControlPlaneHandover(current.desired, current.options);
    rmSync(current.from, { recursive: true });
    const unit = readFileSync(resolve(current.unitRoot, "remote-agent-settings-apply.service"), "utf8");
    const recovery = readFileSync(resolve(current.binRoot, "rac-settings-recover"), "utf8");
    assert.ok(unit.includes(current.to)); assert.ok(!unit.includes(current.from));
    assert.ok(recovery.includes(current.to)); assert.ok(!recovery.includes(current.from));
    assert.equal(existsSync(resolve(current.controlRoot, "journal/checkout-handover.json")), false);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

// roll back each prepromotion replacement without deleting external edits
test("partial checkout handovers recover exact artifacts and reject manual drift", async () => {
  // exercise the journaled replacement seams independently
  for (const phase of ["helper-written", "recovery-written"]) {
    const current = fixture();
    try {
      await assert.rejects(handoverControlPlane(current.active, current.desired, { ...current.options, afterHandoverPhase: observed => { if (observed === phase) throw new Error("fixture interruption"); } }));
      assert.equal(readFileSync(resolve(current.unitRoot, "remote-agent-settings-apply.service"), "utf8"), current.oldService);
      assert.equal(readFileSync(resolve(current.binRoot, "rac-settings-recover"), "utf8"), current.oldRecovery);
      await handoverControlPlane(current.active, current.desired, current.options);
      writeFileSync(resolve(current.binRoot, "rac-settings-recover"), "operator replacement\n", { mode: 0o700 });
      await assert.rejects(recoverControlPlaneHandover(current.active, current.options), { code: "manual-recovery-required" });
      assert.equal(readFileSync(resolve(current.binRoot, "rac-settings-recover"), "utf8"), "operator replacement\n");
    } finally { rmSync(current.root, { recursive: true, force: true }); }
  }
});

// refuse pre-existing operator edits before taking any transaction snapshot
test("checkout handover rejects pre-existing managed artifact drift", async () => {
  for (const kind of ["service", "recovery"]) {
    const current = fixture();
    try {
      const path = kind === "service" ? resolve(current.unitRoot, "remote-agent-settings-apply.service") : resolve(current.binRoot, "rac-settings-recover");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, `${original}# operator edit\n`);
      await assert.rejects(handoverControlPlane(current.active, current.desired, current.options), { code: "manual-recovery-required" });
      assert.equal(readFileSync(path, "utf8"), `${original}# operator edit\n`);
      assert.equal(existsSync(resolve(current.controlRoot, "journal/checkout-handover.json")), false);
    } finally { rmSync(current.root, { recursive: true, force: true }); }
  }
});
