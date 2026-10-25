// Kindred service worker: shows family alerts as notifications.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'Kindred', body: 'There’s an update.', level: 'fyi', url: '/#/family' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payloads still show the default notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: data.level === 'urgent',
      vibrate: data.level === 'urgent' ? [200, 100, 200, 100, 400] : [100],
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/#/family';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.includes('#/family'));
      if (win) return win.focus();
      return self.clients.openWindow(url);
    }),
  );
});
