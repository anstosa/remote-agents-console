// The Review tour's diff renderer: the Changes of one tour step rendered with `@pierre/diffs`, the
// same library and theming the Code panel uses, so a guided review reads with the same fidelity as
// the standalone panel (real syntax highlighting, line numbers, unified or — with room — split
// diffs). It is a second importer of the library, so — like code-panel.tsx — it is only ever reached
// through a dynamic `import()` (review-tour.tsx lazy-loads it); review-tour.tsx itself is in the
// eager dashboard bundle, so importing the library here directly would drag its ~177 kB in. Controlled:
// the caller hands in the step's Changes, its inline comments and the AI review's suggested comments,
// and this renders them, reporting comment edits and suggestion triage back — including which comments
// are open, which the caller holds so Escape can close them from anywhere in the dialog. The only state it owns is visual: the Unified / Split choice,
// which (rendered at the same spot for every step) carries across steps. The caller also keeps the scroll
// position, handed back on mount so a remounted step returns to where it was read.
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeViewLineSelection, DiffLineAnnotation, FileDiffLoadedChangedFiles, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useColorTheme } from '../color-theme.js';
import { useTerminalFontSize } from '../terminal-font-size.js';
import { DiffLayoutSegment, SPLIT_MIN_WIDTH, useDiffSplit, useObservedWidth } from './diff-layout.js';
import { diffJumpLine, EditorJumpButton, type EditorTarget } from './editor-jump.js';
import { codeViewBaseOptions, codeViewStyle, contentHash, diffItemForPatch, rememberExpandedLines } from './items.js';
import type { ExpandedLines } from './comparison.js';
import { patchRowIndex, patchRows } from './patch-rows.js';

// an annotation is either an inline comment or a suggested comment (an untriaged or dismissed Finding)
export type CommentAnchor = { commentId: string } | { suggestionId: string };
type ReviewItem = CodeViewItem<CommentAnchor>;
type ReviewOptions = CodeViewReactOptions<CommentAnchor, undefined>;

