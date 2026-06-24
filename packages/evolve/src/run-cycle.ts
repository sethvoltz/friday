/**
 * FRI-174 — the deep `runEvolveCycle(opts)` module: the ordered signal →
 * propose → rerank → upgrade-resolution → audit → critical-notify →
 * triage/builder spawn → dreaming apply/hygiene/diary cycle, extracted VERBATIM
 * from the daemon's `POST /api/evolve/scan` handler so the daemon endpoint and
 * the `friday evolve scan` CLI share one implementation.
 *
 * Design (FRI-174 owner-accepted decisions):
 *  - ERROR HANDLING (decision a): this module THROWS on cycle failure. Each
 *    caller owns its OWN error envelope — the daemon keeps its `try/catch`
 *    500-path, the CLI lets the error propagate (citty prints + non-zero exit).
 *    The SOFT per-scanner `.catch(() => [])` IS behaviour and lives here; it is
 *    NOT the error envelope.
 *  - RESULT SHAPE (decision b): `EvolveCycleResult` is the endpoint's exact
 *    12-field 200-summary. Both callers adopt it.
 *  - SEAM (i): the `autoSpawnTriageHelpers`/`autoSpawnBuilders` config gates +
 *    the `createAgent`/`updateProposal`/`sendMail` escalation IO STAY in the
 *    daemon's effect closure. This module always calls `effects.spawnTriage` /
 *    `effects.spawnBuilder` with the unconditionally-built plan; the daemon
 *    closure checks the flag and no-ops when off. This module imports NO daemon
 *    config and NO daemon logger (console.warn for the soft-error path, matching
 *    scan-dreaming.ts / dreaming-pipeline.ts's existing console usage).
 */

import { DAEMON_LOG_PATH, type NotifyEvent } from "@friday/shared";
import type { MemoryEntry } from "@friday/memory";
import { scanAll } from "./scan.js";
import { scanFriction } from "./scan-friction.js";
import { scanPreferences } from "./scan-preferences.js";
import { scanDreaming, decodeDreamPayload, type DreamEvidence } from "./scan-dreaming.js";
import { proposeFromSignals, rerankAll } from "./propose.js";
import { getProposal } from "./store.js";
import { resolveByUpgrade } from "./scan-upgrade-resolution.js";
import { appendRun } from "./runs.js";
import { triageSpawnPlan, type TriageSpawnRequest } from "./triage-spawn.js";
import { builderEscalationPlan, type BuilderEscalationRequest } from "./builder-escalation.js";
import { applyDreamProposals } from "./dreaming-pipeline.js";
import { runHygiene, type HygieneReport } from "./hygiene.js";
import { appendDreamEntry, type DreamRunReport, type DreamDiaryItem } from "./dream-diary.js";
import { slugify } from "./apply.js";
import { DEFAULT_RULE, type CriticalityRule } from "./rank.js";

/**
 * The side-effect boundary `runEvolveCycle` drives. The daemon supplies the
 * real `notify`, the gated `createAgent` triage/builder loops, and the real
 * `listEntries`; the CLI supplies no-op spawn/notify effects + the real
 * `listEntries` (true parity).
 */
export interface EvolveCycleEffects {
  /** FRI-142/ADR-048 producer seam #5: fired once per cycle that promoted any
   *  proposal to critical. */
  notify(event: NotifyEvent): Promise<void> | void;
  /** Spawn the planned read-only triage helpers (FRI-40). The daemon gates this
   *  on `cfg.evolve?.autoSpawnTriageHelpers === true`; the CLI no-ops. */
  spawnTriage(reqs: TriageSpawnRequest[]): Promise<void> | void;
  /** Spawn the planned auto-fixing builders (FRI-149/ADR-036). The daemon gates
   *  this on `cfg.evolve?.autoSpawnBuilders === true`; the CLI no-ops. */
  spawnBuilder(reqs: BuilderEscalationRequest[]): Promise<void> | void;
  /** Read the live memory corpus (real `listEntries` from `@friday/memory` in
   *  BOTH callers). */
  listEntries(): Promise<MemoryEntry[]>;
}

export interface EvolveCycleOptions {
  /** ISO lower bound for the regular scan window. */
  since: string;
  /** ISO lower bound for the dreaming sub-pass (the meta-agent's
   *  lastDreamScannedTs cursor; the CLI passes `since`). */
  dreamSince: string;
  includeFriction?: boolean;
  includePreferences?: boolean;
  includeDreaming?: boolean;
  /** Who is running the cycle (`appendRun.by` + dreaming `createdBy`). */
  callerName: string;
  /** The CONFIGURED orchestrator agent name — `DreamEvidence.orchestratorName`
   *  (daemon: `cfg.orchestratorName`; CLI: `loadConfig().orchestratorName`).
   *  daemon.jsonl friction signals carry the REAL agent name. */
  orchestratorName: string;
  /** Criticality rule; defaults to DEFAULT_RULE. */
  rule?: CriticalityRule;
  effects: EvolveCycleEffects;
}

