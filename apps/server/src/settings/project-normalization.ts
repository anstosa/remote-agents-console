import { SettingsError, type SettingsPatch } from './contracts.js';
import { applyPatch, safePath } from './patches.js';

type ProjectField = {
  type: 'array' | 'object' | 'record' | 'string' | 'union' | 'value';
  optional?: boolean;
  omitWhenEmpty?: boolean;
  omitAfterChildRemoval?: boolean;
  properties?: Record<string, ProjectField>;
  items?: ProjectField;
  variants?: ProjectField[];
};

const optionalString: ProjectField = { type: 'string', optional: true };
const requiredString: ProjectField = { type: 'string' };
// describe one omittable collection
const optionalArray = (items: ProjectField): ProjectField => ({ type: 'array', optional: true, omitWhenEmpty: true, items });

const processObject: ProjectField = {
  type: 'object',
  properties: {
    command: requiredString,
    dependsOn: optionalArray(requiredString)
  }
};
const processValue: ProjectField = { type: 'union', variants: [requiredString, processObject] };
const processes: ProjectField = { type: 'record', optional: true, omitAfterChildRemoval: true, items: processValue };
const commandProperties: Record<string, ProjectField> = {
  start: optionalString,
  stop: optionalString,
  build: optionalString,
  restart: optionalString,
  migrate: optionalString,
  status: optionalString,
  setup: optionalString,
  processes
};
const projectCommands: ProjectField = { type: 'object', optional: true, omitWhenEmpty: true, properties: commandProperties };
const overrideCommands: ProjectField = { type: 'object', optional: true, properties: commandProperties };
const worktreeOverride: ProjectField = {
  type: 'object',
  properties: {
    path: requiredString,
    commands: overrideCommands,
    externalUrl: optionalString,
    port: { type: 'value', optional: true },
    hostname: optionalString
  }
};
const buttonAction: ProjectField = {
  type: 'union',
  variants: [
    { type: 'object', properties: { shellCommand: requiredString } },
    { type: 'object', properties: { agentPrompt: requiredString } }
  ]
};
const configuredButton: ProjectField = {
  type: 'object',
  properties: {
    text: requiredString,
    icon: optionalString,
    color: requiredString,
    style: requiredString,
    action: buttonAction
  }
};
const buttonList = optionalArray(configuredButton);
const splitButtons: ProjectField = {
  type: 'object',
  optional: true,
  omitWhenEmpty: true,
  properties: {
    agent: buttonList,
    terminal: buttonList,
    note: buttonList,
    browser: buttonList,
    files: buttonList,
    code: buttonList,
    review: buttonList,
    stack: buttonList,
    github: buttonList,
    settings: buttonList
  }
};
const projectButtons: ProjectField = {
  type: 'object',
  optional: true,
  omitWhenEmpty: true,
  properties: {
    tabLead: buttonList,
    leftNav: buttonList,
    rightNav: buttonList,
    navMenu: buttonList,
    pullRequest: buttonList,
    reviewRequest: buttonList,
    issue: buttonList,
    splits: splitButtons
  }
};
const project: ProjectField = {
  type: 'object',
  properties: {
    id: requiredString,
    label: optionalString,
    defaultBranch: optionalString,
    path: requiredString,
    hostPath: optionalString,
    worktreeOrder: optionalArray(requiredString),
    worktreeOverrides: optionalArray(worktreeOverride),
    worktreesDirectory: optionalString,
    externalUrl: optionalString,
    port: { type: 'value', optional: true },
    hostname: optionalString,
    commands: projectCommands,
    newTask: optionalString,
    buttons: projectButtons
  }
};
const projectFields: ProjectField = {
  type: 'object',
  properties: {
    projects: optionalArray(project)
  }
};
const omitted = Symbol('omitted-project-field');

