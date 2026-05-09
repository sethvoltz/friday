import type { AgentType } from "./agents.js";

export interface UsageEntry {
  ts: string;
  agentName: string | null;
  agentType: AgentType | null;
  sessionId: string;
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
}
