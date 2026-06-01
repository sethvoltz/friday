import type { RequestHandler } from "./$types";

// First-party PostHog reverse proxy — the official SvelteKit pattern
// (https://posthog.com/docs/advanced/proxy/sveltekit). posthog-js is
// configured with `api_host: '/ingest'`, so every ingestion request and the
// lazily-loaded session-replay recorder hit our own origin instead of
// `us.i.posthog.com`. Content/ad blockers (common on mobile Safari, which is
// how Friday is reached over the Cloudflare Tunnel) block the PostHog cloud
// domain by name; routing through our origin makes the traffic first-party
// and undetectable as analytics.
//
// Two upstreams: ingestion (`/e/`, `/flags/`, `/i/v0/…`) → the API host;
// static assets (`/static/…`, e.g. recorder.js) → the matching `-assets`
// host. Both derived from POSTHOG_HOST so EU / self-hosted just work.

// posthog-js posts to trailing-slash paths (`/e/`, `/flags/`). SvelteKit's
// default `trailingSlash: 'never'` would 308-redirect those, adding a round
// trip; 'ignore' serves them as-is so the body forwards in one hop.
export const trailingSlash = "ignore";

const API_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
// us.i.posthog.com → us-assets.i.posthog.com ; eu.i.posthog.com → eu-assets…
const ASSET_HOST = API_HOST.replace(".i.posthog.com", "-assets.i.posthog.com");

// `fallback` handles every method (GET for assets, POST for ingestion).
export const fallback: RequestHandler = async ({ request, params, url }) => {
  const path = params.path;
  const upstream = path.startsWith("static/") ? ASSET_HOST : API_HOST;
  const target = `${upstream}/${path}${url.search}`;

  // Clone headers and rewrite Host to the upstream so PostHog's edge routes
  // correctly; drop hop-by-hop headers Node's fetch manages itself.
  const headers = new Headers(request.headers);
  headers.set("host", new URL(upstream).host);
  headers.delete("connection");

  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    // Required by Node's fetch to stream a request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  // Strip content-encoding/length: fetch has already decoded the body, so
  // re-advertising the original encoding would make the browser fail to
  // parse it. Let the platform set fresh framing.
  const respHeaders = new Headers(res.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  return new Response(res.body, { status: res.status, headers: respHeaders });
};
