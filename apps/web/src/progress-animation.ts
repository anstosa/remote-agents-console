import { highVolumePresentation, scheduleVisualFrame, sparseVisualFrame } from './visual-frame-clock.js';

export type ProgressKind = 'working' | 'loading';

const quietCadence = 12;
const sparseCadence = 4;
const frameInterval = 1_000 / quietCadence;
const phases = Array.from({ length: quietCadence * 2 }, (_, index) => `${index * 360 / (quietCadence * 2)}deg`);
const ownerSelector = '.progress-border, .updates-in-progress';
type Ring = { owner: HTMLElement; target?: HTMLElement; phase?: string };
const rings = new Map<HTMLElement, Ring>();
let active = false;
let timer: number | undefined;
let cancelShared: (() => void) | undefined;
let reducedMotion: MediaQueryList | undefined;
let inputUntil = 0;
let currentFrame = -1;

// restrict decorative work to visible, motion-enabled documents
function canPresent(): boolean {
  return active && document.visibilityState === 'visible' && document.documentElement.dataset.motion !== 'reduced' && !reducedMotion?.matches;
}

// share the terminal's sparse presentation pulses during actual input or rapid output
function cadence(): number {
  return performance.now() < inputUntil || highVolumePresentation() ? sparseCadence : quietCadence;
}

// release only the phase previously written by this registered ring
function retire(element: HTMLElement, ring: Ring): void {
  ring.target?.style.removeProperty('--progress-phase');
  rings.delete(element);
}

// write one shared phase per ring, or per small status control with an external dot
function paint(): void {
  const frame = Math.floor(performance.now() / frameInterval);
  if (frame === currentFrame) return;
  currentFrame = frame;
  const phase = phases[frame % phases.length]!;
  for (const [element, ring] of rings) {
    // discarded or no-longer-busy owners cannot retain a running clock
    if (!element.isConnected || element.parentElement !== ring.owner || !ring.owner.matches(ownerSelector)) {
      retire(element, ring);
      continue;
    }
    const target = ring.owner.classList.contains('progress-status-button') ? ring.owner : element;
    // a conditional status dot can appear or disappear while its control remains busy
    if (target !== ring.target) {
      ring.target?.style.removeProperty('--progress-phase');
      ring.target = target;
      ring.phase = undefined;
    }
    // skip duplicate writes after delayed clock delivery
    if (ring.phase === phase) continue;
    target.style.setProperty('--progress-phase', phase);
    ring.phase = phase;
  }
}

// stop both presentation paths together
function stop(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  cancelShared?.();
  cancelShared = undefined;
}

// service sparse effects on the terminal's already scheduled display pulse
function onShared(frame: number): void {
  cancelShared = undefined;
  if (canPresent() && sparseVisualFrame(frame)) paint();
  reconcile();
}

// keep at most one pending presentation for all progress surfaces
function reconcile(): void {
  if (!canPresent() || rings.size === 0) {
    stop();
    return;
  }
  if (timer !== undefined || cancelShared !== undefined) return;
  if (cadence() === sparseCadence) {
    cancelShared = scheduleVisualFrame(onShared);
    return;
  }
  const now = performance.now();
  paint();
  if (rings.size === 0) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    reconcile();
  }, (Math.floor(now / frameInterval) + 1) * frameInterval - now);
}

// join exactly one direct progress ring to the next shared presentation
function register(element: Element): void {
  if (!canPresent() || !(element instanceof HTMLElement) || !element.classList.contains('update-progress-ring') || rings.has(element)) return;
  const owner = element.parentElement;
  if (!owner?.matches(ownerSelector)) return;
  rings.set(element, { owner });
  reconcile();
}

// rescan only on lifecycle boundaries, never during a presentation pulse
function refresh(): void {
  for (const element of Array.from(document.querySelectorAll('.update-progress-ring'))) register(element);
  reconcile();
}

// expose the actual shared presentation to regression tests
export function progressAnimationSnapshot() {
  return { currentFrame, presentationFramesPerSecond: cadence(), registeredRings: rings.size, running: timer !== undefined || cancelShared !== undefined };
}

// own document registration, visibility and input lifetimes
export function installProgressAnimationSync(): () => void {
  active = true;
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onVisibility = () => {
    document.documentElement.toggleAttribute('data-progress-hidden', document.visibilityState !== 'visible');
    if (canPresent()) refresh();
    else stop();
  };
  const onStart = (event: AnimationEvent) => {
    // the zero-duration mount signal never starts an autonomous visual loop
    if (event.animationName === 'progress-register' && event.target instanceof Element) register(event.target);
  };
  const onMotion = () => {
    if (canPresent()) refresh();
    else {
      stop();
      // static reduced-motion surfaces need no registered phase or retained style
      if (document.documentElement.dataset.motion === 'reduced' || reducedMotion?.matches) {
        for (const [element, ring] of rings) retire(element, ring);
      }
    }
  };
  // yield the next shared presentation window to actual interactive work
  const onInput = () => {
    inputUntil = performance.now() + 1_100;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    reconcile();
  };
  const inputEvents = ['pointerdown', 'wheel', 'keydown', 'input'] as const;
  const motionAttribute = new MutationObserver(onMotion);
  motionAttribute.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  for (const event of inputEvents) document.addEventListener(event, onInput, { capture: true, passive: true });
  document.addEventListener('animationstart', onStart);
  document.addEventListener('visibilitychange', onVisibility);
  reducedMotion.addEventListener('change', onMotion);
  onVisibility();
  // release only this synchronizer's listeners, style and pending clock
  return () => {
    active = false;
    stop();
    for (const [element, ring] of rings) retire(element, ring);
    for (const event of inputEvents) document.removeEventListener(event, onInput, true);
    document.removeEventListener('animationstart', onStart);
    document.removeEventListener('visibilitychange', onVisibility);
    reducedMotion?.removeEventListener('change', onMotion);
    motionAttribute.disconnect();
    document.documentElement.removeAttribute('data-progress-hidden');
  };
}
