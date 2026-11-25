export type ProgressKind = 'working' | 'loading';

const progressAnimations = new Set(['update-border-orbit', 'loading-border-orbit', 'working-status-orbit', 'progress-spinner']);

// align active progress animations to the document clock
function synchronizeRing(ring: Element): void {
  // include the retained mask, border and compact-spinner pseudo elements
  const mask = ring.querySelector(':scope > .working-progress-mask');
  for (const animation of ring.getAnimations({ subtree: true })) {
    // leave unrelated animation names and transitions untouched
    if (!(animation instanceof CSSAnimation) || !progressAnimations.has(animation.animationName)) continue;
    const effect = animation.effect;
    // preserve paused animations and non-document timelines
    if (!(effect instanceof KeyframeEffect) || (effect.target !== ring && effect.target !== mask) || animation.timeline !== document.timeline || animation.playState !== 'running') continue;
    // snap active loops to a shared phase
    animation.startTime = 0;
  }
}

// synchronize late mounts, portals and motion-preference replacements without a frame loop
export function installProgressAnimationSync(): () => void {
  // pseudo-element animation events target the ring or its mask
  const onStart = (event: AnimationEvent): void => {
    // accept only the shared progress pseudo-element animations
    if (!progressAnimations.has(event.animationName) || !(event.target instanceof Element) || !['::before', '::after'].includes(event.pseudoElement)) return;
    // resolve the decorative mask back to its owning ring
    const ring = event.target.closest('.update-progress-ring');
    if (ring !== null && (event.target === ring || event.target === ring.querySelector(':scope > .working-progress-mask'))) synchronizeRing(ring);
  };
  document.addEventListener('animationstart', onStart);
  // include any progress surface painted before bootstrap
  for (const ring of Array.from(document.querySelectorAll('.update-progress-ring'))) synchronizeRing(ring);
  // release this document's listener when its owner is disposed
  return () => document.removeEventListener('animationstart', onStart);
}
