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

  const lowerQ = q.toLowerCase();
  const tags = opts.tags ?? [];
  const results: SearchResult[] = [];

  for (const entry of candidatePool) {
    if (tags.length > 0 && !tags.every((t) => entry.tags.includes(t))) continue;
    let score = 0;
    const matchedOn: string[] = [];

    if (entry.title.toLowerCase().includes(lowerQ)) {
      score += 3;
      matchedOn.push("title");
    }
    if (entry.content.toLowerCase().includes(lowerQ)) {
      score += 1;
      matchedOn.push("content");
    }
    for (const t of entry.tags) {
      if (t.toLowerCase() === lowerQ) {
        score += 5;
        matchedOn.push(`tag:${t}`);
      }
    }

    if (score > 0) {
      score += Math.log2(entry.recallCount + 1);
      results.push({ entry, score, matchedOn });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);
  if (opts.trackRecall) {
    for (const r of top) touchRecall(r.entry.id);
  }
  return top;
}
