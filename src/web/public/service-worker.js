const CACHE = "stone-memory-pwa-v3";
const FALLBACKS = ["/", "/manifest.webmanifest", "/app-logo.jpg", "/pwa-icon-192.png", "/pwa-icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FALLBACKS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("stone-memory-pwa-") && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !/^\/pwa-icon-(192|512)\.png$/.test(url.pathname)) return;
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});
