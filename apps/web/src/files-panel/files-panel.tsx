import { createPortal } from 'react-dom';
import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { FlyoutPortal } from '../flyout-portal.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand, usePhoneLayout } from '../panel-header.js';
import { useViewportFlyout } from '../viewport-flyout.js';
import { OpenFolderContext } from '../open-folder.js';
import { Skeleton } from '../skeleton.js';
import type { FileSortColumn, FilesController } from './controller.js';
import { formatFileSize, formatModifiedAt } from './format.js';
import { FileIcon } from './file-icon.js';
import type { CollisionDecision, Favorite, FileEntry, FilesError, OperationConflict, OperationResult, PreparedOperation, UploadPreparation } from './contracts.js';
import './loading.css';

type NameDialog = { kind: 'create-file' | 'create-folder' | 'rename'; title: string; value: string; destinationDirectoryToken: string; entry?: FileEntry };
type PendingAction = { kind: 'operation'; prepared: PreparedOperation; entries: { name: string }[] } | { kind: 'upload'; prepared: UploadPreparation; files: File[] };
type EntryMenu = { entry: FileEntry };
type ContextMenu = { x: number; y: number; scope: { kind: 'entries'; entries: FileEntry[] } | { kind: 'directory' } };

const sortColumns: { column: FileSortColumn; label: string }[] = [
  { column: 'name', label: 'Name' },
  { column: 'owner', label: 'Owner' },
  { column: 'permissions', label: 'Permissions' },
  { column: 'modified', label: 'Modified' },
  { column: 'size', label: 'Size' }
];

// identify navigable entries without following unsupported special objects
const isDirectory = (entry: FileEntry): boolean => entry.kind === 'directory' || entry.kind === 'symlink' && entry.symlinkTargetKind === 'directory';
// identify previewable regular files and symlinks to regular files
const isPreviewable = (entry: FileEntry): boolean => entry.kind === 'file' || entry.kind === 'symlink' && entry.symlinkTargetKind === 'file';
// keep dialog filenames inside the server's leaf contract
const validLeaf = (value: string): boolean => value.length > 0 && value !== '.' && value !== '..' && !/[\/\x00-\x1f\x7f-\x9f]/u.test(value) && new TextEncoder().encode(value).length <= 255;

// render fixed table geometry without controls or cached values
function FilesLoadingRows() {
  const rows = [0, 1, 2, 3];
  return <>
    {/* repeat the complete six-column row shape */}
    {rows.map(row => <div key={row} className="files-row files-row-skeleton" role="row" aria-hidden="true">
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-name" /></span>
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-owner" /></span>
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-permissions" /></span>
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-modified" /></span>
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-size" /></span>
      <span role="gridcell"><Skeleton className="files-skeleton-cell files-skeleton-actions" /></span>
    </div>)}
  </>;
}

// render one stable operation error or partial result summary
function resultMessage(result: OperationResult | FilesError): { tone: 'status' | 'alert'; text: string } {
  // map terminal operation states to truthful copy
  if ('state' in result) {
    const failures = result.results.filter(item => item.outcome === 'failed');
    // preserve partial failure count
    if (result.state === 'partial' || failures.length > 0) return { tone: 'alert', text: `${result.completedItems} of ${result.totalItems} items completed. ${failures.length} failed.` };
    // expose an explicit failure
    if (result.state === 'failed') return { tone: 'alert', text: result.results.find(item => item.message)?.message ?? 'The file operation failed.' };
    return { tone: 'status', text: `${result.completedItems} of ${result.totalItems} items completed.` };
  }
  return { tone: 'alert', text: result.message };
}

// one focused modal shell for files actions
function FilesDialog({ title, busy, children, onClose, footer }: { title: string; busy?: boolean; children: ReactNode; onClose: () => void; footer: ReactNode }) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  // place focus inside every dialog on mount
  useEffect(() => {
    (dialog.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    // restore the invoking control after the dialog closes
    return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, []);
  // trap focus and dismiss idle dialogs predictably
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // preserve an in-flight mutation
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); return; }
    // preserve ordinary dialog keys
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href]')).filter(control => control.offsetParent !== null);
    // retain focus when every control is disabled
    if (controls.length === 0) return;
    event.preventDefault();
    const index = document.activeElement instanceof HTMLElement ? controls.indexOf(document.activeElement) : -1;
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    controls[next]?.focus();
  };
  return createPortal(<div ref={dialog} className="dialog files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" onKeyDown={keyDown}><div><header><div><small>FILES</small><h2 id="files-dialog-title">{title}</h2></div><button type="button" aria-label={`Close ${title.toLowerCase()}`} disabled={busy} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>{children}<footer>{footer}</footer></div></div>, document.body);
}

