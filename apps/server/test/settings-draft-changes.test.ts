import { describe, expect, it, vi } from 'vitest';
import { applyPatch as applyServerPatch } from '../src/settings/patches.js';
import { appendSettingsPatch, effectiveSettingsPatches, hasSettingsDraftChanges, normalizedSettingsPatches, type SettingsDraft, type SettingsKnownValue } from '../../web/src/settings/draft-changes.js';
import type { SettingsPatch, SettingsSource } from '../../web/src/settings/contracts.js';

// build one authoritative source with focused test overrides
const source = (overrides: Partial<SettingsSource> = {}): SettingsSource => ({
  id: 'app',
  label: 'Application',
  format: 'json',
  exists: true,
  writable: true,
  protected: false,
  tracked: false,
  revisionId: 'revision-1',
  apply: 'rac-restart',
  hasProtectedContent: false,
  value: {},
  ...overrides
});

// isolate the mutating server patch implementation from each candidate
const applyCandidate = (value: unknown, patch: SettingsPatch): unknown => applyServerPatch(structuredClone(value), structuredClone(patch));

// retain the exact root draft shape used by settings center
const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({ patches: [], ...overrides });

describe('settings patch structural phases', () => {
  it('compacts repeated edits without changing revisions or values', () => {
    const first: SettingsPatch = { op: 'set', path: ['rows', '0', 'name'], value: 'First', revisionId: 'old' };
    const second: SettingsPatch = { ...first, value: 'Latest', revisionId: 'new' };
    expect(appendSettingsPatch([first], second)).toEqual([second]);
  });

  it.each<SettingsPatch>([
    { op: 'move', path: ['rows'], from: 0, to: 1 },
    { op: 'insert', path: ['rows'], index: 0, value: { name: 'New' } },
    { op: 'remove', path: ['rows', '0'] }
  ])('retains edits on both sides of $op', structural => {
    const first: SettingsPatch = { op: 'set', path: ['rows', '0', 'name'], value: 'Edited first' };
    const second: SettingsPatch = { ...first, value: 'Edited current' };
    const last: SettingsPatch = { ...first, value: 'Final current' };
    const patches = appendSettingsPatch(appendSettingsPatch([first, structural], second), last);
    expect(patches).toEqual([first, structural, last]);
    const result = patches.reduce(applyCandidate, { rows: [{ name: 'First' }, { name: 'Second' }] });
    const expected = structural.op === 'move' ? ['Final current', 'Edited first'] : structural.op === 'insert' ? ['Final current', 'Edited first', 'Second'] : ['Final current'];
    expect((result as { rows: Array<{ name: string }> }).rows.map(row => row.name)).toEqual(expected);
  });
});

// exercise both mutation operations across every rejected path shape
const invalidPathPatches: Array<{ name: string; patch: SettingsPatch }> = [
  { name: '__proto__', path: ['__proto__'] },
  { name: 'constructor', path: ['constructor'] },
  { name: 'prototype', path: ['prototype'] },
  { name: 'overlong segment', path: ['x'.repeat(257)] },
  { name: 'overlong depth', path: Array.from({ length: 17 }, (_, index) => `part-${index}`) },
  { name: 'nul segment', path: ['bad\0key'] }
].flatMap(({ name, path }) => [
  { name: `set ${name}`, patch: { op: 'set', path, value: 'unsafe' } as SettingsPatch },
  { name: `remove ${name}`, patch: { op: 'remove', path } as SettingsPatch }
]);

