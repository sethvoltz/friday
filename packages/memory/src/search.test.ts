import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MemoryEntry } from "./store.js";

let entries: MemoryEntry[] = [];

// FTS candidate ids the mocked Postgres pool returns. `null` (the default)
// makes the FTS query reject so the scoring logic falls back to the full-scan
// branch — the mode every pre-existing test relies on. A test that wants to
// exercise the FTS-narrow branch sets `ftsRows` to the candidate id rows it
// should see.
let ftsRows: { id: string }[] | null = null;

// FRI-24: cosine rows the mocked Postgres pool returns for the VECTOR candidate
// query (the `embedding <=> $1::vector` SELECT). `null` (default) makes that
// query reject → vector path fails open. Set to an array of {id,cosine} to
// drive the hybrid path.
let vecRows: { id: string; cosine: number }[] | null = null;

// FRI-24: the vector the mocked embedText returns for the query. `null` (the
// default) makes the embedder unavailable → vector path entirely skipped →
// FTS-only behavior. A number[] enables the hybrid path.
let queryVector: number[] | null = null;

// ADR-023: production code uses `getPool()` (returns pg.Pool whose `query` is
// awaitable). The stub branches on the SQL string: the vector candidate query
// contains `<=>`, the FTS query contains `content_tsv`. Each independently
// rejects (→ fallback / fail-open) unless its row source is set.
vi.mock("@friday/shared", () => ({
  getPool: () => ({
    query: (sqlText: string) => {
      if (sqlText.includes("<=>") || sqlText.includes("embedding")) {
        return vecRows === null
          ? Promise.reject(new Error("force vector fail-open"))
          : Promise.resolve({ rows: vecRows });
      }
      return ftsRows === null
        ? Promise.reject(new Error("force fallback to full scan"))
        : Promise.resolve({ rows: ftsRows });
    },
  }),
}));

