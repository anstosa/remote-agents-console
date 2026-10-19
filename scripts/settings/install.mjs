import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { CONTROL_DIRECTORIES, PROTOCOL_VERSION } from "./constants.mjs";
import { runBounded } from "./command.mjs";
import { atomicWriteFile, readJsonFile, safeError } from "./fs.mjs";
import { ensureRecoveryKey } from "./operations.mjs";
import { preflightComposeDependencyGraph } from "./dependencies.mjs";
import { installRecoveryCommand } from "./recovery-command.mjs";
import { composePrefix, validateInstallationSettings } from "./validate.mjs";
import { validateDescriptor } from "./contracts.mjs";
import { preflightMigrationPublisher } from "./migrations.mjs";

const INSTALLATION_FILE = "config/remote-agent-console.installation.json";

// install one fixed user-systemd control plane
export async function installSettingsApplier(options) {
  const repository = realpathSync(options.repository);
  const kind = options.kind;
  if (!["compose", "systemd"].includes(kind)) {
    throw safeError("invalid-install-kind");
  }
  await verifyPrerequisites(kind, options.runner ?? runBounded);
  const desiredPath = resolve(repository, INSTALLATION_FILE);
  const existingDesired = existsSync(desiredPath) ? readJsonFile(desiredPath, 1024 * 1024) : undefined;
  if (existingDesired) {
    validateInstallationSettings(Buffer.from(JSON.stringify(existingDesired), "utf8"));
  }
  const existingInstallationId = options.installationId ?? findExistingInstallationId(repository, kind);
  const installationId = existingInstallationId ?? randomBytes(18).toString("base64url");
  const stateHome = process.env.XDG_STATE_HOME || resolve(homedir(), ".local/state");
  const controlRoot = resolve(stateHome, "remote-agent-console/installations", installationId);
  createControlRoot(controlRoot);
  const descriptorPath = resolve(controlRoot, "installation.json");
  if (existsSync(descriptorPath)) {
    let raw = readJsonFile(descriptorPath, 1024 * 1024);
    // repair only the known first-bootstrap external credential-root omission
    if (kind === "compose" && raw.generation === 1 && raw.installationId === installationId && raw.hostCheckout === repository && raw.hostControlRoot === controlRoot && !existsSync(resolve(controlRoot, "effective.json"))) {
      const env = parseEnv(readFileSync(resolve(repository, ".env"), "utf8"));
      const credentials = resolve(repository, env.CLOUDFLARED_CREDENTIALS_FILE || "config/cloudflared.credentials.json");
      if (raw.sources?.["cloudflared-credentials"]?.path === credentials && !raw.allowedRoots.includes(dirname(credentials))) {
        raw = { ...raw, allowedRoots: [...raw.allowedRoots, dirname(credentials)] };
        validateDescriptor(raw, descriptorPath);
        atomicWriteFile(descriptorPath, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
      }
    }
    let descriptor = validateDescriptor(raw, descriptorPath);
    if (
      descriptor.installationId !== installationId ||
      descriptor.hostControlRoot !== controlRoot ||
      descriptor.hostCheckout !== repository ||
      descriptor.kind !== kind
    ) {
      throw safeError("installation-conflict");
    }
    // block capability activation for unsupported graphs
    if (descriptor.kind === "compose") {
      preflightComposeDependencyGraph(descriptor.compose.files);
    }
    const promoted = promoteLiveIconSources(raw);
    // persist the fixed live icon policy only after graph preflight
    if (promoted !== raw) {
      descriptor = validateDescriptor(promoted, descriptorPath);
      atomicWriteFile(descriptorPath, `${JSON.stringify(promoted, null, 2)}\n`, 0o600);
    }
    installRecoveryCommand({ repository, node: process.execPath, ...(options.recoveryBinDirectory ? { binDirectory: options.recoveryBinDirectory } : {}) });
    renderApplierUnits({ repository, controlRoot, node: process.execPath });
    await activateApplierUnits(options.runner ?? runBounded);
    return { installationId, controlRoot, descriptor };
  }
  const built = kind === "compose"
    ? await buildComposeInstallation(repository, controlRoot, existingDesired, options.runner ?? runBounded)
    : buildNativeInstallation(repository, controlRoot, existingDesired, options.environmentFile);
  if (!existingDesired) {
    atomicWriteFile(desiredPath, `${JSON.stringify(built.desired, null, 2)}\n`, 0o600);
  }
  const descriptor = {
    version: PROTOCOL_VERSION,
    installationId,
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind,
    hostControlRoot: controlRoot,
    hostCheckout: repository,
    serverCheckout: kind === "compose" ? "/workspace" : repository,
    allowedRoots: built.allowedRoots,
    sources: built.sources,
    ...(built.compose ? { compose: built.compose } : {}),
    ...(built.native ? { native: built.native } : {})
  };
  atomicWriteFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 0o600);
  installRecoveryCommand({ repository, node: process.execPath, ...(options.recoveryBinDirectory ? { binDirectory: options.recoveryBinDirectory } : {}) });
  renderApplierUnits({ repository, controlRoot, node: process.execPath });
  await activateApplierUnits(options.runner ?? runBounded);
  return { installationId, controlRoot, descriptor };
}

