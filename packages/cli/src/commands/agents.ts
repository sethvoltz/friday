import { defineCommand } from "citty";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DaemonClient } from "../lib/api.js";
import type { AgentEntry } from "@friday/shared";

export const agentsCommand = defineCommand({
  meta: { name: "agents", description: "Inspect and control agents" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List agents" },
      async run() {
        const c = new DaemonClient();
        const agents = await c.get<AgentEntry[]>("/api/agents");
        for (const a of agents) {
          const dot =
            a.status === "working"
              ? pc.green("●")
              : a.status === "idle"
                ? pc.yellow("●")
                : a.status === "archived"
                  ? pc.dim("●")
                  : pc.red("●");
          console.log(`  ${dot} ${a.type.padEnd(12)} ${a.name}`);
        }
      },
    }),
    inspect: defineCommand({
      meta: { name: "inspect", description: "Show agent detail" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const a = await c.get<AgentEntry>(`/api/agents/${args.name}`);
        console.log(JSON.stringify(a, null, 2));
      },
    }),
    archive: defineCommand({
      // Archives the agent: stops it from receiving work, marks status=archived,
      // and for builders also removes the worktree + force-deletes the branch.
      // Sessions persist in perpetuity. Irreversible for builders (worktree
      // cleanup); the CLI prompts for a literal "yes" unless --force is passed.
      meta: {
        name: "archive",
        description:
          "Archive an agent (stop work; for builders also free the worktree)",
      },
      args: {
        name: { type: "positional", required: true },
        force: {
          type: "boolean",
          default: false,
          description: "Skip the interactive confirmation prompt",
        },
      },
      async run({ args }) {
        const c = new DaemonClient();
        if (!args.force) {
          const rl = createInterface({ input: stdin, output: stdout });
          const answer = await rl.question(
            pc.yellow(
              `Archive "${args.name}"? For builders this also wipes ~/.friday/workspaces/${args.name}/ and force-deletes friday/${args.name}. Type "yes" to confirm: `,
            ),
          );
          rl.close();
          if (answer.trim().toLowerCase() !== "yes") {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        const res = await c.post<{ ok: boolean; workspacePath?: string }>(
          `/api/agents/${args.name}/archive`,
          {},
        );
        if (res.workspacePath) {
          console.log(pc.green(`archived ${args.name} (removed ${res.workspacePath})`));
        } else {
          console.log(pc.green(`archived ${args.name}`));
        }
      },
    }),
  },
});