// One Change of a tour step: the file it touches (and, for a rename, where it moved from), the kind
// of change, and its captured unified patch. A structural subset of the tour's ReviewChange — the
// kind union is kept intact so the `kind === 'binary'` placeholder note stays typo-checked.
export type ReviewDiffChange = { id: string; file: string; originalFile?: string; kind: 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked'; patch: string };

// Which side of a diff a line number counts on: the base (deletions) or the change (additions).
export type ReviewDiffSide = 'deletions' | 'additions';

// An inline comment on a line range of one Change. The range runs from (startSide, startLine) to
// (endSide, endLine) — in a unified diff a range can begin on a removed line and end on an added
// one — and the comment renders under its last line.
export type ReviewDiffComment = { id: string; changeId: string; startSide: ReviewDiffSide; startLine: number; endSide: ReviewDiffSide; endLine: number; body: string };

// A suggested comment: one AI review Finding on a line range of one Change (`side` and the lines
// follow ReviewDiffComment's), with the `source` line naming the review that wrote it. A dismissed one
// collapses to a row that can restore it.
export type ReviewDiffSuggestion = { id: string; changeId: string; side: ReviewDiffSide; startLine: number; endLine: number; severity: 'high' | 'medium' | 'low'; title: string; body: string; source: string; dismissed: boolean };

// The longest one inline comment may grow; the caller enforces the shared aggregate cap on top.
export const MAX_INLINE_COMMENT = 4_000;

type ReviewDiffsProps = {
  changes: ReviewDiffChange[];
  comments: ReviewDiffComment[];
  // the comments showing their editor: each new one, and saved ones reopened with Edit
  openCommentIds: ReadonlySet<string>;
  // add a comment, already open
  onCommentAdd: (comment: ReviewDiffComment) => void;
  onCommentChange: (id: string, body: string) => void;
  onCommentOpen: (id: string) => void;
  // close an editor (Done), which discards a comment left empty
  onCommentClose: (id: string) => void;
  onCommentDelete: (id: string) => void;
  // the step's suggested comments and their triage: Keep turns one into an inline comment
  suggestions?: ReviewDiffSuggestion[];
  onSuggestionKeep?: (id: string) => void;
  onSuggestionDismiss?: (id: string) => void;
  onSuggestionRestore?: (id: string) => void;
  // what shows under a comment or an untriaged suggestion: its Ask thread, when it has one
  threadFor?: (anchor: CommentAnchor) => ReactNode;
  // open a file at a line in the configured editor; the header button is hidden without it
  onOpenInEditor?: (target: EditorTarget) => void;
  // the working tree's text of a file, which lets the unchanged lines between hunks expand
  loadFile?: (path: string) => Promise<string | undefined>;
  // a file's unchanged lines could not expand, and why
  onExpandError?: (file: string, detail: string) => void;
  // where the diffs were scrolled to when this step was last on screen, returned to on mount; `onScroll`
  // reports each move
  scrollTop?: number;
  onScroll?: (scrollTop: number) => void;
  // the hidden lines expanded in the step's diffs, which this updates in place and expands again on mount
  expandedLines: ExpandedLines;
};

// One hunk of a file view: its Change, its range on each side of the base diff, and where its old
// side starts in the view's old file.
type ViewHunk = { changeId: string; oldStart: number; oldLines: number; newStart: number; newLines: number; viewOldStart: number; tail: string; body: string[] };
// A step's hunks of one file shown as one diff. Its old side is the working file with only these
// hunks undone, so expanding the gaps between them shows the file's current lines, other steps'
// changes included, as unchanged context. Old-side numbers count on that file rather than the base,
// so `changeLine` and `viewLine` translate them. A file that is one non-hunk Change (an untracked
// file) is shown as is.
type FileView = { file: string; patch: string; hunks: ViewHunk[]; changeId?: string };

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;
// where a hunk's lines sit as a zero-based index; an empty side's start names the line before it
const sideIndex = (start: number, count: number): number => count === 0 ? start : start - 1;
const inRange = (line: number, start: number, count: number): boolean => line >= start && line < start + count;

// join a step's Changes of one file into one patch, renumbering each hunk's old side for the view
const fileView = (changes: ReviewDiffChange[]): FileView => {
  const [first] = changes as [ReviewDiffChange, ...ReviewDiffChange[]];
  let header: string[] = [];
  const hunks = changes.flatMap((change): ViewHunk[] => {
    const lines = change.patch.split('\n');
    const index = lines.findIndex(line => line.startsWith('@@'));
    const match = index < 0 ? null : hunkHeader.exec(lines[index]!);
    if (match === null) return [];
    header = lines.slice(0, index);
    const body = lines.slice(index + 1);
    while (body.at(-1) === '') body.pop();
    return [{ changeId: change.id, oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), viewOldStart: 0, tail: match[5] ?? '', body }];
  }).sort((a, b) => a.newStart - b.newStart);
  if (first.kind !== 'hunk' || hunks.length !== changes.length) return { file: first.file, patch: first.patch, hunks: [], changeId: first.id };
  // undoing the hunks above moves a hunk's old side by their difference in length
  let shift = 0;
  for (const hunk of hunks) {
    const at = sideIndex(hunk.newStart, hunk.newLines) + shift;
    hunk.viewOldStart = hunk.oldLines === 0 ? at : at + 1;
    shift += hunk.oldLines - hunk.newLines;
  }
  const body = hunks.flatMap(hunk => [`@@ -${hunk.viewOldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.tail}`, ...hunk.body]);
  return { file: first.file, patch: `${[...header, ...body].join('\n')}\n`, hunks };
};

// The Change and base line a view line stands for, or undefined for an expanded line outside the
// step's hunks, which takes no comment. New-side numbers are the working tree's on both.
const changeLine = (view: FileView, side: ReviewDiffSide, line: number): { changeId: string; line: number } | undefined => {
  if (view.changeId !== undefined) return { changeId: view.changeId, line };
  const hunk = view.hunks.find(candidate => side === 'additions' ? inRange(line, candidate.newStart, candidate.newLines) : inRange(line, candidate.viewOldStart, candidate.oldLines));
  return hunk && { changeId: hunk.changeId, line: side === 'additions' ? line : line - hunk.viewOldStart + hunk.oldStart };
};

// where a Change's base line sits in the view
const viewLine = (view: FileView, changeId: string, side: ReviewDiffSide, line: number): number => {
  const hunk = side === 'deletions' ? view.hunks.find(candidate => candidate.changeId === changeId) : undefined;
  return hunk === undefined ? line : line - hunk.oldStart + hunk.viewOldStart;
};

