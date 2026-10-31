import { booleanPreference } from './browser-preference.js';

// the service worker cannot read localStorage, so the opt-out is mirrored here for pushed alerts
const workerPreferenceCache = 'rac-preferences';
const workerPreferenceUrl = '/__rac/notification-sounds-muted';

// expose the opt-out to the service worker
const mirrorToWorker = async (enabled: boolean): Promise<void> => {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(workerPreferenceCache);
    if (enabled) await cache.delete(workerPreferenceUrl);
    else await cache.put(workerPreferenceUrl, new Response('muted'));
  } catch { /* pushed alerts keep their default sound */ }
};

// per-browser opt-out of alert sounds; notifications still show
const notificationSounds = booleanPreference('rac.notification-sounds', true, enabled => { void mirrorToWorker(enabled); });

export const readNotificationSounds = notificationSounds.get;
export const setNotificationSounds = notificationSounds.set;
export const useNotificationSounds = notificationSounds.use;
