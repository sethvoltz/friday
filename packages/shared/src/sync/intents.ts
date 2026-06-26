/**
 * Typed intent seam between dashboard mutators and daemon LISTEN handlers
 * (ADR-023 "row-as-intent", refined by ADR-049).
 *
 * Friday's side-effect mutators don't perform work directly. Each writes a
 * sentinel value into a domain row's `status` column and a Postgres trigger
 * fires a per-channel `NOTIFY`; the daemon's LISTEN handler re-reads the row
 * and runs the real side effect (fork a worker, fire an abort, write a memory
 * file, register a cron). The seam that crosses two PROCESSES and two PACKAGES
 * (`@friday/shared` mutator ↔ `services/daemon` listener) is the Postgres row
 * + the `status` string. This module names that contract so both sides import
 * it instead of re-spelling string literals and re-deriving payload shapes by
 * hand.
 *
 * It does NOT introduce a separate `intents` table — ADR-023 deliberately
 * rejected one. The intent stays encoded as a status value on the real domain
 * row (block / agent / schedule / memory_entry). This is a typed VIEW over
 * selected columns + status, layered on the existing row; the seam is exactly
 * where ADR-023 put it.
 *
 * Two distinct concerns live here:
 *
 *   1. INTENT_STATUS — the transient status tokens, centralized. Previously
 *      each token (`pending`, `abort_requested`, …) was a bare string literal
 *      re-spelled at five sites (mutator body, schema column comment, schema
 *      CHECK constraint, the CHECK migration, the Postgres trigger predicate)
 *      with nothing binding them. The mutators and listeners now import the
 *      const; `intents.test.ts` pins each value against its DB CHECK set so a
 *      rename can't silently desync the two. VALUES ARE FROZEN — changing a
 *      value is a data-format change (in-flight rows + CHECK + trigger keys all
 *      depend on the exact string), i.e. a migration, not a code edit. This
 *      const centralizes the DECLARATION, it does not authorize new spellings.
 *
 *   2. User-message content view — `parseUserMessageContent` /
 *      `buildUserMessageContent`. The `sendUserMessage` and `resumeTurn` seams
 *      carry a real payload in `content_json`, and both daemon listeners parsed
 *      it with a byte-identical hand-rolled `JSON.parse` + `typeof`/regex
 *      block. That duplicated re-derivation is the implicit-contract cost this
 *      module removes: the parser lives once, beside the constructor the
 *      mutator uses, and both listeners call it.
 *
 * The status-only seams (`abortTurn`, `cancelQueued`, `resumeTurn`'s status
 * flip, `archiveAgent`, `createSchedule`, `createMemoryEntry`) deliberately get
 * the token const but NO content-view object: there is no hand-parse to remove
 * — their listeners read typed Drizzle columns off the re-fetched row. Adding
 * an empty view object there would be indirection without removed duplication.
 *
 * `updateSettings` is the documented boundary case: it has no status token at
 * all. The intent is the whole settings row, reconciled by content-diff into
 * `config.json`. It does not fit the discriminated-token mold and is left out
 * of INTENT_STATUS by design (see ADR-049).
 *
 * This module is node-free (string consts + JSON) so it is safe in both the
 * browser-bundled `@friday/shared/sync` surface (the mutator side) and the
 * daemon (the listener side).
 */

/* ------------------------------------------------------------------ *
 * 1. Centralized transient intent status tokens
 * ------------------------------------------------------------------ */

/**
 * The transient `status` values a side-effect mutator writes to signal the
 * daemon. Each is flipped to a terminal state (or the row deleted) by the
 * handler. These are intentionally SEPARATE from the durable `BlockStatus`
 * union (`packages/shared/src/services/blocks.ts`) — a durable status is a
 * resting state; an intent token is a request the daemon consumes.
 *
 * Keys are camelCase; values are the literal column strings. One entry per
 * distinct token (`reload_requested` is shared by schedules; the apps seam
 * reuses the same literal and can adopt this const when it migrates).
 */
export const INTENT_STATUS = {
  // blocks
  /** sendUserMessage INSERT → daemon forks/queues the turn. */
  pending: "pending",
  /** abortTurn → daemon fires AbortController, flips back to 'complete'. */
  abortRequested: "abort_requested",
  /** cancelQueued → daemon splices nextPrompts + DELETEs the row. */
  cancelRequested: "cancel_requested",
  /** resumeTurn → daemon re-dispatches under the same turnId, flips to 'complete'. */
  resumeRequested: "resume_requested",
  // memory_entries
  /** createMemoryEntry / updateMemoryEntry → daemon writes the file, flips to 'ready'. */
  pendingFile: "pending_file",
  /** deleteMemoryEntry → daemon trashes the file, flips to 'deleted'. */
  pendingDelete: "pending_delete",
  // schedules
  /** createSchedule → daemon registers cron, flips to 'active'. */
  pendingRegister: "pending_register",
  /** updateSchedule → daemon recomputes nextRunAt, flips to 'active'. */
  reloadRequested: "reload_requested",
  /** triggerSchedule → daemon fires now, flips back to 'active'. */
  triggerRequested: "trigger_requested",
  /** deleteSchedule → daemon cleans up the registry stub. Tombstone (stays 'deleted'). */
  scheduleDeleted: "deleted",
  // agents
  /** archiveAgent → daemon archives worktree + closes tickets, flips to 'archived'. */
  archiveRequested: "archive_requested",
} as const;

