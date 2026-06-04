import { PostHog } from "posthog-node";
import { loadFridayConfig } from "@friday/shared";

// Server-side PostHog client for the dashboard's SvelteKit server (load
// functions, endpoints, hooks). Mirrors the daemon's singleton
// (services/daemon/src/posthog.ts): reads the same `POSTHOG_API_KEY` /
// `POSTHOG_HOST` from the loadFridayConfig() object. With no key set the
// client constructs empty and silently no-ops. Distinct from the
// browser's posthog-js — this captures errors that never reach the
// client (SSR load throws, endpoint failures).
const DISTINCT_ID = "friday-dashboard-server";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const phCfg = loadFridayConfig();
const client = new PostHog(phCfg.posthogApiKey ?? "", {
  host: phCfg.posthogHost ?? DEFAULT_POSTHOG_HOST,
  enableExceptionAutocapture: true,
});

export { client as posthog, DISTINCT_ID };
