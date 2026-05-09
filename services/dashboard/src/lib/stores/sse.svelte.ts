import type { WireEvent } from "@friday/shared";
import { chat } from "./chat.svelte";
import { bumpDashboardData } from "./dashboard-data.svelte";

const DASHBOARD_BUMP_TYPES = new Set([
  "turn_done",
  "agent_lifecycle",
  "agent_status",
  "schedule_fired",
]);

let es: EventSource | null = null;

class SseConnected {
  value = $state(false);
}
export const sseConnected = new SseConnected();

const HANDLED_TYPES = new Set([
  "turn_started",
  "text_delta",
  "tool_use_start",
  "tool_use_input",
  "tool_use_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "compaction_start",
  "compaction_end",
  "error",
  "turn_done",
  "agent_message",
  "agent_lifecycle",
  "agent_status",
  "mail_delivered",
  "schedule_fired",
  "evolve_critical",
  "system_banner",
]);

export function startSSE(): void {
  if (es) return;
  es = new EventSource("/api/events");
  es.onopen = () => {
    sseConnected.value = true;
    chat.connected = true;
    // Reset the per-event cursor on (re)connect — daemon restarts reset its
    // seq counter; a stale high lastSeq would filter every new event out.
    chat.lastSeq = 0;
  };
  es.onerror = () => {
    sseConnected.value = false;
    chat.connected = false;
  };
  for (const t of HANDLED_TYPES) {
    es.addEventListener(t, (e: MessageEvent) => {
      try {
        chat.applyEvent(JSON.parse(e.data) as WireEvent);
      } catch {
        /* ignore */
      }
      if (DASHBOARD_BUMP_TYPES.has(t)) bumpDashboardData();
    });
  }
}

export function stopSSE(): void {
  es?.close();
  es = null;
  sseConnected.value = false;
}
