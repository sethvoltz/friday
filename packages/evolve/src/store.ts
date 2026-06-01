/**
 * Markdown-backed proposal CRUD. Files live at
 * `~/.friday/evolve/proposals/<id>.md` with YAML-ish frontmatter; lists,
 * signals, and other non-trivial fields are JSON-encoded inline so the
 * frontmatter parser can stay tiny.
 *
 * Ported from the old SlackAgents Friday. The new system replaces `dispatch.ts`
 * (beads-driven) with `@friday/shared/services/tickets` writes invoked at the
 * `apply` site (handled in the daemon's evolve MCP/HTTP shim, not here).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { EVOLVE_PROPOSALS_DIR } from "@friday/shared";
import type { BlastRadius, Proposal, ProposalStatus, ProposalType, Signal } from "./types.js";

export function ensureProposalsDir(): void {
  mkdirSync(EVOLVE_PROPOSALS_DIR, { recursive: true });
}

export function generateId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  return `${slug}-${suffix}`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseProposal(id: string, raw: string): Proposal {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`Invalid proposal format: ${id}`);
  }
  const fields = parseFrontmatter(match[1]);
  const body = match[2].trim();

  return {
    id,
    title: typeof fields.title === "string" ? fields.title : id,
    type: (typeof fields.type === "string" ? fields.type : "memory") as ProposalType,
    status: (typeof fields.status === "string" ? fields.status : "open") as ProposalStatus,
    clusterId: typeof fields.clusterId === "string" ? fields.clusterId : null,
    score: typeof fields.score === "number" ? fields.score : 0,
    signals: Array.isArray(fields.signals) ? (fields.signals as Signal[]) : [],
    proposedChange: body,
    blastRadius: (typeof fields.blastRadius === "string"
      ? fields.blastRadius
      : "low") as BlastRadius,
    appliesTo: Array.isArray(fields.appliesTo) ? (fields.appliesTo as string[]) : [],
    createdBy: typeof fields.createdBy === "string" ? fields.createdBy : "unknown",
    createdAt: typeof fields.createdAt === "string" ? fields.createdAt : new Date().toISOString(),
    updatedAt: typeof fields.updatedAt === "string" ? fields.updatedAt : new Date().toISOString(),
    appliedAt: typeof fields.appliedAt === "string" ? fields.appliedAt : null,
    appliedBy: typeof fields.appliedBy === "string" ? fields.appliedBy : null,
    enrichedAt: typeof fields.enrichedAt === "string" ? fields.enrichedAt : null,
    enrichedBy: typeof fields.enrichedBy === "string" ? fields.enrichedBy : null,
    lastEnrichError: typeof fields.lastEnrichError === "string" ? fields.lastEnrichError : null,
    lastEnrichFailedAt:
      typeof fields.lastEnrichFailedAt === "string" ? fields.lastEnrichFailedAt : null,
    appliedTicketId: typeof fields.appliedTicketId === "string" ? fields.appliedTicketId : null,
    familyResolvedBy: typeof fields.familyResolvedBy === "string" ? fields.familyResolvedBy : null,
  };
}

export function serializeProposal(p: Proposal): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(p.title)}`,
    `type: "${p.type}"`,
    `status: "${p.status}"`,
    `clusterId: ${p.clusterId ? JSON.stringify(p.clusterId) : "null"}`,
    `score: ${p.score}`,
    `blastRadius: "${p.blastRadius}"`,
    `appliesTo: ${jsonArray(p.appliesTo)}`,
    `createdBy: ${JSON.stringify(p.createdBy)}`,
    `createdAt: ${JSON.stringify(p.createdAt)}`,
    `updatedAt: ${JSON.stringify(p.updatedAt)}`,
    `appliedAt: ${p.appliedAt ? JSON.stringify(p.appliedAt) : "null"}`,
    `appliedBy: ${p.appliedBy ? JSON.stringify(p.appliedBy) : "null"}`,
    `enrichedAt: ${p.enrichedAt ? JSON.stringify(p.enrichedAt) : "null"}`,
    `enrichedBy: ${p.enrichedBy ? JSON.stringify(p.enrichedBy) : "null"}`,
    `lastEnrichError: ${p.lastEnrichError ? JSON.stringify(p.lastEnrichError) : "null"}`,
    `lastEnrichFailedAt: ${p.lastEnrichFailedAt ? JSON.stringify(p.lastEnrichFailedAt) : "null"}`,
    `appliedTicketId: ${p.appliedTicketId ? JSON.stringify(p.appliedTicketId) : "null"}`,
    `familyResolvedBy: ${p.familyResolvedBy ? JSON.stringify(p.familyResolvedBy) : "null"}`,
    `signals: ${JSON.stringify(p.signals)}`,
    "---",
    "",
    p.proposedChange,
    "",
  ];
  return lines.join("\n");
}

function jsonArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
}

export interface SaveProposalInput {
  title: string;
  type: ProposalType;
  proposedChange: string;
  signals?: Signal[];
  blastRadius?: BlastRadius;
  appliesTo?: string[];
  createdBy: string;
  score?: number;
  status?: ProposalStatus;
  clusterId?: string | null;
  /**
   * If set at create-time, the proposal is auto-resolved as `applied`
   * because a sibling proposal with the same `signal.key` was applied
   * within the family-resolution window. Caller is responsible for also
   * passing matching `status="applied"` + `appliedAt` / `appliedBy` /
   * `appliedTicketId` fields.
   */
  familyResolvedBy?: string | null;
  appliedAt?: string | null;
  appliedBy?: string | null;
  appliedTicketId?: string | null;
}