// select the concrete union branch for a value
function unionField(field: ProjectField, value: unknown): ProjectField | undefined {
  if (field.type !== 'union') return field;
  // object unions select the variant that owns the authored key
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    return field.variants?.find(variant => variant.type === 'object' && keys.some(key => variant.properties?.[key] !== undefined));
  }
  // scalar process declarations use the string branch
  if (typeof value === 'string') return field.variants?.find(variant => variant.type === 'string');
  return undefined;
}

// resolve one declared project field without validating selectors
function fieldAt(field: ProjectField | undefined, path: readonly string[], value: unknown): ProjectField | undefined {
  let currentField = field;
  let currentValue = value;
  // follow only declared structural children
  for (const part of path) {
    if (currentField?.type === 'union') currentField = unionField(currentField, currentValue) ?? currentField.variants?.find(variant => variant.type === 'object' && variant.properties?.[part] !== undefined);
    // resolve declared object properties
    if (currentField?.type === 'object') currentField = currentField.properties?.[part];
    else if (currentField?.type === 'array' || currentField?.type === 'record') currentField = currentField.items;
    else return undefined;
    currentValue = currentValue !== null && typeof currentValue === 'object' && Object.hasOwn(currentValue, part)
      ? (currentValue as Record<string, unknown>)[part]
      : undefined;
  }
  return currentField;
}

// reject missing, noncanonical, or out-of-bounds array members
function assertArraySelectors(value: unknown, path: readonly string[]): void {
  let currentField: ProjectField | undefined = projectFields;
  let currentValue = value;
  // validate every selector before traversing its child
  for (const part of path) {
    if (currentField?.type === 'union') currentField = unionField(currentField, currentValue) ?? currentField.variants?.find(variant => variant.type === 'object' && variant.properties?.[part] !== undefined);
    // require an actual bounded row whenever the path enters an array
    if (currentField?.type === 'array') {
      if (!Array.isArray(currentValue) || !/^(?:0|[1-9]\d*)$/u.test(part) || Number(part) >= currentValue.length) throw new SettingsError('invalid_settings_patch');
      currentField = currentField.items;
    } else if (currentField?.type === 'object') currentField = currentField.properties?.[part];
    else if (currentField?.type === 'record') currentField = currentField.items;
    else currentField = undefined;
    currentValue = currentValue !== null && typeof currentValue === 'object' && Object.hasOwn(currentValue, part)
      ? (currentValue as Record<string, unknown>)[part]
      : undefined;
  }
}

// omit only declared optional blanks in one authored value
function normalizeValue(field: ProjectField | undefined, value: unknown): unknown | typeof omitted {
  const concrete = field === undefined ? undefined : unionField(field, value);
  // preserve values outside the declared project shape
  if (concrete === undefined) return structuredClone(value);
  // convert optional blank scalar inputs to absence
  if ((concrete.type === 'string' || concrete.type === 'value') && concrete.optional && typeof value === 'string' && value.trim() === '') return omitted;
  // retain required strings and nonblank scalar values
  if (concrete.type === 'string' || concrete.type === 'value') return structuredClone(value);
  // normalize authored array members without filtering invalid required values
  if (concrete.type === 'array' && Array.isArray(value)) {
    const normalized = value.map(item => normalizeValue(concrete.items, item)).filter(item => item !== omitted);
    return concrete.optional && concrete.omitWhenEmpty && normalized.length === 0 ? omitted : normalized;
  }
  // normalize declared object and record children while retaining unknown keys
  if ((concrete.type === 'object' || concrete.type === 'record') && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // preserve key order while omitting only known optional blanks
    for (const [key, child] of Object.entries(value)) {
      const childField = concrete.type === 'object' ? concrete.properties?.[key] : concrete.items;
      const next = normalizeValue(childField, child);
      if (next !== omitted) normalized[key] = next;
    }
    return concrete.optional && concrete.omitWhenEmpty && Object.keys(normalized).length === 0 ? omitted : normalized;
  }
  return structuredClone(value);
}

