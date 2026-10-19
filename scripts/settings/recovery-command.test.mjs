import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { installRecoveryCommand, requireRecoveryCompletion } from "./recovery-command.mjs";

// install a fixed executable without accepting operator-authored command text
test("installs a private fixed recovery command and preserves unrelated commands", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-recovery-command-"));
  try {
    const destination = installRecoveryCommand({ repository: root, node: process.execPath, binDirectory: root });
    assert.equal(statSync(destination).mode & 0o777, 0o700);
    assert.match(readFileSync(destination, "utf8"), /rac-settings-recovery:managed/u);
    assert.match(readFileSync(destination, "utf8"), /settings-recovery\.mjs/u);
    writeFileSync(destination, "operator command", { mode: 0o700 });
    assert.throws(() => installRecoveryCommand({ repository: root, node: process.execPath, binDirectory: root }), { code: "recovery-command-conflict" });
    assert.equal(readFileSync(destination, "utf8"), "operator command");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// never report drain success as operation success
test("requires the exact successful recovery receipt and waits for a watcher", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-recovery-status-"));
  const id = "recovery_operation_test_01";
  const path = resolve(root, "status", `${id}.json`);
  mkdirSync(resolve(root, "status"), { mode: 0o700 });
  // publish only the fixture's bounded status metadata
  const publish = details => writeFileSync(path, JSON.stringify({ version: 1, id, kind: "recover", ...details }), { mode: 0o600 });
  try {
    publish({ state: "failed", error: "recovery-unavailable" });
    await assert.rejects(requireRecoveryCompletion(root, id), { code: "recovery-failed" });
    publish({ state: "complete", phase: "applied" });
    await assert.rejects(requireRecoveryCompletion(root, id), { code: "recovery-failed" });
    publish({ state: "complete", phase: "recovered", id: "another_operation_test_01" });
    await assert.rejects(requireRecoveryCompletion(root, id), { code: "recovery-status-invalid" });
    publish({ state: "running" });
    const timer = setTimeout(() => publish({ state: "complete", phase: "recovered" }), 10);
    await requireRecoveryCompletion(root, id, { timeoutMs: 500, pollMs: 5 });
    clearTimeout(timer);
    publish({ state: "running" });
    await assert.rejects(requireRecoveryCompletion(root, id, { timeoutMs: 0 }), { code: "recovery-pending" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
