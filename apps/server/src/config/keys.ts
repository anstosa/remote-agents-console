// The keyboard system's tables, chords and config validation, modelled on tmux key tables. The
// web app imports this file too (by relative path), so it stays free of Node and of any
// dependency: the server validates `keys` and resolves `{ terminal }` commands with it, and the
// browser merges the same defaults and names the chord each keydown makes.

// A binding runs a built-in action, switches to another table for one key, or opens a Terminal
// panel running a command from the server's config.
export type KeyBinding = string | { table: string } | { terminal: string; reuse?: boolean };
// The operator's `keys`: per table, chord to binding, with `null` removing a default.
export type KeysConfig = Record<string, Record<string, KeyBinding | null>>;
export type KeyBindingSource = 'default' | 'config' | 'replaced' | 'removed';
export type KeyRow = { chord: string; binding: KeyBinding; source: KeyBindingSource; conflicted?: boolean };
export type ResolvedKeyTables = Record<string, Record<string, KeyRow>>;
// The fields of a KeyboardEvent a chord is read from.
export const isTableBinding = (binding: KeyBinding | null | undefined): binding is { table: string } => binding != null && typeof binding === 'object' && 'table' in binding;
export const isTerminalBinding = (binding: KeyBinding | null | undefined): binding is { terminal: string; reuse?: boolean } => binding != null && typeof binding === 'object' && 'terminal' in binding;
export type ChordEvent = { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing?: boolean };

// Every built-in action, with the description the bindings sheet and the palette show.
// `repeat` actions stay live for a moment after they run, like tmux `bind -r`.
export const keyActions: Record<string, { description: string; repeat?: true }> = {
  'show-bindings': { description: 'Show key bindings' },
  'command-palette': { description: 'Command palette' },
  'new-terminal': { description: 'New Terminal panel' },
  'split-beside': { description: 'New Terminal beside the current panel' },
  'split-below': { description: 'New Terminal below the current panel' },
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`select-panel-${index + 1}`, { description: `Go to panel ${index + 1}` }])),
  'next-panel': { description: 'Next panel' },
  'previous-panel': { description: 'Previous panel' },
  'last-panel': { description: 'Last used panel' },
  'select-panel-left': { description: 'Panel to the left', repeat: true },
  'select-panel-right': { description: 'Panel to the right', repeat: true },
  'toggle-expand': { description: 'Expand or restore the current panel' },
  'toggle-code': { description: 'Open or close the Code panel' },
  'rename-panel': { description: 'Rename the current panel' },
  'close-panel': { description: 'Close the current panel' },
  'choose-tree': { description: 'Pick a Workspace or panel' },
  'choose-workspace': { description: 'Pick a Workspace' },
  'next-workspace': { description: 'Next Workspace' },
  'previous-workspace': { description: 'Previous Workspace' },
  'last-workspace': { description: 'Last used Workspace' },
  'rename-workspace': { description: 'Rename the current Workspace' },
  'close-workspace': { description: 'Turn off the current Workspace' },
  'font-larger': { description: 'Larger terminal font' },
  'font-smaller': { description: 'Smaller terminal font' },
  'font-reset': { description: 'Reset terminal font size' },
  'copy-selection': { description: 'Copy the selected output' },
  'save-note': { description: 'Save the prompt draft as a Note' },
  'prompt-newline': { description: 'Insert a newline in the prompt' }
};

