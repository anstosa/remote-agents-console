#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readJsonFile, safeError } from "./fs.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { currentSourceManifest, processOperation } from "./operations.mjs";
import { assertInheritedMutationLock } from "./lock.mjs";

const [controlRoot, operationId, mode] = process.argv.slice(2);
if (!controlRoot || !/^[A-Za-z0-9_-]{20,64}$/.test(operationId ?? "")) {
  throw safeError("invalid-update-proof");
}
// reject direct deployment calls outside the updater's inherited shared lock
assertInheritedMutationLock(controlRoot);
const descriptorPath = resolve(controlRoot, "installation.json");
const descriptor = validateDescriptor(readJsonFile(descriptorPath, 1024 * 1024), descriptorPath);
if (descriptor.hostCheckout !== process.cwd() || descriptor.kind !== "compose") {
  throw safeError("update-authority-mismatch");
}
if (mode === "--verify-only") {
  const desiredPath = resolve(controlRoot, "desired-installation.json");
  if (existsSync(desiredPath)) {
    const desired = readJsonFile(desiredPath, 1024 * 1024);
    if (desired.hostCheckout !== descriptor.hostCheckout) {
      throw safeError("source-migration-restart-required");
    }
  }
  process.exit(0);
}
const sources = currentSourceManifest(descriptor);
await processOperation(descriptor, {
  version: 1,
  id: operationId,
  kind: "restart",
  generation: descriptor.generation,
  sources,
  targets: ["rac"]
});
