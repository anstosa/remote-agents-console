import { defaultKeyTables, isTableBinding, parseChord, parseKeysConfig, resolveKeyTables, type KeyBinding, type KeyRow, type KeysConfig, type ResolvedKeyTables } from '../../server/src/config/keys.js';
import type { SettingsPatch } from './settings/contracts.js';

// browser-local choices are keyed by the server binding's stable original identity
export type ShortcutAlias = string | { table: string; chord: string };
export type ShortcutOverrides = Record<string, Record<string, ShortcutAlias[] | null>>;
export type ShortcutOrigin = { table: string; chord: string };
export type ShortcutCommand = {
  id: string;
  binding: KeyBinding;
  origins: Array<{ table: string; chord: string; source: KeyRow['source'] }>;
  shortcuts: Array<{ table: string; chord: string; originTable: string; original: string; source: KeyRow['source']; conflicted: boolean }>;
  unavailable: boolean;
  customized: boolean;
};
export type ShortcutEdit =
  | { kind: 'reset' }
  | { kind: 'disable' }
  | { kind: 'add'; table: string; chord: string }
  | { kind: 'replace'; fromTable: string; from: string; table: string; chord: string }
  | { kind: 'remove'; table: string; from: string };

export type ServerShortcutCommand = ShortcutCommand & { protected: boolean };
export type ServerShortcutModel = {
  commands: ServerShortcutCommand[];
  hasConfig: boolean;
  tables: ResolvedKeyTables;
  error?: string;
};
export type ServerKeyTableRow = { chord: string; rawChord: string; binding: KeyBinding | null; source: KeyRow['source']; configured: boolean; builtInDefault: boolean; protected: boolean };
export type ServerKeyTable = { name: string; builtIn: boolean; configured: boolean; rows: ServerKeyTableRow[]; inbound: Array<{ table: string; chord: string; rawChord: string }> };
export type ServerKeyTableModel = { tables: ServerKeyTable[]; hasConfig: boolean; error?: string };
export type ServerKeyTableEdit =
  | { kind: 'create-table'; name: string }
  | { kind: 'rename-table'; from: string; to: string }
  | { kind: 'remove-table'; name: string }
  | { kind: 'create-binding'; table: string; chord: string; binding: KeyBinding | null }
  | { kind: 'set-binding'; table: string; chord: string; binding: KeyBinding }
  | { kind: 'rename-binding'; table: string; from: string; to: string }
  | { kind: 'remove-binding'; table: string; chord: string; mode: 'disable' | 'restore' };

const tableName = /^[a-z][a-z0-9-]{0,31}$/u;
const maxTables = 32;
const maxBindingsPerTable = 200;
const maxAliasesPerBinding = 20;
const reservedSettingsPathParts = new Set(['__proto__', 'prototype', 'constructor']);
// reject table names the settings patch path cannot address
const reservedTableError = (name: string): string | undefined => reservedSettingsPathParts.has(name) ? 'That table name is reserved by the settings editor.' : undefined;
const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// recognize a value redacted by the settings service
const isProtectedValue = (value: unknown): boolean => isRecord(value) && value.__racProtected === true && typeof value.present === 'boolean';

type EffectiveAssignment = { table: string; chord: string; originTable: string; original: string; row: KeyRow; commandId: string };

// identify globally shared commands while keeping redacted terminal rows distinct
const commandId = (binding: KeyBinding, table: string, original: string): string => typeof binding === 'string'
  ? `action:${binding}`
  : 'table' in binding ? `table:${binding.table}` : `terminal:${table}:${original}`;

// copy a row before changing its effective chord
const copyRow = (row: KeyRow, chord = row.chord, conflicted = row.conflicted === true): KeyRow => ({
  chord,
  binding: typeof row.binding === 'string' ? row.binding : { ...row.binding },
  source: row.source,
  ...(conflicted ? { conflicted: true } : {})
});

// normalize a stored alias to its effective table and chord
const aliasDestination = (originTable: string, alias: ShortcutAlias): ShortcutOrigin => typeof alias === 'string' ? { table: originTable, chord: alias } : alias;

// use the compact string form for aliases that stay in their origin table
const storedAlias = (originTable: string, destination: ShortcutOrigin): ShortcutAlias => destination.table === originTable ? destination.chord : { ...destination };

// identify one effective destination independently of its storage representation
const aliasKey = (originTable: string, alias: ShortcutAlias): string => {
  const destination = aliasDestination(originTable, alias);
  return `${destination.table}\0${destination.chord}`;
};

// read one active row's current destinations
const effectiveAliases = (originTable: string, rows: Record<string, KeyRow>, choices: Record<string, ShortcutAlias[] | null> | undefined, original: string): ShortcutOrigin[] => {
  const row = rows[original]!;
  // operator removals stay authoritative
  if (row.source === 'removed') return [];
  // inherit the current server chord without a browser choice
  if (choices === undefined || !hasOwn(choices, original)) return [{ table: originTable, chord: original }];
  return (choices[original] ?? []).map(alias => aliasDestination(originTable, alias));
};

// enumerate assignments once so conflict, display and dispatch use identical semantics
const effectiveAssignments = (base: ResolvedKeyTables, overrides: ShortcutOverrides): EffectiveAssignment[] => {
  const assignments: EffectiveAssignment[] = [];
  const seen = new Set<string>();
  // retain server order for commands and aliases
  for (const [originTable, rows] of Object.entries(base)) {
    const choices = overrides[originTable];
    // expand every active origin to all of its browser aliases
    for (const [original, row] of Object.entries(rows)) {
      const identity = commandId(row.binding, originTable, original);
      for (const destination of effectiveAliases(originTable, rows, choices, original)) {
        const key = `${destination.table}\0${destination.chord}\0${identity}`;
        // identical aliases for one command are one effective shortcut
        if (seen.has(key)) continue;
        seen.add(key);
        assignments.push({ table: destination.table, chord: destination.chord, originTable, original, row, commandId: identity });
      }
    }
  }
  return assignments;
};

