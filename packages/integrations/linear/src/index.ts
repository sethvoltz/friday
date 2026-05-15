/**
 * Linear integration. Probes `LINEAR_API_KEY`; if absent, every entry point
 * gracefully no-ops. With a key set, the boot path runs `reconcile()` which
 * lists active Linear issues, cross-references against
 * `ticket_external_links WHERE system='linear'`, and returns a result the
 * daemon turns into a `system_banner` SSE event.
 *
 * `linear_import(identifier)` is the orchestrator-driven path to bring a
 * Linear issue in as a Friday ticket.
 */

import {
  createTicket,
  externalLinksBySystem,
  getTicket,
  linkExternal,
  type Ticket,
} from "@friday/shared/services";
import { loadConfig } from "@friday/shared";
import {
  createIssue,
  findTeamByKey,
  getIssueByIdentifier,
  listActiveIssues,
  listTeams,
  type CreatedIssue,
  type LinearIssue,
  type LinearTeam,
} from "./api.js";

export {
  createIssue,
  findTeamByKey,
  getIssueByIdentifier,
  getStateIdByType,
  LinearApiError,
  linearQuery,
  listActiveIssues,
  listTeams,
  resolveIssueIdByIdentifier,
  setIssueStateByType,
  updateIssue,
  type CreateIssueInput,
  type CreatedIssue,
  type LinearIssue,
  type LinearStateType,
  type LinearTeam,
  type UpdateIssueInput,
  type UpdatedIssue,
} from "./api.js";

export const LINEAR_SYSTEM_NAME = "linear";

export interface LinearConfig {
  apiKey: string;
  /**
   * Team identifier for issue creation. Either a Linear team UUID or a
   * team key like `"FRI"`. Sourced from `FRIDAY_LINEAR_TEAM` env var,
   * falling back to `linear.team` in `~/.friday/config.json`. May be
   * undefined; the createIssue path falls back to "first team" with a
   * warning when missing.
   */
  team?: string;
}

export function getLinearConfig(): LinearConfig | null {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return null;
  const team = process.env.FRIDAY_LINEAR_TEAM ?? loadConfig().linear?.team;
  return { apiKey: key, team };
}

/**
 * Resolve the configured `team` value (UUID or key) to a concrete team UUID
 * suitable for `createIssue`. If no team is configured, falls back to the
 * first team Linear returns and logs a warning.
 *
 * Pure helper — accepts the raw team string so tests can drive it directly.
 */
export async function resolveTeamId(opts: {
  apiKey: string;
  team?: string;
  warn?: (msg: string) => void;
}): Promise<LinearTeam> {
  const warn = opts.warn ?? ((m) => console.warn(m));

  if (opts.team && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.team)) {
    // Already a UUID. Return a stub team — name/key not needed downstream.
    return { id: opts.team, key: "", name: "" };
  }

  if (opts.team) {
    const found = await findTeamByKey({ apiKey: opts.apiKey, key: opts.team });
    if (!found) {
      throw new Error(
        `Linear team "${opts.team}" not found (configured via FRIDAY_LINEAR_TEAM or linear.team).`,
      );
    }
    return found;
  }

  const teams = await listTeams({ apiKey: opts.apiKey });
  if (teams.length === 0) {
    throw new Error("Linear API key has access to no teams.");
  }
  warn(
    `linear.team not configured — falling back to first team "${teams[0].key}". Set linear.team in ~/.friday/config.json or FRIDAY_LINEAR_TEAM to pin this.`,
  );
  return teams[0];
}

/**
 * Convenience wrapper: resolve the configured team, then create an issue.
 * Returns the created issue plus the team that was used.
 */
export async function createIssueWithConfiguredTeam(opts: {
  title: string;
  description?: string;
}): Promise<{ issue: CreatedIssue; team: LinearTeam }> {
  const cfg = getLinearConfig();
  if (!cfg) {
    throw new Error("LINEAR_API_KEY not set");
  }
  const team = await resolveTeamId({ apiKey: cfg.apiKey, team: cfg.team });
  const issue = await createIssue({
    apiKey: cfg.apiKey,
    input: {
      teamId: team.id,
      title: opts.title,
      description: opts.description,
    },
  });
  return { issue, team };
}

export interface ReconcileResult {
  /** True if a key was present and the pass actually ran. */
  ran: boolean;
  /** Reason for skipping, when `ran === false`. */
  reason?: string;
  /** Linear issues active right now without a Friday ticket. */
  orphans: LinearIssue[];
  /** Friday tickets linked to Linear issues that are no longer in the active set. */
  staleLinks: Array<{ ticketId: string; identifier: string }>;
  /** All linked external IDs we saw (for diagnostics). */
  linkedCount: number;
}

export async function reconcile(): Promise<ReconcileResult> {
  const cfg = getLinearConfig();
  if (!cfg) {
    return {
      ran: false,
      reason: "LINEAR_API_KEY not set",
      orphans: [],
      staleLinks: [],
      linkedCount: 0,
    };
  }

  const issues = await listActiveIssues({ apiKey: cfg.apiKey });
  const links = externalLinksBySystem(LINEAR_SYSTEM_NAME);

  const linkedIds = new Set(links.map((l) => l.externalId));
  const activeById = new Map(issues.map((i) => [i.identifier, i]));

  const orphans = issues.filter((i) => !linkedIds.has(i.identifier));
  const staleLinks = links
    .filter((l) => !activeById.has(l.externalId))
    .map((l) => ({ ticketId: l.ticketId, identifier: l.externalId }));

  return {
    ran: true,
    orphans,
    staleLinks,
    linkedCount: links.length,
  };
}

export interface ImportResult {
  ticket: Ticket;
  alreadyLinked: boolean;
  issue: LinearIssue;
}

/**
 * Import a Linear issue as a Friday ticket. Idempotent: if a ticket already
 * has the (linear, identifier) external link, returns the existing ticket
 * with `alreadyLinked: true`. Otherwise creates a fresh Friday ticket and
 * stamps the link.
 */
export async function importIssue(opts: {
  identifier: string;
  createdBy?: string;
}): Promise<ImportResult> {
  const cfg = getLinearConfig();
  if (!cfg) {
    throw new Error("LINEAR_API_KEY not set");
  }
  const issue = await getIssueByIdentifier({
    apiKey: cfg.apiKey,
    identifier: opts.identifier,
  });
  if (!issue) {
    throw new Error(`No Linear issue found with identifier "${opts.identifier}"`);
  }

  // Check existing link.
  const existing = externalLinksBySystem(LINEAR_SYSTEM_NAME).find(
    (l) => l.externalId === issue.identifier,
  );
  if (existing) {
    const t = getTicket(existing.ticketId);
    if (t) {
      return { ticket: t, alreadyLinked: true, issue };
    }
    // Fall through — orphan link to a deleted ticket; create fresh.
  }

  const status = mapState(issue.state.type);
  const ticket = createTicket({
    title: issue.title,
    body: issue.description ?? undefined,
    status,
    kind: "task",
    meta: { linearUrl: issue.url, linearState: issue.state.name },
  });
  linkExternal({
    ticketId: ticket.id,
    system: LINEAR_SYSTEM_NAME,
    externalId: issue.identifier,
    url: issue.url,
    meta: { stateName: issue.state.name, stateType: issue.state.type },
  });
  return { ticket, alreadyLinked: false, issue };
}

function mapState(
  type: LinearIssue["state"]["type"],
): Ticket["status"] {
  switch (type) {
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "closed";
    case "triage":
    case "backlog":
    case "unstarted":
    default:
      return "open";
  }
}
