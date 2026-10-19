import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { eventChord, isTableBinding, isTerminalBinding, keyActions, lookupKeyBinding, resolveKeyTables, terminalProgramName, type KeyBinding, type KeyRow, type KeysConfig, type ResolvedKeyTables } from '../../server/src/config/keys.js';
import { createKeyDispatcher, type KeyDispatchState } from './key-dispatch.js';
import { editServerShortcuts, resetServerShortcuts, serverShortcutModel, shortcutKeys, shortcutLabel, shortcutCommands, type ServerShortcutCommand, type ShortcutCommand, type ShortcutEdit } from './shortcut-config.js';
import type { SettingsPatch } from './settings/contracts.js';
import { SettingsSelect } from './settings/select.js';
import { resetTerminalFontSize, stepTerminalFontSize } from './terminal-font-size.js';

// What a handler hears about the key that ran it; undefined when the palette runs it.
export type KeyActionContext = { table: string; chord: string; binding: KeyBinding };
// A handler returns false when its action does not apply right now (copy with nothing selected),
// so a root key passes through to the focused control untouched.
export type KeyActionHandler = (event: KeyboardEvent | undefined, context: KeyActionContext | undefined) => boolean | void;
// the action a `{ terminal }` binding runs; its handler asks the server to open the binding's Terminal
export const terminalBindingAction = 'open-terminal-binding';

let configured: KeysConfig | undefined;
let baseTables = resolveKeyTables(undefined);
let tables = baseTables;
let tablesRevision = 0;
const tableListeners = new Set<() => void>();
// refresh dispatch and every mounted shortcut reference together
const refreshTables = () => {
  tables = baseTables;
  dispatcher.reset();
  clearKeyPress();
  tablesRevision += 1;
  tableListeners.forEach(listener => listener());
};
// adopt only the server dashboard's effective key config
export const setKeysConfig = (keys: KeysConfig | undefined) => {
  // skip identical dashboard updates
  if (JSON.stringify(keys) === JSON.stringify(configured)) return;
  configured = keys;
  baseTables = resolveKeyTables(keys);
  refreshTables();
};
// subscribe shortcut references to live server bindings
const useKeyTables = () => {
  useSyncExternalStore(listener => { tableListeners.add(listener); return () => { tableListeners.delete(listener); }; }, () => tablesRevision);
  return tables;
};
// expose only the server-provided command reference
export const useShortcutSettings = () => {
  useKeyTables();
  return { commands: shortcutCommands(baseTables, {}) };
};
// use the operating system's familiar modifier name
const platform = navigator.platform || navigator.userAgent;
// separate simultaneous keys without putting the plus sign inside a keycap
function KeyCaps({ keys }: { keys: string[] }) {
  return <span className="shortcut-keys" aria-label={keys.join(' + ')}>{keys.map((key, index) => <Fragment key={`${index}:${key}`}>{index > 0 && <span className="shortcut-key-separator" aria-hidden="true"> + </span>}<kbd>{key}</kbd></Fragment>)}</span>;
}
// render each physical key with its own outline
export const ShortcutKeys = ({ chord }: { chord: string }) => <KeyCaps keys={shortcutKeys(chord, platform)} />;
// share readable labels with editor controls and the command palette
export const readableShortcut = (chord: string) => shortcutLabel(chord, platform);

