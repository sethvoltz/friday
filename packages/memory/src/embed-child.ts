/**
 * Forked embedding child (FRI-24). Compiles to dist/embed-child.js and is
 * `fork`ed by embed.ts's default spawn factory. Hosts the all-MiniLM-L6-v2
 * feature-extraction pipeline and answers `embed` IPC commands with a 384-float
 * L2-normalized vector.
 *
 * Lifecycle mirrors the daemon worker (services/daemon/src/agent/worker.ts):
 * emit `ready` at startup, then `process.on("message")` for commands. The model
 * is built lazily on the first embed so spawning the child is cheap; the first
 * embed pays the load cost (bounded by the parent's warm timeout).
 *
 * FAKE mode: when FRIDAY_EMBED_FAKE is set, skip the model entirely and reply
 * with a deterministic hash-derived, L2-normalized pseudo-embedding. This lets
 * e2e tests exercise the REAL fork + IPC round-trip fast and offline (no model
 * download, no WASM runtime).
 */

import { EMBEDDING_DIM } from "@friday/shared";
import { embedTextWasm } from "./embed-runtime.js";
import type { EmbedCommand, EmbedEvent } from "./embed.js";

const FAKE = !!process.env.FRIDAY_EMBED_FAKE;

function emit(e: EmbedEvent): void {
  if (process.send) process.send(e);
}

// ---------------------------------------------------------------------------
// Deterministic fake embedding for tests. A simple FNV-1a-seeded LCG fills the
// vector, then we L2-normalize so the output has the same shape + invariants
// (unit norm, EMBEDDING_DIM length) as a real embed.
// ---------------------------------------------------------------------------

function fakeEmbedding(text: string): number[] {
  // FNV-1a 32-bit hash of the text → seed.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0 || 1;
  const out = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // xorshift32 → float in [-1, 1)
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = (state / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// ---------------------------------------------------------------------------
// Real embedding via the cross-platform WASM runtime (onnxruntime-web +
// transformers tokenizer). See embed-runtime.ts for why this is NOT the native
// feature-extraction pipeline.
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[]> {
  if (FAKE) return fakeEmbedding(text);
  return embedTextWasm(text);
}

process.on("message", (msg: EmbedCommand) => {
  if (!msg || msg.type !== "embed") return;
  const { id, text } = msg;
  void (async () => {
    try {
      const vector = await embed(text);
      emit({ type: "result", id, vector, pid: process.pid });
    } catch (err) {
      emit({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

// Handshake: announce readiness so the parent can release queued requests.
emit({ type: "ready" });
