import { loadSkills, type Skill } from "@friday/shared";

export interface SystemCommand {
  name: string;
  description: string;
  destructive?: boolean;
}

export const SYSTEM_COMMANDS: SystemCommand[] = [
  { name: "kill", description: "Kill an agent (`/kill <agent>`)", destructive: true },
  { name: "restart", description: "Restart the daemon", destructive: true },
  { name: "status", description: "Show daemon + agent status" },
  { name: "inspect", description: "Show agent detail (`/inspect <agent>`)" },
  { name: "reset-context", description: "Wipe orchestrator context (memory persists)", destructive: true },
  { name: "jump", description: "Jump to date or term (`/jump <date|term>`)" },
  { name: "scratch", description: "Spawn a fresh bare agent (`/scratch [topic]`)" },
];

export function commandsApi(): {
  system: SystemCommand[];
  skills: Array<{ name: string; description: string; source: string }>;
} {
  const skills: Skill[] = loadSkills();
  return {
    system: SYSTEM_COMMANDS,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    })),
  };
}
