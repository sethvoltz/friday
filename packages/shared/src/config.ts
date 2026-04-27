import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const FRIDAY_DIR = join(homedir(), ".friday");
export const CONFIG_PATH = join(FRIDAY_DIR, "config.json");
export const ENV_PATH = join(FRIDAY_DIR, ".env");
export const SESSIONS_DIR = join(FRIDAY_DIR, "sessions");
export const USAGE_LOG_PATH = join(FRIDAY_DIR, "usage.jsonl");
export const DAEMON_LOG_PATH = join(FRIDAY_DIR, "daemon.jsonl");
export const EVOLVE_DIR = join(FRIDAY_DIR, "evolve");

export interface SlackConfig {
  orchestratorChannelId: string;
}

export interface AgentConfig {
  workingDirectory: string;
  allowedTools: string[];
  permissionMode: string;
  model: string;
  systemPrompt?: string;
}

export interface EmojiConfig {
  processing: string;
  queued: string;
  error: string;
  complete: string | null;
  thinking: string;
  toolCoding: string;
  toolWeb: string;
  toolGeneric: string;
  compacting: string;
}

export interface SlackFormattingConfig {
  maxMessageLength: number;
  streamingEnabled: boolean;
  thinkingIndicatorDelaySec: number;
  emojiReactions: EmojiConfig;
}

export interface MonitoringConfig {
  usageLogFile: string;
  warnAtPercentOfDailyLimit: number;
}

export interface EventServerConfig {
  port: number;
}

export interface EvolveConfig {
  /** Score (0-100) at or above which a proposal is promoted to "critical". */
  criticalScore: number;
  /** Signal frequency at or above which a proposal is promoted to "critical". */
  criticalFrequency: number;
}

export interface FridayConfig {
  slack: SlackConfig;
  agent: AgentConfig;
  independentAgent?: Partial<AgentConfig>;
  slack_formatting: SlackFormattingConfig;
  monitoring: MonitoringConfig;
  eventServer: EventServerConfig;
  evolve: EvolveConfig;
}

const DEFAULT_CONFIG: FridayConfig = {
  slack: {
    orchestratorChannelId: "",
  },
  agent: {
    workingDirectory: join(FRIDAY_DIR, "working"),
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "auto-accept",
    model: "claude-sonnet-4-6",
  },
  independentAgent: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "auto-accept",
  },
  slack_formatting: {
    maxMessageLength: 4000,
    streamingEnabled: true,
    thinkingIndicatorDelaySec: 30,
    emojiReactions: {
      processing: "eyes",
      queued: "clock1",
      error: "x",
      complete: null,
      thinking: "thinking_face",
      toolCoding: "technologist",
      toolWeb: "zap",
      toolGeneric: "fire",
      compacting: "writing_hand",
    },
  },
  monitoring: {
    usageLogFile: USAGE_LOG_PATH,
    warnAtPercentOfDailyLimit: 80,
  },
  eventServer: {
    port: 7444,
  },
  evolve: {
    criticalScore: 80,
    criticalFrequency: 5,
  },
};

export function loadConfig(): FridayConfig {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const userConfig = JSON.parse(raw) as Partial<FridayConfig>;
  return {
    slack: { ...DEFAULT_CONFIG.slack, ...userConfig.slack },
    agent: { ...DEFAULT_CONFIG.agent, ...userConfig.agent },
    independentAgent: userConfig.independentAgent !== undefined
      ? { ...DEFAULT_CONFIG.independentAgent, ...userConfig.independentAgent }
      : DEFAULT_CONFIG.independentAgent,
    slack_formatting: {
      ...DEFAULT_CONFIG.slack_formatting,
      ...userConfig.slack_formatting,
      emojiReactions: {
        ...DEFAULT_CONFIG.slack_formatting.emojiReactions,
        ...userConfig.slack_formatting?.emojiReactions,
      },
    },
    monitoring: { ...DEFAULT_CONFIG.monitoring, ...userConfig.monitoring },
    eventServer: { ...DEFAULT_CONFIG.eventServer, ...userConfig.eventServer },
    evolve: { ...DEFAULT_CONFIG.evolve, ...userConfig.evolve },
  };
}

/**
 * Read whatever's currently on disk at CONFIG_PATH (raw, no defaults applied).
 * Returns {} when the file doesn't exist. Used by the evolve auto-apply path
 * so we merge into the user's actual config rather than into defaults — that
 * way the rewritten file doesn't suddenly grow every default field.
 */
export function readRawConfig(): Partial<FridayConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<FridayConfig>;
}

/**
 * Write the user's config back to CONFIG_PATH. The caller is responsible for
 * supplying a fully-formed object — this function does not merge defaults.
 * Creates the directory if it doesn't exist.
 */
export function writeConfig(config: Partial<FridayConfig>): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
