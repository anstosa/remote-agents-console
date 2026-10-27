// The Code panel view: a Comparison's Changes rendered with `@pierre/diffs`, either as one
// virtualized scroll of every file or filtered to a single file. This module is the app's only
// importer of the library, and main.tsx pulls it in with a dynamic `import()` so the ~177 kB (plus
// lazy shiki chunks) never lands in the eager dashboard bundle. It is a controlled view — the
// controller (main.tsx) or the test fixture owns which Comparison and which file it shows and hands
// them in — so it stays free of any network code and easy to drive in isolation. What the view owns
// itself is purely visual: the diff mode (Hunks / Full context / Plain file), unified vs split, and
// the changed-file rail/drawer.
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { closeOnMiddleClick } from '../middle-click.js';
import { FlyoutPortal } from '../flyout-portal.js';
import { useViewportFlyout } from '../viewport-flyout.js';
import type { CodeViewLineSelection, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewItem, type CodeViewReactOptions, type FileDiffMetadata } from '@pierre/diffs/react';
import { openSelectionContextMenu, preserveContextMenuPress, useSelectionActions, type SelectionActions, type SelectionContextMode } from '../selection-context-menu.js';
import { useColorTheme } from '../color-theme.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand } from '../panel-header.js';
import { useTerminalFontSize } from '../terminal-font-size.js';
import { groupComparisonFiles, previewImageByteLimit, type CodePanelCommit, type CodePanelMode, type CodePanelState, type CodePanelView, type CodePanelViewMode, type ExpandedLines, type ScrollAnchor, type ComparisonChange, type ComparisonFile, type ComparisonFileContents, type ComparisonPatch, type FilePreviewView, type PreviewImage, type RevisionFile } from './comparison.js';
import { DiffLayoutSegment, SPLIT_MIN_WIDTH, useDiffSplit, useObservedWidth } from './diff-layout.js';
import { diffJumpLine, EditorJumpButton, isPlaceRelativePath, type EditorTarget } from './editor-jump.js';
import { annotatedItem, codeViewBaseOptions, codeViewStyle, diffItemForContents, diffItemForFile, fileItemForContents, fileVersion, hunkLinesOnlyCSS, loadedFilesFromContents, rememberExpandedLines } from './items.js';
import { orderedRange, patchRowIndex, patchRows } from './patch-rows.js';
import { askLines } from '../asks.js';
import type { LineAsks } from '../ask-thread.js';

// an annotation is the Ask thread under some lines
type PanelAnnotation = { askId: string } | undefined;
type PanelItem = CodeViewItem<PanelAnnotation>;
type PanelOptions = CodeViewReactOptions<PanelAnnotation, undefined>;
type PanelHandle = CodeViewHandle<PanelAnnotation, undefined>;

// Below this panel width the changed-file list is a slide-over drawer rather than a persistent left
// rail, and the split layout is unavailable — one width rule (shared with the Review tour) covers both
// phones (always narrow) and a narrow desktop column, which is what "phones force unified" and
// "narrow panels auto-collapse" both come down to.
const RAIL_BREAKPOINT = SPLIT_MIN_WIDTH;

// Below this (narrower) width the title pill drops the branch so the title reads.
const COMPACT_BREAKPOINT = 480;

// The rail's dragged width, remembered on this browser; unset leaves the stylesheet's default. The
// stylesheet also caps the rail at half the panel, so a width saved on a wide panel fits a narrower one.
const railWidthKey = 'rac.code-rail-width';
const RAIL_MIN_WIDTH = 160;
const readRailWidth = (): number | undefined => {
  try { const width = Number(localStorage.getItem(railWidthKey)); return width >= RAIL_MIN_WIDTH ? width : undefined; }
  catch { return undefined; }
};
const saveRailWidth = (width: number): void => {
  try { localStorage.setItem(railWidthKey, String(width)); } catch { /* private-mode storage is non-fatal */ }
};

export type CodePanelProps = {
  // the Comparison the panel shows: Working tree vs HEAD, or the whole PR
  mode: CodePanelMode;
  // one commit shown in place of the mode's Comparison
  commit?: CodePanelCommit;
  state: CodePanelState;
  patch: ComparisonPatch | undefined;
  // the one file the panel is filtered to, or undefined for the all-files scroll
  selectedPath: string | undefined;
  // the File the panel is showing (a response file or terminal link), or undefined for a Comparison;
  // when set the panel renders the File view instead of the Changes layout
  filePreview?: FilePreviewView;
  // whether an All PR Comparison (and so its commits) exists to pick
  prAvailable: boolean;
  // the Place's branch, shown beside the Comparison picker
  branch?: string;
  // the guided review of the shown Comparison, where an Agent can run one
  review?: CodePanelReview;
  loadFile: (path: string) => Promise<ComparisonFileContents | undefined>;
  onSelectFile: (path: string) => void;
  onClearFile: () => void;
  onSetMode: (mode: CodePanelMode) => void;
  // the branch's commits for the Comparison picker, and picking one; the picker offers only Working
  // and All PR without them
  loadCommits?: () => Promise<CodePanelCommit[] | undefined>;
  onSelectCommit?: (commit: CodePanelCommit) => void;
  // leave the File view, returning to the Comparison the panel would otherwise show
  onCloseFile: () => void;
  onClose: () => void;
  onRetry?: () => void;
  // open a file at a line in the configured editor; the file headers' editor buttons are hidden
  // without it
  onOpenInEditor?: (target: EditorTarget) => void;
  // the view state this panel last had in its Workspace, restored on mount; `onSaveView` takes it
  // back as the panel unmounts
  savedView?: CodePanelView;
  onSaveView?: (view: CodePanelView) => void;
  // When given, the gutter "+" asks about the picked lines of a diff, and each Ask thread shows under
  // the last of its lines while the file's patch still holds them.
  ask?: LineAsks;
};

// Start (or reopen) the guided review of a Comparison; `unavailable` says why it cannot start.
// With no Agent there is no `onReview`, and the button shows disabled with `unavailable` as its reason.
// `generating` marks an open review still being built; the button says so but still opens it.
export type CodePanelReview = { onReview?: (scope: CodePanelMode) => void; open: boolean; generating?: boolean; unavailable?: string };

// Why a Change shows a placeholder instead of a rendered diff.
type PlaceholderReason = 'capped' | 'binary' | 'metadata' | 'unrenderable';
type Placeholder = { path: string; reason: PlaceholderReason; note?: string };
// The per-Change load status of the "Load anyway" affordance.
type LoadStatus = 'loading' | 'error';
// A CodeView item paired with the patch-derived content version (`fileVersion`) it was built for.
// The library reconciles controlled items by id + `version`, so a stable version already stops it
// re-rendering or re-hydrating an unchanged file; caching the item by version on top of that both
// hands back the identical object (the library's documented identity rule) and — the load-bearing
// use — lets a changed file keep showing its prior full-context item while its rebuild is fetched.
// Both the item cache and a resolved full-context override carry the same shape.
type VersionedItem = { patchVersion: number; item: PanelItem };
// A file that changed while shown in full context and needs a non-partial rebuild fetched (below).
type OverrideNeed = { path: string; version: number };

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// offer previews for capped raster paths without treating svg source as an image
const isImagePath = (path: string): boolean => /\.(?:png|jpe?g|gif|webp)$/iu.test(path);

// tracked binary patches retain git's binary marker rather than a binary file kind
const isBinaryPatch = (patch: string): boolean => /^(?:GIT binary patch|Binary files .+ differ)$/mu.test(patch);

// unrelated file edits must not invalidate a selected image's response
const previewVersion = (file: ComparisonFile, comparison: string, base: string | undefined): string => JSON.stringify([comparison, base, file.fingerprint ?? fileVersion(file), file.change]);

// text comparisons require at least one revision and no binary side
const isTextComparison = (contents: ComparisonFileContents): boolean => (contents.base !== null || contents.working !== null) && contents.base?.binary !== true && contents.working?.binary !== true;

// Copy text to the clipboard, falling back to a hidden textarea + execCommand when the async
// Clipboard API is unavailable — RAC is served over LAN http, a non-secure context where
// `navigator.clipboard` is undefined, so the fallback is what makes copy-path work there.
const copyToClipboard = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
};

