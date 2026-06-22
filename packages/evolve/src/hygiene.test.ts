/**
 * FRI-26 — runHygiene tests (AC8 merge, AC9 decay, AC10 no-forgetEntry).
 *
 * Mirrors propose.test.ts's mocked-store convention: `@friday/memory` is mocked
 * with an in-memory Map-backed store, a faithful-enough `searchMemories` scorer
 * (token/tag weights match search.ts: +3 title, +1 content, +5 exact tag), and
 * a `forgetEntry` SPY that the tests assert is NEVER called — proving hygiene
 * archives by tag and never hard-deletes (preserve-over-delete).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@friday/memory";

const entries = new Map<string, MemoryEntry>();

/** Hard-delete spy. runHygiene must NEVER call this. */
const forgetEntrySpy = vi.fn(async (id: string) => {
  entries.delete(id);
});

vi.mock("@friday/memory", () => ({
  listEntries: async (): Promise<MemoryEntry[]> => [...entries.values()],
  getEntry: async (id: string): Promise<MemoryEntry | null> => entries.get(id) ?? null,
  saveEntry: async (entry: MemoryEntry): Promise<void> => {
    entries.set(entry.id, { ...entry });
  },
  // Mirror store.ts updateEntry: spread `...cur, ...patch`, bump updatedAt,
  // keep id. Omitting recallCount/lastRecalledAt from the patch PRESERVES them.
  updateEntry: async (id: string, patch: Partial<MemoryEntry>): Promise<void> => {
    const cur = entries.get(id);
    if (!cur) return;
    entries.set(id, {
      ...cur,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
  },
  // Faithful-enough scorer: per query token, +3 title, +1 content, +5 exact tag.
  // Returns SearchResult[] sorted desc by score (mirrors search.ts ordering).
  searchMemories: async (opts: {
    query: string;
    limit?: number;
  }): Promise<Array<{ entry: MemoryEntry; score: number; matchedOn: string[] }>> => {
    const tokens = opts.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const results: Array<{ entry: MemoryEntry; score: number; matchedOn: string[] }> = [];
    for (const entry of entries.values()) {
      const titleLc = entry.title.toLowerCase();
      const contentLc = entry.content.toLowerCase();
      const tagsLc = entry.tags.map((t) => t.toLowerCase());
      let score = 0;
      const matchedOn = new Set<string>();
      for (const tok of tokens) {
        if (titleLc.includes(tok)) {
          score += 3;
          matchedOn.add("title");
        }
        if (contentLc.includes(tok)) {
          score += 1;
          matchedOn.add("content");
        }
        for (let i = 0; i < tagsLc.length; i++) {
          if (tagsLc[i] === tok) {
            score += 5;
            matchedOn.add(`tag:${entry.tags[i]}`);
          }
        }
      }
      if (score > 0) results.push({ entry, score, matchedOn: [...matchedOn] });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.limit ?? 10);
  },
  forgetEntry: forgetEntrySpy,
}));

const { runHygiene } = await import("./hygiene.js");
const memory = await import("@friday/memory");

function makeEntry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: over.id,
    title: over.title ?? over.id,
    content: over.content ?? "",
    tags: over.tags ?? [],
    createdBy: over.createdBy ?? "test",
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    recallCount: over.recallCount ?? 0,
    lastRecalledAt: over.lastRecalledAt ?? null,
  };
}

beforeEach(() => {
  entries.clear();
  forgetEntrySpy.mockClear();
});

