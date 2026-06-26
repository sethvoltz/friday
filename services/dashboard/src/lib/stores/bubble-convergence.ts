/**
 * Bubble convergence — the rune-free presentation core for the chat store.
 *
 * Owns the pure "shape of state" logic that turns canonical block rows +
 * live overlays into the `ChatMessage[]` the chat UI renders: the
 * `ChatMessage` view type, the overlay-key scheme, the block-row parsers,
 * the FRI-85 no-response safety-net pruner, and the pagination cursor.
 * Every export here is a plain function or type over plain data — ZERO
 * Svelte runes — so it is unit-testable without a reactive root.
 *
 * Clock note: every export is a deterministic, pure function of its inputs —
 * the wall clock is threaded in, never read implicitly. `mergeZeroSnapshot`
 * REQUIRES a `now` (epoch ms) the shell pins at its IO boundary, so the
 * FRI-85 / FRI-91 grace-window suppressions are testable without touching the
 * real clock. `parseBlocks` accepts `opts.now` for the same reason and keeps a
 * `Date.now()` fallback solely for time-agnostic callers that set no grace
 * fields, where `now`'s value cannot affect the result (the grace branches are
 * the only place it is read). The shell's transport-failure clock
 * (`scheduleTransportFailureFallback` / `TRANSPORT_FAILURE_FALLBACK_MS`)
 * deliberately stays out of this module.
 *
 * Hard invariant: this module imports NOTHING from `chat.svelte.ts` or
 * `zero.svelte.ts`. These helpers were relocated OUT of `chat.svelte.ts`
 * precisely because their value bindings were the cyclic edge; defining
 * them here (and importing them back into the store, which re-exports the
 * public surface) is what breaks the chat <-> core dependency cycle.
 */
import type { BlockKind } from "@friday/shared";
import { compactionDividerId } from "../components/Chat/compaction-render";

export interface ChatMessage {
  /** turn_id for assistant; "u_<n>" for user; "t_<toolId>"; "th_<blockId>". */
  id: string;
  role: "user" | "assistant" | "tool" | "thinking";
  /** user/assistant: rendered markdown body. thinking: streamed thoughts. tool: unused. */
  text: string;
  status:
    | "streaming" // assistant turn still receiving deltas
    | "stopping" // user clicked Stop; daemon hasn't confirmed yet
    | "complete"
    | "aborted"
    | "error"
    | "running" // tool/thinking still in progress
    | "done"
    // User block recorded by the daemon at status='queued' — sitting in the
    // worker's `nextPrompts` FIFO behind an in-flight turn. Pinned to the
    // bottom of the chat (alongside `pending`) until a `block_meta_update`
    // event flips it to 'complete' with a fresh ts. Carries an X cancel
    // affordance that yanks it from the daemon's queue and stuffs the
    // text back into the input bar.
    | "queued"
    // FRI-95: Stop fired on a turn that completed before the abort took
    // effect. Brief 1s transient on the user-block to acknowledge the click
    // without falsely claiming "Stopped". Settles back to "complete".
    | "already_finished";
  agent?: string;
  ts: number;

  // Assistant-specific: the turn this bubble belongs to. Recorded on
  // appendDelta so finishTurn can match bubbles whose primary id is keyed
  // by the SDK message_id rather than the turn_id.
  turnId?: string;

  // Tool-specific
  toolId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  /** Mid-stream accumulator for `input_json_delta` chunks (FRI-84). The
   *  SDK emits the tool's input as incremental JSON fragments via the
   *  `block_delta` wire event's `partial_json` field; we concatenate them
   *  here so the ToolBlock can render the live input under the headline
   *  during the streaming phase. Cleared on `block_complete` once `input`
   *  is populated from the canonical content_json. Best-effort:
   *  intermediate values may be invalid JSON and the renderer falls back
   *  to raw display. */
  inputPartialJson?: string;

  // Thinking-specific
  blockId?: string;
  /** True when thinking was redacted by Anthropic; renders a badge instead of text. */
  isRedacted?: boolean;

  /** Optimistic-send queue id. When set, this user bubble represents a
   * message that is waiting to flush — render with a "queued" pill so the
   * user can see it didn't actually reach the daemon yet. Cleared as soon
   * as the queue successfully POSTs the message. */
  queueId?: string;

  /** Attachments included on the user message (rendered inline as chips
   * for non-images, thumbnails for images). */
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;

  /** Where the bubble originated. Carries through to the canonical block
   *  (matches the `source` column in the blocks table). FIX_FORWARD 2.6. */
  source?:
    | "user_chat"
    | "mail"
    | "queue_inject"
    | "sdk"
    | "scratch"
    | "agent_spawn"
    | "schedule"
    | "refork_notice";

  /** Sender attribution for `source='mail'` blocks. Pulled from
   *  `content_json.from_agent`, written by `recordUserBlock` at
   *  daemon/agent/lifecycle.ts when the mail-bridge materializes incoming
   *  mail. Undefined for non-mail user blocks. */
  fromAgent?: string;

  /** Extra mail-row metadata for `source='mail'` blocks (id/subject/type/
   *  priority/threadId/ts). Serialized into content_json by the daemon
   *  so MailBlock can render rich detail without a separate fetch. */
  mailMeta?: {
    id: number;
    subject: string | null;
    type: string;
    priority: string;
    threadId: string | null;
    ts: number;
  };

  /** True from the moment a user types until `/api/chat/turn` confirms
   *  the dispatch with `{turn_id}`. Pending bubbles render pinned to the
   *  bottom regardless of natural ts sort (FIX_FORWARD 2.6). */
  pending?: boolean;

  /** Set when the send-queue's flush returned a 4xx — surface a
   *  retry/discard affordance (FIX_FORWARD 2.6). */
  failed?: boolean;

  /** When set to `"error"`, this bubble is a synthetic error notification
   *  (FRI-12) emitted by the daemon when the SDK throws (529, 429, 401,
   *  network) or the stop force-kill safety net fires. The bubble's
   *  `role` stays `"assistant"` so it slots into the assistant lane;
   *  ChatMessages discriminates on `kind` to render the ErrorBlock with
   *  Resend / Resume / Details affordances.
   *
   *  When set to `"no-response"`, this bubble is a synthetic
   *  "agent didn't reply" affordance (FRI-85). Emitted either because
   *  the model produced its trained "No response requested." end-of-
   *  turn sentinel (deliberate no-reply) or because the turn finished
   *  with zero assistant-side content blocks (worker died early,
   *  Task-only response, etc.). Replaces FRI-9's silent suppression
   *  so the user is never left staring at their own message wondering
   *  whether the system swallowed the turn. Single bubble per turn
   *  (id `nr_<turnId>`) regardless of which producer wins.
   *
   *  When set to `"compaction"`, this message is the durable full-width
   *  "Context compacted · 779K → 50K tokens" divider (FRI-156 §E). It is
   *  derived from a persisted `kind:'compaction'` block row, so it
   *  survives reload (unlike the retired in-memory `compactionTurnIds`
   *  inline notice). `role` is `"assistant"` so it rides the existing
   *  agent filter + full-width continuation grouping; `preTokens` /
   *  `postTokens` carry the humanized token deltas. Stable id
   *  `cb_<blockId>` so reload + live converge on a single divider. */
  kind?: "error" | "no-response" | "compaction";

  /** FRI-156 §E: pre/post context-window token counts on a
   *  `kind:"compaction"` divider message, read from the durable
   *  compaction block's `content_json` (`pre_tokens` / `post_tokens`).
   *  Humanized via `fmtTokensCompact` at render time. Undefined on every
   *  other message kind. */
  preTokens?: number;
  postTokens?: number;

  /** True when the synthetic no-response bubble was produced by the
   *  SDK sentinel specifically — distinguishes "agent deliberately
   *  decided no reply was needed" (verbose: "Agent acknowledged — no
   *  reply needed") from "turn ended with zero assistant content"
   *  (verbose: "Agent didn't respond"). FRI-85. */
  noResponseSentinel?: boolean;
  errorCode?: string;
  errorHeadline?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawErrorMessage?: string;

  /** FRI-95: set on the user-block message when its turn ends in an
   *  aborted state, so the bubble's terminal footer can distinguish
   *  "Stopped" (cooperative — worker honored the abort cleanly) from
   *  "Stopped — worker had to be force-killed" (forced — the daemon's
   *  500ms deadline elapsed and the worker was SIGTERMed). Sourced from
   *  the daemon's `turn_done.abort_reason` field. Undefined for
   *  non-user-block messages and for turns that didn't end in abort. */
  abortReason?: "cooperative" | "forced";
  /** FRI-60: set on no-response bubbles to convey why the turn produced
   *  zero content blocks. Drives the display copy in ChatMessages. */
  zeroBlockReason?: "abort" | "compaction" | "sdk-resume-failure";
}

export interface AgentInfo {
  name: string;
  type: string;
  status: string;
  /** Current SDK session id, when one is active. Used to distinguish
   * "current chat" from "past sessions" in the sidebar's expand-history view. */
  sessionId?: string;
  /** Distinct session count, populated by /api/agents. Indicates whether
   * the sidebar should show an expand-history button for this agent. */
  sessionCount?: number;
  /** ISO timestamps from the agents table. Sidebar uses `updatedAt`
   * (fallback `createdAt`) to bucket rows by age. Optional because SSE-
   * synthesized entries that arrive before the first /api/agents poll
   * don't carry them yet. */
  createdAt?: string;
  updatedAt?: string;
  /** Epoch-millis when the daemon began compacting this agent's context;
   * undefined when not compacting. Replicated from `agents.compacting_since`
   * via Zero. The DURABLE half of the compaction-in-progress signal — lets the
   * "Compacting context…" indicator reconstruct on reload/reconnect and drives
   * the sidebar dot + elapsed-time readout. See {@link compactingAgents} for
   * the transient SSE half this is unioned with. */
  compactingSince?: number;
}

