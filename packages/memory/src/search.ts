import { getRawDb } from "@friday/shared";
import { listEntries, touchRecall, type MemoryEntry } from "./store.js";

export interface SearchOptions {
  query: string;
  tags?: string[];
  limit?: number;
  trackRecall?: boolean;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  matchedOn: string[];
}

export function searchMemories(opts: SearchOptions): SearchResult[] {
  const limit = opts.limit ?? 10;
  const q = opts.query.trim();
  if (!q) return [];

  const raw = getRawDb();
  let candidateIds: string[] = [];
  try {
    const ftsRows = raw
      .prepare(
        `SELECT id FROM memory_entries WHERE rowid IN (
           SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? LIMIT 100
         )`,
      )
      .all(q) as Array<{ id: string }>;
    candidateIds = ftsRows.map((r) => r.id);
  } catch {
    candidateIds = [];
  }

  const allEntries = listEntries();
  const candidatePool =
    candidateIds.length > 0
      ? allEntries.filter((e) => candidateIds.includes(e.id))
      : allEntries; // FTS5 fallback: scan all

  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const tags = opts.tags ?? [];
  const results: SearchResult[] = [];

  for (const entry of candidatePool) {
    if (tags.length > 0 && !tags.every((t) => entry.tags.includes(t))) continue;
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
        }
      }
      if (!tokenMatched) {
        allTokensMatch = false;
        break;
      }
    }

    if (allTokensMatch && score > 0) {
      score += Math.log2(entry.recallCount + 1);
      results.push({ entry, score, matchedOn: [...matchedOn] });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);
  if (opts.trackRecall) {
    for (const r of top) touchRecall(r.entry.id);
  }
  return top;
}
