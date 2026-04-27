import { getAgent, registerScheduledAgent } from "../sessions/registry.js";
import { computeNextRun } from "../scheduler/scheduler.js";
import { log } from "../log.js";

/**
 * Idempotently seed the daily meta-analysis agent. If it already exists in
 * the registry (regardless of status), do nothing — the user is free to
 * pause, retune, or delete it.
 *
 * Phase 1: only seeds the daily agent. The weekly deep-dive agent and the
 * dashboard surface land in later phases.
 */
const META_DAILY_NAME = "scheduled-meta-daily";
const META_DAILY_CRON = "0 4 * * *"; // 4am local

const TASK_PROMPT = [
  "You are Friday's daily evolve analyst.",
  "",
  "Run the deterministic evolve pipeline against the last 24 hours of",
  "telemetry, then summarize what changed in this run. The pipeline writes",
  "proposals to ~/.friday/evolve/proposals/ — your job is to invoke it",
  "and report.",
  "",
  "Steps:",
  "1. Run: `FRIDAY_AGENT_NAME=scheduled-meta-daily friday-evolve scan --since-hours 24`",
  "2. Run: `friday-evolve list --status critical`",
  "3. If there are critical proposals, write a short summary to <stateDir>/state.md.",
  "   Otherwise write a one-line 'no critical issues' note.",
  "",
  "Do not invent proposals. Do not edit files outside the state directory.",
  "Phase 1 is read-only beyond the proposals directory; later phases will",
  "let you mail the orchestrator about critical items.",
].join("\n");

const SYSTEM_PROMPT_SUFFIX = [
  "You are scheduled-meta-daily, the evolve analyst for Friday.",
  "Your only job is to run the friday-evolve CLI and summarize results.",
  "Never act on behalf of the user. Never propose changes outside the pipeline.",
].join("\n");

export interface SeedOptions {
  cwd: string;
}

export function seedScheduledMetaAgents(opts: SeedOptions): void {
  if (getAgent(META_DAILY_NAME)) {
    log("debug", "meta_seed_skip_existing", { agent: META_DAILY_NAME });
    return;
  }

  try {
    const schedule = { cron: META_DAILY_CRON };
    const nextRunAt = computeNextRun(schedule);

    registerScheduledAgent(
      META_DAILY_NAME,
      schedule,
      TASK_PROMPT,
      opts.cwd,
      nextRunAt ? nextRunAt.toISOString() : null,
      SYSTEM_PROMPT_SUFFIX
    );

    log("info", "meta_seed_created", { agent: META_DAILY_NAME, cron: META_DAILY_CRON });
  } catch (err) {
    // Never let a seed failure block daemon startup.
    log("error", "meta_seed_failed", {
      agent: META_DAILY_NAME,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
