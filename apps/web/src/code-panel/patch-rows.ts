// The rows of a unified patch in the order a unified diff renders them, each with the old and/or
// new line number it counts on. Shared by the Review tour's change request (which quotes the lines a
// comment covers) and the diff renderers (which order a range picked across both sides).
// Imports nothing, so the eager review-tour.tsx can use it without pulling in the diff library.

// one removed (old only), added (new only) or context (both) line, with its +/-/space prefix
export type PatchRow = { old?: number; new?: number; text: string };

// Walk a patch's hunks counting old and new line numbers; lines before the first hunk header (the
// file header) and "\ No newline" markers are not rows.
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); continue; }
    if (oldLine === 0 && newLine === 0) continue;
    if (text.startsWith('-')) rows.push({ old: oldLine++, text });
    else if (text.startsWith('+')) rows.push({ new: newLine++, text });
    else if (text.startsWith(' ')) rows.push({ old: oldLine++, new: newLine++, text });
  }
  return rows;
}

// the index of the row holding a line of one side (deletions count old lines, additions new), or -1
export const patchRowIndex = (rows: PatchRow[], side: 'deletions' | 'additions', line: number): number => rows.findIndex(row => (side === 'deletions' ? row.old : row.new) === line);

type Side = 'deletions' | 'additions';
// A range of lines picked in a diff, from (startSide, startLine) to (endSide, endLine), top to bottom
export type PickedLines = { startSide: Side; startLine: number; endSide: Side; endLine: number };

// Order a range picked in a diff (the library's selected range) top-to-bottom. Within one side line
// numbers order it; across sides (unified view only) the two ends' rows in the patch do, since an
// added block can sit above a later removed one. An end the patch does not hold falls back to
// deletions first.
export function orderedRange(range: { start: number; end: number; side?: Side; endSide?: Side }, patch: string): PickedLines {
  const startSide = range.side ?? range.endSide ?? 'additions';
  const endSide = range.endSide ?? startSide;
  if (startSide === endSide) return { startSide, startLine: Math.min(range.start, range.end), endSide, endLine: Math.max(range.start, range.end) };
  const rows = patchRows(patch);
  const startRow = patchRowIndex(rows, startSide, range.start);
  const endRow = patchRowIndex(rows, endSide, range.end);
  const inOrder = startRow < 0 || endRow < 0 ? startSide === 'deletions' : startRow <= endRow;
  return inOrder ? { startSide, startLine: range.start, endSide, endLine: range.end } : { startSide: endSide, startLine: range.end, endSide: startSide, endLine: range.start };
}
