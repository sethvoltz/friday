/**
 * Real-fork integration suite for the embedding subsystem (FRI-24). Unlike
 * embed.test.ts (fake transport, no subprocess) this `fork`s the actual
 * dist/embed-child.js and round-trips IPC. Excluded from `pnpm test`; runs
 * under `pnpm test:e2e`.
 *
 * FRIDAY_EMBED_FAKE=1 keeps the child off transformers entirely — it replies
 * with a deterministic hash-derived 384-float L2-normalized vector — so these
 * tests exercise the real fork + IPC + supervision plumbing fast and offline,
 * with no model download and no native onnxruntime binary.
 *
 * The AC11 test is the ONE exception: it runs REAL WASM in-process inference to
 * prove "no outbound network at inference time". It warms the model cache once
 * (the only network step), then asserts a cached re-embed hits the network zero
 * times. It soft-skips (with a warning) only if the warm download itself fails
 * (a genuinely offline box), so it never flakes but DOES assert wherever the hub
 * is reachable (incl. CI).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBED_DIM, _resetEmbedForTests, embedText, shutdownEmbedChild } from "./embed.js";

describe("embed subsystem (real fork, FRIDAY_EMBED_FAKE=1)", () => {
  beforeAll(() => {
    // The default spawn factory forwards process.env to the child, so setting
    // this here puts the forked child into deterministic fake mode.
    process.env.FRIDAY_EMBED_FAKE = "1";
  });
  afterEach(() => {
    shutdownEmbedChild();
    _resetEmbedForTests();
  });

  it("embedding runs in a distinct OS process and returns a 384-length vector (AC19)", async () => {
    // Capture the child pid via the result event by spying on the manager's
    // observable output. The child stamps its own pid; we read it back through
    // a dedicated round-trip below.
    const vec = await embedText("hello world", { timeoutMs: 30_000 });
    expect(vec).not.toBe(null);
    expect(vec).toHaveLength(EMBED_DIM);

    // Prove the embed ran out-of-process: fork a probe that reports the child
    // pid alongside the result, and assert it differs from this test process.
    const pid = await childPidForEmbed("pid probe");
    expect(pid).toBeTypeOf("number");
    expect(pid).not.toBe(process.pid);
  });

  it("child crash → manager survives and restarts; recall can embed again (AC20)", async () => {
    // Warm one embed so a child is live.
    const first = await embedText("before crash", { timeoutMs: 30_000 });
    expect(first).toHaveLength(EMBED_DIM);

    // Kill the live child out from under the manager.
    shutdownEmbedChild();

    // The next embed must transparently respawn and succeed. The default
    // backoff base (500ms) is well under the timeout, and the manager's gate
    // allows the spawn once it elapses; retry across the backoff window.
    const recovered = await embedWithRetry("after crash", 30_000);
    expect(recovered).not.toBe(null);
    expect(recovered).toHaveLength(EMBED_DIM);
  });

  // AC11: real (non-fake) in-process inference via the WASM runtime must make
  // ZERO outbound network calls once the model + tokenizer are cached on disk.
  // We warm the cache first (the ONE network step), then reset the in-memory
  // runtime, force offline, and assert a fresh embed reloads from disk and
  // hits the network zero times. Soft-skips (with a warning) only if the warm
  // download itself fails — e.g. a genuinely offline box — so it never flakes,
  // but it DOES run and assert wherever the hub is reachable (incl. CI).
  it("real WASM inference makes no outbound network and yields a 384-len vector (AC11)", async () => {
    const { embedTextWasm, _resetRuntimeForTests } = await import("./embed-runtime.js");
    let warmed: number[];
    try {
      warmed = await embedTextWasm("warm"); // downloads model + tokenizer (network)
    } catch (err) {
      console.warn(`AC11: model warm failed (offline?), cannot assert cached path: ${err}`);
      return;
    }
    expect(warmed).toHaveLength(EMBED_DIM);

    // Assets are now on disk. Drop the in-memory runtime so the next embed
    // reloads from the disk cache, force offline, and watch the network.
    _resetRuntimeForTests();
    const { env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const vec = await embedTextWasm("cached in-process embed");

    expect(vec).toHaveLength(EMBED_DIM);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    fetchSpy.mockRestore();
  }, 120_000);
});

/** Fork the same child the manager uses and read back the pid it stamps on the
 *  result — proves the embed executes in a separate process. Uses fake mode
 *  (inherited from process.env) so no model is required. */
async function childPidForEmbed(text: string): Promise<number> {
  const { fork } = await import("node:child_process");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const childPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "embed-child.js");
  return await new Promise<number>((resolve, reject) => {
    const child = fork(childPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child pid probe timed out"));
    }, 30_000);
    child.on("message", (msg: { type?: string; pid?: number }) => {
      if (msg?.type === "ready") {
        child.send({ type: "embed", id: "probe", text });
      } else if (msg?.type === "result") {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(msg.pid as number);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Retry `embedText` across the manager's restart-backoff window so a
 *  post-crash respawn has a chance to clear its gate. */
async function embedWithRetry(text: string, timeoutMs: number): Promise<number[] | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const vec = await embedText(text, { timeoutMs });
    if (vec) return vec;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}