/** Claude Agent SDK tombstone for turns that ended without assistant output.
 *  The SDK writes this literal into the session JSONL so resumed sessions
 *  preserve the "this turn happened but produced nothing" signal. The
 *  daemon's jsonl-mirror faithfully ingests it as a `text` block; we keep
 *  the row on disk (preserve-over-delete) but suppress it from the chat
 *  UI so it doesn't render as a ghost assistant bubble. */
const SDK_NO_RESPONSE_SENTINEL = "No response requested.";

export function isNoResponseSentinel(role: string, text: string | undefined): boolean {
  return role !== "user" && text?.trim() === SDK_NO_RESPONSE_SENTINEL;
}

/**
 * Stable bubble id for a user-role chat message keyed by its turn_id. Used
 * both client-side (when `/api/chat/turn` confirms a dispatch) and on the
 * SSE handler (when the daemon emits the canonical `block_complete` for the
 * user-role block) so the two paths converge on the same ChatMessage row.
 * FIX_FORWARD 2.6.
 */
export function userBlockIdForTurn(turnId: string): string {
  return `user_${turnId}`;
}

/**
 * Stable bubble id for the synthetic "agent didn't respond" affordance
 * keyed by turn_id (FRI-85). One per turn — both the sentinel-text path
 * and the zero-assistant-content safety-net path converge on the same id
 * so live SSE replacing the streaming bubble and reload reconstructing
 * from blocks produce identical message rows.
 */
export function noResponseIdForTurn(turnId: string): string {
  return `nr_${turnId}`;
}

/**
 * Sentinel session_id the dashboard's `sendUserMessage` mutator writes
 * on user blocks before the daemon has resolved the SDK's real session
 * id. Matches `PENDING_SESSION_SENTINEL` in
 * `packages/shared/src/services/blocks.ts` — duplicated here to keep
 * the client free of a runtime dependency on the daemon-side service
 * module (the constant is used in a hot reactive path).
 */
export const PENDING_SESSION_SENTINEL = "__pending__";

/**
 * Drop rows whose session id doesn't match the focused agent's current
 * SDK session. Used at the two ingest points where multi-session
 * agent-scoped data shows up in the live transcript:
 *
 *   1. {@link ChatState.applyZeroBlocks} — Zero's blocks slice is
 *      agent-scoped, so prior-session rows ride along.
 *   2. {@link ChatState.loadAgentTurns} — the localStorage transcript
 *      cache pre-dates Zero and can contain blocks from whatever
 *      session was active when it was last written.
 *
 * Rows tagged with the `__pending__` sentinel pass through **only if
 * their `turn_id` matches the focused agent's current inflight turn**.
 * The sentinel is the dashboard mutator's "no SDK session yet" marker;
 * the daemon's lifecycle `session-update` sweep rewrites those rows
 * to the real id once the worker announces a session, but the sweep
 * is scoped to a single turn. When a turn dies before its
 * `session-update` arrives (worker SIGTERM, daemon crash, `/clear`
 * mid-turn), the `__pending__` block becomes a historical orphan that
 * the sweep will never claim. Without the turn-id gate the orphan
 * keeps rendering as live content every time the user reloads —
 * which is exactly the "Yesterday at 4:23 PM bug message keeps
 * reappearing post-`/clear`" repro. Gating on `turn_id ===
 * inflightTurn` keeps the just-typed user bubble visible during the
 * brief mutator-write → daemon-sweep window without resurrecting dead
 * orphans.
 *
 * **STRICT contract:** when `agents` does not contain a row for the
 * focused agent, return `[]`. The earlier permissive fallback
 * (return rows unfiltered) was the load-bearing leak behind the
 * post-`/clear` reload bug — Zero's `agents` and `blocks` slices
 * materialize independently, and on a cold reload the `blocks`
 * listener can fire `applyZeroBlocks` before the `agents` query has
 * replicated. With the permissive fallback that meant the prior
 * session's full transcript got rendered in the window between
 * blocks-arriving and agents-arriving. Callers must therefore
 * either ensure `chat.agents` is populated before they invoke the
 * filter, or accept "render nothing yet" and re-invoke once Zero
 * pushes the agents row — see the `#bindAgents` update callback in
 * `zero.svelte.ts` which now re-fires `applyZeroBlocks` for the
 * focused agent whenever `chat.agents` updates.
 *
 * Duck-types over both row shapes — Zero rows expose `session_id` /
 * `turn_id` (snake_case), `BlockRow` exposes `sessionId` / `turnId`
 * (camelCase).
 */
export function filterRowsToCurrentSession<
  T extends {
    sessionId?: string;
    session_id?: string;
    turnId?: string;
    turn_id?: string;
  },
>(
  rows: readonly T[],
  agent: string,
  agents: readonly AgentInfo[],
  currentInflightTurnId: string | null,
): T[] {
  const agentRow = agents.find((a) => a.name === agent);
  if (!agentRow) return [];
  const currentSessionId = agentRow.sessionId;
  return rows.filter((r) => {
    const sid = r.session_id ?? r.sessionId;
    if (sid === undefined) return false;
    if (sid === PENDING_SESSION_SENTINEL) {
      // Only pass the sentinel for rows belonging to the turn the user
      // is actively in. Historical orphans from dead turns that the
      // daemon's session-update sweep will never claim are dropped.
      if (currentInflightTurnId === null) return false;
      const tid = r.turn_id ?? r.turnId;
      return tid === currentInflightTurnId;
    }
    return currentSessionId !== undefined && sid === currentSessionId;
  });
}

/** Overlay-map key. Globally unique because message ids (`b_<blockId>`,
 *  `t_<toolId>`, `th_<blockId>`, `u_queue_<qid>`, `userBlockIdForTurn(...)`)
 *  are themselves unique within an agent. */
export type OverlayKey = string;
export function overlayKey(agent: string, id: string): OverlayKey {
  return `${agent}|${id}`;
}

/**
 * Overlay entry shape the merge reads: a {@link ChatMessage} carrying the
 * non-optional `agent` plus the `sessionId` snapshot stamped at the entry's
 * construction. Both `StreamingEntry` and `OptimisticEntry` (in
 * `chat.svelte.ts`) satisfy it structurally.
 */
export type OverlayEntry = ChatMessage & { agent: string; sessionId: string | null };

/** Focused-agent identity the merge filters overlay + legacy bubbles by. */
export interface Focus {
  agent: string;
  sessionId: string | null;
}

/**
 * Merge canonical (legacy) bubbles with the live streaming + optimistic
 * overlays into the focused agent's chat view. Read-time core of
 * `ChatState.#derivedMessages`.
 *
 * The shell does the rune reads (focused agent, current session id, the two
 * SvelteMap value iterators) and passes plain snapshots; this function is
 * pure over them. Overlay entries are filtered by
 * `entry.agent === focus.agent && entry.sessionId === focus.sessionId` so a
 * `/clear` (which nulls the agent's sessionId at the daemon) hides leftover
 * in-flight entries with no imperative sweep; legacy entries are filtered by
 * agent tag for structural cross-agent isolation.
 *
 * REACTIVITY CONTRACT (load-bearing — see chat.svelte.ts `#derivedMessages`):
 * reads ONLY identity fields (`id`, `agent`, `sessionId`) off the overlay
 * entries — NEVER `text` / `status` / other streaming-mutable `$state`
 * fields. Reading a mutable field here would subscribe the derivation to
 * every per-delta mutation and re-run the whole merge on each token,
 * collapsing the fine-grained one-paint-frame streaming path into an O(n)
 * re-derive. On `StreamingEntry`/`OptimisticEntry` `id`/`agent`/`sessionId`
 * are plain `readonly` (non-`$state`) fields, so reading them registers no
 * fine-grained subscription.
 *
 * Entries are returned BY REFERENCE (never cloned) so each overlay entry's
 * per-instance `$state` stays live in the rendered bubble. Order:
 * `[surviving legacy..., streaming..., optimistic...]`.
 */
export function mergeBubbles(
  legacy: readonly ChatMessage[],
  streaming: Iterable<OverlayEntry>,
  optimistic: Iterable<OverlayEntry>,
  focus: Focus,
): ChatMessage[] {
  const focused = focus.agent;
  const sid = focus.sessionId;

  const overlayIds = new Set<string>();
  const overlayEntries: ChatMessage[] = [];
  for (const entry of streaming) {
    if (entry.agent !== focused) continue;
    if (entry.sessionId !== sid) continue;
    overlayEntries.push(entry);
    overlayIds.add(entry.id);
  }
  for (const entry of optimistic) {
    if (entry.agent !== focused) continue;
    if (entry.sessionId !== sid) continue;
    overlayEntries.push(entry);
    overlayIds.add(entry.id);
  }
  // Legacy filter:
  //   - skip overlay-shadowed ids
  //   - skip entries explicitly tagged for a different agent
  //   - pass through untagged entries (defensive — test fixtures /
  //     pre-migration synth bubbles whose pushLocal call now stamps
  //     the focused agent automatically)
  const out: ChatMessage[] = [];
  for (const m of legacy) {
    if (overlayIds.has(m.id)) continue;
    if (m.agent && m.agent !== focused) continue;
    out.push(m);
  }
  for (const e of overlayEntries) out.push(e);
  return out;
}

