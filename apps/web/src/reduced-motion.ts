import { booleanPreference } from './browser-preference.js';

// still attention effects and replace progress borders with compact spinners
// for this browser, alongside the os-level prefers-reduced-motion query
// css follows data-motion on the document without a reload
const apply = (enabled: boolean): void => {
  if (typeof document === 'undefined') return;
  if (enabled) document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
};
const reducedMotion = booleanPreference('rac.reduced-motion', false, apply);

// true when either this browser's setting or the OS asks for reduced motion
export const prefersReducedMotion = (): boolean =>
  reducedMotion.get() || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// apply the stored preference once at startup
export const applyReducedMotion = (): void => apply(reducedMotion.get());

export const setReducedMotion = reducedMotion.set;
export const useReducedMotion = reducedMotion.use;
