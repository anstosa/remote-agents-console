// The shared core of everything that renders `@pierre/diffs`: turning a Comparison's per-file patches
// into CodeView items, plus the render metrics and base options both diff renderers use. Importing
// the library here (not in comparison.ts) is what keeps it out of the eager bundle — its only two
// importers, code-panel.tsx and code-panel/review-diffs.tsx, are both reached through a dynamic
// `import()`. Kept side-effect free so the isolated-component fixture can exercise item derivation
// without the dashboard.
import { parseDiffFromFile, parsePatchFiles, type ChangeContent, type CodeViewDiffItem, type CodeViewFileItem, type CodeViewItem, type ContextContent, type DiffLineAnnotation, type FileDiffLoadedChangedFiles, type FileDiffMetadata, type HunkExpansionRegion, type PostRenderPhase } from '@pierre/diffs';
import type { ComparisonFile, ComparisonFileContents, ExpandedLines, RevisionFile } from './comparison.js';

// Line cap for syntax tokenization: past this a file renders as plain (un-highlighted) text so a
// very large diff or file never blocks the main thread. From the spike's timing measurements.
export const CODE_TOKENIZE_MAX_LINES = 2000;

// baseline metrics preserve the established line-height ratio while the shared terminal setting
// supplies the live font size; rendered css and virtualizer metrics must remain in lockstep
export const CODE_FONT_SIZE = 13;
export const CODE_LINE_HEIGHT = 20;

// scale line boxes with the shared font setting
const codeLineHeight = (fontSize: number): number => Math.round(fontSize * CODE_LINE_HEIGHT / CODE_FONT_SIZE);

// The CSS custom properties the diff library reads for its font metrics, applied to the element that
// hosts the CodeView. Cast to CSSProperties at the call site (custom properties aren't in its type).
// build matching shadow-dom font metrics
export const codeViewStyle = (fontSize: number): Record<string, string> => ({ '--diffs-font-size': `${fontSize}px`, '--diffs-line-height': `${codeLineHeight(fontSize)}px` });

// The diff-library options both renderers share (theme, highlighter, scroll/sticky behaviour, the
// freeze cap, and the itemMetrics that track the font metrics above). Each renderer spreads this and
// adds its own view-specific keys — diffStyle, and the Code panel's full-context expandUnchanged /
// loadDiffFiles. `themeType` is driven from color-theme.ts. Literals are pinned so the object stays
// assignable to `CodeViewReactOptions` when spread, without importing the React entry here.
// build matching virtualizer metrics
export const codeViewBaseOptions = (themeType: 'light' | 'dark', fontSize: number) => ({
  theme: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' } as const,
  themeType,
  preferredHighlighter: 'shiki-js' as const,
  overflow: 'scroll' as const,
  hunkSeparators: 'line-info' as const,
  stickyHeaders: true,
  enableLineSelection: true,
  tokenizeMaxLength: CODE_TOKENIZE_MAX_LINES,
  itemMetrics: { lineHeight: codeLineHeight(fontSize), diffHeaderHeight: codeLineHeight(fontSize) + 24 }
});

// A small, stable content hash (djb2, folded to uint32). Drives both an item's `version` — which
// only moves when the file's content moves — and its content-derived `cacheKey` prefix, never an
// index or a constant, so the library's highlight cache stays correct across live updates.
export const contentHash = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return hash >>> 0;
};

// Hide the gutter "+" on unchanged lines a diff expanded, so lines are picked only inside its hunks.
export const hunkLinesOnlyCSS = '[data-line-type="context-expanded"] [data-gutter-utility-slot] { display: none; }';

// An item with its annotations, each keyed. CodeView only re-reads an item when its version moves, so
// the version folds in where the annotations sit, and only that: what an annotation renders can change
// without re-laying out the diff. An item with none is returned as is.
export const annotatedItem = <A,>(item: CodeViewItem<A>, placed: Array<{ key: string; annotation: DiffLineAnnotation<A> }>): CodeViewItem<A> => {
  if (placed.length === 0) return item;
  return { ...item, annotations: placed.map(entry => entry.annotation), version: contentHash(`${item.version}|${placed.map(entry => `${entry.key}:${entry.annotation.side}:${entry.annotation.lineNumber}`).join('|')}`) };
};

// Combine a file's two sides into one hash input; the leading old-side length keeps the boundary
// between them unambiguous, so distinct (old, new) pairs never collide on the split point.
const sidesHash = (oldText: string, newText: string): number => contentHash(`${oldText.length}:${oldText}:${newText}`);

