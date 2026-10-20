import { useSyncExternalStore } from 'react';

// still attention effects and replace progress borders with compact spinners
// for this browser, alongside the os-level prefers-reduced-motion query
// css follows data-motion on the document without a reload
const reducedMotionKey = 'rac.reduced-motion';

// read the opt-in while keeping full motion by default
const read = (): boolean => {
  try {
    return localStorage.getItem(reducedMotionKey) === 'enabled';
  } catch {
    return false;
  }
};

// reflect the preference onto the document so the CSS overrides apply
const apply = (enabled: boolean): void => {
  if (typeof document === 'undefined') return;
  if (enabled) document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
};

let current: boolean | undefined;
const listeners = new Set<() => void>();
// notify every mounted settings page
const notify = () => listeners.forEach(listener => listener());

// expose the cached browser preference
const readReducedMotion = (): boolean => {
  // initialize from storage once
  if (current === undefined) current = read();
  return current;
};

// true when either this browser's setting or the OS asks for reduced motion
export const prefersReducedMotion = (): boolean =>
  readReducedMotion() || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// apply the stored preference once at startup
export const applyReducedMotion = (): void => apply(readReducedMotion());

// persist one motion preference
export const setReducedMotion = (enabled: boolean): boolean => {
  // skip duplicate writes
  if (enabled === readReducedMotion()) return enabled;
  current = enabled;
  try {
    // keep the default absent from storage
    if (enabled) localStorage.setItem(reducedMotionKey, 'enabled');
    else localStorage.removeItem(reducedMotionKey);
  } catch { /* private-mode storage is non-fatal */ }
  apply(enabled);
  notify();
  return enabled;
};

// subscribe one mounted consumer
const subscribeReducedMotion = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// follow the same preference changing in another browser tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    // ignore unrelated storage changes
    if (event.key !== null && event.key !== reducedMotionKey) return;
    const next = read();
    // ignore an unchanged value
    if (next === current) return;
    current = next;
    apply(next);
    notify();
  });
}

// read the live motion preference
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeReducedMotion, readReducedMotion, readReducedMotion);
