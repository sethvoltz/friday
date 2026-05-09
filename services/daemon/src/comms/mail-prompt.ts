/**
 * Renders an inbox into a first-turn prompt for the recipient. Used when the
 * mail bridge spawns a fresh turn for an agent that wasn't live when mail
 * landed (Phase 3+).
 */

import type { MailRow } from "@friday/shared/services";

const PREVIEW_CHARS = 220;

export function buildMailPrompt(agentName: string, inbox: MailRow[]): string {
  if (inbox.length === 0) {
    return `Your inbox is empty. Nothing to do.`;
  }
  const lines = inbox.map((m) => {
    const preview =
      m.body.length > PREVIEW_CHARS
        ? m.body.slice(0, PREVIEW_CHARS).replace(/\s+$/, "") + "…"
        : m.body;
    const flat = preview.replace(/\n+/g, " ");
    return `- mail #${m.id} from \`${m.fromAgent}\` (${m.type}, ${new Date(m.ts).toISOString()}): ${flat}`;
  });
  const replyHint =
    agentName === "orchestrator" || /^bare-/.test(agentName)
      ? "Reply to the user via `chat_reply`"
      : "Reply to the sender via `mail_send`";
  return [
    `You have ${inbox.length} pending mail item${inbox.length === 1 ? "" : "s"}.`,
    "",
    ...lines,
    "",
    `Use \`mail_read({id})\` to read each in full, then \`mail_close({id})\` once handled. ${replyHint} as appropriate.`,
  ].join("\n");
}
