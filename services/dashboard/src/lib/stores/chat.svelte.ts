import type { WireEvent } from "@friday/shared";

export interface ChatMessage {
  /** turn_id for assistant; "u_<n>" for user; "t_<toolId>"; "th_<blockId>". */
  id: string;
  role: "user" | "assistant" | "tool" | "thinking";
  /** user/assistant: rendered markdown body. thinking: streamed thoughts. tool: unused. */
  text: string;
  status:
    | "streaming" // assistant turn still receiving deltas
    | "complete"
    | "aborted"
    | "error"
    | "running" // tool/thinking still in progress
    | "done";
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

  // Thinking-specific
  blockId?: string;

  /** Source DB row id for the JSONL turn this message was parsed from.
   * Used as the pagination cursor when loading older history. Live SSE
   * deltas don't carry one. */
  dbTurnId?: number;
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
}

export class ChatState {
  messages = $state<ChatMessage[]>([]);
  agents = $state<AgentInfo[]>([]);
  focusedAgent = $state("friday");
  /** Cursor for race-free SSE catchup; bumped after each event applied. */
  lastSeq = $state(0);
  inflightTurnId = $state<string | null>(null);
  connected = $state(false);
  /** Smallest `dbTurnId` we've loaded; pagination cursor for older turns. */
  oldestDbId = $state<number | null>(null);
  /** True while a paginated fetch is in flight; prevents re-entrant calls. */
  loadingOlder = $state(false);
  /** True once we've fetched and gotten back an empty page (no more history). */
  reachedOldest = $state(false);
  /** Set by ChatShell from its scroll handler. ChatMessages reads it to
   * decide whether to slice the rendered list (cap at WINDOW when bottom-
   * pinned) or render everything (when the user is reading older history). */
  pinnedToBottom = $state(true);

  addUser(text: string): void {
    const id = `u_${Date.now()}`;
    this.messages.push({
      id,
      role: "user",
      text,
      status: "complete",
      ts: Date.now(),
    });
  }

  startAssistantTurn(turnId: string, agent: string): void {
    this.inflightTurnId = turnId;
    this.messages.push({
      id: turnId,
      role: "assistant",
      text: "",
      status: "streaming",
      agent,
      ts: Date.now(),
    });
  }

