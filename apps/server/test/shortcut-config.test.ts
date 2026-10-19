import { describe, expect, it } from 'vitest';
import { lookupKeyBinding, parseKeysConfig, resolveKeyTables } from '../src/config/keys.js';
import { editServerKeyTables, editServerShortcuts, editShortcutOverrides, reconcileShortcutOverrides, resetServerShortcuts, resolveShortcutTables, serverKeyTableModel, serverShortcutModel, shortcutCommands, shortcutKeys, shortcutLabel, shortcutOrigin, shortcutValidationError, validateShortcutOverrides, type ShortcutOverrides } from '../../web/src/shortcut-config.js';

// build representative server tables without duplicating row metadata
const configuredTables = () => resolveKeyTables(parseKeysConfig({
  root: { 'C-g': { table: 'git' }, 'C-p': { table: 'prefix' } },
  prefix: { q: 'command-palette', x: null },
  git: { d: { terminal: 'gh dash' }, e: { terminal: 'gh dash' }, x: null }
}));

describe('shortcut table overrides', () => {
  it('assigns multiple aliases without mutating the server tables', () => {
    const base = configuredTables();
    const before = structuredClone(base);
    const resolved = resolveShortcutTables(base, { prefix: { c: ['C-c', 'M-c'] }, git: { d: ['C-d', 'M-d'] } });

    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!['C-c']).toEqual({ ...base.prefix!.c, chord: 'C-c' });
    expect(resolved.prefix!['M-c']).toEqual({ ...base.prefix!.c, chord: 'M-c' });
    expect(resolved.git!.d).toBeUndefined();
    expect(resolved.git!['C-d']).toEqual({ ...base.git!.d, chord: 'C-d' });
    expect(resolved.git!['M-d']).toEqual({ ...base.git!.d, chord: 'M-d' });
    expect(base).toEqual(before);
  });

  it('disables a row and an empty override resets every row to the server result', () => {
    const base = configuredTables();

    expect(resolveShortcutTables(base, { prefix: { c: null } }).prefix!.c).toBeUndefined();
    expect(resolveShortcutTables(base, {})).toEqual(base);
  });

  it('preserves operator removals and lets an active alias occupy their placeholder', () => {
    const base = configuredTables();
    const stale = resolveShortcutTables(base, { prefix: { x: ['C-x'] } });
    const occupied = resolveShortcutTables(base, { prefix: { c: ['x'] } });

    expect(stale.prefix!.x).toEqual(base.prefix!.x);
    expect(stale.prefix!['C-x']).toBeUndefined();
    expect(occupied.prefix!.x).toEqual({ ...base.prefix!.c, chord: 'x' });
  });
});

describe('shortcut commands', () => {
  it('globally consolidates built-in actions and table switches in first-origin order', () => {
    const commands = shortcutCommands(configuredTables(), {});
    const larger = commands.find(command => command.id === 'action:font-larger')!;
    const nextPanel = commands.find(command => command.id === 'action:next-panel')!;
    const prefix = commands.find(command => command.id === 'table:prefix')!;

    expect(larger.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['root.C-=', 'root.C-+', 'root.Super-=', 'root.Super-+']);
    expect(nextPanel.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['prefix.n', 'prefix.o']);
    expect(prefix.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['root.C-b', 'root.C-p']);
    expect(commands.indexOf(larger)).toBeLessThan(commands.indexOf(nextPanel));
  });

  it('keeps terminal commands distinct by server origin even when their redacted binding matches', () => {
    const commands = shortcutCommands(configuredTables(), {});
    const terminals = commands.filter(command => command.id.startsWith('terminal:git:'));

    expect(terminals.map(command => command.id)).toEqual(['terminal:git:d', 'terminal:git:e']);
    expect(terminals.map(command => command.origins[0]!.chord)).toEqual(['d', 'e']);
  });

  it('deduplicates identical aliases assigned to the same command', () => {
    const commands = shortcutCommands(configuredTables(), { root: { 'C-=': ['C-F6'], 'Super-=': ['C-F6'] } });
    const larger = commands.find(command => command.id === 'action:font-larger')!;

    expect(larger.shortcuts.filter(shortcut => shortcut.chord === 'C-F6')).toEqual([
      { table: 'root', chord: 'C-F6', originTable: 'root', original: 'C-=', source: 'default', conflicted: false }
    ]);
    expect(reconcileShortcutOverrides(configuredTables(), { root: { 'C-=': ['C-F6'], 'Super-=': ['C-F6'] } }).conflicts).toEqual([]);
  });

  it('keeps browser-disabled commands editable and reserves unavailable for full operator removal', () => {
    const locallyDisabled = shortcutCommands(configuredTables(), { prefix: { n: null, o: null } }).find(command => command.id === 'action:next-panel')!;
    const partlyRemoved = shortcutCommands(resolveKeyTables(parseKeysConfig({ prefix: { n: null } })), {}).find(command => command.id === 'action:next-panel')!;
    const operatorRemoved = shortcutCommands(resolveKeyTables(parseKeysConfig({ prefix: { n: null, o: null } })), {}).find(command => command.id === 'action:next-panel')!;

    expect(locallyDisabled).toMatchObject({ unavailable: false, customized: true, shortcuts: [] });
    expect(partlyRemoved).toMatchObject({ unavailable: false });
    expect(operatorRemoved).toMatchObject({ unavailable: true, customized: false, shortcuts: [] });
  });
});