// The view's two files from the working tree's text: the old one undoes each hunk, after checking
// the text still holds the hunk's new lines, so a file changed since the tour was made stays
// collapsed (undefined) rather than showing the wrong lines.
const viewFiles = (view: FileView, fileDiff: FileDiffMetadata, working: string): FileDiffLoadedChangedFiles | undefined => {
  const lines = working.split('\n');
  const newline = lines.at(-1) === '';
  if (newline) lines.pop();
  let oldNewline = newline;
  const last = view.hunks.at(-1);
  if (last !== undefined && sideIndex(last.newStart, last.newLines) + last.newLines === lines.length) oldNewline = !last.body.some((text, index) => text.startsWith('\\') && /^[ -]/u.test(last.body[index - 1] ?? ''));
  for (const hunk of [...view.hunks].reverse()) {
    const at = sideIndex(hunk.newStart, hunk.newLines);
    const newSide = hunk.body.filter(text => text.startsWith(' ') || text.startsWith('+')).map(text => text.slice(1));
    if (newSide.length !== hunk.newLines || newSide.some((text, index) => lines[at + index] !== text)) return undefined;
    lines.splice(at, hunk.newLines, ...hunk.body.filter(text => text.startsWith(' ') || text.startsWith('-')).map(text => text.slice(1)));
  }
  const old = lines.length > 0 && oldNewline ? `${lines.join('\n')}\n` : lines.join('\n');
  return {
    oldFile: { name: fileDiff.prevName ?? fileDiff.name, contents: old, cacheKey: `tour-old:${fileDiff.name}#${contentHash(old)}` },
    newFile: { name: fileDiff.name, contents: working, cacheKey: `tour-new:${fileDiff.name}#${contentHash(working)}` }
  };
};

// The comment "+" is offered only on the step's own lines: an expanded unchanged line may lie
// outside the pull request's diff, where a review comment cannot be posted.
const reviewCSS = '[data-line-type="context-expanded"] [data-gutter-utility-slot] { display: none; }';

// how a label names a side: the base's old lines or the change's new ones
const sideWord = (side: ReviewDiffSide): string => side === 'deletions' ? 'old' : 'new';

// A human label for a comment's line range, e.g. "Line 12", "Lines 12–14", or across sides, top to
// bottom, "Lines old 9 – new 11" or "Lines new 5 – old 7".
export const commentRangeLabel = (comment: Pick<ReviewDiffComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'>): string => {
  if (comment.startSide !== comment.endSide) return `Lines ${sideWord(comment.startSide)} ${comment.startLine} – ${sideWord(comment.endSide)} ${comment.endLine}`;
  return comment.startLine === comment.endLine ? `Line ${comment.startLine}` : `Lines ${comment.startLine}–${comment.endLine}`;
};

// Order a picked range top-to-bottom. Within one side line numbers order it; across sides (unified
// view only) the two ends' rows in the rendered patch do, since an added block can sit above a later
// removed one. An end the patch does not hold falls back to deletions first.
const orderedRange = (range: SelectedLineRange, patch: string): Pick<ReviewDiffComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'> => {
  const startSide = range.side ?? range.endSide ?? 'additions';
  const endSide = range.endSide ?? startSide;
  if (startSide === endSide) return { startSide, startLine: Math.min(range.start, range.end), endSide, endLine: Math.max(range.start, range.end) };
  const rows = patchRows(patch);
  const startRow = patchRowIndex(rows, startSide, range.start);
  const endRow = patchRowIndex(rows, endSide, range.end);
  const inOrder = startRow < 0 || endRow < 0 ? startSide === 'deletions' : startRow <= endRow;
  return inOrder ? { startSide, startLine: range.start, endSide, endLine: range.end } : { startSide: endSide, startLine: range.end, endSide: startSide, endLine: range.start };
};

