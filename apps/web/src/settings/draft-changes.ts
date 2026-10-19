import { isProtectedValue, type SettingsPatch, type SettingsSource } from './contracts.js';
import { safePath } from '../../../server/src/settings/patches.js';

export type SettingsDraft = {
  patches: SettingsPatch[];
  content?: string;
  remove?: boolean;
  migration?: 'copy' | 'adopt' | 'empty';
  disclosureContent?: boolean;
  disclosurePaths?: string[];
};

export type SettingsKnownValue = { path: string[]; value: unknown };
export type SettingsPatchApplier = (value: unknown, patch: SettingsPatch) => unknown;

// replace repeated leaf edits only within the current structural phase
export const appendSettingsPatch = (patches: readonly SettingsPatch[], next: SettingsPatch): SettingsPatch[] => {
  // retain collection and removal operations in their authored order
  if (next.op !== 'set') return [...patches, next];
  let boundary = patches.length - 1;
  // stop before any operation that may have reassigned a row identity
  while (boundary >= 0 && patches[boundary]!.op === 'set') boundary -= 1;
  const retained = patches.filter((patch, index) => index <= boundary || patch.op !== 'set' || patch.path.length !== next.path.length || !patch.path.every((part, position) => part === next.path[position]));
  return [...retained, next];
};

// compare json-backed settings with the same ordering semantics as the editor
const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

