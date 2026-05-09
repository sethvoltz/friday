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
import type {
  BlastRadius,
  Proposal,
  ProposalStatus,
  ProposalType,
  Signal,
} from "./types.js";

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
    createdAt:
      typeof fields.createdAt === "string"
        ? fields.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof fields.updatedAt === "string"
        ? fields.updatedAt
        : new Date().toISOString(),
    appliedAt: typeof fields.appliedAt === "string" ? fields.appliedAt : null,
    appliedBy: typeof fields.appliedBy === "string" ? fields.appliedBy : null,
    enrichedAt: typeof fields.enrichedAt === "string" ? fields.enrichedAt : null,
    enrichedBy: typeof fields.enrichedBy === "string" ? fields.enrichedBy : null,
    lastEnrichError:
      typeof fields.lastEnrichError === "string" ? fields.lastEnrichError : null,
    lastEnrichFailedAt:
      typeof fields.lastEnrichFailedAt === "string"
        ? fields.lastEnrichFailedAt
        : null,
    appliedTicketId:
      typeof fields.appliedTicketId === "string" ? fields.appliedTicketId : null,
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
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
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
  /**
   * Override the auto-assigned `updatedAt`. Pass when a write needs
   * `enrichedAt` and `updatedAt` to share a timestamp so idempotency checks
   * survive sub-millisecond races.
   */
  updatedAt?: string;
}

export function updateProposal(
  id: string,
  updates: UpdateProposalInput,
): Proposal | null {
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
  const files = readdirSync(EVOLVE_PROPOSALS_DIR).filter((f) =>
    f.endsWith(".md"),
  );
  const proposals: Proposal[] = [];
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      proposals.push(
        parseProposal(
          id,
          readFileSync(join(EVOLVE_PROPOSALS_DIR, file), "utf-8"),
        ),
      );
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