describe('settings draft net changes', () => {
  it('collapses scalar edits, reversions, and absent removals against the snapshot', () => {
    const baseline = source({ value: { mode: 'one', optional: null } });

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['mode'], value: 'two' }] }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['mode'], value: 'two' }, { op: 'set', path: ['mode'], value: 'one' }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'remove', path: ['missing'] }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'remove', path: ['optional'] }, { op: 'set', path: ['optional'], value: null }] }), applyCandidate)).toBe(false);
  });

  it('preserves collection order while collapsing inverse moves and additions', () => {
    const baseline = source({ value: { rows: ['one', 'two'] } });

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'move', path: ['rows'], from: 0, to: 1 }, { op: 'move', path: ['rows'], from: 1, to: 0 }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'insert', path: ['rows'], index: 1, value: 'new' }, { op: 'remove', path: ['rows', '1'] }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'move', path: ['rows'], from: 0, to: 1 }] }), applyCandidate)).toBe(true);
  });

  it('retains json object ordering semantics after a remove and re-add', () => {
    const baseline = source({ value: { first: 1, second: 2 } });
    const changes = draft({ patches: [{ op: 'remove', path: ['first'] }, { op: 'set', path: ['first'], value: 1 }] });

    expect(hasSettingsDraftChanges(baseline, changes, applyCandidate)).toBe(true);
  });

  it('compares raw sources by exact displayed or disclosed bytes', () => {
    const baseline = source({ id: 'compose', format: 'compose', content: 'services:\n  app: {}\n' });
    const protectedSource = source({ id: 'credentials', format: 'credentials', protected: true, hasProtectedContent: true, content: undefined });
    const known: SettingsKnownValue[] = [{ path: [], value: '{"token":"secret"}\n' }];

    expect(hasSettingsDraftChanges(baseline, draft({ content: baseline.content }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ content: 'services:\n  app: { }\n' }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(protectedSource, draft({ content: '{"token":"secret"}\n', disclosureContent: true }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(protectedSource, draft({ content: '{"token":"secret"}\n', disclosureContent: true }), applyCandidate, known)).toBe(false);
  });

  it('uses the svg value fallback when no editor content exists', () => {
    const baseline = source({ id: 'heart', format: 'svg', value: '<svg />', content: undefined });

    expect(hasSettingsDraftChanges(baseline, draft({ content: '<svg />' }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ content: '<svg> </svg>' }), applyCandidate)).toBe(true);
  });

  it('compares environment presence and serialized string values', () => {
    const baseline = source({
      id: 'compose-env',
      format: 'env',
      value: undefined,
      fields: [
        { key: 'PORT', value: '3000', protected: false, present: true, apply: 'rac-restart' },
        { key: 'OPTIONAL', protected: false, present: false, apply: 'rac-restart' }
      ]
    });

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['PORT'], value: 3000 }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'remove', path: ['OPTIONAL'] }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['OPTIONAL'], value: '' }] }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['PORT'], value: '' }] }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'remove', path: ['PORT'] }] }), applyCandidate)).toBe(true);
  });

  it('uses disclosed environment values only for comparison', () => {
    const baseline = source({
      id: 'compose-env',
      format: 'env',
      fields: [{ key: 'API_KEY', protected: true, present: true, apply: 'rac-restart' }]
    });
    const original = draft({ patches: [{ op: 'set', path: ['API_KEY'], value: 'saved-secret' }], disclosurePaths: ['["API_KEY"]'] });

    expect(hasSettingsDraftChanges(baseline, original, applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(baseline, original, applyCandidate, [{ path: ['API_KEY'], value: 'saved-secret' }])).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['API_KEY'], value: 'replacement' }] }), applyCandidate, [{ path: ['API_KEY'], value: 'saved-secret' }])).toBe(true);
  });

  it('treats protected replacements conservatively without copying markers', () => {
    const marker = { __racProtected: true as const, present: true };
    const baseline = source({ value: { token: marker } });
    const sameDisclosedValue = draft({ patches: [{ op: 'set', path: ['token'], value: 'saved-secret' }] });

    expect(hasSettingsDraftChanges(baseline, sameDisclosedValue, applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(baseline, sameDisclosedValue, applyCandidate, [{ path: ['token'], value: 'saved-secret' }])).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'set', path: ['token'], value: marker }] }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: [{ op: 'remove', path: ['token'] }] }), applyCandidate)).toBe(true);
  });

  it('ignores handover metadata and no-op source removals', () => {
    const existing = source();
    const missing = source({ exists: false });

    expect(hasSettingsDraftChanges(existing, draft({ migration: 'copy' }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(existing, draft({ remove: false }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(existing, draft({ remove: true }), applyCandidate)).toBe(true);
    expect(hasSettingsDraftChanges(missing, draft({ remove: true }), applyCandidate)).toBe(false);
  });

  // a blank optional wrapper is clean until authored content exists
  it('treats an absent wrapper as an empty editor baseline', () => {
    const missing = source({ id: 'wrapper', format: 'wrapper', exists: false, value: undefined });
    expect(hasSettingsDraftChanges(missing, undefined, applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(missing, draft({ content: '' }), applyCandidate)).toBe(false);
    expect(hasSettingsDraftChanges(missing, draft({ content: '#!/bin/sh\nexec /usr/bin/tmux "$@"\n' }), applyCandidate)).toBe(true);
  });

  it('normalizes voice text before comparing or serializing it', () => {
    const baseline = source({ value: { integrations: { realtime: { name: 'Davo', context: 'Be concise.' } } } });
    const patches: SettingsPatch[] = [
      { op: 'set', path: ['integrations', 'realtime', 'name'], value: '  Davo  ' },
      { op: 'set', path: ['integrations', 'realtime', 'context'], value: '\nBe concise.\n' },
      { op: 'set', path: ['unrelated'], value: '  retained  ' }
    ];
    const normalized = normalizedSettingsPatches('app', patches);

    expect(normalized.map(patch => patch.value)).toEqual(['Davo', 'Be concise.', '  retained  ']);
    expect(patches[0]!.value).toBe('  Davo  ');
    expect(hasSettingsDraftChanges(baseline, draft({ patches: patches.slice(0, 2) }), applyCandidate)).toBe(false);
  });
});

describe('effective settings patches', () => {
  it('omits an unchanged disclosed environment secret beside an ordinary change', () => {
    const baseline = source({
      id: 'compose-env',
      format: 'env',
      fields: [
        { key: 'API_KEY', protected: true, present: true, apply: 'rac-restart' },
        { key: 'PORT', value: '3000', protected: false, present: true, apply: 'rac-restart' }
      ]
    });
    const patches: SettingsPatch[] = [
      { op: 'set', path: ['API_KEY'], value: 'saved-secret', revisionId: 'secret-revision' },
      { op: 'set', path: ['PORT'], value: '4000', revisionId: 'port-revision' }
    ];

    expect(effectiveSettingsPatches(baseline, patches, applyCandidate, [{ path: ['API_KEY'], value: 'saved-secret' }])).toEqual([patches[1]]);
  });

  it('omits one unchanged nested secret without synthesizing it into sibling patches', () => {
    const marker = { __racProtected: true as const, present: true };
    const baseline = source({ value: { auth: { token: marker }, theme: 'dark' } });
    const patches: SettingsPatch[] = [
      { op: 'set', path: ['auth', 'token'], value: 'saved-secret' },
      { op: 'set', path: ['theme'], value: 'light', revisionId: 'theme-revision' }
    ];

    expect(effectiveSettingsPatches(baseline, patches, applyCandidate, [{ path: ['auth', 'token'], value: 'saved-secret' }])).toEqual([patches[1]]);
  });

  it('tracks a known protected leaf through an ordered collection move', () => {
    const marker = { __racProtected: true as const, present: true };
    const baseline = source({ value: { accounts: [{ name: 'first', token: marker }, { name: 'second' }] } });
    const move: SettingsPatch = { op: 'move', path: ['accounts'], from: 0, to: 1, revisionId: 'move-revision' };
    const sameMovedSecret: SettingsPatch = { op: 'set', path: ['accounts', '1', 'token'], value: 'saved-secret', revisionId: 'secret-revision' };

    expect(effectiveSettingsPatches(baseline, [move, sameMovedSecret], applyCandidate, [{ path: ['accounts', '0', 'token'], value: 'saved-secret' }])).toEqual([move]);
  });

  it('retains unknown protected replacements and their authored metadata', () => {
    const marker = { __racProtected: true as const, present: true };
    const baseline = source({ value: { token: marker } });
    const replacement: SettingsPatch = { op: 'set', path: ['token'], value: 'replacement', revisionId: 'opaque-revision' };

    expect(effectiveSettingsPatches(baseline, [replacement], applyCandidate)).toEqual([replacement]);
  });

  it('prunes absent removals, same values, and normalized voice no-ops', () => {
    const baseline = source({ value: { mode: 'one', integrations: { realtime: { name: 'Davo', context: 'Concise.' } } } });
    const changed: SettingsPatch = { op: 'set', path: ['mode'], value: 'two', revisionId: 'mode-revision' };
    const patches: SettingsPatch[] = [
      { op: 'remove', path: ['missing'] },
      { op: 'set', path: ['mode'], value: 'one' },
      { op: 'set', path: ['integrations', 'realtime', 'name'], value: '  Davo  ' },
      { op: 'set', path: ['integrations', 'realtime', 'context'], value: '\nConcise.\n' },
      changed
    ];

    expect(effectiveSettingsPatches(baseline, patches, applyCandidate)).toEqual([changed]);
  });

  it('preserves ordered collection operations and their array indexes', () => {
    const baseline = source({ value: { rows: ['one', 'two'] } });
    const patches: SettingsPatch[] = [
      { op: 'insert', path: ['rows'], index: 1, value: 'new', revisionId: 'insert-revision' },
      { op: 'move', path: ['rows'], from: 2, to: 0, revisionId: 'move-revision' },
      { op: 'remove', path: ['rows', '1'], revisionId: 'remove-revision' }
    ];

    expect(effectiveSettingsPatches(baseline, patches, applyCandidate)).toEqual(patches);
  });

  it('retains marker-invalid and subsequent patches for server validation', () => {
    const marker = { __racProtected: true as const, present: true };
    const baseline = source({ value: { token: marker, mode: 'one' } });
    const patches: SettingsPatch[] = [
      { op: 'set', path: ['token'], value: marker, revisionId: 'invalid-revision' },
      { op: 'set', path: ['mode'], value: 'one', revisionId: 'after-invalid-revision' }
    ];

    expect(effectiveSettingsPatches(baseline, patches, applyCandidate)).toEqual(patches);
  });

  it('compares environment values after string coercion and retains changed authored values', () => {
    const baseline = source({ id: 'compose-env', format: 'env', fields: [{ key: 'PORT', value: '3000', protected: false, present: true, apply: 'rac-restart' }] });
    const same: SettingsPatch = { op: 'set', path: ['PORT'], value: 3000 };
    const changed: SettingsPatch = { op: 'set', path: ['PORT'], value: 4000, revisionId: 'port-revision' };

    expect(effectiveSettingsPatches(baseline, [same, changed], applyCandidate)).toEqual([changed]);
  });

  // serialize safe blank environment sets as removals while retaining invalid selectors
  it('normalizes blank environment values to assignment removals', () => {
    const baseline = source({ id: 'compose-env', format: 'env', fields: [{ key: 'PORT', value: '3000', protected: false, present: true, apply: 'rac-restart' }] });
    const blank: SettingsPatch = { op: 'set', path: ['PORT'], value: '', revisionId: 'port-revision' };
    const missing: SettingsPatch = { op: 'set', path: ['OPTIONAL'], value: '', revisionId: 'optional-revision' };
    const invalid: SettingsPatch = { op: 'set', path: ['__proto__'], value: '', revisionId: 'invalid-revision' };

    expect(effectiveSettingsPatches(baseline, [blank], applyCandidate)).toEqual([{ op: 'remove', path: ['PORT'], revisionId: 'port-revision' }]);
    expect(effectiveSettingsPatches(baseline, [missing], applyCandidate)).toEqual([]);
    expect(effectiveSettingsPatches(baseline, [invalid], applyCandidate)).toEqual([invalid]);
  });

  it.each(invalidPathPatches)('retains $name without executing local traversal', ({ patch }) => {
    const baseline = source({ value: { mode: 'one' } });
    const following: SettingsPatch = { op: 'set', path: ['mode'], value: 'one', revisionId: 'after-invalid' };
    const dirtyApply = vi.fn((value: unknown) => value);

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [patch, following] }), dirtyApply)).toBe(true);
    expect(dirtyApply).not.toHaveBeenCalled();

    const effectiveApply = vi.fn((value: unknown) => value);
    expect(effectiveSettingsPatches(baseline, [patch, following], effectiveApply)).toEqual([patch, following]);
    expect(effectiveApply).not.toHaveBeenCalled();
  });

  it('retains an invalid environment path and subsequent same-value set', () => {
    const baseline = source({ id: 'compose-env', format: 'env', fields: [{ key: 'PORT', value: '3000', protected: false, present: true, apply: 'rac-restart' }] });
    const invalid: SettingsPatch = { op: 'remove', path: ['__proto__'], revisionId: 'invalid-revision' };
    const following: SettingsPatch = { op: 'set', path: ['PORT'], value: '3000', revisionId: 'after-invalid' };
    const apply = vi.fn((value: unknown) => value);

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [invalid, following] }), apply)).toBe(true);
    expect(effectiveSettingsPatches(baseline, [invalid, following], apply)).toEqual([invalid, following]);
    expect(apply).not.toHaveBeenCalled();
  });
});

