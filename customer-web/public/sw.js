// POS_V2 service worker — handles Web Push notifications.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'POS V2', body: event.data?.text() || '' }; }
  const title = data.title || 'POS V2';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'pos-v2',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { url: data.url || '/kitchen' },
    requireInteraction: data.requireInteraction === true,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/kitchen';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.pathname === target) { return c.focus(); }
      } catch {}
    }
    return self.clients.openWindow(target);
  })());
});
