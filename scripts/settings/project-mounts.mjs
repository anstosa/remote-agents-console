import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { safeError } from "./fs.mjs";

const START = "      # rac-project-mounts:start";
const END = "      # rac-project-mounts:end";

// read only the application fields that own Docker Project mounts
function mappings(content, tolerant = false) {
  let value;
  try { value = JSON.parse(content); } catch {
    // tolerate only damaged current truth during repair
    if (tolerant) return [];
    throw safeError("invalid-project-mounts");
  }
  // require one application object
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // tolerate only damaged current truth during repair
    if (tolerant) return [];
    throw safeError("invalid-project-mounts");
  }
  const projects = value.projects ?? [];
  // require the Project collection shape
  if (!Array.isArray(projects)) {
    // tolerate only damaged current truth during repair
    if (tolerant) return [];
    throw safeError("invalid-project-mounts");
  }
  const parsed = projects.map((project) => {
    // reject incomplete candidate rows
    if (!project || typeof project !== "object" || Array.isArray(project) || typeof project.path !== "string" || (project.hostPath !== undefined && typeof project.hostPath !== "string") || (project.id !== undefined && typeof project.id !== "string")) return undefined;
    return { id: project.id, source: project.hostPath ?? project.path, target: project.path };
  });
  // reject any malformed candidate row
  if (parsed.some((mapping) => mapping === undefined)) {
    // retain independently trustworthy current rows during repair
    if (!tolerant) throw safeError("invalid-project-mounts");
  }
  return parsed.filter((mapping) => mapping !== undefined);
}

// distinguish damaged current truth from a genuinely empty mount set
function currentMountState(content) {
  try { return { mappings: mappings(content), known: true }; } catch {
    return { mappings: mappings(content, true), known: false };
  }
}

// match the server's collision-free mount identity
const mappingKey = (mapping) => JSON.stringify([mapping.source, mapping.target]);
// duplicate Projects still describe one effective mount
const mappingSet = (selected) => [...new Set(selected.map(mappingKey))].sort();

// compare mount knowledge rather than unrelated application fields
export function projectMountsChanged(currentApplication, candidateApplication, hasOverride = true) {
  const current = currentMountState(currentApplication);
  const candidate = mappings(candidateApplication);
  // unknown truth still requires cleanup when an override is installed
  if (!current.known) return hasOverride || candidate.length > 0;
  return JSON.stringify(mappingSet(current.mappings)) !== JSON.stringify(mappingSet(candidate));
}

// retain one literal dollar through Compose interpolation
const yamlPath = (value) => JSON.stringify(value.replaceAll("$", "$$$$"));
const composePath = (value) => typeof value === "string" ? value.replaceAll("$$", "$") : value;

// compare effective absolute destinations without rewriting authored Project fields
function targetKey(target) {
  // preserve the existing handling of absent model targets
  if (typeof target !== "string") return undefined;
  return isAbsolute(target) ? posix.resolve(target) : target;
}

// locate the fixed service volumes list without interpreting operator YAML
function volumeRegion(lines) {
  const services = lines.findIndex((line) => line === "services:");
  // require a block-style services map
  if (services < 0) throw safeError("project-mount-yaml-unsupported");
  let service = -1;
  // find the exact RAC service boundary
  for (let index = services + 1; index < lines.length; index += 1) {
    // stop at the next top-level section
    if (/^[^\s]/u.test(lines[index]) && lines[index] !== "") break;
    // retain the supported block key
    if (lines[index] === "  remote-agent-console:") { service = index; break; }
    // reject alternate key syntax before inserting duplicates
    if (/^  ["']?remote-agent-console["']?\s*:/u.test(lines[index])) throw safeError("project-mount-yaml-unsupported");
  }
  // allow creating the absent service block
  if (service < 0) return { services, service, volumes: -1, end: lines.length };
  let volumes = -1;
  let end = lines.length;
  // find the exact service volumes boundary
  for (let index = service + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // stop at the next service or top-level section
    if (/^(?:\S|  \S)/u.test(line)) { end = index; break; }
    // retain the supported block key
    if (line === "    volumes:") volumes = index;
    // reject alternate volume syntax before mutation
    else if (/^    ["']?volumes["']?\s*:/u.test(line)) throw safeError("project-mount-yaml-unsupported");
  }
  // allow creating the absent volumes block
  if (volumes < 0) return { services, service, volumes, end };
  // find the next service field boundary
  for (let index = volumes + 1; index < end; index += 1) {
    // stop before a sibling field or top-level section
    if (/^(?:\S|    \S)/u.test(lines[index])) { end = index; break; }
  }
  return { services, service, volumes, end };
}

// remove one complete owned block and reject marker ambiguity
function withoutManagedBlock(source) {
  const lines = source.split("\n");
  const region = volumeRegion(lines);
  const starts = lines.flatMap((line, index) => line === START ? [index] : []);
  const ends = lines.flatMap((line, index) => line === END ? [index] : []);
  // reject partial duplicate or misplaced ownership markers
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length || starts.length === 1 && (region.volumes < 0 || starts[0] <= region.volumes || ends[0] <= starts[0] || ends[0] >= region.end)) throw safeError("project-mount-marker-invalid");
  const targets = new Set();
  // validate and remove the prior owned block
  if (starts.length === 1) {
    let entry;
    // accept only complete entries emitted by this module
    for (const line of lines.slice(starts[0] + 1, ends[0])) {
      // begin one generated bind
      if (line === "      - type: bind") {
        // reject an incomplete prior bind
        if (entry !== undefined && (!entry.source || !entry.target)) throw safeError("project-mount-marker-invalid");
        entry = {};
        continue;
      }
      // require one active bind entry
      if (entry === undefined) throw safeError("project-mount-marker-invalid");
      const path = /^        (source|target): ("(?:[^"\\]|\\.)*")$/u.exec(line);
      // collect one generated path
      if (path !== null) {
        let value;
        try { value = composePath(JSON.parse(path[2])); } catch { /* reject malformed owned path */ throw safeError("project-mount-marker-invalid"); }
        // distinguish host and container identities
        if (path[1] === "source") {
          // reject duplicate source identities
          if (entry.source !== undefined) throw safeError("project-mount-marker-invalid");
          entry.source = value;
        } else {
          // reject duplicate target identities
          if (entry.target !== undefined) throw safeError("project-mount-marker-invalid");
          entry.target = value;
          targets.add(targetKey(value));
        }
        continue;
      }
      // accept only serializer-owned option forms
      if (line === "        read_only: true" || line === "        read_only: false" || line === "        bind:" || /^        consistency: "(?:[^"\\]|\\.)*"$/u.test(line) || /^          [a-z_]+: (?:true|false|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*")$/u.test(line)) continue;
      throw safeError("project-mount-marker-invalid");
    }
    // reject an incomplete final bind
    if (entry !== undefined && (!entry.source || !entry.target)) throw safeError("project-mount-marker-invalid");
    lines.splice(starts[0], ends[0] - starts[0] + 1);
  }
  return { lines, targets };
}

