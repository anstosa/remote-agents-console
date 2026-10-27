import type { IBufferRange, Terminal as XTerm } from '@xterm/xterm';
import { snapshotTerminalLinks } from './terminal-link-metadata.js';
import { resolveTerminalLinks } from './terminal-link-resolver.js';

export type OutputLink = { kind: 'url'|'file'; uri: string; range: IBufferRange };
export type OutputLinkSegment = { column: number; row: number; columns: number };

const currentTargets = new WeakMap<HTMLAnchorElement, () => boolean>();

// validate before ancestor capture handlers read a possibly stale anchor
export const currentOutputLinkUrl = (target: EventTarget | null) => {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a.output-link-overlay:not([data-output-file-path])') : null;
  return anchor && currentTargets.get(anchor)?.() ? anchor.href : undefined;
};

// compare one output URL with the configured stack host
export const outputUrlMatchesHost = (candidate: string, homeUrl: string) => {
  try { return new URL(candidate).host === new URL(homeUrl).host; }
  catch { return false; }
};

// adapt selected logical targets to the existing row-local presentation contract
export const terminalOutputLinks = (terminal: XTerm): OutputLink[] => resolveTerminalLinks(snapshotTerminalLinks(terminal))
  .flatMap(link => link.ranges.map(range => ({ kind: link.kind, uri: link.uri, range })));

// clip buffer ranges to the visible terminal grid
export const outputLinkSegments = (range: IBufferRange, columns: number, rows: number, viewportY: number): OutputLinkSegment[] => {
  const firstVisibleLine = viewportY + 1;
  const lastVisibleLine = viewportY + rows;
  const firstLine = Math.max(range.start.y, firstVisibleLine);
  const lastLine = Math.min(range.end.y, lastVisibleLine);
  const segments: OutputLinkSegment[] = [];
  // emit only occupied visible segments
  for (let line = firstLine; line <= lastLine; line += 1) {
    const column = line === range.start.y ? range.start.x - 1 : 0;
    const end = line === range.end.y ? range.end.x : columns;
    // ignore empty or fully clipped ranges
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
    // detached terminals have no usable geometry
    if (!element || !screen) return clear();
    const containerBounds = container.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    // wait for measurable terminal cells
    if (!screenBounds.width || !screenBounds.height || !terminal.cols || !terminal.rows) return clear();
    const cellWidth = screenBounds.width / terminal.cols;
    const cellHeight = screenBounds.height / terminal.rows;
    const active = new Set<string>();
    // map each detected link to visible segments
    for (const link of terminalOutputLinks(terminal)) {
      // unsupported file contexts remain selectable text rather than dead anchors
      if (link.kind === 'file' && !onOpenFile) continue;
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
          const createdAnchor = anchor;
          // refresh the shared model before any action can use a stale destination
          const isCurrent = () => {
            render(terminal);
            return anchors.get(key) === createdAnchor && createdAnchor.isConnected;
          };
          currentTargets.set(anchor, isCurrent);
          // cancel obsolete native actions before they can navigate
          const guardCurrentTarget = (event: Event) => {
            // an overwrite or reflow invalidates the old hit target instead of opening it
            if (!isCurrent()) { event.preventDefault(); event.stopImmediatePropagation(); }
          };
          // native open, copy, and keyboard actions use the same selected destination
          for (const type of ['pointerdown', 'mousedown', 'click', 'auxclick', 'contextmenu', 'keydown']) anchor.addEventListener(type, guardCurrentTarget);
          anchor.addEventListener('mousedown', event => event.stopPropagation());
          // the overlay sits outside xterm's element, so hand the wheel to the terminal beneath it
          anchor.addEventListener('wheel', event => {
            const forwarded = new WheelEvent('wheel', event);
            terminal.element?.querySelector('.xterm-screen')?.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) event.preventDefault();
          }, { passive: false });
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
