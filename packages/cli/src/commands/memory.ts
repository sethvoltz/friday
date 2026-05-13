import { defineCommand } from "citty";
import pc from "picocolors";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getEntry, listEntries, type MemoryEntry } from "@friday/memory";
import { DaemonClient } from "../lib/api.js";

function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function readContent(opts: {
  content: string | undefined;
  contentFile: string | undefined;
}): string {
  if (opts.content !== undefined && opts.contentFile !== undefined) {
    throw new Error("pass at most one of --content / --content-file");
  }
  if (opts.content !== undefined) return opts.content;
  if (opts.contentFile === "-") return readFileSync(0, "utf8");
  if (opts.contentFile) return readFileSync(opts.contentFile, "utf8");
  // Fallback: read piped stdin if any.
  if (!input.isTTY) return readFileSync(0, "utf8");
  throw new Error(
    "no content provided; pass --content, --content-file <path>, or pipe to stdin",
  );
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  const ans = await rl.question(prompt);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

export const memoryCommand = defineCommand({
  meta: { name: "memory", description: "Inspect and mutate memory entries" },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List entries" },
      run() {
        const all = listEntries();
        for (const e of all) {
          console.log(`  ${e.id.padEnd(40)} recall=${e.recallCount}`);
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Print one entry" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const e = getEntry(args.id as string);
        if (!e) {
          console.error("not found");
          process.exit(1);
        }
        console.log(`# ${e.title}`);
        console.log(`tags: ${e.tags.join(", ")}`);
        console.log("");
        console.log(e.content);
      },
    }),
    add: defineCommand({
      // FIX_FORWARD 6.9: writes go through the daemon so memory_fts triggers
      // fire and connected agents see the memory_changed event.
      meta: { name: "add", description: "Create a new memory entry" },
      args: {
        title: { type: "string", required: true },
        id: { type: "string", description: "Override the auto-slug id" },
        tags: { type: "string", description: "Comma-separated tag list" },
        content: { type: "string", description: "Inline content" },
        "content-file": {
          type: "string",
          description: "Path to content file (use `-` for stdin)",
        },
      },
      async run({ args }) {
        const content = readContent({
          content: args.content as string | undefined,
          contentFile: args["content-file"] as string | undefined,
        });
        const body: Record<string, unknown> = {
          title: args.title,
          content,
        };
        if (args.id) body.id = args.id;
        const tags = parseTags(args.tags as string | undefined);
        if (tags) body.tags = tags;
        const c = new DaemonClient();
        const created = await c.post<MemoryEntry>("/api/memory", body);
        console.log(pc.green(`created ${created.id}`));
      },
    }),
    edit: defineCommand({
      meta: { name: "edit", description: "Update an existing memory entry" },
      args: {
        id: { type: "positional", required: true },
        title: { type: "string" },
        tags: { type: "string", description: "Comma-separated tag list" },
        content: { type: "string" },
        "content-file": {
          type: "string",
          description: "Path to content file (use `-` for stdin)",
        },
      },
      async run({ args }) {
        const id = args.id as string;
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        const tags = parseTags(args.tags as string | undefined);
        if (tags) patch.tags = tags;
        const hasContent =
          args.content !== undefined || args["content-file"] !== undefined;
        if (hasContent) {
          patch.content = readContent({
            content: args.content as string | undefined,
            contentFile: args["content-file"] as string | undefined,
          });
        }
        if (Object.keys(patch).length === 0) {
          console.error(
            pc.red(
              "no edits — pass at least one of --title, --tags, --content, --content-file",
            ),
          );
          process.exit(1);
        }
        const c = new DaemonClient();
        const updated = await c.patch<MemoryEntry>(
          `/api/memory/${encodeURIComponent(id)}`,
          patch,
        );
        console.log(pc.green(`updated ${updated.id}`));
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete a memory entry" },
      args: {
        id: { type: "positional", required: true },
        force: {
          type: "boolean",
          default: false,
          description: "Skip confirmation",
        },
      },
      async run({ args }) {
        const id = args.id as string;
        if (!args.force) {
          const ok = await confirm(
            pc.yellow(`Delete memory "${id}"? Type "yes" to confirm: `),
          );
          if (!ok) {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        const c = new DaemonClient();
        await c.del(`/api/memory/${encodeURIComponent(id)}`);
        console.log(pc.green(`deleted ${id}`));
      },
    }),
  },
});