type KeyPressFeedback = { chords: string[][]; matched: boolean; expiresAt: number; target: Element | null };
let keyPressFeedback: KeyPressFeedback | undefined;
let keyPressTimer: ReturnType<typeof setTimeout> | undefined;
let keyPressMatched = false;
const keyPressListeners = new Set<() => void>();
// publish transient shortcut feedback without persisting input
const publishKeyPress = (next: KeyPressFeedback | undefined) => {
  keyPressFeedback = next;
  keyPressListeners.forEach(listener => listener());
};
// clear transient feedback when its deadline or keyboard listener ends
const clearKeyPress = () => {
  clearTimeout(keyPressTimer);
  publishKeyPress(undefined);
};
// hide ordinary typing and native control navigation, including terminal output mode
const inputOwnsKey = (target: Element | null) => target?.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], .xterm, .prompt, .note-pane.editing') != null || target instanceof HTMLElement && target.isContentEditable;
// preserve the entire leader chain until its command finishes and fades together
const showKeyPress = (event: KeyboardEvent, chord: string | undefined, previous: KeyDispatchState | undefined, matched: boolean, previousFeedback: KeyPressFeedback | undefined) => {
  const target = keyTarget(event);
  const binding = chord === undefined ? undefined : lookupKeyBinding(tables, previous?.table ?? 'root', chord);
  const continuing = previous !== undefined && (previous.confirm !== undefined || !previous.repeat || typeof binding === 'string' && keyActions[binding]?.repeat === true);
  // password characters stay private even when a binding consumes the key
  if (target instanceof HTMLInputElement && target.type === 'password') { clearKeyPress(); return; }
  // composition is private input, never a shortcut attempt
  if (event.isComposing) { clearKeyPress(); return; }
  // bare modifiers are not bindings and never replace a pending leader
  if (chord === undefined) return;
  // ordinary field editing stays silent even when a newline has a configured binding
  if (!continuing && inputOwnsKey(target) && (!matched || binding === 'prompt-newline')) { clearKeyPress(); return; }
  const keys = shortcutKeys(chord, platform);
  const trail = continuing ? previousFeedback?.chords ?? [] : [];
  const priorChords = previous?.table !== undefined && previous.repeat ? trail.slice(0, -1) : trail;
  const state = dispatcher.state();
  const pending = state !== undefined && (state.confirm !== undefined || !state.repeat);
  const expiresAt = pending ? state.expiresAt : Date.now() + 1500;
  clearTimeout(keyPressTimer);
  publishKeyPress({ chords: [...priorChords, keys], matched, expiresAt, target });
  keyPressTimer = setTimeout(clearKeyPress, Math.max(0, expiresAt - Date.now()));
};
// share key feedback with the floating indicator without rerendering the app
const useKeyPress = () => useSyncExternalStore(listener => { keyPressListeners.add(listener); return () => { keyPressListeners.delete(listener); }; }, () => keyPressFeedback);

// Handlers per action, newest first: the first that does not decline handles the key.
const handlers = new Map<string, KeyActionHandler[]>();
export const registerKeyAction = (name: string, handler: KeyActionHandler) => {
  handlers.set(name, [handler, ...(handlers.get(name) ?? [])]);
  return () => { handlers.set(name, (handlers.get(name) ?? []).filter(candidate => candidate !== handler)); };
};
export const runKeyAction = (name: string, event?: KeyboardEvent, context?: KeyActionContext): boolean => {
  for (const handler of handlers.get(name) ?? []) if (handler(event, context) !== false) return true;
  return false;
};
// register a component's handlers for as long as it is mounted, always calling its latest render's
export function useKeyActions(actions: Record<string, KeyActionHandler>) {
  const latest = useRef(actions);
  latest.current = actions;
  const names = Object.keys(actions).join('\n');
  useEffect(() => {
    // a handler that returns nothing handled the key; only an explicit false declines it
    const unregister = names.split('\n').map(name => registerKeyAction(name, (event, context) => latest.current[name] === undefined ? false : latest.current[name]!(event, context)));
    return () => unregister.forEach(release => release());
  }, [names]);
}
export const useKeyAction = (name: string, handler: KeyActionHandler) => useKeyActions({ [name]: handler });

const dispatcher = createKeyDispatcher<KeyboardEvent>({
  tables: () => tables,
  // distinguish successful dispatch from an inapplicable root binding
  onMatch: () => { keyPressMatched = true; },
  // send the exact server-provided binding identity
  run: (binding, { table, chord, event }) => runKeyAction(typeof binding === 'string' ? binding : terminalBindingAction, event, { table, chord, binding })
});
// ask a y/n question in the indicator; the next key answers it
export const confirmKey = (message: string, onYes: () => void) => dispatcher.confirm(message, onYes);

// the element a key really went to, through any shadow root (the Code panel's diffs)
export const keyTarget = (event: KeyboardEvent | undefined): Element | null => {
  const target = event?.composedPath()[0] ?? document.activeElement;
  return target instanceof Element ? target : null;
};
// whether a key goes to a text field other than a terminal's own input, where it is typing; an
// action the palette runs has no key, so it is never typing
export const typingOutsideTerminal = (event: KeyboardEvent | undefined): boolean => {
  if (event === undefined) return false;
  const target = keyTarget(event);
  const editable = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
  return editable && target.closest('.xterm') === null;
};