/**
 * Reload-heal convergence partition: split the streaming-overlay snapshot
 * into entries to KEEP vs DROP for `focusAgent`. An overlay entry has
 * converged (→ `drop`) once a legacy bubble with the same id exists at a
 * terminal status — while in-flight the overlay shadowed the legacy entry,
 * but once the canonical row carries the terminal status the overlay adds
 * nothing. Agent-scoped: entries for other agents are partitioned into
 * neither list (the caller leaves them in the map untouched).
 *
 * MUST NEVER be called from inside `ChatState.#derivedMessages` — or any
 * `$derived` / `$effect` body. It reads the `status` field off the
 * deep-reactive legacy snapshot, so invoking it inside a derivation would
 * subscribe that derivation to every legacy bubble's `status` and re-run it
 * on each terminal flip (a perf regression, and a potential write-during-
 * derive if the caller then mutates the map). The shell calls it
 * imperatively from `pruneConvergedStreamingOverlay` over a
 * `[...streaming.values()]` snapshot, OUTSIDE any reactive scope, then
 * applies `drop` via `streaming.delete`.
 */
export function pruneConverged(
  legacy: readonly ChatMessage[],
  streaming: readonly OverlayEntry[],
  focusAgent: string,
): { keep: OverlayEntry[]; drop: OverlayEntry[] } {
  const keep: OverlayEntry[] = [];
  const drop: OverlayEntry[] = [];
  const terminalIds = new Set<string>();
  for (const m of legacy) {
    if (
      m.status === "complete" ||
      m.status === "aborted" ||
      m.status === "error" ||
      m.status === "done"
    ) {
      terminalIds.add(m.id);
    }
  }
  for (const entry of streaming) {
    if (entry.agent !== focusAgent) continue;
    if (terminalIds.has(entry.id)) drop.push(entry);
    else keep.push(entry);
  }
  return { keep, drop };
}

/** Parsed shape of a block row's `content_json`. Mirrors what the daemon
 *  writes for each block kind (FIX_FORWARD 1.2 + 1.3). */
export interface ParsedBlockContent {
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  from_agent?: string;
  /** Mail-source block extras (see daemon/agent/lifecycle.ts
   *  recordUserBlock). */
  mail_id?: number;
  mail_subject?: string | null;
  mail_type?: string;
  mail_priority?: string;
  mail_thread_id?: string | null;
  mail_ts?: number;
  /** user_chat blocks for paste/drop/file-pick sends carry the attachment
   *  metadata the daemon persisted alongside the text. Reload reads this
   *  back so the bubble's image thumb / file chip survives across page
   *  loads (FRI-6). */
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;
  /** FRI-156 §E: durable `kind:'compaction'` marker block payload
   *  (snake_case, written by the daemon's compaction-boundary handler).
   *  `pre_tokens`/`post_tokens` are the context-window size before/after
   *  compaction; `duration_ms` is unused by the divider render but kept
   *  for parity with the daemon's `content_json` shape. */
  pre_tokens?: number;
  post_tokens?: number;
  duration_ms?: number;
  /** True when the thinking block was redacted by Anthropic. */
  isRedacted?: boolean;
  /** Opaque encrypted payload from a `redacted_thinking` content block. */
  data?: string;
}

export function parseBlockContent(contentJson: string): ParsedBlockContent {
  try {
    return JSON.parse(contentJson) as ParsedBlockContent;
  } catch {
    return {};
  }
}

/** Parsed shape of a `kind="error"` block's content_json. Mirrors the
 *  daemon-side `ErrorBlockPayload` (services/daemon/src/agent/block-stream.ts).
 *  Defensive defaults so a malformed/legacy row still renders something. */
export interface ParsedErrorContent {
  code: string;
  headline: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage: string;
}

export function parseErrorContent(contentJson: string): ParsedErrorContent {
  try {
    const raw = JSON.parse(contentJson) as Partial<ParsedErrorContent>;
    return {
      code: typeof raw.code === "string" ? raw.code : "unknown",
      headline:
        typeof raw.headline === "string" && raw.headline.length > 0
          ? raw.headline
          : "Something went wrong",
      httpStatus: typeof raw.httpStatus === "number" ? raw.httpStatus : undefined,
      retryAfterSeconds:
        typeof raw.retryAfterSeconds === "number" && raw.retryAfterSeconds >= 0
          ? raw.retryAfterSeconds
          : undefined,
      requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
      rawMessage: typeof raw.rawMessage === "string" ? raw.rawMessage : contentJson,
    };
  } catch {
    return { code: "unknown", headline: "Something went wrong", rawMessage: contentJson };
  }
}

/** Pull the mail metadata out of a parsed content_json, if present. The
 *  daemon writes these fields only for `source='mail'` blocks; older mail
 *  rows persisted before the schema gained these fields will return
 *  undefined and MailBlock will fall back to a header-only view. */
export function extractMailMeta(parsed: ParsedBlockContent): ChatMessage["mailMeta"] | undefined {
  if (typeof parsed.mail_id !== "number") return undefined;
  return {
    id: parsed.mail_id,
    subject: parsed.mail_subject ?? null,
    type: parsed.mail_type ?? "message",
    priority: parsed.mail_priority ?? "normal",
    threadId: parsed.mail_thread_id ?? null,
    ts: parsed.mail_ts ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Live SSE convergence — block_complete / block_canceled reconciliation
// ---------------------------------------------------------------------------

/**
 * Canonical `block_complete` SSE frame the reconcile core resolves. Mirrors
 * the daemon's `block_complete` wire event consumed by
 * `ChatState.handleBlockComplete`.
 *
 * `status` is load-bearing: it drives the user/assistant `mappedStatus`, the
 * thinking ghost-drop gate (`status === "complete"`), and the tool
 * aborted/error terminal states. `source` is load-bearing too: it backfills a
 * late-mounted row's origin and rides onto the late-mount push. There is no
 * `tool` field — the tool id is read from `content_json.tool_use_id`, never
 * the event.
 */
export type BlockCompleteEvent = {
  block_id: string;
  role: string;
  kind: BlockKind;
  turn_id: string;
  content_json: string;
  status: "complete" | "aborted" | "error" | "queued" | string;
  source: string | null;
  ts: number;
};

/**
 * Read surface a block_complete is reconciled against. `merged` is the
 * derived `ChatState.messages` view — it folds in the streaming + optimistic
 * overlays and the session filter, and is BOTH the dedup read surface and the
 * source of the LIVE object references the `inplace` plan patches. `legacy`
 * is the raw `#legacyMessages` bucket (the splice/filter identity target the
 * shell applies plans against). `overlay` is the streaming SvelteMap (keyed by
 * `overlayKey(agent, id)`); `focus` is the focused-agent identity.
 */
export interface ReconcileSnapshot {
  // `merged` (the derived view) is the only read surface the reconciler needs:
  // it folds in overlay+optimistic+session filter and carries the live object
  // references the `inplace` plan patches. The shell owns the raw
  // `#legacyMessages` splice/filter target directly, so it is not part of the
  // snapshot.
  merged: readonly ChatMessage[];
  overlay: ReadonlyMap<OverlayKey, OverlayEntry>;
  focus: Focus;
}

/**
 * Discriminated plan a block_complete reconciliation emits; the shell applies
 * exactly one via a `switch (plan.kind)`. The `inplace` / `overlay-finalize`
 * variants carry the convergence target so the shell never re-derives it:
 *
 *   - `overlay-finalize` — patch the streaming overlay entry at `key`.
 *   - `inplace` — patch the LIVE merged-view object `target` directly. Fix #5:
 *     the object found by scanning `merged` may be an overlay/optimistic entry,
 *     NOT a `#legacyMessages` member — re-finding by id in the legacy bucket
 *     alone would silently no-op on overlay-resident targets. The plan carries
 *     the matched reference so the shell mutates exactly what the scan found.
 *   - `legacy-push` — append a freshly-materialized canonical row to legacy.
 *   - `no-response` — FRI-85 sentinel: drop the streaming `b_<id>`, splice the
 *     legacy `b_<id>`, then push the `nr_<turnId>` affordance (`pushRow` is
 *     null when one already exists).
 *   - `ghost-drop` — FRI-81 D4: drop the empty-complete thinking placeholder
 *     from both the overlay and the legacy bucket.
 *   - `noop` — nothing to do (e.g. an orphan tool_result with no tool_use).
 */
export type ReconcilePlan =
  | { kind: "overlay-finalize"; key: OverlayKey; patch: Partial<ChatMessage> }
  | { kind: "inplace"; target: ChatMessage; patch: Partial<ChatMessage> }
  | { kind: "legacy-push"; row: ChatMessage }
  | {
      kind: "no-response";
      overlayKeyToDelete: OverlayKey;
      legacyIdToSplice: string;
      pushRow: ChatMessage | null;
    }
  | { kind: "ghost-drop"; overlayKeyToDelete: OverlayKey; legacyIdToFilter: string }
  | { kind: "noop" };

/** FRI-12 error block: idempotent in-place patch (ring-buffer replay /
 *  reload-mid-error must not double-add) or a fresh legacy push. */
function reconcileErrorComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
): ReconcilePlan {
  const errPayload = parseErrorContent(event.content_json);
  const id = `e_${event.block_id}`;
  const existing = snapshot.merged.find((m) => m.id === id);
  if (existing) {
    return {
      kind: "inplace",
      target: existing,
      patch: {
        errorCode: errPayload.code,
        errorHeadline: errPayload.headline,
        httpStatus: errPayload.httpStatus,
        retryAfterSeconds: errPayload.retryAfterSeconds,
        requestId: errPayload.requestId,
        rawErrorMessage: errPayload.rawMessage,
      },
    };
  }
  return {
    kind: "legacy-push",
    row: {
      id,
      role: "assistant",
      kind: "error",
      text: errPayload.headline,
      status: "error",
      agent: snapshot.focus.agent,
      turnId: event.turn_id,
      ts: event.ts,
      errorCode: errPayload.code,
      errorHeadline: errPayload.headline,
      httpStatus: errPayload.httpStatus,
      retryAfterSeconds: errPayload.retryAfterSeconds,
      requestId: errPayload.requestId,
      rawErrorMessage: errPayload.rawMessage,
    },
  };
}

/** Assistant/user text: FRI-85 sentinel → no-response affordance; otherwise
 *  finalize the streaming overlay (a1), patch the live merged-view row in
 *  place with source/turn/block backfills (a2), or late-mount into legacy
 *  (a3). Precedence preserved verbatim from `handleBlockComplete`. */
function reconcileTextComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
  parsed: ParsedBlockContent,
): ReconcilePlan {
  const { focus, merged, overlay } = snapshot;
  const agent = focus.agent;
  if (isNoResponseSentinel(event.role, parsed.text)) {
    const streamingId = `b_${event.block_id}`;
    const nrId = noResponseIdForTurn(event.turn_id);
    // The nr-exists check reads `merged` captured at handler entry — i.e. BEFORE
    // the shell applies this plan's `b_<id>` overlay-delete + legacy-splice. The
    // original handler evaluated it on the POST-delete view, but the result is
    // identical: `streamingId` is `b_<block_id>` and `nrId` is `nr_<turn_id>`,
    // so removing `b_` rows can never add or remove an `nr_` entry from the
    // concat-only merged view. The pre-mutation read is safe.
    const pushRow: ChatMessage | null = merged.some((m) => m.id === nrId)
      ? null
      : {
          id: nrId,
          role: "assistant",
          kind: "no-response",
          noResponseSentinel: true,
          text: "",
          status: "complete",
          agent,
          turnId: event.turn_id,
          ts: event.ts,
        };
    return {
      kind: "no-response",
      overlayKeyToDelete: overlayKey(agent, streamingId),
      legacyIdToSplice: streamingId,
      pushRow,
    };
  }
  const id = event.role === "user" ? userBlockIdForTurn(event.turn_id) : `b_${event.block_id}`;
  const mappedStatus: ChatMessage["status"] =
    event.status === "complete"
      ? "complete"
      : event.status === "aborted"
        ? "aborted"
        : event.status === "queued"
          ? "queued"
          : "error";
  // a1: streaming overlay (assistant only; user blocks never have one).
  const overlayEntry = event.role === "user" ? undefined : overlay.get(overlayKey(agent, id));
  if (overlayEntry && overlayEntry.role === "assistant") {
    const patch: Partial<ChatMessage> = {};
    if (typeof parsed.text === "string") patch.text = parsed.text;
    patch.status = mappedStatus;
    return { kind: "overlay-finalize", key: overlayKey(agent, id), patch };
  }
  // a2: in-place patch of the live merged-view row, with defensive backfills.
  const target = merged.find((m) => m.id === id);
  if (target) {
    const patch: Partial<ChatMessage> = {};
    if (typeof parsed.text === "string") patch.text = parsed.text;
    patch.status = mappedStatus;
    if (target.source === undefined && event.source) {
      patch.source = event.source as ChatMessage["source"];
    }
    if (target.fromAgent === undefined && parsed.from_agent) {
      patch.fromAgent = parsed.from_agent;
    }
    if (target.attachments === undefined && parsed.attachments) {
      patch.attachments = parsed.attachments;
    }
    if (!target.turnId && event.turn_id) patch.turnId = event.turn_id;
    if (!target.blockId && event.block_id) patch.blockId = event.block_id;
    return { kind: "inplace", target, patch };
  }
  // a3: late mount — block_start was evicted (or, for mail, never emitted).
  const liveRole = event.role === "user" ? "user" : "assistant";
  return {
    kind: "legacy-push",
    row: {
      id,
      role: liveRole,
      text: parsed.text ?? "",
      status: mappedStatus,
      agent,
      turnId: event.turn_id,
      blockId: event.block_id,
      ts: event.ts,
      source: (event.source as ChatMessage["source"]) ?? undefined,
      fromAgent: parsed.from_agent,
      mailMeta: extractMailMeta(parsed),
      attachments: parsed.attachments,
    },
  };
}

