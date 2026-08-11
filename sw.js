const CACHE = "famshots-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// App shell: cache-first. Everything else (Dropbox API, CDN models): network-first, no caching of API responses.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin;
  if (!isShell) return; // let Dropbox/API/CDN requests pass straight through

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
