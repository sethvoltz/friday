import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";

/**
 * Per-installation shared secret used to authenticate same-host callers of
 * the daemon's HTTP API. The daemon binds to 127.0.0.1, but that alone does
 * not protect against:
 *
 *   - DNS rebinding: a hostile page can resolve an attacker-controlled
 *     hostname to 127.0.0.1 and `fetch()` the daemon under that origin.
 *   - Other local processes on a shared machine.
 *
 * The dashboard (running as the same OS user) reads this file on startup
 * and injects `x-friday-daemon-secret` on requests to the daemon. The
 * daemon rejects requests that don't match.
 *
 * The file is created on first read with mode 0600 so other users on the
 * machine can't read it.
 */
export const DAEMON_SECRET_PATH = join(DATA_DIR, ".daemon-secret");

let cached: string | null = null;

export function getDaemonSecret(): string {
  if (cached) return cached;
  if (!existsSync(DAEMON_SECRET_PATH)) {
    const dir = dirname(DAEMON_SECRET_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const secret = randomBytes(32).toString("hex");
    writeFileSync(DAEMON_SECRET_PATH, secret, { mode: 0o600 });
    cached = secret;
    return secret;
  }
  cached = readFileSync(DAEMON_SECRET_PATH, "utf8").trim();
  return cached;
}

export const DAEMON_SECRET_HEADER = "x-friday-daemon-secret";

/** Hostnames that are acceptable on the `Host` header for daemon requests.
 *  Used as a DNS-rebind defense alongside the shared-secret check. */
export function isLocalHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
