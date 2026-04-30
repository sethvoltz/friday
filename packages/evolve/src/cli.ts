#!/usr/bin/env node
import { loadConfig } from "@friday/shared";
import {
  listProposals,
  scanDaemonLog,
  scanFeedback,
  scanUsageLog,
  scanTranscripts,
  scanFriction,
  sinceHoursAgo,
  proposeFromSignals,
  rerankAll,
  appendRun,
  mergeClusters,
  enrichProposals,
} from "./index.js";

const args = process.argv.slice(2);
const cmd = args[0];

function help(): void {
  console.log(
    [
      "friday-evolve — local self-improvement pipeline (Evolve with Intent)",
      "",
      "Usage:",
      "  friday-evolve scan [--since-hours N]                   Run scan + propose + rerank, write a run record.",
      "  friday-evolve enrich [--id ID|--all|--retry-failed]    Replace templated bodies with Sonnet-written analysis.",
      "                        [--force] [--limit N]",
      "  friday-evolve cluster                                  Re-cluster open proposals via Jaccard merge.",
      "  friday-evolve list [--status STATUS] [--needs-enrich]  List proposals.",
      "  friday-evolve show <id>                                Print a single proposal as JSON.",
      "  friday-evolve help                                     Show this help.",
      "",
      "Enrich flags:",
      "  --id ID          Target a single proposal by id.",
      "  --all            Target all open/critical proposals (default when no --id/--retry-failed).",
      "  --retry-failed   Target only proposals that have a recorded lastEnrichError.",
      "  --force          Re-enrich even if enrichedAt is fresh.",
      "  --limit N        Cap enrichments at N per run (default 50).",
      "",
      "List flags:",
      "  --status STATUS  Filter by status (open, critical, applied, …).",
      "  --needs-enrich   Show only proposals that need enrichment (pending or failed).",
      "",
      "Defaults:",
      "  --since-hours 24",
    ].join("\n")
  );
}

function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

async function main(): Promise<void> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  if (cmd === "scan") {
    const hours = Number(getFlag("--since-hours") ?? "24");
    if (!Number.isFinite(hours) || hours <= 0) {
      console.error("Error: --since-hours must be a positive number.");
      process.exit(2);
    }

    const config = loadConfig();
    const now = new Date();
    const since = sinceHoursAgo(hours, now);

    // Friction is async (Haiku-graded) and may fail on transient API errors —
    // never let it sink the rest of the scan. Other scanners are pure I/O and
    // run in parallel.
    const [daemon, feedback, usage, transcripts, friction] = await Promise.all([
      Promise.resolve(scanDaemonLog({ since })),
      Promise.resolve(scanFeedback({ since })),
      Promise.resolve(scanUsageLog({ since })),
      Promise.resolve(scanTranscripts({ since })),
      scanFriction({ since }).catch((err) => {
        console.error(`friction scanner failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }),
    ]);
    const signals = [...daemon, ...feedback, ...usage, ...transcripts, ...friction];
    const result = proposeFromSignals(signals, {
      rule: config.evolve,
      createdBy: process.env.FRIDAY_AGENT_NAME ?? "cli",
    });
    const reranked = rerankAll(config.evolve);

    const record = {
      ts: now.toISOString(),
      by: process.env.FRIDAY_AGENT_NAME ?? "cli",
      windowStart: since,
      windowEnd: now.toISOString(),
      signalsScanned: signals.length,
      proposalsCreated: result.created.length,
      proposalsUpdated: result.updated.length + reranked.reranked.length,
      promotedToCritical: result.promotedToCritical.length + reranked.promoted.length,
    };
    appendRun(record);

    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (cmd === "enrich") {
    const id = getFlag("--id");
    const all = args.includes("--all");
    const retryFailed = args.includes("--retry-failed");
    const force = args.includes("--force");
    const limitRaw = getFlag("--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      console.error("Error: --limit must be a positive number.");
      process.exit(2);
    }
    if (retryFailed && id) {
      console.error("Error: --retry-failed and --id are mutually exclusive.");
      process.exit(2);
    }

    const result = await enrichProposals({
      id,
      all: all || (!id && !retryFailed),
      retryFailed,
      force,
      limit,
    });

    const record = {
      ts: new Date().toISOString(),
      enriched: result.enriched.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      failures: result.failed,
    };
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (cmd === "cluster") {
    const merged = mergeClusters();
    const record = {
      ts: new Date().toISOString(),
      clustersCreated: merged.clustersCreated.length,
      clustersUpdated: merged.clustersUpdated.length,
      proposalsAttached: merged.proposalsAttached,
    };
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (cmd === "list") {
    const status = getFlag("--status");
    const needsEnrich = args.includes("--needs-enrich");
    let proposals = listProposals();
    if (status) proposals = proposals.filter((p) => p.status === status);
    if (needsEnrich) {
      proposals = proposals.filter(
        (p) =>
          (p.status === "open" || p.status === "critical") &&
          (p.lastEnrichError !== null || !p.enrichedAt)
      );
    }
    proposals.sort((a, b) => b.score - a.score);

    if (proposals.length === 0) {
      console.log("(no proposals)");
      return;
    }

    for (const p of proposals) {
      const enrichStatus = p.lastEnrichError
        ? "failed"
        : p.enrichedAt
          ? "ok"
          : "pending";
      console.log(`[${p.status}] (${p.score}) ${p.id}  enrich:${enrichStatus}  —  ${p.title}`);
    }
    return;
  }

  if (cmd === "show") {
    const id = args[1];
    if (!id) {
      console.error("Error: 'show' requires an id.");
      process.exit(2);
    }
    const proposals = listProposals();
    const p = proposals.find((x) => x.id === id);
    if (!p) {
      console.error(`Error: proposal not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  help();
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