// keep project previews and save pruning on the shared omission rules
describe('project draft omission semantics', () => {
  // avoid materializing missing command groups while clearing a blank field
  it('collapses optional nested edits back to their sparse baseline', async () => {
    const { applyAuthoredProjectPatch } = await import('../src/settings/project-normalization.js');
    const baseline = source({ value: { projects: [{ id: 'one', path: '/tmp/one' }] } });
    const path = ['projects', '0', 'commands', 'start'];
    const patches: SettingsPatch[] = [{ op: 'set', path, value: 'pnpm dev' }, { op: 'remove', path }];
    const absentClear: SettingsPatch[] = [{ op: 'remove', path }];

    expect(hasSettingsDraftChanges(baseline, draft({ patches }), applyAuthoredProjectPatch)).toBe(false);
    expect(hasSettingsDraftChanges(baseline, draft({ patches: absentClear }), applyAuthoredProjectPatch)).toBe(false);
    expect(effectiveSettingsPatches(baseline, absentClear, applyAuthoredProjectPatch)).toEqual([]);
    const reverted = appendSettingsPatch([{ op: 'set', path, value: 'pnpm dev' }], { op: 'set', path, value: '' });
    const renamed: SettingsPatch = { op: 'set', path: ['projects', '0', 'label'], value: 'Renamed' };
    expect(effectiveSettingsPatches(baseline, [...reverted, renamed], applyAuthoredProjectPatch)).toEqual([renamed]);
  });

  // preserve authored removals and meaningful explicit override containers
  it('keeps saved optional clears while retaining override suppression', async () => {
    const { applyAuthoredProjectPatch } = await import('../src/settings/project-normalization.js');
    const baseline = source({ value: { projects: [{ id: 'one', path: '/tmp/one', label: 'One', worktreeOverrides: [{ path: 'feature', commands: {} }] }] } });
    const patch: SettingsPatch = { op: 'remove', path: ['projects', '0', 'label'] };

    expect(hasSettingsDraftChanges(baseline, draft({ patches: [patch] }), applyAuthoredProjectPatch)).toBe(true);
    expect(effectiveSettingsPatches(baseline, [patch], applyAuthoredProjectPatch)).toEqual([patch]);
    expect(applyAuthoredProjectPatch(baseline.value, patch)).toEqual({ projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature', commands: {} }] }] });
  });
});