// locate one explicit existing installation for repair
function findExistingInstallationId(repository, kind) {
  if (process.env.RAC_INSTALLATION_ID) {
    return process.env.RAC_INSTALLATION_ID;
  }
  const candidate = kind === "compose"
    ? controlRootFromOverride(resolve(repository, "compose.override.yaml"))
    : controlRootFromNativeUnit();
  if (!candidate) {
    return undefined;
  }
  const id = basename(candidate);
  return /^[A-Za-z0-9_-]{12,64}$/.test(id) ? id : undefined;
}

// recover only the installer-marked Compose locator
function controlRootFromOverride(path) {
  if (!existsSync(path)) {
    return undefined;
  }
  const source = readFileSync(path, "utf8");
  const block = /# rac-settings-control:start([\s\S]*?)# rac-settings-control:end/.exec(source)?.[1];
  const encoded = /^\s*source:\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(block ?? "")?.[1];
  if (!encoded) {
    return undefined;
  }
  try {
    return JSON.parse(encoded);
  } catch {
    throw safeError("control-mount-marker-invalid");
  }
}

// recover only the rendered native unit locator
function controlRootFromNativeUnit() {
  const unit = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "systemd/user/remote-agent-console.service");
  if (!existsSync(unit)) {
    return undefined;
  }
  return /--settings-control\s+(\S+)/.exec(readFileSync(unit, "utf8"))?.[1];
}

