export type FinalUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

/**
 * Lifts the Claude Agent SDK's `result` message into the worker-protocol
 * `turn-complete.usage` shape. The SDK reports cache tokens as
 * `cache_creation_input_tokens` / `cache_read_input_tokens`; this remap
 * also matches the column names on the `usage` table.
 */
export function extractUsageFromResult(
  m: Record<string, unknown>,
): FinalUsage | undefined {
  if (m.type !== "result") return undefined;
  const u = m.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  if (!u) return undefined;
  const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd: cost,
  };
}
