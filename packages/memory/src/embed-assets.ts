/**
 * Embedding model asset warmup (FRI-24). Called by `friday update` / setup to
 * pre-fetch the all-MiniLM-L6-v2 tokenizer + quantized ONNX model into the
 * <DATA_DIR>/models cache so the first real recall after an install/update
 * doesn't pay the download cost (and doesn't silently fail open just because the
 * assets weren't on disk yet).
 *
 * The runtime is onnxruntime-web (WASM), whose small wasm files ship inside
 * node_modules — there is NO native binary to fetch (see embed-runtime.ts). So
 * warmup downloads ONLY the model + tokenizer. FAIL-OPEN: a failed warm returns
 * false and never throws; recall degrades to FTS-only and the daemon still boots.
 */

import { embedTextWasm, MODEL_CACHE_DIR, MODEL_ID } from "./embed-runtime.js";

export { MODEL_CACHE_DIR };

/**
 * Best-effort: pull the tokenizer + quantized model into the cache by running a
 * single trivial embed through the WASM runtime. Resolves `true` if the embed
 * produced a vector, `false` on any failure (offline, download error, runtime
 * error). NEVER throws.
 */
export async function warmEmbeddingModel(opts?: { log?: (m: string) => void }): Promise<boolean> {
  const log = opts?.log ?? (() => {});
  try {
    log(`embedding: warming model ${MODEL_ID} into ${MODEL_CACHE_DIR}`);
    const vec = await embedTextWasm("warm");
    const ok = Array.isArray(vec) && vec.length > 0;
    log(ok ? "embedding: model warmed" : "embedding: warm produced no data");
    return ok;
  } catch (err) {
    log(`embedding: warm failed (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