/** Thinking: FRI-81 D4 ghost-drop for empty-complete blocks; otherwise
 *  finalize overlay (a1) / patch in place (a2) / late-mount (a3). */
function reconcileThinkingComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
  parsed: ParsedBlockContent,
): ReconcilePlan {
  const { focus, merged, overlay } = snapshot;
  const agent = focus.agent;
  const id = `th_${event.block_id}`;
  const hasText = typeof parsed.text === "string" && parsed.text.length > 0;
  if (!hasText && !parsed.isRedacted && event.status === "complete") {
    return {
      kind: "ghost-drop",
      overlayKeyToDelete: overlayKey(agent, id),
      legacyIdToFilter: id,
    };
  }
  const status: ChatMessage["status"] =
    event.status === "aborted" ? "aborted" : event.status === "error" ? "error" : "done";
  const thinkOverlay = overlay.get(overlayKey(agent, id));
  if (thinkOverlay && thinkOverlay.role === "thinking") {
    const patch: Partial<ChatMessage> = {};
    if (typeof parsed.text === "string") patch.text = parsed.text;
    if (parsed.isRedacted) patch.isRedacted = true;
    patch.status = status;
    return { kind: "overlay-finalize", key: overlayKey(agent, id), patch };
  }
  const target = merged.find((m) => m.id === id);
  if (target) {
    const patch: Partial<ChatMessage> = {};
    if (typeof parsed.text === "string") patch.text = parsed.text;
    if (parsed.isRedacted) patch.isRedacted = true;
    patch.status = status;
    return { kind: "inplace", target, patch };
  }
  return {
    kind: "legacy-push",
    row: {
      id,
      role: "thinking",
      text: parsed.text ?? "",
      isRedacted: parsed.isRedacted === true,
      status,
      agent,
      blockId: event.block_id,
      turnId: event.turn_id,
      ts: event.ts,
    },
  };
}

/** tool_use: finalize overlay (a1) / patch in place (a2) / late-mount (a3).
 *  `input` is always set (even to `undefined`), `inputPartialJson` is always
 *  cleared, `toolName` only fills when absent, status only moves on
 *  aborted/error (otherwise stays "running"). */
function reconcileToolUseComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
  parsed: ParsedBlockContent,
): ReconcilePlan {
  const { focus, merged, overlay } = snapshot;
  const agent = focus.agent;
  const toolId = parsed.tool_use_id ?? "";
  const id = `t_${toolId}`;
  const toolOverlay = overlay.get(overlayKey(agent, id));
  if (toolOverlay && toolOverlay.role === "tool") {
    const patch: Partial<ChatMessage> = { input: parsed.input, inputPartialJson: undefined };
    if (parsed.name && !toolOverlay.toolName) patch.toolName = parsed.name;
    if (event.status === "aborted") patch.status = "aborted";
    else if (event.status === "error") patch.status = "error";
    return { kind: "overlay-finalize", key: overlayKey(agent, id), patch };
  }
  const target = merged.find((m) => m.id === id);
  if (target) {
    const patch: Partial<ChatMessage> = { input: parsed.input, inputPartialJson: undefined };
    if (parsed.name && !target.toolName) patch.toolName = parsed.name;
    if (event.status === "aborted") patch.status = "aborted";
    else if (event.status === "error") patch.status = "error";
    return { kind: "inplace", target, patch };
  }
  const status: ChatMessage["status"] =
    event.status === "aborted" ? "aborted" : event.status === "error" ? "error" : "running";
  return {
    kind: "legacy-push",
    row: {
      id,
      role: "tool",
      text: "",
      status,
      agent,
      toolId,
      toolName: parsed.name ?? "",
      input: parsed.input,
      turnId: event.turn_id,
      ts: event.ts,
    },
  };
}

/** tool_result: finalize overlay (a1) / patch in place (a2). A result with no
 *  preceding tool_use bubble (ring eviction / window cut) is dropped → noop. */
function reconcileToolResultComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
  parsed: ParsedBlockContent,
): ReconcilePlan {
  const { focus, merged, overlay } = snapshot;
  const agent = focus.agent;
  const toolId = parsed.tool_use_id ?? "";
  const id = `t_${toolId}`;
  const status: ChatMessage["status"] = parsed.is_error ? "error" : "done";
  const resultOverlay = overlay.get(overlayKey(agent, id));
  if (resultOverlay && resultOverlay.role === "tool") {
    const patch: Partial<ChatMessage> = { status };
    if (typeof parsed.text === "string") patch.output = parsed.text;
    return { kind: "overlay-finalize", key: overlayKey(agent, id), patch };
  }
  const target = merged.find((m) => m.id === id);
  if (target) {
    const patch: Partial<ChatMessage> = { status };
    if (typeof parsed.text === "string") patch.output = parsed.text;
    return { kind: "inplace", target, patch };
  }
  return { kind: "noop" };
}