// edit one create or rename leaf before asking the server to prepare it
function FileNameDialog({ dialog, busy, error, onChange, onClose, onSubmit }: { dialog: NameDialog; busy: boolean; error?: string; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  // submit through the shared dialog action
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(); };
  return <FilesDialog title={dialog.title} busy={busy} onClose={onClose} footer={<><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" form="files-name-form" className={busy ? 'progress-border progress-blue' : undefined} aria-busy={busy || undefined} disabled={busy || !validLeaf(dialog.value)}>{busy && <span className="update-progress-ring" aria-hidden="true" />}{busy ? 'Preparing…' : dialog.kind === 'rename' ? 'Rename' : 'Create'}</button></>}><form id="files-name-form" className="files-name-form" onSubmit={submit}><label>Name<input autoFocus value={dialog.value} maxLength={255} disabled={busy} onChange={event => onChange(event.target.value)} /></label>{!validLeaf(dialog.value) && dialog.value.length > 0 && <p className="files-dialog-error" role="alert">Use a single filename without control characters or slashes.</p>}{error && <p className="files-dialog-error" role="alert">{error}</p>}</form></FilesDialog>;
}

// require an explicit decision for every collision before continuing
function ConflictDialog({ pending, decisions, busy, error, onDecision, onClose, onContinue }: { pending: PendingAction; decisions: Record<string, CollisionDecision>; busy: boolean; error?: string; onDecision: (id: string, decision: CollisionDecision) => void; onClose: () => void; onContinue: () => void }) {
  const conflicts: OperationConflict[] = pending.prepared.conflicts;
  const deleting = pending.kind === 'operation' && pending.prepared.kind === 'delete';
  const complete = deleting || conflicts.every(conflict => decisions[conflict.id] !== undefined);
  const names = pending.kind === 'operation' ? pending.entries.map(entry => entry.name) : pending.files.map(file => file.name);
  const title = deleting ? 'Permanently delete' : conflicts.length > 0 ? 'Resolve name conflicts' : pending.kind === 'upload' ? 'Upload files' : 'Confirm file operation';
  return <FilesDialog title={title} busy={busy} onClose={onClose} footer={<><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className={`${deleting ? 'files-danger' : ''}${busy ? ` progress-border progress-${deleting ? 'red' : 'blue'}` : ''}`.trim() || undefined} type="button" aria-busy={busy || undefined} disabled={busy || !complete} onClick={onContinue}>{busy && <span className="update-progress-ring" aria-hidden="true" />}{busy ? 'Working…' : deleting ? `Delete ${names.length}` : 'Continue'}</button></>}>
    {deleting && <><p>This permanently deletes {names.length === 1 ? <strong>{names[0]}</strong> : <strong>{names.length} selected items</strong>} and all contents. This cannot be undone.</p><ul className="files-confirm-list">{names.map(name => <li key={name}>{name}</li>)}</ul></>}
    {!deleting && conflicts.length === 0 && <p>{pending.kind === 'upload' ? `Upload ${names.length} ${names.length === 1 ? 'file' : 'files'}?` : 'Continue this file operation?'}</p>}
    {conflicts.length > 0 && <div className="files-conflicts" role="group" aria-label="Collision decisions">{conflicts.map(conflict => <fieldset key={conflict.id}><legend><strong>{conflict.destinationName}</strong><span>{conflict.sourceName} conflicts with an existing item.</span></legend>{conflict.allowed.map(choice => <label key={choice}><input type="radio" name={`collision-${conflict.id}`} value={choice} checked={decisions[conflict.id] === choice} disabled={busy} onChange={() => onDecision(conflict.id, choice)} /><span>{choice === 'keep-both' ? 'Keep both' : choice[0].toUpperCase() + choice.slice(1)}</span></label>)}</fieldset>)}</div>}
    {error && <p className="files-dialog-error" role="alert">{error}</p>}
  </FilesDialog>;
}

// render one keyboard-operable menu item
function MenuItem({ children, disabled, danger, onSelect }: { children: ReactNode; disabled?: boolean; danger?: boolean; onSelect: () => void }) {
  return <button type="button" role="menuitem" className={danger ? 'files-menu-danger' : undefined} disabled={disabled} onClick={onSelect}>{children}</button>;
}

// render one viewport-clamped menu with roving arrow-key focus
function MenuSurface({ label, flyoutRef, style, onDismiss, children }: { label: string; flyoutRef: RefObject<HTMLDivElement | null>; style: CSSProperties; onDismiss: () => void; children: ReactNode }) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  // focus only after viewport placement makes the portal visible
  useEffect(() => {
    // hidden flyouts cannot receive focus
    if (style.visibility !== 'visible') return;
    flyoutRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [flyoutRef, style.visibility]);
  // retain the invoking control through menu dismissal
  useEffect(() => {
    const menu = flyoutRef.current;
    // restore dismissal focus without stealing it from a newly opened dialog
    return () => {
      const focus = document.activeElement;
      // return only to a connected visible invoking control
      if (returnFocus.current?.isConnected && returnFocus.current.getClientRects().length > 0 && (focus === document.body || focus !== null && menu?.contains(focus))) returnFocus.current.focus();
    };
  }, [flyoutRef]);
  // move through enabled menu actions without leaving the surface
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')).filter(item => item.offsetParent !== null);
    // dismiss from the menu before the panel sees escape
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); return; }
    // preserve text and activation keys
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  return <FlyoutPortal onDismiss={onDismiss}><div ref={flyoutRef} className="more-menu flyout-menu files-menu" role="menu" aria-label={label} style={style} onKeyDown={keyDown}>{children}</div></FlyoutPortal>;
}

