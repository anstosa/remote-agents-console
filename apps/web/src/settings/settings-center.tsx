import { Fragment, type MouseEventHandler, type ReactNode, type Ref, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SettingsHeaderActionsContext } from './header-actions.js';
import { appendSettingsPatch, effectiveSettingsPatches, hasSettingsDraftChanges, type SettingsDraft } from './draft-changes.js';
import { settingsDefaultPatches } from './schema-defaults.js';
import { applyAuthoredProjectPatch } from '../../../server/src/settings/project-normalization.js';
import { SettingsError } from '../../../server/src/settings/contracts.js';
import { useBrowserSettingsDraft, useSettingsBrowserDraftState, type BrowserSettingsIdentity } from './browser-settings.js';
import type { SettingsChange, SettingsEnvironmentFallback, SettingsIssue, SettingsPatch, SettingsSchema, SettingsSnapshot, SettingsSource, SettingsValidation } from './contracts.js';
import { isProtectedValue, isSettingsSnapshot, settingsResponseError } from './contracts.js';
import { useSettingsRuntime } from './runtime.js';
import { SettingsCodeEditor } from './code-editor.js';
import { SettingsRevealButton } from './reveal-button.js';
import { useSettingsTerminalEditor } from './terminal-editor.js';
import { openBindingsSheet } from '../keyboard.js';
import { KeyboardConfigurationEditor } from './key-tables-editor.js';
import { RemoteServerFields, type RemoteServerDefaults } from './remote-server-fields.js';
import { PanelIcon, panelIcons } from '../panel-header.js';
import { SplitConfirmation } from '../split-confirmation.js';
import { SettingsSourceHandover, type SettingsHandoverChoices } from './source-handover.js';
import { isTmuxSettingsChange, tmuxEnvironmentKeys, tmuxEnvironmentKeysForInstallation } from './tmux-settings.js';
import { environmentKeysWithDedicatedControls } from './environment-fields.js';
import { SettingsSelect, type SettingsSelectOption } from './select.js';
import { editableIconSources, InstanceIconPreview, instanceIcons, isInstanceIconName } from './icon-preview.js';
import { composeOptionSettings, environmentDescription, knownEnvironmentKeys, labels as sourceLabels, protectedSettingIdentity } from '../../../server/src/settings/catalog.js';
import './settings.css';

type Draft = SettingsDraft;
type Disclosure = { sourceId: string; path: string[]; value: unknown; leaseId: string; expiresAt: string };
type SetPatch = (source: SettingsSource, patch: SettingsPatch, disclosureDerived?: boolean) => void;
type HideCollection = (source: SettingsSource, path: string[]) => void;
// let split lifecycle actions await explicit draft-discard consent
export type SettingsCloseGuard = { requestClose: () => Promise<boolean> };

// retain safe settings baselines and drafts across split remounts
export function useSettingsSession() {
  const runtime = useSettingsRuntime();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [sources, setSources] = useState<SettingsSource[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const browserDraft = useSettingsBrowserDraftState();
  const operationPending = useRef(false);
  const saveCancelled = useRef(false);
  // revoke captured saves even when their originating split is no longer mounted
  useEffect(() => { saveCancelled.current = true; }, [runtime.canMutate, runtime.securityEpoch]);
  // retire transactions with the shared session rather than a workspace view
  useEffect(() => () => { saveCancelled.current = true; }, []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadGeneration = useRef(0);
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [rawSourceIds, setRawSourceIds] = useState(() => new Set<string>());
  return { snapshot, setSnapshot, sources, setSources, drafts, setDrafts, browserDraft, operationPending, saveCancelled, loading, setLoading, saving, setSaving, loadGeneration, issues, setIssues, warnings, setWarnings, message, setMessage, error, setError, rawSourceIds, setRawSourceIds };
}

const rawFormats = new Set<SettingsSource['format']>(['compose', 'cloudflared', 'credentials', 'wrapper', 'svg']);
// reserve file navigation identities without inventing editable source data
const pendingSourceFormats = { app: 'json', env: 'env', installation: 'installation', 'compose-override': 'compose', cloudflared: 'cloudflared', 'cloudflared-credentials': 'credentials' } as const;
// reuse the authoritative labels before the installation catalog arrives
const pendingSourceNavigation: Pick<SettingsSource, 'id' | 'label' | 'format' | 'path'>[] = Object.entries(pendingSourceFormats).map(([id, format]) => ({ id, label: sourceLabels[id] ?? id, format }));
// keep dedicated and unused controls out of the application field tree
const dedicatedApplicationPaths = new Set(['name', 'defaultAgent', 'icon', 'keys', 'tmux', 'projects', 'proxy', 'integrations.realtime', 'integrations.realtime.enabled', 'integrations.realtime.name', 'integrations.realtime.context']);
// keep dedicated source selectors with their application and tmux consumers
const dedicatedInstallationPaths = new Set(['version', 'sources']);

// keep execution warnings out of Docker and the wrapper's plain editor
const trustedCodeFormats = new Set<SettingsSource['format']>(['json', 'cloudflared']);
// reserve built-in environment fields while allowing custom assignments to be deleted
const builtinEnvironmentKeys = new Set<string>(knownEnvironmentKeys);

// make machine keys readable without changing their identity
const labelForKey = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .replace(/[-_]+/gu, ' ')
  .replace(/^./u, character => character.toUpperCase())
  .replace(/\burl\b/giu, 'URL');

// retain a stable identity for one protected field
const disclosureKey = (sourceId: string, path: string[]): string => `${sourceId}\u0000${path.join('\u0000')}`;

// identify credential-bearing sources even when their saved credential is empty
const containsProtectedValue = (value: unknown): boolean => isProtectedValue(value) || value !== null && typeof value === 'object' && Object.values(value).some(containsProtectedValue);

// read one nested structured value
const valueAt = (value: unknown, path: string[]): unknown => {
  let current = value;
  // walk only own object properties
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

// clone and set one nested structured value
const setAt = (value: unknown, path: string[], nextValue: unknown): unknown => {
  // replace the root value
  if (path.length === 0) return nextValue;
  const [head, ...tail] = path;
  const collection = Array.isArray(value) ? [...value] : { ...(value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}) };
  const current = (collection as Record<string, unknown>)[head!];
  (collection as Record<string, unknown>)[head!] = setAt(current, tail, nextValue);
  return collection;
};

// clone and remove one nested structured value
const removeAt = (value: unknown, path: string[], index?: number): unknown => {
  // remove one array entry at the addressed collection
  if (index !== undefined) {
    const array = valueAt(value, path);
    if (!Array.isArray(array)) return value;
    const next = [...array];
    next.splice(index, 1);
    return setAt(value, path, next);
  }
  // root removal becomes undefined
  if (path.length === 0) return undefined;
  const [head, ...tail] = path;
  const collection = Array.isArray(value) ? [...value] : { ...(value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}) };
  // delete the addressed leaf
  if (tail.length === 0 && Array.isArray(collection) && /^\d+$/u.test(head!)) collection.splice(Number(head), 1);
  else if (tail.length === 0) delete (collection as Record<string, unknown>)[head!];
  else (collection as Record<string, unknown>)[head!] = removeAt((collection as Record<string, unknown>)[head!], tail);
  return collection;
};

// project one patch into the local typed preview
const applyLocalPatch = (value: unknown, patch: SettingsPatch, sourceId?: string): unknown => {
  // match authored project omission semantics without affecting other sources
  if (sourceId === 'app' && (patch.path[0] === 'projects' || patch.path.length === 0)) {
    try { return applyAuthoredProjectPatch(value, patch); }
    // keep invalid scalar text editable while retaining structural failures for validation
    catch (error) {
      // reject malformed paths and collection operations
      if (!(error instanceof SettingsError) || error.code !== 'invalid_settings_value' || patch.op !== 'set') throw error;
    }
  }
  // set one ordinary field
  if (patch.op === 'set') return setAt(value, patch.path, patch.value);
  // remove one field or collection member
  if (patch.op === 'remove') return removeAt(value, patch.path, patch.index);
  const array = valueAt(value, patch.path);
  // ignore malformed collection paths until server validation reports them
  if (!Array.isArray(array)) return value;
  const next = [...array];
  // add one collection member
  if (patch.op === 'insert') next.splice(patch.index ?? next.length, 0, patch.value);
  // move one collection member
  else if (patch.from !== undefined && patch.to !== undefined) {
    const [entry] = next.splice(patch.from, 1);
    next.splice(patch.to, 0, entry);
  }
  return setAt(value, patch.path, next);
};

// keep expected leaf revisions aligned with local collection edits
const applyRevisionPatch = (revisions: Record<string, string> | undefined, patch: SettingsPatch): Record<string, string> | undefined => {
  if (revisions === undefined || patch.op === 'set') return revisions;
  const next: Record<string, string> = {};
  const pathMember = patch.path.at(-1);
  const indexedRemoval = patch.op === 'remove' && patch.index === undefined && pathMember !== undefined && /^\d+$/u.test(pathMember);
  const collectionPath = indexedRemoval ? patch.path.slice(0, -1) : patch.path;
  const removalIndex = indexedRemoval ? Number(pathMember) : patch.index;
  // rewrite only revision keys with valid path arrays
  for (const [encoded, revision] of Object.entries(revisions)) {
    let path: unknown;
    try { path = JSON.parse(encoded); } catch { next[encoded] = revision; continue; }
    if (!Array.isArray(path) || !path.every(segment => typeof segment === 'string')) { next[encoded] = revision; continue; }
    const prefix = collectionPath.every((segment, index) => path[index] === segment);
    // removing a leaf invalidates its revisions
    if (patch.op === 'remove' && !indexedRemoval && patch.index === undefined && prefix) continue;
    const member = path[collectionPath.length];
    // retain paths outside the edited collection
    if (!prefix || member === undefined || !/^\d+$/u.test(member)) { next[encoded] = revision; continue; }
    let index = Number(member);
    // shift inserted collection members
    if (patch.op === 'insert' && patch.index !== undefined && index >= patch.index) index += 1;
    // drop and shift removed collection members
    if (patch.op === 'remove' && removalIndex !== undefined) {
      if (index === removalIndex) continue;
      if (index > removalIndex) index -= 1;
    }
    // remap every member affected by a move
    if (patch.op === 'move' && patch.from !== undefined && patch.to !== undefined) {
      if (index === patch.from) index = patch.to;
      else if (patch.from < patch.to && index > patch.from && index <= patch.to) index -= 1;
      else if (patch.to < patch.from && index >= patch.to && index < patch.from) index += 1;
    }
    const remapped = [...path];
    remapped[collectionPath.length] = String(index);
    next[JSON.stringify(remapped)] = revision;
  }
  return next;
};

// detect explicit default metadata including null and false
const hasSchemaDefault = (schema: SettingsSchema | undefined): boolean => schema !== undefined && Object.hasOwn(schema, 'default');

// choose a usable initial value for new optional fields and collection entries
const defaultForSchema = (schema?: SettingsSchema, includeMetadataDefault = true): unknown => {
  // honor a server-provided semantic template
  if (includeMetadataDefault && hasSchemaDefault(schema)) return structuredClone(schema!.default);
  if (schema?.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, child]) => !child.optional).map(([key, child]) => [key, defaultForSchema(child, includeMetadataDefault)]));
  if (schema?.type === 'array') return [];
  if (schema?.type === 'record') return {};
  if (schema?.type === 'boolean') return false;
  if (schema?.type === 'number') return 0;
  if (schema?.type === 'enum') return schema.options?.[0] ?? '';
  if (schema?.type === 'json') return null;
  if (schema?.type === 'union') return defaultForSchema(schema.variants?.[0], includeMetadataDefault);
  return '';
};

// infer a rendering schema only when the server omits optional presentation hints
const inferSchema = (value: unknown): SettingsSchema => {
  if (Array.isArray(value)) return { type: 'array', items: inferSchema(value[0]) };
  if (value !== null && typeof value === 'object' && !isProtectedValue(value)) return { type: 'object', properties: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, inferSchema(child)])) };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'string') return { type: 'string' };
  return { type: 'json' };
};

