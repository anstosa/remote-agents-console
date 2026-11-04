import { MAX_COMMAND_BYTES, MAX_SOURCE_BYTES } from "./constants.mjs";
import { runBounded } from "./command.mjs";
import { readJsonFile, safeError } from "./fs.mjs";
import { composePrefix } from "./validate.mjs";

const PI_PREPARE_TIMEOUT_MS = 10 * 60_000;
const COMPOSE_RENDER_TIMEOUT_MS = 30_000;

// prepare the pinned host runtime only for a bridged Pi deployment
export async function prepareHostPiRuntime(descriptor, options = {}) {
  // skip native installations before reading Compose-only state
  if (descriptor.kind !== "compose") {
    return { prepared: false, reason: "native" };
  }
  const application = readJsonFile(descriptor.sources.app.path, MAX_SOURCE_BYTES);
  const pi = application?.adapters?.pi;
  // skip installations that do not configure Pi
  if (!pi || typeof pi !== "object" || Array.isArray(pi)) {
    return { prepared: false, reason: "pi-disabled" };
  }
  const runner = options.runner ?? runBounded;
  const render = await runner("docker", [...composePrefix(descriptor.compose), "config", "--format", "json"], {
    cwd: descriptor.compose.projectDirectory,
    maxBytes: MAX_COMMAND_BYTES,
    timeoutMs: COMPOSE_RENDER_TIMEOUT_MS
  });
  // keep Compose output private on proof failure
  if (render.code !== 0) {
    throw safeError("pi-host-bridge-proof-failed");
  }
  const bridge = renderedHostBridge(render.stdout);
  // skip container-only Pi deployments
  if (!bridge) {
    return { prepared: false, reason: "container-only" };
  }
  await requirePreparationSuccess(runner("pnpm", ["install", "--frozen-lockfile"], {
    cwd: descriptor.hostCheckout,
    maxBytes: MAX_SOURCE_BYTES,
    timeoutMs: options.timeoutMs ?? PI_PREPARE_TIMEOUT_MS
  }), "pi-host-dependency-install-failed");
  await requirePreparationSuccess(runner("pnpm", ["--filter", "@rac/server", "build"], {
    cwd: descriptor.hostCheckout,
    maxBytes: MAX_SOURCE_BYTES,
    timeoutMs: options.timeoutMs ?? PI_PREPARE_TIMEOUT_MS
  }), "pi-host-server-build-failed");
  return { prepared: true };
}

// prove a nonblank host socket selector from the rendered model
function renderedHostBridge(stdout) {
  let model;
  try {
    model = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw safeError("pi-host-bridge-proof-failed");
  }
  // require the rendered console service before inspecting its environment
  if (!model || typeof model !== "object" || Array.isArray(model) || !model.services || typeof model.services !== "object" || Array.isArray(model.services)) {
    throw safeError("pi-host-bridge-proof-failed");
  }
  const service = model.services["remote-agent-console"];
  // require an object-shaped rendered console service
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw safeError("pi-host-bridge-proof-failed");
  }
  const environment = service.environment;
  // accept only Docker Compose's object environment shape
  if (environment === undefined || environment === null) {
    return false;
  }
  // reject Compose list syntax and scalar environment values
  if (typeof environment !== "object" || Array.isArray(environment)) {
    throw safeError("pi-host-bridge-proof-failed");
  }
  const socketDirectory = environment.RAC_HOST_TMUX_DIR;
  // require a concrete nonblank rendered selector
  if (socketDirectory === undefined || socketDirectory === null || socketDirectory === "") {
    return false;
  }
  // reject nonstring rendered bridge selectors
  if (typeof socketDirectory !== "string") {
    throw safeError("pi-host-bridge-proof-failed");
  }
  return socketDirectory.trim() !== "";
}

// map private command details to one safe stage error
async function requirePreparationSuccess(command, errorCode) {
  const result = await command;
  // reject every nonzero preparation command
  if (result.code !== 0) {
    throw safeError(errorCode);
  }
}
