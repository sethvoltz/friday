import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageEntry } from "@friday/shared";
import { USAGE_LOG_PATH } from "@friday/shared";

let initialized = false;

function ensureLogDir(): void {
  if (initialized) return;
  const dir = dirname(USAGE_LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  initialized = true;
}

export function logUsage(entry: UsageEntry): void {
  ensureLogDir();
  appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + "\n");
}