/**
 * Reconcile a `block_complete` SSE frame against the current chat snapshot
 * into a single {@link ReconcilePlan}. Pure read-time core of
 * `ChatState.handleBlockComplete`: dispatches by `event.kind` to the five
 * per-kind helpers (error / text / thinking / tool_use / tool_result),
 * preserving the a1–a5 branch precedence verbatim. `parseBlockContent` is run
 * once for the non-error kinds (mirroring the original handler), and the
 * 'mail'/'compaction' kinds — which never arrive via block_complete — fall
 * through to a noop.
 *
 * Reads `$state` fields off the live overlay/merged refs (e.g. `toolName`,
 * `status`), which is safe ONLY because the shell calls this imperatively from
 * the SSE handler, never from inside a `$derived` / `$effect`.
 */
export function reconcileComplete(
  snapshot: ReconcileSnapshot,
  event: BlockCompleteEvent,
): ReconcilePlan {
  if (event.kind === "error") return reconcileErrorComplete(snapshot, event);
  const parsed = parseBlockContent(event.content_json);
  if (event.kind === "text") return reconcileTextComplete(snapshot, event, parsed);
  if (event.kind === "thinking") return reconcileThinkingComplete(snapshot, event, parsed);
  if (event.kind === "tool_use") return reconcileToolUseComplete(snapshot, event, parsed);
  if (event.kind === "tool_result") return reconcileToolResultComplete(snapshot, event, parsed);
  return { kind: "noop" };
}

/**
 * Reconcile a `block_canceled` SSE frame (FRI-78): the daemon DELETEd a block
 * that started but never accumulated content. Drop any overlay entry AND any
 * legacy bubble mounted against that block id. AGENT-AGNOSTIC (fix #4): the
 * overlay scan matches by `blockId` across ALL agents and returns the exact
 * map keys to delete (`overlayKey(entry.agent, entry.id)` reconstructs the
 * insertion key), and the legacy filter is likewise untagged — exactly the
 * cross-agent delete `handleBlockCanceled` performed inline.
 */
export function reconcileCanceled(
  legacy: readonly ChatMessage[],
  streaming: readonly OverlayEntry[],
  blockId: string,
): { nextLegacy: ChatMessage[]; dropKeys: OverlayKey[] } {
  const dropKeys: OverlayKey[] = [];
  for (const entry of streaming) {
    if (entry.blockId === blockId) dropKeys.push(overlayKey(entry.agent, entry.id));
  }
  const nextLegacy = legacy.filter((m) => m.blockId !== blockId);
  return { nextLegacy, dropKeys };
}

/**
 * True when the canonical user bubble for a confirmed turn has already landed
 * — either pushed into the legacy bucket by an SSE-first `block_complete` or
 * sitting in the streaming overlay. `confirmPending` uses this as its
 * defense-in-depth dedup: if the bubble is already here, the optimistic entry
 * is dropped without pushing a second bubble at the same id (which would crash
 * the keyed `{#each}`). `targetId` is `userBlockIdForTurn(turn_id)`.
 */
export function userBubbleAlreadyLanded(
  legacy: readonly ChatMessage[],
  streaming: readonly OverlayEntry[],
  targetId: string,
): boolean {
  return legacy.some((m) => m.id === targetId) || streaming.some((s) => s.id === targetId);
}

/** Wire shape of a row from `GET /api/agents/:name/blocks`. Mirrors the
 *  `blocks` table columns (FIX_FORWARD 1.1). */
export interface BlockRow {
  /** Phase 4.11: text UUID (was bigserial number). Equal to
   *  blockId for mutator-INSERTed rows; for legacy daemon-written
   *  rows the column still holds the original bigserial value as
   *  text (e.g. "123"). */
  id: string;
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: string;
  source: string | null;
  contentJson: string;
  status: string;
  ts: number;
}

/** Phase 3.7: snake_case Zero row shape mirrors the Postgres `blocks`
 *  table — exposed here (not imported from `zero.svelte.ts`) to avoid
 *  the chat → zero circular dependency. Aligned with `ZeroBlockRow`
 *  in the Zero store (`zero.svelte.ts`). */
export interface ZeroBlocksRow {
  /** Phase 4.11: flipped from `number` → `string` alongside the
   *  Drizzle bigserial→text(uuid) migration. */
  id: string;
  block_id: string;
  turn_id: string;
  agent_name: string;
  session_id: string;
  message_id: string | null;
  block_index: number;
  role: string;
  kind: string;
  source: string | null;
  content_json: unknown;
  status: string;
  streaming: boolean;
  origin_mutation_id: string | null;
  ts: number;
}

/** Convert a Zero row (snake_case, jsonb columns auto-parsed) to the
 *  `BlockRow` shape `parseBlocks` consumes (camelCase, `content_json`
 *  re-serialized to a JSON string). The string round-trip is load-
 *  bearing: parseBlocks runs `parseBlockContent` which calls JSON.parse
 *  on `contentJson` — passing a parsed object would double-parse and
 *  throw. */
export function zeroBlockRowToBlockRow(r: ZeroBlocksRow): BlockRow {
  return {
    id: r.id,
    blockId: r.block_id,
    turnId: r.turn_id,
    agentName: r.agent_name,
    sessionId: r.session_id,
    messageId: r.message_id,
    blockIndex: r.block_index,
    role: r.role,
    kind: r.kind,
    source: r.source,
    contentJson:
      typeof r.content_json === "string" ? r.content_json : JSON.stringify(r.content_json ?? null),
    status: r.status,
    ts: r.ts,
  };
}

/** Strip safety-net "Agent didn't respond" bubbles that are no longer
 *  load-bearing. Two cases:
 *
 *   1. **Superseded**: the turn has since produced real assistant
 *      content. parseBlocks emits `nr_<turnId>` with
 *      `noResponseSentinel=false` for any user_chat turn that lacks
 *      assistant blocks at parse time — a fundamentally stateful
 *      inference that's wrong during the brief race where the user
 *      message lands in Zero before the first assistant block does.
 *   2. **Orphaned**: the user_chat user bubble that anchored the
 *      affordance is gone. Happens when the upstream blocks row was
 *      deleted (cancel-queued mutator, daemon block_canceled) but the
 *      nr_ synth from a prior parse run is still in `messages`.
 *
 *  Sentinel-driven nr_ bubbles (`noResponseSentinel=true`) come from
 *  the SDK's trained marker block and are authoritative; we never
 *  drop those. */
export function dropSupersededNoResponseSafetyNet(messages: ChatMessage[]): ChatMessage[] {
  const respondedTurns = new Set<string>();
  const userChatTurns = new Set<string>();
  for (const m of messages) {
    if (!m.turnId) continue;
    if (m.role === "assistant" && m.kind !== "no-response") {
      respondedTurns.add(m.turnId);
    } else if (m.role === "thinking" || m.role === "tool") {
      respondedTurns.add(m.turnId);
    } else if (m.role === "user" && (m.source ?? "user_chat") === "user_chat") {
      userChatTurns.add(m.turnId);
    }
  }
  return messages.filter((m) => {
    if (
      m.role === "assistant" &&
      m.kind === "no-response" &&
      m.noResponseSentinel === false &&
      m.turnId
    ) {
      if (respondedTurns.has(m.turnId)) return false;
      if (!userChatTurns.has(m.turnId)) return false;
    }
    return true;
  });
}

/**
 * Convert BlockRow[] (from /api/agents/:name/blocks) into the ChatMessage[]
 * the chat UI renders. Mirrors `handleBlockComplete`'s id scheme so a
 * canonical block row + a live block_complete SSE event converge on the
 * same bubble id (FIX_FORWARD 3.7 + 2.6).
 */
/**
 * FRI-81 D2/D3: a thinking or tool_use row left at status='streaming' in
 * the DB is an orphan when the worker died or the daemon restarted before
 * any teardown could finalize it. Heuristic to decide which streaming rows
 * are orphans without an authoritative "is this turn active" signal:
 *
 *   - Compute the max ts across all rows ("global high-water"). The active
 *     turn, if one exists, is by definition the turn that produced the
 *     newest block.
 *   - For each turn, compute the turn's max ts.
 *   - A streaming row is an orphan if EITHER:
 *       (a) Its turn's max ts is strictly less than the global high-water —
 *           i.e. a later turn has produced blocks since, so this turn
 *           cannot still be live.
 *       (b) Its own ts is strictly less than its turn's max ts — i.e. a
 *           sibling block in the same turn landed later (possibly already
 *           terminal), so the worker moved past this block.
 *
 * The streaming-mid-current-turn case (this block IS the latest activity
 * we know about) is preserved so reload-during-stream resumes cleanly —
 * `handleBlockDelta` gates on `m.status === "streaming"` / "running" and
 * would otherwise reject the next SSE delta.
 *
 * `loadAgentTurns`'s post-render `/api/agents/:name` probe handles the
 * remaining case (this is the only/latest turn AND the agent is idle)
 * via `healOrphanStreamingBubbles` on the live message array.
 *
 * Known race (PR #22 review N1): rule (b) compares `ts` values. The
 * daemon's `block_complete` write bumps the row's `ts` to `Date.now()`
 * when `block-stream.close()` INSERTs the canonical row; if a sibling
 * block in the same turn has already completed AND its ts is later
 * than this still-streaming block's `ts`, this block is classified as
 * orphan even though it might still be receiving deltas. The window
 * is bounded — the next SSE `block_complete` event flips the bubble to a real
 * terminal status and overrides the misclassification — but the user
 * sees a brief "Stopped" affordance on a block that wasn't stopped.
 * Acceptable for now; a full fix would require tracking the daemon's
 * live-turn map on the dashboard side, which is more state than the
 * symptom warrants.
 */