// One inline comment: an editor while it is new or reopened, and the saved text otherwise.
function InlineComment({ comment, editing, onEdit, onChange, onDone, onDelete }: { comment: ReviewDiffComment; editing: boolean; onEdit: () => void; onChange: (body: string) => void; onDone: () => void; onDelete: () => void }) {
  const label = commentRangeLabel(comment);
  return (
    <div className="review-tour-inline-comment">
      <small>{label}</small>
      {editing
        ? <>
          <textarea aria-label={`Comment on ${label.toLowerCase()}`} value={comment.body} maxLength={MAX_INLINE_COMMENT} autoFocus onChange={event => onChange(event.target.value)} />
          {comment.body.length >= MAX_INLINE_COMMENT && <span role="status">{MAX_INLINE_COMMENT.toLocaleString()} character limit reached</span>}
          <div><button type="button" onClick={onDelete}>Delete</button><button type="button" onClick={onDone}>Done</button></div>
        </>
        : <>
          <p>{comment.body}</p>
          <div><button type="button" onClick={onDelete}>Delete</button><button type="button" onClick={onEdit}>Edit</button></div>
        </>}
    </div>
  );
}

// One suggested comment: its severity, title, body and source with Keep and Dismiss, or, dismissed,
// one row that restores it.
function SuggestedComment({ suggestion, onKeep, onDismiss, onRestore }: { suggestion: ReviewDiffSuggestion; onKeep: () => void; onDismiss: () => void; onRestore: () => void }) {
  if (suggestion.dismissed) return <div className="review-tour-suggestion dismissed" role="group" aria-label={`Dismissed suggestion: ${suggestion.title}`}><span>Dismissed · {suggestion.title}</span><button type="button" onClick={onRestore}>Restore</button></div>;
  return (
    <div className="review-tour-suggestion" role="group" aria-label={`Suggested comment: ${suggestion.title}`}>
      <div className="review-tour-suggestion-title"><span className={`review-tour-severity ${suggestion.severity}`}>{suggestion.severity}</span><strong>{suggestion.title}</strong></div>
      {suggestion.body.trim() !== '' && <p>{suggestion.body}</p>}
      <small>{commentRangeLabel({ startSide: suggestion.side, startLine: suggestion.startLine, endSide: suggestion.side, endLine: suggestion.endLine })} · {suggestion.source}</small>
      <div><button type="button" onClick={onDismiss}>Dismiss</button><button type="button" onClick={onKeep}>Keep</button></div>
    </div>
  );
}

