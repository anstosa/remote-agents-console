import { fstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { safeError } from "./fs.mjs";

// prove the inherited descriptor owns the exact shared advisory lock
export function assertInheritedMutationLock(controlRoot, descriptor = 9) {
  try {
    const opened = fstatSync(descriptor);
    const current = statSync(resolve(controlRoot, "mutation.lock"));
    const info = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
    // bind the lock to this open file description and current inode
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino || !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(info)) throw new Error();
  } catch { throw safeError("shared-lock-required"); }
}