// Return a copy of a path-keyed record with only the keys that pass `keep`; the same reference when
// nothing was dropped, so a no-op refresh does not force a re-render.
const keepKeys = <V,>(record: Record<string, V>, keep: (path: string) => boolean): Record<string, V> => {
  const kept = Object.keys(record).filter(keep);
  if (kept.length === Object.keys(record).length) return record;
  return Object.fromEntries(kept.map(path => [path, record[path]]));
};

// The placeholder a diffable-in-principle file falls back to when its patch cannot be rendered
// (withheld for size, binary, or a metadata-only change); undefined means it renders as a real diff.
const placeholderFor = (file: ComparisonFile): Placeholder | undefined => {
  if (file.capped) return { path: file.change.path, reason: 'capped' };
  // tracked git binary markers use the same preview action as untracked binaries
  if (file.kind === 'binary' || isBinaryPatch(file.patch)) return { path: file.change.path, reason: 'binary' };
  if (file.kind === 'metadata') return { path: file.change.path, reason: 'metadata', note: file.patch };
  return undefined;
};

// scope readonly selection to the rendered code, including diff shadow roots
function codeContextMenu(event: ReactMouseEvent<HTMLElement>, actions: SelectionActions | undefined, modes: SelectionContextMode[] = []) {
  const panel = event.currentTarget;
  const path = event.nativeEvent.composedPath();
  const shadow = path.find((node): node is ShadowRoot => node instanceof ShadowRoot);
  // retain the clicked side when the diff uses two code columns
  const targetCode = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'CODE');
  const selection = window.getSelection();
  let anchor = selection?.anchorNode;
  // cross shadow boundaries only to verify this panel owns the selection
  while (anchor !== null && anchor !== undefined && !panel.contains(anchor)) {
    const root = anchor.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    anchor = root.host;
  }
  const selected = anchor !== null && anchor !== undefined && panel.contains(anchor) ? selection?.toString() ?? '' : '';
  // header invocations have no shadow path, so resolve the active or first rendered file
  const selectedRoot = selection?.anchorNode?.getRootNode();
  const selectedCode = selectedRoot instanceof ShadowRoot && panel.contains(selectedRoot.host) ? selection?.anchorNode?.parentElement?.closest('code') ?? selectedRoot.querySelector('code') : undefined;
  const renderedCode = Array.from(panel.querySelectorAll('diffs-container'), host => host.shadowRoot?.querySelector('code')).find(code => Boolean(code?.textContent));
  const content = targetCode ?? shadow?.querySelector('code') ?? selectedCode ?? renderedCode ?? panel.querySelector('.code-pane-view') ?? panel;
  openSelectionContextMenu(event, {
    label: 'Code options', modes, selectedText: selected,
    // select the rendered code rather than controls outside this split
    selectAll: () => {
      const range = document.createRange();
      range.selectNodeContents(content);
      const current = window.getSelection();
      current?.removeAllRanges();
      current?.addRange(range);
    },
    copy: () => copyToClipboard(selected),
    selectionActions: actions
  });
}