describe('shortcut identity and conflicts', () => {
  it('maps every terminal alias back to the correct server identity', () => {
    const base = configuredTables();
    const overrides = { git: { d: ['C-d', 'M-d'], e: ['C-e', 'M-e'] } };

    expect(shortcutOrigin(base, overrides, 'git', 'C-d')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'git', 'M-d')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'git', 'C-e')).toEqual({ table: 'git', chord: 'e' });
    expect(shortcutOrigin(base, overrides, 'git', 'd')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'missing', 'C-d')).toEqual({ table: 'missing', chord: 'C-d' });
  });

  it('dispatches cross-table aliases through their stable server origin', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { git: { d: [{ table: 'root', chord: 'C-F6' }] } };
    const resolved = resolveShortcutTables(base, overrides);

    expect(resolved.git!.d).toBeUndefined();
    expect(lookupKeyBinding(resolved, 'root', 'C-F6')).toEqual({ terminal: 'gh dash' });
    expect(shortcutOrigin(base, overrides, 'root', 'C-F6')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutCommands(base, overrides).find(command => command.id === 'terminal:git:d')!.shortcuts).toEqual([
      { table: 'root', chord: 'C-F6', originTable: 'git', original: 'd', source: 'config', conflicted: false }
    ]);
  });

});

describe('shortcut reconciliation', () => {
  it('preserves every conflict participant and makes the ambiguous chord non-dispatchable', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['C-a'], n: ['C-a'] } };
    const reconciled = reconcileShortcutOverrides(base, overrides);
    const resolved = resolveShortcutTables(base, overrides);

    expect(reconciled).toEqual({ overrides, conflicts: ['prefix.C-a'] });
    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!['C-a']?.conflicted).toBe(true);
    expect(lookupKeyBinding(resolved, 'prefix', 'C-a')).toBeUndefined();
    expect(shortcutCommands(base, overrides).filter(command => command.shortcuts.some(shortcut => shortcut.chord === 'C-a')).map(command => [command.id, command.shortcuts.find(shortcut => shortcut.chord === 'C-a')!.conflicted])).toEqual([
      ['action:new-terminal', true],
      ['action:next-panel', true]
    ]);
  });

  it('does not fall back to a default when a custom alias conflicts with it', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['n'] } };
    const resolved = resolveShortcutTables(base, overrides);

    expect(reconcileShortcutOverrides(base, overrides)).toEqual({ overrides, conflicts: ['prefix.n'] });
    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!.n?.conflicted).toBe(true);
  });

  it('scopes conflicts to a key table', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['C-a'] }, git: { d: ['C-a'] } };

    expect(reconcileShortcutOverrides(base, overrides).conflicts).toEqual([]);
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'prefix', 'C-a')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'git', 'C-a')).toEqual({ terminal: 'gh dash' });
  });

  it('detects conflicts and same-command duplicates at effective cross-table destinations', () => {
    const base = configuredTables();
    const conflict: ShortcutOverrides = { prefix: { c: [{ table: 'root', chord: 'C-=' }] } };
    const duplicate: ShortcutOverrides = { prefix: { '?': [{ table: 'root', chord: 'C-?' }] } };

    expect(reconcileShortcutOverrides(base, conflict).conflicts).toEqual(['root.C-=']);
    expect(lookupKeyBinding(resolveShortcutTables(base, conflict), 'root', 'C-=')).toBeUndefined();
    expect(shortcutCommands(base, conflict).filter(command => command.shortcuts.some(shortcut => shortcut.table === 'root' && shortcut.chord === 'C-=')).map(command => command.id)).toEqual([
      'action:font-larger',
      'action:new-terminal'
    ]);
    expect(reconcileShortcutOverrides(base, duplicate).conflicts).toEqual([]);
    expect(shortcutCommands(base, duplicate).find(command => command.id === 'action:show-bindings')!.shortcuts.filter(shortcut => shortcut.table === 'root' && shortcut.chord === 'C-?')).toHaveLength(1);
  });

  it('keeps preferences while conflicted and recovers after one participant changes', () => {
    const base = configuredTables();
    const conflicted = { prefix: { c: ['C-a', 'M-c'], n: ['C-a'] } };
    const recovered = { prefix: { c: ['C-a', 'M-c'], n: ['M-n'] } };

    expect(reconcileShortcutOverrides(base, conflicted).overrides).toEqual(conflicted);
    expect(reconcileShortcutOverrides(base, recovered)).toEqual({ overrides: recovered, conflicts: [] });
    expect(lookupKeyBinding(resolveShortcutTables(base, recovered), 'prefix', 'C-a')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, recovered), 'prefix', 'M-n')).toBe('next-panel');
  });

  it('drops stored identities removed or no longer supplied by the server', () => {
    const base = configuredTables();
    const reconciled = reconcileShortcutOverrides(base, { prefix: { x: ['C-x'], missing: null, c: ['C-c'] }, missing: { c: ['C-c'] } });

    expect(reconciled).toEqual({ overrides: { prefix: { c: ['C-c'] } }, conflicts: [] });
  });

  it('drops aliases for missing destination tables and safely restores inheritance', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { prefix: { c: [{ table: 'gone', chord: 'C-c' }] } };

    expect(reconcileShortcutOverrides(base, overrides)).toEqual({ overrides: {}, conflicts: [] });
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'prefix', 'c')).toBe('new-terminal');
  });
});

