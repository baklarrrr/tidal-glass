'use strict';

// Keeps a copy of the app on the glasses so it still opens when the network is slow or briefly gone.
// Network first, so an update shows up on the very next launch; the copy is only the fallback.
// Only this site's own files are handled; the phone link (MQTT over WebSocket) and artwork always go
// to the network.
const CACHE = 'tidal-glass-v21';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'vendor/mqtt.min.js', 'icon.svg', 'icon-mono.svg', 'sound/', 'sound/index.html', 'sound/icon-mono.svg'];

// An open pre-v20 page can send to Android even after the new worker claims it.
// Carry the upgrade flag across the install/activate lifetime exactly once.
const UPGRADE_FLAG = new URL('.reopen-for-phone-choice-v20', self.registration.scope).href;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const priorShells = (await caches.keys()).filter(key => /^tidal-glass-v\d+$/.test(key) && key !== CACHE);
    const oldOrUnknown = !priorShells.length || priorShells.some(key => Number(key.slice('tidal-glass-v'.length)) < 20);
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(path => new Request(path, {cache: 'reload'})));
    if (self.registration.active && oldOrUnknown) {
      await cache.put(UPGRADE_FLAG, new Response('1'));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const reopenOldPages = await cache.delete(UPGRADE_FLAG);
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => /^tidal-glass-v\d+$/.test(key) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
    if (!reopenOldPages) return;
    const pages = await self.clients.matchAll({type: 'window'});
    for (const page of pages) {
      if (page.url.startsWith(self.registration.scope)) {
        // Queue the navigation now. Its fetch must wait for activation to finish,
        // so waiting for the navigation here would deadlock the open app.
        page.navigate(page.url).catch(() => {});
      }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await Promise.race([
        // no-cache: always ask the server (a tiny 304 when nothing changed), so a Refresh never
        // shows a version the browser's own cache kept for up to ten minutes after an update.
        fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (e) {
      return (await cache.match(event.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
