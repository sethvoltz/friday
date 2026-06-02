import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MemoryEntry } from "./store.js";

let entries: MemoryEntry[] = [];

// Force the FTS path to throw so the scoring logic falls back to the full-scan
// branch (mirrors search.test.ts). The pg.Pool stub's `query` rejects.
vi.mock("@friday/shared", () => ({
  getPool: () => ({
    query: () => Promise.reject(new Error("force fallback to full scan")),
  }),
}));

vi.mock("./store.js", () => ({
  listEntries: () => Promise.resolve(entries),
  touchRecall: () => Promise.resolve(),
}));

function mkEntry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    id: partial.id,
    title: partial.title ?? "",
    content: partial.content ?? "",
    tags: partial.tags ?? [],
    createdBy: "tester",
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    recallCount: partial.recallCount ?? 0,
    lastRecalledAt: null,
  };
}

beforeEach(() => {
  entries = [];
});

describe("buildAutoRecallBlock person exclusion (FRI-141)", () => {
  // AC#6: with excludeTags:["person"] and NO allowTags, the general case
  // suppresses person entries while keeping non-person hits.
  it("FRI-141 (AC#6): general case suppresses person entries, keeps project entries", async () => {
    const { buildAutoRecallBlock } = await import("./auto-recall.js");
    entries = [
      mkEntry({
        id: "code-1",
        title: "daemon worker fork",
        content: "the daemon forks workers on demand",
        tags: ["project"],
      }),
      mkEntry({
        id: "person-1",
        title: "Asher daemon notes",
        content: "asher cares about the daemon fork race",
        tags: ["person", "person:x"],
      }),
    ];

    const block = await buildAutoRecallBlock("daemon", { excludeTags: ["person"] });
    expect(block).toContain("(code-1)");
    expect(block).not.toContain("person-1");
  });

  // AC#7: allowTags carve-out surfaces ONLY the named person; the other person
  // stays suppressed.
  it("FRI-141 (AC#7): carve-out surfaces only the named person", async () => {
    const { buildAutoRecallBlock } = await import("./auto-recall.js");
    entries = [
      mkEntry({
        id: "person-asher",
        title: "Asher daemon notes",
        content: "asher cares about the daemon",
        tags: ["person", "person:asher"],
      }),
      mkEntry({
        id: "person-mike",
        title: "Mike daemon notes",
        content: "mike cares about the daemon",
        tags: ["person", "person:mike"],
      }),
    ];

    const block = await buildAutoRecallBlock("daemon", {
      excludeTags: ["person"],
      allowTags: ["person:asher"],
    });
    expect(block).toContain("person-asher");
    expect(block).not.toContain("person-mike");
  });

  // AC#9: worst case — person entries are engineered (full-phrase content +
  // high recallCount) to out-score code absent suppression. With no name in
  // the query, excludeTags must still keep every person id out of the block.
  // NOTE: the multi-token query triggers the AND-gate, so EVERY candidate
  // (code AND person) must contain ALL query tokens or it is silently dropped.
  it("FRI-141 (AC#9): worst-case high-recall persons stay suppressed with no name in the query", async () => {
    const { buildAutoRecallBlock } = await import("./auto-recall.js");
    const phrase = "fix the daemon worker fork race";
    entries = [
      mkEntry({
        id: "code-1",
        title: "engineering note one",
        content: `we need to fix the daemon worker fork race in the registry`,
        tags: ["project"],
      }),
      mkEntry({
        id: "code-2",
        title: "engineering note two",
        content: `another angle on how to fix the daemon worker fork race`,
        tags: ["project"],
      }),
      mkEntry({
        id: "person-hot-1",
        title: "Asher engineering chat",
        content: `asher said fix the daemon worker fork race`,
        tags: ["person", "person:asher"],
        recallCount: 50,
      }),
      mkEntry({
        id: "person-hot-2",
        title: "Mike engineering chat",
        content: `mike said fix the daemon worker fork race`,
        tags: ["person", "person:mike"],
        recallCount: 50,
      }),
    ];

    const block = await buildAutoRecallBlock(phrase, { excludeTags: ["person"] });
    expect(block).not.toContain("person-hot-1");
    expect(block).not.toContain("person-hot-2");
    // Sanity: the code entries (the only legitimate hits) do surface.
    expect(block).toContain("(code-1)");
  });

  // AC#10: scale + non-vacuity guard. 500 person entries engineered to out-score
  // code (full-phrase content + recallCount >= code) plus ~10 code entries.
  // (a) suppressed top ids == the same store WITHOUT the 500 person rows;
  // (b) ZERO of the 500 person ids appear in the suppressed block;
  // (c) CONTROL: the same call WITHOUT excludeTags DOES surface >=1 person id —
  //     proving the 500 rows are a real top-slice threat.
  it("FRI-141 (AC#10): 500 high-recall persons are fully suppressed and identity matches the person-free store", async () => {
    const { buildAutoRecallBlock } = await import("./auto-recall.js");
    const phrase = "fix the daemon worker fork race";

    const codeEntries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `code-${String(i).padStart(3, "0")}`;
      codeEntries.push(
        mkEntry({
          id,
          title: `engineering note ${id}`,
          content: `note ${id}: how to fix the daemon worker fork race cleanly`,
          tags: ["project"],
          recallCount: 5,
        }),
      );
    }

    const personEntries: MemoryEntry[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `person-${String(i).padStart(3, "0")}`;
      personEntries.push(
        mkEntry({
          id,
          title: `person note ${id}`,
          // Full query phrase so the AND-gate admits every person row; high
          // recallCount so unsuppressed they out-score the code entries.
          content: `${id} said fix the daemon worker fork race`,
          tags: ["person", `person:p${i}`],
          recallCount: 50,
        }),
      );
    }

    const idRe = /\(([^)]+)\)/g;
    const parseIds = (block: string): string[] => {
      const ids: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = idRe.exec(block)) !== null) ids.push(m[1]);
      return ids;
    };

    // Baseline: the person-free store (code only).
    entries = [...codeEntries];
    const baselineBlock = await buildAutoRecallBlock(phrase, { excludeTags: ["person"] });
    const baselineIds = parseIds(baselineBlock);

    // Suppressed: code + 500 persons, excludeTags engaged.
    entries = [...codeEntries, ...personEntries];
    const suppressedBlock = await buildAutoRecallBlock(phrase, { excludeTags: ["person"] });
    const suppressedIds = parseIds(suppressedBlock);

    // (a) identical top-id slice.
    expect(suppressedIds).toEqual(baselineIds);
    // (b) zero of the 500 person ids leak through.
    for (const p of personEntries) {
      expect(suppressedIds).not.toContain(p.id);
    }

    // (c) control: same store, NO excludeTags -> persons genuinely displace code.
    entries = [...codeEntries, ...personEntries];
    const controlBlock = await buildAutoRecallBlock(phrase);
    const controlIds = parseIds(controlBlock);
    const leakedPersonIds = controlIds.filter((id) => id.startsWith("person-"));
    expect(leakedPersonIds.length).toBeGreaterThanOrEqual(1);
  });
});