// read only own properties from one structured source
const valueAt = (value: unknown, path: string[]): unknown => {
  let current = value;
  // stop before inherited or scalar traversal
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

// recognize collection operations whose sequential result remains knowable
const validCollectionPatch = (value: unknown, patch: SettingsPatch): boolean => {
  const collection = valueAt(value, patch.path);
  if (!Array.isArray(collection)) return false;
  // inserts accept the omitted append index or one bounded integer
  if (patch.op === 'insert') {
    const index = patch.index ?? collection.length;
    return Number.isInteger(index) && index >= 0 && index <= collection.length && patch.value !== undefined;
  }
  // moves require two existing member indexes
  return patch.op !== 'move' || Number.isInteger(patch.from) && Number.isInteger(patch.to) && patch.from! >= 0 && patch.to! >= 0 && patch.from! < collection.length && patch.to! < collection.length;
};

// identify display-only protected markers anywhere in a submitted value
const containsProtectedValue = (value: unknown): boolean => isProtectedValue(value)
  || value !== null && typeof value === 'object' && Object.values(value).some(containsProtectedValue);

// overlay only disclosed leaves that replace an authoritative protected marker
const knownStructuredBaseline = (source: SettingsSource, applyPatch: SettingsPatchApplier, knownValues: readonly SettingsKnownValue[]): unknown => {
  let value = structuredClone(source.value);
  // keep disclosure bytes computational and out of returned patches
  for (const known of knownValues) {
    if (known.path.length === 0 || !safePath(known.path) || !isProtectedValue(valueAt(value, known.path))) continue;
    value = applyPatch(value, { op: 'set', path: [...known.path], value: structuredClone(known.value) });
  }
  return value;
};

// normalize values exactly as the settings request serializer does
export const normalizedSettingsPatches = (sourceId: string, patches: readonly SettingsPatch[]): SettingsPatch[] => patches.map(patch => {
  const path = patch.path.join('.');
  // trim only the two voice text fields normalized by the save transaction
  if (sourceId === 'app' && patch.op === 'set' && (path === 'integrations.realtime.name' || path === 'integrations.realtime.context') && typeof patch.value === 'string') return { ...patch, path: [...patch.path], value: patch.value.trim() };
  return { ...patch, path: [...patch.path] };
});

// match the blank wrapper editor while retaining exact saved source bytes
const publicSourceContent = (source: SettingsSource): string | undefined => source.content
  ?? (!source.exists && source.format === 'wrapper' ? '' : undefined)
  ?? (source.exists && !source.protected && source.format === 'svg' && typeof source.value === 'string' ? source.value : undefined);

// project environment fields into their request comparison model
const environmentBaseline = (source: SettingsSource, knownValues: readonly SettingsKnownValue[]): Record<string, unknown> => {
  const original: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // include only variables present in the authoritative file
  for (const field of source.fields ?? []) {
    if (!field.present) continue;
    original[field.key] = field.protected ? { __racProtected: true, present: true, ...(field.hasValue === false ? { hasValue: false } : {}) } : field.value ?? '';
  }
  // replace only disclosed protected environment values
  for (const known of knownValues) {
    if (known.path.length !== 1 || !safePath(known.path)) continue;
    const field = source.fields?.find(candidate => candidate.key === known.path[0]);
    if (field?.protected !== true || !field.present) continue;
    original[field.key] = String(known.value ?? '');
  }
  return original;
};

// serialize safe blank structured fields as assignment removals
const normalizedEnvironmentPatches = (patches: readonly SettingsPatch[]): SettingsPatch[] => patches.map(patch => {
  // preserve malformed selectors for authoritative server validation
  if (patch.op !== 'set' || patch.value !== '' || patch.path.length !== 1 || !safePath(patch.path)) return patch;
  const { value: _value, ...retained } = patch;
  return { ...retained, op: 'remove' };
});

// compare environment presence and string values without inventing hidden secrets
const environmentChanged = (source: SettingsSource, patches: readonly SettingsPatch[], knownValues: readonly SettingsKnownValue[]): boolean => {
  const original = environmentBaseline(source, knownValues);
  const candidate = structuredClone(original) as Record<string, unknown>;
  // replay the environment operations using their serialized string semantics
  for (const patch of normalizedEnvironmentPatches(patches)) {
    if (patch.path.length !== 1 || patch.op === 'insert' || patch.op === 'move') return true;
    const key = patch.path[0]!;
    if (patch.op === 'set') candidate[key] = String(patch.value ?? '');
    else delete candidate[key];
  }
  return !sameValue(original, candidate);
};

// prune only environment operations proven redundant against sequential state
const effectiveEnvironmentPatches = (source: SettingsSource, patches: readonly SettingsPatch[], knownValues: readonly SettingsKnownValue[]): SettingsPatch[] => {
  const candidate = environmentBaseline(source, knownValues);
  const effective: SettingsPatch[] = [];
  let uncertain = false;
  // retain order and stop pruning after an invalid operation
  for (const patch of patches) {
    if (uncertain) { effective.push(patch); continue; }
    if (!safePath(patch.path) || containsProtectedValue(patch.value) || patch.path.length !== 1 || patch.op === 'insert' || patch.op === 'move') {
      effective.push(patch);
      uncertain = true;
      continue;
    }
    const key = patch.path[0]!;
    if (patch.op === 'set') {
      const next = String(patch.value ?? '');
      if (!Object.hasOwn(candidate, key) || candidate[key] !== next) effective.push(patch);
      candidate[key] = next;
      continue;
    }
    if (Object.hasOwn(candidate, key)) effective.push(patch);
    delete candidate[key];
  }
  return effective;
};

// prune provable typed no-ops without rewriting authored patch payloads
export const effectiveSettingsPatches = (
  baseline: SettingsSource,
  patches: readonly SettingsPatch[],
  applyPatch: SettingsPatchApplier,
  knownValues: readonly SettingsKnownValue[] = []
): SettingsPatch[] => {
  const normalized = normalizedSettingsPatches(baseline.id, patches);
  // environment sources compare their serialized presence and string values
  if (baseline.format === 'env') return effectiveEnvironmentPatches(baseline, normalizedEnvironmentPatches(normalized), knownValues);
  let candidate: unknown;
  try { candidate = knownStructuredBaseline(baseline, applyPatch, knownValues); }
  catch { return normalized; }
  const effective: SettingsPatch[] = [];
  let uncertain = false;
  // preserve collection order while pruning only successful set and remove no-ops
  for (const patch of normalized) {
    if (uncertain) { effective.push(patch); continue; }
    // never evaluate selectors rejected by the authoritative patch boundary
    if (!safePath(patch.path)) {
      effective.push(patch);
      uncertain = true;
      continue;
    }
    if ((patch.op === 'set' || patch.op === 'insert') && containsProtectedValue(patch.value)) {
      effective.push(patch);
      uncertain = true;
      continue;
    }
    // invalid collection operations stay available to server validation
    if ((patch.op === 'insert' || patch.op === 'move') && !validCollectionPatch(candidate, patch) || patch.op === 'remove' && patch.path.length === 0 || patch.op === 'set' && patch.value === undefined) {
      effective.push(patch);
      uncertain = true;
      continue;
    }
    const before = structuredClone(candidate);
    try { candidate = applyPatch(candidate, patch); }
    catch { effective.push(patch); uncertain = true; continue; }
    // inserts and moves retain their authored ordering even when temporarily neutral
    if (patch.op === 'insert' || patch.op === 'move' || !sameValue(before, candidate)) effective.push(patch);
  }
  return effective;
};

// compare the final request candidate with one authoritative source snapshot
export const hasSettingsDraftChanges = (
  baseline: SettingsSource,
  draft: SettingsDraft | undefined,
  applyPatch: SettingsPatchApplier,
  knownValues: readonly SettingsKnownValue[] = []
): boolean => {
  // metadata-only handover and disclosure state never modify a source
  if (draft === undefined) return false;
  // removing a missing source or carrying remove false is a no-op
  if (draft.remove === true && baseline.exists) return true;
  const rawKnown = knownValues.find(known => known.path.length === 0 && typeof known.value === 'string');
  const originalContent = rawKnown?.value as string | undefined ?? publicSourceContent(baseline);
  // raw formatting and byte changes are intentional source edits
  if (draft.content !== undefined && draft.content !== originalContent) return true;
  const patches = normalizedSettingsPatches(baseline.id, draft.patches);
  if (patches.length === 0) return false;
  // invalid selectors remain dirty without reaching local object traversal
  if (patches.some(patch => !safePath(patch.path))) return true;
  // masked marker objects must never be treated as valid authored replacements
  if (patches.some(patch => patch.op === 'set' || patch.op === 'insert' ? containsProtectedValue(patch.value) : false)) return true;
  // environment fields use presence plus their serialized string values
  if (baseline.format === 'env') return environmentChanged(baseline, patches, knownValues);
  try {
    const original = knownStructuredBaseline(baseline, applyPatch, knownValues);
    let candidate = structuredClone(original);
    // replay every typed edit so reversions collapse to a clean candidate
    for (const patch of patches) candidate = applyPatch(candidate, patch);
    return !sameValue(original, candidate);
  } catch {
    // malformed staged operations remain visible for validation
    return true;
  }
};
