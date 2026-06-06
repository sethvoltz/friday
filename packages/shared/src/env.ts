/**
 * Friday config loader (FRI-150 pivot, ADR-037; vault overlay ADR-038).
 *
 * Machine-local secrets live in `~/.friday/.env.local`. Integration secrets
 * live in the age-encrypted vault (`secrets/vault.enc`) and are read via
 * `unlockVault()` into an in-memory cache — not from plaintext `.env`.
 */

import { parse as dotenvParse } from "dotenv";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV_LOCAL_PATH, ENV_PATH } from "./config.js";
import { MACHINE_ENV_KEYS } from "./secrets/types.js";
import { resolveDaemonFields } from "./secrets/resolve.js";
import {
  clearSecretsCache,
  getVaultCache,
  isSecretsLocked,
  unlockVault,
  upsertSecret,
} from "./secrets/vault.js";
import type { SecretMeta } from "./secrets/types.js";

export interface FridayEnvConfig {
  readonly betterAuthSecret: string;
  readonly zeroAuthSecret: string;
  readonly zeroAdminPassword: string;
  readonly databaseUrl: string | undefined;
  readonly zeroUpstreamDb: string | undefined;
  readonly zeroReplicaFile: string | undefined;
  readonly linearApiKey: string | undefined;
  readonly anthropicApiKey: string | undefined;
  readonly cloudflareTunnelToken: string | undefined;
  readonly posthogApiKey: string | undefined;
  readonly posthogHost: string | undefined;
}

let cached: FridayEnvConfig | undefined;

export function clearFridayConfigCache(): void {
  cached = undefined;
}

export function __resetFridayEnvConfigForTests(): void {
  cached = undefined;
  clearSecretsCache();
}

function localEnvPath(): string {
  if (existsSync(ENV_LOCAL_PATH)) return ENV_LOCAL_PATH;
  if (existsSync(ENV_PATH)) return ENV_PATH;
  return ENV_LOCAL_PATH;
}

function ensureLocalEnvFile(): Record<string, string> {
  const path = localEnvPath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (!existsSync(path)) {
    writeFileSync(path, "# Friday machine-local env vars\n");
  }
  return dotenvParse(readFileSync(path));
}

function persistLocalKey(path: string, key: string, value: string, parsed: Record<string, string>): void {
  appendFileSync(path, `${key}=${value}\n`);
  parsed[key] = value;
}

/**
 * Warm the vault cache. Call at daemon boot before serving traffic.
 */
export async function warmVaultCache(): Promise<void> {
  await unlockVault();
}

export function loadFridayConfig(): FridayEnvConfig {
  if (cached) return cached;

  const path = localEnvPath();
  const parsed = ensureLocalEnvFile();

  if (!parsed.BETTER_AUTH_SECRET) {
    const secret = randomBytes(32).toString("base64");
    appendFileSync(path, `BETTER_AUTH_SECRET=${secret}\n`);
    parsed.BETTER_AUTH_SECRET = secret;
  }
  if (!parsed.ZERO_AUTH_SECRET) {
    const secret = randomBytes(32).toString("hex");
    appendFileSync(path, `ZERO_AUTH_SECRET=${secret}\n`);
    parsed.ZERO_AUTH_SECRET = secret;
  }
  if (!parsed.ZERO_ADMIN_PASSWORD) {
    const secret = randomBytes(24).toString("base64url");
    appendFileSync(path, `ZERO_ADMIN_PASSWORD=${secret}\n`);
    parsed.ZERO_ADMIN_PASSWORD = secret;
  }

  const readLocal = (key: string): string | undefined => process.env[key] || parsed[key];
  const vaultCache = getVaultCache();
  const daemonOverlay = resolveDaemonFields(vaultCache, (key) => process.env[key]);

  const readIntegration = (key: string, field?: string): string | undefined => {
    const fromEnv = process.env[key];
    if (fromEnv) return fromEnv;
    if (field && daemonOverlay[field as keyof typeof daemonOverlay]) {
      return daemonOverlay[field as keyof typeof daemonOverlay];
    }
    return undefined;
  };

  cached = Object.freeze({
    betterAuthSecret: (readLocal("BETTER_AUTH_SECRET") ?? parsed.BETTER_AUTH_SECRET) as string,
    zeroAuthSecret: (readLocal("ZERO_AUTH_SECRET") ?? parsed.ZERO_AUTH_SECRET) as string,
    zeroAdminPassword: (readLocal("ZERO_ADMIN_PASSWORD") ?? parsed.ZERO_ADMIN_PASSWORD) as string,
    databaseUrl: readLocal("DATABASE_URL"),
    zeroUpstreamDb: readLocal("ZERO_UPSTREAM_DB"),
    zeroReplicaFile: readLocal("ZERO_REPLICA_FILE"),
    linearApiKey: readIntegration("LINEAR_API_KEY", "linearApiKey"),
    anthropicApiKey: readIntegration("ANTHROPIC_API_KEY", "anthropicApiKey"),
    cloudflareTunnelToken: readIntegration("CLOUDFLARE_TUNNEL_TOKEN", "cloudflareTunnelToken"),
    posthogApiKey: readIntegration("POSTHOG_API_KEY", "posthogApiKey"),
    posthogHost: readIntegration("POSTHOG_HOST", "posthogHost"),
  });
  return cached;
}

export function secretsHealthLocked(): boolean {
  return isSecretsLocked();
}

export function upsertEnvVar(key: string, value: string): void {
  if (MACHINE_ENV_KEYS.has(key)) {
    upsertLocalEnvVar(key, value);
    return;
  }
  throw new Error(
    `upsertEnvVar: integration key ${key} must use friday secrets set (vault), not plaintext .env`,
  );
}

export async function upsertIntegrationSecret(meta: SecretMeta, value: string): Promise<void> {
  await upsertSecret(meta, value);
  clearFridayConfigCache();
}

function upsertLocalEnvVar(key: string, value: string): void {
  const path = localEnvPath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# Friday machine-local env vars\n";
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
  writeFileSync(path, lines.join("\n"));
  cached = undefined;
}

function formatEnvValue(value: string): string {
  if (/[\s#="]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
