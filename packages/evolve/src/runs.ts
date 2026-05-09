/**
 * Append-only run log. Records every scan/enrich/cluster pass for later audit.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUNS_LOG_PATH } from "@friday/shared";

export interface RunRecord {
  ts: string;
  /** Who/what triggered this run (e.g. "scheduled-meta-daily", "cli", "orchestrator"). */
  by: string;
  /** ISO window start. */
  windowStart: string;
  /** ISO window end. */
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

export { RUNS_LOG_PATH };
