/**
 * Typed outcome wrapper for Zero 1.5 `MutatorResult.server` promises.
 *
 * Zero 1.5's `MutatorResult.server` **never rejects** — both success and
 * error legs resolve to a discriminated `{type:"success"} | {type:"error", ...}`
 * value. Every `try { await mutate.X(...).server } catch` in the dashboard
 * was dead code: the `await` returns the typed error cleanly, the `try`
 * completes, the `catch` never runs, and the wrapper reports success.
 *
 * `awaitMutatorServer` reads the resolved value and surfaces a flat
 * `MutatorOutcome` the caller can branch on. PK collisions on `blocks.id`
 * are detected by substring match on the error message (the SDK drops
 * Postgres's SQLSTATE — `getErrorDetails` checks `"details" in error`
 * but PG carries `detail` singular — so the message is the only signal
 * available without daemon-side changes).
 *
 * Browser-bundle-safe: type-only imports from `@rocicorp/zero`, no
 * Node-only deps.
 */

import type {
  PromiseWithServerResult as MutatorResult,
  MutatorResultDetails,
} from "@rocicorp/zero";

export type MutatorOutcome =
  | { kind: "success" }
  | {
      kind: "app-error";
      message: string;
      details: unknown;
      pkCollision: boolean;
    }
  | { kind: "zero-error"; message: string };

/**
 * Heuristic: Postgres `unique_violation` (SQLSTATE 23505) surfaces in the
 * application-error message as the English-locale substring
 * `duplicate key value violates unique constraint` (lc_messages=C). The
 * Zero SDK drops the SQLSTATE code (`getErrorDetails` at
 * `shared/src/error.js:32-46` only checks `"details" in error" — singular;
 * Postgres errors carry `detail`, not `details`), so the message is the
 * ONLY signal available without daemon-side changes.
 *
 * We require BOTH the substring match AND the constraint name
 * `blocks_pkey` so a non-blocks unique violation (`tickets_pkey`,
 * `memory_entries_pkey`, etc.) does NOT accidentally classify as
 * send-dedup. PK-collision-as-success is a `sendUserMessage`-specific
 * idempotency contract; a `tickets_pkey` collision means the caller
 * genuinely lost a create race and the UI must surface that.
 *
 * `details` is currently unused — kept on the signature for forward
 * compatibility if the daemon ever wraps PG errors to expose
 * `{code: "23505", constraint: "blocks_pkey"}` in `ApplicationError.details`.
 */
export function isPkCollision(message: string, details: unknown): boolean {
  void details;
  return (
    message.includes("duplicate key value violates unique constraint") &&
    message.includes("blocks_pkey")
  );
}

/**
 * Await the server leg of a `MutatorResult` and classify the resolved
 * value into a flat `MutatorOutcome`. Returns `"no-zero"` for an
 * undefined input (callers wrap that as the "Zero not initialised yet"
 * branch).
 *
 * **Never throws.** Zero 1.5's contract guarantees `.server` resolves
 * either way; the defensive `.catch` here backstops a future SDK
 * regression by mapping any reject into a `zero-error` outcome so the
 * caller's flat-branch logic stays valid.
 */
export async function awaitMutatorServer(
  result: MutatorResult | undefined,
): Promise<MutatorOutcome | "no-zero"> {
  if (!result) return "no-zero";
  let resolved: MutatorResultDetails;
  try {
    resolved = await result.server;
  } catch (err) {
    // Defensive: Zero 1.5's contract says `.server` never rejects, but
    // if a future SDK regression breaks that promise we must not throw
    // out of the wrapper.
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "zero-error", message };
  }
  if (resolved.type === "success") return { kind: "success" };
  const error = resolved.error;
  if (error.type === "zero") {
    return { kind: "zero-error", message: error.message };
  }
  // type === "app"
  return {
    kind: "app-error",
    message: error.message,
    details: error.details,
    pkCollision: isPkCollision(error.message, error.details),
  };
}
