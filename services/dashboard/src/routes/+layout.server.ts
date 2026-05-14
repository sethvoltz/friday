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
  };
};
