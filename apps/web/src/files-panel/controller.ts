import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Requester } from '../code-panel/comparison.js';
import { filesError, isDownloadPreparation, isFavorite, isFilesList, isOperationResult, isPreparedOperation, isUploadAuthorization, isUploadPreparation, type CollisionDecision, type DownloadPreparation, type Favorite, type FileEntry, type FilesError, type FilesList, type OperationKind, type OperationResult, type PreparedOperation, type UploadPreparation } from './contracts.js';
import { retainCurrentSelection, selectFileEntry, type FileSelection, type SelectionGesture } from './selection.js';

export type FilesClipboard = { origin: string; mode: 'copy' | 'move'; entries: { name: string; objectToken: string }[] };
type ClipboardListener = () => void;
let clipboard: FilesClipboard | undefined;
const clipboardListeners = new Set<ClipboardListener>();

// publish one clipboard snapshot to every workspace
function writeClipboard(next: FilesClipboard | undefined): void {
  clipboard = next;
  // notify every files controller
  for (const listener of clipboardListeners) listener();
}

// subscribe a controller to the process-local clipboard
function subscribeClipboard(listener: ClipboardListener): () => void {
  clipboardListeners.add(listener);
  return () => { clipboardListeners.delete(listener); };
}

// return the current immutable clipboard reference
const readClipboard = (): FilesClipboard | undefined => clipboard;

const filesOpenKey = (placeId: string): string => `rac.files-open:${placeId}`;
// read retained panel visibility
export function savedFilesOpen(placeId: string | undefined): boolean {
  // leave unscoped agents without files
  if (placeId === undefined) return false;
  try { return localStorage.getItem(filesOpenKey(placeId)) === '1'; } catch { return false; }
}

// persist retained panel visibility per place
export function saveFilesOpen(placeId: string | undefined, open: boolean): void {
  // leave unscoped agents without persistent state
  if (placeId === undefined) return;
  try {
    // store only the open state
    if (open) localStorage.setItem(filesOpenKey(placeId), '1'); else localStorage.removeItem(filesOpenKey(placeId));
  } catch { /* browser storage is optional */ }
}

// parse a sanitized server error without leaking response internals
async function responseError(response: Response, fallback: string): Promise<FilesError> {
  const payload: unknown = await response.json().catch(() => undefined);
  return filesError(payload, fallback);
}

export type FileSortColumn = 'name' | 'owner' | 'permissions' | 'modified' | 'size';
export type FileSort = { column: FileSortColumn; direction: 'ascending' | 'descending' };
const defaultSort: FileSort = { column: 'name', direction: 'ascending' };

// keep directories above files while sorting metadata with deterministic name ties
export function sortFileEntries(entries: readonly FileEntry[], sort: FileSort = defaultSort): FileEntry[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === 'directory' || left.kind === 'symlink' && left.symlinkTargetKind === 'directory';
    const rightDirectory = right.kind === 'directory' || right.kind === 'symlink' && right.symlinkTargetKind === 'directory';
    // keep navigable directories above other entries
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    const nameOrder = collator.compare(left.name, right.name) || left.name.localeCompare(right.name) || left.hostPath.localeCompare(right.hostPath);
    const comparison = sort.column === 'size' ? left.size - right.size
      : sort.column === 'modified' ? Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt)
      : sort.column === 'owner' ? collator.compare(left.owner.label, right.owner.label)
      : sort.column === 'permissions' ? left.permissions.localeCompare(right.permissions)
      : nameOrder;
    return comparison * (sort.direction === 'ascending' ? 1 : -1) || nameOrder;
  });
}

export type PrepareBody =
  | { kind: 'create-file' | 'create-folder'; name: string; destinationDirectoryToken: string }
  | { kind: 'rename'; sourceToken: string; newName: string; destinationDirectoryToken: string }
  | { kind: 'copy' | 'move'; sourceTokens: string[]; destinationDirectoryToken: string }
  | { kind: 'delete'; sourceTokens: string[] };

