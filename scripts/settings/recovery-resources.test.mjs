import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { readRequest } from "./contracts.mjs";
import { processOperation } from "./operations.mjs";
import { collectRecoveryResources, parseRecoveryResources } from "./recovery-resources.mjs";
import { processClaim, removeExpiredDisclosureStatuses, writeStatus } from "./queue.mjs";

// write one strict recovery resource request fixture
function requestFile(request) {
  const root = mkdtempSync(resolve(tmpdir(), "rac-recovery-resources-"));
  const path = resolve(root, `${request.id}.json`);
  writeFileSync(path, JSON.stringify(request));
  return { root, path };
}

test("recovery resource requests accept only one near-term deadline", () => {
  const valid = { version: 1, id: "recovery_resources_0001", kind: "recovery-resources", generation: 1, resourceSample: { deadline: Date.now() + 5_000 } };
  const descriptor = { generation: 1 };
  const fixture = requestFile(valid);
  try {
    assert.deepEqual(readRequest(fixture.path, descriptor), valid);
    // arbitrary commands and unrelated settings fields are outside the strict envelope
    for (const changed of [
      { ...valid, resourceSample: { deadline: Date.now() + 60_000 } },
      { ...valid, resourceSample: { deadline: 0 } },
      { ...valid, resourceSample: { ...valid.resourceSample, command: "powershell.exe" } },
      { ...valid, sources: [] },
      { ...valid, targets: [] },
      { ...valid, inspect: { sourceId: "app" } }
    ]) {
      writeFileSync(fixture.path, JSON.stringify(changed));
      assert.throws(() => readRequest(fixture.path, descriptor), { code: "invalid-request" });
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovery resource dispatch runs only the fixed bounded collector", async () => {
  const deadline = Date.now() + 5_000;
  const usage = {
    cpuPercent: 12.5,
    memory: { usedBytes: 1_024, totalBytes: 4_096 },
    disks: [{ mount: "C:\\", usedBytes: 2_048, totalBytes: 8_192 }]
  };
  let calls = 0;
  const recoveryResourceRunner = async (command, args, options) => {
    calls += 1;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ["/repo/scripts/resource-monitor.mjs", "--recovery-host"]);
    assert.equal(options.cwd, "/repo");
    assert.deepEqual(options.env, { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 3_500);
    assert.equal(options.maxBytes, 512_000);
    return { code: 0, stdout: Buffer.from(JSON.stringify(usage)), stderr: Buffer.alloc(0) };
  };
  const result = await processOperation(
    { hostCheckout: "/repo" },
    { kind: "recovery-resources", resourceSample: { deadline } },
    { recoveryResourceRunner }
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { phase: "sampled", hostResources: usage });
});

test("recovery resource collection reports unavailable collectors without fallback execution", async () => {
  const descriptor = { hostCheckout: "/repo" };
  const unavailable = await collectRecoveryResources(
    descriptor,
    { resourceSample: { deadline: Date.now() + 5_000 } },
    { recoveryResourceRunner: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("private") }) }
  );
  assert.deepEqual(unavailable, { phase: "unavailable", hostResources: null });
  let called = false;
  await assert.rejects(
    () => collectRecoveryResources(descriptor, { resourceSample: { deadline: Date.now() - 1 } }, { recoveryResourceRunner: async () => { called = true; throw new Error("unexpected"); } }),
    { code: "recovery-resource-expired" }
  );
  assert.equal(called, false);
});

test("recovery resource parsing rejects extensions and inconsistent counters", () => {
  const usage = { cpuPercent: null, memory: null, disks: [], diskError: "Disk usage is unavailable." };
  assert.deepEqual(parseRecoveryResources(Buffer.from(JSON.stringify(usage))), usage);
  for (const invalid of [
    { ...usage, command: "whoami" },
    { ...usage, cpuPercent: 101 },
    { ...usage, memory: { usedBytes: 10, totalBytes: 9 } },
    { ...usage, disks: [{ mount: "C:\\", usedBytes: null, totalBytes: 10 }] }
  ]) {
    assert.throws(() => parseRecoveryResources(Buffer.from(JSON.stringify(invalid))), { code: "recovery-resources-failed" });
  }
});

