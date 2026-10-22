import { useSyncExternalStore } from 'react';

// per-browser opt-out of alert sounds; notifications still show
const notificationSoundsKey = 'rac.notification-sounds';
// the service worker cannot read localStorage, so the opt-out is mirrored here for pushed alerts
const workerPreferenceCache = 'rac-preferences';
const workerPreferenceUrl = '/__rac/notification-sounds-muted';

// keep sounds on unless explicitly disabled
const read = (): boolean => {
  try {
    return localStorage.getItem(notificationSoundsKey) !== 'disabled';
  } catch {
    return true;
  }
};

// expose the opt-out to the service worker
const mirrorToWorker = async (enabled: boolean): Promise<void> => {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(workerPreferenceCache);
    if (enabled) await cache.delete(workerPreferenceUrl);
    else await cache.put(workerPreferenceUrl, new Response('muted'));
  } catch { /* pushed alerts keep their default sound */ }
};

let current: boolean | undefined;
const listeners = new Set<() => void>();
// notify mounted settings consumers
const notify = () => listeners.forEach(listener => listener());

// cache the persisted preference
export const readNotificationSounds = (): boolean => {
  // initialize from storage once
  if (current === undefined) current = read();
  return current;
};

// persist one sound preference
export const setNotificationSounds = (enabled: boolean): boolean => {
  // skip duplicate writes
  if (enabled === readNotificationSounds()) return enabled;
  current = enabled;
  try {
    // keep the default absent from storage
    if (enabled) localStorage.removeItem(notificationSoundsKey);
    else localStorage.setItem(notificationSoundsKey, 'disabled');
  } catch { /* private-mode storage is non-fatal */ }
  void mirrorToWorker(enabled);
  notify();
  return enabled;
};

// subscribe one mounted settings consumer
const subscribeNotificationSounds = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// follow the same preference changing in another browser tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    // ignore unrelated storage changes
    if (event.key !== null && event.key !== notificationSoundsKey) return;
    const next = read();
    // ignore an unchanged value
    if (next === current) return;
    current = next;
    notify();
  });
}

// read the live sound preference
export const useNotificationSounds = (): boolean =>
  useSyncExternalStore(subscribeNotificationSounds, readNotificationSounds, readNotificationSounds);