function classifyOrphanRows(blocks: BlockRow[]): Set<string> {
  const orphans = new Set<string>();
  if (blocks.length === 0) return orphans;
  const maxTsByTurn = new Map<string, number>();
  let globalMax = -Infinity;
  for (const b of blocks) {
    const prev = maxTsByTurn.get(b.turnId);
    if (prev === undefined || b.ts > prev) maxTsByTurn.set(b.turnId, b.ts);
    if (b.ts > globalMax) globalMax = b.ts;
  }
  for (const b of blocks) {
    if (b.status !== "streaming") continue;
    const turnMax = maxTsByTurn.get(b.turnId) ?? b.ts;
    if (turnMax < globalMax || b.ts < turnMax) orphans.add(b.blockId);
  }
  return orphans;
}

export function parseBlocks(
  blocks: BlockRow[],
  agent: string,
  opts: {
    inflightTurnId?: string | null;
    /** When true, the focused agent's `status` is `'working'` in the
     *  DB/Zero snapshot. Suppresses the "Agent didn't respond" safety-net
     *  for ALL pending turns — the missing assistant block is still being
     *  generated. Covers page-refresh and mail-triggered turns where
     *  `inflightTurnId` is null but the agent is actively producing output.
     *  Must be checked BEFORE `zeroResultIncomplete` so a complete-replica
     *  frame with a still-working agent doesn't fire the sentinel. */
    agentWorking?: boolean;
    /** Per-turn grace deadline (epoch ms) for the FRI-85 safety net.
     *  Owned by ChatState.noResponseGraceUntil; covers the SSE-faster-
     *  than-Zero race where the inflight slot has cleared but the
     *  assistant block hasn't replicated to this client yet. */
    noResponseGraceUntil?: Record<string, number>;
    /** FRI-91: the input came from a Zero snapshot whose `resultType` is
     *  not yet `"complete"` (initial bootstrap still streaming in, or the
     *  local IndexedDB replica is behind upstream). The safety-net loop
     *  must NOT synthesize "Agent didn't respond" for user-only turns
     *  while this is true — the missing assistant blocks may simply not
     *  have replicated yet. Only call sites that hand parseBlocks a
     *  partial view (applyZeroBlocks) set this; REST-driven paths pass
     *  full server payloads and leave it falsy. */
    zeroResultIncomplete?: boolean;
    /** Epoch ms; no-response guard is suppressed while now < this. */
    reconnectGraceUntil?: number;
    /** FRI-60: maps turn_id → zero_block_reason. When the safety-net
     *  synthesizes a no-response bubble, attaches the reason so
     *  ChatMessages can show the right copy (abort / compaction /
     *  sdk-resume-failure). Owned by ChatState.zeroBlockReasonByTurn. */
    zeroBlockReasonByTurn?: Record<string, "abort" | "compaction" | "sdk-resume-failure">;
    /** Wall-clock reference (epoch ms) for the FRI-85 / FRI-91 grace-window
     *  comparisons below. Supplied by the caller so this function is a pure
     *  function of its inputs — the clock is pinned at the IO boundary (the
     *  shell's reload/pagination paths and `mergeZeroSnapshot`, which requires
     *  it). The `Date.now()` fallback exists ONLY for time-agnostic callers
     *  that set no grace fields, where `now`'s value cannot affect the result
     *  (the grace branches are the only place `now` is read). Always pass it
     *  explicitly when any grace field is set, or the suppression window is
     *  measured against an uncontrolled clock. */
    now?: number;
  } = {},
): ChatMessage[] {
  const orphans = classifyOrphanRows(blocks);
  const out: ChatMessage[] = [];
  const toolByToolId = new Map<string, ChatMessage>();
  // Pre-scan: which tool_use_ids actually have a tool_use row in this
  // batch. The 50-row Zero window — and the `?before=` scroll-back
  // batches that share the same shape — often slice between a tool_use
  // and its tool_result; we want to drop the orphan tool_result rather
  // than render a `toolName="(unknown)"` card with just the result text
  // ("mail 154 closed", a bare exit code, …) which is noise without the
  // tool name + input. FRI-81 D1 still has to work: when both rows ARE
  // in the batch but `finalizeStreamingBlocks` bumped the tool_use past
  // the tool_result's ts, the sort processes tool_result first and the
  // fold-in-existing path needs to materialize a placeholder. So:
  // window-cut orphan ⇒ drop, ts-reorder orphan ⇒ synth-then-fold.
  const toolUseIdsInBatch = new Set<string>();
  for (const b of blocks) {
    if (b.kind === "tool_use") {
      const p = parseBlockContent(b.contentJson);
      const tid = p.tool_use_id ?? b.blockId;
      toolUseIdsInBatch.add(tid);
    }
  }
  // FRI-85: track which turns produced any assistant-side content, and
  // which turns we've already synthesized a no-response affordance for
  // (sentinel-driven). After the main pass we scan user-only turns and
  // backfill a "Agent didn't respond" affordance for any that ended with
  // no assistant content at all (covers worker-died-before-block_start,
  // Task-only responses filtered at the worker, etc.).
  const userTurns = new Map<string, { ts: number; index: number }>();
  const assistantTurns = new Set<string>();
  const noResponseTurns = new Set<string>();
  // Newest-first arrives from the API; chronological for rendering. Sort by
  // `ts` first so boot-time jsonl-recovery rows — which receive a fresh
  // autoincrement `id` strictly greater than the live retry blocks that came
  // after the recovered failure — slot into the correct chronological position
  // (failed attempt before its retry) instead of trailing the successful
  // retry. `id` stays as the tiebreaker for blocks sharing a ts (a single
  // live message's thinking + tool_use can land within the same ms).
  // Phase 4.11: id is now a text UUID, so the chronological
  // tiebreak switches from numeric subtraction to lexical
  // comparison. Within a millisecond the lexical order is
  // arbitrary-but-stable — same property bigserial provided.
  const sorted = [...blocks].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const b of sorted) {
    const parsed = parseBlockContent(b.contentJson);
    if (b.kind === "text") {
      const role = b.role === "user" ? "user" : "assistant";
      if (isNoResponseSentinel(b.role, parsed.text)) {
        // FRI-85: the SDK's trained end-of-turn marker. Instead of FRI-9's
        // silent suppression (which left the user staring at their own
        // message), render a faint "Agent acknowledged — no reply needed"
        // affordance. Single bubble per turn; idempotent on duplicate
        // sentinels (a refork can produce two).
        if (b.turnId && !noResponseTurns.has(b.turnId)) {
          noResponseTurns.add(b.turnId);
          assistantTurns.add(b.turnId);
          out.push({
            id: noResponseIdForTurn(b.turnId),
            role: "assistant",
            kind: "no-response",
            noResponseSentinel: true,
            text: "",
            status: "complete",
            agent,
            turnId: b.turnId,
            ts: b.ts,
          });
        }
        continue;
      }
      if (role === "assistant" && b.turnId) assistantTurns.add(b.turnId);
      if (role === "user" && b.turnId) {
        // user_chat is the only source that carries the "I sent something
        // and expected a reply" semantics — mail / queue_inject / scratch
        // / agent_spawn / schedule are agent-driven traffic where a silent
        // turn is fine. The safety-net synth below only fires for
        // user_chat-sourced user blocks.
        // Queued blocks haven't been dispatched yet; don't expect a response.
        if (b.source === "user_chat" && b.status !== "queued") {
          userTurns.set(b.turnId, { ts: b.ts, index: out.length });
        }
      }
      const id = role === "user" ? userBlockIdForTurn(b.turnId) : `b_${b.blockId}`;
      // Preserve the row's `streaming` state. On reload during a turn,
      // the assistant block is still being filled — collapsing it to
      // `complete` here would make `handleBlockDelta` reject every
      // subsequent SSE delta (it gates on `m.status === "streaming"`)
      // and the user would see a frozen replay instead of a live
      // resumption. User blocks are always finalized at insert time
      // so they map cleanly to `complete`.
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        role === "user"
          ? b.status === "queued"
            ? "queued"
            : "complete"
          : b.status === "streaming"
            ? isOrphan
              ? "aborted"
              : "streaming"
            : b.status === "complete"
              ? "complete"
              : b.status === "aborted"
                ? "aborted"
                : "error";
      out.push({
        id,
        role,
        text: parsed.text ?? "",
        status,
        agent,
        turnId: b.turnId,
        blockId: b.blockId,
        ts: b.ts,
        source: (b.source as ChatMessage["source"]) ?? undefined,
        fromAgent: parsed.from_agent,
        mailMeta: extractMailMeta(parsed),
        attachments: parsed.attachments,
      });
    } else if (b.kind === "thinking") {
      // FRI-81 D4: an empty thinking row at status='complete' is a ghost
      // — typically an SDK-opened block the worker abandoned before the
      // FRI-78 block-cancel IPC existed. The dashboard's ThinkingBlock
      // renders empty text as "redacted by Anthropic", which is not what
      // these rows are. Drop them on reload. Aborted / error empties are
      // preserved because they carry the user-visible "stopped" affordance
      // (the worker explicitly tore the block down). Streaming rows are
      // preserved so reload-mid-turn deltas still attach.
      const hasText = typeof parsed.text === "string" && parsed.text.length > 0;
      // Redacted blocks legitimately have no text — exempt from the ghost filter.
      if (!hasText && !parsed.isRedacted && b.status === "complete") continue;
      // FRI-85: only count rows that survive the D4 filter as assistant
      // content. A dropped ghost thinking row should not suppress the
      // user-only-turn safety-net no-response affordance below.
      if (b.turnId) assistantTurns.add(b.turnId);
      // Same shape for thinking blocks. `handleBlockDelta` gates on
      // `m.status === "running"` for thinking; preserve "running"
      // for streaming rows so reload-mid-turn deltas append.
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        b.status === "streaming"
          ? isOrphan
            ? "aborted"
            : "running"
          : b.status === "aborted"
            ? "aborted"
            : b.status === "error"
              ? "error"
              : "done";
      out.push({
        id: `th_${b.blockId}`,
        role: "thinking",
        text: parsed.text ?? "",
        isRedacted: parsed.isRedacted === true,
        status,
        blockId: b.blockId,
        turnId: b.turnId,
        ts: b.ts,
      });
    } else if (b.kind === "tool_use") {
      if (b.turnId) assistantTurns.add(b.turnId);
      const toolId = parsed.tool_use_id ?? b.blockId;
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        b.status === "aborted"
          ? "aborted"
          : b.status === "error"
            ? "error"
            : b.status === "streaming" && isOrphan
              ? "aborted"
              : "running";
      // FRI-81 D1: a tool_result row may have been sorted (and processed)
      // before its tool_use sibling when `finalizeStreamingBlocks` updates
      // the tool_use's `ts` past the tool_result's original insert `ts`.
      // The earlier code path skipped the tool_use entirely, leaving the
      // tool-card with toolName="(unknown)" and no input. Instead, fold
      // the tool_use's authoritative name/input into the existing synth.
      const existing = toolByToolId.get(toolId);
      if (existing) {
        if (parsed.name) existing.toolName = parsed.name;
        if (parsed.input !== undefined) existing.input = parsed.input;
        if (!existing.turnId) existing.turnId = b.turnId;
        // Don't downgrade a terminal tool_result status with a tool_use
        // "running" — but DO honor a tool_use-side aborted/error since
        // those won't have a tool_result follow-up.
        if (status === "aborted" || status === "error") existing.status = status;
        continue;
      }
      const msg: ChatMessage = {
        id: `t_${toolId}`,
        role: "tool",
        text: "",
        status,
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        // FRI-84: blockId on reload mirrors the live handleBlockStart
        // setter so any reload-mid-stream delta routing finds this row.
        blockId: b.blockId,
        turnId: b.turnId,
        ts: b.ts,
      };
      out.push(msg);
      toolByToolId.set(toolId, msg);
    } else if (b.kind === "error") {
      if (b.turnId) assistantTurns.add(b.turnId);
      // FRI-12: synthetic error bubble persisted by the daemon when the
      // SDK throws or the stop force-kill safety net fires. Mirror the
      // SSE `block_complete` materialization shape so reload-mid-error
      // and live-error converge on the same id (e_<blockId>).
      const errPayload = parseErrorContent(b.contentJson);
      out.push({
        id: `e_${b.blockId}`,
        role: "assistant",
        kind: "error",
        text: errPayload.headline,
        status: "error",
        agent,
        turnId: b.turnId,
        ts: b.ts,
        errorCode: errPayload.code,
        errorHeadline: errPayload.headline,
        httpStatus: errPayload.httpStatus,
        retryAfterSeconds: errPayload.retryAfterSeconds,
        requestId: errPayload.requestId,
        rawErrorMessage: errPayload.rawMessage,
      });
    } else if (b.kind === "tool_result") {
      if (b.turnId) assistantTurns.add(b.turnId);
      const toolId = parsed.tool_use_id ?? "";
      const status = parsed.is_error ? "error" : "done";
      const existing = toolByToolId.get(toolId);
      if (existing) {
        existing.status = status;
        existing.output = parsed.text ?? "";
      } else if (toolUseIdsInBatch.has(toolId)) {
        // FRI-81 D1: the tool_use IS in this batch but hasn't been
        // processed yet because `finalizeStreamingBlocks` bumped its
        // ts past the tool_result's. Materialize a placeholder so the
        // upcoming tool_use can fold its name + input in.
        const synth: ChatMessage = {
          id: `t_${toolId}`,
          role: "tool",
          text: "",
          status,
          toolId,
          toolName: "(unknown)",
          output: parsed.text ?? "",
          turnId: b.turnId,
          ts: b.ts,
        };
        out.push(synth);
        toolByToolId.set(toolId, synth);
      }
      // Else: window-cut orphan — drop. See `toolUseIdsInBatch`
      // pre-scan comment at the top of parseBlocks.
    } else if (b.kind === "compaction") {
      // FRI-156 §E: durable compaction marker block. Materialize the
      // full-width "Context compacted · 779K → 50K tokens" divider. The
      // row is persisted (kind:'compaction', role:'system') and replicates
      // via Zero, so this branch fires on BOTH the live insert and every
      // reload — the stable `cb_<blockId>` id makes the two converge on a
      // single divider (a duplicated id would crash the keyed {#each}).
      // role:'assistant' so the divider rides the existing focused-agent
      // filter and the chat-grouping continuation guard treats it as a
      // full-width continuation row (no spurious author/timestamp header).
      // The marker is the turn's visible artifact, so count it toward
      // assistantTurns: a user-typed `/compact` writes a user_chat block and
      // typically emits no assistant TEXT block, so on reload the turn would
      // otherwise be in userTurns, absent from assistantTurns, and the FRI-85
      // net would synthesize a spurious "Agent didn't respond" bubble next to
      // the divider. (The daemon's marker bumps blocksThisTurn so the live
      // zeroBlockReason path already handles this — but reload rebuilds
      // assistantTurns purely from block kinds, where blocksThisTurn has no
      // effect, so the divider itself must register as the artifact.)
      if (b.turnId) assistantTurns.add(b.turnId);
      out.push({
        id: compactionDividerId(b.blockId),
        role: "assistant",
        kind: "compaction",
        text: "",
        status: "complete",
        agent,
        turnId: b.turnId,
        ts: b.ts,
        preTokens: typeof parsed.pre_tokens === "number" ? parsed.pre_tokens : undefined,
        postTokens: typeof parsed.post_tokens === "number" ? parsed.post_tokens : undefined,
      });
    }
  }
  // FRI-85 safety net: for any user_chat-sourced user message whose turn
  // produced zero assistant-side blocks (text/thinking/tool/error), synth
  // an "Agent didn't respond" affordance so the user is never left staring
  // at an unanswered message. Covers H3 (worker died before block_start),
  // H5 (entire response was Task sub-agent traffic filtered at the worker),
  // and any other "turn completed silently" path that doesn't already
  // leave a visible artifact. Inserted just after the user block by ts so
  // the natural chronological sort keeps it adjacent.
  let synthesized = false;
  // Suppress the synth for the agent's currently in-flight turn.
  // The Claude SDK's first stream_event can land anywhere from
  // hundreds of ms to many seconds after submit (model latency,
  // queue depth, tool-call subprocess startup). A blanket time
  // grace would either flash the "Agent didn't respond" affordance
  // for slow turns or hide it for genuinely-failed-fast turns; the
  // chat store's `inflightTurnIdByAgent` is the unambiguous signal.
  // While a turn is the agent's in-flight turn, the safety-net
  // never fires; once it stops being in-flight (turn_done from
  // SSE or agents.status flip to idle), the next parseBlocks run
  // will see no inflight match and the synth can fire if the turn
  // genuinely produced no assistant content.
  const inflight = opts.inflightTurnId;
  const grace = opts.noResponseGraceUntil;
  const zeroReasons = opts.zeroBlockReasonByTurn;
  const reconnectGrace = opts.reconnectGraceUntil ?? 0;
  const now = opts.now ?? Date.now();
  for (const [turnId, info] of userTurns) {
    if (assistantTurns.has(turnId)) continue;
    if (inflight && turnId === inflight) continue;
    if (reconnectGrace > now) continue;
    // Post-clear grace: SSE turn_done cleared the inflight slot, but
    // Zero may still be pushing the assistant block over WS. Without
    // this check, the next parseBlocks pass on a frame between SSE
    // turn_done and Zero block-landing flashes a spurious
    // "Agent didn't respond" bubble that vanishes ~1 frame later.
    const graceDeadline = grace?.[turnId];
    if (graceDeadline && graceDeadline > now) continue;
    // FRI-54: agent.status = 'working' in the DB means a turn is
    // actively in progress. Suppress the sentinel regardless of whether
    // we have a local inflightTurnId — covers page refresh and mail-
    // triggered turns where ephemeral state was never set.
    if (opts.agentWorking) continue;
    // FRI-91: while Zero hasn't confirmed the local replica matches
    // upstream, a missing assistant block is indistinguishable from
    // "the worker died" vs. "the row just hasn't replicated yet."
    // The in-memory grace map can't cover this on page reload (it's
    // wiped on every load); the resultType signal is the only thing
    // that survives. Skip synthesis until Zero says "complete."
    if (opts.zeroResultIncomplete) continue;
    synthesized = true;
    out.push({
      id: noResponseIdForTurn(turnId),
      role: "assistant",
      kind: "no-response",
      noResponseSentinel: false,
      // FRI-60: attach the reason so ChatMessages shows the right copy.
      zeroBlockReason: zeroReasons?.[turnId],
      text: "",
      status: "complete",
      agent,
      turnId,
      // +1ms keeps it strictly after its user message even when ts
      // collisions occur (a fast turn can land sub-millisecond).
      ts: info.ts + 1,
    });
  }
  // Final ts-sort so the safety-net synth lands chronologically adjacent
  // to its user message rather than at the trailing edge. Stable on
  // existing entries (their ts ordering already matches the input-block
  // sort one level up); only nr_<turnId> rows actually move.
  if (synthesized) {
    out.sort((a, b) => a.ts - b.ts);
  }
  // Cross-agent isolation depends on every bubble carrying its owning
  // agent: `#derivedMessages` (`if (m.agent && m.agent !== focused)`) and
  // `applyZeroBlocks`'s merge (`if (m.agent && m.agent !== forAgent)`) only
  // drop a legacy bubble when its `agent` tag is truthy AND mismatched.
  // Most push sites above (text/thinking/tool/tool_result/user) omit the
  // tag, so without this stamp those bubbles are untagged and leak into
  // EVERY agent's chat — e.g. a builder's tool calls surface in Friday's
  // thread even though their canonical rows are correctly attributed in
  // the DB. parseBlocks always parses exactly one agent's rows (`agent`),
  // so tagging the whole batch here is unambiguous and idempotent (the
  // error / no-response synths already set the same value).
  for (const m of out) m.agent = agent;
  return out;
}

