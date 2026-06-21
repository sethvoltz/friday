/**
 * FRI-26 Memory Dreaming — the Dream Diary (Refinement 3).
 *
 * An append-only markdown journal, one timestamped block per dream run. The
 * nightly `/api/evolve/scan` sub-pass writes exactly one block per run after
 * promotion + hygiene, summarising what the run did.
 *
 * Append convention mirrors `runs.ts` / `scheduler/state.ts`: a path constant
 * from `@friday/shared` (never a hardcoded string) plus a defensive
 * `mkdirSync(dirname(...))` before the write. Unlike `state.ts`'s
 * `writeFileSync` (which overwrites), this APPENDS so prior runs are never
 * clobbered — the diary is a durable history (AC16).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DREAM_DIARY_PATH } from "@friday/shared";

/** Per-item action recorded in a dream run's diary table. */
export type DreamItemAction = "promoted" | "merged" | "pruned-flagged" | "reinforced";

export interface DreamDiaryItem {
  action: DreamItemAction;
  title: string;
  /** Null where not score-driven (e.g. a flagged/merged entry). */
  score: number | null;
  /** Short human-readable note. */
  evidence: string;
}

export interface DreamRunReport {
  /** ISO timestamp of the run; becomes the block heading. */
  ts: string;
  promoted: number;
  merged: number;
  prunedFlagged: number;
  reinforced: number;
  items: DreamDiaryItem[];
}

/**
 * Escape a value for a markdown table cell: collapse newlines and escape the
 * pipe so the cell never breaks the table layout.
 */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Render one diary item as a markdown table row. */
function renderRow(item: DreamDiaryItem): string {
  const score = item.score === null ? "—" : String(item.score);
  return `| ${cell(item.action)} | ${cell(item.title)} | ${cell(score)} | ${cell(item.evidence)} |`;
}

/**
 * Appends ONE timestamped markdown block to `DREAM_DIARY_PATH`. Append-only —
 * earlier blocks are never rewritten.
 */
export function appendDreamEntry(report: DreamRunReport): void {
  const counts = `promoted: ${report.promoted}, merged: ${report.merged}, pruned-flagged: ${report.prunedFlagged}, reinforced: ${report.reinforced}`;

  const lines = [
    `## ${report.ts} — dream run`,
    "",
    counts,
    "",
    "| action | title | score | evidence |",
    "| --- | --- | --- | --- |",
    ...report.items.map(renderRow),
  ];

  const block = lines.join("\n") + "\n";

  mkdirSync(dirname(DREAM_DIARY_PATH), { recursive: true });
  appendFileSync(DREAM_DIARY_PATH, block);
}
