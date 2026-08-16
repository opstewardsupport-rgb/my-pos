// Minimal service worker — its only job is to make the browser consider
// this site "installable" (a PWA requirement on Android/desktop; iOS
// doesn't require one at all, but it doesn't hurt to have it there too)
// and to let the POS keep working, cache-first, if the connection drops
// mid-shift. It deliberately does NOT try to cache/replay POS data itself
// (sales, cart, etc.) — that's already handled by this app's own
// localStorage/Supabase sync logic. This only caches the static app shell
// (the HTML/JS/CSS bundle), not any business data.

const CACHE_NAME = "opsteward-shell-v1";
// Just the app shell — Vite's hashed asset filenames change on every
// deploy, so we don't try to pre-list them here. They get cached
// automatically the first time they're fetched (see fetch handler below).
const APP_SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Clean up caches from older deploys so an update doesn't keep serving
  // stale JS/CSS forever.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Never intercept API calls (Supabase, PayMongo, PayPal) or anything
  // that isn't a simple GET — those need to always hit the network live,
  // never a stale cached response, especially for payments.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (Supabase etc.) pass straight through
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          // Only cache successful, basic (same-origin) responses.
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to whatever's cached
      // Cache-first for instant loads; network still runs in the
      // background to keep the cache fresh for next time.
      return cached || networkFetch;
    })
  );
});
