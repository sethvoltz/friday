import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BEADS_DIR } from "@friday/shared";
import type { Proposal } from "./store.js";

export interface DispatchResult {
  /** Beads epic id (e.g. "friday-42") seeded with the proposal body. */
  epicId: string;
  /** Beads issue id of the orchestrator notification mail. */
  mailId: string;
}

export interface DispatchOptions {
  /** Override BEADS_DIR — used by tests. */
  workspace?: string;
  /** Inject a custom bd command runner — used by tests to avoid spawning bd. */
  runBd?: (args: string[]) => string;
  /** Identifier of who's dispatching (becomes the from: label on the mail). */
  appliedBy: string;
}

/**
 * Phase 5: materialize a `code` proposal.
 *
 * Creates a Beads epic capturing the proposal body + evidence pointers, then
 * mails the orchestrator with the epic id so it can confirm the plan with
 * the user and dispatch a Builder. We never spawn the Builder ourselves —
 * Builder creation is a high-blast-radius action that always goes through
 * the user-approval flow the orchestrator already owns.
 *
 * The mail label format mirrors `services/friday/src/comms/mail.ts` so the
 * orchestrator's existing mail poller picks it up unchanged.
 */
export function dispatchCodeProposal(
  proposal: Proposal,
  opts: DispatchOptions
): DispatchResult {
  const workspace = opts.workspace ?? BEADS_DIR;
  const bd = opts.runBd ?? defaultRunner(workspace);

  const epicId = bd([
    "create",
    `Evolve: ${proposal.title}`,
    "-d",
    buildEpicBody(proposal),
    "--epic",
    "--silent",
  ]);

  const mailId = bd([
    "create",
    `Code proposal ${proposal.id} approved`,
    "-d",
    buildMailBody(proposal, epicId),
    "-a",
    "orchestrator",
    "-l",
    `type:message,delivery:pending,from:evolve:${opts.appliedBy}`,
    "--priority",
    "2",
    "--ephemeral",
    "--silent",
  ]);

  return { epicId, mailId };
}

function defaultRunner(workspace: string): (args: string[]) => string {
  return (args) => {
    if (!existsSync(join(workspace, ".beads"))) {
      throw new Error(
        `Beads database not found at ${workspace}. Run: cd ${workspace} && bd init --non-interactive --prefix friday --skip-agents --skip-hooks`
      );
    }
    const result = execFileSync("bd", args, {
      cwd: workspace,
      stdio: "pipe",
      env: { ...process.env, BD_NON_INTERACTIVE: "1" },
    });
    return result.toString().trim();
  };
}

function buildEpicBody(proposal: Proposal): string {
  const evidence = proposal.signals.flatMap((s) =>
    s.evidencePointers.map((ev) => {
      const loc = ev.line ? `:${ev.line}` : "";
      const sess = ev.sessionId ? ` (session ${ev.sessionId})` : "";
      return `- \`${ev.kind}\` ${ev.path}${loc}${sess}`;
    })
  );

  const targets = proposal.appliesTo.length
    ? proposal.appliesTo.map((t) => `\`${t}\``).join(", ")
    : "(none specified)";

  return [
    `Source: evolve proposal \`${proposal.id}\` (score ${proposal.score}, blast ${proposal.blastRadius}).`,
    "",
    "## Proposed change",
    "",
    proposal.proposedChange.trim(),
    "",
    "## Targets",
    "",
    targets,
    "",
    "## Evidence",
    "",
    evidence.length > 0 ? evidence.join("\n") : "(no evidence pointers attached)",
    "",
    "## Acceptance criteria",
    "",
    "- Implement the change above with tests covering the failure modes the signals describe.",
    "- Verify pre-push gates pass (pnpm test, daemon tsc, cli tsc, shared build).",
  ].join("\n");
}

function buildMailBody(proposal: Proposal, epicId: string): string {
  return [
    `An evolve \`code\` proposal was approved.`,
    "",
    `- Proposal: \`${proposal.id}\` — ${proposal.title}`,
    `- Score: ${proposal.score}`,
    `- Blast radius: ${proposal.blastRadius}`,
    `- Beads epic: \`${epicId}\``,
    "",
    "Confirm scope with the user, then dispatch a Builder against this epic via",
    "the existing `agent_create` flow. Read the epic with `bd show ${epicId} --json`.",
  ].join("\n");
}