// The built-in tables, in canonical chords. `root` is always active; `C-b` enters `prefix`.
// Today's handlers accept Cmd as well as Ctrl, so those bindings come in both forms.
export const defaultKeyTables: Record<string, Record<string, KeyBinding>> = {
  root: {
    'C-b': { table: 'prefix' },
    'C-?': 'show-bindings',
    'S-Left': 'previous-workspace',
    'S-Right': 'next-workspace',
    'C-=': 'font-larger', 'C-+': 'font-larger', 'Super-=': 'font-larger', 'Super-+': 'font-larger',
    'C--': 'font-smaller', 'Super--': 'font-smaller',
    'C-0': 'font-reset', 'Super-0': 'font-reset',
    'C-S-c': 'copy-selection', y: 'copy-selection', 'C-c': 'copy-selection', 'Super-c': 'copy-selection',
    // prompt handlers decline these keys outside the composer
    'C-Enter': 'prompt-newline', 'S-Enter': 'prompt-newline', 'C-S-Enter': 'prompt-newline', 'Super-Enter': 'prompt-newline',
    'C-s': 'save-note', 'C-S-s': 'save-note', 'Super-s': 'save-note', 'S-Super-s': 'save-note'
  },
  prefix: {
    c: 'new-terminal',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String((index + 1) % 10), `select-panel-${index + 1}`])),
    n: 'next-panel', p: 'previous-panel', l: 'last-panel', o: 'next-panel',
    Left: 'select-panel-left', Right: 'select-panel-right',
    w: 'choose-tree', s: 'choose-workspace',
    '(': 'previous-workspace', ')': 'next-workspace', 'S-l': 'last-workspace',
    '%': 'split-beside', '"': 'split-below',
    z: 'toggle-expand',
    ',': 'rename-panel', $: 'rename-workspace',
    x: 'close-panel', '&': 'close-panel', 'S-x': 'close-workspace',
    g: { terminal: 'lazygit', reuse: true },
    ':': 'command-palette',
    '?': 'show-bindings'
  }
};

// Chords a browser keeps for itself or never delivers, from the chord probe in Firefox 155 and
// Chromium 152 on Linux (2026-10-09). Binding one would never fire, or would fire and also act.
const bothReserve = 'Firefox and Chromium both reserve it';
const neverDelivered = 'Firefox and Chromium both reserve it; the page never receives it';
const forbiddenChords: Record<string, string> = {
  'C-t': bothReserve, 'C-n': bothReserve, 'C-w': bothReserve, 'C-q': bothReserve, 'C-S-t': bothReserve, 'C-S-n': bothReserve, 'C-S-w': bothReserve,
  'C-Tab': neverDelivered, 'C-S-Tab': neverDelivered, 'C-PageUp': neverDelivered, 'C-PageDown': neverDelivered,
  'C-S-p': 'Firefox opens a private window even when the page prevents it',
  'C-S-u': 'IBus starts Unicode entry in every text field, even though the page gets the key',
  'C-]': 'Chromium never delivers it'
};

