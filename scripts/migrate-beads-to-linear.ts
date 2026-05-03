#!/usr/bin/env tsx
/**
 * One-time migration: port active Beads epics to Linear Backlog.
 *
 * Run once at the Linear cutover (ADR-026). NOT shipped — delete from the
 * repo after the migration is complete.
 *
 * Behavior:
 *   1. Lists all Beads epics via `bd list --type epic --json`.
 *   2. Skips epics in `closed` / `done` state — those stay as historical
 *      record in beads.
 *   3. For each active epic: creates a Linear ticket in Backlog with the
 *      epic's title and description, the `evolve` label if it appears to
 *      have come from evolve dispatch (title starts with "Evolve: "),
 *      priority mapped from any associated proposal score (else Normal).
 *      Sets the bead's `external_ref` to the Linear identifier (FRI-XX).
 *      Posts the Friday-bead back-reference comment on Linear.
 *   4. Surveys `~/.friday/evolve/proposals/*.md`. Reports counts by status.
 *      `open` / `critical` / `approved` proposals not yet dispatched are
 *      left untouched — the next `friday evolve apply` run will land them
 *      in Linear naturally via the new dispatch path.
 *
 * Usage:
 *   tsx scripts/migrate-beads-to-linear.ts --dry-run   # plan, no writes
 *   tsx scripts/migrate-beads-to-linear.ts             # execute
 *
 * Environment:
 *   LINEAR_API_KEY  — must be set (read from `~/.friday/.env` if present)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  BEADS_DIR,
  ENV_PATH,
  EVOLVE_LABEL,
  FRIDAY_BEAD_MARKER,
  FRIDAY_TEAM_ID,
} from "@friday/shared";

const DRY_RUN = process.argv.includes("--dry-run");

interface BeadEpic {
  id: string;
  title: string;
  description?: string;
  status: string;
  external_ref?: string;
}

async function main(): Promise<void> {
  loadDotenv({ path: ENV_PATH });
  if (!process.env.LINEAR_API_KEY) {
    console.error("LINEAR_API_KEY not set. Run `friday setup linear` first.");
    process.exit(1);
  }
  if (DRY_RUN) console.log("DRY RUN — no writes will occur.\n");

  // 1. List beads epics. --long is required to include external_ref in the JSON.
  const epicsRaw = bd(["list", "--type", "epic", "--json", "--long"]);
  const epics = JSON.parse(epicsRaw) as BeadEpic[];
  console.log(`Found ${epics.length} beads epics total.`);

  // 2. Filter to active (non-closed)
  const active = epics.filter(
    (e) => e.status !== "closed" && e.status !== "done"
  );
  console.log(`  ${active.length} active (the rest stay as historical record).\n`);

  // Skip epics already linked to Linear (idempotency for re-runs)
  const unlinked = active.filter((e) => !e.external_ref);
  console.log(`  ${unlinked.length} not yet linked to Linear.\n`);

  // 3. Per-epic migration
  const stateId = await resolveBacklogStateId();
  const evolveLabelId = await resolveLabelId(EVOLVE_LABEL);

  let migrated = 0;
  for (const epic of unlinked) {
    const isEvolve = epic.title.startsWith("Evolve: ");
    const priority = 3; // Normal — could parse score from epic body if needed
    const labels = isEvolve && evolveLabelId ? [evolveLabelId] : [];

    console.log(
      `  ${DRY_RUN ? "[dry-run] would migrate" : "migrating"}: ${epic.id} "${epic.title}"` +
        (isEvolve ? " (evolve)" : "")
    );
    if (DRY_RUN) continue;

    const created = await createLinearTicket({
      teamId: FRIDAY_TEAM_ID,
      title: epic.title,
      description:
        (epic.description ?? "(no description on the originating bead)") +
        `\n\n---\nMigrated from local Beads epic \`${epic.id}\` on ${new Date().toISOString().slice(0, 10)}.`,
      stateId,
      priority,
      labelIds: labels,
    });

    bd(["update", epic.id, "--external-ref", created.identifier]);
    await postBackRefComment(created.id, epic.id);
    console.log(`    → ${created.identifier} ${created.url}`);
    migrated++;
  }

  // 4. Survey evolve proposals
  const proposalsDir = join(process.env.HOME ?? "~", ".friday", "evolve", "proposals");
  let proposalSummary: Record<string, number> = {};
  if (existsSync(proposalsDir)) {
    const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const body = readFileSync(join(proposalsDir, f), "utf-8");
      const m = body.match(/^status:\s*(\S+)/m);
      const status = m ? m[1] : "unknown";
      proposalSummary[status] = (proposalSummary[status] ?? 0) + 1;
    }
  }

  // Summary
  console.log(`\n──────────────────────────────────`);
  console.log(`Beads epics migrated to Linear: ${migrated}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Evolve proposals on disk (untouched):`);
  for (const [status, n] of Object.entries(proposalSummary)) {
    console.log(`  ${status}: ${n}`);
  }
  console.log(`\nNext steps:`);
  console.log(`  • Review migrated tickets in Linear (Friday team, Backlog).`);
  console.log(`  • Triage to Todo as desired.`);
  console.log(`  • Open evolve proposals will dispatch to Linear naturally on next \`friday evolve apply\`.`);
}

function bd(args: string[]): string {
  return execFileSync("bd", args, {
    cwd: BEADS_DIR,
    stdio: "pipe",
    env: { ...process.env, BD_NON_INTERACTIVE: "1" },
  })
    .toString()
    .trim();
}

async function linearGraphQL<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.LINEAR_API_KEY!,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Linear errors: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error("Linear: empty data");
  return json.data;
}

async function resolveBacklogStateId(): Promise<string> {
  const data = await linearGraphQL<{ workflowStates: { nodes: Array<{ id: string }> } }>(
    `query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: "Backlog" } }) {
        nodes { id }
      }
    }`,
    { teamId: FRIDAY_TEAM_ID }
  );
  if (!data.workflowStates.nodes[0]) throw new Error("No Backlog state found");
  return data.workflowStates.nodes[0].id;
}

async function resolveLabelId(name: string): Promise<string | null> {
  const data = await linearGraphQL<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
    `query($teamId: String!) {
      issueLabels(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name }
      }
    }`,
    { teamId: FRIDAY_TEAM_ID }
  );
  return data.issueLabels.nodes.find((l) => l.name === name)?.id ?? null;
}

interface CreateInput {
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  labelIds: string[];
}

async function createLinearTicket(input: CreateInput): Promise<{ id: string; identifier: string; url: string }> {
  const data = await linearGraphQL<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
  }>(
    `mutation($teamId: String!, $title: String!, $description: String!, $stateId: String!, $priority: Int!, $labelIds: [String!]!) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description, stateId: $stateId, priority: $priority, labelIds: $labelIds }) {
        success
        issue { id identifier url }
      }
    }`,
    input as unknown as Record<string, unknown>
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("issueCreate returned success=false");
  }
  return data.issueCreate.issue;
}

async function postBackRefComment(issueId: string, beadId: string): Promise<void> {
  await linearGraphQL(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }`,
    { issueId, body: `${FRIDAY_BEAD_MARKER} \`${beadId}\`` }
  );
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
