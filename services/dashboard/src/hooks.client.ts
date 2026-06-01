import posthog from "posthog-js";
import type { HandleClientError } from "@sveltejs/kit";

// Client-side error tracking. SvelteKit routes uncaught errors during
// load/render through `handleError`; forward them to PostHog so they land
// in Error Tracking, correlated with the active session replay. posthog-js
// is initialized in +layout.ts; if a key isn't configured (`__loaded` is
// false) this is a no-op. 404s are not errors — skip them.
export const handleError: HandleClientError = ({ error, status, message }) => {
  if (status !== 404 && posthog.__loaded) {
    posthog.captureException(error instanceof Error ? error : new Error(String(error)), {
      source: "sveltekit.handleError",
      status,
    });
  }
  // Preserve SvelteKit's default: the returned shape becomes `$page.error`.
  return { message };
};
