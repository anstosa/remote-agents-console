// The Code panel's data layer, kept free of any `@pierre/diffs` import so it stays in the eager
// bundle: the heavy diff library lives only in `code-panel.tsx`, which main.tsx lazy-imports. This
// module owns the wire shapes of the two Comparison endpoints, the Implementation/Tests-&-docs
// classifier, and the `useCodePanel` controller that opens the panel and fetches a Comparison.
import { useCallback, useEffect, useRef, useState } from 'react';

// The two Comparisons a Worktree can show, matching the server's `ComparisonKind`.
export type CodePanelMode = 'working' | 'pr';
// One commit of the branch shown on its own, against its first parent; it stands in for the mode's
// Comparison until the reviewer picks Working or All PR again.
export type CodePanelCommit = { sha: string; subject: string };

// One changed path in a Comparison — the client mirror of the server `GitStatusChange`.
export type ComparisonChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation' | 'test' | 'doc' };
// How a file's patch was produced; mirrors the server `ComparisonFileKind`.
export type ComparisonFileKind = 'tracked' | 'metadata' | 'binary' | 'untracked';
// One file of a Comparison patch: its Change, the captured patch text, and whether the server
// withheld that text for being over a size cap (drives the "Load anyway" placeholder).
export type ComparisonFile = { change: ComparisonChange; kind: ComparisonFileKind; patch: string; capped: boolean };
// The `POST /api/worktrees/:id/comparison` response: every Change with its per-file patch, a
// content-sensitive fingerprint (for staleness), and whether the file-count/total cap truncated it.
export type ComparisonPatch = { kind: CodePanelMode | 'commit'; base: string; gitBase: string; files: ComparisonFile[]; fingerprint: string; truncated: boolean };

// One side of a file in a Comparison, from `POST /api/worktrees/:id/comparison/file`.
export type RevisionFile = { path: string; size: number; binary: boolean; truncated: boolean; content?: string };
// A changed file's two sides; either is null for an add or a delete.
export type ComparisonFileContents = { path: string; base: RevisionFile | null; working: RevisionFile | null };

// The authenticated fetch main.tsx already owns (attaches the CSRF header); injected so this module
// need not reach back into the app entry, and so tests can drive it with a scripted requester.
export type Requester = (url: string, init?: RequestInit) => Promise<Response>;

const isChange = (value: unknown): value is ComparisonChange =>
  value !== null && typeof value === 'object' && typeof (value as ComparisonChange).code === 'string' && typeof (value as ComparisonChange).path === 'string';

const comparisonFileKinds = new Set<ComparisonFileKind>(['tracked', 'metadata', 'binary', 'untracked']);

const isComparisonFile = (value: unknown): value is ComparisonFile =>
  value !== null && typeof value === 'object'
  && isChange((value as ComparisonFile).change)
  && comparisonFileKinds.has((value as ComparisonFile).kind)
  && typeof (value as ComparisonFile).patch === 'string'
  && typeof (value as ComparisonFile).capped === 'boolean';

// Validate the patch endpoint's payload before trusting it, the way `useFilePreview` guards its own.
export const isComparisonPatch = (value: unknown): value is ComparisonPatch =>
  value !== null && typeof value === 'object'
  && ['working', 'pr', 'commit'].includes((value as ComparisonPatch).kind)
  && typeof (value as ComparisonPatch).fingerprint === 'string'
  && Array.isArray((value as ComparisonPatch).files)
  && (value as ComparisonPatch).files.every(isComparisonFile);

const isRevisionFile = (value: unknown): value is RevisionFile =>
  value !== null && typeof value === 'object' && typeof (value as RevisionFile).path === 'string' && typeof (value as RevisionFile).binary === 'boolean'
  && ((value as RevisionFile).content === undefined || typeof (value as RevisionFile).content === 'string');

