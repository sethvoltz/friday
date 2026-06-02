import { getPool } from "@friday/shared";
import { listEntries, touchRecall, type MemoryEntry } from "./store.js";

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

    // Tag filter is authoritative when present: include all tag-matched
    // entries regardless of token match. Tag-less search retains the AND-gate
    // so unrelated entries don't leak in.
    const include = tags.length > 0 || (allTokensMatch && score > 0);
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
