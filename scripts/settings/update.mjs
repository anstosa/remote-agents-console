#!/usr/bin/env node
import { resolve } from "node:path";
import { readJsonFile, safeError } from "./fs.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { currentSourceManifest, loadDesiredDescriptor, processOperation } from "./operations.mjs";
import { assertInheritedMutationLock } from "./lock.mjs";
import { prepareHostPiRuntime } from "./pi-update.mjs";

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
const effectiveDescriptor = loadDesiredDescriptor(descriptor);
// keep reviewed updates inside the active host checkout
if (effectiveDescriptor.hostCheckout !== descriptor.hostCheckout) {
  throw safeError("source-migration-restart-required");
}
if (mode === "--verify-only") {
  process.exit(0);
}
await prepareHostPiRuntime(effectiveDescriptor);
const sources = currentSourceManifest(descriptor);
await processOperation(descriptor, {
  version: 1,
  id: operationId,
  kind: "restart",
  generation: descriptor.generation,
  sources,
  targets: ["rac"]
});
