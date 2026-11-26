import type { IBufferRange, Terminal as XTerm } from '@xterm/xterm';
import { snapshotTerminalLinks, type LinkSnapshot } from './terminal-link-metadata.js';
import { resolveTerminalLinks } from './terminal-link-resolver.js';

export type OutputLink = { kind: 'url'|'file'; uri: string; range: IBufferRange };
export type OutputLinkSegment = { column: number; row: number; columns: number };

const currentTargets = new WeakMap<HTMLAnchorElement, () => boolean>();
const resolvedLinks = new WeakMap<XTerm, { snapshot: LinkSnapshot; links: OutputLink[] }>();

// compare immutable row identities produced by the bounded terminal snapshot cache
const sameLinkSnapshot = (left: LinkSnapshot, right: LinkSnapshot) => {
  // reject viewport boundary or row-count changes
  if (left.truncatedStart !== right.truncatedStart || left.truncatedEnd !== right.truncatedEnd || left.rows.length !== right.rows.length) return false;
  // require every physical row to be the exact previously validated value
  for (let index = 0; index < left.rows.length; index += 1) {
    if (left.rows[index] !== right.rows[index]) return false;
  }
  return true;
};

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
export const terminalOutputLinks = (terminal: XTerm, fresh = false): OutputLink[] => {
  const snapshot = snapshotTerminalLinks(terminal, fresh);
  const cached = resolvedLinks.get(terminal);
  // reuse resolution only when every ordinary row is unchanged
  if (!fresh && cached && sameLinkSnapshot(cached.snapshot, snapshot)) return cached.links;
  const links = resolveTerminalLinks(snapshot)
    // preserve every independently selectable logical range
    .flatMap(link => link.ranges.map(range => ({ kind: link.kind, uri: link.uri, range })));
  resolvedLinks.set(terminal, { snapshot, links });
  return links;
};

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

type OverlayGeometry = { left?: string; top?: string; width?: string; height?: string };
type OverlayEntry = {
  anchor: HTMLAnchorElement;
  geometry: OverlayGeometry;
  targetIdentity: string;
};

// position one hit target in xterm's relative cell grid without reading layout
const positionOverlay = (entry: OverlayEntry, segment: OutputLinkSegment, columns: number, rows: number) => {
  const next = {
    left: `${segment.column / columns * 100}%`,
    top: `${segment.row / rows * 100}%`,
    width: `${segment.columns / columns * 100}%`,
    height: `${100 / rows}%`
  };
  // preserve an unchanged horizontal origin
  if (entry.geometry.left !== next.left) { entry.anchor.style.left = next.left; entry.geometry.left = next.left; }
  // preserve an unchanged vertical origin
  if (entry.geometry.top !== next.top) { entry.anchor.style.top = next.top; entry.geometry.top = next.top; }
  // preserve an unchanged hit width
  if (entry.geometry.width !== next.width) { entry.anchor.style.width = next.width; entry.geometry.width = next.width; }
  // preserve an unchanged hit height
  if (entry.geometry.height !== next.height) { entry.anchor.style.height = next.height; entry.geometry.height = next.height; }
};

