import { searchMemories } from "./search.js";

/**
 * Build the `<memory-context>` block to prepend to a user message. Strategy:
 * pull top N memories matching the user's text, embed them inline. Empty when
 * nothing matches.
 */
export function buildAutoRecallBlock(
  userText: string,
  opts: { limit?: number; minScore?: number } = {},
): string {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 1;
  const results = searchMemories({
    query: userText,
    limit,
    trackRecall: true,
  });
  const filtered = results.filter((r) => r.score >= minScore);
  if (filtered.length === 0) return "";
  const lines = filtered.map(({ entry }) => {
    return `### ${entry.title} (${entry.id})\n${entry.content.trim()}`;
  });
  return [
    "<memory-context>",
    "Relevant memories from your store. Treat these as authoritative context the user expects you to know without being re-told.",
    "",
    lines.join("\n\n"),
    "</memory-context>",
  ].join("\n");
}
