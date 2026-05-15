/**
 * Sonnet-driven proposal body rewrite. Replaces templated `proposedChange`
 * bodies with root-cause analysis + a concrete suggested change.
 *
 * Ported nearly verbatim from old SlackAgents Friday.
 */

import { existsSync, readFileSync } from "node:fs";
import { getProposal, listProposals, updateProposal } from "./store.js";
import type {
  EvidencePointer,
  Proposal,
  ProposalType,
  Signal,
} from "./types.js";
import { chat, extractJson, ChatAbortError } from "./llm.js";

export interface EnrichOptions {
  id?: string;
  all?: boolean;
  retryFailed?: boolean;
  force?: boolean;
  model?: string;
  limit?: number;
  evidenceCharCap?: number;
  enrichFn?: EnrichFn;
}

export interface EnrichResult {
  enriched: Proposal[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string; abortReason?: string }>;
}

export interface EnrichedProposal {
  body: string;
  type: ProposalType;
  blastRadius: Proposal["blastRadius"];
}

export type EnrichFn = (
  proposal: Proposal,
  context: EnrichContext,
  model: string,
) => Promise<EnrichedProposal>;

export interface EnrichContext {
  proposal: Proposal;
  evidence: HydratedEvidence[];
}

export interface HydratedEvidence {
  signalHash: string;
  signalKey: string;
  pointer: EvidencePointer;
  /** Raw content snippet read from the pointer. Empty if unreadable. */
  snippet: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_LIMIT = 50;
const DEFAULT_EVIDENCE_CAP = 2000;
// First attempt: generous enough for a cold SDK subprocess + Sonnet streaming
// a ~400-word body. Old value was 90s, which was tight enough that proposals
// occasionally timed out across consecutive daily scans and never enriched.
const ENRICH_TIMEOUT_MS = 180_000;
// Retry budget: a single retry with a longer ceiling. Bounded so a hung SDK
// can't stall the whole scan.
const ENRICH_RETRY_TIMEOUT_MS = 300_000;
const ENRICH_RETRY_BACKOFF_MS = 2_000;

export async function enrichProposals(
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: [], skipped: [], failed: [] };
  const model = opts.model ?? DEFAULT_MODEL;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const evidenceCap = opts.evidenceCharCap ?? DEFAULT_EVIDENCE_CAP;
  const enrich = opts.enrichFn ?? defaultEnrichFn;

  const targets = selectTargets(opts);
  let processed = 0;

  for (const proposal of targets) {
    if (processed >= limit) {
      result.skipped.push({ id: proposal.id, reason: "limit reached" });
      continue;
    }
    if (!opts.force && !needsEnrichment(proposal)) {
      result.skipped.push({ id: proposal.id, reason: "already enriched" });
      continue;
    }

    const context: EnrichContext = {
      proposal,
      evidence: hydrateEvidence(proposal.signals, evidenceCap),
    };

    let enriched: EnrichedProposal;
    try {
      enriched = await enrichWithRetry(enrich, proposal, context, model);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const abortReason =
        err instanceof ChatAbortError ? err.reason : undefined;
      const now = new Date().toISOString();
      updateProposal(proposal.id, {
        lastEnrichError: errorMsg,
        lastEnrichFailedAt: now,
      });
      result.failed.push({ id: proposal.id, error: errorMsg, abortReason });
      continue;
    }

    const now = new Date().toISOString();
    const updated = updateProposal(proposal.id, {
      proposedChange: enriched.body,
      type: enriched.type,
      blastRadius: enriched.blastRadius,
      enrichedAt: now,
      enrichedBy: model,
      updatedAt: now,
      lastEnrichError: null,
      lastEnrichFailedAt: null,
    });
    if (updated) {
      result.enriched.push(updated);
      processed++;
    } else {
      result.failed.push({ id: proposal.id, error: "update returned null" });
    }
  }

  return result;
}

function selectTargets(opts: EnrichOptions): Proposal[] {
  if (opts.id) {
    const p = getProposal(opts.id);
    return p ? [p] : [];
  }
  const active = listProposals().filter(
    (p) => p.status === "open" || p.status === "critical",
  );
  if (opts.retryFailed) {
    return active.filter((p) => p.lastEnrichError !== null);
  }
  return active;
}

function needsEnrichment(p: Proposal): boolean {
  if (!p.enrichedAt) return true;
  return p.updatedAt > p.enrichedAt;
}

export function hydrateEvidence(
  signals: Signal[],
  evidenceCharCap: number,
): HydratedEvidence[] {
  const out: HydratedEvidence[] = [];
  for (const signal of signals) {
    for (const pointer of signal.evidencePointers) {
      out.push({
        signalHash: signal.hash,
        signalKey: signal.key,
        pointer,
        snippet: readSnippet(pointer, evidenceCharCap),
      });
    }
  }
  return out;
}

