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
 * - Precached assets: cache-first.
 * - Same-origin GET that's *not* /api/*: stale-while-revalidate. Pages and
 *   icons feel instant on resume even if the network is degraded.
 * - /api/*: network-only. The API talks to localhost / a Cloudflare Tunnel;
 *   serving a cached agent list, transcript, or SSE stream would actively
 *   mislead the user. Cached transcripts live in localStorage where the app
 *   can decide how to merge them with fresh data.
 *
 * No skipWaiting/clients.claim — the user gets the new worker on next reload,
 * which lines up with how the app's own state is rehydrated.
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

  if (ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Page navigations + everything else same-origin: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
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

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok && res.type === "basic") cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (cached) {
    // Kick off the revalidation but don't wait on it.
    void network;
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  // Last resort: navigation request with neither cache nor network. Serve
  // the precached root HTML so the SPA shell still mounts and can render
  // its own offline UI from localStorage.
  if (request.mode === "navigate") {
    const fallback = await cache.match("/");
    if (fallback) return fallback;
  }
  return new Response("offline", { status: 503, statusText: "offline" });
}
