// شبكة الناس v3.3.1 — Service Worker
// يخزّن غلاف التطبيق (الصفحة + المانيفست + الأيقونات) للتحميل دون إنترنت.
// استراتيجية: غلاف التطبيق من الكاش أولاً ثم الشبكة، وأي طلب آخر من الشبكة.
var CACHE_NAME = "sayegh-mesh-v3.3.1";
var SHELL = ["./v3-3-1.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (c) { return c.addAll(SHELL); }).catch(function () {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  var isShell = SHELL.some(function (p) { return url.pathname.endsWith(p.replace("./", "")); });
  if (isShell) {
    e.respondWith(
      caches.match(e.request).then(function (r) {
        if (r) return r;
        return fetch(e.request).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copy); });
          return resp;
        });
      })
    );
  } else {
    e.respondWith(
      fetch(e.request).catch(function () { return caches.match(e.request); })
    );
  }
});
