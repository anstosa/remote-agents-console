import type { IBufferCell, IBufferLine, Terminal as XTerm } from '@xterm/xterm';

export const linkContextRows = 32;
export type LinkCell = Readonly<{
  column: number;
  text: string;
  width: number;
  style: string;
  accented: boolean;
  // undefined means ordinary text; null reserves an unsafe or unresolved explicit link
  explicit?: string | null;
}>;
export type LinkRow = Readonly<{ line: number; columns: number; wrapped: boolean; cells: readonly LinkCell[] }>;
export type LinkSnapshot = Readonly<{ rows: readonly LinkRow[]; truncatedStart: boolean; truncatedEnd: boolean }>;

const xtermCellSize = 3;
const xtermCombinedMask = 0x200000;
const xtermContentMask = 0x3fffff;
const xtermWidthShift = 22;
const xtermExtendedMask = 0x10000000;
type NativeRow = Readonly<{
  identity: object;
  data: Uint32Array;
  words: number;
  contentColumns: number;
  cacheable: boolean;
  matchesCached: boolean;
  identityColumn?: number;
}>;
type CachedRow = Readonly<{ identity: object; data: Uint32Array; nextWrapped: boolean; value: LinkRow }>;
const rowCaches = new WeakMap<XTerm, ReadonlyMap<number, CachedRow>>();

// validate destinations without rewriting encoded path, query, or fragment text
export const safeHttpTarget = (value: string): string | undefined => {
  // reject parser-normalized whitespace and unsupported schemes
  if (!/^https?:\/\//iu.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? value : undefined;
  } catch { return undefined; }
};

// isolate the read-only compatibility seam for the pinned xterm 6.0.0 runtime
const explicitMetadata = (terminal: XTerm) => {
  const runtime = terminal as unknown as { _core?: { _oscLinkService?: { getLinkData?: (id: number) => { uri?: unknown } | undefined } } };
  const service = runtime._core?._oscLinkService;
  const targets = new Map<number, string | null>();
  // resolve only ids observed on current occupied cells, never the service registry
  return (cell: unknown): { supported: boolean; extended: boolean; target?: string | null } => {
    const metadata = cell as { hasExtendedAttrs?: () => number; extended?: { urlId?: unknown } };
    // unknown cell layouts must not let text overlays shadow explicit destinations
    if (typeof metadata.hasExtendedAttrs !== 'function') return { supported: false, extended: false };
    // fresh cells still require the extended flag; recycled fields can contain stale ids
    if (!metadata.hasExtendedAttrs()) return { supported: true, extended: false };
    const id = metadata.extended?.urlId;
    // extended styling alone is not a hyperlink
    if (id === undefined || id === 0) return { supported: true, extended: true };
    // reserve malformed identities rather than guessing their visible labels
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return { supported: true, extended: true, target: null };
    // copy the destination once per snapshot
    if (!targets.has(id)) {
      const data = typeof service?.getLinkData === 'function' ? service.getLinkData(id) : undefined;
      targets.set(id, typeof data?.uri === 'string' ? safeHttpTarget(data.uri) ?? null : null);
    }
    return { supported: true, extended: true, target: targets.get(id)! };
  };
};

// inspect the pinned xterm row layout without retaining its mutable view
const nativeRow = (row: IBufferLine, columns: number, nextWrapped: boolean, cached: CachedRow | undefined): NativeRow | undefined => {
  const identity = (row as unknown as { _line?: unknown })._line;
  // fall back to public cells when the pinned line identity is unavailable
  if (identity === null || typeof identity !== 'object') return undefined;
  const data = (identity as { _data?: unknown })._data;
  // reject partial or upgraded layouts instead of interpreting unknown words
  if (!(data instanceof Uint32Array) || data.length !== row.length * xtermCellSize || columns * xtermCellSize > data.length) return undefined;
  const words = columns * xtermCellSize;
  let contentColumns = 0;
  let identityColumn: number | undefined;
  let cacheable = true;
  let matchesCached = cached !== undefined && cached.identity === identity && cached.data.length === words
    && cached.nextWrapped === nextWrapped && cached.value.columns === columns && cached.value.wrapped === row.isWrapped;
  // reject side tables and compare every retained content and style word
  for (let column = 0; column < columns; column += 1) {
    const offset = column * xtermCellSize;
    const content = data[offset];
    const background = data[offset + 2];
    // retain printed spaces while locating the last non-null cell
    if (content & xtermContentMask) contentColumns = column + 1;
    // remember one cell for the public identity compatibility check
    if (identityColumn === undefined && content >>> xtermWidthShift) identityColumn = column;
    // side tables can change independently of the raw row words
    if ((content & xtermCombinedMask) || (background & xtermExtendedMask)) cacheable = false;
    // any raw content or style change requires a public cell copy
    if (matchesCached && cached !== undefined && (cached.data[offset] !== content || cached.data[offset + 1] !== data[offset + 1] || cached.data[offset + 2] !== background)) matchesCached = false;
  }
  return { identity, data, words, contentColumns, cacheable, matchesCached, ...(identityColumn === undefined ? {} : { identityColumn }) };
};

