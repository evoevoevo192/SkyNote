/* Стикеры — service worker (generated at build time: see scripts/make-sw.mjs). */
const VERSION = "__VERSION__";
const SHELL = "sticky-shell-" + VERSION;
const IMG = "sticky-img-v1";
const FONT = "sticky-font-v1";
const PRECACHE = __PRECACHE__;
const MAX_IMG = 300;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(new URL(u, self.registration.scope).href, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sticky-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function staleWhileRevalidate(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  // pictures loaded by <img> are cached as "opaque"; the export reads them with fetch (CORS) and needs readable copies,
  // so these two kinds are kept under different keys
  const key = req.mode === "cors" ? new Request(req.url + (req.url.includes("?") ? "&" : "?") + "__cors=1") : req;
  const hit = await cache.match(key);
  const net = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) {
        cache.put(key, res.clone()).then(() => (max ? trim(cacheName, max) : undefined));
      }
      return res;
    })
    .catch(() => undefined);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") {
      // the app opens instantly without a network: network first (short wait), cached shell as the fallback
      event.respondWith(
        withTimeout(fetch(req), 4000)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(new URL("./", self.registration.scope).href, copy));
            }
            return res;
          })
          .catch(async () => {
            const c = await caches.open(SHELL);
            return (await c.match(new URL("./", self.registration.scope).href)) || (await c.match(new URL("index.html", self.registration.scope).href)) || Response.error();
          })
      );
      return;
    }
    // hashed build files, icons, manifest: cache first
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // photos from Supabase Storage (public files and signed background links)
  if (url.pathname.startsWith("/storage/v1/object/")) {
    event.respondWith(staleWhileRevalidate(req, IMG, MAX_IMG));
    return;
  }
  // handwriting font of the "Скевоморфизм" style
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req, FONT, 30));
    return;
  }
  // everything else (Supabase API, auth, realtime) is never touched
});

// tap on a reminder notification: bring the app to the front
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
