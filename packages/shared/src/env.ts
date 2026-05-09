import { config as dotenvConfig } from "dotenv";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV_PATH } from "./config.js";

/**
 * Idempotent: load `~/.friday/.env` into `process.env`, generating any required
 * keys (currently `BETTER_AUTH_SECRET`) on first call. Safe to invoke from
 * every entry point — CLI, daemon, dashboard. The first caller writes; later
 * callers just read.
 */
export function ensureFridayEnv(): void {
  if (!existsSync(dirname(ENV_PATH))) {
    mkdirSync(dirname(ENV_PATH), { recursive: true });
  }
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, "# Friday env vars\n");
  }
  dotenvConfig({ path: ENV_PATH });

  if (!process.env.BETTER_AUTH_SECRET) {
    const secret = randomBytes(32).toString("base64");
    appendFileSync(ENV_PATH, `BETTER_AUTH_SECRET=${secret}\n`);
    process.env.BETTER_AUTH_SECRET = secret;
  }
}