/** Any transient intent status token value. */
export type IntentStatus = (typeof INTENT_STATUS)[keyof typeof INTENT_STATUS];

/**
 * Which table's CHECK constraint each token must be a member of. Drives the
 * `intents.test.ts` cross-boundary contract test (token ↔ DB CHECK agreement).
 * Keyed by token VALUE so duplicates (`reload_requested`, `deleted`) map
 * unambiguously to the table whose mutator+listener this pass owns.
 */
export const INTENT_STATUS_TABLE: Record<
  IntentStatus,
  "blocks" | "memory_entries" | "schedules" | "agents"
> = {
  pending: "blocks",
  abort_requested: "blocks",
  cancel_requested: "blocks",
  resume_requested: "blocks",
  pending_file: "memory_entries",
  pending_delete: "memory_entries",
  pending_register: "schedules",
  reload_requested: "schedules",
  trigger_requested: "schedules",
  deleted: "schedules",
  archive_requested: "agents",
};

/* ------------------------------------------------------------------ *
 * 2. User-message content view (sendUserMessage + resumeTurn seams)
 * ------------------------------------------------------------------ */

/**
 * A content attachment carried by a user-chat block, keyed by the upload's
 * sha256 (the daemon's attachment-store key). Matches `SendUserMessageArgs`'s
 * attachment shape and the daemon `dispatchTurn` option shape.
 */
export interface UserMessageAttachment {
  sha256: string;
  filename: string;
  mime: string;
}

/**
 * The typed view over a user-chat block's `content_json`. The mutator
 * constructs it (via `buildUserMessageContent`); the dispatch + resume
 * listeners parse it (via `parseUserMessageContent`). This is the shared
 * contract that replaces both sides hand-agreeing on the JSON shape.
 */
export interface UserMessageContent {
  text: string;
  attachments?: UserMessageAttachment[];
}

/**
 * Result of parsing a block's `content_json`. `ok` is `false` ONLY when
 * `JSON.parse` throws or the parsed value is JSON `null` (property access on the
 * primitive throws) — i.e. genuinely unrecoverable content. A value that parses
 * to any other non-object primitive (`42`, `"foo"`, `[…]`, `true`) does NOT
 * throw, so it returns `ok: true` with `text: ""` — matching the original
 * hand-parse, which left `userText=""` and fell through for those inputs rather
 * than treating them as corrupt. (Do NOT "tighten" this with a
 * `typeof parsed !== "object"` guard: that would flip non-object payloads in the
 * resume listener from its empty-text bail to its content-corrupt bail — a real
 * behavior change. The original had no such guard.)
 *
 * The dispatch listener ignores `ok` and forks an empty prompt on any result;
 * the resume listener bails terminal "content-corrupt" only when `ok` is false.
 * The discriminator is what preserves BOTH listeners' prior behavior with one
 * parser.
 */
export interface ParsedUserMessageContent {
  ok: boolean;
  content: UserMessageContent;
}

/**
 * Construct the `content_json` payload a user-chat block carries. Owns the
 * omit-empty-attachments rule so every writer agrees (the `sendUserMessage`
 * mutator is the canonical caller).
 */
export function buildUserMessageContent(
  text: string,
  attachments?: UserMessageAttachment[],
): UserMessageContent {
  const content: UserMessageContent = { text };
  if (attachments && attachments.length > 0) content.attachments = attachments;
  return content;
}

/**
 * Parse + validate the `content_json` a user-chat block carries — exactly as
 * the dispatch + resume listeners did by hand (dispatch-listener.ts:88-109,
 * resume-listener.ts:174-195). NEVER throws.
 *
 *   - `JSON.parse` throws, or the value is JSON `null` → `{ ok: false, content:
 *     { text: "" } }`. (These are the only `ok: false` cases — see the
 *     `ParsedUserMessageContent` doc for why non-object primitives stay `ok`.)
 *   - A non-string `text` (incl. a non-object primitive) → coerced to `""`,
 *     `ok: true`.
 *   - Attachments are kept only when each is an object with a 64-hex `sha256`
 *     (the daemon's attachment key); invalid entries are dropped. This mirrors
 *     the prior filter exactly — it validates `sha256` only, then trusts the
 *     `{ filename, mime }` companions the upload path wrote alongside it.
 */
export function parseUserMessageContent(raw: string): ParsedUserMessageContent {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; attachments?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    let attachments: UserMessageAttachment[] | undefined;
    if (Array.isArray(parsed.attachments)) {
      attachments = parsed.attachments.filter(
        (a): a is UserMessageAttachment =>
          a !== null &&
          typeof a === "object" &&
          typeof (a as { sha256?: unknown }).sha256 === "string" &&
          /^[a-f0-9]{64}$/.test((a as { sha256: string }).sha256),
      );
    }
    return { ok: true, content: attachments ? { text, attachments } : { text } };
  } catch {
    // Malformed content_json (incl. JSON.parse → null, where property access
    // on the primitive throws). Empty content; caller decides fork-vs-bail.
    return { ok: false, content: { text: "" } };
  }
}
