import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isTableBinding, keyActions, terminalProgramName, type KeyBinding } from '../../../server/src/config/keys.js';
import { editServerKeyTables, resetServerShortcuts, serverKeyTableModel, type ServerKeyTableEdit, type ServerKeyTableRow } from '../shortcut-config.js';
import { readableShortcut, ShortcutCaptureInput, ShortcutEditor, ShortcutKeys } from '../keyboard.js';
import { PanelIcon, panelIcons } from '../panel-header.js';
import { SettingsSelect } from './select.js';
import type { SettingsPatch } from './contracts.js';
import './key-tables-editor.css';

type BindingKind = 'action' | 'table' | 'terminal' | 'disabled';
type BindingForm = { original?: string; chord?: string; kind: BindingKind; action: string; target: string; terminal: string; reuse?: boolean };
type Props = { keys: unknown; disabled: boolean; navigationDisabled: boolean; readOnly: boolean; onChange: (patches: SettingsPatch[]) => boolean; onNavigate: () => boolean; renderProtectedTerminal: (table: string, rawChord: string) => ReactNode };

// describe bindings without leaking masked command arguments into row labels
const bindingDescription = (row: ServerKeyTableRow): string => row.binding === null ? 'Disabled binding' : row.protected ? 'Protected terminal command' : typeof row.binding === 'string' ? keyActions[row.binding]!.description : isTableBinding(row.binding) ? `Switch to the ${row.binding.table} table` : `Terminal running ${terminalProgramName(row.binding.terminal)}`;

// initialize editable forms from exact safe bytes rather than display placeholders
const bindingForm = (row?: ServerKeyTableRow): BindingForm => {
  const binding = row?.protected ? null : row?.binding;
  return { ...(row === undefined ? {} : { original: row.chord, chord: row.chord }), kind: row?.protected ? 'terminal' : binding === null ? 'disabled' : typeof binding === 'string' ? 'action' : binding !== undefined && isTableBinding(binding) ? 'table' : binding === undefined ? 'action' : 'terminal', action: typeof binding === 'string' ? binding : '', target: binding !== null && binding !== undefined && isTableBinding(binding) ? binding.table : '', terminal: binding !== null && typeof binding === 'object' && 'terminal' in binding ? binding.terminal : '', ...(binding !== null && typeof binding === 'object' && 'terminal' in binding && binding.reuse !== undefined ? { reuse: binding.reuse } : {}) };
};

// present one keyboard configuration view at a time against the same file-backed draft
export function KeyboardConfigurationEditor(props: Props) {
  const [view, setView] = useState('tables');
  return <div className="settings-keyboard-editor"><label className="settings-keyboard-view">Editor view<SettingsSelect label="Keyboard editor view" value={view} disabled={props.navigationDisabled} options={[{ value: 'tables', label: 'Key tables' }, { value: 'commands', label: 'Command shortcuts' }]} onChange={value => { /* unchanged selections preserve drafts and forms */ if (value === view || !props.onNavigate()) return; setView(value); }} /></label>{view === 'tables' ? <KeyTablesEditor {...props} /> : <ShortcutEditor keys={props.keys} disabled={props.disabled} onChange={props.onChange} />}</div>;
}

