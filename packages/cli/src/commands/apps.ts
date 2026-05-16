import { defineCommand } from "citty";
import pc from "picocolors";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DaemonClient } from "../lib/api.js";

interface AppRow {
  id: string;
  name: string;
  version: string;
  status: string;
  installedAt: number;
  folderPath: string;
  agents: { name: string; type: string; status: string }[];
  schedules: { name: string; cron: string | null }[];
  mcpServers: { name: string }[];
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  const ans = await rl.question(prompt);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

export const appsCommand = defineCommand({
  meta: {
    name: "app",
    description: "Install, inspect, and manage Friday Apps",
  },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install an app from a folder" },
      args: {
        path: { type: "positional", required: true },
        adopt: {
          type: "boolean",
          default: false,
          description:
            "Rebind any existing agent with a colliding name into this app",
        },
      },
      async run({ args }) {
        const folderPath = resolve(args.path as string);
        const c = new DaemonClient();
        const result = await c.post<{ id: string; version: string }>(
          "/api/apps",
          { folderPath, adopt: !!args.adopt },
        );
        console.log(
          pc.green(`installed ${result.id}@${result.version}`),
          pc.dim(`(${folderPath})`),
        );
      },
    }),
    uninstall: defineCommand({
      meta: {
        name: "uninstall",
        description: "Uninstall an app (archives agents + schedules)",
      },
      args: {
        id: { type: "positional", required: true },
        folder: {
          type: "string",
          default: "archive",
          description:
            "What to do with the on-disk folder: archive (default) | keep | delete",
        },
        yes: {
          type: "boolean",
          default: false,
          description: "Skip the confirmation prompt for --folder=delete",
        },
      },
      async run({ args }) {
        const id = args.id as string;
        const folder = args.folder as "archive" | "keep" | "delete";
        if (!["archive", "keep", "delete"].includes(folder)) {
          console.error(pc.red(`invalid --folder: ${folder}`));
          process.exit(1);
        }
        if (folder === "delete" && !args.yes) {
          const ok = await confirm(
            pc.yellow(
              `--folder=delete is IRREVERSIBLE; type "yes" to confirm deletion of "${id}": `,
            ),
          );
          if (!ok) {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        const c = new DaemonClient();
        const result = await c.del<{ archivedFolderPath?: string }>(
          `/api/apps/${encodeURIComponent(id)}`,
          { folderDisposition: folder },
        );
        const tail = result.archivedFolderPath
          ? pc.dim(`(folder → ${result.archivedFolderPath})`)
          : "";
        console.log(pc.green(`uninstalled ${id}`), tail);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List installed apps" },
      async run() {
        const c = new DaemonClient();
        const rows = await c.get<AppRow[]>("/api/apps");
        if (rows.length === 0) {
          console.log(pc.dim("No apps installed."));
          return;
        }
        for (const r of rows) {
          const status =
            r.status === "installed"
              ? pc.green(r.status)
              : r.status === "orphaned"
                ? pc.yellow(r.status)
                : pc.red(r.status);
          console.log(
            `  ${pc.bold(r.id.padEnd(24))} v${r.version.padEnd(10)} ${status}`,
          );
          if (r.agents.length > 0) {
            console.log(
              pc.dim(`    agents:    ${r.agents.map((a) => a.name).join(", ")}`),
            );
          }
          if (r.schedules.length > 0) {
            console.log(
              pc.dim(
                `    schedules: ${r.schedules.map((s) => s.name).join(", ")}`,
              ),
            );
          }
          if (r.mcpServers.length > 0) {
            console.log(
              pc.dim(
                `    mcp:       ${r.mcpServers.map((m) => m.name).join(", ")}`,
              ),
            );
          }
        }
      },
    }),
    inspect: defineCommand({
      meta: { name: "inspect", description: "Print one app's full state" },
      args: { id: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const row = await c.get<AppRow>(
          `/api/apps/${encodeURIComponent(args.id as string)}`,
        );
        console.log(JSON.stringify(row, null, 2));
      },
    }),
    reload: defineCommand({
      meta: {
        name: "reload",
        description: "Re-read the manifest from disk and reconcile",
      },
      args: { id: { type: "positional", required: true } },
      async run({ args }) {
        const c = new DaemonClient();
        const id = args.id as string;
        const result = await c.post<{ changed: boolean }>(
          `/api/apps/${encodeURIComponent(id)}/reload`,
          {},
        );
        console.log(
          result.changed
            ? pc.green(`reloaded ${id}`)
            : pc.dim(`${id}: no change`),
        );
      },
    }),
  },
});
