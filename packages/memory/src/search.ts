import { listEntries, touchRecall, type MemoryEntry } from "./store.js";

export interface SearchOptions {
  /** Free-text query — matched against title, content, and tags */
  query: string;
  /** Filter to entries with ALL of these tags */
  tags?: string[];
  /** Maximum results to return (default: 10) */
  limit?: number;
  /** If true, increment recall count on returned entries */
  trackRecall?: boolean;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  /** Which fields matched */
  matchedOn: string[];
}

/**
 * Search memories using hybrid keyword + tag matching.
 *
 * Scoring:
 * - Title keyword match: 3 points per keyword
 * - Content keyword match: 1 point per keyword
 * - Tag exact match: 5 points per tag
 * - Recall frequency boost: log2(recallCount + 1) bonus
 *
 * Results are returned sorted by score descending.
 */
export function searchMemories(options: SearchOptions): SearchResult[] {
  const { query, tags, limit = 10, trackRecall = true } = options;
  const entries = listEntries();

  // Tokenize query into lowercase keywords
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 1);

  // Filter by required tags first (if specified)
  let candidates = entries;
  if (tags && tags.length > 0) {
    const requiredTags = new Set(tags.map((t) => t.toLowerCase()));
    candidates = entries.filter((e) => {
      const entryTags = new Set(e.tags.map((t) => t.toLowerCase()));
      for (const rt of requiredTags) {
        if (!entryTags.has(rt)) return false;
      }
      return true;
    });
  }

  // Score each candidate
  const results: SearchResult[] = [];

  for (const entry of candidates) {
    let score = 0;
    const matchedOn: string[] = [];

    const titleLower = entry.title.toLowerCase();
    const contentLower = entry.content.toLowerCase();
    const entryTagsLower = entry.tags.map((t) => t.toLowerCase());

    for (const kw of keywords) {
      // Title matches (weighted higher)
      if (titleLower.includes(kw)) {
        score += 3;
        if (!matchedOn.includes("title")) matchedOn.push("title");
      }

      // Content matches
      if (contentLower.includes(kw)) {
        score += 1;
        if (!matchedOn.includes("content")) matchedOn.push("content");
      }

      // Tag exact matches (highest weight)
      if (entryTagsLower.includes(kw)) {
        score += 5;
        if (!matchedOn.includes("tags")) matchedOn.push("tags");
      }
    }

    // If no query keywords were provided, all candidates get base score
    if (keywords.length === 0) {
      score = 1;
    }

    // Skip entries with no matches
    if (score === 0) continue;

    // Recall frequency boost
    score += Math.log2(entry.recallCount + 1);

    results.push({ entry, score, matchedOn });
  }

  // Sort by score descending, then by recency
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  });

  const limited = results.slice(0, limit);

  // Track recall on returned results
  if (trackRecall) {
    for (const result of limited) {
      const updated = touchRecall(result.entry.id);
      if (updated) {
        result.entry = updated;
      }
    }
  }

  return limited;
}
