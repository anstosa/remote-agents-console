import { describe, expect, it } from 'vitest';
import { browserKeysConfig, defaultKeyTables, eventChord, focusKeyTableLabel, isFocusKeyTable, isKeyTableName, keyActions, movedRootDefault, parseChord, parseKeysConfig, resolveKeyTables, terminalBindingCommand } from '../src/config/keys.js';

const press = (key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string; isComposing?: boolean } = {}) => ({ key, code: modifiers.code ?? '', ctrlKey: modifiers.ctrl ?? false, altKey: modifiers.alt ?? false, shiftKey: modifiers.shift ?? false, metaKey: modifiers.meta ?? false, isComposing: modifiers.isComposing ?? false });

describe('chord syntax', () => {
  it('canonicalizes modifiers into C-M-S-Super order', () => {
    expect(parseChord('C-b')).toBe('C-b');
    expect(parseChord('Super-S-C-x')).toBe('C-S-Super-x');
    expect(parseChord('M-C-Space')).toBe('C-M-Space');
  });

  it('reads an uppercase letter as Shift and drops Shift from other characters', () => {
    expect(parseChord('L')).toBe('S-l');
    expect(parseChord('S-l')).toBe('S-l');
    expect(parseChord('C-S-c')).toBe('C-S-c');
    expect(parseChord('C-C')).toBe('C-S-c');
    expect(parseChord('S-%')).toBe('%');
    expect(parseChord('C-?')).toBe('C-?');
  });

  it('keeps a dash or plus as the key after a modifier', () => {
    expect(parseChord('C--')).toBe('C--');
    expect(parseChord('C-+')).toBe('C-+');
    expect(parseChord('-')).toBe('-');
  });

  it('accepts named keys in any case and keeps Shift on them', () => {
    expect(parseChord('S-Left')).toBe('S-Left');
    expect(parseChord('c-pageup')).toBe('C-PageUp');
    expect(parseChord('F12')).toBe('F12');
  });

  it('refuses unknown keys, empty chords and repeated modifiers', () => {
    for (const bad of ['', 'C-', 'C-C-b', 'Hyper-b', 'C-abc', 'F13']) expect(() => parseChord(bad), bad).toThrow();
  });
});

describe('eventChord', () => {
  it('names a chord by the character typed', () => {
    expect(eventChord(press('b', { ctrl: true }))).toBe('C-b');
    expect(eventChord(press('%', { shift: true }))).toBe('%');
    expect(eventChord(press('?', { ctrl: true, shift: true }))).toBe('C-?');
    expect(eventChord(press('L', { shift: true }))).toBe('S-l');
    expect(eventChord(press('C', { ctrl: true, shift: true }))).toBe('C-S-c');
  });

  it('ignores Caps Lock on letters', () => {
    expect(eventChord(press('L'))).toBe('l');
  });

  it('maps named keys', () => {
    expect(eventChord(press('ArrowLeft', { shift: true }))).toBe('S-Left');
    expect(eventChord(press(' ', { ctrl: true }))).toBe('C-Space');
    expect(eventChord(press('Backspace'))).toBe('BSpace');
    expect(eventChord(press('F5'))).toBe('F5');
    expect(eventChord(press('=', { meta: true }))).toBe('Super-=');
  });

  it('reads Alt letters and digits from the physical key when the layout rewrites them', () => {
    expect(eventChord(press('å', { alt: true, code: 'KeyA' }))).toBe('M-a');
    expect(eventChord(press('¡', { alt: true, code: 'Digit1' }))).toBe('M-1');
  });

  it('gives no chord for a bare modifier, a dead key or an IME composition', () => {
    expect(eventChord(press('Shift', { shift: true }))).toBeUndefined();
    expect(eventChord(press('Control', { ctrl: true }))).toBeUndefined();
    expect(eventChord(press('Dead'))).toBeUndefined();
    expect(eventChord(press('Process'))).toBeUndefined();
    expect(eventChord(press('a', { isComposing: true }))).toBeUndefined();
  });

  it('agrees with parseChord on every default binding', () => {
    for (const table of Object.values(defaultKeyTables)) for (const chord of Object.keys(table)) expect(parseChord(chord)).toBe(chord);
  });
});

