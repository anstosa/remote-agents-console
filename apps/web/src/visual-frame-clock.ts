// share one sparse display cadence across independently dirty visual surfaces
export const visualFrameIntervalMs = 100;

// four shared presentation pulses per second with no scheduled gap over 300ms
export const sparseVisualFrame = (frame: number): boolean => frame % 5 === 0 || frame % 5 === 2;
type VisualFrameCallback = (frame: number) => void;
const pendingFrames = new Set<VisualFrameCallback>();
const highVolumeSurfaces = new Set<() => boolean>();
let frameTimer: number | undefined;
let lastDispatchedFrame = -1;

// allow decorative work to share the active high-volume terminal's display pulses
export const observeHighVolumePresentation = (active: () => boolean): (() => void) => {
  highVolumeSurfaces.add(active);
  return () => { highVolumeSurfaces.delete(active); };
};

// inspect only active presentation owners, never poll independently of a display pulse
export const highVolumePresentation = (): boolean => {
  for (const active of highVolumeSurfaces) {
    if (active()) return true;
  }
  return false;
};

// dispatch all dirty surfaces before the same browser animation frame
const dispatchVisualFrame = (target: number) => {
  frameTimer = undefined;
  const frame = Math.max(target, Math.floor(performance.now() / visualFrameIntervalMs));
  lastDispatchedFrame = frame;
  const callbacks = [...pendingFrames];
  pendingFrames.clear();
  // callbacks may schedule the next shared frame while this one runs
  for (const callback of callbacks) callback(frame);
};

// queue one display update at the next document-time bucket
export const scheduleVisualFrame = (callback: VisualFrameCallback): (() => void) => {
  pendingFrames.add(callback);
  // all dirty surfaces share the same deadline
  if (frameTimer === undefined) {
    const now = performance.now();
    const target = Math.max(lastDispatchedFrame + 1, Math.floor(now / visualFrameIntervalMs) + 1);
    frameTimer = window.setTimeout(() => dispatchVisualFrame(target), target * visualFrameIntervalMs - now);
  }
  // release just this surface and retire the empty queue
  return () => {
    pendingFrames.delete(callback);
    // avoid a dormant global animation clock
    if (pendingFrames.size === 0 && frameTimer !== undefined) {
      window.clearTimeout(frameTimer);
      frameTimer = undefined;
    }
  };
};