function readSnippet(pointer: EvidencePointer, cap: number): string {
  if (!pointer.path || !existsSync(pointer.path)) return "";
  try {
    const raw = readFileSync(pointer.path, "utf-8");
    if (typeof pointer.line !== "number" || pointer.line <= 0) {
      return raw.slice(0, cap);
    }
    const lines = raw.split("\n");
    const target = Math.min(Math.max(pointer.line - 1, 0), lines.length - 1);
    const start = Math.max(0, target - 2);
    const end = Math.min(lines.length, target + 3);
    const slice = lines.slice(start, end).join("\n");
    return slice.length > cap ? slice.slice(0, cap) + "…" : slice;
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT = [
  "You are Friday's improvement analyst. You rewrite a templated proposal body",
  "with root-cause analysis and a concrete suggested change. The proposal was",
  "generated from one or more signals (events, transcripts, usage spikes).",
  "",
  "Your job is to make the proposal actionable. The reader is the orchestrator",
  "agent or the human who reviews proposals. Write tightly. No fluff.",
  "",
  "Output a JSON object with these fields:",
  '  "body": markdown body. ~150–400 words. Sections: **Signal summary** (1–2 lines)',
  "         | **Root cause** (your hypothesis, anchored in the evidence)",
  "         | **Suggested change** (concrete, scoped to one of: memory entry,",
  "         system prompt edit, config change, or code change). Reference",
  "         specific files, agent names, or settings when possible.",
  '  "type": one of "memory" | "prompt" | "config" | "code".',
  '  "blastRadius": "low" | "medium" | "high". low = memory or prompt edit.',
  "         medium = config or scoped code change. high = broad code change.",
  "",
  "Respond with just the JSON object. No prose, no fences.",
].join("\n");

// Tracks per-call timeout so the retry helper can extend it on a second
// attempt without changing the public EnrichFn signature. Set right before
// `enrich(...)` is invoked; read by defaultEnrichFn. Synchronous: the call is
// always followed by an awaited enrich(), so no concurrent writes.
let currentEnrichTimeoutMs = ENRICH_TIMEOUT_MS;

async function enrichWithRetry(
  enrich: EnrichFn,
  proposal: Proposal,
  context: EnrichContext,
  model: string,
): Promise<EnrichedProposal> {
  currentEnrichTimeoutMs = ENRICH_TIMEOUT_MS;
  try {
    return await enrich(proposal, context, model);
  } catch (err) {
    if (!(err instanceof ChatAbortError) || err.reason !== "timeout") throw err;
    await new Promise((r) => setTimeout(r, ENRICH_RETRY_BACKOFF_MS));
    currentEnrichTimeoutMs = ENRICH_RETRY_TIMEOUT_MS;
    return enrich(proposal, context, model);
  }
}

const defaultEnrichFn: EnrichFn = async (proposal, context, model) => {
  const userPrompt = buildUserPrompt(proposal, context);
  const reply = await chat({
    prompt: userPrompt,
    systemPrompt: SYSTEM_PROMPT,
    model,
    timeoutMs: currentEnrichTimeoutMs,
  });

  const parsed = extractJson<{
    body?: string;
    type?: string;
    blastRadius?: string;
  }>(reply.text);
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!body) {
    throw new Error("enrichment reply missing 'body'");
  }
  const type = sanitizeType(parsed.type) ?? proposal.type;
  const blastRadius =
    sanitizeBlastRadius(parsed.blastRadius) ?? proposal.blastRadius;
  return { body, type, blastRadius };
};

function sanitizeType(raw: unknown): ProposalType | null {
  if (raw === "memory" || raw === "prompt" || raw === "config" || raw === "code")
    return raw;
  return null;
}

function sanitizeBlastRadius(raw: unknown): Proposal["blastRadius"] | null {
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return null;
}

function buildUserPrompt(
  proposal: Proposal,
  context: EnrichContext,
): string {
  const lines: string[] = [];
  lines.push(`# Proposal to enrich`);
  lines.push("");
  lines.push(`**Title**: ${proposal.title}`);
  lines.push(`**Current type**: ${proposal.type}`);
  lines.push(`**Current blastRadius**: ${proposal.blastRadius}`);
  lines.push(`**Score**: ${proposal.score}`);
  lines.push("");
  lines.push("## Signals");
  for (const s of proposal.signals) {
    lines.push(
      `- key=\`${s.key}\` source=${s.source} severity=${s.severity} count=${s.count}` +
        (s.agent ? ` agent=${s.agent}` : ""),
    );
    lines.push(`  window: ${s.firstSeenAt} → ${s.lastSeenAt}`);
  }
  lines.push("");
  lines.push("## Evidence (snippets read from the pointers)");
  if (context.evidence.length === 0) {
    lines.push("_No evidence pointers were readable._");
  } else {
    for (const e of context.evidence) {
      const loc = e.pointer.line
        ? `${e.pointer.path}:${e.pointer.line}`
        : e.pointer.path;
      lines.push(`### \`${e.signalKey}\` — ${loc}`);
      if (e.pointer.sessionId) lines.push(`session: ${e.pointer.sessionId}`);
      lines.push("```");
      lines.push(e.snippet || "(no readable content)");
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("## Current body (templated; replace this)");
  lines.push("```");
  lines.push(proposal.proposedChange);
  lines.push("```");
  lines.push("");
  lines.push(
    "Now produce the enrichment as the JSON object specified in the system prompt.",
  );
  return lines.join("\n");
}
