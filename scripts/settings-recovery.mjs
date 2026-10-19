#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { enqueueRequest } from "./settings/queue.mjs";
import { safeError } from "./settings/fs.mjs";
import { validateDescriptor } from "./settings/contracts.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireRecoveryCompletion } from "./settings/recovery-command.mjs";

// queue one fixed recovery without accepting a path or command
async function main() {
  const installationId = process.argv[2];
  if (process.argv.length !== 3 || !/^[A-Za-z0-9_-]{12,64}$/.test(installationId ?? "")) {
    throw safeError("invalid-installation-id");
  }
  const stateHome = process.env.XDG_STATE_HOME || resolve(homedir(), ".local/state");
  const controlRoot = resolve(stateHome, "remote-agent-console/installations", installationId);
  const descriptorPath = resolve(controlRoot, "installation.json");
  if (!existsSync(descriptorPath)) {
    throw safeError("installation-unavailable");
  }
  const descriptor = validateDescriptor(JSON.parse(readFileSync(descriptorPath, "utf8")), descriptorPath);
  if (descriptor.installationId !== installationId || !Number.isSafeInteger(descriptor.generation)) {
    throw safeError("installation-unavailable");
  }
  const id = randomBytes(24).toString("base64url");
  enqueueRequest(controlRoot, {
    version: 1,
    id,
    kind: "recover",
    generation: descriptor.generation,
    targets: descriptor.sources.cloudflared?.apply === "cloudflared-recreate" ? ["rac", "cloudflared"] : ["rac"]
  });
  const helper = resolve(fileURLToPath(new URL(".", import.meta.url)), "apply-settings.mjs");
  const result = spawnSync(process.execPath, [helper, "--control-root", controlRoot], { stdio: "ignore", timeout: 35 * 60_000 });
  if (result.status !== 0 && result.status !== 75) {
    throw safeError("recovery-start-failed");
  }
  await requireRecoveryCompletion(controlRoot, id);
  process.stdout.write(`${id}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${typeof error?.code === "string" ? error.code : "recovery-failed"}\n`);
  process.exitCode = 1;
}
