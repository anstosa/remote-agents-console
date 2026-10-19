import { isProtectedValue, type SettingsPatch, type SettingsSchema } from './contracts.js';
import { protectedSettingIdentity } from '../../../server/src/settings/catalog.js';

// reject ambiguous union defaults when any branch can contain protected values
const hasProtectedSchema = (schema: SettingsSchema): boolean => schema.protected === true
  || Object.entries(schema.properties ?? {}).some(([key, child]) => protectedSettingIdentity(key) || hasProtectedSchema(child))
  || schema.items !== undefined && hasProtectedSchema(schema.items)
  || (schema.variants ?? []).some(hasProtectedSchema);

// exclude protected defaults from newly authored container baselines
const publicDefault = (value: unknown, schema?: SettingsSchema): unknown => {
  // never copy masked markers or protected schema defaults
  if (schema?.protected || isProtectedValue(value) || schema?.variants?.some(hasProtectedSchema)) return undefined;
  // retain array indexes only when every default member is public
  if (Array.isArray(value)) {
    const entries = value.map(entry => publicDefault(entry, schema?.items));
    return entries.some(entry => entry === undefined) ? undefined : entries;
  }
  // omit protected object members without inventing replacement credentials
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([key, entry]) => {
      // consult every union shape before copying an embedded default
      const variants = schema?.variants?.map(variant => variant.properties?.[key]).filter((child): child is SettingsSchema => child !== undefined);
      const child = schema?.properties?.[key] ?? schema?.items ?? (variants?.length ? { type: 'union' as const, variants } : undefined);
      const next = protectedSettingIdentity(key) ? undefined : publicDefault(entry, child);
      return next === undefined ? [] : [[key, next]];
    });
    return Object.fromEntries(entries);
  }
  return value;
};

// materialize a missing structured default only for an authored descendant edit
export const settingsDefaultPatches = (schema: SettingsSchema, value: unknown, path: readonly string[], patch: SettingsPatch): SettingsPatch[] => {
  // existing file values and nondefaulted controls keep their original patches
  if (value !== undefined || !Object.hasOwn(schema, 'default')) return [patch];
  const baseline = schema.default;
  // empty objects support ordinary leaf writes without extra file values
  if (baseline === null || typeof baseline !== 'object' || !Array.isArray(baseline) && Object.keys(baseline).length === 0) return [patch];
  // explicit replacements and removals must not resurrect the default
  if (!path.every((part, index) => patch.path[index] === part) || patch.path.length === path.length && patch.op !== 'insert' && patch.op !== 'move') return [patch];
  const seed = publicDefault(baseline, schema);
  // unsafe structured defaults are never submitted as config values
  if (seed === undefined) return [patch];
  return [{ op: 'set', path: [...path], value: seed }, patch];
};
