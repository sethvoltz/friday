import { defineCommand } from "citty";
import pc from "picocolors";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DaemonClient } from "../lib/api.js";

interface ScheduleRow {
  name: string;
  cron: string | null;
  runAt: string | null;
  taskPrompt: string;
  paused: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
}

function fmtTs(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function readPrompt(opts: {
  prompt: string | undefined;
  promptFile: string | undefined;
}): string {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new Error("pass at most one of --prompt / --prompt-file");
  }
  if (opts.prompt !== undefined) return opts.prompt;
  if (opts.promptFile === "-") return readFileSync(0, "utf8");
  if (opts.promptFile) return readFileSync(opts.promptFile, "utf8");
  if (!input.isTTY) return readFileSync(0, "utf8");
  throw new Error(
    "no prompt provided; pass --prompt, --prompt-file <path>, or pipe to stdin",
  );
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  const ans = await rl.question(prompt);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

export const schedulesCommand = defineCommand({
  meta: {
    name: "schedules",
    description: "Inspect and mutate scheduled agents",
  },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List schedules" },
      async run() {
        const c = new DaemonClient();
        const rows = await c.get<ScheduleRow[]>("/api/schedules");
        if (rows.length === 0) {
          console.log(pc.dim("No schedules."));
          return;
        }
        for (const r of rows) {
          const status = r.paused ? pc.yellow("paused") : pc.green("active");
          const when = r.cron ?? r.runAt ?? "—";
          console.log(
            `  ${r.name.padEnd(28)} ${status.padEnd(18)} ${pc.dim(when.padEnd(18))}  next=${fmtTs(r.nextRunAt)}`,
          );
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Print one schedule's full state" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const row = await c.get<ScheduleRow>(
          `/api/schedules/${encodeURIComponent(args.name as string)}`,
        );
        console.log(JSON.stringify(row, null, 2));
      },
    }),
    create: defineCommand({
      // FIX_FORWARD 6.9: `create` is a thin wrapper around the daemon's
      // upsert endpoint; passing an existing name updates it.
      meta: {
        name: "create",
        description: "Create or update a schedule",
      },
      args: {
        name: { type: "positional", required: true },
        cron: { type: "string" },
        "run-at": {
          type: "string",
          description: "One-shot ISO timestamp (use instead of --cron)",
        },
        prompt: { type: "string", description: "Inline task prompt" },
        "prompt-file": {
          type: "string",
          description: "Path to task prompt file (use `-` for stdin)",
        },
        paused: { type: "boolean", default: false },
      },
      async run({ args }) {
        const cron = args.cron as string | undefined;
        const runAt = args["run-at"] as string | undefined;
        if (!cron && !runAt) {
          console.error(pc.red("pass --cron <expr> or --run-at <iso>"));
          process.exit(1);
        }
        const taskPrompt = readPrompt({
          prompt: args.prompt as string | undefined,
          promptFile: args["prompt-file"] as string | undefined,
        });
        const c = new DaemonClient();
        await c.post("/api/schedules", {
          name: args.name,
          cron,
          runAt,
          taskPrompt,
          paused: !!args.paused,
        });
        console.log(pc.green(`saved ${args.name}`));
      },
    }),
    pause: defineCommand({
      meta: { name: "pause", description: "Pause a schedule" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        await c.post(
          `/api/schedules/${encodeURIComponent(args.name as string)}/pause`,
          {},
        );
        console.log(pc.green(`paused ${args.name}`));
      },
    }),
    resume: defineCommand({
      meta: { name: "resume", description: "Resume a paused schedule" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        await c.post(
          `/api/schedules/${encodeURIComponent(args.name as string)}/resume`,
          {},
        );
        console.log(pc.green(`resumed ${args.name}`));
      },
    }),
    trigger: defineCommand({
      meta: {
        name: "trigger",
        description: "Fire a schedule immediately (out-of-band)",
      },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const r = await c.post<{ runId: string }>(
          `/api/schedules/${encodeURIComponent(args.name as string)}/trigger`,
          {},
        );
        console.log(pc.green(`triggered ${args.name} (run ${r.runId})`));
      },
    }),
    delete: defineCommand({
      meta: {
        name: "delete",
        description: "Delete a schedule (state.md / last-run.md stay on disk)",
      },
      args: {
        name: { type: "positional", required: true },
        force: {
          type: "boolean",
          default: false,
          description: "Skip confirmation",
        },
      },
      async run({ args }) {
        const name = args.name as string;
        if (!args.force) {
          const ok = await confirm(
            pc.yellow(`Delete schedule "${name}"? Type "yes" to confirm: `),
          );
          if (!ok) {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        const c = new DaemonClient();
        await c.del(`/api/schedules/${encodeURIComponent(name)}`);
        console.log(pc.green(`deleted ${name}`));
      },
    }),
  },
});
