/* Fuel & Form service worker.
 *
 * The app is already offline-capable in principle — FALLBACK exercises and the
 * workout history both live client-side — but without a cached shell a
 * standalone (home-screen) launch with no signal fails to boot at all. This
 * caches the shell so the app always opens, and opportunistically caches
 * exercise images so previously-seen workouts keep their photos offline.
 *
 * Bump SHELL_CACHE when any shell file changes so clients pick it up.
 */

const SHELL_CACHE = 'mtracker-shell-v4'; // v4: renamed to Fuel & Form
const IMG_CACHE   = 'mtracker-img-v1';
const IMG_LIMIT   = 120; // exercise photos to retain before trimming oldest

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/data.js',
  './js/app.js',
  './js/meals.js',
  './js/nutrition-ai.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is atomic — one 404 would reject the whole install, so request
      // each entry individually and keep whatever succeeds.
      .then(cache => Promise.all(SHELL.map(url =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== IMG_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys  = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Cache-first, falling back to the network and storing what comes back.
async function imageStrategy(request) {
  const cache = await caches.open(IMG_CACHE);
  const hit   = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    // Cross-origin images are opaque (status 0) — still worth caching.
    if (res.ok || res.type === 'opaque') {
      await cache.put(request, res.clone());
      trimCache(IMG_CACHE, IMG_LIMIT);
    }
    return res;
  } catch {
    // No network and nothing cached: let the <img> onerror show the placeholder.
    return Response.error();
  }
}

// Serve the cached shell immediately, then refresh it in the background.
async function shellStrategy(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then(res => {
    if (res.ok) caches.open(SHELL_CACHE).then(c => c.put(request, res.clone()));
    return res;
  });
  if (cached) {
    network.catch(() => null); // offline refresh failure is expected; don't warn
    return cached;
  }
  return network;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.destination === 'image' && url.origin !== self.location.origin) {
    event.respondWith(imageStrategy(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(request));
    return;
  }

  // Anything else (the wger API) goes straight to the network — app.js already
  // handles a failed fetch by falling back to the bundled exercise set.
});