// create private queue and recovery state
function createControlRoot(controlRoot) {
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  chmodSync(controlRoot, 0o700);
  // create every protocol directory privately
  for (const name of CONTROL_DIRECTORIES) {
    const path = resolve(controlRoot, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  ensureRecoveryKey(controlRoot);
}

// verify detached host execution prerequisites
async function verifyPrerequisites(kind, runner) {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw safeError("node-too-old");
  }
  preflightMigrationPublisher();
  const systemd = await runner("systemctl", ["--user", "show-environment"], { maxBytes: 1024 * 1024 });
  if (systemd.code !== 0) {
    throw safeError("user-systemd-unavailable");
  }
  const linger = await runner("loginctl", ["show-user", String(process.getuid()), "-p", "Linger", "--value"], { maxBytes: 1024 });
  if (linger.code !== 0 || linger.stdout.toString("utf8").trim() !== "yes") {
    throw safeError("user-lingering-required");
  }
  const flock = await runner("flock", ["--version"], { maxBytes: 1024 * 1024 });
  if (flock.code !== 0) {
    throw safeError("flock-unavailable");
  }
  if (kind === "compose") {
    const compose = await runner("docker", ["compose", "version"], { maxBytes: 1024 * 1024 });
    if (compose.code !== 0) {
      throw safeError("compose-unavailable");
    }
  }
}

// derive Compose identities without emitting resolved configuration
async function buildComposeInstallation(repository, controlRoot, existingDesired, runner) {
  const envPath = resolve(repository, ".env");
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const configuredFiles = (process.env.COMPOSE_FILE ?? env.COMPOSE_FILE)
    ? (process.env.COMPOSE_FILE ?? env.COMPOSE_FILE).split(":")
    : ["compose.yaml", ...(existsSync(resolve(repository, "compose.override.yaml")) ? ["compose.override.yaml"] : [])];
  let files = configuredFiles.map((path) => realpathSync(resolve(repository, path)));
  if (files.length > 2) {
    throw safeError("unsupported-compose-source-count");
  }
  const configuredEnvFiles = process.env.COMPOSE_ENV_FILES ?? env.COMPOSE_ENV_FILES;
  const envFiles = (configuredEnvFiles ? configuredEnvFiles.split(",") : [".env"])
    .map((path) => realpathSync(resolve(repository, path.trim())));
  let profiles = (process.env.COMPOSE_PROFILES ?? env.COMPOSE_PROFILES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  let projectName = process.env.COMPOSE_PROJECT_NAME ?? env.COMPOSE_PROJECT_NAME ?? basename(repository).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const composeOptions = discoverComposeOptions(env);
  const active = await proveContainerUid(repository, files, envFiles, profiles, composeOptions, runner);
  files = active.files;
  // block mutation before publishing unsupported graphs
  preflightComposeDependencyGraph(files);
  projectName = active.projectName;
  if (active.cloudflaredRunning && !profiles.includes("tunnel")) {
    profiles = [...profiles, "tunnel"];
  }
  const overridePath = files[1] ?? resolve(repository, "compose.override.yaml");
  await installControlMount(repository, overridePath, controlRoot, {
    projectDirectory: repository,
    projectName,
    files,
    envFiles,
    profiles,
    options: composeOptions
  }, runner);
  const finalFiles = files.length === 1 ? [files[0], realpathSync(overridePath)] : files;
  const desired = existingDesired ?? {
    version: 1,
    host: { checkout: repository },
    compose: {
      projectDirectory: repository,
      projectName,
      files: finalFiles,
      envFiles,
      profiles,
      options: composeOptions
    },
    sources: {
      wrapper: resolve(repository, "config/host-tmux"),
      icons: {
        heart: resolve(repository, "config/instance-icons/heart.svg"),
        potato: resolve(repository, "config/instance-icons/potato.svg")
      }
    }
  };
  const appRelative = env.RAC_CONFIG?.startsWith("/workspace/") ? env.RAC_CONFIG.slice("/workspace/".length) : "config/remote-agent-console.docker.json";
  const credentials = resolve(repository, env.CLOUDFLARED_CREDENTIALS_FILE || "config/cloudflared.credentials.json");
  const sources = fixedSources(repository, {
    app: resolve(repository, appRelative),
    env: envPath,
    installation: resolve(repository, INSTALLATION_FILE),
    compose: finalFiles[0],
    "compose-override": finalFiles[1],
    cloudflared: resolve(repository, "config/cloudflared.yml"),
    "cloudflared-credentials": credentials,
    wrapper: resolve(repository, "config/host-tmux"),
    "icon-heart": resolve(repository, "config/instance-icons/heart.svg"),
    "icon-potato": resolve(repository, "config/instance-icons/potato.svg")
  }, true, profiles.includes("tunnel"));
  return {
    desired,
    allowedRoots: [...new Set([repository, dirname(credentials)])],
    sources,
    compose: { projectDirectory: repository, projectName, files: finalFiles, envFiles, profiles, options: composeOptions }
  };
}

// discover the supported fixed global Compose options
export function discoverComposeOptions(env) {
  const options = {};
  const configuredParallel = process.env.COMPOSE_PARALLEL_LIMIT ?? env.COMPOSE_PARALLEL_LIMIT;
  if (configuredParallel) {
    const parallel = Number(configuredParallel);
    if (!Number.isInteger(parallel) || parallel !== -1 && (parallel < 1 || parallel > 64)) {
      throw safeError("invalid-compose-parallel");
    }
    options.parallel = parallel;
  }
  if (/^(?:1|true|yes)$/i.test(process.env.COMPOSE_COMPATIBILITY ?? env.COMPOSE_COMPATIBILITY ?? "")) {
    options.compatibility = true;
  }
  return options;
}

// add the invariant writable control bind to the real ignored override
async function installControlMount(repository, overridePath, controlRoot, compose, runner) {
  const original = existsSync(overridePath) ? readFileSync(overridePath, "utf8") : "services:\n  remote-agent-console:\n    volumes:\n";
  const candidate = addManagedControlMount(original, controlRoot);
  const stage = resolve(controlRoot, "staging", `install-${process.pid}`);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const candidatePath = resolve(stage, "compose.override.yaml");
  atomicWriteFile(candidatePath, candidate, 0o600);
  const validationFiles = compose.files.length === 1 ? [compose.files[0], candidatePath] : compose.files.map((path) => path === overridePath ? candidatePath : path);
  const args = [...composePrefix(compose, validationFiles), "config", "--quiet"];
  const result = await runner("docker", args, { cwd: repository, maxBytes: 1024 * 1024 });
  if (result.code !== 0) {
    throw safeError("control-mount-invalid");
  }
  atomicWriteFile(overridePath, candidate, existsSync(overridePath) ? (readFileMode(overridePath)) : 0o600);
}

// insert or replace one marked YAML list item
export function addManagedControlMount(source, controlRoot) {
  const start = "      # rac-settings-control:start";
  const end = "      # rac-settings-control:end";
  const block = [
    start,
    "      - type: bind",
    `        source: ${JSON.stringify(controlRoot)}`,
    "        target: /run/rac-settings-control",
    "        read_only: false",
    "        bind:",
    "          create_host_path: false",
    end
  ].join("\n");
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex >= 0 || endIndex >= 0) {
    if (startIndex < 0 || endIndex < startIndex) {
      throw safeError("control-mount-marker-invalid");
    }
    return addManagedControlEnvironment(`${source.slice(0, startIndex)}${block}${source.slice(endIndex + end.length)}`, controlRoot);
  }
  const lines = source.split("\n");
  let serviceLine = -1;
  let volumesLine = -1;
  // locate the exact RAC service and its volumes list
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "  remote-agent-console:") {
      serviceLine = index;
      continue;
    }
    if (serviceLine >= 0 && lines[index] === "    volumes:") {
      volumesLine = index;
      break;
    }
    if (serviceLine >= 0 && /^  \S/.test(lines[index])) {
      break;
    }
  }
  if (serviceLine < 0) {
    throw safeError("rac-service-missing");
  }
  if (volumesLine < 0) {
    lines.splice(serviceLine + 1, 0, "    volumes:", ...block.split("\n"));
  } else {
    lines.splice(volumesLine + 1, 0, ...block.split("\n"));
  }
  return addManagedControlEnvironment(lines.join("\n"), controlRoot);
}

