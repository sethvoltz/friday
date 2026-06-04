/**
 * Friday config loader (FRI-150 pivot, ADR-037).
 *
 * Reads `~/.friday/.env` (creating it on first run, auto-generating missing
 * load-bearing secrets), then returns an immutable `FridayEnvConfig` object
 * without mutating `process.env`. Callers that need a secret import this
 * loader and read the field they want (e.g. `loadFridayEnvConfig().linearApiKey`)
 * rather than reaching into `process.env`.
 *
 * Why the no-mutation contract is load-bearing: the daemon forks worker
 * processes, which then `$SHELL -ilc`-capture the user's interactive shell
 * env and pass a restricted subset to MCP children. If `process.env` on
 * the daemon held `BETTER_AUTH_SECRET` / `LINEAR_API_KEY` / etc., those
 * keys would ride through the fork (`...process.env`) into every worker,
 * and from there into the captured-env round-trip, potentially landing in
 * MCP children. By keeping secrets in a config object instead, the daemon
 * fork inherits a clean env tree — secrets stay daemon-side at the use
 * sites that explicitly request them.
 *
 * Cached per-process via a module singleton. Multiple calls within one
 * process return the same object; calls after `upsertEnvVar` rotates a
 * key see the updated value on the next call (the singleton is rebuilt
 * because `upsertEnvVar` clears the cache).
 *
 * NOT exported from index.ts? It IS — `loadFridayEnvConfig` is the public
 * entry point. The legacy `ensureFridayEnv` shape that mutated
 * `process.env` retired in this pivot; callers were migrated.
 */

import { parse as dotenvParse } from "dotenv";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV_PATH } from "./config.js";

/** Immutable per-process config object returned by `loadFridayEnvConfig()`.
 *
 *  Fields are typed `string | undefined` so a caller that legitimately
 *  expects a secret to be absent (e.g. `linearApiKey` when the user hasn't
 *  configured Linear) gets `undefined` rather than empty string. Fields
 *  the loader auto-generates (`betterAuthSecret`, `zeroAuthSecret`,
 *  `zeroAdminPassword`) are always present after the first call. */
export interface FridayEnvConfig {
  /** Always populated — generated on first call if missing. */
  readonly betterAuthSecret: string;
  /** Always populated — generated on first call if missing. */
  readonly zeroAuthSecret: string;
  /** Always populated — generated on first call if missing. */
  readonly zeroAdminPassword: string;
  /** Set by `friday setup` once Postgres is provisioned. */
  readonly databaseUrl: string | undefined;
  /** Set by `friday setup`. Mirrors `databaseUrl` for zero-cache use. */
  readonly zeroUpstreamDb: string | undefined;
  /** Set by `friday setup`. Local zero-cache replica file path. */
  readonly zeroReplicaFile: string | undefined;
  /** Set when the user configured Linear integration. */
  readonly linearApiKey: string | undefined;
  /** Set when the user configured Claude API access. */
  readonly anthropicApiKey: string | undefined;
  /** Set when the user configured a Cloudflare Tunnel. */
  readonly cloudflareTunnelToken: string | undefined;
  /** Set when the user opted in to PostHog telemetry. */
  readonly posthogApiKey: string | undefined;
  /** Optional override for the PostHog endpoint. */
  readonly posthogHost: string | undefined;
}

let cached: FridayEnvConfig | undefined;

/**
 * Invalidate the cached `FridayEnvConfig` singleton so the next call to
 * `loadFridayConfig()` re-reads `~/.friday/.env`. Use after an
 * out-of-band file mutation (e.g. `friday restore` swapping in a backup,
 * manual dev edits). `upsertEnvVar` calls this automatically.
 */
export function clearFridayConfigCache(): void {
  cached = undefined;
}

/**
 * Test-only alias for `clearFridayConfigCache`. Kept for the
 * underscore-prefixed signal in test files.
 */
export function __resetFridayEnvConfigForTests(): void {
  cached = undefined;
}

/**
 * Load (or return cached) Friday config. Idempotent — first caller
 * creates the `.env` file + generates missing load-bearing secrets and
 * appends them to disk; later callers just parse and return.
 *
 * Does NOT mutate `process.env`. See module-level doc-comment for why.
 */