// select the most-specific mount that owns one container path
function effectiveVolume(mapping, volumes) {
  return volumes.filter((volume) => {
    // ignore records without one container target
    if (typeof volume?.target !== "string") return false;
    const child = relative(targetKey(composePath(volume.target)), targetKey(mapping.target));
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  }).sort((left, right) => targetKey(composePath(right.target)).length - targetKey(composePath(left.target)).length)[0];
}

// report whether the effective bind exposes the requested host path
function covers(mapping, volume, projectDirectory) {
  // reject non-bind effective mounts
  if (volume?.type !== "bind" || typeof volume.source !== "string" || typeof volume.target !== "string") return false;
  const target = targetKey(composePath(volume.target));
  const source = composePath(volume.source);
  const child = relative(target, targetKey(mapping.target));
  // reject unrelated volume trees
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
  return resolve(projectDirectory, source, child) === resolve(projectDirectory, mapping.source);
}

// match changed rows by stable id or one unambiguous idless transition
function changes(current, candidate) {
  const byId = new Map();
  // reject conflicting identities before selecting one transition template
  for (const mapping of current.filter((mapping) => mapping.id)) {
    const previous = byId.get(mapping.id);
    // row order must not choose between different previous mount policies
    if (previous !== undefined && mappingKey(previous) !== mappingKey(mapping)) throw safeError("project-mount-transition-ambiguous");
    byId.set(mapping.id, mapping);
  }
  const stable = candidate.flatMap((mapping) => {
    const previous = mapping.id ? byId.get(mapping.id) : undefined;
    return previous !== undefined && mappingKey(previous) !== mappingKey(mapping) ? [{ previous, next: mapping }] : [];
  });
  const currentIdless = current.filter((mapping) => !mapping.id);
  const candidateIdless = candidate.filter((mapping) => !mapping.id);
  const currentKeys = new Set(currentIdless.map(mappingKey));
  const candidateKeys = new Set(candidateIdless.map(mappingKey));
  const removed = currentIdless.filter((mapping) => !candidateKeys.has(mappingKey(mapping)));
  const added = candidateIdless.filter((mapping) => !currentKeys.has(mappingKey(mapping)));
  // refuse to guess among multiple idless transitions
  if (removed.length > 0 && added.length > 0 && (removed.length !== 1 || added.length !== 1)) throw safeError("project-mount-transition-ambiguous");
  return removed.length === 1 && added.length === 1 ? [...stable, { previous: removed[0], next: added[0] }] : stable;
}

