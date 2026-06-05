/**
 * FRI-152: defense-in-depth hook denying the SDK built-in `AskUserQuestion`
 * tool for every agent type.
 *
 * The system prompt's elicitation protocol fragment tells the model to use
 * `mcp__friday-elicitation__ask_user` instead. This hook is the structural
 * gate that catches a model that ignores the prompt: if it tries to call
 * the built-in, the call is denied with a redirect message that doubles as
 * a model-visible instruction to retry through the right path.
 *
 * Surface: a synchronous predicate that returns the deny message when the
 * tool name matches, or `undefined` otherwise. Pure — no I/O, no daemon
 * state — so the worker can call it inside its PreToolUse adapter without
 * a hook-registry round-trip.
 *
 * Why not register through the `before_tool_call` hook registry? That
 * registry's adapter at `services/daemon/src/agent/worker.ts:651-685`
 * currently fires only for `opts.agentType === "builder"`. The
 * `AskUserQuestion` deny needs to fire for orchestrator, bare, and
 * scheduled (all the agent types that ship `friday-elicitation`) — and
 * conversely the workspace-guard hook should stay gated to builder. The
 * worker adapter composes both: a small unconditional check for this
 * deny, plus the existing builder-only loop.
 */

export const ASK_USER_QUESTION_BUILTIN_DENY_REASON = [
  "The built-in `AskUserQuestion` tool is not available in this environment.",
  "Use the `mcp__friday-elicitation__ask_user` tool instead — it surfaces the same kind of multiple-choice prompt to the user via the dashboard panel and returns a structured answer.",
  "Re-issue your question using `mcp__friday-elicitation__ask_user` with the same questions/options payload (the schema mirrors AskUserQuestion's).",
].join(" ");

/**
 * Returns the deny reason when `toolName` is the SDK built-in
 * `"AskUserQuestion"`, otherwise `undefined` so the caller can fall
 * through to whatever else PreToolUse needs to consider.
 *
 * Kept as a single-purpose function so tests can pin the exact reason
 * string emitted to the model (it's user-visible inside the model's
 * context and is part of the contract that produces a successful retry
 * via the MCP path).
 */
export function denyBuiltinAskUserQuestion(toolName: string): string | undefined {
  if (toolName === "AskUserQuestion") return ASK_USER_QUESTION_BUILTIN_DENY_REASON;
  return undefined;
}