// inject the matching host-side path for the fixed updater
function addManagedControlEnvironment(source, controlRoot) {
  const start = "      # rac-settings-control-env:start";
  const end = "      # rac-settings-control-env:end";
  const block = [start, `      RAC_HOST_SETTINGS_CONTROL_ROOT: ${JSON.stringify(controlRoot)}`, end].join("\n");
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex >= 0 || endIndex >= 0) {
    if (startIndex < 0 || endIndex < startIndex) {
      throw safeError("control-environment-marker-invalid");
    }
    return `${source.slice(0, startIndex)}${block}${source.slice(endIndex + end.length)}`;
  }
  const lines = source.split("\n");
  let serviceLine = -1;
  let environmentLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "  remote-agent-console:") {
      serviceLine = index;
      continue;
    }
    if (serviceLine >= 0 && lines[index] === "    environment:") {
      environmentLine = index;
      break;
    }
    if (serviceLine >= 0 && /^  \S/.test(lines[index])) {
      break;
    }
  }
  if (environmentLine < 0) {
    lines.splice(serviceLine + 1, 0, "    environment:", ...block.split("\n"));
  } else {
    lines.splice(environmentLine + 1, 0, ...block.split("\n"));
  }
  return lines.join("\n");
}

// prove the running Compose container shares the installing uid
async function proveContainerUid(repository, files, envFiles, profiles, options, runner) {
  const args = ["compose"];
  if (options.parallel !== undefined) {
    args.push("--parallel", String(options.parallel));
  }
  if (options.compatibility === true) {
    args.push("--compatibility");
  }
  args.push("--project-directory", repository);
  for (const envFile of envFiles) {
    args.push("--env-file", envFile);
  }
  for (const profile of profiles) {
    args.push("--profile", profile);
  }
  for (const file of files) {
    args.push("-f", file);
  }
  const result = await runner("docker", [...args, "ps", "-q", "remote-agent-console"], { cwd: repository, maxBytes: 1024 });
  const container = result.stdout.toString("utf8").trim();
  if (result.code !== 0 || !/^[0-9a-f]{12,64}$/.test(container)) {
    throw safeError("running-container-required");
  }
  const inspect = await runner("docker", ["inspect", "--format", "{{json .Config.Labels}} {{.State.Pid}}", container], { maxBytes: 64 * 1024 });
  const inspected = /^(\{.*\})\s+(\d+)\s*$/s.exec(inspect.stdout.toString("utf8"));
  const pid = Number(inspected?.[2]);
  if (inspect.code !== 0 || !Number.isInteger(pid) || pid < 2) {
    throw safeError("container-uid-unavailable");
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  if (uid !== process.getuid()) {
    throw safeError("container-uid-mismatch");
  }
  let labels;
  try {
    labels = JSON.parse(inspected[1]);
  } catch {
    throw safeError("compose-identity-unavailable");
  }
  const projectName = labels["com.docker.compose.project"];
  const workingDirectory = labels["com.docker.compose.project.working_dir"];
  const activeFiles = labels["com.docker.compose.project.config_files"]?.split(",").map((path) => realpathSync(path));
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName ?? "") ||
    realpathSync(workingDirectory ?? "/") !== repository ||
    !Array.isArray(activeFiles) ||
    activeFiles.length === 0 ||
    activeFiles.length > 2
  ) {
    throw safeError("compose-identity-unavailable");
  }
  const cloud = await runner("docker", [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--filter",
    "label=com.docker.compose.service=cloudflared"
  ], { maxBytes: 1024 });
  return {
    projectName,
    files: activeFiles,
    cloudflaredRunning: cloud.code === 0 && /^[0-9a-f]{12,64}$/m.test(cloud.stdout.toString("utf8"))
  };
}

