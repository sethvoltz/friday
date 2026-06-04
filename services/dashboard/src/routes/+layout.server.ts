import { existsSync, readFileSync, statSync } from "node:fs";
import { HEALTH_PATH, loadFridayConfig } from "@friday/shared";
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
  // FRI-150 (pivot, ADR-037): PostHog config now comes from
  // `loadFridayConfig()` (no process.env mutation). The project key is
  // the public `phc_…` token, safe to ship to the browser.
  const phCfg = loadFridayConfig();
  return {
    user: locals.user,
    health,
    daemonOnline,
    homeDir: process.env.HOME ?? null,
    dataDir:
      process.env.FRIDAY_DATA_DIR ?? (process.env.HOME ? `${process.env.HOME}/.friday` : null),
    posthogKey: phCfg.posthogApiKey || null,
    posthogHost: phCfg.posthogHost || "https://us.i.posthog.com",
  };
};