export function saveProposal(input: SaveProposalInput): Proposal {
  ensureProposalsDir();
  const id = generateId(input.title);
  const now = new Date().toISOString();

  const proposal: Proposal = {
    id,
    title: input.title,
    type: input.type,
    status: input.status ?? "open",
    clusterId: input.clusterId ?? null,
    score: input.score ?? 0,
    signals: input.signals ?? [],
    proposedChange: input.proposedChange,
    blastRadius: input.blastRadius ?? "low",
    appliesTo: input.appliesTo ?? [],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    appliedAt: input.appliedAt ?? null,
    appliedBy: input.appliedBy ?? null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: input.appliedTicketId ?? null,
    familyResolvedBy: input.familyResolvedBy ?? null,
  };

  writeFileSync(filePath(id), serializeProposal(proposal));
  return proposal;
}

export function getProposal(id: string): Proposal | null {
  const path = filePath(id);
  if (!existsSync(path)) return null;
  return parseProposal(id, readFileSync(path, "utf-8"));
}

export interface UpdateProposalInput {
  title?: string;
  type?: ProposalType;
  status?: ProposalStatus;
  score?: number;
  signals?: Signal[];
  proposedChange?: string;
  blastRadius?: BlastRadius;
  appliesTo?: string[];
  clusterId?: string | null;
  appliedAt?: string | null;
  appliedBy?: string | null;
  enrichedAt?: string | null;
  enrichedBy?: string | null;
  lastEnrichError?: string | null;
  lastEnrichFailedAt?: string | null;
  appliedTicketId?: string | null;
  familyResolvedBy?: string | null;
  /**
   * Override the auto-assigned `updatedAt`. Pass when a write needs
   * `enrichedAt` and `updatedAt` to share a timestamp so idempotency checks
   * survive sub-millisecond races.
   */
  updatedAt?: string;
}

export function updateProposal(id: string, updates: UpdateProposalInput): Proposal | null {
  const existing = getProposal(id);
  if (!existing) return null;

  const next: Proposal = {
    ...existing,
    ...updates,
    updatedAt: updates.updatedAt ?? new Date().toISOString(),
  };

  writeFileSync(filePath(id), serializeProposal(next));
  return next;
}

