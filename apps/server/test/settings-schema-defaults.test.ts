import { describe, expect, it } from 'vitest';
import { settingsDefaultPatches } from '../../web/src/settings/schema-defaults.js';
import type { SettingsPatch, SettingsSchema } from '../../web/src/settings/contracts.js';
import { applyPatch } from '../src/settings/patches.js';

// replay the exact serialized operations against the production patch reducer
const editDefault = (schema: SettingsSchema, patch: SettingsPatch): unknown => settingsDefaultPatches(schema, undefined, ['setting'], patch).reduce(applyPatch, {});

describe('settings schema default mutations', () => {
  const array: SettingsSchema = { type: 'array', optional: true, default: [{ label: 'First' }, { label: 'Second' }], items: { type: 'object', properties: { label: { type: 'string' } } } };
  // preserve default members when editing an omitted list item
  it('seeds an omitted default list before a descendant edit', () => {
    expect(editDefault(array, { op: 'set', path: ['setting', '0', 'label'], value: 'Changed' })).toEqual({ setting: [{ label: 'Changed' }, { label: 'Second' }] });
    expect(array.default).toEqual([{ label: 'First' }, { label: 'Second' }]);
  });
  // keep structural operations valid against raw file bytes
  it.each([
    [{ op: 'move', path: ['setting'], from: 0, to: 1 }, [{ label: 'Second' }, { label: 'First' }]],
    [{ op: 'remove', path: ['setting', '0'] }, [{ label: 'Second' }]],
    [{ op: 'insert', path: ['setting'], index: 1, value: { label: 'New' } }, [{ label: 'First' }, { label: 'New' }, { label: 'Second' }]]
  ] as [SettingsPatch, unknown][])('seeds before %j', (patch, expected) => {
    expect(editDefault(array, patch)).toEqual({ setting: expected });
  });
  // create empty collections only when the user actually adds an item
  it('seeds an omitted empty default array on insert', () => {
    expect(editDefault({ type: 'array', default: [] }, { op: 'insert', path: ['setting'], value: 'New' })).toEqual({ setting: ['New'] });
  });
  // retain required siblings from nonempty object and record defaults
  it.each(['object', 'record'] as const)('preserves %s default siblings', type => {
    expect(editDefault({ type, default: { mode: 'safe', limit: 3 } }, { op: 'set', path: ['setting', 'mode'], value: 'strict' })).toEqual({ setting: { mode: 'strict', limit: 3 } });
  });
  // keep empty object ancestors sparse until their exact child is edited
  it('keeps leaf-only writes under empty default objects', () => {
    const patch: SettingsPatch = { op: 'set', path: ['setting', 'enabled'], value: false };
    expect(settingsDefaultPatches({ type: 'object', default: {} }, undefined, ['setting'], patch)).toEqual([patch]);
  });
  // do not restore defaults over an existing raw value
  it('preserves existing values and deliberate replacements or removals', () => {
    const schema: SettingsSchema = { type: 'object', default: { mode: 'safe', limit: 3 } };
    const patch: SettingsPatch = { op: 'set', path: ['setting', 'mode'], value: 'strict' };
    expect(settingsDefaultPatches(schema, {}, ['setting'], patch)).toEqual([patch]);
    // whole-value actions bypass default seeding
    for (const whole of [{ op: 'set', path: ['setting'], value: {} }, { op: 'remove', path: ['setting'] }] as SettingsPatch[]) {
      expect(settingsDefaultPatches(schema, undefined, ['setting'], whole)).toEqual([whole]);
    }
  });
  // protected values remain absent while exact authored leaf identity survives
  it('never serializes embedded protected defaults or markers', () => {
    const schema: SettingsSchema = { type: 'object', default: { public: 'safe', token: 'hidden', privateValue: 'hidden', masked: { __racProtected: true, present: true } }, properties: { privateValue: { type: 'string', protected: true } } };
    const patch: SettingsPatch = { op: 'set', path: ['setting', 'privateValue'], value: 'authored', revisionId: 'leaf-r1' };
    const patches = settingsDefaultPatches(schema, undefined, ['setting'], patch);
    expect(patches).toEqual([{ op: 'set', path: ['setting'], value: { public: 'safe' } }, patch]);
    expect(patches.at(-1)).toBe(patch);
  });
  // fail closed when copying an array would require masked placeholders
  it('does not seed protected array defaults', () => {
    const patch: SettingsPatch = { op: 'insert', path: ['setting'], value: 'New' };
    expect(settingsDefaultPatches({ type: 'array', default: ['hidden'], items: { type: 'string', protected: true } }, undefined, ['setting'], patch)).toEqual([patch]);
  });
  // never infer public union defaults from an ambiguous protected collection branch
  it.each(['array', 'record'] as const)('does not seed union defaults with protected %s items', type => {
    const patch: SettingsPatch = { op: 'set', path: ['setting', 'public'], value: 'authored' };
    const schema: SettingsSchema = { type: 'union', default: type === 'array' ? ['hidden'] : { entry: 'hidden' }, variants: [{ type, items: { type: 'string', protected: true } }, { type: 'object' }] };
    expect(settingsDefaultPatches(schema, undefined, ['setting'], patch)).toEqual([patch]);
  });
  // metadata remains a display-only value until an operation is supplied
  it('ignores missing scalar defaults and unrelated operations', () => {
    const patch: SettingsPatch = { op: 'set', path: ['other'], value: true };
    expect(settingsDefaultPatches(array, undefined, ['setting'], patch)).toEqual([patch]);
    expect(settingsDefaultPatches({ type: 'boolean', default: false }, undefined, ['setting'], patch)).toEqual([patch]);
    expect(settingsDefaultPatches({ type: 'array' }, undefined, ['setting'], patch)).toEqual([patch]);
  });
});
