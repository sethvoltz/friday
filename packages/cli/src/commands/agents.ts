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
                : a.status === "killed"
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
    kill: defineCommand({
      meta: { name: "kill", description: "Kill an agent" },
      args: { name: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        await c.post(`/api/agents/${args.name}/kill`, {});
        console.log(pc.green(`killed ${args.name}`));
      },
    }),
    "rm-workspace": defineCommand({
      // FIX_FORWARD 6.4: irreversible. The CLI prompts for a literal "yes"
      // unless --force is passed. The daemon-side endpoint still re-checks
      // path containment, so a bypass here can't escape ~/.friday/workspaces/.
      meta: {
        name: "rm-workspace",
        description: "Permanently delete a builder's workspace folder",
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
              `Delete workspace for "${args.name}"? This wipes ~/.friday/workspaces/${args.name}/. Type "yes" to confirm: `,
            ),
          );
          rl.close();
          if (answer.trim().toLowerCase() !== "yes") {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        const res = await c.del<{ ok: boolean; path: string }>(
          `/api/agents/${args.name}/workspace`,
        );
        console.log(pc.green(`removed ${res.path}`));
      },
    }),
  },
});
