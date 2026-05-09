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
  const protocols = protocolNames
    .map((name) => {
      const p = join(dir, "protocols", `${name}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { constitution, soul, agentBase, protocols };
}

/**
 * Compose the system prompt in the canonical order:
 *   1. CONSTITUTION
 *   2. SOUL
 *   3. agents/<type>
 *   4. protocols/*
 */
export function composeSystemPrompt(stack: PromptStack): string {
  return [stack.constitution, stack.soul, stack.agentBase, stack.protocols]
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
