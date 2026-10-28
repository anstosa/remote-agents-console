import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProgressKind } from './progress-animation.js';

export type FullscreenAction = 'reload' | 'restart' | 'tunnel-reconnect';

type PendingAction = {
  kind: FullscreenAction;
  resolve: (entered: boolean) => void;
};

// coordinate one destructive client action with the painted fullscreen cover
export function useFullscreenAction(): { action?: FullscreenAction; begin: (kind: FullscreenAction) => Promise<boolean>; finish: (kind: FullscreenAction) => void; entered: () => void } {
  const [action, setAction] = useState<FullscreenAction>();
  const actionRef = useRef<FullscreenAction | undefined>(undefined);
  const pendingRef = useRef<PendingAction | undefined>(undefined);

  // lock before react renders so repeated clicks cannot queue another action
  const begin = useCallback((kind: FullscreenAction): Promise<boolean> => {
    // reject every action while one already owns the fullscreen cover
    if (actionRef.current !== undefined) return Promise.resolve(false);
    actionRef.current = kind;
    setAction(kind);
    return new Promise<boolean>(resolve => { pendingRef.current = { kind, resolve }; });
  }, []);

  // release only the matching action and cancel an unpainted start
  const finish = useCallback((kind: FullscreenAction) => {
    // preserve a different action's lock
    if (actionRef.current !== kind) return;
    actionRef.current = undefined;
    setAction(undefined);
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    pending?.resolve(false);
  }, []);

  // allow the owner to mutate only after the cover is fully painted
  const entered = useCallback(() => {
    const pending = pendingRef.current;
    // ignore passive overlays and stale paint notifications
    if (pending === undefined || pending.kind !== actionRef.current) return;
    pendingRef.current = undefined;
    pending.resolve(true);
  }, []);

  // cancel a pending mutation when its app owner unmounts
  useEffect(() => () => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    actionRef.current = undefined;
    pending?.resolve(false);
  }, []);

  return { action, begin, finish, entered };
}

// convert one computed css time token to milliseconds
const cssTimeMs = (value: string): number => {
  const normalized = value.trim();
  // preserve millisecond values directly
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized) || 0;
  // css reports other transition times in seconds
  if (normalized.endsWith('s')) return (Number.parseFloat(normalized) || 0) * 1_000;
  return 0;
};

// find the longest computed transition including its delay
const computedTransitionMs = (style: CSSStyleDeclaration): number => {
  const durations = style.transitionDuration.split(',').map(cssTimeMs);
  const delays = style.transitionDelay.split(',').map(cssTimeMs);
  const count = Math.max(durations.length, delays.length);
  let longest = 0;
  // pair repeated css lists by index
  for (let index = 0; index < count; index += 1) {
    longest = Math.max(longest, durations[index % durations.length] + delays[index % delays.length]);
  }
  return longest;
};