// map every ambiguous destination to all commands occupying it
const conflictDestinations = (assignments: EffectiveAssignment[]): Set<string> => {
  const occupants = new Map<string, Set<string>>();
  // collect unique commands because duplicate origins for one command are harmless
  for (const assignment of assignments) {
    const destination = `${assignment.table}.${assignment.chord}`;
    const commands = occupants.get(destination) ?? new Set<string>();
    commands.add(assignment.commandId);
    occupants.set(destination, commands);
  }
  return new Set([...occupants].filter(([, commands]) => commands.size > 1).map(([destination]) => destination));
};

// remove stale choices while preserving collisions for the user to resolve
export function reconcileShortcutOverrides(base: ResolvedKeyTables, overrides: ShortcutOverrides): { overrides: ShortcutOverrides; conflicts: string[] } {
  const safe = validateShortcutOverrides(overrides);
  const reconciled: ShortcutOverrides = {};
  // retain only active binding identities still supplied by the server
  for (const [table, choices] of Object.entries(safe)) {
    const rows = base[table];
    // drop a table removed by a server update
    if (rows === undefined) continue;
    const retained: Record<string, ShortcutAlias[] | null> = {};
    // discard unknown and operator-removed identities
    for (const [original, destinations] of Object.entries(choices)) {
      if (rows[original]?.source === undefined || rows[original]!.source === 'removed') continue;
      // drop destinations whose table no longer exists and inherit when none survive
      if (destinations === null) retained[original] = null;
      else {
        const available = destinations.filter(alias => base[aliasDestination(table, alias).table] !== undefined);
        if (available.length > 0) retained[original] = available;
      }
    }
    // omit tables with no live choices
    if (Object.keys(retained).length > 0) reconciled[table] = retained;
  }
  const assignments = effectiveAssignments(base, reconciled);
  return { overrides: reconciled, conflicts: [...conflictDestinations(assignments)] };
}

// apply browser-local destinations without changing stable server binding identities
export function resolveShortcutTables(base: ResolvedKeyTables, overrides: ShortcutOverrides): ResolvedKeyTables {
  const choicesByTable = reconcileShortcutOverrides(base, overrides).overrides;
  const assignments = effectiveAssignments(base, choicesByTable);
  const conflicts = conflictDestinations(assignments);
  const resolved: ResolvedKeyTables = {};
  // retain the server's table order
  for (const [table, rows] of Object.entries(base)) {
    const effective: Record<string, KeyRow> = {};
    // keep operator removal placeholders visible until an active alias occupies them
    for (const [original, row] of Object.entries(rows)) if (row.source === 'removed') effective[original] = copyRow(row);
    // add active assignments after placeholders so aliases can occupy a removed chord
    for (const assignment of assignments) {
      if (assignment.table !== table) continue;
      effective[assignment.chord] = copyRow(assignment.row, assignment.chord, conflicts.has(`${table}.${assignment.chord}`));
    }
    resolved[table] = effective;
  }
  return resolved;
}

// consolidate repeated defaults and aliases into commands for the reference and editor
export function shortcutCommands(base: ResolvedKeyTables, overrides: ShortcutOverrides): ShortcutCommand[] {
  const choicesByTable = reconcileShortcutOverrides(base, overrides).overrides;
  const assignments = effectiveAssignments(base, choicesByTable);
  const conflicts = conflictDestinations(assignments);
  const commands = new Map<string, ShortcutCommand>();
  // establish command order and preserve every server origin, removed rows included
  for (const [table, rows] of Object.entries(base)) for (const [original, row] of Object.entries(rows)) {
    const id = commandId(row.binding, table, original);
    const command = commands.get(id) ?? { id, binding: copyRow(row).binding, origins: [], shortcuts: [], unavailable: true, customized: false };
    command.origins.push({ table, chord: original, source: row.source });
    command.customized ||= choicesByTable[table] !== undefined && hasOwn(choicesByTable[table]!, original);
    commands.set(id, command);
  }
  // attach each deduplicated effective assignment to its command
  for (const assignment of assignments) {
    const command = commands.get(assignment.commandId)!;
    command.shortcuts.push({
      table: assignment.table,
      chord: assignment.chord,
      originTable: assignment.originTable,
      original: assignment.original,
      source: assignment.row.source,
      conflicted: conflicts.has(`${assignment.table}.${assignment.chord}`)
    });
  }
  // only operator removal blocks editing; browser-disabled commands remain restorable
  for (const command of commands.values()) command.unavailable = command.origins.every(origin => origin.source === 'removed');
  return [...commands.values()];
}

// recover the stable server identity behind an effective browser chord
export function shortcutOrigin(base: ResolvedKeyTables, overrides: ShortcutOverrides, table: string, chord: string): ShortcutOrigin {
  const choices = reconcileShortcutOverrides(base, overrides).overrides;
  const assignment = effectiveAssignments(base, choices).find(candidate => candidate.table === table && candidate.chord === chord);
  // leave unknown destinations addressed as received
  return assignment === undefined ? { table, chord } : { table: assignment.originTable, chord: assignment.original };
}

// validate one recorded destination through the shared browser and root-key rules
export function shortcutValidationError(table: string, chord: string, originalChord: string, originTable = table): string | undefined {
  // an empty recorder value means inherit the original
  if (chord === '') return undefined;
  // only a true root origin may retain its own legacy typing key
  if (table === 'root' && originTable === 'root' && chord === originalChord && hasOwn(defaultKeyTables.root!, chord)) return undefined;
  try {
    parseKeysConfig({ [table]: { [chord]: 'show-bindings' } });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid shortcut';
  }
}