/** The exact 12-field 200-summary of `POST /api/evolve/scan` (server.ts). */
export interface EvolveCycleResult {
  signals: number;
  created: number;
  updated: number;
  promotedToCritical: number;
  reranked: number;
  promotedFromRerank: number;
  familyResolved: number;
  familyRejected: number;
  dreamPromoted: number;
  dreamReinforced: number;
  dreamMerged: number;
  dreamFlagged: number;
}

/**
 * Run one evolve cycle. THROWS on failure (decision a); the caller owns the
 * error envelope. The per-scanner soft `.catch(() => [])` is behaviour and is
 * preserved here.
 */
export async function runEvolveCycle(opts: EvolveCycleOptions): Promise<EvolveCycleResult> {
  const { since, dreamSince, callerName, orchestratorName, effects } = opts;
  const includeFriction = opts.includeFriction !== false;
  const includePreferences = opts.includePreferences !== false;
  const includeDreaming = opts.includeDreaming !== false;
  const rule = opts.rule ?? DEFAULT_RULE;
  const windowEnd = new Date().toISOString();

  const syncSignals = await scanAll({ since });
  const frictionSignals = includeFriction
    ? await scanFriction({ since }).catch((err) => {
        console.warn(
          `evolve.scan.friction-error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as typeof syncSignals;
      })
    : [];
  const preferenceSignals = includePreferences
    ? await scanPreferences({ since }).catch((err) => {
        console.warn(
          `evolve.scan.preferences-error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as typeof syncSignals;
      })
    : [];
  // FRI-26 Memory Dreaming (design D7): a daily sub-pass that mines the
  // orchestrator transcript for new memories worth saving, deduped against
  // the live corpus. Evidence (recall stats keyed by slug + co-occurring
  // daemon-source friction signals) is assembled from a listEntries() read.
  // The scanner is LLM-backed, so it fails soft to [] exactly like the
  // friction/preference scanners.
  const dreamEntries = includeDreaming ? await effects.listEntries() : [];
  // F2/F14: key recall stats by slugify(title) — the SAME identity used for
  // dedup/apply — so the recall→severity bump is not dead in prod when the
  // LLM's title formatting differs trivially from the existing memory's.
  const recallStatsBySlug = new Map<
    string,
    { recallCount: number; lastRecalledAt: string | null }
  >();
  for (const e of dreamEntries) {
    recallStatsBySlug.set(slugify(e.title), {
      recallCount: e.recallCount,
      lastRecalledAt: e.lastRecalledAt,
    });
  }
  const evidence: DreamEvidence = {
    recallStatsBySlug,
    frictionSignalsInWindow: syncSignals.filter((s) => s.source === "daemon"),
    // F2: friction co-occurrence matches the CONFIGURED orchestrator name —
    // daemon.jsonl signals carry the real agent name, not the literal
    // "orchestrator".
    orchestratorName,
    existingMemories: dreamEntries.map((e) => ({ title: e.title, tags: e.tags })),
  };
  // F4/AC6: use the cursor (`dreamSince`) for the dreaming window — the
  // meta-agent's lastDreamScannedTs narrows it to turns newer than the last
  // pass, with propose-merge dedup as the overlap safety net.
  const dreamSignals = includeDreaming
    ? await scanDreaming({ since: dreamSince, evidence }).catch((err) => {
        console.warn(`evolve.scan.dreaming-error: ${String(err)}`);
        return [] as typeof syncSignals;
      })
    : [];
  const signals = [...syncSignals, ...frictionSignals, ...preferenceSignals, ...dreamSignals];
  const propose = proposeFromSignals(signals, {
    rule,
    createdBy: callerName,
  });
  const reranked = rerankAll(rule);
  await resolveByUpgrade({ daemonLogPath: DAEMON_LOG_PATH });
  appendRun({
    ts: windowEnd,
    by: callerName,
    windowStart: since,
    windowEnd,
    signalsScanned: signals.length,
    proposalsCreated: propose.created.length,
    proposalsUpdated: propose.updated.length,
    promotedToCritical: propose.promotedToCritical.length,
  });
  // FRI-142 / ADR-048 producer seam #5 — evolve_critical. A proposal was
  // promoted to critical (across BOTH promote surfaces: fresh-create +
  // rerank). `evolve_critical` is the always-on critical class. One
  // notification per cycle that produced any critical promotion.
  {
    const criticalCount = propose.promotedToCritical.length + reranked.promoted.length;
    if (criticalCount > 0) {
      await effects.notify({
        type: "evolve_critical",
        title: "Critical evolve proposal",
        body:
          criticalCount === 1
            ? "A proposal was promoted to critical."
            : `${criticalCount} proposals were promoted to critical.`,
        deepLink: "/evolve",
        priority: "critical",
      });
    }
  }
  // FRI-40 Phase 1: auto-spawn a read-only triage helper for each proposal
  // that just promoted to critical — across BOTH promote surfaces (fresh-create
  // + rerank). The config gate + per-spawn createAgent IO lives in the daemon's
  // effect closure (seam i); the plan is built unconditionally here (harmless
  // when the effect no-ops).
  await effects.spawnTriage(triageSpawnPlan([...propose.promotedToCritical, ...reranked.promoted]));
  // FRI-149 Phase 2: auto-spawn an auto-fixing Builder for each proposal that
  // just promoted to critical AND is code-shaped AND carries a high-severity
  // signal — across BOTH promote surfaces. The config gate, the
  // `evolveEscalation` flag, the createAgent, the updateProposal linkage, and
  // the sendMail ALL live in the daemon's effect closure (seam i / ADR-036);
  // the plan is built unconditionally here.
  await effects.spawnBuilder(
    builderEscalationPlan([...propose.promotedToCritical, ...reranked.promoted]),
  );
  // FRI-26 Memory Dreaming (design D7): after the usual propose/rerank, hand
  // the dream-shaped proposals (those whose signals carry a decodable
  // DreamPayload) to applyDreamProposals — it dedup-extends an existing
  // memory, auto-applies a proposal that clears its per-category threshold,
  // or leaves it `open` for human review. Then a corpus-wide hygiene pass
  // merges near-dups + flags cold entries (archive-by-tag, never
  // hard-delete), and one diary block is appended. The dream proposals are
  // `type:"memory"` so the FRI-40/FRI-149 spawn blocks above (which consume
  // code-shaped promotions) never touch them. Each sub-step fails soft so a
  // single LLM/dedup hiccup never aborts the nightly run.
  let hygiene: HygieneReport | null = null;
  let dreamPromoted = 0;
  let dreamReinforced = 0;
  if (includeDreaming) {
    // F10/F16: re-read each dream proposal from the store via getProposal so
    // the per-category gate inside applyDreamProposals sees the POST-rerank
    // `score` (rerankAll mutates persisted rows; the in-memory propose.*
    // copies predate it). We keep LIVE dream proposals only — `open` (fresh,
    // gates on score), `critical` (escalated, still gateable), and `applied`
    // (a prior run / family-resolution already wrote the memory). The
    // `applied` ones MUST flow through: on the second nightly run the dream
    // signal's stable hash re-hits the same proposal (now `applied`), and the
    // dedup path inside applyDreamProposals finds the existing memory at
    // score >= DREAM_DEDUP_MIN_SCORE and EXTENDS it (reinforce, AC4) — it
    // never reaches applyProposal, so there is no "already applied" mislabel.
    // Terminal-dead states (`rejected`/`superseded`/`auto-resolved`/
    // `approved`) are excluded so a killed proposal is not resurrected.
    const LIVE_DREAM_STATUSES = new Set(["open", "critical", "applied"]);
    const dreamProps = [...propose.created, ...propose.updated]
      .map((p) => getProposal(p.id) ?? p)
      .filter(
        (p) => p.signals.some((s) => decodeDreamPayload(s)) && LIVE_DREAM_STATUSES.has(p.status),
      );
    const dreamApply = await applyDreamProposals(dreamProps, callerName);
    dreamPromoted = dreamApply.promoted.length;
    dreamReinforced = dreamApply.reinforced.length;
    // F20: a proposal that CLEARED its threshold but whose applyProposal
    // returned ok:false is a genuine failure (distinct from a deliberate
    // below-threshold deferral) — surface it so it is not silently dropped.
    if (dreamApply.failed?.length) {
      console.warn(`evolve.scan.dream-apply-failed: ${dreamApply.failed.join(", ")}`);
    }
    try {
      // Deliberate second listEntries() read: the hygiene pass runs over the
      // corpus AFTER the dream applies/extends above, so it must see those
      // post-write rows (not the pre-write `dreamEntries` snapshot).
      hygiene = await runHygiene(await effects.listEntries());
      const mergedItems: DreamDiaryItem[] = hygiene.merged.map((m) => ({
        action: "merged",
        title: m.survivorId,
        score: null,
        evidence: m.reason,
      }));
      const flaggedItems: DreamDiaryItem[] = hygiene.decayCandidates.map((id) => ({
        action: "pruned-flagged",
        title: id,
        score: null,
        evidence: "cold entry flagged for decay",
      }));
      const report: DreamRunReport = {
        ts: new Date().toISOString(),
        promoted: dreamApply.promoted.length,
        reinforced: dreamApply.reinforced.length,
        merged: hygiene.merged.length,
        prunedFlagged: hygiene.decayCandidates.length,
        items: [...dreamApply.promoted, ...dreamApply.reinforced, ...mergedItems, ...flaggedItems],
      };
      appendDreamEntry(report);
    } catch (err) {
      console.warn(
        `evolve.scan.dreaming-hygiene-error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    signals: signals.length,
    created: propose.created.length,
    updated: propose.updated.length,
    promotedToCritical: propose.promotedToCritical.length,
    reranked: reranked.reranked.length,
    promotedFromRerank: reranked.promoted.length,
    familyResolved: propose.familyResolved.length,
    familyRejected: propose.familyRejected.length,
    dreamPromoted,
    dreamReinforced,
    dreamMerged: hygiene?.merged.length ?? 0,
    dreamFlagged: hygiene?.decayCandidates.length ?? 0,
  };
}
