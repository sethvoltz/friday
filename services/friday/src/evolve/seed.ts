import { getAgent, registerScheduledAgent } from "../sessions/registry.js";
import { computeNextRun } from "../scheduler/scheduler.js";
import { log } from "../log.js";

/**
 * Idempotently seed Friday's two evolve meta-agents. If a given agent already
 * exists in the registry (regardless of status), do nothing — the user is
 * free to pause, retune, or delete it.
 *
 * - `scheduled-meta-daily`  runs at 4am, scans the last 24h, escalates critical.
 * - `scheduled-meta-weekly` runs Sunday 5am, deep-clusters open backlog and
 *   re-scans the last 7 days for slow-burn patterns the daily run misses.
 */
const META_DAILY_NAME = "scheduled-meta-daily";
const META_DAILY_CRON = "0 4 * * *"; // 4am local

const META_WEEKLY_NAME = "scheduled-meta-weekly";
const META_WEEKLY_CRON = "0 5 * * 0"; // Sun 5am local

const DAILY_TASK_PROMPT = [
  "You are Friday's daily evolve analyst.",
  "",
  "Run the deterministic evolve pipeline against the last 24 hours of",
  "telemetry, then summarize what changed in this run. The pipeline writes",
  "proposals to ~/.friday/evolve/proposals/ — your job is to invoke it",
  "and escalate critical items.",
  "",
  "Steps:",
  "1. Run: `FRIDAY_AGENT_NAME=scheduled-meta-daily friday evolve scan --since-hours 24`",
  "   The JSON output includes a `promotedToCritical` count.",
  "2. Run: `friday evolve list --status critical`",
  "3. If there are critical proposals, send ONE urgent mail to the orchestrator:",
  "   `mail_send` to=\"orchestrator\" priority=\"urgent\"",
  "   subject: \"Critical evolve proposals (<N>)\"",
  "   body: a terse list — for each critical proposal include id, title, and the",
  "         primary signal (e.g. `agent_health_crashed × 7`). The orchestrator has",
  "         `evolve_show` and `evolve_approve` — it will fetch details on its own.",
  "   Do NOT mail if `promotedToCritical` is 0 and no existing criticals are open.",
  "4. Write a short summary to <stateDir>/state.md (run timestamp, counts, any",
  "   critical ids you escalated). One line is fine when nothing happened.",
  "",
  "Do not invent proposals. Do not edit proposals directly. Do not mail the",
  "orchestrator unless there are critical items — daily-digest spam is not the",
  "goal.",
].join("\n");

const WEEKLY_TASK_PROMPT = [
  "You are Friday's weekly evolve analyst.",
  "",
  "The daily analyst handles per-day triage. Your job is the deeper pass:",
  "re-scan a wider window, then re-cluster the open backlog so related",
  "proposals stop appearing in isolation.",
  "",
  "Steps:",
  "1. Run: `FRIDAY_AGENT_NAME=scheduled-meta-weekly friday evolve scan --since-hours 168`",
  "   This pulls 7 days of daemon, usage, transcript, and feedback signals.",
  "2. Run: `friday evolve cluster`",
  "   Jaccard merge attaches `clusterId` to proposals whose signal sets overlap.",
  "3. Run: `friday evolve list --status critical`",
  "4. If there are critical proposals, send ONE urgent mail to the orchestrator:",
  "   `mail_send` to=\"orchestrator\" priority=\"urgent\"",
  "   subject: \"Weekly evolve digest — <N> critical, <C> clusters\"",
  "   body: a terse list of critical ids + the largest clusters (cluster id +",
  "         size + title). The orchestrator has `evolve_show` / `evolve_approve`.",
  "5. Write a short summary to <stateDir>/state.md (window, signal counts,",
  "   clusters touched, criticals escalated).",
  "",
  "Do not invent proposals. Do not edit proposals directly. Skip the mail when",
  "there's nothing critical and no new clusters.",
].join("\n");

const DAILY_SYSTEM_PROMPT_SUFFIX = [
  "You are scheduled-meta-daily, the evolve analyst for Friday.",
  "Your only job is to run the `friday evolve` CLI and summarize results.",
  "Never act on behalf of the user. Never propose changes outside the pipeline.",
].join("\n");

const WEEKLY_SYSTEM_PROMPT_SUFFIX = [
  "You are scheduled-meta-weekly, the deep evolve analyst for Friday.",
  "Your only job is to run `friday evolve scan + cluster` and summarize results.",
  "Never act on behalf of the user. Never propose changes outside the pipeline.",
].join("\n");

export interface SeedOptions {
  cwd: string;
}

interface SeedSpec {
  name: string;
  cron: string;
  taskPrompt: string;
  systemPromptSuffix: string;
}

export function seedScheduledMetaAgents(opts: SeedOptions): void {
  const specs: SeedSpec[] = [
    {
      name: META_DAILY_NAME,
      cron: META_DAILY_CRON,
      taskPrompt: DAILY_TASK_PROMPT,
      systemPromptSuffix: DAILY_SYSTEM_PROMPT_SUFFIX,
    },
    {
      name: META_WEEKLY_NAME,
      cron: META_WEEKLY_CRON,
      taskPrompt: WEEKLY_TASK_PROMPT,
      systemPromptSuffix: WEEKLY_SYSTEM_PROMPT_SUFFIX,
    },
  ];

  for (const spec of specs) {
    if (getAgent(spec.name)) {
      log("debug", "meta_seed_skip_existing", { agent: spec.name });
      continue;
    }

    try {
      const schedule = { cron: spec.cron };
      const nextRunAt = computeNextRun(schedule);

      registerScheduledAgent(
        spec.name,
        schedule,
        spec.taskPrompt,
        opts.cwd,
        nextRunAt ? nextRunAt.toISOString() : null,
        spec.systemPromptSuffix
      );

      log("info", "meta_seed_created", { agent: spec.name, cron: spec.cron });
    } catch (err) {
      // Never let a seed failure block daemon startup.
      log("error", "meta_seed_failed", {
        agent: spec.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
