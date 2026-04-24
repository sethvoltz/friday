import type { AgentStatus, RegistryEntry } from "./agents.js";
import type { UsageEntry } from "./usage.js";

/** Base fields assigned by EventBus on publish */
export interface BaseEvent {
  seq: number;
  ts: string;
}

/** The payload passed to eventBus.publish() — seq and ts are assigned automatically */
export type FridayEventPayload =
  | { type: "agent:status"; agentName: string; status: AgentStatus }
  | { type: "agent:created"; agentName: string; entry: RegistryEntry }
  | { type: "agent:destroyed"; agentName: string }
  | { type: "session:updated"; agentName: string; sessionId: string }
  | { type: "turn:streaming"; agentName: string; sessionId: string; text: string }
  | { type: "turn:complete"; agentName: string; sessionId: string }
  | { type: "usage:logged"; entry: UsageEntry };

/** Full event with base fields — returned by EventBus after publish */
export type FridayEvent = BaseEvent & FridayEventPayload;
