self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
// display every received push within the worker lifetime
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  // prefer durable worktree destinations
  const url = typeof data.worktreeId === 'string' ? `/#worktree=${encodeURIComponent(data.worktreeId)}` : data.url ?? '/';
  // date delayed alerts to the original event rather than app opening
  const timestamp = typeof data.sentAt === 'number' && Number.isFinite(data.sentAt) && data.sentAt > 0 ? data.sentAt : undefined;
  event.waitUntil((async () => {
    // honour this browser's sound opt-out, mirrored here by notification-sounds.ts
    const silent = await caches.match('/__rac/notification-sounds-muted', { cacheName: 'rac-preferences' }).then(Boolean, () => false);
    await self.registration.showNotification(data.title ?? 'Remote Agent Console', { body: data.body ?? 'An agent is ready.', tag: data.tag, icon: '/favicon.svg', badge: '/notification-badge.png', timestamp, silent, requireInteraction: data.kind === 'question', data: { url, kind: data.kind, worktreeId: data.worktreeId } });
  })());
});
// route notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    // upgrade already displayed notifications
    const worktreeId = event.notification.data?.worktreeId;
    const destination = typeof worktreeId === 'string' ? `/#worktree=${encodeURIComponent(worktreeId)}` : event.notification.data?.url ?? '/';
    const url = new URL(destination, self.location.origin).href;
    const existing = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = existing.find(candidate => new URL(candidate.url).origin === self.location.origin);
    if (client) {
      const target = await client.navigate(url).catch(() => client);
      return (target?.focus() ?? Promise.resolve()).catch(() => clients.openWindow(url));
    }
    return clients.openWindow(url);
  })());
});
