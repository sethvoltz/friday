import { config as dotenvConfig } from "dotenv";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

/**
 * Idempotently set `KEY=value` in `~/.friday/.env`. Replaces an existing
 * line for the same key, or appends if missing. Other lines are preserved
 * verbatim. Also updates `process.env[key]` so callers see the new value
 * without re-loading. The file is created with `# Friday env vars` header
 * if it does not yet exist.
 *
 * Quoting: values containing whitespace, `#`, `=`, or `"` are wrapped in
 * double quotes with internal `"` and `\` escaped. Tokens that are pure
 * URL-safe base64 / opaque blobs (the common case) are written bare.
 */
export function upsertEnvVar(key: string, value: string): void {
  if (!existsSync(dirname(ENV_PATH))) {
    mkdirSync(dirname(ENV_PATH), { recursive: true });
  }
  const existing = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, "utf8")
    : "# Friday env vars\n";
  const line = `${key}=${formatEnvValue(value)}`;
  const lines = existing.split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
  process.env[key] = value;
}

function formatEnvValue(value: string): string {
  if (/[\s#="]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