// edit actual tables and bindings using the shared chord recorder and custom menus
function KeyTablesEditor({ keys, disabled, navigationDisabled, readOnly, onChange, onNavigate, renderProtectedTerminal }: Props) {
  const model = useMemo(() => serverKeyTableModel(keys), [keys]);
  const [selected, setSelected] = useState('root');
  const [newTable, setNewTable] = useState('');
  const [rename, setRename] = useState<string>();
  const [form, setForm] = useState<BindingForm>();
  const [capture, setCapture] = useState<{ from: string; chord: string }>();
  const [error, setError] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const table = model.tables.find(candidate => candidate.name === selected) ?? model.tables[0];
  const unavailable = disabled || model.error !== undefined;
  // restore focus to a surviving opener after applying or canceling a local form
  const closeForm = () => { setForm(undefined); setCapture(undefined); setError(undefined); requestAnimationFrame(() => { /* avoid focusing controls that disappeared after a structural edit */ if (opener.current?.isConnected && !opener.current.disabled) opener.current.focus(); else editorRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }); };
  // discard local capture state when the selected table is removed or replaced
  useEffect(() => {
    // built-in root remains a safe fallback after table deletion or global discard
    if (!model.tables.some(candidate => candidate.name === selected)) { setSelected('root'); setForm(undefined); setCapture(undefined); setRename(undefined); }
  }, [model.tables, selected]);
  // authority loss clears forms while temporary save locks preserve unapplied input
  useEffect(() => { if (readOnly) { setForm(undefined); setCapture(undefined); setRename(undefined); } }, [readOnly]);
  // compile every table edit before adding any part of it to the shared draft
  const apply = (edit: ServerKeyTableEdit): boolean => {
    // never stage edits queued before a read-only or busy transition
    if (unavailable) return false;
    const result = editServerKeyTables(keys, edit);
    setError(result.error);
    // retain invalid forms for correction without partially staging their changes
    if (result.error !== undefined) return false;
    return onChange(result.patches ?? []);
  };
  // validate a complete binding before copying a command or disabling an old chord
  const applyBinding = () => {
    // incomplete selections are not defaults chosen on the operator's behalf
    if (form?.chord === undefined || table === undefined || unavailable) return;
    let binding: KeyBinding;
    // null is an explicit disabled row, not a missing override
    if (form.kind === 'disabled') {
      if (form.original !== undefined && form.original !== form.chord) { setError('Change the key separately before disabling its binding.'); return; }
      if (apply(form.original === undefined ? { kind: 'create-binding', table: table.name, chord: form.chord, binding: null } : { kind: 'remove-binding', table: table.name, chord: form.chord, mode: 'disable' })) closeForm();
      return;
    }
    // require explicit complete action and table choices
    if (form.kind === 'action') { if (!form.action) { setError('Choose an action.'); return; } binding = form.action; }
    else if (form.kind === 'table') { if (!form.target) { setError('Choose a destination table.'); return; } binding = { table: form.target }; }
    else binding = { terminal: form.terminal, ...(form.reuse === undefined ? {} : { reuse: form.reuse }) };
    // separate key moves keep protected data and inherited defaults in the compiler
    if (form.original !== undefined && form.original !== form.chord) { setError('Change the key separately, then edit its binding.'); return; }
    if (apply({ kind: form.original === undefined ? 'create-binding' : 'set-binding', table: table.name, chord: form.chord, binding })) closeForm();
  };
  // table navigation hides leases and abandons only unapplied form input
  const chooseTable = (name: string) => { /* reselecting the active table is not navigation */ if (name === table?.name || !onNavigate()) return; closeForm(); setRename(undefined); setSelected(name); };
  return <section ref={editorRef} className="settings-key-tables" role="region" aria-label="Edit key tables">
    <div className="settings-key-tables-header"><label>Key table<SettingsSelect label="Key table" value={table?.name ?? 'root'} disabled={navigationDisabled} options={model.tables.map(candidate => ({ value: candidate.name, label: candidate.name, group: candidate.builtIn ? 'Built-in tables' : 'Custom tables' }))} onChange={chooseTable} /></label><button type="button" disabled={disabled || !model.hasConfig && model.error === undefined} onClick={() => { /* restore defaults without mutating the running server */ if (onChange(resetServerShortcuts())) closeForm(); }}>Reset all key tables</button></div>
    {model.error !== undefined && <p className="shortcut-error" role="alert">{model.error} Reset key tables or repair the Application whole source.</p>}
    <div className="settings-key-table-create"><label>New table name<input value={newTable} disabled={unavailable} autoCapitalize="off" spellCheck={false} onChange={event => { /* retain unapplied table names locally */ setNewTable(event.target.value); }} /></label><button type="button" disabled={unavailable || !newTable} onClick={() => { /* an empty custom table is a real file-backed configuration */ if (apply({ kind: 'create-table', name: newTable })) { onNavigate(); setSelected(newTable); setNewTable(''); closeForm(); } }}>Add table</button></div>
    {table !== undefined && <>
      <header className="settings-key-table-heading"><div><h3>{table.name}</h3><p>{table.name === 'root' ? 'Always active. Use modified keys or function keys so normal typing stays available.' : table.name === 'prefix' ? 'The built-in prefix table. A root binding switches into it for the next shortcut.' : 'A binding in another table can switch into this custom table.'}</p></div><span className="settings-key-table-actions">{!table.builtIn && <button type="button" disabled={unavailable || table.rows.some(row => row.protected)} title={table.rows.some(row => row.protected) ? 'Replace or remove protected commands before renaming this table.' : 'Rename this table and update its switch targets.'} onClick={() => { /* retain a rename candidate without changing other tables */ setRename(table.name); }}>Rename table</button>}<button type="button" className={table.builtIn ? '' : 'danger'} disabled={unavailable || table.builtIn && !table.configured} aria-label={table.builtIn ? `Reset ${table.name} table` : `Remove ${table.name} table`} onClick={() => { /* inbound references must be repaired explicitly before removal */ if (apply({ kind: 'remove-table', name: table.name })) { onNavigate(); closeForm(); } }}>{!table.builtIn && <PanelIcon path={panelIcons.trash} />}{table.builtIn ? 'Reset table' : 'Remove table'}</button></span></header>
      {rename !== undefined && <div className="settings-key-table-create"><label>Table name<input value={rename} disabled={unavailable} autoCapitalize="off" spellCheck={false} onChange={event => { /* retain the rename until its complete graph validates */ setRename(event.target.value); }} /></label><button type="button" disabled={unavailable || !rename || rename === table.name} onClick={() => { /* stage the table and every inbound reference atomically */ if (apply({ kind: 'rename-table', from: table.name, to: rename })) { setSelected(rename); setRename(undefined); closeForm(); } }}>Apply table name</button><button type="button" onClick={() => setRename(undefined)}>Cancel rename</button></div>}
      {table.inbound.length > 0 && <p className="settings-key-table-inbound">Entered by: {table.inbound.map(reference => `${reference.table}: ${readableShortcut(reference.chord)}`).join(', ')}</p>}
      <div className="settings-key-table-rows" data-key-table={table.name}>{table.rows.map(row => <div className="settings-key-table-row" key={row.chord} data-key-chord={row.chord}>
        <div className="settings-key-table-row-heading"><button type="button" className="settings-key-table-chord" aria-label={`Change key ${row.chord} in ${table.name}`} title={row.protected ? 'Protected commands cannot be copied to another key. Replace or remove the binding first.' : 'Capture a new key for this binding.'} disabled={unavailable || row.protected} onClick={event => { /* reuse the normal recorder without dispatching the recorded key */ opener.current = event.currentTarget; setForm(undefined); setCapture({ from: row.chord, chord: row.chord }); setError(undefined); }}><ShortcutKeys chord={row.chord} /><PanelIcon path={panelIcons.editor} /></button><div className="settings-key-table-row-copy"><strong>{bindingDescription(row)}</strong><small>{row.source === 'default' ? 'Built-in default' : row.source === 'removed' ? 'Disabled in config' : row.source === 'replaced' ? 'Overrides a built-in default' : 'Configured binding'}</small></div><span className="settings-key-table-actions"><button type="button" disabled={unavailable} onClick={event => { /* protected commands are replaced only by explicit new values */ opener.current = event.currentTarget; setCapture(undefined); setForm(bindingForm(row)); setError(undefined); }}>Edit binding</button><button type="button" className="danger" aria-label={`Disable ${row.chord} in ${table.name}`} disabled={unavailable || row.binding === null} onClick={() => { /* disabling never restores a hidden built-in assignment */ apply({ kind: 'remove-binding', table: table.name, chord: row.chord, mode: 'disable' }); }}><PanelIcon path={panelIcons.trash} /></button><button type="button" className={row.builtInDefault ? '' : 'danger'} disabled={unavailable || !row.configured} onClick={() => { /* remove the override rather than disabling the inherited default */ apply({ kind: 'remove-binding', table: table.name, chord: row.chord, mode: 'restore' }); }}>{!row.builtInDefault && <PanelIcon path={panelIcons.trash} />}{row.builtInDefault ? 'Restore default' : 'Remove binding'}</button></span></div>
        {row.protected && <div className="settings-key-table-protected">{renderProtectedTerminal(table.name, row.rawChord)}<small>Protected commands stay in the file. Replace or remove this binding before moving its key or renaming its table.</small></div>}
        {capture?.from === row.chord && <div className="shortcut-recorder settings-key-table-capture"><ShortcutCaptureInput label={`New key for ${row.chord} in ${table.name}`} chord={capture.chord} disabled={unavailable} onCapture={chord => { /* retain the captured key until explicitly applied */ setCapture({ from: row.chord, chord }); setError(undefined); }} onCancel={closeForm} /><span>Press keys, then Apply shortcut. Escape cancels.</span><div className="settings-key-table-actions"><button type="button" disabled={unavailable} onClick={() => { /* the compiler preserves exact command bytes and original defaults */ if (apply({ kind: 'rename-binding', table: table.name, from: capture.from, to: capture.chord })) closeForm(); }}>Apply shortcut</button><button type="button" onClick={closeForm}>Cancel</button></div></div>}
      </div>)}</div>
      {table.rows.length === 0 && <p>This table has no bindings yet.</p>}
      {form !== undefined && <div className="settings-key-table-form shortcut-recorder" role="group" aria-label={form.original === undefined ? `New binding in ${table.name}` : `Edit binding ${form.original} in ${table.name}`}>
        {form.original === undefined ? <label>Key<ShortcutCaptureInput label={`Key for binding in ${table.name}`} chord={form.chord} disabled={unavailable} onCapture={chord => { /* capture new bindings with the same normal shortcut surface */ setForm({ ...form, chord }); setError(undefined); }} onCancel={closeForm} /></label> : <div><ShortcutKeys chord={form.original} /><small>Use the key's edit control to move this binding.</small></div>}
        <label>Binding type<SettingsSelect label="Binding type" value={form.kind} disabled={unavailable} options={[{ value: 'action', label: 'Action' }, { value: 'table', label: 'Switch table' }, { value: 'terminal', label: 'Terminal command' }, { value: 'disabled', label: 'Disabled' }]} onChange={kind => { /* choose a shape without staging an incomplete binding */ setForm({ ...form, kind: kind as BindingKind }); setError(undefined); }} /></label>
        {form.kind === 'action' && <label>Action<SettingsSelect label="Action" value={form.action} disabled={unavailable} options={[{ value: '', label: 'Choose an action…', disabled: true }, ...Object.entries(keyActions).map(([action, detail]) => ({ value: action, label: detail.description }))]} onChange={action => { /* require the operator's explicit action choice */ setForm({ ...form, action }); setError(undefined); }} /></label>}
        {form.kind === 'table' && <label>Switch to table<SettingsSelect label="Switch to table" value={form.target} disabled={unavailable} options={[{ value: '', label: 'Choose a table…', disabled: true }, ...model.tables.filter(candidate => candidate.name !== 'root').map(candidate => ({ value: candidate.name, label: candidate.name }))]} onChange={target => { /* target only existing named tables, never an arbitrary string */ setForm({ ...form, target }); setError(undefined); }} /></label>}
        {form.kind === 'terminal' && <><label>Terminal command<input value={form.terminal} disabled={unavailable} aria-label="New terminal command" autoCapitalize="off" spellCheck={false} onChange={event => { /* keep exact command bytes until the complete binding validates */ setForm({ ...form, terminal: event.target.value }); setError(undefined); }} /></label><div className="settings-key-table-reuse"><span>Reuse a matching terminal<small>Focus an existing terminal for this command instead of opening another one.</small></span><label className="client-settings-toggle"><input type="checkbox" role="switch" aria-label="Reuse a matching terminal" checked={form.reuse === true} disabled={unavailable} onChange={event => { /* preserve absence until the reuse control is explicitly changed */ setForm({ ...form, reuse: event.target.checked }); }} /><span className="client-settings-switch-state" aria-hidden="true">{form.reuse === true ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></div><small>Apply and Save never run this command.</small></>}
        <p>Apply binding adds this edit to the shared draft. Save changes persists all staged edits together.</p><div className="settings-key-table-actions"><button type="button" disabled={unavailable || form.chord === undefined} onClick={applyBinding}>Apply binding</button><button type="button" onClick={closeForm}>Cancel</button></div>
      </div>}
      {form === undefined && <button type="button" disabled={unavailable} onClick={event => { /* begin an empty form without assigning any default command */ opener.current = event.currentTarget; setCapture(undefined); setForm(bindingForm()); setError(undefined); }}>Add binding</button>}
    </>}
    {error !== undefined && <p className="shortcut-error" role="alert">{error}</p>}
  </section>;
}
