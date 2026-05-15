import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUL_PATH } from "../config.js";

/**
 * Find the bundled prompts directory. At runtime we live at
 * `dist/prompts/loader.js`; the markdown files were copied into `dist/prompts/`
 * by the build's post-step. In tests we run from `src/prompts/loader.ts`.
 */
function bundledPromptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Same dir contains the .md files (they sit alongside this loader).
  return here;
}

export interface PromptStack {
  /** CONSTITUTION.md — inviolate rules, all agents. */
  constitution: string;
  /** SOUL.md — identity, user-overridable. */
  soul: string;
  /** agents/<type>.md — per-role behavior. */
  agentBase: string;
  /** Concatenated protocols/*.md the agent's type opts into. */
  protocols: string;
}

export type AgentBaseKey =
  | "orchestrator"
  | "builder"
  | "helper"
  | "scheduled"
  | "bare";

/**
 * Protocols loaded automatically for an agent type, regardless of the
 * `protocolNames` argument passed to `readPromptStack`. Memory is system
 * capability — every agent that can write to the memory store needs the
 * framework. Builders are read-only and helpers are scoped, so they pick up
 * memory recall behavior from their own agent prompts without the full
 * save-side guidance.
 */
const DEFAULT_PROTOCOLS_BY_TYPE: Record<AgentBaseKey, readonly string[]> = {
  orchestrator: ["memory"],
  scheduled: ["memory"],
  builder: [],
  helper: [],
  bare: ["memory"],
};

export function readPromptStack(
  agentType: AgentBaseKey,
  protocolNames: string[] = [],
): PromptStack {
  const dir = bundledPromptsDir();
  const constitution = readFileSync(join(dir, "CONSTITUTION.md"), "utf8");
  const soul = readSoul();
  const agentBase = readFileSync(
    join(dir, "agents", `${agentType}.md`),
    "utf8",
  );
  // Merge type-default protocols with caller-requested ones, dedup, preserve order.
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...DEFAULT_PROTOCOLS_BY_TYPE[agentType], ...protocolNames]) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  const protocols = merged
    .map((name) => {
      const p = join(dir, "protocols", `${name}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { constitution, soul, agentBase, protocols };
}

export interface AgentIdentity {
  agentName: string;
  agentType: AgentBaseKey;
  parentName?: string;
}

/**
 * Identity preamble. Anchors the child on its literal name + parent name so it
 * never has to guess "who am I, who spawned me" — semantic substitutions like
 * `mail_send({to: "orchestrator"})` (a role, not a name) get dropped silently.
 * See FRI-11.
 */
export function renderIdentityBlock(identity: AgentIdentity): string {
  const lines: string[] = ["# Identity"];
  lines.push(`- Your agent name is \`${identity.agentName}\`.`);
  lines.push(`- Your agent type is \`${identity.agentType}\`.`);
  if (identity.parentName) {
    lines.push(`- Your parent agent is named \`${identity.parentName}\`.`);
    lines.push(
      `- To send mail back, use \`mail_send({to: "${identity.parentName}", ...})\` — or the symbolic \`mail_send({to: "parent", ...})\`. Never use role names like \`orchestrator\`, \`builder\`, \`helper\` — the daemon will reject them.`,
    );
  } else {
    lines.push(
      "- You have no parent agent. Mail recipients must be literal agent names (run `agent_list` to discover them).",
    );
  }
  return lines.join("\n");
}

/**
 * Compose the system prompt in the canonical order:
 *   1. CONSTITUTION
 *   2. SOUL
 *   3. Identity (when provided — FRI-11)
 *   4. agents/<type>
 *   5. protocols/*
 */
export function composeSystemPrompt(
  stack: PromptStack,
  identity?: AgentIdentity,
): string {
  const identityBlock = identity ? renderIdentityBlock(identity) : "";
  return [
    stack.constitution,
    stack.soul,
    identityBlock,
    stack.agentBase,
    stack.protocols,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** First-boot copy: if ~/.friday/SOUL.md doesn't exist, install the default. */
export function ensureSoul(): void {
  if (existsSync(SOUL_PATH)) return;
  const dir = bundledPromptsDir();
  const defaultSoul = readFileSync(
    join(dir, "fragments", "soul.default.md"),
    "utf8",
  );
  writeFileSync(SOUL_PATH, defaultSoul);
}

function readSoul(): string {
  if (existsSync(SOUL_PATH)) return readFileSync(SOUL_PATH, "utf8");
  // Fallback to bundled default.
  const dir = bundledPromptsDir();
  return readFileSync(join(dir, "fragments", "soul.default.md"), "utf8");
}
