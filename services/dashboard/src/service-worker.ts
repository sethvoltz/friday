/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from "$service-worker";

declare const self: ServiceWorkerGlobalScope;

/**
 * App-shell service worker.
 *
 * SvelteKit emits `build` (the JS/CSS chunks the SSR HTML references) and
 * `files` (everything in /static). Precache both at install so a cold network
 * still paints the shell. Runtime cache strategy:
 *
 * - Precached assets (the build + static files set): cache-first.
 * - Everything else same-origin: pass through to the network. We
 *   deliberately do NOT cache rendered HTML or any other dynamic GET —
 *   SvelteKit pages are personalized for the authenticated user, and a
 *   cached `/sessions/*` shell would still be served after logout /
 *   cookie expiry, exposing the previous session's UI to the next user.
 * - /api/*: bypass. SSE, agent lists, transcripts — serving cached
 *   versions of those would actively mislead the UI.
 *
 * No skipWaiting/clients.claim — the user gets the new worker on next reload.
 */

const CACHE = `friday-shell-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older deployments. `version` changes per build.
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // /api/* always hits the network — cached responses would mislead the UI.
  if (url.pathname.startsWith("/api/")) return;

  // Static asset from the precache set: cache-first. These are
  // content-versioned by SvelteKit (filenames include a hash) so we never
  // serve stale code, and they don't carry user state.
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (rendered HTML, dynamic responses): pass through to
  // the network without caching. We don't trust ourselves to know which
  // responses safely outlive a logout, so we cache none of them.
});

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
