import { resolve } from "node:path";
import { runBounded } from "./command.mjs";
import { safeError } from "./fs.mjs";

const RESULT_STATUSES = new Set(["signal_sent", "stale", "not_found", "rejected", "failed"]);

// translate one fixed host-helper result without exposing private process data
function parseResult(stdout, targets) {
  let value;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw safeError("agent-stop-failed");
  }
  // require one ordered outcome for every selected identity
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "results"].includes(key)) || value.version !== 1 || !Array.isArray(value.results) || value.results.length !== targets.length) {
    throw safeError("agent-stop-failed");
  }
  return value.results.map((result, index) => {
    const target = targets[index];
    // bind each public result to its exact requested lifetime
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some(key => !["pid", "startTime", "status"].includes(key)) || result.pid !== target.pid || result.startTime !== target.startTime || !RESULT_STATUSES.has(result.status)) {
      throw safeError("agent-stop-failed");
    }
    const messages = {
      stale: "The Agent process changed before it could be stopped.",
      not_found: "The Agent process is no longer running.",
      rejected: "The process no longer satisfies the safe Agent policy.",
      failed: "The host could not signal this Agent process."
    };
    return { ...result, ...(messages[result.status] === undefined ? {} : { message: messages[result.status] }) };
  });
}

// execute only the repository-owned pidfd helper with identity tuples
export async function stopAgents(descriptor, request, options = {}) {
  const helper = resolve(descriptor.hostCheckout, "scripts/settings/terminate_agent.py");
  const payload = Buffer.from(JSON.stringify(request.agentStop), "utf8").toString("base64url");
  const result = await (options.agentStopRunner ?? runBounded)("/usr/bin/python3", [helper, payload], {
    cwd: descriptor.hostCheckout,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    timeoutMs: 3_000,
    maxBytes: 16_384
  });
  // helper failures do not grant a fallback signaling path
  if (result.code !== 0) throw safeError("agent-stop-failed");
  return { phase: "signal-sent", agentStops: parseResult(result.stdout, request.agentStop.targets) };
}
