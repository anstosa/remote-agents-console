import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

const desktopWidth = 980;
const maxZoom = 4;
type Viewport = { scale: number; x: number; y: number };
type Gesture = { viewport: Viewport; anchorX: number; anchorY: number };

// retain a stable desktop layout while changing only its visible area
export function useBrowserZoom(shellRef: RefObject<HTMLDivElement | null>, frameRef: RefObject<HTMLIFrameElement | null>, phoneDesktop: boolean, managedOrigin?: string) {
  const resetRef = useRef<(() => void) | undefined>(undefined);
  const generation = useRef(0);
  // expose navigation resets without recreating the viewport controller
  const resetZoom = useCallback(() => resetRef.current?.(), []);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const frame = frameRef.current;
    // desktop and mobile layouts do not need phone emulation
    if (!shell || !frame || !phoneDesktop) return;
    let fit = 1;
    let layoutHeight = 0;
    let viewport: Viewport = { scale: fit, x: 0, y: 0 };
    let gesture: Gesture | undefined;

    // publish the current pan bounds to the cooperative page
    const publish = (reset = false, continuing?: number) => {
      // never send controls to an unrelated origin
      if (!managedOrigin) return;
      frame.contentWindow?.postMessage({
        type: 'rac-browser-zoom-state',
        generation: generation.current,
        reset,
        continuing,
        zoomed: viewport.scale > fit,
        canPanUp: viewport.y > shell.clientHeight - layoutHeight * viewport.scale + 1,
        canPanDown: viewport.y < -1
      }, managedOrigin);
    };

    // constrain the translated iframe to cover the visible split
    const render = (next: Viewport, reset = false) => {
      const scale = Math.max(fit, Math.min(fit * maxZoom, next.scale));
      viewport = {
        scale,
        x: Math.min(0, Math.max(shell.clientWidth - desktopWidth * scale, next.x)),
        y: Math.min(0, Math.max(shell.clientHeight - layoutHeight * scale, next.y))
      };
      shell.style.setProperty('--browser-desktop-scale', String(scale));
      shell.style.setProperty('--browser-desktop-x', `${viewport.x}px`);
      shell.style.setProperty('--browser-desktop-y', `${viewport.y}px`);
      publish(reset);
    };

    // refit on viewport changes and discard stale gesture coordinates
    const measure = () => {
      const width = shell.clientWidth;
      const height = shell.clientHeight;
      // wait for a visible split
      if (width <= 0 || height <= 0) {
        // invalidate the last measured viewport while hidden
        if (layoutHeight > 0) { layoutHeight = 0; reset(); }
        return;
      }
      const nextFit = Math.min(width / desktopWidth, 1);
      const nextHeight = height / nextFit;
      // preserve zoom when observers report identical dimensions
      if (nextFit === fit && nextHeight === layoutHeight) return;
      fit = nextFit;
      layoutHeight = nextHeight;
      shell.style.setProperty('--browser-desktop-height', `${layoutHeight}px`);
      reset();
    };

    // reset zoom for each newly loaded document
    const reset = () => {
      generation.current += 1;
      gesture = undefined;
      render({ scale: fit, x: 0, y: 0 }, true);
    };

    // consume only this managed iframe's gesture reports
    const receive = (event: MessageEvent) => {
      // reject unrelated sources and malformed messages
      if (!managedOrigin || event.origin !== managedOrigin || event.source !== frame.contentWindow || !event.data) return;
      const { type, x, y, ratio } = event.data;
      // respond to bridge startup even if it precedes the load event
      if (type === 'rac-browser-zoom-ready') { reset(); return; }
      // reject queued movement from a viewport that has since reset
      if (event.data.generation !== generation.current) return;
      // finish or cancel the current gesture
      if (type === 'rac-browser-zoom-end') {
        const continuing = event.data.continuing;
        const active = gesture !== undefined;
        gesture = undefined;
        // acknowledge the final pinch state only for an active gesture
        if (active && Number.isSafeInteger(continuing)) publish(false, continuing);
        return;
      }
      // only accept finite gesture coordinates
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // capture the layout point beneath the fingers before transforming
      if (type === 'rac-browser-zoom-start') {
        gesture = { viewport, anchorX: x, anchorY: y };
        return;
      }
      // reject stale or invalid updates
      if (type !== 'rac-browser-zoom-move' || !gesture || !Number.isFinite(ratio) || ratio <= 0) return;
      const start = gesture.viewport;
      const scale = Math.max(fit, Math.min(fit * maxZoom, start.scale * ratio));
      render({
        scale,
        x: start.x + x + gesture.anchorX * (start.scale - scale),
        y: start.y + y + gesture.anchorY * (start.scale - scale)
      });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    window.addEventListener('message', receive);
    frame.addEventListener('load', reset);
    resetRef.current = reset;
    measure();
    publish();
    return () => {
      resetRef.current = undefined;
      observer.disconnect();
      window.removeEventListener('message', receive);
      frame.removeEventListener('load', reset);
      // release the bridge before leaving phone desktop mode
      if (managedOrigin) frame.contentWindow?.postMessage({ type: 'rac-browser-zoom-state', disabled: true }, managedOrigin);
      shell.style.removeProperty('--browser-desktop-scale');
      shell.style.removeProperty('--browser-desktop-height');
      shell.style.removeProperty('--browser-desktop-x');
      shell.style.removeProperty('--browser-desktop-y');
    };
  }, [shellRef, frameRef, phoneDesktop, managedOrigin]);
  return resetZoom;
}