// serialize only normalized bind options, forcing safe path creation behavior
function mountBlock(mapping, template, destination) {
  const target = targetKey(composePath(destination?.target)) === targetKey(mapping.target)
    ? composePath(destination.target)
    : targetKey(mapping.target);
  const block = [
    "      - type: bind",
    `        source: ${yamlPath(mapping.source)}`,
    `        target: ${yamlPath(target)}`,
    `        read_only: ${template?.read_only === true ? "true" : "false"}`
  ];
  // retain one supported consistency option
  if (template?.consistency !== undefined) {
    // reject dynamic option shapes
    if (typeof template.consistency !== "string") throw safeError("project-mount-option-unsupported");
    block.push(`        consistency: ${JSON.stringify(template.consistency)}`);
  }
  const bind = template?.bind;
  block.push("        bind:");
  // retain scalar bind options
  if (bind && typeof bind === "object" && !Array.isArray(bind)) {
    // copy every supported scalar option
    for (const [key, value] of Object.entries(bind)) {
      // force safe path creation below
      if (key === "create_host_path") continue;
      // reject arbitrary nested options
      if (!/^[a-z_]+$/u.test(key) || !["string", "boolean", "number"].includes(typeof value)) throw safeError("project-mount-option-unsupported");
      block.push(`          ${key}: ${JSON.stringify(value)}`);
    }
  }
  block.push("          create_host_path: false");
  return block;
}

// synchronize one staged override without touching its live source
export function synchronizeProjectMounts(source, currentApplication, candidateApplication, resolvedModel, projectDirectory) {
  const state = currentMountState(currentApplication);
  const current = state.mappings;
  const candidate = mappings(candidateApplication);
  // leave unrelated application changes untouched
  if (state.known && JSON.stringify(mappingSet(current)) === JSON.stringify(mappingSet(candidate))) return source;
  const currentKeys = new Set(current.map(mappingKey));
  const currentTargets = new Set(current.map((mapping) => mapping.target));
  // validate only newly authored mappings
  for (const mapping of candidate) {
    // unchanged legacy relative paths stay outside automatic ownership
    if (currentKeys.has(mappingKey(mapping))) continue;
    // require safe Compose bind identities
    if (!isAbsolute(mapping.source) || !isAbsolute(mapping.target)) throw safeError("project-mount-path-not-absolute");
    // reject aliases before conflict and invariant comparisons
    if (!currentTargets.has(mapping.target) && mapping.target !== targetKey(mapping.target)) throw safeError("project-mount-path-not-canonical");
  }
  const desiredByTarget = new Map();
  // one container target cannot represent two different host paths
  for (const mapping of candidate.filter((mapping) => isAbsolute(mapping.source) && isAbsolute(mapping.target))) {
    const target = targetKey(mapping.target);
    const existing = desiredByTarget.get(target);
    // fail before Compose silently selects one source
    if (existing !== undefined && resolve(projectDirectory, existing.source) !== resolve(projectDirectory, mapping.source)) throw safeError("project-mount-target-conflict");
    desiredByTarget.set(target, mapping);
  }
  const desired = [...desiredByTarget.values()];
  const { lines, targets: oldManagedTargets } = withoutManagedBlock(source);
  const trustworthyTargets = new Set(current.map((mapping) => targetKey(mapping.target)));
  // unknown owned transitions cannot safely donate or discard prior access policy
  if (!state.known && candidate.length > 0 && [...oldManagedTargets].some((target) => !trustworthyTargets.has(target))) throw safeError("project-mount-transition-ambiguous");
  const resolved = resolvedModel?.services?.["remote-agent-console"]?.volumes;
  // require one normalized Compose service model
  if (!Array.isArray(resolved)) throw safeError("invalid-project-mount-model");
  // a prior managed target masks any earlier same-target declaration, so regenerate it
  const effective = resolved.filter((volume) => !oldManagedTargets.has(targetKey(composePath(volume?.target))));
  const changed = changes(current, candidate);
  const protectedTarget = (target) => target === "/workspace" || target === "/run/rac-settings-control" || target.startsWith("/run/rac-settings-control/");
  const managed = desired.filter((mapping) => !currentKeys.has(mappingKey(mapping)) || oldManagedTargets.has(targetKey(mapping.target)));
  const generated = managed.filter((mapping) => !covers(mapping, effectiveVolume(mapping, effective), projectDirectory));
  // never replace fixed invariant mounts
  if (generated.some((mapping) => protectedTarget(targetKey(mapping.target)))) throw safeError("project-mount-host-path-required");
  const block = [START];
  // emit every uncovered Project after operator-authored entries
  for (const mapping of generated) {
    const transition = changed.find((entry) => mappingKey(entry.next) === mappingKey(mapping));
    const inherited = transition === undefined ? undefined : effectiveVolume(transition.previous, resolved);
    const previousTarget = transition === undefined ? undefined : resolved.find((volume) => volume?.type === "bind" && targetKey(composePath(volume.target)) === targetKey(transition.previous.target));
    const template = inherited?.type === "bind" ? inherited : previousTarget ?? resolved.find((volume) => volume?.type === "bind" && targetKey(composePath(volume.target)) === targetKey(mapping.target));
    const destination = effectiveVolume(mapping, resolved);
    // never weaken either the prior or destination read-only boundary
    block.push(...mountBlock(mapping, { ...template, read_only: template?.read_only === true || destination?.read_only === true }, destination));
  }
  block.push(END);
  const region = volumeRegion(lines);
  // create the narrowest missing YAML container
  if (region.service < 0) lines.splice(region.services + 1, 0, "  remote-agent-console:", "    volumes:", ...block);
  else if (region.volumes < 0) lines.splice(region.service + 1, 0, "    volumes:", ...block);
  else lines.splice(region.end, 0, ...block);
  return lines.join("\n");
}
