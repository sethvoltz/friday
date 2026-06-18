/**
 * On-device embedding-asset provisioning (FRI-24).
 *
 * Inference runs on onnxruntime-web's WASM backend (see
 * `@friday/memory`'s embed-runtime.ts), NOT the native onnxruntime-node addon —
 * onnxruntime-node ships no macOS x64 prebuilt (dropped at ORT 1.20) and prod is
 * an Intel x64 box. The WASM `.wasm` files ship inside node_modules, so there is
 * NO native binary to fetch on-device. The only thing this module provisions is
 * the MODEL: it warms the all-MiniLM tokenizer + quantized ONNX model into
 * `<DATA_DIR>/models` so the first real recall after an update doesn't pay the
 * download cost.
 *
 * FAIL-OPEN by design: a failed warm (offline, download error, runtime error)
 * leaves the embedder cold → the first recall lazily retries, and if that also
 * fails `embedText` returns null → semantic recall degrades to FTS-only. The
 * daemon still boots; nothing throws into the update or recall path. (The
 * pgvector EXTENSION, by contrast, is a HARD schema dependency ensured at
 * provision time and is NOT handled here.)
 *
 * The model warm is injectable ({@link EnsureEmbeddingAssetsOptions.warmModel})
 * so the unit suite asserts the invoke + fail-open behavior without loading the
 * transformers/onnxruntime-web stack or hitting the network.
 *
 * IMPORTANT (lazy-dep discipline, CLAUDE.md "Static imports only" exception b):
 * the default warm forks @friday/memory's embedding CHILD (`warmEmbedChild`)
 * rather than warming in-process. The fork is what keeps the ~240 MB ORT/
 * transformers stack OUT of the short-lived `friday update` CLI process — only
 * the ephemeral child loads it. `warmEmbedChild`/`shutdownEmbedChild` are plain
 * manager functions (no heavy deps), so they are imported statically.
 */

import { shutdownEmbedChild, warmEmbedChild } from "@friday/memory";

/**
 * Default model warm: fork the embedding child, run one warm embed (which
 * downloads the tokenizer + quantized model into `<DATA_DIR>/models`), then kill
 * the child so the short-lived CLI process exits promptly. ORT loads in the
 * child, never in this process.
 */
async function warmViaForkedChild(o: { log?: (m: string) => void }): Promise<boolean> {
  o.log?.("embedding: warming model via the forked child");
  try {
    return await warmEmbedChild();
  } finally {
    shutdownEmbedChild();
  }
}

/** Outcome of a model-warm attempt — discriminated for precise assertions and
 *  so the caller can render an accurate ✓ / ✗ TUI line. */
export type EnsureEmbeddingAssetsResult =
  | { status: "warmed" }
  | { status: "warm-failed" }
  | { status: "error"; error: string };

export interface EnsureEmbeddingAssetsOptions {
  /**
   * The new version's extracted install tree. Retained for call-site symmetry
   * with the other provisioning steps (and so a future asset that DOES live in
   * the install tree has a home), even though the WASM warm only writes into
   * `<DATA_DIR>/models`.
   */
  installDir: string;
  /** Inject the model warm (defaults to forking @friday/memory's embedding
   *  child via warmEmbedChild). */
  warmModel?: (o: { log?: (m: string) => void }) => Promise<boolean>;
  log?: (m: string) => void;
}

/**
 * Provision the embedding MODEL on-device (FRI-24). Best-effort and FAIL-OPEN:
 * warm the all-MiniLM model into `<DATA_DIR>/models` so the first real recall
 * doesn't pay the download cost. The WASM runtime needs no native binary, so
 * there is nothing else to fetch.
 *
 * NEVER throws. Returns:
 *   - `warmed`      — the model warmed (downloaded into the cache + produced a
 *                     vector).
 *   - `warm-failed` — the warm returned false (offline / no data); recall
 *                     degrades to FTS-only until the first recall retries.
 *   - `error`       — the warm threw (caught here); same FTS-only fallback,
 *                     with the message for the caller to surface.
 */
export async function ensureEmbeddingAssets(
  opts: EnsureEmbeddingAssetsOptions,
): Promise<EnsureEmbeddingAssetsResult> {
  const log = opts.log ?? (() => {});

  try {
    const warm = opts.warmModel ?? warmViaForkedChild;
    const ok = await warm({ log });
    return ok ? { status: "warmed" } : { status: "warm-failed" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`embedding: model warm failed (fail-open): ${error}`);
    return { status: "error", error };
  }
}
