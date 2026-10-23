/* Offline cache. Bump VERSION whenever any app file changes. */
var VERSION = 'jin-v2.1.0';
var SHELL = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
var FONT_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap';

self.addEventListener('install', function (e) {
  // One missing file must not stop the whole install (the app shell is what makes offline work).
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.concat([FONT_CSS]).map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // API calls are POST: never cached
  var url = new URL(req.url);
  if (url.hostname.indexOf('script.google') >= 0) return;
  // Fonts: keep after first load so the app looks the same offline; offline without them falls back to system-ui.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(function (c) {
      return c.match(req, { ignoreVary: true }).then(function (hit) {
        return hit || fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; })
          .catch(function () { return new Response('', { status: 503 }); });
      });
    }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok && url.origin === self.location.origin) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return caches.match('index.html'); });
  }));
});
