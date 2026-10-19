import { existsSync } from "node:fs";
import { sha256 } from "./crypto.mjs";
import { inspectOwnedPath, readBoundedFile, safeError } from "./fs.mjs";
import { MAX_SOURCE_BYTES } from "./constants.mjs";

// return private identity metadata without decrypting or disclosing source bytes
export function inspectSource(descriptor, request) {
  const sourceId = request.inspect.sourceId;
  const source = descriptor.sources[sourceId];
  if (!source) throw safeError("invalid-source");
  const existed = existsSync(source.path);
  if (existed) inspectOwnedPath(source.path);
  return { phase: "inspected", sourceMetadata: { sourceId, existed, contentHash: sha256(existed ? readBoundedFile(source.path, MAX_SOURCE_BYTES) : Buffer.alloc(0)) } };
}