// render semantic overlays for detected output links
export const createOutputLinkOverlays = (container: HTMLElement, onOpen: () => void, onOpenFile?: (path: string) => void, onOpenUrl?: (url: string) => boolean) => {
  const anchors = new Map<string, OverlayEntry>();
  // isolate the moving hit rectangles from the terminal's own renderer layout
  const layer = document.createElement('div');
  layer.className = 'terminal-link-layer';
  const view = container.ownerDocument.defaultView ?? window;
  // keep one exact pointer gesture separate from programmatic and keyboard activation
  let gesture: { entry: OverlayEntry; identity: string | null } | undefined;
  let gestureRelease: number | undefined;
  // release the conditional window listeners after the gesture's click task
  const finishGesture = () => {
    if (gestureRelease !== undefined) view.clearTimeout(gestureRelease);
    gestureRelease = undefined;
    gesture = undefined;
    view.removeEventListener('pointerup', endGesture, true);
    view.removeEventListener('pointercancel', endGesture, true);
  };
  // allow a following click to verify its identity before clearing canceled or completed drags
  const endGesture = (event: PointerEvent) => {
    if (gesture === undefined) return;
    // a canceled gesture must not authorize an activation in the same event turn
    if (event.type === 'pointercancel') gesture.identity = null;
    if (gestureRelease !== undefined) view.clearTimeout(gestureRelease);
    gestureRelease = view.setTimeout(finishGesture, 0);
  };
  // mark rejected pointerdowns explicitly rather than allowing later clicks to reauthorize them
  const beginGesture = (entry: OverlayEntry, identity: string | null) => {
    finishGesture();
    gesture = { entry, identity };
    view.addEventListener('pointerup', endGesture, true);
    view.addEventListener('pointercancel', endGesture, true);
  };
  // only the pointer gesture associated with this exact anchor can constrain its action
  const pressedIdentity = (entry: OverlayEntry): string | null | undefined => gesture?.entry === entry ? gesture.identity : undefined;
  // remove every active overlay
  const clear = () => {
    finishGesture();
    anchors.forEach(entry => entry.anchor.remove());
    anchors.clear();
    layer.remove();
  };
  // render links over terminal cells
  const render = (terminal: XTerm, fresh = false) => {
    const element = terminal.element;
    const screen = element?.querySelector<HTMLElement>('.xterm-screen');
    // detached terminals have no usable geometry
    if (!element || !screen || !container.contains(screen)) return clear();
    const links = terminalOutputLinks(terminal, fresh);
    // clear absent semantic targets without touching terminal layout
    if (!links.length) return clear();
    // wait for a defined relative terminal grid
    if (!terminal.cols || !terminal.rows) return clear();
    // retain one screen-local relative grid throughout a renderer replacement
    if (layer.parentElement !== screen) screen.append(layer);
    const active = new Set<string>();
    const occurrences = new Map<string, number>();
    // map each detected link to visible segments
    for (const link of links) {
      // unsupported file contexts remain selectable text rather than dead anchors
      if (link.kind === 'file' && !onOpenFile) continue;
      const segments = outputLinkSegments(link.range, terminal.cols, terminal.rows, terminal.buffer.active.viewportY);
      const semantic = `${link.kind}:${link.uri.length}:${link.uri}`;
      // retain anchors across position-only scroll and reflow changes
      for (const segment of segments) {
        const occurrence = occurrences.get(semantic) ?? 0;
        occurrences.set(semantic, occurrence + 1);
        const key = `${semantic}:${occurrence}`;
        const targetIdentity = `${link.range.start.x}:${link.range.start.y}:${link.range.end.x}:${link.range.end.y}:${segment.column}:${segment.row}:${segment.columns}`;
        active.add(key);
        let entry = anchors.get(key);
        // create a stable semantic link once
        if (entry === undefined) {
          const anchor = document.createElement('a');
          const createdEntry: OverlayEntry = { anchor, geometry: {}, targetIdentity };
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
          const isCurrent = (requireLocation = true) => {
            const priorIdentity = anchors.get(key)?.targetIdentity;
            render(terminal, true);
            const current = anchors.get(key);
            return current?.anchor === createdAnchor && createdAnchor.isConnected
              && (!requireLocation || priorIdentity === current.targetIdentity);
          };
          currentTargets.set(anchor, () => isCurrent()
            && (pressedIdentity(createdEntry) === undefined || pressedIdentity(createdEntry) === createdEntry.targetIdentity));
          // cancel obsolete native actions before they can navigate
          const guardCurrentTarget = (event: Event) => {
            const keyboardAction = event.type === 'keydown';
            // keyboard activation uses the focused semantic target, never an abandoned pointer drag
            if (keyboardAction) finishGesture();
            const current = isCurrent(!keyboardAction);
            // compatibility mousedown must retain an invalid pointerdown rather than replacing it
            if (event.type === 'pointerdown' || event.type === 'mousedown' && pressedIdentity(createdEntry) === undefined) {
              beginGesture(createdEntry, current ? createdEntry.targetIdentity : null);
            }
            const pressedStillCurrent = keyboardAction || pressedIdentity(createdEntry) === undefined || pressedIdentity(createdEntry) === createdEntry.targetIdentity;
            // an overwrite or reflow invalidates the old hit target instead of opening it
            if (!current || !pressedStillCurrent) {
              if (gesture?.entry === createdEntry) gesture.identity = null;
              event.preventDefault(); event.stopImmediatePropagation();
            }
            // finish each pointer action without carrying identity into the next gesture
            if (event.type === 'click' || event.type === 'auxclick' || event.type === 'contextmenu') finishGesture();
          };
          // native open, copy, and keyboard actions use the same selected destination
          for (const type of ['pointerdown', 'mousedown', 'click', 'auxclick', 'contextmenu', 'keydown']) anchor.addEventListener(type, guardCurrentTarget);
          anchor.addEventListener('mousedown', event => event.stopPropagation());
          anchor.addEventListener('click', event => {
            event.stopPropagation();
            onOpen();
            // open file links in the internal preview
            if (link.kind === 'file') { event.preventDefault(); onOpenFile?.(link.uri); }
            // route ordinary same-stack clicks internally
            else if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && onOpenUrl?.(link.uri)) event.preventDefault();
          });
          layer.append(anchor);
          entry = createdEntry;
          anchors.set(key, entry);
        }
        // retain the anchor in its contained hit-test layer
        if (entry.anchor.parentElement !== layer) layer.append(entry.anchor);
        entry.targetIdentity = targetIdentity;
        positionOverlay(entry, segment, terminal.cols, terminal.rows);
      }
    }
    // discard overlays no longer rendered
    for (const [key, entry] of anchors) if (!active.has(key)) {
      entry.anchor.remove();
      anchors.delete(key);
    }
    // offscreen-only targets need no element in the current renderer
    if (anchors.size === 0) layer.remove();
  };
  return { render, clear };
};