// select the union branch that owns the current primitive or object keys
const matchesSchemaValue = (schema: SettingsSchema, value: unknown): boolean => {
  if (schema.type === 'enum' || schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number' || schema.type === 'boolean') return typeof value === schema.type;
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(schema.properties ?? {}).some(key => Object.hasOwn(value as object, key));
  if (schema.type === 'record') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return schema.type === 'json';
};

// distinguish the newest protected replacement from an explicit removal
const replacementPatch = (draft: Draft | undefined, path: string[]): SettingsPatch | undefined => {
  // search backward so later edits win
  for (let index = (draft?.patches.length ?? 0) - 1; index >= 0; index -= 1) {
    const patch = draft!.patches[index]!;
    if ((patch.op === 'set' || patch.op === 'remove') && patch.path.length === path.length && patch.path.every((segment, part) => segment === path[part])) return patch;
  }
  return undefined;
};

// distinguish file edits from an optional handover choice
const hasDraftMutation = (draft: Draft | undefined): boolean => draft !== undefined && (draft.patches.length > 0 || draft.content !== undefined || draft.remove !== undefined);

// preview only ordinary or server-redacted artwork never revealed credential bytes
const iconPreviewContent = (source: SettingsSource, draft?: Draft): string | undefined => draft?.content !== undefined && !draft.disclosureContent ? draft.content : source.content ?? (source.exists && !source.protected && typeof source.value === 'string' ? source.value : undefined);

// render issues belonging to one exact field path
function FieldIssues({ issues, sourceId, path }: { issues: SettingsIssue[]; sourceId: string; path: string[] }) {
  const matches = issues.filter(issue => issue.sourceId === sourceId && issue.path.join('\u0000') === path.join('\u0000'));
  // omit unused validation space
  if (matches.length === 0) return null;
  return <>{matches.map(issue => <span key={`${issue.code}:${issue.message}`} className="settings-field-error" role="alert">{issue.message}</span>)}</>;
}

type CollectionSummary = { primary: string; secondary?: string };

const collectionProtectionReason = 'Save or discard the protected replacement before reordering or deleting this list.';

// compare a path with one collection subtree
const pathStartsWith = (candidate: string[], prefix: string[]): boolean => prefix.every((segment, index) => candidate[index] === segment);

// keep summaries compact without serializing structured values
const truncateCollectionSummary = (value: string): string => value.length > 120 ? `${value.slice(0, 117)}…` : value;

// identify schema branches that can hold protected values
const schemaContainsProtected = (schema: SettingsSchema | undefined): boolean => {
  // stop at an explicitly protected node
  if (schema?.protected === true) return true;
  // inspect named object fields without reading their values
  if (schema?.type === 'object') return Object.entries(schema.properties ?? {}).some(([key, child]) => protectedSettingIdentity(key) || schemaContainsProtected(child));
  // inspect one homogeneous collection item schema
  if (schema?.type === 'array' || schema?.type === 'record') return schemaContainsProtected(schema.items);
  // treat any protected union branch conservatively
  if (schema?.type === 'union') return (schema.variants ?? []).some(schemaContainsProtected);
  return false;
};

// identify protection at or below one relative schema path
const schemaPathProtected = (schema: SettingsSchema | undefined, path: string[]): boolean => {
  // retain protection inherited by the current node
  if (schema?.protected === true) return true;
  // an authored parent replacement may include protected descendants
  if (path.length === 0) return schemaContainsProtected(schema);
  const [head, ...tail] = path;
  // protect sensitive identities even when an older schema omitted the flag
  if (protectedSettingIdentity(head!)) return true;
  // inspect every possible union branch
  if (schema?.type === 'union') return (schema.variants ?? []).some(variant => schemaPathProtected(variant, path));
  // advance through typed containers
  if (schema?.type === 'array' || schema?.type === 'record') return schemaPathProtected(schema.items, tail);
  if (schema?.type === 'object') return schemaPathProtected(schema.properties?.[head!], tail);
  return false;
};

// block index-changing operations while an authored protected replacement is pending
const hasAuthoredProtectedCollectionDraft = (source: SettingsSource, draft: Draft | undefined, path: string[], schema: SettingsSchema): boolean => {
  const disclosurePaths = new Set(draft?.disclosurePaths ?? []);
  return (draft?.patches ?? []).some(candidate => {
    // only authored sets can carry replacement plaintext
    if (candidate.op !== 'set' || disclosurePaths.has(JSON.stringify(candidate.path)) || !pathStartsWith(candidate.path, path)) return false;
    // use redacted source metadata and schema identity, never the draft value
    return containsProtectedValue(valueAt(source.value, candidate.path)) || schemaPathProtected(schema, candidate.path.slice(path.length));
  });
};

// summarize one safe scalar without reading protected markers
const safeSummaryScalar = (value: unknown, schema: SettingsSchema | undefined, key?: string): string | undefined => {
  // omit every protected value and sensitive identity
  if (schema?.protected === true || isProtectedValue(value) || key !== undefined && protectedSettingIdentity(key)) return undefined;
  // retain useful scalar identity
  if (typeof value === 'string') return value.trim() ? truncateCollectionSummary(value.trim()) : undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return undefined;
};

// summarize an item using safe identity fields before a field-count fallback
const collectionItemSummary = (value: unknown, schema: SettingsSchema | undefined, plainPath = false): CollectionSummary => {
  // overlapping union shapes must not choose a weaker protection policy
  if (schema?.type === 'union' && schemaContainsProtected(schema)) return { primary: 'Protected value configured' };
  const resolvedSchema = schema?.type === 'union' ? schema.variants?.find(candidate => matchesSchemaValue(candidate, value)) ?? schema.variants?.[0] : schema;
  // never inspect values protected at the item or active union-variant boundary
  if (schema?.protected === true || resolvedSchema?.protected === true || isProtectedValue(value)) return { primary: 'Protected value configured' };
  const scalar = safeSummaryScalar(value, resolvedSchema);
  // show primitive collection members directly
  if (scalar !== undefined) return { primary: scalar };
  // describe nested arrays without expanding their contents
  if (Array.isArray(value)) return { primary: `${value.length} ${value.length === 1 ? 'item' : 'items'}` };
  // keep absent values opaque
  if (value === null || typeof value !== 'object') return { primary: 'Empty value' };
  const record = value as Record<string, unknown>;
  const properties = resolvedSchema?.type === 'object' ? resolvedSchema.properties ?? {} : {};
  const priority = ['name', 'label', 'title', 'url', 'path', 'id'];
  const orderedKeys = [...priority.filter(key => Object.hasOwn(record, key)), ...Object.keys(record).filter(key => !priority.includes(key))];
  const fields: Array<{ key: string; value: string }> = [];
  let safeFieldCount = 0;
  // collect at most two safe scalar details while counting useful fields
  for (const key of orderedKeys) {
    const childSchema = properties[key] ?? (resolvedSchema?.type === 'record' ? resolvedSchema.items : undefined);
    // omit protected branches from both text and counts
    if (childSchema?.protected === true || protectedSettingIdentity(key) || isProtectedValue(record[key])) continue;
    safeFieldCount += 1;
    const field = safeSummaryScalar(record[key], childSchema, key);
    // retain only compact scalar details
    if (field !== undefined && fields.length < 2) fields.push({ key, value: field });
  }
  // prefer a real saved identity over generated numbering
  if (fields.length > 0) return { primary: fields[0]!.value, ...(fields[1] === undefined ? {} : { secondary: plainPath && fields[1]!.key === 'path' ? fields[1]!.value : `${labelForKey(fields[1]!.key)}: ${fields[1]!.value}` }) };
  // fall back to a safe shape description
  if (safeFieldCount > 0) return { primary: `${safeFieldCount} configured ${safeFieldCount === 1 ? 'field' : 'fields'}` };
  return { primary: 'Empty item' };
};

// find validation errors hidden below one collapsed item
const collectionItemIssues = (issues: SettingsIssue[], sourceId: string, path: string[]): SettingsIssue[] => issues.filter(issue => issue.sourceId === sourceId && pathStartsWith(issue.path, path));

// create one valid stable relationship id from source and path identity
const collectionEditorId = (sourceId: string, path: string[]): string => `settings-collection-${encodeURIComponent(JSON.stringify([sourceId, ...path]))}`;

// edit a free-form JSON field while retaining invalid draft text for correction
function JsonField({ source, value, disabled, ariaLabel, onChange, fieldAction }: { source: SettingsSource; value: unknown; disabled: boolean; ariaLabel?: string; onChange: (value: unknown) => void; fieldAction?: ReactNode }) {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const [text, setText] = useState(serialized);
  const [error, setError] = useState('');
  useEffect(() => { setText(serialized); setError(''); }, [serialized]);
  // parse only on explicit field completion
  const commit = () => {
    try {
      onChange(JSON.parse(text));
      setError('');
    } catch {
      setError('Enter valid JSON before saving.');
    }
  };
  return <><SettingsCodeEditor ariaLabel={ariaLabel ?? "JSON value"} value={text} disabled={disabled} format="json" editorSource={source} fieldAction={fieldAction} onChange={setText} onBlur={commit} />{error && <span className="settings-field-error" role="alert">{error}</span>}</>;
}

// hash a replacement login password without exposing the stored original
function PasswordReplacement({ disabled, onHash }: { disabled: boolean; onHash: (hash: string) => void }) {
  const { request, securityEpoch } = useSettingsRuntime();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // discard replacement plaintext on reconnect and controller lifecycle changes
  useEffect(() => { setPassword(''); setConfirm(''); setError(''); setOpen(false); }, [securityEpoch]);
  // exchange plaintext for a validated hash in memory
  const submit = async () => {
    if (password.length === 0 || password !== confirm) { setError(password.length === 0 ? 'Enter a password.' : 'Passwords do not match.'); return; }
    setPending(true);
    try {
      const response = await request('/api/settings/password/hash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      const payload = await response.json().catch(() => undefined) as { hash?: unknown; error?: unknown } | undefined;
      // accept only a returned hash string
      if (!response.ok || typeof payload?.hash !== 'string') { setError(typeof payload?.error === 'string' ? payload.error : 'Password could not be prepared.'); return; }
      onHash(payload.hash);
      setPassword(''); setConfirm(''); setOpen(false); setError('');
    } finally {
      setPending(false);
    }
  };
  // keep the replacement fields absent until requested
  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Set new password</button>;
  return <div className="settings-password-replacement">
    <label>New password<input type="password" autoComplete="new-password" value={password} disabled={disabled || pending} onChange={event => setPassword(event.target.value)} /></label>
    <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} disabled={disabled || pending} onChange={event => setConfirm(event.target.value)} /></label>
    {error && <span className="settings-field-error" role="alert">{error}</span>}
    <span className="settings-inline-actions"><button type="button" disabled={disabled || pending} onClick={() => { setPassword(''); setConfirm(''); setError(''); setOpen(false); }}>Cancel</button><button type="button" disabled={disabled || pending} onClick={() => { /* hash this replacement */ void submit(); }}>{pending ? 'Preparing…' : 'Use password'}</button></span>
  </div>;
}

type SettingsRemoveButtonProps = {
  ariaLabel?: string;
  disabled: boolean;
  label?: string;
  labelClassName?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  title?: string;
};

// keep every destructive settings action visually and semantically consistent
function SettingsRemoveButton({ ariaLabel, disabled, label = 'Remove', labelClassName, onClick, title }: SettingsRemoveButtonProps) {
  return <button type="button" className="danger settings-remove-button" aria-label={ariaLabel} title={title} disabled={disabled} onClick={onClick}><PanelIcon path={panelIcons.trash} /><span className={labelClassName}>{label}</span></button>;
}

// edit one masked setting without ever serializing its placeholder
function ProtectedField({ source, path, label, headingAction, description, fallback, schema, draft, disclosure, disabled, showRemove = true, onReveal, onRemask, onPatch }: { source: SettingsSource; path: string[]; label: string; headingAction?: ReactNode; description?: string; fallback?: SettingsEnvironmentFallback; schema?: SettingsSchema; draft?: Draft; disclosure?: Disclosure; disabled: boolean; showRemove?: boolean; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void>; onPatch: SetPatch }) {
  const key = disclosureKey(source.id, path);
  const patch = replacementPatch(draft, path);
  const replacement = patch?.op === 'set' ? patch.value : undefined;
  const removed = patch?.op === 'remove';
  const [replace, setReplace] = useState(false);
  const [replacementVisible, setReplacementVisible] = useState(false);
  const runtime = useSettingsRuntime();
  const shown = removed ? undefined : patch?.op === 'set' ? replacement : disclosure?.value;
  const masked = valueAt(source.value, path);
  const present = !removed && (isProtectedValue(masked) ? masked.present : masked !== undefined);
  const savedHasValue = isProtectedValue(masked) ? masked.hasValue ?? masked.present : masked !== undefined && masked !== null && masked !== '';
  const hasValue = !removed && (replacement !== undefined ? replacement !== '' && replacement !== null : savedHasValue);
  const revealed = disclosure !== undefined || replacement !== undefined && replacementVisible;
  const visible = shown !== undefined && revealed;
  const independentlyAuthored = patch !== undefined && !draft?.disclosurePaths?.includes(JSON.stringify(path));
  const passwordHash = path.at(-1) === 'RAC_PASSWORD_HASH';
  const environmentField = source.format === 'env';
  // keep safe fallback text in the placeholder without assigning a value
  const placeholder = environmentField ? fallback?.value : undefined;
  const projectScalar = source.id === 'app' && path[0] === 'projects' && path.length >= 3 && (schema === undefined || ['string', 'number', 'boolean', 'enum'].includes(schema.type));
  const directScalar = environmentField || projectScalar;
  const structured = schema !== undefined && !['string', 'number', 'boolean', 'enum'].includes(schema.type) || shown !== undefined && typeof shown === 'object';
  const structuredDefault = useMemo(() => defaultForSchema(schema, false), [schema]);
  // clear replacement mode after a successful draft reset
  useEffect(() => { if (replacement === undefined && draft === undefined) setReplace(false); }, [draft, replacement]);
  // hide locally authored values when source or security authority changes
  useEffect(() => { setReplacementVisible(false); setReplace(false); }, [source.id, source.revisionId, runtime.securityEpoch]);
  // keep authored key drafts but hide their plaintext across page lifecycle boundaries
  useEffect(() => {
    const hide = () => { setReplacementVisible(false); setReplace(false); };
    window.addEventListener('pagehide', hide);
    return () => window.removeEventListener('pagehide', hide);
  }, []);
  // revoke saved leases superseded by authored values or removal including late responses
  useEffect(() => {
    // independently authored drafts must not retain the saved key's disclosure lease
    if (independentlyAuthored && disclosure !== undefined) void onRemask(key);
  }, [independentlyAuthored, disclosure, key, onRemask]);
  // reveal saved keys through leases and toggle authored replacements only locally
  const toggle = async () => {
    // revoking a lease also discards disclosure-derived edits
    if (disclosure !== undefined) { setReplacementVisible(false); await onRemask(key); return; }
    // never fetch an old saved value over a locally authored replacement
    if (replacement !== undefined) { setReplacementVisible(current => !current); return; }
    await onReveal(source, path);
  };
  const eye = hasValue || disclosure !== undefined ? <SettingsRevealButton label={label} revealed={revealed} disabled={disabled} onToggle={toggle} /> : undefined;
  // clear optional direct fields without retaining a saved disclosure lease
  const editDirectValue = (value: string) => {
    setReplacementVisible(true);
    const remove = value === '' && (environmentField || schema?.optional === true);
    onPatch(source, remove ? { op: 'remove', path } : { op: 'set', path, value }, !remove && disclosure !== undefined);
  };
  let scalarControl: ReactNode = <span className="settings-masked-value" aria-label={`${label} masked`}>{hasValue ? '••••••••' : 'Not set'}</span>;
  // empty direct values need no saved secret disclosure
  if (directScalar && (visible || !hasValue)) {
    const value = typeof shown === 'string' ? shown : '';
    scalarControl = /[\r\n]/u.test(value) ? <textarea aria-label={label} value={value} placeholder={placeholder} disabled={disabled} spellCheck={false} onChange={event => editDirectValue(event.target.value)} /> : <input type="text" aria-label={label} value={value} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => editDirectValue(event.target.value)} />;
  // preserve multiline editing for non-environment protected values
  } else if (visible) {
    scalarControl = <textarea aria-label={label} value={typeof shown === 'string' ? shown : String(shown)} disabled={disabled} spellCheck={false} onChange={event => onPatch(source, { op: 'set', path, value: event.target.value }, disclosure !== undefined)} />;
  }
  // keep environment credentials in the ordinary field layout
  return <div className={`settings-field settings-protected-field${environmentField ? ' settings-environment-field' : ''}`} data-settings-path={path.join('.')}>
    <div className="settings-field-summary"><span className="settings-field-copy"><span className="settings-field-heading">{headingAction === undefined ? <strong>{label}</strong> : <span className="settings-environment-key"><strong>{label}</strong>{headingAction}</span>}{!environmentField && <span className="settings-field-badges"><span className="settings-protected-badge">Protected</span></span>}</span>{description && <small>{description}</small>}</span>{showRemove && !environmentField && present && <SettingsRemoveButton ariaLabel={`Remove ${label}`} title={`Remove ${label}`} disabled={disabled} onClick={() => onPatch(source, { op: 'remove', path })} />}</div>
    {visible && structured ? <JsonField source={source} value={shown} disabled={disabled} ariaLabel={label} fieldAction={eye} onChange={value => onPatch(source, { op: 'set', path, value }, disclosure !== undefined)} /> : <div className={`settings-secret-control${environmentField ? ' settings-environment-secret-control' : ''}`}>{scalarControl}{eye}</div>}
    {!directScalar && <span className="settings-inline-actions">
      {!passwordHash && (shown === undefined || !hasValue) && <button type="button" disabled={disabled} onClick={() => { /* explicitly edit a new value without disclosing the saved key */ setReplace(true); setReplacementVisible(true); }}>Replace without revealing</button>}
    </span>}
    {!directScalar && replace && (shown === undefined || !hasValue) && <div className="settings-blind-replace"><span>New value</span>{structured ? <JsonField source={source} value={structuredDefault} disabled={disabled} ariaLabel={`New ${label}`} onChange={value => onPatch(source, { op: 'set', path, value })} /> : <textarea autoFocus aria-label={`New ${label}`} disabled={disabled} spellCheck={false} onChange={event => onPatch(source, { op: 'set', path, value: event.target.value })} />}</div>}
    {passwordHash && <PasswordReplacement disabled={disabled} onHash={hash => onPatch(source, { op: 'set', path, value: hash })} />}
  </div>;
}

