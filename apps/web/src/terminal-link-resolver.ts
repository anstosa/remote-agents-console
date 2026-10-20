import type { IBufferRange } from '@xterm/xterm';
import { linkContextRows, safeHttpTarget, type LinkCell, type LinkRow, type LinkSnapshot } from './terminal-link-metadata.js';

export type ResolvedTerminalLink = { kind: 'url' | 'file'; uri: string; source: 'explicit' | 'inferred'; ranges: IBufferRange[] };
type Point = { row: number; cell: LinkCell };
type LogicalRow = { text: string; points: Point[]; first: LinkRow; last: LinkRow; clipped: boolean };
type Piece = { row: LogicalRow; start: number; end: number };
const maxTargetCharacters = 8192;
const urlStart = /https?:\/{0,2}/giu;
const tokenEnd = /[\s\u0000"'!*(){}|\\^<>`]/u;
// retain the existing workspace-reference grammar independently from URL inference
const fileMention = /(?:^|[\s'"`(<\[])(@?(?:(?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]*[A-Za-z0-9_@+-]|(?:README|LICENSE|Dockerfile|Makefile)(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_@+-]+\.[A-Za-z0-9_-]{1,16})(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)/gu;

// remove display-only source line annotations from file targets
const filePath = (value: string) => value.replace(/^@/u, '').replace(/^file:\/\//u, '').replace(/#L\d+(?:-L\d+)?$/iu, '').replace(/:\d+(?::\d+)?$/u, '');

// combine only native wraps while keeping an exact UTF-16-to-cell map
const logicalRows = (snapshot: LinkSnapshot): LogicalRow[] => {
  const result: LogicalRow[] = [];
  // copy cells instead of flattening away their layout and style evidence
  for (const [index, row] of snapshot.rows.entries()) {
    const previous = result.at(-1);
    const logical = row.wrapped && previous ? previous : { text: '', points: [], first: row, last: row, clipped: false };
    // begin a new hard row
    if (logical !== previous) result.push(logical);
    logical.last = row;
    const next = snapshot.rows[index + 1];
    let end = row.cells.length;
    // omit layout-only null padding at hard breaks, not printed spaces in native wraps
    if (!next?.wrapped) {
      while (end && !row.cells[end - 1].text) end -= 1;
    } else if (!row.cells[end - 1]?.text && next.cells[0]?.width === 2) end -= 1;
    // map every code unit of combined/wide glyphs to its originating cell
    for (const cell of row.cells.slice(0, end)) {
      const text = cell.explicit !== undefined ? '\0'.repeat(cell.text.length || 1) : cell.text || ' ';
      logical.text += text;
      // preserve offsets inside combined glyphs without duplicating terminal columns
      for (let offset = 0; offset < text.length; offset += 1) logical.points.push({ row: row.line, cell });
    }
    logical.clipped = index === snapshot.rows.length - 1 && snapshot.truncatedEnd;
  }
  return result;
};

// translate selected text into inclusive xterm row-local ranges
const rangesFor = (pieces: Piece[], length = Infinity): IBufferRange[] => {
  const ranges: IBufferRange[] = [];
  // retain only the selected prefix, excluding stripped sentence punctuation
  for (const piece of pieces) {
    const end = Math.min(piece.end, piece.start + length);
    // coalesce adjacent code units and wide cells on the same physical row
    for (const point of piece.row.points.slice(piece.start, end)) {
      const last = ranges.at(-1);
      const right = point.cell.column + point.cell.width;
      // combined characters map back onto the same cell
      if (last && last.end.y === point.row + 1 && point.cell.column <= last.end.x) last.end.x = Math.max(last.end.x, right);
      else ranges.push({ start: { x: point.cell.column + 1, y: point.row + 1 }, end: { x: right, y: point.row + 1 } });
    }
    length -= end - piece.start;
    // no geometry may outlive the selected target
    if (length <= 0) break;
  }
  return ranges;
};

// read a single uninterrupted token, leaving delimiters in the source model
const tokenAt = (row: LogicalRow, start: number) => {
  const length = row.text.slice(start).search(tokenEnd);
  const end = length < 0 ? row.text.length : start + length;
  return { text: row.text.slice(start, end), end, terminal: !row.text.slice(end).trim() };
};

// compare generic identifier shape without knowledge of UUIDs or application routes
const opaqueContinuation = (before: string, after: string) => {
  const tail = before.split(/[/?#=&]/u).at(-1) ?? '';
  const head = after.split(/[/?#=&]/u)[0];
  const shape = (text: string) => text.replace(/[A-Za-z0-9]+/gu, 'x');
  return /\d/u.test(tail) && /\d/u.test(head) && /^[\w-]+$/u.test(tail) && /^[\w-]+$/u.test(head) && shape(tail) !== shape(head);
};

// score a hard boundary from independent style, layout, and lexical evidence
const continuationScore = (previous: Piece, next: Piece, before: string, after: string, trailingProse: boolean) => {
  const left = previous.row.points[previous.end - 1]?.cell;
  const right = next.row.points[next.start]?.cell;
  const sameStyle = !!left?.accented && left.style === right?.style;
  const surrounding = [...previous.row.points.slice(0, previous.start), ...next.row.points.slice(next.end)];
  const distinctive = sameStyle && surrounding.some(point => point.cell.text.trim() && point.cell.style !== left.style);
  const underlined = sameStyle && left.style.split(':')[2] !== '0';
  const opaque = opaqueContinuation(before, after);
  const syntax = /[/?#&=%:]/u.test(after) || opaque;
  const valueBoundary = /[?&=]$/u.test(before) && (!trailingProse || syntax) || /[:=]$/u.test(before) && /^\d+$/u.test(after);
  const compoundSyntax = /\/[^\s]*[?#]/u.test(after) || /[?&][^\s]*=/u.test(after);
  const boundaryBond = /[?&=/:,.-]$/u.test(before) || /^[/?#&=%:]/u.test(after) || opaque || compoundSyntax;
  const file = new RegExp(fileMention).exec(after)?.[1];
  const separatePath = file === after && after.includes('/') && !boundaryBond && !distinctive;
  // combine distinct styling with an unfinished boundary before joining file-shaped text
  const styledBoundary = distinctive && (/[?&=/]$/u.test(before) || /^https?:$/iu.test(before) && after.startsWith('/'));
  // a new file or prose sentence is stronger evidence than shared color
  const independentFile = !styledBoundary && (separatePath || /^(?:README|LICENSE|Dockerfile|Makefile)(?:\.|$)/u.test(after) || /^[^?#=&]*\/[^/]+\.[A-Za-z0-9_-]+$/u.test(after));
  // do not absorb prose, separate destinations, or explicit metadata
  if (!after || /^https?:/iu.test(after) || independentFile || (trailingProse && !(syntax && boundaryBond) && !valueBoundary)) return 0;
  const aligned = /^ */u.exec(previous.row.text)![0].length === next.start;
  const edge = !!left && left.column + left.width === previous.row.last.columns;
  const unfinished = valueBoundary || /[:/]$/u.test(before) && syntax;
  const path = /\/$/u.test(before) && (syntax || /^[\w@%+-]+\.[\w-]+$/u.test(after));
  // style supports a syntactic token, never arbitrary whitespace deletion
  if ((distinctive && !trailingProse) || ((distinctive || underlined) && (syntax || valueBoundary || (!trailingProse && /[/?#&=%:_-]$/u.test(before))))) return 6;
  // layout and lexical evidence retain unstyled captures without format-specific exceptions
  if ((aligned || edge) && (opaque || path || unfinished || (edge && syntax))) return 3;
  return 0;
};

// select one best bounded candidate rather than committing every hard-row join
const inferUrl = (rows: LogicalRow[], rowIndex: number, start: number) => {
  const row = rows[rowIndex];
  const initial = tokenAt(row, start);
  const pieces: Piece[] = [{ row, start, end: initial.end }];
  let raw = initial.text;
  let score = 0;
  let supported = true;
  let best: { uri: string; pieces: Piece[]; score: number } | undefined;
  const opening = row.text[start - 1];
  const closing = opening === '(' ? ')' : opening === '<' ? '>' : undefined;
  let exhausted = false;
  // examine one prefix per hard boundary and prefer fewer joins on equal evidence
  for (let index = rowIndex; index < rows.length; index += 1) {
    const current = pieces.at(-1)!;
    const token = tokenAt(current.row, current.start);
    const closed = closing !== undefined && current.row.text[token.end] === closing;
    const physicalRows = current.row.last.line - row.first.line + 1;
    // never expose a prefix cut by a reconstruction budget or snapshot boundary
    if (raw.length > maxTargetCharacters || physicalRows > linkContextRows || (current.row.clipped && token.terminal)) { exhausted = true; break; }
    const uri = safeHttpTarget(raw.replace(/["':,.!?\[\]`()<>]+$/u, ''));
    // invalid supported continuations must not fall back to a fabricated shorter href
    if (!uri && supported) best = undefined;
    const candidateScore = closed ? score + 10 : score;
    // a matched enclosure can support otherwise ambiguous single-token rows
    if (uri && (supported || closed) && (!best || candidateScore > best.score)) best = { uri, pieces: [...pieces], score: candidateScore };
    // real delimiters and text terminate reconstruction
    if (!token.terminal || closed || index + 1 >= rows.length) break;
    const nextRow = rows[index + 1];
    const nextStart = /^ */u.exec(nextRow.text)![0].length;
    const nextToken = tokenAt(nextRow, nextStart);
    const next: Piece = { row: nextRow, start: nextStart, end: nextToken.end };
    // explicit cells and independent URL starts are unconditional boundaries
    if (!nextToken.text || /^https?:/iu.test(nextToken.text)) break;
    const evidence = continuationScore(current, next, raw, nextToken.text, !nextToken.terminal && nextRow.text[nextToken.end] !== closing);
    // speculative enclosed candidates must remain uninterrupted single tokens
    if (!evidence && (!closing || (!nextToken.terminal && nextRow.text[nextToken.end] !== closing))) break;
    supported = supported && evidence > 0;
    score += evidence;
    raw += nextToken.text;
    pieces.push(next);
  }
  return { best: exhausted ? undefined : best, pieces };
};

// resolve explicit targets first, then inferred URLs, then non-overlapping files
export const resolveTerminalLinks = (snapshot: LinkSnapshot): ResolvedTerminalLink[] => {
  const links: ResolvedTerminalLink[] = [];
  // use only currently occupied explicit cells; reset may retain stale service entries
  for (const row of snapshot.rows) {
    let previous: ResolvedTerminalLink | undefined;
    // group contiguous label cells without treating their visible text as a destination
    for (const cell of row.cells) {
      // unsafe and missing destinations remain reserved but never become anchors
      if (!cell.text || !cell.explicit) { previous = undefined; continue; }
      const range = previous?.ranges[0];
      // extend one row-local explicit segment
      if (previous?.uri === cell.explicit && range?.end.x === cell.column) range.end.x = cell.column + cell.width;
      else {
        previous = { kind: 'url', uri: cell.explicit, source: 'explicit', ranges: [{ start: { x: cell.column + 1, y: row.line + 1 }, end: { x: cell.column + cell.width, y: row.line + 1 } }] };
        links.push(previous);
      }
    }
  }
  const rows = logicalRows(snapshot);
  const occupied = new Map<LogicalRow, Array<{ start: number; end: number }>>();
  // reserve all URL text before recognizing file mentions
  for (const [index, row] of rows.entries()) {
    const matcher = new RegExp(urlStart);
    // find URL starts without destroying physical evidence
    for (let match = matcher.exec(row.text); match; match = matcher.exec(row.text)) {
      // an earlier selected continuation owns this text
      if (occupied.get(row)?.some(range => match.index >= range.start && match.index < range.end)) continue;
      const resolved = inferUrl(rows, index, match.index);
      const pieces = resolved.best?.pieces ?? resolved.pieces;
      // reserve attempted URLs even when a bound prevents a safe target
      for (const piece of pieces) {
        const ranges = occupied.get(piece.row) ?? [];
        ranges.push({ start: piece.start, end: piece.end });
        occupied.set(piece.row, ranges);
      }
      // retain complete targets with precise geometry on every selected row
      if (resolved.best) links.push({ kind: 'url', uri: resolved.best.uri, source: 'inferred', ranges: rangesFor(resolved.best.pieces, resolved.best.uri.length) });
    }
  }
  // files use their own supported grammar outside explicit and inferred URLs
  for (const row of rows) {
    const matcher = new RegExp(fileMention);
    // preserve native-wrapped file mentions and their line annotations
    for (let match = matcher.exec(row.text); match; match = matcher.exec(row.text)) {
      const mention = match[1];
      const start = match.index + match[0].length - mention.length;
      const end = start + mention.length;
      // clipped or URL-owned text cannot authorize an unrelated file preview
      if ((row.clipped && end === row.text.length) || (snapshot.truncatedStart && row === rows[0] && start === 0) || occupied.get(row)?.some(range => start < range.end && end > range.start)) continue;
      links.push({ kind: 'file', uri: filePath(mention), source: 'inferred', ranges: rangesFor([{ row, start, end }]) });
    }
  }
  return links;
};
