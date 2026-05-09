/**
 * @friday/evolve — self-improvement pipeline.
 *
 * Surface:
 *   - types: Proposal, Signal, ProposalStatus, ProposalType, BlastRadius, …
 *   - store: file-backed CRUD over `~/.friday/evolve/proposals/<id>.md`
 *   - scan: walk daemon log + usage table + transcripts → Signal[]
 *   - propose: bridge signals → proposals (deterministic templated body)
 *   - rank: score + criticality computation
 *   - clusters: jaccard-based deduplication
 *   - enrich: Sonnet-driven body rewrite
 *   - apply: programmatic proposal application (memory autoapply, others ticket-file)
 *   - runs: append-only audit log of pipeline runs
 *   - llm: Claude SDK wrapper used by enrich
 */

export * from "./types.js";
export * from "./store.js";
export * from "./scan.js";
export * from "./rank.js";
export * from "./propose.js";
export * from "./clusters.js";
export * from "./enrich.js";
export * from "./apply.js";
export * from "./runs.js";
export * from "./llm.js";
