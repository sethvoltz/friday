import { writeFileSync } from "node:fs";
import { HEALTH_PATH, atomicWriteFile } from "@friday/shared";

const startedAt = Date.now();

export function startHealthHeartbeat(): NodeJS.Timeout {
  writeHealth();
  return setInterval(writeHealth, 30_000);
}

export function clearHealth(): void {
  try {
    writeFileSync(HEALTH_PATH, "");
  } catch {
    // ignore
  }
}

function writeHealth(): void {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
  };
  atomicWriteFile(HEALTH_PATH, JSON.stringify(payload, null, 2));
}