// verify that an ordinary row still exposes the pinned public identity seam
const hasOrdinaryCellIdentity = (row: IBufferLine, column: number, reusableCell: IBufferCell) => {
  const cell = row.getCell(column, reusableCell) as unknown as { hasExtendedAttrs?: () => number } | undefined;
  return typeof cell?.hasExtendedAttrs === 'function' && !cell.hasExtendedAttrs();
};

// copy one physical row through xterm's public cell contract
const readLinkRow = (
  row: IBufferLine,
  line: number,
  columns: number,
  readColumns: number,
  readExplicit: ReturnType<typeof explicitMetadata>,
  reusableCell: IBufferCell
): { supported: boolean; ordinary: boolean; value: LinkRow } => {
  const cells: LinkCell[] = [];
  let ordinary = true;
  // reuse one public cell; current flags guard its stale combined and extended side fields
  for (let column = 0; column < readColumns; column += 1) {
    const cell = row.getCell(column, reusableCell);
    // wide-character continuation cells have no independent text or target
    if (!cell || !cell.getWidth()) continue;
    const explicit = readExplicit(cell);
    // fail closed if an xterm upgrade removes the identity interface
    if (!explicit.supported) return { supported: false, ordinary: false, value: { line, columns, wrapped: row.isWrapped, cells: [] } };
    // extended cells always require a fresh per-snapshot lookup
    if (explicit.extended) ordinary = false;
    cells.push({
      column, text: cell.getChars(), width: cell.getWidth(),
      style: `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.isUnderline()}:${cell.isInverse()}`,
      accented: !cell.isFgDefault() || !!cell.isUnderline(),
      ...(explicit.target !== undefined ? { explicit: explicit.target } : {})
    });
  }
  return { supported: true, ordinary, value: { line, columns, wrapped: row.isWrapped, cells } };
};

// snapshot bounded viewport context without retaining mutable xterm cells
export const snapshotTerminalLinks = (terminal: XTerm, fresh = false): LinkSnapshot => {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY - linkContextRows);
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows + linkContextRows);
  const readExplicit = explicitMetadata(terminal);
  const reusableCell = buffer.getNullCell();
  const rows: LinkRow[] = [];
  const cachedRows = rowCaches.get(terminal);
  const nextRows = new Map<number, CachedRow>();
  // capture physical rows including native-wrap provenance
  for (let line = start; line < end; line += 1) {
    const row = buffer.getLine(line);
    // tolerate a viewport disappearing during disposal
    if (!row) break;
    const columns = Math.min(row.length, terminal.cols);
    // inspect the following physical row even when it lies just outside the snapshot
    const nextWrapped = buffer.getLine(line + 1)?.isWrapped === true;
    const cached = cachedRows?.get(line);
    const native = nativeRow(row, columns, nextWrapped, cached);
    // reuse only exact ordinary rows after checking the public identity seam
    if (!fresh && native?.cacheable && native.matchesCached && cached
      && (native.identityColumn === undefined || hasOrdinaryCellIdentity(row, native.identityColumn, reusableCell))) {
      rows.push(cached.value);
      nextRows.set(line, cached);
      continue;
    }
    // hard rows need no public copies for layout-only null padding
    const readColumns = native?.cacheable && !nextWrapped ? native.contentColumns : columns;
    // retain the prior fail-closed probe when a trimmed empty row has no copied cells
    if (readColumns === 0 && native?.identityColumn !== undefined && !hasOrdinaryCellIdentity(row, native.identityColumn, reusableCell)) {
      rowCaches.delete(terminal);
      return { rows: [], truncatedStart: false, truncatedEnd: false };
    }
    const captured = readLinkRow(row, line, columns, readColumns, readExplicit, reusableCell);
    // discard prior cache state after an incompatible public identity
    if (!captured.supported) {
      rowCaches.delete(terminal);
      return { rows: [], truncatedStart: false, truncatedEnd: false };
    }
    rows.push(captured.value);
    // retain only bounded ordinary rows with exact raw copies
    if (native?.cacheable && captured.ordinary) {
      nextRows.set(line, { identity: native.identity, data: native.data.slice(0, native.words), nextWrapped, value: captured.value });
    }
  }
  rowCaches.set(terminal, nextRows);
  return { rows, truncatedStart: start > 0 && !!rows[0]?.wrapped, truncatedEnd: end < buffer.length && !!buffer.getLine(end)?.isWrapped };
};
