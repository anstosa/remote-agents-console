import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlyoutPortal } from './flyout-portal.js';
import { useViewportFlyout } from './viewport-flyout.js';

// one phone split with its key, kind, visible menu title and accessible action label
export type CarouselPanel = { key: string; kind: string; title: string; label: string };

// What the carousel tells the rest of the Workspace: its panels in order, the one in view, and how
// to bring one into view.
export type PanelCarousel = { panels: readonly CarouselPanel[]; visibleKey: string | undefined; show: (key: string) => void };

// retain the last visible split in this browser for each worktree
const lastViewedSplitKey = (worktreeId: string) => `rac.last-split:${worktreeId}`;
// read one bounded preference from optional browser storage
const savedSplit = (worktreeId: string | undefined): string | undefined => {
  // leave unscoped panels ephemeral
  if (worktreeId === undefined) return undefined;
  try {
    const key = localStorage.getItem(lastViewedSplitKey(worktreeId));
    return key !== null && key.length <= 128 ? key : undefined;
  } catch { return undefined; }
};
// save only a real worktree panel
const saveSplit = (worktreeId: string | undefined, key: string | undefined) => {
  // leave unscoped and empty panels ephemeral
  if (worktreeId === undefined || key === undefined) return;
  try { localStorage.setItem(lastViewedSplitKey(worktreeId), key); }
  catch { /* browser storage is optional */ }
};

// move one ordered item horizontally, optionally handling an upward gesture on a chooser
export function usePanelSwipe(carousel: { panels: readonly { key: string }[]; visibleKey: string | undefined; show: (key: string) => void; onSwipeUp?: () => void }) {
  const start = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const touchStart = useRef<{ identifier: number; x: number; y: number } | undefined>(undefined);
  const swiped = useRef(false);
  // handle one deliberate gesture without turning its release into a click
  const finishSwipe = (dx: number, dy: number) => {
    // reserve upward gestures only for controls that explicitly opt in
    if (carousel.onSwipeUp !== undefined && dy <= -40 && -dy > Math.abs(dx) * 1.25) {
      swiped.current = true;
      carousel.onSwipeUp();
      return;
    }
    // preserve taps and vertical content scrolling
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
    swiped.current = true;
    const index = carousel.panels.findIndex(panel => panel.key === carousel.visibleKey);
    const neighbor = carousel.panels[index + (dx < 0 ? 1 : -1)];
    // stay at the first or last split
    if (neighbor !== undefined) carousel.show(neighbor.key);
  };
  // remember only the primary touch within an enabled swipe area
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, enabled = true) => {
    swiped.current = false;
    start.current = undefined;
    // ignore mouse gestures and secondary touches
    if (!enabled || event.pointerType !== 'touch' || !event.isPrimary) return;
    start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  // choose the neighboring split once the finger crosses the horizontal threshold
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = start.current;
    start.current = undefined;
    // touchend owns gestures that also emitted touchstart, even if this pointer was cancelled
    if (touchStart.current !== undefined && event.pointerType === 'touch') return;
    // ignore a touch that did not start in this area
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return;
    finishSwipe(event.clientX - gesture.x, event.clientY - gesture.y);
  };
  // discard a browser-owned gesture such as a vertical scroll
  const onPointerCancel = () => { start.current = undefined; };
  // the diff's shadow scroll surface can cancel pointer events while still delivering touchend
  const onTouchStart = (event: ReactTouchEvent<HTMLElement>, enabled = true) => {
    touchStart.current = undefined;
    swiped.current = false;
    // do not treat a second finger or an excluded area as a carousel swipe
    if (!enabled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStart.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY };
  };
  // use the ending finger when a nested scroller consumed the pointer stream
  const onTouchEnd = (event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchStart.current;
    touchStart.current = undefined;
    start.current = undefined;
    // ignore touches that did not start in a swipe area
    if (gesture === undefined) return;
    const touch = Array.from(event.changedTouches).find(candidate => candidate.identifier === gesture.identifier);
    // ignore another finger ending first
    if (touch === undefined) return;
    finishSwipe(touch.clientX - gesture.x, touch.clientY - gesture.y);
  };
  // discard a cancelled multi-touch or browser gesture
  const onTouchCancel = () => { touchStart.current = undefined; start.current = undefined; };
  // prevent the touch-generated click from opening a menu or editing a note
  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    // preserve normal taps and keyboard activation
    if (!swiped.current || event.detail === 0) return;
    swiped.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  return { onPointerDown, onPointerUp, onPointerCancel, onTouchStart, onTouchEnd, onTouchCancel, onClickCapture };
}

