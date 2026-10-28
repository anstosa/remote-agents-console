import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { removeObsoleteOperationArtifacts } from "./queue.mjs";

// remove redundant ciphertext without discarding current or replayable work
test("terminal retention bounds old artifacts and preserves active referenced operations", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-retention-"));
  // publish only isolated bounded fixture metadata
  const write = (path, value) => writeFileSync(resolve(root, path), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  try {
    for (const name of ["queued", "claimed", "status", "journal", "recovery"]) mkdirSync(resolve(root, name), { mode: 0o700 });
    const names = ["recent", "obsolete", "reconnect-failed", "queued", "claimed", "pending", "latest", "unfinished"];
    // model terminal transactions with distinct protected pointer identities
    for (const name of names) {
      const id = `operation_${name}_000001`;
      const reconnectFailure = name === "reconnect-failed";
      write(`status/${id}.json`, { version: 1, id, state: reconnectFailure ? "failed" : "complete", kind: reconnectFailure ? "cloudflare" : "commit", updatedAt: new Date(name === "recent" ? 10_000 : 0).toISOString() });
      write(`journal/${id}.json`, { version: 1, id, ...(reconnectFailure ? { action: "reconnect" } : {}), phase: name === "unfinished" ? "committing" : reconnectFailure ? "rolled-back" : "complete" });
      write(`recovery/${id}.json`, "private ciphertext");
      if (["queued", "claimed"].includes(name)) write(`${name}/${id}.json`, { version: 1, id });
    }
    write("pending.json", { recoveryId: "operation_pending_000001" });
    write("latest-deploy.json", { id: "operation_latest_000001" });
    write("recovery/effective-rac.json", "keep encrypted baseline");
    removeObsoleteOperationArtifacts({ controlRoot: root }, { maxTerminal: 1, maxAgeMs: 20_000, now: 15_000 });
    assert.equal(existsSync(resolve(root, "recovery/operation_recent_000001.json")), false);
    assert.equal(existsSync(resolve(root, "status/operation_recent_000001.json")), true);
    // prune both successful and failed terminal reconnect artifacts
    for (const name of ["obsolete", "reconnect-failed"]) for (const folder of ["recovery", "status", "journal"]) assert.equal(existsSync(resolve(root, `${folder}/operation_${name}_000001.json`)), false);
    for (const name of ["queued", "claimed", "pending", "latest", "unfinished"]) for (const folder of ["recovery", "status", "journal"]) assert.equal(existsSync(resolve(root, `${folder}/operation_${name}_000001.json`)), true);
    assert.equal(existsSync(resolve(root, "recovery/effective-rac.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