// derive native identities from the chosen environment file
function buildNativeInstallation(repository, controlRoot, existingDesired, environmentFileValue) {
  const environmentFile = realpathSync(environmentFileValue || process.env.RAC_ENV_FILE || resolve(repository, ".env"));
  const env = parseEnv(readFileSync(environmentFile, "utf8"));
  const appPath = realpathSync(env.RAC_CONFIG || resolve(repository, "config/remote-agent-console.systemd.json"));
  const desired = existingDesired ?? {
    version: 1,
    host: { checkout: repository },
    native: { environmentFile },
    sources: {
      wrapper: resolve(repository, "config/host-tmux"),
      icons: {
        heart: resolve(repository, "config/instance-icons/heart.svg"),
        potato: resolve(repository, "config/instance-icons/potato.svg")
      }
    }
  };
  const paths = {
    app: appPath,
    env: environmentFile,
    installation: resolve(repository, INSTALLATION_FILE),
    wrapper: resolve(repository, "config/host-tmux"),
    "icon-heart": resolve(repository, "config/instance-icons/heart.svg"),
    "icon-potato": resolve(repository, "config/instance-icons/potato.svg")
  };
  if (existingDesired?.native?.cloudflaredConfig) {
    paths.cloudflared = resolve(existingDesired.native.cloudflaredConfig);
  }
  if (existingDesired?.native?.cloudflaredCredentials) {
    paths["cloudflared-credentials"] = resolve(existingDesired.native.cloudflaredCredentials);
  }
  const allowedRoots = [...new Set([
    repository,
    dirname(environmentFile),
    dirname(appPath),
    ...(paths.cloudflared ? [dirname(paths.cloudflared)] : []),
    ...(paths["cloudflared-credentials"] ? [dirname(paths["cloudflared-credentials"])] : [])
  ])];
  return {
    desired,
    allowedRoots,
    sources: fixedSources(repository, paths, false, Boolean(existingDesired?.native?.cloudflaredUnit)),
    native: {
      unit: "remote-agent-console.service",
      environmentFile,
      ...(existingDesired?.native?.cloudflaredUnit ? { cloudflaredUnit: existingDesired.native.cloudflaredUnit } : {})
    }
  };
}