// A changed file's content version, derived from its captured patch text. This is the single source
// of that formula: `diffItemForFile` stamps it on the item's `version`, and the Code panel keys its
// live-update item cache on the same value, so the two cannot drift.
export const fileVersion = (file: ComparisonFile): number => contentHash(file.patch);

// Which files can render as a real diff. `binary` / `metadata` files carry a human note rather than
// a unified patch, and a `capped` file has its patch withheld — all of those become placeholders.
export const isDiffable = (file: ComparisonFile): boolean => !file.capped && (file.kind === 'tracked' || file.kind === 'untracked');

// Build a diff item from a raw unified patch under a stable, content-independent key — a changed
// file's path (Code panel, one item per file) or a Change id (Review tour, one item per change-hunk,
// so a file split across hunks does not collide on its path). Returns undefined when the text is not
// a diff the parser can recover (e.g. a git binary patch), so the caller shows a placeholder instead.
// The item id (`diff:<key>`) is content-stable so controlled reconciliation matches it across updates
// and every line stays addressable as (key, side, line).
export const diffItemForPatch = (key: string, patch: string): CodeViewDiffItem | undefined => {
  const version = contentHash(patch);
  const parsed = parsePatchFiles(patch, `${key}#${version}`, false);
  const fileDiff = parsed.flatMap(entry => entry.files)[0];
  if (fileDiff === undefined) return undefined;
  return { id: `diff:${key}`, type: 'diff', fileDiff, version };
};

// Build a diff item for one non-capped changed file from its captured patch, keyed by its path.
export const diffItemForFile = (file: ComparisonFile): CodeViewDiffItem | undefined =>
  isDiffable(file) ? diffItemForPatch(file.change.path, file.patch) : undefined;

// One side's text, or undefined when it is absent, binary, or cut off by the server's size cap — a
// partial file would diff or expand against the wrong lines.
const sideText = (side: RevisionFile | null): string | undefined => side === null || side.truncated ? undefined : side.content;

// Build a diff item from a changed file's two sides (the `/comparison/file` payload), used by the
// "Load anyway" affordance. jsdiff produces a non-partial diff — one that already carries both
// revisions — so it renders without a further hydration round-trip.
export const diffItemForContents = (contents: ComparisonFileContents): CodeViewDiffItem | undefined => {
  const oldText = sideText(contents.base);
  const newText = sideText(contents.working);
  // a side present but binary or cut off (no text) cannot be diffed as text
  if ((contents.base !== null && oldText === undefined) || (contents.working !== null && newText === undefined)) return undefined;
  const oldName = contents.base?.path ?? contents.path;
  const version = sidesHash(oldText ?? '', newText ?? '');
  const oldFile = contents.base === null ? null : { name: oldName, contents: oldText ?? '', cacheKey: `old:${contents.path}#${version}` };
  const newFile = contents.working === null ? null : { name: contents.path, contents: newText ?? '', cacheKey: `new:${contents.path}#${version}` };
  const fileDiff = parseDiffFromFile(oldFile, newFile, undefined, false);
  return { id: `diff:${contents.path}`, type: 'diff', fileDiff, version };
};

// A run of a diff's old and new lines, as indexes into FileDiffMetadata's two line arrays.
type LineSpan = { deletionLineIndex: number; deletions: number; additionLineIndex: number; additions: number };
type HunkPart = ContextContent | ChangeContent;

// Append a part, folding adjacent unchanged runs into one.
const pushPart = (parts: HunkPart[], part: HunkPart): void => {
  const last = parts[parts.length - 1];
  if (part.type === 'context' && last?.type === 'context') parts[parts.length - 1] = { ...last, lines: last.lines + part.lines };
  else parts.push(part);
};

