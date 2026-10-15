import type { IBufferRange, Terminal as XTerm } from '@xterm/xterm';

const outputUrl = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/;
// retain punctuation and incomplete schemes at captured row boundaries
const outputUrlFragment = /(?:https?|HTTPS?):[/]{0,2}[^\s"'!*(){}|\\^<>`]*$/;
const outputUrlContinuation = /^[^\s"'!*(){}|\\^<>`]/;
// recognize workspace-style file mentions
const outputFile = /(?:^|[\s'"`(<\[])(@?(?:(?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]*[A-Za-z0-9_@+-]|(?:README|LICENSE|Dockerfile|Makefile)(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_@+-]+\.[A-Za-z0-9_-]{1,16})(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)/u;

export type OutputLink = { kind: 'url'|'file'; uri: string; range: IBufferRange };
export type OutputLinkSegment = { column: number; row: number; columns: number };
type OutputLinkFragment = { line: number; column: number; offset: number; text: string };

// compare one output URL with the configured stack host
export const outputUrlMatchesHost = (candidate: string, homeUrl: string) => {
  try { return new URL(candidate).host === new URL(homeUrl).host; }
  catch { return false; }
};

// normalize one file-preview request path
const outputFilePath = (value: string) => value.replace(/^@/u, '').replace(/^file:\/\//u, '').replace(/#L\d+(?:-L\d+)?$/iu, '').replace(/:\d+(?::\d+)?$/u, '');

// map one row's string offset without counting wide-character continuation cells
const outputLinkColumn = (terminal: XTerm, line: number, initialColumn: number, length: number) => {
  const buffer = terminal.buffer.active;
  const row = buffer.getLine(line);
  // reject missing buffer rows
  if (!row) return -1;
  const cell = buffer.getNullCell();
  // walk physical cells while consuming their UTF-16 text
  for (let column = initialColumn; column < row.length; column += 1) {
    row.getCell(column, cell);
    // skip the second cell of a wide glyph
    if (!cell.getWidth()) continue;
    // stop before consuming the requested cell
    if (length <= 0) return column;
    length -= cell.getChars().length || 1;
    // clamp offsets inside a combined glyph
    if (length < 0) return column;
  }
  return length === 0 ? row.length : -1;
};

// preserve native boundary spaces but omit padding before a wrapped wide glyph
const outputLineText = (terminal: XTerm, line: number) => {
  const row = terminal.buffer.active.getLine(line);
  const next = terminal.buffer.active.getLine(line + 1);
  const widePadding = next?.isWrapped && row?.getCell(row.length - 1)?.getChars() === '' && next.getCell(0)?.getWidth() === 2;
  return row?.translateToString(!next?.isWrapped, 0, widePadding ? row.length - 1 : row.length) ?? '';
};

// require URL syntax before treating sentence punctuation as a captured wrap
const urlReachesEnd = (text: string, nextText: string) => outputUrlFragment.test(text)
  && (!/[?:,.]$/u.test(text) || /^[^\s]*[/?#&=%:]/u.test(nextText) || /^\d+(?:\s|$)/u.test(nextText));

// require a matching close before trusting a padded URL delimiter
const capturedUrlCloses = (terminal: XTerm, first: number, indent: number, closing: string) => {
  const buffer = terminal.buffer.active;
  // inspect uninterrupted continuation tokens without joining them yet
  for (let line = first; line < buffer.length; line += 1) {
    const row = buffer.getLine(line);
    const rowText = outputLineText(terminal, line);
    const rowIndent = row?.isWrapped ? 0 : /^ */u.exec(rowText)?.[0].length ?? 0;
    // stop at a different captured layout
    if (!row?.isWrapped && rowIndent !== indent) return false;
    const candidate = rowText.slice(rowIndent);
    // stop at empty rows or a separate destination
    if (!candidate || /^https?:/iu.test(candidate)) return false;
    const end = candidate.search(/[\s"'!*(){}|\\^<>`]/u);
    // only the expected closing delimiter can terminate this URL
    if (end >= 0) return candidate[end] === closing;
  }
  return false;
};

// recognize padded TUI wraps without joining arbitrary neighboring lines
const capturedUrlContinues = (terminal: XTerm, line: number, text: string, nextText: string, indent: number) => {
  const fragment = outputUrlFragment.exec(text);
  // reject delimiters, prose boundaries, and a separate URL
  if (!fragment || !outputUrlContinuation.test(nextText) || /^https?:/iu.test(nextText) || !urlReachesEnd(text, nextText)) return false;
  const opening = text[fragment.index - 1];
  // trust padded delimiter context only when its closing token is present
  if ((opening === '(' || opening === '<') && capturedUrlCloses(terminal, line + 1, indent, opening === '(' ? ')' : '>')) return true;
  const rowText = outputLineText(terminal, line);
  const lastColumn = outputLinkColumn(terminal, line, 0, rowText.length);
  const columns = terminal.buffer.active.getLine(line)?.length ?? terminal.cols;
  // retain the existing full-width captured-wrap heuristic
  if (!indent && lastColumn === columns) return true;
  // retain the original padding after native soft wraps
  const logicalIndent = /^ */u.exec(text)?.[0].length ?? 0;
  const identifierStart = /\/([0-9a-f-]+)$/iu.exec(fragment[0])?.[1];
  // inspect identifier continuations only at matching logical indentation
  if (indent === logicalIndent && identifierStart !== undefined) {
    let continuation = nextText;
    // the UUID suffix may itself span native soft wraps
    for (let following = line + 2; terminal.buffer.active.getLine(following)?.isWrapped; following += 1) {
      continuation += outputLineText(terminal, following);
    }
    const identifierEnd = /^([0-9a-f-]+)(?=[/?#\s)]|$)/iu.exec(continuation)?.[1];
    // rejoin split UUIDs without broadly accepting neighboring prose or paths
    if (identifierEnd !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identifierStart + identifierEnd)) return true;
  }
  const previousIndent = /^ */u.exec(rowText)?.[0].length ?? 0;
  // structural inference away from the edge requires matching indentation
  if (!indent || indent !== previousIndent) return false;
  // accept unfinished query values and explicit numeric ports
  if (/[?&=]$/u.test(fragment[0]) || (/:$/u.test(fragment[0]) && /^\d+(?:\s|$)/u.test(nextText))) return true;
  // filename-only asset wraps are ambiguous without native wrap flags
  const standaloneAsset = /^[A-Za-z0-9_@.+%-]+\.(?:svg|png|jpe?g|gif|webp|ico|html?|pdf|json)[)>]?$/iu.test(nextText);
  // a directory boundary needs path syntax or a standalone web-asset filename
  return /\/$/u.test(fragment[0]) && (/^[^\s]*[/?#&=%]/u.test(nextText)
    || standaloneAsset);
};

// map logical matches to precise row-local ranges, excluding captured padding
const outputLinkRanges = (terminal: XTerm, fragments: OutputLinkFragment[], start: number, length: number): IBufferRange[] => {
  const ranges: IBufferRange[] = [];
  // intersect each physical fragment with the logical match
  for (const fragment of fragments) {
    const from = Math.max(start, fragment.offset);
    const to = Math.min(start + length, fragment.offset + fragment.text.length);
    // ignore rows outside this match
    if (to <= from) continue;
    const startColumn = outputLinkColumn(terminal, fragment.line, fragment.column, from - fragment.offset);
    const endColumn = outputLinkColumn(terminal, fragment.line, fragment.column, to - fragment.offset);
    // reject the whole match rather than exposing a partial target
    if (startColumn < 0 || endColumn <= startColumn) return [];
    ranges.push({ start: { x: startColumn + 1, y: fragment.line + 1 }, end: { x: endColumn, y: fragment.line + 1 } });
  }
  return ranges;
};

// detect output targets across native and inferred captured wraps
export const terminalOutputLinks = (terminal: XTerm): OutputLink[] => {
  const buffer = terminal.buffer.active;
  const links: OutputLink[] = [];
  // scan each logical terminal line
  for (let first = 0; first < buffer.length;) {
    let last = first;
    let text = outputLineText(terminal, first);
    const fragments: OutputLinkFragment[] = [{ line: first, column: 0, offset: 0, text }];
    // join xterm-wrapped rows
    while (last + 1 < buffer.length) {
      const next = buffer.getLine(last + 1);
      const rowText = outputLineText(terminal, last + 1);
      // retain real whitespace on native soft wraps
      const indent = next?.isWrapped ? 0 : /^ */u.exec(rowText)?.[0].length ?? 0;
      const nextText = rowText.slice(indent);
      // infer captured wraps conservatively when native wrap flags are absent
      if (!next?.isWrapped && !capturedUrlContinues(terminal, last, text, nextText, indent)) break;
      last += 1;
      fragments.push({ line: last, column: indent, offset: text.length, text: nextText });
      text += nextText;
    }
    const occupied: Array<{ start: number; end: number }> = [];
    const matcher = new RegExp(outputUrl.source, 'g');
    // retain external URLs first
    for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
      const ranges = outputLinkRanges(terminal, fragments, match.index, match[0].length);
      // skip unmappable terminal cells
      if (!ranges.length) continue;
      occupied.push({ start: match.index, end: match.index + match[0].length });
      // give every physical segment the complete destination
      for (const range of ranges) links.push({ kind: 'url', uri: match[0], range });
    }
    const fileMatcher = new RegExp(outputFile.source, 'gu');
    // retain non-URL file mentions
    for (let match = fileMatcher.exec(text); match !== null; match = fileMatcher.exec(text)) {
      const mention = match[1]!;
      const mentionAt = match.index + match[0].length - mention.length;
      // avoid path-like fragments inside URLs
      if (occupied.some(range => mentionAt < range.end && mentionAt + mention.length > range.start)) continue;
      const path = outputFilePath(mention);
      // ignore empty normalized paths
      if (!path) continue;
      const ranges = outputLinkRanges(terminal, fragments, mentionAt, mention.length);
      // retain the same file target across native wrapped rows
      for (const range of ranges) links.push({ kind: 'file', uri: path, range });
    }
    first = last + 1;
  }
  return links;
};

export const outputLinkSegments = (range: IBufferRange, columns: number, rows: number, viewportY: number): OutputLinkSegment[] => {
  const firstVisibleLine = viewportY + 1;
  const lastVisibleLine = viewportY + rows;
  const firstLine = Math.max(range.start.y, firstVisibleLine);
  const lastLine = Math.min(range.end.y, lastVisibleLine);
  const segments: OutputLinkSegment[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    const column = line === range.start.y ? range.start.x - 1 : 0;
    const end = line === range.end.y ? range.end.x : columns;
    if (end > column) segments.push({ column, row: line - firstVisibleLine, columns: end - column });
  }
  return segments;
};

// render semantic overlays for detected output links
export const createOutputLinkOverlays = (container: HTMLElement, onOpen: () => void, onOpenFile?: (path: string) => void, onOpenUrl?: (url: string) => boolean) => {
  const anchors = new Map<string, HTMLAnchorElement>();
  // remove every active overlay
  const clear = () => {
    anchors.forEach(anchor => anchor.remove());
    anchors.clear();
  };
  // render links over terminal cells
  const render = (terminal: XTerm) => {
    const element = terminal.element;
    const screen = element?.querySelector<HTMLElement>('.xterm-screen');
    if (!element || !screen) return clear();
    const containerBounds = container.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    if (!screenBounds.width || !screenBounds.height || !terminal.cols || !terminal.rows) return clear();
    const cellWidth = screenBounds.width / terminal.cols;
    const cellHeight = screenBounds.height / terminal.rows;
    const active = new Set<string>();
    // map each detected link to visible segments
    for (const link of terminalOutputLinks(terminal)) {
      const segments = outputLinkSegments(link.range, terminal.cols, terminal.rows, terminal.buffer.active.viewportY);
      segments.forEach((segment, index) => {
        const key = `${link.kind}\0${link.uri}\0${segment.column}:${segment.row}:${segment.columns}:${index}`;
        active.add(key);
        let anchor = anchors.get(key);
        // create a stable semantic link once
        if (anchor === undefined) {
          anchor = document.createElement('a');
          anchor.className = 'output-link-overlay';
          // configure external navigation
          if (link.kind === 'url') {
            anchor.href = link.uri;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.title = link.uri;
            anchor.setAttribute('aria-label', `Open ${link.uri}`);
          } else {
            anchor.href = `#file-preview=${encodeURIComponent(link.uri)}`;
            anchor.title = `Preview ${link.uri}`;
            anchor.dataset.outputFilePath = link.uri;
            anchor.setAttribute('aria-label', `Preview ${link.uri}`);
          }
          anchor.style.position = 'absolute';
          anchor.style.zIndex = '10';
          anchor.style.display = 'block';
          anchor.style.background = 'transparent';
          anchor.style.cursor = 'pointer';
          anchor.addEventListener('mousedown', event => event.stopPropagation());
          anchor.addEventListener('click', event => {
            event.stopPropagation();
            onOpen();
            // open file links in the internal preview
            if (link.kind === 'file') { event.preventDefault(); onOpenFile?.(link.uri); }
            // route ordinary same-stack clicks internally
            else if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && onOpenUrl?.(link.uri)) event.preventDefault();
          });
          container.append(anchor);
          anchors.set(key, anchor);
        }
        anchor.style.left = `${screenBounds.left - containerBounds.left + segment.column * cellWidth}px`;
        anchor.style.top = `${screenBounds.top - containerBounds.top + segment.row * cellHeight}px`;
        anchor.style.width = `${segment.columns * cellWidth}px`;
        anchor.style.height = `${cellHeight}px`;
      });
    }
    // discard overlays no longer rendered
    for (const [key, anchor] of anchors) if (!active.has(key)) {
      anchor.remove();
      anchors.delete(key);
    }
  };
  return { render, clear };
};