const isComparisonFileContents = (value: unknown): value is ComparisonFileContents =>
  value !== null && typeof value === 'object'
  && typeof (value as ComparisonFileContents).path === 'string'
  && ((value as ComparisonFileContents).base === null || isRevisionFile((value as ComparisonFileContents).base))
  && ((value as ComparisonFileContents).working === null || isRevisionFile((value as ComparisonFileContents).working));

// Fetch one file's two sides in a Worktree's Comparison; undefined when it is unavailable.
export const fetchComparisonFile = async (request: Requester, worktreeId: string, comparison: { kind: CodePanelMode; path: string } | { kind: 'commit'; commit: string; path: string }): Promise<ComparisonFileContents | undefined> => {
  try {
    const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/comparison/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(comparison) });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    return isComparisonFileContents(payload) ? payload : undefined;
  } catch { return undefined; }
};

// Which files read as supporting (tests, specs, docs) rather than implementation. Prefer the
// server-assigned category; fall back to the same path heuristic the GitStatus flyout uses so the
// panel groups a Change identically to the flyout that opened it.
export const supportingChange = (change: ComparisonChange): boolean =>
  change.category === undefined ? supportingPath(change.path) : change.category !== 'implementation';

const supportingPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return /(^|\/)(?:__tests__|e2e|specs?|tests?)(?:\/|$)/u.test(lower)
    || /(?:^|[._-])(?:spec|test)(?:[._-]|$)/u.test(name)
    || /(^|\/)(?:docs?|documentation)(?:\/|$)/u.test(lower)
    || /\.(?:adoc|md|mdx|rst)$/u.test(name)
    || /^(?:changelog|code_of_conduct|contributing|license|readme|security)(?:\.|$)/u.test(name);
};

// A Comparison's files split into the two groups the panel renders: implementation first, the
// supporting group collapsed behind a toggle. Order within each group is the server's order.
export type GroupedFiles = { implementation: ComparisonFile[]; supporting: ComparisonFile[] };
export const groupComparisonFiles = (files: ComparisonFile[]): GroupedFiles => ({
  implementation: files.filter(file => !supportingChange(file.change)),
  supporting: files.filter(file => supportingChange(file.change))
});

// The lifecycle of a Comparison fetch, mirroring the old file-preview loading/ready/error states.
export type CodePanelState = 'loading' | 'ready' | 'error';

// A raster image the file-preview endpoints can inline (the agent `/tmp` screenshot bridge and small
// working-tree images), mirroring the server's `PreviewImage`.
export type PreviewImage = { mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };
// One bounded workspace-file preview from `POST /api/{agents,worktrees}/:id/file-preview`: a text
// file's contents, or a binary file (optionally an inlined image), plus whether the 256 KB cap cut it
// short. Mirrors the server's `WorkspaceFilePreview`. The panel's File view renders text through the
// diff library and an image / binary placeholder as plain non-library views.
export type FilePreview = { path: string; size: number; truncated: boolean } & ({ binary: true; image?: PreviewImage } | { binary: false; content: string });
// The panel's File view: the path a response file or terminal link opened, the fetch lifecycle, and
// the payload once ready. A peer of the Comparison — a panel shows Changes or one File, not both.
export type FilePreviewView = { path: string; state: CodePanelState; preview?: FilePreview; source?: 'files' };

