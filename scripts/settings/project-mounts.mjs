import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { safeError } from "./fs.mjs";

const START = "      # rac-project-mounts:start";
const END = "      # rac-project-mounts:end";
// keep same-process policy provenance outside authored Compose JSON
export const PROJECT_MOUNT_OPERATOR_VOLUMES = Symbol("project-mount-operator-volumes");

// read only the application fields that own Docker Project mounts
function mappings(content, tolerant = false, requireIdentity = true) {
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
  // default only an omitted collection
  const projects = value.projects === undefined ? [] : value.projects;
  // require the Project collection shape
  if (!Array.isArray(projects)) {
    // tolerate only damaged current truth during repair
    if (tolerant) return [];
    throw safeError("invalid-project-mounts");
  }
  const parsed = projects.map((project) => {
    // reject incomplete candidate rows
    if (!project || typeof project !== "object" || Array.isArray(project) || typeof project.path !== "string" || (project.hostPath !== undefined && typeof project.hostPath !== "string") || (requireIdentity && project.id !== undefined && typeof project.id !== "string")) return undefined;
    return { id: typeof project.id === "string" ? project.id : undefined, source: project.hostPath ?? project.path, target: project.path };
  });
  // reject any malformed candidate row
  if (parsed.some((mapping) => mapping === undefined)) {
    // retain independently trustworthy current rows during repair
    if (!tolerant) throw safeError("invalid-project-mounts");
  }
  return parsed.filter((mapping) => mapping !== undefined);
}

// current policy donors rely on bind tuples rather than repairable identity metadata
function currentMountState(content) {
  try { return { mappings: mappings(content, false, false), known: true }; } catch {
    return { mappings: mappings(content, true, false), known: false };
  }
}

// match the server's collision-free mount identity
const mappingKey = (mapping) => JSON.stringify([mapping.source, mapping.target]);
// duplicate Projects still describe one effective mount
const mappingSet = (selected) => [...new Set(selected.map(mappingKey))].sort();