// edit arbitrary record keys through compact summaries
function RecordField({ source, schema, value, path, draft, issues, disabled, navigationDisabled, renderChild, onPatch, onHideCollection }: { source: SettingsSource; schema: SettingsSchema; value: unknown; path: string[]; draft?: Draft; issues: SettingsIssue[]; disabled: boolean; navigationDisabled: boolean; renderChild: (schema: SettingsSchema, value: unknown, path: string[], key: string) => ReactNode; onPatch: SetPatch; onHideCollection?: HideCollection }) {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const [newKey, setNewKey] = useState('');
  const [openKeys, setOpenKeys] = useState(() => new Set<string>());
  const item = schema.items ?? { type: 'string' };
  const protectedDraft = hasAuthoredProtectedCollectionDraft(source, draft, path, schema);
  // remove editor state for keys removed outside this control
  useEffect(() => {
    setOpenKeys(current => {
      const next = new Set([...current].filter(key => Object.hasOwn(record, key)));
      return next.size === current.size ? current : next;
    });
  }, [record]);
  // toggle one stable keyed editor without changing its draft
  const toggle = (key: string) => {
    // revoke hidden descendants before scheduling collapse
    if (openKeys.has(key)) onHideCollection?.(source, [...path, key]);
    setOpenKeys(current => {
      const next = new Set(current);
      // flip only this keyed editor
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // delete one key after closing only its stable subtree
  const remove = (key: string) => {
    onHideCollection?.(source, [...path, key]);
    setOpenKeys(current => { const next = new Set(current); next.delete(key); return next; });
    onPatch(source, { op: 'remove', path: [...path, key] });
  };
  // insert only a new nonempty record key
  const add = () => {
    const key = newKey.trim();
    // preserve existing keyed values
    if (!key || Object.hasOwn(record, key)) return;
    onPatch(source, { op: 'set', path: [...path, key], value: defaultForSchema(item) });
    setOpenKeys(current => new Set(current).add(key));
    setNewKey('');
  };
  return <div className="settings-record settings-collection" data-settings-collection="record" data-settings-collection-path={path.join('.')}>
    {protectedDraft && <p className="settings-collection-protected-note" role="note">{collectionProtectionReason}</p>}
    {Object.entries(record).map(([key, entry]) => {
      const editing = openKeys.has(key);
      const editorId = collectionEditorId(source.id, [...path, key]);
      const summary = collectionItemSummary(entry, item);
      const entryIssues = collectionItemIssues(issues, source.id, [...path, key]);
      return <fieldset className="settings-record-entry settings-collection-entry" data-settings-collection-entry="record" data-settings-entry-key={key} data-settings-editing={editing ? 'true' : 'false'} key={key}>
        <legend className="sr-only">{key}</legend>
        <div className="settings-record-key settings-collection-entry-header"><span className="settings-collection-entry-copy"><code>{key}</code><span className="settings-collection-summary" title={summary.primary}>{summary.primary}</span>{summary.secondary && <small>{summary.secondary}</small>}{entryIssues.length > 0 && <span className="settings-collection-issue-badge" aria-label={`${entryIssues.length} validation ${entryIssues.length === 1 ? 'issue' : 'issues'}`}>{entryIssues.length}</span>}</span><span className="settings-collection-actions"><button type="button" className="settings-collection-edit" aria-label={`${editing ? 'Close' : 'Edit'} ${key}`} aria-expanded={editing} aria-controls={editorId} disabled={navigationDisabled} onClick={() => { /* toggle this keyed editor */ toggle(key); }}><PanelIcon path={editing ? panelIcons.close : panelIcons.editor} /><span>{editing ? 'Close' : 'Edit'}</span></button><SettingsRemoveButton ariaLabel={`Remove ${key}`} title={protectedDraft ? collectionProtectionReason : `Remove ${key}`} disabled={disabled || protectedDraft} onClick={() => { /* remove this keyed entry */ remove(key); }} /></span></div>
        {!editing && entryIssues.length > 0 && <span className="settings-collection-issue" role="alert">{entryIssues[0]!.message}</span>}
        {editing && <div className="settings-collection-editor" id={editorId}>{renderChild(item, entry, [...path, key], key)}</div>}
      </fieldset>;
    })}
    <div className="settings-record-add settings-collection-add"><label>New key<input value={newKey} disabled={disabled} onChange={event => setNewKey(event.target.value)} onKeyDown={event => { /* add from the key field */ if (event.key === 'Enter') { event.preventDefault(); add(); } }} /></label><button type="button" disabled={disabled || !newKey.trim() || Object.hasOwn(record, newKey.trim())} onClick={add}>Add entry</button></div>
  </div>;
}

type CollectionEntryProps = {
  label: string;
  itemLabel: string;
  visibleLabel?: string;
  index: number;
  count: number;
  firstMovableIndex?: number;
  summary: CollectionSummary;
  issues: SettingsIssue[];
  editing: boolean;
  editorId: string;
  disabled: boolean;
  navigationDisabled: boolean;
  structuralReason?: string;
  confirming: boolean;
  confirmProjectRemoval: boolean;
  onEdit: () => void;
  onMove: (to: number) => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  children: ReactNode;
};

// keep compact collection actions and confirmation inside one row
function CollectionEntry({ label, itemLabel, visibleLabel, index, count, firstMovableIndex = 0, summary, issues, editing, editorId, disabled, navigationDisabled, structuralReason, confirming, confirmProjectRemoval, onEdit, onMove, onRequestRemove, onCancelRemove, onRemove, children }: CollectionEntryProps) {
  const structureDisabled = disabled || structuralReason !== undefined || confirming;
  const moveUpTitle = structuralReason ?? `Move ${label} ${index + 1} up`;
  const moveDownTitle = structuralReason ?? `Move ${label} ${index + 1} down`;
  const removeTitle = structuralReason ?? `Remove ${label} ${index + 1}`;
  return <fieldset className="settings-collection-entry settings-array-entry" data-settings-collection-entry="array" data-settings-entry-index={index} data-settings-editing={editing ? 'true' : 'false'}><legend className="sr-only">{itemLabel}</legend><div className="settings-array-entry-header settings-collection-entry-header"><span className="settings-collection-entry-copy">{visibleLabel !== undefined && <strong>{visibleLabel}</strong>}<span className="settings-collection-summary" title={summary.primary}>{summary.primary}</span>{summary.secondary && <small>{summary.secondary}</small>}{issues.length > 0 && <span className="settings-collection-issue-badge" aria-label={`${issues.length} validation ${issues.length === 1 ? 'issue' : 'issues'}`}>{issues.length}</span>}</span><span className="settings-array-actions settings-collection-actions">
    <button type="button" className="settings-collection-edit" aria-label={`${editing ? 'Close' : 'Edit'} ${itemLabel}`} aria-expanded={editing} aria-controls={editorId} disabled={navigationDisabled || confirming} onClick={onEdit}><PanelIcon path={editing ? panelIcons.close : panelIcons.editor} /><span>{editing ? 'Close' : 'Edit'}</span></button>
    <button type="button" aria-label={`Move ${label} ${index + 1} up`} title={moveUpTitle} disabled={structureDisabled || index <= firstMovableIndex} onClick={() => { /* move one collection entry earlier */ onMove(index - 1); }}><PanelIcon path={panelIcons.moveUp} /></button>
    <button type="button" aria-label={`Move ${label} ${index + 1} down`} title={moveDownTitle} disabled={structureDisabled || index === count - 1} onClick={() => { /* move one collection entry later */ onMove(index + 1); }}><PanelIcon path={panelIcons.moveDown} /></button>
    <SettingsRemoveButton ariaLabel={`Remove ${label} ${index + 1}`} title={removeTitle} disabled={structureDisabled} labelClassName="settings-array-remove-label" onClick={() => { /* request project confirmation when required */ onRequestRemove(); }} />
  </span></div>{!editing && issues.length > 0 && <span className="settings-collection-issue" role="alert">{issues[0]!.message}</span>}{editing && <div className="settings-collection-editor" id={editorId}>{children}</div>}{confirming && confirmProjectRemoval && <div className="settings-project-remove-confirm" role="alertdialog" aria-label={`Remove ${itemLabel}`}><p>Remove this Project from RAC configuration? Repositories, Worktrees, state, agents, and stacks will not be deleted.</p><span><button type="button" onClick={onCancelRemove}>Keep Project</button><SettingsRemoveButton disabled={disabled || structuralReason !== undefined} title={structuralReason} label="Confirm remove" onClick={onRemove} /></span></div>}</fieldset>;
}

// edit ordered arrays through compact summaries
function ArrayField({ source, schema, value, path, draft, issues, label, itemLabel, disabled, navigationDisabled, renderChild, onPatch, onHideCollection, pinnedCount = 0, pinnedRows }: { source: SettingsSource; schema: SettingsSchema; value: unknown; path: string[]; draft?: Draft; issues: SettingsIssue[]; label: string; itemLabel: string; disabled: boolean; navigationDisabled: boolean; renderChild: (schema: SettingsSchema, value: unknown, path: string[], key: string) => ReactNode; onPatch: SetPatch; onHideCollection?: HideCollection; pinnedCount?: number; pinnedRows?: ReactNode }) {
  const array = Array.isArray(value) ? value : [];
  const item = schema.items ?? inferSchema(array[0]);
  const [openEntries, setOpenEntries] = useState(() => new Set<number>());
  const [confirmingEntries, setConfirmingEntries] = useState(() => new Set<number>());
  const protectedDraft = hasAuthoredProtectedCollectionDraft(source, draft, path, schema);
  const projectCollection = source.id === 'app' && path.length === 1 && path[0] === 'projects';
  const confirmProjectRemoval = label.toLowerCase().startsWith('project');
  // prune transient row state after external collection replacement
  useEffect(() => {
    setOpenEntries(current => { const next = new Set([...current].filter(index => index < array.length)); return next.size === current.size ? current : next; });
    setConfirmingEntries(current => { const next = new Set([...current].filter(index => index < array.length)); return next.size === current.size ? current : next; });
  }, [array.length]);
  // close every index-bound editor before indexes change
  const closeForStructuralChange = () => {
    onHideCollection?.(source, path);
    setOpenEntries(new Set());
    setConfirmingEntries(new Set());
  };
  // toggle one row while retaining staged values
  const toggle = (index: number) => {
    // revoke only the subtree being hidden
    if (openEntries.has(index)) onHideCollection?.(source, [...path, String(index)]);
    setOpenEntries(current => {
      const next = new Set(current);
      // flip only this ordered editor
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  // append a default item and open its editor
  const add = () => {
    // never insert an additional file into an unconfigured source-owner slot
    if (array.length < pinnedCount) return;
    const index = array.length;
    onPatch(source, { op: 'insert', path, index, value: defaultForSchema(item) });
    setOpenEntries(current => new Set(current).add(index));
  };
  // move only after every index-bound subtree is hidden
  const move = (from: number, to: number) => {
    // never move an editable entry through its fixed source prefix
    if (from < pinnedCount || to < pinnedCount) return;
    closeForStructuralChange();
    onPatch(source, { op: 'move', path, from, to });
  };
  // remove only after every index-bound subtree is hidden
  const remove = (index: number) => {
    // retain source-owner entries even when a stale action is invoked
    if (index < pinnedCount) return;
    closeForStructuralChange();
    onPatch(source, { op: 'remove', path: [...path, String(index)] });
  };
  // close a project editor before showing destructive confirmation
  const requestRemove = (index: number) => {
    // remove ordinary entries immediately
    if (!confirmProjectRemoval) { remove(index); return; }
    onHideCollection?.(source, [...path, String(index)]);
    setOpenEntries(current => { const next = new Set(current); next.delete(index); return next; });
    setConfirmingEntries(new Set([index]));
  };
  return <div className="settings-array settings-collection" data-settings-collection="array" data-settings-collection-path={path.join('.')}>
    {protectedDraft && <p className="settings-collection-protected-note" role="note">{collectionProtectionReason}</p>}
    <div className="settings-array-list">{pinnedRows}{array.map((entry, index) => {
      // source-owner rows expose navigation instead of collection mutations
      if (index < pinnedCount) return null;
      const entryPath = [...path, String(index)];
      const entryLabel = `${itemLabel} ${index + 1}`;
      const editing = openEntries.has(index);
      const editorId = collectionEditorId(source.id, entryPath);
      const structuralReason = protectedDraft ? collectionProtectionReason : confirmingEntries.size > 0 && !confirmingEntries.has(index) ? 'Finish or cancel the pending Project removal before changing this list.' : undefined;
      return <CollectionEntry key={`${path.join('.')}:${index}`} label={label} itemLabel={entryLabel} visibleLabel={projectCollection ? undefined : itemLabel} index={index} count={array.length} firstMovableIndex={pinnedCount} summary={collectionItemSummary(entry, item, projectCollection)} issues={collectionItemIssues(issues, source.id, entryPath)} editing={editing} editorId={editorId} disabled={disabled} navigationDisabled={navigationDisabled} structuralReason={structuralReason} confirming={confirmingEntries.has(index)} confirmProjectRemoval={confirmProjectRemoval} onEdit={() => { /* toggle this ordered editor */ toggle(index); }} onMove={to => { /* keep index state detached from moved data */ move(index, to); }} onRequestRemove={() => { /* confirm or remove this ordered entry */ requestRemove(index); }} onCancelRemove={() => { /* cancel project removal */ setConfirmingEntries(new Set()); }} onRemove={() => { /* confirm project removal */ remove(index); }}>{renderChild({ ...item, label: item.label ?? itemLabel }, entry, entryPath, String(index))}</CollectionEntry>;
    })}</div><button type="button" className="settings-collection-add-button" disabled={disabled || array.length < pinnedCount} title={array.length < pinnedCount ? 'Configure the source files before adding additional entries.' : undefined} onClick={add}>+ Add {itemLabel}</button>
  </div>;
}

// render every schema kind with collection-preserving patches
function SchemaField({ source, schema: providedSchema, value, path, draft, disclosures, issues, disabled: inheritedDisabled, navigationDisabled: inheritedNavigationDisabled = inheritedDisabled, onPatch, onReveal, onRemask, onHideCollection, remoteServers = [] }: { source: SettingsSource; schema?: SettingsSchema; value: unknown; path: string[]; draft?: Draft; disclosures: Map<string, Disclosure>; issues: SettingsIssue[]; disabled: boolean; navigationDisabled?: boolean; onPatch: SetPatch; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void>; onHideCollection?: HideCollection; remoteServers?: readonly RemoteServerDefaults[] }) {
  const controlId = useId();
  const schema = providedSchema ?? inferSchema(value);
  // retain unsupported adapter values without offering inactive controls
  const unimplementedAdapter = source.id === 'app' && path.length === 2 && path[0] === 'adapters' && (path[1] === 'pi' || path[1] === 'opencode');
  const disabled = inheritedDisabled || unimplementedAdapter;
  const navigationDisabled = inheritedNavigationDisabled || unimplementedAdapter;
  const label = unimplementedAdapter ? path[1] === 'pi' ? 'Pi' : 'OpenCode' : schema.label ?? labelForKey(path.at(-1) ?? source.label);
  const projectItem = source.id === 'app' && path[0] === 'projects' && path.length === 2 && /^\d+$/u.test(path[1]!);
  const projectField = source.id === 'app' && path[0] === 'projects' && path.length >= 3;
  const removable = schema.optional && !hasSchemaDefault(schema) && !projectField;
  const disclosure = disclosures.get(disclosureKey(source.id, path));
  // protect masked leaves before interpreting their semantic schema
  if (schema.protected === true || isProtectedValue(value) || protectedSettingIdentity(path.at(-1) ?? '')) return <ProtectedField source={source} path={path} label={label} description={schema.description} schema={schema} draft={draft} disclosure={disclosure} disabled={disabled} showRemove={!hasSchemaDefault(schema) && !projectField} onReveal={onReveal} onRemask={onRemask} onPatch={onPatch} />;
  // replace numbered remote objects with permanent inherited identity controls
  if (source.id === 'app' && path.length === 2 && path[0] === 'remoteServers' && /^\d+$/u.test(path[1]!)) return <RemoteServerFields value={value} path={path} defaults={remoteServers} disabled={disabled} onPatch={next => { /* stage remote overrides in the same application transaction */ onPatch(source, next); }} renderIssues={fieldPath => <FieldIssues issues={issues} sourceId={source.id} path={fieldPath} />} renderProtected={key => {
    const fieldValue = valueAt(value, [key]);
    // keep server-classified credentials behind the existing disclosure boundary
    if (!isProtectedValue(fieldValue)) return undefined;
    return <ProtectedField source={source} path={[...path, key]} label={key === 'url' ? 'URL' : labelForKey(key)} schema={schema.properties?.[key]} draft={draft} disclosure={disclosures.get(disclosureKey(source.id, [...path, key]))} disabled={disabled} showRemove={false} onPatch={onPatch} onReveal={onReveal} onRemask={onRemask} />;
  }} />;
  const defaulted = hasSchemaDefault(schema);
  const effectiveValue = value === undefined && defaulted ? schema.default : value;
  // seed only a deliberately edited missing container and retain exact leaf identity
  const stagePatch: SetPatch = (target, next, disclosureDerived) => {
    // sequence the public default baseline before its original authored operation
    for (const prepared of settingsDefaultPatches(schema, value, path, next)) onPatch(target, prepared, prepared === next && disclosureDerived);
  };
  // preserve explicit and defaulted null independently from optional absence
  if (effectiveValue === null && schema.nullable) return <div className="settings-field settings-null-field" data-settings-path={path.join('.')}><div className="settings-field-summary"><span className="settings-field-copy"><strong>{label}</strong><small>{value === undefined ? 'Default is null' : 'Explicitly null'}</small>{schema.description && <small>{schema.description}</small>}</span><span className="settings-field-actions"><button type="button" disabled={disabled} onClick={() => stagePatch(source, { op: 'set', path, value: defaultForSchema({ ...schema, nullable: false }, schema.default !== null) })}>Use a value</button>{removable && <SettingsRemoveButton ariaLabel={`Remove ${label}`} title={`Remove ${label}`} disabled={disabled} onClick={() => stagePatch(source, { op: 'remove', path })} />}</span></div><FieldIssues issues={issues} sourceId={source.id} path={path} /></div>;
  // let optional absent values be created intentionally
  if (value === undefined && schema.optional && !defaulted && !projectField && !(source.id === 'app' && path.length === 1 && path[0] === 'remoteServers')) return <div className={`settings-field settings-optional-field${unimplementedAdapter ? ' settings-unimplemented-field' : ''}`} data-settings-path={path.join('.')} aria-disabled={unimplementedAdapter || undefined}><span className="settings-field-heading"><strong>{label}</strong><small>{unimplementedAdapter ? 'Unimplemented' : 'Optional'}</small></span>{schema.description && <small>{schema.description}</small>}<button type="button" disabled={disabled} onClick={() => stagePatch(source, { op: 'set', path, value: defaultForSchema(schema) })}>Add {label}</button></div>;
  const child = (nextSchema: SettingsSchema, nextValue: unknown, nextPath: string[], key: string) => <SchemaField key={key} source={source} schema={nextSchema} value={nextValue} path={nextPath} draft={draft} disclosures={disclosures} issues={issues} disabled={disabled} navigationDisabled={navigationDisabled} onPatch={stagePatch} onReveal={onReveal} onRemask={onRemask} onHideCollection={onHideCollection} remoteServers={remoteServers} />;
  let control: ReactNode;
  // render structured objects as field groups
  if (schema.type === 'object') {
    const record = effectiveValue !== null && typeof effectiveValue === 'object' && !Array.isArray(effectiveValue) ? effectiveValue as Record<string, unknown> : {};
    const properties = schema.properties ?? Object.fromEntries(Object.entries(record).map(([key, current]) => [key, inferSchema(current)]));
    control = <div className="settings-object-fields">{Object.entries(properties).filter(([key]) => (source.id !== 'app' || !dedicatedApplicationPaths.has([...path, key].join('.'))) && (source.id !== 'installation' || !dedicatedInstallationPaths.has([...path, key].join('.')))).map(([key, next]) => child(next, record[key], [...path, key], key))}</div>;
  // render ordered arrays with explicit insert, remove, and move operations
  } else if (schema.type === 'array') {
    const array = Array.isArray(effectiveValue) ? effectiveValue : [];
    const item = schema.items ?? inferSchema(array[0]);
    const remoteCollection = source.id === 'app' && path.length === 1 && path[0] === 'remoteServers';
    const itemLabel = remoteCollection ? 'Remote server' : item.label ?? label.replace(/s$/u, '');
    control = <ArrayField key={`${source.id}:${source.revisionId}:${path.join('.')}`} source={source} schema={schema} value={array} path={path} draft={draft} issues={issues} label={label} itemLabel={itemLabel} disabled={disabled} navigationDisabled={navigationDisabled} renderChild={child} onPatch={stagePatch} onHideCollection={onHideCollection} />;
  // render maps with explicit keyed mutations
  } else if (schema.type === 'record') {
    control = <RecordField key={`${source.id}:${source.revisionId}:${path.join('.')}`} source={source} schema={schema} value={effectiveValue} path={path} draft={draft} issues={issues} disabled={disabled} navigationDisabled={navigationDisabled} renderChild={child} onPatch={stagePatch} onHideCollection={onHideCollection} />;
  // retain arbitrary JSON when a typed shape is unavailable
  } else if (schema.type === 'json') {
    control = <JsonField source={source} value={effectiveValue} disabled={disabled} ariaLabel={label} onChange={next => stagePatch(source, { op: 'set', path, value: next })} />;
  // choose the variant matching the current primitive or use the first server variant
  } else if (schema.type === 'union') {
    const variant = schema.variants?.find(candidate => matchesSchemaValue(candidate, effectiveValue)) ?? schema.variants?.[0] ?? inferSchema(effectiveValue);
    const variantIndex = Math.max(0, schema.variants?.indexOf(variant) ?? 0);
    control = <div className="settings-union"><SettingsSelect label={`${label} type`} value={String(variantIndex)} disabled={disabled} options={(schema.variants ?? []).map((candidate, index) => ({ value: String(index), label: candidate.label ?? labelForKey(candidate.type) }))} onChange={index => { /* replace only an explicitly chosen variant */ const next = schema.variants?.[Number(index)]; if (next !== undefined) stagePatch(source, { op: 'set', path, value: defaultForSchema(next) }); }} />{child({ ...variant, label }, effectiveValue, path, `union:${variantIndex}`)}</div>;
  // render enumerated strings without losing their exact value
  } else if (schema.type === 'enum') {
    control = <SettingsSelect label={label} value={typeof effectiveValue === 'string' ? effectiveValue : ''} disabled={disabled} options={(schema.options ?? []).map(option => ({ value: option, label: option, ...(path.at(-1) === 'icon' && isInstanceIconName(option) ? { icon: <InstanceIconPreview name={option} /> } : {}) }))} onChange={next => { /* stage the exact enum identity */ stagePatch(source, { op: 'set', path, value: next }); }} />;
  // render booleans as accessible switches
  } else if (schema.type === 'boolean') {
    control = <label className="client-settings-toggle"><input id={controlId} aria-label={label} type="checkbox" role="switch" checked={effectiveValue === true} disabled={disabled} onChange={event => stagePatch(source, { op: 'set', path, value: event.target.checked })} /><span className="client-settings-switch-state">{effectiveValue === true ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label>;
  // retain number semantics during editing
  } else if (schema.type === 'number') {
    control = <input id={controlId} type="number" value={typeof effectiveValue === 'number' ? effectiveValue : projectField ? '' : 0} disabled={disabled} onChange={event => { /* preserve blank project numbers as authored absence */ if (projectField && event.target.value === '') stagePatch(source, { op: 'set', path, value: '' });
      // reject other transient nonnumbers
      else if (!Number.isNaN(event.target.valueAsNumber)) stagePatch(source, { op: 'set', path, value: event.target.valueAsNumber }); }} />;
  // use multiline controls only for existing multiline strings
  } else if (typeof effectiveValue === 'string' && effectiveValue.includes('\n')) {
    control = <textarea id={controlId} value={effectiveValue} disabled={disabled} onChange={event => stagePatch(source, { op: 'set', path, value: event.target.value })} />;
  } else {
    control = <input id={controlId} type="text" value={typeof effectiveValue === 'string' ? effectiveValue : ''} disabled={disabled} onChange={event => stagePatch(source, { op: 'set', path, value: event.target.value })} />;
  }
  // object and collection controls own their nested labels
  if (schema.type === 'object') return <section className={`settings-schema-section${unimplementedAdapter ? ' settings-unimplemented-field' : ''}`} aria-disabled={unimplementedAdapter || undefined} data-settings-path={path.join('.')}>{!projectItem && <header><div><h3>{label}</h3>{unimplementedAdapter && <small>Unimplemented</small>}{schema.description && <p>{schema.description}</p>}</div>{removable && <SettingsRemoveButton ariaLabel={`Remove ${label}`} title={`Remove ${label}`} disabled={disabled} label="Remove section" onClick={() => stagePatch(source, { op: 'remove', path })} />}</header>}{control}<FieldIssues issues={issues} sourceId={source.id} path={path} /></section>;
  if (schema.type === 'union' || schema.type === 'json') return <div className="settings-field settings-field-union" data-settings-path={path.join('.')}><div className="settings-field-summary"><span className="settings-field-copy"><strong>{label}</strong>{schema.description && <small>{schema.description}</small>}</span><span className="settings-field-actions">{schema.nullable && <button type="button" aria-label={`Set ${label} to null`} disabled={disabled} onClick={() => stagePatch(source, { op: 'set', path, value: null })}>Set null</button>}{removable && <SettingsRemoveButton ariaLabel={`Remove ${label}`} title={`Remove ${label}`} disabled={disabled} onClick={() => stagePatch(source, { op: 'remove', path })} />}</span></div>{control}<FieldIssues issues={issues} sourceId={source.id} path={path} /></div>;
  // bind copy only to native controls that expose this generated id
  const ownsNativeControl = schema.type === 'boolean' || schema.type === 'number' || schema.type === 'string';
  return <div className={`settings-field settings-field-${schema.type}`} data-settings-path={path.join('.')}><div className="settings-field-summary"><span className="settings-field-copy">{ownsNativeControl ? <label htmlFor={controlId}><strong>{label}</strong></label> : <strong>{label}</strong>}{schema.description && <small>{schema.description}</small>}</span><span className="settings-field-actions">{schema.nullable && <button type="button" aria-label={`Set ${label} to null`} disabled={disabled} onClick={() => stagePatch(source, { op: 'set', path, value: null })}>Set null</button>}{removable && <SettingsRemoveButton ariaLabel={`Remove ${label}`} title={`Remove ${label}`} disabled={disabled} onClick={() => stagePatch(source, { op: 'remove', path })} />}{schema.type === 'boolean' && control}</span></div>{schema.type === 'boolean' ? null : control}<FieldIssues issues={issues} sourceId={source.id} path={path} /></div>;
}

type InstallationFields = Omit<Parameters<typeof SchemaField>[0], 'schema' | 'value' | 'path'>;
type PinnedInstallationFile = { id: string; path: string; section: string; defaulted: boolean };

// keep source-owner paths fixed while preserving original indexes for additional files
function InstallationFileList({ schema, value, path, pinned, availableSections, onNavigate, ...fields }: InstallationFields & { schema: SettingsSchema; value: unknown; path: string[]; pinned: PinnedInstallationFile[]; availableSections: Set<string>; onNavigate: (section: string) => void }) {
  const label = schema.label ?? (path.at(-1) === 'files' ? 'Compose files' : 'Environment files');
  const itemLabel = schema.items?.label ?? (path.at(-1) === 'files' ? 'Compose file' : 'Environment file');
  const navigationDisabled = fields.navigationDisabled ?? fields.disabled;
  // reuse compact row layout without exposing mutations on catalog-owned source paths
  const pinnedRows = pinned.map((file, index) => <fieldset className="settings-collection-entry settings-array-entry settings-installation-pinned-file" data-settings-pinned-source={file.id} key={file.id}><legend className="sr-only">{file.id === 'env' ? 'Default environment file' : file.id === 'compose' ? 'Base Compose file' : 'Compose override file'}</legend><div className="settings-collection-entry-header"><span className="settings-collection-entry-copy"><strong>{file.path.split('/').at(-1)}</strong><span className="settings-collection-summary" title={file.path}>{file.path}</span>{file.defaulted && <small>{file.id === 'env' ? 'Default environment file' : 'Not configured in the file list'}</small>}</span><button type="button" className="settings-installation-file-link" disabled={navigationDisabled || !availableSections.has(file.section)} onClick={() => { /* navigate through the existing draft and disclosure boundary */ onNavigate(file.section); }}>{file.id === 'env' ? 'Edit in Environment & keys' : 'View and edit in Docker'}</button></div><FieldIssues issues={fields.issues} sourceId={fields.source.id} path={[...path, String(index)]} /></fieldset>);
  return <div className="settings-field settings-field-array" data-settings-path={path.join('.')}><div className="settings-field-summary"><span className="settings-field-copy"><strong>{label}</strong>{schema.description && <small>{schema.description}</small>}</span></div><ArrayField {...fields} navigationDisabled={navigationDisabled} schema={schema} value={value} path={path} label={label} itemLabel={itemLabel} pinnedCount={pinned.length} pinnedRows={pinnedRows} renderChild={(childSchema, childValue, childPath, key) => <SchemaField {...fields} key={key} schema={childSchema} value={childValue} path={childPath} />} /><FieldIssues issues={fields.issues} sourceId={fields.source.id} path={path} /></div>;
}

// show installed mode and file-only selectors beneath the editable checkout
function InstallationEditor({ source, installationKind, sources, onNavigate, ...fields }: InstallationFields & { installationKind?: SettingsSnapshot['installationKind']; sources: SettingsSource[]; onNavigate: (section: string) => void }) {
  const schema = source.schema ?? inferSchema(source.value);
  // retain a legacy display fallback while preferring exact installed-mode metadata
  const configuredKind = installationKind ?? (valueAt(source.value, ['native']) !== undefined && valueAt(source.value, ['compose']) === undefined ? 'systemd' : 'compose');
  const groupId = useId();
  const navigationDisabled = fields.navigationDisabled ?? fields.disabled;
  const host = schema.properties?.host ?? { type: 'object', label: 'Host', properties: { checkout: { type: 'string', label: 'Checkout' } } } as SettingsSchema;
  const branch = configuredKind === 'compose' ? 'compose' : 'native';
  const branchSchema = schema.properties?.[branch];
  const providedOptions = branchSchema?.properties?.options;
  // expose permanent defaults without materializing unedited file values
  const optionsSchema: SettingsSchema = { ...providedOptions, type: 'object', label: providedOptions?.label ?? 'Options', optional: false, default: {}, properties: {
    ...providedOptions?.properties,
    parallel: { ...providedOptions?.properties?.parallel, type: 'number', optional: false, ...composeOptionSettings.parallel },
    compatibility: { ...providedOptions?.properties?.compatibility, type: 'boolean', optional: false, ...composeOptionSettings.compatibility }
  } };
  const branchProperties = branch === 'compose' ? { ...branchSchema?.properties, options: optionsSchema } : branchSchema?.properties ?? {};
  const projectDirectory = valueAt(source.value, ['compose', 'projectDirectory']);
  const checkout = valueAt(source.value, ['host', 'checkout']);
  const directory = typeof projectDirectory === 'string' ? projectDirectory : typeof checkout === 'string' ? checkout : undefined;
  const availableSections = new Set(sources.map(entry => entry.id));
  // retain configured role paths and use installation-relative defaults only when absent
  const pinnedFiles = (key: 'files' | 'envFiles'): PinnedInstallationFile[] => {
    const values = valueAt(source.value, ['compose', key]);
    const ids = key === 'files' ? ['compose', 'compose-override'] : ['env'];
    // source indexes own catalog identities even when custom filenames are configured
    return ids.map((id, index) => {
      const configured = Array.isArray(values) && typeof values[index] === 'string' ? values[index] as string : undefined;
      const filename = id === 'env' ? '.env' : id === 'compose' ? 'compose.yaml' : 'compose.override.yaml';
      const fallback = directory === undefined ? filename : `${directory.replace(/\/+$/u, '')}/${filename}`;
      return { id, path: configured ?? sources.find(entry => entry.id === id)?.path ?? fallback, section: id === 'env' ? 'env' : 'compose-override', defaulted: configured === undefined };
    });
  };
  return <div className="settings-installation-editor">
    <div className="settings-object-fields" data-settings-path="host"><SchemaField {...fields} source={source} schema={{ type: 'string', label: 'Checkout', ...host.properties?.checkout, optional: false }} value={checkout} path={['host', 'checkout']} /></div>
    <fieldset className="settings-installation-mode" disabled>
      <legend>Installation mode</legend>
      {/* retain the installed selection without offering a deployment conversion */}
      {(['systemd', 'compose'] as const).map(kind => <label key={kind}><input type="radio" name={groupId} value={kind} checked={configuredKind === kind} readOnly /><span>{kind === 'compose' ? 'Docker' : 'Native'}</span></label>)}
    </fieldset>
    <p className="settings-preference-description" role="note">Installation mode and its settings are read-only here. Change them through the installation files.</p>
    {/* keep unrelated host fields on their original editable paths */}
    {Object.entries(host.properties ?? {}).filter(([key]) => key !== 'checkout').map(([key, property]) => <SchemaField {...fields} key={`host.${key}`} source={source} schema={property} value={valueAt(source.value, ['host', key])} path={['host', key]} />)}
    <FieldIssues issues={fields.issues} sourceId={source.id} path={['host']} />
    <div className="settings-object-fields settings-installation-read-only" data-settings-path={branch} role="group" aria-label="File-only installation settings">
      {/* retain file navigation while disabling mode-specific mutations */}
      {Object.entries(branchProperties).filter(([key]) => branch === 'compose' ? key !== 'profiles' : !['cloudflaredUnit', 'cloudflaredConfig', 'cloudflaredCredentials'].includes(key)).map(([key, property]) => branch === 'compose' && (key === 'files' || key === 'envFiles')
        ? <InstallationFileList {...fields} disabled navigationDisabled={navigationDisabled} key={`${branch}.${key}`} source={source} schema={property} value={valueAt(source.value, [branch, key])} path={[branch, key]} pinned={pinnedFiles(key)} availableSections={availableSections} onNavigate={onNavigate} />
        : <SchemaField {...fields} disabled navigationDisabled={navigationDisabled} key={`${branch}.${key}`} source={source} schema={property} value={valueAt(source.value, [branch, key])} path={[branch, key]} />)}
    </div>
    <FieldIssues issues={fields.issues} sourceId={source.id} path={[branch]} />
    {/* preserve any unrelated installation controls and their authored values */}
    {Object.entries(schema.properties ?? {}).filter(([key]) => !['host', 'version', 'sources', 'native', 'compose'].includes(key)).map(([key, property]) => <SchemaField {...fields} key={key} source={source} schema={property} value={valueAt(source.value, [key])} path={[key]} />)}
    <FieldIssues issues={fields.issues} sourceId={source.id} path={[]} />
  </div>;
}

// edit the line-preserving environment model one variable at a time
function EnvironmentEditor({ source, draft, disclosures, issues, disabled, installationKind, scope = 'general', excludedKeys = tmuxEnvironmentKeys, onPatch, onReveal, onRemask }: { source: SettingsSource; draft?: Draft; disclosures: Map<string, Disclosure>; issues: SettingsIssue[]; disabled: boolean; installationKind?: SettingsSnapshot['installationKind']; scope?: 'general' | 'tmux'; excludedKeys?: ReadonlySet<string>; onPatch: SetPatch; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const { securityEpoch } = useSettingsRuntime();
  // discard unfinished creation plaintext when connection authority changes
  useEffect(() => { setAdding(false); setNewKey(''); setNewValue(''); }, [source.id, securityEpoch]);
  const allFields = source.fields ?? [];
  // keep each field with its dedicated controls without changing source identity
  const visibleTmuxKeys = tmuxEnvironmentKeysForInstallation(installationKind);
  const fields = allFields.filter(field => scope === 'tmux' ? visibleTmuxKeys.has(field.key) : !excludedKeys.has(field.key));
  // append an explicitly named environment variable
  const add = () => {
    const key = newKey.trim();
    // empty values remove assignments instead of creating blank variables
    if (!key || newValue === '' || allFields.some(field => field.key === key) || excludedKeys.has(key)) return;
    onPatch(source, { op: 'set', path: [key], value: newValue });
    setNewKey(''); setNewValue(''); setAdding(false);
  };
  return <div className="settings-env-fields">
    {fields.map(field => {
      // retain server guidance and describe older or custom environment entries too
      const description = field.description?.trim() || environmentDescription(field.key);
      // saved conflict proof does not establish a winner for local draft values
      const fieldEdited = draft?.patches.some(patch => patch.path[0] === field.key);
      const winningSource = !fieldEdited && field.present && field.winningSource?.trim();
      const provenance = [winningSource && `Winning source: ${winningSource}`, field.overriddenBy && `Overridden by: ${field.overriddenBy}`].filter(Boolean).join(' · ');
      // custom assignments may be removed without revealing their values
      const remove = field.present && !builtinEnvironmentKeys.has(field.key) ? <SettingsRemoveButton ariaLabel={`Remove ${field.key}`} title={`Remove ${field.key}`} labelClassName="sr-only" disabled={disabled} onClick={() => onPatch(source, { op: 'remove', path: [field.key] })} /> : undefined;
      return field.protected ? <ProtectedField key={field.key} source={{ ...source, value: { [field.key]: { __racProtected: true, present: field.present, hasValue: field.hasValue ?? field.present } } }} path={[field.key]} label={field.key} headingAction={remove} description={[description, provenance].filter(Boolean).join(' · ')} fallback={field.fallback} schema={{ type: 'string', apply: field.apply }} draft={draft} disclosure={disclosures.get(disclosureKey(source.id, [field.key]))} disabled={disabled} showRemove={false} onReveal={onReveal} onRemask={onRemask} onPatch={onPatch} /> : <div className="settings-field" data-settings-path={field.key} key={field.key}><div className="settings-field-summary"><span className="settings-field-copy"><span className="settings-field-heading"><span className="settings-environment-key"><strong>{field.key}</strong>{remove}</span></span><small>{description}</small>{provenance && <small className="settings-field-origin">{provenance}</small>}</span></div><input type="text" aria-label={field.key} value={field.value ?? ''} placeholder={field.fallback?.value} disabled={disabled} onChange={event => onPatch(source, event.target.value === '' ? { op: 'remove', path: [field.key] } : { op: 'set', path: [field.key], value: event.target.value })} /><FieldIssues issues={issues} sourceId={source.id} path={[field.key]} /></div>;
    })}
    {scope === 'general' && <section className="settings-env-add" aria-label="Add environment variable">{adding ? <div className="settings-env-add-form"><input className="settings-env-variable-name" aria-label="Variable" placeholder="VARIABLE_NAME" autoFocus value={newKey} disabled={disabled} autoCapitalize="off" spellCheck={false} onChange={event => setNewKey(event.target.value)} /><label>Value<input type={protectedSettingIdentity(newKey) ? 'password' : 'text'} value={newValue} disabled={disabled} autoComplete="new-password" onChange={event => setNewValue(event.target.value)} /></label><span className="settings-inline-actions"><button type="button" disabled={disabled} onClick={() => { /* discard unfinished creation without changing the source */ setAdding(false); setNewKey(''); setNewValue(''); }}>Cancel</button><button type="button" className="settings-primary-button" disabled={disabled || !newKey.trim() || newValue === '' || allFields.some(field => field.key === newKey.trim()) || excludedKeys.has(newKey.trim())} onClick={add}>Add variable</button></span></div> : <button type="button" className="settings-collection-add-button" disabled={disabled} onClick={() => { /* expand the placeholder without staging an empty assignment */ setAdding(true); }}>Add environment variable</button>}</section>}
  </div>;
}

// keep secret-bearing source views read-only until explicitly revealed
function RawSourceEditor({ source, draft, disclosure, issues, disabled, showRemove = true, onContent, onRemove, onReveal, onRemask }: { source: SettingsSource; draft?: Draft; disclosure?: Disclosure; issues: SettingsIssue[]; disabled: boolean; showRemove?: boolean; onContent: (source: SettingsSource, content: string) => void; onRemove: (source: SettingsSource) => void; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void> }) {
  const [replace, setReplace] = useState(false);
  const [draftVisible, setDraftVisible] = useState(false);
  const runtime = useSettingsRuntime();
  // let an absent wrapper start as an editable blank rather than a creation prompt
  const publicContent = source.content ?? (!source.exists && source.format === 'wrapper' ? '' : undefined) ?? (source.exists && !source.protected && source.format === 'svg' && typeof source.value === 'string' ? source.value : undefined);
  // replace only server-redacted markers without altering draft or saved bytes
  const maskedContent = publicContent?.replace(/__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/gu, '********');
  const hasSavedSecrets = source.hasProtectedContent === true || maskedContent !== publicContent || source.exists && publicContent === undefined;
  // retain broad draft protection without locking empty saved credential fields
  const credentialBearing = useMemo(() => hasSavedSecrets || source.format === 'credentials' || source.protected && publicContent === undefined || containsProtectedValue(source.value), [hasSavedSecrets, source.format, source.protected, source.value, publicContent]);
  const localProtectedDraft = draft?.content !== undefined && draft.content !== '' && credentialBearing;
  const hiddenDraft = localProtectedDraft && !draftVisible && disclosure === undefined;
  const revealed = disclosure !== undefined || localProtectedDraft && draftVisible;
  const masked = hiddenDraft || draft?.content === undefined && !revealed && !replace && hasSavedSecrets;
  const shown = masked ? maskedContent ?? '********' : draft?.content ?? (typeof disclosure?.value === 'string' ? disclosure.value : disclosure === undefined ? publicContent : JSON.stringify(disclosure.value, null, 2));
  const key = disclosureKey(source.id, []);
  // revoke saved disclosures before hiding any independently authored plaintext
  const toggle = async () => {
    // one mask also hides a draft authored before a delayed lease arrived
    if (disclosure !== undefined) { setDraftVisible(false); setReplace(false); await onRemask(key); return; }
    // toggle authored bytes locally without replacing them with the saved source
    if (localProtectedDraft) { setDraftVisible(current => !current); setReplace(false); return; }
    await onReveal(source, []);
  };
  // omit disclosure for unset sources and files containing no protected values
  const eye = disclosure !== undefined || localProtectedDraft || draft?.content === undefined && source.exists && (shown === undefined && !replace || hasSavedSecrets) ? <SettingsRevealButton label={publicContent === undefined && !replace && !localProtectedDraft && disclosure === undefined ? source.label : 'keys'} revealed={revealed} disabled={disabled} onToggle={toggle} /> : undefined;
  // omit empty action rows while keeping blind secret replacement available
  const showReplace = source.format !== 'env' && masked && publicContent === undefined && !hiddenDraft;
  // keep Docker and wrapper editors free of redundant source chrome
  const minimalChrome = source.format === 'wrapper' || source.id === 'compose-override';
  const showSourceRemove = showRemove && source.format !== 'env' && !minimalChrome && source.exists;
  // reset blind replacement after save or refresh
  useEffect(() => { if (draft?.content === undefined) setReplace(false); }, [draft?.content]);
  // close plaintext editors when controller or connection authority changes
  useEffect(() => { setReplace(false); setDraftVisible(false); }, [source.id, source.revisionId, runtime.securityEpoch]);
  // retain locally authored content but stop displaying it after pagehide
  useEffect(() => {
    const hide = () => { setReplace(false); setDraftVisible(false); };
    window.addEventListener('pagehide', hide);
    return () => window.removeEventListener('pagehide', hide);
  }, []);
  // revoke late saved-source leases without discarding an independently authored draft
  useEffect(() => {
    // the operator's local source replaces any saved disclosure that arrived later
    if (draft?.content !== undefined && !draft.disclosureContent && disclosure !== undefined) void onRemask(key);
  }, [draft?.content, draft?.disclosureContent, disclosure, key, onRemask]);
  return <div className="settings-raw-editor">
    {trustedCodeFormats.has(source.format) && <div className="settings-trusted-warning" role="note"><strong>Trusted code</strong><span>This source can execute only through its later explicit product action. Save validates and persists it but never runs it.</span></div>}
    {source.tracked && <div className="settings-tracked-warning" role="note"><strong>Tracked file</strong><span>Editing this file will dirty the checkout and can affect future updates.</span></div>}
    {hiddenDraft && <p className="settings-source-warning" role="note">Unsaved protected source draft is masked; reveal to continue editing. Save changes still saves the draft.</p>}
    {shown === undefined && !replace ? <div className="settings-raw-masked"><span className="settings-masked-value">Source does not exist</span><span className="settings-inline-actions"><button type="button" disabled={disabled} onClick={() => { /* explicitly start authoring a missing source */ setReplace(true); setDraftVisible(true); }}>Create source</button></span></div> : <>{!minimalChrome && <span className="settings-code-label">Source content</span>}<SettingsCodeEditor ariaLabel={`${source.label} source content`} value={shown ?? ''} disabled={disabled} masked={masked} format={source.format} editorSource={source} fieldAction={eye === undefined ? undefined : <>{masked && <span className="settings-code-editor-disclosure-note">Contains secrets, reveal to edit</span>}{eye}</>} onChange={content => { /* preserve editable authored bytes until explicitly masked */ setDraftVisible(true); onContent(source, content); }} />{(showReplace || showSourceRemove) && <span className="settings-inline-actions">{showReplace && <button type="button" disabled={disabled} onClick={() => { /* explicitly replace a source without fetching its saved keys */ setReplace(true); setDraftVisible(true); }}>Replace without revealing</button>}{showSourceRemove && <SettingsRemoveButton disabled={disabled} label="Remove source" onClick={() => onRemove(source)} />}</span>}</>}
    {issues.filter(issue => issue.sourceId === source.id).map(issue => <span key={`${issue.path.join('.')}:${issue.code}`} className="settings-field-error" role="alert">{issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}{issue.message}</span>)}
  </div>;
}

type IconArtworkProps = {
  sources: SettingsSource[]; drafts: Record<string, Draft>; disclosures: Map<string, Disclosure>; issues: SettingsIssue[]; disabled: boolean;
  installation?: SettingsSource; installationDraft?: Draft; onPatch: SetPatch;
  onContent: (source: SettingsSource, content: string) => void; onRemove: (source: SettingsSource) => void;
  onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void>;
};

// keep each editable file beside the setting that consumes its artwork
function IconArtwork({ sources, drafts, disclosures, issues, disabled, installation, installationDraft, onPatch, onContent, onRemove, onReveal, onRemask }: IconArtworkProps) {
  const artwork = sources.filter(source => editableIconSources.has(source.id));
  return <div className="settings-icon-artwork" role="group" aria-label="Local icon artwork"><p>View or edit local artwork without changing the selected server icon. Artwork is shared wherever its alias is shown by this console.</p>{artwork.map(source => {
    const name = source.id === 'icon-heart' ? 'heart' : 'potato';
    // edit icon file locations beside their application-owned artwork
    const locationPath = ['sources', 'icons', name];
    const locationSchema = installation?.schema?.properties?.sources?.properties?.icons?.properties?.[name];
    const locationBlocked = installationDraft?.content !== undefined || installationDraft?.remove === true;
    const draft = drafts[source.id];
    // show artwork draft status only when its saved bytes actually differ
    const changed = hasSettingsDraftChanges(source, draft, (value, next) => applyLocalPatch(value, next, source.id), [...disclosures.values()].filter(disclosure => disclosure.sourceId === source.id));
    return <details key={source.id} className="settings-icon-source">
      <summary><span className="settings-icon-thumbnail"><InstanceIconPreview name={name} source={source} content={iconPreviewContent(source, draft)} removed={draft?.remove} label={`${source.label} preview`} /></span><span><strong>View / edit {source.label}</strong><small>{changed ? 'Unsaved artwork changes' : source.exists ? 'Saved artwork' : 'Not created · Terminal fallback'}</small></span><svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="settings-icon-source-edit" d={panelIcons.editor} /><path className="settings-icon-source-close" d={panelIcons.close} /></svg>{source.exists && <SettingsRemoveButton ariaLabel={`Remove ${source.label}`} title={`Remove ${source.label}`} label={`Remove ${source.label}`} labelClassName="sr-only" disabled={disabled || !source.writable || draft?.remove === true} onClick={event => { /* stage removal without toggling the viewer */ event.preventDefault(); event.stopPropagation(); onRemove(source); }} />}</summary>
      <div className="settings-icon-source-content">{source.path && <code>{source.path}</code>}{installation !== undefined && locationSchema !== undefined && <SchemaField source={installation} schema={{ ...locationSchema, label: `${labelForKey(name)} icon path` }} value={valueAt(installation.value, locationPath)} path={locationPath} draft={installationDraft} disclosures={disclosures} issues={issues} disabled={disabled || !installation.writable || installation.value === undefined || locationBlocked} onPatch={onPatch} onReveal={onReveal} onRemask={onRemask} />}{locationBlocked && <p role="note">Finish or discard the Installation whole-source draft or removal before editing icon paths.</p>}{!source.writable && <p role="note">This artwork is read-only in the current installation.</p>}<RawSourceEditor source={source} draft={draft} disclosure={disclosures.get(disclosureKey(source.id, []))} issues={issues} disabled={disabled || !source.writable} showRemove={false} onContent={onContent} onRemove={onRemove} onReveal={onReveal} onRemask={onRemask} /></div>
    </details>;
  })}{artwork.length === 0 && <p role="note">Custom artwork sources are unavailable in this installation.</p>}</div>;
}

// select the local identity once while preserving independent icon file drafts
function ApplicationIconSetting({ source, showSelector, onPatch, ...artwork }: IconArtworkProps & { source: SettingsSource; showSelector: boolean }) {
  const value = valueAt(source.value, ['icon']);
  const name = isInstanceIconName(value) ? value : 'terminal';
  const selectedSource = artwork.sources.find(candidate => candidate.id === `icon-${name}`);
  const selectedDraft = selectedSource === undefined ? undefined : artwork.drafts[selectedSource.id];
  const options: SettingsSelectOption[] = instanceIcons.map(icon => {
    const iconSource = artwork.sources.find(candidate => candidate.id === `icon-${icon}`);
    const draft = iconSource === undefined ? undefined : artwork.drafts[iconSource.id];
    return { value: icon, label: labelForKey(icon), icon: <InstanceIconPreview name={icon} source={iconSource} content={iconSource === undefined ? undefined : iconPreviewContent(iconSource, draft)} removed={draft?.remove} /> };
  });
  return <section className="settings-application-icon" aria-label="Server icon and artwork"><header><h3>Server icon and artwork</h3><p>The server selector and favicon use this choice. Terminal is built in; custom files remain editable below.</p></header>{showSelector && <div className="settings-icon-choice"><span className="settings-icon-selected-preview"><InstanceIconPreview name={name} source={selectedSource} content={selectedSource === undefined ? undefined : iconPreviewContent(selectedSource, selectedDraft)} removed={selectedDraft?.remove} label="Server icon preview" /></span><div><span className="settings-code-label">Server icon</span><SettingsSelect label="Server icon" value={name} options={options} disabled={artwork.disabled || !source.writable} onChange={icon => { /* stage identity without saving or restarting */ onPatch(source, { op: 'set', path: ['icon'], value: icon }); }} />{value !== undefined && <button type="button" disabled={artwork.disabled || !source.writable} onClick={() => { /* restore the portable default explicitly */ onPatch(source, { op: 'remove', path: ['icon'] }); }}>Use default icon</button>}</div></div>}<IconArtwork {...artwork} onPatch={onPatch} /></section>;
}

// group installation sources for quick navigation
const sourceGroup = (source: Pick<SettingsSource, 'id' | 'format'>): string => {
  if (source.id === 'app') return 'Application';
  if (source.format === 'env') return 'Environment';
  if (source.format === 'installation') return 'Installation';
  if (source.format === 'compose') return 'Deployment';
  if (source.format === 'cloudflared' || source.format === 'credentials') return 'Cloudflare';
  if (source.format === 'svg') return 'Appearance';
  return 'Advanced';
};

// paint a consistent section glyph in both navigation layouts
const sectionIcon = (id: string, format?: SettingsSource['format']): ReactNode => {
  const glyphs = {
    browser: 'M3 4h18v13H3zM8 21h8m-4-4v4',
    keyboard: 'M2 5h20v14H2zM5 8h1m3 0h1m3 0h1m3 0h1M5 11h1m3 0h1m3 0h1m3 0h1M6 15h12',
    voice: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0zm-3 7v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
    projects: 'M3 6h6l2 2h10v12H3zM3 6V4h7l2 2h7v2',
    tmux: 'M3 4h18v16H3zm9 0v16M3 12h9',
    json: 'm8 4-5 8 5 8m8-16 5 8-5 8m-3-17-2 18',
    env: 'M11 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM11 12h11m-4 0v4m3-4v3',
    installation: 'M3 6h7l2 3h9v11H3z',
    compose: 'm12 3 9 5v8l-9 5-9-5V8zm-9 5 9 5 9-5m-9 5v8',
    cloudflared: 'M6 18a4 4 0 1 1 0-8 6 6 0 0 1 12 0 4 4 0 1 1 0 8z',
    credentials: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zm7 4v3',
    wrapper: 'M3 4h18v16H3zm3 5 3 3-3 3m6 0h4',
    svg: 'M3 3h18v18H3zM3 16l6-6 6 6 3-3 3 3M16 7h.01'
  };
  return <PanelIcon path={id === 'browser' || id === 'voice' || id === 'keyboard' || id === 'tmux' || id === 'projects' ? glyphs[id] : glyphs[format ?? 'json']} />;
};

// bind tmux controls and wrapper contents to their existing installed sources
function TmuxSettings({ sources, installationKind, drafts, disclosures, issues, disabled, navigationDisabled, onPatch, onContent, onRemove, onReveal, onRemask, onHideCollection }: { sources: SettingsSource[]; installationKind?: SettingsSnapshot['installationKind']; drafts: Record<string, Draft>; disclosures: Map<string, Disclosure>; issues: SettingsIssue[]; disabled: boolean; navigationDisabled: boolean; onPatch: SetPatch; onContent: (source: SettingsSource, content: string) => void; onRemove: (source: SettingsSource) => void; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void>; onHideCollection: HideCollection }) {
  const app = sources.find(source => source.id === 'app');
  const env = sources.find(source => source.id === 'env');
  const wrapper = sources.find(source => source.id === 'wrapper');
  const pollingSchema = app?.schema?.properties?.tmux;
  // do not replace a whole-source draft with a competing structured patch
  const typedBlockReason = (source: SettingsSource | undefined): string | undefined => {
    // require an authoritative backing file before exposing editable fields
    if (source === undefined) return 'This source is unavailable in the current installation.';
    const draft = drafts[source.id];
    // retain deliberate file removals until the operator resolves them
    if (draft?.remove === true) return `Discard the ${source.label} source removal before editing these settings.`;
    // leave authored whole-source bytes in control of this source
    if (draft?.content !== undefined) return `Finish or discard the ${source.label} whole-source draft before editing these settings.`;
    // keep malformed JSON in its existing repair editor
    if ((source.format === 'json' || source.format === 'installation') && source.value === undefined) return `Repair ${source.label} before editing these settings.`;
    return undefined;
  };
  const appBlock = typedBlockReason(app);
  const envBlock = typedBlockReason(env);
  return <div className="settings-tmux">
    <section className="settings-schema-section" aria-label="TMUX polling"><header><h3>Polling</h3></header>{appBlock && <p role="note">{appBlock}</p>}{app !== undefined && pollingSchema !== undefined ? Object.entries(pollingSchema.properties ?? {}).map(([key, schema]) => <SchemaField key={key} source={app} schema={{ ...schema, optional: false, ...(key === 'pollIntervalMs' ? { label: 'Polling interval (ms)' } : {}) }} value={valueAt(app.value, ['tmux', key])} path={['tmux', key]} draft={drafts[app.id]} disclosures={disclosures} issues={issues} disabled={disabled || !app.writable || appBlock !== undefined} navigationDisabled={navigationDisabled} onPatch={onPatch} onReveal={onReveal} onRemask={onRemask} onHideCollection={onHideCollection} />) : <p role="note">TMUX polling settings are unavailable.</p>}</section>
    <section className="settings-schema-section" aria-label="TMUX connection and discovery"><header><h3>Connection &amp; discovery</h3></header>{envBlock && <p role="note">{envBlock}</p>}{env !== undefined && <EnvironmentEditor source={env} draft={drafts[env.id]} disclosures={disclosures} issues={issues} disabled={disabled || !env.writable || envBlock !== undefined} scope="tmux" installationKind={installationKind} onPatch={onPatch} onReveal={onReveal} onRemask={onRemask} />}</section>
    <section className="settings-schema-section" aria-label="TMUX wrapper"><header><h3>{wrapper?.label ?? 'Installation wrapper'}</h3></header>{wrapper !== undefined ? <RawSourceEditor source={wrapper} draft={drafts[wrapper.id]} disclosure={disclosures.get(disclosureKey(wrapper.id, []))} issues={issues} disabled={disabled || !wrapper.writable} onContent={onContent} onRemove={onRemove} onReveal={onReveal} onRemask={onRemask} /> : <p role="note">The wrapper file is unavailable in this installation.</p>}</section>
  </div>;
}

// retain runtime availability separately from file-backed voice values
type VoiceSettings = { enabled: boolean; available: boolean; name: string; context: string };

// read file values first and schema defaults before the applied runtime fallback
const voiceValue = (source: SettingsSource | undefined, key: 'enabled' | 'name' | 'context', fallback: VoiceSettings): unknown =>
  valueAt(source?.value, ['integrations', 'realtime', key]) ?? source?.schema?.properties?.integrations?.properties?.realtime?.properties?.[key]?.default ?? fallback[key];

// edit basic voice fields in the same source draft as every advanced control
function VoiceEditor({ source, voice, draft, disabled, disclosures, issues, onPatch, onReveal, onRemask }: { source?: SettingsSource; voice: VoiceSettings; draft?: Draft; disabled: boolean; disclosures: Map<string, Disclosure>; issues: SettingsIssue[]; onPatch: SetPatch; onReveal: (source: SettingsSource, path: string[]) => Promise<void>; onRemask: (key: string) => Promise<void> }) {
  const enabled = voiceValue(source, 'enabled', voice) === true;
  const name = voiceValue(source, 'name', voice);
  const context = voiceValue(source, 'context', voice);
  const assistantName = typeof name === 'string' && name.trim() ? name.trim() : 'Davo';
  const descriptionId = useId();
  // refit text on input changes and panel resizing
  const contextRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    // skip the unmounted field
    if (textarea === null) return;
    // measure the entire context without introducing an inner scrollbar
    const fit = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    // follow wrapping in the surrounding settings split
    if (textarea.parentElement) observer.observe(textarea.parentElement);
    return () => observer.disconnect();
  }, [context]);
  // stage only the edited voice path and retain all other application patches
  const stage = (key: 'enabled' | 'name' | 'context', value: unknown) => {
    // refuse changes outside an editable application source
    if (source === undefined || disabled) return;
    onPatch(source, { op: 'set', path: ['integrations', 'realtime', key], value });
  };
  // honor masking for voice text classified as protected by the server
  const textField = (key: 'name' | 'context', value: unknown) => {
    const path = ['integrations', 'realtime', key];
    // delegate protected text to the existing reveal boundary
    if (source !== undefined && isProtectedValue(value)) return <SchemaField key={key} source={source} schema={source.schema?.properties?.integrations?.properties?.realtime?.properties?.[key]} value={value} path={path} draft={draft} disclosures={disclosures} issues={issues} disabled={disabled} onPatch={onPatch} onReveal={onReveal} onRemask={onRemask} />;
    return <label key={key}>{key === 'name' ? 'Name' : 'Context'}{key === 'name' ? <input aria-label="Davo name" type="text" value={typeof value === 'string' ? value : ''} maxLength={80} disabled={disabled} onChange={event => { /* stage the voice identity */ stage(key, event.target.value); }} /> : <textarea ref={contextRef} aria-label="Davo context" value={typeof value === 'string' ? value : ''} maxLength={16_000} disabled={disabled} onChange={event => { /* stage the full voice context */ stage(key, event.target.value); }} />}{source !== undefined && <FieldIssues issues={issues} sourceId={source.id} path={path} />}</label>;
  };
  return <section className="client-settings-section client-settings-davo" aria-label="Voice assistant" aria-describedby={descriptionId}><header><p id={descriptionId} className="settings-preference-description">Talk to your AI assistant using voice, with context from your current workspace.</p><label className="client-settings-toggle"><input aria-label={`Enable ${assistantName}`} role="switch" type="checkbox" checked={enabled} disabled={disabled || !voice.available && !enabled} onChange={event => { /* stage the feature gate without an immediate write */ stage('enabled', event.currentTarget.checked); }} /><span className="client-settings-switch-state">{enabled ? 'On' : voice.available ? 'Off' : 'Unavailable'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></header>{source === undefined && <p role="note">Load the application config before editing voice settings.</p>}{source !== undefined && source.value === undefined && <p role="note">Repair the Application whole source before editing voice settings.</p>}{draft?.remove === true && <p role="note">Discard the Application source removal before editing voice settings.</p>}{draft?.content !== undefined && <p role="note">Finish or discard the Application whole-source draft before editing voice settings.</p>}{enabled && <div className="client-settings-davo-form">{textField('name', name)}{textField('context', context)}</div>}{source !== undefined && <FieldIssues issues={issues} sourceId={source.id} path={['integrations', 'realtime', 'enabled']} />}</section>;
}

// coordinate staged browser preferences and one validated file transaction
export function SettingsCenter({ active, browser, voice, onSaved, onSavedNotice, requestedSection, onSectionSelected, remoteServers = [], closeGuardRef, session }: { active: boolean; browser: BrowserSettingsIdentity; voice: VoiceSettings; onSaved: () => Promise<void>; onSavedNotice: (detail: string) => void; requestedSection?: { id: string; request: number }; onSectionSelected: (request: number) => void; remoteServers?: readonly RemoteServerDefaults[]; closeGuardRef?: Ref<SettingsCloseGuard>; session: ReturnType<typeof useSettingsSession> }) {
  const runtime = useSettingsRuntime();
  const workspaceEditor = useSettingsTerminalEditor();
  const headerActionsTarget = useContext(SettingsHeaderActionsContext);
  const { snapshot, setSnapshot, sources, setSources, drafts, setDrafts, browserDraft: browserDraftState, operationPending, saveCancelled, loading, setLoading, saving, setSaving, loadGeneration, issues, setIssues, warnings, setWarnings, message, setMessage, error, setError, rawSourceIds, setRawSourceIds } = session;
  const [catalogEditorEpoch, setCatalogEditorEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState('browser');
  const sourcePanel = useRef<HTMLDivElement>(null);
  // start each selected section at the top without remounting its drafts
  useLayoutEffect(() => { sourcePanel.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [selectedId]);
  const [disclosures, setDisclosures] = useState(() => new Map<string, Disclosure>());
  const disclosuresRef = useRef(disclosures);
  const disclosureGeneration = useRef(0);
  const revealing = useRef(new Map<string, { sourceId: string; path: string[]; cancelled: boolean }>());
  const [confirmation, setConfirmation] = useState<'discard' | 'close'>();
  const [handoverSources, setHandoverSources] = useState<Pick<SettingsSource, 'id' | 'label'>[]>();
  const handoverResolution = useRef<((choices: SettingsHandoverChoices | undefined) => void) | undefined>(undefined);
  const ownerMounted = useRef(true);
  const closeResolution = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const [query, setQuery] = useState('');
  const browserDraft = useBrowserSettingsDraft(browser, loading || saving || !runtime.canMutate, operationPending, browserDraftState);
  disclosuresRef.current = disclosures;

  // cancel the paused save without touching any authored drafts
  const cancelHandover = useCallback(() => {
    // a new workspace view cannot cancel an ordinary shared save
    if (handoverResolution.current !== undefined) saveCancelled.current = true;
    setHandoverSources(undefined);
    handoverResolution.current?.(undefined);
    handoverResolution.current = undefined;
  }, [saveCancelled]);
  // revoke pending consent on controller, connection, or workspace changes
  useEffect(() => { cancelHandover(); }, [active, runtime.canMutate, runtime.securityEpoch, cancelHandover]);
  // release a paused save when its owning settings split is removed
  useEffect(() => {
    ownerMounted.current = true;
    return () => {
      ownerMounted.current = false;
      // pending consent belongs to this view but ordinary saves belong to the session
      if (handoverResolution.current !== undefined) saveCancelled.current = true;
      handoverResolution.current?.(undefined);
      handoverResolution.current = undefined;
    };
  }, [saveCancelled]);

  // discard and revoke every active disclosure lease
  const remaskAll = useCallback(async () => {
    // invalidate plaintext responses that outlive this boundary
    disclosureGeneration.current += 1;
    const leases = [...disclosuresRef.current.values()];
    disclosuresRef.current = new Map();
    setDisclosures(new Map());
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([sourceId, draft]) => {
      const disclosed = new Set(draft.disclosurePaths ?? []);
      return [sourceId, { ...draft, patches: draft.patches.filter(patch => !disclosed.has(JSON.stringify(patch.path))), content: draft.disclosureContent ? undefined : draft.content, disclosureContent: undefined, disclosurePaths: undefined }];
    })));
    // revoke independently so one stale lease cannot retain the others
    await Promise.allSettled(leases.map(disclosure => runtime.request('/api/settings/remask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: disclosure.leaseId }) })));
  }, [runtime.request]);

  // keep keyboard focus inside settings when clean header actions disappear
  const focusAfterHeaderAction = useCallback((startedInHeader: boolean) => {
    // never steal focus from a different control or an unmounted split
    if (!startedInHeader || headerActionsTarget === null) return;
    const focused = document.activeElement;
    // disabled actions may already have yielded focus to the document
    if (focused !== document.body && !headerActionsTarget.contains(focused)) return;
    const panel = headerActionsTarget.closest<HTMLElement>('[role="dialog"]');
    // the stable dialog remains available after saving or discarding
    if (panel?.isConnected) panel.focus({ preventScroll: true });
  }, [headerActionsTarget]);

  // load the redacted authoritative source catalog
  const load = useCallback(async (preserveDrafts = false) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const response = await runtime.request('/api/settings', { cache: 'no-store' });
      // surface unavailable setup rather than inventing local defaults
      if (!response.ok) {
        const responseError = await settingsResponseError(response, 'Settings could not be loaded.');
        // ignore an obsolete response owned by an earlier mount
        if (generation === loadGeneration.current) setError(responseError);
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      // ignore stale reads before changing the retained baseline
      if (generation !== loadGeneration.current) return;
      // require the versioned snapshot boundary
      if (!isSettingsSnapshot(payload)) { setError('Settings returned an unsupported response.'); return; }
      setSnapshot(payload);
      setSources(payload.sources);
      // retain virtual pages and redirect removed standalone tabs
      setSelectedId(current => {
        const next = current === 'compose' ? 'compose-override' : current === 'wrapper' ? 'tmux' : current;
        return next === 'browser' || next === 'voice' || next === 'keyboard' || next === 'tmux' || next === 'projects' || payload.sources.some(source => source.id === next) ? next : 'browser';
      });
      if (!preserveDrafts) { setDrafts({}); setIssues([]); setWarnings([]); setCatalogEditorEpoch(current => current + 1); }
      setError('');
      await runtime.refreshStatus();
    } catch {
      // leave a newer load or transaction in control
      if (generation === loadGeneration.current) setError('Settings could not be loaded.');
    } finally {
      // only the newest read may release the shared loading lock
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [loadGeneration, runtime.refreshStatus, runtime.request, setDrafts, setLoading, setSnapshot, setSources]);

  // lock refresh and discard before waiting for disclosure revocation
  const reloadFiles = async () => {
    // preserve any already captured save or validation transaction
    if (operationPending.current || loading) return;
    const startedInHeader = headerActionsTarget?.contains(document.activeElement) === true;
    operationPending.current = true;
    loadGeneration.current += 1;
    setLoading(true);
    try { await remaskAll(); await load(); focusAfterHeaderAction(startedInHeader); }
    finally { operationPending.current = false; setLoading(false); }
  };

  // discard browser drafts without requiring an available file catalog
  const discardChanges = async () => {
    // preserve an already captured transaction
    if (operationPending.current || loading) return;
    const startedInHeader = headerActionsTarget?.contains(document.activeElement) === true;
    operationPending.current = true;
    loadGeneration.current += 1;
    setSaving(true);
    try {
      browserDraft.discard();
      setMessage(''); setError('');
      await remaskAll();
      // reconcile saved files only when file drafts actually changed
      if (changes.length > 0) await load();
      else { setDrafts({}); setIssues([]); setWarnings([]); setMessage(''); setError(''); setCatalogEditorEpoch(current => current + 1); }
      focusAfterHeaderAction(startedInHeader);
    } finally {
      operationPending.current = false;
      setSaving(false);
    }
  };

  // refresh pristine sessions without rebasing retained edits onto new files
  useEffect(() => { if (active && changes.length === 0 && !operationPending.current) void load(); }, [active, load]);

  // clear disclosed plaintext on navigation, controller lifecycle, or reconnect signals
  useEffect(() => { void remaskAll(); }, [active, runtime.securityEpoch, remaskAll]);
  useEffect(() => () => { /* revoke leases on controller loss */ void remaskAll(); }, [remaskAll]);

  const selected = sources.find(source => source.id === selectedId);
  const disabled = loading || saving || selected?.writable === false || !runtime.canMutate;

  // retain one structured patch and update only safe local previews
  const patch = useCallback<SetPatch>((source, nextPatch, disclosureDerived = false) => {
    // ignore events queued before the busy render
    if (operationPending.current) return;
    const currentValue = valueAt(source.value, nextPatch.path);
    const revisionId = nextPatch.op === 'set' && !isProtectedValue(currentValue) ? source.pathRevisions?.[JSON.stringify(nextPatch.path)] : undefined;
    const revisionedPatch = revisionId === undefined ? nextPatch : { ...nextPatch, revisionId };
    setDrafts(current => {
      const draft = current[source.id] ?? { patches: [] };
      const pathKey = JSON.stringify(nextPatch.path);
      const disclosurePaths = new Set(draft.disclosurePaths ?? []);
      // retain edits made before collection indexes changed
      const patches = appendSettingsPatch(draft.patches, revisionedPatch);
      if (nextPatch.op === 'set' && disclosureDerived) disclosurePaths.add(pathKey);
      else disclosurePaths.delete(pathKey);
      return { ...current, [source.id]: { ...draft, patches, content: undefined, disclosureContent: undefined, disclosurePaths: [...disclosurePaths], remove: undefined } };
    });
    setSources(current => current.map(candidate => {
      if (candidate.id !== source.id) return candidate;
      const prior = valueAt(candidate.value, nextPatch.path);
      // masked leaves stay masked while their replacement lives only in the draft
      if (isProtectedValue(prior)) return candidate;
      if (candidate.format === 'env' && nextPatch.path.length === 1) {
        const key = nextPatch.path[0]!;
        const fields = candidate.fields ?? [];
        // update existing safe environment fields without exposing protected ones
        if (nextPatch.op === 'set') return { ...candidate, fields: fields.some(field => field.key === key) ? fields.map(field => field.key === key && !field.protected ? { ...field, value: String(nextPatch.value ?? ''), present: true } : field) : [...fields, { key, protected: protectedSettingIdentity(key), ...(protectedSettingIdentity(key) ? {} : { value: String(nextPatch.value ?? '') }), present: true, apply: candidate.apply }] };
        if (nextPatch.op === 'remove') return { ...candidate, fields: fields.map(field => field.key === key ? { ...field, value: undefined, present: false } : field) };
      }
      try { return { ...candidate, value: applyLocalPatch(candidate.value, nextPatch, candidate.id), pathRevisions: applyRevisionPatch(candidate.pathRevisions, nextPatch) }; }
      // keep rejected structural drafts pending without replacing the last usable preview
      catch { return candidate; }
    }));
    setMessage(''); setError('');
  }, []);

  // stage one whole-source replacement in memory
  const setContent = useCallback((source: SettingsSource, content: string) => {
    // retain the transaction captured for validation
    if (operationPending.current) return;
    const disclosureContent = disclosuresRef.current.has(disclosureKey(source.id, []));
    setDrafts(current => ({ ...current, [source.id]: { ...(current[source.id] ?? { patches: [] }), patches: [], content, disclosureContent, remove: undefined } }));
    setMessage(''); setError('');
  }, []);

  // stage one optional source removal
  const removeSource = useCallback((source: SettingsSource) => {
    // retain the transaction captured for validation
    if (operationPending.current) return;
    setDrafts(current => ({ ...current, [source.id]: { patches: [], remove: true } }));
    setMessage(''); setError('');
  }, []);

  // accept only one disclosure request within the current navigation epoch
  const reveal = useCallback(async (source: SettingsSource, path: string[]) => {
    const key = disclosureKey(source.id, path);
    // avoid duplicate leases and events preceding the busy render
    if (operationPending.current || revealing.current.has(key)) return;
    const pending = { sourceId: source.id, path, cancelled: false };
    revealing.current.set(key, pending);
    const generation = disclosureGeneration.current;
    try {
      const response = await runtime.request('/api/settings/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: source.id, revisionId: source.revisionId, ...(path.length === 0 ? {} : { path }) }) });
      const payload = await response.json().catch(() => undefined) as { value?: unknown; revisionId?: unknown; leaseId?: unknown; expiresAt?: unknown; error?: unknown } | undefined;
      // revoke late leases rather than bringing plaintext back after remasking
      if (generation !== disclosureGeneration.current || pending.cancelled) {
        if (typeof payload?.leaseId === 'string') await runtime.request('/api/settings/remask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: payload.leaseId }) });
        return;
      }
      // reject stale and malformed disclosures
      if (!response.ok || typeof payload?.leaseId !== 'string' || typeof payload.expiresAt !== 'string' || payload.revisionId !== source.revisionId) { setError(typeof payload?.error === 'string' ? payload.error : 'Protected value could not be revealed.'); return; }
      const disclosure = { sourceId: source.id, path, value: payload.value, leaseId: payload.leaseId, expiresAt: payload.expiresAt };
      disclosuresRef.current = new Map(disclosuresRef.current).set(key, disclosure);
      setDisclosures(current => new Map(current).set(key, disclosure));
    } catch {
      // leave obsolete navigation untouched when a request fails
      if (generation === disclosureGeneration.current && !pending.cancelled) setError('Protected value could not be revealed.');
    } finally {
      revealing.current.delete(key);
    }
  }, [runtime.request]);

  // revoke and forget one disclosure
  const remask = useCallback(async (key: string) => {
    // cancel in-flight plaintext even before its field has received a lease
    const pending = revealing.current.get(key);
    if (pending !== undefined) pending.cancelled = true;
    const disclosure = disclosuresRef.current.get(key);
    disclosuresRef.current = new Map(disclosuresRef.current);
    disclosuresRef.current.delete(key);
    setDisclosures(current => { const next = new Map(current); next.delete(key); return next; });
    // discard whole-source plaintext derived from this disclosure
    if (disclosure?.path.length === 0) setDrafts(current => {
      const draft = current[disclosure.sourceId];
      return draft?.disclosureContent === true ? { ...current, [disclosure.sourceId]: { ...draft, content: undefined, disclosureContent: undefined } } : current;
    });
    // discard a candidate copied out of one field disclosure
    if (disclosure !== undefined && disclosure.path.length > 0) setDrafts(current => {
      const draft = current[disclosure.sourceId];
      const pathKey = JSON.stringify(disclosure.path);
      return draft?.disclosurePaths?.includes(pathKey) === true ? { ...current, [disclosure.sourceId]: { ...draft, patches: draft.patches.filter(patch => JSON.stringify(patch.path) !== pathKey), disclosurePaths: draft.disclosurePaths.filter(candidate => candidate !== pathKey) } } : current;
    });
    // tolerate an already-expired lease
    if (disclosure !== undefined) {
      try {
        const response = await runtime.request('/api/settings/remask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: disclosure.leaseId }) });
        // keep plaintext hidden even if host-side lease revocation is unavailable
        if (!response.ok) setError('Value hidden locally, but its server disclosure could not be revoked.');
      } catch {
        // never restore plaintext after a transport failure
        setError('Value hidden locally, but its server disclosure could not be revoked.');
      }
    }
  }, [runtime.request]);

  // revoke accepted and pending leases before hiding or reindexing item editors
  const hideCollection = useCallback((source: SettingsSource, path: string[]) => {
    // retain plaintext boundaries captured by an active transaction
    if (operationPending.current) return;
    const affected = new Map<string, { sourceId: string; path: string[] }>([...revealing.current, ...disclosuresRef.current]);
    // preserve unrelated disclosures and independently authored drafts
    for (const [key, disclosure] of affected) {
      if (disclosure.sourceId === source.id && path.length <= disclosure.path.length && path.every((part, index) => part === disclosure.path[index])) void remask(key);
    }
  }, [remask]);

  // expire disclosure leases even while the settings view stays open
  useEffect(() => {
    const timers = [...disclosures.entries()].map(([key, disclosure]) => window.setTimeout(() => { /* clear expired plaintext and derived drafts */ void remask(key); }, Math.min(Math.max(Date.parse(disclosure.expiresAt) - Date.now(), 0), 2_147_000_000)));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [disclosures, remask]);

  // serialize only changed sources with opaque revisions
  const changes = useMemo<SettingsChange[]>(() => sources.flatMap(source => {
    const draft = drafts[source.id];
    // omit handover choices until an actual source edit exists
    if (!hasDraftMutation(draft)) return [];
    const baseline = snapshot?.sources.find(candidate => candidate.id === source.id);
    const knownValues = [...disclosures.values()].filter(disclosure => disclosure.sourceId === source.id);
    // exclude reversible no-op edits against the saved snapshot, not its local preview
    if (baseline === undefined || !hasSettingsDraftChanges(baseline, draft, (value, next) => applyLocalPatch(value, next, source.id), knownValues)) return [];
    // omit neutral leaf writes, including unchanged disclosed credentials
    const patches = effectiveSettingsPatches(baseline, draft.patches, (value, next) => applyLocalPatch(value, next, source.id), knownValues);
    return [{ sourceId: source.id, revisionId: source.revisionId, ...(patches.length === 0 ? {} : { patches }), ...(draft.content === undefined ? {} : { content: draft.content }), ...(draft.remove === undefined ? {} : { remove: draft.remove }) }];
  }), [disclosures, drafts, snapshot?.sources, sources]);
  const dirtyCount = changes.length + (browserDraft.dirty ? 1 : 0);
  const confirmationTarget = headerActionsTarget?.closest<HTMLElement>('.client-settings-page');
  // route every split close through the current semantic dirty state
  useImperativeHandle(closeGuardRef, () => ({
    // wait for an explicit decision rather than dropping staged edits
    requestClose: () => {
      // do not interrupt an active transaction or replace another confirmation
      if (operationPending.current || saving || confirmation !== undefined || loading && dirtyCount > 0) return Promise.resolve(false);
      // pristine and reverted edits close without a prompt
      if (dirtyCount === 0) return Promise.resolve(true);
      // an unavailable split target cannot safely collect discard consent
      if (confirmationTarget == null) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        closeResolution.current = resolve;
        setConfirmation('close');
      });
    }
  }), [confirmation, confirmationTarget, dirtyCount, loading, saving]);
  // abort unresolved close requests when their split is removed externally
  useEffect(() => () => { closeResolution.current?.(false); closeResolution.current = undefined; }, []);
  // keep every draft intact when the confirmation is cancelled
  const cancelConfirmation = () => {
    // preserve the already captured discard transaction
    if (operationPending.current) return;
    setConfirmation(undefined);
    closeResolution.current?.(false);
    closeResolution.current = undefined;
  };
  // share the real discard path before either staying open or closing
  const confirmDiscard = async () => {
    // capture only one explicit confirmation action
    if (operationPending.current || loading || confirmation === undefined) return;
    const closing = confirmation === 'close';
    await discardChanges();
    setConfirmation(undefined);
    // release the caller only after disclosure revocation and discard complete
    if (closing) {
      closeResolution.current?.(true);
      closeResolution.current = undefined;
    }
  };
  const changedSourceIds = new Set(changes.map(change => change.sourceId));
  // surface icon file and location edits beside their application controls
  if (changes.some(change => editableIconSources.has(change.sourceId) || change.sourceId === 'installation' && change.patches?.some(patch => patch.path[0] === 'sources' && patch.path[1] === 'icons'))) changedSourceIds.add('app');
  // surface edits from every backing source on the virtual TMUX tab
  if (changes.some(isTmuxSettingsChange)) changedSourceIds.add('tmux');
  // reflect project edits and opaque whole-application drafts on their dedicated page
  if (changes.some(change => change.sourceId === 'app' && (change.content !== undefined || change.remove === true || change.patches?.some(next => next.path[0] === 'projects' || next.path.length === 0 && (next.op === 'set' || next.op === 'remove'))))) changedSourceIds.add('projects');
  // include browser-only drafts in the shared navigation and header
  if (browserDraft.dirty) changedSourceIds.add('browser');

  // validate the complete staged transaction without saving it
  const validate = useCallback(async (submittedChanges = changes): Promise<SettingsValidation | undefined> => {
    const browserError = browserDraft.validate();
    // reject browser identity errors before committing any files
    if (browserError !== undefined) { setError(browserError); return undefined; }
    // browser-only validation never submits an empty file transaction
    if (submittedChanges.length === 0) {
      setIssues([]); setWarnings([]); setError(''); setMessage('Validation passed. Save will apply these browser preferences.');
      return { valid: true, issues: [] };
    }
    const response = await runtime.request('/api/settings/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: submittedChanges }) });
    const payload = await response.json().catch(() => undefined) as SettingsValidation | { error?: unknown } | undefined;
    // preserve field issues and safe warnings
    if (!response.ok || payload === undefined || !('valid' in payload) || typeof payload.valid !== 'boolean' || !Array.isArray(payload.issues)) { setError(payload !== undefined && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Settings could not be validated.'); return undefined; }
    // ownership decisions belong only to the save overlay, never the editor panel
    setIssues(payload.issues.filter(issue => issue.code !== 'migration_required'));
    setWarnings(payload.warnings ?? []);
    setError('');
    setMessage(payload.valid ? 'Validation passed. Save will persist these files.' : payload.issues.some(issue => issue.code === 'migration_required') ? 'Save changes to choose a source handover.' : 'Fix the validation issues before saving.');
    return payload;
  }, [browserDraft.validate, changes, runtime.request]);

  // lock validation and commit together so rapid clicks cannot duplicate writes
  const save = useCallback(async () => {
    // capture only one controller-owned transaction
    if (operationPending.current || loading || !runtime.canMutate || dirtyCount === 0) return;
    const startedInHeader = headerActionsTarget?.contains(document.activeElement) === true;
    const returnFocus = startedInHeader && document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    operationPending.current = true;
    saveCancelled.current = false;
    loadGeneration.current += 1;
    setSaving(true);
    let filesSaved = false;
    let prompted = false;
    try {
      let submittedChanges = changes;
      // revalidate each explicit decision before making any durable write
      while (true) {
        const validation = await validate(submittedChanges);
        // revoked control and cancelled prompts cannot resume a captured save
        if (saveCancelled.current || prompted && !ownerMounted.current || validation === undefined) return;
        // only authoritative successful validation can unlock commit
        if (validation.valid) break;
        const requirements = validation.issues.filter(issue => issue.code === 'migration_required');
        // repair ordinary validation failures before asking ownership questions
        if (requirements.length === 0 || requirements.length !== validation.issues.length) return;
        const requiredIds = [...new Set(requirements.map(issue => issue.sourceId))];
        const requiredSources = requiredIds.map(id => sources.find(source => source.id === id));
        // never open an orphaned prompt after its owning view has disappeared
        if (!ownerMounted.current || confirmationTarget?.isConnected !== true) return;
        // reject foreign owners or repeated requirements rather than guessing consent
        if (requiredSources.some(source => source === undefined || !['installation', 'env', 'compose'].includes(source.format)) || requiredIds.some(id => !submittedChanges.some(change => change.sourceId === id) || submittedChanges.some(change => change.sourceId === id && change.migration !== undefined))) {
          setError('Source handover requirements could not be confirmed. Review your changes and save again.');
          return;
        }
        setMessage('');
        prompted = true;
        // keep the save locked while the decision overlay remains interactive
        const choices = await new Promise<SettingsHandoverChoices | undefined>(resolve => {
          handoverResolution.current = resolve;
          setHandoverSources(requiredSources as Pick<SettingsSource, 'id' | 'label'>[]);
        });
        // cancellation leaves file and browser drafts untouched
        if (choices === undefined || saveCancelled.current || !ownerMounted.current) return;
        submittedChanges = submittedChanges.map(change => choices[change.sourceId] === undefined ? change : { ...change, migration: { mode: choices[change.sourceId]! } });
      }
      // apply browser preferences only after every file edit has saved successfully
      if (submittedChanges.length > 0) {
        const response = await runtime.request('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: submittedChanges }) });
        // distinguish external edits from ordinary validation failures
        if (!response.ok) { setError(response.status === 409 ? 'A settings file changed outside Settings. Refresh and review your changes before saving again.' : await settingsResponseError(response, 'Settings could not be saved.')); return; }
        const payload: unknown = await response.json().catch(() => undefined);
        // keep browser drafts unapplied when the file result cannot be confirmed
        if (!isSettingsSnapshot(payload)) { setError('Settings saved, but their refreshed state is unavailable. Browser changes remain unsaved. Reload Settings before editing again.'); return; }
        filesSaved = true;
        setSnapshot(payload); setSources(payload.sources); setDrafts({}); setIssues([]); setWarnings([]); setCatalogEditorEpoch(current => current + 1);
      }
      // do not start a browser write after ownership was revoked during file commit
      const browserError = browserDraft.dirty ? saveCancelled.current ? 'Saving was interrupted; browser preferences remain unsaved.' : await browserDraft.save() : undefined;
      // the identity endpoint and browser storage cannot share the file transaction
      if (browserError !== undefined) {
        setMessage('');
        setError(filesSaved ? `Files saved, but browser changes remain unsaved. ${browserError}` : browserError);
      } else {
        focusAfterHeaderAction(startedInHeader);
        // restore summary defaults even when only browser preferences were saved
        if (!filesSaved) setCatalogEditorEpoch(current => current + 1);
        // use the shared transient toast instead of retaining a success banner
        setMessage('');
        onSavedNotice(filesSaved ? 'Settings updated.' : 'Browser preferences applied.');
        setError('');
      }
      // reconcile committed files even when a later browser identity write failed
      if (filesSaved) {
        await remaskAll();
        await Promise.allSettled([runtime.refreshStatus(), onSaved()]);
      }
    } catch {
      setError(filesSaved ? 'Files saved, but browser changes could not be confirmed. Review the remaining browser drafts before retrying.' : 'Settings could not be saved. Your drafts remain; refresh to reconcile files before retrying if the connection was interrupted.');
    } finally {
      operationPending.current = false;
      setSaving(false);
      // restore the save action only after the paused transaction unlocks it
      if (prompted && returnFocus !== undefined) window.requestAnimationFrame(() => {
        const focused = document.activeElement;
        // never steal focus from another split or a newly chosen control
        if (returnFocus.isConnected && !returnFocus.matches(':disabled') && (focused === document.body || focused === confirmationTarget)) returnFocus.focus({ preventScroll: true });
      });
    }
  }, [browserDraft.dirty, browserDraft.save, changes, confirmationTarget, dirtyCount, focusAfterHeaderAction, headerActionsTarget, loading, onSaved, onSavedNotice, remaskAll, runtime.canMutate, runtime.refreshStatus, runtime.request, saveCancelled, sources, validate]);

  // resume the captured transaction only from an explicit modal decision
  const confirmHandover = (choices: SettingsHandoverChoices) => {
    // reject consent after control or the owning settings split has changed
    if (saveCancelled.current || !ownerMounted.current || !active || !runtime.canMutate) { cancelHandover(); return; }
    const resolve = handoverResolution.current;
    handoverResolution.current = undefined;
    setHandoverSources(undefined);
    resolve?.(choices);
  };

  // prevent validation from racing edits or another save
  const validateDrafts = async () => {
    // do not run a second transaction while the first is pending
    if (operationPending.current || loading || !runtime.canMutate) return;
    operationPending.current = true;
    loadGeneration.current += 1;
    setSaving(true);
    try { await validate(); } catch { setError('Settings could not be validated. Your drafts remain.'); }
    finally { operationPending.current = false; setSaving(false); }
  };

  // keep advanced voice configuration beside its existing live controls
  const voiceSource = sources.find(source => source.id === 'app');
  const voiceSchema = voiceSource?.schema?.properties?.integrations?.properties?.realtime;
  const advancedVoice = Object.entries(voiceSchema?.properties ?? {}).filter(([key]) => !dedicatedApplicationPaths.has(`integrations.realtime.${key}`));
  const voiceFileDraft = voiceSource === undefined || !changedSourceIds.has(voiceSource.id) ? undefined : drafts[voiceSource.id];

  // retain blank voice names locally until the operator corrects them
  const voiceNameInvalid = changes.some(change => change.sourceId === 'app' && change.patches?.some(patch => patch.op === 'set' && patch.path.join('.') === 'integrations.realtime.name' && typeof patch.value === 'string' && !patch.value));
  const voiceEditor = <VoiceEditor source={voiceSource} voice={voice} draft={voiceFileDraft} disabled={loading || saving || !runtime.canMutate || voiceSource === undefined || voiceSource.value === undefined || !voiceSource.writable || voiceFileDraft?.content !== undefined || voiceFileDraft?.remove === true} disclosures={disclosures} issues={issues} onPatch={patch} onReveal={reveal} onRemask={remask} />;

  // share source locks across application-backed structured editors
  const applicationFieldsDisabled = loading || saving || !runtime.canMutate || voiceSource === undefined || voiceSource.value === undefined || !voiceSource.writable || voiceFileDraft?.content !== undefined || voiceFileDraft?.remove === true;
  // reuse the original project schema and source identity without competing with raw edits
  const projectsSchema = voiceSource?.schema?.properties?.projects;
  const projectsEditor = <div className="settings-projects">
    {voiceSource === undefined ? <p role="note">Load Application configuration before editing projects.</p>
      : voiceSource.value === undefined ? <p role="note">Repair the Application whole source before editing projects.</p>
        : projectsSchema === undefined ? <p role="note">Project settings are unavailable in this configuration.</p>
          : <>
            {!voiceSource.writable && <p role="note">Projects are read-only in this installation.</p>}
            {voiceFileDraft?.content !== undefined && <p role="note">Finish or discard the Application whole-source draft before editing projects.</p>}
            {voiceFileDraft?.remove === true && <p role="note">Discard the Application source removal before editing projects.</p>}
            <SchemaField key={`projects:${catalogEditorEpoch}`} source={voiceSource} schema={projectsSchema} value={valueAt(voiceSource.value, ['projects'])} path={['projects']} draft={voiceFileDraft} disclosures={disclosures} issues={issues} disabled={applicationFieldsDisabled} navigationDisabled={loading || saving} onPatch={patch} onReveal={reveal} onRemask={remask} onHideCollection={hideCollection} />
          </>}
  </div>;
  // revoke only disclosures whose binding or table is explicitly replaced or removed
  const stageKeyboardPatches = (patches: SettingsPatch[]): boolean => {
    // retain controller and captured-transaction authority
    if (operationPending.current || voiceSource === undefined || applicationFieldsDisabled) return false;
    // pending and accepted disclosures share the same ancestor-edit boundary
    const affected = new Map<string, { sourceId: string; path: string[] }>([...revealing.current, ...disclosuresRef.current]);
    for (const [key, disclosure] of affected) {
      // sibling edits such as reuse never discard an independently staged command
      if (disclosure.sourceId === voiceSource.id && patches.some(next => next.path.length <= disclosure.path.length && next.path.every((part, index) => part === disclosure.path[index]))) void remask(key);
    }
    for (const next of patches) patch(voiceSource, next);
    return true;
  };
  // use authoritative reuse metadata with the runtime false fallback
  const keyboardReuseSchema = voiceSource?.schema?.properties?.keys?.items?.items?.variants?.find(variant => variant.properties?.terminal !== undefined)?.properties?.reuse;
  const keyboardSettings = <section className="settings-keyboard" aria-label="Server keyboard shortcuts"><p>The server's <code>config.json</code> <code>keys</code> field is the source of truth. Use Save changes to persist shortcuts with all other drafts.</p><button type="button" onClick={openBindingsSheet}>View active shortcuts</button>{voiceSource === undefined && <p role="note">Load the Application config before editing keyboard shortcuts.</p>}{voiceSource !== undefined && voiceSource.value === undefined && <p role="note">Repair the Application whole source before editing keyboard shortcuts.</p>}{voiceFileDraft?.content !== undefined && <p role="note">Finish or discard the Application whole-source draft before editing keyboard shortcuts.</p>}{voiceFileDraft?.remove === true && <p role="note">Discard the Application source removal before editing keyboard shortcuts.</p>}{voiceSource !== undefined && voiceSource.value !== undefined && <KeyboardConfigurationEditor keys={valueAt(voiceSource.value, ['keys'])} disabled={applicationFieldsDisabled} navigationDisabled={loading || saving} readOnly={loading || !runtime.canMutate || !voiceSource.writable || voiceFileDraft?.content !== undefined || voiceFileDraft?.remove === true} onChange={stageKeyboardPatches} onNavigate={() => { /* preserve captured transactions even before the busy render */ if (operationPending.current) return false; void remaskAll(); return true; }} renderProtectedTerminal={(table, chord) => {
    const path = ['keys', table, chord, 'terminal'];
    const reusePath = ['keys', table, chord, 'reuse'];
    return <><ProtectedField source={voiceSource} path={path} label="Terminal command" description="Edit the protected command here. Saving never executes it." schema={{ type: 'string', apply: 'rac-restart' }} draft={voiceFileDraft} disclosure={disclosures.get(disclosureKey(voiceSource.id, path))} disabled={applicationFieldsDisabled} showRemove={false} onPatch={patch} onReveal={reveal} onRemask={remask} /><SchemaField source={voiceSource} path={reusePath} schema={{ type: 'boolean', optional: true, default: false, ...keyboardReuseSchema, label: 'Reuse terminal', description: 'Focus a matching terminal instead of opening another one.', apply: 'rac-restart' }} value={valueAt(voiceSource.value, reusePath)} draft={voiceFileDraft} disclosures={disclosures} issues={issues} disabled={applicationFieldsDisabled} onPatch={patch} onReveal={reveal} onRemask={remask} /></>;
  }} />}</section>;

  // retain environment rows when their alternative editor is unavailable or raw
  const environmentPeerSources = sources.filter(source => !rawSourceIds.has(source.id) && drafts[source.id]?.content === undefined && drafts[source.id]?.remove !== true);
  const dedicatedEnvironmentKeys = environmentKeysWithDedicatedControls(environmentPeerSources, snapshot?.installationKind);

  // keep all preference pages in the shared save flow
  const preferences = [
    { id: 'browser', group: 'Console', label: 'This browser', kicker: 'Browser preferences', description: 'Client identity, appearance, terminal and workspace preferences. Save changes applies these preferences to this browser.', keywords: 'client rename theme dark light terminal font reduced motion flyout markers dynamic worktrees', content: browserDraft.content },
    { id: 'voice', group: 'Console', label: 'Voice', kicker: 'Application preferences', description: 'Voice assistant preferences and context are saved together with application configuration.', keywords: 'davo voice assistant name context enable write tools advanced', content: voiceEditor },
    { id: 'keyboard', group: 'Console', label: 'Keyboard shortcuts', kicker: 'Server configuration', description: 'Server-wide bindings are saved in application config, not browser storage. Save changes persists all drafts together.', keywords: 'keyboard shortcuts bindings keys prefix terminal command', content: keyboardSettings },
    { id: 'projects', group: 'Application', label: 'Projects', kicker: 'Application configuration', description: '', keywords: 'projects repositories directories worktrees paths overrides commands tasks push', content: projectsEditor },
    { id: 'tmux', group: 'Application', label: 'TMUX', kicker: 'Application configuration', description: '', keywords: `tmux polling pollIntervalMs wrapper executable connection discovery socket ${[...tmuxEnvironmentKeys].join(' ')} ${sources.find(source => source.id === 'wrapper')?.path ?? ''}`, content: <TmuxSettings sources={sources} installationKind={snapshot?.installationKind} drafts={drafts} disclosures={disclosures} issues={issues} disabled={loading || saving || !runtime.canMutate} navigationDisabled={loading || saving} onPatch={patch} onContent={setContent} onRemove={removeSource} onReveal={reveal} onRemask={remask} onHideCollection={hideCollection} /> }
  ];
  // select preference pages independently of the file catalog
  const selectedPreference = preferences.find(preference => preference.id === selectedId);
  const search = query.trim().toLowerCase();
  // search existing preferences by their controls as well as their page labels
  const visiblePreferences = preferences.filter(preference => !search || `${preference.label} ${preference.keywords}`.toLowerCase().includes(search));
  // keep every known file section visible until the installation identifies its sources
  const navigationSources = snapshot === undefined ? pendingSourceNavigation : sources;
  // filter pending and authoritative source identities with the same search term
  const visibleSources = navigationSources.filter(source => source.id !== 'compose' && source.id !== 'wrapper' && !editableIconSources.has(source.id) && (!search || `${source.label} ${source.path ?? ''} ${source.format} ${sourceGroup(source)}`.toLowerCase().includes(search)));
  // merge file-backed and virtual pages beneath their visible group
  const groups = [...new Set([...visiblePreferences.map(preference => preference.group), ...visibleSources.map(sourceGroup)])];
  // keep the custom selector honest when search hides the open section
  const selectedOutsideSearch = !visiblePreferences.some(preference => preference.id === selectedId) && !visibleSources.some(source => source.id === selectedId);
  const selectedLabel = selectedPreference?.label ?? selected?.label ?? 'This browser';
  // browser navigation never depends on the installation files
  const sectionLoading = (id: string): boolean => loading && id !== 'browser';
  // unavailable file placeholders cannot open an invented editor
  const sectionDisabled = (id: string): boolean => sectionLoading(id) || snapshot === undefined && (id === 'tmux' || id === 'projects' || !preferences.some(preference => preference.id === id));
  // preserve grouping, artwork and active state in the custom mobile menu
  const navigationOptions: SettingsSelectOption[] = [
    ...(selectedOutsideSearch ? [{ value: selectedId, label: `${selectedLabel}${changedSourceIds.has(selectedId) ? ' · Unsaved changes' : ''} (outside search results)`, group: 'Current section', disabled: sectionDisabled(selectedId), icon: sectionLoading(selectedId) ? <span className="spinner" /> : sectionIcon(selectedId, selected?.format) }] : []),
    ...groups.flatMap(group => [
      ...visibleSources.filter(source => sourceGroup(source) === group).map(source => ({ value: source.id, label: `${source.label}${changedSourceIds.has(source.id) ? ' · Unsaved changes' : ''}`, group, disabled: sectionDisabled(source.id), icon: sectionLoading(source.id) ? <span className="spinner" /> : sectionIcon(source.id, source.format) })),
      ...visiblePreferences.filter(preference => preference.group === group).map(preference => ({ value: preference.id, label: `${preference.label}${changedSourceIds.has(preference.id) ? ' · Unsaved changes' : ''}`, group, disabled: sectionDisabled(preference.id), icon: sectionLoading(preference.id) ? <span className="spinner" /> : sectionIcon(preference.id) }))
    ])
  ];
  // share draft retention and disclosure revocation across both navigation layouts
  const selectSection = (id: string) => {
    // retain transaction boundaries and reject sections without ready files
    if (operationPending.current || sectionDisabled(id)) return;
    void remaskAll();
    setSelectedId(id);
  };
  // receive quick-reference navigation without losing a closed split request
  useEffect(() => {
    // wait for an explicit keyboard navigation request
    if (requestedSection === undefined || operationPending.current) return;
    void remaskAll();
    setSelectedId(requestedSection.id);
    onSectionSelected(requestedSection.request);
  }, [requestedSection, remaskAll, saving, loading, onSectionSelected]);
  // open the saved redacted base rather than any editor draft or disclosed bytes
  const baseCompose = snapshot?.sources.find(source => source.id === 'compose');
  const previewBaseCompose = () => {
    // require catalog content and a workspace-owned Code destination
    if (loading || baseCompose?.content === undefined || workspaceEditor.preview === undefined) return;
    workspaceEditor.preview({ path: baseCompose.path ?? 'compose.yaml', content: baseCompose.content.replace(/__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/gu, '********') });
  };
  const selectedSupportsRawRepair = selected?.format === 'json' || selected?.format === 'installation' || selected?.format === 'env';
  const forceRawMode = selected !== undefined && selected.value === undefined && (selected.format === 'json' || selected.format === 'installation');
  const rawMode = selected !== undefined && (rawSourceIds.has(selected.id) || forceRawMode);
  // switch representations only after discarding incompatible local edits
  const toggleRawMode = () => {
    if (selected === undefined || forceRawMode) return;
    void remaskAll();
    setDrafts(current => {
      const draft = current[selected.id];
      return draft === undefined ? current : { ...current, [selected.id]: { patches: [] } };
    });
    setRawSourceIds(current => { const next = new Set(current); if (rawMode) next.delete(selected.id); else next.add(selected.id); return next; });
    setMessage(''); setError('');
  };
  // retain transaction status without a redundant page introduction
  return <section className="settings-center" aria-label="Settings center" aria-busy={saving}>
    <header className="settings-center-header"><span className="settings-center-summary"><span className="settings-dirty-summary" aria-live="polite">{dirtyCount === 0 ? 'No unsaved changes' : [browserDraft.dirty ? 'Browser preferences changed' : undefined, changes.length > 0 ? `${changes.length} file source${changes.length === 1 ? '' : 's'} changed` : undefined].filter(Boolean).join(' · ')}</span></span></header>
    {snapshot === undefined && <div className="settings-catalog-state" role={loading ? 'status' : 'alert'}>{loading ? <><span className="spinner" />Loading installation files…</> : <><span>Installation files are unavailable. Browser settings remain available; voice settings are read-only.</span><button type="button" onClick={() => { /* retry without discarding browser preferences */ void reloadFiles(); }}>Retry files</button></>}</div>}
    <label className="settings-search"><span>Search settings</span><input type="search" value={query} placeholder="Search browser, voice, application, deployment…" onChange={event => { /* filter both preference pages and file sources */ setQuery(event.target.value); }} /></label>
    <div className="settings-center-layout">
      <div className="settings-source-select"><span>Settings section</span><SettingsSelect label="Settings section" value={selectedId} options={navigationOptions} onChange={selectSection} />{visiblePreferences.length === 0 && visibleSources.length === 0 && <small role="status">No matching sections.</small>}</div>
      {/* share mobile glyphs without replacing desktop loading and dirty indicators */}
      <nav className="settings-source-nav" aria-label="Settings sources">{groups.map(group => <Fragment key={group}>
        <h3>{group}</h3>
        {visibleSources.filter(source => sourceGroup(source) === group).map(source => <button type="button" key={source.id} className={selectedId === source.id ? 'active' : undefined} aria-current={selectedId === source.id ? 'page' : undefined} aria-busy={sectionLoading(source.id) || undefined} disabled={sectionDisabled(source.id)} title={snapshot === undefined && !loading ? 'Installation files are unavailable' : undefined} onClick={() => { /* use the same secure navigation as the mobile selector */ selectSection(source.id); }}><span className="settings-source-nav-icon" aria-hidden="true">{sectionIcon(source.id, source.format)}</span><span className="settings-source-nav-label">{source.label}</span>{sectionLoading(source.id) ? <span className="spinner" aria-hidden="true" /> : changedSourceIds.has(source.id) && <i aria-label="Unsaved changes" />}</button>)}
        {visiblePreferences.filter(preference => preference.group === group).map(preference => <button type="button" key={preference.id} className={selectedId === preference.id ? 'active' : undefined} aria-current={selectedId === preference.id ? 'page' : undefined} aria-busy={sectionLoading(preference.id) || undefined} disabled={sectionDisabled(preference.id)} onClick={() => { /* use the same secure navigation as the mobile selector */ selectSection(preference.id); }}><span className="settings-source-nav-icon" aria-hidden="true">{sectionIcon(preference.id)}</span><span className="settings-source-nav-label">{preference.label}</span>{sectionLoading(preference.id) ? <span className="spinner" aria-hidden="true" /> : changedSourceIds.has(preference.id) && <i aria-label="Unsaved changes" />}</button>)}
      </Fragment>)}</nav>
      <div ref={sourcePanel} className="settings-source-panel" role="region" aria-label={`${selectedLabel} settings content`} tabIndex={0}>{selectedPreference !== undefined ? <><header className="settings-source-header"><div><span className="settings-source-kicker">{selectedPreference.kicker}</span><h2>{selectedPreference.label}</h2>{selectedPreference.description && <p className="settings-preference-description">{selectedPreference.description}</p>}</div></header><div className="settings-preferences">{selectedPreference.content}{selectedPreference.id === 'voice' && voiceSource !== undefined && advancedVoice.length > 0 && <section className="settings-voice-advanced"><header><h3>Advanced voice configuration</h3><p>Save these preferences together with the other voice settings.</p></header>{voiceFileDraft?.content !== undefined && <p role="note">Finish or discard the Application whole-source draft before editing these fields.</p>}{advancedVoice.map(([key, schema]) => <SchemaField key={`${key}:${catalogEditorEpoch}`} source={voiceSource} schema={schema} value={valueAt(voiceSource.value, ['integrations', 'realtime', key])} path={['integrations', 'realtime', key]} draft={voiceFileDraft} disclosures={disclosures} issues={issues} disabled={disabled || voiceSource.value === undefined || !voiceSource.writable || voiceFileDraft?.content !== undefined || voiceFileDraft?.remove === true} onPatch={patch} onReveal={reveal} onRemask={remask} onHideCollection={hideCollection} navigationDisabled={loading || saving} />)}</section>}</div></> : selected !== undefined && <>
        {/* source identity alone does not establish a conflict winner */}
        <header className={`settings-source-header${selected.id === 'compose-override' ? ' settings-docker-header' : ''}`}><div><span className="settings-source-kicker">{selected.format} · {selected.exists ? 'present' : 'not created'}</span><h2>{selected.label}</h2>{selected.path && <code>{selected.path}</code>}</div>{selected.id === 'compose-override' && <button type="button" disabled={loading || baseCompose?.content === undefined || workspaceEditor.preview === undefined} onClick={previewBaseCompose}>View base compose.yaml</button>}</header>
        {!selected.writable && <p className="settings-source-warning" role="note">This source is visible but the current installation cannot write it. Repair the installation descriptor or file permissions to edit it.</p>}
        {selectedSupportsRawRepair && <div className="settings-raw-mode"><span><strong>{rawMode ? 'Whole source editor' : 'Structured editor'}</strong><small>{forceRawMode ? 'The current JSON cannot be parsed. Edit its source to repair it; credential values stay masked.' : 'Edit the source with syntax highlighting and line numbers. Credential placeholders are restored on save. Reveal keys to edit them; switching discards incompatible drafts.'}</small></span>{!forceRawMode && <button type="button" disabled={disabled} onClick={toggleRawMode}>{rawMode ? 'Use structured editor' : 'Edit whole source'}</button>}</div>}
        {rawMode || rawFormats.has(selected.format) ? <RawSourceEditor source={selected} draft={drafts[selected.id]} disclosure={disclosures.get(disclosureKey(selected.id, []))} issues={issues} disabled={disabled} onContent={setContent} onRemove={removeSource} onReveal={reveal} onRemask={remask} /> : selected.format === 'installation' ? <InstallationEditor key={`${selected.id}:${catalogEditorEpoch}`} source={selected} installationKind={snapshot?.installationKind} sources={sources} onNavigate={selectSection} draft={drafts[selected.id]} disclosures={disclosures} issues={issues} disabled={disabled} navigationDisabled={loading || saving} onPatch={patch} onReveal={reveal} onRemask={remask} onHideCollection={hideCollection} /> : selected.format === 'env' ? <EnvironmentEditor source={selected} excludedKeys={dedicatedEnvironmentKeys} draft={drafts[selected.id]} disclosures={disclosures} issues={issues} disabled={disabled} onPatch={patch} onReveal={reveal} onRemask={remask} /> : <SchemaField key={`${selected.id}:${catalogEditorEpoch}`} source={selected} schema={selected.schema} value={selected.value} path={[]} draft={drafts[selected.id]} disclosures={disclosures} issues={issues} disabled={disabled} onPatch={patch} onReveal={reveal} onRemask={remask} onHideCollection={hideCollection} navigationDisabled={loading || saving} remoteServers={remoteServers} />}
        {/* keep local icon files with their application consumer even in raw repair mode */}
        {selected.id === 'app' && <ApplicationIconSetting source={selected} showSelector={!rawMode} sources={sources} drafts={drafts} installation={sources.find(source => source.id === 'installation')} installationDraft={drafts.installation} disclosures={disclosures} issues={issues} disabled={saving || !runtime.canMutate} onPatch={patch} onContent={setContent} onRemove={removeSource} onReveal={reveal} onRemask={remask} />}
      </>}</div>
    </div>
    {(warnings.length > 0 || error || message) && <div className="settings-feedback" aria-live="polite">{warnings.map(warning => <p key={warning} className="warning">{warning}</p>)}{error && <p className="error" role="alert">{error}</p>}{!error && message && <p>{message}</p>}</div>}
    {headerActionsTarget !== null && createPortal(<>
      {/* show commit actions only while drafts remain unsaved */}
      {dirtyCount > 0 && <>
        <button type="button" className="panel-header-action settings-header-labelled-action settings-header-validate" disabled={loading || saving || !runtime.canMutate} onClick={() => { /* validate the same captured global transaction */ void validateDrafts(); }}><PanelIcon path={panelIcons.check} /><span>Validate</span></button>
        <button type="button" className="panel-header-action settings-header-discard" aria-label="Discard changes" title="Discard changes" disabled={loading || saving || !runtime.canMutate} onClick={() => { /* confirm before discarding any staged settings */ setConfirmation('discard'); }}><PanelIcon path={panelIcons.trash} /></button>
        <button type="button" className="panel-header-action settings-header-labelled-action settings-header-save" disabled={loading || saving || !runtime.canMutate || voiceNameInvalid || browserDraft.validate() !== undefined} onClick={() => { /* apply browser preferences and persist files without an implicit restart */ void save(); }}><PanelIcon path={panelIcons.save} /><span>{saving ? 'Saving…' : 'Save changes'}</span></button>
      </>}
      {/* retain refresh in the shared toolbar across every settings section */}
      <button type="button" className="panel-header-action settings-header-refresh" aria-label="Refresh files" aria-busy={loading} disabled={loading || saving || dirtyCount > 0} title={dirtyCount > 0 ? 'Discard or save local changes before refreshing files' : loading ? 'Refreshing files…' : 'Refresh files'} onClick={() => { /* revoke old plaintext before accepting new source revisions */ void reloadFiles(); }}><PanelIcon path={panelIcons.refresh} /></button>
    </>, headerActionsTarget)}
    {confirmation !== undefined && confirmationTarget != null && <SplitConfirmation target={confirmationTarget} title={confirmation === 'close' ? 'Close Settings with unsaved changes?' : 'Discard unsaved changes?'} description={confirmation === 'close' ? 'Your unsaved settings changes will be discarded. Nothing will be saved.' : 'Discard all unsaved browser, server and file changes? Nothing will be saved.'} confirmLabel={confirmation === 'close' ? 'Discard and close' : 'Discard changes'} pending={loading || saving} onCancel={cancelConfirmation} onConfirm={confirmDiscard} />}
    {handoverSources !== undefined && confirmationTarget != null && <SettingsSourceHandover target={confirmationTarget} sources={handoverSources} onConfirm={confirmHandover} onCancel={cancelHandover} />}
  </section>;
}
