// Browser-safe model-id helpers (FRI-16). This module MUST stay free of
// `node:*` imports (and of anything that transitively reaches them): it is
// re-exported from `@friday/shared/sync`, whose entire graph lands in the
// dashboard's client bundle (zero.svelte.ts → createMutators, loaded by the
// root layout). A node builtin here gets stubbed to an empty module by Vite
// and crashes every page at hydration. See sync/index.ts for the contract.

/**
 * Coerce the legacy un-dated Haiku id to its dated snapshot (FRI-16 AC #22b).
 * The dashboard's MODEL_OPTIONS standardizes on `claude-haiku-4-5-20251001`
 * (matching the evolve defaults); rows/configs written before that carry the
 * bare alias. Idempotent — a dated id (or any other id) passes through
 * unchanged. Shared so the Zero mutator, the daemon settings listener, and
 * the dashboard REST endpoint apply the identical coercion.
 */
export function coerceLegacyModelId(id: string): string {
  return id === "claude-haiku-4-5" ? "claude-haiku-4-5-20251001" : id;
}
