import { defineCommand } from "citty";
import pc from "picocolors";
import {
  enrichProposals,
  getProposal,
  listProposals,
  mergeClusters,
  proposeFromSignals,
  rerankAll,
  scanAll,
  sinceHoursAgo,
  appendRun,
  DEFAULT_RULE,
} from "@friday/evolve";

export const evolveCommand = defineCommand({
  meta: { name: "evolve", description: "Self-improvement pipeline" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List proposals on disk" },
      args: {
        status: { type: "string" },
        type: { type: "string" },
      },
      run({ args }) {
        const statusFilter = args.status as string | undefined;
        const typeFilter = args.type as string | undefined;
        const all = listProposals();
        const filtered = all.filter(
          (p) =>
            (!statusFilter || p.status === statusFilter) &&
            (!typeFilter || p.type === typeFilter),
        );
        if (filtered.length === 0) {
          console.log(pc.dim("No proposals."));
          return;
        }
        for (const p of filtered) {
          const status = p.status.padEnd(10);
          const score = String(p.score).padStart(3);
          console.log(
            `${pc.dim(p.id.padEnd(48))} ${pc.cyan(status)} ${pc.yellow(score)}  ${p.title}`,
          );
        }
        console.log(
          pc.dim(
            `\n${filtered.length} of ${all.length} proposal${all.length === 1 ? "" : "s"}`,
          ),
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Read a proposal in full" },
      args: { id: { type: "positional", required: true } },
      run({ args }) {
        const p = getProposal(args.id as string);
        if (!p) {
          console.error(pc.red(`No proposal with id "${args.id}"`));
          process.exit(1);
        }
        console.log(JSON.stringify(p, null, 2));
      },
    }),
    scan: defineCommand({
      meta: {
        name: "scan",
        description: "Walk daemon log + usage + transcripts → emit proposals",
      },
      args: {
        windowHours: { type: "string" },
      },
      run({ args }) {
        const windowHours = args.windowHours
          ? Number(args.windowHours)
          : 24;
        const since = sinceHoursAgo(windowHours);
        const windowEnd = new Date().toISOString();
        const signals = scanAll({ since });
        const propose = proposeFromSignals(signals, {
          rule: DEFAULT_RULE,
          createdBy: "cli",
        });
        const reranked = rerankAll(DEFAULT_RULE);
        appendRun({
          ts: windowEnd,
          by: "cli",
          windowStart: since,
          windowEnd,
          signalsScanned: signals.length,
          proposalsCreated: propose.created.length,
          proposalsUpdated: propose.updated.length,
          promotedToCritical: propose.promotedToCritical.length,
        });
        console.log(
          JSON.stringify(
            {
              signals: signals.length,
              created: propose.created.length,
              updated: propose.updated.length,
              promotedToCritical: propose.promotedToCritical.length,
              reranked: reranked.reranked.length,
              promotedFromRerank: reranked.promoted.length,
            },
            null,
            2,
          ),
        );
      },
    }),
    enrich: defineCommand({
      meta: {
        name: "enrich",
        description: "Replace templated proposal bodies with Sonnet output",
      },
      args: {
        id: { type: "string" },
        force: { type: "boolean" },
        limit: { type: "string" },
      },
      async run({ args }) {
        const result = await enrichProposals({
          id: args.id as string | undefined,
          force: !!args.force,
          limit: args.limit ? Number(args.limit) : undefined,
        });
        console.log(
          JSON.stringify(
            {
              enriched: result.enriched.length,
              skipped: result.skipped,
              failed: result.failed,
            },
            null,
            2,
          ),
        );
      },
    }),
    cluster: defineCommand({
      meta: {
        name: "cluster",
        description: "Group near-duplicate proposals into clusters",
      },
      args: {
        threshold: { type: "string" },
      },
      run({ args }) {
        const threshold = args.threshold ? Number(args.threshold) : undefined;
        const result = mergeClusters({ threshold });
        console.log(
          JSON.stringify(
            {
              clustersCreated: result.clustersCreated.length,
              clustersUpdated: result.clustersUpdated.length,
              proposalsAttached: result.proposalsAttached,
            },
            null,
            2,
          ),
        );
      },
    }),
  },
});
