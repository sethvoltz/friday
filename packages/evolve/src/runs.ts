import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVOLVE_DIR } from "@friday/shared";

export const RUNS_LOG_PATH = join(EVOLVE_DIR, "runs.jsonl");

export interface RunRecord {
  ts: string;
  /** Who/what triggered this run (e.g. "scheduled-meta-daily", "cli"). */
  by: string;
  /** ISO window start (e.g. 24h ago). */
  windowStart: string;
  /** ISO window end (typically run time). */
  windowEnd: string;
  signalsScanned: number;
  proposalsCreated: number;
  proposalsUpdated: number;
  promotedToCritical: number;
  /** Optional free-text note (e.g. error if scan failed). */
  note?: string;
}

export function appendRun(record: RunRecord): void {
  mkdirSync(dirname(RUNS_LOG_PATH), { recursive: true });
  appendFileSync(RUNS_LOG_PATH, JSON.stringify(record) + "\n");
}
