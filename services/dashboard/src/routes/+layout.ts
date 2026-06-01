import { browser } from "$app/environment";
import posthog from "posthog-js";
import type { LayoutLoad } from "./$types";

// PostHog client init — the official SvelteKit pattern
// (https://posthog.com/docs/libraries/svelte): initialize in the root
// universal load, guarded by `browser`. The project key + host arrive via
// the sibling `+layout.server.ts` load (which reads them from process.env),
// so a single `POSTHOG_API_KEY` in `~/.friday/.env` drives both the daemon
// and the dashboard. With no key set, `data.posthogKey` is null and we skip
// init entirely — posthog-js stays dormant.
//
// `defaults: '2026-01-30'` opts into PostHog's current recommended defaults
// bundle: history-based `$pageview`/`$pageleave` capture (which covers
// SvelteKit client-side navigation), autocapture, and session replay. The
// per-user identify/reset lives in +layout.svelte, where `data.user` is
// reactively available.
export const load: LayoutLoad = async ({ data }) => {
  if (browser && data.posthogKey && !posthog.__loaded) {
    posthog.init(data.posthogKey, {
      // First-party reverse proxy (src/routes/ingest) — same-origin path so
      // content blockers can't recognize and block PostHog traffic. The
      // proxy forwards to the real POSTHOG_HOST server-side.
      api_host: "/ingest",
      // Real cloud host, used only to build "view in PostHog" deep links —
      // not for ingestion. Keeps toolbar/links pointing at the actual app.
      ui_host: data.posthogHost,
      defaults: "2026-01-30",
    });
  }
  return data;
};
