import { Terminal as XTerm, type IBufferCell } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createOutputLinkOverlays } from '../src/output-links.js';
import { snapshotTerminalLinks } from '../src/terminal-link-metadata.js';
import '../src/styles.css';

let terminal: XTerm | undefined;
let overlays: ReturnType<typeof createOutputLinkOverlays> | undefined;

type TerminalLinkScenarioOptions = {
  columns?: number;
  rows?: number;
  scrollback?: number;
  fileCapability?: boolean;
  missingOscLookup?: boolean;
  missingCellMetadata?: boolean;
  missingNativeRow?: boolean;
};

// wait for one painted frame
const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

// render one real xterm scenario
export const renderTerminalLinkScenario = async (container: HTMLElement, output: string, options: TerminalLinkScenarioOptions = {}) => {
  const columns = options.columns ?? 96;
  const rows = options.rows ?? 10;
  container.style.position = 'relative';
  container.style.width = '960px';
  container.style.height = `${Math.max(240, rows * 20)}px`;
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  container.append(host);
  terminal = new XTerm({ cols: columns, rows, scrollback: options.scrollback ?? 1000, convertEol: true, fontSize: 14 });
  overlays = createOutputLinkOverlays(
    container,
    () => { document.body.dataset.opened = 'true'; },
    options.fileCapability ? path => { document.body.dataset.openedFile = path; } : undefined
  );
  terminal.open(host);
  await new Promise<void>(resolve => terminal!.write(output, resolve));
  // emulate a pinned-runtime lookup seam disappearing before the first model read
  if (options.missingOscLookup) {
    const runtime = terminal as unknown as { _core?: { _oscLinkService?: { getLinkData?: unknown } } };
    // shadow the optional lookup only when present
    if (runtime._core?._oscLinkService !== undefined) runtime._core._oscLinkService.getLinkData = undefined;
  }
  // emulate an incompatible cell identity shape before the first model read
  if (options.missingCellMetadata) {
    const buffer = terminal.buffer.active;
    const originalGetLine = buffer.getLine.bind(buffer);
    Object.defineProperty(buffer, 'getLine', { configurable: true, value: (line: number) => {
      const row = originalGetLine(line);
      // preserve absent rows
      if (row === undefined) return undefined;
      return new Proxy(row, {
        get: (target, property) => {
          // hide only the pinned metadata method
          if (property === 'getCell') return (column: number, reusableCell?: IBufferCell) => {
            const cell = target.getCell(column, reusableCell);
            return cell === undefined ? undefined : new Proxy(cell, { get: (next, name) => name === 'hasExtendedAttrs' ? undefined : Reflect.get(next, name, next) });
          };
          return Reflect.get(target, property, target);
        }
      });
    } });
  }
  // emulate an unrecognized private row while retaining the complete public contract
  if (options.missingNativeRow) {
    const buffer = terminal.buffer.active;
    const originalGetLine = buffer.getLine.bind(buffer);
    Object.defineProperty(buffer, 'getLine', { configurable: true, value: (line: number) => {
      const row = originalGetLine(line);
      // preserve absent rows
      if (row === undefined) return undefined;
      return new Proxy(row, { get: (target, property) => {
        // hide only the private row while binding public cell reads to the real view
        if (property === '_line') return undefined;
        if (property === 'getCell') return (column: number, reusableCell?: IBufferCell) => target.getCell(column, reusableCell);
        return Reflect.get(target, property, target);
      } });
    } });
  }
  await painted();
  overlays.render(terminal);
  container.dataset.ready = 'true';
};

// append output without repainting the semantic layer
export const writeTerminalBytesOnly = async (output: string) => {
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  await new Promise<void>(resolve => terminal!.write(output, resolve));
  await painted();
};

// repaint without changing terminal cells
export const refreshTerminalLinks = async () => {
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  await painted();
  overlays.render(terminal);
};