describe("runHygiene — merge near-duplicates (AC8)", () => {
  it("folds the lower-recall dup into the higher-recall survivor, archives by tag, never hard-deletes", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    // A and B are near-identical (same title + a shared exact tag → score >= 5).
    // A is the survivor (recallCount 5, recently recalled); B is absorbed.
    const A = makeEntry({
      id: "deploy-via-friday-update",
      title: "Deploy via friday update",
      content: "Use friday update then friday restart.",
      tags: ["evolve", "memory:dreaming", "deploy"],
      recallCount: 5,
      lastRecalledAt: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const B = makeEntry({
      id: "deploy-via-friday-update-2",
      title: "Deploy via friday update",
      content: "Deploy is friday update plus restart; no brew.",
      tags: ["evolve", "deploy"],
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    await memory.saveEntry(A);
    await memory.saveEntry(B);

    const report = await runHygiene([...entries.values()], { now });

    // Exactly one merge, A survives, B absorbed.
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0].survivorId).toBe(A.id);
    expect(report.merged[0].absorbedId).toBe(B.id);
    expect(report.archived).toContain(B.id);

    // Survivor A: recallCount PRESERVED (>= 5), no archive tag, content folded.
    const survivor = await memory.getEntry(A.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.recallCount).toBeGreaterThanOrEqual(5);
    expect(survivor!.lastRecalledAt).toBe("2026-06-20T00:00:00.000Z");
    expect(survivor!.tags).not.toContain("archived");
    expect(survivor!.content).toContain("no brew");

    // Exactly one entry in the active (non-archived) set.
    const active = [...entries.values()].filter((e) => !e.tags.includes("archived"));
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(A.id);

    // Absorbed B: archived by TAG, row still present (not hard-deleted).
    const absorbed = await memory.getEntry(B.id);
    expect(absorbed).not.toBeNull();
    expect(absorbed!.tags).toContain("archived");

    // Preserve-over-delete: forgetEntry NEVER called.
    expect(forgetEntrySpy).toHaveBeenCalledTimes(0);
  });

  it("accumulates content+tags cumulatively when ONE survivor absorbs TWO+ losers (F1)", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    // A (highest recall) is the survivor; B and C are near-dups it absorbs in a
    // single pass. The bug F1 fixes: the second fold read the STALE survivor
    // content, silently destroying the first loser's content + tags. This pins
    // that BOTH losers' unique content + tags land on the survivor.
    const A = makeEntry({
      id: "habits-core",
      title: "Habits core tracker",
      content: "ALPHA survivor content.",
      tags: ["evolve", "habits", "tagA"],
      recallCount: 10,
      lastRecalledAt: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const B = makeEntry({
      id: "habits-core-2",
      title: "Habits core tracker",
      content: "BRAVO unique content from loser B.",
      tags: ["evolve", "habits", "tagB"],
      recallCount: 5,
      createdAt: "2026-06-05T00:00:00.000Z",
    });
    const C = makeEntry({
      id: "habits-core-3",
      title: "Habits core tracker",
      content: "CHARLIE unique content from loser C.",
      tags: ["evolve", "habits", "tagC"],
      recallCount: 2,
      createdAt: "2026-06-08T00:00:00.000Z",
    });
    await memory.saveEntry(A);
    await memory.saveEntry(B);
    await memory.saveEntry(C);

    const report = await runHygiene([...entries.values()], { now });

    // Two merges, both with A as survivor.
    expect(report.merged).toHaveLength(2);
    expect(report.merged.every((m) => m.survivorId === A.id)).toBe(true);
    expect(report.merged.map((m) => m.absorbedId).sort()).toEqual([B.id, C.id]);

    // Survivor A retains its own + BOTH losers' content (no clobber).
    const survivor = await memory.getEntry(A.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.content).toContain("ALPHA survivor content.");
    expect(survivor!.content).toContain("BRAVO unique content from loser B.");
    expect(survivor!.content).toContain("CHARLIE unique content from loser C.");
    // And BOTH losers' unique tags.
    expect(survivor!.tags).toContain("tagB");
    expect(survivor!.tags).toContain("tagC");
    // recall metadata preserved, not archived.
    expect(survivor!.recallCount).toBeGreaterThanOrEqual(10);
    expect(survivor!.lastRecalledAt).toBe("2026-06-20T00:00:00.000Z");
    expect(survivor!.tags).not.toContain("archived");

    // Both losers archived by tag, rows intact, never hard-deleted.
    for (const loser of [B, C]) {
      const row = await memory.getEntry(loser.id);
      expect(row).not.toBeNull();
      expect(row!.tags).toContain("archived");
    }
    const active = [...entries.values()].filter((e) => !e.tags.includes("archived"));
    expect(active.map((e) => e.id)).toEqual([A.id]);
    expect(forgetEntrySpy).toHaveBeenCalledTimes(0);
  });

  it("is idempotent — a second runHygiene over the already-merged corpus does nothing (F1)", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    const A = makeEntry({
      id: "dup-a",
      title: "Shared dup title",
      content: "A content.",
      tags: ["evolve", "shared"],
      recallCount: 4,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const B = makeEntry({
      id: "dup-b",
      title: "Shared dup title",
      content: "B content.",
      tags: ["evolve", "shared"],
      recallCount: 1,
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    await memory.saveEntry(A);
    await memory.saveEntry(B);

    const first = await runHygiene([...entries.values()], { now });
    expect(first.merged).toHaveLength(1);

    const survivorAfterFirst = await memory.getEntry(A.id);
    const contentAfterFirst = survivorAfterFirst!.content;

    // Re-run over the post-merge corpus (B now carries `archived`).
    const second = await runHygiene([...entries.values()], { now });
    // No new merges, no new archives — the already-archived loser is skipped.
    expect(second.merged).toHaveLength(0);
    expect(second.archived).toHaveLength(0);
    // Survivor content byte-unchanged (no double-fold).
    const survivorAfterSecond = await memory.getEntry(A.id);
    expect(survivorAfterSecond!.content).toBe(contentAfterFirst);
    expect(forgetEntrySpy).toHaveBeenCalledTimes(0);
  });
});

describe("runHygiene — decay cold entries (AC9)", () => {
  it("flags + archives a cold entry past the grace window without hard-deleting it", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    // Cold: recallCount 0, never recalled, created ~50d ago (past 30d grace).
    const cold = makeEntry({
      id: "stale-note",
      title: "Stale note nobody recalls",
      content: "An old fact that has gone cold.",
      tags: ["evolve"],
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await memory.saveEntry(cold);
    const before = (await memory.listEntries()).length;

    const report = await runHygiene([...entries.values()], { now });

    // Flagged as a decay candidate AND archived via updateEntry tag.
    expect(report.decayCandidates).toContain(cold.id);
    expect(report.archived).toContain(cold.id);

    const after = await memory.getEntry(cold.id);
    expect(after).not.toBeNull();
    expect(after!.tags).toContain("archived");

    // NOT hard-deleted: row still present, listEntries length unchanged.
    expect((await memory.listEntries()).length).toBe(before);
    expect(forgetEntrySpy).toHaveBeenCalledTimes(0);
  });

  it("does NOT flag a recently-created entry still inside the grace window", async () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    const fresh = makeEntry({
      id: "fresh-note",
      title: "Brand new note",
      content: "Just written, not yet recalled.",
      tags: ["evolve"],
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: "2026-06-20T00:00:00.000Z", // 1 day old → inside 30d grace
    });
    await memory.saveEntry(fresh);

    const report = await runHygiene([...entries.values()], { now });

    expect(report.decayCandidates).not.toContain(fresh.id);
    const after = await memory.getEntry(fresh.id);
    expect(after!.tags).not.toContain("archived");
    expect(forgetEntrySpy).toHaveBeenCalledTimes(0);
  });
});

describe("runHygiene — preserve-over-delete static guard (AC10)", () => {
  it("hygiene.ts source never imports or references forgetEntry", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./hygiene.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/forgetEntry/);
  });
});

describe("dreaming memory-access static guard (AC7 — no new search surface)", () => {
  // ADR-025: the dream sub-pass dedups via the EXISTING in-proc `@friday/memory`
  // hop (searchMemories/updateEntry/getEntry/listEntries/saveEntry) — it must
  // NOT open a fresh Postgres/Zero/db search surface. These static-source
  // assertions pin that hygiene.ts and dreaming-pipeline.ts touch memory only
  // through `@friday/memory`.

  // Direct data-tier symbols that would signal a bypass of the memory package.
  // (`getPool`/`getDb` are the @friday/shared raw-Postgres accessors; pgvector
  // `<=>` / `content_tsv` / plainto_tsquery are the search internals that live
  // ONLY inside packages/memory; `@rocicorp/zero` is the sync surface.)
  const FORBIDDEN_SEARCH_SURFACE = [
    /\bgetPool\b/,
    /\bgetDb\b/,
    /from\s+["']pg["']/,
    /@rocicorp\/zero/,
    /@friday\/shared\/db/,
    /content_tsv/,
    /plainto_tsquery/,
    /<=>/, // pgvector cosine operator — search.ts internal
  ];

  for (const file of ["./hygiene.ts", "./dreaming-pipeline.ts"]) {
    it(`${file} accesses memory ONLY via @friday/memory (no direct pg/Zero/db search surface)`, async () => {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      // The only memory-data import must be from @friday/memory.
      expect(src).toMatch(/from\s+["']@friday\/memory["']/);
      for (const pat of FORBIDDEN_SEARCH_SURFACE) {
        expect(src, `${file} must not reference ${pat}`).not.toMatch(pat);
      }
    });
  }
});