describe('keys configuration', () => {
  // keep the recovery preview opt-in on each installation
  it('allows mapping the tmux recovery preview but does not bind it by default', () => {
    const action = 'preview-tmux-recovery';
    expect(Object.values(defaultKeyTables).flatMap(table => Object.values(table))).not.toContain(action);
    const keys = parseKeysConfig({ root: { 'Super-M-t': action } });
    expect(resolveKeyTables(keys).root!['M-Super-t']?.binding).toBe(action);
    expect(eventChord(press('t', { alt: true, meta: true, code: 'KeyT' }))).toBe('M-Super-t');
  });

  it('reserves named focus-condition tables without widening custom table names', () => {
    // verify the labels of every resolved focus table in settings order
    expect(Object.keys(defaultKeyTables).filter(isFocusKeyTable).map(name => [name, focusKeyTableLabel(name)])).toEqual([
      ['when:prompt', 'Prompt focused'],
      ['when:terminal', 'Terminal focused'],
      ['when:agent', 'Agent focused'],
      ['when:browser', 'Browser focused'],
      ['when:note-editor', 'Note editor focused'],
      ['when:code', 'Code/diff focused'],
      ['when:files', 'Files focused'],
      ['when:terminal-input', 'Terminal input focused'],
      ['when:terminal-selection', 'Terminal selection mode'],
      ['when:text-selected', 'Text selected']
    ]);
    expect(focusKeyTableLabel('when:text-selected')).toBe('Text selected');
    expect(focusKeyTableLabel('__proto__')).toBeUndefined();
    expect(isFocusKeyTable('when:agent')).toBe(true);
    expect(isFocusKeyTable('when:other')).toBe(false);
    expect(isKeyTableName('custom-table')).toBe(true);
    expect(isKeyTableName('when:browser')).toBe(true);
    expect(isKeyTableName('custom:table')).toBe(false);
  });

  it('accepts tables of bindings, canonicalizing their chords', () => {
    const keys = parseKeysConfig({
      root: { 'C-g': { table: 'git' } },
      prefix: { x: null, 'C-S-L': 'last-workspace' },
      git: { l: { terminal: 'lazygit', reuse: true }, d: { terminal: 'gh dash' } }
    });
    expect(keys).toEqual({
      root: { 'C-g': { table: 'git' } },
      prefix: { x: null, 'C-S-l': 'last-workspace' },
      git: { l: { terminal: 'lazygit', reuse: true }, d: { terminal: 'gh dash' } }
    });
  });

  it.each([
    ...['C-t', 'C-n', 'C-w', 'C-q', 'C-S-t', 'C-S-n', 'C-S-w'].map(chord => [chord, 'Firefox and Chromium both reserve it']),
    ...['C-Tab', 'C-S-Tab', 'C-PageUp', 'C-PageDown'].map(chord => [chord, 'never receives']),
    ['C-S-p', 'Firefox opens a private window'],
    ['C-S-u', 'IBus'],
    ['C-]', 'Chromium never delivers']
  ])('refuses the browser-reserved chord %s', (chord, reason) => {
    expect(() => parseKeysConfig({ prefix: { [chord]: 'next-panel' } })).toThrow(reason);
  });

  it('refuses a plain key in root but allows modifiers, function keys and removals there', () => {
    expect(() => parseKeysConfig({ root: { g: 'next-panel' } })).toThrow('keys.root.g');
    expect(() => parseKeysConfig({ root: { 'S-Left': 'next-panel' } })).toThrow('C-, M- or Super-');
    expect(parseKeysConfig({ root: { 'M-1': 'select-panel-1', F2: 'command-palette', 'S-F3': 'show-bindings', 'Super-k': 'next-panel', y: null } })).toEqual({ root: { 'M-1': 'select-panel-1', F2: 'command-palette', 'S-F3': 'show-bindings', 'Super-k': 'next-panel', y: null } });
  });

  it('applies direct-key safety to focus conditions while allowing their remaps', () => {
    expect(() => parseKeysConfig({ 'when:prompt': { k: 'clear-prompt' } })).toThrow('a focus binding needs C-, M- or Super-');
    expect(() => parseKeysConfig({ 'when:prompt': { 'S-Enter': 'clear-prompt' } })).toThrow('a focus binding needs C-, M- or Super-');
    expect(() => parseKeysConfig({ 'when:note-editor': { 'S-Enter': 'prompt-newline' } })).toThrow('a focus binding needs C-, M- or Super-');
    expect(parseKeysConfig({ 'when:prompt': { 'C-c': null, 'C-k': 'clear-prompt' }, 'when:terminal': { F2: 'command-palette' } })).toEqual({
      'when:prompt': { 'C-c': null, 'C-k': 'clear-prompt' },
      'when:terminal': { F2: 'command-palette' }
    });
    expect(parseKeysConfig({ 'when:prompt': { 'S-Enter': 'prompt-newline' } })).toEqual({ 'when:prompt': { 'S-Enter': 'prompt-newline' } });
  });

  it('refuses an unknown table, an unknown action and a malformed binding', () => {
    expect(() => parseKeysConfig({ root: { 'C-g': { table: 'git' } } })).toThrow('no table named git');
    expect(() => parseKeysConfig({ prefix: { r: { table: 'root' } } })).toThrow('root is always active');
    expect(() => parseKeysConfig({ prefix: { q: 'quit-everything' } })).toThrow('unknown action quit-everything');
    expect(() => parseKeysConfig({ prefix: { q: { terminal: '' } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'vim\nrm -rf ~' } } })).toThrow('newlines');
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'htop', reuse: 'yes' } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'htop', extra: 1 } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: 42 } })).toThrow();
    expect(() => parseKeysConfig({ 'Bad Name': {} })).toThrow('table name');
    expect(() => parseKeysConfig({ 'custom:table': {} })).toThrow('table name');
    expect(() => parseKeysConfig([])).toThrow();
  });

  it('selects focus tables automatically instead of allowing table switches into them', () => {
    expect(() => parseKeysConfig({ prefix: { p: { table: 'when:prompt' } } })).toThrow('when:prompt is selected automatically');
    expect(parseKeysConfig({ 'when:prompt': { 'C-g': { table: 'prefix' } } })).toEqual({ 'when:prompt': { 'C-g': { table: 'prefix' } } });
  });

  it('refuses two spellings of one chord in a table', () => {
    expect(() => parseKeysConfig({ prefix: { L: 'next-panel', 'S-l': 'previous-panel' } })).toThrow('twice');
  });

  it('reports every problem at once', () => {
    expect(() => parseKeysConfig({ root: { g: 'next-panel' }, prefix: { 'C-t': 'next-panel' } })).toThrow(/keys\.root\.g.*keys\.prefix\.C-t/su);
  });

  it('binds only actions it knows', () => {
    for (const table of Object.values(defaultKeyTables)) for (const binding of Object.values(table)) if (typeof binding === 'string') expect(keyActions).toHaveProperty(binding);
  });
});