/** Lowest block_id across an array. Used as the next `before` cursor for
 *  scroll-up pagination (FIX_FORWARD 3.7). */

export function oldestBlockCursor(blocks: BlockRow[]): string | null {
  // Compare by `(ts, id)` tuple, NOT by bare `id`. Phase 4.11 made
  // `blocks.id` a text UUID; the pre-migration rows that came in via
  // legacy_sqlite restore kept their old bigserial ids as strings
  // ("9943", "9942", …). A bare lexical `b.id < oldest.id` is meaningless
  // across that mixed alphabet — e.g. `"2241..." < "9943" < "ebec..."` —
  // and chooses an "oldest" that has nothing to do with chronology, then
  // hands that anchor to the daemon's `?before=` pagination which
  // dutifully fetches rows older than the wrong row.
  let oldest: BlockRow | null = null;
  for (const b of blocks) {
    if (oldest === null || b.ts < oldest.ts || (b.ts === oldest.ts && b.id < oldest.id)) oldest = b;
  }
  return oldest?.blockId ?? null;
}

// ---------------------------------------------------------------------------
// Zero snapshot convergence — applyZeroBlocks merge core
// ---------------------------------------------------------------------------

/**
 * Inputs the {@link mergeZeroSnapshot} core reads. The shell ({@link
 * ChatState.applyZeroBlocks}) owns the gates, the `$state` pre-sets, the
 * session filter, and the empty-rows branch; it hands the already-session-
 * filtered `rows` plus read-only snapshots of the state the merge genuinely
 * consumes. `priorOldestBlockId` is captured BEFORE the merge so the core can
 * compute `oldestCursorChanged` against the cursor's prior value rather than
 * its post-assignment value (fix #3).
 */
