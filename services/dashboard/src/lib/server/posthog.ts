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

// Build the client LAZILY, on first use — not at module load. POSTHOG_API_KEY
// is a daemon-scoped vault secret, and the dashboard process warms the age
// vault in the server `init` hook (hooks.server.ts), which runs AFTER this
// module is evaluated. Reading the key at module load (the prior behavior) hit
// an unwarmed vault, so the client was built with an empty key and silently
// no-op'd ALL server analytics. Deferring the loadFridayConfig() read to first
// use guarantees it runs after `init` has warmed the vault and cleared the
// config cache. (FRI-166 follow-up: vault-warm timing.)
let instance: PostHog | undefined;
function build(): PostHog {
  const cfg = loadFridayConfig();
  return new PostHog(cfg.posthogApiKey ?? "", {
    host: cfg.posthogHost ?? DEFAULT_POSTHOG_HOST,
    enableExceptionAutocapture: true,
  });
}

// Lazy proxy: preserves the `posthog.captureException(...)` / `.shutdown()`
// call sites unchanged while deferring construction to the first property
// access. Methods are bound to the underlying client.
const posthog = new Proxy({} as PostHog, {
  get(_target, prop) {
    instance ??= build();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/**
 * Eagerly construct the client (after the vault is warmed). Called from the
 * server `init` hook so `enableExceptionAutocapture` installs its global
 * handlers at startup rather than waiting for the first manual capture.
 */
export function initPosthog(): void {
  instance ??= build();
}

export { posthog, DISTINCT_ID };
