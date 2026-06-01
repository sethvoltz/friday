import { PostHog } from "posthog-node";

const DISTINCT_ID = "friday-daemon";

// System default: PostHog US cloud. Placed as the `??` fallback so a
// `POSTHOG_HOST` in `~/.friday/.env` (EU cloud / self-hosted) overrides
// it, mirroring the "system defaults in code" convention. With no
// `POSTHOG_API_KEY` set the client is constructed with an empty key and
// silently no-ops, so analytics are strictly opt-in.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const client = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
  host: process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
  enableExceptionAutocapture: true,
});

export { client as posthog, DISTINCT_ID };