  /**
   * Append a text delta to the in-flight assistant bubble.
   *
   * Bubble id is `assistant_<messageId>` when the SDK has provided a message
   * id (the normal case) — that matches the id `extractBlocks` synthesizes
   * for the same content when reading the canonical JSONL row from DB, so a
   * page refresh mid-stream lands on the same bubble instead of duplicating.
   *
   * Falls back to `<turnId>` on the very first delta before message_start
   * has fired (rare). When messageId arrives later, we still find the bubble
   * by the (turnId-shaped) id we created the first time and keep appending.
   *
   * Idempotent on already-finalized bubbles: if the SSE event is a replay of
   * a turn that's now complete in DB, no-op.
   */
  appendDelta(turnId: string, delta: string, messageId?: string): void {
    const id = messageId ? `assistant_${messageId}` : turnId;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant") continue;
      if (m.id === id || m.id === turnId) {
        if (
          m.status === "complete" ||
          m.status === "aborted" ||
          m.status === "error"
        ) {
          return;
        }
        m.text += delta;
        m.turnId = turnId;
        return;
      }
    }
    this.messages.push({
      id,
      role: "assistant",
      text: delta,
      status: "streaming",
      turnId,
      ts: Date.now(),
    });
  }

  finishTurn(
    turnId: string,
    status: "complete" | "aborted" | "error",
  ): void {
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.id === turnId || m.turnId === turnId) {
        if (
          m.status === "complete" ||
          m.status === "aborted" ||
          m.status === "error"
        ) {
          continue;
        }
        m.status = status;
      }
    }
    if (this.inflightTurnId === turnId) this.inflightTurnId = null;
  }

  pushTool(toolId: string, toolName: string, input: unknown): void {
    const id = `t_${toolId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      toolId,
      toolName,
      input,
      ts: Date.now(),
    });
  }

  /** Lazy-create: if the tool block hasn't been pushed yet (e.g. start was
   * evicted from the SSE ring), push it now. Idempotent on `done`/`error`. */
  setToolInput(toolId: string, input: unknown): void {
    const id = `t_${toolId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.input = input;
        return;
      }
    }
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      toolId,
      input,
      ts: Date.now(),
    });
  }

  /** Lazy-create + idempotent: SSE replay shouldn't overwrite a tool block
   * already finalized from DB. */
  finishTool(toolId: string, status: "ok" | "error", output?: string): void {
    const id = `t_${toolId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.status = status === "ok" ? "done" : "error";
        if (output !== undefined) m.output = output;
        return;
      }
    }
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: status === "ok" ? "done" : "error",
      toolId,
      output,
      ts: Date.now(),
    });
  }

  pushThinking(blockId: string): void {
    const id = `th_${blockId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.messages.push({
      id,
      role: "thinking",
      text: "",
      status: "running",
      blockId,
      ts: Date.now(),
    });
  }

  /** Lazy-create + idempotent. Mirrors appendDelta semantics for thinking. */
  appendThinking(blockId: string, delta: string): void {
    const id = `th_${blockId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.text += delta;
        return;
      }
    }
    this.messages.push({
      id,
      role: "thinking",
      text: delta,
      status: "running",
      blockId,
      ts: Date.now(),
    });
  }

  finishThinking(blockId: string): void {
    const id = `th_${blockId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.status = "done";
        return;
      }
    }
    this.messages.push({
      id,
      role: "thinking",
      text: "",
      status: "done",
      blockId,
      ts: Date.now(),
    });
  }

  async loadAgentTurns(agent: string): Promise<void> {
    // Clear immediately so switching agents doesn't briefly show the prior
    // agent's messages while turns are fetching.
    this.messages = [];
    this.oldestDbId = null;
    this.reachedOldest = false;
    try {
      const r = await fetch(`/api/agents/${agent}/turns?limit=50`);
      if (!r.ok) return;
      const turns = (await r.json()) as TurnRow[];
      this.messages = parseTurns(turns, agent);
      this.oldestDbId = oldestDbTurnId(turns);
      if (turns.length === 0) this.reachedOldest = true;
    } catch {
      // ignore network errors
    }
  }

  /**
   * Fetch and prepend the next older page of turns. Idempotent on re-entry
   * via `loadingOlder`. Stops once a fetch returns empty (`reachedOldest`).
   */
  async loadOlderTurns(): Promise<void> {
    if (this.loadingOlder || this.reachedOldest) return;
    if (this.oldestDbId === null) return;
    const agent = this.focusedAgent;
    const beforeId = this.oldestDbId;
    this.loadingOlder = true;
    try {
      const r = await fetch(
        `/api/agents/${agent}/turns?limit=50&beforeId=${beforeId}`,
      );
      if (!r.ok) return;
      const turns = (await r.json()) as TurnRow[];
      if (turns.length === 0) {
        this.reachedOldest = true;
        return;
      }
      const older = parseTurns(turns, agent);
      // Prepend, dedup-by-id (SSE may have surfaced something we now also
      // see in DB).
      const seen = new Set(this.messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      this.messages = [...fresh, ...this.messages];
      this.oldestDbId = oldestDbTurnId(turns);
    } catch {
      // ignore
    } finally {
      this.loadingOlder = false;
    }
  }

  applyEvent(event: WireEvent): void {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;

    switch (event.type) {
      case "turn_started":
        // Don't pre-mount the assistant bubble. Thinking blocks frequently
        // arrive *before* the first text_delta, and pre-mounting forces them
        // visually below the (empty) bubble. `appendDelta` lazily creates
        // the bubble when the first text token arrives, after any preceding
        // thinking/tool blocks have already been pushed.
        if (event.agent === this.focusedAgent) {
          this.inflightTurnId = event.turn_id;
        }
        break;
      case "text_delta":
        if (event.agent !== this.focusedAgent) break;
        this.appendDelta(event.turn_id, event.text, event.message_id);
        break;
      case "tool_use_start":
        if (event.agent !== this.focusedAgent) break;
        this.pushTool(event.tool_id, event.tool_name, event.input);
        break;
      case "tool_use_input":
        if (event.agent !== this.focusedAgent) break;
        this.setToolInput(event.tool_id, event.input);
        break;
      case "tool_use_end":
        if (event.agent !== this.focusedAgent) break;
        this.finishTool(event.tool_id, event.status, event.output);
        break;
      case "thinking_start":
        if (event.agent !== this.focusedAgent) break;
        this.pushThinking(event.block_id);
        break;
      case "thinking_delta":
        if (event.agent !== this.focusedAgent) break;
        this.appendThinking(event.block_id, event.text);
        break;
      case "thinking_end":
        if (event.agent !== this.focusedAgent) break;
        this.finishThinking(event.block_id);
        break;
      case "turn_done":
        if (event.agent !== this.focusedAgent) break;
        this.finishTurn(event.turn_id, event.status);
        break;
      case "error":
        if (event.agent !== this.focusedAgent) break;
        if (event.turn_id) this.finishTurn(event.turn_id, "error");
        break;
      case "agent_lifecycle":
        // Attach the spawn message to the SPAWNER's chat, not the focused
        // agent's. Without parentName we can't route reliably, so only render
        // it when the focused agent is the spawner.
        if (
          event.event === "spawn" &&
          event.parentName === this.focusedAgent &&
          this.inflightTurnId
        ) {
          this.appendDelta(
            this.inflightTurnId,
            `\n\n> 🤖 Spawned **${event.agentType}** \`${event.agent}\` — _click in the sidebar to switch focus_\n\n`,
          );
        }
        break;
      case "agent_status":
        for (const a of this.agents) {
          if (a.name === event.agent) a.status = event.status;
        }
        break;
      default:
        break;
    }
  }
}

