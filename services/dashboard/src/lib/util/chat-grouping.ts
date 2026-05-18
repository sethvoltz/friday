import type { ChatMessage } from "$lib/stores/chat.svelte";
import { localDayKey } from "./time-format";

/** Per-message rendering metadata derived from the full ordered list. */
export interface MessageGroupingMeta {
  /** Render a day separator above this message (new local day). */
  showDaySeparator: boolean;
  /** Render an inactivity separator above this message (>1h same-day gap).
   *  Mutually exclusive with `showDaySeparator` — day wins. */
  showInactivitySeparator: boolean;
  /** True when this is the first bubble of a new author-group. Slack-style
   *  same-author-within-5min grouping; only the first in a group renders an
   *  inline timestamp. Always true when a separator fires. */
  isFirstInGroup: boolean;
  /** True for streamed sub-blocks of an assistant turn (tool/thinking) that
   *  ride along with the previous anchor and never break grouping or emit
   *  their own separators/timestamps. */
  isContinuation: boolean;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** Stable author identity for grouping. Tool/thinking are continuations and
 *  are handled separately — not via this function. */
function authorOf(msg: ChatMessage): string {
  if (msg.kind === "error") return "system:error";
  if (msg.role === "user" && msg.source === "mail") {
    return `mail:${msg.fromAgent ?? "unknown"}`;
  }
  if (msg.role === "user") return "user";
  // assistant + no-response (which is a synthetic assistant placeholder).
  return `agent:${msg.agent ?? ""}`;
}

/**
 * Compute per-message grouping/separator metadata in a single forward pass.
 *
 * Rules:
 *   - tool/thinking blocks are continuations; they never break grouping and
 *     never carry their own separators or inline timestamps. The grouping
 *     anchor (ts + author) advances past them unchanged.
 *   - day separator fires when the local day flips between this anchor and
 *     the previous anchor (or when there is no previous anchor).
 *   - inactivity separator fires when the gap is >1h AND no day separator
 *     fired (day wins).
 *   - first-in-group fires when a separator fires, the author changes, or
 *     the gap exceeds 5 minutes.
 */
export function computeGroupingMeta(messages: ChatMessage[]): MessageGroupingMeta[] {
  const out: MessageGroupingMeta[] = new Array(messages.length);
  let prevTs: number | null = null;
  let prevAuthor: string | null = null;
  let prevDayKey: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool" || msg.role === "thinking") {
      out[i] = {
        showDaySeparator: false,
        showInactivitySeparator: false,
        isFirstInGroup: false,
        isContinuation: true,
      };
      continue;
    }

    const author = authorOf(msg);
    const dayKey = localDayKey(msg.ts);
    const isFirstEver = prevTs === null;
    const dayChanged = !isFirstEver && dayKey !== prevDayKey;
    const gap = prevTs === null ? 0 : msg.ts - prevTs;
    const inactivity = !dayChanged && !isFirstEver && gap > ONE_HOUR;
    const authorChanged = prevAuthor !== null && author !== prevAuthor;
    const isFirstInGroup =
      isFirstEver || dayChanged || inactivity || authorChanged || gap > FIVE_MINUTES;

    out[i] = {
      showDaySeparator: isFirstEver || dayChanged,
      showInactivitySeparator: inactivity,
      isFirstInGroup,
      isContinuation: false,
    };

    prevTs = msg.ts;
    prevAuthor = author;
    prevDayKey = dayKey;
  }

  return out;
}