// render one sortable desktop column header
function SortHeader({ column, label, activeColumn, direction, onSort }: { column: FileSortColumn; label: string; activeColumn: FileSortColumn; direction: 'ascending' | 'descending'; onSort: (column: FileSortColumn) => void }) {
  const active = column === activeColumn;
  return <span role="columnheader" aria-sort={active ? direction : 'none'}><button type="button" aria-label={`Sort by ${label}`} onClick={() => onSort(column)}><span>{label}</span>{active && <span aria-hidden="true">{direction === 'ascending' ? '↑' : '↓'}</span>}</button></span>;
}

// render the exact favorite state without silently rebinding replaced paths
function FavoriteMenuRow({ favorite, busy, onOpen, onAcknowledge }: { favorite: Favorite; busy: boolean; onOpen: () => void; onAcknowledge: () => void }) {
  const activatable = favorite.entry !== undefined && favorite.state !== 'replaced' && favorite.state !== 'unavailable';
  const label = favorite.path.split('/').filter(Boolean).at(-1) ?? '/';
  return <div className={`files-favorite-menu-row ${favorite.state}`} role="none"><button type="button" role="menuitem" className="files-favorite-open" disabled={!activatable || busy} title={favorite.path} onClick={onOpen}><FileIcon entry={favorite.entry ?? { name: label, kind: 'file' }} decorative /><span>{label}</span><small>{favorite.state === 'available' ? '' : favorite.state.replace('-', ' ')}</small></button>{favorite.state === 'replaced' && favorite.entry !== undefined && <button type="button" role="menuitem" disabled={busy} onClick={onAcknowledge}>Use current object</button>}</div>;
}