// paint one modal fullscreen status before reporting that its action may begin
export function FullscreenLoader({ label, children, onEntered, focusReturnKey, progressKind = 'working' }: { label: string; children?: ReactNode; onEntered?: () => void; focusReturnKey?: string; progressKind?: ProgressKind }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(false);
  const focusReturnRef = useRef(focusReturnKey);
  const [visible, setVisible] = useState(false);

  // retain the initiating action even when its toast disappears before effects run
  useEffect(() => {
    // keep the last action through passive or durable restart follow-through
    if (focusReturnKey !== undefined) focusReturnRef.current = focusReturnKey;
  }, [focusReturnKey]);

  // let a later action reuse an already-painted passive overlay
  useEffect(() => {
    // clear only when no action owns the painted handoff
    if (onEntered === undefined) reportedRef.current = false;
  }, [onEntered]);

  // retain an initial transparent paint before beginning the fade
  useEffect(() => {
    let fadeFrame: number | undefined;
    const transparentFrame = window.requestAnimationFrame(() => {
      fadeFrame = window.requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      window.cancelAnimationFrame(transparentFrame);
      // cancel the fade when its second frame was scheduled
      if (fadeFrame !== undefined) window.cancelAnimationFrame(fadeFrame);
    };
  }, []);

  // keep keyboard focus out of every covered body-level portal
  useEffect(() => {
    const overlay = overlayRef.current;
    // wait for the portal element before changing its siblings
    if (overlay === null) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousFocusKey = previousFocus?.getAttribute('data-fullscreen-focus-return');
    const inertStates = new Map<HTMLElement, boolean>();
    // make one body sibling unavailable while preserving its prior state
    const coverSibling = (element: HTMLElement) => {
      // exclude the modal cover and avoid recording one sibling twice
      if (element === overlay || inertStates.has(element)) return;
      inertStates.set(element, element.inert);
      // avoid an unnecessary attribute write when already inert
      if (!element.inert) element.inert = true;
    };
    // cover the app root and every existing portal root
    for (const child of Array.from(document.body.children)) {
      // inert applies only to html elements
      if (child instanceof HTMLElement) coverSibling(child);
    }
    // cover dialogs or toast roots portaled in while the loader remains mounted
    const observer = new MutationObserver(records => {
      // inspect every body child addition
      for (const record of records) {
        // cover each new direct body sibling
        for (const node of Array.from(record.addedNodes)) {
          // ignore text and non-html nodes
          if (node instanceof HTMLElement) coverSibling(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });
    overlay.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      // restore each sibling to its exact pre-cover state
      for (const [element, inert] of inertStates) {
        // avoid changing an element already at its original state
        if (element.inert !== inert) element.inert = inert;
      }
      // a removed action leaves body focused before the loader's first effect
      const returnKey = focusReturnRef.current ?? previousFocusKey;
      // restore a surviving control rather than the document body
      if (previousFocus?.isConnected && previousFocus !== document.body && previousFocus !== document.documentElement) previousFocus.focus({ preventScroll: true });
      // rejected actions may recreate their toast button while the loader is mounted
      else if (returnKey) document.querySelector<HTMLElement>(`[data-fullscreen-focus-return="${CSS.escape(returnKey)}"]`)?.focus({ preventScroll: true });
    };
  }, []);

  // resolve after transition completion and a confirmed full-opacity paint
  useEffect(() => {
    const overlay = overlayRef.current;
    // wait until the visible class and an explicit action owner are committed
    if (!visible || overlay === null || onEntered === undefined) return;
    let disposed = false;
    let firstPaintFrame: number | undefined;
    let secondPaintFrame: number | undefined;

    // defer through two frames so the final opacity reaches the compositor
    const reportAfterPaint = () => {
      // schedule one reporting sequence only
      if (reportedRef.current || firstPaintFrame !== undefined) return;
      firstPaintFrame = window.requestAnimationFrame(() => {
        secondPaintFrame = window.requestAnimationFrame(() => {
          // reject teardown after either scheduled frame
          if (disposed || reportedRef.current) return;
          // keep checking an interrupted or delayed compositor transition
          if (Number.parseFloat(getComputedStyle(overlay).opacity) < 1) {
            firstPaintFrame = undefined;
            secondPaintFrame = undefined;
            reportAfterPaint();
            return;
          }
          reportedRef.current = true;
          onEntered();
        });
      });
    };
    // use the real opacity transition as the primary completion signal
    const transitionEnded = (event: TransitionEvent) => {
      // ignore bubbled or unrelated transitions
      if (event.target !== overlay || event.propertyName !== 'opacity') return;
      reportAfterPaint();
    };
    overlay.addEventListener('transitionend', transitionEnded);
    const style = getComputedStyle(overlay);
    const transitionMs = computedTransitionMs(style);
    // reduced motion and passive-to-action handoffs still need a painted frame
    if (transitionMs === 0 || Number.parseFloat(style.opacity) >= 1) reportAfterPaint();
    const fallback = transitionMs === 0 || Number.parseFloat(style.opacity) >= 1 ? undefined : window.setTimeout(reportAfterPaint, transitionMs + 50);
    return () => {
      disposed = true;
      overlay.removeEventListener('transitionend', transitionEnded);
      // cancel only scheduled fallback work
      if (fallback !== undefined) window.clearTimeout(fallback);
      if (firstPaintFrame !== undefined) window.cancelAnimationFrame(firstPaintFrame);
      if (secondPaintFrame !== undefined) window.cancelAnimationFrame(secondPaintFrame);
    };
  }, [onEntered, visible]);

  return createPortal(<div ref={overlayRef} className={`reconnecting-overlay fullscreen-loader${visible ? ' fullscreen-loader-entered' : ''}`} role="alert" aria-label={label} aria-busy="true" tabIndex={-1}>
    <div className="auth-glow" aria-hidden="true" />
    <div className={`loading-console fullscreen-card progress-border progress-mauve${progressKind === 'loading' ? ' progress-loading' : ''}`} aria-busy="true">
      <span className="update-progress-ring" aria-hidden="true" />
      <div className="loading-line">{label}</div>
      {children}
    </div>
  </div>, document.body);
}