describe('resolveKeyTables', () => {
  it('returns the defaults when nothing is configured', () => {
    const tables = resolveKeyTables(undefined);
    expect(tables.root!['C-b']).toEqual({ chord: 'C-b', binding: { table: 'prefix' }, source: 'default' });
    expect(tables.root!.y).toEqual({ chord: 'y', binding: 'copy-selection', source: 'default' });
    for (const chord of ['C-c', 'C-S-c', 'Super-c', 'C-Enter', 'S-Enter', 'C-S-Enter', 'Super-Enter', 'C-s', 'C-S-s', 'Super-s', 'S-Super-s']) expect(tables.root![chord]).toBeUndefined();
    expect(tables.prefix!.c).toEqual({ chord: 'c', binding: 'new-terminal', source: 'default' });
    expect(tables['when:prompt']!['C-c']).toEqual({ chord: 'C-c', binding: 'clear-prompt', source: 'default' });
    expect(tables['when:prompt']!['S-Enter']).toEqual({ chord: 'S-Enter', binding: 'prompt-newline', source: 'default' });
    expect(tables['when:prompt']!['Super-s']).toEqual({ chord: 'Super-s', binding: 'save-note', source: 'default' });
    expect(tables['when:text-selected']!['C-c']).toEqual({ chord: 'C-c', binding: 'copy-selection', source: 'default' });
    expect(tables['when:text-selected']!['C-S-c']).toEqual({ chord: 'C-S-c', binding: 'copy-selection', source: 'default' });
    expect(tables['when:terminal']).toEqual({});
  });

  it('describes every moved root default from the source used by scoped defaults', () => {
    expect(movedRootDefault('C-c')).toEqual({ table: 'when:text-selected', binding: 'copy-selection' });
    expect(movedRootDefault('S-Enter')).toEqual({ table: 'when:prompt', binding: 'prompt-newline' });
    expect(movedRootDefault('Super-s')).toEqual({ table: 'when:prompt', binding: 'save-note' });
    expect(movedRootDefault('y')).toBeUndefined();
    expect(movedRootDefault('__proto__')).toBeUndefined();
  });

  it.each([null, 'copy-selection', 'last-panel'])('lets a legacy root %s suppress its inherited scoped default', legacy => {
    const keys = parseKeysConfig({ root: { 'C-c': legacy } });
    const tables = resolveKeyTables(keys);

    expect(tables['when:text-selected']!['C-c']).toEqual({ chord: 'C-c', binding: 'copy-selection', source: 'removed' });
    if (legacy === null) expect(tables.root!['C-c']).toBeUndefined();
    else expect(tables.root!['C-c']).toEqual({ chord: 'C-c', binding: legacy, source: 'config' });
  });

  it('applies legacy suppression to prompt defaults moved from root', () => {
    const tables = resolveKeyTables(parseKeysConfig({ root: { 'S-Enter': null, 'C-s': 'save-note' } }));

    expect(tables['when:prompt']!['S-Enter']).toEqual({ chord: 'S-Enter', binding: 'prompt-newline', source: 'removed' });
    expect(tables['when:prompt']!['C-s']).toEqual({ chord: 'C-s', binding: 'save-note', source: 'removed' });
    expect(tables.root!['C-s']).toEqual({ chord: 'C-s', binding: 'save-note', source: 'config' });
  });

  it('lets an explicit scoped leaf win over a legacy root leaf and leaves aliases alone', () => {
    const tables = resolveKeyTables(parseKeysConfig({
      root: { 'C-c': null, 'C-Enter': 'last-panel', 'C-k': 'copy-selection' },
      'when:text-selected': { 'C-c': 'last-panel' },
      'when:prompt': { 'C-Enter': 'prompt-newline' }
    }));

    expect(tables['when:text-selected']!['C-c']).toEqual({ chord: 'C-c', binding: 'last-panel', source: 'replaced' });
    expect(tables['when:prompt']!['C-Enter']).toEqual({ chord: 'C-Enter', binding: 'prompt-newline', source: 'replaced' });
    expect(tables.root!['C-Enter']).toEqual({ chord: 'C-Enter', binding: 'last-panel', source: 'config' });
    expect(tables.root!['C-k']).toEqual({ chord: 'C-k', binding: 'copy-selection', source: 'config' });
  });

  it('merges config over the defaults per key, keeping removed defaults for the sheet', () => {
    const tables = resolveKeyTables(parseKeysConfig({ root: { 'C-a': { table: 'prefix' }, 'C-b': null }, prefix: { c: 'command-palette', q: 'show-bindings' }, git: { l: { terminal: 'lazygit' } } }));
    expect(tables.root!['C-b']).toEqual({ chord: 'C-b', binding: { table: 'prefix' }, source: 'removed' });
    expect(tables.root!['C-a']).toEqual({ chord: 'C-a', binding: { table: 'prefix' }, source: 'config' });
    expect(tables.prefix!.c).toEqual({ chord: 'c', binding: 'command-palette', source: 'replaced' });
    expect(tables.prefix!.q!.source).toBe('config');
    expect(tables.git!.l).toEqual({ chord: 'l', binding: { terminal: 'lazygit' }, source: 'config' });
  });

  it('ignores a removal of a key no default binds', () => {
    expect(resolveKeyTables(parseKeysConfig({ prefix: { q: null } })).prefix!.q).toBeUndefined();
  });
});

