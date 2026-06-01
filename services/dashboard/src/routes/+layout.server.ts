import { existsSync, readFileSync, statSync } from "node:fs";
import { HEALTH_PATH } from "@friday/shared";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  let health: {
    pid?: number;
    uptimeSec?: number;
    rssMb?: number;
    ts?: string;
  } | null = null;
  let daemonOnline = false;
  if (existsSync(HEALTH_PATH)) {
    try {
      health = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
      const mtime = statSync(HEALTH_PATH).mtimeMs;
      daemonOnline = Date.now() - mtime < 60_000;
    } catch {
      // ignore
    }
  }
  return {
    user: locals.user,
    health,
    daemonOnline,
    homeDir: process.env.HOME ?? null,
    dataDir:
      process.env.FRIDAY_DATA_DIR ?? (process.env.HOME ? `${process.env.HOME}/.friday` : null),
    // PostHog analytics config (FRI / posthog branch). The project key is
    // the public `phc_…` token — safe to ship to the browser — so we reuse
    // the same `POSTHOG_API_KEY` / `POSTHOG_HOST` the daemon reads from
    // `~/.friday/.env` (loaded into process.env by ensureFridayEnv, invoked
    // at module load in $lib/server/auth). When unset, the client load
    // below skips init and posthog-js stays dormant — analytics are opt-in.
    posthogKey: process.env.POSTHOG_API_KEY || null,
    posthogHost: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  };
};