// validate and deduplicate one stored alias list
const validatedAliases = (value: unknown, originTable: string, original: string): ShortcutAlias[] | null | undefined => {
  // explicit null and empty arrays both disable the command origin
  if (value === null || Array.isArray(value) && value.length === 0) return null;
  const stored = typeof value === 'string' ? [value] : Array.isArray(value) ? value.slice(0, maxAliasesPerBinding) : undefined;
  if (stored === undefined) return undefined;
  const aliases: ShortcutAlias[] = [];
  const destinations = new Set<string>();
  // discard malformed aliases without losing other valid assignments
  for (const alias of stored) {
    const destination = typeof alias === 'string'
      ? { table: originTable, chord: alias }
      : isRecord(alias) && Object.keys(alias).every(field => field === 'table' || field === 'chord') && typeof alias.table === 'string' && typeof alias.chord === 'string'
        ? { table: alias.table, chord: alias.chord }
        : undefined;
    if (destination === undefined || !tableName.test(destination.table)) continue;
    let canonical: string;
    try { canonical = parseChord(destination.chord); }
    catch { continue; }
    const key = `${destination.table}\0${destination.chord}`;
    if (canonical !== destination.chord || shortcutValidationError(destination.table, destination.chord, original, originTable) !== undefined || destinations.has(key)) continue;
    destinations.add(key);
    aliases.push(storedAlias(originTable, destination));
  }
  return aliases.length > 0 ? aliases : undefined;
};

// parse an untrusted stored object into bounded, canonical, safe choices
export function validateShortcutOverrides(input: unknown): ShortcutOverrides {
  const validated: ShortcutOverrides = {};
  // reject a non-object preference as empty
  if (!isRecord(input)) return validated;
  // bound the number of stored tables inspected
  for (const table of Object.keys(input).slice(0, maxTables)) {
    const storedRows = input[table];
    // ignore malformed table names and values
    if (!tableName.test(table) || !isRecord(storedRows)) continue;
    const rows: Record<string, ShortcutAlias[] | null> = {};
    // bound the number of stored bindings inspected per table
    for (const [original, value] of Object.entries(storedRows).slice(0, maxBindingsPerTable)) {
      let canonicalOriginal: string;
      try { canonicalOriginal = parseChord(original); }
      catch { continue; }
      // stable identities must use their canonical spelling
      if (canonicalOriginal !== original) continue;
      const aliases = validatedAliases(value, table, original);
      if (aliases !== undefined) rows[original] = aliases;
    }
    // omit empty tables from the normalized preference
    if (Object.keys(rows).length > 0) validated[table] = rows;
  }
  return validated;
}

