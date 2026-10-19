import { SettingsError, type SettingsPatch } from './contracts.js';

// permit exact property identities without prototype traversal
export function safePath(path: unknown): path is string[] { return Array.isArray(path) && path.length <= 16 && path.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(part) && !part.includes('\0')); }
// read one own-property path
export function atPath(value: unknown, path: string[]): unknown {
  let current = value;
  // traverse only actual object members
  for (const key of path) {
    // reject inherited or absent selectors
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
// reject display-only markers anywhere in submitted data
export function validPatchValue(value: unknown): boolean {
  // reject masked placeholders
  if (typeof value === 'string') return !value.includes('\0') && !/^[•●*]{3,}$/u.test(value);
  // inspect collection members without accepting marker objects
  if (value !== null && typeof value === 'object') return !Object.hasOwn(value, '__racProtected') && Object.entries(value).every(([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && validPatchValue(child));
  return value !== undefined;
}
// patch fresh source bytes while preserving hidden values
export function applyPatch(root: unknown, patch: SettingsPatch): unknown {
  // require bounded canonical paths and operation names
  if (!safePath(patch.path) || !['set', 'remove', 'insert', 'move'].includes(patch.op)) throw new SettingsError('invalid_settings_patch');
  // support deliberate root replacement only
  if (patch.path.length === 0) {
    // refuse accidental source removal
    if (patch.op !== 'set' || !validPatchValue(patch.value)) throw new SettingsError('invalid_settings_patch');
    return structuredClone(patch.value);
  }
  let parent = root as Record<string, unknown>;
  // create missing object branches for optional settings
  for (const part of patch.path.slice(0, -1)) {
    // reject scalar traversal
    if (parent === null || typeof parent !== 'object') throw new SettingsError('invalid_settings_patch');
    if (!Object.hasOwn(parent, part)) parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  // reject scalar parent selectors
  if (parent === null || typeof parent !== 'object') throw new SettingsError('invalid_settings_patch');
  const key = patch.path.at(-1)!;
  // constrain array index assignments
  if (Array.isArray(parent) && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length)) throw new SettingsError('invalid_settings_patch');
  // set only intentional values
  if (patch.op === 'set') {
    if (!validPatchValue(patch.value)) throw new SettingsError('invalid_settings_value');
    parent[key] = structuredClone(patch.value);
  } else if (patch.op === 'remove') {
    // remove rows without sparse arrays
    if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
  } else {
    const array = parent[key];
    // require a declared collection
    if (!Array.isArray(array)) throw new SettingsError('invalid_settings_patch');
    // insert a newly described row
    if (patch.op === 'insert') {
      const index = patch.index ?? array.length;
      if (!Number.isInteger(index) || index < 0 || index > array.length || !validPatchValue(patch.value)) throw new SettingsError('invalid_settings_patch');
      array.splice(index, 0, structuredClone(patch.value));
    } else {
      // reorder the original row with its protected values intact
      if (!Number.isInteger(patch.from) || !Number.isInteger(patch.to) || patch.from! < 0 || patch.to! < 0 || patch.from! >= array.length || patch.to! >= array.length) throw new SettingsError('invalid_settings_patch');
      const [row] = array.splice(patch.from!, 1); array.splice(patch.to!, 0, row);
    }
  }
  return root;
}
