import type { Terminal as XTerm } from '@xterm/xterm';

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
  return (cell: unknown): { supported: boolean; target?: string | null } => {
    const metadata = cell as { hasExtendedAttrs?: () => number; extended?: { urlId?: unknown } };
    // unknown cell layouts must not let text overlays shadow explicit destinations
    if (typeof metadata.hasExtendedAttrs !== 'function') return { supported: false };
    // fresh cells still require the extended flag; recycled fields can contain stale ids
    if (!metadata.hasExtendedAttrs()) return { supported: true };
    const id = metadata.extended?.urlId;
    // extended styling alone is not a hyperlink
    if (id === undefined || id === 0) return { supported: true };
    // reserve malformed identities rather than guessing their visible labels
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return { supported: true, target: null };
    // copy the destination once per snapshot
    if (!targets.has(id)) {
      const data = typeof service?.getLinkData === 'function' ? service.getLinkData(id) : undefined;
      targets.set(id, typeof data?.uri === 'string' ? safeHttpTarget(data.uri) ?? null : null);
    }
    return { supported: true, target: targets.get(id)! };
  };
};

// snapshot bounded viewport context without retaining mutable xterm cells
export const snapshotTerminalLinks = (terminal: XTerm): LinkSnapshot => {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY - linkContextRows);
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows + linkContextRows);
  const readExplicit = explicitMetadata(terminal);
  const rows: LinkRow[] = [];
  // capture physical rows including native-wrap provenance
  for (let line = start; line < end; line += 1) {
    const row = buffer.getLine(line);
    // tolerate a viewport disappearing during disposal
    if (!row) break;
    const columns = Math.min(row.length, terminal.cols);
    const cells: LinkCell[] = [];
    // use fresh cells because getNullCell reuse retains stale extended fields
    for (let column = 0; column < columns; column += 1) {
      const cell = row.getCell(column);
      // wide-character continuation cells have no independent text or target
      if (!cell || !cell.getWidth()) continue;
      const explicit = readExplicit(cell);
      // fail closed if an xterm upgrade removes the identity interface
      if (!explicit.supported) return { rows: [], truncatedStart: false, truncatedEnd: false };
      cells.push({
        column, text: cell.getChars(), width: cell.getWidth(),
        style: `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.isUnderline()}:${cell.isInverse()}`,
        accented: !cell.isFgDefault() || !!cell.isUnderline(),
        ...(explicit.target !== undefined ? { explicit: explicit.target } : {})
      });
    }
    rows.push({ line, columns, wrapped: row.isWrapped, cells });
  }
  return { rows, truncatedStart: start > 0 && !!rows[0]?.wrapped, truncatedEnd: end < buffer.length && !!buffer.getLine(end)?.isWrapped };
};
