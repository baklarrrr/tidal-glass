'use strict';

// Keeps a copy of the app on the glasses so it still opens when the network is slow or briefly gone.
// Network first, so an update shows up on the very next launch; the copy is only the fallback.
// Only this site's own files are handled; the phone link (MQTT over WebSocket) and artwork always go
// to the network.
const CACHE = 'tidal-glass-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'vendor/mqtt.min.js', 'icon.svg', 'icon-mono.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await Promise.race([
        fetch(event.request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (e) {
      return (await cache.match(event.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