// map present fixed paths to descriptor sources
function fixedSources(repository, paths, compose, cloudflaredActive) {
  const definitions = {
    app: ["json", "rac-restart", false],
    env: ["env", "rac-restart", false],
    installation: ["installation", "rac-restart", false],
    compose: ["compose", "rac-restart", false],
    "compose-override": ["compose", "rac-restart", false],
    cloudflared: ["cloudflared", cloudflaredActive ? "cloudflared-recreate" : "saved-only", true],
    "cloudflared-credentials": ["credentials", cloudflaredActive ? "cloudflared-recreate" : "saved-only", true],
    wrapper: ["wrapper", "rac-restart", true],
    "icon-heart": ["svg", "live", true],
    "icon-potato": ["svg", "live", true]
  };
  const sources = {};
  // include present and explicitly optional installation sources
  for (const [id, path] of Object.entries(paths)) {
    const [kind, apply, optional] = definitions[id];
    if (!existsSync(path) && !optional && id !== "installation") {
      throw safeError("missing-source");
    }
    if (existsSync(path) || optional || id === "installation") {
      const relative = path.startsWith(`${repository}/`) ? path.slice(repository.length + 1) : undefined;
      sources[id] = {
        path,
        ...(compose && relative ? { serverPath: `/workspace/${relative}` } : !compose ? { serverPath: path } : {}),
        kind,
        ...(optional ? { optional: true } : {}),
        apply
      };
    }
  }
  return sources;
}

// upgrade only the two installer-owned icon policies
function promoteLiveIconSources(descriptor) {
  let sources;
  // copy lazily when a legacy icon policy is present
  for (const id of ["icon-heart", "icon-potato"]) {
    const source = descriptor.sources?.[id];
    if (source?.kind !== "svg" || source.apply === "live") {
      continue;
    }
    sources ??= { ...descriptor.sources };
    sources[id] = { ...source, apply: "live" };
  }
  return sources ? { ...descriptor, sources } : descriptor;
}

// read and preserve a file mode
function readFileMode(path) {
  return statSync(path).mode & 0o777;
}

// render and enable fixed helper units
function renderApplierUnits({ repository, controlRoot, node }) {
  const unitDirectory = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "systemd/user");
  mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
  const replacements = {
    "@REPOSITORY@": repository,
    "@CONTROL_ROOT@": controlRoot,
    "@NODE@": node
  };
  for (const name of ["remote-agent-settings-apply.path", "remote-agent-settings-apply.service"]) {
    let template = readFileSync(resolve(repository, "systemd", `${name}.in`), "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      template = template.replaceAll(token, value);
    }
    atomicWriteFile(resolve(unitDirectory, name), template, 0o600);
  }
}

// load and start the durable queue watcher
async function activateApplierUnits(runner) {
  const reload = await runner("systemctl", ["--user", "daemon-reload"], { maxBytes: 1024 * 1024 });
  if (reload.code !== 0) {
    throw safeError("user-systemd-unavailable");
  }
  const enable = await runner("systemctl", ["--user", "enable", "--now", "remote-agent-settings-apply.path"], { maxBytes: 1024 * 1024 });
  if (enable.code !== 0) {
    throw safeError("settings-applier-start-failed");
  }
}