const previewMediaTypes = new Set<PreviewImage['mediaType']>(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const isPreviewImage = (value: unknown): value is PreviewImage =>
  value !== null && typeof value === 'object'
  && previewMediaTypes.has((value as PreviewImage).mediaType)
  && typeof (value as PreviewImage).base64 === 'string'
  && /^[A-Za-z0-9+/]*={0,2}$/u.test((value as PreviewImage).base64);

// Guard the file-preview payload before trusting it, the way the retired dialog's `isAssistantFilePreview` did.
export const isFilePreview = (value: unknown): value is FilePreview =>
  value !== null && typeof value === 'object'
  && typeof (value as FilePreview).path === 'string'
  && Number.isInteger((value as FilePreview).size) && (value as FilePreview).size >= 0
  && typeof (value as FilePreview).truncated === 'boolean'
  && typeof (value as { binary?: unknown }).binary === 'boolean'
  && ((value as FilePreview).binary
    ? (value as { content?: unknown }).content === undefined && ((value as { image?: unknown }).image === undefined || isPreviewImage((value as { image?: unknown }).image))
    : typeof (value as { content?: unknown }).content === 'string' && (value as { image?: unknown }).image === undefined);

// One Worktree's Code panel: whether it is open, which Comparison it shows, the latest patch, the
// file it is filtered to (if any), and the actions the flyout and the panel drive. The controller
// owns exactly what a deep link controls — open, the Working/PR Comparison, and the selected file —
// while purely visual state (Hunks/Full/Plain, unified/split, the rail) lives in the panel view.
// Threaded to `Log`/`WorktreeCard` as a single prop.
export type CodePanelController = {
  open: boolean;
  mode: CodePanelMode;
  // the one commit the panel shows instead of the mode's Comparison, if any
  commit: CodePanelCommit | undefined;
  state: CodePanelState;
  patch: ComparisonPatch | undefined;
  // the one file the panel is filtered to, or undefined for the all-files view
  selectedPath: string | undefined;
  // the File the panel is showing — a response file or terminal link opened via a file-preview
  // endpoint — or undefined when the panel shows a Comparison. A panel shows Changes or one File.
  filePreview: FilePreviewView | undefined;
  // open (or refocus) the panel on the given Comparison, seeded from the flyout's mode; a `path`
  // filters straight to that one Change (a flyout row deep link), otherwise shows all files
  openChanges(mode: CodePanelMode, path?: string): void;
  // open (or refocus) the panel on one commit's own Changes
  openCommit(commit: CodePanelCommit): void;
  // open (or refocus) the panel on one file, fetched from the given preview endpoint (agent-keyed for
  // an agent-context file so the `/tmp` screenshot bridge works, worktree-keyed otherwise)
  openFilePreview(path: string, previewUrl: string, options?: { body?: unknown; source?: 'files' }): void;
  // leave the File view, revealing the Comparison the panel would otherwise show
  closeFilePreview(): void;
  // switch the Comparison in place (the panel-header Working / All PR toggle), leaving any commit; refetches
  setMode(mode: CodePanelMode): void;
  // filter the open panel to one Change, or return to all files
  selectFile(path: string): void;
  clearFile(): void;
  // re-request the current Comparison (used by the retry affordance)
  refresh(): void;
  // fetch one changed file's two sides, for the "Load anyway" placeholder and single-file modes
  loadFile(path: string): Promise<ComparisonFileContents | undefined>;
  close(): void;
};

// scope the open flag to one browser client and Worktree, mirroring the browser split's key
const codeOpenKey = (worktreeId: string) => `rac.code-open:${worktreeId}`;
// read the retained code split for inactive workspace menus
export const savedCodeOpen = (worktreeId: string | undefined): boolean => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(codeOpenKey(worktreeId)) === '1'; } catch { return false; }
};
// persist non-destructive code split visibility
export const saveCodeOpen = (worktreeId: string | undefined, open: boolean) => {
  if (worktreeId === undefined) return;
  try { if (open) localStorage.setItem(codeOpenKey(worktreeId), '1'); else localStorage.removeItem(codeOpenKey(worktreeId)); }
  catch { /* browser storage is optional */ }
};