export const chat = new ChatState();

export interface TurnRow {
  id: number;
  role: string;
  kind: string;
  contentJson: string;
  ts: number;
}

/**
 * Parse JSONL turn rows into ChatMessage[]. Used by both the active loader
 * (which writes into the global `chat.messages`) and the read-only past-
 * session view (which keeps its own array). Stable bubble ids ensure SSE
 * replays on top of an active load don't duplicate content.
 */
export function parseTurns(turns: TurnRow[], agent: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sorted = [...turns].reverse();
  const toolByToolId = new Map<string, ChatMessage>();

  for (const t of sorted) {
    const blocks = extractBlocks(t.contentJson);
    for (const b of blocks) {
      if (b.kind === "text") {
        const id = b.messageId
          ? `assistant_${b.messageId}`
          : `db_${t.id}_${b.index}`;
        out.push({
          id,
          role: t.role === "user" ? "user" : "assistant",
          text: b.text,
          status: "complete",
          ts: t.ts,
          agent,
          dbTurnId: t.id,
        });
      } else if (b.kind === "tool_use") {
        const msg: ChatMessage = {
          id: `t_${b.toolId}`,
          role: "tool",
          text: "",
          status: "running",
          toolId: b.toolId,
          toolName: b.toolName,
          input: b.input,
          ts: t.ts,
          dbTurnId: t.id,
        };
        out.push(msg);
        toolByToolId.set(b.toolId, msg);
      } else if (b.kind === "tool_result") {
        const msg = toolByToolId.get(b.toolId);
        if (msg) {
          msg.status = b.isError ? "error" : "done";
          msg.output = b.text;
        } else {
          out.push({
            id: `t_${b.toolId}`,
            role: "tool",
            text: "",
            status: b.isError ? "error" : "done",
            toolId: b.toolId,
            toolName: "(unknown)",
            output: b.text,
            ts: t.ts,
            dbTurnId: t.id,
          });
        }
      } else if (b.kind === "thinking") {
        const blockId = b.messageId
          ? `${b.messageId}_${b.index}`
          : `db_${t.id}_${b.index}`;
        out.push({
          id: `th_${blockId}`,
          role: "thinking",
          text: b.text,
          status: "done",
          blockId,
          ts: t.ts,
          dbTurnId: t.id,
        });
      }
    }
  }
  return out;
}

/** Returns the smallest `id` among the given turn rows, or null if empty. */
function oldestDbTurnId(turns: TurnRow[]): number | null {
  let oldest: number | null = null;
  for (const t of turns) {
    if (oldest === null || t.id < oldest) oldest = t.id;
  }
  return oldest;
}

/** Extracted block from a JSONL entry, ordered as it appears in the file. */
type ExtractedBlock =
  | { kind: "text"; index: number; text: string; messageId?: string }
  | {
      kind: "tool_use";
      index: number;
      toolId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      index: number;
      toolId: string;
      text: string;
      isError: boolean;
    }
  | { kind: "thinking"; index: number; text: string; messageId?: string };

/**
 * Extract content blocks from a Claude-SDK JSONL entry. Handles both the
 * canonical message shape (with `message.content[]`) and the simpler
 * streaming-row shape (`{text: "..."}`).
 */
function extractBlocks(contentJson: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return out;
  }
  const j = parsed as {
    text?: string;
    message?: {
      id?: string;
      content?: Array<{
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>;
    };
  };
  if (typeof j.text === "string" && j.text.length > 0) {
    out.push({ kind: "text", index: 0, text: j.text });
    return out;
  }
  const messageId = j.message?.id;
  if (Array.isArray(j.message?.content)) {
    j.message.content.forEach((b, idx) => {
      if (b.type === "text" && typeof b.text === "string") {
        out.push({ kind: "text", index: idx, text: b.text, messageId });
      } else if (b.type === "tool_use") {
        out.push({
          kind: "tool_use",
          index: idx,
          toolId: b.id ?? `idx_${idx}`,
          toolName: b.name ?? "",
          input: b.input,
        });
      } else if (b.type === "tool_result") {
        out.push({
          kind: "tool_result",
          index: idx,
          toolId: b.tool_use_id ?? "",
          text: stringifyToolResult(b.content),
          isError: b.is_error === true,
        });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        out.push({ kind: "thinking", index: idx, text: b.thinking, messageId });
      }
    });
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: string }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}
