export type FinalUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

/**
 * Per-API-request usage, one per `assistant` message the SDK streams within a
 * turn. Distinct from {@link FinalUsage} (the cumulative `result.usage`): these
 * are NOT summed — the LAST request's prompt size is the live context window
 * (FRI: nightly-compaction runaway). No cost (the SDK only reports cost on the
 * cumulative result).
 */
export type RequestUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
};

/**
 * Lift the per-request `usage` off an SDK `assistant` message
 * (`m.message.usage`, an Anthropic `BetaUsage`) into the worker-protocol
 * `RequestUsage` shape. The SDK names cache fields
 * `cache_creation_input_tokens` / `cache_read_input_tokens` (both nullable);
 * we remap to match the `usage_request` column names. Returns `undefined` when
 * the message carries no usage (e.g. a non-`assistant` message).
 */
export function extractRequestUsage(m: Record<string, unknown>): RequestUsage | undefined {
  if (m.type !== "assistant") return undefined;
  const msg = m.message as
    | {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        };
      }
    | undefined;
  const u = msg?.usage;
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * Lifts the Claude Agent SDK's `result` message into the worker-protocol
 * `turn-complete.usage` shape. The SDK reports cache tokens as
 * `cache_creation_input_tokens` / `cache_read_input_tokens`; this remap
 * also matches the column names on the `usage` table.
 */
export function extractUsageFromResult(m: Record<string, unknown>): FinalUsage | undefined {
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