test("recovery resource statuses stay out of settings receipts and expire quickly", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-recovery-status-"));
  const statusRoot = resolve(root, "status");
  mkdirSync(statusRoot, { mode: 0o700 });
  const id = "recovery_resources_0002";
  const usage = { cpuPercent: null, memory: null, disks: [] };
  try {
    writeFileSync(resolve(root, "latest.json"), "sentinel\n", { mode: 0o600 });
    writeStatus({ controlRoot: root }, id, "complete", "recovery-resources", { phase: "sampled", hostResources: usage, requestDigest: "private" });
    const statusPath = resolve(statusRoot, `${id}.json`);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.deepEqual(status.hostResources, usage);
    assert.deepEqual(status.privateRecord, { requestDigest: "private" });
    assert.equal(readFileSync(resolve(root, "latest.json"), "utf8"), "sentinel\n");
    writeFileSync(statusPath, `${JSON.stringify({ ...status, updatedAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
    removeExpiredDisclosureStatuses({ controlRoot: root }, 60_001);
    assert.equal(existsSync(statusPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired recovery requests fail as telemetry without changing latest settings", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-expired-recovery-"));
  const id = "expired_recovery_000001";
  const claimed = resolve(root, "claimed", `${id}.json`);
  try {
    // create only the fixed queue directories touched by claim processing
    for (const name of ["claimed", "status", "staging"]) mkdirSync(resolve(root, name), { mode: 0o700 });
    writeFileSync(resolve(root, "latest.json"), "sentinel\n", { mode: 0o600 });
    writeFileSync(claimed, `${JSON.stringify({
      version: 1,
      id,
      kind: "recovery-resources",
      generation: 1,
      resourceSample: { deadline: Date.now() - 1 }
    })}\n`, { mode: 0o600 });
    await processClaim(claimed, { controlRoot: root, generation: 1, hostCheckout: "/repo" });
    const status = JSON.parse(readFileSync(resolve(root, "status", `${id}.json`), "utf8"));
    assert.equal(status.kind, "recovery-resources");
    assert.equal(status.state, "failed");
    assert.equal(status.error, "recovery-resource-expired");
    assert.match(status.privateRecord.requestDigest, /^[0-9a-f]{64}$/u);
    assert.equal(readFileSync(resolve(root, "latest.json"), "utf8"), "sentinel\n");
    assert.equal(existsSync(claimed), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// an invalid claim has no authority over the last validated settings operation
for (const scenario of ["old generation", "extra sample field", "foreign id"]) {
  test(`invalid recovery claim (${scenario}) cannot replace latest settings`, async () => {
    const id = "invalid_recovery_000001";
    const request = {
      version: 1, id, kind: "recovery-resources", generation: 1,
      resourceSample: { deadline: Date.now() + 5_000 }
    };
    // exercise distinct failures before claiming an operation identity
    if (scenario === "old generation") request.generation = 2;
    else if (scenario === "extra sample field") request.resourceSample.extra = true;
    else request.id = "foreign_recovery_000001";
    const root = mkdtempSync(resolve(tmpdir(), "rac-invalid-recovery-"));
    const claimed = resolve(root, "claimed", `${id}.json`);
    const statusPath = resolve(root, "status", `${id}.json`);
    const latest = resolve(root, "latest.json");
    try {
      // prepare only the queue directories used by a standalone claim
      for (const name of ["claimed", "status", "staging"]) mkdirSync(resolve(root, name), { mode: 0o700 });
      writeFileSync(latest, "sentinel\n", { mode: 0o600 });
      writeFileSync(claimed, JSON.stringify(request), { mode: 0o600 });
      await processClaim(claimed, { controlRoot: root, generation: 1, hostCheckout: "/repo" });
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      assert.equal(status.kind, "unknown");
      assert.equal(status.state, "failed");
      assert.equal(status.error, "invalid-request");
      assert.equal(readFileSync(latest, "utf8"), "sentinel\n");
      assert.equal(existsSync(claimed), false);
      removeExpiredDisclosureStatuses({ controlRoot: root }, Date.parse(status.updatedAt) + 60_001);
      assert.equal(existsSync(statusPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
