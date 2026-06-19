/**
 * `friday provision` — the idempotent actuator that installs the runtime deps
 * `checkDeps` only detects. The brew / Postgres / model-warm side effects are
 * injected via the `ProvisionDeps` seam so these tests drive every branch
 * (idempotent skip, fresh install, hard failure, fail-open model warm) without
 * shelling out.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-provision-"));

const { runProvision } = await import("./provision.js");
import type { ProvisionDeps } from "./provision.js";
import { BREW_DEPS } from "../lib/brew-deps.js";

function makeDeps(overrides: Partial<ProvisionDeps> = {}): {
  deps: ProvisionDeps;
  ensureBrewDeps: ReturnType<typeof vi.fn>;
  ensureVectorExtension: ReturnType<typeof vi.fn>;
  ensureEmbeddingAssets: ReturnType<typeof vi.fn>;
  logs: string[];
} {
  const logs: string[] = [];
  const ensureBrewDeps = vi.fn(() => ({
    installed: [],
    alreadyPresent: [...BREW_DEPS],
    failed: [],
  }));
  const ensureVectorExtension = vi.fn(async () => false);
  const ensureEmbeddingAssets = vi.fn(async () => ({ status: "warmed" }) as const);
  const deps: ProvisionDeps = {
    ensureBrewDeps,
    ensureVectorExtension,
    ensureEmbeddingAssets,
    installDir: () => "/tmp/current",
    log: (l) => logs.push(l),
    ...overrides,
  };
  return { deps, ensureBrewDeps, ensureVectorExtension, ensureEmbeddingAssets, logs };
}

describe("runProvision", () => {
  it("invokes brew + extension + model warm and reports ok on a fully-present box", async () => {
    const { deps, ensureBrewDeps, ensureVectorExtension, ensureEmbeddingAssets } = makeDeps();
    const result = await runProvision(deps);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(ensureBrewDeps).toHaveBeenCalledTimes(1);
    expect(ensureVectorExtension).toHaveBeenCalledTimes(1);
    expect(ensureEmbeddingAssets).toHaveBeenCalledTimes(1);
  });

  it("fails (non-ok) with a remedy when the pgvector brew install fails, and SKIPS the extension", async () => {
    const ensureVectorExtension = vi.fn(async () => false);
    const { deps } = makeDeps({
      ensureBrewDeps: () => ({ installed: [], alreadyPresent: [], failed: ["pgvector"] }),
      ensureVectorExtension,
    });
    const result = await runProvision(deps);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("pgvector");
    // The extension CREATE is skipped when its binary didn't install — it would
    // only throw "could not open extension control file".
    expect(ensureVectorExtension).not.toHaveBeenCalled();
  });

  it("fails (non-ok) when the extension CREATE throws (e.g. must be superuser)", async () => {
    const { deps } = makeDeps({
      ensureVectorExtension: vi.fn(async () => {
        throw new Error("must be superuser");
      }),
    });
    const result = await runProvision(deps);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("must be superuser");
  });

  it("treats a failed model warm as fail-open (still ok)", async () => {
    const { deps, logs } = makeDeps({
      ensureEmbeddingAssets: vi.fn(async () => ({ status: "error", error: "offline" }) as const),
    });
    const result = await runProvision(deps);
    // The model warm is SOFT — a failure degrades recall to FTS-only but never
    // flips ok false.
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("FTS-only");
  });
});
