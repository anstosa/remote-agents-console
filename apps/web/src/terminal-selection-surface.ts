import type { IBufferLine, Terminal as XTerm } from '@xterm/xterm';

// keep browser ranges on owned nodes rather than xterm's replaceable render trees
export const createTerminalSelectionSurface = (terminal: XTerm, isPresented: () => boolean) => {
  const surface = document.createElement('div');
  surface.className = 'terminal-selection-surface';
  surface.setAttribute('aria-hidden', 'true');
  // keep native hyperlink hover and click events inside xterm's linkifier boundary
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
  screen.append(surface);
  const rows: Array<{ element: HTMLDivElement; text: string; wrapped?: boolean; lineIdentity?: object }> = [];
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  let nativeProjection: boolean | undefined;
  let paused = false;
  let measuredWidth = 0;
  let measuredHeight = 0;
  let appliedWidth = '';
  let appliedFontFamily = '';
  let appliedFontSize = '';
  let appliedCellWidth = '';
  let appliedCellHeight = '';
  let projectedBuffer: string | undefined;
  let projectedViewport = -1;
  let projectedColumns = -1;
  let projectedRows = -1;

  // apply cached screen geometry without forcing another layout measurement
  const applyGeometry = () => {
    // wait until xterm exposes a measurable grid
    if (!measuredWidth || !measuredHeight || !terminal.cols || !terminal.rows) return false;
    const width = `${measuredWidth}px`;
    const fontFamily = terminal.options.fontFamily ?? '';
    const fontSize = `${terminal.options.fontSize}px`;
    const cellWidth = `${measuredWidth / terminal.cols}px`;
    const cellHeight = `${measuredHeight / terminal.rows}px`;
    // avoid invalidating style when the terminal geometry is unchanged
    if (appliedWidth !== width) { surface.style.width = width; appliedWidth = width; }
    if (appliedFontFamily !== fontFamily) { surface.style.fontFamily = fontFamily; appliedFontFamily = fontFamily; }
    if (appliedFontSize !== fontSize) { surface.style.fontSize = fontSize; appliedFontSize = fontSize; }
    if (appliedCellWidth !== cellWidth) { surface.style.setProperty('--selection-cell-width', cellWidth); appliedCellWidth = cellWidth; }
    if (appliedCellHeight !== cellHeight) { surface.style.setProperty('--selection-cell-height', cellHeight); appliedCellHeight = cellHeight; }
    return true;
  };

  // append one completed run instead of mutating a detached span for every character
  const appendRun = (fragment: DocumentFragment, text: string, columns: number) => {
    // omit empty runs from the selectable projection
    if (!text || columns <= 0) return;
    const span = document.createElement('span');
    span.style.width = `calc(var(--selection-cell-width) * ${columns})`;
    span.textContent = text;
    fragment.append(span);
  };

  // use the pinned physical line identity only to locate overlapping scroll rows
  const lineIdentity = (line: IBufferLine | undefined): object | undefined => {
    const identity = (line as unknown as { _line?: unknown } | undefined)?._line;
    return identity !== null && typeof identity === 'object' ? identity : undefined;
  };

  // move already projected rows with the viewport instead of replacing their text spans
  const reuseScrolledRows = (delta: number) => {
    // retain the normal full scan when the previous viewport has no overlap
    if (delta === 0 || Math.abs(delta) >= rows.length) return;
    // recycle only the rows that left the viewport
    if (delta > 0) {
      const moved = rows.splice(0, delta);
      rows.push(...moved);
      surface.append(...moved.map(row => row.element));
    } else {
      const moved = rows.splice(rows.length + delta);
      rows.unshift(...moved);
      surface.prepend(...moved.map(row => row.element));
    }
  };

  // mirror visible cells only while no selection owns their node lifetime
  const render = (range?: { start: number; end: number }) => {
    // queued xterm renders must not project covered or detached frames or invalidate a browser range
    if (paused || !isPresented() || !screen.isConnected) return;
    const buffer = terminal.buffer.active;
    const expanded = coarsePointer.matches || terminal.element?.classList.contains('enable-mouse-events') === true;
    // plain desktop panes use xterm selection rather than the browser-native cell projection
    if (!expanded) {
      const text = Array.from({ length: terminal.rows }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '').join('\n');
      // retain committed text without allocating or laying out a second set of visible cell spans
      if (nativeProjection !== false || surface.textContent !== text) surface.textContent = text;
      nativeProjection = false;
      rows.length = 0;
      projectedBuffer = undefined;
      return;
    }
    // rebuild the exact grid once when a mouse-reporting app or touch device needs native text
    if (nativeProjection !== true) {
      surface.replaceChildren();
      nativeProjection = true;
      projectedBuffer = undefined;
      range = undefined;
    }
    // batch the only synchronous layout reads before any surface style writes
    if (!measuredWidth || !measuredHeight) {
      measuredWidth = screen.clientWidth;
      measuredHeight = screen.clientHeight;
    }
    if (!applyGeometry()) return;
    // remove rows only after a terminal resize and outside selection mode
    while (rows.length > terminal.rows) rows.pop()!.element.remove();
    const cell = buffer.getNullCell();
    const sameGrid = projectedBuffer === buffer.type && projectedColumns === terminal.cols && projectedRows === terminal.rows && rows.length === terminal.rows;
    let delta = 0;
    // physical overlap also handles trimmed scrollback where viewportY alone is misleading
    if (sameGrid && (projectedViewport !== buffer.viewportY || range === undefined || range.start === 0 && range.end >= terminal.rows - 1)) {
      const first = lineIdentity(buffer.getLine(buffer.viewportY));
      // detect overlap only through known native line identities, never infer text from them
      const previousIndex = first === undefined ? -1 : rows.findIndex(row => row.lineIdentity === first);
      if (previousIndex >= 0) delta = previousIndex;
      else if (rows[0]?.lineIdentity !== undefined) {
        // a backward scroll can expose the previous first row farther down the grid
        for (let index = 1; index < terminal.rows; index += 1) {
          if (lineIdentity(buffer.getLine(buffer.viewportY + index)) === rows[0].lineIdentity) { delta = -index; break; }
        }
      }
    }
    // always verify every row's current text after scrolling or changing the buffer grid
    const projectionChanged = !sameGrid || projectedViewport !== buffer.viewportY || delta !== 0;
    if (delta !== 0) reuseScrolledRows(delta);
    projectedBuffer = buffer.type;
    projectedViewport = buffer.viewportY;
    projectedColumns = terminal.cols;
    projectedRows = terminal.rows;
    const first = projectionChanged || range === undefined ? 0 : Math.max(0, range.start);
    const last = projectionChanged || range === undefined ? terminal.rows - 1 : Math.min(terminal.rows - 1, range.end);
    // update changed rows without rebuilding the rest of the projection
    for (let index = first; index <= last; index += 1) {
      let row = rows[index];
      // retain one stable element per visible row
      if (row === undefined) {
        const element = document.createElement('div');
        element.className = 'terminal-selection-row';
        surface.append(element);
        row = { element, text: '\0' };
        rows.push(row);
      }
      const line = buffer.getLine(buffer.viewportY + index);
      row.lineIdentity = lineIdentity(line);
      const wrapped = line?.isWrapped === true;
      // avoid rewriting row metadata when only terminal paint changed
      if (row.wrapped !== wrapped) { row.element.dataset.wrapped = String(wrapped); row.wrapped = wrapped; }
      const text = line?.translateToString(true) ?? '';
      // retain text nodes when only colors or the cursor changed
      if (row.text === text) continue;
      row.text = text;
      const fragment = document.createDocumentFragment();
      // ordinary terminal output maps one printable ascii character to one cell
      if (/^[\x20-\x7e]*$/u.test(text)) {
        appendRun(fragment, text, text.length);
        row.element.replaceChildren(fragment);
        continue;
      }
      let remaining = text.length;
      let asciiText = '';
      let asciiColumns = 0;
      // use public cell widths so wide glyphs and combining characters stay aligned
      for (let column = 0; line !== undefined && column < terminal.cols && remaining > 0; column += 1) {
        line.getCell(column, cell);
        const width = cell.getWidth();
        // wide characters already occupy their trailing zero-width cell
        if (width === 0) continue;
        const characters = cell.getChars() || ' ';
        const ascii = width === 1 && characters.length === 1 && characters.charCodeAt(0) >= 32 && characters.charCodeAt(0) < 127;
        // keep ordinary words together and avoid one node per ascii character
        if (ascii) {
          asciiText += characters;
          asciiColumns += 1;
        } else {
          appendRun(fragment, asciiText, asciiColumns);
          asciiText = '';
          asciiColumns = 0;
          appendRun(fragment, characters, width);
        }
        remaining -= characters.length;
      }
      appendRun(fragment, asciiText, asciiColumns);
      row.element.replaceChildren(fragment);
    }
  };
  const renderSub = terminal.onRender(render);
  // receive future geometry without synchronously measuring after xterm paints
  const resizeObserver = new ResizeObserver(entries => {
    const bounds = entries.at(-1)?.contentRect;
    // ignore callbacks without a current observation
    if (bounds === undefined) return;
    // invalidate detached geometry so reattachment measures its new screen before writing
    if (!bounds.width || !bounds.height) { measuredWidth = 0; measuredHeight = 0; return; }
    // ignore duplicate observations
    if (bounds.width === measuredWidth && bounds.height === measuredHeight) return;
    measuredWidth = bounds.width;
    measuredHeight = bounds.height;
    render();
  });
  resizeObserver.observe(screen);
  // track mouse-reporting and pointer-mode transitions without reading computed layout
  const syncProjectionMode = () => {
    const expanded = coarsePointer.matches || terminal.element?.classList.contains('enable-mouse-events') === true;
    if (nativeProjection !== expanded) render();
  };
  const modeObserver = new MutationObserver(syncProjectionMode);
  modeObserver.observe(terminal.element!, { attributes: true, attributeFilter: ['class'] });
  coarsePointer.addEventListener('change', syncProjectionMode);
  render();

  return {
    // publish the first displayed frame when the terminal removes its initial cover
    publish: () => render(),
    // refresh through the terminal's post-paint boundary when selection ends
    setPaused: (value: boolean) => {
      paused = value;
      // catch up without projecting a viewport the terminal has not painted yet
      if (!paused) terminal.refresh(0, terminal.rows - 1);
    },
    // release subscriptions before disposing the terminal
    dispose: () => {
      renderSub.dispose();
      resizeObserver.disconnect();
      modeObserver.disconnect();
      coarsePointer.removeEventListener('change', syncProjectionMode);
      surface.remove();
    }
  };
};