export function deleteProposal(id: string): boolean {
  const path = filePath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function listProposals(): Proposal[] {
  ensureProposalsDir();
  const files = readdirSync(EVOLVE_PROPOSALS_DIR).filter((f) => f.endsWith(".md"));
  const proposals: Proposal[] = [];
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      proposals.push(parseProposal(id, readFileSync(join(EVOLVE_PROPOSALS_DIR, file), "utf-8")));
    } catch {
      // Skip malformed proposals — never let one bad file kill listing.
    }
  }
  return proposals;
}

/**
 * Find an open or critical proposal whose signals already cover `hash`.
 * Used by the scan pipeline (when ported) to avoid creating duplicate
 * proposals for repeated signals.
 */
export function findProposalBySignalHash(hash: string): Proposal | null {
  const all = listProposals();
  for (const p of all) {
    if (p.status !== "open" && p.status !== "critical") continue;
    if (p.signals.some((s) => s.hash === hash)) return p;
  }
  return null;
}

/**
 * Find the most-recently-applied proposal whose signals include `key` (the
 * signal family — event name, not the hash), applied within `windowDays` of
 * `now`. Used by the propose pipeline to auto-resolve new variants of a
 * family that already has a shipped fix on the books (e.g. ejku applied for
 * `usage_token_spike` on `friday` → kyvl, 6gnh, z79r etc. created later get
 * marked applied at birth with `familyResolvedBy=ejku.id`).
 *
 * Window default 14 days: long enough to absorb a daily-scan cadence, short
 * enough that a recurrence months after a fix re-surfaces as a fresh open
 * proposal (which IS what we want — a fix that decays warrants attention).
 */
export function findRecentlyAppliedByFamilyKey(
  key: string,
  opts: { windowDays?: number; now?: Date } = {},
): Proposal | null {
  const windowDays = opts.windowDays ?? 14;
  const nowMs = (opts.now ?? new Date()).getTime();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  let best: Proposal | null = null;
  let bestAppliedMs = 0;

  for (const p of listProposals()) {
    if (p.status !== "applied") continue;
    if (!p.appliedAt) continue;
    if (!p.signals.some((s) => s.key === key)) continue;
    const appliedMs = Date.parse(p.appliedAt);
    if (!Number.isFinite(appliedMs)) continue;
    if (nowMs - appliedMs > windowMs) continue;
    if (appliedMs > bestAppliedMs) {
      best = p;
      bestAppliedMs = appliedMs;
    }
  }
  return best;
}

/**
 * Find the most-recently-rejected proposal whose signals include `key`,
 * rejected within `windowDays`. Used by the propose pipeline to honor the
 * user's prior reject: if they said "not a real issue" recently, don't
 * spawn another variant immediately. Outside the window the family is
 * eligible for a fresh proposal again (the rejection isn't permanent —
 * conditions can change).
 *
 * "Rejected" timestamps live on `updatedAt` (no dedicated `rejectedAt`
 * field), so the window check uses `updatedAt` for status=rejected rows.
 */
export function findRecentlyRejectedByFamilyKey(
  key: string,
  opts: { windowDays?: number; now?: Date } = {},
): Proposal | null {
  const windowDays = opts.windowDays ?? 14;
  const nowMs = (opts.now ?? new Date()).getTime();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  let best: Proposal | null = null;
  let bestMs = 0;

  for (const p of listProposals()) {
    if (p.status !== "rejected") continue;
    if (!p.signals.some((s) => s.key === key)) continue;
    const ms = Date.parse(p.updatedAt);
    if (!Number.isFinite(ms)) continue;
    if (nowMs - ms > windowMs) continue;
    if (ms > bestMs) {
      best = p;
      bestMs = ms;
    }
  }
  return best;
}

function filePath(id: string): string {
  return join(EVOLVE_PROPOSALS_DIR, `${id}.md`);
}

export { EVOLVE_PROPOSALS_DIR };

// ── Frontmatter parser (minimal YAML subset, with JSON-inline support) ────────

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = parseValue(match[2]);
  }
  return result;
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "") return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}
