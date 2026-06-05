/**
 * FRI-152 elicitation registry.
 *
 * In-memory map keyed by SDK `tool_use_id` of an `mcp__friday-elicitation__
 * ask_user` call. When the MCP handler (in the worker process) is invoked,
 * it POSTs `/api/elicitation/start` to register a waiter here; then it
 * long-polls `/api/elicitation/<id>/wait` to retrieve the answer. The
 * dashboard's submit POSTs `/api/elicitation/<id>/submit` with the
 * user-supplied answer, which resolves the waiter's promise and the
 * `/wait` request returns.
 *
 * The registry is process-local on the daemon. A daemon restart drops
 * every pending waiter; the worker's `/wait` request gets an HTTP-level
 * error, the MCP handler throws, the SDK marks the tool call failed,
 * and the model proceeds with the failure tool_result (the existing
 * blocks plumbing renders that as a failed `ask_user` block). The
 * dashboard's panel — derived from the canonical tool_use's `output`
 * field on the chat message — flips from "active" to "errored" once
 * the block_complete for the failed tool_result replicates. This is
 * the v1 simplicity per FRI-152 §7(b).
 *
 * Re-entrancy: distinct toolUseIds are independent. Concurrent
 * elicitations don't share state.
 */

/** Caller's submitted answer shape, mirrors the MCP tool's output type
 *  declaration (see `services/daemon/src/mcp/elicitation.ts`). Stored
 *  verbatim and returned to the MCP handler on resolution. */
export interface ElicitationAnswer {
  answers: Record<string, { kind: "option" | "other"; value: string }>;
  annotations?: Record<string, { notes?: string }>;
}

/** Internal waiter entry. `abortSignal` is the worker's abort signal —
 *  when the worker dies the daemon's `/wait` handler bails on this
 *  signal and the waiter is removed. */
interface Waiter {
  resolve: (a: ElicitationAnswer) => void;
  reject: (err: Error) => void;
}

const waiters = new Map<string, Waiter>();

/**
 * Register a new waiter. Returns the Promise the MCP handler should
 * await for the user's answer. The promise rejects if `cancel(id, err)`
 * is called before the answer arrives — typically on worker abort.
 *
 * Idempotency: calling `register` twice with the same `toolUseId`
 * rejects the prior waiter with a `re-registered` error. The model
 * shouldn't normally re-call the same tool_use_id, but we don't crash
 * the daemon if it happens.
 */
export function register(toolUseId: string): Promise<ElicitationAnswer> {
  const existing = waiters.get(toolUseId);
  if (existing) {
    existing.reject(new Error("elicitation re-registered for same tool_use_id"));
    waiters.delete(toolUseId);
  }
  return new Promise<ElicitationAnswer>((resolve, reject) => {
    waiters.set(toolUseId, { resolve, reject });
  });
}

/**
 * Resolve a pending waiter with the user's answer. Called by the daemon's
 * `POST /api/elicitation/<id>/submit` handler when the dashboard mutator
 * fires. Returns true if a waiter was actually resolved; false when the
 * id has no waiter (orphaned submission after worker died, double-submit,
 * etc.) — caller can return a 404 / 409 as appropriate.
 */
export function resolve(toolUseId: string, answer: ElicitationAnswer): boolean {
  const w = waiters.get(toolUseId);
  if (!w) return false;
  waiters.delete(toolUseId);
  w.resolve(answer);
  return true;
}

/**
 * Cancel a pending waiter with an error. Called when the worker's
 * `/wait` long-poll aborts (signal triggered by worker death) so the
 * MCP handler's promise rejects cleanly instead of dangling. Returns
 * true when a waiter was found, false otherwise (cancel-after-resolve
 * race — harmless no-op).
 */
export function cancel(toolUseId: string, err: Error): boolean {
  const w = waiters.get(toolUseId);
  if (!w) return false;
  waiters.delete(toolUseId);
  w.reject(err);
  return true;
}

/** True iff a waiter is registered for `toolUseId`. Used by tests and the
 *  diagnostics endpoint (if we ever add one). */
export function hasWaiter(toolUseId: string): boolean {
  return waiters.has(toolUseId);
}

/** Count of currently-pending waiters. Used by tests and (potentially) a
 *  health endpoint. */
export function pendingCount(): number {
  return waiters.size;
}

/** Test helper — drop every waiter. Not exported from index; intended for
 *  vitest's beforeEach. */
export function __clearForTests(): void {
  for (const w of waiters.values()) {
    w.reject(new Error("registry cleared by test"));
  }
  waiters.clear();
}