// edit one consolidated command without weakening its stable server authorization identity
export function editShortcutOverrides(base: ResolvedKeyTables, overrides: ShortcutOverrides, id: string, edit: ShortcutEdit): { overrides?: ShortcutOverrides; error?: string } {
  const current = reconcileShortcutOverrides(base, overrides).overrides;
  const command = shortcutCommands(base, current).find(candidate => candidate.id === id);
  // refuse stale or server-disabled commands
  if (command === undefined) return { error: 'This command is no longer available. Reopen the quick reference.' };
  if (command.unavailable && edit.kind !== 'reset') return { error: 'This command is disabled by the server.' };
  const next: ShortcutOverrides = Object.fromEntries(Object.entries(current).map(([table, choices]) => [table, Object.fromEntries(Object.entries(choices).map(([original, aliases]) => [original, aliases?.map(alias => typeof alias === 'string' ? alias : { ...alias }) ?? null]))]));
  // read an origin's effective aliases from the pending transaction
  const valuesFor = (originTable: string, original: string): ShortcutAlias[] => next[originTable]?.[original] === null
    ? []
    : next[originTable]?.[original]?.map(alias => typeof alias === 'string' ? alias : { ...alias }) ?? [original];
  // preserve inheritance and canonicalize duplicate destinations on every write
  const write = (originTable: string, original: string, values: ShortcutAlias[] | undefined) => {
    next[originTable] ??= {};
    if (values === undefined) delete next[originTable]![original];
    else {
      const seen = new Set<string>();
      const unique = values.filter(alias => {
        const key = aliasKey(originTable, alias);
        // keep only the first owner within this stable origin
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(alias => storedAlias(originTable, aliasDestination(originTable, alias)));
      // an unchanged same-table original should follow future server defaults
      if (unique.length === 1 && typeof unique[0] === 'string' && unique[0] === original) delete next[originTable]![original];
      else next[originTable]![original] = unique.length === 0 ? null : unique;
    }
    // keep storage free of empty tables
    if (Object.keys(next[originTable]!).length === 0) delete next[originTable];
  };
  // disabling and resetting cover every duplicate origin of this command
  if (edit.kind === 'reset' || edit.kind === 'disable') {
    for (const origin of command.origins) {
      // never re-enable an operator-removed assignment
      if (origin.source === 'removed' && edit.kind !== 'reset') continue;
      write(origin.table, origin.chord, edit.kind === 'reset' ? undefined : []);
    }
    return { overrides: reconcileShortcutOverrides(base, next).overrides };
  }
  const sourceTable = edit.kind === 'replace' ? edit.fromTable : edit.table;
  // a removed or changed alias cannot silently turn into a new assignment
  if ((edit.kind === 'replace' || edit.kind === 'remove') && !command.shortcuts.some(shortcut => shortcut.table === sourceTable && shortcut.chord === edit.from)) return { error: 'This shortcut changed. Try again with its current assignment.' };
  // only tables present in the operator's resolved configuration are valid destinations
  if ((edit.kind === 'add' || edit.kind === 'replace') && base[edit.table] === undefined) return { error: 'This key table is no longer available.' };
  const origins = command.origins.filter(origin => origin.source !== 'removed');
  let destination: (typeof origins)[number] | undefined;
  // select a stable authorized origin while validating the effective destination
  if (edit.kind === 'add' || edit.kind === 'replace') {
    const previous = edit.kind === 'replace' ? command.shortcuts.find(shortcut => shortcut.table === edit.fromTable && shortcut.chord === edit.from) : undefined;
    const preferred = previous === undefined ? undefined : origins.find(origin => origin.table === previous.originTable && origin.chord === previous.original);
    const candidates = [preferred, ...origins.filter(origin => origin.table === edit.table), ...origins].filter((origin, index, all): origin is (typeof origins)[number] => origin !== undefined && all.indexOf(origin) === index);
    destination = candidates.find(origin => shortcutValidationError(edit.table, edit.chord, origin.chord, origin.table) === undefined);
    // browser-reserved and unsafe typing chords still cannot be assigned
    if (destination === undefined) return { error: shortcutValidationError(edit.table, edit.chord, origins[0]?.chord ?? edit.chord, origins[0]?.table ?? edit.table) ?? 'Invalid shortcut' };
  }
  // remove all duplicate owners of one visible destination before replacing or deleting it
  if (edit.kind === 'replace' || edit.kind === 'remove') {
    for (const origin of origins) write(origin.table, origin.chord, valuesFor(origin.table, origin.chord).filter(alias => {
      const effective = aliasDestination(origin.table, alias);
      return effective.table !== sourceTable || effective.chord !== edit.from;
    }));
  }
  // assigning an existing destination to one command is a no-op rather than a duplicate
  if (edit.kind === 'add' || edit.kind === 'replace') {
    const alreadyAssigned = origins.some(origin => valuesFor(origin.table, origin.chord).some(alias => {
      const effective = aliasDestination(origin.table, alias);
      return effective.table === edit.table && effective.chord === edit.chord;
    }));
    if (!alreadyAssigned) {
      const values = [...valuesFor(destination!.table, destination!.chord), storedAlias(destination!.table, { table: edit.table, chord: edit.chord })];
      // match the bounded preference validator instead of silently dropping saved keys
      if (values.length > maxAliasesPerBinding) return { error: `This assignment supports at most ${maxAliasesPerBinding} shortcuts. Remove one before adding another.` };
      write(destination!.table, destination!.chord, values);
    }
  }
  return { overrides: reconcileShortcutOverrides(base, next).overrides };
}

type ParsedServerShortcuts = {
  keys: Record<string, Record<string, KeyBinding | null>>;
  protectedBindings: Set<string>;
  rawBindings: Map<string, KeyBinding | null>;
  rawChords: Map<string, string>;
  error?: string;
};

// identify a command without serializing its binding
const serverCommandId = (binding: KeyBinding, table: string, chord: string): string => typeof binding === 'string'
  ? `action:${binding}`
  : isRecord(binding) && 'table' in binding ? `table:${binding.table}` : `terminal:${table}:${chord}`;

// retain safe bindings while substituting a display-only terminal for masked commands
const parseServerShortcuts = (input: unknown): ParsedServerShortcuts => {
  // an absent keys object means the built-in defaults
  if (input === undefined) return { keys: {}, protectedBindings: new Set(), rawBindings: new Map(), rawChords: new Map() };
  // keep malformed source values visible as an editor error
  if (!isRecord(input)) return { keys: {}, protectedBindings: new Set(), rawBindings: new Map(), rawChords: new Map(), error: 'Keyboard shortcuts must be an object of key tables.' };
  const candidate = Object.create(null) as Record<string, unknown>;
  const protectedBindings = new Set<string>();
  const rawBindings = new Map<string, KeyBinding | null>();
  const rawChords = new Map<string, string>();
  // replace only masked terminal commands in the validation copy
  for (const [table, rows] of Object.entries(input)) {
    // let shared config validation report malformed tables
    if (!isRecord(rows)) {
      candidate[table] = rows;
      continue;
    }
    const candidateRows = Object.create(null) as Record<string, unknown>;
    candidate[table] = candidateRows;
    // retain every safe leaf exactly
    for (const [chord, binding] of Object.entries(rows)) {
      let canonicalChord: string | undefined;
      try { canonicalChord = parseChord(chord); } catch { /* shared validation reports invalid chords */ }
      // preserve exact existing property and safe binding bytes for compiled patches
      if (canonicalChord !== undefined) rawChords.set(`${table}\0${canonicalChord}`, chord);
      // protected terminal commands cannot be copied into a recorder patch
      if (isRecord(binding) && isProtectedValue(binding.terminal)) {
        candidateRows[chord] = { ...binding, terminal: 'protected-terminal' };
        if (canonicalChord !== undefined) protectedBindings.add(`${table}\0${canonicalChord}`);
        continue;
      }
      candidateRows[chord] = binding;
      // validation below proves this stored value is a binding
      if (canonicalChord !== undefined) rawBindings.set(`${table}\0${canonicalChord}`, binding as KeyBinding | null);
    }
  }
  try {
    return { keys: parseKeysConfig(candidate), protectedBindings, rawBindings, rawChords };
  } catch (error) {
    return { keys: {}, protectedBindings, rawBindings, rawChords, error: error instanceof Error ? error.message : 'Keyboard shortcuts are invalid.' };
  }
};

// expose the resolved server configuration without activating an unsaved draft
export function serverShortcutModel(input: unknown): ServerShortcutModel {
  const parsed = parseServerShortcuts(input);
  const tables = resolveKeyTables(parsed.keys);
  const commands = shortcutCommands(tables, {}).map(command => ({
    ...command,
    customized: command.origins.some(origin => origin.source !== 'default'),
    unavailable: false,
    protected: command.origins.some(origin => parsed.protectedBindings.has(`${origin.table}\0${origin.chord}`))
  }));
  const hasConfig = Object.keys(parsed.keys).length > 0;
  return { commands, hasConfig, tables, ...(parsed.error === undefined ? {} : { error: parsed.error }) };
}

// clone a binding before handing it to the settings draft
const copiedBinding = (binding: KeyBinding): KeyBinding => typeof binding === 'string' ? binding : { ...binding };

// clone a configured binding without normalizing terminal command bytes
const copiedStoredBinding = (binding: KeyBinding | null): KeyBinding | null => binding === null ? null : copiedBinding(binding);

// expose structured tables while retaining exact configured property identities
export function serverKeyTableModel(input: unknown): ServerKeyTableModel {
  const parsed = parseServerShortcuts(input);
  const resolved = resolveKeyTables(parsed.keys);
  const tables: ServerKeyTable[] = [];
  // retain shared resolution order for built-in and custom tables
  for (const [name, resolvedRows] of Object.entries(resolved)) {
    const configuredRows = parsed.keys[name] ?? {};
    const rows: ServerKeyTableRow[] = [];
    // describe every resolved default and active configured row
    for (const row of Object.values(resolvedRows)) {
      const coordinate = `${name}\0${row.chord}`;
      const configured = hasOwn(configuredRows, row.chord);
      const protectedBinding = parsed.protectedBindings.has(coordinate);
      const rawBinding = parsed.rawBindings.get(coordinate);
      const binding = row.source === 'removed'
        ? null
        : configured && !protectedBinding && rawBinding !== undefined && rawBinding !== null ? copiedBinding(rawBinding) : copiedBinding(row.binding);
      rows.push({ chord: row.chord, rawChord: parsed.rawChords.get(coordinate) ?? row.chord, binding, source: row.source, configured, builtInDefault: hasOwn(defaultKeyTables[name] ?? {}, row.chord), protected: protectedBinding });
    }
    // include custom null leaves omitted by shared resolution
    for (const [chord, binding] of Object.entries(configuredRows)) {
      // resolved rows already include built-in null overrides
      if (binding !== null || rows.some(row => row.chord === chord)) continue;
      rows.push({ chord, rawChord: parsed.rawChords.get(`${name}\0${chord}`) ?? chord, binding: null, source: 'removed', configured: true, builtInDefault: hasOwn(defaultKeyTables[name] ?? {}, chord), protected: false });
    }
    tables.push({ name, builtIn: hasOwn(defaultKeyTables, name), configured: hasOwn(parsed.keys, name), rows, inbound: [] });
  }
  const byName = new Map(tables.map(table => [table.name, table]));
  // attach each active table switch to its destination
  for (const table of tables) for (const row of table.rows) {
    // disabled and non-switch bindings have no live inbound edge
    if (row.source === 'removed' || !isTableBinding(row.binding)) continue;
    byName.get(row.binding.table)?.inbound.push({ table: table.name, chord: row.chord, rawChord: row.rawChord });
  }
  return { tables, hasConfig: Object.keys(parsed.keys).length > 0, ...(parsed.error === undefined ? {} : { error: parsed.error }) };
}

// copy parsed keys before validating a complete edited candidate
const copiedServerKeys = (keys: KeysConfig): KeysConfig => Object.fromEntries(Object.entries(keys).map(([table, rows]) => [table, Object.fromEntries(Object.entries(rows).map(([chord, binding]) => [chord, copiedStoredBinding(binding)]))]));

// return shared parser diagnostics for one complete candidate
const serverKeysError = (keys: KeysConfig): string | undefined => {
  try { parseKeysConfig(keys); return undefined; }
  catch (error) { return error instanceof Error ? error.message : 'Keyboard shortcuts are invalid.'; }
};

// canonicalize one edit chord through the shared chord parser
const editedChord = (chord: string): { chord?: string; error?: string } => {
  try { return { chord: parseChord(chord) }; }
  catch (error) { return { error: error instanceof Error ? error.message : 'Invalid shortcut' }; }
};

// reject any display-only protected marker inside a fresh binding
const containsProtectedMarker = (value: unknown, seen = new Set<object>()): boolean => {
  // recognize the settings service marker before ordinary traversal
  if (isProtectedValue(value)) return true;
  // primitives cannot contain marker objects
  if (value === null || typeof value !== 'object') return false;
  // cycles are invalid bindings and need no repeated traversal
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(child => containsProtectedMarker(child, seen));
};

// rebuild one configured table with raw chords and safe raw binding bytes
const rawServerTable = (parsed: ParsedServerShortcuts, name: string, renamedFrom?: string, renamedTo?: string): Record<string, KeyBinding | null> => {
  const result: Record<string, KeyBinding | null> = {};
  // preserve each configured leaf in source order
  for (const chord of Object.keys(parsed.keys[name] ?? {})) {
    const coordinate = `${name}\0${chord}`;
    // protected rows are blocked by the caller rather than copied
    if (!parsed.rawBindings.has(coordinate)) continue;
    const binding = copiedStoredBinding(parsed.rawBindings.get(coordinate)!);
    result[parsed.rawChords.get(coordinate) ?? chord] = renamedFrom !== undefined && renamedTo !== undefined && isTableBinding(binding) && binding.table === renamedFrom ? { table: renamedTo } : binding;
  }
  return result;
};

// compile one structured table or row edit into direct application-config patches
export function editServerKeyTables(input: unknown, edit: ServerKeyTableEdit): { patches?: SettingsPatch[]; error?: string } {
  const parsed = parseServerShortcuts(input);
  // invalid source must be repaired before structured editing
  if (parsed.error !== undefined) return { error: parsed.error };
  const model = serverKeyTableModel(input);
  const tableFor = (name: string) => model.tables.find(table => table.name === name);
  // create one explicit empty custom table
  if (edit.kind === 'create-table') {
    // existing built-in and configured tables cannot be replaced
    if (tableFor(edit.name) !== undefined) return { error: `The ${edit.name} key table already exists.` };
    // settings patches cannot traverse reserved object identities
    const reservedError = reservedTableError(edit.name);
    if (reservedError !== undefined) return { error: reservedError };
    const candidate = copiedServerKeys(parsed.keys);
    candidate[edit.name] = {};
    const error = serverKeysError(candidate);
    return error === undefined ? { patches: [{ op: 'set', path: ['keys', edit.name], value: {} }] } : { error };
  }
  // rename one custom table and every safe switch reference
  if (edit.kind === 'rename-table') {
    const source = tableFor(edit.from);
    // stale and built-in table identities are immutable
    if (source === undefined) return { error: 'This key table is no longer available.' };
    if (source.builtIn) return { error: 'Built-in root and prefix tables cannot be renamed.' };
    const sourcePathError = reservedTableError(edit.from);
    // an existing reserved table cannot be addressed by settings patches
    if (sourcePathError !== undefined) return { error: sourcePathError };
    if (edit.from === edit.to) return { patches: [] };
    if (tableFor(edit.to) !== undefined) return { error: `The ${edit.to} key table already exists.` };
    // settings patches cannot traverse reserved object identities
    const destinationPathError = reservedTableError(edit.to);
    if (destinationPathError !== undefined) return { error: destinationPathError };
    const reservedInbound = source.inbound.find(reference => reference.table !== edit.from && reservedSettingsPathParts.has(reference.table));
    // every external switch update must also have a writable path
    if (reservedInbound !== undefined) return { error: `The ${reservedInbound.table} key table name is reserved by the settings editor.` };
    // a whole-table copy cannot safely include masked terminal commands
    if ([...parsed.protectedBindings].some(coordinate => coordinate.startsWith(`${edit.from}\0`))) return { error: 'This table contains a protected terminal command. Replace or remove it before renaming the table.' };
    const candidate = copiedServerKeys(parsed.keys);
    const moved = candidate[edit.from]!;
    delete candidate[edit.from];
    candidate[edit.to] = moved;
    // update every switch target in the complete validation candidate
    for (const rows of Object.values(candidate)) for (const [chord, binding] of Object.entries(rows)) if (isTableBinding(binding) && binding.table === edit.from) rows[chord] = { table: edit.to };
    const error = serverKeysError(candidate);
    // never emit patches for an invalid renamed graph
    if (error !== undefined) return { error };
    const patches: SettingsPatch[] = [{ op: 'set', path: ['keys', edit.to], value: rawServerTable(parsed, edit.from, edit.from, edit.to) }];
    // retarget external switch leaves without copying their tables
    for (const [coordinate, binding] of parsed.rawBindings) {
      const [table, chord] = coordinate.split('\0') as [string, string];
      // internal switches were rewritten in the new whole-table value
      if (table === edit.from || !isTableBinding(binding) || binding.table !== edit.from) continue;
      patches.push({ op: 'set', path: ['keys', table, parsed.rawChords.get(coordinate) ?? chord], value: { table: edit.to } });
    }
    patches.push({ op: 'remove', path: ['keys', edit.from] });
    return { patches };
  }
  // remove a custom table or reset a built-in table's overrides
  if (edit.kind === 'remove-table') {
    const selected = tableFor(edit.name);
    // refuse stale table controls
    if (selected === undefined) return { error: 'This key table is no longer available.' };
    const selectedPathError = reservedTableError(edit.name);
    // a reserved table cannot be removed through settings patches
    if (selectedPathError !== undefined) return { error: selectedPathError };
    // built-in removal means only removing its configured overrides
    if (selected.builtIn) {
      if (!selected.configured) return { patches: [] };
      const candidate = copiedServerKeys(parsed.keys);
      delete candidate[edit.name];
      const error = serverKeysError(candidate);
      return error === undefined ? { patches: [{ op: 'remove', path: ['keys', edit.name] }] } : { error };
    }
    const external = selected.inbound.filter(reference => reference.table !== edit.name);
    // preserve switch targets owned by other tables
    if (external.length > 0) return { error: `This key table is still referenced by ${external.map(reference => `${reference.table}.${reference.rawChord}`).join(', ')}.` };
    const candidate = copiedServerKeys(parsed.keys);
    delete candidate[edit.name];
    const error = serverKeysError(candidate);
    // validate the remaining table graph after removal or built-in reset
    if (error !== undefined) return { error };
    return { patches: [{ op: 'remove', path: ['keys', edit.name] }] };
  }
  const table = tableFor(edit.table);
  // row edits require one current table
  if (table === undefined) return { error: 'This key table is no longer available.' };
  const tablePathError = reservedTableError(edit.table);
  // a reserved table cannot receive direct leaf patches
  if (tablePathError !== undefined) return { error: tablePathError };
  // create one binding without replacing any active row
  if (edit.kind === 'create-binding') {
    // display markers must never become source values
    if (containsProtectedMarker(edit.binding)) return { error: 'A protected marker cannot be saved as a key binding. Enter a fresh value instead.' };
    const chordResult = editedChord(edit.chord);
    // reject malformed chords before checking canonical occupancy
    if (chordResult.chord === undefined) return { error: chordResult.error };
    const chord = chordResult.chord;
    const destination = table.rows.find(row => row.chord === chord);
    // active defaults and configured rows require the explicit replacement edit
    if (destination !== undefined && destination.source !== 'removed') return { error: 'That shortcut is already assigned to another command.' };
    const candidate = copiedServerKeys(parsed.keys);
    candidate[edit.table] ??= {};
    candidate[edit.table]![chord] = copiedStoredBinding(edit.binding);
    const error = serverKeysError(candidate);
    // validate null slots and bindings against the complete candidate
    if (error !== undefined) return { error };
    const rawChord = parsed.rawChords.get(`${edit.table}\0${chord}`) ?? chord;
    return { patches: [{ op: 'set', path: ['keys', edit.table, rawChord], value: copiedStoredBinding(edit.binding) }] };
  }
  // replace one binding directly, including a previously protected terminal
  if (edit.kind === 'set-binding') {
    // display markers must never become source values
    if (containsProtectedMarker(edit.binding)) return { error: 'A protected marker cannot be saved as a key binding. Enter a fresh value instead.' };
    const chordResult = editedChord(edit.chord);
    // reject malformed chords before locating raw properties
    if (chordResult.chord === undefined) return { error: chordResult.error };
    const chord = chordResult.chord;
    const candidate = copiedServerKeys(parsed.keys);
    candidate[edit.table] ??= {};
    candidate[edit.table]![chord] = copiedBinding(edit.binding);
    const error = serverKeysError(candidate);
    // validate action names, switch targets, root chords and limits together
    if (error !== undefined) return { error };
    return { patches: [{ op: 'set', path: ['keys', edit.table, parsed.rawChords.get(`${edit.table}\0${chord}`) ?? chord], value: copiedBinding(edit.binding) }] };
  }
  // rename one binding while preserving its exact safe configured value
  if (edit.kind === 'rename-binding') {
    const fromResult = editedChord(edit.from); const toResult = editedChord(edit.to);
    // both source and destination use canonical identity
    if (fromResult.chord === undefined) return { error: fromResult.error };
    if (toResult.chord === undefined) return { error: toResult.error };
    const from = fromResult.chord; const to = toResult.chord;
    if (from === to) return { patches: [] };
    const source = table.rows.find(row => row.chord === from);
    // stale source rows cannot be copied
    if (source === undefined) return { error: 'This shortcut changed. Reload Settings.' };
    // disabled rows have no active binding to preserve
    if (source.source === 'removed') return { error: 'Disabled shortcuts cannot be renamed. Add a binding at the new shortcut instead.' };
    if (source.protected) return { error: 'This protected terminal command cannot be renamed. Replace it with a fresh binding or remove it.' };
    const destination = table.rows.find(row => row.chord === to);
    // active destinations cannot be overwritten, including noncanonical properties
    if (destination !== undefined && destination.source !== 'removed') return { error: 'That shortcut is already assigned to another command.' };
    const sourceCoordinate = `${edit.table}\0${from}`;
    const stored = source.configured ? parsed.rawBindings.get(sourceCoordinate) : source.binding;
    // every unprotected modeled source has a safe value
    if (stored === undefined) return { error: 'This shortcut changed. Reload Settings.' };
    const binding = copiedStoredBinding(stored);
    const candidate = copiedServerKeys(parsed.keys);
    candidate[edit.table] ??= {};
    // keep old built-in defaults disabled after moving their binding
    if (defaultKeyTables[edit.table]?.[from] !== undefined) candidate[edit.table]![from] = null;
    else delete candidate[edit.table]![from];
    candidate[edit.table]![to] = copiedStoredBinding(binding);
    const error = serverKeysError(candidate);
    // reject the complete move before writing either leaf
    if (error !== undefined) return { error };
    const oldRawChord = parsed.rawChords.get(sourceCoordinate) ?? from;
    const newRawChord = parsed.rawChords.get(`${edit.table}\0${to}`) ?? to;
    const patches: SettingsPatch[] = [defaultKeyTables[edit.table]?.[from] !== undefined
      ? { op: 'set', path: ['keys', edit.table, oldRawChord], value: null }
      : { op: 'remove', path: ['keys', edit.table, oldRawChord] }];
    patches.push({ op: 'set', path: ['keys', edit.table, newRawChord], value: copiedStoredBinding(binding) });
    return { patches };
  }
  const chordResult = editedChord(edit.chord);
  // remove only a current canonical row
  if (chordResult.chord === undefined) return { error: chordResult.error };
  const chord = chordResult.chord;
  const row = table.rows.find(candidate => candidate.chord === chord);
  if (row === undefined) return { error: 'This shortcut changed. Reload Settings.' };
  const coordinate = `${edit.table}\0${chord}`;
  const configured = hasOwn(parsed.keys[edit.table] ?? {}, chord);
  const rawChord = parsed.rawChords.get(coordinate) ?? chord;
  // restoring an inherited row is already a no-op
  if (edit.mode === 'restore' && !configured) return { patches: [] };
  // an explicit null is already disabled
  if (edit.mode === 'disable' && parsed.rawBindings.get(coordinate) === null) return { patches: [] };
  const candidate = copiedServerKeys(parsed.keys);
  candidate[edit.table] ??= {};
  if (edit.mode === 'disable') candidate[edit.table]![chord] = null;
  else delete candidate[edit.table]![chord];
  const error = serverKeysError(candidate);
  // preserve graph validity after restoration or disablement
  if (error !== undefined) return { error };
  return { patches: [edit.mode === 'disable' ? { op: 'set', path: ['keys', edit.table, rawChord], value: null } : { op: 'remove', path: ['keys', edit.table, rawChord] }] };
}

// choose the minimal patch that removes one active assignment
const removalPatch = (parsed: ParsedServerShortcuts, id: string, table: string, chord: string): SettingsPatch => {
  const defaultBinding = defaultKeyTables[table]?.[chord];
  const storedChord = parsed.rawChords.get(`${table}\0${chord}`);
  // a matching built-in must be disabled rather than uncovered
  if (defaultBinding !== undefined && serverCommandId(defaultBinding, table, chord) === id) return { op: 'set', path: ['keys', table, storedChord ?? chord], value: null };
  // configured replacements and additions disappear by removing their leaf
  return { op: 'remove', path: ['keys', table, storedChord ?? chord] };
};

// remove duplicate patches while preserving edit order
const uniquePatches = (patches: SettingsPatch[]): SettingsPatch[] => {
  const byPath = new Map<string, SettingsPatch>();
  // the last write to a direct leaf is authoritative
  for (const patch of patches) byPath.set(JSON.stringify(patch.path), patch);
  return [...byPath.values()];
};

// compile one recorder action into direct application-config patches
export function editServerShortcuts(input: unknown, id: string, edit: ShortcutEdit): { patches?: SettingsPatch[]; error?: string } {
  const parsed = parseServerShortcuts(input);
  // raw invalid config must be repaired in the advanced editor
  if (parsed.error !== undefined) return { error: parsed.error };
  const model = serverShortcutModel(input);
  const command = model.commands.find(candidate => candidate.id === id);
  // reject a stale command reference
  if (command === undefined) return { error: 'This command is no longer available. Reload Settings.' };
  // never copy a redacted terminal command into a new leaf
  if (command.protected) return { error: 'This terminal command is protected. Use the advanced key-table controls to edit it.' };
  // reset restores built-ins and removes custom aliases for only this command
  if (edit.kind === 'reset') {
    const patches: SettingsPatch[] = [];
    // remove every configured leaf that defines this command
    for (const [coordinate, rawChord] of parsed.rawChords) {
      const [table, chord] = coordinate.split('\0') as [string, string];
      const binding = parsed.keys[table]?.[chord];
      // ignore coordinates rejected from the parsed config
      if (binding === undefined && !hasOwn(parsed.keys[table] ?? {}, chord)) continue;
      const defaultBinding = defaultKeyTables[table]?.[chord];
      const configuredMatches = binding !== null && serverCommandId(binding, table, chord) === id;
      const defaultMatches = defaultBinding !== undefined && serverCommandId(defaultBinding, table, chord) === id;
      // resetting this command restores its defaults and drops its aliases
      if (configuredMatches || defaultMatches) patches.push({ op: 'remove', path: ['keys', table, rawChord] });
    }
    return { patches: uniquePatches(patches) };
  }
  // enabling a disabled command is the same scoped reset
  if (edit.kind === 'disable' && command.shortcuts.length === 0) return editServerShortcuts(input, id, { kind: 'reset' });
  // disabling removes every active assignment without touching other commands
  if (edit.kind === 'disable') {
    return { patches: uniquePatches(command.shortcuts.map(shortcut => removalPatch(parsed, id, shortcut.table, shortcut.chord))) };
  }
  const sourceTable = edit.kind === 'replace' ? edit.fromTable : edit.table;
  // a stale visible assignment cannot turn into an unrelated addition
  if ((edit.kind === 'replace' || edit.kind === 'remove') && !command.shortcuts.some(shortcut => shortcut.table === sourceTable && shortcut.chord === edit.from)) return { error: 'This shortcut changed. Try again with its current assignment.' };
  // removal needs only the direct source leaf
  if (edit.kind === 'remove') {
    const row = model.tables[sourceTable]?.[edit.from];
    return row === undefined ? { error: 'This shortcut changed. Try again with its current assignment.' } : { patches: [removalPatch(parsed, id, sourceTable, edit.from)] };
  }
  // destinations must use a table known to the current server config
  if (model.tables[edit.table] === undefined) return { error: 'This key table is no longer available.' };
  const validation = shortcutValidationError(edit.table, edit.chord, command.origins[0]?.chord ?? edit.chord, command.origins[0]?.table ?? edit.table);
  // apply shared browser and root-key constraints
  if (validation !== undefined) return { error: validation.replace(/\broot\b/gu, 'non-prefixed') };
  const occupant = model.tables[edit.table]![edit.chord];
  // reject an active collision rather than replacing another command
  if (occupant !== undefined && occupant.source !== 'removed' && serverCommandId(occupant.binding, edit.table, edit.chord) !== id) return { error: 'That shortcut is already assigned to another command.' };
  const alreadyAssigned = command.shortcuts.some(shortcut => shortcut.table === edit.table && shortcut.chord === edit.chord);
  // an unchanged replacement is a no-op
  if (alreadyAssigned && edit.kind === 'replace' && edit.fromTable === edit.table && edit.from === edit.chord) return { patches: [] };
  const patches: SettingsPatch[] = [];
  // remove the old leaf before placing its binding elsewhere
  if (edit.kind === 'replace') {
    const row = model.tables[edit.fromTable]?.[edit.from];
    // retain stale-edit protection through compilation
    if (row === undefined) return { error: 'This shortcut changed. Try again with its current assignment.' };
    patches.push(removalPatch(parsed, id, edit.fromTable, edit.from));
  }
  // do not duplicate an existing assignment
  if (!alreadyAssigned) {
    const original = command.shortcuts.map(shortcut => parsed.rawBindings.get(`${shortcut.originTable}\0${shortcut.original}`)).find((binding): binding is KeyBinding => binding !== undefined && binding !== null);
    const storedDestination = parsed.rawChords.get(`${edit.table}\0${edit.chord}`) ?? edit.chord;
    patches.push({ op: 'set', path: ['keys', edit.table, storedDestination], value: copiedBinding(original ?? command.binding) });
  }
  return { patches: uniquePatches(patches) };
}

// reset the complete key table so future built-in defaults are inherited
export const resetServerShortcuts = (): SettingsPatch[] => [{ op: 'remove', path: ['keys'] }];

const arrowLabels: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' };

// choose the platform's familiar name for the system modifier
const superLabel = (platform: string): string => {
  // include desktop and mobile apple platform spellings
  if (/(?:darwin|mac|iphone|ipad|ipod|ios)/iu.test(platform)) return 'Cmd';
  // recognize windows platform and user-agent spellings
  if (/win(?:dows|32|64)?/iu.test(platform)) return 'Win';
  return 'Super';
};

// split one canonical chord into human-readable physical key labels
export function shortcutKeys(chord: string, platform: string): string[] {
  const labels: string[] = [];
  let key = chord;
  const modifiers = [['C', 'Ctrl'], ['M', 'Alt'], ['S', 'Shift']] as const;
  // peel canonical modifiers in their fixed order
  for (const [modifier, label] of modifiers) {
    // add only modifiers present on this chord
    if (key.startsWith(`${modifier}-`)) {
      labels.push(label);
      key = key.slice(modifier.length + 1);
    }
  }
  // the system modifier follows shift in canonical chords
  if (key.startsWith('Super-')) {
    labels.push(superLabel(platform));
    key = key.slice('Super-'.length);
  }
  // expand terse and directional key names
  if (key === 'BSpace') key = 'Backspace';
  else if (hasOwn(arrowLabels, key)) key = arrowLabels[key]!;
  else if (/^[a-z]$/iu.test(key)) key = key.toUpperCase();
  labels.push(key);
  return labels;
}

// join the outlined-key labels for text-only surfaces
export const shortcutLabel = (chord: string, platform: string): string => shortcutKeys(chord, platform).join(' + ');
