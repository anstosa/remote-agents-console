export type ProgressKind = 'working' | 'loading';

const progressAnimations = new Set(['update-border-orbit', 'loading-border-orbit', 'progress-spinner']);

// align only active infinite progress animations to the document clock
function synchronizeRing(ring: Element): void {
  // include the border and compact-spinner pseudo elements
  for (const animation of ring.getAnimations({ subtree: true })) {
    // leave unrelated animation names and transitions untouched
    if (!(animation instanceof CSSAnimation) || !progressAnimations.has(animation.animationName)) continue;
    const effect = animation.effect;
    // preserve paused animations and non-document timelines
    if (!(effect instanceof KeyframeEffect) || effect.target !== ring || animation.timeline !== document.timeline || animation.playState !== 'running') continue;
    // never seek a finite animation past its final frame
    if (effect.getTiming().iterations !== Infinity) continue;
    animation.startTime = 0;
  }
}

// synchronize late mounts, portals and motion-preference replacements without a frame loop
export function installProgressAnimationSync(): () => void {
  // pseudo-element animation events target their owning ring
  const onStart = (event: AnimationEvent): void => {
    // accept only the shared progress pseudo-element animations
    if (!progressAnimations.has(event.animationName) || !(event.target instanceof Element) || !event.target.classList.contains('update-progress-ring') || !['::before', '::after'].includes(event.pseudoElement)) return;
    synchronizeRing(event.target);
  };
  document.addEventListener('animationstart', onStart);
  // include any progress surface painted before bootstrap
  for (const ring of Array.from(document.querySelectorAll('.update-progress-ring'))) synchronizeRing(ring);
  // release this document's listener when its owner is disposed
  return () => document.removeEventListener('animationstart', onStart);
}
