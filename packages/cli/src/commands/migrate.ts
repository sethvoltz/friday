/**
 * `friday migrate` — inspect daemon-side state migrations from the CLI.
 *
 * Today the only subcommand is `cwd --dry-run`, which reports the moves
 * the daemon's `agent-cwd-pin-v1` state migration would perform on its
 * next boot. The migration itself runs on daemon boot (guarded by the
 * `_friday_state_migrations` table), not from the CLI — that lets the
 * advisory-locked, atomic-with-other-boot-steps version stay the only
 * runner. Users get pre-boot visibility via `--dry-run`; applying it is
 * simply `friday start`.
 */

import { defineCommand } from "citty";
import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import {
  AGENTS_DIR,
  ENV_PATH,
  appDir,
  ensureDirs,
  ensureFridayEnv,
  getDb,
  schema,
} from "@friday/shared";

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function resolveAgentCwd(row: {
  name: string;
  type: string;
  worktreePath: string | null;
  appId: string | null;
}): Promise<string> {
  if (row.worktreePath) return row.worktreePath;
  if (row.appId) return appDir(row.appId);
  const home = join(AGENTS_DIR, row.name);
  mkdirSync(home, { recursive: true });
  return home;
}

export const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Inspect daemon-side state migrations",
  },
  subCommands: {
    cwd: defineCommand({
      meta: {
        name: "cwd",
        description:
          "Preview JSONL transcript moves the daemon will perform on next boot (FRI-61).",
      },
      args: {
        "dry-run": {
          type: "boolean",
          default: true,
          description:
            "Always true today — apply by running `friday start` (the daemon runs the migration at boot).",
        },
      },
      async run() {
        // Load ~/.friday/.env into process.env before any DB access; other
        // CLI commands gate on existsSync(ENV_PATH) for fresh installs that
        // haven't run `friday setup` yet.
        if (existsSync(ENV_PATH)) ensureFridayEnv();
        ensureDirs();
        const projectsDir = join(homedir(), ".claude", "projects");
        if (!existsSync(projectsDir)) {
          console.log(pc.yellow(`no ~/.claude/projects dir — nothing to migrate.`));
          return;
        }
        const candidates = readdirSync(projectsDir);
        const db = getDb();
        const agentRows = await db
          .select({
            name: schema.agents.name,
            type: schema.agents.type,
            sessionId: schema.agents.sessionId,
            worktreePath: schema.agents.worktreePath,
            appId: schema.agents.appId,
          })
          .from(schema.agents)
          .where(eq(schema.agents.status, schema.agents.status));
        if (agentRows.length === 0) {
          console.log(pc.yellow("no agents in registry."));
          return;
        }

        let wouldMove = 0;
        let alreadyAtDest = 0;
        let missingSource = 0;

        for (const a of agentRows) {
          if (!a.sessionId) continue;
          const newCwd = await resolveAgentCwd(a);
          const newEncoded = encodeProjectDir(newCwd);
          const newJsonl = join(projectsDir, newEncoded, `${a.sessionId}.jsonl`);
          if (existsSync(newJsonl)) {
            console.log(
              pc.dim(`  skip  ${a.name} (${a.sessionId.slice(0, 8)}…) — already at new path`),
            );
            alreadyAtDest++;
            continue;
          }
          let found = false;
          for (const dir of candidates) {
            if (dir === newEncoded) continue;
            const old = join(projectsDir, dir, `${a.sessionId}.jsonl`);
            if (!existsSync(old)) continue;
            const oldSidecar = join(projectsDir, dir, a.sessionId);
            const sidecarTag =
              existsSync(oldSidecar) && statSync(oldSidecar).isDirectory() ? " (+sidecar)" : "";
            console.log(pc.cyan(`  move  ${a.name} (${a.sessionId.slice(0, 8)}…)${sidecarTag}`));
            console.log(pc.dim(`        from: ${old}`));
            console.log(pc.dim(`        to:   ${newJsonl}`));
            wouldMove++;
            found = true;
            break;
          }
          if (!found) {
            console.log(
              pc.dim(`  miss  ${a.name} (${a.sessionId.slice(0, 8)}…) — no source JSONL found`),
            );
            missingSource++;
          }
        }
        console.log("");
        console.log(
          pc.green(
            `${wouldMove} session(s) would move; ${alreadyAtDest} already migrated; ${missingSource} have no source JSONL on disk.`,
          ),
        );
        console.log(
          pc.dim(
            "  Run `friday start` to apply (the daemon's state-migrations runner handles this at boot, recorded in _friday_state_migrations).",
          ),
        );
      },
    }),
  },
});