// render one tour step with current display settings
export default function ReviewDiffs({ changes, comments, openCommentIds, onCommentAdd, onCommentChange, onCommentOpen, onCommentClose, onCommentDelete, suggestions = [], onSuggestionKeep, onSuggestionDismiss, onSuggestionRestore, threadFor, onOpenInEditor, loadFile, onExpandError, scrollTop, onScroll, expandedLines }: ReviewDiffsProps) {
  const theme = useColorTheme();
  const codeView = useRef<CodeViewHandle<CommentAnchor, undefined>>(null);
  const initialScrollTop = useRef(scrollTop);
  const terminalFontSize = useTerminalFontSize();
  // The step's hunk Changes of one file become one diff item, keyed by their Change ids; any other
  // Change is an item of its own. One whose patch is not a diff the parser can recover (a binary
  // file, a metadata-only change) falls back to a placeholder.
  const { baseItems, placeholders } = useMemo(() => {
    const files = new Map<string, ReviewDiffChange[]>();
    for (const change of changes) {
      const key = change.kind === 'hunk' ? `${change.originalFile ?? ''}\0${change.file}` : change.id;
      files.set(key, [...files.get(key) ?? [], change]);
    }
    const baseItems = new Map<string, { item: NonNullable<ReturnType<typeof diffItemForPatch>>; view: FileView }>();
    const placeholders: ReviewDiffChange[] = [];
    for (const group of files.values()) {
      const view = fileView(group);
      const item = diffItemForPatch(group.map(change => change.id).join('+'), view.patch);
      if (item === undefined) placeholders.push(...group); else baseItems.set(item.id, { item, view });
    }
    return { baseItems, placeholders };
  }, [changes]);

  // Each comment, and each suggested comment, anchors one annotation under its last line. CodeView only
  // re-reads an item when its version moves, so an item's version folds in where its annotations sit —
  // and only that, so typing into a comment (which changes no anchor) never re-lays out the diff.
  const anchorKey = [...comments.map(comment => `${comment.id}@${comment.changeId}:${comment.endSide}:${comment.endLine}`), ...suggestions.map(suggestion => `${suggestion.id}@${suggestion.changeId}:${suggestion.side}:${suggestion.endLine}`)].join('|');
  const items = useMemo(() => [...baseItems.values()].map(({ item, view }): ReviewItem => {
    const inView = (changeId: string) => view.changeId === changeId || view.hunks.some(hunk => hunk.changeId === changeId);
    const annotations: DiffLineAnnotation<CommentAnchor>[] = [
      ...suggestions.filter(suggestion => inView(suggestion.changeId)).map(suggestion => ({ side: suggestion.side, lineNumber: viewLine(view, suggestion.changeId, suggestion.side, suggestion.endLine), metadata: { suggestionId: suggestion.id } })),
      ...comments.filter(comment => inView(comment.changeId)).map(comment => ({ side: comment.endSide, lineNumber: viewLine(view, comment.changeId, comment.endSide, comment.endLine), metadata: { commentId: comment.id } }))
    ];
    if (annotations.length === 0) return item as ReviewItem;
    return { ...item, annotations, version: contentHash(`${item.version}|${annotations.map(annotation => `${'commentId' in annotation.metadata ? annotation.metadata.commentId : annotation.metadata.suggestionId}:${annotation.side}:${annotation.lineNumber}`).join('|')}`) };
  }), [baseItems, anchorKey]); // anchorKey stands in for `comments` and `suggestions`: it covers every field read here
  const viewByDiff = useMemo(() => new Map([...baseItems.values()].map(({ item, view }) => [item.fileDiff, view])), [baseItems]);
  const patchByChangeId = useMemo(() => new Map(changes.map(change => [change.id, change.patch])), [changes]);

  // Return to where the step was last read, once on mount. The library holds the target until layout
  // can reach it. It is an offset from the first item's top because a `position` target lands short by
  // the sticky file header.
  useEffect(() => {
    const first = items[0];
    const top = first === undefined ? undefined : codeView.current?.getInstance()?.getTopForItem(first.id);
    const restore = initialScrollTop.current ?? 0;
    if (restore > 0 && first !== undefined && top !== undefined) codeView.current?.scrollTo({ type: 'item', id: first.id, align: 'start', offset: top - restore });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The selected line range, held here so starting a comment can clear it: while a range is selected
  // the library pins the "+" to it, so a stale selection would steal the next comment's placement.
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);

  // Split follows the Code panel's rule: offered only when the diff pane itself is wide enough, so a
  // phone or a narrow dialog always reads unified.
  const [split, setSplit] = useDiffSplit();
  const [viewRef, viewWidth] = useObservedWidth();
  const splitFits = viewWidth >= SPLIT_MIN_WIDTH;
  const effectiveSplit = split && splitFits;

  // Expanding a gap fetches the file once and swaps in the view's two files. A failure is reported,
  // then thrown so the library leaves the gap collapsed.
  const loadDiffFiles = useCallback(async (fileDiff: FileDiffMetadata) => {
    const view = viewByDiff.get(fileDiff);
    const working = view === undefined ? undefined : await loadFile?.(fileDiff.name);
    const files = view === undefined || working === undefined ? undefined : viewFiles(view, fileDiff, working);
    if (files !== undefined) return files;
    const detail = working === undefined ? 'The file could not be loaded. It may be binary or over 2 MB.' : 'The file changed since the tour was made. Regenerate the tour to see its current lines.';
    onExpandError?.(fileDiff.name, detail);
    throw new Error(`${fileDiff.name}: ${detail}`);
  }, [viewByDiff, loadFile, onExpandError]);

  // The Code panel's shared render options (the tour has no full-context toggle), plus the gutter "+"
  // that starts a comment. On a mouse it shows on hover; on touch, tapping a line number reveals it.
  // Clicking it — after optionally selecting a range of lines — reports the range to comment on,
  // which must lie within one of the step's hunks.
  const options = useMemo<ReviewOptions>(() => ({
    ...codeViewBaseOptions(theme === 'latte' ? 'light' : 'dark', terminalFontSize),
    diffStyle: effectiveSplit ? 'split' : 'unified',
    enableGutterUtility: true,
    unsafeCSS: reviewCSS,
    ...(loadFile === undefined ? {} : { loadDiffFiles }),
    onPostRender: rememberExpandedLines(expandedLines),
    onGutterUtilityClick: (range: SelectedLineRange, context: { item: { id: string } }) => {
      const view = baseItems.get(context.item.id)?.view;
      const startSide = range.side ?? range.endSide ?? 'additions';
      const start = view && changeLine(view, startSide, range.start);
      const end = view && changeLine(view, range.endSide ?? startSide, range.end);
      if (start === undefined || end === undefined || start.changeId !== end.changeId) return;
      onCommentAdd({ id: crypto.randomUUID(), changeId: start.changeId, ...orderedRange({ ...range, start: start.line, end: end.line }, patchByChangeId.get(start.changeId) ?? ''), body: '' });
      // the library commits the picked range as the selection after this callback returns
      window.setTimeout(() => setSelection(null), 0);
    }
  }), [baseItems, patchByChangeId, effectiveSplit, onCommentAdd, terminalFontSize, theme, loadFile, loadDiffFiles, expandedLines]);

  const commentsById = useMemo(() => new Map(comments.map(comment => [comment.id, comment])), [comments]);
  const suggestionsById = useMemo(() => new Map(suggestions.map(suggestion => [suggestion.id, suggestion])), [suggestions]);
  const renderAnnotation = (annotation: { metadata?: CommentAnchor }) => {
    // a suggested comment
    if (annotation.metadata !== undefined && 'suggestionId' in annotation.metadata) {
      const suggestion = suggestionsById.get(annotation.metadata.suggestionId);
      if (suggestion === undefined) return null;
      return <><SuggestedComment suggestion={suggestion} onKeep={() => onSuggestionKeep?.(suggestion.id)} onDismiss={() => onSuggestionDismiss?.(suggestion.id)} onRestore={() => onSuggestionRestore?.(suggestion.id)} />{!suggestion.dismissed && threadFor?.(annotation.metadata)}</>;
    }
    const comment = annotation.metadata === undefined ? undefined : commentsById.get(annotation.metadata.commentId);
    if (comment === undefined) return null;
    return <><InlineComment comment={comment} editing={openCommentIds.has(comment.id)} onEdit={() => onCommentOpen(comment.id)} onChange={body => onCommentChange(comment.id, body)} onDone={() => onCommentClose(comment.id)} onDelete={() => onCommentDelete(comment.id)} />{threadFor?.(annotation.metadata!)}</>;
  };

  // Each file header's editor button opens the working tree's copy at the selected line when one is
  // selected in that diff (clicking a line number selects it), else at the diff's first change. A
  // deleted file has no copy to open.
  const renderHeaderMetadata = (item: ReviewItem) => {
    if (onOpenInEditor === undefined || item.type !== 'diff' || item.fileDiff.type === 'deleted') return null;
    const file = baseItems.get(item.id)?.view.file;
    if (file === undefined) return null;
    return <EditorJumpButton file={file} line={diffJumpLine(item.fileDiff, selection?.id === item.id ? selection.range : undefined)} onOpen={onOpenInEditor} />;
  };

  const style = codeViewStyle(terminalFontSize) as CSSProperties;
  return (
    <div className="review-tour-diff-view" style={style} ref={viewRef}>
      {items.length > 0 && splitFits && <div className="review-tour-diff-toolbar"><DiffLayoutSegment split={effectiveSplit} onChange={setSplit} /></div>}
      {placeholders.length > 0 && (
        <ul className="review-tour-diff-placeholders">
          {placeholders.map(change => (
            <li key={change.id}>
              <span className="review-tour-diff-placeholder-path" title={change.file}>{change.originalFile === undefined ? change.file : `${change.originalFile} → ${change.file}`}</span>
              <span className="review-tour-diff-placeholder-note">{change.kind === 'binary' ? 'Binary file' : 'No preview available'}</span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && <CodeView ref={codeView} className="review-tour-diff-scroll" options={options} items={items} renderAnnotation={renderAnnotation} {...(onOpenInEditor === undefined ? {} : { renderHeaderMetadata })} selectedLines={selection} onSelectedLinesChange={setSelection} {...(onScroll === undefined ? {} : { onScroll })} disableWorkerPool />}
    </div>
  );
}
