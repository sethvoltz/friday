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
 * `files` (everything in /static). Precache both at install so a cold
 * network still paints the shell. Runtime cache strategy (FIX_FORWARD 3.9):
 *
 * - Precached assets (hashed JS/CSS, static files): cache-first. Filenames
 *   are content-versioned, so a cached entry is always correct for its url.
 * - Navigation requests (HTML): network-first, fall back to cache on
 *   network failure. A successful network response is written to cache so
 *   offline reloads survive. `/login` is excluded — we don't want to
 *   serve a stale auth page after a server-side rotation.
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

  // Navigation / HTML responses: network-first with cache fallback
  // (FIX_FORWARD 3.9). Offline reload serves the last successful response.
  if (isHtmlRequest(request)) {
    event.respondWith(networkFirstHtml(request, url));
    return;
  }

  // Everything else: pass through to the network without caching.
});

function isHtmlRequest(request: Request): boolean {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

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

async function networkFirstHtml(
  request: Request,
  url: URL,
): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    // Cache 2xx HTML responses for the offline-fallback path. Skip /login
    // so we never re-serve a stale auth page after a server-side
    // credential rotation; same for any other auth-flow endpoints.
    if (fresh.ok && !url.pathname.startsWith("/login")) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last-resort: try `/` (the dashboard shell). The SPA boot will
    // re-route the client to the current path once it's interactive.
    const rootCached = await cache.match(new Request(`${url.origin}/`));
    if (rootCached) return rootCached;
    throw err;
  }
}