const namedKeys = ['Left', 'Right', 'Up', 'Down', 'Space', 'Tab', 'Enter', 'Escape', 'BSpace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
const namedKeysByLowerCase = new Map(namedKeys.map(name => [name.toLowerCase(), name] as const));
// KeyboardEvent.key values that differ from their tmux names
const eventKeyNames: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Backspace: 'BSpace', Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const functionKey = /^F([1-9]|1[0-2])$/u;
const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const asciiLetter = /^[a-z]$/iu;

type Modifiers = { ctrl: boolean; alt: boolean; shift: boolean; super: boolean };
// A letter carries Shift as `S-`; every other character already says it (`%`, `?`), so Shift is
// dropped from it; a named key keeps it (`S-Left`).
const canonical = (key: string, modifiers: Modifiers, named = false): string => {
  const letter = asciiLetter.test(key);
  const shift = letter ? modifiers.shift || key !== key.toLowerCase() : named && modifiers.shift;
  return `${modifiers.ctrl ? 'C-' : ''}${modifiers.alt ? 'M-' : ''}${shift ? 'S-' : ''}${modifiers.super ? 'Super-' : ''}${letter ? key.toLowerCase() : key}`;
};

// Parse a tmux-style chord (`C-b`, `M-Space`, `Super-=`, `%`) to its canonical spelling.
export function parseChord(text: string): string {
  const modifiers: Modifiers = { ctrl: false, alt: false, shift: false, super: false };
  let rest = text;
  for (;;) {
    const match = /^(C|M|S|Super)-(.+)$/iu.exec(rest);
    if (match === null) break;
    const name = ({ c: 'ctrl', m: 'alt', s: 'shift', super: 'super' } as const)[match[1]!.toLowerCase() as 'c' | 'm' | 's' | 'super'];
    if (modifiers[name]) throw new Error(`${text} repeats ${match[1]}-`);
    modifiers[name] = true;
    rest = match[2]!;
  }
  if (rest === '') throw new Error('a chord needs a key');
  const named = namedKeysByLowerCase.get(rest.toLowerCase());
  if (named !== undefined && rest.length > 1) return canonical(named, modifiers, true);
  if (Array.from(rest).length !== 1 || /\s/u.test(rest)) throw new Error(`${text} is not a key`);
  return canonical(rest, modifiers);
}

// The canonical chord a keydown makes, or undefined for a bare modifier, a dead key or an IME
// composition, which never match a binding.
export function eventChord(event: ChordEvent): string | undefined {
  if (event.isComposing === true) return undefined;
  const modifiers: Modifiers = { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, super: event.metaKey };
  const named = hasOwn(eventKeyNames, event.key) ? eventKeyNames[event.key]! : functionKey.test(event.key) ? event.key : undefined;
  if (named !== undefined) return canonical(named, modifiers, true);
  if (Array.from(event.key).length !== 1) return undefined;
  let key = event.key;
  // macOS Option rewrites letters and digits (Option-a is å), so M- reads the physical key
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/u.exec(event.code);
  if (event.altKey && physical !== null) key = (physical[1] ?? physical[2]!).toLowerCase();
  // Caps Lock uppercases a letter without Shift; only Shift itself makes `S-`
  if (asciiLetter.test(key)) key = key.toLowerCase();
  return canonical(key, modifiers);
}

const tableName = /^[a-z][a-z0-9-]{0,31}$/u;
const maxTables = 32;
const maxBindingsPerTable = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// check one binding value, returning it or the reason it is invalid
const parseBinding = (value: unknown): KeyBinding | null | string[] => {
  if (value === null) return null;
  if (typeof value === 'string') return hasOwn(keyActions, value) ? value : [`unknown action ${value}`];
  if (!isRecord(value)) return ['a binding is an action name, { table }, { terminal } or null'];
  const fields = Object.keys(value);
  if (hasOwn(value, 'table')) {
    if (fields.length !== 1 || typeof value.table !== 'string') return ['{ table } takes only a table name'];
    return { table: value.table };
  }
  if (hasOwn(value, 'terminal')) {
    if (fields.some(field => field !== 'terminal' && field !== 'reuse')) return ['{ terminal } takes only terminal and reuse'];
    const command = typeof value.terminal === 'string' ? value.terminal.trim() : '';
    if (command === '' || command.length > 4096) return ['terminal needs a command of 1 to 4096 characters'];
    if (/[\0\r\n]/u.test(command)) return ['terminal commands forbid NUL and newlines'];
    if (value.reuse !== undefined && typeof value.reuse !== 'boolean') return ['reuse must be true or false'];
    return value.reuse === undefined ? { terminal: command } : { terminal: command, reuse: value.reuse };
  }
  return ['a binding is an action name, { table }, { terminal } or null'];
};

// Validate the operator's `keys` and return it with canonical chords, or throw one error naming
// every problem (`keys.<table>.<chord>: reason`).
export function parseKeysConfig(input: unknown): KeysConfig {
  if (!isRecord(input)) throw new Error('keys must be an object of tables');
  const errors: string[] = [];
  const keys: KeysConfig = {};
  const names = Object.keys(input);
  if (names.length > maxTables) errors.push(`keys: at most ${maxTables} tables`);
  for (const name of names) {
    const table = input[name];
    if (!tableName.test(name)) { errors.push(`keys.${name}: a table name is lowercase letters, digits and dashes`); continue; }
    if (!isRecord(table)) { errors.push(`keys.${name}: a table is an object of chord to binding`); continue; }
    if (Object.keys(table).length > maxBindingsPerTable) errors.push(`keys.${name}: at most ${maxBindingsPerTable} bindings`);
    const parsed: Record<string, KeyBinding | null> = {};
    for (const [chordText, value] of Object.entries(table)) {
      const where = `keys.${name}.${chordText}`;
      let chord: string;
      try { chord = parseChord(chordText); }
      catch (error) { errors.push(`${where}: ${(error as Error).message}`); continue; }
      if (hasOwn(forbiddenChords, chord)) { errors.push(`${where}: ${forbiddenChords[chord]}`); continue; }
      if (hasOwn(parsed, chord)) { errors.push(`${where}: binds ${chord} twice`); continue; }
      const binding = parseBinding(value);
      if (Array.isArray(binding)) { errors.push(...binding.map(reason => `${where}: ${reason}`)); continue; }
      // a root binding fires on every keystroke, so it must not steal ordinary typing
      if (name === 'root' && binding !== null && !/^(?:C-|M-|(?:S-)?Super-)|^(?:S-)?F\d+$/u.test(chord)) {
        errors.push(`${where}: a root binding needs C-, M- or Super-, or a function key, so it cannot steal typing`);
        continue;
      }
      parsed[chord] = binding;
    }
    keys[name] = parsed;
  }
  const tables = new Set([...Object.keys(defaultKeyTables), ...Object.keys(keys)]);
  for (const [name, table] of Object.entries(keys)) for (const [chord, binding] of Object.entries(table)) {
    if (!isTableBinding(binding)) continue;
    if (binding.table === 'root') errors.push(`keys.${name}.${chord}: root is always active; switch to another table`);
    else if (!tables.has(binding.table)) errors.push(`keys.${name}.${chord}: there is no table named ${binding.table}`);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return keys;
}

// Merge the operator's tables over the defaults per key. A default replaced by config is
// `replaced`; one removed with `null` stays, as `removed`, so the bindings sheet can strike it.
export function resolveKeyTables(keys: KeysConfig | undefined): ResolvedKeyTables {
  const resolved: ResolvedKeyTables = {};
  for (const name of new Set([...Object.keys(defaultKeyTables), ...Object.keys(keys ?? {})])) {
    const defaults = hasOwn(defaultKeyTables, name) ? defaultKeyTables[name]! : {};
    const overrides = keys !== undefined && hasOwn(keys, name) ? keys[name]! : {};
    const rows: Record<string, KeyRow> = {};
    for (const [chord, binding] of Object.entries(defaults)) {
      if (!hasOwn(overrides, chord)) rows[chord] = { chord, binding, source: 'default' };
      else if (overrides[chord] === null) rows[chord] = { chord, binding, source: 'removed' };
      else rows[chord] = { chord, binding: overrides[chord]!, source: 'replaced' };
    }
    for (const [chord, binding] of Object.entries(overrides)) if (binding !== null && !hasOwn(rows, chord)) rows[chord] = { chord, binding, source: 'config' };
    resolved[name] = rows;
  }
  return resolved;
}

// The live binding for a chord in a table, skipping removed and ambiguous rows.
export function lookupKeyBinding(tables: ResolvedKeyTables, table: string, chord: string): KeyBinding | undefined {
  if (!hasOwn(tables, table) || !hasOwn(tables[table]!, chord)) return undefined;
  const row = tables[table]![chord]!;
  return row.source === 'removed' || row.conflicted === true ? undefined : row.binding;
}

// The command a `{ terminal }` binding runs, looked up in the server's own config so a browser
// only ever names the binding (table and chord), never the command.
export function terminalBindingCommand(keys: KeysConfig | undefined, table: string, chord: string): { command: string; reuse: boolean } | undefined {
  const binding = lookupKeyBinding(resolveKeyTables(keys), table, chord);
  if (!isTerminalBinding(binding)) return undefined;
  return { command: binding.terminal, reuse: binding.reuse === true };
}

// The name a binding's Terminal goes by: its program's basename (`/usr/bin/gh dash` is `gh`), past
// any `env` and `VAR=value` assignments, which may hold secrets, within the pane-name limit.
export const terminalProgramName = (command: string): string => {
  const words = command.trim().split(/\s+/u);
  const program = words.find((word, index) => !(index === 0 && word === 'env') && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) ?? 'terminal';
  return (program.split('/').pop() || 'terminal').slice(0, 120);
};

// The operator's tables as the browser receives them: each terminal command reduced to its
// program name, which the bindings sheet shows, so no command line leaves the server.
export function browserKeysConfig(keys: KeysConfig): KeysConfig {
  return Object.fromEntries(Object.entries(keys).map(([name, table]) => [name, Object.fromEntries(Object.entries(table).map(([chord, binding]) =>
    [chord, isTerminalBinding(binding) ? { ...binding, terminal: terminalProgramName(binding.terminal) } : binding]))]));
}
