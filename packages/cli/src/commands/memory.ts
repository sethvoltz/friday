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
      async run() {
        const all = await listEntries();
        for (const e of all) {
          console.log(`  ${e.id.padEnd(40)} recall=${e.recallCount}`);
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Print one entry" },
      args: { id: { type: "positional", required: true } },
      async run({ args }) {
        const e = await getEntry(args.id as string);
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
    "pin-repo": defineCommand({
      // FRI-61: write friday's repo-path pinned memory entry directly
      // through the memory store. Works whether or not the daemon is
      // running — the memory store talks to Postgres + writes the
      // markdown file on disk; the daemon's settings LISTEN handler
      // will pick up the row on its next boot if it isn't already up.
      meta: {
        name: "pin-repo",
        description:
          "Pin friday's agent-friday repo path as a memory entry (FRI-61). Idempotent unless --force.",
      },
      args: {
        path: {
          type: "positional",
          required: true,
          description: "Absolute path to the agent-friday repo",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Overwrite an existing pinned-repo memory",
        },
      },
      async run({ args }) {
        const path = args.path as string;
        if (!path.startsWith("/")) {
          console.error(pc.red(`path must be absolute: ${path}`));
          process.exit(1);
        }
        const { saveEntry, getEntry } = await import("@friday/memory");
        const id = "pin-repo-agent-friday";
        const existing = await getEntry(id);
        if (existing && !args.force) {
          console.log(
            pc.yellow(
              `memory "${id}" already exists; pass --force to overwrite.`,
            ),
          );
          return;
        }
        const now = new Date().toISOString();
        await saveEntry({
          id,
          title: "agent-friday repo path",
          content:
            `The agent-friday repo lives at \`${path}\`. Use this path ` +
            `when you need to Read, Edit, or run Bash against Friday's ` +
            `own source; open PRs against it; or hand a worktree off to ` +
            `a builder. Same pattern applies to any other repos pinned ` +
            `for you — each is on equal footing.`,
          tags: ["pinned", "repo"],
          createdBy: "friday",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          recallCount: existing?.recallCount ?? 0,
          lastRecalledAt: existing?.lastRecalledAt ?? null,
        });
        console.log(
          pc.green(
            `pinned repo path for friday: ${path}` +
              (args.force && existing ? " (overwrote)" : ""),
          ),
        );
      },
    }),
  },
});