describe('stored shortcut validation', () => {
  it('migrates strings and keeps only bounded canonical safe aliases', () => {
    const validated = validateShortcutOverrides({
      prefix: { c: 'C-c', n: null, p: ['M-p', 'M-p', 'Hyper-x'], q: [], bad: ['Hyper-x'] },
      root: { y: ['y'], 'C-b': ['g', 'C-g'], 'C-s': 'C-s' },
      'Bad Table': { c: 'C-c' },
      broken: null
    });

    expect(validated).toEqual({
      prefix: { c: ['C-c'], n: null, p: ['M-p'], q: null },
      root: { y: ['y'], 'C-b': ['C-g'], 'C-s': ['C-s'] }
    });
    expect(validateShortcutOverrides(null)).toEqual({});
    expect(validateShortcutOverrides([])).toEqual({});
  });

  it('canonicalizes and deduplicates same-table and cross-table destinations', () => {
    expect(validateShortcutOverrides({
      prefix: {
        c: ['C-c', { table: 'prefix', chord: 'C-c' }, { table: 'root', chord: 'C-F6' }, { table: 'root', chord: 'C-F6' }, { table: 'root', chord: 'c' }]
      }
    })).toEqual({ prefix: { c: ['C-c', { table: 'root', chord: 'C-F6' }] } });
    expect(validateShortcutOverrides({ prefix: { c: 'C-c' } })).toEqual({ prefix: { c: ['C-c'] } });
  });

  it('caps stored tables, rows and aliases', () => {
    const input = Object.fromEntries(Array.from({ length: 40 }, (_, table) => [`table-${table}`, Object.fromEntries(Array.from({ length: 240 }, (_, row) => [`C-F${row + 1}`, Array.from({ length: 30 }, (__, alias) => `M-F${alias + 1}`)]))]));
    const validated = validateShortcutOverrides(input);

    expect(Object.keys(validated).length).toBeLessThanOrEqual(32);
    expect(Object.values(validated).every(rows => Object.keys(rows).length <= 200)).toBe(true);
    expect(Object.values(validated).flatMap(Object.values).filter(Array.isArray).every(aliases => aliases.length <= 20)).toBe(true);
  });
});

describe('shortcut validation', () => {
  it('reports browser reservations and unsafe root typing', () => {
    expect(shortcutValidationError('prefix', 'C-t', 'c')).toContain('reserve it');
    expect(shortcutValidationError('root', 'g', 'C-b')).toContain('cannot steal typing');
    expect(shortcutValidationError('prefix', 'Hyper-x', 'c')).toContain('not a key');
  });

  it('allows retained built-in root typing shortcuts but not aliases borrowed from another origin', () => {
    expect(shortcutValidationError('root', 'y', 'y')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Left', 'S-Left')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Enter', 'S-Enter')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Right', 'C-b')).toContain('cannot steal typing');
    expect(shortcutValidationError('root', 'S-Right', 'S-Right', 'prefix')).toContain('cannot steal typing');
    expect(shortcutValidationError('root', '', 'C-b')).toBeUndefined();
  });
});

