/**
 * The deep scanner core. `scan-friction.ts`, `scan-preferences.ts`, and
 * `scan-dreaming.ts` were three hand-copied pipelines sharing the same four
 * stages — collect orchestrator turns → batch → LLM-score → bucket into
 * `Signal[]` — with ~35–40 lines of identical scaffolding per file. This module
 * owns those stages once; each scanner contributes only a `Taxonomy` adapter
 * (its per-turn payload projection, its default LLM scorer, and its bucketing
 * rule). The genuine variation between the scanners — category enums, score
 * gates, pointer caps, dreaming's payload encoding and promote/reinforce verb —
 * lives entirely inside each `bucket`; the core never inspects the scored type
 * beyond the `turn_id` join key it needs to map scores back to their turns.
 *
 * Two injectable seams ride on the core:
 *   - `scoreFn` (the pre-existing model seam) — replaces the LLM call in tests.
 *   - `collectFn` (new) — replaces `collectOrchestratorTurns`, so the WHOLE
 *     pipeline (collect → batch → score → bucket) is testable without a DB.
 */

import { loadConfig, resolveModelForEvolveTask, type EvolveTaskName } from "@friday/shared";
import type { Signal, SignalSeverity } from "./types.js";
import { collectOrchestratorTurns, type OrchestratorTurn } from "./collect.js";

/** Turns per LLM batch. Default 30. Overridable per-call via `opts.batchSize`. */
export const SCAN_BATCH_SIZE = 30;

/**
 * The one field every scored row carries: the synthetic turn id, echoed back by
 * the LLM, used to join scores onto their source turns. This is the sole part
 * of the scored type `T` the core is allowed to know — everything else is the
 * taxonomy's business.
 */
export interface ScoredRow {
  turn_id: string;
}

/** The turn-collection seam. Defaults to `collectOrchestratorTurns`. */
export type CollectFn = (sinceMs: number, maxTurns: number) => Promise<OrchestratorTurn[]>;

/** The model seam: score a batch of per-turn payloads `P` into scored rows `T`. */
export type BatchScoreFn<P, T extends ScoredRow> = (batch: P[], model: string) => Promise<T[]>;

/**
 * A per-scanner adapter. `P` is the per-turn LLM payload shape, `T` the scored
 * row merged onto each `OrchestratorTurn`, `Ctx` an opaque per-scanner context
 * threaded through untouched by the core (dreaming uses it for its
 * `DreamEvidence`; friction/preferences leave it `undefined`).
 */
export interface Taxonomy<P, T extends ScoredRow, Ctx = undefined> {
  /** Used in the per-batch error log line: `${name} scoring batch …`. */
  name: string;
  /** Resolves the default model via `cfg.evolve.models[modelTask]`. */
  modelTask: EvolveTaskName;
  /** Project one turn into the LLM payload shape (friction adds prev_assistant; dreaming adds evidence). */
  buildPayload: (turn: OrchestratorTurn, ctx: Ctx) => P;
  /** The default LLM scorer (the existing per-scanner `defaultScoreFn`). */
  defaultScoreFn: BatchScoreFn<P, T>;
  /** The scanner-specific bucketing rule — score gate, caps, encoding, verb. Unchanged. */
  bucket: (scored: Array<OrchestratorTurn & T>, ctx: Ctx) => Signal[];
}

/** Per-scan options shared by every scanner. `P`/`T` specialize per taxonomy. */
export interface RunScannerOptions<P, T extends ScoredRow> {
  /** ISO string lower bound — turns earlier than this are skipped. */
  since?: string;
  /** Maximum user turns to evaluate per scan. Default 1000. */
  maxTurns?: number;
  /** Turns per LLM batch. Default `SCAN_BATCH_SIZE` (30). */
  batchSize?: number;
  /** Model id override. Default resolves via `cfg.evolve.models[taxonomy.modelTask]`. */
  model?: string;
  /** Inject for tests — replaces the real LLM call. */
  scoreFn?: BatchScoreFn<P, T>;
  /** Inject for tests — replaces the DB-backed turn collection. */
  collectFn?: CollectFn;
}

/**
 * The deep core: collect → batch → score → bucket. Generic over the per-turn
 * payload `P`, the scored row `T` (constrained to carry `turn_id`), and the
 * opaque per-scanner context `Ctx`. A failing batch is logged and skipped — it
 * never aborts the scan (identical to the copied loops it replaces).
 */
export async function runScanner<P, T extends ScoredRow, Ctx>(
  taxonomy: Taxonomy<P, T, Ctx>,
  opts: RunScannerOptions<P, T>,
  ctx: Ctx,
): Promise<Signal[]> {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const maxTurns = opts.maxTurns ?? 1000;
  const batchSize = opts.batchSize ?? SCAN_BATCH_SIZE;
  const model = opts.model ?? resolveModelForEvolveTask(loadConfig(), taxonomy.modelTask).name;
  const score = opts.scoreFn ?? taxonomy.defaultScoreFn;
  const collect = opts.collectFn ?? collectOrchestratorTurns;

  const turns = await collect(sinceMs, maxTurns);
  if (turns.length === 0) return [];

  const scored: Array<OrchestratorTurn & T> = [];
  for (let i = 0; i < turns.length; i += batchSize) {
    const batch = turns.slice(i, i + batchSize);
    const payload = batch.map((t) => taxonomy.buildPayload(t, ctx));
    let results: T[];
    try {
      results = await score(payload, model);
    } catch (err) {
      // Better to score fewer turns than abort the whole pass; log loudly.
      console.error(
        `${taxonomy.name} scoring batch ${i}-${i + batch.length - 1} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    const byId = new Map(results.map((r) => [r.turn_id, r]));
    for (const turn of batch) {
      const r = byId.get(turn.turnId);
      if (!r) continue;
      scored.push({ ...turn, ...r });
    }
  }

  return taxonomy.bucket(scored, ctx);
}

// ── Shared pure helpers, de-duplicated from the three scanner files ──────────

/** Truncate to `max` chars with an ellipsis. Used by every `buildPayload`. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Clamp `n` into `[lo, hi]`. Used by every `defaultScoreFn` parser. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Map an integer signal/friction score (0–5) to a severity band. */
export function severityFor(score: number): SignalSeverity {
  if (score >= 4) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/** Order severities so bucketing can keep the strongest seen. */
export function severityRank(s: SignalSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}
