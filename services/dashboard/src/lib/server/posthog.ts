import { PostHog } from "posthog-node";

// Server-side PostHog client for the dashboard's SvelteKit server (load
// functions, endpoints, hooks). Mirrors the daemon's singleton
// (services/daemon/src/posthog.ts): reads the same `POSTHOG_API_KEY` /
// `POSTHOG_HOST` from process.env (loaded by ensureFridayEnv via
// $lib/server/auth). With no key set the client constructs empty and
// silently no-ops. Distinct from the browser's posthog-js — this captures
// errors that never reach the client (SSR load throws, endpoint failures).
const DISTINCT_ID = "friday-dashboard-server";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const client = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
  host: process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
  enableExceptionAutocapture: true,
});

export { client as posthog, DISTINCT_ID };
