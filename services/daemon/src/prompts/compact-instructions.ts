/**
 * FRI-156 §C — persona-continuity compaction instructions.
 *
 * A static module-scope string prepended onto the `/compact` dispatch body so
 * the SDK's summarizer is told what an orchestrator-as-companion must NOT lose
 * when it folds the conversation tail into a summary. The SDK keeps the most
 * recent turns verbatim; these directives govern only the SUMMARIZED tail, so
 * they're written to protect the relationship-continuity signal that a generic
 * "summarize the conversation" pass would flatten away.
 *
 * Two consumers, both of which pass this string unchanged:
 *   - the nightly maintenance sweep (scheduler/compaction-sweep.ts), which
 *     builds the dispatch body literally as `/compact ${COMPACT_CUSTOM_INSTRUCTIONS}`;
 *   - the `compact` DispatchIntent kind (prompts/intent.ts), the standardized
 *     seam for any path that routes a /compact through buildDispatchPrompt.
 *
 * It is NOT the FRI-27 memory-flush prompt — that lives worker-side in
 * agent/compact-flush.ts and never depends on this wording (the two tickets
 * stay decoupled). FRI-27's PreCompact hook DOES see this string via
 * `PreCompactHookInput.custom_instructions`, but its flush prompt is keyed off
 * the memory index, not this text.
 *
 * Pinned by a golden + load-bearing `.toContain()` directive assertions in
 * compact-instructions.test.ts.
 */
export const COMPACT_CUSTOM_INSTRUCTIONS: string = [
  "You are compacting a long-running companion conversation, not a disposable task session. The summary you produce REPLACES the older turns permanently, so preserve continuity, not just facts. When you summarize, keep all of the following:",
  "",
  "- Open commitments to the user: anything you said you would do, follow up on, remember, or check back about — and whether it is still outstanding.",
  "- In-flight tasks and their current state: what is underway, what step it's on, what's blocked, and what the next action is. A task half-described is a task lost.",
  "- Relationship tone and voice: how you and the user talk to each other — running jokes, preferences, the level of formality, names and shorthand you've settled on. The user should not feel like they're starting over with a stranger.",
  "- Recent decisions AND their reasoning: not just what was decided, but WHY, and what alternatives were rejected. A decision without its reasoning invites re-litigating it next week.",
  "",
  "Be concise, but never drop a commitment or a decision's rationale to save space. When in doubt, preserve.",
].join("\n");