export default function CodePanel({ mode, commit, state, patch, selectedPath, filePreview, prAvailable, branch, review, loadFile, onSelectFile, onClearFile, onSetMode, loadCommits, onSelectCommit, onCloseFile, onClose, onRetry, onOpenInEditor, savedView, onSaveView, ask }: CodePanelProps) {
  const selectionActions = useSelectionActions();
  const theme = useColorTheme();
  const fontSize = useTerminalFontSize();
  const [supportingExpanded, setSupportingExpanded] = useState(savedView?.supportingExpanded ?? false);
  // the Workspace's expansion, which promotes this panel over its siblings
  const expanded = usePanelExpand('code')?.expanded === true;
  const [viewMode, setViewMode] = useState<CodePanelViewMode>(savedView?.viewMode ?? 'hunks');
  const [split, setSplit] = useDiffSplit();
  // wrapping is opt-in so wide lines keep their horizontal scroll by default
  const [wrapLines, setWrapLines] = useState(savedView?.wrapLines ?? false);
  // keep file collapse separate from cached diff content and version each toggle for CodeView
  const [fileCollapse, setFileCollapse] = useState<CodePanelView['fileCollapse']>(savedView?.fileCollapse ?? {});
  const [railCollapsed, setRailCollapsed] = useState(savedView?.railCollapsed ?? false);
  const [railWidth, setRailWidth] = useState(readRailWidth);
  const railDragRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Changes the reviewer pulled in with "Load anyway", keyed by path; they render as ordinary diff
  // items alongside the rest.
  const [loaded, setLoaded] = useState<Record<string, PanelItem>>({});
  const [loadStatus, setLoadStatus] = useState<Record<string, LoadStatus>>({});
  // each manual load owns one file revision and cannot settle a newer request
  const loadRequestsRef = useRef(new Map<string, { version: string }>());
  // reuse a classified response without fetching the same revision again
  const [previewOverride, setPreviewOverride] = useState<{ version: string; contents: ComparisonFileContents }>();
  // The working-tree contents for the selected file in Plain mode, fetched on demand.
  const [plain, setPlain] = useState<{ path: string; contents?: string; error?: boolean }>();
  // Non-partial rebuilds for files that changed while shown in full context, keyed by path; the item
  // memo prefers one of these over a fresh partial so a live edit never blinks back to hunks-only.
  const [fullOverrides, setFullOverrides] = useState<Record<string, VersionedItem>>({});

  const viewRef = useRef<PanelHandle>(null);
  // The place to return to when the reviewer leaves the all-files scroll for one file.
  const anchorRef = useRef<ScrollAnchor | undefined>(savedView?.listAnchor);
  // The place on screen to return to after a Workspace switch, once the reloaded items render.
  const restoreRef = useRef<ScrollAnchor | undefined>(savedView?.scroll);
  // The hidden lines expanded in each diff, which the library forgets when the CodeView unmounts.
  const [expandedLines] = useState<ExpandedLines>(() => new Map(savedView?.expanded));
  // The rendered item per file id, with the content version it was built for. Kept across live
  // updates so an unchanged file hands the library the identical object (preserving its scroll and
  // full-context expansion); a version-mismatch is what marks a file as edited.
  const itemCacheRef = useRef<Map<string, VersionedItem>>(new Map());
  // Full-context rebuilds in flight, keyed by path → the version being fetched, so a file is fetched
  // once per version even as the memo re-emits the need on every render until it resolves.
  const overrideInflightRef = useRef<Map<string, number>>(new Map());

  // Reset the view-local caches when the Comparison changes. A mode switch (Working ↔ All PR, or a
  // commit) is a different Comparison entirely, so everything view-local is dropped. A same-mode content refresh
  // (a live update) is surgical: only entries for files the Comparison no longer has are dropped, plus
  // resolved overrides whose file changed content — a "Load anyway" view or expansion of an unrelated,
  // unchanged file survives an edit elsewhere. The id-based scroll anchor and the version-guarded item
  // cache are kept so unchanged files stay put.
  const comparisonKey = commit?.sha ?? mode;
  const comparisonKeyRef = useRef(comparisonKey);
  comparisonKeyRef.current = comparisonKey;
  // later navigation wins over an image classification started from the all-files list
  const navigationRef = useRef({ selectedPath, filePreview, comparisonKey, epoch: 0 });
  // include external navigation before async responses can settle
  if (navigationRef.current.selectedPath !== selectedPath || navigationRef.current.filePreview !== filePreview || navigationRef.current.comparisonKey !== comparisonKey) {
    navigationRef.current = { selectedPath, filePreview, comparisonKey, epoch: navigationRef.current.epoch + 1 };
  }
  const lastModeRef = useRef(comparisonKey);
  useEffect(() => {
    const modeChanged = lastModeRef.current !== comparisonKey;
    lastModeRef.current = comparisonKey;
    // a different comparison invalidates all manual loads
    if (modeChanged) {
      setLoaded({}); setLoadStatus({}); setPlain(undefined); setFullOverrides({});
      loadRequestsRef.current.clear();
      setFileCollapse({});
      anchorRef.current = undefined;
      restoreRef.current = undefined;
      itemCacheRef.current.clear();
      overrideInflightRef.current.clear();
      return;
    }
    const live = patch?.files;
    // missing comparisons cannot retain pending controls
    if (live === undefined) { setLoaded({}); setLoadStatus({}); setFullOverrides({}); loadRequestsRef.current.clear(); return; }
    // keep "Load anyway" results for files the Comparison still has (a capped/binary file the reviewer
    // pulled in stays put unless it is gone); keep an override only while its file's version is unchanged
    const present = new Set(live.map(file => file.change.path));
    const versions = new Map(live.map(file => [file.change.path, fileVersion(file)] as const));
    const previewVersions = new Map(live.map(file => [file.change.path, previewVersion(file, comparisonKey, patch?.gitBase)] as const));
    // unchanged files keep their request through unrelated live edits
    for (const [path, request] of loadRequestsRef.current) {
      // changed or removed revisions release their old loading control
      if (previewVersions.get(path) !== request.version) loadRequestsRef.current.delete(path);
    }
    setLoaded(current => keepKeys(current, path => present.has(path)));
    setLoadStatus(current => keepKeys(current, path => loadRequestsRef.current.has(path)));
    setFullOverrides(current => keepKeys(current, path => versions.get(path) === current[path]?.patchVersion));
    setFileCollapse(current => keepKeys(current, path => present.has(path)));
  }, [comparisonKey, patch?.fingerprint]);
  // full-context overrides use the current comparison fingerprint to reject stale rebuilds
  const fingerprintRef = useRef(patch?.fingerprint);
  fingerprintRef.current = patch?.fingerprint;
  // The latest patch, read by the async override resolver (below) to fall back to a fresh partial.
  const patchRef = useRef(patch);
  patchRef.current = patch;

  // Track the panel's own width so the file list and layout adapt to a narrow column, not just a
  // narrow viewport — a Code panel is one column in the split and can be much narrower than the tab.
  // A callback ref (not a mount-once effect) so the observer re-attaches every time the Comparison
  // section mounts: the panel can open straight into the File view, whose section carries no ref, and
  // returning from a File detour remounts this section — a `[]`-effect would never see either.
  const [panelRef, panelWidth] = useObservedWidth();
  // `narrow` folds the file list into a drawer and forces unified; `compact` (narrower still) drops
  // the header's branch.
  const narrow = panelWidth < RAIL_BREAKPOINT;
  const compact = panelWidth < COMPACT_BREAKPOINT;

  // Plain view is single-file only; fall back to Hunks in the all-files scroll. Split needs a wide
  // column, so a narrow panel (a phone, or a squeezed column) is always unified.
  const effectiveMode: CodePanelViewMode = selectedPath === undefined && viewMode === 'plain' ? 'hunks' : viewMode;
  const effectiveSplit = split && !narrow && effectiveMode !== 'plain';

  const groups = useMemo(() => patch === undefined ? { implementation: [], supporting: [] } : groupComparisonFiles(patch.files), [patch]);
  // inspect withheld or non-text patches without guessing content from a filename
  const { file: selectedPreviewFile, text: selectedTextContents } = useMemo(() => {
    const file = patch?.files.find(candidate => candidate.change.path === selectedPath);
    // ordinary text diffs retain their existing renderer even with a raster extension
    if (file === undefined || file.kind === 'metadata') return { file: undefined, text: undefined };
    const contents = previewOverride?.version === previewVersion(file, comparisonKey, patch?.gitBase) ? previewOverride.contents : undefined;
    // restore all primary diff controls once fetched bytes establish ordinary text
    if (contents !== undefined && isTextComparison(contents)) return { file: undefined, text: contents };
    return { file: file.capped || file.kind === 'binary' || isBinaryPatch(file.patch) || diffItemForFile(file) === undefined ? file : undefined, text: undefined };
  }, [patch, selectedPath, comparisonKey, previewOverride]);
  // unrelated edits must not rebuild a fully hydrated text item
  const selectedTextItem = useMemo(() => selectedTextContents === undefined ? undefined : diffItemForContents(selectedTextContents), [selectedTextContents]);

  // Fetch the working-tree contents for the selected file when Plain mode needs them.
  useEffect(() => {
    // binary candidates own their preview instead of entering the plain text loader
    if (patch === undefined || selectedPath === undefined || effectiveMode !== 'plain' || selectedPreviewFile !== undefined) { setPlain(undefined); return; }
    // skip a selection removed from the comparison
    if (patch.files.every(file => file.change.path !== selectedPath)) return;
    // reuse classified working text for plain mode instead of fetching it twice
    if (selectedTextContents !== undefined) {
      const text = selectedTextContents.working?.content;
      setPlain(text === undefined ? { path: selectedPath, error: true } : { path: selectedPath, contents: text });
      return;
    }
    let cancelled = false;
    const path = selectedPath;
    setPlain({ path });
    void (async () => {
      const contents = await loadFile(path);
      if (cancelled) return;
      const text = contents?.working?.content;
      setPlain(text === undefined ? { path, error: true } : { path, contents: text });
    })();
    return () => { cancelled = true; };
  }, [patch, selectedPath, effectiveMode, loadFile, selectedPreviewFile, selectedTextContents]);

  // Full-context mode hydrates a partial patch with the file's two revisions so the diff library can
  // expand the unchanged lines around each hunk.
  const loadDiffFiles = useCallback(async (fileDiff: FileDiffMetadata) => {
    const contents = await loadFile(fileDiff.name);
    const loadedFiles = contents === undefined ? undefined : loadedFilesFromContents(contents);
    if (loadedFiles === undefined) throw new Error('file contents unavailable');
    return loadedFiles;
  }, [loadFile]);

  // One pass building the CodeView items (in the scroll) and placeholders (in the list above it) for
  // the current view: a single selected file, or every visible file in Implementation-then-Tests&docs
  // order. "Load anyway" moves a withheld file out of the placeholder list and into the diff scroll.
  // Diffable files go through the item cache so an unchanged file keeps its exact object (and so its
  // scroll and full-context expansion) across a live update, while an edited file rebuilds — and, in
  // full context, holds its prior expanded item until a non-partial rebuild is fetched (overrideNeeds).
  const { items, placeholders, missing, overrideNeeds } = useMemo(() => {
    const cache = itemCacheRef.current;
    const needs: OverrideNeed[] = [];
    const fullMode = effectiveMode === 'full';
    const buildDiff = (file: ComparisonFile): PanelItem | undefined => {
      const id = `diff:${file.change.path}`;
      const version = fileVersion(file);
      const cached = cache.get(id);
      // unchanged file: reuse the identical object so the library preserves its instance
      if (cached !== undefined && cached.patchVersion === version) return cached.item;
      // an edited file already shown in full context keeps its expanded item until a non-partial
      // rebuild arrives, so it never blinks to hunks-only; ask for one meanwhile
      if (fullMode && cached !== undefined) {
        const ready = fullOverrides[file.change.path];
        if (ready !== undefined && ready.patchVersion === version) { cache.set(id, { patchVersion: version, item: ready.item }); return ready.item; }
        needs.push({ path: file.change.path, version });
        return cached.item;
      }
      const item = diffItemForFile(file);
      if (item === undefined) return undefined;
      cache.set(id, { patchVersion: version, item });
      return item;
    };
    if (patch === undefined) return { items: [] as PanelItem[], placeholders: [] as Placeholder[], missing: false, overrideNeeds: needs };
    // keep the cache and any resolved overrides bounded to the files the Comparison still has
    const live = new Set(patch.files.map(file => `diff:${file.change.path}`));
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
    if (selectedPath !== undefined) {
      const file = patch.files.find(candidate => candidate.change.path === selectedPath);
      if (file === undefined) return { items: [], placeholders: [], missing: true, overrideNeeds: needs };
      // image revisions render outside the text diff library
      if (selectedPreviewFile !== undefined) return { items: [], placeholders: [], missing: false, overrideNeeds: needs };
      // Plain mode always renders the whole current file, even for a file the reviewer earlier
      // pulled in with "Load anyway" — so it wins over the cached diff item.
      if (effectiveMode === 'plain') {
        return plain?.path === selectedPath && plain.contents !== undefined
          ? { items: [fileItemForContents(selectedPath, plain.contents)], placeholders: [], missing: false, overrideNeeds: needs }
          : { items: [], placeholders: [], missing: false, overrideNeeds: needs };
      }
      // classified text uses the same editor, selection, annotations and collapse renderer
      if (selectedTextItem !== undefined) return { items: [selectedTextItem], placeholders: [], missing: false, overrideNeeds: needs };
      const already = loaded[selectedPath];
      if (already !== undefined) return { items: [already], placeholders: [], missing: false, overrideNeeds: needs };
      const placeholder = placeholderFor(file);
      if (placeholder !== undefined) return { items: [], placeholders: [placeholder], missing: false, overrideNeeds: needs };
      const item = buildDiff(file);
      return item !== undefined ? { items: [item], placeholders: [], missing: false, overrideNeeds: needs } : { items: [], placeholders: [{ path: selectedPath, reason: 'unrenderable' as const }], missing: false, overrideNeeds: needs };
    }
    const ordered: ComparisonFile[] = [...groups.implementation, ...(supportingExpanded ? groups.supporting : [])];
    const nextItems: PanelItem[] = [];
    const nextPlaceholders: Placeholder[] = [];
    for (const file of ordered) {
      const path = file.change.path;
      const already = loaded[path];
      if (already !== undefined) { nextItems.push(already); continue; }
      const placeholder = placeholderFor(file);
      if (placeholder !== undefined) { nextPlaceholders.push(placeholder); continue; }
      const item = buildDiff(file);
      if (item !== undefined) nextItems.push(item); else nextPlaceholders.push({ path, reason: 'unrenderable' });
    }
    return { items: nextItems, placeholders: nextPlaceholders, missing: false, overrideNeeds: needs };
  }, [patch, selectedPath, effectiveMode, plain, groups, supportingExpanded, loaded, fullOverrides, selectedPreviewFile, selectedTextItem]);

  // The asked-about lines, each under its last line while its file's patch holds it. `askKey` stands
  // in for them, covering every field read, so a render that moves no thread re-lays out nothing.
  const lineAsks = ask?.lineAsks ?? [];
  const askKey = lineAsks.map(entry => `${entry.id}@${entry.changeId}:${entry.side}:${entry.endLine}`).join('|');
  // only toggled or asked-about files get new item versions; unchanged files retain their cache identity
  const visibleItems = useMemo(() => items.map(item => {
    // plain files and untouched diffs keep their original instance
    if (item.type !== 'diff') return item;
    const path = item.id.slice(5);
    const collapse = fileCollapse[path];
    // an untouched diff keeps its original instance too
    const shown = collapse === undefined ? item : { ...item, collapsed: collapse.collapsed, version: (item.version ?? 0) + collapse.revision };
    const asked = lineAsks.filter(entry => entry.changeId === path);
    const rows = asked.length === 0 ? [] : patchRows(patch?.files.find(file => file.change.path === path)?.patch ?? '');
    return annotatedItem(shown, asked.filter(entry => patchRowIndex(rows, entry.side, entry.endLine) >= 0).map(entry => ({ key: entry.id, annotation: { side: entry.side, lineNumber: entry.endLine, metadata: { askId: entry.id } } as DiffLineAnnotation<PanelAnnotation> })));
    // askKey stands in for lineAsks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items, fileCollapse, askKey, patch]);
  // the library keeps a collapsed item's header mounted, so this controls its body in place
  const toggleFileCollapse = useCallback((path: string) => {
    setFileCollapse(current => ({ ...current, [path]: { collapsed: !current[path]?.collapsed, revision: (current[path]?.revision ?? 0) + 1 } }));
  }, []);

  // Fetch the non-partial rebuilds the full-context memo asked for: a changed file's two revisions,
  // diffed in the browser so it renders already expanded (no hunks-only frame). Deduped per version
  // by the in-flight map, and dropped if the Comparison moved on. On failure fall back to the fresh
  // partial (one hunks-only frame) — or, if even that is unavailable, the prior item — so the file
  // still settles and stops being re-requested.
  const overrideSignature = overrideNeeds.map(need => `${need.path}#${need.version}`).join('|');
  useEffect(() => {
    if (overrideNeeds.length === 0) return;
    const fingerprint = fingerprintRef.current;
    for (const { path, version } of overrideNeeds) {
      if (overrideInflightRef.current.get(path) === version) continue;
      overrideInflightRef.current.set(path, version);
      void (async () => {
        const contents = await loadFile(path);
        if (overrideInflightRef.current.get(path) === version) overrideInflightRef.current.delete(path);
        if (fingerprintRef.current !== fingerprint) return;
        const file = patchRef.current?.files.find(candidate => candidate.change.path === path);
        const item = (contents === undefined ? undefined : diffItemForContents(contents))
          ?? (file === undefined ? undefined : diffItemForFile(file))
          ?? itemCacheRef.current.get(`diff:${path}`)?.item;
        if (item === undefined) return;
        setFullOverrides(current => ({ ...current, [path]: { patchVersion: version, item } }));
      })();
    }
    // overrideSignature captures which (path, version) rebuilds are outstanding
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideSignature, loadFile]);

  // the gutter "+" picks lines of a diff to ask about; it is offered only inside the diff's hunks, the
  // lines a question carries
  const startAsk = ask?.start;
  const asking = startAsk === undefined || effectiveMode === 'plain' ? {} : {
    enableGutterUtility: true,
    unsafeCSS: hunkLinesOnlyCSS,
    onGutterUtilityClick: (range: SelectedLineRange, context: { item: { id: string } }) => {
      const path = context.item.id.slice(5);
      const file = context.item.id.startsWith('diff:') ? patchRef.current?.files.find(candidate => candidate.change.path === path) : undefined;
      // a question carries its hunk, so a file whose patch was withheld (shown with Load anyway) has none to ask about
      if (file === undefined || file.capped || file.patch === '') return;
      startAsk(askLines({ changeId: path, ...orderedRange(range, file.patch) }));
      // the library commits the picked range as the selection after this callback returns
      window.setTimeout(() => setSelection(null), 0);
    }
  };
  const options = useMemo<PanelOptions>(() => ({
    ...codeViewBaseOptions(theme === 'latte' ? 'light' : 'dark', fontSize),
    ...asking,
    overflow: wrapLines ? 'wrap' : 'scroll',
    diffStyle: effectiveSplit ? 'split' : 'unified',
    // Full context expands the unchanged lines, hydrating each partial patch through loadDiffFiles.
    // Full context auto-expands every unchanged line; Hunks leaves the gaps collapsed. Either way the
    // gap ("N unmodified lines") must be expandable on click, which the library only offers when it can
    // hydrate the partial patch — so `loadDiffFiles` is always provided, not just in Full context. (It
    // is lazy: nothing is fetched until a gap is actually expanded.)
    expandUnchanged: effectiveMode === 'full',
    loadDiffFiles,
    onPostRender: rememberExpandedLines(expandedLines)
    // `asking` follows startAsk and effectiveMode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [theme, fontSize, wrapLines, effectiveSplit, effectiveMode, loadDiffFiles, expandedLines, startAsk]);

  // The topmost item and how far into it we have scrolled: the last rendered item whose top has
  // passed the viewport top.
  const currentAnchor = (): ScrollAnchor | undefined => {
    const instance = viewRef.current?.getInstance();
    const container = instance?.getContainerElement();
    if (instance === undefined || container === undefined) return undefined;
    const scrollTop = container.scrollTop;
    const tops = instance.getRenderedItems()
      .map(item => ({ id: item.id, top: instance.getTopForItem(item.id) ?? 0 }))
      .sort((a, b) => a.top - b.top);
    let top = tops[0];
    for (const candidate of tops) { if (candidate.top <= scrollTop) top = candidate; else break; }
    return top === undefined ? undefined : { id: top.id, offset: Math.max(0, scrollTop - top.top) };
  };

  // Once the all-files scroll is back, jump to the captured item and offset into it (queued if layout
  // is pending). Anchoring to the item, not a raw scrollTop, keeps the place even when item heights
  // shift, and restores exactly when — as here — the same file list returns. The scroll target's
  // offset adds space *above* the item, so scrolling `offset` px further into it takes its negative.
  useEffect(() => {
    if (selectedPath !== undefined) return;
    const anchor = anchorRef.current;
    if (anchor === undefined) return;
    anchorRef.current = undefined;
    viewRef.current?.scrollTo({ type: 'item', id: anchor.id, align: 'start', offset: -anchor.offset });
  }, [selectedPath]);

  // Back on screen after a Workspace switch: once the reloaded Comparison settles, return to the saved
  // place, or give up on it when its item is gone (or the load failed) so it cannot jump the view later.
  const plainPending = effectiveMode === 'plain' && selectedPath !== undefined && plain?.contents === undefined && plain?.error !== true;
  useEffect(() => {
    const anchor = restoreRef.current;
    if (anchor === undefined || state === 'loading' || plainPending) return;
    restoreRef.current = undefined;
    if (visibleItems.some(item => item.id === anchor.id)) viewRef.current?.scrollTo({ type: 'item', id: anchor.id, align: 'start', offset: -anchor.offset });
  }, [visibleItems, state, plainPending]);

  // Hand the view's state back as the panel unmounts, so a switch back to this Workspace restores it.
  // A layout cleanup, because the scroll position is only readable before the DOM is removed.
  const snapshot = (): CodePanelView => {
    const scroll = filePreview === undefined && restoreRef.current === undefined ? currentAnchor() : restoreRef.current;
    return { viewMode, wrapLines, railCollapsed, supportingExpanded, fileCollapse, ...(scroll === undefined ? {} : { scroll }), ...(anchorRef.current === undefined ? {} : { listAnchor: anchorRef.current }), ...(expandedLines.size === 0 ? {} : { expanded: new Map(expandedLines) }) };
  };
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  useLayoutEffect(() => () => onSaveView?.(latestSnapshot.current()), [onSaveView]);

  // explicit navigation supersedes pending image classification
  const openFile = (path: string) => {
    navigationRef.current.epoch += 1;
    // preserve the all-files scroll before selecting a file
    if (selectedPath === undefined) anchorRef.current = currentAnchor();
    setDrawerOpen(false);
    onSelectFile(path);
  };
  // returning to all files also cancels pending automatic selection
  const backToAll = () => { navigationRef.current.epoch += 1; setDrawerOpen(false); onClearFile(); };

  // classify withheld revisions without invalidating requests for unrelated edits
  const loadAnyway = async (path: string) => {
    const file = patch?.files.find(candidate => candidate.change.path === path);
    // a removed placeholder has no revision to request
    if (file === undefined) return;
    const request = { version: previewVersion(file, comparisonKey, patch?.gitBase) };
    loadRequestsRef.current.set(path, request);
    const navigation = ++navigationRef.current.epoch;
    setLoadStatus(current => ({ ...current, [path]: 'loading' }));
    const contents = await loadFile(path);
    // a superseded response cannot clear the replacement request's control
    if (loadRequestsRef.current.get(path) !== request) return;
    // release only the current request's loading control
    const complete = () => {
      loadRequestsRef.current.delete(path);
      setLoadStatus(current => { const next = { ...current }; delete next[path]; return next; });
    };
    const currentPatch = patchRef.current;
    const currentFile = currentPatch?.files.find(candidate => candidate.change.path === path);
    // reject changed revisions even before the refresh effect has pruned their ticket
    if (currentFile === undefined || previewVersion(currentFile, comparisonKeyRef.current, currentPatch?.gitBase) !== request.version) { complete(); return; }
    // select image revisions instead of trying to parse their bytes as text
    if (contents !== undefined && (contents.base?.image !== undefined || contents.working?.image !== undefined)) {
      setPreviewOverride({ version: request.version, contents });
      // never replace a selection made while these bytes were loading
      if (navigationRef.current.epoch === navigation) onSelectFile(path);
      complete();
      return;
    }
    const item = contents === undefined ? undefined : diffItemForContents(contents);
    // failed revisions retain an enabled retry until their version changes
    if (item === undefined) { setLoadStatus(current => ({ ...current, [path]: 'error' })); return; }
    setLoaded(current => ({ ...current, [path]: item }));
    complete();
  };

  // The selected line range, which the file headers' editor buttons open at (clicking a line number
  // selects it). Held here so picking lines to ask about can clear it: while a range is selected the
  // library pins the "+" to it.
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);
  // Each file header's editor button opens the working tree's copy at the selected line when one is
  // selected in that file, else at its first change (a plain file at its top). A deleted file has
  // no copy to open.
  const renderHeaderMetadata = (item: PanelItem) => {
    if (onOpenInEditor === undefined) return null;
    const range = selection?.id === item.id ? selection.range : undefined;
    if (item.type === 'file') return <EditorJumpButton file={item.id.slice(5)} line={range === undefined ? 1 : Math.min(range.start, range.end)} onOpen={onOpenInEditor} />;
    if (item.fileDiff.type === 'deleted') return null;
    return <EditorJumpButton file={item.id.slice(5)} line={diffJumpLine(item.fileDiff, range)} onOpen={onOpenInEditor} />;
  };

  const fileCount = groups.implementation.length + groups.supporting.length;
  const style = codeViewStyle(fontSize) as CSSProperties;
  // The rail is a persistent column on a wide panel unless the reviewer collapsed it; a narrow panel
  // uses the drawer instead.
  const railVisible = !narrow && !railCollapsed;
  const clampRail = (width: number) => Math.round(Math.max(RAIL_MIN_WIDTH, Math.min(panelWidth / 2, width)));
  // drag the rail's right edge, or step it with the arrow keys
  const startRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startWidth = event.currentTarget.parentElement!.getBoundingClientRect().width;
    railDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.width = clampRail(drag.startWidth + event.clientX - drag.startX);
    setRailWidth(drag.width);
  };
  const stopRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    railDragRef.current = undefined;
    if (drag.width !== drag.startWidth) saveRailWidth(drag.width);
  };
  const keyboardRailResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const width = clampRail(event.currentTarget.parentElement!.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -16 : 16));
    setRailWidth(width);
    saveRailWidth(width);
    event.preventDefault();
  };
  // The Plain-mode fetch state for the file on screen (undefined unless Plain mode shows this file).
  const plainForSelected = selectedPath !== undefined && effectiveMode === 'plain' && plain?.path === selectedPath ? plain : undefined;

  const fileList = (
    <div className="code-pane-file-list" role="tree" aria-label="Changed files">
      <FileGroup label="Implementation" changes={groups.implementation.map(file => file.change)} selectedPath={selectedPath} onSelect={openFile} />
      {groups.supporting.length > 0 && <FileGroup label="Tests &amp; docs" changes={groups.supporting.map(file => file.change)} selectedPath={selectedPath} onSelect={openFile} />}
    </div>
  );

  // A File view (a response-file row or a terminal link) takes over the whole panel as a peer of the
  // Comparison — text through the same diff library for real highlighting, an image / binary
  // placeholder / over-cap notice as plain views. It replaces the Changes layout while it is open.
  if (filePreview !== undefined) return <FileView filePreview={filePreview} options={options} style={style} expanded={expanded} onBack={onCloseFile} onClose={onClose} {...(onOpenInEditor === undefined ? {} : { onOpenInEditor })} />;

  const hasDiffs = state === 'ready' && fileCount > 0;
  // render display choices directly in the header flyout at every panel width
  const viewMenu = hasDiffs && selectedPreviewFile === undefined ? (closeMenu: () => void) => <div className="code-pane-view-menu">
    <div className="code-pane-options-group">
      <span className="code-pane-options-label">Diff mode</span>
      <span className="code-pane-segment" role="group" aria-label="Diff mode">
        <button type="button" aria-pressed={effectiveMode === 'hunks'} onClick={() => setViewMode('hunks')}>Hunks</button>
        <button type="button" aria-pressed={effectiveMode === 'full'} onClick={() => setViewMode('full')}>Full ctx</button>
        <button type="button" aria-pressed={effectiveMode === 'plain'} disabled={selectedPath === undefined} title={selectedPath === undefined ? 'Open a file for the plain view' : undefined} onClick={() => setViewMode('plain')}>Plain file</button>
      </span>
    </div>
    {!narrow && effectiveMode !== 'plain' && <div className="code-pane-options-group">
      <span className="code-pane-options-label">Diff layout</span>
      <DiffLayoutSegment split={effectiveSplit} onChange={setSplit} />
    </div>}
    {/* keep labels mounted through their forwarded click, then reveal the newly configured view */}
    {selectedPath === undefined && groups.supporting.length > 0 && <label className="code-pane-view-check" onClick={event => event.stopPropagation()}><input type="checkbox" checked={supportingExpanded} onChange={event => { setSupportingExpanded(event.target.checked); closeMenu(); }} />View docs <small>({groups.supporting.length})</small></label>}
    <label className="code-pane-view-check" onClick={event => event.stopPropagation()}><input type="checkbox" checked={wrapLines} onChange={event => { setWrapLines(event.target.checked); closeMenu(); }} />Wrap lines</label>
  </div> : undefined;
  const title = <>
    {hasDiffs && (narrow || railCollapsed) && (
      <button type="button" className="code-pane-files-open" aria-label="Show changed files" title="Files" onClick={() => { if (narrow) setDrawerOpen(true); else setRailCollapsed(false); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h10l3 3v1M4 4v15h3M7 8h10l3 3v10H7zM17 8v3h3" /></svg>
      </button>
    )}
    {/* the picker stays reachable with one file open, so switching keeps the reviewer on that file */}
    <nav className="code-pane-crumbs" aria-label="Location">
      {selectedPath !== undefined && <button type="button" className="code-pane-crumb-back" aria-label="All files" title="All files" onClick={backToAll}>‹</button>}
      <ComparisonPicker mode={mode} commit={commit} prAvailable={prAvailable} onSetMode={onSetMode} {...(loadCommits === undefined || onSelectCommit === undefined ? {} : { loadCommits, onSelectCommit })} />
      {selectedPath !== undefined && <>
        <span className="code-pane-crumb-sep" aria-hidden="true">/</span>
        <span className="code-pane-crumb-current" title={selectedPath}>{basename(selectedPath)}</span>
      </>}
    </nav>
    {!compact && selectedPath === undefined && (commit !== undefined
      ? <span className="panel-header-sub code-pane-branch" title={commit.sha}>{commit.sha.slice(0, 7)}</span>
      : branch !== undefined && <span className="panel-header-sub code-pane-branch" title={branch}>{branch}</span>)}
  </>;
  const actions = <>
    {/* a guided review covers Working or All PR, never a single commit */}
    {review !== undefined && commit === undefined && <button type="button" className={`code-pane-review${review.generating ? ' progress-border progress-peach' : ''}`} aria-busy={review.generating || undefined} disabled={review.onReview === undefined || (!review.open && (review.unavailable !== undefined || !hasDiffs))} title={review.unavailable ?? (review.generating ? 'Generating the guided review — open it to watch progress or cancel' : review.open ? 'Open the guided review' : 'Start a guided review of these changes')} onClick={() => review.onReview?.(mode)}>{review.generating && <span className="update-progress-ring" aria-hidden="true" />}{review.generating ? 'Generating…' : review.open ? 'Open Review' : 'Review'}</button>}
  </>;

  return (
    <section onAuxClickCapture={event => closeOnMiddleClick(event, onClose)} className={`code-pane${expanded ? ' expanded' : ''}`} data-wrap-lines={wrapLines ? 'true' : undefined} style={style} role="region" aria-label="Code changes" ref={panelRef} onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenu={event => codeContextMenu(event, selectionActions, [
      { id: 'working', label: 'Working changes', checked: commit === undefined && mode === 'working', onSelect: () => onSetMode('working') },
      ...(prAvailable ? [{ id: 'pr', label: 'All PR changes', checked: commit === undefined && mode === 'pr', onSelect: () => onSetMode('pr') }] : [])
    ])}>
      <PanelHeader panelKey="code" label="code panel" title={title} actions={actions} menuContent={viewMenu} close={{ key: 'close', label: 'Close code changes', title: 'Close', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
      <div className="code-pane-main">
        {state === 'ready' && fileCount > 0 && railVisible && (
          <aside className="code-pane-rail" style={railWidth === undefined ? undefined : { flexBasis: railWidth }}>
            <div className="code-pane-rail-resizer" role="separator" aria-label="Resize changed files" aria-orientation="vertical" aria-valuenow={railWidth} aria-valuemin={RAIL_MIN_WIDTH} aria-valuemax={Math.round(panelWidth / 2)} tabIndex={0} onPointerDown={startRailResize} onPointerMove={moveRailResize} onPointerUp={stopRailResize} onPointerCancel={stopRailResize} onKeyDown={keyboardRailResize} />
            <div className="code-pane-rail-head">
              <span>Files<span className="code-pane-count">{fileCount}</span></span>
              <button type="button" className="code-pane-rail-collapse" aria-label="Hide changed files" title="Hide files" onClick={() => setRailCollapsed(true)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
              </button>
            </div>
            {fileList}
          </aside>
        )}
        <div className="code-pane-body">
          {state === 'loading' && <p className="code-pane-status progress-border progress-blue" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />Loading changes…</p>}
          {state === 'error' && <p className="code-pane-status" role="alert">Unable to load changes.{onRetry !== undefined && <> <button type="button" className="code-pane-retry" onClick={onRetry}>Retry</button></>}</p>}
          {state === 'ready' && fileCount === 0 && <p className="code-pane-status">No changes to show.</p>}
          {state === 'ready' && fileCount > 0 && <>
            {missing && <p className="code-pane-status" role="alert">This file isn't part of the current changes. <button type="button" className="code-pane-retry" onClick={backToAll}>Back to all files</button></p>}
            {/* keep binary candidates outside the text diff renderer */}
            {selectedPreviewFile !== undefined ? <ComparisonFilePreview key={previewVersion(selectedPreviewFile, comparisonKey, patch?.gitBase)} path={selectedPreviewFile.change.path} loadFile={loadFile} onText={contents => setPreviewOverride({ version: previewVersion(selectedPreviewFile, comparisonKey, patch?.gitBase), contents })} initialContents={previewOverride?.version === previewVersion(selectedPreviewFile, comparisonKey, patch?.gitBase) ? previewOverride.contents : undefined} options={options} onOpenInEditor={onOpenInEditor} /> : <>
            {plainForSelected !== undefined && plainForSelected.contents === undefined && plainForSelected.error !== true && <p className="code-pane-status progress-border progress-blue" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />Loading file…</p>}
            {plainForSelected?.error === true && <p className="code-pane-status" role="alert">Unable to load this file.</p>}
            {selectedPath === undefined && patch?.truncated === true && <p className="code-pane-notice">Some files were left out because the change set is very large.</p>}
            {placeholders.length > 0 && (
              <ul className="code-pane-placeholders">
                {placeholders.map(placeholder => (
                  <li key={placeholder.path} className={`code-pane-placeholder ${placeholder.reason}`}>
                    <span className="code-pane-placeholder-path" title={placeholder.path}>{placeholder.path}</span>
                    <span className="code-pane-placeholder-note">
                      {placeholder.reason === 'capped' && 'File too large to preview'}
                      {placeholder.reason === 'binary' && 'Binary file'}
                      {placeholder.reason === 'metadata' && (placeholder.note ?? 'Not a regular file')}
                      {placeholder.reason === 'unrenderable' && 'Diff unavailable'}
                    </span>
                    {/* open raster candidates without requesting every file up front */}
                    {(placeholder.reason === 'binary' || (placeholder.reason !== 'metadata' && isImagePath(placeholder.path))) && <button type="button" className="code-pane-load" aria-label={`Preview ${placeholder.path}`} onClick={() => openFile(placeholder.path)}>Preview</button>}
                    {/* retain the inline text load action for other withheld files */}
                    {placeholder.reason !== 'binary' && !isImagePath(placeholder.path) && (placeholder.reason === 'capped' || placeholder.reason === 'unrenderable') && (
                      loadStatus[placeholder.path] === 'error'
                        ? <span className="code-pane-placeholder-error">Could not load</span>
                        : <button type="button" className={`code-pane-load${loadStatus[placeholder.path] === 'loading' ? ' progress-border progress-blue' : ''}`} aria-busy={loadStatus[placeholder.path] === 'loading' || undefined} disabled={loadStatus[placeholder.path] === 'loading'} onClick={() => void loadAnyway(placeholder.path)}>{loadStatus[placeholder.path] === 'loading' && <span className="update-progress-ring" aria-hidden="true" />}{loadStatus[placeholder.path] === 'loading' ? 'Loading…' : 'Load anyway'}</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* add one disclosure control to each diff header */}
            <CodeView ref={viewRef} className="code-pane-view" options={options} items={visibleItems} renderHeaderPrefix={item => item.type === 'diff' ? <button type="button" className="code-pane-file-collapse" aria-label={`${item.collapsed ? 'Expand' : 'Collapse'} ${item.fileDiff.name}`} aria-expanded={!item.collapsed} title={item.collapsed ? 'Expand file' : 'Collapse file'} onClick={() => toggleFileCollapse(item.id.slice(5))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button> : null} {...(onOpenInEditor === undefined ? {} : { renderHeaderMetadata })} renderAnnotation={annotation => annotation.metadata === undefined ? null : ask?.threadFor(annotation.metadata.askId) ?? null} selectedLines={selection} onSelectedLinesChange={setSelection} disableWorkerPool />
            </>}
          </>}
        </div>
        {narrow && drawerOpen && state === 'ready' && fileCount > 0 && (
          <>
          <button type="button" className="code-pane-drawer-backdrop" aria-label="Close changed files" onClick={() => setDrawerOpen(false)} />
          <div className="code-pane-drawer" role="dialog" aria-label="Changed files" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDrawerOpen(false); } }}>
            <div className="code-pane-drawer-head">
              <span>Files<span className="code-pane-count">{fileCount}</span></span>
              <button type="button" className="code-pane-close" aria-label="Close changed files" title="Close" onClick={() => setDrawerOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            {fileList}
          </div>
          </>
        )}
      </div>
    </section>
  );
}

// decode raster bytes only in an image element and report corrupt data accessibly
function RasterImage({ image, label }: { image: PreviewImage; label: string }) {
  const source = `data:${image.mediaType};base64,${image.base64}`;
  const [failed, setFailed] = useState<string>();
  // a failed previous image must not hide a newer response
  if (failed === source) return <p className="code-pane-status" role="alert">Unable to display this image.</p>;
  return <img src={source} alt={label} onError={() => setFailed(source)} />;
}

// render each revision independently when a change crosses media types
function ImageRevision({ revision, side, options, onOpenInEditor }: { revision: RevisionFile; side: string; options: PanelOptions; onOpenInEditor?: (target: EditorTarget) => void }) {
  // bounded source keeps the established highlighted file renderer
  const items = useMemo<PanelItem[]>(() => !revision.binary && revision.content !== undefined ? [fileItemForContents(revision.path, revision.content)] : [], [revision]);
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);
  return <figure className="code-pane-image-revision">
    <figcaption><strong>{side}</strong><span title={revision.path}>{revision.path}</span>
      {/* only the working source opens the current file, at its selected line */}
      {side === 'After' && !revision.binary && onOpenInEditor !== undefined && <EditorJumpButton file={revision.path} line={selection === null ? 1 : Math.min(selection.range.start, selection.range.end)} onOpen={onOpenInEditor} />}
    </figcaption>
    {/* text and raster sides do not determine each other's renderer */}
    {!revision.binary ? <div className="code-pane-revision-text">
      {/* unavailable text stays explicit rather than becoming an empty code view */}
      {revision.content === undefined ? <p className="code-pane-status">Text preview unavailable.</p> : <CodeView className="code-pane-view" options={options} items={items} onSelectedLinesChange={setSelection} disableWorkerPool />}
      {/* comparison text retains its separate two-mib cap */}
      {revision.truncated && <footer className="code-pane-file-truncated">Preview limited to the first 2 MiB.</footer>}
    </div> : <div className="code-pane-file-image">
      {/* render complete bytes or explain why this revision has no image */}
      {revision.image !== undefined ? <RasterImage image={revision.image} label={`${side}: ${revision.path}`} /> : <p className="code-pane-status">{isImagePath(revision.path) && revision.size > previewImageByteLimit ? 'Image exceeds the 5 MiB preview limit.' : 'Binary file — no image preview available.'}</p>}
    </div>}
  </figure>;
}

// request only the selected comparison and discard results after navigation or refresh
function ComparisonFilePreview({ path, loadFile, onText, initialContents, options, onOpenInEditor }: { path: string; loadFile: CodePanelProps['loadFile']; onText: (contents: ComparisonFileContents) => void; initialContents: ComparisonFileContents | undefined; options: PanelOptions; onOpenInEditor?: (target: EditorTarget) => void }) {
  const [result, setResult] = useState<{ state: 'loading' } | { state: 'error' } | { state: 'ready'; contents: ComparisonFileContents }>(() => initialContents === undefined ? { state: 'loading' } : { state: 'ready', contents: initialContents });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // the all-files action may have already fetched this exact revision
    if (initialContents !== undefined && attempt === 0) return;
    let cancelled = false;
    setResult({ state: 'loading' });
    // isolate failures from text diff state
    void (async () => {
      try {
        const contents = await loadFile(path);
        // a remounted revision owns its own result
        if (!cancelled) setResult(contents === undefined ? { state: 'error' } : { state: 'ready', contents });
      } catch {
        // transport failures leave a retryable view
        if (!cancelled) setResult({ state: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [path, loadFile, attempt, initialContents]);
  // hand ordinary text back to the primary renderer after classification
  useEffect(() => {
    // image and metadata responses stay in this non-text view
    if (result.state === 'ready' && isTextComparison(result.contents)) onText(result.contents);
  }, [result, onText]);
  // keep loading and retry feedback inside the selected file
  if (result.state === 'loading') return <p className="code-pane-status progress-border progress-blue" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />Loading image…</p>;
  // failed requests never fall through to broken image elements
  if (result.state === 'error') return <p className="code-pane-status" role="alert">Unable to load image preview. <button type="button" className="code-pane-retry" onClick={() => setAttempt(current => current + 1)}>Retry</button></p>;
  const { base, working } = result.contents;
  // wait one commit for the existing text renderer to take over
  if (isTextComparison(result.contents)) return <p className="code-pane-status" role="status">Loading file…</p>;
  return <div className="code-pane-image-comparison" aria-label={`Image changes: ${path}`} role="group">
    {/* retain only revisions that actually existed */}
    {base !== null && <ImageRevision revision={base} side="Before" options={options} />}
    {working !== null && <ImageRevision revision={working} side="After" options={options} onOpenInEditor={onOpenInEditor} />}
    {/* distinguish additions and deletions from a failed preview */}
    {base === null && working !== null && <p className="code-pane-image-note">File added</p>}
    {working === null && base !== null && <p className="code-pane-image-note">File deleted</p>}
    {/* handle a file removed from both sides during the request */}
    {base === null && working === null && <p className="code-pane-status">Image preview unavailable.</p>}
  </div>;
}

// The header's Comparison picker: the shown Comparison's name ▾, whose menu switches between Working,
// All PR, and any one commit of the branch (listed fresh each time the menu opens).
function ComparisonPicker({ mode, commit, prAvailable, onSetMode, loadCommits, onSelectCommit }: { mode: CodePanelMode; commit: CodePanelCommit | undefined; prAvailable: boolean; onSetMode: (mode: CodePanelMode) => void; loadCommits?: () => Promise<CodePanelCommit[] | undefined>; onSelectCommit?: (commit: CodePanelCommit) => void }) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<CodePanelCommit[] | 'loading' | 'error'>('loading');
  const { anchorRef, flyoutRef, style } = useViewportFlyout(open, { align: 'start' });
  // commits exist only relative to a merge target
  const listCommits = prAvailable && loadCommits !== undefined && onSelectCommit !== undefined;
  useEffect(() => {
    if (!open || !listCommits) return;
    let cancelled = false;
    setCommits('loading');
    void loadCommits().then(next => { if (!cancelled) setCommits(next ?? 'error'); });
    return () => { cancelled = true; };
  }, [open, listCommits, loadCommits]);
  const choose = (select: () => void) => { setOpen(false); select(); };
  const label = commit !== undefined ? commit.subject : mode === 'working' ? 'Working changes' : 'All PR changes';
  return <><span className="code-pane-picker-wrap" ref={anchorRef}><button type="button" className="code-pane-picker" aria-haspopup="menu" data-context-flyout aria-expanded={open} title={label} onClick={() => setOpen(value => !value)}>
    <span className="code-pane-title">{label}</span>
    <svg className="agent-switcher-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  </button></span>{open && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="more-menu flyout-menu code-pane-picker-menu" ref={flyoutRef} style={style} role="menu" aria-label="Comparison">
    <button type="button" role="menuitemradio" aria-checked={commit === undefined && mode === 'working'} onClick={() => choose(() => onSetMode('working'))}>Working changes</button>
    <button type="button" role="menuitemradio" aria-checked={commit === undefined && mode === 'pr'} disabled={!prAvailable} title={prAvailable ? 'Compare the whole PR' : 'Merge target unavailable'} onClick={() => choose(() => onSetMode('pr'))}>All PR changes</button>
    {listCommits && <>
      <p className="code-pane-picker-label">Commits</p>
      {commits === 'loading' && <p className="code-pane-picker-note" role="status">Loading commits…</p>}
      {commits === 'error' && <p className="code-pane-picker-note" role="alert">Commits unavailable</p>}
      {Array.isArray(commits) && commits.length === 0 && <p className="code-pane-picker-note">No commits yet</p>}
      {Array.isArray(commits) && commits.map(entry => <button key={entry.sha} type="button" role="menuitemradio" aria-checked={entry.sha === commit?.sha} className="code-pane-picker-commit" title={entry.subject} onClick={() => choose(() => onSelectCommit(entry))}><span>{entry.subject}</span><code>{entry.sha.slice(0, 7)}</code></button>)}
    </>}
  </div></FlyoutPortal>}</>;
}

// The panel's File view: one file opened from a response-file row or a terminal link, filling the
// panel as a peer of the Comparison. A text file renders through the same diff library (a
// `{type:'file'}` item) so it gets real syntax highlighting; an image (including the agent `/tmp`
// screenshot bridge), a binary file, and the over-cap truncation notice are plain non-library views.
// the back action returns to the source panel or comparison
function FileView({ filePreview, options, style, expanded, onBack, onClose, onOpenInEditor }: { filePreview: FilePreviewView; options: PanelOptions; style: CSSProperties; expanded: boolean; onBack: () => void; onClose: () => void; onOpenInEditor?: (target: EditorTarget) => void }) {
  const selectionActions = useSelectionActions();
  const { path, state, preview } = filePreview;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [path]);
  const copyPath = async () => {
    try { await copyToClipboard(path); setCopied(true); } catch { setCopied(false); }
  };
  // a text file becomes a single plain-file item; an image or binary file renders without the library
  const items = useMemo<PanelItem[]>(() => state === 'ready' && preview !== undefined && !preview.binary ? [fileItemForContents(path, preview.content)] : [], [state, preview, path]);
  // the header's editor button opens the selected line, else the top; only a path inside the Place
  // can be opened (a response file may name one elsewhere, such as a `/tmp` screenshot)
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);
  const backLabel = filePreview.source === 'settings' ? 'Settings' : filePreview.source === 'files' ? 'Files' : 'Changes';
  const renderHeaderMetadata = () => {
    // keep redacted settings snapshots read only
    if (filePreview.source === 'settings' || onOpenInEditor === undefined || !isPlaceRelativePath(path)) return null;
    return <EditorJumpButton file={path} line={selection === null ? 1 : Math.min(selection.range.start, selection.range.end)} onOpen={onOpenInEditor} />;
  };
  return (
    <section onAuxClickCapture={event => closeOnMiddleClick(event, onClose)} className={`code-pane code-pane-file${expanded ? ' expanded' : ''}`} style={style} role="region" aria-label="Code changes" onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenu={event => codeContextMenu(event, selectionActions)}>
      <PanelHeader panelKey="code" label="code panel" title={<nav className="code-pane-crumbs" aria-label="Location">
          <button type="button" className="code-pane-crumb-back" onClick={onBack}>‹ {backLabel}</button>
          <span className="code-pane-crumb-sep" aria-hidden="true">/</span>
          <span className="code-pane-crumb-current" title={path}>{basename(path)}</span>
        </nav>}
        secondary={[{ key: 'copy-path', label: copied ? 'Path copied' : 'Copy path', className: copied ? 'copied' : undefined, icon: <PanelIcon path={copied ? panelIcons.check : panelIcons.copy} />, onSelect: () => void copyPath() }]}
        close={{ key: 'close', label: 'Close file', title: 'Close', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
      <div className="code-pane-main">
        <div className="code-pane-body">
          {state === 'loading' && <p className="code-pane-status progress-border progress-blue" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />Loading file…</p>}
          {state === 'error' && <p className="code-pane-status" role="alert">Preview unavailable.</p>}
          {state === 'ready' && preview !== undefined && <>
            {/* inline only complete supported images */}
            {preview.binary && preview.image !== undefined && <div className="code-pane-file-image"><RasterImage image={preview.image} label={`Preview of ${path}`} /></div>}
            {/* keep unsupported and oversized binaries readable as metadata */}
            {preview.binary && preview.image === undefined && <p className="code-pane-status">{isImagePath(path) && preview.size > previewImageByteLimit ? 'Image exceeds the 5 MiB preview limit.' : 'Binary file — no preview available.'}</p>}
            {/* ordinary source remains highlighted code */}
            {!preview.binary && <CodeView className="code-pane-view" options={options} items={items} {...(onOpenInEditor === undefined ? {} : { renderHeaderMetadata })} onSelectedLinesChange={setSelection} disableWorkerPool />}
            {/* the text cap does not describe metadata-only image fallbacks */}
            {!preview.binary && preview.truncated && <footer className="code-pane-file-truncated">Preview limited to the first 256 KB.</footer>}
          </>}
        </div>
      </div>
    </section>
  );
}

// One grouped section of the changed-file rail/drawer: a header with the count, then a clickable row
// per Change that filters the panel to that file (highlighting the active one).
// use git's two-character status, preferring conflict/deletion over other staged changes
const changeStatus = (code: string): string => {
  // conflicted pairs outrank their individual add/delete letters
  if (/^(?:DD|AU|UD|UA|DU|AA|UU)$/u.test(code) || code.includes('U')) return 'conflicted';
  // deletions use the removal color
  if (code.includes('D')) return 'deleted';
  // untracked and added files share the addition color
  if (code.includes('A') || code.includes('?')) return 'added';
  // renames remain distinct from edited files
  if (code.includes('R')) return 'renamed';
  return 'modified';
};

function FileGroup({ label, changes, selectedPath, onSelect }: { label: string; changes: ComparisonChange[]; selectedPath: string | undefined; onSelect: (path: string) => void }) {
  // empty categories do not need a heading
  if (changes.length === 0) return null;
  return (
    <div className="code-pane-file-group" role="group" aria-label={label}>
      <div className="code-pane-file-group-head">{label}</div>
      {/* show each file's git status and available line totals in the shared rail/drawer */}
      {changes.map(change => (
        <button
          key={change.path}
          type="button"
          className={`code-pane-file-row${change.path === selectedPath ? ' active' : ''}`}
          aria-current={change.path === selectedPath}
          title={change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}
          onClick={() => onSelect(change.path)}
        >
          <span className={`code-pane-file-code status-${changeStatus(change.code)}`} aria-hidden="true">{change.code.trim() || '·'}</span>
          <span className="code-pane-file-name">{basename(change.path)}</span>
          {(change.additions !== undefined || change.deletions !== undefined) && <span className="code-pane-file-lines" aria-label={`${change.additions ?? 0} lines added, ${change.deletions ?? 0} lines deleted`}><span className="added">+{change.additions ?? 0}</span><span className="deleted">−{change.deletions ?? 0}</span></span>}
        </button>
      ))}
    </div>
  );
}
