import { spawn } from "node:child_process";
import { MAX_COMMAND_BYTES } from "./constants.mjs";
import { safeError } from "./fs.mjs";

// run one fixed executable with bounded private output
export function runBounded(command, args, options = {}) {
  // reject cancellation before creating a process
  if (options.signal?.aborted) {
    return Promise.reject(safeError("command-aborted"));
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let failureCode;
    let settled = false;
    let killTimer;
    const killTree = (signal) => {
      // target the detached process group on POSIX
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall back to the direct process
        }
      }
      try {
        child.kill(signal);
      } catch {
        // the child already exited
      }
    };
    const terminate = (code) => {
      // retain the first termination reason
      if (failureCode) return;
      failureCode = code;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), options.killGraceMs ?? 250);
      killTimer.unref?.();
    };
    const onAbort = () => terminate("command-aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("command-timeout"), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    // collect output only in bounded memory
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxBytes ?? MAX_COMMAND_BYTES)) {
        terminate("command-output-too-large");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", () => {
      // settle a spawn failure only once
      if (settled) return;
      settled = true;
      cleanup();
      reject(safeError("command-unavailable"));
    });
    child.once("close", (code, signal) => {
      // ignore close after a spawn error settled the promise
      if (settled) return;
      settled = true;
      // kill residual descendants before reporting cancellation
      if (failureCode) {
        killTree("SIGKILL");
      }
      cleanup();
      if (failureCode) {
        reject(safeError(failureCode));
        return;
      }
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
  });
}

// convert private subprocess failure into one safe category
export async function runQuiet(command, args, options = {}) {
  const result = await runBounded(command, args, options);
  if (result.code !== 0) {
    throw safeError(options.errorCode ?? "validation-failed");
  }
  return result.stdout;
}
