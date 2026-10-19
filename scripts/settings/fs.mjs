import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// compare paths without prefix ambiguity
export function isPathInside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

// canonicalize an existing path without following a final symlink
export function inspectOwnedPath(path, { uid = process.getuid?.(), regular = true, writable = false } = {}) {
  const link = lstatSync(path);
  // reject indirection at the source identity
  if (link.isSymbolicLink()) {
    throw safeError("unsafe-source");
  }
  // require ordinary source files
  if (regular && !link.isFile()) {
    throw safeError("unsafe-source");
  }
  // preserve one user authority boundary
  if (uid !== undefined && link.uid !== uid) {
    throw safeError("wrong-owner");
  }
  // reject group or public mutation
  if ((link.mode & 0o022) !== 0) {
    throw safeError("unsafe-mode");
  }
  // require owner write access for mutations
  if (writable && (link.mode & 0o200) === 0) {
    throw safeError("not-writable");
  }
  return { path: realpathSync(path), stat: link };
}

// prove a configured source stays beneath an installer-owned root
export function assertAllowedSource(path, allowedRoots, options = {}) {
  if (!isAbsolute(path)) {
    throw safeError("unsafe-source");
  }
  const canonical = existsSync(path)
    ? inspectOwnedPath(path, options).path
    : resolve(inspectOwnedPath(dirname(path), { regular: false }).path, path.slice(dirname(path).length + 1));
  const allowed = allowedRoots.some((root) => {
    const canonicalRoot = realpathSync(root);
    return isPathInside(canonicalRoot, canonical);
  });
  // fail closed outside the installation roots
  if (!allowed) {
    throw safeError("outside-allowed-root");
  }
  return canonical;
}

// write one durable sibling replacement
export function atomicWriteFile(path, data, mode = 0o600, hooks = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = inspectOwnedPath(directory, { regular: false, writable: true });
  // snapshot only destinations that replacement is allowed to overwrite
  const original = hooks.noClobber ? undefined : existsSync(path) ? inspectOwnedPath(path).stat : undefined;
  const parentFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const pinnedParent = `/proc/self/fd/${parentFd}`;
  const temporary = `${pinnedParent}/${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const destination = `${pinnedParent}/${basename(path)}`;
  let descriptor;
  let stagedIdentity;
  try {
    // pin the canonical parent rather than following a swapped path on rename
    if (realpathSync(pinnedParent) !== parent.path || !sameIdentity(fstatSync(parentFd), parent.stat)) throw safeError("source-conflict");
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    // capture ownership only for no-clobber publication
    if (hooks.noClobber) {
      const staged = fstatSync(descriptor);
      stagedIdentity = { device: String(staged.dev), inode: String(staged.ino) };
    }
    closeSync(descriptor);
    descriptor = undefined;
    // publish a new inode without replacing a raced destination
    if (hooks.noClobber) {
      hooks.onPublishing?.(stagedIdentity);
      let published = false;
      try {
        hooks.beforePublish?.();
        const currentParent = lstatSync(directory);
        if (currentParent.isSymbolicLink() || !sameIdentity(currentParent, parent.stat) || !sameIdentity(fstatSync(parentFd), parent.stat) || realpathSync(pinnedParent) !== parent.path) throw safeError("source-conflict");
        linkSync(temporary, destination);
        published = true;
      } catch (error) {
        // discard ownership when publication never occurred
        if (!published) {
          hooks.onPublishAborted?.(stagedIdentity);
        }
        // expose destination races through the stable conflict code
        if (error?.code === "EEXIST") {
          throw safeError("source-conflict");
        }
        throw error;
      }
      unlinkSync(temporary);
      fsyncSync(parentFd);
      return;
    }
    hooks.beforeRename?.();
    const currentParent = lstatSync(directory);
    const current = existsSync(path) ? lstatSync(path) : undefined;
    // reject parent swaps and intervening manual source replacements
    if (currentParent.isSymbolicLink() || !sameIdentity(currentParent, parent.stat) || current?.isSymbolicLink() || Boolean(current) !== Boolean(original) || current && (!sameIdentity(current, original) || current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs)) throw safeError("source-conflict");
    renameSync(temporary, destination);
    fsyncSync(parentFd);
  } finally {
    // remove abandoned sibling stages
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    closeSync(parentFd);
  }
}

// unlink only the unchanged expected source through its pinned parent
export function unlinkIfIdentity(path, expected, hooks = {}) {
  const directory = dirname(path);
  const parent = inspectOwnedPath(directory, { regular: false, writable: true });
  const parentFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const pinnedParent = `/proc/self/fd/${parentFd}`;
  try {
    hooks.beforeUnlink?.();
    const currentParent = lstatSync(directory);
    const current = inspectOwnedPath(path).stat;
    const selected = expected.stat;
    if (!selected || currentParent.isSymbolicLink() || !sameIdentity(currentParent, parent.stat) || !sameIdentity(fstatSync(parentFd), parent.stat) || !sameIdentity(current, selected) || current.size !== selected.size || current.mtimeMs !== selected.mtimeMs || current.ctimeMs !== selected.ctimeMs || realpathSync(pinnedParent) !== parent.path) throw safeError("source-conflict");
    const bytes = readBoundedFile(path, Math.min(1_048_576, selected.size));
    if (createHash("sha256").update(bytes).digest("hex") !== expected.contentHash) throw safeError("source-conflict");
    const rechecked = lstatSync(path);
    if (!sameIdentity(rechecked, selected) || rechecked.size !== selected.size || rechecked.mtimeMs !== selected.mtimeMs || rechecked.ctimeMs !== selected.ctimeMs) throw safeError("source-conflict");
    unlinkSync(`${pinnedParent}/${basename(path)}`);
    fsyncSync(parentFd);
  } finally { closeSync(parentFd); }
}

// sync an atomic rename parent
export function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// read bounded bytes before parsing
export function readBoundedFile(path, maximum, hooks = {}) {
  const selected = inspectOwnedPath(path);
  hooks.beforeOpen?.();
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    // prove the opened identity before reading any source bytes
    if (!sameIdentity(stat, selected.stat) || realpathSync(`/proc/self/fd/${descriptor}`) !== selected.path || !stat.isFile()) throw safeError("source-conflict");
    if (stat.size > maximum) throw safeError("source-too-large");
    const chunks = []; let size = 0;
    // bound growth during reads instead of trusting only the initial stat
    while (size <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum - size + 1));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count)); size += count;
    }
    if (size > maximum) throw safeError("source-too-large");
    const after = fstatSync(descriptor);
    // reject an in-place edit during the bounded read
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw safeError("source-conflict");
    return Buffer.concat(chunks);
  } catch (error) {
    // a substituted final symlink is a conflict, never an alternate source
    if (error?.code === "ELOOP") throw safeError("source-conflict");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// compare opened and selected filesystem identities
function sameIdentity(left, right) { return right !== undefined && left.dev === right.dev && left.ino === right.ino; }

// expose stable public error codes only
export function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// parse JSON without propagating source text
export function readJsonFile(path, maximum) {
  try {
    return JSON.parse(readBoundedFile(path, maximum).toString("utf8"));
  } catch (error) {
    // preserve known safe failures
    if (error?.code && typeof error.code === "string" && error.message === error.code) {
      throw error;
    }
    throw safeError("invalid-json");
  }
}
