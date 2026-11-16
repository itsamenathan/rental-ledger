/* Service worker for the installed app (built into dist/sw.js by the rental-service-worker plugin in vite.config.ts).
 *
 * - The app shell (index.html + every built asset) is cached on install, so the app opens with no connection.
 * - A few read-only API calls fall back to their last good response when the network is unreachable: what the Add
 *   form needs (who am I, categories/properties, suggestions) and transaction lists/entries, so entries seen while
 *   online can be opened and edited offline. Nothing else under /api is touched.
 * - Writes are never handled here: unsent entries live in the page's IndexedDB outbox (src/outbox.ts).
 */
const BUILD = "__BUILD_ID__";
const ASSETS = __ASSETS__;
const SHELL = `shell-${BUILD}`;
const API = "api-v1";
const STATIC = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];
const CACHED_API = new Set(["/api/auth/me", "/api/overview", "/api/suggestions"]);
/** Transaction lists (any filter) and single entries. */
const TX_API = /^\/api\/transactions(\/\d+)?$/;
/** Saved list pages / entries to keep; the oldest go first. */
const MAX_TX_RESPONSES = 150;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll([...STATIC, ...ASSETS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    if (CACHED_API.has(path) && !url.search) event.respondWith(networkThenCache(req, API));
    else if (TX_API.test(path)) event.respondWith(networkThenCache(req, API, undefined, 8000, trimApiCache));
    return;
  }
  if (path === "/mcp" || path.startsWith("/mcp/") || path === "/llms.txt" || path === "/healthz") return;
  if (req.mode === "navigate") {
    event.respondWith(networkThenCache(req, SHELL, "/"));
    return;
  }
  if (path.startsWith("/assets/")) {
    event.respondWith(cacheThenNetwork(req));
    return;
  }
  if (STATIC.includes(path)) event.respondWith(networkThenCache(req, SHELL));
});

/** How long to wait for the network before showing the saved copy (a weak signal can hang for minutes). */
const SLOW_MS = 3000;

/**
 * Fresh from the network (and remembered when OK). The saved copy is used when the network can't be reached, or
 * when it's slower than SLOW_MS and a saved copy exists; the fetch still finishes in the background to refresh it.
 */
async function networkThenCache(req, cacheName, key, slowMs = SLOW_MS, afterPut) {
  const cache = await caches.open(cacheName);
  const network = fetch(req).then(async (res) => {
    if (res.ok) {
      await cache.delete(key ?? req); // re-adding moves it to the end, so trimming drops the least recently used
      await cache.put(key ?? req, res.clone());
      await afterPut?.(cache);
    }
    return res;
  });
  network.catch(() => {}); // a late failure after the saved copy was served is fine
  const hit = await cache.match(key ?? req);
  if (!hit) return network;
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(hit), slowMs);
  });
  try {
    return await Promise.race([network, slow]);
  } catch {
    return hit;
  } finally {
    clearTimeout(timer);
  }
}

/** Keep only the most recent transaction responses. */
async function trimApiCache(cache) {
  const keys = (await cache.keys()).filter((r) => TX_API.test(new URL(r.url).pathname));
  for (const r of keys.slice(0, Math.max(0, keys.length - MAX_TX_RESPONSES))) await cache.delete(r);
}

/** Hashed build files never change: serve the cached copy, else fetch and remember it. */
async function cacheThenNetwork(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(SHELL);
    await cache.put(req, res.clone());
  }
  return res;
}
