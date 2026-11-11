import type { Terminal } from '@xterm/xterm';

type TextRun = [row: number, column: number, columns: number];
// measure cells in font-relative units so the same shape follows font changes
export type OutputShape = [cellWidth: number, rowHeight: number, runs: TextRun[]];

const storageKey = 'rac.agent-output-shapes.v1';
const maxPanes = 8;
const maxRows = 200;
const maxCols = 400;
const maxRuns = 512;
let cached: Map<string, OutputShape> | undefined;

// snapshot only viewport geometry using the same screen dimensions in dom and webgl
export const measureOutputShape = (terminal: Terminal): OutputShape | undefined => {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  const fontSize = terminal.options.fontSize ?? 0;
  // renderer dimensions remain available during panel cleanup after dom removal
  const cellWidth = Number.parseFloat(screen?.style.width ?? '') / terminal.cols / fontSize;
  const rowHeight = Number.parseFloat(screen?.style.height ?? '') / terminal.rows / fontSize;
  // ignore terminals that have never had measurable cells
  if (!(cellWidth > 0 && cellWidth <= 4 && rowHeight > 0 && rowHeight <= 4)) return undefined;
  const runs: TextRun[] = [];
  const buffer = terminal.buffer.active;
  const scratch = buffer.getNullCell();
  const cols = Math.min(terminal.cols, maxCols);
  // preserve blank rows by retaining each run's original row index
  for (let row = 0; row < Math.min(terminal.rows, maxRows) && runs.length < maxRuns; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    // an unpopulated row contributes no bars
    if (line === undefined) continue;
    let start = 0;
    let end = 0;
    // use cell widths instead of string lengths for wide and combined glyphs
    for (let column = 0; column < cols && runs.length < maxRuns; column += 1) {
      const cell = line.getCell(column, scratch);
      const width = cell?.getWidth() ?? 0;
      // skip empty cells and the trailing half of wide glyphs
      if (width === 0 || !cell?.getChars().trim()) continue;
      // bridge single spaces within prose but preserve wider gaps and indentation
      if (end === 0 || column > end + 1) {
        // finish the previous run before starting a new column
        if (end > start) runs.push([row, start, end - start]);
        start = column;
      }
      end = Math.min(column + width, cols);
    }
    // omit trailing whitespace and never exceed the bar budget
    if (end > start && runs.length < maxRuns) runs.push([row, start, end - start]);
  }
  return [cellWidth, rowHeight, runs];
};

// accept only bounded numeric geometry from optional browser storage
const isOutputShape = (value: unknown): value is OutputShape => {
  // require the versioned tuple layout
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [width, height, runs] = value;
  return typeof width === 'number' && width > 0 && width <= 4
    && typeof height === 'number' && height > 0 && height <= 4
    && Array.isArray(runs) && runs.length > 0 && runs.length <= maxRuns
    && runs.every(run => {
      // reject malformed or oversized cell coordinates
      if (!Array.isArray(run) || run.length !== 3) return false;
      const [row, start, length] = run;
      return Number.isInteger(row) && row >= 0 && row < maxRows
        && Number.isInteger(start) && start >= 0
        && Number.isInteger(length) && length > 0 && start + length <= maxCols;
    });
};

// hydrate once per page while keeping storage failures non-fatal
const shapes = () => {
  // reuse cached shapes within the page even when storage is blocked
  if (cached !== undefined) return cached;
  cached = new Map();
  try {
    const raw = sessionStorage.getItem(storageKey);
    // bound the parse before accepting stored entries
    if (raw === null || raw.length > 128 * 1024) return cached;
    const entries: unknown = JSON.parse(raw);
    // ignore invalid storage and accept only the newest pane entries
    if (!Array.isArray(entries)) return cached;
    // keep each pane's geometry isolated
    for (const entry of entries.slice(-maxPanes)) {
      // reject stale or malformed entries
      if (Array.isArray(entry) && typeof entry[0] === 'string' && isOutputShape(entry[1])) cached.set(entry[0], entry[1]);
    }
  } catch { /* unavailable storage falls back to memory */ }
  return cached;
};

// load the last shape for this pane only
export const readOutputShape = (key: string) => shapes().get(key);

// keep a small tab-local history without retaining any output text
export const saveOutputShape = (key: string, shape: OutputShape) => {
  const entries = shapes();
  entries.delete(key);
  // an empty screen should not replay older content geometry
  if (shape[2].length > 0) entries.set(key, shape);
  // evict the least recently saved pane
  if (entries.size > maxPanes) entries.delete(entries.keys().next().value!);
  try { sessionStorage.setItem(storageKey, JSON.stringify([...entries])); }
  catch { /* keep using the memory cache */ }
};

// paint anonymous bars without reconstructing the source text
export const renderOutputShape = (target: HTMLElement, [cellWidth, rowHeight, runs]: OutputShape) => {
  const fragment = document.createDocumentFragment();
  // replay each run at the saved viewport coordinates
  for (const [row, column, columns] of runs) {
    const bar = document.createElement('span');
    bar.className = 'skeleton output-skeleton-line';
    Object.assign(bar.style, {
      left: `${column * cellWidth}em`,
      top: `${(row + 0.2) * rowHeight}em`,
      width: `${columns * cellWidth}em`,
      height: `${0.6 * rowHeight}em`
    });
    fragment.append(bar);
  }
  target.replaceChildren(fragment);
};
