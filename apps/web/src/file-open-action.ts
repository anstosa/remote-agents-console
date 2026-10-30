import { useSyncExternalStore } from 'react';

export type FileOpenAction = 'preview' | 'edit';

// per-browser default for activating files
const fileOpenActionKey = 'rac.file-open-action';

// read one supported value and retain edit as the default
const read = (): FileOpenAction => {
  try {
    return localStorage.getItem(fileOpenActionKey) === 'preview' ? 'preview' : 'edit';
  } catch {
    return 'edit';
  }
};

let current: FileOpenAction | undefined;
const listeners = new Set<() => void>();

// notify every mounted file opener and settings page
const notify = () => listeners.forEach(listener => listener());

// cache the persisted browser preference
const readFileOpenAction = (): FileOpenAction => {
  // initialize from storage once
  if (current === undefined) current = read();
  return current;
};

// persist one file activation preference
export const setFileOpenAction = (action: FileOpenAction): FileOpenAction => {
  // skip duplicate writes
  if (action === readFileOpenAction()) return action;
  current = action;
  try {
    // keep the edit default absent from storage
    if (action === 'preview') localStorage.setItem(fileOpenActionKey, action);
    else localStorage.removeItem(fileOpenActionKey);
  } catch { /* private-mode storage is non-fatal */ }
  notify();
  return action;
};

// subscribe one mounted consumer
const subscribeFileOpenAction = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// follow the same preference changing in another browser tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    // ignore unrelated storage changes
    if (event.key !== null && event.key !== fileOpenActionKey) return;
    const next = read();
    // ignore an unchanged value
    if (next === current) return;
    current = next;
    notify();
  });
}

// read the live file activation preference
export const useFileOpenAction = (): FileOpenAction =>
  useSyncExternalStore(subscribeFileOpenAction, readFileOpenAction, readFileOpenAction);