vi.mock("./embed.js", () => ({
  embedText: () => Promise.resolve(queryVector),
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
  ftsRows = null;
  vecRows = null;
  queryVector = null;
});

describe("searchMemories scoring", () => {
  it("multi-word query matches entry containing all tokens (AND)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "a",
        title: "Friday memory subsystem",
        content: "discusses recall and storage details",
      }),
      mkEntry({
        id: "b",
        title: "Friday only",
        content: "no other token here",
      }),
    ];

    const results = await searchMemories({ query: "friday memory" });
    expect(results.map((r) => r.entry.id)).toEqual(["a"]);
    expect(results[0].matchedOn).toContain("title");
  });

  it("multi-word query matches when tokens are split across title and content", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "split",
        title: "Daemon architecture",
        content: "the orchestrator forks workers",
      }),
      mkEntry({
        id: "nomatch",
        title: "Daemon only",
        content: "nothing relevant",
      }),
    ];

    const results = await searchMemories({ query: "daemon orchestrator" });
    expect(results.map((r) => r.entry.id)).toEqual(["split"]);
    const r = results[0];
    expect(r.matchedOn).toEqual(expect.arrayContaining(["title", "content"]));
  });

  it("single-word query keeps prior scoring behavior", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "title-hit",
        title: "alpha topic",
        content: "unrelated body",
      }),
      mkEntry({
        id: "content-hit",
        title: "different",
        content: "the word alpha appears here",
      }),
      mkEntry({
        id: "tag-hit",
        title: "neither",
        content: "neither",
        tags: ["alpha"],
      }),
    ];

    const results = await searchMemories({ query: "alpha" });
    // Tag exact-match (5) > title contains (3) > content contains (1).
    expect(results.map((r) => r.entry.id)).toEqual(["tag-hit", "title-hit", "content-hit"]);
    expect(results[0].matchedOn).toEqual(["tag:alpha"]);
  });

  it("tag filter unchanged: rejects entries missing required tags", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "tagged",
        title: "matches query",
        content: "body",
        tags: ["needed", "extra"],
      }),
      mkEntry({
        id: "untagged",
        title: "matches query",
        content: "body",
        tags: ["other"],
      }),
    ];

    const results = await searchMemories({ query: "matches", tags: ["needed"] });
    expect(results.map((r) => r.entry.id)).toEqual(["tagged"]);
  });

  it("multi-word query excludes entries that match only one token", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "partial",
        title: "Friday docs",
        content: "no second token",
      }),
    ];

    const results = await searchMemories({ query: "friday memory" });
    expect(results).toEqual([]);
  });

  // FRI-34: when a tag filter is supplied, tags are the authoritative selector
  // and the query is a ranking signal only. Tag-matched entries must come back
  // even when the query token isn't anywhere in their title/content/tags.
  it("FRI-34: tag filter returns all tagged entries even when query token is absent", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "bucket-a",
        title: "alpha entry",
        content: "body about apples",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-b",
        title: "bravo entry",
        content: "body about bananas",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-c",
        title: "charlie entry",
        content: "body about cherries",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-d",
        title: "delta entry",
        content: "body about dates",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-e",
        title: "echo entry",
        content: "body about eggplant",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "noise",
        title: "unrelated",
        content: "no bucket here",
        tags: ["other:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo", tags: ["test:bucket"] });
    expect(results.map((r) => r.entry.id).sort()).toEqual([
      "bucket-a",
      "bucket-b",
      "bucket-c",
      "bucket-d",
      "bucket-e",
    ]);
    // The untagged entry must not slip in.
    expect(results.map((r) => r.entry.id)).not.toContain("noise");
  });

  it("FRI-34: without tag filter, same query returns zero (AND-gate still applies)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "bucket-a",
        title: "alpha entry",
        content: "body about apples",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-b",
        title: "bravo entry",
        content: "body about bananas",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-c",
        title: "charlie entry",
        content: "body about cherries",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-d",
        title: "delta entry",
        content: "body about dates",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "bucket-e",
        title: "echo entry",
        content: "body about eggplant",
        tags: ["test:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo" });
    expect(results).toEqual([]);
  });

  it("FRI-34: query+tag matches rank above tag-only matches", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "tag-only",
        title: "alpha entry",
        content: "no relevant token here",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "title-and-tag",
        title: "foo handling",
        content: "no body match",
        tags: ["test:bucket"],
      }),
      mkEntry({
        id: "content-and-tag",
        title: "delta entry",
        content: "the foo appears in body",
        tags: ["test:bucket"],
      }),
    ];

    const results = await searchMemories({ query: "foo", tags: ["test:bucket"] });
    // All three return; title-match (+3) outranks content-match (+1) which
    // outranks tag-only (score 0). Order: title-and-tag, content-and-tag, tag-only.
    expect(results.map((r) => r.entry.id)).toEqual([
      "title-and-tag",
      "content-and-tag",
      "tag-only",
    ]);
    expect(results[0].matchedOn).toContain("title");
    expect(results[1].matchedOn).toContain("content");
    expect(results[2].matchedOn).toEqual([]);
  });

  // FRI-141 (AC#2): excludeTags removes person entries from the tag-less
  // (FTS-fallback) path even when they share the query token.
  it("FRI-141: excludeTags drops person entries on the tag-less path", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "code-1",
        title: "daemon worker",
        content: "the daemon forks workers",
        tags: ["project"],
      }),
      mkEntry({
        id: "code-2",
        title: "daemon scheduler",
        content: "the daemon schedules jobs",
        tags: ["project"],
      }),
      mkEntry({
        id: "person-1",
        title: "Asher the daemon fan",
        content: "the daemon is asher's favourite topic",
        tags: ["person", "person:asher"],
      }),
    ];

    const results = await searchMemories({ query: "daemon", excludeTags: ["person"] });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toEqual(["code-1", "code-2"]);
    expect(ids).not.toContain("person-1");
  });

  // FRI-26 (AC11): the hygiene pass archives a memory by adding an `archived`
  // tag (no schema status — Decision A). searchMemories has no status awareness;
  // suppression rides the same tag-only excludeTags mechanism as the FRI-141
  // person carve-out. This is the load-bearing half of AC11: it proves the
  // mechanism only suppresses when the CALLER passes excludeTags:["archived"]
  // (the recall-hook change). Same query + corpus, with and without the exclude.
  it("FRI-26: excludeTags:['archived'] suppresses an archived entry that would otherwise match", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "live-1",
        title: "daemon worker pool",
        content: "the daemon forks workers",
        tags: ["project"],
      }),
      mkEntry({
        id: "archived-1",
        title: "stale daemon notes",
        content: "the daemon notes that were merged away",
        tags: ["project", "archived"],
      }),
    ];

    // Baseline: WITHOUT the exclude, the archived entry matches "daemon" and is
    // returned — proving it is a genuine match the exclude must remove.
    const withoutExclude = await searchMemories({ query: "daemon" });
    const baselineIds = withoutExclude.map((r) => r.entry.id);
    expect(baselineIds).toContain("archived-1");
    expect(baselineIds).toContain("live-1");

    // With excludeTags:["archived"] (what the recall hook now passes), the
    // archived entry is suppressed while the live entry survives.
    const withExclude = await searchMemories({ query: "daemon", excludeTags: ["archived"] });
    const ids = withExclude.map((r) => r.entry.id);
    expect(ids).toEqual(["live-1"]);
    expect(ids).not.toContain("archived-1");
  });

  // FRI-141 (AC#3): exclusion wins over inclusion for a dual-tagged entry —
  // the tag filter admits it, then excludeTags removes it.
  it("FRI-141: excludeTags removes a dual-tagged entry even when it satisfies the tag filter", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "x-and-person",
        title: "shared topic",
        content: "matches the query body",
        tags: ["x", "person"],
      }),
      mkEntry({
        id: "x-only",
        title: "shared topic",
        content: "matches the query body",
        tags: ["x"],
      }),
    ];

    const results = await searchMemories({
      query: "query",
      tags: ["x"],
      excludeTags: ["person"],
    });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toEqual(["x-only"]);
    expect(ids).not.toContain("x-and-person");
  });

  // FRI-141 (AC#4): allowTags re-admits ONLY the name-matched person at the
  // ranker level — the matched person comes back, the other stays excluded.
  it("FRI-141: allowTags re-admits only the name-matched person", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "person-asher",
        title: "Asher notes",
        content: "asher likes the daemon",
        tags: ["person", "person:asher"],
      }),
      mkEntry({
        id: "person-mike",
        title: "Mike notes",
        content: "mike likes the daemon",
        tags: ["person", "person:mike"],
      }),
    ];

    const results = await searchMemories({
      query: "daemon",
      excludeTags: ["person"],
      allowTags: ["person:asher"],
    });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain("person-asher");
    expect(ids).not.toContain("person-mike");
  });

  // FRI-141 (AC#5): an explicit person search (tags filter, no exclude/allow)
  // still returns exactly the matching person entries — the exclusion only
  // engages when excludeTags is supplied (the passive-recall path).
  it("FRI-141: explicit tags:['person:asher'] search is unaffected by the carve-out machinery", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "asher-1",
        title: "Asher food",
        content: "asher loves the daemon talk",
        tags: ["person", "person:asher", "food"],
      }),
      mkEntry({
        id: "asher-2",
        title: "Asher work",
        content: "asher works on the daemon",
        tags: ["person", "person:asher", "work"],
      }),
      mkEntry({
        id: "mike-1",
        title: "Mike work",
        content: "mike works on the daemon",
        tags: ["person", "person:mike", "work"],
      }),
    ];

    const results = await searchMemories({ query: "daemon", tags: ["person:asher"] });
    expect(results.map((r) => r.entry.id).sort()).toEqual(["asher-1", "asher-2"]);
  });

  // Adjacent ranking bug noted in FRI-34: a `library` token should earn some
  // credit against an entry tagged `meal:library` even without a tag filter.
  it("FRI-34: substring tag match earns partial credit (+2), not zero", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "namespaced",
        title: "weekly menu",
        content: "library staples to keep stocked",
        tags: ["meal:library"],
      }),
      mkEntry({
        id: "no-tag",
        title: "the library list",
        content: "unrelated body",
      }),
    ];

    const results = await searchMemories({ query: "library" });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain("namespaced");
    expect(ids).toContain("no-tag");
    // `namespaced` gets content (+1) + tag~ (+2) = 3 ≥ `no-tag` title-only (+3).
    // Both should appear; the namespaced entry's matchedOn must call out the
    // partial-tag hit so callers can see why it ranked.
    const namespaced = results.find((r) => r.entry.id === "namespaced")!;
    expect(namespaced.matchedOn).toEqual(expect.arrayContaining(["content", "tag~:meal:library"]));
  });

  // FRI-141: the exclusion gate lives in the shared scan loop, so it must hold
  // on the FTS-narrow branch too — not just the full-scan fallback every other
  // test exercises. Drive the FTS path (ftsRows set) and confirm a person entry
  // in the FTS candidate set is still excluded, while a matching entry NOT in
  // the candidate set is correctly absent (proving the narrow actually applied).
  it("FRI-141: excludeTags holds on the FTS-narrow branch (not just the full-scan fallback)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({ id: "code-x", title: "daemon notes", content: "the daemon", tags: ["project"] }),
      mkEntry({
        id: "person-x",
        title: "Asher daemon",
        content: "asher and the daemon",
        tags: ["person", "person:asher"],
      }),
      mkEntry({ id: "code-y", title: "daemon other", content: "the daemon", tags: ["project"] }),
    ];
    // FTS narrows to code-x + person-x only (code-y is a matching entry the FTS
    // query did NOT return).
    ftsRows = [{ id: "code-x" }, { id: "person-x" }];

    const results = await searchMemories({ query: "daemon", excludeTags: ["person"] });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toEqual(["code-x"]);
    expect(ids).not.toContain("person-x"); // excluded despite being an FTS candidate
    expect(ids).not.toContain("code-y"); // proves the FTS narrow ran (full scan would include it)
  });

  // FRI-141: preloadedEntries lets the daemon recall hook hand the ranker the
  // entry set it already loaded (for the name-match), so passive recall does one
  // listEntries() per turn instead of two. When supplied, the store is NOT read.
  it("FRI-141: preloadedEntries is ranked instead of reading the store", async () => {
    const { searchMemories } = await import("./search.js");
    // The mocked store would return this decoy — it must NOT appear.
    entries = [mkEntry({ id: "from-store", title: "daemon", content: "the daemon" })];

    const results = await searchMemories({
      query: "daemon",
      preloadedEntries: [mkEntry({ id: "from-preload", title: "daemon", content: "the daemon" })],
    });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toEqual(["from-preload"]);
    expect(ids).not.toContain("from-store");
  });

  // FRI-24 (AC7): vector recall surfaces a semantically-related entry that
  // shares NO query token. Entry A matches the query lexically; entry B is
  // semantically related ("Login & session sign-in flow") but contains none of
  // the query tokens, so FTS alone returns only A. With the embedder live and a
  // strong cosine on B (>= VEC_MIN), hybrid recall returns BOTH — A still ranks
  // first on its large lexical score, B is admitted purely by its cosine.
  it("vector recall surfaces a semantically-related entry that FTS-alone misses", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "A",
        title: "How do we authenticate users",
        content: "authenticate users via the API",
      }),
      mkEntry({
        id: "B",
        title: "Login & session sign-in flow",
        content: "credential exchange and session cookies",
      }),
    ];

    // FTS-only baseline: embedder unavailable → only A (lexical) comes back.
    queryVector = null;
    vecRows = null;
    const ftsOnly = await searchMemories({ query: "how do we authenticate users" });
    expect(ftsOnly.map((r) => r.entry.id)).toEqual(["A"]);

    // Hybrid: embedder live; vector query ranks B high, A low.
    queryVector = [0.1, 0.2, 0.3];
    vecRows = [
      { id: "B", cosine: 0.88 },
      { id: "A", cosine: 0.2 },
    ];
    const hybrid = await searchMemories({ query: "how do we authenticate users" });
    const ids = hybrid.map((r) => r.entry.id);
    expect(ids).toContain("B");
    // B's cosine (0.88*3=2.64) beats A's lexical "authenticate"+"users" content
    // hits + weak cosine. Pin the full ordered array.
    expect(ids).toEqual(["A", "B"]);
    const b = hybrid.find((r) => r.entry.id === "B")!;
    expect(b.matchedOn).toContain("vector");
  });

  // FRI-24 (AC8): AND-gate preserved for non-semantic noise. Entry C matches no
  // query token AND its cosine is below VEC_MIN (0.75) → it must NOT survive.
  it("AND-gate preserved for non-semantic noise", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "match",
        title: "authenticate users guide",
        content: "how we authenticate users",
      }),
      mkEntry({
        id: "C",
        title: "unrelated grocery list",
        content: "milk eggs bread",
      }),
    ];
    queryVector = [0.1, 0.2, 0.3];
    vecRows = [
      { id: "match", cosine: 0.9 },
      { id: "C", cosine: 0.4 }, // below VEC_MIN and no token match → dropped
    ];

    const results = await searchMemories({ query: "authenticate users" });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain("match");
    expect(ids).not.toContain("C");
  });

  // FRI-24 (AC9): tag bypass unchanged (FRI-34 regression). With a tags filter,
  // a tag-matched entry whose body matches no query token AND has a low cosine
  // is STILL returned — the vector path is skipped entirely for tags-only
  // queries, so it neither drops the entry nor is needed to admit it.
  it("tag bypass unchanged (FRI-34 regression)", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({
        id: "tagged",
        title: "no token here",
        content: "nothing relevant in the body",
        tags: ["test:bucket"],
      }),
    ];
    // Even if the embedder were live with a low cosine, the tags-only path must
    // not consult it.
    queryVector = [0.1, 0.2, 0.3];
    vecRows = [{ id: "tagged", cosine: 0.1 }];

    const results = await searchMemories({ query: "foo", tags: ["test:bucket"] });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toEqual(["tagged"]);
    // The tags-only path never adds a vector contribution.
    expect(results[0].matchedOn).not.toContain("vector");
  });

  // FRI-24 (AC10): FTS fallback when embeddings unavailable. With embedText →
  // null the vector path is entirely skipped and the result is byte-identical
  // to a pure FTS-only run on the same seed — same ids, same order, non-empty,
  // no throw.
  it("FTS fallback when embeddings unavailable", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({ id: "p", title: "daemon worker pool", content: "the daemon forks workers" }),
      mkEntry({ id: "q", title: "daemon scheduler", content: "the daemon schedules daemon jobs" }),
      mkEntry({ id: "r", title: "unrelated", content: "nothing here" }),
    ];

    // Baseline: embedder explicitly OFF (the AC10 fallback path — the vector
    // block is skipped entirely).
    queryVector = null;
    vecRows = null;
    const baseline = await searchMemories({ query: "daemon" });
    const baselineIds = baseline.map((r) => r.entry.id);
    expect(baselineIds).not.toEqual([]);
    expect(baselineIds).toContain("p");
    expect(baselineIds).toContain("q");
    expect(baselineIds).not.toContain("r");
    for (const r of baseline) expect(r.matchedOn).not.toContain("vector");

    // Contrast (NOT a re-run of the same path): embedder LIVE but the vector
    // query yields NO candidates. This actually exercises the hybrid machinery
    // (embed + vector SELECT + union) yet must produce a byte-identical id list
    // + order to the FTS-only baseline — proving the vector term is a true
    // additive no-op, not merely that the function is deterministic.
    queryVector = [0.1, 0.2, 0.3];
    vecRows = [];
    const hybridNoHits = await searchMemories({ query: "daemon" });
    expect(hybridNoHits.map((r) => r.entry.id)).toEqual(baselineIds);
    for (const r of hybridNoHits) expect(r.matchedOn).not.toContain("vector");
  });

  // FRI-24: the OTHER fail-open interleaving — embedText SUCCEEDS but the vector
  // SQL query THROWS mid-flight (e.g. a transient index error). The catch must
  // leave the FTS candidate set + scores untouched → byte-identical to FTS-only.
  it("vector-query error after a successful embed falls back to FTS-only", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({ id: "p", title: "daemon worker pool", content: "the daemon forks workers" }),
      mkEntry({ id: "q", title: "daemon scheduler", content: "the daemon schedules daemon jobs" }),
      mkEntry({ id: "r", title: "unrelated", content: "nothing here" }),
    ];
    queryVector = null;
    vecRows = null;
    const baselineIds = (await searchMemories({ query: "daemon" })).map((r) => r.entry.id);

    // embedText returns a vector (non-null) BUT the vector query rejects
    // (vecRows=null → the mock throws on the `<=>` query).
    queryVector = [0.1, 0.2, 0.3];
    vecRows = null;
    const afterThrow = await searchMemories({ query: "daemon" });
    expect(afterThrow.map((r) => r.entry.id)).toEqual(baselineIds);
    for (const r of afterThrow) expect(r.matchedOn).not.toContain("vector");
  });

  // FRI-141 × FRI-24: excludeTags (person-recall suppression) must win over a
  // high-cosine vector-only hit. The excludeTags `continue` fires BEFORE the
  // relaxed cosine gate, so a person entry the vector path would otherwise admit
  // (cosine ≥ VEC_MIN, no shared token) stays suppressed.
  it("excludeTags suppresses a high-cosine vector-only person hit", async () => {
    const { searchMemories } = await import("./search.js");
    entries = [
      mkEntry({ id: "person1", title: "Alice", content: "private notes", tags: ["person"] }),
      mkEntry({ id: "proj1", title: "project plan", content: "the roadmap", tags: ["project"] }),
    ];
    // Live embedder; the person entry ranks well above VEC_MIN (0.75) and shares
    // NO query token — the relaxed AND-gate would admit it absent excludeTags.
    queryVector = [0.1, 0.2, 0.3];
    vecRows = [
      { id: "person1", cosine: 0.95 },
      { id: "proj1", cosine: 0.2 },
    ];
    const ids = (await searchMemories({ query: "roadmap", excludeTags: ["person"] })).map(
      (r) => r.entry.id,
    );
    // person1 (cosine 0.95 ≥ VEC_MIN, no token) would be admitted by the relaxed
    // gate, but excludeTags drops it first; proj1 is admitted via the "roadmap"
    // token match.
    expect(ids).not.toContain("person1");
    expect(ids).toContain("proj1");
  });
});
