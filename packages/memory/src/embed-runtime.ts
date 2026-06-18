/**
 * WASM embedding runtime (FRI-24). Tokenizes with @huggingface/transformers'
 * `AutoTokenizer` (pure JS) and runs inference on onnxruntime-web's WASM backend
 * — deliberately NOT transformers' feature-extraction pipeline, which forces the
 * native `onnxruntime-node` backend. onnxruntime-node ships no macOS x64 prebuilt
 * (dropped at ORT 1.20) and Friday's release tarball strips its `bin/` tree, so
 * the native path is dead on the Intel x64 production box. This WASM path is
 * cross-platform (x64 + arm64), needs no native binary, and is what makes
 * semantic recall actually work on prod.
 *
 * The all-MiniLM-L6-v2 quantized ONNX model + its tokenizer are cached under
 * `<DATA_DIR>/models` (honoring FRIDAY_DATA_DIR), fetched lazily on first use or
 * pre-warmed by `friday update` via warmEmbeddingModel().
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, EMBEDDING_DIM } from "@friday/shared";

/** Model cache dir — keyed off the shared DATA_DIR so it honors FRIDAY_DATA_DIR
 *  and never hardcodes ~/.friday. */
export const MODEL_CACHE_DIR = join(DATA_DIR, "models");

/** System defaults as code constants placed before the env reads so they stay
 *  overridable; nothing is read from .env or the age vault (no embedding secret). */
export const MODEL_ID = process.env.FRIDAY_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const THREADS = Math.max(1, Number(process.env.FRIDAY_EMBED_THREADS ?? "2"));
const MAX_TOKENS = Math.max(8, Number(process.env.FRIDAY_EMBED_MAX_TOKENS ?? "256"));
const MODEL_ONNX_URL =
  process.env.FRIDAY_EMBED_MODEL_URL ??
  `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_quantized.onnx`;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Tok {
  data: BigInt64Array;
  dims: number[];
}
interface Encoding {
  input_ids: Tok;
  attention_mask: Tok;
  token_type_ids?: Tok;
}
type Tokenizer = (text: string, opts?: Record<string, unknown>) => Promise<Encoding>;
interface Runtime {
  tokenizer: Tokenizer;
  session: any;
  ORT: any;
}

let runtimePromise: Promise<Runtime> | null = null;

function modelOnnxPath(): string {
  return join(MODEL_CACHE_DIR, `${MODEL_ID.replace(/[^a-z0-9]+/gi, "_")}.quantized.onnx`);
}

/** Ensure the quantized ONNX model file is on disk; download it once if absent.
 *  Downloads to a unique temp path then atomically renames into place, so a
 *  concurrent or interrupted download can never leave a truncated file at the
 *  canonical path (which existsSync would then trust forever — a fail-CLOSED
 *  trap inside a fail-open system). */
async function ensureModelFile(): Promise<string> {
  const path = modelOnnxPath();
  if (existsSync(path)) return path;
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  const res = await fetch(MODEL_ONNX_URL);
  if (!res.ok) {
    throw new Error(`embedding model download failed: ${res.status} ${MODEL_ONNX_URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${path}.partial-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, buf);
  await rename(tmp, path); // atomic on the same filesystem
  return path;
}

async function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      // AutoTokenizer is pure JS. Importing transformers also (statically) imports
      // onnxruntime-node, which is patched (FRI-24) to no-op when its native
      // binary is absent — so this import succeeds on macOS x64 / a stripped
      // tarball; we never invoke transformers' native inference path.
      const { AutoTokenizer, env } = await import("@huggingface/transformers");
      env.cacheDir = MODEL_CACHE_DIR;
      const ortMod = (await import("onnxruntime-web")) as any;
      const ORT = ortMod.default ?? ortMod;
      try {
        ORT.env.wasm.numThreads = THREADS;
      } catch {
        // ORT env shape varies across builds — thread cap is best-effort.
      }
      const tokenizer = (await AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as Tokenizer;
      const modelPath = await ensureModelFile();
      const session = await ORT.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
      });
      return { tokenizer, session, ORT };
    })();
  }
  return runtimePromise;
}

// onnxruntime-web's WASM backend does not support concurrent run() on a single
// session — overlapping calls throw "Session already started". The manager
// supports multiple in-flight embeds (a simultaneous store + recall both hit
// this one child), so serialize inference through a chain. transformers does
// the same internally (webInferenceChain); we bypass its pipeline, so we own it.
let inferenceChain: Promise<unknown> = Promise.resolve();

/**
 * Embed `text` into a 384-float, L2-normalized vector via the WASM runtime.
 * Calls are serialized (one session.run at a time). Throws on any failure
 * (download/model/inference) — callers (embed-child, warmEmbeddingModel) own
 * the fail-open semantics.
 */
export async function embedTextWasm(text: string): Promise<number[]> {
  const run = inferenceChain.then(() => embedOnce(text));
  // Keep the chain alive regardless of this call's outcome.
  inferenceChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function embedOnce(text: string): Promise<number[]> {
  const { tokenizer, session, ORT } = await getRuntime();
  const enc = await tokenizer(text, { truncation: true, max_length: MAX_TOKENS });
  const ids = enc.input_ids;
  const mask = enc.attention_mask;
  const feeds: Record<string, any> = {};
  for (const name of session.inputNames as string[]) {
    if (name === "input_ids") feeds[name] = new ORT.Tensor("int64", ids.data, ids.dims);
    else if (name === "attention_mask") feeds[name] = new ORT.Tensor("int64", mask.data, mask.dims);
    else if (name === "token_type_ids")
      feeds[name] = new ORT.Tensor(
        "int64",
        enc.token_type_ids?.data ?? new BigInt64Array(ids.data.length),
        ids.dims,
      );
  }
  const out = await session.run(feeds);
  const lhs = out[session.outputNames[0]]; // last_hidden_state [1, seq, dim]
  const [, seq, dim] = lhs.dims as number[];
  const d = lhs.data as ArrayLike<number>;
  const m = mask.data;
  // Mean-pool over the sequence weighted by the attention mask, then L2-normalize.
  const pooled = new Array<number>(dim).fill(0);
  let msum = 0;
  for (let s = 0; s < seq; s++) {
    const w = Number(m[s]);
    msum += w;
    for (let k = 0; k < dim; k++) pooled[k] += Number(d[s * dim + k]) * w;
  }
  const denom = msum || 1;
  let norm = 0;
  for (let k = 0; k < dim; k++) {
    pooled[k] /= denom;
    norm += pooled[k] * pooled[k];
  }
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < dim; k++) pooled[k] /= norm;
  if (pooled.length !== EMBEDDING_DIM) {
    throw new Error(`embedding dim ${pooled.length} != expected ${EMBEDDING_DIM}`);
  }
  return pooled;
}

/** Reset the cached runtime (tests). */
export function _resetRuntimeForTests(): void {
  runtimePromise = null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