export interface ZeroMergeInput {
  rows: readonly ZeroBlocksRow[];
  forAgent: string;
  agents: readonly AgentInfo[];
  inflightTurnId: string | null;
  legacyMessages: readonly ChatMessage[];
  zeroSeenBlockIds: ReadonlySet<string>;
  noResponseGraceUntil: Record<string, number>;
  reconnectGraceUntil: number;
  zeroBlockReasonByTurn: Record<string, "abort" | "compaction" | "sdk-resume-failure">;
  resultType: "complete" | "unknown" | "error";
  fullWindow: boolean;
  priorOldestBlockId: string | null;
  /** Wall-clock reference (epoch ms) for the FRI-85 / FRI-91 grace windows,
   *  captured by the shell at the IO boundary. Required (not defaulted) so this
   *  merge is a pure, deterministic function of its inputs — a grace-window
   *  test can pin `now` and assert suppression on/off without touching the
   *  real clock. */
  now: number;
}

/**
 * Result of merging a Zero snapshot. The shell consumes this and applies the
 * write-backs: assign `nextLegacyMessages`, add `snapshotBlockIds` to the
 * seen-tracker AFTER (gotcha 1), drop optimistic overlays whose queueId
 * appeared, and apply the cursor + `reachedOldest` two-writer (set true if
 * `reachedOldest`, then false if `oldestCursorChanged`). `newestRowForReadCursor`
 * is the `(ts, id)` tuple-max row for the per-device read cursor.
 */
export interface ZeroMergeResult {
  nextLegacyMessages: ChatMessage[];
  snapshotBlockIds: Set<string>;
  newOldestCursor: string | null;
  newestRowForReadCursor: { block_id: string; ts: number; id: string } | null;
  reachedOldest: boolean | undefined;
  oldestCursorChanged: boolean;
}

/**
 * Merge a fresh, already-session-filtered Zero snapshot into the focused
 * agent's chat view. Pure read-time core of `ChatState.applyZeroBlocks`:
 * parses the rows, merges them with the legacy bucket (parsed rows shadow by
 * id; optimistic-pending bubbles whose queueId now appears are dropped;
 * previously-seen-but-now-absent blockIds are treated as upstream deletes;
 * everything else is preserved), composes the FRI-85 superseded-no-response
 * pruner, and computes the pagination + read cursors.
 *
 * Idempotent on the same row set: a re-run produces an equal merged list and
 * the same cursors (`oldestCursorChanged` is false when the prior cursor
 * already equals the new one). Reads `zeroSeenBlockIds` but never mutates it —
 * the shell adds this snapshot's ids AFTER consuming the result so the
 * delete-detection compares against the PRIOR seen-set.
 */
export function mergeZeroSnapshot(input: ZeroMergeInput): ZeroMergeResult {
  const {
    rows,
    forAgent,
    agents,
    inflightTurnId,
    legacyMessages,
    zeroSeenBlockIds,
    noResponseGraceUntil,
    reconnectGraceUntil,
    zeroBlockReasonByTurn,
    resultType,
    fullWindow,
    priorOldestBlockId,
    now,
  } = input;

  const blockRows: BlockRow[] = rows.map(zeroBlockRowToBlockRow);
  const parsed = parseBlocks(blockRows, forAgent, {
    inflightTurnId,
    // FRI-54: DB-derived working status suppresses the sentinel on
    // refresh/mail-triggered turns even when the local inflightTurnId is null.
    agentWorking: agents.find((a) => a.name === forAgent)?.status === "working",
    // FRI-91 Part A: grace map covers the SSE-cleared-inflight-but-Zero-hasn't-
    // landed-the-block-yet flash, mirroring the REST fetch path.
    noResponseGraceUntil,
    reconnectGraceUntil,
    // FRI-91 Part B: until Zero confirms the replica matches upstream, a
    // user-only turn may just be waiting for replication.
    zeroResultIncomplete: resultType !== "complete",
    // FRI-60: reason map for the synthesized no-response bubble's copy.
    zeroBlockReasonByTurn,
    // Deterministic clock threaded from the shell's IO boundary (see ZeroMergeInput.now).
    now,
  });
  const parsedById = new Map<string, ChatMessage>();
  for (const m of parsed) parsedById.set(m.id, m);

  // Track this snapshot's block_ids so the shell can both detect upstream
  // deletes (a previously-seen id now absent) and drop optimistic overlays
  // whose queueId just landed canonically.
  const snapshotBlockIds = new Set<string>();
  for (const r of rows) snapshotBlockIds.add(r.block_id);

  const merged: ChatMessage[] = [];
  const seen = new Set<string>();
  // Iterate the legacy bucket only — overlay entries render via the `messages`
  // derivation and don't belong in legacy.
  for (const m of legacyMessages) {
    // Structural cross-agent isolation: drop legacy entries tagged for a
    // different agent.
    if (m.agent && m.agent !== forAgent) continue;
    const parsedMatch = parsedById.get(m.id);
    if (parsedMatch) {
      merged.push(parsedMatch);
      seen.add(m.id);
      continue;
    }
    // Drop optimistic-pending bubbles whose queueId (= pre-minted blockId) now
    // appears in the snapshot as a canonical block_id.
    if (m.queueId !== undefined && snapshotBlockIds.has(m.queueId)) continue;
    // The bubble's blockId was in a prior snapshot but is missing now — the
    // upstream row was deleted (cancel-queued / block_canceled). Drop it.
    if (
      m.blockId !== undefined &&
      zeroSeenBlockIds.has(m.blockId) &&
      !snapshotBlockIds.has(m.blockId)
    ) {
      continue;
    }
    // Otherwise preserve: in-flight SSE streams, optimistic-pending bubbles,
    // and scroll-back rows older than the Zero window.
    merged.push(m);
  }
  for (const m of parsed) {
    if (!seen.has(m.id)) merged.push(m);
  }
  merged.sort((a, b) => a.ts - b.ts);

  const nextLegacyMessages = dropSupersededNoResponseSafetyNet(merged);

  const newOldestCursor = oldestBlockCursor(blockRows);
  // fix #3: compare against the cursor's PRIOR value (captured before the
  // shell assigns it), not its post-assignment value.
  const oldestCursorChanged = newOldestCursor !== priorOldestBlockId;
  // FRI-161: a narrow-window 'complete' only means the recent window synced,
  // not that the user reached the oldest message — gate on fullWindow.
  const reachedOldest: boolean | undefined =
    resultType === "complete" && fullWindow ? true : undefined;

  // Chronologically newest row by (ts, id) tuple — Phase 4.11's mixed
  // numeric-string + UUID alphabet makes a bare lexical `id` compare
  // meaningless (see `oldestBlockCursor`).
  let newest: ZeroBlocksRow | null = null;
  for (const r of rows) {
    if (!newest || r.ts > newest.ts || (r.ts === newest.ts && r.id > newest.id)) newest = r;
  }
  const newestRowForReadCursor =
    newest !== null ? { block_id: newest.block_id, ts: newest.ts, id: newest.id } : null;

  return {
    nextLegacyMessages,
    snapshotBlockIds,
    newOldestCursor,
    newestRowForReadCursor,
    reachedOldest,
    oldestCursorChanged,
  };
}