// The one keydown listener for app shortcuts. It runs first (window, capture phase) and swallows
// only the keys the dispatcher handles; every other key reaches xterm, the composer or the control.
const onKeyDown = (event: KeyboardEvent) => {
  const chord = eventChord(event);
  // let the recorder hear shortcuts without executing or illustrating them
  if (keyTarget(event)?.closest('[data-shortcut-recorder]') != null) { dispatcher.reset(); clearKeyPress(); return; }
  // modal controls own their keys without workspace feedback behind them
  if (document.querySelector('[aria-modal="true"]') !== null) {
    dispatcher.reset();
    clearKeyPress();
    // keep the quick reference's own toggle available
    if (overlay === 'bindings' && chord !== undefined && lookupKeyBinding(tables, 'root', chord) === 'show-bindings') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOverlay(undefined);
    }
    return;
  }
  const previous = dispatcher.state();
  const previousFeedback = keyPressFeedback;
  // holding the leader neither sends it on nor duplicates its keycaps
  const held = event.repeat && chord !== undefined && chord === previous?.chord;
  keyPressMatched = false;
  const result = held ? 'handled' : dispatcher.handle(chord, event);
  // publish consumed shortcuts only while the action has not opened a modal
  if (!held && overlay === undefined) showKeyPress(event, chord, previous, keyPressMatched && result !== 'pass', previousFeedback);
  // send-prefix reaches a terminal only; elsewhere the browser would act on it
  if (result === 'pass' || (result === 'send' && keyTarget(event)?.closest('.xterm') != null)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
let installed = 0;
const installKeyboard = () => {
  // install one shared capture listener across dashboard mounts
  if (installed++ === 0) window.addEventListener('keydown', onKeyDown, true);
  // release transient state when the final keyboard layer unmounts
  return () => { if (--installed === 0) { window.removeEventListener('keydown', onKeyDown, true); dispatcher.reset(); clearKeyPress(); } };
};

// The overlays the keyboard opens, outside any one Workspace.
type KeyboardOverlay = 'bindings' | 'palette' | undefined;
let overlay: KeyboardOverlay;
const overlayListeners = new Set<() => void>();
// modal entry cancels any leader before a recorder or picker can own focus
const setOverlay = (next: KeyboardOverlay) => {
  // mouse-opened overlays must also release the pending table
  if (next !== undefined) { dispatcher.reset(); clearKeyPress(); }
  overlay = next;
  overlayListeners.forEach(listener => listener());
};
export const openBindingsSheet = () => setOverlay('bindings');
export const shortcutSettingsNavigationEvent = 'rac:open-shortcut-settings';
// open Settings and request its server keyboard section
export const openShortcutSettings = () => {
  // preserve search parameters while using the existing Settings route
  if (location.hash !== '#settings') location.hash = 'settings';
  window.dispatchEvent(new CustomEvent(shortcutSettingsNavigationEvent));
};
const useOverlay = () => useSyncExternalStore(listener => { overlayListeners.add(listener); return () => { overlayListeners.delete(listener); }; }, () => overlay);

registerKeyAction('show-bindings', () => setOverlay(overlay === 'bindings' ? undefined : 'bindings'));
registerKeyAction('command-palette', () => setOverlay('palette'));
// font size steps while a terminal shows, from anywhere but a text field; otherwise the browser
// zooms the page as it always has
const fontKeyDeclines = (event: KeyboardEvent | undefined) => document.querySelector('.xterm') === null || typingOutsideTerminal(event);
registerKeyAction('font-larger', event => { if (fontKeyDeclines(event)) return false; stepTerminalFontSize(1); });
registerKeyAction('font-smaller', event => { if (fontKeyDeclines(event)) return false; stepTerminalFontSize(-1); });
registerKeyAction('font-reset', event => { if (fontKeyDeclines(event)) return false; resetTerminalFontSize(); });

// how a binding reads in the sheet and the palette
export const describeBinding = (binding: KeyBinding): string => typeof binding === 'string'
  ? keyActions[binding]?.description ?? binding
  : isTableBinding(binding) ? `Switch to the ${binding.table} table` : `Terminal running ${terminalProgramName(binding.terminal)}${binding.reuse === true ? ' (reused)' : ''}`;
const sourceLabel: Record<KeyRow['source'], string> = { default: 'Default', config: 'Config', replaced: 'Config, replaces the default', removed: 'Default, removed by config' };
export type KeyPickerOption = { id: string; label: string; detail?: string; nested?: boolean; current?: boolean; onSelect: () => void };
// A filterable list in a dialog: type to filter, arrows to move, Enter to choose, Escape to close.
// Closing hands focus back to where it was before the choice runs, so a choice can move it on.
export function KeyPicker({ title, options, onClose, placeholder = 'Filter' }: { title: string; options: readonly KeyPickerOption[]; onClose: () => void; placeholder?: string }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, options.findIndex(option => option.current === true)));
  const returnFocus = useRef(document.activeElement);
  const listRef = useRef<HTMLUListElement | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle === '' ? options : options.filter(option => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(needle));
  const active = Math.min(index, shown.length - 1);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const close = () => {
    onClose();
    if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus({ preventScroll: true });
  };
  const choose = (option: KeyPickerOption | undefined) => {
    if (option === undefined) return;
    close();
    option.onSelect();
  };
  const keyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((active + 1) % Math.max(1, shown.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((active - 1 + shown.length) % Math.max(1, shown.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
  };
  return createPortal(<div className="dialog key-picker-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={keyDown} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div>
    <input className="key-picker-filter" autoFocus aria-label={`${title} filter`} placeholder={placeholder} value={query} role="combobox" aria-expanded="true" aria-controls="key-picker-list" aria-activedescendant={shown[active] === undefined ? undefined : `key-picker-${active}`} onChange={event => { setQuery(event.target.value); setIndex(0); }} />
    <ul ref={listRef} id="key-picker-list" className="key-picker-list" role="listbox" aria-label={title}>
      {shown.map((option, position) => <li key={option.id} id={`key-picker-${position}`} role="option" aria-selected={position === active} className={`${option.nested ? 'nested' : ''}${option.current ? ' current' : ''}`} onMouseMove={() => setIndex(position)} onClick={() => choose(option)}><span>{option.label}</span>{option.detail !== undefined && <small>{option.detail}</small>}</li>)}
      {shown.length === 0 && <li className="key-picker-empty" role="presentation">No matches</li>}
    </ul>
  </div></div>, document.body);
}

// identify every command origin even when all of its shortcuts are disabled
const commandOrigins = (command: ShortcutCommand): string => command.origins.map(origin => `${origin.table}:${origin.chord}`).join(' ');
// direct shortcuts need no internal table label
const assignmentLabel = (table: string, chord: string): string => `${table === 'root' ? '' : `${table}: `}${readableShortcut(chord)}`;
// explain exactly which ambiguous shortcuts are ignored in either popup mode
const commandConflict = (command: ShortcutCommand): string | undefined => {
  const shared = command.shortcuts.filter(shortcut => shortcut.conflicted).map(shortcut => assignmentLabel(shortcut.table, shortcut.chord));
  return shared.length === 0 ? undefined : `Conflict: ${shared.join(', ')} — assigned to another command. These shortcuts are ignored until resolved.`;
};
// summarize provenance once for each consolidated command
const commandSource = (command: ShortcutCommand): string => command.shortcuts.length === 0 ? 'Disabled' : command.customized ? 'Custom' : [...new Set(command.shortcuts.map(shortcut => sourceLabel[shortcut.source]))].join(', ');

// capture a chord without activating dashboard shortcuts
export function ShortcutCaptureInput({ chord, label, disabled = false, onCapture, onCancel }: { chord?: string; label: string; disabled?: boolean; onCapture: (chord: string) => void; onCancel: () => void }) {
  // record complete chords without dispatching them or trapping focus traversal
  const record = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // tab belongs to normal focus traversal
    if (event.key === 'Tab') return;
    event.stopPropagation();
    event.preventDefault();
    // escape cancels the current capture only
    if (event.key === 'Escape') { onCancel(); return; }
    const next = eventChord(event.nativeEvent);
    // bare modifiers and composition are not complete shortcuts
    if (next !== undefined) onCapture(next);
  };
  return <input autoFocus readOnly disabled={disabled} data-shortcut-recorder aria-label={label} placeholder="Press a shortcut…" value={chord === undefined ? '' : readableShortcut(chord)} onKeyDown={record} />;
}

// edit one server-backed command without activating the draft in this browser
function ShortcutSetting({ command, keys, tables, disabled: editorDisabled, onChange }: { command: ServerShortcutCommand; keys: unknown; tables: ResolvedKeyTables; disabled: boolean; onChange: (patches: SettingsPatch[]) => boolean }) {
  const [editing, setEditing] = useState<{ table: string; prefixTable: string; from?: { table: string; chord: string } }>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(command);
  const description = command.protected ? 'Protected terminal command' : describeBinding(command.binding);
  const commandDisabled = command.shortcuts.length === 0;
  const prefixTables = Object.keys(tables).filter(table => table !== 'root');
  // recover focus when an assignment or its old edit icon disappears
  const focusControl = () => {
    const trigger = triggerRef.current;
    // prefer the actual opener while it still exists and remains usable
    if (trigger?.isConnected === true && !trigger.disabled) trigger.focus();
    else rowRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  // abandon stale recorder state after the shared settings draft changes
  useEffect(() => {
    const restoreFocus = recorderRef.current?.contains(document.activeElement) === true;
    setEditing(undefined);
    setError(undefined);
    // avoid stealing focus from another command's controls
    if (restoreFocus) requestAnimationFrame(focusControl);
  }, [signature]);
  // start one replacement or addition recorder
  const begin = (trigger: HTMLButtonElement, table: string, from?: string) => {
    triggerRef.current = trigger;
    setDraft(from);
    setError(undefined);
    setEditing({ table, prefixTable: table === 'root' ? prefixTables[0] ?? 'prefix' : table, ...(from === undefined ? {} : { from: { table, chord: from } }) });
  };
  // cancel capture without changing the shared settings draft
  const cancel = () => { setEditing(undefined); setError(undefined); requestAnimationFrame(focusControl); };
  // compile one edit into application-config leaf patches
  const apply = (edit: ShortcutEdit) => {
    const result = editServerShortcuts(keys, command.id, edit);
    setError(result.error);
    // retain invalid recorder state for correction
    if (result.error !== undefined) return;
    // preserve the recorder when a captured transaction rejects staging
    if (!onChange(result.patches ?? [])) return;
    setEditing(undefined);
    requestAnimationFrame(focusControl);
  };
  const assignments = command.shortcuts.map(shortcut => assignmentLabel(shortcut.table, shortcut.chord)).join(', ');
  const unavailable = editorDisabled || command.protected;
  return <div ref={rowRef} className={`shortcut-setting${commandDisabled ? ' key-binding-removed' : ''}`} role="group" aria-label={`${description} (${commandDisabled ? 'disabled' : assignments})`} data-shortcut-command={command.id} data-shortcut-origins={commandOrigins(command)}>
    <div className="shortcut-setting-keys">
      {command.shortcuts.map(shortcut => <span key={`${shortcut.table}:${shortcut.chord}`} className="shortcut-assignment" data-shortcut-id={`${shortcut.originTable}:${shortcut.original}`} data-shortcut-table={shortcut.table} data-shortcut-chord={shortcut.chord}>
        <span className="shortcut-assignment-controls">
          <button type="button" className="shortcut-change shortcut-outline" disabled={unavailable} aria-label={`Change shortcut for ${description} (${assignmentLabel(shortcut.table, shortcut.chord)})`} title="Rebind shortcut" onClick={event => { /* capture only this visible binding */ begin(event.currentTarget, shortcut.table, shortcut.chord); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg></button>
          <button type="button" className="shortcut-remove shortcut-outline" disabled={unavailable} aria-label={`Remove shortcut ${assignmentLabel(shortcut.table, shortcut.chord)} for ${description}`} title="Remove shortcut" onClick={() => { /* remove only this config-backed leaf */ apply({ kind: 'remove', table: shortcut.table, from: shortcut.chord }); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></button>
        </span>
        {shortcut.table !== 'root' && <span className="shortcut-table-label">{shortcut.table}</span>}<ShortcutKeys chord={shortcut.chord} />
      </span>)}
      {!commandDisabled && <button type="button" className="shortcut-add shortcut-outline" disabled={unavailable} aria-label={`Add shortcut for ${description}`} onClick={event => { /* start in the command's current table */ begin(event.currentTarget, command.shortcuts[0]!.table); }}>+ Add</button>}
    </div>
    <div className="shortcut-setting-description"><strong>{commandDisabled ? <s>{description}</s> : description}</strong></div>
    <div className="shortcut-setting-actions shortcut-binding-controls">
      <button type="button" className="shortcut-outline" disabled={unavailable} title={commandDisabled ? 'Restore the built-in shortcuts' : 'Disable all shortcuts for this command'} onClick={() => { /* toggle this command through config patches */ apply({ kind: commandDisabled ? 'reset' : 'disable' }); }}>{commandDisabled ? 'Enable' : 'Disable'}</button>
      <button type="button" className="shortcut-outline" disabled={unavailable || !command.customized} onClick={() => { /* restore only this command's built-in defaults */ apply({ kind: 'reset' }); }}>Reset</button>
    </div>
    {editing !== undefined && <div ref={recorderRef} className="shortcut-recorder">
      <label className="client-settings-toggle shortcut-prefix-toggle"><span>Use prefix</span><input role="switch" type="checkbox" aria-label={`Use prefix for ${description}`} checked={editing.table !== 'root'} disabled={editorDisabled} onChange={event => { /* change only the pending destination table */ setEditing({ ...editing, table: event.currentTarget.checked ? editing.prefixTable : 'root' }); setError(undefined); }} /><span className="client-settings-switch-state">{editing.table === 'root' ? 'Off' : 'On'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label>
      {editing.table !== 'root' && prefixTables.length > 1 && <label>Prefix table<SettingsSelect label={`Prefix table for ${description}`} value={editing.table} disabled={editorDisabled} options={prefixTables.map(table => ({ value: table, label: table }))} onChange={table => { /* retain the recorded chord while changing tables */ setEditing({ ...editing, table, prefixTable: table }); setError(undefined); }} /></label>}
      <ShortcutCaptureInput chord={draft} label={`New shortcut for ${description}`} disabled={editorDisabled} onCapture={chord => { /* retain the same normal recorder semantics */ setDraft(chord); setError(undefined); }} onCancel={cancel} />
      <span>Press keys, then Apply shortcut. Escape cancels.</span>
      <div className="shortcut-setting-actions"><button type="button" disabled={editorDisabled || draft === undefined} onClick={() => { /* apply a replacement or additional binding */ if (draft !== undefined) apply(editing.from === undefined ? { kind: 'add', table: editing.table, chord: draft } : { kind: 'replace', table: editing.table, fromTable: editing.from.table, from: editing.from.chord, chord: draft }); }}>Apply shortcut</button><button type="button" onClick={cancel}>Cancel</button></div>
    </div>}
    {command.protected && <small>This terminal binding is masked. Choose the Key tables editor view to edit it.</small>}
    {error && <p className="shortcut-error" role="alert">{error}</p>}
  </div>;
}

// stage server-wide keyboard changes through the shared Settings transaction
export function ShortcutEditor({ keys, disabled, onChange }: { keys: unknown; disabled: boolean; onChange: (patches: SettingsPatch[]) => boolean }) {
  const model = serverShortcutModel(keys);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  // search display-safe descriptions and assignments only
  const shown = model.commands.filter(command => `${command.protected ? 'Protected terminal command' : describeBinding(command.binding)} ${command.origins.map(origin => `${origin.table} ${readableShortcut(origin.chord)}`).join(' ')} ${command.shortcuts.map(shortcut => `${shortcut.table} ${readableShortcut(shortcut.chord)}`).join(' ')}`.toLowerCase().includes(needle));
  return <div className="shortcut-editor" role="region" aria-label="Edit keyboard shortcuts">
    <p>These shortcuts are server-wide and come from the application config. Recorder changes join the Settings draft and take effect after the server restarts.</p>
    <div className="shortcut-editor-actions"><button type="button" className="shortcut-outline" disabled={disabled || !model.hasConfig} onClick={() => { /* restore every built-in key table */ if (onChange(resetServerShortcuts())) requestAnimationFrame(() => searchRef.current?.focus()); }}>Reset all shortcuts</button></div>
    {model.error && <p className="shortcut-error" role="alert">{model.error} Choose the Key tables editor view or Application whole source to repair it.</p>}
    <input ref={searchRef} type="search" aria-label="Find keyboard shortcuts" placeholder="Find a shortcut…" value={query} disabled={disabled || model.error !== undefined} onChange={event => { /* filter without changing the draft */ setQuery(event.target.value); }} />
    <div className="shortcut-table">{shown.map(command => <ShortcutSetting key={command.id} command={command} keys={keys} tables={model.tables} disabled={disabled || model.error !== undefined} onChange={onChange} />)}</div>
    {shown.length === 0 && model.error === undefined && <p>No matching shortcuts.</p>}
  </div>;
}

// show each command once with disabled and conflicting assignments clearly marked
function BindingsSheet({ onClose }: { onClose: () => void }) {
  const { commands } = useShortcutSettings();
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  // recover focus if a live configuration update removes the focused control
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    // leave valid modal focus untouched
    if (sheet !== null && !sheet.contains(document.activeElement)) sheet.querySelector<HTMLButtonElement>('button')?.focus();
  });
  // hand focus back however the sheet closes, C-? again included
  useLayoutEffect(() => () => { if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus({ preventScroll: true }); }, []);
  // contain keyboard navigation inside the quick reference
  const sheetKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // dismiss without also closing settings behind the portal
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // cycle focus within the quick reference
    if (event.key === 'Tab') {
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      // wrap at either end of the modal controls
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  };
  return createPortal(<div ref={sheetRef} className="dialog key-bindings-dialog" role="dialog" aria-modal="true" aria-labelledby="key-bindings-title" onKeyDown={sheetKey} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div>
    <header><h2 id="key-bindings-title">Key bindings</h2><button className="key-bindings-edit" type="button" onClick={() => { /* move editing to the server settings source */ onClose(); openShortcutSettings(); }}>Edit in Settings</button><button type="button" autoFocus aria-label="Close key bindings" onClick={onClose}>×</button></header>
    <p className="key-bindings-hint">Unlabeled shortcuts run directly. Prefix labels mean press that table&rsquo;s leader first. Press a leader twice to send it to the focused terminal; otherwise it waits 10 seconds for the next key.</p>
    <section aria-label="Keyboard shortcuts"><table><tbody>{commands.map(command => {
      const disabled = command.shortcuts.length === 0;
      const conflict = commandConflict(command);
      return <tr key={command.id} data-shortcut-command={command.id} data-shortcut-origins={commandOrigins(command)} className={`key-binding-${disabled ? 'removed' : command.origins[0]!.source}${conflict === undefined ? '' : ' shortcut-conflict'}`}>
        <td><div className="shortcut-reference-keys">{command.shortcuts.map(shortcut => <span key={`${shortcut.table}:${shortcut.chord}`} className={`shortcut-assignment${shortcut.conflicted ? ' shortcut-assignment-conflict' : ''}`} data-shortcut-id={`${shortcut.originTable}:${shortcut.original}`} data-shortcut-table={shortcut.table} data-shortcut-chord={shortcut.chord}>{shortcut.table !== 'root' && <span className="shortcut-table-label">{shortcut.table}</span>}<ShortcutKeys chord={shortcut.chord} /></span>)}</div></td>
        <td>{disabled ? <s>{describeBinding(command.binding)}</s> : describeBinding(command.binding)}{conflict !== undefined && <p className="shortcut-conflict-message">{conflict}</p>}</td>
        <td className="key-binding-source">{commandSource(command)}</td>
      </tr>;
    })}</tbody></table></section>
  </div></div>, document.body);
}

// Every action, and each Terminal binding, runnable by name.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const resolved = useKeyTables();
  // keys that run each binding, so a row teaches its shortcut
  const keysFor = (matches: (binding: KeyBinding) => boolean) => Object.entries(resolved).flatMap(([table, rows]) => Object.values(rows).filter(row => row.source !== 'removed' && row.conflicted !== true && matches(row.binding)).map(row => table === 'root' ? readableShortcut(row.chord) : `${table} ${readableShortcut(row.chord)}`)).join(', ');
  // copy and save-note act on the key's own target, so they only make sense as keys
  const actions = Object.entries(keyActions).filter(([name]) => name !== 'copy-selection' && name !== 'save-note' && name !== 'prompt-newline' && name !== 'command-palette').map(([name, action]): KeyPickerOption => ({ id: name, label: action.description, detail: keysFor(binding => binding === name) || name, onSelect: () => runKeyAction(name) }));
  // keep one terminal command option even when it has several aliases
  const terminals = shortcutCommands(baseTables, {}).flatMap((command): KeyPickerOption[] => {
    // operator-disabled terminal commands remain unavailable
    if (!isTerminalBinding(command.binding) || command.unavailable) return [];
    const origin = command.origins.find(candidate => candidate.source !== 'removed')!;
    const detail = command.shortcuts.filter(shortcut => !shortcut.conflicted).map(shortcut => shortcut.table === 'root' ? readableShortcut(shortcut.chord) : `${shortcut.table} ${readableShortcut(shortcut.chord)}`).join(', ');
    return [{ id: command.id, label: `Open ${terminalProgramName(command.binding.terminal)}`, detail: detail || 'No active shortcut', onSelect: () => runKeyAction(terminalBindingAction, undefined, { table: origin.table, chord: origin.chord, binding: command.binding }) }];
  });
  return <KeyPicker title="Command palette" placeholder="Run a command" options={[...actions, ...terminals]} onClose={onClose} />;
}

// keep a countdown's duration stable while its keypress labels update
function KeyIndicatorTimer({ expiresAt }: { expiresAt: number }) {
  const [duration] = useState(() => Math.max(0, expiresAt - Date.now()));
  return <span className="key-indicator-bar" style={{ animationDuration: `${duration}ms` }} />;
}

// place feedback above the current split's composer and terminal helper controls
function useKeyIndicatorPosition(target: Element | null) {
  const [position, setPosition] = useState<{ right: number; bottom: number; maxWidth: string }>();
  // follow resized composers, split navigation and the software keyboard
  useLayoutEffect(() => {
    const panelSelector = '.log-split > *';
    let observedPanel: Element | null | undefined;
    // derive an anchor from visible controls rather than a fixed composer height
    const update = () => {
      const panel = document.activeElement?.closest(panelSelector) ?? (target?.isConnected === true ? target.closest(panelSelector) : null);
      // workspace chrome still needs clearance above visible split input forms
      const scope = panel ?? document.querySelector('.log-split');
      const controls = Array.from(scope?.querySelectorAll<HTMLElement>('.agent-composer, .question-prompt, .mobile-terminal-keys') ?? []);
      // move observations when a shortcut focuses a different split
      if (scope !== observedPanel) {
        observer.disconnect();
        observedPanel = scope;
        // keep global shortcuts aligned when the workspace resizes
        if (scope !== null) observer.observe(scope);
        controls.forEach(control => observer.observe(control));
      }
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth);
      const rect = panel?.getBoundingClientRect();
      const panelRight = rect === undefined ? right : Math.min(right, rect.right);
      let anchor = Math.min(bottom - 92, rect?.bottom ?? bottom);
      // avoid every visible input bar within this split
      for (const control of controls) {
        const bounds = control.getBoundingClientRect();
        // hidden mobile controls have no layout box
        if (bounds.width > 0 && bounds.height > 0) anchor = Math.min(anchor, bounds.top);
      }
      setPosition({ right: Math.max(12, window.innerWidth - panelRight + 12), bottom: Math.max(12, window.innerHeight - Math.max(top + 72, anchor) + 12), maxWidth: `${Math.max(0, Math.min(512, panelRight - Math.max(viewport?.offsetLeft ?? 0, rect?.left ?? 0) - 24))}px` });
    };
    const observer = new ResizeObserver(update);
    window.addEventListener('focusin', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();
    // release geometry listeners when the feedback disappears
    return () => {
      observer.disconnect();
      window.removeEventListener('focusin', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [target]);
  return position;
}

// render pending leaders and completed commands as one fading group
function KeyIndicatorFeedback({ feedback, state }: { feedback: KeyPressFeedback | undefined; state: KeyDispatchState | undefined }) {
  const position = useKeyIndicatorPosition(feedback?.target ?? null);
  const chords = feedback?.chords ?? [];
  const sequence = chords.map(keys => keys.join(' + ')).join(' then ');
  const matched = feedback?.matched ?? true;
  const pending = state !== undefined && (state.confirm !== undefined || !state.repeat);
  const expiresAt = pending ? state.expiresAt : feedback!.expiresAt;
  // geometry updates must not shorten the shared fade
  const [duration] = useState(() => Math.max(0, expiresAt - Date.now()));
  const label = state?.confirm ?? (pending ? state.table === 'prefix' ? readableShortcut(state.chord!) : state.table : undefined);
  const accessibleLabel = state?.confirm ?? (pending ? `Key table ${label}` : `Key press ${sequence}`);
  // do not flash a guessed position before the split geometry is measured
  if (position === undefined) return null;
  return createPortal(<div style={{ ...position, animationDuration: `${duration}ms` }} className={`key-indicator${matched ? ' matched' : ''}${pending ? '' : ' completed'}${state?.confirm === undefined ? '' : ' confirm'}`} role="status" aria-live={pending ? 'polite' : 'off'} aria-label={`${accessibleLabel}, ${matched ? 'binding matched' : 'no binding matched'}`}>
    {chords.length > 0 && <span className="key-indicator-label">{chords.map((keys, index) => <Fragment key={index}>{index > 0 && <span className="key-indicator-next" aria-hidden="true">→</span>}<KeyCaps keys={keys} /></Fragment>)}</span>}
    {label !== undefined && (state?.confirm !== undefined || label !== sequence) && <span className="key-indicator-context">{label}{state?.confirm !== undefined && <kbd>y/n</kbd>}</span>}
    <KeyIndicatorTimer key={expiresAt} expiresAt={expiresAt} />
  </div>, document.body);
}

// keep programmatic confirmations available without illustrating normal typing
function KeyIndicator() {
  const state = useSyncExternalStore(dispatcher.subscribe, dispatcher.state);
  const feedback = useKeyPress();
  // hidden input never gets resurrected by a pending dispatch table
  if (feedback === undefined && state?.confirm === undefined) return null;
  return <KeyIndicatorFeedback key={feedback?.expiresAt ?? state?.expiresAt} feedback={feedback} state={state} />;
}

// The keyboard's listener and overlays, mounted once with the dashboard.
export function KeyboardLayer({ keys }: { keys?: KeysConfig }) {
  useEffect(installKeyboard, []);
  useEffect(() => setKeysConfig(keys), [keys]);
  const open = useOverlay();
  const close = () => setOverlay(undefined);
  return <>
    <KeyIndicator />
    {open === 'bindings' && <BindingsSheet onClose={close} />}
    {open === 'palette' && <CommandPalette onClose={close} />}
  </>;
}
