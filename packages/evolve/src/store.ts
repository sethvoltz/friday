import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { EVOLVE_DIR } from "@friday/shared";

const PROPOSALS_DIR = join(EVOLVE_DIR, "proposals");

export type ProposalType = "memory" | "prompt" | "config" | "code";
export type ProposalStatus =
  | "open"
  | "critical"
  | "approved"
  | "rejected"
  | "applied"
  | "superseded";
export type BlastRadius = "low" | "medium" | "high";
export type SignalSource = "daemon" | "usage" | "transcript" | "feedback";
export type SignalSeverity = "low" | "medium" | "high";

export interface EvidencePointer {
  kind: SignalSource;
  path: string;
  line?: number;
  sessionId?: string;
}

export interface Signal {
  /** Stable hash that groups identical signal occurrences across runs. */
  hash: string;
  source: SignalSource;
  /** Human-readable identifier within the source (e.g. daemon event name). */
  key: string;
  severity: SignalSeverity;
  /** Number of occurrences observed in the analyzed window. */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Optional name of the agent involved (never a `scheduled-meta-*` agent). */
  agent?: string;
  evidencePointers: EvidencePointer[];
}

export interface Proposal {
  id: string;
  title: string;
  type: ProposalType;
  status: ProposalStatus;
  clusterId: string | null;
  /** 0-100 score driven by severity, frequency, blast radius, fix cost. */
  score: number;
  signals: Signal[];
  /** Free-text rationale + suggested change (markdown body). */
  proposedChange: string;
  blastRadius: BlastRadius;
  /** What surfaces this proposal would touch (e.g. "agent.systemPrompt"). */
  appliesTo: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  /**
   * Set by `friday-evolve enrich`. Marks when the body was rewritten by the
   * Sonnet pass. Stale if `updatedAt > enrichedAt` (signals changed since).
   */
  enrichedAt: string | null;
  /** Model used for the enrichment call. NULL if the body is still templated. */
  enrichedBy: string | null;
  /** Error message from the last failed enrichment attempt. Cleared on success. */
  lastEnrichError: string | null;
  /** ISO timestamp of the last failed enrichment attempt. Cleared on success. */
  lastEnrichFailedAt: string | null;
}

export function ensureImprovementsDirs(): void {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
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
    title: fields.title ?? id,
    type: (fields.type ?? "memory") as ProposalType,
    status: (fields.status ?? "open") as ProposalStatus,
    clusterId: fields.clusterId ?? null,
    score: typeof fields.score === "number" ? fields.score : 0,
    signals: Array.isArray(fields.signals) ? (fields.signals as Signal[]) : [],
    proposedChange: body,
    blastRadius: (fields.blastRadius ?? "low") as BlastRadius,
    appliesTo: Array.isArray(fields.appliesTo) ? fields.appliesTo : [],
    createdBy: fields.createdBy ?? "unknown",
    createdAt: fields.createdAt ?? new Date().toISOString(),
    updatedAt: fields.updatedAt ?? new Date().toISOString(),
    appliedAt: fields.appliedAt ?? null,
    appliedBy: fields.appliedBy ?? null,
    enrichedAt: fields.enrichedAt ?? null,
    enrichedBy: fields.enrichedBy ?? null,
    lastEnrichError: fields.lastEnrichError ?? null,
    lastEnrichFailedAt: fields.lastEnrichFailedAt ?? null,
  };
}

export function serializeProposal(p: Proposal): string {
  // Signals and evidencePointers are non-trivial — serialize as JSON inside the YAML
  // frontmatter rather than spelling them out as nested YAML. Keeps the parser tiny.
  const lines = [
    "---",
    `title: ${JSON.stringify(p.title)}`,
    `type: "${p.type}"`,
    `status: "${p.status}"`,
    `clusterId: ${p.clusterId ? `"${p.clusterId}"` : "null"}`,
    `score: ${p.score}`,
    `blastRadius: "${p.blastRadius}"`,
    `appliesTo: ${jsonArray(p.appliesTo)}`,
    `createdBy: "${p.createdBy}"`,
    `createdAt: "${p.createdAt}"`,
    `updatedAt: "${p.updatedAt}"`,
    `appliedAt: ${p.appliedAt ? `"${p.appliedAt}"` : "null"}`,
    `appliedBy: ${p.appliedBy ? `"${p.appliedBy}"` : "null"}`,
    `enrichedAt: ${p.enrichedAt ? `"${p.enrichedAt}"` : "null"}`,
    `enrichedBy: ${p.enrichedBy ? `"${p.enrichedBy}"` : "null"}`,
    `lastEnrichError: ${p.lastEnrichError ? JSON.stringify(p.lastEnrichError) : "null"}`,
    `lastEnrichFailedAt: ${p.lastEnrichFailedAt ? `"${p.lastEnrichFailedAt}"` : "null"}`,
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
  signals: Signal[];
  blastRadius: BlastRadius;
  appliesTo: string[];
  createdBy: string;
  score?: number;
  status?: ProposalStatus;
  clusterId?: string | null;
}

export function saveProposal(input: SaveProposalInput): Proposal {
  ensureImprovementsDirs();
  const id = generateId(input.title);
  const now = new Date().toISOString();

  const proposal: Proposal = {
    id,
    title: input.title,
    type: input.type,
    status: input.status ?? "open",
    clusterId: input.clusterId ?? null,
    score: input.score ?? 0,
    signals: input.signals,
    proposedChange: input.proposedChange,
    blastRadius: input.blastRadius,
    appliesTo: input.appliesTo,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
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
  /** Override the auto-assigned `updatedAt`. Pass when a write needs `enrichedAt` and `updatedAt` to share a timestamp so idempotency checks survive sub-millisecond races. */
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
  ensureImprovementsDirs();
  const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".md"));
  const proposals: Proposal[] = [];
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      proposals.push(parseProposal(id, readFileSync(join(PROPOSALS_DIR, file), "utf-8")));
    } catch {
      // Skip malformed proposals — never let one bad file kill listing.
    }
  }
  return proposals;
}

/**
 * Find an open or critical proposal whose signals already cover `hash`.
 * Returns the first match — phase 1 scan emits one raw signal per hash, so
 * "first match" is unambiguous.
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
  return join(PROPOSALS_DIR, `${id}.md`);
}

export { PROPOSALS_DIR };

// ── Frontmatter parser (minimal YAML subset, with JSON-inline support) ────────

function parseFrontmatter(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = parseValue(match[2]);
  }
  return result;
}

function parseValue(raw: string): any {
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
