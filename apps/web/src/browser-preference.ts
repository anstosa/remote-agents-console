import { useSyncExternalStore } from 'react';

// One per-browser on/off preference in localStorage, shared across tabs. Only the
// non-default value is stored, as 'enabled' or 'disabled'. `apply` runs whenever the
// value changes in this tab or another one.
export function booleanPreference(key: string, defaultValue: boolean, apply?: (enabled: boolean) => void) {
  const stored = defaultValue ? 'disabled' : 'enabled';
  const read = (): boolean => {
    try {
      return localStorage.getItem(key) === stored ? !defaultValue : defaultValue;
    } catch {
      return defaultValue;
    }
  };

  let current: boolean | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());

  const get = (): boolean => {
    if (current === undefined) current = read();
    return current;
  };

  const set = (enabled: boolean): boolean => {
    if (enabled === get()) return enabled;
    current = enabled;
    try {
      if (enabled === defaultValue) localStorage.removeItem(key);
      else localStorage.setItem(key, stored);
    } catch { /* private-mode storage is non-fatal */ }
    apply?.(enabled);
    notify();
    return enabled;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== key) return;
      const next = read();
      if (next === current) return;
      current = next;
      apply?.(next);
      notify();
    });
  }

  const use = (): boolean => useSyncExternalStore(subscribe, get, get);
  return { get, set, use };
}
