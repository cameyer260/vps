/*
 * Admin Dashboard service worker.
 *
 * Deliberately minimal — this is a live agent dashboard over a Cloudflare
 * tunnel, so correctness beats aggression:
 *  - navigations: network-first, cached app shell as offline fallback
 *  - same-origin static assets (vite /assets/, icons, manifest): stale-while-revalidate
 *  - everything else (API, WebSockets): untouched
 */
const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([SHELL_URL]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(SHELL_CACHE).then((c) => c.put(SHELL_URL, res.clone()));
          return res;
        })
        .catch(() => caches.match(SHELL_URL)),
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
