import { defineCommand } from "citty";
import pc from "picocolors";
import { getProposal, listProposals } from "@friday/evolve";

const PIPELINE_HINT =
  "(scan/enrich/cluster auto-population lands in roadmap Phase 4. Use the orchestrator's `evolve_save` / `evolve_apply` MCP tools to capture proposals manually until then.)";

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
        console.log(pc.dim(`\n${filtered.length} of ${all.length} proposal${all.length === 1 ? "" : "s"}`));
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
        description: "Scan logs for improvement signals (pending pipeline lift)",
      },
      run() {
        console.log(pc.dim(PIPELINE_HINT));
      },
    }),
    enrich: defineCommand({
      meta: {
        name: "enrich",
        description: "Enrich proposal bodies via Sonnet (pending)",
      },
      run() {
        console.log(pc.dim(PIPELINE_HINT));
      },
    }),
    cluster: defineCommand({
      meta: {
        name: "cluster",
        description: "Cluster near-duplicate proposals (pending)",
      },
      run() {
        console.log(pc.dim(PIPELINE_HINT));
      },
    }),
  },
});