// Re-diff a span's old and new lines with all whitespace removed, by longest common subsequence: the
// lines that match become unchanged lines indexing both sides, so each keeps its own text. A line the
// file ends on without a newline only matches one that also does, as in git. Undefined when the span
// is too large to diff here.
const maxRealignCells = 4_000_000;
export const squashWhitespace = (line: string): string => line.replace(/\s+/gu, '');
const realign = (span: LineSpan, fileDiff: FileDiffMetadata, noNewlineAt: { deletion: number; addition: number }): HunkPart[] | undefined => {
  const side = (lines: string[], from: number, count: number, noNewline: number) =>
    lines.slice(from, from + count).map((line, offset) => from + offset === noNewline ? `${squashWhitespace(line)}\n` : squashWhitespace(line));
  const deleted = side(fileDiff.deletionLines, span.deletionLineIndex, span.deletions, noNewlineAt.deletion);
  const added = side(fileDiff.additionLines, span.additionLineIndex, span.additions, noNewlineAt.addition);
  // the matching lines at either end need no table
  let head = 0;
  while (head < deleted.length && head < added.length && deleted[head] === added[head]) head += 1;
  let tail = 0;
  while (tail < deleted.length - head && tail < added.length - head && deleted[deleted.length - 1 - tail] === added[added.length - 1 - tail]) tail += 1;
  const rows = deleted.length - head - tail;
  const cols = added.length - head - tail;
  if (rows * cols > maxRealignCells) return undefined;
  // common[i * width + j]: how many lines deleted[head + i..] and added[head + j..] can match
  const width = cols + 1;
  const common = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      common[i * width + j] = deleted[head + i] === added[head + j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const parts: HunkPart[] = [];
  const unchanged = (i: number, j: number, lines: number) => pushPart(parts, { type: 'context', lines, deletionLineIndex: span.deletionLineIndex + i, additionLineIndex: span.additionLineIndex + j });
  if (head > 0) unchanged(0, 0, head);
  let i = 0;
  let j = 0;
  let fromI = 0;
  let fromJ = 0;
  const flushChange = () => {
    if (i > fromI || j > fromJ) parts.push({ type: 'change', deletions: i - fromI, deletionLineIndex: span.deletionLineIndex + head + fromI, additions: j - fromJ, additionLineIndex: span.additionLineIndex + head + fromJ });
  };
  while (i < rows || j < cols) {
    if (i < rows && j < cols && deleted[head + i] === added[head + j] && common[i * width + j] === common[(i + 1) * width + j + 1]! + 1) {
      flushChange();
      unchanged(head + i, head + j, 1);
      i += 1; j += 1; fromI = i; fromJ = j;
    } else if (j === cols || (i < rows && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) i += 1;
    else j += 1;
  }
  flushChange();
  if (tail > 0) unchanged(head + rows, head + cols, tail);
  return parts;
};

// A diff item with its whitespace-only changes shown as unchanged lines, like `git diff -w`: each hunk
// is re-diffed whole (a hunk too large for that has each change block re-diffed instead), so a line
// that only moved its indentation pairs with its old form even where git's whitespace-sensitive diff
// had anchored on an unchanged line between them. Hunk ranges and line numbers stay put, so
// selections and comment anchors address the same lines; only the rows' classification and the
// library's per-hunk render counts move. A hunk of nothing but whitespace changes renders as
// unchanged lines. The id is kept while the version and highlight cache key move; an item with
// nothing to pair (or a file item) is returned as is.
export const withoutWhitespaceChanges = <I extends CodeViewItem<unknown>>(item: I): I => {
  if (item.type !== 'diff') return item;
  const fileDiff = item.fileDiff;
  let splitShift = 0;
  let unifiedShift = 0;
  const hunks = fileDiff.hunks.map(hunk => {
    const noNewlineAt = {
      deletion: hunk.noEOFCRDeletions ? hunk.deletionLineIndex + hunk.deletionCount - 1 : -1,
      addition: hunk.noEOFCRAdditions ? hunk.additionLineIndex + hunk.additionCount - 1 : -1
    };
    const whole = realign({ deletionLineIndex: hunk.deletionLineIndex, deletions: hunk.deletionCount, additionLineIndex: hunk.additionLineIndex, additions: hunk.additionCount }, fileDiff, noNewlineAt);
    const hunkContent: HunkPart[] = [];
    for (const part of whole ?? hunk.hunkContent.flatMap(part => part.type === 'context' ? [part] : realign(part, fileDiff, noNewlineAt) ?? [part])) pushPart(hunkContent, part);
    let additionLines = 0;
    let deletionLines = 0;
    let splitLineCount = 0;
    let unifiedLineCount = 0;
    for (const part of hunkContent) {
      if (part.type === 'context') { splitLineCount += part.lines; unifiedLineCount += part.lines; continue; }
      additionLines += part.additions;
      deletionLines += part.deletions;
      splitLineCount += Math.max(part.additions, part.deletions);
      unifiedLineCount += part.additions + part.deletions;
    }
    const next = { ...hunk, hunkContent, additionLines, deletionLines, splitLineStart: hunk.splitLineStart + splitShift, splitLineCount, unifiedLineStart: hunk.unifiedLineStart + unifiedShift, unifiedLineCount };
    splitShift += splitLineCount - hunk.splitLineCount;
    unifiedShift += unifiedLineCount - hunk.unifiedLineCount;
    return next;
  });
  // every line matched anew folds two unified rows into one, so an unmoved count means nothing changed
  if (unifiedShift === 0) return item;
  return {
    ...item,
    version: contentHash(`${item.version}|ignore-whitespace`),
    fileDiff: { ...fileDiff, hunks, splitLineCount: fileDiff.splitLineCount + splitShift, unifiedLineCount: fileDiff.unifiedLineCount + unifiedShift, ...(fileDiff.cacheKey === undefined ? {} : { cacheKey: `${fileDiff.cacheKey}:ignore-whitespace` }) }
  };
};

// Build a plain (non-diff) file item from the working-tree contents, for the single-file "Plain
// file" mode. The id namespace (`file:`) is disjoint from `diff:` so switching a file between diff
// and plain modes swaps the item cleanly, and `version` moves only when the contents change.
export const fileItemForContents = (path: string, contents: string): CodeViewFileItem => {
  const version = contentHash(contents);
  return { id: `file:${path}`, type: 'file', file: { name: path, contents, cacheKey: `file:${path}#${version}` }, version };
};

// Map a changed file's two sides (the /comparison/file payload) into the `loadDiffFiles` result the
// diff library hydrates a partial patch with, so Full-context mode can expand the surrounding lines.
// Returns undefined when either side has no text (a binary or cut-off side), which cannot be expanded.
export const loadedFilesFromContents = (contents: ComparisonFileContents): FileDiffLoadedChangedFiles | undefined => {
  const oldText = sideText(contents.base);
  const newText = sideText(contents.working);
  if (oldText === undefined || newText === undefined) return undefined;
  const oldName = contents.base?.path ?? contents.path;
  const version = sidesHash(oldText, newText);
  return {
    oldFile: { name: oldName, contents: oldText, cacheKey: `old:${contents.path}#${version}` },
    newFile: { name: contents.path, contents: newText, cacheKey: `new:${contents.path}#${version}` }
  };
};

// A diff's hunk layout, which the library's per-gap expansion keys (hunk indices) only mean anything against.
const hunkSignature = (fileDiff: FileDiffMetadata): string => fileDiff.hunks.map(hunk => `${hunk.deletionStart},${hunk.deletionCount},${hunk.additionStart},${hunk.additionCount}`).join(';');

// The library has no public read of a diff's expansions, so this reaches into its renderer. A library
// upgrade that moves it reads as undefined, which turns remembering off rather than throwing. The retry
// below also leans on library behaviour: expanding by no lines loads a partial diff's files again.
type ExpandableInstance = { expandHunk?: (hunkIndex: number, direction: 'up' | 'down', lineCount: number) => void; hunksRenderer?: { getExpandedHunksMap?: () => Map<number, HunkExpansionRegion> } };

// The instances a restore expanded, until they next mount. A restore can land on an item that is only on
// screen until the saved scroll is put back; scrolling it out cancels its file load, so its next mount
// loads them again.
const restoredInstances = new WeakSet<object>();

// An `onPostRender` that keeps `store` up to date with the hidden lines expanded in each diff, and
// expands them again when an item renders in a fresh instance (a remounted CodeView, or an item that
// left the list and came back). The library drops its expansions with the instance; `store` outlives it.
// An expansion is kept only once its files have loaded, so one that failed is not retried on every remount.
// Expanding re-renders the item, so each expansion waits until the library's render pass returns.
export const rememberExpandedLines = (store: ExpandedLines) => (_node: HTMLElement, instance: unknown, phase: PostRenderPhase, { item }: { item: CodeViewItem<unknown> }) => {
  const target = instance as ExpandableInstance;
  const current = target.hunksRenderer?.getExpandedHunksMap?.();
  if (item.type !== 'diff' || phase === 'unmount' || current === undefined) return;
  const signature = hunkSignature(item.fileDiff);
  if (current.size > 0) {
    const [first] = current.keys();
    if (!item.fileDiff.isPartial) store.set(item.id, { signature, regions: [...current].map(([index, region]) => [index, { ...region }]) });
    else if (phase === 'mount' && restoredInstances.delete(target) && first !== undefined) queueMicrotask(() => target.expandHunk?.(first, 'up', 0));
    return;
  }
  const saved = store.get(item.id);
  if (phase !== 'mount' || saved === undefined) return;
  // a changed patch starts collapsed, and forgets the gaps it no longer has
  if (saved.signature !== signature) { store.delete(item.id); return; }
  restoredInstances.add(target);
  queueMicrotask(() => {
    for (const [index, { fromStart, fromEnd }] of saved.regions) {
      if (fromStart > 0) target.expandHunk?.(index, 'up', fromStart);
      if (fromEnd > 0) target.expandHunk?.(index, 'down', fromEnd);
    }
  });
};