// test own-property presence without creating missing parents
function hasPath(value: unknown, path: readonly string[]): boolean {
  let current = value;
  // reject missing and scalar ancestors
  for (const part of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

// read one own-property path from a candidate
function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  // stop on absent ancestors
  for (const part of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// remove one known-existing property without creating parents
function removeAt(value: unknown, path: readonly string[]): void {
  if (path.length === 0) return;
  const parent = valueAt(value, path.slice(0, -1));
  // leave malformed ancestry to the authoritative patch boundary
  if (parent === null || typeof parent !== 'object') return;
  const key = path.at(-1)!;
  // keep arrays dense when a declared collection is removed
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete (parent as Record<string, unknown>)[key];
}

// identify a declared optional container that is now empty
function emptyOptionalContainer(field: ProjectField | undefined, value: unknown, afterChildRemoval: boolean): boolean {
  if (field?.optional !== true || field.omitWhenEmpty !== true && !(afterChildRemoval && field.omitAfterChildRemoval === true)) return false;
  // omit empty optional arrays
  if (field.type === 'array') return Array.isArray(value) && value.length === 0;
  // omit empty optional objects only where semantics permit it
  return (field.type === 'object' || field.type === 'record') && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

// prune only authored optional ancestors after a removal
function pruneAuthoredAncestors(value: unknown, patch: SettingsPatch): void {
  // visit deepest ancestors before their containers
  for (let length = patch.path.length; length > 0; length -= 1) {
    const candidatePath = patch.path.slice(0, length);
    const field = fieldAt(projectFields, candidatePath, value);
    const candidate = valueAt(value, candidatePath);
    const afterChildRemoval = patch.op === 'remove' && length < patch.path.length;
    if (emptyOptionalContainer(field, candidate, afterChildRemoval)) removeAt(value, candidatePath);
  }
}

// apply one project-aware patch without mutating its baseline
export function applyAuthoredProjectPatch(root: unknown, patch: SettingsPatch): unknown {
  const candidate = structuredClone(root);
  // preserve the generic rejection contract before any no-op shortcut
  if (!safePath(patch.path) || !['set', 'remove', 'insert', 'move'].includes(patch.op)) return applyPatch(candidate, patch);
  const touchesProjects = patch.path.length === 0 || patch.path[0] === 'projects';
  // preserve generic behavior outside project settings
  if (!touchesProjects || patch.op === 'move') return applyPatch(candidate, patch);
  assertArraySelectors(candidate, patch.path);
  const targetField = fieldAt(projectFields, patch.path, candidate);
  let authored = patch;
  // normalize full replacement values at their declared field
  if (patch.op === 'set') {
    const next = normalizeValue(targetField, patch.value);
    // translate optional blanks into deletion without creating missing parents
    if (next === omitted) {
      if (!hasPath(candidate, patch.path)) return candidate;
      const { value: _value, ...retained } = patch;
      authored = { ...retained, op: 'remove' };
    } else authored = { ...patch, value: next };
  }
  // normalize one inserted collection item
  if (patch.op === 'insert') {
    const itemField = targetField?.type === 'array' ? targetField.items : undefined;
    const next = normalizeValue(itemField, patch.value);
    authored = { ...patch, value: next === omitted ? patch.value : next };
    // seed only one declared optional collection under an existing parent
    if (targetField?.type === 'array' && targetField.optional === true && !hasPath(candidate, patch.path) && hasPath(candidate, patch.path.slice(0, -1))) {
      applyPatch(candidate, { op: 'set', path: [...patch.path], value: [] });
    }
  }
  // make missing removals exact no-ops instead of synthesizing ancestry
  if (authored.op === 'remove' && !hasPath(candidate, authored.path)) return candidate;
  const result = applyPatch(candidate, authored);
  pruneAuthoredAncestors(result, authored);
  return result;
}
