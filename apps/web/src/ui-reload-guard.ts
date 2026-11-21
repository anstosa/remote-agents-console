import { useLayoutEffect, useSyncExternalStore } from 'react';

const reloadBlockers = new Set<symbol>();
const listeners = new Set<() => void>();

// read the current blockers without asking the user to discard anything
export const hasUiReloadBlockers = (): boolean => reloadBlockers.size > 0;

// update a draft owner's blocker and notify only when reload safety changes
export function setUiReloadBlocker(owner: symbol, blocked: boolean): void {
  const before = hasUiReloadBlockers();
  // keep only owners with pending work in the set
  if (blocked) reloadBlockers.add(owner);
  else reloadBlockers.delete(owner);
  // update mounted guidance after the first blocker arrives or the last leaves
  if (before !== hasUiReloadBlockers()) listeners.forEach(notify => notify());
}

// retain only mounted subscribers to the current reload guidance
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
};

// expose the current blocked state without latching stale guidance
export const useUiReloadBlocked = (): boolean => useSyncExternalStore(subscribe, hasUiReloadBlockers);

// keep a background update from discarding work that only lives in this document
export function useUiReloadBlocker(blocked: boolean): void {
  // publish the guard before a painted reload can proceed
  useLayoutEffect(() => {
    // leave clean workspaces out of the registry
    if (!blocked) return;
    const key = Symbol();
    setUiReloadBlocker(key, true);
    return () => { setUiReloadBlocker(key, false); };
  }, [blocked]);
}