// Track which of a split's panels (`keys`, in column order) is in view. On a phone the split is a
// horizontal scroll-snap carousel, one panel per screen (the CSS lays it out), so the panel in view
// follows the scroll position, and `show` jumps to a panel. A newly opened panel other than the
// agent's comes into view; when the one in view closes, the first panel does. Off the phone no
// scrolling happens, but the panel in view is still tracked, so it is there when the width shrinks.
// Every programmatic scroll is instant: a smooth one is cancelled when a panel's layout changes
// mid-flight (the Code panel loading, say), and the browser re-snaps to the old panel without a
// scroll event, leaving the dots pointing at a panel that is not in view. Only a change of width
// realigns: the toolbar swapping for a Terminal's taller helper keys mid-swipe changes the height,
// and a realign then would yank the carousel from under the finger.
export function usePanelCarousel(containerRef: RefObject<HTMLElement | null>, keys: readonly string[], phone: boolean, worktreeId?: string, initialPanelsReady = true) {
  const [preferred] = useState(() => savedSplit(worktreeId));
  const pendingRestore = useRef(preferred);
  const ignoreHydratedNote = useRef(false);
  const initialPanelsReadyRef = useRef(initialPanelsReady);
  initialPanelsReadyRef.current = initialPanelsReady;
  const scope = useRef(worktreeId);
  const [visibleKey, setVisibleKey] = useState<string | undefined>(preferred ?? keys[0]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const visibleRef = useRef(visibleKey);
  visibleRef.current = visibleKey;
  const previousKeys = useRef(keys);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const scrollTo = useCallback((key: string) => {
    const container = containerRef.current;
    const index = keysRef.current.indexOf(key);
    if (!phoneRef.current || container === null || index < 0) return;
    container.scrollTo({ left: index * container.clientWidth, behavior: 'instant' });
  }, [containerRef]);
  // update the visible panel and optionally remember it
  const choose = useCallback((key: string | undefined, persist = false) => {
    visibleRef.current = key;
    setVisibleKey(key);
    // record deliberate navigation and settled panel changes
    if (persist) saveSplit(worktreeId, key);
  }, [worktreeId]);
  // follow a panel opening or closing, and line the carousel up when the phone layout starts
  const signature = keys.join('|');
  useLayoutEffect(() => {
    // restore a new worktree even if this hook survives a scope change
    if (scope.current !== worktreeId) {
      scope.current = worktreeId;
      pendingRestore.current = savedSplit(worktreeId);
      ignoreHydratedNote.current = false;
      previousKeys.current = keysRef.current;
      const next = pendingRestore.current !== undefined && keysRef.current.includes(pendingRestore.current) ? pendingRestore.current : keysRef.current[0];
      choose(next);
      if (next !== undefined) scrollTo(next);
      return;
    }
    const previous = previousKeys.current;
    const current = keysRef.current;
    previousKeys.current = current;
    const opened = current.find(key => key !== 'agent' && !previous.includes(key));
    const pending = pendingRestore.current;
    // wait for asynchronous panels such as saved Notes before replacing the remembered split
    if (pending !== undefined) {
      // a newly opened non-note panel is a user action, not a delayed note restoration
      if (!initialPanelsReady && opened !== undefined && opened !== 'note') {
        pendingRestore.current = undefined;
        ignoreHydratedNote.current = true;
        choose(opened, true);
        scrollTo(opened);
        return;
      }
      const next = current.includes(pending) ? pending : current[0];
      // finish restoration only after the asynchronous note list settles
      if (initialPanelsReady) pendingRestore.current = undefined;
      choose(next, initialPanelsReady);
      if (next !== undefined) scrollTo(next);
      return;
    }
    const shown = visibleRef.current;
    // do not let a delayed retained Note replace an explicit choice
    const hydratedNote = initialPanelsReady && ignoreHydratedNote.current && opened === 'note';
    if (initialPanelsReady) ignoreHydratedNote.current = false;
    const next = (hydratedNote ? undefined : opened) ?? (shown !== undefined && current.includes(shown) ? shown : current[0]);
    choose(next, true);
    if (next !== undefined) scrollTo(next);
  }, [signature, phone, worktreeId, initialPanelsReady, choose, scrollTo]);
  // a swipe moves the panel in view; a resize (rotation, the software keyboard) keeps it in view
  useEffect(() => {
    const container = containerRef.current;
    if (!phone || container === null) return;
    const follow = () => {
      const width = container.clientWidth;
      const key = width > 0 ? keysRef.current[Math.round(container.scrollLeft / width)] : undefined;
      // remember a real scroll selection
      if (key !== undefined) {
        // an actual swipe takes precedence over a pending Note restoration
        if (!initialPanelsReadyRef.current && key !== visibleRef.current) ignoreHydratedNote.current = true;
        pendingRestore.current = undefined;
        choose(key, true);
      }
    };
    let width = container.clientWidth;
    const realign = () => {
      if (container.clientWidth === width) return;
      width = container.clientWidth;
      if (visibleRef.current !== undefined) scrollTo(visibleRef.current);
    };
    container.addEventListener('scroll', follow, { passive: true });
    const observer = new ResizeObserver(realign);
    observer.observe(container);
    return () => {
      container.removeEventListener('scroll', follow);
      observer.disconnect();
    };
  }, [phone, containerRef, choose, scrollTo]);
  // Bring a panel into view. Focus left in the panel scrolled away (the Agent's pane taking keys)
  // goes with it, so the keyboard and the helper keys never split between two panels. Focus is kept
  // when nothing scrolls away: on desktop, or when the panel is already in view (a new note's editor).
  const show = useCallback((key: string) => {
    if (!keysRef.current.includes(key)) return;
    const focused = document.activeElement;
    if (phoneRef.current && key !== visibleRef.current && focused instanceof HTMLElement && containerRef.current?.contains(focused) === true) focused.blur();
    pendingRestore.current = undefined;
    // an explicit menu selection takes precedence over pending Note hydration
    if (!initialPanelsReadyRef.current) ignoreHydratedNote.current = true;
    choose(key, true);
    scrollTo(key);
  }, [containerRef, choose, scrollTo]);
  return { visibleKey: visibleKey !== undefined && keys.includes(visibleKey) ? visibleKey : keys[0], show };
}

// the toolbar's position dots show the current split; its whole flex area opens a titled chooser
export function PanelDots({ carousel }: { carousel: PanelCarousel }) {
  const [open, setOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(open, { align: 'center' });
  const swipe = usePanelSwipe(carousel);
  // close the chooser before navigating to its selected split
  const select = (key: string) => { setOpen(false); carousel.show(key); anchorRef.current?.focus(); };
  return <><span className="panel-dots" role="group" aria-label="Panels"><button ref={anchorRef} type="button" className="panel-dots-trigger" aria-label="Choose split" aria-haspopup="menu" data-context-flyout aria-expanded={open} onPointerDown={swipe.onPointerDown} onPointerUp={swipe.onPointerUp} onPointerCancel={swipe.onPointerCancel} onClickCapture={swipe.onClickCapture} onClick={() => setOpen(value => !value)}><span className="flyout-caret" aria-hidden="true" />
    {/* keep summary dots in panel order */}
    {carousel.panels.map(panel => <span key={panel.key} className={`panel-dot ${panel.kind}-dot`} aria-hidden="true" title={panel.label} data-current={panel.key === carousel.visibleKey ? 'true' : undefined} />)}
  </button></span>
    {open && <FlyoutPortal onDismiss={() => setOpen(false)}><div ref={flyoutRef} style={style} className="more-menu flyout-menu panel-split-menu" role="menu" aria-label="Splits">
      {/* list titles in the same carousel order */}
      {carousel.panels.map(panel => <button key={panel.key} type="button" role="menuitem" className={`panel-split-row${panel.key === carousel.visibleKey ? ' active' : ''}`} aria-current={panel.key === carousel.visibleKey ? 'true' : undefined} onClick={() => select(panel.key)}><span className={`panel-split-mark ${panel.kind}-dot`} aria-hidden="true" /><span>{panel.title}</span></button>)}
    </div></FlyoutPortal>}
  </>;
}