// compare mount knowledge rather than unrelated application fields
export function projectMountsChanged(currentApplication, candidateApplication, hasOverride = true) {
  // current ID metadata cannot turn an unchanged bind tuple into a mount edit
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

// reject inherited and complex keys the byte-preserving editor cannot materialize
function unsupportedMappingKey(line, indent) {
  const key = line.slice(indent);
  return line.startsWith(" ".repeat(indent)) && /^(?:(?:<<|"<<"|'<<')\s*:|[?&!*]|"[^"\n]*\\)/u.test(key);
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
    // inherited service entries must not be shadowed by a new explicit service
    if (unsupportedMappingKey(lines[index], 2)) throw safeError("project-mount-yaml-unsupported");
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
    // inherited volumes must not be shadowed by a new explicit list
    if (unsupportedMappingKey(line, 4)) throw safeError("project-mount-yaml-unsupported");
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

// share exact owned-block stripping with the private Compose planner
export function projectMountOperatorSource(source) {
  return withoutManagedBlock(source).lines.join("\n");
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

// match only transitions whose previous identity is unambiguous
function changes(current, candidate) {
  const byId = new Map();
  // group current identities without blocking deletion or exact retention
  for (const mapping of current.filter((mapping) => mapping.id)) {
    const previous = byId.get(mapping.id) ?? new Map();
    previous.set(mappingKey(mapping), mapping);
    byId.set(mapping.id, previous);
  }
  // exact retained tuples do not need to choose between conflicting history
  const stable = candidate.flatMap((mapping) => {
    const previous = mapping.id ? byId.get(mapping.id) : undefined;
    // new identities and exact retention need no transition template
    if (previous === undefined || previous.has(mappingKey(mapping))) return [];
    // moved rows must have exactly one distinct previous policy donor
    if (previous.size !== 1) throw safeError("project-mount-transition-ambiguous");
    return [{ previous: previous.values().next().value, next: mapping }];
  });
  // exact tuples and known stable transitions already have their policy donors
  const currentKeys = new Set(current.map(mappingKey));
  const candidateKeys = new Set(candidate.map(mappingKey));
  const matchedPrevious = new Set(stable.map((entry) => mappingKey(entry.previous)));
  const matchedNext = new Set(stable.map((entry) => mappingKey(entry.next)));
  const removed = [...new Map(current.filter((mapping) => !candidateKeys.has(mappingKey(mapping)) && !matchedPrevious.has(mappingKey(mapping))).map((mapping) => [mappingKey(mapping), mapping])).values()];
  const added = [...new Map(candidate.filter((mapping) => !currentKeys.has(mappingKey(mapping)) && !matchedNext.has(mappingKey(mapping))).map((mapping) => [mappingKey(mapping), mapping])).values()];
  // identity repairs cannot discard policy or guess among multiple remaining donors
  if (removed.length > 0 && added.length > 0 && (removed.length !== 1 || added.length !== 1)) throw safeError("project-mount-transition-ambiguous");
  return removed.length === 1 && added.length === 1 ? [...stable, { previous: removed[0], next: added[0] }] : stable;
}

// compare and serialize supported options through one canonical policy
function mountOptions(template) {
  const block = [];
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
    for (const [key, value] of Object.entries(bind).sort(([left], [right]) => left.localeCompare(right))) {
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

// serialize one destination without weakening safe path creation behavior
function mountBlock(mapping, template, destination) {
  const target = targetKey(composePath(destination?.target)) === targetKey(mapping.target)
    ? composePath(destination.target)
    : targetKey(mapping.target);
  return [
    "      - type: bind",
    `        source: ${yamlPath(mapping.source)}`,
    `        target: ${yamlPath(target)}`,
    `        read_only: ${template?.read_only === true ? "true" : "false"}`,
    ...mountOptions(template)
  ];
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
    const existing = desiredByTarget.get(target) ?? [];
    // fail before Compose silently selects one source
    if (existing.length > 0 && resolve(projectDirectory, existing[0].source) !== resolve(projectDirectory, mapping.source)) throw safeError("project-mount-target-conflict");
    existing.push(mapping);
    desiredByTarget.set(target, existing);
  }
  // prefer a changed member while retaining ownership knowledge for the whole group
  const desired = [...desiredByTarget.values()].map((group) => group.find((mapping) => !currentKeys.has(mappingKey(mapping))) ?? group[0]);
  const { lines, targets: oldManagedTargets } = withoutManagedBlock(source);
  const trustworthyTargets = new Set(current.map((mapping) => targetKey(mapping.target)));
  // unknown owned transitions cannot safely donate or discard prior access policy
  if (!state.known && candidate.length > 0 && [...oldManagedTargets].some((target) => !trustworthyTargets.has(target))) throw safeError("project-mount-transition-ambiguous");
  const resolved = resolvedModel?.services?.["remote-agent-console"]?.volumes;
  // require one normalized Compose service model
  if (!Array.isArray(resolved)) throw safeError("invalid-project-mount-model");
  const hasOperatorProjection = Object.hasOwn(resolvedModel, PROJECT_MOUNT_OPERATOR_VOLUMES);
  // a filtered full model cannot recover operator entries hidden by owned binds
  if (hasOperatorProjection && !Array.isArray(resolvedModel[PROJECT_MOUNT_OPERATOR_VOLUMES]) || oldManagedTargets.size > 0 && !hasOperatorProjection) throw safeError("invalid-project-mount-model");
  const effective = hasOperatorProjection ? resolvedModel[PROJECT_MOUNT_OPERATOR_VOLUMES] : resolved;
  const changed = changes(current, candidate);
  const protectedTarget = (target) => target === "/workspace" || target === "/run/rac-settings-control" || target.startsWith("/run/rac-settings-control/");
  const managed = desired.filter((mapping) => desiredByTarget.get(targetKey(mapping.target)).some((member) => !currentKeys.has(mappingKey(member))) || oldManagedTargets.has(targetKey(mapping.target)));
  // derive complete group policy before considering the matching-source fast path
  const planned = managed.map((mapping) => {
    const transitions = changed.filter((entry) => targetKey(entry.next.target) === targetKey(mapping.target));
    const groupKeys = new Set(desiredByTarget.get(targetKey(mapping.target)).map(mappingKey));
    const previous = [...transitions.map((entry) => entry.previous), ...current.filter((member) => groupKeys.has(mappingKey(member)))];
    // preserve the supported policy of every incoming and retained group member
    const templates = previous.map((member) => {
      const inherited = effectiveVolume(member, resolved);
      return inherited?.type === "bind" ? inherited : resolved.find((volume) => volume?.type === "bind" && targetKey(composePath(volume.target)) === targetKey(member.target));
    });
    // conflicting non-read-only policies cannot be chosen by Project row order
    if (new Set(templates.map((template) => JSON.stringify(mountOptions(template)))).size > 1) throw safeError("project-mount-transition-ambiguous");
    const template = templates.find((selected) => selected !== undefined) ?? resolved.find((volume) => volume?.type === "bind" && targetKey(composePath(volume.target)) === targetKey(mapping.target));
    const destination = effectiveVolume(mapping, resolved);
    const operatorDestination = effectiveVolume(mapping, effective);
    // coalesced Projects retain every known prior read-only boundary
    const previousReadOnly = previous.some((member) => effectiveVolume(member, resolved)?.read_only === true || effectiveVolume(member, effective)?.read_only === true);
    const readOnly = template?.read_only === true || destination?.read_only === true || operatorDestination?.read_only === true || previousReadOnly;
    const requiredOptions = mountOptions(template);
    const operatorOptions = mountOptions(operatorDestination);
    const reusable = covers(mapping, operatorDestination, projectDirectory) && (!readOnly || operatorDestination.read_only === true) && requiredOptions.every((option) => operatorOptions.includes(option));
    return { mapping, destination, template: { ...template, read_only: readOnly }, reusable };
  });
  const generated = planned.filter((entry) => !entry.reusable);
  // never replace fixed invariant mounts
  if (generated.some((entry) => protectedTarget(targetKey(entry.mapping.target)))) throw safeError("project-mount-host-path-required");
  const block = [START];
  // emit every uncovered or policy-restricting Project after operator-authored entries
  for (const { mapping, destination, template } of generated) {
    block.push(...mountBlock(mapping, template, destination));
  }
  block.push(END);
  const region = volumeRegion(lines);
  // create the narrowest missing YAML container
  if (region.service < 0) lines.splice(region.services + 1, 0, "  remote-agent-console:", "    volumes:", ...block);
  else if (region.volumes < 0) lines.splice(region.service + 1, 0, "    volumes:", ...block);
  else lines.splice(region.end, 0, ...block);
  return lines.join("\n");
}
