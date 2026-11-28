// forward touch gestures from the cooperative desktop preview to its console viewport
export const projectBrowserZoom = (parentOrigin: string) => `
  let zoomState;
  let zoomGesture;
  let pendingPan;
  let continuationSequence = 0;
  let documentActive = true;
  // report only to the configured console
  const postZoom = (type, data = {}) => window.parent.postMessage({ type: 'rac-browser-zoom-' + type, generation: zoomState?.generation, ...data }, ${JSON.stringify(parentOrigin)});
  // use screen coordinates for movement because the iframe transforms during gestures
  const touchCenter = (touches) => {
    const a = touches[0];
    const b = touches[1] || a;
    return {
      x: (a.screenX + b.screenX) / 2,
      y: (a.screenY + b.screenY) / 2,
      localX: (a.clientX + b.clientX) / 2,
      localY: (a.clientY + b.clientY) / 2,
      distance: Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY)
    };
  };
  // capture the starting viewport point
  const startZoom = (center, pinch) => {
    zoomGesture = { center, pinch, dragging: pinch, native: false };
    postZoom('start', { x: center.localX, y: center.localY });
  };
  // begin a pinch immediately or wait for a single-finger drag
  const beginZoom = (event) => {
    pendingPan = undefined;
    // leave normal touch behavior unchanged outside phone desktop mode
    if (!zoomState || event.touches.length === 0) return;
    // abandon gestures with additional fingers
    if (event.touches.length > 2) { endZoom(); return; }
    const pinch = event.touches.length === 2;
    // permit native scrolling and tapping at fit scale
    if (!pinch && !zoomState.zoomed) return;
    const center = touchCenter(event.touches);
    startZoom(center, pinch);
    // suppress native page zoom only for a two-finger gesture
    if (pinch && event.cancelable) event.preventDefault();
  };
  // zoom about the moving midpoint or pan the magnified viewport
  const moveZoom = (event) => {
    // ignore ordinary page scrolling or changed finger counts
    if (!zoomGesture || zoomGesture.native || event.touches.length !== (zoomGesture.pinch ? 2 : 1)) return;
    const center = touchCenter(event.touches);
    const x = center.x - zoomGesture.center.x;
    const y = center.y - zoomGesture.center.y;
    // distinguish a drag from an ordinary tap
    if (!zoomGesture.dragging) {
      // ignore subpixel movement
      if (Math.hypot(x, y) < 5) return;
      // preserve native vertical scrolling at the corresponding pan boundary
      if (Math.abs(y) > Math.abs(x) && ((y < 0 && !zoomState.canPanUp) || (y > 0 && !zoomState.canPanDown))) {
        zoomGesture.native = true;
        return;
      }
      zoomGesture.dragging = true;
    }
    // do not compete with a native gesture that has already started
    if (!event.cancelable) return;
    event.preventDefault();
    postZoom('move', { x, y, ratio: zoomGesture.pinch ? center.distance / Math.max(1, zoomGesture.center.distance) : 1 });
  };
  // terminate when a finger lifts or the browser cancels the gesture
  const endZoom = () => {
    pendingPan = undefined;
    // skip unrelated touch sequences
    if (!zoomGesture) return;
    zoomGesture = undefined;
    postZoom('end');
  };
  // continue panning when one of the pinching fingers lifts
  const finishZoom = (event) => {
    // await the parent's settled zoom before continuing a pinch
    if (zoomGesture?.pinch && event.touches.length === 1) {
      zoomGesture = undefined;
      pendingPan = { center: touchCenter(event.touches), sequence: ++continuationSequence };
      postZoom('end', { continuing: pendingPan.sequence });
      return;
    }
    endZoom();
  };
  // suppress Safari's separate native pinch gesture
  const preventNativeZoom = (event) => { if (event.cancelable) event.preventDefault(); };
  const touchOptions = { capture: true, passive: false };
  // attach blocking listeners only while phone desktop mode is active
  const listenZoom = (enabled) => {
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    window[method]('touchstart', beginZoom, touchOptions);
    window[method]('touchmove', moveZoom, touchOptions);
    window[method]('touchend', finishZoom, true);
    window[method]('touchcancel', endZoom, true);
    window[method]('gesturestart', preventNativeZoom, touchOptions);
    window[method]('gesturechange', preventNativeZoom, touchOptions);
  };
  // accept zoom controls only from the owning console
  window.addEventListener('message', (event) => {
    // reject unrelated window messages
    if (!documentActive || event.source !== window.parent || event.origin !== ${JSON.stringify(parentOrigin)} || event.data?.type !== 'rac-browser-zoom-state') return;
    const wasEnabled = !!zoomState;
    zoomState = event.data.disabled ? undefined : event.data;
    // leave mobile mode and standalone pages free of blocking listeners
    if (wasEnabled !== !!zoomState) listenZoom(!!zoomState);
    // discard stale gestures on authoritative resets
    if (!zoomState || event.data.reset) { zoomGesture = undefined; pendingPan = undefined; }
    // continue only after acknowledgement of the final pinch movement
    if (pendingPan && event.data.continuing === pendingPan.sequence) {
      const { center } = pendingPan;
      pendingPan = undefined;
      // avoid intercepting fit-scale native gestures
      if (zoomState?.zoomed) startZoom(center, false);
    }
  });
  // cancel gestures before caching or unloading this document
  window.addEventListener('pagehide', () => {
    endZoom();
    documentActive = false;
    // cached documents must not retain touch interception
    if (zoomState) listenZoom(false);
    zoomState = undefined;
  });
  // reestablish state after history restoration
  window.addEventListener('pageshow', (event) => {
    documentActive = true;
    // request new state rather than restoring cached listeners
    if (event.persisted) postZoom('ready');
  });
  postZoom('ready');
`;
