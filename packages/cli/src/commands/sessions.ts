import { defineCommand } from "citty";
import { DaemonClient } from "../lib/api.js";

export const sessionsCommand = defineCommand({
  meta: { name: "sessions", description: "Inspect sessions" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List sessions" },
      async run() {
        const c = new DaemonClient();
        const rows = await c.get<unknown[]>("/api/sessions");
        console.log(JSON.stringify(rows, null, 2));
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show session transcript" },
      args: { id: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const turns = await c.get<unknown[]>(
          `/api/sessions/${args.id}/turns`,
        );
        console.log(JSON.stringify(turns, null, 2));
      },
    }),
  },
});