describe('shortcut editing', () => {
  it('adds and moves bindings between prefixed and nonprefixed tables', () => {
    const base = configuredTables();
    const added = editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' });

    expect(added).toEqual({ overrides: { prefix: { c: ['c', { table: 'root', chord: 'C-F6' }] } } });
    expect(lookupKeyBinding(resolveShortcutTables(base, added.overrides!), 'prefix', 'c')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, added.overrides!), 'root', 'C-F6')).toBe('new-terminal');

    const moved = editShortcutOverrides(base, added.overrides!, 'action:new-terminal', { kind: 'replace', fromTable: 'root', from: 'C-F6', table: 'prefix', chord: 'M-c' });
    expect(moved).toEqual({ overrides: { prefix: { c: ['c', 'M-c'] } } });
    expect(shortcutOrigin(base, moved.overrides!, 'prefix', 'M-c')).toEqual({ table: 'prefix', chord: 'c' });

    const rootToPrefix = editShortcutOverrides(base, {}, 'action:show-bindings', { kind: 'replace', fromTable: 'root', from: 'C-?', table: 'prefix', chord: 'F6' });
    expect(rootToPrefix).toEqual({ overrides: { root: { 'C-?': [{ table: 'prefix', chord: 'F6' }] } } });
    expect(shortcutOrigin(base, rootToPrefix.overrides!, 'prefix', 'F6')).toEqual({ table: 'root', chord: 'C-?' });
  });

  it('removes, disables and resets cross-table aliases across consolidated origins', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { root: { 'C-=': ['C-=', { table: 'prefix', chord: 'F6' }] } };
    const removed = editShortcutOverrides(base, overrides, 'action:font-larger', { kind: 'remove', table: 'prefix', from: 'F6' });
    const disabled = editShortcutOverrides(base, overrides, 'action:font-larger', { kind: 'disable' });
    const reset = editShortcutOverrides(base, disabled.overrides!, 'action:font-larger', { kind: 'reset' });

    expect(removed).toEqual({ overrides: {} });
    expect(shortcutCommands(base, disabled.overrides!).find(command => command.id === 'action:font-larger')!.shortcuts).toEqual([]);
    expect(reset).toEqual({ overrides: {} });
  });

  it('keeps terminal authorization tied to its original server row after a move', () => {
    const base = configuredTables();
    const moved = editShortcutOverrides(base, {}, 'terminal:git:d', { kind: 'replace', fromTable: 'git', from: 'd', table: 'root', chord: 'C-F8' });

    expect(moved).toEqual({ overrides: { git: { d: [{ table: 'root', chord: 'C-F8' }] } } });
    expect(shortcutOrigin(base, moved.overrides!, 'root', 'C-F8')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutCommands(base, moved.overrides!).filter(command => command.id.startsWith('terminal:git:')).map(command => [command.id, command.shortcuts.map(shortcut => `${shortcut.table}.${shortcut.chord}`)])).toEqual([
      ['terminal:git:d', ['root.C-F8']],
      ['terminal:git:e', ['git.e']]
    ]);
  });

  it('rejects stale aliases, missing tables, unsafe root typing and server-disabled commands', () => {
    const base = configuredTables();

    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'replace', fromTable: 'prefix', from: 'missing', table: 'root', chord: 'C-F6' }).error).toContain('changed');
    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'gone', chord: 'C-F6' }).error).toContain('no longer available');
    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'c' }).error).toContain('cannot steal typing');
    const removed = resolveKeyTables(parseKeysConfig({ prefix: { c: null } }));
    expect(editShortcutOverrides(removed, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' }).error).toContain('disabled by the server');
  });
});

describe('shortcut labels', () => {
  it('uses separate familiar labels for every modifier and key', () => {
    expect(shortcutKeys('C-M-S-Super-Left', 'Win32')).toEqual(['Ctrl', 'Alt', 'Shift', 'Win', '←']);
    expect(shortcutKeys('M-Super-BSpace', 'MacIntel')).toEqual(['Alt', 'Cmd', 'Backspace']);
    expect(shortcutKeys('Super-a', 'Darwin arm64')).toEqual(['Cmd', 'A']);
    expect(shortcutKeys('Super-a', 'Linux x86_64')).toEqual(['Super', 'A']);
    expect(shortcutKeys('C--', 'Linux')).toEqual(['Ctrl', '-']);
    expect(shortcutLabel('C-S-c', 'Windows')).toBe('Ctrl + Shift + C');
  });
});

