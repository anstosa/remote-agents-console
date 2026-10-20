import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createOutputLinkOverlays } from '../src/output-links.js';
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
          if (property === 'getCell') return (column: number) => {
            const cell = target.getCell(column);
            return cell === undefined ? undefined : new Proxy(cell, { get: (next, name) => name === 'hasExtendedAttrs' ? undefined : Reflect.get(next, name, next) });
          };
          return Reflect.get(target, property, target);
        }
      });
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
