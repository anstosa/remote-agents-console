import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { atomicWriteFile, readBoundedFile, unlinkIfIdentity } from "./fs.mjs";
import { sha256 } from "./crypto.mjs";

// reject deterministic final-symlink swaps before reading source bytes
test("bounded reads reject a source symlink swap", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-fs-"));
  try {
    const source = resolve(root, "source"); const outside = resolve(root, "outside");
    writeFileSync(source, "allowed", { mode: 0o600 }); writeFileSync(outside, "private outside", { mode: 0o600 });
    assert.throws(() => readBoundedFile(source, 1024, { beforeOpen: () => { renameSync(source, `${source}.old`); symlinkSync(outside, source); } }), { code: "source-conflict" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// preserve an optional source replaced at the final unlink seam
test("identity-bound deletion rejects replacements and removes only unchanged bytes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-delete-"));
  try {
    const source = resolve(root, "source");
    writeFileSync(source, "original", { mode: 0o600 });
    const expected = { stat: lstatSync(source), contentHash: sha256(Buffer.from("original")) };
    assert.throws(() => unlinkIfIdentity(source, expected, { beforeUnlink: () => { renameSync(source, `${source}.old`); writeFileSync(source, "external replacement", { mode: 0o600 }); } }), { code: "source-conflict" });
    assert.equal(readFileSync(source, "utf8"), "external replacement");
    unlinkIfIdentity(source, { stat: lstatSync(source), contentHash: sha256(Buffer.from("external replacement")) });
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(`${source}.old`, "utf8"), "original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// pin replacement writes to a proven directory rather than a swapped pathname
test("atomic replacement rejects a parent symlink swap without writing outside", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-fs-"));
  const outside = mkdtempSync(resolve(tmpdir(), "rac-settings-outside-"));
  try {
    const source = resolve(root, "source"); const outsideSource = resolve(outside, "source");
    writeFileSync(source, "allowed", { mode: 0o600 }); writeFileSync(outsideSource, "private outside", { mode: 0o600 });
    assert.throws(() => atomicWriteFile(source, "candidate", 0o600, { beforeRename: () => { renameSync(root, `${root}.old`); symlinkSync(outside, root); } }), { code: "source-conflict" });
    assert.equal(readFileSync(outsideSource, "utf8"), "private outside");
    assert.equal(readFileSync(resolve(`${root}.old`, "source"), "utf8"), "allowed");
  } finally { rmSync(root, { force: true, recursive: true }); rmSync(`${root}.old`, { force: true, recursive: true }); rmSync(outside, { force: true, recursive: true }); }
});

// publish new files without replacing a raced destination
test("atomic no-clobber publication preserves a destination created at the final seam", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rac-settings-publish-"));
  try {
    const source = resolve(root, "source");
    const records = [];
    const aborted = [];
    assert.throws(() => atomicWriteFile(source, "candidate", 0o700, {
      noClobber: true,
      onPublishing: (identity) => records.push(identity),
      onPublishAborted: (identity) => aborted.push(identity),
      beforePublish: () => writeFileSync(source, "external", { mode: 0o600 })
    }), { code: "source-conflict" });
    assert.equal(readFileSync(source, "utf8"), "external");
    assert.equal(records.length, 1);
    assert.deepEqual(aborted, records);
    assert.match(records[0].device, /^\d+$/u);
    assert.match(records[0].inode, /^\d+$/u);
    const rejected = resolve(root, "rejected");
    assert.throws(() => atomicWriteFile(rejected, "candidate", 0o700, {
      noClobber: true,
      onPublishing: (identity) => records.push(identity),
      onPublishAborted: (identity) => aborted.push(identity),
      beforePublish: () => { throw new Error("rejected-before-link"); }
    }), /rejected-before-link/u);
    assert.equal(existsSync(rejected), false);
    assert.deepEqual(aborted, records);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
