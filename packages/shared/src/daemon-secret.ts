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
  // Race-safe creation. If daemon and dashboard cold-start concurrently and
  // both observe the file missing, naive existsSync+write lets both win
  // the existsSync but then fight at write — last-write wins on disk while
  // the loser caches its own value forever. Use `wx` (exclusive create)
  // and fall through to a read on EEXIST.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cached = readFileSync(DAEMON_SECRET_PATH, "utf8").trim();
      if (cached) return cached;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const dir = dirname(DAEMON_SECRET_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(DAEMON_SECRET_PATH, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lost the race — loop back and read what the winner wrote.
    }
  }
  throw new Error(
    `failed to read or create daemon secret at ${DAEMON_SECRET_PATH}`,
  );
}

export const DAEMON_SECRET_HEADER = "x-friday-daemon-secret";

/** Hostnames that are acceptable on the `Host` header for daemon requests.
 *  Used as a DNS-rebind defense alongside the shared-secret check. */
export function isLocalHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
