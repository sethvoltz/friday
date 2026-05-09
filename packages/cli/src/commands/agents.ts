import { defineCommand } from "citty";
import pc from "picocolors";
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
  },
});
