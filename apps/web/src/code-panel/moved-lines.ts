// Moved code: deleted lines that reappear, in order, as added lines elsewhere in the diff — another
// file or another part of the same one — highlighted apart from ordinary deletions and additions, as
// `git diff --color-moved` does. With Ignore whitespace on, lines match with all whitespace removed,
// so a block moved and re-indented still reads as moved without changes. The library offers no
// per-line styling, so each rendered diff gets its own small stylesheet in its shadow root, keyed by
// line type and number.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CodeViewItem, FileDiffMetadata, PostRenderPhase } from '@pierre/diffs';
import { squashWhitespace } from './items.js';

// The old line numbers of a diff's moved deletions and the new line numbers of its moved additions.
export type MovedLines = { deletions: Set<number>; additions: Set<number> };

// A run of consecutive deleted (or added) lines in one change block.
type Run = { id: string; lines: number[]; texts: string[]; keys: string[] };

// Like git, a moved block needs this many letters and digits, so braces and blank lines that merely
// recur elsewhere never read as moved.
const minMovedAlnum = 20;
const alnum = (text: string): number => text.replace(/[^\p{L}\p{N}]/gu, '').length;

const collectRuns = (id: string, fileDiff: FileDiffMetadata, key: (line: string) => string, deleted: Run[], added: Run[]) => {
  const run = (source: string[], from: number, count: number, firstLine: number): Run => {
    const texts = source.slice(from, from + count);
    return { id, lines: texts.map((_, offset) => firstLine + offset), texts, keys: texts.map(key) };
  };
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') { oldLine += part.lines; newLine += part.lines; continue; }
      if (part.deletions > 0) deleted.push(run(fileDiff.deletionLines, part.deletionLineIndex, part.deletions, oldLine));
      if (part.additions > 0) added.push(run(fileDiff.additionLines, part.additionLineIndex, part.additions, newLine));
      oldLine += part.deletions;
      newLine += part.additions;
    }
  }
};

// Find the moved lines across a set of diffs, keyed by item id. Each deleted run is matched greedily
// against the longest unclaimed run of equal added lines; an added line belongs to one move at most.
export const movedLines = (items: readonly CodeViewItem<unknown>[], ignoreWhitespace: boolean): Map<string, MovedLines> => {
  const key = ignoreWhitespace ? squashWhitespace : (line: string) => line;
  const deleted: Run[] = [];
  const added: Run[] = [];
  for (const item of items) if (item.type === 'diff') collectRuns(item.id, item.fileDiff, key, deleted, added);
  const where = new Map<string, Array<[run: number, offset: number]>>();
  added.forEach((run, index) => run.keys.forEach((lineKey, offset) => {
    const places = where.get(lineKey);
    if (places === undefined) where.set(lineKey, [[index, offset]]); else places.push([index, offset]);
  }));
  const claimed = added.map(run => new Uint8Array(run.keys.length));
  const moved = new Map<string, MovedLines>();
  const mark = (id: string, side: keyof MovedLines, line: number) => {
    let lines = moved.get(id);
    if (lines === undefined) { lines = { deletions: new Set(), additions: new Set() }; moved.set(id, lines); }
    lines[side].add(line);
  };
  for (const run of deleted) {
    let i = 0;
    while (i < run.keys.length) {
      let best = { length: 0, index: 0, offset: 0 };
      // a move starts on a line with substance; blank lines and braces only ride along inside one
      if (alnum(run.texts[i]!) > 0) {
        for (const [index, offset] of where.get(run.keys[i]!) ?? []) {
          const target = added[index]!;
          let length = 0;
          while (i + length < run.keys.length && offset + length < target.keys.length && claimed[index]![offset + length] === 0 && run.keys[i + length] === target.keys[offset + length]) length += 1;
          if (length > best.length) best = { length, index, offset };
        }
      }
      if (best.length === 0 || run.texts.slice(i, i + best.length).reduce((sum, text) => sum + alnum(text), 0) < minMovedAlnum) { i += 1; continue; }
      const target = added[best.index]!;
      for (let step = 0; step < best.length; step += 1) {
        claimed[best.index]![best.offset + step] = 1;
        mark(run.id, 'deletions', run.lines[i + step]!);
        mark(target.id, 'additions', target.lines[best.offset + step]!);
      }
      i += best.length;
    }
  }
  return moved;
};

// Recolour a moved line's row and gutter: the library derives its background, bar and +/- sign from
// these variables.
const movedRule = (lineType: string, side: 'deletion' | 'addition', lines: Set<number>, color: string): string =>
  lines.size === 0 ? '' : `[data-line-type="${lineType}"]:is(${[...lines].map(line => `[data-line="${line}"],[data-column-number="${line}"]`).join(',')}) { --diffs-${side}-base: ${color} !important; --diffs-bg-${side}: color-mix(in lab, var(--diffs-bg) 80%, ${color}) !important; --diffs-bg-${side}-emphasis: transparent !important; }`;
const movedStyleAttribute = 'data-moved-lines';
const styleMovedLines = (node: HTMLElement, moved: MovedLines | undefined) => {
  const root = node.shadowRoot;
  if (root === null) return;
  const css = moved === undefined ? '' : movedRule('change-deletion', 'deletion', moved.deletions, 'var(--mauve)') + movedRule('change-addition', 'addition', moved.additions, 'var(--blue)');
  let style = root.querySelector<HTMLStyleElement>(`style[${movedStyleAttribute}]`);
  if (css === '') { style?.remove(); return; }
  if (style === null) { style = document.createElement('style'); style.setAttribute(movedStyleAttribute, ''); root.append(style); }
  if (style.textContent !== css) style.textContent = css;
};

// Detect the moves among `items` and return an onPostRender handler that styles each rendered diff.
// Diffs already on screen are restyled when the moves change, since a move found in another file
// does not re-render this one.
export const useMovedLines = (items: readonly CodeViewItem<unknown>[], ignoreWhitespace: boolean) => {
  const moved = useMemo(() => movedLines(items, ignoreWhitespace), [items, ignoreWhitespace]);
  const movedRef = useRef(moved);
  movedRef.current = moved;
  const mounted = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    for (const [id, node] of mounted.current) styleMovedLines(node, moved.get(id));
  }, [moved]);
  return useCallback((node: HTMLElement, _instance: unknown, phase: PostRenderPhase, { item }: { item: CodeViewItem<unknown> }) => {
    if (phase === 'unmount') {
      if (mounted.current.get(item.id) === node) mounted.current.delete(item.id);
      return;
    }
    // a recycled container belongs to its newest item only
    for (const [id, other] of mounted.current) if (other === node && id !== item.id) mounted.current.delete(id);
    mounted.current.set(item.id, node);
    styleMovedLines(node, movedRef.current.get(item.id));
  }, []);
};