export function loadFridayConfig(): FridayEnvConfig {
  if (cached) return cached;

  if (!existsSync(dirname(ENV_PATH))) {
    mkdirSync(dirname(ENV_PATH), { recursive: true });
  }
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, "# Friday env vars\n");
  }

  // Read + parse the file. `dotenv.parse` operates on a buffer and returns
  // the parsed object WITHOUT mutating process.env — that's the load-bearing
  // contract this loader is built on.
  const parsed = dotenvParse(readFileSync(ENV_PATH));

  // Auto-generate load-bearing secrets if missing. Each generated secret is
  // appended to the .env file so the next process inherits it.
  if (!parsed.BETTER_AUTH_SECRET) {
    const secret = randomBytes(32).toString("base64");
    appendFileSync(ENV_PATH, `BETTER_AUTH_SECRET=${secret}\n`);
    parsed.BETTER_AUTH_SECRET = secret;
  }
  // ADR-023: dashboard mints short-lived JWTs from this secret to authenticate
  // to zero-cache. Generated once; rotated only on explicit action by setup
  // (not auto). 32 bytes hex matches Zero's documented format.
  if (!parsed.ZERO_AUTH_SECRET) {
    const secret = randomBytes(32).toString("hex");
    appendFileSync(ENV_PATH, `ZERO_AUTH_SECRET=${secret}\n`);
    parsed.ZERO_AUTH_SECRET = secret;
  }
  // Zero 1.5+ requires ZERO_ADMIN_PASSWORD in production mode (admin RPC
  // gate). Friday's zero-cache instance is local-only, so the password is
  // effectively a self-witness — but Zero refuses to boot without it.
  // Generated once at setup.
  if (!parsed.ZERO_ADMIN_PASSWORD) {
    const secret = randomBytes(24).toString("base64url");
    appendFileSync(ENV_PATH, `ZERO_ADMIN_PASSWORD=${secret}\n`);
    parsed.ZERO_ADMIN_PASSWORD = secret;
  }

  cached = Object.freeze({
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    zeroAuthSecret: parsed.ZERO_AUTH_SECRET,
    zeroAdminPassword: parsed.ZERO_ADMIN_PASSWORD,
    databaseUrl: parsed.DATABASE_URL,
    zeroUpstreamDb: parsed.ZERO_UPSTREAM_DB,
    zeroReplicaFile: parsed.ZERO_REPLICA_FILE,
    linearApiKey: parsed.LINEAR_API_KEY,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    cloudflareTunnelToken: parsed.CLOUDFLARE_TUNNEL_TOKEN,
    posthogApiKey: parsed.POSTHOG_API_KEY,
    posthogHost: parsed.POSTHOG_HOST,
  });
  return cached;
}

/**
 * Idempotently set `KEY=value` in `~/.friday/.env`. Replaces an existing
 * line for the same key, or appends if missing. Other lines are preserved
 * verbatim. The file is created with `# Friday env vars` header if it does
 * not yet exist.
 *
 * Pre-pivot (FRI-150) this also mutated `process.env[key]`; that
 * side-effect is retired. The cached `FridayEnvConfig` singleton is cleared
 * so the NEXT `loadFridayEnvConfig()` call re-reads disk and sees the new
 * value. Callers that need the updated value immediately should call
 * `loadFridayEnvConfig()` after `upsertEnvVar()`.
 *
 * Quoting: values containing whitespace, `#`, `=`, or `"` are wrapped in
 * double quotes with internal `"` and `\` escaped. Tokens that are pure
 * URL-safe base64 / opaque blobs (the common case) are written bare.
 */
export function upsertEnvVar(key: string, value: string): void {
  if (!existsSync(dirname(ENV_PATH))) {
    mkdirSync(dirname(ENV_PATH), { recursive: true });
  }
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "# Friday env vars\n";
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
  // Invalidate the cache so the next `loadFridayEnvConfig()` call sees the
  // freshly-written value.
  cached = undefined;
}

function formatEnvValue(value: string): string {
  if (/[\s#="]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