// the full host files panel for one place
export function FilesPanel({ controller, onOpenFile, onPreviewFile, onEditFile }: { controller: FilesController; onOpenFile: (entry: FileEntry) => void | Promise<void>; onPreviewFile?: (entry: FileEntry) => void | Promise<void>; onEditFile?: (entry: FileEntry) => void | Promise<void> }) {
  const phone = usePhoneLayout();
  const openFolder = useContext(OpenFolderContext);
  const expanded = usePanelExpand('files')?.expanded === true;
  const [location, setLocation] = useState(controller.listing?.path ?? '');
  const [nameDialog, setNameDialog] = useState<NameDialog>();
  const [pending, setPending] = useState<PendingAction>();
  const [decisions, setDecisions] = useState<Record<string, CollisionDecision>>({});
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string }>();
  const [uploadStates, setUploadStates] = useState<{ name: string; state: string }[]>([]);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<EntryMenu>();
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const uploadDestination = useRef<string | undefined>(undefined);
  const newFlyout = useViewportFlyout<HTMLButtonElement>(newOpen, { contentSized: true, align: 'start' });
  const favoritesFlyout = useViewportFlyout<HTMLButtonElement>(favoritesOpen, { contentSized: true });
  const rowFlyout = useViewportFlyout<HTMLButtonElement>(rowMenu !== undefined, { contentSized: true });
  const contextFlyout = useViewportFlyout<HTMLSpanElement>(contextMenu !== undefined, { contentSized: true, align: 'start' });
  const selected = controller.selectedEntries;
  const currentToken = controller.listing?.destinationDirectoryToken;
  const currentDirectory = controller.listing?.directoryEntry;
  const currentFavorite = currentDirectory?.favorite;
  // retain partial listings while disclosing omitted children
  const inaccessibleEntries = controller.listing === undefined ? 0 : controller.listing.inaccessibleEntries;
  // avoid claiming a permission-limited folder is empty
  const emptyMessage = inaccessibleEntries > 0 ? 'No accessible items to show.' : 'This folder is empty.';

  // close every files-owned flyout without changing selection
  const closeMenus = useCallback(() => {
    setNewOpen(false);
    setFavoritesOpen(false);
    setRowMenu(undefined);
    setContextMenu(undefined);
  }, []);

  // synchronize the editable location after every successful canonical listing
  useEffect(() => { setLocation(controller.listing?.path ?? ''); }, [controller.listing]);
  // dismiss stale menu scopes after refresh, loading or sort changes
  useEffect(() => { closeMenus(); }, [closeMenus, controller.listing, controller.loading, controller.sort.column, controller.sort.direction]);

  // open a directory or regular file from either list or favorites
  const activate = (entry: FileEntry) => {
    closeMenus();
    // navigate current directory targets
    if (isDirectory(entry)) { void controller.navigate(entry.hostPath); return; }
    // let the workspace choose the configured editor or Code fallback
    if (isPreviewable(entry)) void onOpenFile(entry);
  };

  // preview one file through the explicit action or default opener
  const preview = (entry: FileEntry) => {
    closeMenus();
    // reject unsupported objects before dispatch
    if (isPreviewable(entry)) void (onPreviewFile ?? onOpenFile)(entry);
  };

  // edit one file only when the workspace supplies an editor action
  const edit = (entry: FileEntry) => {
    closeMenus();
    // preserve optional editor availability
    if (isPreviewable(entry)) void onEditFile?.(entry);
  };

  // submit the editable absolute host path
  const submitLocation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // require one absolute host path
    if (!location.startsWith('/')) { controller.setError({ code: 'invalid_path', message: 'Enter an absolute path beginning with /.' }); return; }
    void controller.navigate(location);
  };

  // prevent native text ranges before Shift-click reaches row selection
  const preventShiftTextSelection = (event: MouseEvent<HTMLDivElement>) => {
    // preserve normal text selection and nonprimary mouse gestures
    if (event.button === 0 && event.shiftKey) event.preventDefault();
  };

  // apply row selection without activating its name
  const selectRow = (entry: FileEntry, event: MouseEvent<HTMLElement>) => {
    controller.select(entry, { mobile: phone, toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  };

  // modified filename clicks select while plain clicks activate
  const clickName = (entry: FileEntry, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // treat every modified click as selection only
    if (event.ctrlKey || event.metaKey || event.shiftKey) { selectRow(entry, event); return; }
    activate(entry);
  };

  // keyboard rows mirror a plain row-body selection
  const rowKey = (entry: FileEntry, event: KeyboardEvent<HTMLDivElement>) => {
    // handle space on the row itself only
    if (event.key !== ' ' || event.target !== event.currentTarget) return;
    event.preventDefault();
    controller.select(entry, { mobile: phone, toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  };

  // execute one operation or upload after explicit decisions
  const continuePending = async (action = pending, choices = decisions) => {
    // ignore a closed dialog
    if (action === undefined) return;
    setBusy(true);
    setDialogError(undefined);
    // execute server-owned file manifests
    if (action.kind === 'operation') {
      const result = await controller.execute(action.prepared, choices, action.prepared.kind === 'delete');
      setBusy(false);
      // retain collision modal after start failure
      if (!('state' in result)) { setDialogError(result.message); return; }
      setPending(undefined);
      setNotice(resultMessage(result));
      // clear a successful cut clipboard
      if (action.prepared.kind === 'move' && result.state === 'completed') controller.clearClipboard();
      return;
    }
    setUploadStates(action.files.map(file => ({ name: file.name, state: 'queued' })));
    const outcome = await controller.upload(action.prepared, action.files, choices, (index, state) => setUploadStates(current => { const next = [...current]; next[index] = { name: action.files[index].name, state }; return next; }));
    setBusy(false);
    setPending(undefined);
    // retain completed and skipped state without retrying successful files
    if (outcome.failure !== undefined) {
      const failed = action.files.length - outcome.uploaded - outcome.skipped;
      setNotice({ tone: 'alert', text: `${outcome.uploaded} uploaded, ${outcome.skipped} skipped, ${failed} failed. ${outcome.failure.message}` });
      return;
    }
    // distinguish authorized skips from completed uploads
    if (outcome.skipped > 0) { setNotice({ tone: 'status', text: `${outcome.uploaded} uploaded. ${outcome.skipped} skipped.` }); return; }
    setNotice({ tone: 'status', text: `Uploaded ${outcome.uploaded} ${outcome.uploaded === 1 ? 'file' : 'files'}.` });
  };

  // prepare create or rename after local leaf validation
  const submitName = async () => {
    const dialog = nameDialog;
    // require one valid dialog draft
    if (dialog === undefined || !validLeaf(dialog.value)) return;
    setBusy(true);
    setDialogError(undefined);
    const body = dialog.kind === 'rename'
      ? { kind: 'rename' as const, sourceToken: dialog.entry!.objectToken, newName: dialog.value, destinationDirectoryToken: dialog.destinationDirectoryToken }
      : { kind: dialog.kind, name: dialog.value, destinationDirectoryToken: dialog.destinationDirectoryToken };
    const prepared = await controller.prepare(body);
    setBusy(false);
    // retain the draft after prepare failure
    if (!('operationId' in prepared)) { setDialogError(prepared.message); return; }
    setNameDialog(undefined);
    const action: PendingAction = { kind: 'operation', prepared, entries: dialog.entry === undefined ? [] : [dialog.entry] };
    // ask only when a collision needs intent
    if (prepared.conflicts.length > 0) { setPending(action); setDecisions({}); return; }
    void continuePending(action, {});
  };

  // resolve one folder capability without changing visible navigation
  const resolveDirectoryToken = async (entry?: FileEntry): Promise<string | undefined> => {
    // use the visible current directory directly
    if (entry === undefined) return currentToken;
    setBusy(true);
    const directory = await controller.directoryAt(entry.hostPath, entry.objectToken);
    setBusy(false);
    // expose stale or inaccessible folder targets
    if (!('destinationDirectoryToken' in directory)) { setNotice(resultMessage(directory)); return undefined; }
    return directory.destinationDirectoryToken;
  };

  // open one scoped create dialog
  const openCreate = async (kind: 'create-file' | 'create-folder', directory?: FileEntry) => {
    closeMenus();
    const destinationDirectoryToken = await resolveDirectoryToken(directory);
    // require an available destination capability
    if (destinationDirectoryToken === undefined) return;
    setNameDialog({ kind, title: kind === 'create-file' ? 'Create file' : 'Create folder', value: '', destinationDirectoryToken });
  };

  // open one row rename dialog in the visible parent directory
  const openRename = (entry: FileEntry) => {
    closeMenus();
    // require the visible parent capability
    if (currentToken === undefined) return;
    setNameDialog({ kind: 'rename', title: `Rename ${entry.name}`, value: entry.name, entry, destinationDirectoryToken: currentToken });
  };

  // prepare copy or move from the process-local clipboard
  const paste = async (directory?: FileEntry) => {
    closeMenus();
    const board = controller.clipboard;
    // require a same-server clipboard
    if (board === undefined) return;
    // reject cross-origin capabilities before resolving a destination
    if (board.origin !== window.location.origin) { setNotice({ tone: 'alert', text: 'Pasting files between RAC hosts is not supported.' }); return; }
    const destinationDirectoryToken = await resolveDirectoryToken(directory);
    // require an available destination capability
    if (destinationDirectoryToken === undefined) return;
    setBusy(true);
    const prepared = await controller.prepare({ kind: board.mode, sourceTokens: board.entries.map(entry => entry.objectToken), destinationDirectoryToken });
    setBusy(false);
    // expose stale or unsupported clipboard failures
    if (!('operationId' in prepared)) { setNotice(resultMessage(prepared)); return; }
    const action: PendingAction = { kind: 'operation', prepared, entries: board.entries };
    setDecisions({});
    // execute immediately when no decisions are required
    if (prepared.conflicts.length === 0) { void continuePending(action, {}); return; }
    setPending(action);
  };

  // prepare explicit permanent deletion for one menu scope
  const prepareDelete = async (entries: FileEntry[]) => {
    closeMenus();
    // require at least one explicit object
    if (entries.length === 0) return;
    setBusy(true);
    const prepared = await controller.prepare({ kind: 'delete', sourceTokens: entries.map(entry => entry.objectToken) });
    setBusy(false);
    // expose stale objects without opening confirmation
    if (!('operationId' in prepared)) { setNotice(resultMessage(prepared)); return; }
    setPending({ kind: 'operation', prepared, entries });
    setDecisions({});
  };

  // choose a destination before opening the native file picker
  const openUpload = async (directory?: FileEntry) => {
    closeMenus();
    const destinationDirectoryToken = await resolveDirectoryToken(directory);
    // require an available destination capability
    if (destinationDirectoryToken === undefined) return;
    uploadDestination.current = destinationDirectoryToken;
    uploadInput.current?.click();
  };

  // prepare raw browser files without base64 conversion
  const chooseUploads = async (files: FileList | null) => {
    const destinationDirectoryToken = uploadDestination.current;
    uploadDestination.current = undefined;
    // ignore a canceled chooser or missing destination
    if (files === null || files.length === 0 || destinationDirectoryToken === undefined) return;
    const selectedFiles = Array.from(files);
    setBusy(true);
    const prepared = await controller.prepareUpload(selectedFiles, destinationDirectoryToken);
    setBusy(false);
    // expose validation and limit failures
    if (!('uploadId' in prepared)) { setNotice(resultMessage(prepared)); return; }
    const action: PendingAction = { kind: 'upload', prepared, files: selectedFiles };
    setDecisions({});
    // stream immediately only when no collision needs intent
    if (prepared.conflicts.length === 0) { void continuePending(action, {}); return; }
    setPending(action);
  };

  // prepare and start a browser download for one explicit menu scope
  const download = async (entries: FileEntry[]) => {
    closeMenus();
    const prepared = await controller.prepareDownload(entries);
    // expose a prepare failure
    if (!('downloadId' in prepared)) { setNotice(resultMessage(prepared)); return; }
    const anchor = document.createElement('a');
    anchor.href = prepared.url;
    anchor.download = prepared.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setNotice({ tone: 'status', text: `Downloading ${prepared.filename}…` });
    const failure = await controller.waitForDownload(prepared.downloadId);
    // replace optimistic copy with terminal status
    setNotice(failure === undefined ? { tone: 'status', text: `Downloaded ${prepared.filename}.` } : resultMessage(failure));
  };

  // add or remove one explicit favorite object
  const toggleFavorite = async (entry: FileEntry) => {
    closeMenus();
    setFavoriteBusy(true);
    const failure = entry.favorite === undefined ? await controller.addFavorite(entry) : await controller.removeFavorite(entry.favorite.id);
    setFavoriteBusy(false);
    // expose a favorite failure
    if (failure !== undefined) setNotice(resultMessage(failure));
  };

  // activate a favorite and explicitly refresh modified identity
  const openFavorite = async (favorite: Favorite) => {
    // require one fresh entry from the server
    if (favorite.entry === undefined) return;
    // acknowledge same-object metadata drift before activation
    if (favorite.state === 'modified') {
      setFavoriteBusy(true);
      const failure = await controller.acknowledgeFavorite(favorite.id, favorite.entry.objectToken);
      setFavoriteBusy(false);
      // preserve the warning without opening a stale object
      if (failure !== undefined) { setNotice(resultMessage(failure)); return; }
    }
    activate(favorite.entry);
  };

  // explicitly accept the replacement at one favorite path
  const acknowledgeFavorite = async (favorite: Favorite) => {
    // require a current replacement token
    if (favorite.entry === undefined) return;
    setFavoriteBusy(true);
    const failure = await controller.acknowledgeFavorite(favorite.id, favorite.entry.objectToken);
    setFavoriteBusy(false);
    // expose an acknowledgement failure
    if (failure !== undefined) setNotice(resultMessage(failure));
  };

  // show a row-end menu for exactly its own entry
  const openRowMenu = (entry: FileEntry, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setContextMenu(undefined);
    setNewOpen(false);
    setFavoritesOpen(false);
    setRowMenu(current => current?.entry.objectToken === entry.objectToken ? undefined : { entry });
  };

  // show a right-click menu for the clicked selection scope
  const openEntryContext = (entry: FileEntry, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const entries = controller.selection.tokens.has(entry.objectToken) ? selected : [entry];
    setNewOpen(false);
    setFavoritesOpen(false);
    setRowMenu(undefined);
    setContextMenu({ x: event.clientX, y: event.clientY, scope: { kind: 'entries', entries } });
  };

  // show current-directory actions from unused list space
  const openDirectoryContext = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    // preserve native menus on interactive content
    if (target.closest('button, input, a, [role="menu"]') !== null) return;
    event.preventDefault();
    setNewOpen(false);
    setFavoritesOpen(false);
    setRowMenu(undefined);
    setContextMenu({ x: event.clientX, y: event.clientY, scope: { kind: 'directory' } });
  };

  // render actions for an explicit row or right-click object scope
  const entryMenuItems = (entries: FileEntry[]) => {
    const one = entries.length === 1 ? entries[0] : undefined;
    const folder = one !== undefined && isDirectory(one) ? one : undefined;
    const file = one !== undefined && isPreviewable(one) ? one : undefined;
    return <>
      {folder !== undefined && <MenuItem onSelect={() => activate(folder)}>Open</MenuItem>}
      {file !== undefined && <MenuItem onSelect={() => preview(file)}>Preview</MenuItem>}
      {file !== undefined && onEditFile !== undefined && <MenuItem onSelect={() => edit(file)}>Edit</MenuItem>}
      {folder !== undefined && openFolder !== undefined && <MenuItem onSelect={() => { closeMenus(); openFolder(folder.hostPath); }}>Open as Workspace</MenuItem>}
      {folder !== undefined && <><MenuItem disabled={busy} onSelect={() => void openCreate('create-file', folder)}>New file here</MenuItem><MenuItem disabled={busy} onSelect={() => void openCreate('create-folder', folder)}>New folder here</MenuItem><MenuItem disabled={busy} onSelect={() => void openUpload(folder)}>Upload files here</MenuItem><MenuItem disabled={busy || controller.clipboard === undefined} onSelect={() => void paste(folder)}>Paste here</MenuItem><hr className="more-menu-divider" role="separator" /></>}
      {one !== undefined && <MenuItem disabled={busy} onSelect={() => openRename(one)}>Rename</MenuItem>}
      <MenuItem disabled={entries.length === 0 || busy} onSelect={() => { closeMenus(); controller.copyEntries(entries, 'copy'); }}>Copy</MenuItem>
      <MenuItem disabled={entries.length === 0 || busy} onSelect={() => { closeMenus(); controller.copyEntries(entries, 'move'); }}>Cut</MenuItem>
      <MenuItem disabled={entries.length === 0 || busy} onSelect={() => void download(entries)}>Download</MenuItem>
      {one !== undefined && <MenuItem disabled={favoriteBusy || busy} onSelect={() => void toggleFavorite(one)}>{one.favorite === undefined ? 'Add to favorites' : 'Remove from favorites'}</MenuItem>}
      <hr className="more-menu-divider" role="separator" />
      <MenuItem danger disabled={entries.length === 0 || busy} onSelect={() => void prepareDelete(entries)}>Delete</MenuItem>
    </>;
  };

  // render current-directory actions without borrowing row selection
  const directoryMenuItems = () => <>
    <MenuItem disabled={currentToken === undefined || busy} onSelect={() => void openCreate('create-file')}>New file</MenuItem>
    <MenuItem disabled={currentToken === undefined || busy} onSelect={() => void openCreate('create-folder')}>New folder</MenuItem>
    <MenuItem disabled={currentToken === undefined || busy} onSelect={() => void openUpload()}>Upload files</MenuItem>
    <MenuItem disabled={controller.clipboard === undefined || currentToken === undefined || busy} onSelect={() => void paste()}>Paste</MenuItem>
    <hr className="more-menu-divider" role="separator" />
    <MenuItem disabled={currentDirectory === undefined || busy} onSelect={() => { if (currentDirectory !== undefined) void download([currentDirectory]); }}>Download current folder</MenuItem>
    <MenuItem disabled={currentDirectory === undefined || favoriteBusy || busy} onSelect={() => { if (currentDirectory !== undefined) void toggleFavorite(currentDirectory); }}>{currentFavorite === undefined ? 'Add current to favorites' : 'Remove current from favorites'}</MenuItem>
    <hr className="more-menu-divider" role="separator" />
    <MenuItem disabled={controller.loading || busy} onSelect={() => { closeMenus(); void controller.refresh(); }}>Refresh</MenuItem>
    <MenuItem disabled={controller.loading || busy} onSelect={() => { closeMenus(); void controller.navigate(); }}>Go to Place home</MenuItem>
    <MenuItem disabled={controller.listing?.parent === undefined || controller.loading || busy} onSelect={() => { const parent = controller.listing?.parent; closeMenus(); if (parent !== undefined) void controller.navigate(parent); }}>Go to parent folder</MenuItem>
  </>;

  const headerActions = <>
    <button className="panel-header-action files-parent-action" type="button" aria-label="Go to parent folder" title="Parent" disabled={controller.listing?.parent === undefined || controller.loading || busy} onClick={() => { const parent = controller.listing?.parent; if (parent !== undefined) void controller.navigate(parent); }}><PanelIcon path="m6 10 6-6 6 6M12 4v16" /></button>
    <button ref={newFlyout.anchorRef} className={`panel-header-action${newOpen ? ' active' : ''}`} type="button" aria-label="New" title="New" aria-haspopup="menu" aria-expanded={newOpen} data-context-flyout onClick={() => { setFavoritesOpen(false); setRowMenu(undefined); setContextMenu(undefined); setNewOpen(value => !value); }}><PanelIcon path="M12 5v14M5 12h14" /><span className="flyout-caret" aria-hidden="true" /></button>
    <button className="panel-header-action" type="button" aria-label="Upload files" title="Upload" disabled={currentToken === undefined || busy} onClick={() => void openUpload()}><PanelIcon path="M12 16V4m0 0L7 9m5-5 5 5M5 20h14" /></button>
    <button ref={favoritesFlyout.anchorRef} className={`panel-header-action files-favorites-action${favoritesOpen ? ' active' : ''}`} type="button" aria-label="Favorites" aria-description={currentFavorite === undefined ? 'Current folder is not favorited.' : 'Current folder is favorited.'} title="Favorites" aria-haspopup="menu" aria-expanded={favoritesOpen} data-current-favorite={currentFavorite !== undefined} data-context-flyout onClick={() => { setNewOpen(false); setRowMenu(undefined); setContextMenu(undefined); setFavoritesOpen(value => !value); }}><PanelIcon path="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" /><span className="flyout-caret" aria-hidden="true" /></button>
  </>;
  const secondary = [
    { key: 'refresh', label: 'Refresh files', title: 'Refresh', disabled: controller.loading || busy, icon: <PanelIcon path="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />, onSelect: () => { void controller.refresh(); } },
    { key: 'home', label: 'Go to Place home', title: 'Home', disabled: controller.loading || busy, icon: <PanelIcon path="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7" />, onSelect: () => { void controller.navigate(); } }
  ];

  return <section className={`files-pane${expanded ? ' expanded' : ''}`} role="region" aria-label="Files" onAuxClickCapture={event => { /* close on unmodified middle click */ if (event.button === 1) controller.close(); }}>
    <PanelHeader panelKey="files" label="files" configuredFilesDirectoryToken={currentToken} titleControl={<form className="panel-header-pill files-address-form" onSubmit={submitLocation}><label className="sr-only" htmlFor="files-address">Absolute path</label><input id="files-address" className="files-address" value={location} spellCheck={false} aria-label="Absolute path" disabled={controller.loading} onChange={event => setLocation(event.target.value)} /></form>} actions={headerActions} secondary={secondary} close={{ key: 'close', label: 'Close files', title: 'Close', className: 'files-close', icon: <PanelIcon path={panelIcons.close} />, onSelect: controller.close }} />
    <input ref={uploadInput} className="attachment-input" aria-label="Upload files" type="file" multiple onChange={event => { /* permit choosing the same files again */ void chooseUploads(event.target.files); event.target.value = ''; }} />
    <div className="files-content" onContextMenu={openDirectoryContext}>
      {/* announce loading without violating the grid row structure */}
      {controller.loading && <span className="sr-only" role="status">Loading files…</span>}
      {controller.error && <p className="files-alert" role="alert">{controller.error.message}</p>}
      {notice && <p className={`files-notice ${notice.tone}`} role={notice.tone}>{notice.text}</p>}
      {controller.progress && ['queued', 'running'].includes(controller.progress.state) && <div className="files-progress progress-border progress-peach" role="status" aria-busy="true" aria-live="polite"><span className="update-progress-ring" aria-hidden="true" /><span>{controller.progress.phase || 'Working'}</span><progress value={controller.progress.completedItems} max={Math.max(1, controller.progress.totalItems)} /></div>}
      {uploadStates.length > 0 && <p className="files-upload-status" role="status">{uploadStates.map(item => `${item.name}: ${item.state}`).join(' · ')}</p>}
      <div className="files-mobile-sort" role="toolbar" aria-label="Sort files">{sortColumns.map(item => <button key={item.column} type="button" aria-label={`Sort by ${item.label}`} aria-pressed={controller.sort.column === item.column} onClick={() => controller.setSort(item.column)}>{item.label}{controller.sort.column === item.column && <span aria-hidden="true">{controller.sort.direction === 'ascending' ? ' ↑' : ' ↓'}</span>}</button>)}</div>
      <div className="files-grid" role="grid" aria-label={`Files in ${controller.listing?.path ?? 'Place home'}`} aria-busy={controller.loading} aria-multiselectable="true">
        <div className="files-grid-head" role="row">{sortColumns.map(item => <SortHeader key={item.column} column={item.column} label={item.label} activeColumn={controller.sort.column} direction={controller.sort.direction} onSort={controller.setSort} />)}<span role="columnheader"><span className="sr-only">Actions</span></span></div>
        {/* hide stale values behind the same table geometry during every read */}
        {controller.loading ? <FilesLoadingRows /> : controller.entries.length === 0 ? <p className="files-empty">{emptyMessage}</p> : controller.entries.map(entry => {
          const selectedRow = controller.selection.tokens.has(entry.objectToken);
          return <div key={entry.objectToken} className={`files-row ${entry.kind}${selectedRow ? ' selected' : ''}`} role="row" aria-selected={selectedRow} tabIndex={0} title={entry.hostPath} onMouseDownCapture={preventShiftTextSelection} onClick={event => selectRow(entry, event)} onKeyDown={event => rowKey(entry, event)} onContextMenu={event => openEntryContext(entry, event)}>
            <span className="files-name-cell" role="gridcell"><FileIcon entry={entry} /><button className="files-name" type="button" title={entry.hostPath} disabled={!isDirectory(entry) && !isPreviewable(entry)} onClick={event => clickName(entry, event)}>{entry.name}</button>{entry.favorite !== undefined && <span className={`files-favorite-mark ${entry.favorite.state}`} aria-label={`Favorite: ${entry.favorite.state}`}>★</span>}</span>
            <span role="gridcell" data-label="Owner">{entry.owner.label}</span><span role="gridcell" data-label="Permissions"><code>{entry.permissions}</code></span><span role="gridcell" data-label="Modified" title={entry.modifiedAt}>{formatModifiedAt(entry.modifiedAt)}</span><span role="gridcell" data-label="Size" title={`${entry.size} bytes`}>{formatFileSize(entry.size)}</span>
            <span className="files-row-actions" role="gridcell"><button ref={rowMenu?.entry.objectToken === entry.objectToken ? rowFlyout.anchorRef : undefined} type="button" aria-label={`Actions for ${entry.name}`} aria-haspopup="menu" aria-expanded={rowMenu?.entry.objectToken === entry.objectToken} data-context-flyout onClick={event => openRowMenu(entry, event)}><span aria-hidden="true">⋮</span></button></span>
          </div>;
        })}
      </div>
      {/* disclose partial directory metadata without hiding readable entries */}
      {inaccessibleEntries > 0 && <p className="files-limit" role="status">{inaccessibleEntries} {inaccessibleEntries === 1 ? 'item' : 'items'} hidden because permission was denied.</p>}
      {controller.listing?.truncated && <p className="files-limit" role="status">This folder has more entries than can be shown.</p>}
    </div>
    {newOpen && <MenuSurface label="New file or folder" flyoutRef={newFlyout.flyoutRef} style={newFlyout.style} onDismiss={() => setNewOpen(false)}><MenuItem disabled={currentToken === undefined || busy} onSelect={() => void openCreate('create-file')}>New file</MenuItem><MenuItem disabled={currentToken === undefined || busy} onSelect={() => void openCreate('create-folder')}>New folder</MenuItem></MenuSurface>}
    {favoritesOpen && <MenuSurface label="Favorites" flyoutRef={favoritesFlyout.flyoutRef} style={favoritesFlyout.style} onDismiss={() => setFavoritesOpen(false)}><MenuItem disabled={currentDirectory === undefined || favoriteBusy || busy} onSelect={() => { if (currentDirectory !== undefined) void toggleFavorite(currentDirectory); }}>{currentFavorite === undefined ? 'Add current' : 'Remove current'}</MenuItem>{controller.favorites.length > 0 && <hr className="more-menu-divider" role="separator" />}{controller.favorites.map(favorite => <FavoriteMenuRow key={favorite.id} favorite={favorite} busy={favoriteBusy} onOpen={() => void openFavorite(favorite)} onAcknowledge={() => void acknowledgeFavorite(favorite)} />)}</MenuSurface>}
    {rowMenu !== undefined && <MenuSurface label={`Actions for ${rowMenu.entry.name}`} flyoutRef={rowFlyout.flyoutRef} style={rowFlyout.style} onDismiss={() => setRowMenu(undefined)}>{entryMenuItems([rowMenu.entry])}</MenuSurface>}
    {contextMenu !== undefined && <><span ref={contextFlyout.anchorRef} className="files-context-anchor" style={{ left: contextMenu.x, top: contextMenu.y }} /><MenuSurface label={contextMenu.scope.kind === 'directory' ? 'Current folder actions' : contextMenu.scope.entries.length === 1 ? `Actions for ${contextMenu.scope.entries[0].name}` : `Actions for ${contextMenu.scope.entries.length} selected items`} flyoutRef={contextFlyout.flyoutRef} style={contextFlyout.style} onDismiss={() => setContextMenu(undefined)}>{contextMenu.scope.kind === 'directory' ? directoryMenuItems() : entryMenuItems(contextMenu.scope.entries)}</MenuSurface></>}
    {nameDialog !== undefined && <FileNameDialog dialog={nameDialog} busy={busy} error={dialogError} onChange={value => setNameDialog(current => current === undefined ? current : { ...current, value })} onClose={() => { setNameDialog(undefined); setDialogError(undefined); }} onSubmit={() => void submitName()} />}
    {pending !== undefined && <ConflictDialog pending={pending} decisions={decisions} busy={busy} error={dialogError} onDecision={(id, choice) => setDecisions(current => ({ ...current, [id]: choice }))} onClose={() => { setPending(undefined); setDialogError(undefined); }} onContinue={() => void continuePending()} />}
  </section>;
}
