/**
 * FRI-24 — on-device embedding-asset provisioning. Inference runs on
 * onnxruntime-web's WASM backend (the `.wasm` files ship inside node_modules),
 * so there is NO native binary to fetch on-device — the ONLY thing
 * ensureEmbeddingAssets provisions is the MODEL warm. These tests pin that it
 * (a) invokes warmEmbeddingModel and maps a `true`/`false` warm onto the
 * discriminated `warmed`/`warm-failed` result, and (b) is FAIL-OPEN: a thrown
 * warm is swallowed and reported as `error`, never propagated. The warm is
 * injected, so nothing here touches the network or the transformers/ORT stack.
 */

import { describe, expect, it, vi } from "vitest";

import { ensureEmbeddingAssets } from "./embedding-assets.js";

const INSTALL_DIR = "/tmp/friday-install-tree";

describe("ensureEmbeddingAssets — WASM model warm, fail-open (FRI-24)", () => {
  it("invokes warmEmbeddingModel and reports `warmed` when it returns true", async () => {
    const warmModel = vi.fn(async () => true);

    const result = await ensureEmbeddingAssets({ installDir: INSTALL_DIR, warmModel });

    expect(result).toEqual({ status: "warmed" });
    // The warm was actually invoked (with the log seam threaded through).
    expect(warmModel).toHaveBeenCalledTimes(1);
    expect(warmModel).toHaveBeenCalledWith(expect.objectContaining({ log: expect.any(Function) }));
  });

  it("reports `warm-failed` (no throw) when warmEmbeddingModel returns false", async () => {
    // Offline / no-data warm: warmEmbeddingModel returns false rather than
    // throwing. Recall degrades to FTS-only; the update must not abort.
    const warmModel = vi.fn(async () => false);

    const result = await ensureEmbeddingAssets({ installDir: INSTALL_DIR, warmModel });

    expect(result).toEqual({ status: "warm-failed" });
    expect(warmModel).toHaveBeenCalledTimes(1);
  });

  it("is FAIL-OPEN: a thrown warm is swallowed and reported as `error`", async () => {
    const warmModel = vi.fn(async () => {
      throw new Error("transformers blew up");
    });

    // Must NOT reject — the update flow depends on this never throwing.
    const result = await ensureEmbeddingAssets({ installDir: INSTALL_DIR, warmModel });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("transformers blew up");
  });

  it("forwards a log() it can use to narrate the warm", async () => {
    const logged: string[] = [];
    const warmModel = vi.fn(async (o: { log?: (m: string) => void }) => {
      o.log?.("warming…");
      return true;
    });

    const result = await ensureEmbeddingAssets({
      installDir: INSTALL_DIR,
      warmModel,
      log: (m) => logged.push(m),
    });

    expect(result).toEqual({ status: "warmed" });
    // The injected log is the one warmModel wrote through (single shared seam).
    expect(logged).toContain("warming…");
  });
});
