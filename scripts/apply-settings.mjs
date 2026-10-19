#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDescriptor } from "./settings/contracts.mjs";
import { installSettingsApplier } from "./settings/install.mjs";
import { inspectOwnedPath, readJsonFile, safeError } from "./settings/fs.mjs";
import { drainQueue } from "./settings/queue.mjs";

const scriptPath = fileURLToPath(import.meta.url);

// parse fixed helper CLI modes
function parseArguments(argv) {
  const values = { mode: "drain" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--install") {
      values.mode = "install";
    } else if (argument === "--drain-locked") {
      values.mode = "drain-locked";
    } else if (["--control-root", "--repository", "--kind", "--environment-file", "--installation-id"].includes(argument)) {
      values[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
      index += 1;
    } else {
      throw safeError("invalid-arguments");
    }
  }
  return values;
}

// load the private descriptor from the invariant root
function loadDescriptor(controlRoot) {
  const path = resolve(controlRoot, "installation.json");
  inspectOwnedPath(path);
  return validateDescriptor(readJsonFile(path, 1024 * 1024), path);
}

// serialize drain and host mutation through fixed flock files
function runLocked(controlRoot) {
  const result = spawnSync("flock", [
    "--wait", "900",
    resolve(controlRoot, "drain.lock"),
    "flock",
    "--wait", "900",
    resolve(controlRoot, "mutation.lock"),
    process.execPath,
    scriptPath,
    "--drain-locked",
    "--control-root",
    controlRoot
  ], { stdio: "ignore", timeout: 35 * 60_000 });
  if (result.error) {
    throw safeError("flock-unavailable");
  }
  if (result.status !== 0) {
    process.exitCode = 75;
  }
}

// execute one fixed helper mode
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "install") {
    if (!options.repository || !options.kind) {
      throw safeError("invalid-arguments");
    }
    const result = await installSettingsApplier(options);
    process.stdout.write(`${JSON.stringify({ installationId: result.installationId, controlRoot: result.controlRoot })}\n`);
    return;
  }
  if (!options.controlRoot || !existsSync(options.controlRoot)) {
    throw safeError("control-root-unavailable");
  }
  if (options.mode === "drain") {
    runLocked(options.controlRoot);
    return;
  }
  await drainQueue(loadDescriptor(options.controlRoot));
}

main().catch((error) => {
  const code = typeof error?.code === "string" ? error.code : "settings-helper-failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