// prove semantic overlay refresh does not synchronously measure terminal layout
export const refreshTerminalLinksWithoutLayoutReads = () => {
  // require the mounted terminal, screen and overlay renderer
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  const container = document.querySelector<HTMLElement>('#terminal-link-redesign');
  // require both former layout-read targets
  if (screen === null || screen === undefined || container === null) throw new Error('terminal link geometry fixture is unavailable');
  const screenBounds = screen.getBoundingClientRect;
  const containerBounds = container.getBoundingClientRect;
  screen.getBoundingClientRect = () => { throw new Error('screen layout was read'); };
  container.getBoundingClientRect = () => { throw new Error('container layout was read'); };
  try { overlays.render(terminal); }
  finally {
    screen.getBoundingClientRect = screenBounds;
    container.getBoundingClientRect = containerBounds;
  }
  return screen.querySelector('.output-link-overlay') !== null;
};

// report immutable cell styles through the production snapshot cache
export const terminalLinkCellStyles = () => {
  // require the mounted terminal before reading its public buffer
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  return snapshotTerminalLinks(terminal).rows.flatMap(row => row.cells.map(cell => cell.style));
};

// measure public cell reads and anchor identity across unchanged model refreshes
export const measureTerminalLinkRowReuse = (renders: number) => {
  // require the mounted terminal and overlay renderer
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  const buffer = terminal.buffer.active;
  const originalDescriptor = Object.getOwnPropertyDescriptor(buffer, 'getLine');
  const originalGetLine = buffer.getLine.bind(buffer);
  let cellReads = 0;
  const firstAnchor = document.querySelector<HTMLAnchorElement>('#terminal-link-redesign .output-link-overlay');
  Object.defineProperty(buffer, 'getLine', { configurable: true, value: (line: number) => {
    const row = originalGetLine(line);
    // preserve missing rows at the bounded snapshot edge
    if (row === undefined) return undefined;
    return new Proxy(row, {
      get: (target, property) => {
        // count public cell copies without hiding the pinned native row identity
        if (property === 'getCell') return (column: number, reusableCell?: IBufferCell) => { cellReads += 1; return target.getCell(column, reusableCell); };
        return Reflect.get(target, property, target);
      }
    });
  } });
  try {
    // exercise only unchanged ordinary rows
    for (let render = 0; render < renders; render += 1) overlays.render(terminal);
  } finally {
    // restore the fixture's original public buffer shape
    if (originalDescriptor === undefined) delete (buffer as unknown as { getLine?: unknown }).getLine;
    else Object.defineProperty(buffer, 'getLine', originalDescriptor);
  }
  return {
    cellReads,
    sameAnchor: firstAnchor !== null && firstAnchor === document.querySelector('#terminal-link-redesign .output-link-overlay')
  };
};

// measure one fresh public snapshot without hiding its pinned native row
export const measureFreshTerminalLinkSnapshot = () => {
  // require the mounted terminal before instrumenting public cell copies
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  const buffer = terminal.buffer.active;
  const originalDescriptor = Object.getOwnPropertyDescriptor(buffer, 'getLine');
  const originalGetLine = buffer.getLine.bind(buffer);
  const reusedCells = new Set<IBufferCell>();
  const reads = new Map<number, number>();
  Object.defineProperty(buffer, 'getLine', { configurable: true, value: (line: number) => {
    const row = originalGetLine(line);
    // preserve missing rows at the bounded snapshot edge
    if (row === undefined) return undefined;
    return new Proxy(row, {
      get: (target, property) => {
        // record public copies and the caller-provided reusable cell
        if (property === 'getCell') return (column: number, reusableCell?: IBufferCell) => {
          reads.set(line, (reads.get(line) ?? 0) + 1);
          if (reusableCell !== undefined) reusedCells.add(reusableCell);
          return target.getCell(column, reusableCell);
        };
        return Reflect.get(target, property, target);
      }
    });
  } });
  try {
    const snapshot = snapshotTerminalLinks(terminal, true);
    return {
      cellReads: [...reads.values()].reduce((total, count) => total + count, 0),
      reads: Object.fromEntries(reads),
      reusedCells: reusedCells.size,
      rows: snapshot.rows.map(row => ({ line: row.line, columns: row.columns, wrapped: row.wrapped, cells: row.cells.map(cell => ({ column: cell.column, text: cell.text, width: cell.width })) })),
      truncatedEnd: snapshot.truncatedEnd
    };
  } finally {
    // restore the fixture's original public buffer shape
    if (originalDescriptor === undefined) delete (buffer as unknown as { getLine?: unknown }).getLine;
    else Object.defineProperty(buffer, 'getLine', originalDescriptor);
  }
};

