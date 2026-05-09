import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR } from "./config.js";
import type { AgentTypeName } from "./config.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Empty/omitted = available to every agent type. */
  agents?: AgentTypeName[];
  /** Optional per-turn restriction subset. */
  allowed_tools?: string[];
  /** Default true; built-ins set false for predictability. */
  auto_invoke?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  agents: AgentTypeName[] | null;
  allowedTools: string[] | null;
  autoInvoke: boolean;
  body: string;
  source: "builtin" | "user";
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function bundledSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/prompts/loader.js → dist/prompts/skills/
  return join(here, "skills");
}

export function loadSkills(): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();

  // User skills first — they shadow built-ins on collision.
  if (existsSync(SKILLS_DIR)) {
    for (const file of readdirSync(SKILLS_DIR)) {
      if (!file.endsWith(".md")) continue;
      const path = join(SKILLS_DIR, file);
      const skill = readSkill(path, "user");
      if (skill) {
        out.push(skill);
        seen.add(skill.name);
      }
    }
  }

  // Built-ins that don't conflict with user files.
  const builtinDir = bundledSkillsDir();
  if (existsSync(builtinDir)) {
    for (const file of readdirSync(builtinDir)) {
      if (!file.endsWith(".md")) continue;
      const skill = readSkill(join(builtinDir, file), "builtin");
      if (!skill) continue;
      if (seen.has(skill.name)) continue;
      out.push(skill);
    }
  }

  return out;
}

function readSkill(filePath: string, source: "builtin" | "user"): Skill | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const m = FRONTMATTER_RE.exec(raw);
    if (!m) return null;
    const fm = parseFrontmatter(m[1]) as Partial<SkillFrontmatter>;
    if (!fm.name || !fm.description) return null;
    const autoInvokeDefault = source === "builtin" ? false : true;
    return {
      name: fm.name,
      description: fm.description,
      agents: fm.agents && fm.agents.length > 0 ? fm.agents : null,
      allowedTools: fm.allowed_tools && fm.allowed_tools.length > 0 ? fm.allowed_tools : null,
      autoInvoke: fm.auto_invoke ?? autoInvokeDefault,
      body: m[2].trim(),
      source,
      filePath,
    };
  } catch {
    return null;
  }
}

function parseFrontmatter(s: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of s.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (v.startsWith("[")) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else if (v === "true") {
      out[k] = true;
    } else if (v === "false") {
      out[k] = false;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function skillsForAgent(skills: Skill[], type: AgentTypeName): Skill[] {
  return skills.filter((s) => !s.agents || s.agents.includes(type));
}
