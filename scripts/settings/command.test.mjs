import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runBounded } from "./command.mjs";

// wait for one bounded filesystem condition
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  // poll only until the bounded deadline
  while (!predicate() && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  return predicate();
}

test("runBounded rejects a pre-aborted command before spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runBounded("rac-command-that-must-not-spawn", [], { signal: controller.signal }), { code: "command-aborted" });
});

test("runBounded settles an aborted process tree before returning", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-command-abort-"));
  const ready = resolve(root, "ready");
  const orphan = resolve(root, "orphan");
  const childSource = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(orphan)}, "orphan"), 150)`;
  const parentSource = `const {spawn}=require("node:child_process");const fs=require("node:fs");spawn(process.execPath,["-e",${JSON.stringify(childSource)}],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000)`;
  const controller = new AbortController();
  try {
    const running = runBounded(process.execPath, ["-e", parentSource], { signal: controller.signal, timeoutMs: 1_000, killGraceMs: 10 });
    assert.equal(await waitFor(() => existsSync(ready)), true);
    controller.abort();
    await assert.rejects(running, { code: "command-aborted" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(existsSync(orphan), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
