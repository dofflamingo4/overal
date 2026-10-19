// Network first, cached copy when offline; shows push notifications sent by the Supabase "notify" function.
const CACHE = 'overal-v6';
const SHELL = ['./', 'index.html', 'app.js', 'logic.js', 'style.css', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => clients.claim()),
));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  const n = e.data?.json() ?? { title: 'Overal' };
  e.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: n.url || './' } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.navigate(url).then((c) => c?.focus()) : clients.openWindow(url);
  }));
});