describe('server shortcut patch compiler', () => {
  it('adds and moves safe bindings with minimal direct key-table patches', () => {
    const keys = {
      prefix: {
        g: { terminal: 'env TOKEN=safe /usr/bin/gh dash', reuse: true },
        c: 'new-terminal'
      }
    };

    expect(editServerShortcuts(keys, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' })).toEqual({
      patches: [{ op: 'set', path: ['keys', 'root', 'C-F6'], value: 'new-terminal' }]
    });
    expect(editServerShortcuts(keys, 'terminal:prefix:g', { kind: 'replace', fromTable: 'prefix', from: 'g', table: 'root', chord: 'C-F8' })).toEqual({
      patches: [
        { op: 'set', path: ['keys', 'prefix', 'g'], value: null },
        { op: 'set', path: ['keys', 'root', 'C-F8'], value: { terminal: 'env TOKEN=safe /usr/bin/gh dash', reuse: true } }
      ]
    });
  });

  it('uses null for disabled built-in defaults and removes config-only bindings', () => {
    const disabledDefault = editServerShortcuts({}, 'action:new-terminal', { kind: 'remove', table: 'prefix', from: 'c' });
    const removedCustom = editServerShortcuts({ prefix: { v: 'new-terminal' } }, 'action:new-terminal', { kind: 'remove', table: 'prefix', from: 'v' });

    expect(disabledDefault).toEqual({ patches: [{ op: 'set', path: ['keys', 'prefix', 'c'], value: null }] });
    expect(removedCustom).toEqual({ patches: [{ op: 'remove', path: ['keys', 'prefix', 'v'] }] });
  });

  it('targets exact raw chord properties when existing spelling canonicalizes', () => {
    const keys = { prefix: { 'C-A': 'new-terminal', 'C-B': 'show-bindings' } };

    expect(editServerShortcuts(keys, 'action:new-terminal', { kind: 'remove', table: 'prefix', from: 'C-S-a' })).toEqual({
      patches: [{ op: 'remove', path: ['keys', 'prefix', 'C-A'] }]
    });
    expect(editServerShortcuts(keys, 'action:show-bindings', { kind: 'reset' })).toEqual({
      patches: [{ op: 'remove', path: ['keys', 'prefix', 'C-B'] }]
    });
    expect(editServerShortcuts(keys, 'action:new-terminal', { kind: 'replace', fromTable: 'prefix', from: 'C-S-a', table: 'root', chord: 'C-F6' })).toEqual({
      patches: [
        { op: 'remove', path: ['keys', 'prefix', 'C-A'] },
        { op: 'set', path: ['keys', 'root', 'C-F6'], value: 'new-terminal' }
      ]
    });
  });

  it('reuses a noncanonical removed destination instead of creating a duplicate canonical chord', () => {
    const keys = { root: { 'S-C-c': null } };
    const result = editServerShortcuts(keys, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-S-c' });

    expect(result).toEqual({ patches: [{ op: 'set', path: ['keys', 'root', 'S-C-c'], value: 'new-terminal' }] });
    const candidate = { root: { ...keys.root, 'S-C-c': result.patches![0]!.value } };
    expect(parseKeysConfig(candidate)).toEqual({ root: { 'C-S-c': 'new-terminal' } });
  });

  it('preserves the exact safe terminal binding when moving a raw config leaf', () => {
    const terminal = { terminal: '  env TOKEN=safe /usr/bin/gh dash  ', reuse: false };
    const keys = { prefix: { 'C-G': terminal } };

    expect(editServerShortcuts(keys, 'terminal:prefix:C-S-g', { kind: 'replace', fromTable: 'prefix', from: 'C-S-g', table: 'root', chord: 'C-F8' })).toEqual({
      patches: [
        { op: 'remove', path: ['keys', 'prefix', 'C-G'] },
        { op: 'set', path: ['keys', 'root', 'C-F8'], value: terminal }
      ]
    });
  });

  it('resets one command without changing unrelated configured bindings', () => {
    const keys = {
      root: { 'C-?': null, 'C-F6': 'show-bindings', 'C-F7': 'command-palette' },
      prefix: { '?': null, v: 'show-bindings', x: null }
    };

    expect(editServerShortcuts(keys, 'action:show-bindings', { kind: 'reset' })).toEqual({
      patches: [
        { op: 'remove', path: ['keys', 'root', 'C-?'] },
        { op: 'remove', path: ['keys', 'root', 'C-F6'] },
        { op: 'remove', path: ['keys', 'prefix', '?'] },
        { op: 'remove', path: ['keys', 'prefix', 'v'] }
      ]
    });
    expect(resetServerShortcuts()).toEqual([{ op: 'remove', path: ['keys'] }]);
  });

  it('rejects collisions instead of overwriting another command', () => {
    expect(editServerShortcuts({}, 'action:new-terminal', { kind: 'add', table: 'prefix', chord: 'n' })).toEqual({
      error: 'That shortcut is already assigned to another command.'
    });
  });

  it('keeps protected terminal bindings visible but never serializes their marker', () => {
    const keys = {
      prefix: {
        g: { terminal: { __racProtected: true, present: true }, reuse: true }
      }
    };
    const model = serverShortcutModel(keys);
    const command = model.commands.find(candidate => candidate.id === 'terminal:prefix:g');

    expect(command).toMatchObject({ protected: true, binding: { terminal: 'protected-terminal', reuse: true } });
    expect(JSON.stringify(model)).not.toContain('__racProtected');
    expect(editServerShortcuts(keys, 'terminal:prefix:g', { kind: 'replace', fromTable: 'prefix', from: 'g', table: 'root', chord: 'C-F8' })).toEqual({
      error: 'This terminal command is protected. Use the advanced key-table controls to edit it.'
    });
  });

  it('reports malformed config for repair instead of silently falling back', () => {
    const model = serverShortcutModel({ root: { c: 'new-terminal' } });

    expect(model.error).toContain('cannot steal typing');
    expect(editServerShortcuts({ root: { c: 'new-terminal' } }, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' }).error).toContain('cannot steal typing');
  });
});

describe('structured server key tables', () => {
  // expose defaults, exact configured leaves, disabled custom rows and empty tables
  it('models raw rows, inbound references, protected terminals and empty config tables', () => {
    const terminal = { terminal: '  env TOKEN=safe /usr/bin/gh dash  ', reuse: false };
    const model = serverKeyTableModel({
      root: { 'S-C-g': { table: 'git' } },
      prefix: { c: null, v: null },
      git: { 'C-G': terminal, x: null },
      empty: {},
      vault: { v: { terminal: { __racProtected: true, present: true }, reuse: true } }
    });

    expect(model.error).toBeUndefined();
    expect(model.hasConfig).toBe(true);
    expect(model.tables.map(table => table.name)).toEqual(['root', 'prefix', 'git', 'empty', 'vault']);
    expect(model.tables.find(table => table.name === 'root')).toMatchObject({ builtIn: true, configured: true });
    expect(model.tables.find(table => table.name === 'prefix')?.rows.find(row => row.chord === 'c')).toMatchObject({ binding: null, source: 'removed', configured: true, builtInDefault: true });
    expect(model.tables.find(table => table.name === 'prefix')?.rows.find(row => row.chord === 'v')).toMatchObject({ binding: null, source: 'removed', configured: true, builtInDefault: false });
    expect(model.tables.find(table => table.name === 'empty')).toEqual({ name: 'empty', builtIn: false, configured: true, rows: [], inbound: [] });
    expect(model.tables.find(table => table.name === 'git')?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ chord: 'C-S-g', rawChord: 'C-G', binding: terminal, source: 'config', configured: true, protected: false }),
      expect.objectContaining({ chord: 'x', rawChord: 'x', binding: null, source: 'removed', configured: true, protected: false })
    ]));
    expect(model.tables.find(table => table.name === 'git')?.inbound).toEqual([{ table: 'root', chord: 'C-S-g', rawChord: 'S-C-g' }]);
    expect(model.tables.find(table => table.name === 'vault')?.rows).toEqual([
      expect.objectContaining({ chord: 'v', rawChord: 'v', binding: { terminal: 'protected-terminal', reuse: true }, source: 'config', configured: true, protected: true })
    ]);
    expect(JSON.stringify(model)).not.toContain('__racProtected');
    expect(serverKeyTableModel({ empty: {} }).hasConfig).toBe(true);
    expect(serverKeyTableModel(undefined).hasConfig).toBe(false);
    expect(serverShortcutModel({ empty: {} }).hasConfig).toBe(true);
  });

  // create and delete only valid tables while retaining referenced custom targets
  it('creates, resets and removes tables with inbound-reference guards', () => {
    expect(editServerKeyTables(undefined, { kind: 'create-table', name: 'git' })).toEqual({ patches: [{ op: 'set', path: ['keys', 'git'], value: {} }] });
    expect(editServerKeyTables({}, { kind: 'create-table', name: 'Bad Table' }).error).toContain('table name');
    expect(editServerKeyTables({}, { kind: 'create-table', name: 'constructor' }).error).toContain('reserved');
    expect(editServerKeyTables({ constructor: {} }, { kind: 'remove-table', name: 'constructor' }).error).toContain('reserved');
    expect(editServerKeyTables({ root: {} }, { kind: 'remove-table', name: 'root' })).toEqual({ patches: [{ op: 'remove', path: ['keys', 'root'] }] });
    expect(editServerKeyTables({ git: {} }, { kind: 'remove-table', name: 'git' })).toEqual({ patches: [{ op: 'remove', path: ['keys', 'git'] }] });
    expect(editServerKeyTables({ root: { 'C-g': { table: 'git' } }, git: {} }, { kind: 'remove-table', name: 'git' }).error).toContain('referenced');
    expect(editServerKeyTables({ git: { g: { table: 'git' } } }, { kind: 'remove-table', name: 'git' })).toEqual({ patches: [{ op: 'remove', path: ['keys', 'git'] }] });
  });

  // rename a custom table and every switch reference without normalizing raw values
  it('renames custom tables atomically while preserving raw chords and terminal bytes', () => {
    const terminal = { terminal: '  env TOKEN=safe /usr/bin/gh dash  ', reuse: false };
    const keys = { root: { 'S-C-g': { table: 'git' } }, git: { 'C-G': terminal, x: { table: 'git' } } };

    expect(editServerKeyTables(keys, { kind: 'rename-table', from: 'git', to: 'tools' })).toEqual({ patches: [
      { op: 'set', path: ['keys', 'tools'], value: { 'C-G': terminal, x: { table: 'tools' } } },
      { op: 'set', path: ['keys', 'root', 'S-C-g'], value: { table: 'tools' } },
      { op: 'remove', path: ['keys', 'git'] }
    ] });
    expect(editServerKeyTables(keys, { kind: 'rename-table', from: 'root', to: 'base' }).error).toContain('Built-in');
    expect(editServerKeyTables({ tools: {}, other: {} }, { kind: 'rename-table', from: 'tools', to: 'other' }).error).toContain('already exists');
    expect(editServerKeyTables({ constructor: { g: { table: 'git' } }, git: {} }, { kind: 'rename-table', from: 'git', to: 'tools' }).error).toContain('reserved');
  });

  // never copy a masked terminal while allowing direct replacement and removal
  it('blocks protected copies but permits unrelated edits, replacement and removal', () => {
    const keys = { secret: { 'C-G': { terminal: { __racProtected: true, present: true }, reuse: true }, x: 'new-terminal' } };
    const freshTerminal = { terminal: '  printf fresh  ', reuse: false };

    expect(editServerKeyTables(keys, { kind: 'rename-table', from: 'secret', to: 'private' }).error).toContain('protected terminal');
    expect(editServerKeyTables(keys, { kind: 'rename-binding', table: 'secret', from: 'C-S-g', to: 'C-F6' }).error).toContain('protected terminal');
    expect(editServerKeyTables(keys, { kind: 'set-binding', table: 'secret', chord: 'C-S-g', binding: 'show-bindings' })).toEqual({ patches: [{ op: 'set', path: ['keys', 'secret', 'C-G'], value: 'show-bindings' }] });
    expect(editServerKeyTables(keys, { kind: 'set-binding', table: 'secret', chord: 'C-S-g', binding: freshTerminal })).toEqual({ patches: [{ op: 'set', path: ['keys', 'secret', 'C-G'], value: freshTerminal }] });
    expect(editServerKeyTables(keys, { kind: 'remove-binding', table: 'secret', chord: 'C-S-g', mode: 'restore' })).toEqual({ patches: [{ op: 'remove', path: ['keys', 'secret', 'C-G'] }] });
    expect(editServerKeyTables(keys, { kind: 'set-binding', table: 'secret', chord: 'C-F7', binding: { terminal: { __racProtected: true, present: true } } as never }).error).toContain('protected marker');
  });

  // create only unoccupied rows while permitting an explicit disabled destination
  it('creates bindings without replacing active defaults or configured rows', () => {
    expect(editServerKeyTables({}, { kind: 'create-binding', table: 'prefix', chord: 'c', binding: 'show-bindings' }).error).toContain('already assigned');
    expect(editServerKeyTables({ prefix: { v: 'new-terminal' } }, { kind: 'create-binding', table: 'prefix', chord: 'v', binding: 'show-bindings' }).error).toContain('already assigned');
    expect(editServerKeyTables({ prefix: { 'C-A': 'new-terminal' } }, { kind: 'create-binding', table: 'prefix', chord: 'C-S-a', binding: 'show-bindings' }).error).toContain('already assigned');
    expect(editServerKeyTables({ prefix: { 'S-C-c': null } }, { kind: 'create-binding', table: 'prefix', chord: 'C-S-c', binding: 'show-bindings' })).toEqual({
      patches: [{ op: 'set', path: ['keys', 'prefix', 'S-C-c'], value: 'show-bindings' }]
    });
    expect(editServerKeyTables({}, { kind: 'create-binding', table: 'prefix', chord: 'M-z', binding: null })).toEqual({
      patches: [{ op: 'set', path: ['keys', 'prefix', 'M-z'], value: null }]
    });
    expect(editServerKeyTables({}, { kind: 'create-binding', table: 'prefix', chord: 'c', binding: null }).error).toContain('already assigned');
  });

  // preserve moved bindings and keep renamed built-in chords disabled at their old address
  it('renames bindings without value corruption or default resurrection', () => {
    const terminal = { terminal: '  printf safe  ', reuse: false };
    expect(editServerKeyTables({ prefix: { 'C-G': terminal } }, { kind: 'rename-binding', table: 'prefix', from: 'C-S-g', to: 'M-g' })).toEqual({ patches: [
      { op: 'remove', path: ['keys', 'prefix', 'C-G'] },
      { op: 'set', path: ['keys', 'prefix', 'M-g'], value: terminal }
    ] });
    expect(editServerKeyTables({}, { kind: 'rename-binding', table: 'prefix', from: 'c', to: 'v' })).toEqual({ patches: [
      { op: 'set', path: ['keys', 'prefix', 'c'], value: null },
      { op: 'set', path: ['keys', 'prefix', 'v'], value: 'new-terminal' }
    ] });
    expect(editServerKeyTables({ prefix: { c: terminal } }, { kind: 'rename-binding', table: 'prefix', from: 'c', to: 'v' })).toEqual({ patches: [
      { op: 'set', path: ['keys', 'prefix', 'c'], value: null },
      { op: 'set', path: ['keys', 'prefix', 'v'], value: terminal }
    ] });
  });

  // reject canonical collisions and reuse an existing noncanonical null destination safely
  it('handles collisions and raw null destinations by canonical identity', () => {
    expect(editServerKeyTables({ prefix: { v: 'new-terminal', 'C-A': 'show-bindings' } }, { kind: 'rename-binding', table: 'prefix', from: 'v', to: 'C-S-a' }).error).toContain('already assigned');
    expect(editServerKeyTables({ prefix: { v: 'new-terminal', 'S-C-c': null } }, { kind: 'rename-binding', table: 'prefix', from: 'v', to: 'C-S-c' })).toEqual({ patches: [
      { op: 'remove', path: ['keys', 'prefix', 'v'] },
      { op: 'set', path: ['keys', 'prefix', 'S-C-c'], value: 'new-terminal' }
    ] });
    expect(editServerKeyTables({ prefix: { v: null } }, { kind: 'rename-binding', table: 'prefix', from: 'v', to: 'C-F6' }).error).toContain('Disabled shortcuts');
  });

  // use full candidate validation for actions, switch targets, root chords and limits
  it('validates complete candidates and respects table and binding limits', () => {
    expect(serverKeyTableModel(JSON.parse('{"__proto__":{}}')).error).toContain('table name');
    expect(editServerKeyTables({}, { kind: 'set-binding', table: 'prefix', chord: 'v', binding: 'unknown-action' as never }).error).toContain('unknown action');
    expect(editServerKeyTables({}, { kind: 'set-binding', table: 'prefix', chord: 'v', binding: { table: 'missing' } }).error).toContain('no table named');
    expect(editServerKeyTables({}, { kind: 'set-binding', table: 'root', chord: 'v', binding: 'new-terminal' }).error).toContain('cannot steal typing');
    const tables = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`table-${index}`, {}]));
    expect(editServerKeyTables(tables, { kind: 'create-table', name: 'overflow' }).error).toContain('at most 32 tables');
    const functionRows = Array.from({ length: 192 }, (_, index) => {
      const mask = Math.floor(index / 12);
      const modifiers = [mask & 1 ? 'C-' : '', mask & 2 ? 'M-' : '', mask & 4 ? 'S-' : '', mask & 8 ? 'Super-' : ''].join('');
      return [`${modifiers}F${index % 12 + 1}`, 'new-terminal'];
    });
    const rows = Object.fromEntries([...functionRows, ...Array.from('abcdefgh', key => [`C-${key}`, 'new-terminal'])]);
    expect(editServerKeyTables({ crowded: rows }, { kind: 'set-binding', table: 'crowded', chord: 'M-z', binding: 'new-terminal' }).error).toContain('at most 200 bindings');
  });

  // distinguish disable from restore and leave unrelated leaves untouched
  it('compiles direct disable and restore patches only', () => {
    expect(editServerKeyTables({}, { kind: 'remove-binding', table: 'prefix', chord: 'c', mode: 'disable' })).toEqual({ patches: [{ op: 'set', path: ['keys', 'prefix', 'c'], value: null }] });
    expect(editServerKeyTables({ prefix: { c: 'show-bindings', x: 'new-terminal' } }, { kind: 'remove-binding', table: 'prefix', chord: 'c', mode: 'restore' })).toEqual({ patches: [{ op: 'remove', path: ['keys', 'prefix', 'c'] }] });
    expect(editServerKeyTables({ prefix: { x: 'new-terminal' } }, { kind: 'remove-binding', table: 'prefix', chord: 'x', mode: 'disable' })).toEqual({ patches: [{ op: 'set', path: ['keys', 'prefix', 'x'], value: null }] });
  });
});