// Own one Worktree's Code panel: its open/mode state, and the Comparison fetch that refreshes when
// the Worktree, mode, or an explicit refresh changes. Fetches only while open so a closed panel
// costs nothing; a request-id guard drops replaced or stale responses like `useFilePreview`.
//
// `changeSignal` is a value the caller recomputes whenever the Worktree's live change summary moves
// (the dashboard pushes gitStatus/gitPrStatus on every edit). When it changes the panel does a SOFT
// refresh: it refetches the current Comparison without tearing down the visible patch, so the diff
// updates in place — file by file, preserving scroll — instead of blanking to a spinner.
export const useCodePanel = (worktreeId: string | undefined, request: Requester, changeSignal?: string): CodePanelController => {
  const [open, setOpen] = useState(() => savedCodeOpen(worktreeId));
  const [mode, setModeState] = useState<CodePanelMode>('working');
  const [commit, setCommit] = useState<CodePanelCommit>();
  const commitSha = commit?.sha;
  const [state, setState] = useState<CodePanelState>('loading');
  const [patch, setPatch] = useState<ComparisonPatch>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [filePreview, setFilePreview] = useState<FilePreviewView>();
  const [refreshToken, setRefreshToken] = useState(0);
  const requestId = useRef(0);
  // a separate request id for the file-preview fetch, so a replaced or closed File view drops its
  // in-flight response the way the Comparison fetch does
  const previewRequest = useRef(0);
  // the last change signal we reacted to; the soft-refresh effect fires only on a genuine change,
  // not on the mount tick or on the open/mode dependencies it also watches
  const signalRef = useRef(changeSignal);

  // fetch and validate one Comparison patch; returns undefined on any failure so callers decide
  // whether that means "error" (a hard load) or "leave the current patch untouched" (a soft refresh)
  const fetchPatch = useCallback(async (id: string, kind: CodePanelMode, sha?: string): Promise<ComparisonPatch | undefined> => {
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(id)}/comparison`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sha === undefined ? { kind } : { kind: 'commit', commit: sha }) });
      if (!response.ok) return undefined;
      const payload: unknown = await response.json();
      return isComparisonPatch(payload) ? payload : undefined;
    } catch { return undefined; }
  }, [request]);

  // a closed or unscoped panel holds no Comparison; reopening refetches from scratch, and a
  // different Worktree drops any file the previous one was filtered to
  useEffect(() => {
    setOpen(savedCodeOpen(worktreeId));
    setPatch(undefined);
    setCommit(undefined);
    setSelectedPath(undefined);
    setFilePreview(undefined);
    signalRef.current = changeSignal;
    requestId.current += 1;
    previewRequest.current += 1;
    // the signal belongs to the new Worktree; the open effect below reloads from scratch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  // hard load: opening the panel, switching Comparison, or an explicit refresh blanks to a spinner
  // and fetches from scratch
  useEffect(() => {
    if (!open || worktreeId === undefined) return;
    const id = ++requestId.current;
    setState('loading');
    setPatch(undefined);
    void (async () => {
      const next = await fetchPatch(worktreeId, mode, commitSha);
      // drop a response the panel no longer awaits
      if (requestId.current !== id) return;
      if (next === undefined) { setState('error'); return; }
      setPatch(next);
      setState('ready');
    })();
  }, [open, worktreeId, mode, commitSha, refreshToken, fetchPatch]);

  // soft refresh: the live change summary moved, so update the open Comparison in place. Only acts
  // once a patch is already on screen — while the initial hard load is still in flight (or after an
  // error) `patch` is undefined and the hard-load/retry path owns the fetch, so a soft refresh never
  // preempts it and strands the panel at "loading". Keep the visible patch and the ready state
  // throughout, and swap only when the server fingerprint actually moved — an identical fingerprint
  // means the change was in the other Comparison, so nothing to repaint.
  useEffect(() => {
    const changed = signalRef.current !== changeSignal;
    signalRef.current = changeSignal;
    if (!changed || !open || worktreeId === undefined || patch === undefined) return;
    const id = ++requestId.current;
    void (async () => {
      const next = await fetchPatch(worktreeId, mode, commitSha);
      if (next === undefined || requestId.current !== id) return;
      setPatch(current => current !== undefined && current.fingerprint === next.fingerprint ? current : next);
      setState('ready');
    })();
  }, [changeSignal, open, worktreeId, mode, commitSha, patch, fetchPatch]);

  const openChanges = useCallback((next: CodePanelMode, path?: string) => {
    // opening Changes leaves any File view the panel was showing
    previewRequest.current += 1;
    setFilePreview(undefined);
    setModeState(next);
    setCommit(undefined);
    setSelectedPath(path);
    setOpen(true);
    // A flyout deep link reflects the live dashboard status, so always refetch — an already-open
    // panel holds a one-time snapshot that may predate the file being opened, which would otherwise
    // read as "not part of the current changes".
    setRefreshToken(token => token + 1);
    saveCodeOpen(worktreeId, true);
  }, [worktreeId]);

  const openCommit = useCallback((next: CodePanelCommit) => {
    previewRequest.current += 1;
    setFilePreview(undefined);
    setCommit(next);
    setSelectedPath(undefined);
    setOpen(true);
    setRefreshToken(token => token + 1);
    saveCodeOpen(worktreeId, true);
  }, [worktreeId]);

  // open a transient file from a legacy path body or an explicit token body
  const openFilePreview = useCallback((path: string, previewUrl: string, options?: { body?: unknown; source?: 'files' }) => {
    const id = ++previewRequest.current;
    setFilePreview({ path, state: 'loading', ...(options?.source === undefined ? {} : { source: options.source }) });
    setOpen(true);
    void (async () => {
      try {
        const response = await request(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options?.body ?? { path }) });
        if (!response.ok) throw new Error('preview unavailable');
        const payload: unknown = await response.json();
        if (!isFilePreview(payload)) throw new Error('invalid preview');
        if (previewRequest.current !== id) return;
        setFilePreview({ path: payload.path, state: 'ready', preview: payload, ...(options?.source === undefined ? {} : { source: options.source }) });
      } catch {
        if (previewRequest.current === id) setFilePreview({ path, state: 'error', ...(options?.source === undefined ? {} : { source: options.source }) });
      }
    })();
  }, [request]);

  const closeFilePreview = useCallback(() => {
    previewRequest.current += 1;
    // close transient files previews unless changes was retained
    if (filePreview?.source === 'files' && !savedCodeOpen(worktreeId)) setOpen(false);
    setFilePreview(undefined);
  }, [filePreview?.source, worktreeId]);

  // the panel-header Working / All PR toggle; keep any selected file so the reviewer stays on it
  const setMode = useCallback((next: CodePanelMode) => { setModeState(next); setCommit(undefined); }, []);
  const selectFile = useCallback((path: string) => setSelectedPath(path), []);
  const clearFile = useCallback(() => setSelectedPath(undefined), []);

  const refresh = useCallback(() => setRefreshToken(token => token + 1), []);
  const close = useCallback(() => { setOpen(false); saveCodeOpen(worktreeId, false); previewRequest.current += 1; setFilePreview(undefined); }, [worktreeId]);

  const loadFile = useCallback(async (path: string): Promise<ComparisonFileContents | undefined> =>
    worktreeId === undefined ? undefined : await fetchComparisonFile(request, worktreeId, commitSha === undefined ? { kind: mode, path } : { kind: 'commit', commit: commitSha, path }), [worktreeId, mode, commitSha, request]);

  // The Comparison needs a Worktree to scope its endpoints, but a File preview rides the agent-keyed
  // file-preview endpoint, so it can show even for an agent with no Worktree — keep the panel visible
  // whenever a File is open, or when Changes are open on a real Worktree.
  const panelVisible = filePreview !== undefined || (open && worktreeId !== undefined);
  return { open: panelVisible, mode, commit, state, patch, selectedPath, filePreview, openChanges, openCommit, openFilePreview, closeFilePreview, setMode, selectFile, clearFile, refresh, loadFile, close };
};