describe('browserKeysConfig', () => {
  it('reduces each terminal command to its program, past environment assignments, within the pane-name limit', () => {
    const keys = parseKeysConfig({ git: { d: { terminal: 'GH_TOKEN=ghp_secret GH_HOST=example.com /usr/bin/gh dash' }, e: { terminal: 'env TOKEN=x htop' }, l: { terminal: 'lazygit', reuse: true }, x: { terminal: `${'a'.repeat(200)} --flag` } }, prefix: { c: 'command-palette' } });
    expect(browserKeysConfig(keys)).toEqual({ git: { d: { terminal: 'gh' }, e: { terminal: 'htop' }, l: { terminal: 'lazygit', reuse: true }, x: { terminal: 'a'.repeat(120) } }, prefix: { c: 'command-palette' } });
    expect(JSON.stringify(browserKeysConfig(keys))).not.toContain('secret');
  });
});

describe('terminalBindingCommand', () => {
  it('resolves the command a terminal binding runs, from config or the defaults', () => {
    const keys = parseKeysConfig({ git: { d: { terminal: 'gh dash' } }, root: { 'C-g': { table: 'git' } } });
    expect(terminalBindingCommand(keys, 'git', 'd')).toEqual({ command: 'gh dash', reuse: false });
    expect(terminalBindingCommand(undefined, 'prefix', 'g')).toEqual({ command: 'lazygit', reuse: true });
  });

  it('resolves nothing for an action, a removed binding or an unknown key', () => {
    expect(terminalBindingCommand(undefined, 'prefix', 'c')).toBeUndefined();
    expect(terminalBindingCommand(parseKeysConfig({ prefix: { g: null } }), 'prefix', 'g')).toBeUndefined();
    expect(terminalBindingCommand(undefined, 'nope', 'x')).toBeUndefined();
    expect(terminalBindingCommand(undefined, '__proto__', 'x')).toBeUndefined();
  });
});

// keep screensaver entry in the same configurable key tables as other commands
describe('screensaver shortcut', () => {
  // preserve the requested default and allow ordinary removal and remapping
  it('registers ctrl+l and supports server key overrides', () => {
    expect(keyActions.screensaver?.description).toBe('Start screensaver');
    expect(defaultKeyTables.root?.['C-l']).toBe('screensaver');
    const keys = parseKeysConfig({ root: { 'C-l': null, 'C-F8': 'screensaver' } });
    const resolved = resolveKeyTables(keys);
    expect(resolved.root?.['C-l']?.source).toBe('removed');
    expect(resolved.root?.['C-F8']?.binding).toBe('screensaver');
  });
});
