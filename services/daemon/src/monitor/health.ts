import { writeFileSync } from "node:fs";
import { HEALTH_PATH, atomicWriteFile, isSecretsLocked } from "@friday/shared";

const startedAt = Date.now();

/**
 * Begin the `health.json` heartbeat (every 30s).
 *
 * `port` is the daemon's actually-bound HTTP port — surfaced into the
 * payload so `friday status` can show the *real* listening port instead
 * of trusting `cfg.daemonPort` (which a future config edit could
 * disagree with). The caller is responsible for passing the port that
 * `startServer({ port })` was invoked with after the server is
 * listening; see `services/daemon/src/index.ts`.
 */
export function startHealthHeartbeat(port: number): NodeJS.Timeout {
  writeHealth(port);
  return setInterval(() => writeHealth(port), 30_000);
}

export function clearHealth(): void {
  try {
    writeFileSync(HEALTH_PATH, "");
  } catch {
    // ignore
  }
}

function writeHealth(port: number): void {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    port,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    secretsLocked: isSecretsLocked(),
  };
  atomicWriteFile(HEALTH_PATH, JSON.stringify(payload, null, 2));
}
