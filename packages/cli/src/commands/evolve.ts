import { defineCommand } from "citty";

// IMPORTANT: do NOT statically import "@friday/evolve" or "@friday/shared"
// here. Each subcommand's run() lazy-imports them so `friday status` and
// other unrelated commands don't pay the cost of pulling in
// @anthropic-ai/claude-agent-sdk just to dispatch.

export const evolveScanCmd = defineCommand({
  meta: {
    name: "scan",
    description:
      "Scan daemon/feedback/usage/transcripts/friction signals, propose, rerank, and write a run record.",
  },
  args: {
    "since-hours": {
      type: "string",
      description: "Lookback window in hours (default: 24)",
    },
  },
  async run({ args }) {
    const hours = Number(args["since-hours"] ?? "24");
    if (!Number.isFinite(hours) || hours <= 0) {
      console.error("Error: --since-hours must be a positive number.");
      process.exit(2);
    }
    const { loadConfig } = await import("@friday/shared");
    const {
      scanDaemonLog,
      scanFeedback,
      scanUsageLog,
      scanTranscripts,
      scanFriction,
      sinceHoursAgo,
      proposeFromSignals,
      rerankAll,
      appendRun,
    } = await import("@friday/evolve");

    const config = loadConfig();
    const now = new Date();
    const since = sinceHoursAgo(hours, now);

    const [daemon, feedback, usage, transcripts, friction] = await Promise.all([
      Promise.resolve(scanDaemonLog({ since })),
      Promise.resolve(scanFeedback({ since })),
      Promise.resolve(scanUsageLog({ since })),
      Promise.resolve(scanTranscripts({ since })),
      scanFriction({ since }).catch((err: unknown) => {
        console.error(
          `friction scanner failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      promotedToCritical:
        result.promotedToCritical.length + reranked.promoted.length,
    };
    appendRun(record);
    console.log(JSON.stringify(record, null, 2));
  },
});

export const evolveEnrichCmd = defineCommand({
  meta: {
    name: "enrich",
    description:
      "Replace templated proposal bodies with Sonnet-written analysis. --id, --all, --retry-failed are mutually exclusive.",
  },
  args: {
    id: { type: "string", description: "Target a single proposal by id" },
    all: {
      type: "boolean",
      description: "Target all open/critical proposals (default when no --id/--retry-failed)",
      default: false,
    },
    "retry-failed": {
      type: "boolean",
      description: "Target only proposals with a recorded lastEnrichError",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Re-enrich even if enrichedAt is fresh",
      default: false,
    },
    limit: {
      type: "string",
      description: "Cap enrichments at N per run (default 50)",
    },
  },
  async run({ args }) {
    const id = typeof args.id === "string" && args.id.length > 0 ? args.id : undefined;
    const all = args.all === true;
    const retryFailed = args["retry-failed"] === true;
    const force = args.force === true;
    const limitRaw = typeof args.limit === "string" ? args.limit : undefined;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      console.error("Error: --limit must be a positive number.");
      process.exit(2);
    }
    if (retryFailed && id) {
      console.error("Error: --retry-failed and --id are mutually exclusive.");
      process.exit(2);
    }

    const { enrichProposals } = await import("@friday/evolve");
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
  },
});

export const evolveClusterCmd = defineCommand({
  meta: {
    name: "cluster",
    description: "Re-cluster open proposals via Jaccard merge.",
  },
  async run() {
    const { mergeClusters } = await import("@friday/evolve");
    const merged = mergeClusters();
    const record = {
      ts: new Date().toISOString(),
      clustersCreated: merged.clustersCreated.length,
      clustersUpdated: merged.clustersUpdated.length,
      proposalsAttached: merged.proposalsAttached,
    };
    console.log(JSON.stringify(record, null, 2));
  },
});

export const evolveListCmd = defineCommand({
  meta: {
    name: "list",
    description: "List proposals (optionally filtered by status or enrichment state).",
  },
  args: {
    status: {
      type: "string",
      description: "Filter by status (open, critical, applied, …)",
    },
    "needs-enrich": {
      type: "boolean",
      description: "Show only proposals that need enrichment (pending or failed)",
      default: false,
    },
  },
  async run({ args }) {
    const { listProposals } = await import("@friday/evolve");
    const status = typeof args.status === "string" && args.status.length > 0 ? args.status : undefined;
    const needsEnrich = args["needs-enrich"] === true;
    let proposals = listProposals();
    if (status) proposals = proposals.filter((p) => p.status === status);
    if (needsEnrich) {
      proposals = proposals.filter(
        (p) =>
          (p.status === "open" || p.status === "critical") &&
          (p.lastEnrichError !== null || !p.enrichedAt),
      );
    }
    proposals.sort((a, b) => b.score - a.score);

    if (proposals.length === 0) {
      console.log("(no proposals)");
      return;
    }
    for (const p of proposals) {
      const enrichStatus = p.lastEnrichError ? "failed" : p.enrichedAt ? "ok" : "pending";
      console.log(`[${p.status}] (${p.score}) ${p.id}  enrich:${enrichStatus}  —  ${p.title}`);
    }
  },
});

export const evolveShowCmd = defineCommand({
  meta: { name: "show", description: "Print a single proposal as JSON." },
  args: {
    id: { type: "positional", required: true, description: "Proposal id" },
  },
  async run({ args }) {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      console.error("Error: 'show' requires an id.");
      process.exit(2);
    }
    const { listProposals } = await import("@friday/evolve");
    const proposals = listProposals();
    const p = proposals.find((x) => x.id === id);
    if (!p) {
      console.error(`Error: proposal not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(p, null, 2));
  },
});

export const evolveCommandCitty = defineCommand({
  meta: {
    name: "evolve",
    description:
      "Local self-improvement pipeline (Evolve with Intent). Subcommands: scan, enrich, cluster, list, show.",
  },
  subCommands: {
    scan: evolveScanCmd,
    enrich: evolveEnrichCmd,
    cluster: evolveClusterCmd,
    list: evolveListCmd,
    show: evolveShowCmd,
  },
});
