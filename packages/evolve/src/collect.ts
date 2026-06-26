/**
 * Orchestrator-transcript collection — the shared stage-A input for every
 * scanner (friction / preferences / dreaming). Extracted from scan-friction.ts
 * so the deep `runScanner` core (run-scanner.ts) can depend on it without a
 * circular import back through any individual scanner, and so the three
 * scanners draw `OrchestratorTurn` / `dbTurnIdToLine` from a neutral home.
 *
 * The DB coupling lives here and nowhere else: `runScanner` accepts a
 * `collectFn` seam that defaults to `collectOrchestratorTurns`, so the full
 * pipeline is drivable with canned turns and no Postgres in tests.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";

export interface OrchestratorTurn {
  sessionId: string;
  /** Source JSONL file (recorded on the turns row). */
  filePath: string;
  /** Synthetic id for matching back from LLM scoring output. */
  turnId: string;
  /** ISO timestamp. */
  ts: string;
  userText: string;
  prevAssistantText: string;
  /** DB row id. Phase 4.11 flipped `blocks.id` to text (UUID), so
   *  this can be a UUID for newer rows or a bigserial-shaped
   *  numeric string for legacy rows. We parse it as a number for
   *  the EvidencePointer's `line` field (falls through to omitted
   *  when NaN). */
  dbTurnId: string;
}

export function dbTurnIdToLine(id: string): number | undefined {
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve "which sessions belong to the orchestrator" by:
 *   1. Selecting all agents of type=orchestrator from the registry.
 *   2. Including their currently-attached sessionId, plus
 *   3. Every distinct sessionId in the `turns` table that's tagged with one
 *      of those agent names (catches historical sessions across resumes).
 */
async function collectOrchestratorSessions(): Promise<Set<string>> {
  const out = new Set<string>();
  const db = getDb();

  const orchAgents = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.type, "orchestrator"));
  if (orchAgents.length === 0) return out;

  for (const a of orchAgents) {
    if (a.sessionId) out.add(a.sessionId);
  }

  // Historic session enumeration via the `blocks` table — the legacy
  // `turns` table is retired per ADR-016. Distinct session_id values
  // for any orchestrator-named agent's blocks.
  const orchNames = orchAgents.map((a) => a.name);
  const historicSessions = await db
    .selectDistinct({ sessionId: schema.blocks.sessionId })
    .from(schema.blocks)
    .where(inArray(schema.blocks.agentName, orchNames));
  for (const t of historicSessions) {
    if (t.sessionId) out.add(t.sessionId);
  }

  return out;
}

/**
 * Walk the `turns` table for orchestrator sessions, return user turns paired
 * with the immediately preceding assistant text. Skips pure tool_result
 * echoes and strips `<memory-context>` auto-injection blocks.
 *
 * Capped at `maxTurns`. Older sessions go first if we hit the cap.
 */
export async function collectOrchestratorTurns(
  sinceMs: number,
  maxTurns: number,
): Promise<OrchestratorTurn[]> {
  const sessionIds = await collectOrchestratorSessions();
  if (sessionIds.size === 0) return [];

  // Ported to the `blocks` table per ADR-016 + ADR-023. Each block row is
  // already a single semantic unit (text / thinking / tool_use / tool_result
  // / user / mail); we no longer parse a JSONL-style `content_json` envelope
  // with `type=user|assistant`. The friction scorer wants pairs of
  // (user-typed text, immediately-preceding assistant text), so we walk
  // blocks in ts order, accumulate the latest assistant text per session,
  // and emit a turn whenever we see a user-role text/user block.
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(inArray(schema.blocks.sessionId, [...sessionIds]));
  // Sort ts ascending so older sessions get scored first when capped.
  rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const out: OrchestratorTurn[] = [];
  const prevAssistantBySession = new Map<string, string>();

  for (const r of rows) {
    const rTsMs = r.ts.getTime();
    if (sinceMs && rTsMs < sinceMs) continue;
    if (out.length >= maxTurns) break;

    // contentJson is jsonb; Drizzle returns it as the parsed object. Block
    // payloads are shaped per-kind; we only need the `text` field for the
    // text + user kinds.
    const content = r.contentJson as { text?: string };

    if (r.role === "assistant" && r.kind === "text") {
      const txt = typeof content?.text === "string" ? content.text : "";
      if (txt) prevAssistantBySession.set(r.sessionId, txt);
      continue;
    }

    // User-typed blocks (chat input, scratch seed, agent_spawn, schedule
    // task prompt). Skip mail-delivered user blocks — those aren't the
    // user's free-text friction signal.
    if (r.role !== "user" || r.kind !== "text") continue;
    if (r.source === "mail") continue;

    const userText = typeof content?.text === "string" ? content.text : "";
    if (!userText.trim()) continue;
    const cleaned = stripMemoryContext(userText).trim();
    if (!cleaned) continue;

    out.push({
      sessionId: r.sessionId,
      filePath: "",
      turnId: r.turnId,
      ts: r.ts.toISOString(),
      userText: cleaned,
      prevAssistantText: prevAssistantBySession.get(r.sessionId) ?? "",
      dbTurnId: r.id,
    });
  }

  return out;
}

function stripMemoryContext(text: string): string {
  return text.replace(/<memory-context>[\s\S]*?<\/memory-context>\s*/g, "");
}