// prove a following-row wrap change invalidates the cached current row
export const measureTerminalLinkNextWrapInvalidation = () => {
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  const buffer = terminal.buffer.active;
  const before = snapshotTerminalLinks(terminal);
  const current = before.rows.find(row => row.cells.some(cell => cell.text));
  const following = current === undefined ? undefined : buffer.getLine(current.line + 1);
  const native = (following as unknown as { _line?: { isWrapped?: boolean } } | undefined)?._line;
  // require one mutable pinned successor for the compatibility test
  if (current === undefined || native === undefined) throw new Error('terminal link wrap fixture is unavailable');
  const original = native.isWrapped === true;
  native.isWrapped = true;
  try {
    const after = snapshotTerminalLinks(terminal);
    const refreshed = after.rows.find(row => row.line === current.line);
    return { sameRow: current === refreshed, beforeCells: current.cells.length, afterCells: refreshed?.cells.length ?? -1, columns: current.columns };
  } finally {
    native.isWrapped = original;
    snapshotTerminalLinks(terminal, true);
  }
};

// prove a wrapped successor outside the bounded snapshot keeps its preceding row full
export const measureTruncatedTerminalLinkWrap = () => {
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  terminal.scrollToTop();
  const buffer = terminal.buffer.active;
  const before = snapshotTerminalLinks(terminal, true);
  const current = before.rows.at(-1);
  const following = current === undefined ? undefined : buffer.getLine(current.line + 1);
  const native = (following as unknown as { _line?: { isWrapped?: boolean } } | undefined)?._line;
  // require a real row just beyond the bounded snapshot
  if (current === undefined || native === undefined) throw new Error('terminal link truncation fixture is unavailable');
  const original = native.isWrapped === true;
  native.isWrapped = true;
  try {
    const after = snapshotTerminalLinks(terminal);
    const refreshed = after.rows.at(-1);
    return { truncatedEnd: after.truncatedEnd, sameRow: current === refreshed, cells: refreshed?.cells.length ?? -1, columns: current.columns };
  } finally {
    native.isWrapped = original;
    snapshotTerminalLinks(terminal, true);
    terminal.scrollToBottom();
  }
};

// append output and repaint overlays
export const writeTerminalLinkOutput = async (output: string) => {
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  await new Promise<void>(resolve => terminal!.write(output, resolve));
  await painted();
  overlays.render(terminal);
};

// resize the current terminal and repaint overlays
export const resizeTerminalLinkOutput = async (columns: number, rows = 10) => {
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  terminal.resize(columns, rows);
  await painted();
  overlays.render(terminal);
};

// reset the current terminal and repaint overlays
export const resetTerminalLinkOutput = async () => {
  if (terminal === undefined || overlays === undefined) throw new Error('terminal link fixture is unavailable');
  terminal.reset();
  await painted();
  overlays.render(terminal);
};

// report occupied public buffer rows after reflow
export const terminalOccupiedRows = () => {
  if (terminal === undefined) throw new Error('terminal link fixture is unavailable');
  const buffer = terminal.buffer.active;
  const rows: Array<{ text: string; wrapped: boolean }> = [];
  // copy only rows with visible text
  for (let line = 0; line < buffer.length; line += 1) {
    const row = buffer.getLine(line);
    const text = row?.translateToString(true) ?? '';
    // omit empty layout rows
    if (text) rows.push({ text, wrapped: row?.isWrapped ?? false });
  }
  return rows;
};