export type FilesController = ReturnType<typeof useFilesController>;

// own one place's files state and requests
export function useFilesController(placeId: string | undefined, request: Requester, onOpen?: () => void) {
  const [open, setOpen] = useState(() => savedFilesOpen(placeId));
  const [listing, setListing] = useState<FilesList>();
  const [loading, setLoading] = useState(false);
  const [navigationError, setNavigationError] = useState<FilesError>();
  const [favoriteError, setFavoriteError] = useState<FilesError>();
  const [selection, setSelection] = useState<FileSelection>({ tokens: new Set() });
  const [sort, setSortState] = useState<FileSort>(defaultSort);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [progress, setProgress] = useState<OperationResult>();
  const listRequest = useRef(0);
  const favoriteRequest = useRef(0);
  // reject callbacks captured by another place
  const activePlace = useRef(placeId);
  activePlace.current = placeId;
  const sharedClipboard = useSyncExternalStore(subscribeClipboard, readClipboard, readClipboard);
  const error = navigationError ?? favoriteError;

  // reset panel state when its place changes
  useEffect(() => {
    setOpen(savedFilesOpen(placeId));
    setListing(undefined);
    setLoading(false);
    setSelection({ tokens: new Set() });
    setSortState(defaultSort);
    setFavorites([]);
    setNavigationError(undefined);
    setFavoriteError(undefined);
    listRequest.current += 1;
    favoriteRequest.current += 1;
  }, [placeId]);

  // load server-saved favorites for the exact place
  const refreshFavorites = useCallback(async (): Promise<FilesError | undefined> => {
    // skip missing or superseded place callbacks
    if (placeId === undefined || activePlace.current !== placeId) return;
    const id = ++favoriteRequest.current;
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/file-favorites`);
    const payload: unknown = await response.json().catch(() => undefined);
    const candidate = payload !== null && typeof payload === 'object' ? (payload as { favorites?: unknown }).favorites : undefined;
    const nextFavorites = Array.isArray(candidate) && candidate.every(isFavorite) ? candidate : undefined;
    const failure = !response.ok
      ? filesError(payload, 'Unable to refresh favorites.')
      : nextFavorites === undefined
        ? { code: 'invalid_response', message: 'The favorites response was invalid.' }
        : undefined;
    // ignore a superseded response from this place
    if (activePlace.current !== placeId || favoriteRequest.current !== id) return undefined;
    // retain the last valid menu while exposing refresh failure
    if (failure !== undefined) { setFavoriteError(failure); return failure; }
    // valid success responses always carry the narrowed array
    if (nextFavorites === undefined) return undefined;
    setFavoriteError(undefined);
    setFavorites(nextFavorites);
    return undefined;
  }, [placeId, request]);

  // navigate only after receiving one valid canonical path-token pair
  const navigate = useCallback(async (path?: string): Promise<boolean> => {
    // fail closed without the current place scope
    if (placeId === undefined || activePlace.current !== placeId) return false;
    const id = ++listRequest.current;
    setLoading(true);
    setNavigationError(undefined);
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(path === undefined ? {} : { path }) });
    const payload: unknown = await response.json().catch(() => undefined);
    // keep the last good directory after a failed navigation
    if (!response.ok || !isFilesList(payload)) {
      // ignore a replaced request
      if (activePlace.current === placeId && listRequest.current === id) { setLoading(false); setNavigationError(response.ok ? { code: 'invalid_response', message: 'The folder response was invalid.' } : filesError(payload, 'Unable to open this folder.')); }
      return false;
    }
    // ignore a stale navigation response
    if (activePlace.current !== placeId || listRequest.current !== id) return false;
    const next = payload;
    setListing(next);
    setSelection(current => retainCurrentSelection(current, next.entries));
    setLoading(false);
    // accept favorites embedded with a list response
    if (next.favorites !== undefined) setFavorites(next.favorites);
    return true;
  }, [placeId, request]);

  // restore visibility at the Place home without persisting navigation outside it
  useEffect(() => {
    // attempt once and retain failures until an explicit retry
    if (!open || placeId === undefined || listing !== undefined || loading || navigationError !== undefined) return;
    void navigate();
    void refreshFavorites();
  }, [open, placeId, listing, loading, navigationError, navigate, refreshFavorites]);

  // use one rendered order for rows, range selection and scoped actions
  const entries = useMemo(() => sortFileEntries(listing?.entries ?? [], sort), [listing?.entries, sort]);
  const selectedEntries = useMemo(() => entries.filter(entry => selection.tokens.has(entry.objectToken)), [entries, selection]);

  // reverse the active column or start another column ascending
  const setSort = useCallback((column: FileSortColumn) => {
    setSortState(current => ({ column, direction: current.column === column && current.direction === 'ascending' ? 'descending' : 'ascending' }));
  }, []);

  // open and retain this place's files panel
  const show = useCallback(() => { setNavigationError(undefined); setOpen(true); saveFilesOpen(placeId, true); onOpen?.(); }, [placeId, onOpen]);
  // close and retain this place's files panel
  const close = useCallback(() => { setOpen(false); setNavigationError(undefined); saveFilesOpen(placeId, false); }, [placeId]);
  // toggle retained visibility
  const toggle = useCallback(() => {
    // choose the matching persisted action
    if (open) close(); else show();
  }, [open, close, show]);
  // refresh the current listing and favorite menu together
  const refresh = useCallback(async (): Promise<boolean> => {
    const [listed] = await Promise.all([navigate(listing?.path), refreshFavorites()]);
    return listed;
  }, [listing?.path, navigate, refreshFavorites]);

  // apply one rendered row selection gesture
  const select = useCallback((entry: FileEntry, gesture: SelectionGesture) => {
    setSelection(current => selectFileEntry(current, entry, entries, gesture));
  }, [entries]);
  // prepare a server-owned mutation manifest
  const prepare = useCallback(async (body: PrepareBody): Promise<PreparedOperation | FilesError> => {
    // reject operations without a place
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/operations/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => undefined);
    return response.ok && isPreparedOperation(payload) ? payload : filesError(payload, 'Unable to prepare this file operation.');
  }, [placeId, request]);

  // poll one operation to a terminal state with a bounded client wait
  const waitForOperation = useCallback(async (operationId: string, initial?: OperationResult): Promise<OperationResult | FilesError> => {
    // publish an immediate execution response
    if (initial !== undefined) {
      setProgress(initial);
      // use an already terminal execution response
      if (!['queued', 'running'].includes(initial.state)) return initial;
    }
    // poll within the active operation window
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, attempt === 0 ? 100 : 250));
      const response = await request(`/api/worktrees/${encodeURIComponent(placeId!)}/files/operations/${encodeURIComponent(operationId)}`);
      const payload: unknown = await response.json().catch(() => undefined);
      const nested = payload !== null && typeof payload === 'object' ? (payload as { operation?: unknown }).operation : undefined;
      const operation = isOperationResult(nested) ? nested : isOperationResult(payload) ? payload : undefined;
      // stop on an invalid or failed status request
      if (!response.ok || operation === undefined) return response.ok ? { code: 'invalid_response', message: 'Operation progress was invalid.' } : filesError(payload, 'Unable to read operation progress.');
      setProgress(operation);
      // return one terminal state
      if (!['queued', 'running'].includes(operation.state)) return operation;
    }
    return { code: 'operation_timeout', message: 'The operation is still running. Refresh Files to check the result.' };
  }, [placeId, request]);

  // execute one prepared manifest with explicit collision and delete intent
  const execute = useCallback(async (prepared: PreparedOperation, decisions: Record<string, CollisionDecision>, confirmed = false): Promise<OperationResult | FilesError> => {
    // reject execution without a place
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/operations/${encodeURIComponent(prepared.operationId)}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisions, ...(prepared.kind === 'delete' ? { confirmed } : {}) }) });
    const payload: unknown = await response.json().catch(() => undefined);
    // never retry a possibly mutating execute automatically
    if (!response.ok) return filesError(payload, 'Unable to start this file operation.');
    const initial = isOperationResult(payload) ? payload : undefined;
    const result = await waitForOperation(prepared.operationId, initial);
    // refresh both views after the server reaches any terminal state
    if ('state' in result) await refresh();
    return result;
  }, [placeId, refresh, request, waitForOperation]);

  // copy an explicit menu scope without changing the current selection
  const copyEntries = useCallback((entries: readonly FileEntry[], mode: 'copy' | 'move') => {
    // ignore empty or unscoped selections
    if (placeId === undefined || entries.length === 0) return;
    writeClipboard({ origin: window.location.origin, mode, entries: entries.map(entry => ({ name: entry.name, objectToken: entry.objectToken })) });
  }, [placeId]);
  // clear a completed cut without changing current selection
  const clearClipboard = useCallback(() => writeClipboard(undefined), []);

  // add one current object to place favorites
  const addFavorite = useCallback(async (entry: FileEntry): Promise<FilesError | undefined> => {
    // reject missing place scope
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/file-favorites`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectToken: entry.objectToken }) });
    const payload: unknown = await response.json().catch(() => undefined);
    // retain the current list after failure
    if (!response.ok) return filesError(payload, 'Unable to add this favorite.');
    await refresh();
    return undefined;
  }, [placeId, refresh, request]);

  // remove one exact favorite record
  const removeFavorite = useCallback(async (favoriteId: string): Promise<FilesError | undefined> => {
    // reject missing place scope
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/file-favorites/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' });
    // expose a sanitized removal failure
    if (!response.ok) return responseError(response, 'Unable to remove this favorite.');
    await refresh();
    return undefined;
  }, [placeId, refresh, request]);

  // explicitly bind a replaced favorite to its current object
  const acknowledgeFavorite = useCallback(async (favoriteId: string, objectToken: string): Promise<FilesError | undefined> => {
    // reject missing place scope
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/file-favorites/${encodeURIComponent(favoriteId)}/acknowledge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectToken }) });
    const payload: unknown = await response.json().catch(() => undefined);
    // require an explicit successful acknowledgement
    if (!response.ok) return filesError(payload, 'Unable to use the current object.');
    await refresh();
    return undefined;
  }, [placeId, refresh, request]);

  // fetch a folder capability or place home without changing visible navigation
  const directoryAt = useCallback(async (path?: string, objectToken?: string): Promise<FilesList | FilesError> => {
    // require the same place scope as visible directory navigation
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, ...(objectToken === undefined ? {} : { objectToken }) }) });
    const payload: unknown = await response.json().catch(() => undefined);
    return response.ok && isFilesList(payload) ? payload : filesError(payload, 'Unable to open the destination folder.');
  }, [placeId, request]);

  // prepare one bounded raw multi-file upload for its explicit destination
  const prepareUpload = useCallback(async (files: readonly File[], destinationDirectoryToken = listing?.destinationDirectoryToken): Promise<UploadPreparation | FilesError> => {
    // require a current destination token
    if (placeId === undefined || destinationDirectoryToken === undefined) return { code: 'invalid_place', message: 'Open a destination folder first.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/uploads/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destinationDirectoryToken, files: files.map((file, index) => ({ clientId: `file-${index}`, name: file.name, size: file.size })) }) });
    const payload: unknown = await response.json().catch(() => undefined);
    return response.ok && isUploadPreparation(payload) ? payload : filesError(payload, 'Unable to prepare the upload.');
  }, [listing, placeId, request]);

  // authorize and stream every upload as raw bytes
  const upload = useCallback(async (prepared: UploadPreparation, files: readonly File[], decisions: Record<string, CollisionDecision>, onFile: (index: number, state: string) => void): Promise<{ uploaded: number; skipped: number; failure?: FilesError }> => {
    // reject missing place scope
    if (placeId === undefined) return { uploaded: 0, skipped: 0, failure: { code: 'invalid_place', message: 'This Workspace has no file location.' } };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/uploads/${encodeURIComponent(prepared.uploadId)}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisions }) });
    const payload: unknown = await response.json().catch(() => undefined);
    // stop before bytes when authorization fails
    if (!response.ok || !isUploadAuthorization(payload)) return { uploaded: 0, skipped: 0, failure: filesError(payload, 'Unable to authorize the upload.') };
    let firstFailure: FilesError | undefined;
    let uploaded = 0;
    let skipped = 0;
    // stream files sequentially for truthful per-file state
    for (let index = 0; index < files.length; index += 1) {
      const authorized = payload.files.find(candidate => candidate.clientId === `file-${index}`);
      // report explicitly skipped files
      if (authorized?.skipped) { skipped += 1; onFile(index, 'skipped'); continue; }
      // reject a malformed authorization
      if (authorized === undefined || typeof authorized.token !== 'string') { onFile(index, 'failed'); firstFailure ??= { code: 'invalid_response', message: `Upload authorization for ${files[index].name} was invalid.` }; continue; }
      onFile(index, 'uploading');
      const sent = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/uploads/${encodeURIComponent(prepared.uploadId)}/${encodeURIComponent(authorized.clientId)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-files-upload-token': authorized.token }, body: files[index] });
      // retain prior successes after a partial upload failure
      if (!sent.ok) { onFile(index, 'failed'); firstFailure ??= await responseError(sent, `Unable to upload ${files[index].name}.`); continue; }
      uploaded += 1;
      onFile(index, 'completed');
    }
    await refresh();
    return { uploaded, skipped, ...(firstFailure === undefined ? {} : { failure: firstFailure }) };
  }, [placeId, refresh, request]);

  // prepare a session-bound download manifest
  const prepareDownload = useCallback(async (entries: readonly FileEntry[]): Promise<DownloadPreparation | FilesError> => {
    // require selected current objects
    if (placeId === undefined || entries.length === 0) return { code: 'invalid_selection', message: 'Select something to download.' };
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/downloads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectTokens: entries.map(entry => entry.objectToken) }) });
    const payload: unknown = await response.json().catch(() => undefined);
    return response.ok && isDownloadPreparation(payload) ? payload : filesError(payload, 'Unable to prepare the download.');
  }, [placeId, request]);

  // observe post-header download completion or failure truthfully
  const waitForDownload = useCallback(async (downloadId: string): Promise<FilesError | undefined> => {
    // reject missing place scope
    if (placeId === undefined) return { code: 'invalid_place', message: 'This Workspace has no file location.' };
    // poll for a bounded foreground status window
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, attempt === 0 ? 250 : 500));
      const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/files/downloads/${encodeURIComponent(downloadId)}/status`);
      const payload: unknown = await response.json().catch(() => undefined);
      // stop on a status request failure
      if (!response.ok) return filesError(payload, 'Unable to confirm the download status.');
      const candidate = payload !== null && typeof payload === 'object' ? payload as { state?: unknown; error?: unknown } : undefined;
      // report a post-header stream failure
      if (candidate?.state === 'failed') return filesError({ error: candidate.error }, 'The download failed while streaming.');
      // accept an explicit completed stream
      if (candidate?.state === 'completed') return undefined;
    }
    return { code: 'download_status_timeout', message: 'The download started, but its final status is not available yet.' };
  }, [placeId, request]);

  return { placeId, open, show, close, toggle, listing, entries, sort, setSort, loading, error, setError: setNavigationError, navigate, refresh, directoryAt, selection, select, selectedEntries, clipboard: sharedClipboard, copyEntries, clearClipboard, prepare, execute, progress, favorites, addFavorite, removeFavorite, acknowledgeFavorite, prepareUpload, upload, prepareDownload, waitForDownload };
}
