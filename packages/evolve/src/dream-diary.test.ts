/**
 * FRI-26 — Dream Diary append-only writer (AC15, AC16).
 *
 * `DREAM_DIARY_PATH` (from @friday/shared) is captured at module-eval time
 * from `process.env.FRIDAY_DATA_DIR`. To point the diary at a scoped tmpdir
 * we set the env BEFORE @friday/shared is imported (CLAUDE.md rule) — and
 * because `dream-diary.ts` statically imports @friday/shared, we import BOTH
 * the constant and the writer DYNAMICALLY in `beforeAll`, after the env is
 * set. (Dynamic import in tests is the sanctioned exception to the
 * static-imports-only rule.) A fresh scoped dir also guarantees the diary
 * file starts empty so AC16's byte-prefix assertion is exact.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Set the data dir BEFORE any @friday/shared import binds DATA_DIR/DREAM_DIARY_PATH.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "dream-diary-test-"));
process.env.FRIDAY_DATA_DIR = TMP_DATA_DIR;

let DREAM_DIARY_PATH: string;
let appendDreamEntry: typeof import("./dream-diary.js").appendDreamEntry;
type DreamRunReport = import("./dream-diary.js").DreamRunReport;

beforeAll(async () => {
  // Imported here (not statically) so the env assignment above wins.
  ({ DREAM_DIARY_PATH } = await import("@friday/shared"));
  ({ appendDreamEntry } = await import("./dream-diary.js"));
});

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

describe("appendDreamEntry", () => {
  it("AC15: writes one timestamped block with exact counts and a per-item table", () => {
    const ts = "2026-06-21T03:30:00.000Z";
    const report: DreamRunReport = {
      ts,
      promoted: 2,
      merged: 1,
      prunedFlagged: 1,
      reinforced: 0,
      items: [
        {
          action: "promoted",
          title: "Seth prefers worktrees by default",
          score: 72,
          evidence: "recurrence x3",
        },
        {
          action: "promoted",
          title: "Use psql-18 not bare psql",
          score: 64,
          evidence: "reference fact",
        },
        {
          action: "merged",
          title: "Duplicate worktree note absorbed",
          score: null,
          evidence: "near-duplicate, score 7",
        },
        {
          action: "pruned-flagged",
          title: "Stale 2024 deploy note",
          score: null,
          evidence: "cold: recallCount=0, age>60d",
        },
      ],
    };

    appendDreamEntry(report);

    const contents = readFileSync(DREAM_DIARY_PATH, "utf8");

    // Exactly one run heading for this ts.
    expect(countOccurrences(contents, `## ${ts} — dream run`)).toBe(1);

    // Counts line present verbatim (AC15 pins promoted/merged/pruned-flagged).
    expect(contents).toContain("promoted: 2, merged: 1, pruned-flagged: 1, reinforced: 0");

    // Table header present.
    expect(contents).toContain("| action | title | score | evidence |");
    expect(contents).toContain("| --- | --- | --- | --- |");

    // Per-item rows carry action + title + score.
    expect(contents).toContain(
      "| promoted | Seth prefers worktrees by default | 72 | recurrence x3 |",
    );
    expect(contents).toContain("| promoted | Use psql-18 not bare psql | 64 | reference fact |");
    // A score-less item renders the em-dash placeholder, still action+title present.
    expect(contents).toContain(
      "| merged | Duplicate worktree note absorbed | — | near-duplicate, score 7 |",
    );
    expect(contents).toContain(
      "| pruned-flagged | Stale 2024 deploy note | — | cold: recallCount=0, age>60d |",
    );
  });

  it("AC16: append-only — a second run adds a distinct dated block, leaving the first's bytes unchanged", () => {
    const ts1 = "2026-06-22T03:30:00.000Z";
    const report1: DreamRunReport = {
      ts: ts1,
      promoted: 1,
      merged: 0,
      prunedFlagged: 0,
      reinforced: 0,
      items: [{ action: "promoted", title: "First-run fact", score: 55, evidence: "user pref" }],
    };

    appendDreamEntry(report1);

    // Capture the exact bytes of the file after run 1.
    const afterRun1 = readFileSync(DREAM_DIARY_PATH);

    const ts2 = "2026-06-23T03:30:00.000Z";
    const report2: DreamRunReport = {
      ts: ts2,
      promoted: 0,
      merged: 0,
      prunedFlagged: 0,
      reinforced: 1,
      items: [
        { action: "reinforced", title: "Second-run fact", score: 61, evidence: "recall match" },
      ],
    };

    appendDreamEntry(report2);

    const afterRun2 = readFileSync(DREAM_DIARY_PATH);

    // Both run headings are present as two distinct dated blocks.
    const text = afterRun2.toString("utf8");
    expect(countOccurrences(text, `## ${ts1} — dream run`)).toBe(1);
    expect(countOccurrences(text, `## ${ts2} — dream run`)).toBe(1);

    // The earlier block's bytes are unchanged: run 1's file is an exact byte
    // prefix of run 2's file (append-only, no rewrite).
    expect(afterRun2.length).toBeGreaterThan(afterRun1.length);
    expect(afterRun2.subarray(0, afterRun1.length).equals(afterRun1)).toBe(true);
  });
});
