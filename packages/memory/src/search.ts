import { getPool } from "@friday/shared";
import { embedText } from "./embed.js";
import { listEntries, touchRecall, type MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Hybrid-ranking constants (FRI-24). The vector path AUGMENTS FTS, never
// replaces it: a cosine contribution is added to the token score, and a
// vector-only hit survives the AND-gate iff its cosine clears VEC_MIN.
// ---------------------------------------------------------------------------

/** Weight applied to an entry's cosine similarity when adding it to the token
 *  score. Tuned so a strong semantic match (cosine→1) contributes on the order
 *  of a title hit (+3) without drowning exact lexical matches. */
const VEC_WEIGHT = 3;

/** Minimum cosine for a vector-only hit (no token match) to survive the
 *  AND-gate. Below this a non-lexical entry is treated as noise and dropped. */
const VEC_MIN = 0.75;

/** Cap on vector candidates pulled from the ANN index per query. */
const VEC_K = 50;

export interface SearchOptions {
  query: string;
  tags?: string[];
  excludeTags?: string[];
  allowTags?: string[];
  limit?: number;
  trackRecall?: boolean;
  /**
   * FRI-141: an already-loaded entry set to rank against instead of re-reading
   * the store. The daemon recall hook loads `listEntries()` once to compute the
   * name-mention carve-out, then threads the same array here so passive recall
   * does a single full-table scan per turn rather than two. Omit it and the
   * ranker reads the store itself (every other caller).
   */
  preloadedEntries?: MemoryEntry[];
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  matchedOn: string[];
}

export async function searchMemories(opts: SearchOptions): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;
  const q = opts.query.trim();
  if (!q) return [];

  const tags = opts.tags ?? [];
  const excludeTags = opts.excludeTags ?? [];
  const allowTags = opts.allowTags ?? [];
  const allEntries = opts.preloadedEntries ?? (await listEntries());

  // When a tag filter is supplied, the caller is asking "give me everything
  // tagged X, ranked by relevance to query" — tags are the authoritative
  // selector and FTS would wrongly exclude tag-matched entries whose body
  // doesn't literally contain query tokens. Skip the FTS narrow and let
  // the loop's tag-membership check be the only gate.
  let candidatePool: MemoryEntry[];
  if (tags.length > 0) {
    candidatePool = allEntries;
  } else {
    // Postgres FTS: use the `content_tsv` generated column populated by
    // schema.ts FTS_SETUP_SQL. plainto_tsquery is forgiving on user input
    // (handles missing operators, stop words, etc.).
    const pool = getPool();
    let candidateIds: string[] = [];
    try {
      const ftsRows = await pool.query<{ id: string }>(
        `SELECT id
           FROM memory_entries
          WHERE content_tsv @@ plainto_tsquery('english', $1)
          ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $1)) DESC
          LIMIT 100`,
        [q],
      );
      candidateIds = ftsRows.rows.map((r) => r.id);
    } catch {
      candidateIds = [];
    }
    candidatePool =
      candidateIds.length > 0 ? allEntries.filter((e) => candidateIds.includes(e.id)) : allEntries; // FTS fallback: scan all
  }

  // ------------------------------------------------------------------------
  // FRI-24 hybrid recall: when this is NOT a tags-only query, embed the query
  // and pull the nearest vector candidates. Each candidate's cosine is added
  // to the token score, and a strong vector-only hit (cosine >= VEC_MIN) can
  // survive the AND-gate even with no lexical match. FAIL-OPEN: if the model
  // is unavailable (embedText → null) or the vector query errors, this whole
  // block is skipped and searchMemories returns EXACTLY the FTS-only result
  // — same ids, same order.
  // ------------------------------------------------------------------------
  const cosineById = new Map<string, number>();
  if (tags.length === 0) {
    const qvec = await embedText(q);
    if (qvec) {
      try {
        const pool = getPool();
        const literal = `[${qvec.join(",")}]`;
        const vecRows = await pool.query<{ id: string; cosine: number }>(
          `SELECT id, 1 - (embedding <=> $1::vector) AS cosine
             FROM memory_entries
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2`,
          [literal, VEC_K],
        );
        for (const row of vecRows.rows) {
          cosineById.set(row.id, Number(row.cosine));
        }
        // Union vector candidates that the FTS narrow didn't already include.
        // Build a fresh array — `candidatePool` may alias `allEntries` (or the
        // caller's preloadedEntries) on the FTS-fallback path, so mutating it
        // in place would leak into the caller's set.
        const present = new Set(candidatePool.map((e) => e.id));
        const extra = allEntries.filter((e) => cosineById.has(e.id) && !present.has(e.id));
        if (extra.length > 0) candidatePool = [...candidatePool, ...extra];
      } catch {
        // FAIL-OPEN: behave as if there were no vector candidates.
        cosineById.clear();
      }
    }
  }

  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const results: SearchResult[] = [];

  for (const entry of candidatePool) {
    if (tags.length > 0 && !tags.every((t) => entry.tags.includes(t))) continue;
    // FRI-141: passive-recall exclusion with a name-mention carve-out. Skip an
    // entry iff it carries an excluded tag (e.g. "person") AND is NOT on the
    // allow-list (a matched person:<name>). When allowTags is empty this reduces
    // to a plain total exclusion (general / no-name-match case), so the
    // contamination guarantee is unchanged.
    if (
      excludeTags.length > 0 &&
      excludeTags.some((t) => entry.tags.includes(t)) &&
      !allowTags.some((t) => entry.tags.includes(t))
    ) {
      continue;
    }
    const titleLc = entry.title.toLowerCase();
    const contentLc = entry.content.toLowerCase();
    const tagsLc = entry.tags.map((t) => t.toLowerCase());

    let score = 0;
    const matchedOn = new Set<string>();
    let allTokensMatch = true;

    for (const tok of tokens) {
      let tokenMatched = false;
      if (titleLc.includes(tok)) {
        score += 3;
        matchedOn.add("title");
        tokenMatched = true;
      }
      if (contentLc.includes(tok)) {
        score += 1;
        matchedOn.add("content");
        tokenMatched = true;
      }
      for (let i = 0; i < tagsLc.length; i++) {
        if (tagsLc[i] === tok) {
          score += 5;
          matchedOn.add(`tag:${entry.tags[i]}`);
          tokenMatched = true;
        } else if (tagsLc[i].includes(tok)) {
          // Partial tag match earns less than exact (+5) and slots between
          // content (+1) and title (+3). Handles namespaced tags like
          // `meal:library` matching a `library` token without double-counting
          // exact-eq hits (the `else if` chain).
          score += 2;
          matchedOn.add(`tag~:${entry.tags[i]}`);
          tokenMatched = true;
        }
      }
      if (!tokenMatched) allTokensMatch = false;
    }

    // FRI-24: add the semantic contribution. A live cosine for this entry
    // (from the ANN candidate query) lifts the score proportionally and is
    // recorded in matchedOn for observability. Absent → 0, so FTS-only
    // behavior is byte-identical when the vector path was skipped.
    const cosine = cosineById.get(entry.id) ?? 0;
    if (cosine > 0) {
      score += VEC_WEIGHT * cosine;
      matchedOn.add("vector");
    }

    // Tag filter is authoritative when present: include all tag-matched
    // entries regardless of token match. Tag-less search retains the AND-gate
    // so unrelated entries don't leak in — RELAXED for FRI-24 so a strong
    // vector-only hit (cosine >= VEC_MIN) survives even with no token match.
    const include = tags.length > 0 || (allTokensMatch && score > 0) || cosine >= VEC_MIN;
    if (include) {
      score += Math.log2(entry.recallCount + 1);
      results.push({ entry, score, matchedOn: [...matchedOn] });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);
  if (opts.trackRecall) {
    for (const r of top) await touchRecall(r.entry.id);
  }
  return top;
}
